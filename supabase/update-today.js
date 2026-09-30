const fs = require('fs');
const path = require('path');
let ProxyAgent = null;
let undiciRequest = null;
try {
  ({ ProxyAgent, request: undiciRequest } = require('undici'));
} catch (e) {
  console.log('undici 未安装，Supabase 请求将使用原生 fetch（无代理）');
}

const projectDir = path.resolve(__dirname, '..');
const root = path.resolve(projectDir, '..');
const dataPath = path.join(projectDir, 'assets', 'project-data.js');
const zipPath = path.join(root, 'jiahua-junyuan-web.zip');
const projectCode = 'jiahua_junyuan';
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;
const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

if (!supabaseUrl || !supabaseKey) throw new Error('缺少 SUPABASE_URL 或 SUPABASE_SECRET_KEY');

// 为 Supabase 请求创建代理 agent（仅用于 Supabase，官网抓取不走代理）
const supabaseAgent = (ProxyAgent && httpsProxy) ? new ProxyAgent(httpsProxy) : null;

global.window = {};
eval(fs.readFileSync(dataPath, 'utf8'));
const data = global.window.PROJECT_DATA;

const statusByColor = {
  '#33cc00': '可售',
  '#ff0000': '已签约',
  '#d2691e': '网上联机备案',
  '#ffcc99': '已预订',
  '#cccccc': '不可售'
};

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function num(s) {
  return Number(String(s || '').replace(/,/g, '').trim());
}

const BASE = 'http://bjjs.zjw.beijing.gov.cn';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchText(url, opts = {}) {
  const retries = opts.retries || 5;
  const minLen = opts.minLen || 20000;
  const requireMarker = opts.requireMarker || null;
  const label = opts.label || '';
  for (let i = 0; i < retries; i++) {
    let html = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const headers = {
        'User-Agent': CHROME_UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      };
      // 交替带/不带 Referer，绕过官网反爬
      if (i % 2 === 1) headers['Referer'] = `${BASE}/eportal/ui?pageId=411612`;
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      console.log(`    [${label}第${i + 1}次] 异常: ${err.message}`);
      if (i < retries - 1) { await sleep(500 + i * 500); continue; }
      throw err;
    }
    if (html.length < minLen) {
      console.log(`    [${label}第${i + 1}次] 内容过短(${html.length}B)，疑似限流`);
      if (i < retries - 1) { await sleep(500 + i * 500); continue; }
      throw new Error(`[${label}] 内容过短(${html.length}B)，疑似限流`);
    }
    if (requireMarker && html.indexOf(requireMarker) < 0) {
      console.log(`    [${label}第${i + 1}次] 缺标记(${html.length}B)，疑似限流`);
      if (i < retries - 1) { await sleep(500 + i * 500); continue; }
      throw new Error(`[${label}] 缺标记 ${requireMarker}，疑似限流`);
    }
    return html;
  }
  throw new Error(`[${label}] 重试 ${retries} 次后仍未获取到有效内容`);
}

function parseOverview(html) {
  const meta = html.match(/name="createDate"\s+content="([^"]+)"/i);
  const extractedAt = meta ? meta[1] : new Date().toISOString().slice(0, 19).replace('T', ' ');
  const rowMatch = html.match(/<tr>\s*<td[^>]*>\s*住宅\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/i);
  if (!rowMatch) throw new Error('未能解析项目签约统计中的住宅行');
  return {
    extractedAt,
    overview: {
      signedCount: num(stripTags(rowMatch[1])),
      signedArea: num(stripTags(rowMatch[2])),
      avgPrice: num(stripTags(rowMatch[3]))
    }
  };
}

function parseStatuses(html) {
  const result = new Map();
  const re = /<div[^>]*style="([^"]*background\s*:\s*#[0-9a-fA-F]{6}[^"]*)"[^>]*>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(html))) {
    const style = m[1].toLowerCase().replace(/\s/g, '');
    const colorMatch = style.match(/background:(#[0-9a-f]{6})/);
    const blockText = stripTags(m[2]);
    const fullMatch = blockText.match(/(\d+单元-\d+)/);
    const shortMatch = blockText.match(/(?:^|\s)(\d{3,4})(?:\s|$)/);
    const houseNo = fullMatch ? fullMatch[1] : (shortMatch ? shortMatch[1] : '');
    if (colorMatch && statusByColor[colorMatch[1]] && houseNo) {
      result.set(houseNo, statusByColor[colorMatch[1]]);
    }
  }
  return result;
}

function headers(extra = {}) {
  return {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function request(pathname, options = {}) {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/${pathname}`;
  if (undiciRequest && supabaseAgent) {
    const reqOptions = {
      method: options.method || 'GET',
      headers: options.headers || {},
      dispatcher: supabaseAgent
    };
    if (options.body) reqOptions.body = options.body;
    const { statusCode, headers, body } = await undiciRequest(url, reqOptions);
    const text = await body.text();
    if (statusCode >= 400) {
      throw new Error(`${pathname} 请求失败：${statusCode} ${text}`);
    }
    return {
      ok: statusCode < 400,
      status: statusCode,
      headers: {
        get(name) { return headers[name.toLowerCase()] || null; }
      },
      text() { return Promise.resolve(text); },
      json() { return Promise.resolve(JSON.parse(text)); }
    };
  }
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${pathname} 请求失败：${res.status} ${text}`);
  }
  return res;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function upsert(table, rows, conflict) {
  for (const part of chunk(rows, 150)) {
    await request(`${table}?on_conflict=${encodeURIComponent(conflict)}`, {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates' }),
      body: JSON.stringify(part)
    });
  }
}

async function countRows(table, query) {
  const res = await request(`${table}?select=*${query}`, {
    method: 'HEAD',
    headers: headers({ Prefer: 'count=exact' })
  });
  return res.headers.get('content-range');
}

(async () => {
  console.log('读取项目概览...');
  const projectHtml = await fetchText(data.project.sourceUrl, { retries: 8, minLen: 5000, requireMarker: '住宅', label: '项目概览' });
  const parsedProject = parseOverview(projectHtml);
  data.project.overview = parsedProject.overview;
  data.project.extractedAt = parsedProject.extractedAt;
  const snapshotDate = parsedProject.extractedAt.slice(0, 10);
  console.log('snapshotDate=' + snapshotDate);
  console.log('overview=' + JSON.stringify(parsedProject.overview));

  let updated = 0;
  let missing = 0;
  for (const building of data.buildings) {
    console.log('读取楼栋 ' + building.name);
    const html = await fetchText(building.url, { minLen: 20000, label: building.name });
    const statusMap = parseStatuses(html);
    const isSingleUnit = new Set(building.houses.map(function(h){ return h.unit; })).size === 1;
    for (const house of building.houses) {
      const status = statusMap.get(house.houseNo) || (isSingleUnit ? statusMap.get(house.room) : null);
      if (status) {
        if (house.status !== status) updated++;
        house.status = status;
      } else {
        missing++;
      }
    }
  }
  console.log('状态变化数量=' + updated);
  console.log('未匹配房源数量=' + missing);
  if (missing > 0) {
    console.log('部分房号未在官网楼盘表中匹配到，保留本地已有状态继续写入今日快照。');
  }

  const houses = [];
  for (const building of data.buildings) {
    for (const house of building.houses) {
      houses.push({
        project_code: projectCode,
        house_key: `${building.name} ${house.houseNo}`,
        building: building.name,
        house_no: house.houseNo,
        floor: house.floor ?? null,
        unit: house.unit ?? null,
        room: house.room ?? null,
        building_area: house.buildingArea ?? null,
        area_bucket: house.areaBucket ?? null,
        source: house.source || 'manual_corrected',
        building_url: building.url || null,
        status: house.status,
        total_price: house.totalPrice || null
      });
    }
  }

  await upsert('daily_project_snapshots', [{
    project_code: projectCode,
    snapshot_date: snapshotDate,
    extracted_at: parsedProject.extractedAt,
    signed_count: parsedProject.overview.signedCount,
    signed_area: parsedProject.overview.signedArea,
    avg_price: parsedProject.overview.avgPrice,
    raw_overview: parsedProject.overview
  }], 'project_code,snapshot_date');

  await upsert('houses', houses.map(h => ({
    project_code: h.project_code,
    house_key: h.house_key,
    building: h.building,
    house_no: h.house_no,
    floor: h.floor,
    unit: h.unit,
    room: h.room,
    building_area: h.building_area,
    area_bucket: h.area_bucket,
    source: h.source,
    building_url: h.building_url
  })), 'project_code,house_key');

  await upsert('house_status_snapshots', houses.map(h => ({
    project_code: h.project_code,
    snapshot_date: snapshotDate,
    house_key: h.house_key,
    building: h.building,
    house_no: h.house_no,
    status: h.status,
    building_area: h.building_area,
    total_price: h.total_price,
    raw_status: { areaBucket: h.area_bucket, source: h.source }
  })), 'project_code,snapshot_date,house_key');

  fs.writeFileSync(dataPath, 'window.PROJECT_DATA = ' + JSON.stringify(data) + ';\n', 'utf8');

  console.log('写入完成');
  console.log('daily_project_snapshots=' + await countRows('daily_project_snapshots', '&project_code=eq.jiahua_junyuan'));
  console.log('house_status_snapshots_today=' + await countRows('house_status_snapshots', `&project_code=eq.jiahua_junyuan&snapshot_date=eq.${snapshotDate}`));
  console.log('dataPath=' + dataPath);
  console.log('zipPath=' + zipPath);
})();

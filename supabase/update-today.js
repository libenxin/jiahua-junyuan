const fs = require('fs');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const root = path.resolve(projectDir, '..');
const dataPath = path.join(projectDir, 'assets', 'project-data.js');
const zipPath = path.join(root, 'jiahua-junyuan-web.zip');
const projectCode = 'jiahua_junyuan';
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) throw new Error('缺少 SUPABASE_URL 或 SUPABASE_SECRET_KEY');

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

async function fetchText(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`官网读取失败 ${res.status}: ${url}`);
      return await res.text();
    } catch (err) {
      console.log(`第${i + 1}次尝试失败: ${err.message}`);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 5000 * (i + 1)));
      else throw err;
    }
  }
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
  const res = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/rest/v1/${pathname}`, options);
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
  const projectHtml = await fetchText(data.project.sourceUrl);
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
    const html = await fetchText(building.url);
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

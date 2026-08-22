(function(){
  var data = window.PROJECT_DATA;
  var project = data.project;
  var buildings = data.buildings;
  var houses = buildings.flatMap(function(b){ return b.houses.map(function(h){ return Object.assign({building:b.name, buildingUrl:b.url}, h); }); });
  var signedLike = {'已签约':true,'网上联机备案':true};
  var areaTypes = ['88平','99平','118平','127平','134平','172平'];
  var viewKey = 'jiahua_junyuan_view_mode';
  var cloudState = {configured:false, loaded:false, message:'', current:null, previous:null};
  var chartArea = null;
  var latestAreaRows = null;
  var chartResizeBound = false;
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim(), accent2 = style.getPropertyValue('--accent2').trim(), muted = style.getPropertyValue('--muted').trim(), rule = style.getPropertyValue('--rule').trim();
  var ok = style.getPropertyValue('--available').trim(), sold = style.getPropertyValue('--dealed').trim(), online = style.getPropertyValue('--dealed').trim(), reserved = style.getPropertyValue('--reserved').trim();
  var chartSale = style.getPropertyValue('--chartSale').trim(), chartUnavailable = style.getPropertyValue('--chartUnavailable').trim();

  function fmtInt(n){ return Number(n || 0).toLocaleString('zh-CN'); }
  function fmtArea(n){ return Number(n || 0).toLocaleString('zh-CN',{maximumFractionDigits:2,minimumFractionDigits:2}) + '㎡'; }
  function fmtMoney(n){ return Number(n || 0).toLocaleString('zh-CN',{maximumFractionDigits:0}) + '元'; }
  function fmtPrice(n){ return Number(n || 0).toLocaleString('zh-CN',{maximumFractionDigits:2,minimumFractionDigits:2}) + '元/㎡'; }
  function pct(a,b){ return b ? (a / b * 100).toFixed(1) + '%' : '-'; }
  function isSigned(h){ return !!signedLike[h.status]; }
  function signedKey(h){ return h.building + ' ' + h.houseNo; }
  function statusClass(status){ return status === '已签约' || status === '网上联机备案' ? 'dealed' : status === '已预订' ? 'reserved' : status === '不可售' ? 'disabled' : ''; }
  function statusName(status){ return status === '已签约' || status === '网上联机备案' ? '已成交' : status; }
  function areaClass(bucket){
    return bucket === '88平' ? 'area-88' : bucket === '99平' ? 'area-99' : bucket === '118平' ? 'area-118' : bucket === '127平' ? 'area-127' : bucket === '134平' ? 'area-134' : bucket === '172平' ? 'area-172' : 'area-other';
  }
  function sourceLabel(h){ return h.source === 'official' ? '官方详情' : h.source === 'inferred' ? '同户位补齐' : '未识别'; }
  function houseKey(h){ return h.building + ' ' + h.houseNo; }
  function snapshotFromCurrent(){
    return {
      savedAt: new Date().toISOString(),
      snapshotDate: project.snapshotDate || '',
      overview: project.overview,
      signedHouses: houses.filter(isSigned).map(function(h){ return {key:houseKey(h), building:h.building, houseNo:h.houseNo, area:h.buildingArea, status:h.status, totalPrice:h.totalPrice || null}; })
    };
  }
  function getSupabaseConfig(){
    var cfg = window.SUPABASE_CONFIG || {};
    return {
      enabled: cfg.enabled === true,
      url: String(cfg.url || '').replace(/\/+$/,''),
      anonKey: String(cfg.anonKey || ''),
      projectCode: cfg.projectCode || 'jiahua_junyuan'
    };
  }
  function hasSupabaseConfig(cfg){
    return !!(cfg.enabled && cfg.url && cfg.anonKey && cfg.url.indexOf('your-project') === -1 && cfg.anonKey.indexOf('your-anon-key') === -1);
  }
  function supabaseFetch(cfg, path){
    var headers = {
      apikey:cfg.anonKey,
      Accept:'application/json'
    };
    if(cfg.anonKey.indexOf('sb_publishable_') !== 0){
      headers.Authorization = 'Bearer ' + cfg.anonKey;
    }
    return fetch(cfg.url + '/rest/v1/' + path, {
      headers:headers
    }).then(function(res){
      if(!res.ok) return res.text().then(function(text){ throw new Error(text || ('Supabase 请求失败：' + res.status)); });
      return res.json();
    });
  }
  function buildHouseMap(){
    var map = new Map();
    houses.forEach(function(h){ map.set(houseKey(h), h); });
    return map;
  }
  function applyStatusRows(rows){
    var statusMap = new Map((rows || []).map(function(r){ return [r.house_key, r]; }));
    houses.forEach(function(h){
      var row = statusMap.get(houseKey(h));
      if(row){
        h.status = row.status || h.status;
        h.totalPrice = row.total_price || null;
      }
    });
    buildings.forEach(function(b){
      b.houses.forEach(function(h){
        var row = statusMap.get(b.name + ' ' + h.houseNo);
        if(row){
          h.status = row.status || h.status;
          h.totalPrice = row.total_price || null;
        }
      });
    });
  }
  function buildSnapshot(day, rows){
    var houseMap = buildHouseMap();
    return {
      savedAt: day.extracted_at || day.created_at || day.snapshot_date,
      snapshotDate: day.snapshot_date,
      overview:{
        signedCount:day.signed_count,
        signedArea:day.signed_area,
        avgPrice:day.avg_price
      },
      signedHouses:(rows || []).filter(function(r){ return !!signedLike[r.status]; }).map(function(r){
        var h = houseMap.get(r.house_key) || {};
        return {
          key:r.house_key,
          building:r.building || h.building || '',
          houseNo:r.house_no || h.houseNo || r.house_key,
          area:r.building_area || h.buildingArea || 0,
          status:r.status,
          totalPrice:r.total_price || null
        };
      })
    };
  }
  function loadCloudData(){
    var cfg = getSupabaseConfig();
    cloudState.configured = hasSupabaseConfig(cfg);
    if(!cloudState.configured){
      cloudState.message = 'Supabase 尚未配置，当前仅展示内置静态数据。填入 Supabase 项目地址和 anon key 后，昨日成交会统一读取云端历史快照。';
      cloudState.current = snapshotFromCurrent();
      return Promise.resolve(cloudState);
    }
    var projectFilter = 'project_code=eq.' + encodeURIComponent(cfg.projectCode);
    return supabaseFetch(cfg, 'daily_project_snapshots?select=*&' + projectFilter + '&order=snapshot_date.desc&limit=2').then(function(days){
      if(!days || !days.length){
        cloudState.message = 'Supabase 已连接，但还没有每日快照数据。自动更新任务首次写入后，这里会显示云端昨日成交。';
        cloudState.current = snapshotFromCurrent();
        return cloudState;
      }
      var latest = days[0];
      var previous = days[1] || null;
      project.extractedAt = latest.extracted_at || latest.snapshot_date;
      project.snapshotDate = latest.snapshot_date;
      project.overview = {
        signedCount:latest.signed_count,
        signedArea:latest.signed_area,
        avgPrice:latest.avg_price
      };
      var latestRowsPath = 'house_status_snapshots?select=*&' + projectFilter + '&snapshot_date=eq.' + encodeURIComponent(latest.snapshot_date) + '&limit=2000';
      var previousRowsPath = previous ? 'house_status_snapshots?select=*&' + projectFilter + '&snapshot_date=eq.' + encodeURIComponent(previous.snapshot_date) + '&limit=2000' : null;
      return Promise.all([
        supabaseFetch(cfg, latestRowsPath),
        previousRowsPath ? supabaseFetch(cfg, previousRowsPath) : Promise.resolve([])
      ]).then(function(result){
        var latestRows = result[0] || [];
        var previousRows = result[1] || [];
        applyStatusRows(latestRows);
        cloudState.loaded = true;
        cloudState.message = '已读取 Supabase 云端快照：' + latest.snapshot_date + (previous ? '，对比日期：' + previous.snapshot_date : '。');
        cloudState.current = buildSnapshot(latest, latestRows);
        cloudState.previous = previous ? buildSnapshot(previous, previousRows) : null;
        return cloudState;
      });
    }).catch(function(err){
      cloudState.message = 'Supabase 读取失败，当前回退展示内置静态数据。错误信息：' + err.message;
      cloudState.current = snapshotFromCurrent();
      return cloudState;
    });
  }

  function renderMeta(){
    document.getElementById('meta').innerHTML = [
      '数据提取：' + project.extractedAt,
      '楼栋：' + buildings.length + '栋',
      '房源：' + houses.length + '套',
      '官网项目：' + project.name,
      cloudState.loaded ? '云端快照：Supabase' : '云端快照：待配置'
    ].map(function(t){ return '<span class="pill">'+t+'</span>'; }).join('');
    document.getElementById('footer').textContent = '数据源：北京市住房和城乡建设委员会项目公示与楼盘表页面；历史快照建议存储于 Supabase，所有访问者统一读取同一份云端数据。';
  }

  function renderOverview(){
    var ov = project.overview;
    document.getElementById('overviewStats').innerHTML = [
      ['已签约套数', fmtInt(ov.signedCount) + '套'],
      ['已签约面积', fmtArea(ov.signedArea)],
      ['成交均价', fmtPrice(ov.avgPrice)]
    ].map(function(s){ return '<div class="stat"><div class="num">'+s[1]+'</div><div class="label">'+s[0]+'</div></div>'; }).join('');

    var rows = areaTypes.map(function(type){
      var list = houses.filter(function(h){ return h.areaBucket === type; });
      var available = list.filter(function(h){ return h.status === '可售'; }).length;
      var unavailable = list.length - available;
      return {
        type:type,
        total:list.length,
        available:available,
        unavailable:unavailable,
        availablePct:list.length ? available / list.length * 100 : 0,
        unavailablePct:list.length ? unavailable / list.length * 100 : 0
      };
    });
    renderCharts(rows);
  }

  function renderCharts(areaRows){
    latestAreaRows = areaRows;
    var isMobile = document.body.classList.contains('mobile-view');
    if(!chartArea) chartArea = echarts.init(document.getElementById('chartArea100'), null, {renderer:'svg'});
    chartArea.setOption({
      animation:false,
      tooltip:{
        trigger:'axis',
        appendToBody:true,
        formatter:function(params){
          var idx = params[0].dataIndex;
          var r = areaRows[idx];
          return r.type + '<br/>总套数：' + r.total + '套<br/>可售：' + r.available + '套<br/>成交：' + r.unavailable + '套';
        }
      },
      legend:{bottom:0,textStyle:{color:muted}},
      grid:{top:28,right:18,bottom:isMobile ? 48 : 72,left:12},
      xAxis:{
        type:'category',
        data:areaRows.map(function(r){return isMobile ? r.type : r.type + '\n总' + r.total + '套';}),
        axisLabel:{color:muted,lineHeight:18,interval:0,fontSize:isMobile ? 10 : 12},
        axisLine:{lineStyle:{color:rule}}
      },
      yAxis:{
        type:'value',
        max:100,
        show:false,
        axisLabel:{show:false},
        axisLine:{show:false},
        axisTick:{show:false},
        splitLine:{show:false}
      },
      color:[chartSale, chartUnavailable],
      series:[
        {
          name:'可售',
          type:'bar',
          stack:'total',
          barWidth:'54%',
          data:areaRows.map(function(r){return Number(r.availablePct.toFixed(2));}),
          label:{
            show:true,
            position:'inside',
            formatter:function(p){
              var r = areaRows[p.dataIndex];
              return r.available ? String(r.available) : '';
            },
            color:'#172033',
            fontWeight:700
          }
        },
        {
          name:'成交',
          type:'bar',
          stack:'total',
          barWidth:'54%',
          data:areaRows.map(function(r){return Number(r.unavailablePct.toFixed(2));}),
          label:{
            show:true,
            position:'inside',
            formatter:function(p){
              var r = areaRows[p.dataIndex];
              return r.unavailable ? String(r.unavailable) : '';
            },
            color:'#172033',
            fontWeight:700
          }
        }
      ]
    });
    if(!chartResizeBound){
      chartResizeBound = true;
      window.addEventListener('resize', function(){ chartArea.resize(); });
    }
  }

  function applyViewMode(mode){
    var selected = mode === 'mobile' ? 'mobile' : 'desktop';
    document.body.classList.toggle('mobile-view', selected === 'mobile');
    document.querySelectorAll('.view-btn').forEach(function(btn){
      btn.classList.toggle('active', btn.dataset.view === selected);
    });
    try { localStorage.setItem(viewKey, selected); } catch(e) {}
    if(latestAreaRows) renderCharts(latestAreaRows);
    setTimeout(function(){ window.dispatchEvent(new Event('resize')); }, 80);
  }

  function initViewSwitch(){
    var saved = 'desktop';
    try { saved = localStorage.getItem(viewKey) || 'desktop'; } catch(e) {}
    applyViewMode(saved);
    document.querySelectorAll('.view-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        applyViewMode(btn.dataset.view);
      });
    });
  }

  function renderDaily(){
    var prev = cloudState.previous;
    var el = document.getElementById('dailyCompare');
    var cur = cloudState.current || snapshotFromCurrent();
    if(!prev){
      el.innerHTML = '<p class="note">'+ cloudState.message +'</p>';
      return;
    }
    var prevMap = new Map(prev.signedHouses.map(function(h){ return [h.key,h]; }));
    var curMap = new Map(cur.signedHouses.map(function(h){ return [h.key,h]; }));
    var newSold = cur.signedHouses.filter(function(h){ return !prevMap.has(h.key); });
    var returned = prev.signedHouses.filter(function(h){ return !curMap.has(h.key); });
    var prevAmount = (prev.overview.signedArea || 0) * (prev.overview.avgPrice || 0);
    var curAmount = (cur.overview.signedArea || 0) * (cur.overview.avgPrice || 0);
    var knownAmount = newSold.every(function(h){ return Number(h.totalPrice || 0) > 0; }) ? newSold.reduce(function(sum,h){ return sum + Number(h.totalPrice || 0); }, 0) : null;
    var newAmount = knownAmount !== null ? knownAmount : curAmount - prevAmount;
    var newArea = newSold.length ? newSold.reduce(function(sum,h){ return sum + Number(h.area || 0); }, 0) : ((cur.overview.signedArea || 0) - (prev.overview.signedArea || 0));
    var newAvg = newArea ? newAmount / newArea : 0;
    var cards = [
      ['新成交套数', newSold.length + '套'],
      ['退房套数', returned.length + '套'],
      ['新成交总价', fmtMoney(newAmount)],
      ['新成交均价', newArea ? fmtPrice(newAvg) : '-']
    ].map(function(c){ return '<div class="compare-card"><strong>'+c[1]+'</strong><span>'+c[0]+'</span></div>'; }).join('');
    el.innerHTML =
      '<p class="hint">'+ cloudState.message +'</p>' +
      '<div class="compare-grid">'+cards+'</div>' +
      '<h3>新成交房源</h3>' + renderHouseList(newSold) +
      '<h3>退房房源</h3>' + renderHouseList(returned);
  }

  function renderHouseList(list){
    if(!list.length) return '<p class="empty">无</p>';
    return '<div class="table-wrap" style="margin-bottom:14px"><table><thead><tr><th>楼栋</th><th>房号</th><th>建筑面积</th><th>状态</th></tr></thead><tbody>' +
      list.map(function(h){ return '<tr><td>'+h.building+'</td><td><strong>'+h.houseNo+'</strong></td><td>'+fmtArea(h.area)+'</td><td>'+h.status+'</td></tr>'; }).join('') +
      '</tbody></table></div>';
  }

  function renderBuildings(){
    document.getElementById('buildingList').innerHTML = buildings.map(function(b, idx){
      var list = b.houses.slice().sort(function(a,b){ return (b.floor-a.floor) || (a.unit-b.unit) || a.room.localeCompare(b.room); });
      var bucketOrder = Array.from(new Set(list.map(function(h){ return h.areaBucket; }))).sort(function(a,b){
        return Number(a.replace('平','')) - Number(b.replace('平',''));
      });
      var bucketSummary = bucketOrder.map(function(bucket){
        var bucketHouses = list.filter(function(h){ return h.areaBucket === bucket; });
        var bucketSold = bucketHouses.filter(isSigned).length;
        return '<span>' + bucket + '共' + bucketHouses.length + '套，已成交' + bucketSold + '套</span>';
      }).join('');
      var floors = Array.from(new Set(list.map(function(h){ return h.floor; }))).sort(function(a,b){ return b-a; });
      var grid = floors.map(function(f){
        var hs = list.filter(function(h){ return h.floor === f; });
        return '<div class="floor-row"><div class="floor-label">'+f+'F</div><div class="houses">' + hs.map(function(h){
          return '<div class="house '+statusClass(h.status)+' '+areaClass(h.areaBucket)+'" title="'+b.name+' '+h.houseNo+'｜'+statusName(h.status)+'｜'+h.areaBucket+'｜'+sourceLabel(h)+'"><span>'+h.houseNo+'</span><small>'+h.areaBucket+'</small></div>';
        }).join('') + '</div></div>';
      }).join('');
      return '<details '+(idx===0?'open':'')+'><summary><span class="building-title"><span>'+b.name+'</span><span class="building-hint">点击查看房源图详情</span></span><span class="building-summary">'+bucketSummary+'</span></summary><div class="building-body">'+grid+'</div></details>';
    }).join('');
  }

  initViewSwitch();
  loadCloudData().then(function(){
    renderMeta();
    renderOverview();
    renderDaily();
    renderBuildings();
  });
})();

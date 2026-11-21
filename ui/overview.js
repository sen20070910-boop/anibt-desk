'use strict';
(() => {
  let mode = '', busy = false;
  const button = $('continued-playback-button');
  const status = $('continued-playback-status');
  function playbackTime(position) {
    const seconds = Math.max(0, Math.floor(position));
    const parts = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
    return (parts[0] ? parts : parts.slice(1)).map((part, i) => i ? String(part).padStart(2, '0') : part).join(':');
  }
  async function updatePlayback() {
    if (busy || S.page !== 'overview') return;
    const { last } = await api('playback');
    if (busy || S.page !== 'overview') return;
    const title = last ? last.title + (last.episode ? ' · 第 ' + last.episode + ' 集' : '') : '';
    mode = last?.nextEpisode ? 'next' : last?.local && !last.finished ? 'resume' : '';
    if (!last) status.textContent = '在追番进度里用 mpv 播放后，播放位置会显示在这里。';
    else if (last.finished) status.textContent = title + ' · 已播完';
    else status.textContent = title + ' · 上次看到 ' + playbackTime(last.position) + (last.local ? '' : ' · 文件已移除');
    button.textContent = mode === 'next' ? '播放下一集' : mode === 'resume' ? '继续播放' : '打开追番进度';
  }
  button.addEventListener('click', guarded(async () => {
    if (!mode) return changePage('progress');
    if (busy) return;
    busy = true;
    button.disabled = true;
    try { await api('playback/start', { action: mode }); }
    finally { busy = false; button.disabled = false; await updatePlayback().catch(() => {}); }
  }));
  window.addEventListener('anibt-page-change', () => void updatePlayback().catch(() => {}));
  window.AniBTRuntime.register('continued-playback', updatePlayback, {
    intervalMs: 10000, enabled: () => S.page === 'overview',
  });
})();
(()=>{
  const D={kind:'animes',page:1,rows:[],request:0,total:0,pages:1};
  const specs={animes:{title:'正在订阅',hint:'按当前 RSS 中的番名统计。尚无发布的已订阅番剧可在「网站已订阅」查看。',empty:'当前 RSS 还没有番剧资源'},matched:{title:'符合偏好的资源',hint:'当前 RSS 中符合已保存偏好的发布；包括已处理、基线和等待补位的资源，不代表都会再次下载。',empty:'当前没有符合偏好的资源'},added:{title:'已自动添加的任务',hint:'从最近一次清理起累计自动添加，与首页计数一致；含仅手动清空显示的历史，不含手动添加或 qB 原有任务，也不代表当前下载进度。',empty:'还没有自动添加的任务'},pending:{title:'等待重试',hint:'持久队列中尚未提交成功的资源，包含等待优先组的条目。后台检查时会重新核对来源、网站退订与当前偏好。',empty:'当前没有等待重试的任务'}};
  const dialog=$('overview-details-dialog');
  function resourceButton(row,index){return `<button type="button" class="text-button" data-overview-resource="${index}">${row.animeTitle?'查看番剧资源':'查看已有资源'} →</button>`;}
  function render(data){
    D.rows=data.items;D.total=data.total;D.pages=data.pages;D.page=data.page;
    text('overview-details-count',`${data.filteredTotal} ${D.kind==='animes'?'部番剧':'条记录'}${$('overview-details-search').value.trim()?' / 共 '+data.total:''}`);
    text('overview-details-page',`第 ${data.page} / ${data.pages} 页`);
    $('overview-details-prev').disabled=data.page<=1;$('overview-details-next').disabled=data.page>=data.pages;
    $('overview-details-results').innerHTML=data.items.length?data.items.map((row,i)=>{
      const canOpen=D.kind==='animes'||!!row.animeTitle;
      let detail='';
      if(D.kind==='animes')detail=`<p>${row.count} 条发布 · ${row.groups.length?escape(row.groups.join(' · ')):'发布组未标注'}</p>`;
      else if(D.kind==='matched')detail=`<p>${escape(row.groupName||row.groupSlug||'发布组未标注')} · ${escape(row.resolution||'画质未标注')} · ${escape((row.languages||[]).join(' / '))}</p><div>${statusBadge(row)}</div>`;
      else if(D.kind==='added')detail=`<p>${date(row.at)} · ${escape(row.status)}</p><p class="overview-detail-path">下载目录：${escape(row.savePath||'旧记录未保存目录，请在 qB 中查看')}</p>`;
      else detail=`<div class="overview-detail-status"><span class="badge">${escape(row.status)}</span>${row.waitUntil?`<span>允许补位：${date(row.waitUntil)}</span>`:''}</div><p>${escape(row.reason)}</p>${row.lastError?`<p class="overview-detail-error">最近失败：${escape(row.lastError)}</p>`:''}`;
      return `<article class="overview-detail-row">${row.cover?`<img class="overview-detail-cover" data-cover-url="${escape(row.cover)}" data-cover-title="${escape(row.title)}" data-cover-bgm="${escape(row.bgmId)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:''}<div class="overview-detail-body"><h3>${escape(row.title)}</h3>${row.episode?`<span class="muted">第 ${escape(row.episode)} 集${row.animeTitle?' · '+escape(row.animeTitle):''}</span>`:''}${detail}${canOpen?resourceButton(row,i):''}</div></article>`;
    }).join(''):empty($('overview-details-search').value.trim()?'没有找到匹配记录':specs[D.kind].empty,'可更换关键词，或点击刷新重新读取。','search');
  }
  async function load(refresh=false){
    const request=++D.request,kind=D.kind,query=$('overview-details-search').value;
    $('overview-details-results').setAttribute('aria-busy','true');$('overview-details-refresh').disabled=true;
    $('overview-details-prev').disabled=true;$('overview-details-next').disabled=true;
    $('overview-details-results').innerHTML='<p class="muted">正在读取详情…</p>';
    try{
      let data;
      if(kind==='animes'||kind==='matched'){
        if(refresh||!S.feedLoaded)await loadFeed(refresh);
        if(request!==D.request||!dialog.open)return;
        let rows=kind==='animes'?animeList().map(a=>({...a,count:a.items.length,groups:[...new Set(a.items.map(i=>i.groupName||i.groupSlug).filter(Boolean))]})):S.feed.filter(i=>i.matched);
        const total=rows.length,q=norm(query).trim();if(q)rows=rows.filter(i=>norm([i.title,i.animeTitle,i.groupName,...(i.groups||[])].join(' ')).includes(q));
        const pages=Math.max(1,Math.ceil(rows.length/40));D.page=Math.min(D.page,pages);
        data={total,filteredTotal:rows.length,pages,page:D.page,items:rows.slice((D.page-1)*40,D.page*40)};
      }else data=await api('overview/details?'+new URLSearchParams({kind,q:query,page:String(D.page)}));
      if(request===D.request&&dialog.open){render(data);if(kind==='added'||kind==='pending')text(kind==='added'?'stat-added':'stat-pending',data.total);}
    }catch(e){if(request===D.request&&dialog.open){text('overview-details-results',e.message);text('overview-details-count','读取失败，请刷新重试');text('overview-details-page','');}}
    finally{if(request===D.request){$('overview-details-results').removeAttribute('aria-busy');$('overview-details-refresh').disabled=false;}}
  }
  function open(kind){D.kind=kind;D.page=1;D.rows=[];$('overview-details-search').value='';text('overview-details-title',specs[kind].title);text('overview-details-hint',specs[kind].hint);text('overview-details-count','正在读取…');text('overview-details-page','');for(const b of dialog.querySelectorAll('[data-overview-tab]')){const active=b.dataset.overviewTab===kind;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));}if(!dialog.open)dialog.showModal();void load();}
  for(const b of document.querySelectorAll('[data-overview-kind]'))b.addEventListener('click',()=>open(b.dataset.overviewKind));
  for(const b of dialog.querySelectorAll('[data-overview-tab]'))b.addEventListener('click',()=>open(b.dataset.overviewTab));
  let timer;$('overview-details-search').addEventListener('input',()=>{clearTimeout(timer);++D.request;D.page=1;timer=setTimeout(()=>void load(),200);});
  $('overview-details-refresh').addEventListener('click',()=>{clearTimeout(timer);void load(true);});
  for(const [id,delta]of [['overview-details-prev',-1],['overview-details-next',1]])$(id).addEventListener('click',()=>{D.page+=delta;void load();});
  dialog.addEventListener('close',()=>{++D.request;clearTimeout(timer);});
  $('overview-details-results').addEventListener('error',e=>{if(e.target.tagName==='IMG')e.target.hidden=true;},true);
  $('overview-details-results').addEventListener('click',guarded(e=>{const b=e.target.closest('[data-overview-resource]');if(!b)return;const row=D.rows[Number(b.dataset.overviewResource)];dialog.close();return window.AniBTResources.open({title:row.animeTitle||row.title,bgmId:row.bgmId||''});}));
})();

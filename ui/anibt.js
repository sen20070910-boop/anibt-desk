'use strict';
(()=>{
  const A={mode:S.catalogMode==='mine'?'mine':'season',seasonKey:'',seasonData:null,day:'all',filter:'',error:'',items:[],members:new Set(),user:null,linked:false,busy:false,loading:false,cursor:'',page:1,totalPages:0,loaded:false,pending:null,requests:new Map(),identities:new Map()};
  let desktopReady=false,scoreSort=false;
  const validScore=item=>typeof item.averageScore==='number'&&Number.isFinite(item.averageScore)&&item.averageScore>0&&item.averageScore<=100;
  const ordered=items=>scoreSort?[...items].sort((a,b)=>(validScore(b)?b.averageScore:-1)-(validScore(a)?a.averageScore:-1)):items;
  function rating(item){return validScore(item)?'<span class="site-score" title="AniBT 评分，百分制">★ '+escape(item.averageScore)+' / 100</span>':'<span class="site-score unrated">暂无评分</span>';}

  async function native(action,data={}){
    if(!window.chrome?.webview)return Promise.reject(new Error('请从桌面快捷方式打开工具，账号登录需要桌面窗口。'));
    if(action!=='capabilities'&&!desktopReady){const caps=await native('capabilities');if(!caps.account)throw new Error('请更新桌面组件后重新打开工具。');desktopReady=true;}
    return new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>{A.requests.delete(id);reject(new Error(action==='capabilities'?'桌面组件较旧，请关闭全部工具窗口，等待 30 秒后重新打开。':'AniBT 响应超时，请刷新后核对网站状态。'));},action==='capabilities'?3000:65000);A.requests.set(id,{resolve,reject,timer});window.chrome.webview.postMessage({type:'anibt-account',id,action,data});});
  }
  window.chrome?.webview?.addEventListener('message',event=>{
    const m=event.data;if(m?.type==='anibt-login-complete'){guarded(()=>connect(false))();return;}
    if(m?.type!=='anibt-account-response')return;const pending=A.requests.get(m.id);if(!pending)return;clearTimeout(pending.timer);A.requests.delete(m.id);m.error?pending.reject(new Error(m.error)):pending.resolve(m.result);
  });
  function today(){return new Date(Date.now()+8*3600000).getUTCDay();}
  function card(item,i,timeline=false){
    const subscribed=A.members.has(item.id)||item.subscribed;
    const day=Number.isInteger(item.weekday)&&item.weekday>=0&&item.weekday<=6?['周日','周一','周二','周三','周四','周五','周六'][item.weekday]:'';
    const time=day?day+' · '+(item.airTime||'具体时间待定'):'暂无排播资料';
    return`<article class="anime-card site-anime-card ${timeline?'timeline-card':''}"><div class="anime-poster" role="button" tabindex="0" data-site-resources="${i}" style="--poster-start:#9b88c4;--poster-end:#d8cbe8"><span class="poster-number">ANIBT / ${escape(item.format||'ANIME')}</span><span class="poster-text">${escape(item.title.slice(0,10))}</span>${item.cover?`<img data-cover-url="${escape(item.cover)}" data-cover-title="${escape(item.title)}" data-cover-bgm="${escape(item.bgmId)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`:''}</div><div class="anime-details"><h3 role="button" tabindex="0" data-site-resources="${i}" title="点击查看已有资源：${escape(item.title)}">${escape(item.title)}</h3><p class="site-original-title" title="${escape(item.originalTitle||'')}">${escape(item.originalTitle||'')}</p>${timeline?`<div class="timeline-airtime"><span class="airtime-label">放送时间（北京时间）：</span><time>${escape(time)}</time><span class="airtime-resource">${item.hasRelease?'已有资源':'暂无种子'}</span></div>`:''}<div class="anime-meta">${rating(item)}<span class="badge ${subscribed?'success':''}">${subscribed?'网站已订阅':escape(item.format||'番剧')}</span>${timeline?'':`<span>${item.year?escape(item.year):''} ${escape(item.season||'')}</span>`}<span>${Number.isInteger(item.episodes)&&item.episodes>0?'共 '+item.episodes+' 集':'总集数未公布'}</span></div><div class="site-anime-actions"><button class="button ${subscribed?'secondary':'primary'}" data-site-action="${subscribed?'unsubscribe':'subscribe'}" data-site-index="${i}" ${A.busy||!A.linked||!item.bgmId?'disabled':''}>${subscribed?'取消订阅':'订阅这部番'}</button><button type="button" class="text-button" data-site-resources="${i}">已有资源</button><button class="text-button" data-site-preferences="${i}" ${!item.bgmId?'disabled':''}>下载偏好</button></div></div></article>`;
  }
  const coverCache=new Map(),scoreCache=new Map(),episodesCache=new Map(),coverTried=new Map();
  const coverKey=i=>i.bgmId?'bgm:'+i.bgmId:'title:'+norm(i.title);
  async function hydrateCovers(force=false){if(!window.AniBTRuntime.active()||S.page!=='library')return;const rows=A.items.filter(i=>(!i.cover||!i.scoreChecked||!i.episodesChecked)&&(!coverTried.has(coverKey(i))||Date.now()-coverTried.get(coverKey(i))>60000));for(const i of rows)coverTried.set(coverKey(i),Date.now());for(let start=0;start<rows.length;start+=60){try{const result=await api('anibt/covers',{refresh:force,items:rows.slice(start,start+60).map(i=>({title:i.title,bgmId:i.bgmId||''}))});let changed=false;for(const row of result.items||[]){if(row.cover)coverCache.set(row.key,row.cover);scoreCache.set(row.key,row.averageScore??null);episodesCache.set(row.key,row.episodes??null);}for(const item of A.items)if(!item.cover&&coverCache.get(coverKey(item))){item.cover=coverCache.get(coverKey(item));changed=true;}for(const item of A.items)if(!item.scoreChecked&&scoreCache.has(coverKey(item))){item.averageScore=scoreCache.get(coverKey(item));item.scoreChecked=true;changed=true;}for(const item of A.items)if(!item.episodesChecked&&episodesCache.has(coverKey(item))){item.episodes=episodesCache.get(coverKey(item));item.episodesChecked=true;changed=true;}if(changed)render();}catch{}}}
  function renderSeason(){
    const data=A.seasonData;if(!data)return empty('季度时间线','正在准备本季番剧。','calendar');
    const match=item=>!A.filter||[item.title,item.originalTitle,item.bgmId].some(s=>String(s).toLocaleLowerCase().includes(A.filter.toLocaleLowerCase()));
    const counts=data.groups.map(g=>({...g,items:g.items.filter(match)}));
    $('anibt-weekdays').innerHTML=[{key:'all',label:'整周',count:counts.reduce((n,g)=>n+g.items.length,0)},...counts.map(g=>({key:String(g.weekday),label:g.label,count:g.items.length}))].map(g=>`<button type="button" class="season-day ${A.day===g.key?'selected':''}" data-season-day="${g.key}" aria-pressed="${A.day===g.key}">${g.label}${g.key===String(today())&&data.season===data.currentSeason?'<em>今天</em>':''}<span>${g.count}</span></button>`).join('');
    const indices=new Map(A.items.map((item,i)=>[item.id,i]));
    const groups=counts.filter(g=>A.day==='all'||String(g.weekday)===A.day);
    const shown=groups.reduce((n,g)=>n+g.items.length,0);
    text('anibt-catalog-count',`${data.season} · ${data.total} 部番剧${A.day!=='all'||A.filter?` · 当前显示 ${shown} 部`:''}`);
    if(scoreSort)return '<div class="anime-grid season-day-grid">'+ordered(groups.flatMap(g=>g.items)).map(item=>card(item,indices.get(item.id),true)).join('')+'</div>';
    return groups.filter(g=>g.items.length).map(g=>`<section class="season-section" aria-label="${g.label}"><div class="season-day-heading ${g.weekday===today()&&data.season===data.currentSeason?'is-today':''}"><div><span class="season-day-dot"></span><h3>${g.label}</h3>${g.weekday===today()&&data.season===data.currentSeason?'<span class="badge">今天</span>':''}</div><span>${g.items.length} 部${g.weekday===null?' · 放送信息待公布':''}</span></div><div class="season-card-grid">${g.items.map(item=>card(item,indices.get(item.id),true)).join('')}</div></section>`).join('')||empty('这个范围暂无番剧','可以切换星期、季度，或清空本季筛选词。','search');
  }
  function render(){
    for(const item of A.items)if(!item.episodesChecked&&episodesCache.has(coverKey(item))){item.episodes=episodesCache.get(coverKey(item));item.episodesChecked=true;}
    for(const item of A.items)if(!item.scoreChecked&&scoreCache.has(coverKey(item))){item.averageScore=scoreCache.get(coverKey(item));item.scoreChecked=true;}
    for(const item of A.items)if(!item.cover&&coverCache.has(coverKey(item)))item.cover=coverCache.get(coverKey(item));
    $('anibt-score-sort').textContent=scoreSort?'评分从高到低 · 恢复默认':'按评分排列';$('anibt-score-sort').setAttribute('aria-pressed',String(scoreSort));$('anibt-score-sort').disabled=A.loading||A.busy;text('anibt-score-hint','评分来自 AniBT，采用百分制；'+(A.mode==='mine'?'仅排列当前页，翻页后排列该页。':A.mode==='search'?'排列已加载的搜索结果，可继续加载更多。':scoreSort?'当前所选日期范围内统一按评分排列。':'默认按放送时间分组。')+' 暂无评分排在最后。');
    text('anibt-account-name',A.linked?'已连接 '+A.user.name:'连接你的 AniBT 账号');text('anibt-account-hint',A.linked?'已核对与私人 RSS 属于同一账号，订阅修改会同步到网站。':'登录在工具内的官方窗口完成；需与偏好设置中的私人 RSS 属于同一账号。');
    $('anibt-connect').textContent=A.linked?'刷新账号连接':'登录 / 连接 AniBT';$('anibt-connect').disabled=A.busy||A.loading;
    for(const b of document.querySelectorAll('[data-anibt-mode]')){b.classList.toggle('selected',b.dataset.anibtMode===A.mode);b.disabled=A.busy||A.loading;}
    $('anibt-search-form').classList.toggle('hidden',A.mode!=='search');$('anibt-search-button').disabled=A.loading||A.busy;
    $('anibt-season-panel').classList.toggle('hidden',A.mode!=='season');
    for(const control of document.querySelectorAll('#anibt-season-panel select, #anibt-season-panel button'))control.disabled=A.loading||A.busy;
    $('anibt-catalog-results').classList.toggle('season-timeline',A.mode==='season');
    text('anibt-catalog-count',A.mode==='mine'?'网站已订阅 · 包含暂无资源的番剧':'在 AniBT 搜索番剧，订阅后自动进入追番流程');
    $('anibt-next').classList.toggle('hidden',A.loading||A.mode==='season'||(A.mode==='search'?!A.cursor:A.page>=A.totalPages));$('anibt-previous').classList.toggle('hidden',A.mode!=='mine'||A.page<=1||A.loading);
    text('anibt-pagination-hint',A.mode==='mine'?`第 ${A.page} / ${Math.max(1,A.totalPages)} 页`:'');
    const results=$('anibt-catalog-results');
    if(A.loading){results.innerHTML=loadingResults('正在读取 AniBT 番剧…');return;}
    const wasLoading=results.firstElementChild?.classList.contains('discovery-loading');
    if(A.error){$('anibt-catalog-results').innerHTML=empty('暂时无法读取番剧',A.error+' 可点击刷新重试。','search');return;}
    results.innerHTML=A.mode==='season'?renderSeason():A.items.length?ordered(A.items).map(item=>card(item,A.items.indexOf(item))).join(''):empty(A.mode==='mine'?'还没有网站订阅':A.loaded?'没有找到匹配的番剧':'搜索想追的下一部番',A.mode==='mine'?'可以切回季度时间线，选择喜欢的番剧进行订阅。':'支持中文、日文、英文番名和 Bangumi 编号。订阅前先连接 AniBT 账号。','search');
    if(wasLoading)window.AniBTMotion?.results(results,'.timeline-card, .anime-card');
    void hydrateCovers();
  }
  async function loadSeason(season=A.seasonKey,refresh=false){
    if(A.loading||A.busy)return;A.mode='season';A.loading=true;A.error='';A.seasonKey=season;A.seasonData=null;A.items=[];text('anibt-season-summary',`${season||'当前季度'} · 正在读取…`);$('anibt-weekdays').innerHTML='';render();
    try{
      const params=new URLSearchParams();if(season)params.set('season',season);if(refresh)params.set('refresh','1');
      const data=await api('anibt/season?'+params);A.seasonData=data;A.seasonKey=data.season;A.items=data.groups.flatMap(g=>g.items);
      $('anibt-season-select').innerHTML=data.availableSeasons.slice().reverse().map(s=>`<option value="${escape(s)}" ${s===data.season?'selected':''}>${escape(s)}${s===data.currentSeason?' · 当季':''}</option>`).join('');
      text('anibt-season-summary',`${data.season===data.currentSeason?'正在放送的这一季':'探索其他季度'} · ${data.total} 部作品 · 北京时间 UTC+8`);
      text('anibt-season-notice',data.truncated?`AniBT 本季接口最多返回 ${data.limit} 部，当前为部分结果；更多作品可切换“搜索番剧”查找。`:'放送时间来自 AniBT 排播，不代表字幕组种子发布时间；暂无种子的番剧也能先订阅。');
      $('anibt-season-notice').classList.toggle('season-warning',data.truncated);
    }catch(e){A.error=e.message;text('anibt-season-summary','季度读取失败');text('anibt-season-notice','可点击刷新重试，或切换到其他季度。');throw e;}
    finally{A.loading=false;render();}
  }
  function adjacentSeason(delta){const s=A.seasonKey;if(!s)return;const q='冬春夏秋',n=Number(s.slice(0,4))*4+q.indexOf(s[4])+delta;A.day='all';return loadSeason(`${Math.floor(n/4)}${q[((n%4)+4)%4]}`);}
  async function connect(openLogin=true){
    if(A.busy||A.loading)return;A.loading=true;render();
    try{
      if(A.linked)await native('refresh');
      const session=await native('session');if(!session.loggedIn){A.user=null;A.linked=false;A.members.clear();if(openLogin)await native('login');else throw new Error('请先在官方窗口完成登录。');return;}
      const identity=await native('identity');const linked=await api('anibt/account',identity);
      if(!linked.linked){A.linked=false;A.user=null;A.members.clear();throw new Error(linked.error);}
      A.user=linked.user;A.linked=true;const memberships=await native('memberships',{expectedUserId:A.user.id});A.members=new Set(memberships.animeIds);toast('AniBT 账号已连接，可以同步网站订阅。');
    }catch(e){A.linked=false;throw e;}
    finally{A.loading=false;render();}
    if(A.mode==='mine')await loadMine(1);
  }
  async function search(append=false){
    if(A.loading||A.busy)return;A.mode='search';A.loading=true;A.error='';if(!append)A.items=[];render();
    try{const params=new URLSearchParams({q:$('anibt-query').value.trim()});if(append&&A.cursor)params.set('cursor',A.cursor);const result=await api('anibt/catalog?'+params);A.items=append?[...A.items,...result.items]:result.items;A.cursor=result.cursor;A.loaded=true;}
    catch(e){A.error=e.message;throw e;}finally{A.loading=false;render();}
  }
  async function loadMine(page=1){
    if(!A.linked)throw new Error('请先连接 AniBT 账号，再读取网站已订阅列表。');if(A.loading||A.busy)return;
    A.mode='mine';A.loading=true;A.error='';A.items=[];render();
    try{const result=await native('list',{expectedUserId:A.user.id,page});A.items=result.items;A.page=result.page;A.totalPages=result.totalPages;A.loaded=true;for(const item of result.items)A.members.add(item.id);}
    catch(e){A.error=e.message;throw e;}finally{A.loading=false;render();}
  }
  function confirm(action,index){
    const item=A.items[index];if(!A.linked||!item?.bgmId)return;A.pending={action,item};text('anibt-change-title',action==='subscribe'?'订阅这部番剧？':'取消网站订阅？');text('anibt-change-name',item.title);
    text('anibt-change-description',action==='subscribe'?'会同步添加到 AniBT 我的订阅。新增成功后，开始追番日期默认设为添加当天（北京时间）；已有手动日期保留。网站端先不限发布组，下载仍按本工具的简中、组、目录和日期偏好执行，现有旧集数留待勾选补下载。':'会同步从 AniBT 我的订阅取消，并停止本工具该番尚未提交的重试；已有 qB 下载任务和文件继续保留。其他设备上的网站订阅也会同步变化。');
    $('anibt-confirm-change').textContent=action==='subscribe'?'确认订阅并同步':'确认取消订阅';$('anibt-change-dialog').showModal();
  }
  async function change(){
    if(A.busy||!A.pending)return;const {action,item}=A.pending,identityKey=action+':'+item.id;
    A.busy=true;S.operation='website-subscription';renderStatus();render();$('anibt-confirm-change').disabled=true;
    let changeId,verified=false,subscribed=action==='unsubscribe',existing=false;
    try{
      const session=await native('session');if(!session.loggedIn||session.user.id!==A.user.id)throw new Error('登录账号已变化，请重新连接。');
      changeId=(await api('anibt/begin',{action,bgmId:item.bgmId,title:item.title,wasSubscribed:A.members.has(item.id)||item.subscribed===true,userId:A.user.id})).changeId;
      if(!A.identities.has(identityKey))A.identities.set(identityKey,'subscription:'+crypto.randomUUID());
      const result=await native(action,{animeId:item.id,expectedUserId:A.user.id,commandIdentity:A.identities.get(identityKey)});verified=result.verified;subscribed=result.subscribed;existing=result.existing===true;
      if(!verified)throw new Error('网站订阅结果尚未确认。');if(subscribed)A.members.add(item.id);else A.members.delete(item.id);A.identities.delete(identityKey);
      item.subscribed=subscribed;$('anibt-change-dialog').close();toast(subscribed?'已同步订阅到 AniBT，之后的新发布会按偏好追踪。':'已从 AniBT 取消订阅。');
    }catch(e){
      if(changeId){try{const current=await native('memberships',{expectedUserId:A.user.id});subscribed=current.animeIds.includes(item.id);verified=true;A.members=new Set(current.animeIds);}catch{}}
      throw e;
    }finally{
      try{if(changeId)await api('anibt/finish',{changeId,verified,subscribed,existing});}finally{A.busy=false;S.operation=null;$('anibt-confirm-change').disabled=false;renderStatus();render();await loadStatus();await loadFeed(true);}
    }
    if(A.mode==='mine')await loadMine(A.page);
    if(action==='subscribe'&&verified&&subscribed&&!existing)await offerCatchup(item);

  }
  let catchupAnime=null;
  async function offerCatchup(item){
    try{const check=await api('anibt/catchup-check?'+new URLSearchParams({bgmId:item.bgmId,title:item.title}));if(!check.offer)return;catchupAnime=item;text('catchup-title',check.finished?'整季补下载？':'补下载往季番剧？');text('catchup-review',check.finished?'整季补下载 · 核对资源':'补下载 · 核对集数');text('catchup-hint',check.finished?'本次走整季补下载，不使用追番日期或开始集数。保留简中、发布组和画质偏好，核对集数后确认；公开 RSS 每次最多 100 条，可能缺集。':'往季尚未确认完结：本次补下载忽略追番日期，保留开始集数、简中和组等偏好。核对后确认，不改变自动追更设置。');text('catchup-name',item.title);text('catchup-timing',(check.season?check.season+' 季度':'已确认完结')+' · 当前为 '+check.currentSeason+' 季度');text('catchup-description',check.finished?'AniBT 已标记这部番剧完结，要补下载已有集数吗？':'这是一部往季番剧，但暂未确认完结，可能仍在更新。要补下载已有集数吗？');$('catchup-dialog').showModal();}
    catch{toast('订阅已成功，但季度检测暂时不可用；可点击番剧查看已有资源并补下载。',true);}
  }
  $('catchup-review').addEventListener('click',guarded(async()=>{if(!catchupAnime)return;const anime=catchupAnime;$('catchup-dialog').close();await window.AniBTResources.open(anime,{catchup:true});}));
  $('anibt-score-sort').addEventListener('click',()=>{scoreSort=!scoreSort;render();});
  $('anibt-connect').addEventListener('click',guarded(()=>connect(true)));
  $('anibt-open-account').addEventListener('click',guarded(()=>native('login')));
  $('anibt-search-form').addEventListener('submit',guarded(e=>{e.preventDefault();return search();}));
  $('anibt-search-form').addEventListener('submit',e=>e.preventDefault());
  for(const b of document.querySelectorAll('[data-anibt-mode]'))b.addEventListener('click',guarded(()=>{if(b.dataset.anibtMode==='mine')return loadMine(1);if(b.dataset.anibtMode==='season')return loadSeason();A.mode='search';A.items=[];A.cursor='';A.error='';A.loaded=false;render();}));
  $('anibt-season-select').addEventListener('change',guarded(()=>{A.day='all';return loadSeason($('anibt-season-select').value);}));
  $('anibt-season-prev').addEventListener('click',guarded(()=>adjacentSeason(-1)));
  $('anibt-season-next').addEventListener('click',guarded(()=>adjacentSeason(1)));
  $('anibt-season-current').addEventListener('click',guarded(()=>{A.day='all';return loadSeason('');}));
  $('anibt-season-refresh').addEventListener('click',guarded(()=>loadSeason(A.seasonKey,true)));
  $('anibt-season-today').addEventListener('click',guarded(()=>{A.day=String(today());if(A.seasonData?.season!==A.seasonData?.currentSeason)return loadSeason('');render();}));
  $('anibt-season-filter').addEventListener('input',()=>{A.filter=$('anibt-season-filter').value.trim();if(!A.loading)render();});
  $('anibt-weekdays').addEventListener('click',e=>{const button=e.target.closest('[data-season-day]');if(!button||A.loading||A.busy)return;A.day=button.dataset.seasonDay;render();});
  $('anibt-catalog-results').addEventListener('error',e=>{if(e.target.tagName==='IMG')e.target.hidden=true;},true);
  $('anibt-next').addEventListener('click',guarded(()=>A.mode==='mine'?loadMine(A.page+1):search(true)));
  $('anibt-previous').addEventListener('click',guarded(()=>loadMine(A.page-1)));
  $('anibt-catalog-results').addEventListener('click',e=>{const resource=e.target.closest('[data-site-resources]');if(resource){guarded(()=>window.AniBTResources.open(A.items[Number(resource.dataset.siteResources)]))();return;}const action=e.target.closest('[data-site-action]');if(action)confirm(action.dataset.siteAction,Number(action.dataset.siteIndex));const preferences=e.target.closest('[data-site-preferences]');if(preferences){const item=A.items[Number(preferences.dataset.sitePreferences)];openAnimeRule({title:item.title,bgmId:item.bgmId,items:[{folderName:item.title}]});}});
  $('anibt-catalog-results').addEventListener('keydown',guarded(e=>{if(!['Enter',' '].includes(e.key)||e.target.tagName==='BUTTON')return;const b=e.target.closest('[data-site-resources]');if(b){e.preventDefault();return window.AniBTResources.open(A.items[Number(b.dataset.siteResources)]);}}));
  $('anibt-confirm-change').addEventListener('click',guarded(change));$('anibt-change-dialog').addEventListener('cancel',e=>{if(A.busy)e.preventDefault();});
  window.AniBTLibrary={enter:()=>{render();if(S.accountLogin){S.accountLogin=false;guarded(async()=>{await connect(true);if(A.mode==='season'&&!A.seasonData)await loadSeason();})();}else if(A.mode==='season'&&!A.seasonData&&!A.loading)guarded(()=>loadSeason())();},refresh:async()=>{coverTried.clear();scoreCache.clear();episodesCache.clear();window.AniBTCovers?.refresh();await(A.mode==='mine'?loadMine(A.page):A.mode==='season'?loadSeason(A.seasonKey,true):search());for(const item of A.items){item.scoreChecked=false;item.episodesChecked=false;}coverTried.clear();await hydrateCovers(true);}};render();
})();

'use strict';
const sourceLabel = Object.fromEntries([...document.querySelectorAll('#page-discover [data-source]')]
  .map(button => [button.dataset.source, button.textContent.trim()]));
const D={pathEdited:false,pathLoading:false,pathError:'',pathRequest:0,suppressPath:false,progressTarget:null,items:[],providers:[],sources:new Set(Object.keys(sourceLabel)),view:'releases',shown:24,loaded:false,busy:false,adding:false,selected:null,variants:[],present:new Set(),tasksRequest:0};
const discoveryFiles = { request: 0, loading: false, preview: null, selected: new Set() };
const discoveryFileLabels = {
  video: '正片候选', subtitle: '字幕', font: '字幕字体', audio: '外挂音轨',
  extra: '特典与附带文件', other: '其他文件',
};

function resetDiscoveryFiles() {
  discoveryFiles.request++;
  discoveryFiles.loading = false;
  discoveryFiles.preview = null;
  discoveryFiles.selected.clear();
  $('discovery-files-read').textContent = '读取文件清单';
  $('discovery-files-read').disabled = !D.selected?.downloadable;
  $('discovery-files-controls').classList.add('hidden');
  $('discovery-files-list').classList.add('hidden');
  $('discovery-files-list').textContent = '';
  $('discovery-subtitle-evidence').classList.add('hidden');
  text('discovery-files-summary', '读取后可跳过特典、扫图等附带文件。');
}

function updateDiscoveryFileSummary() {
  const files = discoveryFiles.preview.files;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const chosen = files.filter(file => discoveryFiles.selected.has(file.index));
  const size = chosen.reduce((sum, file) => sum + file.size, 0);
  text('discovery-files-summary', '已选 ' + chosen.length + ' / ' + files.length + ' 个文件 · ' + bytes(size)
    + ' / ' + bytes(total) + (chosen.length ? '' : ' · 请至少选择一个文件'));
  updateDiscoverAddButton();
}

function updateDiscoveryFilePreset(mode) {
  discoveryFiles.selected = new Set(discoveryFiles.preview.files
    .filter(file => mode === 'all' || (mode === 'recommend' && file.recommended)).map(file => file.index));
  for (const field of $('discovery-files-list').querySelectorAll('input')) {
    field.checked = discoveryFiles.selected.has(Number(field.dataset.fileIndex));
  }
  updateDiscoveryFileSummary();
}

async function loadDiscoveryFiles() {
  const item = D.selected;
  if (!item?.downloadable || D.adding || discoveryFiles.loading) return;
  resetDiscoveryFiles();
  const request = discoveryFiles.request;
  discoveryFiles.loading = true;
  $('discovery-files-read').disabled = true;
  text('discovery-files-summary', '正在读取文件清单。磁力链接可能需要等待做种者返回清单…');
  try {
    const preview = await api('discover/files', { resultId: item.resultId });
    if (request !== discoveryFiles.request || !$('discovery-dialog').open) return;
    discoveryFiles.preview = preview;
    const sidecars = preview.files.filter(file => file.kind === 'subtitle');
    const languages = [...new Set(sidecars.map(file => file.language))];
    text('discovery-subtitle-evidence', (languages.length
      ? '外挂字幕（按文件名） · ' + languages.join(' / ') + '。'
      : '文件清单中未列出正片外挂字幕。')
      + ' 视频内封字幕可在下载后从任务详情读取。');
    $('discovery-subtitle-evidence').classList.remove('hidden');
    const groups = new Map();
    for (const file of preview.files) {
      if (!groups.has(file.kind)) groups.set(file.kind, []);
      groups.get(file.kind).push(file);
    }
    $('discovery-files-list').innerHTML = Object.entries(discoveryFileLabels).map(([kind, label]) => {
      const files = groups.get(kind);
      if (!files) return '';
      return '<section class="discovery-file-group"><h5>' + label + ' · ' + files.length + '</h5>'
        + files.map(file => '<label class="discovery-file-row"><input type="checkbox" data-file-index="' + file.index
          + '"><span>' + escape(file.path) + (file.language ? ' <small>· ' + escape(file.language) + '</small>' : '')
          + '</span><small>' + escape(bytes(file.size)) + '</small></label>').join('') + '</section>';
    }).join('');
    $('discovery-files-list').classList.remove('hidden');
    $('discovery-files-controls').classList.remove('hidden');
    updateDiscoveryFilePreset('recommend');
  } catch (error) {
    if (request === discoveryFiles.request) {
      text('discovery-files-summary', error.message === '没有找到此功能。'
        ? '当前界面服务未加载文件选择功能。请关闭所有 AniBT 窗口，等待约 30 秒后再打开。'
        : error.message);
    }
  } finally {
    if (request === discoveryFiles.request) {
      discoveryFiles.loading = false;
      $('discovery-files-read').disabled = false;
      $('discovery-files-read').textContent = '重新读取';
      updateDiscoverAddButton();
    }
  }
}

for (const mode of ['recommend', 'all', 'clear']) {
  $('discovery-files-' + mode).addEventListener('click', () => updateDiscoveryFilePreset(mode));
}
$('discovery-files-list').addEventListener('change', event => {
  const index = Number(event.target.dataset.fileIndex);
  if (!discoveryFiles.preview || !Number.isInteger(index)) return;
  if (event.target.checked) discoveryFiles.selected.add(index);
  else discoveryFiles.selected.delete(index);
  updateDiscoveryFileSummary();
});
$('discovery-files-read').addEventListener('click', guarded(loadDiscoveryFiles));
$('discovery-dialog').addEventListener('close', () => { discoveryFiles.request++; });
const discoveryLanguageNames = new Intl.DisplayNames('zh-CN', { type: 'language', fallback: 'none' });
const specialSubtitleNames = new Map([['CHS','简中'],['CHT','繁中'],['ZH','中文（简繁未标注）'],['EN','英文']]);
function subtitleNames(codes) {
  return [...new Set(codes.map(code => specialSubtitleNames.get(code) ||
    (/^[a-z]{2,3}$/i.test(code) ? discoveryLanguageNames.of(code.toLowerCase()) : null)).filter(Boolean))].join(' / ');
}
function subtitleLabel(items) {
  const titled = [...new Set(items.flatMap(item => item.languages))];
  const published = [...new Set(items.flatMap(item => item.subtitleDetails?.languages || []))];
  const external = [...new Set(items.flatMap(item => item.subtitleDetails?.sidecars || []))];
  const names = subtitleNames([...titled, ...published]);
  const sidecars = subtitleNames(external);
  if (names) return { label: names, title: published.length ? '来自资源标题和发布页的字幕说明' : '来自发布标题或站点标注', simplified: titled.includes('CHS') || published.includes('CHS') };
  if (sidecars) return { label: '外挂 · ' + sidecars, title: '来自发布页的外挂字幕文件名', simplified: external.includes('CHS') };
  if (items.some(item => item.multipleSubtitles || item.subtitleDetails?.multiple)) return { label: '多语字幕 · 语言待核对' };
  if (items.some(item => item.subtitleDetails?.hasSubtitles)) return { label: '有字幕 · 语言待核对' };
  if (items.some(item => item.subtitleDetails?.state === 'checked')) return { label: '发布页未列字幕语言' };
  if (items.some(item => item.subtitleDetails?.state === 'unavailable')) return { label: '发布页暂未读到' };
  return { label: '字幕语言待核对' };
}
function releaseLanguage(item) { return subtitleLabel([item]).label; }
function subtitleBadge(items) {
  const detail = subtitleLabel(items);
  return '<span class="pill '+(detail.simplified?'green':'gray')+'" title="'+escape(detail.title||'下载后可读取实际内封字幕轨')+'">'+escape(detail.label)+'</span>';
}
function refreshSelectedSubtitleMetadata() {
  const item = D.selected;
  if (!item) return;
  $('discovery-selected-meta').innerHTML = subtitleBadge([item])
    + '<span class="pill gray">'+escape(item.resolution||'画质未标注')+'</span>'
    + '<span class="pill gray">'+escape(item.sizeText||'体积未提供')+'</span>'
    + '<span class="pill gray">'+(item.seeders==null?'做种数未提供':'做种 '+item.seeders)+'</span>';
  const button = $('discovery-subtitles-read');
  button.classList.toggle('hidden', !item.subtitleLookup);
  button.disabled = !!item.subtitleLoading;
  button.textContent = item.subtitleLoading ? '正在查发布页…' : '查发布页字幕';
}
async function lookupDiscoverySubtitles(items) {
  const candidates = [...new Set(items)].filter(item => item.subtitleLookup && !item.subtitleLoading).slice(0,12);
  if (!candidates.length) return;
  for (const item of candidates) item.subtitleLoading = true;
  if ($('discovery-dialog').open) refreshSelectedSubtitleMetadata();
  try {
    const result = await api('discover/subtitles', { ids: candidates.map(item => item.resultId) });
    const details = new Map(result.items.map(item => [item.resultId,item]));
    for (const item of candidates) item.subtitleDetails = details.get(item.resultId);
  } catch {
    for (const item of candidates) item.subtitleDetails = { state: 'unavailable' };
  } finally {
    for (const item of candidates) item.subtitleLoading = false;
    if (!D.busy && candidates.some(item => D.items.includes(item))) renderDiscover();
    if ($('discovery-dialog').open) refreshSelectedSubtitleMetadata();
  }
}
$('discovery-subtitles-read').addEventListener('click', () => {
  if (D.selected) void lookupDiscoverySubtitles([D.selected]);
});
function isDiscoveredPresent(item) {
  return D.present.has(item.infoHash?.toLowerCase());
}

async function refreshDiscoveryTasks(force = false) {
  const request = ++D.tasksRequest;
  const hashes = [...new Set([...D.items, ...D.variants].map(item => item.infoHash?.toLowerCase()).filter(hash => /^[a-f0-9]{40}$/.test(hash)))];
  let present = [];
  if (hashes.length) {
    try {
      const result = await api('discover/tasks', { hashes, refresh: force });
      if (result.connected) present = result.hashes;
    } catch {
      // If qB cannot be checked, the add request still verifies it before submitting.
    }
  }
  if (request !== D.tasksRequest) return;
  if (present.length === D.present.size && present.every(hash => D.present.has(hash))) return;
  D.present = new Set(present);
  updateDiscoverAddButton();
  if (!D.busy) renderDiscover();
}
function sourceTags(item){return item.sources.map(source=>`<span class="source-tag source-${source}">${escape(sourceLabel[source]||source)}</span>`).join('');}
function renderSourceSelection(){for(const button of document.querySelectorAll('[data-source]')){const chosen=D.sources.has(button.dataset.source);button.classList.toggle('selected',chosen);button.setAttribute('aria-pressed',String(chosen));}}
function renderProviders(){const states={ok:'已连接',fallback:'已关联公开发行',error:'连接失败','browser-required':'需浏览器验证'};$('discovery-providers').innerHTML=D.providers.map(p=>`<div class="provider-status ${p.state==='ok'?'online':p.state==='fallback'?'fallback':'offline'}"><span class="tiny-dot"></span><strong>${escape(p.name)}</strong><span>${escape(states[p.state]||p.state)}</span><small>${p.count} 条${p.via?' · '+escape(p.via):''}</small></div>`).join('');const warnings=D.providers.filter(p=>p.message).map(p=>p.name+'：'+p.message);text('discovery-notice',warnings.join(' '));$('discovery-notice').classList.toggle('hidden',!warnings.length);}
function filteredDiscoverItems(){let items=D.items.filter(item=>($('discovery-language').value!=='chs'||item.languages.includes('CHS'))&&(!$('discovery-resolution').value||item.resolution===$('discovery-resolution').value||$('discovery-resolution').value==='2160p'&&item.resolution==='4k'));const sort=$('discovery-sort').value,prefer=$('discovery-language').value==='prefer';items.sort((a,b)=>(prefer?Number(b.languages.includes('CHS'))-Number(a.languages.includes('CHS')):0)||(sort==='seeders'?(b.seeders??-1)-(a.seeders??-1):sort==='size'?(b.sizeBytes||0)-(a.sizeBytes||0):sort==='title'?a.workTitle.localeCompare(b.workTitle,'zh-CN'):(Date.parse(b.publishedAt)||0)-(Date.parse(a.publishedAt)||0)));return items;}
function workGroups(items){const grouped=new Map();for(const item of items){const key=norm(item.workTitle||item.title).replace(/\s+/g,' ');if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(item);}return[...grouped.values()];}
function resultCard(items,index){const item=items[0],project=D.view==='projects';const sources=[...new Set(items.flatMap(i=>i.sources))];const added=items.every(isDiscoveredPresent);const sourceItem={sources};return`<article class="resource-card"><div class="resource-card-top"><span class="resource-mark">${project?icon('library'):icon('download')}</span><div class="resource-sources">${sourceTags(sourceItem)}</div>${added?'<span class="badge success">已在 qB</span>':''}</div><h3 title="${escape(project?item.workTitle:item.title)}">${escape(project?item.workTitle:item.title)}</h3><div class="resource-attributes">${subtitleBadge(items)}${item.resolution?`<span class="pill gray">${escape(item.resolution)}</span>`:''}${project?`<span class="pill gray">${items.length} 个发行版本</span>`:''}</div><p class="resource-group">${escape([...new Set(items.map(i=>i.groupName).filter(Boolean))].join(' · ')||'发布组未标注')}</p><div class="resource-card-bottom"><div><strong>${project&&items.length>1?'多个版本':escape(item.sizeText||'体积未提供')}</strong><small>${item.seeders==null?'做种数未提供':'做种 '+item.seeders}${item.publishedAt?' · '+date(item.publishedAt):''}</small></div><button class="button secondary" data-discover-index="${index}">${project?'选择版本':'查看并添加'} ${icon('chevron')}</button></div></article>`;}
function renderDiscover(){const items=filteredDiscoverItems();const groups=D.view==='projects'?workGroups(items):items.map(i=>[i]);D.renderedGroups=groups;text('discovery-result-title',D.view==='projects'?'作品与发行版本':'跨站发行资源');text('discovery-result-count',D.loaded?`${groups.length} ${D.view==='projects'?'部作品':'份资源'} · 同种子已合并来源`:'选择来源，搜索喜欢的作品');const results=$('discovery-results');
if(D.busy){results.innerHTML=loadingResults('正在搜索资源…','各来源独立连接，单个来源暂不可用时仍会显示其他结果。');$('discovery-more').classList.add('hidden');return;}
const wasLoading=results.firstElementChild?.classList.contains('discovery-loading');
results.innerHTML=groups.length?groups.slice(0,D.shown).map(resultCard).join(''):empty(D.loaded?'还没有找到符合条件的资源':'从一个喜欢的名字开始',D.loaded?'可以试试英文名、日文名、压制组名，或调整画质和字幕筛选。':'搜索新番、老番、合集和 VCB-S 发行作品，选好版本后直接加入 qBittorrent。','search');$('discovery-more').classList.toggle('hidden',groups.length<=D.shown);
if(wasLoading)window.AniBTMotion?.results(results,'.resource-card');
}
async function searchDiscover(force = false) {
  if (D.busy) return;
  if (!D.sources.size) throw new Error('请至少选择一个资源来源。');
  D.busy = true;
  let lookup = false;
  D.shown = 24;
  $('discovery-submit').disabled = true;
  $('discovery-submit').innerHTML = icon('refresh') + '正在搜索…';
  text('discovery-aliases', '');
  renderDiscover();
  try {
    const query = new URLSearchParams({
      q: $('discovery-query').value.trim(),
      sources: [...D.sources].join(','),
      fuzzy: $('discovery-fuzzy').checked ? '1' : '0',
    });
    if (force) query.set('refresh', '1');
    const result = await api('discover/search?' + query);
    D.items = result.items;
    lookup = !!result.query;
    D.providers = result.providers;
    D.loaded = true;
    void refreshDiscoveryTasks(true);
    if (result.aliases?.length) text('discovery-aliases', '同时搜索了 ' + result.aliases.join('、'));
    renderProviders();
    if (result.truncated) toast('结果较多，目前显示近期 240 份去重资源，可用更准确的词缩小范围。');
  } finally {
    D.busy = false;
    $('discovery-submit').disabled = false;
    $('discovery-submit').innerHTML = icon('search') + '搜索资源';
    renderDiscover();
    if (lookup) void lookupDiscoverySubtitles(D.renderedGroups.slice(0,D.shown).flat().filter(item => !item.languages.length));
  }
}
function setSelectedVariant(id){D.selected=D.variants.find(i=>i.resultId===id)||D.variants[0];const item=D.selected;if(!item)return;resetDiscoveryFiles();$('discovery-acknowledge').checked=false;$('discovery-allow-alternate').checked=false;$('discovery-add-error').classList.add('hidden');const unknown=S.status?.config.filters.languages.includes('CHS')&&!item.languages.includes('CHS');$('discovery-subtitle-check').classList.toggle('hidden',!unknown);refreshSelectedSubtitleMetadata();$('discovery-source-links').innerHTML=item.links.map(link=>`<a href="${escape(link.url)}" target="_blank" rel="noopener noreferrer">${escape(sourceLabel[link.source]||'来源')} 发布页 ↗</a>`).join('');updateDiscoverAddButton();if(!D.pathEdited&&!D.suppressPath)void updateDiscoveryPath();}
function updateDiscoverAddButton(){const item=D.selected;if(!item)return;const subtitleNeeded=S.status?.config.filters.languages.includes('CHS')&&!item.languages.includes('CHS');const added=isDiscoveredPresent(item)&&!D.progressTarget;$('discovery-add').disabled=D.adding||D.pathLoading||!!D.pathError||added||!item.downloadable||discoveryFiles.loading||!discoveryFiles.preview||!discoveryFiles.selected.size||(D.progressTarget&&!$('discovery-progress-ack').checked)||(subtitleNeeded&&!$('discovery-acknowledge').checked);$('discovery-add').innerHTML=icon(added?'check':'download')+(D.adding?'正在添加…':added?'已在下载列表':!discoveryFiles.preview?'先读取文件清单':'下载选中文件');}
function openDiscoverDetail(index){openDiscoverVariants(D.renderedGroups[index]||[]);}
function openDiscoverVariants(variants,savePath=""){D.variants=variants;if(!D.variants.length)return;D.pathEdited=!!savePath;D.pathLoading=false;D.pathError='';D.suppressPath=true;D.pathRequest++;D.selected=D.variants[0];const first=D.variants[0];text('discovery-detail-title',first.workTitle||first.title);text('discovery-detail-subtitle',D.variants.length>1?`找到 ${D.variants.length} 个发行版本，请选择需要的画质、字幕与压制组。`:first.title);$('discovery-version-group').innerHTML='<option value="">全部发布组</option>'+[...new Set(D.variants.map(i=>i.groupName||'未标注发布组'))].sort((a,b)=>a.localeCompare(b,'zh-CN')).map(g=>`<option value="${escape(g)}">${escape(g)}</option>`).join('');renderVersionGroups();$('discovery-save-path').value=savePath;$('discovery-save-path').placeholder='正在计算作品子目录…';text('discovery-path-hint',savePath?'使用上次保存目录，可按需修改。':'');D.suppressPath=false;$('discovery-paused').checked=!!S.status?.config.qb.paused;$('discovery-progress-check').classList.toggle('hidden',!D.progressTarget);$('discovery-progress-ack').checked=false;text('discovery-progress-label',D.progressTarget?`我已核对这份资源对应《${D.progressTarget.title}》第 ${D.progressTarget.episode} 集，将关联到追番进度。`:'');setSelectedVariant(first.resultId);$('discovery-dialog').showModal();void refreshDiscoveryTasks(true);}
async function addDiscovered(){if(D.adding||D.pathLoading||D.pathError||!D.selected||discoveryFiles.loading||!discoveryFiles.preview||!discoveryFiles.selected.size)return;const selected=D.selected;if(isDiscoveredPresent(selected)&&!D.progressTarget)return;D.adding=true;const fileSelection={previewId:discoveryFiles.preview.previewId,indices:[...discoveryFiles.selected]};updateDiscoverAddButton();$('discovery-add-error').classList.add('hidden');try{await requireDiscoveryFolders();const result=await api('discover/add',{...(D.progressTarget&&$('discovery-progress-ack').checked?{association:D.progressTarget}:{}),resultId:selected.resultId,fileSelection,savePath:D.pathEdited?$('discovery-save-path').value.trim():'',paused:$('discovery-paused').checked,acknowledgeSubtitle:$('discovery-acknowledge').checked,allowAlternate:$('discovery-allow-alternate').checked});D.tasksRequest++;selected.infoHash=result.hash;D.present.add(result.hash);D.progressTarget=null;$('discovery-progress-check').classList.add('hidden');toast(result.startPending?'文件选择已应用，任务启动待确认，请到 qB 查看。':result.existing?'qBittorrent 已存在这个任务，保留原保存位置。':'已添加到 qBittorrent'+(result.savePath?' · '+result.savePath:''));await Promise.allSettled([loadStatus(),loadQb(true),refreshDiscoveryTasks(true)]);renderDiscover();}catch(e){text('discovery-add-error',e.message);$('discovery-add-error').classList.remove('hidden');}finally{D.adding=false;updateDiscoverAddButton();}}
window.AniBTDiscover={reopen:async key=>{
  const {item,savePath}=await api('discover/reopen',{key});
  D.progressTarget=null;D.loaded=true;
  changePage('discover');
  openDiscoverVariants([item],savePath);
  void loadDiscoveryFiles();
},find:async(query,target=null)=>{D.progressTarget=target;D.loaded=true;$('discovery-query').value=query;changePage('discover');await searchDiscover();},refresh:()=>searchDiscover(true),enter:()=>{if(!D.loaded&&!D.busy)guarded(()=>searchDiscover())();else if(D.loaded)void refreshDiscoveryTasks(true);}};
$('discovery-search-form').addEventListener('submit',guarded(async e=>{e.preventDefault();await searchDiscover();}));
for(const button of document.querySelectorAll('[data-source]'))button.addEventListener('click',()=>{const source=button.dataset.source;if(D.sources.has(source))D.sources.delete(source);else D.sources.add(source);renderSourceSelection();});
$('discovery-select-all').addEventListener('click',()=>{D.sources=new Set(Object.keys(sourceLabel));renderSourceSelection();});
$('browse-vcb').addEventListener('click',guarded(async()=>{if(D.busy)return;D.progressTarget=null;D.sources=new Set(['vcb']);D.view='projects';$('discovery-query').value='';renderSourceSelection();for(const b of document.querySelectorAll('[data-discovery-view]')){const selected=b.dataset.discoveryView==='projects';b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));}await searchDiscover();}));
for(const button of document.querySelectorAll('[data-discovery-view]'))button.addEventListener('click',()=>{D.view=button.dataset.discoveryView;D.shown=24;for(const b of document.querySelectorAll('[data-discovery-view]')){b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));}renderDiscover();});
for(const id of ['discovery-language','discovery-resolution','discovery-sort'])$(id).addEventListener('change',()=>{D.shown=24;renderDiscover();});
$('discovery-more').addEventListener('click',()=>{D.shown+=24;renderDiscover();});
$('discovery-results').addEventListener('click',e=>{const button=e.target.closest('[data-discover-index]');if(button)openDiscoverDetail(Number(button.dataset.discoverIndex));});
$('discovery-variants').addEventListener('change',e=>{if(e.target.name==='discover-version')setSelectedVariant(e.target.value);});
$('discovery-progress-ack').addEventListener('change',updateDiscoverAddButton);
$('discovery-query').addEventListener('input',()=>D.progressTarget=null);
$('discovery-acknowledge').addEventListener('change',updateDiscoverAddButton);
$('discovery-add').addEventListener('click',guarded(addDiscovered));
$('discovery-find-work').addEventListener('click',guarded(async()=>{D.progressTarget=null;const title=D.selected.workTitle.split(/\s*\/\s*/)[0].slice(0,40);$('discovery-dialog').close();$('discovery-query').value=title;await searchDiscover();}));
function updateNetworkField(){$('custom-proxy-field').classList.toggle('hidden',$('setting-network-mode').value!=='custom');}
$('setting-network-mode').addEventListener('change',updateNetworkField);
updateNetworkField();

function renderVersionGroups(){const groups=new Map(),filter=$('discovery-version-group').value;for(const item of D.variants){const name=item.groupName||'未标注发布组';if(filter&&name!==filter)continue;if(!groups.has(name))groups.set(name,[]);groups.get(name).push(item);}const visible=[...groups.values()].flat();if(visible.length&&(!D.selected||!visible.some(i=>i.resultId===D.selected.resultId)))D.selected=visible[0];$('discovery-variants').innerHTML=[...groups].sort((a,b)=>a[0].localeCompare(b[0],'zh-CN')).map(([name,items])=>`<section class="discovery-version-group"><h3>${escape(name)} <span>${items.length} 个版本</span></h3>${items.map(item=>`<label class="discovery-variant"><input type="radio" name="discover-version" value="${item.resultId}" ${item.resultId===D.selected?.resultId?'checked':''}><span><strong>${escape(item.title)}</strong><small>${escape(item.resolution||'画质未标注')} · ${escape(item.sizeText||'体积未提供')} · ${escape(releaseLanguage(item))}</small></span></label>`).join('')}</section>`).join('');if(D.selected)setSelectedVariant(D.selected.resultId);}
$('discovery-version-group').addEventListener('change',renderVersionGroups);

async function requireDiscoveryFolders(){if(!(await api('ping')).capabilities?.discoveryAnimeFolders)throw new Error('请保存并关闭全部工具窗口，等待 30 秒后重新打开，以加载按作品分类的新版本。');}
async function updateDiscoveryPath(){const request=++D.pathRequest,item=D.selected;if(!item||D.pathEdited)return;D.pathLoading=true;D.pathError='';text('discovery-path-hint','正在读取作品目录…');updateDiscoverAddButton();try{await requireDiscoveryFolders();const r=await api('discover/path',{resultId:item.resultId,...(D.progressTarget?{association:D.progressTarget}:{})});if(request!==D.pathRequest||D.pathEdited)return;$('discovery-save-path').value=r.savePath;$('discovery-save-path').placeholder=r.waitingForQb?'qB 默认目录 / '+r.folderName+'（启动后读取）':r.savePath;text('discovery-path-hint',r.waitingForQb?'自动使用 qB 默认目录下的「'+r.folderName+'」子文件夹；添加时启动 qB 并读取实际位置。可填写完整目录覆盖。':'自动按作品分文件夹，单番指定目录优先。编辑可覆盖本次位置，清空或点击“恢复自动目录”可恢复。');}catch(e){if(request===D.pathRequest){D.pathError=e.message;text('discovery-path-hint',e.message);}}finally{if(request===D.pathRequest){D.pathLoading=false;updateDiscoverAddButton();}}}
$('discovery-save-path').addEventListener('input',()=>{D.pathRequest++;D.pathEdited=!!$('discovery-save-path').value.trim();D.pathLoading=false;D.pathError='';if(D.pathEdited){text('discovery-path-hint','本次使用你填写的完整目录。不会再追加子文件夹，也不改变全局设置。');updateDiscoverAddButton();}else void updateDiscoveryPath();});
$('discovery-auto-path').addEventListener('click',()=>{D.pathEdited=false;$('discovery-save-path').value='';void updateDiscoveryPath();});

const canRefreshDiscoveryTasks = () => S.page === 'discover' && D.loaded && D.items.length > 0;
window.AniBTRuntime.register('discovery-tasks', () => refreshDiscoveryTasks(), {
  intervalMs: 15000,
  enabled: canRefreshDiscoveryTasks,
});
window.addEventListener('focus', () => {
  if (canRefreshDiscoveryTasks() && window.AniBTRuntime.active()) void refreshDiscoveryTasks(true);
});

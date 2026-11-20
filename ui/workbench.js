'use strict';
(()=>{
 const W={shows:[],loading:false,dirty:false,plan:null};
  function prepareBackupPaths(){$('backup-error').classList.add('hidden');const dirs=W.plan?.restoreViewing?[]:W.plan?.directories||[];$('backup-path-review').classList.toggle('hidden',!dirs.length);$('backup-path-list').textContent=dirs.join('；');$('backup-path-confirm').checked=false;$('backup-path-mappings').value='';}
  function backupPathFields(){const rows=$('backup-path-mappings').value.split(/\r?\n/).filter(line=>line.trim());return{confirmPaths:$('backup-path-confirm').checked,pathMappings:rows.map(line=>{const n=line.indexOf('=>');if(n<0)throw new Error('目录映射请使用：原目录 => 新目录');return{from:line.slice(0,n).trim(),to:line.slice(n+2).trim()};})};}


 function selectPriority(){const inherit=$('rule-inherit-priority').checked;for(const id of ['rule-priority','rule-fallback'])$(id).disabled=inherit;}
 $('rule-inherit-priority').addEventListener('change',selectPriority);
 new MutationObserver(selectPriority).observe($('rule-dialog'),{attributes:true,attributeFilter:['open']});
 const progressMetadata=new Map();
 const coverKey=show=>show.bgmId?'bgm:'+show.bgmId:'title:'+norm(show.title);
 function showCover(show,meta){
   return meta?.cover?`<img data-cover-url="${escape(meta.cover)}" data-cover-title="${escape(show.title)}" data-cover-bgm="${escape(show.bgmId||'')}" alt="" loading="lazy">`:'<span>'+escape(show.title.slice(0,12))+'</span>';
 }
 async function loadShowMetadata(shows,cache,onUpdate){
   const queue=shows.filter(show=>!cache.has(show.key));
   for(let i=0;i<queue.length;i+=30){
     const subset=queue.slice(i,i+30);
     try{
       const result=await api('anibt/covers',{items:subset.map(show=>({title:show.title,bgmId:show.bgmId||''}))});
       const byKey=new Map(result.items.map(meta=>[meta.key,meta]));
       for(const show of subset){const meta=byKey.get(coverKey(show));if(meta?.cover)cache.set(show.key,meta);}
       onUpdate();
     }catch{}
   }
 }
 function paintProgressCovers(){
   for(const card of $('progress-results').querySelectorAll('[data-progress-show]')){
     const show=W.shows[Number(card.dataset.progressShow)],meta=progressMetadata.get(show?.key);
     const cover=card.querySelector('[data-progress-cover]');
     if(meta?.cover&&cover&&!cover.querySelector('img'))cover.innerHTML=showCover(show,meta);
   }
 }
 const resetDialog = $("manual-reset-dialog");
 let resetPlan = null, resetRequest = 0, resetting = false;
 async function openManualReset(show) {
   if (!show?.direct || resetting) return;
   const request = ++resetRequest;
   resetPlan = null;
   text("manual-reset-name", show.title);
   text("manual-reset-scope", "正在核对这部作品的记录…");
   $("manual-reset-error").classList.add("hidden");
   $("manual-reset-confirm").disabled = true;
   if (!resetDialog.open) resetDialog.showModal();
   try {
     const preview = await api("progress/manual/reset/preview", { key: show.key });
     if (request !== resetRequest || !resetDialog.open) return;
     resetPlan = { key: show.key, version: preview.version };
     text("manual-reset-name", preview.title);
     text("manual-reset-scope", `将清除这部作品的 ${preview.records} 条手动下载记录，以及本机观看进度、评分、评价和草稿。相关去重与完成通知也会清除。操作仅限工具内记录，删除后无法撤销。`);
     $("manual-reset-confirm").disabled = false;
   } catch (error) {
     if (request !== resetRequest || !resetDialog.open) return;
     text("manual-reset-scope", error.message);
   }
 }
 resetDialog.addEventListener("close", () => { resetRequest++; resetPlan = null; });
 resetDialog.addEventListener("cancel", event => { if (resetting) event.preventDefault(); });
 $("manual-reset-confirm").addEventListener("click", guarded(async () => {
   if (!resetPlan || resetting) return;
   resetting = true;
   const buttons = [...resetDialog.querySelectorAll("button")];
   buttons.forEach(button => { button.disabled = true; });
   $("manual-reset-error").classList.add("hidden");
   try {
     await api("progress/manual/reset", { ...resetPlan, confirm: true });
   } catch (error) {
     text("manual-reset-error", error.message);
     $("manual-reset-error").classList.remove("hidden");
     $("manual-reset-confirm").disabled = true;
     return;
   } finally {
     resetting = false;
     buttons.filter(button => button.id !== "manual-reset-confirm").forEach(button => { button.disabled = false; });
   }
   resetDialog.close();
   toast("已删除这部作品的工具记录。");
   await loadStatus();
   if ($("watched-library-dialog").open) await loadWatched();
   else await load();
 }));
 function directCard(show,i){
   const items=show.resources.map(row=>`<div class="progress-direct-row"><div><strong>${escape(row.title)}</strong><small>${escape(row.status)}${row.progress!==null&&row.progress<1?' · '+Math.round(row.progress*100)+'%':''}</small></div>${/^[a-f0-9]{40}$/.test(row.hash)?`<button type="button" class="text-button" data-qb-details="${escape(row.hash)}">任务详情</button>`:''}${row.reDownloadKey&&row.progress===null?`<button type="button" class="text-button" data-progress-redownload="${escape(row.reDownloadKey)}">再次下载</button>`:''}</div>`).join('');
   return `<article class="panel progress-show" data-progress-show="${i}"><div class="progress-show-heading"><div class="progress-show-info"><div class="progress-cover watched-library-cover" data-progress-cover>${showCover(show,progressMetadata.get(show.key))}</div><div><h3>${escape(show.title)}</h3><p class="muted">手动下载 · ${show.resources.length} 份资源</p></div></div>${show.direct?`<button type="button" class="text-button" data-progress-archive="${i}">${show.archived?'取消归档':'归档作品'}</button>`:''}</div><div class="progress-direct-list">${items}</div>${show.direct?`<div class="progress-edit">${show.watchSessions?.length?`<button type="button" class="text-button" data-progress-review="${i}">观看回顾</button>`:''}<button type="button" class="button secondary" data-progress-finish="${i}">已全部看完</button><button type="button" class="text-button danger-quiet" data-progress-manual-reset="${i}">删除记录</button></div>`:''}</article>`;
 }
 function render(){
  const origin=$('progress-origin').value;
  const view=$('progress-view').value,shows=W.shows.filter(s=>origin==='all'||(origin==='direct'?s.resources.length>0:!s.direct)).filter(s=>view==='all'||view==='archived'?view==='all'||s.archived:!s.archived&&!s.fullyWatched&&(view!=='unwatched'||(s.unwatched>0||s.direct&&s.resources.some(r=>r.progress>=1))));
  text('progress-summary',`${W.shows.filter(s=>!s.direct&&!s.archived&&!s.fullyWatched).length} 部在追 · ${W.shows.filter(s=>s.direct&&!s.archived&&!s.completedAt).length} 部手动下载`);
  $('progress-results').innerHTML=shows.length?shows.map(show=>{const i=W.shows.indexOf(show);if(show.direct||origin==='direct')return directCard(show,i);const ids=show.missing.flatMap(e=>e.candidateIds);return`<article class="panel progress-show" data-progress-show="${i}"><div class="progress-show-heading"><div class="progress-show-info"><div class="progress-cover watched-library-cover" data-progress-cover>${showCover(show,progressMetadata.get(show.key))}</div><div><span class="eyebrow">AniBT 追番</span><h3>${escape(show.title)}</h3><p class="muted">最新已知第 ${show.latest||'?'} 集 · 曾完成 ${show.downloaded} 集 · 已标记看过 ${show.episodes.filter(e=>e.watched).length} 集 ${show.archived?'· 已归档':''}</p></div></div><button type="button" class="text-button" data-progress-archive="${i}">${show.archived?'恢复追番':'归档这部番'}</button></div><div class="episode-strip">${show.episodes.map(e=>`<button type="button" class="badge episode-action ${e.watched?'success':''}" data-episode-show="${i}" data-episode-number="${e.number}" title="点击选择已看或未看；执行前会再次确认">${e.number} · ${e.watched?(e.deletionWarning?'删除待核对 · 已看':'已看'):escape(e.status)+' · 未看'}</button>`).join('')||'<span class="muted">暂无可识别的单集记录</span>'}</div><p class="muted">点击集数可单独标记已看 / 未看；单集标记优先于连续进度，删除和下载均需二次确认。</p><div class="progress-edit"><label>连续看到第 <input type="number" min="0" max="9999" value="${show.watched}" data-progress-watched="${i}"> 集</label><label>从第 <input type="number" min="1" max="9999" value="${show.startEpisode||1}" data-progress-start="${i}"> 集查漏</label>${show.watchSessions?.length?`<button type="button" class="text-button" data-progress-review="${i}">观看回顾</button>`:''}<button type="button" class="button secondary" data-progress-finish="${i}">已全部看完</button><button type="button" class="button secondary" data-progress-save="${i}">保存进度</button><button type="button" class="text-button" data-progress-settings="${i}">下载偏好</button></div><div class="progress-gaps"><strong>待核对缺集 · ${show.missing.length} 集${show.rangeLimited?'（仅检查起始后的 500 集）':''}</strong><p class="muted">依据当前 RSS、已提交记录和 qB 状态整理；未扫描磁盘。设定起始集可跳过不打算补的旧集。</p><div class="gap-buttons">${show.missing.map(e=>`<button type="button" class="episode-gap" data-gap-show="${i}" data-gap-episode="${e.number}" title="跨站查找，核对后添加">第 ${e.number} 集 ↗</button>`).join('')||'<span class="badge success">已知范围内没有缺集</span>'}</div>${ids.length?`<button type="button" class="button primary" data-progress-backfill="${i}">预览并补齐 RSS 中可用的缺集</button>`:''}</div>${show.unknown.length?`<p class="muted">另有 ${show.unknown.length} 条合集 / 特别篇 / 未识别集数，不计入单集查漏：${show.unknown.map(escape).join('；')}</p>`:''}${show.resources.length?`<p class="muted">另有 ${show.resources.length} 份手动下载。具体版本可在下载记录核对。</p>`:''}</article>`;}).join(''):empty('这个视图暂无番剧','订阅资源和下载记录会在这里汇合，也可以切换到全部或已归档。','library');
 }
 async function load(){if(W.loading)return;W.loading=true;$('progress-refresh').disabled=true;try{const result=await api('progress');W.shows=result.shows;text('progress-hint',[result.feedError?'RSS 暂不可用：'+result.feedError:'范围按已知发布集数计算，未来集数不算缺集',!result.qbConnected?'qB 未连接，显示本机记录':'已读取 qB 当前进度',result.historicalUnidentified?`${result.historicalUnidentified} 条旧记录无法确定番名与集数，未强行归类`:''].filter(Boolean).join(' · '));render();void loadShowMetadata(W.shows,progressMetadata,paintProgressCovers);const n=S.status?.notifications||await api('notifications');const alerts=n.items.filter(i=>i.kind==='alert'&&!i.read);$('progress-alerts').innerHTML=alerts.length?alerts.map(a=>`<p><strong>${escape(a.title)}</strong><br><span class="muted">${escape(a.detail)}</span></p>`).join(''):'<p class="muted">目前没有未读异常提醒。历史提醒可在右上角通知记录中查看。</p>';}catch(e){$('progress-results').innerHTML=empty('进度暂时无法读取',e.message,'info');throw e;}finally{W.loading=false;$('progress-refresh').disabled=false;}}
 async function save(index,archive){const show=W.shows[index],article=document.querySelector(`[data-progress-show="${index}"]`);await api('progress',{key:show.key,title:show.title,watched:Number(article.querySelector('[data-progress-watched]')?.value??show.watched),startEpisode:Number(article.querySelector('[data-progress-start]')?.value??show.startEpisode??1),archived:archive??!!show.archived});W.dirty=false;toast('追番进度已保存。');await load();}
 $('progress-results').addEventListener('input',()=>W.dirty=true);
 $('progress-refresh').addEventListener('click',guarded(load));$('progress-view').addEventListener('change',render);$('progress-origin').addEventListener('change',render);$('progress-retry').addEventListener('click',guarded(async()=>{await doAction('check');await load();}));
 $('progress-results').addEventListener('click',guarded(async e=>{
  let b;
  if(b=e.target.closest('[data-progress-manual-reset]'))return openManualReset(W.shows[Number(b.dataset.progressManualReset)]);
  if(b=e.target.closest('[data-progress-redownload]')){b.disabled=true;try{return await window.AniBTDiscover.reopen(b.dataset.progressRedownload);}finally{b.disabled=false;}}
  if(b=e.target.closest('[data-progress-review]'))return window.AniBTReviews.open(W.shows[Number(b.dataset.progressReview)]);if(b=e.target.closest('[data-progress-finish]'))return window.AniBTEpisodeActions.openAll(W.shows[Number(b.dataset.progressFinish)]);if(b=e.target.closest('[data-episode-show]'))return window.AniBTEpisodeActions.open(W.shows[Number(b.dataset.episodeShow)],Number(b.dataset.episodeNumber));if(b=e.target.closest('[data-progress-save]'))return save(Number(b.dataset.progressSave));
  if(b=e.target.closest('[data-progress-archive]')){const i=Number(b.dataset.progressArchive);return save(i,!W.shows[i].archived);}
  if(b=e.target.closest('[data-progress-settings]')){const s=W.shows[Number(b.dataset.progressSettings)];return openAnimeRule({title:s.title,bgmId:s.bgmId,items:[{folderName:s.title}]});}
  if(b=e.target.closest('[data-gap-show]')){const s=W.shows[Number(b.dataset.gapShow)];return window.AniBTDiscover.find(s.title.slice(0,32)+' '+String(b.dataset.gapEpisode).padStart(2,'0'),{title:s.title,bgmId:s.bgmId,episode:String(b.dataset.gapEpisode)});}
  if(b=e.target.closest('[data-progress-backfill]'))return window.AniBTBackfill.open(W.shows[Number(b.dataset.progressBackfill)].missing.flatMap(e=>e.candidateIds));
 }));
 async function preview(single){const dialog=$('rules-preview-dialog');$('rules-preview-results').innerHTML=empty('正在分析当前资源','不会保存设置或提交任务。','clock');dialog.showModal();try{const patch=single?{rules:draftRules()}:settingsPatch();if(patch.startEpisode||S.status.config.startEpisode||single&&!$('rule-inherit-start-episode').checked)await requireStartEpisodeScheduling();const result=await api('rules/preview',{filters:patch.filters,rules:patch.rules,startDate:patch.startDate,startEpisode:patch.startEpisode});const rows=single?result.rows.filter(i=>S.rule.anime.bgmId?i.bgmId===S.rule.anime.bgmId:i.animeTitle===S.rule.anime.title):result.rows;$('rules-preview-results').innerHTML=rows.length?rows.map(i=>`<article class="rule-preview-row"><strong>${escape(i.title)}</strong><p class="${i.matched?'muted':'preview-excluded'}">${escape(i.decision)}</p></article>`).join(''):empty('当前 RSS 中没有可预览的资源','可以先保存偏好，等这部番有资源时再检查。','search');}catch(e){$('rules-preview-results').innerHTML=empty('预览暂时不可用',e.message,'info');throw e;}}
 $('preview-settings').addEventListener('click',guarded(()=>preview(false)));$('preview-rule').addEventListener('click',guarded(()=>preview(true)));
 $('backup-export').addEventListener('click',guarded(async()=>{const backup=await api('backup/export'),url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='AniBT-备份-'+new Date(Date.now()+8*3600000).toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('备份已导出，不含私人 RSS、密码或网站登录资料。');}));
 $('backup-import').addEventListener('click',()=>{$('backup-file').value='';$('backup-file').click();});
 $('backup-file').addEventListener('change',guarded(async()=>{const file=$('backup-file').files[0];if(!file)return;if(file.size>16777216)throw new Error('备份文件不能超过 16 MiB。');let data;try{data=JSON.parse(await file.text());}catch{throw new Error('备份不是有效 JSON 文件。');}W.plan=await api('backup/preview',data);text('backup-confirm','确认导入');text('backup-restore-description','偏好使用备份设置，下载与观看记录合并时本机已有记录优先；不会改网站订阅或 qB 任务。');text('backup-summary',`将导入 ${W.plan.rules} 条单番偏好、${W.plan.records} 条处理记录、${W.plan.shows} 部观看进度。${W.plan.requiresConnection?'导入后请填写你的连接资料。':''}`);prepareBackupPaths();$('backup-dialog').showModal();}));
 $('backup-confirm').addEventListener('click',guarded(async()=>{if(!W.plan)return;$('backup-confirm').disabled=true;try{const result=await api('backup/restore',{id:W.plan.id,confirm:true,...backupPathFields()});$('backup-dialog').close();W.plan=null;await loadStatus();fillSettings();await loadFeed();await load();if($('watched-library-dialog').open)await loadWatched();if($('library-tools-dialog').open)await window.AniBTLibraryTools?.refresh();toast(result.warning|| (result.requiresConnection?'备份已导入，请填写私人 RSS 和 qB 连接，再登录 AniBT。':'备份已导入，本机登录和连接凭据已保留。'),!!result.warning);}catch(error){text('backup-error',error.message);$('backup-error').classList.remove('hidden');}finally{$('backup-confirm').disabled=false;}}));
 window.AniBTRuntime.register('progress',load,{intervalMs:30000,enabled:()=>S.page==='progress'&&!W.dirty&&!document.querySelector('dialog[open]')});

 let watchedShows=[],watchedMetadata=new Map();
 function renderWatched(){
  const query=norm($('watched-library-search').value),filter=$('watched-library-filter').value,sort=$('watched-library-sort').value;const visible=watchedShows.filter(s=>(!query||norm(s.title+' '+(s.personalReview?.text||'')+' '+(s.watchSessions||[]).map(w=>w.personalReview?.text||'').join(' ')).includes(query))&&(filter==='all'||filter==='unreviewed'&&(!s.personalReview||s.personalReview.score===null&&!s.personalReview.text.trim())||filter==='rewatch'&&s.personalReview?.rewatch===true||filter==='scored'&&s.personalReview?.score!==null&&s.personalReview?.score!==undefined));visible.sort((a,b)=>sort==='score'?(b.personalReview?.score??-1)-(a.personalReview?.score??-1):sort==='website'?(watchedMetadata.get(b.key)?.averageScore??-1)-(watchedMetadata.get(a.key)?.averageScore??-1):sort==='title'?a.title.localeCompare(b.title,'zh-CN'):sort==='first'?String(a.watchSessions?.[0]?.completedAt||a.completedAt).localeCompare(String(b.watchSessions?.[0]?.completedAt||b.completedAt)):String(b.completedAt).localeCompare(String(a.completedAt)));text('watched-library-count','显示 '+visible.length+' / '+watchedShows.length+' 部');
  $('watched-library-results').innerHTML=visible.length?visible.map(show=>{const i=watchedShows.indexOf(show);const meta=watchedMetadata.get(show.key)||{},warning=show.showDeletion?.filesRemaining||show.showDeletion?.unknownFiles||show.showDeletion?.folderErrors;return `<article class="watched-library-card"><div class="watched-library-cover">${meta.cover?`<img data-cover-url="${escape(meta.cover)}" data-cover-title="${escape(show.title)}" data-cover-bgm="${escape(show.bgmId||'')}" alt="" loading="lazy">`:`<span>${escape(show.title.slice(0,12))}</span>`}</div><div><h3><button type="button" class="watched-review-title" data-watched-review="${i}">${escape(show.title)}</button></h3><p class="muted">第 ${(show.watchSessions?.length||0)+1} 次看完 · ${date(show.completedAt)}</p><p>${meta.format==='MOVIE'?'电影':show.direct?'手动下载 · '+show.resources.length+' 份资源':meta.episodes?'共 '+meta.episodes+' 集':'最新已知第 '+(show.latest||'?')+' 集'} · ${typeof meta.averageScore==='number'?'网站评分 '+meta.averageScore+' / 100':'暂无评分'}</p><span class="badge ${show.fullyWatched?'success':''}">${show.fullyWatched?'已全部看完':'有新集数待看'}</span>${warning?'<p class="muted">部分文件或目录仍待手动核对</p>':''}<div class="personal-review-summary"><strong>${show.personalReview?.score!==null&&show.personalReview?.score!==undefined?'我的评分：'+show.personalReview.score+' / 10':'我的评分：暂未评分'}</strong><p>${escape(show.personalReview?.text?.slice(0,80)||'还没有写下观后评价')}</p></div><div class="watched-library-tools"><button type="button" class="text-button" data-watched-review="${i}">我的评价</button><button type="button" class="text-button" data-watched-resources="${i}">查看资源</button><button type="button" class="text-button" data-watched-rewatch="${i}">开始重看</button><button type="button" class="text-button" data-watched-restore="${i}">${show.direct?'移回进度':'移回在追'}</button>${show.direct?`<button type="button" class="text-button danger-quiet" data-watched-manual-reset="${i}">删除记录</button>`:''}</div></div></article>`;}).join(''):empty(watchedShows.length?'当前条件没有匹配的番剧':'还没有收录看完的番剧',watchedShows.length?'可以清空搜索或切换筛选条件。':'在追番进度中点击“已全部看完”，二次确认后会收录到这里。','library');
 }
 async function loadWatched(){const result=await api('progress');watchedShows=result.shows.filter(s=>s.completedAt).sort((a,b)=>String(b.completedAt).localeCompare(String(a.completedAt)));renderWatched();await loadShowMetadata(watchedShows,watchedMetadata,()=>{if($('watched-library-dialog').open)renderWatched();});}
 for(const id of ['watched-library-search','watched-library-filter','watched-library-sort'])$(id).addEventListener(id==='watched-library-search'?'input':'change',renderWatched);
 $('open-watched-library').addEventListener('click',guarded(async()=>{$('watched-library-dialog').showModal();$('watched-library-results').textContent='正在读取看过的番剧…';try{await loadWatched();}catch(e){$('watched-library-results').textContent=e.message;}}));
 $('watched-library-results').addEventListener('click',guarded(async e=>{const reset=e.target.closest('[data-watched-manual-reset]');if(reset)return openManualReset(watchedShows[Number(reset.dataset.watchedManualReset)]);const rewatch=e.target.closest('[data-watched-rewatch]');if(rewatch)return window.AniBTLibraryTools.rewatch(watchedShows[Number(rewatch.dataset.watchedRewatch)]);const review=e.target.closest('[data-watched-review]');if(review)return window.AniBTReviews.open(watchedShows[Number(review.dataset.watchedReview)]);const restore=e.target.closest('[data-watched-restore]'),resources=e.target.closest('[data-watched-resources]');if(resources){const show=watchedShows[Number(resources.dataset.watchedResources)];$('watched-library-dialog').close();if(show.direct)return window.AniBTDiscover.find(show.title.slice(0,100));return window.AniBTResources.open({...show,...watchedMetadata.get(show.key)});}if(restore){const show=watchedShows[Number(restore.dataset.watchedRestore)];restore.disabled=true;try{await api('progress/show/restore',{key:show.key});if(show.direct){$('watched-library-dialog').close();$('progress-origin').value='direct';$('progress-view').value='active';changePage('progress');toast('已移回进度，可在资源旁点击「再次下载」。');}else{await loadWatched();await loadFeed();toast('已移回在追，观看进度和已删除文件状态保留；不会自动补下载。');}}finally{restore.disabled=false;}}}));

 if(S.openWatched){S.openWatched=false;queueMicrotask(()=>$('open-watched-library').click());}
 window.AniBTWatched={refresh:loadWatched};
 window.AniBTWorkbench={load:()=>guarded(load)(),previewBackup:async(data,options={})=>{W.plan=await api('backup/preview',{...data,_restoreViewing:options.viewingOnly===true});text('backup-summary','包含 '+W.plan.shows+' 部观看记录与 '+W.plan.records+' 条处理记录。');text('backup-confirm',options.viewingOnly?'确认恢复观看数据':'确认导入');text('backup-restore-description',options.viewingOnly?'将用备份替换对应番剧的观看进度、评分、评价和草稿；本机其他番剧保留，下载偏好与连接不变。恢复前会先保留当前状态的保护备份。不会改网站订阅或 qB 任务，需再次点击确认恢复。':'偏好使用备份设置，下载与观看记录合并时本机已有记录优先；不会改网站订阅或 qB 任务。');prepareBackupPaths();$('backup-dialog').showModal();}};
})();
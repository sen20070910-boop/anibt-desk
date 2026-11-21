'use strict';
(()=>{
 let show=null,episode=0,wholeShow=false,plan=null,busy=false,sequence=0;
 const dialog=$('episode-action-dialog'),confirmation=$('episode-confirm-dialog');
 async function prepare(action,hash){const n=++sequence;plan=null;busy=true;$('episode-prepare-error').textContent='正在核对资源与操作范围…';for(const b of dialog.querySelectorAll('button'))b.disabled=true;try{const result=await api(wholeShow?'progress/show/prepare':'progress/episode/prepare',wholeShow?{key:show.key}:{key:show.key,episode,action,...(hash?{hash}:{})});if(n!==sequence)return;plan=result;dialog.close();text('episode-confirm-title',wholeShow?'确认全部看完并删除资源？':action==='watched'?'确认已看并删除资源？':'确认未看并提交下载？');text('episode-confirm-name',wholeShow?`《${result.title}》· 已全部看完`:`《${result.title}》第 ${episode} 集`);$('episode-version-field').classList.toggle('hidden',action!=='unwatched');$('episode-version').innerHTML=result.candidates.map(c=>`<option value="${escape(c.hash)}" ${c.hash===result.selectedHash?'selected':''}>${escape(c.title)}</option>`).join('');$('episode-plan-details').innerHTML=action==='watched'?`<p>${wholeShow?(result.end?'将标记当前已知第 1–'+result.end+' 集已看':'将记录这部番已全部看完，暂无可识别的单集编号')+'，并收录到追番管理 → 我看过的。合集未识别集号不推算。':'将标记这一集已看。'}${wholeShow?'如果 mpv 正在占用下列视频，确认后先关闭对应播放器。':''}随后通过 qB 移除下列任务及其文件，删除无法撤销。</p>${result.cleanupFolders?.length?`<p>下列番剧目录在清空且没有其他下载任务使用时会一并移除。</p><ul>${result.cleanupFolders.map(folder=>`<li>${escape(folder)}</li>`).join('')}</ul>`:''}${result.targets.length?result.targets.map(t=>`<section><h4>${escape(t.title)}</h4><p class="muted">${escape(t.contentPath)}</p><ul class="episode-files">${t.files.map(f=>`<li>${escape(f.name)} · ${bytes(f.size)}</li>`).join('')}</ul></section>`).join(''):'<p class="muted">qB 当前没有找到与本次操作关联的任务。本次只标记已看，不会扫描或删除脱离 qB 的文件。</p>'}`:'<p>只下载当前选中的一个版本，并立即开始，不沿用添加后先暂停。若 qB 已有此任务，会校验并继续，不重复添加。确认成功后，这一集才改为未看。</p>';$('episode-rules-label').classList.toggle('hidden',!result.warning);text('episode-rules-text',result.warning?'本次资源不符合自动规则（'+result.warning+'），我已核对字幕与集数，确认手动下载。':'');$('episode-rules-ack').checked=false;text('episode-confirm-error','');$('episode-confirm-error').classList.add('hidden');confirmation.showModal();sync();}catch(e){text('episode-prepare-error',e.message);}finally{busy=false;for(const b of dialog.querySelectorAll('button'))b.disabled=false;sync();}}
 function sync(){$('episode-execute').disabled=busy||!plan||!!plan.warning&&!$('episode-rules-ack').checked;$('episode-version').disabled=busy;}
 $('episode-mark-watched').addEventListener('click',()=>void prepare('watched'));$('episode-mark-unwatched').addEventListener('click',()=>void prepare('unwatched'));
 $('episode-version').addEventListener('change',async()=>{if(busy)return;const hash=$('episode-version').value;confirmation.close();dialog.showModal();await prepare('unwatched',hash);});$('episode-rules-ack').addEventListener('change',sync);
 $('episode-execute').addEventListener('click',guarded(async()=>{if(busy||!plan)return;busy=true;confirmation.dataset.busy='1';sync();for(const b of confirmation.querySelectorAll('button'))b.disabled=true;try{const result=await api(plan.scope==='show'?'progress/show/confirm':'progress/episode/confirm',{id:plan.id,confirm:true,acknowledgeRules:$('episode-rules-ack').checked});confirmation.close();await loadStatus();await window.AniBTWorkbench.load();await loadFeed();toast(result.scope==='show'?'已收录到追番管理 → 我看过的。'+(result.filesRemaining||result.unknownFiles||result.folderErrors?'部分文件或目录仍需手动核对。':result.removedTasks?'已删除确认范围内的资源。':'qB 无关联任务，未删除其他文件。'):result.action==='watched'?result.filesRemaining||result.unknownFiles||result.folderErrors?'已标记已看并移除任务，部分文件或目录仍需手动核对。':result.removedTasks?'已标记本集已看，并处理确认范围内的任务。':'已标记本集已看；qB 无关联任务，未扫描或删除其他文件。':'已标记本集未看，并提交所选版本。');}catch(e){plan=null;$('episode-confirm-error').classList.remove('hidden');text('episode-confirm-error',e.message+(/操作意图已保存|待恢复/.test(e.message)?' 关闭此窗口后，请使用顶部“核对并恢复记录”。':wholeShow?' 请关闭后重新点击“已全部看完”预览。':' 请关闭后重新点击集数预览。'));}finally{await loadStatus().catch(()=>{});busy=false;delete confirmation.dataset.busy;for(const b of confirmation.querySelectorAll('button'))b.disabled=false;sync();}}));
 $('episode-mark-only').addEventListener('click', guarded(async () => {
   if (busy || !show) return;
   busy = true;
   const buttons = [...dialog.querySelectorAll('button')];
   for (const button of buttons) button.disabled = true;
   try {
     await api('progress/watched/mark', { key: show.key, ...(wholeShow ? {} : { episode }) });
     dialog.close();
     toast(wholeShow ? '已记录全部看完，资源可继续收藏。' : '已标记本集已看。');
     await window.AniBTWorkbench.load();
   } catch (error) {
     text('episode-prepare-error', error.message);
   } finally {
     busy = false;
     for (const button of buttons) button.disabled = false;
   }
 }));
 $('episode-play').addEventListener('click', guarded(async () => {
   if (busy || wholeShow || !show) return;
   busy = true;
   try {
     await api('playback/start', {key: show.key, episode});
     dialog.close();
   } catch (error) { text('episode-prepare-error', error.message); }
   finally { busy = false; }
 }));
 for(const d of [dialog,confirmation])d.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 window.AniBTEpisodeActions={open:(s,n)=>{if(busy)return;show=s;episode=n;wholeShow=false;plan=null;$('episode-play').classList.toggle('hidden', !s.episodes.some(row => row.number === n && row.status === '已完成'));$('episode-mark-unwatched').classList.remove('hidden');$('episode-mark-watched').textContent='看完并清理';++sequence;text('episode-action-name',`《${s.title}》第 ${n} 集`);text('episode-prepare-error','可以只保存观看进度，也可以预览清理范围或下载版本。');dialog.showModal();},openAll:s=>{if(busy)return;show=s;episode=0;wholeShow=true;plan=null;$('episode-play').classList.add('hidden');++sequence;text('episode-action-name',`《${s.title}》已全部看完`);text('episode-prepare-error','仅标已看会收录到“我看过的”。选择清理时会先展示 qB 任务与文件范围。');$('episode-mark-unwatched').classList.add('hidden');$('episode-mark-watched').textContent='看完并清理';dialog.showModal();}};
})();

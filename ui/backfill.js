'use strict';
(()=>{
  const B={rows:[],shows:[],selected:new Set(),busy:false,loading:false};
  const collator=new Intl.Collator('zh-CN',{numeric:true});
  function sync(){
    text('backfill-count',B.selected.size);text('backfill-total',` / ${B.rows.length} 个可选任务`);
    $('confirm-backfill').disabled=B.busy||B.loading||!B.selected.size;
    if(!B.busy)$('confirm-backfill').innerHTML=icon('download')+`仅补下载选中的 ${B.selected.size} 项`;
    for(const input of $('backfill-preview').querySelectorAll('[data-backfill-row]')){input.checked=B.selected.has(Number(input.dataset.backfillRow));input.disabled=B.busy;}
    for(const input of $('backfill-preview').querySelectorAll('[data-backfill-show]')){
      const show=B.shows[Number(input.dataset.backfillShow)],count=show.rows.filter(i=>B.selected.has(i)).length;
      input.checked=count===show.rows.length;input.indeterminate=count>0&&count<show.rows.length;input.disabled=B.busy;
      text('backfill-show-count-'+input.dataset.backfillShow,`${count} / ${show.rows.length} 项`);
    }
    for(const button of $('backfill-dialog').querySelectorAll('.close-dialog,#backfill-select-all,#backfill-select-none'))button.disabled=B.busy||B.loading;
  }
  function render(){
    $('backfill-preview').innerHTML=B.shows.length?B.shows.map((show,index)=>`<section class="backfill-anime"><label class="backfill-anime-heading"><input type="checkbox" data-backfill-show="${index}" aria-label="选择整部 ${escape(show.title)}"><strong>${escape(show.title)}</strong><small id="backfill-show-count-${index}"></small></label><div class="backfill-episodes">${show.rows.map(i=>{
      const candidates=B.rows[i],item=candidates[0],episode=item.episode;
      const title=episode&&!/^(batch|合集|全集)$/i.test(episode)?`第 ${episode} 集${item.version&&item.version!=='v1'?' · '+item.version:''}`:item.title;
      const groups=[...new Set(candidates.map(c=>c.groupName||c.groupSlug).filter(Boolean))].join('、');
      return`<label class="backfill-episode"><input type="checkbox" data-backfill-row="${i}" aria-label="${escape(show.title+' '+title)}"><span><strong>${escape(title)}</strong><small>${escape(groups||'发布组未标注')}${candidates.length>1?' · 多个候选，按偏好取一份':''}</small></span><span class="badge success">符合偏好</span></label>`;
    }).join('')}</div></section>`).join(''):empty('现有资源已处理或不符合偏好','可以先调整压制组、画质等设置，再重新预览。','check');
    sync();
  }
  async function open(initialIds=[]){
    if(B.loading){if(!$('backfill-dialog').open)$('backfill-dialog').showModal();return;}
    if(B.busy)return;B.rows=[];B.shows=[];B.selected.clear();B.loading=true;
    $('backfill-dialog').showModal();$('backfill-preview').innerHTML=empty('正在准备可选集数','会先按当前偏好筛选并去重。','clock');sync();
    try{
      if(!(await api('ping')).capabilities?.selectiveBackfill)throw new Error('当前窗口服务较旧，请关闭全部工具窗口，等待 30 秒后重新打开，再使用选集补下载。');
      await loadStatus();await loadFeed(true);const groups=new Map();
      for(const item of S.feed.filter(i=>i.matched&&!['recorded','duplicate'].includes(i.status))){const key=S.status.config.dedupeEpisodes&&item.episodeKey?item.episodeKey:item.id;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
      B.rows=[...groups.values()].sort((a,b)=>collator.compare(a[0].animeTitle||a[0].title,b[0].animeTitle||b[0].title)||collator.compare(a[0].episode||'',b[0].episode||'')||collator.compare(a[0].version||'',b[0].version||''));
      const shows=new Map();B.rows.forEach((group,i)=>{const item=group[0],title=item.animeTitle||item.title,key=item.bgmId?'bgm:'+item.bgmId:title;if(!shows.has(key))shows.set(key,{title,rows:[]});shows.get(key).rows.push(i);});B.shows=[...shows.values()];if(Array.isArray(initialIds))B.rows.forEach((candidates,i)=>{if(candidates.some(c=>initialIds.includes(c.id)))B.selected.add(i);});render();
    }catch(e){$('backfill-preview').innerHTML=empty('无法准备清单',e.message,'info');throw e;}
    finally{B.loading=false;sync();}
  }
  $('backfill-preview').addEventListener('change',e=>{
    if(B.busy)return;
    const row=e.target.dataset.backfillRow,show=e.target.dataset.backfillShow;
    const indices=row!==undefined?[Number(row)]:show!==undefined?B.shows[Number(show)].rows:[];
    for(const index of indices){if(e.target.checked)B.selected.add(index);else B.selected.delete(index);}sync();
  });
  $('backfill-select-all').addEventListener('click',()=>{if(!B.busy){B.selected=new Set(B.rows.map((_,i)=>i));sync();}});
  $('backfill-select-none').addEventListener('click',()=>{if(!B.busy){B.selected.clear();sync();}});
  $('confirm-backfill').addEventListener('click',guarded(async()=>{
    if(B.busy||!B.selected.size)return;
    const selectedIds=[...new Set([...B.selected].flatMap(i=>B.rows[i].map(item=>item.id)))];
    B.busy=true;sync();$('confirm-backfill').textContent='正在补下载选中资源…';
    try{await doAction('backfill',{confirm:true,selectedIds});$('backfill-dialog').close();}
    finally{B.busy=false;sync();}
  }));
  $('backfill-dialog').addEventListener('cancel',e=>{if(B.busy)e.preventDefault();});
  window.AniBTBackfill={open};
})();

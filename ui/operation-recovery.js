(() => {
  const banner=document.createElement('section');banner.className='panel hidden';banner.id='watched-recovery-banner';banner.setAttribute('role','status');
  const title=document.createElement('h3');title.textContent='本地操作需要核对与恢复';
  const description=document.createElement('p');description.className='muted';description.textContent='这里仅核对已确认的任务范围并补写观看记录，不会再次删除文件。未恢复前，相关资源不会自动重新下载。';
  const list=document.createElement('div'),button=document.createElement('button');button.type='button';button.className='button secondary';button.textContent='核对并恢复记录';
  const result=document.createElement('p');result.className='muted';banner.append(title,description,list,button,result);document.querySelector('.topbar').after(banner);banner.style.marginBottom='24px';
  function update(status){const rows=[...(status?.watchedOperations||[]),...(status?.localTransactions||[]).map(row=>({...row,title:'本地数据更新'}))];banner.classList.toggle('hidden',!rows.length);list.replaceChildren(...rows.map(row=>{const p=document.createElement('p');p.textContent=`《${row.title}》${row.scope==='episode'?' 第 '+row.episode+' 集':''}：${row.message}`;return p;}));button.disabled=!!status?.busy;}
  button.addEventListener('click',async()=>{if(!confirm('核对原操作的下载器状态并恢复本地观看记录？\n不会再次发送删除请求。'))return;button.disabled=true;try{const response=await api('progress/recover',{confirm:true});result.textContent=response.remaining.length?'已恢复 '+response.restored+' 项，仍有任务存在或结果未知，请先在 qB 核对。':'本地记录已恢复。';}catch(error){result.textContent='仍待恢复：'+error.message;}finally{await loadStatus();if(S.page==='progress')await window.AniBTWorkbench?.load();}});
  window.AniBTOperations={update};update(typeof S==='undefined'?null:S.status);
})();

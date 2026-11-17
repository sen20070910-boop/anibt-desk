'use strict';
(()=>{
  let retry=null,retrying=false;
  document.addEventListener('click',e=>{const b=e.target.closest('[data-history-reprocess]');if(!b)return;retry=S.status?.state.history.find(r=>r.reprocessKey===b.dataset.historyReprocess);if(!retry?.canReprocess)return;text('history-reprocess-title',retry.title);$('history-reprocess-paused').checked=!!S.status.config.qb.paused;$('history-reprocess-dialog').showModal();});
  $('history-reprocess-confirm').addEventListener('click',guarded(async()=>{if(retrying||!retry)return;if(S.operation)throw new Error('正在执行其他操作，请稍候。');if(!(await api('ping')).capabilities?.reprocessDownloads)throw new Error('请保存并关闭旧版工具窗口，等待 30 秒后重新打开。');retrying=true;S.operation='reprocess';renderStatus();for(const b of $('history-reprocess-dialog').querySelectorAll('button'))b.disabled=true;try{const result=await api('history/reprocess',{key:retry.reprocessKey,confirm:true,paused:$('history-reprocess-paused').checked});$('history-reprocess-dialog').close();await loadStatus();await loadQb(true);toast(result.mode==='recheck'?'已请求 qB 重新校验文件，并应用继续 / 暂停选项。':'已重新添加下载任务。');}finally{retrying=false;S.operation=null;for(const b of $('history-reprocess-dialog').querySelectorAll('button'))b.disabled=false;renderStatus();update();}}));
  $('history-reprocess-dialog').addEventListener('cancel',e=>{if(retrying)e.preventDefault();});
  function update(){
    const state=S.status?.state,working=!!(S.operation||S.status?.busy);
    $('clear-history').disabled=working||!state?.historyCount;
    $('restore-history').classList.toggle('hidden',!state?.historyHidden);$('restore-history').disabled=working;
    text('history-visibility-hint',state?.historyHidden?`已清理 ${state.historyHidden} 条显示记录；去重依据继续保留。`:S.status?.maintenance?.cutoff?'仅显示最近清理后的处理记录；清理前记录不会恢复，去重依据继续保留。':'处理记录用于回看；清空显示后，去重依据继续保留。');
  }
  async function apply(action){
    if(S.operation)throw new Error('正在执行操作，请稍候。');
    S.operation='history-'+action;renderStatus();update();
    try{await api('history/'+action,action==='clear'?{confirm:true}:{});await loadStatus();toast(action==='clear'?'处理历史已清空显示，下载任务和去重记录已保留。':'已恢复处理历史显示。');}
    finally{S.operation=null;renderStatus();update();}
  }
  $('clear-history').addEventListener('click',()=>$('clear-history-dialog').showModal());
  $('confirm-clear-history').addEventListener('click',guarded(async()=>{
    const button=$('confirm-clear-history');button.disabled=true;
    try{await apply('clear');$('clear-history-dialog').close();}finally{button.disabled=false;}
  }));
  $('restore-history').addEventListener('click',guarded(()=>apply('restore')));
  window.AniBTHistory={update};update();
})();

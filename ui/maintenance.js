'use strict';
(()=>{
 let working=false;
 const format=value=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value)):'尚未清理';
 function update(){const m=S.status?.maintenance;if(!m)return;if(!working)$('maintenance-monthly').checked=m.enabled;$('maintenance-monthly').disabled=working||!!S.operation||!!S.status.busy;$('maintenance-clean').disabled=working||!!S.operation||!!S.status.busy;text('maintenance-last','最近清理：'+format(m.lastRunAt)+(m.lastError?'；'+m.lastError+'，后台将在稍后重试。':m.lastResult?'；上次清理成功，未生成备份。':''));text('maintenance-next',m.enabled?'下次清理：'+format(m.nextAt)+'（北京时间；未运行时下次补做）':'每月自动清理未开启');}
 $('maintenance-monthly').addEventListener('input',e=>e.stopPropagation());
 $('maintenance-monthly').addEventListener('change',guarded(async e=>{e.stopPropagation();const enabled=e.target.checked;working=true;update();try{if(!(await api('ping')).capabilities?.monthlyCleanup)throw new Error('请重新打开新版窗口以使用每月清理。');await api('maintenance/preferences',{enabled});await loadStatus();toast(enabled?'已开启每月自动清理，从下月 1 日开始。':'已关闭每月自动清理。');}finally{working=false;update();}}));
 $('maintenance-clean').addEventListener('click',()=>$('maintenance-clean-dialog').showModal());
 $('maintenance-confirm').addEventListener('click',guarded(async()=>{if(working||S.operation)return;working=true;S.operation='cleanup';for(const b of $('maintenance-clean-dialog').querySelectorAll('button'))b.disabled=true;update();try{if(!(await api('ping')).capabilities?.monthlyCleanup)throw new Error('请重新打开新版窗口以清理历史。');await api('maintenance/clean',{confirm:true});$('maintenance-clean-dialog').close();await loadStatus();toast('历史已清理，已自动添加从零重新计算。未生成备份。');}catch(e){await loadStatus();throw e;}finally{working=false;S.operation=null;for(const b of $('maintenance-clean-dialog').querySelectorAll('button'))b.disabled=false;renderStatus();update();}}));
 $('maintenance-clean-dialog').addEventListener('cancel',e=>{if(working)e.preventDefault();});
 window.AniBTMaintenance={update};update();
})();

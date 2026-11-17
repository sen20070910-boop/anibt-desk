'use strict';
(()=>{
 const M={revision:null,busy:false,opening:false};
 function update(){const episode=$('setting-start-episode').value,date=$('setting-start-date').value;let message;
  if(episode&&(!Number.isInteger(Number(episode))||Number(episode)<1||Number(episode)>9999))message='开始集数需要填写 1–9999 的整数。';
  else if(episode&&!date)message=`按此表单保存后，新订阅默认从第 ${Number(episode)} 集开始（含该集），不会另加订阅当天的日期限制。`;
  else message='按此表单保存后，没有单番预设的新订阅默认使用添加当天的日期'+(episode?`，并同时沿用从第 ${Number(episode)} 集开始的限制。`:'。');
  text('new-subscription-mode-hint',message+' 已有单番明确设置优先，已发布旧集仍需勾选补下载。');
 }
 $('settings-form').addEventListener('input',e=>{if(['setting-start-episode','setting-start-date'].includes(e.target.id))update();});
 $('settings-form').addEventListener('change',e=>{if(['setting-start-episode','setting-start-date'].includes(e.target.id))update();});
 $('restore-default-settings').addEventListener('click',guarded(async()=>{if(M.busy||M.opening)return;if(S.operation)throw new Error('正在执行其他操作，请稍候。');M.opening=true;$('restore-default-settings').disabled=true;try{if(!(await api('ping')).capabilities?.restoreDefaults)throw new Error('请保存并关闭旧版工具窗口，等待 30 秒后重新打开，再恢复默认设置。');const status=await api('status');M.revision=status.revision;$('settings-defaults-rules').checked=false;$('settings-defaults-appearance').checked=false;text('settings-defaults-rule-count',`当前 ${status.config.rules.length} 条。勾选后清除单番的组、日期、集数、目录和暂停等覆盖；默认保留。`);$('settings-defaults-dialog').showModal();}finally{M.opening=false;$('restore-default-settings').disabled=false;}}));
 $('settings-defaults-confirm').addEventListener('click',guarded(async()=>{if(M.busy)return;if(S.operation)throw new Error('正在执行其他操作，请稍候。');M.busy=true;S.operation='reset-settings';renderStatus();for(const b of $('settings-defaults-dialog').querySelectorAll('button,input'))b.disabled=true;try{await api('config/reset',{revision:M.revision,confirm:true,resetAnimeRules:$('settings-defaults-rules').checked,resetAppearanceNetwork:$('settings-defaults-appearance').checked});$('settings-defaults-dialog').close();await window.AniBTSession?.clear('settingsDraft');await loadStatus();fillSettings();if(!S.status.configurationError)await Promise.allSettled([loadFeed(true)]);toast('默认设置已恢复并保存，账号连接与下载记录已保留。');}finally{M.busy=false;S.operation=null;for(const b of $('settings-defaults-dialog').querySelectorAll('button,input'))b.disabled=false;renderStatus();update();}}));
 $('settings-defaults-dialog').addEventListener('cancel',e=>{if(M.busy)e.preventDefault();});
 window.AniBTDefaults={update};update();
})();

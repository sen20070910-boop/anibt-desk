import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from './config.js';
import { loadState, statePath } from './runner.js';
import { QbClient } from './qb.js';
import { qbReachable } from './qb-launch.js';
import { showDownloadInTaskbar } from './desktop.js';
import { updateAlerts } from './alerts.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function nativeNotification(args) {
  return new Promise((resolve,reject)=>{
    const exe=path.join(root,'native/AniBT.exe');
    if(process.platform!=='win32'||!fs.existsSync(exe)){reject(new Error('系统通知需要 Windows 桌面组件 native/AniBT.exe。'));return;}
    const child=spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('Windows 通知响应超时。'));},15000);
    child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve(out.trim()):reject(new Error(err.trim()||'Windows 未能显示通知，请查看 data/notification-error.log 并检查系统通知设置。'));});
  });
}
export const notifyComplete=(title,hash)=>nativeNotification(['--notify','下载完成',title,hash.slice(0,16)]);
export function createCompletionMonitor(configFile,deps={}) {
  const directory=path.join(path.dirname(configFile),'data'),file=path.join(directory,'completions.json');
  const startedAt=(deps.now||Date.now)();let busy=false;
  return {async poll(config){
    if(busy||(!config.notifications.enabled&&!config.notifications.openOnDownload))return;
    busy=true;
    let qb;
    try{
      const state=loadState(statePath(config,configFile));let manual={};
      try{manual=JSON.parse(fs.readFileSync(path.join(directory,'manual-downloads.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('手动下载记录无法读取，已暂缓完成通知。');}
      const managed=new Map([...Object.values(state.done),...Object.values(manual)].filter(x=>x.status==='added'&&/^[a-f0-9]{40}$/i.test(x.hash||'')).map(x=>[x.hash.toLowerCase(),x]));
      const alertInput={managed:new Set(managed.keys()),now:(deps.now||Date.now)()};
      const alertNotify=deps.alertNotify||((item)=>nativeNotification(['--notify',item.title,item.detail,'alert']));
      if(!managed.size&&!Object.keys(state.pending).length)return;
      if(!await (deps.reachable||qbReachable)(config.qb.url)){if(config.notifications.enabled){const expectingQb=Object.values(state.pending).some(p=>!p.paused&&!p.waitUntil&&(!p.nextRetryAt||p.nextRetryAt<=(deps.now||Date.now)()));await updateAlerts(directory,{...alertInput,reachable:!expectingQb},alertNotify);}return;}
      let saved={version:1,tasks:{}};
      try{saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.version!==1||!saved.tasks)throw new Error();}catch(e){if(e.code!=='ENOENT')throw new Error('完成通知记录无法读取，请检查 data/completions.json。');}
      qb=deps.qb||new QbClient(config);await qb.login();
      const list=await qb.list();const now=new Date((deps.now||Date.now)()).toISOString();const attention=[];
      if(config.notifications.enabled){let freeBytes=null;try{if(qb.request)freeBytes=(await(await qb.request('sync/maindata')).json()).server_state?.free_space_on_disk??null;}catch{}await updateAlerts(directory,{...alertInput,torrents:list,freeBytes},alertNotify);}
      for(const torrent of list){
        const hash=torrent.hash.toLowerCase(),job=managed.get(hash);if(!job)continue;
        const previous=saved.tasks[hash];const complete=torrent.progress>=1&&!/checking/i.test(torrent.state||'');
        const oldAtFirstObservation=!previous&&Date.parse(job.at)<startedAt-30000;
        const entry=saved.tasks[hash]={...previous,title:torrent.name||job.title,observedAt:now,completed:complete};
        const hasStarted=Number(torrent.dlspeed)>0||Number(torrent.downloaded)>0||Number(torrent.progress)>0||['downloading','forcedDL','uploading','stalledUP'].includes(torrent.state);
        if(Date.parse(job.at)<startedAt-30000&&!entry.taskbarShownAt)entry.taskbarShownAt=now;
        if(config.notifications.openOnDownload&&hasStarted&&!entry.taskbarShownAt&&state.done&&Object.values(state.done).some(x=>x.hash?.toLowerCase()===hash&&x.status==='added'&&!x.paused)&&!job.kind&&!job.reprocessedAt)attention.push(entry);
        if(previous?.notifiedAt&&!previous.completedAt)entry.historical=true; // Older app versions had no inbox timestamp.
        // Establish a quiet baseline for already completed historical tasks.
        if(complete&&oldAtFirstObservation&&!job.confirmationRecovered){entry.notifiedAt=now;entry.historical=true;}
        if(complete&&!entry.historical&&!entry.completedAt)entry.completedAt=now;
        if(complete&&!entry.notifiedAt&&config.notifications.enabled){
          saved.updatedAt=now;atomicWrite(file,saved); // Keep an in-app record even if Windows rejects the banner.
          try{await (deps.notify||notifyComplete)(entry.title,hash);entry.notifiedAt=now;delete entry.error;(deps.log||console.log)(`[下载完成] ${entry.title}`);}
          catch(e){entry.error=e.message;(deps.log||console.error)(`[完成通知] ${e.message}`);}
        }
      }
      if(attention.length){await (deps.showTaskbar||showDownloadInTaskbar)(configFile);for(const entry of attention)entry.taskbarShownAt=now;}
      saved.updatedAt=now;atomicWrite(file,saved);
    }catch(e){if(config.notifications.enabled)try{await updateAlerts(directory,{reachable:false,now:(deps.now||Date.now)()},deps.alertNotify||((item)=>nativeNotification(['--notify',item.title,item.detail,'alert'])));}catch{}(deps.log||console.error)(`[完成通知] ${e.message}`);}
    finally{await qb?.logout();busy=false;}
  }};
}

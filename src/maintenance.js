import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './config.js';

const filename=directory=>path.join(directory,'maintenance.json');
export const beijingMonth=now=>new Date(Number(now)+8*3600000).toISOString().slice(0,7);
export function readMaintenance(directory){
  try{const data=JSON.parse(fs.readFileSync(filename(directory),'utf8'));if(data.version!==1||typeof data.enabled!=='boolean'||data.cutoff&&!Number.isFinite(Date.parse(data.cutoff))||data.checkedMonth&&!/^\d{4}-\d{2}$/.test(data.checkedMonth))throw new Error();return data;}
  catch(e){if(e.code==='ENOENT')return{version:1,enabled:false,checkedMonth:'',cutoff:'',lastRunAt:''};throw new Error('每月清理设置无法读取，请检查 data/maintenance.json。');}
}
export function afterCleanup(row,maintenance){return !maintenance.cutoff||Date.parse(row.at)>=Date.parse(maintenance.cutoff);}
export function maintenanceStatus(directory,now=Date.now()){
  const data=readMaintenance(directory),month=beijingMonth(now),due=data.enabled&&(data.pendingCleanup||data.checkedMonth&&data.checkedMonth<month);
  const [year,m]=month.split('-').map(Number),nextAt=new Date(Date.UTC(year,m,1)-8*3600000).toISOString();
  return{...data,due:!!due,nextAt:data.enabled?(data.retryAt|| (due?new Date(Date.UTC(year,m-1,1)-8*3600000).toISOString():nextAt)):null};
}
export function setMonthlyCleanup(directory,enabled,now=Date.now()){
  if(typeof enabled!=='boolean')throw new Error('每月自动清理开关无效。');
  const data=readMaintenance(directory);if(enabled&&!data.enabled&&!data.pendingCleanup)data.checkedMonth=beijingMonth(now);data.enabled=enabled;atomicWrite(filename(directory),data);return maintenanceStatus(directory,now);
}
export function cleanupHistory(directory,{now=Date.now(),automatic=false}={}){
  fs.mkdirSync(directory,{recursive:true});
  // A separate short-lived lock coordinates GUI and watcher without touching download locks.
  const lockFile=path.join(directory,'maintenance.lock');let fd;
  for(let attempt=0;attempt<2;attempt++){
    try{fd=fs.openSync(lockFile,'wx');fs.writeFileSync(fd,String(process.pid));break;}
    catch(e){if(e.code!=='EEXIST')throw e;let pid;try{pid=Number(fs.readFileSync(lockFile,'utf8'));}catch{}if(pid>0){try{process.kill(pid,0);return{ran:false,reason:'busy'};}catch(error){if(error.code!=='ESRCH')return{ran:false,reason:'busy'};}}else if(Date.now()-fs.statSync(lockFile).mtimeMs<30000)return{ran:false,reason:'busy'};try{fs.unlinkSync(lockFile);}catch(error){if(error.code!=='ENOENT')throw error;}}
  }
  if(fd===undefined)return{ran:false,reason:'busy'};
  let data;
  try{
    data=readMaintenance(directory);const month=beijingMonth(now);
    if(automatic&&(!data.enabled||!data.pendingCleanup&&(!data.checkedMonth||data.checkedMonth>=month)))return{ran:false};
    const pending=data.pendingCleanup||{at:new Date(now).toISOString(),month,kind:automatic?'monthly':'manual'};
    data.pendingCleanup=pending;data.cutoff=pending.at;atomicWrite(filename(directory),data);
    const read=(name,fallback)=>{try{return JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
    const newer=row=>Date.parse(row.at)>=Date.parse(pending.at);
    const display=read('history-display.json',{hidden:[]});display.hidden=display.hidden.filter(key=>{try{return Date.parse(JSON.parse(key)[2])>=Date.parse(pending.at);}catch{return false;}});atomicWrite(path.join(directory,'history-display.json'),display);
    atomicWrite(path.join(directory,'completion-history.json'),read('completion-history.json',[]).filter(newer));
    const seen=read('notification-read.json',{});atomicWrite(path.join(directory,'notification-read.json'),Object.fromEntries(Object.entries(seen).filter(([key,at])=>Date.parse(at)>=Date.parse(pending.at)&&Date.parse(key.slice(-24))>=Date.parse(pending.at))));
    const alertsFile=path.join(directory,'alerts.json');if(fs.existsSync(alertsFile)){const alerts=read('alerts.json',{});alerts.items=alerts.items.filter(newer);atomicWrite(alertsFile,alerts);}
    let removedTemps=0;for(const name of fs.readdirSync(directory))if(/\.json\.\d+\.tmp$/.test(name)){const file=path.join(directory,name);try{const stat=fs.lstatSync(file);if(stat.isFile()&&Number(now)-stat.mtimeMs>7*86400000){fs.unlinkSync(file);removedTemps++;}}catch(e){if(e.code!=='ENOENT')throw e;}}
    Object.assign(data,{lastRunAt:pending.at,checkedMonth:pending.month,lastRunKind:pending.kind,lastResult:{removedTemps,backupCreated:false}});delete data.pendingCleanup;delete data.lastError;delete data.retryAt;atomicWrite(filename(directory),data);
    return{ran:true,at:data.lastRunAt,removedTemps,backupCreated:false};
  }catch(error){
    if(data){data.lastError='清理未完成：'+(error.code||'文件读取或写入失败');data.retryAt=new Date(Number(now)+60000).toISOString();atomicWrite(filename(directory),data);}
    if(!automatic)throw new Error('清理未完成，已保留进度；可重试或等待后台重试。'+(error.code?'（'+error.code+'）':''));return{ran:false,error:data?.lastError,retryAt:data?.retryAt};

  }finally{fs.closeSync(fd);fs.unlinkSync(lockFile);}
}
export function runMonthlyCleanup(directory,now=Date.now()){
 const data=readMaintenance(directory);if(!data.enabled||!data.pendingCleanup&&(!data.checkedMonth||data.checkedMonth>=beijingMonth(now)))return{ran:false};
 if(data.retryAt&&Number(now)<Date.parse(data.retryAt))return{ran:false,reason:'backoff'};
 return cleanupHistory(directory,{now,automatic:true});
}

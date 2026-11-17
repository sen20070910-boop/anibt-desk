import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './config.js';
import { readAlerts } from './alerts.js';
import {readMaintenance,afterCleanup} from './maintenance.js';

function read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw new Error('通知记录无法读取，请检查 data 中的通知记录文件。');}}
export function notificationHistory(directory){
  const completion=read(path.join(directory,'completions.json'),{version:1,tasks:{}}),seen=read(path.join(directory,'notification-read.json'),{});
  if(completion.version!==1||!completion.tasks||typeof seen!=='object'||seen===null||Array.isArray(seen))throw new Error('通知记录格式异常。');
  const maintenance=readMaintenance(directory);
  const items=Object.entries(completion.tasks).filter(([,t])=>t.completedAt&&!t.historical).map(([hash,t])=>{
    const id=hash+':'+t.completedAt;return{id,hash,title:t.title,at:t.completedAt,read:!!seen[id],delivered:!!t.notifiedAt};
  }).concat(read(path.join(directory,'completion-history.json'),[]).map(item=>({...item,id:item.hash+':'+item.at,read:!!seen[item.hash+':'+item.at]}))).concat(readAlerts(directory).items.map(item=>({...item,read:!!seen[item.id],kind:'alert'}))).filter(row=>afterCleanup(row,maintenance)).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,200);
  return{items,unread:items.filter(t=>!t.read).length};
}
export function markNotificationsRead(directory,ids){
  if(!Array.isArray(ids)||ids.length>200||ids.some(id=>typeof id!=='string'))throw new Error('请选择要标记的通知。');
  const allowed=new Set(notificationHistory(directory).items.map(t=>t.id));
  const file=path.join(directory,'notification-read.json'),seen=read(file,{}),now=new Date().toISOString();
  for(const id of ids)if(allowed.has(id))seen[id]=now;
  atomicWrite(file,seen);return notificationHistory(directory);
}

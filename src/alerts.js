import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './config.js';
export function readAlerts(directory){try{return JSON.parse(fs.readFileSync(path.join(directory,'alerts.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return{items:[],active:{},observations:{}};throw new Error('异常提醒记录无法读取。');}}
export async function updateAlerts(directory,{reachable=true,torrents=[],managed=new Set(),freeBytes=null,now=Date.now()},notify){
  const data=readAlerts(directory),conditions=new Map();data.observations??={};
  if(!reachable){const t=data.observations.connection??={since:now};if(now-t.since>=90000)conditions.set('connection',{title:'qB 连接持续失败',detail:'已有追番任务或待提交资源，连续 90 秒无法连接 qB。请检查下载器和 Web UI。'});}
  else{
    delete data.observations.connection;
    if(Number.isFinite(freeBytes)&&freeBytes>=0&&freeBytes<2*1024**3&&torrents.some(t=>managed.has(t.hash?.toLowerCase())&&t.progress<1))conditions.set('disk',{title:'qB 报告磁盘空间不足 2 GB',detail:'请在 qB 中检查任务保存目录及其所在磁盘，清理空间后再继续下载。'});
    for(const t of torrents){const hash=t.hash?.toLowerCase();if(!managed.has(hash))continue;
      if(['error','missingFiles'].includes(t.state))conditions.set(hash+':error',{hash,title:'下载任务出错',detail:t.name+'：'+(t.state==='missingFiles'?'找不到下载文件，请在 qB 中检查保存路径。':'qB 报告任务错误，请检查磁盘和任务状态。')});
      const stalled=t.progress<1&&Number(t.dlspeed||0)===0&&['stalledDL','downloading','forcedDL'].includes(t.state);
      const old=data.observations[hash];if(!stalled){delete data.observations[hash];continue;}
      const progress=Number(t.progress)||0;const observation=old&&old.progress===progress?old:{since:now,progress};data.observations[hash]=observation;
      if(now-observation.since>=3600000)conditions.set(hash+':stalled',{hash,title:'下载一小时没有进展',detail:t.name+'：请查看做种人数和网络连接，可到发现资源查找其他版本。'});
    }
    for(const hash of Object.keys(data.observations))if(hash!=='connection'&&!torrents.some(t=>t.hash?.toLowerCase()===hash))delete data.observations[hash];
  }
  for(const key of Object.keys(data.active))if(!conditions.has(key)&&!(key!=='connection'&&!reachable))delete data.active[key];
  for(const [key,condition]of conditions){if(data.active[key])continue;const at=new Date(now).toISOString(),id='alert:'+key+':'+at;data.items.unshift({id,at,...condition,delivered:false});data.active[key]=id;}
  data.items=data.items.slice(0,200);atomicWrite(path.join(directory,'alerts.json'),data);
  for(const item of data.items.filter(i=>!i.delivered&&Object.values(data.active).includes(i.id))){try{await notify?.(item);item.delivered=true;}catch{}}
  atomicWrite(path.join(directory,'alerts.json'),data);return data;
}

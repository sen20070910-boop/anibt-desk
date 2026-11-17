import os from 'node:os';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {normalizeTracking} from './tracking-records.js';import {buildProgress} from './progress.js';import {sourceLinks} from './history-actions.js';
import { clone,defaults,validateConfig,validateDownloadPath } from './config.js';
import {validateReview} from './reviews.js';
import { sourceKey } from './feed.js';
const profileKeys=['bindings','filters','rules','dedupeEpisodes','startDate','startEpisode','intervalSeconds','notifications'];
const qbKeys=['url','username','savePath','category','tags','paused','autoStart','executable'];
export function exportBackup(config,state,tracking,manual={}){
  const profile=Object.fromEntries(profileKeys.map(k=>[k,clone(config[k])]));profile.qb=Object.fromEntries(qbKeys.map(k=>[k,clone(config.qb[k])]));
  const record=j=>{const row=Object.fromEntries(['at','status','title','hash','paused','savePath','animeTitle','bgmId','episode','version','kind'].filter(k=>j[k]!==undefined).map(k=>[k,j[k]]));const links=sourceLinks(j).slice(0,20).map(link=>{const u=new URL(link.url);u.search='';u.hash='';return{name:link.name,url:u.href};});if(links.length)row.sourceLinks=links;if(j.releaseUrl&&links.some(link=>link.url===j.releaseUrl))row.releaseUrl=j.releaseUrl;return row;};
  const done=Object.fromEntries(Object.entries(state.done).map(([id,j])=>[id,record(j)])),manualRecords=Object.fromEntries(Object.entries(manual).map(([hash,j])=>[hash,record(j)]));
  return{format:'anibt-qb-backup',version:1,createdAt:new Date().toISOString(),pathContext:{machineId:machineId()},profile,state:{done,episodes:clone(state.episodes),baselineIds:clone(state.sources[sourceKey(config.rssUrl)]?.baselineIds||[])},manual:manualRecords,tracking:normalizeTracking(tracking)};
}
export function validateBackup(value,current){
  if(!value||value.format!=='anibt-qb-backup'||value.version!==1)throw new Error('这不是支持的 AniBT 备份文件。');
  const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
  if(!object(value.profile)||!object(value.state)||!object(value.state.done)||!object(value.state.episodes)||!object(value.tracking)||!Array.isArray(value.state.baselineIds))throw new Error('备份结构不完整。');
  const check=(v,depth=0)=>{if(depth>15)throw new Error('备份结构过深。');if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(k)&&v!==value.state.done&&v!==value.state.episodes)throw new Error('备份包含不支持的字段。');check(x,depth+1);}};check(value);
  value={...value,tracking:normalizeTracking(value.tracking,{strict:true})};
  const next=clone(current);for(const key of profileKeys)if(value.profile[key]!==undefined)next[key]=clone(value.profile[key]);
  if(!object(value.profile.qb))throw new Error('备份下载器偏好无效。');for(const key of qbKeys)if(value.profile.qb[key]!==undefined)next.qb[key]=clone(value.profile.qb[key]);
  validateConfig({...next,rssUrl:next.rssUrl||'https://anibt.net/rss/subscriptions.xml?key=migration-validation'});
  if(value.state.baselineIds.length>100000||value.state.baselineIds.some(id=>typeof id!=='string'||id.length>2000))throw new Error('备份基线记录无效。');
  for(const [id,j]of Object.entries(value.state.done))if(id.length>2000||!object(j)||typeof j.title!=='string'||typeof j.at!=='string'||!Number.isFinite(Date.parse(j.at))||!['added','existing','episode-duplicate'].includes(j.status)||j.hash!==undefined&&!/^[a-f0-9]{40}$/i.test(j.hash))throw new Error('备份下载记录无效。');
  if(Object.entries(value.state.episodes).some(([k,v])=>k.length>2000||typeof v!=='string'||v.length>2000))throw new Error('备份去重记录无效。');
  const manual=value.manual||{};if(!object(manual)||Object.entries(manual).some(([hash,j])=>!/^[a-f0-9]{40}$/i.test(hash)||!object(j)||j.hash!==hash||typeof j.title!=='string'||!Number.isFinite(Date.parse(j.at))||!['added','existing'].includes(j.status)))throw new Error('备份手动下载记录无效。');
  for(const job of [...Object.values(value.state.done),...Object.values(manual)])for(const key of ['animeTitle','bgmId','episode','version'])if(job[key]!==undefined&&(typeof job[key]!=='string'||job[key].length>300))throw new Error('备份番剧集数信息无效。');
  for(const [key,t]of Object.entries(value.tracking))if(!/^(bgm:\d{1,8}|title:.+)$/.test(key)||key.length>500||!object(t)||typeof t.title!=='string'||t.title.length>300||!Number.isInteger(t.watched)||t.watched<0||t.watched>9999||!Number.isInteger(t.startEpisode)||t.startEpisode<1||t.startEpisode>9999||typeof t.archived!=='boolean')throw new Error('备份观看进度无效。');
  for(const t of Object.values(value.tracking))if(t.episodeStates!==undefined&&(!object(t.episodeStates)||Object.keys(t.episodeStates).length>9999||Object.entries(t.episodeStates).some(([n,v])=>!/^\d{1,4}$/.test(n)||Number(n)<1||typeof v!=='boolean')))throw new Error('备份逐集观看状态无效。');
  for(const t of Object.values(value.tracking))if(t.personalReview!==undefined){validateReview(t.personalReview);for(const name of ['createdAt','updatedAt'])if(typeof t.personalReview[name]!=='string'||!Number.isFinite(Date.parse(t.personalReview[name])))throw new Error('备份评价时间无效。');}
  for(const t of Object.values(value.tracking)){if(t.watchSessions!==undefined){if(!Array.isArray(t.watchSessions)||t.watchSessions.length>100)throw new Error('观看经历无效。');for(const session of t.watchSessions){if(!session||typeof session.completedAt!=='string'||!Number.isFinite(Date.parse(session.completedAt)))throw new Error('观看经历日期无效。');if(session.personalReview){validateReview(session.personalReview);for(const field of ['createdAt','updatedAt'])if(!Number.isFinite(Date.parse(session.personalReview[field])))throw new Error('历史评价时间无效。');}if(session.draft)validateReview(session.draft);}}}
  if(value.reviewDrafts!==undefined){if(!object(value.reviewDrafts)||Object.keys(value.reviewDrafts).length>10000)throw new Error('评价草稿无效。');for(const [key,draft]of Object.entries(value.reviewDrafts)){if(!/^(bgm:\d{1,8}|title:.+)$/.test(key)||key.length>500||typeof draft.baseVersion!=='string'||!/^[a-f0-9]{64}$/.test(draft.baseVersion)||!Number.isFinite(Date.parse(draft.updatedAt)))throw new Error('评价草稿无效。');validateReview(draft);}}
  for(const job of [...Object.values(value.state.done),...Object.values(manual)]){if(job.savePath!==undefined)validateDownloadPath(job.savePath,'备份保存目录');if(job.sourceLinks!==undefined&&(!Array.isArray(job.sourceLinks)||job.sourceLinks.length>20||job.sourceLinks.some(link=>!link||typeof link.url!=='string'||link.url.length>2000)))throw new Error('备份来源链接无效。');if(job.releaseUrl!==undefined&&typeof job.releaseUrl!=='string')throw new Error('备份发布页无效。');}
  buildProgress({items:[],state:{done:value.state.done,episodes:value.state.episodes,pending:{}},manual,tracking:value.tracking,config:next});
  const paths=[...new Set([...Object.values(value.state.done),...Object.values(manual)].map(j=>j.savePath).concat(next.qb.savePath,next.rules.map(r=>r.savePath)).flat().filter(Boolean))];
  const reviewPaths=value.pathContext?.machineId!==machineId()?paths:[];
  return{next,backup:{...exportBackup({...clone(defaults),...next},{...value.state,sources:{[sourceKey(next.rssUrl)]:{baselineIds:value.state.baselineIds}}},value.tracking,manual),reviewDrafts:clone(value.reviewDrafts||{})},summary:{rules:next.rules.length,records:Object.keys(value.state.done).length+Object.keys(manual).length,shows:Object.keys(value.tracking).length,requiresConnection:!current.rssUrl,directories:reviewPaths,pathsNeedReview:reviewPaths.length}};
}

export const machineId=()=>createHash('sha256').update(process.platform+'|'+os.hostname()).digest('hex');
export function verifyBackupPaths(plan,{pathMappings=[],confirmPaths=false}={}){
  const required=plan.restoreViewing?[]:plan.summary.directories||[];if(!required.length)return;
  if(!Array.isArray(pathMappings)||pathMappings.length>10000)throw new Error('目录映射无效。');const mapped=new Map();
  for(const row of pathMappings){if(!row||!required.includes(row.from)||typeof row.to!=='string')throw new Error('目录映射无效。');mapped.set(row.from,validateDownloadPath(row.to,'迁移后的目录'));}
  for(const source of required)if(!mapped.has(source)){if(!confirmPaths)throw new Error('请先验证或映射备份中的保存目录。');try{if(!fs.statSync(source).isDirectory())throw Error();}catch{throw new Error('原目录在本机不存在或不可访问，请映射或清空旧路径。');}}
  for(const row of [...Object.values(plan.backup.state.done),...Object.values(plan.backup.manual)])if(mapped.has(row.savePath))row.savePath=mapped.get(row.savePath);
  if(mapped.has(plan.next.qb.savePath))plan.next.qb.savePath=mapped.get(plan.next.qb.savePath);for(const row of plan.next.rules)if(mapped.has(row.savePath))row.savePath=mapped.get(row.savePath);
}

import path from 'node:path';import fs from 'node:fs';import{createHash}from'node:crypto';
import{animeKey,isDirectDiscoveryRecord}from'./progress.js';import{singleEpisode}from'./episodes.js';import{applyAnimeBindings}from'./anime-bindings.js';import{matches}from'./feed.js';import{groupPriority}from'./priority.js';import{localDownloader}from'./history-actions.js';
import {animeDownloadPath} from './download-path.js';
import {matchingAnimeRule} from './feed.js';

export async function emptyAnimeFolders(show, targets, qb, config) {
  if (!targets.length || !localDownloader(config)) return [];
  const item = { animeTitle: show.title, bgmId: show.bgmId || '' };
  if (matchingAnimeRule(item, config)?.savePath?.trim()) return [];
  try {
    const prefs = await (await qb.request('app/preferences')).json();
    const expected = animeDownloadPath(item, config, prefs.save_path);
    if (normalized(expected) === normalized(prefs.save_path)) return [];
    return targets.some(target => normalized(target.savePath) === normalized(expected)) ? [expected] : [];
  } catch {
    return [];
  }
}

export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function episodeContext({items,state,manual,config,key,episode}){
 if(typeof key!=='string'||!key.match(/^(bgm:\d{1,8}|title:.+)$/)||key.length>500||!Number.isInteger(episode)||episode<1||episode>9999)throw new Error('番剧或集数无效。');
 const history=[...Object.entries(state.done).map(([id,j])=>({id,...j})),...Object.entries(manual).map(([id,j])=>({id,...j,direct:isDirectDiscoveryRecord(j)}))].filter(j=>['added','existing'].includes(j.status));
 const rows=applyAnimeBindings([...items,...Object.values(state.pending).map(p=>p.item),...history],config),byHash=new Map();
 for(const row of rows){const hash=(row.infoHash||row.hash||'').toLowerCase();if(!/^[a-f0-9]{40}$/.test(hash))continue;if(!byHash.has(hash))byHash.set(hash,[]);byHash.get(hash).push(row);}
 const candidates=[];for(const[hash,entries]of byHash){const matching=entries.filter(r=>!r.direct&&animeKey(r)===key&&singleEpisode(r.episode)===episode);if(!matching.length)continue;const ambiguous=entries.some(r=>animeKey(r)!==key||singleEpisode(r.episode)!==episode);const raw=matching.find(r=>r.infoHash)||matching[0],item={...raw,infoHash:hash,magnet:raw.magnet||'magnet:?xt=urn:btih:'+hash,languages:raw.languages||[],subtitles:raw.subtitles||[],groupName:raw.groupName||raw.title.match(/^\[([^\]]+)\]/)?.[1]||''};const match=matches(item,config);candidates.push({hash,item,ambiguous,matched:match.ok,reason:match.reason,savePath:matching.find(r=>r.savePath)?.savePath||''});}
 candidates.sort((a,b)=>Number(b.matched)-Number(a.matched)||groupPriority(a.item,config).rank-groupPriority(b.item,config).rank||a.item.title.localeCompare(b.item.title,'zh-CN'));
 return {candidates,key,episode};
}
export function showContext({items,state,manual,config,key}){
 if(typeof key!=='string'||!key.match(/^(bgm:\d{1,8}|title:.+)$/)||key.length>500)throw new Error('番剧信息无效。');
 const history=[...Object.values(state.done),...Object.values(manual).map(job=>({...job,direct:isDirectDiscoveryRecord(job)}))].filter(j=>['added','existing'].includes(j.status));
 const rows=applyAnimeBindings([...items,...Object.values(state.pending).map(p=>p.item),...history],config),hashes=new Map();
 for(const row of rows){const hash=(row.infoHash||row.hash||'').toLowerCase();if(!/^[a-f0-9]{40}$/.test(hash))continue;if(!hashes.has(hash))hashes.set(hash,[]);hashes.get(hash).push(row);}
 const hasSubscription=rows.some(r=>!r.direct&&animeKey(r)===key);
 const belongs=r=>animeKey(r)===key&&(!hasSubscription||!r.direct);
 const candidates=[];for(const [hash,entries]of hashes){if(entries.some(belongs))candidates.push({hash,ambiguous:entries.some(r=>animeKey(r)!==key)});}
 return {key,candidates,wholeShow:true,latest:rows.filter(r=>belongs(r)&&!r.direct).reduce((n,r)=>Math.max(n,singleEpisode(r.episode)||0),0)};
}
function normalized(value){const win=/^[a-z]:[\\/]|^\\\\/i.test(value||''),p=win?path.win32:path.posix;if(!value||!p.isAbsolute(value))throw new Error('任务路径不完整，不能自动删除。');let result=p.normalize(value).replaceAll('\\','/').replace(/\/+$/,'');if(!result||/^[a-z]:$/i.test(result))throw new Error('任务路径指向磁盘根目录，不能删除。');return win?result.toLowerCase():result;}
const overlaps=(a,b)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
export async function deletionManifest(context,qb,config){
 if(!localDownloader(config))throw new Error('远程下载器的删除范围无法在本机核实，请在 qB 中手动处理。');
 const torrents=await qb.list(),targets=[];
 for(const torrent of torrents){const candidate=context.candidates.find(c=>c.hash===torrent.hash?.toLowerCase());if(!candidate)continue;if(candidate.ambiguous)throw new Error(context.wholeShow?'同一种子关联到其他番剧，不能自动删除，请在 qB 手动核对。':'同一种子对应多个集数或未识别资源，请在 qB 手动处理。');
  const content=normalized(torrent.content_path),save=normalized(torrent.save_path);if(content===save||!content.startsWith(save+'/'))throw new Error('任务内容范围不明确，不能删除整个番剧目录。');
  for(const other of torrents)if(other.hash?.toLowerCase()!==candidate.hash){if(!other.content_path){if(other.save_path&&normalized(other.save_path)===save)throw new Error('其他任务的内容路径未知，无法排除共用文件。');continue;}if(overlaps(content,normalized(other.content_path)))throw new Error('此任务与其他下载共用内容，不能自动删除。');}
  const files=await(await qb.request('torrents/files',null,'?hash='+encodeURIComponent(candidate.hash))).json();if(!Array.isArray(files)||!files.length||files.length>2000||(context.wholeShow?files.filter(f=>/\.(mkv|mp4|avi|ts|m2ts|webm|mov)$/i.test(f.name)).length<1:files.filter(f=>/\.(mkv|mp4|avi|ts|m2ts|webm|mov)$/i.test(f.name)).length!==1))throw new Error('不能确认是单集任务（合集、多视频或无视频），请在 qB 手动处理。');
  const manifest=[];for(const file of files){if(typeof file.name!=='string'||file.name.split(/[\\/]/).includes('..')||path.win32.isAbsolute(file.name)||path.posix.isAbsolute(file.name)||!Number.isFinite(file.size)||file.size<0)throw new Error('文件列表含无效路径，已停止删除。');const full=normalized(torrent.save_path+'/'+file.name);if(full!==content&&!full.startsWith(content+'/'))throw new Error('文件超出任务内容范围，不能删除。');let probe=path.resolve(torrent.save_path,file.name);while(!fs.existsSync(probe)&&path.dirname(probe)!==probe)probe=path.dirname(probe);try{if(normalized(fs.realpathSync(probe))!==normalized(probe))throw new Error('任务路径包含链接，不能确认删除范围。');}catch(error){if(error.code)throw new Error('无法核实本机文件路径，请在 qB 手动处理。');throw error;}manifest.push({name:file.name,size:file.size,priority:file.priority??1});}
  targets.push({hash:candidate.hash,title:torrent.name,savePath:torrent.save_path,contentPath:torrent.content_path,files:manifest});
 }
 targets.sort((a,b)=>a.hash.localeCompare(b.hash));return targets;
}

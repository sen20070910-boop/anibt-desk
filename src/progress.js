import {own} from './dictionary.js';
import {normalizeTracking} from './tracking-records.js';
import {singleEpisode} from './episodes.js';
import {applyAnimeBindings} from './anime-bindings.js';
import { norm,matches } from './feed.js';
import {animeIdentity} from './anime-identity.js';
import {episodeRecorded} from './episode-dedupe.js';
export const animeKey=animeIdentity;
export const episodeNumber=singleEpisode;
export function isDirectDiscoveryRecord(job) {
  if (job.origin) return job.origin === 'discovery';
  if (job.bgmId && singleEpisode(job.episode)) return false;
  return job.sources?.length > 0 || (!job.bgmId && !singleEpisode(job.episode));
}
export function watchedLibraryKeys(tracking,config){const keys=new Set();for(const [key,entry]of Object.entries(tracking))if(entry.completedAt){keys.add(key);const linked=applyAnimeBindings([{animeTitle:entry.title,bgmId:entry.bgmId||''}],config)[0];keys.add(animeKey(linked));}return keys;}
export function explicitEpisodeWatched(item,tracking,config){const linked=applyAnimeBindings([item],config)[0],entry=tracking[animeKey(linked)]||tracking['title:'+norm(item.animeTitle||item.title)];return entry?.episodeStates?.[String(episodeNumber(item.episode))]===true;}
export function buildProgress({items=[],state,manual={},completed={},torrents=[],tracking={},config}){
  tracking=normalizeTracking(tracking);
  const history=[
    ...Object.values(state.done),
    ...Object.entries(manual).map(([recordId, job]) => ({
      ...job,
      recordId,
      direct: isDirectDiscoveryRecord(job),
    })),
  ];
  const evidence=[...items,...history,...Object.entries(tracking).map(([key,t])=>({animeTitle:t.title,bgmId:t.bgmId||(key.startsWith('bgm:')?key.slice(4):'')}))];
  items=applyAnimeBindings(items,config,evidence);
  const mergedTracking={...tracking};
  for(const [key,value]of Object.entries(tracking)){
    const linked=applyAnimeBindings([{animeTitle:value.title,bgmId:value.bgmId||''}],config,evidence)[0];
    if(key.startsWith('title:')&&linked.bgmId){
      const target='bgm:'+linked.bgmId,existing=mergedTracking[target];
      // An existing subject record is authoritative (including deliberate
      // rewatch resets). This is a read-only projection of the saved records.
      mergedTracking[target]=existing||{...value,bgmId:linked.bgmId};
      delete mergedTracking[key];
    }
  }
  tracking=mergedTracking;
  const shows=new Map(),byHash=new Map(torrents.map(t=>[t.hash?.toLowerCase(),t]));
  const feedByHash=new Map(items.filter(i=>i.infoHash).map(i=>[i.infoHash,i]));
  const subscribed = new Set(items.map(animeKey));
  const directResources = new Map();
  const get=item=>{const key=animeKey(item);if(!shows.has(key))shows.set(key,{key,title:item.animeTitle||item.title,bgmId:item.bgmId||'',latest:0,episodes:new Map(),unknown:[],...(tracking[key]||{})});return shows.get(key);};
  for(const [key,t] of Object.entries(tracking))shows.set(key,{key,title:t.title,bgmId:t.bgmId||'',latest:0,episodes:new Map(),unknown:[],...t});
  const put=(item,job)=>{
    if(!item.animeTitle&&!item.bgmId)return;const show=get(item),ep=episodeNumber(item.episode);
    if(!ep){if(!show.unknown.includes(item.title))show.unknown.push(item.title);return;}
    show.latest=Math.max(show.latest,ep);const old=show.episodes.get(ep)||{number:ep,candidateIds:[],status:'已发布'};
    const hash=job?.hash||item.infoHash,torrent=byHash.get(hash?.toLowerCase());
    if(torrent?.progress>=1||completed[hash?.toLowerCase()]?.completed){old.status='已完成';}
    else if(old.status!=='已完成'&&torrent){old.status='下载中';old.progress=Math.round(torrent.progress*100);}
    else if(old.status==='已发布'&&job){old.status='已提交';}
    if(!job&&!own(state.done,item.id)&&matches(item,config).ok&&!episodeRecorded(state,item))old.candidateIds.push(item.id);
    show.episodes.set(ep,old);
  };
  for(const item of items)put(item,null);
  for(const job of applyAnimeBindings(history,config,evidence).filter(j=>j.status==='added'||j.status==='existing')){
    const info=job.animeTitle?job:feedByHash.get(job.hash);
    if(!info?.animeTitle&&!info?.bgmId)continue;
    const show=get(info);
    if(job.direct){
      if(!directResources.has(show.key))directResources.set(show.key,[]);
      const hash=String(job.hash||'').toLowerCase(), torrent=byHash.get(hash);
      const status=torrent?.progress>=1?'已完成':torrent?'已提交到 qB':completed[hash]?.completed?'曾下载完成':'已记录';
      directResources.get(show.key).push({recordId:job.recordId,hash,title:job.title,status,progress:torrent?.progress??null});
      if(!feedByHash.has(hash))continue;
    }else subscribed.add(show.key);
    put(info,job);
  }
  return [...shows.values()].map(show=>{
    const start=show.startEpisode||1,end=Math.min(show.latest,start+499),missing=[];
    for(let n=start;n<=end;n++){const e=show.episodes.get(n);if(!e||e.status==='已发布')missing.push({number:n,candidateIds:e?.candidateIds||[]});}
    const episodes=[...show.episodes.values()].sort((a,b)=>a.number-b.number).map(e=>({...e,watched:Object.hasOwn(show.episodeStates||{},String(e.number))?show.episodeStates[e.number]:e.number<=(show.watched||0),deleted:!!show.deletedEpisodes?.[e.number],deletionWarning:!!(show.deletedEpisodes?.[e.number]?.filesRemaining||show.deletedEpisodes?.[e.number]?.unknownFiles||show.deletedEpisodes?.[e.number]?.folderErrors)}));
    const fullyWatched=!!show.completedAt&&episodes.every(e=>e.watched);
    const resources = directResources.get(show.key) || [];
    const direct = resources.length > 0 && !subscribed.has(show.key);
    return{...show,fullyWatched,episodes,unknown:show.unknown.slice(0,20),missing:direct?[]:missing,direct,resources:resources.slice(0,60),rangeLimited:show.latest>end,watched:show.watched||0,downloaded:episodes.filter(e=>e.status==='已完成').length,unwatched:episodes.filter(e=>!e.watched&&e.status==='已完成').length};
  }).sort((a,b)=>a.title.localeCompare(b.title,'zh-CN'));
}

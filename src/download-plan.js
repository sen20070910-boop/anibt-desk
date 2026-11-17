import {applyAnimeBindings} from './anime-bindings.js';
import {episodeRecorded} from './episode-dedupe.js';
import {priorityWait,groupPriority} from './priority.js';
import {matchingAnimeRule} from './feed.js';
import {own} from './dictionary.js';

export function downloadPlan({items,state,config,source,match,now,baseline,baselineIds,selected,backfill,feedError,queueOnly}){
  const pending=new Map(),pendingKeys=new Map();for(const [key,entry]of Object.entries(state.pending))if(entry.source===source){pending.set(entry.item.id,entry);if(!pendingKeys.has(entry.item.id))pendingKeys.set(entry.item.id,[]);pendingKeys.get(entry.item.id).push(key);}
  const confirmations=new Map();for(const entry of pending.values())if(entry.submissionAttemptedAt&&entry.item.episodeKey&&!own(state.done,entry.item.id))confirmations.set(entry.item.episodeKey,entry.item.id);
  const merged=new Map(items.map(item=>[item.id,item]));for(const [id,entry]of pending)if(!merged.has(id))merged.set(id,entry.item);
  const rows=applyAnimeBindings([...merged.values()],config).filter(item=>!selected||selected.has(item.id)).map(item=>{
    const entry=pending.get(item.id),result=match(item);let status='ready',reason='下载候选',wait;
    if(!result.ok){status='excluded';reason=result.reason;}
    else if(own(state.done,item.id)){status='recorded';reason='已处理';}
    else if(!entry&&!backfill&&(baseline||baselineIds.has(item.id))){status='baseline';reason='现有基线（需补下载）';}
    else if(config.dedupeEpisodes&&episodeRecorded(state,item)){status='duplicate';reason='同集版本已处理';}
    else if(config.dedupeEpisodes&&confirmations.has(item.episodeKey)&&confirmations.get(item.episodeKey)!==item.id){status='confirmation-wait';reason='同集已有提交待确认，请先核对原任务';}
    else if(!backfill&&entry?.paused){status='paused';reason='此项已暂停，需手动重新排队';}
    else if(!backfill&&entry?.nextRetryAt>now){status='retry-wait';reason='等待逐项重试时间';}
    else if((feedError||(queueOnly&&entry?.waitingForSource))&&item.torrentUrl&&!item.torrentData&&!/^[a-f0-9]{40}$/i.test(item.infoHash||'')){status='source-wait';reason='等待来源恢复以获取种子';}
    else if(!/^[a-f0-9]{40}$/i.test(item.infoHash||'')){status='invalid';reason='资源缺少有效 hash，已暂停此项';}
    else if((wait=priorityWait(item,config,state,source,now,backfill))){status='priority-wait';reason=wait.reason;}
    return{item,entry,pendingKeys:pendingKeys.get(item.id)||[],status,reason,wait,matched:result.ok};
  });
  const oldRank=item=>{const gs=matchingAnimeRule(item,config)?.groups||config.filters.groups;const i=gs?.findIndex(g=>[item.groupName,item.groupSlug].some(v=>v?.toLowerCase()===g.toLowerCase()));return i>=0?i:999;};
  const buckets=new Map();for(const row of rows){const key=row.item.episodeKey||row.item.id;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(row);}
  const ordered=[...buckets.values()].sort((a,b)=>Math.min(...a.map(r=>Date.parse(r.item.publishedAt)||0))-Math.min(...b.map(r=>Date.parse(r.item.publishedAt)||0))).flatMap(group=>group.sort((a,b)=>groupPriority(a.item,config).rank-groupPriority(b.item,config).rank||oldRank(a.item)-oldRank(b.item)||a.item.title.localeCompare(b.item.title)));
  const ready=ordered.filter(r=>r.status==='ready');
  return{rows:ordered,ready,planned:new Set(ready.map(({item})=>config.dedupeEpisodes&&item.episodeKey?item.episodeKey:item.id)).size};
}

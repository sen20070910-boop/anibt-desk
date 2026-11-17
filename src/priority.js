import { effectiveFilters, norm } from './feed.js';
export function groupPriority(item,config){
  const groups=effectiveFilters(item,config).priorityGroups||[];
  const names=[item.groupName,item.groupSlug,...(item.groupName||'').split(/[&＆+、]/)].map(norm).filter(Boolean);
  const rank=groups.findIndex(g=>names.includes(norm(g)));
  return {rank:rank<0?groups.length:rank,enabled:groups.length>0};
}
export function priorityWait(item,config,state,source,now=Date.now(),backfill=false){
  const priority=groupPriority(item,config),hours=effectiveFilters(item,config).fallbackHours||0;
  if(backfill||!item.episodeKey||!priority.enabled||priority.rank===0||!hours)return null;
  const key=source+':'+item.episodeKey,first=state.prioritySince?.[key]??now;
  const until=first+hours*3600000;
  return now<until?{key,first,until,reason:`等待首选发布组，${new Date(until).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} 后允许补位`}:null;
}

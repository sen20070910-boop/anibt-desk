import {queueToken} from './retries.js';
import { matches, sourceKey } from './feed.js';
import { priorityWait } from './priority.js';
import { afterCleanup } from './maintenance.js';

// Expose display fields only; queued items contain private source/download URLs.
export function overviewDetails(state, config, {kind, query='', page='1'}, control={},maintenance={}) {
  if(!['added','pending'].includes(kind)||typeof query!=='string'||query.length>200||!/^\d{1,8}$/.test(String(page))||Number(page)<1)throw new Error('详情查询条件无效。');
  const secrets=[config.rssUrl,config.qb.password,config.qb.passwordEncrypted];
  try{for(const value of new URL(config.rssUrl).searchParams.values())if(value.length>=6)secrets.push(value);}catch{}
  const safe=value=>{let s=String(value||'');for(const secret of secrets.filter(Boolean))s=s.split(secret).join('[已隐藏]');return s.slice(0,1600);};
  const fields=item=>({title:safe(item.title),animeTitle:safe(item.animeTitle),bgmId:String(item.bgmId||''),episode:safe(item.episode)});
  const source=sourceKey(config.rssUrl);
  let rows;
  if(kind==='added')rows=Object.values(state.done).filter(row=>row.status==='added'&&afterCleanup(row,maintenance)).map(row=>({...fields(row),at:row.at||'',savePath:safe(row.savePath),status:'已自动添加'})).sort((a,b)=>b.at.localeCompare(a.at));
  else rows=Object.entries(state.pending).map(([id,entry])=>{
    const item=entry.item||{},sameSource=entry.source===source,match=matches(item,config),blocked=!!control.blocked?.[item.bgmId];
    const wait=sameSource&&match.ok&&!blocked?priorityWait(item,config,state,source):null;
    const status=!sameSource?'来源已切换':blocked?'网站已退订':!match.ok?'当前偏好已过滤':entry.paused?'此项已暂停':entry.waitingForSource?'等待来源恢复':entry.nextRetryAt>Date.now()?'等待逐项重试':wait?'等待优先发布组':entry.lastError?'添加失败，等待重试':'等待下次检查';
    const reason=!sameSource?'此记录来自之前的 RSS，当前订阅不会重试它。':blocked?'已取消网站订阅，此资源不会自动重试。':!match.ok?match.reason:wait?wait.reason:'后台将在后续检查时重新判断并处理。';
    return {...fields(item),queueId:queueToken(id,entry.source),attempts:entry.attempts||0,lastAttemptAt:entry.lastAttemptAt||'',nextRetryAt:entry.nextRetryAt||null,failureClass:entry.failureClass||'',failureStage:entry.failureStage||'',paused:!!entry.paused,groupName:safe(item.groupName||item.groupSlug),status,reason,lastError:safe(entry.lastError),waitUntil:wait?.until||null};
  }).sort((a,b)=>a.title.localeCompare(b.title,'zh-CN'));
  const total=rows.length,q=query.normalize('NFKC').trim().toLowerCase();
  if(q)rows=rows.filter(row=>Object.values(row).some(value=>typeof value==='string'&&value.normalize('NFKC').toLowerCase().includes(q)));
  const filteredTotal=rows.length,pageSize=40,pages=Math.max(1,Math.ceil(filteredTotal/pageSize)),current=Math.min(Number(page),pages);
  return {kind,total,filteredTotal,page:current,pages,pageSize,items:rows.slice((current-1)*pageSize,current*pageSize)};
}

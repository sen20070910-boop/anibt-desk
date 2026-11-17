import {applyAnimeBindings} from './anime-bindings.js';
import {episodeIdentity,legacyEpisodeIdentity,subjectId,normalizedTitle} from './anime-identity.js';

// Old keys whose release metadata is unavailable remain conservative tombstones.
// Resolvable keys migrate to subject identity; never infer identity from a new release.
export function migrateEpisodeState(state,config={},history=[]){
  const evidence=[...Object.entries(state.done||{}).map(([id,row])=>({...row,id})),...history];
  const historical=applyAnimeBindings(evidence,config,evidence).filter(row=>['added','existing'].includes(row.status)&&row.animeTitle&&row.episode);
  const byReference=new Map(),legacyKeys=new Set();
  for(const row of historical){if(row.id)byReference.set(row.id,row);if(row.hash)byReference.set(row.hash,row);legacyKeys.add(legacyEpisodeIdentity(row));}
  const indexed=new Set();
  for(const [key,id] of Object.entries(state.episodes||{})){
    if(key.startsWith('bgm:')||key.startsWith('title:'))continue;
    const row=state.done?.[id]||byReference.get(id);
    if(!row?.animeTitle){if(legacyKeys.has(key))delete state.episodes[key];continue;}
    const prefix=normalizedTitle(row.animeTitle)+':',suffix=key.startsWith(prefix)?key.slice(prefix.length):'',divider=suffix.lastIndexOf(':');
    if(divider<1)continue;
    const indexedRow={...row,episode:suffix.slice(0,divider),version:suffix.slice(divider+1)};
    const item=applyAnimeBindings([indexedRow],config,evidence)[0],next=episodeIdentity(item);
    if(next){state.episodes[next]??=id;delete state.episodes[key];indexed.add(id);}
  }
  for(const row of historical){if(indexed.has(row.id)||indexed.has(row.hash))continue;const key=episodeIdentity(row);if(key)state.episodes[key]??=row.id||row.hash||'historical';}
  for(const entry of Object.values(state.pending||{})){
    const item=applyAnimeBindings([entry.item],config,evidence)[0],old=entry.source+':'+legacyEpisodeIdentity(item),next=entry.source+':'+item.episodeKey;
    if(state.prioritySince?.[old]!=null){state.prioritySince[next]=Math.min(state.prioritySince[next]??Infinity,state.prioritySince[old]);}
    entry.item=item;
  }
  state.episodeIdentityVersion=2;return state;
}
export function episodeRecorded(state,item){
  const key=episodeIdentity(item);if(key&&state.episodes?.[key])return true;
  // Compatibility for title-only and pre-migration records. Explicit IDs must agree.
  for(const alias of [episodeIdentity({...item,bgmId:''}),legacyEpisodeIdentity(item)]){
    const id=state.episodes?.[alias];if(!id)continue;
    const recorded=state.done?.[id],known=subjectId(recorded?.bgmId);
    if(!known||!subjectId(item.bgmId)||known===subjectId(item.bgmId))return true;
  }
  return false;
}

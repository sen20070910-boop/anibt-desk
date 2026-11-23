import {ratingIdentity} from './rating-watches.js';

const keys=['title','bgmId','watched','startEpisode','archived','completedAt','personalReview','episodeStates','deletedEpisodes','showDeletion','watchSessions','rewatchStartedAt','lastWatchedOperation'];
const internal=['key','episodes','latest','missing','unknown','downloaded','unwatched','fullyWatched','rangeLimited'];
export function normalizeTracking(tracking,{strict=false}={}){
  const result=Object.create(null);
  for(const [key,value]of Object.entries(tracking||{})){
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('观看进度条目无效。');
    if(strict&&internal.some(k=>Object.hasOwn(value,k)))throw new Error('备份观看进度包含内部计算字段，不能恢复。');
    result[key]=Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));
    if(Object.hasOwn(value,'ratingIdentity'))result[key].ratingIdentity=ratingIdentity(value.ratingIdentity);
  }
  return result;
}

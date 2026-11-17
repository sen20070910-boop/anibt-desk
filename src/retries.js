import {createHash} from 'node:crypto';
export const queueToken=(id,source)=>createHash('sha256').update(JSON.stringify([id,source])).digest('hex');
export function classifyFailure(error){
  if(['MISSING_HASH','INVALID_TORRENT','HASH_MISMATCH','RESPONSE_TOO_LARGE'].includes(error.code))return{failureClass:'invalid-resource',paused:true};
  if(error.code==='ADD_REJECTED')return{failureClass:'downloader-rejected',paused:true};
  if([404,410].includes(error.httpStatus))return{failureClass:'source-missing',paused:true};
  if(error.code==='AUTH_FAILED'||[401,403].includes(error.httpStatus))return{failureClass:'authentication',paused:true};
  if(error.code==='CONFIRMATION_TIMEOUT'||error.submissionAttempted)return{failureClass:'confirmation',paused:false};
  if(error.httpStatus===429||error.retryAfterSeconds)return{failureClass:'rate-limit',paused:false};
  return{failureClass:'network',paused:false};
}
export function failedAttempt(entry,error,now){
  const attempts=(Number.isSafeInteger(entry.attempts)&&entry.attempts>=0?entry.attempts:0)+1,classification=classifyFailure(error),delay=Math.max(Math.min(30_000*2**Math.min(attempts-1,10),6*3600_000),(Number.isFinite(error.retryAfterSeconds)?Math.max(0,error.retryAfterSeconds):0)*1000);
  return{...entry,...classification,failureStage:error.stage||(classification.failureClass==='confirmation'?'confirmation':classification.failureClass==='invalid-resource'?'validation':'transfer'),attempts,lastAttemptAt:new Date(now).toISOString(),nextRetryAt:classification.paused?null:now+delay,lastError:error.message};
}
export function nextQueueWake(state,now,discoveryAt,source){
  let next=discoveryAt;for(const row of Object.values(state.pending))if(!row.paused&&(!source||row.source===source))for(const time of [row.nextRetryAt,row.waitUntil])if(Number.isFinite(time)&&time>now)next=Math.min(next,time);return next;
}

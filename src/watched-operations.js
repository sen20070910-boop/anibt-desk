import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {atomicWrite} from './config.js';
import {applyAnimeBindings} from './anime-bindings.js';
import {animeIdentity} from './anime-identity.js';
import {singleEpisode} from './episodes.js';

export function watchedOperations(configFile){
  const directory=path.join(path.dirname(configFile),'data/watched-operations');
  const read=()=>{
    let files;try{files=fs.readdirSync(directory);}catch(e){if(e.code==='ENOENT')return[];throw new Error('删除操作日志无法读取，尚未向下载器发送新的删除请求。');}
    return files.filter(name=>/^[a-f0-9]{32}\.json$/.test(name)).map(name=>{
      const op=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
      if(op.version!==1||op.id+'.json'!==name||!['prepared','downloader-complete','committed'].includes(op.status)||!['show','episode'].includes(op.scope)||!Array.isArray(op.targets)||op.targets.length>2000||typeof op.key!=='string'||!Number.isInteger(op.scope==='show'?op.end:op.episode)||(op.scope==='show'?op.end:op.episode)<(op.scope==='show'?0:1)||(op.scope==='show'?op.end:op.episode)>9999||op.targets.some(t=>! /^[a-f0-9]{40}$/.test(t.hash)||typeof t.savePath!=='string'||!Array.isArray(t.files)||t.files.some(f=>typeof f.name!=='string')))
        throw new Error('删除操作日志无法核对，已暂停相关自动下载。');
      return op;
    });
  };
  const save=op=>{
    const file=path.join(directory,op.id+'.json');atomicWrite(file,op);
    const descriptor=fs.openSync(file,'r+');try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
    return op;
  };
  return {read,save,pending:()=>read().filter(op=>op.status!=='committed'),
    prepare:input=>save({version:1,id:randomBytes(16).toString('hex'),status:'prepared',at:new Date().toISOString(),...input}),
    complete:(op,result)=>save({...op,status:'downloader-complete',result}),
    committed:op=>save({...op,status:'committed',committedAt:new Date().toISOString()}),
    summary:()=>read().filter(op=>op.status!=='committed').map(op=>({id:op.id,title:op.title,scope:op.scope,episode:op.episode,at:op.at,status:op.status,message:op.status==='downloader-complete'?'下载器已完成，本地记录待恢复':'删除结果待核对；不会自动重复删除'}))};
}
export function operationCovers(op,item,config){
  const linked=applyAnimeBindings([item],config)[0];
  if(op.targets.some(t=>t.hash===(item.infoHash||item.hash||'').toLowerCase()))return true;
  const saved=applyAnimeBindings([{animeTitle:op.title,bgmId:op.bgmId||''}],config)[0];
  return [op.key,animeIdentity(saved)].includes(animeIdentity(linked))&&(op.scope==='show'||singleEpisode(linked.episode)===op.episode);
}
export function deletionResult(targets){
  let filesRemaining=0,unknownFiles=0;
  for(const target of targets)for(const file of target.files)try{fs.statSync(path.resolve(target.savePath,file.name));filesRemaining++;}catch(e){if(e.code!=='ENOENT')unknownFiles++;}
  return{removedTasks:targets.length,filesRemaining,unknownFiles};
}

// Refresh the displayed warning using the confirmed file list. Older records
// without a file list keep their warning until someone verifies them manually.
export function recheckDeletionWarnings(tracking, readOperations, activeHashes, activeTorrents) {
  const pendingWarning = row => row?.filesRemaining || row?.unknownFiles || row?.folderErrors;
  if (!Object.values(tracking).some(entry =>
    pendingWarning(entry.showDeletion) || Object.values(entry.deletedEpisodes || {}).some(pendingWarning))) return;
  const operations = readOperations();
  const byId = new Map(operations.map(op => [op.id, op]));
  const newestFirst = operations.filter(op => op.status === 'committed' && op.targets.length)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const active = new Set(activeHashes.map(hash => hash.toLowerCase()));
  const checked = new Map();
  const refresh = (row, key, scope, episode) => {
    if (!pendingWarning(row)) return;
    const original = byId.get(row.operationId);
    if (original?.status !== 'committed' || original.key !== key || original.scope !== scope ||
        (scope === 'episode' && original.episode !== Number(episode))) return;
    // Clicking “watched” again after qB removed the task used to copy the
    // old warning into a new operation with an empty file list.
    const op = original.targets.length ? original : newestFirst.find(candidate =>
      candidate.key === original.key && candidate.scope === original.scope &&
      candidate.episode === original.episode && candidate.end === original.end &&
      Date.parse(candidate.at) <= Date.parse(original.at));
    if (!op || op.targets.some(target => active.has(target.hash))) return;
    if (!checked.has(op.id)) {
      const rootsAvailable = op.targets.every(target =>
        path.isAbsolute(target.savePath) && fs.existsSync(path.parse(target.savePath).root) && target.files.length);
      const result = rootsAvailable
        ? activeTorrents ? finishDeletion(op, activeTorrents) : deletionResult(op.targets)
        : null;
      checked.set(op.id, result);
    }
    const verified = checked.get(op.id);
    if (!verified || verified.filesRemaining || verified.unknownFiles) return;
    row.filesRemaining = 0;
    row.unknownFiles = 0;
    if (verified.folderErrors !== undefined) row.folderErrors = verified.folderErrors;
    if (row.folderErrors && op.cleanupFolders?.length && op.cleanupFolders.every(folder => {
      try { fs.lstatSync(folder); return false; }
      catch (error) { return error.code === 'ENOENT'; }
    })) row.folderErrors = 0;
  };
  for (const [key, entry] of Object.entries(tracking)) {
    for (const [episode, row] of Object.entries(entry.deletedEpisodes || {}))
      refresh(row, key, row?.scope, episode);
    refresh(entry.showDeletion, key, 'show');
  }
}
export function finishDeletion(op, active) {
  const result = deletionResult(op.targets);
  if (!op.cleanupFolders?.length || result.filesRemaining || result.unknownFiles) return result;
  let removedFolders = 0, folderErrors = 0;
  const location = value => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  for (const folder of op.cleanupFolders) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder) || path.parse(folder).root === folder ||
        !op.targets.some(target => location(target.savePath) === location(folder))) continue;
    const directory = location(folder);
    const inDirectory = value => value === directory || value.startsWith(directory + path.sep);
    if (active.some(t => {
      const save = t.save_path && location(t.save_path);
      const content = t.content_path && location(t.content_path);
      return (save && inDirectory(save)) ||
        (content && (inDirectory(content) || directory.startsWith(content + path.sep)));
    })) continue;
    const candidates = new Set([folder]);
    for (const target of op.targets.filter(target => location(target.savePath) === directory)) {
      for (const file of target.files) {
        let parent = path.dirname(path.resolve(target.savePath, file.name));
        while (location(parent) !== directory && inDirectory(location(parent))) {
          candidates.add(parent);
          parent = path.dirname(parent);
        }
      }
    }
    for (const candidate of [...candidates].sort((a, b) => b.length - a.length)) {
      try {
        if (!fs.lstatSync(candidate).isDirectory() || location(fs.realpathSync(candidate)) !== location(candidate)) continue;
        fs.rmdirSync(candidate);
        if (location(candidate) === directory) removedFolders++;
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) folderErrors++;
      }
    }
  }
  return {...result, removedFolders, folderErrors};
}
// No downloader mutation is allowed here. Recovery only verifies the original hashes.
export async function verifyDeletion(op,qb){
  const active=await qb.list();
  if(active.some(t=>op.targets.some(x=>x.hash===t.hash?.toLowerCase())))return null;
  return finishDeletion(op, active);
}
export function commitWatchedOperation(op,{config,configFile,state,tracking,write=atomicWrite}){
  const priorKey=Object.hasOwn(tracking,op.key)?op.key:op.priorKey;
  const current=tracking[priorKey]||{},result=op.result;
  if(!result)throw new Error('尚未核实下载器结果。');
  // Preserve reviews, watch sessions and unrelated episodes from the latest file.
  const entry={...current,title:op.title,bgmId:op.bgmId||'',watched:current.watched??op.watched??0,startEpisode:current.startEpisode||op.startEpisode||1,archived:op.scope==='show'?false:!!current.archived,episodeStates:{...current.episodeStates},deletedEpisodes:{...current.deletedEpisodes}};
  if(entry.lastWatchedOperation!==op.id){
    const episodes=op.scope==='show'?Array.from({length:op.end},(_,i)=>i+1):[op.episode];
    for(const episode of episodes){entry.episodeStates[episode]=true;entry.deletedEpisodes[episode]={at:op.at,operationId:op.id,scope:op.scope,hashes:op.targets.map(t=>t.hash),...result};}
    if(op.scope==='show'){entry.watched=Math.max(entry.watched,op.end);entry.completedAt=op.at;entry.showDeletion={at:op.at,operationId:op.id,...result};}
    entry.lastWatchedOperation=op.id;
  }
  for(const [id,p]of Object.entries(state.pending))if(operationCovers(op,p.item,config))delete state.pending[id];
  tracking[op.key]=entry;if(priorKey&&priorKey!==op.key)delete tracking[priorKey];
  // A crash between these files is repaired by replaying this idempotent patch.
  write(path.resolve(path.dirname(configFile),config.stateFile),state);
  write(path.join(path.dirname(configFile),'data/tracking.json'),tracking);
  return{scope:op.scope,action:'watched',ok:true,...result};
}

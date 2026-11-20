import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './config.js';
export async function submitAgain(qb,item,{savePath,organizeByAnime=false,paused=false,requireExisting=false}={}){
  const existing=(await qb.list()).find(t=>t.hash?.toLowerCase()===item.infoHash?.toLowerCase());
  if(existing){
    const modern=Number(String(qb.version||'5').match(/\d+/)?.[0])>=5;
    const operation=paused?(modern?'stop':'pause'):(modern?'start':'resume');
    // Start first so a recheck of a stopped torrent does not stop again when checking ends.
    await qb.request('torrents/'+operation,new URLSearchParams({hashes:item.infoHash}));
    await qb.request('torrents/recheck',new URLSearchParams({hashes:item.infoHash}));
    return{mode:'recheck',savePath:existing.save_path||savePath||''};
  }
  if(requireExisting)throw new Error('这项任务原来只下载了部分文件。请在「发现资源」找到同一版本，重新勾选需要的文件。');
  await qb.ensureCategory();const result=await qb.add(item,{stopped:paused,...(savePath?{savePath}:{organizeByAnime})});
  return{mode:'added',savePath:result?.savePath||savePath||''};
}
export function resetCompletion(directory,hash){
  const file=path.join(directory,'completions.json');let saved;
  try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return;throw new Error('完成通知记录无法读取。');}
  if(!saved.tasks||saved.version!==1)throw new Error('完成通知记录格式异常。');
  const old=saved.tasks[hash];if(!old)return;
  if(old.completedAt&&!old.historical){const archiveFile=path.join(directory,'completion-history.json');let archive=[];try{archive=JSON.parse(fs.readFileSync(archiveFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('完成提醒历史无法读取。');}
    if(!archive.some(x=>x.hash===hash&&x.at===old.completedAt))archive.unshift({hash,title:old.title,at:old.completedAt,delivered:!!old.notifiedAt});atomicWrite(archiveFile,archive.slice(0,200));}
  delete saved.tasks[hash];atomicWrite(file,saved);
}

import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {atomicWrite,loadConfig} from './config.js';
import {exportBackup} from './migration.js';
const read=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const dataDir=file=>path.join(path.dirname(file),'data');
export function backupSettings(file){const value={enabled:true,keep:7,...read(path.join(dataDir(file),'automatic-backups.json'),{})};if(typeof value.enabled!=='boolean'||![3,7,14].includes(value.keep))throw new Error('自动备份设置损坏，请检查设置文件。');return value;}
export function setBackupSettings(file,input){if(typeof input.enabled!=='boolean'||![3,7,14].includes(input.keep))throw new Error('备份设置无效。');const next={...backupSettings(file),enabled:input.enabled,keep:input.keep};atomicWrite(path.join(dataDir(file),'automatic-backups.json'),next);return next;}
function backupDirectory(file){const dir=path.join(dataDir(file),'automatic-backups');fs.mkdirSync(dir,{recursive:true});if(fs.lstatSync(dir).isSymbolicLink())throw new Error('备份目录不能是链接。');return dir;}
const validName=name=>/^auto-\d{8}T\d{9}Z-[a-f0-9]{8}\.json$/.test(name);
export function listAutomaticBackups(file){const dir=backupDirectory(file);return fs.readdirSync(dir).filter(validName).flatMap(name=>{const stat=fs.lstatSync(path.join(dir,name));return stat.isFile()&&!stat.isSymbolicLink()?[{id:name,at:stat.mtime.toISOString(),size:stat.size}]:[];}).sort((a,b)=>b.id.localeCompare(a.id));}
export function readAutomaticBackup(file,id){if(typeof id!=='string'||!validName(id))throw new Error('备份标识无效。');const full=path.join(backupDirectory(file),id),stat=fs.lstatSync(full);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)throw new Error('备份不可读取。');return read(full,null);}
export function maybeAutomaticBackup(file,{now=Date.now(),force=false}={}){
 let settings=backupSettings(file);const day=new Date(Number(now)+8*3600000).toISOString().slice(0,10);if(!force&&(!settings.enabled||settings.lastDay===day||Date.parse(settings.retryAt)>Number(now)))return {ran:false};
 const directory=dataDir(file);fs.mkdirSync(directory,{recursive:true});const lock=path.join(directory,'automatic-backup.lock');let fd;
 try{try{fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,String(process.pid));}catch(e){if(e.code!=='EEXIST')throw e;let pid=Number(fs.readFileSync(lock,'utf8'));if(!(pid>0)){if(Date.now()-fs.statSync(lock).mtimeMs<30000)return{ran:false,busy:true};fs.unlinkSync(lock);return maybeAutomaticBackup(file,{now,force});}try{process.kill(pid,0);return{ran:false,busy:true};}catch(error){if(error.code!=='ESRCH')return{ran:false,busy:true};}fs.unlinkSync(lock);return maybeAutomaticBackup(file,{now,force});}
  settings=backupSettings(file);if(!force&&(!settings.enabled||settings.lastDay===day))return{ran:false};
  if(!fs.existsSync(file))return{ran:false,unconfigured:true};const config=loadConfig(file,{validate:false});if(!config.rssUrl)return{ran:false,unconfigured:true};const tracking=read(path.join(directory,'tracking.json'),{}),backup=exportBackup(config,{done:{},episodes:{},sources:{}},tracking);
  const draft=read(path.join(directory,'review-drafts.json'),{});backup.reviewDrafts=draft;
  if(Buffer.byteLength(JSON.stringify(backup,null,2)+'\n')>16*1024*1024)throw new Error('SIZE_LIMIT');
  const dir=backupDirectory(file),stamp=new Date(now).toISOString().replace(/[-:]/g,'').replace('.','');const id='auto-'+stamp+'-'+randomBytes(4).toString('hex')+'.json';atomicWrite(path.join(dir,id),backup);
  for(const old of listAutomaticBackups(file).slice(settings.keep)){const full=path.join(dir,old.id);if(path.dirname(full)!==dir||!validName(old.id))throw new Error('PATH_LIMIT');fs.unlinkSync(full);}
  atomicWrite(path.join(directory,'automatic-backups.json'),{...settings,lastDay:day,lastAt:new Date(now).toISOString(),lastError:'',retryAt:''});return{ran:true,id};
 }catch(e){atomicWrite(path.join(directory,'automatic-backups.json'),{...settings,lastError:e.message==='SIZE_LIMIT'?'备份超过 16 MiB，请手动导出并整理记录。':'自动备份未完成，请重试。',retryAt:new Date(Number(now)+60000).toISOString()});if(force)throw new Error('备份未完成，请检查存储空间或备份大小。');return{ran:false,error:true};}
 finally{if(fd!==undefined){fs.closeSync(fd);try{fs.unlinkSync(lock);}catch{}}}
}
export function continuityStatus(file){return read(path.join(dataDir(file),'rss-continuity.json'),{lastSuccessAt:'',needsCheck:false});}
export function noteFeedSuccess(file,{now=Date.now(),previousAt=''}={}){const old=continuityStatus(file),before=Date.parse(old.lastSuccessAt||previousAt),gap=Number.isFinite(before)?Math.max(0,Number(now)-before):0;const next={...old,lastSuccessAt:new Date(now).toISOString()};if(gap>=6*3600000){next.needsCheck=true;next.gapHours=Math.round(gap/3600000);next.detectedAt=next.lastSuccessAt;}atomicWrite(path.join(dataDir(file),'rss-continuity.json'),next);return next;}
export function acknowledgeContinuity(file){const next={...continuityStatus(file),needsCheck:false,checkedAt:new Date().toISOString()};atomicWrite(path.join(dataDir(file),'rss-continuity.json'),next);return next;}

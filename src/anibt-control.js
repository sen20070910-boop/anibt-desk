import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite } from './config.js';
export const accountKeyHash=config=>{try{const u=new URL(config.rssUrl),key=u.searchParams.get('key')||u.searchParams.get('token');return key?createHash('sha256').update(key).digest('hex'):'';}catch{return '';}};
const filename=configFile=>path.join(path.dirname(configFile),'data/anibt-control.json');
export function readAniBTControl(configFile,config){
  const empty={keyHash:accountKeyHash(config),blocked:{},baseline:{}};
  try{const value=JSON.parse(fs.readFileSync(filename(configFile),'utf8'));if(value.keyHash!==empty.keyHash)return empty;if(!value.blocked||!value.baseline||typeof value.blocked!=='object'||typeof value.baseline!=='object'||Array.isArray(value.blocked)||Array.isArray(value.baseline))throw new Error();for(const [id,marker]of Object.entries(value.baseline))if(!/^\d{1,8}$/.test(id)||!marker||typeof marker.version!=='string'||!Number.isFinite(Date.parse(marker.before)))throw new Error();return value;}
  catch(e){if(e.code==='ENOENT')return empty;throw new Error('AniBT 订阅同步记录无法读取，请检查 data/anibt-control.json。');}
}
export function saveAniBTControl(configFile,value){atomicWrite(filename(configFile),value);}
export function siteExcluded(item,control){return !!(item.bgmId&&control?.blocked?.[String(item.bgmId)]);}

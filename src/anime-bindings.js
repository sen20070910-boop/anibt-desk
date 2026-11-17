import {normalizedTitle as norm,episodeIdentity} from './anime-identity.js';
export function validateBindings(bindings){
 if(!Array.isArray(bindings)||bindings.length>500)throw new Error('番剧关联列表无效。');
 const names=new Set();for(const row of bindings){if(!row||typeof row.title!=='string'||!row.title.trim()||row.title.length>300||!/^\d{1,8}$/.test(row.bgmId)||Number(row.bgmId)<1||typeof row.canonicalTitle!=='string'||row.canonicalTitle.length>300||!Array.isArray(row.aliases)||row.aliases.length>20||row.aliases.some(a=>typeof a!=='string'||!a.trim()||a.length>300))throw new Error('番剧编号或别名无效。');for(const name of new Set([row.title,...row.aliases].map(norm))){if(names.has(name))throw new Error('同一个番名或别名只能关联一部番剧。');names.add(name);}}
}
export function applyAnimeBindings(items,config,evidence=items){
 const explicit=items.map(item=>{
  if(item.bgmId)return {...item,episodeKey:episodeIdentity(item)};
  const name=norm(item.animeTitle||item.title);
  const binding=(config.bindings||[]).find(row=>[row.title,...row.aliases].some(a=>norm(a)===name));
  return binding?{...item,bgmId:binding.bgmId,linkedTitle:binding.canonicalTitle}:item;
 });
 const subjects=new Map();
 // Only exact show titles with a single known subject are safe to infer.
 // Preserve every explicit source ID, including conflicting same-name seasons.
 for(const row of [...evidence,...explicit]){
  const name=norm(row.animeTitle||row.title),id=String(row.bgmId||'');
  if(!name||!/^\d{1,8}$/.test(id)||Number(id)<1)continue;
  if(!subjects.has(name))subjects.set(name,new Set());
  subjects.get(name).add(id);
 }
 return explicit.map(item=>{
  if(item.bgmId)return {...item,episodeKey:episodeIdentity(item)};
  const ids=subjects.get(norm(item.animeTitle||item.title));
  const linked=ids?.size===1?{...item,bgmId:[...ids][0]}:item;
  return {...linked,episodeKey:episodeIdentity(linked)};
 });
}

import path from 'node:path';
import { validateDownloadPath } from './config.js';
import { matchingAnimeRule } from './feed.js';

export function discoveryDownloadItem(item,association={}){
  const name=String(association.animeTitle||item.animeTitle||item.workTitle||item.title||'未命名番剧').split(/\s+\/\s+/)[0].trim();
  return{...item,...association,animeTitle:name||'未命名番剧',bgmId:association.bgmId||item.bgmId||''};
}

export function animeFolderName(item){
  let name=String(item.animeTitle||'未命名番剧').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim().replace(/[. ]+$/g,'');
  if(!name||/^\.+$/.test(name))name='未命名番剧';
  if(/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(name))name='_'+name;
  return [...name].slice(0,100).join('').replace(/[. ]+$/g,'');
}
export function animeDownloadPath(item,config,defaultPath){
  const explicit=matchingAnimeRule(item,config)?.savePath;
  if(explicit?.trim())return validateDownloadPath(explicit,'单番下载目录');
  const root=validateDownloadPath(config.qb.savePath?.trim()||defaultPath,'追番根目录');
  if(!root)throw new Error('无法取得 qB 默认下载目录，请设置追番根目录后重试。');
  return (/^[a-z]:[\\/]/i.test(root)||root.startsWith('\\\\')?path.win32:path.posix).join(root,animeFolderName(item));
}

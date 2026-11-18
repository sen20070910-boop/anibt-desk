import fs from 'node:fs';import path from 'node:path';import{spawn}from'node:child_process';
export function localDownloader(config){return ['localhost','127.0.0.1','[::1]'].includes(new URL(config.qb.url).hostname);}
const releasePageHosts = new Set([
  'anibt.net', 'nyaa.si', 'dmhy.org', 'www.dmhy.org', 'share.dmhy.org',
  'vcb-s.com', 'www.vcb-s.com', 'animes.garden', 'www.animes.garden', 'mikanime.tv', 'mikanani.me',
]);
export function sourceLinks(row){const result=[];for(const link of [row.releaseUrl,...(row.sourceLinks||[]).map(i=>i.url)])try{const u=new URL(link);if(releasePageHosts.has(u.hostname)&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!/[?&](key|token)=/i.test(u.search))result.push({name:u.hostname,url:u.href});}catch{}if(!result.length&&!row.kind&&/^[a-zA-Z0-9_-]+$/.test(row.id||''))result.push({name:'AniBT 发布页',url:'https://anibt.net/release/'+encodeURIComponent(row.id)});return result;}
export async function inspectHistory(row,config,qb){
 const info={title:row.title,hash:row.hash||'',recordedAt:row.at,savePath:row.savePath||'',links:sourceLinks(row),connected:false,taskPresent:false,fileStatus:'unknown',fileMessage:'尚未核实文件。',canOpenFolder:false};
 const local=localDownloader(config);let torrent,files;
 try{await qb.login();info.connected=true;torrent=(await qb.list()).find(t=>t.hash?.toLowerCase()===row.hash?.toLowerCase());info.taskPresent=!!torrent;if(torrent){info.savePath=torrent.save_path||info.savePath;info.progress=torrent.progress;info.taskState=torrent.state;if(qb.request)files=await(await qb.request('torrents/files',null,'?hash='+encodeURIComponent(row.hash))).json();}}
 catch{info.fileMessage='qB 未连接，无法核实实际任务和文件。';}finally{await qb.logout();}
 if(!local){info.fileMessage='下载器位于远程，无法在本机核实文件或打开目录。';return info;}
 let root;try{root=fs.realpathSync(info.savePath);if(!fs.statSync(root).isDirectory())throw new Error();info.canOpenFolder=true;}catch{info.fileStatus=info.savePath?'directory-missing':'unknown';info.fileMessage=info.savePath?'记录的目录在本机不存在或无法访问。':'旧记录未保存目录，当前无法核实。';return info;}
 if(Array.isArray(files)&&files.length>2000){info.fileMessage='文件超过 2000 项，本次未逐项检查。';return info;}
 if(!torrent||!Array.isArray(files)||!files.length){info.fileMessage=info.connected?'目录存在，但 qB 中未找到该任务，无法确认具体视频文件。':'目录存在；qB 未连接，无法确认具体视频文件。';return info;}
 let missing=0,incomplete=0,checked=0;for(const file of files){if(file.priority===0)continue;if(typeof file.name!=='string'||path.isAbsolute(file.name)||!Number.isFinite(file.size)||file.size<0){info.fileMessage='下载器返回的文件列表无法安全核实。';return info;}const full=path.resolve(root,file.name);if(!full.startsWith(root+path.sep)){info.fileMessage='文件路径超出任务目录，未进行检查。';return info;}try{const real=fs.realpathSync(full);if(!real.startsWith(root+path.sep)){info.fileMessage='文件通过链接指向其他目录，未确认其完整性。';return info;}const stat=fs.statSync(real);if(!stat.isFile())missing++;else if(stat.size<file.size)incomplete++;}catch{missing++;}checked++;}
 info.fileStatus=missing?'missing':incomplete?'incomplete':checked?'present':'unknown';info.fileMessage=missing?`发现 ${missing} 个文件不存在或无法读取。`:incomplete?`发现 ${incomplete} 个文件大小尚不完整。`:checked?'已核对所选文件存在且大小符合 qB 记录；未进行内容哈希校验。':'没有需要检查的已选文件。';return info;
}
export async function openHistoryFolder(info){if(!info.canOpenFolder)throw new Error('没有可在本机打开的保存目录。');if(process.platform!=='win32')throw new Error('打开目录需要 Windows。');await new Promise((resolve,reject)=>{const child=spawn('explorer.exe',[info.savePath],{stdio:'ignore',windowsHide:false});child.once('error',reject);child.once('spawn',resolve);});}

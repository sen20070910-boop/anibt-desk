import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const isLocalQb = value => {try{return ['localhost','127.0.0.1','[::1]'].includes(new URL(value).hostname);}catch{return false;}};
export async function qbReachable(url) {
  try {const r=await fetch(url.replace(/\/$/,'')+'/api/v2/app/version',{signal:AbortSignal.timeout(1200)});await r.body?.cancel();return [200,401,403].includes(r.status);}catch{return false;}
}
export function findQbExecutable(config) {
  const candidates=config.qb.executable?[config.qb.executable]:[
    'D:/Apps/qBittorrent/qbittorrent.exe',
    ...[process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.LOCALAPPDATA].filter(Boolean).map(p=>path.join(p,'qBittorrent/qbittorrent.exe')),
  ];
  return candidates.find(p=>path.basename(p).toLowerCase()==='qbittorrent.exe'&&fs.existsSync(p))||'';
}
let starting;
export async function launchQbExecutable(executable,{platform=process.platform,spawnProcess=spawn}={}){
  if(platform==='win32'){
    // qB has no --minimized option. Minimize the native app through Windows,
    // while hiding only this short-lived PowerShell launcher.
    const script="$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;$appPath=[Console]::In.ReadToEnd()|ConvertFrom-Json;Start-Process -FilePath $appPath -ArgumentList '--no-splash' -WindowStyle Minimized";
    await new Promise((resolve,reject)=>{
      const child=spawnProcess('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','ignore','pipe']});
      let error='';child.stderr.on('data',b=>error+=b);child.once('error',()=>reject(new Error('无法调用 Windows 启动 qBittorrent。')));
      child.once('exit',code=>code===0?resolve():reject(new Error('无法启动 qBittorrent，请检查程序路径。')));
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(executable));
    });return;
  }
  await new Promise((resolve,reject)=>{const child=spawnProcess(executable,['--no-splash'],{detached:true,stdio:'ignore',windowsHide:false});child.once('error',()=>reject(new Error('无法启动 qBittorrent，请检查程序路径。')));child.once('spawn',()=>{child.unref();resolve();});});
}
export async function ensureQbRunning(config,deps={}) {
  if(!config.qb.autoStart||!isLocalQb(config.qb.url))return;
  const probe=deps.probe||qbReachable;
  if(await probe(config.qb.url))return;
  if(starting)return starting;
  starting=(async()=>{
    const executable=(deps.findExecutable||findQbExecutable)(config);
    if(!executable)throw new Error('需要提交下载，但未找到 qBittorrent。请在偏好设置中填写 qBittorrent 程序路径。');
    if(deps.launch)await deps.launch(executable);
    else await launchQbExecutable(executable);
    for(let i=0;i<(deps.attempts||50);i++){if(await probe(config.qb.url))return;await (deps.sleep||(ms=>new Promise(r=>setTimeout(r,ms))))(600);}
    throw new Error('已尝试启动 qBittorrent，Web UI 仍未就绪。请检查 qB 的启动提示和 Web UI 设置后重试。');
  })();
  try{await starting;}finally{starting=null;}
}

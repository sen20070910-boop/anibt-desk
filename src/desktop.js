import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function showDownloadInTaskbar(configFile){
  const entry=path.join(root,'dist/gui.mjs');
  if(!fs.existsSync(entry))throw new Error('未找到桌面界面组件。');
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[entry,'--config',configFile,'--background'],{detached:true,stdio:'ignore',windowsHide:true});
    child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
  });
}

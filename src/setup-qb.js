import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { loadConfig, atomicWrite, protectPassword } from './config.js';

export async function setupLocalQb(configFile) {
  if (process.platform !== 'win32') throw new Error('setup-qb 仅支持 Windows 默认 qBittorrent 配置。');
  const probe = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', "[Console]::Write([Diagnostics.Process]::GetProcessesByName('qbittorrent').Length)"], { encoding:'utf8',windowsHide:true });
  if (probe.status !== 0 || probe.stdout.trim() !== '0') throw new Error('请先在 qBittorrent 中选择「文件 → 退出」，再运行 setup-qb。工具不会强制结束 qB。');
  const iniFile = path.join(process.env.APPDATA,'qBittorrent','qBittorrent.ini');
  if (!fs.existsSync(iniFile)) throw new Error('没有找到默认 qBittorrent 配置。请先启动一次 qB，或手动启用 Web UI。');
  const text = fs.readFileSync(iniFile,'utf8');
  if (/^WebUI\\Enabled=true\s*$/mi.test(text)) throw new Error('Web UI 已启用。请用 init 设置现有 Web UI 账户，避免覆盖已有设置。');
  const config = loadConfig(configFile);
  let port;
  for (const candidate of [8080,8081,18080]) {
    const server = net.createServer();
    const free = await new Promise(resolve=>{server.once('error',()=>resolve(false));server.listen(candidate,'127.0.0.1',()=>server.close(()=>resolve(true)));});
    if (free) { port=candidate;break; }
  }
  if (!port) throw new Error('本机 8080、8081、18080 端口均不可用，请手动设置其他 Web UI 端口。');
  const password = randomBytes(24).toString('base64url');
  const salt = randomBytes(16);
  const encoded = `${salt.toString('base64')}:${pbkdf2Sync(password,salt,100000,64,'sha512').toString('base64')}`;
  const settings = {
    'WebUI\\Enabled':'true', 'WebUI\\Address':'127.0.0.1', 'WebUI\\Port':String(port), 'WebUI\\Username':'admin',
    'WebUI\\Password_PBKDF2':`"@ByteArray(${encoded})"`, 'WebUI\\LocalHostAuth':'true',
    'WebUI\\AuthSubnetWhitelistEnabled':'false', 'WebUI\\UseUPnP':'false', 'WebUI\\CSRFProtection':'true',
    'WebUI\\HostHeaderValidation':'true', 'WebUI\\ClickjackingProtection':'true', 'WebUI\\HTTPS\\Enabled':'false',
  };
  const encrypted = protectPassword(password);
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const backup = path.resolve(path.dirname(configFile),'data','backups',`qBittorrent-${stamp}.ini`);
  fs.mkdirSync(path.dirname(backup),{recursive:true});fs.copyFileSync(iniFile,backup,fs.constants.COPYFILE_EXCL);
  const lines = text.split(/\r?\n/);
  const start=lines.findIndex(l=>l.trim()==='[Preferences]');
  if(start<0) throw new Error('qB 配置缺少 Preferences 节；请手动开启 Web UI。');
  let end=start+1;while(end<lines.length&&!/^\[/.test(lines[end]))end++;
  const section=lines.slice(start+1,end).filter(l=>!Object.keys(settings).some(k=>l.startsWith(k+'=')));
  lines.splice(start+1,end-start-1,...section,...Object.entries(settings).map(([k,v])=>`${k}=${v}`),'');
  config.qb.url=`http://127.0.0.1:${port}`;config.qb.username='admin';config.qb.passwordEncrypted=encrypted;config.qb.password='';
  // Save a matching encrypted credential before changing qB. Restore if config writing fails.
  const previousConfig=fs.readFileSync(configFile);
  try { atomicWrite(configFile,config);fs.writeFileSync(iniFile,lines.join('\r\n')); }
  catch(e){fs.copyFileSync(backup,iniFile);fs.writeFileSync(configFile,previousConfig);throw e;}
  console.log(`已开启仅本机 Web UI：${config.qb.url}\n随机密码已使用 Windows 加密保存在工具配置中。\n原配置备份：${backup}\n请重新启动 qBittorrent，然后运行 anibt-qb doctor。`);
}

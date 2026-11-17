import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {validateBindings} from './anime-bindings.js';

export const defaults = {
  rssUrl: '', intervalSeconds: 300, firstRun: 'baseline', stateFile: 'data/state.json', startDate:'',startEpisode:'',
  qb: { url: 'http://127.0.0.1:8080', username: 'admin', password: '', passwordEncrypted: '', savePath: '', category: 'AniBT', tags: ['AniBT'], paused: false, autoStart: true, executable: '' },
  filters: { groups: [], resolutions: [], languages: ['CHS'], subtitles: [], include: [], exclude: [], priorityGroups:[], fallbackHours:6 },
  dedupeEpisodes: true, rules: [], bindings:[], notifications: { enabled: true, openOnDownload: true },
};
export const clone = x => structuredClone(x);
export function restoreDefaultPreferences(current,{resetAnimeRules=false}={}){
  const next=clone(current);
  for(const key of ['intervalSeconds','firstRun','startDate','startEpisode','filters','dedupeEpisodes','notifications'])next[key]=clone(defaults[key]);
  for(const key of ['savePath','category','tags','paused','autoStart'])next.qb[key]=clone(defaults.qb[key]);
  if(resetAnimeRules)next.rules=[];
  validateConfig({...next,rssUrl:next.rssUrl||'https://anibt.net/rss/subscriptions.xml?key=validation-only'});
  return next;
}
export function validateDownloadPath(value,label='下载目录'){
  if(typeof value!=='string'||value.length>1000||/[\x00-\x1f]/.test(value))throw new Error(label+'无效。');
  const folder=value.trim();if(!folder)return '';
  const windows=/^[a-z]:[\\/]/i.test(folder)||/^\\\\[^\\/]+[\\/][^\\/]+/.test(folder);
  if(!windows&&!path.posix.isAbsolute(folder))throw new Error(label+'请输入完整路径，例如 D:\\Anime\\学生会。');
  if(windows&&/[<>"|?*]/.test(folder))throw new Error(label+'包含不支持的字符。');
  return folder;
}
export function validateStartDate(value,label='开始追番日期'){
  if(value==='')return value;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error(label+'请使用 YYYY-MM-DD 格式或留空。');
  const date=new Date(value+'T00:00:00Z');if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw new Error(label+'不是有效日期。');
  return value;
}
export function validateStartEpisode(value,label='开始追番集数'){
  if(value==='')return value;
  if(!Number.isInteger(value)||value<1||value>9999)throw new Error(label+'需为 1–9999 的整数，或留空表示不限集数。');
  return value;
}
export function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function protectPassword(password, decrypt = false) {
  if (process.platform !== 'win32') throw new Error('加密密码仅支持 Windows；其他系统请用 QBITTORRENT_PASSWORD 环境变量。');
  // DPAPI binds the encrypted value to the current Windows account. Secrets travel over stdin.
  const prefix = "[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;[void][Reflection.Assembly]::LoadWithPartialName('System.Security');$v=[Console]::In.ReadToEnd();";
  const script = prefix + (decrypt
    ? "$b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write([Text.Encoding]::UTF8.GetString($b))"
    : "$b=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write([Convert]::ToBase64String($b))");
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: password, encoding: 'utf8', windowsHide: true, maxBuffer:32*1024*1024 });
  if (r.status !== 0 || !r.stdout) throw new Error('Windows 密码加密/解密失败；请重新运行 init，或设置 QBITTORRENT_PASSWORD。');
  return r.stdout.trim();
}
export function validateConfig(c) {
  validateBindings(c.bindings||[]);
  let u;
  try { u = new URL(c.rssUrl); } catch { throw new Error('请先运行 init 配置个人 RSS 链接。'); }
  if (u.protocol !== 'https:' || u.hostname !== 'anibt.net' || u.username || u.password || !u.pathname.startsWith('/rss/'))
    throw new Error('RSS 必须是 https://anibt.net/rss/ 下的官方链接。');
  if (u.pathname === '/rss/subscriptions.xml' && !(u.searchParams.get('key') || u.searchParams.get('token')))
    throw new Error('个人订阅 RSS 缺少 key/token，请从「我的订阅」复制完整链接。');
  try { u = new URL(c.qb.url); } catch { throw new Error('qBittorrent Web UI 地址无效。'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw new Error('Web UI 地址必须是 HTTP/HTTPS 地址，用户名和密码请分开配置。');
  if (!Number.isInteger(c.intervalSeconds) || c.intervalSeconds < 120) throw new Error('检查间隔至少 120 秒。');
  if (!['baseline', 'download'].includes(c.firstRun)) throw new Error('firstRun 只能是 baseline 或 download。');
  if (typeof c.dedupeEpisodes !== 'boolean' || typeof c.qb.paused !== 'boolean') throw new Error('dedupeEpisodes 和 qb.paused 必须是布尔值。');
  if(typeof c.qb.autoStart!=='boolean'||typeof c.notifications?.enabled!=='boolean')throw new Error('自动启动和下载通知必须为布尔值。');
  if(typeof c.notifications?.openOnDownload!=='boolean')throw new Error('任务栏下载提示必须为布尔值。');
  if(typeof c.qb.executable!=='string'||/[\x00-\x1f]/.test(c.qb.executable)||c.qb.executable.length>1000)throw new Error('qBittorrent 程序路径无效。');
  if (!Array.isArray(c.rules)) throw new Error('rules 必须为数组。');
  validateDownloadPath(c.qb.savePath);validateStartDate(c.startDate);validateStartEpisode(c.startEpisode===undefined?'':c.startEpisode);
  for(const rule of c.rules){if(rule.savePath!==undefined)validateDownloadPath(rule.savePath,'单番下载目录');if(rule.startDate!==undefined)validateStartDate(rule.startDate,'单番开始日期');if(rule.startEpisode!==undefined)validateStartEpisode(rule.startEpisode,'单番开始集数');}
  for (const f of [c.filters, ...c.rules]) {
    if(f.fallbackHours!==undefined&&(!Number.isFinite(f.fallbackHours)||f.fallbackHours<0||f.fallbackHours>168))throw new Error('等待补位时间需为 0 至 168 小时。');
    for (const key of ['groups', 'resolutions', 'languages', 'subtitles', 'include', 'exclude','priorityGroups']) {
      if (f[key] !== undefined && (!Array.isArray(f[key]) || f[key].some(x => typeof x !== 'string')))
        throw new Error(`${key} 必须是字符串数组。`);
    }
  }
  for (const r of c.rules) if (!r.bgmId && !r.title) throw new Error('每条番剧规则必须设置 bgmId 或 title。');
  if (c.rules.some(r=>r.enabled !== undefined && typeof r.enabled !== 'boolean')) throw new Error('规则 enabled 必须是布尔值。');
  return c;
}
export function loadConfig(file, { validate = true } = {}) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT') throw new Error('未找到 config.json，请先运行 anibt-qb init。'); throw new Error('配置文件无法读取或 JSON 格式错误。'); }
  const c = { ...clone(defaults), ...raw, qb: { ...defaults.qb, ...raw.qb }, filters: { ...defaults.filters, ...raw.filters }, notifications:{...defaults.notifications,...raw.notifications} };
  c.rssUrl = process.env.ANIBT_RSS_URL || c.rssUrl;
  c.qb.url = process.env.QBITTORRENT_URL || c.qb.url;
  if (validate) validateConfig(c);
  return c;
}
export function getPassword(c) { return process.env.QBITTORRENT_PASSWORD ?? (c.qb.passwordEncrypted ? protectPassword(c.qb.passwordEncrypted, true) : c.qb.password); }
export function redactedConfig(c) {
  const copy = clone(c);
  copy.rssUrl = copy.rssUrl ? copy.rssUrl.replace(/([?&](?:key|token)=)[^&]*/gi, '$1***') : '';
  copy.qb.password = copy.qb.password ? '***' : '';
  copy.qb.passwordEncrypted = copy.qb.passwordEncrypted ? '(Windows 加密保存)' : '';
  return copy;
}

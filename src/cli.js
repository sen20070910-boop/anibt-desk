#!/usr/bin/env node
import {APP_VERSION,MIN_NODE} from './version.js';
import {nextQueueWake} from './retries.js';
import './runtime-guard.js';
import {maybeAutomaticBackup} from './continuity.js';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { defaults, clone, atomicWrite, loadConfig, validateConfig, protectPassword, redactedConfig } from './config.js';
import { fetchFeed, safeFetch, sourceKey } from './feed.js';
import { QbClient } from './qb.js';
import { runOnce, lock, loadState, statePath } from './runner.js';
import { setupLocalQb } from './setup-qb.js';
import { createCompletionMonitor } from './notifications.js';
import { runMonthlyCleanup } from './maintenance.js';
import { weeklyCacheCleanup } from './weekly-cache-cleanup.js';
import {installBackgroundLogs} from './bounded-log.js';
import {createWatchHeartbeat} from './watch-health.js';

const help = `AniBT → qBittorrent ${APP_VERSION}（Node.js >=${MIN_NODE}）

  anibt-qb init                      交互式设置 RSS、qB 和筛选规则
  anibt-qb setup-qb                  退出 qB 后，自动启用仅本机 Web UI
  anibt-qb doctor                    检查配置、真实 RSS 和 qB 连接
  anibt-qb preview                   预览规则匹配；不写记录、不添加任务
  anibt-qb run                       检查一次（首次建立基线，只追新发布）
  anibt-qb run --backfill             补下载 RSS 中现有资源
  anibt-qb watch                     持续自动检查，Ctrl+C 停止
  anibt-qb status                    查看下载与待重试数量
  anibt-qb groups                    查看 AniBT 压制组名称和 slug
  anibt-qb config show               查看脱敏配置
  anibt-qb config set groups "LoliHouse,桜都字幕组"
  anibt-qb config set groups ""       恢复为压制组不限
  anibt-qb config set priorityGroups "LoliHouse,桜都字幕组"
  anibt-qb config set fallbackHours 6
  anibt-qb config set resolutions "1080p"
  anibt-qb config set languages "CHS" 必须包含简中（含简繁双语）
  anibt-qb rule add --bgm-id 123 --groups "LoliHouse"
  anibt-qb rule list
  anibt-qb rule remove --bgm-id 123

通用选项：--config 路径  --dry-run  --backfill  --help
rule add 可用：--title 名称 --groups 组名 --resolutions 1080p
              --save-path 完整目录 --start-date YYYY-MM-DD --start-episode 6
              --priorityGroups 组名优先顺序 --fallbackHours 6
              --languages CHS --subtitles INTERNAL --include HEVC --exclude 合集
同一番剧的规则覆盖全局同名字段；筛选项空字符串表示不限。
单番目录留空自动使用追番根目录下的番名文件夹。默认根目录为 qB 的默认目录。
config set startEpisode 6：从第 6 集开始；空字符串不限集数。单番可覆盖或留空取消限制。
开始集数与日期同时设置时须同时满足。首次基线不会因修改集数而重置，旧集仍需选集补下载。
开始日期按北京时间筛选发布时间，包含当天；config set startDate 设置全局日期。
watch 每轮重新读取配置。--backfill 仅对 watch 的第一轮生效。
Windows 后台启动：powershell -File .\\scripts\\background.ps1 start
Windows 登录自动启动：powershell -File .\\scripts\\background.ps1 install
`;
const { values: args, positionals: pos } = parseArgs({ allowPositionals: true, strict: true, options: {
  'background-log':{type:'boolean'},config: { type: 'string' }, help: { type: 'boolean', short: 'h' }, 'dry-run': { type: 'boolean' }, backfill: { type: 'boolean' },
  'bgm-id': { type: 'string' }, title: { type: 'string' }, groups: { type: 'string' }, resolutions: { type: 'string' },
  priorityGroups:{type:'string'},fallbackHours:{type:'string'},'save-path':{type:'string'},'start-date':{type:'string'},'start-episode':{type:'string'},
  languages: { type: 'string' }, subtitles: { type: 'string' }, include: { type: 'string' }, exclude: { type: 'string' },
} });
const configFile = path.resolve(args.config || 'config.json');
if(args['background-log'])installBackgroundLogs(path.join(path.dirname(configFile),'data'));
const csv = x => x.split(/[,，]/).map(s=>s.trim()).filter(Boolean);
const summary = r=>console.log(`读取 ${r.total} 条，符合 ${r.matched} 条，新增 ${r.added}，已处理 ${r.existing}，基线 ${r.baseline}，等待 / 暂停 ${r.waiting||0}，失败 ${r.failed}${r.dryRun ? `（预览：去重后最多 ${r.planned} 个候选；实际添加前还会检查 qB）` : ''}。`);
async function prompt(question, fallback = '', secret = false) {
  if (secret && !process.stdin.isTTY) throw new Error('密码输入需要交互式终端；也可用 QBITTORRENT_PASSWORD 环境变量。');
  let mute = false;
  const output = new Writable({ write(chunk, enc, next) { if (!mute) process.stdout.write(chunk); next(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
  process.stdout.write(`${question}${fallback ? ` [${fallback}]` : ''}：`);
  mute = secret;
  try { const answer = await rl.question(''); if (secret) process.stdout.write('\n'); return answer.trim() || fallback; }
  finally { rl.close(); }
}
async function init() {
  const c = fs.existsSync(configFile) ? loadConfig(configFile, { validate: false }) : clone(defaults);
  console.log('配置只保存在本机；Windows 下 qB 密码使用当前账户加密。默认仅追踪未来新发布。');
  c.rssUrl = await prompt('粘贴「我的订阅」完整私人 RSS 链接（输入隐藏；留空保留原值）', '', true) || c.rssUrl;
  c.qb.url = await prompt('qBittorrent Web UI 地址', c.qb.url);
  c.qb.username = await prompt('Web UI 用户名', c.qb.username);
  const password = await prompt('Web UI 密码（隐藏；留空保留原值）', '', true);
  if (password) {
    if (process.platform === 'win32') { c.qb.passwordEncrypted = protectPassword(password); c.qb.password = ''; }
    else { console.log('请用 QBITTORRENT_PASSWORD 环境变量提供密码。'); }
  }
  c.filters.groups = csv(await prompt('压制组，逗号分隔；不限填 *', c.filters.groups.join(',') || '*')).filter(s=>s!=='*');
  c.filters.languages = csv(await prompt('字幕语言；CHS 为简中；不限填 *', c.filters.languages.join(',') || 'CHS')).filter(s=>s!=='*');
  c.filters.resolutions = csv(await prompt('画质，逗号分隔；不限填 *', c.filters.resolutions.join(',') || '*')).filter(s=>s!=='*');
  c.qb.savePath = await prompt('下载目录；使用 qB 默认目录填 *', c.qb.savePath || '*');
  if (c.qb.savePath === '*') c.qb.savePath = '';
  validateConfig(c); atomicWrite(configFile, c);
  console.log(`已保存：${configFile}\n下一步：anibt-qb doctor，然后 anibt-qb watch。`);
}
async function main() {
  if (args.help || !pos.length) { console.log(help); return; }
  const command = pos[0];
  if (command === 'init') return init();
  if (command === 'setup-qb') return setupLocalQb(configFile);
  if (command === 'groups') {
    const r = await (await safeFetch('https://anibt.net/api/subtitle-groups')).json();
    if (!Array.isArray(r.data)) throw new Error('字幕组目录响应格式异常。');
    console.table(r.data.map(g=>({ 名称: g.name, slug: g.slug })));
    return;
  }
  const c = loadConfig(configFile);
  if (command === 'doctor') {
    console.log('配置格式：通过；个人 RSS 令牌已隐藏。');
    const items = await fetchFeed(c.rssUrl); console.log(`RSS 连接：通过，返回 ${items.length} 条发布。`);
    const qb = new QbClient(c);
    try { console.log(`qB 连接：通过，${await qb.login()}；当前任务 ${(await qb.list()).length} 个。`); }
    finally { await qb.logout(); }
    return;
  }
  if (command === 'config') {
    if (pos[1] === 'show') { console.log(JSON.stringify(redactedConfig(c), null, 2)); return; }
    if (pos[1] !== 'set' || pos.length !== 4) throw new Error('用法：config set groups "LoliHouse"；可用字段见 --help。');
    const [,, key, value] = pos;
    if(key==='fallbackHours')c.filters.fallbackHours=Number(value);
    else if (Object.hasOwn(c.filters, key)) c.filters[key] = csv(value);
    else if (key === 'intervalSeconds') c.intervalSeconds = Number(value);
    else if (key === 'firstRun') c.firstRun = value;
    else if(key==='startDate')c.startDate=value;
    else if(key==='startEpisode')c.startEpisode=value.trim()?Number(value):'';
    else if (key === 'dedupeEpisodes' || key === 'paused') {
      if (!['true','false'].includes(value)) throw new Error('布尔值必须为 true 或 false。');
      if (key === 'paused') c.qb.paused = value === 'true'; else c[key] = value === 'true';
    }
    else if (['savePath','category'].includes(key)) c.qb[key] = value;
    else throw new Error('不支持的配置字段；RSS 和密码请运行 init 设置。');
    validateConfig(c); atomicWrite(configFile, c); console.log(`已更新 ${key}。`); return;
  }
  if (command === 'rule') {
    if (pos[1] === 'list') { console.log(JSON.stringify(c.rules,null,2)); return; }
    const bgmId = args['bgm-id'];
    if (!bgmId && !args.title) throw new Error('请使用 --bgm-id 或 --title 指定番剧。');
    if (bgmId && !/^\d+$/.test(bgmId)) throw new Error('bgm-id 必须是数字。');
    const same = r=>bgmId ? String(r.bgmId)===bgmId : !r.bgmId && r.title===args.title;
    if (pos[1] === 'remove') c.rules = c.rules.filter(r=>!same(r));
    else if (pos[1] === 'add') {
      const r = c.rules.find(same) || (bgmId ? { bgmId } : { title: args.title });
      for (const key of Object.keys(c.filters)) if (args[key] !== undefined) r[key] = key==='fallbackHours'?Number(args[key]):csv(args[key]);
      if(args['save-path']!==undefined){const folder=args['save-path'].trim();if(folder)r.savePath=folder;else delete r.savePath;}
      if(args['start-date']!==undefined)r.startDate=args['start-date'];
      if(args['start-episode']!==undefined)r.startEpisode=args['start-episode'].trim()?Number(args['start-episode']):'';
      c.rules = [r, ...c.rules.filter(x=>!same(x))];
    } else throw new Error('rule 支持 add、list、remove。');
    validateConfig(c); atomicWrite(configFile,c); console.log('番剧规则已保存。'); return;
  }
  if (command === 'status') {
    const s=loadState(statePath(c,configFile));
    console.log(JSON.stringify({ 最近更新:s.updatedAt, 已记录发布:Object.keys(s.done).length, 已处理集数:Object.keys(s.episodes).length, 待重试:Object.keys(s.pending).length, 当前订阅已初始化:!!s.sources[sourceKey(c.rssUrl)] },null,2)); return;
  }
  if (!['preview','run','watch'].includes(command)) throw new Error('未知命令；请运行 --help 查看用法。');
  const dryRun = command === 'preview' || !!args['dry-run'];
  const release = dryRun ? ()=>{} : lock(statePath(c,configFile)+'.lock');
  const heartbeat = createWatchHeartbeat(configFile,
    command === 'watch' && !dryRun ? process.env.ANIBT_WATCH_SESSION : '');
  let stop = false, wake;
  const monitor=command==='watch'&&!dryRun?createCompletionMonitor(configFile):null;
  const cleanCache = monitor && process.platform === 'win32'
    ? weeklyCacheCleanup(path.join(path.dirname(configFile), 'data')) : null;
  const maintainCache = () => {
    try {
      const result = cleanCache?.();
      if (result?.bytes) console.log(`每周网页缓存清理完成，释放 ${(result.bytes / 1048576).toFixed(1)} MiB。`);
    } catch (error) {
      console.error(`网页缓存清理将稍后重试（${error.code || error.message}）。`);
    }
  };
  const onStop = ()=>{ stop=true; wake?.(); };
  process.once('SIGINT',onStop); process.once('SIGTERM',onStop);
  try {
    let first = true,nextDiscoveryAt=0;
    do {
      let delay = c.intervalSeconds;
      try {
        heartbeat.update('checking');
        maintainCache();
        if(!dryRun)try{maybeAutomaticBackup(configFile);}catch{}
        if(!dryRun)runMonthlyCleanup(path.join(path.dirname(configFile),'data'));
        const current = loadConfig(configFile);
        if (statePath(current, configFile) !== statePath(c, configFile)) throw new Error('运行中不能更改 stateFile；请停止后重新启动。');
        delay = current.intervalSeconds;
        const queueOnly=command==='watch'&&Date.now()<nextDiscoveryAt;if(!queueOnly)nextDiscoveryAt=Date.now()+current.intervalSeconds*1000;
        const report = await runOnce(current,configFile,{dryRun,queueOnly,backfill:args.backfill && first}, {
          log: message => { heartbeat.update('checking'); console.log(message); }
        }); summary(report);if(command==='watch'){nextDiscoveryAt=Math.max(nextDiscoveryAt,Date.now()+(report.feedRetryAfterSeconds||0)*1000);delay=Math.max(1,Math.ceil((nextQueueWake(loadState(statePath(current,configFile)),Date.now(),nextDiscoveryAt,sourceKey(current.rssUrl))-Date.now())/1000));}
        if (report.failed) process.exitCode = command === 'watch' ? 0 : 1;
      } catch (e) {
        if (command !== 'watch') throw e;
        console.error(`[${new Date().toLocaleString()}] ${e.message}`);
        delay = Math.max(delay, e.retryAfterSeconds || 0);
      }
      first=false;
      if (command !== 'watch' || stop) break;
      console.log(`等待 ${delay} 秒后再次检查。`);
      const deadline=Date.now()+delay*1000;
      heartbeat.update('waiting', {waitUntil: deadline});
      do {
        maintainCache();
        if(monitor&&!stop){try{runMonthlyCleanup(path.join(path.dirname(configFile),'data'));await monitor.poll(loadConfig(configFile));}catch(e){console.error(e.message);}}
        if(stop)break;
        await new Promise(resolve=>{const timer=setTimeout(resolve,Math.min(30000,Math.max(0,deadline-Date.now())));wake=()=>{clearTimeout(timer);resolve();};});wake=null;
      }while(!stop&&Date.now()<deadline);
    } while (!stop);
  } finally { heartbeat.close(); process.removeListener('SIGINT',onStop); process.removeListener('SIGTERM',onStop); release(); }
}
main().catch(e=>{ console.error('错误：'+e.message); process.exitCode=1; });

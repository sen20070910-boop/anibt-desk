import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { QbClient } from '../qb.js';
import { readQbFiles } from '../qb-files.js';
import { verifiedLocalVideo } from '../local-video.js';
import { classifyDiscoveryFiles } from '../discovery-files.js';
import { applyAnimeBindings } from '../anime-bindings.js';
import { animeKey } from '../progress.js';
import { episodeInReleaseTitle, singleEpisode } from '../episodes.js';
import { localDownloader } from '../history-actions.js';
import { loadState, statePath } from '../runner.js';

export function createPlaybackRoutes(ctx) {
  const directory = path.join(path.dirname(ctx.configFile), 'data', 'playback');
  const lastFile = path.join(directory, 'last.json');
  const readLast = () => ctx.readJsonFile(lastFile, null);
  const readSample = last => /^[a-f0-9]{32}$/.test(last?.id || '')
    ? ctx.readJsonFile(path.join(directory, last.id + '.json'), {}) : {};
  let starting = false;
  let nextCache;

  async function findVideo(key, episode, hash) {
    const config = ctx.getConfig();
    if (!localDownloader(config)) return null;
    const manual = ctx.readManual();
    const state = loadState(statePath(config, ctx.configFile), config, Object.values(manual));
    const history = applyAnimeBindings([...Object.values(state.done), ...Object.values(manual)], config)
      .filter(row => animeKey(row) === key && ['added', 'existing'].includes(row.status) &&
        /^[a-f0-9]{40}$/.test(row.hash || '') && (!hash || row.hash === hash));
    if (!history.length) return null;
    const candidates = history.filter(row => !episode || !singleEpisode(row.episode) || singleEpisode(row.episode) === episode)
      .sort((a,b) => Number(singleEpisode(b.episode) === episode) - Number(singleEpisode(a.episode) === episode));
    const qb = ctx.deps.playbackQb || ctx.deps.qb || new QbClient(config);
    try {
      await qb.login();
      const tasks = new Map((await qb.list()).map(task => [task.hash?.toLowerCase(), task]));
      let checked = 0;
      for (const row of candidates) {
        const task = tasks.get(row.hash);
        if (!task) continue;
        if (++checked > 8) break;
        let files;
        try { files = await readQbFiles(qb, row.hash); } catch { continue; }
        const videos = classifyDiscoveryFiles(files.map(file => ({ path: file.name.replaceAll('\\','/'), size: file.size })))
          .filter(file => file.kind === 'video')
          .map(file => ({ ...files[file.index], episode: episodeInReleaseTitle(file.path.split('/').at(-1).replace(/\.[^.]+$/, '')) }));
        const completed = videos.filter(file => file.progress === 1 && file.priority > 0);
        const chosen = episode
          ? completed.find(file => file.episode === episode)
            || (videos.length === 1 && singleEpisode(row.episode) === episode ? completed[0] : null)
          : videos.length === 1 ? completed[0]
            : completed.filter(file => file.episode).sort((a,b) => a.episode-b.episode)[0];
        if (!chosen) continue;
        const file = await verifiedLocalVideo(task.save_path, chosen.name, chosen.size);
        if (file) return {
          key, episode: episode || singleEpisode(row.episode) || chosen.episode || null,
          title: row.animeTitle || row.title, savePath: task.save_path, name: chosen.name, size: chosen.size,
        };
      }
      return null;
    } finally { await qb.logout(); }
  }

  async function nextVideo(last) {
    if (!last?.episode) return null;
    if (nextCache?.id === last.id && Date.now() - nextCache.at < 15000) return nextCache.video;
    const video = await findVideo(last.key, last.episode + 1).catch(() => null);
    nextCache = { id: last.id, at: Date.now(), video };
    return video;
  }

  function launchMpv(file, sample, seconds) {
    const executable = [
      process.env.ANIBT_MPV_EXE,
      path.join(path.parse(ctx.root).root, 'Apps', 'mpv', 'mpv.exe'),
      ...(process.env.PATH || '').split(path.delimiter).filter(path.isAbsolute).map(dir => path.join(dir, 'mpv.exe')),
    ].find(name => name && path.isAbsolute(name) && path.basename(name).toLowerCase() === 'mpv.exe' &&
      fs.statSync(name, { throwIfNoEntry: false })?.isFile());
    if (!executable) throw new Error('没找到 mpv.exe。可以将其加入 PATH，或用 ANIBT_MPV_EXE 指定完整路径后重开追番台。');
    const script = path.join(ctx.root, 'scripts', 'record-mpv-playback.lua');
    return new Promise((resolve, reject) => {
      const args = ['--script=' + script, '--keep-open=no',
        ...(seconds > 0 ? ['--no-resume-playback', '--start=' + seconds.toFixed(2)] : []), '--', file];
      const child = spawn(executable, args, { detached: true, stdio: 'ignore',
        env: { ...process.env, ANIBT_PLAYBACK_SAMPLE: sample, ANIBT_PLAYBACK_MEDIA: file } });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }

  return async function playbackRoute({ route, res, body }) {
    if (route === 'GET /api/playback') {
      const last = readLast();
      if (!last || !localDownloader(ctx.getConfig())) {
        ctx.json(res, 200, { last: null });
        return true;
      }
      const sample = readSample(last);
      const local = !!await verifiedLocalVideo(last.savePath, last.name, last.size);
      const next = sample.finished === true ? await nextVideo(last) : null;
      ctx.json(res, 200, { last: {
        title: last.title, episode: last.episode, position: Number(sample.position) || 0,
        finished: sample.finished === true, local, nextEpisode: next?.episode || null,
      } });
      return true;
    }
    if (route !== 'POST /api/playback/start') return false;
    if (starting) throw new Error('正在打开播放器。');
    if (!localDownloader(ctx.getConfig())) throw new Error('请在连接本机 qB 时使用继续观看。');
    starting = true;
    try {
      let selection, seconds = 0;
      if (body.action === 'resume' || body.action === 'next') {
        const last = readLast(), sample = readSample(last);
        if (body.action === 'resume' && last && !sample.finished) {
          selection = last;
          seconds = Number.isFinite(sample.position) ? Math.max(0, sample.position) : 0;
        } else if (body.action === 'next' && last?.episode && sample.finished) {
          selection = await findVideo(last.key, last.episode + 1);
        }
      } else {
        const { key, episode, hash } = body;
        if (typeof key !== 'string' || key.length > 500 || !/^(bgm:\d{1,8}|title:.+)$/.test(key) ||
            (episode !== undefined && (!Number.isInteger(episode) || episode < 1 || episode > 9999)) ||
            (hash !== undefined && !/^[a-f0-9]{40}$/.test(hash)) || (!episode && !hash))
          throw new Error('番剧或播放任务无效。');
        selection = await findVideo(key, episode, hash);
      }
      const file = selection && await verifiedLocalVideo(selection.savePath, selection.name, selection.size);
      if (!file) throw new Error('未找到已经完整下载的本机视频。');
      const id = randomBytes(16).toString('hex');
      await fsp.mkdir(directory, { recursive: true });
      const samplePath = path.join(directory, id + '.json');
      await fsp.writeFile(samplePath, JSON.stringify({ position: seconds, finished: false }));
      await (ctx.deps.launchPlayback || launchMpv)(file, samplePath, seconds);
      ctx.atomicWrite(lastFile, { ...selection, id });
      const samples = await fsp.readdir(directory).catch(() => []);
      for (const name of samples) {
        if (name !== id + '.json' && /^[a-f0-9]{32}\.json$/.test(name))
          await fsp.unlink(path.join(directory, name)).catch(() => {});
      }
      nextCache = null;
      ctx.json(res, 200, { ok: true });
      return true;
    } finally { starting = false; }
  };
}

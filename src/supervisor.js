import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {atomicWrite} from './config.js';
import {appendBoundedLog} from './bounded-log.js';
import {HEALTH_POLL_MS, heartbeatProblem, readHealthFile} from './watch-health.js';

export function restartDelay(failures) {
  return Math.min(300_000, 5000 * 2 ** Math.min(Math.max(0, failures - 1), 6));
}

// The supervisor only owns the child it spawned. It never kills a PID read
// from a JSON file, so stale metadata cannot terminate an unrelated process.
export async function supervise({configFile, entry, node = process.execPath,
  pollMs = HEALTH_POLL_MS, workerArgs, environment = {},
  clock = Date.now, spawnWorker = spawn, problem = heartbeatProblem,
  delayFor = restartDelay, resumeGapMs = 90_000, resumeGraceMs = 120_000} = {}) {
  const directory = path.join(path.dirname(configFile), 'data');
  fs.mkdirSync(directory, {recursive: true});
  const controlFile = path.join(directory, 'watch-control.json');
  const metadataFile = path.join(directory, 'supervisor.json');
  const lockFile = path.join(directory, 'supervisor.lock');
  const control = readHealthFile(controlFile);
  if (!control?.enabled || typeof control.runId !== 'string') return;
  let descriptor;
  try { descriptor = fs.openSync(lockFile, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
    if (pid > 0) {
      try { process.kill(pid, 0); return; }
      catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
    } else if (clock() - fs.statSync(lockFile).mtimeMs < 30_000) return;
    fs.unlinkSync(lockFile);
    descriptor = fs.openSync(lockFile, 'wx');
  }
  fs.writeFileSync(descriptor, String(process.pid));
  fs.closeSync(descriptor);

  const runId = control.runId;
  let child = null, failures = 0, restarts = 0, nextStartAt = 0;
  let stopped = false, startingAt = 0, session = '', reason = '', graceUntil = 0;
  let lastTick = clock(), ticking = false, finish, restartTimer;
  const done = new Promise(resolve => { finish = resolve; });
  const enabled = () => {
    const current = readHealthFile(controlFile);
    return current?.enabled === true && current.runId === runId;
  };
  const log = message => {
    try { appendBoundedLog(path.join(directory, 'supervisor.log'),
      `${new Date(clock()).toISOString()} ${message}\n`, {maxBytes: 256 * 1024, keepBytes: 128 * 1024}); }
    catch {} // Diagnostics must not interrupt supervision.
  };
  const publish = () => {
    if(child?.pid)try { atomicWrite(path.join(directory, 'background.json'), {
      pid: child.pid, supervisorPid: process.pid, session, logMode: 'bounded',
      startedAt: new Date(startingAt).toISOString()
    }); } catch {} // Runtime metadata is advisory; retry without killing a healthy child.
    try { atomicWrite(metadataFile, {
      pid: process.pid, runId, workerPid: child?.pid || null, at: clock(),
      restartCount: Math.max(0, restarts - 1), nextStartAt, reason, state: child ? 'watching' : 'restarting'
    }); } catch {} // A transient Windows file lock is retried on the next poll.
  };
  const terminate = async () => {
    const current = child;
    if (!current) return;
    child = null;
    if (!current.pid) return;
    await new Promise(resolve => {
      if (current.exitCode !== null || current.signalCode) return resolve();
      const timer = setTimeout(() => { current.kill('SIGKILL'); }, 3000);
      current.once('exit', () => { clearTimeout(timer); resolve(); });
      current.kill();
    });
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearTimeout(restartTimer);
    watcher.close();
    await terminate();
    try {
      const metadata = readHealthFile(metadataFile);
      if (metadata?.runId === runId) fs.unlinkSync(metadataFile);
    } catch {}
    try { fs.unlinkSync(lockFile); } catch {}
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    finish();
  };
  const schedule = failure => {
    failures++;
    reason = failure;
    nextStartAt = clock() + delayFor(failures);
    log(`后台异常 (${failure})，将在 ${Math.ceil((nextStartAt - clock()) / 1000)} 秒后重试。`);
    publish();
    clearTimeout(restartTimer);
    restartTimer = setTimeout(tick, Math.max(1, nextStartAt - clock()));
  };
  const tick = async () => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      if (!enabled()) { await stop(); return; }
      const now = clock();
      if (now - lastTick > resumeGapMs) graceUntil = now + resumeGraceMs;
      lastTick = now;
      if (child) {
        let beat;
        try { beat = readHealthFile(path.join(directory, 'watch-heartbeat.json')); } catch {}
        const failure = problem(beat, {pid: child.pid, session, startedAt: startingAt, now, graceUntil});
        if (failure) { await terminate(); if (!stopped && enabled()) schedule(failure); }
        else if (now - startingAt > 10 * 60_000) failures = 0;
      } else if (now >= nextStartAt && enabled()) {
        session = randomBytes(12).toString('hex');
        startingAt = now;
        const current = spawnWorker(node, workerArgs || [entry, 'watch', '--background-log', '--config', configFile], {
          cwd: path.dirname(configFile), windowsHide: true, stdio: 'ignore',
          env: {...process.env, ...environment, ANIBT_WATCH_SESSION: session}
        });
        child = current;
        current.once('error', () => {
          if (child === current) { child = null; if (!stopped) schedule('launch-failed'); }
        });
        current.once('exit', () => {
          if (child === current) { child = null; if (!stopped) schedule('process-exited'); }
        });
        if (!enabled() || stopped) { await terminate(); return; }
        restarts++;
        reason = '';
        nextStartAt = 0;
        publish();
      }
      if (!stopped) publish();
    } catch {
      // Fail closed on an unreadable stop/control file.
      await stop();
    } finally { ticking = false; }
  };
  const timer = setInterval(tick, pollMs);
  const watcher = fs.watch(directory, (_event, name) => {
    if (String(name) === 'watch-control.json') void tick();
  });
  watcher.on('error', stop);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await tick();
  await done;
}

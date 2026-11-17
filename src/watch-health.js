import fs from 'node:fs';
import path from 'node:path';
import {atomicWrite} from './config.js';

export const HEALTH_POLL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 120_000;
export const WORK_TIMEOUT_MS = 15 * 60_000;

export function readHealthFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function heartbeatProblem(beat, {pid, session, startedAt, now, graceUntil = 0,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS, workTimeoutMs = WORK_TIMEOUT_MS}) {
  if (now < graceUntil || now - startedAt < heartbeatTimeoutMs) return '';
  if (!beat || beat.pid !== pid || beat.session !== session ||
      !Number.isFinite(beat.at) || now - beat.at > heartbeatTimeoutMs) return 'heartbeat-timeout';
  const deadline = beat.phase === 'waiting' ? beat.waitUntil : beat.progressAt;
  if (!Number.isFinite(deadline) || now - deadline > workTimeoutMs) return 'work-timeout';
  return '';
}

export function createWatchHeartbeat(configFile, session, {intervalMs = HEALTH_POLL_MS} = {}) {
  if (!session) return {update() {}, close() {}};
  const file = path.join(path.dirname(configFile), 'data/watch-heartbeat.json');
  let state = {pid: process.pid, session, phase: 'starting', progressAt: Date.now(), waitUntil: 0};
  const flush = () => atomicWrite(file, {...state, at: Date.now()});
  const timer = setInterval(() => { try { flush(); } catch {} }, intervalMs);
  timer.unref();
  return {
    update(phase, patch = {}) {
      state = {...state, phase, progressAt: Date.now(), ...patch};
      flush();
    },
    close() { clearInterval(timer); }
  };
}

export function watchHealthStatus(configFile, {now = Date.now(), alive = pid => {
  try { if (!(pid > 0)) return false; process.kill(pid, 0); return true; } catch { return false; }
}} = {}) {
  const directory = path.join(path.dirname(configFile), 'data');
  const read = name => { try { return readHealthFile(path.join(directory, name)); } catch { return null; } };
  const worker = read('background.json'), guardian = read('supervisor.json'), control = read('watch-control.json');
  const workerRunning = alive(Number(worker?.pid));
  const supervised = control?.enabled === true && guardian?.runId === control.runId && alive(Number(guardian?.pid));
  const beat = read('watch-heartbeat.json');
  const heartbeatAt = beat && worker && beat.pid === worker.pid && beat.session === worker.session ? beat.at : 0;
  return {
    running: workerRunning || supervised, pid: workerRunning ? worker.pid : null,
    workerRunning, supervised, restarting: supervised && !workerRunning,
    heartbeatAt, heartbeatHealthy: !!heartbeatAt && now - heartbeatAt <= HEARTBEAT_TIMEOUT_MS,
    restartCount: supervised ? guardian.restartCount : 0,
    nextStartAt: supervised ? guardian.nextStartAt : 0
  };
}

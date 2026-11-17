import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {atomicWrite} from '../src/config.js';
import {heartbeatProblem, watchHealthStatus} from '../src/watch-health.js';
import {restartDelay} from '../src/supervisor.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('an installation without background metadata reports paused safely', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-no-heartbeat-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const status=watchHealthStatus(path.join(root,'config.json'));
  assert.equal(status.running,false);
  assert.equal(status.supervised,false);
  assert.equal(status.heartbeatAt,0);
});
async function until(check, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await pause(20); }
  assert.fail('Timed out waiting for supervisor');
}

test('health distinguishes idle/offline retries, stopped heartbeats, stalled work and resume grace', () => {
  const now = 2_000_000, context = {pid: 123, session: 'current', now, startedAt: 0};
  const beat = {pid: 123, session: 'current', at: now, progressAt: now, phase: 'checking'};
  assert.equal(heartbeatProblem(beat, context), '');
  assert.equal(heartbeatProblem({...beat, at: now - 121_000}, context), 'heartbeat-timeout');
  assert.equal(heartbeatProblem({...beat, session: 'old'}, context), 'heartbeat-timeout');
  assert.equal(heartbeatProblem({...beat, progressAt: now - 901_000}, context), 'work-timeout');
  assert.equal(heartbeatProblem({...beat, phase: 'waiting', waitUntil: now + 3600_000, progressAt: 0}, context), '');
  assert.equal(heartbeatProblem(null, {...context, graceUntil: now + 120_000}), '');
  assert.equal(heartbeatProblem(null, {...context, startedAt: now - 1000}), '');
  assert.deepEqual([1,2,3,9,100].map(restartDelay), [5000,10000,20000,300000,300000]);
});

async function fixture(t, mode = 'normal', failPublication = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anibt-supervisor-'));
  fs.mkdirSync(path.join(root, 'data'));
  const control = path.join(root, 'data/watch-control.json');
  atomicWrite(control, {enabled: true, runId: 'test'});
  const worker = path.join(root, 'worker.mjs');
  fs.writeFileSync(worker, `
    import fs from 'node:fs';
    const at=Date.now();
    const file=${JSON.stringify(path.join(root, 'data/watch-heartbeat.json'))};
    const mode=${JSON.stringify(mode)};
    const tick=()=>{
      if(mode==='stale' && Date.now()-at>60)return;
      const beat={pid:process.pid,session:process.env.ANIBT_WATCH_SESSION,at:Date.now(),
        phase:mode==='stuck'?'checking':'waiting',progressAt:at,waitUntil:Date.now()+1000};
      try{fs.writeFileSync(file+'.tmp',JSON.stringify(beat));fs.renameSync(file+'.tmp',file);}catch{}
    }; tick();setInterval(tick,20);
  `);
  const launcher = path.join(root, 'guardian.mjs');
  const supervisorUrl = pathToFileURL(fileURLToPath(new URL('../src/supervisor.js', import.meta.url))).href;
  const healthUrl = new URL('../src/watch-health.js', import.meta.url).href;
  fs.writeFileSync(launcher, `
    import fs from 'node:fs';
    import {supervise} from ${JSON.stringify(supervisorUrl)};
    import {heartbeatProblem} from ${JSON.stringify(healthUrl)};
    if(${JSON.stringify(failPublication)}){
      const rename=fs.renameSync,started=Date.now();let first=true;
      fs.renameSync=(source,target)=>{
        if(${JSON.stringify(failPublication)}==='background'&&String(target).endsWith('background.json')&&first){first=false;const error=Error('one metadata EPERM');error.code='EPERM';throw error;}
        if(${JSON.stringify(failPublication)}!=='background'&&String(target).endsWith('supervisor.json')){
          if(!first&&Date.now()-started<700){const error=Error('simulated Windows sharing conflict');error.code='EPERM';throw error;}
          first=false;
        }
        return rename(source,target);
      };
    }
    await supervise({configFile:${JSON.stringify(path.join(root,'config.json'))},
      entry:${JSON.stringify(worker)},workerArgs:[${JSON.stringify(worker)}],pollMs:20,
      delayFor:()=>30,problem:(beat,ctx)=>heartbeatProblem(beat,{...ctx,heartbeatTimeoutMs:1000,workTimeoutMs:2000})});
  `);
  const guardian = spawn(process.execPath, [launcher], {stdio: 'ignore', windowsHide: true});
  const metadata = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'data/supervisor.json'))); } catch { return null; } };
  const snapshot = async (matches = row => !!row.workerPid) => {
    let result;
    await until(() => {
      const row=metadata();
      if(row&&matches(row)){result=row;return true;}
      return false;
    });
    return result;
  };
  const stopped = () => guardian.exitCode !== null || guardian.signalCode;
  t.after(async () => {
    atomicWrite(control, {enabled: false, runId: 'paused'});
    await until(stopped);
    fs.rmSync(root, {recursive: true, force: true});
  });
  await snapshot();
  return {root, control, guardian, metadata, snapshot, stopped};
}

test('real supervisor recovers a killed worker then honors pause without spawning again', async t => {
  const f = await fixture(t);
  const first = (await f.snapshot()).workerPid;
  process.kill(first, 'SIGKILL');
  const replacement=await f.snapshot(row=>row.workerPid&&row.workerPid!==first);
  const second = replacement.workerPid;
  assert.equal(replacement.restartCount, 1);
  await pause(600);
  assert.equal((await f.snapshot()).workerPid, second, 'idle retrying workers should remain alive');
  const status = watchHealthStatus(path.join(f.root,'config.json'));
  assert.equal(status.supervised, true);
  assert.equal(status.heartbeatHealthy, true);
  atomicWrite(f.control, {enabled: false, runId: 'paused'});
  await until(f.stopped);
  await pause(100);
  assert.throws(() => process.kill(second, 0));
  assert.equal(watchHealthStatus(path.join(f.root,'config.json')).running, false);
});

for (const mode of ['stale', 'stuck']) {
  test(`real supervisor recovers a worker with ${mode} health`, async t => {
    const f = await fixture(t, mode);
    const first = (await f.snapshot()).workerPid;
    const replacement=await f.snapshot(row=>row.workerPid&&row.workerPid!==first);
    assert.equal(replacement.restartCount, 1);
    assert.match(fs.readFileSync(path.join(f.root,'data/supervisor.log'),'utf8'),
      mode==='stale'?/heartbeat-timeout/:/work-timeout/);
  });
}

test('a second guardian cannot supervise the same directory concurrently', async t => {
  const f = await fixture(t);
  const second = spawn(process.execPath, [path.join(f.root,'guardian.mjs')], {stdio:'ignore',windowsHide:true});
  await until(() => second.exitCode !== null);
  assert.equal(second.exitCode, 0);
  assert.equal((await f.snapshot()).pid, f.guardian.pid);
});

test('temporary publication failures do not terminate supervision or replace a healthy worker', async t => {
  const f=await fixture(t,'normal',true);
  const initial=await f.snapshot();
  await pause(900);
  const current=await f.snapshot(row=>row.at>initial.at);
  assert.equal(current.workerPid,initial.workerPid);
  assert.equal(current.restartCount,0);
  assert.equal(f.guardian.exitCode,null);
});

test('background publication EPERM is retried without terminating or replacing its spawned worker',async t=>{const f=await fixture(t,'normal','background');const first=await f.snapshot();await pause(200);const current=await f.snapshot(row=>row.at>first.at);const runtime=JSON.parse(fs.readFileSync(path.join(f.root,'data/background.json')));assert.equal(runtime.pid,first.workerPid);assert.equal(current.workerPid,first.workerPid);assert.equal(current.restartCount,0);assert.equal(f.guardian.exitCode,null);});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ensureQbRunning,isLocalQb,launchQbExecutable} from '../src/qb-launch.js';
import {createCompletionMonitor} from '../src/notifications.js';
import {defaults,clone,atomicWrite} from '../src/config.js';
import {emptyState} from '../src/runner.js';

test('qB launch only runs for a closed local download client and waits for Web UI',async()=>{
 const c=clone(defaults);let launches=0,probes=0;
 const deps={probe:async()=>++probes>2,findExecutable:()=>'/qbittorrent.exe',launch:async()=>{launches++;},sleep:async()=>{}};
 await ensureQbRunning(c,deps);assert.equal(launches,1);
 c.qb.autoStart=false;probes=0;await ensureQbRunning(c,deps);assert.equal(probes,0);
 c.qb.autoStart=true;c.qb.url='http://192.168.1.4:8080';await ensureQbRunning(c,deps);assert.equal(probes,0);
 c.qb.url='http://127.0.0.1:8081';await ensureQbRunning(c,{...deps,probe:async()=>true});assert.equal(launches,1);
 assert.equal(isLocalQb('http://[::1]:8081'),true);
 await assert.rejects(ensureQbRunning(c,{...deps,probe:async()=>false,findExecutable:()=>''}),/未找到/);
 await assert.rejects(ensureQbRunning(c,{...deps,probe:async()=>false,attempts:2}),/启动提示和 Web UI/);
});

test('completion tracking stays quiet on old completions and notifies once after an observed download finishes',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-completion-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),c=clone(defaults),state=emptyState();const old='a'.repeat(40),active='b'.repeat(40),manual='c'.repeat(40);let now=Date.now();
 state.done={old:{hash:old,status:'added',at:new Date(now-86400000).toISOString()},active:{hash:active,status:'added',at:new Date(now-86400000).toISOString()}};
 atomicWrite(path.join(dir,'data/state.json'),state);let progress=.5,calls=[];
 const qb={login:async()=>{},list:async()=>[{hash:old,progress:1,name:'旧任务'},{hash:active,progress,name:'新完成'},{hash:manual,progress:1,name:'搜索添加'}],logout:async()=>{}};
 const deps={showTaskbar:async()=>{},qb,reachable:async()=>true,notify:async(title,hash)=>calls.push(hash),now:()=>now,log:()=>{}};
 const monitor=createCompletionMonitor(file,deps);await monitor.poll(c);assert.deepEqual(calls,[]);
 progress=1;now+=30000;await monitor.poll(c);assert.deepEqual(calls,[active]);await monitor.poll(c);assert.deepEqual(calls,[active]);
 atomicWrite(path.join(dir,'data/manual-downloads.json'),{[manual]:{hash:manual,status:'added',at:new Date(now).toISOString()}});
 await monitor.poll(c);assert.deepEqual(calls,[active,manual]);
 const restarted=createCompletionMonitor(file,deps);await restarted.poll(c);assert.equal(calls.length,2);
 c.notifications.enabled=false;c.notifications.openOnDownload=false;let probe=0;await createCompletionMonitor(file,{...deps,reachable:async()=>{probe++;return true;}}).poll(c);assert.equal(probe,0);
});

test('completion monitor never launches qB and retries failed notification delivery',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-completion-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const now=Date.now(),hash='d'.repeat(40),state=emptyState();state.done={test:{hash,status:'added',at:new Date(now).toISOString()}};atomicWrite(path.join(dir,'data/state.json'),state);
 let queries=0,calls=0;const qb={connectForDownload:async()=>{throw new Error('must not launch');},login:async()=>queries++,list:async()=>[{hash,name:'完成',progress:1}],logout:async()=>{}};
 const file=path.join(dir,'config.json'),c=clone(defaults);await createCompletionMonitor(file,{showTaskbar:async()=>{},qb,reachable:async()=>false}).poll(c);assert.equal(queries,0);
 const monitor=createCompletionMonitor(file,{showTaskbar:async()=>{},qb,reachable:async()=>true,notify:async()=>{if(++calls===1)throw new Error('temporary');},log:()=>{}});await monitor.poll(c);await monitor.poll(c);await monitor.poll(c);assert.equal(calls,2);
});

test('new automatic downloads request taskbar attention once per batch without manual, paused or historical tasks',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-taskbar-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'config.json'),c=clone(defaults),state=emptyState(),now=Date.now();
 const hashes=['a','b','c','d','e'].map(x=>x.repeat(40));for(const [i,hash] of hashes.entries())state.done[i]={hash,status:'added',paused:i===2,at:new Date(i===4?now-86400000:now).toISOString()};delete state.done[3];
 atomicWrite(path.join(dir,'data/state.json'),state);atomicWrite(path.join(dir,'data/manual-downloads.json'),{manual:{hash:hashes[3],status:'added',kind:'manual',at:new Date(now).toISOString()}});
 let started=false,launches=0;const qb={login:async()=>{},list:async()=>hashes.map((hash,i)=>({hash,progress:started||i===4?.1:0,state:started?'downloading':'metaDL',name:'测试'})),logout:async()=>{}};
 const monitor=createCompletionMonitor(file,{qb,reachable:async()=>true,showTaskbar:async p=>{assert.equal(p,file);launches++;},log:()=>{}});await monitor.poll(c);assert.equal(launches,0);started=true;await monitor.poll(c);assert.equal(launches,1);await monitor.poll(c);assert.equal(launches,1);
 const tasks=JSON.parse(fs.readFileSync(path.join(dir,'data/completions.json'))).tasks;assert.ok(tasks[hashes[0]].taskbarShownAt);assert.ok(tasks[hashes[1]].taskbarShownAt);assert.equal(tasks[hashes[2]].taskbarShownAt,undefined);assert.equal(tasks[hashes[3]].taskbarShownAt,undefined);
});

test('Windows qB launch uses supported no-splash option and native minimized window instead of hidden unknown CLI flags',async()=>{
 const {EventEmitter}=await import('node:events'),{PassThrough}=await import('node:stream');let captured,payload='';const fakeSpawn=(exe,args,options)=>{captured={exe,args,options};const child=new EventEmitter();child.stderr=new PassThrough();child.stdin=new PassThrough();child.stdin.on('data',b=>payload+=b);child.stdin.on('finish',()=>queueMicrotask(()=>child.emit('exit',0)));return child;};const exe=String.raw`D:\Apps With Spaces\qBittorrent\qbittorrent.exe`;await launchQbExecutable(exe,{platform:'win32',spawnProcess:fakeSpawn});assert.equal(captured.exe,'powershell.exe');assert.equal(captured.options.windowsHide,true);const script=captured.args.at(-1);assert.ok(script.includes("--no-splash"));assert.ok(script.includes('-WindowStyle Minimized'));assert.ok(!script.includes('--minimized'));assert.equal(JSON.parse(payload),exe);
});
test('qB readiness wait tolerates a slower startup without submitting any job before readiness',async()=>{const c=clone(defaults);let probes=0,launches=0;await ensureQbRunning(c,{probe:async()=>++probes>35,findExecutable:()=>'/qbittorrent.exe',launch:async()=>launches++,sleep:async()=>{}});assert.equal(launches,1);assert.ok(probes>35);});

test('automatic new release launches a closed qB through the download connector before adding, while first baseline stays quiet',async t=>{
 const {runOnce}=await import('../src/runner.js');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-auto-launch-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const config=clone(defaults);config.rssUrl='https://anibt.net/rss/subscriptions.xml?key=auto-launch-test';const file=path.join(dir,'config.json');const release=n=>({id:'new-'+n,title:'测试番 '+n,animeTitle:'测试番',bgmId:'123',episode:String(n),episodeKey:'test:'+n+':v1',languages:['CHS'],infoHash:String(n).repeat(40),publishedAt:new Date().toISOString()});let items=[release(1)],running=false,ready=false,launches=0,connectorCalls=0;const added=[];
 const qb={connectForDownload:async()=>{connectorCalls++;await ensureQbRunning(config,{probe:async()=>{if(running)ready=true;return ready;},findExecutable:()=>'/qbittorrent.exe',launch:async()=>{launches++;running=true;},sleep:async()=>{}});},login:async()=>assert.fail('automatic flow must use the download connector'),ensureCategory:async()=>assert.equal(ready,true),list:async()=>{assert.equal(ready,true);return[];},add:async i=>{assert.equal(ready,true);added.push(i.id);},logout:async()=>{}};
 const deps={qb,fetchFeed:async()=>items,log:()=>{}};await runOnce(config,file,{},deps);assert.equal(connectorCalls,0);assert.equal(launches,0);items.push(release(2));let report=await runOnce(config,file,{},deps);assert.equal(report.added,1);assert.equal(launches,1);assert.deepEqual(added,['new-2']);running=false;ready=false;items.push({...release(3),languages:['CHT']});report=await runOnce(config,file,{},deps);assert.equal(report.added,0);assert.equal(launches,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {atomicWrite,clone,defaults} from '../src/config.js';
import {beijingMonth,readMaintenance,setMonthlyCleanup,runMonthlyCleanup,cleanupHistory,afterCleanup,maintenanceStatus} from '../src/maintenance.js';
import {notificationHistory} from '../src/notification-history.js';
import {overviewDetails} from '../src/overview-details.js';
import {runOnce,emptyState} from '../src/runner.js';
import {sourceKey} from '../src/feed.js';

function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-maintenance-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('monthly cleanup uses the Beijing calendar, catches missed months once, and leaves the download ledger untouched',t=>{
 const dir=fixture(t),nov=Date.parse('2026-11-04T00:00:00Z');assert.equal(readMaintenance(dir).enabled,false);assert.equal(beijingMonth(Date.parse('2026-11-30T16:00:00Z')),'2026-12');
 setMonthlyCleanup(dir,true,nov);assert.equal(maintenanceStatus(dir,nov).nextAt,'2026-11-30T16:00:00.000Z');assert.equal(runMonthlyCleanup(dir,Date.parse('2026-11-30T15:59:59Z')).ran,false);
 const protectedFiles={'state.json':{done:{old:{status:'added',title:'旧记录',at:'2026-10-01T00:00:00Z'}},episodes:{one:'done'},pending:{retry:{item:{id:'retry'}}},sources:{baseline:['old']}},'manual-downloads.json':{keep:{hash:'a'.repeat(40)}},'tracking.json':{watched:5},'anibt-control.json':{blocked:{}},'completions.json':{version:1,tasks:{keep:{completed:true,notifiedAt:'2026-10-01T00:00:00Z'}}}};
 for(const [file,data]of Object.entries(protectedFiles))atomicWrite(path.join(dir,file),data);const before=Object.fromEntries(Object.keys(protectedFiles).map(file=>[file,fs.readFileSync(path.join(dir,file),'utf8')]));
 atomicWrite(path.join(dir,'history-display.json'),{hidden:['old']});atomicWrite(path.join(dir,'completion-history.json'),[{title:'旧通知'}]);atomicWrite(path.join(dir,'notification-read.json'),{old:'read'});atomicWrite(path.join(dir,'alerts.json'),{items:[{id:'old'}],active:{disk:'old'},observations:{keep:{since:100}}});
 const stale=path.join(dir,'state.json.999.tmp');fs.writeFileSync(stale,'stale');fs.utimesSync(stale,new Date('2026-01-01'),new Date('2026-01-01'));const now=Date.parse('2026-11-30T16:00:00Z');const result=runMonthlyCleanup(dir,now);assert.equal(result.ran,true);assert.equal(result.backupCreated,false);assert.equal(result.removedTemps,1);assert.equal(fs.existsSync(stale),false);assert.equal(runMonthlyCleanup(dir,now+1000).ran,false);
 for(const [file,value]of Object.entries(before))assert.equal(fs.readFileSync(path.join(dir,file),'utf8'),value);const alerts=JSON.parse(fs.readFileSync(path.join(dir,'alerts.json')));assert.deepEqual(alerts.items,[]);assert.deepEqual(alerts.active,{disk:'old'});assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'history-display.json'))),{hidden:[]});assert.ok(!fs.readdirSync(dir).some(n=>/backup|\.bak$/.test(n)));
 assert.equal(runMonthlyCleanup(dir,Date.parse('2027-03-10T00:00:00Z')).ran,true);assert.equal(runMonthlyCleanup(dir,Date.parse('2027-03-10T01:00:00Z')).ran,false);
});
test('cleanup removes old history and notifications from views, starts fresh counts, and never reveals the cleared period',t=>{
 const dir=fixture(t),now=Date.parse('2026-11-04T00:00:00Z'),old='2026-11-01T00:00:00Z',fresh='2026-11-05T00:00:00Z',hash='a'.repeat(40);
 atomicWrite(path.join(dir,'completions.json'),{version:1,tasks:{[hash]:{title:'已完成',completedAt:old,notifiedAt:old,completed:true}}});assert.equal(notificationHistory(dir).items.length,1);cleanupHistory(dir,{now});assert.equal(notificationHistory(dir).items.length,0);
 const maintenance=readMaintenance(dir),config=clone(defaults);config.rssUrl='https://anibt.net/rss/subscriptions.xml?key=fixture';const state={done:{old:{status:'added',title:'旧自动',at:old},fresh:{status:'added',title:'新自动',at:fresh}},pending:{}};
 assert.equal(afterCleanup({at:old},maintenance),false);assert.equal(afterCleanup({at:fresh},maintenance),true);assert.equal(overviewDetails(state,config,{kind:'added'},{},maintenance).total,1);
 atomicWrite(path.join(dir,'history-display.json'),{hidden:[]});assert.equal(afterCleanup({at:old},readMaintenance(dir)),false);setMonthlyCleanup(dir,false,now);assert.equal(runMonthlyCleanup(dir,Date.parse('2027-01-01')).ran,false);
});
test('cleanup respects a live maintenance lock and recovers an abandoned lock without creating backups',t=>{
 const dir=fixture(t);atomicWrite(path.join(dir,'maintenance.json'),{version:1,enabled:true,checkedMonth:'2026-10',cutoff:'',lastRunAt:''});fs.writeFileSync(path.join(dir,'maintenance.lock'),String(process.pid));assert.equal(cleanupHistory(dir).ran,false);assert.equal(readMaintenance(dir).cutoff,'');fs.writeFileSync(path.join(dir,'maintenance.lock'),'2147483647');assert.equal(cleanupHistory(dir).ran,true);assert.equal(fs.existsSync(path.join(dir,'maintenance.lock')),false);
});
test('a monthly reset never makes the watcher download an already handled episode again',async t=>{
 const dir=fixture(t),config=clone(defaults),configFile=path.join(dir,'config.json');config.rssUrl='https://anibt.net/rss/subscriptions.xml?key=fixture';config.stateFile='state.json';const item={id:'old',title:'旧番 05 CHS',animeTitle:'旧番',bgmId:'123',episode:'5',episodeKey:'123:5:v1',languages:['CHS'],subtitles:[],infoHash:'a'.repeat(40)},state=emptyState();state.sources[sourceKey(config.rssUrl)]={baselineIds:[]};state.done.old={title:item.title,status:'added',at:'2026-10-01T00:00:00Z'};state.episodes[item.episodeKey]=item.id;atomicWrite(path.join(dir,'state.json'),state);cleanupHistory(dir);
 const report=await runOnce(config,configFile,{}, {fetchFeed:async()=>[item],qb:{login:async()=>{assert.fail('must not contact qB for an old episode');}},log:()=>{}});assert.equal(report.added,0);assert.equal(report.existing,1);
});

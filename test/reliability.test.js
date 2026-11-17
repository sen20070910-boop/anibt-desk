import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {clone,defaults,atomicWrite} from '../src/config.js';
import {runOnce,emptyState,loadState,statePath} from '../src/runner.js';
import {sourceKey} from '../src/feed.js';
import {episodeRecorded} from '../src/episode-dedupe.js';
import {makeApplication} from '../src/gui-server.js';
import {watchedOperations} from '../src/watched-operations.js';
import {accountKeyHash} from '../src/anibt-control.js';

const item=(id='one',bgmId='123',animeTitle='旧名',episode='1')=>({id,bgmId,animeTitle,episode,title:`[Test] ${animeTitle} ${episode}`,version:'v1',languages:['CHS'],subtitles:[],groupName:'Test',infoHash:(id==='one'?'a':'b').repeat(40),magnet:'magnet:?xt=urn:btih:'+('a'.repeat(40)),publishedAt:new Date().toISOString()});
function workspace(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-reliable-')),config=clone(defaults),file=path.join(root,'config.json');config.rssUrl='https://anibt.net/rss/subscriptions.xml?key=isolated';config.firstRun='download';atomicWrite(file,config);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return{root,config,file};}
function downloader(added=[]){return{login:async()=>{},logout:async()=>{},ensureCategory:async()=>{},list:async()=>[],add:async row=>{added.push(row);}};}
const offline=async()=>{throw Error('RSS offline');};

test('offline RSS processes complete persisted magnets, previews the same jobs, and separately waits for source-only jobs',async t=>{
  const f=workspace(t),s=emptyState(),source=sourceKey(f.config.rssUrl),a={...item(),torrentUrl:'https://anibt.net/api/torrent/old.torrent'},b={...item('two','456','种子待获取'),infoHash:'',magnet:'',torrentUrl:'https://anibt.net/api/torrent/needs-source.torrent'};
  s.sources[source]={baselineIds:[]};s.pending.one={source,item:a};s.pending.two={source,item:b};atomicWrite(statePath(f.config,f.file),s);
  const added=[],deps={fetchFeed:offline,qb:downloader(added),log:()=>{}};
  const preview=await runOnce(f.config,f.file,{dryRun:true},deps);assert.equal(preview.planned,1);assert.equal(preview.waiting,1);assert.equal(added.length,0);
  const report=await runOnce(f.config,f.file,{},deps);assert.equal(report.added,1);assert.equal(report.waiting,1);assert.ok(report.feedError);assert.equal(added[0].torrentUrl,'');assert.match(added[0].magnet,/magnet:/);
  const after=loadState(statePath(f.config,f.file));assert.ok(after.pending.two);assert.match(after.pending.two.lastError,/等待来源恢复/);assert.ok(!after.pending.one);
  assert.ok(!fs.existsSync(path.join(f.root,'data/rss-continuity.json')),'failed discovery must not be marked successful');
});

test('offline persisted work rechecks current rules, website unsubscription, watched flags and source scope',async t=>{
  const f=workspace(t),s=emptyState(),source=sourceKey(f.config.rssUrl);
  const rows=[item('one','123','已看'),item('blocked','456','退订'),{...item('language','789','语言改变'),languages:['CHT']},item('old-source','987','旧来源')];
  for(const row of rows)s.pending[row.id]={source:row.id==='old-source'?'other':source,item:row};atomicWrite(statePath(f.config,f.file),s);
  atomicWrite(path.join(f.root,'data/tracking.json'),{'bgm:123':{episodeStates:{1:true}}});atomicWrite(path.join(f.root,'data/anibt-control.json'),{keyHash:accountKeyHash(f.config),blocked:{456:true},baseline:{}});
  const qb=downloader();qb.login=async()=>assert.fail('no eligible work should contact qB');const preview=await runOnce(f.config,f.file,{dryRun:true},{fetchFeed:offline,qb,log:()=>{}});assert.equal(preview.planned,0);const result=await runOnce(f.config,f.file,{}, {fetchFeed:offline,qb,log:()=>{}});assert.equal(result.added,0);
});

test('subject identity deduplicates renamed releases but separates different subjects with the same title',async t=>{
  const f=workspace(t),added=[],qb=downloader(added),first=item();
  await runOnce(f.config,f.file,{}, {fetchFeed:async()=>[first],qb,log:()=>{}});
  await runOnce(f.config,f.file,{}, {fetchFeed:async()=>[item('renamed','123','完全不同译名')],qb,log:()=>{}});assert.equal(added.length,1);
  await runOnce(f.config,f.file,{}, {fetchFeed:async()=>[item('different','456','旧名')],qb,log:()=>{}});assert.equal(added.length,2);assert.equal(added[1].bgmId,'456');
  const state=loadState(statePath(f.config,f.file));assert.ok(state.episodes['bgm:123:1:v1']);assert.ok(state.episodes['bgm:456:1:v1']);
});

test('legacy identity migration uses historical IDs and manual history, retains unknown tombstones, and does not reset priority clocks',t=>{
  const f=workspace(t),s=emptyState(),old=item(),source=sourceKey(f.config.rssUrl);s.done.old={...old,status:'added'};s.episodes['旧名:1:v1']='old';s.episodes['失去历史:1:v1']='missing';s.episodes['手动番:1:v1']='old-public-id';s.pending.renamed={source,item:{...old,episodeKey:'旧名:1:v1'}};s.prioritySince={[source+':旧名:1:v1']:12345};
  atomicWrite(statePath(f.config,f.file),s);const before=fs.readFileSync(statePath(f.config,f.file),'utf8');const state=loadState(statePath(f.config,f.file),f.config,[{...item('manual','777','手动番'),status:'added',hash:'c'.repeat(40)}]);
  assert.ok(episodeRecorded(state,item('alias','123','另一个译名')));assert.ok(!episodeRecorded(state,item('other','456','旧名')));assert.ok(episodeRecorded(state,item('lost','999','失去历史')));assert.ok(episodeRecorded(state,item('manual-alias','777','手动译名')));assert.ok(!episodeRecorded(state,item('manual-other','888','手动番')));assert.equal(state.prioritySince[source+':bgm:123:1:v1'],12345);assert.equal(fs.readFileSync(statePath(f.config,f.file),'utf8'),before,'read projection must not rewrite the saved file');
});

async function serve(t,f,deps){const app=makeApplication({configFile:f.file,token:'test',deps:{fetchFeed:async()=>[item()],backgroundStatus:()=>({running:false}),...deps}}),server=http.createServer(app.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));return async(route,body)=>{const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/'+route,{method:body?'POST':'GET',headers:{'x-app-token':'test',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:res.status,data:await res.json()};};}
async function deletionFixture(t,scope,mode){
  const f=workspace(t),row=item(),folder=path.join(f.root,'video');fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'01.mkv'),'fixture');let active=[{hash:row.infoHash,name:row.title,save_path:f.root,content_path:folder}],deletes=0,fail=true;
  const qb={...downloader(),list:async()=>active,request:async(method,body)=>{if(method==='torrents/files')return{json:async()=>[{name:'video/01.mkv',size:7}]};assert.equal(method,'torrents/delete');assert.equal(body.get('deleteFiles'),'true');deletes++;active=[];if(mode==='lost-response')throw Error('response lost after remote commit');return{};}};
  const s=emptyState();s.done.old={...row,hash:row.infoHash,status:'added',at:new Date().toISOString()};s.pending.retry={item:row,source:sourceKey(f.config.rssUrl)};atomicWrite(statePath(f.config,f.file),s);
  const request=await serve(t,f,{episodeQb:qb,writeWatchedFile:(file,value)=>{if(fail&&((mode==='tracking'&&path.basename(file)==='tracking.json')||(mode==='state'&&file===statePath(f.config,f.file)))){const e=Error('injected EPERM');e.code='EPERM';throw e;}atomicWrite(file,value);}});
  const preview=await request('progress/'+scope+'/prepare',{key:'bgm:123',...(scope==='episode'?{episode:1,action:'watched'}:{})});assert.equal(preview.status,200);
  return{...f,qb,row,request,preview,folder,deletes:()=>deletes,active:()=>active,heal:()=>{fail=false;}};
}
for(const scope of ['episode','show'])for(const mode of ['tracking','state','lost-response'])test(`${scope} deletion survives ${mode} failure and restart without another delete or lost review`,async t=>{
  const f=await deletionFixture(t,scope,mode),response=await f.request('progress/'+scope+'/confirm',{id:f.preview.data.id,confirm:true});assert.equal(response.status,503);assert.match(response.data.error,mode==='lost-response'?/可能已执行/:/下载器已完成，本地记录待恢复/);assert.equal(f.deletes(),1);assert.equal(f.active().length,0);assert.ok(fs.existsSync(path.join(f.folder,'01.mkv')),'mock must never remove a real file');
  const operations=watchedOperations(f.file),pending=operations.pending();assert.equal(pending.length,1);assert.equal(pending[0].targets[0].files[0].name,'video/01.mkv');assert.equal(pending[0].status,mode==='lost-response'?'prepared':'downloader-complete');
  const candidate={...f.row,id:'new-release',version:'v2'};await runOnce(f.config,f.file,{}, {fetchFeed:async()=>[candidate],qb:{login:async()=>assert.fail('unsettled deletion must suppress redownload')},log:()=>{}});
  atomicWrite(path.join(f.root,'data/tracking.json'),{'bgm:123':{title:'旧名',bgmId:'123',personalReview:{score:9,text:'保留评论'}}});
  const restarted=await serve(t,f,{episodeQb:f.qb});let recovered=await restarted('progress/recover',{confirm:true});assert.equal(recovered.status,200);assert.equal(recovered.data.remaining.length,0);assert.equal(f.deletes(),1);
  const tracking=JSON.parse(fs.readFileSync(path.join(f.root,'data/tracking.json')));assert.equal(tracking['bgm:123'].episodeStates[1],true);assert.equal(tracking['bgm:123'].personalReview.text,'保留评论');if(scope==='show')assert.ok(tracking['bgm:123'].completedAt);assert.ok(!loadState(statePath(f.config,f.file)).pending.retry);assert.equal(operations.pending().length,0);
  recovered=await restarted('progress/recover',{confirm:true});assert.equal(recovered.data.restored,0);assert.equal(f.deletes(),1);
});

test('an unwritable intent journal prevents the delete request entirely',async t=>{
  const f=await deletionFixture(t,'episode','tracking');fs.writeFileSync(path.join(f.root,'data/watched-operations'),'not a directory');const r=await f.request('progress/episode/confirm',{id:f.preview.data.id,confirm:true});assert.match(r.data.error,/尚未向下载器发送/);assert.equal(f.deletes(),0);
});

test('restart verification never repeats a delete while any originally confirmed task remains',async t=>{
  const f=await deletionFixture(t,'episode','tracking'),op=watchedOperations(f.file).prepare({scope:'episode',key:'bgm:123',episode:1,title:'旧名',bgmId:'123',targets:[{hash:f.row.infoHash,savePath:f.root,files:[{name:'video/01.mkv'}]}]});const r=await f.request('progress/recover',{confirm:true});assert.equal(r.status,200);assert.equal(r.data.remaining[0].id,op.id);assert.equal(f.deletes(),0);assert.ok(!fs.existsSync(path.join(f.root,'data/tracking.json')));
});

test('a failed result journal publication is recovered from the saved intent and qB state',async t=>{
  const f=await deletionFixture(t,'episode','healthy'),rename=fs.renameSync;let writes=0,response;
  fs.renameSync=(source,target)=>{if(String(target).includes('watched-operations')&&++writes===2){const error=Error('injected result publication EPERM');error.code='EPERM';throw error;}return rename(source,target);};
  try{response=await f.request('progress/episode/confirm',{id:f.preview.data.id,confirm:true});}finally{fs.renameSync=rename;}
  assert.equal(response.status,503);assert.match(response.data.error,/下载器已完成/);assert.equal(f.deletes(),1);assert.equal(watchedOperations(f.file).pending()[0].status,'prepared');
  const restarted=await serve(t,f,{episodeQb:f.qb});const recovered=await restarted('progress/recover',{confirm:true});assert.equal(recovered.data.restored,1);assert.equal(f.deletes(),1);
});

test('opening status after restart recovers a completed operation without starting qB',async t=>{
  const f=await deletionFixture(t,'show','tracking');await f.request('progress/show/confirm',{id:f.preview.data.id,confirm:true});
  const restarted=await serve(t,f,{episodeQb:{login:async()=>assert.fail('completed operation only needs local replay')}});await restarted('status');
  for(let n=0;n<50&&watchedOperations(f.file).pending().length;n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(watchedOperations(f.file).pending().length,0);assert.ok(JSON.parse(fs.readFileSync(path.join(f.root,'data/tracking.json')))['bgm:123'].completedAt);assert.equal(f.deletes(),1);
});

test('a failure to flush the intent prevents an irreversible downloader request',async t=>{const f=await deletionFixture(t,'episode','healthy'),flush=fs.fsyncSync;fs.fsyncSync=()=>{throw Error('flush failed');};let response;try{response=await f.request('progress/episode/confirm',{id:f.preview.data.id,confirm:true});}finally{fs.fsyncSync=flush;}assert.match(response.data.error,/尚未向下载器发送/);assert.equal(f.deletes(),0);});

test('legacy index retains revision evidence when the old job omitted its version',t=>{const f=workspace(t),s=emptyState();s.done.old={...item(),version:undefined,status:'added'};s.episodes['旧名:1:v2']='old';atomicWrite(statePath(f.config,f.file),s);const migrated=loadState(statePath(f.config,f.file),f.config);assert.ok(episodeRecorded(migrated,{...item('alias','123','新译名'),version:'v2'}));assert.ok(!migrated.episodes['bgm:123:1:v1']);});

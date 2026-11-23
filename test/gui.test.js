import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { clone, defaults, atomicWrite } from '../src/config.js';
import { makeApplication, publicConfig, applyConfigPatch } from '../src/gui-server.js';
import { emptyState, statePath, loadState } from '../src/runner.js';
import { sourceKey as sourceKeyImported } from '../src/feed.js';
import { mergeGroupOptions } from '../src/groups.js';
import {QbClient} from '../src/qb.js';

const item={id:'release-test',title:'[Test] 测试番 01',animeTitle:'测试番',bgmId:'123',episode:'1',version:'v1',episodeKey:'测试番:1:v1',groupName:'Test',groupSlug:'test',languages:['CHS'],subtitles:['INTERNAL'],resolution:'1080p',infoHash:'a'.repeat(40),torrentUrl:'',publishedAt:new Date().toUTCString()};
async function fixture(t,deps={},options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-gui-'));const configFile=path.join(dir,'config.json');const c=clone(defaults);c.rssUrl='https://anibt.net/rss/subscriptions.xml?key=private-test-token';c.qb.password='secret-test-password';atomicWrite(configFile,c);
  const app=makeApplication({...options,configFile,token:'test-ui-session',deps:{fetchFeed:async()=>[item],backgroundStatus:()=>({running:false,autostart:false}),...deps}});const server=http.createServer(app.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));while(server.address().port<11000){await new Promise(r=>server.close(r));await new Promise(r=>server.listen(0,'127.0.0.1',r));}const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const request=async(route,body,headers={})=>{const response=await fetch(base+'/api/'+route,{headers:{'X-App-Token':app.token,...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{method:'POST',body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json()};};
  return{dir,c,configFile,base,request};
}

test('download cards show managed qB tasks newest first, with undated tasks last', async t => {
  const tasks = [
    { name: '旧任务', added_on: 1700000000, state: 'stalledUP' },
    { name: '添加时间未知', added_on: -1, state: 'downloading' },
    { name: '新任务', added_on: 1700000200, state: 'stoppedDL' },
    { name: '正在下载', added_on: 1700000100, state: 'downloading' },
    { name: '其他下载', added_on: 1700000300, category: 'other' },
  ].map((task, index) => ({ category: defaults.qb.category, hash: String(index).repeat(40), ...task }));
  const qb = {
    login: async () => '5.2', logout: async () => {},
    list: async () => tasks,
    request: async () => new Response(JSON.stringify({ save_path: 'D:/Video' })),
  };
  const f = await fixture(t, { qb });
  const snapshot = await f.request('qb');
  assert.equal(snapshot.status, 200);
  assert.deepEqual(snapshot.data.torrents.map(task => [task.name, task.addedAt]), [
    ['新任务', 1700000200000], ['正在下载', 1700000100000],
    ['旧任务', 1700000000000], ['添加时间未知', null],
  ]);
  assert.equal(tasks[0].name, '旧任务');
});

test('existing collection selection adds only newly requested files and rejects stale priority changes', async t => {
  const files = [
    {index:1,name:'Demo - 01.mkv',size:100,priority:6,progress:1},
    {index:2,name:'Demo - 02.mkv',size:200,priority:0,progress:0.2},
    {index:3,name:'Demo - 03.mkv',size:300,priority:0,progress:0},
  ];
  let changes = 0;
  const qb = {
    login: async () => {}, logout: async () => {},
    list: async () => [{hash:item.infoHash,state:'stoppedDL'}],
    async request(route, body) {
      if (route === 'torrents/files') return new Response(JSON.stringify(files));
      assert.equal(route,'torrents/filePrio');
      assert.equal(body.get('id'),'2');
      assert.equal(body.get('hash'),item.infoHash);
      changes++;
      files[1].priority = Number(body.get('priority'));
    },
  };
  const f = await fixture(t,{manualQb:qb,discovery:{peek:()=>item}});
  const p = (await f.request('discover/selection',{resultId:'fixture'})).data;
  assert.equal(p.stopped,true);
  assert.equal(p.files[1].progress,0.2);
  assert.equal((await f.request('discover/selection/apply',{resultId:'fixture',version:p.version,indices:[1]})).status,400);
  assert.equal((await f.request('discover/selection/apply',{resultId:'fixture',version:p.version,indices:[2]})).data.added,1);
  assert.deepEqual(files.map(file=>file.priority),[6,1,0]);
  assert.equal((await f.request('discover/selection/apply',{resultId:'fixture',version:p.version,indices:[3]})).status,409);
  assert.equal(changes,1);
});

test('mark only preserves downloader tasks and separates unwatched gaps from a real collection inventory', async t => {
  const items = [1,2,3].map(n => ({...item,id:'release'+n,episode:String(n),title:'测试番 - 0'+n}));
  const f = await fixture(t,{fetchFeed:async()=>items,episodeQb:{
    login:async()=>{ throw Error('mark only must not connect to download client'); },
  },qb:{login:async()=>{throw Error('qB offline');},logout:async()=>{}}});
  const key = 'bgm:123';
  await f.request('progress',{key,title:'测试番',watched:1,startEpisode:1,archived:false});
  assert.equal((await f.request('progress/watched/mark',{key,episode:2})).status,200);
  let row = (await f.request('progress')).data.shows[0];
  assert.deepEqual(row.missing.map(entry=>entry.number),[3]);
  assert.deepEqual(row.episodes.map(entry=>entry.watched),[true,true,false]);
  const directory = path.join(f.dir,'collection');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory,'测试番 - 03.mkv'),'video');
  const audit = await f.request('progress/collection',{key,directory});
  assert.deepEqual(audit.data.missing,[1,2]);
  assert.equal((await f.request('progress/watched/mark',{key})).status,200);
  row = (await f.request('progress')).data.shows[0];
  assert.equal(row.fullyWatched,true);
  assert.equal(row.showDeletion,undefined);
  assert.ok(fs.existsSync(path.join(directory,'测试番 - 03.mkv')));
});

test('local playback resumes the saved position, offers the next complete video after EOF and requires an existing file', async t => {
  const hashes = ['b'.repeat(40),'c'.repeat(40)];
  const starts = [];
  let dir;
  const filenames = ['Demo - 06.mkv','Demo - 07.mkv'];
  const qb = {
    login:async()=>{}, logout:async()=>{},
    list:async()=>hashes.map(hash=>({hash,save_path:dir})),
    request:async (route, unused, query) => {
      assert.equal(route,'torrents/files');
      const index = hashes.indexOf(new URLSearchParams(query).get('hash'));
      return new Response(JSON.stringify([{index:0,name:filenames[index],size:3,progress:1,priority:1}]));
    },
  };
  const f = await fixture(t,{playbackQb:qb,launchPlayback:async(file,sample,position)=>starts.push({file,sample,position})});
  dir=f.dir;
  const state = emptyState();
  for (const [i,hash] of hashes.entries()) {
    fs.writeFileSync(path.join(dir,filenames[i]),'abc');
    state.done['episode'+i]={...item,episode:String(6+i),hash,status:'added',at:new Date().toISOString()};
  }
  atomicWrite(statePath(f.c,f.configFile),state);
  assert.equal((await f.request('playback/start',{key:'bgm:123',episode:6})).status,200);
  fs.writeFileSync(starts[0].sample,JSON.stringify({position:763,finished:false}));
  assert.equal((await f.request('playback')).data.last.position,763);
  assert.equal((await f.request('playback/start',{action:'resume'})).status,200);
  assert.equal(starts[1].position,763);
  fs.writeFileSync(starts[1].sample,JSON.stringify({position:1220,finished:true}));
  assert.equal((await f.request('playback')).data.last.nextEpisode,7);
  fs.unlinkSync(path.join(dir,filenames[1]));
  assert.equal((await f.request('playback/start',{action:'next'})).status,400);
  fs.writeFileSync(path.join(dir,filenames[1]),'abc');
  assert.equal((await f.request('playback/start',{action:'next'})).status,200);
  assert.equal(starts[2].file,path.join(dir,filenames[1]));
});

test('overview detail pagination matches the automatic counter beyond recent history and does not change records',async t=>{
  const f=await fixture(t,{executeScript:async()=>{throw new Error('read must not start a process');},qb:{login:async()=>{throw new Error('read must not open qB');}}}),state=emptyState();
  for(let n=0;n<85;n++)state.done['added-'+n]={status:'added',title:'累计任务 '+String(n).padStart(2,'0'),at:'2026-11-04T00:00:00Z',savePath:'D:/Anime/测试番'};
  state.done.existing={status:'existing',title:'已有任务',at:'2026-11-04T00:00:00Z'};
  state.done.duplicate={status:'episode-duplicate',title:'同集跳过',at:'2026-11-04T00:00:00Z'};
  const file=statePath(f.c,f.configFile);atomicWrite(file,state);const before=fs.readFileSync(file,'utf8');
  let r=await f.request('overview/details?kind=added');assert.equal(r.status,200);assert.equal(r.data.total,85);assert.equal(r.data.items.length,40);assert.equal(r.data.pages,3);
  r=await f.request('overview/details?kind=added&page=3');assert.equal(r.data.items.length,5);
  r=await f.request('overview/details?kind=added&q='+encodeURIComponent('累计任务 84'));assert.equal(r.data.filteredTotal,1);
  await f.request('history/clear',{confirm:true});assert.equal((await f.request('overview/details?kind=added')).data.total,(await f.request('status')).data.state.added);
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal((await f.request('overview/details?kind=unknown')).status,400);assert.equal((await f.request('overview/details?kind=added&page=-1')).status,400);
});

test('overview pending details explain priority waits, failures and changed rules without exposing private queued URLs',async t=>{
  const f=await fixture(t);f.c.filters.priorityGroups=['Preferred'];f.c.filters.fallbackHours=6;atomicWrite(f.configFile,f.c);const state=emptyState(),source=sourceKeyImported(f.c.rssUrl);
  state.pending.wait={item:{...item,groupName:'Fallback',torrentUrl:'https://private.test/file?secret=never-expose'},source};
  state.pending.failure={item:{...item,title:'失败资源',groupName:'Preferred'},source,lastError:'连接失败 '+f.c.rssUrl+' '+f.c.qb.password};
  state.pending.old={item:{...item,title:'旧来源'},source:'older-source'};
  state.pending.excluded={item:{...item,title:'纯繁中',languages:['CHT']},source};
  state.pending.retired={item:{...item,title:'已退订',bgmId:'999'},source};atomicWrite(statePath(f.c,f.configFile),state);
  const {accountKeyHash}=await import('../src/anibt-control.js');atomicWrite(path.join(f.dir,'data/anibt-control.json'),{keyHash:accountKeyHash(f.c),blocked:{'999':true},baseline:{}});
  const r=await f.request('overview/details?kind=pending');assert.equal(r.status,200);assert.equal(r.data.total,5);
  const rows=r.data.items;assert.equal(rows.find(r=>r.title==='失败资源').status,'添加失败，等待重试');assert.ok(rows.find(r=>r.groupName==='Fallback').waitUntil>Date.now());assert.equal(rows.find(r=>r.title==='旧来源').status,'来源已切换');assert.equal(rows.find(r=>r.title==='纯繁中').status,'当前偏好已过滤');assert.equal(rows.find(r=>r.title==='已退订').status,'网站已退订');
  for(const secret of ['private-test-token','secret-test-password','never-expose','torrentUrl'])assert.ok(!JSON.stringify(r.data).includes(secret));
});
test('GUI excludes plaintext and encrypted credentials from public settings',()=>{const c=clone(defaults);c.rssUrl='https://anibt.net/rss/subscriptions.xml?key=private';c.qb.password='password-secret';c.qb.passwordEncrypted='encrypted-secret';const s=JSON.stringify(publicConfig(c));assert.ok(!s.includes('key=private'));assert.ok(!s.includes('password-secret'));assert.ok(!s.includes('encrypted-secret'));assert.equal(publicConfig(c).passwordConfigured,true);});

test('episode deletion requires a prepared confirmation, revalidates changes and preserves dedupe after marking one episode watched',async t=>{
 let torrents=[],files=[],deletes=0;const qb={login:async()=>{},connectForDownload:async()=>{},logout:async()=>{},list:async()=>torrents,request:async(method,body)=>{if(method==='torrents/files')return{json:async()=>files};assert.equal(method,'torrents/delete');assert.equal(body.get('deleteFiles'),'true');deletes++;torrents=[];return{};}};const f=await fixture(t,{episodeQb:qb});const folder=path.join(f.dir,'video');fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'01.mkv'),'abc');torrents=[{hash:item.infoHash,name:item.title,save_path:f.dir,content_path:folder}];files=[{name:'video/01.mkv',size:3}];const state=emptyState();state.done.old={...item,hash:item.infoHash,at:new Date().toISOString(),status:'added'};state.episodes[item.episodeKey]='old';atomicWrite(statePath(f.c,f.configFile),state);
 let p=await f.request('progress/episode/prepare',{key:'bgm:123',episode:1,action:'watched'});assert.equal(p.status,200);assert.equal(deletes,0);assert.equal((await f.request('progress/episode/confirm',{id:p.data.id})).status,400);files.push({name:'video/font.ttf',size:10});assert.equal((await f.request('progress/episode/confirm',{id:p.data.id,confirm:true})).status,400);assert.equal(deletes,0);
 p=await f.request('progress/episode/prepare',{key:'bgm:123',episode:1,action:'watched'});const result=await f.request('progress/episode/confirm',{id:p.data.id,confirm:true});assert.equal(result.status,200);assert.equal(deletes,1);assert.ok(result.data.filesRemaining>0);const tracking=JSON.parse(fs.readFileSync(path.join(f.dir,'data/tracking.json')));assert.equal(tracking['bgm:123'].episodeStates['1'],true);assert.deepEqual(loadState(statePath(f.c,f.configFile)).episodes,{'bgm:123:1:v1':'old'});assert.deepEqual(loadState(statePath(f.c,f.configFile)).done,state.done);assert.equal((await f.request('feed')).data.items[0].matched,false);assert.equal((await f.request('progress/episode/confirm',{id:p.data.id,confirm:true})).status,400);
});

test('confirmed finale removes only an empty managed folder while a currently airing episode keeps it', async t => {
  let torrents = [], folder, root, status = 'RELEASING';
  const qb = {
    login: async () => {}, logout: async () => {}, list: async () => torrents,
    request: async (method, body) => {
      if (method === 'app/preferences') return { json: async () => ({ save_path: root }) };
      if (method === 'torrents/files') return { json: async () => [{ name: '01.mkv', size: 1 }] };
      assert.equal(method, 'torrents/delete');
      assert.equal(body.get('deleteFiles'), 'true');
      fs.unlinkSync(path.join(folder, '01.mkv'));
      torrents = [];
    },
  };
  const f = await fixture(t, { episodeQb: qb, animeCatalog: {
    search: async () => ({ items: [{ bgmId: '123', status, episodes: 1 }] }),
  } });
  root = f.dir;
  folder = path.join(root, item.animeTitle);
  fs.mkdirSync(folder);
  async function remove({ wholeShow = false, preserve = false } = {}) {
    fs.writeFileSync(path.join(folder, '01.mkv'), 'a');
    if (preserve) fs.writeFileSync(path.join(folder, 'keep.ass'), 'a');
    torrents = [{ hash: item.infoHash, save_path: folder, content_path: path.join(folder, '01.mkv') }];
    const scope = wholeShow ? 'show' : 'episode';
    const preview = await f.request(`progress/${scope}/prepare`, { key: 'bgm:123', episode: 1, action: 'watched' });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.deepEqual(preview.data.cleanupFolders, wholeShow || status === 'FINISHED' ? [folder] : []);
    assert.ok(fs.existsSync(path.join(folder, '01.mkv')));
    const result = await f.request(`progress/${scope}/confirm`, { id: preview.data.id, confirm: true });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  await remove();
  assert.ok(fs.existsSync(folder));
  status = 'FINISHED';
  await remove({ preserve: true });
  assert.ok(fs.existsSync(path.join(folder, 'keep.ass')));
  fs.unlinkSync(path.join(folder, 'keep.ass'));
  assert.equal((await remove()).removedFolders, 1);
  assert.equal(fs.existsSync(folder), false);
  fs.mkdirSync(folder);
  assert.equal((await remove({ wholeShow: true })).removedFolders, 1);
  assert.ok(fs.existsSync(root));
});

test('unwatched episode download chooses one version, requires explicit rule override and updates the single-episode flag only after submission',async t=>{
 const adds=[];let connects=0;const qb={login:async()=>{},connectForDownload:async()=>{connects++;},logout:async()=>{},list:async()=>[],ensureCategory:async()=>{},add:async(i,options)=>{adds.push({i,options});return{savePath:'D:/Anime/Test'};}};const f=await fixture(t,{episodeQb:qb});f.c.startEpisode=2;atomicWrite(f.configFile,f.c);atomicWrite(path.join(f.dir,'data/tracking.json'),{'bgm:123':{title:'测试番',bgmId:'123',watched:5,startEpisode:1,archived:false,episodeStates:{'1':true}}});let p=await f.request('progress/episode/prepare',{key:'bgm:123',episode:1,action:'unwatched'});assert.equal(p.status,200);assert.ok(p.data.warning);assert.equal(adds.length,0);assert.equal((await f.request('progress/episode/confirm',{id:p.data.id,confirm:true})).status,400);assert.equal(adds.length,0);p=await f.request('progress/episode/prepare',{key:'bgm:123',episode:1,action:'unwatched'});const r=await f.request('progress/episode/confirm',{id:p.data.id,confirm:true,acknowledgeRules:true});assert.equal(r.status,200);assert.equal(adds.length,1);assert.ok(connects>0);assert.equal(adds[0].i.infoHash,item.infoHash);assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'data/tracking.json')))['bgm:123'].episodeStates['1'],false);
});

test('manual monthly cleanup resets counter and history without backing up or touching download state',async t=>{
 const f=await fixture(t),state=emptyState();state.done.old={...item,status:'added',hash:item.infoHash,at:'2026-10-01T00:00:00Z'};state.episodes[item.episodeKey]='old';state.pending.retry={item,source:sourceKeyImported(f.c.rssUrl)};atomicWrite(statePath(f.c,f.configFile),state);const before=fs.readFileSync(statePath(f.c,f.configFile),'utf8'),configBefore=fs.readFileSync(f.configFile,'utf8');
 assert.equal((await f.request('status')).data.state.added,1);assert.equal((await f.request('maintenance/clean',{})).status,400);assert.equal((await f.request('maintenance/preferences',{enabled:true})).data.enabled,true);
 assert.equal((await f.request('maintenance/clean',{confirm:true})).data.backupCreated,false);let status=(await f.request('status')).data;assert.equal(status.state.added,0);assert.equal(status.state.historyCount,0);assert.equal(status.state.pending,1);assert.equal((await f.request('overview/details?kind=added')).data.total,0);
 await f.request('history/restore',{});assert.equal((await f.request('status')).data.state.historyCount,0);assert.equal(fs.readFileSync(statePath(f.c,f.configFile),'utf8'),before);assert.equal(fs.readFileSync(f.configFile,'utf8'),configBefore);
 state.done.new={...item,status:'added',hash:item.infoHash,at:new Date(Date.now()+2000).toISOString()};atomicWrite(statePath(f.c,f.configFile),state);status=(await f.request('status')).data;assert.equal(status.state.added,1);assert.equal(status.state.historyCount,1);assert.ok(status.maintenance.enabled);assert.ok(!fs.readdirSync(path.join(f.dir,'data')).some(f=>/backup|\.bak$/.test(f)));
});
test('GUI applies only editable settings, preserves secrets on blank input and private state path',()=>{const c=clone(defaults);c.rssUrl='https://anibt.net/rss/subscriptions.xml?key=private';c.qb.passwordEncrypted='preserved';const next=applyConfigPatch(c,{rssUrl:'',stateFile:'elsewhere',qb:{password:'',passwordEncrypted:'replace'},filters:{groups:['Test']}});assert.equal(next.rssUrl,c.rssUrl);assert.equal(next.qb.passwordEncrypted,'preserved');assert.equal(next.stateFile,c.stateFile);assert.deepEqual(next.filters.languages,['CHS']);assert.deepEqual(next.filters.groups,['Test']);});
test('GUI rejects unauthorized sessions and foreign origins',async t=>{const f=await fixture(t);assert.equal((await f.request('status',null,{'X-App-Token':'wrong'})).status,403);assert.equal((await f.request('status',null,{Origin:'https://other.test'})).status,403);const result=await f.request('status');assert.equal(result.status,200);assert.ok(!JSON.stringify(result.data).includes('secret-test-password'));assert.ok(!JSON.stringify(result.data).includes('private-test-token'));});
test('GUI settings require current revision and are shared with CLI configuration',async t=>{const f=await fixture(t);const before=(await f.request('status')).data;assert.equal((await f.request('config',{revision:-1,config:{filters:{groups:['no']}}})).status,409);const result=await f.request('config',{revision:before.revision,config:{filters:{groups:['Test'],resolutions:['1080p']}}});assert.equal(result.status,200);const saved=JSON.parse(fs.readFileSync(f.configFile,'utf8'));assert.deepEqual(saved.filters.groups,['Test']);assert.deepEqual(saved.filters.languages,['CHS']);assert.equal(saved.qb.password,'secret-test-password');});
test('GUI preview is read-only and marks excluded language without exposing torrent URLs',async t=>{const f=await fixture(t,{fetchFeed:async()=>[item,{...item,id:'cht-only',languages:['CHT']}]});const result=await f.request('feed');assert.equal(result.status,200);assert.equal(result.data.items[0].matched,true);assert.equal(result.data.items[1].status,'excluded');assert.equal(result.data.items[0].torrentUrl,undefined);assert.equal(fs.existsSync(statePath(f.c,f.configFile)),false);});
test('GUI backfill requires confirmation; actual operation pauses and resumes the watcher',async t=>{const actions=[];let adds=0;const qb={login:async()=>{},ensureCategory:async()=>{},list:async()=>[],add:async()=>{adds++;},logout:async()=>{}};const f=await fixture(t,{backgroundStatus:()=>({running:true,autostart:true}),executeScript:async a=>{actions.push(a);},runner:{fetchFeed:async()=>[item],qb}});assert.equal((await f.request('action',{action:'backfill'})).status,400);assert.equal(actions.length,0);const result=await f.request('action',{action:'backfill',confirm:true,selectedIds:[item.id]});assert.equal(result.status,200);assert.equal(result.data.report.added,1);assert.deepEqual(actions,['stop','start']);assert.equal(adds,1);assert.equal(Object.keys(loadState(statePath(f.c,f.configFile)).done).length,1);});
test('GUI restores background tracking when a check fails',async t=>{const actions=[];const f=await fixture(t,{backgroundStatus:()=>({running:true}),executeScript:async a=>actions.push(a),runner:{fetchFeed:async()=>{throw new Error('offline');}}});const r=await f.request('action',{action:'check'});assert.equal(r.status,400);assert.deepEqual(actions,['stop','start']);assert.equal(fs.existsSync(statePath(f.c,f.configFile)+'.lock'),false);});
test('GUI prevents overlapping download operations',async t=>{let unblock;const blocked=new Promise(r=>unblock=r);const f=await fixture(t,{executeScript:async()=>blocked});const first=f.request('action',{action:'start'});await new Promise(r=>setTimeout(r,30));const second=await f.request('action',{action:'check'});assert.equal(second.status,409);unblock();assert.equal((await first).status,200);});

test('per-anime groups include published history beyond RSS and exclude unrelated directory groups',()=>{
  const groups=mergeGroupOptions({items:[item,{...item,groupName:'Other Anime',groupSlug:'other',bgmId:'456',animeTitle:'另一部番'}],directory:[{name:'Unrelated',slug:'unrelated'}],published:[{name:'Older Publisher',slug:'older',totalReleases:50,items:[{language:['CHS']}]}],bgmId:'123',title:'测试番'});
  assert.deepEqual(new Set(groups.map(g=>g.slug)),new Set(['test','older']));assert.equal(groups.find(g=>g.slug==='older').totalReleases,50);assert.equal(groups.find(g=>g.slug==='older').hasSimplified,true);
});
test('group catalog merges exact aliases and keeps newly discovered subscription groups',()=>{
  const groups=mergeGroupOptions({items:[item,{...item,id:'second',groupName:'New Group',groupSlug:'new'}],directory:[{name:'Test',slug:'test'},{name:'Directory Only',slug:'directory'}]});
  assert.equal(groups.filter(g=>g.slug==='test').length,1);assert.equal(groups.find(g=>g.slug==='new').subscription,true);assert.equal(groups.find(g=>g.slug==='directory').published,false);
});
test('group refresh bypasses caches, discovers new publishers and leaves download preferences unchanged',async t=>{
  let phase=0,requests=0;const f=await fixture(t,{groups:async()=>{requests++;return{data:[{name:'Test',slug:'test'},...(phase?[{name:'New',slug:'new'}]:[])]};}});const before=fs.readFileSync(f.configFile,'utf8');
  assert.equal((await f.request('groups')).data.groups.length,1);phase=1;assert.equal((await f.request('groups')).data.groups.length,1);assert.equal(requests,1);
  assert.equal((await f.request('groups?refresh=1')).data.groups.length,2);assert.equal(requests,2);assert.equal(fs.readFileSync(f.configFile,'utf8'),before);
});
test('anime group endpoint uses the correct subject and refreshes old history',async t=>{
  let requests=0;const f=await fixture(t,{animeGroups:async id=>{assert.equal(id,'123');requests++;return{data:{groups:[{name:'Historical',slug:'historical',totalReleases:15,items:[]}]}};}});
  let result=await f.request('groups?bgmId=123&title='+encodeURIComponent('测试番'));assert.equal(result.data.scope,'anime');assert.deepEqual(new Set(result.data.groups.map(g=>g.slug)),new Set(['test','historical']));
  await f.request('groups?bgmId=123');assert.equal(requests,1);await f.request('groups?bgmId=123&refresh=1');assert.equal(requests,2);assert.equal((await f.request('groups?bgmId=bad')).status,400);
});
test('anime groups fall back to current subscriptions when upstream is unavailable',async t=>{
  const f=await fixture(t,{animeGroups:async()=>{throw new Error('offline');}});const result=await f.request('groups?bgmId=123&title='+encodeURIComponent('测试番'));assert.equal(result.status,200);assert.equal(result.data.groups[0].slug,'test');assert.ok(result.data.warning);
});
test('theme preference persists independently from private downloader configuration',async t=>{
  const f=await fixture(t);const before=fs.readFileSync(f.configFile,'utf8');assert.equal((await f.request('preferences')).data.theme,'system');
  assert.equal((await f.request('preferences',{theme:'dark'})).status,200);assert.equal((await f.request('status')).data.preferences.theme,'dark');assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'data/preferences.json'),'utf8')).theme,'dark');
  assert.match(await(await fetch(f.base+'/')).text(),/data-theme-preference="dark"/);
  assert.equal((await f.request('preferences',{theme:'invalid'})).status,400);assert.equal(fs.readFileSync(f.configFile,'utf8'),before);assert.equal(fs.existsSync(statePath(f.c,f.configFile)),false);
});

test('network preferences preserve theme and reject credential-bearing proxy URLs',async t=>{const f=await fixture(t);await f.request('preferences',{theme:'dark'});const r=await f.request('preferences',{networkMode:'custom',proxyUrl:'http://127.0.0.1:7890'});assert.equal(r.data.theme,'dark');assert.equal(r.data.networkMode,'custom');assert.equal((await f.request('preferences',{proxyUrl:'http://u:p@127.0.0.1:7890'})).status,400);});

test('visual style persists independently of brightness and network settings, validates input and bootstraps HTML',async t=>{
  const f=await fixture(t),before=fs.readFileSync(f.configFile,'utf8');
  assert.equal((await f.request('preferences')).data.design,'classic');
  const saved=await f.request('preferences',{design:'apple',theme:'light'});
  assert.equal(saved.status,200);assert.equal(saved.data.design,'apple');
  const dark=await f.request('preferences',{theme:'dark'});
  assert.equal(dark.data.design,'apple');
  const network=await f.request('preferences',{networkMode:'direct'});
  assert.equal(network.data.design,'apple');assert.equal(network.data.theme,'dark');
  const html=await(await fetch(f.base+'/')).text();
  assert.match(html,/data-design="apple"/);assert.match(html,/data-theme-preference="dark"/);
  assert.equal((await fetch(f.base+'/apple.css')).status,200);
  assert.equal((await f.request('preferences',{design:'untrusted-theme'})).status,400);
  assert.equal((await f.request('preferences')).data.design,'apple');
  await f.request('preferences',{design:'classic'});
  assert.equal((await f.request('preferences')).data.theme,'dark');
  assert.equal(fs.readFileSync(f.configFile,'utf8'),before);
  assert.equal(fs.existsSync(statePath(f.c,f.configFile)),false);
});

test('morph is an additive saved style with its own assets and independent brightness',async t=>{
  const f=await fixture(t),before=fs.readFileSync(f.configFile,'utf8');
  let response=await f.request('preferences',{design:'morph',theme:'light'});
  assert.equal(response.status,200);assert.equal(response.data.design,'morph');
  response=await f.request('preferences',{theme:'dark',networkMode:'direct'});
  assert.equal(response.data.design,'morph');assert.equal(response.data.theme,'dark');
  assert.match(await(await fetch(f.base+'/')).text(),/data-design="morph"/);
  for(const asset of ['morph.css','morph.js'])assert.equal((await fetch(f.base+'/'+asset)).status,200);
  assert.equal((await f.request('preferences')).data.theme,'dark');
  await f.request('preferences',{design:'classic'});
  assert.equal((await f.request('preferences')).data.networkMode,'direct');
  assert.equal(fs.readFileSync(f.configFile,'utf8'),before);
  assert.equal(fs.existsSync(statePath(f.c,f.configFile)),false);
});

test('removed themes fall back to classic without losing brightness or network settings',async t=>{
  const f=await fixture(t), file=path.join(f.dir,'data/preferences.json');
  for(const design of ['constructivist','minimal']){
    atomicWrite(file,{design,theme:'dark',networkMode:'direct'});
    const result=await f.request('preferences');
    assert.equal(result.data.design,'classic');
    assert.equal(result.data.theme,'dark');
    assert.equal(result.data.networkMode,'direct');
    const html=await(await fetch(f.base+'/')).text();
    assert.match(html,/data-design="classic"/);
    assert.doesNotMatch(html,new RegExp('data-design-mode="'+design+'"'));
    assert.equal((await f.request('preferences',{design})).status,400);
    assert.equal((await fetch(f.base+'/'+design+'.css')).status,404);
  }
});
test('manual search add is confirmed in qB, recorded once and does not modify automatic filters',async t=>{let adds=0;const hashes=new Set();const manualQb={login:async()=>{},ensureCategory:async()=>{},has:async h=>hashes.has(h),add:async i=>{adds++;hashes.add(i.infoHash);},logout:async()=>{}};const discovery={search:async()=>({items:[]}),resolve:async id=>{if(id!=='valid')throw new Error('expired');return{...item,sources:['nyaa']};}};const f=await fixture(t,{discovery,manualQb});const before=fs.readFileSync(f.configFile,'utf8');let r=await f.request('discover/add',{resultId:'valid',paused:true});assert.equal(r.status,200);assert.equal(r.data.existing,false);assert.equal(adds,1);r=await f.request('discover/add',{resultId:'valid'});assert.equal(r.data.existing,true);assert.equal(adds,1);const history=(await f.request('status')).data.state.history;assert.equal(history.length,1);assert.equal(history[0].kind,'manual');assert.equal(fs.readFileSync(f.configFile,'utf8'),before);assert.equal((await f.request('discover/add',{resultId:'https://evil.test/a'})).status,400);});
test('unknown simplified subtitle metadata needs an explicit per-download acknowledgement',async t=>{let adds=0;const manualQb={login:async()=>{},ensureCategory:async()=>{},has:async()=>false,add:async()=>{adds++;},logout:async()=>{}};const discovery={resolve:async()=>({...item,languages:[],sources:['vcb']})};const f=await fixture(t,{discovery,manualQb});assert.equal((await f.request('discover/add',{resultId:'test'})).status,400);assert.equal(adds,0);assert.equal((await f.request('discover/add',{resultId:'test',acknowledgeSubtitle:true})).status,200);assert.equal(adds,1);});

test('selective discovery validates the preview and never converts an unverified add to success', async t => {
  const adds = [];
  let shouldFail = false;
  const discoveryFileQb = {
    login: async () => {},
    logout: async () => {},
    discoveryFileManifest: async () => [
      { path: 'Movie.mkv', size: 4500 },
      { path: 'SPs/Bonus.mkv', size: 1000 },
    ],
  };
  const manualQb = {
    login: async () => {}, logout: async () => {}, ensureCategory: async () => {}, has: async () => false,
    add: async (resource, options) => {
      adds.push(options.fileSelection.priorities);
      if (shouldFail) throw new Error('优先级未确认');
      return { savePath: 'D:/Test' };
    },
  };
  const f = await fixture(t, { discoveryFileQb, manualQb, discovery: { resolve: async () => item } });
  const preview = await f.request('discover/files', { resultId: 'movie' });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.files.map(row => row.recommended), [true, false]);
  assert.equal(adds.length, 0);
  const fileSelection = { previewId: preview.data.previewId, indices: [0] };
  assert.equal((await f.request('discover/add', { resultId: 'another', fileSelection })).status, 400);
  assert.equal((await f.request('discover/add', { resultId: 'movie', fileSelection: { ...fileSelection, indices: [] } })).status, 400);
  assert.equal(adds.length, 0);
  shouldFail = true;
  assert.equal((await f.request('discover/add', { resultId: 'movie', fileSelection })).status, 400);
  assert.equal((await f.request('status')).data.state.history.length, 0);
  shouldFail = false;
  assert.equal((await f.request('discover/add', { resultId: 'movie', fileSelection })).status, 200);
  assert.deepEqual(adds, [[1, 0], [1, 0]]);
  const manual = JSON.parse(fs.readFileSync(path.join(f.dir, 'data/manual-downloads.json')));
  assert.equal(manual[item.infoHash].selectiveDownload, true);
});

test('discovery reflects live qB tasks and permits the same seed after deletion with history intact', async t => {
  const foreign = 'b'.repeat(40);
  const hashes = new Set([foreign]);
  let connected = true;
  let adds = 0;
  let launches = 0;
  const qb = {
    login: async () => { if (!connected) throw Error('offline'); return '5'; },
    request: async () => ({ json: async () => ({}) }),
    list: async () => [...hashes].map(hash => ({ hash, category: 'foreign' })),
    logout: async () => {},
  };
  const manualQb = {
    ...qb,
    connectForDownload: async () => { launches++; },
    ensureCategory: async () => {},
    has: async hash => hashes.has(hash),
    add: async entry => { adds++; hashes.add(entry.infoHash); },
  };
  const f = await fixture(t, { qb, manualQb, discovery: { resolve: async () => item } });
  const presence = () => f.request('discover/tasks', { hashes: [item.infoHash.toUpperCase(), foreign], refresh: true });
  assert.deepEqual((await presence()).data, { connected: true, hashes: [foreign] });
  assert.equal((await f.request('qb')).data.torrents.length, 0, 'regular status remains limited to managed tasks');
  assert.equal((await f.request('discover/add', { resultId: 'episode' })).data.existing, false);
  assert.deepEqual((await presence()).data.hashes, [item.infoHash, foreign]);
  hashes.delete(item.infoHash);
  assert.deepEqual((await presence()).data.hashes, [foreign]);
  assert.equal((await f.request('status')).data.state.history[0].hash, item.infoHash);
  assert.equal((await f.request('discover/add', { resultId: 'episode' })).data.existing, false);
  assert.equal(adds, 2);
  connected = false;
  assert.deepEqual((await presence()).data, { connected: false, hashes: [] });
  assert.equal(launches, 2, 'read-only presence checks never start qB');
  assert.equal((await f.request('discover/tasks', { hashes: ['bad'] })).status, 400);
});

test('discovery additions use per-work subfolders for blank paths, exact overrides and original paths on duplicates',async t=>{
 const c=clone(defaults),qb=new QbClient(c),forms=[],hashes=new Set();qb.connectForDownload=async()=>{};qb.ensureCategory=async()=>{};qb.logout=async()=>{};let adding=false;
 qb.has=async h=>adding||hashes.has(h);qb.request=async(method,body)=>{if(method==='app/preferences')return{json:async()=>({save_path:'D:/Downloads'})};if(method==='torrents/add'){forms.push(body);adding=true;return{text:async()=> 'Ok.'};}throw new Error(method);};
 const raw=id=>({...item,animeTitle:'',bgmId:'',workTitle:'学生会 / Student Council',id,infoHash:id==='next'?'b'.repeat(40):id==='override'?'c'.repeat(40):'a'.repeat(40)});
 const f=await fixture(t,{manualQb:qb,discovery:{resolve:async id=>raw(id),peek:id=>raw(id)}}),before=fs.readFileSync(f.configFile,'utf8');
 let r=await f.request('discover/add',{resultId:'first',savePath:''});assert.equal(r.status,200);assert.equal(forms[0].get('savepath'),String.raw`D:\Downloads\学生会`);assert.equal(forms[0].get('autoTMM'),'false');assert.equal(r.data.savePath,String.raw`D:\Downloads\学生会`);hashes.add(r.data.hash);adding=false;
 r=await f.request('discover/add',{resultId:'first',savePath:'E:/DoNotMove'});assert.equal(r.data.existing,true);assert.equal(forms.length,1);assert.equal(r.data.savePath,String.raw`D:\Downloads\学生会`);
 r=await f.request('discover/add',{resultId:'next',allowAlternate:true});assert.equal(forms[1].get('savepath'),String.raw`D:\Downloads\学生会`);adding=false;
 r=await f.request('discover/add',{resultId:'override',savePath:'E:/Chosen',allowAlternate:true});assert.equal(forms[2].get('savepath'),'E:/Chosen');assert.equal(r.data.savePath,'E:/Chosen');assert.equal(fs.readFileSync(f.configFile,'utf8'),before);
});
test('discovery preview reads cached metadata without resolving torrents or launching qB; association and single-show directories win',async t=>{
 let resolved=0,logins=0;const raw={...item,animeTitle:'',bgmId:'',workTitle:'学生会'};
 const f=await fixture(t,{qb:{login:async()=>{logins++;throw new Error('qB closed');},logout:async()=>{}},discovery:{peek:()=>raw,resolve:async()=>{resolved++;throw new Error('must not fetch');}}});
 let r=await f.request('discover/path',{resultId:'id'});assert.equal(r.data.waitingForQb,true);assert.equal(r.data.folderName,'学生会');assert.equal(resolved,0);assert.equal(logins,1);
 f.c.qb.savePath='F:/Root';f.c.rules=[{bgmId:'123',savePath:'E:/Single'}];atomicWrite(f.configFile,f.c);
 r=await f.request('discover/path',{resultId:'id',association:{title:'关联番',bgmId:'123',episode:'6'}});assert.equal(r.data.savePath,'E:/Single');assert.equal(r.data.animeTitle,'关联番');assert.equal(logins,1);
 r=await f.request('discover/path',{resultId:'id'});assert.equal(r.data.savePath,String.raw`F:\Root\学生会`);assert.equal(logins,1);
});

test('GUI requires an explicit nonempty backfill selection and submits only those episodes',async t=>{
 const calls=[],added=[];const second={...item,id:'episode-two',episode:'2',episodeKey:'测试番:2:v1',infoHash:'b'.repeat(40)};
 const qb={login:async()=>{},ensureCategory:async()=>{},list:async()=>[],add:async item=>added.push(item.id),logout:async()=>{}};
 const f=await fixture(t,{backgroundStatus:()=>({running:true}),executeScript:async a=>calls.push(a),runner:{fetchFeed:async()=>[item,second],qb}});
 assert.equal((await f.request('action',{action:'backfill',confirm:true})).status,400);assert.equal((await f.request('action',{action:'backfill',confirm:true,selectedIds:[]})).status,400);assert.deepEqual(calls,[]);
 const result=await f.request('action',{action:'backfill',confirm:true,selectedIds:[second.id]});assert.equal(result.status,200);assert.equal(result.data.report.added,1);assert.deepEqual(added,[second.id]);assert.deepEqual(calls,['stop','start']);
});

test('clearing visible history is reversible, keeps dedupe and pending state intact, and shows new arrivals',async t=>{
 const f=await fixture(t);const state=emptyState();state.done[item.id]={at:'2026-11-01T00:00:00Z',status:'added',title:item.title,hash:item.infoHash};state.episodes[item.episodeKey]=item.id;state.pending.retry={item,source:'unchanged'};
 const stateFile=statePath(f.c,f.configFile);atomicWrite(stateFile,state);const manualFile=path.join(f.dir,'data/manual-downloads.json');atomicWrite(manualFile,{manual:{at:'2026-11-01T00:01:00Z',title:'手动下载',hash:'b'.repeat(40),status:'added',kind:'manual'}});
 const beforeState=fs.readFileSync(stateFile,'utf8'),beforeManual=fs.readFileSync(manualFile,'utf8');assert.equal((await f.request('status')).data.state.history.length,2);
 assert.equal((await f.request('history/clear',{})).status,400);assert.equal((await f.request('history/clear',{confirm:true})).status,200);
 let status=(await f.request('status')).data;assert.equal(status.state.history.length,0);assert.equal(status.state.historyHidden,2);assert.equal(status.state.added,1);assert.equal(status.state.pending,1);assert.equal(status.state.episodes,1);
 assert.equal(fs.readFileSync(stateFile,'utf8'),beforeState);assert.equal(fs.readFileSync(manualFile,'utf8'),beforeManual);assert.equal((await f.request('feed')).data.items[0].status,'recorded');
 state.done.new={at:'2026-11-02T00:00:00Z',status:'added',title:'新到的记录',hash:'c'.repeat(40)};atomicWrite(stateFile,state);status=(await f.request('status')).data;assert.equal(status.state.history.length,1);assert.equal(status.state.history[0].id,'new');
 assert.equal((await f.request('history/restore',{})).status,200);assert.equal((await f.request('status')).data.state.history.length,3);
});

test('GUI persists global/per-show dates and paths and rejects bad settings before replacing saved configuration',async t=>{
 const f=await fixture(t);let status=(await f.request('status')).data;
 const patch={startDate:'2026-11-02',rules:[{bgmId:'123',savePath:'E:/Anime/学生会',startDate:''}]};const saved=await f.request('config',{revision:status.revision,config:patch});assert.equal(saved.status,200);
 const before=fs.readFileSync(f.configFile,'utf8');status=(await f.request('status')).data;assert.equal(status.config.startDate,'2026-11-02');assert.equal(status.config.rules[0].startDate,'');assert.equal(status.config.rules[0].savePath,'E:/Anime/学生会');
 assert.equal((await f.request('config',{revision:status.revision,config:{startDate:'2026-02-30'}})).status,400);assert.equal(fs.readFileSync(f.configFile,'utf8'),before);
 assert.equal((await f.request('config',{revision:status.revision,config:{rules:[{bgmId:'123',savePath:'relative-folder'}]}})).status,400);assert.equal(fs.readFileSync(f.configFile,'utf8'),before);
});

test('website account linking checks RSS identity and website changes suspend/resume only the owned watcher',async t=>{
 const {accountKeyHash,readAniBTControl}=await import('../src/anibt-control.js');const {sourceKey}=await import('../src/feed.js');const actions=[];const f=await fixture(t,{backgroundStatus:()=>({running:true}),executeScript:async a=>actions.push(a)});
 const wrong=await f.request('anibt/account',{user:{id:'user123',name:'用户'},keyHash:'0'.repeat(64)});assert.equal(wrong.data.linked,false);assert.deepEqual(actions,[]);
 assert.equal((await f.request('anibt/account',{user:{id:'user123',name:'用户'},keyHash:accountKeyHash(f.c)})).data.linked,true);
 let r=await f.request('anibt/begin',{action:'subscribe',bgmId:'123',userId:'user123'});assert.equal(r.status,200);assert.deepEqual(actions,['stop']);assert.equal((await f.request('action',{action:'check'})).status,409);
 assert.ok(readAniBTControl(f.configFile,f.c).baseline['123']);assert.equal((await f.request('anibt/finish',{changeId:r.data.changeId,verified:true,subscribed:true})).status,200);assert.deepEqual(actions,['stop','start']);
 const s=emptyState();s.pending.one={item,source:sourceKey(f.c.rssUrl)};s.pending.other={item:{...item,bgmId:'456'},source:sourceKey(f.c.rssUrl)};s.episodes.keep='processed';atomicWrite(statePath(f.c,f.configFile),s);
 r=await f.request('anibt/begin',{action:'unsubscribe',bgmId:'123',userId:'user123'});await f.request('anibt/finish',{changeId:r.data.changeId,verified:true,subscribed:false});const final=loadState(statePath(f.c,f.configFile));assert.equal(final.pending.one,undefined);assert.ok(final.pending.other);assert.equal(final.episodes.keep,'processed');assert.equal(readAniBTControl(f.configFile,f.c).blocked['123'],true);
 const stale=(await f.request('feed')).data.items[0];
 assert.equal(stale.siteUnsubscribed,true,'confirmed cancellation hides a stale RSS entry');
 assert.equal(stale.reason,'已从 AniBT 退订');
 r=await f.request('anibt/begin',{action:'subscribe',bgmId:'123',userId:'user123'});
 assert.equal(r.status,200);
 await f.request('anibt/finish',{changeId:r.data.changeId,verified:true,subscribed:true});
 assert.equal((await f.request('feed')).data.items[0].siteUnsubscribed,false);
});

test('new confirmed website subscriptions get the Beijing subscription day before the watcher resumes',async t=>{
 const {accountKeyHash}=await import('../src/anibt-control.js');let f,checked=false;
 f=await fixture(t,{now:()=>new Date('2026-11-02T16:00:01Z'),backgroundStatus:()=>({running:true}),executeScript:async action=>{if(action==='start'){const c=JSON.parse(fs.readFileSync(f.configFile));assert.equal(c.rules[0].startDate,'2026-11-03');checked=true;}}});
 f.c.startDate='2020-01-01';atomicWrite(f.configFile,f.c);
 await f.request('anibt/account',{user:{id:'user123'},keyHash:accountKeyHash(f.c)});
 const r=await f.request('anibt/begin',{action:'subscribe',bgmId:'123',title:'测试番',userId:'user123'});
 assert.equal((await f.request('anibt/finish',{changeId:r.data.changeId,verified:true,subscribed:true,existing:false})).status,200);
 const c=JSON.parse(fs.readFileSync(f.configFile));assert.equal(checked,true);assert.equal(c.startDate,'2020-01-01');assert.deepEqual(c.rules,[{bgmId:'123',title:'测试番',startDate:'2026-11-03',startDateFromSubscription:'2026-11-03'}]);assert.deepEqual(c.filters,f.c.filters);
});

test('subscription date default preserves manual dates including explicit unlimited and other single-show preferences',async t=>{
 const {accountKeyHash}=await import('../src/anibt-control.js');const f=await fixture(t,{now:()=>new Date('2026-11-03T00:00:00Z')});
 const apply=async()=>{const r=await f.request('anibt/begin',{action:'subscribe',bgmId:'123',title:'测试番',userId:'user123'});assert.equal((await f.request('anibt/finish',{changeId:r.data.changeId,verified:true,subscribed:true})).status,200);return JSON.parse(fs.readFileSync(f.configFile));};
 await f.request('anibt/account',{user:{id:'user123'},keyHash:accountKeyHash(f.c)});
 for(const date of ['2026-01-01','']){f.c.rules=[{bgmId:'123',startDate:date,groups:['Test'],savePath:'D:/Anime/Custom'}];atomicWrite(f.configFile,f.c);assert.deepEqual((await apply()).rules,f.c.rules);}
 f.c.rules=[{bgmId:'123',groups:['Test'],enabled:false,savePath:'D:/Anime/Custom'}];atomicWrite(f.configFile,f.c);const c=await apply();assert.deepEqual(c.rules[0],{...f.c.rules[0],startDate:'2026-11-03',startDateFromSubscription:'2026-11-03'});
});

test('re-subscription refreshes only an automatic date; failed, existing and cancelled subscriptions never add date rules',async t=>{
 const {accountKeyHash}=await import('../src/anibt-control.js');const f=await fixture(t,{now:()=>new Date('2026-11-03T00:00:00Z')});
 await f.request('anibt/account',{user:{id:'user123'},keyHash:accountKeyHash(f.c)});
 for(const scenario of [{verified:false,subscribed:true},{verified:true,subscribed:false},{verified:true,subscribed:true,existing:true},{verified:true,subscribed:true,wasSubscribed:true},{action:'unsubscribe',verified:true,subscribed:false}]){
   const r=await f.request('anibt/begin',{action:scenario.action||'subscribe',bgmId:'123',userId:'user123',wasSubscribed:scenario.wasSubscribed});assert.equal((await f.request('anibt/finish',{changeId:r.data.changeId,...scenario})).status,200);assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile)).rules,[]);
 }
 f.c.rules=[{bgmId:'123',startDate:'2026-10-01',startDateFromSubscription:'2026-10-01'}];atomicWrite(f.configFile,f.c);
 const r=await f.request('anibt/begin',{action:'subscribe',bgmId:'123',userId:'user123'});await f.request('anibt/finish',{changeId:r.data.changeId,verified:true,subscribed:true,existing:false});assert.equal(JSON.parse(fs.readFileSync(f.configFile)).rules[0].startDate,'2026-11-03');
});

test('backup import requires preview and confirmation, preserves local arrivals and credentials, and coordinates watcher',async t=>{
 const actions=[];const f=await fixture(t,{backgroundStatus:()=>({running:true}),executeScript:async a=>actions.push(a)});
 const s=emptyState();s.done.old={at:new Date().toISOString(),title:'旧下载',hash:'a'.repeat(40),status:'added'};s.episodes.old='old';s.sources[sourceKeyForTest(f.c.rssUrl)]={baselineIds:['baseline']};atomicWrite(statePath(f.c,f.configFile),s);
 const backup=(await f.request('backup/export')).data;assert.ok(!JSON.stringify(backup).includes('private-test-token'));assert.ok(!JSON.stringify(backup).includes('secret-test-password'));
 assert.equal((await f.request('backup/restore',{id:'wrong',confirm:true})).status,400);backup.profile.filters.priorityGroups=['Test'];const preview=await f.request('backup/preview',backup);assert.equal(preview.status,200);assert.equal((await f.request('backup/restore',{id:preview.data.id,confirm:false})).status,400);
 s.done.new={at:new Date().toISOString(),title:'导入预览后的新下载',status:'added',hash:'b'.repeat(40)};s.pending.keep={item,source:sourceKeyForTest(f.c.rssUrl)};atomicWrite(statePath(f.c,f.configFile),s);
 assert.equal((await f.request('backup/restore',{id:preview.data.id,confirm:true})).status,200);assert.deepEqual(actions,['stop','start']);const final=loadState(statePath(f.c,f.configFile));assert.ok(final.done.new);assert.ok(final.pending.keep);const c=JSON.parse(fs.readFileSync(f.configFile));assert.equal(c.rssUrl,f.c.rssUrl);assert.equal(c.qb.password,f.c.qb.password);assert.deepEqual(c.filters.priorityGroups,['Test']);
});

test('invalid migration and stale configuration are rejected before saved data changes',async t=>{
 const f=await fixture(t),backup=(await f.request('backup/export')).data,before=fs.readFileSync(f.configFile,'utf8');backup.profile.rules=[{bgmId:'123',savePath:'relative-invalid'}];assert.equal((await f.request('backup/preview',backup)).status,400);assert.equal(fs.readFileSync(f.configFile,'utf8'),before);
 backup.profile.rules=[];const plan=await f.request('backup/preview',backup);await new Promise(r=>setTimeout(r,5));atomicWrite(f.configFile,{...f.c,startDate:'2026-01-01'});assert.equal((await f.request('backup/restore',{id:plan.data.id,confirm:true})).status,400);assert.equal(JSON.parse(fs.readFileSync(f.configFile)).startDate,'2026-01-01');
});

test('progress editing never modifies downloader state and rule preview uses unsaved filters read-only',async t=>{
 const f=await fixture(t);const before=fs.readFileSync(f.configFile,'utf8');const result=await f.request('rules/preview',{filters:{languages:['CHT']}});assert.equal(result.status,200);assert.equal(result.data.rows[0].decision,'字幕语言不匹配');assert.equal(fs.readFileSync(f.configFile,'utf8'),before);assert.equal(fs.existsSync(statePath(f.c,f.configFile)),false);
 assert.equal((await f.request('progress',{key:'bgm:123',title:'测试番',watched:3,startEpisode:2,archived:true})).status,200);assert.equal(fs.existsSync(statePath(f.c,f.configFile)),false);assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'data/tracking.json')))['bgm:123'].watched,3);assert.equal((await f.request('progress',{key:'bgm:123',title:'测试番',watched:-1,startEpisode:2,archived:false})).status,400);
});

function sourceKeyForTest(url){return sourceKeyImported(url);}

test('new subscriptions keep episode-only global choice instead of injecting today; explicit unlimited episode override still uses date default',async t=>{
 const {accountKeyHash}=await import('../src/anibt-control.js');const f=await fixture(t,{now:()=>new Date('2026-11-03T00:00:00Z')});f.c.startEpisode=6;atomicWrite(f.configFile,f.c);await f.request('anibt/account',{user:{id:'user123'},keyHash:accountKeyHash(f.c)});
 let r=await f.request('anibt/begin',{action:'subscribe',bgmId:'123',title:'测试番',userId:'user123'});await f.request('anibt/finish',{changeId:r.data.changeId,verified:true,subscribed:true,existing:false});assert.equal(JSON.parse(fs.readFileSync(f.configFile)).rules.length,0);
 f.c.rules=[{bgmId:'456',startEpisode:''}];atomicWrite(f.configFile,f.c);r=await f.request('anibt/begin',{action:'subscribe',bgmId:'456',title:'另一番',userId:'user123'});await f.request('anibt/finish',{changeId:r.data.changeId,verified:true,subscribed:true,existing:false});assert.equal(JSON.parse(fs.readFileSync(f.configFile)).rules[0].startDate,'2026-11-03');
});

test('restoring global defaults requires confirmation and current revision, preserves connection, single-show rules and all records',async t=>{
 const actions=[];const f=await fixture(t,{executeScript:async a=>actions.push(a),backgroundStatus:()=>({running:true,autostart:true})});const c={...f.c,startEpisode:6,startDate:'2026-11-01',intervalSeconds:900,filters:{...f.c.filters,groups:['Test'],languages:['CHT'],priorityGroups:['Test']},rules:[{bgmId:'123',startEpisode:8,startDate:'',savePath:'E:/Custom'}],qb:{...f.c.qb,url:'http://127.0.0.1:8081',username:'saved-user',passwordEncrypted:'encrypted-keep',executable:'D:/Apps/qBittorrent/qbittorrent.exe',savePath:'E:/Root',autoStart:false}};atomicWrite(f.configFile,c);
 const records={'state.json':{...emptyState(),done:{keep:{at:new Date().toISOString(),status:'added',title:'Keep'}}},'tracking.json':{'bgm:123':{title:'Keep',watched:6,startEpisode:1,archived:false}},'anibt-account.json':{id:'saved-account'},'preferences.json':{theme:'dark',networkMode:'custom',proxyUrl:'http://127.0.0.1:17890'}};for(const [name,data]of Object.entries(records))atomicWrite(path.join(f.dir,'data',name),data);const snapshots=new Map(Object.keys(records).map(name=>[name,fs.readFileSync(path.join(f.dir,'data',name),'utf8')]));
 const before=fs.readFileSync(f.configFile,'utf8'),status=(await f.request('status')).data,body={revision:status.revision,confirm:true,resetAnimeRules:false,resetAppearanceNetwork:false};assert.equal((await f.request('config/reset',{...body,confirm:false})).status,400);assert.equal((await f.request('config/reset',{...body,revision:-1})).status,409);assert.equal(fs.readFileSync(f.configFile,'utf8'),before);const r=await f.request('config/reset',body);assert.equal(r.status,200);const saved=JSON.parse(fs.readFileSync(f.configFile));assert.equal(saved.startEpisode,'');assert.equal(saved.startDate,'');assert.deepEqual(saved.filters,defaults.filters);assert.equal(saved.intervalSeconds,300);assert.equal(saved.qb.autoStart,true);assert.equal(saved.qb.savePath,'');assert.equal(saved.rssUrl,c.rssUrl);for(const key of ['url','username','password','passwordEncrypted','executable'])assert.equal(saved.qb[key],c.qb[key]);assert.deepEqual(saved.rules,c.rules);assert.deepEqual(actions,[]);for(const [name,text]of snapshots)assert.equal(fs.readFileSync(path.join(f.dir,'data',name),'utf8'),text);assert.ok(!JSON.stringify(r.data).includes('secret-test-password'));
});

test('explicit reset options clear only single-show preferences and appearance/network while leaving website and download state intact',async t=>{
 const f=await fixture(t);f.c.rules=[{bgmId:'123',enabled:false,startDate:'2026-01-01'}];atomicWrite(f.configFile,f.c);atomicWrite(path.join(f.dir,'data/preferences.json'),{theme:'dark',networkMode:'custom',proxyUrl:'http://127.0.0.1:17890'});const state=emptyState();state.pending.keep={item,source:sourceKeyImported(f.c.rssUrl)};state.sources[sourceKeyImported(f.c.rssUrl)]={baselineIds:['historical']};state.episodes.keep='done';atomicWrite(statePath(f.c,f.configFile),state);const before=fs.readFileSync(statePath(f.c,f.configFile),'utf8');const revision=(await f.request('status')).data.revision;assert.equal((await f.request('config/reset',{revision,confirm:true,resetAnimeRules:'true',resetAppearanceNetwork:true})).status,400);const r=await f.request('config/reset',{revision,confirm:true,resetAnimeRules:true,resetAppearanceNetwork:true});assert.equal(r.status,200);assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile)).rules,[]);assert.deepEqual(r.data.preferences,{theme:'system',design:'classic',networkMode:'auto',proxyUrl:'http://127.0.0.1:7890'});assert.equal(fs.readFileSync(statePath(f.c,f.configFile),'utf8'),before);
});

test('after resetting the global episode-only setting, a new subscription again defaults to its Beijing add date',async t=>{
 const {accountKeyHash}=await import('../src/anibt-control.js');const f=await fixture(t,{now:()=>new Date('2026-11-02T16:00:00Z')});f.c.startEpisode=6;atomicWrite(f.configFile,f.c);const revision=(await f.request('status')).data.revision;assert.equal((await f.request('config/reset',{revision,confirm:true,resetAnimeRules:false,resetAppearanceNetwork:false})).status,200);await f.request('anibt/account',{user:{id:'user123'},keyHash:accountKeyHash(f.c)});const r=await f.request('anibt/begin',{action:'subscribe',bgmId:'456',title:'新订阅',userId:'user123'});await f.request('anibt/finish',{changeId:r.data.changeId,verified:true,subscribed:true,existing:false});const saved=JSON.parse(fs.readFileSync(f.configFile));assert.equal(saved.startEpisode,'');assert.equal(saved.rules[0].startDate,'2026-11-03');
});


test('task card shortcuts survive cleared display history and accept only managed task hashes',async t=>{
 const hash='a'.repeat(40),foreign='b'.repeat(40);let root='',opened=0,starts=0;
 const qb={login:async()=> '5.2',connectForDownload:async()=>{starts++;},logout:async()=>{},list:async()=>[{hash,name:'保留任务',category:'Anime',save_path:root,progress:1,state:'uploading'},{hash:foreign,name:'其他任务',category:'Other',save_path:root,progress:1}],request:async method=>({json:async()=>method==='torrents/files'?[{name:'video.mkv',size:3,priority:1}]:{save_path:root}})};
 const f=await fixture(t,{qb,historyQb:qb,openHistoryFolder:async info=>{assert.equal(info.savePath,root);opened++;}});root=f.dir;f.c.qb.category='Anime';atomicWrite(f.configFile,f.c);fs.writeFileSync(path.join(root,'video.mkv'),'abc');
 assert.equal((await f.request('status')).data.state.history.length,0);
 let r=await f.request('history/task?hash='+hash);assert.equal(r.status,200);assert.equal(r.data.taskPresent,true);assert.equal(r.data.fileStatus,'present');assert.equal(r.data.canOpenFolder,true);assert.equal(r.data.recordedAt,undefined);
 r=await f.request('history/open-folder',{hash});assert.equal(r.status,200);assert.equal(opened,1);assert.equal(starts,0);const native=await f.request('history/open-folder',{hash,native:true});assert.equal(native.status,200);assert.equal(native.data.folderPath,root);assert.equal(opened,1);
 assert.equal((await f.request('history/task?hash='+foreign)).status,400);
 assert.equal((await f.request('history/open-folder',{hash:foreign})).status,400);
 assert.equal((await f.request('history/task?hash=invalid')).status,400);
 assert.equal(opened,1);assert.equal((await f.request('status')).data.state.history.length,0);
});


test('whole-show confirmation deletes only previewed tasks, preserves records, collects watched shows and can restore without redownloading',async t=>{
 let root='',deletes=0;const hashes=['a'.repeat(40),'b'.repeat(40),'c'.repeat(40)];let torrents=[];let changed=false;const qb={login:async()=> '5.2',connectForDownload:async()=>{},logout:async()=>{},list:async()=>torrents,request:async(method,body,query)=>{if(method==='torrents/files'){const hash=new URLSearchParams(query.slice(1)).get('hash'),n=hashes.indexOf(hash)+1;return{json:async()=>[{name:n+'/video.mkv',size:changed?4:3,priority:1}]};}if(method==='torrents/delete'){deletes++;const selected=body.get('hashes').split('|');assert.equal(body.get('deleteFiles'),'true');assert.deepEqual(selected.sort(),hashes.slice(0,2));for(let n=1;n<=2;n++)fs.unlinkSync(path.join(root,String(n),'video.mkv'));torrents=torrents.filter(t=>!selected.includes(t.hash));return{};}return{json:async()=>({save_path:root})};}};
 const f=await fixture(t,{qb,episodeQb:qb,fetchFeed:async()=>[]});root=f.dir;for(let n=1;n<=3;n++){const payload=path.join(root,String(n));fs.mkdirSync(payload);fs.writeFileSync(path.join(payload,'video.mkv'),'abc');torrents.push({hash:hashes[n-1],name:'Task '+n,save_path:root,content_path:payload,progress:1});}const state=emptyState();for(let n=1;n<=2;n++)state.done['r'+n]={status:'added',hash:hashes[n-1],title:'Test '+n,animeTitle:'Test',bgmId:'123',episode:String(n),at:'2026-11-04T00:00:00Z'};atomicWrite(statePath(f.c,f.configFile),state);
 let preview=await f.request('progress/show/prepare',{key:'bgm:123'});assert.equal(preview.status,200);assert.equal(preview.data.targets.length,2);assert.equal(deletes,0);assert.equal((await f.request('progress/show/confirm',{id:preview.data.id,confirm:false})).status,400);assert.equal(deletes,0);
 changed=true;assert.equal((await f.request('progress/show/confirm',{id:preview.data.id,confirm:true})).status,400);assert.equal(deletes,0);changed=false;preview=await f.request('progress/show/prepare',{key:'bgm:123'});const result=await f.request('progress/show/confirm',{id:preview.data.id,confirm:true});assert.equal(result.status,200);assert.equal(result.data.removedTasks,2);assert.equal(result.data.filesRemaining,0);assert.equal(deletes,1);assert.ok(fs.existsSync(path.join(root,'3/video.mkv')));assert.equal(Object.keys(loadState(statePath(f.c,f.configFile)).done).length,2);
 let progress=(await f.request('progress')).data.shows.find(s=>s.key==='bgm:123');assert.equal(progress.fullyWatched,true);assert.ok(progress.completedAt);assert.ok(progress.episodes.every(e=>e.watched));assert.equal((await f.request('progress/show/confirm',{id:preview.data.id,confirm:true})).status,400);
 assert.equal((await f.request('progress/show/restore',{key:'bgm:123'})).status,200);progress=(await f.request('progress')).data.shows.find(s=>s.key==='bgm:123');assert.equal(progress.fullyWatched,false);assert.equal(progress.completedAt,undefined);assert.ok(progress.episodes.every(e=>e.watched));assert.equal(deletes,1);
});


test('personal review persists independently, rejects stale edits and leaves playback state intact',async t=>{
 const f=await fixture(t),tracking={'bgm:123':{title:'测试番',bgmId:'123',watched:12,startEpisode:1,archived:false,completedAt:'2026-11-04T00:00:00Z',episodeStates:{1:true}}};atomicWrite(path.join(f.dir,'data/tracking.json'),tracking);let r=await f.request('progress/review?key=bgm:123');assert.equal(r.status,200);assert.equal(r.data.review,null);const old=r.data.version;
 r=await f.request('progress/review',{key:'bgm:123',version:old,score:8.5,text:'第一段\n第二段 <script>不会执行</script>'});assert.equal(r.status,200);assert.equal(r.data.review.score,8.5);const created=r.data.review.createdAt,version=r.data.version;
 assert.equal((await f.request('progress/review',{key:'bgm:123',version:old,score:9,text:'stale'})).status,409);assert.equal((await f.request('progress/review',{key:'bgm:123',version,score:11,text:''})).status,400);
 const saved=JSON.parse(fs.readFileSync(path.join(f.dir,'data/tracking.json')));assert.equal(saved['bgm:123'].watched,12);assert.equal(saved['bgm:123'].completedAt,tracking['bgm:123'].completedAt);assert.deepEqual(saved['bgm:123'].episodeStates,{1:true});assert.equal((await f.request('progress/review?key=bgm:123')).data.review.createdAt,created);
 r=await f.request('progress/review',{key:'bgm:123',version,score:0,text:'改写'});assert.equal(r.status,200);assert.equal(r.data.review.score,0);assert.equal(r.data.review.createdAt,created);r=await f.request('progress/review',{key:'bgm:123',version:r.data.version,score:null,text:''});assert.equal(r.status,200);assert.equal(r.data.review,null);assert.equal((await f.request('progress/review?key=bgm:456')).status,400);
});


test('personal reviews remain readable after a title-only watched record is linked to an anime ID',async t=>{
 const f=await fixture(t);f.c.bindings=[{title:'旧名',bgmId:'123',canonicalTitle:'新名',aliases:[]}];atomicWrite(f.configFile,f.c);atomicWrite(path.join(f.dir,'data/tracking.json'),{'title:旧名':{title:'旧名',watched:1,startEpisode:1,archived:false,completedAt:'2026-11-04T00:00:00Z'}});const initial=await f.request('progress/review?key=bgm:123');assert.equal(initial.status,200);const r=await f.request('progress/review',{key:'bgm:123',version:initial.data.version,score:8,text:'关联后保留'});assert.equal(r.status,200);assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'data/tracking.json')))['title:旧名'].personalReview.score,8);
});


test('review drafts and rewatch preserve earlier reviews without starting downloads; diagnostics are whitelisted',async t=>{
 let starts=0;const f=await fixture(t,{qb:{login:async()=>{throw Error('offline');},logout:async()=>{}},episodeQb:{connectForDownload:async()=>starts++},updateNetwork:{read:async()=>({text:JSON.stringify({tag_name:'v999.0.0',html_url:'https://github.com/owner/project/releases/tag/v999.0.0',body:'release'})})}});atomicWrite(path.join(f.dir,'data/tracking.json'),{'bgm:123':{title:'PRIVATE_ANIME',bgmId:'123',watched:12,startEpisode:1,archived:false,completedAt:'2026-11-05T00:00:00Z',personalReview:{score:9,text:'PRIVATE_REVIEW',createdAt:'2026-11-05T00:00:00Z',updatedAt:'2026-11-05T00:00:00Z'}}});
 let review=(await f.request('progress/review?key=bgm:123')).data;let draft=await f.request('progress/review/draft',{key:'bgm:123',draftVersion:review.draftVersion,baseVersion:review.version,score:8.5,text:'PRIVATE_DRAFT',rewatch:true});assert.equal(draft.status,200);assert.equal((await f.request('progress/review?key=bgm:123')).data.draft.text,'PRIVATE_DRAFT');
 let r=await f.request('progress/rewatch',{key:'bgm:123',completedAt:review.completedAt,reviewVersion:review.version,confirm:true});assert.equal(r.status,200);review=(await f.request('progress/review?key=bgm:123')).data;assert.equal(review.review,null);assert.equal(review.sessions[0].personalReview.text,'PRIVATE_REVIEW');assert.equal(review.sessions[0].draft.text,'PRIVATE_DRAFT');assert.equal(starts,0);assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'data/tracking.json')))['bgm:123'].watched,0);
 const diagnostic=JSON.stringify((await f.request('library/diagnostics')).data);for(const secret of ['PRIVATE_ANIME','PRIVATE_REVIEW','PRIVATE_DRAFT','private-test-token','secret-test-password',f.dir])assert.ok(!diagnostic.includes(secret));assert.equal((await f.request('library/status')).data.repository,'sen20070910-boop/anibt-desk');await f.request('library/update-source',{repository:'owner/project'});assert.equal((await f.request('library/check-update',{})).data.newer,true);
 const created=await f.request('library/backup',{});assert.equal(created.status,200);const backup=(await f.request('library/backup?id='+created.data.id)).data;assert.equal(backup.tracking['bgm:123'].watchSessions.length,1);assert.equal((await f.request('backup/preview',backup)).status,200);
});

test('offline gap reconciliation finds eligible public releases outside the subscription window without downloading',async t=>{
 const candidate={...item,id:'outside-rss',resultId:'outside-selection',episode:'2',episodeKey:'测试番:2:v1',infoHash:'b'.repeat(40)};let starts=0;const f=await fixture(t,{animeResources:{list:async()=>({items:[candidate],limit:100}),resolve:()=>candidate},episodeQb:{connectForDownload:async()=>starts++}});const state=emptyState();state.done.old={...item,status:'added',hash:item.infoHash,at:new Date().toISOString()};atomicWrite(statePath(f.c,f.configFile),state);let r=await f.request('library/gaps/check',{});assert.equal(r.status,200);assert.equal(r.data.results[0].items[0].resultId,'outside-selection');assert.equal(r.data.done,true);assert.equal(starts,0);assert.equal(Object.keys(loadState(statePath(f.c,f.configFile)).done).length,1);assert.equal((await f.request('library/gaps/check',{auditId:'expired',offset:0})).status,400);
});


test('automatic-backup viewing restore replaces old notes, keeps preferences and creates protection before changes',async t=>{
 const f=await fixture(t),tracked={'bgm:123':{title:'测试',bgmId:'123',watched:1,startEpisode:1,archived:false,completedAt:'2026-11-05T00:00:00Z',personalReview:{score:9,text:'旧评价',createdAt:'2026-11-05T00:00:00Z',updatedAt:'2026-11-05T00:00:00Z'}}};atomicWrite(path.join(f.dir,'data/tracking.json'),tracked);const backup=(await f.request('backup/export')).data;backup.profile.filters.languages=['CHT'];tracked['bgm:123'].personalReview.score=3;atomicWrite(path.join(f.dir,'data/tracking.json'),tracked);let plan=(await f.request('backup/preview',{...backup,_restoreViewing:true})).data;tracked['bgm:123'].personalReview.score=4;atomicWrite(path.join(f.dir,'data/tracking.json'),tracked);assert.equal((await f.request('backup/restore',{id:plan.id,confirm:true})).status,400);plan=(await f.request('backup/preview',{...backup,_restoreViewing:true})).data;assert.equal((await f.request('backup/restore',{id:plan.id,confirm:true})).status,200);assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'data/tracking.json')))['bgm:123'].personalReview.score,9);assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile)).filters.languages,['CHS']);const list=(await f.request('library/status')).data.backups;assert.ok(list.length);assert.equal((await f.request('library/backup?id='+list[0].id)).data.tracking['bgm:123'].personalReview.score,4);
});

test('saving a review does not discard another windows newer draft',async t=>{
 const f=await fixture(t);atomicWrite(path.join(f.dir,'data/tracking.json'),{'bgm:123':{title:'测试',watched:1,startEpisode:1,archived:false}});const initial=(await f.request('progress/review?key=bgm:123')).data;const a=(await f.request('progress/review/draft',{key:'bgm:123',baseVersion:initial.version,draftVersion:initial.draftVersion,score:8,text:'A'})).data;await f.request('progress/review/draft',{key:'bgm:123',baseVersion:initial.version,draftVersion:a.draftVersion,score:9,text:'B latest'});assert.equal((await f.request('progress/review',{key:'bgm:123',version:initial.version,draftVersion:a.draftVersion,score:8,text:'A formal'})).status,200);const result=(await f.request('progress/review?key=bgm:123')).data;assert.equal(result.review.text,'A formal');assert.equal(result.draft.text,'B latest');assert.notEqual(result.draft.baseVersion,result.version);
});

test('finishing a rewatch keeps the first review and the second review becomes a separate history entry',async t=>{
 const qb={login:async()=> '5.2',connectForDownload:async()=>{},logout:async()=>{},list:async()=>[],request:async()=>({json:async()=>({save_path:''})})},f=await fixture(t,{qb,episodeQb:qb});atomicWrite(path.join(f.dir,'data/tracking.json'),{'bgm:123':{title:'测试番',bgmId:'123',watched:1,startEpisode:1,archived:false,completedAt:'2026-11-05T00:00:00Z',personalReview:{score:9,text:'初看',createdAt:'2026-11-05T00:00:00Z',updatedAt:'2026-11-05T00:00:00Z'}}});let review=(await f.request('progress/review?key=bgm:123')).data;await f.request('progress/rewatch',{key:'bgm:123',completedAt:review.completedAt,reviewVersion:review.version,confirm:true});review=(await f.request('progress/review?key=bgm:123')).data;await f.request('progress/review',{key:'bgm:123',version:review.version,score:7,text:'重看感想'});const plan=(await f.request('progress/show/prepare',{key:'bgm:123'})).data;assert.equal((await f.request('progress/show/confirm',{id:plan.id,confirm:true})).status,200);review=(await f.request('progress/review?key=bgm:123')).data;assert.equal(review.review.score,7);assert.equal(review.sessions[0].personalReview.score,9);await f.request('progress/rewatch',{key:'bgm:123',completedAt:review.completedAt,reviewVersion:review.version,confirm:true});review=(await f.request('progress/review?key=bgm:123')).data;assert.equal(review.sessions.length,2);assert.equal(review.sessions[1].personalReview.score,7);assert.equal(review.review,null);
});


test('diagnostics still work for broken settings or tracking without exposing their contents',async t=>{
 const f=await fixture(t);fs.writeFileSync(f.configFile,'PRIVATE_BROKEN_CONFIG');fs.mkdirSync(path.join(f.dir,'data'),{recursive:true});fs.writeFileSync(path.join(f.dir,'data/tracking.json'),'PRIVATE_BROKEN_TRACKING');const r=await f.request('library/diagnostics');assert.equal(r.status,200);assert.equal(r.data.configValid,false);assert.equal(r.data.trackingReadable,false);assert.ok(!JSON.stringify(r.data).includes('PRIVATE_BROKEN'));
});

test('GUI serves the frontend loaded at startup after an on-disk update', async t => {
 const uiRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'anibt-ui-assets-'));
 t.after(() => fs.rmSync(uiRoot, { recursive: true, force: true }));
 const file = path.join(uiRoot, 'discover.js');
 fs.writeFileSync(file, 'old frontend');
 const f = await fixture(t, {}, { uiRoot });
 fs.writeFileSync(file, 'new frontend');
 assert.equal(await (await fetch(f.base + '/discover.js')).text(), 'old frontend');
});

test('subtitle probing only reads the completed local video selected from a managed task', async t => {
 const hash = 'a'.repeat(40);
 let root, probed = 0;
 const qb = {
   login: async () => {}, logout: async () => {},
   list: async () => [{ hash, name: 'Film', category: 'AniBT', save_path: root, progress: 0.5 }],
   request: async () => ({ json: async () => [
      { name: 'film.mkv', priority: 1, size: 5, progress: 1 },
      { name: 'film.sc.ass', priority: 1, size: 5, progress: 1 },
      { name: 'preview.mkv', priority: 1, size: 5, progress: 0.5 },
   ] }),
 };
 const f = await fixture(t, { qb, historyQb: qb, subtitleProbe: async (file) => {
   probed++; assert.equal(file, path.join(fs.realpathSync(root), 'film.mkv'));
   return [{ language: '简中', codec: 'ass' }];
 } });
 root = f.dir;
 f.c.qb.category = 'AniBT';
 atomicWrite(f.configFile, f.c);
 for (const name of ['film.mkv', 'film.sc.ass', 'preview.mkv']) fs.writeFileSync(path.join(root, name), 'media');
 const preview = (await f.request('history/task?hash=' + hash)).data;
 assert.deepEqual(preview.subtitleVideos, [{ index: 0, name: 'film.mkv' }]);
 assert.deepEqual(preview.sidecarSubtitles, [{ name: 'film.sc.ass', language: '简中' }]);
 assert.equal((await f.request('history/subtitles', { hash, index: 2 })).status, 400);
 assert.equal(probed, 0);
 assert.deepEqual((await f.request('history/subtitles', { hash, index: 0 })).data.tracks, [{ language: '简中', codec: 'ass' }]);
 assert.equal(probed, 1);
});

test('a manually downloaded film uses a work card without episode gap calculation', async () => {
  const { buildProgress } = await import('../src/progress.js');
  const hash='f'.repeat(40);
  const film={kind:'manual',origin:'discovery',status:'added',animeTitle:'Kimi to, Nami ni Noretara',title:'Film BD',hash,episode:'12'};
  const external=buildProgress({state:emptyState(),manual:{[hash]:film},torrents:[{hash,progress:1}],config:clone(defaults)});
  assert.equal(external.length,1);
  assert.equal(external[0].direct,true);
  assert.deepEqual(external[0].missing,[]);
  assert.equal(external[0].resources[0].status,'已完成');
  const subscription={...film,origin:'subscription'};
  const tracked=buildProgress({state:emptyState(),manual:{[hash]:subscription},config:clone(defaults)});
  assert.equal(tracked[0].direct,false);
  assert.equal(tracked[0].latest,12);
});

test('rankings can add a local watched work, preserve its review and recognize other sites without connecting the downloader', async t => {
  let downloaderCalls = 0, feedCalls = 0;
  const f = await fixture(t, {
    qb: { login: async () => { downloaderCalls++; throw Error('unexpected qB connection'); } },
    fetchFeed: async () => { feedCalls++; throw Error('unexpected RSS connection'); },
  });
  const first = { title:'示例动画', names:['Example Anime'], ids:{bangumi:'810',mal:'12'}, year:'2023', format:'tv' };
  const second = { title:'示例动画 第二季', names:['Example Anime 2nd Season','Example Anime'], ids:{bangumi:'811',mal:'13'}, year:'2025', format:'tv' };
  const alternate = { title:'Example Anime', names:[], ids:{anilist:'99',mal:'12'}, year:'2023', format:'TV' };
  const movie = { title:'同名电影', names:[], ids:{douban:'444'}, year:'2000', format:'movie' };
  const remake = { ...movie, ids:{douban:'555'}, year:'2025' };
  const status = async (...works) => (await f.request('ratings/watched/status',{ works })).data.items;
  // The ranking workflow also works on a fresh portable profile.
  atomicWrite(f.configFile, clone(defaults));
  assert.deepEqual(await status(first,second),[null,null]);
  const marked = await f.request('ratings/watched', first);
  assert.equal(marked.status, 200);
  assert.equal(marked.data.key, 'bgm:810');
  const watched = { key: marked.data.key, completedAt: marked.data.completedAt, watched: true };
  assert.deepEqual(await status(alternate,second),[{...watched,score:null},null]);
  const review = (await f.request('progress/review?key=bgm:810')).data;
  const saved = await f.request('progress/review',{key:marked.data.key,version:review.version,draftVersion:review.draftVersion,score:8.5,text:'从排行榜记录',rewatch:false});
  assert.equal(saved.status,200);
  assert.equal((await f.request('ratings/watched', alternate)).data.key,marked.data.key);
  assert.deepEqual(await status(first,second),[{...watched,score:8.5},null]);
  const movieKey = (await f.request('ratings/watched',movie)).data.key;
  assert.notEqual((await f.request('ratings/watched',remake)).data.key,movieKey);
  assert.equal((await f.request('ratings/watched',remake)).data.watched,true);
  assert.equal((await f.request('ratings/watched',{...first,ids:{mal:'invalid'}})).status,400);
  const library = await f.request('progress');
  assert.equal(library.status,200);
  assert.equal(library.data.shows.filter(show=>show.completedAt).length,3);
  assert.equal(library.data.shows.find(show=>show.key===marked.data.key).personalReview.score,8.5);
  const { exportBackup, validateBackup } = await import('../src/migration.js');
  const savedTracking = JSON.parse(fs.readFileSync(path.join(f.dir,'data/tracking.json'),'utf8'));
  const restored = validateBackup(exportBackup(f.c,emptyState(),savedTracking),f.c).backup;
  assert.equal(restored.tracking[marked.data.key].ratingIdentity.ids.anilist,'99');
  assert.deepEqual(restored.tracking[marked.data.key].rankWatchUndo,savedTracking[marked.data.key].rankWatchUndo);
  await f.request('progress/show/restore',{key:marked.data.key});
  assert.deepEqual(await status(first,second),[null,null]);
  assert.equal((await f.request('progress/review?key=bgm:810')).data.review.score,8.5);
  assert.equal(feedCalls,0);
  assert.equal(downloaderCalls,0);
});

test('canceling a ranking watch restores the earlier progress and preserves review or later episode edits', async t => {
  const f = await fixture(t, { qb: { login: async () => assert.fail('no downloader connection') } });
  const key='bgm:123', file=path.join(f.dir,'data/tracking.json');
  const at='2026-11-22T00:00:00Z';
  const prior={title:item.animeTitle,bgmId:'123',watched:1,startEpisode:1,episodeStates:{'2':false},archived:true,
    personalReview:{score:8,text:'早期评价',rewatch:false,createdAt:at,updatedAt:at}};
  atomicWrite(file,{[key]:prior});
  const state=emptyState();
  state.done[item.id]={...item,episode:'3',status:'added',at,hash:item.infoHash};
  atomicWrite(statePath(f.c,f.configFile),state);
  const read=()=>JSON.parse(fs.readFileSync(file,'utf8'))[key];
  const mark=()=>f.request('ratings/watched',{title:item.animeTitle,names:[],ids:{bangumi:'123'}});
  const undo=completedAt=>f.request('progress/show/restore',{key,completedAt});
  let marked=await mark();
  assert.equal(read().watched,3);
  assert.deepEqual(read().episodeStates,{'1':true,'2':true,'3':true});
  assert.equal((await undo(at)).status,409);
  assert.equal((await undo(marked.data.completedAt)).status,200);
  const reverted=read();
  for(const field of ['watched','episodeStates','archived','personalReview'])
    assert.deepEqual(reverted[field],prior[field]);
  assert.equal(reverted.completedAt,undefined);
  assert.equal(reverted.rankWatchUndo,undefined);
  marked=await mark();
  const edited=read();
  edited.watched=2;
  edited.episodeStates['3']=false;
  atomicWrite(file,{[key]:edited});
  assert.equal((await undo(marked.data.completedAt)).status,200);
  assert.equal(read().watched,2);
  assert.equal(read().episodeStates['3'],false);
  assert.deepEqual(read().personalReview,prior.personalReview);
});

test('old manual work titles are repaired for display without rekeying the viewing record', async () => {
  const { buildProgress } = await import('../src/progress.js');
  const { createDiscovery } = await import('../src/discover.js');
  const discovery = createDiscovery(() => ({}));
  const rows = [
    ['One Piece Fan Letter (BD', '[HatSubs] One Piece Fan Letter (BD 1080p 10-bit Opus) [3D18E382].mkv', 'One Piece Fan Letter'],
    ['Tokyo Godfathers (Dual Audio) [BDRip', '[CBM] Tokyo Godfathers (Dual Audio) [BDRip 1080p x265 10bit]', 'Tokyo Godfathers'],
    ['收藏译名', '[CBM] Tokyo Godfathers (Dual Audio) [BDRip 1080p x265 10bit]', '收藏译名'],
    ['Film (WEB', '[Team] Other Film (WEB 1080p)', 'Film (WEB'],
  ];
  try {
    for (const [animeTitle, title, expected] of rows) {
      const hash = 'e'.repeat(40), key = 'title:' + animeTitle.toLowerCase();
      const record = { origin: 'discovery', status: 'added', animeTitle, title, hash };
      const at = '2026-11-22T00:00:00Z';
      const tracking = { [key]: { title: animeTitle, completedAt: at, watched: 1 } };
      const [show] = buildProgress({ state: emptyState(), manual: { [hash]: record }, tracking, config: clone(defaults) });
      assert.equal(show.displayTitle, expected);
      assert.equal(show.key, key);
      assert.equal(show.title, animeTitle);
      assert.equal(show.completedAt, at);
      assert.equal(show.resources[0].title, title);
      const reopened = discovery.reopen(record);
      assert.equal(reopened.workTitle, expected);
      assert.equal(discovery.peek(reopened.resultId).animeTitle, animeTitle);
    }
  } finally {
    await discovery.close();
  }
});

test('marking an AniBT series watched excludes unassociated manual editions of the same work', async () => {
  const { showContext } = await import('../src/episode-actions.js');
  const hash='f'.repeat(40);
  const manual={[hash]:{kind:'manual',origin:'discovery',status:'added',animeTitle:item.animeTitle,bgmId:item.bgmId,title:'Unassociated edition',hash,episode:'12'}};
  const context=showContext({items:[item],state:emptyState(),manual,config:clone(defaults),key:'bgm:123'});
  assert.deepEqual(context.candidates,[{hash:item.infoHash,ambiguous:false}]);
  assert.equal(context.latest,1);
});

test('confirmed manual-work reset clears only the selected work and requires a fresh preview', async t => {
  let downloaderCalls = 0;
  const qb = { login: async () => { downloaderCalls++; throw Error('unexpected qB use'); } };
  const f = await fixture(t, { qb, manualQb: qb, episodeQb: qb });
  const hash = 'd'.repeat(40), otherHash = 'e'.repeat(40), key = 'bgm:678', legacyKey = 'title:旧译名';
  f.c.bindings = [{ bgmId: '678', title: '影片', aliases: ['旧译名'], canonicalTitle: '影片' }];
  atomicWrite(f.configFile, f.c);
  const manualFile = path.join(f.dir, 'data/manual-downloads.json');
  const trackingFile = path.join(f.dir, 'data/tracking.json');
  const draftsFile = path.join(f.dir, 'data/review-drafts.json');
  const complete = path.join(f.dir, 'data/completions.json');
  const archive = path.join(f.dir, 'data/completion-history.json');
  const parse = file => JSON.parse(fs.readFileSync(file));
  const at = '2026-11-15T00:00:00Z';
  const other = { hash: otherHash, bgmId: '679', animeTitle: '影片', episode: '1', title: 'Unrelated same-name work', at, kind: 'manual', origin: 'discovery', status:'added' };
  atomicWrite(manualFile, {
    [hash]: { hash, title: 'Original edition', animeTitle: '影片', episode: '1', at, kind: 'manual', origin:'discovery', ledgerId:'old-original-release', status:'added' },
    [otherHash]: other,
  });
  atomicWrite(trackingFile, { [legacyKey]:{title:'旧译名',completedAt:at,watched:1}, 'bgm:679':{title:'影片',bgmId:'679',watched:2} });
  atomicWrite(draftsFile, { [legacyKey]:{text:'draft'}, 'bgm:679':{text:'other'} });
  atomicWrite(complete, {version:1,tasks:{[hash]:{completed:true},[otherHash]:{completed:true}}});
  atomicWrite(archive, [{hash,at},{hash:otherHash,at}]);
  const ledger = emptyState();
  ledger.done[item.id] = {...item,hash:item.infoHash,status:'added',at};
  ledger.episodes['bgm:678:1:v1'] = 'old-original-release';
  ledger.episodes['bgm:679:1:v1'] = otherHash;
  atomicWrite(statePath(f.c,f.configFile),ledger);
  const preview = () => f.request('progress/manual/reset/preview', {key});
  const confirmed = (version, confirm = true) => f.request('progress/manual/reset', {key,version,confirm});
  const initial = await preview();
  assert.equal(initial.status,200); assert.equal(initial.data.records,1);
  assert.equal((await confirmed(initial.data.version,false)).status,400);
  const modified = parse(draftsFile); modified[legacyKey].text = 'new draft'; atomicWrite(draftsFile,modified);
  assert.equal((await confirmed(initial.data.version)).status,409);
  assert.equal(parse(manualFile)[hash].hash,hash);
  assert.equal((await confirmed((await preview()).data.version)).data.removed,1);
  assert.deepEqual(parse(manualFile),{[otherHash]:other});
  assert.equal(parse(trackingFile)[legacyKey],undefined);
  assert.equal(parse(trackingFile)['bgm:679'].watched,2);
  assert.equal(parse(draftsFile)[legacyKey],undefined);
  assert.equal(parse(complete).tasks[hash],undefined);
  assert.deepEqual(parse(archive),[{hash:otherHash,at}]);
  const state = parse(statePath(f.c,f.configFile));
  assert.equal(state.episodes['bgm:678:1:v1'],undefined);
  assert.equal(state.episodes['bgm:679:1:v1'],otherHash);
  assert.equal(state.done[item.id].status,'added');
  assert.equal(downloaderCalls,0);
});

test('a restored manual work reopens its exact original torrent and preserves file selection', async t => {
  const hash = 'd'.repeat(40), key='title:影片', at='2026-11-15T00:00:00Z';
  const qb = { login:async()=> '5.2.4', logout:async()=>{}, list:async()=>[], request:async()=>Response.json({save_path:'D:/Videos'}) };
  const { createDiscovery } = await import('../src/discover.js');
  const reads = [];
  const discovery = createDiscovery(()=>({}), {network:{cacheKey:()=>'',read:async url=>{reads.push(url);throw Error('test: use stored hash fallback');}}});
  const f=await fixture(t,{qb,discovery,discoveryFileQb:{...qb,discoveryFileManifest:async item=>{
    assert.equal(item.infoHash,hash);
    return ['Movie.mkv','Movie.JPSC.ass','Movie.JPTC.ass','[Fonts].7z'].map(path=>({path,size:30}));
  }}});
  atomicWrite(path.join(f.dir,'data/manual-downloads.json'),{[hash]:{hash,kind:'manual',origin:'discovery',status:'added',animeTitle:'影片',title:'Original edition',at,selectiveDownload:true,savePath:'D:/Videos/影片',sourceLinks:[{url:'https://nyaa.si/view/1234'}]}});
  atomicWrite(path.join(f.dir,'data/tracking.json'),{[key]:{title:'影片',completedAt:at,watched:1}});
  assert.equal((await f.request('progress/show/restore',{key})).status,200);
  const show = (await f.request('progress')).data.shows.find(s=>s.key===key);
  assert.equal(show.completedAt,undefined);
  assert.equal(show.resources[0].progress,null);
  const reopened=await f.request('discover/reopen',{key:show.resources[0].reDownloadKey});
  assert.equal(reopened.status,200);
  assert.equal(reopened.data.item.infoHash,hash);
  assert.equal(reopened.data.savePath,'D:/Videos/影片');
  const preview=await f.request('discover/files',{resultId:reopened.data.item.resultId});
  assert.equal(preview.status,200);
  assert.deepEqual(preview.data.files.map(row=>row.recommended),[true,true,false,true]);
  assert.deepEqual(reads,['https://nyaa.si/download/1234.torrent']);
});

test('confirmed whole-work cleanup waits for mpv before removing its qB task and nested folders', async t => {
  const hash = 'f'.repeat(40), key = 'title:film';
  let root, folder, content, file, torrents = [], blocked = true;
  const actions = [];
  const qb = { login: async () => {}, logout: async () => {}, list: async () => torrents,
    request: async name => {
      if (name === 'app/preferences') return Response.json({ save_path: root });
      if (name === 'torrents/files') return Response.json([{ name: 'edition/film.mkv', size: 3, priority: 1 }]);
      assert.equal(name, 'torrents/delete');
      actions.push('delete');
      fs.unlinkSync(file);
      torrents = [];
      return new Response(null, { status: 204 });
    },
  };
  const f = await fixture(t, { episodeQb: qb, fetchFeed: async () => [], closeMpvForTargets: async targets => {
    assert.equal(targets[0].hash, hash);
    if (blocked) throw Error('mpv still open');
    actions.push('close');
    return 1;
  } });
  root = path.join(f.dir, 'downloads'); folder = path.join(root, 'Film');
  content = path.join(folder, 'edition'); file = path.join(content, 'film.mkv');
  fs.mkdirSync(content, { recursive:true }); fs.writeFileSync(file, 'abc');
  torrents = [{ hash, name:'Film release', content_path:content, save_path:folder }];
  atomicWrite(path.join(f.dir,'data/manual-downloads.json'), { [hash]:{ hash, title:'Film release', animeTitle:'Film', kind:'manual', origin:'discovery', status:'added', at:new Date().toISOString() } });
  const preview = () => f.request('progress/show/prepare',{key});
  const confirm = async () => f.request('progress/show/confirm',{id:(await preview()).data.id,confirm:true});
  assert.match((await confirm()).data.error,/mpv still open/);
  assert.deepEqual(actions,[]);
  assert.ok(fs.existsSync(file));
  blocked = false;
  const result = await confirm();
  assert.equal(result.status,200);
  assert.deepEqual(actions,['close','delete']);
  assert.equal(fs.existsSync(folder),false);
  assert.ok(fs.existsSync(root));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clone, defaults, validateConfig, atomicWrite, redactedConfig, protectPassword } from '../src/config.js';
import { parseFeed, matches } from '../src/feed.js';
import { runOnce, loadState, emptyState, lock } from '../src/runner.js';
import { QbClient } from '../src/qb.js';
import http from 'node:http';

const wrap = inner=>`<rss version="2.0" xmlns:anibt="https://anibt.net/xmlns/rss/1.0/"><channel><title>test</title>${inner}</channel></rss>`;
const hash = 'a'.repeat(40);
const modern = wrap(`<item><title>[TestGroup] 测试番 [01][简繁]</title><guid>r1</guid><anibt:bgmId>123</anibt:bgmId><anibt:animeTitle>测试番</anibt:animeTitle><anibt:episodeKey>01</anibt:episodeKey><anibt:groupName>TestGroup</anibt:groupName><anibt:groupSlug>test-group</anibt:groupSlug><anibt:language>CHS</anibt:language><anibt:language>CHT</anibt:language><anibt:resolution>1080p</anibt:resolution><anibt:subtitle>INTERNAL</anibt:subtitle><torrent><infohash>${hash}</infohash></torrent><enclosure url="https://anibt.net/api/torrent/rel_test.torrent"/></item>`);
const legacy = wrap(`<item><title>[TestGroup] 测试番 [01][1080P][简繁内封]</title><guid isPermaLink="false">r2</guid><description><![CDATA[<p><strong>测试番 / Test Anime</strong> · 1 · v1</p><p>https://bgm.tv/subject/123</p><p>🏷️ TestGroup · 📺 1080p · 🌐 CHS+CHT · 💬 INTERNAL · 📁 MKV</p>]]></description><torrent><infohash>${hash}</infohash></torrent><enclosure url="https://anibt.net/api/torrent/rel_test.torrent"/></item>`);
test('public and actual personal RSS schema agree on metadata and episode identity',()=>{
  const a=parseFeed(modern)[0], b=parseFeed(legacy)[0];
  assert.equal(a.episodeKey,b.episodeKey);
  assert.deepEqual(b.languages,['CHS','CHT']);
  assert.equal(b.bgmId,'123'); assert.equal(b.groupName,'TestGroup');
  assert.equal(b.infoHash,hash); assert.equal(b.subtitles[0],'INTERNAL');
});
test('CHS mandatory, traditional-only rejected; absent language fails closed',()=>{
  const item=parseFeed(modern)[0]; assert.equal(matches(item,defaults).ok,true);
  item.languages=['CHT']; assert.equal(matches(item,defaults).ok,false);
  item.languages=[]; assert.equal(matches(item,defaults).ok,false);
});
test('group matching is exact and supports names, slugs, and joint group brackets',()=>{
  const c=clone(defaults),i=parseFeed(modern)[0];
  c.filters.groups=['test-group']; assert.equal(matches(i,c).ok,true);
  c.filters.groups=['Test']; assert.equal(matches(i,c).ok,false);
  c.filters.groups=['Partner'];i.title='[Partner&TestGroup] test';assert.equal(matches(i,c).ok,true);
});
test('per-anime override inherits CHS requirement and can disable an anime',()=>{
  const c=clone(defaults),i=parseFeed(modern)[0];c.filters.groups=['Else'];c.rules=[{bgmId:123,groups:['test-group']}];
  assert.equal(matches(i,c).ok,true); i.languages=['CHT']; assert.equal(matches(i,c).ok,false);
  c.rules[0].enabled=false;i.languages=['CHS'];assert.equal(matches(i,c).ok,false);
});
test('bad XML, HTML, DTD and off-site enclosure are rejected',()=>{
  assert.throws(()=>parseFeed('<html>login</html>'));
  assert.throws(()=>parseFeed('<rss><channel></rss>'));
  assert.throws(()=>parseFeed('<!DOCTYPE rss><rss><channel/></rss>'));
  const i=parseFeed(modern.replace('https://anibt.net/api/torrent/rel_test.torrent','https://evil.test/a.torrent'))[0];assert.equal(i.torrentUrl,'');
  assert.equal(parseFeed(wrap('')).length,0);
});
test('baseline and preview do not contact qB; backfill deduplicates episode variants',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cfg=clone(defaults); cfg.rssUrl='https://anibt.net/rss/subscriptions.xml?key=test';const file=path.join(dir,'config.json');
  const items=[parseFeed(modern)[0],parseFeed(legacy)[0]]; let adds=0;
  const qb={login:async()=>{},ensureCategory:async()=>{},list:async()=>[],add:async()=>{adds++;},logout:async()=>{}};
  const deps={fetchFeed:async()=>items,qb,log:()=>{}};
  await runOnce(cfg,file,{dryRun:true},deps);assert.equal(fs.existsSync(path.join(dir,'data/state.json')),false);
  let report=await runOnce(cfg,file,{},deps);assert.equal(report.baseline,2);assert.equal(adds,0);
  report=await runOnce(cfg,file,{backfill:true},deps);assert.equal(report.added,1);assert.equal(adds,1);
  report=await runOnce(cfg,file,{backfill:true},deps);assert.equal(report.added,0);assert.equal(adds,1);
});
test('new post-baseline releases are downloaded and v2 is not suppressed',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-new-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cfg=clone(defaults); cfg.rssUrl='https://anibt.net/rss/subscriptions.xml?key=test';const file=path.join(dir,'config.json');
  let items=[];let adds=0;const qb={login:async()=>{},ensureCategory:async()=>{},list:async()=>[],add:async()=>{adds++;},logout:async()=>{}};const deps={fetchFeed:async()=>items,qb,log:()=>{}};
  await runOnce(cfg,file,{},deps);items=parseFeed(modern);await runOnce(cfg,file,{},deps);assert.equal(adds,1);
  items=[{...items[0],id:'r3',version:'v2',episodeKey:'测试番:1:v2',infoHash:'b'.repeat(40)}];await runOnce(cfg,file,{},deps);assert.equal(adds,2);
});
test('failed additions stay queued and retry after falling out of RSS',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-retry-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cfg=clone(defaults);cfg.firstRun='download';cfg.rssUrl='https://anibt.net/rss/subscriptions.xml?key=test';const file=path.join(dir,'config.json');
  let items=parseFeed(modern),fail=true,adds=0;const qb={login:async()=>{},ensureCategory:async()=>{},list:async()=>[],add:async()=>{if(fail)throw new Error('fail');adds++;},logout:async()=>{}};
  const deps={fetchFeed:async()=>items,qb,log:()=>{}};const sfile=path.join(dir,'data/state.json');
  let report=await runOnce(cfg,file,{},deps);assert.equal(report.failed,1);assert.equal(Object.keys(loadState(sfile).pending).length,1);
  items=[];fail=false;deps.now=()=>loadState(sfile).pending[Object.keys(loadState(sfile).pending)[0]].nextRetryAt+1;report=await runOnce(cfg,file,{},deps);assert.equal(report.added,1);assert.equal(adds,1);assert.equal(Object.keys(loadState(sfile).pending).length,0);
});
test('existing qB torrent is recorded without an add after crash/restart',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-exists-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const c=clone(defaults);c.firstRun='download';c.rssUrl='https://anibt.net/rss/subscriptions.xml?key=test';let adds=0;
  const qb={login:async()=>{},ensureCategory:async()=>{},list:async()=>[{hash}],add:async()=>{adds++;},logout:async()=>{}};
  const r=await runOnce(c,path.join(dir,'config.json'),{},{fetchFeed:async()=>parseFeed(modern),qb,log:()=>{}});assert.equal(r.existing,1);assert.equal(adds,0);
});
test('invalid feed does not initialize state',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-bad-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const c=clone(defaults);c.rssUrl='https://anibt.net/rss/subscriptions.xml?key=test';
  await assert.rejects(runOnce(c,path.join(dir,'config.json'),{},{fetchFeed:async()=>{throw new Error('bad xml');}}));assert.equal(fs.existsSync(path.join(dir,'data/state.json')),false);
});
test('state corruption stops; process lock prevents two watchers',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-lock-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'state.json');
  atomicWrite(file,emptyState());assert.equal(loadState(file).version,1);fs.writeFileSync(file,'oops');assert.throws(()=>loadState(file));
  const unlock=lock(file+'.lock');assert.throws(()=>lock(file+'.lock'));unlock();const unlock2=lock(file+'.lock');unlock2();
});
test('configuration secrets are redacted and validation rejects wrong RSS hosts',()=>{
  const c=clone(defaults);c.rssUrl='https://anibt.net/rss/subscriptions.xml?key=secret';c.qb.password='private';
  validateConfig(c);const out=JSON.stringify(redactedConfig(c));assert.equal(out.includes('secret'),false);assert.equal(out.includes('private'),false);
  c.rssUrl='https://evil.test/rss/feed.xml';assert.throws(()=>validateConfig(c));
});
test('Windows DPAPI roundtrip',{skip:process.platform!=='win32'},()=>{const encrypted=protectPassword('Test 密码! 123');assert.notEqual(encrypted,'Test 密码! 123');assert.equal(protectPassword(encrypted,true),'Test 密码! 123');});
for (const variant of ['legacy','empty','json']) test(`qB ${variant} response, session cookie, multipart add and stopped flags`,async t=>{
  const status=variant==='empty'?204:200;
  let added=false,sawStopped=false;
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks).toString();
    if(req.url.endsWith('/auth/login')){res.setHeader('Set-Cookie',`${status===204?'QBT_SID_8081':'SID'}=test; HttpOnly`);res.statusCode=status;res.end(status===204?'':body.includes('password=pw')?'Ok.':'Fails.');return;}
    assert.equal(req.headers.cookie,`${status===204?'QBT_SID_8081':'SID'}=test`);assert.ok(req.headers.referer);
    if(req.url.endsWith('/app/version'))res.end('v5.2.0');
    else if(req.url.startsWith('/api/v2/torrents/info'))res.end(JSON.stringify(added?[{hash}]:[]));
    else if(req.url.endsWith('/torrents/add')){sawStopped=/name="stopped"\r\n\r\ntrue/.test(body)&&/name="paused"\r\n\r\ntrue/.test(body);added=true;res.statusCode=status;res.end(variant==='json'?JSON.stringify({added_torrent_ids:[hash],failure_count:0,pending_count:0,success_count:1}):status===204?'':'Ok.');}
    else res.end('Ok.');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const c=clone(defaults);c.qb.url=`http://127.0.0.1:${server.address().port}`;c.qb.password='pw';c.qb.paused=true;
  const qb=new QbClient(c);assert.equal(await qb.login(),'v5.2.0');await qb.add({...parseFeed(modern)[0],torrentUrl:''});assert.equal(sawStopped,true);await qb.logout();
});

// Selection must never widen into a whole-feed or pending-queue operation.
test('backfill only submits selected releases and leaves the first-run remainder as baseline',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-selected-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cfg=clone(defaults);cfg.rssUrl='https://anibt.net/rss/subscriptions.xml?key=test';const file=path.join(dir,'config.json');const a=parseFeed(modern)[0];
  const b={...a,id:'episode-2',episode:'2',episodeKey:'测试番:2:v1',infoHash:'b'.repeat(40)},other={...a,id:'other-anime',bgmId:'456',animeTitle:'另一番',episodeKey:'另一番:1:v1',infoHash:'c'.repeat(40)};
  const added=[];const qb={login:async()=>{},ensureCategory:async()=>{},list:async()=>[],add:async item=>added.push(item.id),logout:async()=>{}};
  const deps={fetchFeed:async()=>[a,b,other],qb,log:()=>{}};
  const r=await runOnce(cfg,file,{backfill:true,selectedIds:[b.id]},deps);assert.equal(r.added,1);assert.deepEqual(added,[b.id]);
  const state=loadState(path.join(dir,'data/state.json'));assert.deepEqual(Object.keys(state.done),[b.id]);assert.deepEqual(Object.keys(state.pending),[]);
  assert.equal(state.sources[Object.keys(state.sources)[0]].baselineIds.length,3);
  await runOnce(cfg,file,{},deps);assert.deepEqual(added,[b.id]);
  await runOnce(cfg,file,{backfill:true,selectedIds:[a.id]},deps);assert.deepEqual(added,[b.id,a.id]);
});

test('selected backfill preserves unrelated pending retries and still deduplicates selected group alternatives',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-selected-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cfg=clone(defaults);cfg.rssUrl='https://anibt.net/rss/subscriptions.xml?key=test';const file=path.join(dir,'config.json'),a=parseFeed(modern)[0],b={...a,id:'alternative',infoHash:'b'.repeat(40)},old={...a,id:'unrelated-retry',episodeKey:'测试番:9:v1',episode:'9',infoHash:'c'.repeat(40)};
  const {sourceKey}=await import('../src/feed.js');const state=emptyState();state.pending[old.id]={item:old,source:sourceKey(cfg.rssUrl),lastError:'previous failure'};atomicWrite(path.join(dir,'data/state.json'),state);
  const added=[];const qb={login:async()=>{},ensureCategory:async()=>{},list:async()=>[],add:async item=>added.push(item.id),logout:async()=>{}};
  const report=await runOnce(cfg,file,{backfill:true,selectedIds:[a.id,b.id]},{fetchFeed:async()=>[a,b],qb,log:()=>{}});assert.equal(report.added,1);assert.equal(added.length,1);
  assert.deepEqual(loadState(path.join(dir,'data/state.json')).pending[old.id],{...state.pending[old.id],item:{...old,episodeKey:'bgm:123:9:v1'}});
});

test('empty or stale backfill selection fails before writes or download connections',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-selected-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const cfg=clone(defaults);cfg.rssUrl='https://anibt.net/rss/subscriptions.xml?key=test';const file=path.join(dir,'config.json');let contacts=0;
  const deps={fetchFeed:async()=>parseFeed(modern),qb:{login:async()=>contacts++},log:()=>{}};
  await assert.rejects(runOnce(cfg,file,{backfill:true,selectedIds:[]},deps),/勾选/);
  await assert.rejects(runOnce(cfg,file,{backfill:true,selectedIds:['expired-id']},deps),/清单/);
  await assert.rejects(runOnce(cfg,file,{backfill:true,selectedIds:[parseFeed(modern)[0].id]},{...deps,fetchFeed:async()=>parseFeed(modern).map(i=>({...i,languages:['CHT']}))}),/清单/);
  assert.equal(contacts,0);assert.equal(fs.existsSync(path.join(dir,'data/state.json')),false);
});

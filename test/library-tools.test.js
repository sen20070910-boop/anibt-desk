import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {defaults,clone,atomicWrite} from '../src/config.js';
import {maybeAutomaticBackup,listAutomaticBackups,readAutomaticBackup,setBackupSettings,noteFeedSuccess,continuityStatus,acknowledgeContinuity} from '../src/continuity.js';
import {getReviewDraft,writeReviewDraft} from '../src/review-drafts.js';
import {normalizeRepository,releaseInformation} from '../src/release-info.js';
import {exportBackup,validateBackup} from '../src/migration.js';
import {digest} from '../src/episode-actions.js';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'library-six-')),file=path.join(dir,'config.json'),config=clone(defaults);config.rssUrl='https://anibt.net/rss/subscriptions.xml?key=PRIVATE_RSS';config.qb.password='PRIVATE_PASSWORD';atomicWrite(file,config);fs.mkdirSync(path.join(dir,'data'),{recursive:true});t.after(()=>{if(!dir.startsWith(path.join(os.tmpdir(),'library-six-')))throw new Error('test path mismatch');fs.rmSync(dir,{recursive:true,force:true});});return{dir,file,config};}
test('automatic backups are daily, bounded, retain drafts and omit connection credentials',t=>{
 const f=fixture(t);setBackupSettings(f.file,{enabled:true,keep:3});fs.writeFileSync(path.join(f.dir,'data/state.json.lock'),String(process.pid));atomicWrite(path.join(f.dir,'data/review-drafts.json'),{'bgm:123':{score:9,text:'草稿',rewatch:true,baseVersion:digest(null),updatedAt:'2026-11-01T00:00:00Z'}});
 for(let day=1;day<=5;day++)assert.equal(maybeAutomaticBackup(f.file,{now:Date.parse('2026-11-0'+day+'T00:00:00Z')}).ran,true);
 const list=listAutomaticBackups(f.file);assert.equal(list.length,3);assert.equal(maybeAutomaticBackup(f.file,{now:Date.parse('2026-11-05T12:00:00Z')}).ran,false);const backup=readAutomaticBackup(f.file,list[0].id),text=JSON.stringify(backup);assert.ok(!text.includes('PRIVATE_RSS'));assert.ok(!text.includes('PRIVATE_PASSWORD'));assert.equal(backup.reviewDrafts['bgm:123'].text,'草稿');assert.throws(()=>readAutomaticBackup(f.file,'../tracking.json'));
 setBackupSettings(f.file,{enabled:false,keep:3});assert.equal(maybeAutomaticBackup(f.file,{now:Date.parse('2026-11-06T00:00:00Z')}).ran,false);assert.equal(maybeAutomaticBackup(f.file,{force:true,now:Date.parse('2026-11-06T00:00:00Z')}).ran,true);
});
test('offline continuity detects only successful-feed gaps and keeps reminder until acknowledgement',t=>{
 const f=fixture(t),at=Date.parse('2026-11-05T00:00:00Z');noteFeedSuccess(f.file,{now:at});assert.equal(continuityStatus(f.file).needsCheck,false);noteFeedSuccess(f.file,{now:at+8*3600000});assert.equal(continuityStatus(f.file).gapHours,8);noteFeedSuccess(f.file,{now:at+9*3600000});assert.equal(continuityStatus(f.file).needsCheck,true);acknowledgeContinuity(f.file);assert.equal(continuityStatus(f.file).needsCheck,false);
});
test('drafts survive reopening, use revisions, and round-trip through backup with historical reviews',t=>{
 const f=fixture(t),key='bgm:123',first=getReviewDraft(f.file,key);const written=writeReviewDraft(f.file,key,{draftVersion:first.draftVersion,baseVersion:digest(null),score:8.5,text:'未写完\n继续',rewatch:true});assert.equal(getReviewDraft(f.file,key).draft.text,'未写完\n继续');assert.throws(()=>writeReviewDraft(f.file,key,{draftVersion:first.draftVersion,baseVersion:digest(null),score:9,text:'stale'}),/其他窗口/);
 const review={score:8,text:'初看',createdAt:'2026-11-05T00:00:00Z',updatedAt:'2026-11-05T00:00:00Z'},tracking={[key]:{title:'Test',bgmId:'123',watched:0,startEpisode:1,archived:false,watchSessions:[{id:'past',completedAt:'2026-11-05T00:00:00Z',personalReview:review}]}};
 const backup={...exportBackup(f.config,{done:{},episodes:{},sources:{}},tracking),reviewDrafts:{[key]:written.draft}},round=validateBackup(backup,f.config).backup;assert.equal(round.reviewDrafts[key].score,8.5);assert.equal(round.tracking[key].watchSessions[0].personalReview.text,'初看');
});
test('release checks accept a configured public repository and never trust foreign release links',()=>{
 assert.equal(normalizeRepository('owner/project'),'owner/project');for(const repo of ['https://github.com/owner/project','a/../b','x/..'])assert.throws(()=>normalizeRepository(repo));
 const payload={tag_name:'v999.0.0',html_url:'https://github.com/owner/project/releases/tag/v999.0.0',body:'说明'};assert.equal(releaseInformation(payload,'owner/project').newer,true);assert.throws(()=>releaseInformation({...payload,html_url:'https://evil.test/release'},'owner/project'));assert.throws(()=>releaseInformation({...payload,prerelease:true},'owner/project'));
});


test('review draft is recoverable after the entire GUI server is recreated',async t=>{
 const {makeApplication}=await import('../src/gui-server.js'),http=await import('node:http'),f=fixture(t);atomicWrite(path.join(f.dir,'data/tracking.json'),{'bgm:123':{title:'测试',bgmId:'123',watched:1,startEpisode:1,archived:false}});let server;
 const start=async()=>{const app=makeApplication({configFile:f.file,token:'restart-test',deps:{backgroundStatus:()=>({running:false}),fetchFeed:async()=>[]}});server=http.createServer(app.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));return async(route,body)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/'+route,{headers:{'X-App-Token':'restart-test',...(body?{'Content-Type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});return response.json();};};
 try{let request=await start(),initial=await request('progress/review?key=bgm:123');await request('progress/review/draft',{key:'bgm:123',baseVersion:initial.version,draftVersion:initial.draftVersion,score:8,text:'进程重启后恢复'});await new Promise(r=>server.close(r));request=await start();const result=await request('progress/review?key=bgm:123');assert.equal(result.review,null);assert.equal(result.draft.text,'进程重启后恢复');}finally{if(server?.listening)await new Promise(r=>server.close(r));}
});

test('official release checking works without configuration and reuses its daily cache', async () => {
 const { createReleaseChecker, OFFICIAL_REPOSITORY } = await import('../src/release-info.js');
 let saved, calls = 0;
 const newChecker = () => createReleaseChecker({ read: () => saved, write: value => { saved = value; }, network: {
   read: async url => {
      calls++;
      const repo = new URL(url).pathname.replace(/^\/repos\//, '').replace(/\/releases\/latest$/, '');
      return { text: JSON.stringify({ tag_name: 'v999.0.0', html_url: 'https://github.com/' + repo + '/releases/tag/v999.0.0' }) };
   },
 } });
 const checker = newChecker();
 assert.equal(checker.settings().repository, OFFICIAL_REPOSITORY);
 assert.equal((await checker.check()).newer, true);
 assert.equal((await newChecker().check()).latestVersion, '999.0.0');
 assert.equal(calls, 1);
 await checker.check({ force: true });
 assert.equal(calls, 2);
 checker.setRepository('owner/project');
 assert.match((await checker.check()).url, /owner\/project/);
 assert.equal(calls, 3);
 checker.setRepository('');
 assert.equal(checker.settings().repository, OFFICIAL_REPOSITORY);
});

test('when the GitHub API is rate-limited, the public latest redirect supplies the stable release', async () => {
 const { createReleaseChecker, OFFICIAL_REPOSITORY } = await import('../src/release-info.js');
 const path = '/' + OFFICIAL_REPOSITORY;
 const attempted = [];
 const newChecker = location => createReleaseChecker({ read:()=>({}), write:()=>{}, network: { read:async (url, options)=>{
   attempted.push(url);
   if (url.startsWith('https://api.github.com/')) throw Error('HTTP 403');
   assert.equal(options.releaseRedirect, true);
   return {location};
 } } });
 const release = await newChecker(path + '/releases/tag/v999.0.0').check({force:true});
 assert.equal(release.newer, true);
 assert.equal(release.url,'https://github.com' + path + '/releases/tag/v999.0.0');
 assert.deepEqual(attempted, ['https://api.github.com/repos' + path + '/releases/latest','https://github.com' + path + '/releases/latest']);
 await assert.rejects(() => newChecker('https://example.test' + path + '/releases/tag/v999.0.0').check(), /发布页面地址不符/);
});

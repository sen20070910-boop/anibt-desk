import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {clone,defaults,validateConfig,validateDownloadPath,validateStartDate} from '../src/config.js';
import {matches,effectiveFilters} from '../src/feed.js';
import {animeFolderName,animeDownloadPath} from '../src/download-path.js';
import {QbClient} from '../src/qb.js';
import {runOnce,loadState} from '../src/runner.js';
const item={id:'student-1',title:'[测试组] 学生会 01',animeTitle:'学生会',bgmId:'123',episode:'1',version:'v1',episodeKey:'学生会:1:v1',infoHash:'a'.repeat(40),languages:['CHS'],subtitles:[],resolution:'1080p',groupName:'测试组',groupSlug:'test',publishedAt:'2026-11-01T16:00:00Z'};
const config=()=>({...clone(defaults),rssUrl:'https://anibt.net/rss/subscriptions.xml?key=test'});

test('automatic destinations use qB default root plus show name; explicit show and root overrides stay independent',()=>{
 const c=config();assert.equal(animeDownloadPath(item,c,'D:/Downloads'),String.raw`D:\Downloads\学生会`);
 assert.equal(animeDownloadPath({...item,animeTitle:'另一番',bgmId:'456'},c,'D:/Downloads'),String.raw`D:\Downloads\另一番`);
 c.rules=[{bgmId:'123',savePath:'E:/Shows/学生会'}];assert.equal(animeDownloadPath(item,c,'D:/Downloads'),'E:/Shows/学生会');
 assert.equal(animeDownloadPath({...item,bgmId:'456'},c,'D:/Downloads'),String.raw`D:\Downloads\学生会`);
 c.rules[0].savePath='';c.qb.savePath='F:/Anime';assert.equal(animeDownloadPath(item,c,'D:/Downloads'),String.raw`F:\Anime\学生会`);
 c.qb.savePath='';assert.equal(animeDownloadPath(item,c,'/downloads'),'/downloads/学生会');assert.throws(()=>animeDownloadPath(item,c,''),/默认下载目录/);
});

test('automatic folder names retain Chinese while preventing traversal, invalid Windows names and empty names',()=>{
 assert.equal(animeFolderName(item),'学生会');assert.equal(animeFolderName({...item,animeTitle:'CON'}),'_CON');assert.equal(animeFolderName({...item,animeTitle:'...'}),'未命名番剧');
 const c=config(),root='D:/Downloads',output=animeDownloadPath({...item,animeTitle:'../学生会\\番:*?'},c,root);const rel=path.win32.relative(root,output);assert.equal(path.win32.isAbsolute(rel),false);assert.equal(rel.includes('..\\'),false);assert.equal(/[\\/:*?<>|]/.test(rel),false);
 assert.ok([...animeFolderName({...item,animeTitle:'漫'.repeat(200)})].length<=100);
});

test('rule dates validate calendar days and directories require full paths before config can be saved',()=>{
 const c=config();c.rules=[{bgmId:'123',savePath:'D:/Shows/学生会',startDate:'2026-11-02'}];assert.doesNotThrow(()=>validateConfig(c));
 for(const value of ['2026-02-30','2026-2-2','not-date'])assert.throws(()=>validateStartDate(value));assert.equal(validateStartDate('2024-02-29'),'2024-02-29');
 for(const value of ['学生会','D:Anime','\\Anime','D:/bad*name',42])assert.throws(()=>validateDownloadPath(value));
 c.rules[0].savePath='relative';assert.throws(()=>validateConfig(c),/单番下载目录/);
});

test('start-date filtering includes Beijing midnight and per-show dates can override or clear the global cutoff',()=>{
 const c=config(),now=new Date('2026-11-03T01:00:00Z');c.startDate='2026-11-02';assert.equal(matches(item,c,now).ok,true);
 assert.equal(matches({...item,publishedAt:'2026-11-01T15:59:59Z'},c,now).ok,false);
 assert.match(matches({...item,publishedAt:''},c,now).reason,/发布时间未知/);
 c.rules=[{bgmId:'123',startDate:''}];assert.equal(effectiveFilters(item,c).startDate,'');assert.equal(matches({...item,publishedAt:'2020-01-01T00:00:00Z'},c,now).ok,true);
 c.rules[0].startDate='2026-11-03';assert.equal(matches(item,c,now).ok,false);c.rules[0].startDate='9999-01-01';assert.match(matches(item,c,now).reason,/尚未到/);
 c.rules[0]={title:'学生会',startDate:'2026-11-02'};assert.equal(matches(item,c,now).ok,true);
});

function mockQb(c){const qb=new QbClient(c),forms=[];let prefs=0;qb.connectForDownload=async()=>{};qb.ensureCategory=async()=>{};qb.list=async()=>[];qb.has=async()=>true;qb.logout=async()=>{};qb.request=async(method,body)=>{if(method==='app/preferences'){prefs++;return{json:async()=>({save_path:'D:/Downloads'})};}if(method==='torrents/add'){forms.push(body);return{text:async()=> 'Ok.'};}throw new Error(method);};return{qb,forms,prefs:()=>prefs};}

test('qB receives per-show savepath and explicit management flags while default-root discovery is cached',async()=>{
 const c=config(),f=mockQb(c);await f.qb.add(item,{organizeByAnime:true});await f.qb.add({...item,id:'another',animeTitle:'另一番'},{organizeByAnime:true});
 assert.equal(f.forms[0].get('savepath'),String.raw`D:\Downloads\学生会`);assert.equal(f.forms[1].get('savepath'),String.raw`D:\Downloads\另一番`);assert.equal(f.forms[0].get('autoTMM'),'false');assert.equal(f.prefs(),1);assert.equal(c.qb.savePath,'');
 const manual=mockQb(c);await manual.qb.add(item);assert.equal(manual.forms[0].has('savepath'),false);assert.equal(manual.prefs(),0);
 c.rules=[{bgmId:'123',savePath:'E:/Custom'}];const explicit=mockQb(c);await explicit.qb.add(item,{organizeByAnime:true});assert.equal(explicit.forms[0].get('savepath'),'E:/Custom');assert.equal(explicit.prefs(),0);
});

test('automatic runs and selected backfills organize by show and preserve date filtering',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-paths-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const c=config();c.firstRun='download';const f=mockQb(c),file=path.join(dir,'config.json');
 const report=await runOnce(c,file,{},{fetchFeed:async()=>[item],qb:f.qb,log:()=>{}});assert.equal(report.added,1);assert.equal(f.forms[0].get('savepath'),String.raw`D:\Downloads\学生会`);assert.equal(loadState(path.join(dir,'data/state.json')).done[item.id].savePath,String.raw`D:\Downloads\学生会`);
 const next={...item,id:'student-2',episode:'2',episodeKey:'学生会:2:v1',infoHash:'b'.repeat(40)},f2=mockQb(c);await runOnce(c,file,{backfill:true,selectedIds:[next.id]},{fetchFeed:async()=>[item,next],qb:f2.qb,log:()=>{}});assert.equal(f2.forms[0].get('savepath'),String.raw`D:\Downloads\学生会`);
 c.startDate='9999-01-01';const blocked=mockQb(c);await assert.rejects(runOnce(c,file,{backfill:true,selectedIds:[next.id]},{fetchFeed:async()=>[next],qb:blocked.qb,log:()=>{}}),/筛选条件/);assert.equal(blocked.forms.length,0);
});

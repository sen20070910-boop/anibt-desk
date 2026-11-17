import test from 'node:test';
import assert from 'node:assert/strict';
import {catchupTiming,catchupRecommendations} from '../src/catchup.js';
import {clone,defaults} from '../src/config.js';
import {catalogAnime} from '../src/anibt-catalog.js';

test('catchup compares Beijing quarter boundaries; past quarter does not imply finished',()=>{
 const now=new Date('2026-03-31T16:00:00Z');
 assert.deepEqual(catchupTiming({year:2026,season:'WINTER',status:'FINISHED'},now),{season:'2026冬',currentSeason:'2026春',older:true,finished:true,offer:true});
 assert.equal(catchupTiming({year:2026,season:'WINTER',status:'RELEASING'},now).finished,false);
 for(const anime of [{year:2026,season:'SPRING'},{year:2027,season:'WINTER'},{year:null,season:''},{year:2025,season:'oops'}])assert.equal(catchupTiming(anime,now).offer,false);
 assert.equal(catalogAnime({_id:'id',title:{chinese:'旧番'},status:'FINISHED'}).status,'FINISHED');
 assert.equal(catalogAnime({_id:'id',status:'unknown'}).status,'');
});

test('catchup recommends one preferred version per episode and ignores only the date',()=>{
 const c=clone(defaults);c.startDate='2026-11-04';c.filters.priorityGroups=['B'];c.startEpisode=2;
 const row=(n,g='A',extra={})=>({id:n+g,resultId:n+g,episode:String(n),title:'旧番 '+n,animeTitle:'旧番',bgmId:'123',groupName:g,groupSlug:g,infoHash:'a'.repeat(40),languages:['CHS'],subtitles:[],publishedAt:'2020-01-01T00:00:00Z',...extra});
 const items=[row(1),row(2),row(2,'B'),row(3),row(4),row(4,'B'),row(5,'A',{languages:['CHT']}),row(6,'A',{episode:'1-12'}),row(7,'A',{infoHash:''})];
 assert.deepEqual(catchupRecommendations(items,c,{'bgm:123':{episodeStates:{3:true}}},i=>i.resultId==='4A'),['2B']);
 assert.equal(c.startDate,'2026-11-04');
 c.rules=[{bgmId:'123',title:'旧番',startDate:'2026-12-01',startEpisode:3,enabled:false}];
 assert.deepEqual(catchupRecommendations(items,c,{}),[]);
});


test('completed recommendation ignores per-show episode limits without changing saved rules',()=>{
 const c=clone(defaults);c.rules=[{bgmId:'123',startEpisode:10,startDate:'2027-01-01'}];const row={id:'r',resultId:'result',episode:'1',title:'完结番 1',animeTitle:'完结番',bgmId:'123',infoHash:'a'.repeat(40),languages:['CHS'],subtitles:[]};
 assert.deepEqual(catchupRecommendations([row],c,{},()=>false,'catchup'),[]);assert.deepEqual(catchupRecommendations([row],c,{},()=>false,'completed'),['result']);assert.equal(c.rules[0].startEpisode,10);assert.equal(catchupTiming({status:'FINISHED'}).offer,true);
});

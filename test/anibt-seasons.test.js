import test from 'node:test';
import assert from 'node:assert/strict';
import { currentSeason,normalizeSeason,seasonCatalog,createAnimeCatalog } from '../src/anibt-catalog.js';
const anime=(id,extra={})=>({animeId:id,bgmId:123,title:{primary:'番剧 '+id,japanese:'原名'},weekday:1,scheduleStatus:'scheduled',airingAt:Date.parse('2026-11-02T15:30:00Z')/1000,...extra});
const payload=items=>({ok:true,data:{requestedSeason:'2026秋',availableSeasons:['2026夏','2026秋','bad'],scope:{kind:'season'},byWeekday:[{weekday:1,animes:items}],truncated:false,limit:200}});
test('season defaults follow Beijing quarter and year boundaries independently of local timezone',()=>{
  assert.equal(currentSeason(new Date('2026-03-31T15:59:59Z')),'2026冬');
  assert.equal(currentSeason(new Date('2026-03-31T16:00:00Z')),'2026春');
  assert.equal(currentSeason(new Date('2026-12-31T16:00:00Z')),'2027冬');
  assert.equal(normalizeSeason('2026-FALL'),'2026秋');
  for(const v of ['2026bad','2026秋&query=xx','1900冬'])assert.throws(()=>normalizeSeason(v));
});
test('season maps exact website anime IDs for subscription and sorts Beijing clock times rather than next-airing dates',()=>{
  const r=seasonCatalog(payload([
    anime('late'),anime('early',{airingAt:Date.parse('2026-11-08T16:10:00Z')/1000}),
    anime('dayOnly',{scheduleStatus:'weekday_only',airingAt:null,hasRelease:false}),
    anime('unknown',{weekday:null,scheduleStatus:'missing_source',airingAt:null}),
    anime('early'),anime('<invalid>'),
  ]),'2026秋');
  assert.deepEqual(r.groups.map(g=>g.weekday),[1,2,3,4,5,6,0,null]);
  const m=r.groups[0].items;assert.deepEqual(m.map(i=>i.id),['early','late','dayOnly']);
  assert.equal(m[0].airTime,'00:10');assert.equal(m[1].airTime,'23:30');assert.equal(m[2].airTime,null);
  assert.equal(m[0].title,'番剧 early');assert.equal(m[0].originalTitle,'原名');assert.equal(m[0].bgmId,'123');
  assert.equal(r.groups.at(-1).items[0].scheduleStatus,'missing_source');assert.equal(r.total,4);
});
test('season preserves truncation and unknown times, permits only official cover URLs',()=>{
  const p=payload([anime('a',{cover:'https://r2.anibt.net/a.jpg'}),anime('b',{cover:'https://evil.test/a.jpg',airingAt:'1793584800'}),anime('c',{cover:'javascript:alert(1)',airingAt:NaN})]);p.data.truncated=true;
  const r=seasonCatalog(p,'2026秋');assert.equal(r.truncated,true);assert.equal(r.limit,200);
  assert.equal(r.groups[0].items.find(i=>i.id==='a').cover,'https://r2.anibt.net/a.jpg');
  for(const i of r.groups[0].items.filter(i=>i.id!=='a')){assert.equal(i.cover,'');assert.equal(i.airTime,null);}
  assert.throws(()=>seasonCatalog(p,'2026夏'),/不一致/);assert.throws(()=>seasonCatalog({data:{}},'2026秋'),/接口已变化/);
});
test('season request has bounded cache, explicit refresh and no private RSS credentials',async()=>{
  const urls=[];const api=createAnimeCatalog(()=>({}),{network:{read:async url=>{urls.push(url);return{text:JSON.stringify(payload([anime('one')]))};}}});
  assert.equal((await api.season({season:'2026-FALL'})).total,1);await api.season({season:'2026秋'});assert.equal(urls.length,1);
  await api.season({season:'2026秋',refresh:true});assert.equal(urls.length,2);
  const u=new URL(urls[0]);assert.equal(u.pathname,'/api/seasons/anime');assert.deepEqual([...u.searchParams.keys()],['season']);assert.equal(u.searchParams.get('season'),'2026秋');
  await assert.rejects(()=>api.season({season:'garbage'}));assert.equal(urls.length,2);
});
test('season malformed or unavailable results are rejected and do not poison cache',async()=>{
  let response='not JSON',calls=0;const api=createAnimeCatalog(()=>({}),{network:{read:async()=>{calls++;return{text:response};}}});
  await assert.rejects(()=>api.season({season:'2026秋'}),/暂时无法读取/);
  response=JSON.stringify(payload([anime('ok')]));assert.equal((await api.season({season:'2026秋'})).total,1);assert.equal(calls,2);
});

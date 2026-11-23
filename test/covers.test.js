import test from 'node:test';
import assert from 'node:assert/strict';
import {animeCover,catalogAnime,createAnimeCatalog} from '../src/anibt-catalog.js';
test('covers use official images, prefer suitable WebP sizes and reject arbitrary URLs',()=>{
 const raw={_id:'student',bgmId:123,title:{chinese:'学生会'},coverImage:{large:'https://r2.anibt.net/poster.jpg'},coverImageWebp:{variants:[{width:720,url:'https://r2.anibt.net/720.webp'},{width:360,url:'https://r2.anibt.net/360.webp'}]}};
 assert.equal(catalogAnime(raw).cover,'https://r2.anibt.net/360.webp');assert.equal(animeCover({cover:'https://r2.anibt.net/p.jpg'}),'https://r2.anibt.net/p.jpg');
 for(const cover of ['javascript:alert(1)','https://evil.test/p.jpg','https://r2.anibt.net:99/p.jpg','https://user@r2.anibt.net/p.jpg'])assert.equal(animeCover({cover}),'');
});
test('management covers match subject identity, cache lookups and avoid a similar season poster',async()=>{
 let calls=0;const catalog=createAnimeCatalog(()=>({}),{network:{read:async()=>{calls++;return{text:JSON.stringify({page:[{_id:'wrong',bgmId:456,title:{chinese:'学生会 第二季'},cover:'https://r2.anibt.net/wrong.jpg'},{_id:'right',bgmId:123,title:{chinese:'学生会'},coverImage:{large:'https://r2.anibt.net/right.jpg'}}],isDone:true})};}}});
 let r=await catalog.covers({items:[{bgmId:'123',title:'学生会'}]});assert.equal(r.items[0].cover,'https://r2.anibt.net/right.jpg');await catalog.covers({items:[{bgmId:'123',title:'学生会'}]});assert.equal(calls,1);
 r=await catalog.covers({items:[{bgmId:'999',title:'学生会'}]});assert.equal(r.items[0].cover,'');r=await catalog.covers({items:[{bgmId:'',title:'学生会'}]});assert.equal(r.items[0].cover,'https://r2.anibt.net/right.jpg');
 await assert.rejects(catalog.covers({items:[{bgmId:'oops',title:'学生会'}]}));await assert.rejects(catalog.covers({items:Array(61).fill({bgmId:'123',title:'学生会'})}));
});


test('ratings retain AniBT percent scale, reject invalid values and hydrate exact subscriptions with explicit refresh',async()=>{
 for(const [value,expected]of [[80,80],[79.5,79.5],[0,null],[null,null],['80',null],[101,null],[-2,null],[Infinity,null]])assert.equal(catalogAnime({_id:'score',averageScore:value}).averageScore,expected);
 let score=80,calls=0;const catalog=createAnimeCatalog(()=>({}),{network:{read:async()=>{calls++;return{text:JSON.stringify({page:[{_id:'wrong',bgmId:456,title:{chinese:'第二季'},averageScore:99},{_id:'right',bgmId:123,title:{chinese:'本季'},averageScore:score}],isDone:true})};}}});
 let result=await catalog.covers({items:[{bgmId:'123',title:'本季'}]});assert.equal(result.items[0].averageScore,80);score=85;result=await catalog.covers({items:[{bgmId:'123',title:'本季'}],refresh:true});assert.equal(result.items[0].averageScore,85);assert.equal(calls,2);assert.equal((await catalog.covers({items:[{bgmId:'999',title:'本季'}]})).items[0].averageScore,null);
});


test('total episodes hydrate alongside cover and score; invalid counts stay unknown',async()=>{
 for(const [value,expected]of [[12,12],[0,null],[-1,null],[12.5,null],['12',null],[10000,null],[null,null]])assert.equal(catalogAnime({_id:'total',episodes:value}).episodes,expected);
 const catalog=createAnimeCatalog(()=>({}),{network:{read:async()=>({text:JSON.stringify({page:[{_id:'right',bgmId:123,title:{chinese:'测试'},episodes:12}],isDone:true})})}});assert.equal((await catalog.covers({items:[{bgmId:'123',title:'测试'}]})).items[0].episodes,12);
});

test('manual release aliases retrieve the correct season poster and keep the stored viewing key', async () => {
 const {buildProgress}=await import('../src/progress.js');
 const {defaults}=await import('../src/config.js');
 const name='药师少女的独语';
 const wrapped='[别当欧尼酱了！/Onii-chan wa Oshimai!/お兄ちゃんはおしまい!][01-12TV全集+特典映像]';
 const manual={
  one:{status:'added',origin:'discovery',animeTitle:name,title:'[Team] '+name+' / Kusuriya no Hitorigoto / 薬屋のひとりごと 10-bit 1080p [S1 Fin]'},
  two:{status:'added',origin:'discovery',animeTitle:wrapped,title:'[DBD-Raws]'+wrapped+'[1080P][BDRip]'},
 };
 const shows=buildProgress({state:{done:{}},manual,config:defaults});
 const inputs=shows.map(show=>({title:show.displayTitle,bgmId:show.bgmId,aliases:show.coverAliases}));
 assert.equal(inputs.find(row=>row.title===name).aliases[1],'薬屋のひとりごと');
 assert.equal(inputs.find(row=>row.title==='别当欧尼酱了！').aliases[1],'お兄ちゃんはおしまい!');
 const catalog=createAnimeCatalog(()=>({}),{network:{async read(address) {
  const query=new URL(address).searchParams.get('q');
  const row=(bgmId,chinese,native)=>({_id:String(bgmId),bgmId,title:{chinese,native},cover:'https://r2.anibt.net/'+bgmId+'.jpg'});
  const page=query===name ? [
   row(486347,'药屋少女的呢喃 第二季','薬屋のひとりごと 第2期'),
   row(420628,'药屋少女的呢喃','薬屋のひとりごと'),
  ] : query==='お兄ちゃんはおしまい!' ? [row(378862,'别当哥哥了！','お兄ちゃんはおしまい！')] : [];
  return {text:JSON.stringify({page,isDone:true})};
 }}});
 const covers=(await catalog.covers({items:inputs})).items;
 assert.deepEqual(covers.map(row=>row.bgmId).sort(),['378862','420628']);
 assert.ok(covers.every(row=>row.cover));
 assert.equal(shows.find(show=>show.displayTitle==='别当欧尼酱了！').title,wrapped);
 const {findRatingWatch,ratingWatchEvidence,ratingWatchWork}=await import('../src/rating-watches.js');
 const key='title:'+name;
 const tracking={[key]:{title:name,completedAt:'2026-11-21T00:00:00Z'}};
 const evidence=ratingWatchEvidence(manual,defaults);
 const first=ratingWatchWork({title:'药屋少女的呢喃',names:['薬屋のひとりごと'],ids:{bangumi:'420628'}});
 const second=ratingWatchWork({title:'药屋少女的呢喃 第二季',names:['薬屋のひとりごと','薬屋のひとりごと 第2期'],ids:{bangumi:'486347'}});
 assert.equal(findRatingWatch(tracking,first,evidence),key);
 assert.equal(findRatingWatch(tracking,second,evidence),'');
});

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

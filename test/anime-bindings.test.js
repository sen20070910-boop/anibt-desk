import test from 'node:test';import assert from 'node:assert/strict';
import {applyAnimeBindings,validateBindings} from '../src/anime-bindings.js';
import {clone,defaults,validateConfig} from '../src/config.js';
import {describeItems} from '../src/gui-server.js';import {sourceKey} from '../src/feed.js';import {buildProgress} from '../src/progress.js';
const binding={title:'JOJO',bgmId:'123',canonicalTitle:'正确季度',aliases:['Steel Ball Run']};

test('RSS without a subject ID joins manual downloads and keeps episode actions unambiguous',async()=>{
 const {episodeContext,showContext}=await import('../src/episode-actions.js');
 const config=clone(defaults),title='穹庐下的魔女',hash='a'.repeat(40);
 const item={id:'rss',title:'[Test] '+title+' 12',animeTitle:title,bgmId:'',episode:'12',infoHash:hash,languages:['CHS'],subtitles:[]};
 const manual={download:{...item,bgmId:'552533',hash,status:'added'}};
 const state={done:{},pending:{},episodes:{}};
 const tracking={['title:'+title]:{title,watched:6,startEpisode:1,episodeStates:{7:true}}};
 const before=JSON.stringify({item,manual,tracking});
 const shows=buildProgress({items:[item],manual,state,tracking,config,completed:{[hash]:{completed:true}}});
 assert.equal(shows.length,1);
 assert.equal(shows[0].key,'bgm:552533');
 assert.equal(shows[0].downloaded,1);
 assert.equal(shows[0].watched,6);
 assert.equal(shows[0].episodeStates[7],true);
 const context=episodeContext({items:[item],manual,state,config,key:'bgm:552533',episode:12});
 assert.equal(context.candidates.length,1);
 assert.equal(context.candidates[0].ambiguous,false);
 assert.equal(showContext({items:[item],manual,state,config,key:'bgm:552533'}).candidates[0].ambiguous,false);
 assert.equal(JSON.stringify({item,manual,tracking}),before);
});

test('automatic identity matching refuses conflicting IDs and partial title matches',()=>{
 const rows=[{animeTitle:'Test',bgmId:'123'},{animeTitle:'Test',bgmId:'456'},{animeTitle:'Test'},{animeTitle:'Test 第二季'}];
 const linked=applyAnimeBindings(rows,{bindings:[]});
 assert.equal(linked[0].bgmId,'123');
 assert.equal(linked[1].bgmId,'456');
 assert.equal(linked[2].bgmId,undefined);
 assert.equal(linked[3].bgmId,undefined);
});
test('explicit subject bindings use exact aliases, never replace source IDs and rebuild canonical episode identity',()=>{const c={bindings:[binding]},items=[{animeTitle:'JOJO',episode:'5',episodeKey:'original:5:v1'},{animeTitle:'Steel Ball Run'},{animeTitle:'JOJO 第二季'},{animeTitle:'JOJO',bgmId:'456'}],r=applyAnimeBindings(items,c);assert.equal(r[0].bgmId,'123');assert.equal(r[0].episodeKey,'bgm:123:5:v1');assert.equal(r[1].bgmId,'123');assert.equal(r[2].bgmId,undefined);assert.equal(r[3].bgmId,'456');assert.equal(items[0].bgmId,undefined);validateBindings([binding]);assert.throws(()=>validateBindings([binding,{...binding,title:'Other',aliases:['JOJO']}]));const cfg=clone(defaults);cfg.rssUrl='https://anibt.net/rss/subscriptions.xml?key=test';cfg.bindings=[{...binding,bgmId:'javascript:1'}];assert.throws(()=>validateConfig(cfg));});
test('decision explanations distinguish matching filters from baseline, duplicates, previous handling and next-check candidates',()=>{const c=clone(defaults);c.rssUrl='https://anibt.net/rss/subscriptions.xml?key=test';const state={done:{recorded:{}},episodes:{'title:测试:1:v1':'processed'},sources:{[sourceKey(c.rssUrl)]:{baselineIds:['baseline']}}};const base={title:'测试',animeTitle:'测试',languages:['CHS'],subtitles:[],infoHash:'a'.repeat(40)};const rows=describeItems([{...base,id:'recorded'},{...base,id:'duplicate',episode:'1',version:'v1',episodeKey:'title:测试:1:v1'},{...base,id:'baseline'},{...base,id:'next'},{...base,id:'excluded',languages:['CHT']}],c,state);assert.match(rows[0].decision,/已经处理/);assert.match(rows[1].decision,/同一集/);assert.match(rows[2].decision,/基线/);assert.match(rows[3].decision,/下次检查/);assert.equal(rows[4].matched,false);assert.match(rows[4].decision,/字幕语言/);});
test('binding joins old title-based viewing progress to a subject without editing the saved progress',()=>{const c=clone(defaults);c.bindings=[binding];const tracking={'title:jojo':{title:'JOJO',watched:5,startEpisode:1,archived:false}},state={done:{},episodes:{}};const shows=buildProgress({items:[{animeTitle:'JOJO',title:'JOJO 06',episode:'6',id:'new',languages:['CHS'],subtitles:[],infoHash:'a'.repeat(40)}],state,config:c,tracking});assert.equal(shows.length,1);assert.equal(shows[0].key,'bgm:123');assert.equal(shows[0].watched,5);assert.ok(tracking['title:jojo']);});

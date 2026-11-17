import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createArtwork} from '../src/artwork.js';
import {makeApplication} from '../src/gui-server.js';
import {clone, defaults, atomicWrite} from '../src/config.js';

test('cover byte cache and URL registry stay bounded and reload evicted bytes', async () => {
  const buffer=Buffer.alloc(1000);
  Buffer.from('89504e470d0a1a0a','hex').copy(buffer);
  let calls=0;
  const artwork=createArtwork(()=>({}),{maxCacheBytes:1500,maxEntries:3,
    network:{read:async()=>{calls++;return {bytes:buffer};}}});
  const ids=[1,2,3].map(n=>artwork.register(`https://r2.anibt.net/${n}.png`).src.slice(8));
  await artwork.get(ids[0]);await artwork.get(ids[1]);
  assert.equal(artwork.stats().bytes,1000);
  await artwork.get(ids[0]);assert.equal(calls,3);
  artwork.register('https://r2.anibt.net/4.png');
  assert.equal(artwork.stats().entries,3);
  assert.ok(artwork.stats().bytes<=1500);
  await assert.rejects(artwork.get(ids[2]),/过期/);
});

test('cover network requests share concurrent reads and never exceed three slots', async () => {
  const bytes=Buffer.from('89504e470d0a1a0a0000','hex');
  let active=0,max=0,calls=0;
  const artwork=createArtwork(()=>({}),{network:{read:async()=>{
    calls++;active++;max=Math.max(max,active);
    await new Promise(resolve=>setTimeout(resolve,15));active--;return {bytes};
  }}});
  const ids=[1,2,3,4,5].map(n=>artwork.register(`https://r2.anibt.net/${n}.png`).src.slice(8));
  await Promise.all([...ids,ids[0]].map(id=>artwork.get(id)));
  assert.equal(calls,5);assert.equal(max,3);
  assert.equal(artwork.stats().active,0);
});

test('progress and download queries share one qB connection while explicit refresh stays fresh', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-shared-qb-'));
  const config=clone(defaults);config.rssUrl='https://anibt.net/rss/subscriptions.xml?key=isolated';
  const file=path.join(root,'config.json');atomicWrite(file,config);
  let logins=0;
  const qb={login:async()=>{logins++;await new Promise(r=>setTimeout(r,30));return '5.2';},
    list:async()=>[],request:async()=>({json:async()=>({save_path:root})}),logout:async()=>{}};
  const app=makeApplication({configFile:file,token:'performance-test',deps:{qb,fetchFeed:async()=>[],backgroundStatus:()=>({running:false})}});
  const server=http.createServer(app.handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port;
  const read=async route=>{const response=await fetch(base+'/api/'+route,{headers:{'x-app-token':'performance-test'}});assert.equal(response.status,200);return response.json();};
  await Promise.all([read('qb'),read('progress'),read('qb?refresh=1')]);
  assert.equal(logins,1);
  await read('qb?refresh=1');assert.equal(logins,2);
});

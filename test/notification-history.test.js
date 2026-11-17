import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {atomicWrite,clone,defaults} from '../src/config.js';
import {notificationHistory,markNotificationsRead} from '../src/notification-history.js';
import {createCompletionMonitor} from '../src/notifications.js';
import {emptyState} from '../src/runner.js';

test('persistent unread records survive restarts and read actions do not erase a newly arrived completion',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-inbox-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'completions.json');
 const saved={version:1,tasks:{a:{title:'一',completedAt:'2026-11-02T00:00:00Z',notifiedAt:'2026-11-02T00:00:00Z'},old:{title:'历史',completedAt:'2026-11-01T00:00:00Z',historical:true}}};atomicWrite(file,saved);
 const first=notificationHistory(dir);assert.equal(first.unread,1);assert.equal(first.items.length,1);
 saved.tasks.b={title:'二',completedAt:'2026-11-02T00:01:00Z'};atomicWrite(file,saved);
 const after=markNotificationsRead(dir,first.items.map(i=>i.id));assert.equal(after.unread,1);assert.equal(after.items[0].title,'二');assert.equal(after.items[0].delivered,false);assert.equal(notificationHistory(dir).unread,1);
 assert.throws(()=>markNotificationsRead(dir,'all'),/请选择/);
});
test('a failed system banner still leaves a durable unread download-completion record',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anibt-inbox-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const c=clone(defaults),state=emptyState(),hash='e'.repeat(40),now=Date.now();state.done={test:{hash,status:'added',at:new Date(now).toISOString()}};const data=path.join(dir,'data');atomicWrite(path.join(data,'state.json'),state);
 const qb={login:async()=>{},list:async()=>[{hash,progress:1,name:'完成后保留'}],logout:async()=>{}};
 const monitor=createCompletionMonitor(path.join(dir,'config.json'),{showTaskbar:async()=>{},qb,now:()=>now,reachable:async()=>true,notify:async()=>{throw new Error('disabled');},log:()=>{}});await monitor.poll(c);
 const n=notificationHistory(data);assert.equal(n.unread,1);assert.equal(n.items[0].title,'完成后保留');assert.equal(n.items[0].delivered,false);
});

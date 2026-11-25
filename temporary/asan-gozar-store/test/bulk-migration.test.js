import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { bulkMigrationQueue } from '../bulk-migration.js';

function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)');
 const prep=(q,args=[])=>({bind(...x){return prep(q,x)},async run(){const r=sql.prepare(q).run(...args);return {meta:{changes:Number(r.changes)}}},async first(){return sql.prepare(q).get(...args)??null}});
 const db={prepare:q=>prep(q)},queue=bulkMigrationQueue(db),id='12345678-1234-1234-1234-123456789abc';
 return {sql,queue,id};
}

test('batch records successes separately and continues past an uncertain service',async()=>{
 const f=fixture();await f.queue.create(f.id,1,'source',3,[1,2,3]);const calls=[];
 const run=async id=>{calls.push(id);if(id===2)throw Error('connection lost');return true};
 await f.queue.step(f.id,run);await f.queue.step(f.id,run);const result=await f.queue.step(f.id,run);
 assert.deepEqual(result.items.map(x=>x.status),['done','review','done']);assert.deepEqual(calls,[1,2,3]);
 await f.queue.step(f.id,run);assert.deepEqual(calls,[1,2,3]);f.sql.close();
});

test('concurrent workers never start the same service twice',async()=>{
 const f=fixture();await f.queue.create(f.id,1,'source',3,[4]);let release,calls=0;
 const barrier=new Promise(r=>{release=r});const first=f.queue.step(f.id,async()=>{calls++;await barrier;return true});
 await new Promise(r=>setImmediate(r));await assert.rejects(f.queue.step(f.id,async()=>true),/already running/);
 release();await first;assert.equal(calls,1);f.sql.close();
});

test('a stale in-flight service becomes review and is never retried automatically',async()=>{
 const f=fixture();await f.queue.create(f.id,1,'source',3,[4,5]);let release;
 const barrier=new Promise(r=>{release=r});const original=f.queue.step(f.id,async()=>{await barrier;return true},()=>100);
 await new Promise(r=>setImmediate(r));await assert.rejects(f.queue.recover(f.id,()=>101),/still be running/);
 const recovered=await f.queue.recover(f.id,()=>600101);assert.equal(recovered.items[0].status,'review');
 const calls=[];await f.queue.step(f.id,async id=>{calls.push(id);return true},()=>600102);assert.deepEqual(calls,[5]);
 release();await assert.rejects(original,/journal conflict/);f.sql.close();
});

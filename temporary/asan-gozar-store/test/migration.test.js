import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceMigration, reconcileMigration, migrationSnapshot } from '../migration.js';
import { migrationJournal } from '../migration-journal.js';
import { commitMigrationService } from '../migration-commit.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

function fixture(failure = '') {
  let job = { id: 7, state: 'ready', next: 0, destination: { email: 'alice', subId: 'planned' } };
  const calls = [];
  const journal = {
    async get() { return structuredClone(job); },
    async compareAndSet(id, before, after) {
      if (id !== job.id || JSON.stringify(before) !== JSON.stringify(job)) return false;
      job = structuredClone(after); return true;
    },
  };
  const names = ['freezeSource', 'snapshotSource', 'createDestination', 'importUsage', 'verifyDestination', 'activateDestination', 'verifyActiveDestination', 'deleteSource', 'commitDestination'];
  const adapter = Object.fromEntries(names.map(name => [name, async state => {
    calls.push(name);
    if (name === failure) throw new Error('connection lost');
    if (name === 'createDestination') assert.equal(state.destination.subId, 'planned');
    return name === 'snapshotSource' ? { snapshot: { up: 5, down: 15, quota: 100, expiry: 123 } } : true;
  }]));
  return { journal, adapter, calls, get: () => job };
}

test('migration verifies and activates destination before deleting source', async () => {
  const f = fixture(); const result = await advanceMigration(f.journal, f.adapter, 7);
  assert.equal(result.state, 'complete');
  assert.deepEqual(f.calls, ['freezeSource','snapshotSource','createDestination','importUsage','verifyDestination','activateDestination','verifyActiveDestination','deleteSource','commitDestination']);
  assert.equal(result.snapshot.quota, 100);
  await advanceMigration(f.journal, f.adapter, 7); assert.equal(f.calls.length, 9);
});

test('ambiguous creation or deletion stays locked and cannot be blindly repeated', async () => {
  for (const [failure, step] of [['createDestination','create_destination'], ['deleteSource','delete_source']]) {
    const f = fixture(failure);
    await assert.rejects(advanceMigration(f.journal, f.adapter, 7), /connection lost/);
    assert.equal(f.get().state, 'review'); assert.equal(f.get().uncertain, step);
    const count = f.calls.length;
    await assert.rejects(advanceMigration(f.journal, f.adapter, 7), /requires review/);
    assert.equal(f.calls.length, count);
    if (failure === 'createDestination') assert.ok(!f.calls.includes('deleteSource'));
  }
});

test('review cannot race an active mutation and never clears ambiguous outcomes', async () => {
  const f = fixture('deleteSource');
  await assert.rejects(advanceMigration(f.journal, f.adapter, 7));
  const sent = f.get().dispatchedAt;
  const verifier = { reconcile: async () => ({ verdict:'ambiguous' }) };
  await assert.rejects(reconcileMigration(f.journal, verifier, 7, () => sent + 1000), /still be running/);
  await assert.rejects(reconcileMigration(f.journal, verifier, 7, () => sent + 600001), /remains uncertain/);
  assert.equal(f.get().uncertain, 'delete_source');
  verifier.reconcile = async () => ({ verdict:'applied' });
  const next = await reconcileMigration(f.journal, verifier, 7, () => sent + 600001);
  assert.equal(next.state, 'ready'); assert.equal(next.next, 8);
  f.adapter.deleteSource = async () => { throw new Error('deletion must not repeat'); };
  assert.equal((await advanceMigration(f.journal, f.adapter, 7)).state, 'complete');
});

test('verified no-op review retries the same stage once', async () => {
  const f = fixture('createDestination');
  await assert.rejects(advanceMigration(f.journal, f.adapter, 7));
  const sent = f.get().dispatchedAt;
  const next = await reconcileMigration(f.journal, {reconcile:async()=>({verdict:'not_applied'})}, 7, () => sent + 600001);
  assert.equal(next.next, 2); assert.equal(next.state, 'ready');
  f.adapter.createDestination = async () => { f.calls.push('createDestination'); return true; };
  assert.equal((await advanceMigration(f.journal,f.adapter,7)).state,'complete');
  assert.equal(f.calls.filter(x=>x==='createDestination').length,2);
});

test('verification failure cannot delete source and read may be retried', async () => {
  const f = fixture('verifyDestination');
  await assert.rejects(advanceMigration(f.journal, f.adapter, 7), /connection lost/);
  assert.equal(f.get().state, 'ready'); assert.equal(f.get().next, 4);
  assert.ok(!f.calls.includes('deleteSource'));
});

test('persistent journal locks the service and only releases completed jobs', async () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO services(id,user_id,name) VALUES(1,42,'alice')");
  const prep = (q, args = []) => ({
    bind(...values) { return prep(q, values); },
    execute() { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    async run() { return this.execute(); },
    async first() { return sql.prepare(q).get(...args) ?? null; },
  });
  const db = { prepare: q => prep(q), async batch(statements) {
    sql.exec('BEGIN'); try { const results = statements.map(s => s.execute()); sql.exec('COMMIT'); return results; }
    catch (e) { sql.exec('ROLLBACK'); throw e; }
  } };
  const journal = migrationJournal(db), id = '12345678-1234-1234-1234-123456789abc';
  const initial = await journal.create(id, 1, { destination: 'two' });
  await assert.rejects(journal.create('22345678-1234-1234-1234-123456789abc', 1, {}));
  await assert.rejects(journal.releaseComplete(id), /not complete/);
  const review = { ...initial, state: 'review', uncertain: 'delete_source' };
  assert.equal(await journal.compareAndSet(id, initial, review), true);
  assert.equal(await journal.compareAndSet(id, initial, review), false);
  const done = { ...review, state: 'complete', uncertain: null };
  assert.equal(await journal.compareAndSet(id, review, done), true);
  assert.equal(await journal.releaseComplete(id), true);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM service_operations').get().n, 0);
  sql.close();
});

test('a pending renewal blocks acquiring a migration lock', async () => {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO services(id,user_id,name) VALUES(1,2,'alice'); INSERT INTO orders(id,user_id,renew_service_id,status) VALUES(1,2,1,'pending')");
  const prep=(q,a=[])=>({bind(...x){return prep(q,x)},execute(){const r=sql.prepare(q).run(...a);return {meta:{changes:Number(r.changes)}}}});
  const db={prepare:q=>prep(q),async batch(ss){sql.exec('BEGIN');try{const r=ss.map(s=>s.execute());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}};
  await assert.rejects(migrationJournal(db).create('12345678-1234-1234-1234-123456789abc',1,{}),/unavailable/);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM service_operations').get().n,0);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE 'migration:%'").get().n,0);
  sql.close();
});

test('concurrent starts dispatch only one source freeze', async () => {
  const f = fixture();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  f.adapter.freezeSource = async () => { f.calls.push('freezeSource'); await barrier; return true; };
  const first = advanceMigration(f.journal, f.adapter, 7);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(advanceMigration(f.journal, f.adapter, 7), /requires review/);
  release();
  await first;
  assert.equal(f.calls.filter(x => x === 'freezeSource').length, 1);
});

test('snapshot keeps full original quota and absolute deadline, including unlimited quota', () => {
  const account = { email: 'Alice', subId: 'secret', enable: false, up: 10, down: 20, allTime: 50, totalGB: 100, expiryTime: 1234 };
  const traffic = {email:'Alice', enable:false,up:10,down:20,allTime:50};
  assert.deepEqual(migrationSnapshot(account, traffic, 'alice', 'secret'), { upload: 10, download: 20, allTime: 50, quota: 100, expiry: 1234 });
  assert.equal(migrationSnapshot({ ...account, totalGB: 0, expiryTime: 0 }, traffic, 'alice', 'secret').quota, 0);
  assert.equal(migrationSnapshot({...account,expiryTime:-86400000},traffic,'alice','secret').expiry,-86400000);
  for (const bad of [{ ...account, enable: true }, { ...account, subId: 'wrong' }, { ...account, up: -1 }]) {
    assert.throws(() => migrationSnapshot(bad, traffic, 'alice', 'secret'));
  }
  assert.throws(() => migrationSnapshot(account, {...traffic,down:21}, 'alice', 'secret'), /inconsistent/);
  assert.throws(() => migrationSnapshot(account, {...traffic,allTime:undefined}, 'alice', 'secret'), /lifetime/);
});

test('service commit changes link and panel together and rejects pending renewals', async () => {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const prep = (q, args = []) => ({ bind(...a) { return prep(q, a); }, execute() { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; } });
  const db = { prepare: q => prep(q), async batch(ss) { sql.exec('BEGIN'); try { const r = ss.map(x => x.execute()); sql.exec('COMMIT'); return r; } catch (e) { sql.exec('ROLLBACK'); throw e; } } };
  const job = { id:'12345678-1234-1234-1234-123456789abc',serviceId:1,state:'review',uncertain:'commit_destination',
    source:{ email:'Alice',subId:'old',panelMapping:'source' },
    destination:{email:'Alice',subId:'new',panelIdentity:'dest',inboundId:4,link:'https://destination.example/sub/new'} };
  sql.exec("INSERT INTO services(id,user_id,panel_email,sub_id,sub_link) VALUES(1,2,'Alice','old','https://source.example/sub/old')");
  sql.prepare('INSERT INTO service_operations VALUES(?,?,?)').run(1,`migration:${job.id}`,'now');
  sql.prepare('INSERT INTO settings VALUES(?,?)').run(`migration:${job.id}`,JSON.stringify(job));
  sql.prepare('INSERT INTO settings VALUES(?,?)').run('service_panel:1','source');
  sql.exec("INSERT INTO orders(id,user_id,renew_service_id,status) VALUES(1,2,1,'pending')");
  await assert.rejects(commitMigrationService(db,job),/pending renewal/);
  assert.equal(sql.prepare('SELECT sub_id FROM services WHERE id=1').get().sub_id,'old');
  assert.equal(sql.prepare("SELECT value FROM settings WHERE key='service_panel:1'").get().value,'source');
  sql.exec("UPDATE orders SET status='cancelled'");
  await commitMigrationService(db,job);
  assert.equal(sql.prepare('SELECT sub_id FROM services WHERE id=1').get().sub_id,'new');
  assert.equal(sql.prepare("SELECT value FROM settings WHERE key='service_panel:1'").get().value,'dest');
  await assert.rejects(commitMigrationService(db,job),/requires review/);
  assert.equal(sql.prepare("SELECT value FROM settings WHERE key='service_panel:1'").get().value,'dest');
  sql.close();
});

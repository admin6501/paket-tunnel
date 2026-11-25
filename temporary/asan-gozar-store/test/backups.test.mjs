import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStoreBackups } from '../backups.mjs';
import { openStore } from '../database.mjs';

test('restore is authenticated, preserves owner credentials and replaces persisted data atomically', t => {
  const dir = mkdtempSync(join(tmpdir(), 'asan-gozar-backup-test-'));
  const file = join(dir, 'store.sqlite');
  let store = openStore(file);
  t.after(() => {
    store.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let idle = true;
  const manager = createStoreBackups(file, 'ab'.repeat(32), () => store, updated => { store = updated; }, () => idle);
  const foreign = createStoreBackups(file, 'bc'.repeat(32), () => store, () => assert.fail('Replaced by foreign backup'), () => true);
  const insertUser = id => store.sqlite.prepare(
    'INSERT INTO store_accounts(id,username,display_name,salt,password_hash,owner,created_at) VALUES(?,?,?,?,?,?,0)',
  ).run(id, `user_${id}`, 'User', 'old-salt', Buffer.from('fake-hash'), Number(id === 1));
  insertUser(1);
  insertUser(2);
  store.sqlite.exec(`INSERT INTO plans VALUES('test',10,40000,0);
    INSERT INTO orders(id,status) VALUES(1,'approved');
    INSERT INTO store_inbox(user_id,html,created_at) VALUES(2,'first message',1);
    INSERT INTO web_shop_sessions(token,user_id,expires_at) VALUES('old-session',2,99);
    INSERT INTO store_tickets(id,customer_id,department_id,subject,created_at,updated_at) VALUES(1,2,1,'Ticket',1,1);
    INSERT INTO store_ticket_messages(id,ticket_id,actor_id,kind,body,created_at) VALUES(1,1,2,'customer','Photo',1);
    INSERT INTO store_ticket_images(id,message_id,data) VALUES('attached',1,x'FFD8FFD9');
    INSERT INTO store_ticket_images(id,session_token,expires_at,data) VALUES('pending','old-session',2,x'FFD8FFD9');`);
  const fileBytes = manager.download();
  assert.ok(!fileBytes.includes('SQLite format 3'));
  assert.ok(!fileBytes.includes('first message'));
  const session = { user_id: 1, token: 'owner-session' };
  const ticket = manager.issueTicket(session);
  assert.equal(manager.consumeTicket(ticket, { ...session, token: 'other-session' }), false);
  assert.equal(manager.consumeTicket(ticket, session), true);
  assert.equal(manager.consumeTicket(ticket, session), false);

  insertUser(30);
  store.sqlite.exec(`UPDATE plans SET price=80000 WHERE key='test';
    UPDATE store_accounts SET salt='new-owner-salt' WHERE id=1;
    INSERT INTO orders(id,status) VALUES(40,'approved');`);
  idle = false;
  assert.throws(() => manager.restore(fileBytes, 1), { status: 409 });
  idle = true;
  const damaged = Buffer.from(fileBytes);
  damaged[damaged.length - 1] ^= 1;
  assert.throws(() => manager.restore(damaged, 1), { status: 400 });
  assert.throws(() => foreign.restore(fileBytes, 1), { status: 400 });
  assert.equal(store.sqlite.prepare('SELECT price FROM plans').get().price, 80000);

  manager.restore(fileBytes, 1);
  assert.equal(store.sqlite.prepare('SELECT price FROM plans').get().price, 40000);
  assert.equal(store.sqlite.prepare('SELECT html FROM store_inbox').get().html, 'first message');
  assert.equal(store.sqlite.prepare('SELECT count(*) AS n FROM web_shop_sessions').get().n, 0);
  assert.equal(store.sqlite.prepare("SELECT hex(data) AS bytes FROM store_ticket_images WHERE id='attached'").get().bytes, 'FFD8FFD9');
  assert.equal(store.sqlite.prepare("SELECT 1 FROM store_ticket_images WHERE id='pending'").get(), undefined);
  assert.equal(store.sqlite.prepare('SELECT salt FROM store_accounts WHERE id=1').get().salt, 'new-owner-salt');
  assert.equal(store.sqlite.prepare("SELECT value FROM settings WHERE key='store_account_id_floor'").get().value, '30');
  assert.equal(store.sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name='orders'").get().seq, 40);
});

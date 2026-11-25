import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from './database.mjs';

const magic = Buffer.from('ASANGOZAR-BACKUP\x01');
const overhead = magic.length + 12 + 16;
export const BACKUP_LIMIT = 64 * 1024 ** 2;
const ticketLifetime = 120_000;

export class BackupError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function syncPath(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function removeSessions(sqlite) {
  sqlite.exec('DELETE FROM web_shop_sessions; DELETE FROM web_shop_limits;');
  if (sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='store_push_subscriptions'").get()) {
    sqlite.exec('DELETE FROM store_push_jobs; DELETE FROM store_push_subscriptions;');
  }
  if (sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='store_ticket_images'").get()) {
    return sqlite.prepare('DELETE FROM store_ticket_images WHERE message_id IS NULL').run().changes > 0;
  }
  return false;
}

function restoreData(snapshot, current, ownerId) {
  const owner = current.prepare('SELECT username,salt,password_hash FROM store_accounts WHERE id=? AND owner=1').get(ownerId);
  const saved = owner && snapshot.prepare('SELECT id FROM store_accounts WHERE username=? AND owner=1').get(owner.username);
  if (!saved) throw new BackupError('حساب مدیر اصلی شما در این نسخهٔ پشتیبان وجود ندارد.');
  snapshot.prepare('UPDATE store_accounts SET salt=?,password_hash=? WHERE id=?')
    .run(owner.salt, owner.password_hash, saved.id);
  removeSessions(snapshot);

  // Keep IDs from being reused for accounts or transactions created after the snapshot.
  const accountFloor = db => db.prepare(`SELECT MAX(COALESCE(MAX(id),0),
    COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key='store_account_id_floor'),0)) AS id FROM store_accounts`).get().id;
  snapshot.prepare(`INSERT INTO settings(key,value) VALUES('store_account_id_floor',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(Math.max(accountFloor(current), accountFloor(snapshot))));
  const sequence = snapshot.prepare('UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name=?');
  const addSequence = snapshot.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)');
  for (const { name, seq } of current.prepare('SELECT name,seq FROM sqlite_sequence').all()) {
    if (!sequence.run(seq, name).changes) addSequence.run(name, seq);
  }

  // A different system owns the VPN clients. Never replay old queued transfers or deletions.
  snapshot.exec(`INSERT INTO settings(key,value) VALUES('auto_delete_enabled','0')
    ON CONFLICT(key) DO UPDATE SET value='0';
    DELETE FROM settings WHERE key='subscription_policy_lease';
    UPDATE service_operations SET kind='auto_delete_review' WHERE kind='auto_delete_running';`);
  const update = snapshot.prepare('UPDATE settings SET value=? WHERE key=?');
  for (const row of snapshot.prepare("SELECT key,value FROM settings WHERE key LIKE 'bulk_migration:%'").iterate()) {
    const job = JSON.parse(row.value);
    let changed = false;
    for (const item of job.items) {
      if (!['pending', 'running'].includes(item.status)) continue;
      item.status = 'review';
      changed = true;
    }
    if (changed) update.run(JSON.stringify(job), row.key);
  }
}

export function createStoreBackups(database, secret, getStore, setStore, idle) {
  const folder = dirname(database);
  const key = hkdfSync('sha256', Buffer.from(secret, 'hex'), Buffer.alloc(0), 'asan-gozar-store-backup-v1', 32);
  const tickets = new Map();
  const workspace = () => mkdtempSync(join(folder, '.backup-'));

  return {
    download() {
      const directory = workspace();
      try {
        const file = join(directory, 'snapshot.sqlite');
        getStore().sqlite.prepare('VACUUM INTO ?').run(file);
        const snapshot = new DatabaseSync(file);
        try {
          if (removeSessions(snapshot)) snapshot.exec('VACUUM');
        } finally { snapshot.close(); }
        if (statSync(file).size + overhead > BACKUP_LIMIT) {
          throw new BackupError('اندازهٔ نسخهٔ پشتیبان بیشتر از ۶۴ مگابایت است.', 413);
        }
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(magic);
        const encrypted = cipher.update(readFileSync(file));
        return Buffer.concat([magic, nonce, encrypted, cipher.final(), cipher.getAuthTag()]);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    },

    issueTicket(session) {
      const now = Date.now();
      for (const [id, entry] of tickets) {
        if (entry.expires <= now || entry.owner === session.user_id) tickets.delete(id);
      }
      const ticket = randomBytes(24).toString('base64url');
      tickets.set(ticket, { session: session.token, owner: session.user_id, expires: now + ticketLifetime });
      return ticket;
    },

    consumeTicket(ticket, session) {
      const entry = tickets.get(ticket);
      if (entry?.session !== session.token || entry.expires <= Date.now()) return false;
      tickets.delete(ticket);
      return true;
    },

    restore(archive, ownerId) {
      if (!idle()) throw new BackupError('عملیاتی در حال اجراست. پس از پایان آن دوباره تلاش کنید.', 409);
      const data = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
      if (data.length <= overhead || data.length > BACKUP_LIMIT || !data.subarray(0, magic.length).equals(magic)) {
        throw new BackupError('فرمت نسخهٔ پشتیبان معتبر نیست.');
      }
      let plain;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(magic.length, magic.length + 12));
        decipher.setAAD(magic);
        decipher.setAuthTag(data.subarray(-16));
        plain = decipher.update(data.subarray(magic.length + 12, -16));
        decipher.final();
      } catch { throw new BackupError('فایل آسیب دیده یا متعلق به این نصب فروشگاه نیست.'); }

      const directory = workspace();
      try {
        const stage = join(directory, 'restored.sqlite');
        const previous = join(directory, 'previous.sqlite');
        writeFileSync(stage, plain, { mode: 0o600 });
        const snapshot = new DatabaseSync(stage, { enableForeignKeyConstraints: true });
        const current = getStore().sqlite;
        try {
          const integrity = snapshot.prepare('PRAGMA quick_check').get();
          if (integrity.quick_check !== 'ok' || snapshot.prepare('PRAGMA foreign_key_check').get()) {
            throw new BackupError('دیتابیس داخل نسخهٔ پشتیبان معتبر نیست.');
          }
          snapshot.exec('BEGIN IMMEDIATE');
          restoreData(snapshot, current, ownerId);
          snapshot.exec('COMMIT');
        } finally { snapshot.close(); }
        syncPath(stage);
        const checkpoint = current.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (checkpoint.busy) throw new BackupError('دیتابیس درگیر عملیات دیگری است. دوباره تلاش کنید.', 409);
        linkSync(database, previous);
        current.close();
        try {
          renameSync(stage, database);
          syncPath(folder);
          setStore(openStore(database));
        } catch (error) {
          renameSync(previous, database);
          setStore(openStore(database));
          throw error;
        }
        tickets.clear();
      } finally { rmSync(directory, { recursive: true, force: true }); }
    },
  };
}

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { WEB_SHOP_SCHEMA } from './shop-schema.js';
import { TICKET_SCHEMA } from './ticket-schema.mjs';

export function openStore(path) {
  const filename = path === ':memory:' ? path : resolve(path);
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const sqlite = new DatabaseSync(filename, { timeout: 5000, enableForeignKeyConstraints: true });
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  sqlite.exec('PRAGMA journal_mode=WAL;');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  sqlite.exec(WEB_SHOP_SCHEMA);
  sqlite.exec(TICKET_SCHEMA);
  sqlite.exec("INSERT OR IGNORE INTO settings(key,value) VALUES ('test_enabled','0'),('referral_discount','0'),('panel_group_ids','')");
  const statement = (query, args = []) => ({
    bind: (...values) => statement(query, values),
    execute() {
      const prepared = sqlite.prepare(query);
      if (prepared.columns().length) return { results: prepared.all(...args), meta: { changes: 0 } };
      const result = prepared.run(...args);
      return { results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    },
    async all() { return this.execute(); },
    async run() { return this.execute(); },
    async first() { return sqlite.prepare(query).get(...args) ?? null; },
  });
  const DB = {
    prepare: statement,
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(item => item.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { sqlite, DB };
}

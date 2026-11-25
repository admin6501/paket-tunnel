export const WEB_SHOP_SCHEMA = `
-- Standalone accounts, sessions, receipts and inbox.
CREATE TABLE IF NOT EXISTS store_accounts (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL, salt TEXT NOT NULL, password_hash BLOB NOT NULL,
  owner INTEGER NOT NULL DEFAULT 0 CHECK(owner IN (0,1)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS store_inbox (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES store_accounts(id),
  html TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS store_inbox_user ON store_inbox(user_id,id DESC);
CREATE TABLE IF NOT EXISTS web_shop_sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES store_accounts(id),
  expires_at INTEGER NOT NULL, admin_access INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}', view_json TEXT NOT NULL DEFAULT '[]',
  busy_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS web_shop_limits (
  bucket TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS web_shop_receipts (
  kind TEXT NOT NULL CHECK(kind IN ('order','topup')), reference INTEGER NOT NULL,
  image TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(kind,reference)
);
`;

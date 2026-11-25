export const PUSH_SCHEMA = `
CREATE TABLE IF NOT EXISTS store_push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES store_accounts(id),
  endpoint TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  auth_key TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS store_push_user ON store_push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS store_push_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES store_push_subscriptions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('ticket_new','ticket_reply','order_receipt','topup_receipt','test')),
  reference INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS store_push_due ON store_push_jobs(next_at,id);
CREATE INDEX IF NOT EXISTS store_push_subscription ON store_push_jobs(subscription_id);

CREATE TRIGGER IF NOT EXISTS store_push_ticket AFTER INSERT ON store_ticket_messages
WHEN NEW.kind='customer'
BEGIN
  INSERT INTO store_push_jobs(subscription_id,kind,reference,created_at,next_at)
  SELECT s.id,CASE WHEN initial THEN 'ticket_new' ELSE 'ticket_reply' END,NEW.ticket_id,NEW.created_at,NEW.created_at
  FROM store_push_subscriptions s JOIN store_tickets t ON t.id=NEW.ticket_id
  CROSS JOIN (SELECT NEW.id=(SELECT MIN(id) FROM store_ticket_messages WHERE ticket_id=NEW.ticket_id) AS initial)
  WHERE s.user_id<>NEW.actor_id AND (NOT initial OR t.legacy_key IS NULL);
END;

CREATE TRIGGER IF NOT EXISTS store_push_receipt_new AFTER INSERT ON web_shop_receipts
BEGIN
  INSERT INTO store_push_jobs(subscription_id,kind,reference,created_at,next_at)
  SELECT id,NEW.kind||'_receipt',NEW.reference,CAST(unixepoch('subsec')*1000 AS INTEGER),CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM store_push_subscriptions;
END;

CREATE TRIGGER IF NOT EXISTS store_push_receipt_updated AFTER UPDATE OF expires_at ON web_shop_receipts
WHEN OLD.expires_at<>NEW.expires_at
BEGIN
  INSERT INTO store_push_jobs(subscription_id,kind,reference,created_at,next_at)
  SELECT id,NEW.kind||'_receipt',NEW.reference,CAST(unixepoch('subsec')*1000 AS INTEGER),CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM store_push_subscriptions;
END;
`;

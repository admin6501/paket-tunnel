export const TICKET_SCHEMA = `
CREATE TABLE IF NOT EXISTS ticket_departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
) STRICT;
INSERT OR IGNORE INTO ticket_departments(id,name,description) VALUES
  (1,'پشتیبانی عمومی','پرسش‌ها و درخواست‌های عمومی'),
  (2,'پرداخت و سفارش','فیش پرداخت، کیف پول، خرید و تمدید'),
  (3,'پشتیبانی فنی','مشکلات اتصال یا راه‌اندازی سرویس');

CREATE TABLE IF NOT EXISTS store_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES store_accounts(id),
  department_id INTEGER NOT NULL REFERENCES ticket_departments(id),
  assignee_id INTEGER REFERENCES store_accounts(id),
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','waiting_customer','resolved','closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  legacy_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS store_tickets_customer ON store_tickets(customer_id,updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS store_tickets_queue ON store_tickets(updated_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS store_ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES store_tickets(id),
  actor_id INTEGER NOT NULL REFERENCES store_accounts(id),
  kind TEXT NOT NULL CHECK(kind IN ('customer','staff','note','event')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS store_ticket_thread ON store_ticket_messages(ticket_id,id DESC);
`;

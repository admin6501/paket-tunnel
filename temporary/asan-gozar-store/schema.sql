CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  service_name TEXT,
  volume TEXT,
  price INTEGER,
  discount INTEGER DEFAULT 0,
  final_price INTEGER,
  duration TEXT,
  renew_service_id INTEGER,
  gb REAL,
  days INTEGER,
  status TEXT DEFAULT 'pending',
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  name TEXT,
  volume TEXT,
  duration TEXT,
  sub_link TEXT,
  config_link TEXT,
  created_at TEXT,
  panel_email TEXT,
  inbound_id INTEGER,
  sub_id TEXT,
  volume_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS idx_services_user ON services(user_id);

CREATE TABLE IF NOT EXISTS discounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  amount INTEGER,
  used INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_discounts_user ON discounts(user_id, used);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER,
  referred_id INTEGER UNIQUE,
  created_at TEXT
);

-- بسته‌ها: با /setprice و /setplan در خود ربات عوض می‌شوند
CREATE TABLE IF NOT EXISTS plans (
  key TEXT PRIMARY KEY,
  gb REAL,
  price INTEGER,
  sort INTEGER
);

-- تنظیمات قابل تغییر با /set
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- ادمین‌های اضافه‌شده با /addadmin
CREATE TABLE IF NOT EXISTS admins (
  user_id INTEGER PRIMARY KEY,
  added_at TEXT
);

-- هر کاربر فقط یک‌بار سرویس تست می‌گیرد
CREATE TABLE IF NOT EXISTS test_claims (
  user_id INTEGER PRIMARY KEY,
  created_at TEXT
);


CREATE TABLE IF NOT EXISTS provision_attempts (attempt_key TEXT PRIMARY KEY, email TEXT NOT NULL, sub_id TEXT NOT NULL, inbound_id INTEGER NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS service_operations (service_id INTEGER PRIMARY KEY, kind TEXT NOT NULL, created_at TEXT NOT NULL);
-- Wallet migration: additive and repeatable; back up D1 before applying.
CREATE TABLE IF NOT EXISTS wallet_entries (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL CHECK(user_id > 0),
 delta INTEGER NOT NULL CHECK(typeof(delta)='integer' AND delta != 0 AND delta BETWEEN -9000000000000000 AND 9000000000000000),
 reference TEXT NOT NULL UNIQUE,
 reason TEXT NOT NULL,
 actor_id INTEGER,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallet_entries_user ON wallet_entries(user_id,id);
CREATE TRIGGER IF NOT EXISTS wallet_entries_balance_guard BEFORE INSERT ON wallet_entries BEGIN
 SELECT CASE WHEN COALESCE((SELECT SUM(delta) FROM wallet_entries WHERE user_id=NEW.user_id),0) + NEW.delta < 0 THEN RAISE(ABORT,'WALLET_INSUFFICIENT') END;
 SELECT CASE WHEN COALESCE((SELECT SUM(delta) FROM wallet_entries WHERE user_id=NEW.user_id),0) + NEW.delta > 9000000000000000 THEN RAISE(ABORT,'WALLET_LIMIT') END;
END;
CREATE TRIGGER IF NOT EXISTS wallet_entries_no_update BEFORE UPDATE ON wallet_entries BEGIN SELECT RAISE(ABORT,'WALLET_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS wallet_entries_no_delete BEFORE DELETE ON wallet_entries BEGIN SELECT RAISE(ABORT,'WALLET_IMMUTABLE'); END;

CREATE TABLE IF NOT EXISTS wallet_payments (
 order_id INTEGER PRIMARY KEY,
 user_id INTEGER NOT NULL CHECK(user_id>0),
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount BETWEEN 0 AND 9000000000000000),
 state TEXT NOT NULL CHECK(state IN ('processing','review','settled','refunded')),
 created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS wallet_payment_verify BEFORE INSERT ON wallet_payments BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM orders WHERE id=NEW.order_id AND user_id=NEW.user_id AND final_price=NEW.amount AND status='wallet_processing') THEN RAISE(ABORT,'WALLET_ORDER_MISMATCH') END;
END;
CREATE TRIGGER IF NOT EXISTS wallet_payment_debit AFTER INSERT ON wallet_payments WHEN NEW.amount>0 BEGIN
 INSERT INTO wallet_entries(user_id,delta,reference,reason,created_at) VALUES(NEW.user_id,-NEW.amount,'order:'||NEW.order_id||':debit','purchase',NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS wallet_payment_transition BEFORE UPDATE ON wallet_payments BEGIN
 SELECT CASE WHEN NEW.order_id!=OLD.order_id OR NEW.user_id!=OLD.user_id OR NEW.amount!=OLD.amount OR NEW.created_at!=OLD.created_at OR NOT ((OLD.state='processing' AND NEW.state IN ('review','settled','refunded')) OR (OLD.state='review' AND NEW.state IN ('settled','refunded'))) THEN RAISE(ABORT,'WALLET_INVALID_TRANSITION') END;
END;
CREATE TRIGGER IF NOT EXISTS wallet_payment_refund AFTER UPDATE OF state ON wallet_payments WHEN NEW.state='refunded' AND NEW.amount>0 BEGIN
 INSERT INTO wallet_entries(user_id,delta,reference,reason,created_at) VALUES(NEW.user_id,NEW.amount,'order:'||NEW.order_id||':refund','refund',NEW.created_at);
END;

CREATE TABLE IF NOT EXISTS wallet_topups (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL CHECK(user_id>0),
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount BETWEEN 1 AND 9000000000000000),
 status TEXT NOT NULL CHECK(status IN ('draft','pending','needs_fix','credited','rejected')),
 created_at TEXT NOT NULL,
 reviewed_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wallet_topups_user ON wallet_topups(user_id,id);
CREATE TRIGGER IF NOT EXISTS wallet_topup_transition BEFORE UPDATE ON wallet_topups BEGIN
 SELECT CASE WHEN NEW.user_id!=OLD.user_id OR NEW.amount!=OLD.amount OR NEW.created_at!=OLD.created_at OR NOT ((OLD.status IN ('draft','needs_fix') AND NEW.status='pending') OR (OLD.status='pending' AND NEW.status IN ('credited','needs_fix','rejected'))) THEN RAISE(ABORT,'WALLET_INVALID_TOPUP') END;
END;
CREATE TRIGGER IF NOT EXISTS wallet_topup_credit AFTER UPDATE OF status ON wallet_topups WHEN NEW.status='credited' BEGIN
 INSERT INTO wallet_entries(user_id,delta,reference,reason,actor_id,created_at) VALUES(NEW.user_id,NEW.amount,'topup:'||NEW.id,'topup',NEW.reviewed_by,NEW.created_at);
END;

CREATE TABLE IF NOT EXISTS wallet_review_resolutions (
 order_id INTEGER PRIMARY KEY,
 actor_id INTEGER NOT NULL,
 resolved_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_card_review_actions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id INTEGER NOT NULL,
 actor_id INTEGER NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('approved','pending','rejected')),
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_card_review_order ON store_card_review_actions(order_id,outcome);

-- Site customer profiles and access control.
CREATE TABLE IF NOT EXISTS store_profiles (
 user_id INTEGER PRIMARY KEY,
 first_name TEXT NOT NULL DEFAULT '',
 username TEXT NOT NULL DEFAULT '',
 blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
 last_seen TEXT NOT NULL DEFAULT ''
);

-- Store the panel group and duration with each category, plan, and order.
CREATE TABLE IF NOT EXISTS store_categories (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 group_ids TEXT NOT NULL,
 panel_identity TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS store_plan_specs (
 plan_key TEXT PRIMARY KEY,
 category_id INTEGER NOT NULL,
 days INTEGER NOT NULL CHECK(days > 0)
);
CREATE TABLE IF NOT EXISTS store_order_routes (
 order_id INTEGER PRIMARY KEY,
 group_ids TEXT NOT NULL,
 anchor_id INTEGER NOT NULL DEFAULT 0,
 panel_identity TEXT NOT NULL DEFAULT ''
);


-- Discount codes: existing purchases and their recorded usage remain intact on deletion.
CREATE TABLE IF NOT EXISTS store_coupons (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 code TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('percent','fixed')),
 value INTEGER NOT NULL CHECK(typeof(value)='integer' AND value>0 AND (kind!='percent' OR value<=100)),
 created_ms INTEGER NOT NULL,
 expires_ms INTEGER,
 total_limit INTEGER CHECK(total_limit IS NULL OR total_limit>0),
 user_limit INTEGER CHECK(user_limit IS NULL OR user_limit>0),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
);
CREATE UNIQUE INDEX IF NOT EXISTS store_coupon_code_live ON store_coupons(code) WHERE deleted=0;
CREATE TABLE IF NOT EXISTS store_coupon_uses (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 coupon_id INTEGER NOT NULL,
 order_id INTEGER NOT NULL,
 user_id INTEGER NOT NULL,
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
 created_ms INTEGER NOT NULL,
 expires_ms INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','consumed','released'))
);
CREATE UNIQUE INDEX IF NOT EXISTS store_coupon_order_live ON store_coupon_uses(order_id) WHERE state IN ('reserved','consumed');
CREATE INDEX IF NOT EXISTS store_coupon_usage ON store_coupon_uses(coupon_id,user_id,state);
CREATE TRIGGER IF NOT EXISTS store_coupon_validate BEFORE INSERT ON store_coupon_uses BEGIN
 SELECT CASE WHEN NEW.state!='reserved' OR NOT EXISTS(SELECT 1 FROM orders o WHERE o.id=NEW.order_id AND o.user_id=NEW.user_id AND o.status='draft' AND o.final_price>=NEW.amount) THEN RAISE(ABORT,'COUPON_ORDER_INVALID') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM store_coupons c JOIN orders o ON o.id=NEW.order_id WHERE c.id=NEW.coupon_id AND c.enabled=1 AND c.deleted=0 AND (c.expires_ms IS NULL OR c.expires_ms>NEW.created_ms) AND NEW.expires_ms>NEW.created_ms AND (c.expires_ms IS NULL OR NEW.expires_ms<=c.expires_ms) AND NEW.amount=CASE WHEN c.kind='fixed' THEN MIN(c.value,o.final_price) ELSE CAST(o.final_price*c.value/100 AS INTEGER) END) THEN RAISE(ABORT,'COUPON_INVALID') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM store_coupons c WHERE c.id=NEW.coupon_id AND c.total_limit IS NOT NULL AND (SELECT COUNT(*) FROM store_coupon_uses u JOIN orders o ON o.id=u.order_id WHERE u.coupon_id=c.id AND (u.state='consumed' OR (u.state='reserved' AND (u.expires_ms>NEW.created_ms OR o.status IN ('pending','processing','needs_review','wallet_processing')))))>=c.total_limit) THEN RAISE(ABORT,'COUPON_TOTAL_LIMIT') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM store_coupons c WHERE c.id=NEW.coupon_id AND c.user_limit IS NOT NULL AND (SELECT COUNT(*) FROM store_coupon_uses u JOIN orders o ON o.id=u.order_id WHERE u.coupon_id=c.id AND u.user_id=NEW.user_id AND (u.state='consumed' OR (u.state='reserved' AND (u.expires_ms>NEW.created_ms OR o.status IN ('pending','processing','needs_review','wallet_processing')))))>=c.user_limit) THEN RAISE(ABORT,'COUPON_USER_LIMIT') END;
END;
CREATE TRIGGER IF NOT EXISTS store_coupon_apply AFTER INSERT ON store_coupon_uses BEGIN
 UPDATE orders SET discount=COALESCE(discount,0)+NEW.amount,final_price=final_price-NEW.amount WHERE id=NEW.order_id AND status='draft';
END;
CREATE TRIGGER IF NOT EXISTS store_coupon_transition BEFORE UPDATE ON store_coupon_uses BEGIN
 SELECT CASE WHEN NEW.id!=OLD.id OR NEW.coupon_id!=OLD.coupon_id OR NEW.order_id!=OLD.order_id OR NEW.user_id!=OLD.user_id OR NEW.amount!=OLD.amount OR NEW.created_ms!=OLD.created_ms OR NEW.expires_ms!=OLD.expires_ms OR OLD.state!='reserved' OR NEW.state NOT IN ('consumed','released') THEN RAISE(ABORT,'COUPON_TRANSITION_INVALID') END;
END;
CREATE TRIGGER IF NOT EXISTS store_coupon_release AFTER UPDATE OF state ON store_coupon_uses WHEN NEW.state='released' BEGIN
 UPDATE orders SET discount=MAX(0,COALESCE(discount,0)-NEW.amount),final_price=final_price+NEW.amount,status='cancelled' WHERE id=NEW.order_id AND status IN ('draft','needs_fix');
END;

-- Outbound admin messages: delivery claims are persistent and not retried blindly.
CREATE TABLE IF NOT EXISTS store_message_jobs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 creator_id INTEGER NOT NULL,
 audience TEXT NOT NULL CHECK(audience='private'),
 target_id INTEGER,
 body TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','building','queued','done','cancelled')),
 created_ms INTEGER NOT NULL,
 finished_ms INTEGER
);
CREATE TABLE IF NOT EXISTS store_message_targets (
 job_id INTEGER NOT NULL,
 user_id INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','uncertain')),
 claimed_ms INTEGER,
 PRIMARY KEY(job_id,user_id)
);
CREATE INDEX IF NOT EXISTS store_message_pending ON store_message_targets(job_id,status,user_id);

-- Referral discounts stay reserved until the order succeeds or is cancelled.
CREATE TABLE IF NOT EXISTS store_order_referrals (
 order_id INTEGER PRIMARY KEY,
 discount_id INTEGER NOT NULL,
 user_id INTEGER NOT NULL,
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
 state TEXT NOT NULL CHECK(state IN ('reserved','consumed','released'))
);
CREATE UNIQUE INDEX IF NOT EXISTS store_referral_discount_live ON store_order_referrals(discount_id) WHERE state IN ('reserved','consumed');
CREATE TRIGGER IF NOT EXISTS store_referral_validate BEFORE INSERT ON store_order_referrals BEGIN
 SELECT CASE WHEN NEW.state!='reserved' OR NOT EXISTS(SELECT 1 FROM discounts d JOIN orders o ON o.id=NEW.order_id WHERE d.id=NEW.discount_id AND d.user_id=NEW.user_id AND d.used=0 AND d.amount>0 AND o.user_id=NEW.user_id AND o.status='draft' AND o.final_price>0 AND NEW.amount=MIN(d.amount,o.final_price)) THEN RAISE(ABORT,'REFERRAL_INVALID') END;
END;
CREATE TRIGGER IF NOT EXISTS store_referral_reserve AFTER INSERT ON store_order_referrals BEGIN
 UPDATE discounts SET used=1 WHERE id=NEW.discount_id AND used=0;
 UPDATE orders SET discount=COALESCE(discount,0)+NEW.amount,final_price=final_price-NEW.amount WHERE id=NEW.order_id AND status='draft';
END;
CREATE TRIGGER IF NOT EXISTS store_referral_transition BEFORE UPDATE ON store_order_referrals BEGIN
 SELECT CASE WHEN NEW.order_id!=OLD.order_id OR NEW.discount_id!=OLD.discount_id OR NEW.user_id!=OLD.user_id OR NEW.amount!=OLD.amount OR OLD.state!='reserved' OR NEW.state NOT IN ('consumed','released') THEN RAISE(ABORT,'REFERRAL_TRANSITION_INVALID') END;
END;
CREATE TRIGGER IF NOT EXISTS store_referral_release AFTER UPDATE OF state ON store_order_referrals WHEN NEW.state='released' BEGIN
 UPDATE discounts SET used=0 WHERE id=NEW.discount_id AND user_id=NEW.user_id;
END;
CREATE TRIGGER IF NOT EXISTS store_referral_order_cancel AFTER UPDATE OF status ON orders WHEN NEW.status IN ('cancelled','rejected','wallet_failed_refunded','needs_review_refunded') BEGIN
 UPDATE store_order_referrals SET state='released' WHERE order_id=NEW.id AND state='reserved';
END;
CREATE TRIGGER IF NOT EXISTS store_referral_order_complete AFTER UPDATE OF status ON orders WHEN NEW.status='approved' BEGIN
 UPDATE store_order_referrals SET state='consumed' WHERE order_id=NEW.id AND state='reserved';
END;

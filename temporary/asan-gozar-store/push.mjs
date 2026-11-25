import { createECDH, createHmac } from 'node:crypto';
import webPush from 'web-push';

const TTL = 60 * 60;
const MAX_DEVICES = 10;
const staff = '(a.owner=1 OR EXISTS(SELECT 1 FROM admins WHERE user_id=a.id))';
const providers = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();

export function pushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.href !== value || url.username || url.password || url.port || url.hash || url.protocol !== 'https:' ||
        url.pathname.length < 2 || !(providers.has(url.hostname) || url.hostname.endsWith('.notify.windows.com'))) return null;
    return url.href;
  } catch { return null; }
}

function keyBytes(value, size) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,90}$/.test(value)) return null;
  const key = Buffer.from(value, 'base64url');
  return key.length === size && key.toString('base64url') === value ? key : null;
}

export function createPushConfig(secret, origin) {
  const ecdh = createECDH('prime256v1');
  const curveOrder = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const seed = createHmac('sha256', Buffer.from(secret, 'hex')).update('store-web-push-v1').digest('hex');
  const scalar = 1n + BigInt('0x' + seed) % (curveOrder - 1n);
  const privateKey = Buffer.from(scalar.toString(16).padStart(64, '0'), 'hex');
  ecdh.setPrivateKey(privateKey);
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: privateKey.toString('base64url'), subject: origin };
}

export async function pushRequest(env, uid, action, body, json) {
  const config = env.WEB_SHOP_PUSH;
  if (!config) return json({ error: 'اعلان برنامه در دسترس نیست.' }, 503);
  if (!action) return json({ publicKey: config.publicKey });
  const endpoint = pushEndpoint(body?.endpoint);
  if (!endpoint) return json({ error: 'نشانی اعلان این مرورگر معتبر نیست.' }, 400);
  const db = env.DB;
  const match = 'endpoint=? AND user_id=?';
  if (action === 'status') return json({ enabled: Boolean(await first(db, `SELECT 1 FROM store_push_subscriptions WHERE ${match}`, endpoint, uid)) });
  if (action === 'unsubscribe') {
    await run(db, `DELETE FROM store_push_subscriptions WHERE ${match}`, endpoint, uid);
    return json({ enabled: false });
  }
  if (action === 'subscribe') {
    const key = keyBytes(body.keys?.p256dh, 65), auth = keyBytes(body.keys?.auth, 16);
    if (!key || key[0] !== 4 || !auth) return json({ error: 'کلیدهای اعلان مرورگر معتبر نیستند.' }, 400);
    const result = await run(db, `INSERT INTO store_push_subscriptions(user_id,endpoint,public_key,auth_key)
      SELECT a.id,?,?,? FROM store_accounts a WHERE a.id=? AND ${staff}
      AND (EXISTS(SELECT 1 FROM store_push_subscriptions WHERE ${match}) OR
        (SELECT COUNT(*) FROM store_push_subscriptions WHERE user_id=a.id)<?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,public_key=excluded.public_key,auth_key=excluded.auth_key
      WHERE store_push_subscriptions.user_id=excluded.user_id`, endpoint, body.keys.p256dh, body.keys.auth, uid, endpoint, uid, MAX_DEVICES);
    return result.meta.changes ? json({ enabled: true }) : json({ error: 'این دستگاه قابل فعال‌سازی نیست یا تعداد دستگاه‌ها به سقف رسیده است.' }, 409);
  }
  if (action === 'test') {
    const now = Date.now();
    const result = await run(db, `INSERT INTO store_push_jobs(subscription_id,kind,reference,created_at,next_at)
      SELECT s.id,'test',0,?,? FROM store_push_subscriptions s WHERE ${match}
      AND NOT EXISTS(SELECT 1 FROM store_push_jobs j WHERE j.subscription_id=s.id AND j.kind='test')`, now, now, endpoint, uid);
    return result.meta.changes ? json({ ok: true }) : json({ error: 'اعلان‌ها را فعال کنید یا منتظر اعلان آزمایشی قبلی بمانید.' }, 409);
  }
  return json({ error: 'درخواست اعلان معتبر نیست.' }, 404);
}

function notification(job) {
  const titles = {
    ticket_new: 'تیکت جدید', ticket_reply: 'پاسخ جدید مشتری', order_receipt: 'رسید جدید سفارش',
    topup_receipt: 'رسید جدید شارژ کیف پول', test: 'اعلان آزمایشی',
  };
  let path = '/account.html';
  if (job.kind.startsWith('ticket_')) path += `?staffTicket=${job.reference}#tickets`;
  else if (job.kind.endsWith('_receipt')) path += `?receipt=${job.kind.split('_')[0]}:${job.reference}#receipts`;
  return { title: titles[job.kind], path, tag: `store-push-${job.id}` };
}

export async function sendPendingPush({ DB: db, WEB_SHOP_PUSH: config }, send = webPush.sendNotification) {
  const now = Date.now();
  if (!(await first(db, 'SELECT 1 FROM store_push_jobs WHERE next_at<=? LIMIT 1', now))) return;
  await db.batch([
    db.prepare('DELETE FROM store_push_jobs WHERE created_at<=?').bind(now - TTL * 1000),
    db.prepare(`DELETE FROM store_push_subscriptions WHERE NOT EXISTS(
      SELECT 1 FROM store_accounts a WHERE a.id=store_push_subscriptions.user_id AND ${staff})`),
    db.prepare(`DELETE FROM store_push_jobs WHERE kind IN ('ticket_new','ticket_reply') AND NOT EXISTS(
      SELECT 1 FROM store_tickets t WHERE t.id=store_push_jobs.reference)`),
  ]);
  const { results } = await db.prepare(`SELECT j.*,s.endpoint,s.public_key,s.auth_key FROM store_push_jobs j
    JOIN store_push_subscriptions s ON s.id=j.subscription_id WHERE j.next_at<=? ORDER BY j.next_at,j.id LIMIT 20`).bind(now).all();
  await Promise.all(results.map(async job => {
    const endpoint = pushEndpoint(job.endpoint);
    if (!endpoint) {
      await run(db, 'DELETE FROM store_push_subscriptions WHERE id=?', job.subscription_id);
      return;
    }
    try {
      await send({ endpoint, keys: { p256dh: job.public_key, auth: job.auth_key } }, JSON.stringify(notification(job)),
        { TTL: Math.max(0, TTL - Math.floor((now - job.created_at) / 1000)), timeout: 8000, vapidDetails: config });
      await run(db, 'DELETE FROM store_push_jobs WHERE id=?', job.id);
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) await run(db, 'DELETE FROM store_push_subscriptions WHERE id=?', job.subscription_id);
      else if (job.attempts >= 6) await run(db, 'DELETE FROM store_push_jobs WHERE id=?', job.id);
      else await run(db, 'UPDATE store_push_jobs SET attempts=attempts+1,next_at=? WHERE id=?', now + 15_000 * 2 ** job.attempts, job.id);
    }
  }));
}

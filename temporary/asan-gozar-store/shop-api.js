import { checkPassword, hashPassword, validPassword, validUsername } from './auth.js';
import { deliverToInbox } from './inbox.js';
import { BACKUP_LIMIT, BackupError } from './backups.mjs';

const PREFIX = '/shop/api/';
const SESSION_COOKIE = '__Host-ag-session';
const SESSION_TTL = 12 * 60 * 60_000;
const RECEIPT_TTL = 30 * 24 * 60 * 60_000;
const TOKEN = /^[a-zA-Z0-9_-]{32}$/;
const IMAGE_LIMIT = 600_000;
const BODY_LIMIT = 810_000;

const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();
const first = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
const token = (size = 24) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(size)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const cookie = (name, value, age) => `${name}=${value}; Max-Age=${age}; Path=/; Secure; HttpOnly; SameSite=Strict`;
const cookieValue = (request, name) => new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]+)(?:;|$)`).exec(request.headers.get('cookie') || '')?.[1];
const json = (value, status = 200, cookies = []) => {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
  for (const item of cookies) headers.append('Set-Cookie', item);
  return new Response(JSON.stringify(value), { status, headers });
};

async function limited(env, key, maximum) {
  const period = Math.floor(Date.now() / 60_000);
  const bucket = await hash(`${period}:${key}`);
  const row = await first(env, `INSERT INTO web_shop_limits VALUES (?,1,?) ON CONFLICT(bucket)
    DO UPDATE SET hits=hits+1 RETURNING hits`, bucket, (period + 2) * 60_000);
  return row.hits > maximum;
}

async function readBytes(request, maximum) {
  if (!request.body || Number(request.headers.get('content-length')) > maximum) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch { return null; }
}

async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return null;
  const bytes = await readBytes(request, BODY_LIMIT);
  if (!bytes) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch { return null; }
}

function validImage(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(IMAGE_LIMIT / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
    if (bytes.length < 4 || bytes.length > IMAGE_LIMIT ||
        bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff ||
        bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
    return bytes;
  } catch { return null; }
}

function rows(markup) {
  return (markup?.inline_keyboard || []).map(row => row.map(button => {
    if (button.callback_data) return { text: button.text, action: button.callback_data };
    if (button.url && /^https:\/\//i.test(button.url)) return { text: button.text, url: button.url };
    return null;
  }).filter(Boolean)).filter(row => row.length);
}

function publicState(session) {
  const { step, admin_ui_step, admin_step } = JSON.parse(session.state_json);
  const input = ['panel_pass','mp_pass','mpedit_pass'].includes(admin_ui_step) ? 'password'
    : (admin_ui_step || admin_step || ['purchase_name_choice','service_name','test_name','wallet_amount','invite_code_input','coupon_code','support'].includes(step)) ? 'text'
    : ['receipt','wallet_receipt'].includes(step) ? 'image' : null;
  return { signedIn: true, admin: Boolean(session.admin_access), revision: session.revision, messages: JSON.parse(session.view_json), input };
}

async function isAdmin(env, uid) {
  return Boolean(await first(env, 'SELECT 1 FROM store_accounts WHERE owner=1 AND id=?', uid)) ||
    Boolean(await first(env, 'SELECT 1 FROM admins WHERE user_id=?', uid));
}

async function changePassword(request, env, session) {
  if (await limited(env, `password:${session.user_id}`, 5)) {
    return json({ error: 'بعد از یک دقیقه دوباره تلاش کنید.' }, 429);
  }
  const body = await readBody(request);
  if (!validPassword(body?.currentPassword) || !validPassword(body?.newPassword) || body.currentPassword === body.newPassword) {
    return json({ error: 'رمز جدید باید با رمز فعلی متفاوت و حداقل ۱۴ نویسه باشد.' }, 400);
  }
  const account = await first(env, 'SELECT salt,password_hash FROM store_accounts WHERE id=?', session.user_id);
  let replacement;
  try {
    if (!(await checkPassword(body.currentPassword, account))) return json({ error: 'رمز فعلی درست نیست.' }, 403);
    replacement = await hashPassword(body.newPassword);
  } catch {
    return json({ error: 'تغییر رمز موقتاً امکان‌پذیر نیست. دوباره تلاش کنید.' }, 503);
  }
  const now = Date.now();
  const [saved] = await env.DB.batch([
    env.DB.prepare(`UPDATE store_accounts SET salt=?,password_hash=? WHERE id=? AND salt=?
      AND EXISTS(SELECT 1 FROM web_shop_sessions WHERE token=? AND user_id=store_accounts.id AND expires_at>? AND busy_until<=?)`)
      .bind(replacement.salt, replacement.password_hash, session.user_id, account.salt, session.token, now, now),
    env.DB.prepare(`UPDATE web_shop_sessions SET expires_at=? WHERE user_id=?
      AND EXISTS(SELECT 1 FROM store_accounts WHERE id=web_shop_sessions.user_id AND salt=?)`)
      .bind(now, session.user_id, replacement.salt),
  ]);
  if (!saved.meta.changes) return json({ error: 'وضعیت حساب تغییر کرده است. دوباره تلاش کنید.' }, 409);
  return json({ signedIn: false }, 200, [cookie(SESSION_COOKIE, '', 0)]);
}

async function verifyCurrentPassword(env, session, password) {
  const account = await first(env, 'SELECT salt,password_hash FROM store_accounts WHERE id=?', session.user_id);
  try {
    if (await checkPassword(password, account)) return account;
  } catch { throw new BackupError('دوباره تلاش کنید.', 503); }
  throw new BackupError('رمز فعلی درست نیست.', 403);
}

async function resetCustomerPassword(request, env, session) {
  if (await limited(env, `password-reset:${session.user_id}`, 5)) {
    return json({ error: 'بعد از یک دقیقه دوباره تلاش کنید.' }, 429);
  }
  const body = await readBody(request);
  if (!Number.isSafeInteger(body?.userId) || body.userId <= 0 || !validPassword(body?.currentPassword) ||
      !validPassword(body?.newPassword) || body.currentPassword === body.newPassword) {
    return json({ error: 'شناسه و رمزها را بررسی کنید. رمز جدید دست‌کم ۱۴ نویسه باشد.' }, 400);
  }
  const customer = await first(env, 'SELECT salt FROM store_accounts WHERE id=?', body.userId);
  if (!customer || await isAdmin(env, body.userId)) return json({ error: 'حساب کاربر برای بازنشانی در دسترس نیست.' }, 403);
  let actor, replacement;
  try {
    actor = await verifyCurrentPassword(env, session, body.currentPassword);
    replacement = await hashPassword(body.newPassword);
  } catch (error) {
    return json({ error: error instanceof BackupError ? error.message : 'بازنشانی رمز موقتاً امکان‌پذیر نیست.' }, error.status || 503);
  }
  const now = Date.now();
  const [changed] = await env.DB.batch([
    env.DB.prepare(`UPDATE store_accounts SET salt=?,password_hash=? WHERE id=? AND salt=? AND owner=0
      AND NOT EXISTS(SELECT 1 FROM admins WHERE user_id=store_accounts.id)
      AND NOT EXISTS(SELECT 1 FROM web_shop_sessions WHERE user_id=store_accounts.id AND busy_until>?)
      AND EXISTS(SELECT 1 FROM web_shop_sessions s JOIN store_accounts a ON a.id=s.user_id
        WHERE s.token=? AND s.expires_at>? AND a.salt=?
        AND (a.owner=1 OR EXISTS(SELECT 1 FROM admins WHERE user_id=a.id)))`)
      .bind(replacement.salt, replacement.password_hash, body.userId, customer.salt, now, session.token, now, actor.salt),
    env.DB.prepare(`DELETE FROM web_shop_sessions WHERE user_id=?
      AND EXISTS(SELECT 1 FROM store_accounts WHERE id=web_shop_sessions.user_id AND salt=?)`)
      .bind(body.userId, replacement.salt),
  ]);
  return changed.meta.changes ? json({ ok: true }) : json({ error: 'وضعیت حساب تغییر کرده است. دوباره تلاش کنید.' }, 409);
}

async function manageBackup(route, request, env, session) {
  const backups = env.WEB_SHOP_BACKUPS;
  if (!backups) return json({ error: 'پشتیبان‌گیری در دسترس نیست.' }, 503);
  const activeOwner = salt => first(env, `SELECT 1 FROM store_accounts a JOIN web_shop_sessions s ON s.user_id=a.id
    WHERE a.owner=1 AND s.token=? AND s.expires_at>? AND (? IS NULL OR a.salt=?)`, session.token, Date.now(), salt, salt);
  try {
    if (route === 'backup/restore') {
      if (request.headers.get('content-type') !== 'application/octet-stream') {
        return json({ error: 'فایل نسخهٔ پشتیبان را انتخاب کنید.' }, 400);
      }
      if (!backups.consumeTicket(request.headers.get('x-asan-gozar-restore-key'), session)) {
        return json({ error: 'مجوز بازیابی منقضی شده است. دوباره تأیید کنید.' }, 403);
      }
      const data = await readBytes(request, BACKUP_LIMIT);
      if (!data) return json({ error: 'فایل معتبر نیست یا از ۶۴ مگابایت بزرگ‌تر است.' }, 413);
      if (!(await activeOwner(null))) return json({ error: 'دوباره وارد شوید.' }, 401);
      backups.restore(data, session.user_id);
      return json({ signedIn: false }, 200, [cookie(SESSION_COOKIE, '', 0)]);
    }
    if (await limited(env, `backup:${session.user_id}`, 6)) return json({ error: 'بعد از یک دقیقه دوباره تلاش کنید.' }, 429);
    const body = await readBody(request);
    if (!validPassword(body?.currentPassword)) return json({ error: 'رمز فعلی را وارد کنید.' }, 400);
    const owner = await verifyCurrentPassword(env, session, body.currentPassword);
    if (!(await activeOwner(owner.salt))) return json({ error: 'دوباره وارد شوید.' }, 401);
    if (route === 'backup/authorize-restore') return json({ ticket: backups.issueTicket(session) });
    return new Response(backups.download(), { headers: {
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Disposition': `attachment; filename="asan-gozar-${new Date().toISOString().slice(0, 10)}.agbackup"`,
    } });
  } catch (error) {
    if (error instanceof BackupError) return json({ error: error.message }, error.status);
    console.error('Store backup operation failed:', error.code || error.name);
    return json({ error: 'عملیات پشتیبان‌گیری کامل نشد. دوباره تلاش کنید.' }, 500);
  }
}

export async function webShopReview(env, uid, action) {
  if (!env.WEB_STATE || !(await isAdmin(env, uid))) return null;
  if (action === 'web:orders' || /^web:orders:\d{1,4}$/.test(action)) {
    const page = Number(action.split(':')[2] || 0);
    const items = await all(env, `SELECT r.kind,r.reference FROM web_shop_receipts r
      LEFT JOIN orders o ON r.kind='order' AND o.id=r.reference
      LEFT JOIN wallet_topups w ON r.kind='topup' AND w.id=r.reference
      WHERE r.expires_at>? AND (o.status='pending' OR w.status='pending')
      ORDER BY r.expires_at DESC LIMIT 11 OFFSET ?`, Date.now(), page * 10);
    const buttons = items.slice(0, 10).map(r => [{ text: `${r.kind === 'order' ? 'سفارش' : 'شارژ کیف پول'} ${r.reference}`, callback_data: `web:receipt:${r.kind}:${r.reference}` }]);
    const nav = [];
    if (page) nav.push({ text: 'قبلی', callback_data: `web:orders:${page - 1}` });
    if (items.length > 10) nav.push({ text: 'بعدی', callback_data: `web:orders:${page + 1}` });
    if (nav.length) buttons.push(nav);
    buttons.push([{ text: 'پنل مدیریت', callback_data: 'admin:root' }]);
    return { text: items.length ? 'فیش‌های در انتظار بررسی' : 'فیشی در انتظار بررسی نیست.', buttons };
  }
  const match = /^web:receipt:(order|topup):(\d+)$/.exec(action);
  if (!match) return null;
  const [, kind, reference] = match;
  const result = kind === 'order'
    ? await first(env, "SELECT final_price AS amount,user_id FROM orders WHERE id=? AND status='pending'", Number(reference))
    : await first(env, "SELECT amount,user_id FROM wallet_topups WHERE id=? AND status='pending'", Number(reference));
  const receipt = result && await first(env, 'SELECT 1 FROM web_shop_receipts WHERE kind=? AND reference=? AND expires_at>?', kind, Number(reference), Date.now());
  if (!receipt) return { text: 'این فیش دیگر در انتظار تأیید نیست.', buttons: [[{ text: 'فیش‌ها', callback_data: 'web:orders' }]] };
  return {
    text: `فیش ${kind === 'order' ? 'سفارش' : 'شارژ'} ${reference}\nکاربر: ${result.user_id}\nمبلغ: ${Number(result.amount).toLocaleString('fa-IR')} تومان`,
    image: `${PREFIX}receipt?kind=${kind}&id=${reference}`,
    buttons: [
      kind === 'order'
        ? [{ text: 'تأیید سفارش', callback_data: `approve_${reference}` }, { text: 'رد سفارش', callback_data: `reject_order:${reference}` }]
        : [{ text: 'تأیید شارژ', callback_data: `topup:approve:${reference}` }, { text: 'رد شارژ', callback_data: `topup:reject:${reference}` }],
      [{ text: 'فیش‌ها', callback_data: 'web:orders' }],
    ],
  };
}

export async function pruneWebShop(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM store_inbox WHERE created_at<=?').bind(now - 90 * 24 * 60 * 60_000),
    env.DB.prepare('DELETE FROM web_shop_sessions WHERE expires_at<=? AND busy_until<=?').bind(now - RECEIPT_TTL, now),
    env.DB.prepare('DELETE FROM web_shop_limits WHERE expires_at<=?').bind(now),
    env.DB.prepare('DELETE FROM web_shop_receipts WHERE expires_at<=?').bind(now),
  ]);
}

export async function webShopRequest(request, env, update) {
  const url = new URL(request.url);
  const route = url.pathname.slice(PREFIX.length);
  const origin = request.headers.get('origin');
  if (request.method !== 'GET' && (request.method !== 'POST' || origin !== env.WEB_SHOP_ORIGIN)) {
    return json({ error: 'درخواست مجاز نیست.' }, 403);
  }
  const ip = env.WEB_SHOP_IP || 'unknown';
  const now = Date.now();
  if (await limited(env, `request:${ip}`, 90)) return json({ error: 'لطفاً کمی صبر کنید.' }, 429);

  if (route === 'catalog' && request.method === 'GET') {
    const plans = await all(env, `SELECT c.id AS categoryId,c.name AS category,p.gb,p.price,s.days
      FROM plans p JOIN store_plan_specs s ON s.plan_key=p.key JOIN store_categories c ON c.id=s.category_id
      WHERE c.active=1 ORDER BY c.id,p.sort,p.price,p.key`);
    return json({ plans });
  }

  if (['register','login'].includes(route) && request.method === 'POST') {
    if (await limited(env, `login:${ip}`, 8)) return json({ error: 'بعد از یک دقیقه دوباره تلاش کنید.' }, 429);
    const body = await readBody(request);
    const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
    const display = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!validUsername(username) || !validPassword(body?.password) ||
        (route === 'register' && (display.length < 2 || display.length > 80 || /[\x00-\x1f]/.test(display)))) {
      return json({ error: 'نام کاربری یا رمز معتبر نیست. رمز حداقل ۱۴ نویسه باشد.' }, 400);
    }
    if (await limited(env, `login-user:${username}`, 8)) return json({ error: 'بعد از یک دقیقه دوباره تلاش کنید.' }, 429);
    let account = await first(env, 'SELECT id,username,display_name,salt,password_hash FROM store_accounts WHERE username=?', username);
    let passwordOK = false;
    try {
      if (route === 'login') passwordOK = await checkPassword(body.password, account);
      else {
        const hashed = await hashPassword(body.password);
        const created = await first(env, `INSERT INTO store_accounts(id,username,display_name,salt,password_hash,created_at)
          SELECT MAX(COALESCE(MAX(id),0),COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key='store_account_id_floor'),0))+1,
          ?,?,?,?,? FROM store_accounts WHERE 1 ON CONFLICT(username) DO NOTHING RETURNING id,username,display_name,salt`,
          username, display, hashed.salt, hashed.password_hash, now);
        if (!created) return json({ error: 'این نام کاربری در دسترس نیست.' }, 409);
        account = created;
        passwordOK = true;
      }
    } catch { return json({ error: 'ورود موقتاً امکان‌پذیر نیست. دوباره تلاش کنید.' }, 503); }
    const blocked = account && await first(env, 'SELECT 1 FROM store_profiles WHERE user_id=? AND blocked=1', account.id);
    if (!passwordOK || blocked) return json({ error: 'ورود ناموفق بود.' }, 401);
    const session = token();
    const key = await hash(session);
    await run(env, `INSERT INTO web_shop_sessions(token,user_id,expires_at,admin_access)
      SELECT ?,id,?,? FROM store_accounts WHERE id=? AND salt=?
      ON CONFLICT(user_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at,
      state_json=CASE WHEN web_shop_sessions.admin_access=excluded.admin_access THEN web_shop_sessions.state_json ELSE '{}' END,
      view_json=CASE WHEN web_shop_sessions.admin_access=excluded.admin_access THEN web_shop_sessions.view_json ELSE '[]' END,
      admin_access=excluded.admin_access,revision=web_shop_sessions.revision+1,busy_until=0
      WHERE web_shop_sessions.busy_until<=?`,
      key, now + SESSION_TTL, Number(await isAdmin(env, account.id)), account.id, account.salt, now);
    const saved = await first(env, 'SELECT 1 FROM web_shop_sessions WHERE token=?', key);
    if (!saved) return json({ error: 'یک عملیات در حال اجراست. بعد از پایان دوباره وارد شوید.' }, 409);
    return json({ signedIn: true }, 200, [cookie(SESSION_COOKIE, session, SESSION_TTL / 1000)]);
  }

  const value = cookieValue(request, SESSION_COOKIE);
  const sessionKey = TOKEN.test(value || '') ? await hash(value) : '';
  const session = sessionKey && await first(env, 'SELECT * FROM web_shop_sessions WHERE token=? AND expires_at>?', sessionKey, now);
  if (!session) return ['state','session'].includes(route) && request.method === 'GET' ? json({ signedIn: false }) : json({ error: 'دوباره وارد شوید.' }, 401);
  if (route === 'logout' && request.method === 'POST') {
    await run(env, 'UPDATE web_shop_sessions SET expires_at=? WHERE token=?', now, sessionKey);
    return json({ signedIn: false }, 200, [cookie(SESSION_COOKIE, '', 0)]);
  }
  const admin = await isAdmin(env, session.user_id);
  const blocked = !admin && await first(env, 'SELECT 1 FROM store_profiles WHERE user_id=? AND blocked=1', session.user_id);
  if (blocked || Boolean(session.admin_access) !== admin) {
    await run(env, 'DELETE FROM web_shop_sessions WHERE token=?', sessionKey);
    return json({ error: blocked ? 'دسترسی حساب مسدود شده است.' : 'سطح دسترسی حساب تغییر کرده است. دوباره وارد شوید.' }, 401,
      [cookie(SESSION_COOKIE, '', 0)]);
  }
  if (route === 'session' && request.method === 'GET') return json({ signedIn: true });
  if (route === 'state' && request.method === 'GET') return json(publicState(session));
  if (route === 'password' && request.method === 'POST') return changePassword(request, env, session);
  if (route === 'admin/password' && request.method === 'POST') {
    return admin ? resetCustomerPassword(request, env, session) : json({ error: 'دسترسی ندارید.' }, 403);
  }
  if (['backup/download','backup/authorize-restore','backup/restore'].includes(route) && request.method === 'POST') {
    const owner = admin && await first(env, 'SELECT 1 FROM store_accounts WHERE id=? AND owner=1', session.user_id);
    return owner ? manageBackup(route, request, env, session) : json({ error: 'این بخش مخصوص مدیر اصلی است.' }, 403);
  }
  if (route === 'inbox' && request.method === 'GET') {
    const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before <= 0) return json({ error: 'صفحه معتبر نیست.' }, 400);
    const items = await all(env, 'SELECT id,html,created_at,read_at FROM store_inbox WHERE user_id=? AND id<? ORDER BY id DESC LIMIT 21',
      session.user_id, before);
    return json({ messages: items.slice(0, 20), next: items.length > 20 ? items[19].id : null });
  }
  if (route === 'inbox/read' && request.method === 'POST') {
    const body = await readBody(request);
    if (!Number.isSafeInteger(body?.upTo) || body.upTo <= 0) return json({ error: 'پیام معتبر نیست.' }, 400);
    await run(env, 'UPDATE store_inbox SET read_at=? WHERE user_id=? AND id<=? AND read_at IS NULL', now, session.user_id, body.upTo);
    return json({ ok: true });
  }
  if (route === 'receipt' && request.method === 'GET') {
    if (!admin) return json({ error: 'دسترسی ندارید.' }, 403);
    const kind = url.searchParams.get('kind');
    const id = Number(url.searchParams.get('id'));
    const receipt = ['order','topup'].includes(kind) && Number.isSafeInteger(id) &&
      await first(env, 'SELECT image FROM web_shop_receipts WHERE kind=? AND reference=? AND expires_at>?', kind, id, now);
    const bytes = receipt && validImage(receipt.image);
    return bytes ? new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' } })
      : json({ error: 'فیش یافت نشد.' }, 404);
  }
  if (route !== 'action' || request.method !== 'POST') return json({ error: 'یافت نشد.' }, 404);
  if (await limited(env, `actor:${session.user_id}`, 30)) return json({ error: 'لطفاً کمی صبر کنید.' }, 429);
  const body = await readBody(request);
  if (!body || body.revision !== session.revision) return json({ error: 'صفحه را تازه کنید.' }, 409);
  const choices = JSON.parse(session.view_json).flatMap(message => message.rows.flat()).map(button => button.action)
    .filter(action => action !== 'web:backup' && !action?.startsWith('web:reset_password:'));
  const state = JSON.parse(session.state_json);
  const image = body.kind === 'image' && validImage(body.image);
  const input = publicState(session).input;
  const typed = typeof body.text === 'string' && body.text.trim().length > 0 && body.text.length <= 3500 &&
    (input === 'password' || !body.text.trimStart().startsWith('/'));
  const valid = body.kind === 'home' || (body.kind === 'button' && typeof body.action === 'string' && choices.includes(body.action)) ||
    (body.kind === 'text' && typed && ['text','password'].includes(input)) || (image && input === 'image');
  if (!valid) return json({ error: 'ورودی یا گزینه معتبر نیست.' }, 400);
  const locked = await run(env, `UPDATE web_shop_sessions SET busy_until=?,revision=revision+1
    WHERE token=? AND revision=? AND busy_until<=? AND expires_at>?`, now + 5 * 60_000, sessionKey, session.revision, now, now);
  if (!locked.meta.changes) return json({ error: 'یک درخواست در حال اجراست.' }, 409);

  const account = await first(env, 'SELECT id,username,display_name FROM store_accounts WHERE id=?', session.user_id);
  const user = { id: account.id, username: account.username, first_name: account.display_name };
  const view = [];
  const settings = { state };
  const record = (text, keyboard, photo) => {
    if (view.length >= 20) return;
    view.push({ html: String(text || '').slice(0, 16_000), rows: rows(keyboard), ...(photo ? { photo } : {}) });
  };
  const send = async (method, params) => {
    if (method === 'answerCallbackQuery') {
      if (params.text) record(params.text);
      return { ok: true };
    }
    if (method === 'copyMessage' && image && params.from_chat_id === user.id) {
      const kind = state.step === 'wallet_receipt' ? 'topup' : 'order';
      const reference = Number(kind === 'topup' ? state.wallet_topup_id : state.order_id);
      if (!Number.isSafeInteger(reference) || reference <= 0) return { ok: false };
      await run(env, `INSERT INTO web_shop_receipts VALUES (?,?,?,?) ON CONFLICT(kind,reference)
        DO UPDATE SET image=excluded.image,expires_at=excluded.expires_at`,
        kind, reference, body.image, now + RECEIPT_TTL);
      return { ok: true };
    }
    if (params.chat_id !== user.id) return deliverToInbox(env, method, params);
    if (method === 'sendMessage' || method === 'sendPhoto' || method === 'editMessageText') {
      record(params.text || params.caption, params.reply_markup, method === 'sendPhoto' ? params.photo : null);
      return { ok: true, result: { message_id: 1 } };
    }
    if (method === 'editMessageReplyMarkup' || method === 'deleteMessage') return { ok: true };
    return deliverToInbox(env, method, params);
  };
  const chat = { id: user.id, type: 'private' };
  const message = { from: user, chat, message_id: 1 };
  const event = body.kind === 'button' ? {
    callback_query: { from: user, id: token(), data: body.action, message },
  } : { message: { ...message, ...(image ? { photo: [{ file_id: 'web-shop-receipt' }] } :
    { text: body.kind === 'home' ? '/start' : input === 'password' ? body.text : body.text.trim() }) } };
  try {
    await update({ ...env, WEB_STATE: settings, WEB_DELIVERY: send, WEB_RECORD: record }, event);
    if (!view.length) record('نتیجه نمایش داده نشد. پیش از تکرار پرداخت، سرویس‌ها یا کیف پول را بررسی کنید.');
    if (body.kind === 'button' && view.every(message => !message.rows.length) && settings.state === state &&
        JSON.stringify(state) === session.state_json) {
      const buttons = JSON.parse(session.view_json).flatMap(message => message.rows);
      if (buttons.length && !/^(approve_|topup:)/.test(body.action)) view[view.length - 1].rows = buttons;
    }
  } catch {
    record('وضعیت درخواست نامشخص است. پیش از تکرار عملیات مالی، وضعیت سفارش را بررسی کنید.');
  } finally {
    await run(env, `UPDATE web_shop_sessions SET busy_until=0,state_json=?,view_json=?
      WHERE token=? AND revision=?`, JSON.stringify(settings.state), JSON.stringify(view), sessionKey, session.revision + 1);
  }
  return json(publicState({ ...session, revision: session.revision + 1, state_json: JSON.stringify(settings.state), view_json: JSON.stringify(view) }));
}

export function isWebShopPath(pathname) {
  return pathname.startsWith(PREFIX);
}

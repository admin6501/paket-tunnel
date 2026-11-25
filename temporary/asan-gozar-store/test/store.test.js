import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../database.mjs';
import { hashPassword } from '../auth.js';
import { handleUpdate } from '../engine.js';
import { webShopRequest } from '../shop-api.js';
import { listenForWebShop } from '../http.mjs';
import { deliverToInbox } from '../inbox.js';
import { processMessageJobs } from '../messages.js';
import { panelAccountKey, panelURL } from '../panel-config.js';
import { fileURLToPath } from 'node:url';
import { loadStorePages, webStorePage } from '../site.mjs';
import { createPushConfig, sendPendingPush } from '../push.mjs';
import webPush from 'web-push';

const origin = 'https://store.example';
const password = 'unique-long-test-password';

async function fixture(t) {
  const { sqlite, DB } = openStore(':memory:');
  t.after(() => sqlite.close());
  const hash = await hashPassword(password);
  const owner = sqlite.prepare('INSERT INTO store_accounts(username,display_name,salt,password_hash,owner,created_at) VALUES (?,?,?,?,1,?) RETURNING id')
    .get('owner', 'Shop Owner', hash.salt, hash.password_hash, Date.now());
  const env = { DB, STORE_SECRET: '0'.repeat(64), WEB_SHOP_ORIGIN: origin, OWNER_IDS: String(owner.id),
    WEB_SHOP_PUSH: createPushConfig('0'.repeat(64), origin),
    PANEL_URL: 'https://panel.example', PANEL_USER: 'admin', PANEL_PASS: 'fixture',
    CARD_NUMBER: '1234123412341234', CARD_HOLDER: 'Fixture' };
  return { sqlite, env, owner };
}

function browser(env, ip) {
  let cookie = '';
  let state;
  async function request(path, body, from = origin) {
    const binary = body instanceof Uint8Array;
    const res = await webShopRequest(new Request(`${origin}/shop/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: from, Cookie: cookie, 'Content-Type': binary ? 'image/jpeg' : 'application/json' },
      ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
    }), { ...env, WEB_SHOP_IP: ip }, handleUpdate);
    const set = res.headers.get('set-cookie');
    if (set) {
      assert.match(set, /^__Host-ag-session=.*Path=\/; Secure; HttpOnly; SameSite=Strict/);
      cookie = set.split(';')[0];
    }
    const data = res.headers.get('content-type').startsWith('image/')
      ? new Uint8Array(await res.arrayBuffer()) : await res.json();
    return { status: res.status, data };
  }
  const buttons = () => state.messages.flatMap(message => message.rows.flat()).map(button => button.action);
  return {
    request,
    get state() { return state; },
    buttons,
    async init() {
      state = (await request('state')).data;
      assert.equal(state.signedIn, true);
      if (!state.messages.length) await this.act({kind:'home'});
    },
    async act(body) {
      const result = await request('action', { ...body, revision: state.revision });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      state = result.data;
      assert.doesNotMatch(JSON.stringify(state), /وضعیت درخواست نامشخص است/);
      return state;
    },
    async press(action) {
      assert.ok(buttons().includes(action), action + ' ' + JSON.stringify(state));
      return this.act({ kind:'button', action });
    },
  };
}

const testJPEG = Uint8Array.of(0xff,0xd8,0xff,0xd9);
const image = Buffer.from(testJPEG).toString('base64');

test('web app alerts are opt-in, restricted to staff and delivered once for each new ticket, reply and receipt', async t => {
  const { env, sqlite } = await fixture(t);
  const admin = browser(env, '192.0.2.208'), buyer = browser(env, '192.0.2.209');
  await admin.request('login', { username: 'owner', password });
  await buyer.request('register', { name: 'Buyer', username: 'buyer', password });
  const endpoint = 'https://fcm.googleapis.com/fcm/send/test-device';
  const keys = { p256dh: createPushConfig('a'.repeat(64), origin).publicKey, auth: Buffer.alloc(16, 1).toString('base64url') };
  assert.equal((await buyer.request('admin/push/subscribe', { endpoint, keys })).status, 403);
  assert.deepEqual((await admin.request('admin/push')).data, { publicKey: env.WEB_SHOP_PUSH.publicKey });
  assert.equal((await admin.request('admin/push/subscribe', { endpoint: 'https://example.net/unrecognized', keys })).status, 400);
  assert.equal((await admin.request('admin/push/subscribe', { endpoint, keys }, 'https://other.example')).status, 403);
  assert.deepEqual((await admin.request('admin/push/subscribe', { endpoint, keys })).data, { enabled: true });
  assert.deepEqual((await admin.request('admin/push/status', { endpoint })).data, { enabled: true });
  const opened = await buyer.request('tickets', { department: 1, subject: 'private subject', message: 'private message' });
  assert.equal(opened.status, 201);
  const ticket = opened.data.id;
  assert.equal((await buyer.request(`tickets/${ticket}/reply`, { version: 0, message: 'another message' })).status, 200);
  assert.equal((await admin.request(`admin/tickets/${ticket}/reply`, { version: 1, message: 'staff note', internal: true })).status, 200);
  sqlite.exec(`INSERT INTO web_shop_receipts VALUES('order',42,'photo',1),('topup',43,'photo',1);
    UPDATE web_shop_receipts SET image='same upload',expires_at=1;`);
  assert.equal((await admin.request('admin/push/test', { endpoint })).status, 200);
  const received = [];
  await sendPendingPush(env, async (device, payload, options) => {
    assert.equal(device.endpoint, endpoint);
    const encrypted = webPush.generateRequestDetails(device, payload, options);
    assert.ok(encrypted.body.length > 0);
    assert.equal(encrypted.headers['Content-Encoding'], 'aes128gcm');
    assert.doesNotMatch(payload, /private|another message|staff note|same upload/);
    received.push(JSON.parse(payload));
  });
  assert.deepEqual(received.map(item => item.path), [
    `/account.html?staffTicket=${ticket}#tickets`, `/account.html?staffTicket=${ticket}#tickets`,
    '/account.html?receipt=order:42#receipts', '/account.html?receipt=topup:43#receipts', '/account.html',
  ]);
  assert.equal(new Set(received.map(item => item.tag)).size, 5);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM store_push_jobs').get().n, 0);
  assert.equal((await admin.request('admin/push/test', { endpoint })).status, 200);
  await sendPendingPush(env, async () => { throw Object.assign(new Error('Service busy'), { statusCode: 503 }); });
  assert.equal(sqlite.prepare('SELECT attempts FROM store_push_jobs').get().attempts, 1);
  sqlite.exec('UPDATE store_push_jobs SET next_at=0');
  await sendPendingPush(env, async () => { throw Object.assign(new Error('Subscription expired'), { statusCode: 410 }); });
  assert.deepEqual((await admin.request('admin/push/status', { endpoint })).data, { enabled: false });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM store_push_jobs').get().n, 0);
  assert.equal((await admin.request('admin/push/subscribe', { endpoint, keys })).status, 200);
  assert.equal((await admin.request('logout', { pushEndpoint: endpoint })).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM store_push_subscriptions').get().n, 0);
});

test('ticket queue routes private threads, replies, assignments and existing inbox requests', async t => {
  const { env, sqlite, owner } = await fixture(t);
  const admin = browser(env, '192.0.2.123'), buyer = browser(env, '192.0.2.124'), stranger = browser(env, '192.0.2.125');
  assert.equal((await buyer.request('tickets')).status, 401);
  assert.equal((await admin.request('login', { username: 'owner', password })).status, 200);
  assert.equal((await buyer.request('register', { name: 'Buyer', username: 'buyer', password })).status, 200);
  assert.equal((await stranger.request('register', { name: 'Stranger', username: 'stranger', password })).status, 200);
  assert.equal((await buyer.request('admin/tickets')).status, 403);
  const departments = (await buyer.request('tickets/departments')).data.departments;
  assert.equal(departments.length, 3);
  const opened = await buyer.request('tickets', { department: departments[0].id, subject: 'مشکل اتصال', message: 'توضیح اول' });
  assert.equal(opened.status, 201);
  const id = opened.data.id;
  assert.match(JSON.stringify((await admin.request('inbox')).data), new RegExp('staffTicket=' + id));
  assert.equal((await stranger.request('tickets/' + id)).status, 404);
  assert.equal((await stranger.request('tickets/' + id + '/reply', { version: 0, message: 'forbidden' })).status, 404);
  const queue = await admin.request('admin/tickets?status=active&q=buyer');
  assert.equal(queue.data.tickets.length, 1);
  const base = 'admin/tickets/' + id;
  assert.equal((await admin.request(base + '/update', { version: 0, status: 'in_progress', department: 3, priority: 'urgent', assignee: owner.id })).status, 200);
  assert.equal((await admin.request(base + '/update', { version: 0, status: 'closed', department: 3, priority: 'normal', assignee: null })).status, 409);
  assert.equal((await admin.request('admin/tickets?assignment=mine&department=3')).data.tickets[0].id, id);
  assert.equal((await admin.request(base + '/reply', { version: 1, internal: true, message: 'یادداشت خصوصی' })).status, 200);
  assert.equal((await admin.request(base + '/reply', { version: 2, message: 'لطفاً نتیجه را بفرستید' })).status, 200);
  const customer = (await buyer.request('tickets/' + id)).data;
  assert.equal(customer.ticket.status, 'waiting_customer');
  assert.deepEqual(customer.messages.map(message => message.kind), ['customer', 'staff']);
  assert.match(JSON.stringify((await buyer.request('inbox')).data), new RegExp('ticket=' + id));
  assert.equal((await buyer.request('tickets/' + id + '/reply', { version: 3, message: 'نتیجهٔ مشتری' })).status, 200);
  assert.equal((await admin.request(base)).data.ticket.status, 'open');
  assert.equal((await buyer.request('tickets/' + id + '/update', { version: 4, status: 'resolved' })).status, 403);
  assert.equal((await buyer.request('tickets/' + id + '/update', { version: 4, status: 'closed' })).status, 200);
  assert.equal((await buyer.request('tickets/' + id + '/reply', { version: 5, message: 'بسته است' })).status, 409);
  assert.equal((await buyer.request('tickets/' + id + '/update', { version: 5, status: 'open' })).status, 403);
  assert.equal((await admin.request(base + '/reply', { version: 5, message: 'پاسخ پشتیبانی پس از بستن' })).status, 200);
  const closed = (await buyer.request('tickets/' + id)).data;
  assert.equal(closed.ticket.status, 'closed');
  assert.equal(closed.messages.at(-1).body, 'پاسخ پشتیبانی پس از بستن');
  assert.equal((await admin.request(base + '/update', { version: 6, status: 'open', department: 3, priority: 'urgent', assignee: owner.id })).status, 200);
  assert.equal((await buyer.request('tickets/' + id + '/reply', { version: 7, message: 'پاسخ پس از بازگشایی' })).status, 200);

  const inactive = { id: 3, name: 'فنی شبکه', description: 'نیاز به بررسی', active: false };
  assert.equal((await admin.request('admin/tickets/departments', inactive)).status, 200);
  assert.ok(!(await buyer.request('tickets/departments')).data.departments.some(unit => unit.id === 3));
  assert.equal((await buyer.request('tickets', { department: 3, subject: 'آزمایش', message: 'رد شود' })).status, 409);
  assert.equal((await admin.request(base)).data.ticket.department, 'فنی شبکه');
  const buyerId = sqlite.prepare("SELECT id FROM store_accounts WHERE username='buyer'").get().id;
  const old = await deliverToInbox(env, 'sendMessage', { chat_id: owner.id,
    text: `درخواست پشتیبانی از کاربر ${buyerId} (@buyer):\nپیام قدیمی &lt;متن&gt;` });
  const messageId = old.result.message_id;
  const imported = await admin.request('admin/tickets/import-inbox', { messageId });
  assert.equal(imported.status, 201);
  assert.deepEqual((await admin.request('admin/tickets/import-inbox', { messageId })).data, imported.data);
  assert.equal((await buyer.request('tickets/' + imported.data.id)).data.messages[0].body, 'پیام قدیمی <متن>');
});

test('ticket photos attach atomically, respect separate limits and keep internal photos private', async t => {
  const { env, sqlite } = await fixture(t);
  const admin = browser(env, '192.0.2.201'), buyer = browser(env, '192.0.2.202'), stranger = browser(env, '192.0.2.203');
  assert.equal((await buyer.request('uploads/ticket', testJPEG)).status, 401);
  await admin.request('login', { username: 'owner', password });
  await admin.init();
  await admin.press('admin:root');
  await admin.press('admin:settings');
  assert.ok(admin.buttons().includes('web:uploads'));
  await buyer.request('register', { name: 'Buyer', username: 'buyer', password });
  await stranger.request('register', { name: 'Stranger', username: 'stranger', password });
  const limits = { ticketKiB: 128, receiptKiB: 1024 };
  assert.equal((await buyer.request('admin/uploads', limits)).status, 403);
  assert.equal((await admin.request('admin/uploads', { ...limits, ticketKiB: 5121 })).status, 400);
  assert.deepEqual((await admin.request('admin/uploads', limits)).data, limits);
  assert.deepEqual((await buyer.request('uploads')).data, { ...limits, maxImages: 4, minKiB: 128, maxKiB: 5120 });
  const tooLarge = new Uint8Array(128 * 1024 + 1);
  assert.equal((await buyer.request('uploads/ticket', tooLarge)).status, 413);
  assert.equal((await buyer.request('uploads/ticket', new Uint8Array([1, 2, 3, 4]))).status, 415);
  assert.equal((await buyer.request('uploads/ticket', testJPEG, 'https://other.example')).status, 403);
  const stage = async browser => {
    const result = await browser.request('uploads/ticket', testJPEG);
    assert.equal(result.status, 201);
    return result.data.id;
  };
  const first = await stage(buyer), second = await stage(buyer), other = await stage(stranger);
  const request = { department: 1, subject: 'اختلال اتصال', message: '', priority: 'high' };
  assert.equal((await buyer.request('tickets', { ...request, images: [first, other] })).status, 409);
  assert.equal((await buyer.request('tickets', { ...request, images: [first, first] })).status, 400);
  assert.equal((await buyer.request('tickets', { ...request, images: [first], priority: 'invalid' })).status, 400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM store_tickets').get().n, 0);
  const opened = await buyer.request('tickets', { ...request, images: [second, first] });
  assert.equal(opened.status, 201);
  const base = `tickets/${opened.data.id}`;
  const data = (await buyer.request(base)).data;
  assert.equal(data.ticket.priority, 'high');
  assert.deepEqual(data.messages[0].images, [second, first]);
  assert.match(JSON.stringify((await admin.request('inbox')).data), /staffTicket=/);
  assert.deepEqual((await buyer.request(base + '/images/' + first)).data, testJPEG);
  assert.deepEqual((await admin.request('admin/' + base + '/images/' + second)).data, testJPEG);
  assert.equal((await stranger.request(base + '/images/' + first)).status, 404);
  assert.equal((await buyer.request(base + '/images/' + other)).status, 404);
  assert.equal((await buyer.request(base + '/update', { version: 0, priority: 'urgent' })).status, 200);
  assert.equal((await buyer.request(base + '/update', { version: 0, priority: 'low' })).status, 409);
  assert.equal((await buyer.request(base + '/update', { version: 1, priority: 'low', status: 'resolved' })).status, 403);
  assert.equal((await admin.request('admin/' + base)).data.ticket.priority, 'urgent');
  const internal = await stage(admin);
  assert.equal((await admin.request('admin/' + base + '/reply', { version: 1, message: '', internal: true, images: [internal] })).status, 200);
  assert.equal((await buyer.request(base + '/images/' + internal)).status, 404);
  assert.deepEqual((await admin.request('admin/' + base + '/images/' + internal)).data, testJPEG);
  assert.equal((await buyer.request(base + '/reply', { version: 2, message: '', images: [first] })).status, 409);
  const followUp = await stage(buyer);
  assert.equal((await buyer.request(base + '/reply', { version: 2, message: '', images: [followUp] })).status, 200);
  assert.deepEqual((await buyer.request(base)).data.messages.at(-1).images, [followUp]);
  assert.deepEqual((await buyer.request(base + '/images/' + first)).data, testJPEG);

  const unrelated = await stranger.request('tickets', { department: 1, subject: 'تیکت دیگر', message: '', images: [other] });
  assert.equal(unrelated.status, 201);
  assert.equal((await buyer.request(base + '/delete', { version: 3 })).status, 403);
  assert.equal((await buyer.request('admin/' + base + '/delete', { version: 3 })).status, 403);
  assert.equal((await admin.request('admin/' + base + '/delete', { version: 2 })).status, 409);
  assert.deepEqual((await buyer.request(base + '/images/' + first)).data, testJPEG);
  assert.equal((await admin.request('admin/' + base + '/delete', { version: 3 })).status, 200);
  assert.equal((await buyer.request(base)).status, 404);
  assert.equal((await admin.request('admin/' + base + '/images/' + internal)).status, 404);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM store_ticket_messages WHERE ticket_id=?').get(opened.data.id).n, 0);
  assert.deepEqual(sqlite.prepare('SELECT id FROM store_ticket_images ORDER BY id').all().map(row => row.id), [other]);
  assert.equal((await stranger.request('tickets/' + unrelated.data.id)).status, 200);
});

test('admin branding is quoted safely and published across every store page and icon', async t => {
  const { env, sqlite } = await fixture(t);
  const guest = browser(env, '192.0.2.92');
  const admin = browser(env, '192.0.2.93');
  const name = 'شبکهٔ «نوین» & "همراه"';
  assert.equal((await guest.request('brand')).data.name, 'آسان‌گذر');
  assert.equal((await guest.request('admin/brand', { name })).status, 401);
  assert.equal((await guest.request('register', { name: 'Customer', username: 'buyer', password })).status, 200);
  assert.equal((await guest.request('admin/brand', { name })).status, 403);
  assert.equal((await admin.request('login', { username: 'owner', password })).status, 200);
  await admin.init();
  await admin.press('admin:root');
  await admin.press('admin:settings');
  assert.ok(admin.buttons().includes('web:brand'));
  assert.equal((await admin.request('admin/brand', { name: '<script>x</script>' })).status, 400);
  assert.equal((await admin.request('admin/brand', { name }, 'https://other.example')).status, 403);
  assert.deepEqual((await admin.request('admin/brand', { name })).data, { name });
  assert.deepEqual((await guest.request('brand')).data, { name });
  assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key='website_brand'").get().value, name);

  const pages = loadStorePages(fileURLToPath(new URL('../../asan-gozar_website/', import.meta.url)));
  for (const [path, page] of pages) {
    const response = await webStorePage(new Request(origin + path), page, env);
    assert.equal(response.status, 200, path);
    const markup = await response.text();
    assert.doesNotMatch(markup, /آسان[‌ ]?گذر|>AG</u, path);
    assert.equal(response.headers.get('x-store-template-sha256'), page.templateSha, path);
    if (path === '/favicon.svg') {
      assert.match(markup, />ش<\/text>/u);
      continue;
    }
    if (path === '/app.webmanifest') {
      assert.equal(JSON.parse(markup).name, name);
      assert.equal(JSON.parse(markup).display, 'standalone');
      continue;
    }
    assert.match(markup, /data-store-brand="شبکهٔ «نوین» &amp; &quot;همراه&quot;"/u, path);
    assert.match(markup, /<title>[^<]*شبکهٔ «نوین» &amp; &quot;همراه&quot;/u, path);
    assert.match(markup, /class="logo-mark" aria-hidden="true">ش<\/span>/u, path);
    const structured = markup.match(/<script type="application\/ld\+json">(.*?)<\/script>/);
    if (structured) assert.equal(JSON.parse(structured[1]).name, name, path);
  }

  const notice = { active: true, kind: 'notice', title: 'خبر {brand}', message: 'اطلاعیه آسان گذر' };
  assert.equal((await admin.request('admin/notice', notice)).status, 200);
  assert.deepEqual((await guest.request('notice')).data.notice, { ...notice, title: 'خبر ' + name, message: 'اطلاعیه ' + name });
  sqlite.exec(`INSERT INTO store_categories(id,name,group_ids) VALUES(1,'اشتراک {brand}','[1]');
    INSERT INTO plans VALUES('t1',10,70000,1);
    INSERT INTO store_plan_specs VALUES('t1',1,30);`);
  assert.equal((await guest.request('catalog')).data.plans[0].category, 'اشتراک ' + name);
  assert.equal((await guest.request('featured')).data.plans[0].category, 'اشتراک ' + name);
});

test('the home page shows at most three active categories and their cheapest plans', async t => {
  const { sqlite, env } = await fixture(t);
  sqlite.exec(`INSERT INTO store_categories(id,name,group_ids,active) VALUES
    (1,'Personal','[1]',1),(2,'Hidden','[2]',0),(3,'Pro','[3]',1),(4,'Fourth','[4]',1),(5,'Fifth','[5]',1);
    INSERT INTO plans(key,gb,price,sort) VALUES
    ('expensive',50,90000,1),('cheap',10,30000,2),('hidden',10,1,3),('third',1,40000,4),('fourth',1,20000,5),('fifth',1,10000,6);
    INSERT INTO store_plan_specs(plan_key,category_id,days) VALUES
    ('expensive',1,60),('cheap',1,30),('hidden',2,30),('third',3,30),('fourth',4,30),('fifth',5,30);`);
  const guest = browser(env, '192.0.2.89');
  const { status, data } = await guest.request('featured');
  assert.equal(status, 200);
  assert.deepEqual(data.plans.map(({ categoryId, price }) => [categoryId, price]), [[1, 30000], [3, 40000], [4, 20000]]);
});

test('the optional public notice can only be edited by a store admin', async t => {
  const { env } = await fixture(t);
  const guest = browser(env, '192.0.2.90');
  const admin = browser(env, '192.0.2.91');
  const notice = { active: true, kind: 'outage', title: 'اختلال موقت', message: 'در حال بررسی اتصال از سمت شبکه هستیم.' };
  assert.deepEqual((await guest.request('notice')).data, { notice: null });
  assert.equal((await guest.request('admin/notice', notice)).status, 401);
  assert.equal((await guest.request('register', { name: 'Customer', username: 'buyer', password })).status, 200);
  assert.equal((await guest.request('admin/notice')).status, 403);
  assert.equal((await guest.request('admin/notice', notice)).status, 403);
  assert.equal((await admin.request('login', { username: 'owner', password })).status, 200);
  await admin.init();
  await admin.press('admin:root');
  assert.ok(admin.buttons().includes('web:notice'));
  assert.equal((await admin.request('admin/notice', { ...notice, title: '' })).status, 400);
  assert.equal((await admin.request('admin/notice', notice, 'https://other.example')).status, 403);
  assert.deepEqual((await admin.request('admin/notice', { ...notice, title: '⚠️ ' + notice.title })).data, { notice });
  assert.deepEqual((await guest.request('notice')).data, { notice });
  assert.equal((await admin.request('admin/notice', { ...notice, active: false })).status, 200);
  assert.deepEqual((await guest.request('notice')).data, { notice: null });
  assert.deepEqual((await admin.request('admin/notice')).data, { notice: { ...notice, active: false } });
});

test('public catalogue reflects the price set in the admin panel', async t => {
  const { sqlite, env } = await fixture(t);
  sqlite.exec(`INSERT INTO store_categories(id,name,group_ids) VALUES(1,'Standard','[1]');
    INSERT INTO store_categories(id,name,group_ids,active) VALUES(2,'Hidden','[2]',0);
    INSERT INTO plans(key,gb,price,sort) VALUES('public10',10,70000,1),('private20',20,80000,2);
    INSERT INTO store_plan_specs(plan_key,category_id,days) VALUES('public10',1,30),('private20',2,60);`);
  const guest = browser(env, '192.0.2.80');
  const admin = browser(env, '192.0.2.81');
  const catalogue = await guest.request('catalog');
  assert.equal(catalogue.status, 200);
  assert.deepEqual(catalogue.data.plans, [{ categoryId: 1, category: 'Standard', gb: 10, price: 70000, days: 30 }]);
  assert.equal((await admin.request('login', { username: 'owner', password })).status, 200);
  await admin.init();
  await admin.press('admin:root');
  await admin.press('admin:plans');
  await admin.press('admin:plan:public10');
  await admin.press('admin:price:public10');
  await admin.act({ kind: 'text', text: '92000' });
  assert.deepEqual((await guest.request('catalog')).data.plans, [{ ...catalogue.data.plans[0], price: 92000 }]);
});

test('password rotation verifies the administrator and invalidates the existing session', async t => {
  const { sqlite, env, owner } = await fixture(t);
  const guest = browser(env, '192.0.2.82');
  const admin = browser(env, '192.0.2.83');
  const replacement = 'another-unique-long-test-password';
  const update = { currentPassword: password, newPassword: replacement };
  assert.equal((await guest.request('password', update)).status, 401);
  assert.equal((await guest.request('register', { name: 'Customer', username: 'buyer', password })).status, 200);
  assert.equal((await guest.request('admin/password', update)).status, 403);
  assert.equal((await admin.request('login', { username: 'owner', password })).status, 200);
  assert.equal((await admin.request('state')).data.admin, true);
  assert.equal((await admin.request('password', update, 'https://other.example')).status, 403);
  assert.equal((await admin.request('password', { ...update, currentPassword: 'wrong-but-long-password' })).status, 403);
  assert.equal((await admin.request('password', { ...update, newPassword: 'short07' })).status, 400);
  const expire = sqlite.prepare('UPDATE web_shop_sessions SET busy_until=? WHERE user_id=?');
  expire.run(Date.now() + 60_000, owner.id);
  assert.equal((await admin.request('password', update)).status, 409);
  expire.run(0, owner.id);
  assert.deepEqual(await admin.request('password', update), { status: 200, data: { signedIn: false } });
  assert.equal((await admin.request('state')).data.signedIn, false);
  assert.ok(sqlite.prepare('SELECT expires_at FROM web_shop_sessions WHERE user_id=?').get(owner.id).expires_at <= Date.now());
  assert.equal((await admin.request('login', { username: 'owner', password })).status, 401);
  assert.equal((await admin.request('login', { username: 'owner', password: replacement })).status, 200);
  assert.equal((await admin.request('state')).data.admin, true);
});

test('customers change their own passwords and administrators reset only customer passwords', async t => {
  const { sqlite, env, owner } = await fixture(t);
  const customer = browser(env, '192.0.2.84');
  const admin = browser(env, '192.0.2.85');
  const changed = 'changed8';
  const reset = 'reset008';
  assert.equal((await customer.request('register', { name: 'Customer', username: 'buyer', password })).status, 200);
  const { id: userId } = sqlite.prepare("SELECT id FROM store_accounts WHERE username='buyer'").get();
  assert.equal((await admin.request('login', { username: 'owner', password })).status, 200);
  await admin.init();
  await admin.press('admin:root');
  await admin.press('admin:users:0');
  await admin.press(`admin:user:${userId}`);
  assert.ok(admin.buttons().includes(`web:reset_password:${userId}`));
  assert.equal((await customer.request('password', { currentPassword: password, newPassword: changed })).status, 200);
  assert.equal((await customer.request('login', { username: 'buyer', password })).status, 401);
  assert.equal((await customer.request('login', { username: 'buyer', password: changed })).status, 200);
  assert.equal((await admin.request('admin/password', { userId: owner.id, currentPassword: password, newPassword: reset })).status, 403);
  assert.equal((await admin.request('admin/password', { userId, currentPassword: 'incorrect-long-test-password', newPassword: reset })).status, 403);
  assert.equal((await admin.request('admin/password', { userId, currentPassword: password, newPassword: reset })).status, 200);
  assert.deepEqual((await customer.request('session')).data, { signedIn: false });
  assert.equal((await customer.request('login', { username: 'buyer', password: changed })).status, 401);
  assert.equal((await customer.request('login', { username: 'buyer', password: reset })).status, 200);
  assert.equal((await admin.request('session')).data.signedIn, true);
});

test('owner and customers edit their own display names and can use eight-character passwords', async t => {
  const { env, sqlite, owner } = await fixture(t);
  const customer = browser(env, '192.0.2.197');
  const admin = browser(env, '192.0.2.198');
  assert.equal((await customer.request('profile')).status, 401);
  const signup = { username: 'buyer', name: 'Customer', password: 'seven77' };
  assert.equal((await customer.request('register', signup)).status, 400);
  const oldPassword = '🔒'.repeat(7);
  assert.equal((await customer.request('register', { ...signup, password: oldPassword })).status, 400);
  assert.equal((await customer.request('register', { ...signup, password: 'رمزعبور۸' })).status, 200);
  assert.equal((await admin.request('login', { username: 'owner', password })).status, 200);
  await admin.init();
  await admin.press('admin:root');
  await admin.press('admin:settings');
  assert.ok(admin.buttons().includes('web:profile'));
  await customer.init();
  assert.equal((await customer.request('profile', { name: 'Line\nBreak' })).status, 400);
  assert.equal((await customer.request('profile', { name: 'نام تازه' }, 'https://other.example')).status, 403);
  assert.deepEqual((await customer.request('profile', { name: '  نام تازه  ', id: owner.id, username: 'owner' })).data, { name: 'نام تازه' });
  assert.deepEqual((await customer.request('profile')).data, { username: 'buyer', name: 'نام تازه' });
  assert.deepEqual((await admin.request('profile')).data, { username: 'owner', name: 'Shop Owner' });
  assert.deepEqual((await admin.request('profile', { name: 'مدیر فروشگاه' })).data, { name: 'مدیر فروشگاه' });
  assert.deepEqual((await admin.request('profile')).data, { username: 'owner', name: 'مدیر فروشگاه' });
  assert.equal(sqlite.prepare('SELECT first_name FROM store_profiles WHERE user_id=?').get(owner.id).first_name, 'مدیر فروشگاه');
  assert.equal((await browser(env, '192.0.2.199').request('login', { username: 'buyer', password: 'رمزعبور۸' })).status, 200);
  const legacy = await hashPassword(oldPassword);
  sqlite.prepare('UPDATE store_accounts SET salt=?,password_hash=? WHERE id=?').run(legacy.salt, legacy.password_hash, owner.id);
  assert.equal((await admin.request('login', { username: 'owner', password: oldPassword })).status, 200);
});

test('standalone signup, local admin role, session rotation and private inbox', async t => {
  const { sqlite, env } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw Error('No outbound fetch expected'); });
  const guest = browser(env,'192.0.2.10'), admin = browser(env,'192.0.2.11');
  assert.equal((await guest.request('action', { kind:'home', revision:0 })).status, 401);
  assert.equal((await guest.request('register', {}, 'https://untrusted.example')).status, 403);
  assert.equal((await guest.request('register', {name:'Customer',username:'buyer',password,owner:true})).status, 200);
  await guest.init();
  assert.ok(guest.buttons().includes('buy'));
  assert.deepEqual((await guest.request('session')).data, { signedIn: true });
  assert.ok(!guest.buttons().includes('admin:root'));
  assert.equal(sqlite.prepare("SELECT owner FROM store_accounts WHERE username='buyer'").get().owner, 0);
  assert.equal((await guest.request('action',{kind:'button',action:'admin:root',revision:guest.state.revision})).status, 400);
  assert.equal((await guest.request('receipt?kind=order&id=1')).status, 403);
  assert.ok(guest.buttons().includes('web:tickets'));
  const customerId = sqlite.prepare("SELECT id FROM store_accounts WHERE username='buyer'").get().id;
  assert.equal((await admin.request('login',{username:'owner',password:'incorrect-strong-password'})).status, 401);
  assert.equal((await admin.request('login',{username:'owner',password})).status, 200);
  await admin.init();
  await admin.press('admin:root');
  assert.ok(admin.buttons().includes('admin:plans'));
  assert.ok(admin.buttons().includes('admin:categories'));
  assert.ok(!admin.buttons().some(action=>action?.includes('broadcast')));
  assert.ok(admin.buttons().includes('web:ticket-admin'));

  await admin.press('admin:users:0');
  await admin.press('admin:user:'+customerId);
  await admin.press('admin:message_user:'+customerId);
  await admin.act({kind:'text',text:'پاسخ پشتیبانی'});
  await admin.press(admin.buttons().find(action=>action?.startsWith('admin:message_send:')));
  await processMessageJobs(env,(id,text)=>deliverToInbox(env,'sendMessage',{chat_id:id,text}));
  assert.match(JSON.stringify((await guest.request('inbox')).data), /پاسخ پشتیبانی/);
  assert.doesNotMatch(JSON.stringify((await admin.request('inbox')).data), /پاسخ پشتیبانی/);

  const replacement = browser(env,'192.0.2.12');
  assert.equal((await replacement.request('login',{username:'buyer',password})).status,200);
  assert.deepEqual((await guest.request('session')).data, { signedIn: false });
  assert.equal((await guest.request('inbox')).status,401);
  await replacement.init();
  sqlite.prepare('UPDATE store_profiles SET blocked=1 WHERE user_id=?').run(customerId);
  assert.equal((await replacement.request('inbox')).status,401);
});

test('trial retries reuse the same credentials and admins can recover held older and partially created trials', async t => {
  const { sqlite, env } = await fixture(t);
  sqlite.exec(`UPDATE settings SET value='1' WHERE key='test_enabled';
    INSERT INTO settings(key,value) VALUES('test_category_id','1'),('sub_base_url','https://sub.example/sub/');
    INSERT INTO store_categories(id,name,group_ids) VALUES(1,'Trial group','1');`);
  const accounts = new Map();
  const attempts = [];
  let phase = 'retry';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url);
    assert.equal(target.hostname, 'panel.example');
    const path = target.pathname;
    if (path === '/login') return Response.json({ success: true }, { headers: { 'set-cookie': 'vpn-ui=test' } });
    if (path.endsWith('/groups')) return Response.json({ success: true, obj: [{ id: 1, inboundIds: [3, 4] }] });
    if (path.endsWith('/assignable')) return Response.json({ success: true, obj: [{ inboundId: 3, protocol: 'vless' }, { inboundId: 4, protocol: 'vless' }] });
    if (path.endsWith('/list')) {
      const account = accounts.get(target.searchParams.get('search'));
      return Response.json({ success: true, obj: { rows: account ? [account] : [], total: account ? 1 : 0 } });
    }
    if (path.endsWith('/addClient')) {
      const form = new URLSearchParams(options.body);
      const client = JSON.parse(form.get('settings')).clients[0];
      attempts.push({ form: options.body, ...client });
      if (phase === 'retry' && attempts.length === 1) return Response.json({ success: false, msg: 'Something went wrong (database is locked)' });
      accounts.set(client.email, { ...client, memberships: (phase === 'retry' ? [3, 4] : [3]).map(inboundId => ({ inboundId })) });
      if (phase === 'partial') return Response.json({ success: false, msg: 'Something went wrong (database is locked)' });
      return Response.json({ success: true });
    }
    throw Error(`Unexpected panel call: ${path}`);
  });
  const create = async (handle, ip) => {
    const customer = browser(env, ip);
    assert.equal((await customer.request('register', { username: handle, name: 'Trial customer', password })).status, 200);
    await customer.init();
    await customer.press('test_service');
    await customer.press('testcat:1:0');
    await customer.press('testname:random');
    return sqlite.prepare('SELECT id FROM store_accounts WHERE username=?').get(handle).id;
  };
  const first = await create('trial_retry', '192.0.2.152');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].form, attempts[1].form);
  assert.equal(sqlite.prepare('SELECT sub_id FROM services WHERE user_id=?').get(first).sub_id, attempts[0].subId);

  phase = 'partial';
  const second = await create('trial_partial', '192.0.2.153');
  assert.equal(attempts.length, 3);
  assert.match(sqlite.prepare('SELECT created_at FROM test_claims WHERE user_id=?').get(second).created_at, /^review\|/);
  assert.equal(sqlite.prepare('SELECT 1 FROM services WHERE user_id=?').get(second), undefined);

  const admin = browser(env, '192.0.2.154');
  assert.equal((await admin.request('login', { username: 'owner', password })).status, 200);
  await admin.init();
  const review = async id => {
    await admin.act({ kind: 'home' });
    await admin.press('admin:root');
    await admin.press('admin:users:0');
    await admin.press(`admin:user:${id}`);
    await admin.press(`admin:trial:${id}`);
  };
  await review(second);
  assert.ok(!admin.buttons().some(action => /^admin:trial_(save|release):/.test(action)));
  accounts.get(attempts[2].email).memberships.push({ inboundId: 4 });
  await admin.act({ kind: 'home' });
  await admin.press('admin:root');
  await admin.press('admin:trials:0');
  await admin.press(`admin:trial:${second}`);
  await admin.press(admin.buttons().find(action => action.startsWith('admin:trial_save:')));
  const saved = sqlite.prepare('SELECT * FROM services WHERE user_id=?').all(second);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].sub_id, attempts[2].subId);
  assert.match(sqlite.prepare('SELECT created_at FROM test_claims WHERE user_id=?').get(second).created_at, /^done\|/);
  assert.equal(attempts.length, 3);

  const unseen = browser(env, '192.0.2.155');
  await unseen.request('register', { username: 'trial_missing', name: 'Legacy', password });
  const legacy = sqlite.prepare("SELECT id FROM store_accounts WHERE username='trial_missing'").get().id;
  const key = `test:${legacy}:0123456789abcdef`;
  sqlite.prepare('INSERT INTO test_claims VALUES(?,?)').run(legacy, 'review|2026-11-25 17:00');
  sqlite.prepare('INSERT INTO provision_attempts VALUES(?,?,?,?,?)').run(key, 'OldMissing', 'old-missing-sub', 3, '2026-11-25 17:00');
  sqlite.prepare('INSERT INTO settings VALUES(?,?)').run(`attempt_panel:${key}`, await panelAccountKey(env.PANEL_URL, env.PANEL_USER));
  await review(legacy);
  await admin.press(`admin:trial_release:${legacy}:0123456789abcdef`);
  assert.equal(sqlite.prepare('SELECT 1 FROM test_claims WHERE user_id=?').get(legacy), undefined);
});

test('card purchase and wallet top-up are reviewed in the web admin without an external messenger', async t => {
  const { sqlite, env } = await fixture(t);
  sqlite.exec(`INSERT INTO plans VALUES('p10',10,70000,1);
    INSERT INTO store_categories(id,name,group_ids) VALUES(1,'Test','1');
    INSERT INTO store_plan_specs VALUES('p10',1,30);
    INSERT INTO settings(key,value) VALUES('sub_base_url','https://sub.example/sub/');`);
  let provisioned = 0;
  const unexpected = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = new URL(url);
    if (target.hostname !== 'panel.example') {
      unexpected.push(target.hostname);
      throw Error('Unexpected destination');
    }
    const p = target.pathname;
    if (p.endsWith('/login')) return Response.json({success:true},{headers:{'set-cookie':'vpn-ui=test'}});
    if (p.endsWith('/clients/groups')) return Response.json({success:true,obj:[{id:1,inboundIds:[3]}]});
    if (p.endsWith('/clients/assignable')) return Response.json({success:true,obj:[{inboundId:3,protocol:'vless'}]});
    if (p.endsWith('/clients/list')) return Response.json({success:true,obj:{rows:[],total:0}});
    if (p.endsWith('/addClient')) { provisioned++; return Response.json({success:true}); }
    throw Error('Unexpected panel route');
  });

  const buyer = browser(env,'192.0.2.20'), admin = browser(env,'192.0.2.21');
  assert.equal((await buyer.request('register',{name:'Buyer',username:'buyer',password})).status,200);
  assert.equal((await admin.request('login',{username:'owner',password})).status,200);
  assert.equal((await admin.request('admin/uploads', { receiptKiB: 128, ticketKiB: 5120 })).status, 200);
  await buyer.init();
  await admin.init();
  for (const action of ['buy','buycat:1:0','plan_p10','buyname:custom']) await buyer.press(action);
  await buyer.act({kind:'text',text:'BrowserClient'});
  const order = sqlite.prepare('SELECT id,final_price,status FROM orders').get();
  assert.equal(order.final_price,70000);
  await buyer.press('card:pay:'+order.id);
  assert.equal(buyer.state.input, 'image');
  assert.equal(buyer.state.receiptKiB, 128);
  const oldRevision = buyer.state.revision;
  const oversized = Buffer.alloc(128 * 1024 + 1024).toString('base64');
  assert.equal((await buyer.request('action', { kind: 'image', image: oversized, revision: oldRevision })).status, 413);
  await buyer.act({kind:'image', image});
  assert.equal(sqlite.prepare('SELECT status FROM orders').get().status,'pending');
  assert.equal((await buyer.request('action',{kind:'image',image,revision:oldRevision})).status,409);
  assert.equal((await buyer.request('action',{kind:'receipt',action:'web:receipt:order:'+order.id,revision:buyer.state.revision})).status,400);
  assert.equal((await admin.act({kind:'receipt',action:'web:receipt:order:'+order.id})).messages[0].photo,
    '/shop/api/receipt?kind=order&id='+order.id);

  for (const action of ['web:orders','web:receipt:order:'+order.id]) await admin.press(action);
  assert.equal((await buyer.request('receipt?kind=order&id='+order.id)).status,403);
  assert.deepEqual((await admin.request('receipt?kind=order&id='+order.id)).data,testJPEG);
  const approveRev = admin.state.revision;
  await admin.press('approve_'+order.id);
  assert.equal((await admin.request('action',{kind:'button',action:'approve_'+order.id,revision:approveRev})).status,409);
  assert.equal(sqlite.prepare('SELECT status FROM orders').get().status,'approved');
  assert.equal(provisioned,1);
  assert.match(JSON.stringify((await buyer.request('inbox')).data),/ساخته شد/);

  await buyer.act({kind:'home'});
  await buyer.press('wallet:home');
  await buyer.press('wallet:topup');
  await buyer.act({kind:'text',text:'150000'});
  await buyer.act({kind:'image',image});
  const topup = sqlite.prepare('SELECT id,status FROM wallet_topups').get();
  assert.equal(topup.status,'pending');
  await admin.act({kind:'home'});
  for (const action of ['admin:root','web:orders','web:receipt:topup:'+topup.id,'topup:approve:'+topup.id]) await admin.press(action);
  assert.equal(sqlite.prepare('SELECT SUM(delta) n FROM wallet_entries').get().n,150000);
  await buyer.act({kind:'home'});
  for (const action of ['buy','buycat:1:0','plan_p10','buyname:custom']) await buyer.press(action);
  await buyer.act({kind:'text',text:'WalletClient'});
  const walletOrder = sqlite.prepare("SELECT id FROM orders WHERE service_name='WalletClient'").get();
  await buyer.press('wallet:pay:'+walletOrder.id);
  assert.equal(sqlite.prepare('SELECT status FROM orders WHERE id=?').get(walletOrder.id).status,'approved');
  assert.equal(sqlite.prepare('SELECT SUM(delta) n FROM wallet_entries').get().n,80000);
  assert.equal(provisioned,2);
  assert.deepEqual(unexpected,[]);
});

test('HTTP standalone adapter accepts shop API only and binds to loopback', async t => {
  const { env } = await fixture(t);
  const http = await listenForWebShop((request,base)=>webShopRequest(request,base,handleUpdate), env, 0);
  t.after(() => new Promise(resolve=>http.close(resolve)));
  assert.equal(http.address().address,'127.0.0.1');
  const url = 'http://127.0.0.1:'+http.address().port;
  assert.equal((await fetch(url+'/webhook')).status,404);
  assert.deepEqual(await (await fetch(url+'/shop/api/state')).json(),{signedIn:false});
});

test('panel credentials require HTTPS outside loopback', () => {
  assert.throws(() => panelURL('http://panel.example/'), /HTTPS/);
  assert.throws(() => panelURL('https://user:pass@panel.example/'), /HTTPS/);
  assert.equal(panelURL('http://127.0.0.1:3456/base/'), 'http://127.0.0.1:3456/base');
  assert.equal(panelURL('https://panel.example/path/'), 'https://panel.example/path');
});

const statuses = { open: 'باز', in_progress: 'در حال بررسی', waiting_customer: 'منتظر پاسخ مشتری', resolved: 'حل‌شده', closed: 'بسته' };
const priorities = { low: 'کم', normal: 'عادی', high: 'زیاد', urgent: 'فوری' };
const finished = new Set(['resolved', 'closed']);
const activeStaff = '(a.owner=1 OR EXISTS(SELECT 1 FROM admins WHERE user_id=a.id))';
const positive = value => Number.isSafeInteger(value) && value > 0;
const PAGE_SIZE = 20;
const THREAD_SIZE = 40;

const baseTicket = `SELECT t.id,t.customer_id,t.department_id,t.assignee_id,t.subject,t.status,t.priority,t.created_at,t.updated_at,t.version,
  d.name AS department,a.username AS customer,
  handler.display_name AS assignee FROM store_tickets t
  JOIN ticket_departments d ON d.id=t.department_id JOIN store_accounts a ON a.id=t.customer_id
  LEFT JOIN store_accounts handler ON handler.id=t.assignee_id`;
const first = (db, query, ...args) => db.prepare(query).bind(...args).first();
const all = async (db, query, ...args) => (await db.prepare(query).bind(...args).all()).results;
const run = (db, query, ...args) => db.prepare(query).bind(...args).run();

function plain(value, size, multiline = false) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\r\n?/g, '\n');
  const invalid = multiline ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/;
  return text && text.length <= size && !invalid.test(text) ? text : null;
}

const error = (json, text, status = 400) => json({ error: text }, status);
const notFound = json => error(json, 'تیکت پیدا نشد.', 404);
const changed = json => error(json, 'تیکت تغییر کرده است. آن را دوباره باز کنید.', 409);
const noDepartment = json => error(json, 'دپارتمان انتخاب‌شده در دسترس نیست.', 409);

async function listTickets(db, url, uid, staff, json) {
  const query = url.searchParams;
  const args = [];
  const where = [];
  if (!staff) { where.push('t.customer_id=?'); args.push(uid); }
  const status = query.get('status') || '';
  if (status) {
    if (status === 'active') where.push("t.status NOT IN ('resolved','closed')");
    else {
      if (!Object.hasOwn(statuses, status)) return error(json, 'وضعیت نامعتبر است.');
      where.push('t.status=?'); args.push(status);
    }
  }
  if (staff) {
    const assignment = query.get('assignment') || '';
    if (assignment === 'mine') { where.push('t.assignee_id=?'); args.push(uid); }
    else if (assignment === 'unassigned') where.push('t.assignee_id IS NULL');
    else if (assignment) return error(json, 'ارجاع نامعتبر است.');
    const department = Number(query.get('department') || 0);
    if (department) {
      if (!positive(department)) return error(json, 'دپارتمان نامعتبر است.');
      where.push('t.department_id=?'); args.push(department);
    }
    const search = query.get('q')?.trim() || '';
    if (search) {
      if (!plain(search, 120)) return error(json, 'عبارت جستجو نامعتبر است.');
      where.push('(instr(lower(t.subject),lower(?))>0 OR instr(lower(a.username),lower(?))>0 OR CAST(t.id AS TEXT)=?)');
      args.push(search, search, search.replace(/^#/, ''));
    }
  }
  const before = query.get('before');
  if (before) {
    const cursor = /^(\d+):(\d+)$/.exec(before);
    if (!cursor || !positive(Number(cursor[1])) || !positive(Number(cursor[2]))) return error(json, 'صفحه نامعتبر است.');
    where.push('(t.updated_at,t.id)<(?,?)');
    args.push(Number(cursor[1]), Number(cursor[2]));
  }
  const rows = await all(db, `${baseTicket} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.updated_at DESC,t.id DESC LIMIT ?`, ...args, PAGE_SIZE + 1);
  const last = rows[PAGE_SIZE - 1];
  return json({ tickets: rows.slice(0, PAGE_SIZE), next: rows.length > PAGE_SIZE ? `${last.updated_at}:${last.id}` : null });
}

async function openTicket(env, uid, body, json) {
  const subject = plain(body?.subject, 120), message = plain(body?.message, 4000, true);
  if (!subject || !message || !positive(body?.department)) return error(json, 'موضوع، پیام و دپارتمان را بررسی کنید.');
  return createTicket(env.DB, uid, { department: body.department, subject, message, origin: env.WEB_SHOP_ORIGIN }, json);
}

async function createTicket(db, uid, { department, subject, message, legacy = null, origin }, json) {
  const now = Date.now();
  const statements = [
    db.prepare(`INSERT INTO store_tickets(customer_id,department_id,subject,created_at,updated_at,legacy_key)
      SELECT ?,id,?,?,?,? FROM ticket_departments WHERE id=? AND active=1 ON CONFLICT(legacy_key) DO NOTHING`)
      .bind(uid, subject, legacy?.time ?? now, now, legacy?.key ?? null, department),
    db.prepare(`INSERT INTO store_ticket_messages(ticket_id,actor_id,kind,body,created_at)
      SELECT last_insert_rowid(),?,'customer',?,? WHERE changes()=1`).bind(uid, message, legacy?.time ?? now),
  ];
  if (origin) {
    statements.push(db.prepare(`WITH recipients AS MATERIALIZED (
      SELECT a.id,?||m.ticket_id||?,? FROM store_accounts a JOIN store_ticket_messages m ON m.id=last_insert_rowid()
      WHERE a.owner=1 AND a.id<>? AND changes()=1)
      INSERT INTO store_inbox(user_id,html,created_at) SELECT * FROM recipients`)
      .bind(`تیکت پشتیبانی جدید ثبت شد. <a href="${origin}/account.html?staffTicket=`, '#tickets">مشاهدهٔ تیکت</a>', now, uid));
  }
  const [created] = await db.batch(statements);
  if (created.meta.changes) return json({ id: created.meta.last_row_id }, 201);
  const existing = legacy && await first(db, 'SELECT id FROM store_tickets WHERE legacy_key=?', legacy.key);
  return existing ? json({ id: existing.id }) : noDepartment(json);
}

async function importInbox(db, uid, body, json) {
  if (!positive(body?.messageId)) return error(json, 'پیام معتبر نیست.');
  const item = await first(db, 'SELECT id,html,created_at FROM store_inbox WHERE user_id=? AND id=?', uid, body.messageId);
  const parsed = item && /^درخواست پشتیبانی از کاربر (\d+) \(@[^\n]*\):\n([\s\S]+)$/u.exec(item.html);
  if (!parsed || !positive(Number(parsed[1]))) return error(json, 'پیام پشتیبانی قدیمی پیدا نشد.', 404);
  const customer = Number(parsed[1]);
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  const message = plain(parsed[2].replace(/&(amp|lt|gt|quot|#39);/g, (_, symbol) => entities[symbol]), 4000, true);
  if (!message || !(await first(db, 'SELECT 1 FROM store_accounts WHERE id=?', customer))) {
    return error(json, 'متن پیام یا حساب فرستنده در دسترس نیست.', 409);
  }
  const key = `${uid}:${item.id}:${item.created_at}`;
  const existing = await first(db, 'SELECT id FROM store_tickets WHERE legacy_key=?', key);
  if (existing) return json({ id: existing.id });
  const department = await first(db, 'SELECT id FROM ticket_departments WHERE active=1 ORDER BY id LIMIT 1');
  if (!department) return noDepartment(json);
  return createTicket(db, customer, { department: department.id, subject: 'درخواست پشتیبانی قدیمی', message,
    legacy: { key, time: item.created_at } }, json);
}

async function thread(db, ticket, url, staff, json) {
  const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
  if (!positive(before)) return error(json, 'صفحهٔ پیام‌ها نامعتبر است.');
  const messages = await all(db, `SELECT m.id,m.kind,m.body,m.created_at,a.display_name AS author
    FROM store_ticket_messages m JOIN store_accounts a ON a.id=m.actor_id WHERE m.ticket_id=? AND m.id<?
    ${staff ? '' : "AND m.kind IN ('customer','staff')"} ORDER BY m.id DESC LIMIT ?`, ticket.id, before, THREAD_SIZE + 1);
  return json({
    ticket, messages: messages.slice(0, THREAD_SIZE).reverse(),
    next: messages.length > THREAD_SIZE ? messages[THREAD_SIZE - 1].id : null,
  });
}

async function replyToTicket(env, uid, ticket, staff, body, json) {
  const message = plain(body?.message, 4000, true);
  const note = staff && body?.internal === true;
  if (!message || (!staff && body?.internal)) return error(json, 'متن پیام معتبر نیست.');
  if (body.version !== ticket.version) return changed(json);
  const db = env.DB, now = Date.now();
  const kind = note ? 'note' : staff ? 'staff' : 'customer';
  const next = note ? ticket.status : staff ? 'waiting_customer' : 'open';
  const statements = [
    db.prepare(`INSERT INTO store_ticket_messages(ticket_id,actor_id,kind,body,created_at)
      SELECT id,?,?,?,? FROM store_tickets WHERE id=? AND version=? AND (? OR status NOT IN ('resolved','closed'))`)
      .bind(uid, kind, message, now, ticket.id, ticket.version, Number(note)),
    db.prepare('UPDATE store_tickets SET status=?,updated_at=?,version=version+1 WHERE id=? AND changes()=1')
      .bind(next, now, ticket.id),
  ];
  if (kind === 'staff') {
    const href = `${env.WEB_SHOP_ORIGIN}/account.html?ticket=${ticket.id}#tickets`;
    const notice = `پشتیبانی به تیکت شماره ${ticket.id} پاسخ داد. <a href="${href}">مشاهدهٔ تیکت</a>`;
    statements.push(db.prepare('INSERT INTO store_inbox(user_id,html,created_at) SELECT ?,?,? WHERE changes()=1')
      .bind(ticket.customer_id, notice, now));
  }
  if (kind === 'customer') {
    const href = `${env.WEB_SHOP_ORIGIN}/account.html?staffTicket=${ticket.id}#tickets`;
    const notice = `مشتری به تیکت شماره ${ticket.id} پاسخ داد. <a href="${href}">مشاهدهٔ تیکت</a>`;
    statements.push(db.prepare(`INSERT INTO store_inbox(user_id,html,created_at)
      SELECT a.id,?,? FROM store_accounts a WHERE a.id<>? AND changes()=1
      AND ((a.id=? AND ${activeStaff}) OR (a.owner=1 AND NOT EXISTS(
        SELECT 1 FROM store_accounts a WHERE a.id=? AND ${activeStaff})))`)
      .bind(notice, now, uid, ticket.assignee_id, ticket.assignee_id));
  }
  const [saved] = await db.batch(statements);
  return saved.meta.changes ? json({ ok: true }) : changed(json);
}

async function updateTicket(db, uid, ticket, staff, body, json) {
  if (body?.version !== ticket.version) return changed(json);
  const status = body.status;
  if (!Object.hasOwn(statuses, status)) return error(json, 'وضعیت نامعتبر است.');
  let department = ticket.department_id, priority = ticket.priority, assignee = ticket.assignee_id;
  if (staff) {
    department = body.department; priority = body.priority; assignee = body.assignee;
    if (!positive(department) || !Object.hasOwn(priorities, priority) || (assignee !== null && !positive(assignee))) {
      return error(json, 'وضعیت، دپارتمان، اولویت یا مسئول رسیدگی معتبر نیست.');
    }
  } else if (!(status === 'closed' || (status === 'open' && finished.has(ticket.status)))) {
    return error(json, 'این تغییر وضعیت برای کاربر مجاز نیست.', 403);
  }
  const details = [];
  if (status !== ticket.status) details.push('وضعیت: ' + statuses[status]);
  if (priority !== ticket.priority) details.push('اولویت: ' + priorities[priority]);
  if (department !== ticket.department_id) {
    const target = await first(db, 'SELECT name FROM ticket_departments WHERE id=? AND active=1', department);
    if (!target) return noDepartment(json);
    details.push('دپارتمان: ' + target.name);
  }
  if (assignee !== ticket.assignee_id) {
    const operator = assignee && await first(db, `SELECT display_name FROM store_accounts a WHERE id=? AND ${activeStaff}`, assignee);
    if (assignee && !operator) return error(json, 'مسئول انتخاب‌شده در دسترس نیست.', 409);
    details.push('مسئول: ' + (operator?.display_name || 'بدون ارجاع'));
  }
  if (!details.length) return json({ ok: true });
  const now = Date.now();
  const [saved] = await db.batch([
    db.prepare(`UPDATE store_tickets SET status=?,priority=?,department_id=?,assignee_id=?,updated_at=?,version=version+1
      WHERE id=? AND version=?
      AND (department_id=? OR EXISTS(SELECT 1 FROM ticket_departments WHERE id=? AND active=1))
      AND (assignee_id IS ? OR ? IS NULL OR EXISTS(SELECT 1 FROM store_accounts a WHERE id=? AND ${activeStaff}))`)
      .bind(status, priority, department, assignee, now, ticket.id, ticket.version, department, department, assignee, assignee, assignee),
    db.prepare(`INSERT INTO store_ticket_messages(ticket_id,actor_id,kind,body,created_at)
      SELECT ?,?,'event',?,? WHERE changes()=1`).bind(ticket.id, uid, details.join(' · '), now),
  ]);
  return saved.meta.changes ? json({ ok: true }) : changed(json);
}

async function departments(db, staff, body, json) {
  if (!body) {
    const rows = await all(db, `SELECT id,name,description,active FROM ticket_departments ${staff ? '' : 'WHERE active=1'}
      ORDER BY active DESC,id`);
    const staffList = staff ? await all(db, `SELECT a.id,a.display_name AS name,a.username FROM store_accounts a
      WHERE ${activeStaff} ORDER BY a.display_name,a.id`) : [];
    return json({ departments: rows, staff: staffList });
  }
  const name = plain(body.name, 60), description = plain(body.description, 240, true) || '';
  if (!name || typeof body.active !== 'boolean' || typeof body.description !== 'string' ||
      (body.description.trim() && !description) || (body.id !== null && !positive(body.id))) {
    return error(json, 'نام و توضیحات دپارتمان را بررسی کنید.');
  }
  try {
    const result = body.id === null
      ? await run(db, 'INSERT INTO ticket_departments(name,description,active) VALUES(?,?,?)', name, description, Number(body.active))
      : await run(db, 'UPDATE ticket_departments SET name=?,description=?,active=? WHERE id=?', name, description, Number(body.active), body.id);
    return result.meta.changes ? json({ ok: true }) : noDepartment(json);
  } catch (cause) {
    if (cause.errcode === 2067) return error(json, 'دپارتمانی با این نام وجود دارد.', 409);
    throw cause;
  }
}

export async function ticketRequest(request, env, actor, route, json, readBody) {
  const url = new URL(request.url);
  const [namespace, ...sections] = route.split('/');
  const staff = namespace === 'admin';
  if (staff && !actor.admin) return error(json, 'دسترسی ندارید.', 403);
  const path = (staff ? sections.slice(1) : sections).join('/');
  const post = request.method === 'POST';
  const body = post ? await readBody(request) : null;
  if (post && !body) return error(json, 'درخواست معتبر نیست.');
  const db = env.DB, uid = actor.session.user_id;
  if (staff && post && !(await first(db, `SELECT 1 FROM store_accounts a WHERE id=? AND ${activeStaff}`, uid))) {
    return error(json, 'دسترسی ندارید.', 403);
  }
  if (path === 'departments' && (!post || staff)) return departments(db, staff, body, json);
  if (path === 'import-inbox' && staff && post) return importInbox(db, uid, body, json);
  if (!path) {
    if (!post) return listTickets(db, url, uid, staff, json);
    if (!staff) return openTicket(env, uid, body, json);
  }
  const parts = /^(\d+)(?:\/(reply|update))?$/.exec(path);
  if (!parts || !positive(Number(parts[1]))) return notFound(json);
  const ticket = await first(db, `${baseTicket} WHERE t.id=? AND (? OR t.customer_id=?)`, Number(parts[1]), Number(staff), uid);
  if (!ticket) return notFound(json);
  if (!post && !parts[2]) return thread(db, ticket, url, staff, json);
  if (post && parts[2] === 'reply') return replyToTicket(env, uid, ticket, staff, body, json);
  if (post && parts[2] === 'update') return updateTicket(db, uid, ticket, staff, body, json);
  return notFound(json);
}

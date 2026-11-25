const get = id => document.getElementById(id);
const app = get('app');
const base = new URL('/shop/api/', location.origin);
const status = get('status');
const messages = get('messages');
const reply = get('reply');
const formats = new Set(['B','STRONG','I','EM','U','S','CODE','PRE','BR','A','BLOCKQUOTE']);
const rtlDigits = '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩';
const emoji = /\p{Emoji_Presentation}|\p{Extended_Pictographic}|[\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu;
const textOnly = value => value.replace(emoji, '');
const configLinks = new WeakMap();
const number = new Intl.NumberFormat('fa-IR');
let state = { signedIn: false, messages: [], revision: 0 };
let busy = false;
let registering = false;
let nextMessage = null;
let newestMessage = null;
let resetTarget = null;
let panelTrigger = null;

function announce(text = '', error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

const jsonRequest = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function shopFetch(route, options) {
  const response = await fetch(new URL(route, base), {
    credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(180_000),
    ...options,
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const error = new Error(result.error || 'ارتباط با فروشگاه برقرار نشد.');
    error.status = response.status;
    throw error;
  }
  return response;
}

async function api(route, body) {
  return (await shopFetch(route, body === undefined ? {} : jsonRequest(body))).json();
}

function safeURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function link(text, href) {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.textContent = textOnly(text).trim();
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

function renderHTML(content, target) {
  const template = document.createElement('template');
  template.innerHTML = content;
  const append = (node, parent) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.append(document.createTextNode(textOnly(node.textContent)));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || ['SCRIPT','STYLE','IFRAME','SVG','MATH'].includes(node.tagName)) return;
    if (!formats.has(node.tagName)) {
      for (const child of node.childNodes) append(child, parent);
      return;
    }
    const href = node.tagName === 'A' && safeURL(node.getAttribute('href'));
    const element = node.tagName === 'A'
      ? (href ? link('', href) : document.createElement('span'))
      : document.createElement(node.tagName.toLowerCase());
    const code = node.tagName === 'CODE' && node.textContent.trim();
    if (code && /^\w[\w-]*:\/\//.test(code)) {
      configLinks.set(element, code);
      element.textContent = code.replace(emoji, character => encodeURIComponent(character));
    } else {
      for (const child of node.childNodes) append(child, element);
    }
    parent.append(element);
  };
  for (const child of template.content.childNodes) append(child, target);
}

function show(newState) {
  state = newState;
  document.dispatchEvent(new CustomEvent('shop:session', { detail: { signedIn: state.signedIn } }));
  get('login').hidden = state.signedIn;
  get('account').hidden = !state.signedIn;
  closeAccountForms();
  if (!state.signedIn) {
    messages.replaceChildren();
    reply.reset();
    get('inbox').hidden = true;
    return;
  }
  get('inbox').hidden = true;
  messages.hidden = false;
  const fragment = document.createDocumentFragment();
  for (const message of state.messages || []) {
    const card = document.createElement('article');
    card.className = 'message';
    const content = document.createElement('div');
    content.className = 'message-content';
    renderHTML(message.html, content);
    card.append(content);
    if (message.photo && ((safeURL(message.photo) && new URL(message.photo).origin === location.origin) || /^(data:image\/png;base64,[A-Za-z0-9+/=]+|\/shop\/api\/receipt\?kind=(order|topup)&id=\d+)$/.test(message.photo))) {
      const photo = document.createElement('img');
      photo.src = message.photo;
      photo.alt = message.photo.startsWith('data:') ? 'کد QR سرویس'
        : message.photo.startsWith('/shop/api/receipt') ? 'تصویر فیش پرداخت' : 'تصویر منوی فروشگاه';
      card.append(photo);
    }
    for (const code of content.querySelectorAll('code')) {
      if (!configLinks.has(code)) continue;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'کپی لینک';
      copy.className = 'secondary';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(configLinks.get(code));
          announce('لینک کپی شد.');
        } catch { announce('لینک را انتخاب و کپی کنید.', true); }
      });
      code.after(' ', copy);
    }
    for (const row of message.rows || []) {
      const buttons = document.createElement('div');
      buttons.className = 'button-row';
      for (const option of row) {
        const href = option.url && safeURL(option.url);
        if (href) {
          const anchor = link(option.text, href);
          anchor.className = 'action-link';
          buttons.append(anchor);
        } else if (option.action) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = textOnly(option.text).trim();
          button.addEventListener('click', () => {
            if (option.action === 'web:notice') {
              void perform(async () => {
                const { notice } = await api('admin/notice');
                openAccountForm('notice-editor', 'notice-heading', button);
                setNoticeFields(notice);
              }).then(() => {
                if (!get('notice-editor').hidden) get('notice-heading').focus();
              });
              return;
            }
            if (option.action === 'web:backup') return openAccountForm('backup-panel', 'backup-password', button);
            const target = /^web:reset_password:(\d+)$/.exec(option.action);
            if (target) {
              openAccountForm('password-reset', 'reset-admin-password', button);
              resetTarget = Number(target[1]);
              get('reset-user').textContent = `شناسهٔ کاربر ${number.format(resetTarget)}. بعد از ذخیره، کاربر با رمز جدید وارد می‌شود.`;
              return;
            }
            if (/^(wallet:pay:|approve_|topup:(approve|reject):|loc:go:)/.test(option.action) &&
                !window.confirm(button.textContent + '؟')) return;
            void perform(() => action({ kind: 'button', action: option.action }));
          });
          buttons.append(button);
        }
      }
      if (buttons.childElementCount) card.append(buttons);
    }
    fragment.append(card);
  }
  messages.replaceChildren(fragment);
  reply.reset();
  reply.hidden = !state.input;
  const label = get('reply-label');
  const field = { text: 'reply-value', password: 'reply-secret', image: 'reply-image' }[state.input];
  for (const id of ['reply-value','reply-secret','reply-image']) get(id).hidden = id !== field;
  if (field) {
    label.htmlFor = field;
    label.textContent = state.input === 'image' ? 'تصویر فیش پرداخت' : state.input === 'password' ? 'رمز پنل' : 'پاسخ';
  }
}

function setBusy(value) {
  busy = value;
  app.setAttribute('aria-busy', String(value));
  for (const el of app.querySelectorAll('button,input,textarea,select')) el.disabled = value;
}

async function perform(task) {
  if (busy) return;
  setBusy(true);
  announce('در حال بررسی…');
  try {
    const message = await task();
    announce(typeof message === 'string' ? message : '');
  } catch (error) {
    if (error.status === 401) show({ signedIn: false });
    announce(error.name === 'TimeoutError'
      ? 'زمان پاسخ تمام شد. قبل از تکرار پرداخت، صفحه را تازه کنید.'
      : (error.message || 'ارتباط برقرار نشد.'), true);
  } finally {
    setBusy(false);
  }
}

async function action(body) {
  show(await api('action', { ...body, revision: state.revision }));
}

async function refresh() {
  show(await api('state'));
  if (state.signedIn && !state.messages.length) await action({ kind: 'home' });
}

function closeAccountForms() {
  get('password-change').hidden = true;
  get('password-open').setAttribute('aria-expanded', 'false');
  get('password-reset').hidden = true;
  get('backup-panel').hidden = true;
  get('notice-editor').hidden = true;
  for (const id of ['password-form', 'reset-form', 'backup-download', 'backup-restore', 'notice-form']) get(id).reset();
  resetTarget = null;
  panelTrigger = null;
}

function openAccountForm(section, input, trigger) {
  closeAccountForms();
  panelTrigger = trigger;
  get(section).hidden = false;
  get(input).focus();
}

function cancelAccountForm() {
  const trigger = panelTrigger;
  closeAccountForms();
  trigger?.focus();
}

get('password-open').addEventListener('click', () => {
  openAccountForm('password-change', 'current-password', get('password-open'));
  get('password-open').setAttribute('aria-expanded', 'true');
});
for (const id of ['password-cancel', 'reset-cancel', 'backup-close', 'notice-cancel']) get(id).addEventListener('click', cancelAccountForm);
function setNoticeFields(notice) {
  get('notice-kind').value = notice.kind;
  get('notice-heading').value = notice.title;
  get('notice-message').value = notice.message;
  get('notice-active').checked = notice.active;
}

get('notice-form').addEventListener('submit', event => {
  event.preventDefault();
  void perform(async () => {
    const { notice } = await api('admin/notice', {
      kind: get('notice-kind').value,
      title: get('notice-heading').value,
      message: get('notice-message').value,
      active: get('notice-active').checked,
    });
    setNoticeFields(notice);
    document.dispatchEvent(new Event('shop:notice'));
    return notice.active ? 'اطلاعیه منتشر شد.' : 'اطلاعیه ذخیره شد و نمایش آن خاموش است.';
  });
});

get('password-form').addEventListener('submit', event => {
  event.preventDefault();
  void perform(async () => {
    const currentPassword = get('current-password').value;
    const newPassword = get('new-password').value;
    if (newPassword !== get('repeat-password').value) throw new Error('رمز جدید و تکرار آن یکسان نیستند.');
    try {
      show(await api('password', { currentPassword, newPassword }));
      return 'رمز عبور تغییر کرد. با رمز جدید وارد شوید.';
    } finally { get('current-password').value = ''; }
  });
});

get('reset-form').addEventListener('submit', event => {
  event.preventDefault();
  void perform(async () => {
    const current = get('reset-admin-password');
    const newPassword = get('reset-new-password').value;
    if (newPassword !== get('reset-repeat-password').value) throw new Error('رمز جدید و تکرار آن یکسان نیستند.');
    try {
      await api('admin/password', { userId: resetTarget, currentPassword: current.value, newPassword });
      closeAccountForms();
      return 'رمز کاربر بازنشانی شد و نشست قبلی او بسته شد.';
    } finally { current.value = ''; }
  });
});

get('backup-download').addEventListener('submit', event => {
  event.preventDefault();
  void perform(async () => {
    const password = get('backup-password');
    try {
      const response = await shopFetch('backup/download', jsonRequest({ currentPassword: password.value }));
      const objectURL = URL.createObjectURL(await response.blob());
      const download = document.createElement('a');
      download.href = objectURL;
      download.download = /filename="(asan-gozar-[\d-]+\.agbackup)"/.exec(response.headers.get('Content-Disposition'))?.[1] || 'asan-gozar.agbackup';
      download.click();
      setTimeout(() => URL.revokeObjectURL(objectURL), 60_000);
      return 'نسخهٔ پشتیبان رمزنگاری‌شده آماده شد.';
    } finally { password.value = ''; }
  });
});

get('backup-restore').addEventListener('submit', event => {
  event.preventDefault();
  if (!window.confirm('داده‌های فعلی فروشگاه با داده‌های این فایل جایگزین شوند؟')) return;
  void perform(async () => {
    const password = get('restore-password');
    const file = get('backup-file').files[0];
    try {
      if (!file || file.size > 64 * 1024 ** 2) throw new Error('فایل پشتیبان حداکثر ۶۴ مگابایت باشد.');
      const { ticket } = await api('backup/authorize-restore', { currentPassword: password.value });
      const response = await shopFetch('backup/restore', {
        method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-Asan-Gozar-Restore-Key': ticket },
      });
      show(await response.json());
      return 'داده‌های فروشگاه بازیابی شدند. دوباره وارد شوید.';
    } finally { password.value = ''; }
  });
});

async function imageData(file) {
  if (!file || file.size > 10_000_000 || !['image/jpeg','image/png','image/webp'].includes(file.type)) {
    throw new Error('یک تصویر JPG، PNG یا WebP حداکثر ۱۰ مگابایت انتخاب کنید.');
  }
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1460 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', .8).split(',')[1];
    if (!data || data.length > 800_000) throw new Error('تصویر خوانا با حجم کمتری بفرستید.');
    return data;
  } finally { image.close(); }
}

get('toggle-signup').addEventListener('click', () => {
  registering = !registering;
  get('login-title').textContent = registering ? 'ساخت حساب فروشگاه' : 'ورود به فروشگاه';
  get('signup-name').hidden = !registering;
  get('display-name').required = registering;
  get('auth-submit').textContent = registering ? 'ثبت‌نام' : 'ورود';
  get('toggle-signup').textContent = registering ? 'حساب دارم' : 'ساخت حساب';
  get('password').autocomplete = registering ? 'new-password' : 'current-password';
});

get('auth').addEventListener('submit', event => {
  event.preventDefault();
  void perform(async () => {
    const password = get('password');
    try {
      await api(registering ? 'register' : 'login', {
        name: get('display-name').value, username: get('username').value, password: password.value,
      });
      get('auth').reset();
      await refresh();
    } finally { password.value = ''; }
  });
});

async function loadInbox(more = false) {
  closeAccountForms();
  const { messages: entries, next } = await api(more ? `inbox?before=${nextMessage}` : 'inbox');
  get('inbox').hidden = false;
  messages.hidden = true;
  reply.hidden = true;
  const container = get('inbox-items');
  if (!more) {
    newestMessage = entries[0]?.id;
    container.replaceChildren();
  }
  for (const entry of entries) {
    const card = document.createElement('article');
    card.className = 'message';
    const time = document.createElement('time');
    time.dateTime = new Date(entry.created_at).toISOString();
    time.textContent = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(entry.created_at);
    if (!entry.read_at) time.textContent += ' · خوانده‌نشده';
    const content = document.createElement('div');
    content.className = 'message-content';
    renderHTML(entry.html, content);
    card.append(time, content);
    container.append(card);
  }
  if (!more && entries.length === 0) container.textContent = 'هنوز پیامی دریافت نکرده‌اید.';
  nextMessage = next;
  get('inbox-more').hidden = !nextMessage;
  get('inbox-read').hidden = !newestMessage;
}

get('inbox-open').addEventListener('click', () => { void perform(loadInbox); });
get('inbox-more').addEventListener('click', () => { void perform(() => loadInbox(true)); });
get('inbox-read').addEventListener('click', () => {
  void perform(async () => {
    await api('inbox/read', { upTo: newestMessage });
    await loadInbox();
  });
});

get('home').addEventListener('click', () => {
  if (state.input === 'image' && !window.confirm('به منو برگردم؟ پیش‌نویس فعلی ممکن است لغو شود.')) return;
  void perform(() => action({ kind: 'home' }));
});
get('refresh').addEventListener('click', () => { void perform(get('inbox').hidden ? refresh : loadInbox); });
get('logout').addEventListener('click', () => { void perform(async () => show(await api('logout', {}))); });
reply.addEventListener('submit', event => {
  event.preventDefault();
  void perform(async () => {
    if (state.input === 'image') {
      await action({ kind: 'image', image: await imageData(get('reply-image').files[0]) });
      return;
    }
    const secret = state.input === 'password';
    const field = get(secret ? 'reply-secret' : 'reply-value');
    const value = secret ? field.value : field.value.trim();
    const text = !secret && /^[\d۰-۹٠-٩]+$/.test(value)
      ? value.replace(/[۰-۹٠-٩]/g, char => String(rtlDigits.indexOf(char) % 10)) : value;
    if (!text) throw new Error('پاسخ را وارد کنید.');
    await action({ kind: 'text', text });
  });
});
void perform(refresh);

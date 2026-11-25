import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStoreBackups } from './backups.mjs';
import { openStore } from './database.mjs';
import { listenForWebShop } from './http.mjs';
import { handleUpdate, recoverStorePayments, runBulkMigrations, runSubscriptionPolicies } from './engine.js';
import { isWebShopPath, pruneWebShop, webShopRequest } from './shop-api.js';
import { deliverToInbox } from './inbox.js';
import { processMessageJobs } from './messages.js';
import { loadStorePages, webStorePage } from './site.mjs';

process.umask(0o077);
const config = JSON.parse(readFileSync(process.env.STORE_CONFIG || '/etc/asan-gozar-store/config.json', 'utf8'));
const port = Number(config.port ?? 8787);
const origin = new URL(config.origin);
if (origin.protocol !== 'https:' || origin.origin !== config.origin ||
    !Number.isInteger(port) || port < 1024 || port > 65535 || !/^[0-9a-f]{64}$/i.test(config.secret || '')) {
  throw new Error('Configure the HTTPS origin, loopback port and a 32-byte hex secret.');
}
const database = resolve(process.env.STORE_DATABASE || '/var/lib/asan-gozar-store/store.sqlite');
let store = openStore(database);
const owners = () => store.sqlite.prepare('SELECT id FROM store_accounts WHERE owner=1 ORDER BY id').all();
if (!owners().length) throw new Error('Create a shop owner first.');
const tasks = new Set();
let requests = 0;
const backups = createStoreBackups(database, config.secret, () => store, replacement => { store = replacement; },
  () => requests === 1 && tasks.size === 0);
const pages = loadStorePages(process.env.STORE_WEB_PAGES || fileURLToPath(new URL('./site/', import.meta.url)));
const env = { STORE_SECRET: config.secret, WEB_SHOP_ORIGIN: origin.origin, WEB_SHOP_BACKUPS: backups, WEB_STORE_PAGES: pages };
const context = base => ({ ...base, DB: store.DB, OWNER_IDS: owners().map(row => row.id).join(',') });
const app = async (request, base) => {
  const path = new URL(request.url).pathname;
  const page = pages.get(path);
  if (page) return webStorePage(request, page, { ...base, DB: store.DB });
  if (!isWebShopPath(path)) return new Response(null, { status: 404 });
  requests++;
  try { return await webShopRequest(request, context(base), handleUpdate); }
  finally { requests--; }
};
const http = await listenForWebShop(app, env, port);

const shutdown = new AbortController();
const intervals = [];
function schedule(label, delay, run) {
  let pending;
  function tick() {
    if (pending || shutdown.signal.aborted) return;
    pending = Promise.resolve().then(() => run(context(env)))
      .catch(() => console.error(label + ' failed'))
      .finally(() => { tasks.delete(pending); pending = null; });
    tasks.add(pending);
  }
  intervals.push(setInterval(tick, delay));
  tick();
}
schedule('Subscription housekeeping', 300_000, async context => {
  await pruneWebShop(context);
  await recoverStorePayments(context);
  await runSubscriptionPolicies(context, { signal: shutdown.signal });
});
schedule('Service transfers', 5000, context => runBulkMigrations(context, { signal: shutdown.signal }));
schedule('Private messages', 5000, context => processMessageJobs(context, (userId, text) =>
  deliverToInbox(context, 'sendMessage', { chat_id: userId, text: text.replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' })[c]) }),
  { signal: shutdown.signal }));
console.log('Asan Gozar store API is listening on loopback.');

async function stop() {
  if (shutdown.signal.aborted) return;
  shutdown.abort();
  intervals.forEach(clearInterval);
  await new Promise(resolve => http.close(resolve));
  await Promise.allSettled(tasks);
  store.sqlite.close();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

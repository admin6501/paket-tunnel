import { readFileSync } from 'node:fs';
import { openStore } from './database.mjs';
import { listenForWebShop } from './http.mjs';
import { handleUpdate, recoverStorePayments, runBulkMigrations, runSubscriptionPolicies } from './engine.js';
import { isWebShopPath, pruneWebShop, webShopRequest } from './shop-api.js';
import { deliverToInbox } from './inbox.js';
import { processMessageJobs } from './messages.js';

process.umask(0o077);
const config = JSON.parse(readFileSync(process.env.STORE_CONFIG || '/etc/asan-gozar-store/config.json', 'utf8'));
const port = Number(config.port ?? 8787);
const origin = new URL(config.origin);
if (origin.protocol !== 'https:' || origin.origin !== config.origin ||
    !Number.isInteger(port) || port < 1024 || port > 65535 || !/^[0-9a-f]{64}$/i.test(config.secret || '')) {
  throw new Error('Configure the HTTPS origin, loopback port and a 32-byte hex secret.');
}
const { sqlite, DB } = openStore(process.env.STORE_DATABASE || '/var/lib/asan-gozar-store/store.sqlite');
const owners = sqlite.prepare('SELECT id FROM store_accounts WHERE owner=1 ORDER BY id');
if (!owners.get()) throw new Error('Create a shop owner first.');
const env = { DB, STORE_SECRET: config.secret, WEB_SHOP_ORIGIN: origin.origin };
const withOwners = base => ({ ...base, OWNER_IDS: owners.all().map(row => row.id).join(',') });
const app = (request, base) => isWebShopPath(new URL(request.url).pathname)
  ? webShopRequest(request, withOwners(base), handleUpdate) : new Response(null, { status: 404 });
const http = await listenForWebShop(app, env, port);

const shutdown = new AbortController();
const intervals = [];
const tasks = new Set();
function schedule(label, delay, run) {
  let pending;
  function tick() {
    if (pending || shutdown.signal.aborted) return;
    pending = Promise.resolve().then(() => run(withOwners(env)))
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
  sqlite.close();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

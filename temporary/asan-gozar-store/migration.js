// A migration is a durable sequence: a mutation is recorded as uncertain before
// dispatch. If the process dies or a response is lost, it must be reconciled by
// an operator rather than repeated against a panel with an unknown state.
const STEPS = [
  ['freeze_source', 'freezeSource'],
  ['snapshot_source', 'snapshotSource'],
  ['create_destination', 'createDestination'],
  ['import_usage', 'importUsage'],
  ['verify_destination', 'verifyDestination'],
  ['activate_destination', 'activateDestination'],
  ['verify_active_destination', 'verifyActiveDestination'],
  ['delete_source', 'deleteSource'],
  ['commit_destination', 'commitDestination'],
];
const READ_ONLY = new Set(['snapshot_source', 'verify_destination', 'verify_active_destination']);
const REVIEW_DELAY_MS = 10 * 60 * 1000;

// Keep the original quota and the absolute expiry, rather than creating a
// reduced-size package which a later renewal would mistakenly renew at that size.
export function migrationSnapshot(account, traffic, expectedEmail, expectedSubId) {
  if (!account || account.enable !== false || !expectedEmail || !expectedSubId ||
      String(account.email || '').trim().toLowerCase() !== String(expectedEmail).trim().toLowerCase() ||
      String(account.subId || '') !== String(expectedSubId)) throw new Error('source identity or frozen status is invalid');
  const fields = ['up', 'down', 'totalGB', 'expiryTime'];
  for (const key of fields) if (!Number.isSafeInteger(account[key]) || (key !== 'expiryTime' && account[key] < 0)) throw new Error(`invalid source ${key}`);
  if (!Number.isSafeInteger(account.up + account.down)) throw new Error('invalid source usage');
  // A negative value encodes first-use semantics and must be preserved verbatim.
  if (!traffic || String(traffic.email || '').trim().toLowerCase() !== String(expectedEmail).trim().toLowerCase() ||
      traffic.enable !== false || traffic.up !== account.up || traffic.down !== account.down) throw new Error('source traffic snapshot is inconsistent');
  const lifetime = traffic.allTime;
  if (!Number.isSafeInteger(lifetime) || lifetime < 0) throw new Error('invalid source lifetime');
  return { upload: account.up, download: account.down, allTime: Math.max(lifetime, account.up + account.down), quota: account.totalGB, expiry: account.expiryTime };
}

// The adapter must make freezeSource wait for all protocol sessions to end and
// their last counters to be committed. A mere database enable flag is not enough.
// journal.compareAndSet is atomic and persists the whole record, including the
// newly-generated destination identity, before any network mutation is dispatched.
export async function advanceMigration(journal, adapter, id) {
  let job = await journal.get(id);
  if (!job) throw new Error('migration not found');
  if (job.state === 'complete') return job;
  if (job.state !== 'ready') throw new Error('migration requires review');
  for (let index = job.next; index < STEPS.length; index++) {
    const [step, method] = STEPS[index];
    if (typeof adapter[method] !== 'function') throw new Error(`unsupported migration step: ${step}`);
    if (!READ_ONLY.has(step)) {
      const dispatched = { ...job, state: 'review', uncertain: step, dispatchedAt: Date.now() };
      if (!await journal.compareAndSet(id, job, dispatched)) throw new Error('migration is already running');
      job = dispatched;
    }
    let output;
    try {
      output = await adapter[method](job);
    } catch (error) {
      // Reads can safely be retried, but uncertain writes remain locked.
      throw new Error(`migration ${step} failed: ${error.message}`, { cause: error });
    }
    if (output === false || output == null) throw new Error(`migration ${step} was not confirmed`);
    const next = { ...job, ...(typeof output === 'object' ? output : {}), id: job.id, serviceId: job.serviceId, state: 'ready', uncertain: null, dispatchedAt: null, lastCompletedAt: Date.now(), next: index + 1 };
    // Adapters may add results, but may not overwrite the sequence controls.
    if (index === STEPS.length - 1) next.state = 'complete';
    if (!await journal.compareAndSet(id, job, next)) throw new Error('migration journal conflict');
    job = next;
  }
  return job;
}

// Reconciliation only reads external state. Its verifier must independently
// prove either that the exact operation completed, or that it definitely did
// not happen and no request is still in flight. Ambiguous results stay locked.
export async function reconcileMigration(journal, adapter, id, clock = Date.now) {
  const job = await journal.get(id);
  if (!job || job.state !== 'review' || !Number.isSafeInteger(job.next) ||
      !STEPS[job.next] || STEPS[job.next][0] !== job.uncertain || READ_ONLY.has(job.uncertain)) throw new Error('migration is not awaiting review');
  if (!Number.isSafeInteger(job.dispatchedAt) || clock() - job.dispatchedAt < REVIEW_DELAY_MS) throw new Error('migration operation may still be running');
  if (typeof adapter.reconcile !== 'function') throw new Error('migration verifier unavailable');
  const result = await adapter.reconcile(job);
  if (!result || !['applied', 'not_applied'].includes(result.verdict)) throw new Error('migration result remains uncertain');
  const nextIndex = job.next + (result.verdict === 'applied' ? 1 : 0);
  const next = { ...job, ...(result.data || {}), id: job.id, serviceId: job.serviceId,
    state: nextIndex === STEPS.length ? 'complete' : 'ready', uncertain: null, dispatchedAt: null, lastCompletedAt: clock(), next: nextIndex };
  if (!await journal.compareAndSet(id, job, next)) throw new Error('migration journal conflict');
  return next;
}

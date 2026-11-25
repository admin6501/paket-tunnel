// Store migration progress in the existing settings table so upgrades need no
// schema rewrite. The service lock also blocks renewals and other bot actions.
export function migrationJournal(db) {
  const key = id => `migration:${id}`;
  return {
    async create(id, serviceId, payload) {
      if (!/^[0-9a-f-]{36}$/.test(id) || !Number.isSafeInteger(serviceId) || serviceId <= 0) throw new Error('invalid migration identity');
      const job = { ...payload, id, serviceId, state: 'ready', next: 0, uncertain: null, lastCompletedAt: Date.now() };
      const lockKind = `migration:${id}`;
      const result = await db.batch([
        db.prepare("INSERT INTO service_operations(service_id,kind,created_at) SELECT id,?,? FROM services WHERE id=? AND NOT EXISTS(SELECT 1 FROM orders WHERE renew_service_id=services.id AND status NOT IN ('approved','rejected','cancelled','wallet_failed_refunded','wallet_review_resolved'))").bind(lockKind, new Date().toISOString(), serviceId),
        db.prepare('INSERT INTO settings(key,value) SELECT ?,? WHERE EXISTS(SELECT 1 FROM service_operations WHERE service_id=? AND kind=?)').bind(key(id), JSON.stringify(job), serviceId, lockKind),
      ]);
      if (!result[0].meta.changes || !result[1].meta.changes) throw new Error('service not found or unavailable');
      return job;
    },
    async get(id) {
      const row = await db.prepare('SELECT value FROM settings WHERE key=?').bind(key(id)).first();
      return row ? JSON.parse(row.value) : null;
    },
    async compareAndSet(id, before, after) {
      const result = await db.prepare('UPDATE settings SET value=? WHERE key=? AND value=?').bind(JSON.stringify(after), key(id), JSON.stringify(before)).run();
      return result.meta.changes === 1;
    },
    async releaseComplete(id) {
      const job = await this.get(id);
      if (!job || job.state !== 'complete') throw new Error('migration not complete');
      const result = await db.prepare("DELETE FROM service_operations WHERE service_id=? AND kind=? AND EXISTS(SELECT 1 FROM settings WHERE key=? AND value=?)")
        .bind(job.serviceId, `migration:${id}`, key(id), JSON.stringify(job)).run();
      return result.meta.changes === 1;
    },
  };
}

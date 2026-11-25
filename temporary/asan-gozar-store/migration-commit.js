// Switch a bot service only after the destination is verified and the source
// deletion is confirmed. Both changes run in one D1/SQLite batch; the durable
// migration lock and exact old service identity guard against stale buttons.
export async function commitMigrationService(db, job) {
  const s = job?.source, d = job?.destination;
  if (job?.state !== 'review' || job.uncertain !== 'commit_destination' ||
      !Number.isSafeInteger(job.serviceId) || job.serviceId <= 0 || !job.id ||
      !s?.email || !s.subId || !d?.email || !d.subId || d.subId === s.subId ||
      !d.panelIdentity || !Number.isSafeInteger(d.inboundId) || d.inboundId <= 0) {
    throw new Error('invalid migration commit');
  }
  let url;
  try { url = new URL(d.link); } catch { throw new Error('invalid destination link'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid destination link');
  const lock = `migration:${job.id}`, record = `migration:${job.id}`, mapping = `service_panel:${job.serviceId}`;
  const guard = `EXISTS(SELECT 1 FROM service_operations WHERE service_id=? AND kind=?)
    AND EXISTS(SELECT 1 FROM settings WHERE key=? AND value=?)
    AND (SELECT value FROM settings WHERE key=?) IS ?
    AND NOT EXISTS(SELECT 1 FROM orders WHERE renew_service_id=? AND status NOT IN ('approved','rejected','cancelled','wallet_failed_refunded','wallet_review_resolved'))`;
  const statements = [
    db.prepare(`UPDATE services SET panel_email=?,inbound_id=?,sub_id=?,sub_link=?,config_link=NULL
      WHERE id=? AND panel_email=? AND sub_id=? AND ${guard}`)
      .bind(d.email, d.inboundId, d.subId, d.link, job.serviceId, s.email, s.subId,
        job.serviceId, lock, record, JSON.stringify(job), mapping, s.panelMapping ?? null, job.serviceId),
    db.prepare(`INSERT INTO settings(key,value) SELECT ?,? WHERE changes()=1 AND EXISTS(
      SELECT 1 FROM services WHERE id=? AND panel_email=? AND sub_id=? AND sub_link=?)
      AND EXISTS(SELECT 1 FROM service_operations WHERE service_id=? AND kind=?)
      AND EXISTS(SELECT 1 FROM settings WHERE key=? AND value=?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .bind(mapping, d.panelIdentity, job.serviceId, d.email, d.subId, d.link,
        job.serviceId, lock, record, JSON.stringify(job)),
  ];
  if(Number.isSafeInteger(d.categoryId) && d.categoryId>0)statements.push(db.prepare(`INSERT INTO settings(key,value) SELECT ?,? WHERE changes()=1 AND EXISTS(SELECT 1 FROM services WHERE id=? AND panel_email=? AND sub_id=? AND sub_link=?) AND EXISTS(SELECT 1 FROM service_operations WHERE service_id=? AND kind=?) AND EXISTS(SELECT 1 FROM settings WHERE key=? AND value=?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(`service_category:${job.serviceId}`,String(d.categoryId),job.serviceId,d.email,d.subId,d.link,job.serviceId,lock,record,JSON.stringify(job)));
  const result = await db.batch(statements);
  if (result[0].meta.changes !== 1 || result[1].meta.changes !== 1) throw new Error('service changed or pending renewal; migration requires review');
  if(statements.length===3 && result[2].meta.changes!==1)throw new Error('destination category commit requires review');
  return true;
}

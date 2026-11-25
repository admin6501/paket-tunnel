// Persistent batch cursor. A claimed service is marked review before any panel
// request; a crash or uncertain response is never retried automatically.
export function bulkMigrationQueue(db) {
  const key = id => `bulk_migration:${id}`;
  async function get(id) {
    const row=await db.prepare('SELECT value FROM settings WHERE key=?').bind(key(id)).first();
    return row ? JSON.parse(row.value) : null;
  }
  async function cas(id, before, after) {
    const result=await db.prepare('UPDATE settings SET value=? WHERE key=? AND value=?').bind(JSON.stringify(after),key(id),JSON.stringify(before)).run();
    return result.meta.changes===1;
  }
  return {
    get,
    async create(id, actorId, source, categoryId, ids, destination=null) {
      if(!/^[0-9a-f-]{36}$/.test(id) || !Number.isSafeInteger(actorId) || actorId<=0 || !source ||
          !Number.isSafeInteger(categoryId) || categoryId<=0 || !Array.isArray(ids) || !ids.length || ids.length>10000 ||
          ids.some(x=>!Number.isSafeInteger(x) || x<=0) || new Set(ids).size!==ids.length) throw new Error('invalid batch');
      const job={id,actorId,source,categoryId,destination,createdAt:Date.now(),items:ids.map(serviceId=>({serviceId,status:'pending'}))};
      await db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').bind(key(id),JSON.stringify(job)).run();
      return job;
    },
    async step(id, execute, clock=Date.now) {
      const before=await get(id);if(!before)throw new Error('batch not found');
      if(before.items.some(x=>x.status==='running'))throw new Error('batch is already running');
      const index=before.items.findIndex(x=>x.status==='pending');if(index<0)return before;
      const claimed=structuredClone(before);claimed.items[index]={...claimed.items[index],status:'running',startedAt:clock()};
      if(!await cas(id,before,claimed))throw new Error('batch is already running');
      let result;
      try { result=await execute(claimed.items[index].serviceId,claimed); }
      catch { result=false; }
      const finished=structuredClone(claimed);
      finished.items[index]={...finished.items[index],status:result===true?'done':'review',finishedAt:clock()};
      if(!await cas(id,claimed,finished))throw new Error('batch journal conflict');
      return finished;
    },
    async recover(id, clock=Date.now) {
      const before=await get(id);if(!before)throw new Error('batch not found');
      const index=before.items.findIndex(x=>x.status==='running');if(index<0)return before;
      if(!Number.isSafeInteger(before.items[index].startedAt) || clock()-before.items[index].startedAt<600000)throw new Error('batch operation may still be running');
      const after=structuredClone(before);after.items[index]={...after.items[index],status:'review',finishedAt:clock()};
      if(!await cas(id,before,after))throw new Error('batch journal conflict');
      return after;
    },
  };
}

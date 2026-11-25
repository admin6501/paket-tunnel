// Admin messages use durable claims. A send with an unknown result is not retried blindly.
const run=(env,sql,...a)=>env.DB.prepare(sql).bind(...a).run();
const first=(env,sql,...a)=>env.DB.prepare(sql).bind(...a).first();
const all=async(env,sql,...a)=>(await env.DB.prepare(sql).bind(...a).all()).results;
export async function createMessageJob(env,creator,audience,target,body){
 if(!Number.isSafeInteger(creator)||creator<=0||audience!=='private'||typeof body!=='string'||!body.trim()||body.length>3500||(audience==='private'&&(!Number.isSafeInteger(target)||target<=0)))throw Error('پیام یا گیرنده معتبر نیست.');
 const result=await run(env,"INSERT INTO store_message_jobs(creator_id,audience,target_id,body,status,created_ms) VALUES(?,?,?,?,'draft',?)",creator,audience,target||null,body,Date.now());return Number(result.meta.last_row_id);
}
export async function confirmMessageJob(env,id,creator){
 const job=await first(env,"SELECT id,audience,target_id FROM store_message_jobs WHERE id=? AND creator_id=? AND status='draft'",id,creator);if(!job)return false;
 const populate=env.DB.prepare("INSERT OR IGNORE INTO store_message_targets(job_id,user_id,status) SELECT ?,?,'pending' WHERE EXISTS(SELECT 1 FROM store_message_jobs WHERE id=? AND creator_id=? AND status='building')").bind(id,job.target_id,id,creator);
 const r=await env.DB.batch([
  env.DB.prepare("UPDATE store_message_jobs SET status='building' WHERE id=? AND creator_id=? AND status='draft'").bind(id,creator),populate,
  env.DB.prepare("UPDATE store_message_jobs SET status=CASE WHEN EXISTS(SELECT 1 FROM store_message_targets WHERE job_id=?) THEN 'queued' ELSE 'done' END,finished_ms=CASE WHEN EXISTS(SELECT 1 FROM store_message_targets WHERE job_id=?) THEN NULL ELSE ? END WHERE id=? AND creator_id=? AND status='building'").bind(id,id,Date.now(),id,creator),
 ]);
 return Number(r[0]?.meta?.changes)>0;
}
export async function processMessageJobs(env,send,{signal,now=()=>Date.now(),limit=20}={}){
 await run(env,"UPDATE store_message_targets SET status='uncertain' WHERE status='sending' AND claimed_ms<?",now()-120000);
 const job=await first(env,"SELECT * FROM store_message_jobs WHERE status='queued' ORDER BY id LIMIT 1");if(!job)return;
 const body=job.body;
 const recipients=await all(env,"SELECT user_id FROM store_message_targets WHERE job_id=? AND status='pending' ORDER BY user_id LIMIT ?",job.id,limit);
 for(const r of recipients){
  if(signal?.aborted)break;
  const claimed=await run(env,"UPDATE store_message_targets SET status='sending',claimed_ms=? WHERE job_id=? AND user_id=? AND status='pending' AND EXISTS(SELECT 1 FROM store_message_jobs WHERE id=? AND status='queued')",now(),job.id,r.user_id,job.id);
  if(!claimed.meta.changes)continue;
  let state='uncertain';try{const result=await send(r.user_id,body,signal);state=result?.ok?'sent':'failed'}catch{}
  await run(env,"UPDATE store_message_targets SET status=? WHERE job_id=? AND user_id=? AND status='sending'",state,job.id,r.user_id);
  if(!signal?.aborted)await new Promise(resolve=>setTimeout(resolve,55));
 }
 const done=await run(env,"UPDATE store_message_jobs SET status='done',finished_ms=? WHERE id=? AND status='queued' AND NOT EXISTS(SELECT 1 FROM store_message_targets WHERE job_id=? AND status IN ('pending','sending'))",now(),job.id,job.id);
 if(done.meta.changes){const stats=await first(env,"SELECT COUNT(CASE WHEN status='sent' THEN 1 END) sent,COUNT(CASE WHEN status='failed' THEN 1 END) failed,COUNT(CASE WHEN status='uncertain' THEN 1 END) uncertain FROM store_message_targets WHERE job_id=?",job.id);try{await send(job.creator_id,`ارسال پیام ${job.id} پایان یافت. موفق: ${stats.sent}، ناموفق: ${stats.failed}، نامشخص: ${stats.uncertain}.`,signal)}catch{}}
}

// D1 batch executes all statements in a single transaction. The database triggers
// enforce non-negative balances and create immutable, idempotent ledger entries.
export const MAX_WALLET = 9_000_000_000_000_000;
export function parseMoney(value, allowZero=false) {
  const s=String(value ?? '').trim();
  if(!/^\d+$/.test(s)) return null;
  const n=Number(s);
  return Number.isSafeInteger(n) && n <= MAX_WALLET && (allowZero ? n>=0 : n>0) ? n : null;
}
export async function walletBalance(env, userId) {
  const row=await env.DB.prepare('SELECT COALESCE(SUM(delta),0) balance FROM wallet_entries WHERE user_id=?').bind(userId).first();
  const n=Number(row?.balance ?? 0); if(!Number.isSafeInteger(n) || n<0) throw new Error('WALLET_BALANCE_INVALID'); return n;
}
export async function reserveWalletPayment(env, orderId, userId) {
  const now=String(Date.now());
  const results=await env.DB.batch([
    env.DB.prepare("UPDATE orders SET status='wallet_processing' WHERE id=? AND user_id=? AND status='draft' AND NOT EXISTS(SELECT 1 FROM orders o2 WHERE o2.user_id=orders.user_id AND o2.status IN ('wallet_processing','needs_review_refunded')) AND NOT EXISTS(SELECT 1 FROM store_coupon_uses u WHERE u.order_id=orders.id AND u.state='reserved' AND u.expires_ms<=?)").bind(orderId,userId,Number(now)),
    env.DB.prepare("INSERT INTO wallet_payments(order_id,user_id,amount,state,created_at) SELECT id,user_id,final_price,'processing',? FROM orders WHERE id=? AND user_id=? AND status='wallet_processing'").bind(now,orderId,userId),
  ]);
  return Number(results[0]?.meta?.changes)>=1 && Number(results[1]?.meta?.changes)>=1;
}
export async function completeWalletPayment(env, orderId, state, beforeDispatch=false) {
  if(!['settled','refunded'].includes(state)) throw new Error('WALLET_INVALID_STATE');
  const orderStatus=state==='settled'?'approved':beforeDispatch?'wallet_failed_refunded':'needs_review_refunded';
  const result=await env.DB.batch([
    env.DB.prepare("UPDATE wallet_payments SET state=? WHERE order_id=? AND state='processing'").bind(state,orderId),
    env.DB.prepare("UPDATE orders SET status=? WHERE id=? AND status='wallet_processing' AND EXISTS(SELECT 1 FROM wallet_payments WHERE order_id=? AND state=?)").bind(orderStatus,orderId,orderId,state),
    env.DB.prepare("UPDATE store_coupon_uses SET state=? WHERE order_id=? AND state='reserved' AND EXISTS(SELECT 1 FROM wallet_payments WHERE order_id=? AND state=?)").bind(state==='settled'?'consumed':'released',orderId,orderId,state),
  ]);
  return Number(result[0]?.meta?.changes)>=1 && Number(result[1]?.meta?.changes)>=1;
}
export async function adjustWallet(env, userId, delta, actorId, reference) {
  if(!Number.isSafeInteger(delta) || delta===0 || Math.abs(delta)>MAX_WALLET) throw new Error('WALLET_INVALID_AMOUNT');
  return env.DB.prepare('INSERT INTO wallet_entries(user_id,delta,reference,reason,actor_id,created_at) VALUES(?,?,?,?,?,?)')
    .bind(userId,delta,reference,'admin_adjustment',actorId,String(Date.now())).run();
}
export async function recoverWalletPayments(env) {
  const cutoff=Date.now()-10*60*1000;
  const rows=(await env.DB.prepare("SELECT order_id,user_id FROM wallet_payments WHERE state='processing' AND CAST(created_at AS INTEGER) < ? ORDER BY created_at LIMIT 50").bind(cutoff).all()).results;
  const recovered=[]; for(const row of rows) if(await completeWalletPayment(env,Number(row.order_id),'refunded')) recovered.push({orderId:Number(row.order_id),userId:Number(row.user_id)});
  return recovered;
}

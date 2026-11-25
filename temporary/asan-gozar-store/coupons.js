// Coupon reservations are atomic SQLite writes guarded by schema triggers.
export const COUPON_HOLD_MS=30*60*1000;
export const normalizeCoupon=value=>String(value || '').trim().toUpperCase();
export const validCouponCode=value=>/^[A-Z0-9_-]{3,32}$/.test(value);
const run=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).run();
const first=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).first();
export async function expireCouponReservations(env,now=Date.now()) {
 return run(env,"UPDATE store_coupon_uses SET state='released' WHERE state='reserved' AND expires_ms<=? AND EXISTS(SELECT 1 FROM orders o WHERE o.id=order_id AND o.status IN ('draft','needs_fix'))",now);
}
export async function cancelDraftOrder(env,orderId,userId) {
 return env.DB.batch([
  env.DB.prepare("UPDATE store_coupon_uses SET state='released' WHERE order_id=? AND user_id=? AND state='reserved' AND EXISTS(SELECT 1 FROM orders o WHERE o.id=order_id AND o.status='draft')").bind(orderId,userId),
  env.DB.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND user_id=? AND status='draft'").bind(orderId,userId),
 ]);
}
export async function applyCoupon(env,orderId,userId,raw,now=Date.now()) {
 const code=normalizeCoupon(raw);if(!validCouponCode(code))throw Error('کد تخفیف معتبر نیست.');
 await expireCouponReservations(env,now);
 const order=await first(env,"SELECT * FROM orders WHERE id=? AND user_id=?",orderId,userId);
 if(!order || order.status!=='draft')throw Error('سفارش منقضی شده یا قابل ویرایش نیست؛ دوباره سفارش بسازید.');
 if(Number(order.discount)>0 && !(await first(env,"SELECT order_id FROM store_order_referrals WHERE order_id=? AND user_id=? AND state='reserved'",orderId,userId)))throw Error('تخفیف قدیمی این سفارش قابل تأیید نیست؛ سفارش جدید بسازید یا با پشتیبانی تماس بگیرید.');
 const coupon=await first(env,"SELECT * FROM store_coupons WHERE code=? AND enabled=1 AND deleted=0",code);
 if(!coupon || (coupon.expires_ms!==null && Number(coupon.expires_ms)<=now))throw Error('کد تخفیف فعال یا معتبر نیست.');
 const price=Number(order.final_price),value=Number(coupon.value);
 if(!Number.isSafeInteger(price)||price<0||!Number.isSafeInteger(value)||value<=0)throw Error('مبلغ سفارش یا کد معتبر نیست.');
 if(price===0)throw Error('مبلغ باقی‌مانده این سفارش صفر است و تخفیف دیگری لازم نیست.');
 const amount=coupon.kind==='fixed'?Math.min(price,value):Number(BigInt(price)*BigInt(value)/100n);
 if(amount<=0)throw Error('مبلغ تخفیف برای این سفارش کمتر از یک تومان است.');
 const until=Math.min(now+COUPON_HOLD_MS,coupon.expires_ms===null?Number.MAX_SAFE_INTEGER:Number(coupon.expires_ms));
 try {await run(env,"INSERT INTO store_coupon_uses(coupon_id,order_id,user_id,amount,created_ms,expires_ms,state) VALUES(?,?,?,?,?,?,'reserved')",coupon.id,orderId,userId,amount,now,until)}
 catch(e){const m=String(e.message);if(m.includes('COUPON_TOTAL_LIMIT'))throw Error('ظرفیت کلی کد تمام شده است.');if(m.includes('COUPON_USER_LIMIT'))throw Error('سهمیه شما برای این کد تمام شده است.');if(m.includes('UNIQUE'))throw Error('برای این سفارش قبلاً یک کد ثبت شده است.');throw Error('کد قابل استفاده نیست یا وضعیت سفارش تغییر کرده است.');}
 return {amount,expiresMs:until,code};
}

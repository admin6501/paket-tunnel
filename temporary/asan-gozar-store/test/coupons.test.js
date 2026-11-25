import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {applyCoupon,expireCouponReservations,cancelDraftOrder,COUPON_HOLD_MS} from '../coupons.js';
import {adjustWallet,reserveWalletPayment,completeWalletPayment,walletBalance} from '../wallet.js';
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const prep=(q,a=[])=>({q,a,bind(...x){return prep(q,x)},async run(){const r=sql.prepare(q).run(...a);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}},async first(){return sql.prepare(q).get(...a)??null},async all(){return {results:sql.prepare(q).all(...a)}}});
 let queue=Promise.resolve();const DB={prepare:q=>prep(q),batch(stmts){const task=async()=>{sql.exec('BEGIN IMMEDIATE');try{const r=[];for(const s of stmts)r.push(await s.run());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}};let p=queue.then(task);queue=p.catch(()=>{});return p}};
 const env={DB},order=(user,price=100)=>Number(sql.prepare("INSERT INTO orders(user_id,price,discount,final_price,status) VALUES(?,?,0,?,'draft')").run(user,price,price).lastInsertRowid);
 const coupon=(code,kind,value,total=null,perUser=null,expires=null)=>Number(sql.prepare('INSERT INTO store_coupons(code,kind,value,created_ms,total_limit,user_limit,expires_ms) VALUES(?,?,?,0,?,?,?)').run(code,kind,value,total,perUser,expires).lastInsertRowid);
 return {env,sql,order,coupon};
}
test('percent and fixed coupons cap discount and combine with referral',async()=>{
 const f=fixture();f.coupon('PCT','percent',25);f.coupon('FIX','fixed',500);const a=f.order(2,101),b=f.order(3,100);
 await applyCoupon(f.env,a,2,'pct',1000);await applyCoupon(f.env,b,3,'FIX',1000);
 assert.deepEqual({...f.sql.prepare('SELECT discount,final_price FROM orders WHERE id=?').get(a)},{discount:25,final_price:76});assert.equal(f.sql.prepare('SELECT final_price FROM orders WHERE id=?').get(b).final_price,0);
 const c=f.order(4);const gift=f.sql.prepare("INSERT INTO discounts(user_id,amount,used,created_at) VALUES(4,10,0,'today')").run();f.sql.prepare("INSERT INTO store_order_referrals(order_id,discount_id,user_id,amount,state) VALUES(?,?,4,10,'reserved')").run(c,gift.lastInsertRowid);await applyCoupon(f.env,c,4,'PCT',1000);assert.deepEqual({...f.sql.prepare('SELECT discount,final_price FROM orders WHERE id=?').get(c)},{discount:32,final_price:68});
});
test('concurrent reservations enforce total and per-user limits',async()=>{
 const f=fixture();f.coupon('ONCE','fixed',10,1,1);const a=f.order(2),b=f.order(3);
 const result=await Promise.allSettled([applyCoupon(f.env,a,2,'ONCE',1000),applyCoupon(f.env,b,3,'ONCE',1000)]);assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM store_coupon_uses WHERE state='reserved'").get().n,1);
 const g=fixture();g.coupon('USER','fixed',10,null,1);const x=g.order(2),y=g.order(2),z=g.order(3);await applyCoupon(g.env,x,2,'USER',1000);await assert.rejects(applyCoupon(g.env,y,2,'USER',1000),/سهمیه/);await applyCoupon(g.env,z,3,'USER',1000);
});
test('expiry and cancellation release capacity and invalidate stale invoice',async()=>{
 const f=fixture();f.coupon('ONCE','fixed',10,1);const a=f.order(2),b=f.order(3);await applyCoupon(f.env,a,2,'ONCE',1000);await expireCouponReservations(f.env,1000+COUPON_HOLD_MS);
 assert.equal(f.sql.prepare('SELECT status FROM orders WHERE id=?').get(a).status,'cancelled');await applyCoupon(f.env,b,3,'ONCE',1000+COUPON_HOLD_MS);await cancelDraftOrder(f.env,b,3);
 assert.equal(f.sql.prepare('SELECT status FROM orders WHERE id=?').get(b).status,'cancelled');assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM store_coupon_uses WHERE state='reserved'").get().n,0);
});
test('pending paid receipt remains reserved until final decision',async()=>{
 const f=fixture();f.coupon('ONE','fixed',10,1);const a=f.order(2),b=f.order(3);await applyCoupon(f.env,a,2,'ONE',1000);f.sql.prepare("UPDATE orders SET status='pending' WHERE id=?").run(a);await expireCouponReservations(f.env,1000+COUPON_HOLD_MS);
 await assert.rejects(applyCoupon(f.env,b,3,'ONE',1000+COUPON_HOLD_MS),/ظرفیت/);
 f.sql.prepare("UPDATE orders SET status='rejected' WHERE id=?").run(a);f.sql.prepare("UPDATE store_coupon_uses SET state='released' WHERE order_id=?").run(a);await applyCoupon(f.env,b,3,'ONE',1000+COUPON_HOLD_MS);
});
test('wallet settlement consumes coupon, failed payment releases it and refunds funds',async()=>{
 for(const outcome of ['settled','refunded']){const f=fixture();f.coupon('ONE','fixed',10,1);const a=f.order(2);await adjustWallet(f.env,2,100,1,'seed');await applyCoupon(f.env,a,2,'ONE');assert.equal(await reserveWalletPayment(f.env,a,2),true);assert.equal(await walletBalance(f.env,2),10);assert.equal(await completeWalletPayment(f.env,a,outcome,true),true);assert.equal(f.sql.prepare('SELECT state FROM store_coupon_uses').get().state,outcome==='settled'?'consumed':'released');assert.equal(await walletBalance(f.env,2),outcome==='settled'?10:100)}
});
test('coupon validity and zero-cost order are safely enforced',async()=>{
 const f=fixture();f.coupon('EXPIRED','percent',100,null,null,900);const a=f.order(2);await assert.rejects(applyCoupon(f.env,a,2,'EXPIRED',1000),/معتبر/);
 f.coupon('FREE','percent',100);await applyCoupon(f.env,a,2,'FREE');assert.equal(await reserveWalletPayment(f.env,a,2),true);assert.equal(await completeWalletPayment(f.env,a,'settled'),true);assert.equal(await walletBalance(f.env,2),0);assert.equal(f.sql.prepare('SELECT state FROM store_coupon_uses').get().state,'consumed');
});

test('expired needs-fix coupon cancels invoice and rejects stale wallet payment',async()=>{
 const f=fixture();f.coupon('CODE','fixed',10,1);const a=f.order(2);await applyCoupon(f.env,a,2,'CODE');f.sql.prepare("UPDATE orders SET status='needs_fix' WHERE id=?").run(a);await expireCouponReservations(f.env,Date.now()+COUPON_HOLD_MS+1);assert.equal(f.sql.prepare('SELECT status FROM orders WHERE id=?').get(a).status,'cancelled');assert.equal(await reserveWalletPayment(f.env,a,2),false);assert.equal(f.sql.prepare('SELECT state FROM store_coupon_uses').get().state,'released');
});

test('per-user usage counts completed purchases and other users remain eligible',async()=>{
 const f=fixture();f.coupon('LIMIT','fixed',10,null,1);const a=f.order(2),b=f.order(2),c=f.order(3);await applyCoupon(f.env,a,2,'LIMIT');f.sql.prepare("UPDATE orders SET status='approved' WHERE id=?").run(a);f.sql.prepare("UPDATE store_coupon_uses SET state='consumed' WHERE order_id=?").run(a);
 await assert.rejects(applyCoupon(f.env,b,2,'LIMIT'),/سهمیه/);await applyCoupon(f.env,c,3,'LIMIT');
});
test('disabled or deleted codes cannot create reservations',async()=>{
 const f=fixture();const id=f.coupon('OFF','fixed',10);const a=f.order(2);f.sql.prepare('UPDATE store_coupons SET enabled=0 WHERE id=?').run(id);await assert.rejects(applyCoupon(f.env,a,2,'OFF'),/فعال/);f.sql.prepare('UPDATE store_coupons SET enabled=1,deleted=1 WHERE id=?').run(id);await assert.rejects(applyCoupon(f.env,a,2,'OFF'),/فعال/);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM store_coupon_uses').get().n,0);
});

test('legacy discounted invoice with no provable referral link is left unchanged',async()=>{
 const f=fixture();f.coupon('CODE','fixed',10);const id=f.order(2);f.sql.prepare('UPDATE orders SET discount=20,final_price=80 WHERE id=?').run(id);await assert.rejects(applyCoupon(f.env,id,2,'CODE'),/قدیمی/);assert.deepEqual({...f.sql.prepare('SELECT discount,final_price FROM orders WHERE id=?').get(id)},{discount:20,final_price:80});assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM store_coupon_uses').get().n,0);
});

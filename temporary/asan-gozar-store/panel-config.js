// Credentials remain encrypted with a dedicated AES-GCM key.
const enc = new TextEncoder(), dec = new TextDecoder();
const as64 = b => btoa(String.fromCharCode(...b));
const from64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function keyFor(token) {
  if (!token) throw new Error('کلید رمزنگاری فروشگاه تنظیم نشده است.');
  const material = await crypto.subtle.importKey('raw', enc.encode(token), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:enc.encode('asan-gozar-store-panel-credentials-v1'),info:enc.encode('AES-256-GCM')}, material, {name:'AES-GCM',length:256}, false, ['encrypt','decrypt']);
}
export async function encryptPanel(token, value) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},await keyFor(token),enc.encode(JSON.stringify(value)));
  return JSON.stringify({v:1,iv:as64(iv),data:as64(new Uint8Array(ciphertext))});
}
export async function decryptPanel(token, stored) {
  const payload=JSON.parse(stored);
  if(payload.v!==1 || typeof payload.iv!=='string' || typeof payload.data!=='string')throw new Error('اطلاعات رمزگذاری‌شده نامعتبر است.');
  const data=await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(payload.iv)},await keyFor(token),from64(payload.data));
  return JSON.parse(dec.decode(data));
}
export function panelURL(value) {
  let u; try {u=new URL(value);} catch {throw new Error('آدرس معتبر نیست.');}
  const secure = u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(u.hostname));
  if(!secure || u.username || u.password || u.search || u.hash || !u.hostname || value.length>2048) throw new Error('آدرس باید HTTPS و بدون اطلاعات ورود، پارامتر یا # باشد. HTTP فقط برای لوپ‌بک مجاز است.');
  return u.origin + u.pathname.replace(/\/+$/, '');
}
export async function panelAccountKey(url, user) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify([panelURL(url), user]))));
  return Array.from(hash, b=>b.toString(16).padStart(2,'0')).join('');
}
export async function probePanel(config) {
  const base=panelURL(config.url);
  const options={redirect:'error',signal:AbortSignal.timeout(15000)};
  let r,j;
  try {
    r=await fetch(base+'/login',{...options,method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:new URLSearchParams({username:config.user,password:config.pass}).toString()});
    j=await r.json();
  } catch {throw new Error('ارتباط یا پاسخ ورود پنل ناموفق بود.');}
  if(!r.ok || !j?.success) throw new Error(j?.obj?.twoFactorRequired ? 'ورود خودکار با حساب دارای تأیید دومرحله‌ای پشتیبانی نمی‌شود.' : 'ورود به پنل ناموفق بود؛ آدرس و اطلاعات حساب را بررسی کنید.');
  const raw=typeof r.headers.getSetCookie==='function'?r.headers.getSetCookie():[r.headers.get('set-cookie')||''];
  const cookie=raw.map(x=>x.split(';')[0]).filter(x=>x.startsWith('vpn-ui=')).join('; ');
  if(!cookie)throw new Error('پنل کوکی نشست معتبر نداد.');
  async function get(path){
    let response,result; try {response=await fetch(base+path,{...options,headers:{cookie,'X-Requested-With':'XMLHttpRequest'}});result=await response.json();}catch{throw new Error('خواندن گروه‌ها و ورودی‌های پنل ناموفق بود.');}
    if(!response.ok || !result?.success || !Array.isArray(result.obj))throw new Error('خواندن گروه‌ها یا ورودی‌ها مجاز نیست؛ مجوز حساب را بررسی کنید.');
    return result.obj;
  }
  const [groups,inbounds]=await Promise.all([get('/panel/api/clients/groups'),get('/panel/api/clients/assignable')]);
  return {groups,inbounds};
}

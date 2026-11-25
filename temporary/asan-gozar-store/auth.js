import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const dummy = { salt: '00000000000000000000000000000000', password_hash: Buffer.alloc(64) };
let running = 0;

export const validUsername = value => /^[a-z][a-z0-9_]{2,31}$/.test(value);
export const validPassword = value => typeof value === 'string' &&
  value.length >= 14 && Buffer.byteLength(value) <= 256 && !/[\r\n\x00]/.test(value);

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  if (running >= 2) throw new Error('password queue busy');
  running++;
  try {
    const password_hash = await derive(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 ** 2 });
    return { salt, password_hash };
  } finally { running--; }
}

export async function checkPassword(password, account) {
  const saved = account || dummy;
  const result = await hashPassword(password, saved.salt);
  return timingSafeEqual(Buffer.from(saved.password_hash), result.password_hash) && Boolean(account);
}

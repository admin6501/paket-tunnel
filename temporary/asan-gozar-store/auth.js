import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const dummy = { salt: '00000000000000000000000000000000', password_hash: Buffer.alloc(64) };
let running = 0;

export const validUsername = value => /^[a-z][a-z0-9_]{2,31}$/.test(value);
const validPasswordInput = value => typeof value === 'string' && Buffer.byteLength(value) <= 256 && !/[\r\n\x00]/.test(value);
export const validPassword = value => validPasswordInput(value) && [...value].length >= 8;

// Existing passwords could satisfy the old 14-character rule in UTF-16 code units.
export const validStoredPassword = value => validPasswordInput(value) && (value.length >= 14 || [...value].length >= 8);

export function displayName(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value)) return null;
  const name = value.normalize('NFC').trim();
  return name.length >= 2 && name.length <= 80 ? name : null;
}

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

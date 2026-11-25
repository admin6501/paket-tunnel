import { openStore } from './database.mjs';
import { hashPassword, validPassword, validUsername } from './auth.js';

process.umask(0o077);
const [operation, rawUsername, displayName] = process.argv.slice(2);
const username = (rawUsername || '').toLowerCase();
if (!['owner','reset'].includes(operation) || !validUsername(username) ||
    (operation === 'owner' && (!displayName || displayName.length < 2 || displayName.length > 80 || /[\x00-\x1f]/.test(displayName)))) {
  throw new Error('Usage: node account.mjs owner USER DISPLAY_NAME, or node account.mjs reset USER. Read the password through stdin.');
}
let password = '';
for await (const chunk of process.stdin.setEncoding('utf8')) {
  password += chunk;
  if (Buffer.byteLength(password) > 258) throw new Error('Password is too long.');
}
password = password.replace(/\r?\n$/, '');
if (!validPassword(password)) throw new Error('Use at least 14 characters and at most 256 UTF-8 bytes.');
const { salt, password_hash } = await hashPassword(password);
const { sqlite } = openStore(process.env.STORE_DATABASE || '/var/lib/asan-gozar-store/store.sqlite');
try {
  if (operation === 'owner') {
    const result = sqlite.prepare('INSERT INTO store_accounts(username,display_name,salt,password_hash,owner,created_at) VALUES(?,?,?,?,1,?) ON CONFLICT(username) DO NOTHING')
      .run(username, displayName, salt, password_hash, Date.now());
    if (!result.changes) throw new Error('This username already exists. Choose a new owner username or use reset.');
  } else {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const account = sqlite.prepare('UPDATE store_accounts SET salt=?,password_hash=? WHERE username=? RETURNING id').get(salt, password_hash, username);
      if (!account) throw new Error('Account not found.');
      sqlite.prepare('UPDATE web_shop_sessions SET expires_at=? WHERE user_id=?').run(Date.now(), account.id);
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  console.log('Account saved.');
} finally { sqlite.close(); }

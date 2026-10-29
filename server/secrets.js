// Encrypts secrets (external AI providers' API keys) before they're stored in the database, so a
// copy of the .sqlite file alone — a backup, say — doesn't expose them. AES-256-GCM with a random
// key kept in data/secret.key, next to the database: moving the data folder to another machine
// keeps the keys usable, while the key file itself is never committed (see .gitignore).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KEY_PATH = process.env.AMERB_SECRET_KEY_PATH || path.join(__dirname, '..', 'data', 'secret.key');

let cachedKey = null;

function encryptionKey() {
  if (cachedKey) return cachedKey;
  if (fs.existsSync(KEY_PATH)) {
    cachedKey = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'hex');
  } else {
    cachedKey = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
    fs.writeFileSync(KEY_PATH, cachedKey.toString('hex'), { mode: 0o600 });
  }
  return cachedKey;
}

function encryptSecret(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptSecret(stored) {
  const [version, iv, tag, data] = String(stored).split(':');
  if (version !== 'v1') throw new Error('Unknown secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// "sk-...abcd" — enough for an admin to tell keys apart, never enough to use one.
function maskSecret(plainText) {
  const s = String(plainText || '');
  return s.length <= 8 ? '••••' : `${s.slice(0, 3)}…${s.slice(-4)}`;
}

module.exports = { encryptSecret, decryptSecret, maskSecret };

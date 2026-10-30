const crypto = require('crypto');

function key() {
  const value = process.env.TOKEN_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.');
  return Buffer.from(value, 'hex');
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(x => x.toString('base64')).join('.');
}
function decrypt(value) {
  const [iv, tag, body] = String(value).split('.');
  if (!iv || !tag || !body) throw new Error('Stored OAuth token payload is malformed.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8'));
}
function randomToken(bytes = 24) { return crypto.randomBytes(bytes).toString('hex'); }
function b64url(value) { return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function decodeB64url(value = '') {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
module.exports = { encrypt, decrypt, randomToken, b64url, decodeB64url, sha256 };

const { google } = require('googleapis');
const { decrypt, b64url, decodeB64url } = require('./security');
const { EmailConnection } = require('../models');

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly'
];

function createOAuthClient() {
  const required = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing Google OAuth configuration: ${missing.join(', ')}`);
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
}
async function getConnection(userId) {
  const connection = await EmailConnection.findOne({ userId });
  if (!connection) throw new Error('Connect Gmail before using this feature.');
  const auth = createOAuthClient();
  auth.setCredentials(decrypt(connection.encryptedTokens));
  auth.on('tokens', async tokens => {
    try {
      const current = decrypt(connection.encryptedTokens);
      await EmailConnection.updateOne({ _id: connection._id }, { $set: { encryptedTokens: require('./security').encrypt({ ...current, ...tokens }) } });
    } catch (error) { console.error('[gmail] token refresh persistence failed:', error.message); }
  });
  return { connection, auth, gmail: google.gmail({ version: 'v1', auth }) };
}
function headerMap(payload) {
  const result = {};
  for (const item of payload?.headers || []) result[String(item.name || '').toLowerCase()] = item.value || '';
  return result;
}
function decodePart(data) { return data ? decodeB64url(data) : ''; }
function collectBodies(payload, out = { text: [], html: [], dsn: [] }) {
  if (!payload) return out;
  const mime = String(payload.mimeType || '').toLowerCase();
  if (payload.body?.data) {
    const decoded = decodePart(payload.body.data);
    if (mime === 'text/plain') out.text.push(decoded);
    else if (mime === 'text/html') out.html.push(decoded);
    else if (mime === 'message/delivery-status' || mime === 'text/rfc822-headers') out.dsn.push(decoded);
  }
  for (const part of payload.parts || []) collectBodies(part, out);
  return out;
}
function stripHtml(html) {
  return String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}
function decodeBase64Mime(raw) {
  const normalized = String(raw || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}
function wrapBase64(value) { return Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || ''; }
function buildMime({ from, to, subject, html, text, inReplyTo, references }) {
  const boundary = `bluecode_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const headers = [
    `From: ${from}`, `To: ${to}`, `Subject: ${String(subject || '').replace(/[\r\n]/g, ' ')}`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  const body = [
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrapBase64(text || stripHtml(html)),
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrapBase64(html || `<pre>${String(text || '')}</pre>`),
    `--${boundary}--`, ''
  ].join('\r\n');
  return b64url(`${headers.join('\r\n')}\r\n\r\n${body}`);
}
module.exports = { SCOPES, createOAuthClient, getConnection, headerMap, collectBodies, stripHtml, decodeBase64Mime, buildMime };

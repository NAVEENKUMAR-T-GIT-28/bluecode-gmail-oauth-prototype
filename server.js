require('dotenv').config();
const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');
const { EmailConnection, EmailLog, EmailReply, ProcessedMessage } = require('./models');
const { encrypt, decrypt, randomToken, sha256 } = require('./lib/security');
const { SCOPES, createOAuthClient, getConnection, headerMap, collectBodies, stripHtml, decodeBase64Mime, buildMime } = require('./lib/gmail');
const { BASE, addEvent, instrumentHtml, gifBytes, recordOpen, recordClick } = require('./lib/tracking');

const app = express();
const PORT = Number(process.env.PORT || 5000);
const SYNC_INTERVAL = Math.max(15000, Number(process.env.GMAIL_SYNC_INTERVAL_MS || 60000));
const SYNC_MAX = Math.max(10, Math.min(100, Number(process.env.GMAIL_SYNC_MAX_MESSAGES || 50)));

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(session({
  name: 'bluecode.sid',
  secret: process.env.SESSION_SECRET || 'development-only-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.SESSION_COOKIE_SECURE === 'true', maxAge: 7 * 86400000 }
}));
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: '1h' }));

// DEMO ONLY: replace this function with your BlueCode OS authentication middleware.
// It must return the immutable internal account/user ID, never an email supplied by the browser.
function getUserId(req) { return req.session.userId || (process.env.DEMO_USER_ID || 'demo-user-001'); }
function requireUser(req, res, next) {
  req.userId = getUserId(req);
  if (!req.userId) return res.status(401).json({ error: 'Authentication required.' });
  next();
}
app.use('/api', requireUser);
function oauthClient() { return createOAuthClient(); }
function safeMessage(error) {
  const message = String(error?.message || 'Unexpected server error');
  if (/invalid_grant|insufficient permission|insufficient authentication scopes/i.test(message)) return 'Gmail authorization needs to be renewed. Disconnect Gmail, reconnect and approve the requested read/send permissions.';
  return message;
}
function parseAddress(value = '') {
  const match = String(value).match(/(?:^|\s)([^<>\s]+@[^<>\s]+\.[^<>\s]+)(?:$|\s)/);
  return (match?.[1] || String(value).replace(/^.*<|>.*$/g, '')).trim().toLowerCase();
}
function normalizeMessageId(value = '') { return String(value).replace(/[<>]/g, '').trim().toLowerCase(); }
function parseDate(value, fallback) { const d = value ? new Date(Number(value) * 1000) : fallback; return Number.isNaN(d?.getTime?.()) ? fallback : d; }

// OAuth connect: state is one-time and bound to the current session.
app.get('/auth/google', (req, res) => {
  try {
    const state = randomToken(24);
    req.session.oauthState = state;
    res.redirect(oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', include_granted_scopes: true, scope: SCOPES, state }));
  } catch (e) { res.status(500).send(safeMessage(e)); }
});
app.get('/auth/google/callback', async (req, res) => {
  try {
    if (!req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send('OAuth state validation failed. Start the connection flow again.');
    delete req.session.oauthState;
    if (req.query.error) return res.redirect('/?oauth=denied');
    const oauth = oauthClient();
    const { tokens } = await oauth.getToken(String(req.query.code || ''));
    oauth.setCredentials(tokens);
    const userInfo = await google.oauth2({ version: 'v2', auth: oauth }).userinfo.get();
    const email = String(userInfo.data.email || '').toLowerCase();
    if (!email) throw new Error('Google did not return an email address.');
    const userId = getUserId(req);
    const existing = await EmailConnection.findOne({ userId });
    const previousTokens = existing ? decrypt(existing.encryptedTokens) : {};
    const mergedTokens = { ...previousTokens, ...tokens };
    if (!mergedTokens.refresh_token && previousTokens.refresh_token) mergedTokens.refresh_token = previousTokens.refresh_token;
    await EmailConnection.findOneAndUpdate({ userId }, {
      userId, email, encryptedTokens: encrypt(mergedTokens), scopes: SCOPES, connectedAt: new Date(), lastSyncError: ''
    }, { upsert: true, new: true });
    res.redirect('/?oauth=connected');
  } catch (e) { console.error('[oauth] callback:', e.message); res.status(500).send(`Gmail connection failed: ${safeMessage(e)}`); }
});

app.get('/api/connection', async (req, res) => {
  const c = await EmailConnection.findOne({ userId: req.userId }).lean();
  res.json({ connected: !!c, email: c?.email || null, lastSyncAt: c?.lastSyncAt || null, lastSyncError: c?.lastSyncError || null, requestedScopes: SCOPES });
});
app.post('/api/disconnect', async (req, res) => {
  const c = await EmailConnection.findOne({ userId: req.userId });
  if (c) {
    try { const auth = oauthClient(); auth.setCredentials(decrypt(c.encryptedTokens)); await auth.revokeCredentials(); }
    catch (e) { console.warn('[oauth] token revoke warning:', e.message); }
    await EmailConnection.deleteOne({ _id: c._id });
  }
  res.json({ ok: true });
});

app.post('/api/send', async (req, res) => {
  let log;
  try {
    const to = String(req.body?.to || '').trim().toLowerCase();
    const subject = String(req.body?.subject || '').trim();
    const textBody = String(req.body?.body || '').trim();
    const htmlInput = String(req.body?.html || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'Enter a valid recipient email address.' });
    if (!subject || !textBody && !htmlInput) return res.status(400).json({ error: 'Subject and message body are required.' });
    const { connection, gmail } = await getConnection(req.userId);
    log = await EmailLog.create({ userId: req.userId, sender: connection.email, recipient: to, subject, textBody, status: 'SENDING', trackingToken: randomToken(24), events: [] });
    await addEvent(log, 'SENDING', 'Message handed to Gmail API for submission.', 'system');
    const built = instrumentHtml(htmlInput || '', log);
    const html = built.html;
    const raw = buildMime({ from: connection.email, to, subject, html, text: textBody });
    const sent = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    log.gmailMessageId = sent.data.id || '';
    log.gmailThreadId = sent.data.threadId || '';
    await addEvent(log, 'SUBMITTED', 'Gmail API accepted the send request. This is not proof of recipient delivery.', 'gmail_api');
    try {
      const meta = await gmail.users.messages.get({ userId: 'me', id: sent.data.id, format: 'metadata', metadataHeaders: ['Message-ID'] });
      const headers = headerMap(meta.data.payload);
      log.rfcMessageId = normalizeMessageId(headers['message-id']);
    } catch (e) { console.warn('[mail] sent metadata unavailable:', e.message); }
    await log.save();
    res.status(202).json({ ok: true, id: log._id, status: log.status, sender: connection.email, recipient: to, tracking: { pixelIncluded: true, trackedLinks: log.trackedLinks.length } });
  } catch (e) {
    console.error('[mail] send error:', e.message);
    if (log && !log.gmailMessageId) { log.status = 'SEND_FAILED'; await addEvent(log, 'SEND_FAILED', safeMessage(e), 'gmail_api'); await log.save().catch(() => {}); }
    res.status(500).json({ error: safeMessage(e) });
  }
});

app.get('/api/emails', async (req, res) => {
  const logs = await EmailLog.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(200).lean();
  res.json(logs);
});
app.get('/api/emails/:id', async (req, res) => {
  const log = await EmailLog.findOne({ _id: req.params.id, userId: req.userId }).lean();
  if (!log) return res.status(404).json({ error: 'Email record not found.' });
  const replies = await EmailReply.find({ userId: req.userId, emailLogId: log._id }).sort({ receivedAt: 1 }).lean();
  res.json({ email: log, replies });
});
app.get('/api/replies', async (req, res) => {
  const query = { userId: req.userId };
  if (req.query.unread === 'true') query.isRead = false;
  const replies = await EmailReply.find(query).sort({ receivedAt: -1 }).limit(200).lean();
  res.json(replies);
});
app.post('/api/replies/:id/read', async (req, res) => {
  const reply = await EmailReply.findOneAndUpdate({ _id: req.params.id, userId: req.userId }, { $set: { isRead: true } }, { new: true });
  if (!reply) return res.status(404).json({ error: 'Reply not found.' });
  res.json({ ok: true });
});

function parseDsn(text) {
  const lines = String(text || '').split(/\r?\n/);
  const get = name => { const prefix = `${name.toLowerCase()}:`; const line = lines.find(x => x.toLowerCase().startsWith(prefix)); return line ? line.slice(prefix.length).trim() : ''; };
  const status = get('Status');
  const action = get('Action').toLowerCase();
  const finalRecipient = (get('Final-Recipient') || get('Original-Recipient')).split(';').pop().trim().toLowerCase();
  const originalMessageId = normalizeMessageId(get('Original-Message-ID'));
  const diagnostic = get('Diagnostic-Code');
  return { status, action, finalRecipient, originalMessageId, diagnostic, isAddressMissing: /^5\.1\.1\b/.test(status) || /5\.1\.1|user unknown|mailbox.*not found|address.*not found|no such user/i.test(diagnostic) };
}
async function matchOriginalEmail(userId, { threadId, inReplyTo, references, from, subject }) {
  const ids = [inReplyTo, ...(String(references || '').match(/<[^>]+>/g) || [])].map(normalizeMessageId).filter(Boolean);
  let match = null;
  if (ids.length) match = await EmailLog.findOne({ userId, rfcMessageId: { $in: ids } }).sort({ createdAt: -1 });
  if (!match && threadId) match = await EmailLog.findOne({ userId, gmailThreadId: threadId }).sort({ createdAt: -1 });
  if (!match && from) {
    const candidates = await EmailLog.find({ userId, recipient: parseAddress(from), subject }).sort({ createdAt: -1 }).limit(2);
    if (candidates.length === 1) match = candidates[0];
  }
  return match;
}
async function processBounce(gmail, userId, message) {
  const headers = headerMap(message.payload);
  const from = headers.from || '';
  const subject = headers.subject || '';
  const bodies = collectBodies(message.payload);
  const combined = `${subject}\n${message.snippet || ''}\n${bodies.dsn.join('\n')}\n${bodies.text.join('\n')}`;
  if (!/mailer-daemon|mail-delivery-subsystem|delivery status notification|undeliverable|delivery failure|address not found/i.test(`${from} ${subject}`)) return false;
  const dsn = parseDsn(combined);
  let original = null;
  if (dsn.originalMessageId) original = await EmailLog.findOne({ userId, rfcMessageId: dsn.originalMessageId });
  if (!original && dsn.finalRecipient) {
    const recent = await EmailLog.find({ userId, recipient: dsn.finalRecipient, createdAt: { $gte: new Date(Date.now() - 45 * 86400000) } }).sort({ createdAt: -1 }).limit(2);
    if (recent.length === 1) original = recent[0];
  }
  if (!original) return false;
  const code = dsn.status || (dsn.diagnostic.match(/\b[245]\.\d\.\d\b/) || [])[0] || '';
  const dsnKey = `dsn:${message.id}:${original._id}`;
  if (dsn.action === 'delivered' || /^2\./.test(dsn.status)) {
    await addEvent(original, 'DELIVERED', `Gmail DSN reports recipient-server delivery (${code || dsn.action}).`, 'gmail_dsn', { dedupeKey: dsnKey });
    original.deliveryEvidence = 'Gmail delivery-status notification (Action: delivered)';
  } else if (dsn.action === 'failed' || /^5\./.test(dsn.status) || dsn.isAddressMissing) {
    const type = dsn.isAddressMissing ? 'ADDRESS_NOT_FOUND' : 'BOUNCED';
    await addEvent(original, type, `Gmail delivery-status message: ${dsn.diagnostic || subject || 'Delivery failure'}`, 'gmail_dsn', { dedupeKey: dsnKey });
    original.bounceCode = code;
    original.bounceReason = (dsn.diagnostic || subject || 'Delivery failure').slice(0, 1000);
    original.deliveryEvidence = 'Gmail delivery-status notification (failure)';
  } else if (dsn.action === 'delayed' || /^4\./.test(dsn.status)) {
    await addEvent(original, 'DELIVERY_DEFERRED', `Gmail DSN reports a temporary delay (${code || dsn.action}).`, 'gmail_dsn', { dedupeKey: dsnKey });
  } else {
    return false;
  }
  await original.save();
  return true;
}
async function syncMailbox(userId, { maxResults = SYNC_MAX } = {}) {
  const { gmail, connection } = await getConnection(userId);
  const listed = await gmail.users.messages.list({ userId: 'me', q: 'in:anywhere newer_than:45d', maxResults: Math.min(100, maxResults) });
  const items = listed.data.messages || [];
  let scanned = 0, repliesAdded = 0, bouncesMatched = 0, skipped = 0;
  for (const item of items) {
    const already = await ProcessedMessage.exists({ userId, gmailMessageId: item.id });
    if (already) { skipped++; continue; }
    try {
      const response = await gmail.users.messages.get({ userId: 'me', id: item.id, format: 'full' });
      const msg = response.data;
      const headers = headerMap(msg.payload);
      const sender = parseAddress(headers.from || '');
      const subject = headers.subject || '';
      const fromSelf = sender === connection.email.toLowerCase();
      const bodies = collectBodies(msg.payload);
      const text = bodies.text.join('\n').trim() || stripHtml(bodies.html.join('\n'));
      const html = bodies.html.join('\n');
      const internalDate = parseDate(msg.internalDate, new Date());
      const isBounce = await processBounce(gmail, userId, msg);
      if (isBounce) bouncesMatched++;
      else if (!fromSelf && sender) {
        const original = await matchOriginalEmail(userId, {
          threadId: msg.threadId,
          inReplyTo: headers['in-reply-to'],
          references: headers.references,
          from: headers.from,
          subject: subject.replace(/^\s*(re|fw|fwd)\s*:\s*/i, '').trim()
        });
        if (original) {
          await EmailReply.updateOne({ userId, gmailMessageId: msg.id }, { $setOnInsert: {
            userId, emailLogId: original._id, gmailMessageId: msg.id, gmailThreadId: msg.threadId || '',
            rfcMessageId: normalizeMessageId(headers['message-id']), inReplyTo: normalizeMessageId(headers['in-reply-to']),
            references: headers.references || '', from: headers.from || sender, to: headers.to || connection.email,
            subject, text, html, receivedAt: internalDate, snippet: msg.snippet || ''
          } }, { upsert: true });
          original.repliedAt = original.repliedAt || internalDate;
          await addEvent(original, 'REPLIED', `Reply received from ${sender}`, 'gmail_sync', { dedupeKey: `reply:${msg.id}` });
          await original.save();
          repliesAdded++;
        }
      }
      await ProcessedMessage.updateOne({ userId, gmailMessageId: msg.id }, { $setOnInsert: { userId, gmailMessageId: msg.id, kind: isBounce ? 'bounce' : 'scanned' } }, { upsert: true });
      scanned++;
    } catch (error) {
      // Do not mark failed fetches as processed; the next sync can retry them.
      console.warn('[gmail-sync] message failed:', item.id, error.message);
    }
  }
  connection.lastSyncAt = new Date();
  connection.lastSyncError = '';
  if (listed.data.historyId) connection.gmailHistoryId = String(listed.data.historyId);
  await connection.save();
  return { ok: true, messagesScanned: scanned, repliesAdded, bounceMessagesMatched: bouncesMatched, alreadyProcessed: skipped, lastSyncAt: connection.lastSyncAt };
}
app.post('/api/gmail/sync', async (req, res) => {
  try { res.json(await syncMailbox(req.userId, { maxResults: Number(req.body?.maxResults || SYNC_MAX) })); }
  catch (e) { console.error('[gmail-sync] error:', e.message); await EmailConnection.updateOne({ userId: req.userId }, { $set: { lastSyncError: e.message } }); res.status(500).json({ error: safeMessage(e) }); }
});
app.post('/api/email/sync-delivery', async (req, res) => {
  try { const result = await syncMailbox(req.userId); res.json({ ...result, note: 'Only matched DSN evidence is used for bounce classification. No bounce notification is not proof of delivery.' }); }
  catch (e) { res.status(500).json({ error: safeMessage(e) }); }
});
app.post('/api/replies/:id/send', async (req, res) => {
  try {
    const reply = await EmailReply.findOne({ _id: req.params.id, userId: req.userId });
    if (!reply) return res.status(404).json({ error: 'Conversation not found.' });
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Reply message cannot be empty.' });
    const { connection, gmail } = await getConnection(req.userId);
    const to = parseAddress(reply.from);
    const subject = /^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`;
    const raw = buildMime({ from: connection.email, to, subject, text: body, html: `<div style="font:14px/1.6 Arial,sans-serif;white-space:pre-wrap">${body.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</div>`, inReplyTo: reply.rfcMessageId, references: [reply.references, reply.rfcMessageId].filter(Boolean).join(' ') });
    const sent = await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId: reply.gmailThreadId } });
    res.status(202).json({ ok: true, gmailMessageId: sent.data.id, threadId: sent.data.threadId });
  } catch (e) { res.status(500).json({ error: safeMessage(e) }); }
});

app.get('/track/open/:token.gif', async (req, res) => {
  try { await recordOpen(req.params.token, req.get('user-agent') || ''); }
  catch (e) { console.error('[tracking] open:', e.message); }
  const bytes = gifBytes();
  res.status(200).set({ 'Content-Type':'image/gif', 'Content-Length':String(bytes.length), 'Cache-Control':'no-store, no-cache, must-revalidate, private, max-age=0', 'Pragma':'no-cache', 'X-Content-Type-Options':'nosniff' }).end(bytes);
});
app.get('/track/click/:token/:linkId', async (req, res) => {
  try {
    const destination = await recordClick(req.params.token, req.params.linkId, req.get('user-agent') || '');
    if (!destination) return res.status(404).send('Tracking link not found.');
    res.redirect(302, destination);
  } catch (e) { console.error('[tracking] click:', e.message); res.status(500).send('Unable to process tracked link.'); }
});
app.get('/track/ping', (req, res) => res.type('text/plain').set('Cache-Control','no-store').send('BlueCode OS tracking endpoint is reachable.'));
app.get('/api/tracking/diagnostics', (req, res) => res.json({ ok: true, publicTrackingUrl: BASE(), pixelExample: `${BASE()}/track/open/{token}.gif`, clickExample: `${BASE()}/track/click/{token}/{linkId}` }));
app.get('/health', (req, res) => res.json({ ok: true, service: 'bluecode-os-email-lifecycle' }));

// Development poller: processes each connected account. Use a durable job queue in production.
let syncBusy = false;
async function runPeriodicSync() {
  if (syncBusy || mongoose.connection.readyState !== 1) return;
  syncBusy = true;
  try {
    const connections = await EmailConnection.find({}).select('userId').lean();
    for (const c of connections) {
      try { await syncMailbox(c.userId); }
      catch (e) { console.warn('[gmail-sync] periodic sync failed:', c.userId, e.message); await EmailConnection.updateOne({ userId: c.userId }, { $set: { lastSyncError: e.message } }); }
    }
  } finally { syncBusy = false; }
}
async function start() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required.');
  await mongoose.connect(process.env.MONGO_URI);
  // Compatibility migration for lifecycle records created by the earlier lowercase-status prototype.
  const legacyStatuses = { submitted: 'SUBMITTED', delivered: 'DELIVERED', opened: 'OPENED', clicked: 'CLICKED', bounced: 'BOUNCED', send_failed: 'SEND_FAILED' };
  for (const [oldStatus, newStatus] of Object.entries(legacyStatuses)) {
    await EmailLog.updateMany({ status: oldStatus }, { $set: { status: newStatus } });
  }
  console.log('[db] MongoDB connected');
  app.listen(PORT, () => console.log(`[server] BlueCode OS email lifecycle: http://localhost:${PORT}\n[tracking] ${BASE()}`));
  setInterval(runPeriodicSync, SYNC_INTERVAL).unref();
}
start().catch(error => { console.error('[startup]', error); process.exit(1); });

module.exports = { app, syncMailbox, parseDsn, matchOriginalEmail };

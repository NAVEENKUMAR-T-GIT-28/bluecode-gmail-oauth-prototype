require("dotenv").config();

const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const crypto = require("crypto");
const path = require("path");
const { google } = require("googleapis");

const app = express();
const PORT = Number(process.env.PORT || 5000);
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
  // Added only to let the connected owner inspect their own mailbox for DSN/bounce notices.
  "https://www.googleapis.com/auth/gmail.readonly"
];
const DEMO_USER_ID = process.env.DEMO_USER_ID || "demo-user-001";
const TRACKING_BASE = () => (process.env.PUBLIC_TRACKING_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

app.use(express.json({ limit: "1mb" }));
app.use(session({
  secret: process.env.SESSION_SECRET || "local-only-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

const connectionSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  email: { type: String, required: true },
  encryptedTokens: { type: String, required: true },
  connectedAt: { type: Date, default: Date.now },
  lastBounceSyncAt: Date,
  gmailHistoryId: String
});

const eventSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ["submitted", "delivered", "bounced", "opened", "clicked", "send_failed"],
    required: true
  },
  at: { type: Date, default: Date.now },
  detail: String,
  source: { type: String, enum: ["gmail_api", "tracking_pixel", "tracking_link", "gmail_dsn", "manual"], default: "gmail_api" },
  userAgent: String,
  automatedLikely: { type: Boolean, default: false }
}, { _id: false });

const trackedLinkSchema = new mongoose.Schema({
  linkId: { type: String, required: true },
  destination: { type: String, required: true },
  clicks: { type: Number, default: 0 }
}, { _id: false });

const emailSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  sender: String,
  recipient: String,
  subject: String,
  gmailMessageId: String,
  rfcMessageId: String,
  trackingToken: { type: String, index: true, sparse: true },
  trackedLinks: { type: [trackedLinkSchema], default: [] },
  openCount: { type: Number, default: 0 },
  clickCount: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ["submitted", "delivered", "bounced", "opened", "clicked", "send_failed"],
    default: "submitted",
    index: true
  },
  events: [eventSchema],
  deliveryEvidence: String,
  bounceReason: String,
  lastBounceCheckAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const EmailConnection = mongoose.model("EmailConnection", connectionSchema);
const EmailLog = mongoose.model("EmailLog", emailSchema);

function encryptionKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.");
  return Buffer.from(hex, "hex");
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(v => v.toString("base64")).join(".");
}
function decrypt(value) {
  const [iv, tag, data] = value.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8"));
}
function oauthClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
    throw new Error("Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI in .env");
  }
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
}
function requireDemoSession(req, res, next) {
  if (!req.session.userId) req.session.userId = DEMO_USER_ID;
  next();
}
app.use("/api", requireDemoSession);

function createEvent(type, detail, source, userAgent = "") {
  return {
    type, detail, source, at: new Date(),
    userAgent: String(userAgent || "").slice(0, 500),
    automatedLikely: /(bot|crawler|spider|preview|scanner|proofpoint|mimecast|barracuda|safelinks|urlscan|googleimageproxy)/i.test(userAgent || "")
  };
}
function appendStatusEvent(email, type, detail, source) {
  const already = email.events.some(e => e.type === type && e.source === source && e.detail === detail);
  if (!already) email.events.push(createEvent(type, detail, source));
  // Status is a latest/highest-signal state, but opened/clicked are engagement states.
  // A bounce supersedes delivery; engagement never overwrites bounce.
  if (type === "bounced") email.status = "bounced";
  else if (type === "delivered" && email.status !== "bounced" && email.status !== "opened" && email.status !== "clicked") email.status = "delivered";
  else if (type === "opened" && email.status !== "bounced" && email.status !== "clicked") email.status = "opened";
  else if (type === "clicked" && email.status !== "bounced") email.status = "clicked";
}

app.get("/auth/google", requireDemoSession, (req, res) => {
  try {
    const oauth = oauthClient();
    const state = crypto.randomBytes(24).toString("hex");
    req.session.oauthState = state;
    res.redirect(oauth.generateAuthUrl({
      access_type: "offline", prompt: "consent", include_granted_scopes: true,
      scope: SCOPES, state
    }));
  } catch (e) { res.status(500).send(e.message); }
});

app.get("/auth/google/callback", requireDemoSession, async (req, res) => {
  try {
    if (!req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send("OAuth state validation failed.");
    delete req.session.oauthState;
    if (req.query.error) return res.redirect("/?oauth=denied");
    const oauth = oauthClient();
    const { tokens } = await oauth.getToken(String(req.query.code || ""));
    oauth.setCredentials(tokens);
    const info = await google.oauth2({ version: "v2", auth: oauth }).userinfo.get();
    const email = info.data.email;
    if (!email) throw new Error("Google did not return an email address.");
    const previous = await EmailConnection.findOne({ userId: req.session.userId });
    const oldTokens = previous ? decrypt(previous.encryptedTokens) : {};
    const merged = { ...oldTokens, ...tokens };
    if (!merged.refresh_token && oldTokens.refresh_token) merged.refresh_token = oldTokens.refresh_token;
    await EmailConnection.findOneAndUpdate(
      { userId: req.session.userId },
      { userId: req.session.userId, email, encryptedTokens: encrypt(merged), connectedAt: new Date() },
      { upsert: true, new: true }
    );
    res.redirect("/?oauth=connected");
  } catch (e) {
    console.error("[oauth] callback:", e.message);
    res.status(500).send(`Gmail connection failed: ${e.message}`);
  }
});

app.get("/api/connection", async (req, res) => {
  const c = await EmailConnection.findOne({ userId: req.session.userId }).lean();
  res.json({ connected: !!c, email: c?.email || null });
});

app.post("/api/disconnect", async (req, res) => {
  const c = await EmailConnection.findOne({ userId: req.session.userId });
  if (c) {
    try {
      const tokens = decrypt(c.encryptedTokens);
      const oauth = oauthClient();
      oauth.setCredentials(tokens);
      await oauth.revokeCredentials();
    } catch (e) { console.warn("[oauth] revoke warning:", e.message); }
    await EmailConnection.deleteOne({ _id: c._id });
  }
  res.json({ ok: true });
});

function b64url(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function makeTrackedHtml(rawText, email) {
  const token = email.trackingToken;
  const base = TRACKING_BASE();
  const escaped = escapeHtml(rawText);
  const links = escaped.replace(/(https?:\/\/[^\s<]+)/g, match => {
    const dest = match.replace(/[),.!?;:]+$/, "");
    const trailing = match.slice(dest.length);
    let parsed;
    try { parsed = new URL(dest); } catch { return match; }
    if (!["http:", "https:"].includes(parsed.protocol)) return match;
    const linkId = crypto.randomBytes(10).toString("hex");
    email.trackedLinks.push({ linkId, destination: parsed.toString(), clicks: 0 });
    const redirect = `${base}/track/click/${token}/${linkId}`;
    return `<a href="${redirect}" target="_blank" rel="noopener noreferrer">${dest}</a>${trailing}`;
  }).replace(/\r?\n/g, "<br>");
  const pixel = `<img src="${base}/track/open/${token}.gif" width="1" height="1" alt="" style="width:1px;height:1px;border:0" />`;
  return `<div style="font-family:Arial,sans-serif;line-height:1.5">${links}</div>${pixel}`;
}

app.post("/api/send", async (req, res) => {
  let log;
  try {
    const { to, subject, body } = req.body || {};
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "Enter a valid-looking recipient email address." });
    if (!String(subject || "").trim()) return res.status(400).json({ error: "Subject is required." });
    if (!String(body || "").trim()) return res.status(400).json({ error: "Email body is required." });

    const conn = await EmailConnection.findOne({ userId: req.session.userId });
    if (!conn) return res.status(400).json({ error: "Connect Gmail before sending." });

    log = await EmailLog.create({
      userId: req.session.userId, sender: conn.email, recipient: String(to).trim(),
      subject: String(subject).trim(), trackingToken: crypto.randomBytes(24).toString("hex"),
      events: []
    });
    const html = makeTrackedHtml(String(body), log);
    await log.save();

    const mime = [
      `From: BlueCode OS <${conn.email}>`,
      `To: ${String(to).trim()}`,
      `Subject: ${String(subject).replace(/[\r\n]/g, " ")}`,
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(html, "utf8").toString("base64").match(/.{1,76}/g).join("\r\n")
    ].join("\r\n");

    const oauth = oauthClient();
    oauth.setCredentials(decrypt(conn.encryptedTokens));
    const gmail = google.gmail({ version: "v1", auth: oauth });
    const sent = await gmail.users.messages.send({ userId: "me", requestBody: { raw: b64url(mime) } });
    log.gmailMessageId = sent.data.id;
    // Read the actual Message-ID assigned/stored by Gmail for later DSN correlation.
    try {
      const sentMeta = await gmail.users.messages.get({
        userId: "me",
        id: sent.data.id,
        format: "metadata",
        metadataHeaders: ["Message-ID"]
      });
      const actualHeader = (sentMeta.data.payload?.headers || [])
        .find(h => h.name?.toLowerCase() === "message-id")?.value || "";
      if (actualHeader) log.rfcMessageId = actualHeader.replace(/[<>]/g, "").trim().toLowerCase();
    } catch (metaError) {
      console.warn("[mail] Could not read sent Message-ID metadata:", metaError.message);
    }
    log.status = "submitted";
    log.events.push(createEvent("submitted", "Gmail API accepted the send request; delivery is not yet confirmed.", "gmail_api"));
    await log.save();

    console.log(`[mail] submitted ${log._id} (${log.recipient}) pixel=1 links=${log.trackedLinks.length}`);
    res.json({
      ok: true, id: log._id, sender: conn.email,
      message: "Gmail API accepted the message.",
      tracking: { pixelIncluded: true, links: log.trackedLinks.length }
    });
  } catch (e) {
    console.error("[mail] send failed:", e.message);
    if (log && !log.gmailMessageId) {
      // API submission failure is not a recipient bounce. Keep it distinct.
      log.status = "send_failed";
      log.events.push(createEvent("send_failed", `Gmail API rejected the send request: ${e.message}`, "gmail_api"));
      await log.save().catch(() => {});
    }
    res.status(500).json({ error: e.message || "Unable to send email." });
  }
});

app.get("/api/emails", async (req, res) => {
  const emails = await EmailLog.find({ userId: req.session.userId }).sort({ createdAt: -1 }).limit(100).lean();
  res.json(emails);
});

// For this prototype, run this endpoint on demand to check the connected mailbox for DSN/bounce notices.
// Gmail does not provide a "delivered" webhook for messages sent through gmail.users.messages.send.
function decodeGmailBody(data) {
  if (!data) return "";
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}
function flattenMimeText(payload, output = []) {
  if (!payload) return output;
  const mime = String(payload.mimeType || "").toLowerCase();
  if (payload.body?.data && (
    mime === "text/plain" ||
    mime === "message/delivery-status" ||
    mime === "text/rfc822-headers"
  )) {
    output.push(decodeGmailBody(payload.body.data));
  }
  (payload.parts || []).forEach(part => flattenMimeText(part, output));
  return output;
}
function extractDsnFields(text) {
  const lines = String(text || "").split(/\r?\n/);
  const get = name => {
    const prefix = `${name.toLowerCase()}:`;
    const line = lines.find(x => x.toLowerCase().startsWith(prefix));
    return line ? line.slice(prefix.length).trim() : "";
  };
  return {
    action: get("Action").toLowerCase(),
    status: get("Status"),
    finalRecipient: (get("Final-Recipient") || get("Original-Recipient")).split(";").pop().trim().toLowerCase(),
    originalMessageId: get("Original-Message-ID").replace(/[<>]/g, "").trim().toLowerCase(),
    trackingToken: get("X-BlueCode-Tracking-ID").trim().toLowerCase()
  };
}

app.post("/api/email/sync-delivery", async (req, res) => {
  try {
    const conn = await EmailConnection.findOne({ userId: req.session.userId });
    if (!conn) return res.status(400).json({ error: "Connect Gmail first." });

    const oauth = oauthClient();
    oauth.setCredentials(decrypt(conn.encryptedTokens));
    const gmail = google.gmail({ version: "v1", auth: oauth });

    // in:anywhere includes Spam/Trash where a DSN may have been classified.
    const q = 'in:anywhere (from:mailer-daemon OR from:mail-delivery-subsystem) newer_than:30d';
    const listed = await gmail.users.messages.list({ userId: "me", q, maxResults: 100 });
    const messages = listed.data.messages || [];
    let scanned = 0, bounced = 0, delivered = 0, unmatched = 0;

    for (const item of messages) {
      const msg = await gmail.users.messages.get({ userId: "me", id: item.id, format: "full" });
      scanned++;
      const headers = msg.data.payload?.headers || [];
      const header = name => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
      const subject = header("Subject");
      const from = header("From");
      const snippet = msg.data.snippet || "";
      const bodyText = flattenMimeText(msg.data.payload).join("\n");
      const text = `${subject}\n${from}\n${snippet}\n${bodyText}`;
      const senderLooksLikeDaemon = /mailer-daemon|mail-delivery-subsystem/i.test(from);
      const subjectLooksLikeDsn = /delivery status notification|undeliverable|delivery failure|address not found|user unknown|mailbox unavailable|message not delivered/i.test(subject);
      if (!senderLooksLikeDaemon && !subjectLooksLikeDsn) continue;

      const fields = extractDsnFields(text);
      const idFromDsn = fields.originalMessageId.toLowerCase();
      const candidates = idFromDsn
        ? await EmailLog.find({ userId: req.session.userId, rfcMessageId: idFromDsn }).limit(2)
        : [];
      const tokenCandidates = (!candidates.length && fields.trackingToken)
        ? await EmailLog.find({ userId: req.session.userId, trackingToken: fields.trackingToken }).limit(2)
        : [];

      let matched = candidates.length === 1 ? candidates[0]
        : (tokenCandidates.length === 1 ? tokenCandidates[0] : null);

      // Conservative fallback: only match if exact final recipient and original subject
      // identify exactly one recent message. Never infer Delivered from no bounce.
      if (!matched && fields.finalRecipient && subject) {
        const possible = await EmailLog.find({
          userId: req.session.userId,
          recipient: fields.finalRecipient,
          createdAt: { $gte: new Date(Date.now() - 30 * 86400000) }
        }).sort({ createdAt: -1 }).limit(10);
        const subjectMatches = possible.filter(x =>
          x.subject && text.toLowerCase().includes(x.subject.toLowerCase())
        );
        if (subjectMatches.length === 1) matched = subjectMatches[0];
      }

      if (!matched) { unmatched++; continue; }

      const isFailed = fields.action === "failed" || /^5\.\d\.\d/.test(fields.status) ||
        /delivery failed|not delivered|undeliverable|address not found|user unknown|mailbox unavailable|550\\s/i.test(text);
      const isDelivered = fields.action === "delivered" || /^2\.\d\.\d/.test(fields.status);

      if (isFailed) {
        appendStatusEvent(matched, "bounced", `DSN reports failed delivery (${fields.status || fields.action || "failure"}): ${subject}`, "gmail_dsn");
        matched.bounceReason = `${fields.status || fields.action || "Delivery failure"} ${fields.finalRecipient || matched.recipient}`.trim();
        matched.deliveryEvidence = "Gmail delivery-status notification (failure)";
        matched.lastBounceCheckAt = new Date();
        await matched.save();
        bounced++;
      } else if (isDelivered) {
        appendStatusEvent(matched, "delivered", `DSN reports successful delivery (${fields.status || fields.action}): ${subject}`, "gmail_dsn");
        matched.deliveryEvidence = "Gmail delivery-status notification (success)";
        matched.lastBounceCheckAt = new Date();
        await matched.save();
        delivered++;
      } else {
        unmatched++;
      }
    }

    conn.lastBounceSyncAt = new Date();
    await conn.save();
    res.json({
      ok: true,
      messagesScanned: scanned,
      bounceEventsAdded: bounced,
      deliveredEventsAdded: delivered,
      unmatchedDsnMessages: unmatched,
      note: "Only matching DSN delivery/failure evidence changes status. No bounce found does not mean Delivered; Gmail may not provide a positive delivery receipt."
    });
  } catch (e) {
    console.error("[delivery-sync] error:", e.message);
    res.status(500).json({ error: e.message || "Unable to sync delivery notifications." });
  }
});

app.get("/api/tracking/diagnostics", (req, res) => res.json({
  ok: true, publicTrackingUrl: TRACKING_BASE(),
  pixelExample: `${TRACKING_BASE()}/track/open/{token}.gif`,
  clickExample: `${TRACKING_BASE()}/track/click/{token}/{linkId}`
}));

app.get("/track/ping", (req, res) => res.type("text/plain").set("Cache-Control", "no-store").send("BlueCode OS tracking endpoint is reachable."));

function gif(res) {
  const bytes = Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64");
  res.status(200).set({
    "Content-Type": "image/gif", "Content-Length": String(bytes.length),
    "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
    "Pragma": "no-cache", "X-Content-Type-Options": "nosniff"
  }).end(bytes);
}

app.get("/track/open/:token.gif", async (req, res) => {
  try {
    const email = await EmailLog.findOne({ trackingToken: req.params.token });
    if (email) {
      email.openCount = (email.openCount || 0) + 1;
      appendStatusEvent(email, "opened", "Tracking pixel requested; may be a proxy or automated image fetch.", "tracking_pixel");
      await email.save();
      console.log(`[tracking] OPEN ${email._id} count=${email.openCount} automated=${/(bot|crawler|scanner|proxy)/i.test(req.get("user-agent") || "")}`);
    } else {
      console.warn("[tracking] unknown open token", req.params.token.slice(0, 8));
    }
  } catch (e) { console.error("[tracking] open error:", e.message); }
  gif(res);
});

app.get("/track/click/:token/:linkId", async (req, res) => {
  try {
    const email = await EmailLog.findOne({ trackingToken: req.params.token });
    if (!email) return res.status(404).send("Tracking record not found.");
    const link = email.trackedLinks.find(x => x.linkId === req.params.linkId);
    if (!link) return res.status(404).send("Tracked destination not found.");
    link.clicks = (link.clicks || 0) + 1;
    email.clickCount = (email.clickCount || 0) + 1;
    appendStatusEvent(email, "clicked", `Tracked link requested: ${new URL(link.destination).hostname}`, "tracking_link");
    await email.save();
    console.log(`[tracking] CLICK ${email._id} count=${email.clickCount}`);
    res.redirect(302, link.destination);
  } catch (e) {
    console.error("[tracking] click error:", e.message);
    res.status(500).send("Unable to process tracked link.");
  }
});

// Manual delivery confirmation is intentionally unavailable: only recognized DSN bounce evidence is ingested.
// Gmail API send acceptance alone cannot prove Delivered.

app.get("/health", (req, res) => res.json({ ok: true }));

async function start() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is missing in .env");
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");
  app.listen(PORT, () => {
    console.log(`BlueCode Gmail prototype: http://localhost:${PORT}`);
    console.log(`Public tracking base: ${TRACKING_BASE()}`);
  });
}
start().catch(e => { console.error(e); process.exit(1); });

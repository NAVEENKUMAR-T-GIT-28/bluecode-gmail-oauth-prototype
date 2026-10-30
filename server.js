require("dotenv").config();

const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const crypto = require("crypto");
const path = require("path");
const { google } = require("googleapis");

const app = express();
const PORT = Number(process.env.PORT || 5000);
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.send"];
const DEMO_USER_ID = process.env.DEMO_USER_ID || "demo-user-001";

function trackingBase() {
  return (process.env.PUBLIC_TRACKING_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
}

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
  connectedAt: { type: Date, default: Date.now }
});

const eventSchema = new mongoose.Schema({
  type: { type: String, enum: ["submitted", "opened", "clicked"], required: true },
  at: { type: Date, default: Date.now },
  detail: String,
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
  trackingToken: { type: String, index: true, sparse: true },
  trackedLinks: { type: [trackedLinkSchema], default: [] },
  openCount: { type: Number, default: 0 },
  clickCount: { type: Number, default: 0 },
  status: { type: String, default: "submitted" },
  events: [eventSchema],
  createdAt: { type: Date, default: Date.now }
});

const EmailConnection = mongoose.model("EmailConnection", connectionSchema);
const EmailLog = mongoose.model("EmailLog", emailSchema);

function encryptionKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.");
  }
  return Buffer.from(hex, "hex");
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(x => x.toString("base64")).join(".");
}
function decrypt(value) {
  const [ivB64, tagB64, dataB64] = value.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8"));
}
function oauthClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
    throw new Error("Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI in .env");
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}
function requireDemoSession(req, res, next) {
  // Local prototype only. Replace with authenticated BlueCode OS user identity before multi-user use.
  if (!req.session.userId) req.session.userId = DEMO_USER_ID;
  next();
}
app.use("/api", requireDemoSession);

app.get("/auth/google", requireDemoSession, (req, res) => {
  try {
    const oauth2 = oauthClient();
    const state = crypto.randomBytes(24).toString("hex");
    req.session.oauthState = state;
    res.redirect(oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      scope: SCOPES,
      state
    }));
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/auth/google/callback", requireDemoSession, async (req, res) => {
  try {
    if (!req.query.state || req.query.state !== req.session.oauthState) {
      return res.status(400).send("OAuth state validation failed. Restart the Gmail connection flow.");
    }
    delete req.session.oauthState;
    if (req.query.error) return res.redirect("/?oauth=denied");

    const oauth2 = oauthClient();
    const { tokens } = await oauth2.getToken(String(req.query.code || ""));
    oauth2.setCredentials(tokens);

    // OpenID userinfo identifies the Google account without Gmail mailbox-read permission.
    const profile = await google.oauth2({ version: "v2", auth: oauth2 }).userinfo.get();
    const email = profile.data.email;
    if (!email) throw new Error("Google did not return an email address.");

    const previous = await EmailConnection.findOne({ userId: req.session.userId });
    const previousTokens = previous ? decrypt(previous.encryptedTokens) : {};
    const mergedTokens = { ...previousTokens, ...tokens };
    if (!mergedTokens.refresh_token && previousTokens.refresh_token) {
      mergedTokens.refresh_token = previousTokens.refresh_token;
    }
    await EmailConnection.findOneAndUpdate(
      { userId: req.session.userId },
      { userId: req.session.userId, email, encryptedTokens: encrypt(mergedTokens), connectedAt: new Date() },
      { upsert: true, new: true }
    );
    res.redirect("/?oauth=connected");
  } catch (e) {
    console.error("OAuth callback error:", e.message);
    res.status(500).send(`Gmail connection failed: ${e.message}`);
  }
});

app.get("/api/connection", async (req, res) => {
  const connection = await EmailConnection.findOne({ userId: req.session.userId }).lean();
  res.json({ connected: !!connection, email: connection?.email || null });
});

app.post("/api/disconnect", async (req, res) => {
  const connection = await EmailConnection.findOne({ userId: req.session.userId });
  if (connection) {
    try {
      const tokens = decrypt(connection.encryptedTokens);
      if (tokens.refresh_token) {
        const oauth2 = oauthClient();
        oauth2.setCredentials({ refresh_token: tokens.refresh_token });
        await oauth2.revokeCredentials();
      }
    } catch (e) {
      console.warn("Token revocation warning:", e.message);
    }
    await EmailConnection.deleteOne({ _id: connection._id });
  }
  res.json({ ok: true });
});

function base64Url(input) {
  return Buffer.from(input).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function linkifyEscapedText(text) {
  return text.replace(/(https?:\/\/[^\s<]+)/g, raw => {
    const clean = raw.replace(/[),.!?;:]+$/, "");
    const suffix = raw.slice(clean.length);
    return `<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${suffix}`;
  });
}
function instrumentHtml(html, emailLog) {
  const base = trackingBase();
  let output = String(html || "");
  const trackedLinks = [];

  output = output.replace(/href=(["'])(https?:\/\/[^"']+)\1/gi, (match, quote, rawUrl) => {
    let destination;
    try {
      destination = new URL(rawUrl).toString();
    } catch {
      return match;
    }
    const linkId = crypto.randomBytes(8).toString("hex");
    trackedLinks.push({ linkId, destination, clicks: 0 });
    const trackedUrl = `${base}/track/click/${emailLog.trackingToken}/${linkId}`;
    return `href=${quote}${trackedUrl}${quote}`;
  });

  emailLog.trackedLinks = trackedLinks;
  // Use a normal 1x1 image element. Some clients ignore CSS-hidden images.
  const pixelUrl = `${base}/track/open/${emailLog.trackingToken}.gif?v=${Date.now()}`;
  const pixel = `<img src="${pixelUrl}" width="1" height="1" border="0" alt="" style="width:1px;height:1px;border:0;display:block" />`;
  return `${output}${pixel}`;
}
function likelyAutomated(userAgent) {
  return /(bot|crawler|spider|preview|scanner|proofpoint|mimecast|barracuda|safelinks|urlscan|googleimageproxy)/i.test(userAgent || "");
}
function trackingEvent(type, detail, userAgent) {
  return {
    type,
    detail,
    userAgent: String(userAgent || "").slice(0, 500),
    automatedLikely: likelyAutomated(userAgent),
    at: new Date()
  };
}
function gifResponse(res) {
  // Valid 1x1 transparent GIF.
  const gif = Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64");
  res.status(200).set({
    "Content-Type": "image/gif",
    "Content-Length": String(gif.length),
    "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(gif);
}

app.post("/api/send", async (req, res) => {
  try {
    const { to, subject, body } = req.body || {};
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ error: "Enter a valid-looking recipient email address." });
    }
    if (!subject || !String(subject).trim()) return res.status(400).json({ error: "Subject is required." });
    if (!body || !String(body).trim()) return res.status(400).json({ error: "Email body is required." });

    const connection = await EmailConnection.findOne({ userId: req.session.userId });
    if (!connection) return res.status(400).json({ error: "Connect Gmail before sending." });

    const emailLog = await EmailLog.create({
      userId: req.session.userId,
      sender: connection.email,
      recipient: String(to).trim(),
      subject: String(subject).trim(),
      trackingToken: crypto.randomBytes(24).toString("hex"),
      events: []
    });

    const safeBody = linkifyEscapedText(escapeHtml(body)).replace(/\n/g, "<br>");
    const html = instrumentHtml(
      `<div style="font-family:Arial,sans-serif;line-height:1.5">${safeBody}</div>`,
      emailLog
    );
    await emailLog.save();

    const mime = [
      `From: BlueCode OS <${connection.email}>`,
      `To: ${String(to).trim()}`,
      `Subject: ${String(subject).replace(/[\r\n]/g, " ")}`,
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(html, "utf8").toString("base64").match(/.{1,76}/g).join("\r\n")
    ].join("\r\n");

    const tokens = decrypt(connection.encryptedTokens);
    const oauth2 = oauthClient();
    oauth2.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth: oauth2 });
    const sent = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: base64Url(mime) }
    });

    emailLog.gmailMessageId = sent.data.id;
    emailLog.status = "submitted";
    emailLog.events.push(trackingEvent("submitted", "Gmail API accepted the message for sending.", ""));
    await emailLog.save();

    console.log(`[mail] submitted id=${emailLog._id} recipient=${emailLog.recipient} tracking=${trackingBase()}`);
    res.json({
      ok: true,
      id: emailLog._id,
      message: "Gmail API accepted the message.",
      sender: connection.email,
      tracking: { pixelIncluded: true, trackedLinks: emailLog.trackedLinks.length }
    });
  } catch (e) {
    console.error("Send error:", e.message);
    res.status(500).json({ error: e.message || "Unable to send email." });
  }
});

app.get("/api/emails", async (req, res) => {
  const emails = await EmailLog.find({ userId: req.session.userId })
    .sort({ createdAt: -1 }).limit(100).lean();
  res.json(emails);
});

app.get("/api/tracking/diagnostics", requireDemoSession, (req, res) => {
  const base = trackingBase();
  res.json({
    ok: true,
    publicTrackingUrl: base,
    pixelRoute: `${base}/track/open/{trackingToken}.gif`,
    clickRoute: `${base}/track/click/{trackingToken}/{linkId}`,
    note: "Open this base URL from a browser to verify ngrok reaches this local server. Actual pixel requests are recorded per email."
  });
});

app.get("/track/ping", (req, res) => {
  console.log(`[tracking] public ping ${new Date().toISOString()} ua=${req.get("user-agent") || "unknown"}`);
  res.type("text/plain").set("Cache-Control", "no-store").send("BlueCode OS tracking endpoint is reachable.");
});

async function recordOpen(req, res, token) {
  try {
    // New messages use an unguessable tracking token. Fall back to Mongo ObjectId
    // for compatibility with pixels embedded by the earlier prototype.
    let email = await EmailLog.findOne({ trackingToken: token });
    if (!email && mongoose.isValidObjectId(token)) {
      email = await EmailLog.findById(token);
    }
    if (!email) {
      console.warn(`[tracking] open token not found: ${String(token).slice(0, 8)}`);
      return gifResponse(res);
    }
    email.openCount = (email.openCount || 0) + 1;
    const alreadyRecorded = (email.events || []).some(event => event.type === "opened");
    if (!alreadyRecorded) {
      email.events.push(trackingEvent(
        "opened",
        "Tracking image requested (may be a privacy proxy or automated image fetch).",
        req.get("user-agent")
      ));
    }
    await email.save();
    console.log(`[tracking] OPEN email=${email._id} count=${email.openCount} automatedLikely=${likelyAutomated(req.get("user-agent"))}`);
  } catch (e) {
    console.error("[tracking] open error:", e.message);
  }
  return gifResponse(res);
}

app.get("/track/open/:token.gif", async (req, res) => {
  await recordOpen(req, res, req.params.token);
});

app.get("/track/click/:token/:linkId", async (req, res) => {
  try {
    const email = await EmailLog.findOne({ trackingToken: req.params.token });
    if (!email) return res.status(404).send("Tracking link not found.");
    const link = email.trackedLinks.find(item => item.linkId === req.params.linkId);
    if (!link) return res.status(404).send("Tracked destination not found.");

    link.clicks = (link.clicks || 0) + 1;
    email.clickCount = (email.clickCount || 0) + 1;
    email.events.push(trackingEvent(
      "clicked",
      `Link clicked: ${new URL(link.destination).hostname}`,
      req.get("user-agent")
    ));
    await email.save();

    console.log(`[tracking] CLICK email=${email._id} link=${link.linkId} count=${link.clicks} automatedLikely=${likelyAutomated(req.get("user-agent"))}`);
    return res.redirect(302, link.destination);
  } catch (e) {
    console.error("[tracking] click error:", e.message);
    return res.status(500).send("Unable to process tracked link.");
  }
});

// Legacy click route for already-sent messages. Kept for compatibility with previous test emails.
app.get("/track/click/:idLegacy", async (req, res) => {
  const target = String(req.query.url || "");
  try {
    const parsed = new URL(target);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid URL");
    await EmailLog.updateOne(
      { _id: req.params.idLegacy },
      { $push: { events: trackingEvent("clicked", `Legacy link: ${parsed.hostname}`, req.get("user-agent")) } }
    );
    return res.redirect(302, parsed.toString());
  } catch (_) {
    return res.status(400).send("Invalid tracking destination.");
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

async function start() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is missing in .env");
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");
  app.listen(PORT, () => {
    console.log(`BlueCode Gmail prototype: http://localhost:${PORT}`);
    console.log(`Public tracking base: ${trackingBase()}`);
  });
}
start().catch(err => {
  console.error(err);
  process.exit(1);
});

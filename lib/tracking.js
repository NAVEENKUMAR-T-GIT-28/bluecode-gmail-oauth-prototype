const crypto = require('crypto');
const { EmailLog } = require('../models');
const { randomToken, sha256 } = require('./security');

const BASE = () => (process.env.PUBLIC_TRACKING_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/+$/, '');
const AUTO_UA = /(bot|crawler|spider|preview|scanner|proofpoint|mimecast|barracuda|safelinks|urlscan|googleimageproxy|facebookexternalhit|skypeuripreview|headless)/i;
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function event(type, detail, source, extra = {}) {
  const ua = String(extra.userAgent || '').slice(0, 500);
  return { type, detail: String(detail || '').slice(0, 1200), source, at: new Date(), automatedLikely: AUTO_UA.test(ua), dedupeKey: extra.dedupeKey || '' };
}
async function addEvent(log, type, detail, source, extra = {}) {
  const dedupeKey = extra.dedupeKey || `${type}:${source}:${detail}`;
  if (log.events.some(e => e.dedupeKey === dedupeKey)) return false;
  log.events.push(event(type, detail, source, { ...extra, dedupeKey }));
  const precedence = { PENDING: 0, SENDING: 1, SUBMITTED: 2, DELIVERY_UNKNOWN: 2, DELIVERED: 3, OPENED: 4, CLICKED: 5, REPLIED: 6, BOUNCED: 7, ADDRESS_NOT_FOUND: 8, SEND_FAILED: 9 };
  if (['BOUNCED','ADDRESS_NOT_FOUND','SEND_FAILED'].includes(type)) log.status = type;
  else if (precedence[type] !== undefined && !['BOUNCED','ADDRESS_NOT_FOUND','SEND_FAILED'].includes(log.status) && precedence[type] >= (precedence[log.status] || 0)) log.status = type;
  return true;
}
function instrumentHtml(input, log) {
  const token = log.trackingToken;
  let html = String(input || '').trim();
  const base = BASE();
  const links = [];
  const register = destination => {
    let url; try { url = new URL(destination); } catch { return null; }
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const linkId = randomToken(10);
    log.trackedLinks.push({ linkId, destination: url.toString(), clicks: 0 });
    links.push(linkId);
    return `${base}/track/click/${token}/${linkId}`;
  };
  if (!html) {
    // Linkify plain-text URLs after escaping user content. Keep trailing punctuation outside the anchor.
    const escaped = escapeHtml(log.textBody || '').replace(/(https?:\/\/[^\s<]+)/gi, raw => {
      const destination = raw.replace(/[),.!?;:]+$/, '');
      const trailing = raw.slice(destination.length);
      const tracked = register(destination);
      return tracked ? `<a href="${tracked}" target="_blank" rel="noopener noreferrer">${destination}</a>${trailing}` : raw;
    });
    html = `<div style="font-family:Arial,sans-serif;line-height:1.5;white-space:pre-wrap">${escaped}</div>`;
  } else {
    // Track existing absolute HTTP(S) anchors. Other HTML remains unchanged.
    html = html.replace(/href\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi, (full, quote, destination) => {
      const tracked = register(destination);
      return tracked ? `href=${quote}${tracked}${quote}` : full;
    });
  }
  const pixel = `<img src="${base}/track/open/${token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`;
  return { html: `${html}${pixel}`, links };
}
function gifBytes() { return Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64'); }
async function recordOpen(token, userAgent) {
  const log = await EmailLog.findOne({ trackingToken: token });
  if (!log) return;
  log.openCount += 1;
  if (!log.firstOpenedAt) log.firstOpenedAt = new Date();
  log.lastOpenedAt = new Date();
  await addEvent(log, 'OPENED', 'Tracking pixel requested; proxy/scanner activity may be included.', 'tracking_pixel', { userAgent, dedupeKey: `open:${sha256(`${token}:${Math.floor(Date.now()/60000)}:${userAgent}`).slice(0,24)}` });
  await log.save();
}
async function recordClick(token, linkId, userAgent) {
  const log = await EmailLog.findOne({ trackingToken: token });
  if (!log) return null;
  const link = log.trackedLinks.find(x => x.linkId === linkId);
  if (!link) return null;
  link.clicks += 1; link.lastClickedAt = new Date(); log.clickCount += 1;
  if (!log.firstClickedAt) log.firstClickedAt = new Date();
  let host = 'tracked link'; try { host = new URL(link.destination).hostname; } catch {}
  await addEvent(log, 'CLICKED', `Tracked link requested: ${host}`, 'tracking_link', { userAgent, dedupeKey: `click:${linkId}:${sha256(`${Date.now()}:${userAgent}`).slice(0,16)}` });
  await log.save();
  return link.destination;
}
module.exports = { BASE, addEvent, instrumentHtml, gifBytes, recordOpen, recordClick, escapeHtml };

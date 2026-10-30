const mongoose = require('mongoose');

const connectionSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  email: { type: String, required: true, lowercase: true, index: true },
  encryptedTokens: { type: String, required: true },
  scopes: { type: [String], default: [] },
  connectedAt: { type: Date, default: Date.now },
  lastSyncAt: Date,
  lastSyncError: String,
  gmailHistoryId: String,
  syncCursor: String
}, { timestamps: true });

const trackedLinkSchema = new mongoose.Schema({
  linkId: { type: String, required: true },
  destination: { type: String, required: true },
  clicks: { type: Number, default: 0 },
  lastClickedAt: Date
}, { _id: false });

const eventSchema = new mongoose.Schema({
  type: { type: String, required: true, index: true },
  at: { type: Date, default: Date.now, index: true },
  source: { type: String, default: 'system' },
  detail: { type: String, default: '' },
  code: { type: String, default: '' },
  automatedLikely: { type: Boolean, default: false },
  dedupeKey: { type: String, default: '' }
}, { _id: true });

const emailSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  sender: { type: String, lowercase: true },
  recipient: { type: String, required: true, lowercase: true, index: true },
  subject: { type: String, default: '' },
  textBody: { type: String, default: '' },
  htmlBody: { type: String, default: '' },
  status: { type: String, enum: ['PENDING','SENDING','SUBMITTED','DELIVERED','OPENED','CLICKED','REPLIED','BOUNCED','ADDRESS_NOT_FOUND','SEND_FAILED','DELIVERY_UNKNOWN'], default: 'PENDING', index: true },
  gmailMessageId: { type: String, default: '', index: true },
  gmailThreadId: { type: String, default: '', index: true },
  rfcMessageId: { type: String, default: '', index: true },
  trackingToken: { type: String, unique: true, sparse: true, index: true },
  trackedLinks: { type: [trackedLinkSchema], default: [] },
  openCount: { type: Number, default: 0 },
  clickCount: { type: Number, default: 0 },
  firstOpenedAt: Date,
  lastOpenedAt: Date,
  firstClickedAt: Date,
  repliedAt: Date,
  bounceCode: String,
  bounceReason: String,
  deliveryEvidence: String,
  events: { type: [eventSchema], default: [] }
}, { timestamps: true });

emailSchema.index({ userId: 1, createdAt: -1 });
emailSchema.index({ userId: 1, recipient: 1, gmailThreadId: 1 });

const replySchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  emailLogId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailLog', index: true },
  gmailMessageId: { type: String, required: true },
  gmailThreadId: { type: String, default: '', index: true },
  rfcMessageId: { type: String, default: '' },
  inReplyTo: { type: String, default: '' },
  references: { type: String, default: '' },
  from: { type: String, default: '' },
  to: { type: String, default: '' },
  subject: { type: String, default: '' },
  text: { type: String, default: '' },
  html: { type: String, default: '' },
  receivedAt: { type: Date, default: Date.now, index: true },
  snippet: { type: String, default: '' },
  isRead: { type: Boolean, default: false }
}, { timestamps: true });
replySchema.index({ userId: 1, gmailMessageId: 1 }, { unique: true });
replySchema.index({ userId: 1, receivedAt: -1 });

const processedMessageSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  gmailMessageId: { type: String, required: true },
  kind: { type: String, default: 'processed' }
}, { timestamps: true });
processedMessageSchema.index({ userId: 1, gmailMessageId: 1 }, { unique: true });

module.exports = {
  EmailConnection: mongoose.model('EmailConnection', connectionSchema),
  EmailLog: mongoose.model('EmailLog', emailSchema),
  EmailReply: mongoose.model('EmailReply', replySchema),
  ProcessedMessage: mongoose.model('ProcessedMessage', processedMessageSchema)
};

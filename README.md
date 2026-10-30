# BlueCode OS — Gmail Lifecycle & Reply Inbox (rebuild)

This rebuild extends the inspected Express/MongoDB/Gmail OAuth prototype. It adds a single internal email lifecycle model, inbox reply capture, Gmail-thread/message-reference matching, basic DSN bounce parsing, reply inbox UI, and unique open/click tracking.

## Important scope note

This repository is still a **single demo workspace** until `getUserId()` in `server.js` is wired to your actual BlueCode OS authentication middleware. It currently uses `DEMO_USER_ID` as a development fallback. Do not expose this demo authentication mode publicly or treat it as multi-tenant security.

## Requirements

- Node.js 18+
- MongoDB
- Google Cloud project with Gmail API enabled
- Google OAuth Web client credentials

## Setup (patch the existing project)

The ZIP includes `apply-patch.ps1`. Extract the ZIP, then run this from PowerShell/Antigravity, adjusting the project path if yours differs:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
$Patch = "C:\Users\navee\Downloads\bluecode-os-email-lifecycle-rebuild\apply-patch.ps1"
$Project = "C:\Users\navee\Downloads\bluecode-gmail-oauth-prototype\bluecode-gmail-oauth-prototype"
& $Patch -ProjectPath $Project
```

The installer backs up every replaced source file under `.bluecode-backups`, then replaces only the source/UI files. It preserves `.env`, `package-lock.json`, `node_modules`, and Git history. Dependencies are unchanged, so no reinstall is required.

1. Confirm your existing `.env` has the required values below; do not overwrite it.
2. Ensure Google OAuth redirect URI exactly matches `GOOGLE_REDIRECT_URI`.
3. Run `npm start`.
4. Open `http://localhost:5000` and connect Gmail.
5. If you previously authorized only `gmail.send`, disconnect the old connection and reconnect. Approve Gmail read-only access as well.
6. For remote open/click tracking, run `ngrok http 5000` and set `PUBLIC_TRACKING_URL` to its HTTPS forwarding URL, then restart the server.

## Environment variables

- `MONGO_URI`: MongoDB connection string.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: Google OAuth client credentials.
- `GOOGLE_REDIRECT_URI`: OAuth callback URL registered in Google Cloud.
- `TOKEN_ENCRYPTION_KEY`: 32 random bytes, 64 hex characters; encrypts OAuth tokens at rest.
- `SESSION_SECRET`: long random session secret.
- `PUBLIC_TRACKING_URL`: publicly reachable HTTPS URL for pixel/link tracking.
- `DEMO_USER_ID`: local development identity only.
- `GMAIL_SYNC_INTERVAL_MS`: periodic inbox poll cadence; default 60 seconds.
- `GMAIL_SYNC_MAX_MESSAGES`: max recent Gmail messages scanned per sync; default 50.

## Lifecycle semantics

- `PENDING`: queued but not yet handed to Gmail.
- `SENDING`: backend is processing the send request.
- `SUBMITTED`: Gmail API accepted the send request. Not proof of delivery.
- `DELIVERED`: reserved for a positive delivery receipt/event. Gmail's normal send response does not provide this evidence; this build does not infer it merely because no bounce was found.
- `OPENED`: tracking image URL requested. May be a privacy proxy or automated fetch, not proof a human read the message.
- `CLICKED`: tracked redirect requested. Automated security scanners may request links.
- `REPLIED`: a reply matched to the original outreach.
- `BOUNCED`: a matched Gmail delivery-status notification indicated failure.
- `ADDRESS_NOT_FOUND`: matched bounce explicitly indicated a nonexistent/unknown recipient, typically enhanced status `5.1.1`.
- `SEND_FAILED`: Gmail API rejected the send operation.
- `DELIVERY_UNKNOWN`: available for UI/data modelling where no reliable delivery evidence exists; absence of bounce is not delivery confirmation.

## API routes

- `GET /api/connection`
- `POST /api/disconnect`
- `POST /api/send` `{ to, subject, body }`
- `GET /api/emails`
- `GET /api/emails/:id`
- `POST /api/gmail/sync` (manual inbox/reply/bounce sync)
- `POST /api/email/sync-delivery` (compatibility alias for sync)
- `GET /api/replies`
- `POST /api/replies/:id/read`
- `POST /api/replies/:id/send` `{ body }`
- `GET /api/tracking/diagnostics`
- `GET /track/open/:token.gif`
- `GET /track/click/:token/:linkId`
- `GET /health`

## How reply sync works

The synchronizer scans recent messages in the connected mailbox. It skips message IDs already processed, parses message headers and bodies, and attempts to associate incoming messages to sent messages using `In-Reply-To`, `References`, Gmail `threadId`, and a conservative sender/subject fallback. Replies matched to an outreach are stored in `EmailReply`, linked to the originating `EmailLog`, and shown in the Reply Inbox. The system deliberately does not import every unrelated inbox message into the outreach inbox.

For replies sent from the website, the app uses the original Gmail thread ID and reply headers when available. Test this against actual Gmail conversations; threading behavior can vary for unusual clients and forwarded messages.

## Known limits / production hardening required

1. Gmail API send acceptance is not recipient delivery confirmation. A missing DSN is not a delivered event. To have stronger delivery events across recipients/providers, add an optional provider adapter (SES/Brevo/SendGrid) later.
2. Pixel opens are estimates; Gmail image proxy/cache and privacy tools affect them. Link scanners can also trigger clicks.
3. DSN formats vary. The parser is best-effort and must be tested against real bounce samples. `ADDRESS_NOT_FOUND` is only assigned when explicit signals such as `5.1.1` are detected.
4. `gmail.readonly` is a restricted Google OAuth scope. Public SaaS rollout may require Google verification and a security assessment. Obtain informed consent and minimize retention of email body data.
5. This build uses Express's default in-memory session store for local development. Replace it with a persistent store (e.g., Mongo-backed session store), secure cookies, HTTPS, CSRF protection, rate limiting, audit logs, and robust authentication before production.
6. Implement real BlueCode OS account authentication and map each request to its internal immutable user/tenant ID. Do not trust an ID from query/body/header.
7. Encrypt refresh tokens with a managed KMS or equivalent in production, rotate keys, and provide revoke/disconnect controls.
8. The periodic poller is suitable for a prototype. A production multi-instance deployment should use a durable queue/worker or Gmail Pub/Sub watch with history cursor reconciliation and renewal.
9. Consider retention/deletion controls for reply bodies and sensitive personal information. Do not expose message bodies in logs.
10. Do not send unsolicited bulk email. Follow Gmail policies and applicable anti-spam/privacy laws.

## Database migration note

The model names intentionally remain `EmailConnection` and `EmailLog`, so existing MongoDB collections can be reused. The new fields are additive. The rebuilt `status` values are uppercase and new status values were added; old lowercase records may still render but should be migrated to uppercase before relying on filters/reporting. Old tracking links and tracking tokens remain valid only while the old tracking URL/routes continue to exist; consider keeping a compatibility redirect during cutover.

# BlueCode OS — Gmail OAuth prototype

A local Node.js + Express + MongoDB prototype that lets one demo user connect a Gmail account with Google OAuth, send email through the Gmail API, and record open-pixel / tracked-link requests.

## Requirements

- Node.js 18+
- MongoDB running locally, or a MongoDB connection string
- A Google Cloud project with Gmail API enabled
- Google OAuth 2.0 **Web application** credentials

## 1. Configure Google Cloud

1. Open https://console.cloud.google.com/
2. Create/select a project and enable **Gmail API**.
3. Configure the OAuth consent screen. For a personal test, choose External and add your Google account as a test user if the app is in Testing.
4. Create credentials → OAuth client ID → Web application.
5. Add this Authorized redirect URI exactly:
   `http://localhost:5000/auth/google/callback`
6. Copy the Client ID and Client Secret.

The prototype requests only `https://www.googleapis.com/auth/gmail.send`.

Google may show an unverified-app warning during testing. Only authorize an app you created and trust. Public deployment may require Google's OAuth verification and compliance steps for Gmail scopes.

## 2. Configure environment

Copy `.env.example` to `.env`, then fill:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI=http://localhost:5000/auth/google/callback`
- `MONGO_URI`
- `TOKEN_ENCRYPTION_KEY`: generate with `openssl rand -hex 32`
- `SESSION_SECRET`: use a long random value
- `PUBLIC_TRACKING_URL`: initially `http://localhost:5000`

Never commit `.env` or share OAuth client secrets/tokens.

## 3. Run locally

```bash
npm install
cp .env.example .env
# Edit .env
npm start
```

Open http://localhost:5000, click **Connect Gmail**, approve the permission, then send a test email.

## 4. Enable tracking for external recipients with ngrok

Email sending works without ngrok. For tracking events from a recipient outside your computer, the pixel/link URLs must be publicly reachable.

In a second terminal:

```bash
ngrok http 5000
```

Copy the HTTPS forwarding URL, for example `https://your-name.ngrok-free.app`, into `.env`:

```env
PUBLIC_TRACKING_URL=https://your-name.ngrok-free.app
```

Restart `npm start`. The OAuth redirect URI can remain `http://localhost:5000/auth/google/callback` because the browser completes OAuth back to your local machine. If you instead choose to route OAuth callback through ngrok, register that exact HTTPS callback URI in Google Cloud and update `GOOGLE_REDIRECT_URI` too.

Keep the ngrok tunnel running while testing tracking. Free ngrok URLs may change between sessions.

## 5. What the event labels mean

- `submitted`: Gmail API accepted the send request. It is **not** proof of inbox delivery.
- `opened`: the tracking image URL was requested. Image proxies, privacy features, and automated scanners can cause false positives.
- `clicked`: a tracked link was requested. Security scanners can also visit links automatically.

This prototype does not provide authoritative delivery/bounce status, replies, or proof a human read the email.

## Important security limitations

This is a local proof of concept, not production multi-tenant software:
- The app uses one fixed `DEMO_USER_ID`; it does not yet implement BlueCode OS login or user isolation.
- Express's default in-memory session store is for local testing only.
- Tokens are AES-256-GCM encrypted in MongoDB, but the encryption key lives in `.env`; production should use a managed secret/KMS and hardened session storage/cookies.
- Add CSRF protection, rate limits, validation, audit logging, secure cookie settings, and tenant authorization before deployment.
- Do not expose MongoDB to the internet. Only expose the Express app through ngrok.
- The demo sends plain-text user content as escaped HTML and rewrites absolute http/https links for tracking.

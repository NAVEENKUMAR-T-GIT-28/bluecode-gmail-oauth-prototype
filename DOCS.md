# BlueCode OS – Gmail Email Tracking Tool

## 1. What is this tool?

BlueCode OS Gmail Email Tracking allows founders to send business emails through their own Gmail accounts and monitor what happens afterwards.

**Main workflow:**

Connect Gmail → Send email → Track activity → Detect reply → AI analysis → Founder takes action.

## 2. Tools and technologies

| Tool | Purpose |
|---|---|
| Google OAuth 2.0 | Connect each founder's Gmail account |
| Gmail API | Send emails and identify matching replies |
| HTML tracking pixel | Track email image requests |
| Tracking redirect URL | Track link clicks |
| HTTPS domain | Secure OAuth and tracking endpoints |
| Backend hosting | Run the application and tracking services |
| MongoDB | Store emails, replies and tracking events |
| AI API | Analyse and classify prospect replies |

## 3. How it works

1. **Connect Gmail:** Founder authorizes BlueCode OS through Google. No Gmail password is shared.
2. **Send email:** BlueCode OS sends outreach through the connected Gmail account.
3. **Track activity:** Records image requests, link clicks and available bounce reports.
4. **Capture replies:** Identifies replies matching BlueCode OS outreach and stores the complete original email and matching reply.
5. **Dashboard:** Displays email activity, delivery errors, clicks and conversations for AI analysis.

Unrelated personal Gmail messages are not intended to be collected or stored.

## 4. Production requirements

### Google Cloud credentials

| Requirement | Purpose |
|---|---|
| Production Google Cloud project | Live application |
| Gmail API enabled | Gmail integration |
| OAuth Client ID | Identify BlueCode OS |
| OAuth Client Secret | Backend authorization |
| Authorized redirect URI | OAuth callback |
| Verified application domain | Establish domain ownership |
| Google OAuth verification | Enable public-user authorization |

**Required OAuth scopes:**

```text
openid
email
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.readonly
```

- `gmail.send` – Send emails.
- `gmail.readonly` – Identify and retrieve matching replies. This is a restricted scope.

### Production website requirements

- Registered domain.
- HTTPS application URL.
- Production OAuth callback URL.
- Public privacy policy and terms.
- Support email.
- Verified domain ownership.

### Backend environment credentials

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
APP_BASE_URL=
TRACKING_BASE_URL=
ENCRYPTION_KEY=
```

OAuth tokens must be encrypted and stored securely on the backend.

### Google production approval

Before public launch, we need:

1. Domain and brand verification.
2. Privacy policy and terms.
3. Gmail permission justification.
4. Explanation of email storage and AI processing.
5. Application demonstration for Google review.
6. Required security assessment by a Google-approved assessor, if applicable.

**Important:** Production mode alone does not remove restricted-scope verification requirements.

## 5. Cost estimation

| Service | Expected cost |
|---|---|
| Google OAuth | No separate per-user fee |
| Gmail API | No additional charge under the applicable daily billing threshold |
| Google Cloud project | Project creation is free |
| Gmail account | Free Gmail or paid Workspace subscription |
| Domain | Annual registration fee |
| Backend hosting | Depends on hosting provider |
| MongoDB | Depends on storage and hosting plan |
| AI API | Depends on usage and selected model |
| Google security assessment | Separate assessor quotation |

### Gmail API quota limits

For projects covered by Google's May 2026 quota model:

| Quota category | Limit | Applies to |
|---|---:|---|
| Per project per minute | 1,200,000 units | All founders combined |
| Per user per minute | 6,000 units | Each connected Gmail account |
| Per project per day | 80,000,000 units | All founders combined |

### What is a quota unit?

A quota unit measures the workload of a Gmail API operation. It is not an individual email, word or character.

| Gmail API operation | Quota units |
|---|---:|
| Send one email | 100 |
| List messages | 5 |
| Retrieve message metadata | 20 |
| Retrieve complete email content | 60 |
| Retrieve complete conversation thread | 120 |
| Check Gmail history | 2 |

### Estimated API usage per complete email workflow

| Action | API units |
|---|---:|
| Send outreach email | 100 |
| Check new messages | 5 |
| Check mailbox history | 2 |
| Fetch matching reply metadata | 20 |
| Retrieve complete reply content | 60 |
| **Total** | **187 units** |

<text color="secondary" size="xs">Illustrative calculation assuming one request for each operation. Actual usage depends on synchronization frequency, pagination and implementation.</text>

### Estimated daily capacity

At 187 quota units per complete workflow:

\[
80,000,000 \div 187 \approx 427,807
\]

| Metric | Estimated value |
|---|---:|
| Daily API quota threshold | 80,000,000 units |
| Units per complete workflow | 187 |
| Theoretical complete workflows | 427,807 per day |
| Additional Gmail API charge below threshold | ₹0 |

**Billing clarification:** Google's current published quota documentation describes standard Gmail API usage below the 80-million-unit daily threshold as free. Billing beyond the threshold is planned for later in 2026; final prices must be checked when published. The 80-million limit is a project-wide API usage threshold, not an email sending allowance.

### Gmail account sending limits

These limits are separate from Gmail API quota.

| Connected account | General daily sending limit |
|---|---:|
| Personal Gmail | 500 emails |
| Eligible paid Google Workspace | Up to 2,000 messages |
| Workspace trial | Generally 500 emails |

Each founder has their own account-level sending limit.

For example, if 100 founders connect their own personal Gmail accounts, their theoretical combined daily allowance is 50,000 emails, subject to Google's account policies.

**Important:** BlueCode OS uses one shared Google Cloud OAuth application, but the API quota is shared at project level and email sending limits belong to individual founder accounts.

### Security assessment cost

Google does not charge a separate application fee for OAuth verification. However, restricted-scope access generally requires an independent security assessment by an approved assessor, unless an exception applies.

The assessor determines the cost. A quotation is required before calculating this expense.

## 6. Current demonstration status

| Feature | Status |
|---|---|
| Gmail connection | Working in test configuration |
| Gmail email sending | Demonstrated |
| Click tracking | Demonstrated |
| Bounce detection | Demonstrated |
| Matching reply capture | Demonstrated |
| Reply inbox | Demonstrated |
| Conversation timeline | Demonstrated |
| Open tracking | Requires validation |
| AI reply classification | Requires final integration/validation |
| Production OAuth approval | Pending |
| Security assessment | Pending, if applicable |

## 7. Production launch checklist

1. Create production Google Cloud project.
2. Register production domain.
3. Configure Gmail API and OAuth credentials.
4. Publish privacy policy and terms.
5. Complete Google OAuth verification.
6. Complete applicable security assessment.
7. Deploy backend and MongoDB.
8. Configure production HTTPS tracking URL.
9. Validate open tracking and reply matching.
10. Test with independently authorized Google accounts.
11. Enable token encryption, monitoring and data deletion.
12. Launch after required approvals.

## Official references

- Gmail API quotas: https://developers.google.com/workspace/gmail/api/reference/quota
- Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- OAuth production requirements: https://developers.google.com/identity/protocols/oauth2/production-readiness/overview
- Restricted-scope verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Gmail sending limits: https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace
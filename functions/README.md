# TJA Dashboard Functions

Cloud Functions backend for the Conversations page.

## What it does

Exposes a single HTTPS function, `getConversations`, that:

1. Verifies the caller's Firebase ID token (must end in `@thejamesagency.com`).
2. Impersonates the `crm@thejamesagency.com` archive mailbox via a
   service account with domain-wide delegation.
3. Runs subject-line searches against Gmail for the client's name +
   any aliases.
4. Returns parsed threads in the shape the dashboard's
   `conversations.html` expects.

## One-time setup

### 1. Create the service account

In Google Cloud Console (the project linked to this Firebase app):

- IAM & Admin → **Service Accounts → Create**
- Name: `crm-archive-reader`
- Skip role assignment (no GCP role needed; we only use it for Gmail
  delegation).
- Open the created service account → **Keys → Add Key → Create new
  key → JSON**. Save the file as `crm-sa-key.json` somewhere outside
  the repo. **This file is gitignored.**
- Note the service account's **OAuth 2 Client ID** (the long
  numeric ID on the details page).

### 2. Enable domain-wide delegation

In **Workspace Admin Console**:

- Security → Access and data control → API controls → **Domain-wide
  delegation → Add new**
- Client ID: paste the OAuth 2 Client ID
- OAuth scopes (one line, comma-separated):
  ```
  https://www.googleapis.com/auth/gmail.readonly
  ```
- Save.

### 3. Confirm `crm@thejamesagency.com` exists

The function impersonates this mailbox. It must:

- Exist as a real user in the Workspace tenant.
- Be receiving the email you want indexed. Cameron's setup CC's it on
  every important thread; if any thread isn't CC'd, it won't be
  visible here.

### 4. Upload the service-account key as a Firebase secret

From the repo root:

```bash
cd functions
firebase functions:secrets:set CRM_SA_KEY < /path/to/crm-sa-key.json
```

(The first time you run this, Firebase will create the secret in
Secret Manager. Subsequent calls update it.)

### 5. Install + deploy

```bash
cd functions
npm install
firebase deploy --only functions
```

Firebase prints the deployed URL, e.g.
`https://getconversations-xxxxxx-uc.a.run.app`.

### 6. Wire it into the dashboard

Open the dashboard in a browser, open DevTools console, and run:

```js
localStorage.setItem('conversations_cf_endpoint',
  'https://getconversations-xxxxxx-uc.a.run.app');
```

(This is also synced via firebase-sync, so it propagates to your
phone automatically — but only after the first cloud write happens.)

Reload the Conversations page. The "Refresh from crm@" button now
calls the Cloud Function. Manual paste-entry still works alongside.

## Local dev

```bash
cd functions
npm install
firebase emulators:start --only functions
```

The emulator binds Secret Manager values from your local environment.
Export `CRM_SA_KEY` as the JSON string before starting the emulator:

```bash
export CRM_SA_KEY="$(cat /path/to/crm-sa-key.json)"
firebase emulators:start --only functions
```

## Cost

For Cameron's volume (low hundreds of TJA emails/day), this stays
well inside Firebase's free tier:

- Cloud Functions: 2M invocations / month free
- Gmail API: 1B quota units / day free; each thread read ~5–10 units
- Secret Manager: $0 for our access count

Realistic monthly cost: $0.

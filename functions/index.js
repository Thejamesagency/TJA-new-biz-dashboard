/**
 * TJA Dashboard — Cloud Functions backend
 *
 * Single function: getConversations
 *
 *   POST <function-url>
 *   Headers:
 *     Authorization: Bearer <Firebase ID token of @thejamesagency.com user>
 *     Content-Type: application/json
 *   Body:
 *     { clientName: "Acme Corp", keywords: ["Acme Corp", "Acme", "acme.com"] }
 *
 *   Response:
 *     { threads: [
 *         { id, subject, lastMessageAt, snippet,
 *           messages: [{ id, from, to:[], date, body }] }
 *       ]
 *     }
 *
 * Architecture:
 *
 * 1. Caller's Firebase ID token is verified by firebase-admin.
 *    Only @thejamesagency.com emails pass.
 * 2. We load a service-account key (from Secret Manager — see
 *    `gcloud secrets create`/`firebase functions:secrets:set`).
 * 3. The service account uses domain-wide delegation to impersonate
 *    crm@thejamesagency.com (the archive mailbox the dashboard treats
 *    as the source of truth for client email).
 * 4. Gmail API search: for each keyword, run `subject:"keyword"` and
 *    union the resulting threads. Pull each thread's full messages.
 * 5. Parse + return as a normalized shape that the page knows how to
 *    render.
 *
 * Why subject-line matching: the dashboard's client list (Status
 * Report + Outreach) is keyed by business name, and Cameron always
 * includes the client name in the subject. Subject scoping keeps the
 * query fast (no full-body indexing required) and avoids false
 * positives from forwarded chains where the client is mentioned in
 * passing.
 *
 * Setup checklist (do once):
 *   1. In Google Cloud Console → IAM & Admin → Service Accounts
 *      create `crm-archive-reader`, download a JSON key.
 *   2. In Workspace Admin → Security → API controls → Domain-wide
 *      delegation, add the service account's OAuth Client ID with
 *      scope: https://www.googleapis.com/auth/gmail.readonly
 *   3. Upload the JSON key as a Firebase secret:
 *        firebase functions:secrets:set CRM_SA_KEY < key.json
 *   4. Deploy:  firebase deploy --only functions
 *   5. Copy the printed function URL into the dashboard at
 *      localStorage.conversations_cf_endpoint
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { google } = require('googleapis');

initializeApp();

const CRM_SA_KEY = defineSecret('CRM_SA_KEY');

const TJA_DOMAIN = 'thejamesagency.com';
const ARCHIVE_USER = 'crm@thejamesagency.com';
const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
// Pull the most-recent N threads per keyword. Cameron's volume is
// well under this — bump if a single client ever has hundreds of
// threads in a query window.
const MAX_THREADS_PER_KEYWORD = 50;
// Cap on returned messages-per-thread. Gmail conversation threads
// can balloon when a long quote-reply chain is forwarded around;
// for the UI 100 is well above what we'd ever want to render.
const MAX_MESSAGES_PER_THREAD = 100;

exports.getConversations = onRequest(
  {
    region: 'us-central1',
    cors: true,
    secrets: [CRM_SA_KEY],
    // Memory bump — googleapis + JWT auth + JSON parsing of email
    // bodies blows past the default 256MB on threads with image
    // attachments. 512MB has plenty of headroom for our volume.
    memory: '512MiB',
    timeoutSeconds: 60
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed');
      return;
    }

    // ── 1. Auth: verify the caller's Firebase ID token ──
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res.status(401).json({ error: 'Missing Authorization: Bearer <token>' });
      return;
    }
    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(match[1]);
    } catch (e) {
      console.warn('Token verification failed', e.message);
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    const callerEmail = (decoded.email || '').toLowerCase();
    if (!callerEmail.endsWith('@' + TJA_DOMAIN)) {
      res.status(403).json({ error: 'TJA email required' });
      return;
    }

    // ── 2. Validate body ──
    const body = req.body || {};
    const clientName = String(body.clientName || '').trim();
    const keywords = Array.isArray(body.keywords)
      ? body.keywords.map((k) => String(k).trim()).filter(Boolean)
      : [];
    if (!clientName) {
      res.status(400).json({ error: 'clientName required' });
      return;
    }
    // Always include clientName as a keyword if not already
    if (!keywords.some((k) => k.toLowerCase() === clientName.toLowerCase())) {
      keywords.push(clientName);
    }

    // ── 3. Set up Gmail API with delegated auth ──
    let saKey;
    try {
      saKey = JSON.parse(CRM_SA_KEY.value());
    } catch (e) {
      console.error('Failed to parse CRM_SA_KEY secret', e);
      res.status(500).json({ error: 'Server config error (CRM_SA_KEY)' });
      return;
    }
    const jwt = new google.auth.JWT({
      email: saKey.client_email,
      key: saKey.private_key,
      scopes: GMAIL_SCOPES,
      subject: ARCHIVE_USER
    });
    const gmail = google.gmail({ version: 'v1', auth: jwt });

    // ── 4. Search each keyword, union the thread IDs ──
    const threadIds = new Set();
    for (const kw of keywords) {
      // Escape double quotes in the keyword so it parses cleanly
      // inside Gmail's subject:"..." operator.
      const safe = kw.replace(/"/g, '\\"');
      const q = `subject:"${safe}"`;
      try {
        const list = await gmail.users.threads.list({
          userId: 'me',
          q,
          maxResults: MAX_THREADS_PER_KEYWORD
        });
        (list.data.threads || []).forEach((t) => threadIds.add(t.id));
      } catch (e) {
        console.warn('thread list failed for keyword', kw, e.message);
      }
    }

    // ── 5. Fetch each thread + parse messages ──
    const threads = [];
    for (const tid of threadIds) {
      try {
        const t = await gmail.users.threads.get({
          userId: 'me',
          id: tid,
          format: 'full'
        });
        const parsed = parseThread(t.data);
        if (parsed) threads.push(parsed);
      } catch (e) {
        console.warn('thread get failed', tid, e.message);
      }
    }

    // Sort newest first
    threads.sort((a, b) => {
      return Date.parse(b.lastMessageAt || 0) - Date.parse(a.lastMessageAt || 0);
    });

    console.log(`getConversations: caller=${callerEmail} client="${clientName}" ` +
                `keywords=${JSON.stringify(keywords)} threads=${threads.length}`);

    res.status(200).json({ threads });
  }
);

/* ─── PARSERS ─── */

function parseThread(raw) {
  if (!raw || !Array.isArray(raw.messages) || raw.messages.length === 0) return null;
  const messages = raw.messages
    .slice(0, MAX_MESSAGES_PER_THREAD)
    .map(parseMessage)
    .filter(Boolean);
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  const subject = messages[0].subject || '(no subject)';
  return {
    id: raw.id,
    subject,
    lastMessageAt: last.date,
    snippet: (raw.snippet || '').slice(0, 240),
    messages
  };
}

function parseMessage(m) {
  if (!m || !m.payload) return null;
  const headers = {};
  (m.payload.headers || []).forEach((h) => {
    headers[h.name.toLowerCase()] = h.value;
  });
  const fromRaw = headers.from || '';
  const toRaw = headers.to || '';
  const ccRaw = headers.cc || '';
  const from = extractEmail(fromRaw);
  const to = parseAddressList(toRaw).concat(parseAddressList(ccRaw));
  const date = headers.date ? new Date(headers.date).toISOString() : null;
  const subject = headers.subject || '';
  const body = extractBody(m.payload) || m.snippet || '';
  return {
    id: m.id,
    from,
    to,
    date,
    subject,
    body
  };
}

/** Pull just the email address out of "Sarah Lee <sarah@acme.com>". */
function extractEmail(s) {
  const m = String(s || '').match(/<([^>]+)>/);
  if (m) return m[1].trim();
  return String(s || '').trim();
}

function parseAddressList(s) {
  if (!s) return [];
  // Split on commas not inside angle brackets
  return s.split(/,(?![^<]*>)/).map(extractEmail).filter(Boolean);
}

/** Walk MIME parts and return the text/plain body if available,
 *  falling back to a stripped text/html. */
function extractBody(payload) {
  if (!payload) return '';
  const stack = [payload];
  let plain = '';
  let html = '';
  while (stack.length) {
    const part = stack.pop();
    if (part.parts && part.parts.length) {
      part.parts.forEach((p) => stack.push(p));
      continue;
    }
    if (!part.body || !part.body.data) continue;
    const decoded = Buffer.from(
      part.body.data.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    if (part.mimeType === 'text/plain') {
      plain += decoded;
    } else if (part.mimeType === 'text/html') {
      html += decoded;
    }
  }
  if (plain) return plain.trim();
  if (html) return stripHtml(html).trim();
  return '';
}

function stripHtml(s) {
  return s
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n');
}

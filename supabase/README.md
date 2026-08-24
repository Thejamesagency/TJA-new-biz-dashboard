# RFP pipeline — Supabase backend

Runs **only** the BidPrime → RFP feed. The Firebase dashboard is untouched; the
RFP page reads this project with the anon key (select-only) and keeps triage
notes in Firebase.

## Pieces
- `migrations/0001_rfps.sql` — the `rfps` table + RLS (anon read; writes only via
  Edge Functions using the service-role key).
- `functions/_shared/normalize.ts` — the **only** file that maps a BidPrime
  payload to a row. Tighten it when a real sample payload arrives.
- `functions/_shared/bidprime.ts` — the adapter. Returns **bundled sample RFPs**
  until `BIDPRIME_API_BASE` is set, then calls the real API. No code change to
  go live — just secrets.
- `functions/bidprime-pull` — fetch + normalize + upsert (manual or cron).
- `functions/bidprime-webhook` — push receiver (optional HMAC signature check).

## Deploy (one time)
```bash
# 1. link this repo to the Supabase project that will host the RFP feed
supabase link --project-ref <PROJECT_REF>

# 2. create the table
supabase db push          # applies migrations/0001_rfps.sql

# 3. secrets (the key is already provided; the rest come from BidPrime)
supabase secrets set BIDPRIME_API_KEY=bp_xxx           # the token
# --- once BidPrime gives you the API details: ---
# supabase secrets set BIDPRIME_API_BASE=https://api.bidprime.com/v1
# supabase secrets set BIDPRIME_LIST_PATH=/opportunities
# supabase secrets set BIDPRIME_AUTH_HEADER=Authorization   # or X-API-Key
# supabase secrets set BIDPRIME_AUTH_SCHEME=Bearer          # or "" for raw key
# supabase secrets set BIDPRIME_WEBHOOK_SECRET=whsec_xxx    # if they sign webhooks

# 4. deploy the functions (see the memory note: use --use-api)
supabase functions deploy bidprime-pull    --use-api
supabase functions deploy bidprime-webhook --use-api
```

## Wire up
- **Webhook (push):** give BidPrime the deployed URL
  `https://<ref>.functions.supabase.co/bidprime-webhook`.
- **Pull (backfill/reconcile):** hit `.../bidprime-pull` manually, or schedule it
  (pg_cron / Supabase scheduled function) every N minutes.
- **The page:** put the project URL + anon key into `rfp.html`'s `SUPABASE`
  config. Until then, `rfp.html` shows the bundled sample RFPs.

## Test before BidPrime is wired
```bash
curl -X POST https://<ref>.functions.supabase.co/bidprime-pull   # ingests samples
```
Then the RFP page shows them, and each mirrors into the Scorecard.

# TJA New-Biz Dashboard — Handoff / Continue-Here

> **Why this file exists:** Cameron is moving Claude to the enterprise work
> account. Claude's *memory* and *plan files* live under the old account's
> local folders and **do not transfer**. GitHub + Supabase logins **do**
> stay the same — so everything needed to pick up is captured here, in the
> repo, where the new account can read it. Written 2026-07-24.

---

## 1 · Reconnect in 5 minutes (from the new Claude account)

Same Mac, so the repo is already on disk. In the new account:

1. **Open Claude Code in the repo:**
   `/Users/cameronpoolton/Documents/GitHub/TJA-new-biz-dashboard`
   It will auto-load `CLAUDE.md` (repo conventions) — read that first, then this file.

2. **GitHub** (login unchanged). As of 2026-07-24, **both `Thejamesagency`
   (owner) and `thejamesagencyoperations` (collaborator, push access) can push**
   — no more account-switch dance for the account you actually use.
   ```bash
   gh auth status   # confirm you're on Thejamesagency OR thejamesagencyoperations
   ```
   > ⚠️ **Only remaining gotcha:** the personal `cameronvervecrm` account still
   > has **no access** → 403 on push. If a push 403s, you're on that account;
   > switch with `gh auth switch --hostname github.com --user thejamesagencyoperations`.

3. **Supabase** (login unchanged, needed for the RFP build — see §5):
   ```bash
   supabase --version   # install if missing: brew install supabase/tap/supabase
   supabase login       # if the CLI isn't already authed
   ```
   There is an empty `supabase/` folder started in the repo (untracked) — nothing in it yet.

4. **Run the dashboard locally** (static site, no build step):
   ```bash
   npx -y serve -l 8937 .
   ```
   Then open `http://localhost:8937/weekly-priorities.html`.
   (There's also a `dashboard-static` entry in `.claude/launch.json` for the preview tools. Don't use `python3 -m http.server` — it hits a sandbox PermissionError here.)

5. **Deploy = push to `main`.** GitHub Pages rebuilds in ~30s at
   `https://thejamesagency.github.io/TJA-new-biz-dashboard/`.

**Sign-in inside the app:** only `cameron@thejamesagency.com` has write access
(gated in Firestore rules + client-side `isAdmin()`). Other `@thejamesagency.com`
users are read-only. Signed-out = "Local only (not synced)".

---

## 2 · Where things stand (state snapshot)

**Live pages (8), all on the fixed left sidebar nav:** Status Report
(`task-list.html`), Weekly Priorities, Client Notes, Scorecard, Outreach,
Conversations, Projects, Forecast. Plus `diag.html` (sync diagnostics) and
`index.html` (redirect).

**Sync:** every page loads `firebase-sync.js?v=26`. All synced data rides in a
**single Firestore doc** `workspaces/tja-main`, mirrored to `localStorage` keys
listed in the `SYNC_KEYS` array. **Bump the `?v=NN` cache-buster on every page
whenever you touch the sync layer or `SYNC_KEYS`**, and keep `diag.html`'s own
copy of `SYNC_KEYS` in step.

**Most recent work (newest first):**
- **Forecast v2** (`forecast.html`) — shipped, but running on **assumed seed
  data**. It's built to pull two live Google Sheets (Emma's P&L + the new-biz
  pipeline report) via published-CSV, has an "Actual Forecast" tab of real
  pipeline clients, and scenario tabs for per-client close cases. **Needs the
  real sheets Monday** (see to-dos).
- Weekly-Priorities SR rollover sync + "rolled from" badge clears on any edit.
- Projects page: drag-drop into folders, per-file download.

**Not yet built (planned):** the **BidPrime → RFP integration** — full plan in §5.

---

## 3 · Active to-do + bookmark list (dashboard-focused, prioritized)

### 🔜 This week / Monday
1. **📌 BidPrime access lands Monday AM** → then build the RFP integration (§5).
   Bring back the **6 deal-maker answers** from the vendor call:
   - Webhook payload richness + signature secret
   - API base URL + auth model
   - Whether RFP **document text is fetchable** via API (decides auto-scoring input)
   - Stable **deep-link** field back to the opportunity page
   - **Seats/login** needed to view an opportunity (who on the team can click through)
   - Data/AI **licensing**: can we store metadata + run their content through an LLM
2. **Forecast v2 real data** — get the **two published-CSV URLs** (P&L +
   pipeline report) and the **real pipeline export** so the parser mapping can
   be tuned to it (currently assumed). Wire via the page's **⚙ Sources** modal.

### 📌 Bookmarked / open threads
3. **Conversations backend was never finished.** `functions/getConversations`
   (crm@ Gmail reader) is scaffolded but **never deployed**, and the browser
   token bridge `window._tjaGetIdToken` **does not exist** — so "Refresh from
   crm@" silently no-ops. The page works in **manual paste mode only** today.
   Needs: Firebase **Blaze** plan, function deploy, the token bridge, and the
   pinned **Workspace tier question** (Vault vs shared-mailbox path). NOTE: with
   the Supabase pivot (§5) you may want to move this off Firebase Functions too.
4. **Firebase is on the free Spark plan** — it **cannot make outbound calls**
   (no BidPrime, no Anthropic, no Gmail-function outbound). This is *the* reason
   the RFP backend goes to Supabase. If you ever want the Conversations function
   live on Firebase, Blaze is required.
5. **Outreach → API automation** (deferred): pick a sending tool (Lusha for
   data, maybe HubSpot for send), sending-domain warmup decision, then replace
   the manual stage updates + campaign stats with API sync.
6. **Full Supabase migration (strategic, NOT now):** the single-1MB-doc Firestore
   model has already bumped its ceiling (Projects had to store HTML in-repo
   instead of Firestore). If that keeps biting, migrating the whole dashboard to
   Supabase Postgres is a reasonable *separate, carefully-planned* project. The
   RFP work (§5) is deliberately a hybrid so it doesn't force this now.

---

## 4 · How to make + ship updates (the workflow)

1. **Edit** the relevant page's inline `<script>` (each page is self-contained).
2. **Verify in the browser** before pushing — serve locally (step 1.4), open the
   page, check the console is clean, exercise the change. For engine/logic
   changes, test the functions directly in the console.
3. **If you changed the sync layer or `SYNC_KEYS`:** bump `firebase-sync.js` to
   the next `vNN`, bump the `?v=NN` cache-buster on **every** page, and mirror
   the `SYNC_KEYS` change into `diag.html`.
4. **Nav / chrome / header changes are global** — apply to all 8 pages, never
   just the named one. The canonical sidebar CSS block is identical everywhere
   (search `SIDEBAR NAV`).
5. **Commit** (short subject + bullet body; end with the `Co-Authored-By`
   trailer) and **push to `main`** (remember the `gh auth switch`). ~30s to live.
6. **Never** commit secrets, and leave the untracked `mockups/` dir alone.

**Adding a Projects file** is the one special workflow — see `CLAUDE.md` →
"Projects page — adding files."

---

## 5 · Next big build: BidPrime → RFP integration (Supabase hybrid)

> This is the full plan, brought over from the (non-transferring) plan file.
> Decisions below are already locked with Cameron.

### Context / goal
Cameron reviews every incoming RFP by hand on BidPrime. Goal: the dashboard
auto-ingests the RFPs matching TJA's criteria, **auto-creates a Scorecard entry
(PANTS + Investment) for each**, lets him triage + **deep-link back to BidPrime
without downloading files**, and (later) auto-scores with Claude. Build behind a
clean adapter boundary so Monday = "paste credentials + deploy."

### Locked decisions
- **Auto-create a Scorecard entry for every RFP**, then filter/sort to show only
  "Pursue" tier (or whichever tier selected).
- **Scoring is swappable** — placeholder now, flip on the Anthropic API later.
- **Backend = Supabase (hybrid).** Firebase Spark can't make outbound calls;
  Supabase free tier can (outbound + cron + Postgres). **Supabase runs only the
  RFP pipeline; the existing Firebase dashboard is untouched.** (Recommendation
  stands: do NOT migrate the whole app for this — hybrid only.)
- Volume ≈ **≤10 RFPs/day** → clean list, no heavy pagination.

### Architecture (three layers)
- **Supabase = the RFP feed, source of truth** (server-written, client
  read-only). Postgres `rfps` table = thin metadata + `source_url` + optional
  score JSON; **never the file or full text**. Edge Functions: `bidprime-webhook`
  (push receiver), `bidprime-pull` (scheduled backfill/reconciliation via
  pg_cron), scoring behind a swappable adapter. RLS: anon **select-only**; all
  writes via the service-role key inside functions.
- **Firebase = everything else, unchanged**, plus two *synced overlays*: a new
  `rfp_triage` SYNC_KEY (user's status/notes/promoted-flag per RFP id) and the
  auto-created records in the existing `scorecards` key. The client never writes
  to Supabase — triage writes stay on the familiar admin-gated Firebase path.
- **New page `rfp.html`** reads RFPs from Supabase (anon client) — or **bundled
  sample data when Supabase isn't configured** — merges the Firebase triage
  overlay, renders the inbox, deep-links to BidPrime, mirrors each RFP into
  `scorecards`.

### Build now (weekend) — needs no BidPrime access
1. **Supabase code** in `supabase/`: migration for the `rfps` table + RLS; Edge
   Functions `bidprime-webhook` + `bidprime-pull` against a **mock BidPrime
   adapter** (returns sample RFPs), with the **field normalizer isolated in one
   file** (documented payload assumptions); scoring adapter **stubbed**
   (unscored → renders "Pending"). A `supabase/README.md` with setup/deploy.
2. **`rfp.html` full UI**: reads through an `rfpSource` module (Supabase client
   if configured, else bundled samples). ≤10/day sizing — clean list + "new
   today" + filters (tier/Pursue, category, agency, due, triage status) + sort
   (due/score) + deep-link + triage actions writing `rfp_triage`. Reuse the
   `isAdmin()` `#authBar` scrape + `window.render` hook (copy from
   `forecast.html`).
3. **Auto-create Scorecard mirror**: per RFP, upsert `scorecards[key]`
   (`type:'rfp'`, source tag, `discretionaryRead` from summary/context, score if
   present). **Careful merge — never clobber a record that has `humanInputAt` or
   `override`** (scorecard `doImport` overwrites silently by client name). Dedup
   via a flag on the `rfp_triage` record. Key = opportunity title/agency
   (assumption — confirm).
4. **Scorecard filter/sort**: extend `scorecard.html`'s toolbar to filter by
   tier (Pursue/Qualify/Pass/Pending) and by source (RFP vs warm).
5. **Sidebar sweep + sync bump**: add the "RFPs" tab to all pages (same pattern
   as the Forecast tab add). `SYNC_KEYS` gains `rfp_triage` → `firebase-sync.js`
   **v27** + `diag.html` mirror + `?v=27` cache-buster on every page.

### Monday (the whole delta) — with BidPrime + Supabase access
- Real BidPrime **API base URL + token** → `bidprime-pull` adapter + Supabase secret.
- Finalize the **webhook normalizer** against the real payload; set the signature
  secret; point BidPrime's webhook at the deployed `bidprime-webhook` URL.
- **Create the Supabase project + apply migration + deploy Edge Functions + set
  the RFP page's Supabase URL + anon key** (uses Cameron's Supabase login).
- *(When ready)* add the Anthropic API key secret and flip the scoring adapter
  to the real Claude call.

### Reuse map (from codebase exploration)
- **Scorecard schema/insertion** (`scorecard.html`): `scorecards` object **keyed
  by client name**; minimum valid record = `{ client, pants|investment }`;
  `type:'rfp'` selects the 9-variable / 85-max Investment set; normalize via
  `_normalizeImportedRecord` (~L1889) / `doImport` (~L1985). PANTS keys:
  `price/authority/need/timeframe/suitability`. RFP Investment keys include
  `capabilityGate` + `responseBurden` (burden is inverted: high score = low
  burden). Merge must respect `humanInputAt` / `override`.
- **Cross-page "promote" pattern** (`outreach.html` `promoteProspect` ~L1282):
  read a foreign SYNC_KEY with a typed default → mutate → `localStorage.setItem`
  (the monkey-patch triggers the cloud write) → stamp a back-reference for dedup.
- **Auth/render**: no `db` or current-user is exposed to pages — scrape
  `#authBar` for `isAdmin()`; expose `window.render` to catch cloud updates.
  (`tja-sync-applied` is listened for but **never dispatched** — dead code, don't
  rely on it. The real re-render hook is `window.render` / `window.reloadFromLocalStorage`.)
- **Supabase read** = anon key + RLS select. (Not Firestore — `firebase-sync.js`
  exposes no collection-query capability at all; adding one would be new plumbing.)

### Verification
- **Weekend (local):** RFP page renders sample RFPs; filters/sort/triage work and
  `rfp_triage` round-trips; each sample RFP creates a `scorecards` entry visible
  on the Scorecard page and filterable to Pursue; **merge guard** — hand-score a
  sample record, re-run the mirror, confirm human input isn't overwritten;
  sidebar tab on all pages; mobile reflow.
- **Monday (live):** apply migration; deploy functions; POST a sample BidPrime
  payload to `bidprime-webhook` → row lands in `rfps` → RFP page shows it; run
  `bidprime-pull` for backfill; optionally flip scoring on and confirm a real
  PANTS score lands and mirrors to the Scorecard.

---

## 6 · Gotchas that will bite you
- **`gh` push access:** `Thejamesagency` (owner) + `thejamesagencyoperations`
  (collaborator, added 2026-07-24) can both push. Only `cameronvervecrm` 403s —
  if you see a 403, `gh auth switch --hostname github.com --user thejamesagencyoperations`.
- **Cache-buster discipline** — a sync-layer change without the `?v=NN` bump on
  every page means stale JS on phones (iOS Safari caches hard).
- **`SYNC_KEYS` lives in TWO files** — `firebase-sync.js` and `diag.html`. Keep
  them identical.
- **Firestore = one 1MB doc.** Don't dump large/volume data into a SYNC_KEY.
  (That's why Projects stores HTML in-repo and why RFPs go to Supabase.)
- **Never base a sync write on stale localStorage** — the WMJ-wipe incident on
  the sister portal project came from exactly that. Server-first.
- **`python3 -m http.server`** fails here (sandbox PermissionError). Use
  `npx serve`.
- **Preview screenshot compositor** occasionally sticks on a black frame — open
  a fresh tab / resize to unstick; the DOM is fine.

---

*End of handoff. Start by reading `CLAUDE.md`, then pick up at §3 (to-dos) or
§5 (RFP build) depending on whether BidPrime access has landed.*

# CLAUDE.md — TJA Dashboard

This file briefs future Claude sessions on the repo's conventions.

## Repo at a glance

Static HTML/CSS/JS dashboard deployed via GitHub Pages at
`https://thejamesagency.github.io/TJA-new-biz-dashboard/`. No build
step. Edits push to `main` → ~30s deploy.

### Pages
- `task-list.html` — Status Report (SR tasks)
- `weekly-priorities.html` — kanban + weekly notes
- `client-notes.html` — per-client notes cards
- `scorecard.html` — PANTS + Investment scoring
- `outreach.html` — cold-outbound pipeline
- `conversations.html` — email threads from `crm@thejamesagency.com`
- `projects.html` — HTML project files (Model C: repo + Firestore)
- `forecast.html` — new-biz revenue forecast scenarios (baseline from
  Emma's dynamic-forecast P&L + hypothetical Stratagem/project/retainer
  deals + "how many Stratagems?" solver)
- `diag.html` — sync diagnostics
- `index.html` — landing/redirect

### Sync
- All pages share `firebase-sync.js` (Firestore + persistent IndexedDB cache).
- Cross-device sync via a single workspace doc `workspaces/tja-main`.
- `SYNC_KEYS` array in `firebase-sync.js` lists every localStorage key
  that round-trips through Firestore.
- Bump the cache-buster `?v=NN` on every page's `firebase-sync.js`
  script tag when you change the sync layer or `SYNC_KEYS`.

### Auth
- Only `cameron@thejamesagency.com` has write access (gated in
  Firestore rules and re-checked client-side via `isAdmin()`).
- Other `@thejamesagency.com` users get read-only.

### Layout / nav rule (from memory)
- Chrome / nav / header changes apply **globally to every page**, not
  just the named one. When the user asks "change X on Y page" and X
  is the nav, treat it as a sweep.
- Nav is a **fixed left sidebar** (190px, `position:fixed`, brand
  stripe on the left edge, logo top → links → date + auth-bar bottom).
  Content offset via `body { padding-left: 190px }`. On ≤720px it
  collapses to a sticky top bar (row flex, horizontal scroll,
  nav-date hidden). The canonical CSS block is identical on all 8
  pages — search for "SIDEBAR NAV". Sidebar z-index 5000; modals stay
  at 10000.

### Brand
- TJA orange: `#FF7800` (from logo SVG, CMYK 0/53/98/0).
- Inter font, weights 300/400/500/600/700/900.
- Dark theme: bg `#161616`, card `#1c1c1c`, border `#2a2a2a`.

## Projects page — adding files (the unique workflow)

The Projects page (`projects.html`) uses a hybrid storage model:

- **HTML content** lives in the repo under `/projects/`. Served by
  GitHub Pages at its natural URL.
- **Display name, folder placement, archive flag** live in Firestore
  under `projects_data.fileOverrides`, keyed by stable file ID.

To add a new file (when the user pastes HTML and asks for it):

1. Decide on a kebab-case filename and a stable file ID:
   - Filename: `projects/<kebab-name>.html`
     (use a sub-folder like `projects/acme-corp/q3-proposal.html` if
     the user's prompt suggests one)
   - File ID: `file_` + 5–7 char random suffix
2. Write the HTML to that path.
3. Append an entry to `projects-manifest.json` under `files[]`:
   ```json
   {
     "id": "file_xyz12",
     "repoPath": "projects/acme-q3-proposal.html",
     "defaultName": "Acme Q3 Proposal",
     "addedAt": "<ISO timestamp>",
     "sizeBytes": <bytes>
   }
   ```
4. `git add` the new HTML file + the updated manifest.
5. Commit + push. ~30s later it shows on `projects.html`.

The user can rename / move / archive from the UI without you touching
the manifest. Only adding a brand-new file requires Claude.

## Where to look for behavior

- `firebase-sync.js` — sync layer, SYNC_KEYS, auth gating, version
  marker (`v26` or higher).
- `diag.html` — has its own SYNC_KEYS array (keep in sync).
- Each page's `<script>` block is self-contained — find function
  definitions inline.

## Commit message style

Past commits use a short subject + bullet list body. Example:

```
Conversations: archive instead of delete (✕ moves to Archived tab)

- Renamed conversations_hidden → conversations_archived in SYNC_KEYS.
- Sync layer bumped to v24, all 6 page cache-busters bumped to ?v=24.
- ...
```

Always end commits with the Co-Authored-By trailer.

## Never

- Don't commit secrets (service account keys, OAuth tokens). The
  `functions/.gitignore` covers the SA key.
- Don't add unrelated files when staging — the user has a `mockups/`
  dir that should stay untracked.
- Don't add markdown documentation files unless explicitly asked.

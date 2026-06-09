# /projects/ — HTML project files for the dashboard

This directory holds standalone HTML files that surface on the
dashboard's **Projects** page (`/projects.html`). Files in here are
served by GitHub Pages at their natural URL and rendered inside the
Projects page via an iframe.

## How files get here

You don't manually drop files in this folder. Instead:

1. **Paste the HTML into a Claude conversation** in this repo.
2. Tell Claude something like: *"Add this as a project file for Acme
   Corp's Q3 proposal."*
3. Claude does all of the following in one go:
   - Writes the HTML to `/projects/<kebab-name>.html`
   - Appends an entry to `/projects-manifest.json` with a stable file
     ID, the repo path, a default display name, and a timestamp
   - `git add` + `git commit` + `git push`

GitHub Pages picks it up within ~30 seconds. Your Projects page polls
the manifest on load and the new file appears automatically.

## How rename / folder / archive works

The manifest holds the **default** display name and the repo path.
Everything else — display name overrides, folder placement, archive
state — lives in Firestore under `projects_data.fileOverrides`, keyed
by the file's stable ID.

This means:
- **Renames** are instant from the UI — no git commit.
- **Moving** between folders is instant from the UI.
- **Archiving** is instant from the UI.
- The underlying HTML file never changes unless you ask Claude to
  edit it.

If you rename a file from the UI and a teammate visits the page on
their phone, they see the new name as soon as Firestore syncs (a
couple of seconds).

## Why this split

Storing the actual HTML in the repo (instead of in Firestore as in
the previous Model A approach) means:
- No file-size cap (GitHub Pages serves up to ~100 MB happily).
- Linked assets work — images, CSS, JS, fonts referenced with
  relative paths.
- Real shareable URLs you can paste in Slack / email.
- Full git history of every change.

Storing the metadata in Firestore means:
- Renames don't require a commit.
- Reorganizing folders is fast.
- The team-wide org structure is the same on every device, instantly.

## File layout suggestions

Use kebab-case filenames. Group by client / project where it makes
sense:

```
projects/
  README.md
  acme-corp/
    q3-proposal.html
    onboarding-deck.html
  internal/
    rate-card.html
  client-portal-demo.html
```

The folder structure in the repo is only a storage convenience — the
folder tree the user sees on the Projects page is independent and
lives in Firestore.

## Public access caveat

GitHub Pages serves these files publicly at their natural URL. The
URL is not guessable, but it's not behind auth either. **Don't put
anything truly confidential here** (NDA-grade client data, etc.).
Internal proposals, client-facing deliverables, and demos are fine.
For sensitive content, talk to Cameron about a Firebase Hosting +
auth-gated rewrite.

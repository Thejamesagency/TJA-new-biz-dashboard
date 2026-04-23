# Firestore Security Rules

Paste these into **Firebase console → Firestore Database → Rules tab** and click **Publish**.

## Rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /workspaces/{workspaceId} {
      // READ: anyone signed in with a verified @thejamesagency.com Google
      // account can read the workspace (view-only access for teammates).
      allow read: if request.auth != null
                  && request.auth.token.email_verified == true
                  && request.auth.token.email.matches('.*@thejamesagency[.]com$');

      // WRITE: only Cameron's email can modify the workspace.
      allow write: if request.auth != null
                   && request.auth.token.email == 'cameron@thejamesagency.com';
    }
  }
}
```

## What they do

- **Read**: any teammate who signs in with their own `@thejamesagency.com`
  Google account can load the dashboard data. They see everything you see,
  but can't save changes.
- **Write**: only `cameron@thejamesagency.com` can save. Attempts from any
  other email return a permission-denied error and roll back.

## Adding more admins later

When you want to let someone else (e.g. Veronique) write too, replace the
`write` clause with:

```
allow write: if request.auth != null
             && request.auth.token.email in [
                 'cameron@thejamesagency.com',
                 'veronique@thejamesagency.com'
               ];
```

Repaste → publish. Change is live in a few seconds.

## Going read-only for everyone

If you want to temporarily lock everyone out of writing (e.g. during a data
migration), change `write` to `allow write: if false;` and republish.

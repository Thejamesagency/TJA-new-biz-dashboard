// ════════════════════════════════════════════════════════════
//  TJA Dashboard ~ Firebase Auth + Firestore real-time sync
// ════════════════════════════════════════════════════════════
//  Loaded as a module from all three HTML pages. On sign-in
//  this module mirrors a specific set of localStorage keys to
//  a single Firestore document and listens for remote changes.
//
//  Design:
//    - Single shared workspace document: workspaces/tja-main
//    - Auth: Google sign-in, hint-scoped to thejamesagency.com
//    - Writes are debounced (~700 ms) so rapid edits batch
//    - localStorage.setItem / removeItem are monkey-patched to
//      auto-queue a cloud write whenever a synced key changes
//    - A snapshot listener applies remote changes back to local
//      and re-renders the page (if the page exposes render())
//    - On first sign-in we push the user's existing localStorage
//      up to Firestore iff the cloud is empty.
// ════════════════════════════════════════════════════════════

import { initializeApp }           from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
                                   from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp }
                                   from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAE9NAgJionL24LmGuWrh5Dnz8MVUAImsU",
  authDomain: "tja-new-biz-dashboard.firebaseapp.com",
  projectId: "tja-new-biz-dashboard",
  storageBucket: "tja-new-biz-dashboard.firebasestorage.app",
  messagingSenderId: "51662123848",
  appId: "1:51662123848:web:36173bd66975d81be2797d"
};

// All localStorage keys we mirror to the cloud.
// Deliberately EXCLUDES sr_dataVersion — that's a per-browser schema
// guard that must run independently on each browser on page load.
const SYNC_KEYS = [
  // Weekly Priorities
  "wp_weeks", "wp_current_week", "wp_selected_day", "wp_view_mode",
  // Status Report
  "sr_tasks", "sr_archived_tasks",
  "sr_taskTypeOptions", "sr_statusOptions", "sr_priorityOptions",
  // Priority Matrix
  "eisenhower_tasks", "eisenhower_am", "eisenhower_pm",
  "eisenhower_notes", "eisenhower_last_day", "eisenhower_last_seed_day"
];

const WORKSPACE_ID = "tja-main";

// Emails with write access. Keep in sync with the Firestore rules'
// `allow write` clause. Anyone else who signs in sees a read-only banner
// and their localStorage edits won't persist across reloads.
const ADMIN_EMAILS = new Set([
  "cameron@thejamesagency.com"
]);

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ hd: "thejamesagency.com" });

const workspaceRef = doc(db, "workspaces", WORKSPACE_ID);

let currentUser      = null;
let isApplyingRemote = false;   // guard: ignore setItem hooks while applying cloud state
let unsubscribe      = null;
let writeTimer       = null;

// ─── localStorage <-> plain object helpers ───────────────────
function dumpLocalToObject() {
  const o = {};
  for (const k of SYNC_KEYS) {
    const v = localStorage.getItem(k);
    if (v !== null) o[k] = v;
  }
  return o;
}

function applyCloudToLocal(data) {
  if (!data) return;
  isApplyingRemote = true;
  try {
    for (const k of SYNC_KEYS) {
      if (Object.prototype.hasOwnProperty.call(data, k)) {
        if (localStorage.getItem(k) !== data[k]) {
          localStorage.setItem(k, data[k]);
        }
      }
    }
  } finally {
    isApplyingRemote = false;
  }
}

function triggerReRender() {
  // Each page defines some subset of these globals. Missing ones are no-ops.
  try { if (typeof window.render        === "function") window.render(); }        catch (e) { console.warn("render failed", e); }
  try { if (typeof window.renderDaily   === "function") window.renderDaily(); }   catch (e) { console.warn("renderDaily failed", e); }
  try { if (typeof window.renderWpPanel === "function") window.renderWpPanel(); } catch (e) { console.warn("renderWpPanel failed", e); }
}

// ─── Cloud writes (debounced) ────────────────────────────────
function scheduleCloudWrite() {
  if (isApplyingRemote) return;
  if (!currentUser)     return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    try {
      await setDoc(workspaceRef, {
        data: dumpLocalToObject(),
        lastUpdated: serverTimestamp(),
        lastUpdatedBy: currentUser.email
      }, { merge: true });
    } catch (e) {
      console.error("[sync] cloud write failed:", e);
    }
  }, 700);
}

// Monkey-patch localStorage so every write to a synced key hits the cloud.
const origSetItem    = localStorage.setItem.bind(localStorage);
const origRemoveItem = localStorage.removeItem.bind(localStorage);
localStorage.setItem = function (k, v) {
  origSetItem(k, v);
  if (SYNC_KEYS.includes(k)) scheduleCloudWrite();
};
localStorage.removeItem = function (k) {
  origRemoveItem(k);
  if (SYNC_KEYS.includes(k)) scheduleCloudWrite();
};

// ─── Real-time snapshot listener ─────────────────────────────
function startListening() {
  if (unsubscribe) unsubscribe();
  unsubscribe = onSnapshot(
    workspaceRef,
    (snap) => {
      if (!snap.exists()) return;
      const d = snap.data();
      if (!d || !d.data) return;
      applyCloudToLocal(d.data);
      triggerReRender();
      updateAuthUI();
    },
    (err) => {
      console.error("[sync] snapshot listener error:", err);
    }
  );
}
function stopListening() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
}

// ─── First sign-in migration ─────────────────────────────────
async function maybeMigrateFirstSignIn(user) {
  try {
    const snap = await getDoc(workspaceRef);
    const cloudHasData =
      snap.exists() &&
      snap.data()?.data &&
      Object.keys(snap.data().data).length > 0;
    if (cloudHasData) return; // cloud wins, don't overwrite

    const local = dumpLocalToObject();
    if (Object.keys(local).length === 0) return; // nothing to migrate

    await setDoc(workspaceRef, {
      data: local,
      lastUpdated:           serverTimestamp(),
      lastUpdatedBy:         user.email,
      migratedFromLocalBy:   user.email,
      migratedAt:            serverTimestamp()
    }, { merge: true });
    console.log("[sync] first sign-in: pushed local data up to cloud");
  } catch (e) {
    console.error("[sync] first-sign-in migration failed:", e);
  }
}

// ─── Auth state ──────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  updateAuthUI();
  if (user) {
    await maybeMigrateFirstSignIn(user);
    startListening();
  } else {
    stopListening();
  }
});

// ─── Auth UI ─────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function canCurrentUserWrite() {
  return !!(currentUser && ADMIN_EMAILS.has(currentUser.email));
}

function updateAuthUI() {
  const el = document.getElementById("authBar");
  if (el) {
    if (currentUser) {
      const ro = !canCurrentUserWrite();
      const status = ro
        ? `<span class="auth-status auth-status-ro">👁️ View only &middot; ${escapeHtml(currentUser.email)}</span>`
        : `<span class="auth-status">☁️ Synced &middot; ${escapeHtml(currentUser.email)}</span>`;
      el.innerHTML =
        status +
        `<button class="auth-btn" id="authSignOutBtn" type="button">Sign out</button>`;
      const btn = document.getElementById("authSignOutBtn");
      if (btn) btn.addEventListener("click", handleSignOut);
    } else {
      el.innerHTML =
        `<span class="auth-status auth-status-local">💾 Local only (not synced)</span>` +
        `<button class="auth-btn auth-btn-primary" id="authSignInBtn" type="button">Sign in with Google</button>`;
      const btn = document.getElementById("authSignInBtn");
      if (btn) btn.addEventListener("click", handleSignIn);
    }
  }
  renderReadOnlyBanner();
}

// Inject a prominent amber banner at the top of the page when a non-admin
// user is signed in, so they don't get tricked by the optimistic local UI
// into thinking their edits are being saved.
function ensureReadOnlyStyles() {
  if (document.getElementById("readonlyBannerStyles")) return;
  const style = document.createElement("style");
  style.id = "readonlyBannerStyles";
  style.textContent = `
    .readonly-banner {
      background: #3a2d20;
      color: #f6ad55;
      padding: 0.55rem 1rem;
      text-align: center;
      font-size: 0.72rem;
      font-weight: 500;
      border-bottom: 1px solid #6b4a20;
      letter-spacing: 0.02em;
      position: relative;
    }
    .readonly-banner strong { color: #fcd34d; font-weight: 700; }
    .auth-status-ro { color: #f6ad55; }
  `;
  document.head.appendChild(style);
}

function renderReadOnlyBanner() {
  ensureReadOnlyStyles();
  let banner = document.getElementById("readonlyBanner");
  const shouldShow = currentUser && !canCurrentUserWrite();
  if (shouldShow) {
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "readonlyBanner";
      banner.className = "readonly-banner";
      banner.innerHTML =
        "👁️ <strong>View-only access</strong> — this dashboard is shared read-only with you. " +
        "Anything you type here stays on your device and will disappear on reload. " +
        "Contact Cameron if you need to edit.";
      if (document.body.firstChild) {
        document.body.insertBefore(banner, document.body.firstChild);
      } else {
        document.body.appendChild(banner);
      }
    }
    banner.style.display = "block";
  } else if (banner) {
    banner.style.display = "none";
  }
}

async function handleSignIn() {
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    console.error("[sync] sign-in error:", e);
    alert("Sign-in failed: " + (e.message || e.code || e));
  }
}

async function handleSignOut() {
  try { await signOut(auth); } catch (e) { console.error(e); }
  location.reload();
}

// Render auth UI as soon as the DOM is ready.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", updateAuthUI);
} else {
  updateAuthUI();
}

// ─── Console utilities (call from DevTools console) ──────────
// Force-push whatever's in THIS browser's localStorage to the cloud,
// overwriting whatever's there. Use when you want to make "this
// browser" the source of truth — e.g. migrating your local-file
// data over to the shared cloud.
window.fbForcePushLocal = async function () {
  if (!currentUser) {
    console.error("[sync] Not signed in — sign in first before forcing a push.");
    return false;
  }
  const local = dumpLocalToObject();
  const keyCount = Object.keys(local).length;
  if (!confirm(
    "Force-push this browser's localStorage (" + keyCount + " keys) to the cloud?\n\n" +
    "This will OVERWRITE any data currently in the cloud with what's in this browser."
  )) {
    console.log("[sync] cancelled");
    return false;
  }
  try {
    await setDoc(workspaceRef, {
      data: local,
      lastUpdated:        serverTimestamp(),
      lastUpdatedBy:      currentUser.email,
      forcePushedBy:      currentUser.email,
      forcePushedAt:      serverTimestamp()
    }, { merge: true });
    console.log("[sync] ✓ force-push complete. Reload any other device to see the new state.");
    return true;
  } catch (e) {
    console.error("[sync] force-push failed:", e);
    return false;
  }
};

// Peek at what THIS browser has in local (helpful for debugging).
window.fbPeekLocal = function () {
  const o = dumpLocalToObject();
  const sizes = {};
  for (const k in o) sizes[k] = o[k].length + " chars";
  console.log("[sync] local keys:", sizes);
  return o;
};

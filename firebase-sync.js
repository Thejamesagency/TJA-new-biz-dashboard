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
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
         getFirestore, doc, getDoc, getDocFromServer, setDoc, onSnapshot, serverTimestamp }
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
// Deliberately EXCLUDES:
//   - sr_dataVersion           — per-browser schema guard
//   - wp_current_week          — what week each device is currently viewing
//   - wp_selected_day          — which day in cascade per device
//   - wp_view_mode             — single-day vs full-week toggle per device
// Those last three are per-device UI state. Syncing them caused other
// users' clicks to snap the read-only viewer back to the admin's view —
// ("click Tuesday, snaps back to Monday").
const SYNC_KEYS = [
  // Weekly Priorities — DATA only, not UI state
  "wp_weeks",
  "wp_last_notes_rollover_week",
  "wp_last_backup_prompt_week",
  // Status Report
  "sr_tasks", "sr_archived_tasks",
  "sr_taskTypeOptions", "sr_statusOptions", "sr_priorityOptions",
  // Client Notes — keyed by client name, shared with Status Report's
  // 📝 icon on each row. client_groups holds the per-client bucket
  // (current / won / past / unsorted) so the Client Notes tabs filter
  // the same way on every device.
  "client_notes",
  "client_groups",
  // Clients the user explicitly deleted from the Client Notes view.
  // The card disappears but the underlying SR task is untouched.
  // Reappears on next save/group-change.
  "client_notes_hidden",
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

// Use IndexedDB-backed persistent cache so a setDoc that's still in flight
// when iOS Safari (or any browser) kills the tab gets queued durably and
// replays the next time the SDK is online. Without this, "user adds task,
// immediately swipes back / locks phone / refreshes" silently loses the
// edit. persistentMultipleTabManager handles the (very real) case where
// the user has the dashboard open in more than one tab on the same device
// — single-tab manager would reject the second tab and silently fall back
// to no-persistence, recreating the original mobile-write-loss symptom.
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    })
  });
  console.log("[sync] persistent IndexedDB cache enabled (multi-tab)");
} catch (e) {
  // Private mode, IndexedDB unavailable, etc — fall back so the page
  // still loads, but warn loudly because mobile writes are now fragile.
  console.warn("[sync] persistent cache unavailable, falling back to memory:", e);
  try { db = initializeFirestore(app, {}); }
  catch (_) { db = getFirestore(app); }
}
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
  // CRITICAL race guard. Background pulls (auto-pull tick, snapshot
  // listener replays from cache, etc.) can deliver cloud data that's
  // staler than our local state if a local write is currently queued
  // or in flight. If we apply the stale data, we erase the user's
  // just-added task — and worse, the queued setDoc will then dump
  // the just-erased localStorage back to cloud, completing the loop
  // and losing the edit everywhere.
  //
  // Diagnosed from a phone where: local=119570 + new task should have
  // been 119800. Auto-pull's getDocFromServer started ~5s before the
  // user tapped +, the network call resolved AFTER the add but with
  // pre-add cloud data, applyCloudToLocal happily overwrote local
  // back to 119570, then the queued setDoc shipped that 119570 to
  // cloud. Both ended at 119570 with the task vanished.
  //
  // Skipping here is safe: a fresh snapshot will fire the moment our
  // write confirms, and we'll reconcile then with everyone's edits
  // properly merged.
  const cloudWp = (data.wp_weeks || "").length;
  const localWp = (() => { try { return (localStorage.getItem("wp_weeks") || "").length; } catch { return -1; } })();
  if (writeTimer !== null || pendingWrites > 0) {
    _appendTrace({
      ev: 'apply_skip', why: 'local_write_pending',
      writeTimer: writeTimer !== null, pendingWrites,
      cloudWp, localWp
    });
    console.log("[sync] applyCloudToLocal SKIPPED — local write pending");
    return;
  }
  _appendTrace({ ev: 'apply_proceed', cloudWp, localWp, diff: cloudWp - localWp });
  isApplyingRemote = true;
  try {
    for (const k of SYNC_KEYS) {
      if (Object.prototype.hasOwnProperty.call(data, k)) {
        if (localStorage.getItem(k) !== data[k]) {
          localStorage.setItem(k, data[k]);
        }
      }
    }
    // Synchronously refresh the page's in-memory state from the just-
    // updated localStorage — even if the full re-render is about to be
    // deferred because the user is mid-keystroke. Without this, any
    // local edit that fires during the deferral reads stale in-memory
    // data and writes that staleness back to localStorage and cloud,
    // silently destroying the snapshot we just applied.
    try { if (typeof window.reloadStateFromLocalStorage === "function") window.reloadStateFromLocalStorage(); } catch (e) {}
  } finally {
    isApplyingRemote = false;
  }
}

// If the user is actively interacting with a form control (typing into a
// contenteditable, in a date picker, has a select dropdown open, etc.)
// we DEFER the cloud-triggered re-render until they blur. Otherwise the
// snapshot listener would rebuild the DOM underneath them and their
// date picker / typing / select would snap closed.
let reRenderDeferred   = false;
let deferredBlurListener = null;

function isUserInteracting() {
  const ae = document.activeElement;
  if (!ae || ae === document.body) return false;
  if (ae.isContentEditable) return true;
  const tag = ae.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
}

function performReRender() {
  try { if (typeof window.reloadFromLocalStorage === "function") window.reloadFromLocalStorage(); } catch (e) { console.warn("reloadFromLocalStorage failed", e); }
  try { if (typeof window.render        === "function") window.render(); }        catch (e) { console.warn("render failed", e); }
  try { if (typeof window.renderDaily   === "function") window.renderDaily(); }   catch (e) { console.warn("renderDaily failed", e); }
  try { if (typeof window.renderWpPanel === "function") window.renderWpPanel(); } catch (e) { console.warn("renderWpPanel failed", e); }
}

function triggerReRender() {
  if (isUserInteracting()) {
    if (!reRenderDeferred) {
      reRenderDeferred = true;
      // Poll after each focusout — when user finally drops focus on all
      // controls, run the queued re-render with the latest cloud state.
      deferredBlurListener = () => {
        // Wait a tick so document.activeElement reflects the post-focusout state
        setTimeout(() => {
          if (!isUserInteracting()) {
            document.removeEventListener("focusout", deferredBlurListener, true);
            deferredBlurListener = null;
            reRenderDeferred = false;
            performReRender();
          }
        }, 40);
      };
      document.addEventListener("focusout", deferredBlurListener, true);
    }
    return;
  }
  reRenderDeferred = false;
  if (deferredBlurListener) {
    document.removeEventListener("focusout", deferredBlurListener, true);
    deferredBlurListener = null;
  }
  performReRender();
}

// ─── Cloud writes (debounced) ────────────────────────────────
// Sync health state — surfaces visibly so silent failures (most often a
// permission-denied caused by signing in with the wrong Google account)
// can't silently destroy edits anymore.
let lastWriteError = null;       // last setDoc failure (Error)
let lastWriteAt    = 0;          // ms timestamp of last successful write
let pendingWrites  = 0;          // in-flight setDoc calls

function doCloudWriteNow() {
  if (isApplyingRemote) {
    _appendTrace({ ev: 'write_skip', why: 'isApplyingRemote' });
    return null;
  }
  if (!currentUser) {
    _appendTrace({ ev: 'write_skip', why: 'no_user' });
    return null;
  }
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  try {
    pendingWrites++;
    renderSyncStatus();
    const payload = dumpLocalToObject();
    const wpBytes = (payload.wp_weeks || "").length;
    const writeId = "w" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
    _appendTrace({ ev: 'write_start', id: writeId, wpBytes, by: currentUser.email });
    console.log("[sync] writing to cloud", "id=", writeId, "wp_weeks bytes=", wpBytes);
    return setDoc(workspaceRef, {
      data: payload,
      lastUpdated: serverTimestamp(),
      lastUpdatedBy: currentUser.email
    }, { merge: true })
      .then(() => {
        pendingWrites = Math.max(0, pendingWrites - 1);
        lastWriteAt = Date.now();
        _appendTrace({ ev: 'write_ok', id: writeId, wpBytes });
        console.log("[sync] write confirmed", "id=", writeId);
        if (lastWriteError) { lastWriteError = null; renderWriteErrorBanner(); }
        renderSyncStatus();
      })
      .catch(e => {
        pendingWrites = Math.max(0, pendingWrites - 1);
        const msg = e.code || e.message || String(e);
        _appendTrace({ ev: 'write_fail', id: writeId, err: msg });
        console.error("[sync] cloud write failed:", e);
        lastWriteError = e;
        renderWriteErrorBanner();
        renderSyncStatus();
      });
  } catch (e) {
    pendingWrites = Math.max(0, pendingWrites - 1);
    _appendTrace({ ev: 'write_throw', err: e.message || String(e) });
    console.error("[sync] cloud write failed:", e);
    lastWriteError = e;
    renderWriteErrorBanner();
    renderSyncStatus();
    return null;
  }
}

// Manually flush — invoked by the "Try again" button on the error banner.
window.fbForceSync = function () {
  if (!currentUser) {
    alert("Not signed in. Click 'Sign in with Google' in the top bar.");
    return;
  }
  doCloudWriteNow();
};

// Comprehensive sync diagnostic — call from browser console OR by tapping
// the 🔍 button in the auth bar. Two alerts: first one fires SYNCHRONOUSLY
// with everything we know without hitting the network (so the button never
// feels dead even if the cloud fetch hangs), then a second alert fires
// once the server fetch resolves with the cloud-vs-local comparison.
window.fbDiag = function () {
  let local;
  try {
    local = {
      version: "sync v8 (persistent cache, sync-first diag)",
      now: new Date().toISOString(),
      signedIn: !!currentUser,
      email: currentUser ? currentUser.email : null,
      isAdmin: canCurrentUserWrite(),
      lastWriteAt: lastWriteAt ? new Date(lastWriteAt).toISOString() : "(never)",
      lastWriteError: lastWriteError ? (lastWriteError.code || lastWriteError.message || String(lastWriteError)) : null,
      pendingWrites,
      writeTimerQueued: writeTimer !== null,
      cloudLastUpdatedAt: lastCloudUpdatedAt ? new Date(lastCloudUpdatedAt).toISOString() : "(never)",
      cloudLastUpdatedBy: lastCloudUpdatedBy || "(never)",
      snapshotListenerActive: !!unsubscribe,
      localStorageOK: false,
      indexedDBOK: false,
      wpWeeksBytes: 0,
    };
    try {
      const probe = "__fb_probe_" + Date.now();
      localStorage.setItem(probe, "1");
      local.localStorageOK = (localStorage.getItem(probe) === "1");
      localStorage.removeItem(probe);
    } catch (e) { local.localStorageOK = false; }
    local.indexedDBOK = !!window.indexedDB;
    local.wpWeeksBytes = (localStorage.getItem("wp_weeks") || "").length;
  } catch (e) {
    alert("fbDiag failed (sync part): " + (e.message || e));
    return;
  }

  // SYNCHRONOUS alert first — never hangs.
  const part1 =
    "1/2 LOCAL STATE\n" +
    "Version: " + local.version + "\n" +
    "Signed in: " + (local.email || "NO") + "\n" +
    "Admin: " + local.isAdmin + "\n" +
    "Last write: " + local.lastWriteAt + "\n" +
    "Last write error: " + (local.lastWriteError || "none") + "\n" +
    "Pending writes: " + local.pendingWrites + "\n" +
    "Write queued: " + local.writeTimerQueued + "\n" +
    "Cloud last update: " + local.cloudLastUpdatedAt + "\n" +
    "Cloud last writer: " + local.cloudLastUpdatedBy + "\n" +
    "Listener active: " + local.snapshotListenerActive + "\n" +
    "localStorage OK: " + local.localStorageOK + "\n" +
    "IndexedDB available: " + local.indexedDBOK + "\n" +
    "wp_weeks size: " + local.wpWeeksBytes + " bytes";
  console.log("===== fbDiag local =====", local);
  alert(part1);

  // ASYNC cloud fetch — separate alert when done.
  if (!currentUser) {
    alert("2/2 CLOUD: skipped (not signed in)");
    return;
  }
  getDocFromServer(workspaceRef).then(snap => {
    if (!snap.exists()) {
      alert("2/2 CLOUD: doc does not exist");
      return;
    }
    const d = snap.data();
    const cloudWp = d.data?.wp_weeks || "";
    const localWp = localStorage.getItem("wp_weeks") || "";
    const part2 =
      "2/2 CLOUD STATE\n" +
      "Cloud writer: " + (d.lastUpdatedBy || "?") + "\n" +
      "Cloud updated: " + (d.lastUpdated?.toMillis ? new Date(d.lastUpdated.toMillis()).toISOString() : "?") + "\n" +
      "Cloud wp_weeks: " + cloudWp.length + " bytes\n" +
      "Local wp_weeks: " + localWp.length + " bytes\n" +
      "Match: " + (cloudWp === localWp) + "\n" +
      (cloudWp === localWp ? "" : "DIFF: cloud is " + (cloudWp.length > localWp.length ? "LARGER" : "SMALLER") + " by " + Math.abs(cloudWp.length - localWp.length) + " bytes");
    console.log("===== fbDiag cloud =====", { cloudBytes: cloudWp.length, localBytes: localWp.length, match: cloudWp === localWp, by: d.lastUpdatedBy });
    alert(part2);
  }).catch(e => {
    console.error("fbDiag cloud fetch failed:", e);
    alert("2/2 CLOUD: fetch FAILED — " + (e.code || e.message || e));
  });
};

console.log("[sync] firebase-sync.js loaded — v19 (+ client_notes_hidden sync key)");
// Stamp the loaded version into localStorage so the diag page can prove
// which firebase-sync.js the dashboard is actually running (vs. some
// stale cached version Safari kept serving).
try {
  origSetItem('_fb_sync_loaded_version', 'v19');
  origSetItem('_fb_sync_loaded_at', new Date().toISOString());
  _appendTrace({ ev: 'sync_loaded', version: 'v19' });
} catch (e) {}

// Manually pull the latest cloud state and apply it locally. Useful when a
// device shows stale data and you want to confirm whether the cloud actually
// has newer state. Exposed on window so the toolbar button (and the console)
// can call it.
let lastCloudUpdatedAt = 0;     // ms timestamp from snapshot.lastUpdated
let lastCloudUpdatedBy = "";    // email

// Internal helper — pulls from SERVER (not cache) and applies. Returns
// true if anything actually changed locally so callers can show feedback.
async function _pullFromServer() {
  if (!currentUser) return { ok: false, reason: "not-signed-in" };
  const snap = await getDocFromServer(workspaceRef);
  if (!snap.exists()) return { ok: false, reason: "no-cloud-doc" };
  const d = snap.data() || {};
  if (d.lastUpdated && typeof d.lastUpdated.toMillis === "function") {
    lastCloudUpdatedAt = d.lastUpdated.toMillis();
  }
  lastCloudUpdatedBy = d.lastUpdatedBy || "";
  // Detect whether applyCloudToLocal will actually change anything.
  let changed = false;
  if (d.data) {
    for (const k of SYNC_KEYS) {
      if (Object.prototype.hasOwnProperty.call(d.data, k) &&
          localStorage.getItem(k) !== d.data[k]) {
        changed = true;
        break;
      }
    }
    applyCloudToLocal(d.data);
  }
  if (changed) triggerReRender();
  renderSyncStatus();
  return { ok: true, changed, lastCloudUpdatedAt, lastCloudUpdatedBy };
}

window.fbPullNow = async function () {
  if (!currentUser) {
    alert("Not signed in. Click 'Sign in with Google' in the top bar.");
    return;
  }
  try {
    const r = await _pullFromServer();
    if (!r.ok) {
      if (r.reason === "no-cloud-doc") alert("Cloud document doesn't exist yet — nothing to pull.");
      return;
    }
    console.log("[sync] manual pull complete. changed=", r.changed,
                "cloud lastUpdated=", new Date(r.lastCloudUpdatedAt).toISOString(),
                "by", r.lastCloudUpdatedBy);
    // Visible confirmation so the button doesn't feel like a no-op.
    if (typeof window.toast === "function") {
      window.toast(r.changed
        ? "✓ Pulled latest from cloud"
        : "✓ Already up to date");
    } else {
      // Fallback: temporarily flash the auth-bar dot.
      const dot = document.querySelector("#authBar .auth-status-dot");
      if (dot) {
        const prev = dot.className;
        dot.className = "auth-status-dot pending";
        setTimeout(() => { dot.className = prev; }, 600);
      }
    }
  } catch (e) {
    console.error("[sync] manual pull failed:", e);
    alert("Pull failed: " + (e.message || e.code || e));
  }
};

// Automatic safety-net pull: every 20s, fetch the latest cloud state and
// apply it. The onSnapshot listener should already keep us in sync, but
// this is a belt-and-suspenders guard against listener stalls (e.g. iOS
// background → foreground network reconnects, transient Firestore
// connection drops, etc).
//
// Critical: we MUST skip whenever local has uncommitted changes, otherwise
// fetching cloud will overwrite the user's just-typed edit before our
// debounced setDoc has even fired. Three guards:
//   - pendingWrites > 0   → setDoc in flight to server
//   - writeTimer != null  → setDoc queued behind 30ms debounce
//   - isUserInteracting() → user is mid-keystroke; render would interrupt
const AUTO_PULL_INTERVAL_MS = 20000;
setInterval(async () => {
  if (!currentUser) return;
  if (isUserInteracting()) return;
  if (pendingWrites > 0) return;
  if (writeTimer !== null) return;   // queued local write — would clobber it
  if (lastWriteError) return;
  try {
    const r = await _pullFromServer();
    if (r && r.ok && r.changed) {
      console.log("[sync] auto-pull picked up newer cloud state at",
        new Date(r.lastCloudUpdatedAt).toISOString(), "by", r.lastCloudUpdatedBy);
    }
  } catch (e) {
    // Stay quiet on transient failures — the next tick will retry.
    console.debug("[sync] auto-pull tick failed:", e);
  }
}, AUTO_PULL_INTERVAL_MS);

function scheduleCloudWrite() {
  if (isApplyingRemote) return;
  if (!currentUser)     return;
  if (writeTimer) clearTimeout(writeTimer);
  // Zero-delay coalesce: setTimeout(..., 0) still fires AFTER the current
  // synchronous block, so multiple setItem calls inside one save() helper
  // coalesce into a single cloud write (each call clears the previous
  // pending timer and queues a new one). Going to 0 closes the iOS race
  // where the user adds → swipes back / refreshes within the old 30ms
  // window before setDoc was ever invoked, losing the edit on the floor.
  writeTimer = setTimeout(() => { writeTimer = null; doCloudWriteNow(); renderSyncStatus(); }, 0);
  renderSyncStatus(); // surface "↑ Saving…" immediately
}

// Flush any pending cloud write whenever the tab loses focus / unloads.
// Mobile browsers (iOS Safari especially) are aggressive about pausing
// or killing background tabs without firing beforeunload — visibilitychange
// is the most reliable signal we get.
function _flushPendingWrite() {
  if (writeTimer && currentUser) doCloudWriteNow();
}
window.addEventListener("beforeunload", _flushPendingWrite);
window.addEventListener("pagehide", _flushPendingWrite);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    _flushPendingWrite();
  } else if (document.visibilityState === "visible" && currentUser) {
    // Tab is back — the snapshot listener may have stalled while we
    // were backgrounded (iOS Safari aggressively pauses tabs and the
    // Firestore websocket can drop). Force one explicit server pull
    // so we're definitely fresh before the user touches anything.
    _pullFromServer().catch(e => console.warn("[sync] visibility-resume pull failed", e));
  }
});
window.addEventListener("focus", () => {
  // Same idea but for desktop window-focus changes (alt-tab back to
  // the dashboard). Cheap if cloud hasn't moved — applyCloudToLocal
  // is a no-op when nothing differs.
  if (currentUser) {
    _pullFromServer().catch(e => console.warn("[sync] focus-resume pull failed", e));
  }
});
window.addEventListener("blur", _flushPendingWrite);

// Monkey-patch localStorage so every write to a synced key hits the cloud.
const origSetItem    = localStorage.setItem.bind(localStorage);
const origRemoveItem = localStorage.removeItem.bind(localStorage);

// In-flight diagnostic trail. Every meaningful sync event is appended
// to localStorage under '_fb_sync_trace' (using the un-patched setItem
// so it doesn't itself round-trip through Firestore). The diag page
// reads this list and displays it so we can see — chronologically —
// exactly what happened around a vanishing edit.
function _appendTrace(entry) {
  try {
    const raw = localStorage.getItem('_fb_sync_trace');
    let arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) arr = [];
    entry.t = new Date().toISOString();
    arr.push(entry);
    while (arr.length > 50) arr.shift();
    origSetItem('_fb_sync_trace', JSON.stringify(arr));
  } catch (e) { /* never let tracing break sync */ }
}
localStorage.setItem = function (k, v) {
  origSetItem(k, v);
  if (SYNC_KEYS.includes(k)) {
    _appendTrace({ ev: 'set', key: k, bytes: (v || '').length, applying: isApplyingRemote });
    scheduleCloudWrite();
  }
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
      // Capture cloud freshness so the auth bar can show "Cloud updated
      // X ago by <email>" — surfaces stale-laptop / out-of-sync conditions.
      if (d.lastUpdated && typeof d.lastUpdated.toMillis === "function") {
        lastCloudUpdatedAt = d.lastUpdated.toMillis();
      }
      lastCloudUpdatedBy = d.lastUpdatedBy || "";
      const md = snap.metadata || {};
      const wpBytes = (d.data.wp_weeks || "").length;
      _appendTrace({
        ev: 'snap',
        fromCache: !!md.fromCache,
        hasPendingWrites: !!md.hasPendingWrites,
        by: d.lastUpdatedBy || null,
        wpBytes
      });
      console.log("[sync] snapshot received",
        "fromCache=", md.fromCache,
        "hasPendingWrites=", md.hasPendingWrites,
        "by=", lastCloudUpdatedBy,
        "at=", new Date(lastCloudUpdatedAt).toISOString(),
        "wp_weeks bytes=", wpBytes);
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
      // On sign-out, clear any sync-error banner — it's no longer relevant.
      lastWriteError = null;
      renderWriteErrorBanner();
      el.innerHTML =
        `<span class="auth-status auth-status-local">💾 Local only (not synced)</span>` +
        `<button class="auth-btn auth-btn-primary" id="authSignInBtn" type="button">Sign in with Google</button>`;
      const btn = document.getElementById("authSignInBtn");
      if (btn) btn.addEventListener("click", handleSignIn);
    }
  }
  renderReadOnlyBanner();
  renderWriteErrorBanner();
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

    /* Loud red banner when a cloud write fails. Stays sticky at the top so
       it can't be missed on a phone screen. */
    .sync-error-banner {
      background: #7f1d1d;
      color: #fff;
      padding: 0.7rem 1rem;
      text-align: center;
      font-size: 0.78rem;
      font-weight: 600;
      border-bottom: 2px solid #fca5a5;
      letter-spacing: 0.02em;
      position: sticky;
      top: 0;
      z-index: 9999;
      line-height: 1.4;
    }
    .sync-error-banner strong { color: #fecaca; }
    .sync-error-banner .sync-error-actions {
      display: inline-flex;
      gap: 0.4rem;
      margin-left: 0.6rem;
      flex-wrap: wrap;
      justify-content: center;
    }
    .sync-error-banner button {
      background: #fff;
      color: #7f1d1d;
      border: none;
      border-radius: 4px;
      padding: 0.25rem 0.7rem;
      font-size: 0.7rem;
      font-weight: 700;
      cursor: pointer;
      font-family: inherit;
    }
    .sync-error-banner button:hover { background: #fecaca; }

    /* Status dot inside the auth-bar — green when synced, amber when pending,
       red when last write failed. */
    .auth-status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 4px;
      vertical-align: middle;
    }
    .auth-status-dot.ok      { background: #22c55e; }
    .auth-status-dot.pending { background: #f59e0b; animation: authDotPulse 1s ease-in-out infinite; }
    .auth-status-dot.err     { background: #ef4444; }
    @keyframes authDotPulse { 0%,100%{opacity:1;} 50%{opacity:0.35;} }

    .auth-btn.auth-btn-pull {
      padding: 0.25rem 0.55rem;
      font-size: 0.85rem;
      line-height: 1;
      min-width: 28px;
    }
    .auth-cloud-meta {
      display: block;
      font-size: 0.55rem;
      font-weight: 400;
      color: #777;
      margin-top: 1px;
      letter-spacing: 0;
      text-transform: none;
    }
  `;
  document.head.appendChild(style);
}

// Loud red banner when the most recent cloud write was rejected. Most
// common cause: signed in with a Google account that isn't an admin in
// the Firestore rules, so the local optimistic UI lies about persistence.
function renderWriteErrorBanner() {
  ensureReadOnlyStyles();
  let banner = document.getElementById("syncErrorBanner");
  const shouldShow = !!lastWriteError && !!currentUser;
  if (!shouldShow) {
    if (banner) banner.remove();
    return;
  }

  const code  = (lastWriteError && lastWriteError.code) || "";
  const email = currentUser ? currentUser.email : "(unknown)";
  const isPerm = code === "permission-denied";

  const msg = isPerm
    ? `<strong>⚠ YOUR EDITS ARE NOT SAVING.</strong> ` +
      `Signed in as <strong>${escapeHtml(email)}</strong>, but only <strong>cameron@thejamesagency.com</strong> can write to this workspace. ` +
      `Sign out and sign back in with the correct Google account.`
    : `<strong>⚠ Sync error — your edits may not be saving.</strong> ` +
      `(${escapeHtml(code || "unknown")}) ` +
      `Signed in as <strong>${escapeHtml(email)}</strong>. Try the buttons below or check your network.`;

  if (!banner) {
    banner = document.createElement("div");
    banner.id = "syncErrorBanner";
    banner.className = "sync-error-banner";
    if (document.body.firstChild) {
      document.body.insertBefore(banner, document.body.firstChild);
    } else {
      document.body.appendChild(banner);
    }
  }
  banner.innerHTML =
    msg +
    `<span class="sync-error-actions">` +
      `<button type="button" id="syncErrRetryBtn">Try again</button>` +
      (currentUser
        ? `<button type="button" id="syncErrSignOutBtn">Sign out</button>`
        : "") +
    `</span>`;
  const retry = document.getElementById("syncErrRetryBtn");
  if (retry) retry.addEventListener("click", () => doCloudWriteNow());
  const so = document.getElementById("syncErrSignOutBtn");
  if (so) so.addEventListener("click", handleSignOut);
}

// No-op stub. Earlier versions repainted a fancy timestamp + dot status
// into the auth bar; the simpler "☁️ Synced · email" rendered by
// updateAuthUI() is what users actually wanted, so we keep call sites
// referencing renderSyncStatus() but don't render anything extra here.
function renderSyncStatus() {}

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

// ════════════════════════════════════════════════════════════
//  CROSS-PAGE CASCADE HELPERS
//  Every task CRUD handler (add / delete / mark-done) on every page
//  calls into these helpers so links stay consistent. Exposed on
//  `window` so the regular (non-module) page scripts can call them.
// ════════════════════════════════════════════════════════════

function _safeParse(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch (e) { return fallback; }
}
function _randomUid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Delete all items LINKED to a source task, on the OTHER pages, without
// touching the source task itself. Called before deleting or completing
// the source — or as a "strip siblings" op.
//
// sourceType: 'sr' | 'matrix' | 'weekly'
// sourceId:   task id string
function _cascadeDeleteSiblings(sourceType, sourceId) {
  let matrix = _safeParse("eisenhower_tasks", []);

  // Which matrix tasks do we need to cascade-remove?
  let matrixIdsToRemove = [];
  if (sourceType === "sr") {
    matrixIdsToRemove = matrix.filter(t => t.srSourceId === sourceId).map(t => t.id);
  } else if (sourceType === "weekly") {
    // Find the weekly task & pick up its matrixSourceId
    const weeks = _safeParse("wp_weeks", {});
    Object.values(weeks).forEach(week => {
      if (!week || !week.days) return;
      Object.values(week.days).forEach(day => {
        if (!day || !day.priorities) return;
        day.priorities.forEach(t => {
          if (t.id === sourceId && t.matrixSourceId) matrixIdsToRemove.push(t.matrixSourceId);
        });
      });
    });
  }

  // Strip those matrix tasks
  if (matrixIdsToRemove.length) {
    matrix = matrix.filter(t => !matrixIdsToRemove.includes(t.id));
    localStorage.setItem("eisenhower_tasks", JSON.stringify(matrix));
  }

  // Strip AM/PM items that pointed at those matrix tasks OR at the source
  ["eisenhower_am", "eisenhower_pm"].forEach(key => {
    let items = _safeParse(key, []);
    const before = items.length;
    items = items.filter(i => {
      if (matrixIdsToRemove.includes(i.sourceTaskId)) return false;
      if (sourceType === "matrix" && i.sourceTaskId === sourceId) return false;
      if (sourceType === "weekly" && i.wpSourceId === sourceId) return false;
      return true;
    });
    if (items.length !== before) localStorage.setItem(key, JSON.stringify(items));
  });

  // Strip weekly tasks linked to the source
  const weeks = _safeParse("wp_weeks", {});
  let wpChanged = false;
  Object.values(weeks).forEach(week => {
    if (!week || !week.days) return;
    Object.values(week.days).forEach(day => {
      if (!day || !Array.isArray(day.priorities)) return;
      const before = day.priorities.length;
      day.priorities = day.priorities.filter(t => {
        // Never delete the source task itself here
        if (sourceType === "weekly" && t.id === sourceId) return true;
        if (sourceType === "sr" && t.srSourceId === sourceId) return false;
        if (sourceType === "matrix" && t.matrixSourceId === sourceId) return false;
        if (matrixIdsToRemove.includes(t.matrixSourceId)) return false;
        return true;
      });
      if (day.priorities.length !== before) wpChanged = true;
    });
  });
  if (wpChanged) localStorage.setItem("wp_weeks", JSON.stringify(weeks));
}

// Mark every LINKED task on other pages as done/completed, without
// touching the source task. Used on "mark complete" so linked items stay
// visible but striked out, matching our per-page "done" UX.
function _cascadeMarkSiblingsDone(sourceType, sourceId) {
  let matrix = _safeParse("eisenhower_tasks", []);

  // Matrix tasks to mark completed
  let matrixIdsToMark = [];
  if (sourceType === "sr") {
    matrixIdsToMark = matrix.filter(t => t.srSourceId === sourceId && !t.completed).map(t => t.id);
  } else if (sourceType === "weekly") {
    const weeks = _safeParse("wp_weeks", {});
    Object.values(weeks).forEach(week => {
      if (!week || !week.days) return;
      Object.values(week.days).forEach(day => {
        if (!day || !day.priorities) return;
        day.priorities.forEach(t => {
          if (t.id === sourceId && t.matrixSourceId) matrixIdsToMark.push(t.matrixSourceId);
        });
      });
    });
  }
  if (matrixIdsToMark.length) {
    matrix.forEach(t => { if (matrixIdsToMark.includes(t.id)) t.completed = true; });
    localStorage.setItem("eisenhower_tasks", JSON.stringify(matrix));
  }

  // AM/PM items: mark completed if pointing at the source or the matrix tasks we just marked
  ["eisenhower_am", "eisenhower_pm"].forEach(key => {
    let items = _safeParse(key, []);
    let changed = false;
    items.forEach(i => {
      let shouldMark = false;
      if (matrixIdsToMark.includes(i.sourceTaskId)) shouldMark = true;
      if (sourceType === "matrix" && i.sourceTaskId === sourceId) shouldMark = true;
      if (sourceType === "weekly" && i.wpSourceId    === sourceId) shouldMark = true;
      if (shouldMark && !i.completed) { i.completed = true; changed = true; }
    });
    if (changed) localStorage.setItem(key, JSON.stringify(items));
  });

  // Weekly tasks linked to source: set status='done'
  const weeks = _safeParse("wp_weeks", {});
  let wpChanged = false;
  Object.values(weeks).forEach(week => {
    if (!week || !week.days) return;
    Object.values(week.days).forEach(day => {
      if (!day || !Array.isArray(day.priorities)) return;
      day.priorities.forEach(t => {
        if (sourceType === "weekly" && t.id === sourceId) return; // source
        let shouldMark = false;
        if (sourceType === "sr"     && t.srSourceId     === sourceId) shouldMark = true;
        if (sourceType === "matrix" && t.matrixSourceId === sourceId) shouldMark = true;
        if (matrixIdsToMark.includes(t.matrixSourceId)) shouldMark = true;
        if (shouldMark && t.status !== "done") { t.status = "done"; wpChanged = true; }
      });
    });
  });
  if (wpChanged) localStorage.setItem("wp_weeks", JSON.stringify(weeks));
}

// ── Matrix ─────────────────────────────────────────────────────
window.tjaDeleteMatrixTaskCascade = function (matrixId) {
  _cascadeDeleteSiblings("matrix", matrixId);
  let matrix = _safeParse("eisenhower_tasks", []);
  matrix = matrix.filter(t => t.id !== matrixId);
  localStorage.setItem("eisenhower_tasks", JSON.stringify(matrix));
};
window.tjaCompleteMatrixTaskCascade = function (matrixId) {
  // Mark the matrix task completed, and propagate "done" to linked AM/PM + Weekly (no delete).
  let matrix = _safeParse("eisenhower_tasks", []);
  const mt = matrix.find(t => t.id === matrixId);
  if (mt) mt.completed = true;
  localStorage.setItem("eisenhower_tasks", JSON.stringify(matrix));
  _cascadeMarkSiblingsDone("matrix", matrixId);
};

// ── Weekly ─────────────────────────────────────────────────────
window.tjaDeleteWeeklyTaskCascade = function (weeklyId) {
  _cascadeDeleteSiblings("weekly", weeklyId);
  const weeks = _safeParse("wp_weeks", {});
  Object.values(weeks).forEach(week => {
    if (!week || !week.days) return;
    Object.values(week.days).forEach(day => {
      if (!day || !Array.isArray(day.priorities)) return;
      day.priorities = day.priorities.filter(t => t.id !== weeklyId);
    });
  });
  localStorage.setItem("wp_weeks", JSON.stringify(weeks));
};
window.tjaCompleteWeeklyTaskCascade = function (weeklyId) {
  // Weekly source task itself goes to status='done' and stays visible (strikethrough).
  // Linked Matrix + AM/PM get marked completed (also stay visible).
  const weeks = _safeParse("wp_weeks", {});
  Object.values(weeks).forEach(week => {
    if (!week || !week.days) return;
    Object.values(week.days).forEach(day => {
      if (!day || !Array.isArray(day.priorities)) return;
      const t = day.priorities.find(t => t.id === weeklyId);
      if (t) t.status = "done";
    });
  });
  localStorage.setItem("wp_weeks", JSON.stringify(weeks));
  _cascadeMarkSiblingsDone("weekly", weeklyId);
};

// ── SR ─────────────────────────────────────────────────────────
// action: 'delete' (strip entirely, wipe linked) | 'archive' (move to archive, mark-done linked)
window.tjaDeleteOrArchiveSrTaskCascade = function (srId, action) {
  if (action === "delete") {
    _cascadeDeleteSiblings("sr", srId);
  } else {
    // archive = mark linked tasks done, don't delete them
    _cascadeMarkSiblingsDone("sr", srId);
  }
  let srTasks    = _safeParse("sr_tasks", []);
  let srArchived = _safeParse("sr_archived_tasks", []);
  const idx = srTasks.findIndex(s => s.id === srId);
  if (idx >= 0) {
    const [sr] = srTasks.splice(idx, 1);
    if (action === "archive") {
      sr.status = sr.status === "Dead Deal" ? "Dead Deal" : "Done";
      srArchived.push(sr);
      localStorage.setItem("sr_archived_tasks", JSON.stringify(srArchived));
    }
    localStorage.setItem("sr_tasks", JSON.stringify(srTasks));
  } else {
    // If already in archive, just remove from archive on 'delete'
    if (action === "delete") {
      const aIdx = srArchived.findIndex(s => s.id === srId);
      if (aIdx >= 0) {
        srArchived.splice(aIdx, 1);
        localStorage.setItem("sr_archived_tasks", JSON.stringify(srArchived));
      }
    }
  }
};

// ── SR → Weekly auto-sync ──────────────────────────────────────
// For every Status Report task with a due date, ensure a corresponding
// Weekly Priorities task exists on that day's AM section, linked via
// srSourceId. Idempotent: running it many times is safe; only creates
// missing tasks and updates titles. Doesn't move tasks across days
// after creation (user's manual placement wins).
//
// Past-due active SR tasks land on TODAY (so user can see overdue work
// without navigating to old weeks). Weekend due dates snap to the
// following Monday.
window.tjaSyncSrToWeekly = function () {
  let srTasks = [];
  try { srTasks = JSON.parse(localStorage.getItem("sr_tasks") || "[]"); } catch (e) {}
  if (!srTasks.length) return;

  let weeks;
  try { weeks = JSON.parse(localStorage.getItem("wp_weeks") || "{}") || {}; } catch (e) { weeks = {}; }

  // Index existing weekly tasks by srSourceId
  const linked = {};
  Object.keys(weeks).forEach(wk => {
    const w = weeks[wk];
    if (!w || !w.days) return;
    Object.keys(w.days).forEach(dk => {
      const day = w.days[dk];
      if (!day || !Array.isArray(day.priorities)) return;
      day.priorities.forEach(t => {
        if (t.srSourceId) linked[t.srSourceId] = { weekKey: wk, dayKey: dk, task: t };
      });
    });
  });

  // Build helper: today's ISO + Monday-of-today
  const now = new Date();
  const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const pad = n => (n < 10 ? "0" + n : "" + n);
  const isoOf = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const todayIso = isoOf(todayLocal);

  function targetForDueDate(dueRaw) {
    const datePart = (dueRaw || "").split("T")[0];
    if (!datePart) return null;
    const parts = datePart.split("-");
    if (parts.length !== 3) return null;
    let target = new Date(parseInt(parts[0],10), parseInt(parts[1],10) - 1, parseInt(parts[2],10));
    if (isNaN(target.getTime())) return null;
    // If the due date is in the past, put it on today (overdue handling)
    if (isoOf(target) < todayIso) target = new Date(todayLocal);
    // Snap weekend to next Monday
    let dow = target.getDay();
    if (dow === 0)      target.setDate(target.getDate() + 1); // Sun → Mon
    else if (dow === 6) target.setDate(target.getDate() + 2); // Sat → Mon
    dow = target.getDay();
    if (dow < 1 || dow > 5) return null;
    const dayKey = ["monday","tuesday","wednesday","thursday","friday"][dow - 1];
    // Compute Monday of that week
    const mon = new Date(target);
    const diff = 1 - dow;
    mon.setDate(mon.getDate() + diff);
    return { weekKey: isoOf(mon), dayKey, fridayIso: isoOf(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 4)) };
  }

  function timeFromDue(dueRaw) {
    const parts = (dueRaw || "").split("T");
    if (parts.length < 2) return "";
    const t = parts[1];
    if (!t) return "";
    const [hh, mm] = t.split(":");
    const h = parseInt(hh, 10);
    if (isNaN(h)) return "";
    const ampm = h >= 12 ? "pm" : "am";
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return hour12 + ":" + (mm || "00") + " " + ampm;
  }

  let changed = false;
  srTasks.forEach(sr => {
    if (!sr.dueDate) return; // skip SR tasks without a due date
    const target = targetForDueDate(sr.dueDate);
    if (!target) return;
    const existing = linked[sr.id];
    if (existing) {
      // Already in weekly somewhere — just sync the title (don't move days)
      if (existing.task.title !== sr.client) {
        existing.task.title = sr.client;
        changed = true;
      }
      return;
    }
    // Create a new weekly task on the target day's AM section
    if (!weeks[target.weekKey]) {
      weeks[target.weekKey] = {
        startDate: target.weekKey,
        endDate:   target.fridayIso,
        days: { monday:{priorities:[]}, tuesday:{priorities:[]}, wednesday:{priorities:[]}, thursday:{priorities:[]}, friday:{priorities:[]} },
        sections: { whereNeedHelp:[], thingsMightComeUp:[], potentialFollowUps:[], winsLastWeek:[] },
        pushedToMatrix: false
      };
    }
    if (!weeks[target.weekKey].days)                  weeks[target.weekKey].days = {};
    if (!weeks[target.weekKey].days[target.dayKey])   weeks[target.weekKey].days[target.dayKey] = { priorities: [] };
    if (!Array.isArray(weeks[target.weekKey].days[target.dayKey].priorities))
      weeks[target.weekKey].days[target.dayKey].priorities = [];

    weeks[target.weekKey].days[target.dayKey].priorities.push({
      id: _randomUid(),
      title: sr.client || "Untitled",
      owner: "Cameron",
      support: [],
      timeSlot: timeFromDue(sr.dueDate),
      notes: sr.desc || "",
      half: "am",
      status: "pending",
      srSourceId: sr.id,
      matrixSourceId: null,
      rolledFrom: null,
      createdAt: Date.now()
    });
    changed = true;
  });

  if (changed) localStorage.setItem("wp_weeks", JSON.stringify(weeks));
};

// Create a Weekly task on TODAY linked to a Matrix task. Returns the new
// weekly id (or null if something went wrong). Half defaults to AM before
// noon, PM after.
window.tjaCreateLinkedWeeklyTask = function (title, opts) {
  opts = opts || {};
  const today  = new Date();
  const dow    = today.getDay(); // 0 Sun .. 6 Sat
  let anchor   = new Date(today);
  const DAY_KEYS = ["monday","tuesday","wednesday","thursday","friday"];
  let dayKey;
  if (dow === 0)      { anchor.setDate(today.getDate() - 2); dayKey = "friday"; }
  else if (dow === 6) { anchor.setDate(today.getDate() - 1); dayKey = "friday"; }
  else                { dayKey = DAY_KEYS[dow - 1]; }

  // Monday of anchor week
  const monday = new Date(anchor);
  const mdow   = monday.getDay();
  const diff   = mdow === 0 ? -6 : 1 - mdow;
  monday.setDate(monday.getDate() + diff);
  const pad = n => (n < 10 ? "0" + n : "" + n);
  const mondayIso = monday.getFullYear() + "-" + pad(monday.getMonth() + 1) + "-" + pad(monday.getDate());

  // Compute Friday for endDate
  const friday = new Date(monday);
  friday.setDate(friday.getDate() + 4);
  const fridayIso = friday.getFullYear() + "-" + pad(friday.getMonth() + 1) + "-" + pad(friday.getDate());

  const half = opts.half === "pm" ? "pm"
             : opts.half === "am" ? "am"
             : (new Date().getHours() < 12 ? "am" : "pm");

  const weeks = _safeParse("wp_weeks", {});
  if (!weeks[mondayIso]) {
    weeks[mondayIso] = {
      startDate: mondayIso,
      endDate:   fridayIso,
      days: { monday:{priorities:[]}, tuesday:{priorities:[]}, wednesday:{priorities:[]}, thursday:{priorities:[]}, friday:{priorities:[]} },
      sections: { whereNeedHelp:[], thingsMightComeUp:[], potentialFollowUps:[], winsLastWeek:[] },
      pushedToMatrix: false
    };
  }
  if (!weeks[mondayIso].days)             weeks[mondayIso].days = {};
  if (!weeks[mondayIso].days[dayKey])     weeks[mondayIso].days[dayKey] = { priorities: [] };
  if (!Array.isArray(weeks[mondayIso].days[dayKey].priorities))
    weeks[mondayIso].days[dayKey].priorities = [];

  const wpId = _randomUid();
  weeks[mondayIso].days[dayKey].priorities.push({
    id: wpId,
    title: title || "Untitled",
    owner: opts.owner || "Cameron",
    support: [],
    timeSlot: "",
    notes: opts.notes || "",
    half: half,
    status: "pending",
    srSourceId:     opts.srSourceId     || null,
    matrixSourceId: opts.matrixSourceId || null,
    rolledFrom: null,
    createdAt: Date.now()
  });
  localStorage.setItem("wp_weeks", JSON.stringify(weeks));
  return wpId;
};

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

// ════════════════════════════════════════════════════════════
//  BACKUP / RESTORE SYSTEM
// ════════════════════════════════════════════════════════════
//  Every page load snapshots the current SYNC_KEYS state to a
//  timestamped localStorage key (wp_backup_<ISO>). We keep the
//  last 6 auto-backups. A manual "download JSON" and a
//  "restore from backup" console command round it out.
//
//  Backups live OUTSIDE SYNC_KEYS — so they don't round-trip
//  through Firestore and stay private to this browser.
// ════════════════════════════════════════════════════════════

const BACKUP_PREFIX = "wp_backup_";
const BACKUP_MAX    = 6;

function _snapshotAllSyncedKeys() {
  const out = {};
  for (const k of SYNC_KEYS) {
    const v = localStorage.getItem(k);
    if (v !== null) out[k] = v;
  }
  out.__takenAt = new Date().toISOString();
  return out;
}

function _listBackupKeys() {
  return Object.keys(localStorage)
    .filter(k => k.indexOf(BACKUP_PREFIX) === 0)
    .sort();
}

function _pruneBackups() {
  const keys = _listBackupKeys();
  while (keys.length > BACKUP_MAX) {
    const oldest = keys.shift();
    try { localStorage.removeItem(oldest); } catch (e) {}
  }
}

function _autoBackupOnce() {
  try {
    // Skip if we already took one in the last 4 hours
    const keys = _listBackupKeys();
    if (keys.length > 0) {
      const lastIso = keys[keys.length - 1].replace(BACKUP_PREFIX, "").replace(/-/g, ":");
      const lastTs  = Date.parse(lastIso);
      if (!isNaN(lastTs) && (Date.now() - lastTs) < 4 * 60 * 60 * 1000) return;
    }
    const snapshot = _snapshotAllSyncedKeys();
    const key = BACKUP_PREFIX + new Date().toISOString().replace(/[:.]/g, "-");
    localStorage.setItem(key, JSON.stringify(snapshot));
    _pruneBackups();
    console.log("[backup] auto-saved:", key);
  } catch (e) {
    console.warn("[backup] auto-save failed:", e);
  }
}

// Wait ~3s after load so cloud sync has a chance to land fresh data first,
// then take the backup. Otherwise we'd snapshot whatever stale local state
// was there at page load.
setTimeout(_autoBackupOnce, 3000);

window.fbListBackups = function () {
  const keys = _listBackupKeys();
  if (keys.length === 0) { console.log("[backup] no backups on this browser yet"); return []; }
  console.log("[backup] " + keys.length + " backups available (newest last):");
  keys.forEach(k => {
    try {
      const data = JSON.parse(localStorage.getItem(k));
      const taken = data.__takenAt || "?";
      const weeks = data.wp_weeks ? Object.keys(JSON.parse(data.wp_weeks)).length : 0;
      console.log("  " + k + "   taken: " + taken + "   weeks: " + weeks);
    } catch (e) {
      console.log("  " + k + "   (couldn't parse)");
    }
  });
  return keys;
};

window.fbRestoreBackup = function (key) {
  if (!key) {
    console.error("[backup] pass a key: fbRestoreBackup('wp_backup_2026-04-24T...')");
    return;
  }
  const data = localStorage.getItem(key);
  if (!data) { console.error("[backup] no such backup: " + key); return; }
  if (!confirm("Restore from " + key + "?\n\nThis overwrites your current state AND pushes to the cloud after sign-in.")) return;
  try {
    const snapshot = JSON.parse(data);
    for (const k in snapshot) {
      if (k.indexOf("__") === 0) continue;
      localStorage.setItem(k, snapshot[k]);
    }
    console.log("[backup] restored:", key);
    setTimeout(() => location.reload(), 300);
  } catch (e) {
    console.error("[backup] restore failed:", e);
  }
};

// Manually take a named backup RIGHT NOW (bypasses the 4-hour cooldown).
window.fbBackupNow = function () {
  const snapshot = _snapshotAllSyncedKeys();
  const key = BACKUP_PREFIX + new Date().toISOString().replace(/[:.]/g, "-");
  localStorage.setItem(key, JSON.stringify(snapshot));
  _pruneBackups();
  console.log("[backup] saved:", key);
  return key;
};

// Download the current state as a JSON file (cross-device safety net).
window.fbDownloadBackup = function () {
  const snapshot = _snapshotAllSyncedKeys();
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = "tja-dashboard-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  console.log("[backup] download triggered");
};

// ─── CSV export ──────────────────────────────────────────────
// Flatten Weekly tasks + Status Report tasks into a single human-readable
// CSV. Lossy (drops chip colors, IDs, etc.) but opens cleanly in Excel.
function _csvEsc(v) {
  const s = String(v == null ? "" : v);
  if (s.indexOf('"') >= 0 || s.indexOf(",") >= 0 || s.indexOf("\n") >= 0) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function _buildCsvString() {
  const rows = [[
    "source", "week", "day", "half", "title_or_client", "owner",
    "support", "status", "time_slot", "due_date", "priority", "notes"
  ]];

  // Weekly tasks
  const weeks = _safeParse("wp_weeks", {});
  Object.keys(weeks).sort().forEach(mondayIso => {
    const w = weeks[mondayIso];
    if (!w || !w.days) return;
    ["monday", "tuesday", "wednesday", "thursday", "friday"].forEach(dayKey => {
      const day = w.days[dayKey];
      if (!day || !Array.isArray(day.priorities)) return;
      day.priorities.forEach(t => {
        rows.push([
          "weekly",
          mondayIso,
          dayKey,
          t.half || "",
          t.title || "",
          t.owner || "",
          Array.isArray(t.support) ? t.support.join(", ") : "",
          t.status || "",
          t.timeSlot || "",
          "",
          "",
          t.notes || ""
        ]);
      });
    });
    // Weekly notes (sections)
    const sections = w.sections || {};
    Object.keys(sections).forEach(sectionKey => {
      (sections[sectionKey] || []).forEach(item => {
        rows.push([
          "weekly-notes:" + sectionKey,
          mondayIso, "", "",
          item.text || "",
          "", "", item.done ? "done" : "open", "", "", "", ""
        ]);
      });
    });
  });

  // Status Report tasks (active + archived)
  const sr  = _safeParse("sr_tasks", []);
  const arx = _safeParse("sr_archived_tasks", []);
  const srAll = sr.map(t => ({ t, archived: false })).concat(arx.map(t => ({ t, archived: true })));
  srAll.forEach(({ t, archived }) => {
    rows.push([
      archived ? "sr (archived)" : "sr",
      "", "", "",
      t.client || "",
      "",
      Array.isArray(t.taskType) ? t.taskType.join(", ") : "",
      t.status || "",
      "",
      t.dueDate || "",
      t.priority || "",
      t.desc || ""
    ]);
  });

  // Priority Matrix tasks
  const mx = _safeParse("eisenhower_tasks", []);
  mx.forEach(t => {
    rows.push([
      "matrix:" + (t.quadrant || ""),
      "", "", "",
      t.text || "",
      "", "", t.completed ? "done" : "open",
      "", t.srDueDate || "", "", ""
    ]);
  });

  return rows.map(r => r.map(_csvEsc).join(",")).join("\n");
}

window.fbDownloadCsv = function () {
  const csv = _buildCsvString();
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = "tja-dashboard-" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  console.log("[backup] CSV download triggered");
};

// ─── THURSDAY 4PM BACKUP PROMPT ──────────────────────────────
// On every page load + every 5 min thereafter, checks whether the most
// recent Thursday 4pm local time has passed AND we haven't already shown
// the prompt for that Thursday. If so, injects a modal with Download JSON
// / Download CSV / Skip options. Marker `wp_last_backup_prompt_week` is
// synced across devices so a dismiss on one machine doesn't re-prompt on
// another.
function _mostRecentThursday4pmIso() {
  const now = new Date();
  const dow = now.getDay();
  const thu = new Date(now);
  thu.setHours(16, 0, 0, 0);
  if (dow === 4) {
    if (now.getHours() < 16) thu.setDate(thu.getDate() - 7); // today's 4pm not reached
  } else {
    const daysBack = (dow - 4 + 7) % 7;
    thu.setDate(thu.getDate() - daysBack);
  }
  const pad = n => (n < 10 ? "0" + n : "" + n);
  return thu.getFullYear() + "-" + pad(thu.getMonth() + 1) + "-" + pad(thu.getDate());
}

function _ensureBackupPromptStyles() {
  if (document.getElementById("tja-backup-prompt-styles")) return;
  const style = document.createElement("style");
  style.id = "tja-backup-prompt-styles";
  style.textContent =
    ".tja-bkp-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:2rem;}" +
    ".tja-bkp-modal{background:#252525;border:1px solid #444;border-left:4px solid #F68E21;border-radius:10px;padding:1.5rem;max-width:480px;box-shadow:0 12px 40px rgba(0,0,0,0.5);color:#e0e0e0;font-family:'Inter',-apple-system,sans-serif;}" +
    ".tja-bkp-modal h2{font-size:1rem;margin:0 0 0.5rem 0;color:#F68E21;font-weight:700;}" +
    ".tja-bkp-modal p{font-size:0.75rem;color:#bbb;line-height:1.5;margin:0 0 1rem 0;}" +
    ".tja-bkp-actions{display:flex;gap:0.5rem;justify-content:flex-end;flex-wrap:wrap;}" +
    ".tja-bkp-actions button{padding:0.4rem 0.9rem;border-radius:6px;border:1px solid #444;background:#333;color:#e0e0e0;font-family:inherit;font-size:0.7rem;font-weight:500;cursor:pointer;transition:all 0.15s;}" +
    ".tja-bkp-actions button:hover{background:#404040;border-color:#666;}" +
    ".tja-bkp-actions .tja-bkp-primary{background:#F68E21;color:#000;border-color:#F68E21;font-weight:700;}" +
    ".tja-bkp-actions .tja-bkp-primary:hover{background:#e07d15;border-color:#e07d15;}";
  document.head.appendChild(style);
}

function _showBackupPrompt(thuIso) {
  if (document.getElementById("tjaBackupPromptOverlay")) return; // already shown
  _ensureBackupPromptStyles();
  const overlay = document.createElement("div");
  overlay.id = "tjaBackupPromptOverlay";
  overlay.className = "tja-bkp-overlay";
  overlay.innerHTML =
    '<div class="tja-bkp-modal">' +
      '<h2>📥 Weekly Backup Reminder</h2>' +
      '<p>It\'s Thursday 4pm — download a snapshot of everything so you have a safety net if the dashboard breaks or data gets lost. Pick either format:</p>' +
      '<p style="font-size:0.65rem;color:#888;margin-bottom:1rem;">' +
      '<strong>JSON</strong> = complete, restorable via fbRestoreFromText(). ' +
      '<strong>CSV</strong> = readable in Excel, doesn\'t restore.' +
      '</p>' +
      '<div class="tja-bkp-actions">' +
        '<button id="tjaBkpSkip">Skip this week</button>' +
        '<button id="tjaBkpCsv">Download CSV</button>' +
        '<button id="tjaBkpJson" class="tja-bkp-primary">Download JSON</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  const dismiss = () => {
    localStorage.setItem("wp_last_backup_prompt_week", thuIso);
    overlay.remove();
  };
  overlay.querySelector("#tjaBkpSkip").addEventListener("click", dismiss);
  overlay.querySelector("#tjaBkpCsv").addEventListener("click", () => { window.fbDownloadCsv(); dismiss(); });
  overlay.querySelector("#tjaBkpJson").addEventListener("click", () => { window.fbDownloadBackup(); dismiss(); });
}

function _checkBackupPrompt() {
  try {
    const thuIso = _mostRecentThursday4pmIso();
    const last   = localStorage.getItem("wp_last_backup_prompt_week") || "";
    if (last >= thuIso) return;
    _showBackupPrompt(thuIso);
  } catch (e) {
    console.warn("[backup-prompt] check failed:", e);
  }
}

// Check ~6s after load (lets cloud sync + render settle first), then every 5 min.
setTimeout(_checkBackupPrompt, 6000);
setInterval(_checkBackupPrompt, 5 * 60 * 1000);

// Manual trigger in case you want to test the prompt
window.fbShowBackupPrompt = function () {
  _showBackupPrompt(_mostRecentThursday4pmIso());
};

// Restore from a JSON blob you paste back in (use after downloading one).
window.fbRestoreFromText = function (jsonText) {
  if (!jsonText) { console.error("[backup] pass the JSON string"); return; }
  if (!confirm("Restore from pasted JSON? This overwrites current state.")) return;
  try {
    const snapshot = typeof jsonText === "string" ? JSON.parse(jsonText) : jsonText;
    for (const k in snapshot) {
      if (k.indexOf("__") === 0) continue;
      localStorage.setItem(k, snapshot[k]);
    }
    console.log("[backup] restored from pasted text");
    setTimeout(() => location.reload(), 300);
  } catch (e) {
    console.error("[backup] restore from text failed:", e);
  }
};

// Diagnostic: inspect the weekly-notes sections for a specific week.
window.fbInspectWeeklyNotes = function (mondayIso) {
  let weeks;
  try { weeks = JSON.parse(localStorage.getItem("wp_weeks") || "{}"); } catch (e) { weeks = {}; }
  if (!mondayIso) {
    console.log("[inspect] weeks present:", Object.keys(weeks).sort());
    console.log("[inspect] pass one of those keys to see its sections, e.g. fbInspectWeeklyNotes('2026-04-20')");
    return weeks;
  }
  const w = weeks[mondayIso];
  if (!w) { console.log("[inspect] no week:", mondayIso); return null; }
  console.log("[inspect] week " + mondayIso + " sections:");
  if (!w.sections) { console.log("  (no sections object at all)"); return w; }
  Object.keys(w.sections).forEach(k => {
    const items = w.sections[k] || [];
    console.log("  " + k + ": " + items.length + " items");
    items.forEach((it, i) => console.log("    [" + i + "] done=" + !!it.done + " — " + (it.text || "(empty)")));
  });
  return w;
};

// Recovery utility: remove every task with status='rolled' from TODAY's day.
// Used to undo a runaway rollover (the April 23 incident). Prompts for
// confirmation, then writes back to localStorage (+ cloud).
window.fbClearTodayRolled = function () {
  const weeks = _safeParse("wp_weeks", {});
  const now = new Date();
  const dow = now.getDay();
  if (dow < 1 || dow > 5) {
    console.warn("[recovery] today is a weekend; no-op");
    return;
  }
  const pad = n => (n < 10 ? "0" + n : "" + n);
  const monday = new Date(now);
  const diff = 1 - dow;
  monday.setDate(monday.getDate() + diff);
  const mondayIso = monday.getFullYear() + "-" + pad(monday.getMonth() + 1) + "-" + pad(monday.getDate());
  const DAY_KEYS = ["monday","tuesday","wednesday","thursday","friday"];
  const todayKey = DAY_KEYS[dow - 1];

  const week = weeks[mondayIso];
  if (!week || !week.days || !week.days[todayKey]) {
    console.warn("[recovery] no data for today (" + mondayIso + " " + todayKey + ")");
    return;
  }
  const list = week.days[todayKey].priorities || [];
  const rolled = list.filter(t => t.status === "rolled");
  if (rolled.length === 0) {
    console.log("[recovery] nothing to clean — no rolled tasks on today");
    return;
  }
  if (!confirm("Remove " + rolled.length + " rolled-over tasks from today? This cannot be undone.")) {
    console.log("[recovery] cancelled");
    return;
  }
  week.days[todayKey].priorities = list.filter(t => t.status !== "rolled");
  localStorage.setItem("wp_weeks", JSON.stringify(weeks));
  console.log("[recovery] ✓ removed " + rolled.length + " rolled tasks. Reload to see clean state.");
  setTimeout(() => location.reload(), 400);
};

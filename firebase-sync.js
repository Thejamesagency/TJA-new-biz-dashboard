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
  "wp_last_notes_rollover_week",
  "wp_last_backup_prompt_week",
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
function doCloudWriteNow() {
  if (isApplyingRemote) return null;
  if (!currentUser)     return null;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  try {
    return setDoc(workspaceRef, {
      data: dumpLocalToObject(),
      lastUpdated: serverTimestamp(),
      lastUpdatedBy: currentUser.email
    }, { merge: true }).catch(e => console.error("[sync] cloud write failed:", e));
  } catch (e) {
    console.error("[sync] cloud write failed:", e);
    return null;
  }
}

function scheduleCloudWrite() {
  if (isApplyingRemote) return;
  if (!currentUser)     return;
  if (writeTimer) clearTimeout(writeTimer);
  // Short debounce: long enough to batch a few synchronous setItem calls
  // (e.g. save() that writes 5 keys in a row), short enough that a user
  // clicking a nav link right after an edit doesn't out-race it.
  writeTimer = setTimeout(() => { writeTimer = null; doCloudWriteNow(); }, 120);
}

// Flush any pending cloud write when the page is about to unload. Firestore
// SDK fires the request as XHR; most browsers let in-flight XHRs complete
// during unload, so the write has a good chance of reaching the server
// before the next page loads.
window.addEventListener("beforeunload", () => {
  if (writeTimer && currentUser) { doCloudWriteNow(); }
});
// pagehide fires in more scenarios than beforeunload (incl. bfcache)
window.addEventListener("pagehide", () => {
  if (writeTimer && currentUser) { doCloudWriteNow(); }
});

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

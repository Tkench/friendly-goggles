/* Last Brick — track missing LEGO pieces across your sets.
 *
 * Parts lists come from Rebrickable, through our "rebrickable" Supabase
 * helper (supabase/functions/rebrickable) so nobody needs their own key.
 * Photo recognition of a single piece uses the Brickognize API.
 * Everything you tick off is stored on this device (localStorage) and, when
 * logged in, backed up to Supabase and synced between devices.
 */
'use strict';

// Storage names keep the app's original name so existing data and logins carry over.
const STORE_KEY = 'brickfinder.v1';
const RB_API = 'https://rebrickable.com/api/v3/lego';
const BRICKOGNIZE_API = 'https://api.brickognize.com/predict/parts/';
// Tip jar link (Ko-fi / Buy Me a Coffee). The Support button stays hidden while this is empty.
const TIP_URL = '';
// Supabase project for login, backup and sync (see supabase/setup.sql). The
// "anon" key is meant to be public: row-level security keeps each person's
// data private. Accounts stay hidden while these are empty.
const SUPABASE_URL = 'https://nioytuzuejdzznaxvlic.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vWTdvZvwYgGsKhE0m7DbPg_MP_UbMqr';

/* ---------- State ---------- */

let state = load();
let ui = { setFilter: 'missing', missingColor: '', missingSearch: '', setSearch: '', missingView: loadPref('missingView', 'list'), missingType: '', setSort: loadPref('setSort', 'closest'), setView: loadPref('setView', 'grid'), setsShow: loadPref('setsShow', 'all') };
let lastUndo = null;
let scanState = null; // { photoUrl, loading, error, items }

function load() {
  let s = { apiKey: '', sets: {} };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) s = JSON.parse(raw);
  } catch (e) { console.warn('Could not load saved data', e); }
  s.sets = s.sets || {};
  s.deleted = s.deleted || {};
  // Sets saved before sync existed have no change time yet.
  for (const set of Object.values(s.sets)) if (!set.updatedAt) set.updatedAt = set.addedAt || 1;
  return s;
}

function loadPref(name, fallback) {
  try { return localStorage.getItem('brickfinder.' + name) || fallback; } catch { return fallback; }
}
function savePref(name, value) {
  try { localStorage.setItem('brickfinder.' + name, value); } catch { /* not important */ }
}

// What sync compares to tell whether a set changed since the last save.
const setSig = (set) => JSON.stringify([set.name, set.value, set.parts.length, set.parts.map((p) => p.have)]);
let lastSigs = new Map(Object.values(state.sets).map((set) => [set.setNum, setSig(set)]));

// Saves on this device. Stamps changed sets (and deletions) with the time so
// sync can tell which copy is newest, then schedules a backup.
function save({ fromSync = false } = {}) {
  const now = Date.now();
  const sigs = new Map();
  for (const set of Object.values(state.sets)) {
    const sig = setSig(set);
    sigs.set(set.setNum, sig);
    if (!fromSync && (lastSigs.get(set.setNum) !== sig || !set.updatedAt)) set.updatedAt = now;
  }
  if (!fromSync) {
    for (const num of lastSigs.keys()) if (!sigs.has(num)) state.deleted[num] = now;
  }
  lastSigs = sigs;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('Could not save on this device: ' + e.message);
  }
  if (!fromSync) scheduleSync();
}

/* ---------- Account, backup & sync (Supabase) ----------
 * One row per user in the user_data table holds { apiKey, sets, deleted }.
 * Every sync pulls that row, merges it with this device (newest copy of each
 * set wins; deletions win over older copies) and pushes the result back.
 */

const SESSION_KEY = 'brickfinder.session';
const syncEnabled = () => !!(SUPABASE_URL && SUPABASE_KEY);
let session = syncEnabled() ? loadSession() : null;
let sync = { busy: false, again: false, timer: 0, error: '', lastAt: Number(loadPref('lastSync', '0')) };

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}
function setSession(s) {
  session = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* private mode */ }
}

async function sbFetch(path, opts = {}) {
  const { method = 'GET', body, auth = false, headers = {}, retried = false } = opts;
  const h = { apikey: SUPABASE_KEY, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (auth) h.Authorization = 'Bearer ' + (await accessToken());
  let res;
  try {
    res = await fetch(SUPABASE_URL + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Can't connect — check your internet");
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  // Token rejected early (e.g. the phone's clock is off): renew it and retry once.
  if (res.status === 401 && auth && !retried && session) {
    session.expiresAt = 0;
    return sbFetch(path, { ...opts, retried: true });
  }
  if (!res.ok) {
    const msg = (data && (data.error_description || data.msg || data.message || data.error)) || 'Error ' + res.status;
    const err = new Error(friendlyAuthError(String(msg)));
    err.status = res.status;
    throw err;
  }
  return data;
}

function friendlyAuthError(msg) {
  if (/invalid login credentials/i.test(msg)) return 'Wrong email or password';
  if (/email not confirmed/i.test(msg)) return 'Please confirm your email first — tap the link in the email we sent you';
  if (/already registered|already exists/i.test(msg)) return 'There is already an account with this email — try logging in';
  if (/password.*(at least|short)/i.test(msg)) return 'Password must be at least 6 characters';
  if (/rate limit|too many/i.test(msg)) return 'Too many tries — please wait a few minutes';
  return msg;
}

function sessionFrom(data) {
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    email: (data.user && data.user.email) || (session && session.email) || '',
    userId: (data.user && data.user.id) || (session && session.userId) || '',
  };
}

async function accessToken() {
  if (!session) throw new Error('Not logged in');
  if (Date.now() > session.expiresAt - 60000) {
    try {
      const data = await sbFetch('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh } });
      setSession(sessionFrom(data));
    } catch (e) {
      if (e.status === 400 || e.status === 401) {
        setSession(null);
        render();
        throw new Error('Please log in again');
      }
      throw e;
    }
  }
  return session.access;
}

const appUrl = () => location.origin + location.pathname;

async function logIn(email, password) {
  const data = await sbFetch('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
  setSession(sessionFrom(data));
  await syncNow({ loud: true });
}

// Returns true when logged straight in, false when an email confirmation is needed.
async function register(email, password) {
  const data = await sbFetch('/auth/v1/signup?redirect_to=' + encodeURIComponent(appUrl()), { method: 'POST', body: { email, password } });
  if (data && data.access_token) {
    setSession(sessionFrom(data));
    await syncNow({ loud: true });
    return true;
  }
  return false;
}

function logOut() {
  if (session) sbFetch('/auth/v1/logout', { method: 'POST', auth: true }).catch(() => {});
  setSession(null);
  sync.error = '';
}

function mergeData(local, remote) {
  const deleted = { ...(remote.deleted || {}) };
  for (const [num, t] of Object.entries(local.deleted || {})) deleted[num] = Math.max(t, deleted[num] || 0);
  const sets = {};
  const nums = new Set([...Object.keys(local.sets || {}), ...Object.keys((remote.sets) || {})]);
  for (const num of nums) {
    const a = (local.sets || {})[num], b = (remote.sets || {})[num];
    const newest = !a ? b : !b ? a : ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a);
    if ((newest.updatedAt || 0) > (deleted[num] || 0)) sets[num] = newest;
  }
  return { apiKey: local.apiKey || remote.apiKey || '', sets, deleted };
}

function scheduleSync(delay = 3000) {
  if (!session) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => syncNow(), delay);
}

async function syncNow({ loud = false } = {}) {
  if (!session) return;
  if (sync.busy) { sync.again = true; return; }
  sync.busy = true;
  clearTimeout(sync.timer);
  try {
    // The row's version number stops two devices saving over each other: if
    // it changed since we read it, read again, merge again and retry.
    for (let attempt = 0; ; attempt++) {
      if (attempt === 4) throw new Error('Another device keeps saving — try again in a moment');
      if (await syncOnce(session.userId)) break;
    }
    sync.error = '';
    sync.lastAt = Date.now();
    savePref('lastSync', String(sync.lastAt));
  } catch (e) {
    sync.error = e.message;
    if (loud) toast('Backup failed: ' + e.message);
  } finally {
    sync.busy = false;
    if (route().name === 'settings') renderAccountCard();
  }
  if (sync.again) { sync.again = false; syncNow(); }
}

// One pull–merge–push round. Returns false if another device saved first.
async function syncOnce(uid) {
  const q = `user_id=eq.${encodeURIComponent(uid)}`;
  const rows = await sbFetch(`/rest/v1/user_data?select=data,version&${q}`, { auth: true });
  const row = rows && rows[0];
  const local = { apiKey: state.apiKey, sets: state.sets, deleted: state.deleted };
  const merged = row ? mergeData(local, row.data) : local;
  if (JSON.stringify(merged) !== JSON.stringify(local)) {
    state.apiKey = merged.apiKey;
    state.sets = merged.sets;
    state.deleted = merged.deleted;
    save({ fromSync: true });
    if (!document.querySelector('#sheet:not(.hidden)') && !document.activeElement?.matches('input')) render();
  }
  if (row && JSON.stringify(merged) === JSON.stringify(row.data)) return true;
  const now = new Date().toISOString();
  if (!row) {
    try {
      await sbFetch('/rest/v1/user_data', {
        method: 'POST', auth: true, headers: { Prefer: 'return=minimal' },
        body: { user_id: uid, data: merged, version: 1, updated_at: now },
      });
      return true;
    } catch (e) {
      if (e.status === 409) return false; // another device created it first
      throw e;
    }
  }
  const updated = await sbFetch(`/rest/v1/user_data?${q}&version=eq.${row.version}`, {
    method: 'PATCH', auth: true, headers: { Prefer: 'return=representation' },
    body: { data: merged, version: row.version + 1, updated_at: now },
  });
  return Array.isArray(updated) && updated.length > 0;
}

async function deleteAccount() {
  await sbFetch('/rest/v1/rpc/delete_account', { method: 'POST', auth: true, body: {} });
  setSession(null);
}

// After tapping the link in a confirmation or password-reset email, Supabase
// sends people back here with the login in the address (#access_token=…).
async function handleAuthRedirect() {
  const h = location.hash.slice(1);
  if (!syncEnabled() || !/(^|&)(access_token|error_description)=/.test(h)) return;
  const p = new URLSearchParams(h);
  history.replaceState(null, '', location.pathname + location.search + '#settings');
  if (p.get('error_description')) {
    toast(p.get('error_description').replace(/\+/g, ' ') + ' — please try again');
    return;
  }
  setSession(sessionFrom({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_in: Number(p.get('expires_in')) || 3600 }));
  try {
    const user = await sbFetch('/auth/v1/user', { auth: true });
    setSession({ ...session, email: user.email, userId: user.id });
  } catch (e) {
    setSession(null);
    toast('Could not log in: ' + e.message);
    return;
  }
  if (p.get('type') === 'recovery') {
    render();
    showNewPasswordSheet();
  } else {
    toast('Email confirmed — you are logged in');
    await syncNow({ loud: true });
    render();
  }
}

function showNewPasswordSheet() {
  openSheet(`
    <h2>Choose a new password</h2>
    <input class="field" id="newPw" type="password" autocomplete="new-password" placeholder="New password (at least 6 characters)">
    <p></p>
    <button class="btn primary block" id="newPwSave">Save password</button>`);
  $('#newPwSave').onclick = async () => {
    const password = $('#newPw').value;
    if (password.length < 6) return toast('Password must be at least 6 characters');
    try {
      await sbFetch('/auth/v1/user', { method: 'PUT', auth: true, body: { password } });
      closeSheet();
      toast('Password changed — you are logged in');
      syncNow();
    } catch (e) { toast(e.message); }
  };
}

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' hours ago';
  return new Date(t).toLocaleDateString();
}

/* ---------- Helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function normaliseSetNum(input) {
  const s = String(input).trim().replace(/\s+/g, '');
  if (!s) return '';
  return /-\d+$/.test(s) ? s : s + '-1';
}

function shortSetNum(setNum) {
  return setNum.replace(/-1$/, '');
}

function setStats(set) {
  let need = 0, have = 0, kinds = 0, kindsMissing = 0;
  for (const p of set.parts) {
    need += p.qty;
    have += Math.min(p.have, p.qty);
    kinds++;
    if (p.have < p.qty) kindsMissing++;
  }
  return { need, have, missing: need - have, kinds, kindsMissing };
}

function sortedSets() {
  return Object.values(state.sets).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

// Simple piece types for filtering. Uses Rebrickable's category when we have
// it, otherwise the part name (which starts with "Brick", "Plate", "Tile"…).
const PIECE_TYPES = ['Bricks', 'Plates', 'Tiles', 'Slopes', 'Minifigure parts', 'Technic', 'Wheels', 'Windows & doors', 'Other'];

function pieceType(p) {
  const t = (p.catName || p.name || '').toLowerCase();
  if (/minifig/.test(t)) return 'Minifigure parts';
  if (/^technic/.test(t)) return 'Technic';
  if (/slope|wedge(?! plate)/.test(t) && !/^(plate|tile)/.test(t)) return 'Slopes';
  if (/^bricks?\b/.test(t)) return 'Bricks';
  if (/^(plates?|baseplates?)\b|^wedge plate/.test(t)) return 'Plates';
  if (/^tiles?\b/.test(t)) return 'Tiles';
  if (/wheel|tyre|tire/.test(t)) return 'Wheels';
  if (/window|door|glass for|shutter/.test(t)) return 'Windows & doors';
  // Names like "Round Brick 1 x 1" or "Cone 1 x 1" (older saved sets have no category).
  if (/\bbricks?\b|^cone\b/.test(t)) return 'Bricks';
  if (/\bplates?\b/.test(t)) return 'Plates';
  if (/\btiles?\b/.test(t)) return 'Tiles';
  return 'Other';
}

function swatch(rgb) {
  return `<span class="swatch" style="background:#${esc(rgb || 'ccc')}"></span>`;
}

function partImg(p, cls = '') {
  return p.img
    ? `<img class="${cls}" src="${esc(p.img)}" alt="${esc(p.name)}" loading="lazy">`
    : `<span class="noimg">No picture</span>`;
}

function buzz() {
  if (navigator.vibrate) navigator.vibrate(30);
}

/* ---------- Rebrickable ---------- */

async function rbFetch(url) {
  const u = new URL(url);
  if (!u.searchParams.has('key')) u.searchParams.set('key', state.apiKey);
  const res = await fetch(u.toString());
  if (res.status === 404) throw new Error(SET_NOT_FOUND);
  if (res.status === 401 || res.status === 403) throw new Error('Rebrickable rejected the API key. Check it in Settings.');
  if (res.status === 429) throw new Error('Rebrickable says too many requests — wait a minute and try again.');
  if (!res.ok) throw new Error('Rebrickable error ' + res.status);
  return res.json();
}

async function partCategories() {
  if (state.partCats && Object.keys(state.partCats).length) return state.partCats;
  try {
    const data = await rbFetch(`${RB_API}/part_categories/?page_size=1000`);
    state.partCats = Object.fromEntries(data.results.map((c) => [c.id, c.name]));
    save();
  } catch (e) {
    console.warn('Could not load part categories', e);
    return {};
  }
  return state.partCats;
}

const SET_NOT_FOUND = 'Set not found. Check the number on the box or manual (e.g. 6080 or 6080-1).';
const helperAvailable = () => syncEnabled();
const needsOwnKey = () => !helperAvailable() && !state.apiKey;

// Gets a parts list from our helper, which caches Rebrickable for everyone.
// Falls back to the person's own Rebrickable key if the helper isn't set up.
async function fetchSet(setNum, { refresh = false } = {}) {
  if (!helperAvailable()) return fetchSetDirect(setNum);
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/rebrickable?set=${encodeURIComponent(setNum)}${refresh ? '&refresh=1' : ''}`,
      { headers: { apikey: SUPABASE_KEY } });
  } catch {
    if (state.apiKey) return fetchSetDirect(setNum);
    throw new Error('No connection. Check your internet and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return buildSet(data.info, data.results, data.cats || {});
  if (data.error === 'not_found') throw new Error(SET_NOT_FOUND);
  if (res.status === 429) throw new Error('Lots of people are adding sets right now — wait a minute and try again.');
  if (res.status === 400) throw new Error(SET_NOT_FOUND);
  if (state.apiKey) return fetchSetDirect(setNum); // helper not set up or broken
  throw new Error("Parts lists aren't available right now — please try again later.");
}

async function fetchSetDirect(setNum) {
  const info = await rbFetch(`${RB_API}/sets/${encodeURIComponent(setNum)}/`);
  const cats = await partCategories();
  const results = [];
  let url = `${RB_API}/sets/${encodeURIComponent(setNum)}/parts/?page_size=1000&inc_minifig_parts=1&inc_part_details=1`;
  while (url) {
    const page = await rbFetch(url);
    results.push(...page.results);
    url = page.next;
  }
  return buildSet(info, results, cats);
}

function buildSet(info, results, cats) {
  const merged = new Map();
  {
    for (const r of results) {
      if (r.is_spare) continue; // spares are extras in the bag, not needed to build
      const key = r.part.part_num + '|' + r.color.id;
      const existing = merged.get(key);
      if (existing) { existing.qty += r.quantity; continue; }
      const ext = r.part.external_ids || {};
      merged.set(key, {
        key,
        partNum: r.part.part_num,
        name: r.part.name,
        catName: cats[r.part.part_cat_id] || '',
        img: r.element_img_url || r.part.part_img_url || '',
        colorId: r.color.id,
        colorName: r.color.name,
        rgb: r.color.rgb,
        qty: r.quantity,
        have: 0,
        altIds: [...(ext.BrickLink || []), ...(ext.LEGO || [])].map(String),
      });
    }
  }
  const parts = [...merged.values()].sort((a, b) =>
    a.colorName.localeCompare(b.colorName) || a.name.localeCompare(b.name));
  return {
    setNum: info.set_num,
    name: info.name,
    year: info.year,
    img: info.set_img_url || '',
    addedAt: Date.now(),
    parts,
  };
}

/* ---------- Brickognize ---------- */

async function shrinkImage(file, maxSide = 1024) {
  const bitmapUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not read photo'));
      i.src = bitmapUrl;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}

async function identifyPiece(file) {
  const blob = await shrinkImage(file);
  const form = new FormData();
  form.append('query_image', blob, 'piece.jpg');
  const res = await fetch(BRICKOGNIZE_API, { method: 'POST', body: form });
  if (!res.ok) throw new Error('Recognition service error ' + res.status);
  const data = await res.json();
  return data.items || [];
}

// Strip print/pattern/mould suffixes so e.g. "3626bpr0001" ≈ "3626b" ≈ "3626".
function basePartNum(id) {
  return String(id).toLowerCase()
    .replace(/(pr|pat|px|pb|ps|pat)\d+.*$/, '')
    .replace(/[a-z]+$/, '');
}

// Find every missing entry (across all sets) that matches a recognised part id.
function findMissingMatches(id) {
  const want = String(id).toLowerCase();
  const wantBase = basePartNum(id);
  const exact = [], similar = [];
  for (const set of sortedSets()) {
    for (const p of set.parts) {
      if (p.have >= p.qty) continue;
      const ids = [p.partNum, ...(p.altIds || [])].map((x) => x.toLowerCase());
      if (ids.includes(want)) exact.push({ set, p });
      else if (wantBase && ids.some((x) => basePartNum(x) === wantBase)) similar.push({ set, p });
    }
  }
  return { exact, similar };
}

/* ---------- Mutations ---------- */

function changeHave(setNum, key, delta, { withUndo = false } = {}) {
  const set = state.sets[setNum];
  if (!set) return;
  const p = set.parts.find((x) => x.key === key);
  if (!p) return;
  const before = p.have;
  p.have = Math.max(0, Math.min(p.qty, p.have + delta));
  if (p.have === before) return;
  save();
  buzz();
  if (withUndo) {
    lastUndo = () => { p.have = before; save(); render(); };
    const done = p.have >= p.qty;
    toast(`${done ? '✅' : '➕'} ${p.name} (${p.colorName}) → ${set.name}`, true);
  }
}

async function deleteSet(setNum) {
  const set = state.sets[setNum];
  if (!set) return false;
  const ok = await askConfirm({
    title: `Delete ${set.name} (#${shortSetNum(setNum)})?`,
    text: "Its parts list and your ticks will be removed from this phone. You can add the set again later, but you'd need to re-tick the pieces.",
    ok: 'Delete set',
    danger: true,
  });
  if (!ok || !state.sets[setNum]) return false;
  delete state.sets[setNum];
  save();
  toast(`Deleted ${set.name}`);
  return true;
}

function setAllHave(setNum, value) {
  const set = state.sets[setNum];
  for (const p of set.parts) p.have = value ? p.qty : 0;
  save();
}

/* ---------- Toast & sheet ---------- */

let toastTimer;
function toast(msg, undoable = false) {
  const el = $('#toast');
  el.innerHTML = `<span class="grow">${esc(msg)}</span>${undoable ? '<button id="undoBtn">UNDO</button>' : ''}`;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), undoable ? 5000 : 3500);
  if (undoable) {
    $('#undoBtn').onclick = () => {
      if (lastUndo) lastUndo();
      lastUndo = null;
      el.classList.add('hidden');
    };
  }
}

function openSheet(html) {
  const el = $('#sheet');
  el.innerHTML = `<div class="panel">${html}</div>`;
  el.classList.remove('hidden');
  el.onclick = (e) => { if (e.target === el || e.target.closest('[data-close]')) closeSheet(); };
}
// In-app "are you sure?" panel. Used instead of the browser's confirm box,
// which phone browsers can silently block (e.g. after "don't allow more dialogs").
function askConfirm({ title, text = '', ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    openSheet(`
      <h2>${esc(title)}</h2>
      ${text ? `<p class="muted">${esc(text)}</p>` : ''}
      <p></p>
      <button class="btn block ${danger ? 'danger' : 'primary'}" data-answer="yes">${esc(ok)}</button>
      <p></p>
      <button class="btn block" data-answer="no">Cancel</button>`);
    const el = $('#sheet');
    el.onclick = (e) => {
      const answer = e.target.closest('[data-answer]')?.dataset.answer;
      if (e.target !== el && !answer) return;
      closeSheet();
      resolve(answer === 'yes');
    };
  });
}

function closeSheet() {
  $('#sheet').classList.add('hidden');
  $('#sheet').innerHTML = '';
}

/* ---------- Routing ---------- */

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = h.split('/');
  return { name: name || 'sets', arg: decodeURIComponent(rest.join('/')) };
}

function go(hash) { location.hash = hash; }

window.addEventListener('hashchange', () => { closeSheet(); render(); window.scrollTo(0, 0); });

/* ---------- Rendering ---------- */

function render() {
  const r = route();
  const tab = r.name === 'set' || r.name === 'add' ? 'sets' : r.name;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const back = $('#backBtn');
  back.classList.toggle('hidden', !(r.name === 'set' || r.name === 'add'));
  $('#delBtn').classList.add('hidden'); // renderSet shows it for the open set

  if (r.name !== 'settings' && (needsOwnKey() || (!state.welcomed && !Object.keys(state.sets).length))) return renderWelcome();

  switch (r.name) {
    case 'set': return renderSet(r.arg);
    case 'add': return renderAdd();
    case 'missing': return renderMissing();
    case 'scan': return renderScan();
    case 'settings': return renderSettings();
    default: return renderSets();
  }
}

function setTitle(t) {
  document.body.classList.remove('welcome');
  $('#title').textContent = t;
}

// Welcome page header: logo + "Last" in black, "Brick" in red.
function setWelcomeHeader() {
  document.body.classList.add('welcome');
  $('#title').innerHTML = setWelcomeHeaderArt();
}

// Last Brick logo art: a stepped stack of bricks with the red "last brick"
// on top. Drawn from scratch (no LEGO artwork). With `animate`, the red brick
// drops in and lands, with motion lines and impact marks (see .lb-* in CSS).
const BRICK_COLOURS = {
  r: ['#d9312b', '#a61f1b'], y: ['#f6c31b', '#c99a06'], b: ['#2f80d1', '#1d5ea3'], g: ['#3aa64a', '#277a34'],
};

function brandArt({ animate = false, cls = '' } = {}) {
  // Everything sits on a 34px stud grid centred on x = 328, so rows step in
  // evenly and the last brick's studs line up with the bricks below.
  const U = 34;
  const brick = (x, y, units, c) => {
    const [fill, edge] = BRICK_COLOURS[c];
    let studs = '';
    for (let i = 0; i < units; i++) {
      studs += `<rect x="${x + i * U + 8.5}" y="${y - 8}" width="17" height="10" rx="2.5" fill="${fill}" stroke="${edge}" stroke-width="2.5"/>`;
    }
    return `${studs}<rect x="${x + 1}" y="${y}" width="${units * U - 2}" height="44" rx="3.5" fill="${fill}" stroke="${edge}" stroke-width="2.5"/>`;
  };
  const row = (x, y, parts) => parts.map(([units, c]) => { const b = brick(x, y, units, c); x += units * U; return b; }).join('');
  return `
  <svg class="${cls}" viewBox="128 300 400 208" role="img" aria-label="A stack of bricks with the last red brick ${animate ? 'dropping into place' : 'on top'}">
    <rect x="136" y="491" width="384" height="7" rx="3.5" fill="#000" opacity=".08"/>
    ${row(141, 446, [[2, 'b'], [3, 'g'], [3, 'r'], [3, 'g']])}
    ${row(175, 402, [[3, 'r'], [3, 'g'], [3, 'y']])}
    ${row(209, 358, [[4, 'y'], [3, 'b']])}
    <g class="${animate ? 'lb-drop' : ''}">
      ${animate ? `<g class="lb-speed" stroke="#e8a3a0" stroke-width="3" stroke-linecap="round">
        <line x1="300" y1="220" x2="300" y2="262"/><line x1="328" y1="196" x2="328" y2="252"/><line x1="356" y1="220" x2="356" y2="262"/>
      </g>` : ''}
      ${brick(277, 314, 3, 'r')}
    </g>
    ${animate ? `<g class="lb-impact" fill="none" stroke="#e8a3a0" stroke-width="3" stroke-linecap="round">
      <path d="M266 330 q-12 6 -18 18"/><path d="M268 312 q-14 0 -24 8"/><path d="M390 330 q12 6 18 18"/><path d="M388 312 q14 0 24 8"/>
    </g>` : ''}
  </svg>`;
}

function setWelcomeHeaderArt() {
  return `${brandArt({ cls: 'logo-mark' })}<span class="wordmark"><span>Last</span> <span class="brick">Brick</span></span>`;
}

function renderWelcome() {
  setWelcomeHeader();
  $('#view').innerHTML = `
    <section class="hero">
      ${brandArt({ animate: true, cls: 'hero-art' })}
      <h2 class="hero-title">Find the missing pieces.<br><span class="accent">Finish every set.</span></h2>
      <p class="hero-sub">Rebuild old LEGO® sets from a pile of bricks: see exactly what's missing, with a picture of every piece.</p>
    </section>
    ${needsOwnKey() ? `<div class="card">
      <h2>One-time setup: free Rebrickable key</h2>
      <ol class="small">
        <li>Create a free account at <a href="https://rebrickable.com/signup/" target="_blank" rel="noopener">rebrickable.com</a>.</li>
        <li>Go to <a href="https://rebrickable.com/users/profile/settings/#api" target="_blank" rel="noopener">Settings → API</a> and tap <b>Generate new API key</b>.</li>
        <li>Copy the key and paste it below.</li>
      </ol>
      <input class="field" id="keyInput" placeholder="Paste API key here" autocomplete="off" autocapitalize="off" spellcheck="false">
      <p></p>
      <button class="btn primary block" id="saveKey">Save and start</button>
    </div>` : `
    <button class="btn primary block hero-cta" id="startBtn">Get started for free</button>`}
    ${syncEnabled() ? `<p class="center small hero-login">Already have an account? <a href="#settings">Log in</a></p>` : ''}
    <h3 class="steps-title">How it works</h3>
    <ol class="steps" id="steps">
      <li><span class="step-ico" aria-hidden="true">📖</span><span class="step-n">01 /</span><b>Add your sets</b><span class="step-text">Type the number from the box or manual and the full parts list appears.</span></li>
      <li><span class="step-ico" aria-hidden="true">✅</span><span class="step-n">02 /</span><b>Tick what you have</b><span class="step-text">See exactly which pieces are still missing, in every colour.</span></li>
      <li><span class="step-ico" aria-hidden="true">📷</span><span class="step-n">03 /</span><b>Find and scan</b><span class="step-text">Spot a piece in the pile? Scan it to see which set needs it.</span></li>
    </ol>
    <div class="step-dots" id="stepDots" aria-hidden="true"><span class="on"></span><span></span><span></span></div>
    <footer class="welcome-foot small muted">
      <a href="privacy.html">Privacy Policy</a> · <a href="terms.html">Terms of Use</a>
      <p>LEGO® is a trademark of the LEGO Group, which does not sponsor or endorse this app.</p>
    </footer>`;
  const steps = $('#steps');
  steps.addEventListener('scroll', () => {
    const cards = [...steps.children];
    const mid = steps.scrollLeft + steps.clientWidth / 2;
    const i = cards.reduce((best, c, n) => (Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid) < Math.abs(cards[best].offsetLeft + cards[best].offsetWidth / 2 - mid) ? n : best), 0);
    [...$('#stepDots').children].forEach((d, n) => d.classList.toggle('on', n === i));
  }, { passive: true });
  if ($('#startBtn')) {
    $('#startBtn').onclick = () => { state.welcomed = true; save(); go('#add'); render(); };
    return;
  }
  $('#saveKey').onclick = () => {
    const k = $('#keyInput').value.trim();
    if (!k) return toast('Paste your key first');
    state.apiKey = k; state.welcomed = true; save(); go('#sets'); render();
  };
}

/* ---------- Search box with clear (✕) and Cancel ----------
 * Pages re-render on every keystroke, so bindSearch puts focus and the
 * cursor back afterwards. Cancel and ✕ act on pointerdown so the box
 * doesn't lose focus (and hide them) before the tap lands.
 */
function searchBox(id, value, placeholder) {
  return `
    <div class="search ${value ? 'has-text' : ''}">
      <div class="search-field">
        <input class="field" id="${id}" type="search" enterkeyhint="search" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(value)}">
        <button type="button" class="search-clear" aria-label="Clear search">✕</button>
      </div>
      <button type="button" class="search-cancel">Cancel</button>
    </div>`;
}

function bindSearch(id, setValue, rerender) {
  const input = document.getElementById(id);
  if (!input) return;
  const box = input.closest('.search');
  const update = (value, { keepFocus = true, pos = value.length } = {}) => {
    setValue(value);
    rerender();
    const again = document.getElementById(id);
    if (!again) return;
    if (keepFocus) { again.focus(); again.setSelectionRange(pos, pos); } else again.blur();
  };
  input.oninput = () => update(input.value, { pos: input.selectionStart });
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } }; // keep results, close keyboard
  box.querySelector('.search-clear').onpointerdown = (e) => { e.preventDefault(); update(''); };
  box.querySelector('.search-cancel').onpointerdown = (e) => { e.preventDefault(); update('', { keepFocus: false }); };
}

// Scrolling with a finger closes the keyboard so it doesn't cover the results.
document.addEventListener('touchmove', () => {
  const el = document.activeElement;
  if (el && el.matches('.search input')) el.blur();
}, { passive: true });

// Sets still missing pieces come first, fewest missing at the top; complete sets last.
function setsClosestFirst() {
  return sortedSets()
    .map((s) => ({ s, st: setStats(s) }))
    .sort((a, b) => {
      const aDone = a.st.missing === 0, bDone = b.st.missing === 0;
      if (aDone !== bDone) return aDone ? 1 : -1;
      return a.st.missing - b.st.missing || (b.st.have / (b.st.need || 1)) - (a.st.have / (a.st.need || 1));
    })
    .map((x) => x.s);
}

const hasValue = (s) => typeof s.value === 'number' && s.value > 0;

function money(v) {
  return '£' + (Number.isInteger(v) ? v : v.toFixed(2));
}

function priceGuideUrl(setNum) {
  return `https://www.bricklink.com/catalogPG.asp?S=${encodeURIComponent(setNum)}`;
}

// Best value for the work left: valued sets ranked by £ per missing piece,
// then unvalued sets by fewest missing; complete sets last.
function setsWorthFirst() {
  const rank = ({ s, st }) => (st.missing === 0 ? 2 : hasValue(s) ? 0 : 1);
  return sortedSets()
    .map((s) => ({ s, st: setStats(s) }))
    .sort((a, b) => rank(a) - rank(b) ||
      (rank(a) === 0 ? b.s.value / b.st.missing - a.s.value / a.st.missing : a.st.missing - b.st.missing))
    .map((x) => x.s);
}

/* ---------- Swaps between sets ----------
 * A piece ticked as found in one set can be moved to another set that needs
 * the same piece in the same colour. Only suggest taking from sets that have
 * more left to find and, when both have a value, are also worth less.
 */
function canTakeFrom(from, to, stats) {
  if (from === to) return false;
  if (stats.get(from.setNum).missing <= stats.get(to.setNum).missing) return false;
  return !(hasValue(from) && hasValue(to)) || from.value < to.value;
}

function swapIndex() {
  const byKey = new Map();
  const stats = new Map();
  for (const set of Object.values(state.sets)) {
    stats.set(set.setNum, setStats(set));
    for (const p of set.parts) {
      if (p.have <= 0) continue;
      if (!byKey.has(p.key)) byKey.set(p.key, []);
      byKey.get(p.key).push({ set, part: p });
    }
  }
  return { byKey, stats };
}

function swapsFor(target, index = swapIndex()) {
  const { byKey, stats } = index;
  const moves = [];
  for (const p of target.parts) {
    let need = p.qty - p.have;
    if (need <= 0) continue;
    const donors = (byKey.get(p.key) || [])
      .filter((d) => canTakeFrom(d.set, target, stats))
      // Known cheaper sets first, then sets without a value; most missing first within each.
      .sort((a, b) => (hasValue(b.set) - hasValue(a.set)) ||
        (a.set.value || 0) - (b.set.value || 0) ||
        stats.get(b.set.setNum).missing - stats.get(a.set.setNum).missing);
    for (const d of donors) {
      if (need <= 0) break;
      const qty = Math.min(need, d.part.have);
      moves.push({ part: p, from: d.set, fromPart: d.part, qty });
      need -= qty;
    }
  }
  return moves;
}

function moveBetweenSets(target, move) {
  const { part, from, fromPart } = move;
  const qty = Math.min(move.qty, fromPart.have, part.qty - part.have);
  if (qty <= 0) return;
  part.have += qty;
  fromPart.have -= qty;
  save();
  buzz();
  lastUndo = () => { part.have -= qty; fromPart.have += qty; save(); render(); };
  toast(`🔁 Moved ${qty}× ${part.name} from ${from.name}`, true);
}

function editValue(set) {
  openSheet(`
    <h2>Value of ${esc(set.name)}</h2>
    <p class="muted small">Open the price guide, look at <b>Last 6 months sales → Used → Avg Price</b>, then type it in below.</p>
    <a class="btn block" href="${priceGuideUrl(set.setNum)}" target="_blank" rel="noopener">💷 See prices on BrickLink ↗</a>
    <label class="lbl" for="valInput">Value (£)</label>
    <input class="field" id="valInput" type="number" inputmode="decimal" min="0" step="0.01" placeholder="e.g. 45" value="${hasValue(set) ? set.value : ''}">
    <p></p>
    <button class="btn primary block" id="valSave">Save</button>
    <p></p>
    <button class="btn block" data-close>Cancel</button>`);
  const save_ = () => {
    const v = parseFloat($('#valInput').value);
    if (v > 0) set.value = Math.round(v * 100) / 100; else delete set.value;
    save();
    closeSheet();
    render();
    toast(hasValue(set) ? `Value saved: ${money(set.value)}` : 'Value removed');
  };
  $('#valSave').onclick = save_;
  $('#valInput').onkeydown = (e) => { if (e.key === 'Enter') save_(); };
}

const SET_SORTS = [
  ['worth', 'Worth finishing'],
  ['closest', 'Closest to finished'],
  ['newest', 'Newest added'],
  ['az', 'Name (A–Z)'],
  ['year', 'Year (oldest first)'],
];
const SET_VIEWS = [['grid', '▦', 'Grid'], ['list', '☰', 'List'], ['compact', '≡', 'Compact']];

function setsInOrder() {
  switch (ui.setSort) {
    case 'worth': return setsWorthFirst();
    case 'closest': return setsClosestFirst();
    case 'az': return sortedSets().sort((a, b) => a.name.localeCompare(b.name));
    case 'year': return sortedSets().sort((a, b) => (a.year || 0) - (b.year || 0) || a.name.localeCompare(b.name));
    default: return sortedSets();
  }
}

function setPic(s, cls = '') {
  return s.img
    ? `<img class="${cls}" src="${esc(s.img)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;${cls} no-pic&quot;>🧱</span>'">`
    : `<span class="${cls} no-pic">🧱</span>`;
}

function renderSets() {
  setTitle('My sets');
  const all = setsInOrder();
  const index = swapIndex();
  let html = `<button class="btn primary block" id="addBtn">＋ Add a set</button><p></p>`;
  if (!all.length) {
    html += `<div class="empty"><div class="big">🧱</div>No sets yet.<br>Tap <b>Add a set</b> and enter the set number from the manual cover.</div>`;
  } else {
    const info = new Map(all.map((s) => {
      const st = setStats(s);
      return [s.setNum, {
        st,
        pct: st.need ? Math.round((st.have / st.need) * 100) : 100,
        swaps: st.missing ? swapsFor(s, index).reduce((t, m) => t + m.qty, 0) : 0,
      }];
    }));
    const done = all.filter((s) => !info.get(s.setNum).st.missing).length;
    if (ui.setsShow === 'done' && !done) ui.setsShow = 'all';
    if (ui.setsShow === 'todo' && done === all.length) ui.setsShow = 'all';

    html += `
      <div class="sets-toolbar">
        <label class="sort-select">
          <span class="muted small">Sort</span>
          <select id="setSort" aria-label="Sort sets">
            ${SET_SORTS.map(([v, label]) => `<option value="${v}" ${ui.setSort === v ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <div class="view-toggle" role="group" aria-label="View">
          ${SET_VIEWS.map(([v, icon, label]) => `<button data-view="${v}" class="${ui.setView === v ? 'active' : ''}" aria-label="${label} view" title="${label}">${icon}</button>`).join('')}
        </div>
      </div>
      <div class="chips">
        <button class="chip ${ui.setsShow === 'all' ? 'active' : ''}" data-filter="all">All (${all.length})</button>
        <button class="chip ${ui.setsShow === 'todo' ? 'active' : ''}" data-filter="todo">In progress (${all.length - done})</button>
        <button class="chip ${ui.setsShow === 'done' ? 'active' : ''}" data-filter="done">Complete (${done})</button>
      </div>`;
    const valued = all.filter(hasValue);
    html += `<p class="muted small">${valued.length
      ? `Total value: <b>${money(valued.reduce((t, s) => t + s.value, 0))}</b> (${valued.length} of ${all.length} sets valued)${ui.setSort === 'worth' ? '. Most value per missing piece first.' : ''}`
      : 'Tip: add a value to each set (open the set and tap <b>Add value</b>) to see which are worth finishing first.'}</p>`;
    if (all.length > 4) html += searchBox('setSearch', ui.setSearch, 'Search sets…');

    const q = ui.setSearch.toLowerCase();
    const sets = all.filter((s) => {
      const { st } = info.get(s.setNum);
      if (ui.setsShow === 'todo' && !st.missing) return false;
      if (ui.setsShow === 'done' && st.missing) return false;
      return !q || s.name.toLowerCase().includes(q) || s.setNum.toLowerCase().includes(q);
    });

    if (!sets.length) {
      html += `<div class="empty">${q ? 'No sets match your search.' : ui.setsShow === 'done' ? 'No complete sets yet.' : 'No sets in progress.'}</div>`;
    } else if (ui.setView === 'grid') {
      html += `<div class="set-grid">${sets.map((s) => {
        const { st, pct, swaps } = info.get(s.setNum);
        return `
        <div class="set-tile" data-set="${esc(s.setNum)}">
          <div class="tile-pic">
            ${setPic(s)}
            ${st.missing ? `<span class="tile-tag miss">${st.missing} missing</span>` : '<span class="tile-tag ok">Complete ✓</span>'}
          </div>
          <div class="tile-body">
            <div class="tile-name">${esc(s.name)}</div>
            <div class="muted small">#${esc(shortSetNum(s.setNum))} · ${esc(s.year)}</div>
            <div class="progress"><div style="width:${pct}%"></div></div>
            ${hasValue(s) || swaps ? `<div class="tile-meta">${hasValue(s) ? `<b class="value">${money(s.value)}</b>` : ''}${swaps ? `<span class="badge swap">🔁 ${swaps}</span>` : ''}</div>` : ''}
          </div>
        </div>`;
      }).join('')}</div>`;
    } else if (ui.setView === 'compact') {
      html += `<div class="card compact-list">${sets.map((s) => {
        const { st, swaps } = info.get(s.setNum);
        return `
        <div class="compact-row" data-set="${esc(s.setNum)}">
          ${setPic(s, 'compact-pic')}
          <div class="grow">
            <div class="compact-name">${esc(s.name)}</div>
            <div class="muted small">#${esc(shortSetNum(s.setNum))} · ${esc(s.year)}${hasValue(s) ? ` · ${money(s.value)}` : ''}${swaps ? ' · 🔁 ' + swaps : ''}</div>
          </div>
          ${st.missing ? `<span class="badge miss">${st.missing} missing</span>` : '<span class="badge ok">Complete ✓</span>'}
        </div>`;
      }).join('')}</div>`;
    } else {
      for (const s of sets) {
        const { st, pct, swaps } = info.get(s.setNum);
        html += `
        <div class="card set-card" data-set="${esc(s.setNum)}">
          ${s.img ? `<img src="${esc(s.img)}" alt="" loading="lazy">` : ''}
          <div class="grow">
            <div class="name">${esc(s.name)}</div>
            <div class="muted small">#${esc(shortSetNum(s.setNum))} · ${esc(s.year)}${hasValue(s) ? ` · <b class="value">${money(s.value)}</b>` : ''}</div>
            <div class="progress"><div style="width:${pct}%"></div></div>
            <div class="small" style="margin-top:4px">
              ${st.missing
                ? `<span class="badge miss">${st.missing} missing</span> <span class="muted">${st.have}/${st.need} pieces</span>`
                : `<span class="badge ok">Complete ✓</span> <span class="muted">${st.need} pieces</span>`}
            </div>
            ${swaps ? `<div class="small" style="margin-top:4px"><span class="badge swap">🔁 ${swaps} can be swapped in</span></div>` : ''}
          </div>
          <button class="icon-btn" data-del="${esc(s.setNum)}" aria-label="Delete ${esc(s.name)}">🗑</button>
        </div>`;
      }
    }
  }
  if (TIP_URL && all.length) {
    html += `<p class="center small muted" style="margin-top:20px">Enjoying Last Brick? <a href="${esc(TIP_URL)}" target="_blank" rel="noopener">☕ Buy me a coffee</a></p>`;
  }
  $('#view').innerHTML = html;
  $('#addBtn').onclick = () => go('#add');
  const sortSel = $('#setSort');
  if (sortSel) sortSel.onchange = () => { ui.setSort = sortSel.value; savePref('setSort', sortSel.value); renderSets(); };
  document.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => { ui.setView = b.dataset.view; savePref('setView', b.dataset.view); renderSets(); };
  });
  document.querySelectorAll('[data-filter]').forEach((b) => {
    b.onclick = () => { ui.setsShow = b.dataset.filter; savePref('setsShow', b.dataset.filter); renderSets(); };
  });
  bindSearch('setSearch', (v) => { ui.setSearch = v; }, renderSets);
  document.querySelectorAll('[data-set]').forEach((el) => {
    el.onclick = (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { deleteSet(del.dataset.del).then((gone) => gone && renderSets()); return; }
      go('#set/' + encodeURIComponent(el.dataset.set));
    };
  });
}

function renderAdd() {
  setTitle('Add a set');
  $('#view').innerHTML = `
    <div class="card">
      <label class="lbl" for="setNum">Set number</label>
      <input class="field" id="setNum" inputmode="numeric" pattern="[0-9]*" placeholder="e.g. 6080" autocomplete="off" autocapitalize="off">
      <p class="muted small">It's on the front of the manual and the box.</p>
      <label class="lbl">How complete is it?</label>
      <div class="seg" id="startMode">
        <button data-v="most">Mostly complete</button>
        <button data-v="none" class="active">Start from zero</button>
      </div>
      <p class="muted small" id="modeHelp"></p>
      <button class="btn primary block" id="fetchBtn">Get parts list</button>
      <div id="addStatus"></div>
    </div>`;
  let mode = 'none';
  const help = {
    most: 'Every piece starts ticked as <b>have</b>. Then just untick the few that are missing — much quicker!',
    none: 'Every piece starts as <b>missing</b>. Tick them off as you find them.',
  };
  $('#modeHelp').innerHTML = help[mode];
  document.querySelectorAll('#startMode button').forEach((b) => {
    b.onclick = () => {
      mode = b.dataset.v;
      document.querySelectorAll('#startMode button').forEach((x) => x.classList.toggle('active', x === b));
      $('#modeHelp').innerHTML = help[mode];
    };
  });
  const input = $('#setNum');
  input.focus();
  const submit = async () => {
    const num = normaliseSetNum(input.value);
    if (!num) return toast('Enter a set number');
    if (state.sets[num]) return go('#set/' + encodeURIComponent(num));
    const btn = $('#fetchBtn');
    btn.disabled = true;
    $('#addStatus').innerHTML = '<div class="spinner"></div><p class="center muted">Downloading parts list…</p>';
    try {
      const set = await fetchSet(num);
      if (!set.parts.length) throw new Error('Rebrickable has no parts list for this set.');
      if (mode === 'most') set.parts.forEach((p) => { p.have = p.qty; });
      state.sets[set.setNum] = set;
      save();
      ui.setFilter = mode === 'most' ? 'all' : 'missing';
      location.replace('#set/' + encodeURIComponent(set.setNum));
      if (mode === 'most') toast('Now untick the pieces that are missing');
    } catch (e) {
      btn.disabled = false;
      const msg = e instanceof TypeError ? 'No connection to Rebrickable. Check your internet and try again.' : e.message;
      $('#addStatus').innerHTML = `<p class="center" style="color:var(--miss)">${esc(msg)}</p>`;
    }
  };
  $('#fetchBtn').onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

function renderSwapBox(set) {
  const swaps = swapsFor(set);
  if (!swaps.length) return '';
  const st = setStats(set);
  const total = swaps.reduce((t, m) => t + m.qty, 0);
  const stats = new Map(Object.values(state.sets).map((s) => [s.setNum, setStats(s)]));
  return `
    <div class="card swap-box">
      <h2>🔁 ${total} of ${st.missing} missing ${st.missing === 1 ? 'piece is' : 'pieces are'} in your other sets</h2>
      <p class="muted small">These sets have more left to find${hasValue(set) ? ' (and are worth less, where you\'ve added values)' : ''}, so it makes sense to move the pieces here. <b>Move</b> updates both sets.</p>
      ${swaps.map((m, i) => {
        const fst = stats.get(m.from.setNum);
        return `
        <div class="for-set">
          <div class="row grow" style="min-width:0">
            <div class="thumb">${partImg(m.part)}</div>
            <div class="grow" style="min-width:0">
              <div class="sname"><b>${m.qty}× ${esc(m.part.name)}</b></div>
              <div class="small muted">${swatch(m.part.rgb)} ${esc(m.part.colorName)}</div>
              <div class="small">from <b>${esc(m.from.name)}</b> <span class="muted">#${esc(shortSetNum(m.from.setNum))} · ${hasValue(m.from) ? money(m.from.value) + ' · ' : ''}${fst.missing ? fst.missing + ' missing' : 'complete'}</span></div>
            </div>
          </div>
          <button class="btn ok small" data-move="${i}">Move</button>
        </div>`;
      }).join('')}
    </div>`;
}

function renderSet(setNum) {
  const set = state.sets[setNum];
  if (!set) { go('#sets'); return; }
  setTitle(set.name);
  const st = setStats(set);
  const f = ui.setFilter;
  const parts = set.parts.filter((p) =>
    f === 'all' ? true : f === 'missing' ? p.have < p.qty : p.have >= p.qty);

  let html = `
    <div class="card set-card" style="cursor:default">
      ${set.img ? `<img src="${esc(set.img)}" alt="">` : ''}
      <div class="grow">
        <div class="muted small">#${esc(shortSetNum(set.setNum))} · ${esc(set.year)} · ${st.kinds} different parts</div>
        <div class="progress"><div style="width:${st.need ? Math.round(st.have / st.need * 100) : 100}%"></div></div>
        <div style="margin-top:6px">
          ${st.missing ? `<span class="badge miss">${st.missing} ${st.missing === 1 ? 'piece' : 'pieces'} missing</span>` : `<span class="badge ok">Complete ✓</span>`}
          <span class="muted small">${st.have} / ${st.need}</span>
        </div>
        <button class="btn small value-btn" id="valueBtn">${hasValue(set) ? `💷 ${money(set.value)} · edit` : '💷 Add value'}</button>
      </div>
    </div>
    ${renderSwapBox(set)}
    <div class="seg" id="filter">
      <button data-f="missing" class="${f === 'missing' ? 'active' : ''}">Missing (${st.kindsMissing})</button>
      <button data-f="have" class="${f === 'have' ? 'active' : ''}">Have (${st.kinds - st.kindsMissing})</button>
      <button data-f="all" class="${f === 'all' ? 'active' : ''}">All (${st.kinds})</button>
    </div>
    <p class="muted small">Tap a picture to tick it off / untick it. Use − and + for pieces you need several of.</p>`;

  if (!parts.length) {
    html += f === 'missing'
      ? `<div class="empty"><div class="big">🎉</div>Nothing missing — this set is complete!</div>`
      : `<div class="empty">No pieces here yet.</div>`;
  } else {
    html += `<div class="grid">`;
    for (const p of parts) {
      const missing = p.qty - p.have;
      html += `
        <div class="part ${missing ? 'missing' : 'done'}" data-key="${esc(p.key)}">
          <div class="pic" data-act="toggle">
            ${partImg(p)}
            ${missing ? `<span class="need-tag">need ${missing}</span>` : `<span class="tick">✓</span>`}
          </div>
          <div class="info">
            <div class="pname">${esc(p.name)}</div>
            <div class="meta">${swatch(p.rgb)} ${esc(p.colorName)} · ${esc(p.partNum)}</div>
          </div>
          <div class="counter">
            <button data-act="minus" aria-label="One less">−</button>
            <span class="count">${p.have}<span class="of"> / ${p.qty}</span></span>
            <button data-act="plus" aria-label="One more">+</button>
          </div>
        </div>`;
    }
    html += `</div>`;
  }

  html += `
    <p></p>
    <div class="card">
      <h2>Set options</h2>
      <div class="row" style="flex-wrap:wrap">
        <button class="btn small" id="allHave">Tick all as have</button>
        <button class="btn small" id="allMissing">Untick all (start again)</button>
        <button class="btn small" id="refresh">Re-download list</button>
        <button class="btn small" id="del" style="color:var(--miss)">Delete set</button>
      </div>
    </div>`;
  $('#view').innerHTML = html;

  document.querySelectorAll('#filter button').forEach((b) => {
    b.onclick = () => { ui.setFilter = b.dataset.f; renderSet(setNum); };
  });
  $('#view').querySelectorAll('.part').forEach((el) => {
    el.onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      const p = set.parts.find((x) => x.key === el.dataset.key);
      if (act === 'toggle') changeHave(setNum, p.key, p.have >= p.qty ? -p.qty : p.qty - p.have);
      if (act === 'plus') changeHave(setNum, p.key, 1);
      if (act === 'minus') changeHave(setNum, p.key, -1);
      const y = window.scrollY;
      renderSet(setNum);
      window.scrollTo(0, y);
    };
  });
  $('#allHave').onclick = async () => {
    if (!await askConfirm({ title: 'Tick every piece as have?', text: 'Every piece in this set will be marked as found.', ok: 'Tick all' })) return;
    setAllHave(setNum, true);
    if (route().arg === setNum) renderSet(setNum);
    toast('All pieces ticked');
  };
  $('#allMissing').onclick = async () => {
    if (!await askConfirm({ title: 'Untick every piece?', text: 'This clears all your ticks for this set so you can start again. Every piece will show as missing.', ok: 'Untick all', danger: true })) return;
    setAllHave(setNum, false);
    ui.setFilter = 'missing';
    if (route().arg === setNum) { renderSet(setNum); window.scrollTo(0, 0); }
    toast('All pieces unticked — starting again');
  };
  $('#valueBtn').onclick = () => editValue(set);
  const swaps = swapsFor(set);
  document.querySelectorAll('[data-move]').forEach((b) => {
    b.onclick = () => {
      moveBetweenSets(set, swaps[Number(b.dataset.move)]);
      const y = window.scrollY;
      renderSet(setNum);
      window.scrollTo(0, y);
    };
  });
  const delBtn = $('#delBtn');
  delBtn.classList.remove('hidden');
  $('#del').onclick = delBtn.onclick = async () => { if (await deleteSet(setNum)) go('#sets'); };
  $('#refresh').onclick = async () => {
    try {
      toast('Downloading…');
      const fresh = await fetchSet(setNum, { refresh: true });
      const old = new Map(set.parts.map((p) => [p.key, p.have]));
      fresh.parts.forEach((p) => { p.have = Math.min(p.qty, old.get(p.key) || 0); });
      fresh.addedAt = set.addedAt;
      if (hasValue(set)) fresh.value = set.value;
      state.sets[setNum] = fresh; save(); renderSet(setNum);
      toast('Parts list updated (your ticks were kept)');
    } catch (e) { toast(e.message); }
  };
}

/* All missing pieces across all sets, grouped by part + colour. */
function missingGroups() {
  const groups = new Map();
  for (const set of sortedSets()) {
    for (const p of set.parts) {
      const need = p.qty - p.have;
      if (need <= 0) continue;
      let g = groups.get(p.key);
      if (!g) {
        g = { key: p.key, part: p, total: 0, sets: [] };
        groups.set(p.key, g);
      }
      g.total += need;
      g.sets.push({ set, need });
    }
  }
  return [...groups.values()];
}

function renderMissing() {
  setTitle('Looking for');
  const all = missingGroups();
  if (!Object.keys(state.sets).length) {
    $('#view').innerHTML = `<div class="empty"><div class="big">🔎</div>Add a set first, then all its missing pieces show up here.</div>`;
    return;
  }
  if (!all.length) {
    $('#view').innerHTML = `<div class="empty"><div class="big">🎉</div>You're not missing anything. All your sets are complete!</div>`;
    return;
  }

  for (const g of all) g.type = pieceType(g.part);

  // Colour chips (most common first). Each row's counts respect the other filter.
  const colors = new Map();
  for (const g of all) {
    const c = colors.get(g.part.colorName) || { name: g.part.colorName, rgb: g.part.rgb, n: 0 };
    if (!ui.missingType || g.type === ui.missingType) c.n += g.total;
    colors.set(c.name, c);
  }
  const colorList = [...colors.values()].filter((c) => c.n || c.name === ui.missingColor).sort((a, b) => b.n - a.n);
  if (ui.missingColor && !colors.has(ui.missingColor)) ui.missingColor = '';

  const types = new Map(PIECE_TYPES.map((t) => [t, 0]));
  for (const g of all) {
    if (!ui.missingColor || g.part.colorName === ui.missingColor) types.set(g.type, types.get(g.type) + g.total);
  }
  if (ui.missingType && !all.some((g) => g.type === ui.missingType)) ui.missingType = '';
  const typeList = PIECE_TYPES.filter((t) => types.get(t) || t === ui.missingType);

  const q = ui.missingSearch.trim().toLowerCase();
  const shown = all.filter((g) =>
    (!ui.missingColor || g.part.colorName === ui.missingColor) &&
    (!ui.missingType || g.type === ui.missingType) &&
    (!q || g.part.name.toLowerCase().includes(q) || g.part.partNum.toLowerCase().includes(q) ||
      g.part.colorName.toLowerCase().includes(q)));
  shown.sort((a, b) => a.part.colorName.localeCompare(b.part.colorName) || a.part.name.localeCompare(b.part.name));

  const totalPieces = all.reduce((n, g) => n + g.total, 0);
  let html = `
    <p class="muted small">${totalPieces} pieces missing across ${new Set(all.flatMap((g) => g.sets.map((s) => s.set.setNum))).size} sets. Sorting a pile? Pick a colour and a type of piece below.</p>
    ${searchBox('mSearch', ui.missingSearch, 'Search by name or part number…')}
    <div class="chips">
      <button class="chip ${!ui.missingColor ? 'active' : ''}" data-color="">All colours</button>
      ${colorList.map((c) => `<button class="chip ${ui.missingColor === c.name ? 'active' : ''}" data-color="${esc(c.name)}">${swatch(c.rgb)}${esc(c.name)} (${c.n})</button>`).join('')}
    </div>
    <div class="chips">
      <button class="chip ${!ui.missingType ? 'active' : ''}" data-type="">All types</button>
      ${typeList.map((t) => `<button class="chip ${ui.missingType === t ? 'active' : ''}" data-type="${esc(t)}">${esc(t)} (${types.get(t)})</button>`).join('')}
    </div>
    <div class="seg" id="mView">
      <button data-v="list" class="${ui.missingView === 'list' ? 'active' : ''}">☰ List with sets</button>
      <button data-v="grid" class="${ui.missingView === 'grid' ? 'active' : ''}">▦ All pictures</button>
    </div>
    <div id="mList">`;
  if (!shown.length) html += `<div class="empty">No missing pieces match.</div>`;
  if (ui.missingView === 'grid' && shown.length) {
    html += `<p class="muted small">Every piece you're looking for. Tap one to see which set needs it.</p><div class="grid compact">`;
    for (const g of shown) {
      const p = g.part;
      html += `
        <div class="part missing" data-key="${esc(g.key)}" data-sheet>
          <div class="pic">${partImg(p)}<span class="need-tag">×${g.total}</span></div>
          <div class="info"><div class="meta">${swatch(p.rgb)} ${esc(p.colorName)}</div></div>
        </div>`;
    }
    html += `</div>`;
  }
  for (const g of ui.missingView === 'grid' ? [] : shown) {
    const p = g.part;
    html += `
      <div class="card need-item" data-key="${esc(g.key)}">
        <div class="pic">${partImg(p)}</div>
        <div class="body">
          <div class="pname">${esc(p.name)}</div>
          <div class="meta">${swatch(p.rgb)} ${esc(p.colorName)} · #${esc(p.partNum)}</div>
          <span class="badge miss">need ${g.total}</span>
          ${g.sets.map((s) => `
            <div class="for-set">
              <span class="sname">${s.need}× for <b>${esc(s.set.name)}</b> <span class="muted">#${esc(shortSetNum(s.set.setNum))}</span></span>
              <button class="btn ok small" data-found="${esc(s.set.setNum)}">Found</button>
            </div>`).join('')}
        </div>
      </div>`;
  }
  html += `</div>`;
  $('#view').innerHTML = html;

  bindSearch('mSearch', (v) => { ui.missingSearch = v; }, renderMissing);
  document.querySelectorAll('[data-color]').forEach((b) => {
    b.onclick = () => { ui.missingColor = b.dataset.color; renderMissing(); };
  });
  document.querySelectorAll('[data-type]').forEach((b) => {
    b.onclick = () => { ui.missingType = b.dataset.type; renderMissing(); };
  });
  document.querySelectorAll('[data-found]').forEach((b) => {
    b.onclick = () => {
      const key = b.closest('[data-key]').dataset.key;
      changeHave(b.dataset.found, key, 1, { withUndo: true });
      const y = window.scrollY;
      renderMissing();
      window.scrollTo(0, y);
    };
  });
  document.querySelectorAll('#mView button').forEach((b) => {
    b.onclick = () => { ui.missingView = b.dataset.v; savePref('missingView', b.dataset.v); renderMissing(); };
  });
  document.querySelectorAll('[data-sheet]').forEach((el) => {
    el.onclick = () => showPartSheet(el.dataset.key);
  });
  document.querySelectorAll('.need-item .pic').forEach((el) => {
    el.onclick = () => showPartSheet(el.closest('[data-key]').dataset.key);
  });
}

function showPartSheet(key) {
  const g = missingGroups().find((x) => x.key === key);
  if (!g) return;
  const p = g.part;
  openSheet(`
    <div class="big-pic">${partImg(p)}</div>
    <h2 style="margin-top:12px">${esc(p.name)}</h2>
    <div class="meta muted">${swatch(p.rgb)} ${esc(p.colorName)} · part #${esc(p.partNum)}</div>
    <p><span class="badge miss">need ${g.total}</span></p>
    ${g.sets.map((s) => `
      <div class="for-set">
        <span class="sname">${s.need}× for <b>${esc(s.set.name)}</b> <span class="muted">#${esc(shortSetNum(s.set.setNum))}</span></span>
        <button class="btn ok small" data-sheet-found="${esc(s.set.setNum)}">Found</button>
      </div>`).join('')}
    <p class="small"><a href="https://rebrickable.com/parts/${encodeURIComponent(p.partNum)}/" target="_blank" rel="noopener">More pictures on Rebrickable ↗</a></p>
    <button class="btn block" data-close>Close</button>`);
  document.querySelectorAll('[data-sheet-found]').forEach((b) => {
    b.onclick = () => {
      changeHave(b.dataset.sheetFound, key, 1, { withUndo: true });
      closeSheet();
      const y = window.scrollY;
      renderMissing();
      window.scrollTo(0, y);
    };
  });
}

/* ---------- Scan ---------- */

function renderScan() {
  setTitle('Scan a piece');
  let html = '';
  if (!scanState) {
    html = `
      <div class="card scan-hero">
        <div class="big">📷</div>
        <h2>Found a piece?</h2>
        <p class="muted">Take a photo of <b>one piece</b> on a plain background. The app works out what it is and tells you if one of your sets needs it.</p>
        <p></p>
        <button class="btn primary block" id="snap">Take photo</button>
      </div>
      <div class="card small muted">
        <b>Tips for a good match</b>
        <ul style="margin:6px 0 0; padding-left:20px">
          <li>One piece only, filling most of the photo.</li>
          <li>Plain, light background (a sheet of paper is great).</li>
          <li>Good light, no strong shadows.</li>
          <li>Show the side with the most detail (studs, holes, prints).</li>
        </ul>
      </div>`;
  } else {
    html += `<div class="card"><img class="scan-photo" src="${esc(scanState.photoUrl)}" alt="Your photo"></div>`;
    if (scanState.loading) {
      html += `<div class="spinner"></div><p class="center muted">Working out which piece this is…</p>`;
    } else if (scanState.error) {
      html += `<div class="card"><p style="color:var(--miss)">${esc(scanState.error)}</p>
        <p class="muted small">You can still search the <a href="#missing">Looking for</a> list by name or part number.</p></div>`;
    } else {
      html += renderScanResults(scanState.items);
    }
    html += `<button class="btn primary block" id="snap">📷 Scan another piece</button>`;
  }
  $('#view').innerHTML = html;
  $('#snap').onclick = () => $('#cameraInput').click();
  bindScanResultButtons();
}

function renderScanResults(items) {
  if (!items.length) {
    return `<div class="card"><p class="verdict no">Couldn't recognise that piece.</p>
      <p class="muted small">Try again closer up, on a plain background — or search the <a href="#missing">Looking for</a> list.</p></div>`;
  }
  const top = items.slice(0, 4);
  const results = top.map((it) => ({ it, ...findMissingMatches(it.id) }));
  const anyHit = results.some((r) => r.exact.length || r.similar.length);
  let html = anyHit
    ? `<p class="verdict yes">✅ Yes — you're looking for this!</p>`
    : `<p class="verdict no">Not on your missing list.</p>
       <p class="muted small">Check the best guess below looks right. If it's wrong, try another photo.</p>`;

  results.forEach((r, i) => {
    const hits = [...r.exact, ...r.similar];
    if (i > 0 && !hits.length) return; // only show alternative guesses that matter
    const score = Math.round((r.it.score || 0) * 100);
    html += `
      <div class="card match-card ${hits.length ? 'hit' : ''}">
        <div class="row">
          ${r.it.img_url ? `<img src="${esc(r.it.img_url)}" alt="" style="width:72px;height:72px;object-fit:contain;background:#fff;border-radius:8px">` : ''}
          <div class="grow">
            <div class="small muted">${i === 0 ? 'Best guess' : 'Could also be'} · ${score}% sure</div>
            <div style="font-weight:600">${esc(r.it.name)}</div>
            <div class="small muted">#${esc(r.it.id)}</div>
          </div>
        </div>`;
    if (hits.length) {
      html += `<p class="small muted" style="margin-top:10px">Needed by — pick the one that matches the colour of your piece:</p>`;
      for (const h of hits) {
        const need = h.p.qty - h.p.have;
        html += `
          <div class="for-set" style="align-items:center">
            <div class="row grow" style="min-width:0">
              <div class="thumb">${partImg(h.p)}</div>
              <div class="grow" style="min-width:0">
                <div class="sname"><b>${esc(h.set.name)}</b> <span class="muted">#${esc(shortSetNum(h.set.setNum))}</span></div>
                <div class="small muted">${swatch(h.p.rgb)} ${esc(h.p.colorName)} · need ${need}${r.exact.includes(h) ? '' : ' · similar part'}</div>
              </div>
            </div>
            <button class="btn ok small" data-scan-found="${esc(h.set.setNum)}" data-key="${esc(h.p.key)}">Add</button>
          </div>`;
      }
    }
    html += `</div>`;
  });
  return html;
}

function bindScanResultButtons() {
  document.querySelectorAll('[data-scan-found]').forEach((b) => {
    b.onclick = () => {
      changeHave(b.dataset.scanFound, b.dataset.key, 1, { withUndo: true });
      renderScan();
    };
  });
}

$('#cameraInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (scanState?.photoUrl) URL.revokeObjectURL(scanState.photoUrl);
  scanState = { photoUrl: URL.createObjectURL(file), loading: true };
  if (route().name !== 'scan') go('#scan'); else renderScan();
  try {
    scanState.items = await identifyPiece(file);
  } catch (err) {
    scanState.error = err instanceof TypeError
      ? 'Could not reach the recognition service. Check your internet connection.'
      : err.message;
  }
  scanState.loading = false;
  if (route().name === 'scan') renderScan();
});

/* ---------- Settings ---------- */

function renderSettings() {
  setTitle('Settings');
  const sets = sortedSets();
  $('#view').innerHTML = `
    ${syncEnabled() ? '<div class="card" id="accountCard"></div>' : ''}
    ${helperAvailable() ? `<details class="card advanced">
      <summary>Advanced: your own Rebrickable key</summary>
      <p class="muted small">Not needed — Last Brick looks up parts lists for you. If you have your own key from <a href="https://rebrickable.com/users/profile/settings/#api" target="_blank" rel="noopener">rebrickable.com</a>, it's only used as a backup if our lookup service is unavailable.</p>
      <input class="field" id="keyInput" value="${esc(state.apiKey)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste API key here (optional)">
      <p></p>
      <button class="btn block" id="saveKey">Save key</button>
    </details>` : `<div class="card">
      <h2>Rebrickable API key</h2>
      <p class="muted small">Free from <a href="https://rebrickable.com/users/profile/settings/#api" target="_blank" rel="noopener">rebrickable.com → Settings → API</a>.</p>
      <input class="field" id="keyInput" value="${esc(state.apiKey)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste API key here">
      <p></p>
      <button class="btn primary block" id="saveKey">Save key</button>
    </div>`}
    <div class="card">
      <h2>Backup file</h2>
      <p class="muted small">${session ? 'Your sets are backed up online automatically. You can also keep a copy as a file.' : 'Your ticks are saved on this phone only. Download a backup now and then, or use it to move to a new phone.'} (${sets.length} sets saved.)</p>
      <div class="row">
        <button class="btn grow" id="exportBtn">⬇️ Download backup</button>
        <button class="btn grow" id="importBtn">⬆️ Restore backup</button>
      </div>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
    </div>
    ${TIP_URL ? `
    <div class="card">
      <h2>☕ Support Last Brick</h2>
      <p class="muted small">Last Brick is free. If it's helped you finish a set, you can say thanks with a small tip.</p>
      <a class="btn primary block" href="${esc(TIP_URL)}" target="_blank" rel="noopener">☕ Buy me a coffee</a>
    </div>` : ''}
    <div class="card small muted">
      <h2 style="color:var(--text)">About</h2>
      <p>Parts lists and pictures: <a href="https://rebrickable.com" target="_blank" rel="noopener">Rebrickable</a>. Piece recognition: <a href="https://brickognize.com" target="_blank" rel="noopener">Brickognize</a>. LEGO® is a trademark of the LEGO Group, which does not sponsor or endorse this app.</p>
      <p><a href="privacy.html">Privacy Policy</a> · <a href="terms.html">Terms of Use</a> · <a href="mailto:hello@lastbrick.co.uk">hello@lastbrick.co.uk</a></p>
    </div>`;
  $('#saveKey').onclick = () => {
    state.apiKey = $('#keyInput').value.trim(); save();
    toast(state.apiKey ? 'Key saved' : 'Key removed');
  };
  renderAccountCard();
  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify({ app: 'lastbrick', version: 1, exportedAt: new Date().toISOString(), sets: state.sets }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `last-brick-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data.sets !== 'object') throw new Error('Not a Last Brick backup file');
      const n = Object.keys(data.sets).length;
      if (!await askConfirm({ title: `Restore ${n} sets from this backup?`, text: 'Sets with the same number on this phone will be replaced.', ok: 'Restore' })) return;
      Object.assign(state.sets, data.sets); save();
      toast(`Restored ${n} sets`); renderSettings();
    } catch (err) { toast('Could not restore: ' + err.message); }
  };
}

function renderAccountCard() {
  const card = $('#accountCard');
  if (!card) return;
  if (session) {
    card.innerHTML = `
      <h2>☁️ Account &amp; backup</h2>
      <p class="small">Logged in as <b>${esc(session.email)}</b></p>
      <p class="small ${sync.error ? '' : 'muted'}" ${sync.error ? 'style="color:var(--miss)"' : ''}>
        ${sync.busy ? 'Backing up…' : sync.error ? '⚠️ Last backup failed: ' + esc(sync.error) : sync.lastAt ? '✅ Backed up ' + timeAgo(sync.lastAt) : 'Not backed up yet'}
      </p>
      <p class="muted small">Changes are backed up automatically and appear on your other devices when you open the app there.</p>
      <div class="row">
        <button class="btn grow" id="syncBtn" ${sync.busy ? 'disabled' : ''}>🔄 Back up now</button>
        <button class="btn grow" id="logoutBtn">Log out</button>
      </div>
      <p class="small" style="margin-top:12px"><a href="#" id="deleteAcct" style="color:var(--miss)">Delete my account</a></p>`;
    $('#syncBtn').onclick = () => { syncNow({ loud: true }); renderAccountCard(); };
    $('#logoutBtn').onclick = async () => {
      if (!await askConfirm({ title: 'Log out?', text: 'Your sets stay on this phone. Log in again any time to carry on backing up.', ok: 'Log out' })) return;
      logOut();
      toast('Logged out');
      renderSettings();
    };
    $('#deleteAcct').onclick = async (e) => {
      e.preventDefault();
      if (!await askConfirm({ title: 'Delete your account?', text: 'This deletes your login and your online backup for good. The sets on this phone are kept.', ok: 'Delete account', danger: true })) return;
      try {
        await deleteAccount();
        toast('Account deleted');
        renderSettings();
      } catch (err) { toast('Could not delete account: ' + err.message); }
    };
    return;
  }
  card.innerHTML = `
    <h2>☁️ Account &amp; backup</h2>
    <p class="small">Log in to back up your sets online and use them on your other devices.</p>
    <input class="field" id="email" type="email" autocomplete="email" autocapitalize="off" placeholder="Email address">
    <p></p>
    <input class="field" id="password" type="password" autocomplete="current-password" placeholder="Password">
    <p></p>
    <div class="row">
      <button class="btn primary grow" id="loginBtn">Log in</button>
      <button class="btn grow" id="registerBtn">Create account</button>
    </div>
    <label class="agree small">
      <input type="checkbox" id="agree">
      <span>New account? Please confirm: I'm 13 or over and agree to the <a href="terms.html">Terms of Use</a> and <a href="privacy.html">Privacy Policy</a>.</span>
    </label>
    <p class="small" style="margin-top:12px"><a href="#" id="forgotPw">Forgot password?</a></p>
    <p class="muted small">Your email and sets are stored securely and only you can see them.</p>`;
  const creds = () => {
    const email = $('#email').value.trim(), password = $('#password').value;
    if (!/^\S+@\S+\.\S+$/.test(email)) { toast('Enter your email address'); return null; }
    if (password.length < 6) { toast('Password must be at least 6 characters'); return null; }
    return { email, password };
  };
  const busy = (on) => { $('#loginBtn').disabled = $('#registerBtn').disabled = on; };
  $('#loginBtn').onclick = async () => {
    const c = creds();
    if (!c) return;
    busy(true);
    try {
      await logIn(c.email, c.password);
      toast('Logged in — your sets are backed up');
      renderSettings();
    } catch (e) { toast(e.message); busy(false); }
  };
  $('#registerBtn').onclick = async () => {
    const c = creds();
    if (!c) return;
    if (!$('#agree').checked) {
      toast("Please tick the box to confirm you're 13 or over and agree to the terms");
      $('.agree').classList.add('need');
      return;
    }
    busy(true);
    try {
      if (await register(c.email, c.password)) {
        toast('Account created — your sets are backed up');
        renderSettings();
      } else {
        busy(false);
        openSheet(`
          <h2>📧 Check your email</h2>
          <p>We've sent a link to <b>${esc(c.email)}</b>. Tap it to confirm your account — it brings you back here, logged in.</p>
          <p class="muted small">Can't see it? Check your spam folder.</p>
          <button class="btn block" data-close>OK</button>`);
      }
    } catch (e) { toast(e.message); busy(false); }
  };
  $('#password').onkeydown = (e) => { if (e.key === 'Enter') $('#loginBtn').click(); };
  $('#forgotPw').onclick = async (e) => {
    e.preventDefault();
    const email = $('#email').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Type your email address first');
    try {
      await sbFetch('/auth/v1/recover?redirect_to=' + encodeURIComponent(appUrl()), { method: 'POST', body: { email } });
      toast('Check your email for a link to reset your password');
    } catch (err) { toast(err.message); }
  };
}

/* ---------- Boot ---------- */

document.querySelectorAll('#tabs button').forEach((b) => {
  b.onclick = () => {
    if (b.dataset.tab === 'scan' && route().name === 'scan' && !scanState) return $('#cameraInput').click();
    go('#' + b.dataset.tab);
  };
});
$('#backBtn').onclick = () => (history.length > 1 ? history.back() : go('#sets'));

render();
handleAuthRedirect().then(() => syncNow());
// Pick up changes from other devices when the app is reopened or back online.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
window.addEventListener('online', () => syncNow());

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}

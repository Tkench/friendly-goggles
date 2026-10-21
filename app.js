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
const BRICKOGNIZE_FIGS = 'https://api.brickognize.com/predict/figs/';
// Tip jar link (Ko-fi / Buy Me a Coffee). The Support button stays hidden while this is empty.
const TIP_URL = '';
// Supabase project for login, backup and sync (see supabase/setup.sql). The
// "anon" key is meant to be public: row-level security keeps each person's
// data private. Accounts stay hidden while these are empty.
const SUPABASE_URL = 'https://nioytuzuejdzznaxvlic.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vWTdvZvwYgGsKhE0m7DbPg_MP_UbMqr';

/* ---------- State ---------- */

let state = load();
let ui = { setFilter: 'missing', missingColor: '', setSearch: '', missingView: loadPref('missingView2', 'list'), missingSort: loadPref('missingSort', 'colour'), missingType: '', setSort: loadPref('setSort', 'closest'), setView: loadPref('setView', 'grid'), setsShow: loadPref('setsShow', 'all'), collection: loadPref('collection', 'sets'), partView: loadPref('partView', 'grid'), partSort: loadPref('partSort', 'colour'), partColor: '', partType: '', partSetNum: '' };
let lastUndo = null;
let scanState = null; // { photoUrl, loading, error, items }
let figAdd = {}; // the Add a minifigure page (scans and their results)

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
const setSig = (set) => JSON.stringify([set.name, set.value, set.count || 1, set.parts.length, set.parts.map((p) => p.have)]);
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
/* ---------- Free to try: one set or minifigure without an account ----------
 * Adding a second one asks people to create a free account (or log in).
 * Everything already added is kept; scanning works without an account. */
const FREE_ITEMS = 1;
let afterAuth = null; // what to do once someone logs in from the sign-up panel

function needsAccount() {
  return syncEnabled() && !session && Object.keys(state.sets).length >= FREE_ITEMS;
}

// Returns true if adding can go ahead; otherwise shows the sign-up panel and,
// once they're logged in, runs `then`.
function accountGate(then = () => render()) {
  if (!needsAccount()) return true;
  openSheet(`
    <div class="gate">
      <button class="sheet-x" data-close aria-label="Close">✕</button>
      ${brandArt({ cls: 'gate-art' })}
      <h2>Create a free account to add more</h2>
      <p class="muted">You've tried Last Brick with your first ${Object.values(state.sets).some(isFig) ? 'minifigure' : 'set'}. A free account lets you add as many sets and minifigures as you like, backs them up, and keeps them in sync on your other devices.</p>
      <p class="muted small">What you've already added comes with you.</p>
      <div id="accountCard" class="gate-card"></div>
    </div>`);
  afterAuth = () => { closeSheet(); then(); };
  renderAccountCard();
  return false;
}

function authDone(message) {
  toast(message);
  if (afterAuth) { const next = afterAuth; afterAuth = null; next(); } else renderSettings();
}

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

// Minifigures are kept alongside sets (same pieces, ticks, sync), marked kind 'fig'.
const isFig = (s) => s.kind === 'fig' || /^fig-/i.test(s.setNum);
const noun = (s, n = 1) => (isFig(s) ? (n === 1 ? 'minifigure' : 'minifigures') : (n === 1 ? 'set' : 'sets'));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const setSub = (s) => `${(s.count || 1) > 1 ? `×${s.count} · ` : ''}#${shortSetNum(s.setNum)}${s.year ? ' · ' + s.year : ''}`;

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

/* ---------- Minifigures (through our helper) ---------- */

async function helperGet(query) {
  if (!helperAvailable()) throw new Error("Minifigure lookups aren't available right now — please try again later.");
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/rebrickable?${query}`, { headers: { apikey: SUPABASE_KEY } });
  } catch {
    throw new Error('No connection. Check your internet and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const err = new Error(res.status === 404 ? 'Not found on Rebrickable.'
    : res.status === 429 ? 'Lots of people are using Last Brick right now — wait a minute and try again.'
      : "Minifigure lookups aren't available right now — please try again later.");
  err.status = res.status;
  throw err;
}

/* The "piece → minifigures" lookup, rebuilt weekly from Rebrickable's catalogue
 * downloads by tools/build-fig-index.mjs and published with the app. */
const FIG_INDEX = 'data/figindex/';
const RB_MEDIA = 'https://cdn.rebrickable.com/media/';
const figIndexFiles = new Map();

function shardOf(partNum) { // must match tools/build-fig-index.mjs
  let h = 5381;
  for (const ch of String(partNum).toLowerCase()) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return (h % 256).toString(16).padStart(2, '0');
}

function figIndexFile(name) {
  if (!figIndexFiles.has(name)) {
    figIndexFiles.set(name, fetch(FIG_INDEX + name).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return figIndexFiles.get(name).then((data) => { if (!data) figIndexFiles.delete(name); return data; });
}

// The lookup entry for one piece: { n: name, c: { colourId: { i: picture, f: [[fig, name, picture, pieces]…] } } }
async function figIndexPart(partNum) {
  const shard = await figIndexFile(`p/${shardOf(partNum)}.json`);
  return shard ? shard[String(partNum).toLowerCase()] || null : undefined; // undefined: lookup not available
}

const figCache = new Map(); // figures looked at on the Add page, so adding doesn't download again

async function fetchFig(figNum, { refresh = false } = {}) {
  if (!refresh && figCache.has(figNum)) return structuredClone(figCache.get(figNum));
  const data = await helperGet(`fig=${encodeURIComponent(figNum)}${refresh ? '&refresh=1' : ''}`);
  const fig = buildSet({ ...data.info, year: '' }, data.results || [], data.cats || {});
  fig.kind = 'fig';
  fig.count = 1;
  for (const p of fig.parts) p.per = p.qty;
  fig.inSets = (data.sets || []).map((x) => ({ setNum: x.set_num, name: x.name, year: x.year, img: x.set_img_url || '' }))
    .sort((a, b) => (a.year || 0) - (b.year || 0));
  // Accessories and stand from the figure's own packet (collectable series, polybag…).
  if (data.pack) {
    addAccessories(fig, buildSet({ set_num: data.pack.set_num, name: '', year: '' }, data.pack.results || [], data.cats || {}).parts);
    fig.pack = { setNum: data.pack.set_num, name: data.pack.name };
  }
  fig.accChecked = true;
  figCache.set(figNum, fig);
  return structuredClone(fig);
}

// How many of a piece one figure needs (qty covers all copies of the figure).
const perFig = (fig, p) => p.per || p.qty / (fig.count || 1);

function addAccessories(fig, accParts) {
  const n = fig.count || 1;
  for (const a of accParts) {
    const one = a.per || a.qty;
    const same = fig.parts.find((p) => p.key === a.key);
    if (same) { same.per = perFig(fig, same) + one; same.qty = same.per * n; }
    else fig.parts.push({ ...a, per: one, qty: one * n, have: 0, acc: true });
  }
}

// Changes how many of a figure you have. Pieces found stay ticked (up to the new total).
function setFigCount(fig, n) {
  for (const p of fig.parts) {
    p.per = perFig(fig, p);
    p.qty = p.per * n;
    p.have = Math.min(p.have, p.qty);
  }
  fig.count = n;
}

// How many complete copies of a figure you have.
function figsComplete(fig) {
  return Math.min(...fig.parts.map((p) => Math.floor(p.have / perFig(fig, p))), fig.count || 1);
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

async function identifyPiece(file, api = BRICKOGNIZE_API) {
  const blob = await shrinkImage(file);
  const form = new FormData();
  form.append('query_image', blob, 'piece.jpg');
  const res = await fetch(api, { method: 'POST', body: form });
  if (!res.ok) throw new Error('Recognition service error ' + res.status);
  const data = await res.json();
  return { items: data.items || [], box: data.bounding_box || null };
}

// Zooms a photo in on the box the scanner found the piece or figure in, with a
// little space around it. Returns a new picture link, or null to keep the whole
// photo (no box, an unsure box, or the piece already fills the photo).
async function zoomToBox(url, box) {
  if (!box || !(box.image_width > 0) || !(box.image_height > 0) || (box.score ?? 1) < 0.3) return null;
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = url;
  }).catch(() => null);
  if (!img) return null;
  const W = img.naturalWidth, H = img.naturalHeight;
  const sx = W / box.image_width, sy = H / box.image_height;
  const l = box.left * sx, t = box.upper * sy, r = box.right * sx, b = box.lower * sy;
  const w = r - l, h = b - t;
  if (w <= 0 || h <= 0 || w * h > 0.6 * W * H) return null;
  const pad = Math.max(w, h) * 0.2;
  let cw = w + 2 * pad, ch = h + 2 * pad;
  if (cw / ch < 4 / 3) cw = ch * 4 / 3; else ch = cw * 3 / 4; // same shape as the photo frame
  cw = Math.min(cw, W); ch = Math.min(ch, H);
  const cx = Math.max(0, Math.min(W - cw, (l + r) / 2 - cw / 2));
  const cy = Math.max(0, Math.min(H - ch, (t + b) / 2 - ch / 2));
  const scale = Math.min(1, 1000 / cw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cw * scale);
  canvas.height = Math.round(ch * scale);
  canvas.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  return blob ? URL.createObjectURL(blob) : null;
}

// Swaps a scan's photo for the zoomed-in one, when there is one.
async function zoomPhoto(holder, box) {
  const zoomed = await zoomToBox(holder.photoUrl, box);
  if (!zoomed) return;
  URL.revokeObjectURL(holder.photoUrl);
  holder.photoUrl = zoomed;
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
    text: `Its parts list and your ticks will be removed from this phone. You can add the ${noun(set)} again later, but you'd need to re-tick the pieces.`,
    ok: `Delete ${noun(set)}`,
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
  afterAuth = null;
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
  const sub = r.name === 'set' || r.name === 'add' || r.name === 'addfig';
  const tab = sub ? 'sets' : r.name;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const back = $('#backBtn');
  back.classList.toggle('hidden', !sub);
  $('#delBtn').classList.add('hidden'); // renderSet shows it for the open set

  if (r.name !== 'settings' && (needsOwnKey() || (!state.welcomed && !Object.keys(state.sets).length))) return renderWelcome();

  switch (r.name) {
    case 'set': return renderSet(r.arg);
    case 'add': return renderAdd();
    case 'addfig': return renderAddFig();
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

// Sideways-swipe cards with dots, as on the welcome page. items: [icon html, title, text]
function swipeCards(id, items) {
  return `
    <ol class="steps" id="${id}">
      ${items.map(([ico, t, d], i) => `<li><span class="step-ico" aria-hidden="true">${ico}</span><span class="step-n">${String(i + 1).padStart(2, '0')} /</span><b>${t}</b><span class="step-text">${d}</span></li>`).join('')}
    </ol>
    <div class="step-dots" id="${id}Dots" aria-hidden="true">${items.map((_, i) => `<span class="${i ? '' : 'on'}"></span>`).join('')}</div>`;
}

function bindSwipeCards(id) {
  const list = $('#' + id);
  if (!list) return;
  list.addEventListener('scroll', () => {
    const cards = [...list.children];
    const mid = list.scrollLeft + list.clientWidth / 2;
    const i = cards.reduce((best, c, n) => (Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid) < Math.abs(cards[best].offsetLeft + cards[best].offsetWidth / 2 - mid) ? n : best), 0);
    [...$('#' + id + 'Dots').children].forEach((d, n) => d.classList.toggle('on', n === i));
  }, { passive: true });
}

// Small version of the Scan page picture: the red brick in camera corners with
// a scanning line across it. onRed swaps to white for red buttons.
function scanIcon({ onRed = false, cls = 'scan-ico' } = {}) {
  const [f, e] = onRed ? ['#ffffff', '#ffd2d2'] : BRICK_COLOURS.r;
  const corner = onRed ? '#ffffff' : 'var(--brand)';
  const line = onRed ? '#f6c31b' : 'var(--brand)';
  const c = (d) => `<path d="${d}" fill="none" stroke="${corner}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<svg class="${cls}" viewBox="0 0 28 26" aria-hidden="true">
    ${c('M2.5 8 V3 H7.5')}${c('M20.5 3 H25.5 V8')}${c('M25.5 18 V23 H20.5')}${c('M7.5 23 H2.5 V18')}
    ${[0, 1, 2].map((i) => `<rect x="${8.2 + i * 4.3}" y="7.6" width="2.8" height="2.2" rx=".7" fill="${f}" stroke="${e}" stroke-width=".8"/>`).join('')}
    <rect x="7" y="9.4" width="14" height="8.6" rx="1.4" fill="${f}" stroke="${e}" stroke-width="1"/>
    <rect x="4.5" y="12.4" width="19" height="1.9" rx=".95" fill="${line}" stroke="#fff" stroke-width="${onRed ? 0 : 0.6}"/>
  </svg>`;
}

// A whole minifigure inside the scan corners, for "Scan whole figure".
function scanFigIcon(cls = 'scan-ico') {
  const [y, ye] = BRICK_COLOURS.y, [r, re] = BRICK_COLOURS.r, [b, be] = BRICK_COLOURS.b;
  const c = (d) => `<path d="${d}" fill="none" stroke="var(--brand)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<svg class="${cls}" viewBox="0 0 28 26" aria-hidden="true">
    ${c('M2.5 8 V3 H7.5')}${c('M20.5 3 H25.5 V8')}${c('M25.5 18 V23 H20.5')}${c('M7.5 23 H2.5 V18')}
    <rect x="11.6" y="3" width="4.8" height="4.6" rx="1.6" fill="${y}" stroke="${ye}" stroke-width=".7"/>
    <path d="M10.6 8 H17.4 L18.4 14.4 H9.6 Z" fill="${r}" stroke="${re}" stroke-width=".7" stroke-linejoin="round"/>
    <rect x="9.6" y="14.3" width="8.8" height="1.8" rx=".4" fill="${b}" stroke="${be}" stroke-width=".6"/>
    <rect x="9.8" y="15.9" width="4" height="6" rx=".5" fill="${b}" stroke="${be}" stroke-width=".6"/>
    <rect x="14.2" y="15.9" width="4" height="6" rx=".5" fill="${b}" stroke="${be}" stroke-width=".6"/>
    <rect class="ico-scan-line" x="4.5" y="12.4" width="19" height="1.9" rx=".95" fill="var(--brand)" stroke="#fff" stroke-width=".6"/>
  </svg>`;
}

// A minifigure head inside the scan corners, with a moving scan line, for "Scan one piece".
function scanHeadIcon(cls = 'scan-ico') {
  const [y, ye] = BRICK_COLOURS.y;
  const c = (d) => `<path d="${d}" fill="none" stroke="var(--brand)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<svg class="${cls}" viewBox="0 0 28 26" aria-hidden="true">
    ${c('M2.5 8 V3 H7.5')}${c('M20.5 3 H25.5 V8')}${c('M25.5 18 V23 H20.5')}${c('M7.5 23 H2.5 V18')}
    <rect x="11.5" y="4.6" width="5" height="2.6" rx=".8" fill="${y}" stroke="${ye}" stroke-width=".7"/>
    <rect x="8.6" y="6.8" width="10.8" height="10" rx="3.4" fill="${y}" stroke="${ye}" stroke-width=".9"/>
    <rect x="11.5" y="16.6" width="5" height="2.4" rx=".6" fill="${y}" stroke="${ye}" stroke-width=".7"/>
    <circle cx="12.2" cy="10.9" r=".95" fill="#222"/><circle cx="15.8" cy="10.9" r=".95" fill="#222"/>
    <path d="M11.8 13.4 Q14 15.2 16.2 13.4" fill="none" stroke="#222" stroke-width=".9" stroke-linecap="round"/>
    <rect class="ico-scan-line" x="4.5" y="12.4" width="19" height="1.9" rx=".95" fill="var(--brand)" stroke="#fff" stroke-width=".6"/>
  </svg>`;
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
    <button class="btn primary block hero-cta" id="startBtn">Try it with your first set</button>`}
    ${syncEnabled() ? `<p class="center small hero-login">Already have an account? <a href="#settings">Log in</a></p>` : ''}
    <h3 class="steps-title">How it works</h3>
    ${swipeCards('steps', [
      ['📖', 'Add your sets', 'Type the number from the box or manual and the full parts list appears.'],
      ['✅', 'Tick what you have', 'See exactly which pieces are still missing, in every colour.'],
      [scanIcon({ cls: 'scan-ico big' }), 'Find and scan', 'Spot a piece in the pile? Scan it to see which set needs it.'],
    ])}
    <footer class="welcome-foot small muted">
      <a href="privacy.html">Privacy Policy</a> · <a href="terms.html">Terms of Use</a>
      <p>LEGO® is a trademark of the LEGO Group, which does not sponsor or endorse this app.</p>
    </footer>`;
  bindSwipeCards('steps');
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

function priceGuideUrl(set) {
  // BrickLink numbers minifigures differently, so search by name instead.
  if (isFig(set)) return `https://www.bricklink.com/v2/search.page?q=${encodeURIComponent(set.name)}#T=M`;
  return `https://www.bricklink.com/catalogPG.asp?S=${encodeURIComponent(set.setNum)}`;
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
    <p class="muted small">${isFig(set) ? 'Find the figure on BrickLink and open its <b>Price Guide</b> tab' : 'Open the price guide'}, look at <b>Last 6 months sales → Used → Avg Price</b>, then type it in below.</p>
    <a class="btn block" href="${priceGuideUrl(set)}" target="_blank" rel="noopener">💷 See prices on BrickLink ↗</a>
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
  const icon = isFig(s) ? '🙂' : '🧱';
  return s.img
    ? `<img class="${cls}" src="${esc(s.img)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;${cls} no-pic&quot;>${icon}</span>'">`
    : `<span class="${cls} no-pic">${icon}</span>`;
}

function renderSets() {
  const figs = ui.collection === 'figs';
  setTitle(figs ? 'My minifigures' : 'My sets');
  const everything = setsInOrder();
  const all = everything.filter((s) => isFig(s) === figs);
  const figCount = everything.filter(isFig).length;
  const word = figs ? ['minifigure', 'minifigures'] : ['set', 'sets'];
  const index = swapIndex();
  let html = `
    <div class="seg collection-switch" id="collection">
      <button data-c="sets" class="${figs ? '' : 'active'}">🧱 Sets <em>${everything.length - figCount}</em></button>
      <button data-c="figs" class="${figs ? 'active' : ''}">${figIcon()} Minifigures <em>${figCount}</em></button>
    </div>
    <button class="btn primary block" id="addBtn">＋ Add a ${word[0]}</button><p></p>
    ${figs ? renderFigHints() : ''}`;
  if (!all.length) {
    html += figs
      ? `<div class="empty">${emptyFig()}<b>No minifigures yet</b><br>Tap <b>Add a minifigure</b> to scan a whole figure, or scan one of its pieces (like the legs) to work out which figure it's from.</div>`
      : `<div class="empty">${emptyBrick()}<b>No sets yet</b><br>Tap <b>Add a set</b> and enter the set number from the manual cover.</div>`;
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
          <select id="setSort" aria-label="Sort ${word[1]}">
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
      ? `Total value: <b>${money(valued.reduce((t, s) => t + s.value, 0))}</b> (${valued.length} of ${all.length} ${word[1]} valued)${ui.setSort === 'worth' ? '. Most value per missing piece first.' : ''}`
      : `Tip: add a value to each ${word[0]} (open it and tap <b>Add value</b>) to see which are worth finishing first.`}</p>`;
    if (all.length > 4) html += searchBox('setSearch', ui.setSearch, `Search ${word[1]}…`);

    const q = ui.setSearch.toLowerCase();
    const sets = all.filter((s) => {
      const { st } = info.get(s.setNum);
      if (ui.setsShow === 'todo' && !st.missing) return false;
      if (ui.setsShow === 'done' && st.missing) return false;
      return !q || s.name.toLowerCase().includes(q) || s.setNum.toLowerCase().includes(q);
    });

    if (!sets.length) {
      html += `<div class="empty">${q ? `No ${word[1]} match your search.` : ui.setsShow === 'done' ? `No complete ${word[1]} yet.` : `No ${word[1]} in progress.`}</div>`;
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
            <div class="muted small">${esc(setSub(s))}</div>
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
            <div class="muted small">${esc(setSub(s))}${hasValue(s) ? ` · ${money(s.value)}` : ''}${swaps ? ' · 🔁 ' + swaps : ''}</div>
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
            <div class="muted small">${esc(setSub(s))}${hasValue(s) ? ` · <b class="value">${money(s.value)}</b>` : ''}</div>
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
  // Minifigures can still be scanned without an account; the check happens when adding.
  $('#addBtn').onclick = () => { if (figs || accountGate(() => go('#add'))) go(figs ? '#addfig' : '#add'); };
  bindFigHints(renderSets);
  document.querySelectorAll('#collection button').forEach((b) => {
    b.onclick = () => { ui.collection = b.dataset.c; ui.setSearch = ''; savePref('collection', b.dataset.c); renderSets(); };
  });
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
    if (!accountGate(() => submit())) return;
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

/* ---------- Minifigures: sets they came in, and the Add page ---------- */

function figSetRows(fig, limit, withButtons) {
  const list = fig.inSets || [];
  if (!list.length) {
    return `<p class="muted small">Rebrickable doesn't list this figure in any set, so it was probably sold on its own (for example as a promotion, magazine gift or keyring).</p>`;
  }
  let html = list.slice(0, limit).map((x) => `
    <div class="for-set">
      <div class="row grow" style="min-width:0" ${withButtons && state.sets[x.setNum] ? `data-open-set="${esc(x.setNum)}"` : ''}>
        <div class="thumb">${x.img ? `<img src="${esc(x.img)}" alt="" loading="lazy">` : '🧱'}</div>
        <div class="grow" style="min-width:0">
          <div class="sname"><b>${esc(x.name)}</b></div>
          <div class="small muted">${esc(setSub(x))}${withButtons && state.sets[x.setNum] ? ' · <span class="yours">in your sets</span>' : ''}</div>
        </div>
      </div>
      ${!withButtons ? '' : fig.pack && fig.pack.setNum === x.setNum
        ? '<span class="badge ok">Its own packet</span>'
        : state.sets[x.setNum]
        ? `<button class="btn ok small" data-move-to="${esc(x.setNum)}">Move here</button>`
        : `<button class="btn small" data-add-move="${esc(x.setNum)}">Add &amp; move</button>`}
    </div>`).join('');
  if (list.length > limit) html += `<button class="link-btn" data-more-sets>Show all ${list.length} sets</button>`;
  return html;
}


/* ---------- Suggestions: minifigures that belong in the same set ---------- */

// Groups your loose minifigures by a set they came in: first sets you have
// (any number of figures), then sets you don't have (2 or more figures).
// Figures only sold in their own packet are left out.
function figSuggestions() {
  const figs = Object.values(state.sets).filter(isFig);
  const homes = (f) => (f.inSets || []).filter((x) => !f.pack || x.setNum !== f.pack.setNum);
  const groups = new Map();
  for (const f of figs) {
    for (const x of homes(f)) {
      if (!groups.has(x.setNum)) groups.set(x.setNum, { info: x, owned: !!(state.sets[x.setNum] && !isFig(state.sets[x.setNum])), figs: [] });
      groups.get(x.setNum).figs.push(f);
    }
  }
  const out = [];
  const used = new Set();
  for (const owned of [true, false]) {
    for (;;) {
      let best = null;
      for (const g of groups.values()) {
        if (g.owned !== owned || out.includes(g)) continue;
        const free = g.figs.filter((f) => !used.has(f.setNum));
        if (free.length >= (owned ? 1 : 2) && (!best || free.length > best.free.length)) best = { g, free };
      }
      if (!best) break;
      best.g.figs = best.free;
      best.free.forEach((f) => used.add(f.setNum));
      out.push(best.g);
    }
  }
  return out;
}

const hintSig = (g) => g.info.setNum + ':' + g.figs.map((f) => f.setNum).sort().join(',');
function hiddenHints() {
  try { return JSON.parse(loadPref('hiddenFigHints', '[]')); } catch { return []; }
}

function renderFigHints() {
  const hidden = hiddenHints();
  const list = figSuggestions().filter((g) => !hidden.includes(hintSig(g)));
  return list.map((g, i) => {
    const names = g.figs.map((f) => f.name.split(',')[0]);
    const who = names.length === 1 ? `<b>${esc(names[0])}</b> belongs` : `<b>${names.length} of your minifigures</b> belong`;
    return `
    <div class="card fig-hint ${g.owned ? 'owned' : ''}">
      <h2>${g.owned ? '🔁' : '💡'} ${g.owned
        ? `${who} in ${esc(g.info.name)}`
        : `${esc(names.slice(0, -1).join(', '))} and ${esc(names[names.length - 1])} all come from ${esc(g.info.name)}`}</h2>
      <p class="muted small">${g.owned ? `You have this set (#${esc(shortSetNum(g.info.setNum))}). Moving ${names.length === 1 ? 'it' : 'them'} ticks the found pieces in the set.` : `#${esc(shortSetNum(g.info.setNum))}${g.info.year ? ' · ' + esc(g.info.year) : ''}. Add the set and move them in? It could be a good one to rebuild next.`}</p>
      <div class="hint-figs">${g.figs.map((f) => `<div class="thumb" title="${esc(f.name)}">${setPic(f)}</div>`).join('')}${g.info.img ? `<span class="hint-arrow">→</span><div class="thumb">${`<img src="${esc(g.info.img)}" alt="" loading="lazy">`}</div>` : ''}</div>
      <div class="row">
        <button class="btn ${g.owned ? 'ok' : 'primary'} small grow" data-hint-go="${i}">${g.owned ? (names.length === 1 ? 'Move it' : `Move all ${names.length}`) : 'Add set &amp; move them'}</button>
        <button class="btn small" data-hint-hide="${i}">Not now</button>
      </div>
    </div>`;
  }).join('');
}

function bindFigHints(rerender) {
  const hidden = hiddenHints();
  const list = figSuggestions().filter((g) => !hidden.includes(hintSig(g)));
  document.querySelectorAll('[data-hint-hide]').forEach((b) => {
    b.onclick = () => {
      savePref('hiddenFigHints', JSON.stringify([...hiddenHints(), hintSig(list[Number(b.dataset.hintHide)])].slice(-50)));
      rerender();
    };
  });
  document.querySelectorAll('[data-hint-go]').forEach((b) => {
    b.onclick = () => moveFigsToSet(list[Number(b.dataset.hintGo)].figs, list[Number(b.dataset.hintGo)].info, b);
  });
}

// Moves several figures into one set (adding the set first if needed), with one Undo.
async function moveFigsToSet(figs, info, btn) {
  const owned = state.sets[info.setNum] && !isFig(state.sets[info.setNum]);
  if (!owned && !accountGate()) return;
  const names = figs.map((f) => f.name.split(',')[0]);
  if (!await askConfirm({
    title: owned ? `Move ${names.length === 1 ? names[0] : `${names.length} minifigures`} into ${info.name}?` : `Add ${info.name} and move ${names.length} minifigures into it?`,
    text: `${owned ? '' : 'The whole set is added, with its other pieces starting as missing. '}Their found pieces are ticked in the set and they come off your Minifigures list. Any pieces the set doesn't need stay with the figures.`,
    ok: owned ? 'Move' : 'Add set & move',
  })) return;
  if (btn) { btn.disabled = true; btn.textContent = owned ? 'Moving…' : 'Adding…'; }
  const before = JSON.stringify(state.sets);
  try {
    if (!owned) {
      const set = await fetchSet(info.setNum);
      state.sets[set.setNum] = set;
    }
    let spares = 0;
    for (const f of figs) if (state.sets[f.setNum]) spares += await moveFigToSet(state.sets[f.setNum], info.setNum, { ask: false, quiet: true }) || 0;
    save();
    buzz();
    lastUndo = () => { state.sets = JSON.parse(before); save(); render(); };
    toast(`🔁 Moved ${names.length === 1 ? names[0] : `${names.length} minifigures`} into ${info.name}${spares ? ` (${plural(spares, 'spare piece stays', 'spare pieces stay')} in Minifigures)` : ''}`, true);
    go('#set/' + encodeURIComponent(info.setNum));
  } catch (e) {
    toast(e.message);
    render();
  }
}

/* ---------- Minifigures in a set (set page) ---------- */

const setFigsLoading = new Set();

// Downloads (once) which minifigures are in a set and what each is made of.
async function loadSetFigs(set) {
  if (set.figs || isFig(set) || setFigsLoading.has(set.setNum) || !helperAvailable()) return;
  setFigsLoading.add(set.setNum);
  try {
    const data = await helperGet('setfigs=' + encodeURIComponent(set.setNum));
    const live = state.sets[set.setNum];
    if (!live) return;
    live.figs = (data.results || []).map((f) => ({
      figNum: f.set_num, name: f.name, qty: f.quantity || 1, img: f.set_img_url || '',
      parts: f.parts.map((x) => ({ key: x.part_num + '|' + x.color_id, qty: x.quantity })),
    }));
    save();
    const r = route();
    if (r.name === 'set' && r.arg === set.setNum) { const y = window.scrollY; renderSet(set.setNum); window.scrollTo(0, y); }
  } catch (e) {
    console.warn('Could not load minifigures for', set.setNum, e); // try again next time the set is opened
  } finally {
    setFigsLoading.delete(set.setNum);
  }
}

// Shares the set's found pieces out between its figures (in order), so each
// figure (and each copy of it) shows whether all its pieces are found.
function figProgress(set) {
  const pool = new Map(set.parts.map((p) => [p.key, p.have]));
  return (set.figs || []).map((f) => {
    const copies = [];
    for (let i = 0; i < f.qty; i++) {
      let missing = 0;
      for (const fp of f.parts) {
        const got = Math.min(fp.qty, pool.get(fp.key) || 0);
        pool.set(fp.key, (pool.get(fp.key) || 0) - got);
        missing += fp.qty - got;
      }
      copies.push(missing);
    }
    return { f, copies, done: copies.filter((m) => !m).length };
  });
}

function renderSetFigs(set) {
  if (isFig(set)) return '';
  if (!set.figs) return setFigsLoading.has(set.setNum) ? '<p class="muted small center">Loading minifigures…</p>' : '';
  if (!set.figs.length) return '';
  const prog = figProgress(set);
  if (isFigPacket(set)) {
    const { f } = prog[0];
    return `
    <div class="card acc-offer">
      <h2>🎒 This is a minifigure packet</h2>
      <p class="muted small">It's just ${esc(f.name)} with ${plural(extraPieces(set), 'accessory', 'accessories')}. You can keep it in Minifigures instead, with the accessories included and your ticks kept.</p>
      <button class="btn primary block" id="toFig">${figIcon()} Turn into a minifigure</button>
    </div>`;
  }
  const total = prog.reduce((t, x) => t + x.f.qty, 0);
  const done = prog.reduce((t, x) => t + x.done, 0);
  const loose = set.figs.map((f) => state.sets[f.figNum]).filter((f) => f && isFig(f));
  return `
    <div class="card set-figs">
      <h2>${figIcon()} Minifigures in this set <span class="muted small">${done} of ${total} complete</span></h2>
      ${loose.length ? `
      <div class="loose-figs">
        <span>🔁 You have <b>${loose.length === 1 ? esc(loose[0].name.split(',')[0]) : `${loose.length} of these`}</b> in your Minifigures.</span>
        <button class="btn ok small" id="looseIn">Move ${loose.length === 1 ? 'it' : 'them'} in</button>
      </div>` : ''}
      <div class="set-fig-grid">${prog.map(({ f, copies, done: d }, i) => `
        <button class="set-fig ${d === f.qty ? 'done' : ''}" data-setfig="${i}">
          <span class="sf-pic">${f.img ? `<img src="${esc(f.img)}" alt="" loading="lazy">` : '🙂'}${f.qty > 1 ? `<em>×${f.qty}</em>` : ''}</span>
          <span class="sf-name">${esc(f.name)}</span>
          ${d === f.qty ? '<span class="badge ok">✓ Done</span>' : `<span class="badge miss">${copies.reduce((t, m) => t + m, 0)} missing</span>`}
        </button>`).join('')}</div>
    </div>`;
}

// Pieces in a set that aren't part of its minifigures (accessories, stand…).
function extraPieces(set) {
  const figPieces = (set.figs || []).reduce((t, f) => t + f.qty * f.parts.reduce((u, p) => u + p.qty, 0), 0);
  return set.parts.reduce((t, p) => t + p.qty, 0) - figPieces;
}

// A "set" that is really one figure in its own packet (collectable series, polybag…).
const isFigPacket = (set) => !isFig(set) && set.figs && set.figs.length === 1 && set.figs[0].qty === 1 && extraPieces(set) <= 20;

async function turnIntoFig(set) {
  const f = set.figs[0];
  if (!await askConfirm({
    title: `Turn ${set.name} into a minifigure?`,
    text: `It moves to your Minifigures as ${f.name}, with its accessories included and the pieces you've found still ticked.`,
    ok: 'Turn into a minifigure',
  })) return;
  let fig;
  try {
    fig = await fetchFig(f.figNum);
  } catch (e) {
    toast(e.message);
    return;
  }
  if (!state.sets[set.setNum]) return;
  if (!fig.pack) { // make sure the packet's accessories come along
    addAccessories(fig, set.parts.filter((p) => !f.parts.some((x) => x.key === p.key)).map((p) => ({ ...p })));
    fig.pack = { setNum: set.setNum, name: set.name };
  }
  const pool = new Map(set.parts.map((p) => [p.key, p.have]));
  const existing = state.sets[fig.setNum];
  const undo = { set: structuredClone(set), fig: existing ? structuredClone(existing) : null };
  // Already have this figure? Then this becomes one more of it.
  if (existing) {
    addAccessories(fig, existing.parts.filter((p) => !fig.parts.some((x) => x.key === p.key)).map((p) => ({ ...p, per: perFig(existing, p) })));
    setFigCount(fig, (existing.count || 1) + 1);
    if (!fig.pack && existing.pack) fig.pack = existing.pack;
  }
  for (const p of fig.parts) {
    const got = Math.min(perFig(fig, p), pool.get(p.key) || 0);
    pool.set(p.key, (pool.get(p.key) || 0) - got);
    const before = existing && existing.parts.find((x) => x.key === p.key);
    p.have = Math.min(p.qty, got + (before ? before.have : 0));
  }
  fig.addedAt = existing ? existing.addedAt : Date.now();
  if (hasValue(set)) fig.value = set.value;
  delete state.sets[set.setNum];
  state.sets[fig.setNum] = fig;
  save();
  lastUndo = () => {
    state.sets[undo.set.setNum] = undo.set;
    if (undo.fig) state.sets[undo.fig.setNum] = undo.fig; else delete state.sets[fig.setNum];
    save();
    render();
  };
  ui.collection = 'figs';
  savePref('collection', 'figs');
  location.replace('#set/' + encodeURIComponent(fig.setNum));
  toast(`${fig.name} is now in your Minifigures`, true);
}

function showSetFigSheet(set, i, onChange) {
  const { f, copies } = figProgress(set)[i];
  const missingAll = copies.reduce((t, m) => t + m, 0);
  // How many of each piece is still free for this figure after the figures before it.
  const pool = new Map(set.parts.map((p) => [p.key, p.have]));
  for (const prev of set.figs.slice(0, i)) for (const fp of prev.parts) pool.set(fp.key, Math.max(0, (pool.get(fp.key) || 0) - fp.qty * prev.qty));
  openSheet(`
    <div class="fig-preview">
      <div class="big-pic">${f.img ? `<img src="${esc(f.img)}" alt="">` : emptyFig()}</div>
      <h2>${f.qty > 1 ? f.qty + '× ' : ''}${esc(f.name)}</h2>
      <p>${missingAll ? `<span class="badge miss">${plural(missingAll, 'piece', 'pieces')} still to find</span>` : '<span class="badge ok">All pieces found ✓</span>'}</p>
      <h3 class="steps-title">Pieces${f.qty > 1 ? ` (for all ${f.qty})` : ''}</h3>
      <div class="fig-parts">${f.parts.map((fp) => {
        const p = set.parts.find((x) => x.key === fp.key);
        if (!p) return '';
        const need = fp.qty * f.qty;
        const got = Math.min(need, pool.get(fp.key) || 0);
        return `
        <div class="fig-part ${got >= need ? 'scanned' : 'need'}" data-part="${esc(p.key)}">
          <div class="thumb">${partImg(p)}</div>
          <div class="grow" style="min-width:0">
            <div class="small"><b>${need > 1 ? need + '× ' : ''}${esc(p.name)}</b></div>
            <div class="small muted">${swatch(p.rgb)} ${esc(p.colorName)}</div>
            ${got >= need ? '<span class="badge ok">Found ✓</span>' : `<span class="badge miss">need ${need - got}</span>`}
          </div>
        </div>`;
      }).join('')}</div>
      <p class="muted small center">Tap a piece to record finding it.</p>
      <button class="btn block" data-close>Close</button>
    </div>`);
  document.querySelectorAll('[data-part]').forEach((el) => {
    el.onclick = () => showSetPartSheet(set.setNum, el.dataset.part, () => { onChange(); showSetFigSheet(state.sets[set.setNum], i, onChange); });
  });
}

function renderFigSets(fig) {
  const list = fig.inSets || [];
  const n = list.length;
  const done = !setStats(fig).missing;
  const real = list.filter((x) => !fig.pack || x.setNum !== fig.pack.setNum);
  const offer = accOffers.get(fig.setNum);
  const accCard = offer ? `
    <div class="card acc-offer">
      <h2>🎒 ${plural(offer.parts.length, 'accessory', 'accessories')} from its packet</h2>
      <p class="muted small">${esc(fig.name)} came in its own packet (${esc(offer.pack.name)}). Add its accessories to this figure so you can track them here too.</p>
      <div class="acc-thumbs">${offer.parts.map((p) => `<div class="thumb" title="${esc(p.name)}">${partImg(p)}</div>`).join('')}</div>
      <button class="btn primary block" id="addAcc">＋ Add accessories</button>
    </div>` : '';
  if (offer) return accCard; // sort out the packet first, then show where it can go
  if (!real.length && fig.pack) {
    return accCard + `
    <div class="card fig-sets">
      <h2>🎒 Sold in its own packet</h2>
      <p class="muted small">${esc(fig.pack.name)} (#${esc(shortSetNum(fig.pack.setNum))}). Its accessories are included in the pieces below.</p>
    </div>`;
  }
  // Sets you already have first, so "Move here" is easy to find.
  const sorted = { ...fig, inSets: [...list].sort((a, b) => !!state.sets[b.setNum] - !!state.sets[a.setNum]) };
  const yours = list.filter((x) => state.sets[x.setNum]).length;
  return accCard + `
    <div class="card fig-sets ${done && n ? 'done' : ''}">
      <h2>${!n ? '🧱 Not part of a set' : done ? '✅ Complete! Move it to its set' : `🧱 Comes in ${plural(n, 'set', 'sets')}`}</h2>
      ${fig.pack ? `<p class="muted small">🎒 Also sold in its own packet (#${esc(shortSetNum(fig.pack.setNum))}); its accessories are included below.</p>` : ''}
      ${n ? `<p class="muted small">${yours
        ? `${yours === 1 ? 'One of these is' : `${yours} of these are`} in your sets. <b>Move here</b> ticks this figure's found pieces in that set and takes it off your Minifigures list.`
        : '<b>Add &amp; move</b> adds the whole set (its other pieces start as missing) and moves this figure into it.'}</p>` : ''}
      ${figSetRows(sorted, ui.figSetsAll === fig.setNum ? 999 : 3, true)}
    </div>`;
}

// Moves a figure's found pieces into a set. Pieces the set has already found
// stay with the figure as spares; the figure is removed if nothing is left.
async function moveFigToSet(fig, setNum, { ask = true, quiet = false } = {}) {
  const set = state.sets[setNum];
  if (!set || !state.sets[fig.setNum]) return;
  const count = fig.count || 1;
  // Only one figure's worth of pieces moves; the rest stay with your other copies.
  const take = (p) => Math.min(p.have, perFig(fig, p));
  const room = (p) => { const t = set.parts.find((x) => x.key === p.key); return t ? Math.min(take(p), t.qty - t.have) : 0; };
  const found = fig.parts.reduce((t, p) => t + room(p), 0);
  const ok = !ask || await askConfirm({
    title: count > 1 ? `Move one of your ${count} ${fig.name} into ${set.name}?` : `Move ${fig.name} into ${set.name}?`,
    text: count > 1
      ? `${found ? `${plural(found, 'found piece', 'found pieces')} will be ticked in ${set.name} (#${shortSetNum(setNum)})` : 'No pieces are found for it yet'}, and you'll have ${count - 1} left in Minifigures.`
      : found
      ? `Its ${plural(found, 'found piece', 'found pieces')} will be ticked in ${set.name} (#${shortSetNum(setNum)}) and it will come off your Minifigures list.`
      : `It has no pieces found yet, so it will just come off your Minifigures list (its pieces are already in ${set.name}'s list).`,
    ok: 'Move',
  });
  if (!ok || !state.sets[fig.setNum] || !state.sets[setNum]) return;
  const before = { fig: structuredClone(fig), set: set.parts.map((p) => p.have) };
  const spares = [];
  for (const p of fig.parts) {
    const t = take(p);
    if (!t) continue;
    const target = set.parts.find((x) => x.key === p.key);
    const moved = target ? Math.min(t, target.qty - target.have) : 0;
    if (target) target.have += moved;
    p.have -= moved;
    if (t - moved) spares.push({ p, n: t - moved, why: target ? 'found' : 'notneeded' });
  }
  if (count > 1) {
    // One fewer figure, unless pieces that couldn't move need its space as spares.
    if (fig.parts.every((p) => p.have <= perFig(fig, p) * (count - 1))) setFigCount(fig, count - 1);
  } else if (!spares.length) delete state.sets[fig.setNum];
  if (quiet) return spares.reduce((t, x) => t + x.n, 0);
  save();
  buzz();
  lastUndo = () => {
    state.sets[fig.setNum] = before.fig;
    set.parts.forEach((p, i) => { p.have = before.set[i]; });
    save();
    render();
  };
  if (spares.length || count > 1) {
    const n = spares.reduce((t, x) => t + x.n, 0);
    if (!n) { toast(`🔁 Moved one ${fig.name} into ${set.name}`, true); render(); return; }
    const names = spares.map((x) => x.p.name).slice(0, 2).join(', ');
    const why = spares.every((x) => x.why === 'notneeded') ? "isn't in that set" : spares.every((x) => x.why === 'found') ? 'was already found there' : "wasn't needed there";
    toast(`Moved to ${set.name}. ${n === 1 ? `1 piece (${names}) ${why}` : `${n} pieces (${names}${spares.length > 2 ? '…' : ''}) ${why.replace('was', 'were').replace("isn't", "aren't").replace("wasn't", "weren't")}`}, so ${n === 1 ? 'it stays' : 'they stay'} with your figure.`, true);
    render();
  } else {
    toast(`🔁 Moved ${fig.name} into ${set.name}`, true);
    location.replace('#set/' + encodeURIComponent(setNum));
  }
}

// Figures added before accessories existed: look once for their packet's accessories.
const accOffers = new Map();
const accChecking = new Set();
async function checkFigAccessories(fig) {
  if (fig.accChecked || accChecking.has(fig.setNum) || !helperAvailable()) return;
  accChecking.add(fig.setNum);
  try {
    const fresh = await fetchFig(fig.setNum, { refresh: true });
    const live = state.sets[fig.setNum];
    if (!live) return;
    const extras = fresh.parts.filter((p) => p.acc && !live.parts.some((x) => x.key === p.key));
    if (fresh.pack && extras.length) accOffers.set(fig.setNum, { pack: fresh.pack, parts: extras });
    else { live.accChecked = true; save(); }
    const r = route();
    if (r.name === 'set' && r.arg === fig.setNum) { const y = window.scrollY; renderSet(fig.setNum); window.scrollTo(0, y); }
  } catch (e) {
    console.warn('Could not check accessories for', fig.setNum, e);
  } finally {
    accChecking.delete(fig.setNum);
  }
}

function bindFigSets(fig) {
  if (!isFig(fig)) return;
  checkFigAccessories(fig);
  const addAcc = $('#addAcc');
  if (addAcc) {
    addAcc.onclick = () => {
      const offer = accOffers.get(fig.setNum);
      addAccessories(fig, offer.parts);
      fig.pack = offer.pack;
      fig.accChecked = true;
      accOffers.delete(fig.setNum);
      save();
      renderSet(fig.setNum);
      toast(`Added ${plural(offer.parts.length, 'accessory', 'accessories')}`);
    };
  }
  document.querySelectorAll('[data-open-set]').forEach((b) => { b.onclick = () => go('#set/' + encodeURIComponent(b.dataset.openSet)); });
  const more = $('[data-more-sets]');
  if (more) more.onclick = () => { ui.figSetsAll = fig.setNum; renderSet(fig.setNum); };
  document.querySelectorAll('[data-move-to]').forEach((b) => { b.onclick = () => moveFigToSet(fig, b.dataset.moveTo); });
  document.querySelectorAll('[data-add-move]').forEach((b) => {
    b.onclick = async () => {
      if (!accountGate()) return;
      const num = b.dataset.addMove;
      const info = fig.inSets.find((x) => x.setNum === num);
      if (!await askConfirm({
        title: `Add ${info ? info.name : 'this set'} and move ${fig.name} into it?`,
        text: 'This adds the whole set to your sets, with all its pieces starting as missing, then ticks off this figure\'s found pieces in it.',
        ok: 'Add set & move',
      })) return;
      b.disabled = true;
      b.textContent = 'Adding…';
      try {
        if (!state.sets[num]) {
          const set = await fetchSet(num);
          state.sets[set.setNum] = set;
          save();
        }
        await moveFigToSet(fig, num, { ask: false });
      } catch (e) {
        toast(e.message);
        if (route().arg === fig.setNum) renderSet(fig.setNum);
      }
    };
  });
}

function figTiles(list) {
  return `<div class="set-grid fig-grid">${list.map((f) => `
    <div class="set-tile" data-fig="${esc(f.set_num)}">
      <div class="tile-pic">
        ${f.set_img_url ? `<img src="${esc(f.set_img_url)}" alt="" loading="lazy">` : `<span class="no-pic">🙂</span>`}
        ${state.sets[f.set_num] ? '<span class="tile-tag ok">Yours ✓</span>' : ''}
      </div>
      <div class="tile-body">
        <div class="tile-name">${esc(f.name)}</div>
        <div class="muted small">#${esc(f.set_num)}${f.num_parts ? ` · ${plural(f.num_parts, 'piece', 'pieces')}` : ''}</div>
      </div>
    </div>`).join('')}</div>`;
}

const FIG_SHOW_MAX = 40;

// Top of the Add a minifigure page: the drawing until you take a photo, then
// your photo (with a scanning line while it's being looked at), as on the Scan page.
function renderFigTop() {
  const a = figAdd;
  if (!a.photoUrl) {
    return `
    <section class="hero fig-hero">
      ${emptyFig('fig-art')}
      <h2 class="hero-title">Got a minifigure?<br><span class="accent">Find out who it is.</span></h2>
      <p class="hero-sub">Scan the whole figure, or just one piece (like the legs), to see which figures it could belong to.</p>
    </section>`;
  }
  return `
    <div class="scan-shot ${a.loading ? 'scanning' : ''}">
      <img src="${esc(a.photoUrl)}" alt="Your photo">
      <span class="vf tl"></span><span class="vf tr"></span><span class="vf br"></span><span class="vf bl"></span>
      ${a.loading ? '<span class="shot-line"></span>' : ''}
    </div>`;
}

function renderFigOut() {
  const a = figAdd;
  let h = '';
  if (a.loading) return h + `<p class="center scan-status">${esc(a.loading)}</p>`;
  if (a.error) {
    return h + `<div class="verdict-card no"><span class="verdict-ico">${a.errorIcon || '⚠️'}</span><div><b>${esc(a.errorTitle || 'Something went wrong')}</b><span>${esc(a.error)}</span></div></div>`;
  }
  if (a.step === 'guesses') {
    const what = a.scanKind === 'fig' ? 'figure' : 'piece';
    h += `<h3 class="steps-title">Which ${what} is it?</h3><p class="muted small">Tap the one that looks like yours.</p>`;
    h += a.guesses.map((g, i) => `
      <button class="match-card guess" data-guess="${i}">
        <div class="match-head">
          <div class="match-pic">${g.img_url ? `<img src="${esc(g.img_url)}" alt="">` : '<span class="no-pic">🧱</span>'}</div>
          <div class="grow">
            <span class="match-chip">${i === 0 ? 'Best guess' : 'Could also be'} · ${Math.round((g.score || 0) * 100)}% sure</span>
            <div class="match-name">${esc(g.name)}</div>
            <div class="small muted">#${esc(g.id)}</div>
          </div>
          <span class="chev">›</span>
        </div>
      </button>`).join('');
  }
  if (a.step === 'colours') {
    h += `<div class="picked-part"><div class="thumb">${a.part.img ? `<img src="${esc(a.part.img)}" alt="">` : '🧱'}</div><div><b>${esc(a.part.name)}</b><div class="small muted">#${esc(a.part.num)}</div></div></div>`;
    h += `<h3 class="steps-title">What colour is yours?</h3><p class="muted small">The scanner works out the shape, but not always the colour.</p>`;
    h += `<div class="colour-pick">${a.colours.map((c) => `
      <button class="colour-opt" data-colour="${esc(c.id)}">
        ${c.img ? `<img src="${esc(c.img)}" alt="" loading="lazy">` : '<span class="no-pic">🧱</span>'}
        <span>${swatch(c.rgb)} ${esc(c.name)}</span>
        ${c.figs ? `<em class="muted small">${plural(c.figs, 'figure', 'figures')}</em>` : ''}
      </button>`).join('')}</div>`;
    h += `<button class="link-btn" data-back="guesses">‹ Pick a different piece</button>`;
  }
  if (a.step === 'legcolours' || a.step === 'hips') {
    const legs = a.step === 'hips';
    h += `<div class="picked-part"><div class="thumb">${a.part.img ? `<img src="${esc(a.part.img)}" alt="">` : '🧱'}</div><div><b>${esc(legs ? a.legsColour + ' legs' : 'Minifigure legs')}</b><div class="small muted">${legs ? 'Now the hips (the top part)' : 'Hips and legs'}</div></div></div>`;
    h += `<h3 class="steps-title">${legs ? 'What colour are the hips?' : 'What colour are the legs?'}</h3>`;
    h += `<p class="muted small">${legs ? 'If the legs have a pattern printed on them, pick a “printed” option.' : 'The scanner works out the shape, but not always the colour.'}</p>`;
    h += `<div class="colour-pick">${(legs ? a.hipOptions : a.legOptions).map((o, i) => `
      <button class="colour-opt" data-legopt="${i}">
        ${o.img ? `<img src="${esc(o.img)}" alt="" loading="lazy">` : '<span class="no-pic">🧱</span>'}
        <span>${swatch(o.rgb)} ${esc(o.label)}</span>
        <em class="muted small">${plural(o.figs, 'figure', 'figures')}</em>
      </button>`).join('')}</div>`;
    h += `<button class="link-btn" data-back="${legs ? 'legcolours' : 'guesses'}">‹ ${legs ? 'Pick a different legs colour' : 'Pick a different piece'}</button>`;
  }
  if (a.step === 'results') {
    const q = (a.filter || '').toLowerCase();
    const list = q ? a.results.filter((f) => f.name.toLowerCase().includes(q) || f.set_num.includes(q)) : a.results;
    h += `<h3 class="steps-title">${esc(a.resultsTitle)}</h3>`;
    if (a.resultsHint) h += `<div class="verdict-card ${a.results.length > 12 ? 'no' : 'yes'}"><span class="verdict-ico">${a.results.length > 12 ? '💡' : '✅'}</span><div><b>${esc(a.resultsHint[0])}</b><span>${esc(a.resultsHint[1])}</span></div></div>`;
    if (a.results.length > 12) h += `<input class="field" id="figFilter" type="search" placeholder="Narrow down by name, e.g. knight" value="${esc(a.filter || '')}" autocomplete="off">`;
    h += list.length ? figTiles(list.slice(0, FIG_SHOW_MAX)) : `<div class="empty">No figures match “${esc(a.filter)}”.</div>`;
    if (list.length > FIG_SHOW_MAX) h += `<p class="center muted small">Showing ${FIG_SHOW_MAX} of ${list.length}. Type above to narrow it down.</p>`;
    if (a.back) h += `<button class="link-btn" data-back="${esc(a.back)}">‹ ${a.back === 'colours' || a.back === 'hips' || a.back === 'legcolours' ? 'Pick a different colour' : 'Pick a different match'}</button>`;
  }
  return h;
}

// Just the hips and legs of a minifigure (red hips, blue legs), for the legs tip.
function figLegsIcon(cls = 'step-svg') {
  const [b, be] = BRICK_COLOURS.b, [r, re] = BRICK_COLOURS.r;
  return `<svg class="${cls}" viewBox="0 0 40 46" aria-hidden="true">
    <rect x="6" y="4" width="28" height="7" rx="1.5" fill="${r}" stroke="${re}" stroke-width="1.6"/>
    <rect x="6.5" y="10" width="13" height="31" rx="2" fill="${b}" stroke="${be}" stroke-width="1.6"/>
    <rect x="20.5" y="10" width="13" height="31" rx="2" fill="${b}" stroke="${be}" stroke-width="1.6"/>
    <rect x="9" y="6" width="22" height="2" rx="1" fill="#fff" opacity=".3"/>
  </svg>`;
}

// A minifigure torso with arms, hands and a printed design, for the torso tip.
function figTorsoIcon(cls = 'step-svg') {
  const [r, re] = BRICK_COLOURS.r, [y, ye] = BRICK_COLOURS.y;
  return `<svg class="${cls}" viewBox="0 0 48 46" aria-hidden="true">
    <rect x="19" y="3" width="10" height="5" rx="1" fill="${y}" stroke="${ye}" stroke-width="1.4"/>
    <rect x="4" y="9" width="8" height="22" rx="4" transform="rotate(14 8 20)" fill="${r}" stroke="${re}" stroke-width="1.5"/>
    <rect x="36" y="9" width="8" height="22" rx="4" transform="rotate(-14 40 20)" fill="${r}" stroke="${re}" stroke-width="1.5"/>
    <circle cx="6.5" cy="33" r="4" fill="${y}" stroke="${ye}" stroke-width="1.4"/><circle cx="41.5" cy="33" r="4" fill="${y}" stroke="${ye}" stroke-width="1.4"/>
    <path d="M14 7.5 H34 L37 40 H11 Z" fill="${r}" stroke="${re}" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="M24 13 L31 21 L24 32 L17 21 Z" fill="#f6c31b" stroke="#c99a06" stroke-width="1.2"/>
    <circle cx="24" cy="22" r="2.6" fill="#fff"/>
    <rect x="16" y="10" width="16" height="2" rx="1" fill="#fff" opacity=".3"/>
  </svg>`;
}

const FIG_TIPS = [
  [figTorsoIcon(), 'Printed torsos work best', 'A torso with a design usually points to just one or two figures.'],
  [emptyFig('step-svg'), 'Whole figure? Face the front', 'Stand it up on white paper, with its face and torso showing.'],
  [figLegsIcon(), 'Legs: two colours', "Pick the legs colour, then the hips (the top part). Plain legs are in hundreds of figures, so you'll narrow it down next."],
  ['🔎', 'Lots of matches?', 'Type part of a name, like “knight” or “police”, to narrow the list.'],
  ['💡', 'Good light', 'Daylight is best, on a plain background with no strong shadows.'],
];

function renderAddFig() {
  setTitle('Add a minifigure');
  $('#view').innerHTML = `
    <div id="figTop">${renderFigTop()}</div>
    <div id="figOut">${renderFigOut()}</div>
    <h3 class="steps-title ${figAdd.photoUrl ? '' : 'hidden'}" id="scanAgainTitle">Scan something else</h3>
    <div class="scan-opts">
      <button class="scan-opt" id="scanFig"><span class="opt-ico">${scanFigIcon()}</span><b>Scan whole figure</b><span>Stand it up on plain paper</span></button>
      <button class="scan-opt" id="scanPiece"><span class="opt-ico">${scanHeadIcon()}</span><b>Scan one piece</b><span>Legs, torso, head…</span></button>
    </div>
    <h3 class="steps-title">Tips for a good match</h3>
    ${swipeCards('figTips', FIG_TIPS)}`;
  bindAddFig();
  bindSwipeCards('figTips');
}

function refreshFigOut({ scroll = false } = {}) {
  if (route().name !== 'addfig') return;
  $('#figTop').innerHTML = renderFigTop();
  $('#figOut').innerHTML = renderFigOut();
  $('#scanAgainTitle').classList.toggle('hidden', !figAdd.photoUrl);
  bindAddFig();
  if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function figStep(loadingText, work) {
  Object.assign(figAdd, { loading: loadingText, error: '', errorTitle: '', errorIcon: '' });
  refreshFigOut({ scroll: true });
  try {
    await work();
  } catch (e) {
    figAdd.error = e instanceof TypeError ? 'No connection. Check your internet and try again.' : e.message;
  }
  figAdd.loading = '';
  refreshFigOut();
}

function noFigs(title, text) {
  Object.assign(figAdd, { error: text, errorTitle: title, errorIcon: '🤔' });
}

function bindAddFig() {
  if ($('#scanFig')) $('#scanFig').onclick = () => { figAdd.scanKind = 'fig'; $('#figCameraInput').click(); };
  if ($('#scanPiece')) $('#scanPiece').onclick = () => { figAdd.scanKind = 'piece'; $('#figCameraInput').click(); };

  document.querySelectorAll('[data-guess]').forEach((b) => {
    b.onclick = () => {
      const g = figAdd.guesses[Number(b.dataset.guess)];
      if (figAdd.scanKind === 'fig') {
        figStep('Finding this figure…', async () => {
          const data = await helperGet(`figfind=${encodeURIComponent(g.id)}&name=${encodeURIComponent(g.name)}`);
          if (!data.results.length) return noFigs("Couldn't find that figure", 'Try another match, or search by name above.');
          if (data.results.length === 1) { figAdd.step = 'guesses'; showFigPreview(data.results[0].set_num, data.results[0].set_img_url || g.img_url); return; }
          Object.assign(figAdd, { step: 'results', results: data.results, resultsTitle: 'Which one is yours?', resultsHint: null, back: 'guesses', filter: '' });
        });
        return;
      }
      figStep('Looking up this piece…', async () => {
        if (isLegs(g) && await startLegs(g)) return;
        // Try the scanner's part number first, then Rebrickable's number for it.
        let num = g.id;
        let entry = await figIndexPart(num);
        const lookupUp = entry !== undefined; // false until the weekly lookup has been published
        let helper = null;
        if (!entry) {
          try {
            helper = await helperGet('partfigs=' + encodeURIComponent(g.id));
            num = helper.part.part_num;
            if (lookupUp) entry = await figIndexPart(num);
          } catch (e) {
            if (e.status !== 404) throw e;
          }
        }
        if (entry) {
          const names = (await figIndexFile('colors.json')) || {};
          Object.assign(figAdd, {
            entry,
            part: { num, name: entry.n || g.name, img: g.img_url },
            colours: Object.entries(entry.c).map(([id, v]) => ({
              id: Number(id), name: (names[id] || [])[0] || 'Colour ' + id, rgb: (names[id] || [])[1] || 'cccccc',
              img: v.i ? RB_MEDIA + v.i : g.img_url, figs: v.f.length,
            })).sort((a, b) => b.figs - a.figs),
          });
        } else if (!lookupUp && helper && helper.colors && helper.colors.length) {
          Object.assign(figAdd, { entry: null, part: { num, name: helper.part.name, img: helper.part.part_img_url || g.img_url }, colours: helper.colors });
        } else {
          return noFigs("This piece isn't part of any minifigure", 'Check the match is right (tap Scan one piece to try again), or scan another piece. A printed torso works best.');
        }
        figAdd.step = 'colours';
        if (figAdd.colours.length === 1) await pickColour(figAdd.colours[0].id);
      });
    };
  });
  document.querySelectorAll('[data-legopt]').forEach((b) => {
    b.onclick = () => {
      const o = (figAdd.step === 'hips' ? figAdd.hipOptions : figAdd.legOptions)[Number(b.dataset.legopt)];
      if (figAdd.step === 'legcolours') figStep('Finding these legs…', () => pickLegsColour(o.key));
      else { pickHips(o); refreshFigOut({ scroll: true }); }
    };
  });
  document.querySelectorAll('[data-colour]').forEach((b) => {
    b.onclick = () => figStep('Finding minifigures with this piece…', () => pickColour(b.dataset.colour));
  });
  document.querySelectorAll('[data-back]').forEach((b) => {
    b.onclick = () => { Object.assign(figAdd, { step: b.dataset.back, error: '', filter: '' }); refreshFigOut(); };
  });
  const filter = $('#figFilter');
  if (filter) {
    filter.oninput = () => {
      figAdd.filter = filter.value;
      const pos = filter.selectionStart;
      refreshFigOut();
      const again = $('#figFilter');
      again.focus();
      again.setSelectionRange(pos, pos);
    };
  }
  document.querySelectorAll('[data-fig]').forEach((el) => { el.onclick = () => showFigPreview(el.dataset.fig, el.querySelector('img')?.getAttribute('src') || ''); });
}

/* Legs: scanners call plain legs 970c00 in any colour, but Rebrickable numbers
 * them by leg colour with the hips as the piece colour, so legs use their own
 * list (legs.json): legs colour → hips colour → plain or printed → figures. */
const isLegs = (g) => /^(970c|970x|73200)/i.test(g.id) || (/\bhips\b/i.test(g.name) && /\blegs\b/i.test(g.name));

async function colourByName() {
  const names = (await figIndexFile('colors.json')) || {};
  const out = {};
  for (const [id, [name, rgb]] of Object.entries(names)) out[name] = { id: Number(id), rgb };
  return { byName: out, names };
}

async function startLegs(g) {
  const legs = await figIndexFile('legs.json');
  if (!legs) return false;
  const { byName } = await colourByName();
  figAdd.legsData = legs;
  figAdd.part = { num: g.id, name: 'Hips and Legs', img: g.img_url };
  figAdd.legOptions = Object.entries(legs).map(([name, byHips]) => {
    const all = Object.values(byHips);
    const best = byHips[byName[name]?.id] || all[0];
    return {
      key: name, label: name, rgb: byName[name]?.rgb || 'cccccc', img: best && best.i ? RB_MEDIA + best.i : '',
      figs: all.reduce((t, e) => t + e.plain.length + e.printed.length, 0),
    };
  }).sort((a, b) => b.figs - a.figs);
  figAdd.step = 'legcolours';
  return true;
}

async function pickLegsColour(name) {
  const { byName, names } = await colourByName();
  const byHips = figAdd.legsData[name] || {};
  const same = byName[name]?.id;
  const opts = [];
  for (const [hips, e] of Object.entries(byHips)) {
    const hipsName = (names[hips] || [])[0] || 'Colour ' + hips;
    for (const kind of ['plain', 'printed']) {
      if (!e[kind].length) continue;
      opts.push({
        key: hips + '|' + kind, hips: Number(hips), kind, rgb: (names[hips] || [])[1] || 'cccccc',
        label: `${hipsName} hips${kind === 'printed' ? ', printed legs' : ''}`, img: e.i ? RB_MEDIA + e.i : '', figs: e[kind].length,
      });
    }
  }
  // Same-colour plain legs first (the usual kind), then the most common.
  opts.sort((a, b) => ((b.hips === same && b.kind === 'plain') - (a.hips === same && a.kind === 'plain')) || b.figs - a.figs);
  Object.assign(figAdd, { legsColour: name, hipOptions: opts, step: 'hips' });
  if (opts.length === 1) pickHips(opts[0]);
}

function pickHips(o) {
  const list = figAdd.legsData[figAdd.legsColour][o.hips][o.kind];
  const hipsName = o.label.replace(/ hips.*$/, '');
  const n = list.length;
  Object.assign(figAdd, {
    step: 'results', filter: '', back: figAdd.hipOptions.length > 1 ? 'hips' : 'legcolours',
    scanned: { legs: figAdd.legsColour, hips: o.hips },
    results: list.map(([num, name, img, parts]) => ({ set_num: num, name, set_img_url: img ? RB_MEDIA + img : '', num_parts: parts })),
    resultsTitle: `${figAdd.legsColour} legs, ${hipsName} hips${o.kind === 'printed' ? ' (printed)' : ''}: in ${plural(n, 'minifigure', 'minifigures')}`,
    resultsHint: n > 12
      ? ['Lots of figures have these legs', 'Type a name below to narrow it down, or scan the torso — printed torsos usually point to just one or two figures.']
      : ['Tap a figure to see the rest of its pieces', 'and which sets it came in.'],
  });
}

async function pickColour(colourId) {
  const hit = figAdd.entry && figAdd.entry.c[colourId];
  const data = hit
    ? {
      part: { part_num: figAdd.part.num, name: figAdd.part.name },
      results: hit.f.map(([num, name, img, n]) => ({ set_num: num, name, set_img_url: img ? RB_MEDIA + img : '', num_parts: n })),
    }
    : await helperGet(`partfigs=${encodeURIComponent(figAdd.part.num)}&color=${encodeURIComponent(colourId)}`);
  const colour = figAdd.colours.find((c) => String(c.id) === String(colourId)) || data.color || {};
  figAdd.scanned = { partNum: data.part.part_num, colorId: Number(colourId) };
  const n = data.results.length;
  if (!n) return noFigs('No minifigures found', `Rebrickable doesn't list any figures with this piece in ${colour.name || 'that colour'}. Try another colour, or scan the whole figure.`);
  Object.assign(figAdd, {
    step: 'results', results: data.results, filter: '', back: figAdd.colours.length > 1 ? 'colours' : 'guesses',
    resultsTitle: `${colour.name} ${data.part.name}: in ${plural(n, 'minifigure', 'minifigures')}`,
    resultsHint: n > 12
      ? ['Lots of figures use this piece', 'Type a name below to narrow it down, or scan the torso — printed torsos usually point to just one or two figures.']
      : ['Tap a figure to see the rest of its pieces', 'and which sets it came in.'],
  });
}

// Details of one figure before adding it: its pieces and the sets it came in.
async function showFigPreview(figNum, picture = '') {
  openSheet(`<button class="sheet-x" data-close aria-label="Close">✕</button><div class="spinner"></div><p class="center muted">Loading minifigure…</p>`);
  let fig;
  try {
    fig = await fetchFig(figNum);
  } catch (e) {
    openSheet(`<h2>Couldn't load this figure</h2><p class="muted">${esc(e.message)}</p><button class="btn block" data-close>Close</button>`);
    return;
  }
  if ($('#sheet').classList.contains('hidden')) return; // closed while loading
  if (!fig.img && picture) fig.img = picture; // Rebrickable's photo of the figure
  const owned = state.sets[fig.setNum];
  const sc = figAdd.scanned;
  const legsRe = sc && sc.legs ? new RegExp('^Hips and ' + sc.legs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' Legs\\b') : null;
  const scanned = sc && fig.parts.find((p) => (legsRe ? legsRe.test(p.name) && p.colorId === sc.hips : p.partNum === sc.partNum && p.colorId === sc.colorId));
  const pieces = fig.parts.reduce((t, p) => t + p.qty, 0);
  openSheet(`
    <div class="fig-preview">
      <button class="sheet-x" data-close aria-label="Close">✕</button>
      <div class="big-pic">${fig.img ? `<img src="${esc(fig.img)}" alt="">` : emptyFig()}</div>
      <h2>${esc(fig.name)}</h2>
      <div class="muted small">#${esc(fig.setNum)} · ${plural(pieces, 'piece', 'pieces')}</div>
      <h3 class="steps-title">What it's made of</h3>
      ${fig.pack ? `<p class="muted small">🎒 Includes the accessories from its packet (${esc(fig.pack.name)}).</p>` : ''}
      <div class="fig-parts">${[...fig.parts].sort((a, b) => !!a.acc - !!b.acc).map((p) => `
        <div class="fig-part ${p === scanned ? 'scanned' : ''}">
          <div class="thumb">${partImg(p)}</div>
          <div class="grow" style="min-width:0">
            <div class="small"><b>${p.qty > 1 ? p.qty + '× ' : ''}${esc(p.name)}</b></div>
            <div class="small muted">${swatch(p.rgb)} ${esc(p.colorName)}${p.acc ? ' <span class="acc-tag">accessory</span>' : ''}</div>
            ${p === scanned ? '<span class="badge ok">Your piece ✓</span>' : ''}
          </div>
        </div>`).join('')}</div>
      <h3 class="steps-title">${fig.inSets.length ? `Comes in ${plural(fig.inSets.length, 'set', 'sets')}` : 'Not part of a set'}</h3>
      ${figSetRows(fig, 3, false)}
      <p></p>
      ${owned
        ? `<p class="muted small center">You have ${owned.count || 1} already.</p>
           <button class="btn primary block" id="figAnother">＋ Add another</button>
           <p></p><button class="btn block" id="figOpen">Open in my minifigures</button>`
        : `<button class="btn primary block" id="figAddBtn">＋ Add to my minifigures</button>
           <p class="muted small center">${scanned ? 'The piece you scanned is ticked as found; the rest go on your Looking for list.' : 'Its pieces start as missing, so they show on your Looking for list.'}</p>`}
      <button class="btn block" data-close>Close</button>
    </div>`);
  const open = () => { ui.collection = 'figs'; savePref('collection', 'figs'); ui.setFilter = 'missing'; go('#set/' + encodeURIComponent(fig.setNum)); };
  if ($('#figOpen')) $('#figOpen').onclick = open;
  if ($('#figAnother')) {
    $('#figAnother').onclick = () => {
      if (!accountGate(() => showFigPreview(figNum, picture))) return;
      const mine = state.sets[fig.setNum];
      setFigCount(mine, (mine.count || 1) + 1);
      const sp = scanned && mine.parts.find((p) => p.key === scanned.key);
      if (sp) sp.have = Math.min(sp.qty, sp.have + 1);
      save();
      open();
      toast(`You now have ${mine.count} ${fig.name}`);
    };
  }
  if ($('#figAddBtn')) {
    $('#figAddBtn').onclick = () => {
      if (!accountGate(() => showFigPreview(figNum, picture))) return;
      fig.addedAt = Date.now();
      if (scanned) scanned.have = Math.min(scanned.qty, 1);
      state.sets[fig.setNum] = fig;
      save();
      open();
      toast(`Added ${fig.name}`);
    };
  }
}

$('#figCameraInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (figAdd.photoUrl) URL.revokeObjectURL(figAdd.photoUrl);
  const kind = figAdd.scanKind;
  Object.assign(figAdd, { photoUrl: URL.createObjectURL(file), step: '', scanned: null, filter: '', back: '', entry: undefined, colours: null });
  if (route().name !== 'addfig') go('#addfig');
  figStep(kind === 'fig' ? 'Working out which figure this is…' : 'Working out which piece this is…', async () => {
    const found = await identifyPiece(file, kind === 'fig' ? BRICKOGNIZE_FIGS : BRICKOGNIZE_API);
    await zoomPhoto(figAdd, found.box);
    const items = found.items.slice(0, 4);
    if (!items.length) return noFigs(`Couldn't recognise that ${kind === 'fig' ? 'figure' : 'piece'}`, 'Try again closer up, on a plain background, or search by name.');
    Object.assign(figAdd, { step: 'guesses', guesses: items });
  });
});

const PART_SORTS = [
  ['colour', 'Colour'],
  ['type', 'Type of piece'],
  ['missing', 'Most missing first'],
  ['partnum', 'Part number'],
];
const PART_VIEWS = [['grid', '▦', 'Grid'], ['list', '☰', 'List'], ['check', '≡', 'Compact']];
// Enlarged view of one piece in a set, with − / + to record how many you've found.
function showSetPartSheet(setNum, key, onChange) {
  const set = state.sets[setNum];
  const p = set && set.parts.find((x) => x.key === key);
  if (!p) return;
  const draw = () => {
    const missing = p.qty - p.have;
    openSheet(`
      <div class="piece-sheet">
        <div class="big-pic ${missing ? 'missing' : ''}">${partImg(p)}</div>
        <h2>${esc(p.name)}</h2>
        <div class="meta muted">${swatch(p.rgb)} ${esc(p.colorName)} · part #${esc(p.partNum)}</div>
        <p>${missing ? `<span class="badge miss">need ${missing} more</span>` : '<span class="badge ok">Got them all ✓</span>'}</p>
        <div class="counter big">
          <button data-step="-1" aria-label="One less">−</button>
          <span class="count">${p.have}<span class="of"> / ${p.qty} found</span></span>
          <button data-step="1" aria-label="One more">+</button>
        </div>
        <p class="small"><a href="https://rebrickable.com/parts/${encodeURIComponent(p.partNum)}/" target="_blank" rel="noopener">More pictures on Rebrickable ↗</a></p>
        <button class="btn block" data-close>Done</button>
      </div>`);
    document.querySelectorAll('[data-step]').forEach((b) => {
      b.onclick = () => { changeHave(setNum, key, Number(b.dataset.step)); draw(); };
    });
    // Closing (Done or tapping outside) refreshes the page behind with the new counts.
    const sheet = $('#sheet');
    sheet.onclick = (e) => {
      if (e.target === sheet || e.target.closest('[data-close]')) { closeSheet(); onChange(); }
    };
  };
  draw();
}

const PART_VIEW_HINTS = {
  grid: 'Use − and + to record how many you\'ve found. Tap a picture to see it bigger.',
  list: 'Use − and + to record how many you\'ve found. Tap a picture to see it bigger.',
  check: 'Use − and + to record how many you\'ve found. Tap a piece to see it bigger.',
};

// Groups pieces for the chosen sort: headings by colour or type, otherwise one list.
function groupParts(parts) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (ui.partSort === 'colour' || ui.partSort === 'type') {
    const groups = new Map();
    for (const p of parts) {
      const k = ui.partSort === 'colour' ? p.colorName : pieceType(p);
      if (!groups.has(k)) groups.set(k, { title: k, rgb: ui.partSort === 'colour' ? p.rgb : '', items: [] });
      groups.get(k).items.push(p);
    }
    const order = ui.partSort === 'type'
      ? (a, b) => PIECE_TYPES.indexOf(a.title) - PIECE_TYPES.indexOf(b.title)
      : (a, b) => a.title.localeCompare(b.title);
    return [...groups.values()].sort(order).map((g) => ({ ...g, items: g.items.sort(ui.partSort === 'type' ? (a, b) => a.colorName.localeCompare(b.colorName) || byName(a, b) : byName) }));
  }
  const items = [...parts];
  if (ui.partSort === 'missing') items.sort((a, b) => (b.qty - b.have) - (a.qty - a.have) || a.colorName.localeCompare(b.colorName) || byName(a, b));
  else items.sort((a, b) => a.partNum.localeCompare(b.partNum, undefined, { numeric: true }) || a.colorName.localeCompare(b.colorName));
  return [{ title: '', items }];
}

function renderPartItems(items) {
  if (ui.partView === 'list') {
    return `<div class="part-list">${items.map((p) => {
      const missing = p.qty - p.have;
      return `
      <div class="pitem prow ${missing ? 'missing' : 'done'}" data-key="${esc(p.key)}">
        <div class="prow-pic" data-act="view">${partImg(p)}</div>
        <div class="grow">
          <div class="pname">${esc(p.name)}</div>
          <div class="meta">${swatch(p.rgb)} ${esc(p.colorName)} · ${esc(p.partNum)}${p.acc ? ' <span class="acc-tag">accessory</span>' : ''}</div>
          ${missing ? `<span class="badge miss">need ${missing}</span>` : '<span class="badge ok">Got them ✓</span>'}
        </div>
        <div class="counter vertical">
          <button data-act="plus" aria-label="One more">+</button>
          <span class="count">${p.have}<span class="of">/${p.qty}</span></span>
          <button data-act="minus" aria-label="One less">−</button>
        </div>
      </div>`;
    }).join('')}</div>`;
  }
  if (ui.partView === 'check') {
    return `<div class="part-list">${items.map((p) => {
      const done = p.have >= p.qty;
      return `
      <div class="pitem crow ${done ? 'done' : 'missing'}" data-key="${esc(p.key)}">
        <div class="crow-pic" data-act="view">${partImg(p)}</div>
        <div class="grow" data-act="view">
          <div class="crow-name">${esc(p.name)}</div>
          <div class="meta">${swatch(p.rgb)} ${esc(p.colorName)} · ${esc(p.partNum)}${p.acc ? ' <span class="acc-tag">accessory</span>' : ''}</div>
        </div>
        <div class="mini-counter">
          <button data-act="minus" aria-label="One less">−</button>
          <span class="count ${done ? 'done' : ''}">${p.have}<span class="of">/${p.qty}</span></span>
          <button data-act="plus" aria-label="One more">+</button>
        </div>
      </div>`;
    }).join('')}</div>`;
  }
  return `<div class="grid">${items.map((p) => {
    const missing = p.qty - p.have;
    return `
        <div class="pitem part ${missing ? 'missing' : 'done'}" data-key="${esc(p.key)}">
          <div class="pic" data-act="view">
            ${partImg(p)}
            ${missing ? `<span class="need-tag">need ${missing}</span>` : `<span class="tick">✓</span>`}
          </div>
          <div class="info">
            <div class="pname">${esc(p.name)}</div>
            <div class="meta">${swatch(p.rgb)} ${esc(p.colorName)} · ${esc(p.partNum)}${p.acc ? ' <span class="acc-tag">accessory</span>' : ''}</div>
          </div>
          <div class="counter">
            <button data-act="minus" aria-label="One less">−</button>
            <span class="count">${p.have}<span class="of"> / ${p.qty}</span></span>
            <button data-act="plus" aria-label="One more">+</button>
          </div>
        </div>`;
  }).join('')}</div>`;
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
  if (ui.partSetNum !== setNum) { ui.partSetNum = setNum; ui.partColor = ''; ui.partType = ''; }
  const inFilter = set.parts.filter((p) =>
    f === 'all' ? true : f === 'missing' ? p.have < p.qty : p.have >= p.qty);

  if (ui.partColor && !inFilter.some((p) => p.colorName === ui.partColor)) ui.partColor = '';
  if (ui.partType && !inFilter.some((p) => pieceType(p) === ui.partType)) ui.partType = '';
  const parts = inFilter.filter((p) =>
    (!ui.partColor || p.colorName === ui.partColor) && (!ui.partType || pieceType(p) === ui.partType));

  let html = `
    <div class="card set-card" style="cursor:default">
      ${set.img ? `<img src="${esc(set.img)}" alt="">` : ''}
      <div class="grow">
        <div class="muted small">${esc(setSub(set))} · ${st.kinds} different parts</div>
        <div class="progress"><div style="width:${st.need ? Math.round(st.have / st.need * 100) : 100}%"></div></div>
        <div style="margin-top:6px">
          ${st.missing ? `<span class="badge miss">${st.missing} ${st.missing === 1 ? 'piece' : 'pieces'} missing</span>` : `<span class="badge ok">Complete ✓</span>`}
          <span class="muted small">${st.have} / ${st.need}</span>
        </div>
        ${isFig(set) ? `
        <div class="fig-count">
          <span class="muted small">How many?</span>
          <div class="mini-counter">
            <button id="figLess" aria-label="One fewer">−</button>
            <span class="count">${set.count || 1}</span>
            <button id="figMore" aria-label="One more">+</button>
          </div>
          ${(set.count || 1) > 1 ? `<span class="muted small">${figsComplete(set)} of ${set.count} complete</span>` : ''}
        </div>` : ''}
        <button class="btn small value-btn" id="valueBtn">${hasValue(set) ? `💷 ${money(set.value)} · edit` : '💷 Add value'}</button>
      </div>
    </div>
    ${isFig(set) ? renderFigSets(set) : renderSetFigs(set)}
    ${renderSwapBox(set)}
    <div class="sets-toolbar lf-toolbar">
      <label class="sort-select">
        <span class="muted small">Sort</span>
        <select id="partSort" aria-label="Sort pieces">
          ${PART_SORTS.map(([v, label]) => `<option value="${v}" ${ui.partSort === v ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </label>
      ${filterButton(ui.partColor, ui.partType)}
      <div class="view-toggle" role="group" aria-label="View">
        ${PART_VIEWS.map(([v, icon, label]) => `<button data-pview="${v}" class="${ui.partView === v ? 'active' : ''}" aria-label="${label} view" title="${label}">${icon}</button>`).join('')}
      </div>
    </div>
    <div class="seg" id="filter">
      <button data-f="missing" class="${f === 'missing' ? 'active' : ''}">Missing (${st.kindsMissing})</button>
      <button data-f="have" class="${f === 'have' ? 'active' : ''}">Have (${st.kinds - st.kindsMissing})</button>
      <button data-f="all" class="${f === 'all' ? 'active' : ''}">All (${st.kinds})</button>
    </div>
    ${activeFilterTags(ui.partColor, ui.partColor ? set.parts.find((p) => p.colorName === ui.partColor).rgb : '', ui.partType, `Showing ${parts.length} of ${inFilter.length}:`)}
    <p class="muted small">${PART_VIEW_HINTS[ui.partView]}</p>`;

  if (!parts.length) {
    html += f === 'missing' && !ui.partColor && !ui.partType
      ? `<div class="empty"><div class="big">🎉</div>Nothing missing — this ${noun(set)} is complete!</div>`
      : `<div class="empty">No pieces here.</div>`;
  } else {
    for (const g of groupParts(parts)) {
      if (g.title) html += `<h3 class="part-group">${g.rgb ? swatch(g.rgb) : ''}${esc(g.title)} <span class="muted">(${g.items.length})</span></h3>`;
      html += renderPartItems(g.items);
    }
  }

  html += `
    <p></p>
    <div class="card">
      <h2>${isFig(set) ? 'Minifigure' : 'Set'} options</h2>
      <div class="row" style="flex-wrap:wrap">
        <button class="btn small" id="allHave">Tick all as have</button>
        <button class="btn small" id="allMissing">Untick all (start again)</button>
        <button class="btn small" id="refresh">Re-download list</button>
        <button class="btn small" id="del" style="color:var(--miss)">Delete ${noun(set)}</button>
      </div>
    </div>`;
  $('#view').innerHTML = html;

  document.querySelectorAll('#filter button').forEach((b) => {
    b.onclick = () => { ui.setFilter = b.dataset.f; renderSet(setNum); };
  });
  const rerender = () => { const y = window.scrollY; renderSet(setNum); window.scrollTo(0, y); };
  const sortSel = $('#partSort');
  sortSel.onchange = () => { ui.partSort = sortSel.value; savePref('partSort', sortSel.value); rerender(); };
  document.querySelectorAll('[data-pview]').forEach((b) => {
    b.onclick = () => { ui.partView = b.dataset.pview; savePref('partView', b.dataset.pview); rerender(); };
  });
  $('#filterBtn').onclick = () => showFilterSheet(
    inFilter.map((p) => ({ colour: p.colorName, rgb: p.rgb, type: pieceType(p), n: 1 })),
    { colour: ui.partColor, type: ui.partType },
    ({ colour, type }) => { ui.partColor = colour; ui.partType = type; rerender(); },
    ['different piece', 'different pieces']);
  document.querySelectorAll('[data-clear]').forEach((b) => {
    b.onclick = () => { if (b.dataset.clear === 'colour') ui.partColor = ''; else ui.partType = ''; rerender(); };
  });
  $('#view').querySelectorAll('.pitem').forEach((el) => {
    el.onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      const p = set.parts.find((x) => x.key === el.dataset.key);
      if (act === 'view') { showSetPartSheet(setNum, p.key, rerender); return; }
      if (act === 'plus') changeHave(setNum, p.key, 1);
      if (act === 'minus') changeHave(setNum, p.key, -1);
      const y = window.scrollY;
      renderSet(setNum);
      window.scrollTo(0, y);
    };
  });
  $('#allHave').onclick = async () => {
    if (!await askConfirm({ title: 'Tick every piece as have?', text: `Every piece in this ${noun(set)} will be marked as found.`, ok: 'Tick all' })) return;
    setAllHave(setNum, true);
    if (route().arg === setNum) renderSet(setNum);
    toast('All pieces ticked');
  };
  $('#allMissing').onclick = async () => {
    if (!await askConfirm({ title: 'Untick every piece?', text: `This clears all your ticks for this ${noun(set)} so you can start again. Every piece will show as missing.`, ok: 'Untick all', danger: true })) return;
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
  bindFigSets(set);
  if ($('#figMore')) {
    $('#figMore').onclick = () => { setFigCount(set, (set.count || 1) + 1); save(); rerender(); toast(`You now have ${set.count} — their pieces are added to Looking for`); };
    $('#figLess').onclick = async () => {
      const n = set.count || 1;
      if (n === 1) return toast('To remove the figure, use Delete minifigure');
      const lost = set.parts.reduce((t, p) => t + Math.max(0, p.have - perFig(set, p) * (n - 1)), 0);
      if (lost && !await askConfirm({ title: `Down to ${n - 1}?`, text: `${plural(lost, 'found piece', 'found pieces')} will be unticked, because ${n - 1 === 1 ? 'one figure' : `${n - 1} figures`} only need${n - 1 === 1 ? 's' : ''} fewer.`, ok: 'Remove one', danger: true })) return;
      setFigCount(set, n - 1);
      save();
      rerender();
    };
  }
  document.querySelectorAll('[data-setfig]').forEach((b) => { b.onclick = () => showSetFigSheet(set, Number(b.dataset.setfig), rerender); });
  if ($('#toFig')) $('#toFig').onclick = () => turnIntoFig(set);
  if ($('#looseIn')) {
    $('#looseIn').onclick = () => moveFigsToSet(set.figs.map((f) => state.sets[f.figNum]).filter((f) => f && isFig(f)),
      { setNum: set.setNum, name: set.name, year: set.year, img: set.img }, $('#looseIn'));
  }
  if (!set.figs && !isFig(set)) loadSetFigs(set);
  const delBtn = $('#delBtn');
  delBtn.classList.remove('hidden');
  $('#del').onclick = delBtn.onclick = async () => { if (await deleteSet(setNum)) go('#sets'); };
  $('#refresh').onclick = async () => {
    try {
      toast('Downloading…');
      const fresh = isFig(set) ? await fetchFig(setNum, { refresh: true }) : await fetchSet(setNum, { refresh: true });
      if (isFig(set)) {
        // Keep accessories added by hand and how many you have.
        const extra = set.parts.filter((p) => p.acc && !fresh.parts.some((x) => x.key === p.key));
        addAccessories(fresh, extra.map((p) => ({ ...p, per: perFig(set, p) })));
        if (!fresh.pack && set.pack) fresh.pack = set.pack;
        setFigCount(fresh, set.count || 1);
      }
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

// Small red "last brick" used on empty screens.
function emptyBrick() {
  const [f, e] = BRICK_COLOURS.r;
  return `<svg class="empty-brick" viewBox="0 0 100 70" aria-hidden="true">
    <ellipse cx="50" cy="62" rx="30" ry="3.5" fill="#000" opacity=".08"/>
    ${[0, 1, 2].map((i) => `<rect x="${24.5 + i * 20}" y="13" width="11" height="8" rx="2.5" fill="${f}" stroke="${e}" stroke-width="2"/>`).join('')}
    <rect x="20" y="20" width="60" height="34" rx="4" fill="${f}" stroke="${e}" stroke-width="2.4"/>
    <rect x="24" y="24" width="52" height="3.5" rx="1.75" fill="#fff" opacity=".28"/>
    <rect x="22" y="46" width="56" height="6" rx="3" fill="#000" opacity=".13"/>
  </svg>`;
}

// A simple toy figure (our own drawing) for empty minifigure screens.
function emptyFig(cls = 'empty-brick') {
  const [y, ye] = BRICK_COLOURS.y, [r, re] = BRICK_COLOURS.r, [b, be] = BRICK_COLOURS.b;
  return `<svg class="${cls}" viewBox="0 0 100 124" aria-hidden="true">
    <ellipse cx="50" cy="118" rx="30" ry="3.5" fill="#000" opacity=".08"/>
    <rect x="43" y="5" width="14" height="7" rx="2.5" fill="${y}" stroke="${ye}" stroke-width="2"/>
    <rect x="35" y="11" width="30" height="25" rx="9" fill="${y}" stroke="${ye}" stroke-width="2.4"/>
    <circle cx="44.5" cy="22" r="2.4" fill="#222"/><circle cx="55.5" cy="22" r="2.4" fill="#222"/>
    <path d="M43 28 Q50 33.5 57 28" fill="none" stroke="#222" stroke-width="2.2" stroke-linecap="round"/>
    <rect x="43" y="35" width="14" height="5" fill="${y}" stroke="${ye}" stroke-width="2"/>
    <rect x="19" y="43" width="11" height="27" rx="5.5" transform="rotate(14 24.5 56.5)" fill="${r}" stroke="${re}" stroke-width="2"/>
    <rect x="70" y="43" width="11" height="27" rx="5.5" transform="rotate(-14 75.5 56.5)" fill="${r}" stroke="${re}" stroke-width="2"/>
    <circle cx="21" cy="72" r="5" fill="${y}" stroke="${ye}" stroke-width="2"/><circle cx="79" cy="72" r="5" fill="${y}" stroke="${ye}" stroke-width="2"/>
    <path d="M33 40 H67 L71 74 H29 Z" fill="${r}" stroke="${re}" stroke-width="2.4" stroke-linejoin="round"/>
    <rect x="37" y="45" width="26" height="3" rx="1.5" fill="#fff" opacity=".28"/>
    <rect x="28" y="74" width="44" height="9" rx="2" fill="${b}" stroke="${be}" stroke-width="2.2"/>
    <rect x="29" y="82" width="20" height="31" rx="2.5" fill="${b}" stroke="${be}" stroke-width="2.2"/>
    <rect x="51" y="82" width="20" height="31" rx="2.5" fill="${b}" stroke="${be}" stroke-width="2.2"/>
  </svg>`;
}

// Small figure head for buttons and labels.
function figIcon() {
  const [y, ye] = BRICK_COLOURS.y;
  return `<svg class="fig-ico" viewBox="0 0 20 20" aria-hidden="true">
    <rect x="7" y="1" width="6" height="3" rx="1" fill="${y}" stroke="${ye}" stroke-width="1"/>
    <rect x="3" y="3.5" width="14" height="13" rx="4.5" fill="${y}" stroke="${ye}" stroke-width="1.3"/>
    <circle cx="7.5" cy="9" r="1.2" fill="#222"/><circle cx="12.5" cy="9" r="1.2" fill="#222"/>
    <path d="M7 12 Q10 14.5 13 12" fill="none" stroke="#222" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`;
}

const MISSING_SORTS = [['colour', 'Colour'], ['type', 'Type'], ['needed', 'Most needed'], ['set', 'By set']];
const MISSING_VIEWS = [['grid', '▦', 'Grid'], ['list', '☰', 'List'], ['compact', '≡', 'Compact']];

// Groups for Looking for. Each entry: { title, rgb, items: [{ g, sets }] } where
// `sets` are the sets to show for that item (all of them, or one when grouped by set).
function groupMissing(shown) {
  const byColourName = (a, b) => a.g.part.colorName.localeCompare(b.g.part.colorName) || a.g.part.name.localeCompare(b.g.part.name);
  const wrap = (g) => ({ g, sets: g.sets });
  if (ui.missingSort === 'set') {
    const groups = new Map();
    for (const g of shown) {
      for (const s of g.sets) {
        if (!groups.has(s.set.setNum)) groups.set(s.set.setNum, { title: s.set.name, sub: '#' + shortSetNum(s.set.setNum), items: [] });
        groups.get(s.set.setNum).items.push({ g, sets: [s] });
      }
    }
    return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title)).map((x) => ({ ...x, items: x.items.sort(byColourName) }));
  }
  if (ui.missingSort === 'colour' || ui.missingSort === 'type') {
    const groups = new Map();
    for (const g of shown) {
      const k = ui.missingSort === 'colour' ? g.part.colorName : g.type;
      if (!groups.has(k)) groups.set(k, { title: k, rgb: ui.missingSort === 'colour' ? g.part.rgb : '', items: [] });
      groups.get(k).items.push(wrap(g));
    }
    const order = ui.missingSort === 'type'
      ? (a, b) => PIECE_TYPES.indexOf(a.title) - PIECE_TYPES.indexOf(b.title)
      : (a, b) => a.title.localeCompare(b.title);
    return [...groups.values()].sort(order).map((x) => ({ ...x, items: x.items.sort(byColourName) }));
  }
  return [{ title: '', items: shown.map(wrap).sort((a, b) => b.g.total - a.g.total || byColourName(a, b)) }];
}

function renderMissing() {
  setTitle('Looking for');
  const all = missingGroups();
  if (!Object.keys(state.sets).length) {
    $('#view').innerHTML = `<div class="empty">${emptyBrick()}<b>Nothing to look for yet</b><br>Add a set or minifigure first, and all its missing pieces show up here.</div>`;
    return;
  }
  if (!all.length) {
    $('#view').innerHTML = `<div class="empty">${emptyBrick()}<b>All done!</b><br>You're not missing anything. Everything is complete. 🎉</div>`;
    return;
  }

  for (const g of all) g.type = pieceType(g.part);
  if (ui.missingColor && !all.some((g) => g.part.colorName === ui.missingColor)) ui.missingColor = '';
  if (ui.missingType && !all.some((g) => g.type === ui.missingType)) ui.missingType = '';
  const shown = all.filter((g) =>
    (!ui.missingColor || g.part.colorName === ui.missingColor) && (!ui.missingType || g.type === ui.missingType));

  const totalPieces = all.reduce((n, g) => n + g.total, 0);
  const owners = [...new Set(all.flatMap((g) => g.sets.map((s) => s.set)))];
  const figOwners = owners.filter(isFig).length;
  const setOwners = owners.length - figOwners;
  const across = [setOwners && plural(setOwners, 'set', 'sets'), figOwners && plural(figOwners, 'minifigure', 'minifigures')].filter(Boolean).join(' & ');
  const shownPieces = shown.reduce((n, g) => n + g.total, 0);
  const filtering = ui.missingColor || ui.missingType;
  const activeColour = filtering && ui.missingColor ? all.find((g) => g.part.colorName === ui.missingColor).part.rgb : '';

  let html = `
    <section class="lf-head">
      <h2 class="lf-title">${totalPieces} ${totalPieces === 1 ? 'piece' : 'pieces'} to find<br><span class="accent">across ${across}</span></h2>
    </section>
    <div class="sets-toolbar lf-toolbar">
      <label class="sort-select">
        <span class="muted small">Sort</span>
        <select id="missingSort" aria-label="Sort missing pieces">
          ${MISSING_SORTS.map(([v, label]) => `<option value="${v}" ${ui.missingSort === v ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </label>
      ${filterButton(ui.missingColor, ui.missingType)}
      <div class="view-toggle" role="group" aria-label="View">
        ${MISSING_VIEWS.map(([v, icon, label]) => `<button data-mview="${v}" class="${ui.missingView === v ? 'active' : ''}" aria-label="${label} view" title="${label}">${icon}</button>`).join('')}
      </div>
    </div>
    ${activeFilterTags(ui.missingColor, activeColour, ui.missingType, `Showing ${shownPieces} of ${totalPieces}:`)}`;

  if (!shown.length) html += `<div class="empty">No missing pieces match these filters.</div>`;
  for (const grp of groupMissing(shown)) {
    if (grp.title) html += `<h3 class="part-group">${grp.rgb ? swatch(grp.rgb) : ''}${esc(grp.title)}${grp.sub ? ` <span class="muted">${esc(grp.sub)}</span>` : ''} <span class="muted">(${grp.items.length})</span></h3>`;
    html += renderMissingItems(grp.items);
  }
  $('#view').innerHTML = html;

  const rerender = () => { const y = window.scrollY; renderMissing(); window.scrollTo(0, y); };
  const sortSel = $('#missingSort');
  sortSel.onchange = () => { ui.missingSort = sortSel.value; savePref('missingSort', sortSel.value); rerender(); };
  document.querySelectorAll('[data-mview]').forEach((b) => {
    b.onclick = () => { ui.missingView = b.dataset.mview; savePref('missingView2', b.dataset.mview); rerender(); };
  });
  $('#filterBtn').onclick = () => showFilterSheet(
    all.map((g) => ({ colour: g.part.colorName, rgb: g.part.rgb, type: g.type, n: g.total })),
    { colour: ui.missingColor, type: ui.missingType },
    ({ colour, type }) => { ui.missingColor = colour; ui.missingType = type; renderMissing(); window.scrollTo(0, 0); });
  document.querySelectorAll('[data-clear]').forEach((b) => {
    b.onclick = () => { if (b.dataset.clear === 'colour') ui.missingColor = ''; else ui.missingType = ''; rerender(); };
  });
  document.querySelectorAll('[data-found]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      changeHave(b.dataset.found, b.closest('[data-key]').dataset.key, 1, { withUndo: true });
      rerender();
    };
  });
  document.querySelectorAll('[data-sheet]').forEach((el) => {
    el.onclick = (e) => { if (!e.target.closest('[data-found]')) showPartSheet(el.dataset.key); };
  });
}

function renderMissingItems(items) {
  if (ui.missingView === 'grid') {
    return `<div class="grid compact">${items.map(({ g }) => `
        <div class="part missing" data-key="${esc(g.key)}" data-sheet>
          <div class="pic">${partImg(g.part)}<span class="need-tag">×${g.total}</span></div>
          <div class="info"><div class="meta">${swatch(g.part.rgb)} ${esc(g.part.colorName)}</div></div>
        </div>`).join('')}</div>`;
  }
  if (ui.missingView === 'compact') {
    return `<div class="part-list">${items.map(({ g, sets }) => `
        <div class="crow missing" data-key="${esc(g.key)}" data-sheet>
          <div class="crow-pic">${partImg(g.part)}</div>
          <div class="grow">
            <div class="crow-name">${esc(g.part.name)}</div>
            <div class="meta">${swatch(g.part.rgb)} ${esc(g.part.colorName)} · ${esc(g.part.partNum)}</div>
          </div>
          <span class="badge miss">need ${sets.reduce((t, s) => t + s.need, 0)}</span>
        </div>`).join('')}</div>`;
  }
  return `<div class="part-list">${items.map(({ g, sets }) => `
      <div class="prow lf-row missing" data-key="${esc(g.key)}">
        <div class="prow-pic" data-sheet data-key="${esc(g.key)}">${partImg(g.part)}</div>
        <div class="grow">
          <div class="pname">${esc(g.part.name)}</div>
          <div class="meta">${swatch(g.part.rgb)} ${esc(g.part.colorName)} · ${esc(g.part.partNum)}</div>
          ${sets.map((s) => `
            <div class="lf-set">
              <span class="sname"><b>${s.need}×</b> ${esc(s.set.name)} <span class="muted">#${esc(shortSetNum(s.set.setNum))}</span></span>
              <button class="btn ok small" data-found="${esc(s.set.setNum)}">Found</button>
            </div>`).join('')}
        </div>
      </div>`).join('')}</div>`;
}

// Bottom panel with every colour and type laid out in a grid (no sideways
// scrolling). `entries` are { colour, rgb, type, n }; counts respect the other choice.
function showFilterSheet(entries, current, onApply, unit = ['piece', 'pieces']) {
  let colour = current.colour, type = current.type;
  const draw = () => {
    const colours = new Map(), types = new Map();
    let count = 0;
    for (const e of entries) {
      if (!type || e.type === type) {
        const c = colours.get(e.colour) || { name: e.colour, rgb: e.rgb, n: 0 };
        c.n += e.n; colours.set(e.colour, c);
      }
      if (!colour || e.colour === colour) types.set(e.type, (types.get(e.type) || 0) + e.n);
      if ((!colour || e.colour === colour) && (!type || e.type === type)) count += e.n;
    }
    openSheet(`
      <div class="filter-sheet">
        <div class="row"><h2 class="grow">Filter</h2><button class="link-btn" id="fClear">Clear all</button></div>
        <h3 class="steps-title">Colour</h3>
        <div class="filter-grid">
          ${[...colours.values()].sort((a, b) => b.n - a.n).map((c) => `
            <button class="fchip ${colour === c.name ? 'on' : ''}" data-fc="${esc(c.name)}">${swatch(c.rgb)}<span>${esc(c.name)}</span><em>${c.n}</em></button>`).join('')}
        </div>
        <h3 class="steps-title">Type of piece</h3>
        <div class="filter-grid">
          ${PIECE_TYPES.filter((t) => types.get(t)).map((t) => `
            <button class="fchip ${type === t ? 'on' : ''}" data-ft="${esc(t)}"><span>${esc(t)}</span><em>${types.get(t)}</em></button>`).join('')}
        </div>
        <button class="btn primary block" id="fApply">Show ${count} ${count === 1 ? unit[0] : unit[1]}</button>
      </div>`);
    document.querySelectorAll('[data-fc]').forEach((b) => { b.onclick = () => { colour = colour === b.dataset.fc ? '' : b.dataset.fc; draw(); }; });
    document.querySelectorAll('[data-ft]').forEach((b) => { b.onclick = () => { type = type === b.dataset.ft ? '' : b.dataset.ft; draw(); }; });
    $('#fClear').onclick = () => { colour = ''; type = ''; draw(); };
    $('#fApply').onclick = () => { closeSheet(); onApply({ colour, type }); };
  };
  draw();
}

function filterButton(colour, type) {
  const n = (colour ? 1 : 0) + (type ? 1 : 0);
  return `<button class="filter-btn ${n ? 'on' : ''}" id="filterBtn">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        <span class="fword">Filter</span>${n ? `<span class="fcount">${n}</span>` : ''}
      </button>`;
}

function activeFilterTags(colour, rgb, type, label) {
  if (!colour && !type) return '';
  return `<div class="active-filters">
      <span class="muted small">${label}</span>
      ${colour ? `<button class="pill" data-clear="colour">${swatch(rgb)}${esc(colour)} ✕</button>` : ''}
      ${type ? `<button class="pill" data-clear="type">${esc(type)} ✕</button>` : ''}
    </div>`;
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

// Viewfinder art for the Scan page: the red "last brick" inside camera
// corner brackets, with a scanning line sweeping over it.
function scanArt(cls = 'scan-art') {
  const [f, e] = BRICK_COLOURS.r;
  const studs = [0, 1, 2].map((i) => `<rect x="${72 + i * 20}" y="58" width="12" height="8" rx="2.5" fill="${f}" stroke="${e}" stroke-width="2"/>`).join('');
  const corner = (d) => `<path d="${d}" fill="none" stroke="var(--brand)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `
  <svg class="${cls}" viewBox="0 0 200 140" aria-hidden="true">
    ${corner('M34 36 V18 H52')}${corner('M148 18 H166 V36')}${corner('M166 104 V122 H148')}${corner('M52 122 H34 V104')}
    <ellipse cx="100" cy="104" rx="34" ry="3.5" fill="#000" opacity=".08"/>
    ${studs}
    <rect x="66" y="64" width="68" height="34" rx="4" fill="${f}" stroke="${e}" stroke-width="2.4"/>
    <rect x="70" y="68" width="60" height="3.5" rx="1.75" fill="#fff" opacity=".28"/>
    <rect x="68" y="90" width="64" height="6" rx="3" fill="#000" opacity=".13"/>
    <g class="scan-line"><rect x="40" y="0" width="120" height="3" rx="1.5" fill="var(--brand)" opacity=".85"/><rect x="40" y="3" width="120" height="14" fill="url(#scanGlow)"/></g>
    <defs><linearGradient id="scanGlow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d01012" stop-opacity=".22"/><stop offset="1" stop-color="#d01012" stop-opacity="0"/></linearGradient></defs>
  </svg>`;
}

/* Tip pictures for the Scan page, drawn in the same brick style as the logo. */
const tipBrick = (x, y, w, colour = 'r', studs = 2) => {
  const [f, e] = BRICK_COLOURS[colour];
  const gap = w / studs;
  return `${Array.from({ length: studs }, (_, i) => `<rect x="${x + gap * i + gap / 2 - 3.5}" y="${y - 4}" width="7" height="5" rx="1.5" fill="${f}" stroke="${e}" stroke-width="1.3"/>`).join('')}
    <rect x="${x}" y="${y}" width="${w}" height="12" rx="2.2" fill="${f}" stroke="${e}" stroke-width="1.6"/>
    <rect x="${x + 2.5}" y="${y + 2.2}" width="${w - 5}" height="2" rx="1" fill="#fff" opacity=".3"/>`;
};
const TIP_ART = {
  // One brick on its own, with a soft shadow.
  one: `<svg class="step-svg" viewBox="0 0 48 48" aria-hidden="true">
    <ellipse cx="24" cy="38" rx="15" ry="2.6" fill="#000" opacity=".1"/>
    ${tipBrick(11, 22, 26, 'r', 2)}
  </svg>`,
  // A sheet of white paper with a brick sitting on it.
  paper: `<svg class="step-svg" viewBox="0 0 48 48" aria-hidden="true">
    <path d="M6 34 L18 14 H44 L34 34 Z" fill="#fff" stroke="#b9bcc6" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M6 34 V37 H34 V34" fill="#e3e5ea" stroke="#b9bcc6" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M34 34 L44 14 V17 L34 37" fill="#e3e5ea" stroke="#b9bcc6" stroke-width="1.6" stroke-linejoin="round"/>
    ${tipBrick(17, 20, 14, 'b', 2)}
  </svg>`,
  // A round yellow sun with chunky rays.
  light: `<svg class="step-svg" viewBox="0 0 48 48" aria-hidden="true">
    <g fill="#f6c31b" stroke="#c99a06" stroke-width="1.4">
      ${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<rect x="21.5" y="2.5" width="5" height="8" rx="2.5" transform="rotate(${a} 24 24)"/>`).join('')}
      <circle cx="24" cy="24" r="10.5"/>
    </g>
    <circle cx="20.5" cy="20.5" r="3" fill="#fff" opacity=".45"/>
  </svg>`,
  // A 2×2 brick seen from the top with its studs, and a turn-over arrow.
  side: `<svg class="step-svg" viewBox="0 0 48 48" aria-hidden="true">
    <rect x="9" y="11" width="26" height="26" rx="3" fill="${BRICK_COLOURS.g[0]}" stroke="${BRICK_COLOURS.g[1]}" stroke-width="1.6"/>
    ${[[16, 18], [28, 18], [16, 30], [28, 30]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4.3" fill="${BRICK_COLOURS.g[0]}" stroke="${BRICK_COLOURS.g[1]}" stroke-width="1.4"/><circle cx="${x - 1.2}" cy="${y - 1.2}" r="1.3" fill="#fff" opacity=".4"/>`).join('')}
    <path d="M39 30 A12 12 0 0 0 39 12" fill="none" stroke="var(--brand)" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M35 11.5 L39.5 11 L40 15.5" fill="none" stroke="var(--brand)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
};

const SCAN_TIPS = [
  [TIP_ART.one, 'One piece only', 'Put a single piece in the photo. It doesn\'t need to fill the frame: the app zooms in on it for you.'],
  [TIP_ART.paper, 'Plain background', 'A sheet of white paper is perfect, so the piece stands out.'],
  [TIP_ART.light, 'Good light', 'Daylight is best; avoid strong shadows.'],
  [TIP_ART.side, 'Best side up', 'Show the studs, holes or printed side.'],
];

function renderScan() {
  setTitle('Scan a piece');
  let html = '';
  if (!scanState) {
    html = `
      <section class="hero scan-start">
        ${scanArt()}
        <h2 class="hero-title">Found a piece?<br><span class="accent">Scan it to find its set.</span></h2>
        <p class="hero-sub">Take a photo of one piece and Last Brick works out what it is, and which of your sets needs it.</p>
      </section>
      <button class="btn primary block hero-cta" id="snap">${scanIcon({ onRed: true, cls: 'scan-ico btn-ico' })} Scan a piece</button>
      <p class="center small hero-login">Know the part number? <a href="#missing">Search your list</a></p>
      <h3 class="steps-title">Tips for a good match</h3>
      ${swipeCards('scanTips', SCAN_TIPS)}`;
  } else {
    html += `
      <div class="scan-shot ${scanState.loading ? 'scanning' : ''}">
        <img src="${esc(scanState.photoUrl)}" alt="Your photo">
        <span class="vf tl"></span><span class="vf tr"></span><span class="vf br"></span><span class="vf bl"></span>
        ${scanState.loading ? '<span class="shot-line"></span>' : ''}
      </div>`;
    if (scanState.loading) {
      html += `<p class="center scan-status">Working out which piece this is…</p>`;
    } else if (scanState.error) {
      html += `<div class="verdict-card no"><span class="verdict-ico">⚠️</span><div><b>Something went wrong</b><span>${esc(scanState.error)} You can still search the <a href="#missing">Looking for</a> list.</span></div></div>`;
    } else {
      html += renderScanResults(scanState.items);
    }
    if (!scanState.loading) html += `<button class="btn primary block hero-cta scan-again" id="snap">${scanIcon({ onRed: true, cls: 'scan-ico btn-ico' })} Scan another piece</button>`;
  }
  $('#view').innerHTML = html;
  if ($('#snap')) $('#snap').onclick = () => $('#cameraInput').click();
  bindSwipeCards('scanTips');
  bindScanResultButtons();
}

function renderScanResults(items) {
  if (!items.length) {
    return `<div class="verdict-card no"><span class="verdict-ico">🤔</span><div><b>Couldn't recognise that piece</b><span>Try again closer up, on a plain background — or search the <a href="#missing">Looking for</a> list.</span></div></div>`;
  }
  const top = items.slice(0, 4);
  const results = top.map((it) => ({ it, ...findMissingMatches(it.id) }));
  const anyHit = results.some((r) => r.exact.length || r.similar.length);
  let html = anyHit
    ? `<div class="verdict-card yes"><span class="verdict-ico">✅</span><div><b>Yes — you're looking for this!</b><span>Pick the set that matches your piece's colour and tap Add.</span></div></div>`
    : `<div class="verdict-card no"><span class="verdict-ico">🔎</span><div><b>Not on your missing list</b><span>Check the best guess looks right. If it doesn't, try another photo.</span></div></div>`;

  results.forEach((r, i) => {
    const hits = [...r.exact, ...r.similar];
    if (i > 0 && !hits.length) return; // only show alternative guesses that matter
    const score = Math.round((r.it.score || 0) * 100);
    html += `
      <div class="match-card ${hits.length ? 'hit' : ''}">
        <div class="match-head">
          <div class="match-pic">${r.it.img_url ? `<img src="${esc(r.it.img_url)}" alt="">` : '<span class="no-pic">🧱</span>'}</div>
          <div class="grow">
            <span class="match-chip">${i === 0 ? 'Best guess' : 'Could also be'} · ${score}% sure</span>
            <div class="match-name">${esc(r.it.name)}</div>
            <div class="small muted">#${esc(r.it.id)}</div>
          </div>
        </div>`;
    if (hits.length) {
      html += `<div class="match-sets-title">Needed by</div>`;
      for (const h of hits) {
        const need = h.p.qty - h.p.have;
        html += `
          <div class="match-set">
            <div class="thumb">${partImg(h.p)}</div>
            <div class="grow" style="min-width:0">
              <div class="sname"><b>${esc(h.set.name)}</b> <span class="muted">#${esc(shortSetNum(h.set.setNum))}</span></div>
              <div class="small muted">${swatch(h.p.rgb)} ${esc(h.p.colorName)} · need ${need}${r.exact.includes(h) ? '' : ' · similar part'}</div>
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
    const found = await identifyPiece(file);
    scanState.items = found.items;
    await zoomPhoto(scanState, found.box);
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
      <p class="muted small">${session ? 'Your sets are backed up online automatically. You can also keep a copy as a file.' : 'Your ticks are saved on this phone only. Download a backup now and then, or use it to move to a new phone.'} (${[plural(sets.filter((x) => !isFig(x)).length, 'set', 'sets'), sets.some(isFig) && plural(sets.filter(isFig).length, 'minifigure', 'minifigures')].filter(Boolean).join(' and ')} saved.)</p>
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
      authDone('Logged in — your sets are backed up');
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
        authDone('Account created — your sets are backed up');
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
// The Scan tab uses the same brick-and-scan-line picture as the Scan page.
$('#tabs [data-tab="scan"] .ico').innerHTML = scanIcon({ cls: 'tab-svg' });
$('#backBtn').onclick = () => (history.length > 1 ? history.back() : go('#sets'));

render();
handleAuthRedirect().then(() => syncNow());
// Pick up changes from other devices when the app is reopened or back online.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
window.addEventListener('online', () => syncNow());

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}

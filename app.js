/* Brick Finder — track missing LEGO pieces across your sets.
 *
 * Parts lists come from the Rebrickable API (free key required).
 * Photo recognition of a single piece uses the Brickognize API.
 * Everything you tick off is stored on this device (localStorage).
 */
'use strict';

const STORE_KEY = 'brickfinder.v1';
const RB_API = 'https://rebrickable.com/api/v3/lego';
const BRICKOGNIZE_API = 'https://api.brickognize.com/predict/parts/';

/* ---------- State ---------- */

let state = load();
let ui = { setFilter: 'missing', missingColor: '', missingSearch: '', setSearch: '', missingView: loadPref('missingView', 'list') };
let lastUndo = null;
let scanState = null; // { photoUrl, loading, error, items }

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      s.sets = s.sets || {};
      return s;
    }
  } catch (e) { console.warn('Could not load saved data', e); }
  return { apiKey: '', sets: {} };
}

function loadPref(name, fallback) {
  try { return localStorage.getItem('brickfinder.' + name) || fallback; } catch { return fallback; }
}
function savePref(name, value) {
  try { localStorage.setItem('brickfinder.' + name, value); } catch { /* not important */ }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('Could not save on this device: ' + e.message);
  }
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
  if (res.status === 404) throw new Error('Set not found. Check the number on the box or manual (e.g. 6080 or 6080-1).');
  if (res.status === 401 || res.status === 403) throw new Error('Rebrickable rejected the API key. Check it in Settings.');
  if (res.status === 429) throw new Error('Rebrickable says too many requests — wait a minute and try again.');
  if (!res.ok) throw new Error('Rebrickable error ' + res.status);
  return res.json();
}

async function fetchSet(setNum) {
  const info = await rbFetch(`${RB_API}/sets/${encodeURIComponent(setNum)}/`);
  const merged = new Map();
  let url = `${RB_API}/sets/${encodeURIComponent(setNum)}/parts/?page_size=1000&inc_minifig_parts=1&inc_part_details=1`;
  while (url) {
    const page = await rbFetch(url);
    for (const r of page.results) {
      if (r.is_spare) continue; // spares are extras in the bag, not needed to build
      const key = r.part.part_num + '|' + r.color.id;
      const existing = merged.get(key);
      if (existing) { existing.qty += r.quantity; continue; }
      const ext = r.part.external_ids || {};
      merged.set(key, {
        key,
        partNum: r.part.part_num,
        name: r.part.name,
        img: r.element_img_url || r.part.part_img_url || '',
        colorId: r.color.id,
        colorName: r.color.name,
        rgb: r.color.rgb,
        qty: r.quantity,
        have: 0,
        altIds: [...(ext.BrickLink || []), ...(ext.LEGO || [])].map(String),
      });
    }
    url = page.next;
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

  if (!state.apiKey && r.name !== 'settings') return renderWelcome();

  switch (r.name) {
    case 'set': return renderSet(r.arg);
    case 'add': return renderAdd();
    case 'missing': return renderMissing();
    case 'scan': return renderScan();
    case 'settings': return renderSettings();
    default: return renderSets();
  }
}

function setTitle(t) { $('#title').textContent = t; }

function renderWelcome() {
  setTitle('Brick Finder');
  $('#view').innerHTML = `
    <div class="card">
      <h2>👋 Welcome!</h2>
      <p>Add your LEGO sets by number and this app downloads the parts list (the same one printed at the back of the manual) with a picture of every piece.</p>
      <p>Tick off what you have. The <b>Looking for</b> tab shows every missing piece across all your sets, and <b>Scan</b> tells you which set a piece you just found belongs to.</p>
    </div>
    <div class="card">
      <h2>One-time setup: free Rebrickable key</h2>
      <ol class="small">
        <li>Create a free account at <a href="https://rebrickable.com/signup/" target="_blank" rel="noopener">rebrickable.com</a>.</li>
        <li>Go to <a href="https://rebrickable.com/users/profile/settings/#api" target="_blank" rel="noopener">Settings → API</a> and tap <b>Generate new API key</b>.</li>
        <li>Copy the key and paste it below.</li>
      </ol>
      <input class="field" id="keyInput" placeholder="Paste API key here" autocomplete="off" autocapitalize="off" spellcheck="false">
      <p></p>
      <button class="btn primary block" id="saveKey">Save and start</button>
    </div>`;
  $('#saveKey').onclick = () => {
    const k = $('#keyInput').value.trim();
    if (!k) return toast('Paste your key first');
    state.apiKey = k; save(); go('#sets'); render();
  };
}

function renderSets() {
  setTitle('My sets');
  const sets = sortedSets();
  let html = `<button class="btn primary block" id="addBtn">＋ Add a set</button><p></p>`;
  if (!sets.length) {
    html += `<div class="empty"><div class="big">🧱</div>No sets yet.<br>Tap <b>Add a set</b> and enter the set number from the manual cover.</div>`;
  } else {
    if (sets.length > 4) {
      html += `<input class="field" id="setSearch" placeholder="Search sets…" value="${esc(ui.setSearch)}"><p></p>`;
    }
    const q = ui.setSearch.toLowerCase();
    for (const s of sets) {
      if (q && !(s.name.toLowerCase().includes(q) || s.setNum.toLowerCase().includes(q))) continue;
      const st = setStats(s);
      const pct = st.need ? Math.round((st.have / st.need) * 100) : 100;
      html += `
        <div class="card set-card" data-set="${esc(s.setNum)}">
          ${s.img ? `<img src="${esc(s.img)}" alt="" loading="lazy">` : ''}
          <div class="grow">
            <div class="name">${esc(s.name)}</div>
            <div class="muted small">#${esc(shortSetNum(s.setNum))} · ${esc(s.year)}</div>
            <div class="progress"><div style="width:${pct}%"></div></div>
            <div class="small" style="margin-top:4px">
              ${st.missing
                ? `<span class="badge miss">${st.missing} missing</span> <span class="muted">${st.have}/${st.need} pieces</span>`
                : `<span class="badge ok">Complete ✓</span> <span class="muted">${st.need} pieces</span>`}
            </div>
          </div>
          <button class="icon-btn" data-del="${esc(s.setNum)}" aria-label="Delete ${esc(s.name)}">🗑</button>
        </div>`;
    }
  }
  $('#view').innerHTML = html;
  $('#addBtn').onclick = () => go('#add');
  const ss = $('#setSearch');
  if (ss) ss.oninput = () => { ui.setSearch = ss.value; renderSetsKeepFocus(); };
  document.querySelectorAll('[data-set]').forEach((el) => {
    el.onclick = (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { deleteSet(del.dataset.del).then((gone) => gone && renderSets()); return; }
      go('#set/' + encodeURIComponent(el.dataset.set));
    };
  });
}

function renderSetsKeepFocus() {
  const pos = $('#setSearch').selectionStart;
  renderSets();
  const ss = $('#setSearch');
  ss.focus(); ss.setSelectionRange(pos, pos);
}

function renderAdd() {
  setTitle('Add a set');
  $('#view').innerHTML = `
    <div class="card">
      <label class="lbl" for="setNum">Set number</label>
      <input class="field" id="setNum" inputmode="text" placeholder="e.g. 6080" autocomplete="off" autocapitalize="off">
      <p class="muted small">It's on the front of the manual and the box. If there are several versions you can add <b>-2</b>, <b>-3</b>… (default is -1).</p>
      <label class="lbl">How complete is it?</label>
      <div class="seg" id="startMode">
        <button data-v="most" class="active">Mostly complete</button>
        <button data-v="none">Start from zero</button>
      </div>
      <p class="muted small" id="modeHelp"></p>
      <button class="btn primary block" id="fetchBtn">Get parts list</button>
      <div id="addStatus"></div>
    </div>`;
  let mode = 'most';
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
          ${st.missing ? `<span class="badge miss">${st.missing} pieces missing</span>` : `<span class="badge ok">Complete ✓</span>`}
          <span class="muted small">${st.have} / ${st.need}</span>
        </div>
      </div>
    </div>
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
  const delBtn = $('#delBtn');
  delBtn.classList.remove('hidden');
  $('#del').onclick = delBtn.onclick = async () => { if (await deleteSet(setNum)) go('#sets'); };
  $('#refresh').onclick = async () => {
    try {
      toast('Downloading…');
      const fresh = await fetchSet(setNum);
      const old = new Map(set.parts.map((p) => [p.key, p.have]));
      fresh.parts.forEach((p) => { p.have = Math.min(p.qty, old.get(p.key) || 0); });
      fresh.addedAt = set.addedAt;
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

  // Colour chips (most common colours first)
  const colors = new Map();
  for (const g of all) {
    const c = colors.get(g.part.colorName) || { name: g.part.colorName, rgb: g.part.rgb, n: 0 };
    c.n += g.total; colors.set(c.name, c);
  }
  const colorList = [...colors.values()].sort((a, b) => b.n - a.n);
  if (ui.missingColor && !colors.has(ui.missingColor)) ui.missingColor = '';

  const q = ui.missingSearch.trim().toLowerCase();
  const shown = all.filter((g) =>
    (!ui.missingColor || g.part.colorName === ui.missingColor) &&
    (!q || g.part.name.toLowerCase().includes(q) || g.part.partNum.toLowerCase().includes(q) ||
      g.part.colorName.toLowerCase().includes(q)));
  shown.sort((a, b) => a.part.colorName.localeCompare(b.part.colorName) || a.part.name.localeCompare(b.part.name));

  const totalPieces = all.reduce((n, g) => n + g.total, 0);
  let html = `
    <p class="muted small">${totalPieces} pieces missing across ${new Set(all.flatMap((g) => g.sets.map((s) => s.set.setNum))).size} sets. Sorting a pile by colour? Pick a colour below.</p>
    <input class="field" id="mSearch" type="search" placeholder="Search by name or part number…" value="${esc(ui.missingSearch)}">
    <p></p>
    <div class="chips">
      <button class="chip ${!ui.missingColor ? 'active' : ''}" data-color="">All colours</button>
      ${colorList.map((c) => `<button class="chip ${ui.missingColor === c.name ? 'active' : ''}" data-color="${esc(c.name)}">${swatch(c.rgb)}${esc(c.name)} (${c.n})</button>`).join('')}
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

  const ms = $('#mSearch');
  ms.oninput = () => {
    ui.missingSearch = ms.value;
    const pos = ms.selectionStart;
    renderMissing();
    const n = $('#mSearch'); n.focus(); n.setSelectionRange(pos, pos);
  };
  document.querySelectorAll('[data-color]').forEach((b) => {
    b.onclick = () => { ui.missingColor = b.dataset.color; renderMissing(); };
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
    <div class="card">
      <h2>Rebrickable API key</h2>
      <p class="muted small">Free from <a href="https://rebrickable.com/users/profile/settings/#api" target="_blank" rel="noopener">rebrickable.com → Settings → API</a>.</p>
      <input class="field" id="keyInput" value="${esc(state.apiKey)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste API key here">
      <p></p>
      <button class="btn primary block" id="saveKey">Save key</button>
    </div>
    <div class="card">
      <h2>Backup</h2>
      <p class="muted small">Your ticks are saved on this phone only. Download a backup now and then, or use it to move to a new phone. (${sets.length} sets saved.)</p>
      <div class="row">
        <button class="btn grow" id="exportBtn">⬇️ Download backup</button>
        <button class="btn grow" id="importBtn">⬆️ Restore backup</button>
      </div>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
    </div>
    <div class="card small muted">
      <h2 style="color:var(--text)">About</h2>
      <p>Parts lists and pictures: <a href="https://rebrickable.com" target="_blank" rel="noopener">Rebrickable</a>. Piece recognition: <a href="https://brickognize.com" target="_blank" rel="noopener">Brickognize</a>. LEGO® is a trademark of the LEGO Group, which does not sponsor or endorse this app.</p>
    </div>`;
  $('#saveKey').onclick = () => {
    state.apiKey = $('#keyInput').value.trim(); save();
    toast(state.apiKey ? 'Key saved' : 'Key removed');
  };
  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify({ app: 'brickfinder', version: 1, exportedAt: new Date().toISOString(), sets: state.sets }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `brick-finder-backup-${new Date().toISOString().slice(0, 10)}.json`;
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
      if (!data || typeof data.sets !== 'object') throw new Error('Not a Brick Finder backup file');
      const n = Object.keys(data.sets).length;
      if (!await askConfirm({ title: `Restore ${n} sets from this backup?`, text: 'Sets with the same number on this phone will be replaced.', ok: 'Restore' })) return;
      Object.assign(state.sets, data.sets); save();
      toast(`Restored ${n} sets`); renderSettings();
    } catch (err) { toast('Could not restore: ' + err.message); }
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

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}

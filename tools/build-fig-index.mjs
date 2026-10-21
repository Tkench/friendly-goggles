// Builds the "piece → minifigures" lookup used when you scan one piece of a
// minifigure. Run by .github/workflows/minifig-index.yml once a week.
//
// It reads Rebrickable's free catalogue downloads (https://rebrickable.com/downloads/)
// and writes small JSON files under data/figindex/:
//   colors.json    { colourId: [name, rgb] }
//   p/<xx>.json    { part_num: { n: name, c: { colourId: { i: image, f: [[fig_num, name, image, pieces], …] } } } }
//   legs.json      { legsColour: { hipsColourId: { i: image, plain: [figs], printed: [figs] } } }
//                  Scanners call plain legs 970c00 whatever the colour, but Rebrickable
//                  numbers legs by leg colour (970c28 = blue legs) with the hips colour as
//                  the piece colour, so legs get their own list, found by colour.
//   figs.json      [[fig_num, name, image], …] every minifigure, so a whole-figure scan
//                  (which gives BrickLink's name) can be matched to Rebrickable's names
//   meta.json      when it was built and how big it is
// Parts are spread over 256 files by a hash of the part number (see shardOf,
// which app.js repeats), so a scan downloads only one small file.
//
// Usage: node tools/build-fig-index.mjs [folder with the .csv.gz files]
// Without a folder it downloads them from Rebrickable.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';

const SRC = 'https://cdn.rebrickable.com/media/downloads/';
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'figindex');
const IMG = 'https://cdn.rebrickable.com/media/'; // stripped from picture links to keep files small
const localDir = process.argv[2];

export function shardOf(partNum) {
  let h = 5381;
  for (const ch of String(partNum).toLowerCase()) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return (h % 256).toString(16).padStart(2, '0');
}

// Splits one CSV line, allowing "quoted, fields" with "" inside.
function splitCsv(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

// Calls onRow(object) for every row of a Rebrickable .csv.gz file.
async function eachRow(name, onRow) {
  let input;
  if (localDir) input = fs.createReadStream(path.join(localDir, name));
  else {
    const res = await fetch(SRC + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    input = Readable.fromWeb(res.body);
  }
  const lines = readline.createInterface({ input: input.pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let cols = null, n = 0;
  for await (const line of lines) {
    if (!line) continue;
    const cells = splitCsv(line);
    if (!cols) { cols = cells; continue; }
    const row = {};
    cols.forEach((c, i) => { row[c] = cells[i]; });
    onRow(row);
    n++;
  }
  console.log(`${name}: ${n} rows`);
}

const short = (url) => (url && url.startsWith(IMG) ? url.slice(IMG.length) : url || '');

// 1. Minifigures and their latest inventory.
const figs = new Map(); // fig_num -> [fig_num, name, image, pieces]
await eachRow('minifigs.csv.gz', (r) => figs.set(r.fig_num, [r.fig_num, r.name, short(r.img_url), Number(r.num_parts) || 0]));
const figInv = new Map(); // inventory id -> fig_num
const latest = new Map(); // fig_num -> { id, version }
await eachRow('inventories.csv.gz', (r) => {
  if (!figs.has(r.set_num)) return;
  const v = Number(r.version) || 1;
  const cur = latest.get(r.set_num);
  if (!cur || v > cur.version) latest.set(r.set_num, { id: r.id, version: v });
});
for (const [fig, { id }] of latest) figInv.set(id, fig);

// 2. Which pieces (in which colour) each of those inventories holds.
const index = new Map(); // part_num -> { n, c: { colour: { i, f: Set(fig_num) } } }
await eachRow('inventory_parts.csv.gz', (r) => {
  const fig = figInv.get(r.inventory_id);
  if (!fig || /^(t|true|1)$/i.test(r.is_spare || '')) return;
  let p = index.get(r.part_num);
  if (!p) index.set(r.part_num, (p = { n: '', c: {} }));
  const c = p.c[r.color_id] || (p.c[r.color_id] = { i: '', f: new Set() });
  if (!c.i && r.img_url) c.i = short(r.img_url);
  c.f.add(fig);
});

// 3. Piece names and colours.
await eachRow('parts.csv.gz', (r) => { const p = index.get(r.part_num); if (p) p.n = r.name; });
const colours = {};
await eachRow('colors.csv.gz', (r) => { colours[r.id] = [r.name, r.rgb]; });

// 4. Write the files.
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'p'), { recursive: true });
const shards = new Map();
for (const [num, p] of index) {
  const key = shardOf(num);
  if (!shards.has(key)) shards.set(key, {});
  const c = {};
  for (const [colour, v] of Object.entries(p.c)) {
    c[colour] = { i: v.i, f: [...v.f].sort().map((f) => figs.get(f)) };
  }
  shards.get(key)[num.toLowerCase()] = { n: p.n, c };
}
for (let i = 0; i < 256; i++) {
  const key = i.toString(16).padStart(2, '0');
  fs.writeFileSync(path.join(OUT, 'p', key + '.json'), JSON.stringify(shards.get(key) || {}));
}
fs.writeFileSync(path.join(OUT, 'colors.json'), JSON.stringify(colours));
fs.writeFileSync(path.join(OUT, 'figs.json'), JSON.stringify([...latest.keys()].sort().map((f) => figs.get(f).slice(0, 3))));

const legs = {};
for (const [num, p] of index) {
  const m = /^Hips and (.+?) Legs\b/.exec(p.n);
  if (!m) continue;
  const kind = p.n === m[0] ? 'plain' : 'printed';
  const byHips = legs[m[1]] || (legs[m[1]] = {});
  for (const [colour, v] of Object.entries(p.c)) {
    const e = byHips[colour] || (byHips[colour] = { i: '', plain: new Set(), printed: new Set() });
    if (!e.i || kind === 'plain') e.i = v.i || e.i;
    v.f.forEach((f) => e[kind].add(f));
  }
}
for (const byHips of Object.values(legs)) {
  for (const e of Object.values(byHips)) {
    e.plain = [...e.plain].sort().map((f) => figs.get(f));
    e.printed = [...e.printed].sort().map((f) => figs.get(f));
  }
}
fs.writeFileSync(path.join(OUT, 'legs.json'), JSON.stringify(legs));
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({ built: new Date().toISOString(), figs: latest.size, parts: index.size, imageBase: IMG }));
console.log(`Done: ${latest.size} minifigures, ${index.size} different pieces.`);

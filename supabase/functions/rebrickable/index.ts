// Last Brick: parts-list helper (Supabase Edge Function "rebrickable").
//
// The app asks this function for a set's parts list instead of calling
// Rebrickable itself, so people don't need their own Rebrickable key.
// The key lives only here, as the REBRICKABLE_KEY secret, and every
// parts list is cached in the set_cache table so each set is fetched from
// Rebrickable only once for everyone.
//
// GET /functions/v1/rebrickable?set=6080-1[&refresh=1]
//   200 { info, results, cats }   404 { error: "not_found" }
// Minifigures:
//   ?fig=fig-000123[&refresh=1]   { info, results, sets, cats }  (its pieces and the sets it came in)
//   ?figsearch=falcon             { results: [figure, …] }       (search by name or number)
//   ?figfind=cas123&name=…        { results: [figure, …] }       (match a figure scan)
//   ?partfigs=973pb123c01         { part, colors: [colour, …] }  (colours a scanned piece comes in)
//   ?partfigs=…&color=0           { part, color, results: [figure, …] } (figures using that piece)
//   ?setfigs=6080-1               { results: [{ set_num, name, quantity, set_img_url, parts }] } (figures in a set)

const RB = 'https://rebrickable.com/api/v3/lego';
const KEY = Deno.env.get('REBRICKABLE_KEY') ?? '';
const DB = (Deno.env.get('SUPABASE_URL') ?? '') + '/rest/v1/set_cache';
// Supabase provides one of these automatically (older or newer key system).
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || '';

const DAY = 24 * 60 * 60 * 1000;
const KEEP_FOR = 30 * DAY; // parts lists rarely change
const REFRESH_AFTER = DAY; // "Re-download list" fetches again at most once a day

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

type HttpError = Error & { status?: number };

// deno-lint-ignore no-explicit-any
async function rebrickable(path: string): Promise<any> {
  const res = await fetch(RB + path, { headers: { Authorization: 'key ' + KEY } });
  if (!res.ok) {
    const err: HttpError = new Error('Rebrickable error ' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Older keys are JWTs and also go in Authorization; newer sb_secret_ keys go in apikey only.
const dbHeaders: Record<string, string> = SERVICE_KEY.startsWith('eyJ')
  ? { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
  : { apikey: SERVICE_KEY };

// Returns the cached value for `key` if it's newer than maxAge, otherwise
// loads it fresh and stores it. Cache problems never stop a lookup.
async function cached(key: string, maxAge: number, load: () => Promise<unknown>): Promise<unknown> {
  try {
    const res = await fetch(`${DB}?select=data,fetched_at&key=eq.${encodeURIComponent(key)}`, { headers: dbHeaders });
    const rows = res.ok ? await res.json() : [];
    if (rows[0] && Date.now() - Date.parse(rows[0].fetched_at) < maxAge) return rows[0].data;
  } catch (e) {
    console.error('cache read failed', e);
  }
  const data = await load();
  try {
    await fetch(DB, {
      method: 'POST',
      headers: { ...dbHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key, data, fetched_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.error('cache write failed', e);
  }
  return data;
}

// Keep only what the app uses, to keep the cache and downloads small.
// deno-lint-ignore no-explicit-any
function trimPart(r: any) {
  const ext = r.part.external_ids || {};
  return {
    part: {
      part_num: r.part.part_num,
      name: r.part.name,
      part_cat_id: r.part.part_cat_id,
      part_img_url: r.part.part_img_url,
      external_ids: { BrickLink: ext.BrickLink || [], LEGO: ext.LEGO || [] },
    },
    color: { id: r.color.id, name: r.color.name, rgb: r.color.rgb },
    quantity: r.quantity,
    is_spare: r.is_spare,
  };
}

async function loadSet(set: string) {
  const num = encodeURIComponent(set);
  const info = await rebrickable(`/sets/${num}/`);
  const results: unknown[] = [];
  let path = `/sets/${num}/parts/?page_size=1000&inc_minifig_parts=1&inc_part_details=1`;
  while (path) {
    const page = await rebrickable(path);
    for (const r of page.results) results.push(trimPart(r));
    path = page.next ? page.next.replace(RB, '') : null;
  }
  return {
    info: { set_num: info.set_num, name: info.name, year: info.year, set_img_url: info.set_img_url },
    results,
  };
}

async function loadCategories() {
  const data = await rebrickable('/part_categories/?page_size=1000');
  return Object.fromEntries(data.results.map((c: { id: number; name: string }) => [c.id, c.name]));
}

// deno-lint-ignore no-explicit-any
const trimFig = (f: any) => ({ set_num: f.set_num, name: f.name, num_parts: f.num_parts, set_img_url: f.set_img_url });

// Every page of a Rebrickable list (up to `max` items).
// deno-lint-ignore no-explicit-any
async function allPages(path: string, max = 3000): Promise<any[]> {
  const out: unknown[] = [];
  while (path && out.length < max) {
    const page = await rebrickable(path);
    out.push(...page.results);
    path = page.next ? page.next.replace(RB, '') : '';
  }
  // deno-lint-ignore no-explicit-any
  return out as any[];
}

async function loadFig(fig: string) {
  const num = encodeURIComponent(fig);
  const info = await rebrickable(`/minifigs/${num}/`);
  const results = (await allPages(`/minifigs/${num}/parts/?page_size=1000&inc_part_details=1`)).map(trimPart);
  // deno-lint-ignore no-explicit-any
  const sets = (await allPages(`/minifigs/${num}/sets/?page_size=1000`)).map((s: any) => ({
    set_num: s.set_num, name: s.set_name ?? s.name, year: s.year, set_img_url: s.set_img_url, quantity: s.quantity,
  }));
  return { info: { set_num: info.set_num, name: info.name, num_parts: info.num_parts, set_img_url: info.set_img_url }, results, sets };
}

async function searchFigs(q: string) {
  const page = await rebrickable(`/minifigs/?page_size=60&search=${encodeURIComponent(q)}`);
  return { results: page.results.map(trimFig) };
}

// Figure scans give BrickLink ids and names, so try the id, then the name, then a shorter name.
async function findFigs(id: string, name: string) {
  const tries = [id, name, name.split(/ - |,|\(/)[0]].map((t) => t.trim()).filter((t) => t.length > 2);
  for (const t of [...new Set(tries)]) {
    const found = await cached('figsearch:' + t.toLowerCase(), KEEP_FOR, () => searchFigs(t)) as { results: unknown[] };
    if (found.results.length) return found;
  }
  return { results: [] };
}

// Scans give BrickLink part numbers, which are sometimes different on Rebrickable.
// deno-lint-ignore no-explicit-any
async function findPart(id: string): Promise<any> {
  try {
    return await rebrickable(`/parts/${encodeURIComponent(id)}/`);
  } catch (e) {
    if ((e as HttpError).status !== 404) throw e;
  }
  const page = await rebrickable(`/parts/?bricklink_id=${encodeURIComponent(id)}`);
  if (!page.results.length) {
    const err: HttpError = new Error('not found');
    err.status = 404;
    throw err;
  }
  return page.results[0];
}

async function loadColors() {
  const data = await rebrickable('/colors/?page_size=1000');
  return Object.fromEntries(data.results.map((c: { id: number; name: string; rgb: string }) => [c.id, { name: c.name, rgb: c.rgb }]));
}

async function partColors(id: string) {
  const part = await findPart(id);
  const colours = await cached('colors', KEEP_FOR, loadColors) as Record<string, { name: string; rgb: string }>;
  const list = await allPages(`/parts/${encodeURIComponent(part.part_num)}/colors/?page_size=1000`);
  return {
    part: { part_num: part.part_num, name: part.name, part_img_url: part.part_img_url },
    // deno-lint-ignore no-explicit-any
    colors: list.map((c: any) => ({ id: c.color_id, name: c.color_name, rgb: colours[c.color_id]?.rgb || 'cccccc', img: c.part_img_url, num_sets: c.num_sets }))
      .sort((a, b) => b.num_sets - a.num_sets),
  };
}

async function partFigs(id: string, color: string) {
  const part = await findPart(id);
  const colours = await cached('colors', KEEP_FOR, loadColors) as Record<string, { name: string; rgb: string }>;
  const list = await allPages(`/parts/${encodeURIComponent(part.part_num)}/colors/${encodeURIComponent(color)}/sets/?page_size=1000`);
  return {
    part: { part_num: part.part_num, name: part.name, part_img_url: part.part_img_url },
    color: { id: Number(color), ...(colours[color] || { name: '', rgb: 'cccccc' }) },
    // Minifigures are listed alongside sets, with numbers starting "fig-".
    // deno-lint-ignore no-explicit-any
    results: list.filter((s: any) => String(s.set_num).startsWith('fig-')).map(trimFig),
  };
}

// The minifigures in a set, each with its pieces, so the app can show which are complete.
async function setFigs(set: string) {
  const figs = await allPages(`/sets/${encodeURIComponent(set)}/minifigs/?page_size=1000`);
  const results = [];
  for (const f of figs) {
    const parts = await allPages(`/minifigs/${encodeURIComponent(f.set_num)}/parts/?page_size=1000`);
    results.push({
      set_num: f.set_num, name: f.set_name ?? f.name, quantity: f.quantity, set_img_url: f.set_img_url,
      // deno-lint-ignore no-explicit-any
      parts: parts.filter((r: any) => !r.is_spare).map((r: any) => ({ part_num: r.part.part_num, color_id: r.color.id, quantity: r.quantity })),
    });
  }
  return { results };
}

const FIG_NUM = /^fig-[0-9]{1,8}$/i;
const PART_ID = /^[0-9A-Za-z.\-]{1,40}$/;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET') return reply(405, { error: 'Use GET' });
  if (!KEY) return reply(500, { error: 'REBRICKABLE_KEY secret is not set' });

  const params = new URL(req.url).searchParams;
  const refresh = params.get('refresh') === '1' ? REFRESH_AFTER : KEEP_FOR;
  try {
    const fig = params.get('fig');
    if (fig !== null) {
      if (!FIG_NUM.test(fig)) return reply(400, { error: 'Invalid minifigure number' });
      const cats = await cached('categories', KEEP_FOR, loadCategories);
      const data = await cached('fig:' + fig.toLowerCase(), refresh, () => loadFig(fig));
      return reply(200, { ...(data as object), cats });
    }
    const q = params.get('figsearch');
    if (q !== null) {
      const t = q.trim().slice(0, 60);
      if (t.length < 2) return reply(400, { error: 'Search is too short' });
      return reply(200, await cached('figsearch:' + t.toLowerCase(), KEEP_FOR, () => searchFigs(t)));
    }
    const blid = params.get('figfind');
    if (blid !== null) {
      return reply(200, await findFigs(blid.slice(0, 40), (params.get('name') || '').slice(0, 120)));
    }
    const inSet = params.get('setfigs');
    if (inSet !== null) {
      if (!/^[0-9A-Za-z]{1,15}-[0-9]{1,3}$/.test(inSet)) return reply(400, { error: 'Invalid set number' });
      return reply(200, await cached('setfigs:' + inSet.toLowerCase(), KEEP_FOR, () => setFigs(inSet)));
    }
    const part = params.get('partfigs');
    if (part !== null) {
      if (!PART_ID.test(part)) return reply(400, { error: 'Invalid part number' });
      const color = params.get('color');
      if (color === null) return reply(200, await cached('partcolors:' + part.toLowerCase(), KEEP_FOR, () => partColors(part)));
      if (!/^-?[0-9]{1,6}$/.test(color)) return reply(400, { error: 'Invalid colour' });
      return reply(200, await cached(`partfigs:${part.toLowerCase()}:${color}`, KEEP_FOR, () => partFigs(part, color)));
    }
  } catch (e) {
    const status = (e as HttpError).status;
    if (status === 404) return reply(404, { error: 'not_found' });
    if (status === 429) return reply(429, { error: 'busy' });
    console.error(e);
    return reply(502, { error: 'Could not reach Rebrickable' });
  }

  const set = (params.get('set') || '').trim();
  if (!/^[0-9A-Za-z]{1,15}(-[0-9]{1,3})?$/.test(set)) return reply(400, { error: 'Invalid set number' });

  try {
    const cats = await cached('categories', KEEP_FOR, loadCategories);
    const data = await cached('set:' + set.toLowerCase(), refresh, () => loadSet(set));
    return reply(200, { ...(data as object), cats });
  } catch (e) {
    const status = (e as HttpError).status;
    if (status === 404) return reply(404, { error: 'not_found' });
    if (status === 429) return reply(429, { error: 'busy' });
    console.error(e);
    return reply(502, { error: 'Could not reach Rebrickable' });
  }
});

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

const RB = 'https://rebrickable.com/api/v3/lego';
const KEY = Deno.env.get('REBRICKABLE_KEY') ?? '';
const DB = (Deno.env.get('SUPABASE_URL') ?? '') + '/rest/v1/set_cache';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

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

const dbHeaders = { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY };

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET') return reply(405, { error: 'Use GET' });
  if (!KEY) return reply(500, { error: 'REBRICKABLE_KEY secret is not set' });

  const params = new URL(req.url).searchParams;
  const set = (params.get('set') || '').trim();
  if (!/^[0-9A-Za-z]{1,15}(-[0-9]{1,3})?$/.test(set)) return reply(400, { error: 'Invalid set number' });

  try {
    const cats = await cached('categories', KEEP_FOR, loadCategories);
    const data = await cached('set:' + set.toLowerCase(), params.get('refresh') === '1' ? REFRESH_AFTER : KEEP_FOR, () => loadSet(set));
    return reply(200, { ...(data as object), cats });
  } catch (e) {
    const status = (e as HttpError).status;
    if (status === 404) return reply(404, { error: 'not_found' });
    if (status === 429) return reply(429, { error: 'busy' });
    console.error(e);
    return reply(502, { error: 'Could not reach Rebrickable' });
  }
});

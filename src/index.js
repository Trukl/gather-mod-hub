const ALLOWED_ORIGIN = "https://app.v2.gather.town";
const TYPES = ["outfit", "desk"];
const OUTFIT_SLOTS = [
  "skin",
  "hair",
  "facialHair",
  "top",
  "jacket",
  "bottom",
  "shoes",
  "hat",
  "glasses",
  "other",
  "costume",
  "mobility",
];
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^\d{13}[0-9a-f]{8}$/;
const MAX_BODY_CHARS = 64 * 1024;
const MAX_NAME = 40;
const MAX_SUMMARY = 300;
const MAX_META_SUMMARY = 150;
const MAX_DESK_OBJECTS = 200;
const MAX_DESK_DEPTH = 5;
const MAX_DESK_OFFSET = 100;
const MAX_DESK_AREA = 50;
const PUBLISH_PER_HOUR = 20;
const LIST_LIMIT = 100;
const MOD_RELEASE_KEY = "mod:latest";

const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
const fail = (status, error) => json({ error }, status);

const cleanText = (v, max) => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
};

function cleanOutfit(p) {
  const name = cleanText(p?.name, MAX_NAME);
  if (!name || typeof p.outfit !== "object" || p.outfit === null) return null;
  const outfit = {};
  for (const slot of OUTFIT_SLOTS) {
    const v = p.outfit[slot];
    if (v === undefined) continue;
    if (typeof v !== "string" || !UUID_RE.test(v)) return null;
    outfit[slot] = v;
  }
  const summary =
    typeof p.summary === "string" ? p.summary.slice(0, MAX_SUMMARY) : "";
  return { name, outfit, summary };
}

function cleanDeskItem(i, depth, counter) {
  if (depth > MAX_DESK_DEPTH || ++counter.n > MAX_DESK_OBJECTS) return null;
  if (
    typeof i?.variant !== "string" ||
    !UUID_RE.test(i.variant) ||
    !Number.isFinite(i.x) ||
    !Number.isFinite(i.y) ||
    Math.abs(i.x) > MAX_DESK_OFFSET ||
    Math.abs(i.y) > MAX_DESK_OFFSET ||
    !Array.isArray(i.children)
  )
    return null;
  const children = [];
  for (const c of i.children) {
    const child = cleanDeskItem(c, depth + 1, counter);
    if (!child) return null;
    children.push(child);
  }
  const name = typeof i.name === "string" ? i.name.slice(0, MAX_NAME) : "?";
  return { variant: i.variant, name, x: i.x, y: i.y, children };
}

function cleanDesk(p) {
  const name = cleanText(p?.name, MAX_NAME);
  if (!name || !Array.isArray(p.items) || !p.items.length) return null;
  const counter = { n: 0 };
  const items = [];
  for (const i of p.items) {
    const item = cleanDeskItem(i, 1, counter);
    if (!item) return null;
    items.push(item);
  }
  const area = cleanDeskArea(p.area);
  return area ? { name, items, area } : { name, items };
}

function cleanDeskArea(a) {
  const valid = (n) => Number.isFinite(n) && n > 0 && n <= MAX_DESK_AREA;
  return valid(a?.width) && valid(a?.height)
    ? { width: a.width, height: a.height }
    : null;
}

const CLEANERS = { outfit: cleanOutfit, desk: cleanDesk };
const summaryOf = (type, preset) =>
  type === "outfit"
    ? preset.summary
    : preset.items.map((i) => i.name).join(", ");

async function sha256(s) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const newId = () =>
  String(1e13 - Date.now()).padStart(13, "0") +
  crypto.randomUUID().replace(/-/g, "").slice(0, 8);

async function collectMatchingKeys(env, type, q) {
  const keys = [];
  let cursor;
  do {
    const page = await env.PRESETS.list({ prefix: `p:${type}:`, cursor });
    for (const key of page.keys) {
      const meta = key.metadata;
      if (!meta) continue;
      const haystack = `${meta.name} ${meta.author} ${meta.summary}`;
      if (q && !haystack.toLowerCase().includes(q)) continue;
      keys.push(key);
      if (keys.length >= LIST_LIMIT) return keys;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

async function listPresets(env, type, url) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const keys = await collectMatchingKeys(env, type, q);
  const items = await Promise.all(
    keys.map(async (key) => {
      const stored = await env.PRESETS.get(key.name, "json");
      if (!stored) return null;
      const id = key.name.slice(`p:${type}:`.length);
      return { id, type, ...key.metadata, data: stored.data };
    }),
  );
  return json({ items: items.filter(Boolean) });
}

async function publishPreset(env, type, request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateKey = `rl:${ip}:${Math.floor(Date.now() / 3_600_000)}`;
  const count = Number(await env.PRESETS.get(rateKey)) || 0;
  if (count >= PUBLISH_PER_HOUR) return fail(429, "too many publishes");

  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return fail(413, "too large");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "invalid json");
  }
  const data = CLEANERS[type](body?.data);
  if (!data) return fail(400, "invalid preset");

  const id = newId();
  const deleteToken = crypto.randomUUID();
  const meta = {
    name: data.name,
    author: cleanText(body.author, MAX_NAME) || "anonymous",
    summary: summaryOf(type, data).slice(0, MAX_META_SUMMARY),
    createdAt: new Date().toISOString(),
  };
  await env.PRESETS.put(
    `p:${type}:${id}`,
    JSON.stringify({ ...meta, data, tokenHash: await sha256(deleteToken) }),
    { metadata: meta },
  );
  await env.PRESETS.put(rateKey, String(count + 1), { expirationTtl: 3600 });
  return json({ id, type, deleteToken }, 201);
}

async function deletePreset(env, type, id, request) {
  const key = `p:${type}:${id}`;
  const stored = await env.PRESETS.get(key, "json");
  if (!stored) return fail(404, "not found");
  const token = (request.headers.get("Authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  );
  const isAdmin = Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN;
  if (!token || (!isAdmin && (await sha256(token)) !== stored.tokenHash))
    return fail(403, "forbidden");
  await env.PRESETS.delete(key);
  return json({ ok: true });
}

async function route(request, env) {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  if (url.pathname === "/mod/latest") {
    if (request.method !== "GET") return fail(405, "method not allowed");
    const release = await env.PRESETS.get(MOD_RELEASE_KEY);
    if (!release) return fail(404, "no release");
    return new Response(release, {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  const [, root, type, id, extra] = url.pathname.split("/");
  if (root !== "presets" || !TYPES.includes(type) || extra !== undefined)
    return fail(404, "not found");
  if (id === undefined || id === "") {
    if (request.method === "GET") return listPresets(env, type, url);
    if (request.method === "POST") return publishPreset(env, type, request);
    return fail(405, "method not allowed");
  }
  if (!ID_RE.test(id)) return fail(404, "not found");
  if (request.method === "DELETE") return deletePreset(env, type, id, request);
  return fail(405, "method not allowed");
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      console.error(e);
      return fail(500, "internal error");
    }
  },
};

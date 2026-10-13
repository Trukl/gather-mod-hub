import { createSession, sessionAccount, verifyGatherToken } from "./auth.js";
import { installStats, reportInstall } from "./installs.js";

const ALLOWED_ORIGIN = "https://app.v2.gather.town";
const TYPES = ["outfit", "desk", "construction"];
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
const ANIMATION_TYPES = ["orbit", "line", "wave"];
const MAX_ANIMATIONS_PER_FLOOR = 50;
const MAX_ANIMATION_OBJECTS = 100;
const MAX_ANIMATION_COORD = 1_000_000;
const ANIMATIONS_PER_HOUR = 30;
const MAX_CLAIMS = 200;
// Mods older than Community hub 1.1.0 / Fun 1.3.0 don't sign in: they are
// served until this date, then every route but sign-in requires a session.
const SIGN_IN_REQUIRED_FROM = Date.parse("2026-10-20T16:30:00Z");

const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
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
  const summary = typeof p.summary === "string" ? p.summary.slice(0, MAX_SUMMARY) : "";
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
  return valid(a?.width) && valid(a?.height) ? { width: a.width, height: a.height } : null;
}

function cleanConstruction(p) {
  const desk = cleanDesk(p);
  return desk && { name: desk.name, items: desk.items };
}

const CLEANERS = {
  outfit: cleanOutfit,
  desk: cleanDesk,
  construction: cleanConstruction,
};
const summaryOf = (type, preset) =>
  type === "outfit" ? preset.summary : preset.items.map((i) => i.name).join(", ");

const inRange = (v, min, max) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

// Animated objects are stable references: Gather's hashIdentifier (kept when
// a new version of the map is published) plus type and position (tiles).
function cleanObjectRefs(objects) {
  if (!Array.isArray(objects) || !objects.length || objects.length > MAX_ANIMATION_OBJECTS)
    return null;
  const refs = objects.map((o) =>
    UUID_RE.test(o?.hash || "") &&
    UUID_RE.test(o.variant || "") &&
    inRange(o.x, -MAX_ANIMATION_COORD, MAX_ANIMATION_COORD) &&
    inRange(o.y, -MAX_ANIMATION_COORD, MAX_ANIMATION_COORD)
      ? { hash: o.hash, variant: o.variant, x: o.x, y: o.y }
      : null,
  );
  return refs.includes(null) ? null : refs;
}

function cleanAnimation(a) {
  const name = cleanText(a?.name, MAX_NAME);
  if (!name || !ANIMATION_TYPES.includes(a.type)) return null;
  const objects = cleanObjectRefs(a.objects);
  const { point, params } = a;
  if (
    !objects ||
    !inRange(point?.x, -MAX_ANIMATION_COORD, MAX_ANIMATION_COORD) ||
    !inRange(point?.y, -MAX_ANIMATION_COORD, MAX_ANIMATION_COORD) ||
    !inRange(params?.period, 0.5, 600) ||
    ![1, -1].includes(params.direction) ||
    !inRange(params.amplitude, 0, 50) ||
    !inRange(params.waves, 0.5, 50)
  )
    return null;
  return {
    name,
    type: a.type,
    objects,
    point: { x: point.x, y: point.y },
    params: {
      period: params.period,
      direction: params.direction,
      amplitude: params.amplitude,
      waves: params.waves,
    },
  };
}

async function sha256(s) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const newId = () =>
  String(1e13 - Date.now()).padStart(13, "0") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);

const bearer = (request) => (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");

// The bearer is a hub session (signed in with Gather), the admin token, or the
// per-item token handed out before sign-in existed.
async function callerOf(env, request) {
  const token = bearer(request);
  return {
    token,
    accountId: await sessionAccount(env, token),
    isAdmin: Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN,
  };
}
async function canEdit(item, caller) {
  if (caller.isAdmin) return true;
  if (caller.accountId) return item.ownerId === caller.accountId;
  return Boolean(item.tokenHash && caller.token) && (await sha256(caller.token)) === item.tokenHash;
}
// Rate limits count per Gather account; per IP for clients not signed in.
const rateLimitKey = (prefix, request, caller) =>
  `${prefix}:${caller.accountId ? "acc:" + caller.accountId : request.headers.get("CF-Connecting-IP") || "unknown"}:${Math.floor(Date.now() / 3_600_000)}`;
// Items created while signed in belong to the account; the others get a token.
async function ownership(caller) {
  if (caller.accountId) return { stored: { ownerId: caller.accountId }, token: undefined };
  const token = crypto.randomUUID();
  return { stored: { tokenHash: await sha256(token) }, token };
}
const isMine = (item, caller) => Boolean(caller.accountId) && item.ownerId === caller.accountId;

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

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

async function listPresets(env, type, url, caller) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const keys = await collectMatchingKeys(env, type, q);
  const items = await Promise.all(
    keys.map(async (key) => {
      const stored = await env.PRESETS.get(key.name, "json");
      if (!stored) return null;
      const id = key.name.slice(`p:${type}:`.length);
      return { id, type, ...key.metadata, data: stored.data, mine: isMine(stored, caller) };
    }),
  );
  return json({ items: items.filter(Boolean) });
}

const presetMeta = ({ name, author, summary, createdAt }) => ({ name, author, summary, createdAt });

async function publishPreset(env, type, request, caller) {
  const rateKey = rateLimitKey("rl", request, caller);
  const count = Number(await env.PRESETS.get(rateKey)) || 0;
  if (count >= PUBLISH_PER_HOUR) return fail(429, "too many publishes");

  const body = await readBody(request);
  if (!body) return fail(400, "invalid json or too large");
  const data = CLEANERS[type](body.data);
  if (!data) return fail(400, "invalid preset");

  const id = newId();
  const meta = {
    name: data.name,
    author: cleanText(body.author, MAX_NAME) || "anonymous",
    summary: summaryOf(type, data).slice(0, MAX_META_SUMMARY),
    createdAt: new Date().toISOString(),
  };
  const { stored, token } = await ownership(caller);
  await env.PRESETS.put(`p:${type}:${id}`, JSON.stringify({ ...meta, data, ...stored }), {
    metadata: meta,
  });
  await env.PRESETS.put(rateKey, String(count + 1), { expirationTtl: 3600 });
  return json({ id, type, deleteToken: token }, 201);
}

async function deletePreset(env, type, id, caller) {
  const key = `p:${type}:${id}`;
  const stored = await env.PRESETS.get(key, "json");
  if (!stored) return fail(404, "not found");
  if (!(await canEdit(stored, caller))) return fail(403, "forbidden");
  await env.PRESETS.delete(key);
  return json({ ok: true });
}

// All animations of a floor live in one key: listing them costs a single read.
// The floor survives new versions of its map, whose id changes.
const animationsKey = (floorId) => `af:${floorId}`;
// Before stable references, animations were stored per map version, with object ids.
const legacyAnimationsKey = (mapId) => `a:${mapId}`;
const readAnimations = async (env, floorId) =>
  (await env.PRESETS.get(animationsKey(floorId), "json")) ?? [];
const publicAnimation = ({ tokenHash, ownerId, ...a }, caller) => ({
  ...a,
  mine: isMine({ ownerId }, caller),
});

// `?map=` adds the legacy animations of that map version, for the client to migrate.
async function listAnimations(env, floorId, url, caller) {
  const items = await readAnimations(env, floorId);
  const mapId = url.searchParams.get("map");
  const legacy = UUID_RE.test(mapId || "")
    ? await env.PRESETS.get(legacyAnimationsKey(mapId), "json")
    : null;
  return json({
    now: Date.now(),
    items: items.map((a) => publicAnimation(a, caller)),
    ...(legacy?.length && { legacy: legacy.map((a) => publicAnimation(a, caller)) }),
  });
}

// The client still has the objects of the legacy animations' map version and
// sends their references; unresolved animations (objects gone) are dropped.
async function migrateAnimations(env, floorId, request, caller) {
  if (!caller.accountId) return fail(401, "sign in required");
  const body = await readBody(request);
  if (!UUID_RE.test(body?.mapId || "")) return fail(400, "invalid map");
  const legacy = (await env.PRESETS.get(legacyAnimationsKey(body.mapId), "json")) ?? [];
  const refs = new Map(
    (Array.isArray(body.items) ? body.items : []).map((i) => [i?.id, i?.objects]),
  );
  const items = await readAnimations(env, floorId);
  const known = new Set(items.map((a) => a.id));
  for (const { ids, ...animation } of legacy) {
    const objects = cleanObjectRefs(refs.get(animation.id));
    if (!objects || known.has(animation.id) || items.length >= MAX_ANIMATIONS_PER_FLOOR) continue;
    items.push({ ...animation, objects });
  }
  await env.PRESETS.put(animationsKey(floorId), JSON.stringify(items));
  await env.PRESETS.delete(legacyAnimationsKey(body.mapId));
  return json({ now: Date.now(), items: items.map((a) => publicAnimation(a, caller)) });
}

async function createAnimation(env, floorId, request, caller) {
  const rateKey = rateLimitKey("rla", request, caller);
  const count = Number(await env.PRESETS.get(rateKey)) || 0;
  if (count >= ANIMATIONS_PER_HOUR) return fail(429, "too many animations");
  const body = await readBody(request);
  const data = cleanAnimation(body?.data);
  if (!data) return fail(400, "invalid animation");
  const items = await readAnimations(env, floorId);
  if (items.length >= MAX_ANIMATIONS_PER_FLOOR)
    return fail(409, "too many animations on this floor");
  const { stored, token } = await ownership(caller);
  const animation = {
    id: newId(),
    author: cleanText(body.author, MAX_NAME) || "anonymous",
    ...data,
    running: true,
    startedAt: Date.now(),
    ...stored,
  };
  await env.PRESETS.put(animationsKey(floorId), JSON.stringify([...items, animation]));
  await env.PRESETS.put(rateKey, String(count + 1), { expirationTtl: 3600 });
  return json(
    { animation: publicAnimation(animation, caller), editToken: token, now: Date.now() },
    201,
  );
}

async function editAnimation(env, floorId, id, request, caller) {
  const items = await readAnimations(env, floorId);
  const animation = items.find((a) => a.id === id);
  if (!animation) return fail(404, "not found");
  if (!(await canEdit(animation, caller))) return fail(403, "forbidden");
  if (request.method === "DELETE") {
    await env.PRESETS.put(
      animationsKey(floorId),
      JSON.stringify(items.filter((a) => a !== animation)),
    );
    return json({ ok: true });
  }
  const body = await readBody(request);
  if (typeof body?.running !== "boolean") return fail(400, "invalid change");
  animation.running = body.running;
  if (body.running) animation.startedAt = Date.now();
  await env.PRESETS.put(animationsKey(floorId), JSON.stringify(items));
  return json({ animation: publicAnimation(animation, caller), now: Date.now() });
}

function routeAnimations(request, env, floorId, id, url, caller) {
  if (!UUID_RE.test(floorId || "")) return fail(404, "not found");
  if (id === undefined || id === "") {
    if (request.method === "GET") return listAnimations(env, floorId, url, caller);
    if (request.method === "POST") return createAnimation(env, floorId, request, caller);
    return fail(405, "method not allowed");
  }
  if (id === "migrate" && request.method === "POST")
    return migrateAnimations(env, floorId, request, caller);
  if (!ID_RE.test(id)) return fail(404, "not found");
  if (request.method === "PATCH" || request.method === "DELETE")
    return editAnimation(env, floorId, id, request, caller);
  return fail(405, "method not allowed");
}

async function signIn(env, request) {
  const body = await readBody(request);
  const accountId = await verifyGatherToken(body?.gatherToken);
  if (!accountId) return fail(401, "invalid Gather token");
  return json(await createSession(env, accountId));
}

// Hands the items created before sign-in to the account, given their tokens.
async function claim(env, request, caller) {
  if (!caller.accountId) return fail(401, "sign in required");
  const body = await readBody(request);
  const presets = Array.isArray(body?.presets) ? body.presets : [];
  const animations = Array.isArray(body?.animations) ? body.animations : [];
  if (presets.length + animations.length > MAX_CLAIMS) return fail(413, "too many claims");
  const proves = async (item, token) =>
    typeof token === "string" &&
    Boolean(item.tokenHash) &&
    (await sha256(token)) === item.tokenHash;
  const handOver = ({ tokenHash, ...item }) => ({ ...item, ownerId: caller.accountId });
  const claimed = [];
  for (const { type, id, token } of presets) {
    if (!TYPES.includes(type) || !ID_RE.test(id || "")) continue;
    const key = `p:${type}:${id}`;
    const stored = await env.PRESETS.get(key, "json");
    if (!stored || !(await proves(stored, token))) continue;
    await env.PRESETS.put(key, JSON.stringify(handOver(stored)), { metadata: presetMeta(stored) });
    claimed.push(id);
  }
  const byFloor = Map.groupBy(
    animations.filter((a) => UUID_RE.test(a?.floorId || "") && ID_RE.test(a.id || "")),
    (a) => a.floorId,
  );
  for (const [floorId, claims] of byFloor) {
    const items = await readAnimations(env, floorId);
    const before = claimed.length;
    for (const [i, item] of items.entries()) {
      const match = claims.find((c) => c.id === item.id);
      if (!match || !(await proves(item, match.token))) continue;
      items[i] = handOver(item);
      claimed.push(item.id);
    }
    if (claimed.length > before)
      await env.PRESETS.put(animationsKey(floorId), JSON.stringify(items));
  }
  return json({ claimed });
}

async function route(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  const [, root, type, id, extra] = url.pathname.split("/");
  if (root === "auth" && id === undefined && request.method === "POST") {
    if (type === undefined) return signIn(env, request);
    if (type === "claim") return claim(env, request, await callerOf(env, request));
  }
  if (root === "installs" && type === undefined && request.method === "POST")
    return reportInstall(env, await readBody(request), json, fail);
  const caller = await callerOf(env, request);
  if (!caller.accountId && !caller.isAdmin && Date.now() >= SIGN_IN_REQUIRED_FROM)
    return fail(401, "sign in required");
  if (root === "stats" && type === undefined && request.method === "GET")
    return caller.isAdmin ? installStats(env, json) : fail(403, "forbidden");
  if (root === "animations" && extra === undefined)
    return routeAnimations(request, env, type, id, url, caller);
  if (root !== "presets" || !TYPES.includes(type) || extra !== undefined)
    return fail(404, "not found");
  if (id === undefined || id === "") {
    if (request.method === "GET") return listPresets(env, type, url, caller);
    if (request.method === "POST") return publishPreset(env, type, request, caller);
    return fail(405, "method not allowed");
  }
  if (!ID_RE.test(id)) return fail(404, "not found");
  if (request.method === "DELETE") return deletePreset(env, type, id, caller);
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

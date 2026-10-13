// Object animations, per Gather floor.
import { canEdit, handOver, isMine, ownership, withinRateLimit } from "./accounts.js";
import {
  cleanText,
  fail,
  ID_RE,
  inRange,
  json,
  MAX_NAME,
  newId,
  readBody,
  UUID_RE,
} from "./common.js";

const ANIMATION_TYPES = ["orbit", "line", "wave"];
const MAX_ANIMATIONS_PER_FLOOR = 50;
const MAX_ANIMATION_OBJECTS = 100;
const MAX_COORD = 1_000_000;
const ANIMATIONS_PER_HOUR = 30;

// Animated objects are stable references: Gather's hashIdentifier (kept when
// a new version of the map is published) plus type and position (tiles).
function cleanObjectRefs(objects) {
  if (!Array.isArray(objects) || !objects.length || objects.length > MAX_ANIMATION_OBJECTS)
    return null;
  const refs = objects.map((o) =>
    UUID_RE.test(o?.hash || "") &&
    UUID_RE.test(o.variant || "") &&
    inRange(o.x, -MAX_COORD, MAX_COORD) &&
    inRange(o.y, -MAX_COORD, MAX_COORD)
      ? { hash: o.hash, variant: o.variant, x: o.x, y: o.y }
      : null,
  );
  return refs.includes(null) ? null : refs;
}

function cleanAnimation(a) {
  const name = cleanText(a?.name, MAX_NAME);
  const objects = cleanObjectRefs(a?.objects);
  const { point, params } = a ?? {};
  if (
    !name ||
    !ANIMATION_TYPES.includes(a.type) ||
    !objects ||
    !inRange(point?.x, -MAX_COORD, MAX_COORD) ||
    !inRange(point?.y, -MAX_COORD, MAX_COORD) ||
    !inRange(params?.period, 0.5, 600) ||
    ![1, -1].includes(params.direction) ||
    !inRange(params.amplitude, 0, 50) ||
    !inRange(params.waves, 0.5, 50)
  )
    return null;
  const { period, direction, amplitude, waves } = params;
  return {
    name,
    type: a.type,
    objects,
    point: { x: point.x, y: point.y },
    params: { period, direction, amplitude, waves },
  };
}

// All animations of a floor live in one key: listing them costs a single read.
// The floor survives new versions of its map, whose id changes.
const animationsKey = (floorId) => `af:${floorId}`;
// Before stable references, animations were stored per map version, with object ids.
const legacyAnimationsKey = (mapId) => `a:${mapId}`;
const readAnimations = async (env, floorId) =>
  (await env.PRESETS.get(animationsKey(floorId), "json")) ?? [];
const writeAnimations = (env, floorId, items) =>
  env.PRESETS.put(animationsKey(floorId), JSON.stringify(items));
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
  await writeAnimations(env, floorId, items);
  await env.PRESETS.delete(legacyAnimationsKey(body.mapId));
  return json({ now: Date.now(), items: items.map((a) => publicAnimation(a, caller)) });
}

async function createAnimation(env, floorId, request, caller) {
  if (!(await withinRateLimit(env, "rla", ANIMATIONS_PER_HOUR, request, caller)))
    return fail(429, "too many animations");
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
  await writeAnimations(env, floorId, [...items, animation]);
  return json(
    { animation: publicAnimation(animation, caller), editToken: token, now: Date.now() },
    201,
  );
}

// PATCH { running } restarts (from the beginning) or stops; DELETE removes.
async function editAnimation(env, floorId, id, request, caller) {
  const items = await readAnimations(env, floorId);
  const animation = items.find((a) => a.id === id);
  if (!animation) return fail(404, "not found");
  if (!(await canEdit(animation, caller))) return fail(403, "forbidden");
  if (request.method === "DELETE") {
    await writeAnimations(
      env,
      floorId,
      items.filter((a) => a !== animation),
    );
    return json({ ok: true });
  }
  const body = await readBody(request);
  if (typeof body?.running !== "boolean") return fail(400, "invalid change");
  animation.running = body.running;
  if (body.running) animation.startedAt = Date.now();
  await writeAnimations(env, floorId, items);
  return json({ animation: publicAnimation(animation, caller), now: Date.now() });
}

// Ids of the animations handed to the caller's account.
export async function claimAnimations(env, claims, caller) {
  const claimed = [];
  const valid = claims.filter((a) => UUID_RE.test(a?.floorId || "") && ID_RE.test(a.id || ""));
  for (const [floorId, floorClaims] of Map.groupBy(valid, (a) => a.floorId)) {
    const items = await readAnimations(env, floorId);
    const before = claimed.length;
    for (const [i, item] of items.entries()) {
      const match = floorClaims.find((c) => c.id === item.id);
      const owned = match && (await handOver(item, match.token, caller));
      if (!owned) continue;
      items[i] = owned;
      claimed.push(item.id);
    }
    if (claimed.length > before) await writeAnimations(env, floorId, items);
  }
  return claimed;
}

export function routeAnimations(request, env, floorId, id, url, caller) {
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

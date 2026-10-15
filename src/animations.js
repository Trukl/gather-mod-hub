// Object animations, per Gather floor.
import { canEdit, handOver, isMine, ownerOf, ownership, withinRateLimit } from "./accounts.js";
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
import { isNewerVersion, runningVersions } from "./versions.js";

const ANIMATION_TYPES = ["orbit", "line", "wave"];
const MAX_ANIMATIONS_PER_FLOOR = 50;
const MAX_ANIMATION_OBJECTS = 100;
const MAX_COORD = 1_000_000;
const ANIMATIONS_PER_HOUR = 30;
// Path animations (Fun 1.7.0): a list of steps from the objects' resting
// place. Offsets are world pixels from the resting place of the group's center.
const PATH_FUN_VERSION = "1.7.0";
const MAX_STEPS = 20;
const MAX_OFFSET = 100_000;
const MAX_EXPRESSION = 120;
const MODES = ["block", "each"];
const ORDERS = ["selection", "left-right", "top-bottom", "random"];
const ENDS = ["loop", "pingpong", "once"];
const SHAPES = ["line", "wave", "arc", "orbit", "custom"];
const EASINGS = [
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "sine-in-out",
  "back-out",
  "bounce-out",
  "elastic-out",
  "custom",
];
// Expressions are only checked token by token here; clients evaluate them
// with their own parser, never as code.
const EXPRESSION_RE =
  /^(?:\s*(?:\d+(?:\.\d+)?|sqrt|sign|round|floor|sin|cos|tan|abs|exp|min|max|pi|t|[-+*/^(),]))*\s*$/;
const cleanExpression = (s) =>
  typeof s === "string" && s.trim() && s.length <= MAX_EXPRESSION && EXPRESSION_RE.test(s)
    ? s.trim()
    : null;
const cleanOffset = (p) =>
  inRange(p?.x, -MAX_OFFSET, MAX_OFFSET) && inRange(p.y, -MAX_OFFSET, MAX_OFFSET)
    ? { x: p.x, y: p.y }
    : null;

// Animated objects are stable references: Gather's hashIdentifier (kept when
// a new version of the map is published) plus type and position (tiles), or
// a custom object of the floor ({ custom: id, x, y }).
function cleanObjectRefs(objects) {
  if (!Array.isArray(objects) || !objects.length || objects.length > MAX_ANIMATION_OBJECTS)
    return null;
  const refs = objects.map((o) => {
    if (!inRange(o?.x, -MAX_COORD, MAX_COORD) || !inRange(o.y, -MAX_COORD, MAX_COORD)) return null;
    if (o.custom !== undefined)
      return ID_RE.test(o.custom) ? { custom: o.custom, x: o.x, y: o.y } : null;
    return UUID_RE.test(o.hash || "") && UUID_RE.test(o.variant || "")
      ? { hash: o.hash, variant: o.variant, x: o.x, y: o.y }
      : null;
  });
  return refs.includes(null) ? null : refs;
}

function cleanStep(s) {
  if (
    !SHAPES.includes(s?.shape) ||
    !EASINGS.includes(s.easing) ||
    !inRange(s.duration, 0.05, 600) ||
    !inRange(s.pause, 0, 600) ||
    !inRange(s.rotate, -36_000, 36_000)
  )
    return null;
  const step = {
    shape: s.shape,
    easing: s.easing,
    duration: s.duration,
    pause: s.pause,
    rotate: s.rotate,
  };
  if (s.easing === "custom") {
    step.easingExpr = cleanExpression(s.easingExpr);
    if (!step.easingExpr) return null;
  }
  if (s.shape === "orbit") {
    const center = cleanOffset(s.center);
    if (!center || !inRange(s.turns, 0.05, 100) || ![1, -1].includes(s.direction)) return null;
    return { ...step, center, turns: s.turns, direction: s.direction };
  }
  const to = cleanOffset(s.to);
  if (!to) return null;
  if (s.shape === "wave") {
    if (!inRange(s.amplitude, 0, 50) || !inRange(s.waves, 0.5, 50) || typeof s.invert !== "boolean")
      return null;
    return { ...step, to, amplitude: s.amplitude, waves: s.waves, invert: s.invert };
  }
  if (s.shape === "arc") return inRange(s.bend, -50, 50) ? { ...step, to, bend: s.bend } : null;
  if (s.shape === "custom") {
    const x = cleanExpression(s.x);
    const y = cleanExpression(s.y);
    return x && y ? { ...step, to, x, y } : null;
  }
  return { ...step, to };
}

function cleanPathAnimation(a, name, objects) {
  const steps = Array.isArray(a.steps) && a.steps.length <= MAX_STEPS ? a.steps.map(cleanStep) : [];
  if (
    !steps.length ||
    steps.includes(null) ||
    !MODES.includes(a.mode) ||
    !ENDS.includes(a.end) ||
    !inRange(a.stagger?.delay, 0, 60) ||
    !ORDERS.includes(a.stagger.order)
  )
    return null;
  const stagger = { delay: a.stagger.delay, order: a.stagger.order };
  return { name, type: "path", objects, mode: a.mode, stagger, end: a.end, steps };
}

function cleanAnimation(a) {
  const name = cleanText(a?.name, MAX_NAME);
  const objects = cleanObjectRefs(a?.objects);
  if (!name || !objects) return null;
  if (a.type === "path") return cleanPathAnimation(a, name, objects);
  const { point, params } = a;
  if (
    !ANIMATION_TYPES.includes(a.type) ||
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

// Mods before Fun 1.7.0 can't play path animations: they don't get them.
function playsPaths(request, caller) {
  if (caller.isAdmin) return true;
  const fun = runningVersions(request)?.get("fun");
  return !!fun && !isNewerVersion(PATH_FUN_VERSION, fun);
}

// One row per animation, on its floor: the floor survives new versions of its
// map, whose id changes. Rows are listed in insertion order.
const fromRow = (row) => ({ ...JSON.parse(row.data), ...ownerOf(row) });
const readAnimations = async (env, floorId) =>
  (
    await env.DB.prepare(
      "SELECT data, owner_id, token_hash FROM animations WHERE floor_id = ? ORDER BY rowid",
    )
      .bind(floorId)
      .all()
  ).results.map(fromRow);
// Inserts unless the floor is full or the id exists; meta.changes tells which.
function insertAnimation(env, floorId, { ownerId, tokenHash, ...animation }) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO animations (id, floor_id, data, owner_id, token_hash)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE (SELECT count(*) FROM animations WHERE floor_id = ?2) < ?6`,
  ).bind(
    animation.id,
    floorId,
    JSON.stringify(animation),
    ownerId ?? null,
    tokenHash ?? null,
    MAX_ANIMATIONS_PER_FLOOR,
  );
}
const publicAnimation = ({ tokenHash, ownerId, ...a }, caller) => ({
  ...a,
  mine: isMine({ ownerId }, caller),
});

// Before stable references, animations were stored per map version, with object ids.
const readLegacy = async (env, mapId) =>
  JSON.parse(
    (
      await env.DB.prepare("SELECT items FROM legacy_animations WHERE map_id = ?")
        .bind(mapId)
        .first()
    )?.items ?? "[]",
  );

// `?map=` adds the legacy animations of that map version, for the client to migrate.
async function listAnimations(env, floorId, url, request, caller) {
  const paths = playsPaths(request, caller);
  const items = (await readAnimations(env, floorId)).filter((a) => paths || a.type !== "path");
  const mapId = url.searchParams.get("map");
  const legacy = UUID_RE.test(mapId || "") ? await readLegacy(env, mapId) : [];
  return json({
    now: Date.now(),
    items: items.map((a) => publicAnimation(a, caller)),
    ...(legacy.length && { legacy: legacy.map((a) => publicAnimation(a, caller)) }),
  });
}

// The client still has the objects of the legacy animations' map version and
// sends their references; unresolved animations (objects gone) are dropped.
async function migrateAnimations(env, floorId, request, caller) {
  if (!caller.accountId) return fail(401, "sign in required");
  const body = await readBody(request);
  if (!UUID_RE.test(body?.mapId || "")) return fail(400, "invalid map");
  const refs = new Map(
    (Array.isArray(body.items) ? body.items : []).map((i) => [i?.id, i?.objects]),
  );
  const inserts = [];
  for (const { ids, ...animation } of await readLegacy(env, body.mapId)) {
    const objects = cleanObjectRefs(refs.get(animation.id));
    if (objects) inserts.push(insertAnimation(env, floorId, { ...animation, objects }));
  }
  await env.DB.batch([
    ...inserts,
    env.DB.prepare("DELETE FROM legacy_animations WHERE map_id = ?").bind(body.mapId),
  ]);
  const paths = playsPaths(request, caller);
  const items = (await readAnimations(env, floorId)).filter((a) => paths || a.type !== "path");
  return json({ now: Date.now(), items: items.map((a) => publicAnimation(a, caller)) });
}

async function createAnimation(env, floorId, request, caller) {
  if (!(await withinRateLimit(env, "rla", ANIMATIONS_PER_HOUR, request, caller)))
    return fail(429, "too many animations");
  const body = await readBody(request);
  const data = cleanAnimation(body?.data);
  if (!data) return fail(400, "invalid animation");
  const { stored, token } = await ownership(caller);
  const animation = {
    id: newId(),
    author: cleanText(body.author, MAX_NAME) || "anonymous",
    ...data,
    running: true,
    startedAt: Date.now(),
    ...stored,
  };
  const { meta } = await insertAnimation(env, floorId, animation).run();
  if (!meta.changes) return fail(409, "too many animations on this floor");
  return json(
    { animation: publicAnimation(animation, caller), editToken: token, now: Date.now() },
    201,
  );
}

const findAnimation = async (env, floorId, id) => {
  const row = await env.DB.prepare(
    "SELECT data, owner_id, token_hash FROM animations WHERE floor_id = ? AND id = ?",
  )
    .bind(floorId, id)
    .first();
  return row && fromRow(row);
};

// PATCH { running } restarts (from the beginning) or stops; PATCH { data }
// replaces the movement (same format as on creation) and restarts it if it
// runs; DELETE removes.
async function editAnimation(env, floorId, id, request, caller) {
  const animation = await findAnimation(env, floorId, id);
  if (!animation) return fail(404, "not found");
  if (!(await canEdit(animation, caller))) return fail(403, "forbidden");
  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM animations WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }
  const body = await readBody(request);
  const data = body?.data === undefined ? null : cleanAnimation(body.data);
  if (body?.data !== undefined && !data) return fail(400, "invalid animation");
  if (!data && typeof body?.running !== "boolean") return fail(400, "invalid change");
  if (data) Object.assign(animation, data, { startedAt: Date.now() });
  if (typeof body.running === "boolean") {
    animation.running = body.running;
    if (body.running) animation.startedAt = Date.now();
  }
  const { tokenHash, ownerId, ...stored } = animation;
  await env.DB.prepare("UPDATE animations SET data = ? WHERE id = ?")
    .bind(JSON.stringify(stored), id)
    .run();
  return json({ animation: publicAnimation(animation, caller), now: Date.now() });
}

// Ids of the animations handed to the caller's account.
export async function claimAnimations(env, claims, caller) {
  const claimed = [];
  const valid = claims.filter((a) => UUID_RE.test(a?.floorId || "") && ID_RE.test(a.id || ""));
  for (const { floorId, id, token } of valid) {
    const animation = await findAnimation(env, floorId, id);
    const owned = animation && (await handOver(animation, token, caller));
    if (!owned) continue;
    await env.DB.prepare("UPDATE animations SET owner_id = ?, token_hash = NULL WHERE id = ?")
      .bind(owned.ownerId, id)
      .run();
    claimed.push(id);
  }
  return claimed;
}

export function routeAnimations(request, env, floorId, id, url, caller) {
  if (!UUID_RE.test(floorId || "")) return fail(404, "not found");
  if (id === undefined || id === "") {
    if (request.method === "GET") return listAnimations(env, floorId, url, request, caller);
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

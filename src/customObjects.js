// Custom objects: images the mod draws on a Gather floor for everyone who has
// it, free (position, size, layer, collision) or over a real object (skin).
// Images come from an https URL or are uploaded to the hub (/images). Only
// signed-in accounts create; the owner and the admin edit and delete.
import { canEdit, isMine, ownerOf, withinRateLimit } from "./accounts.js";
import {
  cleanText,
  CORS,
  fail,
  ID_RE,
  inRange,
  json,
  MAX_NAME,
  newId,
  readBody,
  UUID_RE,
} from "./common.js";

const MAX_PER_FLOOR = 100;
const CREATES_PER_HOUR = 30;
const UPLOADS_PER_HOUR = 20;
const MAX_URL = 500;
const MAX_TILES = 30;
const MAX_COORD = 1_000_000;
const MAX_IMAGE_BYTES = 512 * 1024;
const LAYERS = ["floor", "sorted", "above"];
const PLANE_RELATIONS = ["front", "behind"];
const HUB_IMAGE_RE = /^\/images\/\d{13}[0-9a-f]{8}$/;
// The first bytes of each accepted format, so nothing else is ever served.
const IMAGE_TYPES = {
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/gif": [0x47, 0x49, 0x46, 0x38],
  "image/webp": [0x52, 0x49, 0x46, 0x46],
};

// A real object, as a stable reference (see animations).
function cleanRef(o) {
  return UUID_RE.test(o?.hash || "") &&
    UUID_RE.test(o.variant || "") &&
    inRange(o.x, -MAX_COORD, MAX_COORD) &&
    inRange(o.y, -MAX_COORD, MAX_COORD)
    ? { hash: o.hash, variant: o.variant, x: o.x, y: o.y }
    : null;
}

// An https image, or one uploaded to this hub ("/images/<id>").
function cleanImageUrl(url) {
  if (typeof url !== "string" || url.length > MAX_URL) return null;
  if (HUB_IMAGE_RE.test(url)) return url;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// Draw order chosen by the user: just in front of or just behind a real
// object (a stable reference). Without it, the layer or the restyled object
// decides.
function cleanPlane(p) {
  if (p === undefined) return {};
  const object = cleanRef(p?.object);
  return PLANE_RELATIONS.includes(p?.relation) && object
    ? { plane: { relation: p.relation, object } }
    : null;
}

// Free objects are placed in tiles: top-left corner, size, layer (under
// everything, sorted with avatars and objects by the `base` line, or above
// everything), and whether the tiles under the base line block avatars.
function cleanCustomObject(o) {
  const name = cleanText(o?.name, MAX_NAME);
  const imageUrl = cleanImageUrl(o?.imageUrl);
  const plane = cleanPlane(o?.plane);
  if (!name || !imageUrl || !plane || !inRange(o.opacity, 0.1, 1)) return null;
  const common = { name, imageUrl, opacity: o.opacity, ...plane };
  if (o.mode === "skin") {
    const object = cleanRef(o.skin?.object);
    return object ? { ...common, mode: "skin", skin: { object } } : null;
  }
  const f = o.free;
  if (
    o.mode !== "free" ||
    !inRange(f?.x, -MAX_COORD, MAX_COORD) ||
    !inRange(f.y, -MAX_COORD, MAX_COORD) ||
    !inRange(f.width, 0.25, MAX_TILES) ||
    !inRange(f.height, 0.25, MAX_TILES) ||
    !LAYERS.includes(f.layer) ||
    !inRange(f.base, 0, f.height) ||
    typeof f.collision !== "boolean"
  )
    return null;
  const { x, y, width, height, layer, base, collision } = f;
  return { ...common, mode: "free", free: { x, y, width, height, layer, base, collision } };
}

const fromRow = (row) => ({ ...JSON.parse(row.data), ...ownerOf(row) });
const publicObject = ({ ownerId, tokenHash, ...o }, caller) => ({
  ...o,
  mine: isMine({ ownerId }, caller),
});

async function listObjects(env, floorId, caller) {
  const { results } = await env.DB.prepare(
    "SELECT data, owner_id FROM custom_objects WHERE floor_id = ? ORDER BY rowid",
  )
    .bind(floorId)
    .all();
  return json({ items: results.map((r) => publicObject(fromRow(r), caller)) });
}

async function createObject(env, floorId, request, caller) {
  if (!caller.accountId) return fail(401, "sign in required");
  if (!(await withinRateLimit(env, "rlo", CREATES_PER_HOUR, request, caller)))
    return fail(429, "too many custom objects");
  const body = await readBody(request);
  const data = cleanCustomObject(body?.data);
  if (!data) return fail(400, "invalid custom object");
  const object = {
    id: newId(),
    author: cleanText(body.author, MAX_NAME) || "anonymous",
    ...data,
  };
  const { meta } = await env.DB.prepare(
    `INSERT INTO custom_objects (id, floor_id, data, owner_id)
     SELECT ?1, ?2, ?3, ?4
     WHERE (SELECT count(*) FROM custom_objects WHERE floor_id = ?2) < ?5`,
  )
    .bind(object.id, floorId, JSON.stringify(object), caller.accountId, MAX_PER_FLOOR)
    .run();
  if (!meta.changes) return fail(409, "too many custom objects on this floor");
  return json({ object: { ...object, mine: true } }, 201);
}

// PATCH { data } replaces it (same format as on creation); DELETE removes it.
async function editObject(env, floorId, id, request, caller) {
  const row = await env.DB.prepare(
    "SELECT data, owner_id FROM custom_objects WHERE floor_id = ? AND id = ?",
  )
    .bind(floorId, id)
    .first();
  if (!row) return fail(404, "not found");
  const object = fromRow(row);
  if (!(await canEdit(object, caller))) return fail(403, "forbidden");
  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM custom_objects WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }
  const body = await readBody(request);
  const data = cleanCustomObject(body?.data);
  if (!data) return fail(400, "invalid custom object");
  const { ownerId, tokenHash, free, skin, plane, ...kept } = object;
  const updated = { ...kept, ...data };
  await env.DB.prepare("UPDATE custom_objects SET data = ? WHERE id = ?")
    .bind(JSON.stringify(updated), id)
    .run();
  return json({ object: publicObject({ ...updated, ownerId }, caller) });
}

export function routeCustomObjects(request, env, floorId, id, caller) {
  if (!UUID_RE.test(floorId || "")) return fail(404, "not found");
  if (id === undefined || id === "") {
    if (request.method === "GET") return listObjects(env, floorId, caller);
    if (request.method === "POST") return createObject(env, floorId, request, caller);
    return fail(405, "method not allowed");
  }
  if (!ID_RE.test(id)) return fail(404, "not found");
  if (request.method === "PATCH" || request.method === "DELETE")
    return editObject(env, floorId, id, request, caller);
  return fail(405, "method not allowed");
}

// ===================
// Images
// ===================
async function uploadImage(env, request, caller) {
  if (!caller.accountId) return fail(401, "sign in required");
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim();
  const magic = IMAGE_TYPES[type];
  if (!magic) return fail(415, "png, jpeg, gif or webp only");
  if (Number(request.headers.get("Content-Length")) > MAX_IMAGE_BYTES)
    return fail(413, "image too large (512 KB max)");
  if (!(await withinRateLimit(env, "rlu", UPLOADS_PER_HOUR, request, caller)))
    return fail(429, "too many uploads");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) return fail(413, "image too large (512 KB max)");
  if (!magic.every((b, i) => bytes[i] === b)) return fail(415, "not a " + type + " file");
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO images (id, content_type, data, owner_id, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, type, bytes, caller.accountId, new Date().toISOString())
    .run();
  return json({ url: `/images/${id}` }, 201);
}

async function serveImage(env, id) {
  const row = await env.DB.prepare("SELECT content_type, data FROM images WHERE id = ?")
    .bind(id)
    .first();
  if (!row) return fail(404, "not found");
  return new Response(new Uint8Array(row.data), {
    headers: {
      ...CORS,
      "Content-Type": row.content_type,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function deleteImage(env, id, caller) {
  const row = await env.DB.prepare("SELECT owner_id FROM images WHERE id = ?").bind(id).first();
  if (!row) return fail(404, "not found");
  if (!(await canEdit(ownerOf(row), caller))) return fail(403, "forbidden");
  await env.DB.prepare("DELETE FROM images WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// GET /images/:id is public (the mod loads it like any image); upload and
// delete need a session (or the admin token to delete).
export function routeImages(request, env, id, caller) {
  if (id === undefined && request.method === "POST") return uploadImage(env, request, caller);
  if (!ID_RE.test(id || "")) return fail(404, "not found");
  if (request.method === "GET") return serveImage(env, id);
  if (request.method === "DELETE") return deleteImage(env, id, caller);
  return fail(405, "method not allowed");
}

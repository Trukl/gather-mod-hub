// Shared presets: outfits, desks and constructions.
import { canEdit, handOver, isMine, ownerOf, ownership, withinRateLimit } from "./accounts.js";
import { cleanText, fail, ID_RE, json, MAX_NAME, newId, readBody, UUID_RE } from "./common.js";

export const TYPES = ["outfit", "desk", "construction"];
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
const MAX_SUMMARY = 300;
const MAX_META_SUMMARY = 150;
const MAX_DESK_OBJECTS = 200;
const MAX_DESK_DEPTH = 5;
const MAX_DESK_OFFSET = 100;
const MAX_DESK_AREA = 50;
const PUBLISH_PER_HOUR = 20;
const LIST_LIMIT = 100;

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
    !UUID_RE.test(i?.variant || "") ||
    !Number.isFinite(i.x) ||
    !Number.isFinite(i.y) ||
    Math.abs(i.x) > MAX_DESK_OFFSET ||
    Math.abs(i.y) > MAX_DESK_OFFSET ||
    !Array.isArray(i.children)
  )
    return null;
  const children = i.children.map((c) => cleanDeskItem(c, depth + 1, counter));
  if (children.includes(null)) return null;
  const name = typeof i.name === "string" ? i.name.slice(0, MAX_NAME) : "?";
  return { variant: i.variant, name, x: i.x, y: i.y, children };
}

function cleanDeskArea(a) {
  const valid = (n) => Number.isFinite(n) && n > 0 && n <= MAX_DESK_AREA;
  return valid(a?.width) && valid(a?.height) ? { width: a.width, height: a.height } : null;
}

function cleanDesk(p) {
  const name = cleanText(p?.name, MAX_NAME);
  if (!name || !Array.isArray(p.items) || !p.items.length) return null;
  const counter = { n: 0 };
  const items = p.items.map((i) => cleanDeskItem(i, 1, counter));
  if (items.includes(null)) return null;
  const area = cleanDeskArea(p.area);
  return area ? { name, items, area } : { name, items };
}

function cleanConstruction(p) {
  const desk = cleanDesk(p);
  return desk && { name: desk.name, items: desk.items };
}

const CLEANERS = { outfit: cleanOutfit, desk: cleanDesk, construction: cleanConstruction };
const summaryOf = (type, preset) =>
  type === "outfit" ? preset.summary : preset.items.map((i) => i.name).join(", ");
export const presetSearch = ({ name, author, summary }) =>
  `${name} ${author} ${summary}`.toLowerCase();

async function listPresets(env, type, url, caller) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const { results } = await env.DB.prepare(
    `SELECT id, name, author, summary, created_at, data, owner_id FROM presets
     WHERE type = ?1 AND instr(search, ?2) > 0 ORDER BY id LIMIT ?3`,
  )
    .bind(type, q, LIST_LIMIT)
    .all();
  return json({
    items: results.map((p) => ({
      id: p.id,
      type,
      name: p.name,
      author: p.author,
      summary: p.summary,
      createdAt: p.created_at,
      data: JSON.parse(p.data),
      mine: isMine(ownerOf(p), caller),
    })),
  });
}

async function publishPreset(env, type, request, caller) {
  if (!(await withinRateLimit(env, "rl", PUBLISH_PER_HOUR, request, caller)))
    return fail(429, "too many publishes");
  const body = await readBody(request);
  if (!body) return fail(400, "invalid json or too large");
  const data = CLEANERS[type](body.data);
  if (!data) return fail(400, "invalid preset");
  const id = newId();
  const meta = {
    name: data.name,
    author: cleanText(body.author, MAX_NAME) || "anonymous",
    summary: summaryOf(type, data).slice(0, MAX_META_SUMMARY),
  };
  const { stored, token } = await ownership(caller);
  await env.DB.prepare(
    `INSERT INTO presets (id, type, name, author, summary, search, created_at, data, owner_id, token_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      type,
      meta.name,
      meta.author,
      meta.summary,
      presetSearch(meta),
      new Date().toISOString(),
      JSON.stringify(data),
      stored.ownerId ?? null,
      stored.tokenHash ?? null,
    )
    .run();
  return json({ id, type, deleteToken: token }, 201);
}

const findPreset = (env, type, id) =>
  env.DB.prepare("SELECT owner_id, token_hash FROM presets WHERE type = ? AND id = ?")
    .bind(type, id)
    .first();

async function deletePreset(env, type, id, caller) {
  const row = await findPreset(env, type, id);
  if (!row) return fail(404, "not found");
  if (!(await canEdit(ownerOf(row), caller))) return fail(403, "forbidden");
  await env.DB.prepare("DELETE FROM presets WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// Ids of the presets handed to the caller's account.
export async function claimPresets(env, claims, caller) {
  const claimed = [];
  for (const { type, id, token } of claims) {
    if (!TYPES.includes(type) || !ID_RE.test(id || "")) continue;
    const row = await findPreset(env, type, id);
    const owned = row && (await handOver(ownerOf(row), token, caller));
    if (!owned) continue;
    await env.DB.prepare("UPDATE presets SET owner_id = ?, token_hash = NULL WHERE id = ?")
      .bind(owned.ownerId, id)
      .run();
    claimed.push(id);
  }
  return claimed;
}

export function routePresets(request, env, type, id, url, caller) {
  if (!TYPES.includes(type)) return fail(404, "not found");
  if (id === undefined || id === "") {
    if (request.method === "GET") return listPresets(env, type, url, caller);
    if (request.method === "POST") return publishPreset(env, type, request, caller);
    return fail(405, "method not allowed");
  }
  if (!ID_RE.test(id)) return fail(404, "not found");
  if (request.method === "DELETE") return deletePreset(env, type, id, caller);
  return fail(405, "method not allowed");
}

// Shared HTTP helpers and validation primitives.
const ALLOWED_ORIGIN = "https://app.v2.gather.town";
const MAX_BODY_CHARS = 64 * 1024;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Item ids sort newest first: reversed timestamp, then random hex.
export const ID_RE = /^\d{13}[0-9a-f]{8}$/;
export const MAX_NAME = 40;
const MODULE_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const MAX_MODULES = 40;

// `{ moduleId: "x.y.z" }` with 1 to 40 entries, null when invalid.
export function cleanModuleVersions(versions) {
  if (!versions || typeof versions !== "object" || Array.isArray(versions)) return null;
  const entries = Object.entries(versions);
  if (!entries.length || entries.length > MAX_MODULES) return null;
  const valid = entries.every(
    ([id, v]) => MODULE_ID_RE.test(id) && typeof v === "string" && VERSION_RE.test(v),
  );
  return valid ? Object.fromEntries(entries) : null;
}

export const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Gather-Mods",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
export const fail = (status, error) => json({ error }, status);

// Parsed JSON body, null when invalid or too large.
export async function readBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
export const bearer = (request) =>
  (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");

export function cleanText(v, max) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
}
export const inRange = (v, min, max) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

export async function sha256(s) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const newId = () =>
  String(1e13 - Date.now()).padStart(13, "0") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);

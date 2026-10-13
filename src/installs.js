// Install reports: the mod's core sends, on first install and after each
// update, a random install id, the installed module versions and its Gather ID
// token (verified, only the account id is kept). Admins read the totals.
import { verifyGatherToken } from "./auth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const MAX_MODULES = 40;
const REPORTS_PER_HOUR = 30;
const ACTIVE_DAYS = 30;
const DAY_MS = 86_400_000;

function cleanVersions(versions) {
  if (!versions || typeof versions !== "object" || Array.isArray(versions)) return null;
  const entries = Object.entries(versions);
  if (!entries.length || entries.length > MAX_MODULES) return null;
  const valid = entries.every(
    ([id, v]) => MODULE_ID_RE.test(id) && typeof v === "string" && VERSION_RE.test(v),
  );
  return valid && versions.core ? Object.fromEntries(entries) : null;
}

export async function reportInstall(env, body, json, fail) {
  const versions = cleanVersions(body?.versions);
  if (!UUID_RE.test(body?.installId || "") || !versions || typeof body.launcher !== "boolean")
    return fail(400, "invalid report");
  const accountId = await verifyGatherToken(body.gatherToken);
  if (!accountId) return fail(401, "invalid Gather token");
  const rateKey = `rli:${accountId}:${Math.floor(Date.now() / 3_600_000)}`;
  const count = Number(await env.PRESETS.get(rateKey)) || 0;
  if (count >= REPORTS_PER_HOUR) return fail(429, "too many reports");
  const key = `i:${body.installId}`;
  const previous = await env.PRESETS.get(key, "json");
  const now = new Date().toISOString();
  const install = {
    accountId,
    launcher: body.launcher,
    versions,
    firstSeen: previous?.firstSeen ?? now,
    updatedAt: now,
  };
  // Kept in the key's metadata so the stats only list keys, without reading them.
  await env.PRESETS.put(key, JSON.stringify(install), { metadata: install });
  await env.PRESETS.put(rateKey, String(count + 1), { expirationTtl: 3600 });
  return json({ ok: true });
}

export async function installStats(env, json) {
  const installs = [];
  let cursor;
  do {
    const page = await env.PRESETS.list({ prefix: "i:", cursor });
    for (const key of page.keys)
      if (key.metadata) installs.push({ installId: key.name.slice(2), ...key.metadata });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const modules = {};
  for (const { versions } of installs)
    for (const [id, version] of Object.entries(versions)) {
      modules[id] ??= {};
      modules[id][version] = (modules[id][version] ?? 0) + 1;
    }
  const activeSince = Date.now() - ACTIVE_DAYS * DAY_MS;
  return json({
    installs: installs.length,
    accounts: new Set(installs.map((i) => i.accountId)).size,
    launcher: installs.filter((i) => i.launcher).length,
    updatedLast30Days: installs.filter((i) => Date.parse(i.updatedAt) >= activeSince).length,
    modules,
    items: installs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  });
}

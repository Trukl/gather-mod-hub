// Install reports: the mod's core sends, on first install and after each
// update, a random install id, the installed module versions and its Gather ID
// token (verified, only the account id is kept). Admins read the totals.
import { withinRateLimit } from "./accounts.js";
import { verifyGatherToken } from "./auth.js";
import { cleanModuleVersions, fail, json, readBody, UUID_RE } from "./common.js";

const REPORTS_PER_HOUR = 30;
const ACTIVE_DAYS = 30;
const DAY_MS = 86_400_000;

function cleanVersions(versions) {
  const clean = cleanModuleVersions(versions);
  return clean?.core ? clean : null;
}

export async function reportInstall(env, request) {
  const body = await readBody(request);
  const versions = cleanVersions(body?.versions);
  if (!UUID_RE.test(body?.installId || "") || !versions || typeof body.launcher !== "boolean")
    return fail(400, "invalid report");
  const accountId = await verifyGatherToken(body.gatherToken);
  if (!accountId) return fail(401, "invalid Gather token");
  if (!(await withinRateLimit(env, "rli", REPORTS_PER_HOUR, request, { accountId })))
    return fail(429, "too many reports");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO installs (install_id, account_id, launcher, versions, first_seen, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT (install_id) DO UPDATE SET account_id = excluded.account_id,
       launcher = excluded.launcher, versions = excluded.versions, updated_at = excluded.updated_at`,
  )
    .bind(body.installId, accountId, body.launcher ? 1 : 0, JSON.stringify(versions), now)
    .run();
  return json({ ok: true });
}

export async function installStats(env) {
  const { results } = await env.DB.prepare("SELECT * FROM installs ORDER BY updated_at DESC").all();
  const installs = results.map((i) => ({
    installId: i.install_id,
    accountId: i.account_id,
    launcher: i.launcher === 1,
    versions: JSON.parse(i.versions),
    firstSeen: i.first_seen,
    updatedAt: i.updated_at,
  }));
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
    items: installs,
  });
}

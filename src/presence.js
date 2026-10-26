// Presence: while it runs, the mod's core pings every 2 minutes with its hub
// session (cores before 1.8.0: its Gather ID token, verified; only the account
// id is kept, with the time) and the account ids of the players it sees. The answer lists those that ran the mod
// in the last 5 minutes, so the mod can mark them. `hidden` deletes the
// caller's row instead: it still sees the others.
import { accountOf, withinRateLimit } from "./accounts.js";
import { fail, json, readBody, UUID_RE } from "./common.js";

const ACTIVE_MS = 5 * 60_000;
const MAX_ACCOUNTS = 500;
const PINGS_PER_HOUR = 150;

export async function presence(env, request) {
  const body = await readBody(request);
  const accounts = body?.accounts;
  if (
    !Array.isArray(accounts) ||
    accounts.length > MAX_ACCOUNTS ||
    !accounts.every((a) => UUID_RE.test(a)) ||
    typeof body.hidden !== "boolean"
  )
    return fail(400, "invalid presence");
  const accountId = await accountOf(env, request, body);
  if (!accountId) return fail(401, "sign in required");
  if (!(await withinRateLimit(env, "prs", PINGS_PER_HOUR, request, { accountId })))
    return fail(429, "too many pings");
  const now = Date.now();
  await (
    body.hidden
      ? env.DB.prepare("DELETE FROM presence WHERE account_id = ?").bind(accountId)
      : env.DB.prepare(
          `INSERT INTO presence (account_id, seen_at) VALUES (?1, ?2)
           ON CONFLICT (account_id) DO UPDATE SET seen_at = excluded.seen_at`,
        ).bind(accountId, new Date(now).toISOString())
  ).run();
  // One bound parameter for the whole list: D1 allows 100 per query.
  const { results } = await env.DB.prepare(
    `SELECT account_id FROM presence
     WHERE seen_at > ? AND account_id IN (SELECT value FROM json_each(?))`,
  )
    .bind(new Date(now - ACTIVE_MS).toISOString(), JSON.stringify(accounts))
    .all();
  return json({ active: results.map((r) => r.account_id) });
}

// Who is calling, what they own, and how often they may write.
import { createSession, sessionAccount, verifyGatherToken } from "./auth.js";
import { bearer, fail, json, readBody, sha256 } from "./common.js";

// The bearer is a hub session (signed in with Gather), the admin token, or the
// per-item token handed out to mods that don't sign in yet.
export async function callerOf(env, request) {
  const token = bearer(request);
  return {
    token,
    accountId: await sessionAccount(env, token),
    isAdmin: Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN,
  };
}

export async function signIn(env, request) {
  const body = await readBody(request);
  const accountId = await verifyGatherToken(body?.gatherToken);
  if (!accountId) return fail(401, "invalid Gather token");
  return json(await createSession(env, accountId));
}

export const isMine = (item, caller) =>
  Boolean(caller.accountId) && item.ownerId === caller.accountId;

const provesToken = async (item, token) =>
  typeof token === "string" && Boolean(item.tokenHash) && (await sha256(token)) === item.tokenHash;

export async function canEdit(item, caller) {
  if (caller.isAdmin) return true;
  if (caller.accountId) return item.ownerId === caller.accountId;
  return provesToken(item, caller.token);
}

// Items created while signed in belong to the account; the others get a token.
export async function ownership(caller) {
  if (caller.accountId) return { stored: { ownerId: caller.accountId }, token: undefined };
  const token = crypto.randomUUID();
  return { stored: { tokenHash: await sha256(token) }, token };
}

// Hands an item created with a token to the account, if the token matches.
export async function handOver(item, token, caller) {
  if (!(await provesToken(item, token))) return null;
  const { tokenHash, ...rest } = item;
  return { ...rest, ownerId: caller.accountId };
}

// Owner columns of a stored row, in the shape the helpers above expect.
export const ownerOf = (row) => ({
  ownerId: row.owner_id ?? undefined,
  tokenHash: row.token_hash ?? undefined,
});

// Counts one write for the hour; false once the limit is reached. Per Gather
// account, or per IP for clients not signed in. Past hours are dropped.
export async function withinRateLimit(env, prefix, limit, request, caller) {
  const who = caller.accountId
    ? "acc:" + caller.accountId
    : request.headers.get("CF-Connecting-IP") || "unknown";
  const hour = Math.floor(Date.now() / 3_600_000);
  const [, counted] = await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_limits WHERE hour < ?").bind(hour),
    env.DB.prepare(
      `INSERT INTO rate_limits (key, hour, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key, hour) DO UPDATE SET count = count + 1 RETURNING count`,
    ).bind(`${prefix}:${who}`, hour),
  ]);
  return counted.results[0].count <= limit;
}

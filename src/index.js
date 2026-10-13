// Community hub of the Gather Mod Menu: routes. See README.md for the API.
import { callerOf, signIn } from "./accounts.js";
import { claimAnimations, routeAnimations } from "./animations.js";
import { CORS, fail, json, readBody } from "./common.js";
import { installStats, reportInstall } from "./installs.js";
import { claimPresets, routePresets } from "./presets.js";
import { updateRequired } from "./versions.js";

// Mods older than Community hub 1.1.0 / Fun 1.3.0 don't sign in: they are
// served until this date, then every route but sign-in requires a session.
const SIGN_IN_REQUIRED_FROM = Date.parse("2026-10-20T16:30:00Z");
const MAX_CLAIMS = 200;

// Hands the items created with per-item tokens to the signed-in account.
async function claim(env, request, caller) {
  if (!caller.accountId) return fail(401, "sign in required");
  const body = await readBody(request);
  const presets = Array.isArray(body?.presets) ? body.presets : [];
  const animations = Array.isArray(body?.animations) ? body.animations : [];
  if (presets.length + animations.length > MAX_CLAIMS) return fail(413, "too many claims");
  return json({
    claimed: [
      ...(await claimPresets(env, presets, caller)),
      ...(await claimAnimations(env, animations, caller)),
    ],
  });
}

async function route(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  const [, root, type, id, extra] = url.pathname.split("/");
  if (extra !== undefined) return fail(404, "not found");
  const post = request.method === "POST";
  if (root === "installs" && type === undefined && post) return reportInstall(env, request);
  const outdated = await updateRequired(env, request);
  if (outdated) return outdated;
  if (root === "auth" && type === undefined && post) return signIn(env, request);

  const caller = await callerOf(env, request);
  if (root === "auth" && type === "claim" && id === undefined && post)
    return claim(env, request, caller);
  if (!caller.accountId && !caller.isAdmin && Date.now() >= SIGN_IN_REQUIRED_FROM)
    return fail(401, "sign in required");
  if (root === "stats" && type === undefined && request.method === "GET")
    return caller.isAdmin ? installStats(env) : fail(403, "forbidden");
  if (root === "animations") return routeAnimations(request, env, type, id, url, caller);
  if (root === "presets") return routePresets(request, env, type, id, url, caller);
  return fail(404, "not found");
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

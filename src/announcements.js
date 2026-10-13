// Announcements: messages from the hub admin (maintenance, incident…) that the
// mod shows once in a window, then in its panel until they expire.
import { cleanText, fail, ID_RE, inRange, json, newId, readBody } from "./common.js";

const KEY = "announcements";
const LEVELS = ["info", "warning"];
const MAX_TITLE = 60;
const MAX_MESSAGE = 500;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 30 * 24;
const HOUR_MS = 3_600_000;

async function activeAnnouncements(env) {
  const now = Date.now();
  return ((await env.PRESETS.get(KEY, "json")) ?? []).filter((a) => Date.parse(a.expiresAt) > now);
}

export async function routeAnnouncements(request, env, id, caller) {
  const list = await activeAnnouncements(env);
  if (request.method === "GET" && id === undefined) return json({ announcements: list });
  if (!caller.isAdmin) return fail(403, "forbidden");
  if (request.method === "POST" && id === undefined) {
    const body = await readBody(request);
    const title = cleanText(body?.title, MAX_TITLE);
    const message = cleanText(body?.message, MAX_MESSAGE);
    const level = body?.level ?? "info";
    const hours = body?.hours ?? DEFAULT_HOURS;
    if (!title || !message || !LEVELS.includes(level) || !inRange(hours, 0.05, MAX_HOURS))
      return fail(400, "invalid announcement");
    const now = Date.now();
    const announcement = {
      id: newId(),
      title,
      message,
      level,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + hours * HOUR_MS).toISOString(),
    };
    await env.PRESETS.put(KEY, JSON.stringify([announcement, ...list]));
    return json({ announcement });
  }
  if (request.method === "DELETE" && ID_RE.test(id ?? "")) {
    const rest = list.filter((a) => a.id !== id);
    if (rest.length === list.length) return fail(404, "not found");
    await env.PRESETS.put(KEY, JSON.stringify(rest));
    return json({ deleted: id });
  }
  return fail(404, "not found");
}

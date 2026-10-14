// Announcements: messages from the hub admin (maintenance, incident, new
// feature) that the mod shows once in a window, then in its panel until they
// expire. One with `outdated` only goes to mods running one of those modules
// below the given version; the admin sees them all.
import {
  cleanModuleVersions,
  cleanText,
  fail,
  ID_RE,
  inRange,
  json,
  newId,
  readBody,
} from "./common.js";
import { isNewerVersion, runningVersions } from "./versions.js";

const LEVELS = ["info", "warning"];
const MAX_TITLE = 60;
const MAX_MESSAGE = 500;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 30 * 24;
const HOUR_MS = 3_600_000;

function isFor(announcement, running) {
  if (!announcement.outdated) return true;
  return Object.entries(announcement.outdated).some(([module, version]) => {
    const current = running?.get(module);
    return current && isNewerVersion(version, current);
  });
}

export async function routeAnnouncements(request, env, id, caller) {
  const now = new Date().toISOString();
  if (request.method === "GET" && id === undefined) {
    const { results } = await env.DB.prepare(
      `SELECT id, title, message, level, created_at, expires_at, outdated
       FROM announcements WHERE expires_at > ? ORDER BY id`,
    )
      .bind(now)
      .all();
    const running = runningVersions(request);
    const announcements = results
      .map((a) => ({
        id: a.id,
        title: a.title,
        message: a.message,
        level: a.level,
        createdAt: a.created_at,
        expiresAt: a.expires_at,
        ...(a.outdated && { outdated: JSON.parse(a.outdated) }),
      }))
      .filter((a) => caller.isAdmin || isFor(a, running));
    return json({ announcements });
  }
  if (!caller.isAdmin) return fail(403, "forbidden");
  if (request.method === "POST" && id === undefined) {
    const body = await readBody(request);
    const title = cleanText(body?.title, MAX_TITLE);
    const message = cleanText(body?.message, MAX_MESSAGE);
    const level = body?.level ?? "info";
    const hours = body?.hours ?? DEFAULT_HOURS;
    const outdated = body?.outdated === undefined ? null : cleanModuleVersions(body.outdated);
    if (
      !title ||
      !message ||
      !LEVELS.includes(level) ||
      !inRange(hours, 0.05, MAX_HOURS) ||
      (body.outdated !== undefined && !outdated)
    )
      return fail(400, "invalid announcement");
    const announcement = {
      id: newId(),
      title,
      message,
      level,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + hours * HOUR_MS).toISOString(),
      ...(outdated && { outdated }),
    };
    const { createdAt, expiresAt } = announcement;
    await env.DB.prepare(
      `INSERT INTO announcements (id, title, message, level, created_at, expires_at, outdated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        announcement.id,
        title,
        message,
        level,
        createdAt,
        expiresAt,
        outdated && JSON.stringify(outdated),
      )
      .run();
    return json({ announcement });
  }
  if (request.method === "DELETE" && ID_RE.test(id ?? "")) {
    const { meta } = await env.DB.prepare(
      "DELETE FROM announcements WHERE id = ? AND expires_at > ?",
    )
      .bind(id, now)
      .run();
    if (!meta.changes) return fail(404, "not found");
    return json({ deleted: id });
  }
  return fail(404, "not found");
}

// Required updates: the mod sends the versions of its running modules in the
// X-Gather-Mods header ("core=1.4.0,hub-api=1.3.0"). A changelog entry marked
// `breaking` in the published catalog is the minimum version of its module:
// below it, the request gets a 426 with the breaking entries it misses.
// Mods older than Core 1.4.0 don't send the header and are not checked.
import { json } from "./common.js";

const VERSIONS_HEADER = "X-Gather-Mods";
// Written by the release worker of the mod (gather-mod-menu-updates).
const CATALOG_KEY = "catalog:latest";
const CATALOG_CACHE_S = 300;

const parseVersion = (v) => v.split(".").map((n) => Number(n) || 0);
function isNewerVersion(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

export async function updateRequired(env, request) {
  const header = request.headers.get(VERSIONS_HEADER);
  if (!header) return null;
  const running = new Map(header.split(",").map((pair) => pair.trim().split("=")));
  const release = await env.RELEASES.get(CATALOG_KEY, { type: "json", cacheTtl: CATALOG_CACHE_S });
  if (!release) return null;
  const modules = JSON.parse(release.manifest)
    .modules.map((m) => {
      const version = running.get(m.id);
      const changelog = version
        ? (m.changelog ?? []).filter((e) => e.breaking && isNewerVersion(e.version, version))
        : [];
      return { id: m.id, changelog };
    })
    .filter((m) => m.changelog.length);
  return modules.length ? json({ error: "update required", modules }, 426) : null;
}

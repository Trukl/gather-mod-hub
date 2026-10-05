export const HUB_URL = "https://gather-mods-hub.minnecorentin.workers.dev";

export const signedPayload = (version, code) =>
  Buffer.from(`${version}\n${code}`, "utf8");

const parseVersion = (v) => v.split(".").map((n) => Number(n) || 0);

export function isNewerVersion(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

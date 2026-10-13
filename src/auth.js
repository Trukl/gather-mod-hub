// Sign-in with the Gather account: the mod sends Gather's Firebase ID token
// once; it is verified against Google's public keys, only the Gather account
// id is kept (never the token nor the email), and a hub session is returned.
const GATHER_FIREBASE_PROJECT = "gather-town-v2";
const ISSUER = `https://securetoken.google.com/${GATHER_FIREBASE_PROJECT}`;
const GOOGLE_KEYS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const CLOCK_SKEW_S = 60;
const SESSION_PREFIX = "s1.";
const SESSION_MS = 30 * 24 * 3_600_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encoder = new TextEncoder();
const base64urlToBytes = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const bytesToBase64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const decodeJson = (s) => JSON.parse(new TextDecoder().decode(base64urlToBytes(s)));

let googleKeys = { keys: [], expiresAt: 0 };
async function googleKey(kid) {
  if (Date.now() >= googleKeys.expiresAt) {
    const res = await fetch(GOOGLE_KEYS_URL);
    if (!res.ok) throw new Error(`Google keys: HTTP ${res.status}`);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") || "")?.[1]);
    googleKeys = {
      keys: (await res.json()).keys,
      expiresAt: Date.now() + (maxAge || 3600) * 1000,
    };
  }
  return googleKeys.keys.find((k) => k.kid === kid);
}

// Gather account id of a valid Gather ID token, null otherwise.
export async function verifyGatherToken(token) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) return null;
  let header;
  let payload;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  const jwk = await googleKey(header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64urlToBytes(parts[2]),
    encoder.encode(`${parts[0]}.${parts[1]}`),
  );
  const now = Date.now() / 1000;
  const valid =
    signed &&
    payload.iss === ISSUER &&
    payload.aud === GATHER_FIREBASE_PROJECT &&
    payload.exp > now &&
    payload.iat <= now + CLOCK_SKEW_S &&
    typeof payload.sub === "string" &&
    payload.sub !== "";
  const accountId = payload.gather?.userAccountId;
  return valid && UUID_RE.test(accountId || "") ? accountId : null;
}

const hmacKey = (secret) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

// Stateless session: the account id and expiry, signed with SESSION_SECRET.
export async function createSession(env, accountId) {
  const expiresAt = Date.now() + SESSION_MS;
  const payload = bytesToBase64url(encoder.encode(JSON.stringify({ a: accountId, e: expiresAt })));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(env.SESSION_SECRET),
    encoder.encode(payload),
  );
  return {
    session: `${SESSION_PREFIX}${payload}.${bytesToBase64url(new Uint8Array(signature))}`,
    expiresAt,
  };
}

// Gather account id of a valid hub session, null otherwise.
export async function sessionAccount(env, token) {
  if (!token.startsWith(SESSION_PREFIX)) return null;
  const [payload, signature] = token.slice(SESSION_PREFIX.length).split(".");
  if (!payload || !signature) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(env.SESSION_SECRET),
      base64urlToBytes(signature),
      encoder.encode(payload),
    );
    const { a, e } = decodeJson(payload);
    return valid && e > Date.now() && UUID_RE.test(a) ? a : null;
  } catch {
    return null;
  }
}

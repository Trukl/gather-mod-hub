import { execFileSync } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HUB_URL,
  isNewerVersion,
  signedPayload,
} from "../launcher/mod-release.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOD_PATH =
  process.argv[2] ?? join(ROOT, "../gather-mod-menu/gather-mod-menu.js");
const PRIVATE_KEY_PATH = join(homedir(), ".config/gather-mods/release-key.pem");
const PUBLIC_KEY_PATH = join(ROOT, "launcher/mod-public-key.pem");

function loadReleaseKey() {
  if (!existsSync(PRIVATE_KEY_PATH)) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    mkdirSync(dirname(PRIVATE_KEY_PATH), { recursive: true });
    writeFileSync(
      PRIVATE_KEY_PATH,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    writeFileSync(
      PUBLIC_KEY_PATH,
      publicKey.export({ type: "spki", format: "pem" }),
    );
    console.log(`Generated release key: ${PRIVATE_KEY_PATH}`);
  }
  const key = createPrivateKey(readFileSync(PRIVATE_KEY_PATH));
  const publicPem = createPublicKey(key).export({
    type: "spki",
    format: "pem",
  });
  if (readFileSync(PUBLIC_KEY_PATH, "utf8") !== publicPem)
    throw new Error(`${PUBLIC_KEY_PATH} does not match ${PRIVATE_KEY_PATH}`);
  return key;
}

const code = readFileSync(MOD_PATH, "utf8");
const version = code.match(/const MOD_VERSION = "([^"]+)"/)?.[1];
if (!version) throw new Error(`No MOD_VERSION found in ${MOD_PATH}`);

const published = await fetch(`${HUB_URL}/mod/latest`).then((r) =>
  r.ok ? r.json() : null,
);
if (published && !isNewerVersion(version, published.version))
  throw new Error(
    `MOD_VERSION ${version} must be greater than the published ${published.version}`,
  );

const signature = sign(
  "sha256",
  signedPayload(version, code),
  loadReleaseKey(),
).toString("base64");
const releasePath = join(tmpdir(), `gather-mod-release-${version}.json`);
writeFileSync(
  releasePath,
  JSON.stringify({
    version,
    code,
    signature,
    publishedAt: new Date().toISOString(),
  }),
);
try {
  execFileSync(
    join(ROOT, "node_modules/.bin/wrangler"),
    [
      "kv",
      "key",
      "put",
      "mod:latest",
      "--path",
      releasePath,
      "--binding",
      "PRESETS",
      "--remote",
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
} finally {
  rmSync(releasePath, { force: true });
}
console.log(`Released mod ${version}`);

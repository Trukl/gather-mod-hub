#!/usr/bin/env node
// One-off copy of the hub's former KV storage into D1. Rows that already exist
// are kept, so it can run again to pick up writes made before the D1 deploy.
//   node scripts/migrate-kv-to-d1.mjs --local | --remote [other wrangler options]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presetSearch } from "../src/presets.js";

const KV_NAMESPACE_ID = "ecb47a392e434508af32023291cc2651";
const DATABASE = "gather-mods-hub";
const [mode, ...options] = process.argv.slice(2);
if (mode !== "--local" && mode !== "--remote") {
  console.error("usage: migrate-kv-to-d1.mjs --local | --remote [other wrangler options]");
  process.exit(1);
}

const wrangler = (...args) =>
  execFileSync("npx", ["wrangler", ...args, mode, ...options], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
const kvGet = (key) =>
  JSON.parse(wrangler("kv", "key", "get", key, "--namespace-id", KV_NAMESPACE_ID));

const sql = (v) =>
  v === null || v === undefined
    ? "NULL"
    : typeof v === "number"
      ? String(v)
      : `'${String(v).replaceAll("'", "''")}'`;
const insert = (table, row) =>
  `INSERT OR IGNORE INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(sql).join(", ")});`;

const statements = [];
const skipped = [];
const keys = JSON.parse(wrangler("kv", "key", "list", "--namespace-id", KV_NAMESPACE_ID));
for (const { name } of keys) {
  const [prefix, ...rest] = name.split(":");
  if (prefix === "p") {
    const [type, id] = rest;
    const { name: presetName, author, summary, createdAt, data, ownerId, tokenHash } = kvGet(name);
    statements.push(
      insert("presets", {
        id,
        type,
        name: presetName,
        author,
        summary,
        search: presetSearch({ name: presetName, author, summary }),
        created_at: createdAt,
        data: JSON.stringify(data),
        owner_id: ownerId,
        token_hash: tokenHash,
      }),
    );
  } else if (prefix === "af") {
    for (const { ownerId, tokenHash, ...animation } of kvGet(name))
      statements.push(
        insert("animations", {
          id: animation.id,
          floor_id: rest[0],
          data: JSON.stringify(animation),
          owner_id: ownerId,
          token_hash: tokenHash,
        }),
      );
  } else if (prefix === "a") {
    statements.push(
      insert("legacy_animations", { map_id: rest[0], items: JSON.stringify(kvGet(name)) }),
    );
  } else if (prefix === "i") {
    const { accountId, launcher, versions, firstSeen, updatedAt } = kvGet(name);
    statements.push(
      insert("installs", {
        install_id: rest[0],
        account_id: accountId,
        launcher: launcher ? 1 : 0,
        versions: JSON.stringify(versions),
        first_seen: firstSeen,
        updated_at: updatedAt,
      }),
    );
  } else if (name === "announcements") {
    for (const a of kvGet(name))
      statements.push(
        insert("announcements", {
          id: a.id,
          title: a.title,
          message: a.message,
          level: a.level,
          created_at: a.createdAt,
          expires_at: a.expiresAt,
        }),
      );
  } else skipped.push(name);
}

console.log(`${keys.length} KV keys, ${statements.length} rows to insert`);
if (skipped.length) console.log(`Not copied: ${skipped.join(", ")}`);
const file = join(mkdtempSync(join(tmpdir(), "hub-migration-")), "rows.sql");
writeFileSync(file, statements.join("\n"));
wrangler("d1", "execute", DATABASE, "--file", file, "--yes");
const counts = wrangler(
  "d1",
  "execute",
  DATABASE,
  "--json",
  "--command",
  ["presets", "animations", "legacy_animations", "installs", "announcements"]
    .map((t) => `SELECT '${t}' AS rows_in, count(*) AS n FROM ${t}`)
    .join(" UNION ALL "),
);
for (const { rows_in, n } of JSON.parse(counts)[0].results) console.log(`${rows_in}: ${n}`);

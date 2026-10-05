#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HUB_URL, isNewerVersion, signedPayload } from "./mod-release.mjs";

const APP_PATH = "/Applications/GatherV2.app";
const APP_PROCESS = "GatherV2";
const PORT = Number(process.env.GATHER_MODS_PORT) || 31337;
const DEBUGGER_URL = `http://127.0.0.1:${PORT}`;
const GATHER_PAGE_PREFIX = "https://app.v2.gather.town/";
const CACHE_DIR = join(homedir(), "Library/Caches/gather-mods");
const CACHE_PATH = join(CACHE_DIR, "mod-release.json");
const LOCK_PATH = join(CACHE_DIR, "launcher.pid");
const PUBLIC_KEY = createPublicKey(
  readFileSync(new URL("./mod-public-key.pem", import.meta.url)),
);
const TARGET_POLL_MS = 2000;
const UPDATE_CHECK_MS =
  Number(process.env.GATHER_MODS_UPDATE_CHECK_MS) || 15 * 60_000;
const MOD_HUB_URL = process.env.GATHER_MODS_HUB_URL || HUB_URL;

const log = (...args) => console.log(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isValidRelease(release) {
  return (
    typeof release?.version === "string" &&
    typeof release.code === "string" &&
    typeof release.signature === "string" &&
    verify(
      "sha256",
      signedPayload(release.version, release.code),
      PUBLIC_KEY,
      Buffer.from(release.signature, "base64"),
    )
  );
}

async function fetchRemoteRelease() {
  try {
    const res = await fetch(`${MOD_HUB_URL}/mod/latest`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const release = await res.json();
    if (!isValidRelease(release)) throw new Error("invalid signature");
    return release;
  } catch (e) {
    log("Remote mod release unavailable:", e.message);
    return null;
  }
}

function readCachedRelease() {
  try {
    const release = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    return isValidRelease(release) ? release : null;
  } catch {
    return null;
  }
}

async function loadRelease() {
  const cached = readCachedRelease();
  const remote = await fetchRemoteRelease();
  if (remote && !isNewerVersion(cached?.version ?? "0", remote.version)) {
    writeFileSync(CACHE_PATH, JSON.stringify(remote));
    return remote;
  }
  return cached;
}

async function isDebuggerUp() {
  try {
    const res = await fetch(`${DEBUGGER_URL}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const isGatherRunning = () =>
  spawnSync("pgrep", ["-x", APP_PROCESS]).status === 0;

async function startGatherWithDebugger() {
  if (await isDebuggerUp()) return;
  if (isGatherRunning()) {
    log("GatherV2 is running without the debug port, restarting it");
    execFileSync("osascript", ["-e", `quit app "${APP_PROCESS}"`]);
    for (let i = 0; i < 40 && isGatherRunning(); i++) await sleep(500);
    if (isGatherRunning()) throw new Error("GatherV2 did not quit");
  }
  execFileSync("open", [
    "-a",
    APP_PATH,
    "--args",
    `--remote-debugging-port=${PORT}`,
  ]);
  for (let i = 0; i < 120; i++) {
    if (await isDebuggerUp()) return;
    await sleep(500);
  }
  throw new Error("GatherV2 debug port did not open");
}

class CdpSession {
  #nextId = 1;
  #pending = new Map();

  constructor(webSocketUrl) {
    this.ws = new WebSocket(webSocketUrl);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.closed = new Promise((resolve) =>
      this.ws.addEventListener("close", resolve, { once: true }),
    );
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.closed.then(() => {
      for (const { reject } of this.#pending.values())
        reject(new Error("CDP connection closed"));
      this.#pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      this.#pending.set(id, { resolve, reject }),
    );
  }
}

const pageSource = (code) =>
  `if (window.top === window && location.href.startsWith(${JSON.stringify(GATHER_PAGE_PREFIX)})) {\n${code}\n}`;

let release = null;
const sessions = new Map();

async function injectInto(targetId) {
  const session = sessions.get(targetId);
  const source = pageSource(release.code);
  if (session.scriptId)
    await session.cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: session.scriptId,
    });
  const { identifier } = await session.cdp.send(
    "Page.addScriptToEvaluateOnNewDocument",
    { source },
  );
  session.scriptId = identifier;
  await session.cdp.send("Runtime.evaluate", { expression: source });
}

async function attach(target) {
  const cdp = new CdpSession(target.webSocketDebuggerUrl);
  sessions.set(target.id, { cdp, scriptId: null });
  try {
    await cdp.opened;
    await cdp.send("Page.enable");
    await injectInto(target.id);
    log(`Injected mod ${release.version} into ${target.url}`);
  } catch (e) {
    log("Injection failed:", e.message);
    sessions.delete(target.id);
    cdp.ws.close();
    return;
  }
  cdp.closed.then(() => sessions.delete(target.id));
}

async function watchGatherPages() {
  while (await isDebuggerUp()) {
    try {
      const targets = await (await fetch(`${DEBUGGER_URL}/json/list`)).json();
      for (const target of targets)
        if (
          target.type === "page" &&
          target.url.startsWith(GATHER_PAGE_PREFIX) &&
          !sessions.has(target.id)
        )
          attach(target);
    } catch (e) {
      log("Target polling failed:", e.message);
    }
    await sleep(TARGET_POLL_MS);
  }
}

async function checkForUpdate() {
  const remote = await fetchRemoteRelease();
  if (!remote || !isNewerVersion(remote.version, release.version)) return;
  release = remote;
  writeFileSync(CACHE_PATH, JSON.stringify(remote));
  log(`Hot-updating mod to ${remote.version}`);
  for (const targetId of sessions.keys())
    injectInto(targetId).catch((e) => log("Re-injection failed:", e.message));
}

function acquireLock() {
  mkdirSync(CACHE_DIR, { recursive: true });
  try {
    process.kill(Number(readFileSync(LOCK_PATH, "utf8")), 0);
    return false;
  } catch {}
  writeFileSync(LOCK_PATH, String(process.pid));
  process.on("exit", () => {
    try {
      if (readFileSync(LOCK_PATH, "utf8") === String(process.pid))
        rmSync(LOCK_PATH);
    } catch {}
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => process.exit(0));
  return true;
}

if (!acquireLock()) {
  log("Launcher already running, focusing GatherV2");
  execFileSync("open", ["-a", APP_PATH]);
  process.exit(0);
}

release = await loadRelease();
await startGatherWithDebugger();
if (!release) {
  log("No valid mod release (remote and cache), GatherV2 started without mods");
  process.exit(1);
}
log(`Mod ${release.version} ready, watching GatherV2 pages`);
const updateTimer = setInterval(checkForUpdate, UPDATE_CHECK_MS);
await watchGatherPages();
clearInterval(updateTimer);
log("GatherV2 closed, launcher exiting");
process.exit(0);

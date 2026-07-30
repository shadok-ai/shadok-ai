#!/usr/bin/env node
// pilotctl — thin client for the shadok-ai web server. One-shot commands,
// JSON on stdout. See .claude/skills/shadok-ai-agents/SKILL.md.
import { execFileSync, spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

export const port = () => Number(process.env.SHADOK_PORT ?? 3789);
export const httpBase = () => `http://localhost:${port()}`;
export const wsUrl = () => `ws://localhost:${port()}/ws`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stateDir() {
  return process.env.SHADOK_STATE_DIR ?? path.join(os.homedir(), ".shadok-ai", "pilotctl");
}

export function readState(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), id + ".json"), "utf8"));
  } catch {
    return null;
  }
}

export function writeState(id, obj) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), id + ".json"), JSON.stringify(obj, null, 2));
}

export function deleteState(id) {
  fs.rmSync(path.join(stateDir(), id + ".json"), { force: true });
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--worktree" || a === "--continue") flags[a.slice(2)] = true;
    else if (a === "--cwd" || a === "--resume" || a === "--timeout") flags[a.slice(2)] = rest[++i];
    else pos.push(a);
  }
  return { cmd, pos, flags };
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

// Attaches to (or starts) a session; resolves once the server says `ready`.
export async function openSession(startMsg) {
  const ws = await connect();
  const listeners = new Set();
  const state = { lastScreen: "", busy: false, ready: null };
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "screen") state.lastScreen = msg.text;
    if (msg.type === "working") state.busy = true;
    if (msg.type === "turn-done" || msg.type === "dialog") state.busy = false;
    for (const l of [...listeners]) l(msg);
  });
  ws.on("close", () => {
    for (const l of [...listeners]) l({ type: "socket-closed" });
  });
  const client = {
    ws,
    state,
    send: (m) => ws.send(JSON.stringify(m)),
    on: (l) => listeners.add(l),
    off: (l) => listeners.delete(l),
    waitFor: (types, timeoutMs) =>
      new Promise((resolve) => {
        const timer = timeoutMs
          ? setTimeout(() => {
              listeners.delete(l);
              resolve({ type: "timeout" });
            }, timeoutMs)
          : null;
        const l = (msg) => {
          if (!types.includes(msg.type)) return;
          if (timer) clearTimeout(timer);
          listeners.delete(l);
          resolve(msg);
        };
        listeners.add(l);
      }),
  };
  client.send({ type: "start", ...startMsg });
  const ready = await client.waitFor(["ready", "error"], 90_000);
  if (ready.type !== "ready") {
    ws.close();
    throw new Error(ready.message ?? "timeout waiting for ready");
  }
  state.ready = ready;
  return client;
}

// Accumulates streamed content until the turn ends (or a dialog suspends it).
export async function collectTurn(client, timeoutMs) {
  const texts = [];
  const tools = [];
  const collector = (msg) => {
    if (msg.type === "stream-text") texts.push(msg.text);
    else if (msg.type === "stream-tool") tools.push({ name: msg.name, summary: msg.summary });
  };
  client.on(collector);
  const end = await client.waitFor(
    // "pace-blocked" is a refusal, not a turn: the server sent nothing to the
    // TUI, so no turn-done will ever follow. Without it here the call would sit
    // out the whole timeout and report an indistinguishable {status:"timeout"}.
    ["dialog", "turn-done", "exited", "stopped", "error", "pace-blocked", "socket-closed"],
    timeoutMs,
  );
  client.off(collector);
  const text = texts.join("\n\n");
  if (end.type === "turn-done") return { status: "answer", text, tools };
  if (end.type === "dialog")
    return { status: "dialog", question: end.question, options: end.options, multi: end.multi, text };
  if (end.type === "pace-blocked")
    return { status: "pace-blocked", reason: end.reason ?? null, text };
  if (end.type === "timeout") return { status: "timeout", screen: client.state.lastScreen, text };
  if (end.type === "error") return { status: "error", error: end.message };
  return { status: "exited", code: end.code ?? null, text };
}

async function serverUp() {
  try {
    const r = await fetch(`${httpBase()}/sessions?cwd=${encodeURIComponent(os.homedir())}`, {
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function ensureServer() {
  if (await serverUp()) return;
  if (process.env.SHADOK_NO_AUTOSTART)
    throw new Error(`shadok-ai server unreachable on :${port()}`);
  const dist = path.join(REPO_ROOT, "dist", "server.js");
  if (!fs.existsSync(dist))
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "ignore" });
  fs.mkdirSync(stateDir(), { recursive: true });
  const logPath = path.join(stateDir(), "server.log");
  const log = fs.openSync(logPath, "a");
  const child = spawnChild(process.execPath, [dist], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, PORT: String(port()) },
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await serverUp()) return;
    await sleep(300);
  }
  throw new Error(`shadok-ai server did not come up on :${port()} (log: ${logPath})`);
}

// The server kills the claude process when its last WS client detaches, so a
// detached "hold" process keeps one attachment open per piloted agent.
export async function ensureHolder(id, cwd) {
  if (process.env.SHADOK_NO_HOLDER) return;
  const st = readState(id);
  if (st?.holderPid && pidAlive(st.holderPid)) return;
  const self = fileURLToPath(import.meta.url);
  const args = [self, "hold", id];
  if (cwd) args.push(cwd);
  const child = spawnChild(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: process.env,
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("holder failed to attach within 90s")), 90_000);
      child.stdout.on("data", (d) => {
        if (String(d).includes("attached")) {
          clearTimeout(t);
          resolve();
        }
      });
      child.once("exit", () => {
        clearTimeout(t);
        reject(new Error("holder exited before attaching"));
      });
    });
  } finally {
    child.unref();
  }
  writeState(id, { ...(readState(id) ?? { sessionId: id }), cwd: cwd ?? null, holderPid: child.pid });
}

async function cmdSpawn(flags) {
  await ensureServer();
  const startMsg = {};
  if (flags.cwd) startMsg.cwd = flags.cwd;
  if (flags.worktree) startMsg.worktree = true;
  if (flags.resume) startMsg.resume = flags.resume;
  if (flags.continue) startMsg.continue = true;
  const client = await openSession(startMsg);
  const { sessionId, cwd, branch } = client.state.ready;
  let baseSha = null;
  if (branch) {
    try {
      baseSha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {}
  }
  const prev = readState(sessionId) ?? {};
  writeState(sessionId, {
    ...prev,
    sessionId,
    cwd,
    branch: branch ?? prev.branch ?? null,
    baseSha: baseSha ?? prev.baseSha ?? null,
    holderPid: prev.holderPid ?? null,
  });
  await ensureHolder(sessionId, cwd);
  client.ws.close();
  return { sessionId, cwd, branch: branch ?? null };
}

// Internal command: stays attached until the session ends.
async function cmdHold(id, cwd) {
  await openSession({ resume: id, cwd }).then((client) => {
    process.stdout.write("attached\n");
    client.on((msg) => {
      if (msg.type === "stopped") deleteState(id);
      if (["stopped", "exited", "socket-closed"].includes(msg.type)) process.exit(0);
    });
  });
  return new Promise(() => {}); // never resolves; the WS keeps the loop alive
}

// Attaches to a piloted session and sends one protocol message, then waits
// for the outcome of the turn (answer, dialog, timeout…).
async function cmdTurn(id, msg, flags) {
  await ensureServer();
  const st = readState(id);
  const cwd = flags.cwd ?? st?.cwd ?? undefined;
  await ensureHolder(id, cwd);
  const client = await openSession({ resume: id, cwd });
  client.send(msg);
  const result = await collectTurn(client, Number(flags.timeout ?? 600) * 1000);
  client.ws.close();
  if (result.status === "error") throw new Error(result.error);
  return { ...result, sessionId: id };
}

async function cmdDialog(id, flags) {
  // `settle` is silently ignored server-side while a turn is in flight, and
  // triggers a dialog/turn-done broadcast when idle — safe to always send.
  const r = await cmdTurn(id, { type: "settle" }, flags);
  if (r.status === "answer") return { status: "idle", sessionId: id, text: r.text };
  return r;
}

async function cmdList(flags) {
  await ensureServer();
  const cwd = flags.cwd ?? process.cwd();
  const r = await fetch(`${httpBase()}/sessions?cwd=${encodeURIComponent(cwd)}`);
  const resumable = await r.json();
  const dir = stateDir();
  const agents = !fs.existsSync(dir)
    ? []
    : fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
        .map((s) => ({ ...s, live: !!(s.holderPid && pidAlive(s.holderPid)) }));
  return { agents, resumable };
}

async function cmdDiff(id) {
  await ensureServer();
  const r = await fetch(`${httpBase()}/diff?session=${encodeURIComponent(id)}`);
  const body = await r.json();
  if (!body.error) return body;
  // Session no longer live server-side: diff the worktree locally against
  // the baseSha recorded at spawn time.
  const st = readState(id);
  if (!st?.cwd) throw new Error(`no live session and no local state for ${id}`);
  const git = (args) =>
    execFileSync("git", ["-C", st.cwd, ...args], { encoding: "utf8" }).trimEnd();
  let diff = git(["diff", st.baseSha ?? "HEAD"]);
  // Include untracked files (diff doesn't show them) — mirrors gitDiff in src/worktree.ts.
  const untracked = git(["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean);
  if (untracked.length) {
    const shown = untracked.map((f) => {
      try {
        return git(["diff", "--no-index", "/dev/null", f]);
      } catch (e) {
        // --no-index exits non-zero when files differ; its stdout has the diff.
        return e?.stdout ? String(e.stdout).trimEnd() : `+++ ${f} (untracked)`;
      }
    });
    diff = [diff, ...shown].filter(Boolean).join("\n");
  }
  return {
    status: git(["status", "--short"]),
    diff,
    branch: st.branch ?? null,
    fallback: true,
  };
}

async function cmdStop(id) {
  await ensureServer();
  const st = readState(id);
  const holderLive = !!(st?.holderPid && pidAlive(st.holderPid));
  if (!holderLive) {
    // No holder → we never kept this session alive; don't resurrect it just
    // to stop it (it may belong to a browser client). Clear local state only.
    deleteState(id);
    return { stopped: false, sessionId: id, note: "no live holder; local state cleared" };
  }
  let client;
  try {
    client = await openSession({ resume: id, cwd: st?.cwd ?? undefined });
  } catch (err) {
    // Holder pid is alive but session is dead (zombie holder, dead server session).
    // Kill the holder and clean up state.
    if (st.holderPid !== process.pid && pidAlive(st.holderPid)) {
      try {
        process.kill(st.holderPid);
      } catch {}
    }
    deleteState(id);
    const msg = err instanceof Error ? err.message : String(err);
    return { stopped: false, sessionId: id, note: `session not reattachable (${msg}); holder killed and local state cleared` };
  }
  client.send({ type: "stop" });
  const result = await client.waitFor(["stopped", "socket-closed"], 30_000);
  client.ws.close();
  if (result.type === "timeout") {
    // Stop was not confirmed within 30s; don't kill holder or delete state (leave for retry).
    return { stopped: false, sessionId: id, note: "stop not confirmed within 30s; session may still be running" };
  }
  if (st.holderPid !== process.pid && pidAlive(st.holderPid)) {
    try {
      process.kill(st.holderPid);
    } catch {}
  }
  deleteState(id);
  return { stopped: true, sessionId: id };
}

async function cmdScreen(id, flags) {
  await ensureServer();
  const st = readState(id);
  const cwd = flags.cwd ?? st?.cwd ?? undefined;
  await ensureHolder(id, cwd);
  const client = await openSession({ resume: id, cwd });
  if (!client.state.lastScreen) await client.waitFor(["screen"], 5000);
  client.ws.close();
  return { sessionId: id, screen: client.state.lastScreen };
}

const HELP =
  "usage: pilotctl <spawn|prompt|dialog|choose|toggle|confirm|freetext|list|diff|stop|screen> …";

export async function run(argv) {
  const { cmd, pos, flags } = parseArgs(argv);
  switch (cmd) {
    case "spawn":
      return cmdSpawn(flags);
    case "hold":
      return cmdHold(pos[0], pos[1]);
    case "prompt":
      return cmdTurn(pos[0], { type: "prompt", text: pos[1] }, flags);
    case "dialog":
      return cmdDialog(pos[0], flags);
    case "choose":
      return cmdTurn(pos[0], { type: "choose", n: Number(pos[1]) }, flags);
    case "toggle":
      return cmdTurn(pos[0], { type: "toggle", n: Number(pos[1]) }, flags);
    case "confirm":
      return cmdTurn(pos[0], { type: "confirm" }, flags);
    case "freetext":
      return cmdTurn(pos[0], { type: "freetext", n: Number(pos[1]), text: pos[2] }, flags);
    case "list":
      return cmdList(flags);
    case "diff":
      return cmdDiff(pos[0]);
    case "stop":
      return cmdStop(pos[0]);
    case "screen":
      return cmdScreen(pos[0], flags);
    default:
      throw new Error(HELP);
  }
}

// CLI entry point — not triggered when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2))
    .then((r) => {
      console.log(JSON.stringify(r));
      process.exit(r?.error || r?.status === "error" ? 1 : 0);
    })
    .catch((e) => {
      console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      process.exit(1);
    });
}

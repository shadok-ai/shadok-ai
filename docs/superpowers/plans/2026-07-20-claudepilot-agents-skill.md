# Skill `shadok-ai-agents` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project skill (`.claude/skills/shadok-ai-agents/`) that lets Claude Code create and drive shadok-ai agents through the web server, with a `pilotctl.mjs` thin client offering one-shot commands and JSON output.

**Architecture:** `pilotctl.mjs` speaks the server's WebSocket protocol (`src/server.ts`) in one-shot commands. Since the server kills the claude process when the last WS client detaches (`detach` → `destroySession`, src/server.ts:105-110), each agent is kept alive by a detached "holder" process (the internal `hold` command) that keeps a WS attachment open. Local state (cwd, branch, baseSha, holderPid per session) lives in `~/.shadok-ai/pilotctl/<id>.json`. The unit tests use a mock server (HTTP + WS) replaying the protocol.

**Tech Stack:** Node 20 (ESM), a single dependency `ws` (already in the repo's package.json — resolution walks up to the root `node_modules`), `node:test` for the tests.

## Global Constraints

- Node 20 : pas de `WebSocket` global — importer `ws`. `fetch` global disponible.
- No new npm dependency; `pilotctl.mjs` imports only `ws` and `node:` modules.
- Port serveur : `Number(process.env.SHADOK_PORT ?? 3789)` ; URLs `http://localhost:<port>` et `ws://localhost:<port>/ws`.
- State directory: `process.env.SHADOK_STATE_DIR ?? ~/.shadok-ai/pilotctl/` (a `stateDir()` function, never a constant frozen at import time — the tests override the env).
- Test/control env: `SHADOK_NO_HOLDER=1` (no holder process), `SHADOK_NO_AUTOSTART=1` (no automatic server start).
- CLI output: one JSON object on stdout; exit 0 on success, 1 on `{error}` or `status:"error"`.
- The real server protocol (src/server.ts, NOT the README, which lags): content streamed through `stream-text`/`stream-tool`/`stream-result`, end of turn = `turn-done`, dialog = `dialog`, plus `ready`, `screen`, `working`, `error`, `exited`, `stopped`. `settle` is silently ignored while a turn is running.
- SKILL.md in English, like the rest of the repo; code, identifiers and comments in English, in the repo's sober style.
- Commits: `feat:`/`test:`/`docs:` prefixes, signed `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: The pilotctl skeleton — parseArgs, local state, dispatcher

**Files:**
- Create: `.claude/skills/shadok-ai-agents/pilotctl.mjs`
- Create: `.claude/skills/shadok-ai-agents/test/helpers.test.mjs`
- Modify: `package.json` (script `test`)

**Interfaces:**
- Produces: `parseArgs(argv) -> {cmd, pos, flags}`; `stateDir() -> string`; `readState(id) -> object|null`; `writeState(id, obj)`; `deleteState(id)`; `run(argv) -> Promise<object>` (resolves with the JSON result, rejects on error); the `REPO_ROOT` constant, the `port()`, `httpBase()`, `wsUrl()`, `sleep(ms)`, `pidAlive(pid)` helpers. Everything is exported for the tests.

- [ ] **Step 1: Write the failing test**

```js
// .claude/skills/shadok-ai-agents/test/helpers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SHADOK_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-test-"));
const { parseArgs, readState, writeState, deleteState } = await import("../pilotctl.mjs");

test("parseArgs splits command, positionals and flags", () => {
  const r = parseArgs(["prompt", "abc", "fais X", "--timeout", "30", "--worktree", "--cwd", "/tmp/y"]);
  assert.equal(r.cmd, "prompt");
  assert.deepEqual(r.pos, ["abc", "fais X"]);
  assert.equal(r.flags.timeout, "30");
  assert.equal(r.flags.worktree, true);
  assert.equal(r.flags.cwd, "/tmp/y");
});

test("parseArgs handles --continue and --resume", () => {
  const r = parseArgs(["spawn", "--continue", "--resume", "abc-123"]);
  assert.equal(r.flags.continue, true);
  assert.equal(r.flags.resume, "abc-123");
});

test("state: write, read, delete", () => {
  assert.equal(readState("nope"), null);
  writeState("abc", { sessionId: "abc", cwd: "/tmp/x" });
  assert.deepEqual(readState("abc"), { sessionId: "abc", cwd: "/tmp/x" });
  deleteState("abc");
  assert.equal(readState("abc"), null);
});
```

- [ ] **Step 2: Check that the test fails**

Run: `node --test .claude/skills/shadok-ai-agents/test/`
Expected: FAIL (`Cannot find module '../pilotctl.mjs'`)

- [ ] **Step 3: Implement the skeleton**

```js
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

const HELP =
  "usage: pilotctl <spawn|prompt|dialog|choose|toggle|confirm|freetext|list|diff|stop|screen> …";

export async function run(argv) {
  const { cmd, pos, flags } = parseArgs(argv);
  switch (cmd) {
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
```

- [ ] **Step 4: Put the test script in package.json**

In `package.json`, replace `"test": "echo \"Error: no test specified\" && exit 1"` with:

```json
"test": "node --test .claude/skills/shadok-ai-agents/test/"
```

- [ ] **Step 5: Check the tests pass**

Run: `npm test`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/shadok-ai-agents/ package.json
git commit -m "feat: the pilotctl skeleton (args, local state, dispatcher)"
```

---

### Task 2: Serveur mock de test, client WS (openSession/collectTurn), spawn + hold

**Files:**
- Create: `.claude/skills/shadok-ai-agents/test/mock-server.mjs`
- Create: `.claude/skills/shadok-ai-agents/test/spawn.test.mjs`
- Modify: `.claude/skills/shadok-ai-agents/pilotctl.mjs`

**Interfaces:**
- Consumes: helpers de Task 1 (`readState`, `writeState`, `wsUrl`, `sleep`, `pidAlive`).
- Produces: `startMockServer(script) -> Promise<{port, received, close()}>` (tests only); in pilotctl: `openSession(startMsg) -> Promise<client>` where `client = {ws, send(msg), waitFor(types[], timeoutMs) -> Promise<msg|{type:"timeout"}>, on(l), off(l), state: {lastScreen, busy, ready}}`; `collectTurn(client, timeoutMs) -> Promise<{status: "answer"|"dialog"|"timeout"|"error"|"exited", …}>`; `ensureServer()` (the health-check-only version, the auto-start lands in Task 4); `ensureHolder(id, cwd)`; the `spawn` and `hold` commands wired into `run()`.

- [ ] **Step 1: Write the mock server**

```js
// .claude/skills/shadok-ai-agents/test/mock-server.mjs
import http from "node:http";
import { WebSocketServer } from "ws";

// Minimal stand-in for the shadok-ai server: replays scripted replies per
// incoming message type, so pilotctl's client logic is exercised without a
// real claude process. `script[type]` is an array of messages to send back.
export function startMockServer(script = {}) {
  const app = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/sessions")) return res.end(JSON.stringify(script.sessions ?? []));
    if (req.url.startsWith("/diff"))
      return res.end(
        JSON.stringify(script.diff ?? { status: "", diff: "", branch: null, error: "no such session" }),
      );
    res.end("{}");
  });
  const wss = new WebSocketServer({ server: app, path: "/ws" });
  const received = [];
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      received.push(msg);
      for (const reply of script[msg.type] ?? []) ws.send(JSON.stringify(reply));
    });
  });
  return new Promise((resolve) => {
    app.listen(0, () =>
      resolve({
        port: app.address().port,
        received,
        close: () => new Promise((r) => { wss.close(); app.close(r); }),
      }),
    );
  });
}
```

- [ ] **Step 2: Write the failing spawn test**

```js
// .claude/skills/shadok-ai-agents/test/spawn.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockServer } from "./mock-server.mjs";

process.env.SHADOK_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-test-"));
process.env.SHADOK_NO_HOLDER = "1";
process.env.SHADOK_NO_AUTOSTART = "1";
const { run, readState } = await import("../pilotctl.mjs");

test("spawn starts a session and writes the local state", async () => {
  const mock = await startMockServer({
    start: [{ type: "ready", sessionId: "abc-123", cwd: "/tmp/x", branch: "shadok-ai/abc123" }],
  });
  process.env.SHADOK_PORT = String(mock.port);
  try {
    const r = await run(["spawn", "--cwd", "/tmp/x", "--worktree"]);
    assert.equal(r.sessionId, "abc-123");
    assert.equal(r.cwd, "/tmp/x");
    assert.equal(r.branch, "shadok-ai/abc123");
    assert.deepEqual(mock.received[0], { type: "start", cwd: "/tmp/x", worktree: true });
    const st = readState("abc-123");
    assert.equal(st.cwd, "/tmp/x");
    assert.equal(st.branch, "shadok-ai/abc123");
  } finally {
    await mock.close();
  }
});

test("spawn propage l'erreur du serveur", async () => {
  const mock = await startMockServer({
    start: [{ type: "error", message: "worktree creation failed: boom" }],
  });
  process.env.SHADOK_PORT = String(mock.port);
  try {
    await assert.rejects(() => run(["spawn"]), /worktree creation failed/);
  } finally {
    await mock.close();
  }
});
```

- [ ] **Step 3: Check that the test fails**

Run: `npm test`
Expected: FAIL (`usage: pilotctl …` — the spawn command does not exist yet)

- [ ] **Step 4: Implement openSession, collectTurn, ensureServer (check only), ensureHolder, spawn, hold**

Add to `pilotctl.mjs` (above `run`):

```js
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
    ["dialog", "turn-done", "exited", "stopped", "error", "socket-closed"],
    timeoutMs,
  );
  client.off(collector);
  const text = texts.join("\n\n");
  if (end.type === "turn-done") return { status: "answer", text, tools };
  if (end.type === "dialog")
    return { status: "dialog", question: end.question, options: end.options, multi: end.multi, text };
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
  throw new Error(`shadok-ai server unreachable on :${port()}`);
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
  child.unref();
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
      baseSha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {}
  }
  writeState(sessionId, { sessionId, cwd, branch: branch ?? null, baseSha, holderPid: null });
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
```

And in `run()`'s `switch`:

```js
    case "spawn":
      return cmdSpawn(flags);
    case "hold":
      return cmdHold(pos[0], pos[1]);
```

- [ ] **Step 5: Check the tests pass**

Run: `npm test`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/shadok-ai-agents/
git commit -m "feat: pilotctl spawn + holder (client WS, collecte de tour)"
```

---

### Task 3: prompt, dialog and dialog answers (choose/toggle/confirm/freetext)

**Files:**
- Create: `.claude/skills/shadok-ai-agents/test/turns.test.mjs`
- Modify: `.claude/skills/shadok-ai-agents/pilotctl.mjs`

**Interfaces:**
- Consumes: `openSession`, `collectTurn`, `ensureServer`, `ensureHolder`, `readState` (Tasks 1-2).
- Produces: the `prompt <id> <text> [--timeout s]`, `dialog <id>`, `choose <id> <n>`, `toggle <id> <n>`, `confirm <id>`, `freetext <id> <n> <text>` commands in `run()`. They all return `collectTurn`'s result + `sessionId`; `dialog` maps `answer` → `{status:"idle"}`.

- [ ] **Step 1: Write the failing tests**

```js
// .claude/skills/shadok-ai-agents/test/turns.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockServer } from "./mock-server.mjs";

process.env.SHADOK_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-test-"));
process.env.SHADOK_NO_HOLDER = "1";
process.env.SHADOK_NO_AUTOSTART = "1";
const { run, writeState } = await import("../pilotctl.mjs");

const READY = { type: "ready", sessionId: "abc", cwd: "/tmp/x" };

function useMock(mock) {
  process.env.SHADOK_PORT = String(mock.port);
  writeState("abc", { sessionId: "abc", cwd: "/tmp/x", holderPid: null });
}

test("prompt returns the answer streamed at turn-done", async () => {
  const mock = await startMockServer({
    start: [READY],
    prompt: [
      { type: "working" },
      { type: "stream-text", text: "Bonjour" },
      { type: "stream-tool", name: "Bash", summary: "ls" },
      { type: "stream-text", text: "Fini." },
      { type: "turn-done", sessionId: "abc" },
    ],
  });
  useMock(mock);
  try {
    const r = await run(["prompt", "abc", "fais un truc"]);
    assert.equal(r.status, "answer");
    assert.equal(r.text, "Bonjour\n\nFini.");
    assert.deepEqual(r.tools, [{ name: "Bash", summary: "ls" }]);
    assert.deepEqual(mock.received[1], { type: "prompt", text: "fais un truc" });
  } finally {
    await mock.close();
  }
});

test("prompt remonte un dialog en attente", async () => {
  const dialog = {
    type: "dialog",
    question: "Autoriser Bash ?",
    options: [{ n: 1, label: "Oui" }, { n: 2, label: "Non" }],
    multi: false,
  };
  const mock = await startMockServer({ start: [READY], prompt: [{ type: "working" }, dialog] });
  useMock(mock);
  try {
    const r = await run(["prompt", "abc", "fais un truc"]);
    assert.equal(r.status, "dialog");
    assert.equal(r.question, "Autoriser Bash ?");
    assert.equal(r.options.length, 2);
  } finally {
    await mock.close();
  }
});

test("a prompt with no end of turn returns a timeout with the current screen", async () => {
  const mock = await startMockServer({
    start: [READY],
    prompt: [{ type: "working" }, { type: "screen", text: "esc to interrupt", working: true }],
  });
  useMock(mock);
  try {
    const r = await run(["prompt", "abc", "long", "--timeout", "1"]);
    assert.equal(r.status, "timeout");
    assert.equal(r.screen, "esc to interrupt");
  } finally {
    await mock.close();
  }
});

test("choose commits an option and waits for what follows", async () => {
  const mock = await startMockServer({
    start: [READY],
    choose: [{ type: "working" }, { type: "stream-text", text: "ok" }, { type: "turn-done" }],
  });
  useMock(mock);
  try {
    const r = await run(["choose", "abc", "1"]);
    assert.equal(r.status, "answer");
    assert.deepEqual(mock.received[1], { type: "choose", n: 1 });
  } finally {
    await mock.close();
  }
});

test("dialog interroge via settle et mappe answer → idle", async () => {
  const mock = await startMockServer({ start: [READY], settle: [{ type: "turn-done" }] });
  useMock(mock);
  try {
    const r = await run(["dialog", "abc"]);
    assert.equal(r.status, "idle");
  } finally {
    await mock.close();
  }
});

test("freetext passes n and the text", async () => {
  const mock = await startMockServer({ start: [READY], freetext: [{ type: "turn-done" }] });
  useMock(mock);
  try {
    await run(["freetext", "abc", "3", "my answer"]);
    assert.deepEqual(mock.received[1], { type: "freetext", n: 3, text: "my answer" });
  } finally {
    await mock.close();
  }
});
```

- [ ] **Step 2: Check that the tests fail**

Run: `npm test`
Expected: FAIL (6 nouveaux tests, `usage: pilotctl …`)

- [ ] **Step 3: Implement the turn commands**

Add to `pilotctl.mjs`:

```js
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
```

And in `run()`'s `switch`:

```js
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
```

- [ ] **Step 4: Check the tests pass**

Run: `npm test`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/shadok-ai-agents/
git commit -m "feat: pilotctl prompt/dialog/choose/toggle/confirm/freetext"
```

---

### Task 4: Auto-start du serveur, list, diff (+ fallback local), stop, screen

**Files:**
- Create: `.claude/skills/shadok-ai-agents/test/mgmt.test.mjs`
- Modify: `.claude/skills/shadok-ai-agents/pilotctl.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: a completed `ensureServer()` (build + detached start + waiting for the port); the `list [--cwd]`, `diff <id>`, `stop <id>`, `screen <id>` commands in `run()`.

- [ ] **Step 1: Write the failing tests**

```js
// .claude/skills/shadok-ai-agents/test/mgmt.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockServer } from "./mock-server.mjs";

process.env.SHADOK_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-test-"));
process.env.SHADOK_NO_HOLDER = "1";
process.env.SHADOK_NO_AUTOSTART = "1";
const { run, writeState, readState } = await import("../pilotctl.mjs");

test("unreachable server with no auto-start → an explicit error", async () => {
  process.env.SHADOK_PORT = "1"; // nothing listens there
  await assert.rejects(() => run(["list"]), /unreachable/);
});

test("list combines resumable sessions and local agents", async () => {
  const mock = await startMockServer({ sessions: [{ id: "old-1", mtime: 123 }] });
  process.env.SHADOK_PORT = String(mock.port);
  writeState("abc", { sessionId: "abc", cwd: "/tmp/x", holderPid: null });
  try {
    const r = await run(["list"]);
    assert.deepEqual(r.resumable, [{ id: "old-1", mtime: 123 }]);
    assert.equal(r.agents.length, 1);
    assert.equal(r.agents[0].live, false);
  } finally {
    await mock.close();
  }
});

test("diff goes through the server while the session is live", async () => {
  const mock = await startMockServer({
    diff: { status: "M x.txt", diff: "--- a/x.txt", branch: "shadok-ai/abc" },
  });
  process.env.SHADOK_PORT = String(mock.port);
  try {
    const r = await run(["diff", "abc"]);
    assert.equal(r.branch, "shadok-ai/abc");
    assert.equal(r.fallback, undefined);
  } finally {
    await mock.close();
  }
});

test("diff falls back to local git once the session is no longer live", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-repo-"));
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "x.txt"), "v1\n");
  git("add", ".");
  git("commit", "-qm", "init");
  const baseSha = git("rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(repo, "x.txt"), "v2\n");

  const mock = await startMockServer(); // /diff answers "no such session"
  process.env.SHADOK_PORT = String(mock.port);
  writeState("gone", { sessionId: "gone", cwd: repo, baseSha, branch: "shadok-ai/gone" });
  try {
    const r = await run(["diff", "gone"]);
    assert.equal(r.fallback, true);
    assert.match(r.diff, /\+v2/);
    assert.match(r.status, /x\.txt/);
  } finally {
    await mock.close();
  }
});

test("stop with no live holder cleans the state without reattaching", async () => {
  const mock = await startMockServer();
  process.env.SHADOK_PORT = String(mock.port);
  writeState("dead", { sessionId: "dead", cwd: "/tmp/x", holderPid: 999999 });
  try {
    const r = await run(["stop", "dead"]);
    assert.equal(r.stopped, false);
    assert.equal(readState("dead"), null);
    assert.equal(mock.received.length, 0); // no start sent
  } finally {
    await mock.close();
  }
});

test("stop with a live session sends stop and cleans up", async () => {
  const mock = await startMockServer({
    start: [{ type: "ready", sessionId: "abc", cwd: "/tmp/x" }],
    stop: [{ type: "stopped" }],
  });
  process.env.SHADOK_PORT = String(mock.port);
  // pid du process de test : vivant, simule un holder actif
  writeState("abc", { sessionId: "abc", cwd: "/tmp/x", holderPid: process.pid });
  try {
    const r = await run(["stop", "abc"]);
    assert.equal(r.stopped, true);
    assert.equal(readState("abc"), null);
  } finally {
    await mock.close();
  }
});

test("screen returns the last screen received", async () => {
  const mock = await startMockServer({
    start: [
      { type: "ready", sessionId: "abc", cwd: "/tmp/x" },
      { type: "screen", text: "❯ prompt en attente", working: false },
    ],
  });
  process.env.SHADOK_PORT = String(mock.port);
  writeState("abc", { sessionId: "abc", cwd: "/tmp/x", holderPid: null });
  try {
    const r = await run(["screen", "abc"]);
    assert.equal(r.screen, "❯ prompt en attente");
  } finally {
    await mock.close();
  }
});
```

Note: the `stop with a live session` test uses `process.pid` as the `holderPid` — the pid is alive, so `stop` attempts the reattach; it must NOT kill that pid when it is its own (the `pid !== process.pid` guard in the implementation) — in reality the holder is another process, the guard merely stops the test from killing itself.

- [ ] **Step 2: Check that the tests fail**

Run: `npm test`
Expected: FAIL (7 nouveaux tests)

- [ ] **Step 3: Implement**

Replace `ensureServer` with the complete version and add the commands:

```js
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
  return {
    status: git(["status", "--short"]),
    diff: git(["diff", st.baseSha ?? "HEAD"]),
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
  const client = await openSession({ resume: id, cwd: st?.cwd ?? undefined });
  client.send({ type: "stop" });
  await client.waitFor(["stopped", "socket-closed"], 30_000);
  client.ws.close();
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
```

And in `run()`'s `switch`:

```js
    case "list":
      return cmdList(flags);
    case "diff":
      return cmdDiff(pos[0]);
    case "stop":
      return cmdStop(pos[0]);
    case "screen":
      return cmdScreen(pos[0], flags);
```

- [ ] **Step 4: Check the tests pass**

Run: `npm test`
Expected: PASS (18 tests)

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/shadok-ai-agents/
git commit -m "feat: pilotctl auto-start serveur, list/diff/stop/screen"
```

---

### Task 5: SKILL.md

**Files:**
- Create: `.claude/skills/shadok-ai-agents/SKILL.md`

**Interfaces:**
- Consumes: every pilotctl command (Tasks 2-4).

- [ ] **Step 1: Write SKILL.md**

````markdown
---
name: shadok-ai-agents
description: Create and drive isolated Claude Code agents through the shadok-ai server (git worktrees, prompts, dialogs, diff). Use when the user wants to delegate a task to a shadok-ai agent, launch agents in parallel, or inspect/drive existing shadok-ai sessions.
---

# Driving shadok-ai agents

Every operation goes through the thin client shipped with this skill:

```bash
node .claude/skills/shadok-ai-agents/pilotctl.mjs <command> …
```

Each command prints ONE JSON object on stdout (exit 1 + `{error}` on failure)
and automatically starts the shadok-ai server when it is not running (port
3789, or `$SHADOK_PORT`). Sessions stay visible in the web UI
(http://localhost:3789) — the user can follow along and step in.

## Commands

| Command | Effect |
|---|---|
| `spawn [--cwd DIR] [--worktree] [--resume ID] [--continue]` | creates an agent → `{sessionId, cwd, branch}`. `--worktree` isolates the agent in a git worktree (`~/.shadok-ai/worktrees/`, branch `shadok-ai/<tag>`) |
| `prompt <id> "text" [--timeout s]` | sends a prompt, waits for the end of the turn → `{status:"answer", text, tools}` or `{status:"dialog", question, options, multi}` or `{status:"timeout", screen}` |
| `dialog <id>` | queries the state → `{status:"idle"}` or the pending dialog |
| `choose <id> <n>` | single-select dialog: picks and commits option n |
| `toggle <id> <n>` then `confirm <id>` | multi-select dialog: check/uncheck then submit |
| `freetext <id> <n> "text"` | the "Type something" option: a free answer |
| `list [--cwd DIR]` | driven agents (local state + alive/dead) and resumable sessions |
| `diff <id>` | the agent's changes (git status + diff against the worktree's base) |
| `stop <id>` | ends the session (for ALL its clients) |
| `screen <id>` | raw TUI screen (debug) |

## Typical flow: delegating a task to an agent

1. `spawn --worktree --cwd <repo>` → note the `sessionId` and `branch`;
2. `prompt <id> "<task>"` — launch it through Bash with **run_in_background**
   (a turn can take several minutes) and read the JSON at the end;
3. if `status:"dialog"`: answer with `choose` (single) or `toggle`+`confirm`
   (multi) or `freetext`, which in turn return `answer` or a new `dialog`;
4. if `status:"timeout"`: the turn CONTINUES server-side — do not resend the
   prompt; check back later with `dialog <id>`;
5. task finished: `diff <id>` and present the changes to the user. The
   `shadok-ai/<tag>` branch and its worktree are NEVER merged or deleted
   automatically — the user is the one who merges.

Parallel agents: repeat `spawn` (one id per agent), and launch the `prompt`
calls in the background simultaneously.

## Guardrails

- NEVER `stop` a session this conversation did not create: it may belong to
  the user in the web UI. `stop` ends the session for all its clients.
- Every agent consumes the Claude quota like an ordinary session. Do not
  multiply agents without an explicit request from the user.
- `prompt` on a session whose turn is already running → the error "a
  response is already in progress": wait with `dialog <id>`.
- If an agent seems stuck in a state the dialogs do not cover, look at
  `screen <id>` (the equivalent of the UI's "engine room").

## Mechanics (for debugging)

The server kills the claude process when its last WS client detaches; so
`pilotctl` keeps a small detached "holder" process per agent (the internal
`hold` command), restarted as needed by every command. Local state:
`~/.shadok-ai/pilotctl/<id>.json` (cwd, branch, baseSha, holderPid). Log of
the auto-started server: `~/.shadok-ai/pilotctl/server.log`.
````

- [ ] **Step 2: Check the skill is discovered**

Run: `ls .claude/skills/shadok-ai-agents/ && head -5 .claude/skills/shadok-ai-agents/SKILL.md`
Expected: `SKILL.md`, `pilotctl.mjs`, `test/`; the frontmatter shows.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/shadok-ai-agents/SKILL.md
git commit -m "docs: SKILL.md de shadok-ai-agents"
```

---

### Task 6: Validation de bout en bout (manuelle, consomme du quota)

A real server + a real claude. To be run as is, reporting any discrepancy.

**Files:** aucun (validation).

- [ ] **Step 1: Prepare a toy repo**

```bash
TOY=$(mktemp -d /tmp/pilotctl-e2e-XXXXXX)
git -C "$TOY" init -q && git -C "$TOY" commit -q --allow-empty -m init
```

- [ ] **Step 2: spawn --worktree**

Run: `node .claude/skills/shadok-ai-agents/pilotctl.mjs spawn --worktree --cwd "$TOY"`
Expected: `{sessionId, cwd:~/.shadok-ai/worktrees/…, branch:"shadok-ai/…"}`; the server started on its own if needed; the session appears in the web UI; `list` shows the agent as `live:true`.

- [ ] **Step 3: prompt simple**

Run: `node .claude/skills/shadok-ai-agents/pilotctl.mjs prompt <id> "Create a hello.txt file containing exactly: hello world" --timeout 300`
Expected: `{status:"answer", …}` — or `{status:"dialog"}` (a write permission), in which case answer `choose <id> 1` and check that what follows arrives.

- [ ] **Step 4: diff**

Run: `node .claude/skills/shadok-ai-agents/pilotctl.mjs diff <id>`
Expected: the diff contains `+hello world` (hello.txt).

- [ ] **Step 5: stop et conservation du worktree sale**

Run: `node .claude/skills/shadok-ai-agents/pilotctl.mjs stop <id>` puis `ls ~/.shadok-ai/worktrees/`
Expected: `{stopped:true}`; the worktree containing hello.txt is STILL there (dirty → kept); the local state `~/.shadok-ai/pilotctl/<id>.json` is gone; `diff <id>` still works through the local fallback if it was not cleaned — (optionally) re-test before deleting.

- [ ] **Step 6: Final commit (any fixes discovered end to end)**

```bash
git add -A && git commit -m "fix: pilotctl adjustments after end-to-end validation" # only if fixes were needed
```

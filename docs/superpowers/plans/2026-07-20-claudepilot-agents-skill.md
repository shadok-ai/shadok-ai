# Skill `shadok-ai-agents` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une skill de projet (`.claude/skills/shadok-ai-agents/`) qui permet à Claude Code de créer et piloter des agents shadok-ai via le serveur web, avec un thin client `pilotctl.mjs` à commandes one-shot et sortie JSON.

**Architecture:** `pilotctl.mjs` parle le protocole WebSocket du serveur (`src/server.ts`) en commandes one-shot. Comme le serveur tue le process claude quand le dernier client WS se détache (`detach` → `destroySession`, src/server.ts:105-110), chaque agent est maintenu en vie par un process « holder » détaché (commande interne `hold`) qui garde une attache WS ouverte. L'état local (cwd, branch, baseSha, holderPid par session) vit dans `~/.shadok-ai/pilotctl/<id>.json`. Les tests unitaires utilisent un serveur mock (HTTP + WS) qui rejoue le protocole.

**Tech Stack:** Node 20 (ESM), dépendance unique `ws` (déjà dans le package.json du repo — la résolution remonte au `node_modules` racine), `node:test` pour les tests.

## Global Constraints

- Node 20 : pas de `WebSocket` global — importer `ws`. `fetch` global disponible.
- Aucune nouvelle dépendance npm ; `pilotctl.mjs` n'importe que `ws` et des modules `node:`.
- Port serveur : `Number(process.env.SHADOK_PORT ?? 3789)` ; URLs `http://localhost:<port>` et `ws://localhost:<port>/ws`.
- Répertoire d'état : `process.env.SHADOK_STATE_DIR ?? ~/.shadok-ai/pilotctl/` (fonction `stateDir()`, jamais une constante figée à l'import — les tests surchargent l'env).
- Env de test/contrôle : `SHADOK_NO_HOLDER=1` (pas de process holder), `SHADOK_NO_AUTOSTART=1` (pas de démarrage auto du serveur).
- Sortie CLI : un objet JSON sur stdout ; exit 0 en succès, 1 si `{error}` ou `status:"error"`.
- Protocole serveur réel (src/server.ts, PAS le README qui est en retard) : contenu streamé via `stream-text`/`stream-tool`/`stream-result`, fin de tour = `turn-done`, dialog = `dialog`, plus `ready`, `screen`, `working`, `error`, `exited`, `stopped`. `settle` est ignoré silencieusement si le tour est en cours.
- Messages français dans SKILL.md ; code et identifiants en anglais, commentaires dans le style du repo (anglais, sobres).
- Commits : préfixes `feat:`/`test:`/`docs:`, signés `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Squelette de pilotctl — parseArgs, état local, dispatcher

**Files:**
- Create: `.claude/skills/shadok-ai-agents/pilotctl.mjs`
- Create: `.claude/skills/shadok-ai-agents/test/helpers.test.mjs`
- Modify: `package.json` (script `test`)

**Interfaces:**
- Produces: `parseArgs(argv) -> {cmd, pos, flags}` ; `stateDir() -> string` ; `readState(id) -> object|null` ; `writeState(id, obj)` ; `deleteState(id)` ; `run(argv) -> Promise<object>` (résout le résultat JSON, rejette en erreur) ; constantes `REPO_ROOT`, helpers `port()`, `httpBase()`, `wsUrl()`, `sleep(ms)`, `pidAlive(pid)`. Tout est exporté pour les tests.

- [ ] **Step 1: Écrire le test qui échoue**

```js
// .claude/skills/shadok-ai-agents/test/helpers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SHADOK_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-test-"));
const { parseArgs, readState, writeState, deleteState } = await import("../pilotctl.mjs");

test("parseArgs sépare commande, positionnels et flags", () => {
  const r = parseArgs(["prompt", "abc", "fais X", "--timeout", "30", "--worktree", "--cwd", "/tmp/y"]);
  assert.equal(r.cmd, "prompt");
  assert.deepEqual(r.pos, ["abc", "fais X"]);
  assert.equal(r.flags.timeout, "30");
  assert.equal(r.flags.worktree, true);
  assert.equal(r.flags.cwd, "/tmp/y");
});

test("parseArgs gère --continue et --resume", () => {
  const r = parseArgs(["spawn", "--continue", "--resume", "abc-123"]);
  assert.equal(r.flags.continue, true);
  assert.equal(r.flags.resume, "abc-123");
});

test("state: écriture, lecture, suppression", () => {
  assert.equal(readState("nope"), null);
  writeState("abc", { sessionId: "abc", cwd: "/tmp/x" });
  assert.deepEqual(readState("abc"), { sessionId: "abc", cwd: "/tmp/x" });
  deleteState("abc");
  assert.equal(readState("abc"), null);
});
```

- [ ] **Step 2: Vérifier que le test échoue**

Run: `node --test .claude/skills/shadok-ai-agents/test/`
Expected: FAIL (`Cannot find module '../pilotctl.mjs'`)

- [ ] **Step 3: Implémenter le squelette**

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

- [ ] **Step 4: Mettre le script test dans package.json**

Dans `package.json`, remplacer `"test": "echo \"Error: no test specified\" && exit 1"` par :

```json
"test": "node --test .claude/skills/shadok-ai-agents/test/"
```

- [ ] **Step 5: Vérifier que les tests passent**

Run: `npm test`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/shadok-ai-agents/ package.json
git commit -m "feat: squelette pilotctl (args, état local, dispatcher)"
```

---

### Task 2: Serveur mock de test, client WS (openSession/collectTurn), spawn + hold

**Files:**
- Create: `.claude/skills/shadok-ai-agents/test/mock-server.mjs`
- Create: `.claude/skills/shadok-ai-agents/test/spawn.test.mjs`
- Modify: `.claude/skills/shadok-ai-agents/pilotctl.mjs`

**Interfaces:**
- Consumes: helpers de Task 1 (`readState`, `writeState`, `wsUrl`, `sleep`, `pidAlive`).
- Produces: `startMockServer(script) -> Promise<{port, received, close()}>` (test uniquement) ; dans pilotctl : `openSession(startMsg) -> Promise<client>` où `client = {ws, send(msg), waitFor(types[], timeoutMs) -> Promise<msg|{type:"timeout"}>, on(l), off(l), state: {lastScreen, busy, ready}}` ; `collectTurn(client, timeoutMs) -> Promise<{status: "answer"|"dialog"|"timeout"|"error"|"exited", …}>` ; `ensureServer()` (version health-check seule, l'auto-start arrive en Task 4) ; `ensureHolder(id, cwd)` ; commandes `spawn` et `hold` branchées dans `run()`.

- [ ] **Step 1: Écrire le serveur mock**

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

- [ ] **Step 2: Écrire le test de spawn qui échoue**

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

test("spawn démarre une session et écrit l'état local", async () => {
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

- [ ] **Step 3: Vérifier que le test échoue**

Run: `npm test`
Expected: FAIL (`usage: pilotctl …` — la commande spawn n'existe pas encore)

- [ ] **Step 4: Implémenter openSession, collectTurn, ensureServer (check seul), ensureHolder, spawn, hold**

Ajouter dans `pilotctl.mjs` (au-dessus de `run`) :

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

Et dans le `switch` de `run()` :

```js
    case "spawn":
      return cmdSpawn(flags);
    case "hold":
      return cmdHold(pos[0], pos[1]);
```

- [ ] **Step 5: Vérifier que les tests passent**

Run: `npm test`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/shadok-ai-agents/
git commit -m "feat: pilotctl spawn + holder (client WS, collecte de tour)"
```

---

### Task 3: prompt, dialog et réponses aux dialogs (choose/toggle/confirm/freetext)

**Files:**
- Create: `.claude/skills/shadok-ai-agents/test/turns.test.mjs`
- Modify: `.claude/skills/shadok-ai-agents/pilotctl.mjs`

**Interfaces:**
- Consumes: `openSession`, `collectTurn`, `ensureServer`, `ensureHolder`, `readState` (Tasks 1-2).
- Produces: commandes `prompt <id> <texte> [--timeout s]`, `dialog <id>`, `choose <id> <n>`, `toggle <id> <n>`, `confirm <id>`, `freetext <id> <n> <texte>` dans `run()`. Toutes retournent le résultat de `collectTurn` + `sessionId` ; `dialog` mappe `answer` → `{status:"idle"}`.

- [ ] **Step 1: Écrire les tests qui échouent**

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

test("prompt retourne la réponse streamée à turn-done", async () => {
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

test("prompt sans fin de tour rend un timeout avec le screen courant", async () => {
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

test("choose valide une option et attend la suite", async () => {
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

test("freetext transmet n et le texte", async () => {
  const mock = await startMockServer({ start: [READY], freetext: [{ type: "turn-done" }] });
  useMock(mock);
  try {
    await run(["freetext", "abc", "3", "ma réponse"]);
    assert.deepEqual(mock.received[1], { type: "freetext", n: 3, text: "ma réponse" });
  } finally {
    await mock.close();
  }
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `npm test`
Expected: FAIL (6 nouveaux tests, `usage: pilotctl …`)

- [ ] **Step 3: Implémenter les commandes de tour**

Ajouter dans `pilotctl.mjs` :

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

Et dans le `switch` de `run()` :

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

- [ ] **Step 4: Vérifier que les tests passent**

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
- Consumes: tout ce qui précède.
- Produces: `ensureServer()` complété (build + démarrage détaché + attente du port) ; commandes `list [--cwd]`, `diff <id>`, `stop <id>`, `screen <id>` dans `run()`.

- [ ] **Step 1: Écrire les tests qui échouent**

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

test("serveur injoignable sans auto-start → erreur explicite", async () => {
  process.env.SHADOK_PORT = "1"; // rien n'écoute là
  await assert.rejects(() => run(["list"]), /unreachable/);
});

test("list combine sessions résumables et agents locaux", async () => {
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

test("diff passe par le serveur quand la session est live", async () => {
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

test("diff retombe sur git local quand la session n'est plus live", async () => {
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

  const mock = await startMockServer(); // /diff répond "no such session"
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

test("stop sans holder vivant nettoie l'état sans rattacher", async () => {
  const mock = await startMockServer();
  process.env.SHADOK_PORT = String(mock.port);
  writeState("dead", { sessionId: "dead", cwd: "/tmp/x", holderPid: 999999 });
  try {
    const r = await run(["stop", "dead"]);
    assert.equal(r.stopped, false);
    assert.equal(readState("dead"), null);
    assert.equal(mock.received.length, 0); // aucun start envoyé
  } finally {
    await mock.close();
  }
});

test("stop avec session live envoie stop et nettoie", async () => {
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

test("screen retourne le dernier screen reçu", async () => {
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

Note : le test `stop avec session live` utilise `process.pid` comme `holderPid` — le pid est vivant, donc `stop` tente le rattachement ; il ne doit PAS tuer ce pid s'il s'agit du sien (garde `pid !== process.pid` dans l'implémentation) — en réalité le holder est un autre process, la garde évite juste que le test se suicide.

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `npm test`
Expected: FAIL (7 nouveaux tests)

- [ ] **Step 3: Implémenter**

Remplacer `ensureServer` par la version complète et ajouter les commandes :

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

Et dans le `switch` de `run()` :

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

- [ ] **Step 4: Vérifier que les tests passent**

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
- Consumes: toutes les commandes pilotctl (Tasks 2-4).

- [ ] **Step 1: Écrire SKILL.md**

````markdown
---
name: shadok-ai-agents
description: Créer et piloter des agents Claude Code isolés via le serveur shadok-ai (worktrees git, prompts, dialogs, diff). Utiliser quand l'utilisateur veut déléguer une tâche à un agent shadok-ai, lancer des agents en parallèle, ou inspecter/piloter des sessions shadok-ai existantes.
---

# Piloter des agents shadok-ai

Toutes les opérations passent par le thin client livré avec cette skill :

```bash
node .claude/skills/shadok-ai-agents/pilotctl.mjs <commande> …
```

Chaque commande imprime UN objet JSON sur stdout (exit 1 + `{error}` en
échec) et démarre automatiquement le serveur shadok-ai s'il ne tourne pas
(port 3789, ou `$SHADOK_PORT`). Les sessions restent visibles dans
l'UI web (http://localhost:3789) — l'utilisateur peut suivre et intervenir.

## Commandes

| Commande | Effet |
|---|---|
| `spawn [--cwd DIR] [--worktree] [--resume ID] [--continue]` | crée un agent → `{sessionId, cwd, branch}`. `--worktree` isole l'agent dans un worktree git (`~/.shadok-ai/worktrees/`, branche `shadok-ai/<tag>`) |
| `prompt <id> "texte" [--timeout s]` | envoie un prompt, attend la fin du tour → `{status:"answer", text, tools}` ou `{status:"dialog", question, options, multi}` ou `{status:"timeout", screen}` |
| `dialog <id>` | interroge l'état → `{status:"idle"}` ou le dialog en attente |
| `choose <id> <n>` | dialog single-select : choisit et valide l'option n |
| `toggle <id> <n>` puis `confirm <id>` | dialog multi-select : coche/décoche puis soumet |
| `freetext <id> <n> "texte"` | option « Type something » : réponse libre |
| `list [--cwd DIR]` | agents pilotés (état local + vivant/mort) et sessions résumables |
| `diff <id>` | changements de l'agent (git status + diff vs la base du worktree) |
| `stop <id>` | termine la session (pour TOUS ses clients) |
| `screen <id>` | screen TUI brut (debug) |

## Flux type : déléguer une tâche à un agent

1. `spawn --worktree --cwd <repo>` → noter `sessionId` et `branch` ;
2. `prompt <id> "<tâche>"` — lancer via Bash en **run_in_background**
   (un tour peut durer plusieurs minutes) et lire le JSON à la fin ;
3. si `status:"dialog"` : répondre avec `choose` (single) ou
   `toggle`+`confirm` (multi) ou `freetext`, qui rendent à leur tour
   `answer` ou un nouveau `dialog` ;
4. si `status:"timeout"` : le tour CONTINUE côté serveur — ne pas renvoyer
   le prompt ; re-vérifier plus tard avec `dialog <id>` ;
5. tâche finie : `diff <id>` et présenter les changements à l'utilisateur.
   La branche `shadok-ai/<tag>` et son worktree ne sont JAMAIS mergés ni
   supprimés automatiquement — c'est l'utilisateur qui merge.

Agents parallèles : répéter `spawn` (un id par agent), lancer les `prompt`
en arrière-plan simultanément.

## Garde-fous

- Ne JAMAIS `stop` une session que cette conversation n'a pas créée : elle
  appartient peut-être à l'utilisateur dans l'UI web. `stop` termine la
  session pour tous ses clients.
- Chaque agent consomme le quota Claude comme une session normale. Ne pas
  multiplier les agents sans demande explicite de l'utilisateur.
- `prompt` sur une session dont le tour est déjà en cours → erreur « a
  response is already in progress » : attendre avec `dialog <id>`.
- Si un agent semble bloqué sur un état que les dialogs ne couvrent pas,
  regarder `screen <id>` (équivalent de l'« engine room » de l'UI).

## Mécanique (pour le debug)

Le serveur tue le process claude quand son dernier client WS se détache ;
`pilotctl` maintient donc un petit process « holder » détaché par agent
(commande interne `hold`), relancé au besoin par chaque commande. État
local : `~/.shadok-ai/pilotctl/<id>.json` (cwd, branch, baseSha,
holderPid). Log du serveur auto-démarré : `~/.shadok-ai/pilotctl/server.log`.
````

- [ ] **Step 2: Vérifier la découverte de la skill**

Run: `ls .claude/skills/shadok-ai-agents/ && head -5 .claude/skills/shadok-ai-agents/SKILL.md`
Expected: `SKILL.md`, `pilotctl.mjs`, `test/` ; le frontmatter s'affiche.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/shadok-ai-agents/SKILL.md
git commit -m "docs: SKILL.md de shadok-ai-agents"
```

---

### Task 6: Validation de bout en bout (manuelle, consomme du quota)

Réel serveur + réel claude. À exécuter tel quel, en signalant tout écart.

**Files:** aucun (validation).

- [ ] **Step 1: Préparer un repo jouet**

```bash
TOY=$(mktemp -d /tmp/pilotctl-e2e-XXXXXX)
git -C "$TOY" init -q && git -C "$TOY" commit -q --allow-empty -m init
```

- [ ] **Step 2: spawn --worktree**

Run: `node .claude/skills/shadok-ai-agents/pilotctl.mjs spawn --worktree --cwd "$TOY"`
Expected: `{sessionId, cwd:~/.shadok-ai/worktrees/…, branch:"shadok-ai/…"}` ; le serveur a démarré tout seul si besoin ; la session apparaît dans l'UI web ; `list` montre l'agent `live:true`.

- [ ] **Step 3: prompt simple**

Run: `node .claude/skills/shadok-ai-agents/pilotctl.mjs prompt <id> "Crée un fichier hello.txt contenant exactement: hello world" --timeout 300`
Expected: `{status:"answer", …}` — ou `{status:"dialog"}` (permission d'écriture) auquel cas répondre `choose <id> 1` et vérifier que la suite arrive.

- [ ] **Step 4: diff**

Run: `node .claude/skills/shadok-ai-agents/pilotctl.mjs diff <id>`
Expected: le diff contient `+hello world` (hello.txt).

- [ ] **Step 5: stop et conservation du worktree sale**

Run: `node .claude/skills/shadok-ai-agents/pilotctl.mjs stop <id>` puis `ls ~/.shadok-ai/worktrees/`
Expected: `{stopped:true}` ; le worktree contenant hello.txt est TOUJOURS là (sale → conservé) ; l'état local `~/.shadok-ai/pilotctl/<id>.json` a disparu ; `diff <id>` fonctionne encore via le fallback local si on ne l'a pas nettoyé — (facultatif) re-tester avant de supprimer.

- [ ] **Step 6: Commit final (fixes éventuels découverts en e2e)**

```bash
git add -A && git commit -m "fix: ajustements post-validation e2e de pilotctl" # seulement si des fixes ont été nécessaires
```

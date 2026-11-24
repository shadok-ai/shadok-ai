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

test("list --peer asks the PEER for its agents, never the local state (#423)", async () => {
  const mock = await startMockServer({
    live: [{ id: "remote-1", cwd: "/workspace", branch: null, busy: false, clients: 1, lastPrompt: "hi" }],
    sessions: [{ id: "old-remote", mtime: 1 }],
  });
  // A local state file that a plain `list` would report: it must NOT leak in.
  writeState("local-only", { sessionId: "local-only", cwd: "/only/on/caller", holderPid: process.pid });
  const url = `http://127.0.0.1:${mock.port}`;
  try {
    const r = await run(["list", "--peer-url", url, "--peer-token", "tok"]);
    assert.equal(r.peer, url);
    assert.deepEqual(r.agents.map((a) => a.sessionId), ["remote-1"]);
    assert.ok(r.agents.every((a) => !("holderPid" in a) && !("live" in a)), "no local-only fields");
    // No --cwd: the caller's cwd means nothing over there, so no resumable list.
    assert.ok(!("resumable" in r));
    const live = mock.http.find((h) => h.url === "/live");
    assert.equal(live.peer, "tok");
    assert.ok(!mock.http.some((h) => h.url.startsWith("/sessions")));
    // An explicit --cwd is a path on the peer: queried there.
    const r2 = await run(["list", "--peer-url", url, "--peer-token", "tok", "--cwd", "/workspace"]);
    assert.deepEqual(r2.resumable, [{ id: "old-remote", mtime: 1 }]);
    assert.ok(mock.http.some((h) => h.url === "/sessions?cwd=%2Fworkspace" && h.peer === "tok"));
  } finally {
    await mock.close();
  }
});

test("list --peer refused by the peer → an explicit peer-scope error, not a local list", async () => {
  const mock = await startMockServer({ liveStatus: 401, live: { error: "unauthorized" } });
  try {
    await assert.rejects(
      () => run(["list", "--peer-url", `http://127.0.0.1:${mock.port}`, "--peer-token", "tok"]),
      /peer-scope/,
    );
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

test("the diff fallback includes untracked files", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-repo-"));
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("commit", "-qm", "init", "--allow-empty");
  const baseSha = git("rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(repo, "hello.txt"), "hello world\n");

  const mock = await startMockServer(); // /diff answers "no such session"
  process.env.SHADOK_PORT = String(mock.port);
  writeState("untracked", { sessionId: "untracked", cwd: repo, baseSha, branch: "shadok-ai/u" });
  try {
    const r = await run(["diff", "untracked"]);
    assert.equal(r.fallback, true);
    assert.match(r.diff, /\+hello world/);
  } finally {
    await mock.close();
  }
});

// `stop` used to go through the local holder: with the holder gone (always, once
// a `prompt` over a peer link returned) it sent nothing and only cleared local
// state, so peers piled up finished agents. It now sends `stop` by id on a bare
// socket — no `start`, nothing resumed — and trusts only the server's answer.
test("stop with no live holder still stops the agent, by id, without resuming it", async () => {
  const mock = await startMockServer({ stop: [{ type: "stop-result", sessionId: "dead", ok: true }] });
  process.env.SHADOK_PORT = String(mock.port);
  writeState("dead", { sessionId: "dead", cwd: "/tmp/x", holderPid: 999999 });
  try {
    const r = await run(["stop", "dead"]);
    assert.equal(r.stopped, true);
    assert.equal(readState("dead"), null);
    assert.deepEqual(mock.received.map((m) => m.type), ["stop"]); // no start → no resume
    assert.equal(mock.received[0].sessionId, "dead");
  } finally {
    await mock.close();
  }
});

test("stop over a peer link needs no local state and sends the stop to the peer", async () => {
  const mock = await startMockServer({ stop: [{ type: "stop-result", sessionId: "w1", ok: true }] });
  try {
    const r = await run(["stop", "w1", "--peer-url", `http://127.0.0.1:${mock.port}`, "--peer-token", "T"]);
    assert.equal(r.stopped, true);
    assert.deepEqual(mock.received.map((m) => m.type), ["stop"]);
  } finally {
    await mock.close();
  }
});

test("a refused stop keeps the local state and says why", async () => {
  const mock = await startMockServer({ stop: [{ type: "error", message: "a restricted peer may only stop its own agents", code: "peer-scope" }] });
  process.env.SHADOK_PORT = String(mock.port);
  writeState("theirs", { sessionId: "theirs", cwd: "/tmp/x", holderPid: null });
  try {
    const r = await run(["stop", "theirs"]);
    assert.equal(r.stopped, false);
    assert.equal(r.code, "peer-scope");
    assert.ok(readState("theirs"));
  } finally {
    await mock.close();
  }
});

test("a local agent pilotctl never drove needs --force", async () => {
  const mock = await startMockServer({ stop: [{ type: "stop-result", sessionId: "ui-1", ok: true }] });
  process.env.SHADOK_PORT = String(mock.port);
  try {
    const r = await run(["stop", "ui-1"]);
    assert.equal(r.stopped, false);
    assert.match(r.note, /--force/);
    assert.equal(mock.received.length, 0);
    assert.equal((await run(["stop", "ui-1", "--force"])).stopped, true);
  } finally {
    await mock.close();
  }
});

test("reap over a restricted peer closes its idle leftovers, never a busy or watched one", async () => {
  const mock = await startMockServer({
    live: [
      { id: "done", busy: false, clients: 0, idleSec: 4000 },
      { id: "dormant", busy: false, clients: 0, idleSec: -1, running: false },
      { id: "working", busy: true, clients: 0, idleSec: 9000 },
      { id: "watched", busy: false, clients: 1, idleSec: 9000 },
      { id: "fresh", busy: false, clients: 0, idleSec: 60 },
    ],
    liveHeaders: { "x-shadok-peer-scope": "restricted" },
    stop: [{ type: "stop-result", sessionId: "done", ok: true }],
  });
  try {
    const url = `http://127.0.0.1:${mock.port}`;
    const dry = await run(["reap", "--peer-url", url, "--peer-token", "T", "--dry-run"]);
    assert.deepEqual(dry.wouldStop, ["done", "dormant"]);
    assert.equal(mock.received.length, 0);
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


test("runs when invoked through a SYMLINKED skill directory (group HOME)", async () => {
  // In a group HOME, ~/.claude/skills/shadok-ai-agents is a symlink to the
  // machine-wide copy. path.resolve(argv[1]) does not follow links while
  // import.meta.url does, so a naive entry guard exited 0 printing nothing.
  const { execFile } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const skillDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-link-"));
  const link = path.join(dir, "shadok-ai-agents");
  fs.symlinkSync(skillDir, link);
  const mock = await startMockServer({ sessions: [{ id: "old-1", mtime: 123 }] });
  const res = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(link, "pilotctl.mjs"), "list"],
      { env: { ...process.env, SHADOK_PORT: String(mock.port) } },
      (e, out, err) => resolve({ code: e ? (e.code ?? 1) : 0, out, err }),
    );
  });
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(res.code, 0, res.err);
  assert.notEqual(res.out.trim(), "", "no output through the link");
  assert.deepEqual(JSON.parse(res.out).resumable, [{ id: "old-1", mtime: 123 }]);
});

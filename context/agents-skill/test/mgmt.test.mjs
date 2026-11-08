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
  // the test process' pid: alive, simulates an active holder
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

test("stop with a live holder but a dead session cleans up and reports stopped:false", async () => {
  const mock = await startMockServer({
    start: [{ type: "error", message: "no session" }],
  });
  process.env.SHADOK_PORT = String(mock.port);
  writeState("zombie", { sessionId: "zombie", cwd: "/tmp/x", holderPid: process.pid });
  try {
    const r = await run(["stop", "zombie"]);
    assert.equal(r.stopped, false);
    assert.match(r.note, /not reattachable/);
    assert.equal(readState("zombie"), null);
  } finally {
    await mock.close();
  }
});

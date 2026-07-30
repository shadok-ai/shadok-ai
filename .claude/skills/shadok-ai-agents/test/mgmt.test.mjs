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

test("diff fallback inclut les fichiers non suivis", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-repo-"));
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("commit", "-qm", "init", "--allow-empty");
  const baseSha = git("rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(repo, "hello.txt"), "hello world\n");

  const mock = await startMockServer(); // /diff répond "no such session"
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

test("stop avec holder vivant mais session morte nettoie et rapporte stopped:false", async () => {
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

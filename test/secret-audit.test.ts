import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditRow, spawnActor, httpActor, profileSecretDiff, parseAudit, filterAudit,
  recordSecretAudit, readSecretAudit, AUDIT_ROTATE_BYTES, type SecretAuditRow,
} from "../src/secret-audit.js";

test("secret audit: a row names secrets, deduped and sorted; none → no row", () => {
  const r = auditRow({ action: "injected", secrets: ["B", "A", "B", " ", null], actor: "ada", via: "web", instance: "/x" }, 5);
  assert.deepEqual(r?.secrets, ["A", "B"]);
  assert.equal(r?.at, 5);
  assert.equal(auditRow({ action: "injected", secrets: [], actor: "ada", via: "web", instance: "/x" }, 5), null);
});

test("secret audit: a row never carries a value field, whatever is passed", () => {
  const r = auditRow({ action: "created", secrets: ["TOKEN"], actor: "ada", via: "web", instance: "/x", value: "s3cret" } as never, 1);
  assert.ok(!JSON.stringify(r).includes("s3cret"));
});

test("secret audit: the most specific principal is credited with a spawn", () => {
  // pilotctl authenticates as the bootstrap admin: the parent agent must win.
  assert.deepEqual(spawnActor({ account: "admin", origin: "cli", parent: "1234567890ab" }), { actor: "agent 12345678", via: "agent" });
  assert.deepEqual(spawnActor({ account: "admin", origin: "web", peer: "lab" }), { actor: "peer lab", via: "peer" });
  assert.deepEqual(spawnActor({ account: "admin", origin: "cron" }), { actor: "cron", via: "cron" });
  assert.deepEqual(spawnActor({ account: "admin", origin: "telegram", from: "Ada" }), { actor: "telegram Ada", via: "telegram" });
  assert.deepEqual(spawnActor({ account: "bob", origin: "web" }), { actor: "bob", via: "web" });
  assert.deepEqual(spawnActor({}), { actor: "unknown", via: "system" });
});

test("secret audit: an agent's key beats the admin account it authenticates as", () => {
  assert.deepEqual(httpActor({ agentId: "abcdef0123", account: "admin", browser: false }), {
    actor: "agent abcdef01", via: "agent", agent: "abcdef0123",
  });
  assert.deepEqual(httpActor({ account: "bob", browser: true }), { actor: "bob", via: "web" });
  assert.deepEqual(httpActor({ account: "admin", browser: false }), { actor: "admin", via: "api" });
});

test("secret audit: profile diff reports both directions", () => {
  assert.deepEqual(profileSecretDiff(["A", "B"], ["B", "C"]), { added: ["C"], removed: ["A"] });
  assert.deepEqual(profileSecretDiff(undefined, undefined), { added: [], removed: [] });
});

test("secret audit: parse skips torn lines; filter narrows, newest first", () => {
  const rows: SecretAuditRow[] = [
    { at: 1, action: "created", secrets: ["A"], actor: "ada", via: "web", instance: "/x" },
    { at: 3, action: "injected", secrets: ["A", "B"], actor: "bob", via: "web", agent: "a1b2c3", agentName: "general", instance: "/x" },
    { at: 2, action: "injected", secrets: ["B"], actor: "cron", via: "cron", agent: "ffff", instance: "/x" },
  ];
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n{torn";
  const parsed = parseAudit(text);
  assert.equal(parsed.length, 3);
  assert.deepEqual(filterAudit(parsed, {}).map((r) => r.at), [3, 2, 1]);
  assert.deepEqual(filterAudit(parsed, { secret: "A" }).map((r) => r.at), [3, 1]);
  assert.deepEqual(filterAudit(parsed, { action: "injected", agent: "GEN" }).map((r) => r.at), [3]);
  assert.deepEqual(filterAudit(parsed, { actor: "cro" }).map((r) => r.at), [2]);
  assert.deepEqual(filterAudit(parsed, { since: 2, limit: 1 }).map((r) => r.at), [3]);
});

test("secret audit: written 600, appended, rotated once, read back in order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-"));
  try {
    const file = path.join(dir, "audit.jsonl");
    recordSecretAudit({ action: "created", secrets: ["A"], actor: "ada", via: "web", instance: "/x" }, file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // Force a rotation: the next write moves the big file aside.
    fs.appendFileSync(file, "x".repeat(AUDIT_ROTATE_BYTES + 1) + "\n");
    recordSecretAudit({ action: "deleted", secrets: ["A"], actor: "ada", via: "web", instance: "/x" }, file);
    assert.ok(fs.existsSync(file + ".1"));
    assert.deepEqual(readSecretAudit(file).map((r) => r.action), ["created", "deleted"]);
    // Nothing to name → nothing written.
    assert.equal(recordSecretAudit({ action: "injected", secrets: [], actor: "x", via: "system", instance: "/x" }, file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

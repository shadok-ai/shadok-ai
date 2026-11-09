import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "social.mjs");

async function stub(status, body) {
  const seen = {};
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.key = req.headers["x-shadok-session-key"];
      seen.body = raw ? JSON.parse(raw) : undefined;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

function run(args, port, stdin = "") {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env, SHADOK_PORT: String(port), SHADOK_SESSION_KEY: "key-123" } },
      (e, out, err) => resolve({ code: e ? (e.code ?? 1) : 0, out, err }),
    );
    child.stdin.end(stdin);
  });
}

test("post --stdin sends the body and the session key; pending is explained", async () => {
  const s = await stub(200, { status: "pending", draftId: "ab12cd34" });
  const r = await run(["post", "--account", "a1b2c3d4", "--image", "/tmp/x.png", "--stdin"], s.port, "Hello world\n");
  await s.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(s.seen.url, "/social/posts");
  assert.equal(s.seen.key, "key-123");
  assert.deepEqual(s.seen.body, { account: "a1b2c3d4", text: "Hello world", image: "/tmp/x.png" });
  assert.match(r.out, /Draft ab12cd34 is waiting for approval in the cockpit\. Do not say it is published until you are told\./);
  assert.doesNotMatch(r.out + r.err, /key-123/);
});

test("published prints the URL", async () => {
  const s = await stub(200, { status: "published", url: "https://linkedin.com/feed/update/1" });
  const r = await run(["post", "--account", "a1", "--stdin"], s.port, "Hi");
  await s.close();
  assert.match(r.out, /https:\/\/linkedin\.com\/feed\/update\/1/);
});

test("a relative --image is refused locally", async () => {
  const s = await stub(200, {});
  const r = await run(["post", "--account", "a1", "--image", "pic.png", "--stdin"], s.port, "Hi");
  await s.close();
  assert.notEqual(r.code, 0);
  assert.match(r.err, /absolute/);
  assert.equal(s.seen.body, undefined);
});

test("without --stdin the post is refused", async () => {
  const s = await stub(200, {});
  const r = await run(["post", "--account", "a1"], s.port);
  await s.close();
  assert.notEqual(r.code, 0);
  assert.match(r.err, /--stdin/);
  assert.equal(s.seen.body, undefined);
});

test("text over 3000 code points is refused locally; exactly 3000 goes", async () => {
  const s = await stub(200, { status: "pending", draftId: "d" });
  const over = await run(["post", "--account", "a1", "--stdin"], s.port, "😀".repeat(3001));
  assert.notEqual(over.code, 0);
  assert.match(over.err, /3,001 characters; LinkedIn allows 3,000\./);
  assert.equal(s.seen.body, undefined);
  const ok = await run(["post", "--account", "a1", "--stdin"], s.port, "😀".repeat(3000));
  await s.close();
  assert.equal(ok.code, 0, ok.err);
});

test("a server refusal prints its sentence on stderr and exits 1", async () => {
  const s = await stub(403, { error: "That account is not shared with you." });
  const r = await run(["post", "--account", "a1", "--stdin"], s.port, "Hi");
  await s.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /That account is not shared with you\./);
  assert.equal(r.out, "");
});

test("accounts prints only the known fields, never a token", async () => {
  const s = await stub(200, { accounts: [
    { id: "a1b2c3d4e5f6", label: "Me", provider: "linkedin", kind: "x", policy: "approve", expiresAt: Date.UTC(2027, 0, 5), status: "ok", token: "SECRET-TOK" },
    { id: "ffeeddcc", label: "Co", provider: "linkedin", policy: "autonomous", expiresAt: Date.UTC(2026, 0, 1), status: "expired" },
  ] });
  const r = await run(["accounts"], s.port);
  await s.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(s.seen.key, "key-123");
  assert.doesNotMatch(r.out, /SECRET-TOK|token/i);
  const lines = r.out.trim().split("\n");
  assert.equal(lines[0], "a1b2c3d4  Me  linkedin  policy=approve  expires=2027-01-05");
  assert.equal(lines[1], "ffeeddcc  Co  linkedin  policy=autonomous  expires=2026-01-01  EXPIRED");
});

test("accounts with none says how to connect one", async () => {
  const s = await stub(200, { accounts: [] });
  const r = await run(["accounts"], s.port);
  await s.close();
  assert.equal(r.out.trim(), "No LinkedIn account is available to this agent. Ask the person to connect one in Secrets → Connected accounts, or to share theirs with this agent's group.");
});

test("SKILL.md code fences are copy-pasteable: heredoc terminators and commands start at column 0", async () => {
  const { readFileSync } = await import("node:fs");
  const md = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8").split("\n");
  let inFence = false;
  for (const line of md) {
    if (line.trim().startsWith("```")) { inFence = !inFence; continue; }
    if (line.trim() === "EOF") assert.equal(line, "EOF", "indented heredoc terminator");
    if (inFence && line.trim().startsWith("node ")) assert.ok(line.startsWith("node "), `indented command: ${line}`);
  }
});

test("the local post limit equals the server's MAX_COMMENTARY", async () => {
  const { readFileSync } = await import("node:fs");
  const here = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const local = here("../scripts/social.mjs").match(/const MAX_CHARS = (\d+)/);
  const server = here("../../../src/linkedin.ts").match(/export const MAX_COMMENTARY = (\d+)/);
  assert.ok(local && server);
  assert.equal(local[1], server[1]);
});

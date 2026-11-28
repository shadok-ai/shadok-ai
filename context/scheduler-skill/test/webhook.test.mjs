import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeCockpit } from "./fake-cockpit.mjs";
import { parseArgs, resolveMine, callInstructions, UsageError } from "../scripts/webhook.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "webhook.mjs");

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env, SHADOK_PORT: "", SHADOK_SESSION_ID: "", SHADOK_SESSION_KEY: "", ...env } },
      (e, out, err) => resolve({ code: e ? (e.code ?? 1) : 0, out, err }),
    );
  });
}
const AGENT = (port) => ({ SHADOK_PORT: String(port), SHADOK_SESSION_ID: "sess-1", SHADOK_SESSION_KEY: "key-1" });
const HOOK = { id: "aaaaaaaa-1111", sessionId: "sess-1", name: "nightly import", prompt: "Summarise the import.", enabled: true, createdBy: "agent", path: "/hooks/aaaaaaaa-1111", url: "https://cockpit.example/hooks/aaaaaaaa-1111" };

test("parseArgs keeps the documented commands and refuses the rest", () => {
  assert.deepEqual(parseArgs(["add", "--name", "n", "--prompt", "p"]), { cmd: "add", id: undefined, opts: { name: "n", prompt: "p" } });
  assert.deepEqual(parseArgs(["update", "abc", "--pause"]), { cmd: "update", id: "abc", opts: { enabled: false } });
  assert.deepEqual(parseArgs(["update", "abc", "--resume", "--prompt", "x"]), { cmd: "update", id: "abc", opts: { enabled: true, prompt: "x" } });
  assert.deepEqual(parseArgs(["rotate", "abc"]), { cmd: "rotate", id: "abc", opts: {} });
  for (const bad of [[], ["nope"], ["add"], ["add", "--prompt"], ["add", "--prompt", "p", "--pause"], ["update", "abc"], ["del"], ["del", "a", "b"], ["list", "x"], ["add", "--prompt", "p", "--session", "other"], ["update", "abc", "--pause", "--resume"]]) {
    assert.throws(() => parseArgs(bad), UsageError, JSON.stringify(bad));
  }
});

test("an id prefix names one of this agent's own webhooks, or nothing", () => {
  const list = [HOOK, { ...HOOK, id: "aaaabbbb-2222" }, { ...HOOK, id: "cccccccc-3333", sessionId: "sess-2" }];
  assert.equal(resolveMine(list, "sess-1", "aaaaaaaa").id, "aaaaaaaa-1111");
  assert.throws(() => resolveMine(list, "sess-1", "aaaa"), /matches 2/);
  // Another agent's webhook is not found, even by its full id.
  assert.throws(() => resolveMine(list, "sess-1", "cccccccc-3333"), /no webhook/);
});

test("the call instructions never invent a host", () => {
  const known = callInstructions(HOOK, "whk_secret");
  assert.match(known, /POST https:\/\/cockpit\.example\/hooks\/aaaaaaaa-1111/);
  assert.match(known, /Bearer whk_secret/);
  const unknown = callInstructions({ ...HOOK, url: null }, "whk_secret");
  assert.match(unknown, /<the cockpit's public address>\/hooks\/aaaaaaaa-1111/);
  assert.match(unknown, /do not guess a host/);
  assert.doesNotMatch(unknown, /127\.0\.0\.1|localhost/);
});

test("refuses to run outside a shadok-ai channel", async () => {
  const r = await run(["list"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Not inside a shadok-ai channel/);
});

test("add sends the name and the prompt, never a target, and prints the token once", async () => {
  const srv = await fakeCockpit({ "POST /webhooks": { body: { ...HOOK, token: "whk_once" } } });
  try {
    const r = await run(["add", "--name", "nightly import", "--prompt", "Summarise the import."], AGENT(srv.port));
    assert.equal(r.code, 0, r.err);
    // The server takes the target from the session key: the script names none.
    assert.deepEqual(srv.seen[0].body, { name: "nightly import", prompt: "Summarise the import." });
    assert.match(r.out, /whk_once/);
    assert.match(r.out, /https:\/\/cockpit\.example\/hooks\/aaaaaaaa-1111/);
  } finally {
    await srv.close();
  }
});

test("del resolves the prefix against this agent's list before deleting", async () => {
  const srv = await fakeCockpit({ "GET /webhooks": { body: [HOOK, { ...HOOK, id: "dddddddd-4444", sessionId: "sess-2" }] }, "DELETE /webhooks/aaaaaaaa-1111": { body: { ok: true } } });
  try {
    const miss = await run(["del", "dddddddd"], AGENT(srv.port));
    assert.equal(miss.code, 1);
    assert.match(miss.err, /no webhook/);
    assert.ok(!srv.seen.some((q) => q.method === "DELETE"));
    const hit = await run(["del", "aaaaaaaa"], AGENT(srv.port));
    assert.equal(hit.code, 0, hit.err);
    assert.ok(srv.seen.some((q) => q.method === "DELETE" && q.path === "/webhooks/aaaaaaaa-1111"));
  } finally {
    await srv.close();
  }
});

test("a cockpit that keeps webhooks person-only gets a sentence, not a status code", async () => {
  const srv = await fakeCockpit({ "POST /webhooks": { status: 403, body: { error: "same-origin browser only" } } });
  try {
    const r = await run(["add", "--prompt", "p"], AGENT(srv.port));
    assert.equal(r.code, 1);
    assert.match(r.err, /Ask the person to add it/);
  } finally {
    await srv.close();
  }
});

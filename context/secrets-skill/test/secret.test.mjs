import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeCockpit } from "./fake-cockpit.mjs";
import { parseArgs } from "../scripts/secret.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "secret.mjs");

/** Runs secret.mjs against `port`, feeding `stdin`. Never puts a value in argv. */
function run(args, port, stdin, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env, SHADOK_PORT: port === null ? "" : String(port), SHADOK_AUTH: "sk_auth=tok", ...env } },
      (e, out, err) => resolve({ code: e ? (e.code ?? 1) : 0, out, err }),
    );
    child.stdin.end(stdin);
  });
}

test("set reads the value from stdin and sends it in the body", async () => {
  const srv = await fakeCockpit(200, { names: ["A"], result: "created" });
  const res = await run(["set", "A", "--stdin"], srv.port, "s3cr3t\n");
  await srv.close();
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(srv.seen.body, { name: "A", value: "s3cr3t" });
  // No cookie any more, even if one sits in the env: the session key is an
  // agent's only credential.
  assert.equal(srv.seen.cookie, undefined);
  // The value must never be echoed back — the reply lands in the transcript.
  assert.doesNotMatch(res.out, /s3cr3t/);
  // And the user has to be told the secret is inert until attached.
  assert.match(res.out, /profile/i);
});

test("set --attach creates and attaches in ONE request", async () => {
  // Two calls (store, then attach) used to leave "stored, but NOT attached"
  // behind; the server now does both in the same write, or neither.
  const srv = await fakeCockpit(200, { names: ["A"], result: "created", attached: "Shadok-Marketing" });
  const res = await run(["set", "A", "--stdin", "--attach"], srv.port, "s3cr3t\n");
  await srv.close();
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(srv.seen.paths, ["PUT /secrets"]);
  assert.deepEqual(srv.seen.body, { name: "A", value: "s3cr3t", attach: true });
  assert.match(res.out, /attached to your profile \(Shadok-Marketing\)/);
  assert.doesNotMatch(res.out, /s3cr3t/);
});

test("set --attach falls back to the attach route on a server that ignores `attach`", async () => {
  // A seeded script can be newer than the server it calls (invariant 57).
  const srv = await fakeCockpit(200, { names: ["A"], result: "created", profile: "Shadok-dev" });
  const res = await run(["set", "A", "--stdin", "--attach"], srv.port, "s3cr3t\n");
  await srv.close();
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(srv.seen.paths, ["PUT /secrets", "PUT /profiles/secret"]);
  assert.deepEqual(srv.seen.body, { name: "A" });
  assert.match(res.out, /attached to your profile \(Shadok-dev\)/);
});

test("set requires --stdin, so a value can never be passed in argv", async () => {
  const srv = await fakeCockpit(200, {});
  const res = await run(["set", "A"], srv.port, "");
  await srv.close();
  assert.notEqual(res.code, 0);
  assert.match(res.err, /--stdin/);
  assert.equal(srv.seen.body, undefined);
});

test("a value offered as an argument is refused, and never leaves the process", async () => {
  // The whole point of the design: `ps` shows a process's arguments to every
  // user on the machine, so there must be no argv shape that carries a value.
  const srv = await fakeCockpit(200, {});
  const res = await run(["set", "A", "s3cr3t"], srv.port, "");
  await srv.close();
  assert.notEqual(res.code, 0);
  assert.equal(srv.seen.body, undefined);
  assert.throws(() => parseArgs(["set", "A", "s3cr3t", "--stdin"]), /unrecognized/);
  assert.throws(() => parseArgs(["set", "A", "--value", "s3cr3t"]), /unrecognized/);
});

test("there is no way to read a value back — no `get`", async () => {
  const srv = await fakeCockpit(200, {});
  const res = await run(["get", "A"], srv.port, "");
  await srv.close();
  assert.notEqual(res.code, 0);
  assert.match(res.err, /invalid choice/);
  assert.equal(srv.seen.method, undefined);
});

test("an existing name is refused, and the script does not retry", async () => {
  const srv = await fakeCockpit(409, { error: "exists", name: "A" });
  const res = await run(["set", "A", "--stdin"], srv.port, "v");
  await srv.close();
  assert.notEqual(res.code, 0);
  assert.match(res.err, /already exists/i);
});

test("empty stdin is refused before anything is sent", async () => {
  const srv = await fakeCockpit(200, {});
  const res = await run(["set", "A", "--stdin"], srv.port, "   \n");
  await srv.close();
  assert.notEqual(res.code, 0);
  assert.equal(srv.seen.body, undefined);
});

test("list prints the NAMES the vault holds, and says when it is empty", async () => {
  const full = await fakeCockpit(200, { names: ["A", "B"] });
  const res = await run(["list"], full.port, "");
  await full.close();
  assert.equal(res.code, 0, res.err);
  assert.equal(res.out.trim(), "A\nB");

  const empty = await fakeCockpit(200, { names: [] });
  const res2 = await run(["list"], empty.port, "");
  await empty.close();
  assert.match(res2.out, /vault empty/);
});

test("refuses to run outside a shadok-ai agent", async () => {
  const res = await run(["list"], null, "");
  assert.notEqual(res.code, 0);
  assert.match(res.err, /SHADOK_PORT/);
});

test("runs when invoked through a SYMLINKED skill directory (group HOME)", async () => {
  // In a group HOME, ~/.claude/skills/shadok-secrets is a symlink to the
  // machine-wide copy. Node resolves links in import.meta.url but not in
  // argv[1]: a naive entry guard exited 0 having done NOTHING — a silent
  // no-op on a write tool, which the agent cannot tell from success.
  const { mkdtempSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "secret-link-"));
  const link = path.join(dir, "shadok-secrets");
  symlinkSync(path.dirname(path.dirname(SCRIPT)), link);
  const srv = await fakeCockpit(200, { names: ["A", "B"] });
  const res = await new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [path.join(link, "scripts", "secret.mjs"), "list"],
      { env: { ...process.env, SHADOK_PORT: String(srv.port), SHADOK_AUTH: "sk_auth=tok" } },
      (e, out, err) => resolve({ code: e ? (e.code ?? 1) : 0, out, err }),
    );
    child.stdin.end("");
  });
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(res.code, 0, res.err);
  assert.equal(res.out.trim(), "A\nB", "no output through the link");
});

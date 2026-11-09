import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpServersVerdict, profileArgs } from "../src/profiles.js";
import { profileSaveBody } from "../public/profile-card.js";
import { launcherScript } from "../src/tmux.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const matomo = {
  type: "http",
  url: "https://example.matomo.cloud/mcp",
  headers: { Authorization: "Bearer ${MATOMO_TOKEN}" },
};

test("mcpServersVerdict: empty means none", () => {
  for (const raw of [undefined, null, "", {}])
    assert.deepEqual(mcpServersVerdict(raw), { ok: true, servers: undefined });
});

test("mcpServersVerdict: keeps a valid http and stdio server as typed", () => {
  const gsc = { command: "uvx", args: ["mcp-search-console==0.3.2"], env: { GSC_OAUTH_CLIENT_SECRETS_FILE: "/x" } };
  const v = mcpServersVerdict({ matomo, gsc });
  assert.deepEqual(v, { ok: true, servers: { matomo, gsc } });
});

test("mcpServersVerdict: refuses malformed configs with a reason", () => {
  const bad: unknown[] = [
    [],
    { "bad name": matomo },
    { m: "not an object" },
    { m: { type: "ws", url: "x" } },
    { m: { type: "http" } },
    { m: {} },
    { m: { command: "x", args: "one" } },
    { m: { command: "x", env: { A: 1 } } },
    { m: { type: "http", url: "x", headers: { A: ["b"] } } },
  ];
  for (const raw of bad) {
    const v = mcpServersVerdict(raw);
    assert.equal(v.ok, false, JSON.stringify(raw));
    if (!v.ok) assert.ok(v.error.length > 0);
  }
});

// The point of the feature is that a token is NAMED in the config, never
// written: a pasted vault value would land in profiles.json and in argv.
test("mcpServersVerdict: refuses a vault value pasted instead of ${NAME}", () => {
  const pasted = { ...matomo, headers: { Authorization: "Bearer abcdef0123456789" } };
  const v = mcpServersVerdict({ matomo: pasted }, ["abcdef0123456789"]);
  assert.equal(v.ok, false);
  assert.equal(mcpServersVerdict({ matomo }, ["abcdef0123456789"]).ok, true);
  // too short to match on without false positives
  assert.equal(mcpServersVerdict({ matomo }, ["http"]).ok, true);
});

test("profileArgs: emits --mcp-config with the ${NAME} reference untouched", () => {
  const args = profileArgs({ name: "m", mcpServers: { matomo } });
  const i = args.indexOf("--mcp-config");
  assert.ok(i >= 0);
  assert.deepEqual(JSON.parse(args[i + 1]), { mcpServers: { matomo } });
  assert.ok(args[i + 1].includes("${MATOMO_TOKEN}"));
});

// --mcp-config is variadic: whatever follows it must be a flag, or the CLI
// would read it as a second config.
test("profileArgs: --mcp-config is always followed by a flag", () => {
  for (const extra of [{}, { model: "opus" }, { systemPrompt: "role" }]) {
    const args = profileArgs({ name: "m", mcpServers: { matomo }, ...extra });
    const i = args.indexOf("--mcp-config");
    assert.ok(args[i + 2]?.startsWith("--"), JSON.stringify(args));
  }
});

test("profileArgs: no flag without servers", () => {
  assert.equal(profileArgs({ name: "m" }).includes("--mcp-config"), false);
  assert.equal(profileArgs({ name: "m", mcpServers: {} }).includes("--mcp-config"), false);
});

test("profileSaveBody: carries mcpServers, so a save never drops them", () => {
  const b = profileSaveBody({ name: "m", prompt: "", deny: [], model: "", mcpServers: { matomo } }, { tracked: true, forked: false });
  assert.deepEqual(b.mcpServers, { matomo });
});

// The real spawn path: the tmux launcher single-quotes every argument, so `sh`
// must hand the CLI the literal `${MATOMO_TOKEN}` (expanded later, by the CLI,
// from env) — never the value, which `ps` would show machine-wide.
test("tmux launcher: the secret reaches env, argv keeps only its name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-launch-"));
  const out = path.join(dir, "out.json");
  const dump = path.join(dir, "dump.mjs");
  fs.writeFileSync(dump, `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env.MATOMO_TOKEN }));`);
  const { script } = launcherScript({
    unset: [],
    env: { MATOMO_TOKEN: "s3cret-value-123" },
    forced: {},
    bin: process.execPath,
    args: [dump, ...profileArgs({ name: "m", mcpServers: { matomo } })],
  });
  const file = path.join(dir, "launch.sh");
  fs.writeFileSync(file, script);
  execFileSync("sh", [file]);
  const got = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(got.env, "s3cret-value-123");
  assert.ok(got.argv.join(" ").includes("${MATOMO_TOKEN}"));
  assert.ok(!got.argv.join(" ").includes("s3cret-value-123"));
  fs.rmSync(dir, { recursive: true, force: true });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GAUGE_WARN_MS,
  REFRESH_BACKOFF_MS,
  REFRESH_LEAD_MS,
  createGauge,
  gaugeConfigDir,
  gaugeEnv,
  gaugeState,
  parseGaugeCreds,
  refreshInvocation,
  refreshOnce,
  shouldRefresh,
  usableAccessToken,
  usageCandidates,
  type ExecFn,
  type GaugeCreds,
} from "../src/gauge-login.js";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const H = 3600_000;
const D = 24 * H;

const creds = (over: Partial<GaugeCreds> = {}): GaugeCreds => ({
  accessToken: "sk-ant-oat01-ACCESS",
  hasRefreshToken: true,
  accessExpiresAt: NOW + 6 * H,
  refreshExpiresAt: NOW + 20 * D,
  scopes: ["user:profile", "user:inference"],
  ...over,
});

const blob = (o: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: o });

test("the gauge dir is per instance and away from ~/.claude", () => {
  const d = gaugeConfigDir("/home/x", "-srv-cockpit");
  assert.equal(d, "/home/x/.shadok-ai/gauge/-srv-cockpit/.claude");
  assert.notEqual(d, "/home/x/.claude");
  assert.notEqual(gaugeConfigDir("/home/x", "a"), gaugeConfigDir("/home/x", "b"));
});

test("gaugeEnv points the CLI at the gauge dir and drops credential overrides", () => {
  const env = gaugeEnv(
    { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "agents-token", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CONFIG_DIR: "/elsewhere" },
    "/g/.claude",
  );
  assert.equal(env.CLAUDE_CONFIG_DIR, "/g/.claude");
  assert.equal(env.PATH, "/bin");
  // An env token outranks a stored login in the CLI: leaving it would make the
  // gauge login read the AGENTS' identity (a setup-token, no user:profile).
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) assert.equal(env[k], undefined, k);
});

test("parseGaugeCreds reads the two expiries and scopes, tolerates garbage", () => {
  const c = parseGaugeCreds(
    blob({ accessToken: "a", refreshToken: "r", expiresAt: 5, refreshTokenExpiresAt: 9, scopes: ["user:profile"] }),
  );
  assert.deepEqual(c, { accessToken: "a", hasRefreshToken: true, accessExpiresAt: 5, refreshExpiresAt: 9, scopes: ["user:profile"] });
  assert.equal(parseGaugeCreds("not json"), null);
  assert.equal(parseGaugeCreds("null"), null);
  assert.equal(parseGaugeCreds(blob({}))?.accessToken, null);
});

test("gaugeState: none / ok / expiring / expired / wrong-scope", () => {
  assert.equal(gaugeState(null, NOW), "none");
  assert.equal(gaugeState(creds({ accessToken: null, hasRefreshToken: false }), NOW), "none");
  assert.equal(gaugeState(creds(), NOW), "ok");
  assert.equal(gaugeState(creds({ refreshExpiresAt: NOW + GAUGE_WARN_MS - 1 }), NOW), "expiring");
  assert.equal(gaugeState(creds({ refreshExpiresAt: NOW + GAUGE_WARN_MS }), NOW), "ok");
  assert.equal(gaugeState(creds({ refreshExpiresAt: NOW }), NOW), "expired");
  assert.equal(gaugeState(creds({ refreshExpiresAt: NOW - D }), NOW), "expired");
  assert.equal(gaugeState(creds({ scopes: ["user:inference"] }), NOW), "wrong-scope");
  // No scope list in the blob asserts nothing either way.
  assert.equal(gaugeState(creds({ scopes: null }), NOW), "ok");
  // An unknown refresh expiry is never reported as expiring.
  assert.equal(gaugeState(creds({ refreshExpiresAt: null }), NOW), "ok");
});

test("usableAccessToken offers a live token only", () => {
  assert.equal(usableAccessToken(creds(), NOW), "sk-ant-oat01-ACCESS");
  assert.equal(usableAccessToken(null, NOW), null);
  assert.equal(usableAccessToken(creds({ accessExpiresAt: NOW - 1 }), NOW), null);
  assert.equal(usableAccessToken(creds({ accessExpiresAt: NOW + 30_000 }), NOW), null, "inside the skew");
  assert.equal(usableAccessToken(creds({ scopes: ["user:inference"] }), NOW), null);
  assert.equal(usableAccessToken(creds({ accessToken: null }), NOW), null);
});

test("shouldRefresh: only inside the lead window, never past the wall, with a backoff", () => {
  assert.equal(shouldRefresh(null, NOW, null), false);
  assert.equal(shouldRefresh(creds(), NOW, null), false, "6h left, not due");
  assert.equal(shouldRefresh(creds({ accessExpiresAt: NOW + REFRESH_LEAD_MS - 1 }), NOW, null), true);
  assert.equal(shouldRefresh(creds({ accessExpiresAt: NOW - H }), NOW, null), true, "already lapsed");
  assert.equal(shouldRefresh(creds({ accessExpiresAt: null }), NOW, null), true);
  assert.equal(shouldRefresh(creds({ hasRefreshToken: false, accessExpiresAt: NOW }), NOW, null), false);
  assert.equal(shouldRefresh(creds({ accessExpiresAt: NOW, refreshExpiresAt: NOW - 1 }), NOW, null), false, "no way left to renew");
  const due = creds({ accessExpiresAt: NOW });
  assert.equal(shouldRefresh(due, NOW, NOW - REFRESH_BACKOFF_MS + 1), false);
  assert.equal(shouldRefresh(due, NOW, NOW - REFRESH_BACKOFF_MS), true);
});

test("usageCandidates: gauge login first, then the vault token, then the live store", () => {
  assert.deepEqual(usageCandidates({ gauge: "G", longLived: "L", live: "V" }), ["G", "L", "V"]);
  // No gauge login = exactly the list the server built before this feature.
  assert.deepEqual(usageCandidates({ gauge: null, longLived: "L", live: "V" }), [null, "L", "V"]);
});

test("the refresh command is a minimal `-p` call — there is no `claude auth refresh`", () => {
  const { args } = refreshInvocation();
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(!args.includes("auth"), "must not invent an auth subcommand");
});

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gauge-test-"));
}
function writeCreds(dir: string, o: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".credentials.json"), blob(o));
}

test("refreshOnce runs in the gauge dir with the scrubbed env, and judges by the file", async () => {
  const dir = tmpDir();
  writeCreds(dir, { accessToken: "a", refreshToken: "r", expiresAt: NOW + 1000, refreshTokenExpiresAt: NOW + 20 * D });
  let seen: Parameters<ExecFn> | null = null;
  const advancing: ExecFn = async (...a) => {
    seen = a;
    writeCreds(dir, { accessToken: "a2", refreshToken: "r2", expiresAt: NOW + 8 * H, refreshTokenExpiresAt: NOW + 20 * D });
    return { error: null };
  };
  const ok = await refreshOnce(dir, () => NOW, advancing, { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "agents" });
  assert.deepEqual(ok, { at: NOW, ok: true });
  assert.equal(seen![2].env.CLAUDE_CONFIG_DIR, dir);
  assert.equal(seen![2].cwd, dir);
  assert.equal(seen![2].env.CLAUDE_CODE_OAUTH_TOKEN, undefined);

  // Exit 0 but the store did not move: NOT a success.
  const inert: ExecFn = async () => ({ error: null });
  const stuck = await refreshOnce(dir, () => NOW, inert, {});
  assert.equal(stuck.ok, false);
  assert.match(stuck.error!, /did not advance/);

  const failing: ExecFn = async () => ({ error: "spawn ENOENT" });
  assert.equal((await refreshOnce(dir, () => NOW, failing, {})).error, "spawn ENOENT");
});

test("createGauge: no credential = inert; a credential is read from its own dir only", () => {
  const home = tmpDir();
  const g = createGauge({ home, key: "k1", now: () => NOW, platform: "linux" });
  assert.equal(g.dir, path.join(home, ".shadok-ai", "gauge", "k1", ".claude"));
  assert.equal(g.token(), null);
  assert.equal(g.view().state, "none");
  // A credential in the user's ordinary store must never be picked up.
  writeCreds(path.join(home, ".claude"), { accessToken: "AGENT", refreshToken: "r", expiresAt: NOW + H });
  assert.equal(g.token(), null);
  writeCreds(g.dir, { accessToken: "GAUGE", refreshToken: "r", expiresAt: NOW + 6 * H, refreshTokenExpiresAt: NOW + 20 * D });
  assert.equal(g.token(), "GAUGE");
  assert.equal(g.view().state, "ok");
  assert.equal(g.forget(), true);
  assert.equal(g.token(), null);
  assert.equal(fs.existsSync(g.dir), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", ".credentials.json")), true, "the other store is untouched");
});

test("createGauge on macOS is unsupported: the keychain is not the file we read", () => {
  const home = tmpDir();
  const g = createGauge({ home, key: "k", now: () => NOW, platform: "darwin" });
  writeCreds(g.dir, { accessToken: "GAUGE", refreshToken: "r", expiresAt: NOW + 6 * H });
  assert.equal(g.token(), null);
  assert.equal(g.view().supported, false);
});

test("tick refreshes a due token once, records the outcome, and backs off", async () => {
  const home = tmpDir();
  let t = NOW;
  let calls = 0;
  const g = createGauge({
    home, key: "k", now: () => t, platform: "linux",
    exec: async () => {
      calls++;
      writeCreds(g.dir, { accessToken: "a2", refreshToken: "r", expiresAt: t + 8 * H, refreshTokenExpiresAt: NOW + 20 * D });
      return { error: null };
    },
  });
  writeCreds(g.dir, { accessToken: "a", refreshToken: "r", expiresAt: NOW + 10 * 60_000, refreshTokenExpiresAt: NOW + 20 * D });
  const lines: string[] = [];
  await g.tick((l) => lines.push(l));
  assert.equal(calls, 1);
  assert.equal(g.view().lastRefresh?.ok, true);
  assert.match(lines[0], /refreshed/);
  assert.ok(!lines.join().includes("a2"), "never log a token");
  await g.tick();
  assert.equal(calls, 1, "fresh now, nothing due");
});

test("the gauge login child gets its own config dir (0700) and leaves the instance's alone", async (t) => {
  const { claudeCommand } = await import("../src/claude-bin.js");
  try { claudeCommand(); } catch { return t.skip("no claude binary"); }
  const home = tmpDir();
  const g = createGauge({ home, key: "k", platform: "linux" });
  const r = await g.login.start(true);
  try {
    if ("error" in r) return t.skip("claude printed no URL here: " + r.error);
    assert.match((r as { url: string }).url, /^https:\/\//);
    assert.equal(g.login.pending(), true);
    assert.equal(fs.statSync(g.dir).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(home, ".claude", ".credentials.json")), false);
  } finally {
    g.login.cancel();
  }
});

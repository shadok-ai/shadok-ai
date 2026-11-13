import assert from "node:assert/strict";
import test from "node:test";
import { effectiveToken, parseLegacyToken, telegramConfig, applyTelegramPatch, titleForCwd, themeForCwd, mutedForCwd, agentAuthForCwd } from "../src/config.js";

test("effectiveToken: an explicit env var always wins", () => {
  assert.equal(
    effectiveToken({ tokens: { "/x": "cfg" } }, "/x", { TELEGRAM_BOT_TOKEN: "env" } as any),
    "env",
  );
});

test("effectiveToken: falls back to this dir's configured token", () => {
  assert.equal(effectiveToken({ tokens: { "/x": "cfg" } }, "/x", {} as any), "cfg");
});

test("effectiveToken: is per directory — another dir's token doesn't leak", () => {
  assert.equal(effectiveToken({ tokens: { "/x": "cfg" } }, "/other", {} as any), null);
});

test("effectiveToken: null/undefined means no token", () => {
  assert.equal(effectiveToken({ tokens: { "/x": null } }, "/x", {} as any), null);
  assert.equal(effectiveToken({}, "/x", {} as any), null);
});

test("parseLegacyToken: extracts TELEGRAM_BOT_TOKEN from an env file", () => {
  assert.equal(parseLegacyToken("TELEGRAM_BOT_TOKEN=123:abc\n"), "123:abc");
  assert.equal(parseLegacyToken('export TELEGRAM_BOT_TOKEN="123:abc"'), "123:abc");
  assert.equal(parseLegacyToken("NOTHING=here"), null);
});

test("telegramConfig: env token wins and marks envOverride", () => {
  const c = telegramConfig({ tokens: { "/x": "cfg" } }, "/x", { TELEGRAM_BOT_TOKEN: "env" } as any);
  assert.equal(c.token, "env");
  assert.equal(c.envOverride, true);
});

test("telegramConfig: falls back to this dir's config token, no override", () => {
  const c = telegramConfig({ tokens: { "/x": "cfg" } }, "/x", {} as any);
  assert.equal(c.token, "cfg");
  assert.equal(c.envOverride, false);
});

test("telegramConfig: enabled defaults to true, explicit false respected", () => {
  assert.equal(telegramConfig({}, "/x", {} as any).enabled, true);
  assert.equal(telegramConfig({ telegramEnabled: { "/x": false } }, "/x", {} as any).enabled, false);
});

test("telegramConfig: allowedChats from env (comma-split) wins over config", () => {
  const c = telegramConfig(
    { telegramAllowed: { "/x": ["1"] } },
    "/x",
    { TELEGRAM_ALLOWED_CHATS: "7, 8 ,9" } as any,
  );
  assert.deepEqual(c.allowedChats, ["7", "8", "9"]);
});

test("telegramConfig: allowedChats from config when no env, [] default", () => {
  assert.deepEqual(telegramConfig({ telegramAllowed: { "/x": ["1", "2"] } }, "/x", {} as any).allowedChats, ["1", "2"]);
  assert.deepEqual(telegramConfig({}, "/x", {} as any).allowedChats, []);
});

test("applyTelegramPatch: sets token, enabled, allowedChats per cwd; absent keys untouched", () => {
  const out = applyTelegramPatch({ tokens: { "/x": "old" } }, "/x", { enabled: false }, false);
  assert.equal(out.telegramEnabled!["/x"], false);
  assert.equal(out.tokens!["/x"], "old"); // token key absent → unchanged
});

test("applyTelegramPatch: empty-string/null token removes it", () => {
  assert.equal(applyTelegramPatch({ tokens: { "/x": "t" } }, "/x", { token: "" }, false).tokens!["/x"], null);
  assert.equal(applyTelegramPatch({ tokens: { "/x": "t" } }, "/x", { token: null }, false).tokens!["/x"], null);
});

test("applyTelegramPatch: envOverride ignores token but still applies other fields", () => {
  const out = applyTelegramPatch({ tokens: { "/x": "keep" } }, "/x", { token: "new", allowedChats: ["9"] }, true);
  assert.equal(out.tokens!["/x"], "keep"); // env wins → token untouched
  assert.deepEqual(out.telegramAllowed!["/x"], ["9"]); // other fields still applied
});

test("applyTelegramPatch: does not mutate the input config", () => {
  const input = { tokens: { "/x": "old" } };
  applyTelegramPatch(input, "/x", { token: "new" }, false);
  assert.equal(input.tokens["/x"], "old");
});

test("titleForCwd: this dir's name, trimmed", () => {
  assert.equal(titleForCwd({ cockpitTitle: { "/x": "  Prod  " } }, "/x"), "Prod");
});

test("titleForCwd: null when unset, blank, or another dir", () => {
  assert.equal(titleForCwd({}, "/x"), null);
  assert.equal(titleForCwd({ cockpitTitle: { "/x": "   " } }, "/x"), null);
  assert.equal(titleForCwd({ cockpitTitle: { "/x": "Prod" } }, "/other"), null);
});

test("themeForCwd: a known non-default palette is returned per dir", () => {
  assert.equal(themeForCwd({ cockpitTheme: { "/x": "emerald" } }, "/x"), "emerald");
  assert.equal(themeForCwd({ cockpitTheme: { "/x": "emerald" } }, "/other"), null);
});

test("themeForCwd: default, unknown, or unset resolve to null", () => {
  assert.equal(themeForCwd({}, "/x"), null);
  assert.equal(themeForCwd({ cockpitTheme: { "/x": "amber" } }, "/x"), null); // default stored as absent
  assert.equal(themeForCwd({ cockpitTheme: { "/x": "chartreuse" } }, "/x"), null); // unknown ignored
});

test("mutedForCwd: true only for this dir's explicit true", () => {
  assert.equal(mutedForCwd({ cockpitMuted: { "/x": true } }, "/x"), true);
  assert.equal(mutedForCwd({ cockpitMuted: { "/x": true } }, "/other"), false); // per dir
  assert.equal(mutedForCwd({}, "/x"), false); // unset = not muted
  assert.equal(mutedForCwd({ cockpitMuted: { "/x": false } }, "/x"), false); // explicit false
});

test("agentAuthForCwd: 'login' only for this dir's explicit 'login', else 'token'", () => {
  assert.equal(agentAuthForCwd({ agentAuth: { "/x": "login" } }, "/x"), "login");
  assert.equal(agentAuthForCwd({ agentAuth: { "/x": "login" } }, "/other"), "token"); // per dir
  assert.equal(agentAuthForCwd({}, "/x"), "token"); // unset = default token
  assert.equal(agentAuthForCwd({ agentAuth: { "/x": "token" } }, "/x"), "token"); // explicit default
  // A malformed value never silently switches auth away from the safe default.
  assert.equal(agentAuthForCwd({ agentAuth: { "/x": "bogus" as "token" } }, "/x"), "token");
});

// ── The config file is never torn, and never replaced over an unreadable one ──
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConfigFile, writeConfigFile } from "../src/config.js";

const tmpConfig = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shadok-cfg-")), "config.json");

test("readConfigFile: absent is an empty config, safe to write", () => {
  assert.deepEqual(readConfigFile(tmpConfig()), { cfg: {}, unreadable: false });
});

test("readConfigFile: an empty, torn or non-object file is UNREADABLE, not empty", () => {
  for (const body of ["", '{"tokens": {"/x": "1:a"', "[]", "null"]) {
    const f = tmpConfig();
    fs.writeFileSync(f, body);
    assert.equal(readConfigFile(f).unreadable, true, JSON.stringify(body));
  }
});

test("writeConfigFile: refuses to replace an unreadable file with an almost-empty config", () => {
  // The wipe: a torn read became `{}`, and the next ordinary save wrote `{}` + one
  // field over every token. The bytes on disk must survive instead.
  const f = tmpConfig();
  fs.writeFileSync(f, '{"tokens": {"/x": "1:a"}');
  assert.equal(writeConfigFile(f, { cockpitTitle: { "/x": "T" } }), false);
  assert.equal(fs.readFileSync(f, "utf8"), '{"tokens": {"/x": "1:a"}');
});

test("writeConfigFile: writes 600 through a rename, leaving no temp file behind", () => {
  const f = tmpConfig();
  assert.equal(writeConfigFile(f, { tokens: { "/x": "1:a" } }), true);
  assert.deepEqual(readConfigFile(f), { cfg: { tokens: { "/x": "1:a" } }, unreadable: false });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ["config.json"]);
});

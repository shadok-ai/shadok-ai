import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  profileWriteRefusal,
  profileDeleteRefusal,
  promptWriteRefusal,
  mayReadMcpValues,
  redactMcpServers,
  setProfileRefusal,
  restartAllPlan,
  monoSecretRefusal,
  MCP_REDACTED,
} from "../src/route-guards.js";
import { mergeChannels, type Channel } from "../src/channels.js";
import { linkRefusal } from "../src/kinship.js";

// The per-route authorization decisions are pure and tested here; the WIRING in
// `server.ts` (un-importable without starting a server) is locked by the
// source-scan suite at the bottom, like `test/server-acl-leaks.test.ts`.

const MT = "multi-tenant";
const MONO = "mono-tenant";

// ── Profiles ──────────────────────────────────────────────────────────────────
test("PUT /profiles: browser-only always; admin-only in multi-tenant; any person in mono-tenant", () => {
  assert.equal(profileWriteRefusal({ mode: MONO, fromBrowser: false, role: "admin" })?.status, 403);
  assert.equal(profileWriteRefusal({ mode: MONO, fromBrowser: true, role: "member" }), null);
  assert.equal(profileWriteRefusal({ mode: MT, fromBrowser: true, role: "member" })?.status, 403);
  assert.equal(profileWriteRefusal({ mode: MT, fromBrowser: true, role: "admin" }), null);
  assert.equal(profileWriteRefusal({ mode: MT, fromBrowser: true, role: null })?.status, 403);
});

test("PUT /profiles/prompt: refused in multi-tenant (profiles are global), open in mono-tenant", () => {
  assert.equal(promptWriteRefusal({ mode: MT })?.status, 403);
  assert.equal(promptWriteRefusal({ mode: MONO }), null);
});

test("DELETE /profiles: an agent (no browser) is refused even as the bootstrap admin; a member too", () => {
  assert.equal(profileDeleteRefusal({ fromBrowser: false, role: "admin" })?.status, 403);
  assert.equal(profileDeleteRefusal({ fromBrowser: true, role: "member" })?.status, 403);
  assert.equal(profileDeleteRefusal({ fromBrowser: true, role: "admin" }), null);
});

test("GET /profiles: MCP values are masked for whoever cannot write the profile, keys kept", () => {
  assert.equal(mayReadMcpValues({ mode: MONO, role: "member" }), true);
  assert.equal(mayReadMcpValues({ mode: MT, role: "member" }), false);
  assert.equal(mayReadMcpValues({ mode: MT, role: "admin" }), true);
  const servers = {
    gh: { command: "gh-mcp", env: { TOKEN: "literal-value", OTHER: "${X}" } },
    web: { type: "http" as const, url: "https://x", headers: { Authorization: "Bearer abc" } },
    bare: { command: "noenv" },
  };
  const out = redactMcpServers(servers)!;
  assert.deepEqual(out.gh.env, { TOKEN: MCP_REDACTED, OTHER: MCP_REDACTED });
  assert.equal(out.gh.command, "gh-mcp");
  assert.deepEqual(out.web.headers, { Authorization: MCP_REDACTED });
  assert.equal(out.web.url, "https://x");
  assert.deepEqual(out.bare, { command: "noenv" });
  assert.equal(servers.gh.env.TOKEN, "literal-value", "the stored object is never mutated");
  assert.equal(redactMcpServers(undefined), undefined);
});

test("WS set-profile: never an agent or a peer; admin-only in multi-tenant", () => {
  // An agent resolves to the bootstrap admin today — the person bit is what refuses it.
  assert.ok(setProfileRefusal({ mode: MONO, person: false, role: "admin" }));
  assert.ok(setProfileRefusal({ mode: MT, person: false, role: "admin" }));
  assert.equal(setProfileRefusal({ mode: MONO, person: true, role: "member" }), null);
  assert.ok(setProfileRefusal({ mode: MT, person: true, role: "member" }));
  assert.equal(setProfileRefusal({ mode: MT, person: true, role: "admin" }), null);
});

// ── restart-all ───────────────────────────────────────────────────────────────
test("restart-all: a bare call is admin-only; a session list is narrowed to what the caller may drive", () => {
  const mayDrive = (id: string) => id !== "foreign";
  assert.equal(restartAllPlan({ ids: undefined, isAdmin: false, mayDrive }).ok, false);
  assert.equal(restartAllPlan({ ids: [], isAdmin: false, mayDrive }).ok, false);
  assert.deepEqual(restartAllPlan({ ids: undefined, isAdmin: true, mayDrive }), { ok: true, ids: undefined });
  assert.deepEqual(restartAllPlan({ ids: ["a", "foreign", "b"], isAdmin: false, mayDrive }), {
    ok: true,
    ids: ["a", "b"],
  });
  // An admin's list is narrowed too: an admin is not special inside a group they are not in.
  assert.deepEqual(restartAllPlan({ ids: ["foreign"], isAdmin: true, mayDrive }), { ok: true, ids: [] });
});

// ── Secrets (mono-tenant) ─────────────────────────────────────────────────────
test("mono-tenant vault: overwrite and delete are admin acts", () => {
  assert.ok(monoSecretRefusal({ op: "overwrite", role: "member" }));
  assert.ok(monoSecretRefusal({ op: "delete", role: "member" }));
  assert.ok(monoSecretRefusal({ op: "delete", role: null }));
  assert.equal(monoSecretRefusal({ op: "overwrite", role: "admin" }), null);
  assert.equal(monoSecretRefusal({ op: "delete", role: "admin" }), null);
});

// ── PUT /channels merge ───────────────────────────────────────────────────────
const ch = (sessionId: string, extra: Partial<Channel> = {}): Channel =>
  ({ sessionId, name: sessionId, cwd: "/r", ...extra }) as Channel;

test("mergeChannels: a member's PUT preserves the dormant rows of a group it cannot see", () => {
  const stored = [ch("mine"), ch("theirs", { group: "rh", name: "payroll" }), ch("gone")];
  const canSee = (c: Channel) => c.group !== "rh";
  // The member's tab only ever held `mine` (GET /channels filtered `theirs` out).
  const out = mergeChannels(stored, [ch("mine", { name: "renamed" })], new Set(), canSee);
  const byId = new Map(out.map((c) => [c.sessionId, c]));
  assert.equal(byId.get("mine")?.name, "renamed");
  assert.deepEqual(byId.get("theirs"), stored[1], "an invisible row survives untouched");
  assert.equal(byId.has("gone"), false, "a visible row the client dropped is still dropped (unchanged rule)");
});

test("mergeChannels: a client row naming an invisible session is ignored — no rename, no mute", () => {
  const stored = [ch("theirs", { group: "rh", name: "payroll" })];
  const out = mergeChannels(stored, [ch("theirs", { name: "pwned", muted: true } as Partial<Channel>)], new Set(), (c) => c.group !== "rh");
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], stored[0]);
});

test("mergeChannels: without a visibility rule nothing changes (mono-tenant)", () => {
  const stored = [ch("a"), ch("b", { group: "rh" })];
  const out = mergeChannels(stored, [ch("a")], new Set());
  assert.deepEqual(out.map((c) => c.sessionId), ["a"]);
});

// ── Kinship ───────────────────────────────────────────────────────────────────
test("linkRefusal: a parent the caller cannot drive is refused with the SAME answer as an unknown one", () => {
  const chans = [ch("child"), ch("victim", { group: "rh" })];
  const reach = (id: string) => id !== "victim";
  assert.equal(linkRefusal(chans, "child", "victim", reach), "unknown-parent");
  assert.equal(linkRefusal(chans, "child", "nope", reach), "unknown-parent");
  assert.equal(linkRefusal(chans, "child", "victim"), null, "no rule → unchanged behaviour");
  assert.equal(linkRefusal(chans, "child", null, () => false), null, "detaching is always allowed");
});

// ── Wiring locks (source-scan) ────────────────────────────────────────────────
const SERVER_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"),
  "utf8",
);

/** The text of one route handler: from its registration to the next `app.`. */
function route(method: string, p: string): string {
  const start = SERVER_SRC.indexOf(`app.${method}("${p}"`);
  assert.ok(start >= 0, `route ${method.toUpperCase()} ${p} must exist`);
  const rest = SERVER_SRC.slice(start + 10);
  const next = rest.search(/\napp\.(get|put|post|delete|use)\(/);
  return next > 0 ? rest.slice(0, next) : rest;
}
/** The text of one WS case. */
function wsCase(name: string): string {
  const start = SERVER_SRC.indexOf(`case "${name}": {`);
  assert.ok(start > 0, `case "${name}" must exist`);
  const rest = SERVER_SRC.slice(start + name.length);
  const next = rest.search(/\n\s{8}(case "|default:)/);
  return next > 0 ? rest.slice(0, next) : rest;
}

test("wiring: instance-wide settings are admin-only (accountAdmin) as their FIRST check", () => {
  const admin: Array<[string, string]> = [
    ["post", "/autoupdate"],
    ["post", "/ledger"],
    ["post", "/update-channel"],
    ["post", "/permission-mode"],
    ["post", "/auth/login"],
    ["post", "/auth/code"],
    ["delete", "/auth/login"],
    ["put", "/title"],
    ["put", "/theme"],
    ["post", "/tweak/prepare"],
  ];
  for (const [m, p] of admin) {
    const body = route(m, p);
    const gate = body.indexOf("accountAdmin(req, res, true");
    assert.ok(gate > 0, `${m.toUpperCase()} ${p} must call accountAdmin`);
    // Before any write: the gate must precede the first saveConfig/start/…
    for (const effect of ["saveConfig", "startLogin", "submitLoginCode", "cancelLogin", "setTitleForCwd", "setThemeForCwd", "ensureSelfRepo"]) {
      const at = body.indexOf(effect);
      if (at >= 0) assert.ok(gate < at, `${m.toUpperCase()} ${p}: accountAdmin must run before ${effect}`);
    }
  }
});

test("wiring: profile routes carry their verdicts", () => {
  assert.ok(route("put", "/profiles").includes("profileWriteRefusal("));
  assert.ok(route("post", "/profiles/restore").includes("profileWriteRefusal("));
  const del = route("delete", "/profiles");
  assert.ok(del.indexOf("profileDeleteRefusal(") >= 0 && del.indexOf("profileDeleteRefusal(") < del.indexOf("removeProfile("));
  assert.ok(route("get", "/profiles").includes("redactMcpServers("));
  // The agent-side prompt write is mode-gated BEFORE it consults the per-profile
  // rule or writes: the lead's "any profile" branch must never run in multi-tenant.
  const prompt = route("put", "/profiles/prompt");
  const gate = prompt.indexOf("promptWriteRefusal({ mode: DEPLOYMENT_MODE })");
  assert.ok(gate > 0, "PUT /profiles/prompt must call promptWriteRefusal");
  assert.ok(gate < prompt.indexOf("promptEditVerdict("));
  assert.ok(gate < prompt.indexOf("upsertProfile("));
});

test("wiring: restart-all, DELETE /channel and PUT /channels are group-gated", () => {
  assert.ok(route("post", "/restart-all").includes("restartAllPlan("));
  const del = route("delete", "/channel");
  assert.ok(del.indexOf("httpMayDrive(req, id)") > 0 && del.indexOf("httpMayDrive(req, id)") < del.indexOf("endChannel("));
  const put = route("put", "/channels");
  assert.ok(put.includes("mergeClientChannels(body, live, canSee)"));
  assert.ok(put.includes("res.json(merged.filter(canSee))"), "the reply must not list rows the caller cannot see");
  assert.ok(!put.includes("channels: loadChannels()"), "nor the 409 reply");
});

test("wiring: set-profile needs a person; set-parent and start.parent check the parent's group", () => {
  assert.ok(wsCase("set-profile").includes("setProfileRefusal("));
  assert.ok(wsCase("set-parent").includes("linkRefusal(loadChannels(), s.id, wanted, mayDriveSession)"));
  assert.ok(SERVER_SRC.includes("linkRefusal(loadChannels(), id, msg.parent ?? null, mayDriveSession)"));
});

test("wiring: mono-tenant secret overwrite/delete go through monoSecretRefusal", () => {
  const put = route("put", "/secrets");
  assert.ok(put.indexOf("monoSecretRefusal(") > 0 && put.indexOf("monoSecretRefusal(") < put.indexOf("setSecret(key"));
  const del = route("delete", "/secrets");
  assert.ok(del.indexOf("monoSecretRefusal(") > 0 && del.indexOf("monoSecretRefusal(") < del.indexOf("deleteSecret("));
});

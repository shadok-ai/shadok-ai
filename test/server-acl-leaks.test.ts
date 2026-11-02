import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canResumeAs,
  canSeeGroup,
  canSeeSession,
  listableGroups,
  viewerFor,
  MAIN_GROUP_ID,
  type Group,
} from "../src/groups.js";
import type { Channel } from "../src/channels.js";
import { secretWriteDecision } from "../src/secrets.js";

// Cross-group leaks closed in Task 10 follow-up. The DECISIONS are pure and
// tested here with the brief's exact fixtures; the WIRING in `server.ts` (which
// cannot be imported without starting a server — see `test/twofactor.test.ts`)
// is locked by the source-scan suite at the bottom, the same pattern as
// `test/ws-url.test.ts`. The scan is what defends invariant 24: the gate
// EXISTS in code but must be on the path the leak travels.

// ── Fixtures: a restricted group G (COMEX) and a member who is NOT in it ───────
const groups: Group[] = [
  { id: "main", name: "main", nature: "public", members: [], createdAt: 0 },
  { id: "comex", name: "COMEX", nature: "restricted", members: ["ada"], createdAt: 0 },
];
const ada = { name: "ada", role: "member" as const }; // IN COMEX
const bob = { name: "bob", role: "member" as const }; // NOT in COMEX
const admin = { name: "root", role: "admin" as const }; // bootstrap-admin shape (agents authenticate as this)

// ── CRITICAL 1: resuming a session whose channel is in restricted G ────────────
test("resume authorization: a member NOT in G is refused; a member of G and a group-less session are allowed", () => {
  // The `start` resume gate is `canResumeAs(storedGroup, groups, viewer)`. It
  // now runs ABOVE the live-attach branch, so a LIVE foreign-group session is
  // refused exactly as a dormant one — no history/screen/stream is delivered.
  assert.equal(canResumeAs("comex", groups, viewerFor(bob)), false); // foreign group → forbidden
  assert.equal(canResumeAs("comex", groups, viewerFor(ada)), true); // own group → allowed
  assert.equal(canResumeAs(null, groups, viewerFor(bob)), true); // group-less / mono-tenant → allowed
  assert.equal(canResumeAs("ghost", groups, viewerFor(ada)), false); // dangling group → fail closed
});

// ── IMPORTANT 3: GET /live visibility — the predicate the handler filters on ───
test("GET /live visibility: a member NOT in G cannot see G's sessions; group-less/commons stay visible", () => {
  // `/live` maps each live session to its channel's group and keeps only those
  // where `canSeeGroup(group, viewer)` — the same decision `mayDriveSession`
  // uses. A session in COMEX is omitted for bob, kept for ada; a group-less
  // (commons) session is visible to everyone.
  const comex = groups.find((g) => g.id === "comex")!;
  const main = groups.find((g) => g.id === "main")!;
  assert.equal(canSeeGroup(comex, viewerFor(bob)), false); // omitted from bob's /live
  assert.equal(canSeeGroup(comex, viewerFor(ada)), true); // present in ada's /live
  assert.equal(canSeeGroup(main, viewerFor(bob)), true); // commons always visible
});

// ── CRITICAL 2: term-* drive/see gate — same decision as the other drives ──────
test("term-* gate: a member NOT in G cannot attach/input/resize a foreign-group session", () => {
  // term-attach (SEE), term-input and term-resize (DRIVE) all route through
  // `mayDriveSession` → `canSeeGroup(group, viewer)`. A foreign group → refused.
  const comex = groups.find((g) => g.id === "comex")!;
  assert.equal(canSeeGroup(comex, viewerFor(bob)), false); // → forbidden
  assert.equal(canSeeGroup(comex, viewerFor(ada)), true); // own group → allowed
});

// ── ⚠️ private-group AGENT writes its OWN secret ───────────────────────────────
test("secret write: a private-group AGENT writes its own group's secret; a non-member browser cannot", () => {
  const withPriv: Group[] = [
    ...groups,
    { id: "ada-priv", name: "Ada", nature: "private", members: [], owner: "ada", createdAt: 0 },
  ];
  // An AGENT in a PRIVATE group (its channel's group = ada-priv) authenticates
  // as the bootstrap admin, NOT as the private owner — the owner-name rule would
  // refuse a human here, but the agent writes into the group it was SPAWNED into.
  const agent = secretWriteDecision({ agentGroupId: "ada-priv", viewer: admin, groups: withPriv });
  assert.deepEqual(agent, { ok: true, ownerGroup: "ada-priv" });
  // An agent in a restricted group (bootstrap admin) still writes there.
  const agentComex = secretWriteDecision({ agentGroupId: "comex", viewer: admin, groups: withPriv });
  assert.deepEqual(agentComex, { ok: true, ownerGroup: "comex" });
  // A HUMAN (browser) member of COMEX is a plain member, not admin → refused.
  const member = secretWriteDecision({ viewer: ada, groups: withPriv });
  assert.equal(member.ok, false);
  // An agent whose group does not resolve fails closed (never write blind).
  const dangling = secretWriteDecision({ agentGroupId: "ghost", viewer: admin, groups: withPriv });
  assert.equal(dangling.ok, false);
  // Mono-tenant (no groups) → Main, allowed — byte-for-byte today's.
  assert.deepEqual(secretWriteDecision({ agentGroupId: null, viewer: admin, groups: [] }), {
    ok: true,
    ownerGroup: MAIN_GROUP_ID,
  });
});

// ── Final-fix wave: four more cross-group read leaks ───────────────────────────

const withPrivate: Group[] = [
  { id: "main", name: "main", nature: "public", members: [], createdAt: 0 },
  { id: "comex", name: "COMEX", nature: "restricted", members: ["ada"], createdAt: 0 },
  { id: "ada-priv", name: "Ada", nature: "private", members: ["ada"], owner: "ada", createdAt: 0 },
  { id: "bob-priv", name: "Bob", nature: "private", members: ["bob"], owner: "bob", createdAt: 0 },
];

// ── MUST-FIX 1: GET /groups is filtered by the caller ──────────────────────────
test("listableGroups: a non-member omits a restricted group's row AND a foreign private group", () => {
  // bob is in neither COMEX nor ada-priv. He keeps public Main and his own
  // private group; COMEX (restricted, not a member) and ada-priv (foreign
  // private) are both omitted — their members/owner never reach him.
  const seen = listableGroups(withPrivate, viewerFor(bob)).map((g) => g.id);
  assert.deepEqual(seen.sort(), ["bob-priv", "main"]);
});
test("listableGroups: an ADMIN non-member SEES restricted groups but NOT a foreign private group", () => {
  // The admin nuance: root administers COMEX's membership/secrets without being a
  // member, so COMEX's row (existence + members) MUST survive — a plain
  // canSeeGroup would wrongly hide it. But a private group root does not own stays
  // hidden: "a private group is invisible even to an admin". root owns none here.
  const seen = listableGroups(withPrivate, viewerFor(admin)).map((g) => g.id);
  assert.deepEqual(seen.sort(), ["comex", "main"]);
  assert.ok(!seen.includes("ada-priv") && !seen.includes("bob-priv"), "no private group is visible to an admin");
});
test("listableGroups: a member sees own restricted + own private; null/mono-tenant sees public only", () => {
  const ada = { name: "ada", role: "member" as const };
  const adaSeen = listableGroups(withPrivate, viewerFor(ada)).map((g) => g.id);
  assert.deepEqual(adaSeen.sort(), ["ada-priv", "comex", "main"]);
  assert.deepEqual(listableGroups(withPrivate, null).map((g) => g.id), ["main"]); // no account → public only
  // Mono-tenant: only public Main → everyone keeps it, byte-for-byte unchanged.
  const mono: Group[] = [{ id: "main", name: "main", nature: "public", members: [], createdAt: 0 }];
  assert.deepEqual(listableGroups(mono, viewerFor(bob)).map((g) => g.id), ["main"]);
  assert.deepEqual(listableGroups(mono, null).map((g) => g.id), ["main"]);
});

// ── MUST-FIX 2 / ADJACENT: /diff, /recover, /sessions session-level gate ────────
test("canSeeSession: a session in a group the caller can't see is refused; commons/legacy visible", () => {
  const chans: Channel[] = [
    { sessionId: "S-comex", cwd: "", group: "comex" },
    { sessionId: "S-commons", cwd: "", group: null },
    { sessionId: "S-nogroup", cwd: "" }, // no group field at all → commons
  ];
  // bob is not in COMEX → its session is refused; the commons ones stay visible.
  assert.equal(canSeeSession("S-comex", chans, withPrivate, viewerFor(bob)), false);
  assert.equal(canSeeSession("S-comex", chans, withPrivate, viewerFor({ name: "ada", role: "member" })), true);
  assert.equal(canSeeSession("S-commons", chans, withPrivate, viewerFor(bob)), true);
  assert.equal(canSeeSession("S-nogroup", chans, withPrivate, viewerFor(bob)), true);
  // A session with no channel row at all (legacy) → commons, visible to everyone.
  assert.equal(canSeeSession("S-orphan", chans, withPrivate, viewerFor(bob)), true);
  assert.equal(canSeeSession(null, chans, withPrivate, viewerFor(bob)), true);
  // An admin is NOT exempt from a restricted group's sessions (runs as a member).
  assert.equal(canSeeSession("S-comex", chans, withPrivate, viewerFor(admin)), false);
  // A dangling group id fails closed.
  const dangling: Channel[] = [{ sessionId: "S-x", cwd: "", group: "ghost" }];
  assert.equal(canSeeSession("S-x", dangling, withPrivate, viewerFor(admin)), false);
});

// ── Wiring locks (source-scan) — the `server.ts` surfaces are un-importable ────
const SERVER_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"),
  "utf8",
);

test("CRIT1 wiring: the resume people-boundary gate runs BEFORE the live-attach branch", () => {
  // The leak was that `sessions.get(id)` + attach ran before `canResumeAs`, so a
  // LIVE foreign-group session was attached with no authorization. The gate must
  // sit above the attach, or the leak returns verbatim.
  const gate = SERVER_SRC.indexOf("canResumeAs(storedGroupId, groupsNow");
  const attach = SERVER_SRC.indexOf("const existing = sessions.get(id);");
  assert.ok(gate > 0, "the canResumeAs resume gate must exist");
  assert.ok(attach > 0, "the sessions.get(id) attach branch must exist");
  assert.ok(gate < attach, "canResumeAs must be hoisted ABOVE the live-attach branch");
});

test("CRIT2 wiring: each term-* case carries the mayDriveSession gate", () => {
  // term-attach (SEE), term-input / term-resize (DRIVE) each raw-pipe the agent's
  // screen or keystrokes; all three must gate, like prompt/key.
  const gate = 'if (!mayDriveSession(session.id)) return fail("you are not entitled to drive this agent", "forbidden");';
  for (const name of ["term-attach", "term-input", "term-resize"]) {
    const start = SERVER_SRC.indexOf(`case "${name}": {`);
    assert.ok(start > 0, `case "${name}" must exist`);
    // Slice to the next `case ` / `default:` so the gate is counted inside THIS case.
    const rest = SERVER_SRC.slice(start + name.length);
    const next = rest.search(/\n\s{8}(case "|default:)/);
    const body = next > 0 ? rest.slice(0, next) : rest;
    assert.ok(body.includes(gate), `case "${name}" must call mayDriveSession and refund "forbidden"`);
  }
});

test("IMPORTANT3 wiring: GET /live filters sessions by group visibility", () => {
  const live = SERVER_SRC.indexOf('app.get("/live"');
  assert.ok(live > 0, "the /live route must exist");
  const body = SERVER_SRC.slice(live, live + 1600);
  assert.ok(body.includes("visible(s.id)"), "/live must filter the session list by group visibility");
  assert.ok(body.includes("canSeeGroup(g, viewer)"), "/live visibility must use canSeeGroup");
  assert.ok(body.includes("DEPLOYMENT_MODE"), "/live must short-circuit to visible in mono-tenant");
});

// ── Task 11 wiring: the validated `group` request reaches the write decision ───
test("Task 11 wiring: secretWriteTarget reads a body/query `group` and threads it as requestedGroup", () => {
  const start = SERVER_SRC.indexOf("function secretWriteTarget(");
  assert.ok(start > 0, "secretWriteTarget must exist");
  const body = SERVER_SRC.slice(start, start + 1300);
  // It must READ a client-supplied group (body OR query — DELETE uses the query)…
  assert.ok(/\.group\b/.test(body) && body.includes("req.query"), "secretWriteTarget must read a body/query `group`");
  // …and pass it as `requestedGroup` into the (authorizing) decision, never as a
  // trusted owner. The decision — not the route — applies canWriteSecretGroup.
  assert.ok(body.includes("requestedGroup"), "the request must be threaded as requestedGroup");
  assert.ok(body.includes("secretWriteDecision({"), "authorization must go through secretWriteDecision");
  // And mono-tenant must NOT honour a requested group (back-compat: everything Main).
  assert.ok(
    body.includes("DEPLOYMENT_MODE") && body.includes("secretOwnerGroup({ ...caller, groups })"),
    "mono-tenant must ignore the request and keep today's identity-derived owner",
  );
});

// ── Final-fix wave wiring (source-scan): the four read leaks are gated ──────────

test("MUST-FIX1 wiring: GET /groups is filtered by the caller via listableGroups", () => {
  // The leak was `app.get("/groups", (_req, res) => res.json(loadGroups()))` —
  // every group's members/owner/osUser to any authenticated caller. It must now
  // read the caller (`req`, not `_req`) and filter with the admin-aware
  // listableGroups, so a non-member never sees a restricted roster or a foreign
  // private group's existence.
  const route = SERVER_SRC.indexOf('app.get("/groups"');
  assert.ok(route > 0, "the GET /groups route must exist");
  const body = SERVER_SRC.slice(route, route + 900);
  assert.ok(!/app\.get\("\/groups",\s*\(_req/.test(body), "GET /groups must not ignore the caller (_req)");
  assert.ok(body.includes("listableGroups("), "GET /groups must filter via listableGroups");
  assert.ok(
    body.includes("viewerFor(currentAccount(req))"),
    "GET /groups must derive the viewer server-side from currentAccount",
  );
});

test("MUST-FIX2 wiring: GET /diff carries the session group gate (canSeeSession) AND the peer check", () => {
  const route = SERVER_SRC.indexOf('app.get("/diff"');
  assert.ok(route > 0, "the GET /diff route must exist");
  const body = SERVER_SRC.slice(route, route + 1600);
  assert.ok(body.includes("canSeeSession("), "/diff must gate with canSeeSession");
  assert.ok(
    body.includes("viewerFor(currentAccount(req))"),
    "/diff must derive the viewer server-side from currentAccount",
  );
  assert.ok(body.includes("DEPLOYMENT_MODE"), "/diff gate must short-circuit in mono-tenant");
  // The existing remote restricted-peer behaviour must stay intact.
  assert.ok(body.includes("peerScopeFor(req)") && body.includes("ownedByPeer("), "/diff must keep the peer gate");
});

test("ADJACENT wiring: GET /recover and GET /sessions filter past sessions by group", () => {
  for (const name of ["/recover", "/sessions"]) {
    const route = SERVER_SRC.indexOf(`app.get("${name}"`);
    assert.ok(route > 0, `the GET ${name} route must exist`);
    const body = SERVER_SRC.slice(route, route + 900);
    assert.ok(body.includes("canSeeSession("), `${name} must filter sessions via canSeeSession`);
    assert.ok(
      body.includes("viewerFor(currentAccount(req))"),
      `${name} must derive the viewer server-side from currentAccount`,
    );
    assert.ok(body.includes("DEPLOYMENT_MODE"), `${name} must short-circuit in mono-tenant`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canResumeAs,
  canSeeGroup,
  viewerFor,
  MAIN_GROUP_ID,
  type Group,
} from "../src/groups.js";
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

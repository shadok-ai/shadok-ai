import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerGroupsFor, viewerFor, MAIN_GROUP_ID, type Group } from "../src/groups.js";

// Task 13 PIVOT: the ledger is ONE table scoped SERVER-SIDE by the caller's
// group. The DECISIONS are pure (ledger.ts `scopeVisible`/`recordIntoTable`,
// groups.ts `ledgerGroupsFor` — tested in test/ledger.test.ts and here); the
// WIRING in server.ts cannot be imported without a server, so it is locked by a
// source-scan, the same pattern as test/ws-url.test.ts and
// test/server-acl-leaks.test.ts. The scan defends the authoring-group invariant:
// the group a row is stamped with, and the group a read is filtered by, must
// come from the SESSION and never from the client's body.

const groups: Group[] = [
  { id: "main", name: "main", nature: "public", members: [], createdAt: 0 },
  { id: "comex", name: "COMEX", nature: "restricted", members: ["ada"], createdAt: 0 },
  { id: "sales", name: "Sales", nature: "restricted", members: ["ada", "bob"], createdAt: 0 },
];
const ada = { name: "ada", role: "member" as const }; // comex + sales
const bob = { name: "bob", role: "member" as const }; // sales only
const cleo = { name: "cleo", role: "member" as const }; // no group
const admin = { name: "root", role: "admin" as const }; // no restricted membership

test("ledgerGroupsFor: a single-group member sees own group (+public), NOT Main-private", () => {
  // bob is in sales only → his home is sales, and Main is excluded, so a
  // Main-private row never reaches him (the GET /ledger leak this fixes).
  assert.deepEqual([...ledgerGroupsFor(groups, viewerFor(bob))].sort(), ["sales"]);
});

test("ledgerGroupsFor: a multi-group member's commons home is Main, so sees Main too", () => {
  // ada is in two groups → spawnGroupFor is ambiguous → commons (Main). She sees
  // both her groups and the commons' own rows.
  assert.deepEqual([...ledgerGroupsFor(groups, viewerFor(ada))].sort(), ["comex", "main", "sales"]);
});

test("ledgerGroupsFor: NO super-view — an admin with no membership resolves to {main}", () => {
  assert.deepEqual([...ledgerGroupsFor(groups, viewerFor(admin))].sort(), ["main"]);
  // a group-less human is the same (their home is the commons)
  assert.deepEqual([...ledgerGroupsFor(groups, viewerFor(cleo))].sort(), ["main"]);
});

test("ledgerGroupsFor: mono-tenant (no groups / null viewer) collapses to {main}", () => {
  assert.deepEqual([...ledgerGroupsFor([], null)], [MAIN_GROUP_ID]);
  assert.deepEqual([...ledgerGroupsFor([], viewerFor(admin))], [MAIN_GROUP_ID]);
});

// ── Wiring locks (source-scan) ────────────────────────────────────────────────
const SERVER_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"),
  "utf8",
);

function routeBody(marker: string): string {
  const start = SERVER_SRC.indexOf(marker);
  assert.ok(start > 0, `${marker} must exist`);
  const rest = SERVER_SRC.slice(start + marker.length);
  const next = rest.indexOf("\napp.");
  return next > 0 ? rest.slice(0, next) : rest;
}

test("POST /ledger/record derives the authoring group from the SESSION, never the body", () => {
  const body = routeBody('app.post("/ledger/record"');
  // identity comes from the per-session key…
  assert.ok(body.includes("callerOf(req).id"), "must identify the caller by its session key");
  // …and the group from that session's CHANNEL, not from req.body
  assert.ok(
    body.includes("loadChannels().find((c) => c.sessionId === agentId)?.group"),
    "the authoring group must be read from the caller's channel",
  );
  // the write goes through the scoped core
  assert.ok(body.includes("recordIntoTable("), "the write must go through recordIntoTable");
  // a no-session-key caller (a browser / anonymous) is refused — writes are an
  // agent act, like the secrets skill
  assert.ok(body.includes("requires an agent session key"), "a keyless caller must be refused");
  // the group must NOT be taken from the request body
  assert.ok(!/group\s*[:=]\s*(req\.body|b)\.group/.test(body), "the group must never come from the body");
});

test("GET /ledger filters by the caller's group — agent by channel, browser by membership", () => {
  const body = routeBody('app.get("/ledger"');
  assert.ok(body.includes("scopeVisible("), "the viewer/CLI read must filter via scopeVisible");
  // the agent path keys on its channel group, and must be consulted FIRST (a
  // session key makes currentAccount the bootstrap admin)
  assert.ok(body.includes("callerOf(req).id"), "must detect an agent caller");
  assert.ok(
    body.includes("loadChannels().find((c) => c.sessionId === agentId)?.group"),
    "an agent is scoped to its channel's group",
  );
  // the browser path uses the membership-derived set, no super-view
  assert.ok(body.includes("ledgerGroupsFor(loadGroups()"), "a browser is scoped by ledgerGroupsFor");
  // it must NOT return the whole table unfiltered any more
  assert.ok(
    !/const rows = loadLedger\(ledgerFileFor\(process\.cwd\(\)\)\);\s*\n\s*rows\.sort/.test(SERVER_SRC),
    "GET /ledger must not sort+return the raw table (the unfiltered-leak shape)",
  );
});

test("the per-group ledger FILE split and the --public mirror env are gone", () => {
  assert.ok(!SERVER_SRC.includes("SHADOK_LEDGER_PUBLIC_FILE"), "no commons-mirror env var");
  assert.ok(!/ledgerFileFor\(process\.cwd\(\), group\)/.test(SERVER_SRC), "no per-group file path");
  assert.ok(!SERVER_SRC.includes("visibleLedger"), "the multi-file visibleLedger is retired");
});

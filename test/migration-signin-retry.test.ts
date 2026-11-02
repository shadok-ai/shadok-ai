import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A FRESH capable instance cannot complete its group migration at boot: the CORE
// "seed shared Claude credential" step reads `~/.claude/.credentials.json`, which
// does not exist until someone signs in — and on a brand-new instance the sign-in
// happens AFTER boot, via the web card. So the first-boot migration ALWAYS fails
// that step, withholds the marker, and raises the red "isolation did NOT complete"
// banner, and it only retries on the NEXT boot — leaving the commons un-isolated
// behind a scary banner until a MANUAL restart (observed on the mt373 test
// instance: two failed boot migrations, then a third that succeeded post-restart).
//
// The fix re-runs the migration the moment a Claude sign-in succeeds, mirroring
// `startFirstAgent` (re-fired from the same handler for the symmetric reason).
// `server.ts` is un-importable (it binds a port at import), so — like
// `test/server-system-drive.test.ts` and `test/ws-url.test.ts` — the wiring is
// locked by scanning the source. This guards against the invariant-24 class: a
// handler that typechecks and is unit-reasoned but never actually calls the retry.
const SERVER_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"),
  "utf8",
);

test("maybeRunGroupsMigration exists and is the one migration entry point", () => {
  assert.match(
    SERVER_SRC,
    /async function maybeRunGroupsMigration\(/,
    "the shared migration entry point must exist",
  );
});

test("the migration is serialised against overlapping runs", () => {
  const i = SERVER_SRC.indexOf("async function maybeRunGroupsMigration(");
  assert.ok(i > 0, "maybeRunGroupsMigration must exist");
  const body = SERVER_SRC.slice(i, i + 2400);
  assert.ok(
    /if \(migrationInFlight\)/.test(body),
    "it must skip while a migration is already in flight (boot vs sign-in overlap)",
  );
  assert.ok(
    /alreadyMigratedNow\(\)/.test(body),
    "it must short-circuit once the instance is already migrated",
  );
  assert.ok(
    /migrationInFlight = true/.test(body) && /migrationInFlight = false/.test(body),
    "it must set and clear the in-flight guard",
  );
});

test("the boot reconcile runs even on an ALREADY-migrated capable boot", () => {
  // Regression guard: the already-migrated short-circuit must still call
  // ensureGroupsProvisioned() — it heals a persisted group's missing OS user
  // after a docker recreate AND provisions the bootstrap admin's Personal group,
  // both INDEPENDENT of the migration marker. Folding the migration into
  // maybeRunGroupsMigration once dropped this call on a plain restart of a
  // migrated instance (measured on the mt373 test instance: no admin Personal
  // group, no reprovision).
  const i = SERVER_SRC.indexOf("async function maybeRunGroupsMigration(");
  assert.ok(i > 0, "maybeRunGroupsMigration must exist");
  const body = SERVER_SRC.slice(i, i + 2400);
  const guard = body.indexOf("if (alreadyMigratedNow())");
  assert.ok(guard > 0, "the already-migrated short-circuit must exist");
  // From the guard to its `return;` — the branch that runs when nothing migrates.
  const branch = body.slice(guard, body.indexOf("return;", guard) + "return;".length);
  assert.match(
    branch,
    /ensureGroupsProvisioned\(\)/,
    "the already-migrated branch must still run the boot reconcile (admin Personal + OS-user heal)",
  );
});

test("the /auth/code success path re-runs the migration", () => {
  const h = SERVER_SRC.indexOf('app.post("/auth/code"');
  assert.ok(h > 0, "the /auth/code handler must exist");
  // Scope to the handler body (up to the next route registration).
  const next = SERVER_SRC.indexOf("app.", h + 10);
  const region = SERVER_SRC.slice(h, next > h ? next : h + 1200);
  assert.match(
    region,
    /maybeRunGroupsMigration\(/,
    "a successful Claude sign-in must re-run the group migration — otherwise a fresh " +
      "instance stays un-isolated behind the red banner until a manual restart",
  );
  // It must be gated on success, next to the startFirstAgent re-fire.
  assert.ok(
    /if \(r\.ok\)/.test(region) && /startFirstAgent\(\)/.test(region),
    "the retry must sit inside the r.ok branch, beside startFirstAgent",
  );
});

test("the boot path goes through the same entry point", () => {
  assert.match(
    SERVER_SRC,
    /void maybeRunGroupsMigration\("boot"\)/,
    "boot must call the shared entry point (one code path for boot + sign-in retry)",
  );
});

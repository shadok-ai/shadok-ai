import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Agents authenticate through an injected CLAUDE_CODE_OAUTH_TOKEN, so the old
// shared-credential-FILE machinery must stay gone — while OS-user / HOME
// provisioning stays. `server.ts` is un-importable (it binds a port at import),
// so this is a source scan, like test/migration-signin-retry.test.ts.
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf8");
const osusers = read("osusers.ts");
const migrate = read("migrate-groups.ts");
const server = read("server.ts");

const GONE = [
  "migSeedSharedCredential",
  "seedSharedCredential",
  "shadok-cred",
  "SHARED_CRED_GROUP",
  "DEFAULT_SHARED_CREDENTIAL_PATH",
  "SHADOK_SHARED_CREDENTIAL_PATH",
  "credentialWiring",
  "credentialReachableReal",
  "credentialDivergenceWarned",
  "reachableFromInspection",
  "classifyCredentialLink",
  "checkCredentialDivergence",
  "warnIfCredentialDiverged",
];

for (const sym of GONE) {
  test(`shared credential file machinery is gone: ${sym}`, () => {
    for (const [name, src] of [["osusers.ts", osusers], ["migrate-groups.ts", migrate], ["server.ts", server]]) {
      assert.ok(!src.includes(sym), `${sym} must not appear in ${name}`);
    }
  });
}

test("seedGroupHome and the migration create no .credentials.json symlink", () => {
  assert.ok(!/ln["',\s\]]+.*\.credentials\.json/.test(server), "no credential symlink in server.ts");
  assert.ok(!migrate.includes(".credentials.json"), "migrate-groups must not mention .credentials.json");
});

test("OS-user + HOME provisioning is still wired", () => {
  assert.match(osusers, /export function resolveSpawnIsolation\(/);
  assert.match(osusers, /export function dropArgv\(/);
  assert.match(osusers, /export function dropEnv\(/);
  assert.match(osusers, /--create-home/, "useradd HOME creation remains");
  assert.match(osusers, /chmod["'],\s*\["700"/, "HOME 0700 wall remains");
  assert.match(server, /async function seedGroupHome\(/);
  assert.match(server, /async function migCreateCommonsUser\(/);
  assert.match(migrate, /create commons user/);
  assert.match(migrate, /deps\.writeMarker\(\)/);
});

test("the migration marker no longer depends on a credential step", () => {
  const i = migrate.indexOf("export async function runMigration");
  const body = migrate.slice(i);
  assert.ok(!/credential/i.test(body.replace(/\/\/.*$/gm, "")), "no credential step in runMigration");
});

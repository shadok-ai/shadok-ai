import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

// server.ts is un-importable, so the SHAPE of the wiring is locked by scan
// (like test/tg-guests-routes.test.ts) while every decision it calls is
// unit-tested for real in test/isolation-unit.test.ts,
// test/external-users.test.ts, test/osusers.test.ts and test/groups.test.ts.
const SRC = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

const fnBody = (sig: string): string => {
  const i = SRC.indexOf(sig);
  assert.ok(i >= 0, `missing ${sig}`);
  return SRC.slice(i, SRC.indexOf("\n}\n", i));
};

test("the conversation's account is minted at ADMISSION, before anything of theirs exists", () => {
  const start = SRC.slice(SRC.indexOf('case "start": {'), SRC.indexOf('case "prompt"'));
  const at = start.indexOf("ensureExternalUser(");
  assert.ok(at >= 0, "the external wall is not posed at all");
  // Before the working directory, the isolation resolution and any process: a
  // refusal must cost nothing but the refusal.
  for (const later of ["ensureGuestWorkDir(", "resolveSpawnIsolation({", "--session-id"])
    assert.ok(start.indexOf(later) > at, `the account must be minted before ${later}`);
  // …and after the ceiling, so a flood is turned away before it reaches
  // /etc/passwd at all (invariant 83).
  assert.ok(start.indexOf("guestAdmitVerdict({") < at);
  // Only for an external group, and only on a fresh admission.
  assert.match(start, /extGroup\?\.nature === "external"/);
  assert.match(start, /if \(!minted\.ok\) \{/);
  assert.match(start, /return fail\(minted\.why, "guest-isolation"\)/);
});

test("ensureExternalUser refuses rather than falls back, in every branch", () => {
  const body = fnBody("async function ensureExternalUser(");
  // Mono-tenant cannot pose the wall, and says so (never a cosmetic label).
  assert.match(body, /DEPLOYMENT_MODE !== "multi-tenant"/);
  assert.match(body, /need the privileged deployment/);
  // The registry's collision refusal is consulted BEFORE provisioning.
  const collision = body.indexOf("externalUserVerdict(");
  const provision = body.indexOf("provisionOsUserFor(");
  assert.ok(collision >= 0 && provision > collision, "the collision is checked before useradd");
  assert.match(body, /if \(verdict\.kind === "collision"\) return \{ ok: false, why: verdict\.why \}/);
  // A failed useradd is a refusal of the admission, not a warning.
  assert.match(body, /could not provision this conversation's user/);
  // The row is written only AFTER the account exists, so a failed attempt
  // leaves no claim behind — and the name is derived, so the retry recomputes it.
  assert.ok(body.indexOf("saveExternalUsers(") > provision);
  assert.match(body, /if \(verdict\.kind === "new"\)/);
});

test("deleting an external group removes EVERY conversation's account", () => {
  const body = fnBody("async function teardownGroupOrConversations(");
  // An ordinary group keeps the one teardown it always had.
  assert.match(body, /if \(g\.nature !== "external"\)\s*\n\s*return teardownGroupUser\(g, \{/);
  // The registry is the only thing that knows the hashed names.
  assert.match(body, /externalUsersOfGroup\(rows, g\.id\)/);
  // The agents go first, once: `userdel` cannot remove an account a process holds.
  const kill = body.indexOf("killGroupAgents(g.id)", body.indexOf("externalUsersOfGroup"));
  const del = body.indexOf('runPrivileged("userdel", ["--remove", row.user])');
  assert.ok(kill >= 0 && del > kill, "the agents are killed before the accounts are removed");
  // A row is dropped only for an account that actually went away — keeping one
  // for a surviving account is what makes the retry work, and dropping one
  // early would let a LATER conversation mint the name and inherit the home.
  assert.match(body, /if \(removed\.length\) saveExternalUsers\(withoutExternalUsers\(loadExternalUsers\(\), removed\)\)/);
  // The route uses it.
  assert.match(SRC, /teardown: \(g\) => teardownGroupOrConversations\(g\)/);
});

test("a conversation's account is reconciled at boot, like a group's", () => {
  const body = fnBody("async function reconcileExternalUsers(");
  assert.match(body, /DEPLOYMENT_MODE !== "multi-tenant"/);
  assert.match(body, /osUserExists\(row\.user\)/);
  assert.match(body, /provisionOsUserFor\(g, conv\)/);
  // A row whose group is gone is a leftover from an interrupted teardown:
  // keeping it would make the collision refusal guard a conversation nothing
  // can reach.
  assert.match(body, /if \(!g \|\| g\.nature !== "external"\)/);
  assert.match(body, /stale\.push\(row\.user\)/);
  // Never fatal: one bad row must not stop the boot.
  assert.match(body, /failed\+\+/);
  assert.match(SRC, /await reconcileExternalUsers\(\);/);
});

test("the spawn resolution carries the conversation, and refuses without it", () => {
  const start = SRC.slice(SRC.indexOf('case "start": {'), SRC.indexOf('case "prompt"'));
  // A fresh guest spawn knows it from the frame; a resume reads it off the
  // stored row's own binding (invariant 1: the registry is the authority).
  assert.match(start, /conversation: guestDir \?\? guestConversationKey\(storedRow\)/);
  assert.match(start, /conversation: guestDir,/);
  assert.equal((start.match(/if \((early)?[Ii]so(lation)?\.refusal\)/g) ?? []).length, 2);
  assert.equal((start.match(/"guest-isolation"/g) ?? []).length, 3);
});

test("a channel's own state and media follow its conversation", () => {
  // `channelStateHome` LOCATES state (a transcript, a worktree to prune) and
  // grants nothing, so a refusal there logs and reads the commons home rather
  // than throwing — which would break pruning for every other agent.
  const home = fnBody("function channelStateHome(");
  assert.match(home, /osUserOf\(g, guestConversationKey\(chan\)\)/);
  assert.match(home, /reading its state from the commons home/);
  // The media directory, on the other hand, REFUSES: an attachment with
  // nowhere safe to go is never dropped into a shared directory.
  const media = fnBody("function mediaDirForUnitOf(");
  assert.match(media, /unitFor\(g, conversation\)/);
  assert.match(media, /if \(!u\.ok\) throw new Error\(u\.why\)/);
  assert.match(media, /mediaDirForUnit\(root, u\.unit, true\)/);
  assert.match(SRC, /return mediaDirForUnitOf\(ch\.group \?\? null, guestConversationKey\(ch\)\)/);
  // A room is a conversation between PEOPLE: it has no guest conversation, so
  // an external group refuses it rather than inventing a group-level directory.
  assert.match(SRC, /return mediaDirForUnitOf\(room\.group \?\? null, null\)/);
});

test("/media maps a hashed key back through the units that EXIST", () => {
  const route = SRC.slice(SRC.indexOf('app.get(["/media/:name"'), SRC.indexOf('app.get(["/media/:name"') + 2600);
  assert.match(route, /unitForMediaKey\(ref\.key, \[\.\.\.groups\.map\(\(g\) => g\.id\), \.\.\.externalUnits\(groups, chans\)\]\)/);
  assert.match(route, /if \(!unit\) return res\.status\(404\)/);
  // Authorised by the GROUP: its members see every conversation in it, which is
  // the whole product of an external group.
  assert.match(route, /const gid = unitGroup\(unit\)/);
  const units = fnBody("function externalUnits(");
  assert.match(units, /g\.nature === "external"/);
  assert.match(units, /conversationUnit\(c\.group, conv\)/);
});

test("an external door's profile may carry no secret, and both routes ask", () => {
  assert.equal((SRC.match(/profileSecrets: \(n\) => getProfile\(n\)\?\.secrets \?\? \[\],/g) ?? []).length, 2);
});

test("no group-level user is ever invented for an external group", () => {
  // The three places that legitimately have no answer for it say so by asking
  // `groupOsUser`, which refuses — rather than taking `null`, which means THE
  // COMMONS and would have run a stranger as the shared user.
  for (const sig of ["function loginUsers(", "function ensureGroupVolumeKeys("]) {
    const body = fnBody(sig);
    assert.match(body, /groupOsUser\(g\)/, sig);
    assert.match(body, /if \(!r\.ok\) continue;|if \(r\.ok && r\.user\)/, sig);
  }
  // And the group creation flow neither stamps nor provisions one.
  const osusers = fs.readFileSync(new URL("../src/osusers.ts", import.meta.url), "utf8");
  assert.match(osusers, /const created = groupOsUser\(g\);\n\s*g\.osUser = created\.ok \? created\.user : null;/);
  assert.match(osusers, /if \(input\.nature !== "public" && input\.nature !== "external" && input\.mode === "multi-tenant"\)/);
});

test("the three nature PARSERS all know `external` — the holes a review caught", () => {
  // Each of these was a one-word omission with a different failure:
  //  - POST /groups would have created a RESTRICTED group from the External
  //    card: a label promising a wall that was never posed (invariant 47);
  //  - `normalizeGroups` would have read a stored external group back as
  //    PUBLIC, i.e. published every stranger's conversation on a reload;
  //  - `deleteGroupFlow`'s ACL named one nature, leaving an external group
  //    deletable by ANY signed-in caller, accounts and homes included.
  assert.match(
    SRC,
    /body\.nature === "private" \|\| body\.nature === "restricted" \|\| body\.nature === "external" \|\| body\.nature === "public"/,
  );
  const channels = fs.readFileSync(new URL("../src/channels.ts", import.meta.url), "utf8");
  assert.match(
    channels,
    /row\.nature === "private" \|\| row\.nature === "restricted" \|\| row\.nature === "external" \|\| row\.nature === "public"/,
  );
  const osusers = fs.readFileSync(new URL("../src/osusers.ts", import.meta.url), "utf8");
  assert.match(osusers, /if \(isRoster\(g\) && !canAdministerGroup\(g, \{ name: input\.account\.name/);
  // …and the ONE place that must still refuse it: a nature is never converted.
  const groups = fs.readFileSync(new URL("../src/groups.ts", import.meta.url), "utf8");
  assert.match(
    groups,
    /row\.nature === "private" \|\| row\.nature === "restricted" \|\| row\.nature === "public" \? row\.nature : undefined/,
  );
});

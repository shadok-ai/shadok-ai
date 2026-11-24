import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FILE_CHANGED_SENTENCE,
  GOOGLE_ACTIONS,
  actionLogged,
  actionSetting,
  actionVerdict,
  approveGoogleDraft,
  runGoogleAction,
  type ActionOutcome,
  type GoogleDeps,
} from "../src/google-actions.js";
import { GoogleInputError, MIME_DOC, sharePlan, shareMessageVerdict, shareRoleVerdict, shareTargetsVerdict, unsharePlan, type DrivePermission, type FetchFn } from "../src/google.js";
import { GOOGLE_AREA_SCOPES, type ConnectedAccount, type GooglePolicies } from "../src/connected-accounts.js";
import { draftView, makeDraft, type Draft, type FilePayload } from "../src/social-drafts.js";
import { draftCardModel, googleAutonomousConfirmText, googlePolicyRows } from "../public/social-card.js";

// Sharing a Drive file with NAMED people (`drive share`, the SHARE setting)
// and taking access away (`drive unshare`, never asks). Request shapes follow
// the Drive API v3 reference (permissions.list / create / update / delete);
// nothing here reaches Google.

const NOW = Date.UTC(2026, 10, 24, 12);
const S = GOOGLE_AREA_SCOPES;
const acct = (policies: Partial<GooglePolicies> = {}, scopes: string[] = [S.drive, S.drive_all]): ConnectedAccount => ({
  id: "g0000001", provider: "google", kind: "member", label: "ana@example.org", externalId: "sub-1", owner: "ana", connectedVia: "ana",
  share: { personal: true, groups: [], everyone: false, profiles: [] }, policy: "approve",
  policies: { mail: "approve", calendar: "approve", drive: "approve", share: "approve", ...policies },
  scopes: ["openid", "email", ...scopes], token: "ACCESS-TOKEN", refreshToken: "REFRESH-SECRET", expiresAt: NOW + 3600_000, createdAt: 1, updatedAt: 1,
});

interface Perm { id: string; type: string; role: string; emailAddress?: string; displayName?: string }

function fakeDrive() {
  const file = { id: "DOC", name: "Budget", mimeType: MIME_DOC, parents: ["TEAM"] };
  let perms: Perm[] = [
    { id: "p-owner", type: "user", role: "owner", emailAddress: "ana@example.org", displayName: "Ana" },
    { id: "p-bob", type: "user", role: "reader", emailAddress: "bob@example.org", displayName: "Bob" },
    { id: "p-link", type: "anyone", role: "reader" },
  ];
  const writes: { method: string; path: string; params: URLSearchParams; body: any }[] = [];
  let seq = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const p = url.pathname;
    assert.equal(((init.headers ?? {}) as Record<string, string>).Authorization, "Bearer ACCESS-TOKEN");
    let m: RegExpExecArray | null;
    if (p === `/drive/v3/files/${file.id}` && method === "GET") {
      return json(200, { id: file.id, name: file.name, mimeType: file.mimeType, parents: file.parents, webViewLink: "https://drive.example/DOC", owners: [{ emailAddress: "ana@example.org" }] });
    }
    if (p === `/drive/v3/files/${file.id}/permissions`) {
      assert.equal(url.searchParams.get("supportsAllDrives"), "true");
      if (method === "GET") return json(200, { permissions: perms });
      const body = JSON.parse(String(init.body));
      writes.push({ method, path: p, params: url.searchParams, body });
      const np: Perm = { id: `p-new${++seq}`, type: body.type, role: body.role, emailAddress: body.emailAddress };
      perms = [...perms, np];
      return json(200, { id: np.id });
    }
    if ((m = new RegExp(`^/drive/v3/files/${file.id}/permissions/([^/]+)$`).exec(p))) {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      writes.push({ method, path: p, params: url.searchParams, body });
      const i = perms.findIndex((x) => x.id === m![1]);
      if (i < 0) return json(404, { error: { message: "Permission not found" } });
      if (method === "PATCH") perms[i] = { ...perms[i]!, role: body.role };
      if (method === "DELETE") {
        perms = perms.filter((_, j) => j !== i);
        return new Response(null, { status: 204 });
      }
      return json(200, { id: m[1] });
    }
    return json(404, { error: { message: `unexpected ${method} ${p}` } });
  }) as FetchFn;
  return { fetchFn, file, writes, perms: () => perms, setPerms: (x: Perm[]) => (perms = x) };
}

function setup() {
  const g = fakeDrive();
  const deps: GoogleDeps = {
    fetchFn: g.fetchFn,
    token: async () => "ACCESS-TOKEN",
    readFile: async () => Buffer.alloc(0),
    now: () => NOW,
    pendingGmailDrafts: () => new Set(),
    ownGmailDrafts: { has: () => false, add: () => {} },
    ownFiles: { has: () => false, add: () => {}, list: () => [] },
    writeFile: async () => "/nowhere",
  };
  return { g, deps };
}
const pending = (o: ActionOutcome) => {
  if (o.kind !== "pending" || o.payload.kind !== "file") throw new Error(`expected a file card, got ${o.kind}`);
  return o as Extract<ActionOutcome, { kind: "pending" }> & { payload: FilePayload };
};
const result = (o: ActionOutcome) => {
  if (o.kind !== "result") throw new Error(`expected a result, got ${o.kind}`);
  return o;
};
const card = (payload: FilePayload): Pick<Draft, "payload"> => ({ payload });

// ---- the table and the setting ------------------------------------------------

test("drive.share follows the SHARE setting, never the Drive-edits one; drive.unshare never asks; both are logged", () => {
  assert.deepEqual(GOOGLE_ACTIONS["drive.share"], { class: "share", area: "drive" });
  assert.deepEqual(GOOGLE_ACTIONS["drive.unshare"], { class: "unshare", area: "drive" });
  assert.equal(actionSetting(acct(), "drive.share"), "approve");
  assert.equal(actionSetting(acct({ drive: "autonomous" }), "drive.share"), "approve", "automatic Drive edits do not make sharing automatic");
  assert.equal(actionSetting(acct({ share: "autonomous" }), "drive.share"), "autonomous");
  assert.equal(actionSetting(acct({ share: "autonomous" }), "drive.rename"), "approve", "and the share setting governs nothing else");
  assert.equal(actionSetting(acct(), "drive.unshare"), null);
  assert.equal(actionLogged("drive.share"), true);
  assert.equal(actionLogged("drive.unshare"), true);
  // An account stored before the setting existed asks.
  const old = { ...acct(), policies: { mail: "autonomous", calendar: "autonomous", drive: "autonomous" } as GooglePolicies };
  assert.equal(actionSetting(old, "drive.share"), "approve");
  assert.equal(actionVerdict(acct({}, [S.calendar]), "drive.share").ok, false, "a Drive area is needed");
});

// ---- the vocabulary ---------------------------------------------------------------

test("only named addresses, viewer / commenter / editor: never anyone-with-the-link, a domain or an owner", () => {
  assert.deepEqual(shareTargetsVerdict(["Bob@Example.org", "bob@example.org"], ["team@example.org"]), [
    { email: "bob@example.org", type: "user" },
    { email: "team@example.org", type: "group" },
  ]);
  for (const bad of ["anyone", "example.org", "@example.org", "a b@example.org", "x@localhost", ""]) {
    assert.throws(() => shareTargetsVerdict([bad], undefined), GoogleInputError, bad);
  }
  assert.throws(() => shareTargetsVerdict(undefined, undefined), /at least one address/);
  assert.throws(() => shareTargetsVerdict(Array.from({ length: 21 }, (_, i) => `u${i}@example.org`), undefined), /At most 20/);
  assert.equal(shareRoleVerdict(undefined), "reader");
  assert.equal(shareRoleVerdict("editor"), "writer");
  assert.equal(shareRoleVerdict("viewer"), "reader");
  assert.equal(shareRoleVerdict("commenter"), "commenter");
  for (const bad of ["owner", "organizer", "fileOrganizer", "admin"]) assert.throws(() => shareRoleVerdict(bad), /viewer, commenter or editor/);
  assert.equal(shareMessageVerdict("  hello\r\nthere  "), "hello\nthere");
  assert.equal(shareMessageVerdict("   "), undefined);
  assert.throws(() => shareMessageVerdict("x".repeat(1001)), /over 1000/);
});

test("the plan: a new address is added, a different role is changed (with what it was), the same role and an owner are left alone", () => {
  const current: DrivePermission[] = [
    { id: "1", type: "user", role: "owner", email: "ana@example.org" },
    { id: "2", type: "user", role: "reader", email: "bob@example.org" },
    { id: "3", type: "user", role: "writer", email: "cy@example.org" },
    { id: "4", type: "anyone", role: "reader" },
  ];
  const t = shareTargetsVerdict(["ana@example.org", "bob@example.org", "cy@example.org", "dee@example.org"], undefined);
  assert.deepEqual(sharePlan(current, t, "writer"), {
    grants: [
      { email: "bob@example.org", type: "user", role: "writer", from: "reader" },
      { email: "dee@example.org", type: "user", role: "writer" },
    ],
    unchanged: ["cy@example.org"],
    kept: ["ana@example.org"],
  });
});

// ---- drive share ------------------------------------------------------------------

test("drive share with approval: a card naming who has access now and exactly who gets what — nothing is written", async () => {
  const { g, deps } = setup();
  const o = pending(await runGoogleAction(deps, acct(), "drive.share", { id: "DOC", users: ["dee@example.org", "bob@example.org"], role: "commenter", message: "For Friday." }));
  assert.equal(g.writes.length, 0, "nothing shared before a person approves");
  assert.equal(o.action, "drive.share");
  assert.deepEqual(o.payload.grants, [
    { email: "dee@example.org", type: "user", role: "commenter" },
    { email: "bob@example.org", type: "user", role: "commenter", from: "reader" },
  ]);
  assert.equal(o.payload.notify, true);
  assert.equal(o.payload.text, "For Friday.");
  assert.equal(o.payload.parentId, "TEAM");
  assert.deepEqual(o.payload.access, ["Ana <ana@example.org> — owner", "Bob <bob@example.org> — viewer", "anyone with the link — viewer"]);
  assert.equal(o.summary, 'share "Budget" (DOC) with dee@example.org (commenter), bob@example.org (commenter, was viewer)');
});

test("approving a share re-reads the access: a new person is created (Google emails them, with the note), a changed role is patched", async () => {
  const { g, deps } = setup();
  const o = pending(await runGoogleAction(deps, acct(), "drive.share", { id: "DOC", users: ["dee@example.org", "bob@example.org"], role: "editor", message: "For Friday." }));
  const r = await approveGoogleDraft(deps, acct(), card(o.payload));
  assert.equal(r.kind, "done");
  assert.equal(g.writes.length, 2);
  const [create, patch] = g.writes;
  assert.equal(create!.method, "POST");
  assert.deepEqual(create!.body, { type: "user", role: "writer", emailAddress: "dee@example.org" });
  assert.equal(create!.params.get("sendNotificationEmail"), "true");
  assert.equal(create!.params.get("emailMessage"), "For Friday.");
  assert.equal(patch!.method, "PATCH");
  assert.match(patch!.path, /\/permissions\/p-bob$/);
  assert.deepEqual(patch!.body, { role: "writer" });
});

test("an approval never undoes what changed since the card: someone already given that role is left alone", async () => {
  const { g, deps } = setup();
  const o = pending(await runGoogleAction(deps, acct(), "drive.share", { id: "DOC", users: ["dee@example.org"], role: "editor" }));
  g.setPerms([...g.perms(), { id: "p-dee", type: "user", role: "writer", emailAddress: "dee@example.org" }]);
  assert.equal((await approveGoogleDraft(deps, acct(), card(o.payload))).kind, "done");
  assert.equal(g.writes.length, 0);
});

test("a share is for the file the card showed: renamed since, nothing is shared", async () => {
  const { g, deps } = setup();
  const o = pending(await runGoogleAction(deps, acct(), "drive.share", { id: "DOC", users: ["dee@example.org"] }));
  g.file.name = "Budget (final)";
  await assert.rejects(approveGoogleDraft(deps, acct(), card(o.payload)), (e: Error) => e.message === FILE_CHANGED_SENTENCE);
  assert.equal(g.writes.length, 0);
});

test("drive share, automatic: shared at once, logged, and Google told not to email when asked", async () => {
  const { g, deps } = setup();
  const r = result(await runGoogleAction(deps, acct({ share: "autonomous" }), "drive.share", { id: "DOC", groups: ["team@example.org"], notify: false }));
  assert.deepEqual(r.result, { id: "DOC", status: "shared", shared: ["team@example.org (viewer)"] });
  assert.equal(r.log?.summary, 'share "Budget" (DOC) with team@example.org (viewer) without notifying them');
  assert.equal(g.writes.length, 1);
  assert.deepEqual(g.writes[0]!.body, { type: "group", role: "reader", emailAddress: "team@example.org" });
  assert.equal(g.writes[0]!.params.get("sendNotificationEmail"), "false");
  assert.equal(g.writes[0]!.params.get("emailMessage"), null);
});

test("drive share refuses what would change nothing, and a note with no email to carry it", async () => {
  const { g, deps } = setup();
  await assert.rejects(runGoogleAction(deps, acct(), "drive.share", { id: "DOC", users: ["bob@example.org"], role: "viewer" }), /Nothing to change: bob@example.org is already viewer/);
  await assert.rejects(runGoogleAction(deps, acct(), "drive.share", { id: "DOC", users: ["ana@example.org"], role: "editor" }), /ana@example.org is an owner or manager/);
  await assert.rejects(runGoogleAction(deps, acct(), "drive.share", { id: "DOC", users: ["dee@example.org"], notify: false, message: "hi" }), /cannot go with --no-notify/);
  await assert.rejects(runGoogleAction(deps, acct(), "drive.share", { id: "DOC", users: ["anyone"] }), /not an email address/);
  assert.equal(g.writes.length, 0);
});

// ---- drive unshare ----------------------------------------------------------------

test("drive unshare takes access away at once, even with every setting on approve, and logs who lost it", async () => {
  const { g, deps } = setup();
  const r = result(await runGoogleAction(deps, acct(), "drive.unshare", { id: "DOC", users: ["bob@example.org"], anyone: true }));
  assert.deepEqual(r.result, { id: "DOC", status: "removed", removed: ["Bob <bob@example.org>", "anyone with the link"] });
  assert.equal(r.log?.summary, 'remove Bob <bob@example.org>, anyone with the link from "Budget" (DOC)');
  assert.deepEqual(g.writes.map((w) => `${w.method} ${w.path.split("/").pop()}`), ["DELETE p-bob", "DELETE p-link"]);
});

test("drive unshare never removes an owner, the account itself, or an access that is not the address's own", async () => {
  const { g, deps } = setup();
  await assert.rejects(runGoogleAction(deps, acct(), "drive.unshare", { id: "DOC", users: ["ana@example.org"] }), /lock the cockpit out/);
  const owned = acct();
  owned.label = "someone@example.org";
  await assert.rejects(runGoogleAction(deps, owned, "drive.unshare", { id: "DOC", users: ["ana@example.org"] }), /owner or organizer/);
  await assert.rejects(runGoogleAction(deps, acct(), "drive.unshare", { id: "DOC", users: ["zed@example.org"] }), /no access of its own/);
  await assert.rejects(runGoogleAction(deps, acct(), "drive.unshare", { id: "DOC" }), /--anyone/);
  g.setPerms(g.perms().filter((p) => p.type !== "anyone"));
  await assert.rejects(runGoogleAction(deps, acct(), "drive.unshare", { id: "DOC", anyone: true }), /not shared with anyone who has the link/);
  assert.equal(g.writes.length, 0, "a refusal changes nothing — not even the addresses that were fine");
  assert.throws(() => unsharePlan([], [], false, "a@example.org"), /--anyone/);
});

// ---- what the person sees ------------------------------------------------------------

test("the share card: who has access now, who gets what, whether Google emails them, and the note as the body", () => {
  const payload: FilePayload = {
    kind: "file", op: "drive.share", fileId: "DOC", name: "Budget", owners: ["ana@example.org"], parentId: "TEAM",
    grants: [{ email: "dee@example.org", type: "user", role: "writer" }, { email: "bob@example.org", type: "user", role: "commenter", from: "reader" }],
    notify: true, access: ["Ana <ana@example.org> — owner", "Bob <bob@example.org> — viewer"], text: "For Friday.",
  };
  const v = draftView(makeDraft({ id: "d1", sessionId: "s1", accountId: "g0000001", text: "share", origin: "agent", now: NOW, provider: "google", action: "drive.share", payload }), { label: "ana@example.org" });
  assert.deepEqual(v.file!.grants, payload.grants);
  assert.equal(v.file!.notify, true);
  assert.deepEqual(v.file!.access, payload.access);
  const m = draftCardModel({ ...v, provider: "google" });
  assert.match(m.title, /^Share a Drive file/);
  const field = (label: string) => m.fields.find((f: { label: string }) => f.label === label)?.value;
  assert.equal(field("Has access now"), "Ana <ana@example.org> — owner\nBob <bob@example.org> — viewer");
  assert.equal(field("Gets access"), "dee@example.org — editor\nbob@example.org — commenter (now viewer)");
  assert.equal(field("Google emails them"), "yes (the people new to the file), with the note below");
  const roleOnly = draftCardModel({ ...v, provider: "google", file: { ...v.file!, grants: [payload.grants![1]!] } });
  assert.equal(roleOnly.fields.find((f: { label: string }) => f.label === "Google emails them")?.value, "no — Google sends no email for a changed role");
  assert.equal(m.text, "For Friday.");
});

test("the Sharing setting row appears with a Drive area, and its confirmation says what cannot be undone", () => {
  const rows = googlePolicyRows({ areas: ["drive"], policies: { share: "autonomous" } }).map((r: { key: string; choices: { key: string; checked: boolean }[] }) => [r.key, r.choices.find((c) => c.checked)!.key]);
  assert.deepEqual(rows, [["mail", "approve"], ["calendar", "approve"], ["drive", "approve"], ["share", "autonomous"]]);
  assert.deepEqual(googlePolicyRows({ areas: ["gmail"] }).map((r: { key: string }) => r.key), ["mail", "calendar"]);
  assert.match(googleAutonomousConfirmText({ label: "ana@example.org", share: { personal: true } }, "share", []), /access to files in ana@example.org's Drive.*taking the access back does not undo what they saw/);
});

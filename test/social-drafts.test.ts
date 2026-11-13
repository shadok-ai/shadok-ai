import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DRAFT_TTL_MS,
  DISCONNECTED_SENTENCE,
  BEING_PUBLISHED_SENTENCE,
  DRAFTER_NOT_ALLOWED,
  NOT_SHARED_WITH_APPROVER,
  NOT_SHARED_WITH_AGENT,
  PUBLISH_FAILED_SENTENCE,
  POST_OUTCOME_UNKNOWN_SENTENCE,
  SESSION_NOT_VISIBLE,
  PublishInputError,
  appendLog,
  draftLogEntry,
  failureOutcome,
  makeDraft,
  refusalLogOutcome,
  approvalCaller,
  discardVerdict,
  draftNotice,
  draftView,
  expireDrafts,
  expirySentence,
  imagePathVerdict,
  loadDrafts,
  postRequestVerdict,
  publishVerdict,
  resolveDraftId,
  saveDrafts,
  sessionDrafts,
  ACCOUNT_LOG_LIMIT,
  IMAGE_GONE_SENTENCE,
  accountLog,
  draftsFileFor,
  mediaDirFor,
  readSnapshot,
  removeSnapshot,
  sha256Hex,
  snapshotBytes,
  snapshotDone,
  snapshotPathFor,
  writeSnapshot,
  AGENT_CANNOT_APPROVE_ACTION,
  GONE_IN_GMAIL_SENTENCE,
  GOOGLE_FAILED_SENTENCE,
  GOOGLE_OUTCOME_UNKNOWN_SENTENCE,
  draftAction,
  draftProvider,
  usableAccountVerdict,
  type Draft,
} from "../src/social-drafts.js";
import { GoogleError, GoogleInputError, GoogleOutcomeUnknownError } from "../src/google.js";
import { LinkedInError, PostOutcomeUnknownError } from "../src/linkedin.js";
import type { ConnectedAccount, ShareScope } from "../src/connected-accounts.js";
import type { Group, Viewer } from "../src/groups.js";

const DAY = 24 * 3600_000;
const NOW = Date.UTC(2027, 0, 1);
const g = (id: string, nature: Group["nature"], members: string[], owner?: string): Group => ({
  id, name: id, nature, members, owner, createdAt: 0,
});
const groups: Group[] = [g("main", "public", []), g("g1", "restricted", ["ann", "bob"]), g("p-ann", "private", ["ann"], "ann")];
const acct = (over: Partial<ConnectedAccount> = {}, share: ShareScope = { scope: "private" }): ConnectedAccount => ({
  id: "abcd1234", provider: "linkedin", kind: "member", label: "Acme (Page)", externalId: "urn:li:person:1",
  owner: "Paul", connectedVia: "Paul", share, policy: "approve", token: "SECRET-TOKEN", refreshToken: "SECRET-REFRESH",
  expiresAt: NOW + 30 * DAY, createdAt: 1, updatedAt: 1, ...over,
});
const draft = (over: Partial<Draft> = {}): Draft => ({
  id: "d0d0d0d0", sessionId: "sess-1", accountId: "abcd1234", text: "Hello", status: "pending", createdAt: NOW - DAY, ...over,
});
const paul: Viewer = { name: "Paul", role: "member" };
const bob: Viewer = { name: "bob", role: "member" };
const agentViewer: Viewer = { name: "agent:x", role: "member", agentGroup: null };

test("publishVerdict: a pending draft on the owner's live account passes", () => {
  assert.deepEqual(publishVerdict(draft(), acct(), paul, groups, NOW, true), { ok: true });
});

test("publishVerdict: an agent viewer never passes, whatever the account allows", () => {
  const open = acct({}, { scope: "instance" });
  const v = publishVerdict(draft(), open, agentViewer, groups, NOW, true);
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.status, 403);
  assert.equal(publishVerdict(draft(), open, null, groups, NOW, true).ok, false);
});

test("publishVerdict: published → 409 naming the URL; publishing → 409 (Review Focus 2)", () => {
  const p = publishVerdict(draft({ status: "published", postUrl: "https://x/1" }), acct(), paul, groups, NOW, true);
  assert.deepEqual(p, { ok: false, status: 409, reason: "Already published: https://x/1" });
  const q = publishVerdict(draft({ status: "publishing" }), acct(), paul, groups, NOW, true);
  assert.deepEqual(q, { ok: false, status: 409, reason: BEING_PUBLISHED_SENTENCE });
  for (const status of ["discarded", "expired", "failed"] as const) {
    const r = publishVerdict(draft({ status }), acct(), paul, groups, NOW, true);
    assert.equal(!r.ok && r.status, 409, status);
  }
});

test("publishVerdict: a pending draft older than 7 days refuses", () => {
  const r = publishVerdict(draft({ createdAt: NOW - DRAFT_TTL_MS }), acct(), paul, groups, NOW, true);
  assert.equal(!r.ok && r.status, 409);
});

test("publishVerdict: account disconnected since the draft → the disconnected sentence (Review Focus 3)", () => {
  const r = publishVerdict(draft(), undefined, paul, groups, NOW, true);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, DISCONNECTED_SENTENCE);
});

test("publishVerdict: account unshared since the draft → 403 sentence (Review Focus 3)", () => {
  const wasShared = acct({}, { scope: "groups", groups: ["g1"] });
  assert.deepEqual(publishVerdict(draft(), wasShared, bob, groups, NOW, true), { ok: true });
  const unshared = acct({}, { scope: "private" });
  assert.deepEqual(publishVerdict(draft(), unshared, bob, groups, NOW, true), { ok: false, status: 403, reason: NOT_SHARED_WITH_APPROVER });
});

test("publishVerdict: an expired account → the sentence naming label, date and owner", () => {
  const byDate = acct({ expiresAt: Date.UTC(2026, 11, 12) });
  const r = publishVerdict(draft(), byDate, paul, groups, NOW, true);
  assert.deepEqual(r, {
    ok: false,
    status: 409,
    reason: "LinkedIn account 'Acme (Page)' expired on 12 Dec 2026 — Paul must reconnect it in Secrets → Connected accounts.",
  });
  // Refused by LinkedIn (401) before its date: the date is when we learnt it, not a future one.
  const revoked = acct({ status: "expired", updatedAt: Date.UTC(2026, 11, 20) });
  assert.match(expirySentence(revoked, NOW), /expired on 20 Dec 2026 — Paul must reconnect/);
  assert.equal(publishVerdict(draft(), revoked, paul, groups, NOW, true).ok, false);
});

test("discardVerdict: allowed on a disconnected or expired account, never for an agent", () => {
  assert.deepEqual(discardVerdict(draft(), undefined, paul, groups, NOW, true), { ok: true });
  assert.deepEqual(discardVerdict(draft(), acct({ status: "expired" }), paul, groups, NOW, true), { ok: true });
  assert.equal(discardVerdict(draft(), acct(), agentViewer, groups, NOW, true).ok, false);
  assert.equal(discardVerdict(draft({ status: "published", postUrl: "u" }), acct(), paul, groups, NOW, true).ok, false);
  assert.equal(discardVerdict(draft(), acct(), bob, groups, NOW, true).ok, false);
});

test("approvalCaller: an agent key, a peer token, no cookie or a foreign origin never approve", () => {
  const base = { hasAgentKey: false, hasPeerToken: false, passwordSet: true, personCookie: true, sameOrigin: true, account: { name: "Paul" } };
  assert.deepEqual(approvalCaller(base), { ok: true, person: "Paul" });
  assert.equal(approvalCaller({ ...base, hasAgentKey: true }).ok, false);
  assert.equal(approvalCaller({ ...base, hasPeerToken: true }).ok, false);
  assert.equal(approvalCaller({ ...base, personCookie: false }).ok, false);
  assert.equal(approvalCaller({ ...base, sameOrigin: false }).ok, false);
  assert.equal(approvalCaller({ ...base, account: { name: "agent:x", agent: {} } }).ok, false);
  assert.equal(approvalCaller({ ...base, account: null }).ok, false);
});

test("expireDrafts: pending drafts expire at exactly 7 days, nothing else changes", () => {
  const list = [
    draft({ id: "a", createdAt: NOW - DRAFT_TTL_MS }),
    draft({ id: "b", createdAt: NOW - DRAFT_TTL_MS + 1 }),
    draft({ id: "c", createdAt: NOW - 30 * DAY, status: "published", postUrl: "u" }),
  ];
  const { list: out, expired } = expireDrafts(list, NOW);
  assert.deepEqual(expired.map((d) => d.id), ["a"]);
  assert.deepEqual(out.map((d) => d.status), ["expired", "pending", "published"]);
});

test("postRequestVerdict: unknown, ambiguous, unshared, expired, bad text, peer box", () => {
  const mine = acct({}, { scope: "instance" });
  const other = acct({ id: "abff0000", owner: "cat" }, { scope: "private" });
  const list = [mine, other];
  const agent: Viewer = { name: "agent:x", role: "member", agentGroup: null };
  const ok = postRequestVerdict(list, "abcd", "Hi", agent, groups, null, NOW);
  assert.equal(ok.ok && ok.account.id, "abcd1234");
  const none = postRequestVerdict(list, "zz", "Hi", agent, groups, null, NOW);
  assert.deepEqual(none, { ok: false, status: 404, reason: "No LinkedIn account matches 'zz'. Run `social.mjs accounts` to list yours." });
  // "ab" matches both, but only one is visible: it resolves to that one.
  const narrowed = postRequestVerdict(list, "ab", "Hi", agent, groups, null, NOW);
  assert.equal(narrowed.ok && narrowed.account.id, "abcd1234");
  const twoVisible = [mine, acct({ id: "abff0000" }, { scope: "instance" })];
  const amb = postRequestVerdict(twoVisible, "ab", "Hi", agent, groups, null, NOW);
  assert.equal(!amb.ok && amb.status, 409);
  assert.deepEqual(postRequestVerdict(list, "abff0000", "Hi", agent, groups, null, NOW), { ok: false, status: 403, reason: NOT_SHARED_WITH_AGENT });
  const exp = postRequestVerdict([acct({ status: "expired" }, { scope: "instance" })], "abcd", "Hi", agent, groups, null, NOW);
  assert.equal(!exp.ok && exp.status, 409);
  assert.match(!exp.ok ? exp.reason : "", /must reconnect it/);
  const empty = postRequestVerdict(list, "abcd", "   ", agent, groups, null, NOW);
  assert.deepEqual(empty, { ok: false, status: 400, reason: "The post is empty.", account: mine });
  const long = postRequestVerdict(list, "abcd", "x".repeat(3001), agent, groups, null, NOW);
  assert.equal(!long.ok && long.status, 400);
  const peer = postRequestVerdict(list, "abcd", "Hi", agent, groups, "acme-peer", NOW);
  assert.equal(!peer.ok && peer.status, 403);
  // C1: mono-tenant (agents unwalled) — a private account of someone else is usable.
  const priv = [acct({}, { scope: "private" })];
  assert.equal(postRequestVerdict(priv, "abcd", "Hi", agent, groups, null, NOW).ok, false);
  assert.equal(postRequestVerdict(priv, "abcd", "Hi", agent, groups, null, NOW, true).ok, true);
  assert.equal(postRequestVerdict(priv, "abcd", "Hi", agent, groups, "acme-peer", NOW, true).ok, false);
});

test("imagePathVerdict: absolute and PNG/JPEG/GIF only", () => {
  assert.deepEqual(imagePathVerdict("/tmp/a.PNG"), { ok: true, path: "/tmp/a.PNG", mime: "image/png" });
  assert.equal(imagePathVerdict("/tmp/a.jpeg").ok && "ok", "ok");
  assert.equal(imagePathVerdict("a.png").ok, false);
  assert.equal(imagePathVerdict("/tmp/a.webp").ok, false);
  assert.equal(imagePathVerdict(42).ok, false);
});

test("draftView never carries the token; the notices read as sentences", () => {
  const v = draftView(draft({ imagePath: "/tmp/x.png" }), acct());
  const s = JSON.stringify(v);
  assert.ok(!s.includes("SECRET"));
  assert.equal(v.account, "Acme (Page)");
  assert.equal(v.image, "x.png");
  assert.equal(draftView(draft(), undefined).account, "(disconnected account)");
  assert.equal(draftNotice(draft({ status: "published", postUrl: "https://x/1" })), "Your LinkedIn draft d0d0d0d0 was published: https://x/1");
  assert.equal(draftNotice(draft({ status: "discarded", decidedBy: "Paul" })), "Your LinkedIn draft d0d0d0d0 was discarded by Paul.");
  assert.equal(draftNotice(draft({ status: "failed", error: "boom" })), "Your LinkedIn draft d0d0d0d0 could not be published: boom");
  assert.equal(draftNotice(draft()), null);
});

test("resolveDraftId: exact, unique prefix, empty and ambiguous refused", () => {
  const list = [draft({ id: "aa11bb22" }), draft({ id: "aa33cc44" })];
  assert.equal((resolveDraftId(list, "aa11") as Draft).id, "aa11bb22");
  assert.equal(resolveDraftId(list, "aa"), "ambiguous");
  assert.equal(resolveDraftId(list, ""), "none");
  assert.equal(resolveDraftId(list, "zz"), "none");
});

test("sessionDrafts: only that session's, oldest first", () => {
  const list = [draft({ id: "b", createdAt: 2 }), draft({ id: "x", sessionId: "other" }), draft({ id: "a", createdAt: 1 })];
  assert.deepEqual(sessionDrafts(list, "sess-1").map((d) => d.id), ["a", "b"]);
});

test("appendLog: one line per entry, mode 600, and no token even when one is smuggled in", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-log-"));
  const file = path.join(dir, "sub", "k.log.jsonl");
  const smuggled = { at: 1, accountId: "abcd1234", origin: "agent", approvedBy: "Paul", text: "Hi", outcome: "published", postUrl: "u", token: "SECRET-TOKEN" };
  appendLog(file, smuggled as never);
  appendLog(file, { at: 2, accountId: "abcd1234", origin: "cron", approvedBy: "autonomous", text: "Yo", outcome: "failed", error: "nope" });
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("token") && !raw.includes("SECRET"));
  const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].origin, "cron");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("saveDrafts / loadDrafts: round-trip, 600, unparseable → []", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-drafts-"));
  const file = path.join(dir, "k.drafts.json");
  assert.deepEqual(loadDrafts(file), []);
  saveDrafts(file, [draft()]);
  assert.deepEqual(loadDrafts(file), [draft()]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, "{nope");
  assert.deepEqual(loadDrafts(file), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("failureOutcome: LinkedIn 401 before expiresAt → account patched expired, reconnect sentence naming the owner (Review Focus 4)", () => {
  const live = acct({ expiresAt: NOW + 30 * DAY });
  const f = failureOutcome(new LinkedInError("LinkedIn refused the token (401).", 401), live, NOW);
  assert.deepEqual(f.accountPatch, { status: "expired", updatedAt: NOW });
  assert.equal(f.httpStatus, 409);
  assert.equal(f.reason, "LinkedIn account 'Acme (Page)' expired on 1 Jan 2027 — Paul must reconnect it in Secrets → Connected accounts.");
  // Once patched, the next publish refuses with the same sentence, without calling LinkedIn.
  const after = { ...live, ...f.accountPatch };
  assert.deepEqual(publishVerdict(draft(), after, paul, groups, NOW, true), { ok: false, status: 409, reason: f.reason });
});

test("failureOutcome: another LinkedIn error relays its message, no patch, 502", () => {
  const f = failureOutcome(new LinkedInError("LinkedIn refused the post (422): duplicate.", 422), acct(), NOW);
  assert.deepEqual(f, { reason: "LinkedIn refused the post (422): duplicate.", httpStatus: 502 });
});

test("failureOutcome: createPost that never answered says the post may have gone out", () => {
  const f = failureOutcome(new PostOutcomeUnknownError(), acct(), NOW);
  assert.deepEqual(f, { reason: POST_OUTCOME_UNKNOWN_SENTENCE, httpStatus: 502 });
  assert.equal(POST_OUTCOME_UNKNOWN_SENTENCE, "LinkedIn did not answer in time — check LinkedIn before retrying, the post may have gone out.");
});

test("failureOutcome: a non-LinkedIn error gets the generic sentence, no patch, 502; our own input error is relayed", () => {
  const f = failureOutcome(new Error("connect ECONNREFUSED https://api.linkedin.com?t=SECRET-TOKEN"), acct(), NOW);
  assert.deepEqual(f, { reason: PUBLISH_FAILED_SENTENCE, httpStatus: 502 });
  assert.deepEqual(failureOutcome("weird", acct(), NOW), { reason: PUBLISH_FAILED_SENTENCE, httpStatus: 502 });
  const i = failureOutcome(new PublishInputError("Could not read the image 'x.png': gone."), acct(), NOW);
  assert.deepEqual(i, { reason: "Could not read the image 'x.png': gone.", httpStatus: 400 });
});

test("a draft carries its drafting turn's origin, and the approval log entry uses it", () => {
  const d = makeDraft({ id: "d1", sessionId: "sess-1", accountId: "abcd1234", text: "Hi", origin: "cron", now: NOW });
  assert.equal(d.origin, "cron");
  assert.equal(d.status, "pending");
  assert.equal("imagePath" in d, false);
  const e = draftLogEntry(d, { at: NOW + 1, channel: "news", approvedBy: "Paul", outcome: "published", postUrl: "https://x/1" });
  assert.deepEqual(e, {
    at: NOW + 1, accountId: "abcd1234", sessionId: "sess-1", channel: "news", origin: "cron",
    approvedBy: "Paul", text: "Hi", outcome: "published", postUrl: "https://x/1",
  });
  // A draft written before the field existed logs as "agent".
  assert.equal(draftLogEntry(draft(), { at: NOW, approvedBy: "Paul", outcome: "failed", error: "x" }).origin, "agent");
});

test("refusalLogOutcome: past the TTL → expired; account refusal → refused; decided or invisible → not logged", () => {
  const old = draft({ createdAt: NOW - DRAFT_TTL_MS });
  const v = publishVerdict(old, acct(), paul, groups, NOW, true);
  assert.equal(!v.ok && refusalLogOutcome(old, v.reason, NOW), "expired");
  const u = publishVerdict(draft(), undefined, paul, groups, NOW, true);
  assert.equal(!u.ok && refusalLogOutcome(draft(), u.reason, NOW), "refused");
  assert.equal(refusalLogOutcome(draft({ status: "published" }), "Already published: u", NOW), null);
  assert.equal(refusalLogOutcome(draft(), SESSION_NOT_VISIBLE, NOW), null);
});

test("publish and discard both require the person may see the draft's agent — even with the account gone", () => {
  const hidden = { ok: false, status: 403, reason: SESSION_NOT_VISIBLE };
  assert.deepEqual(publishVerdict(draft(), acct(), paul, groups, NOW, false), hidden);
  assert.deepEqual(discardVerdict(draft(), acct(), paul, groups, NOW, false), hidden);
  assert.deepEqual(discardVerdict(draft(), undefined, paul, groups, NOW, false), hidden);
  // It does not reveal a decided draft's state either.
  assert.deepEqual(publishVerdict(draft({ status: "published", postUrl: "u" }), acct(), paul, groups, NOW, false), hidden);
});

// ---- I1: the approved image is the published image ------------------------

test("snapshotPathFor: <draftId><ext> in the media dir, extension lower-cased", () => {
  assert.equal(snapshotPathFor("/m", "ab12cd34", "/work/Shot.PNG"), path.join("/m", "ab12cd34.png"));
  assert.equal(snapshotPathFor("/m", "ab12cd34", "/work/a.jpeg"), path.join("/m", "ab12cd34.jpeg"));
  // A draft id is server-made hex: anything else must never become a path.
  assert.throws(() => snapshotPathFor("/m", "../x", "/a.png"));
  assert.throws(() => snapshotPathFor("/m", "", "/a.png"));
});

test("mediaDirFor sits beside the store, per instance", () => {
  const d = mediaDirFor("/some/launch");
  assert.equal(path.dirname(d), path.dirname(draftsFileFor("/some/launch")));
  assert.match(path.basename(d), /\.media$/);
});

test("snapshotBytes: missing, tampered, intact; no image → none", () => {
  const bytes = Buffer.from([1, 2, 3]);
  const d = draft({ imagePath: "/w/x.png", imageSnapshot: "/m/d0.png", imageSha256: sha256Hex(bytes) });
  assert.deepEqual(snapshotBytes(d, () => null), { ok: false, reason: IMAGE_GONE_SENTENCE });
  assert.deepEqual(snapshotBytes(d, () => Buffer.from([9])), { ok: false, reason: IMAGE_GONE_SENTENCE });
  const ok = snapshotBytes(d, (p) => (p === "/m/d0.png" ? bytes : null));
  assert.ok(ok.ok && ok.image && ok.image.mime === "image/png" && ok.image.bytes.equals(bytes));
  assert.deepEqual(snapshotBytes(draft(), () => bytes), { ok: true, image: null });
  // A draft with an image but no snapshot (written before snapshots) cannot publish its image.
  assert.deepEqual(snapshotBytes(draft({ imagePath: "/w/x.png" }), () => bytes), { ok: false, reason: IMAGE_GONE_SENTENCE });
  assert.equal(IMAGE_GONE_SENTENCE, "The draft's image is gone — ask the agent to draft again.");
});

test("snapshot write/read/remove round-trips with mode 600 in a 700 dir", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "snap-")), "inst.media");
  const f = path.join(dir, "ab12cd34.png");
  writeSnapshot(f, Buffer.from("img"));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(readSnapshot(f)?.toString(), "img");
  removeSnapshot(f);
  assert.equal(readSnapshot(f), null);
  removeSnapshot(f); // twice: never throws
  removeSnapshot(undefined);
});

test("snapshotDone: a decided draft no longer needs its snapshot", () => {
  for (const s of ["discarded", "expired", "published", "failed"] as const) assert.equal(snapshotDone(draft({ status: s })), true, s);
  for (const s of ["pending", "publishing"] as const) assert.equal(snapshotDone(draft({ status: s })), false, s);
});

test("draftView: the image card is offered only while the snapshot exists (pending/publishing)", () => {
  const card = { path: "/m/d0.png", name: "x.png" };
  assert.deepEqual(draftView(draft({ imagePath: "/w/x.png", imageSnapshot: "/m/d0.png" }), acct(), card).image, card);
  assert.equal(draftView(draft({ status: "published", postUrl: "u", imagePath: "/w/x.png", imageSnapshot: "/m/d0.png" }), acct(), card).image, "x.png");
  // The server-side snapshot path never reaches a client in the draft itself.
  assert.ok(!JSON.stringify(draftView(draft({ imagePath: "/w/x.png", imageSnapshot: "/m/d0.png", imageSha256: "ff" }), acct())).includes("sha"));
});

// ---- I2: the publication log can be read ----------------------------------

test("accountLog: that account only, newest first, capped, token-free shape", () => {
  const e = (at: number, accountId: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ at, accountId, origin: "agent", approvedBy: "Paul", text: "t" + at, outcome: "published", ...extra });
  const raw = [
    e(1, "abcd1234"),
    "not json",
    "",
    e(2, "other"),
    e(3, "abcd1234", { token: "SECRET", refreshToken: "SECRET2" }),
    JSON.stringify({ at: "x", accountId: "abcd1234" }),
    e(4, "abcd1234"),
  ].join("\n");
  const out = accountLog(raw, "abcd1234");
  assert.deepEqual(out.map((x) => x.at), [4, 3, 1]);
  assert.ok(!JSON.stringify(out).includes("SECRET"));
  assert.deepEqual(accountLog(raw, "abcd1234", 2).map((x) => x.at), [4, 3]);
  assert.deepEqual(accountLog("", "abcd1234"), []);
  const many = Array.from({ length: 80 }, (_, i) => e(i, "abcd1234")).join("\n");
  assert.equal(accountLog(many, "abcd1234").length, ACCOUNT_LOG_LIMIT);
  assert.equal(ACCOUNT_LOG_LIMIT, 50);
});

test("postRequestVerdict: a refusal after the account resolved carries it (for the log); before, it does not", () => {
  const mine = acct({}, { scope: "instance" });
  const agent: Viewer = { name: "agent:x", role: "member", agentGroup: null };
  const empty = postRequestVerdict([mine], "abcd", " ", agent, groups, null, NOW);
  assert.equal(!empty.ok && empty.account?.id, "abcd1234");
  const exp = postRequestVerdict([acct({ status: "expired" }, { scope: "instance" })], "abcd", "Hi", agent, groups, null, NOW);
  assert.equal(!exp.ok && exp.account?.id, "abcd1234");
  const none = postRequestVerdict([mine], "zz", "Hi", agent, groups, null, NOW);
  assert.equal(!none.ok && none.account, undefined);
  const hidden = postRequestVerdict([acct({ owner: "cat" }, { scope: "private" })], "abcd", "Hi", agent, groups, null, NOW);
  assert.equal(!hidden.ok && hidden.account, undefined);
});

test("the drafting agent is re-checked at click time: group AND profile", () => {
  const writersOnly = acct({}, { personal: false, groups: [], everyone: true, profiles: ["Writer"] });
  const drafter = (profile: string | null, agentGroup: string | null = null) => ({ viewer: { name: "agent:x", role: "member" as const, agentGroup }, peerBox: null, profile });
  assert.deepEqual(publishVerdict(draft(), writersOnly, paul, groups, NOW, true, false, drafter("Writer")), { ok: true });
  const r = publishVerdict(draft(), writersOnly, paul, groups, NOW, true, false, drafter("Dev"));
  assert.deepEqual(r, { ok: false, status: 403, reason: DRAFTER_NOT_ALLOWED });
  assert.equal(refusalLogOutcome(draft(), DRAFTER_NOT_ALLOWED, NOW), "refused");
  // A share narrowed from Public to Personal since the draft refuses a Main agent's draft.
  const narrowed = acct({}, { personal: true, groups: [], everyone: false, profiles: [] });
  assert.equal(publishVerdict(draft(), narrowed, paul, groups, NOW, true, false, drafter(null, null)).ok, false);
  // A peer-boxed drafter never passes.
  assert.equal(publishVerdict(draft(), acct({}, { scope: "instance" } as never), paul, groups, NOW, true, false, { ...drafter(null), peerBox: "box" }).ok, false);
  // Draft time: an agent on another profile does not see the account at all.
  assert.equal(postRequestVerdict([writersOnly], "abcd", "Hi", agentViewer, groups, null, NOW, false, "Dev").ok, false);
  assert.equal(postRequestVerdict([writersOnly], "abcd", "Hi", agentViewer, groups, null, NOW, false, "Writer").ok, true);
});

// ---- Google drafts: the same gate, generalised from "a post" to "an action" --

const gacct = (over: Partial<ConnectedAccount> = {}, share: ShareScope = { scope: "private" }): ConnectedAccount =>
  acct({ id: "g0000001", provider: "google", label: "paul@example.org", externalId: "sub-1", policies: { mail: "approve", calendar: "approve" }, expiresAt: NOW - DAY, refreshExpiresAt: NOW + 5 * DAY, ...over }, share);
const mailDraft = (over: Partial<Draft> = {}): Draft =>
  draft({
    accountId: "g0000001", provider: "google", action: "gmail.send", text: 'to bob@example.org — "Hello"',
    payload: { kind: "mail", from: "paul@example.org", to: ["bob@example.org"], cc: [], bcc: [], subject: "Hello", body: "The private body", attachments: ["a.pdf"], gmailDraftId: "r1", fingerprint: "ff" },
    ...over,
  });

test("a draft without provider/action is a LinkedIn post (drafts written before Google existed)", () => {
  assert.equal(draftProvider(draft()), "linkedin");
  assert.equal(draftAction(draft()), "post");
  const made = makeDraft({ id: "ab", sessionId: "s", accountId: "a", text: "t", origin: "agent", now: 1 });
  assert.equal("provider" in made || "action" in made || "payload" in made, false, "a LinkedIn draft keeps its stored shape");
  assert.equal(draftView(draft(), acct()).provider, "linkedin");
  assert.equal(draftView(draft(), acct()).action, "post");
});

test("the publish gate is the same for an email: a person, never an agent — the browser-person rule is reused, not re-made", () => {
  const live = gacct();
  assert.deepEqual(publishVerdict(mailDraft(), live, paul, groups, NOW, true), { ok: true }, "the hourly access expiry does not block: the deadline is the refresh token's");
  const byAgent = publishVerdict(mailDraft(), gacct({}, { scope: "instance" }), agentViewer, groups, NOW, true);
  assert.deepEqual(byAgent, { ok: false, status: 403, reason: AGENT_CANNOT_APPROVE_ACTION });
  assert.equal(publishVerdict(mailDraft(), live, null, groups, NOW, true).ok, false);
  assert.equal(publishVerdict(mailDraft(), live, bob, groups, NOW, true).ok, false, "someone the account is not shared with");
  assert.deepEqual(publishVerdict(mailDraft(), live, paul, groups, NOW, false), { ok: false, status: 403, reason: SESSION_NOT_VISIBLE });
  const caller = { hasAgentKey: false, hasPeerToken: false, passwordSet: true, personCookie: true, sameOrigin: true, account: { name: "Paul" } };
  assert.equal(approvalCaller(caller).ok, true);
  assert.equal(approvalCaller({ ...caller, hasAgentKey: true }).ok, false);
  assert.equal(approvalCaller({ ...caller, sameOrigin: false }).ok, false);
  assert.equal(approvalCaller({ ...caller, account: { name: "x", agent: { session: "s" } } }).ok, false);
  // A refused click by a non-person is not a refused action on the account.
  assert.equal(refusalLogOutcome(mailDraft(), AGENT_CANNOT_APPROVE_ACTION, NOW), null);
});

test("a Google draft's refusals name Google; gone (deleted in Gmail) is decided for good", () => {
  assert.deepEqual(publishVerdict(mailDraft(), undefined, paul, groups, NOW, true), { ok: false, status: 410, reason: "The Google account this draft was for has been disconnected." });
  const lapsed = publishVerdict(mailDraft(), gacct({ refreshExpiresAt: NOW - 1 }), paul, groups, NOW, true);
  assert.deepEqual(lapsed, { ok: false, status: 409, reason: "Google account 'paul@example.org' needs a reconnect (test app authorisations last 7 days) — Paul can do it in Secrets → Connected accounts." });
  assert.deepEqual(publishVerdict(mailDraft({ status: "gone" }), gacct(), paul, groups, NOW, true), { ok: false, status: 409, reason: GONE_IN_GMAIL_SENTENCE });
  assert.equal(discardVerdict(mailDraft({ status: "gone" }), gacct(), paul, groups, NOW, true).ok, false);
  assert.equal(discardVerdict(mailDraft(), undefined, paul, groups, NOW, true).ok, true, "a card whose account is gone can still be thrown away");
});

test("usableAccountVerdict: each provider only sees its own accounts", () => {
  const both = [acct({}, { scope: "instance" }), gacct({}, { scope: "instance" })];
  const viewer: Viewer = { name: "agent:x", role: "member", agentGroup: null };
  assert.equal(usableAccountVerdict(both, "google", "g0000001", viewer, groups, null, NOW).ok, true);
  assert.deepEqual(usableAccountVerdict(both, "google", "abcd1234", viewer, groups, null, NOW), {
    ok: false, status: 404, reason: "No Google account matches 'abcd1234'. Run `google.mjs accounts` to list yours.",
  });
  assert.equal(postRequestVerdict(both, "g0000001", "Hello", viewer, groups, null, NOW).ok, false, "a Google id is not a LinkedIn account");
  const peer = usableAccountVerdict(both, "google", "g0000001", viewer, groups, "peer-box", NOW);
  assert.equal(!peer.ok && peer.status, 403, "a restricted-peer agent never uses an account");
  const expired = usableAccountVerdict([gacct({ status: "expired" }, { scope: "instance" })], "google", "g0", viewer, groups, null, NOW);
  assert.equal(!expired.ok && expired.status, 409);
  assert.match(!expired.ok ? expired.reason : "", /needs a reconnect/);
});

test("what a Google draft tells its agent: sent, discarded, failed, deleted in Gmail — by summary, never the body", () => {
  const d = mailDraft();
  assert.equal(draftNotice({ ...d, status: "published" }), 'Your email d0d0d0d0 (to bob@example.org — "Hello") was sent.');
  assert.equal(draftNotice({ ...d, status: "discarded", decidedBy: "Paul" }), 'Your email d0d0d0d0 (to bob@example.org — "Hello") was discarded by Paul — nothing left the account.');
  // Deleted in Gmail and sent from Gmail look the same to us: the notice claims neither, and says to ask.
  assert.equal(
    draftNotice({ ...d, status: "gone" }),
    'Your email d0d0d0d0 (to bob@example.org — "Hello") is no longer in Gmail: the person deleted it there, or sent it from Gmail themselves. The cockpit sent nothing — ask them before sending it again.',
  );
  assert.match(draftNotice({ ...d, status: "failed", error: "boom" }) ?? "", /could not be completed: boom/);
  assert.equal(draftNotice(d), null);
  const ev = draft({ provider: "google", action: "calendar.create", text: 'create "Review" a → b', status: "published", postUrl: "https://calendar.google.com/e/1" });
  assert.equal(draftNotice(ev), 'Your calendar change d0d0d0d0 (create "Review" a → b) was applied: https://calendar.google.com/e/1');
  for (const s of ["published", "discarded", "gone", "failed"] as const) assert.doesNotMatch(draftNotice({ ...d, status: s, error: "e" }) ?? "", /The private body/);
});

test("the log of a Google action keeps the action and the summary; a smuggled body or token never lands", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glog-"));
  const file = path.join(dir, "log.jsonl");
  appendLog(file, draftLogEntry(mailDraft(), { at: 5, channel: "general", approvedBy: "Paul", outcome: "done" }));
  appendLog(file, { at: 6, accountId: "g0000001", origin: "agent", approvedBy: "none", action: "doc.append", text: "document d1", outcome: "done", body: "The private body", token: "SECRET-TOKEN" } as never);
  const raw = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /The private body|SECRET|"payload"|gmailDraftId/);
  const entries = accountLog(raw, "g0000001");
  assert.deepEqual(entries.map((e) => [e.action, e.outcome, e.text]), [["doc.append", "done", "document d1"], ["gmail.send", "done", 'to bob@example.org — "Hello"']]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("failureOutcome for Google: a dead grant patches the account expired; a bad request is ours; a lost send says check first", () => {
  const live = gacct();
  const dead = failureOutcome(new GoogleError("Google no longer accepts this account's authorisation.", 401, true), live, NOW);
  assert.deepEqual(dead.accountPatch, { status: "expired", updatedAt: NOW });
  assert.equal(dead.httpStatus, 409);
  assert.match(dead.reason, /Google account 'paul@example\.org' needs a reconnect/);
  assert.deepEqual(failureOutcome(new GoogleError("Google send failed (403): quota", 403), live, NOW), { reason: "Google send failed (403): quota", httpStatus: 502 });
  assert.deepEqual(failureOutcome(new GoogleInputError("The email has no subject."), live, NOW), { reason: "The email has no subject.", httpStatus: 400 });
  assert.deepEqual(failureOutcome(new GoogleOutcomeUnknownError(), live, NOW), { reason: GOOGLE_OUTCOME_UNKNOWN_SENTENCE, httpStatus: 502 });
  assert.deepEqual(failureOutcome(new Error("ECONNRESET SECRET-TOKEN"), live, NOW), { reason: GOOGLE_FAILED_SENTENCE, httpStatus: 502 }, "an error that is not ours is never relayed");
});

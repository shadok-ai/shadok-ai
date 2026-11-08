import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DRAFT_TTL_MS,
  DISCONNECTED_SENTENCE,
  BEING_PUBLISHED_SENTENCE,
  NOT_SHARED_WITH_APPROVER,
  NOT_SHARED_WITH_AGENT,
  PUBLISH_FAILED_SENTENCE,
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
  type Draft,
} from "../src/social-drafts.js";
import { LinkedInError } from "../src/linkedin.js";
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
  assert.deepEqual(empty, { ok: false, status: 400, reason: "The post is empty." });
  const long = postRequestVerdict(list, "abcd", "x".repeat(3001), agent, groups, null, NOW);
  assert.equal(!long.ok && long.status, 400);
  const peer = postRequestVerdict(list, "abcd", "Hi", agent, groups, "acme-peer", NOW);
  assert.equal(!peer.ok && peer.status, 403);
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

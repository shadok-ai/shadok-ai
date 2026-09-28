import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import {
  signPeerToken,
  peerTokenName,
  peerFromToken,
  normPeerName,
  addPeer,
  newPeer,
  withSalts,
  redeemVerdict,
  redeemPeer,
  removePeer,
  ownedByPeer,
  peerFileFor,
  peersOutFileFor,
  agentInvitePrompt,
} from "../src/peers.js";

const secret = randomBytes(32);

/** An enrolled row: salted, ticket already consumed. */
const enrolled = (name: string, salt = "s1") => ({ name, createdAt: 1, salt, enrolledAt: 2 });

test("peerTokenName reads the CLAIM and proves nothing", () => {
  // It is the first half of the token, so it must never be treated as identity.
  assert.equal(peerTokenName(signPeerToken("brasdroit1", secret, "s1")), "brasdroit1");
  assert.equal(peerTokenName(""), null);
  assert.equal(peerTokenName("nodot"), null);
  assert.equal(peerTokenName(undefined), null);
});

test("peerFromToken: enrolled AND registered → name; tampered, foreign or revoked → null", () => {
  const peers = [enrolled("brasdroit1")];
  const tok = signPeerToken("brasdroit1", secret, "s1");
  assert.equal(peerFromToken(tok, secret, peers), "brasdroit1");
  // tampered mac
  assert.equal(peerFromToken(tok.slice(0, -1) + (tok.at(-1) === "0" ? "1" : "0"), secret, peers), null);
  // another instance's secret
  assert.equal(peerFromToken(tok, randomBytes(32), peers), null);
  // the mac is still valid, but the registry no longer lists it → revoked
  assert.equal(peerFromToken(tok, secret, []), null);
  // a valid token for a DIFFERENT name is not smuggled in
  assert.equal(peerFromToken(signPeerToken("other", secret, "s1"), secret, peers), null);
  // malformed
  assert.equal(peerFromToken("nodot", secret, peers), null);
});

test("the salt is what makes revocation a ROTATION", () => {
  // THE bug this closes: the token used to be hmac(secret, "peer:"+name), so
  // deleting the row and re-inviting the same name minted the IDENTICAL token —
  // a leaked credential handed straight back. With a per-peer salt it cannot.
  const first = newPeer([], "brasdroit1", 1000);
  const s1 = first.peers[0].salt!;
  const again = newPeer(removePeer(first.peers, "brasdroit1"), "brasdroit1", 2000);
  assert.notEqual(again.peers[0].salt, s1, "re-inviting must re-roll the salt");
  assert.notEqual(
    signPeerToken("brasdroit1", secret, again.peers[0].salt!),
    signPeerToken("brasdroit1", secret, s1),
    "and therefore mint a different token",
  );
  // The old token is dead against the new row.
  const oldTok = signPeerToken("brasdroit1", secret, s1);
  assert.equal(peerFromToken(oldTok, secret, redeemPeer(again.peers, "brasdroit1", 3000)), null);
});

test("a peer that has NOT redeemed its ticket cannot use a durable token", () => {
  // This is what keeps the ticket the only way in: the row exists and is salted,
  // but while `invite` is present the token authenticates nothing.
  const { peers } = newPeer([], "brasdroit1", 1000);
  const tok = signPeerToken("brasdroit1", secret, peers[0].salt!);
  assert.equal(peerFromToken(tok, secret, peers), null, "pending invite → refused");
  assert.equal(peerFromToken(tok, secret, redeemPeer(peers, "brasdroit1", 2000)), "brasdroit1");
});

test("withSalts backfills a pre-salt row, which invalidates its old token", () => {
  // Deliberate: the saltless token is the deterministic one being removed. A
  // peer whose token stops working gets re-invited; one whose leaked token kept
  // working would never know.
  const legacy = [{ name: "old", createdAt: 1, enrolledAt: 1 }];
  const fixed = withSalts(legacy, () => "backfilled");
  assert.equal(fixed[0].salt, "backfilled");
  assert.equal(peerFromToken(signPeerToken("old", secret, ""), secret, fixed), null);
  assert.equal(peerFromToken(signPeerToken("old", secret, "backfilled"), secret, fixed), "old");
  // idempotent: an already-salted row is untouched
  assert.equal(withSalts(fixed, () => "other")[0].salt, "backfilled");
});

test("redeemVerdict: a ticket works ONCE, and the refusals are indistinguishable", () => {
  const { peers, ticket } = newPeer([], "brasdroit1", 1000);
  assert.deepEqual(redeemVerdict(peers, ticket, 1001), { ok: true, name: "brasdroit1" });
  // redeemed → the ticket is gone, so the same call now fails
  const after = redeemPeer(peers, "brasdroit1", 1002);
  const used = redeemVerdict(after, ticket, 1003);
  const invented = redeemVerdict(after, "never-existed", 1003);
  assert.equal(used.ok, false);
  assert.equal(invented.ok, false);
  // Same wording on purpose: saying "already used" would confirm it once existed.
  assert.equal((used as { error: string }).error, (invented as { error: string }).error);
  assert.equal(redeemVerdict(peers, "", 1003).ok, false);
});

test("redeemVerdict: an expired ticket is refused, and expiry is a bound not a sweep", () => {
  const { peers, ticket } = newPeer([], "brasdroit1", 1000);
  const past = peers[0].invite!.expiresAt;
  assert.equal(redeemVerdict(peers, ticket, past - 1).ok, true);
  assert.equal(redeemVerdict(peers, ticket, past).ok, false, "expiresAt is exclusive");
  assert.equal(redeemVerdict(peers, ticket, past + 1).ok, false);
});

test("redeemPeer keeps the peer and drops only the invitation", () => {
  const { peers } = newPeer([], "brasdroit1", 1000, "prod");
  const after = redeemPeer(peers, "brasdroit1", 5000);
  assert.equal(after.length, 1);
  assert.equal(after[0].invite, undefined, "the ticket is consumed");
  assert.equal(after[0].enrolledAt, 5000);
  assert.equal(after[0].note, "prod", "the rest of the row survives");
  assert.equal(after[0].salt, peers[0].salt, "the salt is NOT re-rolled by redeeming");
});

test("normPeerName: a slug — lowercased, trimmed, safe chars; empty is rejected", () => {
  assert.equal(normPeerName("  BrasDroit 1 "), "brasdroit-1");
  assert.equal(normPeerName("a_b.c"), "a-b-c");
  assert.equal(normPeerName(""), null);
  assert.equal(normPeerName("   "), null);
  assert.equal(normPeerName("é$@"), null); // nothing safe survives
});

test("addPeer / removePeer: dedup by name, supersede, remove", () => {
  let peers = addPeer([], "brasdroit1", 1000, undefined, "s1", "t1");
  assert.equal(peers.length, 1);
  // re-adding the same name supersedes rather than duplicating
  peers = addPeer(peers, "brasdroit1", 2000, "prod", "s2", "t2");
  assert.equal(peers.length, 1);
  assert.equal(peers[0].note, "prod");
  assert.equal(peers[0].salt, "s2", "and re-rolls the credential");
  peers = addPeer(peers, "brasdroit2", 3000, undefined, "s3", "t3");
  assert.equal(peers.length, 2);
  peers = removePeer(peers, "brasdroit1");
  assert.deepEqual(peers.map((p) => p.name), ["brasdroit2"]);
});

test("ownedByPeer: only the peer that created an agent owns it", () => {
  assert.equal(ownedByPeer({ createdByPeer: "brasdroit1" }, "brasdroit1"), true);
  assert.equal(ownedByPeer({ createdByPeer: "brasdroit2" }, "brasdroit1"), false); // another peer's
  assert.equal(ownedByPeer({}, "brasdroit1"), false); // a local agent (no owner)
  assert.equal(ownedByPeer(undefined, "brasdroit1"), false); // no such channel
});

test("peerFileFor / peersOutFileFor: distinct per-instance paths under ~/.shadok-ai", () => {
  assert.match(peerFileFor("/a/b"), /\.shadok-ai\/peers\/-a-b\.json$/);
  assert.match(peersOutFileFor("/a/b"), /\.shadok-ai\/peers-out\/-a-b\.json$/);
  assert.notEqual(peerFileFor("/a"), peersOutFileFor("/a")); // inbound vs outbound never collide
});

test("agentInvitePrompt: carries the endpoint, the TICKET and the brief; trims the URL", () => {
  const p = agentInvitePrompt({ url: "https://cockpit.example/", ticket: "tkt123", brief: "  audit module X  " });
  assert.match(p, /Cockpit: https:\/\/cockpit\.example$/m); // trailing slash trimmed
  assert.match(p, /Your invitation ticket: tkt123/);
  assert.match(p, /peer add host https:\/\/cockpit\.example tkt123/);
  assert.match(p, /Single use/);
  assert.match(p, /Your brief:/);
  assert.match(p, /audit module X/); // trimmed, present
  // no brief → an explicit "ask your inviter" line, never a dangling "Your brief:"
  const none = agentInvitePrompt({ url: "http://h", ticket: "t" });
  assert.match(none, /No brief was included/);
  assert.ok(!none.includes("Your brief:"));
});

test("agentInvitePrompt never carries a durable token", () => {
  // The invitation is pasted into a session and lives on in a transcript, so what
  // it holds must be worthless once used. A regression here would put the
  // long-lived credential back into exactly the place this design removes it from.
  const p = agentInvitePrompt({ url: "http://h", ticket: "tkt" });
  assert.ok(!/peer key:/i.test(p), "no durable key in an invitation");
  assert.match(p, /exchanges it for your own durable key/);
});

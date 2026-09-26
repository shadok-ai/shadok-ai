import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import {
  signPeerToken,
  readPeerToken,
  peerFromToken,
  normPeerName,
  addPeer,
  removePeer,
  ownedByPeer,
} from "../src/peers.js";

const secret = randomBytes(32);

test("signPeerToken / readPeerToken round-trip; a tampered or foreign token is refused", () => {
  const tok = signPeerToken("brasdroit1", secret);
  assert.equal(readPeerToken(tok, secret), "brasdroit1");
  // tampered mac
  assert.equal(readPeerToken(tok.slice(0, -1) + (tok.at(-1) === "0" ? "1" : "0"), secret), null);
  // signed with a different secret
  assert.equal(readPeerToken(tok, randomBytes(32)), null);
  // malformed
  assert.equal(readPeerToken("", secret), null);
  assert.equal(readPeerToken("nodot", secret), null);
});

test("peerFromToken: valid AND still registered → name; valid but revoked → null", () => {
  const peers = [{ name: "brasdroit1", createdAt: 1 }];
  const tok = signPeerToken("brasdroit1", secret);
  assert.equal(peerFromToken(tok, secret, peers), "brasdroit1");
  // the mac is still valid, but the registry no longer lists it → revoked
  assert.equal(peerFromToken(tok, secret, []), null);
  // a valid token for a DIFFERENT name is not smuggled in
  assert.equal(peerFromToken(signPeerToken("other", secret), secret, peers), null);
});

test("normPeerName: a slug — lowercased, trimmed, safe chars; empty is rejected", () => {
  assert.equal(normPeerName("  BrasDroit 1 "), "brasdroit-1");
  assert.equal(normPeerName("a_b.c"), "a-b-c");
  assert.equal(normPeerName(""), null);
  assert.equal(normPeerName("   "), null);
  assert.equal(normPeerName("é$@"), null); // nothing safe survives
});

test("addPeer / removePeer: dedup by name, supersede, remove", () => {
  let peers = addPeer([], "brasdroit1", 1000);
  assert.equal(peers.length, 1);
  // re-adding the same name supersedes rather than duplicating
  peers = addPeer(peers, "brasdroit1", 2000, "prod");
  assert.equal(peers.length, 1);
  assert.equal(peers[0].note, "prod");
  peers = addPeer(peers, "brasdroit2", 3000);
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

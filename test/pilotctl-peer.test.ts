import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  parseArgs,
  resolvePeer,
  setPeer,
  httpBase,
  wsUrl,
  authHeaders,
  peersFile,
  cmdPeer,
} from "../context/agents-skill/pilotctl.mjs";

test("parseArgs: --peer / --peer-url / --peer-token are value flags", () => {
  const { cmd, pos, flags } = parseArgs(["spawn", "--peer", "brasdroit1", "--profile", "dev"]);
  assert.equal(cmd, "spawn");
  assert.equal(flags.peer, "brasdroit1");
  assert.equal(flags.profile, "dev");
  assert.deepEqual(pos, []);
  const one = parseArgs(["prompt", "abc", "hello", "--peer-url", "https://b.example", "--peer-token", "t"]);
  assert.equal(one.flags["peer-url"], "https://b.example");
  assert.equal(one.flags["peer-token"], "t");
  assert.deepEqual(one.pos, ["abc", "hello"]);
});

test("resolvePeer: valid alias → {url trimmed, token}; missing/malformed → null", () => {
  const map = { brasdroit1: { url: "https://b.example/", token: "tok" }, bad: { url: "x" } };
  assert.deepEqual(resolvePeer(map, "brasdroit1"), { url: "https://b.example", token: "tok" });
  assert.equal(resolvePeer(map, "bad"), null); // no token
  assert.equal(resolvePeer(map, "nope"), null); // no such alias
  assert.equal(resolvePeer({}, "x"), null);
});

test("targeting a peer retargets the base URL and the auth header; clearing restores local", () => {
  setPeer({ url: "https://b.example", token: "tok" });
  assert.equal(httpBase(), "https://b.example");
  assert.equal(wsUrl(), "wss://b.example/ws"); // https → wss
  assert.deepEqual(authHeaders(), { "x-shadok-peer": "tok" }); // never the local key
  // a plain-http peer → ws (not wss)
  setPeer({ url: "http://127.0.0.1:3999", token: "t2" });
  assert.equal(wsUrl(), "ws://127.0.0.1:3999/ws");
  setPeer(null);
  assert.equal(httpBase(), `http://localhost:${process.env.SHADOK_PORT ?? 3789}`);
  assert.ok(!("x-shadok-peer" in authHeaders()));
});

test("peersFile honours SHADOK_PEERS_FILE, else a global fallback", () => {
  const saved = process.env.SHADOK_PEERS_FILE;
  process.env.SHADOK_PEERS_FILE = "/tmp/x/peers-out.json";
  assert.equal(peersFile(), "/tmp/x/peers-out.json");
  delete process.env.SHADOK_PEERS_FILE;
  assert.match(peersFile(), /\.shadok-ai\/peers-out\.json$/);
  if (saved !== undefined) process.env.SHADOK_PEERS_FILE = saved;
});

test("cmdPeer add/list/rm round-trips a file, and list never prints tokens", () => {
  const saved = process.env.SHADOK_PEERS_FILE;
  const f = `/tmp/pilotctl-peer-${process.pid}.json`;
  process.env.SHADOK_PEERS_FILE = f;
  try {
    cmdPeer(["add", "brasdroit1", "https://b.example", "secret-token"]);
    const listed = cmdPeer(["list"]);
    assert.deepEqual(listed, { peers: [{ alias: "brasdroit1", url: "https://b.example" }] });
    assert.ok(!JSON.stringify(listed).includes("secret-token")); // token never surfaced
    cmdPeer(["rm", "brasdroit1"]);
    assert.deepEqual(cmdPeer(["list"]), { peers: [] });
  } finally {
    try { fs.unlinkSync(f); } catch {}
    if (saved !== undefined) process.env.SHADOK_PEERS_FILE = saved;
    else delete process.env.SHADOK_PEERS_FILE;
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("cmdPeer add/list/rm round-trips a file, and list never prints tokens", async () => {
  const saved = process.env.SHADOK_PEERS_FILE;
  const f = `/tmp/pilotctl-peer-${process.pid}.json`;
  process.env.SHADOK_PEERS_FILE = f;
  try {
    // `--token` stores a credential issued some other way: no network.
    await cmdPeer(["add", "brasdroit1", "https://b.example", "secret-token"], { token: true });
    const listed = await cmdPeer(["list"]);
    assert.deepEqual(listed, { peers: [{ alias: "brasdroit1", url: "https://b.example" }] });
    assert.ok(!JSON.stringify(listed).includes("secret-token")); // token never surfaced
    await cmdPeer(["rm", "brasdroit1"]);
    assert.deepEqual(await cmdPeer(["list"]), { peers: [] });
  } finally {
    try { fs.unlinkSync(f); } catch {}
    if (saved !== undefined) process.env.SHADOK_PEERS_FILE = saved;
    else delete process.env.SHADOK_PEERS_FILE;
  }
});


test("cmdPeer add ENROLS: the ticket is exchanged, and a refusal stores nothing", async () => {
  // The point of the exchange: what lands in the outbound file is the durable
  // token the remote handed back, never the ticket that was pasted around.
  const http = await import("node:http");
  let seen: unknown = null;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen = JSON.parse(body || "{}");
      const ok = (seen as { ticket?: string }).ticket === "good-ticket";
      res.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { ok: true, name: "host", token: "durable-token" } : { error: "this invitation is no longer valid" }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-enrol-"));
  const prev = process.env.SHADOK_PEERS_FILE;
  process.env.SHADOK_PEERS_FILE = path.join(dir, "out.json");
  try {
    const r = await cmdPeer(["add", "host", url, "good-ticket"]);
    assert.equal((r as { enrolled?: boolean }).enrolled, true);
    assert.deepEqual(seen, { ticket: "good-ticket" }, "only the ticket is sent");
    const saved = JSON.parse(fs.readFileSync(process.env.SHADOK_PEERS_FILE!, "utf8"));
    assert.equal(saved.host.token, "durable-token", "the DURABLE token is stored");
    assert.notEqual(saved.host.token, "good-ticket", "never the ticket");

    // A dead ticket: refused, and nothing is written for it.
    await assert.rejects(() => cmdPeer(["add", "other", url, "dead-ticket"]), /no longer valid/);
    const after = JSON.parse(fs.readFileSync(process.env.SHADOK_PEERS_FILE!, "utf8"));
    assert.equal(after.other, undefined, "a refused enrolment stores nothing");
  } finally {
    if (prev === undefined) delete process.env.SHADOK_PEERS_FILE;
    else process.env.SHADOK_PEERS_FILE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
    srv.close();
  }
});

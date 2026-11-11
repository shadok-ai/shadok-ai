import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// A room must never get an agent. The pure rules are in test/rooms.test.ts; these
// lock the four places where a room could fall through to a SPAWN, which no
// unit test of src/rooms.ts can see. Source scans, like test/csp.test.ts: a
// refactor that reorders these lines must go red here, not in production.

const tg = fs.readFileSync(new URL("../src/telegram.ts", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function body(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `missing: ${start}`);
  const j = src.indexOf(end, i + start.length);
  assert.ok(j > i, `missing end after: ${start}`);
  return src.slice(i, j);
}

test("telegram: a room topic is routed before anything resolves a bridge (a bridge IS a session)", () => {
  const h = body(tg, "const handleMessage = async", "\n  };\n");
  const room = h.indexOf("roomForTopic(");
  const bridge = h.indexOf("bridgeFor(");
  assert.ok(room > 0, "handleMessage must look the room up");
  assert.ok(bridge > room, "the room lookup must come before the first bridgeFor()");
});

test("telegram: the rooms' mirror loop never opens a bridge nor tracks its topic as sweepable", () => {
  const r = body(tg, "const reconcileRooms = async", "\n  };\n");
  assert.ok(!r.includes("openBridge("), "reconcileRooms must never open a bridge");
  assert.ok(!r.includes("addTgTopic("), "a room topic in the tracked list is swept as an orphan once the room closes");
  const boot = body(tg, "const reconcileOnBoot = async", "\n  };\n");
  assert.match(boot, /bound\.has\(th\) \|\| roomThreads\.has\(th\)/, "the orphan sweep must skip room topics");
});

test("server: a socket is an agent link OR a room link, never both", () => {
  const start = body(server, 'case "start": {', "\n        }\n");
  assert.match(start, /if \(roomId\) return fail\(/, "`start` must be refused on a room socket");
  const join = body(server, 'case "room-join": {', "\n        }\n");
  assert.match(join, /if \(session\) return fail\(/, "`room-join` must be refused on an agent socket");
  assert.ok(!join.includes("createSession("));
  const post = body(server, 'case "room-post": {', "\n        }\n");
  assert.ok(!post.includes("createSession(") && !post.includes("pilot."), "a room post reaches no agent");
  assert.match(post, /author: me\.name/, "the author is the session's account, never the frame's");
});

test("server: room routes refuse agents and peers (people only)", () => {
  const p = body(server, "function roomPerson(", "\n}\n");
  assert.match(p, /machineHeaders\(/);
  assert.match(p, /me\.agent/);
  assert.match(p, /isInternalClient\(/);
});

test("web: a room tab can never send `start`", () => {
  const open = body(page, "function openLink(t) {", "\n  }\n");
  assert.match(open.split("\n").slice(0, 5).join("\n"), /if \(t\.roomId\) return openRoomLink\(t\);/);
  const launch = body(page, "function launchTab(t, msg) {", "\n  }\n");
  assert.match(launch.split("\n")[1], /if \(t\.roomId\) return openRoomLink\(t\);/);
  const room = body(page, "function openRoomLink(tab) {", "\n  }\n");
  assert.ok(!room.includes('"start"'), "the room link only joins");
  // `persistChannels` keeps only tabs with a sessionId — a room has none, so it
  // never lands in PUT /channels (the agent registry).
  assert.match(body(page, "function persistChannels() {", "\n  }\n"), /\.filter\(\(t\) => t && t\.sessionId\)/);
});

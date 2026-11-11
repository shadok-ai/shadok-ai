import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Group } from "../src/groups.js";
import {
  ROOM_TEXT_MAX,
  RoomStore,
  isRoomId,
  newRoomId,
  pageMessages,
  parseMessages,
  patchRoomIn,
  postRefusal,
  roomForTopic,
  roomGroupFor,
  roomName,
  unreadCount,
  visibleRooms,
  type Room,
  type RoomMessage,
} from "../src/rooms.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function room(id: string, extra: Partial<Room> = {}): Room {
  return { id, name: id, createdBy: "ada", createdAt: 1, ...extra };
}
function msg(ts: number, account?: string): RoomMessage {
  return { id: "m" + ts, ts, author: account ?? "tg", ...(account ? { account } : {}), origin: account ? "web" : "telegram", text: "hi " + ts };
}
const groups: Group[] = [
  { id: "main", name: "Main", nature: "public", members: [], createdAt: 0 },
  { id: "comex", name: "Comex", nature: "restricted", members: ["ada"], createdAt: 0 },
  { id: "p-bob", name: "Bob", nature: "private", members: ["bob"], owner: "bob", createdAt: 0 },
];
const ada = { name: "ada", role: "member" as const };
const bob = { name: "bob", role: "admin" as const };

test("a room id is never shaped like a session id", () => {
  for (let i = 0; i < 50; i++) {
    const id = newRoomId();
    assert.ok(isRoomId(id), id);
    assert.ok(!UUID.test(id), id);
  }
  assert.ok(!isRoomId("113f3745-0000-0000-0000-000000000000"));
  assert.ok(!isRoomId("r_../../etc"));
});

test("roomName trims, collapses, and refuses empty or oversized names", () => {
  assert.deepEqual(roomName("  daily   sync "), { ok: true, name: "daily sync" });
  assert.equal(roomName("   ").ok, false);
  assert.equal(roomName(42).ok, false);
  assert.equal(roomName("x".repeat(81)).ok, false);
});

test("roomGroupFor honours a group the caller sees, never one they do not", () => {
  assert.equal(roomGroupFor("comex", groups, ada), "comex");
  assert.equal(roomGroupFor("comex", groups, bob), null); // an admin is not exempt
  assert.equal(roomGroupFor("p-bob", groups, ada), null);
  assert.equal(roomGroupFor("main", groups, ada), "main");
  assert.equal(roomGroupFor("ghost", groups, ada), null);
  assert.equal(roomGroupFor(undefined, groups, ada), null);
});

test("visibleRooms: commons for all, groups by membership, dangling and archived hidden", () => {
  const rooms = [
    room("r_0000000000000001"),
    room("r_0000000000000002", { group: "comex" }),
    room("r_0000000000000003", { group: "gone" }),
    room("r_0000000000000004", { archivedAt: 5 }),
    room("r_0000000000000005", { group: "p-bob" }),
  ];
  assert.deepEqual(visibleRooms(rooms, groups, ada).map((r) => r.id), ["r_0000000000000001", "r_0000000000000002"]);
  assert.deepEqual(visibleRooms(rooms, groups, bob).map((r) => r.id), ["r_0000000000000001", "r_0000000000000005"]);
  assert.deepEqual(visibleRooms(rooms, groups, null).map((r) => r.id), ["r_0000000000000001"]);
});

test("postRefusal names every refusal", () => {
  const r = room("r_0000000000000001");
  assert.equal(postRefusal(undefined, "x")?.code, "unknown-room");
  assert.equal(postRefusal({ ...r, archivedAt: 1 }, "x")?.code, "archived");
  assert.equal(postRefusal(r, "   ")?.code, "empty");
  assert.equal(postRefusal(r, { text: "x" })?.code, "empty");
  assert.equal(postRefusal(r, "x".repeat(ROOM_TEXT_MAX + 1))?.code, "too-long");
  assert.equal(postRefusal(r, "hello"), null);
});

test("patchRoomIn only touches the mutable fields of the one room", () => {
  const list = [room("r_0000000000000001", { telegram: { chatId: -1, threadId: 3 } }), room("r_0000000000000002")];
  const out = patchRoomIn(list, "r_0000000000000001", { name: "renamed", group: "main" });
  assert.equal(out[0].name, "renamed");
  assert.equal(out[0].group, "main");
  assert.deepEqual(out[0].telegram, { chatId: -1, threadId: 3 });
  assert.equal(out[0].createdBy, "ada");
  assert.equal(out[1], list[1]);
});

test("parseMessages skips a torn last line instead of losing the room", () => {
  const raw = JSON.stringify(msg(1, "ada")) + "\n" + JSON.stringify(msg(2)) + "\n" + '{"id":"m3","ts":3,"te';
  assert.deepEqual(parseMessages(raw).map((m) => m.ts), [1, 2]);
});

test("pageMessages returns the newest page before a cursor, oldest first", () => {
  const all = [1, 2, 3, 4, 5].map((t) => msg(t));
  assert.deepEqual(pageMessages(all, undefined, 2).map((m) => m.ts), [4, 5]);
  assert.deepEqual(pageMessages(all, 4, 2).map((m) => m.ts), [2, 3]);
  assert.deepEqual(pageMessages(all, 1, 2), []);
});

test("unreadCount ignores your own messages and anything already read", () => {
  const all = [msg(1, "ada"), msg(2, "bob"), msg(3), msg(4, "ada")];
  assert.equal(unreadCount(all, 0, "ada"), 2);
  assert.equal(unreadCount(all, 2, "ada"), 1);
  assert.equal(unreadCount(all, 0, null), 4);
});

test("roomForTopic matches a live topic only — never a General, a DM or an archived room", () => {
  const rooms = [
    room("r_0000000000000001", { telegram: { chatId: -100, threadId: 7 } }),
    room("r_0000000000000002", { telegram: { chatId: -100, threadId: 8 }, archivedAt: 1 }),
  ];
  assert.equal(roomForTopic(rooms, -100, 7)?.id, "r_0000000000000001");
  assert.equal(roomForTopic(rooms, -100, 8), undefined);
  assert.equal(roomForTopic(rooms, -100, undefined), undefined);
  assert.equal(roomForTopic(rooms, 42, 7), undefined);
});

test("RoomStore: create, append, page, mark read — on disk, private modes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rooms-"));
  try {
    const store = new RoomStore(dir, "k");
    const r = room(newRoomId());
    store.create(r);
    assert.equal(store.get(r.id)?.name, r.id);
    store.append(r.id, msg(1, "ada"));
    store.append(r.id, msg(2, "bob"));
    assert.deepEqual(store.messages(r.id).map((m) => m.ts), [1, 2]);
    store.append(r.id, msg(3)); // the size-keyed cache must see the append
    assert.deepEqual(store.messages(r.id).map((m) => m.ts), [1, 2, 3]);
    store.markRead(r.id, "ada", 2);
    store.markRead(r.id, "ada", 1); // never backwards
    assert.equal(store.lastRead(r.id, "ada"), 2);
    assert.equal(store.lastRead(r.id, "bob"), 0);
    const updated = store.update(r.id, (x) => ({ ...x, archivedAt: 9 }));
    assert.equal(updated?.archivedAt, 9);
    assert.equal(store.update("r_ffffffffffffffff", (x) => x), undefined);
    const mode = (f: string) => fs.statSync(f).mode & 0o777;
    assert.equal(mode(path.join(dir, "k.json")), 0o600);
    assert.equal(mode(path.join(dir, "k", r.id + ".jsonl")), 0o600);
    assert.throws(() => store.messages("../k"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The desktop client's pure logic (desktop/lib/instances.mjs). Electron is not
// needed — and not installed in CI — so only the parts with no Electron import
// are tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUrl,
  defaultName,
  partitionFor,
  parseInstances,
  addInstance,
  renameInstance,
  removeInstance,
  moveInstance,
  titleWantsAttention,
  cleanTitle,
  attentionCount,
  staysInView,
  externalAllowed,
} from "../desktop/lib/instances.mjs";

test("normalizeUrl: a bare loopback host gets http, anything else https", () => {
  assert.deepEqual(normalizeUrl("localhost:3789"), { ok: true, url: "http://localhost:3789/" });
  assert.deepEqual(normalizeUrl("127.0.0.1:3790"), { ok: true, url: "http://127.0.0.1:3790/" });
  assert.deepEqual(normalizeUrl("cockpit.example.com"), { ok: true, url: "https://cockpit.example.com/" });
  assert.deepEqual(normalizeUrl("  http://box.lan:3789/  "), { ok: true, url: "http://box.lan:3789/" });
});

test("normalizeUrl: refuses what must never be loaded beside a bridge", () => {
  for (const bad of ["", "   ", "file:///etc/passwd", "javascript:alert(1)", "ftp://x.y", "http://"]) {
    assert.equal(normalizeUrl(bad).ok, false, bad);
  }
});

test("normalizeUrl: refuses credentials in the address, drops the fragment", () => {
  assert.equal(normalizeUrl("https://admin:pw@cockpit.example.com").ok, false);
  assert.deepEqual(normalizeUrl("https://c.example.com/#x"), { ok: true, url: "https://c.example.com/" });
});

test("defaultName: host, plus the port when there is one", () => {
  assert.equal(defaultName("http://localhost:3789/"), "localhost:3789");
  assert.equal(defaultName("https://c.example.com/"), "c.example.com");
});

test("partitionFor: one persistent partition per instance id, not per origin", () => {
  assert.equal(partitionFor("abc"), "persist:instance-abc");
  assert.notEqual(partitionFor("a"), partitionFor("b"));
});

test("parseInstances: drops malformed rows instead of throwing", () => {
  const list = parseInstances({
    instances: [
      { id: "a", url: "http://localhost:3789", name: "Local" },
      { id: "a", url: "http://localhost:3790" }, // duplicate id
      { id: "b", url: "file:///etc/passwd" }, // unsafe
      { id: "../x", url: "http://localhost:1" }, // bad id
      null,
      "nope",
      { id: "c", url: "remote.example.com", name: "  " }, // blank name → host
    ],
  });
  assert.deepEqual(list, [
    { id: "a", name: "Local", url: "http://localhost:3789/" },
    { id: "c", name: "remote.example.com", url: "https://remote.example.com/" },
  ]);
  assert.deepEqual(parseInstances(null), []);
  assert.deepEqual(parseInstances("garbage"), []);
});

test("add / rename / remove / move", () => {
  const r1 = addInstance([], { url: "localhost:3789" }, "one");
  assert.ok(r1.ok);
  const r2 = addInstance(r1.list, { url: "https://c.example.com", name: "Remote" }, "two");
  assert.ok(r2.ok);
  let list = r2.list;
  assert.deepEqual(list.map((i) => i.name), ["localhost:3789", "Remote"]);

  assert.equal(addInstance(list, { url: "file:///x" }, "x").ok, false);

  list = renameInstance(list, "two", "  Prod  ");
  assert.equal(list[1].name, "Prod");
  list = renameInstance(list, "two", "");
  assert.equal(list[1].name, "c.example.com", "an empty rename falls back to the host");
  assert.equal(list[1].id, "two", "a rename keeps the id, hence the login");

  assert.deepEqual(moveInstance(list, "two", 0).map((i) => i.id), ["two", "one"]);
  assert.deepEqual(moveInstance(list, "nope", 0), list);
  assert.deepEqual(removeInstance(list, "one").map((i) => i.id), ["two"]);
});

test("titleWantsAttention reads the cockpit's own title badge (public/notify.js)", () => {
  assert.equal(titleWantsAttention("● shadok-ai"), true);
  assert.equal(titleWantsAttention("◉ shadok-ai"), true, "the blink's other phase");
  assert.equal(titleWantsAttention("shadok-ai"), false);
  assert.equal(titleWantsAttention("a ● in the middle"), false);
  assert.equal(cleanTitle("◉ shadok-ai"), "shadok-ai");
  assert.equal(attentionCount({ a: { attention: true }, b: { attention: false }, c: { attention: true } }), 2);
});

test("the badge glyphs are the ones notify.js really emits", async () => {
  const { notifyState } = await import("../public/notify.js");
  const blocked = [{ mood: "needs-answer" }];
  for (const phase of [0, 1]) {
    for (const away of [false, true]) {
      assert.equal(titleWantsAttention(notifyState(blocked, { away, phase }).badge + "x"), true);
    }
  }
  assert.equal(titleWantsAttention(notifyState([{ mood: "unread" }], { away: true, phase: 0 }).badge + "x"), true);
  assert.equal(titleWantsAttention(notifyState([{ mood: "working" }], { away: true, phase: 0 }).badge + "x"), false);
});

test("navigation: same origin stays in the view, the rest goes to the browser", () => {
  assert.equal(staysInView("http://localhost:3789/", "http://localhost:3789/login"), true);
  assert.equal(staysInView("http://localhost:3789/", "http://localhost:3790/"), false);
  assert.equal(staysInView("http://localhost:3789/", "https://github.com/"), false);
  assert.equal(staysInView("http://localhost:3789/", "not a url"), false);
  assert.equal(externalAllowed("https://github.com/x"), true);
  assert.equal(externalAllowed("mailto:a@b.c"), true);
  assert.equal(externalAllowed("file:///etc/passwd"), false);
  assert.equal(externalAllowed("smb://host/share"), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bareJid,
  findWaChannel,
  inboundVerdict,
  sendAllowed,
  senderKey,
  waAccountKey,
  waGuestSetup,
  waGuestWorkDirName,
  waReattachList,
  type WaBinding,
  type WaInbound,
} from "../src/wa-guests.js";

const ACCOUNT = "33600000000@s.whatsapp.net";
const LID = "100000000000001@lid";
const PN = "33611111111@s.whatsapp.net";

const msg = (o: Partial<WaInbound> = {}): WaInbound => ({
  id: "M1",
  chat: LID,
  chatAlt: PN,
  fromMe: false,
  live: true,
  unreadable: false,
  text: "hello",
  pushName: "Grace",
  at: 1,
  ...o,
});

test("bareJid drops the device suffix and refuses what is not a jid", () => {
  assert.equal(bareJid("33600000000:12@s.whatsapp.net"), "33600000000@s.whatsapp.net");
  assert.equal(bareJid("100000000000001:3@lid"), "100000000000001@lid");
  assert.equal(bareJid("33600000000@S.WHATSAPP.NET"), "33600000000@s.whatsapp.net");
  assert.equal(bareJid("../x@lid"), null);
  assert.equal(bareJid(""), null);
  assert.equal(bareJid(undefined), null);
  assert.equal(bareJid("12@g.us"), null, "a group is never a person");
});

test("waAccountKey names the linked number without its device", () => {
  assert.equal(waAccountKey({ id: "33600000000:1@s.whatsapp.net" }), ACCOUNT);
  assert.equal(waAccountKey({ id: "33600000000:7@s.whatsapp.net" }), ACCOUNT, "a relink of the same number is the same account");
  assert.equal(waAccountKey(undefined), null);
});

test("waGuestWorkDirName is rebuilt from digits, never sanitised", () => {
  assert.equal(waGuestWorkDirName(LID), "wa-100000000000001");
  assert.equal(waGuestWorkDirName(PN), "wa-33611111111");
  assert.equal(waGuestWorkDirName("33611111111:4@s.whatsapp.net"), "wa-33611111111");
  // Longer than a safe integer: kept as the digits it is, never rounded.
  assert.equal(waGuestWorkDirName("123456789012345678901@lid"), "wa-123456789012345678901");
  for (const bad of ["", "../1@lid", "1.2@lid", "abc@lid", "1/2@lid", 42, null, undefined, "1@g.us", "@lid"])
    assert.equal(waGuestWorkDirName(bad), null, String(bad));
});

test("inboundVerdict: only a live, readable text DM from someone else gets through", () => {
  assert.deepEqual(inboundVerdict(msg()), { kind: "text", lid: LID, pn: PN, text: "hello" });
  // Addressed by phone number, the LID alongside: the same two facts.
  assert.deepEqual(inboundVerdict(msg({ chat: PN, chatAlt: LID })), { kind: "text", lid: LID, pn: PN, text: "hello" });
  assert.deepEqual(inboundVerdict(msg({ chat: "33611111111:2@s.whatsapp.net", chatAlt: undefined })), {
    kind: "text",
    lid: null,
    pn: PN,
    text: "hello",
  });
  const ignored: [Partial<WaInbound>, string][] = [
    [{ chat: "120363000000000000@g.us" }, "group"],
    [{ chat: "status@broadcast" }, "status"],
    [{ chat: "120363000000000000@newsletter" }, "newsletter"],
    [{ chat: "1234@broadcast" }, "broadcast"],
    [{ fromMe: true }, "own"],
    [{ live: false }, "replay"],
    [{ text: "   " }, "no-text"],
    [{ text: undefined }, "no-text"],
    [{ chat: "0@call" }, "not-a-person"],
  ];
  for (const [o, why] of ignored) assert.deepEqual(inboundVerdict(msg(o)), { kind: "ignore", why }, why);
});

test("senderKey prefers the LID", () => {
  assert.equal(senderKey({ lid: LID, pn: PN }), LID);
  assert.equal(senderKey({ lid: null, pn: PN }), PN);
  assert.equal(senderKey({ lid: null, pn: null }), null);
});

type Row = { sessionId: string; whatsapp?: WaBinding | null; telegram?: unknown };
const rows: Row[] = [
  { sessionId: "a", whatsapp: { account: ACCOUNT, id: LID, phone: "33611111111" } },
  { sessionId: "b", whatsapp: { account: ACCOUNT, id: "33622222222@s.whatsapp.net" } },
  { sessionId: "c", whatsapp: { account: "33699999999@s.whatsapp.net", id: "100000000000003@lid" } },
  { sessionId: "d", telegram: { chatId: 5 } },
];

test("findWaChannel: the same person under a LID or a phone number is one row", () => {
  assert.equal(findWaChannel(rows, ACCOUNT, { lid: LID, pn: null })?.sessionId, "a");
  assert.equal(findWaChannel(rows, ACCOUNT, { lid: null, pn: PN })?.sessionId, "a", "by the stored phone");
  // Bound under its phone number before any LID was known: the LID message finds it.
  assert.equal(findWaChannel(rows, ACCOUNT, { lid: "100000000000002@lid", pn: "33622222222@s.whatsapp.net" })?.sessionId, "b");
  assert.equal(findWaChannel(rows, ACCOUNT, { lid: "100000000000009@lid", pn: null }), undefined);
});

test("findWaChannel: another linked number's rows never match", () => {
  assert.equal(findWaChannel(rows, ACCOUNT, { lid: "100000000000003@lid", pn: null }), undefined);
  assert.equal(findWaChannel(rows, "33699999999@s.whatsapp.net", { lid: LID, pn: null }), undefined);
});

test("sendAllowed: only an existing binding of the linked account", () => {
  assert.equal(sendAllowed(rows, ACCOUNT, LID), true);
  assert.equal(sendAllowed(rows, ACCOUNT, "100000000000001:2@lid"), true, "a device suffix is the same person");
  assert.equal(sendAllowed(rows, ACCOUNT, "33677777777@s.whatsapp.net"), false, "never a number that has not written");
  assert.equal(sendAllowed(rows, ACCOUNT, "100000000000003@lid"), false, "another account's binding");
  assert.equal(sendAllowed(rows, ACCOUNT, "120363000000000000@g.us"), false);
});

test("waGuestSetup: the door is open (dm-only) or shut (group), nothing else", () => {
  assert.deepEqual(waGuestSetup({ mode: "dm-only", group: " g1 ", profile: "Support" }), {
    mode: "dm-only",
    group: "g1",
    profile: "Support",
  });
  assert.equal(waGuestSetup({ mode: "group+dm", group: "g1", profile: "Support" }).mode, "group");
  assert.equal(waGuestSetup({ mode: "dm-only", group: null, profile: "Support" }).mode, "group", "half a door is no door");
  assert.equal(waGuestSetup(undefined).mode, "group");
  assert.equal(waGuestSetup({ mode: "dm-only", group: "g", profile: "p", joined: true }).joined, true);
});

test("waReattachList: bound channels of the linked account with no bridge", () => {
  const out = waReattachList(rows, ACCOUNT, (id) => id === "b").map((c) => c.sessionId);
  assert.deepEqual(out, ["a"]);
  assert.deepEqual(waReattachList(rows, null, () => false), [], "nothing linked, nothing to reattach");
});

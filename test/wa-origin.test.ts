import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionOrigin, type ConnectionFacts } from "../src/promptmeta.js";
import { promptAuthor } from "../src/accounts.js";
import { spawnActor } from "../src/secret-audit.js";

// Who is speaking is decided by the CONNECTION (invariant 61). The WhatsApp
// bridge proves its own secret, which is the only thing that makes a socket
// `whatsapp` — and so the only thing that makes its `from` believable.

const none: ConnectionFacts = { systemDrive: false, telegramBridge: false, whatsappBridge: false, agent: false, peer: false, browser: false };

test("connectionOrigin: the WhatsApp bridge's secret makes the origin whatsapp", () => {
  assert.equal(connectionOrigin({ ...none, whatsappBridge: true }, undefined), "whatsapp");
  // The system drive outranks it, as it outranks Telegram's.
  assert.equal(connectionOrigin({ ...none, whatsappBridge: true, systemDrive: true }, undefined), "cron");
});

test("connectionOrigin: claiming whatsapp in the frame gains nothing", () => {
  assert.equal(connectionOrigin(none, "whatsapp"), "cli");
  assert.equal(connectionOrigin({ ...none, browser: true }, "whatsapp"), "web");
  assert.equal(connectionOrigin({ ...none, telegramBridge: true }, "whatsapp"), "telegram");
});

test("promptAuthor believes the sender's name only from the proved bridge", () => {
  assert.equal(promptAuthor("whatsapp", "admin", "Grace"), "Grace");
  assert.equal(promptAuthor("cli", "admin", "Grace"), undefined);
});

test("spawnActor credits a WhatsApp sender", () => {
  assert.deepEqual(spawnActor({ origin: "whatsapp", from: "Grace" }), { actor: "whatsapp Grace", via: "whatsapp" });
  assert.deepEqual(spawnActor({ origin: "whatsapp" }), { actor: "whatsapp", via: "whatsapp" });
});

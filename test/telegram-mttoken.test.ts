import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommand } from "../src/telegram.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TG = fs.readFileSync(path.join(HERE, "..", "src", "telegram.ts"), "utf8");

test("parseCommand accepts /mttoken and /mtcode with their argument", () => {
  assert.deepEqual(parseCommand("/mttoken"), { cmd: "mttoken", arg: "" });
  assert.deepEqual(parseCommand("/mtcode ABC-123"), { cmd: "mtcode", arg: "ABC-123" });
});

test("telegram: both command cases are wired", () => {
  assert.ok(/case "mttoken": \{/.test(TG), "/mttoken case");
  assert.ok(/case "mtcode": \{/.test(TG), "/mtcode case");
});

test("telegram: /mtcode stores via the reserved name, deletes the code message, never echoes the token", () => {
  const start = TG.indexOf('case "mtcode"');
  const block = TG.slice(start, TG.indexOf("case \"secret\"", start));
  assert.ok(
    /submitSetupTokenCode\(cmd\.arg, \(token\) =>[\s\S]*setSecret\(MT_CLAUDE_OAUTH_TOKEN_NAME, token, MAIN_GROUP_ID/.test(block),
    "stored via setSecret(MT_CLAUDE_OAUTH_TOKEN_NAME, token, MAIN_GROUP_ID, …)",
  );
  assert.ok(/deleteMessage/.test(block), "the code message is deleted from the chat");
  assert.ok(!/\$\{.*token.*\}/.test(block), "the token is never interpolated into a reply");
});

test("telegram: help lists the two new commands", () => {
  assert.ok(/\/mttoken —.*\/mtcode <code>/.test(TG), "help mentions /mttoken and /mtcode");
});

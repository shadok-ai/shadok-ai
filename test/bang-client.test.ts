import assert from "node:assert/strict";
import test from "node:test";
import { bangCommands, MAX_BANG_PER_MESSAGE } from "../public/bang.js";

test("an inline `! cmd` is offered, quotes intact", () => {
  // The exact shape that prompted this feature.
  const msg = "Lance ça : `! ssh ubuntu@vps1.alfredclaw.com 'docker exec shadok-ai claude --version'`";
  assert.deepEqual(bangCommands(msg), ["ssh ubuntu@vps1.alfredclaw.com 'docker exec shadok-ai claude --version'"]);
});

test("a command on its own line, in a fenced block, is offered", () => {
  const msg = "Vérifie :\n```\n! claude --version\n```";
  assert.deepEqual(bangCommands(msg), ["claude --version"]);
});

test("prose with an exclamation mark is NEVER a command", () => {
  // The button runs on the machine. A false positive here is a click away from
  // executing a sentence.
  assert.deepEqual(bangCommands("Done! That was quick."), []);
  assert.deepEqual(bangCommands("Attention ! ne fais pas ça"), []);
  assert.deepEqual(bangCommands("x != y"), []);
});

test("duplicates collapse and the list is bounded", () => {
  const same = "`! ls` puis encore `! ls`";
  assert.deepEqual(bangCommands(same), ["ls"]);
  const many = Array.from({ length: 9 }, (_, i) => `\`! echo ${i}\``).join(" ");
  assert.equal(bangCommands(many).length, MAX_BANG_PER_MESSAGE);
});

test("nothing to offer yields nothing", () => {
  assert.deepEqual(bangCommands(""), []);
  assert.deepEqual(bangCommands(undefined), []);
});

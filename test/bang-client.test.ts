import assert from "node:assert/strict";
import test from "node:test";
import { bangCommands, blockCommand, MAX_BANG_PER_MESSAGE } from "../public/bang.js";

test("an inline `! cmd` is offered, quotes intact", () => {
  // The exact shape that prompted this feature.
  const msg = "Lance ça : `! ssh ubuntu@vps1.alfredclaw.com 'docker exec shadok-ai claude --version'`";
  assert.deepEqual(bangCommands(msg), ["ssh ubuntu@vps1.alfredclaw.com 'docker exec shadok-ai claude --version'"]);
});

test("a command on its own line, in a fenced block, is offered", () => {
  const msg = "Vérifie :\n```\n! claude --version\n```";
  assert.deepEqual(bangCommands(msg), ["claude --version"]);
});

test("a standalone line with NO space after `!` is a command (Claude Code bash mode)", () => {
  // The exact report: an agent offered a fenced block `!/tmp/.../allow-pr-merge.sh`
  // and the run button never appeared, because the parser required a space.
  const msg = "Pour autoriser, lance :\n```\n!/tmp/claude-0/scratchpad/allow-pr-merge.sh\n```";
  assert.deepEqual(bangCommands(msg), ["/tmp/claude-0/scratchpad/allow-pr-merge.sh"]);
  assert.deepEqual(bangCommands("!./run.sh"), ["./run.sh"]);
  assert.deepEqual(bangCommands("!claude --version"), ["claude --version"]);
});

test("inline code still REQUIRES the space, so prose tokens stay inert", () => {
  // `!important` (CSS) and `!=` are real in a technical chat; the space is the
  // only thing that tells an inline command from one of these.
  assert.deepEqual(bangCommands("Use `!important` to win the cascade."), []);
  assert.deepEqual(bangCommands("The check is `!=` not `==`."), []);
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

test("blockCommand: a one-line `! cmd` block is runnable, trailing newline and all", () => {
  // marked leaves a trailing newline on the code element's text.
  assert.equal(blockCommand("! claude --version\n"), "claude --version");
  assert.equal(
    blockCommand("! ssh ubuntu@host 'sudo /home/ubuntu/reap-fix.sh url2ad'"),
    "ssh ubuntu@host 'sudo /home/ubuntu/reap-fix.sh url2ad'",
  );
});

test("blockCommand: what the inline button offers equals what bangCommands offers", () => {
  // The two must never disagree about a command's spelling.
  const code = "! ssh ubuntu@host 'docker exec shadok-ai claude --version'\n";
  assert.equal(blockCommand(code), bangCommands(code)[0]);
});

test("blockCommand: a multi-line block is NOT one runnable command", () => {
  // Shell mode reads one line; a glued two-line command would be wrong.
  assert.equal(blockCommand("! cd /tmp\n! ls"), null);
  assert.equal(blockCommand("! make build\nnpm test"), null);
});

test("blockCommand: a one-line block with NO space after `!` is runnable", () => {
  assert.equal(blockCommand("!/tmp/claude-0/scratchpad/allow-pr-merge.sh\n"), "/tmp/claude-0/scratchpad/allow-pr-merge.sh");
  assert.equal(blockCommand("!./run.sh"), "./run.sh");
  // Still agrees with the fallback row.
  const code = "!/opt/deploy.sh\n";
  assert.equal(blockCommand(code), bangCommands(code)[0]);
});

test("blockCommand: a block that is not a command yields null", () => {
  assert.equal(blockCommand("const x = 1;"), null);
  assert.equal(blockCommand("Done! ship it"), null);   // `!` not at the start
  assert.equal(blockCommand(""), null);
  assert.equal(blockCommand(undefined), null);
});

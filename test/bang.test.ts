import assert from "node:assert/strict";
import test from "node:test";
import { runRefusal, isShellMode, MAX_RUN_CHARS, parseBashMessage, MAX_BASH_OUTPUT } from "../src/bang.js";

test("a one-line command is accepted", () => {
  assert.equal(runRefusal("ssh ubuntu@vps1 'docker exec shadok-ai claude --version'"), null);
  assert.equal(runRefusal("  ls -la  "), null);
});

test("multi-line is REFUSED, never joined", () => {
  // Shell mode reads one line. Gluing two lines runs something the human never
  // saw written that way — the one outcome a human-authorised door must avoid.
  assert.match(runRefusal("echo a\necho b")!, /ONE line/);
  // A TRAILING newline is not a second line — a copied command often carries
  // one — so it is trimmed and the command runs.
  assert.equal(runRefusal("echo a\r\n"), null);
});

test("empty, non-string and oversized commands are refused with a reason", () => {
  assert.equal(runRefusal(""), "empty command");
  assert.equal(runRefusal("   "), "empty command");
  assert.equal(runRefusal(undefined), "no command");
  assert.match(runRefusal("x".repeat(MAX_RUN_CHARS + 1))!, /too long/);
});

test("shell mode is the column-0 bang, not the footer hint", () => {
  // Captured on a real pane after typing `!`: the input line is "! " (the
  // padding is a NON-BREAKING space) and the footer carries an indented hint.
  const shell = ["─".repeat(20), "! ", "─".repeat(20), "  ! for shell mode"].join("\n");
  assert.ok(isShellMode(shell));
  // The hint alone — indented — must not count, or a normal prompt screen that
  // merely mentions shell mode would be mistaken for it.
  const normal = ["─".repeat(20), "❯ ", "─".repeat(20), "  ! for shell mode"].join("\n");
  assert.ok(!isShellMode(normal));
  assert.ok(!isShellMode(""));
});

test("a shell-mode exchange is read back from the transcript", () => {
  // Shapes captured from a real pane: the TUI writes both as user messages.
  const inp = parseBashMessage("<bash-input>git commit --allow-empty -m bang-probe</bash-input>");
  assert.deepEqual(inp, { command: "git commit --allow-empty -m bang-probe" });
  const out = parseBashMessage("<bash-stdout>[master (root-commit) 067be88] bang-probe</bash-stdout><bash-stderr></bash-stderr>");
  assert.deepEqual(out, { output: "[master (root-commit) 067be88] bang-probe", isError: false });
});

test("stderr alone reads as a failure, stderr beside stdout does not", () => {
  // git prints progress on stderr; only a run with nothing on stdout AND
  // something on stderr is shown as an error.
  const fail = parseBashMessage("<bash-stdout></bash-stdout><bash-stderr>ls: cannot access 'x'</bash-stderr>") as any;
  assert.equal(fail.isError, true);
  assert.match(fail.output, /cannot access/);
  const mixed = parseBashMessage("<bash-stdout>done</bash-stdout><bash-stderr>warning</bash-stderr>") as any;
  assert.equal(mixed.isError, false);
  assert.equal(mixed.output, "done\nwarning");
});

test("escaped characters come back as they were typed", () => {
  // The quotes and angle brackets of `ssh … 'docker exec …'` must not reach the
  // chat as &quot; — the reader has to recognise the command they ran.
  const r = parseBashMessage("<bash-input>echo &quot;a&quot; &gt; /tmp/x</bash-input>") as any;
  assert.equal(r.command, 'echo "a" > /tmp/x');
});

test("anything else is not a shell exchange", () => {
  assert.equal(parseBashMessage("<system-reminder>x</system-reminder>"), null);
  assert.equal(parseBashMessage("just a prompt"), null);
  assert.equal(parseBashMessage(""), null);
});

test("long output is bounded", () => {
  const r = parseBashMessage(`<bash-stdout>${"x".repeat(MAX_BASH_OUTPUT + 500)}</bash-stdout>`) as any;
  assert.ok(r.output.length <= MAX_BASH_OUTPUT + 2);
});

test("the TAIL streams a shell exchange written with STRING content", async () => {
  // The regression that only a browser showed: parseLine dropped every message
  // whose content was not an array, and the TUI writes `<bash-input>` as a
  // plain string — so the command ran and came back on reload, while the live
  // chat showed nothing at all.
  const { parseLine } = await import("../src/tail.js");
  const inp = parseLine(JSON.stringify({
    type: "user", timestamp: "2026-09-26T18:40:00Z",
    message: { role: "user", content: "<bash-input>echo hi</bash-input>" },
  }));
  assert.deepEqual(inp.map((e: any) => e.kind), ["bash"]);
  assert.equal((inp[0] as any).command, "echo hi");
  const out = parseLine(JSON.stringify({
    type: "user", message: { role: "user", content: "<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>" },
  }));
  assert.equal((out[0] as any).output, "hi");
});

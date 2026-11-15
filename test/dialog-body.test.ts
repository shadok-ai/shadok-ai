import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { detectDialog, dialogKey } from "../src/extract.js";

/**
 * Five screens captured from live 100-column panes (Claude Code 2.1.308–310),
 * kept verbatim except for the local username in paths, replaced by one of the
 * same length so every wrap lands where it did.
 *
 * Claude Code 2.1.310 added a line to file-read permission prompts saying where
 * a symlink leads ("This will read … (outside working directory) via a
 * symlink"). That line, and the `Read(…)` target, are the dialog's BODY: what a
 * person judges the request by. `detectDialog` used to drop it, so a web or
 * Telegram card asked "Do you want to proceed?" about nothing.
 */
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "dialogs");
const screen = (name: string) => fs.readFileSync(path.join(DIR, name), "utf8");
const parse = (name: string) => {
  const d = detectDialog(screen(name));
  assert.ok(d, `${name} must parse as a dialog`);
  return d;
};

const ROOT = "/tmp/claude-0/-Users-dev-user-example-projects-shadok-ai/6c08578f-7866-4450-961b-4fbd25314769/scratchpad/ph310";
const ROOT_DASHED = "/tmp/claude-0/-Users-dev-user-example-projects-shadok-ai-6c08578f-7866-4450-961b-4fbd25314769/scratchpad/ph310";

// ── The part that was already right: options, hints, multi. Pinned exactly as
//    they parsed BEFORE body extraction existed. ─────────────────────────────

const OPTIONS: Record<string, { multi: boolean; options: [string, string][] }> = {
  "read-symlink-outside-310.txt": {
    multi: false,
    options: [
      ["Yes", ""],
      [
        "Yes, allow reading from /tmp/claude-0/-Users-dev-user-example-projects-shadok-ai/6c08578f-7866",
        "-4450-961b-4fbd25314769/scratchpad/ph310/cwd310 during this session",
      ],
      ["No", ""],
    ],
  },
  "read-plain-310.txt": {
    multi: false,
    options: [
      ["Yes", ""],
      [
        "Yes, allow reading from /tmp/claude-0/-Users-dev-user-example-projects-shadok-ai-6c08578f-7866",
        "-4450-961b-4fbd25314769/scratchpad/ph310/cwd310 during this session",
      ],
      ["No", ""],
    ],
  },
  "bash-4option-pipe-body-310.txt": {
    multi: false,
    options: [
      ["Yes", ""],
      [
        "Yes, allow reading from /tmp/claude-0/-Users-dev-user-example-projects-shadok-ai/6c08578f-7866",
        "-4450-961b-4fbd25314769/scratchpad/ph310/outside from this project",
      ],
      ["Yes, and switch to auto mode · auto mode handles these prompts for you", ""],
      ["No", ""],
    ],
  },
  "opus-safeguards-309.txt": {
    multi: false,
    options: [
      ["Switch automatically", "Continue on Opus 4.8 now, and switch without asking from now on"],
      ["Stay on Opus 5.5", "Stop here without switching, and ask me each time a message is flagged"],
      ["Type something.", ""],
      ["Chat about this", ""],
    ],
  },
  "askuserquestion-preview-column-308.txt": {
    multi: false,
    options: [
      ["Sidebar + grid", ""],
      ["Top bar + hero", ""],
      ["Split + table", ""],
    ],
  },
};

for (const [name, want] of Object.entries(OPTIONS)) {
  test(`${name}: options, hints and multi are unchanged`, () => {
    const d = parse(name);
    assert.equal(d.multi, want.multi);
    assert.deepEqual(
      d.options.map((o) => [o.label, o.hint]),
      want.options,
    );
    assert.deepEqual(
      d.options.map((o) => o.n),
      want.options.map((_, i) => i + 1),
    );
  });
}

// ── The body ──────────────────────────────────────────────────────────────

test("a symlink read carries the 2.1.310 disclosure and its target, paths rejoined whole", () => {
  const d = parse("read-symlink-outside-310.txt");
  assert.equal(d.question, "Do you want to proceed?");
  assert.equal(
    d.body,
    [
      "Read file",
      `This will read ${ROOT}/outside/note.txt (outside working directory) via a symlink`,
      `Read(${ROOT}/cwd310/link-to-note.txt)`,
    ].join("\n"),
  );
});

test("the same read without a symlink has no disclosure — only the title and target", () => {
  const d = parse("read-plain-310.txt");
  assert.equal(d.question, "Do you want to proceed?");
  assert.equal(d.body, ["Read file", `Read(${ROOT_DASHED}/cwd310/link-to-note.txt)`].join("\n"));
});

test("a Bash prompt's │-gutter command comes out as the command, without the gutter", () => {
  const d = parse("bash-4option-pipe-body-310.txt");
  assert.equal(d.question, "Do you want to proceed?");
  assert.equal(
    d.body,
    [
      "Bash command",
      'Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
      "Check whether the file is a symlink",
      `ls -l ${ROOT}/cwd310/link-to-note.txt`,
    ].join("\n"),
  );
});

test("the safeguards form: the │-gutter prose is the question, not the ● line above the box", () => {
  // It used to read "● Opus 5.5's safeguards stopped the response above …" — a
  // transcript line OUTSIDE the box, reached because the walk skipped the whole
  // gutter block and never stopped at the box's top rule.
  const d = parse("opus-safeguards-309.txt");
  assert.ok(!d.question.startsWith("●"), d.question);
  assert.ok(d.question.startsWith("Opus 5.5's safeguards flagged this session."), d.question);
  assert.ok(d.question.endsWith("Switch to Opus 4.8 and keep going whenever this happens? You can change this later in /config."), d.question);
  // Word-wrapped prose rejoins with spaces, never glued.
  assert.ok(d.question.includes("Opus 5.5 is more capable"), d.question);
  // The "☐ Model switch" header chip is furniture, not body.
  assert.equal(d.body, undefined);
});

test("invariant 2: an AskUserQuestion preview column never leaks into the body or the question", () => {
  const d = parse("askuserquestion-preview-column-308.txt");
  assert.equal(d.question, "Which layout?");
  // The "☐ Layout" chip is the only thing above the question: no body.
  assert.equal(d.body, undefined);
  const all = [d.question, d.body ?? "", ...d.options.flatMap((o) => [o.label, o.hint])].join("\n");
  assert.doesNotMatch(all, /[│┌└]|NAV|KPI|Chart|Notes:/);
});

test("the body is not identity: dialogKey ignores it (invariant 21)", () => {
  const d = parse("read-symlink-outside-310.txt");
  assert.equal(dialogKey(d), dialogKey({ ...d, body: "repainted" }));
  assert.equal(dialogKey(d), dialogKey({ ...d, body: undefined }));
});

test("no top rule → no body, and the question walk behaves as before", () => {
  const s = ["Some heading", "", "Pick one?", "❯ 1. A", "  2. B"].join("\n");
  const d = detectDialog(s)!;
  assert.equal(d.question, "Pick one?");
  assert.equal(d.body, undefined);
});

test("a body line the TUI broke itself stays on its own line; a word wrap joins with a space", () => {
  // Width 40. " this sentence is long enough that next" ends at column 39, and
  // " word" would overflow it: a word wrap. "Short line" had room to spare: a
  // line the TUI broke on purpose.
  const s = [
    "─".repeat(40),
    " Title",
    " Short line",
    " this sentence is long enough that next",
    " word wraps",
    "",
    " Proceed?",
    " ❯ 1. Yes",
    "   2. No",
  ].join("\n");
  const d = detectDialog(s)!;
  assert.equal(d.question, "Proceed?");
  assert.equal(d.body, "Title\nShort line\nthis sentence is long enough that next word wraps");
});

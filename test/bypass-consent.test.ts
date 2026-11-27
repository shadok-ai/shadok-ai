import test from "node:test";
import assert from "node:assert/strict";
import { settingsPlan } from "../src/claude-home.js";
import { describeStuckScreen, stuckScreenKind } from "../src/detect.js";
import { detectDialog } from "../src/extract.js";
import { submitRecoveryVerdict } from "../src/submit-recovery.js";

/**
 * The real screen, transcribed from a cockpit screenshot of a wedged agent on
 * an instance running in bypass mode (2026-11-27). Kept verbatim — the labels
 * carry no numbers, which is the whole reason nothing recognised it.
 */
const BYPASS_SCREEN = [
  "────────────────────────────────────────────────────────────────────────────",
  "WARNING: Claude Code running in Bypass Permissions mode",
  "",
  "In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.",
  "This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.",
  "",
  "By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.",
  "",
  "https://code.claude.com/docs/en/security",
  "",
  "❯ No, exit",
  "  Yes, I accept",
  "",
  "Enter to confirm · Esc to cancel",
].join("\n");

// ── The cause: the consent is recorded in the HOME the agent actually reads ──

test("settingsPlan: nothing about bypass is written unless the operator chose it", () => {
  // The default path is unchanged, byte for byte: a cosmetic `tui` and nothing
  // else. Accepting a dangerous-mode disclaimer on an instance that never uses
  // the mode would be shadok deciding something nobody asked it to.
  assert.deepEqual(settingsPlan({}), { tui: "fullscreen" });
  assert.equal(settingsPlan({ tui: "fullscreen" }), null);
});

test("settingsPlan: in bypass mode the acceptance is written, once, next to the rest", () => {
  assert.deepEqual(settingsPlan({}, { bypassAccepted: true }), {
    tui: "fullscreen",
    skipDangerousModePermissionPrompt: true,
  });
  // A HOME that already has `tui` is no longer "nothing to do": the key it is
  // missing is the one that matters. This is what makes an existing instance
  // converge when the operator flips the mode on.
  assert.deepEqual(settingsPlan({ tui: "fullscreen" }, { bypassAccepted: true }), {
    tui: "fullscreen",
    skipDangerousModePermissionPrompt: true,
  });
  // Idempotent: nothing left to add, no write.
  assert.equal(settingsPlan({ tui: "fullscreen", skipDangerousModePermissionPrompt: true }, { bypassAccepted: true }), null);
});

test("settingsPlan: an explicit false is somebody asking to be asked — never overwritten", () => {
  assert.equal(settingsPlan({ tui: "x", skipDangerousModePermissionPrompt: false }, { bypassAccepted: true }), null);
});

// ── The symptom: the screen is named, and a restart is not attempted ─────────

test("stuckScreenKind: the bypass disclaimer is recognised, and not as something else", () => {
  assert.equal(stuckScreenKind(BYPASS_SCREEN), "bypass-consent");
  // It is NOT the first-run screen and NOT the numbered-question shape — which
  // is exactly why it used to fall through to "the text never appeared in the
  // input box", a message pointing at an input box that does not exist.
  assert.notEqual(stuckScreenKind(BYPASS_SCREEN), "first-run");
  assert.match(String(describeStuckScreen(BYPASS_SCREEN)), /bypass-permissions disclaimer/);
  assert.match(String(describeStuckScreen(BYPASS_SCREEN)), /skipDangerousModePermissionPrompt/);
});

test("recoveryPlan: the disclaimer escalates to a human instead of respawning for ever", () => {
  const plan = submitRecoveryVerdict({
    enabled: true,
    failure: "not-typed",
    stuck: "bypass-consent",
    exited: false,
    working: false,
    dialogOpen: false,
    restarting: false,
    promptLanded: false,
    sinceLastRecoveryMs: 10 * 60_000,
    cooldownMs: 60_000,
  });
  // A restart lands on the identical screen: the state lives in the HOME, not
  // in the process.
  assert.equal(plan.action, "escalate");
});

// ── And the question reaches the chat, where someone can answer it ───────────

test("detectDialog: a BARE select (no numbers) is a dialog, with its options in order", () => {
  const d = detectDialog(BYPASS_SCREEN);
  assert.ok(d, "the disclaimer was not surfaced as a question at all");
  assert.deepEqual(d.options.map((o) => o.label), ["No, exit", "Yes, I accept"]);
  assert.deepEqual(d.options.map((o) => o.n), [1, 2]);
  assert.equal(d.multi, false);
  // The warning itself lands in `body` — the existing question walk takes the
  // nearest text above the options and stops at the blank line, which here is
  // the docs link. Asserted as it really is rather than reshaped: the shared
  // walk serves every numbered dialog in the cockpit and is not worth bending
  // for one screen, and the card shows body + question + options together.
  assert.equal(d.question, "https://code.claude.com/docs/en/security");
  assert.match(String(d.body), /WARNING: Claude Code running in Bypass Permissions mode/);
  assert.match(String(d.body), /you accept all responsibility/);
});

test("detectDialog: the bare scan needs the TUI's own footer — prose with a ❯ is not a question", () => {
  // The false positive that must not exist: an agent writing about a menu would
  // otherwise publish an invented question to the chat and to Telegram, where a
  // person would answer it.
  const prose = [
    "● Here is what the menu looks like:",
    "❯ No, exit",
    "  Yes, I accept",
    "",
    "● I did not actually open it.",
  ].join("\n");
  assert.equal(detectDialog(prose), null);
});

test("detectDialog: a bare group needs a SIBLING, and alignment is what makes one", () => {
  const lonely = ["❯ No, exit", "", "Enter to confirm · Esc to cancel"].join("\n");
  assert.equal(detectDialog(lonely), null);
  // Mis-aligned by one column: the TUI does not draw that, so we do not read it.
  const askew = ["❯ No, exit", "   Yes, I accept", "Enter to confirm"].join("\n");
  assert.equal(detectDialog(askew), null);
});

test("detectDialog: every NUMBERED screen still takes the old path, untouched by the bare scan", () => {
  // The bare scan runs only when the numbered one found no cursor group, so a
  // numbered dialog that also carries the footer is matched exactly as before.
  const numbered = [
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. No, and tell Claude what to do differently",
    "",
    "Enter to confirm · Esc to cancel",
  ].join("\n");
  const d = detectDialog(numbered);
  assert.ok(d);
  assert.deepEqual(d.options.map((o) => o.label), ["Yes", "No, and tell Claude what to do differently"]);
});

test("detectDialog: with a ❯ left in the scrollback, the LIVE select is the one read", () => {
  // The footer is on screen, so the bare scan runs — and it must land on the
  // dialog the person is looking at, not on an older one still visible above.
  // The numbered scan keeps the bottom-most cursor group for this exact reason.
  const screen = [
    "● Earlier, the agent printed this:",
    "❯ stale one",
    "  stale two",
    "",
    "WARNING: Claude Code running in Bypass Permissions mode",
    "",
    "❯ No, exit",
    "  Yes, I accept",
    "",
    "Enter to confirm · Esc to cancel",
  ].join("\n");
  const d = detectDialog(screen);
  assert.ok(d);
  assert.deepEqual(d.options.map((o) => o.label), ["No, exit", "Yes, I accept"]);
});

test("detectDialog: a bare select with too many aligned lines is not believed", () => {
  // A long aligned block is a table or a paste, not a select. The cap is what
  // stops the scan from swallowing one when the footer happens to be on screen.
  const many = ["❯ a", ...Array.from({ length: 12 }, (_, i) => "  line " + i), "Enter to confirm"].join("\n");
  assert.equal(detectDialog(many), null);
});

test("detectDialog: a question indented to the options' own column is not read as one of them", () => {
  // A boxed bare select with no blank line between the question and the first
  // option. Swallowing the sentence would put a bogus option 1 in front of the
  // real ones and shift every index — `choose` then moves the cursor one step
  // too far and answers the wrong thing.
  const boxed = [
    "  Switch this agent to the other model?",
    "❯ Yes, switch",
    "  No, keep the current one",
    "",
    "Enter to confirm · Esc to cancel",
  ].join("\n");
  const d = detectDialog(boxed);
  assert.ok(d);
  assert.deepEqual(d.options.map((o) => o.label), ["Yes, switch", "No, keep the current one"]);
  assert.match(d.question, /Switch this agent/);
});

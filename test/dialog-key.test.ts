import assert from "node:assert/strict";
import test from "node:test";
import { detectDialog, dialogKey, isResumeSummaryDialog } from "../src/extract.js";

/**
 * The screen captured from a session whose question never reached the chat.
 *
 * It is the real artefact, kept verbatim: a multi-question AskUserQuestion
 * (two tabs in the "← ☐ Filtres ☐ PR #334 ✔ Submit →" bar) whose options sit on
 * the same lines as a multi-line ASCII preview. `detectDialog` handles it — the
 * bug was never the parser, it was that nobody called it. Keeping the screen
 * here means a future change to the preview-stripping is measured against the
 * shape that actually shipped.
 */
const SCREEN = [
  "● Bonne occasion : j'ai justement une vraie question en suspens sur la PR.",
  "",
  "────────────────────────────────────────────────────────────",
  "←  ☐ Filtres  ☐ PR #334  ✔ Submit  →",
  "",
  "Sur mobile, comment veux-tu les 3 filtres de la page Ressources ?",
  "",
  "❯ 1. Empilés (actuel)             ┌──────────────────────────┐",
  "  2. Grille 2 colonnes            │ ┌───────────────────┐    │",
  "  3. Filtres repliables           │ │ 🔍 Rechercher…    │    │",
  "                                  │ └───────────────────┘    │",
  "                                  └──────────────────────────┘",
].join("\n");

test("the shipped stuck screen does parse — the parser was never the bug", () => {
  const d = detectDialog(SCREEN);
  assert.ok(d);
  assert.equal(d.question, "Sur mobile, comment veux-tu les 3 filtres de la page Ressources ?");
  assert.deepEqual(
    d.options.map((o) => o.label),
    ["Empilés (actuel)", "Grille 2 colonnes", "Filtres repliables"],
  );
  assert.equal(d.multi, false);
});

test("the key ignores the ❯ cursor moving between options", () => {
  // The watcher re-parses several times a second; a user arrowing through the
  // options must not read as a new question and re-announce it each time.
  const onFirst = detectDialog(SCREEN)!;
  const onSecond = detectDialog(SCREEN.replace("❯ 1.", "  1.").replace("  2.", "❯ 2."))!;
  assert.equal(dialogKey(onFirst), dialogKey(onSecond));
});

test("a different question is a different key", () => {
  const a = detectDialog(SCREEN)!;
  const b = detectDialog(SCREEN.replace("les 3 filtres", "les 4 filtres"))!;
  assert.notEqual(dialogKey(a), dialogKey(b));
});

test("changing an option label is a different key", () => {
  const a = detectDialog(SCREEN)!;
  const b = detectDialog(SCREEN.replace("Grille 2 colonnes", "Grille 3 colonnes"))!;
  assert.notEqual(dialogKey(a), dialogKey(b));
});

test("a multi-select checkbox does NOT change the key", () => {
  // Toggling a checkbox re-renders the SAME question in place, and that path
  // broadcasts directly; if the key moved, the dedup would fight the re-render.
  const base = ["Pick some", "", "❯ 1. [ ] alpha", "  2. [ ] beta"].join("\n");
  const ticked = ["Pick some", "", "❯ 1. [✔] alpha", "  2. [ ] beta"].join("\n");
  assert.equal(dialogKey(detectDialog(base)!), dialogKey(detectDialog(ticked)!));
});

test("the resume-from-summary prompt is recognised, and nothing else is", () => {
  // Invariant 4: it is auto-answered at startup and must never reach a client.
  assert.equal(
    isResumeSummaryDialog({
      question: "Do you want to resume from the summary?",
      multi: false,
      options: [
        { n: 1, label: "Continue the full session as-is", hint: "" },
        { n: 2, label: "Start from the summary", hint: "" },
      ],
    }),
    true,
  );
  assert.equal(isResumeSummaryDialog(detectDialog(SCREEN)!), false);
});

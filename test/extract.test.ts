import assert from "node:assert/strict";
import test from "node:test";
import { isAgentPrompt, markAgentPrompt } from "../src/kinship.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectDialog,
  extractResponse,
  loadHistory,
  listSessions,
  findSessionId,
  userPromptText,
  lastPromptAt,
  resumedTurnStart,
  MAX_RESUMED_TURN_MS,
} from "../src/extract.js";

// ── detectDialog ─────────────────────────────────────────────────────────

test("single-select dialog: question + options, ❯ selector required", () => {
  const screen = [
    " □ Test",
    "Quelle option préfères-tu ?",
    "❯ 1. Option A",
    "    First option, nothing special.",
    "  2. Option B",
    "  3. Option C",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  const d = detectDialog(screen);
  assert.ok(d, "should detect");
  assert.equal(d!.multi, false);
  assert.equal(d!.question, "Quelle option préfères-tu ?");
  assert.deepEqual(d!.options.map((o) => o.n), [1, 2, 3]);
  assert.equal(d!.options[0].label, "Option A");
  assert.equal(d!.options[0].hint, "First option, nothing special.");
});

test("two-column dialog: the right-hand preview chart is stripped from labels", () => {
  const screen = [
    "Quel style de visualisation veux-tu ?",
    "❯ 1. Barres horizontales          ┌─────────────────────────────────────┐",
    "    (Recommandé)                  │ JAUGES — barres horizontales         │",
    "  2. Sparklines temporelles       │   Session   ████████░░░░  67%         │",
    "  3. Cadrans / arcs               │   Semaine   ██████░░░░░░  42%         │",
    "Enter to select · ↑/↓ to navigate",
  ].join("\n");
  const d = detectDialog(screen);
  assert.ok(d);
  assert.equal(d!.options[0].label, "Barres horizontales");
  assert.equal(d!.options[1].label, "Sparklines temporelles");
  assert.equal(d!.options[2].label, "Cadrans / arcs");
  assert.equal(d!.question, "Quel style de visualisation veux-tu ?");
});

test("multi-select dialog: checkboxes parsed with their state", () => {
  const screen = [
    "Quelles garnitures ?",
    "❯ 1. [✔] Champignons",
    "  2. [ ] Pepperoni",
    "  3. [✔] Mozzarella",
    "Enter to select · ↑/↓ to navigate",
  ].join("\n");
  const d = detectDialog(screen);
  assert.ok(d);
  assert.equal(d!.multi, true);
  assert.deepEqual(
    d!.options.map((o) => o.checked),
    [true, false, true],
  );
});

test("no ❯ selector → not a dialog", () => {
  const screen = ["Some text", "  1. thing", "  2. other"].join("\n");
  assert.equal(detectDialog(screen), null);
});

test("fewer than 2 options → not a dialog", () => {
  assert.equal(detectDialog("Q?\n❯ 1. only one"), null);
});

test("plain transcript text → not a dialog", () => {
  assert.equal(detectDialog("⏺ Voici la réponse.\n\nUn paragraphe normal."), null);
});

test("stacked dialogs: a previous dialog left in the scrollback is ignored — only the one carrying the ❯ cursor is parsed", () => {
  // A previous (already answered) multi-select dialog is still visible above the
  // current single-select one in the xterm buffer. detectDialog must isolate the
  // CURRENT dialog (the block carrying the ❯ cursor), not merge both option sets
  // (which corrupted the numbering, forced multi=true, and showed the wrong
  // question).
  const screen = [
    "Previous question — what to configure?",
    "  1. [✔] Token du bot",
    "  2. [ ] Activer / désactiver",
    "  3. [✔] État / diagnostic",
    "← ☐ ☐ ✔ Submit →",
    "",
    "Comment gérer l'affichage du token ?",
    "❯ 1. Write-only",
    "    Le token n'est jamais réaffiché.",
    "  2. Révélable",
    "    Masqué par défaut, révélable.",
    "Enter to confirm · Esc to cancel",
  ].join("\n");
  const d = detectDialog(screen);
  assert.ok(d);
  assert.equal(d!.options.length, 2);
  assert.equal(d!.multi, false);
  assert.deepEqual(
    d!.options.map((o) => o.label),
    ["Write-only", "Révélable"],
  );
  assert.match(d!.question, /Comment gérer/);
});

// ── extractResponse ──────────────────────────────────────────────────────

test("extractResponse takes the ⏺ answer after the prompt echo, dropping status", () => {
  const buffer = [
    "❯ Explique X",
    "⏺ Voici l'explication de X.",
    "  suite sur deux lignes.",
    "✻ Cooked for 3s",
    "────────────────────────────────────────────",
    "❯ ",
  ].join("\n");
  const out = extractResponse(buffer, "Explique X");
  assert.match(out, /Voici l'explication de X/);
  assert.match(out, /suite sur deux lignes/);
  assert.doesNotMatch(out, /Cooked for/);
  assert.doesNotMatch(out, /^❯/m);
});

// ── filesystem readers (loadHistory / listSessions / findSessionId) ───────
// Run against a throwaway HOME so we never touch the real ~/.claude.

function withTempHome(fn: (cwd: string, sid: string) => void) {
  const prevHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cp-home-"));
  process.env.HOME = tmp;
  try {
    const cwd = "/tmp/some/project";
    const sid = "abc123-session";
    const enc = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const dir = path.join(tmp, ".claude", "projects", enc);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "user", isMeta: true, message: { content: "<system>" } }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-28T21:57:55.938Z",
        message: { content: "Première demande" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-28T21:58:10.000Z",
        message: { content: [{ type: "text", text: "Réponse une." }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-28T21:59:30.000Z",
        message: { content: [{ type: "text", text: "Suite de la réponse une." }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "NOTHING TO SHOW" }] },
      }),
      JSON.stringify({ type: "user", message: { content: "[Request interrupted…" } }),
      // Un tour déclenché par un cron : le prompt est écrit dans le transcript
      // comme n'importe quel message utilisateur, mais ne doit jamais être rendu.
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-28T22:10:00.000Z",
        message: { content: "⏰ [cron] Résultat du monitoring :\n3 kB de dump\n\nRédige l'état des lieux." },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-28T22:10:30.000Z",
        message: { content: [{ type: "text", text: "Rapport du matin." }] },
      }),
    ].join("\n");
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines);
    fn(cwd, sid);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("loadHistory: real turns only, consecutive assistant blocks merged, meta/interrupt skipped", () => {
  withTempHome((cwd, sid) => {
    const turns = loadHistory(cwd, sid);
    assert.deepEqual(
      turns.map((t) => t.role),
      ["user", "assistant"],
    );
    assert.equal(turns[0].text, "Première demande");
    assert.match(turns[1].text, /Réponse une\.\n\nSuite de la réponse une\./);
  });
});

test("loadHistory: a NOTHING TO SHOW block leaves no trace in the replayed history", () => {
  withTempHome((cwd, sid) => {
    const turns = loadHistory(cwd, sid);
    assert.equal(turns.length, 2); // pas de troisième tour né de la sentinelle
    assert.doesNotMatch(turns[1].text, /NOTHING TO SHOW/);
  });
});

test("findSessionId returns the session's id; listSessions previews the first prompt", () => {
  withTempHome((cwd, sid) => {
    assert.equal(findSessionId(cwd), sid);
    const list = listSessions(cwd);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, sid);
    assert.equal(list[0].preview, "Première demande");
  });
});

test("loadHistory: chaque tour porte l'heure du .jsonl, le tour fusionné garde la première", () => {
  withTempHome((cwd, sid) => {
    const turns = loadHistory(cwd, sid);
    assert.equal(turns[0].at, Date.parse("2026-07-28T21:57:55.938Z"));
    // Deux blocs assistant fusionnés : l'heure est celle du DÉBUT de la prise de
    // parole, pas celle du dernier bloc.
    assert.equal(turns[1].at, Date.parse("2026-07-28T21:58:10.000Z"));
  });
});

test("loadHistory: un transcript sans timestamp ne fabrique pas d'heure", () => {
  const prevHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cp-home-"));
  process.env.HOME = tmp;
  try {
    const cwd = "/tmp/other/project";
    const sid = "no-ts-session";
    const dir = path.join(tmp, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, sid + ".jsonl"),
      JSON.stringify({ type: "user", message: { content: "sans horodatage" } }),
    );
    assert.equal(loadHistory(cwd, sid)[0].at, undefined);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadHistory on a missing transcript is empty, never throws", () => {
  assert.deepEqual(loadHistory("/nope/nowhere", "missing"), []);
});

// ── Origine d'un tour retrouvé en cours (après un redémarrage) ─────────────

test("userPromptText : un vrai prompt oui, une ligne technique non", () => {
  assert.equal(userPromptText({ type: "user", message: { content: "salut" } }), "salut");
  assert.equal(
    userPromptText({ type: "user", message: { content: [{ type: "text", text: "  salut  " }] } }),
    "salut",
  );
  // Un résultat d'outil arrive EN COURS de tour : le prendre pour un prompt
  // daterait l'origine du tour quelques secondes avant maintenant.
  assert.equal(userPromptText({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }), null);
  assert.equal(userPromptText({ type: "user", isMeta: true, message: { content: "salut" } }), null);
  assert.equal(userPromptText({ type: "user", message: { content: "<system-reminder>" } }), null);
  assert.equal(userPromptText({ type: "user", message: { content: "[Request interrupted…" } }), null);
  assert.equal(userPromptText({ type: "assistant", message: { content: [] } }), null);
  assert.equal(userPromptText(null), null);
});

test("lastPromptAt : l'heure du DERNIER vrai prompt, pas celle d'un résultat d'outil", () => {
  const prevHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cp-home-"));
  process.env.HOME = tmp;
  try {
    const cwd = "/tmp/turn/project";
    const sid = "turn-session";
    const dir = path.join(tmp, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, sid + ".jsonl"),
      [
        JSON.stringify({ type: "user", timestamp: "2026-07-30T08:00:00.000Z", message: { content: "vieux prompt" } }),
        JSON.stringify({ type: "user", timestamp: "2026-07-30T09:00:00.000Z", message: { content: "le prompt du tour" } }),
        // Écrits APRÈS, pendant le tour : ils ne doivent pas devenir l'origine.
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-30T09:00:05.000Z",
          message: { content: [{ type: "text", text: "je cherche" }] },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-07-30T09:09:00.000Z",
          message: { content: [{ type: "tool_result", content: "sortie de commande" }] },
        }),
      ].join("\n"),
    );
    assert.equal(lastPromptAt(cwd, sid), Date.parse("2026-07-30T09:00:00.000Z"));
    assert.equal(lastPromptAt(cwd, "aucune-session"), null);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resumedTurnStart : reprend le transcript, sauf quand il n'est pas croyable", () => {
  const now = Date.parse("2026-07-30T09:10:00.000Z");
  const tenMinAgo = Date.parse("2026-07-30T09:00:00.000Z");
  // Le cas utile : l'agent réfléchit depuis 10 min, le chrono doit le dire.
  assert.equal(resumedTurnStart(now, tenMinAgo), tenMinAgo);
  // Pas de transcript exploitable → on repart de maintenant (0 s), pas de NaN.
  assert.equal(resumedTurnStart(now, null), now);
  // Horodatage dans le futur (horloge de la machine changée) : refusé, sinon la
  // durée affichée serait négative.
  assert.equal(resumedTurnStart(now, now + 60_000), now);
  // Trop vieux : ce prompt appartient à un tour déjà fini, on afficherait son ÂGE
  // et pas une durée de réflexion.
  assert.equal(resumedTurnStart(now, now - MAX_RESUMED_TURN_MS - 1), now);
  assert.equal(resumedTurnStart(now, now - MAX_RESUMED_TURN_MS + 1), now - MAX_RESUMED_TURN_MS + 1);
});

test("loadHistory : le prompt d'un cron n'est jamais rejoué, sa réponse si", () => {
  withTempHome((cwd, sid) => {
    const turns = loadHistory(cwd, sid);
    // Aucun tour utilisateur ne porte le prompt programmé…
    assert.equal(turns.some((t) => t.role === "user" && /\[cron\]/.test(t.text)), false);
    assert.equal(turns.some((t) => /dump/.test(t.text)), false);
    // …mais ce que l'agent en a répondu reste, c'est tout l'intérêt du cron.
    assert.equal(turns.some((t) => t.role === "assistant" && /Rapport du matin/.test(t.text)), true);
  });
});

test("loadHistory drops a parent notification, like a scheduled prompt", () => {
  // It reaches the transcript as an ordinary user message. Without the filter
  // it reads as something the human typed, and comes back on every web reload
  // and Telegram backfill — the bug CRON_PROMPT_MARK already exists to prevent.
  assert.equal(isAgentPrompt(markAgentPrompt('Agent "kid" finished its turn.')), true);
  assert.equal(isAgentPrompt("please review the diff"), false);
});

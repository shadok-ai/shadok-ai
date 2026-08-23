import assert from "node:assert/strict";
import test from "node:test";
import { extractLiveText } from "../public/live-text.js";

// Bas d'écran commun (séparateurs + box de saisie + footer).
const FOOTER = [
  "────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────",
  "  00:04:01  elapsed:6h58m51s  ctx:4%  ~$0,123  5h:8%",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

test("nouveau bullet ● (Claude Code 2.1): reconnu comme un bloc de texte", () => {
  // Claude Code 2.1 rend le bloc assistant avec "●" (U+25CF) au lieu de "⏺"
  // (U+23FA). Sans le reconnaître, extractLiveText renvoyait "" → aperçu live et
  // préface de question morts sur les versions récentes.
  const screen = [
    "● Une réponse en cours d'écriture qui s'étale sur plusieurs",
    "  lignes enroulées par le terminal.",
    "✻ Crunched for 2s",
    FOOTER,
  ].join("\n");
  assert.equal(
    extractLiveText(screen),
    "Une réponse en cours d'écriture qui s'étale sur plusieurs lignes enroulées par le terminal.",
  );
});

test("● tool_use n'est pas du texte (comme ⏺)", () => {
  assert.equal(extractLiveText(["● Bash(ls -la)", FOOTER].join("\n")), "");
});

test("bloc unique en cours: dé-wrappe les continuations", () => {
  const screen = [
    "⏺ Voici une introduction en cours d'écriture qui s'étale sur plusieurs",
    "  lignes parce que le terminal les enroule à la largeur, et le texte",
    "  continue encore un peu ici.",
    "✽ Composing… (4s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(
    extractLiveText(screen),
    "Voici une introduction en cours d'écriture qui s'étale sur plusieurs lignes parce que le terminal les enroule à la largeur, et le texte continue encore un peu ici.",
  );
});

test("multi-bloc: renvoie le dernier bloc de texte, pas le premier", () => {
  const screen = [
    "⏺ Premier paragraphe déjà terminé.",
    "",
    "  Ran 1 shell command",
    "",
    "⏺ Deuxième paragraphe en cours d'écriture maintenant.",
    "✽ Composing… (2s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(extractLiveText(screen), "Deuxième paragraphe en cours d'écriture maintenant.");
});

test("bloc multi-paragraphes en cours: tous les paragraphes (séparés par une ligne vide) sont capturés", () => {
  // Capture réelle : un long bloc assistant dont les paragraphes sont séparés
  // par une ligne vide. Avant le fix, l'extraction s'arrêtait à la 1re ligne
  // vide → seul le 1er paragraphe s'affichait en aperçu, tout le reste
  // apparaissait "d'un coup" à la finalisation (« le stream bizarre »).
  const screen = [
    "⏺ C'est fait, et la réponse à ta question a changé en cours de route.",
    "",
    "  Maintenant oui, à jour : main local = origin/main, 0 commit de retard.",
    "",
    "  Deuxième paragraphe qui doit lui aussi apparaître dans l'aperçu live.",
    "✽ Composing… (3s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  const out = extractLiveText(screen);
  assert.match(out, /C'est fait/);
  assert.match(out, /Maintenant oui/);
  assert.match(out, /Deuxième paragraphe/);
});

test("un résumé d'outil indenté après une ligne vide n'est PAS aspiré dans le texte", () => {
  const screen = [
    "⏺ Un paragraphe de texte terminé.",
    "",
    "  Ran 1 shell command",
    "✽ Running… (1s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(extractLiveText(screen), "Un paragraphe de texte terminé.");
});

test('dernier ⏺ est un tool_use → ""', () => {
  const screen = [
    "⏺ Premier paragraphe de texte.",
    "",
    "⏺ Bash(echo A)",
    "  ⎿  A",
    "✽ Running… (1s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(extractLiveText(screen), "");
});

test('aucun ⏺ → ""', () => {
  const screen = ["❯ un prompt en attente", FOOTER].join("\n");
  assert.equal(extractLiveText(screen), "");
});

test('dernier ⏺ est un outil en cours ("Running…") → ""', () => {
  const screen = [
    "⏺ Un paragraphe de texte déjà écrit.",
    "",
    "⏺ Running 1 shell command",
    "✽ Running… (2s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(extractLiveText(screen), "");
});

test('dernier ⏺ est un outil fini ("Ran…") → ""', () => {
  const screen = ["⏺ Ran 1 shell command", FOOTER].join("\n");
  assert.equal(extractLiveText(screen), "");
});

test("continuation stoppe au résultat d'outil ⎿", () => {
  const screen = [
    "⏺ Texte avant un outil.",
    "  ⎿  sortie d'outil qui ne doit pas être aspirée",
    "✽ Composing… (1s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(extractLiveText(screen), "Texte avant un outil.");
});

test("écran de dialog réel: le paragraphe précédant la question est retrouvé", () => {
  // Capture réelle du pane TUI pendant qu'un AskUserQuestion était affiché —
  // le cas que le bridge Telegram doit savoir extraire (spec du 2026-07-28).
  const screen = [
    "⏺ Option A. Je regarde les pièces concernées avant d'écrire quoi que ce soit.",
    "",
    "  Searched for 1 pattern, read 1 file, ran 1 shell command",
    "",
    "⏺ Ce paragraphe est là pour servir de texte-préface au test : une capture de l'écran TUI se",
    "  déclenche dans 25 secondes, pendant que la question ci-dessous sera affichée. Réponds ce que tu",
    "  veux, seule la capture m'intéresse.",
    "",
    "❯ /login",
    "────────────────────────────────────────────",
    " ☐ Capture",
    "",
    "Capture en cours — réponds n'importe quoi après ~30 s.",
    "",
    "❯ 1. OK",
    "     Laisse passer ~30 secondes avant de cliquer.",
    "  2. Annule",
    "     Arrête le test de capture.",
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  assert.equal(
    extractLiveText(screen),
    "Ce paragraphe est là pour servir de texte-préface au test : une capture de l'écran TUI se " +
      "déclenche dans 25 secondes, pendant que la question ci-dessous sera affichée. Réponds ce que tu " +
      "veux, seule la capture m'intéresse.",
  );
});

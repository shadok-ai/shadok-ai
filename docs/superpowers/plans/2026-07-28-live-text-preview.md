# Live-text preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Afficher un aperçu live (best-effort) du bloc de texte assistant en cours de génération, extrait de l'écran TUI, puis le remplacer par la version markdown autoritative dès que le bloc `.jsonl` arrive.

**Architecture:** 100 % client. Une fonction pure `extractLiveText(screen)` (fichier `public/live-text.js`, importable en test node ET chargée par le navigateur) extrait le dernier bloc de texte `⏺` de l'écran. Le client (`public/index.html`), sur chaque message `screen` d'un tour actif, affiche/rafraîchit une bulle provisoire grisée ; sur `stream-text` il la remplace par le rendu markdown ; sur `turn-done`/`dialog` il la jette. Zéro changement serveur.

**Tech Stack:** JavaScript ESM (pas de build côté client), `node:test` via `tsx` (`npm test`), DOM natif (le client n'a aucun framework).

## Global Constraints

- Pas de build pour le client : `public/*.js` est servi tel quel par `express.static`. Le fichier partagé DOIT être du JS ESM valide (`export function …`) chargeable par le navigateur ET par node/tsx.
- Tests exécutés par `npm test` = `node --import tsx --test test/*.ts …`. Un test dans `test/*.ts` peut importer un `.js` ESM via `import { x } from "../public/live-text.js"`.
- Le provisoire est **éphémère** : jamais persisté, jamais compté comme historique. Toujours remplacé (`stream-text`) ou jeté (`turn-done`/`dialog`).
- Dégradation gracieuse : si l'extraction renvoie `""`, aucune bulle provisoire → comportement actuel inchangé.
- Le marqueur de bloc de texte assistant dans le TUI est `⏺ ` (U+23FA + espace) en colonne 0 ; les continuations sont indentées de 2 espaces ; un `tool_use` rend `⏺ Nom(args)` ; un résultat d'outil rend `  ⎿ …`.

---

## File Structure

- **Create** `public/live-text.js` — la fonction pure `extractLiveText(screen)`. Une seule responsabilité : parser un écran TUI → dernier bloc de texte assistant dé-wrappé (ou `""`).
- **Create** `test/live-text.test.ts` — tests unitaires de `extractLiveText` sur fixtures d'écran réelles.
- **Modify** `public/index.html` — pont module vers `window.extractLiveText`, CSS `.live-preview`, helpers `updateLivePreview`/`clearLivePreview`, et branchements dans les handlers `working`/`screen`/`stream-text`/`turn-done`/`dialog`.

---

## Task 1: Fonction pure `extractLiveText` + tests

**Files:**
- Create: `public/live-text.js`
- Test: `test/live-text.test.ts`

**Interfaces:**
- Produces: `export function extractLiveText(screen: string): string` — renvoie le **dernier** bloc de texte assistant visible sur l'écran, dé-wrappé (continuations rejointes par un espace). Renvoie `""` si aucun bloc `⏺ ` de texte, ou si le dernier `⏺ ` est un `tool_use` (`⏺ Nom(…)`).

- [ ] **Step 1: Écrire le test qui échoue**

Create `test/live-text.test.ts`:

```ts
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

test("dernier ⏺ est un tool_use → \"\"", () => {
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

test("aucun ⏺ → \"\"", () => {
  const screen = ["❯ un prompt en attente", FOOTER].join("\n");
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
```

- [ ] **Step 2: Lancer le test → échec attendu**

Run: `cd .claude/worktrees/live-text-preview && npx tsx --test test/live-text.test.ts`
Expected: FAIL — `Cannot find module '../public/live-text.js'`.

- [ ] **Step 3: Implémenter `public/live-text.js`**

Create `public/live-text.js`:

```js
// Extraction best-effort du bloc de texte assistant en cours, depuis l'écran
// TUI (@xterm/headless) — voir docs/superpowers/specs/2026-07-28-live-text-preview-design.md.
//
// Chargé tel quel par le navigateur (ESM) et importé par les tests node/tsx.
// Le transcript .jsonl n'écrit un bloc de texte que TERMINÉ ; l'écran, lui, le
// montre au fil de la frappe → seule source token-granulaire.
//
// Un bloc de texte assistant = une ligne "⏺ <prose>" (U+23FA + espace) en
// colonne 0, suivie de continuations indentées de 2 espaces. Un tool_use rend
// "⏺ Nom(args)" ; un résultat d'outil rend "  ⎿ …".

const MARKER = "⏺ "; // "⏺ "

/** Le dernier bloc de texte assistant visible, dé-wrappé ; "" sinon. */
export function extractLiveText(screen) {
  if (typeof screen !== "string" || !screen) return "";
  const lines = screen.split("\n");

  // Trouver le dernier marqueur de bloc "⏺ " en colonne 0.
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(MARKER)) { start = i; break; }
  }
  if (start < 0) return "";

  const head = lines[start].slice(MARKER.length).trim();
  // tool_use : "⏺ Nom(...)" — identifiant collé à une parenthèse.
  if (/^[\w.-]+\(/.test(head)) return "";

  const parts = [head];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith("  ") || l.trim() === "") break; // spinner/blanc/séparateur/fin
    const t = l.trim();
    if (t.startsWith("⎿") || /^Ran\b/.test(t)) break; // sous-ligne d'outil
    parts.push(t);
  }
  return parts.join(" ");
}
```

- [ ] **Step 4: Lancer le test → succès attendu**

Run: `cd .claude/worktrees/live-text-preview && npx tsx --test test/live-text.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Vérifier la suite complète**

Run: `cd .claude/worktrees/live-text-preview && npm test`
Expected: tous les tests passent (les précédents + les 5 nouveaux).

- [ ] **Step 6: Commit**

```bash
git add public/live-text.js test/live-text.test.ts
git commit -m "Live-text: fonction pure extractLiveText + tests"
```

---

## Task 2: Branchement client (pont, CSS, helpers, handlers)

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `window.extractLiveText(screen)` (Task 1, via le pont module).
- Consumes (existant): `addTurn(tab, role, who, text, extraClass)` ; `tab.transcriptEl` ; `active` ; messages WS `working` / `screen` (avec `msg.working`, `msg.text`) / `stream-text` (`msg.text`) / `turn-done` / `dialog` ; `tab.screenText`.
- Produces (état sur `tab`) : `tab.livePreviewEl` (élément DOM ou null), `tab.livePreviewBubble` (div.bubble ou null), `tab.lastFinalizedScreenText` (string ou null).

- [ ] **Step 1: Pont module → `window.extractLiveText`**

Dans `public/index.html`, juste après la ligne `<script src="/vendor/marked.js"></script>`, ajouter :

```html
<script type="module">
  import { extractLiveText } from "/live-text.js";
  window.extractLiveText = extractLiveText;
</script>
```

- [ ] **Step 2: CSS de la bulle provisoire**

Dans le bloc `<style>`, à la suite de la règle `.turn.hist { opacity: 0.8; }`, ajouter :

```css
  /* Aperçu live du bloc en cours, extrait de l'écran TUI (brut, non-markdown).
     Grisé + pré-formaté pour signaler que c'est provisoire ; remplacé par le
     bloc .jsonl (stream-text) dès qu'il arrive. */
  .turn.claude.live-preview .bubble {
    opacity: 0.55;
    white-space: pre-wrap;
    font-family: var(--mono);
  }
  .turn.claude.live-preview .bubble::after {
    content: "▍";
    animation: breathe 1s step-start infinite;
  }
```

- [ ] **Step 3: Helpers `updateLivePreview` / `clearLivePreview`**

Juste après la fonction `addTurn` (elle se termine par `return bubble; }`), ajouter :

```js
  /* ── Aperçu live du texte en cours ───────────────────────
     Le .jsonl n'écrit un bloc de texte que TERMINÉ, donc rien ne s'affiche
     pendant sa génération. On comble avec le dernier bloc lu sur l'écran TUI
     (window.extractLiveText), dans une bulle provisoire, remplacée par le rendu
     markdown autoritatif dès que `stream-text` livre le bloc complet.

     Déduplication : après un `stream-text`, l'écran continue de montrer le même
     bloc `⏺` ; on mémorise sa forme-écran (`lastFinalizedScreenText`) pour ne
     pas recréer un provisoire qui doublonnerait la bulle déjà finalisée. */
  function updateLivePreview(tab, screen) {
    if (!window.extractLiveText) return;
    const txt = extractLiveText(screen);
    if (!txt) return; // trou d'extraction : garder l'existant tel quel
    if (txt === tab.lastFinalizedScreenText) { clearLivePreview(tab); return; }
    if (!tab.livePreviewEl) {
      const turn = document.createElement("div");
      turn.className = "turn claude live-preview";
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      turn.appendChild(bubble);
      tab.transcriptEl.appendChild(turn);
      tab.livePreviewEl = turn;
      tab.livePreviewBubble = bubble;
    }
    tab.livePreviewBubble.textContent = txt;
    if (tab === active) tab.transcriptEl.scrollTop = tab.transcriptEl.scrollHeight;
  }

  function clearLivePreview(tab) {
    if (tab.livePreviewEl) tab.livePreviewEl.remove();
    tab.livePreviewEl = null;
    tab.livePreviewBubble = null;
  }
```

- [ ] **Step 4: `working` — réarmer pour le nouveau tour**

Dans `case "working":`, à la fin du bloc (après `setTabState(t, "busy", "responding…");`), ajouter :

```js
        clearLivePreview(t);
        t.lastFinalizedScreenText = null;
```

- [ ] **Step 5: `screen` — rafraîchir le provisoire pendant le travail**

Dans `case "screen":`, la version actuelle est :

```js
      case "screen":
        t.screenText = msg.text;
        if (t === active) screenEl.textContent = msg.text;
        break;
```

La remplacer par :

```js
      case "screen":
        t.screenText = msg.text;
        if (t === active) screenEl.textContent = msg.text;
        if (msg.working) updateLivePreview(t, msg.text);
        break;
```

- [ ] **Step 6: `stream-text` — snapshot puis remplacement**

Dans `case "stream-text":`, remplacer le corps actuel :

```js
        retireChoices(t);
        closeActivity(t);
        addTurn(t, "claude", "claude", msg.text, "live");
        break;
```

par :

```js
        retireChoices(t);
        closeActivity(t);
        // Mémoriser la forme-écran du bloc qu'on finalise, pour empêcher un
        // provisoire doublon tant que l'écran le montre encore, puis remplacer.
        if (window.extractLiveText) t.lastFinalizedScreenText = extractLiveText(t.screenText);
        clearLivePreview(t);
        addTurn(t, "claude", "claude", msg.text, "live");
        break;
```

- [ ] **Step 7: `turn-done` et `dialog` — jeter tout provisoire résiduel**

Dans `case "turn-done":`, après `retireChoices(t);`, ajouter `clearLivePreview(t);`.

Dans `case "dialog":`, après `closeActivity(t);`, ajouter `clearLivePreview(t);`.

- [ ] **Step 8: `git add` + commit**

```bash
git add public/index.html
git commit -m "Live-text: bulle provisoire côté client (screen → remplacée par .jsonl)"
```

---

## Task 3: Vérification manuelle en conditions réelles

**Files:** aucun (vérification).

- [ ] **Step 1: Build (serveur) depuis le worktree**

Run: `cd .claude/worktrees/live-text-preview && npm run build`
Expected: `tsc` sans erreur (aucun `.ts` modifié, mais valide que le worktree build).

- [ ] **Step 2: Lancer un serveur de dev depuis le worktree sur un port dédié**

Run (token injecté dans le shell, jamais par node) :

```bash
cd .claude/worktrees/live-text-preview && \
CLAUDE_CODE_OAUTH_TOKEN=$(security find-generic-password -s 'Claude Code-credentials' -a "$USER" -w | jq -r '.claudeAiOauth.accessToken') \
PORT=3899 node dist/server.js > /tmp/livetext-dev.log 2>&1 &
```
Expected: `curl -s -o /dev/null -w '%{http_code}' localhost:3899/` → `200` ; `curl -s -o /dev/null -w '%{http_code}' localhost:3899/live-text.js` → `200`.

- [ ] **Step 3: Ouvrir http://localhost:3899, créer un canal, envoyer un prompt**

Prompt de test : « écris un paragraphe d'intro de 5-6 phrases, puis lance `echo A`, puis un paragraphe de conclusion de 5-6 phrases ».

Observer : pendant la génération du paragraphe, une **bulle grisée se remplit en direct** (curseur ▍) ; quand le bloc atterrit, elle est **remplacée** par la bulle markdown nette. Aucun doublon ne subsiste après le tour.

- [ ] **Step 4: Arrêter le serveur de dev**

Run: `pkill -f 'PORT=3899' 2>/dev/null; pkill -f 'dist/server.js.*3899' 2>/dev/null || true`
(Ne PAS toucher au serveur de prod sur 3789.)

- [ ] **Step 5 (si OK): finaliser la branche**

La branche `worktree-live-text-preview` est prête à être revue puis landée (build vérifié, tests verts, vérif navigateur OK). Utiliser `superpowers:finishing-a-development-branch` pour décider merge/PR.
```

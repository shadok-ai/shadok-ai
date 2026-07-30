# Auto-retry serveur des erreurs API transitoires — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quand un tour meurt sur une erreur API transitoire (529 Overloaded, 5xx, timeout…), le serveur shadok-ai soumet automatiquement `continue` après 15 s / 30 s / 60 s (3 tentatives max), annulé si l'utilisateur reprend la main.

**Architecture:** Détection par pattern sur l'écran du TUI à la fin du tour (`finishTurn` dans `src/server.ts`), avec comparaison début/fin de tour pour ignorer une vieille erreur encore affichée. Fonctions pures de détection dans un nouveau module `src/retry.ts`. Timer et compteur portés par l'objet `Live` de la session. Le client web (`public/index.html`) affiche des lignes d'état informatives.

**Tech Stack:** TypeScript (ESM, `tsc`), Node, ws. Pas de framework de test : script de vérification `debug/test-retry.mjs` exécuté avec `node` (assertions `node:assert`), sur le modèle de `debug/probe.mjs`.

## Global Constraints

- Spec : `docs/superpowers/specs/2026-07-20-auto-retry-transient-api-errors-design.md`.
- Délais de retry : 15 000 ms, 30 000 ms, 60 000 ms — 3 tentatives max.
- Texte de relance : exactement `continue`.
- Erreurs transitoires : `API Error` + `5xx`/`529`/`429`/`overloaded`/`timeout`/erreur de connexion. Les `400`/`401`/`403`/`invalid_request` ne déclenchent JAMAIS de retry.
- Nouveaux événements WS serveur→client : `auto-retry`, `auto-retry-cancelled`, `auto-retry-gave-up` ; `prompt-echo` gagne un champ optionnel `auto: true`.
- Style : commentaires en anglais, comme le reste de `src/`.

---

### Task 1: Module de détection `src/retry.ts`

**Files:**
- Create: `src/retry.ts`
- Test: `debug/test-retry.mjs` (script d'assertions, exécuté après build)

**Interfaces:**
- Produces: `findTransientErrors(screen: string): string[]` — les lignes (trimées) de l'écran qui montrent une erreur API transitoire. `newTransientErrors(before: string[], after: string[]): string[]` — les lignes de `after` en excès par rapport à `before` (diff multiset). `RETRY_DELAYS_MS: readonly number[]` = `[15_000, 30_000, 60_000]`.

- [ ] **Step 1: Écrire le script de test (qui échoue)**

```js
// debug/test-retry.mjs — run: node debug/test-retry.mjs (after npm run build)
import assert from "node:assert/strict";
import { findTransientErrors, newTransientErrors, RETRY_DELAYS_MS } from "../dist/retry.js";

// 529 Overloaded (the exact message the user sees) matches.
const s529 = `  ⎿ API Error: 529 Overloaded. This is a server-side issue, usually
     temporary — try again in a moment.
❯ `;
assert.equal(findTransientErrors(s529).length, 1);

// Other transient errors match: 500, 503, 429, timeout, connection.
for (const line of [
  "API Error: 500 Internal Server Error",
  "API Error: 503 Service Unavailable",
  "API Error: 429 Too Many Requests",
  "API Error (Request timed out)",
  "API Error: Connection error",
  "API Error: fetch failed",
]) {
  assert.equal(findTransientErrors(line).length, 1, line);
}

// Non-transient errors do NOT match.
for (const line of [
  "API Error: 400 invalid_request_error",
  "API Error: 401 Unauthorized",
  "API Error: 403 Forbidden",
  "some ordinary output mentioning an error",
]) {
  assert.equal(findTransientErrors(line).length, 0, line);
}

// Multiset diff: an OLD error still on screen does not re-trigger…
const old = ["API Error: 529 Overloaded"];
assert.deepEqual(newTransientErrors(old, old), []);
// …but a SECOND occurrence of the same line is new.
assert.deepEqual(
  newTransientErrors(old, [...old, "API Error: 529 Overloaded"]),
  ["API Error: 529 Overloaded"],
);
// A fresh error on a previously clean screen is new.
assert.deepEqual(newTransientErrors([], old), old);

assert.deepEqual([...RETRY_DELAYS_MS], [15_000, 30_000, 60_000]);
console.log("test-retry: all assertions passed");
```

- [ ] **Step 2: Vérifier qu'il échoue**

Run: `node debug/test-retry.mjs`
Expected: FAIL — `Cannot find module '../dist/retry.js'`

- [ ] **Step 3: Implémenter `src/retry.ts`**

```ts
/**
 * Detection of transient API errors on the TUI screen, used by the server
 * to auto-retry a turn that died on one (529 Overloaded, 5xx, timeout…).
 * Pure functions, kept separate from server.ts so they can be tested.
 */

/** Auto-retry backoff: first, second and third attempt. */
export const RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000];

/**
 * A line worth retrying: "API Error" followed (same line) by a transient
 * cause — 5xx/429 status, overload, timeout or connection failure. Client
 * errors (400/401/403, invalid_request…) intentionally do not match.
 */
const TRANSIENT_ERROR =
  /API Error\b[^\n]*?(?:\b(?:5\d\d|429)\b|overloaded|timed? ?out|connection|ECONNRESET|ETIMEDOUT|fetch failed)/i;

/** The screen lines (trimmed) showing a transient API error. */
export function findTransientErrors(screen: string): string[] {
  return screen
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => TRANSIENT_ERROR.test(l));
}

/**
 * Multiset difference: the lines of `after` in excess of `before`. Used to
 * ignore an old error still visible on screen from a previous turn — only
 * a NEW occurrence triggers a retry.
 */
export function newTransientErrors(before: string[], after: string[]): string[] {
  const counts = new Map<string, number>();
  for (const l of before) counts.set(l, (counts.get(l) ?? 0) + 1);
  const fresh: string[] = [];
  for (const l of after) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else fresh.push(l);
  }
  return fresh;
}
```

- [ ] **Step 4: Builder et vérifier que le test passe**

Run: `npm run build && node debug/test-retry.mjs`
Expected: `test-retry: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add src/retry.ts debug/test-retry.mjs
git commit -m "Add transient API error detection (retry.ts)"
```

---

### Task 2: Câblage serveur (`src/server.ts`)

**Files:**
- Modify: `src/server.ts` (imports ; interface `Live` ~l.90 ; `destroySession` ~l.138 ; `createSession` ~l.171 ; `finishTurn` ~l.225 ; handlers ws ~l.253)

**Interfaces:**
- Consumes: `findTransientErrors`, `newTransientErrors`, `RETRY_DELAYS_MS` de `./retry.js` (Task 1).
- Produces (événements WS vers le client, consommés en Task 3) :
  `{ type: "auto-retry", delayMs: number, attempt: number, max: number }`,
  `{ type: "auto-retry-cancelled" }`,
  `{ type: "auto-retry-gave-up", attempts: number }`,
  `{ type: "prompt-echo", text: "continue", auto: true }`.

- [ ] **Step 1: Import + champs de `Live` + init + nettoyage**

Ajouter l'import :

```ts
import { findTransientErrors, newTransientErrors, RETRY_DELAYS_MS } from "./retry.js";
```

Dans l'interface `Live`, après `usage`:

```ts
  /** Pending auto-retry of a turn that died on a transient API error. */
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Auto-retry attempts consumed for the current error streak (0–3). */
  retryCount: number;
  /** Transient error lines already on screen when the turn started. */
  errorsAtTurnStart: string[];
```

Dans `createSession`, initialiser dans le littéral `s`:

```ts
    retryTimer: null,
    retryCount: 0,
    errorsAtTurnStart: [],
```

Dans `destroySession`, après le nettoyage de `idleTimer`:

```ts
  if (s.retryTimer) clearTimeout(s.retryTimer);
  s.retryTimer = null;
```

- [ ] **Step 2: `clearRetry` + `maybeScheduleRetry` + hook dans `finishTurn`**

Ajouter après `finishTurn`:

```ts
/** Cancels a pending auto-retry (user took over, or session ends). */
function clearRetry(s: Live, notify = false) {
  if (!s.retryTimer) return;
  clearTimeout(s.retryTimer);
  s.retryTimer = null;
  if (notify) broadcast(s, { type: "auto-retry-cancelled" });
}

/**
 * If the turn died on a NEW transient API error (529 Overloaded, 5xx,
 * timeout…), schedules an automatic `continue` — 15 s, then 30 s, then
 * 60 s. Cancelled if the user takes over; gives up after 3 attempts.
 */
function maybeScheduleRetry(s: Live) {
  const fresh = newTransientErrors(
    s.errorsAtTurnStart,
    findTransientErrors(s.pilot.screen()),
  );
  if (fresh.length === 0) {
    s.retryCount = 0; // clean turn: the error streak is over
    return;
  }
  if (s.retryCount >= RETRY_DELAYS_MS.length) {
    broadcast(s, { type: "auto-retry-gave-up", attempts: s.retryCount });
    s.retryCount = 0;
    return;
  }
  const delayMs = RETRY_DELAYS_MS[s.retryCount];
  s.retryCount++;
  broadcast(s, {
    type: "auto-retry",
    delayMs,
    attempt: s.retryCount,
    max: RETRY_DELAYS_MS.length,
  });
  s.retryTimer = setTimeout(async () => {
    s.retryTimer = null;
    if (s.pilot.hasExited || s.busy) return;
    broadcast(s, { type: "prompt-echo", text: "continue", auto: true });
    s.busy = true;
    broadcast(s, { type: "working" });
    try {
      await s.pilot.submit("continue");
    } catch {
      return; // TUI unreachable: give the user back the controls
    } finally {
      s.busy = false;
    }
    await finishTurn(s).catch(() => {});
  }, delayMs);
}
```

Dans `finishTurn`, capturer l'état au début et déclencher à la fin :

```ts
async function finishTurn(s: Live) {
  s.busy = true;
  s.errorsAtTurnStart = findTransientErrors(s.pilot.screen());
  broadcast(s, { type: "working" });
  try {
    await s.pilot.waitForIdle({ stableMs: 2000, timeoutMs: 900_000 });
    const dialog = detectDialog(s.pilot.screen());
    if (dialog) broadcast(s, { type: "dialog", ...dialog });
    else {
      broadcast(s, { type: "turn-done", sessionId: s.id });
      maybeScheduleRetry(s);
    }
  } finally {
    s.busy = false;
  }
}
```

- [ ] **Step 3: Annulation quand l'utilisateur reprend la main**

Dans le handler `ws.on("message", …)`, juste avant le `switch (msg.type)` (dans le `try`) :

```ts
      // Any user takeover cancels a pending auto-retry and ends the streak.
      if (
        session &&
        ["prompt", "choose", "toggle", "freetext", "confirm", "key"].includes(msg.type)
      ) {
        clearRetry(session, true);
        session.retryCount = 0;
      }
```

(`settle` n'annule pas — c'est un simple « attendre la fin du tour ». `stop` passe par `destroySession`, qui nettoie le timer.)

- [ ] **Step 4: Builder**

Run: `npm run build`
Expected: exit 0, aucune erreur TypeScript.

- [ ] **Step 5: Vérification manuelle de la détection**

Run:

```bash
node -e '
import("./dist/retry.js").then(({ findTransientErrors, newTransientErrors }) => {
  const before = [];
  const screen = "  ⎿ API Error: 529 Overloaded. This is a server-side issue\n❯ ";
  const fresh = newTransientErrors(before, findTransientErrors(screen));
  console.log(fresh.length === 1 ? "detection OK" : "detection BROKEN");
});'
```

Expected: `detection OK`

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "Auto-retry turns that die on a transient API error"
```

---

### Task 3: Ligne d'état côté client (`public/index.html`)

**Files:**
- Modify: `public/index.html` (fonction `handleMessage`, ~l.1509 : cas `prompt-echo` ~l.1553 et nouveaux cas après `stopped` ~l.1622)

**Interfaces:**
- Consumes: les événements `auto-retry`, `auto-retry-cancelled`, `auto-retry-gave-up` et `prompt-echo.auto` produits en Task 2. Fonctions existantes du client : `addTurn(t, role, who, text)`, `setTabState(t, status, label)`, `setTabMood(t, mood)`, `stopTurnTimer(t)`.

- [ ] **Step 1: Étiqueter le prompt-echo automatique**

Dans `handleMessage`, remplacer le cas `prompt-echo`:

```js
      case "prompt-echo":
        // Prompt sent by another tab/interface — or by the server itself
        // when it auto-retries a turn that died on a transient API error.
        addTurn(t, "user", msg.auto ? "auto-retry" : "pilot (elsewhere)", msg.text);
        break;
```

- [ ] **Step 2: Afficher les événements auto-retry**

Dans `handleMessage`, ajouter après le cas `stopped`:

```js
      case "auto-retry":
        // The server will resend "continue" by itself; nothing to do here.
        addTurn(t, "system", "",
          "Transient API error — auto-retry in " + Math.round(msg.delayMs / 1000) +
          " s (attempt " + msg.attempt + "/" + msg.max + ")");
        setTabState(t, "ready", "auto-retry in " + Math.round(msg.delayMs / 1000) + " s");
        break;
      case "auto-retry-cancelled":
        setTabState(t, "ready", "ready");
        break;
      case "auto-retry-gave-up":
        addTurn(t, "system", "",
          "Transient API error persists after " + msg.attempts +
          " auto-retries — send a prompt to retry manually.");
        setTabMood(t, "needs-answer");
        break;
```

- [ ] **Step 3: Vérification manuelle du rendu**

Run: `npm run build && node dist/server.js` puis ouvrir `http://localhost:3789`, démarrer une session, et dans la console du navigateur simuler la réception :

```js
// In the browser devtools console, with a channel open:
// (handleMessage is in scope of the page's script)
// Simulate: error detected, retry scheduled, then gave up.
```

Comme `handleMessage` n'est pas exposé globalement, la vérification passe par le flux réel : couper le réseau pendant un tour (ou attendre une vraie 529) N'EST PAS exigé ici — se contenter de vérifier qu'aucune erreur JS n'apparaît au chargement et que l'app fonctionne comme avant (envoyer un prompt, recevoir la réponse).
Expected: aucune régression visible, pas d'erreur console.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "Show auto-retry status lines in the web client"
```

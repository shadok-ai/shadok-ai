# Jauges de quota comparées au temps restant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Comparer la consommation des fenêtres 5h et 7d au temps déjà écoulé, et bloquer les envois lorsque la consommation dépasse 100% de ce rythme idéal, avec forçage explicite par message.

**Architecture:** Un module pur `src/pace.ts` calcule le rythme et le verdict de blocage à partir des données brutes déjà fournies par `src/usage.ts`. `src/server.ts` l'applique en deux points — le `case "prompt"` et le minuteur d'auto-continue — et enrichit `GET /usage`. `public/index.html` affiche deux barres empilées par jauge et rend une bulle de confirmation réutilisant le style `.turn.dialog` existant.

**Tech Stack:** TypeScript (ESM, `module: NodeNext`), Node 20, Express 5, `ws`, tests via `node --import tsx --test`.

Spec de référence : `docs/superpowers/specs/2026-07-20-pace-gauges-design.md`

## Global Constraints

- Seuil de blocage **100%**, en dur, non configurable. Aucune variable d'environnement.
- `PACE_EPSILON = 5`, ajouté au rythme idéal au dénominateur.
- Durées de fenêtre : `fiveHour = 5 * 3600` s, `sevenDay = 7 * 86400` s.
- Absence de données (`usage` null, `resetsAt` null) ⇒ **jamais** de blocage.
- Le forçage vaut pour **un message et un seul** — aucun état de dérogation mémorisé, ni serveur ni client.
- L'auto-continue n'est **jamais** forcé : il attend et reprend seul.
- `src/usage.ts` n'est **pas** modifié.
- Node 20 n'exécute pas TypeScript nativement : toute commande de test passe par `node --import tsx --test`.
- Les imports internes portent l'extension `.js` (NodeNext), y compris depuis `test/`.
- Les fichiers sous `test/` sont hors de `tsconfig.json` (`include: ["src"]`) et ne sont donc pas compilés dans `dist` — c'est voulu.

## File Structure

| Fichier | Rôle |
|---------|------|
| `src/pace.ts` | **Créé.** Calcul pur du rythme idéal et du verdict de blocage. Aucune I/O, aucun état. |
| `test/pace.test.ts` | **Créé.** Tests unitaires du module pur. |
| `src/server.ts` | **Modifié.** Enrichit `/usage` ; applique le blocage sur `case "prompt"` ; met l'auto-continue en pause. |
| `public/index.html` | **Modifié.** Jauges à deux barres ; bulle de forçage ; état de pause. |
| `package.json` | **Modifié.** Le script `test` couvre `test/` en plus des tests de la skill. |

---

### Task 1: Module de calcul du rythme

**Files:**
- Create: `src/pace.ts`
- Create: `test/pace.test.ts`
- Modify: `package.json` (script `test`)

**Interfaces:**
- Consumes: `Usage` et `Window` de `src/usage.ts` (types uniquement, import effacé à l'exécution).
- Produces:
  - `WINDOW_SEC: { readonly fiveHour: number; readonly sevenDay: number }`
  - `computePace(w: Window | null, durationSec: number, nowMs: number): Pace`
  - `paceBlock(u: Usage | null, nowMs: number): PaceVerdict`
  - `interface Pace { idealPacePct: number | null; ratioPct: number | null }`
  - `interface PaceVerdict { blocked: boolean; reason: string | null }`

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `test/pace.test.ts` :

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { computePace, paceBlock, WINDOW_SEC } from "../src/pace.js";
import type { Usage, Window } from "../src/usage.js";

/** Horloge figée : les tests ne doivent jamais dépendre de l'heure réelle. */
const NOW = 1_700_000_000_000;

/** Fenêtre dont le reset tombe dans `remainingSec` secondes. */
const win = (usedPercentage: number, remainingSec: number): Window => ({
  usedPercentage,
  resetsAt: NOW / 1000 + remainingSec,
});

const usage = (fiveHour: Window | null, sevenDay: Window | null): Usage => ({
  fiveHour,
  sevenDay,
  fetchedAt: NOW,
});

const round = (n: number | null) => (n === null ? null : Math.round(n));

test("5h : 90% consommé avec 10 min restantes suit le rythme", () => {
  const p = computePace(win(90, 600), WINDOW_SEC.fiveHour, NOW);
  assert.equal(round(p.idealPacePct), 97);
  assert.equal(round(p.ratioPct), 89);
});

test("5h : 3% consommé 5 min après le reset ne déclenche pas l'epsilon", () => {
  const p = computePace(win(3, 17_700), WINDOW_SEC.fiveHour, NOW);
  assert.equal(round(p.idealPacePct), 2);
  assert.equal(round(p.ratioPct), 45);
});

test("5h : 15% consommé 5 min après le reset dépasse le seuil", () => {
  const p = computePace(win(15, 17_700), WINDOW_SEC.fiveHour, NOW);
  assert.equal(round(p.ratioPct), 225);
});

test("7d : 55% consommé avec 6 jours restants dépasse largement", () => {
  const p = computePace(win(55, 6 * 86_400), WINDOW_SEC.sevenDay, NOW);
  assert.equal(round(p.idealPacePct), 14);
  assert.equal(round(p.ratioPct), 285);
});

test("7d : 80% consommé avec 1 jour restant suit le rythme", () => {
  const p = computePace(win(80, 86_400), WINDOW_SEC.sevenDay, NOW);
  assert.equal(round(p.idealPacePct), 86);
  assert.equal(round(p.ratioPct), 88);
});

test("resetsAt absent : pas de rythme calculable", () => {
  const p = computePace({ usedPercentage: 99, resetsAt: null }, WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, null);
  assert.equal(p.ratioPct, null);
});

test("fenêtre expirée : le rythme idéal est borné à 100%", () => {
  const p = computePace(win(50, -3_600), WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, 100);
  assert.equal(round(p.ratioPct), 48);
});

test("paceBlock : une seule fenêtre au-dessus du seuil suffit", () => {
  const v = paceBlock(usage(win(90, 600), win(55, 6 * 86_400)), NOW);
  assert.equal(v.blocked, true);
  assert.match(v.reason ?? "", /^7d /);
});

test("paceBlock : les deux dans les clous ne bloque pas", () => {
  const v = paceBlock(usage(win(90, 600), win(80, 86_400)), NOW);
  assert.equal(v.blocked, false);
  assert.equal(v.reason, null);
});

test("paceBlock : la raison cite la fenêtre au ratio le plus élevé", () => {
  const v = paceBlock(usage(win(15, 17_700), win(55, 6 * 86_400)), NOW);
  assert.equal(v.blocked, true);
  assert.match(v.reason ?? "", /^7d /); // 285% l'emporte sur 225%
});

test("paceBlock : la raison porte les trois chiffres", () => {
  const v = paceBlock(usage(null, win(55, 6 * 86_400)), NOW);
  assert.equal(v.reason, "7d : 55% consommé pour un rythme idéal de 14% (285% du rythme)");
});

test("paceBlock : usage absent ne bloque jamais", () => {
  assert.deepEqual(paceBlock(null, NOW), { blocked: false, reason: null });
});

test("paceBlock : resetsAt absent ne bloque jamais", () => {
  const v = paceBlock(usage(null, { usedPercentage: 99, resetsAt: null }), NOW);
  assert.equal(v.blocked, false);
});
```

- [ ] **Step 2: Étendre le script de test**

Dans `package.json`, remplacer la ligne `"test"` :

```json
    "test": "node --import tsx --test test/ .claude/skills/shadok-ai-agents/test/",
```

- [ ] **Step 3: Lancer les tests pour vérifier qu'ils échouent**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '.../src/pace.js'`. Les 22 tests existants de la skill continuent de passer.

- [ ] **Step 4: Écrire le module**

Créer `src/pace.ts` :

```ts
import type { Usage, Window } from "./usage.js";

/** Durée totale de chaque fenêtre glissante, en secondes. */
export const WINDOW_SEC = { fiveHour: 5 * 3600, sevenDay: 7 * 86400 } as const;

/**
 * Ajouté au rythme idéal au dénominateur. Sans lui, le rythme est quasi nul
 * juste après un reset et le moindre message ferait exploser le ratio.
 */
const PACE_EPSILON = 5;

/** Au-delà de ce ratio (en % du rythme idéal), on bloque. En dur, par choix. */
const BLOCK_RATIO = 100;

const LABEL = { fiveHour: "5h", sevenDay: "7d" } as const;

export interface Pace {
  /** 0–100 : fraction de la fenêtre déjà écoulée. null si non calculable. */
  idealPacePct: number | null;
  /** Consommation rapportée au rythme idéal, en %. 100 = pile dans les temps. */
  ratioPct: number | null;
}

export interface PaceVerdict {
  blocked: boolean;
  reason: string | null;
}

/**
 * Rapporte la consommation d'une fenêtre au temps qui y est déjà passé.
 * Renvoie des null si la fenêtre est absente ou son reset inconnu — pas de
 * données ne vaut pas dépassement.
 */
export function computePace(w: Window | null, durationSec: number, nowMs: number): Pace {
  if (!w || w.resetsAt === null) return { idealPacePct: null, ratioPct: null };
  const remainingSec = w.resetsAt - nowMs / 1000;
  // Borné : une horloge en avance sur resetsAt ne doit pas produire de rythme
  // négatif, ni une fenêtre expirée un rythme supérieur à 100%.
  const idealPacePct = Math.min(100, Math.max(0, ((durationSec - remainingSec) / durationSec) * 100));
  return { idealPacePct, ratioPct: (w.usedPercentage / (idealPacePct + PACE_EPSILON)) * 100 };
}

/**
 * Bloque dès qu'UNE des deux fenêtres consomme plus vite que le temps ne passe.
 * La raison cite la fenêtre au ratio le plus élevé. Sans données, ne bloque pas :
 * l'indisponibilité de l'API ne doit pas verrouiller l'outil.
 */
export function paceBlock(u: Usage | null, nowMs: number): PaceVerdict {
  if (!u) return { blocked: false, reason: null };
  let worst: { label: string; used: number; pace: number; ratio: number } | null = null;
  for (const key of ["fiveHour", "sevenDay"] as const) {
    const w = u[key];
    const { idealPacePct, ratioPct } = computePace(w, WINDOW_SEC[key], nowMs);
    if (!w || idealPacePct === null || ratioPct === null) continue;
    if (ratioPct <= BLOCK_RATIO) continue;
    if (!worst || ratioPct > worst.ratio) {
      worst = { label: LABEL[key], used: w.usedPercentage, pace: idealPacePct, ratio: ratioPct };
    }
  }
  if (!worst) return { blocked: false, reason: null };
  const r = Math.round;
  return {
    blocked: true,
    reason: `${worst.label} : ${r(worst.used)}% consommé pour un rythme idéal de ${r(worst.pace)}% (${r(worst.ratio)}% du rythme)`,
  };
}
```

- [ ] **Step 5: Lancer les tests pour vérifier qu'ils passent**

Run: `npm test 2>&1 | tail -12`
Expected: PASS — 35 tests (22 existants + 13 nouveaux), 0 fail.

- [ ] **Step 6: Vérifier la compilation**

Run: `npm run build`
Expected: aucune sortie, aucune erreur TypeScript.

- [ ] **Step 7: Commit**

```bash
git add src/pace.ts test/pace.test.ts package.json
git commit -m "feat(pace): calcule le rythme idéal des fenêtres 5h et 7d"
```

---

### Task 2: Enrichir GET /usage

**Files:**
- Modify: `src/server.ts:18` (imports), `src/server.ts:59-62` (route `/usage`)

**Interfaces:**
- Consumes: `computePace`, `paceBlock`, `WINDOW_SEC` de `src/pace.ts` (Task 1).
- Produces: la réponse JSON de `GET /usage`, consommée par `refreshUsage()` en Task 5 :
  ```
  {
    fiveHour: { usedPercentage, resetsAt, idealPacePct, ratioPct } | null,
    sevenDay: { usedPercentage, resetsAt, idealPacePct, ratioPct } | null,
    fetchedAt: number,
    blocked: boolean,
    reason: string | null
  }
  ```

- [ ] **Step 1: Ajouter les imports**

Dans `src/server.ts`, remplacer la ligne 18 (`import { getUsage } from "./usage.js";`) par :

```ts
import { computePace, paceBlock, WINDOW_SEC } from "./pace.js";
import { getUsage, type Window } from "./usage.js";
```

Le type `Window` est nécessaire au helper `enrich` de l'étape suivante.

- [ ] **Step 2: Remplacer la route**

Remplacer les lignes 59-62 :

```ts
// Current 5-hour and 7-day subscription usage (for the quota gauges).
app.get("/usage", async (_req, res) => {
  res.json((await getUsage()) ?? { fiveHour: null, sevenDay: null, fetchedAt: Date.now() });
});
```

par :

```ts
// Current 5-hour and 7-day subscription usage, each window enriched with how it
// compares to the time already elapsed (for the quota gauges and the send guard).
app.get("/usage", async (_req, res) => {
  const u = await getUsage();
  const now = Date.now();
  // The pace is derived per request, not per fetch: getUsage() caches for 60 s
  // and a frozen pace would drift away from the clock.
  const enrich = (w: Window | null, durationSec: number) =>
    w ? { ...w, ...computePace(w, durationSec, now) } : null;
  res.json({
    fiveHour: enrich(u?.fiveHour ?? null, WINDOW_SEC.fiveHour),
    sevenDay: enrich(u?.sevenDay ?? null, WINDOW_SEC.sevenDay),
    fetchedAt: u?.fetchedAt ?? now,
    ...paceBlock(u, now),
  });
});
```

- [ ] **Step 3: Vérifier la compilation**

Run: `npm run build`
Expected: aucune erreur.

- [ ] **Step 4: Vérifier la route à la main**

```bash
node dist/server.js &
sleep 2
curl -s localhost:3789/usage | head -c 400; echo
kill %1
```

Expected: un JSON contenant `blocked` et `reason`. Si un token OAuth est disponible, `fiveHour` porte `idealPacePct` et `ratioPct` numériques ; sinon `{"fiveHour":null,"sevenDay":null,...,"blocked":false,"reason":null}` — les deux sont des succès.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(pace): expose le rythme et le verdict sur GET /usage"
```

---

### Task 3: Bloquer les prompts au-dessus du rythme

**Files:**
- Modify: `src/server.ts:94` (type `ClientMessage`), `src/server.ts:509-527` (`case "prompt"`)

**Interfaces:**
- Consumes: `paceBlock` et `getUsage` (déjà importés en Task 2).
- Produces:
  - Message client accepté : `{ type: "prompt", text: string, force?: boolean }`
  - Message serveur émis : `{ type: "pace-blocked", reason: string | null, text: string }` — envoyé au seul client émetteur, jamais diffusé. Consommé en Task 6.

- [ ] **Step 1: Autoriser `force` dans le type de message**

Remplacer la ligne 94 :

```ts
  | { type: "prompt"; text: string }
```

par :

```ts
  /** `force`: envoyer malgré un dépassement du rythme. Vaut pour ce message seul. */
  | { type: "prompt"; text: string; force?: boolean }
```

- [ ] **Step 2: Ajouter le contrôle dans `case "prompt"`**

Dans `case "prompt"` (server.ts:509), insérer juste après `if (!text) return;` (ligne 513) et avant `session.lastPrompt = text;` (ligne 514) :

```ts
          // Above the ideal pace, a prompt needs an explicit second click. The
          // check lives here because this is the single door every user prompt
          // goes through — including the pilotctl thin client.
          if (!msg.force) {
            const verdict = paceBlock(await getUsage(), Date.now());
            if (verdict.blocked) return send({ type: "pace-blocked", reason: verdict.reason, text });
          }
```

- [ ] **Step 3: Vérifier la compilation**

Run: `npm run build`
Expected: aucune erreur.

- [ ] **Step 4: Vérifier le blocage à la main**

`paceBlock` ne bloque que si le quota réel dépasse — impossible à provoquer à la demande. Forcer temporairement le verdict pour la vérification :

```bash
# Dans src/pace.ts, faire renvoyer un blocage inconditionnel :
#   export function paceBlock(...) { return { blocked: true, reason: "test" }; }
npm run build && node dist/server.js &
sleep 2
```

Ouvrir http://localhost:3789, démarrer un canal, envoyer un prompt. Expected: aucun tour ne part ; l'onglet Network montre la trame WebSocket `pace-blocked`. (L'UI ne réagit pas encore — c'est la Task 6.)

**Rétablir `src/pace.ts` avant de committer** : `git diff src/pace.ts` doit être vide.

- [ ] **Step 5: Vérifier que les tests passent toujours**

Run: `npm test 2>&1 | tail -8`
Expected: 35 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat(pace): refuse les prompts au-dessus du rythme sauf forçage explicite"
```

---

### Task 4: Mettre l'auto-continue en pause plutôt que le laisser consommer

**Files:**
- Modify: `src/server.ts:331-369` (`maybeScheduleRetry`)

**Interfaces:**
- Consumes: `paceBlock`, `getUsage`.
- Produces: deux messages diffusés à tous les clients de la session, consommés en Task 6 :
  - `{ type: "pace-hold", reason: string | null }` — émis **une seule fois** par pause, pas à chaque re-test.
  - `{ type: "pace-resumed" }` — émis seulement si une pause avait eu lieu.

- [ ] **Step 1: Faire survivre la pause à un prompt refusé**

La pause vit dans `s.retryTimer`. Or le bloc « user takeover » tourne avant le `switch` et annule l'auto-retry pour tout message de type `prompt` — y compris un prompt que le contrôle de rythme va refuser juste après. La pause mourrait donc silencieusement à la première tentative d'envoi, alors qu'elle doit reprendre seule dès le retour sous le seuil.

Un prompt refusé n'envoie rien : ce n'est pas une reprise en main. Un prompt réellement soumis — forcé ou non bloqué — en est une.

Remplacer le bloc de `src/server.ts:409-417` :

```ts
    try {
      // Any user takeover cancels a pending auto-retry and ends the streak.
      if (
        session &&
        ["prompt", "choose", "toggle", "freetext", "confirm", "key"].includes(msg.type)
      ) {
        clearRetry(session, true);
        session.retryCount = 0;
      }
```

par :

```ts
    try {
      // Any user takeover cancels a pending auto-retry and ends the streak.
      // "prompt" is settled inside its own case instead: a prompt refused on
      // pace grounds sends nothing, so it must not count as a takeover — it
      // would silently kill the pace pause it was just told about.
      if (
        session &&
        ["choose", "toggle", "freetext", "confirm", "key"].includes(msg.type)
      ) {
        clearRetry(session, true);
        session.retryCount = 0;
      }
```

Puis, dans `case "prompt"`, juste après le contrôle de rythme ajouté en Task 3 (le bloc `if (!msg.force) { … }`) et avant `session.lastPrompt = text;`, insérer :

```ts
          // Getting here means the prompt is really being sent — that is the
          // takeover. A pending auto-retry (or pace pause) gives way to it.
          clearRetry(session, true);
          session.retryCount = 0;
```

- [ ] **Step 2: Ajouter la constante de re-test**

Juste au-dessus de `function maybeScheduleRetry` (server.ts:331), ajouter :

```ts
/**
 * Pas de re-test du rythme pendant une pause. Aligné sur le TTL du cache de
 * usage.ts : la boucle d'attente n'émet aucune requête vers l'API.
 */
const PACE_RECHECK_MS = 60_000;
```

- [ ] **Step 4: Remplacer le corps du minuteur**

Remplacer les lignes 354-369 :

```ts
  s.retryTimer = setTimeout(async () => {
    s.retryTimer = null;
    if (s.pilot.hasExited || s.busy) return;
    broadcast(s, { type: "prompt-echo", text: "continue", auto: true });
    s.busy = true;
    s.turnStartedAt = Date.now();
    broadcast(s, { type: "working", startedAt: s.turnStartedAt });
    try {
      await s.pilot.submit("continue");
    } catch {
      return; // TUI unreachable: give the user back the controls
    } finally {
      s.busy = false;
    }
    await finishTurn(s).catch(() => {});
  }, delayMs);
```

par :

```ts
  // Set when the retry has been parked on a pace overrun, so the resume is
  // announced only to clients that were told about the pause.
  let held = false;
  const fire = async () => {
    s.retryTimer = null;
    if (s.pilot.hasExited || s.busy) return;
    // Never forced: an automatic turn must not spend quota the user is being
    // asked to hold back on. Park and re-test until the pace comes back down.
    const verdict = paceBlock(await getUsage(), Date.now());
    if (verdict.blocked) {
      if (!held) {
        held = true;
        broadcast(s, { type: "pace-hold", reason: verdict.reason });
      }
      s.retryTimer = setTimeout(fire, PACE_RECHECK_MS);
      return;
    }
    if (held) broadcast(s, { type: "pace-resumed" });
    broadcast(s, { type: "prompt-echo", text: "continue", auto: true });
    s.busy = true;
    s.turnStartedAt = Date.now();
    broadcast(s, { type: "working", startedAt: s.turnStartedAt });
    try {
      await s.pilot.submit("continue");
    } catch {
      return; // TUI unreachable: give the user back the controls
    } finally {
      s.busy = false;
    }
    await finishTurn(s).catch(() => {});
  };
  s.retryTimer = setTimeout(fire, delayMs);
```

La pause réutilise `s.retryTimer`, donc `clearRetry()` (server.ts:319) et le nettoyage de session (server.ts:188) l'annulent sans code supplémentaire — y compris quand l'utilisateur reprend la main (server.ts:396-402).

- [ ] **Step 5: Vérifier la compilation**

Run: `npm run build`
Expected: aucune erreur.

- [ ] **Step 6: Vérifier la pause à la main**

Même méthode qu'en Task 3 — forcer `paceBlock` à renvoyer `{ blocked: true, reason: "test" }`, puis abaisser temporairement `RETRY_DELAYS_MS` dans `src/retry.ts` à `[1000]` et `PACE_RECHECK_MS` à `2000` pour ne pas attendre.

Provoquer une erreur transitoire est peu commode ; à défaut, vérifier par lecture que le chemin `blocked` ne comporte aucun `s.pilot.submit`.

Expected: `pace-hold` diffusé une fois, ré-émission du minuteur toutes les 2 s, aucun `continue` envoyé.

**Rétablir `src/pace.ts`, `src/retry.ts` et `PACE_RECHECK_MS` avant de committer** : `git diff src/pace.ts src/retry.ts` doit être vide.

- [ ] **Step 7: Vérifier que les tests passent toujours**

Run: `npm test 2>&1 | tail -8`
Expected: 35 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts
git commit -m "feat(pace): met l'auto-continue en pause tant que le rythme est dépassé"
```

---

### Task 5: Jauges à deux barres

**Files:**
- Modify: `public/index.html:84-108` (CSS `.quota`), `public/index.html:748-757` (markup), `public/index.html:2078-2098` (`paintGauge` / `refreshUsage`)

**Interfaces:**
- Consumes: la réponse de `GET /usage` définie en Task 2.
- Produces: deux variables de portée module, lues en Task 6 :
  - `let paceBlocked = false`
  - `let paceReason = null`

- [ ] **Step 1: Adapter le CSS**

Remplacer les lignes 84-102 :

```css
  /* Quota gauges (5h / 7d subscription usage) */
  .quota { min-width: 92px; }
  .quota .meter {
    height: 6px;
    background: var(--bg-inset);
    border: 1px solid var(--line);
    border-radius: 3px;
    overflow: hidden;
    margin: 1px 0;
  }
  .quota .fill {
    display: block;
    height: 100%;
    width: 0%;
    background: var(--ok);
    transition: width 0.4s ease;
  }
  .quota.warn .fill { background: var(--amber); }
  .quota.crit .fill { background: var(--err); }
```

par :

```css
  /* Quota gauges (5h / 7d subscription usage).
     Two stacked bars: what has been spent, and how much of the window has
     elapsed. Top bar longer than the bottom one = spending faster than time. */
  .quota { min-width: 92px; }
  .quota .meter {
    height: 3px;
    background: var(--bg-inset);
    border: 1px solid var(--line);
    border-radius: 2px;
    overflow: hidden;
    margin: 1px 0;
  }
  .quota .fill {
    display: block;
    height: 100%;
    width: 0%;
    background: var(--ok);
    transition: width 0.4s ease;
  }
  /* The pace bar is a reference, not a status: it never takes the alert colour. */
  .quota .meter.pace .fill { background: var(--text-dim); }
  /* Colour follows the RATIO, not the raw usage. */
  .quota.warn .meter.usage .fill { background: var(--amber); }
  .quota.crit .meter.usage .fill { background: var(--err); }
```

- [ ] **Step 2: Adapter le markup**

Remplacer les lignes 748-757 :

```html
  <div class="gauge quota" id="quota5h" title="5-hour rolling limit">
    <span class="label">5h</span>
    <div class="meter"><span class="fill"></span></div>
    <span class="qpct">—</span>
  </div>
  <div class="gauge quota" id="quota7d" title="7-day rolling limit">
    <span class="label">7d</span>
    <div class="meter"><span class="fill"></span></div>
    <span class="qpct">—</span>
  </div>
```

par :

```html
  <div class="gauge quota" id="quota5h" title="5-hour rolling limit">
    <span class="label">5h</span>
    <div class="meter usage"><span class="fill"></span></div>
    <div class="meter pace"><span class="fill"></span></div>
    <span class="qpct">—</span>
  </div>
  <div class="gauge quota" id="quota7d" title="7-day rolling limit">
    <span class="label">7d</span>
    <div class="meter usage"><span class="fill"></span></div>
    <div class="meter pace"><span class="fill"></span></div>
    <span class="qpct">—</span>
  </div>
```

- [ ] **Step 3: Réécrire `paintGauge` et `refreshUsage`**

Remplacer les lignes 2078-2098 (de `function paintGauge` jusqu'à `setInterval(refreshUsage, 60_000);` inclus) :

`paceBlocked` et `paceReason` sont déclarés ici mais lus par le composer, défini plus haut dans le fichier (ligne 1983). Sans effet : les deux ne sont lus qu'au moment d'un envoi ou d'un message serveur, bien après l'exécution du script.

```js
  /** Last verdict from /usage — read by the composer before sending. */
  let paceBlocked = false, paceReason = null;

  function paintGauge(el, w) {
    const uFill = el.querySelector(".meter.usage .fill");
    const pFill = el.querySelector(".meter.pace .fill");
    const pct = el.querySelector(".qpct");
    const base = el.id === "quota5h" ? "5-hour rolling limit" : "7-day rolling limit";
    if (!w) {
      uFill.style.width = "0%";
      pFill.style.width = "0%";
      pct.textContent = "—";
      el.title = base;
      el.classList.remove("warn", "crit");
      return;
    }
    const used = Math.round(w.usedPercentage);
    const pace = w.idealPacePct == null ? null : Math.round(w.idealPacePct);
    const ratio = w.ratioPct == null ? null : Math.round(w.ratioPct);
    uFill.style.width = Math.min(100, used) + "%";
    pFill.style.width = (pace === null ? 0 : Math.min(100, pace)) + "%";
    pct.textContent = used + "%";
    // Colour tracks the ratio: 90% of the 5h window with 10 min left is fine,
    // 55% of the 7d window with 6 days left is not.
    el.classList.toggle("warn", ratio !== null && ratio >= 70 && ratio < 100);
    el.classList.toggle("crit", ratio !== null && ratio >= 100);
    el.title = base + " — " + used + "% used"
      + (pace === null ? "" : ", ideal pace " + pace + "% (" + ratio + "% of pace)")
      + " · " + fmtReset(w.resetsAt);
  }

  async function refreshUsage() {
    try {
      const u = await (await fetch("/usage")).json();
      paintGauge($("quota5h"), u.fiveHour);
      paintGauge($("quota7d"), u.sevenDay);
      paceBlocked = !!u.blocked;
      paceReason = u.reason || null;
    } catch { /* leave last values */ }
  }
  refreshUsage();
  setInterval(refreshUsage, 60_000);
```

- [ ] **Step 4: Vérifier visuellement**

```bash
npm run build && node dist/server.js &
sleep 2
```

Ouvrir http://localhost:3789. Expected: chaque jauge affiche deux barres fines empilées ; la barre du bas (rythme) est grise. Survoler une jauge : le tooltip donne consommation, rythme idéal, ratio et reset. Sans token OAuth, les deux barres sont vides et le tooltip se réduit au libellé — c'est le comportement attendu.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(pace): jauges à deux barres — consommation contre temps écoulé"
```

---

### Task 6: Bulle de forçage et état de pause

**Files:**
- Modify: `public/index.html:1983-1996` (soumission du composer), `public/index.html:1907-1912` (switch des messages serveur)

**Interfaces:**
- Consumes: `paceBlocked` / `paceReason` (Task 5) ; les messages `pace-blocked` (Task 3), `pace-hold` et `pace-resumed` (Task 4).
- Produces: rien pour les tâches suivantes — c'est la dernière.

- [ ] **Step 1: Extraire l'envoi du prompt**

Remplacer les lignes 1983-1996 :

```js
  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = active;
    const text = promptInput.value.trim();
    if (!text || t.status !== "ready" || t.pendingChoices || !t.ws) return;
    closeActivity(t);
    addTurn(t, "user", "pilot", text);
    startTurnTimer(t);
    setTabMood(t, "working");
    t.ws.send(JSON.stringify({ type: "prompt", text }));
    promptInput.value = "";
    promptInput.style.height = "auto";
    dropDraft(t);
  });
```

par :

```js
  function submitPrompt(t, text, force) {
    closeActivity(t);
    addTurn(t, "user", "pilot", text);
    startTurnTimer(t);
    setTabMood(t, "working");
    t.ws.send(JSON.stringify({ type: "prompt", text, ...(force ? { force: true } : {}) }));
    promptInput.value = "";
    promptInput.style.height = "auto";
    dropDraft(t);
  }

  /**
   * Above the ideal pace, ask before spending. Rendered in the thread like a TUI
   * question rather than as a modal — the codebase has no floating dialog.
   * Each blocked send asks again: forcing covers one message, never a session.
   */
  function renderPaceConfirm(tab, text, reason) {
    const turn = document.createElement("div");
    turn.className = "turn claude dialog";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "shadok-ai — rythme dépassé";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const q = document.createElement("div");
    q.className = "question";
    q.textContent = (reason || "Consommation au-dessus du rythme idéal")
      + " — envoyer quand même ?";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice";
    btn.textContent = "Forcer l'envoi";
    btn.addEventListener("click", () => {
      if (tab.status !== "ready" || !tab.ws) return;
      btn.disabled = true;
      submitPrompt(tab, text, true);
    });
    bubble.append(q, btn);
    turn.append(label, bubble);
    tab.transcriptEl.appendChild(turn);
    if (tab === active) tab.transcriptEl.scrollTop = tab.transcriptEl.scrollHeight;
  }

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = active;
    const text = promptInput.value.trim();
    if (!text || t.status !== "ready" || t.pendingChoices || !t.ws) return;
    // Checked here so nothing is optimistically rendered before the server
    // refuses. The server re-checks anyway — it is the authority.
    if (paceBlocked) return renderPaceConfirm(t, text, paceReason);
    submitPrompt(t, text);
  });
```

Le texte reste dans le composer tant que l'envoi n'est pas forcé : rien n'est perdu si l'utilisateur préfère renoncer ou reformuler.

- [ ] **Step 2: Traiter les trois messages serveur**

Dans le `switch` des messages serveur, juste après le `case "auto-retry-gave-up"` (public/index.html:1907-1912) et avant l'accolade fermante, ajouter :

```js
      case "pace-blocked":
        // The client's own check was stale (or the prompt came from elsewhere):
        // roll back the optimistic turn state, then ask.
        if (t.status === "busy") {
          stopTurnTimer(t);
          setTabMood(t, null);
          setTabState(t, "ready", "ready");
        }
        paceBlocked = true;
        if (msg.reason) paceReason = msg.reason;
        renderPaceConfirm(t, msg.text, msg.reason);
        break;
      case "pace-hold":
        addTurn(t, "system", "",
          "Auto-continue en pause — " + (msg.reason || "rythme dépassé") +
          ". Reprise automatique dès le retour sous le seuil.");
        setTabState(t, "ready", "en attente du rythme");
        break;
      case "pace-resumed":
        addTurn(t, "system", "", "Rythme revenu sous le seuil — auto-continue repris.");
        setTabState(t, "ready", "ready");
        break;
```

- [ ] **Step 3: Vérifier le parcours de forçage**

Forcer `paceBlock` à bloquer comme en Task 3 :

```bash
# src/pace.ts : export function paceBlock(...) { return { blocked: true, reason: "7d : test" }; }
npm run build && node dist/server.js &
sleep 2
```

Ouvrir http://localhost:3789, démarrer un canal, envoyer un prompt.

Expected:
1. Aucun tour utilisateur ne part ; une bulle encadrée d'ambre apparaît avec la raison et le bouton « Forcer l'envoi ».
2. Le texte est toujours dans le composer.
3. Clic sur « Forcer l'envoi » : le tour part, le composer se vide, claude répond.
4. Envoyer un second prompt : la bulle réapparaît — le forçage n'a rien mémorisé.

**Rétablir `src/pace.ts` avant de committer** : `git diff src/pace.ts` doit être vide.

- [ ] **Step 4: Vérifier que rien n'a régressé**

Run: `npm test 2>&1 | tail -8`
Expected: 35 pass, 0 fail.

Run: `npm run build`
Expected: aucune erreur.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(pace): bulle de forçage par message et affichage de la pause auto-continue"
```

---

## Self-Review — couverture du spec

| Exigence du spec | Tâche |
|---|---|
| `computePace`, `paceBlock`, epsilon 5, seuil 100 en dur | 1 |
| Rythme borné 0–100 | 1 (test « fenêtre expirée ») |
| Raison citant la fenêtre au ratio le plus élevé | 1 |
| Pas de données ⇒ pas de blocage | 1 |
| `usage.ts` non modifié | 1–6 (aucune tâche ne le touche) |
| `/usage` enrichi + `blocked`/`reason` | 2 |
| Pace calculé par requête, pas par fetch | 2 |
| Gating de `case "prompt"` + `force` | 3 |
| Forçage limité à un message | 3 (aucun état serveur), 6 (aucun état client) |
| Auto-continue en pause + reprise, jamais forcé | 4 |
| `pace-hold` émis une seule fois par pause | 4 |
| Re-test à 60 s aligné sur le TTL du cache | 4 |
| Réutilisation de `s.retryTimer` pour le nettoyage | 4 |
| Deux barres empilées, couleur par ratio | 5 |
| Tooltip : usage, rythme, ratio, reset | 5 |
| Composer actif, bulle style `.turn.dialog` | 6 |
| Ligne d'état de pause | 6 |
| Sondage 60 s inchangé, pas de canal de push | 5 |
| Tests des fonctions pures | 1 |

## Écarts assumés

- **Le tour utilisateur optimiste reste affiché** quand c'est le serveur qui refuse (client au sondage périmé, ou prompt venu de `pilotctl`). L'état de l'onglet est bien remis à `ready`, mais la bulle du prompt reste dans le fil, suivie de la demande de confirmation. Le cas est rare — le client contrôle avant d'envoyer — et le nettoyer demanderait de tracer l'élément DOM du dernier tour.
- **Les vérifications manuelles des tâches 3, 4 et 6 exigent de trafiquer `paceBlock` temporairement**, un dépassement réel de quota n'étant pas provocable à la demande. Chaque tâche rappelle de rétablir le fichier et de le vérifier par `git diff` avant commit.

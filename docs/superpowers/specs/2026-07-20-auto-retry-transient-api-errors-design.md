# Auto-retry serveur des erreurs API transitoires — design

Date : 2026-07-20
Fichiers concernés : `src/server.ts` (détection + timer), `public/index.html`
(ligne d'état informative).

## Objectif

Quand un tour meurt sur une erreur API transitoire (typiquement
`API Error: 529 Overloaded`), le serveur relance automatiquement le tour en
soumettant `continue`, sans intervention de l'utilisateur — même si aucun
client web n'est connecté. Si l'utilisateur reprend la main pendant le délai,
le retry est annulé.

Décisions utilisateur : toutes les erreurs API transitoires (pas seulement
529) ; 3 tentatives à délai croissant (15 s / 30 s / 60 s) ; relance par un
simple prompt `continue` ; détection et timer entièrement côté serveur.

## Détection (fin de tour, dans `finishTurn`)

`finishTurn` attend déjà la fin du tour (`waitForIdle`) puis inspecte l'écran
pour détecter un dialog. On y ajoute, quand il n'y a **pas** de dialog, un
test d'erreur transitoire sur l'écran du TUI :

- Pattern (fonction pure exportée `findTransientErrors(screen): string[]`,
  retourne les lignes qui matchent) :
  `API Error` suivi sur la même ligne de `5xx`, `529`, `429`, `overloaded`,
  `timeout`, ou une erreur de connexion (`ECONNRESET`, `ETIMEDOUT`,
  `fetch failed`…).
- Les erreurs non transitoires (`400`, `401`, `403`, `invalid_request`…) ne
  matchent pas : pas de retry.

**Anti faux-positif** : une vieille erreur peut rester visible à l'écran
après un tour court réussi. Au tout début de `finishTurn` (un seul point,
qui couvre tous les handlers ainsi que le chemin du retry lui-même), on
capture `errorsAtTurnStart = findTransientErrors(screen)`. À la fin du tour,
on ne déclenche que si `findTransientErrors(screen)` contient une ligne
absente de la capture initiale (comparaison multiset : une occurrence en
plus de la même ligne compte comme nouvelle).

## État par session (objet `Live`)

```ts
retryTimer: ReturnType<typeof setTimeout> | null; // retry en attente
retryCount: number;                               // tentatives consommées (0–3)
errorsAtTurnStart: string[];                      // capture anti faux-positif
```

## Déclenchement

Si une nouvelle erreur transitoire est détectée en fin de tour :

1. Si `retryCount >= 3` : broadcast `{ type: "auto-retry-gave-up" }`,
   reset `retryCount = 0`, fin (l'utilisateur relancera à la main).
2. Sinon : `retryCount++`, délai = 15 s / 30 s / 60 s selon la tentative,
   broadcast `{ type: "auto-retry", delayMs, attempt, max: 3 }`, puis
   `retryTimer = setTimeout(...)`.
3. À l'échéance : si la session est toujours vivante et non `busy`,
   broadcast `{ type: "prompt-echo", text: "continue", auto: true }`,
   `pilot.submit("continue")` puis `finishTurn` (mêmes garde-fous
   busy/erreur que le handler `prompt`). Une nouvelle erreur au tour
   suivant re-déclenche la détection, d'où l'escalade des délais.

`retryCount` revient à 0 dès qu'un tour se termine **sans** nouvelle erreur
transitoire, ou qu'un prompt utilisateur arrive.

## Annulation

Le timer en attente est annulé (`clearRetry(s)`) quand :

- un message utilisateur arrive : `prompt`, `choose`, `toggle`, `freetext`,
  `confirm`, `key` (l'utilisateur a repris la main) — broadcast
  `{ type: "auto-retry-cancelled" }` ;
- la session est stoppée ou détruite : `destroySession` nettoie
  `retryTimer` comme il nettoie déjà `idleTimer`.

Le message `settle` n'annule pas : c'est un simple « attendre la fin du
tour », pas une reprise en main.

## UI (informatif uniquement)

Le client web affiche, à réception de `auto-retry`, une ligne d'état dans le
canal : « Erreur API transitoire — relance auto dans 15 s (tentative 1/3) »,
effacée à `working` (le retry est parti), `auto-retry-cancelled` ou remplacée
par un message final à `auto-retry-gave-up`. Aucune action requise côté
client ; les clients non mis à jour ignorent simplement ces événements.

## Tests

Pas de harnais de test dans le projet aujourd'hui. `findTransientErrors` et
la comparaison début/fin de tour sont des fonctions pures exportées,
validées par un petit script `debug/` avec des écrans d'erreur capturés
(529, 500, timeout, erreur 400 qui ne doit PAS matcher, vieille erreur
encore visible qui ne doit PAS re-déclencher). Validation manuelle du timer
en simulant l'écran.

# Design — Terminal TUI interactif dans le web (expérimental)

Date : 2026-07-28
Statut : validé (brainstorming)

## Idée

Aujourd'hui l'engine room montre l'écran TUI **en lecture seule** (`#screen`,
snapshot `capture-pane` pollé) + quelques boutons de touches. On veut un **vrai
terminal interactif** : le flux ANSI complet du TUI rendu par xterm.js, et la
possibilité de **taper dedans** (passthrough clavier complet : flèches, Ctrl,
Échap, tout). Feature **expérimentale**, derrière un **toggle global**.

## Cible

Transport **tmux** (le défaut, survit aux restarts) — pour que ce soit utilisable
dans le vrai cockpit. Data plane dé-risqué en shell : `pipe-pane` streame bien la
sortie brute, `send-keys -H` injecte l'entrée.

## Architecture

### Serveur — `TmuxPilot` (nouvelles méthodes)

- `seed(): string` — `tmux capture-pane -e -p` : écran courant AVEC séquences
  d'échappement (couleurs), pour amorcer le terminal à l'attache (pipe-pane ne
  capture que le **nouveau** flux).
- `sendRaw(data: Buffer)` — `tmux send-keys -H <hex…>` : injecte des octets bruts.
- `attachRaw(onData): () => void` — `tmux pipe-pane -O -t <name> 'cat >> <tmpfile>'`
  puis tail du fichier (poll ~40 ms, offset) → `onData(chunk)`. Retourne un
  détach (ferme le pipe, supprime le fichier). Un seul consommateur par pilote ;
  le serveur fan-out vers les clients WS.
- **Pas de resize de tmux** : le plan de contrôle scrute cet écran (dialogues,
  fin de tour) — le redimensionner casserait la détection. xterm affiche la
  taille native du pane.

Réservé au `TmuxPilot` (le transport live). `PtyPilot` : non couvert par le MVP.

### Serveur — `server.ts` (WS)

- `term-attach` → si pas déjà attaché : `broadcast(term-data seed)` puis
  `attachRaw` qui `broadcast(term-data, base64(chunk))`. Refcompte par session.
- `term-input {data:base64}` → `sendRaw(Buffer.from(data,'base64'))`.
- `term-detach` → stoppe `attachRaw` s'il ne reste plus de client attaché.
- `term-data {data:base64}` (serveur→client).
- base64 partout : les octets de contrôle ne passent pas en JSON brut.

### Client — `public/index.html`

- **Vendoring** `@xterm/xterm` (JS + CSS) servi en `/vendor/xterm.js` /
  `/vendor/xterm.css` (même mécanisme que `/vendor/marked.js`).
- **Toggle global expérimental** : case dans le menu ⋯ (« ⚡ Terminal interactif
  (exp.) »), persistée `localStorage["cp.expTerminal"]`.
- Quand le toggle est ON et l'engine room ouverte : on instancie un
  `Terminal` xterm.js dans un conteneur (à la place / au-dessus du `#screen`
  read-only), on envoie `term-attach`, on `term.write(atob(data))` sur
  `term-data`, et `term.onData(d => ws.send(term-input, btoa(d)))`. À la
  fermeture / toggle OFF → `term-detach` + `term.dispose()`.
- Toggle OFF → comportement actuel inchangé (`#screen` en lecture seule).

## Sécurité / risques

- Écrire en brut dans le pane interfère avec le plan de contrôle du cockpit
  (détection de tour) — assumé, c'est le mode expérimental.
- pipe-pane vers un fichier temp (poll 40 ms) : latence de sortie ~40 ms,
  acceptable pour de la frappe. Fichier supprimé au détach.
- Le seed (capture-pane -e) peut légèrement décaler le curseur vs le flux ;
  acceptable pour un proto.

## Vérification

- **Headless (sans navigateur)** : sur un serveur de test **port 3899**, prouver
  le data plane bout-en-bout — attacher via un client WS de test, vérifier que le
  seed + le flux arrivent et que `term-input` écrit dans le pane (relu via
  `capture-pane`). Le rendu xterm.js lui-même : à valider à l'œil (navigateur MCP
  déconnecté).
- `npm run build` (TS touché : tmux.ts, server.ts).

## Critères de réussite

1. Toggle ON → l'engine room affiche un terminal xterm.js vivant, coloré.
2. La sortie du TUI (frappe, dialogues) s'affiche en continu.
3. Taper dans le terminal (flèches, lettres, Entrée, Ctrl-C, Échap) agit sur le
   TUI.
4. Toggle OFF → écran read-only actuel, aucun flux résiduel (détach propre).
5. Aucune régression du cockpit toggle OFF.

## Hors MVP (YAGNI)

Resize tmux↔xterm, scrollback, souris, support PtyPilot, multi-onglets simultanés
en flux brut.

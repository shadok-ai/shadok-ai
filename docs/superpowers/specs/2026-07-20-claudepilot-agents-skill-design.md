# Skill `shadok-ai-agents` — design

Date : 2026-07-20
Statut : validé (brainstorming avec l'utilisateur)

## Objectif

Permettre à Claude Code de créer et piloter des agents shadok-ai via le
serveur web (protocole WebSocket documenté dans le README) : lancer un agent
dans un worktree git isolé, lui envoyer des prompts, lire ses réponses,
répondre à ses dialogs interactifs, récupérer son diff, le stopper. Les
sessions restent visibles et pilotables en parallèle dans l'UI web
(sessions partagées côté serveur).

## Décisions actées

- **Interface** : serveur web / WebSocket (`ws://localhost:3789/ws`) + les
  endpoints HTTP (`/sessions`, `/diff`). Pas de pilotage direct par CLI ni
  par la librairie.
- **Périmètre** : complet — spawn (avec ou sans worktree), prompt/réponse,
  dialogs (choose/toggle/confirm/freetext), rattachement à une session
  existante, diff, stop, screen (debug). Pas d'orchestration multi-agents
  intégrée (les agents parallèles se pilotent en lançant plusieurs
  commandes).
- **Emplacement** : skill de projet, versionnée dans ce repo sous
  `.claude/skills/shadok-ai-agents/`.
- **Serveur absent** : démarrage automatique en arrière-plan (build si
  nécessaire), attente du port, puis poursuite.
- **Architecture** : approche « thin client » — un helper `pilotctl.mjs`
  livré avec la skill encapsule le protocole en commandes one-shot à sortie
  JSON. Pas de daemon persistant : le serveur shadok-ai est la source de
  vérité (état des sessions, resumabilité), chaque commande se connecte,
  agit, se détache.

## Structure

```
.claude/skills/shadok-ai-agents/
  SKILL.md        # instructions : quand utiliser, commandes, flux types, pièges
  pilotctl.mjs    # thin client WS/HTTP ; seule dépendance : "ws" (déjà dans le repo)
```

`pilotctl.mjs` est un module ESM situé dans le repo : `import WebSocket from
"ws"` se résout en remontant vers le `node_modules` du repo (Node 20 n'a pas
de client WebSocket global stable). Le script s'exécute avec
`node .claude/skills/shadok-ai-agents/pilotctl.mjs <commande> …`.

## Commandes de `pilotctl.mjs`

Sortie : un objet JSON sur stdout ; exit code 0 en succès, ≠ 0 en erreur
(avec `{error: …}` sur stdout).

| Commande | Effet |
|---|---|
| `spawn [--cwd DIR] [--worktree] [--resume ID] [--continue]` | ouvre un WS, envoie `start`, attend `ready`, imprime `{sessionId, cwd, branch}` puis se détache |
| `prompt <id> "texte" [--timeout s]` | se rattache (`start` + `resume: id`), envoie `prompt`, reste connecté jusqu'à `answer` **ou** `dialog`, imprime `{status:"answer", text}` ou `{status:"dialog", question, options, multi}` |
| `dialog <id>` | se rattache et imprime le dialog en attente s'il y en a un, sinon `{status:"idle"}` |
| `choose <id> <n>` | single-select : choisit et valide l'option n, attend la suite (`answer` ou nouveau `dialog`) |
| `toggle <id> <n>` | multi-select : bascule l'option n, imprime l'état re-lu du dialog |
| `confirm <id>` | multi-select : soumet la sélection, attend la suite |
| `freetext <id> <n> "texte"` | option « Type something » : envoie la réponse libre, attend la suite |
| `list [--cwd DIR]` | GET `/sessions` |
| `diff <id>` | GET `/diff?session=…` → `{status, diff, branch}` du worktree |
| `stop <id>` | envoie `stop` (termine la session pour tous les clients) |
| `screen <id>` | imprime le screen TUI courant (debug / engine room) |

### Démarrage automatique du serveur

Chaque commande commence par un health-check HTTP sur
`http://localhost:${SHADOK_PORT ?? 3789}`. Si le serveur ne répond
pas :

1. `npm run build` dans le repo si `dist/server.js` est absent ;
2. lancement détaché de `node dist/server.js` (stdout/stderr vers un log
   sous `~/.shadok-ai/`) ;
3. attente active du port (timeout ~15 s), puis poursuite de la commande ;
4. échec persistant → `{error}` explicite, exit ≠ 0.

Le serveur lancé reste up ensuite (il sert aussi l'UI web).

## Contenu de SKILL.md

- **Quand utiliser** : déléguer une tâche à un agent Claude isolé dans un
  worktree, piloter/inspecter des sessions shadok-ai existantes.
- **Flux type « créer un agent »** : `spawn --worktree --cwd <repo>` →
  `prompt <id> "<tâche>"` lancé via Bash en `run_in_background` (les tours
  peuvent durer plusieurs minutes) → à la notification, lire le JSON ; si
  `dialog`, répondre (`choose`/`toggle`+`confirm`/`freetext`) ; en fin de
  tâche, `diff <id>` pour présenter les changements à l'utilisateur.
- **Garde-fous** :
  - ne jamais `stop` une session que la conversation courante n'a pas
    créée (elle appartient peut-être à l'utilisateur dans l'UI web) ;
  - la branche `shadok-ai/<tag>` et son worktree ne sont jamais mergés ni
    supprimés automatiquement — c'est l'utilisateur qui merge ;
  - chaque agent consomme le quota Claude comme une session normale : ne
    pas multiplier les agents sans demande explicite ;
  - un `timeout` de `prompt` n'interrompt pas le tour côté serveur — se
    rattacher plus tard plutôt que relancer le prompt.

## Gestion des erreurs

- `prompt`/`choose`/… en timeout → `{status:"timeout", screen}` (le screen
  courant aide au diagnostic), détachement propre, session intacte.
- Session inconnue → le serveur répond `error` ; pilotctl imprime
  `{error}` et sort ≠ 0.
- `exited`/`stopped` inattendus pendant l'attente → `{status:"exited",
  code}`.
- Serveur injoignable après tentative d'auto-start → `{error}` explicite.

## Test de validation (manuel, de bout en bout)

1. `spawn --worktree` sur un repo jouet → `sessionId` + `branch` retournés,
   worktree créé sous `~/.shadok-ai/worktrees/` ;
2. `prompt` simple (« crée un fichier hello.txt ») → `answer` reçu (en
   répondant aux éventuels dialogs de permission via `choose`) ;
3. `diff` → le fichier apparaît dans le diff ;
4. `stop` → session terminée, le worktree sale est **conservé** ;
5. la session est visible dans l'UI web pendant les étapes 1–3.

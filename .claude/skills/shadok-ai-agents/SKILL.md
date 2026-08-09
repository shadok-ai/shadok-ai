---
name: shadok-ai-agents
description: Créer et piloter des agents Claude Code isolés via le serveur shadok-ai (worktrees git, prompts, dialogs, diff). Utiliser quand l'utilisateur veut déléguer une tâche à un agent shadok-ai, lancer des agents en parallèle, ou inspecter/piloter des sessions shadok-ai existantes.
---

# Piloter des agents shadok-ai

Toutes les opérations passent par le thin client livré avec cette skill :

```bash
node .claude/skills/shadok-ai-agents/pilotctl.mjs <commande> …
```

Chaque commande imprime UN objet JSON sur stdout (exit 1 + `{error}` en
échec) et démarre automatiquement le serveur shadok-ai s'il ne tourne pas
(port 3789, ou `$SHADOK_PORT`). Les sessions restent visibles dans
l'UI web (http://localhost:3789) — l'utilisateur peut suivre et intervenir.

## Commandes

| Commande | Effet |
|---|---|
| `spawn [--cwd DIR] [--worktree] [--profile NOM] [--resume ID] [--continue]` | crée un agent → `{sessionId, cwd, branch}`. `--worktree` isole l'agent dans un worktree git (`~/.shadok-ai/worktrees/`, branche `shadok-ai/<tag>`). `--profile` lui donne un rôle + ses garde-fous + ses secrets (voir ci-dessous) |
| `prompt <id> "texte" [--timeout s]` | envoie un prompt, attend la fin du tour → `{status:"answer", text, tools}` ou `{status:"dialog", question, options, multi}` ou `{status:"timeout", screen}` ou `{status:"pace-blocked", reason}` |
| `dialog <id>` | interroge l'état → `{status:"idle"}` ou le dialog en attente |
| `choose <id> <n>` | dialog single-select : choisit et valide l'option n |
| `toggle <id> <n>` puis `confirm <id>` | dialog multi-select : coche/décoche puis soumet |
| `freetext <id> <n> "texte"` | option « Type something » : réponse libre |
| `list [--cwd DIR]` | agents pilotés (état local + vivant/mort) et sessions résumables |
| `diff <id>` | changements de l'agent (git status + diff vs la base du worktree) |
| `stop <id>` | termine la session (pour TOUS ses clients) |
| `screen <id>` | screen TUI brut (debug) |
| `profile-prompt "<texte>" [--name NOM] [--readonly]` | réécrit le **prompt système** d'un profil : le tien par défaut ; n'importe lequel (et création avec `--name`) sous le profil de tête |

## Choisir un profil (`--profile`)

Un profil est un rôle appliqué au démarrage : prompt système, garde-fous de
permissions natifs (ex. écritures git bloquées), secrets injectés, modèle
éventuel. **Sans `--profile`, l'agent démarre en Claude nu** — ni rôle, ni
garde-fou, ni secrets.

Les profils livrés : `Shadok-Boss` (lit tout, délègue, read-only),
`Shadok-dev` (code, accès complet), `Shadok-Marketing` et `Shadok-Support`
(read-only). `pilotctl.mjs list` ne les énumère pas — la liste vit dans le
panneau Profiles de l'UI, ou via `GET /profiles`.

Le profil n'est appliqué qu'aux sessions **neuves** : avec `--resume` ou
`--continue`, la session reprend celui qu'elle avait déjà.

## Faire évoluer ton propre rôle (`profile-prompt`)

Tu peux réécrire le **prompt système** de ton profil — pour y consigner ce que
tu as appris sur ce dépôt, une convention à ne plus redécouvrir, un piège à
éviter. Sous le profil de tête, tu peux réécrire n'importe quel prompt et
**fabriquer** un rôle (`--name`, plus `--readonly` pour qu'il naisse avec les
écritures git bloquées).

Ce que tu ne peux **pas** toucher : `deny`, `allow`, `secrets`, `model`. Ce sont
les garde-fous, ils appartiennent à l'humain et s'éditent depuis l'UI web — un
agent read-only ne doit pas pouvoir s'accorder les écritures git, ni un rôle
fabriqué s'attribuer les secrets du coffre. Ces champs sont ignorés ici, pas
seulement refusés.

L'autorisation repose sur `$SHADOK_SESSION_KEY`, injectée dans ton env au
démarrage — l'id de session ne conviendrait pas, `/live` le publie.

Le prompt est passé à `claude` **au spawn** : une modification prend effet au
prochain redémarrage de l'agent, pas en cours de session.

```bash
node .claude/skills/shadok-ai-agents/pilotctl.mjs profile-prompt "$(cat <<'TXT'
… le nouveau prompt complet …
TXT
)"
```

Écris le prompt **entier** : il remplace l'ancien, il ne s'y ajoute pas.

## Flux type : déléguer une tâche à un agent

1. `spawn --worktree --profile <rôle> --cwd <repo>` → noter `sessionId` et `branch` ;
2. `prompt <id> "<tâche>"` — lancer via Bash en **run_in_background**
   (un tour peut durer plusieurs minutes) et lire le JSON à la fin ;
3. si `status:"dialog"` : répondre avec `choose` (single) ou
   `toggle`+`confirm` (multi) ou `freetext`, qui rendent à leur tour
   `answer` ou un nouveau `dialog` ;
4. si `status:"timeout"` : le tour CONTINUE côté serveur — ne pas renvoyer
   le prompt ; re-vérifier plus tard avec `dialog <id>` ;
4bis. si `status:"pace-blocked"` : RIEN n'a été envoyé — la consommation
   dépasse le rythme idéal du quota (`reason` le détaille). Ne pas insister
   en boucle ; en parler à l'utilisateur ;
5. tâche finie : `diff <id>` et présenter les changements à l'utilisateur.
   La branche `shadok-ai/<tag>` et son worktree ne sont JAMAIS mergés ni
   supprimés automatiquement — c'est l'utilisateur qui merge.

Agents parallèles : répéter `spawn` (un id par agent), lancer les `prompt`
en arrière-plan simultanément.

## On te prévient : tes agents te répondent

Un agent que tu spawnes est enregistré comme ton **enfant**, automatiquement —
rien à passer. Tu reçois alors un message quand il :

- **termine son tour** (avec son propre résumé et un lien vers son `diff`) ;
- **bloque sur une question** (la question, ses options, et comment y répondre) ;
- **meurt ou expire** — sinon tu attendrais indéfiniment un agent déjà parti.

Ces messages arrivent préfixés `🤖 [agent]`. Tu es prévenu de **tes** enfants et
d'aucun autre canal.

Conséquence pratique : **ne boucle plus pour surveiller un agent**. Lance le
`prompt` en arrière-plan et passe à autre chose — le sondage répété coûte un tour
à chaque fois, et l'information vient à toi.

`--parent none` spawne un agent délibérément non rattaché ; `--parent <id>` le
rattache ailleurs.

## Garde-fous

- Ne JAMAIS `stop` une session que cette conversation n'a pas créée : elle
  appartient peut-être à l'utilisateur dans l'UI web. `stop` termine la
  session pour tous ses clients.
- Chaque agent consomme le quota Claude comme une session normale. Ne pas
  multiplier les agents sans demande explicite de l'utilisateur.
- `prompt` sur une session dont le tour est déjà en cours → erreur « a
  response is already in progress » : attendre avec `dialog <id>`.
- Si un agent semble bloqué sur un état que les dialogs ne couvrent pas,
  regarder `screen <id>` (équivalent de l'« engine room » de l'UI).
- Pour reprendre une session existante (`spawn --resume <id>`), toujours passer
  `--cwd` avec le répertoire de la session (le serveur retomberait sinon sur
  son propre cwd) ; pour un agent déjà piloté, l'état local fournit ce cwd
  automatiquement.

## Mécanique (pour le debug)

Le serveur tue le process claude quand son dernier client WS se détache ;
`pilotctl` maintient donc un petit process « holder » détaché par agent
(commande interne `hold`), relancé au besoin par chaque commande. État
local : `~/.shadok-ai/pilotctl/<id>.json` (cwd, branch, baseSha,
holderPid). Log du serveur auto-démarré : `~/.shadok-ai/pilotctl/server.log`.

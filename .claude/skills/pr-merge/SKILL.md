---
name: pr-merge
description: Use when des PR sont ouvertes sur shadok-ai/shadok-ai et qu'il faut les amener au merge — passage périodique sur les PR, PR verte à merger, PR en retard sur main (mode strict), conflit de rebase, CI verify rouge à réparer, ou doute sur l'éligibilité d'une PR au merge automatique.
---

# pr-merge — amener les PR de shadok-ai au merge

## Overview

`main` est protégée en mode **strict** : le check `verify` doit passer **et** la
branche doit être à jour. Beaucoup d'agents travaillent en parallèle dans des
worktrees durables, donc **une branche de PR peut être encore tenue par une
session vivante**.

Principe : ne jamais casser `main`, ne jamais pousser sous les pieds d'un agent.

Rationale et alternatives écartées : `docs/superpowers/specs/2026-07-28-pr-merge-agent-design.md`.

## Filtre d'entrée

Une PR n'est candidate que si **les quatre** tiennent :

1. `isDraft: false` ;
2. `baseRefName: main` ;
3. auteur ∈ {`shadok-ai-dev`, bots (`dependabot[bot]`, `github-actions[bot]`, bots d'app)} ;
4. pas de label `hold`.

`isCrossRepository: true` (fork) → **jamais touché**, signalé.

```bash
gh pr list --state open --limit 50 --json \
  number,title,author,isDraft,mergeStateStatus,headRefName,baseRefName,labels,isCrossRepository
```

## Décision, par `mergeStateStatus`

| Statut | Sens | Action |
|---|---|---|
| `CLEAN` | vert + à jour | relecture rapide → `gh pr merge N --squash --subject "<titre> (#N)"` |
| `BEHIND` | en retard sur `main` | `gh pr update-branch N` → attendre `verify`, puis merger **dans le même passage** |
| `DIRTY` | conflit | simple → résoudre ; gros → montrer à l'humain |
| `UNSTABLE` | checks en échec **ou en cours** | lire `statusCheckRollup` : en cours → attendre ; échec → simple → réparer, gros → montrer |
| `BLOCKED` | review manquante, autre blocage | signaler, ne rien forcer |

Après tout push : **attendre que `verify` repasse vert avant de merger**. Jamais de
merge sur un vert périmé.

**Ne pas rendre la main entre les étapes.** `main` bouge plus vite qu'un passage
toutes les 5 minutes : une PR mise à jour au tour N est souvent repassée `BEHIND`
au tour N+1, et la boucle tourne sans jamais rien merger — c'est arrivé trois
fois de suite. Une PR dont la CI est déjà verte s'enchaîne d'un bloc :
`update-branch` → attente de `verify` → relecture → merge. On ne s'interrompt que
si `verify` échoue ou si un red flag apparaît.

## Simple vs gros

**Le doute compte comme gros.** C'est gros dès que l'une tient :

- les deux côtés du conflit modifient la même logique ;
- la résolution touche plus de 2 fichiers ;
- le test rouge révèle un vrai problème de conception, pas un oubli mécanique ;
- la résolution ne tient pas en une phrase explicable.

Simple ressemble à : deux ajouts dans une même liste, blocs d'imports, fonctions
indépendantes adjacentes, erreur de type, import manquant, coquille, assertion
qu'une PR a oublié de mettre à jour.

## Garde-fou « session vivante » — avant un push LOCAL

```bash
curl -s localhost:3789/live | jq -r '.[].cwd' | while read -r d; do
  printf '%s\t%s\n' "$d" "$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)"
done
```

Si la branche de la PR apparaît → **ne pas y pousser de commit local**, signaler.

Ce garde-fou vise le push (et a fortiori le force-push), pas ces deux-là, qui
restent autorisés même sur une branche tenue :

- **`gh pr merge`** — ne modifie pas la branche source ;
- **`gh pr update-branch`** — merge `main` dans la branche **côté GitHub** :
  aucune réécriture d'historique, le checkout de l'agent n'est pas touché. Au
  pire il devra `git pull` avant son prochain push.

Étendre la règle à `update-branch` a laissé trois PR vertes traîner pour rien,
en attendant la fin de sessions qui n'y touchaient plus.

Les corrections locales (conflit, CI rouge) se font dans un worktree **dédié**,
`~/.shadok-ai/worktrees/pr-bot` — jamais celui d'un autre, jamais le repo racine.
On merge `main` dans la branche ; on ne rebase pas en force-push (cela casserait
le checkout des agents qui tiennent encore ces branches).

## Relecture rapide avant merge (~30 s)

`gh pr diff N`, puis chercher : secrets ou tokens en dur · fichiers hors du sujet
annoncé · suppressions massives non justifiées · marqueurs de conflit résiduels ·
traces de debug · `version` modifiée dans `package.json` (interdit, la CI la calcule).

Quelque chose cloche → on ne merge pas, on signale.

## Did the docs ship with it?

One extra question on the same diff, because this is the last moment it is cheap:

> **Does this PR change something a document describes, without changing that
> document?**

- a user-visible feature, flag, Telegram command, HTTP endpoint or WS message
  → `README.md`;
- a new or reshaped subsystem, or a design trade-off worth remembering
  → `docs/architecture.md`;
- a new module, or an invariant learned the hard way → `CLAUDE.md`.

**This is not a merge blocker.** Sending a green PR back for a doc line costs a
CI round trip and stalls the queue, which is worse than the gap. Merge it, then
**say so in the report** — name the file that should have moved. A doc gap that
is written down gets closed; one that is noticed silently does not.

The cost of skipping this: `docs/architecture.md` once went 48 commits without
an update. It was then missing entire subsystems, and its line references were
hundreds of lines off — confidently wrong, and read as current.

## Faire tourner le passage en continu

Un cron de canal shadok, **avec garde déterministe** — pas une boucle de session :

```bash
node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs add \
  --schedule every:5m \
  --check "sh $HOME/.shadok-ai/checks/pr-open.sh" \
  --prompt "Des PR sont ouvertes sur shadok-ai/shadok-ai (liste ci-dessus). Applique la procédure du skill pr-merge. Si finalement rien n'est à faire, écris exactement NOTHING TO SHOW."
```

La garde est `scripts/check-open-prs.sh` (ce dossier). Le serveur l'exécute
**sans LLM** : elle n'imprime que s'il existe une PR ouverte non-draft basée sur
`main`, et sa sortie est préfixée au prompt. Un dépôt calme coûte donc **0 token**
et ne laisse aucune trace dans le fil.

Deux pièges appris à l'usage :

- **La copie exécutée vit hors du dépôt**, dans `~/.shadok-ai/checks/`. Un chemin
  versionné (`.claude/skills/…`) casse dès qu'un agent change la branche du
  checkout racine — le fichier disparaît et la garde échoue en silence. La source
  de vérité reste ici ; recopier après modification.
- **Une boucle de session (`/loop`) ne suffit pas** : elle meurt avec la session,
  expire au bout de 7 jours, et réveille le LLM à chaque créneau même sans PR.

## Red flags — s'arrêter et demander à l'humain

- La PR touche `.github/workflows/` — **toujours**, même si le reste est propre.
- L'auteur est hors liste blanche, ou la PR vient d'un fork.
- Il faudrait force-pusher, supprimer une branche ou un worktree, ou redémarrer
  le serveur shadok-ai.
- La résolution du conflit ne s'explique pas en une phrase.

## Rapport

Une ligne par PR traitée, ouverte par un marqueur repérable au scroll — entre
deux actions il peut y avoir vingt passages muets, et une ligne de texte brut
s'y noie :

```
✅ MERGED #83 — <titre> (`<sha>`) → 0.1.160
⏭ UPDATE-BRANCH #82 — en retard sur main, CI vérifiée au passage suivant
⚠️ #77 — base `worktree-x`, pas `main` : hors filtre, non touchée
```

La version d'un merge est celle que la CI publiera :
`major.minor.<nombre de commits sur main>`, donc après le merge

```bash
git fetch origin -q && git rev-list --count origin/main
```

Le serveur qui tourne reste sur la version précédente quelques minutes, le temps
que l'auto-update passe — ce n'est pas un symptôme.

Rien à faire — aucune PR ouverte, ou rien n'a bougé depuis le passage précédent —
→ écrire **exactement** ceci, seul, sans rien autour :

```
NOTHING TO SHOW
```

Rien d'autre : pas de « rien à faire », pas de compte rendu entre parenthèses,
pas d'accusé de réception, pas de ponctuation ni d'emoji ajoutés. C'est un
**marqueur, pas une phrase** : l'humain filtre cette chaîne exacte dans le
cockpit, donc la moindre variante (traduction, reformulation, minuscules) la
laisse passer et pollue le fil.

Le silence pur — un tour sans aucun texte — a été essayé et ne marche pas : le
harness relance l'agent en exigeant une réponse visible. D'où ce marqueur.

Une boucle qui tourne toutes les 5 minutes ne doit rien laisser d'autre tant
qu'elle n'agit pas.

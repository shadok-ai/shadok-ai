# Agent de gestion des PR — design

**Date :** 2026-07-28
**But :** un agent qui amène les PR de `shadok-ai/shadok-ai` jusqu'au merge, tout seul,
sans jamais casser `main` ni marcher sur les pieds d'un agent vivant.

## Contexte

- `main` est protégée : check `verify` requis, mode **strict** (la branche doit être
  à jour avec `main` avant merge), 0 review requise.
- Beaucoup d'agents shadok-ai travaillent en parallèle dans des worktrees durables.
  Une branche de PR peut donc être **encore tenue par une session vivante**.
- L'historique de `main` est en squash-merge, titre `Titre (#N)`.
- Le gotcha #8 du CLAUDE.md (merges à l'aveugle, marqueurs de conflit dans `main`)
  est la source #1 de casse passée. Ce design existe pour ne pas la reproduire.

## Forme

Une **boucle dans la session** du cockpit, toutes les **5 minutes**. Pas de cron, pas
de skill : l'humain voit passer chaque tour et peut interrompre.

## Approche : côté serveur d'abord, local seulement si nécessaire

Le cas le plus courant est « verte mais en retard sur `main` » (conséquence directe du
mode strict). On le traite avec `gh pr update-branch`, qui **merge `main` dans la
branche côté GitHub, sans réécrire l'historique**.

On ne rebase pas en force-push : cela casserait le checkout local des agents qui
tiennent encore ces branches. On ne descend en local — dans un worktree **dédié**,
`~/.shadok-ai/worktrees/pr-bot`, jamais celui d'un autre — que pour un vrai conflit
ou une réparation de CI.

Alternatives écartées :

- **Tout rebaser en local + force-push.** Uniforme, mais réécrit l'historique sous
  les agents vivants.
- **Auto-merge natif GitHub.** Léger, mais il ne sait ni résoudre un conflit ni
  réparer un rouge, et il court-circuite la relecture rapide.

## Filtre d'entrée

Une PR n'est candidate que si **toutes** ces conditions tiennent :

1. ce n'est pas un brouillon ;
2. la base est `main` ;
3. l'auteur est dans la liste blanche : `shadok-ai-dev`, plus les bots
   (`dependabot[bot]`, `github-actions[bot]`, bots d'app) ;
4. elle ne porte pas le label `hold`.

Tout le reste — au premier chef **les PR venant d'un fork** — est signalé et jamais
touché.

## Décision, par PR

| État | Action |
|---|---|
| Verte + à jour | Relecture rapide → squash-merge |
| Verte, en retard sur `main` | `gh pr update-branch` → la CI est vérifiée au tour suivant |
| Conflit **simple** | Résolution dans le worktree dédié → push → CI verte → merge |
| Conflit **gros** | Arrêt, le conflit est montré à l'humain |
| Rouge **simple** | Correctif → push → CI verte → merge |
| Rouge **gros** | Arrêt, diagnostic montré à l'humain |

### Simple vs gros

C'est **gros** dès que l'une de ces conditions tient :

- les deux côtés du conflit modifient la même logique ;
- plus de 2 fichiers sont touchés par la résolution ;
- le test rouge révèle un vrai problème de conception, pas un oubli mécanique ;
- la résolution ne tient pas en une phrase explicable.

**Le doute compte comme gros.** Un conflit *simple* ressemble à : deux ajouts dans
une même liste, des blocs d'imports, des fonctions indépendantes adjacentes, un
CHANGELOG. Un rouge *simple* ressemble à : erreur de type, import manquant, coquille,
assertion de test que la PR a oublié de mettre à jour.

## Garde-fou « session vivante »

Avant **tout push** sur une branche de PR, interroger `localhost:3789/live` et
comparer la branche des worktrees actifs à la tête de la PR. Si une session tourne
sur cette branche : **ne pas pousser**, signaler à l'humain.

Merger reste autorisé dans ce cas — un merge ne modifie pas la branche source.

## Relecture rapide avant merge

Scan du diff, ~30 s, à la recherche de :

- secrets ou tokens en dur ;
- fichiers hors du sujet annoncé par la PR ;
- suppressions massives non justifiées ;
- marqueurs de conflit résiduels ;
- traces de debug oubliées ;
- `package.json` dont la `version` est modifiée — interdit, la CI la calcule ;
- toute modification de `.github/workflows/` → **toujours demander à l'humain**,
  même si le reste est propre.

Si quelque chose cloche, on ne merge pas : on le signale.

## Merge

Squash, titre `Titre (#N)`. La branche distante **n'est pas supprimée** : les
worktrees sont durables (invariant #5), leur nettoyage reste un geste explicite.

## Interdits absolus (sans accord explicite de l'humain)

Merger un fork ou un auteur hors liste blanche ; force-push sur `main` ; modifier les
workflows ; supprimer une branche ou un worktree ; redémarrer le serveur shadok-ai.

## Rapport

Une ligne par PR traitée à chaque tour. Si rien n'a bougé depuis le tour précédent,
la boucle reste silencieuse.

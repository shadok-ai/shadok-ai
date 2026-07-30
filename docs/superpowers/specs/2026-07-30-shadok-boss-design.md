# Shadok-Boss — un agent de tête qui délègue

Date : 2026-07-30
Statut : validé, implémenté

## Problème

Le canal `general` est le premier agent de l'environnement (`src/channels.ts`
force son nom) : c'est à lui que l'utilisateur parle en premier. Il n'avait
pourtant aucun rôle — un Claude nu, qui traite chaque demande lui-même.

Or l'intérêt du cockpit est de faire tourner **plusieurs** agents en parallèle.
L'agent d'entrée devrait donc surtout savoir *répartir*.

Et un trou empêchait de le faire proprement : `pilotctl.mjs` — le client par
lequel la skill `shadok-ai-agents` crée des agents — ne connaissait pas
`--profile`. Le message WS `start` accepte pourtant `profile` depuis les
profils d'agents. Résultat : **tout agent délégué démarrait en Claude nu**, sans
rôle, sans garde-fou, sans secrets. Un boss qui délègue à des agents anonymes ne
délègue pas vraiment.

## 1. `--profile` dans pilotctl

`parseArgs` : `--profile` rejoint les flags à valeur (`--cwd`, `--resume`,
`--timeout`). `cmdSpawn` : `if (flags.profile) startMsg.profile = flags.profile`.
Rien à changer côté serveur.

Le profil n'a d'effet que sur une session **neuve** : en `--resume` /
`--continue`, la session reprend celui qu'elle avait déjà. C'est la règle
existante du serveur, la doc de la skill la rappelle.

## 2. Le profil `Shadok-Boss`

Quatrième entrée de `DEFAULT_PROFILES`, **placée en première position** : c'est
la porte d'entrée, donc la première carte de la box « New agent ».

- `deny: READONLY_DENY` — les mêmes écritures git bloquées que Marketing et
  Support.
- `secrets: []`, **pas de `model` forcé** — cohérent avec les trois autres ;
  l'utilisateur l'épingle depuis le panneau Profiles s'il le veut.

**Pourquoi read-only, c'est le cœur du design.** Un boss qui peut committer
finit par corriger lui-même « juste ce typo », puis la fonction d'à côté, et ne
délègue plus. Les écritures bloquées ne sont pas une méfiance : c'est ce qui
rend la délégation obligatoire plutôt que facultative.

Le prompt système lui donne deux tâches, dans l'ordre :

1. **Savoir** — lire le dépôt, `CLAUDE.md`, `docs/` et l'historique avant de
   répondre ; répondre lui-même aux questions, conclusion d'abord. Ne jamais
   faire attendre derrière un agent quand une lecture suffit.
2. **Déléguer** — tout travail réel part à un agent dédié, via
   `spawn --worktree --profile <rôle>` puis `prompt` en arrière-plan, avec un
   brief exécutable sans lui ; puis relire le `diff` et le présenter.

Il choisit le rôle (`Shadok-dev` pour le code, `Shadok-Marketing`,
`Shadok-Support`), **annonce ce qu'il spawne et pourquoi avant de le faire**
(chaque agent consomme le même quota qu'une session normale), ne merge jamais
lui-même (invariant 9), et n'arrête jamais une session qu'il n'a pas créée.

## Livraison

`seedDefaultProfiles` ne sème que si le fichier est **vide** : ajouter l'entrée
au code ne donne donc rien aux installations existantes. Le profil est aussi
créé dans le vault en service via `PUT /profiles`.

## Tests

- `helpers.test.mjs` : `--profile` prend une valeur et ne fuit pas en positionnel.
- `spawn.test.mjs` : le `start` reçu par le mock-server contient bien `profile`.
- `profiles.test.ts` : le boss est read-only, en tête de liste, et son prompt
  cite `shadok-ai-agents`, `--profile` et les trois rôles délégables — qui
  doivent exister dans `DEFAULT_PROFILES`.

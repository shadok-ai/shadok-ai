# Design — Les worktrees d'agents ne dérivent plus de main

Date : 2026-07-28
Statut : **validé (brainstorming), implémentation reportée** — décision explicite
du 2026-07-28 : on garde le design sous le coude, on ne code pas maintenant.

> **Reposé le 2026-08-08.** Ce fichier a été écrit avant la migration vers
> `shadok-ai/shadok-ai` et n'avait jamais été mergé : le nouvel historique n'a pas
> d'ancêtre commun avec la branche qui le portait, donc il a été **recopié**, pas
> rebasé. Le contenu du design est inchangé.
>
> Ses citations de code ne portent plus **que des noms de symboles**. La version
> d'origine donnait des numéros de ligne et ils ont dérivé **trois fois** en dix
> jours — `src/server.ts` est passé de ~1200 à 2244 lignes, une même référence
> allant de 181 à 338 puis à 611. Un numéro faux est pire qu'absent : il envoie
> le lecteur dans la mauvaise fonction avec un air de précision. (`CLAUDE.md`,
> section Conventions, demande maintenant la même chose partout.)

## Problème

Un worktree d'agent est forké sur `HEAD` du repo **au moment du spawn**
(`createWorktree`, `src/worktree.ts`) et `baseSha` est figé une fois pour
toutes. Rien dans le code ne revisite jamais cette base : aucun `fetch`, aucun
`rebase`, aucun `merge-base`. Chaque agent vit dans le passé du repo.

Constat au 2026-07-28 : `shadok-ai/0e330518` a 4 jours, `main` est à `3cbb520`,
plusieurs PR ont atterri entre-temps.

Les quatre douleurs, toutes retenues comme à traiter :

1. **Conflits au landing** — main a bougé, le merge part en conflit.
2. **Agent qui travaille sur du périmé** — il réécrit du code déjà corrigé sur
   main, ou part d'une API qui n'existe plus.
3. **Diff illisible** — `gitDiff` fait `git diff <baseSha>`
   (`src/worktree.ts`, appelé en `src/server.ts`) contre un SHA vieux de
   plusieurs jours, donc le panneau montre aussi ce que main a changé.
4. **Agents qui se marchent dessus** — deux agents parallèles touchent les mêmes
   fichiers sans le savoir.

## Chemin écarté (et pourquoi)

**Rebaser côté serveur, dans une fenêtre d'inactivité de l'agent.** Écarté.

Les signaux de repos disponibles ne sont pas assez solides pour justifier de
muter le disque sous un agent :

- `turn-done` ne signifie pas « l'agent a fini », seulement « ce tour est fini ».
  Le « spontaneous resume » (`src/server.ts`) existe précisément parce que le
  modèle repart tout seul, sans prompt client.
- `!s.busy` peut vouloir dire « suspendu sur un dialogue » : dans `finishTurn`,
  si `detectDialog` matche, on repasse `busy = false` quand même
  (`src/server.ts`).
- `screenShowsWork` (`src/detect.ts`) est du scraping d'écran, documenté comme
  fragile (CLAUDE.md, gotcha #2). Un faux négatif coûte aujourd'hui une jauge qui
  clignote ; branché sur un `git rebase`, il coûterait un arbre réécrit sous un
  agent en train d'éditer.
- Les `Bash` lancés en arrière-plan continuent d'écrire alors que l'écran est au
  repos.

S'ajoute un argument décisif : un `git rebase` côté serveur qui tombe sur un
conflit n'a personne pour trancher — il ne peut qu'`--abort`. L'agent, lui, est
le seul acteur qui sait ce que son propre changement voulait dire.

*(Variante notée si le sujet revient : ne pas **détecter** le repos mais le
**fabriquer**, en prenant `s.busy` comme mutex — les prompts sont déjà refusés
quand la session est busy — les deux gardes `hasExited || s.busy` de
`src/server.ts`. Non retenue : ne résout
pas les conflits, et ne couvre ni les bash en background ni l'humain qui tape
directement dans le tmux `sk-*`.)*

## Décision : l'acte à l'agent, le signal et la comptabilité au serveur

- **L'agent** rebase, résout les conflits, ou renonce et demande à l'humain.
  Il agit dans son propre flux, donc **zéro détection de repos, zéro mutex,
  zéro scraping**.
- **Le serveur** est le seul qui voit le repo et tous les worktrees : il détecte
  le retard, l'annonce, et tient les comptes du diff.

Un prompt seul ne suffit pas, pour trois raisons structurelles :

1. **L'agent ne sait pas que main a bougé** — aucun événement ne l'atteint. Une
   consigne « pense à rebaser régulièrement » se délite sur une session de
   plusieurs jours, surtout après compaction.
2. **`baseSha` casse** dès que l'agent réécrit son historique (voir ci-dessous).
3. **Les garde-fous actuels l'interdisent à moitié** (voir « Prompts »).

## Design

### 1. Serveur — supprimer `baseSha`, calculer la base en direct

`baseSha` est un état figé qui devient faux dès le premier rebase. Le
remplacement est plus simple que l'existant : calculer la base **en direct**.

- `gitDiff` diffe à trois points — `git diff <base>...HEAD` — ou de façon
  équivalente contre `git merge-base <base> HEAD`.
- Résultat : le panneau montre **exactement** le travail de l'agent, qu'il ait
  rebasé, mergé, ou rien fait.
- On **supprime un champ d'état** au lieu d'en ajouter. Le champ `baseSha` de
  `Worktree` (`src/worktree.ts`) et son usage (`src/server.ts`)
  disparaissent.
- Corollaire : la douleur #3 (diff illisible) est réglée **même sans rebase**.
  C'est le seul morceau qui a de la valeur isolément.

Même traitement pour `listPastSessions`, qui compte `commits`/`hasChanges`
contre `base` en deux points (`src/worktree.ts`).

### 2. Serveur — détecter le retard et l'injecter dans le prompt

- Comparer la branche du worktree à la branche courante du repo (comme
  `listPastSessions` le fait déjà, `src/worktree.ts`) : `git rev-list --count
  <branche>..<base>`.
- Si retard > 0, **préfixer le prochain prompt** d'une note du type
  « `main` a avancé de N commits depuis ton fork ».
- Pourquoi l'injection dans le prompt plutôt qu'une ligne statique dans
  `context/pilot-prompt.md` : le contexte est **frais au moment où il compte**,
  ne se délite pas avec la compaction, et **disparaît tout seul** quand il n'y a
  plus de retard. Aucun polling, aucune détection.
- Afficher aussi le retard sur le canal dans le cockpit.

### 3. Skill — la procédure de rebase

Un skill dédié (`.claude/skills/shadok-rebase/`) porte la procédure, pour garder
`pilot-prompt.md` court :

1. **Commit WIP d'abord, jamais de stash.** `git rebase` refuse un arbre sale,
   donc l'agent doit faire quelque chose de son travail en cours. Un commit
   `wip:` sur sa propre branche est visible dans le panneau diff, survit à tout,
   et se défait avec `reset --soft`. Un stash est invisible depuis le cockpit et
   se perd pour de bon si le rebase tourne mal — ce serait une violation de
   l'invariant #5 (« le travail n'est jamais jeté »).
2. **Rebase, pas merge.** Ces branches sont jetables et destinées à atterrir dans
   main ; un historique linéaire se revoit et se lande infiniment mieux qu'un
   `Merge branch 'main' into shadok-ai/xxx` tous les deux jours. Le seul argument
   pour le merge était « ça ne casse pas `baseSha` » — il tombe avec le passage
   au merge-base.
3. **En conflit** : l'agent résout si le conflit relève de son propre changement.
   Sinon `git rebase --abort` — qui restaure exactement l'état d'avant — et il
   demande à l'humain. Le pire cas est donc « rien ne s'est passé ».
4. **Relancer le build** après rebase (`npm run build`), puisque la base a changé
   sous les pieds du travail en cours.

### 4. Moment : au début du tour, de la propre initiative de l'agent

L'agent rebase **de lui-même** quand on l'informe du retard, sans qu'on le lui
demande, et **avant** de traiter la demande de l'humain.

Rebaser après coup reviendrait à résoudre des conflits sur du code qu'on vient
d'écrire — deux fois plus de surface. Comme le serveur n'informe l'agent que
s'il est réellement en retard, le cas reste rare.

### 5. Prompts — lever l'ambiguïté qui ferait tout échouer

Deux textes vont faire refuser le rebase s'ils restent en l'état :

- `context/pilot-prompt.md` : « never merge into the main checkout or another
  worktree ».
- Le rôle Shadok-dev (`src/profiles.ts`) : « never merge into main yourself ».

Les deux parlent de pousser **vers** main. Un agent va sur-lire et refuser
l'inverse — tirer main **dans** sa branche. Il faut l'autoriser explicitement.

À noter aussi : `Bash(git rebase:*)` est dans `READONLY_DENY`
(`src/profiles.ts`). C'est correct et à conserver — les profils marketing et
support ne doivent pas rebaser.

## Questions ouvertes

Posées, non tranchées au moment du report :

1. **Le « début du tour » est-il acceptable ?** Il peut retarder de plusieurs
   minutes une demande urgente. Alternative : ne rebaser qu'à la demande, ou
   seulement au-delà d'un seuil de retard.
2. **Le serveur doit-il `git fetch origin` de lui-même**, ou se contenter du
   `main` local tel qu'il est sur disque ? Le local suffit si l'humain pull ses
   PR ; sinon le retard est sous-estimé.

## Critères de réussite

1. Le panneau diff d'un agent qui a rebasé montre uniquement son travail, pas
   celui de main.
2. Idem pour un agent qui n'a pas rebasé et dont la base a plusieurs jours
   (le fix merge-base vaut indépendamment).
3. Un agent en retard reçoit l'information dans son prompt, sans polling.
4. Un agent avec du travail non committé qui rebase ne perd rien : le WIP est
   visible dans le panneau diff avant comme après.
5. Un rebase en conflit non résoluble laisse le worktree **exactement** dans son
   état d'avant et remonte la question à l'humain.
6. Un profil read-only (marketing/support) ne peut toujours pas rebaser.
7. `npm run build` OK, vérifié **sur un port libre à côté** (jamais en reprenant
   3789 — invariant 8 ; cf. « Running YOUR build » dans `CLAUDE.md`), dans le
   navigateur.

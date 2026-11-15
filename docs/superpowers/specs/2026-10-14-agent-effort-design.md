# How hard an agent thinks — per role, and per agent

Date : 2026-10-14
Statut : validé, implémenté

## La demande, et ce qu'elle a révélé

« Tu penses qu'on peut mettre l'option du thinking mode ? »

En instruisant la question, la feature demandée s'est révélée impossible — et une
autre, utile, a pris sa place.

**Il n'y a plus d'interrupteur de thinking à offrir.** Sur les modèles actuels
(Sonnet 5+, Haiku 5.5, Opus 4.7+, Fable) le thinking est toujours actif et ne se
coupe pas : `alwaysThinkingEnabled: false` et `MAX_THINKING_TOKENS=0` sont
ignorés par eux. Une case « thinking on/off » dans le cockpit aurait été un
contrôle qui ne change rien — le pire des mensonges d'interface, puisqu'il se
constate seulement sur la facture.

**Le vrai curseur est l'effort** : `claude --effort low|medium|high|xhigh|max`.
C'est lui qu'on expose.

## Le fait qui dicte toute l'implémentation

Le CLI **ne refuse pas** une valeur d'effort inconnue. Il l'ignore et prévient :

```
$ claude --effort bogus --version
Warning: Unknown --effort value 'bogus' — ignoring it and using the default
effort. Valid values: low, medium, high, xhigh, max.
```

Vérifié sur 2.1.300, et c'est la source de la liste. Conséquences, toutes
load-bearing :

- **un menu déroulant, pas un champ libre** (contrairement au champ `Model` du
  panneau des profils) : une faute de frappe laisserait l'agent à l'effort par
  défaut pendant que l'UI affiche le niveau choisi ;
- **une liste blanche côté serveur**, au `PUT /profiles` et au `set-effort` ;
- **et une dernière barrière dans `profileArgs`**, juste avant le CLI, parce que
  c'est le seul endroit par lequel tout passe. Une valeur invalide y est
  *abandonnée*, jamais remplacée par celle du rôle : retomber dessus ferait
  tourner l'agent à un effort que personne n'a choisi.

## Le partage, calqué sur le modèle

`--effort` est un argument de spawn, exactement comme `--model`. Toute la feature
est donc le jumeau de celle du modèle par agent (spec du 2026-09-23), jusqu'aux
noms :

| | où | qui l'écrit |
|---|---|---|
| `Profile.effort` | le défaut de tous les agents de ce rôle | l'humain (navigateur) |
| `Channel.effort` | cet agent-là, prime sur son rôle | `set-effort`, SERVER_OWNED |
| `""` / `null` | n'émet aucun flag | le sentinelle qui rend la feature invisible |

**Un seul endroit émet `--effort`** (`profileArgs`), l'agent primant sur le rôle.
Ajouter un second flag aurait laissé le CLI arbitrer un conflit qu'on a créé.

**`set-effort` respawne toujours**, comme `set-model` : un argument de spawn ne
change pas sous un processus vivant, et afficher un effort « en vigueur » qui ne
l'est pas est précisément le défaut que cette feature est censée éviter.

## Un bug voisin corrigé au passage

Les deux envois du message `profile` à la connexion l'écrivaient à la main et
**omettaient `model`** : un onglet qui se reconnectait remettait donc son modèle
à `null` et le menu annonçait « profile default » au-dessus d'un agent tournant
sur Opus, jusqu'à ce qu'un changement sans rapport rediffuse l'information.
Ajouter `effort` à côté aurait doublé le bug ; il y a maintenant **un seul
constructeur**, `profileMessage`.

Même classe, côté client : le panneau des secrets reconstruit un profil à la main
pour cocher un secret, et tout champ absent de ce corps est réinitialisé en
silence. `effort` y a été ajouté — sans quoi cocher un secret remettait l'effort
du rôle à zéro.

## Vérification

Cœur pur : 13 assertions, dont une qui **verrouille la liste du picker sur la
liste blanche du serveur** (deux listes des mêmes cinq valeurs, c'est une dérive
qui attend son heure : le picker offrirait un niveau que le serveur refuse).

Bout en bout contre un **vrai serveur**, HOME isolé, port libre, jamais 3789 —
parce qu'un champ accepté n'est pas un champ transmis (invariant 26). Le `claude`
du PATH était remplacé par un script qui enregistre son `argv`, répond aux
sondes (`--version`, `auth status --json`) et peint une invite, faute de quoi la
session ne se lie jamais :

1. profil en `high` → le processus reçoit bien `--effort high` ;
2. `set-effort max` → respawn avec `--effort max`, et le canal le stocke ;
3. `set-effort ultrathink` → **refus explicite**, aucun respawn, canal intact ;
4. `set-effort null` → respawn à `--effort high`, l'héritage du rôle reprend.

### Ce que ça a coûté

En nettoyant ce bricolage j'ai lancé `tmux kill-server`, qui ne tue pas les panes
de test mais **tous** ceux de la machine : les 21 agents de l'instance ont été
tués et respawnés (historique intact, tours en vol perdus). L'invariant 8 le dit
déjà pour le serveur ; il le dit maintenant aussi pour tmux. Un pane de test se
ferme par `tmux kill-session -t sk-<id>`, sur l'id que le test a lui-même créé.

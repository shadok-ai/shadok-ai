# Un secret n'atteint un agent que via un profil

Date : 2026-08-01
Statut : validé, implémenté

## Le symptôme

« Les agents ont du mal à trouver les variables d'environnement. »

## Ce que le diagnostic a montré

Mesuré sur l'installation réelle, pas déduit :

1. **Le mécanisme d'injection fonctionne.** `TmuxPilot` préfixe la commande par
   `env KEY=VALUE …` ; sur un agent de prod vivant, `SHADOK_PORT` et
   `SHADOK_SESSION_ID` sont bien présents dans l'environnement du process.
2. **Mais rien de réel n'est injecté.** Le vault contenait 5 secrets et
   **aucun profil n'en référençait un seul** (`secrets: []` partout).
   `secretsFor(profile?.secrets)` n'injecte que ce qu'un profil référence : les
   agents n'avaient donc, littéralement, aucun secret. Rien dans l'UI ne disait
   qu'un secret défini ne sert à rien tant qu'il n'est pas accroché.
3. **Et le preprompt mentait.** `makePilot` appelait
   `envVarsNote(Object.keys(env))` **après** avoir ajouté la tuyauterie interne.
   La note reçue par un agent de prod était donc :

   > `Secrets available to you as environment variables: SHADOK_SESSION_ID, SHADOK_PORT`

   La plomberie était annoncée comme des secrets à ne jamais afficher, et un
   vrai secret s'y serait retrouvé noyé.

4. **Le reload fonctionne** (question posée en même temps) : le pid du process
   claude change à chaque redémarrage — vérifié trois fois de suite. Une
   première sonde disait le contraire : c'était un artefact, `ps` tronque les
   arguments à 120 caractères sur macOS. La commande de démarrage du pane tmux
   (`#{pane_start_command}`) donne la ligne complète.

## Les correctifs

### 1. La note ne parle que des vrais secrets

`makePilot` sépare `secretEnv` (les secrets du vault résolus) de l'env complet,
et n'annonce que le premier. Les noms sont ceux **résolus** : un profil qui
référence un secret absent du vault ne fait plus promettre à l'agent une
variable qui n'existe pas. Aucun secret attaché → **aucune note**, plutôt qu'une
note trompeuse. Rien ne dépendait de l'annonce des `SHADOK_*` : les skills lisent
`process.env.SHADOK_PORT` dans leur code.

### 2. Une note actionnable

L'ancienne formulation (« Read them from the environment ») laissait l'agent
partir chercher un fichier à charger, puis conclure que le secret manquait. La
nouvelle coupe court : les variables sont **déjà posées** dans chaque commande
du Bash tool, il n'y a **pas de `.env`** à charger ni rien à sourcer ; un exemple
d'usage ; et le test de présence qui ne révèle pas la valeur
(`[ -n "$NAME" ] && echo set`).

### 3. La popin Secrets dit à quoi ça sert

Un paragraphe en teinte alerte : un secret n'atteint aucun agent tout seul, il
faut le cocher dans un profil. Plus un bouton **« Manage profiles → »** qui
ferme les secrets et ouvre le panneau Profiles — le chaînon manquait.

### 4. Chaque secret orphelin le dit lui-même

Un blurb se lit une fois puis devient du décor. Chaque ligne de secret que
**aucun** profil ne référence porte donc `⚠ no profile uses it`. Sur
l'installation de référence, les cinq s'allument — c'est exactement le problème.
`profileCache` est rechargé à l'ouverture de la popin pour que le diagnostic ne
soit jamais périmé.

## Tests

- `profiles.test.ts` : la note dit « already set », cite le Bash tool, mentionne
  `.env`, et fournit le test de présence.
- Bout en bout au navigateur : un secret et un profil de test créés, un agent
  réel lancé, la note lue dans la commande de démarrage du pane tmux — elle ne
  contient que le secret, pas les `SHADOK_*` — et la valeur du secret est bien
  dans l'environnement du process. Secret et profil de test supprimés ensuite,
  vault et profils revérifiés identiques.
- Popin vérifiée au navigateur : blurb, lien qui ouvre bien les profils, et les
  cinq avertissements d'orphelin.

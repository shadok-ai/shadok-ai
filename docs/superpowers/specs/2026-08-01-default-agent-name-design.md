# Un nom par défaut à la création d'un agent

Date : 2026-08-01
Statut : validé, implémenté

## Problème

Le nom par défaut d'un agent est `basename(cwd)` (`launchTab`). Tous les agents
lancés sur le même dépôt s'appellent donc **pareil** — une colonne entière
d'onglets « shadok-ai » qu'on ne distingue qu'en les ouvrant. Il fallait
renommer chaque agent à la main, après coup, par un double-clic.

## Design

### Un champ `Name` dans la popin de création

Placé entre la grille de profils et le dossier : **qui** est cet agent, **comment
on l'appelle**, puis **où** il travaille. Pré-rempli avec le défaut calculé et
modifiable — on nomme au moment où on sait ce que l'agent va faire.

### Le défaut, c'est le nom du profil

`defaultAgentName(profileName, cwd)` (pur, dans `public/profile-card.js`) :

1. le **profil** s'il y en a un — c'est ce qui distingue deux agents sur le même
   dépôt ;
2. sinon le **nom du dossier** (le comportement actuel) ;
3. sinon `"agent"` — jamais une chaîne vide, un onglet sans nom est illisible.

**Pas de suffixe numérique.** Deux agents du même profil porteront donc le même
nom par défaut ; le champ étant modifiable au lancement, on les distingue sur
place. C'est un choix explicite de simplicité, réversible si la gêne apparaît.

### Quand le défaut est reproposé

Même règle que la mémoire du profil : **à l'ouverture** de la popin, à chaque
**changement de carte de profil** (sinon on lancerait un « Shadok-dev » qui
tourne en réalité sur Shadok-Support), et au **changement de dossier** (sans
profil, le défaut EST le dossier).

Jamais si l'utilisateur a tapé le sien (`nameTouched`). **Vider le champ rend la
main au défaut** — la façon la plus simple de revenir en arrière, sans bouton
dédié.

### Application au lancement

Le nom est posé sur l'onglet **avant** `launchTab`, qui sinon l'écraserait avec
`basename(cwd)`, et `customName = true` le protège aussi du `ready` et de la
restauration des canaux.

## Tests

- `profile-card.test.ts` : profil prioritaire, repli sur le dossier (avec ou
  sans slash final), repli final sur `"agent"`, espaces ignorés.
- Au navigateur : sans profil → `shadok-ai` ; `Shadok-dev` → `Shadok-dev` ;
  changement de carte → le défaut suit ; saisie manuelle jamais écrasée ; champ
  vidé → le défaut revient ; et le nom saisi arrive bien sur l'onglet créé.

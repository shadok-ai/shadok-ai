# Onglets déplaçables et groupes d'onglets — design

Date : 2026-07-20
Fichier concerné : `public/index.html` (toute l'UI vit là).

## Objectif

Dans la sidebar « Channels » :
1. Réordonner les onglets (canaux) par drag & drop.
2. Créer des groupes nommés, y glisser des onglets, les renommer, les replier.
3. Réordonner les groupes eux-mêmes par drag & drop de leur en-tête.

Décisions utilisateur : création via bouton « + new group », groupes
repliables, groupes réordonnables.

## Structure DOM

```
nav#tabbar
  .label.side-label            (inchangé)
  div#ungrouped                ← onglets hors groupe
  div#groups                   ← un div.group par groupe
    div.group[data-gid]
      div.group-head           (draggable, clic = repli, dblclic = renommer, × = dissoudre)
        span.caret  span.gname  span.gclose
      div.group-body           ← onglets du groupe (masqué si replié)
  button#newTab                (inchangé)
  button#newGroup              « + new group »
```

`createTab()` ajoute l'onglet dans `#ungrouped` par défaut (ou dans le
groupe indiqué lors d'une restauration).

## Drag & drop

HTML5 natif (`draggable`), pattern « live sort » : pendant le `dragover`,
l'élément traîné est déplacé directement dans le DOM (pas d'indicateur
séparé).

- Onglet traîné : au-dessus d'un autre onglet → inséré avant/après selon la
  moitié verticale ; au-dessus d'un en-tête de groupe → ajouté au groupe
  (le groupe replié se déplie automatiquement) ; au-dessus d'une zone vide
  (`#ungrouped` ou `.group-body` vide) → ajouté à cette zone.
- Groupe traîné (par son en-tête) : au-dessus d'un autre groupe → inséré
  avant/après.
- Pendant un drag, les zones vides deviennent visibles (pointillés,
  min-height) via une classe sur `body`.
- `dragend` persiste toujours (le `drop` peut ne pas être déclenché).
- Le `draggable` est désactivé pendant le renommage inline (sinon la
  sélection de texte déclenche un drag).

## Persistance (localStorage, comme l'existant)

- `cp.groups` : `[{ id, name, collapsed }]` dans l'ordre DOM.
- `cp.channels` : chaque entrée gagne `group: <id|null>` ; l'ordre de la
  liste = l'ordre DOM des onglets (source de vérité relevée au moment de la
  persistance, pas maintenue dans le tableau `tabs`).

Au chargement : recréer les groupes, puis les canaux dans leur groupe
(groupe disparu → `#ungrouped`). Les groupes vides sont conservés.

## Comportements annexes

- Dissoudre un groupe (×) : ses onglets sont déplacés dans `#ungrouped`,
  le groupe est supprimé (aucune session n'est fermée).
- Replier : masque `.group-body` ; l'onglet actif peut être masqué, le
  transcript reste affiché.
- Renommage de groupe : même pattern inline que le renommage d'onglet.

## Hors périmètre

Pas de couleur de groupe, pas de menu contextuel, pas de synchro
serveur (persistance purement locale, comme les noms de canaux).

## Vérification

Pas d'infra de test dans le projet (`npm test` = placeholder). Vérification
manuelle : `npm run build && npm run web`, puis dans le navigateur —
réordonner, créer/renommer/replier/dissoudre/réordonner des groupes,
recharger la page et vérifier la restauration.

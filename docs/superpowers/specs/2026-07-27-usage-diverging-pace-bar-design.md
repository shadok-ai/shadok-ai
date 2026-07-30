# Design — Barre de pace divergente (jauges d'usage 5h / 7d)

Date : 2026-07-27
Statut : validé (brainstorming)

## Problème

Les jauges d'usage dans le header affichent aujourd'hui, pour chaque fenêtre
(5h et 7d), **deux barres empilées de 3px** : l'usage réel et le pace idéal
(fraction de la fenêtre écoulée). L'utilisateur lit la relation entre les deux
(barre d'usage plus longue que la barre de pace = on dépense plus vite que le
temps) — mais c'est indirect : il faut comparer deux longueurs.

On veut remplacer, pour chaque fenêtre, ces deux barres par **une seule barre
divergente** qui matérialise directement le ratio usage/pace.

## Portée

- **Frontend uniquement** (`public/index.html`) : le CSS des jauges `.quota` et
  la fonction JS `paintGauge`.
- **Aucun changement serveur.** Les données nécessaires sont déjà servies par
  `/usage` : chaque fenêtre expose `usedPercentage`, `idealPacePct`,
  `ratioPct`, `resetsAt`. `ratioPct` = `usedPercentage / idealPacePct * 100`.

Hors périmètre : la logique de pace guard (`src/pace.ts`), le calcul du ratio,
les endpoints, le comportement Telegram.

## Design

### Concept : barre divergente centrée sur « au pace »

Pour chaque fenêtre, une barre horizontale unique.

- **Le centre** de la barre = ratio 100 % (usage exactement au rythme du temps
  écoulé). Un tick discret marque ce point.
- Le remplissage **part du centre** :
  - vers la **gauche** quand `ratioPct < 100` (sous le pace, on a de la marge) ;
  - vers la **droite** quand `ratioPct > 100` (au-dessus du pace, on brûle trop
    vite).
- **Échelle symétrique linéaire.** On mappe le ratio sur une position
  `pos ∈ [-1, +1]` :

  ```
  pos = clamp((ratioPct - 100) / 100, -1, +1)
  ```

  Donc : bord gauche = ratio 0 % ; centre = ratio 100 % ; bord droit =
  ratio ≥ 200 % (épinglé). Ratio 50 % → mi-chemin à gauche ; ratio 150 % →
  mi-chemin à droite. La longueur du remplissage = `|pos|` × demi-largeur.

### Couleur : dégradé vert → ambre → rouge

La couleur du remplissage suit le ratio de façon continue :

- ratio bas (loin à gauche) → **vert franc** (`--ok`) : large marge ;
- ratio approchant 100 % (près du centre, des deux côtés) → **ambre**
  (`--amber`) : avertissement, on arrive au pace ;
- ratio au-dessus, vers le bord droit → **rouge** (`--err`) : on dépasse.

L'ambre garde ainsi le rôle d'alerte de la version actuelle (le seuil `warn`
commençait à ratio 70), tout en restant du côté gauche/vert tant qu'on est sous
le pace. Implémentation : interpolation entre les variables CSS existantes
(`--ok`, `--amber`, `--err`) via `color-mix`, ou couleur calculée en JS. La
teinte est fonction du ratio, indépendante de la longueur du remplissage.

Le rendu doit rester lisible en thème clair **et** sombre (les variables
`--ok/--amber/--err` sont déjà theme-aware). Vert/rouge seuls ne suffisent pas à
distinguer l'état pour un daltonien : la **position** gauche/droite par rapport
au centre porte l'information redondante (position + couleur), ce qui satisfait
l'accessibilité.

### Chiffre compact + tooltip

- On conserve le label `5h` / `7d` et un **petit chiffre compact** à côté de la
  barre : le `% utilisé` (comme aujourd'hui), pour le coup d'œil.
- **Tooltip** (`title`) au survol, avec les valeurs précises — déjà produit par
  `paintGauge` aujourd'hui, on le garde :
  `<fenêtre> — X% utilisé · pace idéal Y% · ratio Z% · reset dans …`.

### État « pas de données »

Quand la fenêtre est `null` (token absent, fetch échoué), la barre est vide
(pos = 0, aucun remplissage), le chiffre affiche `—`, tooltip = libellé de base.
Comportement identique à l'actuel.

## Composants touchés

| Élément | Changement |
|---|---|
| CSS `.quota .meter` (2 barres empilées) | remplacé par **une** barre divergente : track avec tick central, fill positionné en absolu depuis le centre (left/right). |
| CSS `.quota.warn/.crit .fill` | supprimé (la couleur devient continue, calculée). |
| HTML `#quota5h` / `#quota7d` | un seul `.meter` au lieu de deux (`usage` + `pace`). |
| JS `paintGauge(el, w)` | calcule `pos` depuis `ratioPct`, positionne le fill depuis le centre, applique la couleur interpolée, garde le chiffre `%used` et le tooltip. |

## Critères de réussite

1. Chaque fenêtre (5h, 7d) affiche **une** barre divergente centrée.
2. Sous le pace → remplissage vert à gauche ; au-dessus → rouge à droite ;
   près du pace → ambre. Transition continue.
3. Un tick central « au pace » est visible.
4. Le tooltip donne usage / pace idéal / ratio / reset précis.
5. Lisible en thème clair et sombre.
6. `null` → barre vide, `—`. Pas de régression.
7. `npm run build` OK (aucun changement TS, mais on vérifie), rendu vérifié
   dans le navigateur après restart.
```

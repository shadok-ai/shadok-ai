# Clignotement des notifications + mute par canal

**Date :** 2026-07-29
**État :** validé, à implémenter

## Le problème

Depuis `666a62b` le cockpit signale déjà qu'un canal réclame l'attention : un pip
coloré sur le favicon, un préfixe `●` dans le titre, et un son quand un agent se
bloque sur une question. Le signal est **statique**. Dans une fenêtre chargée de
vingt onglets, un pip immobile de 7 px sur une icône de 16 px passe inaperçu :
l'agent attend, et personne ne vient.

Symétriquement, il n'y a aucun moyen de faire taire **un** canal. Un agent qui
pose des questions en boucle, ou un cron bavard, pollue le signal global — et le
seul recours aujourd'hui est le bouton 🔔 du header, qui coupe le son de tout le
monde et ne touche ni le pip ni le titre.

## Ce qu'on construit

1. Le badge d'attention **clignote** quand quelque chose demande vraiment une
   action, et seulement dans ce cas.
2. Chaque canal peut être **muté** individuellement, de façon persistante.
3. Un **menu contextuel** sur l'onglet, qui héberge le mute et deux actions déjà
   existantes.

## A. Le clignotement

### Condition de déclenchement

> **Corrigé le 2026-07-30.** La v1 lisait `document.hidden` seul, et ne
> clignotait donc **jamais** dans l'usage réel : `document.hidden` reste faux
> tant que la fenêtre est affichée, même si une autre application a le focus —
> or c'est exactement le mode d'usage du cockpit (fenêtre ouverte sur un écran,
> utilisateur dans son terminal). Le déclencheur est désormais `away =
> document.hidden || !document.hasFocus()`, un sur-ensemble. Vérifié au
> navigateur, pas seulement en tests unitaires.

Le badge clignote si et seulement si :

- **tu n'es pas sur la page** — onglet caché, fenêtre minimisée, ou fenêtre
  visible mais sans le focus ;
- **et** au moins un canal **non muté** est en `needs-answer`.

Une réponse non lue (`unread`) ne clignote pas : elle garde le pip ambre fixe.
Le clignotement veut dire « il faut faire quelque chose », pas « il s'est passé
quelque chose ».

### Ce qui clignote

Le pip du favicon **et** le préfixe du titre, sur le même tick (~900 ms). Le
favicon compte au moins autant que le titre : un onglet en arrière-plan dans une
fenêtre chargée est réduit à son icône, le titre n'est plus lisible.

### Les deux phases restent visibles

L'alternance ne va **pas** de « badge » à « rien ». Elle va d'un état visible à
un autre :

| Phase | Pip favicon | Titre |
|---|---|---|
| haute | `#e07a6a` (rouge vif) | `● ` |
| basse | `#8a4034` (rouge sombre) | `◉ ` |

**Pourquoi :** Chrome étrangle les timers d'un onglet caché — clamp à 1 s, puis
*intensive throttling* jusqu'à un réveil par minute après ~5 min. Avec un on/off,
un timer gelé sur la phase « off » laisserait la page parfaitement calme alors
qu'un agent attend : le signal disparaîtrait exactement dans le cas où on en a le
plus besoin. Avec deux phases visibles, le pire cas est un clignotement lent.
Cette dégradation doit être vérifiée dans un vrai navigateur, pas déduite.

### Cycle de vie du timer

Aucun timer ne tourne quand rien ne clignote. `refreshBadge()` démarre ou arrête
la boucle selon la condition ci-dessus ; un écouteur `visibilitychange` la
réévalue. Le retour sur l'onglet arrête le clignotement immédiatement et
restaure le badge statique — pas au prochain tick.

## B. Le mute par canal

### État et persistance

Un booléen `muted` porté par l'onglet côté client, persisté dans le registre
serveur via le champ `Channel.muted` (`src/channels.ts`). C'est un champ **piloté
par le client**, comme `name` et `group` : il ne rejoint donc **pas**
`SERVER_OWNED`, et un PUT du navigateur fait autorité dessus. Conséquence
voulue : le mute survit au reload et suit les autres appareils.

### Effet

- `attentionColor()` ignore les canaux mutés → ni pip, ni `●`, ni clignotement.
- Le `ding()` déclenché depuis `setTabMood` est sauté pour un canal muté.
- L'onglet **garde** sa propre couleur d'état (`working` / `needs-answer` /
  `unread`) : muter coupe les signaux globaux, ça ne rend pas le canal invisible.
- Un 🔕 discret s'affiche à côté du nom d'un canal muté, pour que le silence soit
  explicable plutôt que suspect.

## C. Le menu contextuel

Clic droit sur un onglet → petit menu flottant positionné au curseur, calqué sur
`#verMenu` : même style, même logique de fermeture (clic ailleurs, Échap, ou
choix d'une entrée). Le menu natif du navigateur est supprimé sur l'onglet
uniquement.

Entrées de la v1 :

| Entrée | Comportement |
|---|---|
| 🔕 Muter / 🔔 Réactiver | bascule `muted`, persiste, rafraîchit le badge |
| Renommer | réutilise `inlineRename` (le double-clic existant reste) |
| Fermer l'agent | l'action du ✕ existant ; absente sur `general` |

Le menu est l'endroit où rangeront les prochaines actions par canal — c'est la
moitié de sa valeur.

## D. Découpage et tests

La décision de notification est extraite en module pur `public/notify.js` :

```js
notifyState(channels, { hidden, phase }) → { color, badge, blink }
```

`channels` est une liste de `{ mood, muted }` — le module ne connaît ni le DOM ni
les onglets. Il est chargé par le navigateur **et** importé par
`test/notify.test.ts`, exactement comme `live-text.js` et `profile-card.js`.

Cas couverts par les tests :

- un canal `needs-answer` non muté, onglet caché → `blink: true`, rouge ;
- le même, onglet visible → `blink: false`, rouge fixe ;
- le même, **muté** → pas de couleur, pas de clignotement ;
- `unread` seul → ambre, jamais de clignotement ;
- `needs-answer` muté + `unread` non muté → ambre fixe (le muté ne remonte pas) ;
- tous mutés → `color: null` ;
- les deux phases renvoient une couleur non nulle quand `blink` est vrai (c'est
  l'invariant qui protège du timer étranglé).

**Gotcha #10 du CLAUDE.md :** le `<script type="module">` qui expose la fonction
sur `window` s'exécute après le parse du document, alors que le script classique
tourne pendant. Tout appel au chargement doit attendre `DOMContentLoaded` ou se
garder sur `window.notifyState` — sinon l'échec est silencieux.

## Hors périmètre

- Les notifications système (`Notification` API) : le badge + le son suffisent
  pour l'instant, et la permission navigateur est un sujet à part.
- Le mute côté Telegram : le bridge a ses propres règles de silence.
- Un mute temporaire (« pendant 1 h ») : à envisager seulement si le mute
  permanent se révèle trop grossier à l'usage.

# Live-preview du texte assistant (streaming token-par-token côté web)

## Problème

Le client web affiche le texte assistant en le lisant depuis le transcript
`.jsonl` (via le tail — source fiable, non tronquée). Or **Claude Code n'écrit
un bloc de texte dans le `.jsonl` que lorsqu'il est entièrement terminé** — jamais
token par token (vérifié : 0 enregistrement de texte incrémental ; un bloc de
1155 caractères apparaît en un seul saut après ~11 s de génération invisible).

Conséquence : un long paragraphe reste invisible pendant toute sa génération,
puis surgit d'un coup. Les outils *semblent* streamer parce que (a) ce sont de
petits blocs fréquents et surtout (b) l'engine-room affiche l'écran TUI brut du
PTY, mis à jour en direct — indépendamment du fichier. D'où le ressenti « tout
ce que tu écris, on le voit qu'à la fin ».

Ce n'est pas une régression du code shadok-ai (le handler de streaming est
inchangé depuis le commit initial) : c'est inhérent au fait de sourcer le texte
depuis un transcript écrit au bloc.

## Objectif

Donner un **aperçu live best-effort** du bloc de texte en cours de génération,
puis le **remplacer** par la version faisant autorité (markdown propre) dès que
le bloc complet atterrit dans le `.jsonl`. On garde le live *et* la correction :
aucune troncature durable.

Non-objectifs : reconstituer le markdown source depuis l'écran ; toucher au
serveur ou au protocole ; garantir un rendu parfait du provisoire.

## Contraintes / décisions

- **100 % client** (`public/index.html`). Zéro changement serveur, aucun risque
  sur les invariants fragiles. La seule source token-granulaire est l'écran PTY,
  déjà diffusé via les messages `screen` (~3×/s, sur changement) et déjà stocké
  dans `t.screenText`.
- **Fidélité best-effort assumée** : le provisoire est le texte brut de l'écran
  (wrappé, pseudo-ASCII, potentiellement tronqué), affiché grisé, sans markdown.
  Il n'est jamais persistant.
- **Dégradation gracieuse** : si l'extraction échoue (nouveau TUI, marqueur
  changé), on n'affiche pas de provisoire → on retombe exactement sur le
  comportement actuel (texte au bloc). Jamais pire qu'aujourd'hui.

## Architecture (flux)

Rien ne change côté serveur. Tout vit dans le client :

1. Le serveur diffuse déjà `screen` (texte de l'écran TUI complet) sur chaque
   changement, ~toutes les 300 ms pendant un tour.
2. Le client, pendant un tour actif, extrait de l'écran le bloc de texte en
   cours et l'affiche dans une **bulle provisoire** qui se met à jour en place.
3. Quand `stream-text` (bloc autoritatif complet) arrive, la bulle provisoire
   est **remplacée** par le rendu markdown habituel (`addTurn(..., "live")`).
4. À `turn-done`, toute bulle provisoire résiduelle est jetée.

## Composants

### 1. `extractLiveText(screen) -> string` (pure, testable)

Structure régulière du TUI observée :
- Un bloc de texte assistant = une ligne `⏺ <texte>` (marqueur U+23FA en
  colonne 0) + lignes de continuation indentées de 2 espaces.
- Les outils rendent `  Ran … command` / des boîtes ; le prompt echo est `❯ …`.
- Fin de la sortie assistant = la ligne spinner : en cours
  `✽ … (Xs · esc to interrupt)` ou variantes, fini `✻ Brewed for 10s`.
  On réutilise la logique de détection existante (`SPINNER_STATUS` /
  `ESC_TO_INTERRUPT` de `detect.ts`, portée en JS dans le client).
- Puis séparateur `────`, box de saisie `❯`, footer (`… ctx:NN% …`).

Algorithme :
1. Tronquer le bas de l'écran : couper à partir du dernier bloc
   séparateur/box-de-saisie/footer (tout ce qui suit la sortie assistant).
2. Localiser la ligne spinner → borne de fin de la sortie assistant.
3. Remonter jusqu'au **dernier** marqueur `⏺ ` au-dessus du spinner ; prendre
   cette ligne + ses lignes de continuation indentées.
4. Dé-wrapper : rejoindre le marqueur et les continuations en retirant
   l'indentation, produire un texte lisible.
5. Renvoyer `""` si : pas de `⏺` trouvé, ou le dernier `⏺` est manifestement un
   outil (heuristique simple), ou résultat vide → pas de preview.

Cette fonction est le seul point fragile ; elle est isolée et testée
unitairement contre des fixtures d'écran.

### 2. Cycle de vie de la bulle provisoire (par onglet `tab`)

État ajouté sur `tab` : `tab.livePreviewEl` (l'élément DOM provisoire ou null).

- **`working`** : `tab.livePreviewEl = null` (nouveau tour, rien encore).
- **`screen`** (pendant busy) : `const txt = extractLiveText(msg.text)`.
  Si `txt` non vide : créer (si absent) une bulle
  `.turn.claude.live-preview` (grisée, `textContent = txt`, pas de markdown),
  la garder en bas du transcript et scroller ; sinon mettre à jour son texte.
  Si `txt` vide et une bulle existe : la laisser telle quelle (ne pas effacer un
  provisoire déjà affiché sur un simple trou d'extraction).
- **`stream-text`** : retirer `tab.livePreviewEl` (s'il existe), le mettre à
  null, puis exécuter le `addTurn(t, "claude", "claude", msg.text, "live")`
  markdown habituel. Le bloc autoritatif prend la place 1-pour-1.
- **`turn-done`** : retirer toute `tab.livePreviewEl` résiduelle et la mettre à
  null (cas où le tour se termine sans stream-text final — ex. dialog).

### 3. Style

`.turn.claude.live-preview .bubble` : même gabarit qu'une bulle claude, mais
grisée (opacity ~0.6) et en police mono/`white-space: pre-wrap` pour refléter
que c'est du brut d'écran, non du markdown. Marqueur visuel discret (curseur
clignotant optionnel) — à ajuster au goût, cosmétique.

## Réconciliation & garanties

Le provisoire est purement transitoire. La garantie clé qui lève le risque du
scraping d'écran : **toute bulle provisoire est soit remplacée par le bloc
`.jsonl` (stream-text), soit jetée (turn-done)** — elle ne survit jamais au
tour. Une extraction fausse ou tronquée est donc corrigée en <1 s.

## Cas limites

- Écran sans texte assistant (que des outils) → `extractLiveText` renvoie `""` →
  pas de provisoire, les outils streament comme aujourd'hui.
- Plusieurs blocs de texte dans un tour → chaque `stream-text` remplace le
  provisoire courant ; le provisoire suivant se recrée sur les `screen` d'après.
- Tour terminé par un dialog (pas de stream-text final) → `turn-done`/`dialog`
  nettoie le provisoire.
- Nouveau TUI / marqueur `⏺` changé → `""` → dégradation vers l'actuel.
- Le provisoire ne doit jamais être compté comme historique ni persisté
  (`persistChannels` / `loadHistory` ne le voient pas — c'est du DOM éphémère).

## Tests

`extractLiveText` étant pure, tests unitaires (node:test) sur des fixtures
d'écran capturées :
- génération mono-bloc en cours (spinner actif) → renvoie le paragraphe courant ;
- multi-bloc avec un `Ran … command` intercalé → renvoie le dernier bloc texte ;
- spinner fini (`✻ Brewed for Xs`) → renvoie le dernier bloc (ou `""`, à figer) ;
- écran sans `⏺` → `""` ;
- écran avec box de saisie remplie + footer → borne basse correctement coupée.

Pas de test d'intégration navigateur : le cycle de vie DOM est simple et la
dégradation garantit qu'un bug d'extraction ne casse rien.

## Portée

Un seul fichier de code (`public/index.html`) + un module/fonction pure testable
(soit inline + un petit test qui l'importe, soit un mini `public/live-text.js`
partagé pour pouvoir l'`import` en test node). Décision d'implémentation : mettre
`extractLiveText` dans un fichier séparé importable pour la testabilité.

## Coordination

⚠️ Un autre canal (`0e330518`) discutait le même sujet et croyait l'agent
`43b478e9` déjà dessus. Vérifier qu'aucun travail parallèle sur `public/index.html`
n'entre en conflit avant de lander (invariant #8). Ce travail se fait dans le
worktree isolé `worktree-live-text-preview`.

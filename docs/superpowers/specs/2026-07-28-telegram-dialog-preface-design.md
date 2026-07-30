# Telegram : le texte qui précède une question doit arriver avant le clavier

**Date :** 2026-07-28
**Statut :** design validé

## Le symptôme

Dans Telegram, quand l'agent écrit un paragraphe puis pose une question
(`AskUserQuestion`), le **clavier inline arrive en premier**. Le paragraphe
n'apparaît qu'*après* la réponse de l'utilisateur — qui choisit donc à
l'aveugle.

## La cause racine

Preuve relevée sur un client WebSocket passif branché sur une session vivante :

```
23:56:36.247  dialog      "Test d'ordre : …"      ← le clavier part tout de suite
23:58:26.403  prompt-echo                          ← l'utilisateur répond (1 min 50 après)
23:58:26.994  stream-text "Observateur en place…"  ← le texte n'arrive QU'ICI
23:58:26.994  stream-tool AskUserQuestion
```

Deux canaux, deux latences :

- **Le contenu** vient du tail du `.jsonl` (`src/tail.ts`). Claude Code n'y écrit
  un message assistant que **terminé**, c'est-à-dire une fois son `tool_use`
  résolu. Or `AskUserQuestion` ne se résout qu'à la réponse de l'utilisateur.
  Le bloc `text` qui précède l'appel est donc structurellement retenu jusque-là.
- **Le dialog** vient de l'écran TUI (`detectDialog`), disponible immédiatement.

Ce n'est donc pas un bug d'ordonnancement dans le bridge : c'est une donnée que
le tail ne peut pas fournir à temps. La même signature se lit ailleurs dans le
log — `stream-tool` et son `stream-result` tombent à la milliseconde près,
parce que le `tool_use` et son résultat sont flushés ensemble.

Le client web ne souffre pas du problème : il a déjà un contournement,
`extractLiveText(screen)` (`public/live-text.js`), qui affiche une bulle grise
provisoire lue sur l'écran. Telegram n'a pas d'équivalent.

Vérification que l'information est bien disponible côté serveur — capture de
l'écran TUI à l'instant précis où le dialog est affiché :

```
⏺ Ce paragraphe est là pour servir de texte-préface au test : une capture de
  l'écran TUI se déclenche dans 25 secondes, …

❯ /login
────────────────────────────────
 ☐ Capture
```

Le texte est bien le dernier bloc `⏺ ` de l'écran, donc `extractLiveText` sait
le récupérer. Le serveur détient l'information au moment exact où il diffuse le
`dialog` ; il ne la transmet simplement pas.

## Un second défaut, révélé par le premier

Dans `src/telegram.ts`, tous les envois sont en *fire-and-forget* : `send(b, …)`
n'est jamais attendu, et chaque appel lance son propre `fetch`. Deux envois
rapprochés ne sont donc pas garantis d'arriver dans l'ordre d'émission — ce qui
peut déjà entrelacer un texte et la ligne d'outil qui le suit.

Conséquence pour ce fix : envoyer la préface « avant » le clavier ne suffirait
pas. Il faut sérialiser les écritures Telegram d'un bridge.

## La solution

### 1. Le serveur joint la préface au `dialog`

`finishTurn` (et `sendPendingDialog`, et les rediffusions après `choose` /
`toggle`) ajoutent au message `dialog` un champ `preface`, extrait de l'écran
avec `extractLiveText` — la fonction que le web utilise déjà.

Champ optionnel : le client web l'ignore et garde sa bulle grise. L'invariant
« le contenu fait autorité depuis le tail » est préservé — la préface est
explicitement **provisoire**, exactement comme la preview web.

### 2. Une file d'envoi série par bridge

Toute écriture Telegram d'un bridge (texte, ligne d'outil, clavier, édition)
passe par une chaîne de promesses propre au bridge. FIFO garanti, sans blocage
entre bridges différents.

Un envoi qui échoue ne doit pas casser la chaîne : la file avale les rejets.

### 3. Telegram envoie la préface, puis l'édite

- À la **création** d'un clavier (pas à ses rafraîchissements multi-select), si
  `preface` est non vide : on l'envoie, on retient son `message_id` et une clé
  de déduplication, puis on envoie le clavier — dans cet ordre, via la file.
- Quand le `stream-text` autoritatif arrive (après la réponse) et correspond à
  la clé retenue : on **édite** le message de préface avec le vrai contenu
  (`editMessageText`), au lieu de poster un second message. Le rendu final
  récupère le Markdown propre. La clé est consommée.

Si le texte autoritatif dépasse une taille de message, le premier morceau
remplace la préface par édition et les suivants sont envoyés à la suite.

### 4. Le matching préface ↔ texte autoritatif

Fonction pure, testable indépendamment :

```
prefaceMatches(preface, authoritative) -> boolean
```

L'écran dé-wrappe : les retours à la ligne du terminal *et* les vrais sauts de
paragraphe deviennent des espaces simples. On normalise donc les deux côtés
(toute suite d'espaces → un espace, trim) et on teste l'inclusion :
`norm(authoritative).includes(norm(preface))`.

L'inclusion — plutôt qu'un simple préfixe — couvre le cas où l'écran a tronqué
le début du bloc par défilement : la préface est alors un fragment interne du
texte autoritatif.

Garde-fou : pas de match sous 12 caractères normalisés, pour éviter qu'une
préface trop courte ne s'apparie à tort.

## Cas dégradés acceptés

| Situation | Comportement |
|---|---|
| Un `tool_use` s'intercale entre le texte et la question | `extractLiveText` renvoie `""` → pas de préface, comportement actuel inchangé |
| Le bloc a défilé hors écran au point d'être méconnaissable | Le texte autoritatif est posté en second message : un doublon, jamais une perte |
| `editMessageText` échoue | Le message de préface reste en place tel quel |

## Hors périmètre

Le texte qui précède un **outil lent** (un build de deux minutes) reste invisible
pendant toute la durée de l'outil : c'est la même cause racine, mais son
traitement demanderait de flusher le texte écran en continu, avec un vrai risque
de doublons faute de remplacement 1-pour-1 dans Telegram. À traiter séparément
si la gêne se confirme.

## Tests

Tests unitaires purs, sans réseau ni Telegram :

- `prefaceMatches` : cas nominal dé-wrappé, préface tronquée par défilement,
  texte sans rapport, préface trop courte, chaînes vides.
- La file série : des opérations dont la latence est décroissante se terminent
  malgré tout dans l'ordre d'émission ; un rejet ne bloque pas les suivantes.
- `extractLiveText` sur l'écran de dialog réel capturé ci-dessus (un cas de plus
  dans `test/live-text.test.ts`) : le paragraphe est bien retrouvé alors que le
  clavier occupe le bas de l'écran.

Vérification finale en conditions réelles : `npm run build`, redémarrage du
serveur dans son tmux, puis une vraie question posée depuis une session pilotée
— le paragraphe doit précéder le clavier dans Telegram.

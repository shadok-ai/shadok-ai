# Telegram : afficher ou non les tools, par canal

*2026-07-28*

## Le problème

Chaque `stream-tool` reçu par le pont Telegram est posté tel quel
(`src/telegram.ts`, `case "stream-tool"`). Sur un tour un peu long ça noie la
réponse de l'agent sous des dizaines de lignes `→ Read …`, et c'est illisible
sur téléphone. À l'inverse, sur un canal qu'on surveille, voir les outils est
exactement ce qu'on veut.

Le choix appartient au canal, pas au produit : il faut un interrupteur **par
canal Telegram**.

## Le comportement visé

- Par défaut, un canal **n'affiche pas** les tools : seul le texte de l'agent
  est posté. C'est un changement du comportement actuel, assumé — le défaut
  bruyant était le mauvais.
- `/tools` **bascule** l'état et répond le nouvel état. Un tap depuis le
  téléphone, pas d'argument à taper.
- `/tools on` / `/tools off` forcent l'état explicitement (idempotent).
- Le réglage vaut pour le **topic** (ou le DM), et survit à `/new`, `/end` et
  au redémarrage du serveur.
- Le cockpit web ne change pas : il continue d'afficher les tools. Le réglage
  ne concerne que le rendu Telegram.

## Architecture

### Le store (`src/channels.ts`)

`channels.ts` héberge déjà les petits stores Telegram par répertoire de
lancement (`telegram-group`, `telegram-topics`), écrits par `writeJson`. On en
ajoute un quatrième, `…-telegram-tools.json` : la **liste des canaux où les
tools sont affichés**.

```ts
export function loadTgToolKeys(): string[];
export function tgToolsEnabled(key: string): boolean;
export function setTgTools(key: string, on: boolean): void;
```

La clé est le `bindKey(chat, threadId)` déjà utilisé pour indexer les ponts
(`private:<id>`, `group:<id>`, `topic:<id>:<thread>`).

Une *allowlist* plutôt qu'une map `clé → booléen` : le défaut (off) ne coûte
aucune entrée, le fichier reste lisible à l'œil, et un fichier absent ou
corrompu se dégrade exactement en « tout est off » — le défaut voulu.

Les ids de thread Telegram sont des ids de message : jamais réutilisés. Une clé
laissée derrière un topic supprimé ne peut donc pas ressusciter sur un autre
canal. Pas de purge — volontairement hors scope.

### Le pont (`src/telegram.ts`)

`Bridge` gagne `showTools: boolean`, initialisé dans `openBridge` depuis le
store. Un seul point de sortie change :

```ts
case "stream-tool":
  if (b.showTools) send(b, "→ " + m.name + (m.summary ? "  " + m.summary : ""));
  break;
```

Rien d'autre dans la boucle d'événements ne bouge. Le champ est lu sur le pont
(et pas relu dans le store à chaque événement) pour ne pas toucher le disque
des dizaines de fois par tour.

### La commande

`/tools` rejoint le `switch` des commandes de `handleMessage` :

1. résoudre l'état voulu — `on`/`off` explicite, sinon la bascule de l'état
   courant lu dans le store ;
2. `setTgTools(key, next)` ;
3. propager au pont vivant s'il y en a un — via `bridges.get(key)`, **jamais**
   `bridgeFor` : taper `/tools` ne doit pas faire naître une session (même
   précaution que `/stop`) ;
4. répondre l'état.

`parseCommand` est déjà générique (`/tools on` → `{cmd:"tools", arg:"on"}`) :
rien à changer côté parsing. La ligne est ajoutée au texte de `/help`.

Un argument qui n'est ni `on` ni `off` (`/tools yes`) est traité comme une
bascule — la commande ne doit pas se transformer en énigme de syntaxe.

## Tests

- `test/channels.test.ts` : les helpers du store — un canal absent est off, un
  `setTgTools(k, true)` le rend visible, `false` le retire, une clé n'apparaît
  jamais deux fois, un fichier illisible se lit comme « aucun canal ».
- `test/telegram.test.ts` : la résolution de l'état voulu à partir de l'argument
  et de l'état courant, extraite en fonction pure (`nextToolsState(arg, cur)`)
  pour être testable sans réseau ni disque.

## Hors scope

- Toggle côté web : le réglage se pilote depuis Telegram uniquement.
- Filtrer *quels* tools s'affichent (par nom) : un booléen suffit.
- Purger les clés des topics supprimés (cf. plus haut).

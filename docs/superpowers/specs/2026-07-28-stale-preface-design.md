# La préface d'une question ne doit jamais répéter la réponse précédente

*2026-07-28*

## Le problème (reproduit)

Chaque question posée dans Telegram peut être précédée d'une **copie de la
réponse du tour précédent**.

Capture directe de l'événement `dialog` sur le `/ws`, l'agent ayant reçu la
consigne explicite de ne rien dire avant la question :

```json
{"type":"dialog","question":"Thé ou café ?", …, "preface":"MARQUEUR-UNIQUE-42"}
```

`MARQUEUR-UNIQUE-42` était la réponse du tour d'avant, déjà postée. Dans le
canal : le doublon, puis la question.

**La cause.** `dialogMessage` construit la préface avec
`extractLiveText(s.pilot.screen())` : le dernier bloc de texte **visible à
l'écran**. Quand le nouveau tour n'a encore rien écrit, ce bloc est celui du
tour précédent. La préface est périmée.

**Pourquoi le web n'en souffre pas.** Le client garde la trace des blocs déjà
livrés (`finalizedNorms` / `isFinalizedBlock`) et efface l'aperçu s'il en
reconnaît un. Le pont Telegram n'a aucune mémoire : il poste.

**Pourquoi ça ne se répare jamais.** `prefaceMatches` attend le « jumeau
autoritatif » du tail pour éditer le message en place. Ce jumeau est arrivé au
tour précédent ; il ne reviendra pas. Le doublon reste.

## Le correctif

Côté **serveur**, une seule fois pour tous les clients — et pas dans le pont :
un futur client sans mémoire côté navigateur hériterait sinon du même bug.

Une préface n'a de sens que si elle est **inédite**.

### `isStalePreface` (`src/telegram.ts`)

```ts
export function isStalePreface(preface: string, recent: string[]): boolean;
```

Posée à côté de `prefaceMatches`, dont elle est l'application : la préface est
périmée si elle s'apparie à **l'un** des blocs déjà diffusés. Le même
comparateur des deux côtés — même squelette alphanumérique, même empreinte,
mêmes garde-fous (un fragment trop court ne s'apparie jamais). Une seule
définition de « c'est le même bloc » dans tout le projet.

### La mémoire des blocs (`src/server.ts`)

`Live` gagne `recentTexts: string[]`, alimenté là où le tail diffuse déjà les
blocs (`e.kind === "text"`). **Borné aux 8 derniers** : la préface ne peut
décrire qu'un bloc visible à l'écran, donc récent ; garder plus ne ferait
qu'augmenter le risque de faux appariement sur une session longue.

`dialogMessage` n'attache alors la préface que si elle n'est pas périmée.

## Ce que ça ne corrige pas

Un bloc **jamais diffusé** ne peut pas être reconnu. C'est le cas quand le
serveur redémarre (auto-update) pendant qu'un tour écrit : le tail repart de la
fin du fichier (`pos = fs.statSync(file).size`) et ces blocs ne sont jamais
émis. Ils manquent alors dans Telegram — le web, lui, les retrouve en
rechargeant l'historique. **Bug distinct, à traiter à part.**

## Tests

- `isStalePreface` : une préface identique à un bloc déjà diffusé est périmée ;
  un texte inédit ne l'est pas ; une liste vide ne périme rien ; un fragment
  trop court (sous `PREFACE_MIN`) ne s'apparie pas, même contenu dans un bloc.
- La forme rendue à l'écran (gras aplati, ponctuation différente) doit être
  reconnue comme le même bloc que la source Markdown du transcript.

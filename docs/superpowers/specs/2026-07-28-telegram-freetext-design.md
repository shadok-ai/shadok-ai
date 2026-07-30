# Telegram : répondre en texte libre à une question (`freetext`)

*2026-07-28*

## Le problème (reproduit, pas supposé)

`AskUserQuestion` ajoute toujours une option **« Type something »** : une réponse
en texte libre. Le web la gère (`public/index.html`, la `freetext-row` : un champ
de saisie qui envoie `{type:"freetext", n, text}`). Le serveur la gère aussi
(`server.ts`, `case "freetext"` : chiffre → coller le texte → Entrée).

**Le pont Telegram, non.** `parseCallback` ne produit que `choose` / `toggle` /
`confirm`, donc le bouton « 4. Type something » envoie un `choose 4` : le TUI
ouvre sa zone de saisie, reçoit une Entrée à vide, et **rejette l'outil**.

Repro sur le serveur de debug (port 3799, bot `@shadokaitest_bot`), résultat de
l'outil :

```
The user doesn't want to proceed with this tool use. The tool use was rejected
```

Et côté Telegram : **rien**. Aucun message d'erreur, le clavier reste affiché
comme s'il attendait encore. L'utilisateur clique dans le vide et le tour est
mort.

## Le comportement visé

Appuyer sur « Type something » ouvre une saisie : le bot demande la réponse
(avec `force_reply`, donc le clavier du téléphone s'ouvre tout seul), et le
message suivant du canal est renvoyé au serveur en `freetext` — pas en nouveau
prompt.

Le reste ne bouge pas : les options normales restent des `choose`/`toggle`.

## Architecture

### Reconnaître l'option (`src/telegram.ts`)

```ts
export function isFreetextOption(label: string): boolean; // /^type something/i
```

**Exactement la règle du web** (`index.html:2002`) : les deux clients doivent
s'accorder sur ce qu'est une option libre, sinon le même dialogue se comporte
différemment selon l'écran. Un seul endroit à changer si la règle évolue.

### Le clavier et le callback

`dialogKeyboard` émet `f:<n>` au lieu de `d:<n>` pour ces options ;
`parseCallback` reconnaît `^f:(\d+)$` → `{kind:"freetext", n}`.

Le préfixe reste à un caractère : `callback_data` est plafonné à 64 octets par
Telegram, et un label long ne doit jamais s'en approcher.

### L'attente de la réponse

`Bridge` gagne `awaitingFreetext?: { n: number }`.

- **callback `f:n`** → ne rien envoyer au serveur ; armer `awaitingFreetext` et
  poster une invite avec `reply_markup: { force_reply: true }`.
- **message texte suivant** (dans `handleMessage`, avant l'envoi du prompt) →
  `{type:"freetext", n, text}`, puis désarmer.
- **une commande reste une commande** : `/stop` doit fonctionner même en
  attente de texte. L'interception ne se fait donc que pour un message qui
  n'est pas une commande.
- **désarmement** sur `turn-done`, `dialog` et `exited` : une attente orpheline
  transformerait un prompt ordinaire en réponse à une question morte.

### Le garde sur l'envoi du clavier

Le `sendMessage` du dialogue ne passait ni par `chunk()` ni par un repli, là où
`sendPart` réessaie en texte brut. Vérifié auprès de l'API : au-delà de 4096
caractères, Telegram répond `Bad Request: message is too long` → **aucun
clavier et aucune erreur visible**. On tronque le texte de la question, et un
échec d'envoi est **dit** dans le canal au lieu de laisser le tour muet.

## Hors scope

- **« Chat about this »** : le web ne la traite pas non plus comme une option
  libre — la traiter à part ici désaccorderait les deux clients. À trancher
  séparément, pour les deux en même temps.
- Presser un bouton depuis un test automatisé : l'API Bot ne le permet pas
  (seul un vrai client peut émettre un `callback_query`). Les tests couvrent
  les fonctions pures, et la repro de bout en bout passe par le `/ws`.

## Tests

- `isFreetextOption` : « Type something », « Type something else », casse
  indifférente ; une option normale n'est pas libre.
- `dialogKeyboard` : l'option libre porte `f:`, les autres `d:`/`t:`, et le
  bouton Submit du multi-select reste `s`.
- `parseCallback` : `f:4` → `{kind:"freetext", n:4}`, et les formes invalides
  restent `null`.

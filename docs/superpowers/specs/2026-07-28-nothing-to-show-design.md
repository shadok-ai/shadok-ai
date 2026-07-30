# `NOTHING TO SHOW` : laisser un agent ne rien dire

*2026-07-28*

## Le problème

Un agent doit toujours répondre quelque chose. Une session planifiée (un cron
de surveillance, par exemple) qui n'a rien détecté n'a donc aucun moyen de se
taire : elle poste « rien à signaler », ce qui fait vibrer un téléphone pour
dire qu'il ne s'est rien passé. Le bruit est exactement ce qu'un cron muet
devait éviter.

## Le comportement visé

Un bloc de texte dont **tout** le contenu est `NOTHING TO SHOW` n'est ni streamé
ni rejoué : pas de bulle dans le web, pas de message Telegram, rien dans
l'historique après rechargement. Le reste du tour (autres blocs, appels
d'outils, usage de tokens) est inchangé.

La convention est documentée dans `context/pilot-prompt.md`, donc toute session
pilotée la connaît.

## Architecture

### Le prédicat (`src/tail.ts`)

```ts
const NOTHING_TO_SHOW = /^[*_`\s]*nothing to show[*_`\s.!]*$/i;
export function isNothingToShow(text: string): boolean;
```

Volontairement **strict** : la sentinelle doit constituer le bloc entier
(emphase Markdown et point final tolérés, casse indifférente). Un agent qui
*explique* la convention dans une phrase ne se fait pas museler. L'invariant 2
du CLAUDE.md rappelle ce qu'une heuristique trop large a déjà coûté ici : une
citation d'« esc to interrupt » suffisait à bloquer une session en « busy ».

`tail.ts` est la source de vérité du contenu : y placer le filtre le fait valoir
pour tous les consommateurs d'un coup (web et Telegram passent par le même
`stream-text`).

### Les trois points de filtrage

| Où | Pourquoi |
|---|---|
| `parseLine` (`src/tail.ts`) | Le flux live : le bloc n'est jamais émis. |
| `loadHistory` (`src/extract.ts`) | L'historique rejoué au rechargement — filtré **bloc à bloc**, comme le tail, sinon la sentinelle réapparaîtrait après un F5 alors qu'elle n'a jamais été affichée. |
| `updateLivePreview` (`public/index.html`) | L'aperçu gris provisoire est lu à l'écran, pas dans le transcript : sans garde il resterait affiché tout le tour, à attendre un `stream-text` qui ne viendra jamais. Jumeau du regex serveur — il n'y a pas de bundler ici. |

## Tests

- `test/tail.test.ts` : le prédicat (casse, emphase, point final ; la phrase
  *dans* une phrase n'est pas la sentinelle) et `parseLine` qui laisse passer
  le reste du message.
- `test/extract.test.ts` : un bloc sentinelle dans le transcript ne crée aucun
  tour dans l'historique rejoué.

## Hors scope

- Rendre la sentinelle configurable : une chaîne en dur suffit et se documente
  dans le prompt pilote.
- Signaler « ce tour n'a rien dit » dans l'UI : le silence est le but.

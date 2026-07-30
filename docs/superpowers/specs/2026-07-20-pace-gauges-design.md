# Jauges de quota comparées au temps restant

## Problème

Les jauges 5h et 7d affichent un pourcentage de quota consommé sans le rapporter
au temps restant dans la fenêtre. Le chiffre brut ne dit donc rien de la
trajectoire : 90% de la fenêtre 5h alors qu'il reste dix minutes est sans
conséquence, tandis que 55% de la fenêtre 7d alors qu'il reste six jours annonce
un épuisement bien avant le reset. L'utilisateur ne dispose d'aucun signal
l'avertissant qu'il consomme trop vite, ni d'aucun garde-fou.

## Solution

Comparer la consommation au **rythme idéal** — la fraction de la fenêtre déjà
écoulée — et bloquer les envois lorsque la consommation dépasse ce rythme.

```
idealPace = (durée − restant) / durée × 100
ratio     = used / (idealPace + 5) × 100
```

Un ratio de 100% signifie que la consommation suit exactement le temps. Au-delà,
on va trop vite.

La constante 5 ajoutée au dénominateur amortit le début de fenêtre. Sans elle, le
rythme idéal est quasi nul juste après un reset et le moindre message ferait
exploser le ratio : cinq minutes après le reset d'une fenêtre 5h, le rythme idéal
vaut 1,7% et 3% de consommation donnerait un ratio de 180%. Avec l'epsilon, ce
même cas retombe à 45%, tandis que 15% de consommation au même instant donne 225%
et déclenche bien le blocage.

### Cas de référence

| Fenêtre | Restant | Consommé | Rythme idéal | Ratio | Verdict |
|---------|---------|----------|--------------|-------|---------|
| 5h | 10 min | 90% | 96,7% | 89% | passe |
| 5h | 4h55 | 3% | 1,7% | 45% | passe |
| 5h | 4h55 | 15% | 1,7% | 225% | bloque |
| 7d | 6j | 55% | 14,3% | 285% | bloque |
| 7d | 6j | 20% | 14,3% | 104% | bloque |
| 7d | 1j | 80% | 85,7% | 88% | passe |

## Architecture

### `src/pace.ts` — calcul (nouveau)

Module pur, sans I/O ni état, entièrement testable.

```ts
export const WINDOW_SEC = { fiveHour: 5 * 3600, sevenDay: 7 * 86400 };
const PACE_EPSILON = 5;
const BLOCK_RATIO = 100;

export function computePace(
  w: Window | null,
  durationSec: number,
  nowMs: number,
): { idealPacePct: number | null; ratioPct: number | null };

export function paceBlock(
  u: Usage | null,
  nowMs: number,
): { blocked: boolean; reason: string | null };
```

`computePace` renvoie `null` sur les deux champs quand la fenêtre est absente ou
que `resetsAt` est inconnu. `idealPacePct` est borné à l'intervalle 0–100 : une
horloge en avance sur `resetsAt` ne doit pas produire de rythme négatif.

`paceBlock` bloque dès qu'**une** des deux fenêtres dépasse `BLOCK_RATIO`, et
nomme la fautive dans `reason` — par exemple « 7d : 55% consommé pour un rythme
idéal de 14% (285% du rythme) ». Si les deux dépassent, `reason` cite celle dont
le ratio est le plus élevé. En l'absence de données, `blocked` vaut `false` :
l'indisponibilité de l'API ne doit pas verrouiller l'outil.

Le seuil de 100% est en dur. Il n'est pas configurable.

`usage.ts` conserve son rôle actuel — récupérer les données brutes et les cacher
60 secondes — et n'est pas modifié. Le pace se calcule à chaque requête plutôt
qu'au moment du fetch, sinon il resterait figé sur un instantané vieux d'une
minute.

### `src/server.ts` — application

**`GET /usage`** renvoie chaque fenêtre enrichie de `idealPacePct` et `ratioPct`,
plus `blocked` et `reason` au niveau racine.

**Prompt utilisateur** (`case "prompt"`, server.ts:501) : si `paceBlock` bloque et
que `msg.force` est absent, le serveur répond `{type:"pace-blocked", reason, text}`
et ne soumet rien. Le client peut renvoyer le même prompt avec `force: true` pour
passer outre. `force` s'ajoute au garde de forme des messages entrants
(server.ts:385).

Le forçage vaut pour un message et un seul. Aucun état de dérogation n'est
mémorisé, ni côté serveur ni côté client : chaque envoi au-dessus du rythme est un
choix conscient. C'est ce qui distingue un garde-fou d'un avertissement
décoratif.

**Auto-continue** (server.ts:348) : lorsque le minuteur se déclenche alors que le
rythme est dépassé, le serveur ne soumet pas « continue ». Il diffuse
`{type:"pace-hold", reason}` et ré-arme `s.retryTimer` à 60 secondes pour
re-tester. La boucle se poursuit jusqu'à repasser sous le seuil, puis « continue »
part normalement, précédé de `{type:"pace-resumed"}`.

L'attente ne consomme pas `retryCount` : c'est une pause, pas une tentative
échouée. Réutiliser `s.retryTimer` plutôt qu'un minuteur dédié fait que les
chemins de nettoyage existants annulent la pause quand la session meurt, sans
code supplémentaire. Le pas de 60 secondes s'aligne sur le TTL du cache de
`usage.ts` : la boucle d'attente n'émet aucune requête vers l'API.

L'auto-continue n'est jamais forcé. Le forçage est une action de l'utilisateur.

### `public/index.html` — interface

**Jauges.** Chaque `.quota` passe à deux barres empilées de 3 pixels dans les
92 pixels de large existants : consommation au-dessus, rythme idéal en dessous.
La comparaison est immédiate — la barre du haut plus longue que celle du bas
signifie qu'on va trop vite.

```
5h  usage [############  ] 90%
    pace  [############# ] 97%

7d  usage [######        ] 55%
    pace  [##            ] 14%
```

`paintGauge()` peint les deux barres et colore selon le **ratio**, non plus selon
la consommation brute : ambre à partir de 70%, rouge à partir de 100%. Le tooltip
donne consommation, rythme idéal, ratio et délai avant reset.

**Blocage.** Le composer reste actif : le blocage se manifeste à l'envoi, pas
avant. À réception de `pace-blocked`, le client rend une bulle dans le fil au
style `.turn.dialog` (index.html:1524) — la raison chiffrée et un bouton
« Forcer l'envoi » qui renvoie le prompt avec `force: true`. Ce pattern est déjà
celui des questions du TUI ; le codebase n'a pas de modale flottante et n'en
introduit pas.

**Pause.** `pace-hold` affiche une ligne d'état indiquant que l'agent attend le
retour à un rythme acceptable, avec la raison. `pace-resumed` la retire.

**Rafraîchissement.** `refreshUsage()` continue d'interroger `/usage` toutes les
60 secondes. Aucun canal de push n'est ajouté pour l'état de blocage : le serveur
reste l'autorité, et un affichage en retard d'au plus une minute est sans
conséquence puisqu'un envoi entre-temps serait rejeté avec son motif.

## Flux

```
Envoi utilisateur
  └─ prompt ──▶ serveur ──▶ paceBlock ?
                              ├─ non ──────────▶ submit
                              └─ oui, sans force ─▶ pace-blocked
                                                     └─▶ bulle « Forcer l'envoi »
                                                           └─▶ prompt force:true ─▶ submit

Auto-continue
  └─ minuteur ──▶ paceBlock ?
                    ├─ non ──▶ pace-resumed ─▶ submit "continue"
                    └─ oui ──▶ pace-hold ─▶ re-arme 60s ─▶ (boucle)
```

## Erreurs et cas limites

- **API indisponible ou token absent** : `getUsage()` renvoie `null`, `paceBlock`
  ne bloque pas, les jauges affichent « — » comme aujourd'hui.
- **`resetsAt` absent sur une fenêtre** : cette fenêtre ne participe pas au
  blocage ; l'autre reste évaluée.
- **Fenêtre expirée** (`resetsAt` dans le passé) : le rythme idéal est borné à
  100%, le ratio devient donc indulgent jusqu'au prochain instantané.
- **Session tuée pendant une pause** : `s.retryTimer` est annulé par les chemins
  de nettoyage existants.
- **Client déconnecté après `pace-blocked`** : aucun état côté serveur, rien à
  nettoyer.

## Tests

`test/pace.test.ts`, sous `node --test`, sur les fonctions pures :

- 5h, 10 min restantes, 90% consommé → passe
- 5h, 5 min écoulées, 3% consommé → passe (l'epsilon fait son office)
- 5h, 5 min écoulées, 15% consommé → bloque
- 7d, 6 jours restants, 55% consommé → bloque
- 7d, 1 jour restant, 80% consommé → passe
- une seule fenêtre au-dessus du seuil suffit à bloquer
- `resetsAt` null → jamais de blocage
- `usage` null → jamais de blocage
- `reason` cite la fenêtre au ratio le plus élevé quand les deux dépassent

Le script `test` du `package.json` est étendu pour couvrir `test/` en plus du
répertoire de tests de la skill.

## Hors périmètre

- Rendre le seuil configurable.
- Mémoriser une dérogation au-delà d'un message.
- Forcer l'auto-continue.
- Historiser la consommation ou projeter une date d'épuisement.

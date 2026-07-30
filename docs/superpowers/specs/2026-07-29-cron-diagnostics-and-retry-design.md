# Les crons de canal deviennent diagnosticables et rattrapables

*2026-07-29*

## Le problème

Un cron quotidien 09:00 avec garde déterministe a tiré ce matin. Son `lastRun`
dans `~/.shadok-ai/crons/<enc>.json` est bien passé à 09:00:15. **L'agent n'a
jamais reçu le prompt, et rien nulle part ne dit pourquoi.**

Vérifié à la main : le script de garde produisait 11,5 Ko de sortie (il y avait
donc des nouvelles), la session cible était vivante et au repos, aucun mot de
passe configuré. L'échec est dans la livraison — et *tous* ses chemins d'échec
se ressemblent :

```ts
} else if (m.type === "turn-done" || m.type === "exited" || m.type === "error" || m.type === "pace-blocked") {
  // done, or the session was busy/absent/paced → skip; retry next tick.
  clearTimeout(guard); finish();
}
ws.on("error", () => { clearTimeout(guard); finish(); });
ws.on("close", () => { clearTimeout(guard); finish(); });
```

`driveChannel` **résout pareil** que le tour ait abouti ou non, et `fireCron`
renvoie `void`. Un tour livré, un tour refusé pour cause de rythme, une session
occupée, une WS qui casse, la garde 30 min : indiscernables, et aucun d'eux
n'écrit une ligne de log.

`runCronCheck` a le même défaut, en pire — il avale l'erreur d'exécution :

```ts
(_err, stdout) => resolve((stdout || "").trim() || null),
```

Une garde qui n'existe pas (`exit 127`) et une garde qui n'a rien à signaler
rendent le même `null`. Le premier cas est un bug à corriger, le second est le
comportement voulu (0 token sur run calme). Impossible de les distinguer.

Second défaut, indépendant : **aucun rattrapage**. `cronTick` avance `nextRun`
*avant* de tirer.

```ts
c.lastRun = now;
c.nextRun = nextRunFor(c.schedule, now);
```

C'est délibéré — ça empêche un tour long de re-déclencher au tick suivant — mais
ça veut dire qu'un tour perdu pour une raison **transitoire** (garde de rythme,
session occupée, reload du serveur en plein tir) n'est jamais rejoué. Pour un
cron quotidien, l'information est perdue 24 h.

## Le correctif

Trois pièces indépendantes : une issue typée pour la livraison, une issue à
trois branches pour la garde, une fonction pure pour la reprogrammation.

### 1. `driveChannel` renvoie une issue, plus `void`

```ts
export type DriveReason =
  | "pace-blocked"  // la garde de rythme a refusé le prompt
  | "busy"          // un tour était déjà en cours sur ce canal
  | "error"         // refus applicatif du serveur (autre que busy)
  | "exited"        // le process claude est mort pendant le tour
  | "ws-error"      // WS loopback cassée, ou fermée avant la fin du tour
  | "timeout";      // la garde 30 min a sauté

export type DriveOutcome = { ok: true } | { ok: false; reason: DriveReason; detail?: string };
```

**Distinguer « occupée » du reste demande une pièce de protocole.** Le serveur
refuse un prompt en cours de tour avec `fail("a response is already in
progress")` — un `{ type: "error", message }` indiscernable d'un « no session
started ». Matcher la chaîne serait fragile (elle peut changer, ou être
traduite). On ajoute donc un champ **optionnel** `code` au message `error` :

```ts
const fail = (message: string, code?: string) => send({ type: "error", message, ...(code ? { code } : {}) });
```

posé à `"busy"` sur les deux sites qui refusent pour cause de tour en cours
(le test initial, et le re-test après l'`await getUsage()` de la garde de
rythme). Purement additif : aucun client existant ne lit `code`.

`ws-error` couvre aussi la **fermeture prématurée** — un `close` sans
`turn-done` préalable. C'est le cas « le serveur s'est rechargé en plein tir »,
qui aujourd'hui ressemble trait pour trait à un succès.

`gone` (le répertoire du canal a disparu) et `stopped` (quelqu'un a mis fin à la
session) sont classés `error` : les rejouer échouerait exactement pareil.

### 2. `runCronCheck` distingue trois issues

```ts
type CheckResult =
  | { kind: "news"; out: string }        // la garde a parlé → l'agent tourne
  | { kind: "quiet" }                    // rien à signaler → silence, 0 token
  | { kind: "failed"; detail: string };  // la garde est cassée → incident
```

**Le code de sortie ne peut pas servir seul de discriminant.** `grep`, `diff`,
`test` sortent en 1 sans rien écrire quand il n'y a rien à signaler — c'est-à-dire
dans le cas *normal* d'une garde. Traiter « exit ≠ 0 » comme un incident
transformerait la garde la plus banale du monde en alerte permanente.

La règle retenue croise stdout, l'exit et stderr :

| condition | issue |
|---|---|
| stdout non vide (quel que soit l'exit) | **news** |
| stdout vide, exit 0 | **quiet** |
| tué / timeout / échec de spawn | **failed** |
| stdout vide, exit ≠ 0, **stderr non vide** | **failed** |
| stdout vide, exit ≠ 0, stderr vide | **quiet** (cas `grep`) |

stdout reste le seul signal de contenu : le contrat « la sortie de la garde est
préfixée au prompt » est inchangé.

**Une garde cassée réveille l'agent.** Le prompt lui dit que sa garde a échoué
et lui donne le détail, pour qu'il puisse alerter, plutôt que de laisser le
monitoring mourir en silence. C'est un arbitrage assumé : tant que la garde est
cassée, chaque créneau coûte des tokens. Le remède est de réparer la garde — et
le comportement inverse (silence) est précisément le bug qu'on corrige. Le log
sert de trace même si personne ne lit le chat.

### 3. Le rattrapage — décision pure, dans `src/crons.ts`

```ts
export const CRON_RETRY_DELAY_MS = 10 * 60_000;
export const CRON_MAX_RETRIES = 3;

export function nextRunAfterFailure(
  nowMs: number,
  scheduledNextMs: number,
  attempts: number,
): { nextRun: number; retrying: boolean; attempts: number };
```

| cas | résultat | pourquoi |
|---|---|---|
| `attempts >= 3` | `scheduledNext`, `retrying: false`, compteur remis à 0 | ne pas boucler sur un canal cassé |
| `now + 10 min >= scheduledNext` | `scheduledNext`, `retrying: false`, compteur remis à 0 | le créneau normal arrive avant : rattraper n'apporte rien |
| sinon | `now + 10 min`, `retrying: true`, `attempts + 1` | le cas visé |

Une reprogrammation ne **dépasse jamais** le créneau normal : la borne du second
cas le garantit, y compris pour un cron `interval` court (toutes les 5 min → on
ne rattrape jamais, le tick suivant fait le travail).

Rejoué sur : `pace-blocked`, `busy`, `ws-error`, `exited`. Pas sur `error`
(refus applicatif : la cause ne s'évapore pas en 10 min) ni sur `timeout` (la
garde 30 min signifie que le tour tourne *encore* — le rejouer empilerait deux
prompts). Inclure `exited` est un choix : le process claude mort en plein tour a
pu traiter une partie du prompt, donc le rejeu peut dupliquer un effet de bord.
C'est accepté — pour du monitoring, perdre l'info coûte plus cher qu'un doublon.

**L'invariant anti-double-tir tient.** `cronTick` continue d'avancer `nextRun`
avant de tirer, `cronsFiring` reste posé jusqu'au `.finally()` de `fireCron`, et
la reprogrammation écrit toujours une date **future** (`now + 10 min`). Un tour
encore en vol ne peut donc pas être redéclenché. La réécriture relit la liste
depuis le disque (un autre tick a pu la sauver entre-temps) et ne touche que le
cron visé, par id.

Deux champs persistés s'ajoutent à `Cron`, lisibles directement dans le JSON :

```ts
retries?: number;      // échecs de livraison consécutifs, remis à 0 au succès
lastOutcome?: string;  // "ok" | "quiet" | "check-failed" | une DriveReason
```

### 4. Les logs

Une ligne courte par tir sur stdout — donc dans
`~/.shadok-ai/local-supervisor.log` — préfixée `cron:` comme `telegram:` ailleurs,
avec les 8 premiers caractères de l'id.

```
cron: ab12cd34 fired (check: 11.5 kB) -> ok
cron: ab12cd34 quiet (check silent)
cron: ab12cd34 check failed (exit 127) — waking the agent
cron: ab12cd34 skipped: pace-blocked, retry in 10m (1/3)
cron: ab12cd34 skipped: busy, giving up until next slot
cron: ab12cd34 fired -> error: no session started
```

**Le run calme loggue aussi**, sur une ligne neutre. Sans elle on ne distingue
toujours pas « a tourné, rien à dire » de « n'a jamais tourné » — c'est-à-dire
qu'on ne corrigerait qu'à moitié le trou de ce matin. Le coût est borné : un
cron toutes les 5 minutes écrit 288 lignes par jour dans un log déjà bavard.

## Ce qui n'est pas fait

`driveChannel` envoie `cwd: process.cwd()` — la racine du dépôt. L'invariant nº 1
dit qu'une session de worktree reprise avec le cwd de la racine perd son
historique. C'est un défaut réel et adjacent, hors du périmètre ici : les logs
ajoutés le rendront visible s'il mord.

## Tests

`test/crons.test.ts` couvre `nextRunAfterFailure` : le rattrapage nominal, le
plafond de 3 tentatives, le fait de ne jamais dépasser le créneau suivant (y
compris quand celui-ci est à moins de 10 min), et la remise à zéro du compteur.

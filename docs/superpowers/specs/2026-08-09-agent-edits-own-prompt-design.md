# Un agent façonne son rôle — jamais ses garde-fous

Date : 2026-08-09
Statut : validé, implémenté

## La demande, et ce qu'elle a révélé

« Un agent devrait pouvoir modifier le prompt d'un profil — le sien seulement ;
Shadok-Boss pourrait modifier n'importe lequel, voire en fabriquer. »

En instruisant la question, un trou est apparu : **c'était déjà possible, sans
aucune limite**. `PUT /profiles` accepte `deny`, `allow`, `secrets` et `model` ;
`requestAuthed` renvoie `true` d'office quand aucun mot de passe GUI n'est
configuré ; et le garde d'origine laisse délibérément passer les appelants sans
`Origin` (invariant 11, pour Telegram et pilotctl). Un agent read-only pouvait
donc faire :

```bash
curl -X PUT localhost:3789/profiles -d '{"name":"Shadok-Content","deny":[]}'
```

et s'accorder les écritures git. La feature demandée devient donc surtout
l'occasion de **fermer** cette porte en ouvrant, à sa place, une lucarne.

## Ce qui est réellement garanti — et ce qui ne l'est pas

Fermé : le chemin API. Un agent ne peut plus écrire de garde-fou, et la capacité
disparaît de la surface documentée.

**Pas** fermé, et il faut le dire : les agents tournent sous le **même
utilisateur Unix**, avec un shell. `~/.shadok-ai/profiles.json` est en 600 —
donc écrivable par eux. Un agent déterminé réécrit le fichier et le prochain
spawn le relit. C'est le modèle que `CLAUDE.md` annonce déjà : « SOFT (same OS
user, not a sandbox) ». Une vraie frontière demanderait un utilisateur système
ou un conteneur par agent. Ce design supprime l'accident, pas l'intention.

## Le partage

| | prompt de son profil | prompt d'un autre | créer un rôle | deny/allow/secrets/model |
|---|---|---|---|---|
| Agent | ✅ | ❌ | ❌ | ❌ |
| Profil de tête | ✅ | ✅ | ✅ | ❌ |
| Humain (UI web) | ✅ | ✅ | ✅ | ✅ |

Le profil de tête peut fabriquer un rôle en accès complet : ça ne lui donne rien
de neuf, il peut déjà spawner un `Shadok-dev`. Ce qu'il ne peut pas, c'est
**attacher un secret** — la seule capacité qui serait inédite (un rôle qui
injecte le coffre, donné à n'importe quel agent). Un rôle créé reçoit donc
`secrets: []` quoi que demande la requête, pas seulement un refus.

## Le mécanisme

**`browserOrigin`** (`src/net.ts`, pur, testé) : vrai uniquement si un `Origin`
est présent ET same-origin. Volontairement plus strict qu'`originAllowed`, qui
laisse passer les clients sans `Origin`. Garde le `PUT /profiles`. Vérifié
qu'aucun appelant non-navigateur n'en avait besoin : seule `index.html` y écrit,
Telegram et les skills ne font que lire.

**`promptEditVerdict`** (`src/profiles.ts`, pur, testé) : toute la politique en
un seul endroit — nom vide, prompt managé, appelant sans profil, cible d'un
autre, profil de tête, création.

**`PUT /profiles/prompt`** : n'écrit que `systemPrompt`. Une mise à jour repart
de la valeur stockée (`{ ...existing, systemPrompt }`), donc les garde-fous
survivent **par construction** et non par vigilance.

**`SHADOK_SESSION_KEY`** : une clé par session, injectée dans l'env de l'agent.
L'id de session ne pouvait pas servir d'authentifiant — `/live` publie tous les
ids, n'importe quel agent pouvait donc se faire passer pour un autre. Sans cette
clé, « son propre profil » n'aurait été qu'un commentaire.

**Prompt managé refusé, pas avalé** : `Shadok-Tweak` reprend son prompt de
`context/tweak-prompt.md` à chaque boot. Accepter l'édition l'aurait fait
disparaître au prochain redémarrage, sans un mot ; l'erreur renvoie le chemin du
fichier à éditer.

## Surface pour l'agent

`pilotctl.mjs profile-prompt "<texte>" [--name NOM] [--readonly]`, documentée
dans la skill avec ses limites, et annoncée dans le prompt du profil de tête —
sans quoi il ne saurait pas qu'il peut façonner les rôles.

Le prompt est passé à `claude` **au spawn** : un changement prend effet au
**prochain redémarrage** de l'agent visé, pas en cours de session. La réponse le
dit explicitement.

## Vérification

Cœurs purs : 12 assertions (`browserOrigin`, `promptEditVerdict`).

Bout en bout contre un serveur réel, avec de **vrais** agents et leurs vraies
clés — un agent `Shadok-Content` et un `Shadok-Boss` :

- la clé est bien dans l'env de l'agent ;
- il réécrit son prompt (200), le changement est en base, `deny` et `secrets`
  intacts ;
- refus d'éditer un autre profil, de créer, avec une clé inconnue, ou de toucher
  un prompt managé — chacun avec son message ;
- le boss réécrit `Shadok-Support` (garde-fous préservés) et crée un rôle ;
- le rôle créé est read-only comme demandé et porte `secrets: []` **alors que la
  requête réclamait `GOOGLE_ADWORDS`** ;
- un `curl` sans `Origin` sur `PUT /profiles` est refusé, le même avec `Origin`
  passe.

Le vault étant global, il a été sauvegardé avant et restauré à l'identique après
(vérifié par comparaison octet à octet).

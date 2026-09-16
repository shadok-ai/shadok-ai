# Un agent garde le credential qu'il a obtenu — et rien d'autre

Date : 2026-09-16
Statut : validé, implémenté

## La demande

« Il faudrait qu'un agent puisse ajouter un secret à son profil, et ensuite
qu'il se reload tout seul comme un grand. »

## Ce qui existait déjà, et le trou au milieu

La skill `shadok-secrets` laisse un agent **stocker** un credential qu'il a
obtenu lui-même (un `gh auth login`, une clé provisionnée). `POST /reload` et la
skill `shadok-reload` lui laissent **se relancer**. Et `makePilot` relit le
profil sur disque à chaque spawn, donc un reload prend bien en compte un secret
attaché la seconde d'avant.

Les deux bouts étaient là. Le milieu manquait : un secret stocké n'atteint
personne tant qu'il n'est **accroché à un profil**, et ça, seul le navigateur
pouvait le faire (`PUT /profiles` est browser-only). L'agent obtenait un
credential, le rangeait, puis le perdait de vue — un humain devait finir le
travail à la main.

## Le danger, et le mot qui le contient

**Le coffre est global** : un seul fichier pour tous les profils et toutes les
instances. « Un agent attache un secret à son profil » est donc à une règle près
de « n'importe quel agent s'octroie tous les credentials de la machine ». C'est
exactement la capacité que le design du 2026-08-09 avait isolée comme la seule
qui serait inédite — un rôle qui injecte le coffre, donné à n'importe qui.

La règle qui rend la feature sûre tient en un mot : **il n'attache que ce qu'il
a créé**. Il ne gagne alors aucun accès — il détient déjà cette valeur, il la
rend seulement persistante pour ses prochaines sessions.

## Le partage

| | attacher ce qu'il a créé | attacher un autre secret | à un autre profil | deny/allow/model |
|---|---|---|---|---|
| Agent | ✅ | ❌ | ❌ | ❌ |
| Profil de tête | ✅ | ❌ | ❌ | ❌ |
| Humain (UI web) | ✅ | ✅ | ✅ | ✅ |

**Le profil de tête n'a aucune exception**, délibérément à l'inverse de
`promptEditVerdict`. Modifier un prompt ne lui donne rien qu'il n'ait déjà (il
peut spawner un agent en accès complet) ; distribuer des secrets du coffre, si.

## Le mécanisme

**La provenance, dans un fichier annexe** (`~/.shadok-ai/secret-origin.json`,
600). Le coffre reste une map plate `{ NOM: valeur }`, lue par plusieurs chemins
et déjà migrée depuis une forme ancienne : la seule chose pire que perdre la
provenance serait d'abîmer les credentials en l'ajoutant.

**`secretAttachVerdict`** (`src/profiles.ts`, pur, testé), posé à côté de
`promptEditVerdict` — le lecteur qui cherche « ce qu'un agent peut écrire sur un
profil » trouve les deux au même endroit.

**`PUT /profiles/secret`** n'écrit que le tableau `secrets`, en repartant du
profil stocké : les garde-fous survivent **par construction**, pas par
vigilance. Authentifié par `SHADOK_SESSION_KEY`, jamais par l'id de session que
`/live` publie.

Trois détails portent tout le poids :

- l'origine n'est enregistrée qu'à la **création**, jamais sur un écrasement —
  sinon il suffirait d'écraser le secret d'un humain pour s'en dire l'auteur ;
- une origine **absente** signifie « un humain l'a posé », donc un refus :
  l'absence refuse, elle n'accorde jamais ;
- la valeur n'entre dans l'env qu'au **prochain spawn** — l'environnement d'un
  processus vivant ne se change pas — d'où le couple avec `shadok-reload`.

**Surface pour l'agent** : `secret.mjs set NOM --stdin --attach`. Le drapeau est
explicite : stocker un credential pour l'équipe et se l'attribuer sont deux
actes différents. Un refus d'attache n'est pas un échec de stockage — le message
dit les deux moitiés et sort en code 1.

## Ce qui n'est pas fermé, et qu'il faut dire

Un agent peut **supprimer** un secret puis le recréer, et en devenir l'auteur.
Il détruit le credential de l'humain au passage — bruyant, et il n'apprend rien
(la valeur qu'il attache est celle qu'il vient d'écrire). La suppression était
déjà à sa portée avant ce changement ; ce design ne l'aggrave pas.

Et, inchangé : **ce n'est pas un bac à sable**. Les agents tournent sous le même
utilisateur Unix et peuvent réécrire `profiles.json` directement. On supprime
l'accident, pas l'intention.

## Vérification

Cœur pur : 10 assertions.

Bout en bout contre un **vrai serveur**, HOME isolé, port libre, jamais 3789 —
parce qu'un champ accepté n'est pas un champ stocké (invariant 26) :

- l'agent dev stocke `AGENT_TOK` → l'origine est écrite ;
- il l'attache → 200, et le profil le porte ;
- un secret posé par un humain (chemin GUI/Telegram) → **refusé** ;
- un second agent réclamant le secret du premier → **refusé** ;
- l'écrasement pour se dire auteur → `updated`, donc toujours **refusé** ;
- un nom inexistant, et un appel sans clé → refusés ;
- après l'attache, `deny` et `systemPrompt` sont intacts, et l'autre profil
  n'a rien reçu ;
- `secretsFor` sur le profil final ne rend **que** `AGENT_TOK` : c'est
  exactement ce que le spawn injecterait au reload.

Le harnais a d'abord menti — son appel « humain » était non authentifié et sa
sortie jetée, ce qui faisait passer une création pour une attache illégitime. Le
défaut était dans le test, pas dans la règle ; corrigé, les sept étapes se
comportent comme prévu. Le coffre de l'utilisateur n'a jamais été touché.

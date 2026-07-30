# Les messages privés appartiennent à une seule personne

*2026-07-29*

## Le problème

Un groupe est déjà borné : `handleMessage` refuse tout groupe qui n'est pas
celui lié par `/setup`. **Les DM n'avaient aucune borne.** Le seul filtre est
`allowedChats`, et il ne s'applique que s'il est configuré :

```ts
if (allowed.length && !allowed.includes(String(chat.id))) { … }
```

Vérifié sur l'installation en service : **aucune allowlist configurée**. Donc
n'importe qui découvrant le bot obtenait, en écrivant un message, une session
Claude Code sur la machine — avec les droits de l'utilisateur.

## Le comportement visé

Le premier à écrire en privé s'approprie les DM. Tous les autres reçoivent
« ⛔ This bot is private. » et rien d'autre ne se produit : pas de session, pas
de canal créé.

Une `allowedChats` explicite garde la priorité — elle filtre en amont. Ce garde
est le **défaut**, pour l'installation qui n'en configure aucune.

## Architecture

### La décision, pure (`src/telegram.ts`)

```ts
export function dmGate(owner: number | null, from: number | undefined): "claim" | "allow" | "deny";
```

Un expéditeur **sans id** est refusé même quand personne n'a encore revendiqué :
il n'y a rien à mémoriser, donc l'accepter laisserait la porte ouverte au
suivant.

### Le propriétaire (`src/channels.ts`)

`…-telegram-owner.json`, comme le groupe lié : un id, par répertoire de
lancement. Pour repartir de zéro, supprimer le fichier.

### Fermer la fenêtre du déploiement

« Le premier qui écrit gagne » a un défaut sur une installation **déjà en
service** : entre la mise à jour et le premier message de l'utilisateur, un
inconnu peut le verrouiller dehors. `adoptOwnerFromBindings`, au démarrage,
désigne donc le propriétaire sans attendre :

1. **une liaison DM existante** (id de chat positif, sans topic — les groupes
   sont négatifs) ;
2. sinon **le créateur du groupe lié** (`getChatAdministrators`, `status:
   "creator"`, hors bots) : c'est celui qui a monté ce tableau ;
3. sinon seulement, le premier message revendique.

Le cas 2 n'est pas théorique : l'installation en service n'a **aucune** liaison
DM (tout passe par le groupe), donc sans lui la fenêtre serait restée ouverte.
Vérifié en repro — le démarrage journalise
`DM owner adopted from the board group's creator`.

### Les boutons aussi

`handleCallback` applique le même verdict en privé. Un clavier ne peut
apparaître qu'après un message accepté, donc ce chemin n'est en principe pas
atteignable — on le ferme plutôt que de dépendre de cette supposition. Jamais de
`claim` par un clic : on s'approprie les DM en écrivant.

## Ce qui reste exposé (décision de l'utilisateur)

Dans le groupe lié, **tout membre** peut piloter les agents. C'est cohérent avec
le modèle (un tableau partagé), et la protection y est l'appartenance au groupe.
À restreindre au propriétaire seulement si le groupe accueille des tiers.

## Tests

`dmGate` porte les tests : revendication, propriétaire reconnu, tiers refusé,
expéditeur sans id refusé dans les deux états. L'adoption au démarrage est
vérifiée en repro (les deux sources).

Le refus d'un vrai DM tiers ne peut pas être automatisé : un bot ne peut pas
écrire à un autre bot, il faudrait un second compte utilisateur.

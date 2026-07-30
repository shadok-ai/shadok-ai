# Telegram voit les prompts envoyés d'ailleurs, et sait d'où ils viennent

*2026-07-28*

## Le problème

Un canal Telegram ne montrait que les **réponses** de l'agent. Un prompt envoyé
depuis le cockpit web n'y apparaissait pas : côté téléphone, l'agent semblait
parler tout seul, sans qu'on sache à quelle demande il répondait.

Depuis les crons de canal (#79), c'est pire : un cron envoie son prompt par le
même chemin qu'un humain. Sa réponse tombait donc dans le topic sans que rien
ne dise qu'elle venait d'un déclenchement automatique.

## Ce qui existait déjà

`server.ts` diffuse `prompt-echo` **en excluant l'émetteur** :

```ts
broadcast(session, { type: "prompt-echo", text }, ws);
```

Le pont Telegram recevait donc déjà les prompts venus des autres clients — il
n'avait simplement aucun `case` pour eux. Il manquait deux choses : l'afficher,
et savoir **qui** a parlé.

## Le correctif

### L'origine voyage avec l'écho

Un client déclare son origine à la connexion : `{type:"start", origin:"web"}`.
Le serveur la retient pour la durée de la connexion et la joint à l'écho.

| client | origine |
|---|---|
| `public/index.html` | `web` |
| le client interne des crons (`fireCron`) | `cron` |
| le pont Telegram lui-même | `telegram` |
| le reste (pilotctl, CLI…) | absente |

Déclarative et non devinée : le serveur ne peut pas inférer qui est au bout
d'une WebSocket, et une heuristique se tromperait un jour sur le cas qui compte.

### Le rendu (`promptEchoLabel`, pure)

Un en-tête, puis le texte du prompt :

```
👤 web
Réponds exactement PONG et rien d'autre.
```

- `web` → `👤 web` · `cron` → `⏰ cron` · `cli` → `⌨️ cli`
- origine **absente** → `👤` seul. Marquer sans mentir vaut mieux qu'un message
  qui semblerait venir de l'agent.
- origine inconnue → `👤 <nom>` : elle est affichée telle quelle plutôt
  qu'effacée.
- `auto: true` (la reprise du pace guard) → `⚙️ reprise automatique`. Ce n'est
  personne : ça vient du serveur.

Un bot ne peut pas poster sous le nom de l'utilisateur — d'où la marque plutôt
qu'une imitation.

## Pas de boucle

Telegram ne livre jamais à un bot ses propres messages, et le serveur exclut
déjà l'émetteur : un prompt venu de Telegram ne revient pas dans son propre
canal.

## Tests

`promptEchoLabel` porte les tests (chaque origine connue, une origine inconnue,
l'absence d'origine, la reprise automatique). La chaîne complète est vérifiée en
repro sur le banc Telegram.

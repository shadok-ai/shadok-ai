# Le tail reprend où il s'est arrêté (plus de messages perdus au redémarrage)

*2026-07-28*

## Le problème

```ts
pos = fs.statSync(file).size; // start at EOF: only stream what comes next
```

`tailSession` démarre **à la fin du fichier**. Tout ce qu'un agent écrit pendant
qu'un serveur n'est pas là n'est donc jamais diffusé.

Ce n'est pas un cas rare : le serveur **s'auto-update à chaque merge sur `main`**
et se recharge. Constaté en séance, deux fois en quelques minutes :

```
[shadok-ai] auto-update: v0.1.154 → v0.1.155 (installing in background…)
[shadok-ai] auto-update installed v0.1.155; reloading
```

Les agents, eux, survivent (tmux) et continuent d'écrire pendant la fenêtre.

**Le web s'en remet** : au rechargement, il demande l'historique
(`loadHistory`), qui relit tout le transcript. **Telegram n'a aucun rejeu** : un
message manqué n'apparaît jamais. C'est un silence, pas une erreur — rien ne
signale la perte.

## Le correctif

Mémoriser la position atteinte, et repartir de là au lieu de sauter à la fin.

### La décision, isolée et pure (`src/tail.ts`)

```ts
export function startOffset(size: number, stored: number | null, maxCatchUp?: number): number;
```

| cas | départ | pourquoi |
|---|---|---|
| rien de mémorisé | `size` | session neuve : ne pas rejouer un transcript repris |
| `stored > size` | `0` | fichier tronqué ou remplacé — la position n'a plus de sens |
| `size - stored > maxCatchUp` | `size` | trop de retard : rattraper déverserait un mur de texte |
| sinon | `stored` | le cas visé : reprendre après une coupure |

Le plafond (**1 Mo**) borne le seul scénario vraiment gênant : un agent tmux qui
a travaillé des heures pendant que le serveur était absent. Au-delà, on retombe
sur le comportement d'aujourd'hui — et le web garde l'historique complet.

### La persistance

Un fichier par session : `~/.shadok-ai/tail/<sessionId>.pos`. L'id de session
est un UUID, donc le nom est court et sans collision — encoder le chemin complet
du transcript dépasserait la limite d'un composant de nom de fichier.

Écrit **après chaque lecture** (donc seulement quand du contenu a été consommé),
supprimé quand la session est détruite (`destroySession`) : une session finie
n'a rien à reprendre.

Un échec de lecture ou d'écriture n'est jamais fatal — on retombe sur le
comportement actuel (départ à la fin). Perdre la reprise est un désagrément ;
planter le tail couperait tout le contenu.

### Rattacher les agents encore vivants (`src/telegram.ts`)

Reprendre la lecture ne sert à rien si personne ne lit. Or un pont Telegram ne
naissait qu'au **prochain message** du canal : après un redémarrage, un topic
restait dormant, sans session ni tail, et le rattrapage n'avait pas lieu.
Vérifié en repro — première tentative, `/live` renvoyait zéro session et le
message restait perdu malgré la position mémorisée.

`reconcileOnBoot` rouvre donc les ponts dont l'agent **tourne encore**
(`tmuxHasSession("sk-" + sessionId)`). La restriction compte : rouvrir un canal
dormant ferait renaître un `claude` pour rien, à chaque redémarrage et pour
chaque topic jamais fermé.

## Ce que ça corrige, et ce que ça ne corrige pas

**Corrigé** : le contenu écrit pendant un redémarrage arrive enfin dans
Telegram. Vérifié de bout en bout — agent coupé en plein tour, serveur relancé,
la réponse arrive.

**Pas corrigé** : au rattachement, un dialogue resté en attente est re-posté
avec sa préface, et la mémoire anti-doublon (`Live.recentTexts`) est vide dans
le process neuf. Même racine — l'état de diffusion ne survit pas au process —
mais c'est un correctif distinct, à faire séparément.

## Tests

`startOffset` étant pure, elle porte les tests : session neuve, fichier tronqué,
retard raisonnable, retard excessif, position égale à la taille.

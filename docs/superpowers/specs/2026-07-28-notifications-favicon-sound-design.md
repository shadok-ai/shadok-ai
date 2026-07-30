# Design — Notifications : badge favicon + badge titre + son

Date : 2026-07-28
Statut : validé (brainstorming)

## Problème

Quand un agent en arrière-plan réclame l'attention (il est **bloqué** sur une
question/permission) ou a produit une réponse non lue, rien ne le signale au
niveau du navigateur : l'onglet cockpit peut être caché ou sur un autre canal.
On veut un signal passif (favicon + titre) et un signal actif (son) pour les cas
urgents.

## Portée

Frontend uniquement (`public/index.html`). Aucun changement serveur. Tout se
branche sur `setTabMood(tab, mood)` — le point de passage unique par lequel tous
les changements d'état de canal transitent déjà ("working" | "needs-answer" |
"unread" | null).

## Déclencheurs

- **needs-answer** = un agent est **bloqué** en attente d'une décision (dialogue
  TUI : choix, permission, « continuer ? »). Urgent.
- **unread** = un canal en arrière-plan a **fini** un tour (réponse non lue). Info.

Traitement différencié (choix utilisateur) :

| Signal | needs-answer | unread |
|---|---|---|
| Badge favicon | ✅ point **rouge** | ✅ point **ambre** (si pas de needs-answer) |
| Badge titre (`● `) | ✅ | ✅ |
| Son (carillon) | ✅ **si tu ne regardes pas déjà** ce canal | ❌ |

« Tu ne regardes pas déjà » = `document.hidden` (onglet navigateur caché) **ou**
le canal concerné n'est pas le canal actif (`tab !== active`). Le son ne joue
qu'à la **transition** vers needs-answer (pas à chaque re-render).

## Composants (module `notify`, auto-contenu dans index.html)

- `faviconSVG(dot)` → data-URI SVG : marque de base (chevron `›` ambre sur fond
  sombre `#14161d`, coins arrondis) + pastille de couleur `dot` en angle si
  fournie. Aucun asset binaire.
- `attentionColor()` → parcourt `tabs` : rouge (`--err` #e07a6a) si un canal est
  en needs-answer ; sinon ambre (`--amber` #f0a848) si un canal est unread ;
  sinon `null`. (needs-answer prioritaire.)
- `refreshBadge()` → pose `favicon.href = faviconSVG(color)` et
  `document.title = (color ? "● " : "") + titleBase`. `titleBase` est le titre
  courant hors badge (maintenu par le compteur de tokens existant).
- Son : Web Audio API, carillon 2 notes (880 Hz → 1320 Hz, enveloppe ~160 ms),
  pas de fichier. `ding()` respecte le mute. L'AudioContext est **débloqué** au
  premier geste utilisateur (pointerdown/keydown) — contrainte autoplay des
  navigateurs.
- Mute : bouton `🔔`/`🔕` dans le header, préférence persistée
  (`localStorage["cp.muteNotif"]`).

## Points d'intégration

- `<head>` : ajout de `<link rel="icon" id="favicon">`.
- `setTabMood` : mémorise l'état needs-answer précédent, applique les classes,
  puis (transition vers needs-answer + non regardé) → `ding()`, et dans tous les
  cas → `refreshBadge()`.
- Compteur de tokens (met déjà `document.title` à jour) : écrit désormais dans
  `titleBase` puis appelle `refreshBadge()` (le badge survit aux updates de
  tokens).
- Header : bouton mute + handler.

## Critères de réussite

1. Un canal passe en needs-answer alors que l'onglet est caché / un autre canal
   est actif → favicon pastille rouge, `● ` dans le titre, **un** carillon.
2. Un canal passe en unread en arrière-plan → favicon pastille ambre + `● `
   titre, **pas** de son.
3. Regarder le canal (le rendre actif / revenir sur l'onglet) efface son état →
   `refreshBadge()` retire la pastille/titre quand plus rien n'attend.
4. Mute `🔕` → plus de son ; préférence conservée au reload.
5. Pas de son si on est déjà en train de regarder le canal qui pose la question.
6. Le badge coexiste avec le compteur de tokens dans le titre.
7. Frontend seul ; favicon en SVG data-URI (aucun asset ajouté).

## Hors périmètre (YAGNI)

Notifications natives OS (Notification API), compteur numérique dans le badge,
sons personnalisables. On garde favicon + titre + un carillon + mute.

# Design — Désencombrer la barre du haut (boutons en icônes + menu ⋯)

Date : 2026-07-28
Statut : validé (brainstorming)

## Problème

Le header accumule trop de boutons texte à droite (🔔, Diff, Terminal, Secrets,
Profiles, ⏰ Schedule, Telegram, End session) → il déborde sur les fenêtres pas
très larges.

## Décisions (utilisateur)

- Passer les boutons en **icônes** (tooltip `title` conservé pour la découverte).
- **Diff** (jamais utilisé) → rangé dans un menu **⋯** (non destructif, extensible).
- **Secrets** et **Profiles** → restent visibles, en icônes.

## Portée

Frontend uniquement (`public/index.html`). Aucun changement serveur. Les **IDs
des boutons sont conservés** → tous les handlers `addEventListener` existants
restent branchés ; on ne change que le libellé (→ icône) et on emballe Diff dans
un menu.

## Design

Barre, à droite (après les jauges quota 5h/7d) :

| Bouton (id inchangé) | Avant | Après |
|---|---|---|
| `toggleMachine` | Terminal | `⌨️` |
| `secretsBtn` | Secrets | `🔑` |
| `profilesBtn` | Profiles | `👤` |
| `cronBtn` | ⏰ Schedule | `⏰` |
| `telegramBtn` | Telegram | `✈️` |
| `muteNotif` | 🔔 | `🔔`/`🔕` (inchangé) |
| `moreBtn` (nouveau) | — | `⋯` → menu |
| `stopBtn` | End session | `⏹️` (classe `.stop`, teinte alerte au survol) |

Chaque bouton icône porte un `title` explicite.

**Menu ⋯** : `#moreBtn` ouvre `#moreMenu` (absolute, sous le bouton, aligné à
droite, fond `--bg-raised`, bord `--line`). Contenu initial : le bouton **Diff**
(`toggleDiff`, comportement inchangé — bascule le panneau diff). Se ferme au
clic-dehors et après sélection d'un item. Extensible (futurs réglages rares).

### CSS

- `header button.icon` : padding réduit (`6px 8px`), `font-size: 14px`,
  `line-height: 1` pour des carrés d'icône réguliers.
- `.more-wrap { position: relative }` ; `#moreMenu` en dropdown absolu, `z-index`
  au-dessus du contenu.
- `header button.stop:hover { border-color: var(--err); color: var(--err) }`.

### JS

- `#moreBtn` click → toggle `#moreMenu.hidden` (+ `stopPropagation` pour ne pas se
  refermer aussitôt).
- `document` click → ferme `#moreMenu` (clic-dehors ; le clic sur un item bulle
  jusqu'au document → ferme le menu, l'action de l'item s'exécute quand même).

## Critères de réussite

1. La barre tient sans déborder : icônes compactes + un seul `⋯`.
2. Chaque icône garde son action (IDs inchangés) et affiche son tooltip.
3. `⋯` ouvre/ferme un menu contenant Diff ; Diff bascule toujours le panneau.
4. Le menu se ferme au clic-dehors et après clic sur Diff.
5. `⏹️` (stop) reste visuellement distinct (survol en teinte alerte).
6. Frontend seul, aucun asset ajouté (emoji), aucun changement serveur.

## Hors périmètre

Refonte de la partie gauche (Status/Directory/Session/Branch), responsive avancé,
icônes SVG custom. On reste sur des emoji + un menu simple.

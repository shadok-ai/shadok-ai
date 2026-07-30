# Design — La touche Échap envoie esc à la session (comme le bouton du terminal)

Date : 2026-07-28
Statut : validé (brainstorming)

## Problème

Le bouton « Esc » de l'engine room envoie l'échappement au TUI Claude
(`active.ws.send({type:"key", key:"escape"})`, `public/index.html`), ce qui
interrompt le tour en cours. Mais pour l'atteindre il faut ouvrir l'engine room.

On veut que la **touche Échap du clavier**, quand on est dans le chat, envoie
esc à la session active — sans passer par l'engine room. Aujourd'hui Échap dans
le composer ne fait rien.

## Portée

- **Frontend uniquement** (`public/index.html`) : un `addEventListener("keydown")`
  au niveau `document` + une petite fonction de précédence.
- **Aucun changement serveur.** Le message `{type:"key", key:"escape"}` existe
  déjà (émis par les boutons `.keys button[data-key]`, ligne ~2487) et est mappé
  côté serveur vers l'octet d'échappement.

Hors périmètre : le protocole WS, le serveur, l'engine room, les autres touches.

## Comportement (précédence)

Sur `keydown` de `Escape` au niveau document, dans l'ordre :

1. **Overlay/panneau ouvert → le fermer, ne pas envoyer esc.**
   - `#secretsOverlay` non `hidden` → le fermer.
   - sinon `#profilesOverlay` non `hidden` → le fermer.
   - sinon `#diffpanel` a la classe `.open` → le fermer.
   - Dans ces cas : `preventDefault()`, on s'arrête (pas d'esc).
   - *Note :* cela ajoute le comportement « Échap ferme le panneau », qui
     n'existait pas (fermeture au ✕ / clic-fond seulement). Comportement attendu.
2. **L'engine room (`#machine.open`) n'est PAS traité comme un panneau à
   fermer** : c'est le terminal live. On tombe donc dans le cas esc (point 4)
   même quand il est ouvert — Échap y envoie esc, cohérent avec le bouton Esc
   juste à côté.
3. **Dialogue TUI clickable en attente de réponse** (`active.dialogBubble`
   présent) → **ne rien faire** (on laisse répondre au dialogue ; on n'interrompt
   pas). Pas de `preventDefault`.
4. **Sinon, session active** (`active` existe, `active.ws` ouverte
   `readyState === OPEN`, session pas en `setup`) → envoyer
   `active.ws.send(JSON.stringify({type:"key", key:"escape"}))` puis
   `preventDefault()`.
5. **Sinon** (aucune session active) → ne rien faire.

## Interactions & garde-fous

- **Inline-edit (renommage de canal/onglet)** : son input fait déjà
  `e.stopPropagation()` sur `keydown` (avec son propre Échap = annuler). Le
  handler document ne se déclenche donc pas pendant l'édition. Aucun conflit.
- **Champs de saisie d'un overlay** (ex. `#secretKey` dans le secrets overlay) :
  ne font pas `stopPropagation`. Presser Échap en y étant → point 1 ferme
  l'overlay. Comportement souhaitable.
- **Composer (`#promptInput`)** : pas de handler Échap aujourd'hui ; presser
  Échap en y écrivant → esc envoyé (point 4). Le brouillon n'est pas effacé.
- Le point 4 ne dépend d'aucun élément nouveau : réutilise `active.ws` exactement
  comme les boutons de l'engine room.

## Composants touchés

| Élément | Changement |
|---|---|
| JS de `public/index.html` | ajout d'un `document.addEventListener("keydown", …)` gérant `Escape` selon la précédence ci-dessus. Placé près des autres handlers globaux (après le bloc des `.keys button`). |

## Critères de réussite

1. Session active, aucun panneau ouvert, focus dans le composer → Échap
   interrompt le tour (identique au bouton Esc du terminal).
2. Session active, engine room ouvert → Échap envoie esc (n'interrompt pas
   l'affichage, ne ferme pas l'engine room).
3. Secrets / profils / diff ouvert → Échap ferme le panneau, n'envoie pas esc.
4. Dialogue clickable en attente → Échap ne fait rien.
5. Renommage inline en cours → Échap annule le renommage (comportement existant
   inchangé), n'envoie pas esc.
6. Aucune session active → Échap ne fait rien de perturbant.
7. `npm run build` OK (aucun `.ts` touché), vérifié dans le navigateur.

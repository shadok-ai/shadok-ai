# La case « read-only » dit enfin la vérité

Date : 2026-08-09
Statut : validé, implémenté

## Le symptôme

« Quand on édite un profil, on ne peut pas modifier le flag git — ou plutôt il
ne représente pas le statut ? »

Les deux à la fois.

## Les deux défauts

**Elle ne représentait pas l'état.** `fillProfileForm` faisait
`$("profReadonly").checked = false;` **sans condition**. Ouvrir `Shadok-Content`,
qui porte pourtant les 7 motifs `deny`, affichait la case décochée. Pour tous les
profils, toujours.

**Elle ne pilotait rien.** Le gestionnaire était à sens unique :
`if (e.target.checked) profDeny.value = READONLY_DENY.join("\n")`. Cocher
écrasait la zone ; **décocher ne faisait rien**. Retirer le read-only imposait de
vider la zone de texte à la main.

L'origine est dans l'intention : « Read-only **preset** » avait été conçu comme
un bouton « remplis-moi la liste », pas comme un état. Présenté en case à cocher,
il se lit pourtant comme un état — d'où un vrai interrupteur.

## La règle retenue

`deny` reste **la source de vérité**. La case en est une vue, jamais l'inverse.

- **Cochée** si et seulement si les 7 motifs du preset sont **tous** présents. Un
  preset à moitié appliqué ne doit pas se donner des airs d'être en place.
- **Décocher** retire ces 7 motifs et **conserve** les motifs personnalisés.
- **Cocher** ajoute ceux qui manquent, sans doublon et sans toucher au reste.
- **Éditer la zone à la main** resynchronise la case — sinon elle se remettrait à
  mentir dès la première ligne tapée.

Volontairement plus strict que le badge de la carte, qui répond à une autre
question — « ce profil a-t-il des garde-fous ? » — et s'allume dès qu'un `deny`
existe, fût-il personnalisé. Les deux cohabitent parce qu'ils n'affirment pas la
même chose.

## Cœurs purs

`hasReadonlyPreset(deny, preset)` et `applyReadonlyPreset(deny, on, preset)` dans
`public/profile-card.js`, le preset passé en paramètre plutôt que capturé.

**Un garde anti-dérive** vient avec : `READONLY_DENY` est dupliqué dans
`index.html` (le navigateur ne peut pas importer le TypeScript). Un test compare
la copie du HTML à celle de `src/profiles.ts` — sans lui, une modification côté
serveur laisserait la case poser des garde-fous périmés, en silence.

## Vérification

434 tests verts. Au navigateur, sur les profils réels :

| Action | Résultat |
|---|---|
| ouvrir `Shadok-Content` (read-only) | case **cochée** — elle était toujours décochée avant |
| ouvrir `Shadok-dev` (accès complet) | décochée |
| ajouter `Bash(rm:*)` à la main | reste cochée |
| décocher | il ne reste que `Bash(rm:*)` — le perso survit |
| recocher | 8 motifs, perso conservé, aucun doublon |
| vider la zone à la main | se décoche |

Zéro erreur console.

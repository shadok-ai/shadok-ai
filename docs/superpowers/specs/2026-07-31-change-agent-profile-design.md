# Changer le profil d'un agent en cours

Date : 2026-07-31
Statut : validé, implémenté

## Problème

Le profil est choisi au spawn et n'est **plus jamais modifiable** ensuite. Or
c'est ce qui définit un agent : rôle, garde-fous de permissions, secrets, modèle.
Se tromper de profil — ou vouloir passer un agent en lecture seule après coup —
oblige aujourd'hui à fermer le canal et à en recréer un, ce qui **perd la
conversation**.

Le mécanisme manquant est pourtant à 90 % en place :

- `restart` (WS) re-spawne l'agent sur place avec `s.profile`, en préservant
  l'historique (`--resume`) et les références de tous les clients attachés ;
- le menu contextuel d'un onglet existe et **affiche déjà** le profil courant
  dans son entête ;
- la grille de cartes de profil existe (box « New agent »).

Il ne manque que le changement lui-même, et sa confirmation.

## Contrainte

`profile` est dans `SERVER_OWNED` (`src/channels.ts:52`) : un `PUT /channels`
venant du navigateur ne peut ni l'écrire ni l'effacer. C'est délibéré — un client
périmé ne doit pas pouvoir déshabiller un agent de ses garde-fous. Le changement
passe donc par un **chemin serveur dédié**, pas par la persistance des canaux.

## Protocole

**client → serveur** : `{ type: "set-profile", profile: string | null, restart?: boolean }`

Le serveur :
1. valide — `profile === null` ou `getProfile(profile)` existe ; sinon `error` ;
2. persiste sur le canal (`upsertChannel`), seul chemin légitime pour ce champ ;
3. pose `s.profile` — le profil **désiré**, celui que le prochain spawn utilisera ;
4. diffuse `profile` à **tous** les clients (autres onglets, autres appareils) ;
5. si `restart: true`, enchaîne sur le chemin `restart` existant, inchangé.

**serveur → client** : `{ type: "profile", profile, applied }`

`applied` est le profil que le **process en cours** a réellement reçu. Il est posé
aux deux seuls endroits qui appellent `makePilot` : `createSession` et le handler
`restart`. Sans lui, « enregistré » et « en vigueur » seraient indistinguables et
l'UI ne pourrait pas montrer l'écart. Émis aussi juste après `ready`, pour qu'un
client qui arrive connaisse les deux valeurs.

## UI

**Le menu contextuel de l'onglet** gagne une entrée `👤 Change profile…`, sous
l'entête qui affiche déjà le profil. Elle n'apparaît que si l'onglet a un
`sessionId` : un agent jamais lancé se règle dans la box de création.

Quand désiré ≠ en vigueur, l'entête le dit : `👤 Shadok-dev (at next reload)`.

**Le sélecteur** réutilise les cartes de la box. `renderProfileGrid` était câblée
en dur sur `#profileGrid` et sur le `selectedProfile` global ; elle est extraite
en `renderProfileCards(container, selected, onPick)`, utilisée par les deux
appelants. Pas de duplication de la logique de carte.

**La confirmation** a **trois** issues, donc pas un `confirm()` natif :

- `Redémarrer` — persiste et redémarre tout de suite ;
- `Enregistrer seulement` — persiste, appliqué au prochain reload ;
- `Annuler` / Échap — **ne change rien**. Fermer une popin ne doit jamais
  modifier l'état en douce.

Si l'agent travaille, la popin ajoute « Un tour est en cours — il sera
interrompu » et le bouton de redémarrage passe en teinte alerte. On n'interdit
pas : couper un agent parti de travers est précisément un cas d'usage.

## Appui long (tactile)

Le menu contextuel n'avait **aucun** support tactile — préexistant, mais il rend
cette feature inaccessible depuis un téléphone, alors que le cockpit se pilote
aussi comme ça. Un appui long de 500 ms sur l'onglet ouvre le même menu ; un
déplacement du doigt l'annule (c'est un scroll, pas un appui). Bénéficie aussi à
Rename / Mute / Mirror / Close.

## Hors périmètre

- Commande Telegram équivalente.
- Changer le profil d'un onglet jamais lancé (la box de création le couvre).

## Tests

Le WS du serveur n'a pas de harnais de test unitaire dans ce dépôt ; les cœurs
purs, si.

- `channels.test.ts` : un `PUT /channels` client ne peut pas écraser le `profile`
  d'un canal (l'invariant que le chemin dédié protège).
- `profile-card.test.ts` : inchangé — la logique de carte ne bouge pas.
- Le reste (menu, popin, restart, diffusion multi-clients) est vérifié **au
  navigateur** avec Playwright, y compris à deux onglets ouverts pour contrôler
  que le changement se propage.

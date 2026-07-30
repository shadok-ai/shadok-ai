# Agent creation box — profile-first

Date : 2026-07-29
Statut : validé, prêt pour plan d'implémentation

## Problème

La box de création (`#setup`, `public/index.html`) est un formulaire à plat de
six blocs. Trois défauts concrets :

1. **Le profil est invisible.** C'est pourtant *le* choix structurant (rôle,
   garde-fous, secrets, modèle), et il est réduit à un `<select>` maigre placé
   en avant-dernier, après le worktree.
2. **La box déborde.** `#liveField` (« Agents running now ») et `#recoverField`
   (« Reopen an unfinished session ») sont dépliés dès qu'ils ont un élément et
   poussent le bouton Start hors de l'écran. Sur mobile c'est illisible.
3. **Le vocabulaire ment.** L'UI parle de « channel » / « new link » alors que
   l'objet mental de l'utilisateur est un **agent**.

Et deux pièges plus discrets :

- Aucun raccourci depuis la box vers l'édition des profils : il faut viser le
  bouton `Profiles` de la barre du haut, hors du flux de création.
- En mode `continue` / `resume`, le profil et le worktree restent actifs à
  l'écran mais sont **silencieusement ignorés** (`startActiveTab`, ligne ~2288 :
  les deux ne sont posés que `if (mode === "new")`).

## Portée

Uniquement la copie visible et la box de création. Le protocole WS, les
endpoints, `src/channels.ts` et la persistance (`~/.shadok-ai/channels/`) ne
changent pas. Le message `start` garde son champ `profile`.

## 1. Renommage — copie UI seulement

| Où | Avant | Après |
|---|---|---|
| `nav .side-label` | `Channels` | `Agents` |
| `#newTab` | `＋ new channel` | `＋ new agent` |
| `#newTab[title]` | `New channel` | `New agent` |
| `#newGroup[title]` | `New tab group` | `New agent group` |
| `#setup h1` | `New link` | `New agent` |
| `#setup p.hint` | texte « channel » | réécrit en « agent » |
| `#startBtn` | `Start session` | `Start agent` |
| `src/telegram.ts` (aide `/tools`, `/cron`) | « this channel » | « this agent » |

Identifiants de code, noms de fichiers, endpoints `/channels` `/groups`, clés de
`localStorage` et nom forcé `general` du canal principal : **inchangés**. Le
renommage est cosmétique par construction, donc sans risque de régression sur la
persistance (invariant 6 de `CLAUDE.md`).

## 2. Structure de la box

```
New agent
A real Claude Code session, driven from here. Start as many agents as
you want working in parallel.

Which agent?                              ✎ edit profiles
┌──────────────┐ ┌──────────────┐
│ Shadok-dev   │ │ Shadok-Market│
│ senior soft… │ │ paid-market… │
│ [full access]│ │ [read-only]  │
└──────────────┘ └──────────────┘
┌──────────────┐ ┌──────────────┐
│ Shadok-Suppo │ │ ∅ No profile │
│ [read-only]  │ │ plain Claude │
└──────────────┘ └──────────────┘

Working directory  [/path/to/project                ]
☑ Isolate in a git worktree

▸ Advanced — resume an existing session
▸ Reopen a past session  (3)
▸ Agents running now  (1)

                              [ Start agent ]
```

Ordre : **qui** (profil) → **où** (dossier, worktree) → le rare, replié → action.

### Les trois `<details>`

`#advancedField`, `#recoverField`, `#liveField` deviennent des `<details>`
**fermés par défaut**, une règle unique et prévisible. Le `<summary>` porte un
compteur (`(3)`) rendu en ambre quand il est non nul, pour que l'information
« il y a des choses ici » survive au repli. Les listes gardent leur rendu et
leur `max-height` actuels.

`#advancedField` contient le bloc Resume existant tel quel : la `radio-row`
(`new session` / `latest in directory` / `by id`), `#resumeInput` et
`#sessionList`. Le mode par défaut reste `new`.

Corollaire : `refreshLiveList` / `refreshRecoverList` ne pilotent plus
`field.hidden` mais le compteur du `<summary>` et la présence du `<details>` —
un `<details>` sans élément reste masqué comme aujourd'hui.

### Mode ≠ `new`

Quand le mode passe à `continue` ou `resume`, la grille de profils et la case
worktree prennent une classe `.na` (`opacity:.45; pointer-events:none`) et une
note d'une ligne « applies to new sessions only ». `startActiveTab` garde sa
logique actuelle — l'UI cesse simplement de mentir.

## 3. Cartes de profil

Grille CSS `repeat(auto-fill, minmax(150px, 1fr))`, gap 8px. Chaque carte est un
`<button role="radio">` dans un conteneur `role="radiogroup"` : sélection au
clic, navigation aux flèches, activation Espace/Entrée, `aria-checked` tenu à
jour. Sélection = bordure et nom en ambre (`--amber`), comme le reste du thème.

Contenu, **entièrement dérivé du type `Profile` existant** (aucun champ ajouté à
`src/profiles.ts`) :

- **Nom** : `profile.name`, police mono.
- **Blurb** : première phrase de `systemPrompt`, débarrassée du préfixe
  `You are <name>, ` / `You are <name> — `, tronquée à ~90 caractères avec `…`,
  clampée à 2 lignes en CSS. Vide si pas de `systemPrompt`.
- **Badges** : `read-only` si `deny?.length` (sinon `full access`), le nom du
  modèle si `model` est fixé, `N secrets` si `secrets?.length`.

Une carte `∅ No profile` (sous-titre « plain Claude ») termine toujours la
grille ; c'est la valeur par défaut au premier usage, équivalente à l'actuel
`<option value="">`.

### Module pur testable

`profileBlurb(profile)` et `profileBadges(profile)` vont dans
`public/profile-card.js` — même pattern que `public/live-text.js` : ESM importé
par le navigateur *et* par `test/profile-card.test.ts`. Le rendu DOM reste dans
`index.html`.

Cas couverts par les tests : préfixe `You are X,` retiré ; pas de
`systemPrompt` → blurb vide ; phrase très longue → troncature avec `…` sans
couper au milieu d'un mot ; `deny` vide → `full access` ; `deny` non vide →
`read-only` ; `secrets` de 1 → `1 secret` (singulier) ; `model` absent → pas de
badge modèle.

## 4. Raccourcis d'édition

- **`✎ edit profiles`**, aligné à droite du titre « Which agent? », ouvre
  l'overlay existant `#profilesOverlay` (même chemin que `#profilesBtn`).
- **`✎` par carte**, visible au survol/focus, ouvre l'overlay **prérempli** sur
  ce profil via `fillProfileForm(p)`. `stopPropagation` pour ne pas sélectionner
  la carte au passage.
- À la **fermeture** de l'overlay (✕, Échap, clic sur le fond), la grille se
  re-rend depuis `profileCache` : un profil créé apparaît immédiatement, la
  sélection courante est conservée si le profil existe encore, sinon elle
  retombe sur `No profile`.
- **Zéro profil** : une seule carte pleine largeur
  « Create your first profile → » qui ouvre l'overlay vide. Aujourd'hui on
  tombe sur un `(none)` muet.

## 5. Mémoire du dernier profil

Au démarrage d'un agent, le profil retenu est écrit dans
`localStorage["cp.profile:" + cwd]`. À l'ouverture de la box (et à chaque
changement de `#cwdInput`, qui rafraîchit déjà la liste recover), la carte
correspondante est présélectionnée ; à défaut, `cp.profile` (dernier profil
utilisé, tous dossiers confondus) ; à défaut, `No profile`. Un profil mémorisé
qui n'existe plus est ignoré silencieusement.

Effet visé : le cas courant devient **un clic + Start**.

## 6. Erreurs

`GET /profiles` en échec ou réponse non-tableau → la grille affiche une ligne
`couldn't load profiles` et **la carte `No profile` reste présente et
sélectionnable**, donc on peut toujours démarrer un agent. C'est déjà le
comportement défensif de `loadProfilesInto` (`catch { profileCache = [] }`), on
le rend visible.

## 7. Hors périmètre

Écartés volontairement, à rouvrir si le besoin se confirme :

- Menu de spawn rapide au survol de `＋ new agent` (choisir un profil sans
  ouvrir la box).
- Couleurs / emoji par profil — demanderait de nouveaux champs sur `Profile` et
  un formulaire à remplir pour les profils existants.

## Vérification

`npm run build`, `npm test`, puis vérification dans le navigateur sur un build
local (voir « Running YOUR build » dans `CLAUDE.md` — ne pas démarrer un second
serveur). À contrôler à l'œil : box entière visible sans scroll sur une fenêtre
courte, sélection au clavier, ouverture de l'overlay depuis les deux raccourcis,
profil mémorisé au deuxième agent lancé dans le même dossier.

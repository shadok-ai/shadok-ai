# Shadok-Content — le contenu organique, distinct du payant

Date : 2026-08-08
Statut : validé, implémenté

## La question posée

« Un profil de création de contenu, orienté SEO — ou est-ce que Shadok-Marketing
couvre déjà le sujet ? »

## Pourquoi il ne le couvre pas

`Shadok-Marketing` est explicitement **payant** : « paid-marketing & growth »,
« ad copy », « campaign plans », « conversion-focused ». Le seul recouvrement est
« audience/keyword research » — et dans ce contexte, ce sont des mots-clés sur
lesquels **enchérir**.

Le SEO éditorial est un autre métier : intention de recherche, cluster autour
d'une requête primaire, structure Hn, title/meta, maillage interne. Et surtout un
livrable différent : un **article**, pas une campagne.

Élargir `Shadok-Marketing` pour couvrir les deux donnerait un profil obèse dont
le prompt essaie d'être à la fois rédacteur publicitaire et éditeur SEO —
mauvais aux deux bouts. Et le boss, qui choisit un rôle au moment de déléguer,
n'aurait plus de frontière nette. D'où deux profils frères : **Marketing achète
l'audience, Content la gagne**, et chaque prompt nomme l'autre pour que la
frontière soit lisible depuis l'intérieur.

## Le profil

Inséré après `Shadok-Marketing` — ce sont des frères, ils se lisent ensemble.

- `deny: READONLY_DENY`, comme Marketing et Support.
- `secrets: []`, pas de `model` forcé — cohérent avec les autres ; l'utilisateur
  attache ce qu'il veut depuis le panneau Profiles.

Le prompt tient en cinq blocs : partir du produit et pas du mot-clé ; travailler
l'intention (qui cherche, ce qu'il sait déjà, ce qu'il doit pouvoir faire
ensuite) ; livrer un fichier Markdown avec front matter ; ce qu'il a le droit de
faire ; et l'interdiction du remplissage.

### Le piège corrigé : read-only ≠ ne rien écrire

`READONLY_DENY` ne bloque que les écritures **git**, jamais `Write`/`Edit`. Or la
formulation de `Shadok-Marketing` — « You have READ-ONLY access to the code —
git writes are blocked, never modify or commit it » — suffit à faire refuser à un
agent la création du moindre fichier. Pour un profil dont le **livrable est un
fichier**, ce serait fatal. Le prompt dit donc explicitement : *You MAY write and
edit files: your drafts are the deliverable* ; ce qui est interdit, c'est de
toucher au code du produit, et git reste bloqué pour que la revue reste humaine.

### Les secrets, sans les coder en dur

Une phrase conditionnelle : si des identifiants Search Console / analytics sont
disponibles **en variables d'environnement**, s'en servir pour choisir les sujets
sur des requêtes réelles plutôt qu'au jugé. Rien n'est codé en dur — le profil
est global et réutilisable sur n'importe quel dépôt, et c'est `envVarsNote` qui
annonce dynamiquement ce qui est réellement injecté.

## Le boss doit connaître le nouveau rôle

`Shadok-Boss` énumère les rôles délégables ; sans mise à jour, il n'aurait jamais
délégué à `Shadok-Content`. La ligne devient : dev pour le code, Marketing pour
l'acquisition payante et l'ad copy, Content pour les articles et l'organique,
Support pour le user-facing. Un test verrouille le fait que tout rôle cité par le
boss existe bien dans `DEFAULT_PROFILES`.

## Livraison

`seedDefaultProfiles` ne sème que si le fichier est vide : le profil est donc
aussi créé dans le vault en service via `PUT /profiles`, et le prompt du boss y
est rafraîchi. Vérifié au préalable que le boss en service n'avait **aucune**
personnalisation (prompt identique à celui du code, pas de secret ni de modèle
attaché) — sinon il aurait fallu demander avant d'écraser.

## Tests

- `profiles.test.ts` : Content est read-only ; son prompt dit qu'il **peut**
  écrire des fichiers, que git est bloqué, nomme la frontière avec Marketing, et
  décrit le livrable (Markdown + front matter). Le boss cite les quatre rôles, et
  chacun existe.
- Au navigateur : la carte apparaît entre Marketing et Support, blurb
  « the organic-content & SEO agent. », badge `🔒 read-only`, et le nom par défaut
  du nouvel agent suit la carte (`Shadok-Content`). Zéro erreur console.

# Telegram → Claude Code : pièces jointes (images & fichiers)

**Date :** 2026-07-23
**Statut :** validé (brainstorm avec l'utilisateur)

## Problème

Aujourd'hui le bridge Telegram ignore tout message sans texte
(`handleMessage` : `if (typeof msg.text !== "string") return;`). Envoyer une
photo ou un fichier dans un chat/topic lié à une session Claude Code ne fait
rien. L'utilisateur veut que poser une image (ou n'importe quel fichier) dans
Telegram équivaille à la « coller » dans la session Claude Code.

## Approche retenue

**Chemin de fichier dans le prompt** (approche A du brainstorm). Le bridge
télécharge la pièce jointe via l'API Bot Telegram, la sauve sur disque, puis
envoie un prompt texte normal contenant le chemin absolu. Claude Code lit le
fichier lui-même (tool Read pour images/PDF/texte, Bash pour le reste).

Écarté :
- **Simuler un paste TUI (Ctrl+V)** : presse-papier global machine → collisions
  entre sessions parallèles, fragile, casse en headless.
- **Sauver dans le cwd/worktree de la session** : pollue le diff, risque de
  commit accidentel.

Tout vit dans `src/telegram.ts` (+ helper éventuel). **Aucun changement du
serveur ni du protocole WS** — on passe par le message `prompt` existant.

## Comportement

| Envoi Telegram | Résultat |
|---|---|
| Photo avec caption | Un prompt : `[Image jointe : /chemin]` + la caption |
| Photo sans caption | Un prompt : juste `[Image jointe : /chemin]` |
| Document (tout type : PDF, .txt, .zip, image « en fichier »…) | Un prompt : `[Fichier joint : /chemin]` (+ caption éventuelle) |
| Album (`media_group_id`) | **Un seul** prompt regroupant tous les chemins (+ la caption de l'album) |
| Fichier > 20 Mo | Reply `⚠️ fichier trop gros (limite Telegram bot : 20 Mo)`, rien envoyé à Claude |
| Échec de téléchargement | Reply `⚠️` explicite, rien envoyé à Claude |

Le texte pur reste géré exactement comme aujourd'hui.

## Détails techniques

- **Photo** : `msg.photo` est un tableau de tailles → prendre la dernière
  (plus grande résolution).
- **Document** : `msg.document` (tout `mime_type`, sans filtre).
- **Téléchargement** : `getFile(file_id)` → GET
  `https://api.telegram.org/file/bot<token>/<file_path>`. La limite de 20 Mo
  est celle de `getFile` côté Telegram — la détecter via `msg.document.file_size`
  / `photo.file_size` avant l'appel quand c'est possible, et gérer l'erreur
  `getFile` sinon.
- **Stockage** : `~/.shadok-ai/media/` (convention `~/.shadok-ai/` comme
  secrets/channels). Nom : `<file_unique_id>-<nom_original>` (nom d'origine
  conservé pour donner du contexte à Claude ; `file_unique_id` en préfixe
  évite les collisions). Photo sans nom : `<file_unique_id>.jpg`. Le nom
  original est nettoyé (basename, pas de `/`).
- **Prompt généré** : chemin absolu, ex.
  `[Fichier joint : /Users/alex/.shadok-ai/media/AQAD…-rapport.pdf]\n<caption>`.
  Claude décide comment le lire selon le type.
- **Albums** : les messages d'un même `media_group_id` arrivent séparément
  (la caption souvent sur un seul). Buffer par `media_group_id` avec timer
  ~1,5 s réarmé à chaque photo ; à expiration, un seul prompt avec tous les
  chemins et la caption trouvée.
- **Typing** : l'heartbeat « typing » optimiste démarre dès la réception,
  comme pour un message texte (téléchargement inclus).
- **Purge** : au démarrage du bridge, suppression des fichiers de
  `~/.shadok-ai/media/` modifiés il y a plus de 30 jours.

## Gestion d'erreur

- `getFile` KO ou download HTTP non-200 → reply Telegram
  `⚠️ je n'ai pas pu télécharger <nom> (<raison>)` ; rien n'est envoyé à la
  session ; le typing s'arrête.
- Un fichier en échec au sein d'un album n'empêche pas l'envoi des autres
  (le prompt liste ce qui a réussi, le reply signale l'échec).

## Tests / vérification

- Build (`npm run build`), restart du serveur en tmux, puis vérification
  manuelle de bout en bout : photo avec caption, photo sans caption, document
  PDF, image « en fichier », album de 2-3 photos, fichier > 20 Mo.
- Vérifier que la session Claude lit bien le fichier (le tour répond sur le
  contenu de l'image/du document).

# Telegram File Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une image ou un fichier posé dans un chat/topic Telegram est téléchargé et « collé » dans la session Claude Code liée (chemin absolu dans le prompt).

**Architecture:** Tout vit dans `src/telegram.ts` : des helpers purs (extraction de la pièce jointe du message, nom de fichier de stockage, construction du prompt, buffer d'albums) testés unitairement, et le runtime (téléchargement via l'API Bot, purge, branchement dans `handleMessage`) dans la closure `startTelegram`. Aucun changement du serveur ni du protocole WS — on passe par le message `prompt` existant. Spec : `docs/superpowers/specs/2026-07-23-telegram-file-attachments-design.md`.

**Tech Stack:** TypeScript ESM (NodeNext, imports en `.js`), Node ≥ 20, tests `node:test` + `assert/strict` via tsx.

## Global Constraints

- Imports relatifs avec extension `.js` (NodeNext) ; ex. `import { SHADOK_DIR } from "./config.js"`.
- Stockage : `~/.shadok-ai/media/` (`path.join(SHADOK_DIR, "media")`).
- Limite Telegram Bot API `getFile` : 20 Mo (`20 * 1024 * 1024`).
- Purge : fichiers de `media/` plus vieux que 30 jours, au démarrage du bridge.
- Commentaires : expliquer le **pourquoi** (FR/EN mélangés acceptés, suivre le fichier).
- Tests : `npm test` (toute la suite) ou ciblé `node --import tsx --test test/telegram.test.ts`.
- Le code runtime (fetch réseau, fs) n'est PAS testé unitairement dans ce repo — seuls les helpers purs le sont (convention existante de `telegram.ts`).

---

### Task 1: Extraction de la pièce jointe (`attachmentOf`, `mediaFileName`)

**Files:**
- Modify: `src/telegram.ts` (section « Pure helpers », après `parseCommand`, ~ligne 52)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: rien (helpers purs).
- Produces: `interface TgAttachment { fileId: string; fileUniqueId: string; kind: "image" | "file"; fileName?: string; fileSize?: number }`, `attachmentOf(msg: any): TgAttachment | null`, `mediaFileName(att: TgAttachment): string`. Utilisés par les Tasks 3 et 4.

- [ ] **Step 1: Write the failing tests**

Dans `test/telegram.test.ts`, ajouter à l'import existant `attachmentOf, mediaFileName` puis, en fin de fichier :

```ts
test("attachmentOf: photo → la plus grande taille, kind image", () => {
  const att = attachmentOf({
    photo: [
      { file_id: "small", file_unique_id: "u1", file_size: 100 },
      { file_id: "big", file_unique_id: "u2", file_size: 5000 },
    ],
  });
  assert.deepEqual(att, { fileId: "big", fileUniqueId: "u2", kind: "image", fileSize: 5000 });
});

test("attachmentOf: document image/* → kind image, garde le nom", () => {
  const att = attachmentOf({
    document: { file_id: "f", file_unique_id: "u", file_name: "shot.png", mime_type: "image/png", file_size: 42 },
  });
  assert.deepEqual(att, { fileId: "f", fileUniqueId: "u", kind: "image", fileName: "shot.png", fileSize: 42 });
});

test("attachmentOf: document quelconque → kind file", () => {
  const att = attachmentOf({
    document: { file_id: "f", file_unique_id: "u", file_name: "rapport.pdf", mime_type: "application/pdf" },
  });
  assert.equal(att?.kind, "file");
  assert.equal(att?.fileName, "rapport.pdf");
});

test("attachmentOf: message texte pur → null", () => {
  assert.equal(attachmentOf({ text: "hello" }), null);
});

test("mediaFileName: nom original préfixé par l'id unique, nettoyé", () => {
  assert.equal(
    mediaFileName({ fileId: "f", fileUniqueId: "AQAD", kind: "file", fileName: "../é vil/rapport final.pdf" }),
    "AQAD-rapport final.pdf",
  );
});

test("mediaFileName: photo sans nom → .jpg ; fichier sans nom → id nu", () => {
  assert.equal(mediaFileName({ fileId: "f", fileUniqueId: "AQAD", kind: "image" }), "AQAD.jpg");
  assert.equal(mediaFileName({ fileId: "f", fileUniqueId: "AQAD", kind: "file" }), "AQAD");
});
```

Note : `"../é vil/rapport final.pdf"` → `path.basename` donne `"rapport final.pdf"` (l'espace et les lettres accentuées sont gardés par `\w` unicode ? Non — voir Step 3 : la regex de nettoyage remplace tout caractère hors `[\w.\- ]` par `_`, et `é` n'est pas dans `\w` ASCII. Le basename ici est `rapport final.pdf` qui ne contient que des caractères sûrs, donc inchangé).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/telegram.test.ts`
Expected: FAIL — `attachmentOf` / `mediaFileName` ne sont pas exportés (`SyntaxError: The requested module ... does not provide an export named 'attachmentOf'`).

- [ ] **Step 3: Write the implementation**

Dans `src/telegram.ts`, ajouter en tête de fichier (avec les imports existants) :

```ts
import path from "node:path";
```

Puis dans la section « Pure helpers », après `parseCommand` :

```ts
/** A downloadable attachment found in a Telegram message. */
export interface TgAttachment {
  fileId: string;
  fileUniqueId: string;
  kind: "image" | "file";
  fileName?: string; // original name (documents only)
  fileSize?: number; // bytes, when Telegram provides it
}

/** Extract the attachment of a message: a photo (largest size — Telegram
 *  sorts sizes small → large) or any document (PDF, zip, image sent as
 *  file…). Text-only messages → null. */
export function attachmentOf(msg: any): TgAttachment | null {
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { fileId: p.file_id, fileUniqueId: p.file_unique_id, kind: "image", fileSize: p.file_size };
  }
  const d = msg.document;
  if (d?.file_id) {
    return {
      fileId: d.file_id,
      fileUniqueId: d.file_unique_id,
      kind: typeof d.mime_type === "string" && d.mime_type.startsWith("image/") ? "image" : "file",
      ...(d.file_name ? { fileName: d.file_name } : {}),
      ...(d.file_size != null ? { fileSize: d.file_size } : {}),
    };
  }
  return null;
}

/** Storage name under ~/.shadok-ai/media: keep the original name so Claude
 *  has context, prefix with file_unique_id to avoid collisions, and strip
 *  anything path-ish or shell-hostile. */
export function mediaFileName(att: TgAttachment): string {
  const base = att.fileName ? path.basename(att.fileName).replace(/[^\w.\- ]+/g, "_") : "";
  if (base) return `${att.fileUniqueId}-${base}`;
  return att.kind === "image" ? `${att.fileUniqueId}.jpg` : att.fileUniqueId;
}
```

Attention au test `attachmentOf: photo → …` : l'implémentation avec spreads conditionnels ne met PAS `fileName` sur une photo, et `deepEqual` compare aussi l'absence de clé — c'est voulu. Pour la photo, écrire l'objet littéral sans spread (comme montré) pour que `fileSize` soit toujours présent (même `undefined` serait absent avec `deepEqual` strict — ici `file_size: 5000` est fourni par le test).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/telegram.test.ts`
Expected: PASS (tous, y compris les tests préexistants).

- [ ] **Step 5: Commit**

```bash
git add src/telegram.ts test/telegram.test.ts
git commit -m "Telegram: extract attachments from incoming messages (pure helpers)"
```

---

### Task 2: Construction du prompt (`attachmentPrompt`)

**Files:**
- Modify: `src/telegram.ts` (section « Pure helpers », après `mediaFileName`)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: `attachmentPrompt(items: { path: string; kind: "image" | "file" }[], caption?: string): string`. Utilisé par la Task 4.

- [ ] **Step 1: Write the failing tests**

Ajouter `attachmentPrompt` à l'import de `test/telegram.test.ts`, puis :

```ts
test("attachmentPrompt: image seule", () => {
  assert.equal(attachmentPrompt([{ path: "/m/a.jpg", kind: "image" }]), "[Image jointe : /m/a.jpg]");
});

test("attachmentPrompt: fichier + caption", () => {
  assert.equal(
    attachmentPrompt([{ path: "/m/r.pdf", kind: "file" }], "résume ce doc"),
    "[Fichier joint : /m/r.pdf]\nrésume ce doc",
  );
});

test("attachmentPrompt: plusieurs pièces, caption vide ignorée", () => {
  assert.equal(
    attachmentPrompt(
      [
        { path: "/m/a.jpg", kind: "image" },
        { path: "/m/b.zip", kind: "file" },
      ],
      "  ",
    ),
    "[Image jointe : /m/a.jpg]\n[Fichier joint : /m/b.zip]",
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/telegram.test.ts`
Expected: FAIL — export `attachmentPrompt` manquant.

- [ ] **Step 3: Write the implementation**

Dans `src/telegram.ts`, après `mediaFileName` :

```ts
/** The prompt sent to the session for downloaded attachments: one absolute
 *  path per line (Claude reads them itself — Read for images/PDF/text,
 *  Bash for the rest), then the user's caption if any. */
export function attachmentPrompt(items: { path: string; kind: "image" | "file" }[], caption?: string): string {
  const lines = items.map((i) => (i.kind === "image" ? `[Image jointe : ${i.path}]` : `[Fichier joint : ${i.path}]`));
  return caption?.trim() ? lines.join("\n") + "\n" + caption : lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/telegram.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram.ts test/telegram.test.ts
git commit -m "Telegram: build the session prompt for downloaded attachments"
```

---

### Task 3: Buffer d'albums (`makeAlbumBuffer`)

**Files:**
- Modify: `src/telegram.ts` (section « Pure helpers », après `makeTyping`)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: `makeAlbumBuffer<T>(flush: (groupId: string, items: T[]) => void, delayMs?: number): { add: (groupId: string, item: T) => void }` (délai par défaut 1500 ms). Utilisé par la Task 4.

- [ ] **Step 1: Write the failing tests**

Ajouter `makeAlbumBuffer` à l'import, puis (tests asynchrones avec un délai court — pas de mock de timers, cohérent avec le style du fichier) :

```ts
test("makeAlbumBuffer: regroupe les items d'un même album en un seul flush", async () => {
  const flushed: [string, number[]][] = [];
  const buf = makeAlbumBuffer<number>((gid, items) => flushed.push([gid, items]), 30);
  buf.add("g1", 1);
  buf.add("g1", 2);
  buf.add("g1", 3);
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(flushed, [["g1", [1, 2, 3]]]);
});

test("makeAlbumBuffer: chaque add réarme le timer (pas de flush partiel)", async () => {
  const flushed: number[][] = [];
  const buf = makeAlbumBuffer<number>((_gid, items) => flushed.push(items), 40);
  buf.add("g", 1);
  await new Promise((r) => setTimeout(r, 25)); // < délai : pas encore flushé
  buf.add("g", 2); // réarme
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(flushed.length, 0); // 50 ms après le 1er add mais 25 ms après le 2e
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(flushed, [[1, 2]]);
});

test("makeAlbumBuffer: deux albums indépendants", async () => {
  const flushed = new Map<string, string[]>();
  const buf = makeAlbumBuffer<string>((gid, items) => flushed.set(gid, items), 20);
  buf.add("a", "x");
  buf.add("b", "y");
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(flushed.get("a"), ["x"]);
  assert.deepEqual(flushed.get("b"), ["y"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/telegram.test.ts`
Expected: FAIL — export `makeAlbumBuffer` manquant.

- [ ] **Step 3: Write the implementation**

Dans `src/telegram.ts`, après `makeTyping` :

```ts
/** Telegram delivers an album (media_group_id) as separate messages, the
 *  caption often on only one of them. Buffer them per group: each add
 *  re-arms a short timer; when it fires, the whole group is flushed at once
 *  so a 3-photo album costs one turn, not three. */
export function makeAlbumBuffer<T>(
  flush: (groupId: string, items: T[]) => void,
  delayMs = 1500,
): { add: (groupId: string, item: T) => void } {
  const groups = new Map<string, { items: T[]; timer: NodeJS.Timeout }>();
  return {
    add(groupId, item) {
      const g = groups.get(groupId);
      if (g) {
        g.items.push(item);
        g.timer.refresh();
        return;
      }
      const items = [item];
      const timer = setTimeout(() => {
        groups.delete(groupId);
        flush(groupId, items);
      }, delayMs);
      timer.unref?.(); // ne jamais retenir le process pour un buffer
      groups.set(groupId, { items, timer });
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/telegram.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram.ts test/telegram.test.ts
git commit -m "Telegram: album buffer — one flush (one turn) per media group"
```

---

### Task 4: Runtime — téléchargement, purge, branchement dans handleMessage

Pas de test unitaire ici (réseau + fs, convention du repo) : la vérification est `npm run build` + le test de bout en bout de la Task 5.

**Files:**
- Modify: `src/telegram.ts` — imports, constantes module, closure `startTelegram` (purge + `downloadAttachment` + buffer d'albums), `handleMessage` (~ligne 391).

**Interfaces:**
- Consumes: `TgAttachment`, `attachmentOf`, `mediaFileName`, `attachmentPrompt`, `makeAlbumBuffer` (Tasks 1-3) ; `SHADOK_DIR` de `./config.js` ; `tg`, `reply`, `bridgeFor`, `promptTo`, `Bridge` existants.
- Produces: comportement final ; rien d'exporté en plus.

- [ ] **Step 1: Imports et constantes**

En tête de `src/telegram.ts`, compléter les imports (l'import `path` existe depuis la Task 1) :

```ts
import fs from "node:fs";
import { SHADOK_DIR } from "./config.js";
```

Sous `const MSG_LIMIT = 4000; …` ajouter :

```ts
// Downloaded Telegram attachments live OUTSIDE any repo/worktree (never in a
// diff, never committed by accident). Claude reads them by absolute path.
const MEDIA_DIR = path.join(SHADOK_DIR, "media");
const TG_FILE_LIMIT = 20 * 1024 * 1024; // Bot API getFile hard limit
const MEDIA_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // purge after 30 days
```

- [ ] **Step 2: Purge au démarrage + downloadAttachment dans startTelegram**

Dans `startTelegram`, juste après la déclaration de `const tg = …` (≈ ligne 197), ajouter :

```ts
  // Purge old attachments at startup — media/ only grows otherwise.
  try {
    const cutoff = Date.now() - MEDIA_MAX_AGE_MS;
    for (const name of fs.readdirSync(MEDIA_DIR)) {
      const p = path.join(MEDIA_DIR, name);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {
    // dossier absent : rien à purger
  }

  /** Download one attachment to MEDIA_DIR; returns the absolute path.
   *  Throws with a user-facing (French) reason on any failure. */
  const downloadAttachment = async (att: TgAttachment): Promise<string> => {
    if (att.fileSize && att.fileSize > TG_FILE_LIMIT)
      throw new Error("fichier trop gros (limite Telegram bot : 20 Mo)");
    const f = await tg("getFile", { file_id: att.fileId });
    if (!f?.ok) throw new Error(f?.description ?? "getFile a échoué");
    const r = await fetch(`https://api.telegram.org/file/bot${token}/${f.result.file_path}`);
    if (!r.ok) throw new Error(`téléchargement HTTP ${r.status}`);
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const dest = path.join(MEDIA_DIR, mediaFileName(att));
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    return dest;
  };
```

- [ ] **Step 3: Flush d'album**

Toujours dans `startTelegram`, après la déclaration de `promptTo` (≈ ligne 367) — il utilise `reply` déclaré juste après, donc placer le buffer **après `reply`** (≈ ligne 377) :

```ts
  // A flushed album: download everything, then ONE prompt with all the paths.
  // One failed file doesn't sink the album — it's reported, the rest is sent.
  const albums = makeAlbumBuffer<{ b: Bridge; att: TgAttachment; caption?: string }>(async (_gid, items) => {
    const b = items[0].b;
    const caption = items.find((i) => i.caption)?.caption;
    const ok: { path: string; kind: "image" | "file" }[] = [];
    const failed: string[] = [];
    for (const i of items) {
      try {
        ok.push({ path: await downloadAttachment(i.att), kind: i.att.kind });
      } catch (e: any) {
        failed.push(`${i.att.fileName ?? i.att.fileUniqueId} (${e?.message ?? e})`);
      }
    }
    if (failed.length) reply(b.chatId, b.threadId, "⚠️ téléchargement raté : " + failed.join(", "));
    if (ok.length) promptTo(b, attachmentPrompt(ok, caption));
    else b.typing.stop(); // rien à envoyer : ne pas laisser « typing » tourner
  });
```

- [ ] **Step 4: Brancher handleMessage**

Dans `handleMessage` (≈ ligne 391), remplacer :

```ts
  const handleMessage = async (msg: any) => {
    if (typeof msg.text !== "string") return;
```

par :

```ts
  const handleMessage = async (msg: any) => {
    const att = attachmentOf(msg);
    if (typeof msg.text !== "string" && !att) return;
```

Remplacer la ligne `const cmd = parseCommand(msg.text);` (≈ ligne 400) par :

```ts
    // Commands only exist in text messages — a caption is never a command.
    const cmd = typeof msg.text === "string" ? parseCommand(msg.text) : null;
```

Puis remplacer la fin de la fonction (≈ lignes 534-541) :

```ts
    // Optimistic typing: start the heartbeat now, before the server confirms
    // anything — spawning/resuming a session can take tens of seconds and the
    // first "working" only arrives after it. Every terminal outcome stops it
    // (turn-done, dialog, pace-blocked, exited, ws close).
    const b = bridgeFor(key, chat.id, threadId, topicName);
    b.typing.start();
    promptTo(b, msg.text);
  };
```

par :

```ts
    // Optimistic typing: start the heartbeat now, before the server confirms
    // anything — spawning/resuming a session can take tens of seconds and the
    // first "working" only arrives after it. Every terminal outcome stops it
    // (turn-done, dialog, pace-blocked, exited, ws close).
    const b = bridgeFor(key, chat.id, threadId, topicName);
    b.typing.start();

    if (att) {
      const caption = typeof msg.caption === "string" ? msg.caption : undefined;
      if (msg.media_group_id) {
        // Album: buffer, flushed as ONE prompt once the group settles.
        albums.add(`${key}:${msg.media_group_id}`, { b, att, caption });
        return;
      }
      try {
        const p = await downloadAttachment(att);
        promptTo(b, attachmentPrompt([{ path: p, kind: att.kind }], caption));
      } catch (e: any) {
        b.typing.stop();
        await reply(
          chat.id,
          threadId,
          `⚠️ je n'ai pas pu télécharger ${att.fileName ?? "la pièce jointe"} (${e?.message ?? e})`,
        );
      }
      return;
    }
    promptTo(b, msg.text);
  };
```

- [ ] **Step 5: Build + suite complète**

Run: `npm run build && npm test`
Expected: build OK (0 erreur tsc), tous les tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/telegram.ts
git commit -m "Telegram: photos & files are downloaded and pasted into the session"
```

---

### Task 5: Vérification de bout en bout + restart serveur

**Files:** aucun (vérification manuelle, spec § Tests).

- [ ] **Step 1: Rebuild + restart du serveur dans sa session tmux dédiée**

```bash
npm run build
tmux kill-session -t shadok-ai-server 2>/dev/null; sleep 1
tmux new-session -d -s shadok-ai-server \
  "cd ~/projects/shadok-ai && CLAUDE_CODE_OAUTH_TOKEN=\$(security find-generic-password -s 'Claude Code-credentials' -a \"\$USER\" -w | jq -r '.claudeAiOauth.accessToken') node dist/server.js > /tmp/cp.log 2>&1"
sleep 3; curl -s -o /dev/null -w '%{http_code}\n' localhost:3789/
```

Expected: `200`. Sinon, lire `/tmp/cp.log`.

⚠️ Ce restart tue les sessions PTY en cours (invariant n°7 du CLAUDE.md) — c'est l'humain/top-level qui décide du moment, pas un sous-agent.

- [ ] **Step 2: Tests manuels dans Telegram** (l'utilisateur, guidé)

1. Photo avec caption « décris cette image » → la session lit l'image et répond sur son contenu.
2. Photo sans caption → prompt `[Image jointe : …]` seul, la session réagit.
3. Un PDF en document avec caption → la session lit le PDF.
4. Une image envoyée « en fichier » (sans compression) → traitée comme image.
5. Album de 2-3 photos avec une caption → **un seul** tour avec tous les chemins.
6. Fichier > 20 Mo → reply `⚠️ … (fichier trop gros (limite Telegram bot : 20 Mo))`, rien envoyé à Claude.
7. Vérifier `ls ~/.shadok-ai/media/` : fichiers présents, nommés `<uid>-<nom>`.

- [ ] **Step 3: Vérifier `/tmp/cp.log`** — pas d'erreur non gérée pendant les tests.

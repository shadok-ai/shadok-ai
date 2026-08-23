# Telegram File Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An image or a file dropped into a Telegram chat/topic is downloaded and "pasted" into the bound Claude Code session (an absolute path in the prompt).

**Architecture:** Everything lives in `src/telegram.ts`: pure helpers (extracting the message's attachment, the storage file name, building the prompt, an album buffer) unit-tested, and the runtime (downloading through the Bot API, the purge, the wiring in `handleMessage`) inside the `startTelegram` closure. No server or WS protocol change — we go through the existing `prompt` message. Spec: `docs/superpowers/specs/2026-07-23-telegram-file-attachments-design.md`.

**Tech Stack:** TypeScript ESM (NodeNext, imports en `.js`), Node ≥ 20, tests `node:test` + `assert/strict` via tsx.

## Global Constraints

- Relative imports with a `.js` extension (NodeNext); e.g. `import { SHADOK_DIR } from "./config.js"`.
- Stockage : `~/.shadok-ai/media/` (`path.join(SHADOK_DIR, "media")`).
- Limite Telegram Bot API `getFile` : 20 Mo (`20 * 1024 * 1024`).
- Purge: files in `media/` older than 30 days, when the bridge starts.
- Comments: explain the **why**, in English (the repo's convention).
- Tests: `npm test` (the whole suite) or targeted, `node --import tsx --test test/telegram.test.ts`.
- The runtime code (network fetch, fs) is NOT unit-tested in this repo — only the pure helpers are (`telegram.ts`'s existing convention).

---

### Task 1: Extracting the attachment (`attachmentOf`, `mediaFileName`)

**Files:**
- Modify: `src/telegram.ts` (the "Pure helpers" section, after `parseCommand`, ~line 52)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: rien (helpers purs).
- Produces: `interface TgAttachment { fileId: string; fileUniqueId: string; kind: "image" | "file"; fileName?: string; fileSize?: number }`, `attachmentOf(msg: any): TgAttachment | null`, `mediaFileName(att: TgAttachment): string`. Used by Tasks 3 and 4.

- [ ] **Step 1: Write the failing tests**

In `test/telegram.test.ts`, add `attachmentOf, mediaFileName` to the existing import then, at the end of the file:

```ts
test("attachmentOf: photo → the largest size, kind image", () => {
  const att = attachmentOf({
    photo: [
      { file_id: "small", file_unique_id: "u1", file_size: 100 },
      { file_id: "big", file_unique_id: "u2", file_size: 5000 },
    ],
  });
  assert.deepEqual(att, { fileId: "big", fileUniqueId: "u2", kind: "image", fileSize: 5000 });
});

test("attachmentOf: document image/* → kind image, keeps the name", () => {
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

test("mediaFileName: original name prefixed by the unique id, sanitised", () => {
  assert.equal(
    mediaFileName({ fileId: "f", fileUniqueId: "AQAD", kind: "file", fileName: "../é vil/final report.pdf" }),
    "AQAD-rapport final.pdf",
  );
});

test("mediaFileName: an unnamed photo → .jpg; an unnamed file → the bare id", () => {
  assert.equal(mediaFileName({ fileId: "f", fileUniqueId: "AQAD", kind: "image" }), "AQAD.jpg");
  assert.equal(mediaFileName({ fileId: "f", fileUniqueId: "AQAD", kind: "file" }), "AQAD");
});
```

Note: `"../é vil/final report.pdf"` → `path.basename` gives `"final report.pdf"` (are the space and accented letters kept by a unicode `\w`? No — see Step 3: the sanitising regex replaces every character outside `[\w.\- ]` with `_`, and `é` is not in ASCII `\w`. The basename here is `final report.pdf`, which contains only safe characters, so it is unchanged).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/telegram.test.ts`
Expected: FAIL — `attachmentOf` / `mediaFileName` are not exported (`SyntaxError: The requested module ... does not provide an export named 'attachmentOf'`).

- [ ] **Step 3: Write the implementation**

In `src/telegram.ts`, add at the top of the file (with the existing imports):

```ts
import path from "node:path";
```

Then in the "Pure helpers" section, after `parseCommand`:

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

Mind the `attachmentOf: photo → …` test: the implementation with conditional spreads does NOT put `fileName` on a photo, and `deepEqual` also compares the absence of a key — that is intended. For the photo, write the object literal without a spread (as shown) so `fileSize` is always present (even `undefined` would be absent under strict `deepEqual` — here `file_size: 5000` is supplied by the test).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/telegram.test.ts`
Expected: PASS (all of them, including the pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/telegram.ts test/telegram.test.ts
git commit -m "Telegram: extract attachments from incoming messages (pure helpers)"
```

---

### Task 2: Construction du prompt (`attachmentPrompt`)

**Files:**
- Modify: `src/telegram.ts` (the "Pure helpers" section, after `mediaFileName`)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: `attachmentPrompt(items: { path: string; kind: "image" | "file" }[], caption?: string): string`. Used by Task 4.

- [ ] **Step 1: Write the failing tests**

Add `attachmentPrompt` to `test/telegram.test.ts`'s import, then:

```ts
test("attachmentPrompt: image seule", () => {
  assert.equal(attachmentPrompt([{ path: "/m/a.jpg", kind: "image" }]), "[Image jointe : /m/a.jpg]");
});

test("attachmentPrompt: fichier + caption", () => {
  assert.equal(
    attachmentPrompt([{ path: "/m/r.pdf", kind: "file" }], "summarise this doc"),
    "[Attached file: /m/r.pdf]\nsummarise this doc",
  );
});

test("attachmentPrompt: several attachments, an empty caption ignored", () => {
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

In `src/telegram.ts`, after `mediaFileName`:

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
- Modify: `src/telegram.ts` (the "Pure helpers" section, after `makeTyping`)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: `makeAlbumBuffer<T>(flush: (groupId: string, items: T[]) => void, delayMs?: number): { add: (groupId: string, item: T) => void }` (default delay 1500 ms). Used by Task 4.

- [ ] **Step 1: Write the failing tests**

Add `makeAlbumBuffer` to the import, then (async tests with a short delay — no timer mocking, consistent with the file's style):

```ts
test("makeAlbumBuffer: groups one album's items into a single flush", async () => {
  const flushed: [string, number[]][] = [];
  const buf = makeAlbumBuffer<number>((gid, items) => flushed.push([gid, items]), 30);
  buf.add("g1", 1);
  buf.add("g1", 2);
  buf.add("g1", 3);
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(flushed, [["g1", [1, 2, 3]]]);
});

test("makeAlbumBuffer: every add rearms the timer (no partial flush)", async () => {
  const flushed: number[][] = [];
  const buf = makeAlbumBuffer<number>((_gid, items) => flushed.push(items), 40);
  buf.add("g", 1);
  await new Promise((r) => setTimeout(r, 25)); // < the delay: not flushed yet
  buf.add("g", 2); // rearms
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(flushed.length, 0); // 50 ms after the 1st add but 25 ms after the 2nd
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(flushed, [[1, 2]]);
});

test("makeAlbumBuffer: two independent albums", async () => {
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

In `src/telegram.ts`, after `makeTyping`:

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
      timer.unref?.(); // never hold the process open for a buffer
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

### Task 4: Runtime — download, purge, wiring into handleMessage

No unit test here (network + fs, the repo's convention): the verification is `npm run build` + Task 5's end-to-end test.

**Files:**
- Modify: `src/telegram.ts` — imports, constantes module, closure `startTelegram` (purge + `downloadAttachment` + buffer d'albums), `handleMessage` (~ligne 391).

**Interfaces:**
- Consumes: `TgAttachment`, `attachmentOf`, `mediaFileName`, `attachmentPrompt`, `makeAlbumBuffer` (Tasks 1-3) ; `SHADOK_DIR` de `./config.js` ; `tg`, `reply`, `bridgeFor`, `promptTo`, `Bridge` existants.
- Produces: the final behaviour; nothing extra exported.

- [ ] **Step 1: Imports et constantes**

At the top of `src/telegram.ts`, complete the imports (the `path` import exists since Task 1):

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

- [ ] **Step 2: The startup purge + downloadAttachment inside startTelegram**

In `startTelegram`, right after the `const tg = …` declaration (≈ line 197), add:

```ts
  // Purge old attachments at startup — media/ only grows otherwise.
  try {
    const cutoff = Date.now() - MEDIA_MAX_AGE_MS;
    for (const name of fs.readdirSync(MEDIA_DIR)) {
      const p = path.join(MEDIA_DIR, name);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {
    // folder missing: nothing to purge
  }

  /** Download one attachment to MEDIA_DIR; returns the absolute path.
   *  Throws with a user-facing reason on any failure. */
  const downloadAttachment = async (att: TgAttachment): Promise<string> => {
    if (att.fileSize && att.fileSize > TG_FILE_LIMIT)
      throw new Error("fichier trop gros (limite Telegram bot : 20 Mo)");
    const f = await tg("getFile", { file_id: att.fileId });
    if (!f?.ok) throw new Error(f?.description ?? "getFile failed");
    const r = await fetch(`https://api.telegram.org/file/bot${token}/${f.result.file_path}`);
    if (!r.ok) throw new Error(`download HTTP ${r.status}`);
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const dest = path.join(MEDIA_DIR, mediaFileName(att));
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    return dest;
  };
```

- [ ] **Step 3: Flush d'album**

Still in `startTelegram`, after the `promptTo` declaration (≈ line 367) — it uses `reply`, declared right after, so place the buffer **after `reply`** (≈ line 377):

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
    if (failed.length) reply(b.chatId, b.threadId, "⚠️ download failed: " + failed.join(", "));
    if (ok.length) promptTo(b, attachmentPrompt(ok, caption));
    else b.typing.stop(); // nothing to send: do not leave "typing" running
  });
```

- [ ] **Step 4: Brancher handleMessage**

In `handleMessage` (≈ line 391), replace:

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

Replace the `const cmd = parseCommand(msg.text);` line (≈ line 400) with:

```ts
    // Commands only exist in text messages — a caption is never a command.
    const cmd = typeof msg.text === "string" ? parseCommand(msg.text) : null;
```

Then replace the end of the function (≈ lines 534-541):

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
          `⚠️ could not download ${att.fileName ?? "the attachment"} (${e?.message ?? e})`,
        );
      }
      return;
    }
    promptTo(b, msg.text);
  };
```

- [ ] **Step 5: Build + the whole suite**

Run: `npm run build && npm test`
Expected: build OK (0 tsc errors), every test PASSes.

- [ ] **Step 6: Commit**

```bash
git add src/telegram.ts
git commit -m "Telegram: photos & files are downloaded and pasted into the session"
```

---

### Task 5: End-to-end verification + a server restart

**Files:** none (manual verification, the spec's Tests section).

- [ ] **Step 1: Rebuild + restart the server in its dedicated tmux session**

```bash
npm run build
tmux kill-session -t shadok-ai-server 2>/dev/null; sleep 1
tmux new-session -d -s shadok-ai-server \
  "cd ~/projects/shadok-ai && CLAUDE_CODE_OAUTH_TOKEN=\$(security find-generic-password -s 'Claude Code-credentials' -a \"\$USER\" -w | jq -r '.claudeAiOauth.accessToken') node dist/server.js > /tmp/cp.log 2>&1"
sleep 3; curl -s -o /dev/null -w '%{http_code}\n' localhost:3789/
```

Expected: `200`. Sinon, lire `/tmp/cp.log`.

⚠️ This restart kills the running PTY sessions (invariant #7 of CLAUDE.md) — the human/top level decides when, not a subagent.

- [ ] **Step 2: Manual tests in Telegram** (the user, guided)

1. A photo with the caption "describe this image" → the session reads the image and answers about its content.
2. A photo with no caption → the `[Attached image: …]` prompt alone, the session reacts.
3. A PDF as a document with a caption → the session reads the PDF.
4. An image sent "as a file" (uncompressed) → handled as an image.
5. An album of 2-3 photos with a caption → **a single** turn with every path.
6. A file over 20 MB → the reply `⚠️ … (file too large (Telegram bot limit: 20 MB))`, nothing sent to Claude.
7. Check `ls ~/.shadok-ai/media/`: the files are there, named `<uid>-<name>`.

- [ ] **Step 3: Check `/tmp/cp.log`** — no unhandled error during the tests.

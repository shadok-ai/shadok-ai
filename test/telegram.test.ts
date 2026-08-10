import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldReattachBridge,
  bindKey,
  chunk,
  parseCommand,
  dialogKeyboard,
  parseCallback,
  makeTyping,
  mdToTelegramHtml,
  attachmentOf,
  mediaFileName,
  attachmentPrompt,
  makeAlbumBuffer,
  migratedGroupId,
  prefaceMatches,
  isStalePreface,
  promptEchoLabel,
  dmGate,
  makeSendQueue,
  nextToolsState,
  isFreetextOption,
  shouldAnnounceLoggedOut,
} from "../src/telegram.js";

test("migratedGroupId: follows the bound board group to its new supergroup id", () => {
  const msg = { chat: { id: -100 }, migrate_to_chat_id: -1009999 };
  assert.equal(migratedGroupId(msg, -100), -1009999);
});

test("migratedGroupId: ignores a migration of a group that isn't the bound one", () => {
  const msg = { chat: { id: -55 }, migrate_to_chat_id: -1009999 };
  assert.equal(migratedGroupId(msg, -100), null);
});

test("migratedGroupId: a plain message (no migrate field) yields null", () => {
  assert.equal(migratedGroupId({ chat: { id: -100 }, text: "hi" }, -100), null);
  assert.equal(migratedGroupId({ chat: { id: -100 }, migrate_to_chat_id: "x" }, -100), null);
  assert.equal(migratedGroupId({ chat: { id: -100 }, migrate_to_chat_id: -1 }, null), null);
});

test("bindKey: DM, group, and forum topic map to distinct keys", () => {
  assert.equal(bindKey({ id: 42, type: "private" }), "private:42");
  assert.equal(bindKey({ id: -100, type: "supergroup" }), "group:-100");
  assert.equal(bindKey({ id: -100, type: "supergroup" }, 7), "topic:-100:7");
});

test("chunk: short text is one piece", () => {
  assert.deepEqual(chunk("hello", 4000), ["hello"]);
});

test("chunk: long text splits under the limit, preferring newlines", () => {
  const line = "x".repeat(30);
  const text = Array.from({ length: 200 }, () => line).join("\n"); // ~6000 chars
  const parts = chunk(text, 4000);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 4000));
  assert.equal(parts.join("\n"), text); // lossless reassembly
});

test("chunk: a single very long line is hard-cut", () => {
  const parts = chunk("y".repeat(9000), 4000);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length <= 4000));
  assert.equal(parts.join(""), "y".repeat(9000));
});

test("parseCommand: recognizes commands, args, and @botname suffix", () => {
  assert.deepEqual(parseCommand("/new"), { cmd: "new", arg: "" });
  assert.deepEqual(parseCommand("/spawn my agent"), { cmd: "spawn", arg: "my agent" });
  assert.deepEqual(parseCommand("/list@shadokai_bot"), { cmd: "list", arg: "" });
});

test("nextToolsState: /tools alone toggles", () => {
  assert.equal(nextToolsState("", false), true);
  assert.equal(nextToolsState("", true), false);
});

test("nextToolsState: on/off force the state, whatever the current one", () => {
  assert.equal(nextToolsState("on", false), true);
  assert.equal(nextToolsState("ON", true), true);
  assert.equal(nextToolsState("off", true), false);
  assert.equal(nextToolsState(" Off ", false), false);
});

test("nextToolsState: an argument that is neither on nor off just toggles", () => {
  // La commande ne doit pas devenir une énigme de syntaxe : /tools yes bascule.
  assert.equal(nextToolsState("yes", false), true);
  assert.equal(nextToolsState("wat", true), false);
});

test("promptEchoLabel: chaque origine a sa marque", () => {
  assert.equal(promptEchoLabel("web"), "👤 web");
  assert.equal(promptEchoLabel("cron"), "⏰ cron");
  assert.equal(promptEchoLabel("cli"), "⌨️ cli");
});

test("promptEchoLabel: une origine inconnue reste marquée, sans mentir", () => {
  // Mieux vaut « quelqu'un a parlé » qu'un message qui semble venir de l'agent.
  assert.equal(promptEchoLabel(undefined), "👤");
  assert.equal(promptEchoLabel("pilotctl"), "👤 pilotctl");
});

test("promptEchoLabel: la reprise automatique du pace guard n'est pas un humain", () => {
  assert.equal(promptEchoLabel("web", true), "⚙️ reprise automatique");
  assert.equal(promptEchoLabel(undefined, true), "⚙️ reprise automatique");
});

test("dmGate: le premier à écrire en DM devient le propriétaire", () => {
  assert.equal(dmGate(null, 4242), "claim");
});

test("dmGate: le propriétaire passe, les autres sont refusés", () => {
  assert.equal(dmGate(4242, 4242), "allow");
  assert.equal(dmGate(4242, 9999), "deny");
});

test("dmGate: un expéditeur inconnu est refusé, même sans propriétaire", () => {
  // Pas d'id = rien à revendiquer et personne à reconnaître : on n'ouvre pas.
  assert.equal(dmGate(null, undefined), "deny");
  assert.equal(dmGate(4242, undefined), "deny");
});

test("parseCommand: plain text is not a command", () => {
  assert.equal(parseCommand("hello there"), null);
  assert.equal(parseCommand("what is /usr/bin?"), null);
});

test("dialogKeyboard: single-select → one 'choose' button per option, no submit", () => {
  const kb = dialogKeyboard({
    question: "Q?",
    multi: false,
    options: [
      { n: 1, label: "Alpha" },
      { n: 2, label: "Beta" },
    ],
  });
  assert.equal(kb.inline_keyboard.length, 2);
  assert.deepEqual(kb.inline_keyboard[0][0], { text: "1. Alpha", callback_data: "d:1" });
  assert.deepEqual(kb.inline_keyboard[1][0], { text: "2. Beta", callback_data: "d:2" });
});

test("isFreetextOption: only the AskUserQuestion free-form entry", () => {
  // Même règle que le web (index.html) : les deux clients doivent s'accorder.
  assert.equal(isFreetextOption("Type something"), true);
  assert.equal(isFreetextOption("Type something else"), true);
  assert.equal(isFreetextOption("type something."), true);
  assert.equal(isFreetextOption("Chat about this"), false);
  assert.equal(isFreetextOption("Finir le toggle /tools"), false);
});

test("dialogKeyboard: the free-form option gets its own 'f:' callback", () => {
  const kb = dialogKeyboard({
    question: "Q?",
    multi: false,
    options: [
      { n: 1, label: "Alpha" },
      { n: 2, label: "Type something" },
    ],
  });
  assert.equal(kb.inline_keyboard[0][0].callback_data, "d:1");
  assert.equal(kb.inline_keyboard[1][0].callback_data, "f:2");
});

test("dialogKeyboard: a free-form option in a multi-select is still free-form", () => {
  const kb = dialogKeyboard({
    question: "Q?",
    multi: true,
    options: [
      { n: 1, label: "A", checked: false },
      { n: 2, label: "Type something", checked: false },
    ],
  });
  assert.equal(kb.inline_keyboard[0][0].callback_data, "t:1");
  assert.equal(kb.inline_keyboard[1][0].callback_data, "f:2");
  const last = kb.inline_keyboard[kb.inline_keyboard.length - 1][0];
  assert.equal(last.callback_data, "s");
});

test("dialogKeyboard: multi-select → toggle buttons with ☑/☐ + a Submit row", () => {
  const kb = dialogKeyboard({
    question: "Q?",
    multi: true,
    options: [
      { n: 1, label: "A", checked: true },
      { n: 2, label: "B", checked: false },
    ],
  });
  assert.match(kb.inline_keyboard[0][0].text, /^☑ 1\. A/);
  assert.equal(kb.inline_keyboard[0][0].callback_data, "t:1");
  assert.match(kb.inline_keyboard[1][0].text, /^☐ 2\. B/);
  const last = kb.inline_keyboard[kb.inline_keyboard.length - 1][0];
  assert.deepEqual(last, { text: "✅ Submit", callback_data: "s" });
});

test("makeTyping: start beats immediately, then on every interval", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let beats = 0;
  const typing = makeTyping(() => beats++, 4000);
  typing.start();
  assert.equal(beats, 1); // immediate first beat — no 4s wait for the indicator
  t.mock.timers.tick(4000);
  assert.equal(beats, 2);
  t.mock.timers.tick(8000);
  assert.equal(beats, 4);
  typing.stop();
});

test("makeTyping: start while already beating does not double the pulse", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let beats = 0;
  const typing = makeTyping(() => beats++, 4000);
  typing.start();
  typing.start(); // e.g. two "working" events in a row
  assert.equal(beats, 1);
  t.mock.timers.tick(4000);
  assert.equal(beats, 2);
  typing.stop();
});

test("makeTyping: stop halts the pulse and is idempotent; restart works", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let beats = 0;
  const typing = makeTyping(() => beats++, 4000);
  typing.start();
  typing.stop();
  typing.stop(); // turn-done then exited must not throw
  t.mock.timers.tick(20000);
  assert.equal(beats, 1); // only the immediate beat, nothing after stop
  typing.start(); // next turn
  assert.equal(beats, 2);
  typing.stop();
});

test("parseCallback: choose / toggle / confirm, and garbage → null", () => {
  assert.deepEqual(parseCallback("d:3"), { kind: "choose", n: 3 });
  assert.deepEqual(parseCallback("t:2"), { kind: "toggle", n: 2 });
  assert.deepEqual(parseCallback("s"), { kind: "confirm" });
  assert.deepEqual(parseCallback("f:4"), { kind: "freetext", n: 4 });
  assert.equal(parseCallback("x:1"), null);
  assert.equal(parseCallback("f:"), null);
  assert.equal(parseCallback(""), null);
});

test("mdToTelegramHtml: bold/italic/inline code, digits untouched", () => {
  assert.equal(
    mdToTelegramHtml("**b** and *i* and `c` and 3 files"),
    "<b>b</b> and <i>i</i> and <code>c</code> and 3 files",
  );
});

test("mdToTelegramHtml: heading → bold, bullets → •, links", () => {
  assert.equal(
    mdToTelegramHtml("# Title\n- a\n- b\n[t](https://x.com)"),
    '<b>Title</b>\n• a\n• b\n<a href="https://x.com">t</a>',
  );
});

test("mdToTelegramHtml: code fence content is escaped, not reformatted", () => {
  assert.equal(
    mdToTelegramHtml("```js\nconst x = 1 < 2 && *y*;\n```"),
    "<pre>const x = 1 &lt; 2 &amp;&amp; *y*;</pre>",
  );
});

test("mdToTelegramHtml: bare <>& are escaped so the HTML is well-formed", () => {
  assert.equal(mdToTelegramHtml("a <b> & c"), "a &lt;b&gt; &amp; c");
});

test("mdToTelegramHtml: a lone marker stays literal (no unbalanced tag)", () => {
  assert.equal(mdToTelegramHtml("2 * 3 = 6"), "2 * 3 = 6");
});

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

// ── Préface d'un dialog (voir docs/superpowers/specs/2026-07-28-telegram-dialog-preface-design.md)

test("prefaceMatches: le texte autoritatif redonde la préface dé-wrappée", () => {
  // L'écran a replié le paragraphe sur 3 lignes ; extractLiveText les a
  // rejointes par des espaces. Le .jsonl, lui, garde les vrais sauts de ligne.
  const preface = "Voici une introduction assez longue qui explique le contexte avant la question.";
  const authoritative = "Voici une introduction assez longue\nqui explique le contexte\navant la question.";
  assert.equal(prefaceMatches(preface, authoritative), true);
});

test("prefaceMatches: préface tronquée par le défilement = fragment interne", () => {
  const authoritative = "Un préambule qui a défilé hors de l'écran.\n\nPuis la partie encore visible en bas.";
  assert.equal(prefaceMatches("Puis la partie encore visible en bas.", authoritative), true);
});

test("isStalePreface: une préface déjà diffusée est périmée", () => {
  // Le cas reproduit : l'écran montre encore la réponse du tour précédent quand
  // la question suivante s'affiche. La reposter ferait un doublon définitif.
  const recent = ["Un premier bloc sans rapport particulier.", "MARQUEUR-UNIQUE-42 est la réponse attendue ici."];
  assert.equal(isStalePreface("MARQUEUR-UNIQUE-42 est la réponse attendue ici.", recent), true);
});

test("isStalePreface: la forme rendue à l'écran est reconnue comme le même bloc", () => {
  // L'écran aplatit le Markdown et replie les lignes ; seul le squelette
  // alphanumérique est commun aux deux formes (cf. prefaceMatches).
  const authoritative = "Voici une **introduction** assez longue\nqui explique le contexte.";
  assert.equal(isStalePreface("Voici une introduction assez longue qui explique le contexte.", [authoritative]), true);
});

test("isStalePreface: une préface inédite passe", () => {
  const recent = ["Un bloc déjà diffusé, suffisamment long pour s'apparier."];
  assert.equal(isStalePreface("Je vais te poser une question sur la suite du travail.", recent), false);
});

test("isStalePreface: sans bloc connu, rien n'est périmé", () => {
  assert.equal(isStalePreface("Une préface parfaitement légitime et assez longue.", []), false);
});

test("isStalePreface: une réponse COURTE déjà diffusée est périmée elle aussi", () => {
  // Le plancher de prefaceMatches (PREFACE_MIN) laissait repasser « OK » et
  // « SENTINELLE-PREFACE-77 » : trop courts pour s'apparier, donc reposés à
  // chaque question. Ici on ne l'applique pas — cf. le commentaire du code.
  assert.equal(isStalePreface("OK", ["OK"]), true);
  assert.equal(isStalePreface("SENTINELLE-PREFACE-77", ["SENTINELLE-PREFACE-77"]), true);
});

test("isStalePreface: un fragment interne d'un bloc déjà diffusé est périmé", () => {
  // La préface tronquée par le défilement n'est qu'un morceau du bloc.
  assert.equal(isStalePreface("encore visible en bas.", ["Un préambule.\n\nPuis la partie encore visible en bas."]), true);
});

test("isStalePreface: une préface vide ne périme rien", () => {
  assert.equal(isStalePreface("", ["un bloc déjà diffusé"]), false);
  assert.equal(isStalePreface("   ", ["un bloc déjà diffusé"]), false);
});

test("prefaceMatches: un texte sans rapport ne matche pas", () => {
  assert.equal(prefaceMatches("Je regarde les pièces concernées.", "Rien à voir avec la préface ici."), false);
});

test("prefaceMatches: une préface trop courte ne matche jamais", () => {
  // Sinon "Bien." s'apparierait à n'importe quel texte le contenant.
  assert.equal(prefaceMatches("Bien.", "Bien. Et voici une longue suite sans rapport."), false);
});

test("prefaceMatches: chaînes vides ou blanches → false", () => {
  assert.equal(prefaceMatches("", "un texte quelconque et suffisamment long"), false);
  assert.equal(prefaceMatches("   \n  ", "un texte quelconque et suffisamment long"), false);
  assert.equal(prefaceMatches("une préface parfaitement valide ici", ""), false);
});

test("makeSendQueue: sérialise malgré des latences décroissantes", async () => {
  const q = makeSendQueue();
  const done: number[] = [];
  const slow = (n: number, ms: number) =>
    q(async () => {
      await new Promise((r) => setTimeout(r, ms));
      done.push(n);
    });
  // Sans file, le 3e (1 ms) finirait avant le 1er (40 ms) : c'est exactement
  // ce qui faisait arriver le clavier avant la préface.
  const all = [slow(1, 40), slow(2, 20), slow(3, 1)];
  await Promise.all(all);
  assert.deepEqual(done, [1, 2, 3]);
});

test("makeSendQueue: un rejet ne bloque pas la suite de la file", async () => {
  const q = makeSendQueue();
  const done: string[] = [];
  const failing = q(async () => {
    throw new Error("Telegram 400");
  });
  const after = q(async () => {
    done.push("après");
  });
  await assert.rejects(failing, /Telegram 400/);
  await after;
  assert.deepEqual(done, ["après"]);
});

test("makeSendQueue: deux files sont indépendantes", async () => {
  const a = makeSendQueue();
  const b = makeSendQueue();
  const order: string[] = [];
  const pa = a(async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push("a");
  });
  const pb = b(async () => {
    order.push("b"); // ne doit pas attendre la file a
  });
  await Promise.all([pa, pb]);
  assert.deepEqual(order, ["b", "a"]);
});

test("prefaceMatches: l'écran rend le Markdown, le transcript le garde en source", () => {
  // LA cause du doublon observé en prod (v0.1.144) : le .jsonl contient les
  // marqueurs Markdown, l'écran ne montre que le rendu (gras en ANSI). Comparer
  // les deux littéralement échouait, donc la préface n'était jamais éditée et
  // le texte autoritatif repartait en second message, après la question.
  const auth =
    "Voici le test grandeur nature. Ce paragraphe est le texte-préface : si le correctif " +
    "fonctionne, tu dois le lire **avant** de voir apparaître le clavier de la question " +
    "ci-dessous — et non après y avoir répondu.";
  const preface = auth.replace(/\*\*/g, ""); // ce que l'écran donne
  assert.equal(prefaceMatches(preface, auth), true);
});

test("prefaceMatches: une divergence tardive (lien, puces) n'empêche pas l'appariement", () => {
  const auth =
    "Le serveur joint la préface au message `dialog`, lue avec la même fonction que la " +
    "preview web ([live-text.js](public/live-text.js)) :\n\n- pas de copie\n- une seule source";
  const preface =
    "Le serveur joint la préface au message dialog, lue avec la même fonction que la " +
    "preview web (live-text.js) : • pas de copie • une seule source";
  assert.equal(prefaceMatches(preface, auth), true);
});

test("prefaceMatches: deux blocs qui divergent dès l'ouverture ne s'apparient pas", () => {
  // Contrepartie de l'empreinte : elle doit rester discriminante. Deux textes
  // qui ne partagent que quelques mots d'amorce ne sont PAS le même bloc.
  const preface = "Voici le résultat de l'analyse du bridge Telegram et de sa file d'envoi.";
  const auth = "Voici le plan de migration de la base de données vers le nouveau schéma.";
  assert.equal(prefaceMatches(preface, auth), false);
});

test("a live agent whose bridge died is reattachable", () => {
  // The case that shipped this fix: a session restarted after a killed pane.
  // Its channel still carries the binding, but `ws.on("close")` had dropped the
  // bridge, and nothing outside `reconcileOnBoot` knew how to rebuild it — so
  // the topic went deaf in the agent → Telegram direction until an unrelated
  // server restart.
  assert.equal(shouldReattachBridge({ chatId: -100, hasBridge: false, sessionAlive: true }), true);
});

test("a dormant channel is NEVER revived just to fill a topic", () => {
  // The load-bearing guard: without it the 5s loop would respawn a `claude`
  // under every idle mirrored channel. Mirroring an idle channel is the topic's
  // job, not a live process's.
  assert.equal(shouldReattachBridge({ chatId: -100, hasBridge: false, sessionAlive: false }), false);
});

test("an already-bridged channel is left alone", () => {
  // Called every 5s: without this the loop would rebuild a working bridge over
  // and over, and each rebuild replays into the topic.
  assert.equal(shouldReattachBridge({ chatId: -100, hasBridge: true, sessionAlive: true }), false);
});

test("no BINDING means nothing to reattach to", () => {
  // A web-only channel: the mirroring path creates its topic, this one must not
  // pretend it already has one. What disqualifies it is the absence of a bound
  // chat — not the absence of a topic (see the General below).
  assert.equal(shouldReattachBridge({ chatId: null, hasBridge: false, sessionAlive: true }), false);
  assert.equal(shouldReattachBridge({ hasBridge: false, sessionAlive: true }), false);
});

test("the group's General is bound too, even with no threadId", () => {
  // The bug this fixes: the main channel lives in the board group's General,
  // which by construction has NO threadId — that is how the code recognises it
  // (`mergeChannels` forces the name "general" on `telegram.threadId == null`).
  // Keying the guard on the topic instead of the binding meant its bridge was
  // never rebuilt once it died: the web channel kept working while Telegram
  // went silent, with no error anywhere.
  assert.equal(shouldReattachBridge({ chatId: -100, threadId: null, hasBridge: false, sessionAlive: true }), true);
});

test("a sign-out is announced once, not on every refused spawn", () => {
  // A five-minute cron would otherwise turn one sign-out into a flood, and a
  // channel that cries wolf gets muted long before the day it is right.
  assert.equal(shouldAnnounceLoggedOut(false, true), true);
  assert.equal(shouldAnnounceLoggedOut(true, true), false);
});

test("with nobody to speak to, the notice is NOT burnt", () => {
  // Telegram off or no board group bound: staying silent is right, but latching
  // the flag here would mean the REAL sign-out is never announced either.
  assert.equal(shouldAnnounceLoggedOut(false, false), false);
});

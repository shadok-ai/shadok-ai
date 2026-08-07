import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import {
  loadChannels,
  upsertChannel,
  removeChannel,
  channelForTelegram,
  loadTgGroup,
  saveTgGroup,
  loadTgOwner,
  saveTgOwner,
  isMirrored,
  loadTgTopics,
  saveTgTopics,
  addTgTopic,
  tgToolsEnabled,
  setTgTools,
} from "./channels.js";
import { secretNames, setSecret, deleteSecret } from "./secrets.js";
import { getProfile, profileNames } from "./profiles.js";
import { tmuxHasSession } from "./tmux.js";
import { randomUUID } from "node:crypto";
import {
  loadCrons,
  upsertCron,
  removeCron,
  resolveCronId,
  nextRunFor,
  cronTimeZone,
  normalizeSchedule,
  scheduleLabel,
  type Cron,
  type CronSchedule,
} from "./crons.js";
import { SHADOK_DIR, loadConfig, telegramConfig } from "./config.js";
import { readAndClearUpdateResult } from "./update-flag.js";
import { UPDATE_EXIT_CODE } from "./supervisor.js";

/**
 * Telegram control bridge. Runs inside the server process (only when
 * TELEGRAM_BOT_TOKEN is set) and connects to the server's own /ws as a plain
 * client — so a Telegram-driven session is the same Live session the web UI
 * sees. See docs/superpowers/specs/2026-07-23-telegram-design.md.
 *
 * Increment 1: DMs (1 chat = 1 session), text prompt → streamed reply,
 * /new /end /list, binding persistence. Topics + dialogs come next.
 */

const MSG_LIMIT = 4000; // Telegram hard limit is 4096; leave headroom.

// Downloaded Telegram attachments live OUTSIDE any repo/worktree (never in a
// diff, never committed by accident). Claude reads them by absolute path.
const MEDIA_DIR = path.join(SHADOK_DIR, "media");
const TG_FILE_LIMIT = 20 * 1024 * 1024; // Bot API getFile hard limit
const MEDIA_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // purge after 30 days

// ── Pure helpers (unit-tested) ───────────────────────────────────────────

/** The binding key for a chat + optional forum topic thread. */
export function bindKey(chat: { id: number; type: string }, threadId?: number): string {
  if (chat.type === "private") return `private:${chat.id}`;
  return threadId ? `topic:${chat.id}:${threadId}` : `group:${chat.id}`;
}

/** Split text into Telegram-sized chunks, preferring line boundaries. */
export function chunk(text: string, max = MSG_LIMIT): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max; // no nearby newline: hard cut
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/** Parse a leading bot command: "/spawn foo" → {cmd:"spawn", arg:"foo"}. */
export function parseCommand(text: string): { cmd: string; arg: string } | null {
  const m = text.match(/^\/([a-z]+)(?:@\w+)?\s*(.*)$/is);
  return m ? { cmd: m[1].toLowerCase(), arg: m[2].trim() } : null;
}

/**
 * L'état visé par `/tools [on|off]` : `on`/`off` forcent, tout le reste — y
 * compris l'absence d'argument — bascule. Une commande de confort ne doit pas
 * devenir une énigme de syntaxe : `/tools yes` bascule plutôt que d'échouer.
 * Pure — testée unitairement.
 */
/**
 * May we (re)open a Telegram bridge for this channel right now?
 *
 * The whole rule, in one place, because two reconcilers ask it: the boot pass
 * and the 5s loop. They used to answer it separately, and only the boot one knew
 * how to rebuild a bridge that had died — so a session restarted afterwards
 * stayed deaf towards Telegram until something unrelated restarted the server.
 *
 * `sessionAlive` is the load-bearing term. Without it a dormant channel would
 * get a `claude` respawned under it just to fill a topic: mirroring an idle
 * channel is the topic's job, not a live process's.
 */
export function shouldReattachBridge(o: {
  threadId?: number | null;
  hasBridge: boolean;
  sessionAlive: boolean;
}): boolean {
  if (o.threadId == null) return false; // no topic bound → nothing to reattach to
  if (o.hasBridge) return false;        // already connected
  return o.sessionAlive;
}

export function nextToolsState(arg: string, current: boolean): boolean {
  const a = arg.trim().toLowerCase();
  if (a === "on") return true;
  if (a === "off") return false;
  return !current;
}

/**
 * Qui a le droit d'écrire au bot en privé ?
 *
 * Un groupe est déjà borné au groupe lié ; un DM ne l'était pas : sans
 * allowlist configurée, n'importe qui trouvant le bot obtenait une session
 * Claude sur la machine. Le premier à écrire s'approprie donc les DM, et les
 * autres sont refusés.
 *
 * Un expéditeur sans id est refusé même quand personne n'a encore revendiqué :
 * il n'y a rien à mémoriser, donc rien qui empêcherait le suivant d'entrer.
 * Pure — testée unitairement.
 */
export function dmGate(owner: number | null, from: number | undefined): "claim" | "allow" | "deny" {
  if (typeof from !== "number") return "deny";
  if (owner === null) return "claim";
  return owner === from ? "allow" : "deny";
}

/** Les origines connues et leur marque. Une origine inconnue garde son nom :
 *  mieux vaut « quelqu'un a parlé » qu'un message qui semble venir de l'agent. */
const ORIGIN_MARKS: Record<string, string> = { web: "👤 web", cron: "⏰ cron", cli: "⌨️ cli", telegram: "👤 telegram" };

/**
 * L'en-tête d'un prompt venu d'AILLEURS — le web, un cron, la CLI. Sans lui, un
 * canal Telegram ne voyait que les réponses : l'agent semblait parler tout seul,
 * et un cron qui se déclenche était indiscernable d'un message humain.
 * Pure — testée unitairement.
 */
export function promptEchoLabel(origin: string | undefined, auto = false): string {
  // La reprise du pace guard n'est pas quelqu'un : elle vient du serveur.
  if (auto) return "⚙️ reprise automatique";
  if (!origin) return "👤";
  return ORIGIN_MARKS[origin] ?? "👤 " + origin;
}

/**
 * When a group is upgraded to a supergroup (enabling Topics), Telegram sends a
 * `migrate_to_chat_id` service message in the OLD group and changes its chat id.
 * Returns the new supergroup id iff this message migrates the currently-bound
 * board group (so we can follow the binding), else null. Pure — unit tested.
 */
export function migratedGroupId(msg: any, currentBound: number | null): number | null {
  const newId = msg?.migrate_to_chat_id;
  if (typeof newId !== "number") return null;
  return msg?.chat?.id === currentBound ? newId : null;
}

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

/** The prompt sent to the session for downloaded attachments: one absolute
 *  path per line (Claude reads them itself — Read for images/PDF/text,
 *  Bash for the rest), then the user's caption if any. */
export function attachmentPrompt(items: { path: string; kind: "image" | "file" }[], caption?: string): string {
  const lines = items.map((i) => (i.kind === "image" ? `[Image jointe : ${i.path}]` : `[Fichier joint : ${i.path}]`));
  return caption?.trim() ? lines.join("\n") + "\n" + caption : lines.join("\n");
}

const htmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Render an agent's Markdown into the small HTML subset Telegram accepts
 * (`parse_mode: "HTML"`): code fences → <pre>, inline `code`, **bold**, *italic*,
 * headings → bold, [links](url), and `- ` bullets → •. Code is extracted first
 * so its contents aren't reformatted; everything is HTML-escaped so the output
 * is always well-formed (unmatched markers stay literal — the caller can safely
 * fall back to plain text if Telegram ever rejects it).
 */
export function mdToTelegramHtml(md: string): string {
  // Stash code (block + inline) behind sentinels that never collide with real
  // content, so it is not reformatted or double-escaped.
  const parts: string[] = [];
  const stash = (html: string) => {
    parts.push(html);
    return `⟦${parts.length - 1}⟧`;
  };
  let s = md.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code: string) =>
    stash(`<pre>${htmlEscape(code.replace(/\n$/, ""))}</pre>`),
  );
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => stash(`<code>${htmlEscape(c)}</code>`));
  s = htmlEscape(s); // sentinels + markers survive (only &<> are touched)
  s = s.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/gm, "<b>$1</b>"); // headings -> bold
  s = s.replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>").replace(/__([^\n]+?)__/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, "$1<i>$2</i>"); // *italic*
  s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, "$1<i>$2</i>"); // _italic_
  s = s.replace(/\[([^\]]+?)\]\((https?:\/\/[^)\s]+?)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/^(\s*)[-*+]\s+/gm, "$1• "); // bullets
  s = s.replace(/⟦(\d+)⟧/g, (_m, i: string) => parts[+i]);
  return s;
}

/** Telegram's "typing…" indicator lives ~5 s per sendChatAction and dies on
 *  every sendMessage — a single beat can't cover a turn that runs for minutes.
 *  This keeps it alive: an immediate beat, then one every `intervalMs` until
 *  stop(). start() while beating is a no-op; stop() is idempotent. */
export function makeTyping(beat: () => void, intervalMs = 4000): { start: () => void; stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  return {
    start() {
      if (timer) return;
      beat();
      timer = setInterval(beat, intervalMs);
      timer.unref?.(); // never keep the process alive for an indicator
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

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

/**
 * File d'envoi série. Chaque `send`/`edit` d'un bridge lançait son propre
 * `fetch` sans être attendu : deux appels rapprochés n'arrivaient donc pas
 * forcément dans l'ordre d'émission (c'est ce qui pouvait faire passer le
 * clavier devant la préface). Ici les opérations s'enchaînent en FIFO, et un
 * rejet ne casse pas la file — l'appelant récupère quand même son erreur.
 */
export function makeSendQueue(): <T>(op: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(op: () => Promise<T>): Promise<T> => {
    // `then(op, op)` : la suite part que la précédente ait réussi ou échoué.
    const next = tail.then(op, op) as Promise<T>;
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  };
}

/** Nombre de lettres/chiffres en deçà duquel une préface ne peut pas
 *  s'apparier : un fragment trop court s'apparierait à tort à n'importe quoi. */
const PREFACE_MIN = 24;

/**
 * Réduit un texte à ses lettres et chiffres, en minuscules.
 *
 * Les deux côtés décrivent le même bloc mais dans deux formes différentes :
 * l'écran montre le Markdown **rendu** (le gras est de l'ANSI, les `**` ont
 * disparu, une puce devient un bullet) alors que le transcript en garde la
 * **source**. Comparer la ponctuation ferait donc échouer tout paragraphe
 * contenant du gras, un backtick ou un lien — c'est exactement ce qui produisait
 * un doublon en v0.1.144. Seul le squelette alphanumérique est commun aux deux.
 */
function skeleton(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Longueur de l'empreinte comparée. Assez pour identifier un bloc sans
 *  ambiguïté, assez courte pour qu'une divergence plus loin soit sans effet. */
const PREFACE_FINGERPRINT = 60;

/**
 * La préface lue à l'écran et le texte autoritatif du transcript sont-ils le
 * même bloc ?
 *
 * On n'exige pas que le bloc entier coïncide : certaines constructions ne
 * peuvent pas coïncider. Un lien Markdown garde son URL dans la source alors
 * que l'écran n'en montre que le libellé — selon le rendu, c'est un côté ou
 * l'autre qui porte du texte en plus, donc aucune inclusion stricte ne tient
 * dans les deux sens. On compare donc l'**empreinte d'ouverture** : les
 * premiers caractères alphanumériques de la préface doivent se retrouver dans
 * le texte autoritatif. Une divergence plus loin dans le paragraphe devient
 * sans conséquence.
 *
 * L'inclusion (et non le préfixe) couvre le cas où le début du bloc a défilé
 * hors de l'écran : la préface n'en est alors qu'un fragment interne.
 *
 * Volontairement tolérant ; ce qui borne les faux positifs, c'est qu'une seule
 * préface est armée à la fois, consommée par le premier `stream-text` qui suit
 * sa question et désarmée à la fin du tour.
 */
export function prefaceMatches(preface: string, authoritative: string): boolean {
  const a = skeleton(preface);
  const b = skeleton(authoritative);
  if (a.length < PREFACE_MIN || b.length < PREFACE_MIN) return false;
  return b.includes(a.slice(0, PREFACE_FINGERPRINT));
}

/**
 * La préface décrit-elle un bloc **déjà diffusé** ?
 *
 * Une préface est lue à l'écran, et l'écran garde la réponse du tour précédent
 * tant que le nouveau tour n'a rien écrit. Sans ce garde, chaque question était
 * précédée d'une copie de la réponse d'avant — et le doublon ne se réparait
 * jamais : `prefaceMatches` attend un jumeau autoritatif qui, lui, est arrivé
 * au tour précédent et ne reviendra pas.
 *
 * Même comparateur que `prefaceMatches` : une seule définition de « c'est le
 * même bloc » dans tout le projet, garde-fous compris (un fragment trop court
 * ne s'apparie à rien).
 */
export function isStalePreface(preface: string, recent: string[]): boolean {
  const a = skeleton(preface);
  if (!a) return false;
  // Volontairement PLUS large que `prefaceMatches`, dont le plancher
  // (PREFACE_MIN) laissait passer les réponses courtes — « OK » se reposait à
  // chaque question. Les deux fonctions n'ont pas le même coût d'erreur :
  //   · faux positif ici → la préface n'est pas montrée en avance, mais le bloc
  //     arrive quand même par le tail. Presque rien.
  //   · faux positif dans `prefaceMatches` → on ÉDITE le mauvais message.
  // D'où l'inclusion nue, sans longueur minimale : elle couvre aussi la préface
  // tronquée par le défilement, qui n'est qu'un fragment interne du bloc.
  return recent.some((t) => {
    const b = skeleton(t);
    return b.length > 0 && b.includes(a);
  });
}

interface DialogOption {
  n: number;
  label: string;
  hint?: string;
  checked?: boolean;
}
interface Dialog {
  question: string;
  options: DialogOption[];
  multi: boolean;
}

/** Inline keyboard for a TUI dialog. Single-select → one button per option
 *  (choose); multi-select → toggle buttons (with ☑/☐) + a Submit row. */
/**
 * L'option « texte libre » d'AskUserQuestion. **Exactement la règle du web**
 * (`public/index.html`, la `freetext-row`) : les deux clients doivent s'accorder
 * sur ce qu'est une option libre, sinon le même dialogue se comporte
 * différemment selon l'écran.
 */
export function isFreetextOption(label: string): boolean {
  return /^type something/i.test(label.trim());
}

export function dialogKeyboard(d: Dialog): { inline_keyboard: { text: string; callback_data: string }[][] } {
  const rows = d.options.map((o) => [
    {
      text: (d.multi ? (o.checked ? "☑ " : "☐ ") : "") + `${o.n}. ${o.label}`.slice(0, 60),
      // `f:` = réponse libre : le bouton ouvre une saisie au lieu de valider un
      // choix. Sans ça, l'option partait en `choose` → Entrée à vide dans le TUI
      // → outil rejeté et tour mort, sans un mot dans le canal.
      callback_data: (isFreetextOption(o.label) ? "f:" : d.multi ? "t:" : "d:") + o.n,
    },
  ]);
  if (d.multi) rows.push([{ text: "✅ Submit", callback_data: "s" }]);
  return { inline_keyboard: rows };
}

/** Parse a dialog callback_data → an action for the WS. */
export function parseCallback(
  data: string,
): { kind: "choose" | "toggle" | "confirm" | "freetext"; n?: number } | null {
  if (data === "s") return { kind: "confirm" };
  const m = data.match(/^([dtf]):(\d+)$/);
  if (!m) return null;
  const kind = m[1] === "d" ? "choose" : m[1] === "t" ? "toggle" : "freetext";
  return { kind, n: Number(m[2]) };
}

// ── Runtime ──────────────────────────────────────────────────────────────

interface Bridge {
  key: string;
  chatId: number;
  threadId?: number;
  ws: WebSocket;
  sessionId: string | null;
  ready: boolean;
  pending: string[]; // prompts queued until the WS is ready
  pendingActions: object[]; // dialog actions (choose/toggle/confirm) queued until ready
  dialogMsgId?: number; // Telegram message showing the current dialog keyboard
  // Option « texte libre » choisie : on attend le prochain message du canal
  // pour le renvoyer en `freetext` plutôt qu'en nouveau prompt. Désarmé à la
  // fin du tour — une attente orpheline détournerait un prompt ordinaire.
  awaitingFreetext?: { n: number };
  // Préface d'un dialog en attente de son jumeau autoritatif (cf. la spec du
  // 2026-07-28) : le texte lu à l'écran, et le message qui le porte — édité en
  // place quand le tail livre enfin le vrai bloc, au lieu d'un doublon.
  prefaceText?: string;
  prefaceMsgId?: number;
  worktree?: boolean; // spawn the session in an isolated worktree
  // Replay the last N turns into the topic on connect — set ONLY when a topic
  // is freshly created for an existing channel, so a fresh mirror isn't empty.
  // Cleared after the first `history` so a reconnect/reboot never re-spams.
  backfill?: boolean;
  // Poster (ou non) les appels d'outils dans ce canal — réglage du topic, lu
  // une fois à l'ouverture du pont pour ne pas toucher le disque à chaque
  // événement d'un tour. Basculé par /tools.
  showTools: boolean;
  name?: string; // channel name (a /spawn topic name), stored in the registry
  typing: { start: () => void; stop: () => void }; // "typing…" heartbeat for the running turn
  send: <T>(op: () => Promise<T>) => Promise<T>; // file série des écritures Telegram
}

/**
 * Rename a Telegram forum topic to match a channel renamed elsewhere (the web
 * UI). Wired up by startTelegram; a no-op when Telegram is off. Lets the server
 * push a web-side rename to Telegram without importing its token/closure.
 */
let renameTopicImpl: ((chatId: number, threadId: number, name: string) => void) | null = null;
export function renameTelegramTopic(chatId: number, threadId: number, name: string): void {
  renameTopicImpl?.(chatId, threadId, name);
}

/** Close (archive) a Telegram forum topic when its session ends elsewhere. */
let closeTopicImpl: ((chatId: number, threadId: number) => void) | null = null;
export function closeTelegramTopic(chatId: number, threadId: number): void {
  closeTopicImpl?.(chatId, threadId);
}

export interface TelegramHandle {
  stop(): void;
  running(): boolean;
  status(): { username: string | null; tokenError: string | null };
}

const NOOP_HANDLE: TelegramHandle = {
  stop() {},
  running: () => false,
  status: () => ({ username: null, tokenError: null }),
};

export function startTelegram(port: number, authCookie?: string): TelegramHandle {
  // Config is the source of truth (env still overrides, resolved by telegramConfig).
  const cfg = telegramConfig(loadConfig(), process.cwd());
  if (!cfg.enabled || !cfg.token) return NOOP_HANDLE; // off or no token → nothing polling
  const token = cfg.token;
  const api = `https://api.telegram.org/bot${token}`;
  const allowed = cfg.allowedChats;
  // Mutable bridge state, closed over by the returned handle (see stop()/status()).
  let stopped = false;
  let polling = false;
  let botUsername: string | null = null;
  let tokenError: string | null = null;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let pollAbort: AbortController | null = null;
  const bridges = new Map<string, Bridge>();
  // Names of topics we've seen created/renamed (chatId:threadId → name), so a
  // manually-created topic keeps its name instead of the GUI defaulting it.
  const topicNames = new Map<string, string>();

  const tg = async (method: string, params: object, signal?: AbortSignal): Promise<any> => {
    try {
      const r = await fetch(`${api}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal,
      });
      return await r.json();
    } catch {
      return null;
    }
  };

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

  // Web-side rename → rename the matching Telegram topic (best effort).
  renameTopicImpl = (chatId, threadId, name) => {
    tg("editForumTopic", { chat_id: chatId, message_thread_id: threadId, name: name.slice(0, 128) });
  };
  // Session ended elsewhere → delete its topic so it disappears from the group
  // (the bot created it, so it can). Irreversible; ignore errors.
  closeTopicImpl = (chatId, threadId) => {
    tg("deleteForumTopic", { chat_id: chatId, message_thread_id: threadId });
  };

  /** Un morceau déjà découpé → un message Telegram ; renvoie son id, ou null. */
  const sendPart = async (b: Bridge, part: string): Promise<number | null> => {
    const to = { chat_id: b.chatId, ...(b.threadId ? { message_thread_id: b.threadId } : {}) };
    // Render the agent's Markdown as Telegram HTML; if Telegram rejects it
    // (malformed after a mid-chunk split), resend the raw text as-is.
    const r = await tg("sendMessage", {
      ...to,
      text: mdToTelegramHtml(part),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    if (r?.ok) return r.result.message_id;
    const raw = await tg("sendMessage", { ...to, text: part, disable_web_page_preview: true });
    return raw?.ok ? raw.result.message_id : null;
  };

  /** Envoie un texte (découpé si besoin). Passe par la file du bridge : deux
   *  `fetch` concurrents n'arriveraient pas forcément dans l'ordre d'émission.
   *  Renvoie l'id du PREMIER message — celui qu'on éditera pour une préface. */
  const send = (b: Bridge, text: string): Promise<number | null> =>
    b.send(async () => {
      let first: number | null = null;
      for (const part of chunk(text)) {
        const id = await sendPart(b, part);
        if (first === null) first = id;
      }
      return first;
    });

  /** Remplace le contenu d'un message déjà envoyé (la préface → le vrai bloc).
   *  Un texte trop long pour un message : le 1er morceau remplace, le reste
   *  suit. Échec d'édition → on laisse la préface en place, elle reste juste. */
  const editText = (b: Bridge, msgId: number, text: string): Promise<void> =>
    b.send(async () => {
      const parts = chunk(text);
      const r = await tg("editMessageText", {
        chat_id: b.chatId,
        message_id: msgId,
        text: mdToTelegramHtml(parts[0]),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      if (!r?.ok)
        await tg("editMessageText", {
          chat_id: b.chatId,
          message_id: msgId,
          text: parts[0],
          disable_web_page_preview: true,
        });
      for (const part of parts.slice(1)) await sendPart(b, part);
    });

  // Fold each bridge into the ONE registry: its session becomes a channel
  // carrying the Telegram binding, so it shows up (and is pilotable) in the web
  // UI too. The server fills cwd/branch on ready; here we own the binding.
  const persist = () => {
    for (const b of bridges.values()) {
      if (!b.sessionId) continue;
      const existing = channelForTelegram(b.chatId, b.threadId);
      // The General (no threadId) is the environment's main channel — always
      // named "general". Topics seed their name from the topic once.
      const name = b.threadId ? (b.name && !existing?.name ? b.name : undefined) : "general";
      upsertChannel({
        sessionId: b.sessionId,
        ...(name ? { name } : {}),
        // Born in Telegram = mirrored by definition, written ONCE. Never
        // re-assert it: `persist` runs on every `ready`, and overwriting a
        // `mirror: false` chosen from the web would make the topic come back in
        // a loop, right after it was deleted.
        ...(existing?.mirror === undefined ? { mirror: true } : {}),
        telegram: { chatId: b.chatId, ...(b.threadId ? { threadId: b.threadId } : {}) },
      });
    }
  };

  /** Open (or resume) a session for a chat/topic and wire its events to Telegram. */
  const openBridge = (
    key: string,
    chatId: number,
    threadId: number | undefined,
    opts: { resumeId?: string; worktree?: boolean; name?: string; profile?: string; backfill?: boolean } = {},
  ): Bridge => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, authCookie ? { headers: { cookie: authCookie } } : {});
    const b: Bridge = {
      key,
      chatId,
      threadId,
      ws,
      sessionId: opts.resumeId ?? null,
      ready: false,
      pending: [],
      pendingActions: [],
      worktree: opts.worktree,
      backfill: opts.backfill,
      showTools: tgToolsEnabled(key),
      name: opts.name,
      send: makeSendQueue(),
      typing: makeTyping(() =>
        tg("sendChatAction", {
          chat_id: chatId,
          ...(threadId ? { message_thread_id: threadId } : {}),
          action: "typing",
        }),
      ),
    };
    bridges.set(key, b);

    ws.on("open", () => {
      ws.send(
        JSON.stringify(
          opts.resumeId
            ? { type: "start", resume: opts.resumeId, cwd: process.cwd(), origin: "telegram", ...(opts.profile ? { profile: opts.profile } : {}) }
            : { type: "start", cwd: process.cwd(), origin: "telegram", worktree: !!opts.worktree, ...(opts.profile ? { profile: opts.profile } : {}) },
        ),
      );
    });
    ws.on("message", (raw) => {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (m.type) {
        case "history": {
          // Only replay for a freshly-created topic; never on a reconnect/reboot
          // (arrives before `ready`, so the flag gates it exactly once).
          if (!b.backfill) break;
          b.backfill = false;
          const turns = (Array.isArray(m.turns) ? m.turns : []).slice(-15);
          if (!turns.length) break;
          send(b, `— historique repris (${turns.length} derniers échanges) —`);
          for (const t of turns) {
            const txt = String(t?.text ?? "").trim();
            if (txt) send(b, t.role === "user" ? "👤 " + txt : txt);
          }
          break;
        }
        case "ready":
          b.sessionId = m.sessionId;
          b.ready = true;
          persist();
          for (const p of b.pending.splice(0)) ws.send(JSON.stringify({ type: "prompt", text: p }));
          for (const a of b.pendingActions.splice(0)) ws.send(JSON.stringify(a));
          break;
        case "working":
          // Heartbeat, not a one-shot: Telegram's indicator dies after ~5 s
          // (and on every message we send) while a turn runs for minutes.
          b.typing.start();
          break;
        case "stream-text": {
          if (!m.text?.trim()) break;
          // Ce bloc est-il le jumeau autoritatif d'une préface déjà affichée ?
          // (le tail ne le livre qu'une fois la question répondue). Si oui, on
          // ÉDITE le message existant — le Markdown propre remplace le texte
          // dé-wrappé de l'écran — au lieu de poster un doublon.
          if (b.prefaceText && prefaceMatches(b.prefaceText, m.text)) {
            const id = b.prefaceMsgId;
            b.prefaceText = undefined;
            b.prefaceMsgId = undefined;
            if (id !== undefined) editText(b, id, m.text);
            break;
          }
          send(b, m.text);
          break;
        }
        case "prompt-echo":
          // Le serveur exclut déjà l'émetteur : ce qui arrive ici vient
          // forcément d'un AUTRE client. On le montre, marqué — un bot ne peut
          // pas poster sous le nom de l'utilisateur.
          if (m.text?.trim()) send(b, promptEchoLabel(m.origin, m.auto) + "\n" + m.text);
          break;
        case "stream-tool":
          // Masqués par défaut : sur un tour un peu long, la réponse de l'agent
          // se noie sous les « → Read … ». /tools les rallume par canal.
          if (b.showTools) send(b, "→ " + m.name + (m.summary ? "  " + m.summary : ""));
          break;
        case "dialog":
          // The turn is suspended on a question — Claude isn't "typing",
          // it's waiting for the user. Stop the heartbeat.
          b.typing.stop();
          // A TUI question → inline keyboard. On multi-select toggles the
          // server re-sends the dialog; edit the existing keyboard in place.
          if (b.dialogMsgId) {
            b.send(() =>
              tg("editMessageReplyMarkup", {
                chat_id: b.chatId,
                message_id: b.dialogMsgId,
                reply_markup: dialogKeyboard(m),
              }),
            );
          } else {
            // Le texte écrit juste avant la question : le serveur l'a lu à
            // l'écran, car le transcript ne le livrera qu'APRÈS la réponse.
            // Sans lui, l'utilisateur choisit à l'aveugle. La file garantit
            // qu'il précède réellement le clavier.
            if (m.preface?.trim()) {
              b.prefaceText = m.preface;
              b.prefaceMsgId = undefined;
              send(b, m.preface).then((id) => {
                if (id !== null) b.prefaceMsgId = id;
              });
            }
            b.awaitingFreetext = undefined; // nouvelle question : l'attente précédente est caduque
            b.send(() =>
              tg("sendMessage", {
                chat_id: b.chatId,
                ...(b.threadId ? { message_thread_id: b.threadId } : {}),
                // Tronqué : ce message ne passe pas par `chunk()` (il porte le
                // clavier, qu'on ne peut pas couper en deux). Au-delà de la
                // limite Telegram, l'envoi échouait — donc AUCUN clavier, et le
                // tour restait suspendu sur une question inatteignable.
                text: (m.question || "Choisis :").slice(0, MSG_LIMIT),
                reply_markup: dialogKeyboard(m),
              }).then((r) => {
                if (r?.ok) b.dialogMsgId = r.result.message_id;
                // Le dire plutôt que de laisser le canal muet : sans clavier,
                // la seule issue est le web ou /stop.
                else send(b, `⚠️ Telegram refused the question's keyboard (${r?.description ?? "unknown reason"}). Answer from the web UI, or /stop.`);
              }),
            );
          }
          break;
        case "turn-done":
          b.typing.stop();
          b.dialogMsgId = undefined; // any dialog is resolved once the turn ends
          b.awaitingFreetext = undefined; // plus de question en attente de texte
          // Le jumeau autoritatif d'une préface arrive DANS le tour qui suit la
          // réponse ; passé la fin du tour il ne viendra plus. On désarme, sinon
          // un texte ultérieur pourrait s'y apparier et éditer un vieux message.
          b.prefaceText = undefined;
          b.prefaceMsgId = undefined;
          break;
        case "pace-blocked":
          // The prompt was refused by the pace guard (there is no "force"
          // button here) — say so instead of staying silent, and drop the
          // optimistic typing started at message receipt.
          b.typing.stop();
          send(b, "⏸️ pace guard: " + (m.reason ?? "over the ideal pace") + "\nYour message was not sent — retry later.");
          break;
        case "error":
          // No typing.stop() here: fail() errors ("a response is already in
          // progress") don't end the running turn — turn-done/exited will.
          send(b, "⚠️ " + m.message);
          break;
        case "exited":
          b.typing.stop();
          b.awaitingFreetext = undefined;
          send(b, "— session ended —");
          break;
      }
    });
    ws.on("close", () => {
      b.typing.stop();
      if (bridges.get(key) === b) bridges.delete(key);
    });
    ws.on("error", () => {});
    return b;
  };

  const bridgeFor = (key: string, chatId: number, threadId?: number, name?: string): Bridge => {
    const existing = bridges.get(key);
    if (existing && existing.ws.readyState <= WebSocket.OPEN) return existing;
    const saved = channelForTelegram(chatId, threadId);
    // Carry the topic's profile so a re-created session keeps its role/secrets
    // (else its cron scripts lose their env). saved?.profile is a name or null.
    return openBridge(key, chatId, threadId, { resumeId: saved?.sessionId, name, profile: saved?.profile ?? undefined });
  };

  const promptTo = (b: Bridge, text: string) => {
    if (b.ready && b.ws.readyState === WebSocket.OPEN) b.ws.send(JSON.stringify({ type: "prompt", text }));
    else b.pending.push(text);
  };

  const reply = (chatId: number, threadId: number | undefined, text: string, extra: object = {}) =>
    tg("sendMessage", {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: threadId } : {}),
      text,
      disable_web_page_preview: true,
      ...extra,
    });

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

  const endBinding = (key: string, chatId: number, threadId?: number) => {
    const b = bridges.get(key);
    if (b) {
      b.ws.send(JSON.stringify({ type: "stop" }));
      b.ws.close();
      bridges.delete(key);
    }
    // The session is stopped → drop it from the one registry (removes it from
    // the web UI too).
    const ch = channelForTelegram(chatId, threadId);
    if (ch) removeChannel(ch.sessionId);
  };

  /** Applique `dmGate` à un message privé. Renvoie false si on doit s'arrêter. */
  const guardDm = async (msg: any): Promise<boolean> => {
    const from = msg.from?.id as number | undefined;
    const verdict = dmGate(loadTgOwner(), from);
    if (verdict === "allow") return true;
    if (verdict === "claim") {
      saveTgOwner(from!);
      console.log(`telegram: DM claimed by user ${from} — others will be refused`);
      return true;
    }
    console.log(`telegram: refused DM from user ${from ?? "?"} (not the owner)`);
    await reply(msg.chat.id, undefined, "⛔ This bot is private.");
    return false;
  };

  const handleMessage = async (msg: any) => {
    const att = attachmentOf(msg);
    if (typeof msg.text !== "string" && !att) return;
    const chat = msg.chat;
    if (allowed.length && !allowed.includes(String(chat.id))) {
      await reply(chat.id, msg.message_thread_id, "⛔ this bot is restricted.");
      return;
    }
    // Les DM appartiennent au premier qui a écrit. Une allowlist explicite
    // reste prioritaire (elle a déjà filtré plus haut) : ceci est le garde par
    // défaut, pour l'installation qui n'en configure aucune.
    if (chat.type === "private" && !(await guardDm(msg))) return;
    const threadId = msg.message_thread_id as number | undefined;
    const isGroup = chat.type === "group" || chat.type === "supergroup";
    // Commands only exist in text messages — a caption is never a command.
    const cmd = typeof msg.text === "string" ? parseCommand(msg.text) : null;

    // One board per instance: a group must be the bound group.
    if (isGroup) {
      const bound = loadTgGroup();
      if (bound === null) {
        if (cmd?.cmd === "setup") {
          saveTgGroup(chat.id);
          await reply(chat.id, threadId, "✅ This group is now shadok-ai's board. Use /spawn <name> to create an agent (a forum topic). Enable Topics + make me admin if /spawn fails.");
        } else {
          await reply(chat.id, threadId, "Run /setup here to bind this group as shadok-ai's board (one group per instance).");
        }
        return;
      }
      if (bound !== chat.id) {
        await reply(chat.id, threadId, "⛔ This shadok-ai instance is bound to another group.");
        return;
      }
    }

    const key = bindKey(chat, threadId);

    if (cmd) {
      switch (cmd.cmd) {
        case "start":
        case "help":
          await reply(chat.id, threadId, "shadok-ai — talk to your agent by sending a message.\n/spawn <name> — new agent in a topic (groups)\n/stop — interrupt the current turn (esc)\n/new — reset · /end — kill the session · /list — bindings\n/tools [on|off] — show or hide tool calls in this agent\n/secrets — list · /secret KEY value — set · /unsecret KEY\n/cron — schedule prompts (monitoring/reporting)");
          return;
        case "setup":
          if (isGroup) await reply(chat.id, threadId, "✅ already this instance's board.");
          return;
        case "spawn": {
          if (!isGroup) {
            await reply(chat.id, threadId, "/spawn works in the board group. In a DM just send a message.");
            return;
          }
          // `/spawn <profile> <name>`: if the first word is a known profile,
          // apply it; otherwise the whole arg is the agent name (no profile).
          let profile: string | undefined;
          let name = cmd.arg || "agent";
          const sp = name.indexOf(" ");
          const first = sp === -1 ? name : name.slice(0, sp);
          if (getProfile(first)) {
            profile = first;
            name = sp === -1 ? first : name.slice(sp + 1).trim() || first;
          }
          const t = await tg("createForumTopic", { chat_id: chat.id, name: name.slice(0, 128) });
          if (!t?.ok) {
            const why = t?.description ? ` (Telegram: ${t.description})` : "";
            console.log(`telegram: createForumTopic failed for ${chat.id}:`, t?.description ?? t);
            await reply(chat.id, threadId, `⚠️ Couldn't create a topic${why}.\nMake sure this is a supergroup with Topics enabled, and that I'm an admin with 'Manage topics'.`);
            return;
          }
          const newThread = t.result.message_thread_id;
          addTgTopic(newThread);
          // A group agent is isolated in its own worktree (a board of agents).
          openBridge(bindKey(chat, newThread), chat.id, newThread, { worktree: true, name, profile });
          await reply(chat.id, newThread, `🤖 Agent « ${name} »${profile ? ` [${profile}]` : ""} ready (isolated worktree). Send it a task.`);
          return;
        }
        case "profiles": {
          const names = profileNames();
          await reply(chat.id, threadId, names.length ? "Profiles:\n" + names.map((n) => "• " + n).join("\n") + "\n\nUse: /spawn <profile> <name>" : "No profiles yet — create them in the web UI (Profiles panel).");
          return;
        }
        case "new":
        case "end":
          endBinding(key, chat.id, threadId);
          await reply(chat.id, threadId, cmd.cmd === "new" ? "🔄 fresh session — send a message." : "🛑 session ended.");
          return;
        case "stop":
        case "esc": {
          // Interrompre le tour en cours = la touche Échap du web (bouton Esc de
          // l'engine room). Ça ne tue PAS la session : c'est /end qui fait ça.
          // `bridges.get` et pas `bridgeFor` : /stop ne doit jamais faire naître
          // une session juste parce qu'on a tapé la commande.
          const sb = bridges.get(key);
          if (!sb || sb.ws.readyState !== WebSocket.OPEN) {
            await reply(chat.id, threadId, "aucune session ici.");
            return;
          }
          sb.ws.send(JSON.stringify({ type: "key", key: "escape" }));
          // Couper « typing… » tout de suite : si l'agent était déjà au repos,
          // aucun événement terminal n'arrivera pour l'éteindre.
          sb.typing.stop();
          await reply(chat.id, threadId, "⏹ interrompu.");
          return;
        }
        case "tools": {
          // `bridges.get` et pas `bridgeFor` : régler l'affichage ne doit pas
          // faire naître une session (même précaution que /stop). Le store est
          // la source de vérité — un pont ouvert plus tard le relira.
          const next = nextToolsState(cmd.arg, tgToolsEnabled(key));
          setTgTools(key, next);
          const tb = bridges.get(key);
          if (tb) tb.showTools = next;
          await reply(chat.id, threadId, next ? "🔧 tool calls shown in this agent." : "🔧 tool calls hidden in this agent.");
          return;
        }
        case "list": {
          const lines = loadChannels()
            .filter((c) => c.telegram)
            .map((c) => {
              const where = c.telegram!.threadId ? `topic ${c.telegram!.threadId}` : "here";
              return `• ${c.name ?? c.sessionId.slice(0, 8)} (${where})`;
            });
          await reply(chat.id, threadId, lines.length ? lines.join("\n") : "no sessions bound yet.");
          return;
        }
        case "cron": {
          const CRON_USAGE =
            "⏰ Scheduled prompts for this agent:\n" +
            "• /cron every 30m <prompt>  (or 2h)\n" +
            "• /cron daily 09:00 <prompt>  (heure du fuseau du serveur)\n" +
            "• /cron list · /cron off <id> · /cron on <id> · /cron del <id>";
          const ch = channelForTelegram(chat.id, threadId);
          const parts = cmd.arg.trim().split(/\s+/);
          const sub = (parts.shift() || "list").toLowerCase();
          const mineOf = (sid: string) => loadCrons().filter((c) => c.sessionId === sid);
          // Résolution partagée avec l'API HTTP : un préfixe vide ne matche
          // plus « le premier » (un `/cron del` nu supprimait un cron au
          // hasard), et un préfixe ambigu est refusé plutôt que tranché.
          const findById = (pfx: string): Cron | { miss: string } => {
            const list = loadCrons();
            const r = resolveCronId(list, pfx);
            if (r.ok) return list.find((c) => c.id === r.id)!;
            if (r.error === "ambiguous") return { miss: `'${pfx}' matches ${r.matches} crons — use more characters.` };
            return { miss: "cron not found (use /cron list)." };
          };

          if (sub === "list") {
            const mine = ch ? mineOf(ch.sessionId) : [];
            const body = mine.length
              ? mine
                  .map(
                    (c) =>
                      `• [${c.id.slice(0, 8)}] ${scheduleLabel(c.schedule, cronTimeZone(c))}${c.enabled ? "" : " (paused)"}\n  ${c.prompt}`,
                  )
                  .join("\n")
              : "no schedule here yet.";
            await reply(chat.id, threadId, body + "\n\n" + CRON_USAGE);
            return;
          }
          if (sub === "del" || sub === "rm" || sub === "on" || sub === "off") {
            const found = findById(parts[0] || "");
            if ("miss" in found) { await reply(chat.id, threadId, found.miss); return; }
            const t = found;
            if (sub === "del" || sub === "rm") {
              removeCron(t.id);
              await reply(chat.id, threadId, `🗑 cron ${t.id.slice(0, 8)} deleted.`);
            } else {
              t.enabled = sub === "on";
              t.nextRun = t.enabled ? nextRunFor(t.schedule, Date.now(), cronTimeZone(t)) : undefined;
              upsertCron(t);
              await reply(chat.id, threadId, `${t.enabled ? "▶️ resumed" : "⏸ paused"} cron ${t.id.slice(0, 8)}.`);
            }
            return;
          }
          // add: "every 30m <prompt>" | "daily 09:00 <prompt>"
          if (!ch) {
            await reply(chat.id, threadId, "Send a message here first to create the agent, then schedule.\n\n" + CRON_USAGE);
            return;
          }
          let sched: CronSchedule | null = null;
          const spec = parts.shift() || "";
          if (sub === "every") {
            const m = /^(\d+)([mh])$/i.exec(spec);
            if (m) sched = normalizeSchedule({ kind: "interval", everyMin: m[2].toLowerCase() === "h" ? +m[1] * 60 : +m[1] });
          } else if (sub === "daily") {
            const m = /^(\d{1,2}):(\d{2})$/.exec(spec);
            if (m) sched = normalizeSchedule({ kind: "daily", hour: +m[1], minute: +m[2] });
          }
          const prompt = parts.join(" ").trim();
          if (!sched || !prompt) { await reply(chat.id, threadId, CRON_USAGE); return; }
          const cron = {
            id: randomUUID(),
            sessionId: ch.sessionId,
            prompt,
            schedule: sched,
            enabled: true,
            // Pas de `tz` propre : le cron suit le défaut global (config
            // `timezone`), donc le régler répare aussi ceux créés d'ici.
            nextRun: nextRunFor(sched, Date.now(), cronTimeZone({})),
          };
          upsertCron(cron);
          await reply(chat.id, threadId, `⏰ scheduled (${scheduleLabel(sched, cronTimeZone({}))}) — id ${cron.id.slice(0, 8)}`);
          return;
        }
        case "update": {
          // Powerful (npm install + respawn), but instance-wide and non-
          // destructive: allowed from a DM (the operator) or the board group.
          // The allowlist, if set, was already enforced at the top.
          await reply(chat.id, threadId, "🔄 updating… I'll be back in a moment.");
          // Ask the supervisor to fetch @latest and respawn us.
          process.exit(UPDATE_EXIT_CODE);
        }
        case "secrets": {
          const names = secretNames();
          await reply(
            chat.id,
            threadId,
            `🔐 vault:\n${names.length ? names.map((k) => "• " + k).join("\n") : "(none)"}\n\nSet: /secret NAME value  ·  remove: /unsecret NAME\nProfiles pick which secrets they inject (web Profiles panel).`,
          );
          return;
        }
        case "secret": {
          // /secret NAME value — store in the vault, then DELETE the message so
          // the value doesn't linger in the chat history.
          const sp = cmd.arg.indexOf(" ");
          const skey = sp === -1 ? cmd.arg : cmd.arg.slice(0, sp);
          const sval = sp === -1 ? "" : cmd.arg.slice(sp + 1);
          if (!skey || !sval) {
            await reply(chat.id, threadId, "Usage: /secret NAME value");
            return;
          }
          setSecret(skey.trim(), sval);
          const del = await tg("deleteMessage", { chat_id: chat.id, message_id: msg.message_id });
          await reply(
            chat.id,
            threadId,
            `🔐 ${skey.trim()} saved to the vault.${del?.ok ? " (your message was deleted)" : "\n⚠️ I couldn't delete your message — remove it manually; the value is exposed in history."} Add it to a profile to inject it.`,
          );
          return;
        }
        case "unsecret": {
          const skey = cmd.arg.trim();
          if (!skey) {
            await reply(chat.id, threadId, "Usage: /unsecret NAME");
            return;
          }
          deleteSecret(skey);
          await reply(chat.id, threadId, `🔐 ${skey} removed from the vault.`);
          return;
        }
        case "restart": {
          // Re-spawn this topic's agent so it picks up freshly-added secrets.
          const rb = bridgeFor(key, chat.id, threadId);
          const rmsg = { type: "restart" };
          if (rb.ready && rb.ws.readyState === WebSocket.OPEN) rb.ws.send(JSON.stringify(rmsg));
          else rb.pendingActions.push(rmsg);
          await reply(chat.id, threadId, "♻️ restarting the agent to apply secrets…");
          return;
        }
      }
    }

    // A manually-created topic keeps its own name: take it from the cache
    // (forum_topic_created) or the topic's root message, so the channel isn't
    // named after the cwd. Only used to seed a nameless channel (see persist).
    const topicName =
      threadId != null
        ? topicNames.get(key) ?? msg.reply_to_message?.forum_topic_created?.name
        : undefined;

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
    // Réponse à une option « texte libre » : ce message va à la question en
    // cours, pas au prompt. Désarmé avant l'envoi, quoi qu'il advienne : une
    // attente qui survit détournerait le message suivant.
    if (b.awaitingFreetext) {
      const { n } = b.awaitingFreetext;
      b.awaitingFreetext = undefined;
      const wsMsg = { type: "freetext", n, text: msg.text };
      if (b.ready && b.ws.readyState === WebSocket.OPEN) b.ws.send(JSON.stringify(wsMsg));
      else b.pendingActions.push(wsMsg);
      return;
    }
    promptTo(b, msg.text);
  };

  const handleCallback = async (cq: any) => {
    const action = parseCallback(cq.data ?? "");
    const msg = cq.message;
    if (!action || !msg) return;
    // Un clavier ne peut apparaître qu'après un message accepté, donc ce chemin
    // n'est en principe pas atteignable par un inconnu — on le ferme quand même
    // plutôt que de dépendre de cette supposition. Jamais de "claim" ici : on ne
    // s'approprie les DM qu'en écrivant, pas en cliquant.
    if (msg.chat?.type === "private" && dmGate(loadTgOwner(), cq.from?.id) !== "allow") {
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "⛔ This bot is private." });
      return;
    }
    await tg("answerCallbackQuery", { callback_query_id: cq.id }); // stop the client spinner
    // Resume the bridge if the server was restarted since the dialog was shown
    // (otherwise a click on an orphaned keyboard would silently do nothing).
    const b = bridgeFor(bindKey(msg.chat, msg.message_thread_id), msg.chat.id, msg.message_thread_id);
    // Réponse libre : rien à envoyer au serveur pour l'instant — on réclame le
    // texte. `force_reply` ouvre le clavier du téléphone tout seul.
    if (action.kind === "freetext") {
      b.awaitingFreetext = { n: action.n! };
      await tg("sendMessage", {
        chat_id: b.chatId,
        ...(b.threadId ? { message_thread_id: b.threadId } : {}),
        text: "✍️ Type your answer — your next message goes to the question.",
        reply_markup: { force_reply: true, input_field_placeholder: "Your answer…" },
      });
      return;
    }
    const wsMsg =
      action.kind === "confirm" ? { type: "confirm" } : { type: action.kind, n: action.n };
    if (b.ready && b.ws.readyState === WebSocket.OPEN) b.ws.send(JSON.stringify(wsMsg));
    else b.pendingActions.push(wsMsg);
  };

  // A topic created in Telegram → spawn its agent right away, so the channel
  // shows up in the GUI before anyone writes. Creating a topic = creating an
  // agent (the board model). Skips topics already bound (e.g. the bot's own
  // /spawn, which opened the bridge before this event arrived).
  const handleTopicCreated = (msg: any) => {
    const name = msg.forum_topic_created?.name;
    const threadId = msg.message_thread_id;
    const key = bindKey(msg.chat, threadId);
    if (typeof name === "string" && name) topicNames.set(key, name);
    if (msg.chat.id !== loadTgGroup()) return; // only the bound board group
    addTgTopic(threadId);
    const ch = channelForTelegram(msg.chat.id, threadId);
    if (bridges.has(key) || ch) {
      if (ch && !ch.name && name) upsertChannel({ sessionId: ch.sessionId, name });
      return;
    }
    openBridge(key, msg.chat.id, threadId, { worktree: true, name });
    reply(msg.chat.id, threadId, `🤖 Agent « ${name ?? "agent"} » ready (isolated worktree). Send it a task.`);
  };

  // A topic renamed in Telegram → update the one registry so the web tab follows.
  const handleTopicEdited = (msg: any) => {
    const name = msg.forum_topic_edited?.name;
    if (typeof name !== "string" || !name) return;
    topicNames.set(bindKey(msg.chat, msg.message_thread_id), name);
    const ch = channelForTelegram(msg.chat.id, msg.message_thread_id);
    if (ch) upsertChannel({ sessionId: ch.sessionId, name });
  };

  // A topic closed/deleted in Telegram → end its session everywhere. Sending
  // `stop` lets the server tear down + drop it from the registry (which removes
  // the web tab via the sync poll). No bridge → just unbind.
  const handleTopicClosed = (msg: any) => {
    const ch = channelForTelegram(msg.chat.id, msg.message_thread_id);
    if (!ch) return;
    const key = bindKey(msg.chat, msg.message_thread_id);
    const b = bridges.get(key);
    if (b?.ws.readyState === WebSocket.OPEN) b.ws.send(JSON.stringify({ type: "stop" }));
    else removeChannel(ch.sessionId);
    bridges.delete(key);
  };

  /** Follow the board binding when its group becomes a supergroup (Topics on).
   *  Handled before handleMessage — the service message carries no text and
   *  would otherwise be dropped, leaving the binding on a dead chat id. */
  const handleMigrate = (msg: any) => {
    const newId = migratedGroupId(msg, loadTgGroup());
    if (newId === null) return;
    saveTgGroup(newId);
    console.log(`telegram: board group migrated to supergroup ${newId} — binding updated`);
  };

  const handleUpdate = async (u: any) => {
    if (u.callback_query) return handleCallback(u.callback_query);
    if (u.message?.migrate_to_chat_id) return handleMigrate(u.message);
    if (u.message?.forum_topic_created) return handleTopicCreated(u.message);
    if (u.message?.forum_topic_edited) return handleTopicEdited(u.message);
    if (u.message?.forum_topic_closed || u.message?.forum_topic_deleted)
      return handleTopicClosed(u.message);
    if (u.message) return handleMessage(u.message);
  };

  // Long-poll loop — no webhook / public URL needed.
  let offset = 0;
  const poll = async () => {
    if (stopped) return;
    pollAbort = new AbortController();
    const res = await tg(
      "getUpdates",
      { offset, timeout: 30, allowed_updates: ["message", "callback_query"] },
      pollAbort.signal,
    );
    if (stopped) return; // aborted mid-flight during stop(); do not reschedule
    if (res?.ok && Array.isArray(res.result)) {
      for (const u of res.result) {
        offset = u.update_id + 1;
        handleUpdate(u).catch(() => {});
      }
    }
    setTimeout(poll, res ? 0 : 3000); // back off on network error
  };

  // Full mirror: every LIVE web-created channel (one with no Telegram binding)
  // gets its own topic in the board group, bound to the same session — so the
  // web and Telegram show one list both ways. Only live sessions are mirrored
  // (a stale channel from a past run isn't), and a session already handled by a
  // bridge (a /spawn) is skipped so we never double-create.
  const mirroring = new Set<string>();
  /**
   * Reattach a still-running agent to the topic it is already bound to, when its
   * bridge is gone. Returns true if it opened one.
   *
   * A bridge dies with its WebSocket (`ws.on("close")` drops it from `bridges`),
   * which is what ending a session does — a restart, a killed pane, a crash.
   * Both reconcilers need this exact rule, so it lives in one place: the boot
   * pass and the 5s loop must not drift apart on WHEN an agent may be revived.
   *
   * The `tmuxHasSession` guard is the load-bearing half. Without it, a dormant
   * channel would get a `claude` respawned under it merely to fill a topic —
   * mirroring an idle channel is the topic's job, not a live process's.
   */
  const reattachLiveBridge = (c: { sessionId: string; telegram?: { chatId: number; threadId?: number } | null; profile?: string | null }): boolean => {
    const th = c.telegram?.threadId;
    if (th == null) return false;
    const key = bindKey({ id: c.telegram!.chatId, type: "supergroup" }, th);
    const ok = shouldReattachBridge({
      threadId: th,
      hasBridge: bridges.has(key),
      sessionAlive: tmuxHasSession("sk-" + c.sessionId),
    });
    if (!ok) return false;
    console.log(`telegram: reattaching live agent ${c.sessionId.slice(0, 8)} (topic ${th})`);
    openBridge(key, c.telegram!.chatId, th, { resumeId: c.sessionId, profile: c.profile ?? undefined });
    return true;
  };

  const reconcileWebChannels = async () => {
    const group = loadTgGroup();
    if (group === null) return;
    const bridged = new Set([...bridges.values()].map((b) => b.sessionId).filter(Boolean));
    for (const c of loadChannels()) {
      // A binding to a GROUP that isn't our board (a stray /setup on a second
      // group, or a leftover from before this instance re-bound) is what shows
      // up as a DUPLICATE "general". Drop it. Negative id = group/supergroup;
      // DMs (positive id) are never dropped.
      if (c.telegram && c.telegram.chatId < 0 && c.telegram.chatId !== group) {
        removeChannel(c.sessionId);
        continue;
      }
      // Mirroring is a CHOICE (see the 2026-07-30 spec). Both directions, and
      // the loop converges: the web only flips `mirror`, we catch up here.
      // Declarative on purpose — a lost POST would leave a ghost topic.
      const wanted = isMirrored(c);
      // Un-mirroring DELETES a topic, so we demand an EXPLICIT `mirror ===
      // false`, never `isMirrored`'s fallback. A client that ignores the field —
      // an old tab, a script — must not be able to destroy a conversation by
      // omitting a key. It happened in repro: the web's boot restore path didn't
      // restore `mirror`, its first push overwrote the registry, and the loop
      // deleted the topic of a Telegram-born agent. Creating is reversible;
      // deleting is not.
      if (c.mirror === false && c.telegram && c.telegram.threadId != null && c.telegram.chatId === group) {
        // Un-mirror: close the bridge, delete the topic, forget the binding.
        // The CHANNEL survives — it's a web channel, it never depended on
        // Telegram; only its presence in the board group goes away.
        const th = c.telegram.threadId;
        const key = bindKey({ id: group, type: "supergroup" }, th);
        const b = bridges.get(key);
        if (b) {
          try { b.ws.close(); } catch { /* déjà fermé */ }
          bridges.delete(key);
        }
        console.log(`telegram: unmirroring channel ${c.sessionId.slice(0, 8)} — deleting topic ${th}`);
        await tg("deleteForumTopic", { chat_id: group, message_thread_id: th });
        saveTgTopics(loadTgTopics().filter((t) => t !== th));
        mirroring.delete(c.sessionId);
        upsertChannel({ sessionId: c.sessionId, telegram: null });
        continue;
      }
      if (!wanted) continue;
      // A channel that HAS a binding but LOST its bridge — a restarted session,
      // a killed pane, a crash. Rebuilding it used to happen only in
      // `reconcileOnBoot`, i.e. at server boot, so such a channel stayed deaf in
      // the agent → Telegram direction until something unrelated restarted the
      // server. The mirroring loop below could never save it either: it only
      // ever considers channels with NO binding at all.
      if (!bridged.has(c.sessionId)) reattachLiveBridge(c);
      // Mirror every un-bound web channel into the board as a topic — LIVE OR
      // NOT (an idle channel like a monitoring digest must still appear in
      // Telegram). openBridge resumes the existing session; no respawn.
      if (c.telegram || bridged.has(c.sessionId) || mirroring.has(c.sessionId)) continue;
      mirroring.add(c.sessionId);
      const name = (c.name || c.sessionId.slice(0, 8)).slice(0, 128);
      const t = await tg("createForumTopic", { chat_id: group, name });
      if (t?.ok) {
        const threadId = t.result.message_thread_id;
        addTgTopic(threadId);
        // Bind the new topic to the existing web session (shared, not a respawn).
        openBridge(bindKey({ id: group, type: "supergroup" }, threadId), group, threadId, {
          resumeId: c.sessionId,
          name,
          profile: c.profile ?? undefined, // keep the channel's role/secrets on mirror
          backfill: true, // fresh topic → replay recent history so it isn't empty
        });
      } else {
        mirroring.delete(c.sessionId); // couldn't create (perms/Topics off) — retry later
      }
    }
  };

  // Connect, retrying transient failures with backoff. A single network hiccup
  // on getMe used to leave Telegram dead for the whole run; only a real 401
  // (bad token) stops us now.
  /** Does a forum topic still exist? (No list API; probe with a no-op edit.) */
  // Whether a forum topic still exists — a no-op edit is the probe. THREE
  // outcomes, not two: it exists, it's DEFINITIVELY gone, or the check failed
  // for a transient/ambiguous reason (rate limit, network, bot not admin, chat
  // momentarily unreachable). Callers must never treat "unknown" as gone: a
  // single API hiccup once deleted a whole batch of channels whose agents were
  // still running (the board group id had been corrupted).
  const topicStatus = async (chatId: number, threadId: number): Promise<"exists" | "gone" | "unknown"> => {
    const r = await tg("editForumTopic", { chat_id: chatId, message_thread_id: threadId, icon_custom_emoji_id: "" });
    if (r?.ok || /NOT_MODIFIED/i.test(r?.description ?? "")) return "exists";
    const d = (r?.description ?? "").toLowerCase();
    if (/thread not found|topic_?id_?invalid|topic not found|message to edit not found/.test(d)) return "gone";
    return "unknown"; // 429 / network / not-admin / chat not found → keep the channel
  };
  const topicExists = async (chatId: number, threadId: number): Promise<boolean> =>
    (await topicStatus(chatId, threadId)) === "exists";

  /**
   * Self-heal after a crash: (1) a registry channel bound to a topic that no
   * longer exists → drop the channel (its topic is gone; the web tab was a
   * zombie); (2) a tracked topic with no channel → an orphan we delete. Keeps
   * web ⟷ Telegram from drifting across reboots. Runs once at connect.
   */
  /**
   * Adopter le propriétaire d'une installation DÉJÀ en service. Sans ça, la
   * mise à jour ouvrirait une fenêtre : le premier à écrire après le
   * déploiement s'approprie les DM — un inconnu pourrait verrouiller dehors
   * l'utilisateur légitime. Un chat privé a un id positif (les groupes sont
   * négatifs) et pas de topic : la liaison existante suffit à le désigner.
   */
  const adoptOwnerFromBindings = async () => {
    if (loadTgOwner() !== null) return;
    for (const c of loadChannels()) {
      const tgb = c.telegram;
      if (tgb && tgb.threadId == null && tgb.chatId > 0) {
        saveTgOwner(tgb.chatId);
        console.log(`telegram: DM owner adopted from an existing binding (user ${tgb.chatId})`);
        return;
      }
    }
    // Aucune liaison DM — le cas d'une installation pilotée uniquement depuis le
    // groupe. Le CRÉATEUR du groupe lié est celui qui a monté ce tableau : c'est
    // lui le propriétaire légitime. Sans ça, le premier inconnu à écrire au bot
    // après la mise à jour revendiquerait les DM à sa place.
    const group = loadTgGroup();
    if (group === null) return;
    const admins = await tg("getChatAdministrators", { chat_id: group });
    const creator = admins?.ok && Array.isArray(admins.result)
      ? admins.result.find((a: any) => a.status === "creator" && !a.user?.is_bot)
      : null;
    if (creator?.user?.id) {
      saveTgOwner(creator.user.id);
      console.log(`telegram: DM owner adopted from the board group's creator (user ${creator.user.id})`);
    }
  };

  const reconcileOnBoot = async () => {
    await adoptOwnerFromBindings();
    const group = loadTgGroup();
    if (group === null) return;
    const bound = new Set<number>();
    for (const c of loadChannels()) {
      const th = c.telegram?.threadId;
      if (!th) continue;
      const st = await topicStatus(c.telegram!.chatId, th);
      if (st === "exists") bound.add(th);
      else if (st === "gone") {
        console.log(`telegram: reconcile — channel ${c.sessionId.slice(0, 8)}'s topic ${th} is gone, dropping it`);
        removeChannel(c.sessionId);
      }
      // "unknown" (transient check failure) → leave the channel untouched.
    }
    // Rattacher les agents ENCORE VIVANTS. Un pont ne naissait jusqu'ici qu'au
    // prochain message du canal : après un redémarrage — donc à chaque
    // auto-update — personne n'écoutait, et tout ce que l'agent écrivait
    // pendant ce temps n'arrivait jamais dans Telegram (le web, lui, recharge
    // son historique). On se limite aux sessions dont le tmux tourne encore :
    // rouvrir un canal dormant ferait renaître un `claude` pour rien.
    for (const c of loadChannels()) {
      // `bound` = the topic still exists on Telegram's side, checked just above.
      // The rest of the rule (live session, no bridge yet) is shared with the 5s
      // loop through `reattachLiveBridge`, so the two can't drift apart.
      if (c.telegram?.threadId && bound.has(c.telegram.threadId)) reattachLiveBridge(c);
    }

    let kept = [...bound];
    for (const th of loadTgTopics()) {
      if (bound.has(th)) continue;
      if (await topicExists(group, th)) {
        console.log(`telegram: reconcile — deleting orphan topic ${th} (no channel)`);
        await tg("deleteForumTopic", { chat_id: group, message_thread_id: th });
      }
      // either way it's no longer a live tracked topic
    }
    saveTgTopics(kept);
  };

  const connect = async (attempt = 0): Promise<void> => {
    if (stopped) return;
    const me = await tg("getMe", {});
    if (me?.ok) {
      botUsername = `@${me.result.username}`;
      tokenError = null;
      polling = true;
      console.log(`telegram: bot ${botUsername} connected (long-polling)`);
      poll();
      announceUpdateResult();
      reconcileOnBoot().catch(() => {});
      reconcileTimer = setInterval(() => reconcileWebChannels().catch(() => {}), 5000);
      return;
    }
    if (me && me.error_code === 401) {
      tokenError = "401 Unauthorized — check the bot token";
      console.log("telegram: unauthorized — check the bot token");
      return;
    }
    const delay = Math.min(30_000, 2_000 * 2 ** attempt);
    console.log(`telegram: getMe failed (transient), retrying in ${delay / 1000}s`);
    setTimeout(() => connect(attempt + 1), delay);
  };
  connect();

  /** After a supervisor-driven /update, tell the board group how it went. */
  function announceUpdateResult(): void {
    const r = readAndClearUpdateResult();
    const group = loadTgGroup();
    if (!r || group === null) return;
    const text = r.ok ? `✅ updated to v${r.version}` : `⚠️ update failed: ${r.error}`;
    tg("sendMessage", { chat_id: group, text });
  }

  return {
    stop() {
      stopped = true;
      polling = false;
      pollAbort?.abort(); // free the in-flight 30s long-poll → no 409 on restart
      if (reconcileTimer) clearInterval(reconcileTimer);
      // Detach Telegram from its live sessions WITHOUT ending them: close the WS
      // client only, never send `stop` (that would kill the session).
      for (const b of bridges.values()) {
        try {
          b.ws.close();
        } catch {
          /* already closing */
        }
      }
      bridges.clear();
    },
    running: () => polling,
    status: () => ({ username: botUsername, tokenError }),
  };
}

/** One-shot getMe against a candidate token — for the /telegram status view. */
export async function probeToken(token: string | null): Promise<{ username: string | null; error: string | null }> {
  if (!token) return { username: null, error: null };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const j = await r.json();
    if (j?.ok) return { username: `@${j.result.username}`, error: null };
    return { username: null, error: j?.description ?? `HTTP ${r.status}` };
  } catch (e: any) {
    return { username: null, error: e?.message ?? "network error" };
  }
}

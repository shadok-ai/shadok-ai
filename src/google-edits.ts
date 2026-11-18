// Editing the CONTENT of a Google Slides deck, a Doc or a Sheet: one batch of
// operations per call. Everything here is pure — an agent's raw `ops` are
// checked and normalised (`editOpsVerdict`), described one line each for the
// person who approves them (`editOpLines`), and turned into the API's requests
// against the file as it is at that moment (`buildEditRequests`). Nothing an
// agent sends reaches Google as it came: only the fields named here do.
// Design: docs/superpowers/specs/2026-11-13-connected-accounts-google-design.md.
import { createHash, randomBytes } from "node:crypto";
import { GoogleError, GoogleInputError } from "./google.js";

export type EditApp = "slides" | "doc" | "sheet";
/** A checked operation: `op` plus only the fields that operation takes.
 *  `note` is what the file said about its target when the card was made (a
 *  slide's number and title…) — shown to the person, never sent to Google. */
export type EditOp = { op: string; note?: string } & Record<string, unknown>;

export const MAX_EDIT_OPS = 50;
const MAX_TEXT = 20_000;
const MAX_FIND = 1_000;
const MAX_CELLS = 20_000;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** What would break a one-line field out of its line on a card, or reorder it
 *  on screen: every line break Unicode knows, tabs, and the bidi controls. */
const LINE_BREAKERS = /[\r\n\t\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

const bad = (m: string): never => {
  throw new GoogleInputError(m);
};
type Raw = Record<string, unknown>;

function text(o: Raw, key: string, where: string, opt: { max?: number; empty?: boolean; oneLine?: boolean } = {}): string {
  const v = o[key];
  const max = opt.max ?? MAX_TEXT;
  if (typeof v !== "string") return bad(`${where}: '${key}' must be text.`);
  if (!opt.empty && !v) return bad(`${where}: '${key}' is empty.`);
  if (v.length > max) return bad(`${where}: '${key}' is over ${max} characters.`);
  if (CONTROL.test(v) || (opt.oneLine && LINE_BREAKERS.test(v))) return bad(`${where}: '${key}' contains a control character.`);
  return v;
}
function int(o: Raw, key: string, where: string, min: number, max: number): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return bad(`${where}: '${key}' must be a whole number from ${min} to ${max}.`);
  return v;
}
function flag(o: Raw, key: string, where: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") return bad(`${where}: '${key}' must be true or false.`);
  return v;
}
/** An id of something inside a file (a slide, a shape): Google's are short words. */
function objectId(o: Raw, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_:.-]{0,99}$/.test(v)) return bad(`${where}: '${key}' is not a valid object id (see \`slides read\`).`);
  return v;
}
/** An id for something this batch CREATES, as Slides accepts one: 5 to 50
 *  characters, starting with a letter, a digit or `_`. */
const NEW_ID = /^[A-Za-z0-9_][A-Za-z0-9_:-]{4,49}$/;
function newObjectIdField(v: unknown, where: string): string {
  if (typeof v !== "string" || !NEW_ID.test(v)) return bad(`${where} must be a new object id: 5 to 50 letters, digits, '_', '-' or ':', not starting with '-' or ':'.`);
  return v;
}
function onlyKeys(o: Raw, where: string, keys: readonly string[]): void {
  const extra = Object.keys(o).filter((k) => k !== "op" && !keys.includes(k));
  if (extra.length) bad(`${where}: unknown field '${extra[0].slice(0, 40)}' (it takes: ${keys.join(", ") || "nothing"}).`);
}

// ---- images from a URL ------------------------------------------------------

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^192\.0\.0\./, /^198\.1[89]\./, /^2(2[4-9]|[3-5]\d)\./];

/**
 * An image Google will fetch by URL: https only, a public host name. Google
 * fetches it, not this server — but an agent must not be able to point ANY
 * fetcher at an internal address through us, so loopback, private, link-local
 * and metadata hosts, bare names and IP-literal tricks are refused here, with
 * the reason.
 */
export function imageUrlVerdict(v: unknown, where = "insert_image"): string {
  if (typeof v !== "string" || !v || v.length > 2000 || CONTROL.test(v) || /\s/.test(v)) return bad(`${where}: 'url' must be an https address of at most 2000 characters.`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return bad(`${where}: 'url' is not a valid address.`);
  }
  if (u.protocol !== "https:") return bad(`${where}: only https image addresses are accepted.`);
  if (u.username || u.password) return bad(`${where}: an image address cannot carry a user name or a password.`);
  if (u.port && u.port !== "443") return bad(`${where}: an image address cannot name a port.`);
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.split(".").some((label) => !label)) return bad(`${where}: 'url' is not a valid address.`);
  const internal = () => bad(`${where}: '${host.slice(0, 80)}' is an internal or private address — only images on the public internet can be inserted.`);
  if (host.startsWith("[")) return internal(); // any IPv6 literal: never needed for a public image
  if (/^\d+(\.\d+){3}$/.test(host)) {
    if (PRIVATE_V4.some((r) => r.test(host))) return internal();
  } else if (!host.includes(".") || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example|onion)$/.test(host) || host === "metadata.google.internal") {
    return internal();
  }
  return u.toString();
}

// ---- validation -------------------------------------------------------------

const SLIDE_LAYOUTS = ["BLANK", "TITLE", "TITLE_ONLY", "TITLE_AND_BODY", "SECTION_HEADER"] as const;
const HEADINGS = ["NORMAL", "H1", "H2", "H3", "H4", "H5", "H6"] as const;

/** A fresh object id for something this batch creates (Slides wants 5–50 word characters). */
export const newObjectId = (): string => `sk_${randomBytes(8).toString("hex")}`;

function replaceOp(o: Raw, w: string): EditOp {
  onlyKeys(o, w, ["find", "replace", "matchCase"]);
  return { op: "replace_text", find: text(o, "find", w, { max: MAX_FIND }), replace: text(o, "replace", w, { empty: true }), matchCase: flag(o, "matchCase", w) ?? true };
}

function slidesOp(o: Raw, w: string, newId: () => string): EditOp {
  switch (o.op) {
    case "replace_text":
      return replaceOp(o, w);
    case "add_slide": {
      onlyKeys(o, w, ["layout", "layoutId", "title", "body", "at"]);
      const title = o.title === undefined ? undefined : text(o, "title", w);
      const body = o.body === undefined ? undefined : text(o, "body", w);
      if (o.layout !== undefined && o.layoutId !== undefined) return bad(`${w}: give 'layout' or 'layoutId', not both.`);
      // Which layout: a standard one by its type, one of the DECK's own by its
      // id or its name (\`slides read\` lists them). A deck built on custom
      // layouts only — most company decks — has none of the standard ones.
      let which: Record<string, string>;
      if (o.layoutId !== undefined) which = { layoutId: objectId(o, "layoutId", w) };
      else if (typeof o.layout === "string" && !(SLIDE_LAYOUTS as readonly string[]).includes(o.layout)) which = { layoutName: text(o, "layout", w, { max: 200, oneLine: true }) };
      else {
        const layout = o.layout === undefined ? (body !== undefined ? "TITLE_AND_BODY" : title !== undefined ? "TITLE_ONLY" : "BLANK") : o.layout;
        if (typeof layout !== "string") return bad(`${w}: 'layout' must be one of ${SLIDE_LAYOUTS.join(", ")}, or the name of one of the deck's layouts (see \`slides read\`).`);
        if (layout === "BLANK" && (title !== undefined || body !== undefined)) return bad(`${w}: a BLANK slide has no title or body — pick another layout.`);
        if ((layout === "TITLE_ONLY" || layout === "SECTION_HEADER") && body !== undefined) return bad(`${w}: a ${layout} slide has no body — use TITLE_AND_BODY.`);
        which = { layout };
      }
      return {
        op: "add_slide", ...which, slideId: newId(),
        ...(title !== undefined ? { title, titleId: newId() } : {}),
        ...(body !== undefined ? { body, bodyId: newId() } : {}),
        ...(o.at !== undefined ? { at: int(o, "at", w, 0, 1000) } : {}),
      };
    }
    case "duplicate_slide": {
      onlyKeys(o, w, ["slideId", "at", "objectIds"]);
      const slideId = objectId(o, "slideId", w);
      // \`objectIds\` names the copy's objects in advance ({source id: new id}),
      // so a later operation of THIS batch can target them. What it leaves out
      // is named by the server (\`copyIds\`) and reported back.
      const map: Record<string, string> = {};
      if (o.objectIds !== undefined) {
        const m = o.objectIds;
        if (!m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).length > 200) return bad(`${w}: 'objectIds' must be an object of at most 200 {"<source id>": "<new id>"} pairs.`);
        for (const [k, v] of Object.entries(m as Raw)) map[objectId({ k }, "k", `${w} objectIds`)] = newObjectIdField(v, `${w}: objectIds["${k.slice(0, 40)}"]`);
        if (new Set(Object.values(map)).size !== Object.values(map).length) return bad(`${w}: 'objectIds' gives the same new id twice.`);
      }
      const newSlideId = map[slideId] ?? newId();
      delete map[slideId];
      // Derived element ids are \`<copy id>_<8 hex>\`: they must stay within 50.
      if (newSlideId.length > 41) return bad(`${w}: the copy's new slide id must be at most 41 characters (its elements' ids are built from it).`);
      return { op: "duplicate_slide", slideId, newSlideId, ...(Object.keys(map).length ? { objectIds: map } : {}), ...(o.at !== undefined ? { at: int(o, "at", w, 0, 1000) } : {}) };
    }
    case "delete_slide":
      onlyKeys(o, w, ["slideId"]);
      return { op: "delete_slide", slideId: objectId(o, "slideId", w) };
    case "insert_text":
      onlyKeys(o, w, ["objectId", "text", "at"]);
      return { op: "insert_text", objectId: objectId(o, "objectId", w), text: text(o, "text", w), ...(o.at !== undefined ? { at: int(o, "at", w, 0, 1_000_000) } : {}) };
    case "delete_text":
      onlyKeys(o, w, ["objectId"]);
      return { op: "delete_text", objectId: objectId(o, "objectId", w) };
    case "insert_image": {
      onlyKeys(o, w, ["slideId", "url", "x", "y", "w", "h"]);
      const box: Record<string, number> = {};
      for (const k of ["x", "y", "w", "h"]) {
        if (o[k] === undefined) continue;
        if (typeof o[k] !== "number" || !Number.isFinite(o[k]) || (o[k] as number) < 0 || (o[k] as number) > 5000) return bad(`${w}: '${k}' must be a number of points from 0 to 5000.`);
        box[k] = o[k] as number;
      }
      if ((box.w === undefined) !== (box.h === undefined)) return bad(`${w}: give both 'w' and 'h', or neither.`);
      return { op: "insert_image", slideId: objectId(o, "slideId", w), url: imageUrlVerdict(o.url, w), ...box };
    }
    case "reorder": {
      onlyKeys(o, w, ["slideIds", "at"]);
      if (!Array.isArray(o.slideIds) || !o.slideIds.length || o.slideIds.length > 50) return bad(`${w}: 'slideIds' must list 1 to 50 slide ids.`);
      const ids = o.slideIds.map((x, i) => objectId({ v: x }, "v", `${w} slideIds[${i}]`));
      if (new Set(ids).size !== ids.length) return bad(`${w}: 'slideIds' names a slide twice.`);
      return { op: "reorder", slideIds: ids, at: int(o, "at", w, 0, 1000) };
    }
    default:
      return bad(`${w}: unknown Slides operation '${String(o.op).slice(0, 40)}' (replace_text, add_slide, duplicate_slide, delete_slide, insert_text, delete_text, insert_image, reorder).`);
  }
}

type DocAt = "start" | "end" | { after: string };
function docAt(o: Raw, w: string): DocAt {
  const v = o.at;
  if (v === undefined || v === null || v === "end") return "end";
  if (v === "start") return "start";
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as Raw).after === "string") {
    return { after: text(v as Raw, "after", w, { max: 300, oneLine: true }).trim() || bad(`${w}: 'at.after' is empty.`) };
  }
  return bad(`${w}: 'at' must be "start", "end" or {"after": "<heading text>"}.`);
}

function docOp(o: Raw, w: string): EditOp {
  switch (o.op) {
    case "replace_text":
      return replaceOp(o, w);
    case "delete_text":
      onlyKeys(o, w, ["find", "matchCase"]);
      return { op: "delete_text", find: text(o, "find", w, { max: MAX_FIND }), matchCase: flag(o, "matchCase", w) ?? true };
    case "insert_text":
      onlyKeys(o, w, ["text", "at"]);
      return { op: "insert_text", text: text(o, "text", w), at: docAt(o, w) };
    case "style": {
      onlyKeys(o, w, ["find", "heading", "bold", "italic", "bullet"]);
      const heading = o.heading;
      if (heading !== undefined && (typeof heading !== "string" || !(HEADINGS as readonly string[]).includes(heading))) return bad(`${w}: 'heading' must be one of ${HEADINGS.join(", ")}.`);
      const bold = flag(o, "bold", w);
      const italic = flag(o, "italic", w);
      const bullet = flag(o, "bullet", w);
      if (bullet === false) return bad(`${w}: 'bullet' can only be true.`);
      if (heading === undefined && bold === undefined && italic === undefined && !bullet) return bad(`${w}: give at least one of heading, bold, italic, bullet.`);
      return { op: "style", find: text(o, "find", w, { max: MAX_FIND }), ...(heading !== undefined ? { heading } : {}), ...(bold !== undefined ? { bold } : {}), ...(italic !== undefined ? { italic } : {}), ...(bullet ? { bullet: true } : {}) };
    }
    case "insert_table": {
      onlyKeys(o, w, ["rows", "cols", "at", "cells"]);
      const rows = int(o, "rows", w, 1, 20);
      const cols = int(o, "cols", w, 1, 10);
      let cells: string[][] | undefined;
      if (o.cells !== undefined) {
        if (!Array.isArray(o.cells) || o.cells.length > rows || !o.cells.every((r) => Array.isArray(r) && r.length <= cols && r.every((c) => typeof c === "string" && c.length <= 2000 && !CONTROL.test(c) && !/[\r\n]/.test(c))))
          return bad(`${w}: 'cells' must be rows of one-line text that fit the ${rows}×${cols} table.`);
        cells = (o.cells as string[][]).map((r) => [...r]);
      }
      return { op: "insert_table", rows, cols, at: docAt(o, w), ...(cells ? { cells } : {}) };
    }
    case "insert_image":
      onlyKeys(o, w, ["url", "at"]);
      return { op: "insert_image", url: imageUrlVerdict(o.url, w), at: docAt(o, w) };
    default:
      return bad(`${w}: unknown Docs operation '${String(o.op).slice(0, 40)}' (replace_text, insert_text, delete_text, style, insert_table, insert_image).`);
  }
}

type Cell = string | number | boolean;
function cellRows(v: unknown, w: string): Cell[][] {
  const ok = (c: unknown) => (typeof c === "string" && c.length <= MAX_TEXT && !CONTROL.test(c)) || (typeof c === "number" && Number.isFinite(c)) || typeof c === "boolean";
  if (!Array.isArray(v) || !v.length || v.length > 1000 || !v.every((r) => Array.isArray(r) && r.length <= 200 && r.every(ok))) return bad(`${w}: 'values' must be a non-empty list of rows of text, numbers or booleans.`);
  if ((v as unknown[][]).reduce((n, r) => n + r.length, 0) > MAX_CELLS) return bad(`${w}: 'values' holds more than ${MAX_CELLS} cells.`);
  return (v as Cell[][]).map((r) => [...r]);
}
const tabName = (o: Raw, key: string, w: string) => text(o, key, w, { max: 100, oneLine: true });
function a1(o: Raw, w: string): string {
  const v = text(o, "range", w, { max: 200, oneLine: true });
  parseA1(v, w);
  return v;
}

function sheetOp(o: Raw, w: string): EditOp {
  switch (o.op) {
    case "update":
      onlyKeys(o, w, ["range", "values"]);
      return { op: "update", range: a1(o, w), values: cellRows(o.values, w) };
    case "clear":
      onlyKeys(o, w, ["range"]);
      return { op: "clear", range: a1(o, w) };
    case "add_tab":
      onlyKeys(o, w, ["title"]);
      return { op: "add_tab", title: tabName(o, "title", w), sheetId: 1 + (randomBytes(4).readUInt32BE(0) % 2_000_000_000) };
    case "delete_tab":
      onlyKeys(o, w, ["title"]);
      return { op: "delete_tab", title: tabName(o, "title", w) };
    case "rename_tab":
      onlyKeys(o, w, ["from", "to"]);
      return { op: "rename_tab", from: tabName(o, "from", w), to: tabName(o, "to", w) };
    case "insert_rows":
    case "delete_rows":
    case "insert_cols":
    case "delete_cols":
      onlyKeys(o, w, ["tab", "start", "count"]);
      return { op: o.op, ...(o.tab !== undefined ? { tab: tabName(o, "tab", w) } : {}), start: int(o, "start", w, 1, 1_000_000), count: int(o, "count", w, 1, 10_000) };
    case "format": {
      onlyKeys(o, w, ["range", "bold", "italic", "background", "numberFormat"]);
      const bold = flag(o, "bold", w);
      const italic = flag(o, "italic", w);
      const background = o.background;
      if (background !== undefined && (typeof background !== "string" || !/^#[0-9a-fA-F]{6}$/.test(background))) return bad(`${w}: 'background' must be a colour like #ffcc00.`);
      const numberFormat = o.numberFormat === undefined ? undefined : text(o, "numberFormat", w, { max: 100, oneLine: true });
      if (bold === undefined && italic === undefined && background === undefined && numberFormat === undefined) return bad(`${w}: give at least one of bold, italic, background, numberFormat.`);
      return { op: "format", range: a1(o, w), ...(bold !== undefined ? { bold } : {}), ...(italic !== undefined ? { italic } : {}), ...(background !== undefined ? { background: (background as string).toLowerCase() } : {}), ...(numberFormat !== undefined ? { numberFormat } : {}) };
    }
    default:
      return bad(`${w}: unknown Sheets operation '${String(o.op).slice(0, 40)}' (update, clear, add_tab, delete_tab, rename_tab, insert_rows, delete_rows, insert_cols, delete_cols, format).`);
  }
}

/** Operations that are LOCATED in a Doc as it is when the batch starts. */
const docPositional = (o: EditOp) => o.op === "style" || ((o.op === "insert_text" || o.op === "insert_table" || o.op === "insert_image") && o.at !== "end") || (o.op === "insert_table" && Array.isArray(o.cells));

/**
 * An agent's raw `ops` → the checked batch. Every operation is validated, an
 * unknown one or an unknown field is refused (never dropped), and the batch is
 * capped. Ids of what the batch creates are drawn here, so the card and the
 * request name the same objects.
 */
export function editOpsVerdict(app: EditApp, raw: unknown, newId: () => string = newObjectId): EditOp[] {
  if (!Array.isArray(raw) || !raw.length) return bad("Give the operations as a non-empty JSON array (on stdin).");
  if (raw.length > MAX_EDIT_OPS) return bad(`At most ${MAX_EDIT_OPS} operations per edit — send the rest in a second one.`);
  const ops = raw.map((o, i) => {
    const w = `operation ${i + 1}`;
    if (!o || typeof o !== "object" || Array.isArray(o) || typeof (o as Raw).op !== "string") return bad(`${w}: must be an object with an 'op'.`);
    return app === "slides" ? slidesOp(o as Raw, w, newId) : app === "doc" ? docOp(o as Raw, w) : sheetOp(o as Raw, w);
  });
  if (app === "doc") {
    // Located operations are sent first (`docRequests`); listed after one
    // that is not, the card's order would not be the order applied.
    const firstOther = ops.findIndex((o) => !docPositional(o));
    const late = ops.findIndex((o, i) => firstOther >= 0 && i > firstOther && docPositional(o));
    if (late >= 0) bad(`operation ${late + 1}: in one edit, style operations and inserts placed at the start or after a heading (and a table with cells) must come FIRST — before replace_text, delete_text and anything added at the end: they are located in the document as it is now. Reorder them, or send a second edit.`);
  }
  return ops;
}

// ---- one line per operation -------------------------------------------------

/** A text as it appears on a card line: quoted, and with every character that
 *  could start a new line or reorder the line shown as its escape. */
const q = (s: unknown) => JSON.stringify(String(s ?? "")).replace(/[\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const onTab = (range: unknown) => (String(range).includes("!") ? "" : " (first tab)");
const caseNote = (o: EditOp) => (o.matchCase === false ? " (any case)" : "");
const atWords = (at: unknown) => (at === "start" ? "at the start" : at === "end" || at === undefined ? "at the end" : `after the heading ${q((at as { after: string }).after)}`);
const noteOf = (o: EditOp) => (o.note ? ` — ${o.note}` : "");

/** What each operation will do, in words, with its text and values in full:
 *  this IS what a person approves (invariant 43). Derived from the same `ops`
 *  the request is built from — never stored apart from them. */
export function editOpLines(app: EditApp, ops: readonly EditOp[]): string[] {
  return ops.map((o) => {
    if (o.op === "replace_text") return `Replace every ${q(o.find)} with ${q(o.replace)}${caseNote(o)}`;
    if (app === "slides") {
      if (o.op === "add_slide") {
        const kind = o.layout !== undefined ? `a ${o.layout} slide` : o.layoutName !== undefined ? `a slide with the deck's layout ${q(o.layoutName)}` : `a slide with the deck's layout ${o.layoutId}`;
        return `Add ${kind} ${o.at === undefined ? "at the end" : `at position ${(o.at as number) + 1}`}${o.title !== undefined ? ` — title: ${q(o.title)}` : ""}${o.body !== undefined ? ` — body: ${q(o.body)}` : ""}${noteOf(o)}`;
      }
      if (o.op === "duplicate_slide") return `Duplicate slide ${o.slideId} — the copy goes ${o.at === undefined ? "right after it" : `to position ${(o.at as number) + 1}`}${noteOf(o)}`;
      if (o.op === "delete_slide") return `Delete slide ${o.slideId}${noteOf(o)}`;
      if (o.op === "insert_text") return `Insert ${q(o.text)} into ${o.objectId} ${o.at === undefined ? "at the end of its text" : `at character ${o.at}`}${noteOf(o)}`;
      if (o.op === "delete_text") return `Delete all the text of ${o.objectId}${noteOf(o)}`;
      if (o.op === "insert_image") {
        const box = [o.w !== undefined ? `${o.w}×${o.h} pt` : "", o.x !== undefined || o.y !== undefined ? `at ${o.x ?? 0},${o.y ?? 0} pt` : ""].filter(Boolean).join(" ");
        return `Insert the image ${o.url} on slide ${o.slideId}${box ? ` (${box})` : ""}${noteOf(o)}`;
      }
      // Slides counts the place BEFORE the move, so that is what is said.
      return `Move slide${(o.slideIds as string[]).length === 1 ? "" : "s"} ${(o.slideIds as string[]).join(", ")} to just before the slide that is now number ${(o.at as number) + 1} (to the end if there is none)${noteOf(o)}`;
    }
    if (app === "doc") {
      if (o.op === "delete_text") return `Delete every ${q(o.find)}${caseNote(o)}`;
      if (o.op === "insert_text") return `Insert ${q(o.text)} ${atWords(o.at)}`;
      if (o.op === "style") {
        const what = [o.heading !== undefined ? (o.heading === "NORMAL" ? "normal text" : `heading ${String(o.heading).slice(1)}`) : "", o.bold !== undefined ? (o.bold ? "bold" : "not bold") : "", o.italic !== undefined ? (o.italic ? "italic" : "not italic") : "", o.bullet ? "a bullet list" : ""].filter(Boolean);
        return `Make every ${q(o.find)} ${what.join(", ")}${noteOf(o)}`;
      }
      if (o.op === "insert_table") return `Insert a ${o.rows}×${o.cols} table ${atWords(o.at)}${o.cells ? ` — cells: ${(o.cells as string[][]).map((r) => `[${r.map(q).join(",")}]`).join(" ; ")}` : ""}`;
      return `Insert the image ${o.url} ${atWords(o.at)}`;
    }
    const tab = o.tab ? ` of tab ${q(o.tab)}` : " of the first tab";
    if (o.op === "update") return `Write at ${o.range}${onTab(o.range)}: ${(o.values as Cell[][]).map((r) => `[${r.map((c) => (typeof c === "string" ? q(c) : String(c))).join(",")}]`).join(" ; ")}`;
    if (o.op === "clear") return `Clear ${o.range}${onTab(o.range)}`;
    if (o.op === "add_tab") return `Add a tab ${q(o.title)}`;
    if (o.op === "delete_tab") return `Delete the tab ${q(o.title)} and everything in it`;
    if (o.op === "rename_tab") return `Rename the tab ${q(o.from)} to ${q(o.to)}`;
    if (o.op === "insert_rows") return `Insert ${o.count} row${o.count === 1 ? "" : "s"} before row ${o.start}${tab}`;
    if (o.op === "delete_rows") return `Delete ${o.count} row${o.count === 1 ? "" : "s"} from row ${o.start}${tab}`;
    if (o.op === "insert_cols") return `Insert ${o.count} column${o.count === 1 ? "" : "s"} before column ${o.start}${tab}`;
    if (o.op === "delete_cols") return `Delete ${o.count} column${o.count === 1 ? "" : "s"} from column ${o.start}${tab}`;
    const fmt = [o.bold !== undefined ? (o.bold ? "bold" : "not bold") : "", o.italic !== undefined ? (o.italic ? "italic" : "not italic") : "", o.background ? `background ${o.background}` : "", o.numberFormat !== undefined ? `number format ${q(o.numberFormat)}` : ""].filter(Boolean);
    return `Format ${o.range}${onTab(o.range)}: ${fmt.join(", ")}`;
  });
}

/** `replace_text ×2, add_slide ×1` — what the LOG keeps of a batch: never a text. */
export function editOpCounts(ops: readonly EditOp[]): string {
  const n = new Map<string, number>();
  for (const o of ops) n.set(o.op, (n.get(o.op) ?? 0) + 1);
  return [...n].map(([k, v]) => `${k} ×${v}`).join(", ");
}

// ---- the file as it is: what requests are built against ---------------------

export interface SlidesState {
  app: "slides";
  title: string;
  revisionId?: string;
  slides: { id: string; layout: string; elements: { id: string; type: string; text: string }[] }[];
  /** The deck's own layouts (every master's): what \`add_slide\` can name by
   *  id or name. \`placeholders\` are where a title and a body can go. */
  layouts: { id: string; name: string; placeholders: { id: string; type: string; index: number }[] }[];
}
export interface DocState {
  app: "doc";
  title: string;
  revisionId?: string;
  /** Every paragraph of the body (tables included), in order. `text` maps 1:1
   *  onto indices: character k sits at index `start + k`. */
  paragraphs: { start: number; end: number; style: string; text: string }[];
  /** The body's end index (its last newline is at `end - 1`). */
  end: number;
}
export interface SheetState {
  app: "sheet";
  title: string;
  tabs: { id: number; title: string }[];
}
export type EditState = SlidesState | DocState | SheetState;

type J = Record<string, any>;
const runsText = (t: J | undefined): string => ((t?.textElements ?? []) as J[]).map((e) => e.textRun?.content ?? "").join("");

function slideElements(els: J[] | undefined): SlidesState["slides"][number]["elements"] {
  const out: SlidesState["slides"][number]["elements"] = [];
  for (const e of els ?? []) {
    if (e.elementGroup) {
      out.push(...slideElements(e.elementGroup.children));
      continue;
    }
    const id = String(e.objectId ?? "");
    if (e.shape) out.push({ id, type: e.shape.placeholder?.type ? `placeholder ${e.shape.placeholder.type}` : String(e.shape.shapeType ?? "shape").toLowerCase(), text: runsText(e.shape.text) });
    else if (e.table) out.push({ id, type: "table", text: ((e.table.tableRows ?? []) as J[]).map((r) => ((r.tableCells ?? []) as J[]).map((c) => runsText(c.text).trim()).join(" | ")).join("\n") });
    else out.push({ id, type: e.image ? "image" : e.video ? "video" : e.line ? "line" : e.sheetsChart ? "chart" : "other", text: "" });
  }
  return out;
}

export function slidesState(p: J): SlidesState {
  const layouts: SlidesState["layouts"] = ((p.layouts ?? []) as J[]).map((l) => ({
    id: String(l.objectId ?? ""),
    name: String(l.layoutProperties?.displayName || l.layoutProperties?.name || ""),
    placeholders: ((l.pageElements ?? []) as J[])
      .filter((e) => e.shape?.placeholder?.type)
      .map((e) => ({ id: String(e.objectId ?? ""), type: String(e.shape.placeholder.type), index: Number(e.shape.placeholder.index ?? 0) })),
  }));
  const names = new Map(layouts.map((l) => [l.id, l.name]));
  return {
    app: "slides",
    title: String(p.title ?? ""),
    ...(typeof p.revisionId === "string" ? { revisionId: p.revisionId } : {}),
    slides: ((p.slides ?? []) as J[]).map((s) => ({ id: String(s.objectId ?? ""), layout: names.get(String(s.slideProperties?.layoutObjectId)) ?? "", elements: slideElements(s.pageElements) })),
    layouts,
  };
}

export function docState(d: J): DocState {
  const paragraphs: DocState["paragraphs"] = [];
  const walk = (content: J[] | undefined) => {
    for (const c of content ?? []) {
      if (c.paragraph) {
        let t = "";
        for (const e of (c.paragraph.elements ?? []) as J[]) {
          const len = Math.max(0, Number(e.endIndex) - Number(e.startIndex ?? 0)) || 0;
          const run = typeof e.textRun?.content === "string" ? e.textRun.content : null;
          // Anything that is not text (an inline image, a page break) still
          // takes its indices: a filler keeps offsets and indices aligned.
          t += run !== null && run.length === len ? run : "￼".repeat(len);
        }
        paragraphs.push({ start: Number(c.startIndex ?? 0), end: Number(c.endIndex ?? 0), style: String(c.paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT"), text: t });
      } else if (c.table) {
        for (const r of (c.table.tableRows ?? []) as J[]) for (const cell of (r.tableCells ?? []) as J[]) walk(cell.content);
      }
    }
  };
  const content = (d.body?.content ?? []) as J[];
  walk(content);
  return { app: "doc", title: String(d.title ?? ""), ...(typeof d.revisionId === "string" ? { revisionId: d.revisionId } : {}), paragraphs, end: Number(content.at(-1)?.endIndex ?? 1) };
}

/** The headings of a document, in order — what `insert … after` can target. */
export function docHeadings(s: DocState): { level: number; text: string }[] {
  return s.paragraphs.filter((p) => /^HEADING_[1-6]$/.test(p.style) && p.text.trim()).map((p) => ({ level: Number(p.style.slice(8)), text: p.text.trim() }));
}

export function sheetState(s: J): SheetState {
  return { app: "sheet", title: String(s.properties?.title ?? ""), tabs: ((s.sheets ?? []) as J[]).map((x) => ({ id: Number(x.properties?.sheetId ?? 0), title: String(x.properties?.title ?? "") })) };
}

// ---- A1 ranges --------------------------------------------------------------

const colNumber = (letters: string) => [...letters.toUpperCase()].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0);

/** `Tab!B2:D9`, `'My tab'!A:C`, `3:5`, `B2` → the tab named (if any) and a
 *  0-based half-open box; an open side is absent. */
export function parseA1(range: string, where = "range"): { tab?: string; r0?: number; r1?: number; c0?: number; c1?: number } {
  const m = /^(?:(?:'((?:[^']|'')+)'|([^'!]+))!)?([A-Za-z]{0,3})(\d{0,7})(?::([A-Za-z]{0,3})(\d{0,7}))?$/.exec(range.trim());
  // `A1:` (nothing after the colon) would read as "everything": refused.
  if (!m || (!m[3] && !m[4]) || (m[5] === "" && m[6] === "") || m[4] === "0" || /^0+$/.test(m[6] ?? "x")) return bad(`${where}: '${range.slice(0, 60)}' is not an A1 range (e.g. Sheet1!A2:C9).`);
  const tab = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2];
  const single = m[5] === undefined && m[6] === undefined;
  const c0 = m[3] ? colNumber(m[3]) - 1 : undefined;
  const r0 = m[4] ? Number(m[4]) - 1 : undefined;
  const c1 = single ? (c0 !== undefined ? c0 + 1 : undefined) : m[5] ? colNumber(m[5]) : undefined;
  const r1 = single ? (r0 !== undefined ? r0 + 1 : undefined) : m[6] ? Number(m[6]) : undefined;
  if ((r0 !== undefined && r0 < 0) || (r1 !== undefined && r0 !== undefined && r1 <= r0) || (c1 !== undefined && c0 !== undefined && c1 <= c0)) return bad(`${where}: '${range.slice(0, 60)}' is not a valid range.`);
  return { ...(tab !== undefined ? { tab } : {}), ...(r0 !== undefined ? { r0 } : {}), ...(r1 !== undefined ? { r1 } : {}), ...(c0 !== undefined ? { c0 } : {}), ...(c1 !== undefined ? { c1 } : {}) };
}

// ---- requests ---------------------------------------------------------------

function occurrences(s: DocState, find: string, w: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const p of s.paragraphs) {
    for (let i = p.text.indexOf(find); i >= 0; i = p.text.indexOf(find, i + find.length)) out.push({ start: p.start + i, end: p.start + i + find.length });
  }
  // No text in these sentences: a refusal goes to the account's log.
  if (!out.length) return bad(`${w}: its 'find' text is not in the document as it is now (see \`doc read\`).`);
  if (out.length > 200) return bad(`${w}: its 'find' text appears more than 200 times — style a more specific text.`);
  return out;
}

/** Where a located Docs operation goes: an index, or null for "the end". */
function docIndex(s: DocState, at: unknown, w: string): number | null {
  if (at === "start") return 1;
  if (at === "end" || at === undefined) return null;
  const want = (at as { after: string }).after;
  const h = s.paragraphs.find((p) => /^HEADING_[1-6]$/.test(p.style) && p.text.trim() === want);
  if (!h) return bad(`${w}: there is no heading with that exact text in the document as it is now (see \`doc read\`).`);
  // A heading that closes the document: nothing can be inserted past the last newline.
  return h.end >= s.end ? null : h.end;
}

function docRequests(ops: readonly EditOp[], s: DocState): J[] {
  const located: { index: number; order: number; insert: boolean; reqs: J[] }[] = [];
  const sequential: J[] = [];
  ops.forEach((o, i) => {
    const w = `operation ${i + 1}`;
    if (o.op === "replace_text" || o.op === "delete_text") {
      sequential.push({ replaceAllText: { containsText: { text: o.find, matchCase: o.matchCase !== false }, replaceText: o.op === "delete_text" ? "" : o.replace } });
    } else if (o.op === "style") {
      const hits = occurrences(s, String(o.find), w);
      const textStyle = { ...(o.bold !== undefined ? { bold: o.bold } : {}), ...(o.italic !== undefined ? { italic: o.italic } : {}) };
      const fields = Object.keys(textStyle).join(",");
      for (const r of hits) {
        const range = { startIndex: r.start, endIndex: r.end };
        const reqs: J[] = [];
        if (fields) reqs.push({ updateTextStyle: { range, textStyle, fields } });
        if (o.heading !== undefined) reqs.push({ updateParagraphStyle: { range, paragraphStyle: { namedStyleType: o.heading === "NORMAL" ? "NORMAL_TEXT" : `HEADING_${String(o.heading).slice(1)}` }, fields: "namedStyleType" } });
        if (o.bullet) reqs.push({ createParagraphBullets: { range, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } });
        located.push({ index: r.start, order: i, insert: false, reqs });
      }
    } else if (o.op === "insert_text") {
      const index = docIndex(s, o.at, w);
      const after = typeof o.at === "object";
      if (index === null) {
        // At the end; after a closing heading the text starts on its own line.
        sequential.push({ insertText: { text: after ? `\n${o.text}` : o.text, endOfSegmentLocation: {} } });
      } else if (!after) {
        located.push({ index, order: i, insert: true, reqs: [{ insertText: { text: o.text, location: { index } } }] });
      } else {
        // Its own paragraph(s) under the heading, as normal text — not a
        // continuation of the heading's style.
        const t = String(o.text).endsWith("\n") ? String(o.text) : `${o.text}\n`;
        located.push({ index, order: i, insert: true, reqs: [{ insertText: { text: t, location: { index } } }, { updateParagraphStyle: { range: { startIndex: index, endIndex: index + t.length }, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } }] });
      }
    } else if (o.op === "insert_table") {
      const rows = Number(o.rows);
      const cols = Number(o.cols);
      const cells = (o.cells as string[][] | undefined) ?? [];
      let index = docIndex(s, o.at, w);
      if (index === null && !cells.length) {
        sequential.push({ insertTable: { rows, columns: cols, endOfSegmentLocation: {} } });
        return;
      }
      if (index === null) index = Math.max(1, s.end - 1);
      const reqs: J[] = [{ insertTable: { rows, columns: cols, location: { index } } }];
      // The new table starts one index further (Docs puts a newline before
      // it); its first cell's text is 3 further, each cell takes 2 and each
      // row 1 more. Filled last cell first, so earlier indices stay true.
      for (let r = cells.length - 1; r >= 0; r--) {
        for (let c = cells[r].length - 1; c >= 0; c--) {
          if (cells[r][c]) reqs.push({ insertText: { text: cells[r][c], location: { index: index + 4 + r * (2 * cols + 1) + 2 * c } } });
        }
      }
      located.push({ index, order: i, insert: true, reqs });
    } else {
      const index = docIndex(s, o.at, w);
      if (index === null) sequential.push({ insertInlineImage: { uri: o.url, endOfSegmentLocation: {} } });
      else located.push({ index, order: i, insert: true, reqs: [{ insertInlineImage: { uri: o.url, location: { index } } }] });
    }
  });
  // Located operations run first, from the END of the document backwards:
  // none shifts the place of the next. At one same place a style goes before
  // any insert (its range is the text that is there NOW — an insert made first
  // would take it), and of two inserts the later-listed goes first.
  located.sort((a, b) => b.index - a.index || Number(a.insert) - Number(b.insert) || b.order - a.order);
  return [...located.flatMap((l) => l.reqs), ...sequential];
}

/** What a Slides batch creates, by id — reported to the agent, so a later
 *  edit can target a copy's elements. */
export type SlidesCreated =
  | { op: "add_slide"; slideId: string; titleId?: string; bodyId?: string }
  | { op: "duplicate_slide"; from: string; slideId: string; elements: { id: string; from: string; type: string }[] };

/** The id the server gives a copied element nobody named: stable for one
 *  source element, so a card refreshed against a changed deck keeps it. */
export const copyElementId = (newSlideId: string, sourceId: string): string => `${newSlideId}_${createHash("sha256").update(sourceId).digest("hex").slice(0, 8)}`;

/** A deck layout named by id or by name; a name two layouts share is refused. */
function findLayout(s: SlidesState, o: EditOp, w: string): SlidesState["layouts"][number] {
  if (o.layoutId !== undefined) {
    return s.layouts.find((l) => l.id === o.layoutId) ?? bad(`${w}: there is no layout '${String(o.layoutId).slice(0, 60)}' in this deck (\`slides read\` lists them).`);
  }
  const want = String(o.layoutName);
  let hits = s.layouts.filter((l) => l.name === want);
  if (!hits.length) hits = s.layouts.filter((l) => l.name.toLowerCase() === want.toLowerCase());
  if (hits.length > 1) return bad(`${w}: several layouts of this deck have that name — give its 'layoutId' instead (see \`slides read\`).`);
  return hits[0] ?? bad(`${w}: this deck has no layout with that name (\`slides read\` lists them; the standard ones are ${SLIDE_LAYOUTS.join(", ")}).`);
}

function slidesPlan(ops: readonly EditOp[], s: SlidesState): { requests: J[]; created: SlidesCreated[] } {
  type El = SlidesState["slides"][number]["elements"][number];
  const original = new Set(s.slides.map((x) => x.id));
  /** The deck's order as the batch leaves it, step by step. */
  const current = s.slides.map((x) => x.id);
  /** Each slide's elements — the deck's, then what this batch creates. */
  const onSlide = new Map<string, El[]>(s.slides.map((x) => [x.id, x.elements.map((e) => ({ ...e }))]));
  const elements = new Map<string, El>([...onSlide.values()].flat().map((e) => [e.id, e] as const));
  /** Every id a new object must not take. */
  const taken = new Set<string>([...current, ...elements.keys(), ...s.layouts.flatMap((l) => [l.id, ...l.placeholders.map((p) => p.id)])]);
  const out: J[] = [];
  const created: SlidesCreated[] = [];
  ops.forEach((o, i) => {
    const w = `operation ${i + 1}`;
    const needSlide = (id: unknown) => (onSlide.has(String(id)) ? String(id) : bad(`${w}: there is no slide '${String(id).slice(0, 60)}' in the deck as it is now (see \`slides read\`).`));
    const claim = (id: string) => {
      if (taken.has(id)) bad(`${w}: the new id '${id.slice(0, 60)}' is already used in this deck or this edit — pick another.`);
      taken.add(id);
    };
    if (o.op === "replace_text") out.push({ replaceAllText: { containsText: { text: o.find, matchCase: o.matchCase !== false }, replaceText: o.replace } });
    else if (o.op === "add_slide") {
      let ref: J;
      let maps: J[];
      if (o.layout !== undefined) {
        const title = o.layout === "TITLE" ? "CENTERED_TITLE" : "TITLE";
        const body = o.layout === "TITLE" ? "SUBTITLE" : "BODY";
        ref = { predefinedLayout: o.layout };
        maps = [...(o.titleId ? [{ layoutPlaceholder: { type: title, index: 0 }, objectId: o.titleId }] : []), ...(o.bodyId ? [{ layoutPlaceholder: { type: body, index: 0 }, objectId: o.bodyId }] : [])];
      } else {
        // A deck's own layout: its title and body are found among ITS
        // placeholders, by id — a custom layout's need not be the standard types.
        const l = findLayout(s, o, w);
        const pick = (types: string[], what: string) => [...l.placeholders].filter((p) => types.includes(p.type)).sort((a, b) => types.indexOf(a.type) - types.indexOf(b.type) || a.index - b.index)[0] ?? bad(`${w}: the layout '${l.name.slice(0, 60) || l.id}' has no ${what} placeholder — add the slide without a ${what}, or pick another layout.`);
        ref = { layoutId: l.id };
        maps = [...(o.titleId ? [{ layoutPlaceholderObjectId: pick(["TITLE", "CENTERED_TITLE"], "title").id, objectId: o.titleId }] : []), ...(o.bodyId ? [{ layoutPlaceholderObjectId: pick(["BODY", "SUBTITLE"], "body").id, objectId: o.bodyId }] : [])];
      }
      for (const id of [o.slideId, o.titleId, o.bodyId]) if (id) claim(String(id));
      out.push({ createSlide: { objectId: o.slideId, ...(o.at !== undefined ? { insertionIndex: o.at } : {}), slideLayoutReference: ref, ...(maps.length ? { placeholderIdMappings: maps } : {}) } });
      if (o.titleId) out.push({ insertText: { objectId: o.titleId, text: o.title, insertionIndex: 0 } });
      if (o.bodyId) out.push({ insertText: { objectId: o.bodyId, text: o.body, insertionIndex: 0 } });
      const els: El[] = [...(o.titleId ? [{ id: String(o.titleId), type: "placeholder TITLE", text: String(o.title) }] : []), ...(o.bodyId ? [{ id: String(o.bodyId), type: "placeholder BODY", text: String(o.body) }] : [])];
      onSlide.set(String(o.slideId), els);
      for (const e of els) elements.set(e.id, e);
      current.splice(o.at === undefined ? current.length : Math.min(o.at as number, current.length), 0, String(o.slideId));
      created.push({ op: "add_slide", slideId: String(o.slideId), ...(o.titleId ? { titleId: String(o.titleId) } : {}), ...(o.bodyId ? { bodyId: String(o.bodyId) } : {}) });
    } else if (o.op === "duplicate_slide") {
      const src = needSlide(o.slideId);
      const srcEls = onSlide.get(src) ?? [];
      const named = (o.objectIds ?? {}) as Record<string, string>;
      const stray = Object.keys(named).find((k) => !srcEls.some((e) => e.id === k));
      if (stray) return bad(`${w}: 'objectIds' names '${stray.slice(0, 60)}', which is not an element of slide '${src.slice(0, 60)}'.`);
      const newSlide = String(o.newSlideId);
      claim(newSlide);
      const copies = srcEls.map((e) => ({ ...e, from: e.id, id: named[e.id] ?? copyElementId(newSlide, e.id) }));
      for (const c of copies) claim(c.id);
      out.push({ duplicateObject: { objectId: src, objectIds: Object.fromEntries([[src, newSlide], ...copies.map((c) => [c.from, c.id])]) } });
      // Google puts the copy right after its source; \`at\` is where it ENDS.
      const c = current.indexOf(src) + 1;
      current.splice(c, 0, newSlide);
      if (o.at !== undefined) {
        const p = o.at as number;
        if (p > current.length - 1) return bad(`${w}: 'at' is past the end — the deck will have ${current.length} slides, so 'at' goes from 0 to ${current.length - 1}.`);
        // Slides counts the place in the order BEFORE the move.
        if (p !== c) out.push({ updateSlidesPosition: { slideObjectIds: [newSlide], insertionIndex: p < c ? p : p + 1 } });
        current.splice(c, 1);
        current.splice(p, 0, newSlide);
      }
      const els = copies.map(({ from: _f, ...e }) => e);
      onSlide.set(newSlide, els);
      for (const e of els) elements.set(e.id, e);
      created.push({ op: "duplicate_slide", from: src, slideId: newSlide, elements: copies.map((x) => ({ id: x.id, from: x.from, type: x.type })) });
    } else if (o.op === "delete_slide") {
      const id = needSlide(o.slideId);
      out.push({ deleteObject: { objectId: id } });
      for (const e of onSlide.get(id) ?? []) elements.delete(e.id);
      onSlide.delete(id);
      current.splice(current.indexOf(id), 1);
    } else if (o.op === "insert_text" || o.op === "delete_text") {
      const e = elements.get(String(o.objectId));
      if (!e) return bad(`${w}: there is no element '${String(o.objectId).slice(0, 60)}' in the deck as it is now (see \`slides read\`).`);
      if (o.op === "delete_text") {
        if (!e.text) return bad(`${w}: element '${e.id}' has no text to delete.`);
        out.push({ deleteText: { objectId: e.id, textRange: { type: "ALL" } } });
        e.text = "";
      } else {
        // A shape's text ends with a newline that is not ours to write after.
        const end = Math.max(0, e.text.length - (e.text.endsWith("\n") ? 1 : 0));
        if (o.at !== undefined && (o.at as number) > end) return bad(`${w}: element '${e.id}' holds ${end} characters — 'at' is past its end.`);
        out.push({ insertText: { objectId: e.id, text: o.text, insertionIndex: o.at ?? end } });
        e.text = `${e.text.slice(0, (o.at as number) ?? end)}${o.text}${e.text.slice((o.at as number) ?? end)}`;
      }
    } else if (o.op === "insert_image") {
      const pt = (v: unknown) => ({ magnitude: v, unit: "PT" });
      out.push({
        createImage: {
          url: o.url,
          elementProperties: {
            pageObjectId: needSlide(o.slideId),
            ...(o.w !== undefined ? { size: { width: pt(o.w), height: pt(o.h) } } : {}),
            ...(o.x !== undefined || o.y !== undefined ? { transform: { scaleX: 1, scaleY: 1, translateX: o.x ?? 0, translateY: o.y ?? 0, unit: "PT" } } : {}),
          },
        },
      });
    } else {
      const ids = (o.slideIds as string[]).map(needSlide);
      if (ids.some((id) => !original.has(id))) return bad(`${w}: a slide added or duplicated by this same edit cannot be reordered — give add_slide or duplicate_slide its 'at' instead.`);
      // Slides wants them in the deck's own order; the moved slides land, in
      // that order, just before the first unmoved slide at or after \`at\`.
      const sorted = [...ids].sort((a, b) => current.indexOf(a) - current.indexOf(b));
      out.push({ updateSlidesPosition: { slideObjectIds: sorted, insertionIndex: o.at } });
      const anchor = current.slice(o.at as number).find((id) => !ids.includes(id));
      const rest = current.filter((id) => !ids.includes(id));
      rest.splice(anchor === undefined ? rest.length : rest.indexOf(anchor), 0, ...sorted);
      current.splice(0, current.length, ...rest);
    }
  });
  return { requests: out, created };
}

function sheetRequests(ops: readonly EditOp[], s: SheetState): J[] {
  // The tabs as the batch leaves them, step by step: an operation may name a
  // tab an earlier one added or renamed.
  const tabs = s.tabs.map((t) => ({ ...t }));
  const out: J[] = [];
  ops.forEach((o, i) => {
    const w = `operation ${i + 1}`;
    const tabId = (name: string | undefined) => {
      const t = name === undefined ? tabs[0] : tabs.find((x) => x.title === name);
      return t ? t.id : bad(`${w}: there is no tab with that name in the spreadsheet as it is now.`);
    };
    const grid = (range: unknown) => {
      const a = parseA1(String(range), w);
      return { sheetId: tabId(a.tab), ...(a.r0 !== undefined ? { startRowIndex: a.r0 } : {}), ...(a.r1 !== undefined ? { endRowIndex: a.r1 } : {}), ...(a.c0 !== undefined ? { startColumnIndex: a.c0 } : {}), ...(a.c1 !== undefined ? { endColumnIndex: a.c1 } : {}) };
    };
    if (o.op === "update") {
      const a = parseA1(String(o.range), w);
      const value = (c: Cell) => (typeof c === "number" ? { numberValue: c } : typeof c === "boolean" ? { boolValue: c } : c.startsWith("=") ? { formulaValue: c } : { stringValue: c });
      out.push({ updateCells: { start: { sheetId: tabId(a.tab), rowIndex: a.r0 ?? 0, columnIndex: a.c0 ?? 0 }, rows: (o.values as Cell[][]).map((r) => ({ values: r.map((c) => ({ userEnteredValue: value(c) })) })), fields: "userEnteredValue" } });
    } else if (o.op === "clear") out.push({ updateCells: { range: grid(o.range), fields: "userEnteredValue" } });
    else if (o.op === "add_tab") {
      if (tabs.some((t) => t.title === o.title)) return bad(`${w}: there is already a tab with that name.`);
      out.push({ addSheet: { properties: { sheetId: o.sheetId, title: o.title } } });
      tabs.push({ id: Number(o.sheetId), title: String(o.title) });
    } else if (o.op === "delete_tab") {
      const id = tabId(String(o.title));
      if (tabs.length === 1) return bad(`${w}: a spreadsheet keeps at least one tab.`);
      out.push({ deleteSheet: { sheetId: id } });
      tabs.splice(tabs.findIndex((t) => t.id === id), 1);
    } else if (o.op === "rename_tab") {
      const id = tabId(String(o.from));
      if (tabs.some((t) => t.title === o.to)) return bad(`${w}: there is already a tab with that name.`);
      out.push({ updateSheetProperties: { properties: { sheetId: id, title: o.to }, fields: "title" } });
      tabs.find((t) => t.id === id)!.title = String(o.to);
    } else if (o.op === "format") {
      const format: J = {};
      const fields: string[] = [];
      if (o.bold !== undefined || o.italic !== undefined) {
        format.textFormat = { ...(o.bold !== undefined ? { bold: o.bold } : {}), ...(o.italic !== undefined ? { italic: o.italic } : {}) };
        if (o.bold !== undefined) fields.push("userEnteredFormat.textFormat.bold");
        if (o.italic !== undefined) fields.push("userEnteredFormat.textFormat.italic");
      }
      if (o.background) {
        const n = parseInt(String(o.background).slice(1), 16);
        format.backgroundColor = { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
        fields.push("userEnteredFormat.backgroundColor");
      }
      if (o.numberFormat !== undefined) {
        const p = String(o.numberFormat);
        format.numberFormat = { type: /[ymdhs]/i.test(p) && !/[0#]/.test(p) ? "DATE_TIME" : "NUMBER", pattern: p };
        fields.push("userEnteredFormat.numberFormat");
      }
      out.push({ repeatCell: { range: grid(o.range), cell: { userEnteredFormat: format }, fields: fields.join(",") } });
    } else {
      const rows = o.op.endsWith("rows");
      const start = Number(o.start) - 1;
      const range = { sheetId: tabId(o.tab as string | undefined), dimension: rows ? "ROWS" : "COLUMNS", startIndex: start, endIndex: start + Number(o.count) };
      out.push(o.op.startsWith("insert") ? { insertDimension: { range, inheritFromBefore: start > 0 } } : { deleteDimension: { range } });
    }
  });
  return out;
}

/** The API requests for this batch, against the file AS IT IS (`state`).
 *  Throws `GoogleInputError` when an operation's target is not there. */
export function buildEditRequests(app: EditApp, ops: readonly EditOp[], state: EditState): Record<string, unknown>[] {
  return editPlan(app, ops, state).requests;
}

/** The requests, and what they create (Slides only: the new slides, a copy's
 *  element ids) — the same walk, so the ids reported are the ids sent. */
export function editPlan(app: EditApp, ops: readonly EditOp[], state: EditState): { requests: Record<string, unknown>[]; created: SlidesCreated[] } {
  if (state.app !== app) return bad("That file is not of the kind this edit is for.");
  if (state.app === "slides") return slidesPlan(ops, state);
  return { requests: state.app === "doc" ? docRequests(ops, state) : sheetRequests(ops, state), created: [] };
}

/**
 * Google's refusal of a standard layout, in words an agent can act on. A deck
 * built on custom layouts only has none of BLANK / TITLE_AND_BODY / …, and the
 * raw 400 ("The predefined layout (X) is not present in the current master")
 * names neither way out. Anything else comes back unchanged.
 */
export function translateEditError(e: unknown): unknown {
  if (!(e instanceof GoogleError) || e.status !== 400) return e;
  const m = /predefined layout \(([A-Z_]+)\) is not present in the current master/i.exec(e.message);
  if (!m) return e;
  return new GoogleError(`This deck has no standard layout '${m[1]}'; use duplicate_slide, or add_slide with a layoutId from \`slides read\` (it lists the deck's own layouts).`, 400, false);
}

const excerpt = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
};

/** The same ops with a `note` saying what each one's target IS in the file
 *  right now — an id means nothing to the person approving. */
export function annotateOps(app: EditApp, ops: readonly EditOp[], state: EditState): EditOp[] {
  if (state.app !== "slides" || app !== "slides") return ops.map(({ note: _n, ...o }) => o as EditOp);
  const slideNote = (id: unknown) => {
    const i = state.slides.findIndex((x) => x.id === id);
    if (i < 0) return "";
    const title = state.slides[i].elements.find((e) => e.text.trim())?.text ?? "";
    return `slide ${i + 1}${title.trim() ? `: ${JSON.stringify(excerpt(title))}` : ""}`;
  };
  // An element a duplicate_slide of this batch names in advance: said as the
  // copy of what it copies, since it does not exist yet.
  const copied = new Map<string, string>(ops.flatMap((o) => (o.op === "duplicate_slide" && o.objectIds ? Object.entries(o.objectIds as Record<string, string>).map(([from, to]) => [to, from] as [string, string]) : [])));
  const elementNote = (id: unknown): string => {
    for (const [i, sl] of state.slides.entries()) {
      const e = sl.elements.find((x) => x.id === id);
      if (e) return `${e.type} on slide ${i + 1}${e.text.trim() ? `, now ${JSON.stringify(excerpt(e.text))}` : ", now empty"}`;
    }
    const from = copied.get(String(id));
    const of = from ? elementNote(from) : "";
    return of ? `the copy of the ${of}` : "";
  };
  return ops.map(({ note: _n, ...o }) => {
    const layoutNote = () => {
      const l = state.layouts.find((x) => x.id === o.layoutId);
      return l?.name ? `layout ${JSON.stringify(excerpt(l.name))}` : "";
    };
    const note = o.op === "delete_slide" || o.op === "insert_image" || o.op === "duplicate_slide" ? slideNote(o.slideId) : o.op === "add_slide" && o.layoutId !== undefined ? layoutNote() : o.op === "insert_text" || o.op === "delete_text" ? elementNote(o.objectId) : o.op === "reorder" ? (o.slideIds as string[]).map(slideNote).filter(Boolean).join("; ") : "";
    return (note ? { ...o, note } : o) as EditOp;
  });
}

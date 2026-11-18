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
/** One of a closed list of words, or absent. */
function oneOf<T extends string>(o: Raw, key: string, w: string, list: readonly T[]): T | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !(list as readonly string[]).includes(v)) return bad(`${w}: '${key}' must be one of ${list.join(", ")}.`);
  return v as T;
}
/** A colour, always `#rrggbb` — stored lower-case, so the card and the request agree. */
function colour(o: Raw, key: string, w: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) return bad(`${w}: '${key}' must be a colour like #ffcc00.`);
  return v.toLowerCase();
}
/** `#rrggbb` → the 0–1 channels every Google API takes. */
export function rgb(hex: unknown): { red: number; green: number; blue: number } {
  const n = parseInt(String(hex).slice(1), 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}
/** A font by its plain name ("Roboto Mono"): letters, digits, spaces and
 *  hyphens — never a CSS stack or anything that could carry markup. */
function fontName(o: Raw, key: string, w: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 -]{0,59}$/.test(v) || / {2}|\s$/.test(v)) return bad(`${w}: '${key}' must be a plain font name like Arial or Roboto Mono.`);
  return v;
}
function points(o: Raw, key: string, w: string, min: number, max: number, whole = false): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (whole && !Number.isInteger(v))) return bad(`${w}: '${key}' must be ${whole ? "a whole number" : "a number"} from ${min} to ${max}.`);
  return v;
}
/** A link put INTO a document (nobody fetches it): http(s) or mailto, nothing else. */
export function linkVerdict(v: unknown, w: string): string {
  if (typeof v !== "string" || !v || v.length > 2000 || CONTROL.test(v) || /\s/.test(v)) return bad(`${w}: 'link' must be an address of at most 2000 characters, or false to remove a link.`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return bad(`${w}: 'link' is not a valid address.`);
  }
  if (!["https:", "http:", "mailto:"].includes(u.protocol)) return bad(`${w}: a link must be an https, http or mailto address.`);
  return u.toString();
}

/** The character style shared by Docs and Slides: what a person sees on a card as words. */
const TEXT_STYLE_KEYS = ["bold", "italic", "underline", "strikethrough", "font", "size", "color", "link"] as const;
function textStyleFields(o: Raw, w: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["bold", "italic", "underline", "strikethrough"]) {
    const f = flag(o, k, w);
    if (f !== undefined) out[k] = f;
  }
  const font = fontName(o, "font", w);
  if (font !== undefined) out.font = font;
  const size = points(o, "size", w, 1, 400);
  if (size !== undefined) out.size = size;
  const color = colour(o, "color", w);
  if (color !== undefined) out.color = color;
  if (o.link !== undefined && o.link !== null) out.link = o.link === false ? false : linkVerdict(o.link, w);
  return out;
}
const hasTextStyle = (o: Raw) => TEXT_STYLE_KEYS.some((k) => o[k] !== undefined);
const ALIGNS = ["left", "center", "right", "justified"] as const;
const ALIGN_API: Record<string, string> = { left: "START", center: "CENTER", right: "END", justified: "JUSTIFIED" };
/** A list of 1 to 50 slide ids, none twice. */
function slideIdList(o: Raw, key: string, w: string): string[] {
  const v = o[key];
  if (!Array.isArray(v) || !v.length || v.length > 50) return bad(`${w}: '${key}' must list 1 to 50 slide ids.`);
  const ids = v.map((x, i) => objectId({ v: x }, "v", `${w} ${key}[${i}]`));
  if (new Set(ids).size !== ids.length) return bad(`${w}: '${key}' names a slide twice.`);
  return ids;
}
/** A box in points: x and y from 0, w and h — given together — from 1. */
function box(o: Raw, w: string, required: boolean): Record<string, number> {
  const b: Record<string, number> = {};
  for (const k of ["x", "y", "w", "h"]) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "number" || !Number.isFinite(o[k]) || (o[k] as number) < 0 || (o[k] as number) > 5000) return bad(`${w}: '${k}' must be a number of points from 0 to 5000.`);
    b[k] = o[k] as number;
  }
  if (required && (b.w === undefined || b.h === undefined || b.x === undefined || b.y === undefined)) return bad(`${w}: give 'x', 'y', 'w' and 'h' in points.`);
  if ((b.w === undefined) !== (b.h === undefined)) return bad(`${w}: give both 'w' and 'h', or neither.`);
  if (b.w === 0 || b.h === 0) return bad(`${w}: 'w' and 'h' must be more than 0.`);
  return b;
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

/** A new table's cells: rows of one-line text that fit it. */
function tableCells(v: unknown, rows: number, cols: number, w: string): string[][] {
  if (!Array.isArray(v) || v.length > rows || !v.every((r) => Array.isArray(r) && r.length <= cols && r.every((c) => typeof c === "string" && c.length <= 2000 && !CONTROL.test(c) && !/[\r\n]/.test(c))))
    return bad(`${w}: 'cells' must be rows of one-line text that fit the ${rows}×${cols} table.`);
  return (v as string[][]).map((r) => [...r]);
}

function replaceOp(o: Raw, w: string, slides = false): EditOp {
  onlyKeys(o, w, slides ? ["find", "replace", "matchCase", "slideIds"] : ["find", "replace", "matchCase"]);
  const r: EditOp = { op: "replace_text", find: text(o, "find", w, { max: MAX_FIND }), replace: text(o, "replace", w, { empty: true }), matchCase: flag(o, "matchCase", w) ?? true };
  if (slides && o.slideIds !== undefined) r.slideIds = slideIdList(o, "slideIds", w);
  return r;
}

const SHAPE_KINDS = ["text_box", "rectangle", "round_rectangle", "ellipse", "triangle", "right_arrow", "left_arrow", "up_arrow", "down_arrow", "chevron", "star_5", "cloud"] as const;
const SLIDES_LISTS = ["bullet", "numbered", "none"] as const;

function slidesOp(o: Raw, w: string, newId: () => string): EditOp {
  switch (o.op) {
    case "replace_text":
      return replaceOp(o, w, true);
    case "style_text": {
      // Character and paragraph style on ONE element (all its text) or on
      // every occurrence of a text — the occurrences are found in the deck as
      // the batch leaves it, so text inserted earlier in the same edit counts.
      onlyKeys(o, w, ["objectId", "find", "matchCase", "slideIds", ...TEXT_STYLE_KEYS, "list", "align"]);
      if ((o.objectId === undefined) === (o.find === undefined)) return bad(`${w}: give 'objectId' (style all of an element's text) or 'find' (style every occurrence of a text), not both.`);
      if (o.objectId !== undefined && (o.slideIds !== undefined || o.matchCase !== undefined)) return bad(`${w}: 'slideIds' and 'matchCase' go with 'find'.`);
      const style = textStyleFields(o, w);
      const list = oneOf(o, "list", w, SLIDES_LISTS);
      const align = oneOf(o, "align", w, ALIGNS);
      if (!Object.keys(style).length && list === undefined && align === undefined) return bad(`${w}: give at least one of ${TEXT_STYLE_KEYS.join(", ")}, list, align.`);
      const target = o.objectId !== undefined ? { objectId: objectId(o, "objectId", w) } : { find: text(o, "find", w, { max: MAX_FIND }), matchCase: flag(o, "matchCase", w) ?? true, ...(o.slideIds !== undefined ? { slideIds: slideIdList(o, "slideIds", w) } : {}) };
      return { op: "style_text", ...target, ...style, ...(list !== undefined ? { list } : {}), ...(align !== undefined ? { align } : {}) };
    }
    case "set_notes":
      onlyKeys(o, w, ["slideId", "text"]);
      return { op: "set_notes", slideId: objectId(o, "slideId", w), text: text(o, "text", w, { empty: true }) };
    case "add_shape": {
      onlyKeys(o, w, ["slideId", "kind", "x", "y", "w", "h", "text", "fill"]);
      const kind = oneOf(o, "kind", w, SHAPE_KINDS) ?? "text_box";
      const fill = colour(o, "fill", w);
      return { op: "add_shape", slideId: objectId(o, "slideId", w), kind, ...box(o, w, true), objectId: newId(), ...(o.text !== undefined ? { text: text(o, "text", w) } : {}), ...(fill !== undefined ? { fill } : {}) };
    }
    case "move": {
      onlyKeys(o, w, ["objectId", "x", "y", "w", "h"]);
      const b: Record<string, number> = {};
      for (const k of ["x", "y", "w", "h"]) {
        if (o[k] === undefined) continue;
        if (typeof o[k] !== "number" || !Number.isFinite(o[k]) || (o[k] as number) < (k === "w" || k === "h" ? 1 : 0) || (o[k] as number) > 5000) return bad(`${w}: '${k}' must be a number of points from ${k === "w" || k === "h" ? 1 : 0} to 5000.`);
        b[k] = o[k] as number;
      }
      if (!Object.keys(b).length) return bad(`${w}: give at least one of x, y (where it goes) or w, h (its new size), in points.`);
      return { op: "move", objectId: objectId(o, "objectId", w), ...b };
    }
    case "delete_element":
      onlyKeys(o, w, ["objectId"]);
      return { op: "delete_element", objectId: objectId(o, "objectId", w) };
    case "add_table": {
      onlyKeys(o, w, ["slideId", "rows", "cols", "x", "y", "w", "h", "cells"]);
      const rows = int(o, "rows", w, 1, 20);
      const cols = int(o, "cols", w, 1, 10);
      const cells = o.cells === undefined ? undefined : tableCells(o.cells, rows, cols, w);
      return { op: "add_table", slideId: objectId(o, "slideId", w), rows, cols, ...box(o, w, false), objectId: newId(), ...(cells ? { cells } : {}) };
    }
    case "table_cell":
      onlyKeys(o, w, ["objectId", "row", "col", "text"]);
      return { op: "table_cell", objectId: objectId(o, "objectId", w), row: int(o, "row", w, 1, 1000), col: int(o, "col", w, 1, 50), text: text(o, "text", w, { empty: true, max: 2000 }) };
    case "replace_image":
      onlyKeys(o, w, ["objectId", "url", "crop"]);
      return { op: "replace_image", objectId: objectId(o, "objectId", w), url: imageUrlVerdict(o.url, w), crop: flag(o, "crop", w) ?? false };
    case "replace_shapes_with_image":
      onlyKeys(o, w, ["find", "url", "matchCase", "crop", "slideIds"]);
      return { op: "replace_shapes_with_image", find: text(o, "find", w, { max: MAX_FIND }), url: imageUrlVerdict(o.url, w), matchCase: flag(o, "matchCase", w) ?? true, crop: flag(o, "crop", w) ?? false, ...(o.slideIds !== undefined ? { slideIds: slideIdList(o, "slideIds", w) } : {}) };
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
      return bad(`${w}: unknown Slides operation '${String(o.op).slice(0, 40)}' (replace_text, add_slide, duplicate_slide, delete_slide, insert_text, delete_text, insert_image, reorder, style_text, set_notes, add_shape, move, delete_element, add_table, table_cell, replace_image, replace_shapes_with_image).`);
  }
}

type DocAt = "start" | "end" | { after: string } | { afterText: string };
function docAt(o: Raw, w: string): DocAt {
  const v = o.at;
  if (v === undefined || v === null || v === "end") return "end";
  if (v === "start") return "start";
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1) {
    const r = v as Raw;
    if (typeof r.after === "string") return { after: text(r, "after", w, { max: 300, oneLine: true }).trim() || bad(`${w}: 'at.after' is empty.`) };
    if (typeof r.afterText === "string") return { afterText: text(r, "afterText", w, { max: 300, oneLine: true }).trim() || bad(`${w}: 'at.afterText' is empty.`) };
  }
  return bad(`${w}: 'at' must be "start", "end", {"after": "<a heading's or a paragraph's whole text>"} or {"afterText": "<words of one paragraph>"}.`);
}

const DOC_LISTS = ["bullet", "numbered", "checkbox", "none"] as const;
/** Which table, row, column of a Doc: counted from 1, tables in document order (\`doc read\` lists them). */
const tableRef = (o: Raw, w: string) => ({ table: int(o, "table", w, 1, 100), row: int(o, "row", w, 1, 1000) });

function docOp(o: Raw, w: string): EditOp {
  switch (o.op) {
    case "replace_text":
      return replaceOp(o, w);
    case "delete_text":
      onlyKeys(o, w, ["find", "matchCase"]);
      return { op: "delete_text", find: text(o, "find", w, { max: MAX_FIND }), matchCase: flag(o, "matchCase", w) ?? true };
    case "insert_text":
      // A style given HERE applies to exactly the inserted text — the way to
      // insert a link, or bold words, in the same edit (a separate \`style\`
      // only sees the document as it was before the edit).
      onlyKeys(o, w, ["text", "at", ...TEXT_STYLE_KEYS]);
      return { op: "insert_text", text: text(o, "text", w), at: docAt(o, w), ...textStyleFields(o, w) };
    case "style": {
      onlyKeys(o, w, ["find", "heading", "bullet", "list", "align", ...TEXT_STYLE_KEYS]);
      const heading = o.heading;
      if (heading !== undefined && (typeof heading !== "string" || !(HEADINGS as readonly string[]).includes(heading))) return bad(`${w}: 'heading' must be one of ${HEADINGS.join(", ")}.`);
      const bullet = flag(o, "bullet", w);
      if (bullet === false) return bad(`${w}: 'bullet' can only be true (or use "list": "none" to remove a list).`);
      const list = oneOf(o, "list", w, DOC_LISTS);
      if (bullet && list !== undefined) return bad(`${w}: give 'list' or 'bullet', not both.`);
      const align = oneOf(o, "align", w, ALIGNS);
      const style = textStyleFields(o, w);
      if (heading === undefined && !bullet && list === undefined && align === undefined && !Object.keys(style).length) return bad(`${w}: give at least one of heading, ${TEXT_STYLE_KEYS.join(", ")}, list, align.`);
      return { op: "style", find: text(o, "find", w, { max: MAX_FIND }), ...(heading !== undefined ? { heading } : {}), ...style, ...(bullet ? { bullet: true } : {}), ...(list !== undefined ? { list } : {}), ...(align !== undefined ? { align } : {}) };
    }
    case "page_break":
      onlyKeys(o, w, ["at"]);
      return { op: "page_break", at: docAt(o, w) };
    case "table_cell":
      onlyKeys(o, w, ["table", "row", "col", "text"]);
      return { op: "table_cell", ...tableRef(o, w), col: int(o, "col", w, 1, 50), text: text(o, "text", w, { empty: true, max: 2000 }) };
    case "insert_table_row": {
      onlyKeys(o, w, ["table", "row", "below"]);
      return { op: "insert_table_row", ...tableRef(o, w), below: flag(o, "below", w) ?? true };
    }
    case "delete_table_row":
      onlyKeys(o, w, ["table", "row"]);
      return { op: "delete_table_row", ...tableRef(o, w) };
    case "insert_table": {
      onlyKeys(o, w, ["rows", "cols", "at", "cells"]);
      const rows = int(o, "rows", w, 1, 20);
      const cols = int(o, "cols", w, 1, 10);
      let cells: string[][] | undefined;
      if (o.cells !== undefined) {
        cells = tableCells(o.cells, rows, cols, w);
      }
      return { op: "insert_table", rows, cols, at: docAt(o, w), ...(cells ? { cells } : {}) };
    }
    case "insert_image":
      onlyKeys(o, w, ["url", "at"]);
      return { op: "insert_image", url: imageUrlVerdict(o.url, w), at: docAt(o, w) };
    default:
      return bad(`${w}: unknown Docs operation '${String(o.op).slice(0, 40)}' (replace_text, insert_text, delete_text, style, insert_table, insert_image, page_break, table_cell, insert_table_row, delete_table_row).`);
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
    case "duplicate_tab": {
      // A copy keeps what add_tab cannot rebuild: formats, formulas, column
      // widths, conditional formatting. Its name is decided HERE (Google's
      // default would be localised), so the card shows it and a later
      // operation of the batch can name the copy.
      onlyKeys(o, w, ["tab", "title", "at"]);
      const tab = tabName(o, "tab", w);
      const title = o.title === undefined ? `Copy of ${tab}`.slice(0, 100) : tabName(o, "title", w);
      return { op: "duplicate_tab", tab, title, sheetId: 1 + (randomBytes(4).readUInt32BE(0) % 2_000_000_000), ...(o.at !== undefined ? { at: int(o, "at", w, 0, 1000) } : {}) };
    }
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
      onlyKeys(o, w, ["range", "bold", "italic", "underline", "strikethrough", "background", "color", "font", "size", "align", "valign", "wrap", "numberFormat"]);
      const f: Record<string, unknown> = {};
      for (const k of ["bold", "italic", "underline", "strikethrough"]) {
        const v = flag(o, k, w);
        if (v !== undefined) f[k] = v;
      }
      for (const k of ["background", "color"]) {
        const v = colour(o, k, w);
        if (v !== undefined) f[k] = v;
      }
      const font = fontName(o, "font", w);
      if (font !== undefined) f.font = font;
      // Sheets takes a whole number of points.
      const size = points(o, "size", w, 1, 400, true);
      if (size !== undefined) f.size = size;
      const align = oneOf(o, "align", w, ["left", "center", "right"] as const);
      if (align !== undefined) f.align = align;
      const valign = oneOf(o, "valign", w, ["top", "middle", "bottom"] as const);
      if (valign !== undefined) f.valign = valign;
      const wrap = flag(o, "wrap", w);
      if (wrap !== undefined) f.wrap = wrap;
      if (o.numberFormat !== undefined) f.numberFormat = text(o, "numberFormat", w, { max: 100, oneLine: true });
      if (!Object.keys(f).length) return bad(`${w}: give at least one of bold, italic, underline, strikethrough, background, color, font, size, align, valign, wrap, numberFormat.`);
      return { op: "format", range: a1(o, w), ...f };
    }
    case "sort": {
      onlyKeys(o, w, ["range", "by"]);
      const range = a1(o, w);
      if (!Array.isArray(o.by) || !o.by.length || o.by.length > 10) return bad(`${w}: 'by' must list 1 to 10 sort keys, e.g. [{"col": "B", "desc": true}].`);
      const by = (o.by as unknown[]).map((k, i) => {
        const kw = `${w} by[${i}]`;
        if (!k || typeof k !== "object" || Array.isArray(k)) return bad(`${kw}: must be {"col": "<letters>", "desc": true|false}.`);
        onlyKeys(k as Raw, kw, ["col", "desc"]);
        const col = (k as Raw).col;
        if (typeof col !== "string" || !/^[A-Za-z]{1,3}$/.test(col)) return bad(`${kw}: 'col' must be a column's letters, like B.`);
        return { col: col.toUpperCase(), desc: flag(k as Raw, "desc", kw) ?? false };
      });
      const a = parseA1(range, w);
      for (const k of by) {
        const c = colNumber(k.col) - 1;
        if ((a.c0 !== undefined && c < a.c0) || (a.c1 !== undefined && c >= a.c1)) return bad(`${w}: column ${k.col} is outside the range being sorted.`);
      }
      return { op: "sort", range, by };
    }
    case "filter":
      onlyKeys(o, w, ["range"]);
      return { op: "filter", range: a1(o, w) };
    case "clear_filter":
      onlyKeys(o, w, ["tab"]);
      return { op: "clear_filter", ...(o.tab !== undefined ? { tab: tabName(o, "tab", w) } : {}) };
    case "freeze": {
      onlyKeys(o, w, ["tab", "rows", "cols"]);
      if (o.rows === undefined && o.cols === undefined) return bad(`${w}: give 'rows' and/or 'cols' (0 unfreezes).`);
      return { op: "freeze", ...(o.tab !== undefined ? { tab: tabName(o, "tab", w) } : {}), ...(o.rows !== undefined ? { rows: int(o, "rows", w, 0, 1000) } : {}), ...(o.cols !== undefined ? { cols: int(o, "cols", w, 0, 100) } : {}) };
    }
    case "column_width":
    case "row_height": {
      const key = o.op === "column_width" ? "width" : "height";
      onlyKeys(o, w, ["tab", "start", "count", key]);
      const size = o[key] === "auto" ? "auto" : points(o, key, w, 2, 2000, true);
      if (size === undefined) return bad(`${w}: give '${key}': a whole number of pixels, or "auto" to fit the content.`);
      return { op: o.op, ...(o.tab !== undefined ? { tab: tabName(o, "tab", w) } : {}), start: int(o, "start", w, 1, 1_000_000), count: o.count === undefined ? 1 : int(o, "count", w, 1, 10_000), [key]: size };
    }
    case "borders": {
      onlyKeys(o, w, ["range", "style", "color", "sides"]);
      const style = oneOf(o, "style", w, BORDER_STYLES) ?? "solid";
      const color = colour(o, "color", w);
      if (style === "none" && color !== undefined) return bad(`${w}: a border removed has no colour.`);
      let sides: string[];
      if (o.sides === undefined || o.sides === "all") sides = [...BORDER_SIDES];
      else if (o.sides === "outer") sides = ["top", "bottom", "left", "right"];
      else if (o.sides === "inner") sides = ["inner_horizontal", "inner_vertical"];
      else if (Array.isArray(o.sides) && o.sides.length && o.sides.every((x) => typeof x === "string" && (BORDER_SIDES as readonly string[]).includes(x)) && new Set(o.sides).size === o.sides.length) sides = [...(o.sides as string[])];
      else return bad(`${w}: 'sides' must be "all", "outer", "inner" or a list of ${BORDER_SIDES.join(", ")}.`);
      return { op: "borders", range: a1(o, w), style, ...(style !== "none" ? { color: color ?? "#000000" } : {}), sides };
    }
    case "merge": {
      onlyKeys(o, w, ["range", "how"]);
      const range = a1(o, w);
      const a = parseA1(range, w);
      if (a.r0 === undefined || a.r1 === undefined || a.c0 === undefined || a.c1 === undefined) return bad(`${w}: merge a bounded range of cells, like B2:D2.`);
      return { op: "merge", range, how: oneOf(o, "how", w, ["all", "rows", "columns"] as const) ?? "all" };
    }
    case "unmerge":
      onlyKeys(o, w, ["range"]);
      return { op: "unmerge", range: a1(o, w) };
    case "find_replace": {
      onlyKeys(o, w, ["find", "replace", "tab", "range", "matchCase", "wholeCell", "formulas"]);
      if (o.tab !== undefined && o.range !== undefined) return bad(`${w}: give 'tab' or 'range', not both (neither: every tab).`);
      return {
        op: "find_replace", find: text(o, "find", w, { max: MAX_FIND }), replace: text(o, "replace", w, { empty: true, max: MAX_FIND }),
        ...(o.tab !== undefined ? { tab: tabName(o, "tab", w) } : {}), ...(o.range !== undefined ? { range: a1(o, w) } : {}),
        matchCase: flag(o, "matchCase", w) ?? true, wholeCell: flag(o, "wholeCell", w) ?? false, formulas: flag(o, "formulas", w) ?? false,
      };
    }
    case "copy": {
      onlyKeys(o, w, ["from", "to", "paste"]);
      const from = text(o, "from", w, { max: 200, oneLine: true });
      const to = text(o, "to", w, { max: 200, oneLine: true });
      parseA1(from, `${w} 'from'`);
      parseA1(to, `${w} 'to'`);
      return { op: "copy", from, to, paste: oneOf(o, "paste", w, ["all", "values", "formats", "formulas"] as const) ?? "all" };
    }
    case "conditional_format": {
      onlyKeys(o, w, ["range", "rule", "values", "background", "color", "bold", "italic"]);
      const rule = oneOf(o, "rule", w, Object.keys(CF_RULES)) ?? bad(`${w}: give a 'rule' (${Object.keys(CF_RULES).join(", ")}).`);
      const [, n, kind] = CF_RULES[rule];
      const vals = o.values === undefined ? [] : o.values;
      if (!Array.isArray(vals) || vals.length !== n) return bad(`${w}: the rule ${rule} takes ${n === 0 ? "no 'values'" : `'values' with exactly ${n} ${kind === "number" ? "number" : "text"}${n === 1 ? "" : "s"}`}.`);
      const values = vals.map((x, i) => {
        if (kind === "number") return typeof x === "number" && Number.isFinite(x) ? x : bad(`${w}: values[${i}] must be a number.`);
        const t = text({ x }, "x", `${w} values[${i}]`, { max: 500, oneLine: true });
        // A value starting with = is read as a formula by Sheets: refused, a simple rule stays simple.
        return t.startsWith("=") ? bad(`${w}: values[${i}] cannot start with '=' (it would be read as a formula).`) : t;
      });
      const fmt: Record<string, unknown> = {};
      for (const k of ["background", "color"]) {
        const v = colour(o, k, w);
        if (v !== undefined) fmt[k] = v;
      }
      for (const k of ["bold", "italic"]) {
        const v = flag(o, k, w);
        if (v !== undefined) fmt[k] = v;
      }
      if (!Object.keys(fmt).length) return bad(`${w}: give what matching cells look like: background, color, bold and/or italic.`);
      return { op: "conditional_format", range: a1(o, w), rule, ...(values.length ? { values } : {}), ...fmt };
    }
    case "validation": {
      onlyKeys(o, w, ["range", "list", "strict"]);
      if (!Array.isArray(o.list) || !o.list.length || o.list.length > 500) return bad(`${w}: 'list' must hold 1 to 500 choices.`);
      const list = (o.list as unknown[]).map((x, i) => {
        const t = text({ x }, "x", `${w} list[${i}]`, { max: 200, oneLine: true });
        return t.startsWith("=") ? bad(`${w}: list[${i}] cannot start with '=' (it would be read as a formula).`) : t;
      });
      return { op: "validation", range: a1(o, w), list, strict: flag(o, "strict", w) ?? true };
    }
    case "clear_validation":
      onlyKeys(o, w, ["range"]);
      return { op: "clear_validation", range: a1(o, w) };
    default:
      return bad(`${w}: unknown Sheets operation '${String(o.op).slice(0, 40)}' (update, clear, add_tab, duplicate_tab, delete_tab, rename_tab, insert_rows, delete_rows, insert_cols, delete_cols, format, sort, filter, clear_filter, freeze, column_width, row_height, borders, merge, unmerge, find_replace, copy, conditional_format, validation, clear_validation).`);
  }
}

const BORDER_STYLES = ["solid", "solid_medium", "solid_thick", "dashed", "dotted", "double", "none"] as const;
const BORDER_SIDES = ["top", "bottom", "left", "right", "inner_horizontal", "inner_vertical"] as const;
/** A simple conditional-format rule: Google's condition type, how many values, of what kind. */
const CF_RULES: Record<string, [string, number, "number" | "text"]> = {
  number_greater: ["NUMBER_GREATER", 1, "number"],
  number_greater_or_equal: ["NUMBER_GREATER_THAN_EQ", 1, "number"],
  number_less: ["NUMBER_LESS", 1, "number"],
  number_less_or_equal: ["NUMBER_LESS_THAN_EQ", 1, "number"],
  number_equal: ["NUMBER_EQ", 1, "number"],
  number_not_equal: ["NUMBER_NOT_EQ", 1, "number"],
  number_between: ["NUMBER_BETWEEN", 2, "number"],
  number_not_between: ["NUMBER_NOT_BETWEEN", 2, "number"],
  text_contains: ["TEXT_CONTAINS", 1, "text"],
  text_not_contains: ["TEXT_NOT_CONTAINS", 1, "text"],
  text_starts_with: ["TEXT_STARTS_WITH", 1, "text"],
  text_ends_with: ["TEXT_ENDS_WITH", 1, "text"],
  text_equal: ["TEXT_EQ", 1, "text"],
  blank: ["BLANK", 0, "text"],
  not_blank: ["NOT_BLANK", 0, "text"],
};

/** Operations that are LOCATED in a Doc as it is when the batch starts. */
const docPositional = (o: EditOp) =>
  o.op === "style" ||
  o.op === "table_cell" ||
  o.op === "insert_table_row" ||
  o.op === "delete_table_row" ||
  ((o.op === "insert_text" || o.op === "insert_table" || o.op === "insert_image" || o.op === "page_break") && o.at !== "end") ||
  (o.op === "insert_table" && Array.isArray(o.cells)) ||
  (o.op === "insert_text" && hasTextStyle(o));

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
    if (late >= 0) bad(`operation ${late + 1}: in one edit, style operations, table edits, inserts placed at the start or after a paragraph, a styled insert and a table with cells must come FIRST — before replace_text, delete_text and anything added at the end: they are located in the document as it is now. Reorder them, or send a second edit.`);
  }
  return ops;
}

// ---- one line per operation -------------------------------------------------

/** A text as it appears on a card line: quoted, and with every character that
 *  could start a new line or reorder the line shown as its escape. */
const q = (s: unknown) => JSON.stringify(String(s ?? "")).replace(/[\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const onTab = (range: unknown) => (String(range).includes("!") ? "" : " (first tab)");
const caseNote = (o: EditOp) => (o.matchCase === false ? " (any case)" : "");
const atWords = (at: unknown) => {
  if (at === "start") return "at the start";
  if (at === "end" || at === undefined) return "at the end";
  const a = at as { after?: string; afterText?: string };
  return a.afterText !== undefined ? `after the paragraph containing ${q(a.afterText)}` : `after the paragraph ${q(a.after)}`;
};
const noteOf = (o: EditOp) => (o.note ? ` — ${o.note}` : "");
/** A character style in words: what the card says the text will look like. */
const styleWords = (o: EditOp): string[] =>
  [
    o.bold !== undefined ? (o.bold ? "bold" : "not bold") : "",
    o.italic !== undefined ? (o.italic ? "italic" : "not italic") : "",
    o.underline !== undefined ? (o.underline ? "underlined" : "not underlined") : "",
    o.strikethrough !== undefined ? (o.strikethrough ? "struck through" : "not struck through") : "",
    o.font !== undefined ? `font ${q(o.font)}` : "",
    o.size !== undefined ? `${o.size} pt` : "",
    o.color !== undefined ? `text colour ${o.color}` : "",
    o.link === false ? "its link removed" : o.link !== undefined ? `a link to ${q(o.link)}` : "",
  ].filter(Boolean);
const LIST_WORDS: Record<string, string> = { bullet: "a bullet list", numbered: "a numbered list", checkbox: "a checklist", none: "no longer a list" };
const ALIGN_WORDS: Record<string, string> = { left: "aligned left", center: "centred", right: "aligned right", justified: "justified" };
const paraWords = (o: EditOp): string[] => [o.list !== undefined ? LIST_WORDS[String(o.list)] : o.bullet ? "a bullet list" : "", o.align !== undefined ? ALIGN_WORDS[String(o.align)] : ""].filter(Boolean);
const onSlides = (o: EditOp) => (Array.isArray(o.slideIds) ? ` on slide${o.slideIds.length === 1 ? "" : "s"} ${(o.slideIds as string[]).join(", ")}` : "");
const cellsWords = (cells: unknown) => (cells ? ` — cells: ${(cells as string[][]).map((r) => `[${r.map(q).join(",")}]`).join(" ; ")}` : "");
const ptBox = (o: EditOp) => [o.x !== undefined || o.y !== undefined ? `at ${o.x ?? 0},${o.y ?? 0} pt` : "", o.w !== undefined ? `${o.w}×${o.h} pt` : ""].filter(Boolean).join(", ");
export const colLetters = (n: number): string => {
  let out = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) out = String.fromCharCode(65 + ((x - 1) % 26)) + out;
  return out;
};
const CF_WORDS: Record<string, string> = {
  number_greater: "greater than", number_greater_or_equal: "at least", number_less: "less than", number_less_or_equal: "at most", number_equal: "equal to", number_not_equal: "not equal to",
  number_between: "between", number_not_between: "not between", text_contains: "containing", text_not_contains: "not containing", text_starts_with: "starting with", text_ends_with: "ending with", text_equal: "exactly", blank: "empty", not_blank: "not empty",
};
const valueWord = (v: unknown) => (typeof v === "string" ? q(v) : String(v));

/** What each operation will do, in words, with its text and values in full:
 *  this IS what a person approves (invariant 43). Derived from the same `ops`
 *  the request is built from — never stored apart from them. */
export function editOpLines(app: EditApp, ops: readonly EditOp[]): string[] {
  return ops.map((o) => {
    if (o.op === "replace_text") return `Replace every ${q(o.find)} with ${q(o.replace)}${caseNote(o)}${onSlides(o)}`;
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
      if (o.op === "style_text") {
        const what = [...styleWords(o), ...paraWords(o)].join(", ");
        return o.objectId !== undefined ? `Make all the text of ${o.objectId} ${what}${noteOf(o)}` : `Make every ${q(o.find)}${caseNote(o)}${onSlides(o)} ${what}`;
      }
      if (o.op === "set_notes") return `${o.text ? `Set the speaker notes of slide ${o.slideId} to ${q(o.text)}` : `Clear the speaker notes of slide ${o.slideId}`}${noteOf(o)}`;
      if (o.op === "add_shape") return `Add a ${String(o.kind).replace(/_/g, " ")} ${o.objectId} on slide ${o.slideId} (${ptBox(o)})${o.fill ? `, filled ${o.fill}` : ""}${o.text !== undefined ? ` — text: ${q(o.text)}` : ""}${noteOf(o)}`;
      if (o.op === "move") {
        const parts = [o.x !== undefined || o.y !== undefined ? `move it to ${o.x ?? "(same)"},${o.y ?? "(same)"} pt` : "", o.w !== undefined || o.h !== undefined ? `resize it to ${o.w ?? "(same)"}×${o.h ?? "(same)"} pt` : ""].filter(Boolean);
        return `${o.objectId}: ${parts.join(", ")}${noteOf(o)}`;
      }
      if (o.op === "delete_element") return `Delete the element ${o.objectId}${noteOf(o)}`;
      if (o.op === "add_table") return `Add a ${o.rows}×${o.cols} table ${o.objectId} on slide ${o.slideId}${ptBox(o) ? ` (${ptBox(o)})` : ""}${cellsWords(o.cells)}${noteOf(o)}`;
      if (o.op === "table_cell") return `${o.text ? `Set row ${o.row}, column ${o.col} of the table ${o.objectId} to ${q(o.text)}` : `Empty row ${o.row}, column ${o.col} of the table ${o.objectId}`}${noteOf(o)}`;
      if (o.op === "replace_image") return `Replace the image ${o.objectId} with ${o.url} (${o.crop ? "cropped to fill its box" : "fitted inside its box"})${noteOf(o)}`;
      if (o.op === "replace_shapes_with_image") return `Replace every shape whose text contains ${q(o.find)}${caseNote(o)}${onSlides(o)} with the image ${o.url} (${o.crop ? "cropped to fill" : "fitted inside"})`;
      // Slides counts the place BEFORE the move, so that is what is said.
      return `Move slide${(o.slideIds as string[]).length === 1 ? "" : "s"} ${(o.slideIds as string[]).join(", ")} to just before the slide that is now number ${(o.at as number) + 1} (to the end if there is none)${noteOf(o)}`;
    }
    if (app === "doc") {
      if (o.op === "delete_text") return `Delete every ${q(o.find)}${caseNote(o)}`;
      if (o.op === "insert_text") {
        const st = styleWords(o);
        return `Insert ${q(o.text)} ${atWords(o.at)}${st.length ? ` — ${st.join(", ")}` : ""}`;
      }
      if (o.op === "style") {
        const what = [o.heading !== undefined ? (o.heading === "NORMAL" ? "normal text" : `heading ${String(o.heading).slice(1)}`) : "", ...styleWords(o), ...paraWords(o)].filter(Boolean);
        return `Make every ${q(o.find)} ${what.join(", ")}${noteOf(o)}`;
      }
      if (o.op === "insert_table") return `Insert a ${o.rows}×${o.cols} table ${atWords(o.at)}${cellsWords(o.cells)}`;
      if (o.op === "page_break") return `Insert a page break ${atWords(o.at)}`;
      if (o.op === "table_cell") return `${o.text ? `Set row ${o.row}, column ${o.col} of table ${o.table} to ${q(o.text)}` : `Empty row ${o.row}, column ${o.col} of table ${o.table}`}${noteOf(o)}`;
      if (o.op === "insert_table_row") return `Insert an empty row ${o.below === false ? "above" : "below"} row ${o.row} of table ${o.table}${noteOf(o)}`;
      if (o.op === "delete_table_row") return `Delete row ${o.row} of table ${o.table}${noteOf(o)}`;
      return `Insert the image ${o.url} ${atWords(o.at)}`;
    }
    const tab = o.tab ? ` of tab ${q(o.tab)}` : " of the first tab";
    if (o.op === "update") return `Write at ${o.range}${onTab(o.range)}: ${(o.values as Cell[][]).map((r) => `[${r.map((c) => (typeof c === "string" ? q(c) : String(c))).join(",")}]`).join(" ; ")}`;
    if (o.op === "clear") return `Clear ${o.range}${onTab(o.range)}`;
    if (o.op === "add_tab") return `Add a tab ${q(o.title)}`;
    if (o.op === "duplicate_tab") return `Duplicate the tab ${q(o.tab)} as ${q(o.title)} (formats and formulas kept) ${o.at === undefined ? "right after it" : `at position ${(o.at as number) + 1}`}`;
    if (o.op === "delete_tab") return `Delete the tab ${q(o.title)} and everything in it`;
    if (o.op === "rename_tab") return `Rename the tab ${q(o.from)} to ${q(o.to)}`;
    if (o.op === "insert_rows") return `Insert ${o.count} row${o.count === 1 ? "" : "s"} before row ${o.start}${tab}`;
    if (o.op === "delete_rows") return `Delete ${o.count} row${o.count === 1 ? "" : "s"} from row ${o.start}${tab}`;
    if (o.op === "insert_cols") return `Insert ${o.count} column${o.count === 1 ? "" : "s"} before column ${o.start}${tab}`;
    if (o.op === "delete_cols") return `Delete ${o.count} column${o.count === 1 ? "" : "s"} from column ${o.start}${tab}`;
    if (o.op === "sort") return `Sort ${o.range}${onTab(o.range)} by ${(o.by as { col: string; desc: boolean }[]).map((k) => `column ${k.col} (${k.desc ? "Z→A, largest first" : "A→Z, smallest first"})`).join(", then ")}`;
    if (o.op === "filter") return `Put a filter on ${o.range}${onTab(o.range)} (it replaces the tab's filter, if any)`;
    if (o.op === "clear_filter") return `Remove the filter${tab}`;
    if (o.op === "freeze") return `Freeze ${[o.rows !== undefined ? (o.rows === 0 ? "no rows" : `the first ${o.rows} row${o.rows === 1 ? "" : "s"}`) : "", o.cols !== undefined ? (o.cols === 0 ? "no columns" : `the first ${o.cols} column${o.cols === 1 ? "" : "s"}`) : ""].filter(Boolean).join(" and ")}${tab}`;
    if (o.op === "column_width" || o.op === "row_height") {
      const cols = o.op === "column_width";
      const s0 = Number(o.start);
      const s1 = s0 + Number(o.count) - 1;
      const name = cols ? (s0 === s1 ? `column ${colLetters(s0)}` : `columns ${colLetters(s0)} to ${colLetters(s1)}`) : s0 === s1 ? `row ${s0}` : `rows ${s0} to ${s1}`;
      const size = cols ? o.width : o.height;
      return size === "auto" ? `Fit the ${cols ? "width" : "height"} of ${name}${tab} to the content` : `Set the ${cols ? "width" : "height"} of ${name}${tab} to ${size} px`;
    }
    if (o.op === "borders") {
      const sides = (o.sides as string[]).length === BORDER_SIDES.length ? "all borders" : (o.sides as string[]).map((x) => x.replace("_", " ")).join(", ") + " borders";
      return o.style === "none" ? `Remove the ${sides} of ${o.range}${onTab(o.range)}` : `Draw ${sides} of ${o.range}${onTab(o.range)}: ${String(o.style).replace("_", " ")}, ${o.color}`;
    }
    if (o.op === "merge") return `Merge ${o.range}${onTab(o.range)} ${o.how === "rows" ? "row by row" : o.how === "columns" ? "column by column" : "into one cell"} (only the top-left value of each merge is kept)`;
    if (o.op === "unmerge") return `Unmerge the cells of ${o.range}${onTab(o.range)}`;
    if (o.op === "find_replace") {
      const where = o.range !== undefined ? `${o.range}${onTab(o.range)}` : o.tab !== undefined ? `the tab ${q(o.tab)}` : "every tab";
      return `Replace every ${q(o.find)} with ${q(o.replace)} in ${where}${caseNote(o)}${o.wholeCell ? " (whole cells only)" : ""}${o.formulas ? " (inside formulas too)" : ""}`;
    }
    if (o.op === "copy") return `Copy ${o.from}${onTab(o.from)} to ${o.to}${onTab(o.to)} — ${o.paste === "values" ? "values only" : o.paste === "formats" ? "formats only" : o.paste === "formulas" ? "formulas only" : "values, formulas and formats"}`;
    if (o.op === "conditional_format") {
      const vals = (o.values as unknown[] | undefined) ?? [];
      const cond = `${CF_WORDS[String(o.rule)]}${vals.length ? ` ${vals.map(valueWord).join(" and ")}` : ""}`;
      const look = [o.background ? `background ${o.background}` : "", o.color ? `text colour ${o.color}` : "", o.bold !== undefined ? (o.bold ? "bold" : "not bold") : "", o.italic !== undefined ? (o.italic ? "italic" : "not italic") : ""].filter(Boolean).join(", ");
      return `In ${o.range}${onTab(o.range)}, cells ${cond}: ${look}`;
    }
    if (o.op === "validation") return `Make ${o.range}${onTab(o.range)} a dropdown of ${(o.list as string[]).map(q).join(", ")} (${o.strict === false ? "other values allowed, with a warning" : "other values refused"})`;
    if (o.op === "clear_validation") return `Remove the dropdowns and data validation of ${o.range}${onTab(o.range)}`;
    const fmt = [
      o.bold !== undefined ? (o.bold ? "bold" : "not bold") : "",
      o.italic !== undefined ? (o.italic ? "italic" : "not italic") : "",
      o.underline !== undefined ? (o.underline ? "underlined" : "not underlined") : "",
      o.strikethrough !== undefined ? (o.strikethrough ? "struck through" : "not struck through") : "",
      o.background ? `background ${o.background}` : "",
      o.color ? `text colour ${o.color}` : "",
      o.font !== undefined ? `font ${q(o.font)}` : "",
      o.size !== undefined ? `${o.size} pt` : "",
      o.align !== undefined ? ALIGN_WORDS[String(o.align)] : "",
      o.valign !== undefined ? `vertically ${o.valign === "middle" ? "centred" : `at the ${o.valign}`}` : "",
      o.wrap !== undefined ? (o.wrap ? "text wrapped" : "text not wrapped") : "",
      o.numberFormat !== undefined ? `number format ${q(o.numberFormat)}` : "",
    ].filter(Boolean);
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

/** An element of a slide as edits see it. */
export interface SlideElement {
  id: string;
  type: string;
  text: string;
  /** Where it sits and how big it is, in points (rounded) — what \`slides read\` shows and \`move\` starts from. */
  box?: { x: number; y: number; w: number; h: number };
  /** Its geometry as the API gives it, in EMU: base size and affine transform. */
  geo?: { bw: number; bh: number; sx: number; sy: number; shx: number; shy: number; tx: number; ty: number };
  /** A table's cells, row by row. */
  cells?: string[][];
  /** Inside a group: its transform is relative to the group, so it is not moved on its own. */
  inGroup?: true;
}
export interface SlidesState {
  app: "slides";
  title: string;
  revisionId?: string;
  /** \`notesId\` is the speaker-notes shape (Google creates it on first insert); \`notes\` its text. */
  slides: { id: string; layout: string; elements: SlideElement[]; notesId?: string; notes?: string }[];
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
  paragraphs: { start: number; end: number; style: string; text: string; inTable?: true }[];
  /** The body's end index (its last newline is at `end - 1`). */
  end: number;
  /** Every table, in document order (nested ones after their parent): what
   *  \`table_cell\` / \`insert_table_row\` count from 1. A cell's \`start\`/\`end\` span its content. */
  tables?: { start: number; rows: { start: number; end: number; text: string }[][] }[];
}
export interface SheetState {
  app: "sheet";
  title: string;
  tabs: { id: number; title: string }[];
}
export type EditState = SlidesState | DocState | SheetState;

type J = Record<string, any>;
// Auto text (a slide number) takes indices like any run: counted, so found
// text maps onto the right range.
const runsText = (t: J | undefined): string => ((t?.textElements ?? []) as J[]).map((e) => e.textRun?.content ?? e.autoText?.content ?? "").join("");

export const EMU_PER_PT = 12700;
const emu = (d: J | undefined): number => (d?.unit === "PT" ? Number(d.magnitude ?? 0) * EMU_PER_PT : Number(d?.magnitude ?? 0));
const round1 = (n: number) => Math.round(n * 10) / 10;
/** The points box of a geometry (shear ignored: it is what a person reads, not what is sent). */
export const geoBox = (g: NonNullable<SlideElement["geo"]>) => ({ x: round1(g.tx / EMU_PER_PT), y: round1(g.ty / EMU_PER_PT), w: round1((g.bw * g.sx) / EMU_PER_PT), h: round1((g.bh * g.sy) / EMU_PER_PT) });

function geometry(e: J): Pick<SlideElement, "box" | "geo"> {
  if (!e.size?.width || !e.size?.height) return {};
  const t = (e.transform ?? {}) as J;
  const k = t.unit === "PT" ? EMU_PER_PT : 1;
  const geo = { bw: emu(e.size.width), bh: emu(e.size.height), sx: Number(t.scaleX ?? 1), sy: Number(t.scaleY ?? 1), shx: Number(t.shearX ?? 0), shy: Number(t.shearY ?? 0), tx: Number(t.translateX ?? 0) * k, ty: Number(t.translateY ?? 0) * k };
  return { box: geoBox(geo), geo };
}

function slideElements(els: J[] | undefined, inGroup = false): SlideElement[] {
  const out: SlideElement[] = [];
  for (const e of els ?? []) {
    if (e.elementGroup) {
      out.push(...slideElements(e.elementGroup.children, true));
      continue;
    }
    const id = String(e.objectId ?? "");
    const where = { ...(inGroup ? { inGroup: true as const } : geometry(e)) };
    if (e.shape) out.push({ id, type: e.shape.placeholder?.type ? `placeholder ${e.shape.placeholder.type}` : String(e.shape.shapeType ?? "shape").toLowerCase(), text: runsText(e.shape.text), ...where });
    else if (e.table) {
      const cells = ((e.table.tableRows ?? []) as J[]).map((r) => ((r.tableCells ?? []) as J[]).map((c) => runsText(c.text).replace(/\n$/, "")));
      out.push({ id, type: "table", text: cells.map((r) => r.map((c) => c.trim()).join(" | ")).join("\n"), cells, ...where });
    } else out.push({ id, type: e.image ? "image" : e.video ? "video" : e.line ? "line" : e.sheetsChart ? "chart" : "other", text: "", ...where });
  }
  return out;
}

/** A slide's speaker notes: the shape's id (it may not exist yet — Google
 *  creates it on the first insert) and its text. */
function slideNotes(s: J): { notesId?: string; notes?: string } {
  const page = s.slideProperties?.notesPage;
  const id = page?.notesProperties?.speakerNotesObjectId;
  if (typeof id !== "string" || !id) return {};
  const shape = ((page.pageElements ?? []) as J[]).find((e) => e.objectId === id);
  return { notesId: id, notes: runsText(shape?.shape?.text) };
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
    slides: ((p.slides ?? []) as J[]).map((s) => ({ id: String(s.objectId ?? ""), layout: names.get(String(s.slideProperties?.layoutObjectId)) ?? "", elements: slideElements(s.pageElements), ...slideNotes(s) })),
    layouts,
  };
}

export function docState(d: J): DocState {
  const paragraphs: DocState["paragraphs"] = [];
  const tables: NonNullable<DocState["tables"]> = [];
  const walk = (content: J[] | undefined, inTable = false) => {
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
        paragraphs.push({ start: Number(c.startIndex ?? 0), end: Number(c.endIndex ?? 0), style: String(c.paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT"), text: t, ...(inTable ? { inTable: true as const } : {}) });
      } else if (c.table) {
        const table: NonNullable<DocState["tables"]>[number] = { start: Number(c.startIndex ?? 0), rows: [] };
        tables.push(table);
        for (const r of (c.table.tableRows ?? []) as J[]) {
          const row: (typeof table.rows)[number] = [];
          for (const cell of (r.tableCells ?? []) as J[]) {
            const from = paragraphs.length;
            walk(cell.content, true);
            const content = (cell.content ?? []) as J[];
            row.push({ start: Number(content[0]?.startIndex ?? cell.startIndex ?? 0), end: Number(content.at(-1)?.endIndex ?? cell.endIndex ?? 0), text: paragraphs.slice(from).map((p) => p.text).join("") });
          }
          table.rows.push(row);
        }
      }
    }
  };
  const content = (d.body?.content ?? []) as J[];
  walk(content);
  return { app: "doc", title: String(d.title ?? ""), ...(typeof d.revisionId === "string" ? { revisionId: d.revisionId } : {}), paragraphs, end: Number(content.at(-1)?.endIndex ?? 1), ...(tables.length ? { tables } : {}) };
}

/** The tables of a document, counted from 1 — what table operations name. */
export function docTables(s: DocState): { table: number; rows: number; cols: number }[] {
  return (s.tables ?? []).map((t, i) => ({ table: i + 1, rows: t.rows.length, cols: Math.max(0, ...t.rows.map((r) => r.length)) }));
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

/** Where a located Docs operation goes, or null for "the end". `tail`: it
 *  must go just BEFORE the anchor paragraph's newline — the anchor is followed
 *  by a table (Docs refuses an insert at a table's start index) or closes the
 *  document (nothing goes past the last newline). */
function docIndex(s: DocState, at: unknown, w: string): { index: number; tail: boolean } | null {
  if (at === "start") return { index: 1, tail: false };
  if (at === "end" || at === undefined) return null;
  const a = at as { after?: string; afterText?: string };
  let p: DocState["paragraphs"][number] | undefined;
  if (a.afterText !== undefined) {
    const hits = s.paragraphs.filter((x) => !x.inTable && x.text.includes(a.afterText as string));
    if (!hits.length) return bad(`${w}: no paragraph contains that text in the document as it is now (see \`doc read\`).`);
    if (hits.length > 1) return bad(`${w}: ${hits.length} paragraphs contain that text — give words only one of them has.`);
    p = hits[0];
  } else {
    const want = String(a.after);
    // A heading first, as before; then a paragraph whose whole text it is.
    p = s.paragraphs.find((x) => !x.inTable && /^HEADING_[1-6]$/.test(x.style) && x.text.trim() === want);
    if (!p) {
      const hits = s.paragraphs.filter((x) => !x.inTable && x.text.trim() === want);
      if (hits.length > 1) return bad(`${w}: ${hits.length} paragraphs have exactly that text — anchor with {"afterText": "<words only one of them has>"}.`);
      p = hits[0];
    }
    if (!p) return bad(`${w}: there is no heading or paragraph with that exact text in the document as it is now (see \`doc read\`; {"afterText": "…"} matches part of a paragraph).`);
  }
  const tableNext = (s.tables ?? []).some((t) => t.start === p!.end);
  return p.end >= s.end || tableNext ? { index: p.end - 1, tail: true } : { index: p.end, tail: false };
}

/** The Docs text style of an operation, and its field mask; null when it sets none. */
function docTextStyle(o: EditOp): { textStyle: J; fields: string } | null {
  const st: J = {};
  const fields: string[] = [];
  for (const k of ["bold", "italic", "underline", "strikethrough"]) {
    if (o[k] === undefined) continue;
    st[k] = o[k];
    fields.push(k);
  }
  if (o.font !== undefined) {
    st.weightedFontFamily = { fontFamily: o.font };
    fields.push("weightedFontFamily");
  }
  if (o.size !== undefined) {
    st.fontSize = { magnitude: o.size, unit: "PT" };
    fields.push("fontSize");
  }
  if (o.color !== undefined) {
    st.foregroundColor = { color: { rgbColor: rgb(o.color) } };
    fields.push("foregroundColor");
  }
  // A link removed is the field in the mask with no value.
  if (o.link !== undefined) {
    if (o.link !== false) st.link = { url: o.link };
    fields.push("link");
  }
  return fields.length ? { textStyle: st, fields: fields.join(",") } : null;
}

const DOC_BULLETS: Record<string, string> = { bullet: "BULLET_DISC_CIRCLE_SQUARE", numbered: "NUMBERED_DECIMAL_ALPHA_ROMAN", checkbox: "BULLET_CHECKBOX" };

function docRequests(ops: readonly EditOp[], s: DocState): J[] {
  /** `sub` orders operations at one same index (a table's rows: the highest row first). */
  const located: { index: number; sub: number; order: number; insert: boolean; reqs: J[] }[] = [];
  const sequential: J[] = [];
  const cellsSet = new Set<string>();
  const rowsGone = new Map<number, Set<number>>();
  const table = (n: unknown, w: string) => s.tables?.[Number(n) - 1] ?? bad(`${w}: there is no table ${n} in the document as it is now — it has ${s.tables?.length ?? 0} (see \`doc read\`).`);
  const row = (t: NonNullable<DocState["tables"]>[number], n: unknown, r: unknown, w: string) => t.rows[Number(r) - 1] ?? bad(`${w}: table ${n} has ${t.rows.length} row${t.rows.length === 1 ? "" : "s"}.`);
  ops.forEach((o, i) => {
    const w = `operation ${i + 1}`;
    const put = (index: number, insert: boolean, reqs: J[], sub = 0) => located.push({ index, sub, order: i, insert, reqs });
    if (o.op === "replace_text" || o.op === "delete_text") {
      sequential.push({ replaceAllText: { containsText: { text: o.find, matchCase: o.matchCase !== false }, replaceText: o.op === "delete_text" ? "" : o.replace } });
    } else if (o.op === "style") {
      const hits = occurrences(s, String(o.find), w);
      const ts = docTextStyle(o);
      const list = o.list !== undefined ? String(o.list) : o.bullet ? "bullet" : undefined;
      const para: J = {};
      if (o.heading !== undefined) para.namedStyleType = o.heading === "NORMAL" ? "NORMAL_TEXT" : `HEADING_${String(o.heading).slice(1)}`;
      if (o.align !== undefined) para.alignment = ALIGN_API[String(o.align)];
      for (const r of hits) {
        const range = { startIndex: r.start, endIndex: r.end };
        const reqs: J[] = [];
        if (ts) reqs.push({ updateTextStyle: { range, ...ts } });
        if (Object.keys(para).length) reqs.push({ updateParagraphStyle: { range, paragraphStyle: para, fields: Object.keys(para).join(",") } });
        if (list === "none") reqs.push({ deleteParagraphBullets: { range } });
        else if (list) reqs.push({ createParagraphBullets: { range, bulletPreset: DOC_BULLETS[list] } });
        put(r.start, false, reqs);
      }
    } else if (o.op === "insert_text") {
      const where = docIndex(s, o.at, w);
      const after = typeof o.at === "object";
      const ts = docTextStyle(o);
      const body = String(o.text);
      const styled = (from: number): J[] => {
        const len = body.replace(/\n+$/, "").length;
        return ts && len ? [{ updateTextStyle: { range: { startIndex: from, endIndex: from + len }, ...ts } }] : [];
      };
      if (where === null && !ts) {
        sequential.push({ insertText: { text: body, endOfSegmentLocation: {} } });
      } else if (where === null) {
        // Styled at the end: placed where the end is now, so the style knows its range.
        const index = Math.max(1, s.end - 1);
        put(index, true, [{ insertText: { text: body, location: { index } } }, ...styled(index)]);
      } else if (!after) {
        put(where.index, true, [{ insertText: { text: body, location: { index: where.index } } }, ...styled(where.index)]);
      } else {
        // Its own paragraph(s) under the anchor, as normal text — not a
        // continuation of a heading's style.
        const own = body.endsWith("\n") ? body.slice(0, -1) : body;
        const t = where.tail ? `\n${own}` : `${own}\n`;
        const from = where.index + (where.tail ? 1 : 0);
        put(where.index, true, [
          { insertText: { text: t, location: { index: where.index } } },
          { updateParagraphStyle: { range: { startIndex: from, endIndex: from + own.length + (where.tail ? 0 : 1) }, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } },
          ...styled(from),
        ]);
      }
    } else if (o.op === "insert_table") {
      const rows = Number(o.rows);
      const cols = Number(o.cols);
      const cells = (o.cells as string[][] | undefined) ?? [];
      const where = docIndex(s, o.at, w);
      if (where === null && !cells.length) {
        sequential.push({ insertTable: { rows, columns: cols, endOfSegmentLocation: {} } });
        return;
      }
      const index = where === null ? Math.max(1, s.end - 1) : where.index;
      const reqs: J[] = [{ insertTable: { rows, columns: cols, location: { index } } }];
      // The new table starts one index further (Docs puts a newline before
      // it); its first cell's text is 3 further, each cell takes 2 and each
      // row 1 more. Filled last cell first, so earlier indices stay true.
      for (let r = cells.length - 1; r >= 0; r--) {
        for (let c = cells[r].length - 1; c >= 0; c--) {
          if (cells[r][c]) reqs.push({ insertText: { text: cells[r][c], location: { index: index + 4 + r * (2 * cols + 1) + 2 * c } } });
        }
      }
      put(index, true, reqs);
    } else if (o.op === "page_break" || o.op === "insert_image") {
      const where = docIndex(s, o.at, w);
      const req = (loc: J): J => (o.op === "page_break" ? { insertPageBreak: loc } : { insertInlineImage: { uri: o.url, ...loc } });
      if (where === null) sequential.push(req({ endOfSegmentLocation: {} }));
      else put(where.index, true, [req({ location: { index: where.index } })]);
    } else if (o.op === "table_cell") {
      const t = table(o.table, w);
      const cell = row(t, o.table, o.row, w)[Number(o.col) - 1] ?? bad(`${w}: row ${o.row} of table ${o.table} has ${t.rows[Number(o.row) - 1].length} cells.`);
      const key = `${o.table}:${o.row}:${o.col}`;
      if (cellsSet.has(key)) return bad(`${w}: that cell is already set by this edit.`);
      cellsSet.add(key);
      // The cell's text is replaced; its last newline is the cell's own and stays.
      const reqs: J[] = [];
      if (cell.end - 1 > cell.start) reqs.push({ deleteContentRange: { range: { startIndex: cell.start, endIndex: cell.end - 1 } } });
      if (o.text) reqs.push({ insertText: { text: o.text, location: { index: cell.start } } });
      put(cell.start, true, reqs);
    } else {
      // A table's rows, as it is now: the highest row first, so none shifts
      // the next; before any insert at the table's own index.
      const t = table(o.table, w);
      row(t, o.table, o.row, w);
      const r = Number(o.row);
      const at = { tableCellLocation: { tableStartLocation: { index: t.start }, rowIndex: r - 1, columnIndex: 0 } };
      if (o.op === "delete_table_row") {
        const gone = rowsGone.get(t.start) ?? new Set<number>();
        if (gone.has(r)) return bad(`${w}: row ${r} of table ${o.table} is already deleted by this edit.`);
        gone.add(r);
        rowsGone.set(t.start, gone);
        if (gone.size >= t.rows.length) return bad(`${w}: that would delete every row of table ${o.table} — a table keeps at least one row.`);
        put(t.start, false, [{ deleteTableRow: at }], 2 * r);
      } else {
        put(t.start, false, [{ insertTableRow: { ...at, insertBelow: o.below !== false } }], 2 * r + (o.below === false ? -1 : 1));
      }
    }
  });
  // Located operations run first, from the END of the document backwards:
  // none shifts the place of the next. At one same place a style goes before
  // any insert (its range is the text that is there NOW — an insert made first
  // would take it), and of two inserts the later-listed goes first.
  located.sort((a, b) => b.index - a.index || b.sub - a.sub || Number(a.insert) - Number(b.insert) || b.order - a.order);
  return [...located.flatMap((l) => l.reqs), ...sequential];
}

/** What a Slides batch creates, by id — reported to the agent, so a later
 *  edit can target a copy's elements. */
export type SlidesCreated =
  | { op: "add_slide"; slideId: string; titleId?: string; bodyId?: string }
  | { op: "duplicate_slide"; from: string; slideId: string; elements: { id: string; from: string; type: string }[] }
  | { op: "add_shape" | "add_table"; slideId: string; objectId: string };

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

/** Every occurrence of `find` in `text`, as [start, end) — Slides counts in UTF-16 units, as JS does. */
function findAll(text: string, find: string, matchCase: boolean): [number, number][] {
  let hay = matchCase ? text : text.toLowerCase();
  let needle = matchCase ? find : find.toLowerCase();
  // A lower-casing that changes lengths would shift every range: matched as written instead.
  if (hay.length !== text.length || needle.length !== find.length) [hay, needle] = [text, find];
  const out: [number, number][] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length]);
  return out;
}
/** What a replace_text does to a text, so later operations of the batch see the deck as it will be. */
function replaceAll(text: string, find: string, repl: string, matchCase: boolean): string {
  if (matchCase) return text.split(find).join(repl);
  return text.replace(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), () => repl);
}
/** The Slides text style of an operation, and its field mask; null when it sets none. */
function slidesTextStyle(o: EditOp): { style: J; fields: string } | null {
  const st: J = {};
  const fields: string[] = [];
  for (const k of ["bold", "italic", "underline", "strikethrough"]) {
    if (o[k] === undefined) continue;
    st[k] = o[k];
    fields.push(k);
  }
  if (o.font !== undefined) {
    st.fontFamily = o.font;
    fields.push("fontFamily");
  }
  if (o.size !== undefined) {
    st.fontSize = { magnitude: o.size, unit: "PT" };
    fields.push("fontSize");
  }
  if (o.color !== undefined) {
    st.foregroundColor = { opaqueColor: { rgbColor: rgb(o.color) } };
    fields.push("foregroundColor");
  }
  if (o.link !== undefined) {
    if (o.link !== false) st.link = { url: o.link };
    fields.push("link");
  }
  return fields.length ? { style: st, fields: fields.join(",") } : null;
}
const NOT_SHAPES = new Set(["table", "image", "video", "line", "chart", "other"]);
const ptGeo = (b: Record<string, unknown>) => {
  const g = { bw: Number(b.w) * EMU_PER_PT, bh: Number(b.h) * EMU_PER_PT, sx: 1, sy: 1, shx: 0, shy: 0, tx: Number(b.x ?? 0) * EMU_PER_PT, ty: Number(b.y ?? 0) * EMU_PER_PT };
  return { geo: g, box: geoBox(g) };
};
const cellsText = (cells: string[][]) => cells.map((r) => r.map((c) => c.trim()).join(" | ")).join("\n");

function slidesPlan(ops: readonly EditOp[], s: SlidesState): { requests: J[]; created: SlidesCreated[] } {
  type El = SlideElement;
  const original = new Set(s.slides.map((x) => x.id));
  /** The deck's order as the batch leaves it, step by step. */
  const current = s.slides.map((x) => x.id);
  /** Each slide's elements — the deck's, then what this batch creates. Copied:
   *  the state read is not changed by planning (a card is annotated from it). */
  const onSlide = new Map<string, El[]>(s.slides.map((x) => [x.id, x.elements.map((e) => ({ ...e, ...(e.cells ? { cells: e.cells.map((r) => [...r]) } : {}) }))]));
  /** The speaker notes of the deck's slides — a slide this batch creates has none it can reach. */
  const notes = new Map(s.slides.filter((x) => x.notesId).map((x) => [x.id, { id: String(x.notesId), text: x.notes ?? "" }]));
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
    const needEl = (id: unknown): El => elements.get(String(id)) ?? bad(`${w}: there is no element '${String(id).slice(0, 60)}' in the deck as it is now (see \`slides read\`).`);
    const dropEl = (id: string) => {
      elements.delete(id);
      for (const els of onSlide.values()) {
        const k = els.findIndex((e) => e.id === id);
        if (k >= 0) els.splice(k, 1);
      }
    };
    const pages = (): string[] => (Array.isArray(o.slideIds) ? (o.slideIds as string[]).map(needSlide) : [...current]);
    if (o.op === "replace_text") {
      const only = Array.isArray(o.slideIds) ? pages() : null;
      out.push({ replaceAllText: { containsText: { text: o.find, matchCase: o.matchCase !== false }, replaceText: o.replace, ...(only ? { pageObjectIds: only } : {}) } });
      const [f, r, cs] = [String(o.find), String(o.replace), o.matchCase !== false];
      for (const sid of only ?? current) {
        for (const e of onSlide.get(sid) ?? []) {
          e.text = replaceAll(e.text, f, r, cs);
          if (e.cells) e.cells = e.cells.map((row) => row.map((c) => replaceAll(c, f, r, cs)));
        }
        const n = only ? undefined : notes.get(sid);
        if (n) n.text = replaceAll(n.text, f, r, cs);
      }
    } else if (o.op === "style_text") {
      const ranges: J[] = [];
      if (o.objectId !== undefined) {
        const e = needEl(o.objectId);
        if (e.type === "table") return bad(`${w}: '${e.id}' is a table — set its cells with table_cell; style_text styles shapes and text boxes.`);
        if (!e.text.replace(/\n$/, "")) return bad(`${w}: element '${e.id}' has no text to style.`);
        ranges.push({ objectId: e.id, textRange: { type: "ALL" } });
      } else {
        for (const sid of pages()) {
          for (const e of onSlide.get(sid) ?? []) {
            if (e.type === "table" || !e.text) continue;
            for (const [a, b] of findAll(e.text, String(o.find), o.matchCase !== false)) ranges.push({ objectId: e.id, textRange: { type: "FIXED_RANGE", startIndex: a, endIndex: b } });
          }
        }
        if (!ranges.length) return bad(`${w}: its 'find' text is not in the deck as it is now (see \`slides read\`).`);
        if (ranges.length > 200) return bad(`${w}: its 'find' text appears more than 200 times — style a more specific text.`);
      }
      const ts = slidesTextStyle(o);
      for (const r of ranges) {
        if (ts) out.push({ updateTextStyle: { ...r, ...ts } });
        if (o.align !== undefined) out.push({ updateParagraphStyle: { ...r, style: { alignment: ALIGN_API[String(o.align)] }, fields: "alignment" } });
        if (o.list === "none") out.push({ deleteParagraphBullets: { ...r } });
        else if (o.list !== undefined) out.push({ createParagraphBullets: { ...r, bulletPreset: o.list === "numbered" ? "NUMBERED_DIGIT_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE" } });
      }
    } else if (o.op === "set_notes") {
      const sid = needSlide(o.slideId);
      const n = notes.get(sid) ?? bad(`${w}: the speaker notes of slide '${sid.slice(0, 60)}' cannot be reached in this edit — a slide added or duplicated by this same edit gets its notes in a second edit.`);
      if (n.text.replace(/\n$/, "")) out.push({ deleteText: { objectId: n.id, textRange: { type: "ALL" } } });
      if (o.text) out.push({ insertText: { objectId: n.id, text: o.text, insertionIndex: 0 } });
      n.text = String(o.text);
    } else if (o.op === "add_shape") {
      const sid = needSlide(o.slideId);
      const id = String(o.objectId);
      claim(id);
      out.push({ createShape: { objectId: id, shapeType: String(o.kind).toUpperCase(), elementProperties: { pageObjectId: sid, size: { width: { magnitude: o.w, unit: "PT" }, height: { magnitude: o.h, unit: "PT" } }, transform: { scaleX: 1, scaleY: 1, translateX: o.x, translateY: o.y, unit: "PT" } } } });
      if (o.text !== undefined) out.push({ insertText: { objectId: id, text: o.text, insertionIndex: 0 } });
      if (o.fill !== undefined) out.push({ updateShapeProperties: { objectId: id, shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: rgb(o.fill) } } } }, fields: "shapeBackgroundFill.solidFill.color" } });
      const e: El = { id, type: String(o.kind), text: o.text !== undefined ? String(o.text) : "", ...ptGeo(o) };
      onSlide.get(sid)!.push(e);
      elements.set(id, e);
      created.push({ op: "add_shape", slideId: sid, objectId: id });
    } else if (o.op === "move") {
      const e = needEl(o.objectId);
      if (e.inGroup) return bad(`${w}: '${e.id}' is inside a group — it cannot be moved on its own.`);
      if (!e.geo) return bad(`${w}: where '${e.id}' sits is not known (an element added by this same edit without a size?) — move it in a second edit.`);
      const g = { ...e.geo };
      if (o.x !== undefined) g.tx = Number(o.x) * EMU_PER_PT;
      if (o.y !== undefined) g.ty = Number(o.y) * EMU_PER_PT;
      if (o.w !== undefined || o.h !== undefined) {
        if (g.shx || g.shy) return bad(`${w}: '${e.id}' is rotated or skewed — it can be moved, not resized.`);
        if (!g.bw || !g.bh) return bad(`${w}: '${e.id}' has no size to scale from — it can be moved, not resized.`);
        if (o.w !== undefined) g.sx = (Number(o.w) * EMU_PER_PT) / g.bw;
        if (o.h !== undefined) g.sy = (Number(o.h) * EMU_PER_PT) / g.bh;
      }
      // ABSOLUTE: the whole transform is given, so the scale an element already has is kept unless resized.
      out.push({ updatePageElementTransform: { objectId: e.id, applyMode: "ABSOLUTE", transform: { scaleX: g.sx, scaleY: g.sy, shearX: g.shx, shearY: g.shy, translateX: g.tx, translateY: g.ty, unit: "EMU" } } });
      e.geo = g;
      e.box = geoBox(g);
    } else if (o.op === "delete_element") {
      const e = needEl(o.objectId);
      out.push({ deleteObject: { objectId: e.id } });
      dropEl(e.id);
    } else if (o.op === "add_table") {
      const sid = needSlide(o.slideId);
      const id = String(o.objectId);
      claim(id);
      const [rows, cols] = [Number(o.rows), Number(o.cols)];
      const placed = o.x !== undefined || o.y !== undefined;
      out.push({
        createTable: {
          objectId: id,
          elementProperties: {
            pageObjectId: sid,
            ...(o.w !== undefined ? { size: { width: { magnitude: o.w, unit: "PT" }, height: { magnitude: o.h, unit: "PT" } } } : {}),
            ...(placed ? { transform: { scaleX: 1, scaleY: 1, translateX: o.x ?? 0, translateY: o.y ?? 0, unit: "PT" } } : {}),
          },
          rows,
          columns: cols,
        },
      });
      const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (o.cells as string[][] | undefined)?.[r]?.[c] ?? ""));
      grid.forEach((row, r) => row.forEach((t, c) => t && out.push({ insertText: { objectId: id, cellLocation: { rowIndex: r, columnIndex: c }, text: t, insertionIndex: 0 } })));
      const e: El = { id, type: "table", text: cellsText(grid), cells: grid, ...(o.w !== undefined && placed ? ptGeo(o) : {}) };
      onSlide.get(sid)!.push(e);
      elements.set(id, e);
      created.push({ op: "add_table", slideId: sid, objectId: id });
    } else if (o.op === "table_cell") {
      const e = needEl(o.objectId);
      if (!e.cells) return bad(`${w}: '${e.id}' is not a table (it is ${e.type}).`);
      const [r, c] = [Number(o.row) - 1, Number(o.col) - 1];
      if (r >= e.cells.length) return bad(`${w}: the table '${e.id}' has ${e.cells.length} row${e.cells.length === 1 ? "" : "s"}.`);
      if (c >= e.cells[r].length) return bad(`${w}: row ${r + 1} of the table '${e.id}' has ${e.cells[r].length} cells.`);
      const loc = { rowIndex: r, columnIndex: c };
      if (e.cells[r][c]) out.push({ deleteText: { objectId: e.id, cellLocation: loc, textRange: { type: "ALL" } } });
      if (o.text) out.push({ insertText: { objectId: e.id, cellLocation: loc, text: o.text, insertionIndex: 0 } });
      e.cells[r][c] = String(o.text);
      e.text = cellsText(e.cells);
    } else if (o.op === "replace_image") {
      const e = needEl(o.objectId);
      if (e.type !== "image") return bad(`${w}: '${e.id}' is not an image (it is ${e.type}).`);
      out.push({ replaceImage: { imageObjectId: e.id, url: o.url, imageReplaceMethod: o.crop ? "CENTER_CROP" : "CENTER_INSIDE" } });
    } else if (o.op === "replace_shapes_with_image") {
      const only = Array.isArray(o.slideIds) ? pages() : null;
      const hits = (only ?? current).flatMap((sid) => (onSlide.get(sid) ?? []).filter((e) => !NOT_SHAPES.has(e.type) && findAll(e.text, String(o.find), o.matchCase !== false).length));
      if (!hits.length) return bad(`${w}: no shape contains that text in the deck as it is now (see \`slides read\`).`);
      out.push({ replaceAllShapesWithImage: { imageUrl: o.url, imageReplaceMethod: o.crop ? "CENTER_CROP" : "CENTER_INSIDE", containsText: { text: o.find, matchCase: o.matchCase !== false }, ...(only ? { pageObjectIds: only } : {}) } });
      // They become images whose ids Google picks: gone for the rest of the batch.
      for (const e of hits) dropEl(e.id);
    } else if (o.op === "add_slide") {
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
      const copies = srcEls.map((e) => ({ ...e, ...(e.cells ? { cells: e.cells.map((r) => [...r]) } : {}), from: e.id, id: named[e.id] ?? copyElementId(newSlide, e.id) }));
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
    } else if (o.op === "duplicate_tab") {
      const src = tabId(String(o.tab));
      if (tabs.some((t) => t.title === o.title)) return bad(`${w}: there is already a tab with that name — give the copy a 'title'.`);
      if (tabs.some((t) => t.id === o.sheetId)) return bad(`${w}: the new tab's id is taken — send the edit again.`);
      // \`tabs\` is in the spreadsheet's order; without \`at\` the copy goes right after its source.
      const index = o.at === undefined ? tabs.findIndex((t) => t.id === src) + 1 : (o.at as number);
      if (index > tabs.length) return bad(`${w}: 'at' is past the end — the spreadsheet has ${tabs.length} tabs, so 'at' goes from 0 to ${tabs.length}.`);
      out.push({ duplicateSheet: { sourceSheetId: src, insertSheetIndex: index, newSheetId: o.sheetId, newSheetName: o.title } });
      tabs.splice(index, 0, { id: Number(o.sheetId), title: String(o.title) });
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
      const text: J = {};
      for (const k of ["bold", "italic", "underline", "strikethrough"]) {
        if (o[k] === undefined) continue;
        text[k] = o[k];
        fields.push(`userEnteredFormat.textFormat.${k}`);
      }
      if (o.color !== undefined) {
        text.foregroundColorStyle = { rgbColor: rgb(o.color) };
        fields.push("userEnteredFormat.textFormat.foregroundColorStyle");
      }
      if (o.font !== undefined) {
        text.fontFamily = o.font;
        fields.push("userEnteredFormat.textFormat.fontFamily");
      }
      if (o.size !== undefined) {
        text.fontSize = o.size;
        fields.push("userEnteredFormat.textFormat.fontSize");
      }
      if (Object.keys(text).length) format.textFormat = text;
      if (o.background) {
        format.backgroundColor = rgb(o.background);
        fields.push("userEnteredFormat.backgroundColor");
      }
      if (o.align !== undefined) {
        format.horizontalAlignment = String(o.align).toUpperCase();
        fields.push("userEnteredFormat.horizontalAlignment");
      }
      if (o.valign !== undefined) {
        format.verticalAlignment = String(o.valign).toUpperCase();
        fields.push("userEnteredFormat.verticalAlignment");
      }
      if (o.wrap !== undefined) {
        format.wrapStrategy = o.wrap ? "WRAP" : "OVERFLOW_CELL";
        fields.push("userEnteredFormat.wrapStrategy");
      }
      if (o.numberFormat !== undefined) {
        const p = String(o.numberFormat);
        format.numberFormat = { type: /[ymdhs]/i.test(p) && !/[0#]/.test(p) ? "DATE_TIME" : "NUMBER", pattern: p };
        fields.push("userEnteredFormat.numberFormat");
      }
      out.push({ repeatCell: { range: grid(o.range), cell: { userEnteredFormat: format }, fields: fields.join(",") } });
    } else if (o.op === "sort") {
      out.push({ sortRange: { range: grid(o.range), sortSpecs: (o.by as { col: string; desc: boolean }[]).map((k) => ({ dimensionIndex: colNumber(k.col) - 1, sortOrder: k.desc ? "DESCENDING" : "ASCENDING" })) } });
    } else if (o.op === "filter") {
      out.push({ setBasicFilter: { filter: { range: grid(o.range) } } });
    } else if (o.op === "clear_filter") {
      out.push({ clearBasicFilter: { sheetId: tabId(o.tab as string | undefined) } });
    } else if (o.op === "freeze") {
      const gp: J = {};
      if (o.rows !== undefined) gp.frozenRowCount = o.rows;
      if (o.cols !== undefined) gp.frozenColumnCount = o.cols;
      out.push({ updateSheetProperties: { properties: { sheetId: tabId(o.tab as string | undefined), gridProperties: gp }, fields: Object.keys(gp).map((k) => `gridProperties.${k}`).join(",") } });
    } else if (o.op === "column_width" || o.op === "row_height") {
      const start = Number(o.start) - 1;
      const range = { sheetId: tabId(o.tab as string | undefined), dimension: o.op === "column_width" ? "COLUMNS" : "ROWS", startIndex: start, endIndex: start + Number(o.count) };
      const size = o.op === "column_width" ? o.width : o.height;
      out.push(size === "auto" ? { autoResizeDimensions: { dimensions: range } } : { updateDimensionProperties: { range, properties: { pixelSize: size }, fields: "pixelSize" } });
    } else if (o.op === "borders") {
      const border = o.style === "none" ? { style: "NONE" } : { style: String(o.style).toUpperCase(), colorStyle: { rgbColor: rgb(o.color) } };
      const sideKey: Record<string, string> = { top: "top", bottom: "bottom", left: "left", right: "right", inner_horizontal: "innerHorizontal", inner_vertical: "innerVertical" };
      out.push({ updateBorders: { range: grid(o.range), ...Object.fromEntries((o.sides as string[]).map((x) => [sideKey[x], border])) } });
    } else if (o.op === "merge") {
      out.push({ mergeCells: { range: grid(o.range), mergeType: o.how === "rows" ? "MERGE_ROWS" : o.how === "columns" ? "MERGE_COLUMNS" : "MERGE_ALL" } });
    } else if (o.op === "unmerge") {
      out.push({ unmergeCells: { range: grid(o.range) } });
    } else if (o.op === "find_replace") {
      const where = o.range !== undefined ? { range: grid(o.range) } : o.tab !== undefined ? { sheetId: tabId(String(o.tab)) } : { allSheets: true };
      out.push({ findReplace: { find: o.find, replacement: o.replace, matchCase: o.matchCase !== false, matchEntireCell: o.wholeCell === true, searchByRegex: false, includeFormulas: o.formulas === true, ...where } });
    } else if (o.op === "copy") {
      const paste: Record<string, string> = { all: "PASTE_NORMAL", values: "PASTE_VALUES", formats: "PASTE_FORMAT", formulas: "PASTE_FORMULA" };
      out.push({ copyPaste: { source: grid(o.from), destination: grid(o.to), pasteType: paste[String(o.paste)], pasteOrientation: "NORMAL" } });
    } else if (o.op === "conditional_format") {
      const [type] = CF_RULES[String(o.rule)];
      const vals = (o.values as (string | number)[] | undefined) ?? [];
      const fmt: J = {};
      if (o.background) fmt.backgroundColorStyle = { rgbColor: rgb(o.background) };
      const tf: J = {};
      if (o.color) tf.foregroundColorStyle = { rgbColor: rgb(o.color) };
      if (o.bold !== undefined) tf.bold = o.bold;
      if (o.italic !== undefined) tf.italic = o.italic;
      if (Object.keys(tf).length) fmt.textFormat = tf;
      // Added FIRST (index 0): a new rule wins over the tab's older ones, as in the Sheets editor.
      out.push({ addConditionalFormatRule: { rule: { ranges: [grid(o.range)], booleanRule: { condition: { type, ...(vals.length ? { values: vals.map((v) => ({ userEnteredValue: String(v) })) } : {}) }, format: fmt } }, index: 0 } });
    } else if (o.op === "validation") {
      out.push({ setDataValidation: { range: grid(o.range), rule: { condition: { type: "ONE_OF_LIST", values: (o.list as string[]).map((v) => ({ userEnteredValue: v })) }, strict: o.strict !== false, showCustomUi: true } } });
    } else if (o.op === "clear_validation") {
      // No rule: Sheets clears the validation of the range.
      out.push({ setDataValidation: { range: grid(o.range) } });
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
  if (state.app === "doc" && app === "doc") {
    // A table cell or row is said with what it holds NOW: "row 3" alone
    // tells the person nothing about what they are deleting.
    return ops.map(({ note: _n, ...o }) => {
      const row = typeof o.table === "number" ? state.tables?.[o.table - 1]?.rows[Number(o.row) - 1] : undefined;
      let note = "";
      if (row && o.op === "table_cell") {
        const cell = row[Number(o.col) - 1];
        if (cell) note = cell.text.trim() ? `now ${JSON.stringify(excerpt(cell.text))}` : "now empty";
      } else if (row && (o.op === "delete_table_row" || o.op === "insert_table_row")) {
        const t = row.map((c) => c.text.trim()).join(" | ");
        note = t.replace(/[ |]/g, "") ? `row ${o.row} now: ${JSON.stringify(excerpt(t))}` : `row ${o.row} is empty now`;
      }
      return (note ? { ...o, note } : o) as EditOp;
    });
  }
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
    const notesNote = () => {
      const sl = state.slides.find((x) => x.id === o.slideId);
      const n = (sl?.notes ?? "").trim();
      const where = slideNote(o.slideId);
      return where ? `${where}${n ? `; notes now ${JSON.stringify(excerpt(n))}` : "; no notes now"}` : "";
    };
    const SLIDE_OPS = ["delete_slide", "insert_image", "duplicate_slide", "add_shape", "add_table"];
    const ELEMENT_OPS = ["insert_text", "delete_text", "move", "delete_element", "table_cell", "replace_image"];
    const note =
      SLIDE_OPS.includes(o.op) ? slideNote(o.slideId)
      : o.op === "set_notes" ? notesNote()
      : o.op === "add_slide" && o.layoutId !== undefined ? layoutNote()
      : ELEMENT_OPS.includes(o.op) || (o.op === "style_text" && o.objectId !== undefined) ? elementNote(o.objectId)
      : o.op === "reorder" ? (o.slideIds as string[]).map(slideNote).filter(Boolean).join("; ")
      : "";
    return (note ? { ...o, note } : o) as EditOp;
  });
}

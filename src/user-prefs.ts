import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instanceKey } from "./paths.js";

/**
 * Personal display preferences, stored PER ACCOUNT on the server.
 *
 * They used to live only in the browser's localStorage, so they followed the
 * browser rather than the person: the same account on a phone, a second
 * browser or the desktop client started from the defaults again (light mode,
 * sound on, full rail, the tour replayed). The browser still keeps a copy — the
 * light/dark attribute must be set before the first paint, long before any
 * fetch can answer — but the server is now the authority and the copy a cache.
 *
 * Per instance, like the accounts they belong to (`src/accounts.ts`): an
 * account name only means something inside one launch directory.
 *
 * Deliberately a WHITELIST. Anything that is the device's own business (a
 * draft, the last agent opened) or the instance's (the accent palette, the
 * instance-wide mute) stays where it is; a key this file does not name is
 * dropped on write, so the store can never grow into a free-form blob a client
 * fills with whatever it likes.
 */
export interface UserPrefs {
  /** Light or dark mode. Absent = the client default (light). */
  mode?: "light" | "dark";
  /** The notification chime is off for this person (not the instance-wide mute). */
  soundMuted?: boolean;
  /** The groups column is collapsed to its icons. */
  railMini?: boolean;
  /** The guided tour has been seen (or skipped) once. */
  tourSeen?: boolean;
}

type PrefsStore = Record<string, UserPrefs>;

export function prefsFileFor(cwd: string = process.cwd()): string {
  return path.join(os.homedir(), ".shadok-ai", "prefs", instanceKey(cwd) + ".json");
}

/**
 * Keep only the known keys, each with the right type. Pure.
 * A wrong type is DROPPED rather than coerced: `"false"` read as `true` would
 * be a preference the person never chose.
 */
export function sanitizePrefs(input: unknown): UserPrefs {
  const out: UserPrefs = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  const o = input as Record<string, unknown>;
  if (o.mode === "light" || o.mode === "dark") out.mode = o.mode;
  for (const k of ["soundMuted", "railMini", "tourSeen"] as const) {
    if (typeof o[k] === "boolean") out[k] = o[k] as boolean;
  }
  return out;
}

/** A patch only adds or replaces the keys it carries; the others survive. Pure. */
export function mergePrefs(prev: UserPrefs, patch: unknown): UserPrefs {
  return { ...sanitizePrefs(prev), ...sanitizePrefs(patch) };
}

function loadStore(file: string): PrefsStore {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as PrefsStore) : {};
  } catch {
    return {};
  }
}

export function prefsFor(user: string, file: string = prefsFileFor()): UserPrefs {
  // `Object.hasOwn`, not `store[user]`: an account literally named
  // "__proto__" must read as "no preferences", not as Object.prototype.
  const store = loadStore(file);
  return Object.hasOwn(store, user) ? sanitizePrefs(store[user]) : {};
}

export function savePrefsFor(user: string, patch: unknown, file: string = prefsFileFor()): UserPrefs {
  const store = loadStore(file);
  const next = mergePrefs(Object.hasOwn(store, user) ? store[user] : {}, patch);
  // defineProperty for the same "__proto__" reason as above: a plain
  // assignment of that key would set the object's prototype instead.
  Object.defineProperty(store, user, { value: next, enumerable: true, writable: true, configurable: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

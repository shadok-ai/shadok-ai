import path from "node:path";
import { createHash } from "node:crypto";
import { MAIN_GROUP_ID } from "./groups.js";

/**
 * Where a pasted / Telegram attachment lives, per GROUP. Pure.
 *
 * Multi-tenant used to put every group's media in ONE directory under the
 * shared pot, mode 2775 group `shadok-shared` — and every `sk-*` user is in
 * that group. So any agent could read another group's screenshots, overwrite
 * them, or plant `x.png -> /root/.shadok-ai/secrets.json`, which `/media`
 * (served as root, following symlinks) then handed to the browser. The pot is
 * also group-WRITABLE with no sticky bit, so the media directory itself could
 * be renamed away and replaced.
 *
 * Now: a root-owned media ROOT outside the pot (0711 — traversable, not
 * listable), and one subdirectory per ISOLATION UNIT, `g-<key>`, owned
 * root:<that unit's OS user's group>, mode 2750. Only root writes there; only
 * that unit's user (and root) reads. Mono-tenant keeps its single flat
 * directory.
 *
 * "Per unit" rather than "per group" since external groups
 * (`src/isolation-unit.ts`): an image a stranger sends is exactly the kind of
 * thing another stranger must not read, so in an external group the directory
 * follows the conversation like everything else. Nothing changes for a group
 * unit — `g-<group id>` is the same readable name it always was.
 *
 * Invariant 60.
 */

/** Prefix of a group media subdirectory; a flat (legacy / mono) file never
 *  sits in a directory with this shape, so the two cannot be confused. */
export const MEDIA_GROUP_PREFIX = "g-";
export const MEDIA_GROUP_DIR_RE = /^g-[A-Za-z0-9_-]{1,64}$/;

/** The subdirectory name of an isolation UNIT. A unit that is already a safe
 *  name — every group id — is used as is (readable on disk: `g-main`,
 *  `g-<uuid>`); anything else is hashed rather than sanitised, because a lossy
 *  sanitising could map two units to ONE directory, the very sharing this
 *  exists to end. A conversation's unit carries a `/` and so always hashes,
 *  which is also what keeps it from ever colliding with a group's name. */
export function mediaUnitKey(unit: string | null | undefined): string {
  const id = unit || MAIN_GROUP_ID;
  if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) return MEDIA_GROUP_PREFIX + id;
  return MEDIA_GROUP_PREFIX + "h" + createHash("sha256").update(id).digest("hex").slice(0, 32);
}

/** The directory a new attachment of this unit is written to. */
export function mediaDirForUnit(root: string, unit: string | null | undefined, multiTenant: boolean): string {
  return multiTenant ? path.join(root, mediaUnitKey(unit)) : root;
}

/** Mode of a file the server writes into the media tree: the group's user reads
 *  it in multi-tenant (the directory's setgid group), only the server otherwise. */
export function mediaFileMode(multiTenant: boolean): number {
  return multiTenant ? 0o640 : 0o600;
}

/**
 * Split a `/media` request into the directory it names and the file. `key` is
 * null for a flat (legacy / mono-tenant) file. Anything that is not exactly one
 * or two plain path segments is refused (`null`).
 */
export function parseMediaRequest(segments: readonly string[]): { key: string | null; name: string } | null {
  const ok = (s: string) => !!s && s !== "." && s !== ".." && !/[/\\\0]/.test(s);
  if (segments.length === 1 && ok(segments[0])) return { key: null, name: segments[0] };
  if (segments.length === 2 && MEDIA_GROUP_DIR_RE.test(segments[0]) && ok(segments[1]))
    return { key: segments[0], name: segments[1] };
  return null;
}

/**
 * The isolation unit a media key belongs to, among the units this instance
 * knows (null if none).
 *
 * The key is a hash for everything but a plain group id, so the only way back
 * is to try the candidates — group ids, plus every live conversation of an
 * external group. Unknown stays unknown: a key nothing matches is a 404, never
 * a directory served on trust.
 */
export function unitForMediaKey(key: string, units: readonly string[]): string | null {
  for (const id of [MAIN_GROUP_ID, ...units]) if (mediaUnitKey(id) === key) return id;
  return null;
}

/** A user's primary gid from `/etc/passwd` text, or null. */
export function passwdGid(passwd: string, user: string): number | null {
  for (const line of String(passwd ?? "").split("\n")) {
    const f = line.split(":");
    if (f.length >= 4 && f[0] === user) {
      return /^\d+$/.test(f[3]) ? Number(f[3]) : null;
    }
  }
  return null;
}

/**
 * How a group media directory must look. No drop user (commons before
 * migration, whose agents run as the server) → 0700, server only. Otherwise
 * setgid 2750 on the user's group, so frames ffmpeg writes beside a video
 * inherit that group too.
 */
export function mediaDirSpec(gid: number | null): { gid: number | null; mode: number } {
  return gid == null ? { gid: null, mode: 0o700 } : { gid, mode: 0o2750 };
}

/**
 * May a directory entry found where a group media directory should be, be kept?
 * Only a real directory owned by the server. Anything else (a symlink, a file,
 * a directory an agent created while the old media dir was group-writable) is
 * moved aside and recreated — never written through.
 */
export function mediaDirTrusted(st: { isDirectory: boolean; isSymbolicLink: boolean; uid: number }, serverUid: number): boolean {
  return st.isDirectory && !st.isSymbolicLink && st.uid === serverUid;
}

/**
 * May `/media` serve this entry (from `lstat`)? A regular file, never a
 * symlink; in multi-tenant also one the SERVER wrote — a file an agent planted
 * in the old shared directory is not media anyone uploaded.
 */
export function mediaServable(
  st: { isFile: boolean; isSymbolicLink: boolean; uid: number },
  multiTenant: boolean,
  serverUid: number,
): boolean {
  if (st.isSymbolicLink || !st.isFile) return false;
  return !multiTenant || st.uid === serverUid;
}

/**
 * The `--add-dir` pair that lets an agent READ its attachments without a
 * permission prompt. A pasted or Telegram file lands in the media directory,
 * which is outside the agent's working directory, so Claude Code asked before
 * every read of a file the person had just handed over. Writing attachments
 * into the cwd instead was rejected: it litters every worktree (and a worktree
 * holding untracked files is no longer pruned on close, invariant 5) and risks
 * a commit of someone's screenshot. Empty when there is no directory to add —
 * `--add-dir` refuses a path that does not exist, and a refused flag must never
 * cost the spawn.
 */
export function mediaAddDirArgs(dir: string | null | undefined): string[] {
  return dir ? ["--add-dir", dir] : [];
}

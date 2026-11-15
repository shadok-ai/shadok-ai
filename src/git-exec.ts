import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";

/**
 * Running git from the SERVER on a repository someone else owns.
 *
 * Under multi-tenant the server is root and the checkouts it manages belong to
 * the drop users: the Tweak self-clone is chowned to `main`, an agent's worktree
 * to its group user. git (≥ 2.35.2) refuses to operate in a repository owned by
 * another user — "detected dubious ownership" — so the second click on *Tweak
 * Shadok-AI* failed on the refresh of a clone the first click had created, and
 * `isGitRepo` quietly answered `false` for the same directory (no worktree).
 *
 * The tempting fix is `-c safe.directory=<dir>`, and it is the wrong one. That
 * check exists precisely so root never runs configuration planted by another
 * user: a repo's `.git/config` can name `core.fsmonitor`, `core.sshCommand`, a
 * checkout filter or a hook, each of which git EXECUTES. The directory is
 * writable by an agent, so whitelisting it would hand any agent (or a prompt
 * injection driving one) a command run as root — across the very wall the
 * isolation builds. Instead the command is re-run AS THE REPO'S OWNER, which is
 * what git's refusal is asking for: it then executes nothing its owner could not
 * already execute.
 *
 * It is a FALLBACK on that one refusal, never the first attempt, so every
 * invocation that works today — mono-tenant, a root-owned repo, a non-root
 * server, an image that whitelists its workspace — runs exactly as before.
 */

/** Pure: is this a git "dubious ownership" refusal? */
export function isDubiousOwnership(e: unknown): boolean {
  const err = e as { stderr?: string | Buffer } | null;
  return /detected dubious ownership/i.test(String(err?.stderr ?? ""));
}

export interface Owner {
  uid: number;
  gid: number;
  name: string | null;
  home: string | null;
}

/** Pure: the passwd row for `uid` (name + home), or nulls when absent. */
export function passwdEntry(passwd: string, uid: number): { name: string | null; home: string | null } {
  for (const line of passwd.split("\n")) {
    const f = line.split(":");
    if (f.length >= 6 && Number(f[2]) === uid && f[2] !== "") return { name: f[0] || null, home: f[5] || null };
  }
  return { name: null, home: null };
}

/**
 * Pure: the `setpriv` argv + env that run `git -C cwd …args` as `owner`. Numeric
 * ids so a uid with no passwd row still works; `--init-groups` only when there is
 * a name to read the groups of, else `--clear-groups` (never root's groups).
 * HOME is the owner's: git reads `$HOME/.gitconfig`, and root's 0700 home is
 * unreadable to them. With no home known, HOME points at the repo itself rather
 * than staying `/root`.
 */
export function ownerGitCommand(
  owner: Owner,
  cwd: string,
  args: readonly string[],
): { cmd: string; argv: string[]; env: Record<string, string> } {
  const groups = owner.name ? ["--init-groups"] : ["--clear-groups"];
  const env: Record<string, string> = { HOME: owner.home ?? cwd };
  if (owner.name) Object.assign(env, { USER: owner.name, LOGNAME: owner.name });
  return {
    cmd: "setpriv",
    argv: ["--reuid", String(owner.uid), "--regid", String(owner.gid), ...groups, "--", "git", "-C", cwd, ...args],
    env,
  };
}

/** Who owns `dir`, when the server is root and that is someone else; else null. */
export function foreignOwner(dir: string): Owner | null {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return null;
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    return null;
  }
  if (st.uid === 0) return null;
  let passwd = "";
  try {
    passwd = fs.readFileSync("/etc/passwd", "utf8");
  } catch {
    /* no passwd: numeric ids only */
  }
  return { uid: st.uid, gid: st.gid, ...passwdEntry(passwd, st.uid) };
}

/**
 * `git -C cwd …args`, retried as the repository's owner when git refuses it for
 * dubious ownership (see above). Same return and throw contract as the plain
 * `execFileSync` it replaces.
 */
export function gitIn(
  cwd: string,
  args: readonly string[],
  opts: Omit<ExecFileSyncOptionsWithStringEncoding, "encoding"> = {},
): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { ...opts, encoding: "utf8" });
  } catch (e) {
    if (!isDubiousOwnership(e)) throw e;
    const owner = foreignOwner(cwd);
    if (!owner) throw e;
    const run = ownerGitCommand(owner, cwd, args);
    return execFileSync(run.cmd, run.argv, { ...opts, encoding: "utf8", env: { ...process.env, ...run.env } });
  }
}

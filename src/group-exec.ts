import { dropArgv, dropEnv, osUserFor } from "./osusers.js";
import { canSeeGroup, type Group, type Viewer } from "./groups.js";
import type { DeploymentMode } from "./capability.js";

/**
 * What the SERVER does on a group's behalf — run a cron guard, read a file an
 * agent handed over — must be done with that group's rights, never with the
 * server's. In multi-tenant the server is root, so "run it as the server" means
 * "run it as root": a cron `check` was a root shell for anyone who could reach
 * `POST /crons`, and `GET /download` streamed any root-readable file an agent
 * named. Pure, so every decision here is tested without a server, a root
 * account or a provisioned OS user (none of which a test machine has).
 *
 * Invariant 60.
 */

// ── Who may act on a session ────────────────────────────────────────────────

/**
 * May this caller schedule / edit / delete a cron on (or otherwise act for)
 * `targetId`? The HTTP twin of the WS `mayDriveSession`, with one rule more for
 * an AGENT (a request carrying a per-session key): an agent acts on itself, on a
 * sibling of its OWN group, or on a commons/public agent — never into another
 * group, whatever principal its key maps to. That keeps the rule right both
 * while the key still authenticates as the bootstrap admin and after it maps to
 * an agent principal of its own.
 *
 *  - mono-tenant: there is no wall to protect, today's behaviour (true);
 *  - a target with no channel row: refused in multi-tenant — a cron aimed at an
 *    unknown session would fire with a GUESSED directory and group;
 *  - a dangling group id: refused (fail closed, the twin of `canSeeSession`).
 */
export function mayActOnSession(input: {
  mode: DeploymentMode;
  /** The calling agent (per-session key), with its channel's group. */
  agent: { id: string; group: string | null } | null;
  viewer: Viewer | null;
  targetId: string;
  channels: readonly { sessionId: string; group?: string | null }[];
  groups: readonly Group[];
}): boolean {
  if (input.mode !== "multi-tenant") return true;
  if (!input.targetId) return false;
  const ch = input.channels.find((c) => c.sessionId === input.targetId);
  if (!ch) return false;
  return mayReachGroup({ ...input, group: ch.group ?? null, self: input.agent?.id === input.targetId });
}

/**
 * The group-level half of `mayActOnSession`, reused where the thing asked for
 * is a GROUP's rather than a session's (a media subdirectory).
 */
export function mayReachGroup(input: {
  mode: DeploymentMode;
  agent: { id: string; group: string | null } | null;
  viewer: Viewer | null;
  group: string | null;
  groups: readonly Group[];
  self?: boolean;
}): boolean {
  if (input.mode !== "multi-tenant") return true;
  if (input.self) return true;
  const g = input.group ? input.groups.find((x) => x.id === input.group) : null;
  if (input.group && !g) return false; // dangling → fail closed
  // Group-less = the commons, visible to everyone (today's rule).
  if (!g || g.nature === "public") return true;
  if (input.agent) return (input.agent.group ?? null) === g.id;
  return canSeeGroup(g, input.viewer);
}

/**
 * The OS user the server must act as for a channel of `groupId` — the SAME
 * answer as the spawn's drop user (`resolveSpawnIsolation` / `channelStateHome`):
 * the group's own `sk-*` user, else the commons user (null before migration,
 * meaning the server's own user, exactly as a commons agent runs then).
 * A group id that resolves to nothing is REFUSED, never mapped to the commons:
 * acting for a group we cannot identify is how a private job would end up
 * running with someone else's rights.
 */
export function osUserForChannelGroup(
  groupId: string | null | undefined,
  groups: readonly Group[],
  commonsUser: string | null,
): { ok: true; user: string | null } | { ok: false } {
  if (!groupId) return { ok: true, user: commonsUser };
  const g = groups.find((x) => x.id === groupId);
  if (!g) return { ok: false };
  return { ok: true, user: osUserFor(g) ?? commonsUser };
}

// ── Cron guard execution ────────────────────────────────────────────────────

/**
 * The server environment names a cron guard may inherit. An ALLOW-list on
 * purpose: the server's env holds the GUI password, the Telegram token, a
 * custom backend's key, the instance auth cookie — and a deny-list is only as
 * good as the day it was written (invariant 29's lesson about subtraction).
 * What a shell script legitimately needs from its surroundings is short:
 * where binaries are, the locale and zone, a temp dir, proxy and CA settings,
 * and the SSH fallback a container uses (`src/ssh.ts`). Its credentials come
 * from the PROFILE's secrets, like the agent's own.
 */
export const CHECK_ENV_ALLOW =
  /^(PATH|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|TMPDIR|SHELL|GIT_SSH_COMMAND|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|all_proxy)$/;

/** Identity names kept only when the guard runs as the server's own user
 *  (mono-tenant, or the commons before migration) — they are that user's. */
const SELF_IDENTITY = new Set(["HOME", "USER", "LOGNAME"]);

/**
 * The full environment of a cron guard. Layers, last wins:
 *  1. the allow-listed part of the server env (+ HOME/USER/LOGNAME when the
 *     guard runs as the server's own user — they describe that user);
 *  2. the target profile's secrets (what the check was always promised);
 *  3. the session plumbing a script needs to call back the local API
 *     (`SHADOK_SESSION_ID`/`_PORT`/`_KEY` — the agent's own, never the admin
 *     cookie `SHADOK_AUTH`);
 *  4. the drop user's HOME/USER/LOGNAME (`dropEnv`), so a dropped guard never
 *     keeps the server's `HOME=/root`.
 */
export function cronCheckEnv(input: {
  base: Record<string, string | undefined>;
  secrets: Record<string, string>;
  session: { id: string; port: string; key: string };
  user: string | null;
  home: string | null;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.base)) {
    if (v === undefined) continue;
    if (CHECK_ENV_ALLOW.test(k) || (!input.user && SELF_IDENTITY.has(k))) env[k] = v;
  }
  Object.assign(env, input.secrets);
  env.SHADOK_SESSION_ID = input.session.id;
  env.SHADOK_PORT = input.session.port;
  env.SHADOK_SESSION_KEY = input.session.key;
  Object.assign(env, dropEnv(input.user, input.home));
  return env;
}

/** The guard's command: `sh -c <check>`, wrapped in the same `setpriv` drop as
 *  an agent's spawn when there is a user to drop to. */
export function cronCheckCommand(user: string | null, check: string): { cmd: string; argv: string[] } {
  return user ? dropArgv(user, "sh", ["-c", check]) : { cmd: "sh", argv: ["-c", check] };
}

// ── Reading a file AS a group's user ────────────────────────────────────────

/**
 * `stat` as the drop user: format, size, device and inode on four lines.
 * `-L` follows a symlink — AS THAT USER, so it can only ever reach what the
 * user could read anyway; the identity of what it reached is what the offer
 * records and the download compares.
 */
export function statAsUserArgv(user: string, p: string): { cmd: string; argv: string[] } {
  return dropArgv(user, "stat", ["-L", "--printf=%F\\n%s\\n%d\\n%i\\n", "--", p]);
}

export interface FileIdentity {
  isFile: boolean;
  size: number;
  dev: number;
  ino: number;
}

/** Parse `statAsUserArgv`'s output; null on anything unexpected. */
export function parseStatOutput(out: string): FileIdentity | null {
  const [kind, size, dev, ino] = String(out ?? "").split("\n");
  const n = [Number(size), Number(dev), Number(ino)];
  if (!kind || n.some((x) => !Number.isFinite(x) || x < 0)) return null;
  return { isFile: /^regular( empty)? file$/.test(kind.trim()), size: n[0], dev: n[1], ino: n[2] };
}

/**
 * Stream the bytes AS the drop user: `dd` opens the file with that user's
 * rights, so a path an agent named can never be turned into a root read — not
 * by naming `/root/...`, not by swapping a symlink after the offer. Optional
 * byte range (inclusive), for the `<video>` seek path.
 */
export function readAsUserArgv(
  user: string,
  p: string,
  range?: { start: number; end: number } | null,
): { cmd: string; argv: string[] } {
  const ops = [`if=${p}`, "bs=65536", "status=none"];
  if (range) ops.push("iflag=skip_bytes,count_bytes,fullblock", `skip=${range.start}`, `count=${range.end - range.start + 1}`);
  return dropArgv(user, "dd", ops);
}

/**
 * Is the file about to be served the one that was OFFERED? An offer records
 * device + inode; a later symlink swap, rename or replacement changes them.
 * An offer from before this check (no identity recorded) is not refused.
 */
export function sameOfferedFile(
  offered: { dev?: number; ino?: number } | undefined,
  now: { dev: number; ino: number },
): boolean {
  if (!offered || offered.dev === undefined || offered.ino === undefined) return true;
  return offered.dev === now.dev && offered.ino === now.ino;
}

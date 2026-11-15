import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Group } from "./groups.js";

/**
 * Persistent per-container SSH identity.
 *
 * When shadok-ai runs in a Docker container, agents need an SSH key to reach
 * private git repos and servers — and that key must survive `docker restart`
 * AND `docker rm`+recreate. The trick: store it on the ONE volume already
 * mounted in production (`shadok-data → /root/.shadok-ai`), never on the
 * ephemeral `/root/.ssh`. So `ensureSshIdentity` generates the key under
 * `~/.shadok-ai/ssh` and points `~/.ssh` at it.
 *
 * On a normal host (no `/.dockerenv`) this is a NO-OP: we never read, move, or
 * symlink the developer's `~/.ssh`. See
 * docs/superpowers/specs/2026-08-04-docker-ssh-identity-design.md.
 */

export interface SshPaths {
  /** The persistent SSH dir on the shadok-data volume. */
  dir: string;
  key: string;
  pub: string;
  config: string;
  knownHosts: string;
  /** The conventional `~/.ssh` we wire to `dir`. */
  dotSsh: string;
}

/** Pure: every path derived from a home directory. */
export function sshPaths(home: string): SshPaths {
  const dir = path.join(home, ".shadok-ai", "ssh");
  return {
    dir,
    key: path.join(dir, "id_ed25519"),
    pub: path.join(dir, "id_ed25519.pub"),
    config: path.join(dir, "config"),
    knownHosts: path.join(dir, "known_hosts"),
    dotSsh: path.join(home, ".ssh"),
  };
}

/** A keypair on the shadok-data VOLUME, and whether it is the shared one. */
export interface VolumeKeyPaths {
  dir: string;
  key: string;
  pub: string;
  /** Is this the cockpit's HISTORICAL identity, shared by every public group? */
  shared: boolean;
}

/**
 * Where a drop user's keypair lives ON THE VOLUME — the one place that survives a
 * `docker rm` + recreate, which wipes `/home` and with it every agent HOME copy.
 *
 * The split is the operator's decision (2026-11-03): the COMMONS reuses the
 * container's HISTORICAL key, because that is the identity already registered on
 * the forge, while each ISOLATED group gets its OWN key under `groups/<os-user>/`.
 * A public group has no OS user of its own — its agents run as the commons user —
 * so it resolves to the shared key, and so does every group on a mono-tenant
 * instance, where there is exactly one identity for the whole cockpit.
 *
 * Pure, and shared by the two sides that must never disagree: the provisioner
 * that MINTS the keypair and copies it into an agent's HOME, and the endpoint
 * that shows the public line to register. When those were two inline ternaries,
 * nothing stopped one from reading a directory the other never wrote.
 */
export function volumeKeyPaths(serverHome: string, user: string | null, commonsUser: string | null): VolumeKeyPaths {
  const base = sshPaths(serverHome).dir;
  const shared = !user || user === commonsUser;
  const dir = shared ? base : path.join(base, "groups", user);
  return { dir, key: path.join(dir, "id_ed25519"), pub: path.join(dir, "id_ed25519.pub"), shared };
}

/** One group's SSH identity, as the operator needs to read it. */
export interface GroupKeyRow {
  group: string;
  name: string;
  /** The OS user this group's agents run as — the commons user for a public
   *  group, `null` on a mono-tenant instance (they run as the server's own). */
  osUser: string | null;
  /** The OpenSSH public line to register on the forge, or `null` when no keypair
   *  exists YET — an honest "not provisioned", never an empty string that reads
   *  like a key with no content. */
  publicKey: string | null;
  /** True when this is the cockpit's shared historical identity rather than a
   *  key of this group's own: registering it once covers every public group. */
  shared: boolean;
}

/**
 * The public keys an operator has to register for the groups they can see.
 *
 * PURE over an injected `readPub`, so the visibility rule and the "no key yet"
 * case are tested without a filesystem. The CALLER does the row filtering
 * (`listableGroups`), exactly as `GET /groups` does: a private group stays
 * invisible even to an admin (operator decision 2026-11-03), and a public key is
 * not a reason to widen that — the roster and the group's very existence are
 * what the filter protects.
 */
export function groupKeyRows(
  groups: readonly Group[],
  deps: {
    serverHome: string;
    commonsUser: string | null;
    osUserFor: (g: Group) => string | null;
    readPub: (p: string) => string | null;
  },
): GroupKeyRow[] {
  return groups.map((g) => {
    const own = deps.osUserFor(g);
    const user = own ?? deps.commonsUser;
    const p = volumeKeyPaths(deps.serverHome, user, deps.commonsUser);
    const line = deps.readPub(p.pub);
    return {
      group: g.id,
      name: g.name,
      osUser: user,
      publicKey: line && line.trim() ? line.trim() : null,
      shared: p.shared,
    };
  });
}

/**
 * Are we inside a container? `/.dockerenv` exists in every Docker container.
 * `SHADOK_SSH_IDENTITY=0` disables the feature entirely;
 * `SHADOK_FORCE_SSH_IDENTITY=1` forces it on (tests / non-Docker containers).
 */
export function inContainer(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
): boolean {
  if (env.SHADOK_SSH_IDENTITY === "0") return false;
  if (env.SHADOK_FORCE_SSH_IDENTITY === "1") return true;
  return exists("/.dockerenv");
}

/** The observable state of `~/.ssh`, so the wiring decision stays pure. */
export type DotSshState =
  | "absent"
  | "our-symlink" // already a symlink to our persistent dir
  | "foreign-symlink" // a symlink elsewhere
  | "real-dir" // a real directory (maybe baked into the image)
  | "other"; // a file, socket, … — leave it alone

export type DotSshPlan = "symlink" | "migrate-then-symlink" | "leave";

/** Pure: what to do with `~/.ssh` given its current state. */
export function planDotSshWiring(state: DotSshState): DotSshPlan {
  switch (state) {
    case "absent":
      return "symlink";
    case "our-symlink":
      return "leave";
    case "foreign-symlink":
    case "real-dir":
      return "migrate-then-symlink";
    default:
      return "leave";
  }
}

const CONFIG_BODY = [
  "# Managed by shadok-ai (Docker SSH identity). Persistent on the shadok-data volume.",
  "Host *",
  "  StrictHostKeyChecking accept-new",
  "  UserKnownHostsFile ~/.shadok-ai/ssh/known_hosts",
  "  IdentityFile ~/.shadok-ai/ssh/id_ed25519",
  "  IdentitiesOnly yes",
  "",
].join("\n");

function classifyDotSsh(p: SshPaths): DotSshState {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p.dotSsh);
  } catch {
    return "absent";
  }
  if (st.isSymbolicLink()) {
    try {
      return fs.realpathSync(p.dotSsh) === fs.realpathSync(p.dir) ? "our-symlink" : "foreign-symlink";
    } catch {
      return "foreign-symlink";
    }
  }
  return st.isDirectory() ? "real-dir" : "other";
}

/**
 * Move every entry from a real `~/.ssh` into the persistent dir WITHOUT
 * overwriting anything already there (the key/config we just wrote win), then
 * replace `~/.ssh` with a symlink. Never deletes a user file. On any error the
 * caller keeps `~/.ssh` untouched and falls back to GIT_SSH_COMMAND.
 */
function migrateDotSsh(p: SshPaths): void {
  for (const name of fs.readdirSync(p.dotSsh)) {
    const from = path.join(p.dotSsh, name);
    const to = path.join(p.dir, name);
    if (fs.existsSync(to)) continue; // don't clobber our managed files
    fs.renameSync(from, to);
  }
  // The source dir should now only hold files we already had; drop it if empty,
  // otherwise move it aside rather than lose anything.
  try {
    fs.rmdirSync(p.dotSsh);
  } catch {
    fs.renameSync(p.dotSsh, p.dotSsh + ".shadok-bak");
  }
  fs.symlinkSync(p.dir, p.dotSsh);
}

export interface EnsureOpts {
  home?: string;
  isContainer?: boolean;
  log?: (msg: string) => void;
  /** Injected for tests; defaults to the real keygen. */
  keygen?: (p: SshPaths, comment: string) => void;
  env?: NodeJS.ProcessEnv;
}

function realKeygen(p: SshPaths, comment: string): void {
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", p.key, "-C", comment], {
    stdio: "ignore",
  });
}

/**
 * Ensure a persistent SSH identity exists and `~/.ssh` uses it — but ONLY in a
 * container. Idempotent and best-effort: it never throws into the boot path.
 * Returns the exported env for spawned agents (a GIT_SSH_COMMAND fallback) or
 * `{}` when it did nothing.
 */
export function ensureSshIdentity(opts: EnsureOpts = {}): Record<string, string> {
  const env = opts.env ?? process.env;
  const isContainer = opts.isContainer ?? inContainer(env);
  if (!isContainer) return {};

  const home = opts.home ?? os.homedir();
  const log = opts.log ?? ((m: string) => console.log(m));
  const keygen = opts.keygen ?? realKeygen;
  const p = sshPaths(home);

  try {
    fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(p.dir, 0o700);

    if (!fs.existsSync(p.key)) {
      const comment = `shadok-${os.hostname()}`;
      keygen(p, comment);
      log(`ssh: generated a persistent identity (${comment})`);
    }
    // Perms may be lost across a volume restore; assert them every boot.
    if (fs.existsSync(p.key)) fs.chmodSync(p.key, 0o600);
    if (fs.existsSync(p.pub)) fs.chmodSync(p.pub, 0o644);

    if (!fs.existsSync(p.config)) fs.writeFileSync(p.config, CONFIG_BODY, { mode: 0o600 });
    if (!fs.existsSync(p.knownHosts)) fs.writeFileSync(p.knownHosts, "", { mode: 0o600 });

    // Wire ~/.ssh to the persistent dir.
    const plan = planDotSshWiring(classifyDotSsh(p));
    try {
      if (plan === "symlink") fs.symlinkSync(p.dir, p.dotSsh);
      else if (plan === "migrate-then-symlink") migrateDotSsh(p);
    } catch (e) {
      log(`ssh: kept ~/.ssh as-is (${(e as Error).message}); using GIT_SSH_COMMAND fallback`);
    }

    if (fs.existsSync(p.pub)) {
      log(`ssh identity: ${fs.readFileSync(p.pub, "utf8").trim()}`);
    }

    // Belt-and-suspenders: even if ~/.ssh could not be wired, git uses our key.
    return { GIT_SSH_COMMAND: `ssh -F ${p.config}` };
  } catch (e) {
    log(`ssh: identity setup skipped (${(e as Error).message})`);
    return {};
  }
}

import fs from "node:fs";
import path from "node:path";

const CLAUDE_PKG = "@anthropic-ai/claude-code";

/**
 * Search `PATH` for the executable `name`, returning its absolute path or null.
 * An argument that already looks like a path is checked as-is. Pure over
 * (name, env, exists) — inject `exists` in tests.
 */
export function resolveBin(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = isExecutable,
): string | null {
  if (name.includes("/") || name.includes("\\")) return exists(name) ? name : null;
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e);
      if (exists(p)) return p;
    }
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The npm placeholder
// ---------------------------------------------------------------------------
//
// Since the split packaging (verified on 2.1.250), `@anthropic-ai/claude-code`
// ships `bin/claude.exe` as a 500-byte shell PLACEHOLDER, and its postinstall
// (`install.cjs`) hardlinks the ~223 MB native binary from the platform
// optional dependency over it. The placeholder is mode 0755, so it satisfies
// `X_OK` exactly like the real thing — `resolveBin` cannot tell them apart, and
// running it just prints "Error: claude native binary not installed." and exits
// 1. That is the opaque death a spawn used to inherit.
//
// It is not only the `--ignore-scripts` / `--omit=optional` case. `placeBinary`
// in install.cjs UNLINKS the destination before relinking, and restores the
// placeholder if the copy fails, so EVERY claude-code upgrade opens a window in
// which the launcher path is either absent or the placeholder again. Measured
// on this machine: sampling every 2 s for a minute during an upgrade, 1 sample
// in 30 was broken, and one direct `claude --version` answered "No such file or
// directory" while `/usr/local/bin/claude` plainly existed (a symlink onto the
// launcher mid-rewrite). Anthropic acknowledged a cousin of this in the 2.1.246
// CHANGELOG ("background sessions failing ... EACCES when another Claude Code
// process was re-installing the npm package at that moment") and fixed it for
// their own sessions; we had no equivalent.

/** Bytes read to classify a launcher. The whole placeholder is 500 B. */
export const BIN_HEAD_BYTES = 512;

/**
 * Above this, a file cannot be the placeholder. `install.cjs` uses the same
 * order of magnitude (`statSync(dest).size < 4096`) to recognise its own stub.
 */
const STUB_MAX_BYTES = 4096;

/** Verbatim from the placeholder's first line — the one thing only it says. */
const STUB_MARKER = "native binary not installed";

export type BinKind = "usable" | "stub" | "missing";

/** What a cheap look at a launcher file yields: its size and its first bytes. */
export interface BinSample {
  size: number;
  head: string;
}

/**
 * Tell the npm placeholder from something we can actually run. Pure.
 *
 * Deliberately CONSERVATIVE: it condemns only what it positively recognises as
 * the placeholder, and calls everything else usable. The tempting rule — "a
 * real claude is an ELF/Mach-O of hundreds of MB, so anything else is broken" —
 * would also condemn every legitimate small launcher: pnpm's shell shim,
 * volta/asdf/mise shims, npm's `.cmd` shim on Windows, a user's own wrapper.
 * Those work fine, and refusing to spawn them would be a worse bug than the one
 * this fixes. Same rule as invariant 27: assert only what you observed.
 *
 * No execution probe. Running `claude --version` before each spawn would cost a
 * process launch per session start, and it would not even be sound: the answer
 * is stale the moment it returns, and the window this guards against is
 * milliseconds wide. A stat plus a 512-byte read costs microseconds and is
 * exactly as (un)raceable, so it buys the safety at none of the price.
 */
export function classifyBin(sample: BinSample | null): BinKind {
  if (!sample) return "missing";
  if (sample.size < STUB_MAX_BYTES && sample.head.includes(STUB_MARKER)) return "stub";
  return "usable";
}

/** Read the first {@link BIN_HEAD_BYTES} of a file, or null if it isn't there. */
export function sampleBin(p: string): BinSample | null {
  let fd: number | null = null;
  try {
    const size = fs.statSync(p).size;
    // A multi-hundred-MB binary is never the placeholder: skip the read.
    if (size >= STUB_MAX_BYTES) return { size, head: "" };
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(Math.min(size, BIN_HEAD_BYTES));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return { size, head: buf.subarray(0, read).toString("latin1") };
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* nothing to do */ }
  }
}

// ---------------------------------------------------------------------------
// The native binary behind the placeholder
// ---------------------------------------------------------------------------

/**
 * The optional dependency holding the native binary for a platform, mirroring
 * the PLATFORMS map of `install.cjs`. Returns null for a platform the package
 * does not publish — the caller then has no fallback, which is the truth.
 */
export function platformPkg(
  platform: string,
  arch: string,
  musl = false,
): { pkg: string; bin: string } | null {
  const win = platform === "win32";
  const key =
    platform === "linux" ? `linux-${arch}${musl ? "-musl" : ""}` : `${platform}-${arch}`;
  const known = new Set([
    "darwin-arm64", "darwin-x64",
    "linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl",
    "win32-x64", "win32-arm64",
  ]);
  if (!known.has(key)) return null;
  return { pkg: `${CLAUDE_PKG}-${key}`, bin: win ? "claude.exe" : "claude" };
}

/**
 * Where the native binary may sit, given the REAL path of the launcher
 * (`.../@anthropic-ai/claude-code/bin/claude.exe`). Pure: it only builds
 * candidates, the caller decides which one exists.
 *
 * The `node_modules` walk is not decoration. npm hoists an optional dependency
 * to the top level as readily as it nests it, and the layout differs between a
 * global install, `npx`, and the managed `~/.shadok-ai/app`. Assuming the nested
 * layout is precisely the mistake that made `node-pty-fix.ts`'s chmod silently
 * miss on every non-dev install (see CLAUDE.md) — so we reproduce node's own
 * resolution instead: every ancestor directory, each with `node_modules/<pkg>`.
 */
export function nativeBinCandidates(launcherRealPath: string, pkg: string, bin: string): string[] {
  const pkgDir = path.dirname(path.dirname(launcherRealPath));
  const out: string[] = [];
  let dir = pkgDir;
  for (;;) {
    // `path.basename(dir) === "node_modules"` would skip the nested case, which
    // is the layout npm actually produced here — take every ancestor.
    out.push(path.join(dir, "node_modules", pkg, bin));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type ClaudeBin =
  | { ok: true; path: string; via: "launcher" | "native" }
  | { ok: false; reason: "missing" | "stub" };

export interface FindClaudeDeps {
  /** Find the launcher now (typically resolveBin("claude")). */
  resolve: () => string | null;
  /** Follow symlinks (typically fs.realpathSync); may throw, caller guards. */
  realpath: (p: string) => string;
  /** Cheap look at a file (typically sampleBin). */
  sample: (p: string) => BinSample | null;
  platform: string;
  arch: string;
  musl: boolean;
}

/**
 * Resolve a claude we can actually run: the launcher when it is real, else the
 * native binary the launcher is only a placeholder for. Pure over injected
 * deps, so the whole decision is unit-tested without touching the real FS.
 */
export function findClaudeBin(deps: FindClaudeDeps): ClaudeBin {
  const launcher = deps.resolve();
  if (!launcher) return { ok: false, reason: "missing" };
  if (classifyBin(deps.sample(launcher)) === "usable") return { ok: true, path: launcher, via: "launcher" };

  // The launcher is the placeholder. The native binary is usually right there
  // in the package's own tree — the postinstall just has not copied it over
  // yet, or is mid-copy. Going straight to it turns a hard failure into a spawn
  // that works, which is what `cli-wrapper.cjs` does for the same reason.
  const info = platformPkg(deps.platform, deps.arch, deps.musl);
  if (info) {
    let real = launcher;
    try {
      real = deps.realpath(launcher);
    } catch {
      // A launcher we cannot realpath is still a launcher: candidates built
      // from the symlink itself are worth trying before giving up.
    }
    for (const c of nativeBinCandidates(real, info.pkg, info.bin)) {
      if (classifyBin(deps.sample(c)) === "usable") return { ok: true, path: c, via: "native" };
    }
  }
  return { ok: false, reason: "stub" };
}

export interface RetryOptions {
  /** Total attempts, including the first. */
  tries?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * {@link findClaudeBin}, retried briefly. The failure this guards is a
 * TRANSIENT window in someone else's postinstall (unlink → relink), so a hard
 * refusal on the first look would report a healthy install as broken. Bounded
 * on purpose — a couple of seconds at worst, and only on the spawn path, never
 * at boot (same rule as `ensureTmux` / `ensureSshIdentity`: nothing here may
 * hold the server back from serving).
 */
export async function findClaudeBinWithRetry(
  deps: FindClaudeDeps,
  opts: RetryOptions = {},
): Promise<ClaudeBin> {
  const tries = Math.max(1, opts.tries ?? 6);
  const delayMs = opts.delayMs ?? 250;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: ClaudeBin = { ok: false, reason: "missing" };
  for (let i = 0; i < tries; i++) {
    last = findClaudeBin(deps);
    if (last.ok) return last;
    if (i < tries - 1) await sleep(delayMs);
  }
  return last;
}

/** Live deps for {@link findClaudeBin}, reading the real filesystem. */
export function liveClaudeDeps(): FindClaudeDeps {
  return {
    resolve: () => resolveBin("claude"),
    realpath: (p) => fs.realpathSync(p),
    sample: sampleBin,
    platform: process.platform,
    arch: process.arch,
    musl: isMusl(),
  };
}

/**
 * Same test `install.cjs` uses: `glibcVersionRuntime` is absent from the Node
 * report on musl. Cheaper and more reliable than shelling out to `ldd`.
 */
function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const report = typeof process.report?.getReport === "function" ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }) : null;
    return report != null && report.header?.glibcVersionRuntime === undefined;
  } catch {
    return false;
  }
}

// The binary EVERY claude spawn goes through — the pilots, the auth probe, the
// sign-in, the version probe. Before this they each spawned the bare name
// `claude`, which is the placeholder whenever the postinstall has not landed:
// four subsystems failing at once, each with its own opaque symptom.
let cachedBin: string | null = null;

/**
 * The claude to spawn. The resolved binary when we have one — which is NOT
 * always the launcher, see {@link findClaudeBin} — else the bare name, so a
 * layout we failed to understand behaves exactly as it did before.
 *
 * Re-validated on each call: a cached path rots the moment claude-code
 * upgrades, and one stat is a rounding error next to the process spawn every
 * caller is about to pay for.
 */
export function claudeCommand(): string {
  if (cachedBin && classifyBin(sampleBin(cachedBin)) === "usable") return cachedBin;
  const r = findClaudeBin(liveClaudeDeps());
  cachedBin = r.ok ? r.path : null;
  return cachedBin ?? "claude";
}

/** Record a path already resolved (by `ensureClaude`), so we don't look twice. */
export function rememberClaudeBin(p: string | null): void {
  cachedBin = p;
}

/** The manual-install fallback message, shown when the auto-install can't help. */
export function claudeMissingMessage(detail: string): string {
  return (
    `Claude Code CLI ('claude') is required and ${detail}. ` +
    `Install it manually: npm i -g ${CLAUDE_PKG} — then run 'claude' once to sign in to your Claude account. ` +
    `shadok-ai drives claude on your own subscription, so that one-time sign-in is unavoidable.`
  );
}

/**
 * Why a spawn was refused when `claude` IS on PATH. The point is to say what is
 * wrong instead of letting a bare `posix_spawnp failed` — or the placeholder's
 * own exit 1 — reach the user, in the spirit of `describeStuckScreen`.
 */
export function claudeStubMessage(): string {
  return (
    `Claude Code CLI ('claude') is on PATH but it is the npm fallback placeholder, ` +
    `not the real binary: the native package (${CLAUDE_PKG}-<platform>) was not installed, ` +
    `or an upgrade is rewriting the launcher right now. ` +
    `If it does not clear on its own, reinstall without --ignore-scripts / --omit=optional, ` +
    `or run the postinstall by hand: node <path-to>/${CLAUDE_PKG}/install.cjs`
  );
}

export interface EnsureClaudeDeps {
  /** Locate a RUNNABLE claude now. Called again after an install. */
  find: () => Promise<ClaudeBin>;
  /** Perform the global install (typically `npm i -g @anthropic-ai/claude-code`). */
  install: () => Promise<void>;
  /** Surface progress (server log / a line to the client). */
  notify: (line: string) => void;
}

export type EnsureClaudeResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Make a runnable claude CLI available, installing it ONCE if it is missing.
 * Returns the path to spawn — which is NOT always the launcher: when the
 * launcher is the placeholder we hand back the native binary behind it.
 * Otherwise a clear, actionable error, never the raw `posix_spawnp failed` a
 * bare spawn would throw, and never the placeholder's opaque exit 1.
 *
 * A placeholder is NOT a reason to reinstall: the package is plainly installed,
 * so `npm i -g` would neither be the missing-CLI case nor a safe move while
 * someone else's postinstall is mid-rewrite. We say what is wrong instead.
 */
export async function ensureClaude(deps: EnsureClaudeDeps): Promise<EnsureClaudeResult> {
  const found = await deps.find();
  if (found.ok) return { ok: true, path: found.path };
  if (found.reason === "stub") return { ok: false, error: claudeStubMessage() };

  deps.notify(`Claude Code CLI not found — installing ${CLAUDE_PKG} (one-time, this can take a minute)…`);
  try {
    await deps.install();
  } catch (e) {
    return { ok: false, error: claudeMissingMessage(`installing it failed (${e instanceof Error ? e.message : String(e)})`) };
  }

  const after = await deps.find();
  if (after.ok) {
    deps.notify("Claude Code CLI installed. You'll be asked to sign in to your Claude account on first use.");
    return { ok: true, path: after.path };
  }
  if (after.reason === "stub") return { ok: false, error: claudeStubMessage() };
  return { ok: false, error: claudeMissingMessage("it was installed but 'claude' is still not on PATH") };
}

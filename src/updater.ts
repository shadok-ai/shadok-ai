import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { SHADOK_DIR } from "./config.js";
import { isNewer } from "./version.js";
import { TAG_FOR, pickTarget, type UpdateChannel } from "./update-channel.js";

const pexec = promisify(execFile);

/**
 * The server runs from a managed install at ~/.shadok-ai/app so that `/update`
 * can refresh just the server (npm i shadok-ai@latest there) while the
 * supervisor — launched from the npx cache — keeps running.
 */
export const APP_DIR = path.join(SHADOK_DIR, "app");
const PKG = "shadok-ai";

/** Absolute path to the installed server entry point. */
export function serverEntry(): string {
  return path.join(APP_DIR, "node_modules", PKG, "dist", "server.js");
}

/** Version of the currently installed managed server, or null if absent. */
export function installedVersion(): string | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(APP_DIR, "node_modules", PKG, "package.json"), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * What a dist-tag currently resolves to, or null if the lookup failed.
 * Best-effort: callers treat null as "couldn't check, try again later" — never
 * as "there is nothing published".
 */
async function tagVersion(tag: string): Promise<string | null> {
  try {
    const { stdout } = await pexec("npm", ["view", `${PKG}@${tag}`, "version"], {
      timeout: 30_000,
    });
    const v = stdout.trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * The version this instance should be running, for its channel.
 *
 * Beta reads `latest`; alpha reads `alpha` but never accepts a version older
 * than `latest` — see `pickTarget` for the promotion window that rule exists
 * for. The two lookups run together: they are independent, and doing them in
 * sequence would double the poll's latency for no reason.
 */
export async function latestVersion(channel: UpdateChannel = "beta"): Promise<string | null> {
  if (channel === "beta") return tagVersion(TAG_FOR.beta);
  const [alpha, latest] = await Promise.all([tagVersion(TAG_FOR.alpha), tagVersion(TAG_FOR.beta)]);
  return pickTarget(channel, { alpha, latest }, isNewer);
}

/**
 * The ONLY packages whose install scripts we run, and only through an explicit
 * `npm rebuild <name>` after the install.
 *
 * The install itself runs with `--ignore-scripts`: every instance updates itself
 * within minutes of a publish, as root in Docker, so a compromised transitive
 * dependency's `postinstall` would otherwise execute fleet-wide. node-pty is the
 * one dependency that needs a script — it ships no Linux prebuild, so its
 * `install` compiles `pty.node` with node-gyp. Its `postinstall` only tidies
 * `build/Release` (and copies conpty on Windows), and shadok-ai's own
 * `postinstall` chmod is redone at boot by `ensureSpawnHelperExecutable`.
 * Adding a package here is a security decision: say why in the same commit.
 */
export const SCRIPT_ALLOWLIST = ["node-pty"] as const;

/** Pure: the argv of the install. Exact version, never a tag (see below). */
export function installArgs(version: string, prefix: string): string[] {
  // --prefix installs into <prefix>/node_modules; no package.json needed there.
  return ["install", `${PKG}@${version}`, "--prefix", prefix, "--no-audit", "--no-fund", "--ignore-scripts"];
}

/** Pure: the argv that runs the allowlisted scripts. `--ignore-scripts=false`
 *  so an `ignore-scripts=true` in someone's npmrc cannot turn the build into a
 *  silent no-op that leaves node-pty unloadable. */
export function rebuildArgs(prefix: string): string[] {
  return ["rebuild", ...SCRIPT_ALLOWLIST, "--prefix", prefix, "--ignore-scripts=false", "--no-audit", "--no-fund"];
}

/**
 * Pure: is there an installed node-pty with no native module for this machine?
 *
 * Mirrors node-pty's own loader (`build/Release`, then
 * `prebuilds/<platform>-<arch>`). An UNCHANGED node-pty is not touched by npm on
 * update, so its earlier build survives and no compiler is needed — exactly the
 * old behaviour. Both placements are checked: hoisted, and nested under
 * shadok-ai, which is where a shrinkwrapped dependency may land.
 */
export function needsNativeRebuild(
  prefix: string,
  platform: string,
  arch: string,
  exists: (p: string) => boolean,
): boolean {
  const roots = [
    path.join(prefix, "node_modules", "node-pty"),
    path.join(prefix, "node_modules", PKG, "node_modules", "node-pty"),
  ];
  return roots.some((r) =>
    exists(path.join(r, "package.json"))
    && !exists(path.join(r, "build", "Release", "pty.node"))
    && !exists(path.join(r, "prebuilds", `${platform}-${arch}`, "pty.node")));
}

export interface InstallDeps {
  npm: (args: string[]) => Promise<void>;
  platform: string;
  arch: string;
}

const realNpm = async (args: string[]): Promise<void> => {
  await pexec("npm", args, { timeout: 5 * 60_000 });
};

/**
 * Install `version` into `appDir` — staged, so a failure changes nothing.
 *
 * Before scripts were turned off, a failed node-pty build failed `npm install`
 * and npm rolled the tree back. With the build now a separate step, an in-place
 * install would leave a NEW shadok-ai beside an UNBUILT node-pty on a failed
 * compile — and the next respawn would crash on import. So the install happens
 * in a copy of the current tree (cheap: same node_modules, npm only reifies what
 * changed), and the copy replaces the live one only once node-pty loads.
 */
export async function installInto(appDir: string, version: string, deps: InstallDeps): Promise<void> {
  const stage = `${appDir}.staging`;
  const old = `${appDir}.previous`;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });
  try {
    if (fs.existsSync(appDir)) {
      // verbatimSymlinks: node_modules/.bin holds RELATIVE links; resolving them
      // would point the copy back into the tree we are about to retire.
      fs.cpSync(appDir, stage, { recursive: true, verbatimSymlinks: true });
    } else {
      fs.mkdirSync(stage, { recursive: true });
    }
    await deps.npm(installArgs(version, stage));
    if (needsNativeRebuild(stage, deps.platform, deps.arch, fs.existsSync)) {
      await deps.npm(rebuildArgs(stage));
      if (needsNativeRebuild(stage, deps.platform, deps.arch, fs.existsSync)) {
        throw new Error("node-pty rebuilt but no native module was produced");
      }
    }
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
  if (fs.existsSync(appDir)) fs.renameSync(appDir, old);
  fs.renameSync(stage, appDir);
  fs.rmSync(old, { recursive: true, force: true });
}

/**
 * Install an EXACT version, not a tag.
 *
 * The caller already resolved the target (and, on the alpha channel, may have
 * picked `latest` over `alpha`); re-resolving a tag here could install a
 * different build than the one we decided to move to, and on alpha it could
 * silently undo that choice. Transitive versions are pinned by the
 * npm-shrinkwrap.json the package is published with (publish.yml).
 */
async function npmInstallVersion(version: string): Promise<void> {
  fs.mkdirSync(path.dirname(APP_DIR), { recursive: true });
  await installInto(APP_DIR, version, { npm: realNpm, platform: process.platform, arch: process.arch });
}

/** Install the given server version; report what landed (or the failure). */
export async function update(version: string): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    await npmInstallVersion(version);
    return { ok: true, version: installedVersion() ?? "unknown" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

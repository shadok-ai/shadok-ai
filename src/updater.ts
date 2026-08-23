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
 * Install an EXACT version, not a tag.
 *
 * The caller already resolved the target (and, on the alpha channel, may have
 * picked `latest` over `alpha`); re-resolving a tag here could install a
 * different build than the one we decided to move to, and on alpha it could
 * silently undo that choice.
 */
async function npmInstallVersion(version: string): Promise<void> {
  fs.mkdirSync(APP_DIR, { recursive: true });
  // --prefix installs into APP_DIR/node_modules; no package.json needed there.
  await pexec("npm", ["install", `${PKG}@${version}`, "--prefix", APP_DIR, "--no-audit", "--no-fund"], {
    timeout: 5 * 60_000,
  });
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

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { SHADOK_DIR } from "./config.js";

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
 * Latest version published on npm, or null if the network/registry lookup
 * fails. Best-effort: callers treat null as "couldn't check, try again later".
 */
export async function latestVersion(): Promise<string | null> {
  try {
    const { stdout } = await pexec("npm", ["view", `${PKG}@latest`, "version"], {
      timeout: 30_000,
    });
    const v = stdout.trim();
    return v || null;
  } catch {
    return null;
  }
}

async function npmInstallLatest(): Promise<void> {
  fs.mkdirSync(APP_DIR, { recursive: true });
  // --prefix installs into APP_DIR/node_modules; no package.json needed there.
  await pexec("npm", ["install", `${PKG}@latest`, "--prefix", APP_DIR, "--no-audit", "--no-fund"], {
    timeout: 5 * 60_000,
  });
}

/** Install the latest server; report the resolved version (or the failure). */
export async function update(): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    await npmInstallLatest();
    return { ok: true, version: installedVersion() ?? "unknown" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

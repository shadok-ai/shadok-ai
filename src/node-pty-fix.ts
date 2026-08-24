import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

/**
 * The `spawn-helper` binaries a node-pty install may ship, given its package
 * root. Pure over (root, readdir) so it is unit-testable. Covers the prebuilt
 * layout (`prebuilds/<platform>/spawn-helper`) plus the from-source fallback
 * (`build/Release/spawn-helper`).
 */
export function spawnHelperPaths(
  root: string,
  readdir: (dir: string) => string[] = safeReaddir,
): string[] {
  const out: string[] = [];
  for (const d of readdir(path.join(root, "prebuilds"))) {
    out.push(path.join(root, "prebuilds", d, "spawn-helper"));
  }
  out.push(path.join(root, "build", "Release", "spawn-helper"));
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Make node-pty's `spawn-helper` executable, resolved from node-pty's REAL
 * location at runtime.
 *
 * Why this exists: the prebuilt helper must be `chmod +x` to run, and the
 * package's `postinstall` does that — but via a RELATIVE path
 * (`node_modules/node-pty/...`) that only holds when shadok-ai is the root
 * package (a dev checkout). Installed as a dependency (npx / the managed
 * `~/.shadok-ai/app`), node-pty is hoisted to the parent `node_modules` and the
 * postinstall's CWD is shadok-ai's own dir, so the chmod hits a path that isn't
 * there and silently no-ops — leaving the helper non-executable and
 * `pty.spawn()` throwing an opaque `Error: posix_spawnp failed` on the user's
 * first agent. Resolving node-pty here sidesteps every install layout.
 *
 * Best-effort and idempotent; a no-op on Windows (no spawn-helper there).
 */
export function ensureSpawnHelperExecutable(notify: (line: string) => void = () => {}): void {
  if (process.platform === "win32") return;
  let root: string;
  try {
    const require = createRequire(import.meta.url);
    root = path.resolve(path.dirname(require.resolve("node-pty")), "..");
  } catch (e) {
    notify(`node-pty not resolvable, can't fix spawn-helper perms: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  for (const p of spawnHelperPaths(root)) {
    try {
      fs.chmodSync(p, 0o755);
    } catch {
      // Missing in this layout, or read-only — skip; another candidate may hit.
    }
  }
}

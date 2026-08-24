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

/** The manual-install fallback message, shown when the auto-install can't help. */
export function claudeMissingMessage(detail: string): string {
  return (
    `Claude Code CLI ('claude') is required and ${detail}. ` +
    `Install it manually: npm i -g ${CLAUDE_PKG} — then run 'claude' once to sign in to your Claude account. ` +
    `shadok-ai drives claude on your own subscription, so that one-time sign-in is unavoidable.`
  );
}

export interface EnsureClaudeDeps {
  /** Find claude now (typically resolveBin("claude")). Called again after install. */
  resolve: () => string | null;
  /** Perform the global install (typically `npm i -g @anthropic-ai/claude-code`). */
  install: () => Promise<void>;
  /** Surface progress (server log / a line to the client). */
  notify: (line: string) => void;
}

export type EnsureClaudeResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Make the claude CLI available, installing it ONCE if it is missing. Returns
 * the resolved path, or a clear, actionable error when it still isn't there
 * (install failed on permissions, or the global bin dir isn't on PATH) — never
 * the raw `posix_spawnp failed` a bare spawn would throw. Pure orchestration
 * over injected deps, so it is tested without touching npm.
 */
export async function ensureClaude(deps: EnsureClaudeDeps): Promise<EnsureClaudeResult> {
  const found = deps.resolve();
  if (found) return { ok: true, path: found };

  deps.notify(`Claude Code CLI not found — installing ${CLAUDE_PKG} (one-time, this can take a minute)…`);
  try {
    await deps.install();
  } catch (e) {
    return { ok: false, error: claudeMissingMessage(`installing it failed (${e instanceof Error ? e.message : String(e)})`) };
  }

  const after = deps.resolve();
  if (after) {
    deps.notify("Claude Code CLI installed. You'll be asked to sign in to your Claude account on first use.");
    return { ok: true, path: after };
  }
  return { ok: false, error: claudeMissingMessage("it was installed but 'claude' is still not on PATH") };
}

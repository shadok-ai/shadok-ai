export interface TmuxInstall {
  cmd: string;
  args: string[];
  /** Linux package managers need root; brew must NOT run as root. */
  needsRoot: boolean;
}

/**
 * Pure: the package-manager command to install tmux on this platform, given
 * which manager binaries exist (`has`). null when none is available or the
 * platform isn't covered — the caller then stays on node-pty.
 */
export function tmuxInstallCommand(
  platform: NodeJS.Platform,
  has: (bin: string) => boolean,
): TmuxInstall | null {
  if (platform === "darwin") {
    return has("brew") ? { cmd: "brew", args: ["install", "tmux"], needsRoot: false } : null;
  }
  if (platform === "linux") {
    if (has("apt-get")) return { cmd: "apt-get", args: ["install", "-y", "tmux"], needsRoot: true };
    if (has("apk")) return { cmd: "apk", args: ["add", "tmux"], needsRoot: true };
    if (has("dnf")) return { cmd: "dnf", args: ["install", "-y", "tmux"], needsRoot: true };
    if (has("yum")) return { cmd: "yum", args: ["install", "-y", "tmux"], needsRoot: true };
    if (has("pacman")) return { cmd: "pacman", args: ["-S", "--noconfirm", "tmux"], needsRoot: true };
  }
  return null;
}

export interface EnsureTmuxDeps {
  /** Find tmux now (resolveBin("tmux")). Called again after an install. */
  resolve: () => string | null;
  /** The install command for this host, or null (tmuxInstallCommand(...)). */
  plan: () => TmuxInstall | null;
  /** Run the install command. */
  install: (c: TmuxInstall) => Promise<void>;
  /** Progress / fallback guidance. */
  notify: (line: string) => void;
}

export interface EnsureTmuxResult {
  /** tmux got installed by us this run. */
  installed: boolean;
  /** tmux is available now (already there, or installed). */
  present: boolean;
  note?: "no-manager" | "install-failed";
}

/**
 * Best-effort: make tmux available so agents survive a server restart (with
 * node-pty they die on every auto-update). NEVER blocks — if tmux can't be
 * installed (no package manager, or it needs a password we don't have) we say
 * so and stay on node-pty. Pure orchestration over injected deps, so it is
 * tested without touching the system.
 */
export async function ensureTmux(deps: EnsureTmuxDeps): Promise<EnsureTmuxResult> {
  if (deps.resolve()) return { installed: false, present: true };

  const plan = deps.plan();
  if (!plan) {
    deps.notify(
      "tmux not found and no known package manager to install it — running on node-pty " +
        "(agents die when the server restarts). Install tmux for durable agents.",
    );
    return { installed: false, present: false, note: "no-manager" };
  }

  deps.notify(`tmux not found — installing it with ${plan.cmd} so agents survive restarts…`);
  try {
    await deps.install(plan);
  } catch (e) {
    deps.notify(
      `could not auto-install tmux (${e instanceof Error ? e.message : String(e)}) — install it manually ` +
        `(${plan.cmd} ${plan.args.join(" ")}). Running on node-pty meanwhile.`,
    );
    return { installed: false, present: false, note: "install-failed" };
  }

  const present = !!deps.resolve();
  if (present) deps.notify("tmux installed — agents will now survive server restarts.");
  return { installed: present, present };
}

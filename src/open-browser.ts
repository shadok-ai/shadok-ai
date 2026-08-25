import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * Open the cockpit in the user's browser once the server is listening.
 *
 * Done by the SERVER rather than the supervisor, because the server is the only
 * one that knows the port it actually landed on — `START_PORT` is where the walk
 * begins, not where it ends, so a busy 3789 becomes 3790 and the supervisor
 * would hand the browser a dead URL.
 *
 * The supervisor respawns the server on every auto-update, so it sets
 * `SHADOK_OPEN=1` on the FIRST spawn only. Without that, the browser would pop
 * open several times a day on every instance — a good idea turned into a
 * nuisance.
 */

/** Pure: should this process open a browser at all? */
export function shouldOpenBrowser(ctx: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  inContainer: boolean;
}): boolean {
  if (ctx.env.SHADOK_OPEN !== "1") return false;
  // A container has no browser, and the spawn would only fail into the logs on
  // every boot.
  if (ctx.inContainer) return false;
  // Over SSH the person is at the OTHER end of the pipe; opening a browser here
  // helps nobody.
  if (ctx.env.SSH_CONNECTION || ctx.env.SSH_TTY) return false;
  // macOS and Windows always have a session to open into; Linux does not.
  if (ctx.platform === "linux" && !ctx.env.DISPLAY && !ctx.env.WAYLAND_DISPLAY) return false;
  return true;
}

/** Pure: the command that opens a URL, or null on a platform we don't know. */
export function openCommand(
  platform: NodeJS.Platform,
  url: string,
): { cmd: string; args: string[] } | null {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "linux") return { cmd: "xdg-open", args: [url] };
  // The empty string is the window TITLE `start` expects. Without it, a quoted
  // URL is taken as the title and nothing opens.
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  return null;
}

/** Detection matching src/ssh.ts: Docker writes this file in every container. */
const inContainer = (): boolean => {
  try {
    return fs.existsSync("/.dockerenv");
  } catch {
    return false;
  }
};

/**
 * Best effort, always. A browser that refuses to open must never keep the
 * server from serving — which is the whole reason it is fire-and-forget and
 * every error is swallowed.
 */
export function openBrowser(url: string): void {
  try {
    if (!shouldOpenBrowser({ env: process.env, platform: process.platform, inContainer: inContainer() }))
      return;
    const c = openCommand(process.platform, url);
    if (!c) return;
    const child = spawn(c.cmd, c.args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    console.log(`opening ${url} in your browser (--no-open to skip)`);
  } catch {
    /* never fatal */
  }
}

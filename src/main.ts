#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.js";
import {
  effectiveToken,
  loadConfig,
  migrateLegacyToken,
  saveConfig,
  setTokenForCwd,
  tokenForCwd,
} from "./config.js";
import { loadTgGroup } from "./channels.js";
import { promptToken } from "./setup-prompt.js";
import { runSupervisor, type SupervisorDeps } from "./supervisor.js";
import { latestVersion, serverEntry, update } from "./updater.js";
import { resolveChannel } from "./update-channel.js";
import { writeUpdateResult } from "./update-flag.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function ownVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The server to run: the managed (updatable) install if present, else the
 *  server bundled next to this file. */
function serverToRun(): string {
  const managed = serverEntry();
  return fs.existsSync(managed) ? managed : path.join(HERE, "server.js");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "shadok-ai — web cockpit for parallel Claude Code sessions\n\n" +
        "Usage: npx shadok-ai [options]\n" +
        "  --port, -p <n>   HTTP/WS port (default 3789)\n" +
        "  --no-telegram    run web-only; don't prompt for or use a bot token\n" +
        "  --no-open        don't open the browser on launch\n" +
        "  --password <p>   require this password to open the GUI (stored in config)\n" +
        "  --version, -v    print version\n" +
        "  --help, -h       this help\n\n" +
        "Open http://localhost:<port>. In your Telegram board group, /setup to bind it.\n",
    );
    return 0;
  }
  if (args.version) {
    process.stdout.write(ownVersion() + "\n");
    return 0;
  }

  // The bot token is per launch directory — a different directory = a different
  // bot (or none), like the channel list.
  const cwd = process.cwd();
  const cfg = loadConfig();
  // Keep an existing setup working: adopt the old GLOBAL token here iff this dir
  // already has a bound Telegram group; a brand-new dir prompts for its own.
  migrateLegacyToken(cfg, cwd, loadTgGroup() !== null);

  // First-run token prompt: only when we've never asked for THIS dir, it's
  // interactive, and Telegram isn't disabled. A skip is recorded (null) so we
  // never nag again.
  if (
    !args.noTelegram &&
    tokenForCwd(cfg, cwd) === undefined &&
    !process.env.TELEGRAM_BOT_TOKEN &&
    process.stdin.isTTY
  ) {
    setTokenForCwd(cfg, cwd, await promptToken());
  }

  const port = args.port ?? cfg.port ?? (Number(process.env.PORT) || 3789);
  const token = args.noTelegram ? null : effectiveToken(cfg, cwd);

  // GUI password: --password stores it in config; otherwise use the config or an
  // env var. Empty/unset → no auth. Passed to the server child as an env var.
  if (args.password !== undefined) {
    cfg.guiPassword = args.password || undefined;
    saveConfig(cfg);
  }
  const guiPassword = process.env.SHADOK_GUI_PASSWORD ?? cfg.guiPassword;

  const childEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
  if (token) childEnv.TELEGRAM_BOT_TOKEN = token;
  else delete childEnv.TELEGRAM_BOT_TOKEN;
  if (guiPassword) childEnv.SHADOK_GUI_PASSWORD = guiPassword;
  else delete childEnv.SHADOK_GUI_PASSWORD;

  // Open the browser on the first launch only. The supervisor respawns the
  // server on every auto-update, and a cockpit that pops a tab open several
  // times a day is a nuisance, not a convenience.
  let openOnce = !args.noOpen;
  let current: ReturnType<typeof spawn> | null = null;
  // Ctrl-C / SIGTERM: bring the child down with us instead of orphaning it.
  let shuttingDown = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      shuttingDown = true;
      current?.kill(sig);
      process.exit(0);
    });
  }

  const deps: SupervisorDeps = {
    spawnServer: () =>
      new Promise<number>((resolve) => {
        // The SERVER opens it: only it knows the port the walk landed on.
        const env = openOnce ? { ...childEnv, SHADOK_OPEN: "1" } : childEnv;
        openOnce = false;
        const child = spawn(process.execPath, [serverToRun()], { env, stdio: "inherit" });
        current = child;
        child.on("exit", (code) => resolve(shuttingDown ? 0 : code ?? 0));
        child.on("error", () => resolve(1));
      }),
    /**
     * The server asked for an update (exit 75) without naming a version, so the
     * target is resolved HERE — and it must honour the instance's channel, or
     * this path would quietly drag an alpha instance back to the beta build on
     * every supervisor-driven update. The config is read at call time: the user
     * may have switched channels since boot.
     */
    update: async () => {
      const target = await latestVersion(resolveChannel(loadConfig().updateChannel));
      return target
        ? update(target)
        : { ok: false as const, error: "could not reach the npm registry" };
    },
    writeUpdateResult,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (m) => process.stdout.write(`[shadok-ai] ${m}\n`),
  };

  return runSupervisor(deps);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`[shadok-ai] fatal: ${e?.message ?? e}\n`);
    process.exit(1);
  },
);

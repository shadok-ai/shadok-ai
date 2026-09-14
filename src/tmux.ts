import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { idleStep, screenShowsWork, inputText, describeStuckScreen, nextScreenDelay, typeIntoBox, SCREEN_FAST_MS } from "./detect.js";
import { windowMs, FORCED_CLAUDE_ENV } from "./session.js";
import { binaryBusyError } from "./claude-bin.js";
import { SHADOK_DIR } from "./config.js";
import type { PilotOptions, WaitIdleOptions, WaitOptions } from "./session.js";

/**
 * Same interface as {@link PtyPilot}, but runs `claude` inside a detached
 * **tmux** session instead of a node-pty child. tmux (its own daemon) owns the
 * terminal, so the agent survives the shadok-ai server restarting or
 * crashing: on restart the server reattaches to the running tmux session and
 * the in-flight turn continues uninterrupted.
 *
 * The tmux session name is derived from the Claude session id, so reattach is
 * deterministic. Content still comes from the .jsonl tail (unchanged); tmux is
 * only about keeping the live process alive.
 */
export interface TmuxPilotOptions extends PilotOptions {
  /** tmux session name (stable across restarts — derive from the session id). */
  tmuxName: string;
  /** Where the one-shot launcher script is written (default `~/.shadok-ai/run`). */
  launcherDir?: string;
}

function tmux(args: string[], input?: string): string {
  try {
    return execFileSync("tmux", args, {
      encoding: "utf8",
      input,
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    throw new Error(tmuxErrorMessage(args, (e as { stderr?: unknown }).stderr));
  }
}

/**
 * What a failed tmux call is allowed to say: the subcommand and tmux's own
 * complaint, NEVER the rest of the argument vector.
 *
 * `execFileSync` builds its error message as "Command failed: <every argument>",
 * and that message travelled to the browser untouched. When the arguments are a
 * spawn command, they are every secret the profile injects — so a spawn that
 * failed for an unrelated reason displayed forty-six credentials in the web UI.
 * `send-keys` carries the user's own prompt text, which has no business in an
 * error either.
 */
export function tmuxErrorMessage(args: string[], stderr: unknown): string {
  const why = typeof stderr === "string" ? stderr.trim() : Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : "";
  return `tmux ${args[0] ?? "command"} failed${why ? `: ${why}` : ""}`;
}

/** Single-quote a string for POSIX sh; safe for any content, newlines included. */
export function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** A name `export` accepts. The vault does not restrict names, the shell does. */
export function isEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * The one-shot script a tmux pane runs to start an agent.
 *
 * The spawn used to be a single `env KEY=VALUE … claude <args>` string handed to
 * `tmux new-session`. Two things were wrong with carrying it that way. tmux
 * refuses a command over ~16 KB ("command too long", measured: 16000 bytes
 * pass, 17000 fail), and that string holds every secret VALUE of the profile
 * plus every system prompt — so a lead role with a long prompt on a large vault
 * simply could not be launched, while a shorter role on the same vault could.
 * And those values were arguments of a process, which `ps` shows to anyone on
 * the machine.
 *
 * Writing them to a file makes the tmux command a few dozen bytes whatever the
 * vault holds, and `export` is a shell builtin, so no value is ever the argument
 * of any process. The order is the old one and is load-bearing: strip the
 * inherited CLAUDE* markers, then the secrets, then `FORCED_CLAUDE_ENV` LAST so
 * a profile can never switch transcript writing off (invariant 29). The script
 * removes itself first thing — `sh` already holds it open, so unlinking the name
 * loses nothing — which bounds the file's life to the moment before `exec`.
 */
export function launcherScript(o: {
  unset: string[];
  env: Record<string, string>;
  forced: Record<string, string>;
  bin: string;
  args: string[];
}): { script: string; skipped: string[] } {
  const skipped: string[] = [];
  const exports: string[] = [];
  const add = (k: string, v: string) => {
    if (!isEnvName(k)) return skipped.push(k);
    exports.push(`export ${k}=${shellQuote(v)}`);
  };
  add("TERM", "xterm-256color");
  for (const [k, v] of Object.entries(o.env)) add(k, v);
  for (const [k, v] of Object.entries(o.forced)) add(k, v);
  const script = [
    "#!/bin/sh",
    'rm -f -- "$0"',
    ...o.unset.filter(isEnvName).map((k) => `unset ${k}`),
    ...exports,
    `exec ${[o.bin, ...o.args].map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
  return { script, skipped };
}

function tmuxOk(args: string[]): boolean {
  try {
    tmux(args);
    return true;
  } catch {
    return false;
  }
}

/** True when a tmux session with this exact name is alive. */
export function tmuxHasSession(name: string): boolean {
  return tmuxOk(["has-session", "-t", name]);
}

/** Kills a tmux session by name. Idempotent: an absent session is a no-op. */
export function tmuxKillSession(name: string): void {
  tmuxOk(["kill-session", "-t", name]);
}

/**
 * The working directory of a live tmux session's pane — the source of truth for
 * a reattached session's cwd (a worktree agent's real directory), which the
 * client can't always supply on resume. Null if the session is gone.
 */
export function tmuxPaneCwd(name: string): string | null {
  try {
    const p = tmux(["display-message", "-p", "-t", name, "#{pane_current_path}"]).trim();
    return p || null;
  } catch {
    return null;
  }
}

export class TmuxPilot {
  private readonly opts: Required<Pick<TmuxPilotOptions, "cols" | "rows">> & TmuxPilotOptions;
  private readonly name: string;
  private exitListeners = new Set<(code: number) => void>();
  private poller: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive captures that found the screen byte-identical — drives the
   *  poller's back-off. Reset by anything that writes to the pane. */
  private calm = 0;
  private _screen = "";
  private exited = false;
  /** True when we reattached to an already-running session (survived restart). */
  attached = false;

  constructor(options: TmuxPilotOptions) {
    this.opts = { cols: 100, rows: 40, ...options };
    this.name = options.tmuxName;
  }

  /** Whether a tmux session with our name is currently alive. */
  private hasSession(): boolean {
    return tmuxOk(["has-session", "-t", this.name]);
  }

  start(): void {
    if (this.hasSession()) {
      // Reattach to a session that outlived a previous server: claude is
      // already past the trust dialog and holding its state.
      this.attached = true;
    } else {
      // Strip a parent Claude Code session's vars (a nested claude that sees
      // them may disable interactive mode), like PtyPilot does.
      const unset = Object.keys(process.env).filter((k) => /^(CLAUDE|CLAUDECODE|AI_AGENT)/.test(k));
      const bin = this.opts.claudePath ?? "claude";
      // Secrets and prompts go into a private one-shot script, never onto the
      // tmux command line: see `launcherScript` for why both halves matter.
      const { script, skipped } = launcherScript({
        unset,
        env: this.opts.env ?? {},
        forced: FORCED_CLAUDE_ENV,
        bin,
        args: this.opts.args ?? [],
      });
      for (const name of skipped)
        console.error(`[${this.name}] secret "${name}" not exported — not a valid environment variable name`);
      const dir = this.opts.launcherDir ?? path.join(SHADOK_DIR, "run");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      const launcher = path.join(dir, `${this.name}.sh`);
      // `wx` after a forced remove: a stale file from an earlier failed spawn must
      // not keep whatever mode it had — the new one is created 0600 or not at all.
      fs.rmSync(launcher, { force: true });
      fs.writeFileSync(launcher, script, { mode: 0o600, flag: "wx" });
      try {
        tmux([
          "new-session",
          "-d",
          "-s", this.name,
          "-x", String(this.opts.cols),
          "-y", String(this.opts.rows),
          "-c", this.opts.cwd ?? process.cwd(),
          `sh ${shellQuote(launcher)}`,
        ]);
      } catch (e) {
        // The pane never ran, so the script never removed itself: it holds the
        // profile's secrets and must not outlive the failure.
        fs.rmSync(launcher, { force: true });
        throw e;
      }
      // `tmux new-session` returns as soon as the pane exists, so a pane that is
      // ALREADY gone means its command never got to run — ETXTBSY being the
      // reason that actually happens here, when a claude-code upgrade is
      // rewriting the binary. Without this the pane simply vanishes, `tick()`
      // reads it as an ordinary exit, and a spawn killed by a transient reports
      // as a dead agent. A pane tmux has not torn down yet reads as alive and we
      // fall through to the old behaviour — no worse than before, never worse.
      if (!this.hasSession()) {
        fs.rmSync(launcher, { force: true });
        throw binaryBusyError(bin);
      }
    }
    this.capture();
    // Self-rescheduling rather than a flat interval: the capture is synchronous,
    // so a fixed cadence puts its cost on the event loop for EVERY agent that
    // exists, watched or not. An idle pane is byte-identical for hours, so the
    // poller backs off and loses nothing — and any write to the pane wakes it.
    this.poller = setTimeout(() => this.tick(), SCREEN_FAST_MS);
  }

  private tick(): void {
    if (this.exited) return;
    // A SUCCESSFUL capture proves the session is alive, so the `has-session`
    // probe that used to run first was a second tmux spawn per tick for an
    // answer the capture already gives. Both are synchronous, and the pair cost
    // ~15 ms of blocked event loop per session every 250 ms — past sixteen
    // agents the server was oversaturated and every HTTP request queued behind
    // it. Now the probe only runs when the capture actually failed.
    if (this.capture()) {
      this.poller = setTimeout(() => this.tick(), nextScreenDelay(this.calm, false));
      return;
    }
    if (this.hasSession()) {
      // Transient tmux hiccup — keep the last screen, and look again promptly.
      this.poller = setTimeout(() => this.tick(), SCREEN_FAST_MS);
      return;
    }
    this.exited = true;
    if (this.poller) clearTimeout(this.poller);
    this.poller = null;
    for (const cb of this.exitListeners) cb(0);
  }

  /**
   * Back to the fast cadence at once.
   *
   * Every path that writes to the pane calls this: after a keystroke the mirror
   * must not wait out a back-off it earned while the pane was still.
   */
  private wake(): void {
    this.calm = 0;
    if (this.exited || !this.poller) return;
    clearTimeout(this.poller);
    this.poller = setTimeout(() => this.tick(), SCREEN_FAST_MS);
  }

  /** Refreshes the cached rendered screen. Returns false when tmux refused. */
  private capture(): boolean {
    try {
      const next = tmux(["capture-pane", "-t", this.name, "-p"]).replace(/\n+$/, "");
      if (next === this._screen) this.calm++;
      else {
        this.calm = 0;
        this._screen = next;
      }
      return true;
    } catch {
      return false; // session gone or transient tmux error — keep last
    }
  }

  onExit(cb: (code: number) => void): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  get hasExited(): boolean {
    return this.exited;
  }

  /** The currently rendered screen (cached, refreshed by the poller). */
  screen(): string {
    return this._screen;
  }

  /** tmux gives us the rendered pane incl. scrollback; used rarely. */
  fullBuffer(): string {
    try {
      return tmux(["capture-pane", "-t", this.name, "-p", "-S", "-"]).replace(/\n+$/, "");
    } catch {
      return this._screen;
    }
  }

  /** Sends literal text to the session (no submit). */
  write(text: string): void {
    this.wake();
    tmux(["send-keys", "-t", this.name, "-l", "--", text]);
  }

  // ── Interactive raw terminal (experimental) ─────────────────────────
  // A true byte-level view/input path, independent of the rendered-screen
  // control plane. Output streams via `pipe-pane`, input goes in via
  // `send-keys -H` (raw hex bytes: arrows, ctrl, esc — everything).
  private rawFile: string | null = null;
  private rawTimer: ReturnType<typeof setInterval> | null = null;
  private rawOffset = 0;

  /** The pane's real character size, so the browser terminal can render the raw
   *  stream 1:1 (mismatched cols = the TUI wraps into garbage). */
  paneSize(): { cols: number; rows: number } {
    try {
      const [w, h] = tmux(["display-message", "-p", "-t", this.name, "#{pane_width} #{pane_height}"])
        .trim()
        .split(/\s+/)
        .map(Number);
      if (w > 0 && h > 0) return { cols: w, rows: h };
    } catch {
      /* session gone */
    }
    return { cols: this.opts.cols, rows: this.opts.rows };
  }

  /** Current screen WITH escape sequences (colours) — primes a raw viewer,
   *  since pipe-pane only carries output produced AFTER it starts. */
  seed(): string {
    try {
      return tmux(["capture-pane", "-t", this.name, "-e", "-p"]);
    } catch {
      return "";
    }
  }

  /** Original pane size, remembered on the first resize so we can restore it
   *  when the interactive terminal detaches (the control plane reads this pane). */
  private origSize: { cols: number; rows: number } | null = null;

  /** Resizes the tmux window to fit the browser terminal (full-screen view).
   *  Remembers the original size once, restored on detach. */
  resizeWindow(cols: number, rows: number): void {
    if (cols < 4 || rows < 2) return;
    if (!this.origSize) this.origSize = this.paneSize();
    const cur = this.paneSize();
    try {
      tmux(["set-window-option", "-t", this.name, "window-size", "manual"]);
      // A resize makes the TUI (Ink) do a FULL repaint into the pipe — that
      // clean frame is how the browser terminal seeds itself. If the size is
      // already right (channel reopened / same window), nudge one row so the
      // repaint still fires.
      if (cur.cols === cols && cur.rows === rows) {
        tmux(["resize-window", "-t", this.name, "-x", String(cols), "-y", String(Math.max(2, rows - 1))]);
      }
      tmux(["resize-window", "-t", this.name, "-x", String(cols), "-y", String(rows)]);
    } catch {
      /* session gone */
    }
  }

  /** Injects raw bytes into the pane (hex via send-keys -H). */
  sendRaw(data: Buffer): void {
    this.wake();
    if (!data.length) return;
    const hex = Array.from(data, (b) => b.toString(16).padStart(2, "0"));
    try {
      tmux(["send-keys", "-t", this.name, "-H", ...hex]);
    } catch {
      /* session gone — ignore */
    }
  }

  /**
   * Streams the pane's raw output (ANSI included) by piping it to a temp file
   * we tail. One consumer per pilot (the server fans out to WS clients).
   * Returns a detach function; idempotent.
   */
  attachRaw(onData: (chunk: Buffer) => void): () => void {
    this.detachRaw();
    const file = path.join(os.tmpdir(), `sk-raw-${this.name}-${process.pid}.out`);
    try {
      fs.writeFileSync(file, "");
    } catch {
      return () => {};
    }
    this.rawFile = file;
    this.rawOffset = 0;
    // -O: pane output → command. The command appends the raw bytes to our file.
    tmux(["pipe-pane", "-O", "-t", this.name, `cat >> '${file.replace(/'/g, "'\\''")}'`]);
    this.rawTimer = setInterval(() => {
      const f = this.rawFile;
      if (!f) return;
      try {
        const size = fs.statSync(f).size;
        if (size <= this.rawOffset) return;
        const fd = fs.openSync(f, "r");
        const buf = Buffer.alloc(size - this.rawOffset);
        fs.readSync(fd, buf, 0, buf.length, this.rawOffset);
        fs.closeSync(fd);
        this.rawOffset = size;
        onData(buf);
      } catch {
        /* transient read race — retry next tick */
      }
    }, 40);
    return () => this.detachRaw();
  }

  private detachRaw(): void {
    if (this.rawTimer) {
      clearInterval(this.rawTimer);
      this.rawTimer = null;
    }
    // pipe-pane with no command closes the current pipe.
    try {
      tmux(["pipe-pane", "-t", this.name]);
    } catch {
      /* session gone */
    }
    if (this.rawFile) {
      try {
        fs.unlinkSync(this.rawFile);
      } catch {
        /* already gone */
      }
      this.rawFile = null;
    }
    this.rawOffset = 0;
    // Restore the pane to its pre-terminal size so the control plane (dialog /
    // turn detection reads this screen) sees the layout it expects again.
    if (this.origSize) {
      try {
        tmux(["resize-window", "-t", this.name, "-x", String(this.origSize.cols), "-y", String(this.origSize.rows)]);
      } catch {
        /* session gone */
      }
      this.origSize = null;
    }
  }

  /** Pastes text with bracketed-paste framing (reliable for the TUI input). */
  private paste(text: string): void {
    tmux(["load-buffer", "-b", "cp", "-"], text);
    tmux(["paste-buffer", "-t", this.name, "-b", "cp", "-p", "-d"]);
  }

  press(key: "enter" | "escape" | "up" | "down" | "left" | "right" | "tab" | "ctrl-c"): void {
    this.wake();
    const map: Record<string, string> = {
      enter: "Enter",
      escape: "Escape",
      up: "Up",
      down: "Down",
      left: "Left",
      right: "Right",
      tab: "Tab",
      "ctrl-c": "C-c",
    };
    tmux(["send-keys", "-t", this.name, map[key]]);
  }

  isWorking(): boolean {
    return screenShowsWork(this.screen());
  }

  /**
   * Types a prompt then presses Enter — same robustness as PtyPilot:
   * bracketed paste with retry until the text shows, then Enter with retry
   * until the turn is actually sent.
   */
  async submit(text: string): Promise<void> {
    const typed = await typeIntoBox(
      {
        paste: (t) => this.paste(t),
        clearInput: () => this.write("\x15"), // Ctrl-U
        waitFor: (p, o) => this.waitFor(p, o),
      },
      text,
    );
    if (!typed) {
      throw this.submitError("the text never appeared in the input box");
    }
    await sleep(200);
    // Sent once the input box is empty again (or the spinner is up). Requiring
    // it to be truly empty makes the Enter retry robust to the bracketed-paste
    // race, and works for collapsed pastes (whose text is never on screen).
    const submitted = (s: string) => screenShowsWork(s) || inputText(s) === "";
    for (let attempt = 0; attempt < 3; attempt++) {
      this.press("enter");
      try {
        await this.waitFor(submitted, { timeoutMs: 3_000 });
        return;
      } catch {
        /* Enter swallowed — retry */
      }
    }
    throw this.submitError("the prompt does not seem to have been sent");
  }

  /** A concise client-facing error; the full screen goes to the server log only. */
  private submitError(reason: string): Error {
    const screen = this.screen();
    // Name the blocking state when we recognise it: the bare symptom points at
    // the input box, which is exactly where the answer is NOT.
    const because = describeStuckScreen(screen);
    console.error(`[${this.name}] submit failed — ${reason}. Screen:\n${screen}`);
    return new Error(because ? `submit: ${reason} — ${because}.` : `submit: ${reason}.`);
  }

  async waitFor(
    predicate: (screen: string) => boolean,
    { timeoutMs = 60_000 }: WaitOptions = {},
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exited) throw new Error("The claude process has exited.");
      const s = this.screen();
      if (predicate(s)) return s;
      await sleep(120);
    }
    throw new Error(`waitFor: timed out after ${timeoutMs} ms. Last screen:\n${this.screen()}`);
  }

  async waitForIdle({
    stableMs = 1_500,
    timeoutMs = 600_000,
  }: WaitIdleOptions = {}): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastScreen = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      if (this.exited) throw new Error("The claude process has exited.");
      const s = this.screen();
      const step = idleStep(s, lastScreen, stableSince, Date.now(), windowMs(stableMs));
      if (step.done) return s;
      stableSince = step.stableSince;
      lastScreen = step.lastScreen;
      await sleep(160);
    }
    throw new Error(`waitForIdle: timed out after ${timeoutMs} ms. Last screen:\n${this.screen()}`);
  }

  /** Clean shutdown: /exit, then kill the tmux session as a fallback. */
  /**
   * End the agent, gracefully if possible but ALWAYS for real.
   *
   * The graceful `/exit` matters — it lets claude release its session lock so a
   * later `--resume` works. But it goes through `submit()`, which is exactly
   * what fails on a TUI wedged somewhere without an input box: precisely the
   * case a restart exists to rescue. So the kill is unconditional, and the only
   * thing consulted is `hasSession()`.
   *
   * `this.exited` is deliberately NOT an early-return any more. That flag means
   * "I believe this ended"; believing it here returned without killing anything,
   * and `start()` then adopted the surviving pane — turning a restart the user
   * explicitly asked for into a silent reattach to the very process they wanted
   * gone. Three agents sat wedged on Claude Code's onboarding screen for a day
   * that way, and every "Reload agent" was a no-op.
   */
  async stop(): Promise<void> {
    if (this.hasSession()) {
      try {
        await this.submit("/exit");
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline && this.hasSession()) await sleep(200);
      } catch {
        /* fall through to the hard kill */
      }
    }
    this.kill(); // idempotent: killing an absent session is a no-op
  }

  /** Kills the tmux session (ends the agent). */
  kill(): void {
    tmuxOk(["kill-session", "-t", this.name]);
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.exited = true;
  }
}

/** True when tmux is available on this host. */
export function tmuxAvailable(): boolean {
  return tmuxOk(["-V"]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

import { isAgentCredentialVar, withoutAgentCredentials } from "./agent-principal.js";
import pty from "node-pty";
import xterm from "@xterm/headless";
import { idleStep, settleStep, DIALOG_HOLD_MS, screenShowsWork, inputText, boxText, submitFailure, type SubmitError, type SubmitFailure, typeIntoBox } from "./detect.js";
import { dropArgv, dropEnv } from "./osusers.js";

const { Terminal } = xterm;

/**
 * Environment FORCED onto every `claude` this cockpit spawns, whatever the
 * parent process happened to carry. Both transports apply it; keep them in
 * step through this constant rather than by copying the string.
 *
 * Why it has to be asserted and not merely un-poisoned: shadok-ai reads all
 * content from the `.jsonl` transcript (`src/tail.ts`), and uses the screen
 * only for control. An agent that writes no transcript therefore runs, does
 * the work, and says NOTHING — silent in the web chat, silent in Telegram,
 * empty on reload. It is the same silent-loss class as invariant 7.
 *
 * Claude Code turns transcript writing off when it inherits
 * CLAUDE_CODE_CHILD_SESSION, and it sets that marker itself on the environment
 * it hands to its own tool subprocesses — so an agent that shells out to
 * `claude` passes it on without anyone choosing to.
 *
 * Stripping the marker at spawn (below, and in TmuxPilot) still happens and
 * still matters. This is the other half: subtraction assumes we have listed
 * every name that can suppress a transcript, and it stops working in silence
 * the day a new one appears. The assertion holds either way.
 */
export const FORCED_CLAUDE_ENV: Record<string, string> = {
  CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1",
};

/**
 * The forced layer: `FORCED_CLAUDE_ENV` plus, for an isolated group's agent, the
 * shared subscription token. `CLAUDE_CODE_OAUTH_TOKEN` begins with `CLAUDE`, so
 * any layer before the strip would lose it, and a profile secret of the same
 * name must not shadow it — hence the forced layer, applied LAST by both pilots.
 * Gated on BOTH a drop `user` and a non-empty token: mono-tenant gets no key.
 */
export function forcedEnv(opts: { user?: string | null; oauthToken?: string; ghToken?: string }): Record<string, string> {
  return {
    ...FORCED_CLAUDE_ENV,
    ...(opts.user && opts.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: opts.oauthToken } : {}),
    // A dropped agent cannot read the server's gh config (its GH_CONFIG_DIR is
    // overridden to the drop user's own writable dir in `dropEnv`), so it auths
    // via GH_TOKEN instead — the server's own gh token, shared like the
    // subscription token. Gated on a drop user; mono-tenant/root reads the config
    // dir directly and needs nothing.
    ...(opts.user && opts.ghToken ? { GH_TOKEN: opts.ghToken } : {}),
  };
}

/** The full spawn env of a PTY pilot, pure so it is testable without a PTY. */
export function spawnEnv(
  opts: { user?: string | null; home?: string | null; env?: Record<string, string>; oauthToken?: string; ghToken?: string },
  baseEnv: Record<string, string>,
): Record<string, string> {
  // The credential strip goes on the RESULT, so neither the inherited env nor
  // anything a caller passes can hand an agent the admin's cookie or the
  // instance password (src/agent-principal.ts).
  return withoutAgentCredentials({
    ...baseEnv,
    TERM: "xterm-256color",
    ...opts.env,
    ...dropEnv(opts.user, opts.home),
    ...forcedEnv(opts),
  });
}

export interface PilotOptions {
  /** Path to the claude executable (default: "claude" from PATH). */
  claudePath?: string;
  /** Arguments passed to the CLI (e.g. ["--resume", "<id>"]). */
  args?: string[];
  /** Working directory of the session. */
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  /**
   * The OS user to drop to before exec (multi-tenant isolation). When set, the
   * spawn is wrapped in `setpriv` (`src/osusers.ts`); unset = today's behaviour,
   * running as the server's own user. The multi-tenant gate lives in the caller
   * (`makePilot`), so an unset `user` is the only thing a mono-tenant spawn ever
   * sees — the spawn path then stays byte-for-byte what it was.
   */
  user?: string | null;
  /**
   * The HOME directory of the drop `user`. `setpriv` changes the uid but not
   * `$HOME`, so without this a dropped agent keeps the server's `HOME=/root` and
   * never reaches its per-group `~/.claude` (auth + skills break). Only ever set
   * alongside `user`; when `user` is unset this is ignored and HOME is left as
   * today. See `dropEnv` (`src/osusers.ts`).
   */
  home?: string | null;
  /**
   * The shared subscription token, injected as CLAUDE_CODE_OAUTH_TOKEN in the
   * forced-last layer. Honoured only together with `user` (see `forcedEnv`).
   */
  oauthToken?: string;
  /**
   * The server's gh token, injected as GH_TOKEN for a DROPPED agent (whose
   * `GH_CONFIG_DIR` is pointed at its own writable dir, away from the server's
   * unreachable `/root/.claude/gh`). Honoured only together with `user`.
   */
  ghToken?: string;
}

export interface WaitOptions {
  timeoutMs?: number;
}

/** The stability window for this poll: a fixed value, or whatever the getter
 *  says right now. */
export function windowMs(v: number | (() => number)): number {
  return typeof v === "function" ? v() : v;
}

export interface WaitIdleOptions extends WaitOptions {
  /**
   * How long the screen must stay unchanged to be considered "idle".
   *
   * A GETTER is accepted because the bar can change mid-wait: an explicit
   * interrupt arrives while we are already waiting, and from that moment the
   * end state is known rather than guessed. Read on every poll, so it takes
   * effect on the next one instead of at the next turn.
   */
  stableMs?: number | (() => number);
  /**
   * Names the dialog on a screen (`null` = none). When given, the wait ALSO
   * ends once the same dialog has held for `DIALOG_HOLD_MS`, even if the screen
   * never stops moving — a dialog can carry a per-second countdown, and then
   * `stableMs` is never met (see `settleStep`). The pilots stay ignorant of what
   * a dialog is; the caller, which owns that policy, supplies the reading.
   */
  settleOn?: (screen: string) => string | null;
}


/**
 * Drives an interactive `claude` session (the TUI) through a pseudo-terminal.
 *
 * The output stream is replayed into a headless virtual terminal
 * (@xterm/headless), which lets us read the screen as a human would see it
 * instead of parsing the raw ANSI escape stream.
 */
export class PtyPilot {
  private readonly opts: Required<Pick<PilotOptions, "cols" | "rows">> &
    PilotOptions;
  private proc: pty.IPty | null = null;
  private term: InstanceType<typeof Terminal>;
  private dataListeners = new Set<(chunk: string) => void>();
  private exitListeners = new Set<(code: number) => void>();
  private lastDataAt = 0;
  private exited = false;

  constructor(options: PilotOptions = {}) {
    this.opts = { cols: 100, rows: 40, ...options };
    this.term = new Terminal({
      cols: this.opts.cols,
      rows: this.opts.rows,
      scrollback: 10_000,
      allowProposedApi: true,
    });
  }

  /** Spawns the `claude` process inside a PTY. */
  start(): void {
    if (this.proc) throw new Error("Session already started.");
    // Strip variables from a possible parent Claude Code session: a nested
    // `claude` that detects them may disable its interactive mode.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (/^(CLAUDE|CLAUDECODE|AI_AGENT)/.test(k)) continue;
      if (isAgentCredentialVar(k)) continue;
      env[k] = v;
    }
    // Drop to the target group's OS user when one is set (node-pty has no uid
    // option, so we wrap the command in setpriv). `user` is only ever set in
    // multi-tenant — the gate lives in `makePilot` — so this branch is dead in
    // mono-tenant and the spawn below is unchanged.
    const bin0 = this.opts.claudePath ?? "claude";
    const args0 = this.opts.args ?? [];
    const drop = this.opts.user ? dropArgv(this.opts.user, bin0, args0) : null;
    this.proc = pty.spawn(drop ? drop.cmd : bin0, drop ? drop.argv : args0, {
      name: "xterm-256color",
      cols: this.opts.cols,
      rows: this.opts.rows,
      cwd: this.opts.cwd ?? process.cwd(),
      // `dropEnv` sets HOME/USER/LOGNAME to the drop user's own when we are
      // dropping privilege: setpriv changes the uid but not $HOME, so without
      // this the agent keeps the server's HOME=/root and never reaches its
      // per-group ~/.claude (auth + skills break). It goes AFTER `...env` (the
      // inherited process env, which carries the server's HOME) so it overrides
      // it, and is `{}` when no user is set, so the mono-tenant env is unchanged.
      // FORCED_CLAUDE_ENV goes LAST, after the profile's secrets: a transcript
      // is what the cockpit is made of, so nothing a profile carries may switch
      // it off, even by accident of naming.
      env: spawnEnv(this.opts, env),
    });
    this.proc.onData((chunk) => {
      this.lastDataAt = Date.now();
      this.term.write(chunk);
      for (const cb of this.dataListeners) cb(chunk);
    });
    // The app queries the terminal (cursor position, capabilities…) and
    // waits for the responses. xterm generates them through onData: forward
    // them back to the PTY so we behave like a real terminal.
    this.term.onData((response) => this.proc?.write(response));
    this.term.onBinary((response) => this.proc?.write(response));
    this.proc.onExit(({ exitCode }) => {
      this.exited = true;
      for (const cb of this.exitListeners) cb(exitCode);
    });
  }

  /** Raw stream (with ANSI sequences), useful for a "mirror" mode. */
  onData(cb: (chunk: string) => void): () => void {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  onExit(cb: (code: number) => void): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  get hasExited(): boolean {
    return this.exited;
  }

  /** The currently visible screen (the last rendered `rows` lines). */
  screen(): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    const start = buf.length - this.term.rows;
    for (let i = Math.max(0, start); i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  /** The whole terminal content, scrollback included. */
  fullBuffer(): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    // Drop trailing empty lines.
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.join("\n");
  }

  /** Writes text as-is into the TUI (without submitting). */
  write(text: string): void {
    if (!this.proc) throw new Error("Session not started.");
    this.proc.write(text);
  }

  /**
   * Types a prompt then presses Enter.
   *
   * The TUI flushes stdin received before its keyboard handler is ready:
   * we paste the text (bracketed paste) and retry until it shows up on
   * screen, clearing partial input (Ctrl-U) between attempts. Then we
   * verify the message actually went through (spinner visible or "❯ …"
   * echo in the transcript), with retries.
   */
  async submit(text: string, prelude?: string | string[]): Promise<void> {
    const typed = await typeIntoBox(
      {
        screen: () => this.screen(),
        paste: (t) => this.write(`\x1b[200~${t}\x1b[201~`),
        clearInput: () => this.write("\x15"), // Ctrl-U
        hardClear: () => this.press("ctrl-c"),
        waitFor: (p, o) => this.waitFor(p, o),
      },
      text,
      { prelude },
    );
    if (!typed) {
      throw this.submitError("not-typed");
    }
    await sleep(200);
    // Sent once the input box is empty again (or the spinner is up). Requiring
    // it to be truly empty makes the Enter retry robust to the bracketed-paste
    // race, and works for collapsed pastes (whose text is never on screen).
    // The WHOLE box, not its first line: a prompt that wrapped leaves its tail
    // on continuation lines, and `inputText` would read the emptied first line
    // as a box that is gone while the rest of the message is still sitting
    // there, unsent.
    const submitted = (s: string) => screenShowsWork(s) || boxText(s) === "";
    for (let attempt = 0; attempt < 3; attempt++) {
      this.press("enter");
      try {
        await this.waitFor(submitted, { timeoutMs: 3_000 });
        return;
      } catch {
        // Enter was swallowed by the TUI: try again.
      }
    }
    throw this.submitError("not-sent");
  }

  /** A concise client-facing error; the full screen goes to the server log only. */
  private submitError(failure: SubmitFailure): SubmitError {
    const screen = this.screen();
    const e = submitFailure(failure, screen);
    // The sentence without its "submit: " prefix and full stop: the line already says both.
    console.error(`submit failed — ${e.message.replace(/^submit: /, "").replace(/\.$/, "")}. Screen:\n${screen}`);
    return e;
  }

  press(key: "enter" | "escape" | "up" | "down" | "left" | "right" | "tab" | "ctrl-c"): void {
    const seq: Record<string, string> = {
      enter: "\r",
      escape: "\x1b",
      up: "\x1b[A",
      down: "\x1b[B",
      left: "\x1b[D",
      right: "\x1b[C",
      tab: "\t",
      "ctrl-c": "\x03",
    };
    this.write(seq[key]);
  }

  /** True when the TUI indicates that Claude is working. */
  isWorking(): boolean {
    return screenShowsWork(this.screen());
  }

  /** Waits until a predicate on the screen becomes true. */
  async waitFor(
    predicate: (screen: string) => boolean,
    { timeoutMs = 60_000 }: WaitOptions = {},
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exited) throw new Error("The claude process has exited.");
      const s = this.screen();
      if (predicate(s)) return s;
      await sleep(100);
    }
    throw new Error(
      `waitFor: timed out after ${timeoutMs} ms. Last screen:\n${this.screen()}`,
    );
  }

  /**
   * Waits until Claude is idle: no working marker on screen and the screen
   * stable for `stableMs`.
   */
  async waitForIdle({
    stableMs = 1_500,
    timeoutMs = 600_000,
    settleOn,
  }: WaitIdleOptions = {}): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastScreen = "";
    let stableSince = 0;
    let lastKey: string | null = null;
    let keySince = 0;
    while (Date.now() < deadline) {
      if (this.exited) throw new Error("The claude process has exited.");
      const s = this.screen();
      const now = Date.now();
      const step = idleStep(s, lastScreen, stableSince, now, windowMs(stableMs));
      if (step.done) return s;
      if (settleOn) {
        const settle = settleStep(s, settleOn(s), lastKey, keySince, now, DIALOG_HOLD_MS);
        if (settle.done) return s;
        lastKey = settle.lastKey;
        keySince = settle.since;
      }
      stableSince = step.stableSince;
      lastScreen = step.lastScreen;
      await sleep(150);
    }
    throw new Error(
      `waitForIdle: timed out after ${timeoutMs} ms. Last screen:\n${this.screen()}`,
    );
  }

  /** Waits for the process to exit (after /exit for example). */
  waitForExit({ timeoutMs = 15_000 }: WaitOptions = {}): Promise<number> {
    if (this.exited) return Promise.resolve(0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("waitForExit: timed out")),
        timeoutMs,
      );
      this.onExit((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  /** Clean shutdown: /exit, then kill if the process does not leave. */
  async stop(): Promise<void> {
    if (!this.proc || this.exited) return;
    try {
      await this.submit("/exit");
      await this.waitForExit({ timeoutMs: 8_000 });
    } catch {
      this.proc.kill();
    }
  }

  kill(): void {
    this.proc?.kill();
  }

  /** Twin of `TmuxPilot.abandon`. A PTY dies with us and can never be adopted
   *  again, so there is nothing to spare. */
  abandon(): void {
    this.kill();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

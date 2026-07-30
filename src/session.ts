import pty from "node-pty";
import xterm from "@xterm/headless";
import { screenShowsWork, inputText } from "./detect.js";

const { Terminal } = xterm;

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
}

export interface WaitOptions {
  timeoutMs?: number;
}

export interface WaitIdleOptions extends WaitOptions {
  /** How long the screen must stay unchanged to be considered "idle". */
  stableMs?: number;
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
      env[k] = v;
    }
    this.proc = pty.spawn(this.opts.claudePath ?? "claude", this.opts.args ?? [], {
      name: "xterm-256color",
      cols: this.opts.cols,
      rows: this.opts.rows,
      cwd: this.opts.cwd ?? process.cwd(),
      env: { ...env, TERM: "xterm-256color", ...this.opts.env },
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
  async submit(text: string): Promise<void> {
    let typed = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      this.write(`\x1b[200~${text}\x1b[201~`);
      try {
        // The box just needs to be non-empty — a big paste collapses to a
        // "[Pasted text +N lines]" placeholder, so looking for the literal text
        // fails and used to abort before Enter was pressed.
        await this.waitFor((s) => inputText(s) !== "", { timeoutMs: 2_000 });
        typed = true;
        break;
      } catch {
        this.write("\x15"); // Ctrl-U: clear any partial input.
        await sleep(300);
      }
    }
    if (!typed) {
      throw this.submitError("the text never appeared in the input box");
    }
    await sleep(200);
    // Sent once the input box is empty again (or the spinner is up) — robust to
    // the bracketed-paste race and to collapsed pastes.
    const submitted = (s: string) => screenShowsWork(s) || inputText(s) === "";
    for (let attempt = 0; attempt < 3; attempt++) {
      this.press("enter");
      try {
        await this.waitFor(submitted, { timeoutMs: 3_000 });
        return;
      } catch {
        // Enter was swallowed by the TUI: try again.
      }
    }
    throw this.submitError("the prompt does not seem to have been sent");
  }

  /** A concise client-facing error; the full screen goes to the server log only. */
  private submitError(reason: string): Error {
    console.error(`submit failed — ${reason}. Screen:\n${this.screen()}`);
    return new Error(`submit: ${reason}.`);
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
  }: WaitIdleOptions = {}): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastScreen = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      if (this.exited) throw new Error("The claude process has exited.");
      const s = this.screen();
      const working = screenShowsWork(s);
      if (!working && s === lastScreen) {
        if (stableSince === 0) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) return s;
      } else {
        stableSince = 0;
        lastScreen = s;
      }
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

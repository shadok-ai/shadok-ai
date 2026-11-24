import fs from "node:fs";
import path from "node:path";
import { LIVENESS_MS, linkReduce, maskPhone, reconnectDelayMs, type WaAccount, type WaLinkEvent, type WaLinkState } from "./wa-link.js";
import {
  ensureSessionDir,
  rememberAccount,
  storedAccount,
  wipeSession,
  type WaTransport,
  type WaTransportEvent,
  type WaTransportFactory,
} from "./wa-transport.js";
import { waAccountKey, type WaInbound } from "./wa-guests.js";

/**
 * The instance's WhatsApp handle: ONE transport at most, driven by the pure
 * reducer in `wa-link.ts`.
 *
 * Everything with a side effect lives here — starting and stopping the
 * transport, the backoff, the 15 s tick that drives the reducer's two
 * timeouts, the session directory — and everything that DECIDES lives in the
 * reducer. Two rules hold the rest together:
 *
 *  - every start is preceded by the previous transport's `stop()`, and all of
 *    them run through one promise chain, so a double click, an unlink racing a
 *    reconnect, or a timer firing late can never leave two sockets on one
 *    account;
 *  - every transport gets a generation number, and an event from a transport
 *    that is no longer the current one is dropped — a stopped socket that
 *    still emits must not move the state.
 *
 * Step 2 carries messages: inbound ones go to the listeners (`onMessage` —
 * the bridge, `wa-bridge.ts`, is the one consumer), and `sendText` /
 * `setTyping` / `resolveLid` go through the CURRENT transport, only while it
 * is connected — a send never reaches a socket that is being replaced.
 */

export interface WhatsAppHandle {
  state(): WaLinkState;
  link(): { ok: true } | { ok: false; error: string };
  /** From `halted`: resume the stored session (or start linking when there is none). */
  retry(): { ok: true } | { ok: false; error: string };
  cancel(): Promise<void>;
  /** Wipe the stored session (logging out on WhatsApp's side when a socket can).
   *  Not ok when nothing was there to remove, or when the wipe itself failed. */
  unlink(): Promise<{ ok: true } | { ok: false; error: string; nothing?: true }>;
  /** Is anything stored in the session directory? The panel offers Unlink
   *  whenever it is — in EVERY phase, unavailable included. */
  hasStoredSession(): boolean;
  /** Synchronous, for a DELIBERATE process exit (auto-update, reload): a resume
   *  cut short by one is not a crash, and must not trip the breaker. */
  releaseResumeGuard(): void;
  stop(): Promise<void>;
  /** Inbound messages from the current transport. Returns an unsubscribe. */
  onMessage(cb: (m: WaInbound) => void): () => void;
  /** Called on every transition INTO connected (a link, a reconnect, a boot
   *  resume): what the bridge replays its inbox on. */
  onConnected(cb: () => void): () => void;
  /** The linked number (`waAccountKey`), whenever one is known — connected,
   *  reconnecting, halted, or only stored on disk. Null when nothing is linked. */
  account(): string | null;
  sendText(to: string, text: string): Promise<void>;
  setTyping(to: string, on: boolean): Promise<void>;
  resolveLid(pn: string): Promise<string | null>;
  /** Resolves true once connected (at once if already), false after `ms`. */
  whenConnected(ms: number): Promise<boolean>;
}

export const TICK_MS = 15_000;
/** The boot breaker's marker, inside the session directory (so a wipe takes it). */
export const RESUME_MARK = ".resume-in-progress";
/** A resume counts as settled once the link has held `connected` this long. */
export const RESUME_SETTLE_MS = 60_000;
const CRASH_REASON =
  "the server stopped while this WhatsApp session was being resumed, so it was not resumed again automatically — Retry to try once more, or Link again";
/** A logout on a dead socket may never answer: the wipe must not wait for it. */
const LOGOUT_TIMEOUT_MS = 5_000;

type Timer = { cancel(): void };

function defaultSetTimer(fn: () => void, ms: number): Timer {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
}

/** A library's load failure, reduced to one line a panel can show. */
export function oneLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const first = msg.split("\n")[0].trim();
  return (first || "the WhatsApp library failed to load").slice(0, 200);
}

export function startWhatsApp(o: {
  sessionDir: string;
  /** The capability refusal, or null when allowed. A function is re-read on
   *  every tick: an instance's group migration completes AFTER boot, and the
   *  feature must open then without a restart. */
  refusal: string | null | (() => string | null);
  /** Rejects when the library cannot load. Called lazily — only when there is
   *  a stored session or someone asks to link — so an instance that never uses
   *  WhatsApp never loads it. */
  loadFactory: () => Promise<WaTransportFactory>;
  /** The on-demand library (`wa-library.ts`). Absent = always ready (tests,
   *  the fake). Installing is an ADMIN's act — a Link, a Retry — never a boot's:
   *  a boot that finds a stored session without its library halts and says so. */
  library?: { status(): "ready" | "absent" | "stale"; install(o?: { force?: boolean }): Promise<void> };
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  log?: (line: string) => void;
}): WhatsAppHandle {
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? defaultSetTimer;
  const log = o.log ?? ((l: string) => console.log(l));
  const refusalNow = () => (typeof o.refusal === "function" ? o.refusal() : o.refusal);

  let s: WaLinkState = { phase: "unlinked" };
  let transport: WaTransport | null = null;
  let gen = 0;
  let factory: Promise<WaTransportFactory> | null = null;
  let retry: Timer | null = null;
  let tickTimer: Timer | null = null;
  let stopped = false;
  /** Set while `unavailable` comes from the capability gate (lifts by itself),
   *  as opposed to the library (lasts as long as the process). */
  let refused = false;
  let chain: Promise<void> = Promise.resolve();
  /** When the current transport was started: a reconnect attempt that neither
   *  opens nor closes (a socket gone silent mid-handshake) is abandoned after
   *  LIVENESS_MS, or "retrying" would be a lie told for ever. */
  let attemptStartedAt = 0;
  /** Which install the state is waiting for: an Unlink, a refusal or a second
   *  Link in between makes an earlier install's outcome irrelevant. */
  let installSeq = 0;
  const messageListeners = new Set<(m: WaInbound) => void>();
  const connectedListeners = new Set<() => void>();

  const libReady = () => !o.library || o.library.status() === "ready";
  const libReason = () =>
    o.library?.status() === "stale"
      ? "the installed WhatsApp library is out of date (this release pins another version) — Install to reconnect"
      : "the WhatsApp library is not installed on this instance (the session was kept, the library was not) — Install to reconnect";

  /** Install, then `cont` — unless something else happened meanwhile. */
  function startInstall(then: "link" | "resume", force: boolean, cont: () => void) {
    cancelRetry();
    dispatch({ type: "install-requested", then });
    if (s.phase !== "installing") return;
    const mine = ++installSeq;
    const current = () => !stopped && mine === installSeq && s.phase === "installing";
    o.library!.install({ force }).then(
      () => {
        factory = null; // the next start loads the fresh copy
        if (current()) cont();
      },
      (e) => {
        if (current()) dispatch({ type: "halt", cause: "library", reason: `could not install the WhatsApp library: ${oneLine(e)}` });
      },
    );
  }

  // ── the boot breaker ─────────────────────────────────────────────────────
  // The worker contains whatever the library THROWS; a native crash still
  // takes the process. If that happens while the stored session is being
  // resumed, the next boot would resume it again — and crash again, on every
  // start. So a marker is written before any resume and removed once the link
  // has held `connected` for RESUME_SETTLE_MS, when the resume ends any other
  // way, or on a clean stop. Found at boot, it means "the last resume died with
  // the server": the link halts instead, and resuming is the admin's call.
  const markPath = path.join(o.sessionDir, RESUME_MARK);
  let armed = false;
  let settleTimer: Timer | null = null;
  function arm() {
    try {
      fs.writeFileSync(markPath, String(now()), { mode: 0o600 });
      armed = true;
    } catch (e) {
      log(`whatsapp: could not arm the resume breaker: ${oneLine(e)}`);
    }
  }
  function disarm() {
    settleTimer?.cancel();
    settleTimer = null;
    if (!armed) return;
    armed = false;
    try {
      fs.rmSync(markPath, { force: true });
    } catch {
      /* the wipe or the next arm will deal with it */
    }
  }
  function watchBreaker(prev: WaLinkState) {
    if (!armed) return;
    if (s.phase === "connected") {
      if (prev.phase !== "connected") {
        settleTimer?.cancel();
        settleTimer = setTimer(() => {
          settleTimer = null;
          if (s.phase === "connected") disarm();
        }, RESUME_SETTLE_MS);
      }
    } else if (s.phase !== "reconnecting") {
      disarm();
    }
  }

  const serial = (fn: () => Promise<void>): Promise<void> => {
    chain = chain.then(fn).catch((e) => {
      log(`whatsapp: ${oneLine(e)}`);
      // Safety net: whatever threw, a phase that promises a transport with no
      // transport behind it is a lie — say what failed instead.
      if (wantsTransport() && !transport) fail("an unexpected error stopped the link", e);
    });
    return chain;
  };

  /** A local failure the admin must see: halt (nothing retries) with the reason. */
  function fail(what: string, err: unknown) {
    cancelRetry();
    dispatch({ type: "halt", cause: "error", reason: `${what}: ${oneLine(err)}` });
  }

  function describe(st: WaLinkState): string {
    switch (st.phase) {
      case "unavailable":
        return `unavailable (${st.reason})`;
      case "connected":
        return `connected as ${maskPhone(st.account.phone) ?? "an unknown number"}`;
      case "reconnecting":
        return `reconnecting (attempt ${st.attempt})`;
      case "logged-out":
        return `logged-out (${st.detail})`;
      case "halted":
        return `halted, ${st.cause} (${st.reason})`;
      default:
        return st.phase;
    }
  }

  function dispatch(e: WaLinkEvent): WaLinkState {
    const prev = s;
    s = linkReduce(s, e, now());
    // One line per PHASE change: never the QR, never a full number.
    if (prev.phase !== s.phase) log(`whatsapp: ${prev.phase} → ${describe(s)}`);
    watchBreaker(prev);
    if (prev.phase !== "connected" && s.phase === "connected")
      for (const cb of [...connectedListeners]) {
        try {
          cb();
        } catch (err) {
          log(`whatsapp: a connected listener failed: ${oneLine(err)}`);
        }
      }
    return prev;
  }

  const wantsTransport = () => !stopped && (s.phase === "linking" || s.phase === "connected" || s.phase === "reconnecting");

  function cancelRetry() {
    retry?.cancel();
    retry = null;
  }

  async function stopTransport(): Promise<void> {
    gen++;
    const t = transport;
    transport = null;
    if (t) await t.stop().catch((e) => log(`whatsapp: stop failed: ${oneLine(e)}`));
  }

  function getFactory(): Promise<WaTransportFactory> {
    factory ??= o.loadFactory();
    return factory;
  }

  async function startTransport(): Promise<void> {
    await stopTransport();
    if (!wantsTransport()) return;
    let f: WaTransportFactory;
    try {
      f = await getFactory();
    } catch (e) {
      // The library will not load: say so, and leave the session on disk —
      // reinstalling it (Retry) must bring the link back, not a QR. Not cached:
      // the next attempt loads again.
      factory = null;
      cancelRetry();
      dispatch({ type: "halt", cause: "library", reason: oneLine(e) });
      return;
    }
    if (!wantsTransport()) return;
    try {
      ensureSessionDir(o.sessionDir);
    } catch (e) {
      fail("the session directory cannot be used", e);
      return;
    }
    const g = ++gen;
    let t: WaTransport;
    try {
      t = await f({ sessionDir: o.sessionDir });
    } catch (e) {
      onTransportEvent(g, { type: "close", reason: "error", detail: oneLine(e) });
      return;
    }
    if (g !== gen || !wantsTransport()) {
      await t.stop().catch(() => {});
      return;
    }
    transport = t;
    attemptStartedAt = now();
    try {
      await t.start((e) => onTransportEvent(g, e));
    } catch (e) {
      // A start that throws (an unreadable session file, a socket that cannot
      // open) is a failed attempt like any other: it must schedule the next
      // one, not leave the state on "reconnecting" with nothing behind it.
      onTransportEvent(g, { type: "close", reason: "error", detail: oneLine(e) });
    }
  }

  function scheduleStart(ms: number) {
    cancelRetry();
    if (ms <= 0) {
      void serial(startTransport);
      return;
    }
    retry = setTimer(() => {
      retry = null;
      void serial(startTransport);
    }, ms);
  }

  function onTransportEvent(g: number, e: WaTransportEvent) {
    if (g !== gen || stopped) return;
    switch (e.type) {
      case "qr":
        if (s.phase !== "linking") {
          // A QR on a resume means the library holds no usable session any
          // more: the link is over, and retrying would only rotate codes for
          // nobody. The real library usually says 401 instead; both land here.
          dispatch({ type: "close", reason: "logged-out", detail: "the stored session is no longer accepted" });
          cancelRetry();
          void serial(stopTransport);
          return;
        }
        dispatch(e);
        return;
      case "open":
        dispatch(e);
        if (s.phase === "connected") {
          try {
            rememberAccount(o.sessionDir, s.account, s.linkedAt);
          } catch (err) {
            log(`whatsapp: could not record the account: ${oneLine(err)}`);
          }
        } else {
          void serial(stopTransport);
        }
        return;
      case "alive":
        dispatch(e);
        return;
      case "message":
        // A frame from the server is a sign of life like any other.
        dispatch({ type: "alive" });
        for (const cb of [...messageListeners]) {
          try {
            cb(e.msg);
          } catch (err) {
            log(`whatsapp: a message listener failed: ${oneLine(err)}`);
          }
        }
        return;
      case "close":
        dispatch(e);
        if (e.reason === "logged-out" || e.reason === "fatal") {
          // For good: the admin decides what comes next (link again or unlink).
          cancelRetry();
          void serial(stopTransport);
          return;
        }
        if (!wantsTransport()) return;
        void serial(stopTransport);
        if (e.reason === "restart") scheduleStart(0);
        else scheduleStart(reconnectDelayMs(s.phase === "reconnecting" ? s.attempt : 1));
        return;
    }
  }

  function hasStoredSession(): boolean {
    try {
      const st = fs.lstatSync(o.sessionDir);
      return st.isSymbolicLink() || (st.isDirectory() && fs.readdirSync(o.sessionDir).length > 0);
    } catch {
      return false;
    }
  }

  /** The state a fresh look at the disk gives, once allowed. */
  function resumeStored(stored: { account: WaAccount; linkedAt: number }) {
    cancelRetry();
    arm();
    dispatch({ type: "stored-session", ...stored });
    scheduleStart(0);
  }

  /** A stored session whose library is missing or stale: said, not installed. */
  function haltForLibrary(stored: { account: WaAccount; linkedAt: number }) {
    dispatch({ type: "stored-session", ...stored });
    dispatch({ type: "halt", cause: "library", reason: libReason() });
  }

  function resume() {
    const stored = storedAccount(o.sessionDir);
    if (stored && !libReady()) haltForLibrary(stored);
    else if (stored) resumeStored(stored);
    else dispatch({ type: "unlinked" });
  }

  function tick() {
    tickTimer = null;
    if (stopped) return;
    const refusal = refusalNow();
    if (refusal && !(s.phase === "unavailable" && refused)) {
      refused = true;
      cancelRetry();
      dispatch({ type: "unavailable", reason: refusal });
      void serial(stopTransport);
    } else if (!refusal && refused) {
      refused = false;
      resume();
    } else {
      const prev = dispatch({ type: "tick" });
      if (prev.phase === "linking" && s.phase === "unlinked") {
        // Nobody scanned: stop rotating codes.
        cancelRetry();
        void serial(stopTransport);
      } else if (prev.phase === "connected" && s.phase === "reconnecting") {
        // Silent too long: the socket is dead even though it never said so.
        void serial(stopTransport);
        scheduleStart(reconnectDelayMs(1));
      } else if (s.phase === "reconnecting" && transport && now() - attemptStartedAt > LIVENESS_MS) {
        // An attempt that never opened and never closed: count it as lost.
        onTransportEvent(gen, { type: "close", reason: "lost", detail: "the connection attempt never completed" });
      }
    }
    tickTimer = setTimer(tick, TICK_MS);
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  const boot = refusalNow();
  if (boot) {
    refused = true;
    s = { phase: "unavailable", reason: boot };
    log(`whatsapp: ${describe(s)}`);
  } else {
    const stored = storedAccount(o.sessionDir);
    if (stored && fs.existsSync(markPath)) {
      // The marker stays until the admin acts (Retry re-arms it, Unlink and
      // Link again wipe it): a halted boot must not become a resuming one at
      // the start after.
      dispatch({ type: "stored-session", ...stored });
      dispatch({ type: "halt", cause: "crash", reason: CRASH_REASON });
    } else if (stored && !libReady()) {
      haltForLibrary(stored);
    } else if (stored) {
      resumeStored(stored);
    }
  }
  tickTimer = setTimer(tick, TICK_MS);

  function link(): { ok: true } | { ok: false; error: string } {
    const refusal = refusalNow();
    if (refusal) return { ok: false, error: refusal };
    if (s.phase === "unavailable") return { ok: false, error: s.reason };
    if (s.phase === "linking" || s.phase === "connected" || s.phase === "reconnecting" || s.phase === "installing") return { ok: true };
    // A library that installed but would not load is installed again.
    const force = !!o.library && s.phase === "halted" && s.cause === "library" && libReady();
    if (force || !libReady()) startInstall("link", force, linkNow);
    else linkNow();
    return { ok: true };
  }

  function linkNow() {
    cancelRetry();
    dispatch({ type: "link-requested" });
    void serial(async () => {
      await stopTransport();
      // A fresh link never reuses half a session (a logged-out one, or the
      // keys a previous unscanned QR left behind).
      try {
        ensureSessionDir(o.sessionDir);
        wipeSession(o.sessionDir);
      } catch (e) {
        fail("the session directory cannot be prepared", e);
        return;
      }
      await startTransport();
    });
  }

  const live = (): WaTransport => {
    if (stopped || s.phase !== "connected" || !transport) throw new Error("WhatsApp is not connected");
    return transport;
  };

  return {
    state: () => s,

    onMessage(cb) {
      messageListeners.add(cb);
      return () => void messageListeners.delete(cb);
    },
    onConnected(cb) {
      connectedListeners.add(cb);
      return () => void connectedListeners.delete(cb);
    },
    account() {
      const a = "account" in s ? s.account : undefined;
      return waAccountKey(a ?? storedAccount(o.sessionDir)?.account);
    },
    async sendText(to, text) {
      await live().sendText(to, text);
    },
    async setTyping(to, on) {
      await live().setTyping(to, on);
    },
    async resolveLid(pn) {
      return live().resolveLid(pn);
    },
    whenConnected(ms) {
      if (!stopped && s.phase === "connected" && transport) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (v: boolean) => {
          if (done) return;
          done = true;
          off();
          timer.cancel();
          resolve(v);
        };
        connectedListeners.add(onOpen);
        function onOpen() {
          finish(true);
        }
        const off = () => connectedListeners.delete(onOpen);
        const timer = setTimer(() => finish(false), ms);
      });
    },

    link,

    retry() {
      const refusal = refusalNow();
      if (refusal) return { ok: false, error: refusal };
      if (s.phase !== "halted") return { ok: false, error: `nothing to retry (the link is ${s.phase})` };
      const stored = storedAccount(o.sessionDir);
      // Nothing stored to resume (a linking that failed): retrying is linking.
      if (!stored) return link();
      const force = !!o.library && s.cause === "library" && libReady();
      if (force || !libReady())
        startInstall("resume", force, () => {
          const again = storedAccount(o.sessionDir);
          if (again) resumeStored(again);
          else dispatch({ type: "unlinked" });
        });
      else resumeStored(stored);
      return { ok: true };
    },

    cancel() {
      if (s.phase !== "linking") return chain;
      cancelRetry();
      dispatch({ type: "cancel" });
      return serial(async () => {
        await stopTransport();
        try {
          wipeSession(o.sessionDir);
        } catch (e) {
          fail("could not delete the half-made session", e);
        }
      });
    },

    unlink() {
      cancelRetry();
      let result: { ok: true } | { ok: false; error: string; nothing?: true } = { ok: true };
      return serial(async () => {
        const t = transport;
        // From here on that transport's events are noise: the library's own
        // logout closes the socket with "logged out", which must not flash a
        // "Unlinked remotely" on the way to "Not linked".
        gen++;
        if (t) {
          // Logging out tells WhatsApp to forget this device. It may fail (no
          // network, a dead socket): the local session is wiped regardless, so
          // Unlink always means "this instance holds no credentials any more".
          try {
            await new Promise<void>((resolve, reject) => {
              const guard = setTimer(() => reject(new Error("timed out")), LOGOUT_TIMEOUT_MS);
              t.logout().then(
                () => (guard.cancel(), resolve()),
                (e) => (guard.cancel(), reject(e)),
              );
            });
          } catch (e) {
            log(`whatsapp: logout failed, wiping the local session anyway: ${oneLine(e)}`);
          }
        }
        await stopTransport();
        const had = hasStoredSession();
        if (!had && !t && (s.phase === "unlinked" || s.phase === "unavailable")) {
          result = { ok: false, error: "no WhatsApp session is stored on this instance", nothing: true };
          return;
        }
        try {
          wipeSession(o.sessionDir);
        } catch (e) {
          fail("could not delete the stored session", e);
          result = { ok: false, error: `could not delete the stored session: ${oneLine(e)}` };
          return;
        }
        // Unavailable is about the process (a refused deployment) and
        // stays the truth after the wipe: only the credential is gone. Wiping
        // there matters MORE than anywhere — a refused instance may run agents
        // as the server's user, who could read it.
        if (s.phase !== "unavailable") dispatch({ type: "unlinked" });
        else log("whatsapp: stored session wiped while unavailable");
      }).then(() => result);
    },

    hasStoredSession,

    releaseResumeGuard: disarm,

    stop() {
      disarm();
      stopped = true;
      cancelRetry();
      tickTimer?.cancel();
      tickTimer = null;
      return serial(stopTransport);
    },
  };
}

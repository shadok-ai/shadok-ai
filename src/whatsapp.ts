import { LIVENESS_MS, linkReduce, maskPhone, reconnectDelayMs, type WaLinkEvent, type WaLinkState } from "./wa-link.js";
import {
  ensureSessionDir,
  rememberAccount,
  storedAccount,
  wipeSession,
  type WaTransport,
  type WaTransportEvent,
  type WaTransportFactory,
} from "./wa-transport.js";

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
 * Step 1 only links. Messages arrive in step 2.
 */

export interface WhatsAppHandle {
  state(): WaLinkState;
  link(): { ok: true } | { ok: false; error: string };
  /** From `halted`: resume the stored session (or start linking when there is none). */
  retry(): { ok: true } | { ok: false; error: string };
  cancel(): Promise<void>;
  unlink(): Promise<void>;
  stop(): Promise<void>;
}

export const TICK_MS = 15_000;
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
  /** Rejects when the library is absent. Called lazily — only when there is a
   *  stored session or someone asks to link — so an instance that never uses
   *  WhatsApp never loads it. */
  loadFactory: () => Promise<WaTransportFactory>;
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

  const serial = (fn: () => Promise<void>): Promise<void> => {
    chain = chain.then(fn).catch((e) => log(`whatsapp: ${oneLine(e)}`));
    return chain;
  };

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
      // The library is absent or broken: say so, and leave the session on disk
      // — installing the library must bring the link back, not a QR.
      dispatch({ type: "unavailable", reason: oneLine(e) });
      return;
    }
    if (!wantsTransport()) return;
    ensureSessionDir(o.sessionDir);
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

  /** The state a fresh look at the disk gives, once allowed. */
  function resume() {
    const stored = storedAccount(o.sessionDir);
    if (stored) {
      dispatch({ type: "stored-session", ...stored });
      scheduleStart(0);
    } else {
      dispatch({ type: "unlinked" });
    }
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
    if (stored) {
      dispatch({ type: "stored-session", ...stored });
      scheduleStart(0);
    }
  }
  tickTimer = setTimer(tick, TICK_MS);

  function link(): { ok: true } | { ok: false; error: string } {
    const refusal = refusalNow();
    if (refusal) return { ok: false, error: refusal };
    if (s.phase === "unavailable") return { ok: false, error: s.reason };
    if (s.phase === "linking" || s.phase === "connected" || s.phase === "reconnecting") return { ok: true };
    cancelRetry();
    dispatch({ type: "link-requested" });
    void serial(async () => {
      await stopTransport();
      // A fresh link never reuses half a session (a logged-out one, or the
      // keys a previous unscanned QR left behind).
      ensureSessionDir(o.sessionDir);
      wipeSession(o.sessionDir);
      await startTransport();
    });
    return { ok: true };
  }

  return {
    state: () => s,

    link,

    retry() {
      const refusal = refusalNow();
      if (refusal) return { ok: false, error: refusal };
      if (s.phase !== "halted") return { ok: false, error: `nothing to retry (the link is ${s.phase})` };
      const stored = storedAccount(o.sessionDir);
      // Nothing stored to resume (a linking that failed): retrying is linking.
      if (!stored) return link();
      cancelRetry();
      dispatch({ type: "stored-session", ...stored });
      scheduleStart(0);
      return { ok: true };
    },

    cancel() {
      if (s.phase !== "linking") return chain;
      cancelRetry();
      dispatch({ type: "cancel" });
      return serial(async () => {
        await stopTransport();
        wipeSession(o.sessionDir);
      });
    },

    unlink() {
      if (s.phase === "unavailable") return chain;
      cancelRetry();
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
        wipeSession(o.sessionDir);
        dispatch({ type: "unlinked" });
      });
    },

    stop() {
      stopped = true;
      cancelRetry();
      tickTimer?.cancel();
      tickTimer = null;
      return serial(stopTransport);
    },
  };
}

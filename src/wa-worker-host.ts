import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { WaTransport, WaTransportEvent, WaTransportFactory } from "./wa-transport.js";

/**
 * Runs a WhatsApp transport in a WORKER THREAD.
 *
 * Why a thread: the library's socket code runs async work outside every try
 * of ours, and an unhandled rejection there exits the whole process — the
 * cockpit, every bridge, every node-pty agent — and with the boot resuming a
 * stored session, it does so again on every start. Catching that at process
 * level (an unhandledRejection listener on `process`) would change what the server does
 * for EVERY error, not only this library's, and could only guess an error's
 * origin from its stack. A worker contains it by construction: whatever the
 * library throws ends its thread, the host sees `error`/`exit`, and that
 * becomes one `close{error}` the handle already knows how to retry. What a
 * worker does NOT contain is a native crash (a segfault takes the process);
 * the boot breaker in `whatsapp.ts` is for that.
 *
 * One worker per transport, ended by `stop()`. A start therefore costs a
 * library load (~1 s); reconnects are rare and backed off, and a fresh thread
 * per attempt means no state survives from the attempt that failed.
 */

export interface WorkerSpec {
  /** A module URL, set by server code only — never from a request. */
  modulePath: string;
  /** Its loader export: `() => Promise<WaTransportFactory>`. */
  exportName: string;
}

const HERE = fileURLToPath(import.meta.url);
// The worker is a sibling file: `wa-worker.js` in a build. Running from source
// (tests), a bootstrap registers the TypeScript loader inside the worker first
// — Node 20 does not pass `--import tsx` on to a worker (wa-worker-tsx.mjs).
const WORKER_URL =
  path.extname(HERE) === ".ts" ? new URL("./wa-worker-tsx.mjs", import.meta.url) : new URL("./wa-worker.js", import.meta.url);

/** Must exceed the adapter's own write drain (5 s), so `stop()` lets it finish. */
const STOP_GRACE_MS = 7_000;
const READY_MS = 60_000;

function oneLine(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return (m.split("\n")[0].trim() || "unknown error").slice(0, 200);
}

function spawn(data: Record<string, unknown>): Promise<Worker> {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_URL, { workerData: data });
    // A worker must never be what keeps the server alive, nor what stops it exiting.
    w.unref();
    const timer = setTimeout(() => {
      void w.terminate();
      reject(new Error("the WhatsApp worker did not start in time"));
    }, READY_MS);
    timer.unref();
    const onMessage = (m: { ready?: boolean }) => {
      if (!m?.ready) return;
      cleanup();
      resolve(w);
    };
    const onError = (e: unknown) => {
      cleanup();
      void w.terminate();
      reject(new Error(oneLine(e)));
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`the WhatsApp worker exited before it was ready (${code})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      w.off("message", onMessage);
      w.off("error", onError);
      w.off("exit", onExit);
    };
    w.on("message", onMessage);
    w.on("error", onError);
    w.on("exit", onExit);
  });
}

/** Load the module and its loader in a throwaway worker: rejects with the
 *  loader's own message when the library is absent or cannot load. */
export async function probeInWorker(spec: WorkerSpec): Promise<void> {
  const w = await spawn({ ...spec, probe: true });
  await w.terminate();
}

export function workerTransportFactory(spec: WorkerSpec): WaTransportFactory {
  return async ({ sessionDir }) => {
    const w = await spawn({ ...spec, sessionDir });
    let on: ((e: WaTransportEvent) => void) | null = null;
    let dead = false;
    let stopping = false;
    let seq = 0;
    const waiting = new Map<number, { cmd: string; resolve: () => void; reject: (e: Error) => void }>();

    w.on("message", (m: { ev?: WaTransportEvent; id?: number; ok?: boolean; error?: string }) => {
      if (m.ev) {
        if (!stopping && !dead && on) on(m.ev);
        return;
      }
      const p = m.id !== undefined ? waiting.get(m.id) : undefined;
      if (!p) return;
      waiting.delete(m.id!);
      if (m.ok) p.resolve();
      else p.reject(new Error(m.error ?? "failed"));
    });

    // The library died. ONE close, reported once; a pending `start` resolves
    // (its failure IS that close), anything else rejects.
    const died = (detail: string) => {
      if (dead) return;
      dead = true;
      const report = !stopping && on !== null;
      for (const [id, p] of waiting) {
        waiting.delete(id);
        if (p.cmd === "start" && report) p.resolve();
        else p.reject(new Error(detail));
      }
      if (report) on!({ type: "close", reason: "error", detail });
    };
    w.on("error", (e) => died(`the WhatsApp library failed: ${oneLine(e)}`));
    w.on("exit", (code) => died(`the WhatsApp library stopped unexpectedly (exit ${code})`));

    const call = (cmd: "start" | "logout" | "stop") =>
      new Promise<void>((resolve, reject) => {
        if (dead) return reject(new Error("the WhatsApp worker is gone"));
        const id = ++seq;
        waiting.set(id, { cmd, resolve, reject });
        w.postMessage({ id, cmd });
      });

    const t: WaTransport = {
      async start(cb) {
        on = cb;
        await call("start");
      },
      logout: () => call("logout"),
      async stop() {
        stopping = true;
        if (!dead) {
          // Let the adapter drain its credential writes before the thread goes:
          // terminating first could cut a write in half.
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([
            call("stop").catch(() => {}),
            new Promise((r) => {
              timer = setTimeout(r, STOP_GRACE_MS);
            }),
          ]);
          clearTimeout(timer);
        }
        await w.terminate();
      },
    };
    return t;
  };
}

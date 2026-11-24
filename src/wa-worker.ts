import { parentPort, workerData } from "node:worker_threads";
import type { WaTransport, WaTransportFactory } from "./wa-transport.js";

/**
 * The worker-thread side of `wa-worker-host.ts`: loads ONE transport module
 * (named by the host, never by a frame) and runs it here, so an error raised
 * inside the library's own code — an unhandled rejection in its socket
 * handling, a throw from one of its timers — ends THIS thread, not the server.
 *
 * Deliberately no error handler of its own: letting such an error kill the
 * worker is the mechanism. The host sees the worker's `error`/`exit` and turns
 * it into a transport `close{error}`.
 */

interface Spec {
  modulePath: string;
  exportName: string;
  arg?: string;
  sessionDir?: string;
  probe?: boolean;
}
type Cmd = { id: number; cmd: "start" | "logout" | "stop" };

const port = parentPort!;
const spec = workerData as Spec;
const mod = (await import(spec.modulePath)) as Record<string, (arg?: string) => Promise<WaTransportFactory>>;
const factory = await mod[spec.exportName](spec.arg);

if (spec.probe) {
  port.postMessage({ ready: true });
} else {
  const t: WaTransport = await factory({ sessionDir: spec.sessionDir! });
  port.on("message", (m: Cmd) => {
    const run =
      m.cmd === "start" ? t.start((e) => port.postMessage({ ev: e })) : m.cmd === "logout" ? t.logout() : t.stop();
    run.then(
      () => port.postMessage({ id: m.id, ok: true }),
      (e: unknown) => port.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
  });
  port.postMessage({ ready: true });
}

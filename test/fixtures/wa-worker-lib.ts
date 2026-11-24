// Stand-ins for a WhatsApp library, loaded INSIDE the worker by
// test/wa-worker.test.ts. Each export is a loader, like `loadBaileysInProcess`.
import fs from "node:fs";
import path from "node:path";
import type { WaTransportFactory } from "../../src/wa-transport.js";

/** Behaves: a QR on start, then open after a "scan" written to disk. */
export async function loadGood(): Promise<WaTransportFactory> {
  return async ({ sessionDir }) => ({
    async start(on) {
      if (fs.existsSync(path.join(sessionDir, "creds"))) on({ type: "open", account: { id: "33600000000@s.whatsapp.net", phone: "33600000000" } });
      else on({ type: "qr", payload: "worker-qr", ttlMs: 60_000 });
    },
    async logout() {},
    async stop() {},
  });
}

/** Rejects a promise nobody awaits, from deep inside "its socket code". */
export async function loadRejecting(): Promise<WaTransportFactory> {
  return async () => ({
    async start(on) {
      on({ type: "qr", payload: "q", ttlMs: 60_000 });
      setTimeout(() => void Promise.reject(new Error("boom inside the library's socket code")), 20);
    },
    async logout() {},
    async stop() {},
  });
}

/** Throws from a timer: an uncaught exception, not a rejection. */
export async function loadThrowing(): Promise<WaTransportFactory> {
  return async () => ({
    async start() {
      setTimeout(() => {
        throw new Error("uncaught inside the library");
      }, 20);
    },
    async logout() {},
    async stop() {},
  });
}

/** The library is not installed. */
export async function loadAbsent(): Promise<WaTransportFactory> {
  throw new Error("Cannot find package 'baileys'");
}

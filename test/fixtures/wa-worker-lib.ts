// Stand-ins for a WhatsApp library, loaded INSIDE the worker by
// test/wa-worker.test.ts. Each export is a loader, like `loadBaileysInProcess`.
import fs from "node:fs";
import path from "node:path";
import type { WaTransportFactory } from "../../src/wa-transport.js";

const STUB_MESSAGING = {
  async sendText() {},
  async setTyping() {},
  async markRead() {},
  async resolveLid() {
    return null;
  },
  async downloadMedia(): Promise<Uint8Array> {
    throw new Error("no media");
  },
  async sendFile() {},
};

/** Behaves: a QR on start, then open after a "scan" written to disk. */
export async function loadGood(): Promise<WaTransportFactory> {
  return async ({ sessionDir }) => {
    let emit: ((e: Parameters<Parameters<Awaited<ReturnType<WaTransportFactory>>["start"]>[0]>[0]) => void) | null = null;
    return {
      async start(on) {
        emit = on;
        if (fs.existsSync(path.join(sessionDir, "creds"))) on({ type: "open", account: { id: "33600000000@s.whatsapp.net", phone: "33600000000" } });
        else on({ type: "qr", payload: "worker-qr", ttlMs: 60_000 });
      },
      async logout() {},
      async stop() {},
      async sendText(to, text) {
        emit?.({ type: "message", msg: { id: "echo", chat: to, fromMe: true, live: true, unreadable: false, text: `sent:${text}`, at: 0 } });
      },
      async setTyping() {},
      async markRead(chat, id) {
        emit?.({ type: "message", msg: { id: "read", chat, fromMe: true, live: true, unreadable: false, text: `read:${id}`, at: 0 } });
      },
      async resolveLid(pn) {
        return pn === "33611111111@s.whatsapp.net" ? "100000000000001@lid" : null;
      },
      async downloadMedia(id) {
        return Buffer.from(`bytes-of-${id}`);
      },
      async sendFile(to, f) {
        emit?.({ type: "message", msg: { id: "file", chat: to, fromMe: true, live: true, unreadable: false, text: `file:${f.name}:${Buffer.from(f.data).length}`, at: 0 } });
      },
    };
  };
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
    ...STUB_MESSAGING,
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
    ...STUB_MESSAGING,
  });
}

/** The library is not installed. */
export async function loadAbsent(): Promise<WaTransportFactory> {
  throw new Error("Cannot find package 'baileys'");
}

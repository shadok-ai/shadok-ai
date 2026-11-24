import fs from "node:fs";
import path from "node:path";
import type { WaAccount } from "./wa-link.js";
import type { WaTransport, WaTransportEvent, WaTransportFactory } from "./wa-transport.js";
import type { RunCommand } from "./wa-library.js";

/**
 * A WhatsApp transport with no WhatsApp behind it, driven by a script.
 *
 * It exists so the link can be tested — in unit tests AND in a browser on a
 * side instance (`SHADOK_WA_FAKE=1`) — without a phone. It models what the
 * spike observed of the real thing: a QR on a start with no session (60 s for
 * the first, 20 s after), the "restart required" close right after a scan, a
 * silent resume on the stored session, and a logout from the phone.
 *
 * Its "credentials" are a file of its own (`fake-creds.json`), standing for
 * the library's files: the handle's `account.json` is a different thing, and
 * keeping the two apart is what lets a restart test mean something.
 */

export interface FakeScript {
  /** The admin scanned the QR: the server closes with "restart required" and the next start opens. */
  scan(account?: WaAccount): void;
  /** The socket died with a close event. */
  drop(): void;
  /** The socket died WITHOUT a close event: nothing more is ever emitted. */
  goSilent(): void;
  /** The device was removed from the phone's "Linked devices". */
  removeFromPhone(): void;
  /** The QR rotated. */
  rotateQr(): void;
  /** Sign of life from the server (an inbound stanza). */
  ping(): void;
  /** The next `logout()` rejects, as a network failure would. */
  failNextLogout(): void;
  /** WhatsApp refuses for good (banned, connection replaced, bad session). */
  fatal(detail?: string): void;
  /** The network is down: the current socket goes silent AND every later
   *  start stays silent, until `online()`. `goSilent` only kills one socket,
   *  which the next start replaces at once — too brief to watch a panel say
   *  "reconnecting". */
  offline(): void;
  online(): void;
}

const CREDS = "fake-creds.json";
const DEFAULT_ACCOUNT: WaAccount = { id: "33600000000:1@s.whatsapp.net", name: "Ada's shop", phone: "33600000000" };

function readCreds(dir: string): WaAccount | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, CREDS), "utf8")) as WaAccount;
  } catch {
    return null;
  }
}

export function makeFakeTransport(): { factory: WaTransportFactory; script: FakeScript; starts: number; stops: number } {
  let starts = 0;
  let stops = 0;
  let qrSeq = 0;
  let failLogout = false;
  let offline = false;
  // Only the most recently started, not yet stopped transport is scriptable:
  // a stopped one must never emit again, exactly like a closed socket.
  let current: { dir: string; emit: (e: WaTransportEvent) => void; silent: boolean; qrs: number } | null = null;

  const emit = (e: WaTransportEvent) => {
    if (current && !current.silent) current.emit(e);
  };
  const nextQr = () => {
    if (!current || current.silent) return;
    const ttlMs = current.qrs === 0 ? 60_000 : 20_000;
    current.qrs++;
    emit({ type: "qr", payload: `fake-qr-${++qrSeq}`, ttlMs });
  };

  const factory: WaTransportFactory = async ({ sessionDir }) => {
    let mine: typeof current = null;
    const t: WaTransport = {
      async start(on) {
        starts++;
        mine = { dir: sessionDir, emit: on, silent: offline, qrs: 0 };
        current = mine;
        const creds = readCreds(sessionDir);
        if (creds) emit({ type: "open", account: creds });
        else nextQr();
      },
      async logout() {
        if (failLogout) {
          failLogout = false;
          throw new Error("fake: logout failed (network)");
        }
        fs.rmSync(path.join(sessionDir, CREDS), { force: true });
      },
      async stop() {
        stops++;
        if (current === mine) current = null;
        mine = null;
      },
    };
    return t;
  };

  const script: FakeScript = {
    scan(account = DEFAULT_ACCOUNT) {
      if (!current || current.silent) return;
      fs.writeFileSync(path.join(current.dir, CREDS), JSON.stringify(account), { mode: 0o600 });
      emit({ type: "close", reason: "restart" });
    },
    drop() {
      emit({ type: "close", reason: "lost" });
    },
    goSilent() {
      if (current) current.silent = true;
    },
    removeFromPhone() {
      if (!current || current.silent) return;
      fs.rmSync(path.join(current.dir, CREDS), { force: true });
      emit({ type: "close", reason: "logged-out", detail: "the device was removed from the phone" });
    },
    rotateQr() {
      nextQr();
    },
    ping() {
      emit({ type: "alive" });
    },
    failNextLogout() {
      failLogout = true;
    },
    fatal(detail = "connection replaced: this number was connected again elsewhere") {
      emit({ type: "close", reason: "fatal", detail });
    },
    offline() {
      offline = true;
      if (current) current.silent = true;
    },
    online() {
      offline = false;
    },
  };

  return {
    factory,
    script,
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
  };
}

/**
 * The installer's fake, for `SHADOK_WA_FAKE=1` only: waits like npm would, then
 * writes the pinned packages' manifests (enough for the installer's version
 * check) — or fails the way a machine with no network does (`mode: "fail"`).
 * The real `wa-library.ts` runs around it: staging, verify, marker, rename.
 */
export function fakeInstallRunner(mode: string | undefined, ms = 3_000): RunCommand {
  return async (_cmd, _args, { cwd }) => {
    await new Promise((r) => setTimeout(r, ms));
    if (mode === "fail")
      throw Object.assign(new Error("npm ci exited with code 1"), {
        stderr: "npm error code ENOTFOUND\nnpm error network request to the registry failed (fake installer)",
      });
    const deps = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).dependencies as Record<string, string>;
    for (const [name, version] of Object.entries(deps)) {
      fs.mkdirSync(path.join(cwd, "node_modules", name), { recursive: true });
      fs.writeFileSync(path.join(cwd, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
    }
  };
}

/** A QR encoder's stand-in for the fake: a grid drawn from the payload, so a
 *  rotation visibly changes it. Not scannable, and not meant to be. */
export async function fakeQrEncoder(): Promise<{ toString(t: string): Promise<string> }> {
  return {
    async toString(t: string) {
      const n = 21;
      let d = "";
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) if ((t.charCodeAt((x * 7 + y * 13) % t.length) + x * y) % 3 === 0) d += `M${x} ${y}h1v1h-1z`;
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}"><path fill="#000" d="${d}"/></svg>`;
    },
  };
}

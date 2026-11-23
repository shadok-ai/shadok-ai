import fs from "node:fs";
import path from "node:path";
import type { WaAccount } from "./wa-link.js";

/**
 * The seam between shadok and whatever WhatsApp library sits behind it.
 *
 * The server, the handle and the panel import THIS file, never a library: the
 * library is not chosen for good yet (see the design's "The library"), it is an
 * optional dependency that may be absent, and a fake transport (`wa-fake.ts`)
 * is the only way to exercise the link without a phone. Only `wa-baileys.ts`
 * may import the library itself; a test scans for it.
 *
 * Step 1 covers linking only. The message-carrying half of the seam (inbound
 * events, sendText, sendFile, setTyping) arrives with step 2.
 */

export type WaTransportEvent =
  | { type: "qr"; payload: string; ttlMs: number }
  | { type: "open"; account: WaAccount }
  | { type: "alive" }
  | { type: "close"; reason: "restart" | "lost" | "logged-out" | "error"; detail?: string };

export interface WaTransport {
  /** Connect (or resume the stored session). Events until `stop`. */
  start(on: (e: WaTransportEvent) => void): Promise<void>;
  /** Log this device out on WhatsApp's side. May reject; the caller wipes the session either way. */
  logout(): Promise<void>;
  stop(): Promise<void>;
}

export type WaTransportFactory = (o: { sessionDir: string }) => Promise<WaTransport>;

/** The stored session IS the WhatsApp account: one directory per instance, on
 *  the data volume, so a container recreate does not unlink the number. */
export function waSessionDir(home: string, instanceKey: string): string {
  return path.join(home, ".shadok-ai", "whatsapp", instanceKey);
}

/** mkdir -p with 0700, re-asserted when the directory already exists — a
 *  directory created looser by hand or by an older build is tightened, not
 *  trusted. A symlink in its place is refused: the session would then live
 *  wherever the link points, with whatever rights that place has. */
export function ensureSessionDir(dir: string): void {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`refusing a symlinked WhatsApp session directory: ${dir}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

const ACCOUNT_FILE = "account.json";

/** Is there a stored session, and whose? Reads only what the handle wrote
 *  through `rememberAccount` — never the library's own files, whose layout is
 *  the library's business and changes with it. */
export function storedAccount(dir: string): { account: WaAccount; linkedAt: number } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, ACCOUNT_FILE), "utf8"));
  } catch {
    return null;
  }
  const r = raw as { account?: Record<string, unknown>; linkedAt?: unknown };
  const a = r?.account;
  if (!a || typeof a.id !== "string" || typeof r.linkedAt !== "number") return null;
  const account: WaAccount = { id: a.id };
  if (typeof a.name === "string") account.name = a.name;
  if (typeof a.phone === "string") account.phone = a.phone;
  return { account, linkedAt: r.linkedAt };
}

export function rememberAccount(dir: string, account: WaAccount, linkedAt: number): void {
  const file = path.join(dir, ACCOUNT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ account, linkedAt }) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Remove the directory's content (the directory itself stays, 0700). Never
 *  follows a symlink out of it: a link is unlinked, not its target. */
export function wipeSession(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    // `rmSync` uses lstat itself, so a symlink nested deeper is removed as a
    // link too — but the top level is spelled out, it is the case that matters.
    if (st.isSymbolicLink() || !st.isDirectory()) fs.unlinkSync(p);
    else fs.rmSync(p, { recursive: true, force: true });
  }
}

// Instance side of the connect flow: makes the ephemeral P-256 key the broker
// encrypts the provider token for, and decrypts what comes back. The broker's
// counterpart is broker/src/core.ts `encryptForInstance` (src/ cannot import
// broker/, so TokenPayload is re-declared here).
import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";

export const CONNECT_TTL_MS = 10 * 60_000;
const MAX_PENDING = 100;
const INFO = Buffer.from("shadok-connect-v1");

export interface TokenPayload {
  access_token: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

export interface PendingAttempt {
  nonce: string;
  person: string;
  privateKey: KeyObject;
  createdAt: number;
  /** Which provider's Connect started it: an attempt is finished only at that
   *  provider's own route. Absent = linkedin (the only one there was). */
  provider?: string;
}

const b64u = (b: Buffer): string => b.toString("base64url");

export function newAttempt(person: string, now: number, provider?: string): { attempt: PendingAttempt; pub: string; nonce: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  // Raw uncompressed point (0x04||X||Y, 65 bytes): what WebCrypto importKey("raw") expects.
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x as string, "base64url"), Buffer.from(jwk.y as string, "base64url")]);
  const nonce = b64u(randomBytes(16));
  return { attempt: { nonce, person, privateKey, createdAt: now, ...(provider ? { provider } : {}) }, pub: b64u(raw), nonce };
}

/** Throws on any tamper or malformed input; messages never contain the token. */
export function decryptPayload(attempt: PendingAttempt, blob: string): TokenPayload {
  const parts = blob.split(".");
  if (parts.length !== 3) throw new Error("malformed connect payload");
  const [pubRaw, iv, ct] = parts.map((p) => Buffer.from(p, "base64url"));
  if (pubRaw.length !== 65 || iv.length !== 12 || ct.length < 17) throw new Error("malformed connect payload");
  const brokerPub = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: pubRaw.subarray(1, 33).toString("base64url"), y: pubRaw.subarray(33).toString("base64url") },
    format: "jwk",
  });
  const secret = diffieHellman({ privateKey: attempt.privateKey, publicKey: brokerPub });
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), INFO, 32));
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(Buffer.from(attempt.nonce, "base64url"));
  d.setAuthTag(ct.subarray(ct.length - 16));
  let plain: string;
  try {
    plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8");
  } catch {
    throw new Error("connect payload failed authentication");
  }
  let p: Partial<TokenPayload>;
  try {
    p = JSON.parse(plain) as Partial<TokenPayload>;
  } catch {
    throw new Error("connect payload is not valid JSON");
  }
  if (!p || typeof p.access_token !== "string" || !p.access_token) throw new Error("connect payload has no access token");
  if (typeof p.expires_in !== "number" || !(p.expires_in > 0)) throw new Error("connect payload has no valid expiry");
  return p as TokenPayload;
}

export class PendingAttempts {
  private m = new Map<string, PendingAttempt>();

  add(a: PendingAttempt): void {
    this.m.set(a.nonce, a);
    while (this.m.size > MAX_PENDING) {
      const oldest = this.m.keys().next().value as string; // Map keeps insertion order
      this.m.delete(oldest);
    }
  }

  take(nonce: string, person: string, now: number): PendingAttempt | "unknown" | "expired" | "wrong-person" {
    const a = this.m.get(nonce);
    if (!a) return "unknown";
    if (now - a.createdAt > CONNECT_TTL_MS) {
      this.m.delete(nonce);
      return "expired";
    }
    if (a.person !== person) return "wrong-person"; // not consumed: the owner can still finish
    this.m.delete(nonce);
    return a;
  }

  sweep(now: number): void {
    for (const [k, a] of this.m) if (now - a.createdAt > CONNECT_TTL_MS) this.m.delete(k);
  }

  get size(): number {
    return this.m.size;
  }
}

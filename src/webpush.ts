/**
 * Web Push, the standard way: VAPID (RFC 8292) to identify this server to the
 * push service, and `aes128gcm` message encryption (RFC 8291 / RFC 8188) so the
 * push service — Apple's, Google's, Mozilla's — relays a payload it cannot read.
 *
 * Written on `node:crypto` rather than pulled in as the `web-push` package: the
 * whole protocol is one ECDH, two HKDFs, one AES-GCM and one ES256 signature,
 * and the package would bring four transitive dependencies to do exactly that.
 * Correctness is pinned by the RFC 8291 Appendix A vector, byte for byte
 * (test/webpush.test.ts).
 *
 * Why push at all: a phone suspends a backgrounded page within seconds, so the
 * cockpit's own attention signal (title badge, chime — public/notify.js) never
 * reaches a pocket. Only the SERVER can wake the device, through the push
 * service the browser subscribed to. On iOS this works for a cockpit added to
 * the Home Screen (iOS 16.4+), which is the "iOS app" without an App Store.
 *
 * Everything here is pure except `sendPush`, which does the one HTTP request.
 */
import {
  createECDH,
  createCipheriv,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type webcrypto,
} from "node:crypto";

type JsonWebKey = webcrypto.JsonWebKey;

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url — what the browser's
   *  `applicationServerKey` takes. */
  publicKey: string;
  /** The private key as a JWK (d, x, y). */
  privateJwk: JsonWebKey;
}

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const b64u = (b: Buffer): string => b.toString("base64url");
const fromB64u = (s: string): Buffer => Buffer.from(s, "base64url");

/** A fresh VAPID key pair. One per instance: a subscription is bound to it. */
export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const pub = Buffer.concat([Buffer.from([0x04]), fromB64u(jwk.x!), fromB64u(jwk.y!)]);
  return { publicKey: b64u(pub), privateJwk: jwk };
}

/** Is this a usable key pair (as read back from disk)? */
export function vapidKeysValid(k: unknown): k is VapidKeys {
  const v = k as VapidKeys | null;
  if (!v || typeof v.publicKey !== "string" || !v.privateJwk || typeof v.privateJwk !== "object") return false;
  try {
    createPrivateKey({ key: v.privateJwk, format: "jwk" });
    return fromB64u(v.publicKey).length === 65;
  } catch {
    return false;
  }
}

/**
 * The push services we will POST to. A subscription's endpoint comes from the
 * browser, i.e. from a request body: without this list, `POST /push/subscribe`
 * would let any signed-in caller make the server send requests to an address of
 * their choosing (SSRF towards the LAN, cloud metadata…). These are the services
 * the browsers that matter actually hand out; a new one is a one-line addition.
 */
const PUSH_HOST_SUFFIXES = [
  ".push.apple.com", // Safari / iOS (web.push.apple.com)
  "fcm.googleapis.com", // Chrome, Edge (Chromium), Android
  "android.googleapis.com", // older Chrome endpoints
  ".push.services.mozilla.com", // Firefox
  ".notify.windows.com", // legacy Edge / WNS
];

/** Validate and normalise a subscription from a browser, or say why not. */
export function parseSubscription(
  raw: unknown,
): { ok: true; sub: PushSubscriptionData } | { ok: false; reason: string } {
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!r || typeof r.endpoint !== "string") return { ok: false, reason: "no endpoint" };
  let u: URL;
  try {
    u = new URL(r.endpoint);
  } catch {
    return { ok: false, reason: "endpoint is not a URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "endpoint must be https" };
  const host = u.hostname.toLowerCase();
  const known = PUSH_HOST_SUFFIXES.some((s) => (s.startsWith(".") ? host.endsWith(s) : host === s));
  if (!known) return { ok: false, reason: `unknown push service: ${host}` };
  const p256dh = typeof r.keys?.p256dh === "string" ? r.keys.p256dh : "";
  const auth = typeof r.keys?.auth === "string" ? r.keys.auth : "";
  let pk: Buffer, as: Buffer;
  try {
    pk = fromB64u(p256dh);
    as = fromB64u(auth);
  } catch {
    return { ok: false, reason: "keys are not base64url" };
  }
  if (pk.length !== 65 || pk[0] !== 0x04) return { ok: false, reason: "p256dh is not a P-256 public key" };
  if (as.length !== 16) return { ok: false, reason: "auth secret must be 16 bytes" };
  return { ok: true, sub: { endpoint: u.toString(), keys: { p256dh, auth } } };
}

/**
 * The VAPID `Authorization` header for one endpoint (RFC 8292): an ES256 JWT
 * whose audience is the push service's origin.
 *
 * `subject` is a contact for the push service operator. Apple REFUSES a push
 * without one (it must be `mailto:` or `https:`), so it is never omitted; the
 * default points at the project rather than at whoever runs the instance, so no
 * personal address leaves the machine unless the operator sets one.
 */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // 12 h: RFC 8292 caps `exp` at 24 h, and some services reject anything close
  // to the cap because of clock skew.
  const claims = b64u(
    Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: subject })),
  );
  const input = `${header}.${claims}`;
  const key = createPrivateKey({ key: keys.privateJwk, format: "jwk" });
  // JOSE wants the raw r||s signature, not DER.
  const sig = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${input}.${b64u(sig)}, k=${keys.publicKey}`;
}

/**
 * Encrypt a payload for one subscription (RFC 8291, `aes128gcm`, one record).
 *
 * `salt` and `senderPrivate` are drawn fresh per message; they are parameters
 * only so the RFC's own vector can be replayed in a test. Reusing either across
 * messages would break the encryption — production callers never pass them.
 */
export function encryptPayload(
  plaintext: Buffer,
  sub: PushSubscriptionData,
  opts: { salt?: Buffer; senderPrivate?: Buffer } = {},
): Buffer {
  const uaPublic = fromB64u(sub.keys.p256dh);
  const authSecret = fromB64u(sub.keys.auth);
  const salt = opts.salt ?? randomBytes(16);
  const ecdh = createECDH("prime256v1");
  if (opts.senderPrivate) ecdh.setPrivateKey(opts.senderPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // hkdfSync is extract-then-expand, which is the HKDF both RFCs specify.
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  // One record, so it is the LAST one: delimiter 0x02, no padding.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  const header = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, body]);
}

/**
 * The largest payload we send. RFC 8291 guarantees 3993 octets of plaintext per
 * message; staying well under keeps every push service happy and leaves room for
 * the JSON wrapper. The text is a preview — the cockpit has the rest.
 */
export const MAX_BODY_CHARS = 180;

export interface PushMessage {
  title: string;
  body: string;
  /** Collapses notifications: a new one for the same agent REPLACES the last,
   *  instead of piling up one per turn. */
  tag: string;
  /** What to open on tap (same origin, path + hash). */
  url: string;
}

/** Shorten to `max` characters on a word boundary, with an ellipsis. */
export function preview(text: string, max: number = MAX_BODY_CHARS): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + "…";
}

/**
 * The `Topic` header: a push service keeps only the LATEST undelivered message
 * per topic, so a phone that was offline for an hour gets one notification per
 * agent, not sixty. Must be ≤ 32 characters of the URL-safe alphabet.
 */
export function topicFor(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "shadok";
}

export type PushOutcome =
  | { ok: true; status: number }
  /** `gone`: the subscription is dead (unsubscribed, expired) — drop it. */
  | { ok: false; status: number; gone: boolean; error: string };

/** What an HTTP status from a push service means for the subscription. */
export function classifyPushStatus(status: number): { ok: boolean; gone: boolean } {
  if (status >= 200 && status < 300) return { ok: true, gone: false };
  // 404/410: the subscription no longer exists. Keeping it would mean one
  // failed request per event, forever.
  return { ok: false, gone: status === 404 || status === 410 };
}

/** Send one message. Never throws: a push is best effort and must not take an
 *  agent's turn down with it. */
export async function sendPush(
  sub: PushSubscriptionData,
  msg: PushMessage,
  keys: VapidKeys,
  subject: string,
  ttlSec: number = 24 * 3600,
): Promise<PushOutcome> {
  try {
    const payload = encryptPayload(Buffer.from(JSON.stringify(msg)), sub);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthorization(sub.endpoint, keys, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttlSec),
        // An agent waiting on a person is the reason this exists: deliver now,
        // not when the phone next wakes on its own.
        Urgency: "high",
        Topic: topicFor(msg.tag),
      },
      // A plain Uint8Array: fetch's BodyInit typing does not take a Buffer.
      body: new Uint8Array(payload),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    const c = classifyPushStatus(res.status);
    if (c.ok) return { ok: true, status: res.status };
    const text = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, status: res.status, gone: c.gone, error: text || res.statusText };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: (e as Error).message };
  }
}

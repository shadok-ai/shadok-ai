/**
 * Where an instance keeps its Web Push state: its VAPID key pair and the
 * devices subscribed to it, in `~/.shadok-ai/push/<instanceKey>.json` (600).
 *
 * Per instance, because a subscription is bound to the VAPID public key it was
 * created with, and each instance is its own origin to a browser — sharing one
 * file between two launch directories would hand one cockpit's devices to the
 * other. Each subscription names the ACCOUNT that made it, so a member is only
 * ever told about agents they may see (`server.ts` filters with
 * `canSeeSession` at send time, not at subscribe time: group membership
 * changes, and the check must follow it).
 *
 * The list logic is pure (tested); `loadPushState` / `savePushState` are the
 * thin fs half.
 */
import fs from "node:fs";
import path from "node:path";
import { SHADOK_DIR } from "./config.js";
import { instanceKey } from "./paths.js";
import { generateVapidKeys, vapidKeysValid, type PushSubscriptionData, type VapidKeys } from "./webpush.js";

export interface StoredSubscription extends PushSubscriptionData {
  /** The account that subscribed this device. */
  user: string;
  createdAt: number;
  /** A human label for the device list ("iPhone · Safari"), from the UA. */
  device?: string;
}

export interface PushState {
  vapid: VapidKeys;
  subs: StoredSubscription[];
}

/** A person rarely has more than a few devices; the cap stops a loop in a
 *  client from growing the file without bound. Oldest go first. */
export const MAX_SUBS_PER_USER = 10;

export function pushFileFor(cwd: string = process.cwd()): string {
  return path.join(SHADOK_DIR, "push", `${instanceKey(cwd)}.json`);
}

/**
 * Add or refresh a device. Keyed by endpoint: the same device subscribing again
 * (new keys after a browser reset, or another account signing in on it) REPLACES
 * its row — one device never notifies twice, and never for two accounts.
 */
export function upsertSubscription(
  list: readonly StoredSubscription[],
  sub: PushSubscriptionData,
  user: string,
  now: number,
  device?: string,
): StoredSubscription[] {
  const rest = list.filter((s) => s.endpoint !== sub.endpoint);
  const row: StoredSubscription = { ...sub, user, createdAt: now, ...(device ? { device } : {}) };
  const mine = rest.filter((s) => s.user === user).sort((a, b) => a.createdAt - b.createdAt);
  const drop = new Set(mine.slice(0, Math.max(0, mine.length - (MAX_SUBS_PER_USER - 1))).map((s) => s.endpoint));
  return [...rest.filter((s) => !drop.has(s.endpoint)), row];
}

/** Remove a device. Only its own account may: an endpoint is not a secret to
 *  whoever can read the page, so it must not be enough to unsubscribe someone. */
export function removeSubscription(
  list: readonly StoredSubscription[],
  endpoint: string,
  user: string,
): StoredSubscription[] {
  return list.filter((s) => !(s.endpoint === endpoint && s.user === user));
}

/** Drop subscriptions the push service declared dead (404/410). */
export function dropEndpoints(list: readonly StoredSubscription[], gone: ReadonlySet<string>): StoredSubscription[] {
  return list.filter((s) => !gone.has(s.endpoint));
}

/** A short device label from a User-Agent — for the person's own list, never
 *  sent anywhere. */
export function deviceLabel(ua: string | undefined): string | undefined {
  const s = String(ua ?? "");
  if (!s) return undefined;
  const os = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android"
    : /Mac OS X/.test(s) ? "Mac" : /Windows/.test(s) ? "Windows" : /Linux/.test(s) ? "Linux" : "";
  const br = /Edg\//.test(s) ? "Edge" : /Firefox\//.test(s) ? "Firefox" : /Chrome\//.test(s) ? "Chrome"
    : /Safari\//.test(s) ? "Safari" : "";
  return [os, br].filter(Boolean).join(" · ") || undefined;
}

/** Read the state, creating the key pair on first use. Never throws: a broken
 *  file is replaced by a fresh key pair and an empty list — the devices on it
 *  were bound to keys we can no longer prove, so they would fail anyway. */
export function loadPushState(file: string = pushFileFor()): PushState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (vapidKeysValid(raw?.vapid)) {
      const subs = Array.isArray(raw.subs) ? (raw.subs as StoredSubscription[]).filter((s) => s && typeof s.endpoint === "string" && typeof s.user === "string" && s.keys) : [];
      return { vapid: raw.vapid, subs };
    }
  } catch {
    /* missing or unreadable → fresh state below */
  }
  const fresh: PushState = { vapid: generateVapidKeys(), subs: [] };
  savePushState(fresh, file);
  return fresh;
}

export function savePushState(state: PushState, file: string = pushFileFor()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

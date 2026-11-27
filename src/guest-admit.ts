import { type GuestSetup, guestWorkDirName } from "./tg-guests.js";
import { waGuestWorkDirName } from "./wa-guests.js";

/**
 * The admission ceiling of an open door: how many strangers it holds at once,
 * and how fast it takes new ones.
 *
 * Both doors WERE uncapped by construction — "no cap on the number of guests, no
 * queue, no per-person block" — and that was tenable while a guest cost a
 * directory under a shared Unix user. It stopped being tenable in two steps. A
 * guest already costs a `claude` process and a tmux pane, so anyone who
 * knows the number can make the instance spawn until it falls over. And the
 * external-group design makes a guest cost a `useradd`, i.e. a row in
 * `/etc/passwd`, which is not a scratch resource: an uncapped door would then be
 * a provisioning DoS reachable from a phone.
 *
 * So the cap lands BEFORE the wall it pays for — the design's step 2, built
 * before step 3 on purpose. See
 * docs/superpowers/specs/2026-11-26-external-groups-per-conversation-isolation-design.md,
 * decision 3.
 *
 * Why its own module rather than `src/tg-guests.ts`, where the rest of the door
 * lives: the occupancy count has to name a conversation on EITHER transport,
 * and `wa-guests.ts` already imports `tg-guests.ts`. Putting it there would
 * close an import cycle; here both name builders are reused as they are.
 *
 * Pure and dependency-free, like the two door modules, so the whole decision is
 * unit-tested with no server, no bot and no phone.
 */

/** What one door admits at most. */
export interface GuestLimits {
  /** Guest conversations alive in the group at once. */
  live: number;
  /** New conversations admitted per hour. */
  perHour: number;
}

/**
 * The defaults, settled with the operator: large enough that an ordinary flow
 * never meets them, small enough that a flood stops costing at 30 accounts an
 * hour. An instance holding 200 live guest conversations is already at the end
 * of what one host runs; the point of the ceiling is that the 201st is a
 * refusal and not a crash.
 */
export const GUEST_LIMITS: GuestLimits = { live: 200, perHour: 30 };

/** The window `perHour` is counted over. */
export const GUEST_RATE_WINDOW_MS = 3_600_000;

/** The refusal's `code` on the wire, so a bridge classifies it without
 *  matching on the message text (the `busy` convention). */
export const GUEST_FULL_CODE = "guest-full";

/**
 * This door's limits: what the operator stored, else the defaults.
 *
 * A value that is not a positive integer reads as "not set" rather than as a
 * refusal: the config file is hand-editable (`normalizeTgMode` makes the same
 * choice), and a typo that silently shut the door would be indistinguishable
 * from a bot that stopped working. Closing a door is what the MODE is for.
 *
 * There is deliberately no upper bound. An operator who raises the ceiling to
 * a number their host cannot serve has made a decision about their own
 * machine; pretending to know better would be the cosmetic cap of invariant 47.
 */
export function guestLimitsOf(setup: Pick<GuestSetup, "limits">): GuestLimits {
  const one = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : fallback;
  return {
    live: one(setup.limits?.live, GUEST_LIMITS.live),
    perHour: one(setup.limits?.perHour, GUEST_LIMITS.perHour),
  };
}

/**
 * The ceiling a REQUEST asks for, or `undefined` when it names none.
 *
 * `undefined` is not "the defaults": a patch that does not mention the ceiling
 * must leave the operator's numbers alone (`guestPatchFlow` keeps them,
 * ASSERT-only like `branch` / `repo` / `parent` — invariant 19). An EMPTY
 * object is the way back to the defaults, so there is a route out as well as in.
 *
 * Only positive integers survive; anything else is dropped rather than
 * refused, for the reason `guestLimitsOf` gives.
 */
export function requestedLimits(b: Record<string, unknown>): Partial<GuestLimits> | undefined {
  if (!("limits" in b)) return undefined;
  const raw = (b.limits ?? {}) as Record<string, unknown>;
  if (typeof raw !== "object") return {};
  const out: Partial<GuestLimits> = {};
  for (const k of ["live", "perHour"] as const) {
    const v = raw[k];
    if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) out[k] = v;
  }
  return out;
}

/**
 * The conversation a channel belongs to, named the way its directory is
 * (`tg-<id>` / `wa-<digits>`), or null when the channel is not a guest's.
 *
 * That name is the key the whole ceiling counts on, and it is REUSED rather
 * than invented: it is already what makes a person come back to their own
 * folder, it is rebuilt from untrusted input in one place, and two spellings of
 * one id (a chat id as a number or as a string) collapse to one string there.
 * Two keys for one person would be two admissions, i.e. a returning guest
 * charged as a new one.
 *
 * It inherits that name's one limit, and the ceiling can say so honestly: a
 * WhatsApp sender's LID and their phone address are two keys, as they are two
 * directories. It costs nothing in practice — the same person is found by
 * `findWaChannel` and RESUMED, which never reaches the ceiling — and at worst,
 * with no channel row left, it charges one admission twice.
 *
 * The bindings are `SERVER_OWNED`, so no client can rename a conversation into
 * a free slot.
 */
export function guestConversationKey(
  c: {
    telegram?: { chatId: number; threadId?: number } | null;
    whatsapp?: { id: string } | null;
  } | null | undefined,
): string | null {
  if (!c) return null;
  if (c.whatsapp) return waGuestWorkDirName(c.whatsapp.id);
  const t = c.telegram;
  // A topic (`threadId`) is a board agent and a negative id is a group chat:
  // neither is a guest's conversation. `guestWorkDirName` refuses both.
  if (!t || t.threadId != null) return null;
  return guestWorkDirName(t.chatId);
}

/**
 * The guest conversations this group is holding — as a SET of conversation
 * keys, not a channel count.
 *
 * Deliberately per group rather than per door: the group is where a
 * conversation costs something (a Unix user, a home, a vault slice at step 4),
 * and two doors pointed at one group share that cost. Counting a door's own
 * channels would let an operator double the ceiling by opening a second door
 * onto the same group.
 *
 * The owner's own DM is excluded without having to know who the owner is: it
 * lives in the board's group, never in the guest group, and only this group is
 * counted.
 */
export function liveGuestKeys(
  list: readonly {
    group?: string | null;
    telegram?: { chatId: number; threadId?: number } | null;
    whatsapp?: { id: string } | null;
  }[],
  groupId: string,
): Set<string> {
  const keys = new Set<string>();
  for (const c of list) {
    if (c.group !== groupId) continue;
    const k = guestConversationKey(c);
    if (k) keys.add(k);
  }
  return keys;
}

/** Why a stranger was not admitted. The person hears one line either way
 *  (`guestNotice("door-full")`); the two reasons are for the operator's log. */
export type GuestAdmit =
  | { ok: true; returning: boolean }
  | { ok: false; why: "full" | "rate"; message: string };

/**
 * May this conversation be admitted?
 *
 * A **returning** conversation is never subject to either limit, and that is
 * the load-bearing half: the cap exists to stop an unknown number of NEW
 * strangers, never to cut off someone the instance is already talking to. A
 * guest whose agent the operator deleted comes back through this path (their
 * channel row went with it), so "returning" is asked on the conversation key
 * and not on the presence of an agent.
 *
 * `recent` is the admission times of this group, newest or oldest first makes
 * no difference: only how many fall inside the window counts.
 */
export function guestAdmitVerdict(input: {
  limits: GuestLimits;
  /** The conversation keys this group already holds (`liveGuestKeys`). */
  live: ReadonlySet<string>;
  /** The conversation asking to be admitted (`guestConversationKey`). */
  key: string;
  recent: readonly number[];
  now: number;
  windowMs?: number;
}): GuestAdmit {
  const { limits } = input;
  if (input.live.has(input.key)) return { ok: true, returning: true };
  if (input.live.size >= limits.live)
    return {
      ok: false,
      why: "full",
      message: `this instance is already holding its maximum of ${limits.live} guest conversations`,
    };
  const window = input.windowMs ?? GUEST_RATE_WINDOW_MS;
  const since = input.now - window;
  const burst = input.recent.filter((t) => t > since).length;
  if (burst >= limits.perHour)
    return {
      ok: false,
      why: "rate",
      message: `this instance has admitted its maximum of ${limits.perHour} new guest conversations in the last hour`,
    };
  return { ok: true, returning: false };
}

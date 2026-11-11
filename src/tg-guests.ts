import { BOOTSTRAP_ADMIN } from "./accounts.js";
import { type DeploymentMode, isolationRefusal } from "./capability.js";
import { type Group, type Viewer, viewerInGroup } from "./groups.js";

/**
 * Open DMs: the bot's door for people who are not its owner.
 *
 * A DM normally belongs to ONE person (`dmGate` in src/telegram.ts). An
 * instance can open it: anyone who writes gets a dedicated agent, on a
 * configured profile, in a configured group — and always lands on the same one,
 * because a DM's binding key already IS the sender's id (`bindKey` →
 * `private:<chat.id>`).
 *
 * Pure and dependency-free, like `src/groups.ts`, so the whole decision can be
 * unit-tested with no server.
 *
 * See docs/superpowers/specs/2026-11-11-telegram-open-dm-design.md.
 */

/** What the Telegram panel stores for this launch directory. */
export interface GuestSetup {
  on: boolean;
  /** Id of the RESTRICTED group guests' agents are born into. */
  group: string | null;
  /** Profile name every guest agent is spawned on — the job description. */
  profile: string | null;
}

export const GUEST_SETUP_OFF: GuestSetup = { on: false, group: null, profile: null };

/**
 * May this setup be saved? `null` = yes, else the reason, shown to the admin
 * as-is.
 *
 * Turning the option OFF is always allowed, deliberately: the way out must not
 * be gated by the checks that guard the way in, or an operator who wants to
 * close their bot would first have to repair a group someone deleted.
 *
 * The group must be RESTRICTED, and the two rejected natures are rejected for
 * different reasons worth keeping apart in the message. A PUBLIC group is no
 * wall at all — every account in the cockpit would read those conversations. A
 * PRIVATE (Personal) group is sealed to its one account and the bridge could
 * never be a member of it: it drives as the bootstrap admin, a name reserved
 * for the instance password that `loadAccounts` refuses to create, so
 * `canSeeGroup` would be false and every guest message would be refused after a
 * spawn that looked fine.
 */
export function guestEnableRefusal(input: {
  mode: DeploymentMode;
  want: GuestSetup;
  groups: readonly Group[];
  profileExists: (name: string) => boolean;
}): string | null {
  const { want } = input;
  if (!want.on) return null;
  // A non-public group cannot even exist outside the privileged deployment, so
  // there is nothing here that could hold a guest.
  const capability = isolationRefusal(input.mode);
  if (capability) return capability;
  const groupId = want.group?.trim();
  if (!groupId) return "choose the group guests' agents live in";
  const profile = want.profile?.trim();
  if (!profile) return "choose the profile guests' agents run on";
  const g = input.groups.find((x) => x.id === groupId);
  if (!g) return "no such group — pick one from the list";
  if (g.nature === "private")
    return `"${g.name}" is a personal group: it is sealed to its account and cannot host guests`;
  if (g.nature !== "restricted")
    return `"${g.name}" is a public group — guests need a restricted one, so only its members read those conversations`;
  if (!input.profileExists(profile)) return `no profile named "${profile}"`;
  return null;
}

/**
 * The groups a picker may offer: restricted, and ones this viewer belongs to.
 *
 * Membership is asked through `viewerInGroup`, never by comparing names, so an
 * agent principal is judged on its own channel's group like everywhere else.
 */
export function guestGroupChoices(groups: readonly Group[], viewer: Viewer | null): Group[] {
  return groups.filter((g) => g.nature === "restricted" && viewerInGroup(g, viewer));
}

/**
 * Add or remove the INSTANCE from one group's members (new array, inputs
 * untouched).
 *
 * This is what lets the bridge spawn, resume and drive a guest's session: it
 * authenticates as `BOOTSTRAP_ADMIN`, and every group question goes through
 * `memberOf`. Writing the instance into the member list reuses that one
 * primitive instead of carving an exemption into the group wall — and it does
 * NOT widen the group to other agents, which are judged on their own
 * `agentGroup` rather than on this name.
 */
export function withInstanceMember(groups: readonly Group[], groupId: string, member: boolean): Group[] {
  return groups.map((g) => {
    if (g.id !== groupId) return g;
    const has = g.members.includes(BOOTSTRAP_ADMIN);
    if (member === has) return g;
    return {
      ...g,
      members: member ? [...g.members, BOOTSTRAP_ADMIN] : g.members.filter((m) => m !== BOOTSTRAP_ADMIN),
    };
  });
}

/** Pure: a setup with its strings trimmed, `on` only ever true with both
 *  halves present — the two fields are solidary, so a switch alone is never a
 *  door to nowhere. */
export function normalizeGuestSetup(want: GuestSetup): GuestSetup {
  const group = want.group?.trim() || null;
  const profile = want.profile?.trim() || null;
  return { on: want.on === true && !!group && !!profile, group, profile };
}

/**
 * The whole `PUT /telegram` guest decision, transport-free — the twin of
 * `createGroupFlow`/`groupsPutFlow`, so the route is a thin mapper and the
 * behaviour is unit-tested with no server.
 *
 * A refusal carries no group list at all, so a refused patch cannot possibly
 * write one (invariant 6's family: never persist a half-decided state).
 *
 * The membership is MOVED rather than merely added: a change of group must take
 * the instance out of the old one, or an abandoned group would keep a member
 * that outlives the reason it was put there.
 */
export function guestPatchFlow(input: {
  mode: DeploymentMode;
  previous: GuestSetup;
  want: GuestSetup;
  groups: readonly Group[];
  profileExists: (name: string) => boolean;
}): { ok: false; status: number; error: string } | { ok: true; setup: GuestSetup; groups: Group[] } {
  const want = normalizeGuestSetup(input.want);
  const error = guestEnableRefusal({
    mode: input.mode,
    want: input.want,
    groups: input.groups,
    profileExists: input.profileExists,
  });
  if (error) return { ok: false, status: 400, error };
  let groups = [...input.groups];
  const old = input.previous.group?.trim() || null;
  if (input.previous.on && old && old !== want.group) groups = withInstanceMember(groups, old, false);
  if (want.on && want.group) groups = withInstanceMember(groups, want.group, true);
  else if (old) groups = withInstanceMember(groups, old, false);
  return { ok: true, setup: want, groups };
}

/** What a `start` frame carrying the guest marker amounts to. */
export type GuestSpawn =
  | { kind: "not-a-guest" }
  | { kind: "refused"; code: "guest-closed"; message: string }
  | { kind: "guest"; group: string; profile: string };

/**
 * Pure: should this spawn be a guest's, and with what group and profile?
 *
 * The whole trust decision in one place, so it is unit-tested rather than
 * inferred from the shape of a 400-line handler.
 *
 * An unproven marker is **ignored, not refused**: a loopback client may send
 * anything (invariant 11), and what it sends simply is not a guest's spawn —
 * answering with an error would tell it something about the instance it has no
 * business learning. A marker on a RESUME is ignored for a different reason:
 * the channel's stored group is the authority there (invariant 1), and honouring
 * a frame would be a way to move an existing agent across the people wall.
 *
 * `refused` is kept apart from both: the bridge DID prove itself and the door is
 * shut, which is a state worth naming — the bridge can then say something to
 * whoever is writing instead of leaving them in silence.
 */
export function guestSpawnPlan(input: {
  marker: unknown;
  fromBridge: boolean;
  resuming: boolean;
  setup: GuestSetup;
}): GuestSpawn {
  if (input.marker !== true || !input.fromBridge || input.resuming) return { kind: "not-a-guest" };
  const s = normalizeGuestSetup(input.setup);
  if (!s.on || !s.group || !s.profile)
    return { kind: "refused", code: "guest-closed", message: "this instance is not accepting guests" };
  return { kind: "guest", group: s.group, profile: s.profile };
}

/**
 * What a guest is told when they type a command, or null when the message is
 * none of our business as a command.
 *
 * A guest talks, and nothing else. This is deliberately NOT "no operator
 * commands": `commandRequiresOperator` is an allowlist of the privileged ones,
 * and what it leaves open (`/stop`, `/tools`, `/new`…) is still the cockpit's
 * machinery — a stranger ending their own agent would erase the continuity the
 * feature promises.
 *
 * `/start` is the exception, and not a concession: Telegram sends it by itself
 * when someone opens a bot for the first time. Refusing it would make "I can't
 * run commands here" the first thing the bot ever says. It falls through as
 * ordinary text instead, so the agent answers it like the greeting it is.
 */
export function guestCommandRefusal(cmd: string | null | undefined): string | null {
  if (!cmd || cmd === "start") return null;
  return "I can't run commands here — just tell me what you need.";
}

/** Commands whose message must be DELETED when refused: they carried a value. */
export function guestCommandCarriesSecret(cmd: string | null | undefined): boolean {
  return cmd === "secret" || cmd === "code" || cmd === "mtcode";
}

/**
 * May this callback (an inline-keyboard click) be acted on?
 *
 * Answering your own agent's question is driving your own conversation, not a
 * new power — and without it the first `AskUserQuestion` any profile asks would
 * wedge a guest's conversation permanently and in silence: the question's
 * preface arrives, the click is refused, and nothing ever times out.
 *
 * A DM's chat id IS the sender's user id, so "their own DM" is an equality we
 * can check rather than a thing we have to trust.
 */
export function guestCallbackAllowed(
  verdict: "pair" | "allow" | "guest" | "deny",
  chatId: number | undefined,
  fromId: number | undefined,
): boolean {
  if (verdict === "allow") return true;
  if (verdict !== "guest") return false;
  return typeof chatId === "number" && chatId === fromId;
}

/** The bridge's own voice, by occasion — what it would say in a topic. */
export type GuestNotice =
  | "pace-blocked"    // the pace guard refused the prompt: it was NOT sent
  | "error"           // the server refused something after the person wrote
  | "preempt-failed"  // we could not take the hand back: the message was lost
  | "no-keyboard"     // Telegram refused the question's inline keyboard
  | "exited"          // the agent's process is gone
  | "upload-failed"   // a file the agent sent could not be delivered
  | "tool-activity";  // the running commentary of tool calls

/**
 * What a GUEST hears in place of a line the cockpit says to itself, or null to
 * say nothing at all.
 *
 * The rule is not "drop everything": it is that a person who does not know what
 * shadok is must never be left believing their message arrived when it did not.
 * So anything they could not act on is dropped, and anything that MEANS "what
 * you wrote is lost" is rewritten in words that stand on their own — no pace
 * guard, no session, no /stop, no web UI, none of which exist for them.
 */
export function guestNotice(kind: GuestNotice): string | null {
  switch (kind) {
    case "pace-blocked":
      return "⏳ I'm at capacity right now — please send that again in a little while.";
    case "error":
      return "⚠️ Something went wrong on my side — please send that again in a moment.";
    case "preempt-failed":
      return "⚠️ Your message didn't go through — please send it again.";
    case "no-keyboard":
      return "⚠️ I couldn't show you the options — just tell me your answer in words.";
    // Nothing to act on: a new message starts the conversation up again, and a
    // failed upload or a tool trace is the operator's business, not theirs.
    case "exited":
    case "upload-failed":
    case "tool-activity":
      return null;
  }
}

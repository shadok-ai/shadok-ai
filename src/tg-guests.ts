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

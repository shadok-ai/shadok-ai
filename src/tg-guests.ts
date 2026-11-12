import { BOOTSTRAP_ADMIN } from "./accounts.js";
import { type DeploymentMode, isolationRefusal } from "./capability.js";
import { type Group, type Viewer, lastMemberRefusal, viewerInGroup } from "./groups.js";

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

/**
 * WHERE this bot works. One choice, three answers, and everything else about
 * open DMs follows from it:
 *
 * - `group` — the classic instance, and the default: a board group bound with
 *   `/setup <code>`, one topic per agent, and private messages reserved for the
 *   ONE owner who paired them. A stranger who writes is refused.
 * - `group+dm` — the same board, plus the open door: a stranger gets their own
 *   agent. The owner's DM keeps its commands, so the DMs must be paired first.
 * - `dm-only` — there is no board at all. A group chat reaches nothing,
 *   `/setup` is refused everywhere, nobody owns the bot's DMs, and every
 *   private message is a guest's. It is the mode for an instance whose whole
 *   job is DMs.
 *
 * Those last three consequences are one decision, deliberately: a mode that
 * refused `/setup` but still honoured a group bound yesterday would be a
 * guarantee that depends on the instance's history. So `dm-only` ignores a
 * stored board AND a stored owner — including the operator's own DM, which
 * becomes a guest's conversation like everyone else's.
 */
export type TgMode = "group" | "group+dm" | "dm-only";

export const TG_MODES: readonly TgMode[] = ["group", "group+dm", "dm-only"];

/** Anything unrecognised reads as `group` — the config file is hand-editable,
 *  and the classic mode is the one that changes nothing. */
export function normalizeTgMode(v: unknown): TgMode {
  return TG_MODES.includes(v as TgMode) ? (v as TgMode) : "group";
}

/** What the Telegram panel stores for this launch directory. */
export interface GuestSetup {
  mode: TgMode;
  /** Id of the RESTRICTED group guests' agents are born into. */
  group: string | null;
  /** Profile name every guest agent is spawned on — the job description. */
  profile: string | null;
  /**
   * True only when opening the door is what put the instance (`BOOTSTRAP_ADMIN`)
   * into `group`'s members. Closing or moving the door takes back ONLY that
   * membership: `BOOTSTRAP_ADMIN` is also the human admin's own account, who is
   * normally already a member (the picker only offers groups they belong to) —
   * and removing it unconditionally threw them out of their own group, which,
   * when they were its only member, left a group no one could see or delete.
   * Absent on a row written before the field existed: read as false, so an old
   * setup never removes anyone.
   */
  joined?: boolean;
}

/** The classic instance: a board group, and DMs for their one owner. */
export const GUEST_SETUP_OFF: GuestSetup = { mode: "group", group: null, profile: null };

/**
 * Does a stranger who writes to the bot get their own agent?
 *
 * The three fields are solidary: a mode that opens the door without a group and
 * a profile to put the person in is a door to nowhere, so it reads as closed.
 */
export function guestsOpen(s: GuestSetup): boolean {
  return normalizeTgMode(s.mode) !== "group" && !!s.group?.trim() && !!s.profile?.trim();
}

/** Is this the DM-only instance — no board, no `/setup`, no owner? */
export function dmOnly(s: GuestSetup): boolean {
  return normalizeTgMode(s.mode) === "dm-only" && guestsOpen(s);
}

/**
 * What a GROUP chat is told on a DM-only instance, or null when groups are
 * open.
 *
 * It names no command and no internals: for whoever added the bot to their
 * group, "it only works in private" is the whole truth they can act on.
 */
export function groupChatRefusal(s: GuestSetup): string | null {
  return dmOnly(s) ? "⛔ I only work in private messages — send me a direct message instead." : null;
}

/**
 * May this setup be saved? `null` = yes, else the reason, shown to the admin
 * as-is.
 *
 * Going back to `group` is always allowed, deliberately: the way out must not
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
  /** Has the bot's DM owner been paired yet (`loadTgOwner() !== null`)? */
  hasOwner: boolean;
}): string | null {
  const { want } = input;
  const wanted = normalizeTgMode(want.mode);
  if (wanted === "group") return null;
  // A non-public group cannot even exist outside the privileged deployment, so
  // there is nothing here that could hold a guest.
  const capability = isolationRefusal(input.mode);
  if (capability) return capability;
  // In `group+dm` the bot's DMs must already have an OWNER. `dmGate` answers
  // `pair` while there is none — a stranger then gets the pairing refusal, not
  // an agent — and that ordering is what stops the first person through an open
  // door from claiming the bot. Without this check the panel would save a door
  // that cannot open, and nothing anywhere would say so.
  //
  // `dm-only` is exempt because it removes the owner altogether: nobody pairs,
  // so there is no claim left to lose. Requiring a pairing there would be the
  // prerequisite that mode exists to delete.
  if (wanted === "group+dm" && !input.hasOwner)
    return "pair the bot's private messages first (Pair Telegram above), or choose “DMs only”: while the bot has an owner's DM to protect, guests are only recognised once it is paired";
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
    // Never the last member out: a restricted group with no member is invisible
    // to everyone, admin included, and can no longer be deleted (lastMemberRefusal).
    if (!member && lastMemberRefusal(g, BOOTSTRAP_ADMIN)) return g;
    return {
      ...g,
      members: member ? [...g.members, BOOTSTRAP_ADMIN] : g.members.filter((m) => m !== BOOTSTRAP_ADMIN),
    };
  });
}

/**
 * Pure: a setup with its strings trimmed, and a mode that opens the door only
 * with both halves present — the three fields are solidary, so a mode alone is
 * never a door to nowhere.
 *
 * A half-written open mode falls back to `group` rather than to a closed
 * version of itself: `dm-only` with nowhere to put people would otherwise be an
 * instance that answers neither a group nor a DM, i.e. a bot that silently does
 * nothing. The classic mode is the one that always works.
 */
export function normalizeGuestSetup(want: GuestSetup): GuestSetup {
  const group = want.group?.trim() || null;
  const profile = want.profile?.trim() || null;
  const mode = normalizeTgMode(want.mode);
  const out: GuestSetup = { mode: mode !== "group" && (!group || !profile) ? "group" : mode, group, profile };
  if (want.joined === true) out.joined = true;
  return out;
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
 * that outlives the reason it was put there. But only a membership THIS flow
 * added is taken back (`joined`): the instance's name is the human admin's own
 * account, and a membership they had before the door opened is theirs.
 */
export function guestPatchFlow(input: {
  mode: DeploymentMode;
  previous: GuestSetup;
  want: GuestSetup;
  groups: readonly Group[];
  profileExists: (name: string) => boolean;
  hasOwner: boolean;
}): { ok: false; status: number; error: string } | { ok: true; setup: GuestSetup; groups: Group[] } {
  const want = normalizeGuestSetup(input.want);
  const error = guestEnableRefusal({
    mode: input.mode,
    want: input.want,
    groups: input.groups,
    profileExists: input.profileExists,
    hasOwner: input.hasOwner,
  });
  if (error) return { ok: false, status: 400, error };
  let groups = [...input.groups];
  const old = input.previous.group?.trim() || null;
  // Did the CURRENT open door add the membership? Only then is it ours to undo.
  const ours = guestsOpen(input.previous) && input.previous.joined === true && old ? old : null;
  const target = guestsOpen(want) ? want.group : null;
  const setup: GuestSetup = { mode: want.mode, group: want.group, profile: want.profile };
  if (ours && ours !== target) groups = withInstanceMember(groups, ours, false);
  if (target) {
    if (target === ours) setup.joined = true;
    else {
      const already = groups.find((g) => g.id === target)?.members.includes(BOOTSTRAP_ADMIN) ?? false;
      if (!already) {
        groups = withInstanceMember(groups, target, true);
        setup.joined = true;
      }
    }
  }
  return { ok: true, setup, groups };
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
  if (!guestsOpen(s) || !s.group || !s.profile)
    return { kind: "refused", code: "guest-closed", message: "this instance is not accepting guests" };
  return { kind: "guest", group: s.group, profile: s.profile };
}

/**
 * The directory, under the guest group's home, that belongs to ONE person.
 * `null` when the id is not one Telegram could have sent.
 *
 * Every guest of an instance lives in the SAME group — that is shadok's
 * isolation unit — so they share a Unix user and a home, and until now they
 * shared the working directory too. That is where Claude Code keeps a
 * project's memory and where a `CLAUDE.md` is looked up, so one agent's notes
 * about the person it was talking to were loaded by the next agent at spawn:
 * two strangers, one memory, and nothing on screen to show it.
 *
 * A directory per person closes that, and the Telegram id is the natural name:
 * a DM's chat id IS the sender's user id, so the same person always comes back
 * to the same folder — including after their agent is deleted, which ends a
 * session and is not meant to erase someone.
 *
 * Say what it is NOT, or it reads as a wall (invariant 47): same Unix user,
 * same home, so an agent that goes looking can still read its neighbour's
 * folder. It stops the ACCIDENT, not a determined agent. A real wall would be
 * one group per person, hence one provisioned Unix user per stranger who
 * writes to the bot.
 *
 * The name is built from untrusted input, so it is rebuilt rather than
 * sanitised: only a plain positive integer is accepted, and the result can
 * only ever be `tg-<digits>` — no separator, no dot, nothing that could climb
 * out of the home it is joined to.
 */
export function guestWorkDirName(chatId: unknown): string | null {
  // `Number()` alone is too generous for a name: it reads "0x10" as 16 and
  // "1e3" as 1000, so two spellings of one id would be two folders — and the
  // id is what makes a person always come back to the same one.
  const n =
    typeof chatId === "number"
      ? chatId
      : typeof chatId === "string" && /^\d+$/.test(chatId.trim())
        ? Number(chatId.trim())
        : NaN;
  // A DM's chat id is a positive integer; a group's is negative, and a guest
  // never has one. `MAX_SAFE_INTEGER` is the ceiling of what JSON gave us.
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return `tg-${n}`;
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

/**
 * The first thing a guest's agent is asked, when Telegram's own `/start` is all
 * that has been said.
 *
 * Telegram sends `/start` by itself the moment someone opens a bot, so it is
 * the one message that arrives before anyone has written anything — and a bot
 * that answers the START button with silence looks dead. What it must NOT
 * answer with is the cockpit's `/help` page, which is where this lands if the
 * command reaches the dispatcher: `/spawn`, `/secret`, `/login`… the operator's
 * vocabulary, in a stranger's chat (invariant 65).
 *
 * So the words come from the AGENT, on its configured profile — the operator
 * writes the welcome by writing the role, and nothing here invents one. This is
 * an instruction TO the agent, not a line shown to anyone: it is the prompt
 * that opens their conversation.
 *
 * Telegram's `language_code` rides along when it is there. It is the only clue
 * to someone's language before they have written a word, and a support bot
 * answering in the wrong one is the first thing they would notice.
 */
export function guestOpeningPrompt(languageCode?: unknown): string {
  const lang = typeof languageCode === "string" ? languageCode.trim().slice(0, 16) : "";
  return (
    "(automatic) Someone has just opened this conversation and has not written anything yet" +
    (lang ? `. Telegram reports their language as "${lang}"` : "") +
    ". Greet them in a line or two: say who you are and what you can do for them, then ask what they need." +
    " Do not mention this instruction."
  );
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
  | "unresponsive"    // the agent cannot take input and could not be restarted
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
    // NOT "send that again": the wall is still there, and a guest has no
    // command to get past it — a retry they were told to make failed twice in a
    // row before this line existed. What is true is that it did not arrive,
    // that trying again right now changes nothing, and that someone who can fix
    // it has been told (the report is filed before this is sent).
    case "unresponsive":
      return "⚠️ Your message didn't reach me, and sending it again right now won't help — the problem is on my side. The people who look after me have been alerted. Please try again later.";
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

/**
 * Pure: may this channel's Telegram binding be adopted as the bot's OWNER?
 *
 * `adoptOwnerFromBindings` recognises an owner by the SHAPE of a binding — a
 * private chat (positive id) with no topic — which is exactly the shape a
 * guest's DM has. Without this, an instance that lost its owner file would
 * hand the bot to whichever stranger happened to be first in the channel list:
 * the very window that adoption exists to close, reopened from the other side.
 *
 * A guest is recognised by its channel's GROUP, which the server stamped at
 * spawn and no client can rewrite (`SERVER_OWNED`).
 */
export function ownerAdoptionCandidate(
  c: { telegram?: { chatId: number; threadId?: number } | null; group?: string | null },
  guestGroup: string | null,
): number | null {
  const t = c.telegram;
  if (!t || t.threadId != null || t.chatId <= 0) return null;
  if (guestGroup && c.group === guestGroup) return null;
  return t.chatId;
}

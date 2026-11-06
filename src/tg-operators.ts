/**
 * Telegram OPERATORS — who in the bound board group may run the commands that
 * act on the HOST rather than on one agent's conversation.
 *
 * Binding the board needs the pairing code (`src/tg-pairing.ts`), but once a
 * group was bound, nothing looked at `msg.from` again: every member of that
 * group could `/secret` over any vault name, `/unsecret` it, `/login` the
 * instance into their own Claude account, `/update` it (a process exit, as
 * often as they liked), `/mtcode` over the group-agent token, or `/spawn` an
 * agent on the lead profile — or on one carrying every secret — and ask it for
 * its environment. Being in the group was being root on the machine.
 *
 * An operator is a Telegram user id that REDEEMED a pairing code: `/setup
 * <code>` (or `/start <code>`, what a deep link sends) in the board group, or
 * the DM pairing — the DM owner always counts. Talking to agents, answering
 * their dialogs and the per-topic commands stay open to every member: driving
 * a conversation is what the board is for. Everything here is pure and tested.
 */

/** Commands that act on the host (vault, account, process), never on one chat. */
const OPERATOR_COMMANDS = new Set(["secret", "unsecret", "login", "code", "mttoken", "mtcode", "update"]);

/**
 * `/spawn <profile> <name>`: the first word is a profile when one by that name
 * exists, otherwise the whole argument is the agent's name. Shared by the
 * handler and the operator rule, so the two can never disagree about whether a
 * profile was asked for.
 */
export function spawnArgs(arg: string, isProfile: (name: string) => boolean): { profile?: string; name: string } {
  const all = arg.trim() || "agent";
  const sp = all.indexOf(" ");
  const first = sp === -1 ? all : all.slice(0, sp);
  if (!isProfile(first)) return { name: all };
  return { profile: first, name: sp === -1 ? first : all.slice(sp + 1).trim() || first };
}

/**
 * Does this command need an operator? A profile carries guardrails and
 * secrets, so choosing one is a privilege: `/spawn` with an explicit profile is
 * operator-only, a bare `/spawn` (no profile, no secrets) is not.
 */
export function commandRequiresOperator(cmd: string, arg: string, isProfile: (name: string) => boolean): boolean {
  if (OPERATOR_COMMANDS.has(cmd)) return true;
  if (cmd === "spawn") return spawnArgs(arg, isProfile).profile !== undefined;
  return false;
}

/**
 * Is this sender an operator? The recorded operators, plus the DM owner (who
 * paired with a code too). A bot never is, and a sender with no id never is:
 * there is nothing to compare. Fail closed — an empty registry and no owner
 * means nobody, never everybody.
 */
export function isOperator(
  from: number | undefined,
  operators: readonly number[],
  owner: number | null,
  isBot = false,
): boolean {
  if (typeof from !== "number" || isBot) return false;
  return operators.includes(from) || owner === from;
}

/** The registry with `id` added once. */
export function withOperator(operators: readonly number[], id: number): number[] {
  return operators.includes(id) ? [...operators] : [...operators, id];
}

/** What a non-operator is told: what was refused, and the one way in. */
export function operatorRefusal(cmd: string): string {
  return (
    `⛔ /${cmd} is reserved to this instance's Telegram operators.\n` +
    "To become one, open the cockpit's Telegram panel (admin), click “Pair Telegram”, " +
    "and send /setup <code> here."
  );
}

/**
 * `/secret NAME value [--overwrite]`. The flag is a trailing word, so a value
 * with spaces stays whole. Writing over an existing name needs it — the same
 * no-silent-overwrite rule as `PUT /secrets` (`secretWriteVerdict`).
 */
export function parseSecretArg(arg: string): { name: string; value: string; overwrite: boolean } | null {
  let rest = arg.trim();
  let overwrite = false;
  const flag = /\s+--overwrite$/;
  if (flag.test(rest)) {
    overwrite = true;
    rest = rest.replace(flag, "");
  }
  const sp = rest.indexOf(" ");
  if (sp === -1) return null;
  const name = rest.slice(0, sp).trim();
  const value = rest.slice(sp + 1);
  if (!name || !value.trim()) return null;
  return { name, value, overwrite };
}

/**
 * May a callback (an inline-keyboard click) be acted on in this chat? The same
 * chat gate as a message: the allowlist when one is set, and in a group only
 * the bound board. A DM is judged by `dmGate`, separately.
 */
export function callbackChatAllowed(
  chat: { id: number; type?: string },
  allowed: readonly string[],
  boundGroup: number | null,
): boolean {
  if (allowed.length && !allowed.includes(String(chat.id))) return false;
  if (chat.type === "private") return true;
  if (chat.type === "group" || chat.type === "supergroup") return boundGroup !== null && boundGroup === chat.id;
  return false;
}

/** The crons a topic may act on: its own channel's, never another topic's. */
export function cronsInScope<T extends { sessionId: string }>(all: readonly T[], sessionId: string | undefined): T[] {
  return sessionId ? all.filter((c) => c.sessionId === sessionId) : [];
}

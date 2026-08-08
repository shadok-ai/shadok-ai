import type { Channel } from "./channels.js";

/**
 * Kinship between channels: which agent launched which, and what a parent is
 * told about its children. Pure and dependency-free so it can be unit-tested
 * without a server — the same split `crons.ts` uses, and deliberate: the hub is
 * already large enough.
 */

/**
 * How deep a parent chain may go. A notification can trigger a spawn which
 * triggers another notification, so without a ceiling this is a cascade that
 * empties the subscription overnight. The pace guard cannot save us here: it
 * blocks one prompt at a time, never a chain.
 */
export const MAX_LINK_DEPTH = 4;

/** How many children one parent may hold, for the same reason. */
export const MAX_FANOUT = 12;

export type LinkRefusal =
  | "self"
  | "cycle"
  | "unknown-parent"
  | "too-deep"
  | "too-many-children";

/**
 * How many ancestors `sessionId` has (0 for a root, or for an unknown id).
 * `seen` is not paranoia: a hand-edited store can contain a loop, and this must
 * terminate on it rather than spin.
 */
export function chainDepth(channels: readonly Channel[], sessionId: string): number {
  const byId = new Map(channels.map((c) => [c.sessionId, c]));
  const seen = new Set<string>();
  let depth = 0;
  let cur: string | null = sessionId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    cur = byId.get(cur)?.parent ?? null;
    if (cur) depth++;
  }
  return depth;
}

/** The channels whose parent is `sessionId` (direct children only). */
export function childrenOf(channels: readonly Channel[], sessionId: string): Channel[] {
  return channels.filter((c) => c.parent === sessionId);
}

/**
 * Why linking `child` under `parent` must be refused, or null if it is allowed.
 * `parent === null` detaches, which is always allowed.
 *
 * Every refusal is EXPLICIT. An unknown parent is refused, not a field we
 * quietly drop — that is the lesson `resolveCronId` already carries (invariant
 * 17), where a delete answered `{ok:true}` while deleting nothing. Here the
 * silent version is worse: a parent would believe it will be notified and wait
 * for a child it was never linked to.
 */
export function linkRefusal(
  channels: readonly Channel[],
  child: string,
  parent: string | null,
): LinkRefusal | null {
  if (parent === null) return null;
  if (parent === child) return "self";

  const byId = new Map(channels.map((c) => [c.sessionId, c]));
  if (!byId.has(parent)) return "unknown-parent";

  // Walk up from the proposed parent: reaching the child closes a loop, and a
  // loop means the two notify each other forever.
  const seen = new Set<string>();
  let cur: string | null = parent;
  while (cur && !seen.has(cur)) {
    if (cur === child) return "cycle";
    seen.add(cur);
    cur = byId.get(cur)?.parent ?? null;
  }
  // Stopped because we re-entered an ALREADY looped chain: refuse too, rather
  // than attach something new to a structure that is broken.
  if (cur) return "cycle";

  if (chainDepth(channels, parent) + 1 >= MAX_LINK_DEPTH) return "too-deep";

  // Re-asserting an existing child must not count it twice and refuse a no-op.
  const siblings = childrenOf(channels, parent).filter((c) => c.sessionId !== child);
  if (siblings.length >= MAX_FANOUT) return "too-many-children";

  return null;
}

/**
 * Prefix carried by a notification prompt. It reaches the transcript as an
 * ordinary user message, so without a marker it reads as something the human
 * typed — and comes back on every web reload and Telegram backfill, which is
 * exactly the bug `CRON_PROMPT_MARK` exists to prevent. Twin of that one.
 */
export const AGENT_PROMPT_MARK = "🤖 [agent]";

export function markAgentPrompt(text: string): string {
  return isAgentPrompt(text) ? text : `${AGENT_PROMPT_MARK} ${text}`;
}

export function isAgentPrompt(text: string): boolean {
  return typeof text === "string" && text.trimStart().startsWith(AGENT_PROMPT_MARK);
}

/** What happened to a child, as its parent will be told it. */
export interface ChildReport {
  /** The child channel's display name, or its short id when unnamed. */
  name: string;
  sessionId: string;
  kind: "done" | "dialog" | "exited" | "timeout";
  /** The child's own last assistant text block — what it wrote to be read. */
  summary?: string;
  /** kind === "dialog": the pending question and its options. */
  question?: string;
  options?: string[];
  branch?: string | null;
}

const HEADLINE: Record<ChildReport["kind"], (name: string) => string> = {
  done: (n) => `Agent "${n}" finished its turn.`,
  dialog: (n) => `Agent "${n}" is waiting on a question.`,
  exited: (n) => `Agent "${n}" stopped before finishing.`,
  timeout: (n) => `Agent "${n}" hit the delivery timeout.`,
};

/**
 * The prompt a parent receives about one child.
 *
 * Deliberately small. The parent is almost always the LARGEST session in the
 * tree, which makes it the worst place to pour volume into: measured on this
 * repo's transcripts, a call re-reads ~359k tokens of prefix, i.e. ~36k
 * effective per wake. So this carries the child's own summary plus POINTERS,
 * never the diff — the parent fetches that if it decides it needs one.
 */
export function notificationText(r: ChildReport, port: number): string {
  const lines = [HEADLINE[r.kind](r.name)];

  if (r.kind === "dialog" && r.question) {
    lines.push("", `Question: ${r.question}`);
    if (r.options?.length) lines.push(...r.options.map((o, i) => `  ${i + 1}. ${o}`));
    lines.push("", `Answer with \`pilotctl choose ${r.sessionId} <n>\`, or leave it for the human.`);
  } else if (r.summary?.trim()) {
    lines.push("", r.summary.trim());
  }

  const pointers = [`session \`${r.sessionId}\``];
  if (r.branch) pointers.push(`branch \`${r.branch}\``);
  pointers.push(`diff: http://127.0.0.1:${port}/diff?session=${r.sessionId}`);
  lines.push("", pointers.join(" · "));

  return lines.join("\n");
}

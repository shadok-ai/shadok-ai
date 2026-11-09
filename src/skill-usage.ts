import { cronMentionsSkill } from "./factory.js";

/**
 * "Which agents run this skill ON A SCHEDULE?" — the join behind the Skills
 * card's "Used by schedules" list and the agent panel's cron rows. Pure, so it
 * is tested without a server.
 *
 * Two halves, because each alone lies:
 *  - a cron whose PROMPT names the skill (`/name`, `name:name`, the bare word):
 *    known before the first fire, but blind to a skill the agent picks itself;
 *  - runs RECORDED during a cron fire (`via: "cron"` in the run log): what really
 *    happened, but empty until the cron has fired once.
 * An agent appears when either says so; each cron says whether it names it.
 */

export interface CronLike {
  id: string;
  sessionId: string;
  prompt: string;
  enabled: boolean;
  label: string;
}

export interface CronUse {
  sessionId: string;
  name: string;
  group: string | null;
  /** Runs of this skill made during a cron fire (the stats window). */
  cronRuns: number;
  /** This agent's crons; `mentions` = its prompt names the skill. */
  crons: { id: string; label: string; enabled: boolean; prompt: string; mentions: boolean }[];
}

export function cronUsers(
  skillName: string,
  crons: CronLike[],
  channels: { sessionId: string; name?: string | null; group?: string | null }[],
  cronByAgent: Record<string, number> | undefined,
): CronUse[] {
  const out: CronUse[] = [];
  for (const c of channels) {
    const mine = crons.filter((x) => x.sessionId === c.sessionId);
    const runs = cronByAgent?.[c.sessionId] ?? 0;
    const named = mine.filter((x) => cronMentionsSkill(x.prompt, skillName));
    if (!named.length && !runs) continue;
    out.push({
      sessionId: c.sessionId,
      name: c.name || c.sessionId.slice(0, 8),
      group: c.group ?? null,
      cronRuns: runs,
      // Every cron of the agent when the evidence is a recorded run (we don't
      // know WHICH cron made it); only the naming ones otherwise.
      crons: (named.length ? named : mine).map((x) => ({
        id: x.id,
        label: x.label,
        enabled: x.enabled,
        prompt: x.prompt.length > 160 ? x.prompt.slice(0, 157) + "…" : x.prompt,
        mentions: named.includes(x),
      })),
    });
  }
  return out;
}

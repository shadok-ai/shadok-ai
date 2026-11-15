// The Shadok's voice. The cockpit already had the Shadok's BODY (the header
// mark, the pumping favicon, the thinking indicator); what it lacked was its
// logic — absurd, stubborn, cheerfully wrong-way-round. This module is that
// voice, pure and tested: the maxims the mascot says, the lines the thinking
// indicator cycles through, and counting the Shadok way (base 4: GA BU ZO MEU).
// Original lines written in the Shadoks' spirit, in English like the rest of
// the UI. Randomness is injected so every choice is reproducible in tests.

/** What the mascot says when you click it, and what the empty states muse. */
export const MAXIMS = [
  "When in doubt, pump.",
  "Every failed try is one try closer to the one that works.",
  "No solution? Then there was never a problem.",
  "Better to pump for nothing than to stop and find out.",
  "Why one agent when twelve can disagree?",
  "Green tests are suspicious. Pump again.",
  "To go up, you first have to go down.",
  "If it works, don't touch it. Pump it.",
  "Thinking is just pumping with your eyes closed.",
  "Every bug is a feature nobody pumped hard enough.",
  "Pump today what you could pump tomorrow.",
  "A Shadok never waits. It pumps while waiting.",
  "The shortest path is the one with the most pumping.",
];

/** The thinking indicator's lines, in order. The first is the classic one, so
 *  a short turn still reads exactly as it always did. */
export const PUMP_LINES = [
  "Shadok is pumping",
  "Pumping harder",
  "Ga… Bu… Zo… Meu…",
  "Pumping, therefore thinking",
  "Still pumping",
  "Pumping with conviction",
];

/** How long each pump line stays up. Long enough to be read, short enough that
 *  a minute-long turn shows the rotation. */
export const PUMP_LINE_MS = 3500;

/** The line to show `elapsedMs` into a turn. */
export function pumpLine(elapsedMs) {
  const i = Math.floor(Math.max(0, elapsedMs || 0) / PUMP_LINE_MS);
  return PUMP_LINES[i % PUMP_LINES.length];
}

const DIGITS = ["GA", "BU", "ZO", "MEU"];

/** `n` in the Shadoks' base 4: 0 → "GA", 4 → "BU GA", 11 → "ZO MEU". */
export function gabuzomeu(n) {
  let v = Math.max(0, Math.floor(Number(n) || 0));
  if (v === 0) return DIGITS[0];
  const out = [];
  while (v > 0) { out.unshift(DIGITS[v % 4]); v = Math.floor(v / 4); }
  return out.join(" ");
}

/** A maxim, never the same one twice in a row (`prev`), so clicking the
 *  mascot again always gets a new thought. `rand` is Math.random-shaped. */
export function pickMaxim(rand = Math.random, prev = null) {
  const pool = MAXIMS.filter((m) => m !== prev);
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

/** What the mascot says: usually a maxim, now and then a head count of the
 *  agents in Shadok numerals (one draw in five, when there is anyone to count). */
export function mascotSay(agentCount, rand = Math.random, prev = null) {
  const n = Math.max(0, Math.floor(Number(agentCount) || 0));
  if (n > 0 && rand() < 0.2) {
    const line = `${gabuzomeu(n)} agent${n === 1 ? "" : "s"} pumping. That's ${n}, for the non-Shadoks.`;
    if (line !== prev) return line;
  }
  return pickMaxim(rand, prev);
}

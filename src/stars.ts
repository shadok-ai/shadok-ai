/**
 * The star count of shadok-ai's own repository, for the header button.
 *
 * Fetched HERE and not in the browser, on purpose. GitHub's official button is
 * a third-party script plus an iframe (`buttons.github.io`, `ghbtns.com`), and
 * embedding it would mean opening `script-src` to another origin — the very
 * directive that neutralises HTML an agent writes into the transcript
 * (invariant 12) — and handing GitHub the IP of every cockpit user on every
 * page load. One server-side call, cached, costs neither.
 */

export const STAR_REPO = "shadok-ai/shadok-ai";

/** Long enough that a busy cockpit never hammers GitHub's 60/h anonymous quota. */
const TTL_MS = 6 * 3600_000;

let cached: { at: number; count: number } | null = null;
let inFlight: Promise<number | null> | null = null;

/**
 * Pure: the count as GitHub renders it — thousands separated by commas.
 *
 * Written by hand rather than `toLocaleString`, whose grouping depends on the
 * server's locale: a container in another locale would print "200 227" or
 * "200.227" next to a GitHub logo, which reads as a bug.
 */
export function formatStars(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The count, or null when it cannot be had.
 *
 * Null is a first-class answer: the button renders without a number rather
 * than showing a stale or invented one. A failed fetch keeps whatever was
 * cached — an old count beats no count — but never caches the failure itself.
 */
export async function starCount(repo = STAR_REPO): Promise<number | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.count;
  // Coalesce: several tabs loading at once must not fire several calls.
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "shadok-ai" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return cached?.count ?? null;
      const j = (await res.json()) as { stargazers_count?: unknown };
      if (typeof j.stargazers_count !== "number") return cached?.count ?? null;
      cached = { at: Date.now(), count: j.stargazers_count };
      return cached.count;
    } catch {
      return cached?.count ?? null; // offline, rate-limited, DNS down — all the same here
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

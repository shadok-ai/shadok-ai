/**
 * Finish an OAuth sign-in whose redirect lands on a loopback port of the
 * machine the agents run on.
 *
 * An MCP server (or a CLI like a Search Console helper) signs in by listening
 * on `http://localhost:<port>/…` and sending the person's browser there at the
 * end. When shadok runs in a container or on a remote box, that browser is on
 * ANOTHER machine: the redirect fails, and the agent waits forever for a
 * callback it can never get. The person copies the address that failed to
 * load and pastes it in the web UI; the cockpit, which IS on the agents'
 * machine, opens it for them.
 *
 * Loopback only, http only, explicit port, and the address must LOOK like an
 * OAuth callback (a `code`, `state` or `error` parameter): this relays a
 * callback, it is not a general fetch — anything else is refused before a
 * socket is opened. The cockpit sits where the agents sit, so a relay that took
 * any path on any port was a way for whoever reaches the cockpit to read the
 * machine's local services (a debugger on 9222/9229, a Docker API on 2375,
 * another cockpit). Those ports are refused outright, and the reply carries the
 * listener's STATUS only, never its body — the body is what turned a probe into
 * a read.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type RelayTarget = { ok: true; url: URL } | { ok: false; error: string };
export type RelayResult = { ok: true; status: number } | { ok: false; error: string };

/** Ports no OAuth helper listens on and a relay must never reach: the shadok
 *  port walk (3789…3808), browser/Node debuggers, Docker's API, common
 *  unauthenticated stores. */
const REFUSED_PORTS = new Set<number>([
  ...Array.from({ length: 20 }, (_, i) => 3789 + i),
  2375, 2376, 2379, 5432, 3306, 6379, 9200, 9222, 9229, 11211, 27017,
]);

const CALLBACK_PARAMS = ["code", "state", "error"];

export function relayTarget(raw: unknown, opts: { ownPort?: number } = {}): RelayTarget {
  if (typeof raw !== "string" || !raw.trim())
    return { ok: false, error: "paste the address your browser could not open" };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "not an address" };
  }
  if (url.protocol !== "http:") return { ok: false, error: "only an http://localhost address can be relayed" };
  if (!LOOPBACK.has(url.hostname)) return { ok: false, error: "only a localhost address can be relayed" };
  if (!url.port) return { ok: false, error: "the address has no port — copy it whole from the address bar" };
  if (url.username || url.password) return { ok: false, error: "an address with credentials is refused" };
  const port = Number(url.port);
  if (port === opts.ownPort || REFUSED_PORTS.has(port))
    return { ok: false, error: "that port is not a sign-in listener — copy the address the sign-in redirected to" };
  if (!CALLBACK_PARAMS.some((p) => url.searchParams.has(p)))
    return { ok: false, error: "this does not look like a sign-in callback (no code= or state= in it) — copy the whole address" };
  return { ok: true, url };
}

/** GET the callback where the agent listens; report what the listener said. */
export async function relayOAuthCallback(
  raw: unknown,
  timeoutMs = 10_000,
  opts: { ownPort?: number } = {},
): Promise<RelayResult> {
  const t = relayTarget(raw, opts);
  if (!t.ok) return t;
  // `localhost` can resolve to ::1 alone while the listener is bound to
  // 127.0.0.1 (seen on macOS: ECONNREFUSED, no fallback) — so try both stacks.
  const hosts = t.url.hostname === "localhost" ? ["127.0.0.1", "[::1]"] : [t.url.hostname];
  for (const host of hosts) {
    const url = new URL(t.url);
    url.hostname = host;
    try {
      const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      // Status only: the body is the listener's to show, and passing it back is
      // what made this a read of any local page.
      await r.body?.cancel().catch(() => {});
      return { ok: true, status: r.status };
    } catch {
      // next stack
    }
  }
  return {
    ok: false,
    error: "nothing answered on that port — the sign-in may have timed out; start it again and paste the new address",
  };
}

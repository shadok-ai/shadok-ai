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
 * Loopback only, http only, explicit port: this relays a callback, it is not a
 * general fetch — anything else is refused before a socket is opened.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type RelayTarget = { ok: true; url: URL } | { ok: false; error: string };
export type RelayResult = { ok: true; status: number; text: string } | { ok: false; error: string };

export function relayTarget(raw: unknown): RelayTarget {
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
  return { ok: true, url };
}

/** GET the callback where the agent listens; report what the listener said. */
export async function relayOAuthCallback(raw: unknown, timeoutMs = 10_000): Promise<RelayResult> {
  const t = relayTarget(raw);
  if (!t.ok) return t;
  // `localhost` can resolve to ::1 alone while the listener is bound to
  // 127.0.0.1 (seen on macOS: ECONNREFUSED, no fallback) — so try both stacks.
  const hosts = t.url.hostname === "localhost" ? ["127.0.0.1", "[::1]"] : [t.url.hostname];
  for (const host of hosts) {
    const url = new URL(t.url);
    url.hostname = host;
    try {
      const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      // The listener's page is the only proof the sign-in landed ("Authentication
      // successful…"): pass a short plain-text copy back, never the whole page.
      const text = (await r.text()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
      return { ok: true, status: r.status, text };
    } catch {
      // next stack
    }
  }
  return {
    ok: false,
    error: "nothing answered on that port — the sign-in may have timed out; start it again and paste the new address",
  };
}

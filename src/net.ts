/**
 * Where the server listens, and who may talk to it from a browser.
 *
 * The cockpit runs arbitrary commands on the machine (spawning agents, `sh -c`
 * for cron guards): its only real security boundary is "who can open a
 * connection". This module holds both halves of that boundary, as pure
 * functions — so they are testable without a server.
 *
 * Everything here is pure; the wiring lives in server.ts.
 */

/** Default bind: this machine only. Exposing it to a network is a choice. */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * A bind address that does not leave the machine.
 *
 * `localhost` counts: it resolves to a loopback, and refusing a server that
 * uses it would buy nothing but surprise.
 */
export function isLoopbackHost(host: string): boolean {
  // `[::1]`: the bracketed form, as written in a URL.
  const h = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

/** The listening interface: `SHADOK_HOST`, else the loopback. */
export function resolveHost(env: NodeJS.ProcessEnv = process.env): string {
  const h = (env.SHADOK_HOST ?? "").trim();
  return h || DEFAULT_HOST;
}

/**
 * Why to refuse to start, or null when the configuration is safe.
 *
 * Listening beyond the loopback WITHOUT a password hands the whole network the
 * right to run commands on this machine. The refusal is deliberately
 * fail-closed: documenting the good practice is not enough when the mistake
 * costs the machine. A `0.0.0.0` stays perfectly legitimate — in a container it
 * is the only value that works — it just requires a password.
 */
export function bindRefusal(host: string, hasPassword: boolean): string | null {
  if (isLoopbackHost(host) || hasPassword) return null;
  return (
    `refusing to start: SHADOK_HOST=${host} exposes the cockpit beyond this machine, with no password.\n` +
    `  The cockpit runs arbitrary commands: anyone who can reach it runs them too.\n` +
    `  → add --password <p> (or SHADOK_GUI_PASSWORD), or drop SHADOK_HOST to listen locally only.\n` +
    `  In a container, SHADOK_HOST=0.0.0.0 is normal: publish the port on the host's loopback\n` +
    `  (-p 127.0.0.1:PORT:PORT), because -p PORT:PORT bypasses ufw/firewalld through Docker's iptables rules.`
  );
}

/** The extra origin allowlist (`SHADOK_ORIGINS`, comma-separated). */
export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\/+$/, ""))
    .filter(Boolean);
}

/**
 * May this browser talk to this server?
 *
 * WebSockets are **not subject to the same-origin policy**: without this check,
 * any page the user has open can do `new WebSocket("ws://localhost:3789/ws")`,
 * start an agent and give it orders. The `SameSite=Strict` cookie only covers
 * password-protected instances; the default mode has nothing.
 *
 * The rule is **same-origin**, not a hardcoded `localhost` list: the cockpit is
 * also reached on a LAN IP or a domain behind a proxy, and a frozen allowlist
 * would close all of those. Comparing `Origin` to the request's `Host` works
 * everywhere and still refuses `evil.com`.
 *
 * **No `Origin` → allowed**, and that is not an oversight: non-browser clients
 * send none — the Telegram bridge, which opens a WS on 127.0.0.1 to our own
 * server, `pilotctl`, the CLI, the scheduler skill. Closing them would break
 * the product for nothing: an attacker able to forge that header already has
 * direct network access, and it is the bind + the password that stop them, not
 * this. This guard only ever addresses browsers, the one client that sends an
 * `Origin` it does not control.
 */
export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  extraAllowed: string[] = [],
): boolean {
  if (!origin) return true; // non-browser client
  const o = origin.trim().toLowerCase().replace(/\/+$/, "");
  if (extraAllowed.includes(o)) return true;
  if (!host) return false;
  try {
    // `new URL("null")` throws: an opaque origin (sandboxed iframe, file://)
    // therefore falls through to a refusal, which is the right default.
    return new URL(o).host === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

/**
 * A BROWSER on our own origin — the only caller allowed to change a profile's
 * guardrails (deny/allow/secrets/model).
 *
 * Deliberately stricter than `originAllowed`, which lets an Origin-less client
 * through because Telegram, pilotctl, the CLI and the scheduler need that
 * (invariant 11). An agent's shell is exactly such a caller, and that is what
 * we refuse here: without this, any agent could `curl -X PUT /profiles` with
 * `deny: []` and strip its own guardrails.
 *
 * Not a cryptographic boundary — an agent running as the same OS user can forge
 * the header, or rewrite ~/.shadok-ai/profiles.json outright. It removes the
 * accident and takes the capability off the documented surface.
 */
export function browserOrigin(
  origin: string | undefined,
  host: string | undefined,
  extraAllowed: string[] = [],
): boolean {
  if (!origin || !origin.trim()) return false;
  return originAllowed(origin, host, extraAllowed);
}

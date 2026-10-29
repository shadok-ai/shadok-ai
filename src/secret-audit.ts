/**
 * The secret AUDIT log: who wrote, attached, and above all USED which vault
 * secret — "which agent, started by which person, received which credential".
 *
 * Names only, never a value: the log is read by people who must not learn the
 * credentials from it, and a value written here would be a second copy of the
 * vault with none of its care.
 *
 * Global, like the vault it describes (`~/.shadok-ai/secret-audit.jsonl`, 600),
 * with the launch dir on every row: several instances share one vault, and an
 * audit split per instance would hide the one that touched it. Append-only
 * JSONL — one `appendFileSync` per row, so two instances writing at once never
 * rewrite each other's lines the way a read-modify-write JSON file would.
 * Bounded by rotation (one `.1` kept), not by pruning rows in place: an audit
 * trail that edits its own past is not one.
 *
 * "Use" means INJECTION, which is the only moment shadok hands a value to a
 * process: an agent's spawn (env of `claude`) and a cron guard's run (env of
 * `sh -c`). What the process does with the value afterwards is outside what
 * shadok can see — the log says who RECEIVED a secret, and says so.
 *
 * Pure cores (`auditRow`, `spawnActor`, `httpActor`, `profileSecretDiff`,
 * `parseAudit`, `filterAudit`) are tested; the file I/O is the thin part.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SecretAuditAction =
  | "created"   // a new name in the vault
  | "updated"   // an existing value replaced
  | "deleted"   // removed from the vault
  | "attached"  // a profile now references it → its agents will receive it
  | "detached"  // a profile no longer references it
  | "injected"  // handed to a freshly spawned agent's environment
  | "cron-check"; // handed to a cron guard's shell, no LLM involved

export const SECRET_AUDIT_ACTIONS: SecretAuditAction[] = [
  "created", "updated", "deleted", "attached", "detached", "injected", "cron-check",
];

/** Through which door the action came. */
export type SecretAuditVia = "web" | "agent" | "telegram" | "cron" | "peer" | "api" | "system";

export interface SecretAuditRow {
  at: number;
  action: SecretAuditAction;
  /** Vault NAMES concerned — never values. */
  secrets: string[];
  /** Who did it: an account name, `agent <id8>`, a Telegram sender, `cron <id8>`… */
  actor: string;
  via: SecretAuditVia;
  /** The agent concerned (the one that received it, or the one that acted). */
  agent?: string;
  agentName?: string;
  profile?: string;
  /** Launch dir of the instance that wrote the row. */
  instance: string;
  detail?: string;
}

const FILE = path.join(os.homedir(), ".shadok-ai", "secret-audit.jsonl");
/** Rotate past this size, keeping exactly one previous file. */
export const AUDIT_ROTATE_BYTES = 8 * 1024 * 1024;

// ── Pure core ────────────────────────────────────────────────────────────

/** Build a row, or null when there is nothing to record (no secret named). An
 *  agent spawned with no secret received none, and a row saying so is noise. */
export function auditRow(
  r: Omit<SecretAuditRow, "at" | "secrets"> & { secrets: (string | undefined | null)[] },
  now: number,
): SecretAuditRow | null {
  const secrets = [...new Set(r.secrets.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()))].sort();
  if (!secrets.length) return null;
  const row: SecretAuditRow = { at: now, action: r.action, secrets, actor: r.actor || "unknown", via: r.via, instance: r.instance };
  if (r.agent) row.agent = r.agent;
  if (r.agentName) row.agentName = r.agentName;
  if (r.profile) row.profile = r.profile;
  if (r.detail) row.detail = r.detail;
  return row;
}

/**
 * Who started (or restarted) an agent, from what the WebSocket connection
 * knows. The ORDER is the point: the most specific principal wins. A peer
 * names a remote instance; a parent names the agent that delegated (pilotctl
 * connects as the bootstrap admin, so the account alone would credit a person
 * who did nothing); a cron or Telegram origin names a door with no account of
 * its own. Only a plain web client is credited to its signed-in account.
 */
export function spawnActor(c: {
  account?: string | null;
  origin?: string | null;
  peer?: string | null;
  parent?: string | null;
  from?: string | null;
}): { actor: string; via: SecretAuditVia } {
  if (c.peer) return { actor: `peer ${c.peer}`, via: "peer" };
  if (c.parent) return { actor: `agent ${c.parent.slice(0, 8)}`, via: "agent" };
  if (c.origin === "cron") return { actor: "cron", via: "cron" };
  if (c.origin === "telegram") return { actor: c.from ? `telegram ${c.from}` : "telegram", via: "telegram" };
  if (c.origin === "web") return { actor: c.account || "unknown", via: "web" };
  return { actor: c.account || c.origin || "unknown", via: c.origin ? "api" : "system" };
}

/** Who made an HTTP call: an agent by its session key beats the account it
 *  authenticates as (which is the bootstrap admin for every agent). */
export function httpActor(c: {
  agentId?: string | null;
  account?: string | null;
  browser: boolean;
}): { actor: string; via: SecretAuditVia; agent?: string } {
  if (c.agentId) return { actor: `agent ${c.agentId.slice(0, 8)}`, via: "agent", agent: c.agentId };
  return { actor: c.account || "unknown", via: c.browser ? "web" : "api" };
}

/** Names a profile write adds and removes. */
export function profileSecretDiff(before: string[] | undefined, after: string[] | undefined): { added: string[]; removed: string[] } {
  const b = new Set(before ?? []);
  const a = new Set(after ?? []);
  return { added: [...a].filter((n) => !b.has(n)).sort(), removed: [...b].filter((n) => !a.has(n)).sort() };
}

/** Parse JSONL, skipping any line that is not a row (a torn write, a hand edit). */
export function parseAudit(text: string): SecretAuditRow[] {
  const out: SecretAuditRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.at === "number" && typeof r.action === "string" && Array.isArray(r.secrets)) out.push(r);
    } catch {
      /* torn line */
    }
  }
  return out;
}

export interface AuditQuery {
  secret?: string;
  actor?: string;
  agent?: string;
  action?: string;
  since?: number;
  limit?: number;
}

/** Newest first, narrowed. `secret` is exact (it is a name); `actor`/`agent`
 *  are substrings, since a person searches by a fragment of a name or an id. */
export function filterAudit(rows: SecretAuditRow[], q: AuditQuery): SecretAuditRow[] {
  const actor = q.actor?.toLowerCase();
  const agent = q.agent?.toLowerCase();
  const out = rows.filter(
    (r) =>
      (!q.secret || r.secrets.includes(q.secret)) &&
      (!q.action || r.action === q.action) &&
      (!q.since || r.at >= q.since) &&
      (!actor || r.actor.toLowerCase().includes(actor)) &&
      (!agent || (r.agent ?? "").toLowerCase().includes(agent) || (r.agentName ?? "").toLowerCase().includes(agent)),
  );
  out.sort((a, b) => b.at - a.at);
  return q.limit && q.limit > 0 ? out.slice(0, q.limit) : out;
}

// ── Storage ──────────────────────────────────────────────────────────────

/** Append one row. Never throws: losing an audit line must not fail the
 *  action it describes — but it says so, since a silent gap is the failure an
 *  audit exists to rule out. */
export function recordSecretAudit(
  r: Parameters<typeof auditRow>[0],
  file: string = FILE,
): SecretAuditRow | null {
  const row = auditRow(r, Date.now());
  if (!row) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > AUDIT_ROTATE_BYTES) fs.renameSync(file, file + ".1");
    } catch {
      /* no file yet */
    }
    fs.appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    console.log(`secret-audit: ${row.action} [${row.secrets.join(",")}] by ${row.actor}${row.agent ? ` → ${row.agent.slice(0, 8)}` : ""}`);
    return row;
  } catch (err) {
    console.log(`secret-audit: could not record ${row.action} [${row.secrets.join(",")}] — ${(err as Error).message}`);
    return null;
  }
}

/** Every row we still hold (the rotated file first, so order is preserved). */
export function readSecretAudit(file: string = FILE): SecretAuditRow[] {
  let text = "";
  for (const f of [file + ".1", file]) {
    try {
      text += fs.readFileSync(f, "utf8") + "\n";
    } catch {
      /* absent */
    }
  }
  return parseAudit(text);
}

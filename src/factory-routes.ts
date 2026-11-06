/**
 * HTTP surface of the Skill Factory (src/factory.ts). Mounted by server.ts with
 * the few server helpers it needs, so the hub does not grow another 300 lines.
 *
 * Who may do what (phase 2, single-tenant — the one group is `main`):
 * - READ (list, tree, file, log, diff, bundle, scan): anyone past the password
 *   gate, an agent included (by its session key).
 * - WRITE by a person: same-origin browser only (create, save, release, accept,
 *   attach, update, duplicate, adopt). Release is open to every editor — it is
 *   not the gate, acceptance is; deleting a `Main` skill stays an admin act.
 * - FEEDBACK: any agent (session key) or person — the agents that USE a skill
 *   are the ones that find what is wrong with it.
 * - PUSH by an agent: its session key, and its channel's profile must be the
 *   managed `Shadok-Skillsmith`. Not every agent of the group: on a
 *   single-tenant instance that would be every agent on the machine.
 * See docs/superpowers/specs/2026-10-29-skill-factory-design.md.
 */
import fs from "node:fs";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import type { Channel } from "./channels.js";
import os from "node:os";
import {
  accept,
  acceptanceFor,
  acceptedAnywhere,
  approvalFrom,
  pushVerdict,
  addFeedback,
  adoptable,
  adoptSkill,
  closeFeedback,
  duplicateSkill,
  bundleOf,
  createSkill,
  cutRelease,
  deleteSkill,
  diff,
  FactoryError,
  factoryRoot,
  findSkill,
  headCommit,
  listTree,
  loadRegistry,
  log,
  MAIN_GROUP,
  prepareWorkspace,
  readFile,
  scopeError,
  groupsScope,
  runStats,
  updateMeta,
  cleanTags,
  scopeVisibleTo,
  slugify,
  type AgentCtx,
  receivePush,
  saveFile,
  scanMain,
  unreleased,
  type FactorySkill,
  type Release,
} from "./factory.js";
import { parseManifest, type ScanSecret } from "./factory-scan.js";
import { SKILLSMITH_PROFILE_NAME } from "./profiles.js";

export { SKILLSMITH_PROFILE_NAME };
/** A push is a few scripts and Markdown; the scan also caps the tree at 4 MB. */
const PUSH_LIMIT = "8mb";

export interface FactoryDeps {
  requestFromBrowser(req: Request): boolean;
  /** The person (or the bootstrap admin) behind a request, null if none. */
  personName(req: Request): string | null;
  /** Admin gate: sends the 403 itself and returns null when refused. */
  requireAdmin(req: Request, res: Response, what: string): unknown | null;
  callerOf(req: Request): { id: string | null; profile: string | null };
  /**
   * The vault the scan compares against, as the CALLER's group sees it (an
   * agent: its channel's group; a person: the group they spawn in). Main's
   * vault for everyone made the scan an oracle on secrets of other groups.
   */
  vault(req: Request): Record<string, string>;
  /** May this request drive (and so attach to / list) that agent? Mono-tenant: yes. */
  mayDrive(req: Request, sessionId: string): boolean;
  /** The group an agent's acceptances are keyed by (mono-tenant: always `main`). */
  agentGroup(sessionId: string): string;
  /** The group a PERSON accepts for by default (mono-tenant: `main`). */
  personGroup(req: Request): string;
  /** May this request accept on behalf of `group`? (it is one of theirs, or public) */
  mayActForGroup(req: Request, group: string): boolean;
  /** A cockpit group id (or null) → the group acceptances are keyed by. */
  tenantGroup(groupId: string | null): string;
  loadChannels(): Channel[];
  upsertChannel(patch: Partial<Channel> & { sessionId: string }): void;
  /** Re-evaluate an agent's reload indicator after its attachments changed. */
  onAttachmentsChanged(sessionId: string): void;
  /** Remove release directories nothing references any more (see `prunePlugins`). */
  prune(): void;
  /** Reload an agent now if it is idle; otherwise it is only marked stale. */
  reloadIfIdle(sessionId: string): "reloaded" | "stale" | "offline";
  /** The MCP server names an agent's profile carries (for `requires.mcp`). */
  agentMcp(sessionId: string): string[];
  /** The cockpit's groups (`{id, name, icon}`), for a skill's group scope. */
  groups(): { id: string; name?: string; icon?: string }[];
  /**
   * Where a Skillsmith started by this person in `group` will live: the group
   * it will really be born in (same rule as a spawn), the OS user it will run
   * as and that user's HOME. Mono-tenant: `{home: server HOME, user: null}`.
   */
  workspaceFor(req: Request, group: string | null): { home: string; user: string | null; group: string | null };
  /** An agent's schedules, for "where it runs" (label + prompt). */
  cronsOf(sessionId: string): { label: string; prompt: string }[];
  audit(row: Record<string, unknown>): void;
}

const secretsOf = (v: Record<string, string>): ScanSecret[] => Object.entries(v).map(([name, value]) => ({ name, value }));

function fail(res: Response, e: unknown): void {
  if (e instanceof FactoryError) {
    res.status(e.status).json({ error: e.message, ...(e.scan ? { scan: e.scan } : {}) });
    return;
  }
  console.error("factory:", (e as Error)?.message ?? e);
  res.status(500).json({ error: "factory error" });
}

export function mountFactory(app: Express, deps: FactoryDeps): void {
  const root = () => factoryRoot();

  /** The card as the panel shows it: registry + live facts (head, bindings, where attached). */
  const view = (s: FactorySkill, channels: Channel[], vaultNames: Set<string>, stats: ReturnType<typeof runStats>, group: string) => {
    const head = headCommit(root(), s.id);
    const manifest = parseManifest(readFile(root(), s.id, "shadok-skill.json")).manifest;
    const required = manifest.requires?.secrets ?? [];
    return {
      ...s,
      head,
      unreleased: unreleased(s, head),
      bindings: required.map((name) => ({ name, bound: vaultNames.has(name) })),
      latestAccepted: latestAccepted(s, group)?.n ?? null,
      attachedTo: channels
        .filter((c) => c.skills?.some((a) => a.skill === s.id))
        .map((c) => {
          const release = c.skills!.find((a) => a.skill === s.id)!.release;
          const rel = s.releases.find((r) => r.n === release);
          const mcpHave = new Set(deps.agentMcp(c.sessionId));
          return {
            sessionId: c.sessionId,
            name: c.name ?? c.sessionId.slice(0, 8),
            group: c.group ?? null,
            runs: stats.byAgent[s.name]?.[c.sessionId] ?? 0,
            crons: deps.cronsOf(c.sessionId),
            release,
            // What THIS agent gets: each granted secret, present in the vault or not.
            secrets: (rel?.secrets ?? []).map((n) => ({ name: n, bound: vaultNames.has(n), detected: !!rel?.detectedSecrets?.includes(n) })),
            mcp: (rel?.mcp ?? []).map((n) => ({ name: n, present: mcpHave.has(n) })),
            update: (latestAccepted(s, deps.agentGroup(c.sessionId))?.n ?? 0) > release ? latestAccepted(s, deps.agentGroup(c.sessionId))!.n : null,
          };
        }),
      feedback: (s.feedback ?? []).slice().reverse(),
      tags: s.tags ?? [],
      runs7d: stats.bySkill[s.name] ?? 0,
      lastRun: stats.last[s.name] ?? null,
    };
  };
  const latestAccepted = (s: FactorySkill, group: string) =>
    [...s.releases].reverse().find((r) => !!acceptanceFor(s, r, group));

  const by = (req: Request): string => {
    const agent = deps.callerOf(req);
    if (agent.id) return `agent:${agent.profile ?? "no profile"}/${agent.id.slice(0, 8)} (${deps.agentGroup(agent.id)})`;
    return deps.personName(req) ?? "cockpit";
  };

  /**
   * Does this request carry a MACHINE credential — an agent's session key (as a
   * header or the `key` body field `callerOf` also reads) or a peer token? A
   * browser never sends one, and an agent can forge an `Origin` header with
   * curl, so the same-origin check alone does not prove a person is clicking.
   * Checked on presence, not validity: a person has no reason to send either.
   */
  const machine = (req: Request): boolean =>
    !!req.headers["x-shadok-session-key"] ||
    !!req.headers["x-shadok-peer"] ||
    (!Buffer.isBuffer(req.body) && typeof (req.body as { key?: unknown } | undefined)?.key === "string") ||
    !!deps.callerOf(req).id;

  /** A PERSON's click: same-origin browser AND no agent/peer credential. */
  const browser = (req: Request, res: Response): boolean => {
    if (deps.requestFromBrowser(req) && !machine(req)) return true;
    res.status(403).json({ error: "same-origin browser only — a person does this, not an agent" });
    return false;
  };

  /**
   * The secrets a release asks for must be approved by the person, by name,
   * before an acceptance grants them. Returns the approved list, or answers 409
   * with `needsApproval` (the names to show) and returns null.
   */
  const approval = (rel: Release, raw: unknown, res: Response): string[] | null => {
    const ok = approvalFrom(rel, raw);
    if (ok !== undefined) return ok;
    res.status(409).json({
      error: `v${rel.n} asks for vault secrets (${rel.secrets.join(", ")}) — approve them by name to grant them`,
      needsApproval: rel.secrets,
    });
    return null;
  };

  /** The group a person accepts for: the one asked (if theirs), else their default. */
  const acceptGroup = (req: Request, res: Response): string | null => {
    const asked = typeof req.body?.group === "string" && req.body.group.trim() ? req.body.group.trim() : null;
    const g = asked ?? deps.personGroup(req);
    if (!deps.mayActForGroup(req, g)) {
      res.status(403).json({ error: `you cannot accept for ${g}` });
      return null;
    }
    return g;
  };

  /**
   * Who is asking, for scope: a person (by account) or an agent (by its key —
   * its group and creator). A "just me" skill is invisible to everyone else: it
   * answers 404, never 403, so its existence does not leak either.
   */
  const ctxOf = (c: Channel | undefined): AgentCtx => ({ group: c?.group ?? null, createdBy: c?.createdBy ?? null });
  const canSee = (req: Request, s: FactorySkill): boolean => {
    const agent = deps.callerOf(req);
    if (agent.id) {
      const ch = deps.loadChannels().find((c) => c.sessionId === agent.id);
      // An agent sees what its creator sees, plus a private skill its owner
      // put on it (a skill attached to someone else's agent).
      return scopeVisibleTo(s.owner, ch?.createdBy ?? null) || !!ch?.skills?.some((a) => a.skill === s.id);
    }
    return scopeVisibleTo(s.owner, deps.personName(req));
  };
  const skillOr404 = (req: Request, res: Response): FactorySkill | null => {
    const s = findSkill(root(), String(req.params.id));
    if (!s || !canSee(req, s)) {
      res.status(404).json({ error: "no such skill" });
      return null;
    }
    return s;
  };
  /**
   * The form's "shared with" → the stored owner: "me" (only you), "all"
   * (everyone), or `{groups: [ids]}` / "groups:1,3" (the agents of those groups
   * — one skill shared across several teams).
   */
  const ownerFrom = (req: Request, scope: unknown): string => {
    if (scope === "me") return `user:${deps.personName(req) ?? "admin"}`;
    if (scope === "all" || scope === "org" || scope === MAIN_GROUP || scope == null || scope === "") return MAIN_GROUP;
    const stored =
      scope && typeof scope === "object" && Array.isArray((scope as { groups?: unknown }).groups)
        ? groupsScope((scope as { groups: unknown[] }).groups.filter((g) => typeof g === "string" || typeof g === "number").map(String))
        : String(scope);
    const err = scopeError(stored, deps.groups().map((g) => g.id));
    if (err) throw new FactoryError(err);
    return stored;
  };

  app.get("/factory/skills", (req, res) => {
    // Only the agents this caller may drive: the list carries names, groups,
    // creators and schedule prompts of every agent it names.
    const channels = deps.loadChannels().filter((c) => deps.mayDrive(req, c.sessionId));
    const names = new Set(Object.keys(deps.vault(req)));
    const agent = deps.callerOf(req);
    const group = agent.id ? deps.agentGroup(agent.id) : deps.personGroup(req);
    res.json({
      group,
      me: deps.personName(req),
      groups: deps.groups().map((g) => ({ id: g.id, name: g.name ?? `group ${g.id}`, icon: g.icon ?? "" })),
      skills: (() => {
        const stats = runStats(root(), Date.now() - 7 * 86_400_000);
        return loadRegistry(root()).skills.filter((s) => canSee(req, s)).map((s) => view(s, channels, names, stats, group));
      })(),
      agents: channels.map((c) => ({
        sessionId: c.sessionId,
        name: c.name ?? c.sessionId.slice(0, 8),
        skills: c.skills ?? [],
        mcp: deps.agentMcp(c.sessionId),
        group: c.group ?? null,
        createdBy: c.createdBy ?? null,
      })),
    });
  });

  app.post("/factory/skills", (req, res) => {
    if (!browser(req, res)) return;
    try {
      // A person types a TITLE ("Daily marketing summary"); the technical name
      // agents see is derived from it, and made unique rather than refused.
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      let name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : slugify(title);
      if (!name) throw new FactoryError("give the skill a name");
      if (findSkill(root(), name)) {
        let i = 2;
        while (findSkill(root(), `${name}-${i}`)) i++;
        name = `${name}-${i}`;
      }
      const s = createSkill(root(), {
        name, title, description: req.body?.description, by: by(req), owner: ownerFrom(req, req.body?.scope),
        editors: [deps.personGroup(req)],
      });
      if (req.body?.tags) updateMeta(root(), s.id, { tags: cleanTags(req.body.tags) });
      deps.audit({ action: "create", skill: s.name, by: by(req) });
      res.json({ skill: s });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * Administer a skill: who it is shared with, its tags, archived or not, its
   * name and description. Narrowing or widening who it is shared with is the
   * creator's (or an admin's) call; tags and archiving, anyone who sees it.
   */
  app.put("/factory/skills/:id/meta", (req, res) => {
    if (!browser(req, res)) return;
    const s = skillOr404(req, res);
    if (!s) return;
    try {
      const b = req.body ?? {};
      const patch: Parameters<typeof updateMeta>[2] = {};
      if (b.scope !== undefined) {
        const me = deps.personName(req) ?? "admin";
        if (s.createdBy !== me && s.owner !== `user:${me}` && !deps.requireAdmin(req, res, "change who a shared skill is shared with")) return;
        patch.owner = ownerFrom(req, b.scope);
      }
      if (b.tags !== undefined) patch.tags = cleanTags(b.tags);
      if (b.archived !== undefined) patch.archived = !!b.archived;
      if (b.title !== undefined) patch.title = String(b.title);
      if (b.description !== undefined) patch.description = String(b.description);
      const out = updateMeta(root(), s.id, patch);
      deps.audit({ action: "meta", skill: s.name, ...patch, by: by(req) });
      res.json({ skill: out });
    } catch (e) {
      fail(res, e);
    }
  });

  app.delete("/factory/skills/:id", (req, res) => {
    // A person's act either way: an agent's key IS the bootstrap admin, so the
    // admin check alone would let any agent delete a shared skill.
    if (!browser(req, res)) return;
    const s = skillOr404(req, res);
    if (!s) return;
    // Yours: you delete it. Shared (a group's, the organisation's): an admin.
    if (!s.owner.startsWith("user:") && !deps.requireAdmin(req, res, "delete a shared factory skill")) return;
    const attached = deps.loadChannels().filter((c) => c.skills?.some((a) => a.skill === s.id));
    if (attached.length && req.query.force !== "1")
      return res.status(409).json({
        error: `attached to ${attached.map((c) => c.name ?? c.sessionId.slice(0, 8)).join(", ")} — detach first or force`,
      });
    for (const c of attached) {
      deps.upsertChannel({ sessionId: c.sessionId, skills: c.skills!.filter((a) => a.skill !== s.id) });
      deps.onAttachmentsChanged(c.sessionId);
    }
    deleteSkill(root(), s.id);
    deps.audit({ action: "delete", skill: s.name, by: by(req) });
    res.json({ ok: true });
  });

  app.get("/factory/skills/:id/tree", (req, res) => {
    const s = skillOr404(req, res);
    if (!s) return;
    try {
      res.json({ head: headCommit(root(), s.id), files: listTree(root(), s.id) });
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/factory/skills/:id/file", (req, res) => {
    const s = skillOr404(req, res);
    if (!s) return;
    const rev = typeof req.query.rev === "string" && /^v\d+$/.test(req.query.rev) ? `refs/tags/${req.query.rev}` : undefined;
    const content = readFile(root(), s.id, String(req.query.path ?? ""), rev);
    if (content === null) return res.status(404).json({ error: "no such file" });
    res.json({ path: req.query.path, content, head: headCommit(root(), s.id) });
  });

  app.get("/factory/skills/:id/log", (req, res) => {
    const s = skillOr404(req, res);
    if (!s) return;
    res.json({ log: log(root(), s.id) });
  });

  app.get("/factory/skills/:id/diff", (req, res) => {
    const s = skillOr404(req, res);
    if (!s) return;
    try {
      const from = typeof req.query.from === "string" && req.query.from ? req.query.from : null;
      const to = typeof req.query.to === "string" && req.query.to ? req.query.to : "main";
      res.type("text/plain").send(diff(root(), s.id, from, to));
    } catch (e) {
      fail(res, e);
    }
  });

  /** A browser save: one file (content null = delete), scanned BEFORE it is committed. */
  app.put("/factory/skills/:id/file", (req, res) => {
    if (!browser(req, res)) return;
    const s = skillOr404(req, res);
    if (!s) return;
    const b = req.body ?? {};
    try {
      const out = saveFile(root(), s.id, {
        path: String(b.path ?? ""),
        content: b.delete === true ? null : typeof b.content === "string" ? b.content : "",
        base: typeof b.base === "string" ? b.base : null,
        by: by(req),
        secrets: secretsOf(deps.vault(req)),
      });
      deps.audit({ action: "save", skill: s.name, path: b.path, by: by(req) });
      res.json({ ok: true, ...out });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * "Work on it with an agent": make (or fast-forward) the clone the Skillsmith
   * will start in, and hand back its directory. The clone goes in the HOME of
   * the OS user the agent will run as — in multi-tenant, its group's drop user,
   * which cannot traverse the server's `/root` — and is made by that user. The
   * group it will be born in is handed back so the client starts it THERE, and
   * the clone and the agent cannot end up under two different users.
   */
  app.post("/factory/skills/:id/workspace", (req, res) => {
    if (!browser(req, res)) return;
    const s = skillOr404(req, res);
    if (!s) return;
    try {
      const asked = typeof req.body?.group === "string" && req.body.group.trim() ? req.body.group.trim() : null;
      const at = deps.workspaceFor(req, asked);
      const why = pushVerdict(s, { group: deps.tenantGroup(at.group), createdBy: deps.personName(req) });
      if (why) throw new FactoryError(`${why} — a Skillsmith started there could not push`, 403);
      res.json({ cwd: prepareWorkspace(root(), s.id, at.home, at.user), profile: SKILLSMITH_PROFILE_NAME, name: s.name, group: at.group });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/factory/skills/:id/scan", (req, res) => {
    const s = skillOr404(req, res);
    if (!s) return;
    try {
      res.json(scanMain(root(), s.id, secretsOf(deps.vault(req))));
    } catch (e) {
      fail(res, e);
    }
  });

  // ── The agent's clone: pull a bundle, push one back ────────────────────────
  app.get("/factory/skills/:id/bundle", (req, res) => {
    const s = skillOr404(req, res);
    if (!s) return;
    try {
      res.type("application/octet-stream").send(bundleOf(root(), s.id));
    } catch (e) {
      fail(res, e);
    }
  });

  app.post(
    "/factory/skills/:id/push",
    express.raw({ type: () => true, limit: PUSH_LIMIT }),
    (req, res) => {
      const caller = deps.callerOf(req);
      if (!caller.id) return res.status(403).json({ error: "push needs your x-shadok-session-key" });
      if (caller.profile !== SKILLSMITH_PROFILE_NAME)
        return res.status(403).json({
          error: `only a ${SKILLSMITH_PROFILE_NAME} agent may push to a factory skill — ask the person to open it with "Work on it"`,
        });
      const s = skillOr404(req, res);
      if (!s) return;
      const ch = deps.loadChannels().find((c) => c.sessionId === caller.id);
      const why = pushVerdict(s, { group: deps.agentGroup(caller.id), createdBy: ch?.createdBy ?? null });
      if (why) return res.status(403).json({ error: why });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "empty bundle" });
      try {
        const out = receivePush(root(), s.id, req.body, { by: by(req), secrets: secretsOf(deps.vault(req)) });
        deps.audit({ action: "push", skill: s.name, commits: out.commits, by: by(req) });
        res.json({ ok: true, ...out });
      } catch (e) {
        fail(res, e);
      }
    },
  );

  // ── Release, accept, attach — a person's clicks ───────────────────────────
  app.post("/factory/skills/:id/release", (req, res) => {
    // Any editor releases (revised 2026-10-31): a release runs nowhere until a
    // person of the running group accepts it, so gating it on admin only blocked
    // the people who improve the skill, and protected nothing.
    if (!browser(req, res)) return;
    const s = skillOr404(req, res);
    if (!s) return;
    const group = req.body?.accept === true ? acceptGroup(req, res) : null;
    if (req.body?.accept === true && !group) return;
    try {
      // The approval is asked BEFORE the release is cut, from what it would
      // ask for: a 409 after cutting would leave a retry facing "already this
      // exact content".
      let approved: string[] | null = null;
      if (group) {
        const would = scanMain(root(), s.id, secretsOf(deps.vault(req))).secrets;
        approved = approval({ n: (s.releases[s.releases.length - 1]?.n ?? 0) + 1, secrets: would } as Release, req.body?.approveSecrets, res);
        if (!approved) return;
      }
      const rel = cutRelease(root(), s.id, { by: by(req), note: req.body?.note, secrets: secretsOf(deps.vault(req)) });
      deps.audit({ action: "release", skill: s.name, release: rel.n, tree: rel.tree, by: by(req) });
      // "Release and accept" in one click: the releaser is a person of the group.
      if (group && approved) {
        accept(root(), s.id, { group, release: rel.n, by: by(req), secrets: approved });
        deps.audit({ action: "accept", skill: s.name, release: rel.n, tree: rel.tree, group, secrets: approved, by: by(req) });
      }
      res.json({ release: rel });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/factory/skills/:id/accept", (req, res) => {
    if (!browser(req, res)) return;
    const s = skillOr404(req, res);
    if (!s) return;
    const group = acceptGroup(req, res);
    if (!group) return;
    const rel = s.releases.find((r) => r.n === Number(req.body?.release));
    if (!rel) return res.status(404).json({ error: `no release v${req.body?.release}` });
    const approved = approval(rel, req.body?.approveSecrets, res);
    if (!approved) return;
    try {
      const a = accept(root(), s.id, { group, release: rel.n, by: by(req), secrets: approved });
      deps.audit({ action: "accept", skill: s.name, release: a.release, tree: a.tree, group: a.group, secrets: approved, by: by(req) });
      res.json({ acceptance: a });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * Move every agent running an older release of this skill to release N (it
   * must be accepted), and reload the idle ones now — an explicit click, so an
   * explicit respawn. Busy agents are only marked stale: their own reload applies it.
   */
  app.post("/factory/skills/:id/update", (req, res) => {
    if (!browser(req, res)) return;
    const s = skillOr404(req, res);
    if (!s) return;
    const rel = s.releases.find((r) => r.n === Number(req.body?.release));
    if (!rel) return res.status(404).json({ error: "no such release" });
    if (!acceptedAnywhere(s, rel)) return res.status(409).json({ error: `v${rel.n} has not been accepted yet` });
    const out: { name: string; result: string }[] = [];
    // Only agents this person may drive, and only where v<N> is accepted for
    // THEIR group: another group's agent is that group's people's decision.
    for (const c of deps.loadChannels()) {
      const cur = c.skills?.find((a) => a.skill === s.id);
      if (!cur || cur.release >= rel.n) continue;
      if (!deps.mayDrive(req, c.sessionId) || !acceptanceFor(s, rel, deps.agentGroup(c.sessionId))) continue;
      deps.upsertChannel({ sessionId: c.sessionId, skills: c.skills!.map((a) => (a.skill === s.id ? { ...a, release: rel.n } : a)) });
      deps.onAttachmentsChanged(c.sessionId);
      out.push({ name: c.name ?? c.sessionId.slice(0, 8), result: deps.reloadIfIdle(c.sessionId) });
    }
    deps.prune();
    deps.audit({ action: "update", skill: s.name, release: rel.n, agents: out.length, by: by(req) });
    res.json({ updated: out });
  });

  /**
   * "Save" in the editor: what is saved is what agents run. One click cuts a
   * release of the current content (or reuses the last one when nothing changed
   * since), accepts it — the person saving is a person of the running group —
   * and moves every agent that has the skill onto it, reloading the idle ones.
   * Versions and approval stay underneath (the plugin dir is content-addressed,
   * an attachment pins a release), they are just no longer a step people take.
   */
  app.post("/factory/skills/:id/publish", (req, res) => {
    if (!browser(req, res)) return;
    const s = skillOr404(req, res);
    if (!s) return;
    const group = acceptGroup(req, res);
    if (!group) return;
    try {
      const last = s.releases[s.releases.length - 1];
      const head = headCommit(root(), s.id);
      const rel = last && head && last.commit === head
        ? last
        : cutRelease(root(), s.id, { by: by(req), secrets: secretsOf(deps.vault(req)) });
      if (rel !== last) deps.audit({ action: "release", skill: s.name, release: rel.n, tree: rel.tree, by: by(req) });
      if (!acceptanceFor(findSkill(root(), s.id)!, rel, group)) {
        // The release is cut (a retry reuses it); what it may RECEIVE waits for
        // the person to approve each secret name it asks for.
        const approved = approval(rel, req.body?.approveSecrets, res);
        if (!approved) return;
        accept(root(), s.id, { group, release: rel.n, by: by(req), secrets: approved });
        deps.audit({ action: "accept", skill: s.name, release: rel.n, tree: rel.tree, group, secrets: approved, by: by(req) });
      }
      const updated: { name: string; result: string }[] = [];
      for (const c of deps.loadChannels()) {
        const cur = c.skills?.find((a) => a.skill === s.id);
        if (!cur || cur.release === rel.n) continue;
        // Never move an agent this person may not drive, nor one of a group
        // that did not accept this release (it would be dropped at its spawn).
        if (!deps.mayDrive(req, c.sessionId) || deps.agentGroup(c.sessionId) !== group) continue;
        deps.upsertChannel({ sessionId: c.sessionId, skills: c.skills!.map((a) => (a.skill === s.id ? { ...a, release: rel.n } : a)) });
        deps.onAttachmentsChanged(c.sessionId);
        updated.push({ name: c.name ?? c.sessionId.slice(0, 8), result: deps.reloadIfIdle(c.sessionId) });
      }
      deps.prune();
      res.json({ release: rel, updated });
    } catch (e) {
      fail(res, e);
    }
  });

  /** Feedback: an agent that USED the skill (session key), or a person. */
  app.post("/factory/skills/:id/feedback", (req, res) => {
    const agent = deps.callerOf(req);
    if (!agent.id && !deps.requestFromBrowser(req))
      return res.status(403).json({ error: "feedback comes from an agent (session key) or the cockpit" });
    const s = skillOr404(req, res);
    if (!s) return;
    try {
      // The release the reporting agent runs, when it runs this skill at all.
      const running = agent.id
        ? deps.loadChannels().find((c) => c.sessionId === agent.id)?.skills?.find((a) => a.skill === s.id)?.release
        : undefined;
      const f = addFeedback(root(), s.id, { by: by(req), text: String(req.body?.text ?? ""), release: running });
      deps.audit({ action: "feedback", skill: s.name, id: f.id, by: by(req) });
      res.json({ feedback: f });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/factory/skills/:id/feedback/:fid/done", (req, res) => {
    if (!browser(req, res)) return;
    const s = skillOr404(req, res);
    if (!s) return;
    try {
      closeFeedback(root(), s.id, { id: String(req.params.fid), by: by(req) });
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/factory/skills/:id/duplicate", (req, res) => {
    if (!browser(req, res)) return;
    const s = skillOr404(req, res);
    if (!s) return;
    try {
      const release = req.body?.release != null ? Number(req.body.release) : s.releases[s.releases.length - 1]?.n;
      const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : slugify(String(req.body?.title ?? ""));
      const d = duplicateSkill(root(), s.id, {
        name, release, description: req.body?.description, by: by(req), editors: [deps.personGroup(req)],
        ...(req.body?.scope ? { owner: ownerFrom(req, req.body.scope) } : {}),
      });
      deps.audit({ action: "duplicate", skill: d.name, origin: d.origin, by: by(req) });
      res.json({ skill: d });
    } catch (e) {
      fail(res, e);
    }
  });

  /** Skills already on this machine (~/.claude/skills) that can be brought in. */
  const skillsDir = () => process.env.SHADOK_ADOPT_DIR || path.join(os.homedir(), ".claude", "skills");
  app.get("/factory/adoptable", (_req, res) => {
    res.json({ dir: skillsDir(), skills: adoptable(skillsDir(), root()) });
  });

  app.post("/factory/adopt", (req, res) => {
    if (!browser(req, res)) return;
    try {
      const s = adoptSkill(root(), {
        skillsDir: skillsDir(),
        dir: String(req.body?.dir ?? ""),
        name: typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : undefined,
        by: by(req),
        secrets: secretsOf(deps.vault(req)),
        owner: ownerFrom(req, req.body?.scope ?? "me"),
        editors: [deps.personGroup(req)],
      });
      deps.audit({ action: "adopt", skill: s.name, origin: s.origin, by: by(req) });
      res.json({ skill: s });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * Attach (release N) or detach (release null) a skill on an agent. Never
   * respawns: it marks the agent stale and the person reloads it — killing a
   * working agent because someone clicked in another panel is what the reload
   * indicator exists to avoid.
   */
  app.post("/factory/attach", (req, res) => {
    if (!browser(req, res)) return;
    const sessionId = String(req.body?.sessionId ?? "");
    const ch = deps.loadChannels().find((c) => c.sessionId === sessionId);
    // An agent this person may not drive does not exist for them (404, not 403:
    // its id is no confirmation of anything).
    if (!ch || !deps.mayDrive(req, sessionId)) return res.status(404).json({ error: "no such agent" });
    const s = findSkill(root(), String(req.body?.skill ?? ""));
    if (!s || !canSee(req, s)) return res.status(404).json({ error: "no such skill" });
    const release = req.body?.release === null ? null : Number(req.body?.release);
    if (release !== null && s.archived) return res.status(409).json({ error: "this skill is archived: unarchive it first" });
    const rest = (ch.skills ?? []).filter((a) => a.skill !== s.id);
    const group = deps.agentGroup(sessionId);
    if (release !== null) {
      const rel = s.releases.find((r) => r.n === release);
      if (!rel) return res.status(404).json({ error: `no release v${release}` });
      if (!acceptedAnywhere(s, rel))
        return res.status(409).json({ error: `v${rel.n} has not been accepted yet — review and accept it first` });
      // Accepted for ANOTHER group: this person may drive the target, so they
      // are a person of its group, and attaching is their acceptance — with
      // the secrets approved by name, like any acceptance.
      if (!acceptanceFor(s, rel, group)) {
        const approved = approval(rel, req.body?.approveSecrets, res);
        if (!approved) return;
        try {
          accept(root(), s.id, { group, release: rel.n, by: by(req), secrets: approved });
        } catch (e) {
          return fail(res, e);
        }
        deps.audit({ action: "accept", skill: s.name, release: rel.n, tree: rel.tree, group, secrets: approved, by: by(req) });
      }
      rest.push({ skill: s.id, release: rel.n });
    }
    deps.upsertChannel({ sessionId, skills: rest });
    deps.onAttachmentsChanged(sessionId);
    // `reload: true` — the person asked for it in the same click ("Run on a
    // schedule…" on an existing agent): reload now if idle, else mark stale.
    const reload = req.body?.reload === true ? deps.reloadIfIdle(sessionId) : undefined;
    deps.prune();
    deps.audit({ action: release === null ? "detach" : "attach", skill: s.name, release, agent: sessionId, by: by(req) });
    res.json({ ok: true, skills: rest, ...(reload ? { reload } : {}), note: "applies when the agent is reloaded" });
  });
}

/** Append-only audit, beside the store (names and ids only, never a value). */
export function factoryAudit(row: Record<string, unknown>): void {
  try {
    const file = path.join(factoryRoot(), "audit.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n", { mode: 0o600 });
  } catch (e) {
    console.error("factory audit:", (e as Error).message);
  }
}

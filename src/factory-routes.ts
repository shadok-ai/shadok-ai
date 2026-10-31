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
  vault(): Record<string, string>;
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
  groups(): { id: number; name?: string; icon?: string }[];
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
  const view = (s: FactorySkill, channels: Channel[], vaultNames: Set<string>, stats: ReturnType<typeof runStats>) => {
    const head = headCommit(root(), s.id);
    const manifest = parseManifest(readFile(root(), s.id, "shadok-skill.json")).manifest;
    const required = manifest.requires?.secrets ?? [];
    return {
      ...s,
      head,
      unreleased: unreleased(s, head),
      bindings: required.map((name) => ({ name, bound: vaultNames.has(name) })),
      latestAccepted: latestAccepted(s)?.n ?? null,
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
            update: (latestAccepted(s)?.n ?? 0) > release ? latestAccepted(s)!.n : null,
          };
        }),
      feedback: (s.feedback ?? []).slice().reverse(),
      tags: s.tags ?? [],
      runs7d: stats.bySkill[s.name] ?? 0,
      lastRun: stats.last[s.name] ?? null,
    };
  };
  const latestAccepted = (s: FactorySkill) =>
    [...s.releases].reverse().find((r) => s.acceptances.some((a) => a.group === MAIN_GROUP && a.release === r.n && a.tree === r.tree));

  const by = (req: Request): string => {
    const agent = deps.callerOf(req);
    if (agent.id) return `agent:${agent.profile ?? "no profile"}/${agent.id.slice(0, 8)} (${MAIN_GROUP})`;
    return deps.personName(req) ?? "cockpit";
  };

  const browser = (req: Request, res: Response): boolean => {
    if (deps.requestFromBrowser(req)) return true;
    res.status(403).json({ error: "same-origin browser only — a person does this, not an agent" });
    return false;
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
        ? groupsScope((scope as { groups: unknown[] }).groups.map(Number).filter(Number.isInteger))
        : String(scope);
    const err = scopeError(stored, deps.groups().map((g) => g.id));
    if (err) throw new FactoryError(err);
    return stored;
  };

  app.get("/factory/skills", (req, res) => {
    const channels = deps.loadChannels();
    const names = new Set(Object.keys(deps.vault()));
    res.json({
      group: MAIN_GROUP,
      me: deps.personName(req),
      groups: deps.groups().map((g) => ({ id: g.id, name: g.name ?? `group ${g.id}`, icon: g.icon ?? "" })),
      skills: (() => {
        const stats = runStats(root(), Date.now() - 7 * 86_400_000);
        return loadRegistry(root()).skills.filter((s) => canSee(req, s)).map((s) => view(s, channels, names, stats));
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
      const s = createSkill(root(), { name, title, description: req.body?.description, by: by(req), owner: ownerFrom(req, req.body?.scope) });
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
        if (s.createdBy !== me && !s.owner.startsWith(`user:${me}`) && !deps.requireAdmin(req, res, "change who a shared skill is shared with")) return;
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
    const s = skillOr404(req, res);
    if (!s) return;
    // Yours: you delete it. Shared (a group's, the organisation's): an admin.
    if (s.owner.startsWith("user:")) {
      if (!browser(req, res)) return;
    } else if (!deps.requireAdmin(req, res, "delete a shared factory skill")) return;
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
        secrets: secretsOf(deps.vault()),
      });
      deps.audit({ action: "save", skill: s.name, path: b.path, by: by(req) });
      res.json({ ok: true, ...out });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * "Work on it with an agent": make (or fast-forward) the clone the Skillsmith
   * will start in, and hand back its directory. Single-tenant: the agent runs as
   * the server's user, so the server can prepare it in the agent's HOME.
   */
  app.post("/factory/skills/:id/workspace", (req, res) => {
    if (!browser(req, res)) return;
    const s = skillOr404(req, res);
    if (!s) return;
    try {
      res.json({ cwd: prepareWorkspace(root(), s.id), profile: SKILLSMITH_PROFILE_NAME, name: s.name });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/factory/skills/:id/scan", (req, res) => {
    const s = skillOr404(req, res);
    if (!s) return;
    try {
      res.json(scanMain(root(), s.id, secretsOf(deps.vault())));
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
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "empty bundle" });
      try {
        const out = receivePush(root(), s.id, req.body, { by: by(req), secrets: secretsOf(deps.vault()) });
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
    try {
      const rel = cutRelease(root(), s.id, { by: by(req), note: req.body?.note, secrets: secretsOf(deps.vault()) });
      deps.audit({ action: "release", skill: s.name, release: rel.n, tree: rel.tree, by: by(req) });
      // "Release and accept" in one click: the releaser is a person of the group.
      if (req.body?.accept === true) {
        accept(root(), s.id, { group: MAIN_GROUP, release: rel.n, by: by(req) });
        deps.audit({ action: "accept", skill: s.name, release: rel.n, tree: rel.tree, group: MAIN_GROUP, by: by(req) });
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
    try {
      const a = accept(root(), s.id, { group: MAIN_GROUP, release: Number(req.body?.release), by: by(req) });
      deps.audit({ action: "accept", skill: s.name, release: a.release, tree: a.tree, group: a.group, by: by(req) });
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
    if (!s.acceptances.some((a) => a.group === MAIN_GROUP && a.release === rel.n && a.tree === rel.tree))
      return res.status(409).json({ error: `v${rel.n} has not been accepted yet` });
    const out: { name: string; result: string }[] = [];
    for (const c of deps.loadChannels()) {
      const cur = c.skills?.find((a) => a.skill === s.id);
      if (!cur || cur.release >= rel.n) continue;
      deps.upsertChannel({ sessionId: c.sessionId, skills: c.skills!.map((a) => (a.skill === s.id ? { ...a, release: rel.n } : a)) });
      deps.onAttachmentsChanged(c.sessionId);
      out.push({ name: c.name ?? c.sessionId.slice(0, 8), result: deps.reloadIfIdle(c.sessionId) });
    }
    deps.prune();
    deps.audit({ action: "update", skill: s.name, release: rel.n, agents: out.length, by: by(req) });
    res.json({ updated: out });
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
        name, release, description: req.body?.description, by: by(req),
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
        secrets: secretsOf(deps.vault()),
        owner: ownerFrom(req, req.body?.scope ?? "me"),
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
    if (!ch) return res.status(404).json({ error: "no such agent" });
    const s = findSkill(root(), String(req.body?.skill ?? ""));
    if (!s || !canSee(req, s)) return res.status(404).json({ error: "no such skill" });
    const release = req.body?.release === null ? null : Number(req.body?.release);
    if (release !== null && s.archived) return res.status(409).json({ error: "this skill is archived: unarchive it first" });
    const rest = (ch.skills ?? []).filter((a) => a.skill !== s.id);
    if (release !== null) {
      const rel = s.releases.find((r) => r.n === release);
      if (!rel) return res.status(404).json({ error: `no release v${release}` });
      if (!s.acceptances.some((a) => a.group === MAIN_GROUP && a.release === rel.n && a.tree === rel.tree))
        return res.status(409).json({ error: `v${rel.n} has not been accepted yet — review and accept it first` });
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

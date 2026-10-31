/**
 * HTTP surface of the Skill Factory (src/factory.ts). Mounted by server.ts with
 * the few server helpers it needs, so the hub does not grow another 300 lines.
 *
 * Who may do what (phase 2, single-tenant — the one group is `main`):
 * - READ (list, tree, file, log, diff, bundle, scan): anyone past the password
 *   gate, an agent included (by its session key).
 * - WRITE by a person: same-origin browser only (create, save a file, accept,
 *   attach). Releasing and deleting a `Main` skill are admin acts.
 * - PUSH by an agent: its session key, and its channel's profile must be the
 *   managed `Shadok-Skillsmith`. Not every agent of the group: on a
 *   single-tenant instance that would be every agent on the machine.
 * See docs/superpowers/specs/2026-10-29-skill-factory-design.md.
 */
import fs from "node:fs";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import type { Channel } from "./channels.js";
import {
  accept,
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
  const view = (s: FactorySkill, channels: Channel[], vaultNames: Set<string>) => {
    const head = headCommit(root(), s.id);
    const manifest = parseManifest(readFile(root(), s.id, "shadok-skill.json")).manifest;
    const required = manifest.requires?.secrets ?? [];
    return {
      ...s,
      head,
      unreleased: unreleased(s, head),
      bindings: required.map((name) => ({ name, bound: vaultNames.has(name) })),
      attachedTo: channels
        .filter((c) => c.skills?.some((a) => a.skill === s.id))
        .map((c) => ({
          sessionId: c.sessionId,
          name: c.name ?? c.sessionId.slice(0, 8),
          release: c.skills!.find((a) => a.skill === s.id)!.release,
        })),
    };
  };

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

  const skillOr404 = (req: Request, res: Response): FactorySkill | null => {
    const s = findSkill(root(), String(req.params.id));
    if (!s) res.status(404).json({ error: "no such skill" });
    return s ?? null;
  };

  app.get("/factory/skills", (_req, res) => {
    const channels = deps.loadChannels();
    const names = new Set(Object.keys(deps.vault()));
    res.json({
      group: MAIN_GROUP,
      skills: loadRegistry(root()).skills.map((s) => view(s, channels, names)),
      agents: channels.map((c) => ({ sessionId: c.sessionId, name: c.name ?? c.sessionId.slice(0, 8), skills: c.skills ?? [] })),
    });
  });

  app.post("/factory/skills", (req, res) => {
    if (!browser(req, res)) return;
    try {
      const s = createSkill(root(), { name: String(req.body?.name ?? ""), description: req.body?.description, by: by(req) });
      deps.audit({ action: "create", skill: s.name, by: by(req) });
      res.json({ skill: s });
    } catch (e) {
      fail(res, e);
    }
  });

  app.delete("/factory/skills/:id", (req, res) => {
    if (!deps.requireAdmin(req, res, "delete a factory skill")) return;
    const s = skillOr404(req, res);
    if (!s) return;
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
    // A `Main` skill is a house asset: publishing it is an admin act (spec [CALL]).
    if (!deps.requireAdmin(req, res, "release a skill")) return;
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
    if (!s) return res.status(404).json({ error: "no such skill" });
    const release = req.body?.release === null ? null : Number(req.body?.release);
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
    deps.audit({ action: release === null ? "detach" : "attach", skill: s.name, release, agent: sessionId, by: by(req) });
    res.json({ ok: true, skills: rest, note: "applies when the agent is reloaded" });
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

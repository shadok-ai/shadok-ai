import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import type { Channel } from "../src/channels.js";
import { mountFactory, type FactoryDeps } from "../src/factory-routes.js";
import { availableAttachments, loadRegistry, saveFile } from "../src/factory.js";

/**
 * The factory's HTTP gates against stub server helpers: who may act as a
 * person, on which agents, and what an acceptance grants. Two "tenants": the
 * browser (alice) may drive agents of `main` only; `hr-agent` is in `g-hr`.
 */
async function harness(t: test.TestContext, opts: { actFor?: string[] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-routes-"));
  const prev = process.env.SHADOK_FACTORY_DIR;
  process.env.SHADOK_FACTORY_DIR = dir;
  const channels: Channel[] = [
    { sessionId: "main-agent-0000", name: "mine", group: null } as unknown as Channel,
    { sessionId: "hr-agent-000000", name: "theirs", group: "g-hr" } as unknown as Channel,
    { sessionId: "smith-agent-000", name: "smith", group: "g-hr", profile: "Shadok-Skillsmith" } as unknown as Channel,
  ];
  const keys: Record<string, string> = { "key-smith": "smith-agent-000" };
  const deps: FactoryDeps = {
    requestFromBrowser: (req) => req.headers.origin === "http://cockpit",
    personName: () => "alice",
    requireAdmin: () => ({}),
    callerOf: (req) => {
      const id = keys[String(req.headers["x-shadok-session-key"] ?? "")] ?? null;
      return { id, profile: id ? channels.find((c) => c.sessionId === id)?.profile ?? null : null };
    },
    vault: () => ({ HR_DB_PASSWORD: "hr-very-secret-value" }),
    mayDrive: (_req, id) => (channels.find((c) => c.sessionId === id)?.group ?? null) === null,
    agentGroup: (id) => channels.find((c) => c.sessionId === id)?.group ?? "main",
    personGroup: () => "main",
    mayActForGroup: (_req, g) => (opts.actFor ?? ["main"]).includes(g),
    tenantGroup: (g) => g ?? "main",
    loadChannels: () => channels,
    skillsOf: (id) => {
      const c = channels.find((x) => x.sessionId === id);
      return availableAttachments(loadRegistry(dir).skills, { group: c?.group ?? null, createdBy: c?.createdBy ?? null }, c?.group ?? "main");
    },
    runningSkills: () => ({}),
    onSkillsChanged: () => {},
    prune: () => {},
    reloadIfIdle: () => "offline",
    agentMcp: () => [],
    groups: () => [{ id: "main" }, { id: "g-hr" }],
    workspaceFor: () => ({ home: dir, user: null, group: null }),
    audit: () => {},
  };
  const app = express();
  app.use(express.json());
  mountFactory(app, deps);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => {
    server.close();
    if (prev === undefined) delete process.env.SHADOK_FACTORY_DIR;
    else process.env.SHADOK_FACTORY_DIR = prev;
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  });
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + url, {
      method,
      headers: { origin: "http://cockpit", ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  return { dir, call, channels: () => channels };
}

test("routes: a person's action carrying an agent key or a peer token is refused, Origin or not", async (t) => {
  const h = await harness(t);
  const made = await h.call("POST", "/factory/skills", { title: "Payroll export" });
  assert.equal(made.status, 200);
  const id = made.body.skill.id;
  for (const headers of [{ "x-shadok-session-key": "key-smith" }, { "x-shadok-session-key": "garbage" }, { "x-shadok-peer": "tok" }]) {
    assert.equal((await h.call("POST", `/factory/skills/${id}/publish`, {}, headers)).status, 403);
    assert.equal((await h.call("DELETE", `/factory/skills/${id}`, undefined, headers)).status, 403);
    assert.equal((await h.call("PUT", `/factory/skills/${id}/file`, { path: "a.md", content: "x" }, headers)).status, 403);
  }
  // The `key` body field is a credential too.
  assert.equal((await h.call("POST", `/factory/skills/${id}/publish`, { key: "key-smith" })).status, 403);
});

test("routes: publishing a release that asks for secrets needs them approved BY NAME", async (t) => {
  const h = await harness(t);
  const id = (await h.call("POST", "/factory/skills", { title: "HR report" })).body.skill.id;
  saveFile(h.dir, id, {
    path: "shadok-skill.json",
    content: JSON.stringify({ name: "hr-report", requires: { secrets: ["HR_DB_PASSWORD"] } }),
    base: null, by: "x", secrets: [],
  });
  const first = await h.call("POST", `/factory/skills/${id}/publish`, {});
  assert.equal(first.status, 409);
  assert.deepEqual(first.body.needsApproval, ["HR_DB_PASSWORD"]);
  assert.equal(loadRegistry(h.dir).skills[0].acceptances.length, 0);
  const ok = await h.call("POST", `/factory/skills/${id}/publish`, { approveSecrets: ["HR_DB_PASSWORD", "EXTRA"] });
  assert.equal(ok.status, 200);
  assert.deepEqual(loadRegistry(h.dir).skills[0].acceptances[0].secrets, ["HR_DB_PASSWORD"]);
});

test("routes: Save accepts for every group the person may act for, so a skill shared with everyone runs outside Main too", async (t) => {
  const h = await harness(t, { actFor: ["main", "g-hr"] });
  const id = (await h.call("POST", "/factory/skills", { title: "Notes" })).body.skill.id;
  assert.equal((await h.call("POST", `/factory/skills/${id}/publish`, {})).status, 200);
  const skill = loadRegistry(h.dir).skills.find((s) => s.id === id)!;
  assert.deepEqual(skill.acceptances.map((a) => a.group).sort(), ["g-hr", "main"]);
  // The g-hr agent (not drivable by this person, so absent from the list) now runs it.
  const hr = h.channels().find((c) => c.sessionId === "hr-agent-000000")!;
  assert.deepEqual(availableAttachments(loadRegistry(h.dir).skills, { group: hr.group }, "g-hr"), [{ skill: id, release: 1 }]);
  // A second Save with nothing changed reuses v1 and accepts nothing twice.
  assert.equal((await h.call("POST", `/factory/skills/${id}/publish`, {})).status, 200);
  assert.equal(loadRegistry(h.dir).skills.find((s) => s.id === id)!.acceptances.length, 2);
});

test("routes: a skill is not given to an agent — once saved, the agents it is shared with have it", async (t) => {
  const h = await harness(t);
  const id = (await h.call("POST", "/factory/skills", { title: "Notes" })).body.skill.id;
  // Not saved yet: nobody has it.
  assert.deepEqual((await h.call("GET", "/factory/skills")).body.skills[0].attachedTo, []);
  assert.equal((await h.call("POST", `/factory/skills/${id}/publish`, {})).status, 200);
  const list = await h.call("GET", "/factory/skills");
  // Shared with everyone, accepted for main: the main agent has it. The g-hr
  // agents are neither drivable by this person nor accepted for g-hr.
  assert.deepEqual(list.body.skills[0].attachedTo.map((a: { sessionId: string }) => a.sessionId), ["main-agent-0000"]);
  assert.deepEqual(list.body.agents.map((a: { sessionId: string }) => a.sessionId), ["main-agent-0000"]);
  assert.deepEqual(list.body.agents[0].skills, [{ skill: id, release: 1 }]);
  // There is no per-agent attach any more.
  assert.equal((await h.call("POST", "/factory/attach", { sessionId: "main-agent-0000", skill: id, release: 1 })).status, 404);
  // Archived: nobody has it.
  assert.equal((await h.call("PUT", `/factory/skills/${id}/meta`, { archived: true })).status, 200);
  assert.deepEqual((await h.call("GET", "/factory/skills")).body.skills[0].attachedTo, []);
});

test("routes: a Skillsmith of a group that is not an editor cannot push", async (t) => {
  const h = await harness(t);
  const id = (await h.call("POST", "/factory/skills", { title: "Main only" })).body.skill.id;
  const push = await h.call("POST", `/factory/skills/${id}/push`, undefined, { "x-shadok-session-key": "key-smith", "content-type": "application/octet-stream" });
  assert.equal(push.status, 403);
  assert.match(push.body.error, /not editable by agents of g-hr/);
});

#!/usr/bin/env node
// The agent's side of the Skill Factory: a clone of a factory skill, kept in
// step with the server, which is the git origin.
//
//   factory.mjs list                 the factory's skills
//   factory.mjs pull <skill>         clone, or fast-forward the clone, to the server's main
//   factory.mjs status <skill>       what you have not pushed yet
//   factory.mjs scan <skill>         what a release would say right now (server-side)
//   factory.mjs push <skill>         send your new commits (fast-forward only)
//
// The clone lives in ~/.shadok-factory/<skill>. Commit there with plain git;
// this script only moves bundles. A push is refused when someone else pushed
// first ("pull and replay"), or when the scan finds a vault value — in which
// case nothing reached the shared history.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const die = (m) => {
  console.error(m);
  process.exit(1);
};
const [cmd, name] = process.argv.slice(2);
const usage = "usage: factory.mjs list | pull <skill> | status <skill> | scan <skill> | push <skill>";
if (!cmd || cmd === "--help" || cmd === "-h") die(usage);

const port = process.env.SHADOK_PORT;
const key = process.env.SHADOK_SESSION_KEY;
if (!port) die("Not inside a shadok-ai agent (SHADOK_PORT unset).");
if (!key) die("SHADOK_SESSION_KEY is unset — ask the human to reload this agent.");
const base = `http://127.0.0.1:${port}`;
const headers = { "x-shadok-session-key": key };

const home = path.join(os.homedir(), ".shadok-factory");
const cloneOf = (n) => path.join(home, n);
const git = (cwd, args, opts = {}) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();

async function call(method, p, body) {
  let res;
  try {
    res = await fetch(base + p, {
      method,
      headers: body && !(body instanceof Uint8Array) ? { ...headers, "content-type": "application/json" } : headers,
      body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    die(`cannot reach the shadok server on port ${port}: ${e.message}`);
  }
  if (res.status === 401)
    die("401 — this agent's credential is not accepted. Ask the human to reload this agent.");
  return res;
}

async function json(method, p, body) {
  const res = await call(method, p, body);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`refused (${res.status}): ${out.error ?? "unknown error"}`);
    if (out.scan) printScan(out.scan);
    process.exit(1);
  }
  return out;
}

function printScan(scan) {
  for (const r of scan.refusals ?? [])
    console.error(`  ✗ ${r.path || "(skill)"}${r.line ? ":" + r.line : ""} — ${r.message}`);
  for (const w of scan.warnings ?? [])
    console.error(`  ! ${w.path || "(skill)"}${w.line ? ":" + w.line : ""} — ${w.message}`);
}

async function idOf(n) {
  if (!n) die(usage);
  const { skills } = await json("GET", "/factory/skills");
  const s = skills.find((x) => x.name === n || x.id === n);
  if (!s) die(`no factory skill "${n}". Known: ${skills.map((x) => x.name).join(", ") || "(none)"}`);
  return s;
}

async function pull(n) {
  const s = await idOf(n);
  const res = await call("GET", `/factory/skills/${s.id}/bundle`);
  if (!res.ok) die(`could not fetch the bundle (${res.status})`);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(os.tmpdir(), `factory-${s.name}-${process.pid}.bundle`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  try {
    const dir = cloneOf(s.name);
    if (!fs.existsSync(path.join(dir, ".git"))) {
      git(home, ["clone", "-q", "-b", "main", file, dir]);
      console.log(`cloned ${s.name} into ${dir}`);
      return;
    }
    git(dir, ["fetch", "-q", file, "main:refs/remotes/origin/main"]);
    const ahead = git(dir, ["rev-list", "--count", "origin/main..HEAD"]);
    if (ahead !== "0") {
      // Your own commits on top of an older main: replay them on the new one.
      try {
        git(dir, ["rebase", "-q", "origin/main"]);
        console.log(`pulled; your ${ahead} commit(s) replayed on top. Push again.`);
      } catch {
        git(dir, ["rebase", "--abort"]);
        die("your commits conflict with what was pushed meanwhile. Resolve by hand in the clone (git rebase origin/main), then push.");
      }
    } else {
      git(dir, ["merge", "-q", "--ff-only", "origin/main"]);
      console.log(`up to date with the factory (${git(dir, ["rev-parse", "--short", "HEAD"])})`);
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function push(n) {
  const s = await idOf(n);
  const dir = cloneOf(s.name);
  if (!fs.existsSync(path.join(dir, ".git"))) die(`no clone yet — run: factory.mjs pull ${s.name}`);
  if (git(dir, ["status", "--porcelain"])) die("you have uncommitted changes — commit them first (git add -A && git commit -m …).");
  const ahead = git(dir, ["rev-list", "--count", "origin/main..HEAD"]);
  if (ahead === "0") die("nothing to push.");
  const file = path.join(os.tmpdir(), `factory-push-${s.name}-${process.pid}.bundle`);
  try {
    // The server reads `main` from the bundle, so the range must name it.
    if (git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") die("commit on the main branch of the clone.");
    git(dir, ["bundle", "create", "-q", file, "origin/main..main"]);
    const out = await json("POST", `/factory/skills/${s.id}/push`, new Uint8Array(fs.readFileSync(file)));
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    console.log(`pushed ${out.commits} commit(s). A person releases it from the Skills panel.`);
    if (out.warnings?.length) printScan({ warnings: out.warnings });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

if (cmd === "list") {
  const { skills } = await json("GET", "/factory/skills");
  if (!skills.length) console.log("(no factory skills yet)");
  for (const s of skills) {
    const last = s.releases.at(-1);
    console.log(`${s.name} — ${last ? "v" + last.n : "unreleased"}${s.unreleased ? " (+ unreleased changes)" : ""} — ${s.description}`);
  }
} else if (cmd === "pull") await pull(name);
else if (cmd === "push") await push(name);
else if (cmd === "status") {
  const dir = cloneOf((await idOf(name)).name);
  if (!fs.existsSync(path.join(dir, ".git"))) die(`no clone yet — run: factory.mjs pull ${name}`);
  console.log(git(dir, ["status", "--short", "--branch"]));
  console.log(git(dir, ["log", "--oneline", "origin/main..HEAD"]) || "(no commits to push)");
} else if (cmd === "scan") {
  const s = await idOf(name);
  const out = await json("POST", `/factory/skills/${s.id}/scan`);
  if (!out.refusals.length && !out.warnings.length) console.log("clean — nothing to refuse, nothing to warn about.");
  printScan(out);
  if (out.refusals.length) process.exit(1);
} else die(usage);

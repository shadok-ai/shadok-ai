#!/usr/bin/env node
// git + gh on a GitHub account the person connected in the cockpit.
//
// No token is ever stored here or in the agent's environment: GitHub user
// tokens last 8 hours and the cockpit renews them, so every use asks the
// server for the CURRENT one (`POST /github/token`, authenticated by the
// agent's session key). git reaches this script as its credential helper —
// the spawn sets `credential.https://github.com.helper` to
// `node <this file> credential` — and `gh` is run through `github.mjs gh`,
// which hands it the token for that one invocation only.
import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const USAGE = `usage: github.mjs <command>
  accounts
  clone    <owner/repo | https URL> [dir] [--account <id>]
  identity [--account <id>]                     (in a repository: commit as the account, use it for this repo)
  gh       [--account <id>] <gh arguments…>     (e.g. github.mjs gh pr create --fill)
  token    [--account <id>] [--owner <owner>]   (prints the token for a script — never echo or log it)
  credential get                                (git's credential helper; git calls it, not you)`;

const die = (m) => {
  console.error(m);
  process.exit(1);
};

function connection() {
  const port = process.env.SHADOK_PORT;
  const key = process.env.SHADOK_SESSION_KEY;
  if (!port) return { error: "Not inside a shadok-ai agent (SHADOK_PORT unset)." };
  if (!key) return { error: "SHADOK_SESSION_KEY is unset — ask the human to reload this agent." };
  return { port, key };
}

/** One request to the cockpit → `{ok, status, body}`; never throws. */
async function call(method, route, payload, timeoutMs = 30_000) {
  const c = connection();
  if (c.error) return { ok: false, status: 0, body: { error: c.error } };
  try {
    const res = await fetch(`http://127.0.0.1:${c.port}${route}`, {
      method,
      headers: { "content-type": "application/json", "x-shadok-session-key": c.key },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: `The cockpit did not answer (${e?.message ?? e}). It may be restarting — say so rather than working around it.` } };
  }
}

/** What a refusal says, with the accounts it lists when it lists some. */
function refusal(r) {
  const lines = [r.body?.error ?? `Refused (${r.status}): no reason given`];
  for (const a of Array.isArray(r.body?.accounts) ? r.body.accounts : []) {
    lines.push(`  ${a.id}  ${a.login}${a.owners?.length ? `  repos of: ${a.owners.join(", ")}` : ""}`);
  }
  return lines.join("\n");
}

function gitConfig(key) {
  try {
    return execFileSync("git", ["config", "--get", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** The account named on purpose: --account, then SHADOK_GITHUB_ACCOUNT, then
 *  `git config shadok.githubAccount` (this repository, global, or `git -c`). */
function explicitAccount(flag) {
  return flag || (process.env.SHADOK_GITHUB_ACCOUNT ?? "").trim() || gitConfig("shadok.githubAccount") || undefined;
}

/** `owner` out of `owner/repo`, `owner/repo.git`, or a github.com URL. */
export function ownerOf(hint) {
  if (typeof hint !== "string") return null;
  let s = hint.trim();
  const url = /^(?:https?:\/\/(?:[^@/]+@)?|git@)github\.com[/:](.+)$/i.exec(s);
  if (url) s = url[1];
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})(?:\/|$)/.exec(s);
  return m ? m[1] : null;
}

/** git's credential protocol: `key=value` lines up to a blank line. */
export function parseCredentialInput(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) break;
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** What the helper answers git. A GitHub App user token authenticates as any
 *  username; `x-access-token` is the documented one. */
export function credentialOutput(token, expiresAtMs) {
  const lines = ["username=x-access-token", `password=${token}`];
  if (typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs) && expiresAtMs < Number.MAX_SAFE_INTEGER) {
    lines.push(`password_expiry_utc=${Math.floor(expiresAtMs / 1000)}`);
  }
  return lines.join("\n") + "\n";
}

function parseFlags(argv, known) {
  const o = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(2, eq) : a.startsWith("--") ? a.slice(2) : null;
    if (name && known.includes(name)) {
      o[name] = eq > 0 ? a.slice(eq + 1) : argv[++i];
      continue;
    }
    o.rest.push(a);
  }
  return o;
}

async function token(account, owner, timeoutMs) {
  return call("POST", "/github/token", { ...(account ? { account } : {}), ...(owner ? { owner } : {}) }, timeoutMs);
}

const day = (ms) => (typeof ms === "number" ? new Date(ms).toISOString().slice(0, 10) : "none");

async function accounts() {
  const r = await call("GET", "/social/accounts");
  if (!r.ok) die(refusal(r));
  const mine = (r.body.accounts ?? []).filter((a) => a.provider === "github");
  if (!mine.length) {
    console.log("No GitHub account is shared with this agent. Ask the person to connect one in Secrets → Connected accounts, or to share theirs with this agent's group.");
    return;
  }
  for (const a of mine) {
    const owners = (a.owners ?? []).map((o) => `${o.owner}(${o.selection === "all" ? "all" : o.repos ?? "?"})`);
    console.log(
      [
        a.id,
        a.login,
        `repos=${owners.length ? owners.join(",") : "NONE — the person must choose repositories (Secrets → Connected accounts)"}`,
        `email=${a.email}`,
        a.status === "expired" ? "EXPIRED — the person must reconnect it" : `reconnect-by=${day(a.expiresAt)}`,
      ].join("  "),
    );
  }
}

/** git's helper: answer `get` for https://github.com, stay silent otherwise.
 *  Never exits non-zero and never prompts: git falls through to its next
 *  helper (or its own refusal) when this one says nothing. */
async function credential(action) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  if (action !== "get") return;
  const req = parseCredentialInput(Buffer.concat(chunks).toString("utf8"));
  if (req.protocol !== "https" || (req.host ?? "").toLowerCase() !== "github.com") return;
  if (connection().error) return;
  const r = await token(explicitAccount(), ownerOf(req.path ?? ""), 15_000);
  if (!r.ok) {
    process.stderr.write(`shadok-github: ${refusal(r)}\n`);
    return;
  }
  process.stdout.write(credentialOutput(r.body.token, r.body.expiresAt));
}

function setIdentity(dir, t) {
  const g = (k, v) => execFileSync("git", ["-C", dir, "config", k, v], { stdio: "ignore" });
  g("shadok.githubAccount", t.account);
  g("user.name", t.login);
  if (t.email) g("user.email", t.email);
}

async function clone(argv) {
  const o = parseFlags(argv, ["account"]);
  const [target, dir] = o.rest;
  if (!target) die("clone needs <owner/repo> or an https://github.com/… URL.");
  const owner = ownerOf(target);
  if (!owner) die(`'${target}' is not a GitHub repository (owner/repo or https://github.com/owner/repo).`);
  const path = /^https?:\/\//i.test(target) ? target.replace(/^https?:\/\/(?:[^@/]+@)?github\.com\//i, "") : target;
  const url = `https://github.com/${path.replace(/\.git$/, "")}.git`;
  const r = await token(explicitAccount(o.account), owner);
  if (!r.ok) die(refusal(r));
  const dest = dir || path.replace(/\.git$/, "").split("/").pop();
  // The account picked rides along with `-c` so the helper uses it for the
  // clone, then is written into the repository for every later fetch / push.
  const child = spawn("git", ["-c", `shadok.githubAccount=${r.body.account}`, "clone", "--", url, dest], { stdio: "inherit" });
  const code = await new Promise((res) => child.on("close", res));
  if (code !== 0) process.exit(code ?? 1);
  setIdentity(dest, r.body);
  console.log(`Cloned as ${r.body.login}; commits in ${dest} are authored by ${r.body.login} <${r.body.email}>.`);
}

async function identity(argv) {
  const o = parseFlags(argv, ["account"]);
  const top = gitConfig("remote.origin.url");
  const r = await token(explicitAccount(o.account), ownerOf(top ?? ""));
  if (!r.ok) die(refusal(r));
  setIdentity(".", r.body);
  console.log(`This repository now pushes with ${r.body.login} and commits as ${r.body.login} <${r.body.email}>.`);
}

/** The repository `gh` will act on, as an owner hint: -R/--repo, else origin. */
function ghOwner(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-R" || args[i] === "--repo") return ownerOf(args[i + 1] ?? "");
    if (args[i].startsWith("--repo=")) return ownerOf(args[i].slice(7));
  }
  return ownerOf(gitConfig("remote.origin.url") ?? "");
}

async function gh(argv) {
  let account;
  let args = argv;
  if (args[0] === "--account") {
    account = args[1];
    args = args.slice(2);
  } else if (args[0]?.startsWith("--account=")) {
    account = args[0].slice(10);
    args = args.slice(1);
  }
  if (args[0] === "--") args = args.slice(1);
  if (!args.length) die("gh needs arguments, e.g. github.mjs gh pr list");
  const r = await token(explicitAccount(account), ghOwner(args));
  if (!r.ok) die(refusal(r));
  // For this one invocation only: nothing is written to gh's config.
  const child = spawn("gh", args, { stdio: "inherit", env: { ...process.env, GH_TOKEN: r.body.token } });
  child.on("error", (e) => die(e.code === "ENOENT" ? "gh is not installed here — use git, or the GitHub REST API with `github.mjs token`." : String(e)));
  child.on("close", (code) => process.exit(code ?? 1));
}

// Run only as a script (the test imports the pure helpers above). Compared
// through realpath: in a group HOME `~/.claude/skills/shadok-github` is a
// SYMLINK to the machine-wide copy, so argv[1] and import.meta.url differ.
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const invoked = !!process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url));
if (invoked) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "accounts") await accounts();
  else if (cmd === "credential") await credential(rest[0]);
  else if (cmd === "clone") await clone(rest);
  else if (cmd === "identity") await identity(rest);
  else if (cmd === "gh") await gh(rest);
  else if (cmd === "token") {
    const o = parseFlags(rest, ["account", "owner"]);
    const r = await token(explicitAccount(o.account), ownerOf(o.owner ?? ""));
    if (!r.ok) die(refusal(r));
    process.stdout.write(r.body.token + "\n");
  } else die(USAGE);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { credentialOutput, ownerOf, parseCredentialInput } from "../scripts/github.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "github.mjs");
const FAKE = "ghu_FAKE_TEST_VALUE";

async function stub(status, body) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, key: req.headers["x-shadok-session-key"], body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

/** A clean env: no inherited git config, no account override. */
function envFor(port, extra = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...extra };
  if (port) Object.assign(env, { SHADOK_PORT: String(port), SHADOK_SESSION_KEY: "k-test" });
  return env;
}

function run(cmd, args, env, stdin = "") {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { env, timeout: 20_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
    );
    child.stdin.end(stdin);
  });
}

test("parseCredentialInput reads key=value lines up to the blank line", () => {
  assert.deepEqual(parseCredentialInput("protocol=https\nhost=github.com\npath=acme/app.git\n\nignored=1\n"), {
    protocol: "https",
    host: "github.com",
    path: "acme/app.git",
  });
});

test("credentialOutput: x-access-token, the password, and its expiry in seconds", () => {
  assert.equal(credentialOutput("t", 1_700_000_000_999), "username=x-access-token\npassword=t\npassword_expiry_utc=1700000000\n");
  // A lasting token (non-expiring app) carries no expiry line.
  assert.equal(credentialOutput("t", Number.MAX_SAFE_INTEGER), "username=x-access-token\npassword=t\n");
});

test("ownerOf reads owner/repo, .git, and github URLs", () => {
  assert.equal(ownerOf("acme/app"), "acme");
  assert.equal(ownerOf("acme/app.git"), "acme");
  assert.equal(ownerOf("https://github.com/acme/app.git"), "acme");
  assert.equal(ownerOf("https://x-access-token@github.com/acme/app"), "acme");
  assert.equal(ownerOf("git@github.com:acme/app.git"), "acme");
  assert.equal(ownerOf(""), null);
  assert.equal(ownerOf("../etc"), null);
});

test("credential get answers github.com with the server's current token", async () => {
  const s = await stub(200, { account: "a1", login: "octo", email: "1+octo@users.noreply.github.com", token: FAKE, expiresAt: 1_700_000_000_000 });
  try {
    const r = await run("node", [SCRIPT, "credential", "get"], envFor(s.port), "protocol=https\nhost=github.com\npath=acme/app.git\n\n");
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `username=x-access-token\npassword=${FAKE}\npassword_expiry_utc=1700000000\n`);
    assert.equal(s.seen.length, 1);
    assert.equal(s.seen[0].url, "/github/token");
    assert.equal(s.seen[0].key, "k-test");
    // The owner from git's path is the hint for the account pick.
    assert.deepEqual(s.seen[0].body, { owner: "acme" });
  } finally {
    await s.close();
  }
});

test("credential stays silent for another host, for store/erase, and outside an agent", async () => {
  const s = await stub(200, { token: FAKE });
  try {
    const other = await run("node", [SCRIPT, "credential", "get"], envFor(s.port), "protocol=https\nhost=gitlab.com\n\n");
    assert.equal(other.stdout, "");
    const store = await run("node", [SCRIPT, "credential", "store"], envFor(s.port), "protocol=https\nhost=github.com\nusername=x\npassword=y\n\n");
    assert.equal(store.stdout, "");
    const plain = await run("node", [SCRIPT, "credential", "get"], envFor(null), "protocol=https\nhost=github.com\n\n");
    assert.equal(plain.code, 0);
    assert.equal(plain.stdout, "");
    assert.equal(s.seen.length, 0);
  } finally {
    await s.close();
  }
});

test("credential refusal: nothing on stdout, the reason (and the accounts) on stderr, exit 0", async () => {
  const s = await stub(409, { error: "Several GitHub accounts are shared with this agent — pick one.", accounts: [{ id: "a1", login: "octo", owners: ["acme"] }] });
  try {
    const r = await run("node", [SCRIPT, "credential", "get"], envFor(s.port), "protocol=https\nhost=github.com\n\n");
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /shadok-github: Several GitHub accounts/);
    assert.match(r.stderr, /a1 {2}octo {2}repos of: acme/);
  } finally {
    await s.close();
  }
});

test("an explicit account comes from SHADOK_GITHUB_ACCOUNT", async () => {
  const s = await stub(200, { account: "b2", login: "x", email: "", token: FAKE, expiresAt: 1 });
  try {
    await run("node", [SCRIPT, "credential", "get"], envFor(s.port, { SHADOK_GITHUB_ACCOUNT: "b2" }), "protocol=https\nhost=github.com\n\n");
    assert.deepEqual(s.seen[0].body, { account: "b2" });
  } finally {
    await s.close();
  }
});

test("git itself gets the credential through the helper the spawn configures", async () => {
  // A FUTURE expiry, and it is load-bearing: `credentialOutput` reports it as
  // `password_expiry_utc`, and git's `fill` SKIPS a credential whose expiry has
  // passed — it keeps the username, finds no password, and (prompts disabled)
  // dies with "could not read Password". A fixed past instant therefore made
  // this test assert the opposite of what it checks, on any git that honours
  // the attribute. Production always sends a real deadline (~8 h out).
  const s = await stub(200, { account: "a1", login: "octo", email: "", token: FAKE, expiresAt: Date.now() + 8 * 3_600_000 });
  try {
    // The exact env shape `githubGitEnv` (src/github.ts) gives every agent.
    const env = envFor(s.port, {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "shadok.githubAccount",
      GIT_CONFIG_VALUE_0: "a1",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_1: `!node '${SCRIPT}' credential`,
      GIT_TERMINAL_PROMPT: "0",
    });
    const r = await run("git", ["credential", "fill"], env, "protocol=https\nhost=github.com\n\n");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^username=x-access-token$/m);
    assert.match(r.stdout, new RegExp(`^password=${FAKE}$`, "m"));
    // `git config shadok.githubAccount` (here from GIT_CONFIG_*) names the account.
    assert.deepEqual(s.seen[0].body, { account: "a1" });
  } finally {
    await s.close();
  }
});

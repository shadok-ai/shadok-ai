# Agent-written secrets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent put a credential it obtained itself into the vault, without the value ever touching the transcript or `argv`, and without being able to silently overwrite an existing secret.

**Architecture:** `PUT /secrets` gains a no-silent-overwrite guard driven by one pure function; a new `shadok-secrets` skill (versioned in the repo, seeded at boot like `shadok-scheduler`) gives the agent a stdin-only path to that endpoint. No new subsystem — the vault, the endpoint and the auth cookie already exist.

**Tech Stack:** TypeScript (ESM, NodeNext, Node 20), Express, `node:test` + `tsx`, Python 3 for the skill script (same as the scheduler skill), vanilla JS in `public/index.html`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-09-agent-secrets-design.md`.
- Everything written into the repo is **English** — comments, identifiers, commit messages, log and error strings. Comments explain **why**.
- Imports use `.js` extensions (NodeNext).
- **No `get`**: the script never reads a value back, and no endpoint ever returns one. `GET /secrets` returns names only — keep it that way.
- **The value never appears in `argv`.** `secret.py set` takes `--stdin` as a *required* flag so there is structurally no way to pass a value as an argument.
- Telegram is **not** touched: `/secret` calls `setSecret()` directly, never the endpoint.
- Run tests with `npm test`; build with `npm run build`.
- Verify runtime changes in a browser on a **side-by-side instance on a free port** — never take over 3789 (invariant 8): `PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js`.

---

### Task 1: The guard — no silent overwrite

**Files:**
- Modify: `src/secrets.ts` (append to the pure-core section)
- Modify: `src/server.ts` (the `PUT /secrets` handler, ~line 844; the import on line 89)
- Modify: `public/index.html` (both `PUT /secrets` call sites, ~lines 4324 and 4362)
- Test: `test/profiles.test.ts` (where `normalizeVault` / `secretsFor` already live)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `secretWriteVerdict(exists: boolean, overwrite: boolean): "created" | "updated" | "refused"`, and `PUT /secrets` answering `409 { error: "exists", name }` on a refused write, `200 { names: string[], result: "created" | "updated" }` otherwise.

- [ ] **Step 1: Write the failing test**

Append to `test/profiles.test.ts`, and add `secretWriteVerdict` to the existing `../src/secrets.js` import:

```ts
test("secretWriteVerdict: a fresh name is always created", () => {
  assert.equal(secretWriteVerdict(false, false), "created");
  assert.equal(secretWriteVerdict(false, true), "created");
});

test("secretWriteVerdict: an existing name needs an explicit overwrite", () => {
  // The one destructive move: replacing a real credential with something else,
  // with nothing on screen to show it happened. A machine must not do it alone.
  assert.equal(secretWriteVerdict(true, false), "refused");
  assert.equal(secretWriteVerdict(true, true), "updated");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/profiles.test.ts 2>&1 | tail -20`
Expected: FAIL — `secretWriteVerdict` is not exported.

- [ ] **Step 3: Write the pure core**

Append to the "Pure core (unit-tested)" section of `src/secrets.ts`, after `normalizeVault`:

```ts
export type SecretWrite = "created" | "updated" | "refused";

/**
 * Pure: what a write to `name` should do. Overwriting is the only destructive
 * move the vault allows — it replaces a live credential and leaves no trace,
 * and the vault keeps no history to undo it. So it takes an explicit intent,
 * which the human surfaces carry and a machine does not.
 */
export function secretWriteVerdict(exists: boolean, overwrite: boolean): SecretWrite {
  if (!exists) return "created";
  return overwrite ? "updated" : "refused";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/profiles.test.ts 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 5: Guard the endpoint**

In `src/server.ts`, add `secretWriteVerdict` to the import on line 89:

```ts
import { secretsFor, secretNames, setSecret, deleteSecret, secretWriteVerdict } from "./secrets.js";
```

Replace the `PUT /secrets` handler:

```ts
app.put("/secrets", (req, res) => {
  const { name, value, overwrite } = req.body ?? {};
  if (typeof name !== "string" || !name.trim() || typeof value !== "string")
    return res.status(400).json({ error: "name and value required" });
  const key = name.trim();
  // HTTP is the ONLY way an agent can reach the vault — it is a separate
  // process, and Telegram's /secret calls setSecret() directly. So guarding
  // here guards exactly the machine path, and nothing a human does by hand.
  const verdict = secretWriteVerdict(secretNames().includes(key), overwrite === true);
  if (verdict === "refused") return res.status(409).json({ error: "exists", name: key });
  setSecret(key, value);
  res.json({ names: secretNames(), result: verdict });
});
```

- [ ] **Step 6: Let the Secrets panel keep overwriting**

In `public/index.html`, both `PUT /secrets` call sites (~4324 and ~4362) currently send `{ name, value }`. Add the flag to each:

```js
      body: JSON.stringify({ name, value, overwrite: true }),
```

Add this comment above the first of the two:

```js
    // `overwrite` because a person looking at the vault list and clicking Save
    // is acting deliberately. The flag exists to stop an AGENT from silently
    // replacing a credential — not to slow the human down.
```

- [ ] **Step 7: Build and run the whole suite**

Run: `npm run build && npm test 2>&1 | tail -8`
Expected: build clean, 0 failures.

- [ ] **Step 8: Verify the endpoint by hand**

Start a side-by-side instance (never 3789):

```bash
PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js
```

Confirm prod is untouched and the startup output has no `telegram:` line:

```bash
curl -s -o /dev/null -w 'prod %{http_code}\n' localhost:3789/
curl -s localhost:3899/version
```

Then, using a throwaway name so no real credential is involved:

```bash
curl -s -X PUT localhost:3899/secrets -H 'content-type: application/json' \
  -d '{"name":"PLAN_TMP","value":"one"}'                       # {"names":[...],"result":"created"}
curl -s -X PUT localhost:3899/secrets -H 'content-type: application/json' \
  -d '{"name":"PLAN_TMP","value":"two"}'                       # {"error":"exists","name":"PLAN_TMP"}
curl -s -X PUT localhost:3899/secrets -H 'content-type: application/json' \
  -d '{"name":"PLAN_TMP","value":"two","overwrite":true}'      # {"names":[...],"result":"updated"}
curl -s -X DELETE 'localhost:3899/secrets?name=PLAN_TMP'       # clean up
```

- [ ] **Step 9: Verify the Secrets panel still saves over an existing name**

Open http://localhost:3899 (never 3789), open the Secrets panel, add a secret named `PLAN_TMP2`, then save a different value under the same name. It must succeed — that is the path Step 6 protects. Delete it afterwards.

No interactive browser? Borrow Playwright from `~/projects/aibrowser` by absolute path (do not install it into the worktree), drive the panel, and read the screenshot back. Capture the console: a CSP violation or a failed import is silent in the DOM.

Stop your instance when done; nothing to restore.

- [ ] **Step 10: Commit**

```bash
git add src/secrets.ts src/server.ts public/index.html test/profiles.test.ts
git commit -m "feat: PUT /secrets refuses to overwrite a secret without explicit intent"
```

---

### Task 2: The `shadok-secrets` skill

**Files:**
- Create: `context/secrets-skill/SKILL.md`
- Create: `context/secrets-skill/scripts/secret.py`
- Modify: `src/server.ts` (next to `seedSchedulerSkill`, ~lines 2332-2345)
- Test: `test/secret-script.test.ts`

**Interfaces:**
- Consumes: `PUT /secrets` from Task 1, including its `409 { error: "exists", name }`.
- Produces: `secret.py list` and `secret.py set NAME --stdin`; `seedSecretsSkill(): void` in `src/server.ts`, called at boot.

- [ ] **Step 1: Write the failing test**

Create `test/secret-script.test.ts`. It stands up a fake vault server so the script's real HTTP path is exercised without touching the user's vault:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "context", "secrets-skill", "scripts", "secret.py");

/** A stand-in for the cockpit: records what the script sent, answers `status`. */
function fakeServer(status: number, body: unknown) {
  const seen: { body?: any; cookie?: string } = {};
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.body = raw ? JSON.parse(raw) : null;
      seen.cookie = req.headers.cookie;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return { server, seen };
}

/** Runs secret.py against `port`, feeding `stdin`. Never puts a value in argv. */
function run(args: string[], port: number, stdin: string) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = execFile(
      "python3",
      [SCRIPT, ...args],
      { env: { ...process.env, SHADOK_PORT: String(port), SHADOK_AUTH: "sk_auth=tok" } },
      (e, out, err) => resolve({ code: e ? (e as any).code ?? 1 : 0, out, err }),
    );
    child.stdin!.end(stdin);
  });
}

test("set reads the value from stdin and sends it in the body", async () => {
  const { server, seen } = fakeServer(200, { names: ["A"], result: "created" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const res = await run(["set", "A", "--stdin"], port, "s3cr3t\n");
  server.close();
  assert.equal(res.code, 0);
  assert.deepEqual(seen.body, { name: "A", value: "s3cr3t" });
  assert.equal(seen.cookie, "sk_auth=tok");
  // The value must never be echoed back — the reply lands in the transcript.
  assert.doesNotMatch(res.out, /s3cr3t/);
  // And the user has to be told the secret is inert until attached.
  assert.match(res.out, /profile/i);
});

test("set requires --stdin, so a value can never be passed in argv", async () => {
  const { server } = fakeServer(200, {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const res = await run(["set", "A"], port, "");
  server.close();
  assert.notEqual(res.code, 0);
  assert.match(res.err, /--stdin/);
});

test("an existing name is refused, and the script does not retry", async () => {
  const { server } = fakeServer(409, { error: "exists", name: "A" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const res = await run(["set", "A", "--stdin"], port, "v");
  server.close();
  assert.notEqual(res.code, 0);
  assert.match(res.err, /already exists/i);
});

test("empty stdin is refused before anything is sent", async () => {
  const { server, seen } = fakeServer(200, {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const res = await run(["set", "A", "--stdin"], port, "   \n");
  server.close();
  assert.notEqual(res.code, 0);
  assert.equal(seen.body, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/secret-script.test.ts 2>&1 | tail -20`
Expected: FAIL — the script does not exist.

- [ ] **Step 3: Write the script**

Create `context/secrets-skill/scripts/secret.py`:

```python
#!/usr/bin/env python3
"""Put a secret the agent OBTAINED into shadok-ai's vault, through the local API.

The value is read from STDIN, never from argv: `ps` exposes a process's
arguments to every user on the machine, so a token passed as a parameter leaks.
There is deliberately no way to read a value back out.

Reads SHADOK_PORT / SHADOK_AUTH from the env (injected into every agent).
"""
import argparse, json, os, sys, urllib.error, urllib.parse, urllib.request

PORT = os.environ.get("SHADOK_PORT")
AUTH = os.environ.get("SHADOK_AUTH", "")
if not PORT:
    sys.exit("Not inside a shadok-ai agent (SHADOK_PORT unset).")
BASE = f"http://127.0.0.1:{PORT}"


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("content-type", "application/json")
    if AUTH:
        req.add_header("Cookie", AUTH)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if e.code == 409:
            sys.exit(
                "refused: a secret by that name already exists. Do NOT overwrite it "
                "yourself — tell the user and let them decide."
            )
        sys.exit(f"API error {e.code}: {e.read().decode()[:200]}")
    except urllib.error.URLError as e:
        sys.exit(f"cannot reach the cockpit on {BASE}: {e.reason}")


def main():
    ap = argparse.ArgumentParser(description="shadok-ai secret vault (write-only)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="print the secret NAMES (never values)")
    s = sub.add_parser("set", help="store a value read from stdin")
    s.add_argument("name")
    # Required, not optional: it removes any way to pass a value in argv.
    s.add_argument("--stdin", action="store_true", required=True,
                   help="read the value from stdin (the only way)")
    args = ap.parse_args()

    if args.cmd == "list":
        names = api("GET", "/secrets").get("names", [])
        print("\n".join(names) if names else "(vault empty)")
        return

    value = sys.stdin.read().strip()
    if not value:
        sys.exit("nothing on stdin — pipe the value in, e.g. `gh auth token | ... --stdin`")
    api("PUT", "/secrets", {"name": args.name, "value": value})
    print(f"stored {args.name} in the vault")
    print("It reaches an agent only once attached to a profile (web Profiles panel).")


main()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/secret-script.test.ts 2>&1 | tail -8`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the skill**

Create `context/secrets-skill/SKILL.md`:

```markdown
---
name: shadok-secrets
description: Store a credential you OBTAINED yourself (a CLI login, a provisioned key, an API token you just created) in shadok-ai's secret vault, so the next agent doesn't have to obtain it again. Use when you end a task holding a credential that outlives the session. Never for a secret the user typed in the chat.
---

# shadok-secrets

You sometimes finish a task **holding a credential**: you ran `gh auth login`,
provisioned a database, created an API key with a vendor CLI. That credential
dies with your session, and the next agent starts from nothing — in a container,
where there is no OS keyring, it may not be able to start at all.

Put it in the vault instead.

Only works inside a shadok-ai agent — it needs `SHADOK_PORT` in the env (set
automatically). If it is missing, say so rather than improvising.

## Store it

```bash
gh auth token | ~/.claude/skills/shadok-secrets/scripts/secret.py set GITHUB_TOKEN --stdin
~/.claude/skills/shadok-secrets/scripts/secret.py list
```

## The rules — these are the point

- **Pipe the value in. Never put it in the command.** `ps` shows every
  process's arguments to every user on the machine, so a token as an argument
  leaks. `--stdin` is required precisely so there is no other way.
- **Never print it, ever.** Not in your reply, not in a log line, not into a
  file in the working directory. Your reply is written to a transcript on disk
  and may be mirrored to Telegram.
- **You cannot read a value back.** There is no `get`, by design. `list` shows
  names only.
- **A name that already exists is refused.** That is deliberate: overwriting
  replaces a live credential with nothing to show it happened. Do not retry, do
  not work around it — tell the user the name is taken and let them choose.
- **Say what you stored.** Name the secret in your reply, and add that it
  reaches an agent only once attached to a profile in the web Profiles panel.
  A secret stored in silence is one nobody knows to revoke.

## Not for this

A secret the **user typed in the chat** is already exposed — it is in the
transcript, and in Telegram's history. Storing it does not un-expose it. Point
them at the web Secrets panel, or Telegram's `/secret NAME value`, which deletes
their message afterwards.
```

- [ ] **Step 6: Seed the skill at boot**

In `src/server.ts`, right after the `seedSchedulerSkill();` call (~line 2345):

```ts
// Install/refresh the bundled "shadok-secrets" skill, so an agent that obtains
// a credential can keep it for the next one. Server-owned, overwritten each
// boot to stay current — same contract as the scheduler skill above.
function seedSecretsSkill(): void {
  try {
    const src = path.join(__dirname, "..", "context", "secrets-skill");
    if (!fs.existsSync(path.join(src, "SKILL.md"))) return;
    const dst = path.join(os.homedir(), ".claude", "skills", "shadok-secrets");
    fs.mkdirSync(path.join(dst, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(src, "SKILL.md"), path.join(dst, "SKILL.md"));
    fs.copyFileSync(path.join(src, "scripts", "secret.py"), path.join(dst, "scripts", "secret.py"));
    fs.chmodSync(path.join(dst, "scripts", "secret.py"), 0o755);
  } catch {
    /* best effort — the vault still works from the GUI and Telegram */
  }
}
seedSecretsSkill();
```

- [ ] **Step 7: Build and run the whole suite**

Run: `npm run build && npm test 2>&1 | tail -8`
Expected: build clean, 0 failures.

- [ ] **Step 8: Verify the seeded skill end to end**

Start a side-by-side instance, then check the skill landed and works against it:

```bash
PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js &
ls ~/.claude/skills/shadok-secrets ~/.claude/skills/shadok-secrets/scripts
SHADOK_PORT=3899 sh -c 'printf one | ~/.claude/skills/shadok-secrets/scripts/secret.py set PLAN_TMP3 --stdin'
SHADOK_PORT=3899 ~/.claude/skills/shadok-secrets/scripts/secret.py list | grep PLAN_TMP3
SHADOK_PORT=3899 sh -c 'printf two | ~/.claude/skills/shadok-secrets/scripts/secret.py set PLAN_TMP3 --stdin'  # must refuse
curl -s -X DELETE 'localhost:3899/secrets?name=PLAN_TMP3'
```

Expected: the first store prints `stored PLAN_TMP3 …` and the profile reminder; `list` shows the name; the second exits non-zero with the refusal. Confirm `curl -s -o /dev/null -w '%{http_code}' localhost:3789/` still answers `200`, then stop your instance.

- [ ] **Step 9: Commit**

```bash
git add context/secrets-skill src/server.ts test/secret-script.test.ts
git commit -m "feat: a shadok-secrets skill so an agent can keep a credential it obtained"
```

---

### Task 3: Documentation

**Files:**
- Modify: `CLAUDE.md` (the `src/secrets.ts` map row; a new `context/secrets-skill/` row; the HTTP endpoint list)
- Modify: `docs/architecture.md` (the profiles & secrets section)
- Modify: `README.md` (the secret vault bullet)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Update the architecture map**

In `CLAUDE.md`, extend the `src/secrets.ts` row with the guard, and add a row for the skill right after it:

```markdown
| `src/secrets.ts` | Central secret vault (`~/.shadok-ai/secrets.json`, 600). Profiles reference secrets **by name**; values are injected as env at spawn. `secretWriteVerdict` (pure, tested) is the no-silent-overwrite rule behind `PUT /secrets`: an existing name is refused unless the caller passes `overwrite: true`. HTTP is the only way an AGENT can reach the vault (Telegram's `/secret` calls `setSecret()` directly), so that endpoint is exactly the machine boundary. |
| `context/secrets-skill/` | The `shadok-secrets` skill, seeded into `~/.claude/skills/` at boot (`seedSecretsSkill`, twin of `seedSchedulerSkill`): lets an agent store a credential it OBTAINED itself. `scripts/secret.py` has `list` and `set NAME --stdin` and **no `get`** — `--stdin` is required so a value can never sit in `argv`, which `ps` exposes machine-wide. |
```

- [ ] **Step 2: Add the endpoint note**

In `CLAUDE.md`, in the `**HTTP:**` paragraph, the `/secrets` entry becomes:

```
`/profiles` `/secrets` (GET/PUT/DELETE — GET returns NAMES only; PUT refuses an
existing name with 409 unless `overwrite: true`)
```

- [ ] **Step 3: Document it in the architecture doc**

In `docs/architecture.md`, in the "Profiles & secrets" section, append:

```markdown
**An agent can add to the vault, and only add.** A credential an agent obtains
itself — `gh auth login`, a provisioning CLI — used to die with the session. The
`shadok-secrets` skill (seeded at boot from `context/secrets-skill/`) gives it a
way to keep that credential for the next agent, under three constraints that are
the whole design:

- **Write-only.** There is no `get`, and `GET /secrets` returns names. A value
  leaves the vault in exactly one way: injected as env into an agent at spawn.
- **The value never touches `argv`.** `secret.py set NAME --stdin` makes the flag
  *required*, so there is structurally no argument to leak — `ps` shows a
  process's arguments to every user on the machine.
- **No silent overwrite.** `PUT /secrets` refuses an existing name (409) unless
  the caller passes `overwrite: true`. The web Secrets panel passes it, because a
  person reading the list and clicking Save is deliberate. An agent does not, and
  is told to report the clash rather than work around it. Overwriting is the only
  destructive move here: it replaces a live credential, shows nothing, and the
  vault keeps no history.

Telegram needs no guard: `/secret NAME value` calls `setSecret()` directly, in
the server's own process. HTTP is the only door an agent has, which is why
guarding the endpoint guards precisely the machine path.
```

- [ ] **Step 4: Update the README**

In `README.md`, replace the secret vault bullet:

```markdown
- **Secret vault** — stored under `~/.shadok-ai`, never in your repo, injected
  as env vars into the agents that need them. An agent that **obtains** a
  credential (a CLI login, a key it just provisioned) can add it to the vault
  itself so the next agent doesn't start from nothing — write-only, the value
  piped in rather than typed as an argument, and never overwriting an existing
  name without you saying so.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/architecture.md README.md
git commit -m "docs: agent-written secrets, and the boundary that guards them"
```

---

## Self-review notes

- Spec coverage: the guard and its pure core → Task 1 (steps 1-5); the human surfaces keeping overwrite → Task 1 step 6, with Telegram explicitly untouched; the skill, its stdin-only rule, the absent `get`, the refusal behaviour and the "say what you stored" rule → Task 2 (steps 3 and 5, asserted by the tests in step 1); boot seeding → Task 2 step 6; visibility with no new UI → the script's own output plus the skill's rules; tests → Tasks 1 and 2; browser check of the Secrets panel → Task 1 step 9; docs → Task 3.
- The tests use throwaway names (`PLAN_TMP*`) and a fake local server, so no real credential is ever involved and the user's vault is left as it was.

# Web accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the web cockpit named accounts, so every prompt carries who sent it.

**Architecture:** Accounts live per launch directory in `~/.shadok-ai/users/<key>.json`.
The existing `SHADOK_GUI_PASSWORD` remains the door and IS the `admin` account.
Sessions are a signed cookie — no session store — verified against the account
file on every request. The "who spoke" pipeline already exists end to end
(`prompt.from` → `prompt-echo` → `promptMetaHeader` → `echoAuthor`); the server
merely stamps `from` from the session for web clients.

**Tech Stack:** TypeScript/ESM/Node 20, Express, `ws`, node `crypto` (scrypt +
HMAC — no new dependency). Client is plain HTML/JS, no framework, no build.

**Spec:** `docs/superpowers/specs/2026-08-27-web-accounts-design.md`

## Global Constraints

- **Everything written into the repo is in English** — code comments,
  identifiers, commit messages, PR titles and bodies, tests, log and error
  strings. (`CLAUDE.md`, Conventions.)
- **Comments explain WHY**, not what.
- TypeScript, ESM, Node 20, `.js` extensions in imports (NodeNext).
- **Dormant without a password**: with `SHADOK_GUI_PASSWORD` unset, there is no
  auth, no login screen and no `from` — byte-for-byte today's behaviour.
- **Roles gate account management only.** A `member` does everything a user does
  today.
- **The session signing secret is never exported into an agent's environment.**
- **Never restart the shadok-ai server on 3789** (`CLAUDE.md`, invariant 8).
  Verify on a free port: `PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js`.
- After any change: `npm run build && npm test`. One commit per task, English message.
- **Out of scope, and it must stay stated:** `SHADOK_GUI_PASSWORD` keeps leaking
  into every agent's environment, and `SHADOK_AUTH` keeps giving agents an admin
  cookie. This plan closes the impersonation path that accounts would have opened —
  the signing secret is a separate file that never enters an env — but it does
  not fix the leak itself. Do not silently widen the plan to chase it.

---

### Task 1: `instanceKey` — one encoder for per-instance files

**Files:**
- Create: `src/paths.ts`
- Test: `test/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `instanceKey(cwd?: string): string` — the launch directory encoded
  as a filename, used by Tasks 2 and 3.

- [ ] **Step 1: Write the failing test**

Create `test/paths.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { instanceKey } from "../src/paths.js";

test("instanceKey: every non-alphanumeric character becomes a dash", () => {
  assert.equal(instanceKey("/Users/a/projects/shadok-ai"), "-Users-a-projects-shadok-ai");
});

test("instanceKey: the same encoding the existing stores already use", () => {
  // channels.ts, crons.ts and lock.ts each inline this expression. A new file
  // landing next to theirs must key on the SAME string, or an instance would
  // read its channels from one name and its accounts from another.
  const cwd = "/tmp/x.y_z-1";
  assert.equal(instanceKey(cwd), cwd.replace(/[^a-zA-Z0-9]/g, "-"));
});

test("instanceKey: defaults to the process's own directory", () => {
  assert.equal(instanceKey(), process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test test/paths.test.ts`
Expected: FAIL — `Cannot find module '.../src/paths.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/paths.ts`:

```ts
/**
 * The launch directory, encoded as a filename.
 *
 * Channels, crons and the instance lock each key their store on this same
 * expression, inlined in four different files. Anything NEW that is per
 * instance uses this one instead of adding a fifth copy — a store that keyed on
 * a slightly different string would silently belong to another instance.
 *
 * The six existing sites are deliberately left alone: rewriting them would bury
 * the change that needed this.
 */
export function instanceKey(cwd: string = process.cwd()): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --import tsx --test test/paths.test.ts` — Expected: PASS (3 tests).
Then `npm run build && npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts test/paths.test.ts
git commit -m "One encoder for per-instance file names"
```

---

### Task 2: The account store and its write rules

**Files:**
- Create: `src/accounts.ts`
- Test: `test/accounts.test.ts`

**Interfaces:**
- Consumes: `instanceKey` (Task 1).
- Produces:
  - `type Role = "admin" | "member"`
  - `interface Account { name: string; role: Role; passwordHash?: string; createdAt: number; invite?: { token: string; expiresAt: number } }`
  - `BOOTSTRAP_ADMIN = "admin"`
  - `loadAccounts(): Account[]`, `saveAccounts(list: Account[]): void`
  - `hashPassword(plain: string): string`, `verifyPassword(plain: string, hash: string): boolean`
  - `userWriteVerdict(o: { actorRole: Role | null; action: "create" | "delete" | "role"; target: string; exists: boolean }): { ok: true } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing test**

Create `test/accounts.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOTSTRAP_ADMIN,
  hashPassword,
  verifyPassword,
  userWriteVerdict,
} from "../src/accounts.js";

test("password: a hash verifies its own plaintext and nothing else", () => {
  const h = hashPassword("correct horse");
  assert.equal(verifyPassword("correct horse", h), true);
  assert.equal(verifyPassword("Correct horse", h), false);
  assert.equal(verifyPassword("", h), false);
});

test("password: two hashes of the same word differ (salted)", () => {
  // An unsalted hash would let anyone spot two people sharing a password.
  assert.notEqual(hashPassword("same"), hashPassword("same"));
});

test("password: a malformed hash is refused, never crashes", () => {
  assert.equal(verifyPassword("x", "not-a-hash"), false);
  assert.equal(verifyPassword("x", ""), false);
});

test("write rules: only an admin may create, delete or re-role", () => {
  for (const action of ["create", "delete", "role"] as const) {
    const v = userWriteVerdict({ actorRole: "member", action, target: "bob", exists: true });
    assert.equal(v.ok, false, action);
    assert.match((v as { error: string }).error, /admin/i);
  }
});

test("write rules: an admin may do all three", () => {
  assert.deepEqual(userWriteVerdict({ actorRole: "admin", action: "create", target: "bob", exists: false }), { ok: true });
  assert.deepEqual(userWriteVerdict({ actorRole: "admin", action: "delete", target: "bob", exists: true }), { ok: true });
  assert.deepEqual(userWriteVerdict({ actorRole: "admin", action: "role", target: "bob", exists: true }), { ok: true });
});

test("write rules: nobody may create an account named like the bootstrap admin", () => {
  // It lives in the password, not in the file. A file account of the same name
  // would shadow it and could never be logged into.
  const v = userWriteVerdict({ actorRole: "admin", action: "create", target: BOOTSTRAP_ADMIN, exists: false });
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /reserved/i);
});

test("write rules: creating a name that exists, or touching one that does not", () => {
  const dup = userWriteVerdict({ actorRole: "admin", action: "create", target: "bob", exists: true });
  assert.equal(dup.ok, false);
  assert.match((dup as { error: string }).error, /already exists/i);
  const gone = userWriteVerdict({ actorRole: "admin", action: "delete", target: "bob", exists: false });
  assert.equal(gone.ok, false);
  assert.match((gone as { error: string }).error, /no such account/i);
});

test("write rules: an empty name is refused", () => {
  const v = userWriteVerdict({ actorRole: "admin", action: "create", target: "   ", exists: false });
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /name required/i);
});

test("write rules: not signed in is not an admin", () => {
  const v = userWriteVerdict({ actorRole: null, action: "create", target: "bob", exists: false });
  assert.equal(v.ok, false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test test/accounts.test.ts`
Expected: FAIL — `Cannot find module '.../src/accounts.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/accounts.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { instanceKey } from "./paths.js";

/**
 * Web accounts, PER INSTANCE (per launch directory) — the same scope as
 * channels, crons and the instance lock.
 *
 * Per instance rather than global is the consistent choice: SHADOK_GUI_PASSWORD
 * is already per process, so accounts share the scope of the door they extend.
 * Profiles and the secret vault are the global exception, not the rule.
 */
export type Role = "admin" | "member";

export interface Account {
  name: string;
  role: Role;
  /** Absent until an invitation is redeemed. */
  passwordHash?: string;
  createdAt: number;
  /** Present only while the invitation is outstanding. */
  invite?: { token: string; expiresAt: number };
}

/** The account that lives in SHADOK_GUI_PASSWORD, never in the file. */
export const BOOTSTRAP_ADMIN = "admin";

function storeFile(): string {
  return path.join(os.homedir(), ".shadok-ai", "users", instanceKey() + ".json");
}

export function loadAccounts(): Account[] {
  try {
    const v = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
    return Array.isArray(v) ? v.filter((a) => a && typeof a.name === "string") : [];
  } catch {
    return [];
  }
}

export function saveAccounts(list: Account[]): void {
  const f = storeFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.chmodSync(f, 0o600);
}

/** `scrypt$<salt hex>$<derived hex>` — salted, so two identical passwords do
 *  not produce the same hash and cannot be spotted as identical. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(plain: string, hash: string): boolean {
  const parts = String(hash ?? "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const want = Buffer.from(parts[2], "hex");
    const got = scryptSync(plain, salt, want.length);
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/**
 * Who may change which account. Pure, so the whole policy is one testable
 * place rather than a condition repeated at three endpoints.
 */
export function userWriteVerdict(o: {
  actorRole: Role | null;
  action: "create" | "delete" | "role";
  target: string;
  exists: boolean;
}): { ok: true } | { ok: false; error: string } {
  if (o.actorRole !== "admin") return { ok: false, error: "only an admin can manage accounts" };
  const name = o.target.trim();
  if (!name) return { ok: false, error: "name required" };
  if (o.action === "create") {
    if (name === BOOTSTRAP_ADMIN)
      return { ok: false, error: `"${BOOTSTRAP_ADMIN}" is reserved for the instance password` };
    return o.exists ? { ok: false, error: `${name} already exists` } : { ok: true };
  }
  return o.exists ? { ok: true } : { ok: false, error: `no such account: ${name}` };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --import tsx --test test/accounts.test.ts` — Expected: PASS (8 tests).
Then `npm run build && npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/accounts.ts test/accounts.test.ts
git commit -m "Per-instance account store, salted hashes, and the write rules"
```

---

### Task 3: Signed sessions, on a secret agents never see

**Files:**
- Modify: `src/accounts.ts`
- Test: `test/accounts.test.ts`

**Interfaces:**
- Consumes: `instanceKey` (Task 1).
- Produces:
  - `sessionSecret(): Buffer` — per-instance, drawn once, persisted.
  - `signSession(user: string, issuedAt: number, secret: Buffer): string`
  - `readSession(token: string, secret: Buffer, now: number, maxAgeMs: number): string | null` — the user name, or null.

**Design note for the implementer:** the token carries the user and the issue
time, NOT the role. The role is re-read from the account file at use time, so a
demotion takes effect immediately instead of riding in a stale cookie.

- [ ] **Step 1: Write the failing test**

Append to `test/accounts.test.ts`:

```ts
import { signSession, readSession } from "../src/accounts.js";

const SECRET = Buffer.from("a".repeat(64), "hex");
const WEEK = 7 * 24 * 3600 * 1000;

test("session: a token round-trips to its user", () => {
  const t = signSession("alex", 1_000, SECRET);
  assert.equal(readSession(t, SECRET, 2_000, WEEK), "alex");
});

test("session: a tampered user is refused", () => {
  // Swapping the name must not survive: the signature covers it.
  const t = signSession("alex", 1_000, SECRET);
  const forged = t.replace("alex", "root");
  assert.equal(readSession(forged, SECRET, 2_000, WEEK), null);
});

test("session: another instance's secret is refused", () => {
  // The secret is per instance, so a cookie never crosses instances.
  const other = Buffer.from("b".repeat(64), "hex");
  assert.equal(readSession(signSession("alex", 1_000, SECRET), other, 2_000, WEEK), null);
});

test("session: an expired token is refused", () => {
  const t = signSession("alex", 1_000, SECRET);
  assert.equal(readSession(t, SECRET, 1_000 + WEEK + 1, WEEK), null);
  assert.equal(readSession(t, SECRET, 1_000 + WEEK - 1, WEEK), "alex");
});

test("session: garbage in, null out — never a throw", () => {
  for (const bad of ["", "x", "a.b", "a.b.c.d", "..", "alex.notanumber.deadbeef"])
    assert.equal(readSession(bad, SECRET, 2_000, WEEK), null, bad);
});

test("session: a user name containing a dot still round-trips", () => {
  // The token is dot-separated; a name with a dot must not shift the fields.
  const t = signSession("first.last", 1_000, SECRET);
  assert.equal(readSession(t, SECRET, 2_000, WEEK), "first.last");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test test/accounts.test.ts`
Expected: FAIL — `signSession is not exported`.

- [ ] **Step 3: Write the implementation**

Append to `src/accounts.ts`:

```ts
import { createHmac } from "node:crypto";

/**
 * The key that signs sessions — per instance, drawn once, persisted.
 *
 * NOT derived from SHADOK_GUI_PASSWORD, and never exported into an agent's
 * environment. The password leaks into every agent's env today (measured on
 * three production agents, 2026-08-23); signing with it would let any agent mint
 * a cookie for any user. Untidy becomes impersonation the moment accounts exist.
 */
export function sessionSecret(): Buffer {
  const f = path.join(os.homedir(), ".shadok-ai", "users", instanceKey() + ".key");
  try {
    const hex = fs.readFileSync(f, "utf8").trim();
    if (hex.length >= 32) return Buffer.from(hex, "hex");
  } catch {
    /* first run, or unreadable: draw a new one below */
  }
  const secret = randomBytes(32);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, secret.toString("hex"), { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  return secret;
}

/** `<user base64url>.<issuedAt>.<hmac>` — the name is encoded so a dot in it
 *  cannot shift the fields. */
export function signSession(user: string, issuedAt: number, secret: Buffer): string {
  const u = Buffer.from(user, "utf8").toString("base64url");
  const body = `${u}.${issuedAt}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function readSession(
  token: string,
  secret: Buffer,
  now: number,
  maxAgeMs: number,
): string | null {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const [u, at, mac] = parts;
  const issuedAt = Number(at);
  if (!Number.isFinite(issuedAt)) return null;
  const want = createHmac("sha256", secret).update(`${u}.${at}`).digest("hex");
  if (mac.length !== want.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  if (now - issuedAt > maxAgeMs) return null;
  try {
    return Buffer.from(u, "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --import tsx --test test/accounts.test.ts` — Expected: PASS (14 tests).
Then `npm run build && npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/accounts.ts test/accounts.test.ts
git commit -m "Signed sessions on a per-instance secret agents never receive"
```

---

### Task 4: Invitations

**Files:**
- Modify: `src/accounts.ts`
- Test: `test/accounts.test.ts`

**Interfaces:**
- Consumes: `Account` (Task 2).
- Produces:
  - `INVITE_TTL_MS = 7 * 24 * 3600 * 1000`
  - `newInvite(now: number): { token: string; expiresAt: number }`
  - `inviteVerdict(account: Account | undefined, token: string, now: number): { ok: true } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing test**

Append to `test/accounts.test.ts`:

```ts
import { newInvite, inviteVerdict, INVITE_TTL_MS, type Account } from "../src/accounts.js";

const withInvite = (over: Partial<Account> = {}): Account => ({
  name: "bob", role: "member", createdAt: 0,
  invite: { token: "tok", expiresAt: 1_000 }, ...over,
});

test("invite: a fresh one is valid until it expires", () => {
  assert.deepEqual(inviteVerdict(withInvite(), "tok", 999), { ok: true });
});

test("invite: an unknown account says so", () => {
  const v = inviteVerdict(undefined, "tok", 0);
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /unknown/i);
});

test("invite: a wrong token is refused", () => {
  const v = inviteVerdict(withInvite(), "nope", 0);
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /invalid/i);
});

test("invite: an expired link says EXPIRED, not 'invalid'", () => {
  // "This link has expired" tells you to ask for another one; "invalid" sends
  // you looking for a bug.
  const v = inviteVerdict(withInvite(), "tok", 1_001);
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /expired/i);
});

test("invite: an already redeemed link says so", () => {
  // Redeeming drops `invite` and sets a hash.
  const used: Account = { name: "bob", role: "member", createdAt: 0, passwordHash: "scrypt$aa$bb" };
  const v = inviteVerdict(used, "tok", 0);
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /already/i);
});

test("newInvite: a random token and a one-week life", () => {
  const a = newInvite(0), b = newInvite(0);
  assert.notEqual(a.token, b.token);
  assert.ok(a.token.length >= 32);
  assert.equal(a.expiresAt, INVITE_TTL_MS);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test test/accounts.test.ts`
Expected: FAIL — `newInvite is not exported`.

- [ ] **Step 3: Write the implementation**

Append to `src/accounts.ts`:

```ts
/** A week: long enough to hand the link over by another channel, short enough
 *  that a forgotten one stops working. */
export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export function newInvite(now: number): { token: string; expiresAt: number } {
  return { token: randomBytes(24).toString("base64url"), expiresAt: now + INVITE_TTL_MS };
}

/**
 * Whether this link may still be redeemed.
 *
 * Each refusal names its own reason: "expired" tells the holder to ask for a
 * new link, "already redeemed" tells them the account is live, and "invalid"
 * is a real mismatch. A single generic error would send all three to the wrong
 * place.
 */
export function inviteVerdict(
  account: Account | undefined,
  token: string,
  now: number,
): { ok: true } | { ok: false; error: string } {
  if (!account) return { ok: false, error: "unknown invitation" };
  if (!account.invite)
    return { ok: false, error: "this invitation was already redeemed — sign in instead" };
  if (account.invite.token !== token) return { ok: false, error: "invalid invitation" };
  if (now > account.invite.expiresAt)
    return { ok: false, error: "this invitation has expired — ask for a new link" };
  return { ok: true };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --import tsx --test test/accounts.test.ts` — Expected: PASS (20 tests).
Then `npm run build && npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/accounts.ts test/accounts.test.ts
git commit -m "Single-use invitations, each refusal naming its own reason"
```

---

### Task 5: Log in as a named account

**Files:**
- Modify: `src/server.ts` (the auth block around lines 191-215, `cookieToken`/
  `requestAuthed` around 607-621, `/login` around 698-715)

**Interfaces:**
- Consumes: `loadAccounts`, `verifyPassword`, `sessionSecret`, `signSession`,
  `readSession`, `BOOTSTRAP_ADMIN`, `Role` (Tasks 2-3).
- Produces:
  - `currentAccount(req): { name: string; role: Role } | null` — used by Tasks 6 and 7.
  - `SESSION_TTL_MS`

**Context the implementer needs.** Today the cookie is a deterministic HMAC of
the password, identical for everyone, and `requestAuthed` compares it to
`AUTH_TOKEN`. That constant goes away: a cookie must now name someone.

- [ ] **Step 1: Replace the token constant with a session secret**

In `src/server.ts`, replace the `AUTH_TOKEN` declaration (around line 201):

```ts
const AUTH_TOKEN = GUI_PASSWORD
  ? createHmac("sha256", GUI_PASSWORD).update("shadok-ai-auth-v1").digest("hex")
  : "";
```

with:

```ts
/** A week, matching the cookie's Max-Age: one is the other's enforcement. */
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
// Sessions are signed with a per-instance secret, NOT with the password: the
// password reaches every agent's environment, so signing with it would let an
// agent mint a cookie for anyone. Drawn lazily so an instance with no password
// never creates a key file it will not use.
let sessionKeyCache: Buffer | null = null;
const signingSecret = (): Buffer => (sessionKeyCache ??= sessionSecret());
/** The bridge and the agents authenticate as the bootstrap admin. */
const adminCookie = () =>
  GUI_PASSWORD ? `sk_auth=${signSession(BOOTSTRAP_ADMIN, Date.now(), signingSecret())}` : undefined;
```

Then replace the two uses of `AUTH_TOKEN`:
- `const tgCookie = () => (GUI_PASSWORD ? \`sk_auth=${AUTH_TOKEN}\` : undefined);` → `const tgCookie = adminCookie;`
- `if (GUI_PASSWORD) env.SHADOK_AUTH = \`sk_auth=${AUTH_TOKEN}\`;` (line ~1719) →
  `if (GUI_PASSWORD) env.SHADOK_AUTH = adminCookie()!;`

- [ ] **Step 2: Replace `requestAuthed` with an account lookup**

Replace `requestAuthed` (around line 611) with:

```ts
/**
 * Who this request is, or null. Re-reads the account file every time, so
 * deleting an account or changing a role takes effect at once — that is what
 * buys us the absence of a session store.
 */
function currentAccount(req: { headers: Record<string, unknown> }): { name: string; role: Role } | null {
  if (!GUI_PASSWORD) return { name: BOOTSTRAP_ADMIN, role: "admin" };
  const tok = cookieToken(req.headers.cookie as string | undefined);
  if (!tok) return null;
  const user = readSession(tok, signingSecret(), Date.now(), SESSION_TTL_MS);
  if (!user) return null;
  if (user === BOOTSTRAP_ADMIN) return { name: BOOTSTRAP_ADMIN, role: "admin" };
  const acct = loadAccounts().find((a) => a.name === user);
  // No hash means an invitation that was never redeemed: not a login yet.
  if (!acct?.passwordHash) return null;
  return { name: acct.name, role: acct.role };
}

function requestAuthed(req: { headers: Record<string, unknown> }): boolean {
  return currentAccount(req) !== null;
}
```

- [ ] **Step 3: Accept a username at `/login`**

Replace the `/login` handler (around line 698) with:

```ts
// Login (always reachable) — sets an HttpOnly session cookie naming the user.
app.post("/login", (req, res) => {
  if (!GUI_PASSWORD) return res.json({ ok: true });
  const user = String(req.body?.user ?? "").trim();
  const password = String(req.body?.password ?? "");
  // No username means the instance password: the habit of typing just the
  // password keeps working, and it is what the bootstrap admin is.
  const ok = !user || user === BOOTSTRAP_ADMIN
    ? passwordMatches(password)
    : (() => {
        const a = loadAccounts().find((x) => x.name === user);
        return !!a?.passwordHash && verifyPassword(password, a.passwordHash);
      })();
  if (!ok) return res.status(401).json({ error: "wrong username or password" });
  const name = !user ? BOOTSTRAP_ADMIN : user;
  res.setHeader(
    "Set-Cookie",
    `sk_auth=${signSession(name, Date.now(), signingSecret())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
  );
  return res.json({ ok: true, user: name });
});
```

- [ ] **Step 4: Add `/me`, just after `/login`**

```ts
// Who am I? The client labels itself with this; it is also how a page reacts to
// a session that expired while the tab was open.
app.get("/me", (req, res) => {
  const me = currentAccount(req);
  return me ? res.json(me) : res.status(401).json({ error: "unauthorized" });
});
```

Add `"/me"` to the paths the auth middleware lets through — it must answer 401
rather than redirect. In the middleware (around line 710), change the guard to:

```ts
app.use((req, res, next) => {
  if (req.path === "/me" || requestAuthed(req)) return next();
  if (req.method === "GET" && (req.headers.accept ?? "").includes("text/html"))
    return sendLogin(res);
  return res.status(401).json({ error: "unauthorized" });
});
```

- [ ] **Step 5: Import what the file now needs**

Add to the imports at the top of `src/server.ts`:

```ts
import {
  BOOTSTRAP_ADMIN,
  loadAccounts,
  verifyPassword,
  sessionSecret,
  signSession,
  readSession,
  type Role,
} from "./accounts.js";
```

- [ ] **Step 6: Verify**

Run: `npm run build && npm test` — Expected: PASS.

Then, against a throwaway instance (never 3789):

```bash
HOME=/tmp/acct-a SHADOK_GUI_PASSWORD=secret PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js &
curl -s -o /dev/null -w '%{http_code}\n' localhost:3899/            # 200 (login page)
curl -s -i -X POST localhost:3899/login -H 'Content-Type: application/json' -d '{"password":"secret"}' | grep -i set-cookie
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3899/login -H 'Content-Type: application/json' -d '{"password":"wrong"}'   # 401
```

Expected: a `sk_auth=YWRtaW4.<millis>.<hex>` cookie, and 401 on a wrong password.
Then with that cookie: `curl -s -b "sk_auth=…" localhost:3899/me` → `{"name":"admin","role":"admin"}`.

Also confirm the one-time break the spec accepts: a cookie in the OLD shape (a
bare 64-character hex string) must now be refused —
`curl -s -o /dev/null -w '%{http_code}\n' -b "sk_auth=$(printf 'a%.0s' {1..64})" localhost:3899/me`
returns 401, so an already-open browser is sent back to the login page once.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts
git commit -m "A session cookie names its user, signed with a per-instance secret"
```

---

### Task 6: Managing accounts

**Files:**
- Modify: `src/server.ts` (add the routes next to `/profiles`, around line 1089)

**Interfaces:**
- Consumes: `currentAccount` (Task 5), `userWriteVerdict`, `loadAccounts`,
  `saveAccounts`, `newInvite`, `inviteVerdict`, `hashPassword` (Tasks 2-4).
- Produces: the endpoints Task 8's panel calls.

- [ ] **Step 1: Add the routes**

Insert next to the `/profiles` routes in `src/server.ts`:

```ts
/** Accounts are listed to admins only: a member has no use for the list, and
 *  the shortest surface wins. Hashes and live invitation tokens never leave. */
app.get("/users", (req, res) => {
  const me = currentAccount(req);
  if (me?.role !== "admin") return res.status(403).json({ error: "only an admin can manage accounts" });
  res.json(
    loadAccounts().map((a) => ({
      name: a.name,
      role: a.role,
      pending: !a.passwordHash,
      expiresAt: a.invite?.expiresAt ?? null,
    })),
  );
});

// Create + issue the invitation in one step: an account with no way in is a
// dead row, and two calls would let one succeed without the other.
app.post("/users", (req, res) => {
  const me = currentAccount(req);
  const name = String(req.body?.name ?? "").trim();
  const role: Role = req.body?.role === "admin" ? "admin" : "member";
  const list = loadAccounts();
  const v = userWriteVerdict({
    actorRole: me?.role ?? null,
    action: "create",
    target: name,
    exists: list.some((a) => a.name === name),
  });
  if (!v.ok) return res.status(me?.role === "admin" ? 400 : 403).json({ error: v.error });
  const invite = newInvite(Date.now());
  saveAccounts([...list, { name, role, createdAt: Date.now(), invite }]);
  console.log(`users: ${me!.name} invited ${name} as ${role}`);
  res.json({ ok: true, name, role, inviteUrl: `/invite/${invite.token}` });
});

app.delete("/users", (req, res) => {
  const me = currentAccount(req);
  const name = String(req.query.name ?? "").trim();
  const list = loadAccounts();
  const v = userWriteVerdict({
    actorRole: me?.role ?? null,
    action: "delete",
    target: name,
    exists: list.some((a) => a.name === name),
  });
  if (!v.ok) return res.status(me?.role === "admin" ? 400 : 403).json({ error: v.error });
  saveAccounts(list.filter((a) => a.name !== name));
  console.log(`users: ${me!.name} removed ${name}`);
  res.json({ ok: true });
});

app.post("/users/role", (req, res) => {
  const me = currentAccount(req);
  const name = String(req.body?.name ?? "").trim();
  const role: Role = req.body?.role === "admin" ? "admin" : "member";
  const list = loadAccounts();
  const v = userWriteVerdict({
    actorRole: me?.role ?? null,
    action: "role",
    target: name,
    exists: list.some((a) => a.name === name),
  });
  if (!v.ok) return res.status(me?.role === "admin" ? 400 : 403).json({ error: v.error });
  saveAccounts(list.map((a) => (a.name === name ? { ...a, role } : a)));
  res.json({ ok: true });
});
```

- [ ] **Step 2: Add the invitation routes, and let them through the gate**

The invitee has no session yet, so these must sit BEFORE the auth middleware —
next to `/login`:

```ts
// Redeeming an invitation happens WITHOUT a session: the whole point is that
// the holder cannot get in yet.
app.get("/invite/:token", (req, res) => {
  const token = String(req.params.token ?? "");
  const acct = loadAccounts().find((a) => a.invite?.token === token);
  const v = inviteVerdict(acct, token, Date.now());
  if (!v.ok) return res.status(400).type("text").send(v.error);
  res.type("html").send(invitePage(acct!.name, token));
});

app.post("/invite/:token", (req, res) => {
  const token = String(req.params.token ?? "");
  const password = String(req.body?.password ?? "");
  const list = loadAccounts();
  const acct = list.find((a) => a.invite?.token === token);
  const v = inviteVerdict(acct, token, Date.now());
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (password.length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });
  saveAccounts(
    list.map((a) =>
      a.name === acct!.name ? { name: a.name, role: a.role, createdAt: a.createdAt, passwordHash: hashPassword(password) } : a,
    ),
  );
  console.log(`users: ${acct!.name} redeemed their invitation`);
  res.json({ ok: true, user: acct!.name });
});
```

- [ ] **Step 3: Turn the login page into a two-purpose form**

`LOGIN_HTML` posts to `/login` from a nonce-d inline script. The invitation page
needs the same shell — same CSP, same styling — posting somewhere else. Rather
than string-replace JavaScript, give the form a `data-action` and let the one
script read it.

Replace the `<form id=f>` line and the script in `LOGIN_HTML` with:

```
<form id=f data-action="/login">
<h1>◆ shadok-ai</h1><input id=u placeholder="User (blank = admin)" autocomplete=username><input id=pw type=password placeholder="Password" autofocus autocomplete=current-password><button>Enter</button><div class=err></div></form>
<script nonce="${NONCE_PLACEHOLDER}">
document.getElementById("f").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const invite = f.dataset.action !== "/login";
  // One form, two destinations: signing in, or choosing a password for the
  // first time. The fields differ, so the body does too.
  const body = invite
    ? { password: document.getElementById("pw").value }
    : { user: document.getElementById("u").value, password: document.getElementById("pw").value };
  fetch(f.dataset.action, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    if (r.ok) return location.assign("/");
    const j = await r.json().catch(() => ({}));
    document.querySelector(".err").textContent = j.error || "Wrong username or password";
  });
});
</script>
```

Then the invitation page is the same HTML with three substitutions:

```ts
/** The page an invited person lands on: the login shell, pointed at the
 *  redemption route. Same CSP and same nonce — a page that exempted itself from
 *  the policy protecting every other page would be a strange message. */
function invitePage(name: string, token: string): string {
  return LOGIN_HTML
    .replace("<title>shadok-ai — login</title>", "<title>shadok-ai — choose a password</title>")
    .replace('data-action="/login"', `data-action="/invite/${encodeURIComponent(token)}"`)
    // The name is the admin's input: it must never be able to close the tag.
    .replace("◆ shadok-ai", `Welcome, ${name.replace(/[<>&"']/g, "")}`)
    .replace(
      '<input id=u placeholder="User (blank = admin)" autocomplete=username>',
      "",
    )
    .replace('placeholder="Password"', 'placeholder="Choose a password (8+ characters)"')
    .replace("autocomplete=current-password", "autocomplete=new-password");
}
```

and it is served with the same helper as the login page — reuse `sendLogin`'s
body by extracting it:

```ts
/** Serves a login-shaped page with its CSP and nonce. */
function sendAuthPage(res: express.Response, html: string, status: number): void {
  const nonce = randomUUID();
  res.setHeader("Content-Security-Policy", cspHeader(nonce));
  res.status(status).type("html").send(injectNonce(html, nonce));
}
function sendLogin(res: express.Response): void {
  sendAuthPage(res, LOGIN_HTML, 401);
}
```

so the `GET /invite/:token` route from Step 2 becomes:

```ts
  res.type("html");
  return sendAuthPage(res, invitePage(acct!.name, token), 200);
```

- [ ] **Step 4: Verify by hand**

```bash
C=$(curl -s -i -X POST localhost:3899/login -H 'Content-Type: application/json' -d '{"password":"secret"}' | sed -n 's/.*sk_auth=\([^;]*\).*/\1/p')
curl -s -b "sk_auth=$C" -X POST localhost:3899/users -H 'Content-Type: application/json' -d '{"name":"bob","role":"member"}'
# → {"ok":true,"name":"bob","role":"member","inviteUrl":"/invite/<token>"}
curl -s -o /dev/null -w '%{http_code}\n' localhost:3899/invite/<token>          # 200
curl -s -X POST localhost:3899/invite/<token> -H 'Content-Type: application/json' -d '{"password":"hunter2hunter2"}'
curl -s -X POST localhost:3899/login -H 'Content-Type: application/json' -d '{"user":"bob","password":"hunter2hunter2"}'
curl -s -o /dev/null -w '%{http_code}\n' -b "sk_auth=<bob cookie>" localhost:3899/users   # 403
```

Expected: the invitation redeems once, bob can log in, and bob cannot list
accounts.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "Account management, and invitations redeemable without a session"
```

---

### Task 7: The server stamps who spoke

**Files:**
- Modify: `src/server.ts` (`wss.on("connection")` around line 2587, the
  `prompt` case around line 2910)

**Interfaces:**
- Consumes: `currentAccount` (Task 5).
- Produces: nothing new — it fills the existing `from` field.

- [ ] **Step 1: Give the connection handler the request**

The handler currently ignores it:

```ts
wss.on("connection", (ws: WebSocket) => {
```

Change to:

```ts
wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  // Who is on the other end, resolved ONCE at connect. A web client must not be
  // able to claim someone else's name by editing a frame, so this — not
  // `msg.from` — is what a web prompt is attributed to.
  const me = currentAccount(req);
```

`IncomingMessage` is already imported in `src/server.ts` (it is used by the
Express types); if it is not, add `import type { IncomingMessage } from "node:http";`.

- [ ] **Step 2: Stamp the author on web prompts**

In the `prompt` case, the echo and the submitted text both read `msg.from`.
Insert just before the echo broadcast:

```ts
// The bridge is trusted to name its sender (Telegram knows it); a browser is
// not. For web clients the session decides, and any `from` in the frame is
// discarded.
const author = origin === "web" ? (me?.name ?? undefined) : msg.from;
```

then replace both uses of `msg.from` in this case with `author`:
- in the `prompt-echo` broadcast: `...(author ? { from: author } : {})`
- in `promptMetaHeader(origin, new Date(), author, defaultTimeZone())`

- [ ] **Step 3: Verify**

Run: `npm run build && npm test` — Expected: PASS.

Then by hand, on the throwaway instance from Task 5: open two browser tabs
signed in as different accounts, send a prompt from one, and check the other
shows the sender's name above the bubble rather than "pilot (elsewhere)".

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "A web prompt is attributed to its session, never to what the frame claims"
```

---

### Task 8: The login page, and the Users panel

**Files:**
- Modify: `src/server.ts` (`LOGIN_HTML`, around line 622)
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `/me`, `/users`, `/users/role` (Tasks 5-6).
- Produces: nothing other code depends on.

- [ ] **Step 1: Add a username field to the login page**

In `LOGIN_HTML`, add above the password input:

```html
<input id=u placeholder="user (blank = admin)" autocomplete="username">
```

and send it with the password in the existing submit handler:
`body: JSON.stringify({ user: document.getElementById("u").value, password: p.value })`.

Leaving it blank means the admin, so the existing habit — type the password,
press Enter — still works.

- [ ] **Step 2: Add the Users panel markup**

In `public/index.html`, next to `#profilesOverlay`, add an overlay with the same
shape (`class="overlay"`, a `.sec-panel`, a `.sec-head` with a ✕):

```html
<div id="usersOverlay" class="overlay" hidden>
  <div class="sec-panel">
    <div class="sec-head">
      <strong>Users</strong>
      <button id="usersClose" title="Close">✕</button>
    </div>
    <p class="sec-note">Accounts for THIS instance. A member does everything you do; only an admin manages accounts.</p>
    <ul id="usersList"></ul>
    <form id="usersAdd">
      <input id="userName" placeholder="name" autocomplete="off" spellcheck="false">
      <select id="userRole"><option value="member">member</option><option value="admin">admin</option></select>
      <button type="submit">Invite</button>
    </form>
    <p class="sec-note" id="inviteOut" hidden></p>
  </div>
</div>
```

and a header button beside `#profilesBtn`:

```html
<button id="usersBtn" class="icon" title="Users (accounts for this instance)" hidden>👥</button>
```

- [ ] **Step 3: Wire the panel**

In the classic script, next to the Profiles panel code:

```js
  // The button only exists for an admin — and the server refuses anyway, so
  // hiding it is a courtesy, not the guard.
  let me = null;
  async function loadMe() {
    try { me = await (await fetch("/me")).json(); } catch { me = null; }
    $("usersBtn").hidden = me?.role !== "admin";
  }
  async function renderUsers() {
    const ul = $("usersList");
    ul.innerHTML = "";
    let list = [];
    try { list = await (await fetch("/users")).json(); } catch { list = []; }
    if (!Array.isArray(list) || !list.length) {
      ul.innerHTML = '<li><span style="opacity:.6">no accounts yet — only the instance password</span></li>';
      return;
    }
    for (const u of list) {
      const li = document.createElement("li");
      const who = document.createElement("b");
      who.textContent = u.name;
      const meta = document.createElement("span");
      meta.className = "pmeta";
      meta.textContent = u.role + (u.pending ? " · invitation pending" : "");
      const del = document.createElement("button");
      del.textContent = "✕";
      del.title = "Remove this account";
      del.addEventListener("click", async () => {
        if (!confirm("Remove " + u.name + "?\n\nTheir open sessions stop working immediately.")) return;
        await fetch("/users?name=" + encodeURIComponent(u.name), { method: "DELETE" });
        renderUsers();
      });
      li.append(who, meta, del);
      ul.appendChild(li);
    }
  }
  $("usersBtn").addEventListener("click", async () => { await renderUsers(); $("usersOverlay").hidden = false; });
  $("usersClose").addEventListener("click", () => { $("usersOverlay").hidden = true; });
  $("usersOverlay").addEventListener("click", (e) => { if (e.target === $("usersOverlay")) $("usersOverlay").hidden = true; });
  $("usersAdd").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("userName").value.trim();
    if (!name) return;
    const r = await fetch("/users", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, role: $("userRole").value }),
    });
    const out = await r.json();
    if (!r.ok) { alert(out.error || "failed"); return; }
    // The link is the ONLY way in: show it until it is copied, never hide it
    // behind a toast that scrolls away.
    $("inviteOut").hidden = false;
    $("inviteOut").textContent = "Invitation link for " + name + " — valid 7 days: " + location.origin + out.inviteUrl;
    $("userName").value = "";
    renderUsers();
  });
  loadMe();
```

Add `$("usersOverlay")` to the Escape handler chain, next to `#profilesOverlay`.

- [ ] **Step 4: Verify**

Run: `npm run build && npm test` — Expected: PASS.
Run the inline-script syntax check the repo already relies on:

```bash
python3 -c "
import re; s=open('public/index.html').read()
b=max(re.findall(r'<script(?![^>]*\bsrc=)(?![^>]*type=\"module\")[^>]*>(.*?)</script>', s, re.S), key=len)
open('/tmp/inline.js','w').write(b)"
node --check /tmp/inline.js
```

Expected: no output (valid).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts public/index.html
git commit -m "A username on the login page, and a Users panel for admins"
```

---

### Task 9: Documentation and end-to-end verification

**Files:**
- Modify: `CLAUDE.md` (the Architecture map table, and the HTTP endpoint list)
- Modify: `README.md` (anything user-visible: the new login field, accounts)

- [ ] **Step 1: Add the module to the map**

In `CLAUDE.md`, add a row to the Architecture map table:

```
| `src/accounts.ts` | Web accounts, PER INSTANCE (`~/.shadok-ai/users/<key>.json`, 600) — roles (`admin`/`member`), salted scrypt hashes, single-use invitations, and the signed session token. The signing secret (`<key>.key`) is per instance and **never exported into an agent's env**: the GUI password is, so signing with it would let an agent mint a cookie for anyone. `SHADOK_GUI_PASSWORD` remains the door and IS the `admin` account; with no password everything is dormant. Pure cores (`userWriteVerdict`, `signSession`/`readSession`, `inviteVerdict`) are unit-tested. |
| `src/paths.ts` | `instanceKey(cwd)` — the launch directory encoded as a filename, shared by anything stored per instance. |
```

Add to the HTTP list: `/users` (GET/POST/DELETE, admin only), `/users/role`,
`/invite/:token` (GET/POST, reachable WITHOUT a session), `/me`.

- [ ] **Step 2: Update the README**

In the section describing the password, say that the password is the `admin`
account, that an admin can invite `member` accounts from the Users panel, that
accounts are per instance, and that a prompt now carries its sender's name.

- [ ] **Step 3: Verify end to end in a browser**

Start a throwaway instance — never 3789, and never the production HOME:

```bash
HOME=/tmp/acct-e2e SHADOK_GUI_PASSWORD=secret PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js &
```

Then, with Playwright (`/root/.shadok-ai/tools/node_modules/playwright`):

1. open `/`, confirm the login page shows a user field and a password field;
2. log in with the password alone → the cockpit loads, `/me` says
   `{"name":"admin","role":"admin"}`, the 👥 button is visible;
3. invite `bob` as `member`, copy the link from the panel;
4. in a second browser context, open the link, set a password, log in as bob;
5. `/me` says `{"name":"bob","role":"member"}` and the 👥 button is hidden;
6. bob sends a prompt on a shared agent; in the admin's tab the bubble is
   labelled `bob`;
7. `curl -b "<bob cookie>" localhost:3899/users` → 403;
8. as admin, delete bob; bob's next request 401s.

Record the result of each numbered step. Stop the instance and remove
`/tmp/acct-e2e` afterwards.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "Document web accounts"
```

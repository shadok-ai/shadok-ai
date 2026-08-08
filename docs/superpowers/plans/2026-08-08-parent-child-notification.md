# Parent→child notification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A parent agent is told when an agent it launched finishes, blocks on a question, or dies — and nothing else wakes it.

**Architecture:** A `parent` field on `Channel` (server-owned, persisted) records the link. A new pure module `src/kinship.ts` owns link validation, child lookup and notification-text building; `src/server.ts` wires it to the two existing funnels (`finishTurn` and `publishDialog`) and delivers through the same `driveChannel` the crons already use. A per-channel queue holds notifications while the parent is mid-turn.

**Tech Stack:** TypeScript, ESM, Node 20 (`.js` extensions in imports, NodeNext). Tests: `node --test` + `tsx`, run with `npm test`. No new dependencies.

## Global Constraints

- **Everything written into the repo is in English** — comments, identifiers, commit messages, test names, log and error strings. (User-facing UI copy and chat replies follow the user's language.)
- Comments explain **why**, not what.
- `.js` extensions in all relative imports (NodeNext).
- Pure logic goes in its own module with a twin test file; `src/server.ts` only wires. It is already 2244 lines — do not grow it more than the wiring requires.
- Cite **symbols**, not line numbers, in any comment or doc you write.
- After any change with runtime surface: `npm run build`, then verify **on a free port side by side** — never take over 3789 (invariant 8): `PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js`.
- Never restart the running server; never `git merge` in the shared checkout (invariant 9).
- Full reference: `docs/superpowers/specs/2026-08-08-parent-child-notification-design.md`.

---

### Task 1: The pure kinship core

**Files:**
- Create: `src/kinship.ts`
- Create: `test/kinship.test.ts`

**Interfaces:**
- Consumes: `Channel` from `src/channels.js` (Task 2 adds `parent` to it; write Task 1 against the field and let `tsc` fail until Task 2 lands, or do Task 2 first — either order works, but both must be green before Task 3).
- Produces: `MAX_LINK_DEPTH`, `MAX_FANOUT`, `LinkRefusal`, `linkRefusal(channels, child, parent)`, `chainDepth(channels, sessionId)`, `childrenOf(channels, sessionId)`, `AGENT_PROMPT_MARK`, `markAgentPrompt(text)`, `isAgentPrompt(text)`.

- [ ] **Step 1: Write the failing test**

Create `test/kinship.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PROMPT_MARK,
  MAX_FANOUT,
  MAX_LINK_DEPTH,
  chainDepth,
  childrenOf,
  isAgentPrompt,
  linkRefusal,
  markAgentPrompt,
} from "../src/kinship.js";
import type { Channel } from "../src/channels.js";

/** Minimal channels: only the two fields kinship reads. */
function ch(sessionId: string, parent?: string | null): Channel {
  return { sessionId, cwd: "/tmp", ...(parent !== undefined ? { parent } : {}) };
}

test("linkRefusal: detaching is always allowed", () => {
  assert.equal(linkRefusal([ch("a")], "a", null), null);
});

test("linkRefusal: a plain link is allowed", () => {
  assert.equal(linkRefusal([ch("boss"), ch("kid")], "kid", "boss"), null);
});

test("linkRefusal: refuses self, unknown parent and a direct cycle", () => {
  const list = [ch("boss"), ch("kid", "boss")];
  assert.equal(linkRefusal(list, "a", "a"), "self");
  assert.equal(linkRefusal(list, "kid", "ghost"), "unknown-parent");
  // boss under its own child would loop notifications forever
  assert.equal(linkRefusal(list, "boss", "kid"), "cycle");
});

test("linkRefusal: refuses an indirect cycle", () => {
  const list = [ch("a"), ch("b", "a"), ch("c", "b")];
  assert.equal(linkRefusal(list, "a", "c"), "cycle");
});

test("linkRefusal: refuses a chain deeper than the cap", () => {
  // root → n0 → n1 → … : build a chain exactly at the cap, then push past it.
  const list: Channel[] = [ch("root")];
  let prev = "root";
  for (let i = 0; i < MAX_LINK_DEPTH; i++) {
    list.push(ch(`n${i}`, prev));
    prev = `n${i}`;
  }
  list.push(ch("newcomer"));
  assert.equal(linkRefusal(list, "newcomer", prev), "too-deep");
  // ...while attaching near the root is still fine
  assert.equal(linkRefusal(list, "newcomer", "root"), null);
});

test("linkRefusal: refuses a fan-out past the cap, but re-parenting an existing child is fine", () => {
  const list: Channel[] = [ch("boss")];
  for (let i = 0; i < MAX_FANOUT; i++) list.push(ch(`kid${i}`, "boss"));
  list.push(ch("extra"));
  assert.equal(linkRefusal(list, "extra", "boss"), "too-many-children");
  // kid0 already counts as one of boss's children — re-asserting must not
  // count it twice and refuse a no-op.
  assert.equal(linkRefusal(list, "kid0", "boss"), null);
});

test("linkRefusal: survives a pre-existing loop in stored data", () => {
  // Corrupt store (hand-edited JSON): a↔b. Reading it must terminate.
  const list = [ch("a", "b"), ch("b", "a"), ch("fresh")];
  assert.equal(linkRefusal(list, "fresh", "a"), "cycle");
});

test("chainDepth counts ancestors, not nodes", () => {
  const list = [ch("a"), ch("b", "a"), ch("c", "b")];
  assert.equal(chainDepth(list, "a"), 0);
  assert.equal(chainDepth(list, "b"), 1);
  assert.equal(chainDepth(list, "c"), 2);
  assert.equal(chainDepth(list, "ghost"), 0);
});

test("childrenOf returns only direct children", () => {
  const list = [ch("a"), ch("b", "a"), ch("c", "b"), ch("d", "a")];
  assert.deepEqual(childrenOf(list, "a").map((c) => c.sessionId), ["b", "d"]);
  assert.deepEqual(childrenOf(list, "c").map((c) => c.sessionId), []);
});

test("markAgentPrompt is idempotent and detectable", () => {
  const once = markAgentPrompt("agent kid finished");
  assert.ok(once.startsWith(AGENT_PROMPT_MARK));
  assert.equal(markAgentPrompt(once), once);
  assert.ok(isAgentPrompt(once));
  assert.ok(isAgentPrompt(`  \n${once}`));
  assert.equal(isAgentPrompt("a human typed this"), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="linkRefusal|chainDepth|childrenOf|markAgentPrompt"`
Expected: FAIL — `Cannot find module '../src/kinship.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/kinship.ts`:

```ts
import type { Channel } from "./channels.js";

/**
 * Kinship between channels: which agent launched which, and what a parent is
 * told about its children. Pure and dependency-free so it can be unit-tested
 * without a server — the same reason `crons.ts` keeps its logic out of the hub.
 */

/**
 * How deep a parent chain may go. A notification can trigger a spawn which
 * triggers another notification: without a ceiling that is a cascade that
 * empties the subscription overnight. The pace guard blocks one prompt at a
 * time; it does not bound a chain.
 */
export const MAX_LINK_DEPTH = 4;

/** How many children one parent may hold, for the same reason. */
export const MAX_FANOUT = 12;

export type LinkRefusal =
  | "self"
  | "cycle"
  | "unknown-parent"
  | "too-deep"
  | "too-many-children";

/** How many ancestors `sessionId` has (0 for a root, or for an unknown id). */
export function chainDepth(channels: readonly Channel[], sessionId: string): number {
  const byId = new Map(channels.map((c) => [c.sessionId, c]));
  const seen = new Set<string>();
  let depth = 0;
  let cur: string | null = sessionId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    cur = byId.get(cur)?.parent ?? null;
    if (cur) depth++;
  }
  return depth;
}

/** The channels whose parent is `sessionId` (direct children only). */
export function childrenOf(channels: readonly Channel[], sessionId: string): Channel[] {
  return channels.filter((c) => c.parent === sessionId);
}

/**
 * Why linking `child` under `parent` must be refused, or null if it is allowed.
 * `parent === null` detaches and is always allowed.
 *
 * Every refusal is EXPLICIT. An unknown parent is a refusal, not a field we
 * quietly drop — the lesson `resolveCronId` already carries (invariant 17),
 * where a delete answered `{ok:true}` while deleting nothing.
 */
export function linkRefusal(
  channels: readonly Channel[],
  child: string,
  parent: string | null,
): LinkRefusal | null {
  if (parent === null) return null;
  if (parent === child) return "self";

  const byId = new Map(channels.map((c) => [c.sessionId, c]));
  if (!byId.has(parent)) return "unknown-parent";

  // Walk up from the proposed parent: reaching the child closes a loop, and a
  // loop means the two would notify each other forever. `seen` also makes this
  // terminate on a store that is ALREADY looped (hand-edited JSON) instead of
  // spinning.
  const seen = new Set<string>();
  let cur: string | null = parent;
  while (cur && !seen.has(cur)) {
    if (cur === child) return "cycle";
    seen.add(cur);
    cur = byId.get(cur)?.parent ?? null;
  }
  if (cur) return "cycle"; // stopped because we re-entered a pre-existing loop

  if (chainDepth(channels, parent) + 1 >= MAX_LINK_DEPTH) return "too-deep";

  // Re-asserting an existing child must not count it twice and refuse a no-op.
  const siblings = childrenOf(channels, parent).filter((c) => c.sessionId !== child);
  if (siblings.length >= MAX_FANOUT) return "too-many-children";

  return null;
}

/**
 * Prefix carried by a notification prompt. It reaches the transcript as an
 * ordinary user message, so without a marker it reads as something the human
 * typed — and comes back on every web reload and Telegram backfill, which is
 * exactly the bug `CRON_PROMPT_MARK` exists to prevent. Twin of that one.
 */
export const AGENT_PROMPT_MARK = "🤖 [agent]";

export function markAgentPrompt(text: string): string {
  return isAgentPrompt(text) ? text : `${AGENT_PROMPT_MARK} ${text}`;
}

export function isAgentPrompt(text: string): boolean {
  return typeof text === "string" && text.trimStart().startsWith(AGENT_PROMPT_MARK);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all kinship tests PASS. `tsc` may still complain that `parent` is not on `Channel` — Task 2 adds it. If you are doing Task 1 first, that error is expected and only that error.

- [ ] **Step 5: Commit**

```bash
git add src/kinship.ts test/kinship.test.ts
git commit -m "feat: pure kinship core — link validation, children, prompt mark"
```

---

### Task 2: The `parent` field, and the only path that writes it

**Files:**
- Modify: `src/channels.ts` (the `Channel` interface and `SERVER_OWNED`)
- Modify: `src/server.ts` (the `ClientMessage` union and a new `set-parent` case, next to `set-profile`)
- Modify: `test/channels.test.ts`

**Interfaces:**
- Consumes: `linkRefusal` from `src/kinship.js` (Task 1).
- Produces: `Channel.parent`; the WS message `{type:"set-parent", parent: string | null}`; the server→client message `{type:"parent", parent: string | null}`.

- [ ] **Step 1: Write the failing test**

Append to `test/channels.test.ts`:

```ts
test("mergeChannels: parent is server-owned — a stale client cannot rewrite it", () => {
  const stored = [{ sessionId: "kid", cwd: "/w", parent: "boss" }];
  // The browser echoes back a channel with no parent (or a wrong one).
  const fromClient = [{ sessionId: "kid", cwd: "/w", parent: "someone-else" }];
  const merged = mergeChannels(stored, fromClient, new Set(["kid"]));
  assert.equal(merged[0].parent, "boss");
});

test("mergeChannels: a brand-new channel keeps the parent it was created with", () => {
  // Nothing stored for this id yet, so SERVER_OWNED cannot protect it — the
  // server asserts it at `ready` instead (same shape as `repo`, invariant 20).
  const merged = mergeChannels([], [{ sessionId: "kid", cwd: "/w", parent: "boss" }], new Set(["kid"]));
  assert.equal(merged[0].parent, "boss");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="server-owned|created with"`
Expected: FAIL — `parent` is not a property of `Channel`.

- [ ] **Step 3: Add the field**

In `src/channels.ts`, inside `interface Channel`, after `profile`:

```ts
  /** The channel that spawned this one, or one attached to it by hand. Only
   *  this channel's parent hears about it — without that scoping a chatty
   *  Telegram channel would wake a boss on every turn. The CHILD stores its
   *  parent and never the reverse, so there is one writer per fact and the two
   *  directions cannot disagree. */
  parent?: string | null;
```

And extend `SERVER_OWNED` in the same file:

```ts
const SERVER_OWNED = ["cwd", "branch", "repo", "telegram", "profile", "parent"] as const;
```

- [ ] **Step 4: Add the `set-parent` message**

In `src/server.ts`, in the `ClientMessage` union, next to `set-profile`:

```ts
  /** Attach this channel under another (or detach with null). `parent` is
   *  SERVER_OWNED, so a browser PUT /channels cannot touch it — this is the
   *  only legitimate path, exactly like `set-profile`. */
  | { type: "set-parent"; parent: string | null }
```

Then, immediately after the `case "set-profile"` block:

```ts
        case "set-parent": {
          if (!session) return fail("no session started");
          const s = session;
          const wanted = msg.parent ?? null;
          const refusal = linkRefusal(loadChannels(), s.id, wanted);
          // Refuse out loud. Silently dropping the link would leave the parent
          // believing it will be notified, and waiting forever for a child it
          // is not linked to.
          if (refusal) return fail(`cannot attach: ${refusal}`, "link-refused");
          upsertChannel({ sessionId: s.id, parent: wanted });
          broadcast(s, { type: "parent", parent: wanted });
          break;
        }
```

Add the import at the top of `src/server.ts`:

```ts
import { linkRefusal, childrenOf, markAgentPrompt } from "./kinship.js";
```

(`childrenOf` and `markAgentPrompt` are used from Task 5 onward; importing them now keeps the diff in one place.)

- [ ] **Step 5: Run the tests and the build**

Run: `npm test && npm run build`
Expected: PASS, and `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add src/channels.ts src/server.ts test/channels.test.ts
git commit -m "feat: a channel records its parent, and set-parent is the only way to write it"
```

---

### Task 3: pilotctl links a child at spawn

**Files:**
- Modify: `.claude/skills/shadok-ai-agents/pilotctl.mjs` (`cmdSpawn`)
- Modify: `.claude/skills/shadok-ai-agents/test/spawn.test.mjs`
- Modify: `.claude/skills/shadok-ai-agents/SKILL.md`

**Interfaces:**
- Consumes: the `start` message's new `parent` field (Task 2).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

Append to `.claude/skills/shadok-ai-agents/test/spawn.test.mjs`, following the file's existing style:

```js
test("spawn carries the spawner's own session id as parent", () => {
  const startMsg = buildStartMsg({ worktree: true }, { SHADOK_SESSION_ID: "boss-id" });
  assert.equal(startMsg.parent, "boss-id");
});

test("spawn omits parent when the spawner has no session id (CLI, a human shell)", () => {
  const startMsg = buildStartMsg({ worktree: true }, {});
  assert.equal("parent" in startMsg, false);
});

test("an explicit --parent wins over the ambient session id", () => {
  const startMsg = buildStartMsg({ parent: "chosen" }, { SHADOK_SESSION_ID: "boss-id" });
  assert.equal(startMsg.parent, "chosen");
});

test("--parent none detaches instead of linking", () => {
  const startMsg = buildStartMsg({ parent: "none" }, { SHADOK_SESSION_ID: "boss-id" });
  assert.equal(startMsg.parent, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="parent"`
Expected: FAIL — `buildStartMsg` is not exported.

- [ ] **Step 3: Extract the pure builder and use it**

In `pilotctl.mjs`, add near the other helpers:

```js
/**
 * The `start` payload for a spawn. Pure, so the parent-linking rule is testable
 * without a server.
 *
 * `SHADOK_SESSION_ID` is set by the server on every piloted session, so an
 * agent that spawns another is identified with no extra plumbing and nothing to
 * configure. A human shell has no such variable and therefore creates a root.
 */
export function buildStartMsg(flags, env = process.env) {
  const msg = {};
  if (flags.cwd) msg.cwd = flags.cwd;
  if (flags.worktree) msg.worktree = true;
  if (flags.resume) msg.resume = flags.resume;
  if (flags.continue) msg.continue = true;
  if (flags.profile) msg.profile = flags.profile;
  // "none" is the explicit escape hatch: spawn something deliberately unlinked.
  if (flags.parent === "none") msg.parent = null;
  else if (flags.parent) msg.parent = flags.parent;
  else if (env.SHADOK_SESSION_ID) msg.parent = env.SHADOK_SESSION_ID;
  return msg;
}
```

Replace the body of `cmdSpawn` that assembles `startMsg` with:

```js
  const startMsg = buildStartMsg(flags);
```

Add `--parent` to the value-taking flags in `parseArgs`, next to `--profile`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Document it in the skill**

In `.claude/skills/shadok-ai-agents/SKILL.md`, in the `spawn` section, add:

```markdown
An agent that spawns another is recorded as its **parent**, automatically — you
will be told when that child finishes, blocks on a question, or dies. You are
told about **your own** children and nothing else. Pass `--parent none` to spawn
something deliberately unlinked, or `--parent <sessionId>` to attach it
elsewhere.
```

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/shadok-ai-agents/
git commit -m "feat: pilotctl records the spawner as the child's parent"
```

---

### Task 4: The notification text

**Files:**
- Modify: `src/kinship.ts`
- Modify: `test/kinship.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ChildReport`, `notificationText(report, port)`.

- [ ] **Step 1: Write the failing test**

Append to `test/kinship.test.ts`:

```ts
import { notificationText, type ChildReport } from "../src/kinship.js";

const base: ChildReport = { name: "auth-fix", sessionId: "abcd1234", kind: "done" };

test("notificationText: a finished child carries its own summary and pointers", () => {
  const t = notificationText({ ...base, summary: "Fixed the login bug.", branch: "shadok-ai/abcd1234" }, 3789);
  assert.match(t, /auth-fix/);
  assert.match(t, /Fixed the login bug\./);
  assert.match(t, /abcd1234/);
  assert.match(t, /shadok-ai\/abcd1234/);
  // Pointers, never the payload: the parent fetches the diff only if it needs it.
  assert.match(t, /\/diff\?session=abcd1234/);
});

test("notificationText: a pending question lists its options and how to answer", () => {
  const t = notificationText(
    { ...base, kind: "dialog", question: "Allow rm -rf?", options: ["Yes", "No"] },
    3789,
  );
  assert.match(t, /Allow rm -rf\?/);
  assert.match(t, /1\. Yes/);
  assert.match(t, /2\. No/);
  assert.match(t, /pilotctl choose abcd1234/);
});

test("notificationText: a death is announced as such, not as a completion", () => {
  const t = notificationText({ ...base, kind: "exited" }, 3789);
  assert.match(t, /stopped before finishing/i);
  // A failure that says nothing is indistinguishable from a run with nothing
  // to say (invariant 15) — so it must still reach the parent.
  assert.match(t, /abcd1234/);
});

test("notificationText: no summary still produces a usable message", () => {
  const t = notificationText(base, 3789);
  assert.match(t, /auth-fix/);
  assert.match(t, /abcd1234/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="notificationText"`
Expected: FAIL — `notificationText` is not exported.

- [ ] **Step 3: Implement**

Append to `src/kinship.ts`:

```ts
/** What happened to a child, as the parent will be told it. */
export interface ChildReport {
  /** The child channel's display name, or its short id when unnamed. */
  name: string;
  sessionId: string;
  kind: "done" | "dialog" | "exited" | "timeout";
  /** The child's own last assistant text block — what it wrote to be read. */
  summary?: string;
  /** kind === "dialog": the pending question and its options. */
  question?: string;
  options?: string[];
  branch?: string | null;
}

const HEADLINE: Record<ChildReport["kind"], (name: string) => string> = {
  done: (n) => `Agent "${n}" finished its turn.`,
  dialog: (n) => `Agent "${n}" is waiting on a question.`,
  exited: (n) => `Agent "${n}" stopped before finishing.`,
  timeout: (n) => `Agent "${n}" hit the delivery timeout.`,
};

/**
 * The prompt a parent receives about one child.
 *
 * Deliberately small: the parent is almost always the LARGEST session in the
 * tree, so it is the worst place to pour volume into — this repo's transcripts
 * measure ~359k tokens of prefix re-read per call, i.e. ~36k effective per
 * wake. So this carries the child's own summary plus POINTERS, and never the
 * diff; the parent fetches that if it decides it needs one.
 */
export function notificationText(r: ChildReport, port: number): string {
  const lines = [HEADLINE[r.kind](r.name)];

  if (r.kind === "dialog" && r.question) {
    lines.push("", `Question: ${r.question}`);
    if (r.options?.length) lines.push(...r.options.map((o, i) => `  ${i + 1}. ${o}`));
    lines.push("", `Answer with \`pilotctl choose ${r.sessionId} <n>\`, or leave it for the human.`);
  } else if (r.summary?.trim()) {
    lines.push("", r.summary.trim());
  }

  const pointers = [`session \`${r.sessionId}\``];
  if (r.branch) pointers.push(`branch \`${r.branch}\``);
  pointers.push(`diff: http://127.0.0.1:${port}/diff?session=${r.sessionId}`);
  lines.push("", pointers.join(" · "));

  return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/kinship.ts test/kinship.test.ts
git commit -m "feat: build the notification a parent receives about one child"
```

---

### Task 5: Deliver on turn end and on death, with a queue

**Files:**
- Modify: `src/server.ts` (`finishTurn`, the `exited` path, a new `notifyParent` + queue)
- Modify: `src/extract.ts` (filter the new mark out of history)
- Modify: `test/extract.test.ts`

**Interfaces:**
- Consumes: `childrenOf`, `markAgentPrompt`, `isAgentPrompt`, `notificationText`, `ChildReport` (Tasks 1 & 4); `driveChannel`, `resolveCronTarget`, `isNothingToShow` (existing).
- Produces: `notifyParent(child: Live, report: Omit<ChildReport,"name"|"sessionId">): void` and the per-channel queue, both used by Task 6.

- [ ] **Step 1: Write the failing test**

Append to `test/extract.test.ts`:

```ts
test("loadHistory drops an agent notification, like a cron prompt", () => {
  // It reaches the transcript as an ordinary user message; without this filter
  // it reads as something the human typed and comes back on every reload.
  assert.equal(isAgentPrompt("🤖 [agent] Agent \"kid\" finished its turn."), true);
  assert.equal(isAgentPrompt("please review the diff"), false);
});
```

Add the import at the top of `test/extract.test.ts`:

```ts
import { isAgentPrompt } from "../src/kinship.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="agent notification"`
Expected: FAIL — no such export used by `extract.ts` yet.

- [ ] **Step 3: Filter the mark out of history**

In `src/extract.ts`, extend the existing cron filter:

```ts
import { isCronPrompt } from "./crons.js";
import { isAgentPrompt } from "./kinship.js";
```

and where it currently reads `if (isCronPrompt(text)) continue;`:

```ts
      // A cron's prompt and a parent notification are both machine-written
      // user messages. Showing them replays noise on every reload and backfill.
      if (isCronPrompt(text) || isAgentPrompt(text)) continue;
```

- [ ] **Step 4: Add the queue and the deliverer**

In `src/server.ts`, near the cron driving helpers:

```ts
/**
 * Notifications waiting for a parent that is mid-turn, keyed by the PARENT's
 * session id. A prompt sent during a turn is refused (`code:"busy"`), so
 * without this a child finishing while its parent thinks would simply be lost.
 *
 * This is also where batching comes from, for free: a parent is busy precisely
 * when it is working, so several children coalesce on their own — no timer, no
 * window.
 */
const parentInbox = new Map<string, string[]>();

/** A child's display name for the parent, falling back to a short id. */
function childLabel(childId: string): string {
  const ch = loadChannels().find((c) => c.sessionId === childId);
  return ch?.name?.trim() || childId.slice(0, 8);
}

/** Tell a child's parent what just happened to it. No parent → nobody is woken. */
function notifyParent(child: Live, report: Omit<ChildReport, "name" | "sessionId">): void {
  const channels = loadChannels();
  const me = channels.find((c) => c.sessionId === child.id);
  const parentId = me?.parent ?? null;
  if (!parentId) return; // a root agent notifies nobody — that is the scoping rule
  if (!channels.some((c) => c.sessionId === parentId)) return; // parent is gone

  const text = markAgentPrompt(
    notificationText(
      {
        ...report,
        name: childLabel(child.id),
        sessionId: child.id,
        branch: child.worktree?.branch ?? me?.branch ?? null,
      },
      boundPort,
    ),
  );

  const parent = sessions.get(parentId);
  if (parent?.busy) {
    const queued = parentInbox.get(parentId) ?? [];
    queued.push(text);
    parentInbox.set(parentId, queued);
    console.log(`agent: ${child.id.slice(0, 8)} → ${parentId.slice(0, 8)} queued (parent busy)`);
    return;
  }
  deliverToParent(parentId, text);
}

/** Send one (or a coalesced batch) to a parent, over the same path crons use. */
function deliverToParent(parentId: string, text: string): void {
  const target = resolveCronTarget(loadChannels(), parentId, process.cwd());
  // Fire and forget: the parent's turn is its own business, and awaiting here
  // would hold the child's finishTurn open for as long as the parent thinks.
  void driveChannel(parentId, text, target).then((res) => {
    const tag = `agent: → ${parentId.slice(0, 8)}`;
    console.log(res.ok ? `${tag} delivered` : `${tag} failed (${res.reason})`);
  });
}

/** Flush anything queued for a parent that has just gone idle. */
function flushParentInbox(parentId: string): void {
  const queued = parentInbox.get(parentId);
  if (!queued?.length) return;
  parentInbox.delete(parentId);
  // One wake for the batch: N separate wakes would re-pay the parent's whole
  // prefix N times for the same information.
  deliverToParent(parentId, queued.join("\n\n---\n\n"));
}
```

Add to the imports at the top of `src/server.ts`:

```ts
import { notificationText, type ChildReport } from "./kinship.js";
```

- [ ] **Step 5: Hook it to the two existing events**

In `finishTurn`, where `turn-done` is broadcast, immediately after that line:

```ts
      broadcast(s, { type: "turn-done", sessionId: s.id });
      maybeScheduleRetry(s);
      notifyParent(s, { kind: "done", summary: s.recentTexts[s.recentTexts.length - 1] });
      flushParentInbox(s.id); // this session may itself be a parent that was busy
```

And where `exited` is broadcast, immediately after that line:

```ts
    broadcast(s, { type: "exited", code });
    // A failure must notify too: a lost run that says nothing is
    // indistinguishable from a run with nothing to say (invariant 15), and the
    // parent would wait forever.
    notifyParent(s, { kind: "exited" });
```

- [ ] **Step 6: Suppress the empty notification**

Inside `notifyParent`, right after computing `report`, before building the text — a child whose whole answer is the silence placeholder wakes nobody:

```ts
  if (report.kind === "done" && report.summary && isNothingToShow(report.summary)) return;
```

`isNothingToShow` is **not** currently imported by `src/server.ts` — add it to the existing import from `./tail.js`.

- [ ] **Step 7: Run the tests and the build**

Run: `npm test && npm run build`
Expected: PASS, `tsc` clean.

- [ ] **Step 8: Verify by hand, on a free port**

```bash
npm run build
PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js
```

Confirm the startup output has **no `telegram:` line** (a worktree launch dir has no token — that is what lets it coexist with 3789), and that `curl -s localhost:3899/version` reports the local `0.1.0`. Then, from another shell, spawn a child under a parent through `pilotctl` and confirm one `agent: … delivered` line appears. Check `curl -s -o /dev/null -w '%{http_code}' localhost:3789/` still answers `200`. Stop your instance when done.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts src/extract.ts test/extract.test.ts
git commit -m "feat: a parent is notified when its child's turn ends or its process dies"
```

---

### Task 6: Pending questions reach the parent, gated by profile

**Files:**
- Modify: `src/server.ts` (`publishDialog`)
- Modify: `src/profiles.ts` (a `canAnswerChildren` capability)
- Modify: `test/profiles.test.ts`

**Interfaces:**
- Consumes: `notifyParent` (Task 5).
- Produces: `Profile.canAnswerChildren?: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `test/profiles.test.ts`:

```ts
test("Shadok-Boss may answer its children's questions; the read-only roles may not", () => {
  const boss = DEFAULT_PROFILES.find((p) => p.name === "Shadok-Boss");
  assert.equal(boss?.canAnswerChildren, true);
  // Marketing and Support delegate nothing, so the capability is meaningless
  // for them — and an ambient right would let a read-only profile authorise a
  // child to do what it cannot do itself.
  for (const name of ["Shadok-Marketing", "Shadok-Support"]) {
    assert.notEqual(DEFAULT_PROFILES.find((p) => p.name === name)?.canAnswerChildren, true);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="children's questions"`
Expected: FAIL — `canAnswerChildren` is not a property of `Profile`.

- [ ] **Step 3: Add the capability**

In `src/profiles.ts`, in `interface Profile`:

```ts
  /** May this agent answer a dialog pending on one of ITS OWN children?
   *  Deliberately opt-in: answering a child's permission prompt lets a
   *  READONLY_DENY agent authorise a child to do what it cannot do itself, so
   *  the guardrail that makes delegation mandatory would otherwise be
   *  bypassable BY delegating. */
  canAnswerChildren?: boolean;
```

And on the `Shadok-Boss` entry of `DEFAULT_PROFILES`, add `canAnswerChildren: true`.

- [ ] **Step 4: Notify on a pending dialog**

In `src/server.ts`, inside `publishDialog`, after the existing broadcast to clients:

```ts
  // A child blocked on a question is the deadlock this whole feature exists to
  // break: its turn is suspended, and without this the parent believes it is
  // still working. `publishDialog` is the single funnel for dialogs (invariant
  // 23), so hooking here covers every path — including raw `key` input.
  notifyParent(s, { kind: "dialog", question: d.question, options: d.options.map((o) => o.label) });
```

- [ ] **Step 5: Run the tests and the build**

Run: `npm test && npm run build`
Expected: PASS, `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/profiles.ts test/profiles.test.ts
git commit -m "feat: a child's pending question reaches its parent, gated by profile"
```

---

### Task 7: Attach an existing channel from the UI

**Files:**
- Modify: `public/index.html` (the channel tab ⋯ menu, and the `parent` message handler)

**Interfaces:**
- Consumes: `{type:"set-parent"}` and `{type:"parent"}` (Task 2).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Handle the server's `parent` message**

In `public/index.html`, the incoming messages are handled by a `switch (msg.type)`. Add a case next to `case "profile":`, following that case's own style for updating the tab and repainting:

```js
      case "parent":
        tab.parent = msg.parent;
        refreshChrome();
        break;
```

- [ ] **Step 2: Add the menu entry**

In the channel ⋯ menu builder, next to the profile entry. Note the two local conventions: the client sends on the tab's own socket — the existing call is `tab.ws.send(JSON.stringify({ type: "set-profile", … }))` — and `active` **can be null** (invariant 18), so anything reading the current channel must be guarded.

```js
  // "Attach to…": the manual half of the parent link. The automatic half
  // happens at spawn and needs no UI at all.
  const attach = document.createElement("button");
  attach.textContent = tab.parent ? "Detach from parent" : "Attach to…";
  attach.addEventListener("click", () => {          // never onclick=: the CSP
    menu.remove();                                   // nonce does not cover it
    if (tab.parent) {
      tab.ws.send(JSON.stringify({ type: "set-parent", parent: null }));
      return;
    }
    const others = channels.filter((c) => c.sessionId !== tab.sessionId);
    if (!others.length) return;
    const pick = prompt(
      "Attach to which agent?\n" +
        others.map((c, i) => `${i + 1}. ${c.name || c.sessionId.slice(0, 8)}`).join("\n"),
    );
    const n = Number(pick);
    if (!Number.isInteger(n) || n < 1 || n > others.length) return;
    tab.ws.send(JSON.stringify({ type: "set-parent", parent: others[n - 1].sessionId }));
  });
  menu.appendChild(attach);
```

Match the surrounding code's variable name for the channel object (the menu builder's own parameter) rather than pasting `tab` blindly — the point is `<channel>.ws.send(JSON.stringify(…))`, not the identifier.

- [ ] **Step 3: Surface a refusal**

The server answers a bad link with `{type:"error", code:"link-refused", message}`. Confirm the existing `error` handler shows `msg.message` to the user; if it filters on known codes, add `link-refused` so a refused attach is visible rather than silent.

- [ ] **Step 4: Verify in the browser**

```bash
npm run build
PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js
```

Open `http://localhost:3899`, create two agents, attach one to the other from the ⋯ menu, reload the page and confirm the link survived. Then try attaching the parent to its own child and confirm the refusal is **visible**. Capture the browser console: a CSP violation or a failed module import is silent in the DOM (invariants 10 and 12). Check `localhost:3789` still answers `200`, and stop your instance.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: attach or detach a channel's parent from the tab menu"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

This task is **mandatory before opening the PR**: docs ship with the change that makes them wrong, in the same PR (see "Keeping the docs honest" in the README).

- [ ] **Step 1: README — the user-visible surface**

In "What you get", after the scheduled-prompts bullet:

```markdown
- **Agents that report back** — an agent that launches other agents is told when
  each one finishes, blocks on a question, or dies. It hears about **its own**
  children and nothing else, so a busy channel never wakes it. What it receives
  is the child's own summary plus pointers (branch, diff link) — never the diff
  itself, which would cost more than it is worth on a large session.
```

In the WS protocol table, client → server:

```markdown
| `{type:"set-parent", parent}` | attach this channel under another (`null` detaches). Refused explicitly on a cycle, an unknown parent, or a chain/fan-out past its cap |
```

server → client:

```markdown
| `{type:"parent", parent}` | the channel's parent changed |
```

- [ ] **Step 2: CLAUDE.md — the module map**

Add a row to the architecture map, after `src/crons.ts`:

```markdown
| `src/kinship.ts` | Who launched whom, and what a parent is told. `linkRefusal` (self / cycle / unknown parent / depth / fan-out — every refusal EXPLICIT), `chainDepth`, `childrenOf`, `notificationText` (the child's summary + pointers, never the diff), and `AGENT_PROMPT_MARK` — the twin of `CRON_PROMPT_MARK`, since a notification also reaches the transcript as a user message. Pure, tested. |
```

- [ ] **Step 3: architecture.md — the subsystem**

Add a section after "Scheduled prompts":

```markdown
## Parent and child agents (`src/kinship.ts`)

An agent that spawns another is recorded as its **parent** (`Channel.parent`,
server-owned and persisted, so the tree survives the auto-update restart that
would otherwise orphan every child). The child stores its parent and never the
reverse: one writer per fact, and the two directions cannot disagree.

The link is set automatically at spawn — `pilotctl` reads `SHADOK_SESSION_ID`,
which the server already sets on every piloted session — or by hand through
`set-parent`, the only path that may write a server-owned field.

**Scoping is the point.** A parent hears about its own children and nothing
else; without that, a chatty Telegram channel would wake a boss on every turn,
and a wake in a large session costs real money (~36k effective tokens on this
repo's measured transcripts).

Delivery reuses `driveChannel`, the same function crons use, so a child's
completion is indistinguishable from a cron firing, which is indistinguishable
from a human typing. Two hooks suffice: `finishTurn` for a completed turn and
`publishDialog` for a pending question — the latter being a single funnel only
since invariant 23 moved dialog detection into the screen watcher. A death
notifies too, because a failure that says nothing is indistinguishable from a
run with nothing to say (invariant 15).

`parentInbox` holds notifications for a parent that is mid-turn, since a prompt
sent during a turn is refused with `code:"busy"`. It doubles as free batching:
a parent is busy precisely when it is working, so several children coalesce with
no timer.

**Two bounds and one caveat.** `MAX_LINK_DEPTH` and `MAX_FANOUT` stop a
notification→spawn→notification cascade, which the pace guard cannot bound (it
blocks one prompt at a time, not a chain). And answering a child's dialog is a
**profile capability** (`canAnswerChildren`), not an ambient right: a
`READONLY_DENY` boss could otherwise authorise a child to do what it is itself
forbidden from doing, making the guardrail bypassable by delegation.

Known cost: the parent's context grows with every notification and it re-pays
that prefix on every wake. The mitigation is the deferred agent-fork idea.
```

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md docs/architecture.md
git commit -m "docs: parent/child agent notification"
```

---

## Self-Review

**Spec coverage.** §1 data → Task 2. §2 both link paths → Tasks 2 (manual) and 3 (spawn). §3 cycle guard → Task 1. §4 triggers (turn-done, dialog, death) → Tasks 5 and 6. §5 payload, `isNothingToShow`, the `CRON_PROMPT_MARK` twin → Tasks 4 and 5. §6 busy queue → Task 5. §7 bounds → Task 1; escalation caveat → Task 6. Success criteria 1–8 are covered; criterion 9 (build + free-port verification) appears in Tasks 5 and 7.

**Placeholders.** None: every code step carries the actual code, every test step the actual assertions.

**Type consistency.** `ChildReport` is defined in Task 4 and consumed in Task 5 with the same field names (`name`, `sessionId`, `kind`, `summary`, `question`, `options`, `branch`). `linkRefusal` returns `LinkRefusal | null` in Task 1 and is used as a truthy check in Task 2. `notifyParent` takes `Omit<ChildReport, "name" | "sessionId">` in Task 5 and is called that way in Task 6.

**Known ordering note.** Tasks 1 and 2 are mutually referential: Task 1's tests use `Channel.parent`, which Task 2 adds. Either order works; both must be green before Task 3. This is called out in Task 1's Interfaces block.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = fs.readFileSync(path.join(HERE, "..", "public", "index.html"), "utf8");

/**
 * A periodic poll must be unable to accumulate (invariant 69).
 *
 * Two kinds of test live here, both reading `public/index.html` back — the
 * client is one hand-written file with no build step, so that is the only way
 * to lock anything in it (cf. `test/ws-url.test.ts`, `test/csp.test.ts`).
 *
 * 1. The guard's LOGIC. `makePollFetch` is lifted out of the page between its
 *    two markers and run here on fake timers, so what is tested is the code the
 *    browser runs and not a copy of it.
 * 2. A SCAN: nothing a timer drives may reach a bare `fetch(`.
 *
 * Why it earns a test: the failure needs a server that stops answering, which
 * no developer setup ever has. With one, a fixed-interval poll adds a request
 * that never settles on every tick — a handful occupies the few connections a
 * browser opens to a host — and a self-rescheduling loop awaits for ever and
 * silently stops, so the agent list ceases to update with nothing saying so.
 */

// ── 1. the guard's logic ─────────────────────────────────────────────────

type Snapshot = { ok: boolean; status: number; json: () => Promise<unknown> };
type PollFetch = (url: string, opts?: { key?: string; timeoutMs?: number }) => Promise<Snapshot>;

function loadGuard(): { makePollFetch: (env: unknown) => PollFetch; POLL_TIMEOUT_MS: number } {
  const m = INDEX.match(/\/\/ poll-guard:start\n([\s\S]*?)\/\/ poll-guard:end/);
  assert.ok(m, "the poll-guard:start / poll-guard:end markers are missing from index.html");
  return new Function(`${m[1]}\nreturn { makePollFetch, POLL_TIMEOUT_MS };`)();
}

/** A fetch whose every request is settled by hand, and timers that only fire when told to. */
function harness(timeoutMs = 1000) {
  const requests: { url: string; init: Record<string, unknown>; signal: AbortSignal; respond: (body: string, status?: number) => void }[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let throwSync = false;
  const env = {
    timeoutMs,
    AbortController,
    setTimeout: (fn: () => void) => { timers.set(nextTimer, fn); return nextTimer++; },
    clearTimeout: (id: number) => { timers.delete(id); },
    fetch: (url: string, init: { signal: AbortSignal }) => {
      if (throwSync) throw new TypeError("fetch refused synchronously");
      return new Promise((resolve, reject) => {
        // What a real fetch does with its signal: reject the pending request.
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        requests.push({
          url,
          init: init as Record<string, unknown>,
          signal: init.signal,
          respond: (body, status = 200) =>
            resolve({ ok: status >= 200 && status < 300, status, text: async () => body }),
        });
      });
    },
  };
  return {
    pollFetch: loadGuard().makePollFetch(env),
    requests,
    timers,
    fireTimers: () => { for (const fn of [...timers.values()]) fn(); },
    setThrowSync: (v: boolean) => { throwSync = v; },
  };
}

/** Let the microtask queue drain (the guard starts its request one microtask late). */
const settle = () => new Promise((r) => setImmediate(r));

test("poll guard: a tick that finds its endpoint in flight sends nothing", async () => {
  const h = harness();
  const ticks = [h.pollFetch("/usage"), h.pollFetch("/usage"), h.pollFetch("/usage")];
  await settle();
  assert.equal(h.requests.length, 1, "three ticks on a server that has not answered = ONE request");
  h.requests[0].respond('{"n":1}');
  const snaps = await Promise.all(ticks);
  // Every tick gets the answer, each with its own copy: a body is read once,
  // which is why the guard hands out a snapshot and not the Response.
  const bodies = await Promise.all(snaps.map((s) => s.json()));
  assert.deepEqual(bodies, [{ n: 1 }, { n: 1 }, { n: 1 }]);
  assert.notEqual(bodies[0], bodies[1]);
});

test("poll guard: a hundred ticks against a dead endpoint hold one request, then none", async () => {
  const h = harness();
  const ticks = Array.from({ length: 100 }, () => h.pollFetch("/usage"));
  await settle();
  assert.equal(h.requests.length, 1);
  h.fireTimers();
  const results = await Promise.allSettled(ticks);
  assert.ok(results.every((r) => r.status === "rejected"), "the deadline rejects every waiting tick");
  assert.equal((results[0] as PromiseRejectedResult).reason.name, "TimeoutError");
  assert.ok(h.requests[0].signal.aborted, "the request itself is aborted — that is what frees the socket");
});

test("poll guard: the deadline releases the slot, so the next tick polls again", async () => {
  const h = harness();
  const first = h.pollFetch("/usage");
  await settle();
  h.fireTimers();
  await assert.rejects(first);
  const second = h.pollFetch("/usage");
  await settle();
  assert.equal(h.requests.length, 2, "a timed-out poll must not silence its endpoint for the life of the page");
  h.requests[1].respond("{}");
  assert.equal((await second).ok, true);
});

test("poll guard: an answer clears the timer and frees the slot", async () => {
  const h = harness();
  const first = h.pollFetch("/usage");
  await settle();
  h.requests[0].respond("{}");
  await first;
  assert.equal(h.timers.size, 0, "a settled poll leaves no timer behind");
  h.pollFetch("/usage");
  await settle();
  assert.equal(h.requests.length, 2);
});

test("poll guard: the guard is per endpoint — a stuck one never holds the others back", async () => {
  const h = harness();
  h.pollFetch("/usage");
  const other = h.pollFetch("/channels");
  await settle();
  assert.deepEqual(h.requests.map((r) => r.url), ["/usage", "/channels"]);
  h.requests[1].respond("[]");
  assert.deepEqual(await (await other).json(), []);
});

test("poll guard: a body that stalls after the headers is inside the deadline too", async () => {
  const guard = loadGuard();
  const timers: (() => void)[] = [];
  const pollFetch = guard.makePollFetch({
    timeoutMs: 1000,
    AbortController,
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: () => {},
    // Headers arrive at once; the body never does.
    fetch: async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) }),
  });
  const p = pollFetch("/usage");
  await settle();
  timers.forEach((fn) => fn());
  await assert.rejects(p, { name: "TimeoutError" });
});

test("poll guard: a fetch that throws synchronously does not leave a dead slot", async () => {
  const h = harness();
  h.setThrowSync(true);
  await assert.rejects(h.pollFetch("/usage"), TypeError);
  h.setThrowSync(false);
  const again = h.pollFetch("/usage");
  await settle();
  assert.equal(h.requests.length, 1, "the endpoint is polled again after a synchronous failure");
  h.requests[0].respond("{}");
  await again;
});

test("poll guard: status and a malformed body reach the caller as they did with fetch", async () => {
  const h = harness();
  const p = h.pollFetch("/usage");
  await settle();
  h.requests[0].respond("<html>bad gateway</html>", 502);
  const snap = await p;
  assert.equal(snap.ok, false);
  assert.equal(snap.status, 502);
  // Callers rely on `.json()` rejecting to reach their `catch` (refreshUsage
  // fails OPEN on the pace verdict there).
  await assert.rejects(snap.json(), SyntaxError);
});

test("poll guard: it can only issue a GET", async () => {
  const h = harness();
  // A write must never be coalesced (one would be dropped) nor inherit a
  // polling deadline, so the signature carries no `init` to smuggle one in.
  (h.pollFetch as unknown as (u: string, o: unknown) => Promise<Snapshot>)("/channels", { method: "PUT", body: "[]" });
  await settle();
  assert.deepEqual(Object.keys(h.requests[0].init), ["signal"], "nothing but the abort signal reaches fetch");
});

test("poll guard: the deadline is long enough to be a verdict, short enough to bound the pile", () => {
  const { POLL_TIMEOUT_MS } = loadGuard();
  assert.ok(POLL_TIMEOUT_MS >= 5000, "under 5s a slow-but-healthy answer would be thrown away");
  assert.ok(POLL_TIMEOUT_MS <= 30000, "past 30s a dead endpoint holds its socket for most of a minute");
});

// ── 2. the scan ──────────────────────────────────────────────────────────

/**
 * Blanks comments, strings, template text and regex literals out of a script,
 * keeping every offset. No JavaScript parser is installed (TypeScript 7 ships
 * no API), and the checks below only need to know what is CODE. Template
 * `${…}` expressions are kept, since they are code.
 *
 * Returns the brace depth it ends on: anything but 0 means this lexer lost its
 * footing, and the caller refuses to trust the scan rather than pass on noise.
 */
function blankNonCode(src: string): { text: string; depth: number } {
  const out = src.split("");
  const n = src.length;
  const fill = (a: number, b: number) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  const REGEX_AFTER_WORD = ["return", "typeof", "case", "in", "of", "void", "delete", "throw", "new", "else", "do"];
  const templates: number[] = [];
  let i = 0, depth = 0, lastSig = "", lastWord = "";
  const template = () => {
    const s = i;
    while (i < n) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === "`") { fill(s, i); i++; lastSig = "`"; lastWord = ""; return; }
      if (src[i] === "$" && src[i + 1] === "{") { fill(s, i); i += 2; templates.push(depth); depth++; lastSig = "{"; lastWord = ""; return; }
      i++;
    }
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { const s = i; while (i < n && src[i] !== "\n") i++; fill(s, i); continue; }
    if (c === "/" && d === "*") { const s = i; i = src.indexOf("*/", i + 2) + 2; fill(s, i); continue; }
    if (c === '"' || c === "'") {
      const s = i++;
      while (i < n && src[i] !== c) { if (src[i] === "\\") i++; i++; }
      i++;
      fill(s + 1, i - 1);
      lastSig = c; lastWord = "";
      continue;
    }
    if (c === "`") { i++; template(); continue; }
    if (c === "/" && (lastSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSig) || REGEX_AFTER_WORD.includes(lastWord))) {
      const s = i++;
      let inClass = false;
      while (i < n && (inClass || src[i] !== "/") && src[i] !== "\n") {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        i++;
      }
      i++;
      while (/[a-z]/.test(src[i] || "")) i++;
      fill(s, i);
      out[s] = "0";
      lastSig = "0"; lastWord = "";
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (templates.length && templates[templates.length - 1] === depth) { templates.pop(); i++; template(); continue; }
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[\w$]/.test(c)) { const s = i; while (i < n && /[\w$]/.test(src[i])) i++; lastWord = src.slice(s, i); lastSig = "a"; continue; }
    lastSig = c; lastWord = ""; i++;
  }
  return { text: out.join(""), depth };
}

function closing(text: string, open: "(" | "{", from: number): number {
  const close = open === "(" ? ")" : "}";
  let d = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === open) d++;
    else if (text[i] === close && --d === 0) return i;
  }
  return -1;
}

/** Every named function of the script (declarations and `const f = (…) => …`), by name. */
function namedFunctions(text: string): Map<string, string[]> {
  const fns = new Map<string, string[]>();
  const add = (name: string, body: string) => fns.set(name, [...(fns.get(name) ?? []), body]);
  for (const m of text.matchAll(/\bfunction\s+([\w$]+)\s*\(/g)) {
    const params = closing(text, "(", m.index + m[0].length - 1);
    const open = text.indexOf("{", params);
    add(m[1], text.slice(open, closing(text, "{", open) + 1));
  }
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?=\(|[\w$]+\s*=>)/g)) {
    let j = m.index + m[0].length;
    j = text[j] === "(" ? closing(text, "(", j) + 1 : j + text.slice(j).match(/^[\w$]+/)![0].length;
    const arrow = text.slice(j).match(/^\s*=>\s*/);
    if (!arrow) continue; // `const x = (a + b) * c` is not a function
    const start = j + arrow[0].length;
    add(m[1], text[start] === "{" ? text.slice(start, closing(text, "{", start) + 1) : text.slice(start, text.indexOf(";", start)));
  }
  return fns;
}

/** `fetch(` called as itself — not `pollFetch(`, not `env.fetch(`, not `window.fetch = …`. */
const BARE_FETCH = /(?<![\w.$])fetch\s*\(/;

/**
 * How far a timer is followed: the callback itself (0), the functions it names
 * (1), and what those call directly (2) — `syncLoop → syncChannels`, a badge
 * refresh → its inbox helper. Deeper than that the walk stops meaning "this
 * runs on every tick": event handlers are DEFINED inside those functions, and
 * following them reaches nearly every function in the page.
 */
const DEPTH = 2;

/**
 * Self-rescheduling `setTimeout`s that are not polls. Each one waits for a
 * local condition and stops; none of them fetches on a period.
 */
const NOT_A_POLL: Record<string, string> = {
  renderRail: "re-runs ONCE after a click-hold window, to repaint the groups rail",
  followDeepLink: "waits for the restore to finish and a message to render, then stops",
};

function pollRoots(text: string, fns: Map<string, string[]>): { label: string; code: string }[] {
  const roots: { label: string; code: string }[] = [];
  for (const m of text.matchAll(/\bsetInterval\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const line = text.slice(0, m.index).split("\n").length;
    roots.push({ label: `setInterval #${roots.length + 1} (script line ${line})`, code: text.slice(open, closing(text, "(", open) + 1) });
  }
  for (const [name, bodies] of fns) {
    if (name in NOT_A_POLL) continue;
    const again = new RegExp(`\\bsetTimeout\\s*\\(\\s*${name.replace(/\$/g, "\\$")}\\b`);
    if (bodies.some((b) => again.test(b))) roots.push({ label: `self-rescheduling ${name}`, code: `${name}()` });
  }
  return roots;
}

/** Functions within DEPTH of a root whose body holds a bare `fetch(`. */
function bareFetchesFrom(root: { code: string }, fns: Map<string, string[]>): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  const queue: { code: string; name: string; depth: number }[] = [{ code: root.code, name: "<the timer callback>", depth: 0 }];
  while (queue.length) {
    const { code, name, depth } = queue.shift()!;
    if (BARE_FETCH.test(code)) hits.push(name);
    if (depth >= DEPTH) continue;
    // At depth 0 a bare NAME counts (`setInterval(refreshUsage, …)` never calls
    // it); below, only calls do.
    const refs = depth === 0 ? /(?<![\w.$])([\w$]+)\b/g : /(?<![\w.$])([\w$]+)\s*\(/g;
    for (const c of code.matchAll(refs)) {
      if (seen.has(c[1]) || !fns.has(c[1])) continue;
      seen.add(c[1]);
      for (const body of fns.get(c[1])!) queue.push({ code: body, name: c[1], depth: depth + 1 });
    }
  }
  return hits;
}

function mainScript(html: string): string {
  const blocks = [...html.matchAll(/<script nonce="__CSP_NONCE__">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocks.length > 0, "no inline script found in index.html");
  return blocks.reduce((a, b) => (a.length > b.length ? a : b));
}

const SCRIPT = blankNonCode(mainScript(INDEX));
const FUNCTIONS = namedFunctions(SCRIPT.text);
const ROOTS = pollRoots(SCRIPT.text, FUNCTIONS);

test("poll scan: the lexer kept its footing", () => {
  // A scan that silently reads nothing passes for ever. These three fail first.
  assert.equal(SCRIPT.depth, 0, "unbalanced braces after blanking — the scan below cannot be trusted");
  assert.ok(FUNCTIONS.size > 300, `only ${FUNCTIONS.size} functions found in the page script`);
  assert.ok(ROOTS.length >= 10, `only ${ROOTS.length} timers found`);
});

test("poll scan: the scan sees the loops it exists for", () => {
  const labels = ROOTS.map((r) => r.label);
  assert.ok(labels.includes("self-rescheduling syncLoop"), "the channel reconciliation loop was not recognised as a poll");
  for (const fn of ["refreshUsage", "syncRooms", "refreshSecurityBadge", "refreshReportsBadge", "refreshAuthRows", "refreshAccountBanner"]) {
    assert.ok(
      ROOTS.some((r) => new RegExp(`\\b${fn}\\b`).test(r.code)),
      `${fn} is no longer driven by a timer the scan can see — if it moved, move this list with it`,
    );
  }
});

test("poll scan: nothing a timer drives reaches a bare fetch(", () => {
  const offenders = ROOTS.flatMap((r) => bareFetchesFrom(r, FUNCTIONS).map((fn) => `${r.label} → ${fn}`));
  assert.deepEqual(
    offenders,
    [],
    "a periodic poll must go through pollFetch (deadline + in-flight guard, invariant 69): a bare fetch " +
      "piles up one stuck request per tick against a server that stopped answering",
  );
});

test("poll scan: the scan catches what it is meant to catch", () => {
  // Proof the rule above can go red: the same page with ONE poll put back.
  const reverted = INDEX.replace('await pollFetch("/usage")', 'await fetch("/usage")');
  assert.notEqual(reverted, INDEX, "the /usage poll is no longer spelled the way this test rewrites it");
  const script = blankNonCode(mainScript(reverted));
  const fns = namedFunctions(script.text);
  const offenders = pollRoots(script.text, fns).flatMap((r) => bareFetchesFrom(r, fns));
  assert.ok(offenders.includes("refreshUsage"), "a bare fetch in refreshUsage went unnoticed");
  // And one level down, through a helper.
  const helper = INDEX.replace('await pollFetch("/reports")', 'await fetch("/reports")');
  const s2 = blankNonCode(mainScript(helper));
  const f2 = namedFunctions(s2.text);
  assert.ok(pollRoots(s2.text, f2).flatMap((r) => bareFetchesFrom(r, f2)).includes("reportsInbox"));
});

test("poll scan: the exemptions are still what they claim to be", () => {
  // An exempted name that grew a direct fetch is a poll in disguise.
  for (const name of Object.keys(NOT_A_POLL)) {
    const bodies = FUNCTIONS.get(name);
    assert.ok(bodies, `${name} is exempted but no longer exists — drop it from NOT_A_POLL`);
    assert.ok(!bodies.some((b) => BARE_FETCH.test(b)), `${name} is exempted as "not a poll" yet fetches directly`);
  }
});

test("the web client bounds its polls at all", () => {
  // The state this fixes: not one deadline anywhere in the page.
  assert.match(INDEX, /new env\.AbortController\(\)/);
  assert.match(INDEX, /const pollFetch = makePollFetch\(/);
});

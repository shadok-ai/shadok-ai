# Live-text preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a best-effort live preview of the assistant text block being generated, extracted from the TUI screen, then replace it with the authoritative markdown version as soon as the `.jsonl` block arrives.

**Architecture:** 100 % client-side. A pure `extractLiveText(screen)` function (the `public/live-text.js` file, importable in a node test AND loaded by the browser) extracts the screen's last `⏺` text block. The client (`public/index.html`), on every `screen` message of an active turn, shows/refreshes a greyed provisional bubble; on `stream-text` it replaces it with the markdown rendering; on `turn-done`/`dialog` it drops it. Zero server change.

**Tech Stack:** JavaScript ESM (no client-side build), `node:test` through `tsx` (`npm test`), the native DOM (the client has no framework).

## Global Constraints

- No build for the client: `public/*.js` is served as is by `express.static`. The shared file MUST be valid ESM JS (`export function …`) loadable by the browser AND by node/tsx.
- Tests run by `npm test` = `node --import tsx --test test/*.ts …`. A test in `test/*.ts` can import an ESM `.js` through `import { x } from "../public/live-text.js"`.
- The provisional bubble is **ephemeral**: never persisted, never counted as history. Always replaced (`stream-text`) or dropped (`turn-done`/`dialog`).
- Graceful degradation: when the extraction returns `""`, no provisional bubble → the current behaviour unchanged.
- The assistant text block's marker in the TUI is `⏺ ` (U+23FA + space) at column 0; continuations are indented by 2 spaces; a `tool_use` renders as `⏺ Name(args)`; a tool result renders as `  ⎿ …`.

---

## File Structure

- **Create** `public/live-text.js` — the pure `extractLiveText(screen)` function. A single responsibility: parse a TUI screen → the last unwrapped assistant text block (or `""`).
- **Create** `test/live-text.test.ts` — unit tests of `extractLiveText` against real screen fixtures.
- **Modify** `public/index.html` — the module bridge to `window.extractLiveText`, the `.live-preview` CSS, the `updateLivePreview`/`clearLivePreview` helpers, and the wiring in the `working`/`screen`/`stream-text`/`turn-done`/`dialog` handlers.

---

## Task 1: The pure `extractLiveText` function + tests

**Files:**
- Create: `public/live-text.js`
- Test: `test/live-text.test.ts`

**Interfaces:**
- Produces: `export function extractLiveText(screen: string): string` — returns the **last** assistant text block visible on screen, unwrapped (continuations joined by a space). Returns `""` when there is no `⏺ ` text block, or when the last `⏺ ` is a `tool_use` (`⏺ Name(…)`).

- [ ] **Step 1: Write the failing test**

Create `test/live-text.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { extractLiveText } from "../public/live-text.js";

// Shared bottom of screen (separators + input box + footer).
const FOOTER = [
  "────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────",
  "  00:04:01  elapsed:6h58m51s  ctx:4%  ~$0,123  5h:8%",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

test("single in-flight block: unwraps the continuations", () => {
  const screen = [
    "⏺ Here is an introduction being written that spreads over several",
    "  lines because the terminal wraps them to the width, and the text",
    "  carries on a little further here.",
    "✽ Composing… (4s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(
    extractLiveText(screen),
    "Here is an introduction being written that spreads over several lines because the terminal wraps them to the width, and the text carries on a little further here.",
  );
});

test("multi-block: returns the last text block, not the first", () => {
  const screen = [
    "⏺ First paragraph, already finished.",
    "",
    "  Ran 1 shell command",
    "",
    "⏺ Second paragraph being written right now.",
    "✽ Composing… (2s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(extractLiveText(screen), "Second paragraph being written right now.");
});

test("the last ⏺ is a tool_use → \"\"", () => {
  const screen = [
    "⏺ A first paragraph of text.",
    "",
    "⏺ Bash(echo A)",
    "  ⎿  A",
    "✽ Running… (1s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(extractLiveText(screen), "");
});

test("no ⏺ at all → \"\"", () => {
  const screen = ["❯ a pending prompt", FOOTER].join("\n");
  assert.equal(extractLiveText(screen), "");
});

test("a continuation stops at the tool result ⎿", () => {
  const screen = [
    "⏺ Text before a tool.",
    "  ⎿  tool output that must not be sucked in",
    "✽ Composing… (1s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(extractLiveText(screen), "Text before a tool.");
});
```

- [ ] **Step 2: Run the test → failure expected**

Run: `cd .claude/worktrees/live-text-preview && npx tsx --test test/live-text.test.ts`
Expected: FAIL — `Cannot find module '../public/live-text.js'`.

- [ ] **Step 3: Implement `public/live-text.js`**

Create `public/live-text.js`:

```js
// Best-effort extraction of the in-flight assistant text block from the TUI
// screen (@xterm/headless) — see
// docs/superpowers/specs/2026-07-28-live-text-preview-design.md.
//
// Loaded as is by the browser (ESM) and imported by the node/tsx tests. The
// .jsonl transcript only writes a text block once FINISHED; the screen shows it
// as it is typed → the only token-granular source.
//
// An assistant text block = a "⏺ <prose>" line (U+23FA + space) at column 0,
// followed by continuations indented by 2 spaces. A tool_use renders as
// "⏺ Name(args)"; a tool result renders as "  ⎿ …".

const MARKER = "⏺ "; // "⏺ "

/** The last visible assistant text block, unwrapped; "" otherwise. */
export function extractLiveText(screen) {
  if (typeof screen !== "string" || !screen) return "";
  const lines = screen.split("\n");

  // Find the last "⏺ " block marker at column 0.
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(MARKER)) { start = i; break; }
  }
  if (start < 0) return "";

  const head = lines[start].slice(MARKER.length).trim();
  // tool_use: "⏺ Name(...)" — an identifier glued to a parenthesis.
  if (/^[\w.-]+\(/.test(head)) return "";

  const parts = [head];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith("  ") || l.trim() === "") break; // spinner/blank/separator/end
    const t = l.trim();
    if (t.startsWith("⎿") || /^Ran\b/.test(t)) break; // a tool's sub-line
    parts.push(t);
  }
  return parts.join(" ");
}
```

- [ ] **Step 4: Run the test → success expected**

Run: `cd .claude/worktrees/live-text-preview && npx tsx --test test/live-text.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Check the whole suite**

Run: `cd .claude/worktrees/live-text-preview && npm test`
Expected: every test passes (the previous ones + the 5 new).

- [ ] **Step 6: Commit**

```bash
git add public/live-text.js test/live-text.test.ts
git commit -m "Live-text: the pure extractLiveText function + tests"
```

---

## Task 2: Client wiring (bridge, CSS, helpers, handlers)

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `window.extractLiveText(screen)` (Task 1, through the module bridge).
- Consumes (existing): `addTurn(tab, role, who, text, extraClass)`; `tab.transcriptEl`; `active`; the WS messages `working` / `screen` (with `msg.working`, `msg.text`) / `stream-text` (`msg.text`) / `turn-done` / `dialog`; `tab.screenText`.
- Produces (state on `tab`): `tab.livePreviewEl` (a DOM element or null), `tab.livePreviewBubble` (a div.bubble or null), `tab.lastFinalizedScreenText` (a string or null).

- [ ] **Step 1: The module bridge → `window.extractLiveText`**

In `public/index.html`, right after the `<script src="/vendor/marked.js"></script>` line, add:

```html
<script type="module">
  import { extractLiveText } from "/live-text.js";
  window.extractLiveText = extractLiveText;
</script>
```

- [ ] **Step 2: CSS for the provisional bubble**

In the `<style>` block, after the `.turn.hist { opacity: 0.8; }` rule, add:

```css
  /* Live preview of the in-flight block, extracted from the TUI screen (raw,
     not markdown). Greyed + pre-formatted to signal it is provisional; replaced
     by the .jsonl block (stream-text) as soon as that arrives. */
  .turn.claude.live-preview .bubble {
    opacity: 0.55;
    white-space: pre-wrap;
    font-family: var(--mono);
  }
  .turn.claude.live-preview .bubble::after {
    content: "▍";
    animation: breathe 1s step-start infinite;
  }
```

- [ ] **Step 3: The `updateLivePreview` / `clearLivePreview` helpers**

Right after the `addTurn` function (it ends with `return bubble; }`), add:

```js
  /* ── Live preview of the in-flight text ──────────────────
     The .jsonl only writes a text block once FINISHED, so nothing shows while
     it is generated. We fill the gap with the last block read off the TUI
     screen (window.extractLiveText), in a provisional bubble, replaced by the
     authoritative markdown rendering as soon as `stream-text` delivers the
     complete block.

     Deduplication: after a `stream-text` the screen keeps showing the same `⏺`
     block; we remember its screen form (`lastFinalizedScreenText`) so as not to
     recreate a provisional one duplicating the already finalised bubble. */
  function updateLivePreview(tab, screen) {
    if (!window.extractLiveText) return;
    const txt = extractLiveText(screen);
    if (!txt) return; // an extraction gap: keep the existing one as is
    if (txt === tab.lastFinalizedScreenText) { clearLivePreview(tab); return; }
    if (!tab.livePreviewEl) {
      const turn = document.createElement("div");
      turn.className = "turn claude live-preview";
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      turn.appendChild(bubble);
      tab.transcriptEl.appendChild(turn);
      tab.livePreviewEl = turn;
      tab.livePreviewBubble = bubble;
    }
    tab.livePreviewBubble.textContent = txt;
    if (tab === active) tab.transcriptEl.scrollTop = tab.transcriptEl.scrollHeight;
  }

  function clearLivePreview(tab) {
    if (tab.livePreviewEl) tab.livePreviewEl.remove();
    tab.livePreviewEl = null;
    tab.livePreviewBubble = null;
  }
```

- [ ] **Step 4: `working` — rearm for the new turn**

In `case "working":`, at the end of the block (after `setTabState(t, "busy", "responding…");`), add:

```js
        clearLivePreview(t);
        t.lastFinalizedScreenText = null;
```

- [ ] **Step 5: `screen` — refresh the provisional bubble while working**

In `case "screen":`, the current version is:

```js
      case "screen":
        t.screenText = msg.text;
        if (t === active) screenEl.textContent = msg.text;
        break;
```

Replace it with:

```js
      case "screen":
        t.screenText = msg.text;
        if (t === active) screenEl.textContent = msg.text;
        if (msg.working) updateLivePreview(t, msg.text);
        break;
```

- [ ] **Step 6: `stream-text` — snapshot then replacement**

In `case "stream-text":`, replace the current body:

```js
        retireChoices(t);
        closeActivity(t);
        addTurn(t, "claude", "claude", msg.text, "live");
        break;
```

with:

```js
        retireChoices(t);
        closeActivity(t);
        // Remember the screen form of the block being finalised, to prevent a
        // duplicate provisional while the screen still shows it, then replace.
        if (window.extractLiveText) t.lastFinalizedScreenText = extractLiveText(t.screenText);
        clearLivePreview(t);
        addTurn(t, "claude", "claude", msg.text, "live");
        break;
```

- [ ] **Step 7: `turn-done` and `dialog` — drop any leftover provisional bubble**

In `case "turn-done":`, after `retireChoices(t);`, add `clearLivePreview(t);`.

In `case "dialog":`, after `closeActivity(t);`, add `clearLivePreview(t);`.

- [ ] **Step 8: `git add` + commit**

```bash
git add public/index.html
git commit -m "Live-text: the client-side provisional bubble (screen → replaced by .jsonl)"
```

---

## Task 3: Manual verification under real conditions

**Files:** none (verification).

- [ ] **Step 1: Build (the server) from the worktree**

Run: `cd .claude/worktrees/live-text-preview && npm run build`
Expected: `tsc` with no error (no `.ts` modified, but it validates that the worktree builds).

- [ ] **Step 2: Start a dev server from the worktree on a dedicated port**

Run (the token injected in the shell, never through node):

```bash
cd .claude/worktrees/live-text-preview && \
CLAUDE_CODE_OAUTH_TOKEN=$(security find-generic-password -s 'Claude Code-credentials' -a "$USER" -w | jq -r '.claudeAiOauth.accessToken') \
PORT=3899 node dist/server.js > /tmp/livetext-dev.log 2>&1 &
```
Expected: `curl -s -o /dev/null -w '%{http_code}' localhost:3899/` → `200` ; `curl -s -o /dev/null -w '%{http_code}' localhost:3899/live-text.js` → `200`.

- [ ] **Step 3: Open http://localhost:3899, create a channel, send a prompt**

The test prompt: "write a 5-6 sentence intro paragraph, then run `echo A`, then a 5-6 sentence closing paragraph".

Observe: while the paragraph is generated, a **greyed bubble fills in live** (a ▍ cursor); when the block lands, it is **replaced** by the clean markdown bubble. No duplicate remains after the turn.

- [ ] **Step 4: Stop the dev server**

Run: `pkill -f 'PORT=3899' 2>/dev/null; pkill -f 'dist/server.js.*3899' 2>/dev/null || true`
(Do NOT touch the production server on 3789.)

- [ ] **Step 5 (if OK): finalise the branch**

The `worktree-live-text-preview` branch is ready to be reviewed and landed (build verified, tests green, browser check OK). Use `superpowers:finishing-a-development-branch` to decide merge/PR.
```

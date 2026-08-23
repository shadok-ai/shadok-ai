# Escape key → esc to the session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The keyboard's Escape key, while in the chat, sends esc to the active session (like the engine room's Esc button), with guardrails for the overlays/panels and for dialogs.

**Architecture:** A single `document.addEventListener("keydown", …)` in `public/index.html`, with a precedence: close an open overlay/panel, else do nothing when a clickable dialog is pending, else send `{type:"key", key:"escape"}` on `active.ws`. Reuses the WS message the engine room's buttons already emit.

**Tech Stack:** Vanilla HTML/CSS/JS (no front-end build, no JS test framework). Verification = the browser.

## Global Constraints

- Frontend only: modify `public/index.html` and nothing else. No server or protocol change.
- Reuse the existing message `active.ws.send(JSON.stringify({ type: "key", key: "escape" }))` (identical to the `.keys button[data-key]` buttons, ~line 2517).
- `active` = the current tab, with `.ws` (WebSocket), `.status` ("setup"|"ready"|"busy"|"connecting"|"dead"), `.dialogBubble` (non-null ⇒ a clickable dialog is pending; reset to null by `retireChoices`).
- Existing ids: `#secretsOverlay` (modal, `hidden` prop), `#profilesOverlay` (modal, `hidden`), `#diffpanel` (aside, `.open` class), `#machine` (engine room, `.open`).
- The engine room (`#machine.open`) is **not** closed by Escape: Escape sends esc there.
- The inline edit already calls `e.stopPropagation()` ⇒ do not handle it, it never reaches the document handler.

---

### Task 1: A document-level Escape handler

**Files:**
- Modify: `public/index.html` — insert after the `.keys button[data-key]` forEach block (after the `);` line ~2519, before `$("settleBtn")…`).

**Interfaces:**
- Consumes: `$()` (the `document.getElementById` helper), `active` (the global current tab), `active.ws/.status/.dialogBubble`.
- Produces: no new symbol (an anonymous listener).

- [ ] **Step 1: Insert the handler**

In `public/index.html`, right after:

```js
  document.querySelectorAll(".keys button[data-key]").forEach((b) =>
    b.addEventListener("click", () => {
      if (active.ws) active.ws.send(JSON.stringify({ type: "key", key: b.dataset.key }));
    })
  );
```

add:

```js
  // The Escape key sends esc to the active session (like the engine room's Esc
  // button). Precedence: an open overlay/panel is closed first (Escape does not
  // reach down to the session); a pending clickable dialog is left intact;
  // otherwise we send esc. An open engine room is NOT a panel to close — it is
  // the terminal, and Escape sends esc there.
  // The inline edit calls stopPropagation, so this handler never sees it.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // 1. Open overlays / panels → close, no esc.
    if (!$("secretsOverlay").hidden) { $("secretsOverlay").hidden = true; e.preventDefault(); return; }
    if (!$("profilesOverlay").hidden) { $("profilesOverlay").hidden = true; e.preventDefault(); return; }
    if ($("diffpanel").classList.contains("open")) { $("diffpanel").classList.remove("open"); e.preventDefault(); return; }
    // 2. A clickable dialog awaiting an answer → do nothing.
    if (active && active.dialogBubble) return;
    // 3. An active session (an open engine room included) → send esc.
    if (active && active.ws && active.status !== "setup") {
      active.ws.send(JSON.stringify({ type: "key", key: "escape" }));
      e.preventDefault();
    }
  });
```

- [ ] **Step 2: Build**

Run: `cd ~/projects/shadok-ai/.claude/worktrees/esc-key-interrupt && npm run build`
Expected: compiles with no error (no `.ts` touched).

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "Chat: the Escape key sends esc to the session (like the terminal's button)"
```

- [ ] **Step 4: Browser check (after a restart triggered by the human)**

Open an active session at http://localhost:3789 and check:
1. Focus in the composer, Claude working → Escape interrupts the turn (like the engine room's Esc button).
2. Engine room open → Escape sends esc (does not close the engine room).
3. Open the Diff panel → Escape closes it (sends no esc). Same for the Secrets and Profiles overlays.
4. A clickable dialog displayed (a TUI question) → Escape does nothing; the buttons stay clickable.
5. Rename a tab inline, press Escape → the rename is cancelled (unchanged), no esc.
6. No session (the setup screen) → Escape disturbs nothing.

---

## Self-Review

**1. Spec coverage:**
- Overlays/panels closed first (secrets → profiles → diff) → Step 1, point 1 ✓
- Engine room open → esc (not closed) → Step 1, falls to point 3 since `#machine` is not tested ✓
- A pending dialog → nothing → Step 1, point 2 ✓
- An active session → esc → Step 1, point 3 ✓
- The inline edit unchanged (stopPropagation) → deliberately unhandled ✓
- No session → nothing → point 3 is false (no `active.ws`) ✓
- Build + browser check → Steps 2, 4 ✓

**2. Placeholder scan:** none; complete code supplied.

**3. Type consistency:** `active`, `active.ws`, `active.status`, `active.dialogBubble` used consistently with the rest of the file (lines 2517, 2521, 1826). The existing `$()` helper. The `#secretsOverlay`/`#profilesOverlay`/`#diffpanel` ids exist.

# Agent creation box (profile-first) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the profile the way into creating an agent, cut the box's height
by folding the rare sections away, and speak of an "agent" rather than a
"channel".

**Architecture:** Everything happens in `public/index.html` (a client with no
framework and no build) plus a small pure ESM module, `public/profile-card.js`,
for the labels derived from a profile — the same pattern as
`public/live-text.js`, hence testable under `node --test`. No protocol, endpoint
or persistence change: the `start` WS message keeps its `profile` field, and
`src/channels.ts` is untouched.

**Tech Stack:** Vanilla ESM HTML/CSS/JS on the client, `node --import tsx --test`
for the tests, TypeScript/Express on the server (`express.static("public")`
already serves any new file in `public/`).

**Spec:** `docs/superpowers/specs/2026-07-29-agent-creation-box-design.md`

## Global Constraints

- **UI copy in English.** Every visible label is in English (the rest
  de l'UI l'est) : `Agents`, `＋ new agent`, `New agent`, `Which agent?`,
  `∅ No profile`, `plain Claude`, `Start agent`.
- **Code comments in English**, explaining the *why* — the repo's convention
  (`CLAUDE.md`, the Conventions section).
- **No field added to the `Profile` type** (`src/profiles.ts` is not modified):
  the cards are derived from `name`, `systemPrompt`, `deny`, `model`,
  `secrets`.
- **No renaming of a code identifier, an endpoint, a `localStorage` key or a
  persistence file.** The renaming is purely cosmetic. In particular
  `cp.channels`, `/channels`, `/channel`, `src/channels.ts` and the main
  channel's forced `general` name stay as they are.
- **Never restart the shadok-ai server** during the implementation: that would
  kill the sibling sessions (`CLAUDE.md`, invariant 8).
- After any step touching the server: `npm run build`. The tasks below only
  touch TypeScript in task 2 (`src/telegram.ts`).
- One commit per task, the message in English.

---

### Task 1: The pure `profile-card.js` module (derived labels)

**Files:**
- Create: `public/profile-card.js`
- Test: `test/profile-card.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: two exported pure functions, used by task 3 through
  `window.profileBlurb` / `window.profileBadges` :
  - `profileBlurb(profile: {name?, systemPrompt?}) => string` — a one-line
    pitch, `""` when there is no `systemPrompt`.
  - `profileBadges(profile: {deny?, model?, secrets?}) => string[]` — liste de
    short badges, always at least one item.

- [ ] **Step 1: Write the failing test**

Create `test/profile-card.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { profileBlurb, profileBadges } from "../public/profile-card.js";

test("blurb: keeps the 1st sentence and drops the 'You are <name>,' opener", () => {
  const p = {
    name: "Shadok-Marketing",
    systemPrompt:
      "You are Shadok-Marketing, the paid-marketing & growth agent. Read the product's code, docs and site to understand exactly what it does.",
  };
  assert.equal(profileBlurb(p), "the paid-marketing & growth agent.");
});

test("blurb: a hyphenated name is not cut in two", () => {
  const p = {
    name: "Shadok-dev",
    systemPrompt:
      "You are Shadok-dev, a senior software engineer on this project. Make small, well-tested changes.",
  };
  assert.equal(profileBlurb(p), "a senior software engineer on this project.");
});

test("blurb: no systemPrompt → empty string", () => {
  assert.equal(profileBlurb({ name: "x" }), "");
  assert.equal(profileBlurb({ name: "x", systemPrompt: "   " }), "");
  assert.equal(profileBlurb(null), "");
});

test("blurb: a prompt with no full stop → the whole text, truncated if needed", () => {
  assert.equal(profileBlurb({ name: "x", systemPrompt: "just a role" }), "just a role");
});

test("blurb: too long a sentence → truncation on a word boundary", () => {
  const long = "You are Bob, " + "alpha ".repeat(30).trim() + ".";
  const out = profileBlurb({ name: "Bob", systemPrompt: long });
  assert.ok(out.endsWith("…"), "must end with an ellipsis");
  assert.ok(out.length <= 91, "90 characters + the ellipsis");
  assert.ok(!out.slice(0, -1).endsWith(" "), "pas d'espace avant l'ellipse");
  assert.ok(out.startsWith("alpha alpha"), "the opener is dropped");
});

test("badges: deny vide → full access, deny rempli → read-only", () => {
  assert.deepEqual(profileBadges({ name: "x" }), ["full access"]);
  assert.deepEqual(profileBadges({ name: "x", deny: [] }), ["full access"]);
  assert.deepEqual(profileBadges({ name: "x", deny: ["Bash(git commit:*)"] }), ["read-only"]);
});

test("badges: model and secrets, in the order access → model → secrets", () => {
  assert.deepEqual(
    profileBadges({ name: "x", deny: ["Bash(git push:*)"], model: "opus", secrets: ["A", "B"] }),
    ["read-only", "opus", "2 secrets"]
  );
});

test("badges: un seul secret est au singulier", () => {
  assert.deepEqual(profileBadges({ name: "x", secrets: ["A"] }), ["full access", "1 secret"]);
});

test("badges: profil vide ne casse pas", () => {
  assert.deepEqual(profileBadges(null), ["full access"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="blurb|badges"`
(ou directement `node --import tsx --test test/profile-card.test.ts`)
Expected: FAIL — `Cannot find module '.../public/profile-card.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `public/profile-card.js`:

```js
// Labels derived from a Profile for the "New agent" box's cards —
// voir docs/superpowers/specs/2026-07-29-agent-creation-box-design.md.
//
// Loaded as is by the browser (ESM) and imported by the node/tsx tests,
// comme public/live-text.js.
//
// Nothing is added to the Profile type: everything is derived from what is
// already there (systemPrompt, deny, model, secrets), so profiles already
// stored display with no migration and no form to fill in again.

/** Beyond this the card would turn into a wall of text: truncate. */
const MAX_BLURB = 90;

/**
 * A one-line pitch taken from the systemPrompt: its first sentence, without the
 * "You are <name>," opener — redundant with the card's title — and truncated on
 * a word boundary. "" when the profile has no prompt.
 */
export function profileBlurb(profile) {
  const raw = ((profile && profile.systemPrompt) || "").trim();
  if (!raw) return "";
  // First sentence: the first "." followed by a space or by the end.
  const m = raw.match(/^[\s\S]*?\.(?=\s|$)/);
  let s = (m ? m[0] : raw).trim();
  // The name can contain a hyphen (Shadok-dev): we only cut on "," or an em
  // dash, never on the name's own hyphen.
  s = s.replace(/^you are\s+[^,—]{1,40}?\s*[,—]\s*/i, "");
  if (s.length <= MAX_BLURB) return s;
  const cut = s.slice(0, MAX_BLURB);
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut).replace(/[.,;:]$/, "") + "…";
}

/**
 * The profile's guardrails as short badges: git access (the only one that
 * really matters when choosing), forced model, number of injected secrets.
 */
export function profileBadges(profile) {
  const p = profile || {};
  const out = [p.deny && p.deny.length ? "read-only" : "full access"];
  if (p.model) out.push(p.model);
  const n = (p.secrets || []).length;
  if (n) out.push(n + " secret" + (n > 1 ? "s" : ""));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/profile-card.test.ts`
Expected: PASS, 9 tests.

Then the whole suite, to check nothing broke:
Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/profile-card.js test/profile-card.test.ts
git commit -m "Labels derived from a profile (blurb + badges), a tested pure module"
```

---

### Task 2: Renaming "channel" → "agent" in the visible copy

**Files:**
- Modify: `public/index.html` (lignes 884, 917, 920, 996, 997, 1000, 1001, 1007, 1008-1010, 1037, 1147, 1157, 1286, 2134, 2974, 2975)
- Modify: `src/telegram.ts` (lignes 856, 926, 941, 981)

**Interfaces:**
- Consumes: rien.
- Produces: nothing programmatic — copy only.

**Reminder:** no identifier, endpoint (`/channels`, `/channel`),
`localStorage` key (`cp.channels`) or file name changes. Only the displayed text
does.

- [ ] **Step 1: Rename the left-hand column and the box**

In `public/index.html`, apply exactly:

```html
<!-- ligne 996-1001 -->
  <nav id="tabbar" aria-label="Agents">
    <div class="label side-label">Agents</div>
    <div id="ungrouped"></div>
    <div id="groups"></div>
    <button id="newTab" title="New agent">＋ new agent</button>
    <button id="newGroup" title="New agent group">＋ new group</button>
```

```html
<!-- ligne 1007-1010 -->
      <h1>New agent</h1>
      <p class="hint">Starts a real Claude Code session, driven inside a
      pseudo-terminal. Each agent is an independent session — open as many
      agents as you want Claudes working in parallel.</p>
```

```html
<!-- ligne 1037 -->
      <button class="primary" id="startBtn">Start agent</button>
```

- [ ] **Step 2: Rename the client's remaining labels**

Still in `public/index.html`:

```html
<!-- ligne 884 -->
  <button id="cronBtn" title="Scheduled prompts for this agent (monitoring / reporting)">⏰ Schedule</button>
```

```html
<!-- ligne 917 -->
      <strong>⏰ Schedule — <span id="cronChanName">this agent</span></strong>
```

On line 920, replace `<b>this channel's agent</b>` with `<b>this agent</b>` (the
rest of the paragraph is unchanged).

```js
// ligne 1147
    name.textContent = "agent " + seq;
// ligne 1157
    close.title = "Close this agent";
// ligne 1286
    tab.nameEl.title = "Main agent of this environment — it can't be closed";
// ligne 2134
    if (!t.customName) t.nameEl.textContent = basename(msg.cwd || "") || "agent " + t.id;
// ligne 2974
    $("cronChanName").textContent = (active && (active.name || (active.sessionId || "").slice(0, 8))) || "no agent";
// ligne 2975
    if (!active || !active.sessionId) { ul.innerHTML = '<li><span style="opacity:.6">Open an agent to schedule prompts.</span></li>'; return; }
```

- [ ] **Step 3: Rename the Telegram copy**

In `src/telegram.ts`:

- ligne 856 (aide `/help`) : `"/tools [on|off] — show or hide tool calls in this channel"` → `"/tools [on|off] — show or hide tool calls in this agent"`
- ligne 926 : `"🔧 tool calls shown in this channel."` → `"…in this agent."` et `"🔧 tool calls hidden in this channel."` → `"…in this agent."`
- ligne 941 : `"⏰ Scheduled prompts for this channel:\n"` → `"⏰ Scheduled prompts for this agent:\n"`
- ligne 981 : `"Send a message here first to create the channel, then schedule.\n\n"` → `"Send a message here first to create the agent, then schedule.\n\n"`

- [ ] **Step 4: Check no visible "channel" copy remains**

Run:
```bash
grep -nE '"[^"]*[Cc]hannel[^"]*"|>[^<]*[Cc]hannel[^<]*<' public/index.html | grep -vE '/channels?|cp\.channels|persistChannels|dismissedChannels|channelPushTimer'
```
Expected: **no result**. This grep isolates exactly the 12 labels listed in
steps 1-2 (checked before the change): if it returns nothing, the copy is
complete. The CSS/JS comments that still say "channel" stay as they are — they
describe the code, whose identifiers have not changed.

- [ ] **Step 5: Build + tests**

Run: `npm run build && npm test`
Expected: PASS. (`test/telegram.test.ts` exists: if an assertion covered one of
those strings, update it in the same commit.)

- [ ] **Step 6: Commit**

```bash
git add public/index.html src/telegram.ts
git commit -m "L'UI parle d'agents, plus de canaux (copie seulement)"
```

---

### Task 3: A grid of profile cards in place of the `<select>`

**Files:**
- Modify: `public/index.html` — CSS after line ~397, markup at lines
  1033-1036, import ESM ligne 1093-1096, `startActiveTab` ligne ~2289, bloc
  Profiles lignes 3032-3046 et 3115-3118.

**Interfaces:**
- Consumes: `profileBlurb` / `profileBadges` from task 1.
- Produces, for tasks 4 to 6:
  - `let selectedProfile` (string) — the chosen profile's name, `""` for none.
  - `renderProfileGrid(failed?: boolean)` — repaints the grid from
    `profileCache`.
  - `selectProfile(name: string, byUser?: boolean)` — sets the selection.
  - `syncProfileSelection()` — reflects `selectedProfile` on the DOM and falls
    back to `""` when the selected profile no longer exists.
  - `openProfilesPanel(profile?)` — opens the overlay, prefilled when a profile
    is passed.

- [ ] **Step 1: Add the cards' CSS**

In `public/index.html`, right after the `input[type="radio"]` rule (line ~382,
before the `/* Session picker (resume by id) */` comment):

```css
  /* Profile cards — the profile is THE structuring choice of an agent (role,
     guardrails, secrets, model), hence at the top of the box and clickable. */
  .field-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .linkish {
    background: none; border: none; padding: 0;
    color: var(--text-dim); font: inherit; font-size: 12px; cursor: pointer;
  }
  .linkish:hover { color: var(--amber); }
  #profileGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .profile-card {
    position: relative;
    display: flex; flex-direction: column; gap: 4px;
    text-align: left;
    padding: 9px 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg-inset);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .profile-card:hover { border-color: var(--text-dim); }
  .profile-card.selected { border-color: var(--amber); box-shadow: inset 0 0 0 1px var(--amber); }
  .profile-card.selected .pc-name { color: var(--amber); }
  .profile-card:focus-visible { outline: 2px solid var(--amber); outline-offset: 1px; }
  .pc-name { font-family: var(--mono); font-size: 13px; }
  .pc-blurb {
    color: var(--text-dim); font-size: 11.5px; line-height: 1.35;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .pc-badges { display: flex; flex-wrap: wrap; gap: 4px; }
  .pc-badge {
    font-size: 10.5px; color: var(--text-dim);
    border: 1px solid var(--line); border-radius: 3px; padding: 0 4px;
  }
  /* The pencil only appears on hover: it must not compete with the name. */
  .pc-edit { position: absolute; top: 6px; right: 7px; font-size: 11px; color: var(--text-dim); opacity: 0; }
  .profile-card:hover .pc-edit, .profile-card:focus-within .pc-edit { opacity: 1; }
  .pc-edit:hover { color: var(--amber); }
  .grid-note { grid-column: 1 / -1; color: var(--text-dim); font-size: 12px; font-style: italic; }
  /* A field with no effect in the current mode (resume/continue) — visible but inert. */
  .na { opacity: .45; pointer-events: none; }
```

- [ ] **Step 2: Replace the Profile field's markup**

Replace lines 1033-1036:

```html
      <div class="field" id="profileField">
        <span class="label">Profile <span class="check-hint">— role + guardrails + secrets, applied at spawn (new sessions only)</span></span>
        <select id="profileInput"><option value="">(none)</option></select>
      </div>
```

par :

```html
      <div class="field" id="profileField">
        <div class="field-head">
          <span class="label">Which agent?</span>
          <button type="button" class="linkish" id="editProfilesLink" title="Create or edit agent profiles">✎ edit profiles</button>
        </div>
        <div id="profileGrid" role="radiogroup" aria-label="Agent profile"></div>
        <span class="check-hint" id="profileNaNote" hidden>Applies to new sessions only.</span>
      </div>
```

Then **move that block** right after the `<p class="hint">` (line 1010), before
the `Working directory` field: who first, where next.

Note: `#editProfilesLink` is only wired in task 4 — at the end of this task the
link is visible but inert. That is deliberate: task 3 delivers the grid, task 4
delivers the editing shortcuts.

- [ ] **Step 3: Expose the module's functions to the main script**

At lines 1093-1096, extend the existing ESM bridge:

```html
<script type="module">
  import { extractLiveText } from "/live-text.js";
  import { profileBlurb, profileBadges } from "/profile-card.js";
  window.extractLiveText = extractLiveText;
  window.profileBlurb = profileBlurb;
  window.profileBadges = profileBadges;
</script>
```

`express.static(path.join(__dirname, "..", "public"))` (`src/server.ts:276`)
already serves `/profile-card.js` with no route to add.

- [ ] **Step 4: Replace the select's rendering with the grid**

In the "Profiles panel" block (line 3032+), replace `loadProfilesInto`
(lignes 3036-3046) par :

```js
  let selectedProfile = "";    // name of the profile chosen in the box, "" = none

  async function loadProfilesInto() {
    let failed = false;
    try { profileCache = await (await fetch("/profiles")).json(); }
    catch { profileCache = []; failed = true; }
    if (!Array.isArray(profileCache)) { profileCache = []; failed = true; }
    renderProfileGrid(failed);
  }

  /** Paints the box's grid. The "No profile" card is always there: it is the
   *  default, and the only fallback when /profiles is down. */
  function renderProfileGrid(failed) {
    const grid = $("profileGrid");
    if (!grid) return;
    grid.innerHTML = "";
    if (failed) {
      const note = document.createElement("div");
      note.className = "grid-note";
      note.textContent = "couldn't load profiles";
      grid.appendChild(note);
    }
    for (const p of profileCache) grid.appendChild(profileCardEl(p));
    grid.appendChild(profileCardEl(null));      // ∅ No profile, always last
    syncProfileSelection();
  }

  /** One card = one <button role="radio">. p === null → the "No profile" card. */
  function profileCardEl(p) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "profile-card";
    card.setAttribute("role", "radio");
    card.dataset.profile = p ? p.name : "";
    const title = document.createElement("div");
    title.className = "pc-name";
    title.textContent = p ? p.name : "∅ No profile";
    const blurb = document.createElement("div");
    blurb.className = "pc-blurb";
    blurb.textContent = p ? window.profileBlurb(p) : "plain Claude";
    card.append(title, blurb);
    if (p) {
      const badges = document.createElement("div");
      badges.className = "pc-badges";
      for (const b of window.profileBadges(p)) {
        const s = document.createElement("span");
        s.className = "pc-badge";
        s.textContent = b;
        badges.appendChild(s);
      }
      card.appendChild(badges);
    }
    card.addEventListener("click", () => selectProfile(card.dataset.profile, true));
    card.addEventListener("keydown", onProfileKey);
    return card;
  }

  function selectProfile(name, byUser) {
    selectedProfile = name || "";
    if (byUser) profileTouched = true;
    syncProfileSelection();
  }

  /** Reflects selectedProfile on the cards. A single tabindex=0 in the group:
   *  that is the radiogroup convention (Tab enters, arrows navigate). */
  function syncProfileSelection() {
    const grid = $("profileGrid");
    if (!grid) return;
    const cards = [...grid.querySelectorAll('.profile-card[role="radio"]')];
    if (!cards.some((c) => c.dataset.profile === selectedProfile)) selectedProfile = "";
    for (const c of cards) {
      const on = c.dataset.profile === selectedProfile;
      c.classList.toggle("selected", on);
      c.setAttribute("aria-checked", on ? "true" : "false");
      c.tabIndex = on ? 0 : -1;
    }
  }

  /** Arrows = move the selection (radiogroup convention). Space/Enter are
   *  already the <button>'s native click. */
  function onProfileKey(e) {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const cards = [...$("profileGrid").querySelectorAll('.profile-card[role="radio"]')];
    const i = cards.indexOf(e.currentTarget);
    const next = cards[(i + dir + cards.length) % cards.length];
    selectProfile(next.dataset.profile, true);
    next.focus();
  }
```

`profileTouched` is declared in task 5; so that this task stands alone, add it
now, right above `let selectedProfile = "";`:

```js
  let profileTouched = false;  // the user picked by hand (see task 5)
```

- [ ] **Step 5: Wire `startActiveTab` to the new selection**

Ligne ~2289, remplacer :

```js
    if (mode === "new" && $("profileInput") && $("profileInput").value) msg.profile = $("profileInput").value;
```

par :

```js
    if (mode === "new" && selectedProfile) msg.profile = selectedProfile;
```

- [ ] **Step 6: Fix the initial call's comment**

Ligne 3118 : `loadProfilesInto(); // populate the setup selector on load` →
`loadProfilesInto(); // paints the box's profile grid on load`

- [ ] **Step 7: Check**

Run: `npm run build && npm test`
Expected: PASS.

Run: `grep -n "profileInput" public/index.html`
Expected: **no result** — the old `<select>` is entirely gone.

- [ ] **Step 8: Commit**

```bash
git add public/index.html
git commit -m "The profile becomes cards at the top of the box, no longer a select"
```

---

### Task 4: Editing shortcuts, the empty state, the error state

**Files:**
- Modify: `public/index.html` — bloc Profiles (lignes ~3032-3120), gestionnaire
  Escape (line ~2863).

**Interfaces:**
- Consumes: `renderProfileGrid`, `profileCardEl`, `loadProfilesInto`,
  `fillProfileForm`, `clearProfileForm`, `renderProfilesList` (existants).
- Produces: `openProfilesPanel(profile?)` and `closeProfilesPanel()`, used by
  `#profilesBtn`, `#editProfilesLink`, `#profilesClose`, the backdrop click and
  the Escape key.

- [ ] **Step 1: Factoriser ouverture / fermeture du panneau**

Replace lines 3115-3117:

```js
  $("profilesBtn").addEventListener("click", async () => { await loadProfilesInto(); renderProfilesList(); clearProfileForm(); $("profilesOverlay").hidden = false; });
  $("profilesClose").addEventListener("click", () => { $("profilesOverlay").hidden = true; });
  $("profilesOverlay").addEventListener("click", (e) => { if (e.target === $("profilesOverlay")) $("profilesOverlay").hidden = true; });
```

par :

```js
  /** Opens the Profiles panel, prefilled on `p` when coming from a card's pencil. */
  async function openProfilesPanel(p) {
    await loadProfilesInto();
    renderProfilesList();
    if (p) fillProfileForm(p); else clearProfileForm();
    $("profilesOverlay").hidden = false;
  }
  /** Closing repaints the grid: a created profile appears at once, and the
   *  selection falls back to "No profile" when the chosen one was deleted
   *  (syncProfileSelection s'en charge). */
  async function closeProfilesPanel() {
    $("profilesOverlay").hidden = true;
    await loadProfilesInto();
  }
  $("profilesBtn").addEventListener("click", () => openProfilesPanel());
  $("editProfilesLink").addEventListener("click", () => openProfilesPanel());
  $("profilesClose").addEventListener("click", closeProfilesPanel);
  $("profilesOverlay").addEventListener("click", (e) => { if (e.target === $("profilesOverlay")) closeProfilesPanel(); });
```

- [ ] **Step 2: Closing with Escape must repaint too**

Ligne ~2863, remplacer :

```js
    if (!$("profilesOverlay").hidden) { $("profilesOverlay").hidden = true; e.preventDefault(); return; }
```

par :

```js
    if (!$("profilesOverlay").hidden) { closeProfilesPanel(); e.preventDefault(); return; }
```

- [ ] **Step 3: Add the per-card pencil**

In `profileCardEl`, inside the `if (p) { … }` and **after** the badges are
added, insert:

```js
      // Shortcut: edit THIS profile without going through the top bar.
      const pen = document.createElement("span");
      pen.className = "pc-edit";
      pen.textContent = "✎";
      pen.title = "Edit " + p.name;
      pen.addEventListener("click", (e) => {
        e.stopPropagation();          // edit, do not select the card
        openProfilesPanel(p);
      });
      card.appendChild(pen);
```

- [ ] **Step 4: Add the "no profile" state**

In `renderProfileGrid`, between the `if (failed)` block and the loop
`for (const p of profileCache)` :

```js
    // Zero profiles: show the way in rather than a mute "(none)".
    if (!failed && !profileCache.length) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "profile-card";
      b.style.gridColumn = "1 / -1";
      b.textContent = "Create your first profile →";
      b.addEventListener("click", () => openProfilesPanel());
      grid.appendChild(b);
    }
```

That card does **not** have `role="radio"`: it is therefore ignored by
`syncProfileSelection` and by the arrow navigation, and the "No profile" card
stays the default selection.

- [ ] **Step 5: Check**

Run: `npm run build && npm test`
Expected: PASS.

A manual check in the browser (see task 7 for the launch): `✎ edit profiles`
opens the empty panel; a card's `✎` opens it prefilled on that profile; Escape
closes it and the grid refreshes.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "Edit a profile from the box, and a way in when there is none"
```

---

### Task 5: Remembering the last profile used, per directory

**Files:**
- Modify: `public/index.html` — `refreshChrome` (lignes ~1692-1703),
  `startActiveTab` (lignes ~2277-2293), gestionnaire `cwdInput` (ligne ~2689),
  the Profiles block (declarations).

**Interfaces:**
- Consumes: `selectProfile`, `selectedProfile`, `profileTouched` (task 3).
- Produces: `applyRememberedProfile()` and the `profileTab` variable.

- [ ] **Step 1: Add the recall function**

In the Profiles block, right after `syncProfileSelection`, add:

```js
  let profileTab = null;   // tab for which the memory has already been applied

  /** Preselects the last profile used IN THIS DIRECTORY (failing that, the last
   *  used at all): the common case becomes one click + Start. An empty key is a
   *  legitimate value — "No profile" chosen on purpose — hence the test on null
   *  and not on the string's truthiness. */
  function applyRememberedProfile() {
    const cwd = $("cwdInput").value.trim();
    const perDir = cwd ? localStorage.getItem("cp.profile:" + cwd) : null;
    const remembered = perDir !== null ? perDir : (localStorage.getItem("cp.profile") || "");
    selectProfile(remembered);   // syncProfileSelection retombe sur "" s'il n'existe plus
  }
```

- [ ] **Step 2: Apply the recall when the box opens on a tab**

In `refreshChrome`, the `if (t.status === "setup") { … }` block (line ~1692),
after `$("startBtn").disabled = false;`:

```js
      // refreshChrome runs often: we only recall the memory on the first pass
      // over THIS tab, otherwise we would overwrite the user's choice.
      if (profileTab !== t) { profileTab = t; profileTouched = false; applyRememberedProfile(); }
```

- [ ] **Step 3: Re-apply when the directory changes**

Gestionnaire `$("cwdInput").addEventListener("change", …)` (ligne ~2689) :

```js
  $("cwdInput").addEventListener("change", () => {
    if (!$("resumeField").hidden) refreshSessionList();
    refreshRecoverList();
    // Another directory may have its own regular — unless one was already picked.
    if (!profileTouched) applyRememberedProfile();
  });
```

- [ ] **Step 4: Write the memory at launch**

In `startActiveTab`, after `localStorage.setItem("cp.cwd", cwd);`:

```js
    if (mode === "new") {
      localStorage.setItem("cp.profile", selectedProfile);
      if (cwd) localStorage.setItem("cp.profile:" + cwd, selectedProfile);
    }
```

- [ ] **Step 5: Check**

Run: `npm run build && npm test`
Expected: PASS.

A manual check: launch an agent with a profile, open a new box on the same
directory → the card is preselected. Change the directory to another one already
used → that directory's regular gets selected. Pick a card by hand then change
directory → the manual choice holds.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "The last profile used in a directory is preselected"
```

---

### Task 6: Folding the rare sections (`<details>`) and dimming outside `new` mode

**Files:**
- Modify: `public/index.html` — CSS (after the cards' block), markup
  1015-1045, `refreshLiveList` (~2194), `refreshRecoverList` (~2233),
  the `mode` radios' handler (~2679).

**Interfaces:**
- Consumes: `#profileField`, `#profileNaNote` (task 3).
- Produces: `#advancedField`, `#recoverField`, `#liveField` as `<details>` with
  the `#recoverCount` and `#liveCount` counters.

- [ ] **Step 1: Add the foldable sections' CSS**

After the cards' CSS block (task 3):

```css
  /* Rare sections folded away: this is what kept the Start button from fitting
     on screen (the lists opened by default as soon as they had one item). */
  .fold > summary {
    cursor: pointer; list-style: none;
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; color: var(--text-dim);
  }
  .fold > summary::-webkit-details-marker { display: none; }
  .fold > summary::before { content: "▸"; }
  .fold[open] > summary::before { content: "▾"; }
  .fold > summary:hover { color: var(--text); }
  .fold > *:not(summary) { margin-top: 8px; }
  .fold-count { color: var(--amber); }
```

- [ ] **Step 2: Turn the three sections into `<details>`**

The line numbers moved in task 3: replace **the whole content of
`<div id="setup" hidden>`** with this final block, which fixes the definitive
order (who → where → the rare stuff, folded → the action). The `Resume` field
loses its `<span class="label">Resume</span>`: the `<summary>` replaces it.

```html
    <div id="setup" hidden>
      <h1>New agent</h1>
      <p class="hint">Starts a real Claude Code session, driven inside a
      pseudo-terminal. Each agent is an independent session — open as many
      agents as you want Claudes working in parallel.</p>
      <div class="field" id="profileField">
        <div class="field-head">
          <span class="label">Which agent?</span>
          <button type="button" class="linkish" id="editProfilesLink" title="Create or edit agent profiles">✎ edit profiles</button>
        </div>
        <div id="profileGrid" role="radiogroup" aria-label="Agent profile"></div>
        <span class="check-hint" id="profileNaNote" hidden>Applies to new sessions only.</span>
      </div>
      <div class="field">
        <span class="label">Working directory</span>
        <input type="text" id="cwdInput" placeholder="/path/to/project">
      </div>
      <label class="check" id="worktreeField">
        <input type="checkbox" id="worktreeInput" checked>
        <span>Isolate in a git worktree <span class="check-hint">— the agent edits a fresh branch; review &amp; merge from the Diff panel. Auto-removed on close if unused, kept if it has changes. (new sessions only)</span></span>
      </label>
      <details class="fold" id="advancedField">
        <summary>Advanced — resume an existing session</summary>
        <div class="field">
          <div class="radio-row">
            <label><input type="radio" name="mode" value="new" checked> new session</label>
            <label><input type="radio" name="mode" value="continue"> latest in directory</label>
            <label><input type="radio" name="mode" value="resume"> by id</label>
          </div>
        </div>
        <div class="field" id="resumeField" hidden>
          <span class="label">Session id</span>
          <input type="text" id="resumeInput" placeholder="5fe046dd-…">
          <span class="label">Sessions in this directory</span>
          <div class="session-list" id="sessionList"></div>
        </div>
      </details>
      <details class="fold" id="recoverField" hidden>
        <summary>Reopen a past session <span class="fold-count" id="recoverCount"></span></summary>
        <div class="recover-list" id="recoverList"></div>
      </details>
      <details class="fold" id="liveField" hidden>
        <summary>Agents running now <span class="fold-count" id="liveCount"></span></summary>
        <div class="recover-list" id="liveList"></div>
      </details>
      <button class="primary" id="startBtn">Start agent</button>
    </div>
```

- [ ] **Step 3: Feed the counters**

In `refreshLiveList`, replace `field.hidden = false;` (line ~2202) with:

```js
    field.hidden = false;
    $("liveCount").textContent = "(" + live.length + ")";
```

In `refreshRecoverList`, replace `field.hidden = false;` (line ~2243) with:

```js
    field.hidden = false;
    $("recoverCount").textContent = "(" + sessions.length + ")";
```

The `field.hidden = true` of the empty cases stays unchanged: a section with no
item stays entirely hidden, as it does today.

- [ ] **Step 4: Griser profil + worktree hors mode `new`**

Replace the radios' handler (lines 2679-2688) with:

```js
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => {
      const mode = document.querySelector('input[name="mode"]:checked').value;
      const isNew = mode === "new";
      $("resumeField").hidden = mode !== "resume";
      // Profile and worktree only apply to a new session: startActiveTab
      // already ignores them on resume/continue, the UI simply stops hiding it.
      $("profileField").classList.toggle("na", !isNew);
      $("profileNaNote").hidden = isNew;
      $("worktreeField").classList.toggle("na", !isNew);
      $("worktreeInput").disabled = !isNew;
      if (mode === "resume") refreshSessionList();
    })
  );
```

- [ ] **Step 5: Check**

Run: `npm run build && npm test`
Expected: PASS.

Run: `grep -n 'style.opacity' public/index.html | grep -i worktree`
Expected: no result — the old inline dimming is gone.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "A shorter box: past sessions and resume folded, Start always visible"
```

---

### Task 7: Browser verification and a documentation update

**Files:**
- Modify: `CLAUDE.md` (table « Architecture map » : ligne `public/index.html`,
  plus a line for `public/profile-card.js`)

`docs/architecture.md` does not describe the creation box (checked: no
occurrence de `profileInput`, `New link` ni `new channel`) — ne rien y changer.

**Interfaces:**
- Consumes: everything above.
- Produces: rien de programmatique.

- [ ] **Step 1: Run YOUR build without breaking the sibling sessions**

Follow "Running YOUR build" in `CLAUDE.md` exactly: note the supervisor's and
its child's pids, stop them, set `"autoUpdate": false` in
`~/.shadok-ai/config.json` (back the file up first — `SHADOK_AUTOUPDATE=0` is not
enough), then from the worktree:

```bash
npm run build && node dist/server.js
```

Confirmer qu'on est bien sur son build :

```bash
curl -s localhost:3789/version
```
Expected: `current` = `0.1.0` (the local version), not the published one.

- [ ] **Step 2: Go through the visual checklist at http://localhost:3789**

- [ ] The left-hand column says `Agents` and `＋ new agent`.
- [ ] The box opens on `New agent`, then `Which agent?` and its cards.
- [ ] Chaque carte montre nom, blurb sur 2 lignes max, badges corrects
      (`read-only` sur Shadok-Marketing et Shadok-Support, `full access` sur
      Shadok-dev).
- [ ] A click selects (an amber border); Tab enters the grid, the arrows move
      the selection, Space commits.
- [ ] `✎ edit profiles` opens the empty panel; a card's `✎` opens it prefilled;
      on closing, the grid is up to date.
- [ ] The three `▸` sections are closed on opening, with their counter.
- [ ] The whole box, `Start agent` button included, fits without scrolling in an
      800 px-tall window.
- [ ] Switching to `latest in directory` dims the cards and the worktree, and
      affiche « Applies to new sessions only ».
- [ ] Start an agent with a profile, reopen a box on the same directory: the
      card is preselected.

- [ ] **Step 3: Restore the runtime**

Put the original `~/.shadok-ai/config.json` back, stop `node dist/server.js`,
then relaunch the detached supervisor from the repo (`node dist/main.js`).
Confirmer : `curl -s -o /dev/null -w '%{http_code}' localhost:3789/` → `200`.

- [ ] **Step 4: Update the documentation**

In `CLAUDE.md`, the `public/index.html` table row: replace "Channels, groups,
dialogs, …" with "Agents (profile cards at creation), groups, dialogs, …". Add a
table row for `public/profile-card.js`: "Labels derived from a profile (blurb +
badges) for the \"New agent\" box's cards. ESM: loaded by the browser AND
imported
par `test/profile-card.test.ts`. »

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "Docs: the creation box is profile-first"
```

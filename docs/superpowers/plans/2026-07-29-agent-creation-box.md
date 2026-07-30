# Agent creation box (profile-first) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire du profil le point d'entrée de la création d'un agent, réduire la
hauteur de la box en repliant les sections rares, et parler d'« agent » plutôt
que de « channel ».

**Architecture:** Tout se passe dans `public/index.html` (client sans framework
ni build) plus un petit module ESM pur `public/profile-card.js` pour les
libellés dérivés d'un profil — même pattern que `public/live-text.js`, donc
testable sous `node --test`. Aucun changement de protocole, d'endpoint ni de
persistance : le message WS `start` garde son champ `profile`, `src/channels.ts`
n'est pas touché.

**Tech Stack:** HTML/CSS/JS vanilla ESM côté client, `node --import tsx --test`
côté tests, TypeScript/Express côté serveur (`express.static("public")` sert
déjà tout nouveau fichier de `public/`).

**Spec:** `docs/superpowers/specs/2026-07-29-agent-creation-box-design.md`

## Global Constraints

- **Copie UI en anglais.** Tous les libellés visibles sont en anglais (le reste
  de l'UI l'est) : `Agents`, `＋ new agent`, `New agent`, `Which agent?`,
  `∅ No profile`, `plain Claude`, `Start agent`.
- **Commentaires de code en français**, expliquant le *pourquoi* — convention du
  dépôt (`CLAUDE.md`, section Conventions).
- **Aucun champ ajouté au type `Profile`** (`src/profiles.ts` n'est pas
  modifié) : les cartes se déduisent de `name`, `systemPrompt`, `deny`, `model`,
  `secrets`.
- **Aucun renommage d'identifiant de code, d'endpoint, de clé `localStorage` ni
  de fichier de persistance.** Le renommage est purement cosmétique. En
  particulier `cp.channels`, `/channels`, `/channel`, `src/channels.ts` et le
  nom forcé `general` du canal principal restent tels quels.
- **Ne jamais redémarrer le serveur shadok-ai** pendant l'implémentation : ça
  tuerait les sessions sœurs (`CLAUDE.md`, invariant 8).
- Après toute étape touchant le serveur : `npm run build`. Les tâches ci-dessous
  ne touchent au TypeScript que dans la tâche 2 (`src/telegram.ts`).
- Un commit par tâche, message en français.

---

### Task 1: Module pur `profile-card.js` (libellés dérivés)

**Files:**
- Create: `public/profile-card.js`
- Test: `test/profile-card.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: deux fonctions pures exportées, utilisées par la tâche 3 via
  `window.profileBlurb` / `window.profileBadges` :
  - `profileBlurb(profile: {name?, systemPrompt?}) => string` — une ligne de
    présentation, `""` si pas de `systemPrompt`.
  - `profileBadges(profile: {deny?, model?, secrets?}) => string[]` — liste de
    badges courts, toujours au moins un élément.

- [ ] **Step 1: Write the failing test**

Créer `test/profile-card.test.ts` :

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { profileBlurb, profileBadges } from "../public/profile-card.js";

test("blurb: garde la 1re phrase et retire l'amorce « You are <nom>, »", () => {
  const p = {
    name: "Shadok-Marketing",
    systemPrompt:
      "You are Shadok-Marketing, the paid-marketing & growth agent. Read the product's code, docs and site to understand exactly what it does.",
  };
  assert.equal(profileBlurb(p), "the paid-marketing & growth agent.");
});

test("blurb: un nom à tiret n'est pas coupé en deux", () => {
  const p = {
    name: "Shadok-dev",
    systemPrompt:
      "You are Shadok-dev, a senior software engineer on this project. Make small, well-tested changes.",
  };
  assert.equal(profileBlurb(p), "a senior software engineer on this project.");
});

test("blurb: pas de systemPrompt → chaîne vide", () => {
  assert.equal(profileBlurb({ name: "x" }), "");
  assert.equal(profileBlurb({ name: "x", systemPrompt: "   " }), "");
  assert.equal(profileBlurb(null), "");
});

test("blurb: prompt sans point final → tout le texte, tronqué si besoin", () => {
  assert.equal(profileBlurb({ name: "x", systemPrompt: "just a role" }), "just a role");
});

test("blurb: phrase trop longue → troncature sur une frontière de mot", () => {
  const long = "You are Bob, " + "alpha ".repeat(30).trim() + ".";
  const out = profileBlurb({ name: "Bob", systemPrompt: long });
  assert.ok(out.endsWith("…"), "doit finir par une ellipse");
  assert.ok(out.length <= 91, "90 caractères + l'ellipse");
  assert.ok(!out.slice(0, -1).endsWith(" "), "pas d'espace avant l'ellipse");
  assert.ok(out.startsWith("alpha alpha"), "l'amorce est retirée");
});

test("badges: deny vide → full access, deny rempli → read-only", () => {
  assert.deepEqual(profileBadges({ name: "x" }), ["full access"]);
  assert.deepEqual(profileBadges({ name: "x", deny: [] }), ["full access"]);
  assert.deepEqual(profileBadges({ name: "x", deny: ["Bash(git commit:*)"] }), ["read-only"]);
});

test("badges: modèle et secrets, dans l'ordre accès → modèle → secrets", () => {
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

Créer `public/profile-card.js` :

```js
// Libellés dérivés d'un Profile pour les cartes de la box « New agent » —
// voir docs/superpowers/specs/2026-07-29-agent-creation-box-design.md.
//
// Chargé tel quel par le navigateur (ESM) et importé par les tests node/tsx,
// comme public/live-text.js.
//
// Rien n'est ajouté au type Profile : tout se déduit de ce qui existe déjà
// (systemPrompt, deny, model, secrets), donc les profils déjà enregistrés
// s'affichent sans migration ni formulaire à re-remplir.

/** Au-delà, la carte deviendrait un pavé : on tronque. */
const MAX_BLURB = 90;

/**
 * Une ligne de présentation tirée du systemPrompt : sa première phrase, sans
 * le « You are <nom>, » d'amorce — redondant avec le titre de la carte — et
 * tronquée sur une frontière de mot. "" si le profil n'a pas de prompt.
 */
export function profileBlurb(profile) {
  const raw = ((profile && profile.systemPrompt) || "").trim();
  if (!raw) return "";
  // Première phrase : premier « . » suivi d'un espace ou de la fin.
  const m = raw.match(/^[\s\S]*?\.(?=\s|$)/);
  let s = (m ? m[0] : raw).trim();
  // Le nom peut contenir un tiret (Shadok-dev) : on ne coupe que sur « , » ou
  // un tiret cadratin, jamais sur le trait d'union du nom lui-même.
  s = s.replace(/^you are\s+[^,—]{1,40}?\s*[,—]\s*/i, "");
  if (s.length <= MAX_BLURB) return s;
  const cut = s.slice(0, MAX_BLURB);
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut).replace(/[.,;:]$/, "") + "…";
}

/**
 * Les garde-fous du profil en badges courts : accès git (le seul qui compte
 * vraiment au moment de choisir), modèle forcé, nombre de secrets injectés.
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

Puis la suite complète, pour vérifier qu'on n'a rien cassé :
Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/profile-card.js test/profile-card.test.ts
git commit -m "Libellés dérivés d'un profil (blurb + badges), module pur testé"
```

---

### Task 2: Renommage « channel » → « agent » dans la copie visible

**Files:**
- Modify: `public/index.html` (lignes 884, 917, 920, 996, 997, 1000, 1001, 1007, 1008-1010, 1037, 1147, 1157, 1286, 2134, 2974, 2975)
- Modify: `src/telegram.ts` (lignes 856, 926, 941, 981)

**Interfaces:**
- Consumes: rien.
- Produces: rien de programmatique — uniquement de la copie.

**Rappel:** aucun identifiant, endpoint (`/channels`, `/channel`), clé
`localStorage` (`cp.channels`) ni nom de fichier ne change. Seul le texte
affiché change.

- [ ] **Step 1: Renommer la colonne de gauche et la box**

Dans `public/index.html`, appliquer exactement :

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

- [ ] **Step 2: Renommer les libellés restants du client**

Toujours dans `public/index.html` :

```html
<!-- ligne 884 -->
  <button id="cronBtn" title="Scheduled prompts for this agent (monitoring / reporting)">⏰ Schedule</button>
```

```html
<!-- ligne 917 -->
      <strong>⏰ Schedule — <span id="cronChanName">this agent</span></strong>
```

Ligne 920, remplacer `<b>this channel's agent</b>` par `<b>this agent</b>` (le
reste du paragraphe est inchangé).

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

- [ ] **Step 3: Renommer la copie Telegram**

Dans `src/telegram.ts` :

- ligne 856 (aide `/help`) : `"/tools [on|off] — show or hide tool calls in this channel"` → `"/tools [on|off] — show or hide tool calls in this agent"`
- ligne 926 : `"🔧 tool calls shown in this channel."` → `"…in this agent."` et `"🔧 tool calls hidden in this channel."` → `"…in this agent."`
- ligne 941 : `"⏰ Scheduled prompts for this channel:\n"` → `"⏰ Scheduled prompts for this agent:\n"`
- ligne 981 : `"Send a message here first to create the channel, then schedule.\n\n"` → `"Send a message here first to create the agent, then schedule.\n\n"`

- [ ] **Step 4: Vérifier qu'il ne reste aucune copie visible « channel »**

Run:
```bash
grep -nE '"[^"]*[Cc]hannel[^"]*"|>[^<]*[Cc]hannel[^<]*<' public/index.html | grep -vE '/channels?|cp\.channels|persistChannels|dismissedChannels|channelPushTimer'
```
Expected: **aucun résultat**. Ce grep isole exactement les 12 libellés listés aux
steps 1-2 (vérifié avant modification) : s'il ne renvoie plus rien, la copie est
complète. Les commentaires CSS/JS qui parlent encore de « channel » restent tels
quels — ils décrivent le code, dont les identifiants n'ont pas changé.

- [ ] **Step 5: Build + tests**

Run: `npm run build && npm test`
Expected: PASS. (`test/telegram.test.ts` existe : si une assertion portait sur
une de ces chaînes, la mettre à jour dans le même commit.)

- [ ] **Step 6: Commit**

```bash
git add public/index.html src/telegram.ts
git commit -m "L'UI parle d'agents, plus de canaux (copie seulement)"
```

---

### Task 3: Grille de cartes de profil à la place du `<select>`

**Files:**
- Modify: `public/index.html` — CSS après la ligne ~397, markup lignes
  1033-1036, import ESM ligne 1093-1096, `startActiveTab` ligne ~2289, bloc
  Profiles lignes 3032-3046 et 3115-3118.

**Interfaces:**
- Consumes: `profileBlurb` / `profileBadges` de la tâche 1.
- Produces, pour les tâches 4 à 6 :
  - `let selectedProfile` (string) — le nom du profil choisi, `""` pour aucun.
  - `renderProfileGrid(failed?: boolean)` — repeint la grille depuis
    `profileCache`.
  - `selectProfile(name: string, byUser?: boolean)` — pose la sélection.
  - `syncProfileSelection()` — reflète `selectedProfile` sur le DOM et retombe
    sur `""` si le profil sélectionné n'existe plus.
  - `openProfilesPanel(profile?)` — ouvre l'overlay, prérempli si un profil est
    passé.

- [ ] **Step 1: Ajouter le CSS des cartes**

Dans `public/index.html`, juste après la règle `input[type="radio"]`
(ligne ~382, avant le commentaire `/* Session picker (resume by id) */`) :

```css
  /* Cartes de profil — le profil est LE choix structurant d'un agent (rôle,
     garde-fous, secrets, modèle), donc en tête de la box et cliquable. */
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
  /* Le crayon n'apparaît qu'au survol : il ne doit pas concurrencer le nom. */
  .pc-edit { position: absolute; top: 6px; right: 7px; font-size: 11px; color: var(--text-dim); opacity: 0; }
  .profile-card:hover .pc-edit, .profile-card:focus-within .pc-edit { opacity: 1; }
  .pc-edit:hover { color: var(--amber); }
  .grid-note { grid-column: 1 / -1; color: var(--text-dim); font-size: 12px; font-style: italic; }
  /* Champ sans effet dans le mode courant (resume/continue) — visible mais inerte. */
  .na { opacity: .45; pointer-events: none; }
```

- [ ] **Step 2: Remplacer le markup du champ Profile**

Remplacer les lignes 1033-1036 :

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

Puis **déplacer ce bloc** juste après le `<p class="hint">` (ligne 1010), avant
le champ `Working directory` : qui d'abord, où ensuite.

Note : `#editProfilesLink` n'est branché qu'en tâche 4 — à la fin de cette
tâche, le lien est visible mais inerte. C'est volontaire : la tâche 3 livre la
grille, la tâche 4 livre les raccourcis d'édition.

- [ ] **Step 3: Exposer les fonctions du module au script principal**

Ligne 1093-1096, étendre le pont ESM existant :

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
sert déjà `/profile-card.js` sans route à ajouter.

- [ ] **Step 4: Remplacer le rendu du select par la grille**

Dans le bloc « Profiles panel » (ligne 3032+), remplacer `loadProfilesInto`
(lignes 3036-3046) par :

```js
  let selectedProfile = "";    // nom du profil choisi dans la box, "" = aucun

  async function loadProfilesInto() {
    let failed = false;
    try { profileCache = await (await fetch("/profiles")).json(); }
    catch { profileCache = []; failed = true; }
    if (!Array.isArray(profileCache)) { profileCache = []; failed = true; }
    renderProfileGrid(failed);
  }

  /** Peint la grille de la box. La carte « No profile » est toujours présente :
   *  c'est le défaut, et le seul recours si /profiles est tombé. */
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
    grid.appendChild(profileCardEl(null));      // ∅ No profile, toujours en dernier
    syncProfileSelection();
  }

  /** Une carte = un <button role="radio">. p === null → la carte « No profile ». */
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

  /** Reflète selectedProfile sur les cartes. Un seul tabindex=0 dans le groupe :
   *  c'est la convention radiogroup (Tab entre, flèches naviguent). */
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

  /** Flèches = déplacer la sélection (convention radiogroup). Espace/Entrée
   *  sont déjà le clic natif du <button>. */
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

`profileTouched` est déclaré en tâche 5 ; pour que cette tâche compile seule,
ajouter dès maintenant, juste au-dessus de `let selectedProfile = "";` :

```js
  let profileTouched = false;  // l'utilisateur a choisi à la main (voir tâche 5)
```

- [ ] **Step 5: Brancher `startActiveTab` sur la nouvelle sélection**

Ligne ~2289, remplacer :

```js
    if (mode === "new" && $("profileInput") && $("profileInput").value) msg.profile = $("profileInput").value;
```

par :

```js
    if (mode === "new" && selectedProfile) msg.profile = selectedProfile;
```

- [ ] **Step 6: Corriger le commentaire de l'appel initial**

Ligne 3118 : `loadProfilesInto(); // populate the setup selector on load` →
`loadProfilesInto(); // peint la grille de profils de la box au chargement`

- [ ] **Step 7: Vérifier**

Run: `npm run build && npm test`
Expected: PASS.

Run: `grep -n "profileInput" public/index.html`
Expected: **aucun résultat** — l'ancien `<select>` a totalement disparu.

- [ ] **Step 8: Commit**

```bash
git add public/index.html
git commit -m "Le profil devient des cartes en tête de la box, plus un select"
```

---

### Task 4: Raccourcis d'édition, état vide, état d'erreur

**Files:**
- Modify: `public/index.html` — bloc Profiles (lignes ~3032-3120), gestionnaire
  Échap (ligne ~2863).

**Interfaces:**
- Consumes: `renderProfileGrid`, `profileCardEl`, `loadProfilesInto`,
  `fillProfileForm`, `clearProfileForm`, `renderProfilesList` (existants).
- Produces: `openProfilesPanel(profile?)` et `closeProfilesPanel()`, utilisés
  par `#profilesBtn`, `#editProfilesLink`, `#profilesClose`, le clic sur le
  fond et la touche Échap.

- [ ] **Step 1: Factoriser ouverture / fermeture du panneau**

Remplacer les lignes 3115-3117 :

```js
  $("profilesBtn").addEventListener("click", async () => { await loadProfilesInto(); renderProfilesList(); clearProfileForm(); $("profilesOverlay").hidden = false; });
  $("profilesClose").addEventListener("click", () => { $("profilesOverlay").hidden = true; });
  $("profilesOverlay").addEventListener("click", (e) => { if (e.target === $("profilesOverlay")) $("profilesOverlay").hidden = true; });
```

par :

```js
  /** Ouvre le panneau Profiles, prérempli sur `p` si on vient du crayon d'une carte. */
  async function openProfilesPanel(p) {
    await loadProfilesInto();
    renderProfilesList();
    if (p) fillProfileForm(p); else clearProfileForm();
    $("profilesOverlay").hidden = false;
  }
  /** Fermer repeint la grille : un profil créé apparaît tout de suite, et la
   *  sélection retombe sur « No profile » si le profil choisi a été supprimé
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

- [ ] **Step 2: Fermer par Échap doit aussi repeindre**

Ligne ~2863, remplacer :

```js
    if (!$("profilesOverlay").hidden) { $("profilesOverlay").hidden = true; e.preventDefault(); return; }
```

par :

```js
    if (!$("profilesOverlay").hidden) { closeProfilesPanel(); e.preventDefault(); return; }
```

- [ ] **Step 3: Ajouter le crayon par carte**

Dans `profileCardEl`, à l'intérieur du `if (p) { … }` et **après** l'ajout des
badges, insérer :

```js
      // Raccourci : éditer CE profil sans passer par la barre du haut.
      const pen = document.createElement("span");
      pen.className = "pc-edit";
      pen.textContent = "✎";
      pen.title = "Edit " + p.name;
      pen.addEventListener("click", (e) => {
        e.stopPropagation();          // éditer, pas sélectionner la carte
        openProfilesPanel(p);
      });
      card.appendChild(pen);
```

- [ ] **Step 4: Ajouter l'état « aucun profil »**

Dans `renderProfileGrid`, entre le bloc `if (failed)` et la boucle
`for (const p of profileCache)` :

```js
    // Zéro profil : on montre la porte d'entrée plutôt qu'un « (none) » muet.
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

Cette carte n'a **pas** `role="radio"` : elle est donc ignorée par
`syncProfileSelection` et par la navigation aux flèches, et la carte
« No profile » reste la sélection par défaut.

- [ ] **Step 5: Vérifier**

Run: `npm run build && npm test`
Expected: PASS.

Vérification manuelle dans le navigateur (voir tâche 7 pour le lancement) :
`✎ edit profiles` ouvre le panneau vide ; le `✎` d'une carte l'ouvre prérempli
sur ce profil ; Échap le ferme et la grille se rafraîchit.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "Éditer un profil depuis la box, et une porte d'entrée quand il n'y en a aucun"
```

---

### Task 5: Mémoriser le dernier profil utilisé, par dossier

**Files:**
- Modify: `public/index.html` — `refreshChrome` (lignes ~1692-1703),
  `startActiveTab` (lignes ~2277-2293), gestionnaire `cwdInput` (ligne ~2689),
  bloc Profiles (déclarations).

**Interfaces:**
- Consumes: `selectProfile`, `selectedProfile`, `profileTouched` (tâche 3).
- Produces: `applyRememberedProfile()` et la variable `profileTab`.

- [ ] **Step 1: Ajouter la fonction de rappel**

Dans le bloc Profiles, juste après `syncProfileSelection`, ajouter :

```js
  let profileTab = null;   // onglet pour lequel la mémoire a déjà été appliquée

  /** Présélectionne le dernier profil utilisé DANS CE DOSSIER (à défaut, le
   *  dernier utilisé tout court) : le cas courant devient un clic + Start.
   *  Une clé vide est une valeur légitime — « No profile » choisi exprès — d'où
   *  le test sur null et non sur la vérité de la chaîne. */
  function applyRememberedProfile() {
    const cwd = $("cwdInput").value.trim();
    const perDir = cwd ? localStorage.getItem("cp.profile:" + cwd) : null;
    const remembered = perDir !== null ? perDir : (localStorage.getItem("cp.profile") || "");
    selectProfile(remembered);   // syncProfileSelection retombe sur "" s'il n'existe plus
  }
```

- [ ] **Step 2: Appliquer le rappel quand la box s'ouvre sur un onglet**

Dans `refreshChrome`, bloc `if (t.status === "setup") { … }` (ligne ~1692),
après `$("startBtn").disabled = false;` :

```js
      // refreshChrome tourne souvent : on ne rappelle la mémoire qu'au premier
      // passage sur CET onglet, sinon on écraserait le choix de l'utilisateur.
      if (profileTab !== t) { profileTab = t; profileTouched = false; applyRememberedProfile(); }
```

- [ ] **Step 3: Ré-appliquer quand le dossier change**

Gestionnaire `$("cwdInput").addEventListener("change", …)` (ligne ~2689) :

```js
  $("cwdInput").addEventListener("change", () => {
    if (!$("resumeField").hidden) refreshSessionList();
    refreshRecoverList();
    // Un autre dossier a peut-être son propre habitué — sauf si on a déjà choisi.
    if (!profileTouched) applyRememberedProfile();
  });
```

- [ ] **Step 4: Écrire la mémoire au lancement**

Dans `startActiveTab`, après `localStorage.setItem("cp.cwd", cwd);` :

```js
    if (mode === "new") {
      localStorage.setItem("cp.profile", selectedProfile);
      if (cwd) localStorage.setItem("cp.profile:" + cwd, selectedProfile);
    }
```

- [ ] **Step 5: Vérifier**

Run: `npm run build && npm test`
Expected: PASS.

Vérification manuelle : lancer un agent avec un profil, ouvrir une nouvelle box
sur le même dossier → la carte est présélectionnée. Changer le dossier pour un
autre déjà utilisé → l'habitué de ce dossier se sélectionne. Choisir une carte à
la main puis changer de dossier → le choix manuel tient.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "Le dernier profil utilisé dans un dossier est présélectionné"
```

---

### Task 6: Replier les sections rares (`<details>`) et grisage hors mode `new`

**Files:**
- Modify: `public/index.html` — CSS (après le bloc des cartes), markup
  1015-1045, `refreshLiveList` (~2194), `refreshRecoverList` (~2233),
  gestionnaire des radios `mode` (~2679).

**Interfaces:**
- Consumes: `#profileField`, `#profileNaNote` (tâche 3).
- Produces: `#advancedField`, `#recoverField`, `#liveField` en `<details>` avec
  les compteurs `#recoverCount` et `#liveCount`.

- [ ] **Step 1: Ajouter le CSS des sections repliables**

Après le bloc CSS des cartes (tâche 3) :

```css
  /* Sections rares repliées : c'est ce qui empêchait le bouton Start de tenir
     à l'écran (les listes s'ouvraient d'office dès qu'elles avaient un élément). */
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

- [ ] **Step 2: Passer les trois sections en `<details>`**

Les numéros de ligne ont bougé en tâche 3 : remplacer **tout le contenu de
`<div id="setup" hidden>`** par ce bloc final, qui fixe l'ordre définitif
(qui → où → le rare, replié → action). Le champ `Resume` perd son
`<span class="label">Resume</span>` : le `<summary>` le remplace.

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

- [ ] **Step 3: Alimenter les compteurs**

Dans `refreshLiveList`, remplacer `field.hidden = false;` (ligne ~2202) par :

```js
    field.hidden = false;
    $("liveCount").textContent = "(" + live.length + ")";
```

Dans `refreshRecoverList`, remplacer `field.hidden = false;` (ligne ~2243) par :

```js
    field.hidden = false;
    $("recoverCount").textContent = "(" + sessions.length + ")";
```

Les `field.hidden = true` des cas vides restent inchangés : une section sans
élément reste totalement masquée, comme aujourd'hui.

- [ ] **Step 4: Griser profil + worktree hors mode `new`**

Remplacer le gestionnaire des radios (lignes 2679-2688) par :

```js
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => {
      const mode = document.querySelector('input[name="mode"]:checked').value;
      const isNew = mode === "new";
      $("resumeField").hidden = mode !== "resume";
      // Profil et worktree ne valent que pour une session neuve : startActiveTab
      // les ignore déjà en resume/continue, l'UI cesse simplement de le cacher.
      $("profileField").classList.toggle("na", !isNew);
      $("profileNaNote").hidden = isNew;
      $("worktreeField").classList.toggle("na", !isNew);
      $("worktreeInput").disabled = !isNew;
      if (mode === "resume") refreshSessionList();
    })
  );
```

- [ ] **Step 5: Vérifier**

Run: `npm run build && npm test`
Expected: PASS.

Run: `grep -n 'style.opacity' public/index.html | grep -i worktree`
Expected: aucun résultat — l'ancien grisage inline a disparu.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "Box plus courte : sessions passées et resume repliés, Start toujours visible"
```

---

### Task 7: Vérification navigateur et mise à jour de la doc

**Files:**
- Modify: `CLAUDE.md` (table « Architecture map » : ligne `public/index.html`,
  plus une ligne pour `public/profile-card.js`)

`docs/architecture.md` ne décrit pas la box de création (vérifié : aucune
occurrence de `profileInput`, `New link` ni `new channel`) — ne rien y changer.

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: rien de programmatique.

- [ ] **Step 1: Lancer SON build sans casser les sessions sœurs**

Suivre exactement « Running YOUR build » de `CLAUDE.md` : noter les pid du
superviseur et de son fils, les arrêter, passer `"autoUpdate": false` dans
`~/.shadok-ai/config.json` (une sauvegarde du fichier d'abord — `SHADOK_AUTOUPDATE=0`
ne suffit pas), puis depuis le worktree :

```bash
npm run build && node dist/server.js
```

Confirmer qu'on est bien sur son build :

```bash
curl -s localhost:3789/version
```
Expected: `current` = `0.1.0` (la version locale), pas la version publiée.

- [ ] **Step 2: Passer la checklist visuelle sur http://localhost:3789**

- [ ] La colonne de gauche dit `Agents` et `＋ new agent`.
- [ ] La box s'ouvre sur `New agent` puis `Which agent?` et ses cartes.
- [ ] Chaque carte montre nom, blurb sur 2 lignes max, badges corrects
      (`read-only` sur Shadok-Marketing et Shadok-Support, `full access` sur
      Shadok-dev).
- [ ] Un clic sélectionne (bordure ambre) ; Tab entre dans la grille, les
      flèches déplacent la sélection, Espace valide.
- [ ] `✎ edit profiles` ouvre le panneau vide ; le `✎` d'une carte l'ouvre
      prérempli ; à la fermeture la grille est à jour.
- [ ] Les trois sections `▸` sont fermées à l'ouverture, avec leur compteur.
- [ ] La box entière, bouton `Start agent` compris, tient sans scroll dans une
      fenêtre de 800 px de haut.
- [ ] Passer en `latest in directory` grise les cartes et le worktree, et
      affiche « Applies to new sessions only ».
- [ ] Démarrer un agent avec un profil, rouvrir une box sur le même dossier :
      la carte est présélectionnée.

- [ ] **Step 3: Restaurer le runtime**

Remettre `~/.shadok-ai/config.json` d'origine, arrêter `node dist/server.js`,
puis relancer le superviseur détaché depuis le dépôt (`node dist/main.js`).
Confirmer : `curl -s -o /dev/null -w '%{http_code}' localhost:3789/` → `200`.

- [ ] **Step 4: Mettre la doc à jour**

Dans `CLAUDE.md`, ligne de la table `public/index.html` : remplacer
« Channels, groups, dialogs, … » par « Agents (cartes de profil à la création),
groups, dialogs, … ». Ajouter une ligne à la table pour
`public/profile-card.js` : « Libellés dérivés d'un profil (blurb + badges) pour
les cartes de la box « New agent ». ESM : chargé par le navigateur ET importé
par `test/profile-card.test.ts`. »

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "Doc : la box de création est orientée profil"
```

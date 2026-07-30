# Touche Échap → esc à la session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La touche Échap du clavier, dans le chat, envoie esc à la session active (comme le bouton Esc de l'engine room), avec des garde-fous pour les overlays/panneaux et les dialogues.

**Architecture:** Un unique `document.addEventListener("keydown", …)` dans `public/index.html`, avec une précédence : fermer un overlay/panneau ouvert, sinon ignorer si un dialogue clickable est en attente, sinon envoyer `{type:"key", key:"escape"}` sur `active.ws`. Réutilise le message WS déjà émis par les boutons de l'engine room.

**Tech Stack:** HTML/CSS/JS vanilla (pas de build front, pas de framework de test JS). Vérification = navigateur.

## Global Constraints

- Frontend uniquement : ne modifier que `public/index.html`. Aucun changement serveur ni de protocole.
- Réutiliser le message existant `active.ws.send(JSON.stringify({ type: "key", key: "escape" }))` (identique aux boutons `.keys button[data-key]`, ~ligne 2517).
- `active` = onglet courant, avec `.ws` (WebSocket), `.status` ("setup"|"ready"|"busy"|"connecting"|"dead"), `.dialogBubble` (non-null ⇒ dialogue clickable en attente ; remis à null par `retireChoices`).
- Ids existants : `#secretsOverlay` (modal, prop `hidden`), `#profilesOverlay` (modal, `hidden`), `#diffpanel` (aside, classe `.open`), `#machine` (engine room, `.open`).
- L'engine room (`#machine.open`) n'est **pas** fermé par Échap : Échap y envoie esc.
- L'inline-edit fait déjà `e.stopPropagation()` ⇒ ne pas le gérer, il n'atteint pas le handler document.

---

### Task 1: Handler Échap au niveau document

**Files:**
- Modify: `public/index.html` — insérer après le bloc `.keys button[data-key]` forEach (après la ligne `);` ~2519, avant `$("settleBtn")…`).

**Interfaces:**
- Consomme : `$()` (helper `document.getElementById`), `active` (onglet courant global), `active.ws/.status/.dialogBubble`.
- Produit : aucun symbole nouveau (un listener anonyme).

- [ ] **Step 1 : Insérer le handler**

Dans `public/index.html`, juste après :

```js
  document.querySelectorAll(".keys button[data-key]").forEach((b) =>
    b.addEventListener("click", () => {
      if (active.ws) active.ws.send(JSON.stringify({ type: "key", key: b.dataset.key }));
    })
  );
```

ajouter :

```js
  // La touche Échap envoie esc à la session active (comme le bouton Esc de
  // l'engine room). Précédence : un overlay/panneau ouvert est fermé d'abord
  // (Échap ne descend pas jusqu'à la session) ; un dialogue clickable en
  // attente est laissé intact ; sinon on envoie esc. L'engine room ouvert n'est
  // PAS un panneau à fermer — c'est le terminal, Échap y envoie esc.
  // L'inline-edit fait stopPropagation, donc ce handler ne le voit pas.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // 1. Overlays / panneaux ouverts → fermer, pas d'esc.
    if (!$("secretsOverlay").hidden) { $("secretsOverlay").hidden = true; e.preventDefault(); return; }
    if (!$("profilesOverlay").hidden) { $("profilesOverlay").hidden = true; e.preventDefault(); return; }
    if ($("diffpanel").classList.contains("open")) { $("diffpanel").classList.remove("open"); e.preventDefault(); return; }
    // 2. Dialogue clickable en attente de réponse → ne rien faire.
    if (active && active.dialogBubble) return;
    // 3. Session active (engine room ouvert inclus) → envoyer esc.
    if (active && active.ws && active.status !== "setup") {
      active.ws.send(JSON.stringify({ type: "key", key: "escape" }));
      e.preventDefault();
    }
  });
```

- [ ] **Step 2 : Build**

Run : `cd ~/projects/shadok-ai/.claude/worktrees/esc-key-interrupt && npm run build`
Expected : compile sans erreur (aucun `.ts` touché).

- [ ] **Step 3 : Commit**

```bash
git add public/index.html
git commit -m "Chat : la touche Échap envoie esc à la session (comme le bouton du terminal)"
```

- [ ] **Step 4 : Vérification navigateur (après restart déclenché par l'humain)**

Ouvrir une session active dans http://localhost:3789 et vérifier :
1. Focus dans le composer, Claude en train de bosser → Échap interrompt le tour (comme le bouton Esc de l'engine room).
2. Engine room ouvert → Échap envoie esc (ne ferme pas l'engine room).
3. Ouvrir le panneau Diff → Échap le ferme (n'envoie pas esc). Idem overlays Secrets et Profils.
4. Dialogue clickable affiché (question TUI) → Échap ne fait rien ; les boutons restent cliquables.
5. Renommer un onglet inline, presser Échap → annule le renommage (inchangé), pas d'esc.
6. Aucune session (écran setup) → Échap ne perturbe rien.

---

## Self-Review

**1. Spec coverage :**
- Overlays/panneaux fermés en priorité (secrets → profils → diff) → Step 1, points 1 ✓
- Engine room ouvert → esc (non fermé) → Step 1, tombe au point 3 car `#machine` non testé ✓
- Dialogue en attente → rien → Step 1, point 2 ✓
- Session active → esc → Step 1, point 3 ✓
- Inline-edit inchangé (stopPropagation) → non géré volontairement ✓
- Aucune session → rien → point 3 faux (pas de `active.ws`) ✓
- Build + vérif navigateur → Steps 2, 4 ✓

**2. Placeholder scan :** aucun ; code complet fourni.

**3. Type consistency :** `active`, `active.ws`, `active.status`, `active.dialogBubble` utilisés conformément au reste du fichier (lignes 2517, 2521, 1826). `$()` helper existant. Ids `#secretsOverlay`/`#profilesOverlay`/`#diffpanel` existants.

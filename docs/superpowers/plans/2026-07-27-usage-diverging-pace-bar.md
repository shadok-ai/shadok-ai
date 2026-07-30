# Barre de pace divergente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer, pour chaque fenêtre d'usage (5h / 7d), les deux barres empilées (usage + pace) par une seule barre divergente centrée sur « au pace », vert à gauche (sous le pace) → ambre au centre → rouge à droite (au-dessus).

**Architecture:** Changement purement frontend dans `public/index.html`. On touche le CSS des jauges `.quota`, le markup des deux gauges, et la fonction JS `paintGauge`. Aucune donnée nouvelle : `/usage` sert déjà `usedPercentage`, `idealPacePct`, `ratioPct`, `resetsAt` par fenêtre. La position du remplissage est dérivée de `ratioPct` (centre = ratio 100), la couleur interpolée via `color-mix`.

**Tech Stack:** HTML/CSS/JS vanilla (pas de build front, pas de framework de test JS). Serveur TypeScript ESM (non touché). Vérification = navigateur.

## Global Constraints

- Frontend uniquement : ne modifier que `public/index.html`. Aucun changement serveur (`src/*.ts`), ni du protocole `/usage`.
- Réutiliser les variables CSS de thème existantes `--ok` (vert), `--amber`, `--err` (rouge), `--bg-inset`, `--line`, `--text-dim` — theme-aware (clair + sombre).
- Le centre de chaque barre = ratio 100 % (au pace). Échelle symétrique linéaire : `pos = clamp((ratioPct - 100) / 100, -1, +1)`. Bord gauche = ratio 0, bord droit = ratio ≥ 200.
- Information redondante position + couleur (accessibilité daltonien) : sous le pace = gauche, au-dessus = droite, indépendamment de la couleur.
- `w === null` (pas de données) → barre vide, chiffre `—`, tooltip = libellé de base. Pas de régression sur cet état.
- Ne PAS redémarrer le serveur soi-même (invariant #7 du CLAUDE.md) : la vérification navigateur se fait après un restart déclenché par l'humain.

---

### Task 1: Barre divergente (CSS + markup + rendu JS)

Tout tient dans `public/index.html` et change ensemble (structure, style, rendu). Une seule tâche cohérente.

**Files:**
- Modify: `public/index.html` — bloc CSS `.quota` (~lignes 84-113), markup `#quota5h`/`#quota7d` (~lignes 803-814), fonction `paintGauge` (~lignes 2631-2660).

**Interfaces:**
- Consomme : l'objet fenêtre servi par `/usage` — `{ usedPercentage:number, idealPacePct:number|null, ratioPct:number|null, resetsAt:number|null }`. Helper existant `fmtReset(resetsAt)` (retourne "" si null).
- Produit : `paintGauge(el, w)` (signature inchangée, appelée par `refreshUsage`) + nouveau helper `paceColor(ratio:number): string`.

- [ ] **Step 1 : Remplacer le CSS des jauges `.quota`**

Dans `public/index.html`, remplacer le bloc CSS actuel (le commentaire « Quota gauges … » jusqu'à la fin de `.quota .qpct`, ~lignes 84-113) par :

```css
  /* Quota gauges (5h / 7d subscription usage).
     Une barre divergente par fenêtre : le remplissage part du centre
     (= « au pace », ratio 100 %), vert vers la gauche quand on est SOUS le
     pace, rouge vers la droite quand on est AU-DESSUS. Position ET couleur
     portent l'info (accessibilité). */
  .quota { min-width: 92px; }
  .quota .meter {
    position: relative;
    height: 6px;
    background: var(--bg-inset);
    border: 1px solid var(--line);
    border-radius: 3px;
    overflow: hidden;
    margin: 2px 0;
  }
  /* Tick central « au pace ». */
  .quota .meter::before {
    content: "";
    position: absolute;
    left: 50%;
    top: 0; bottom: 0;
    width: 1px;
    margin-left: -0.5px;
    background: var(--text-dim);
    opacity: 0.55;
    z-index: 1;
  }
  /* Remplissage : left + width + background-color posés en inline par paintGauge. */
  .quota .fill {
    position: absolute;
    top: 0; bottom: 0;
    left: 50%;
    width: 0;
    background: var(--ok);
    transition: left 0.4s ease, width 0.4s ease, background-color 0.4s ease;
  }
  .quota .qpct {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-dim);
    white-space: nowrap;
  }
```

Note : on supprime les règles `.quota .meter.pace .fill`, `.quota.warn .meter.usage .fill`, `.quota.crit .meter.usage .fill` (la couleur devient continue, calculée en JS).

- [ ] **Step 2 : Remplacer le markup des deux gauges**

Remplacer (~lignes 803-814) les deux blocs à deux `.meter` par un seul `.meter` chacun :

```html
  <div class="gauge quota" id="quota5h" title="5-hour rolling limit">
    <span class="label">5h</span>
    <div class="meter"><span class="fill"></span></div>
    <span class="qpct">—</span>
  </div>
  <div class="gauge quota" id="quota7d" title="7-day rolling limit">
    <span class="label">7d</span>
    <div class="meter"><span class="fill"></span></div>
    <span class="qpct">—</span>
  </div>
```

- [ ] **Step 3 : Réécrire `paintGauge` + ajouter `paceColor`**

Remplacer la fonction `paintGauge` actuelle (~lignes 2631-2660) par :

```js
  /** Couleur du remplissage : dégradé continu vert → ambre → rouge selon le
   *  ratio usage/pace (0 → 100 → 200). L'ambre entoure le centre « au pace ». */
  function paceColor(ratio) {
    if (ratio <= 100) {
      const t = Math.round(Math.max(0, ratio));            // 0 → vert, 100 → ambre
      return "color-mix(in oklab, var(--ok), var(--amber) " + t + "%)";
    }
    const t = Math.round(Math.min(100, ratio - 100));      // 100 → ambre, 200 → rouge
    return "color-mix(in oklab, var(--amber), var(--err) " + t + "%)";
  }

  function paintGauge(el, w) {
    const fill = el.querySelector(".meter .fill");
    const pct = el.querySelector(".qpct");
    const base = el.id === "quota5h" ? "5-hour rolling limit" : "7-day rolling limit";
    if (!w) {
      fill.style.width = "0%";
      fill.style.left = "50%";
      fill.style.background = "var(--ok)";
      pct.textContent = "—";
      el.title = base;
      return;
    }
    const used = Math.round(w.usedPercentage);
    const pace = w.idealPacePct == null ? null : Math.round(w.idealPacePct);
    const ratio = w.ratioPct == null ? null : Math.round(w.ratioPct);
    // Sans ratio (pas de pace calculable), on centre : barre vide + tick seul.
    const r = ratio == null ? 100 : ratio;
    // Ratio → position [-1, +1] ; 50 % (centre) = au pace (ratio 100).
    const pos = Math.max(-1, Math.min(1, (r - 100) / 100));
    const half = Math.abs(pos) * 50;                       // % de la demi-largeur
    fill.style.left = (pos < 0 ? 50 - half : 50) + "%";
    fill.style.width = half + "%";
    fill.style.background = paceColor(r);
    pct.textContent = used + "%";
    // fmtReset renvoie "" si resetsAt est null (le séparateur part avec).
    const reset = fmtReset(w.resetsAt);
    el.title = base + " — " + used + "% used"
      + (pace === null ? "" : ", ideal pace " + pace + "% (" + ratio + "% of pace)")
      + (reset ? " · " + reset : "");
  }
```

- [ ] **Step 4 : Build (vérifie qu'on n'a rien cassé)**

Run : `cd ~/projects/shadok-ai && npm run build`
Expected : compile sans erreur (aucun `.ts` touché, mais on confirme que le repo build toujours).

- [ ] **Step 5 : Commit**

```bash
cd ~/projects/shadok-ai
git add public/index.html
git commit -m "Jauges d'usage : barre de pace divergente (vert/ambre/rouge, centrée au pace)"
```

- [ ] **Step 6 : Vérification navigateur (après restart déclenché par l'humain)**

Demander à l'humain de redémarrer le serveur (commande du CLAUDE.md), puis ouvrir http://localhost:3789 et vérifier :

1. Deux barres (5h, 7d), chacune **une seule** barre avec un tick central.
2. Avec les valeurs actuelles (5h ratio ~21 %, 7d ratio ~27 %) : remplissage **vert à gauche** du centre dans les deux cas (bien sous le pace).
3. Survol → tooltip `… — X% used, ideal pace Y% (Z% of pace) · resets in …`.
4. Chiffre compact = `% utilisé` à droite de la barre.
5. Bascule thème clair/sombre : couleurs et tick restent lisibles.
6. (Optionnel, sanity du côté droit) : dans la console, `paceColor(150)` → mix ambre→rouge à 50 %, `paceColor(30)` → mix vert→ambre à 30 %.

---

## Self-Review

**1. Spec coverage :**
- Barre divergente unique par fenêtre → Steps 1-3 ✓
- Centre = ratio 100, échelle symétrique `clamp((ratio-100)/100)` → Step 3 (`pos`) ✓
- Dégradé vert→ambre→rouge fonction du ratio → Step 3 (`paceColor`) ✓
- Tick central → Step 1 (`.meter::before`) ✓
- Chiffre compact `%used` + tooltip précis → Step 3 ✓
- Theme-aware → variables CSS, Step 1 ✓ ; vérifié Step 6 ✓
- État `null` → Step 3 (branche `if (!w)`) ✓
- Build OK + vérif navigateur → Steps 4, 6 ✓

**2. Placeholder scan :** aucun TBD/TODO ; tout le code est fourni intégralement.

**3. Type consistency :** `paintGauge(el, w)` signature inchangée (appelée par `refreshUsage`, lignes 2665-2666, non modifiées) ; `paceColor(ratio)` défini et utilisé dans `paintGauge` avec le même nom ; `fmtReset` réutilisé tel quel.

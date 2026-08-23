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
  const readonly = !!(p.deny && p.deny.length);
  const out = [
    readonly
      ? {
          label: "read-only",
          icon: "🔒",
          title:
            "Écritures git bloquées (commit / push / merge…). Ce profil lit et diagnostique, il ne modifie pas le code.",
        }
      : {
          label: "full access",
          icon: "✏️",
          title: "Peut modifier et committer le code — aucun garde-fou de permission sur ce profil.",
        },
  ];
  if (p.model)
    out.push({ label: p.model, icon: "", title: "Modèle forcé pour les sessions de ce profil." });
  const n = (p.secrets || []).length;
  if (n)
    out.push({
      label: n + " secret" + (n > 1 ? "s" : ""),
      icon: "🔑",
      title: "Secret(s) du coffre injecté(s) en variables d'environnement au démarrage de l'agent.",
    });
  return out;
}

/**
 * Le nom proposé pour un nouvel agent : celui de son PROFIL, parce que c'est ce
 * qui distingue deux agents lancés sur le même dépôt — le dossier, lui, est le
 * même pour tous et donnait des colonnes entières d'onglets homonymes.
 * Sans profil, on retombe sur le nom du dossier ; en dernier recours "agent",
 * jamais une chaîne vide (un onglet sans nom est illisible).
 */
export function defaultAgentName(profileName, cwd) {
  const p = String(profileName ?? "").trim();
  if (p) return p;
  const dir = String(cwd ?? "").trim().replace(/[/\\]+$/, "");
  const base = dir.split(/[/\\]/).pop() || "";
  return base || "agent";
}

/**
 * La case « read-only » du formulaire de profil reflète-t-elle un profil
 * réellement read-only ? Vrai seulement si TOUT le preset est présent : un
 * preset à moitié appliqué ne doit pas se donner des airs d'être en place.
 *
 * Volontairement plus strict que le badge de la carte, qui répond à une autre
 * question — « ce profil a-t-il des garde-fous ? » — et s'allume dès qu'il
 * existe un `deny`, fût-il personnalisé.
 */
export function hasReadonlyPreset(deny, preset) {
  const have = new Set(deny || []);
  return (preset || []).length > 0 && preset.every((p) => have.has(p));
}

/**
 * Coche/décoche le preset SANS toucher aux motifs personnalisés : décocher
 * retire les motifs du preset et laisse le reste, cocher ajoute ceux qui
 * manquent en fin de liste. La zone de texte reste la source de vérité — elle
 * n'est jamais écrasée en bloc, ce que faisait l'ancien gestionnaire.
 */
export function applyReadonlyPreset(deny, on, preset) {
  const list = [...(deny || [])];
  const p = preset || [];
  if (!on) return list.filter((x) => !p.includes(x));
  const have = new Set(list);
  for (const x of p) if (!have.has(x)) list.push(x);
  return list;
}

/**
 * Rôles pilotés par le SERVEUR, qui n'ont rien à faire dans une liste où l'on
 * choisit un profil. `Shadok-Tweak` reprend son prompt de
 * `context/tweak-prompt.md` à chaque boot et possède son propre CTA : l'offrir
 * comme un rôle ordinaire promet une personnalisation que le prochain
 * redémarrage effacera.
 */
export const MANAGED_PROFILES = ["Shadok-Tweak"];

export function isManagedProfile(name) {
  return MANAGED_PROFILES.includes(String(name ?? "").trim());
}

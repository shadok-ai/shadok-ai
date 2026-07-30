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

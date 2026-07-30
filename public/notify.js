// Décision de notification du cockpit : quelle couleur sur le favicon, quel
// préfixe dans le titre, et faut-il clignoter — voir
// docs/superpowers/specs/2026-07-29-blinking-notifications-and-per-channel-mute-design.md
//
// Chargé tel quel par le navigateur (ESM) et importé par les tests node/tsx,
// comme public/live-text.js et public/profile-card.js. Le module ne connaît ni
// le DOM ni les onglets : on lui passe une liste de { mood, muted }.

/** Un agent bloqué sur une question : il faut FAIRE quelque chose. */
const RED = "#e07a6a";
/** La phase basse du clignotement — sombre, mais toujours visible. */
const RED_DIM = "#8a4034";
/** Une réponse arrivée dans un canal qu'on ne regarde pas. */
const AMBER = "#f0a848";

/**
 * Période du clignotement. Volontairement au-dessus de la seconde : le
 * navigateur ravale à ~1 Hz les timers d'un onglet caché, viser plus court ne
 * ferait qu'accumuler des ticks sautés.
 */
export const BLINK_MS = 900;

/**
 * L'état d'attention agrégé des canaux.
 *
 * `phase` alterne 0/1 au rythme du clignotement. Les deux phases renvoient
 * toujours une couleur ET un badge : Chrome étrangle les timers d'un onglet
 * caché (jusqu'à un réveil par minute après ~5 min), et un on/off gelé sur
 * « off » rendrait la page parfaitement calme alors qu'un agent attend. Ici, le
 * pire cas est un clignotement lent.
 *
 * @param {Array<{mood?: string|null, muted?: boolean}>} channels
 * @param {{hidden: boolean, phase: number}} view
 * @returns {{color: string|null, badge: string, blink: boolean}}
 */
export function notifyState(channels, view) {
  const hidden = !!(view && view.hidden);
  const phase = view && view.phase ? 1 : 0;

  let blocked = false;
  let unread = false;
  for (const c of channels || []) {
    if (!c || c.muted) continue; // un canal muté ne remonte aucun signal global
    if (c.mood === "needs-answer") blocked = true;
    else if (c.mood === "unread") unread = true;
  }

  if (!blocked && !unread) return { color: null, badge: "", blink: false };

  // Seul un agent bloqué justifie de clignoter : une réponse non lue signale
  // qu'il s'est passé quelque chose, pas qu'on attend après toi.
  const blink = blocked && hidden;
  if (!blink) return { color: blocked ? RED : AMBER, badge: "● ", blink: false };
  return phase
    ? { color: RED_DIM, badge: "◉ ", blink: true }
    : { color: RED, badge: "● ", blink: true };
}

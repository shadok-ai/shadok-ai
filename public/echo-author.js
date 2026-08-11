// Qui a envoyé un prompt venu d'un AUTRE client ? Décision pure, donc testable
// sans navigateur — même découpage que live-text.js, notify.js et
// profile-card.js : chargé tel quel par la page (ESM) et importé par les tests.
//
// L'étiquette d'auteur était figée sur « pilot (elsewhere) », ce qui ne dit ni
// qui a parlé ni d'où. Le pont Telegram connaît le nom de l'expéditeur ; les
// crons connaissent leur origine. Autant le dire.

/**
 * @param {{from?: string, origin?: string, auto?: boolean}} msg un `prompt-echo`
 * @returns {string} l'étiquette à afficher au-dessus de la bulle
 */
export function echoAuthor(msg) {
  // La reprise du pace guard ne vient de personne : elle vient du serveur.
  if (msg?.auto) return "auto-retry";
  const from = (msg?.from ?? "").trim();
  const origin = (msg?.origin ?? "").trim();
  // « web » n'apprend rien : un autre onglet du même cockpit. On ne le montre
  // que faute de nom, et encore, via la formule générique.
  const place = origin && origin !== "web" ? origin : "";
  if (from) return place ? `${from} · ${place}` : from;
  return place || "pilot (elsewhere)";
}

// `live-text.js` est du JS pur : le navigateur le charge tel quel (pas de
// build côté client). Le serveur l'importe aussi — pour joindre la préface
// d'un dialog, cf. docs/superpowers/specs/2026-07-28-telegram-dialog-preface-design.md
// — d'où ce fichier de types, qui garde UNE seule implémentation.

/** Le dernier bloc de texte assistant visible à l'écran, dé-wrappé ; "" sinon. */
export function extractLiveText(screen: string): string;

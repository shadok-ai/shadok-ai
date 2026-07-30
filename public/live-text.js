// Extraction best-effort du bloc de texte assistant en cours, depuis l'écran
// TUI (@xterm/headless) — voir docs/superpowers/specs/2026-07-28-live-text-preview-design.md.
//
// Chargé tel quel par le navigateur (ESM) et importé par les tests node/tsx.
// Le transcript .jsonl n'écrit un bloc de texte que TERMINÉ ; l'écran, lui, le
// montre au fil de la frappe → seule source token-granulaire.
//
// Un bloc de texte assistant = une ligne "⏺ <prose>" (U+23FA + espace) en
// colonne 0, suivie de continuations indentées de 2 espaces. Un tool_use rend
// "⏺ Nom(args)" ; un résultat d'outil rend "  ⎿ …".

const MARKER = "⏺ "; // "⏺ "

/** Le dernier bloc de texte assistant visible, dé-wrappé ; "" sinon. */
export function extractLiveText(screen) {
  if (typeof screen !== "string" || !screen) return "";
  const lines = screen.split("\n");

  // Trouver le dernier marqueur de bloc "⏺ " en colonne 0.
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(MARKER)) { start = i; break; }
  }
  if (start < 0) return "";

  const head = lines[start].slice(MARKER.length).trim();
  // Exclure les lignes d'OUTIL (pas du texte assistant) :
  //  - tool_use     : "⏺ Nom(...)" — identifiant collé à une parenthèse ;
  //  - outil en cours: "⏺ Running 1 shell command" / "⏺ Ran 1 shell command".
  // Sans ça, la ligne d'outil s'affichait comme un aperçu de texte.
  if (/^[\w.-]+\(/.test(head) || /^(Running|Ran)\b/i.test(head)) return "";

  const parts = [head];
  const isToolLine = (t) => t.startsWith("⎿") || /^(Ran|Running)\b/.test(t);
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") {
      // Ligne vide : coupure de paragraphe DANS le bloc, ou fin du bloc. On
      // garde le bloc ouvert seulement si la prochaine ligne non vide est encore
      // une continuation indentée (pas un résumé d'outil ni la box de saisie).
      // Sans ça, un long texte multi-paragraphes était tronqué à son 1er § :
      // l'aperçu se figeait sur le début et tout le reste n'apparaissait qu'à la
      // finalisation du bloc (« le stream bizarre / on voit qu'à la fin »).
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && lines[j].startsWith("  ") && !isToolLine(lines[j].trim())) continue;
      break;
    }
    if (!l.startsWith("  ")) break; // non indenté → fin (spinner, box, bloc suivant)
    const t = l.trim();
    if (isToolLine(t)) break; // sous-ligne d'outil
    parts.push(t);
  }
  return parts.join(" ");
}

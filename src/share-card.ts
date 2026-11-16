/**
 * The link preview of a shared cockpit link: the `og:*` tags a chat app reads,
 * and the 1200×630 PNG it shows.
 *
 * A shared link lands on the login page for anyone without a session, and so
 * does the preview bot of Slack, WhatsApp, iMessage or Telegram — which
 * therefore showed a bare "shadok-ai — login". The card names the instance and,
 * for a link to an agent (`/a/<id>`), the agent. That is all it ever reveals:
 * never a message, never a profile, never who sent it. Revealing even that much
 * is a deliberate choice (the instance title stayed behind the gate until
 * then), so it is kept to exactly two strings.
 *
 * The SVG is built here, pure and tested; the rasterisation goes through
 * `@resvg/resvg-js`, loaded LAZILY: it is a native module, and a platform it has
 * no binary for must cost the preview its picture, never the server its boot.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const CARD_W = 1200;
export const CARD_H = 630;

/** The mascot's own orange — the brand, the same on every instance. */
const MASCOT = "#f2a84a";
/** The default accent (the "amber" theme key, which is stored as absent). */
const DEFAULT_ACCENT = "#7b93ff";
/** Mirrors `:root[data-theme=…]` in index.html. */
export const THEME_ACCENTS: Record<string, string> = {
  emerald: "#45c58a",
  azure: "#5aa9f0",
  violet: "#b98cf0",
  rose: "#f07a9e",
  cyan: "#3fc7d4",
};

export const TAGLINE = ["Humans think. Agents pump.", "Together they ship."];
export const SIGN_IN_LINE = "Sign in to open this link";

export function accentFor(theme: string | null | undefined): string {
  return (theme && THEME_ACCENTS[theme]) || DEFAULT_ACCENT;
}

/** For both the SVG and the HTML meta tags: an agent or instance name is the
 *  operator's input and must never close a tag or an attribute. */
export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Collapse whitespace and cut at `max` characters with an ellipsis. */
export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** Inter Bold averages ~0.6 em per character over mixed case; erring wide only
 *  costs a smaller font or an earlier wrap, never an overflow. */
const EM_PER_CHAR = 0.6;
const TITLE_WIDTH = 610;

/** Greedy word wrap into lines of at most `per` characters (a word longer than
 *  that is cut, so no line can overflow). */
function wrap(text: string, per: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (let w of text.split(" ")) {
    while ([...w].length > per) {
      if (cur) lines.push(cur), (cur = "");
      lines.push([...w].slice(0, per).join(""));
      w = [...w].slice(per).join("");
    }
    if (!cur) cur = w;
    else if ([...cur].length + 1 + [...w].length <= per) cur += " " + w;
    else lines.push(cur), (cur = w);
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * The big name as lines and a font size: one line at the largest size that
 * fits, else two lines, smaller, the second one clipped if it still overflows.
 */
export function titleLayout(text: string): { size: number; lines: string[] } {
  const per = (size: number) => Math.floor(TITLE_WIDTH / (EM_PER_CHAR * size));
  const n = [...text].length;
  for (const size of [84, 72, 64]) if (n <= per(size)) return { size, lines: [text] };
  for (const size of [64, 54]) {
    const lines = wrap(text, per(size));
    if (lines.length <= 2) return { size, lines };
  }
  const lines = wrap(text, per(54));
  return { size: 54, lines: [lines[0], clip(lines.slice(1).join(" "), per(54))] };
}

export interface CardInput {
  /** The cockpit's title (`cockpitTitle`), or "" when none is set. */
  instance: string;
  /** The agent's name, for a link to one agent. */
  agent?: string | null;
  theme?: string | null;
}

/** The strings a preview shows, shared by the PNG and the `og:*` tags. */
export function cardText(input: CardInput): { eyebrow: string; title: string } {
  // The eyebrow is spaced capitals at 26px: ~24 characters of instance fill the
  // column. The title wraps on its own (`titleLayout`), so it gets more room.
  const agent = clip(input.agent || "", 60);
  if (agent) {
    const instance = clip(input.instance || "", 24);
    return { eyebrow: instance ? `Shadok-AI · ${instance}` : "Shadok-AI", title: agent };
  }
  const instance = clip(input.instance || "", 60);
  return { eyebrow: "Shadok-AI", title: instance || "Shadok-AI" };
}

function mascot(x: number, y: number, size: number): string {
  const c = MASCOT;
  return `<g transform="translate(${x},${y}) scale(${size / 512})">
<line x1="190" y1="140" x2="170" y2="80" stroke="${c}" stroke-width="14" stroke-linecap="round"/><circle cx="170" cy="78" r="13" fill="${c}"/>
<line x1="258" y1="140" x2="282" y2="80" stroke="${c}" stroke-width="14" stroke-linecap="round"/><circle cx="284" cy="78" r="13" fill="${c}"/>
<line x1="320" y1="285" x2="365" y2="314" stroke="${c}" stroke-width="16" stroke-linecap="round"/>
<line x1="185" y1="350" x2="180" y2="450" stroke="${c}" stroke-width="16" stroke-linecap="round"/><line x1="262" y1="350" x2="266" y2="450" stroke="${c}" stroke-width="16" stroke-linecap="round"/>
<rect x="150" y="443" width="60" height="18" rx="9" fill="${c}"/><rect x="238" y="443" width="60" height="18" rx="9" fill="${c}"/>
<circle cx="226" cy="257" r="113" fill="${c}"/>
<circle cx="187" cy="147" r="35" fill="#fff"/><circle cx="265" cy="147" r="35" fill="#fff"/>
<circle cx="192" cy="150" r="16" fill="#12151c"/><circle cx="269" cy="150" r="16" fill="#12151c"/></g>`;
}

/** The mascot alone, for the login page (same drawing as the card's). */
export function mascotSvg(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${mascot(0, 0, size)}</svg>`;
}

/** The whole card as SVG. Pure: the same input always yields the same bytes,
 *  which is what the PNG cache keys on. */
export function cardSvg(input: CardInput): string {
  const accent = accentFor(input.theme);
  const { eyebrow, title } = cardText(input);
  const { size, lines } = titleLayout(title);
  const x = 540;
  const font = `font-family="Inter"`;
  // Vertical rhythm from the eyebrow's baseline down: the title block, then
  // the tagline, whatever the number of title lines.
  const lead = Math.round(size * 1.08);
  const firstBase = 190 + 26 + size;
  const lastBase = firstBase + lead * (lines.length - 1);
  const tagBase = lastBase + 70;
  const titleSpans = lines.map((l, i) => `<tspan x="${x}" y="${firstBase + lead * i}">${escapeXml(l)}</tspan>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
<defs><radialGradient id="glow"><stop offset="0" stop-color="${accent}" stop-opacity="0.28"/><stop offset="0.65" stop-color="${accent}" stop-opacity="0"/></radialGradient></defs>
<rect width="${CARD_W}" height="${CARD_H}" fill="#12151c"/>
<circle cx="1000" cy="190" r="330" fill="url(#glow)"/>
${mascot(70, 95, 440)}
<text x="${x}" y="190" ${font} font-weight="700" font-size="26" letter-spacing="4" fill="${accent}">${escapeXml(eyebrow.toUpperCase())}</text>
<text ${font} font-weight="700" font-size="${size}" fill="#f2f2f4">${titleSpans}</text>
<text ${font} font-size="32" fill="#a1a6b3"><tspan x="${x}" y="${tagBase}">${escapeXml(TAGLINE[0])}</tspan><tspan x="${x}" y="${tagBase + 42}">${escapeXml(TAGLINE[1])}</tspan></text>
<g transform="translate(${x},548)" fill="none" stroke="#8a8f9c" stroke-width="3"><rect x="0" y="9" width="20" height="16" rx="3" fill="#8a8f9c"/><path d="M4 9 V5 a6 6 0 0 1 12 0 V9"/></g>
<text x="${x + 34}" y="572" ${font} font-size="24" fill="#8a8f9c">${escapeXml(SIGN_IN_LINE)}</text>
</svg>`;
}

const FONT_DIR = fileURLToPath(new URL("../public/fonts/", import.meta.url));
const FONT_FILES = ["Inter-Regular.ttf", "Inter-Bold.ttf"].map((f) => FONT_DIR + f);

type Rasterise = (svg: string) => Buffer;
let rasteriser: Promise<Rasterise | null> | null = null;

/** The resvg-backed rasteriser, or null where the native module cannot load. */
function loadRasteriser(): Promise<Rasterise | null> {
  rasteriser ??= import("@resvg/resvg-js")
    .then(({ Resvg }) => {
      const fontFiles = FONT_FILES.filter((f) => fs.existsSync(f));
      return (svg: string) =>
        Buffer.from(
          new Resvg(svg, {
            fitTo: { mode: "original" },
            // The bundled Inter first; system fonts only as a fallback for a
            // glyph it lacks (an emoji or a CJK name).
            font: { fontFiles, loadSystemFonts: true, defaultFontFamily: "Inter" },
          })
            .render()
            .asPng(),
        );
    })
    .catch((e) => {
      console.warn(`share card: no rasteriser (${(e as Error).message}) — previews fall back to the icon`);
      return null;
    });
  return rasteriser;
}

/** Rendered cards, keyed by their SVG. Bounded: a card changes only with a
 *  rename or a theme, so a handful of entries is the steady state. */
const cache = new Map<string, Buffer>();
const CACHE_MAX = 64;

/** The card as PNG, or null when this platform cannot rasterise. */
export async function renderCard(input: CardInput): Promise<Buffer | null> {
  const svg = cardSvg(input);
  const hit = cache.get(svg);
  if (hit) return hit;
  const r = await loadRasteriser();
  if (!r) return null;
  const png = r(svg);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(svg, png);
  return png;
}

/**
 * The `<head>` lines of a shared link: title, description and the card. `image`
 * and `url` must be ABSOLUTE — a preview bot resolves nothing relative.
 */
export function previewMeta(input: CardInput, image: string, url: string): string {
  const { eyebrow, title } = cardText(input);
  const head = input.agent ? `${title} · ${eyebrow}` : title === "Shadok-AI" ? "Shadok-AI" : `${title} · Shadok-AI`;
  const desc = TAGLINE.join(" ");
  const e = escapeXml;
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Shadok-AI">`,
    `<meta property="og:title" content="${e(head)}">`,
    `<meta property="og:description" content="${e(desc)}">`,
    `<meta property="og:url" content="${e(url)}">`,
    `<meta property="og:image" content="${e(image)}">`,
    `<meta property="og:image:width" content="${CARD_W}">`,
    `<meta property="og:image:height" content="${CARD_H}">`,
    `<meta property="og:image:alt" content="${e(head)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${e(head)}">`,
    `<meta name="twitter:description" content="${e(desc)}">`,
    `<meta name="twitter:image" content="${e(image)}">`,
  ].join("\n");
}

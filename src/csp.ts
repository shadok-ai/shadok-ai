/**
 * La Content-Security-Policy du cockpit, et l'injection du nonce dans la page.
 *
 * Pourquoi une CSP ici : le transcript rend du **Markdown produit par l'agent**,
 * donc du contenu dérivé de ce que l'agent a lu (un fichier d'un repo cloné, une
 * page web, un message Telegram). `marked` laisse passer le HTML brut. Sans
 * garde, un `<img onerror=…>` planté dans un README s'exécute dans le cockpit —
 * qui peut créer un cron, donc lancer une commande shell. L'assainissement
 * (DOMPurify, côté client) est la première barrière ; la CSP est celle qui tient
 * encore quand l'assainisseur a un trou.
 *
 * Tout est pur ici ; le câblage vit dans server.ts.
 */

/**
 * Marqueur écrit en dur dans `public/index.html`, remplacé par le vrai nonce à
 * chaque requête.
 *
 * Un remplacement de chaîne littérale, pas une réécriture de balises : on ne
 * veut ni parser du HTML ni risquer de « nonce-er » un `<script` qui traînerait
 * dans une chaîne JavaScript. En prime, le marqueur rend l'exigence visible dans
 * la source — un futur bloc de script sans lui ne s'exécutera pas, ce qui se
 * remarque tout de suite.
 */
export const NONCE_PLACEHOLDER = "__CSP_NONCE__";

/**
 * La politique servie avec chaque page.
 *
 * - `script-src` : **aucun `unsafe-inline`**. C'est la directive qui compte —
 *   elle neutralise `<img onerror>`, `<script>` injecté et `javascript:`. Les
 *   deux blocs inline de la page portent le nonce ; le HTML injecté, lui, ne
 *   peut pas le deviner (il est tiré au sort à chaque requête).
 * - `style-src` garde `unsafe-inline` : la page a une grosse feuille inline et
 *   des attributs `style=` un peu partout. Le nonce ne couvre pas les attributs,
 *   donc l'exiger reviendrait à réécrire le client entier pour un gain faible —
 *   l'injection de style seule ne donne pas l'exécution de code.
 * - `img-src` autorise `data:` : le favicon est un SVG en data-URI, et le pip de
 *   notification le réécrit à la volée.
 * - `connect-src 'self'` couvre le WebSocket : `'self'` s'applique aussi au
 *   `ws://` de même hôte et même port.
 * - `base-uri`/`object-src`/`frame-ancestors` à `none` : rien à réécrire, rien à
 *   embarquer, et pas de clickjacking sur une UI qui pilote des agents.
 */
export function cspHeader(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Remplace chaque marqueur par le nonce de cette requête. */
export function injectNonce(html: string, nonce: string): string {
  return html.split(NONCE_PLACEHOLDER).join(nonce);
}

/**
 * Où le serveur écoute, et qui a le droit de lui parler depuis un navigateur.
 *
 * Le cockpit exécute des commandes arbitraires sur la machine (spawn d'agents,
 * `sh -c` des gardes de cron) : sa seule vraie frontière de sécurité est « qui
 * peut ouvrir une connexion ». Ce module tient les deux moitiés de cette
 * frontière, en fonctions pures — donc testables sans serveur.
 *
 * Tout est pur ici ; le câblage vit dans server.ts.
 */

/** Bind par défaut : la machine seule. Une exposition réseau est un choix. */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * Une adresse de bind qui ne sort pas de la machine.
 *
 * `localhost` en fait partie : il résout vers une loopback, et refuser un
 * serveur qui l'utilise n'apporterait rien qu'une surprise.
 */
export function isLoopbackHost(host: string): boolean {
  // `[::1]` : forme entre crochets telle qu'on l'écrit dans une URL.
  const h = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

/** L'interface d'écoute : `SHADOK_HOST`, sinon la loopback. */
export function resolveHost(env: NodeJS.ProcessEnv = process.env): string {
  const h = (env.SHADOK_HOST ?? "").trim();
  return h || DEFAULT_HOST;
}

/**
 * Pourquoi refuser de démarrer, ou null si la configuration est sûre.
 *
 * Écouter au-delà de la loopback SANS mot de passe donne à tout le réseau le
 * droit de lancer des commandes sur cette machine. Le refus est délibérément
 * fail-closed : documenter la bonne pratique ne suffit pas quand l'erreur coûte
 * la machine. Un `0.0.0.0` reste parfaitement légitime — en conteneur c'est même
 * la seule valeur qui marche — il demande juste un mot de passe.
 */
export function bindRefusal(host: string, hasPassword: boolean): string | null {
  if (isLoopbackHost(host) || hasPassword) return null;
  return (
    `refus de démarrer : SHADOK_HOST=${host} expose le cockpit hors de cette machine, sans mot de passe.\n` +
    `  Le cockpit lance des commandes arbitraires : n'importe qui pouvant l'atteindre les lance aussi.\n` +
    `  → ajoutez --password <p> (ou SHADOK_GUI_PASSWORD), ou retirez SHADOK_HOST pour n'écouter qu'en local.\n` +
    `  En conteneur, SHADOK_HOST=0.0.0.0 est normal : publiez le port sur la loopback de l'hôte\n` +
    `  (-p 127.0.0.1:PORT:PORT), car -p PORT:PORT contourne ufw/firewalld via les règles iptables de Docker.`
  );
}

/** L'allowlist d'origines supplémentaires (`SHADOK_ORIGINS`, séparées par des virgules). */
export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\/+$/, ""))
    .filter(Boolean);
}

/**
 * Ce navigateur a-t-il le droit de parler à ce serveur ?
 *
 * Les WebSockets **ne sont pas soumis à la same-origin policy** : sans ce
 * contrôle, n'importe quelle page ouverte par l'utilisateur peut faire
 * `new WebSocket("ws://localhost:3789/ws")`, démarrer un agent et lui donner des
 * ordres. Le cookie `SameSite=Strict` ne couvre que les instances protégées par
 * un mot de passe ; le mode par défaut n'a rien.
 *
 * La règle est le **same-origin**, pas une liste de `localhost` en dur : le
 * cockpit se consulte aussi sur une IP de LAN ou un domaine derrière un proxy,
 * et une allowlist figée les fermerait tous. Comparer l'`Origin` au `Host` de la
 * requête marche partout et refuse quand même `evil.com`.
 *
 * **Absence d'`Origin` → autorisé**, et ce n'est pas un oubli : les clients non
 * navigateur n'en envoient pas — le pont Telegram, qui ouvre un WS sur
 * 127.0.0.1 vers notre propre serveur, `pilotctl`, la CLI, le skill scheduler.
 * Les fermer casserait le produit sans rien gagner : un attaquant capable de
 * forger cet en-tête a déjà un accès réseau direct, et c'est le bind + le mot de
 * passe qui l'arrêtent, pas celui-ci. Ce garde ne vise que le navigateur, seul
 * agent à envoyer un `Origin` qu'il ne contrôle pas.
 */
export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  extraAllowed: string[] = [],
): boolean {
  if (!origin) return true; // client non-navigateur
  const o = origin.trim().toLowerCase().replace(/\/+$/, "");
  if (extraAllowed.includes(o)) return true;
  if (!host) return false;
  try {
    // `new URL("null")` lève : une origine opaque (iframe sandbox, file://)
    // tombe donc en refus, ce qui est le bon défaut.
    return new URL(o).host === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

/**
 * A BROWSER on our own origin — the only caller allowed to change a profile's
 * guardrails (deny/allow/secrets/model).
 *
 * Deliberately stricter than `originAllowed`, which lets an Origin-less client
 * through because Telegram, pilotctl, the CLI and the scheduler need that
 * (invariant 11). An agent's shell is exactly such a caller, and that is what
 * we refuse here: without this, any agent could `curl -X PUT /profiles` with
 * `deny: []` and strip its own guardrails.
 *
 * Not a cryptographic boundary — an agent running as the same OS user can forge
 * the header, or rewrite ~/.shadok-ai/profiles.json outright. It removes the
 * accident and takes the capability off the documented surface.
 */
export function browserOrigin(
  origin: string | undefined,
  host: string | undefined,
  extraAllowed: string[] = [],
): boolean {
  if (!origin || !origin.trim()) return false;
  return originAllowed(origin, host, extraAllowed);
}

/**
 * Which stream of releases an instance follows.
 *
 * `alpha` moves on every merge to main; `beta` only on a promotion (a minor
 * bump). Both are npm dist-tags — except that the beta channel reads `latest`,
 * because CI can only ever SET a tag at publish time: npm Trusted Publishing
 * (OIDC) authenticates `npm publish` and nothing else, so `npm dist-tag add`
 * would mean storing a long-lived npm token. A promotion is therefore published
 * with no `--tag`, which is what moves `latest`.
 *
 * Design: docs/superpowers/specs/2026-08-23-update-channels-design.md
 */

export type UpdateChannel = "alpha" | "beta";

/** The dist-tag an instance polls for a given channel. */
export const TAG_FOR: Record<UpdateChannel, string> = { alpha: "alpha", beta: "latest" };

export const DEFAULT_CHANNEL: UpdateChannel = "beta";

/**
 * Config value → a channel we can act on.
 *
 * Anything unrecognised (a typo, a value from a newer version, a stray null)
 * falls back to the default instead of throwing: a malformed config must not
 * stop an instance from updating at all, and the calm channel is the safe way
 * to be wrong.
 */
export function resolveChannel(raw: unknown): UpdateChannel {
  return raw === "alpha" || raw === "beta" ? raw : DEFAULT_CHANNEL;
}

/**
 * The version an instance should move to, given what each tag currently
 * resolves to.
 *
 * The beta channel is simply `latest`. The alpha channel takes the NEWER of the
 * two tags, which matters for exactly one window: a promotion publish moves
 * `latest` and leaves `alpha` on the previous build, so for the span of one
 * merge the "newest" channel would otherwise resolve to an OLDER version than
 * the calm one. It heals on the next merge, but until then it reads as a bug —
 * and an alpha instance downgrading itself is worse than a cosmetic oddity.
 *
 * `null` means "couldn't look" (see `latestVersion`), never "nothing there":
 * callers must not treat it as an answer.
 */
export function pickTarget(
  channel: UpdateChannel,
  tags: { alpha: string | null; latest: string | null },
  isNewer: (candidate: string, current: string) => boolean,
): string | null {
  if (channel === "beta") return tags.latest;
  if (!tags.alpha) return tags.latest;
  if (!tags.latest) return tags.alpha;
  return isNewer(tags.latest, tags.alpha) ? tags.latest : tags.alpha;
}

/**
 * Whether a brand-new instance applies a newer release by itself.
 *
 * ON, so an ordinary `npx shadok-ai` deployment follows its channel without
 * anyone setting `SHADOK_AUTOUPDATE=1` — on the beta channel, which is already
 * `DEFAULT_CHANNEL`, so the calm stream is what a default install tracks.
 */
export const DEFAULT_AUTO_UPDATE = true;

/**
 * Should this instance apply a newer release by itself?
 *
 * Config first (the GUI checkbox, persisted), then the env var, then the
 * default — the same precedence as the shared-ledger reflex, and for the same
 * reason: the only instance that gets a NEW default is one that never expressed
 * a choice, so flipping the default cannot override anybody's setting.
 *
 * Two things this function exists to prevent, both of them silent.
 *
 * **The env var has to be able to say NO.** It used to be read as
 * `/^(1|true|yes|on)$/.test(env ?? "")`, which could only ever turn the feature
 * ON: absence meant off, so off needed no spelling. With the default ON, that
 * same expression would make `SHADOK_AUTOUPDATE=0` a no-op — an instance
 * updating itself while its own configuration says not to, which is the worst
 * shape this flag can fail in. A non-empty value is therefore parsed, so
 * anything that is not truthy (`0`, `false`, `no`, `off`) is a refusal.
 *
 * **A default ON is only safe where something respawns the server.** Applying
 * an update means exiting 75 for the supervisor to reinstall and relaunch
 * (`src/supervisor.ts`); with no supervisor that exit is just the server
 * disappearing. `npm run web` and the side-by-side build in CLAUDE.md both run
 * `dist/server.js` directly, and they are safe today only because the default
 * is off — so the default is gated on `supervised`, which `main.ts` asserts on
 * the child it spawns. An EXPLICIT choice still wins either way: someone who
 * ticks the box on a hand-run server asked for it.
 */
export function resolveAutoUpdate(
  configured: boolean | null | undefined,
  env: string | undefined,
  supervised: boolean,
): boolean {
  if (typeof configured === "boolean") return configured;
  const raw = (env ?? "").trim();
  if (raw) return /^(1|true|yes|on)$/i.test(raw);
  return supervised ? DEFAULT_AUTO_UPDATE : false;
}

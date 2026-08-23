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

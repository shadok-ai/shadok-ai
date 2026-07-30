/**
 * Tiny semver comparison for the update check. Our versions are always
 * `0.1.<n>` (see the publish workflow), so a numeric major/minor/patch compare
 * is enough — no pre-release or build-metadata handling.
 */

function parse(v: string): [number, number, number] {
  const p = String(v)
    .trim()
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

/** True iff `candidate` is a strictly newer version than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

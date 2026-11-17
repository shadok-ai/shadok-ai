/**
 * Reconciling the browser's copy of the personal preferences with the
 * account's (GET /prefs, src/user-prefs.ts). Pure. ESM, browser + tests.
 *
 * The copy lives in localStorage, which belongs to the BROWSER; the
 * preferences belong to an ACCOUNT. Several accounts pass through one browser
 * (an admin who signs out and redeems the invitation they just made, a shared
 * machine), so the copy is not always the caller's own.
 */

/**
 * Preferences that state something the PERSON did, and so must never be taken
 * from a copy that may be someone else's. "The tour was seen" is true of one
 * person; inherited from the browser, it hid the guided tour from every
 * account after the first one to use that browser. The others (light/dark,
 * the chime, the folded rail) are tastes of whoever sits at this screen, and
 * inheriting them is a fair starting point.
 */
export const NEVER_INHERITED = ["tourSeen"];

/**
 * What to do with each preference once the server has answered.
 *
 * - `owner`: the signed-in account, or null when it could not be read.
 * - `cacheOwner`: the account this browser's copy was last reconciled for, or
 *   null when it was never recorded (a copy older than this rule).
 * - `server` / `local`: the two sides, a key absent when that side has no value.
 *
 * Returns `cache` (values to write into the copy; null = remove the key) and
 * `push` (local values the account never had, to send up once).
 */
export function prefSyncPlan({ names, owner, cacheOwner, server, local }) {
  const mine = owner != null && cacheOwner != null && cacheOwner === owner;
  const cache = {};
  const push = {};
  for (const name of names || []) {
    const s = server?.[name];
    const l = local?.[name];
    if (s !== undefined) {
      if (s !== l) cache[name] = s;
    } else if (l !== undefined) {
      // The account has no value and the browser does. Unless the copy is
      // KNOWN to be this account's, a never-inherited preference is dropped
      // rather than pushed: unknown is not "mine".
      if (NEVER_INHERITED.includes(name) && !mine) cache[name] = null;
      else push[name] = l;
    }
  }
  return { cache, push };
}

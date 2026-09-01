// Pure helpers for the client's channel-list restore. ESM: loaded by the
// browser (bridged onto `window`) AND imported by test/channel-store.test.ts.
//
// Why this exists: the channel list has two sources at boot — the server's
// /channels (isolated per launch DIRECTORY) and a localStorage cache (scoped by
// ORIGIN = host:port, never by directory). Two launch dirs that bind the same
// port (typically 3789, sequentially) therefore share one cache. Falling back
// to that cache whenever the server list was merely EMPTY leaked the previous
// cockpit's channels into a fresh instance — and persisted them back. See the
// per-dir isolation invariant.

/**
 * Which channel list to trust at boot.
 * A fulfilled /channels response is AUTHORITATIVE — even `[]`, which means
 * "this launch dir has no channels", not "consult the cache". Only a genuinely
 * FAILED fetch (network error, or a non-array body) falls back to the cache.
 * @param {{status: string, value?: unknown}} settled - a Promise.allSettled entry for the fetch
 * @param {unknown} cached - the parsed localStorage fallback
 */
export function pickChannelSource(settled, cached) {
  if (settled && settled.status === "fulfilled" && Array.isArray(settled.value)) return settled.value;
  return Array.isArray(cached) ? cached : [];
}

/**
 * Namespace a localStorage key by the launch dir, so two dirs on the same
 * origin keep separate buckets. Falls back to the bare key when the dir is not
 * known yet (before /defaults answers) — the pre-fix behaviour, never a crash.
 * @param {string} base - the un-namespaced key, e.g. "cp.channels"
 * @param {string|undefined} instanceKey - the launch dir's instanceKey
 */
export function dirKey(base, instanceKey) {
  return instanceKey ? base + ":" + instanceKey : base;
}

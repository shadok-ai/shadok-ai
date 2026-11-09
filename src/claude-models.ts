import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Which models THIS Claude Code build supports, read out of the binary.
 *
 * The alternative was a hardcoded list, and it is the alternative that rots:
 * the profile panel still suggests `claude-opus-4-8`, current the day it was
 * written and stale now, and `claude-opus-5-5` shipped without shadok noticing.
 * The CLI has no command that enumerates models (`claude models` is not a
 * subcommand — it is taken as a PROMPT and answered, which is its own trap), so
 * the names are taken from where they actually live: the binary's own strings.
 *
 * Read, never executed, and never trusted blindly — see `parseModelNames`.
 */

/** Families the CLI accepts as aliases. An alias is always offered, scan or no scan. */
export const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;

/**
 * Pure: the model names in a blob of binary strings, conservatively.
 *
 * DELIBERATELY NARROW, and the narrowness is the point. A `strings` dump glues
 * adjacent bytes together, which mints plausible-looking rubbish: this binary
 * contains `claude-haiku-3-55` (a `3-5` with the next byte stuck to it) and
 * `claude-fable-5-mythos-5`. Offering those as choices would produce an agent
 * that dies at spawn on a model nobody can find. So only a plain
 * `claude-<family>-<major>[-<minor>]` is kept, with a single-digit minor.
 *
 * Dropped on purpose:
 *  - `-v1` suffixes and 8-digit dated forms (`claude-opus-4-5-20251101`): the
 *    same model spelled longer, and three spellings of one model in a picker is
 *    noise, not choice.
 *  - anything with a non-numeric segment, which is where the glue artifacts are.
 *
 * KNOWN LIMIT, written down rather than discovered later: a two-digit minor
 * (`claude-opus-5-10`) would be skipped, because admitting two digits is what
 * lets `3-55` back in. The family row (`opus`, `sonnet`…) never depends on this
 * scan, so a missed name costs discoverability, never the ability to run it.
 */
export function parseModelNames(text: string): string[] {
  const fam = MODEL_FAMILIES.join("|");
  const re = new RegExp(`claude-(?:${fam})-\\d{1,2}(?:-\\d)?(?![\\w-])`, "g");
  return [...new Set(text.match(re) ?? [])];
}

/** Pure: family, then newest version first — the order a picker should show. */
export function rankModels(names: readonly string[]): string[] {
  const key = (n: string) => {
    const m = /^claude-([a-z]+)-(\d{1,2})(?:-(\d))?$/.exec(n);
    if (!m) return null;
    return { family: m[1], major: Number(m[2]), minor: m[3] ? Number(m[3]) : 0 };
  };
  return [...names]
    .filter((n) => key(n))
    .sort((a, b) => {
      const x = key(a)!, y = key(b)!;
      const fx = MODEL_FAMILIES.indexOf(x.family as (typeof MODEL_FAMILIES)[number]);
      const fy = MODEL_FAMILIES.indexOf(y.family as (typeof MODEL_FAMILIES)[number]);
      if (fx !== fy) return fx - fy;
      if (x.major !== y.major) return y.major - x.major;
      return y.minor - x.minor;
    });
}

export interface ModelCache {
  /** Identity of the binary these names came from. */
  bin: string;
  size: number;
  mtimeMs: number;
  models: string[];
}

/** Pure: is a cache entry still about the binary on disk right now? */
export function cacheIsFresh(
  cache: ModelCache | null,
  stat: { size: number; mtimeMs: number } | null,
  bin: string,
): boolean {
  if (!cache || !stat) return false;
  return cache.bin === bin && cache.size === stat.size && cache.mtimeMs === stat.mtimeMs;
}

const cacheFile = (): string => path.join(os.homedir(), ".shadok-ai", "models.json");

/** How much of a ~240MB binary we are willing to read in one pass. */
const CHUNK = 1 << 22;
/** Names can straddle a chunk boundary; carry this much across. */
const OVERLAP = 64;

/**
 * Scan the binary. Returns [] on ANY failure — a mid-upgrade binary is the
 * normal case here, not the exception (invariant 32): the launcher is unlinked
 * and relinked on every claude-code update, so a scan can meet ETXTBSY, a
 * 500-byte placeholder, or nothing at all. An empty result is never cached, so
 * the next boot simply tries again.
 */
export function scanModels(bin: string): string[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(bin, "r");
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = "";
    const found = new Set<string>();
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      // latin1: every byte maps to one char, so offsets stay sane and an
      // invalid UTF-8 run cannot swallow a name next to it.
      const text = carry + buf.toString("latin1", 0, n);
      for (const m of parseModelNames(text)) found.add(m);
      carry = text.slice(-OVERLAP);
    }
    return rankModels([...found]);
  } catch {
    return [];
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

function readCache(): ModelCache | null {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    return Array.isArray(j?.models) ? (j as ModelCache) : null;
  } catch {
    return null;
  }
}

function writeCache(c: ModelCache): void {
  try {
    const f = cacheFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.shadok-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
    fs.renameSync(tmp, f);
  } catch {
    /* a cache we cannot write just means we scan again next boot */
  }
}

let memo: string[] | null = null;

/**
 * The models this build supports, cached per binary identity.
 *
 * One scan per claude-code upgrade, not per call: the cache key is the
 * binary's path, size and mtime, exactly the trio that changes when it is
 * replaced. `force` re-reads without touching the memo's contract.
 */
export function availableModels(bin: string, force = false): string[] {
  // `memo.length`, NOT `memo`: an empty array is truthy, so memoising a failed
  // scan would freeze the picker family-only for the life of the process — and
  // a failed scan is the NORMAL case here, since the binary is unlinked and
  // relinked on every claude-code upgrade (invariant 32). Same rule as the
  // file cache below: an empty result is a "could not look", never an answer.
  if (memo?.length && !force) return memo;
  let stat: { size: number; mtimeMs: number } | null = null;
  try {
    const s = fs.statSync(bin);
    stat = { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    stat = null;
  }
  const cached = readCache();
  if (!force && cacheIsFresh(cached, stat, bin)) return (memo = cached!.models);
  const models = scanModels(bin);
  // NEVER cache an empty result: that is what a mid-upgrade binary produces,
  // and freezing it would leave the picker permanently family-only.
  if (models.length && stat) writeCache({ bin, ...stat, models });
  // Falling back to the cache is what carries the picker through an upgrade
  // window — but only for the SAME binary. Without the path check, an entry
  // written for one launcher answered a question about another, which is a
  // cache bleeding across identities rather than a stale-but-useful answer.
  const stale = cached && cached.bin === bin ? cached.models : [];
  memo = models.length ? models : stale;
  // `memo` may legitimately be [] here; the `memo?.length` guard above is what
  // stops that from hardening into a permanent answer.
  return memo;
}

/** Test seam: forget the in-process memo. */
export function resetModelMemo(): void {
  memo = null;
}

/**
 * The Skill Factory's deterministic scan — no model call, pure, tested.
 *
 * Runs at PUSH (and at every browser save), before a commit enters the shared
 * history: a bundle carries the whole history, so a value committed and removed
 * later would otherwise reach every editor for good. See
 * docs/superpowers/specs/2026-10-29-skill-factory-design.md, "The scan".
 *
 * Two severities, on purpose. A REFUSAL is a fact we can stand behind: an actual
 * vault value, a file that is a credential by its very name, a file too large to
 * be prose. A WARNING is a guess (a token-shaped string, an undeclared env var):
 * refusing on a guess makes the scan cry wolf, and a scan that cries wolf gets
 * bypassed by habit.
 */

export interface ScanFile {
  path: string;
  content: Buffer;
}

export interface ScanSecret {
  name: string;
  value: string;
}

export interface ScanFinding {
  path: string;
  line?: number;
  /** The secret NAME (never the value) for a vault hit. */
  secret?: string;
  message: string;
}

export interface ScanResult {
  refusals: ScanFinding[];
  warnings: ScanFinding[];
}

/** Below this, a vault value is too short to match meaningfully ("true", "8080"). */
export const MIN_SECRET_LEN = 8;
/** A skill is prose and small scripts; anything larger is not what this is for. */
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_FILES = 200;

/** Files that are a credential by their name, whatever they contain. */
const FORBIDDEN = [
  /(^|\/)\.env(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)credentials[^/]*$/i,
  /\.jsonl$/i, // a transcript
];

/** Token SHAPES — a warning, since a placeholder in an example looks the same. */
const SHAPES: { re: RegExp; what: string }[] = [
  { re: /\bsk-(ant-)?[A-Za-z0-9_-]{20,}/, what: "an API key (sk-…)" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, what: "a GitHub token" },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, what: "a Slack token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: "an AWS access key" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "a private key" },
];

export function isForbiddenPath(p: string): boolean {
  return FORBIDDEN.some((re) => re.test(p));
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * The push-time scan. `secrets` are the vault values the PUSHER could have
 * pasted — never a slice they cannot see (that would make the refusal an oracle
 * across a wall).
 */
export function scanFiles(files: ScanFile[], secrets: ScanSecret[]): ScanResult {
  const refusals: ScanFinding[] = [];
  const warnings: ScanFinding[] = [];
  if (files.length > MAX_FILES)
    refusals.push({ path: "", message: `too many files (${files.length} > ${MAX_FILES})` });
  let total = 0;
  const usable = secrets.filter((s) => typeof s.value === "string" && s.value.length >= MIN_SECRET_LEN);
  for (const f of files) {
    total += f.content.length;
    if (isForbiddenPath(f.path)) {
      refusals.push({ path: f.path, message: "this kind of file holds credentials — it cannot be part of a skill" });
      continue;
    }
    if (f.content.length > MAX_FILE_BYTES) {
      refusals.push({ path: f.path, message: `file too large (${f.content.length} bytes > ${MAX_FILE_BYTES})` });
      continue;
    }
    const text = f.content.toString("utf8");
    for (const s of usable) {
      const at = text.indexOf(s.value);
      if (at >= 0)
        refusals.push({
          path: f.path,
          line: lineOf(text, at),
          secret: s.name,
          message: `contains the value of the vault secret ${s.name} — use the env var $${s.name} instead`,
        });
    }
    for (const { re, what } of SHAPES) {
      const m = re.exec(text);
      if (m) warnings.push({ path: f.path, line: lineOf(text, m.index), message: `looks like ${what}` });
    }
  }
  if (total > MAX_TOTAL_BYTES)
    refusals.push({ path: "", message: `skill too large (${total} bytes > ${MAX_TOTAL_BYTES})` });
  return { refusals, warnings };
}

/** Env var names a script reads: `process.env.X`, `process.env["X"]`, `$X`, `${X}`, `os.environ["X"]`. */
export function envReads(text: string): string[] {
  const out = new Set<string>();
  const res = [
    /process\.env\.([A-Z_][A-Z0-9_]*)/g,
    /process\.env\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
    /\$\{([A-Z_][A-Z0-9_]*)[}:-]/g,
    /\$([A-Z_][A-Z0-9_]*)\b/g,
    /os\.environ(?:\.get\(|\[)\s*["']([A-Z_][A-Z0-9_]*)["']/g,
  ];
  for (const re of res) for (const m of text.matchAll(re)) out.add(m[1]);
  return [...out];
}

/**
 * Release-time warnings that need the manifest: a script reading a vault secret
 * it does not declare (it would show bound here and break in the next group),
 * and a script relying on $CLAUDE_PLUGIN_ROOT — measured 2026-10-31 on 2.1.309:
 * substituted inside SKILL.md, NOT exported to scripts.
 */
export function releaseWarnings(
  files: ScanFile[],
  declared: string[],
  vaultNames: string[],
): ScanFinding[] {
  const out: ScanFinding[] = [];
  const decl = new Set(declared);
  const vault = new Set(vaultNames);
  for (const f of files) {
    if (f.path === "SKILL.md" || f.path === "shadok-skill.json") continue;
    const text = f.content.toString("utf8");
    const reads = envReads(text);
    for (const name of reads) {
      if (name === "CLAUDE_PLUGIN_ROOT")
        out.push({
          path: f.path,
          message: "reads $CLAUDE_PLUGIN_ROOT, which is not exported to scripts — locate files from the script's own path ($(dirname \"$0\"))",
        });
      else if (vault.has(name) && !decl.has(name))
        out.push({ path: f.path, secret: name, message: `reads $${name} but shadok-skill.json does not declare it in requires.secrets` });
    }
  }
  return out;
}

/** A factory skill's name: also its plugin name and directory, so kept boring. */
export function skillNameError(name: unknown): string | null {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(name))
    return "name must be 2–40 characters: lowercase letters, digits and dashes";
  if (name.startsWith("shadok-")) return "the shadok- prefix is reserved for the skills shadok ships";
  return null;
}

/** A path inside a skill: relative, no `..`, no `.git`, no absolute. */
export function skillPathError(p: unknown): string | null {
  if (typeof p !== "string" || !p.trim()) return "path required";
  if (p.startsWith("/") || p.includes("\\")) return "path must be relative";
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === ".."))
    return "path must not contain empty, . or .. segments";
  if (parts[0] === ".git" || parts[0] === ".claude-plugin") return "reserved path";
  return null;
}

export interface Manifest {
  name?: string;
  description?: string;
  requires?: { secrets?: string[] };
}

/** Read `shadok-skill.json` leniently: a broken manifest is a warning, not a crash. */
export function parseManifest(raw: string | null): { manifest: Manifest; error?: string } {
  if (raw == null) return { manifest: {} };
  try {
    const m = JSON.parse(raw);
    if (!m || typeof m !== "object") return { manifest: {}, error: "shadok-skill.json is not an object" };
    const secrets = Array.isArray(m.requires?.secrets)
      ? m.requires.secrets.filter((s: unknown): s is string => typeof s === "string")
      : [];
    return { manifest: { name: m.name, description: m.description, requires: { secrets } } };
  } catch {
    return { manifest: {}, error: "shadok-skill.json is not valid JSON" };
  }
}

/** The `name:` in SKILL.md's frontmatter, if any. */
export function frontmatterName(md: string): string | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!m) return null;
  const n = /^name:\s*(.+)$/m.exec(m[1]);
  return n ? n[1].trim().replace(/^["']|["']$/g, "") : null;
}

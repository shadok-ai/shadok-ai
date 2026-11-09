// Which environment variables an agent's message asks the human to provide.
//
// Loaded as-is by the browser (ESM, bridged to window.envVarAsks) and imported
// by the tests, like public/bang.js. The agent answers "the CLI stops on
// `HUBSPOT_TOKEN missing`" and the human then has to open the vault, type the
// name back, tick the profile… The "+" this feeds turns that into one click.
//
// Kept narrow on purpose: a "+" on every SCREAMING_CASE word an agent writes
// (`NODE_ENV`, `PATH`, `SHADOK_SESSION_ID`) would be noise, so a name must be
// marked as code by the agent AND look like a credential or a connection
// setting.

/** At most this many "+" under one message. More is a wall, not a help. */
export const MAX_ENV_ASKS_PER_MESSAGE = 6;

/** An env var name as a shell would export it, with at least one underscore. */
const ENV_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/** The segments that make a name something you HAND an agent, not a setting it owns. */
const CREDENTIAL_PART = new Set([
  "TOKEN", "TOKENS", "KEY", "KEYS", "APIKEY", "SECRET", "SECRETS", "PASSWORD", "PASSWD",
  "PASS", "PWD", "AUTH", "CREDENTIAL", "CREDENTIALS", "CREDS", "DSN", "URL", "URI",
  "HOST", "USER", "USERNAME", "LOGIN", "ACCOUNT", "ID", "CLIENT", "WEBHOOK", "JSON",
]);

/** Names the cockpit itself sets: asking the human for one of these is never the fix. */
const OWN_PREFIX = /^(SHADOK|CLAUDE|CLAUDECODE|ANTHROPIC|AI_AGENT|NODE|NPM|GIT|XDG|TMUX)_/;

/** Pure: is this an env var name worth offering a "+" for? */
export function isEnvAsk(name) {
  const n = String(name || "");
  if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(n) || OWN_PREFIX.test(n)) return false;
  return n.split("_").some((p) => CREDENTIAL_PART.has(p));
}

/**
 * Pure: the env var names a message offers to add, in order, de-duplicated.
 *
 * Only names inside inline code or a fenced block count — that is how an agent
 * writes a variable it means (`HUBSPOT_TOKEN`, `` `HUBSPOT_TOKEN missing from
 * the environment` ``, `export MATOMO_TOKEN=…`). A capitalised word in prose is
 * not an ask.
 */
export function envVarAsks(text) {
  const out = [];
  const src = String(text || "");
  // One pass, fenced blocks first in the alternation so their backticks are not
  // read as inline spans — and the names come out in the order they were written.
  for (const span of src.matchAll(/```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g)) {
    const s = span[1] ?? span[2];
    for (const m of s.matchAll(ENV_NAME)) {
      const n = m[0];
      if (isEnvAsk(n) && !out.includes(n) && out.length < MAX_ENV_ASKS_PER_MESSAGE) out.push(n);
    }
  }
  return out;
}

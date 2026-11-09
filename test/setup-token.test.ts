import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  stripTokenEscapes,
  parseSetupTokenUrl,
  parseSetupTokenOutcome,
  parseSetupToken,
} from "../src/setup-token.js";

// Two kinds of fixture. The RENDERED_* ones are the real `capture-pane -p` text
// measured live (v2.1.317, 2026-11-03) driving `claude setup-token` through tmux
// exactly as src/setup-token.ts does — this is what the flow actually parses.
// The raw-escape ones keep the parsers honest for an OSC-8/CSI stream too. ESC = \x1b.

const URL = "https://claude.com/oauth/authorize?code=abc&client=xyz";
const URL_STAGE =
  "\x1b[2G\x1b[38;5;246mBrowser\x1b[10Gdidn't\x1b[17Gopen?\x1b[23GUse\x1b[27Gthe\x1b[31Gurl\x1b[35Gbelow\x1b[39m\r\r\n" +
  `\x1b]8;id=1sbzpzq;${URL}\x1b\\${URL}\x1b]8;;\x1b\\\r\n` +
  "\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18Gif\x1b[21Gprompted\x1b[30G>\r\r\n";
const URL_STAGE_BEL = `prefix\x1b]8;id=9;${URL}\x07${URL}\x1b]8;;\x07done`;

// ── Real rendered screens (what capture-pane returns — no escapes) ──
const REAL_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=user%3Ainference&code_challenge=W0sDR8V2GJhWsxdtPjV7aN7ZGwUG7qMO7-GamOYtBm4" +
  "&code_challenge_method=S256&state=QDp8vuJy4em2gC_YjI7TwsrOIdkAptQKbQk5E-hJEdU";
const RENDERED_URL_STAGE = [
  " This will guide you through long-lived (1-year) auth token setup for your Claude account. Claude subscription required.",
  " Browser didn't open? Use the url below to sign in (c to copy)",
  REAL_URL,
  " Hold Shift (Option in iTerm2, Fn in Terminal.app) while selecting to use your terminal's native copy",
  " Paste code here if prompted > ",
].join("\n");

// The real success screen. The token is on its own line (full, unmasked, 108
// chars at the real prefix). The LAST line carries a literal "<token>"
// placeholder that must NOT be mistaken for the token.
const REAL_TOKEN = "sk-ant-oat01-" + "Ab3_-Cd4".repeat(11) + "XyZ012"; // 13 + 88 + 6 = 107+, real-shaped
const REAL_SUCCESS = [
  " ✓ Long-lived authentication token created successfully!",
  " Your OAuth token (valid for 1 year):",
  ` ${REAL_TOKEN}`,
  " Store this token securely. You won't be able to see it again.",
  " Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>",
].join("\n");

const REAL_INVALID = [
  " OAuth error: Invalid code. Please make sure the full code was copied",
  " Press Enter to retry.",
].join("\n");

test("stripTokenEscapes: removes OSC-8 (ST and BEL) and CSI, keeps text", () => {
  assert.equal(stripTokenEscapes("\x1b[2Ghi\x1b[39m there"), "hi there");
  assert.equal(stripTokenEscapes(`\x1b]8;id=1;${URL}\x1b\\link\x1b]8;;\x1b\\`), "link");
  assert.equal(stripTokenEscapes(`\x1b]8;id=1;${URL}\x07link\x1b]8;;\x07`), "link");
});

test("parseSetupTokenUrl: pulls the URL from the OSC-8 target (ST and BEL)", () => {
  assert.equal(parseSetupTokenUrl(URL_STAGE), URL);
  assert.equal(parseSetupTokenUrl(URL_STAGE_BEL), URL);
});

test("parseSetupTokenUrl: pulls the URL from the real rendered pane (bare https)", () => {
  assert.equal(parseSetupTokenUrl(RENDERED_URL_STAGE), REAL_URL);
});

test("parseSetupTokenUrl: null before the link has been printed", () => {
  assert.equal(parseSetupTokenUrl("\x1b[2G\x1b[38;5;174mWelcome to Claude Code\x1b[39m"), null);
  assert.equal(parseSetupTokenUrl(" Welcome to Claude Code v2.1.317"), null);
  assert.equal(parseSetupTokenUrl(""), null);
});

test("parseSetupToken: extracts the token from the REAL success screen", () => {
  assert.equal(parseSetupToken(REAL_SUCCESS), REAL_TOKEN);
});

test("parseSetupToken: ignores the <token> placeholder on the export line", () => {
  assert.equal(parseSetupToken(" Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>"), null);
});

test("parseSetupToken: survives cursor escapes interleaved in the token", () => {
  const broken = `${REAL_TOKEN.slice(0, 10)}\x1b[40G${REAL_TOKEN.slice(10)}`;
  assert.equal(parseSetupToken(broken), REAL_TOKEN);
});

test("parseSetupToken: NEVER matches the URL stage or the prompt (no false token)", () => {
  assert.equal(parseSetupToken(RENDERED_URL_STAGE), null);
  assert.equal(parseSetupToken(" Paste code here if prompted > "), null);
  assert.equal(parseSetupToken(""), null);
});

test("parseSetupTokenOutcome: detects the real invalid-code refusal, else null", () => {
  assert.equal(parseSetupTokenOutcome(REAL_INVALID), "invalid-code");
  assert.equal(parseSetupTokenOutcome("\x1b[31mInvalid code\x1b[39m. Please make sure…"), "invalid-code");
  assert.equal(parseSetupTokenOutcome(RENDERED_URL_STAGE), null);
  assert.equal(parseSetupTokenOutcome(REAL_SUCCESS), null);
});

// The flow is tmux-driven and reads the RENDERED pane, which on success contains
// the token. Lock the secret discipline and the tmux wiring by source scan
// (the flow is impure and un-importable without spawning tmux), the same way
// test/mt-token-endpoints.test.ts locks server.ts.
test("setup-token: tmux-driven, wide pane, token flows only to store, nothing logged", () => {
  const SRC = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "setup-token.ts"),
    "utf8",
  );
  // Driven through tmux (capture-pane / send-keys), not node-pty.
  assert.ok(/capture-pane/.test(SRC) && /send-keys/.test(SRC), "drives tmux (capture-pane + send-keys)");
  assert.ok(!/from "node-pty"/.test(SRC) && !/pty\.spawn/.test(SRC), "no node-pty import or spawn (prose mentions of the history are fine)");
  // The pane is wide so the ~108-char token never wraps (a wrap inserts a real newline).
  assert.ok(/PANE_COLS = 400/.test(SRC), "pane is 400 cols so the token never wraps");
  // The rendered buffer can hold the token → the module must never log.
  assert.ok(!/console\./.test(SRC), "the module never logs (the captured buffer can contain the token)");
  // The token only ever flows into the server-supplied store, never a return/error.
  assert.ok(/store\(tok\)/.test(SRC), "the token is handed to store()");
  const submit = SRC.slice(SRC.indexOf("export async function submitSetupTokenCode"));
  // The token variable (`tok`) is never concatenated/interpolated into any string
  // (prose mentioning the word "token" is fine; a value leak is not).
  assert.ok(
    !/\$\{\s*tok\b/.test(submit) && !/\btok\s*\+/.test(submit) && !/\+\s*tok\b/.test(submit),
    "the token value is never concatenated into a string or error",
  );
});

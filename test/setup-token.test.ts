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

// Fixtures reconstructed from the REAL `claude setup-token` PTY stream measured
// 2026-11-03 (v2.1.317): a cursor-positioned banner, the URL inside an OSC-8
// hyperlink, then a "Paste code here if prompted >" prompt. ESC = \x1b.
const URL = "https://claude.com/oauth/authorize?code=abc&client=xyz";
const URL_STAGE =
  "\x1b[2G\x1b[38;5;246mBrowser\x1b[10Gdidn't\x1b[17Gopen?\x1b[23GUse\x1b[27Gthe\x1b[31Gurl\x1b[35Gbelow\x1b[39m\r\r\n" +
  // OSC-8 open (id params + URL target, ST-terminated), the visible URL, OSC-8 close.
  `\x1b]8;id=1sbzpzq;${URL}\x1b\\${URL}\x1b]8;;\x1b\\\r\n` +
  "\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18Gif\x1b[21Gprompted\x1b[30G>\r\r\n";

// Same, but the OSC-8 terminated by BEL (\x07) instead of ST — both exist in the wild.
const URL_STAGE_BEL = `prefix\x1b]8;id=9;${URL}\x07${URL}\x1b]8;;\x07done`;

const TOKEN = "sk-ant-oat01-ABCdef_-0123456789";
const TOKEN_STAGE = `\x1b[2G\x1b[32mLogin successful\x1b[39m\r\n\x1b[2G${TOKEN}\x1b[0m\r\n`;

test("stripTokenEscapes: removes OSC-8 (ST and BEL) and CSI, keeps text", () => {
  assert.equal(stripTokenEscapes("\x1b[2Ghi\x1b[39m there"), "hi there");
  assert.equal(stripTokenEscapes(`\x1b]8;id=1;${URL}\x1b\\link\x1b]8;;\x1b\\`), "link");
  assert.equal(stripTokenEscapes(`\x1b]8;id=1;${URL}\x07link\x1b]8;;\x07`), "link");
});

test("parseSetupTokenUrl: pulls the URL from the OSC-8 target (ST and BEL)", () => {
  assert.equal(parseSetupTokenUrl(URL_STAGE), URL);
  assert.equal(parseSetupTokenUrl(URL_STAGE_BEL), URL);
});

test("parseSetupTokenUrl: null before the link has been printed", () => {
  assert.equal(parseSetupTokenUrl("\x1b[2G\x1b[38;5;174mWelcome to Claude Code\x1b[39m"), null);
  assert.equal(parseSetupTokenUrl(""), null);
});

test("parseSetupToken: extracts the sk-ant-oat01 token from a rendered line", () => {
  assert.equal(parseSetupToken(TOKEN_STAGE), TOKEN);
});

test("parseSetupToken: survives cursor escapes interleaved in the token", () => {
  // The terminal may emit cursor moves between characters; stripping first rejoins them.
  const broken = `${TOKEN.slice(0, 10)}\x1b[40G${TOKEN.slice(10)}`;
  assert.equal(parseSetupToken(broken), TOKEN);
});

test("parseSetupToken: NEVER matches the URL stage or the prompt (no false token)", () => {
  assert.equal(parseSetupToken(URL_STAGE), null);
  assert.equal(parseSetupToken("\x1b[2GPaste code here if prompted >"), null);
  assert.equal(parseSetupToken(""), null);
});

test("parseSetupTokenOutcome: detects the invalid-code refusal, else null", () => {
  assert.equal(parseSetupTokenOutcome("\x1b[31mInvalid code\x1b[39m. Please make sure…"), "invalid-code");
  assert.equal(parseSetupTokenOutcome(URL_STAGE), null);
});

// The minted token must never linger in a buffer we don't scrub. The URL-finding
// accumulator `all` is dropped the instant the URL is found, so the later token
// (which arrives only after the code is submitted) never lands in it; the token
// flows solely into `f.out`, scrubbed on settle.
test("setup-token: the URL buffer is cleared once the URL is found, and f.out is scrubbed", () => {
  const SRC = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "setup-token.ts"),
    "utf8",
  );
  const onData = SRC.slice(SRC.indexOf("proc.onData"), SRC.indexOf("proc.onExit"));
  assert.ok(/f\.url = u;\s*\n\s*all = "";/.test(onData), "`all` is cleared when the URL is found");
  const submit = SRC.slice(SRC.indexOf("if (verdict.kind === \"success\")"));
  assert.ok((submit.match(/f\.out = "";/g) ?? []).length >= 2, "f.out is scrubbed on both success and store-failure paths");
});

import assert from "node:assert/strict";
import test from "node:test";
import { parseAuthStatus, parseLoginOutcome, parseLoginUrl, probeWith } from "../src/claude-auth.js";

const URL_ =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=ty2I7J6bCk3fM63ENABuO5hwGCB99nk9h6UQyCpY2aM" +
  "&code_challenge_method=S256&state=WZH7Z-PNxiJxxJbjqETE-v9Z6py_h2Oci8jJSb4wW_0";

/**
 * Real shape, captured 2026-08-08 from claude v2.1.226: the CLI wraps the URL in
 * an OSC 8 hyperlink (`ESC ] 8 ; ; <url> BEL <visible text> ESC ] 8 ; ; BEL`),
 * so the URL is physically present TWICE. The escapes are written as \x1b /
 * \x07 on purpose — a literal control character in a source file is invisible
 * and does not survive being copied around.
 */
const OSC8 =
  "Opening browser to sign in…\n" +
  `If the browser didn't open, visit: \x1b]8;;${URL_}\x07${URL_}\x1b]8;;\x07\n` +
  "Paste code here if prompted > ";

test("parseAuthStatus reads the CLI's JSON", () => {
  const s = parseAuthStatus(
    '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"a@b.c","subscriptionType":"max"}',
  );
  assert.deepEqual(s, {
    loggedIn: true,
    state: "signed-in",
    authMethod: "claude.ai",
    email: "a@b.c",
    subscriptionType: "max",
  });
});

test("a CLI that ANSWERED signed-out is signed-out", () => {
  const s = parseAuthStatus('{"loggedIn":false,"authMethod":"none"}');
  assert.equal(s.state, "signed-out");
  assert.equal(s.loggedIn, false);
});

test("output we could not read is UNKNOWN, never signed-out", () => {
  // THE distinction this type exists for. The probe is a ~850ms process spawn
  // and can fail; reading a failure as "signed out" popped the sign-in card and
  // spawned a login child on instances that were signed in the whole time.
  for (const bad of ["", "command not found", "[1,2,3]", '{"loggedIn":tr']) {
    assert.equal(parseAuthStatus(bad).state, "unknown", bad);
    assert.equal(parseAuthStatus(bad).loggedIn, false, bad);
  }
});

test("parseLoginUrl survives the OSC 8 hyperlink wrapper", () => {
  // A naive /visit: (\S+)/ captures the escape sequence and half the URL. The
  // escapes must be stripped BEFORE matching.
  assert.equal(parseLoginUrl(OSC8), URL_);
});

test("parseLoginUrl also handles a plain unwrapped line", () => {
  assert.equal(parseLoginUrl(`If the browser didn't open, visit: ${URL_}\n`), URL_);
});

test("parseLoginUrl returns null before the URL has been printed", () => {
  assert.equal(parseLoginUrl("Opening browser to sign in…\n"), null);
  assert.equal(parseLoginUrl(""), null);
});

test("parseLoginOutcome recognises the refusal the CLI actually prints", () => {
  // Only "invalid-code" is asserted, because only it was OBSERVED. Success is
  // detected by the child EXITING cleanly (see startLogin) — inventing a
  // success string would produce a sign-in that silently never completes.
  assert.equal(
    parseLoginOutcome(
      "Paste code here if prompted > Invalid code. Please make sure the full code was copied.\n",
    ),
    "invalid-code",
  );
  assert.equal(parseLoginOutcome("Paste code here if prompted > "), null);
  assert.equal(parseLoginOutcome(""), null);
});


/** What `execFile` throws when the kernel refuses to run a binary being
 *  rewritten. Node builds this one as a SYNCHRONOUS throw, not a callback
 *  error — which is how it escaped every `catch` on the spawn path. */
const etxtbsy = () => Object.assign(new Error("spawn ETXTBSY"), { code: "ETXTBSY" });

test("a binary caught mid-upgrade is waited out, not reported", async () => {
  // Every claude-code release rewrites a ~214 MB native binary in place, so the
  // window is seconds wide and a machine that follows releases meets it often.
  let calls = 0;
  const s = await probeWith(
    async () => {
      if (++calls < 3) throw etxtbsy();
      return '{"loggedIn":true,"authMethod":"claude.ai"}';
    },
    { sleep: async () => {} },
  );
  assert.equal(s.state, "signed-in");
  assert.equal(calls, 3);
});

test("a probe that could not run is unknown — it NEVER throws", async () => {
  // The whole point of the three-valued state (invariant 27). A throw is not a
  // fourth state, it is the harshest one: the `start` handler lets `unknown`
  // spawn anyway, but a throw never reaches that decision — it cancels the
  // spawn, and the user reads `⚠️ spawn ETXTBSY` with no agent and no reason.
  const s = await probeWith(async () => { throw etxtbsy(); }, { sleep: async () => {} });
  assert.equal(s.state, "unknown");
  assert.equal(s.loggedIn, false);
});

test("a failure that will not pass on its own is not retried six times", async () => {
  // A missing binary does not get better by being asked again, and burying it
  // under seconds of retries would only delay the message that says what broke.
  let calls = 0;
  const s = await probeWith(
    async () => {
      calls++;
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    },
    { sleep: async () => {} },
  );
  assert.equal(s.state, "unknown");
  assert.equal(calls, 1);
});

test("unreadable output is still unknown, not signed out", async () => {
  const s = await probeWith(async () => "not json at all", { sleep: async () => {} });
  assert.equal(s.state, "unknown");
});

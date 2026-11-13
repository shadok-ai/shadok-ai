import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "google.mjs");

async function stub(status, body) {
  const seen = {};
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.key = req.headers["x-shadok-session-key"];
      seen.body = raw ? JSON.parse(raw) : undefined;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

function run(args, port, stdin = "") {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env, SHADOK_PORT: String(port), SHADOK_SESSION_KEY: "key-123" } },
      (e, out, err) => resolve({ code: e ? (e.code ?? 1) : 0, out, err }),
    );
    child.stdin.end(stdin);
  });
}

/** One run against a stub that is always closed, even when an assertion throws. */
async function withStub(status, body, fn) {
  const s = await stub(status, body);
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

test("gmail send: the body comes from stdin, the fields from flags, the key in the header — and pending is explained", async () => {
  await withStub(200, { status: "pending", draftId: "ab12cd34" }, async (s) => {
    const r = await run(["gmail", "send", "--account", "g1", "--to", "bob@example.org", "--to", "cat@example.org", "--cc", "dan@example.org", "--subject", "Numbers", "--attach", "/tmp/q3.pdf", "--stdin"], s.port, "Hi Bob,\n\nHere.\n");
    assert.equal(r.code, 0, r.err);
    assert.equal(s.seen.url, "/google/actions");
    assert.equal(s.seen.key, "key-123");
    assert.deepEqual(s.seen.body, {
      account: "g1",
      action: "gmail.send",
      args: { to: ["bob@example.org", "cat@example.org"], cc: ["dan@example.org"], bcc: [], subject: "Numbers", body: "Hi Bob,\n\nHere.", attachments: ["/tmp/q3.pdf"] },
    });
    assert.match(r.out, /waiting for approval in the cockpit \(draft ab12cd34\)\. Nothing has left the account\. Do not say it is sent or done until you are told\./);
    assert.doesNotMatch(r.out + r.err, /key-123/);
  });
});

test("the body is never taken from argv: gmail and append commands refuse to run without --stdin", async () => {
  await withStub(200, {}, async (s) => {
    for (const args of [
      ["gmail", "send", "--account", "g1", "--to", "a@b.co", "--subject", "x"],
      ["gmail", "draft", "--account", "g1", "--to", "a@b.co", "--subject", "x"],
      ["doc", "append", "--account", "g1", "--id", "d1"],
      ["sheet", "append", "--account", "g1", "--id", "s1"],
    ]) {
      const r = await run(args, s.port);
      assert.equal(r.code, 1, args.join(" "));
      assert.match(r.err, /requires --stdin/);
    }
    const body = await run(["gmail", "send", "--account", "g1", "--to", "a@b.co", "--subject", "x", "--body", "inline"], s.port);
    assert.equal(body.code, 1, "there is no --body flag");
    assert.equal(s.seen.url, undefined, "nothing reached the cockpit");
  });
});

test("an empty body and a relative attachment are refused locally", async () => {
  await withStub(200, {}, async (s) => {
    const empty = await run(["gmail", "send", "--account", "g1", "--to", "a@b.co", "--subject", "x", "--stdin"], s.port, "  \n");
    assert.equal(empty.code, 1);
    assert.match(empty.err, /body is empty/);
    const rel = await run(["gmail", "send", "--account", "g1", "--to", "a@b.co", "--subject", "x", "--attach", "q3.pdf", "--stdin"], s.port, "hi");
    assert.equal(rel.code, 1);
    assert.match(rel.err, /must be absolute/);
    assert.equal(s.seen.url, undefined);
  });
});

test("calendar create: flags become the event, stdin its description; --to is a DATE for calendar list", async () => {
  await withStub(200, { status: "pending", draftId: "ee11" }, async (s) => {
    const r = await run(["calendar", "create", "--account", "g1", "--title", "Review", "--start", "2026-11-20T10:00", "--end", "2026-11-20T11:00", "--tz", "Europe/Paris", "--attendee", "bob@example.org", "--location", "Room 2", "--stdin"], s.port, "Agenda\n");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(s.seen.body, {
      account: "g1",
      action: "calendar.create",
      args: { title: "Review", start: "2026-11-20T10:00", end: "2026-11-20T11:00", timeZone: "Europe/Paris", attendees: ["bob@example.org"], location: "Room 2", description: "Agenda" },
    });
    assert.match(r.out, /The calendar change is waiting for approval/);
  });
  await withStub(200, { status: "done", result: { events: [{ id: "ev1", title: "Review", start: "2026-11-20T10:00:00+01:00", end: "2026-11-20T11:00:00+01:00", attendees: ["bob@example.org"] }] } }, async (s) => {
    const r = await run(["calendar", "list", "--account", "g1", "--from", "2026-11-20", "--to", "2026-11-27"], s.port);
    assert.deepEqual(s.seen.body, { account: "g1", action: "calendar.list", args: { from: "2026-11-20", to: "2026-11-27" } });
    assert.match(r.out, /^ev1 {2}2026-11-20T10:00:00\+01:00 → 2026-11-20T11:00:00\+01:00 {2}Review {2}\[bob@example\.org\]/);
  });
});

test("sheet append reads JSON rows from stdin; anything else is refused before the cockpit is called", async () => {
  await withStub(200, { status: "done", result: { id: "s1", updatedRange: "Sheet1!A1:B2" } }, async (s) => {
    const r = await run(["sheet", "append", "--account", "g1", "--id", "s1", "--stdin"], s.port, '[["Name","Qty"],["Bolt",12]]');
    assert.deepEqual(s.seen.body, { account: "g1", action: "sheet.append", args: { id: "s1", rows: [["Name", "Qty"], ["Bolt", 12]] } });
    assert.match(r.out, /Appended at Sheet1!A1:B2\./);
  });
  await withStub(200, {}, async (s) => {
    const r = await run(["sheet", "append", "--account", "g1", "--id", "s1", "--stdin"], s.port, "Name,Qty");
    assert.equal(r.code, 1);
    assert.match(r.err, /JSON array of rows/);
    assert.equal(s.seen.url, undefined);
  });
});

test("done results are said plainly: sent, draft, created", async () => {
  await withStub(200, { status: "done", result: { status: "sent", messageId: "m1" } }, async (s) => {
    assert.match((await run(["gmail", "send", "--account", "g1", "--to", "a@b.co", "--subject", "x", "--stdin"], s.port, "hi")).out, /^Sent\.$/m);
  });
  await withStub(200, { status: "done", result: { draftId: "r9", status: "draft" } }, async (s) => {
    const r = await run(["gmail", "draft", "--account", "g1", "--to", "a@b.co", "--subject", "x", "--update", "r1", "--stdin"], s.port, "hi");
    assert.equal(s.seen.body.args.update, "r1");
    assert.match(r.out, /Draft r9 is in the person's Gmail drafts\. Nothing was sent\./);
  });
  await withStub(200, { status: "done", result: { id: "doc1", name: "Notes", link: "https://docs.google.com/document/d/doc1/edit" } }, async (s) => {
    const r = await run(["doc", "create", "--account", "g1", "--title", "Notes", "--stdin"], s.port, "first\n");
    assert.deepEqual(s.seen.body, { account: "g1", action: "doc.create", args: { title: "Notes", text: "first" } });
    assert.match(r.out, /Created doc1: https:\/\/docs\.google\.com\/document\/d\/doc1\/edit/);
  });
});

test("accounts prints only the known fields of the Google accounts, never a token", async () => {
  await withStub(200, { accounts: [
    { id: "g1b2c3d4e5f6", label: "ana@example.org", provider: "google", kind: "member", policies: { mail: "approve", calendar: "autonomous" }, areas: ["calendar", "gmail"], expiresAt: Date.UTC(2026, 10, 20), status: "ok", token: "SECRET-TOK", refreshToken: "SECRET-REF" },
    { id: "li000000", label: "Ana", provider: "linkedin", policy: "approve", expiresAt: 1, status: "ok" },
    { id: "g2", label: "old@example.org", provider: "google", policies: { mail: "approve", calendar: "approve" }, areas: [], expiresAt: null, status: "expired" },
  ] }, async (s) => {
    const r = await run(["accounts"], s.port);
    assert.equal(s.seen.url, "/social/accounts");
    assert.equal(r.out, "g1b2c3d4  ana@example.org  areas=calendar,gmail  mail=approve  events=autonomous  reconnect-by=2026-11-20\ng2  old@example.org  areas=none  mail=approve  events=approve  reconnect-by=none  EXPIRED\n");
    assert.doesNotMatch(r.out + r.err, /SECRET|token|key-123/i);
  });
  await withStub(200, { accounts: [{ id: "li", provider: "linkedin" }] }, async (s) => {
    assert.match((await run(["accounts"], s.port)).out, /No Google account is available to this agent/);
  });
});

test("a refusal is relayed as the server's sentence, exit 1; an unknown command prints the usage", async () => {
  await withStub(409, { error: "Google account 'ana@example.org' needs a reconnect (test app authorisations last 7 days) — ana can do it in Secrets → Connected accounts." }, async (s) => {
    const r = await run(["drive", "list", "--account", "g1"], s.port);
    assert.equal(r.code, 1);
    assert.match(r.err, /needs a reconnect \(test app authorisations last 7 days\)/);
  });
  await withStub(200, {}, async (s) => {
    const r = await run(["gmail", "read", "--account", "g1"], s.port);
    assert.equal(r.code, 1);
    assert.match(r.err, /usage: google\.mjs/);
    assert.equal((await run(["drive", "list"], s.port)).code, 1, "--account is required");
  });
});

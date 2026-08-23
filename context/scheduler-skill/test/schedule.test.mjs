import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeCockpit } from "./fake-cockpit.mjs";
import { parseSchedule, label, parseArgs } from "../scripts/schedule.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "schedule.mjs");

/** Runs the script with a controlled env, like an agent would. */
function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env, SHADOK_PORT: "", SHADOK_SESSION_ID: "", SHADOK_AUTH: "", ...env } },
      (e, out, err) => resolve({ code: e ? (e.code ?? 1) : 0, out, err }),
    );
  });
}

const AGENT = (port) => ({ SHADOK_PORT: String(port), SHADOK_SESSION_ID: "sess-1", SHADOK_AUTH: "sk_auth=tok" });

test("parseSchedule understands minutes, hours and a bare number", () => {
  assert.deepEqual(parseSchedule("every:30m"), { kind: "interval", everyMin: 30 });
  assert.deepEqual(parseSchedule("every:2h"), { kind: "interval", everyMin: 120 });
  assert.deepEqual(parseSchedule("every:45"), { kind: "interval", everyMin: 45 });
  assert.deepEqual(parseSchedule("EVERY:15M"), { kind: "interval", everyMin: 15 });
});

test("parseSchedule reads a daily wall-clock time", () => {
  assert.deepEqual(parseSchedule("daily:09:00"), { kind: "daily", hour: 9, minute: 0 });
  assert.deepEqual(parseSchedule(" daily:18:30 "), { kind: "daily", hour: 18, minute: 30 });
});

test("parseSchedule refuses garbage instead of sending NaN to the server", () => {
  for (const bad of ["every:soon", "daily:nine", "daily:09", "hourly", "", "every:"]) {
    assert.throws(() => parseSchedule(bad), /bad schedule/, `accepted '${bad}'`);
  }
});

test("label always names the timezone of a daily schedule", () => {
  assert.equal(label({ kind: "daily", hour: 9, minute: 0 }, "Europe/Paris"), "daily 09:00 (Europe/Paris)");
  assert.equal(label({ kind: "daily", hour: 9, minute: 5 }), "daily 09:05");
  // An interval is a duration, so it has no timezone to show.
  assert.equal(label({ kind: "interval", everyMin: 30 }, "Europe/Paris"), "every 30m");
});

test("parseArgs keeps the documented flags and their requirements", () => {
  const r = parseArgs(["add", "--schedule", "daily:09:00", "--prompt", "hi", "--check", "sh x.sh", "--tz", "Europe/Paris"]);
  assert.deepEqual(r.opts, { schedule: "daily:09:00", prompt: "hi", check: "sh x.sh", tz: "Europe/Paris" });
  assert.throws(() => parseArgs(["add", "--prompt", "hi"]), /--schedule/);
  assert.throws(() => parseArgs(["add", "--schedule", "every:5m"]), /--prompt/);
  assert.throws(() => parseArgs(["del"]), /required/);
  assert.equal(parseArgs(["del", "abc12345"]).pos[0], "abc12345");
  assert.equal(parseArgs(["tz"]).pos.length, 0);
  assert.equal(parseArgs(["tz", "Europe/Paris"]).pos[0], "Europe/Paris");
  assert.throws(() => parseArgs(["nope"]), /invalid choice/);
});

test("refuses to run outside a shadok-ai channel", async () => {
  const noPort = await run(["list"], { SHADOK_SESSION_ID: "sess-1" });
  assert.notEqual(noPort.code, 0);
  assert.match(noPort.err, /SHADOK_PORT/);
  const noSid = await run(["list"], { SHADOK_PORT: "1" });
  assert.notEqual(noSid.code, 0);
  assert.match(noSid.err, /SHADOK_SESSION_ID/);
});

test("add posts the channel's own sessionId, the guard and the timezone", async () => {
  const srv = await fakeCockpit({
    "POST /crons": { body: { id: "abcdef0123456789", schedule: { kind: "daily", hour: 9, minute: 0 }, timezone: "Europe/Paris" } },
  });
  const res = await run(
    ["add", "--schedule", "daily:09:00", "--prompt", "report", "--check", "sh guard.sh", "--tz", "Europe/Paris"],
    AGENT(srv.port),
  );
  await srv.close();
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(srv.seen[0].body, {
    sessionId: "sess-1",
    prompt: "report",
    schedule: { kind: "daily", hour: 9, minute: 0 },
    enabled: true,
    check: "sh guard.sh",
    tz: "Europe/Paris",
  });
  assert.equal(srv.seen[0].cookie, "sk_auth=tok");
  assert.match(res.out, /scheduled \[abcdef01\] daily 09:00 \(Europe\/Paris\) \+guard/);
});

test("a bad schedule fails before anything is sent", async () => {
  const srv = await fakeCockpit({});
  const res = await run(["add", "--schedule", "every:soon", "--prompt", "x"], AGENT(srv.port));
  await srv.close();
  assert.notEqual(res.code, 0);
  assert.match(res.err, /bad schedule/);
  assert.equal(srv.seen.length, 0);
});

test("list only shows this channel's schedules, with their timezone", async () => {
  const srv = await fakeCockpit({
    "GET /crons": {
      body: [
        { id: "aaaaaaaa1111", sessionId: "sess-1", enabled: true, check: "sh x", schedule: { kind: "daily", hour: 9, minute: 0 }, prompt: "mine" },
        { id: "bbbbbbbb2222", sessionId: "other", enabled: true, schedule: { kind: "interval", everyMin: 5 }, prompt: "someone else's" },
      ],
    },
    "GET /timezone": { body: { timezone: "Europe/Paris", system: "UTC" } },
  });
  const res = await run(["list"], AGENT(srv.port));
  await srv.close();
  assert.match(res.out, /\[aaaaaaaa\] daily 09:00 \(Europe\/Paris\) \+guard/);
  assert.doesNotMatch(res.out, /someone else's/);
});

test("del sends the 8-char prefix the listing prints, url-encoded", async () => {
  const srv = await fakeCockpit({ "DELETE /crons": { body: { id: "abcdef0123456789" } } });
  const res = await run(["del", "abcdef01"], AGENT(srv.port));
  await srv.close();
  assert.equal(srv.seen[0].query, "id=abcdef01");
  assert.match(res.out, /deleted abcdef01/);
});

test("env names the secrets a guard really gets, and the ones it won't", async () => {
  const srv = await fakeCockpit({
    "GET /channels": { body: [{ sessionId: "sess-1", cwd: "/w/t", profile: "P" }] },
    "GET /profiles": { body: [{ name: "P", secrets: ["HAVE", "MISSING"] }] },
    "GET /secrets": { body: { names: ["HAVE"] } },
  });
  const res = await run(["env"], AGENT(srv.port));
  await srv.close();
  assert.match(res.out, /guard cwd: \/w\/t/);
  assert.match(res.out, /guard secrets \(profile 'P'\): HAVE/);
  assert.match(res.out, /NOT in the vault[^\n]*MISSING/);
});

test("env says which cause when a channel has no profile", async () => {
  const srv = await fakeCockpit({ "GET /channels": { body: [{ sessionId: "sess-1", cwd: "/w/t" }] } });
  const res = await run(["env"], AGENT(srv.port));
  await srv.close();
  assert.match(res.out, /guard secrets: NONE — this channel has no profile/);
});

test("an API error is reported, not swallowed", async () => {
  const srv = await fakeCockpit({ "POST /crons": { status: 500, body: { error: "boom" } } });
  const res = await run(["add", "--schedule", "every:5m", "--prompt", "x"], AGENT(srv.port));
  await srv.close();
  assert.notEqual(res.code, 0);
  assert.match(res.err, /API error 500/);
});

test("parseSchedule passes a one-shot date through for the server to resolve", () => {
  // Deliberately NOT parsed here: the instant depends on the cron's timezone,
  // which only the server knows. Two parsers would be two truths.
  assert.deepEqual(parseSchedule("once:2026-08-25T08:42"), { kind: "once", at: "2026-08-25t08:42" });
  assert.deepEqual(parseSchedule(" ONCE:2026-08-25T08:42 "), { kind: "once", at: "2026-08-25t08:42" });
});

test("parseSchedule still refuses garbage, and names once in the message", () => {
  assert.throws(() => parseSchedule("once:"), /bad schedule/);
  assert.throws(() => parseSchedule("nonsense"), /once:2026-08-25T08:42/);
});

test("label reads a one-shot instant in the cron's timezone", () => {
  const at = Date.UTC(2026, 7, 25, 6, 42); // 08:42 in Paris (CEST)
  assert.equal(label({ kind: "once", at }, "Europe/Paris"), "once 2026-08-25 08:42 (Europe/Paris)");
  assert.equal(label({ kind: "once", at }, "UTC"), "once 2026-08-25 06:42 (UTC)");
});

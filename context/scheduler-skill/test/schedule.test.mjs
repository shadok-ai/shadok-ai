import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeCockpit } from "./fake-cockpit.mjs";
import { parseSchedule, label, parseArgs, resolveMine, updateBody } from "../scripts/schedule.mjs";

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
  // No cookie any more, even if one sits in the env: the session key is an
  // agent's only credential.
  assert.equal(srv.seen[0].cookie, undefined);
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

test("env reports what the SERVER resolves, not what the profile lists", async () => {
  // CHIPPED is bound to the profile from the SECRET's side, so it is absent
  // from `profiles[].secrets` and present in the guard. Deriving the answer
  // here reported it missing; asking the server is the fix.
  const srv = await fakeCockpit({
    "GET /crons/env": {
      body: {
        cwd: "/w/t", known: true, profile: "P",
        secrets: ["CHIPPED", "HAVE"], unresolved: ["ELSEWHERE"],
        env: ["PATH", "SHADOK_PORT", "TZ"],
      },
    },
    "GET /profiles": { body: [{ name: "P", secrets: ["HAVE", "ELSEWHERE"] }] },
  });
  const res = await run(["env"], AGENT(srv.port));
  await srv.close();
  assert.equal(srv.seen[0].query, "session=sess-1");
  assert.match(res.out, /guard cwd: \/w\/t/);
  assert.match(res.out, /guard secrets \(profile 'P'\): CHIPPED, HAVE/);
  assert.match(res.out, /NOT resolvable[^\n]*ELSEWHERE/);
  assert.match(res.out, /guard env \(names only\): PATH, SHADOK_PORT, TZ/);
  // No reload is involved: saying so stops the next agent inventing one.
  assert.match(res.out, /next run/i);
  // The profile list must not be consulted at all any more.
  assert.ok(!srv.seen.some((r) => r.path === "/profiles"), "still reads /profiles");
});

test("env lists an 'any profile' secret even with no profile at all", async () => {
  // The old answer was a flat "NONE — this channel has no profile", which is
  // false: a `*` binding reaches a profile-less agent.
  const srv = await fakeCockpit({
    "GET /crons/env": { body: { cwd: "/w/t", known: true, profile: null, secrets: ["WIDE"], env: ["PATH"] } },
  });
  const res = await run(["env"], AGENT(srv.port));
  await srv.close();
  assert.match(res.out, /guard secrets \(no profile\): WIDE/);
});

test("env on an unregistered channel does not claim 'no secrets at all'", async () => {
  // It used to say exactly that, which a `*` binding contradicts on the very
  // next line.
  const srv = await fakeCockpit({
    "GET /crons/env": { body: { cwd: "/srv", known: false, profile: null, secrets: ["WIDE"], env: ["PATH"] } },
  });
  const res = await run(["env"], AGENT(srv.port));
  await srv.close();
  assert.match(res.out, /not registered server-side/);
  assert.match(res.out, /guard secrets \(no profile\): WIDE/);
  assert.doesNotMatch(res.out, /no profile secrets at all/);
});

test("env with nothing bound explains BOTH ways a secret can arrive", async () => {
  const srv = await fakeCockpit({
    "GET /crons/env": { body: { cwd: "/w/t", known: true, profile: "P", secrets: [], env: ["PATH"] } },
  });
  const res = await run(["env"], AGENT(srv.port));
  await srv.close();
  assert.match(res.out, /guard secrets \(profile 'P'\): NONE/);
  assert.match(res.out, /any profile/);
});

test("env on an older cockpit degrades, and says it is half-blind", async () => {
  // Several cockpits on one machine share the skill tier, so this file can run
  // against a server that predates /crons/env. A 404 must not abort the command.
  const srv = await fakeCockpit({
    "GET /crons/env": { status: 404, body: { error: "not found" } },
    "GET /channels": { body: [{ sessionId: "sess-1", cwd: "/w/t", profile: "P" }] },
    "GET /profiles": { body: [{ name: "P", secrets: ["HAVE", "MISSING"] }] },
    "GET /secrets": { body: { names: ["HAVE"] } },
  });
  const res = await run(["env"], AGENT(srv.port));
  await srv.close();
  assert.equal(res.code, 0);
  assert.match(res.out, /guard secrets \(profile 'P'\): HAVE/);
  assert.match(res.out, /NOT in the vault[^\n]*MISSING/);
  assert.match(res.out, /older than this skill/);
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

test("parseSchedule: a daily restricted to some days sends the list as written", () => {
  assert.deepEqual(parseSchedule("daily:09:00@mon-fri"), { kind: "daily", hour: 9, minute: 0, days: "mon-fri" });
  assert.deepEqual(parseSchedule("daily:08:30@Mon,Wed"), { kind: "daily", hour: 8, minute: 30, days: "mon,wed" });
  assert.throws(() => parseSchedule("daily:09:00@"));
});

test("label: a restricted daily names its days", () => {
  assert.equal(label({ kind: "daily", hour: 9, minute: 0, days: [1, 3] }, "Europe/Paris"), "mon,wed 09:00 (Europe/Paris)");
});

const CRONS = [
  { id: "3f2a9c1e-aaaa", sessionId: "sess-1", prompt: "watch", schedule: { kind: "interval", everyMin: 60 }, check: "sh guard.sh", enabled: true },
  { id: "3f2b0000-bbbb", sessionId: "sess-1", prompt: "other", schedule: { kind: "daily", hour: 9, minute: 0 }, enabled: true },
  { id: "9e9e9e9e-cccc", sessionId: "sess-2", prompt: "not mine", schedule: { kind: "interval", everyMin: 5 }, enabled: true },
];

test("update: takes no --check (it is pre-allowed past the classifier) and needs an id", () => {
  assert.deepEqual(parseArgs(["update", "3f2a9c1e", "--schedule", "every:15m"]).opts, { schedule: "every:15m" });
  assert.throws(() => parseArgs(["update", "3f2a9c1e", "--check", "rm -rf /"]), /unrecognized argument --check/);
  assert.throws(() => parseArgs(["update"]), /required/);
});

test("resolveMine: a prefix names one schedule of THIS channel, never another's", () => {
  assert.equal(resolveMine(CRONS, "sess-1", "3f2a9c1e").id, "3f2a9c1e-aaaa");
  assert.throws(() => resolveMine(CRONS, "sess-1", "3f2"), /matches 2 schedules/);
  assert.throws(() => resolveMine(CRONS, "sess-1", "9e9e"), /no schedule '9e9e'/);
  assert.throws(() => resolveMine(CRONS, "sess-1", ""), /no schedule/);
});

test("updateBody: changes only what is given and carries the guard over", () => {
  assert.deepEqual(updateBody(CRONS[0], { schedule: "every:15m" }), {
    id: "3f2a9c1e-aaaa", sessionId: "sess-1", prompt: "watch", schedule: { kind: "interval", everyMin: 15 }, check: "sh guard.sh",
  });
  assert.equal(updateBody(CRONS[1], { prompt: "new" }).check, undefined);
  assert.equal(updateBody(CRONS[1], { tz: "Europe/Paris" }).tz, "Europe/Paris");
  assert.throws(() => updateBody(CRONS[0], {}), /at least one/);
});

test("update end to end: resolves the prefix, posts the full cron with its id", async () => {
  const cockpit = await fakeCockpit({
    "GET /crons": CRONS,
    "POST /crons": { id: "3f2a9c1e-aaaa", schedule: { kind: "interval", everyMin: 15 }, check: "sh guard.sh", enabled: true },
  });
  try {
    const r = await run(["update", "3f2a9c1e", "--schedule", "every:15m"], AGENT(cockpit.port));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /updated \[3f2a9c1e\] every 15m \+guard/);
    const post = cockpit.seen.find((x) => x.method === "POST");
    assert.equal(post.body.id, "3f2a9c1e-aaaa");
    assert.equal(post.body.check, "sh guard.sh");
  } finally {
    await cockpit.close();
  }
});

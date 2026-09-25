import assert from "node:assert/strict";
import test from "node:test";
import {
  offerVerdict, withOffer, offeredPaths, refusalMessage, MAX_OFFER_BYTES, MAX_OFFERS,
  type OfferedFile,
} from "../src/files.js";

const ok = (v: ReturnType<typeof offerVerdict>) => {
  assert.ok(v.ok, "expected an accepted offer");
  return v.file;
};

test("an offer needs an ABSOLUTE path", () => {
  // Not fussiness: the server's cwd is its launch dir and never the agent's
  // (invariant 1), so a relative path would resolve against the wrong directory
  // and "work" only by accident when the two coincide. The skill resolves it
  // agent-side, where the cwd is right.
  const v = offerVerdict("s1", "report.pdf", { isFile: true, size: 10 }, 1);
  assert.equal(v.ok, false);
  assert.equal((v as any).reason, "not-absolute");
  assert.equal(offerVerdict("s1", "", { isFile: true, size: 10 }, 1).ok, false);
});

test("absent and unreadable stay APART", () => {
  // They send the agent to different places: it wrote the wrong path, versus
  // the server cannot see a path that is really there. Collapsing them costs a
  // round trip and points at the wrong subsystem.
  assert.equal((offerVerdict("s1", "/a/b.pdf", "missing", 1) as any).reason, "missing");
  assert.equal((offerVerdict("s1", "/a/b.pdf", "unreadable", 1) as any).reason, "unreadable");
  assert.notEqual(
    refusalMessage(offerVerdict("s1", "/a/b.pdf", "missing", 1) as any),
    refusalMessage(offerVerdict("s1", "/a/b.pdf", "unreadable", 1) as any),
  );
});

test("a directory is refused, and so is something too large", () => {
  assert.equal((offerVerdict("s1", "/tmp", { isFile: false, size: 0 }, 1) as any).reason, "not-a-file");
  const big = offerVerdict("s1", "/a/huge.bin", { isFile: true, size: MAX_OFFER_BYTES + 1 }, 1);
  assert.equal((big as any).reason, "too-big");
  // The boundary itself is allowed — an off-by-one here refuses a file the cap
  // was written to permit.
  assert.ok(offerVerdict("s1", "/a/edge.bin", { isFile: true, size: MAX_OFFER_BYTES }, 1).ok);
});

test("an accepted offer carries the basename, the size and the caption", () => {
  const f = ok(offerVerdict("s1", "/tmp/deep/rapport.pdf", { isFile: true, size: 42 }, 1234, "  le rapport "));
  assert.equal(f.name, "rapport.pdf");
  assert.equal(f.size, 42);
  assert.equal(f.at, 1234);
  assert.equal(f.caption, "le rapport");
  // A blank caption is absent, not an empty string the UI would render as a gap.
  assert.equal(ok(offerVerdict("s1", "/tmp/a.pdf", { isFile: true, size: 1 }, 1, "   ")).caption, undefined);
});

test("re-offering the same path SUPERSEDES its row", () => {
  // An agent that regenerates a report and sends it again should leave one
  // card's worth of state, not a log — the rule the ledger learned the hard way
  // when one cron turned a state table into a changelog.
  const a = ok(offerVerdict("s1", "/tmp/r.pdf", { isFile: true, size: 1 }, 100));
  const b = ok(offerVerdict("s1", "/tmp/r.pdf", { isFile: true, size: 2 }, 200));
  const rows = withOffer(withOffer([], a), b);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].size, 2);
  assert.equal(rows[0].at, 200);
});

test("the same path from ANOTHER session is a different row", () => {
  // The read gate is per session; collapsing two sessions' rows would let one
  // agent's offer authorise a download on another's channel.
  const a = ok(offerVerdict("s1", "/tmp/r.pdf", { isFile: true, size: 1 }, 1));
  const b = ok(offerVerdict("s2", "/tmp/r.pdf", { isFile: true, size: 1 }, 2));
  assert.equal(withOffer(withOffer([], a), b).length, 2);
});

test("the table is bounded", () => {
  let rows: OfferedFile[] = [];
  for (let i = 0; i < MAX_OFFERS + 25; i++) {
    rows = withOffer(rows, ok(offerVerdict("s1", `/tmp/f${i}.pdf`, { isFile: true, size: 1 }, i)));
  }
  assert.equal(rows.length, MAX_OFFERS);
  // The OLDEST go, not the newest: a cap that drops what just arrived would
  // make the last offer the one that cannot be downloaded.
  assert.equal(rows[rows.length - 1].path, `/tmp/f${MAX_OFFERS + 24}.pdf`);
});

test("offeredPaths is scoped to ONE session — the read gate", () => {
  // The whole security property, in one assertion: GET /download serves a path
  // only if it is here (or in that session's transcript), so it can never be
  // walked into an arbitrary file, and one agent's offer never authorises a
  // download on another agent's channel.
  const rows = [
    ok(offerVerdict("s1", "/tmp/mine.pdf", { isFile: true, size: 1 }, 1)),
    ok(offerVerdict("s2", "/tmp/theirs.pdf", { isFile: true, size: 1 }, 2)),
  ];
  const mine = offeredPaths(rows, "s1");
  assert.ok(mine.has("/tmp/mine.pdf"));
  assert.ok(!mine.has("/tmp/theirs.pdf"), "another session's offer must not authorise this one");
  assert.equal(offeredPaths(rows, "unknown").size, 0);
  assert.ok(!offeredPaths(rows, "s1").has("/etc/passwd"));
});

test("a refusal names the path and says what is wrong", () => {
  // A silently dropped file is the exact failure this feature exists to remove,
  // so every refusal has to be readable by the agent that will act on it.
  for (const stat of ["missing", "unreadable", { isFile: false, size: 0 }] as const) {
    const v = offerVerdict("s1", "/tmp/x.pdf", stat as any, 1);
    assert.equal(v.ok, false);
    const msg = refusalMessage(v as any);
    assert.match(msg, /\/tmp\/x\.pdf/);
    assert.ok(msg.length > 20, "a refusal must explain, not just name a code");
  }
});

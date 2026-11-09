import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canSeeGroup, viewerFor, type Group } from "../src/groups.js";

// Task 10 round-2: the server's OWN loopback deliveries (cron fires, parent
// notifications, the reload nudge — all via `driveChannel`) authenticate as the
// bootstrap admin, which `mayDriveSession` does NOT exempt from the per-group
// gate. In multi-tenant that REFUSED every legitimate system delivery to a
// restricted/private group's channel, breaking crons/notifications/reload for
// every non-commons agent. The fix is an unforgeable per-process secret: the
// DECISION is pure (tested below with a faithful replica of `mayDriveSession`),
// and the un-importable `server.ts` WIRING is locked by the source-scan suite,
// the same pattern as `test/server-acl-leaks.test.ts` / `test/ws-url.test.ts`.

// ── Fixtures: a restricted group G, a member, a non-member ─────────────────────
const groups: Group[] = [
  { id: "main", name: "main", nature: "public", members: [], createdAt: 0 },
  { id: "comex", name: "COMEX", nature: "restricted", members: ["ada"], createdAt: 0 },
];
const ada = { name: "ada", role: "member" as const }; // IN COMEX
const bob = { name: "bob", role: "member" as const }; // NOT in COMEX

// Faithful replica of `server.ts`'s `mayDriveSession` decision (the function
// itself cannot be imported — it closes over the live WS connection). The
// CRITICAL property: the system-drive exemption is gated on `isSystemDrive`
// ALONE, which in the server is a constant-time compare of an unforgeable
// secret — NEVER on a client-settable field like `origin`.
function mayDrive(opts: {
  mode: "multi-tenant" | "mono-tenant";
  isSystemDrive: boolean;
  group: Group | null;
  viewer: ReturnType<typeof viewerFor>;
}): boolean {
  if (opts.mode !== "multi-tenant") return true; // mono-tenant unchanged
  if (opts.isSystemDrive) return true; // the server driving its own channel
  if (!opts.group) return true; // commons / group-less
  return canSeeGroup(opts.group, opts.viewer);
}

const comex = groups.find((g) => g.id === "comex")!;

test("mayDriveSession decision: system-drive is exempt on a restricted group; a non-member is refused; a member is allowed", () => {
  // A SYSTEM drive (the secret verified at connect) reaches a restricted group's
  // own channel regardless of who the connection authenticates as — the server
  // is delivering to a channel it manages.
  assert.equal(
    mayDrive({ mode: "multi-tenant", isSystemDrive: true, group: comex, viewer: viewerFor(bob) }),
    true,
    "a system drive is authorized on a restricted group",
  );
  // A non-member HUMAN (no secret) stays gated out of a foreign group.
  assert.equal(
    mayDrive({ mode: "multi-tenant", isSystemDrive: false, group: comex, viewer: viewerFor(bob) }),
    false,
    "a non-member human cannot drive a restricted group",
  );
  // A MEMBER (no secret) is allowed by the ordinary group check.
  assert.equal(
    mayDrive({ mode: "multi-tenant", isSystemDrive: false, group: comex, viewer: viewerFor(ada) }),
    true,
    "a member can drive their own group",
  );
  // Mono-tenant short-circuits regardless of secret or group — byte-for-byte today's.
  assert.equal(
    mayDrive({ mode: "mono-tenant", isSystemDrive: false, group: comex, viewer: viewerFor(bob) }),
    true,
    "mono-tenant is never gated",
  );
});

// ── Wiring locks (source-scan) — the `server.ts` surfaces are un-importable ────
const SERVER_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"),
  "utf8",
);

test("the system-drive secret is randomBytes-generated, and never logged or sent", () => {
  // A fresh per-process random value — not a fixed string, not read from config.
  assert.match(
    SERVER_SRC,
    /const SYSTEM_DRIVE_SECRET = randomBytes\(32\)\.toString\("hex"\);/,
    "SYSTEM_DRIVE_SECRET must be randomBytes-generated",
  );
  // It must never reach a client or a log. Every line that mentions the secret
  // must be the definition, the loopback header, or the connect-time compare —
  // never a `console.*`, a `res.json`, or a `.send(`.
  for (const line of SERVER_SRC.split("\n")) {
    if (!line.includes("SYSTEM_DRIVE_SECRET")) continue;
    assert.ok(!/console\./.test(line), `the secret must never be logged: ${line.trim()}`);
    assert.ok(!/res\.(json|send)/.test(line), `the secret must never be sent in a response: ${line.trim()}`);
    assert.ok(!/\bsend\(/.test(line), `the secret must never be sent to a client: ${line.trim()}`);
  }
});

test("driveChannel sets the x-shadok-system-drive header with the secret", () => {
  // The server's loopback opener (cron/notification/reload all route through it)
  // must carry the secret, or the exemption never reaches the WS connect.
  const drive = SERVER_SRC.indexOf("function driveChannel(");
  assert.ok(drive > 0, "driveChannel must exist");
  const body = SERVER_SRC.slice(drive, drive + 1200);
  assert.match(
    body,
    /"x-shadok-system-drive":\s*SYSTEM_DRIVE_SECRET/,
    "driveChannel must present the secret as the x-shadok-system-drive header",
  );
});

test("the WS connect computes isSystemDrive by a constant-time compare of the header against the secret — NOT from origin", () => {
  // The exemption signal is read from the unforgeable secret header via
  // timingSafeEqual, with a length guard. It must NOT be derived from any
  // client-settable field (`origin`), or a browser could forge a system drive.
  const connect = SERVER_SRC.indexOf('wss.on("connection"');
  assert.ok(connect > 0, "the WS connection handler must exist");
  // Locate the isSystemDrive computation and bound it to its IIFE body.
  const marker = SERVER_SRC.indexOf("const isSystemDrive = ", connect);
  assert.ok(marker > connect, "isSystemDrive must be computed at connect");
  // Bound strictly to the IIFE body so the scan cannot drift into later code
  // (the `origin` comment a few lines below is NOT part of this computation).
  const end = SERVER_SRC.indexOf("})();", marker);
  assert.ok(end > marker, "the isSystemDrive IIFE must close");
  const region = SERVER_SRC.slice(marker, end);
  assert.ok(
    region.includes('req.headers["x-shadok-system-drive"]'),
    "isSystemDrive must read the x-shadok-system-drive header",
  );
  assert.ok(region.includes("timingSafeEqual"), "isSystemDrive must compare in constant time");
  assert.ok(region.includes("SYSTEM_DRIVE_SECRET"), "isSystemDrive must compare against the per-process secret");
  assert.ok(
    region.includes(".length === ") || region.includes(".length ==="),
    "the constant-time compare must guard the length first",
  );
  // The secret — not origin — is what grants the exemption.
  assert.ok(!/origin/.test(region), "isSystemDrive must NOT be derived from a client-settable origin field");
});

test("mayDriveSession consults isSystemDrive, and its exemption is the secret — not origin", () => {
  const fn = SERVER_SRC.indexOf("const mayDriveSession = (");
  assert.ok(fn > 0, "mayDriveSession must exist");
  // Bound to the arrow function body (ends at the next `};`).
  const rest = SERVER_SRC.slice(fn);
  const end = rest.indexOf("\n  };");
  const body = end > 0 ? rest.slice(0, end) : rest.slice(0, 600);
  assert.ok(body.includes("if (isSystemDrive) return true;"), "mayDriveSession must exempt a system drive");
  // The ONLY thing that grants the exemption is the secret-derived boolean; a
  // client-settable `origin` must play no part in the drive decision.
  assert.ok(!/origin/.test(body), "mayDriveSession must NOT grant drive based on origin");
});

test("the resume people-boundary gate also honors the system-drive exemption", () => {
  // Every `driveChannel` delivery is a resume, so the resume gate must let a
  // verified system connection through too, or crons/notifications/reload still
  // break at the resume boundary before mayDriveSession is ever reached.
  const gate = SERVER_SRC.indexOf("canResumeAs(storedGroupId, groupsNow");
  assert.ok(gate > 0, "the canResumeAs resume gate must exist");
  const region = SERVER_SRC.slice(gate - 400, gate + 200);
  assert.ok(region.includes("!isSystemDrive"), "the resume gate must skip the group check for a system drive");
});

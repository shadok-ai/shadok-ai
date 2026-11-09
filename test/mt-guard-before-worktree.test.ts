import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A refused (token-less) group spawn must not leave an orphan git worktree +
// branch behind, so the MT-token guard has to run BEFORE `createWorktree(` in
// the new-spawn path. `server.ts` is un-importable, so this is a source scan.
const server = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"),
  "utf8",
);

test("the MT-token guard runs before createWorktree in the spawn path", () => {
  const wt = server.indexOf("worktree = createWorktree(");
  // The guard is the connect verdict (src/connect-gate.ts) since the onboarding
  // rework; its early call must still come before the checkout is created.
  const guard = server.indexOf("await connectRefusal(earlyUser)");
  assert.ok(wt > 0 && guard > 0, "both anchors must exist");
  assert.ok(guard < wt, "the early connect guard must appear before worktree = createWorktree(");
  assert.ok(server.indexOf("return fail(early.message") < wt, "the early refusal must return before createWorktree");
});

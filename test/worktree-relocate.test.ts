import assert from "node:assert/strict";
import test from "node:test";
import { strandedWorktreePlan, canonicalWorktreeTarget } from "../src/worktree-relocate.js";
import type { StrandedPlanDeps, RelocatableChannel } from "../src/worktree-relocate.js";

// A default deps set: commons `main`, home /home/main, and a reachability fn
// that says a cwd is reachable iff it is already under the user's home. Every
// test overrides what it needs.
function deps(over: Partial<StrandedPlanDeps> = {}): StrandedPlanDeps {
  return {
    dropUserFor: (g) => (g === "public1" ? null : "main"),
    stateHomeFor: () => "/home/main",
    canReach: (_u, cwd) => cwd.startsWith("/home/main/"),
    isWorktreeCwd: (cwd) => cwd.includes("/worktrees/"),
    ...over,
  };
}

test("canonicalWorktreeTarget keeps the basename, under the user's own worktrees", () => {
  assert.equal(
    canonicalWorktreeTarget("/home/main", "/root/.shadok-ai/worktrees/shadok-ai-d97e05ac"),
    "/home/main/.shadok-ai/worktrees/shadok-ai-d97e05ac",
  );
});

test("a stranded /root worktree is planned for relocation to the drop user's home", () => {
  const chans: RelocatableChannel[] = [
    { sessionId: "d97e05ac", cwd: "/root/.shadok-ai/worktrees/shadok-ai-d97e05ac", group: null, repo: "/repo", branch: "b" },
  ];
  const plan = strandedWorktreePlan(chans, deps());
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0], {
    sessionId: "d97e05ac",
    from: "/root/.shadok-ai/worktrees/shadok-ai-d97e05ac",
    to: "/home/main/.shadok-ai/worktrees/shadok-ai-d97e05ac",
    user: "main",
    repo: "/repo",
    branch: "b",
  });
});

test("a working agent (reachable worktree) is NEVER relocated", () => {
  const chans: RelocatableChannel[] = [
    { sessionId: "ok1", cwd: "/home/main/.shadok-ai/worktrees/shadok-ai-ok1", group: null },
  ];
  assert.deepEqual(strandedWorktreePlan(chans, deps()), []);
});

test("a public/server-run agent (no drop user) is skipped", () => {
  const chans: RelocatableChannel[] = [
    { sessionId: "pub", cwd: "/root/.shadok-ai/worktrees/shadok-ai-pub", group: "public1" },
  ];
  assert.deepEqual(strandedWorktreePlan(chans, deps()), []);
});

test("the launch dir (not a worktree) is skipped", () => {
  const chans: RelocatableChannel[] = [
    { sessionId: "lead", cwd: "/root/projects/app", group: null },
  ];
  assert.deepEqual(strandedWorktreePlan(chans, deps({ canReach: () => false })), []);
});

test("an unreachable worktree ALREADY at its canonical path is not relocated onto itself", () => {
  // e.g. canonical is /home/main/... but an ancestor is 700 — a move cannot help,
  // so it must not be planned (which would be a no-op move onto itself).
  const chans: RelocatableChannel[] = [
    { sessionId: "self", cwd: "/home/main/.shadok-ai/worktrees/shadok-ai-self", group: null },
  ];
  const plan = strandedWorktreePlan(chans, deps({ canReach: () => false }));
  assert.deepEqual(plan, []);
});

test("a channel with no session or no cwd is skipped", () => {
  const chans: RelocatableChannel[] = [
    { sessionId: null, cwd: "/root/.shadok-ai/worktrees/x", group: null },
    { sessionId: "nocwd", cwd: "", group: null },
  ];
  assert.deepEqual(strandedWorktreePlan(chans, deps()), []);
});

test("a private group's sk-* worktree relocates to that group's home", () => {
  const chans: RelocatableChannel[] = [
    { sessionId: "p", cwd: "/root/.shadok-ai/worktrees/app-p", group: "g2" },
  ];
  const plan = strandedWorktreePlan(
    chans,
    deps({ dropUserFor: () => "sk-g2", stateHomeFor: (u) => `/home/${u}`, canReach: () => false }),
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0].to, "/home/sk-g2/.shadok-ai/worktrees/app-p");
  assert.equal(plan[0].user, "sk-g2");
});

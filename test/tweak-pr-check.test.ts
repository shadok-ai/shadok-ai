import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The guard runs 288 times a day, per open PR. What matters is not that it
// detects a change — it is that it stays SILENT the rest of the time: the
// slightest line on stdout wakes the agent and costs a turn (invariant 16).
const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "context", "tweak-pr-check.sh",
);

/** Runs the guard with a fake `gh` at the head of PATH and a throwaway HOME. */
function runGuard(ghBody: string, home: string, args: string[] = ["7"]) {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\n" + ghBody, { mode: 0o755 });
  const res = execFileSync("sh", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: bin + ":" + process.env.PATH },
  });
  return res;
}
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "tweakcheck-"));

test("guard: first observation → silence (the agent has just opened the PR)", () => {
  assert.equal(runGuard('echo "OPEN|MERGEABLE||verify=SUCCESS "', tmpHome()), "");
});

test("guard: unchanged state → silence", () => {
  const home = tmpHome();
  const gh = 'echo "OPEN|MERGEABLE||verify=SUCCESS "';
  runGuard(gh, home);
  assert.equal(runGuard(gh, home), "", "un second passage identique doit rester muet");
  assert.equal(runGuard(gh, home), "");
});

test("guard: the CI goes red → one line, exactly once", () => {
  const home = tmpHome();
  runGuard('echo "OPEN|MERGEABLE||verify=SUCCESS "', home);
  const out = runGuard('echo "OPEN|MERGEABLE||verify=FAILURE "', home);
  assert.match(out, /changed/);
  assert.match(out, /FAILURE/);
  assert.match(out, /was:.*SUCCESS/, "the message must say where we came from");
  // The new state is stored: we do not alert again on the next slot.
  assert.equal(runGuard('echo "OPEN|MERGEABLE||verify=FAILURE "', home), "");
});

test("guard: a failing gh → silence and exit 0, never stderr", () => {
  // A coughing network must not wake the agent every 5 minutes.
  const home = tmpHome();
  runGuard('echo "OPEN|MERGEABLE||verify=SUCCESS "', home);
  assert.equal(runGuard('echo "boom" >&2; exit 1', home), "");
});

test("guard: gh answering empty → silence (not \"everything vanished\")", () => {
  const home = tmpHome();
  runGuard('echo "OPEN|MERGEABLE||verify=SUCCESS "', home);
  assert.equal(runGuard("exit 0", home), "");
});

test("guard: with no argument → silence", () => {
  assert.equal(runGuard('echo "x"', tmpHome(), []), "");
});

test("guard: two PRs do not share their state", () => {
  const home = tmpHome();
  runGuard('echo "OPEN|MERGEABLE||a=SUCCESS "', home, ["7"]);
  // PR 8 has never been seen: a first observation, hence silence — and it must
  // not inherit PR 7's state.
  assert.equal(runGuard('echo "OPEN|MERGEABLE||a=FAILURE "', home, ["8"]), "");
  assert.equal(runGuard('echo "OPEN|MERGEABLE||a=FAILURE "', home, ["8"]), "");
});

// ── gh is not everywhere, and a guard that cannot run must not look calm ─────

/** First match for `tool` on a PATH, or null — a `which` that needs no shell. */
function resolveTool(tool: string, searchPath = process.env.PATH ?? "") {
  for (const dir of searchPath.split(path.delimiter)) {
    const p = path.join(dir, tool);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* not here */ }
  }
  return null;
}

/**
 * Runs the guard with NO `gh` on PATH and a fake `curl` instead, so the public
 * API fallback can be exercised without a network. `curl` is dispatched on the
 * URL it is handed, the way the real one would be.
 */
function runGuardNoGh(prJson: string, checksJson: string | null, home: string, args: string[] = ["7"]) {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "curl"),
    "#!/bin/sh\nfor a in \"$@\"; do case \"$a\" in\n" +
      `  *check-runs*) ${checksJson === null ? "exit 22" : `cat <<'J'\n${checksJson}\nJ`}\n    exit 0 ;;\n` +
      `  *pulls/*) cat <<'J'\n${prJson}\nJ\n    exit 0 ;;\n` +
      "esac; done\nexit 22\n",
    { mode: 0o755 },
  );
  // PATH must hold the fake curl and NOTHING that answers to `gh` — the guard
  // picks its backend with `command -v gh`. Keeping the system dirs on PATH is
  // what made this test pass locally and fail on CI: a GitHub runner ships gh
  // in /usr/bin, so the guard took the gh path and the fallback was never
  // exercised. Hence a sandbox: the fake curl plus symlinks to the few real
  // tools the guard needs, and nothing else.
  for (const tool of ["python3", "mkdir", "cat", "tr"]) {
    const real = resolveTool(tool);
    const link = path.join(bin, tool);
    // A test calls the guard twice with the same HOME: linking is idempotent.
    if (real && !fs.existsSync(link)) fs.symlinkSync(real, link);
  }
  assert.equal(resolveTool("gh", bin), null, "the sandbox must not expose a gh");
  // The interpreter is resolved BEFORE the PATH is narrowed: execvp looks the
  // command up in the CHILD's environment, so a sandboxed PATH hides `sh` too.
  return execFileSync(resolveTool("sh") ?? "/bin/sh", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: bin },
  });
}

const PR = (state: string, mergeable: string, mstate: string) =>
  `{"state":"${state}","mergeable":${mergeable},"mergeable_state":"${mstate}","head":{"sha":"abc123"}}`;
const CHECKS = (concl: string) => `{"check_runs":[{"name":"CI","status":"completed","conclusion":"${concl}"}]}`;

test("guard: without gh it falls back to the public API instead of going inert", () => {
  const home = tmpHome();
  // First sighting is silent, as on the gh path…
  assert.equal(runGuardNoGh(PR("open", "true", "clean"), CHECKS("success"), home), "");
  // …and a real change still gets reported. Silence here would mean the watch
  // never fires at all, which is worse than no watch: it looks like coverage.
  const out = runGuardNoGh(PR("open", "true", "clean"), CHECKS("failure"), home);
  assert.match(out, /changed/);
  assert.match(out, /failure/);
  assert.match(out, /was:.*success/);
});

test("guard: an unreachable API stays silent (transient, not news)", () => {
  const home = tmpHome();
  assert.equal(runGuardNoGh(PR("open", "true", "clean"), CHECKS("success"), home), "");
  // check-runs unreachable → the slot is skipped, not reported as a change
  assert.equal(runGuardNoGh(PR("open", "true", "clean"), null, home), "");
});

test("guard: a mergeable state still being computed is not a change", () => {
  const home = tmpHome();
  // GitHub answers null while it computes, so null -> true -> null would wake
  // the agent three times for one non-event.
  assert.equal(runGuardNoGh(PR("open", "null", "unknown"), CHECKS("success"), home), "");
  assert.equal(runGuardNoGh(PR("open", "true", "clean"), CHECKS("success"), home), "");
  assert.equal(runGuardNoGh(PR("open", "null", "unknown"), CHECKS("success"), home), "");
});

test("guard: gh's own UNKNOWN mergeable is skipped the same way", () => {
  const home = tmpHome();
  runGuard('echo "OPEN|MERGEABLE||verify=SUCCESS "', home);
  assert.equal(runGuard('echo "OPEN|UNKNOWN||verify=SUCCESS "', home), "", "UNKNOWN is a computing state, not news");
});

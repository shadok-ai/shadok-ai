import assert from "node:assert/strict";
import test from "node:test";
import { TmuxPilot, tmuxAvailable, tmuxHasSession, tmuxKillSession } from "../src/tmux.js";

/**
 * `stop()` must kill the pane even when the graceful path cannot work.
 *
 * The graceful exit goes through `submit("/exit")`, which needs an input box.
 * A wedged TUI has none — that is the whole reason a restart was asked for — so
 * the hard kill has to be unconditional. It was not: `stop()` began with
 * `if (this.exited) return`, and `exited` latches on a single failed
 * `has-session` probe (every tmux error is swallowed into `false`). A pilot that
 * wrongly believed itself dead returned without killing, and `start()` then
 * ADOPTED the surviving pane — so "Reload agent" silently reattached to the very
 * process it was meant to replace.
 *
 * The stand-in here is `sleep`: like a wedged TUI it has no input box, so
 * `submit` fails exactly the same way, without needing a real agent.
 */
const HAVE_TMUX = tmuxAvailable();
const NAME = "sk-test-stop-" + process.pid;

test("stop() kills a pane whose graceful exit cannot work", { skip: !HAVE_TMUX }, async () => {
  const pilot = new TmuxPilot({ tmuxName: NAME, cwd: process.cwd(), args: ["300"], claudePath: "sleep" });
  try {
    pilot.start();
    assert.equal(tmuxHasSession(NAME), true, "the pane should be up before we stop it");

    await pilot.stop();

    assert.equal(tmuxHasSession(NAME), false, "stop() must leave no pane behind");
    assert.equal(pilot.hasExited, true);
  } finally {
    tmuxKillSession(NAME); // never leak a pane if an assertion throws
  }
});

test("stop() is safe once the pane is already gone", { skip: !HAVE_TMUX }, async () => {
  // Killed first, so the graceful path is skipped entirely — this is the branch
  // that used to `return` early on the `exited` flag, and it must still be a
  // clean no-op rather than a throw. Cheap on purpose: the 12s of submit retries
  // are exercised once, by the test above, and are not worth paying twice.
  const pilot = new TmuxPilot({ tmuxName: NAME + "-b", cwd: process.cwd(), args: ["300"], claudePath: "sleep" });
  pilot.start();
  pilot.kill();
  await pilot.stop();
  assert.equal(tmuxHasSession(NAME + "-b"), false);
});

test("tmuxKillSession on a name that does not exist is a no-op", () => {
  // The server calls this defensively before respawning; it must never throw.
  assert.doesNotThrow(() => tmuxKillSession("sk-definitely-not-a-session-" + process.pid));
});

// A start whose TUI never comes up must not leave a watcher behind — see
// `TmuxPilot.abandon`. `sleep` stands in for the wedged screen again.
test("abandon() kills a pane this pilot created", { skip: !HAVE_TMUX }, () => {
  const pilot = new TmuxPilot({ tmuxName: NAME, cwd: process.cwd(), args: ["300"], claudePath: "sleep" });
  try {
    pilot.start();
    pilot.abandon();
    assert.equal(tmuxHasSession(NAME), false);
    assert.equal(pilot.hasExited, true);
  } finally {
    tmuxKillSession(NAME);
  }
});

test("abandon() stops watching an ADOPTED pane but leaves it running", { skip: !HAVE_TMUX }, () => {
  const owner = new TmuxPilot({ tmuxName: NAME, cwd: process.cwd(), args: ["300"], claudePath: "sleep" });
  const adopter = new TmuxPilot({ tmuxName: NAME, cwd: process.cwd(), args: ["300"], claudePath: "sleep" });
  try {
    owner.start();
    adopter.start();
    assert.equal(adopter.attached, true);
    adopter.abandon();
    assert.equal(tmuxHasSession(NAME), true, "an adopted pane may be a live agent — never killed on a timeout");
    assert.equal(adopter.hasExited, true, "but this pilot no longer polls it");
  } finally {
    owner.kill();
    tmuxKillSession(NAME);
  }
});

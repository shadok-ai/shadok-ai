import assert from "node:assert/strict";
import test from "node:test";
import { moveToOption, selectedOptionN, type DialogPilot } from "../src/detect.js";

/**
 * A pilot whose visible screen is a MIRROR that lags behind the real cursor —
 * exactly the tmux transport, where `screen()` is refreshed on a ~300ms poll and
 * a keystroke is not reflected until the next capture. `lag` reads must pass
 * before the mirror catches up to the real cursor.
 *
 * This is the shape that broke single-select forms in web mode: `moveToOption`
 * read a stale screen after each press, believed the cursor had not moved, and
 * pressed again — sailing past the target to the LAST option. The fix waits for
 * the move to actually land, so `presses` equals the number of steps, never more.
 */
class LagPilot implements DialogPilot {
  real: number;
  private mirror: number;
  private sinceMove = 999;
  presses = 0;
  constructor(
    readonly max: number,
    start = 1,
    readonly lag = 0,
  ) {
    this.real = start;
    this.mirror = start;
  }
  private render(n: number): string {
    let out = "Which one?\n\n";
    for (let i = 1; i <= this.max; i++) out += (i === n ? "❯ " : "  ") + i + ". Option " + i + "\n";
    return out;
  }
  screen(): string {
    this.sinceMove++;
    if (this.sinceMove >= this.lag) this.mirror = this.real; // the poll caught up
    return this.render(this.mirror);
  }
  press(key: "up" | "down"): void {
    this.presses++;
    this.real = key === "down" ? Math.min(this.max, this.real + 1) : Math.max(1, this.real - 1);
    this.sinceMove = 0; // the mirror now lags behind the real cursor
  }
  async waitFor(predicate: (s: string) => boolean, opts?: { timeoutMs?: number }): Promise<string> {
    const deadline = Date.now() + (opts?.timeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      const s = this.screen();
      if (predicate(s)) return s;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error("waitFor: timeout");
  }
}

test("selectedOptionN reads the ❯ cursor's option number", () => {
  assert.equal(selectedOptionN("  1. a\n❯ 2. b\n  3. c"), 2);
  assert.equal(selectedOptionN("  1. a\n  2. b"), null);
});

test("moveToOption lands on the target under a laggy mirror — no overshoot", async () => {
  // The tmux case: the mirror only catches up after several reads. The old
  // fixed-delay code overshot to the last option here; the fix must not.
  const p = new LagPilot(5, 1, 4);
  assert.equal(await moveToOption(p, 3), true);
  assert.equal(p.real, 3);
  assert.equal(p.presses, 2, "exactly two down-steps, never more");
});

test("moveToOption works with no lag (node-pty), moving down and up", async () => {
  const down = new LagPilot(5, 1, 0);
  assert.equal(await moveToOption(down, 4), true);
  assert.equal(down.presses, 3);

  const up = new LagPilot(5, 5, 0);
  assert.equal(await moveToOption(up, 2), true);
  assert.equal(up.real, 2);
  assert.equal(up.presses, 3);
});

test("moveToOption on the already-selected option presses nothing", async () => {
  const p = new LagPilot(5, 1, 4);
  assert.equal(await moveToOption(p, 1), true);
  assert.equal(p.presses, 0);
});

test("moveToOption returns false when the cursor can't be read", async () => {
  const noCursor: DialogPilot = {
    screen: () => "  1. a\n  2. b", // no ❯
    press: () => {},
    waitFor: async () => "",
  };
  assert.equal(await moveToOption(noCursor, 2), false);
});

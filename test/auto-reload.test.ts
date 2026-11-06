import { test } from "node:test";
import assert from "node:assert/strict";
import { autoReloadVerdict, autoReloadEnabled, type AutoReloadInput } from "../src/auto-reload.js";

const READY: AutoReloadInput = {
  enabled: true,
  pendingReasons: 1,
  busy: false,
  working: false,
  submitting: false,
  restarting: false,
  exited: false,
  dialogOpen: false,
  inputBox: "",
  shells: 0,
  monitors: 0,
  inboxPending: 0,
  retryPending: false,
  idleMs: 10 * 60_000,
  quietMs: 2 * 60_000,
  sinceLastAutoMs: Infinity,
  backoffMs: 30 * 60_000,
};

test("an idle, quiet, stale agent is reloaded", () => {
  assert.deepEqual(autoReloadVerdict(READY), { reload: true });
});

test("every in-process loss blocks the reload", () => {
  const cases: [Partial<AutoReloadInput>, string][] = [
    [{ enabled: false }, "disabled"],
    [{ pendingReasons: 0 }, "up to date"],
    [{ exited: true }, "process exited"],
    [{ restarting: true }, "already restarting"],
    [{ busy: true }, "working"],
    [{ working: true }, "working"],
    [{ submitting: true }, "a prompt is being typed"],
    [{ dialogOpen: true }, "waiting on a question"],
    [{ inputBox: "half a sentence" }, "text in the input box"],
    [{ shells: 1 }, "background task running"],
    [{ monitors: 1 }, "background task running"],
    [{ inboxPending: 2 }, "notifications queued"],
    [{ retryPending: true }, "auto-retry scheduled"],
    [{ idleMs: 30_000 }, "recently active"],
    [{ sinceLastAutoMs: 5 * 60_000 }, "auto-reloaded recently"],
  ];
  for (const [patch, why] of cases) {
    assert.deepEqual(autoReloadVerdict({ ...READY, ...patch }), { reload: false, why }, JSON.stringify(patch));
  }
});

test("a blank input box is not text to lose", () => {
  assert.deepEqual(autoReloadVerdict({ ...READY, inputBox: "   " }), { reload: true });
});

test("the env switch is on unless explicitly turned off", () => {
  assert.equal(autoReloadEnabled(undefined), true);
  assert.equal(autoReloadEnabled("1"), true);
  for (const off of ["0", "false", "OFF", " no "]) assert.equal(autoReloadEnabled(off), false, off);
});

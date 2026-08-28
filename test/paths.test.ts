import assert from "node:assert/strict";
import test from "node:test";
import { instanceKey } from "../src/paths.js";

test("instanceKey: every non-alphanumeric character becomes a dash", () => {
  assert.equal(instanceKey("/Users/a/projects/shadok-ai"), "-Users-a-projects-shadok-ai");
});

test("instanceKey: the same encoding the existing stores already use", () => {
  // channels.ts, crons.ts and lock.ts each inline this expression. A new file
  // landing next to theirs must key on the SAME string, or an instance would
  // read its channels from one name and its accounts from another.
  const cwd = "/tmp/x.y_z-1";
  assert.equal(instanceKey(cwd), cwd.replace(/[^a-zA-Z0-9]/g, "-"));
});

test("instanceKey: defaults to the process's own directory", () => {
  assert.equal(instanceKey(), process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
});

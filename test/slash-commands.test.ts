import assert from "node:assert/strict";
import test from "node:test";
import { listCommands } from "../src/slash-commands.js";

test("listCommands: only the attached factory skills, as <name>:<name>", () => {
  const out = listCommands([
    { name: "slack-digest", description: "Daily digest" },
    { name: "ab-test", description: "" },
  ]);
  assert.deepEqual(out.map((c) => c.name), ["ab-test:ab-test", "slack-digest:slack-digest"]);
  assert.equal(out[1].description, "Daily digest");
  assert.deepEqual(listCommands([]), []);
});

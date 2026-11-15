import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, parseParentArg } from "../context/agents-skill/pilotctl.mjs";

test("parseParentArg: none/null/empty mean DETACH, anything else is the parent id", () => {
  assert.equal(parseParentArg("none"), null);
  assert.equal(parseParentArg("null"), null);
  assert.equal(parseParentArg(""), null);
  assert.equal(parseParentArg(undefined), null);
  assert.equal(parseParentArg("abc123"), "abc123");
});

test("parseArgs routes `set-parent <id> <target>` as positionals", () => {
  const { cmd, pos } = parseArgs(["set-parent", "child-id", "none"]);
  assert.equal(cmd, "set-parent");
  assert.deepEqual(pos, ["child-id", "none"]);
});

test("set-parent takes --cwd as a value flag, not a positional", () => {
  const { flags, pos } = parseArgs(["set-parent", "child-id", "parent-id", "--cwd", "/x"]);
  assert.equal(flags.cwd, "/x");
  assert.deepEqual(pos, ["child-id", "parent-id"]);
});

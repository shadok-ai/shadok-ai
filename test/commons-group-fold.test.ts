import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The server's commons group (src/groups.ts MAIN_GROUP_ID === "main") is the SAME
// shared, no-wall home the client has always rendered as the "Main" view — the
// ungrouped (📥) rail entry. Multi-tenant made it an explicit server group row so
// agents can be FILED into it (a channel then carries group === "main"). Rendered
// as its OWN rail group it becomes a SECOND "Main" beside that view — the exact
// bug a user hit on the mt373 test instance: the Groups rail showed "Main" (📥)
// AND "main" (🛠, general inside it). The client must FOLD the commons group into
// the ungrouped view instead of creating a rail group for it.
//
// index.html has no build step, so — like test/ws-url.test.ts and
// test/tab-focus.test.ts — the invariant is locked by scanning the source.
const HTML = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"),
  "utf8",
);

test("the commons group id and fold helper are defined", () => {
  assert.match(HTML, /const COMMONS_GROUP_ID = "main"/, "the commons group id must be defined");
  assert.match(
    HTML,
    /const foldCommons = \(id\) => \(id != null && String\(id\) === COMMONS_GROUP_ID \? null : id\)/,
    "foldCommons must map the commons group id to null (the ungrouped 'Main' view)",
  );
});

test("the boot restore never turns the commons group into a rail group", () => {
  assert.match(
    HTML,
    /for \(const g of savedGroups\) if \(String\(g\.id\) !== COMMONS_GROUP_ID\) createGroup\(g\)/,
    "boot must skip the commons group when creating rail groups",
  );
});

test("syncChannels never turns the commons group into a rail group", () => {
  assert.match(
    HTML,
    /if \(String\(sg\.id\) === COMMONS_GROUP_ID\) continue;/,
    "the 4s sync must skip the commons group",
  );
});

test("channels in the commons are filed into the ungrouped view", () => {
  // Both the boot restore and the sync/discover paths fold a commons channel's
  // group to null, so it lands in the ungrouped "Main" view rather than a second
  // "main" group that no longer exists.
  assert.match(HTML, /createTab\(foldCommons\(s\.group\)\)/, "boot restore folds the commons group");
  assert.match(HTML, /createTab\(foldCommons\(c\.group\), \{ focus: !active \}\)/, "discover folds the commons group");
  assert.match(HTML, /const cg = foldCommons\(c\.group\);/, "the reconcile path folds the commons group");
});

test("the single 'Main' rail entry (the ungrouped view) still exists", () => {
  // Folding must not REMOVE the commons view — it must be the ONE place the
  // commons is shown. The synthetic ungrouped entry named "Main" is that place.
  assert.match(
    HTML,
    /\{ view: "ungrouped", icon: "📥", name: "Main" \}/,
    "the rail must keep exactly its one ungrouped 'Main' entry",
  );
});

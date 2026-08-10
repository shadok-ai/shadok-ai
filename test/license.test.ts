import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

test("package.json declares AGPL-3.0-only", () => {
  // A public repo with no license is "all rights reserved": nobody may legally
  // use it. And this SPDX id is what GitHub's sidebar and npm read, so a typo
  // here silently un-licenses the project.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  assert.equal(pkg.license, "AGPL-3.0-only");
});

test("LICENSE holds the full AGPL-3.0 text", () => {
  const text = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
  assert.match(text, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(text, /Version 3, 19 November 2007/);
  // The network-use clause is the whole reason AGPL was picked over Apache:
  // without it the file is simply a different license.
  assert.match(text, /remote network interaction/i);
});

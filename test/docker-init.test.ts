import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = fs.readFileSync(path.join(HERE, "..", "Dockerfile"), "utf8");
const README = fs.readFileSync(path.join(HERE, "..", "README.md"), "utf8");

/**
 * pid 1 must reap (invariant 44).
 *
 * A scan test, like `test/ws-url.test.ts`: there is no code path to exercise —
 * the whole fix is one `ENTRYPOINT` line, and the thing it prevents cannot be
 * observed from inside the application. An orphaned process is re-parented to
 * pid 1, Node waits only for its own children, so with the supervisor as pid 1
 * every orphan an agent leaves becomes a zombie for the life of the container.
 * A zombie costs no memory, no CPU and no log line — only a pid slot — so the
 * first symptom is the container being unable to fork anything at all. Measured
 * before the fix: 79,055 zombies of a 113,098 pid budget.
 *
 * Which is exactly why it needs a test rather than a comment: a refactor of the
 * image (a new base, a reordering, a "simplification" of the entrypoint) can
 * drop it with nothing turning red anywhere else, and the regression stays
 * invisible for weeks.
 */
test("the image enters through tini, so pid 1 is a reaper", () => {
  assert.match(
    DOCKERFILE,
    /^ENTRYPOINT \["\/usr\/bin\/tini", "--", "docker-entrypoint\.sh"\]$/m,
    "Dockerfile must enter through tini and still run docker-entrypoint.sh",
  );
});

test("tini is installed in the image", () => {
  const apt = DOCKERFILE.match(/apt-get install -y --no-install-recommends \\\n\s+([^\\]+)/);
  assert.ok(apt, "could not find the apt install line");
  assert.match(apt[1], /\btini\b/, "tini must be in the package list the entrypoint needs");
});

test("the entrypoint keeps the base image's own entrypoint in the chain", () => {
  // node:22-slim's `docker-entrypoint.sh` is what makes a bare command work the
  // documented way; replacing it outright would be a silent behaviour change.
  const entry = DOCKERFILE.match(/^ENTRYPOINT .*$/m)![0];
  assert.ok(entry.includes("docker-entrypoint.sh"), entry);
  assert.match(DOCKERFILE, /^CMD \["shadok-ai", "--no-telegram"\]$/m);
});

test("the README tells an existing deployment how to get a reaper", () => {
  // An operator reading only the README must find the two things that are not
  // deducible: `--init` for an image without tini, and that it is fixed at
  // CREATION — a restart empties the table and the leak starts over.
  assert.match(README, /--init/, "README must name `docker run --init`");
  assert.match(README, /docker restart/, "README must say a restart is not the fix");
});

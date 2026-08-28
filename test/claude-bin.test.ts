import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveBin,
  ensureClaude,
  classifyBin,
  sampleBin,
  platformPkg,
  nativeBinCandidates,
  findClaudeBin,
  findClaudeBinWithRetry,
  type BinSample,
  type ClaudeBin,
  type FindClaudeDeps,
} from "../src/claude-bin.js";

test("resolveBin: trouve un exécutable sur le PATH mocké", () => {
  const exists = (p: string) => p === "/b/claude";
  assert.equal(resolveBin("claude", { PATH: "/a:/b" } as never, exists), "/b/claude");
});

test("resolveBin: absent du PATH → null", () => {
  assert.equal(resolveBin("claude", { PATH: "/a:/b" } as never, () => false), null);
});

test("resolveBin: un chemin explicite est vérifié tel quel", () => {
  assert.equal(
    resolveBin("/usr/local/bin/claude", { PATH: "" } as never, (p) => p === "/usr/local/bin/claude"),
    "/usr/local/bin/claude",
  );
  assert.equal(resolveBin("/nope/claude", { PATH: "" } as never, () => false), null);
});

// The real placeholder, byte-for-byte from the 2.1.250 tarball's bin/claude.exe
// (500 bytes). Note what it does NOT have: a shebang. Guessing at `#!` would
// have missed it entirely, and glibc's exec falls back to /bin/sh, which is why
// a spawn of this file "succeeds" and then exits 1 on stderr.
const STUB = `echo "Error: claude native binary not installed." >&2
echo "" >&2
echo "Either postinstall did not run (--ignore-scripts, some pnpm configs)" >&2
echo "or the platform-native optional dependency was not downloaded" >&2
echo "(--omit=optional)." >&2
echo "" >&2
echo "Run the postinstall manually (adjust path for local vs global install):" >&2
echo "  node node_modules/@anthropic-ai/claude-code/install.cjs" >&2
echo "" >&2
echo "Or reinstall without --ignore-scripts / --omit=optional." >&2
exit 1
`;

const stubSample: BinSample = { size: STUB.length, head: STUB };
const nativeSample: BinSample = { size: 223_604_056, head: "" };

test("classifyBin: the npm placeholder is recognised, a real binary is not", () => {
  assert.equal(classifyBin(stubSample), "stub");
  assert.equal(classifyBin(nativeSample), "usable");
  assert.equal(classifyBin(null), "missing");
});

test("classifyBin: a legitimate small shim stays usable", () => {
  // pnpm/volta/asdf ship tiny shell shims, and npm ships a .cmd shim on
  // Windows. Condemning "not an ELF" would break all of them — only the
  // placeholder's own wording condemns.
  const pnpmShim = '#!/bin/sh\nexec node "$basedir/../@anthropic-ai/claude-code/bin/claude.exe" "$@"\n';
  assert.equal(classifyBin({ size: pnpmShim.length, head: pnpmShim }), "usable");
  // A 500-byte script that merely mentions claude is not the placeholder.
  assert.equal(classifyBin({ size: 120, head: 'echo "starting claude" >&2\nexec claude "$@"\n' }), "usable");
});

test("classifyBin: the placeholder's wording in a huge file is not the placeholder", () => {
  // The marker alone is not enough: claude's own binary contains plenty of
  // strings. Size is what makes the match safe.
  assert.equal(classifyBin({ size: 223_604_056, head: STUB }), "usable");
});

test("sampleBin: reads a REAL placeholder off disk and classifies it (regression)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bin-"));
  try {
    const stub = path.join(dir, "claude");
    fs.writeFileSync(stub, STUB, { mode: 0o755 });
    const s = sampleBin(stub);
    assert.ok(s);
    assert.equal(s.size, 500, "the shipped placeholder is 500 bytes");
    assert.equal(classifyBin(s), "stub");
    // And it IS executable, which is precisely why resolveBin hands it back.
    assert.equal(resolveBin("claude", { PATH: dir } as never), stub);
    assert.equal(sampleBin(path.join(dir, "nope")), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("platformPkg: mirrors the package's own PLATFORMS map", () => {
  assert.deepEqual(platformPkg("linux", "x64"), {
    pkg: "@anthropic-ai/claude-code-linux-x64",
    bin: "claude",
  });
  assert.deepEqual(platformPkg("linux", "arm64", true), {
    pkg: "@anthropic-ai/claude-code-linux-arm64-musl",
    bin: "claude",
  });
  assert.deepEqual(platformPkg("darwin", "arm64"), {
    pkg: "@anthropic-ai/claude-code-darwin-arm64",
    bin: "claude",
  });
  assert.deepEqual(platformPkg("win32", "x64"), {
    pkg: "@anthropic-ai/claude-code-win32-x64",
    bin: "claude.exe",
  });
  // An unpublished platform has no fallback, and saying so beats inventing one.
  assert.equal(platformPkg("freebsd", "x64"), null);
  assert.equal(platformPkg("linux", "riscv64"), null);
});

test("nativeBinCandidates: covers the nested AND the hoisted layout", () => {
  const launcher = "/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe";
  const c = nativeBinCandidates(launcher, "@anthropic-ai/claude-code-linux-x64", "claude");
  // Nested — what a global npm install produced here.
  assert.ok(
    c.includes(
      "/usr/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude",
    ),
    "nested layout missing",
  );
  // Hoisted — the layout that made node-pty-fix's chmod silently miss.
  assert.ok(
    c.includes("/usr/lib/node_modules/@anthropic-ai/claude-code-linux-x64/claude"),
    "hoisted layout missing",
  );
  assert.ok(c.length > 2 && c.at(-1)!.startsWith("/node_modules/"), "the walk must reach the root");
});

function deps(over: Partial<FindClaudeDeps> = {}): FindClaudeDeps {
  return {
    resolve: () => "/usr/bin/claude",
    realpath: (p) => p,
    sample: () => nativeSample,
    platform: "linux",
    arch: "x64",
    musl: false,
    ...over,
  };
}

const NESTED =
  "/usr/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude";
const HOISTED = "/usr/lib/node_modules/@anthropic-ai/claude-code-linux-x64/claude";
const LAUNCHER = "/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe";

test("findClaudeBin: a real launcher is used as-is", () => {
  assert.deepEqual(findClaudeBin(deps()), { ok: true, path: "/usr/bin/claude", via: "launcher" });
});

test("findClaudeBin: nothing on PATH → missing", () => {
  assert.deepEqual(findClaudeBin(deps({ resolve: () => null })), { ok: false, reason: "missing" });
});

test("findClaudeBin: launcher is the placeholder → falls back to the nested native binary", () => {
  const r = findClaudeBin(
    deps({
      realpath: () => LAUNCHER,
      sample: (p) => (p === NESTED ? nativeSample : stubSample),
    }),
  );
  assert.deepEqual(r, { ok: true, path: NESTED, via: "native" });
});

test("findClaudeBin: placeholder + HOISTED native binary is found too", () => {
  const r = findClaudeBin(
    deps({
      realpath: () => LAUNCHER,
      sample: (p) => (p === HOISTED ? nativeSample : stubSample),
    }),
  );
  assert.deepEqual(r, { ok: true, path: HOISTED, via: "native" });
});

test("findClaudeBin: placeholder and no native package anywhere → stub, not missing", () => {
  const r = findClaudeBin(deps({ realpath: () => LAUNCHER, sample: (p) => (p === LAUNCHER ? stubSample : null) }));
  assert.deepEqual(r, { ok: false, reason: "stub" });
});

test("findClaudeBin: a realpath that throws does not lose the fallback", () => {
  const r = findClaudeBin(
    deps({
      resolve: () => LAUNCHER,
      realpath: () => { throw new Error("ELOOP"); },
      sample: (p) => (p === NESTED ? nativeSample : stubSample),
    }),
  );
  assert.deepEqual(r, { ok: true, path: NESTED, via: "native" });
});

test("findClaudeBin: an unsupported platform reports the stub rather than inventing a path", () => {
  const r = findClaudeBin(deps({ platform: "freebsd", sample: () => stubSample }));
  assert.deepEqual(r, { ok: false, reason: "stub" });
});

test("findClaudeBinWithRetry: rides out the transient rewrite window", async () => {
  // The measured failure: the postinstall unlinks bin/claude.exe before
  // relinking, so a look during that window finds nothing at all.
  let look = 0;
  const slept: number[] = [];
  const r = await findClaudeBinWithRetry(
    deps({ resolve: () => (++look < 3 ? null : "/usr/bin/claude") }),
    { tries: 6, delayMs: 250, sleep: async (ms) => { slept.push(ms); } },
  );
  assert.deepEqual(r, { ok: true, path: "/usr/bin/claude", via: "launcher" });
  assert.equal(look, 3);
  assert.deepEqual(slept, [250, 250]);
});

test("findClaudeBinWithRetry: bounded — it gives up, it does not hang", async () => {
  let look = 0;
  const r = await findClaudeBinWithRetry(
    deps({ resolve: () => { look++; return null; } }),
    { tries: 4, delayMs: 1, sleep: async () => {} },
  );
  assert.deepEqual(r, { ok: false, reason: "missing" });
  assert.equal(look, 4, "exactly `tries` looks, no more");
});

const found = (p: string): ClaudeBin => ({ ok: true, path: p, via: "launcher" });

test("ensureClaude: already there → no install", async () => {
  let installed = false;
  const r = await ensureClaude({
    find: async () => found("/bin/claude"),
    install: async () => { installed = true; },
    notify: () => {},
  });
  assert.deepEqual(r, { ok: true, path: "/bin/claude" });
  assert.equal(installed, false);
});

test("ensureClaude: missing → install → found → ok", async () => {
  let calls = 0;
  const r = await ensureClaude({
    find: async () => (calls++ === 0 ? { ok: false, reason: "missing" } : found("/g/bin/claude")),
    install: async () => {},
    notify: () => {},
  });
  assert.deepEqual(r, { ok: true, path: "/g/bin/claude" });
});

test("ensureClaude: missing → install → still absent → clear error", async () => {
  const r = await ensureClaude({
    find: async () => ({ ok: false, reason: "missing" }),
    install: async () => {},
    notify: () => {},
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /npm i -g @anthropic-ai\/claude-code/);
});

test("ensureClaude: the install fails → clear error (manual fallback)", async () => {
  const r = await ensureClaude({
    find: async () => ({ ok: false, reason: "missing" }),
    install: async () => { throw new Error("EACCES"); },
    notify: () => {},
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /EACCES/);
    assert.match(r.error, /npm i -g @anthropic-ai\/claude-code/);
  }
});

test("ensureClaude: the placeholder is NOT handed back as usable, and does not trigger an install", async () => {
  // The regression this whole module exists for: bin/claude.exe is mode 0755,
  // so resolveBin returned it and ensureClaude reported {ok:true}. Every spawn
  // in that window then died on the placeholder's opaque exit 1.
  let installed = false;
  const r = await ensureClaude({
    find: async () => ({ ok: false, reason: "stub" }),
    install: async () => { installed = true; },
    notify: () => {},
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /placeholder/);
    assert.match(r.error, /install\.cjs/);
  }
  // A placeholder means the package IS installed — reinstalling is neither the
  // missing-CLI case nor a safe move while someone else's postinstall runs.
  assert.equal(installed, false, "a placeholder must not trigger npm i -g");
});

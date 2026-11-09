import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FFMPEG_SHA256, MODEL_SHA256, MODEL_REV, MODEL_URL, MODELS, WHISPER_SRC_SHA256,
  ffmpegAsset, modelSha256, markerValid, downloadVerified, verifyCached, sha256File,
} from "../src/whisper.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "whisper-integrity-"));
}

/** A fetch that serves one body, whatever the URL. */
function fakeFetch(body: Buffer, status = 200): typeof fetch {
  return (async () => new Response(new Uint8Array(body), { status })) as unknown as typeof fetch;
}

test("every artifact that is downloaded carries a pinned SHA-256", () => {
  for (const arch of ["x64", "arm64"]) {
    const url = ffmpegAsset("linux", arch)!;
    assert.match(FFMPEG_SHA256[path.basename(url)] ?? "", HEX64, `ffmpeg ${arch}`);
  }
  for (const name of Object.keys(MODELS)) assert.match(MODEL_SHA256[name] ?? "", HEX64, name);
  assert.match(WHISPER_SRC_SHA256, HEX64);
});

test("the model URL is pinned to an exact repository commit, never a branch", () => {
  // `/resolve/main/` is a moving ref: the same URL can serve different bytes
  // tomorrow. A commit sha cannot.
  assert.match(MODEL_REV, /^[0-9a-f]{40}$/);
  assert.ok(MODEL_URL.includes(`/resolve/${MODEL_REV}/`), MODEL_URL);
  assert.doesNotMatch(MODEL_URL, /\/resolve\/main\//);
});

test("a model we hold no hash for is refused unless the operator supplies one", () => {
  assert.equal(modelSha256("ggml-small-q5_1.bin", undefined), MODEL_SHA256["ggml-small-q5_1.bin"]);
  // Unknown model, no hash given: null = refuse to download it.
  assert.equal(modelSha256("ggml-large-v3.bin", undefined), null);
  assert.equal(modelSha256("ggml-large-v3.bin", ""), null);
  // A malformed hash is not a hash.
  assert.equal(modelSha256("ggml-large-v3.bin", "nope"), null);
  const h = "A".repeat(64);
  assert.equal(modelSha256("ggml-large-v3.bin", h), h.toLowerCase());
  // An explicit operator hash wins even over a known one: it is their file.
  assert.equal(modelSha256("ggml-small-q5_1.bin", "b".repeat(64)), "b".repeat(64));
});

test("a verification marker is trusted only while the file is unchanged", () => {
  const st = { size: 10, mtimeMs: 1000 };
  const m = { sha256: "a".repeat(64), size: 10, mtimeMs: 1000 };
  assert.ok(markerValid(m, st, "a".repeat(64)));
  assert.ok(!markerValid(m, { ...st, size: 11 }, "a".repeat(64)), "size changed");
  assert.ok(!markerValid(m, { ...st, mtimeMs: 1001 }, "a".repeat(64)), "mtime changed");
  assert.ok(!markerValid(m, st, "b".repeat(64)), "a different pin");
  assert.ok(!markerValid(null, st, "a".repeat(64)));
  assert.ok(!markerValid({ nonsense: true }, st, "a".repeat(64)));
});

test("a download whose hash matches lands in place, with its marker", async () => {
  const dir = tmpDir();
  try {
    const body = Buffer.from("the real binary");
    const dest = path.join(dir, "ffmpeg");
    await downloadVerified("https://x/ffmpeg", dest, { sha256: sha(body), mode: 0o755, fetchImpl: fakeFetch(body) });
    assert.equal(fs.readFileSync(dest, "utf8"), "the real binary");
    assert.equal(fs.statSync(dest).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["ffmpeg", "ffmpeg.sha256-ok"]);
    // And the cached copy is then accepted without rehashing.
    assert.equal(await verifyCached(dest, sha(body)), "ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a download whose hash does NOT match is refused and never renamed into place", async () => {
  const dir = tmpDir();
  try {
    const dest = path.join(dir, "ffmpeg");
    await assert.rejects(
      downloadVerified("https://x/ffmpeg", dest, { sha256: sha("expected"), fetchImpl: fakeFetch(Buffer.from("tampered")) }),
      /SHA-256 mismatch/,
    );
    // Neither the file nor the temp part survives.
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an HTTP error is refused before anything is written", async () => {
  const dir = tmpDir();
  try {
    const dest = path.join(dir, "m.bin");
    await assert.rejects(
      downloadVerified("https://x/m.bin", dest, { sha256: sha("x"), fetchImpl: fakeFetch(Buffer.from("x"), 404) }),
      /HTTP 404/,
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a cached file is verified once, and re-verified when it changes", async () => {
  // SHADOK_WHISPER_DIR may be shared between containers: a file already there
  // was written by someone else, so it must be hashed before it is trusted.
  const dir = tmpDir();
  try {
    const f = path.join(dir, "model.bin");
    fs.writeFileSync(f, "good bytes");
    const pin = sha("good bytes");
    assert.equal(await verifyCached(f, pin), "ok");
    assert.ok(fs.existsSync(`${f}.sha256-ok`), "a marker spares the next voice note a rehash");
    // Same size, different content, different mtime: the marker is void.
    fs.writeFileSync(f, "evil bytes");
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    assert.equal(await verifyCached(f, pin), "mismatch");
    assert.equal(await verifyCached(path.join(dir, "absent"), pin), "missing");
    assert.equal(await sha256File(f), sha("evil bytes"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

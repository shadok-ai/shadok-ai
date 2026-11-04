import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mediaDir } from "../src/telegram.js";

// The bug this locks (invariant 54's family): on a multi-tenant server the
// default `~/.shadok-ai/media` is `/root/.shadok-ai/media`, which a
// privilege-dropped agent cannot traverse. The server relocates it via
// `SHADOK_MEDIA_DIR`; `mediaDir()` must honour that at RUNTIME (a const captured
// at import would miss the boot-time relocation), and fall back to the home dir
// unchanged when it is unset (mono-tenant).

function withEnv(val: string | undefined, fn: () => void): void {
  const prev = process.env.SHADOK_MEDIA_DIR;
  if (val === undefined) delete process.env.SHADOK_MEDIA_DIR;
  else process.env.SHADOK_MEDIA_DIR = val;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.SHADOK_MEDIA_DIR;
    else process.env.SHADOK_MEDIA_DIR = prev;
  }
}

test("mediaDir: unset → the home ~/.shadok-ai/media (mono-tenant, unchanged)", () => {
  withEnv(undefined, () => {
    assert.equal(mediaDir(), path.join(os.homedir(), ".shadok-ai", "media"));
  });
});

test("mediaDir: SHADOK_MEDIA_DIR wins (the multi-tenant relocation)", () => {
  withEnv("/var/lib/shadok-ai/shared/media", () => {
    assert.equal(mediaDir(), "/var/lib/shadok-ai/shared/media");
  });
});

test("mediaDir: a blank/whitespace env value falls back to the default", () => {
  withEnv("   ", () => {
    assert.equal(mediaDir(), path.join(os.homedir(), ".shadok-ai", "media"));
  });
});

test("mediaDir: resolves at CALL time, so a later env change is seen", () => {
  withEnv(undefined, () => {
    const before = mediaDir();
    process.env.SHADOK_MEDIA_DIR = "/srv/media";
    try {
      assert.notEqual(mediaDir(), before);
      assert.equal(mediaDir(), "/srv/media");
    } finally {
      delete process.env.SHADOK_MEDIA_DIR;
    }
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  ffmpegAsset, missingParts, installNotice, installFailure, parseWhisperText,
  transcriptionOutcome, heardNotice, modelLooksComplete, whisperPaths,
  MODEL_BYTES, MODEL_FILE, MODELS, FFMPEG_TAG, WHISPER_TAG,
} from "../src/whisper.js";

test("an unknown platform or architecture is REFUSED, never guessed", () => {
  // Guessing would download an x86-64 binary onto an arm box and fail at
  // execve with something opaque — the shape invariant 32 spends four rules
  // avoiding. "Not supported here" is a better answer than a broken binary.
  assert.ok(ffmpegAsset("linux", "x64")?.includes("ffmpeg-linux-x64"));
  assert.ok(ffmpegAsset("linux", "arm64")?.includes("ffmpeg-linux-arm64"));
  assert.equal(ffmpegAsset("linux", "riscv64"), null);
  assert.equal(ffmpegAsset("darwin", "arm64"), null);
  assert.equal(ffmpegAsset("win32", "x64"), null);
});

test("every download is pinned to an exact version, never a moving tag", () => {
  // The rule the updater already follows for npm: a tag resolves differently
  // tomorrow, and a build that changes under you is not reproducible.
  const url = ffmpegAsset("linux", "x64")!;
  assert.ok(url.includes(`/download/${FFMPEG_TAG}/`), url);
  assert.doesNotMatch(url, /\/latest\//);
  assert.match(WHISPER_TAG, /^v\d+\.\d+\.\d+$/);
});

test("missing parts come back in install order", () => {
  const all = { cmake: false, ffmpeg: false, whisper: false, model: false };
  assert.deepEqual(missingParts(all), ["cmake", "ffmpeg", "whisper", "model"]);
  // cmake first is not cosmetic: whisper.cpp's Makefile is a cmake shim since
  // v1.9, so building before cmake exists fails in a confusing place.
  assert.deepEqual(missingParts({ ...all, cmake: true }), ["ffmpeg", "whisper", "model"]);
  assert.deepEqual(missingParts({ cmake: true, ffmpeg: true, whisper: true, model: true }), []);
});

test("the first-use notice appears only when something is missing", () => {
  // Without it the user sends a voice note and gets minutes of silence while
  // ~600 MB arrives and a compiler runs, which looks exactly like a dead bot.
  assert.equal(installNotice([]), null);
  // The size is COMPUTED from the chosen model, not written into the sentence:
  // the default moved from medium (514 MB) to small (181 MB) on a measurement,
  // and a hardcoded "600 Mo" would have quietly started lying that day.
  assert.match(installNotice(["model"])!, /~\d+ Mo/);
  // A small repair (just cmake) must not announce a download at all.
  assert.doesNotMatch(installNotice(["cmake"])!, /Mo/);
});

test("a failure says why, and says it stops trying", () => {
  // Retrying on every message would turn each voice note into a failed 514 MB
  // download. The user has to learn both facts at once: what broke, and that
  // the rest of the bot still works.
  const m = installFailure("pas de réseau");
  assert.match(m, /pas de réseau/);
  assert.match(m, /désactivée/);
  assert.match(m, /autres messages/);
});

test("parseWhisperText strips timestamps a build may emit despite -nt", () => {
  const raw = [
    "[00:00:00.000 --> 00:00:03.400]   ajoute un test",
    "[00:00:03.400 --> 00:00:05.000]   pour le cas vide",
    "",
  ].join("\n");
  assert.equal(parseWhisperText(raw), "ajoute un test pour le cas vide");
  assert.equal(parseWhisperText("  plain text \n"), "plain text");
  assert.equal(parseWhisperText(""), "");
  // A bracketed-only line is whisper's own noise ([BLANK_AUDIO], [MUSIC]).
  assert.equal(parseWhisperText("[BLANK_AUDIO]"), "");
});

test("an empty transcription is REPORTED, never sent on as an empty prompt", () => {
  // Otherwise a voice note that produced nothing is indistinguishable from the
  // silent drop this whole feature exists to remove.
  const bad = transcriptionOutcome("[BLANK_AUDIO]");
  assert.equal(bad.ok, false);
  assert.match((bad as any).notice, /rien compris/);
  const good = transcriptionOutcome("[00:00:00.000 --> 00:00:01.000]   bonjour");
  assert.equal(good.ok, true);
  assert.equal((good as any).text, "bonjour");
});

test("what was understood is echoed back before it is acted on", () => {
  // Load-bearing, not a courtesy: a misheard instruction acted on in silence is
  // worse than a voice message that was ignored. The user sees what the agent
  // received while there is still time to correct it.
  assert.match(heardNotice("ajoute un test"), /ajoute un test/);
  assert.match(heardNotice("x"), /🎙/);
});

test("a truncated download or an error page is not mistaken for the model", () => {
  assert.ok(modelLooksComplete(MODEL_BYTES));
  assert.ok(!modelLooksComplete(4096), "an HTML error page must not pass");
  assert.ok(!modelLooksComplete(0));
  assert.ok(!modelLooksComplete(MODEL_BYTES * 2));
});

test("the shared directory is configurable, and every artefact sits under it", () => {
  // shadok cannot create a share between containers; it can only put the path
  // behind SHADOK_WHISPER_DIR and write there. The mount is an operator gesture.
  const p = whisperPaths("/shared/whisper");
  assert.ok(p.ffmpeg.startsWith("/shared/whisper/"));
  assert.ok(p.model.endsWith(MODEL_FILE));
  assert.ok(p.binCandidates.every((c) => c.startsWith("/shared/whisper/")));
  // Both binary names are looked for: newer whisper.cpp ships `whisper-cli`,
  // older builds shipped `main`, and a shared directory may hold either.
  assert.ok(p.binCandidates.some((c) => c.endsWith("whisper-cli")));
  assert.ok(p.binCandidates.some((c) => c.endsWith("/main")));
});

test("the model is a choice, and the default is the measured one", () => {
  // small-q5_1 by measurement, not preference: same clip, same machine, 15.2s
  // against medium-q5_0's 49.6s for IDENTICAL output. Voice notes are short
  // spoken instructions and a 30-second one would take two minutes on medium.
  assert.equal(MODEL_FILE, "ggml-small-q5_1.bin");
  assert.ok(MODELS[MODEL_FILE] > 0, "the default must have a measured size");
  assert.ok(MODELS["ggml-medium-q5_0.bin"] > MODELS["ggml-small-q5_1.bin"]);
});

test("a model we have no size for is accepted, not refused", () => {
  // Someone pointing SHADOK_WHISPER_MODEL at another file should get that file,
  // not a refusal because we happen to hold no number for it. The floor still
  // catches an HTML error page.
  assert.ok(modelLooksComplete(MODEL_BYTES));
  assert.ok(!modelLooksComplete(4096));
});

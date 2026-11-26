import assert from "node:assert/strict";
import test from "node:test";
import {
  ffmpegAsset, missingParts, installNotice, installFailure, parseWhisperText,
  transcriptionOutcome, heardNotice, modelLooksComplete, whisperPaths,
  audioClipExtension,
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

test("a sound tag is not speech, in parentheses as well as in brackets", () => {
  // Measured, not imagined: a pure 440 Hz tone in a video came back as
  // `(Bell)`. Quoted to the agent as ⟦heard in the video⟧ it reads as
  // something the user said — the video path makes this reach further than
  // voice notes ever did, since any clip carries ambient sound.
  assert.equal(parseWhisperText("(Bell)"), "");
  assert.equal(parseWhisperText("(wind blowing)"), "");
  assert.equal(parseWhisperText("[MUSIC]\n(applause)"), "");
  // But a tag INSIDE a sentence is part of what was said.
  assert.equal(parseWhisperText("(laughs) yes, ship it"), "(laughs) yes, ship it");
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

test("a recorded audio clip gets a truthful extension, defaulting to webm", () => {
  // What Chromium/Firefox MediaRecorder actually emit, plus the parameters a
  // browser tacks onto the mime type. ffmpeg reads by content anyway, so the
  // load-bearing property is only that an unknown type never throws or produces
  // a path-hostile string — it falls back to the common case.
  assert.equal(audioClipExtension("audio/webm"), "webm");
  assert.equal(audioClipExtension("audio/webm;codecs=opus"), "webm");
  assert.equal(audioClipExtension("audio/ogg; codecs=opus"), "ogg");
  assert.equal(audioClipExtension("audio/mp4"), "m4a");
  assert.equal(audioClipExtension("audio/mpeg"), "m4a");
  assert.equal(audioClipExtension("audio/wav"), "wav");
  assert.equal(audioClipExtension("AUDIO/X-WAV"), "wav");
  assert.equal(audioClipExtension(""), "webm");
  assert.equal(audioClipExtension("application/octet-stream"), "webm");
});

test("the cockpit's choice is an id from a closed list, never a file name", async () => {
  const { activeModelFile, SPEECH_MODELS } = await import("../src/whisper.js");
  assert.equal(activeModelFile("medium", "ggml-small-q5_1.bin"), "ggml-medium-q5_0.bin");
  // Nobody chose: the operator's model (env), else the default.
  assert.equal(activeModelFile(null, "ggml-small-q5_1.bin"), "ggml-small-q5_1.bin");
  assert.equal(activeModelFile(null, "my-own.bin"), "my-own.bin");
  // The choice travels from a request body to a path and a URL: anything that
  // is not an id of the list falls back, it is never used as given.
  assert.equal(activeModelFile("../../etc/passwd", "ggml-small-q5_1.bin"), "ggml-small-q5_1.bin");
  assert.equal(activeModelFile("ggml-medium-q5_0.bin", "ggml-small-q5_1.bin"), "ggml-small-q5_1.bin");
  for (const m of SPEECH_MODELS) {
    assert.ok(MODELS[m.file] > 0, `${m.id} must have a measured size`);
    assert.ok(m.note.length > 10 && !/NOTE_/.test(m.note), `${m.id} must say what it costs`);
  }
  assert.equal(new Set(SPEECH_MODELS.map((m) => m.id)).size, SPEECH_MODELS.length);
});

test("size checks and paths follow the model asked for, not the default", () => {
  const medium = "ggml-medium-q5_0.bin";
  assert.ok(modelLooksComplete(MODELS[medium], medium));
  assert.ok(!modelLooksComplete(MODELS[MODEL_FILE], medium), "small's bytes are not medium");
  assert.ok(whisperPaths("/w", medium).model.endsWith(medium));
  // The first-use notice announces the size of what is ACTUALLY about to download.
  const small = Number(/~(\d+) Mo/.exec(installNotice(["model"])!)![1]);
  const big = Number(/~(\d+) Mo/.exec(installNotice(["model"], medium)!)![1]);
  assert.ok(big > small * 2);
});

test("a clip is never left waiting on a model that is still arriving", async () => {
  const { modelForClip } = await import("../src/whisper.js");
  // Picked a minute ago, still downloading: the model that worked answers.
  assert.equal(modelForClip("new.bin", "downloading", "old.bin"), "old.bin");
  // Its download failed: same — a failed upgrade must not cost dictation.
  assert.equal(modelForClip("new.bin", "failed", "old.bin"), "old.bin");
  assert.equal(modelForClip("new.bin", "checking", "old.bin"), "old.bin");
  // Ready, or simply not looked at yet: use it (and install it if need be).
  assert.equal(modelForClip("new.bin", "ready", "old.bin"), "new.bin");
  assert.equal(modelForClip("new.bin", "absent", "old.bin"), "new.bin");
  // Nothing ever worked here: there is no fallback to prefer.
  assert.equal(modelForClip("new.bin", "downloading", null), "new.bin");
  assert.equal(modelForClip("new.bin", "failed", "new.bin"), "new.bin");
});

test("the settings row reports the choice in force and each model's state", async () => {
  const w = await import("../src/whisper.js");
  const dir = process.env.SHADOK_WHISPER_DIR;
  process.env.SHADOK_WHISPER_DIR = "/nonexistent/shadok-whisper-test";
  try {
    w.resetWhisper();
    assert.equal(w.speechStatus().model, "small");
    assert.equal(w.speechStatus().language, "smart");
    w.setSpeechSettings({ model: "medium", language: "fr-FR" });
    const st = w.speechStatus();
    assert.equal(st.model, "medium");
    assert.equal(st.language, "fr");
    assert.deepEqual(st.models.map((m) => m.id), w.SPEECH_MODELS.map((m) => m.id));
    assert.ok(st.models.every((m) => m.state === "absent" && m.mb > 100));
    // An unknown choice is dropped, never stored as a file name.
    w.setSpeechSettings({ model: "ggml-evil.bin", language: "nonsense" });
    assert.equal(w.speechStatus().model, "small");
    assert.equal(w.speechStatus().language, "smart");
  } finally {
    w.resetWhisper();
    if (dir === undefined) delete process.env.SHADOK_WHISPER_DIR; else process.env.SHADOK_WHISPER_DIR = dir;
  }
});

test("the dictation settings are an admin's to change, and only typed prompts teach the language", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const put = src.slice(src.indexOf('app.put("/speech"'));
  const gate = put.indexOf("accountAdmin(req, res, true");
  assert.ok(gate > 0 && gate < put.indexOf("setSpeechForCwd("), "the admin gate must come before the write");
  // A transcription made in the wrong language would vote for its own mistake.
  const note = src.slice(src.indexOf("typedLanguages.note(") - 200, src.indexOf("typedLanguages.note("));
  assert.match(note, /msg\.voice !== true/);
});

test("threads follow the machine, within whisper's default and a ceiling", async () => {
  const { whisperThreads } = await import("../src/whisper.js");
  assert.equal(whisperThreads(1), 1);
  assert.equal(whisperThreads(2), 2);
  assert.equal(whisperThreads(4), 4);
  assert.equal(whisperThreads(8), 4);
  assert.equal(whisperThreads(12), 6);
  assert.equal(whisperThreads(24), 8);
  assert.equal(whisperThreads(96), 8);
  assert.equal(whisperThreads(NaN), 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
// @ts-ignore — plain ESM shared with the browser
import { recognitionCtor, recognitionLang, liveTranscript, spliceDictation, recognitionFailure } from "../public/live-dictation.js";
import { listenLanguage } from "../src/speech-lang.js";

test("a browser without a recogniser has none, prefixed or not", () => {
  const Ctor = function () {};
  assert.equal(recognitionCtor({ SpeechRecognition: Ctor }), Ctor);
  assert.equal(recognitionCtor({ webkitSpeechRecognition: Ctor }), Ctor);
  assert.equal(recognitionCtor({}), null);
  assert.equal(recognitionCtor(undefined), null);
});

test("the recogniser gets the conversation's language in the browser's regional form", () => {
  assert.equal(recognitionLang("fr", ["en-US", "fr-CA"]), "fr-CA");
  assert.equal(recognitionLang("fr", ["en-US"]), "fr");
  assert.equal(recognitionLang("fr", "fr-FR"), "fr-FR");
  // Nothing known about the conversation: the browser's first language.
  assert.equal(recognitionLang(null, ["en-GB", "fr-FR"]), "en-GB");
  assert.equal(recognitionLang(null, []), "");
});

test("settled and provisional words are told apart", () => {
  assert.deepEqual(
    liveTranscript([{ final: true, text: "Open the file." }, { final: false, text: " and read" }, { final: false, text: " it" }]),
    { final: "Open the file.", interim: "and read it" },
  );
  assert.deepEqual(liveTranscript([]), { final: "", interim: "" });
  assert.deepEqual(liveTranscript(null), { final: "", interim: "" });
});

test("a final result that only extends the previous one replaces it", () => {
  // The cumulative finals of a mobile recogniser must not write the sentence three times.
  assert.equal(liveTranscript([
    { final: true, text: "turn" }, { final: true, text: "turn on" }, { final: true, text: "turn on the light" },
  ]).final, "turn on the light");
  // Two different sentences are both kept.
  assert.equal(liveTranscript([{ final: true, text: "First." }, { final: true, text: "Second." }]).final, "First. Second.");
});

test("dictation lands at the cursor with spaces only where words would touch", () => {
  assert.equal(spliceDictation("", "hello", ""), "hello");
  assert.equal(spliceDictation("Say", "hello", ""), "Say hello");
  assert.equal(spliceDictation("Say ", "hello", " there"), "Say hello there");
  assert.equal(spliceDictation("Say", "hello", "there"), "Say hello there");
  assert.equal(spliceDictation("line\n", "hello", ""), "line\nhello");
  // Nothing heard: the composer is left exactly as it was.
  assert.equal(spliceDictation("Say", "", "there"), "Saythere");
});

test("only an unusable recogniser sends the next click to the server", () => {
  assert.deepEqual(recognitionFailure("aborted"), { message: null, fallback: false });
  for (const e of ["no-speech", "not-allowed", "audio-capture"]) {
    const f = recognitionFailure(e);
    assert.equal(f.fallback, false, e);
    assert.ok(f.message, e);
  }
  for (const e of ["network", "service-not-allowed", "language-not-supported", "something-new"]) {
    assert.equal(recognitionFailure(e).fallback, true, e);
  }
});

test("the language to listen in: a fixed one is an order, else typed, else the client's", () => {
  assert.equal(listenLanguage("de", { typed: "fr", hint: "en" }), "de");
  assert.equal(listenLanguage("smart", { typed: "fr", hint: "en" }), "fr");
  assert.equal(listenLanguage("smart", { typed: null, hint: "en" }), "en");
  // "From the audio only" has no meaning for a recogniser that detects nothing.
  assert.equal(listenLanguage("auto", { typed: "fr", hint: "en" }), "en");
  assert.equal(listenLanguage("smart", {}), null);
});

test("the web engine defaults to the browser, an explicit server stands, the write is admin-gated", async () => {
  const w = await import("../src/whisper.js");
  try {
    // An instance that chose nothing dictates live.
    w.setSpeechSettings({});
    assert.equal(w.speechStatus().web, "browser");
    // Keeping the audio on the instance is a choice that must survive.
    w.setSpeechSettings({ web: "server" });
    assert.equal(w.speechStatus().web, "server");
    w.setSpeechSettings({ web: "browser" });
    assert.equal(w.speechStatus().web, "browser");
  } finally {
    w.setSpeechSettings({});
  }
  const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const put = src.slice(src.indexOf('app.put("/speech"'));
  assert.ok(put.indexOf("accountAdmin(req, res, true") < put.indexOf("req.body?.web"), "the admin gate comes before the engine is read");
  assert.match(put.slice(0, put.indexOf("setSpeechForCwd(")), /unknown web dictation engine/);
});

test("the page stops a live dictation when the composer stops being its own", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  // Sent, typed over, or another agent: a late result must not rewrite the box.
  assert.match(html, /promptInput\.addEventListener\("input", \(\) => stopLiveDictation\(true\)\)/);
  assert.match(html, /composer\.addEventListener\("submit", \(\) => stopLiveDictation\(true\), true\)/);
  assert.match(html, /if \(prev && prev !== tab\) stopLiveDictation\(true\);/);
  // The recogniser starts inside the click: no await between the two.
  const start = html.slice(html.indexOf("function startLiveDictation("), html.indexOf("function stopLiveDictation("));
  assert.doesNotMatch(start, /\bawait\b/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
// @ts-ignore — plain ESM shared with the browser
import { recognitionCtor, recognitionLang, liveTranscript, spliceDictation, recognitionFailure, recognitionEnd } from "../public/live-dictation.js";
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

test("every recogniser failure says something the person can act on, an abort says nothing", () => {
  assert.deepEqual(recognitionFailure("aborted"), { message: null });
  for (const e of ["no-speech", "not-allowed", "audio-capture", "network", "service-not-allowed", "language-not-supported", "something-new"]) {
    assert.ok(recognitionFailure(e).message, e);
  }
  // A network failure is not the browser's absence: the two read differently.
  assert.notEqual(recognitionFailure("network").message, recognitionFailure("service-not-allowed").message);
});

test("the language to listen in: a fixed one is an order, else typed, else the client's", () => {
  assert.equal(listenLanguage("de", { typed: "fr", hint: "en" }), "de");
  assert.equal(listenLanguage("smart", { typed: "fr", hint: "en" }), "fr");
  assert.equal(listenLanguage("smart", { typed: null, hint: "en" }), "en");
  // "From the audio only" has no meaning for a recogniser that detects nothing.
  assert.equal(listenLanguage("auto", { typed: "fr", hint: "en" }), "en");
  assert.equal(listenLanguage("smart", {}), null);
});

test("the web dictation is the browser's only: no server engine, no upload route, no setting", () => {
  const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /app\.post\("\/transcribe"/, "the recorded-clip route is gone");
  const listen = src.slice(src.indexOf('app.get("/speech/listen"'), src.indexOf('app.put("/speech"'));
  assert.doesNotMatch(listen, /engine/, "the browser is not told an engine to choose between");
  assert.doesNotMatch(src.slice(src.indexOf('app.put("/speech"')).slice(0, 1500), /req\.body\?\.web/);
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /sttWebSel/, "the Web dictation row is gone");
  assert.doesNotMatch(html, /fetch\("\/transcribe"/);
  // No recogniser, no button — never one that fails on its first click.
  assert.match(html, /if \(micBtn && !\(window\.SpeechRecognition \|\| window\.webkitSpeechRecognition\)\) micBtn\.hidden = true;/);
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

test("a recogniser that ends with nothing heard and no error says so", () => {
  // Gave up by itself, silently: the person is told, not left with an idle button.
  assert.ok(recognitionEnd({ requested: false, heard: false, error: null }).message);
  // The person's own stop, or a dictation that wrote words, is a normal end.
  assert.deepEqual(recognitionEnd({ requested: true, heard: false, error: null }), { message: null });
  assert.deepEqual(recognitionEnd({ requested: false, heard: true, error: null }), { message: null });
  // A named error decides.
  assert.equal(recognitionEnd({ requested: false, heard: false, error: "network" }).message, recognitionFailure("network").message);
  assert.deepEqual(recognitionEnd({ requested: true, heard: false, error: "aborted" }), { message: null });
});

test("the page wires the end verdict and marks its own stops", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /ld\.recognitionEnd\(\{ requested: rec\.shadokStopRequested === true, heard, error: lastError \}\)/);
  assert.match(html, /rec\.shadokStopRequested = true;\s*\n\s*try \{ rec\.stop\(\); \}/);
});

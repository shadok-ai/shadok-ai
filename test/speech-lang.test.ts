import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLang, detectTextLanguage, TypedLanguages, parseDetectedLanguage, retryLanguage,
  normalizeLanguageSetting, STAND_AGAINST_HINT, STAND_AGAINST_TYPED,
} from "../src/speech-lang.js";

test("a client's language tag becomes a whisper code, or nothing", () => {
  assert.equal(normalizeLang("fr-FR"), "fr");
  assert.equal(normalizeLang("pt_BR"), "pt");
  assert.equal(normalizeLang("EN"), "en");
  assert.equal(normalizeLang("zh-Hans-CN"), "zh");
  assert.equal(normalizeLang("nb-NO"), "no", "Bokmål is whisper's `no`");
  // A wrong `-l` is worse than none: anything unknown is refused, not guessed.
  assert.equal(normalizeLang("xx"), null);
  assert.equal(normalizeLang(""), null);
  assert.equal(normalizeLang("fr; rm -rf"), null);
  assert.equal(normalizeLang(undefined), null);
  assert.equal(normalizeLang(["fr"]), null);
});

test("typed prose names its language", () => {
  assert.equal(detectTextLanguage("peux-tu relancer les tests et me dire ce qui casse dans le déploiement ?"), "fr");
  assert.equal(detectTextLanguage("can you run the tests again and tell me what is broken in the deploy?"), "en");
  assert.equal(detectTextLanguage("puedes ejecutar las pruebas otra vez y decirme lo que falla en el despliegue, por favor"), "es");
  assert.equal(detectTextLanguage("kannst du die Tests noch einmal starten und mir sagen, was nicht funktioniert?"), "de");
  assert.equal(detectTextLanguage("перезапусти тесты и скажи, что сломалось"), "ru");
  assert.equal(detectTextLanguage("テストをもう一度実行してください"), "ja");
});

test("French full of English identifiers is still French", () => {
  assert.equal(
    detectTextLanguage("il faut que le `refreshChrome` ne soit pas appelé quand on ouvre le pull request, et que la CI passe"),
    "fr",
  );
  assert.equal(detectTextLanguage("l'agent n'a pas vu qu'il manquait d'accès"), "fr", "elisions are French's signature");
});

test("text that does not say is null — never a guess", () => {
  assert.equal(detectTextLanguage(""), null);
  assert.equal(detectTextLanguage("ok"), null);
  assert.equal(detectTextLanguage("npm run build"), null);
  assert.equal(detectTextLanguage("```\nthe and is are was this that with for you\n```"), null, "code is not prose");
  assert.equal(detectTextLanguage("https://example.com/the/and/is/are/for/you"), null);
});

test("a conversation's language is read off its recent typed messages together", () => {
  const m = new TypedLanguages();
  assert.equal(m.language("s1"), null);
  m.note("s1", "ok");
  m.note("s1", "relance");
  assert.equal(m.language("s1"), null, "two short words prove nothing");
  m.note("s1", "et dis-moi ce que tu vois dans les logs");
  assert.equal(m.language("s1"), "fr");
  assert.equal(m.language("s2"), null, "another conversation is another person");
  m.note(null, "whatever");
  assert.equal(m.language(null), null);
});

test("a conversation that switches language follows the switch", () => {
  const m = new TypedLanguages();
  for (let i = 0; i < 5; i++) m.note("s", "peux-tu regarder ce qui ne va pas dans les tests");
  assert.equal(m.language("s"), "fr");
  for (let i = 0; i < 5; i++) m.note("s", "please have a look at what is wrong with the tests");
  assert.equal(m.language("s"), "en", "only the last few messages are kept");
});

test("whisper's own detection is read off its stderr", () => {
  assert.deepEqual(
    parseDetectedLanguage("whisper_full_with_state: auto-detected language: fr (p = 0.599208)\n"),
    { lang: "fr", p: 0.599208 },
  );
  assert.equal(parseDetectedLanguage("main: processing 'x.wav' (64000 samples), lang = fr, task = transcribe"), null);
  assert.equal(parseDetectedLanguage(""), null);
});

test("a second transcription is paid only by an unexpected AND unsure detection", () => {
  const typedFr = { typed: "fr", hint: "en" };
  // Agreement with either signal: nothing to do.
  assert.equal(retryLanguage(typedFr, { lang: "fr", p: 0.4 }), null);
  assert.equal(retryLanguage(typedFr, { lang: "en", p: 0.4 }), null, "the client's language is acceptable too");
  // Unexpected and unsure: run it again in what was typed.
  assert.equal(retryLanguage(typedFr, { lang: "nl", p: 0.5 }), "fr");
  assert.equal(retryLanguage(typedFr, { lang: "nl", p: STAND_AGAINST_TYPED - 0.01 }), "fr");
  // Unexpected but certain: the person switched language, believe the audio.
  assert.equal(retryLanguage(typedFr, { lang: "nl", p: STAND_AGAINST_TYPED }), null);
});

test("a client's language alone is a weaker claim than typed text", () => {
  const hintOnly = { hint: "fr" };
  assert.equal(retryLanguage(hintOnly, { lang: "en", p: 0.45 }), "fr");
  assert.equal(retryLanguage(hintOnly, { lang: "en", p: STAND_AGAINST_HINT }), null);
  assert.ok(STAND_AGAINST_HINT < STAND_AGAINST_TYPED);
});

test("no signal, or no detection, never triggers a second run", () => {
  assert.equal(retryLanguage(undefined, { lang: "en", p: 0.1 }), null);
  assert.equal(retryLanguage({}, { lang: "en", p: 0.1 }), null);
  assert.equal(retryLanguage({ typed: null, hint: null }, { lang: "en", p: 0.1 }), null);
  assert.equal(retryLanguage({ typed: "fr" }, null), null);
});

test("the language setting is smart unless it is something known", () => {
  assert.equal(normalizeLanguageSetting(undefined), "smart");
  assert.equal(normalizeLanguageSetting("smart"), "smart");
  assert.equal(normalizeLanguageSetting("auto"), "auto");
  assert.equal(normalizeLanguageSetting("fr"), "fr");
  assert.equal(normalizeLanguageSetting("fr-CA"), "fr");
  assert.equal(normalizeLanguageSetting("klingon"), "smart");
  assert.equal(normalizeLanguageSetting("-l en --output-file /etc/x"), "smart");
});

// Live dictation through the BROWSER's own speech recognition (the Web Speech
// API), the alternative to recording a clip and sending it to the server's
// whisper. Pure helpers only: the wiring (the recognition object, the composer)
// lives in index.html. ESM — loaded by the browser AND imported by
// test/live-dictation.test.ts.
//
// Why it exists: whisper on a CPU answers a four-second sentence in ten to
// forty seconds, and says nothing until then. A browser's recogniser writes the
// words while they are spoken. The price is that the audio goes to whoever
// makes the browser: the default, and a setting an admin can turn back to the
// server (Web dictation → On this server) to keep the audio on the instance.

/** The recognition constructor of this browser, or null (Firefox has none). */
export function recognitionCtor(win) {
  return (win && (win.SpeechRecognition || win.webkitSpeechRecognition)) || null;
}

/**
 * The tag handed to the recogniser. Unlike whisper it cannot detect a language:
 * it transcribes in the one it is given. The server says which language the
 * conversation is in ("fr"); the browser knows the regional form its user
 * reads ("fr-CA"), which is the better tag when both agree on the language.
 */
export function recognitionLang(lang, navLangs) {
  const list = (Array.isArray(navLangs) ? navLangs : [navLangs]).filter((l) => typeof l === "string" && l);
  const want = typeof lang === "string" ? lang.toLowerCase().split("-")[0] : "";
  if (!want) return list[0] || "";
  return list.find((l) => l.toLowerCase().split("-")[0] === want) || want;
}

/**
 * What has been heard so far, from the recogniser's result list
 * (`[{ final, text }]`, oldest first): the settled part and the part still
 * being revised.
 *
 * A settled entry that the NEXT settled entry merely extends is dropped. Chrome
 * on Android, in continuous mode, re-emits the whole utterance as a new final
 * result each time it grows ("turn", "turn on", "turn on the") — joined as they
 * come, the sentence is written three times over.
 */
export function liveTranscript(results) {
  const finals = [];
  let interim = "";
  for (const r of results || []) {
    const text = String((r && r.text) || "").trim();
    if (!text) continue;
    if (!r.final) { interim = interim ? interim + " " + text : text; continue; }
    const last = finals[finals.length - 1];
    if (last !== undefined && text.toLowerCase().startsWith(last.toLowerCase())) finals[finals.length - 1] = text;
    else finals.push(text);
  }
  return { final: finals.join(" "), interim };
}

/** The composer's text with the dictation placed where the cursor was: a space
 *  is added on each side only where two words would otherwise touch. */
export function spliceDictation(before, spoken, after) {
  const b = String(before || ""), a = String(after || ""), s = String(spoken || "").trim();
  if (!s) return b + a;
  return b + (b && !/\s$/.test(b) ? " " : "") + s + (a && !/^\s/.test(a) ? " " : "") + a;
}

/**
 * What a recognition error means for the person. `message` is shown (null: say
 * nothing); `fallback` means the browser cannot do this at all here — the next
 * click should record for the server instead of failing the same way again.
 */
export function recognitionFailure(error) {
  switch (error) {
    case "aborted": return { message: null, fallback: false };
    case "no-speech": return { message: "Didn't catch that — try again", fallback: false };
    case "not-allowed": return { message: "Microphone access denied", fallback: false };
    case "audio-capture": return { message: "No microphone available", fallback: false };
    default:
      // network, service-not-allowed, language-not-supported, or a name this
      // list does not know: the recogniser is not usable in this browser.
      return { message: "Browser dictation is unavailable here — click again to use the server's", fallback: true };
  }
}

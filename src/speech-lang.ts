/**
 * Which language a spoken clip is PROBABLY in, before whisper hears it.
 *
 * whisper detects the language from the audio, and on a short clip — which is
 * what a dictated instruction is — that detection is the weakest part of the
 * whole pipeline: a five-second French sentence comes back as approximate
 * English, and every word after that wrong first guess is wrong too.
 *
 * Two things outside the audio say what to expect: what the person has been
 * TYPING in this conversation, and the language their browser / Telegram client
 * runs in. Neither is allowed to overrule the audio on its own — people do
 * dictate in a language they do not type in, and a client's interface language
 * is only a default — so they are used as a second opinion, never as an order:
 * whisper detects first, and only a detection that both DISAGREES with what was
 * expected and was UNSURE of itself is run again in the expected language
 * (`retryLanguage`). A confident detection always stands.
 *
 * Everything here is pure except `typedLanguages`, a small in-memory record of
 * what was typed per conversation. It is deliberately not persisted: after a
 * restart the client's language carries the first clips, and the record refills
 * with the first typed message.
 */

/** The language codes whisper accepts for `-l` (its own table, v3). */
export const WHISPER_LANGS: ReadonlySet<string> = new Set([
  "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it", "id", "hi", "fi", "vi",
  "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk",
  "te", "fa", "lv", "bn", "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw",
  "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo",
  "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln", "ha", "ba", "jw", "su", "yue",
]);

/** Tags that name a whisper language under another code. */
const LANG_ALIASES: Record<string, string> = { nb: "no", iw: "he", in: "id", fil: "tl", jv: "jw" };

/**
 * Pure: a BCP 47 tag (`fr-FR`, `pt_BR`, `zh-Hans`) as a whisper code, or null.
 * Anything whisper does not know is null rather than a guess — a wrong `-l` is
 * worse than none.
 */
export function normalizeLang(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  if (!/^[a-z]{2,3}$/.test(primary)) return null;
  const code = LANG_ALIASES[primary] ?? primary;
  return WHISPER_LANGS.has(code) ? code : null;
}

/**
 * Function words, per language. Only words that are frequent in ordinary prose
 * and that carry little meaning — the ones a technical message still contains
 * when every noun in it is an English identifier.
 */
const STOPWORDS: Record<string, readonly string[]> = {
  en: ["the", "and", "is", "are", "was", "this", "that", "with", "for", "you", "it", "of", "to", "in", "have", "has",
    "not", "but", "what", "can", "should", "would", "there", "from", "they", "we", "be", "on", "do", "does", "please", "i"],
  fr: ["le", "la", "les", "des", "un", "une", "et", "est", "que", "qui", "dans", "pour", "pas", "sur", "avec", "ce",
    "cette", "il", "je", "tu", "nous", "vous", "on", "du", "au", "mais", "ou", "où", "ça", "fait", "faut", "peux", "être",
    "c'est", "j'ai", "aussi", "sont", "ne", "se", "plus", "par", "y", "à", "de"],
  es: ["el", "la", "los", "las", "un", "una", "y", "es", "que", "en", "para", "con", "no", "por", "del", "al", "pero",
    "está", "este", "esta", "lo", "se", "como", "más", "hay", "yo", "tú", "nosotros", "puedes", "hacer", "también", "muy"],
  de: ["der", "die", "das", "und", "ist", "nicht", "ich", "du", "wir", "sie", "ein", "eine", "mit", "für", "auf", "den",
    "dem", "zu", "von", "es", "aber", "auch", "wie", "was", "kann", "bitte", "sind", "im", "noch", "dass", "wenn"],
  it: ["il", "lo", "la", "gli", "le", "un", "una", "e", "è", "che", "di", "per", "con", "non", "del", "della", "ma",
    "sono", "questo", "questa", "come", "più", "anche", "ho", "hai", "puoi", "fare", "nel", "alla", "io", "ci"],
  pt: ["o", "a", "os", "as", "um", "uma", "e", "é", "que", "em", "para", "com", "não", "por", "do", "da", "mas", "está",
    "este", "esta", "como", "mais", "também", "eu", "você", "nós", "pode", "fazer", "no", "na", "muito", "isso"],
  nl: ["de", "het", "een", "en", "is", "niet", "ik", "je", "wij", "zij", "met", "voor", "op", "van", "te", "dat", "maar",
    "ook", "hoe", "wat", "kan", "zijn", "naar", "nog", "als", "er", "aan", "bij", "deze", "dit", "graag"],
};
const STOPSETS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries(STOPWORDS).map(([l, ws]) => [l, new Set(ws)]),
);

/** Scripts one language owns well enough to name it from the letters alone. */
const SCRIPTS: readonly [RegExp, string][] = [
  [/[぀-ヿ]/g, "ja"], // kana — tested before Han, which Japanese also writes
  [/[가-힯]/g, "ko"],
  [/[一-鿿]/g, "zh"],
  [/[Ѐ-ӿ]/g, "ru"],
  [/[؀-ۿ]/g, "ar"],
  [/[֐-׿]/g, "he"],
  [/[Ͱ-Ͽ]/g, "el"],
  [/[฀-๿]/g, "th"],
];

/** What is not prose: code, addresses, paths. Their words say nothing about
 *  the language someone speaks, and they are mostly English. */
function proseOnly(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\bhttps?:\/\/\S+/g, " ")
    .replace(/(?:^|\s)[~.]?\/[\w./-]+/g, " ");
}

const FR_ELISION = /^(?:l|d|j|n|s|c|qu|m|t)'/;

/** Below this many function words there is no evidence, only an accident. */
const MIN_HITS = 3;
/** The winner must beat the runner-up by this much: Romance languages share
 *  half their short words, and a tie is not a result. */
const LEAD = 1.5;

/**
 * Pure: the language a piece of typed text is written in, or null when the text
 * does not say. Null is the common, correct answer for a short or technical
 * message — the caller falls back to weaker signals rather than act on a guess.
 */
export function detectTextLanguage(text: string): string | null {
  const prose = proseOnly(String(text ?? ""));
  const letters = prose.replace(/[^\p{L}]/gu, "").length;
  if (!letters) return null;
  for (const [re, lang] of SCRIPTS) {
    const n = prose.match(re)?.length ?? 0;
    if (n >= 4 && n / letters > 0.3) return lang;
  }
  const words = prose.toLowerCase().match(/[\p{L}]+(?:['’][\p{L}]+)?/gu) ?? [];
  const scores: [string, number][] = Object.entries(STOPSETS).map(([lang, set]) => {
    let n = 0;
    for (const w of words) {
      const plain = w.replace("’", "'");
      if (set.has(plain)) n++;
      // An elision is French's signature: `l'agent`, `qu'il`, `d'abord`.
      else if (lang === "fr" && FR_ELISION.test(plain)) n++;
    }
    return [lang, n];
  });
  scores.sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  if (best[1] < MIN_HITS) return null;
  if (best[1] < second[1] * LEAD) return null;
  return best[0];
}

/** How many typed messages a conversation keeps, and how much of each. */
const KEEP_TEXTS = 5;
const KEEP_CHARS = 600;
const KEEP_KEYS = 500;

/**
 * What was typed lately, per conversation. Typed, never dictated: a clip
 * transcribed in the wrong language produces text IN that wrong language, and
 * feeding it back here would make the first mistake permanent.
 */
export class TypedLanguages {
  private readonly texts = new Map<string, string[]>();

  note(key: string | null | undefined, text: string): void {
    if (!key || !text?.trim()) return;
    const list = this.texts.get(key) ?? [];
    list.push(text.slice(0, KEEP_CHARS));
    if (list.length > KEEP_TEXTS) list.shift();
    // Re-inserted so the map's order is "least recently written first".
    this.texts.delete(key);
    this.texts.set(key, list);
    if (this.texts.size > KEEP_KEYS) this.texts.delete(this.texts.keys().next().value as string);
  }

  /** The language of the recent typed messages taken together, or null. */
  language(key: string | null | undefined): string | null {
    const list = key ? this.texts.get(key) : undefined;
    return list?.length ? detectTextLanguage(list.join("\n")) : null;
  }
}

export const typedLanguages = new TypedLanguages();

/** What the context says to expect. `typed` is what the person wrote in this
 *  conversation; `hint` is their client's language. Either may be missing. */
export interface ExpectedLanguage {
  typed?: string | null;
  hint?: string | null;
}

/** The expectation for one clip: the conversation's typed language, and the
 *  client's own (a browser's `navigator.language`, Telegram's `language_code`). */
export function expectedLanguage(sessionId: string | null | undefined, clientLang?: unknown): ExpectedLanguage {
  return { typed: typedLanguages.language(sessionId), hint: normalizeLang(clientLang) };
}

/**
 * Pure: what whisper said about the language, read off its stderr —
 * `whisper_full_with_state: auto-detected language: fr (p = 0.970000)`.
 * Null when the line is absent (a forced language prints none).
 */
export function parseDetectedLanguage(stderr: string): { lang: string; p: number } | null {
  const m = /auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([0-9.]+)\)/i.exec(String(stderr ?? ""));
  if (!m) return null;
  const p = Number(m[2]);
  return Number.isFinite(p) ? { lang: m[1].toLowerCase(), p } : null;
}

/**
 * How sure a detection must be to stand against what was expected. Someone who
 * has been typing French in this very conversation is strong evidence, so only
 * a clearly confident detection overrules it; a client's interface language is
 * a default nobody chose for this sentence, so it only breaks a coin toss.
 *
 * These two numbers are a judgement, not a measurement: on the clean clips
 * this was tested with, whisper never detected the wrong language. What the
 * clips did show is where NOT to put the lower one — a correct detection of a
 * two-word French clip came back at p = 0.60 on the small model, and a browser
 * set to English must not be enough to overturn that.
 */
export const STAND_AGAINST_TYPED = 0.8;
export const STAND_AGAINST_HINT = 0.5;

/**
 * Pure: the language to transcribe AGAIN in, or null to keep what we have.
 *
 * Null whenever the detection agrees with either signal, whenever there is no
 * signal, and whenever the detection was sure of itself. So the second run is
 * paid only by the clip that would otherwise have come back wrong, and a person
 * who really did switch language is believed as soon as whisper is confident.
 */
export function retryLanguage(
  expected: ExpectedLanguage | undefined,
  detected: { lang: string; p: number } | null,
): string | null {
  if (!detected) return null;
  const typed = expected?.typed || null;
  const hint = expected?.hint || null;
  if (!typed && !hint) return null;
  if (detected.lang === typed || detected.lang === hint) return null;
  if (detected.p >= (typed ? STAND_AGAINST_TYPED : STAND_AGAINST_HINT)) return null;
  return typed ?? hint;
}

/** The language setting: follow the context (default), trust whisper alone, or
 *  one fixed language for an instance where everybody speaks the same. */
export type SpeechLanguageSetting = "smart" | "auto" | string;

/** Pure: a stored or submitted setting, made safe. Unknown → `smart`. */
export function normalizeLanguageSetting(v: unknown): SpeechLanguageSetting {
  if (v === "auto" || v === "smart") return v;
  return normalizeLang(v) ?? "smart";
}

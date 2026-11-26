import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseDetectedLanguage, retryLanguage, normalizeLanguageSetting,
  type ExpectedLanguage, type SpeechLanguageSetting,
} from "./speech-lang.js";

/**
 * Local speech-to-text: Telegram and WhatsApp voice notes, the web composer's
 * Dictate button, the sound track of a shared video.
 *
 * Provisioned ON DEMAND, at the first voice message, never at boot. The live
 * VPS builds its images from a host-side Dockerfile of its own (see CLAUDE.md),
 * so anything baked into the repo image would reach no running instance — while
 * a download at first use reaches every instance the moment it updates, and
 * costs nothing on the instances that never receive a voice message.
 *
 * See docs/superpowers/specs/2026-09-25-telegram-voice-design.md.
 */

/** Pinned, never a moving tag — the same rule the updater follows for npm. */
export const FFMPEG_TAG = "b6.1.1";
export const WHISPER_TAG = "v1.9.4";
/**
 * The models we know, with the size each should weigh — MEASURED, not recalled.
 *
 * `small-q5_1` is the default on a measurement, not a preference: on the same
 * clip, same machine, it transcribed 11 seconds of audio in 15.2s against
 * medium-q5_0's 49.6s — 3.3x faster **for identical output**. Voice notes are
 * short spoken instructions, and a 30-second one would take two minutes on
 * medium, which is a bad enough experience to matter more than the accuracy
 * nobody could see on that sample.
 *
 * The honest limit of that measurement: ONE clip, clear studio English. Noisy,
 * accented or non-English speech is exactly where medium would earn its size
 * back, and this says nothing about it. Which is why the choice is an env var —
 * switching is a download, never a code change.
 */
export const MODELS: Record<string, number> = {
  "ggml-small-q5_1.bin": 190_085_487,
  "ggml-medium-q5_0.bin": 539_212_467,
  "ggml-large-v3-turbo-q5_0.bin": 574_041_195,
};

/**
 * The models an admin can pick in the cockpit (version menu → Dictation).
 *
 * Measured 2026-11-26 on one busy 24-core host, 8 threads, real French speech
 * (a public-domain reading): a 4-second clip took 9s on small, 25s on medium,
 * 42s on turbo; a 28-second one 16s, 51s and 44s. On the same clips small
 * wrote "ses forces par l'enseignement" for "s'efforce, par l'enseignement" and
 * "Voyez l'anniversaire" for "Joyeux anniversaire"; medium and turbo got both.
 * So the picker's notes are ratios from that one machine, not a benchmark —
 * enough to choose by, and the reason the default stays the fast one.
 *
 * Shrinking whisper's audio context for short clips (`-ac`) was measured too
 * and REJECTED: a third faster, but small began inventing words and turbo
 * returned "Ita, ita." for a clean sentence.
 *
 * A closed list on purpose: the choice arrives in a request body and ends up in
 * a file path and a download URL, so it is an `id` looked up here and never a
 * file name. Each entry is pinned by size and SHA-256 like everything else this
 * module fetches. A model outside the list stays possible, for an operator, by
 * `SHADOK_WHISPER_MODEL` + `SHADOK_WHISPER_MODEL_SHA256`.
 */
export interface SpeechModel {
  id: string;
  file: string;
  label: string;
  /** One line for the picker: what choosing it costs and buys. */
  note: string;
  /**
   * This model must be left to write its timestamps. Measured on a 28-second
   * French clip: with `-nt` the turbo model returned "Article 4. Article 6.
   * Article 7. Article 7." — the headings, every sentence between them gone —
   * and the whole text without it. `parseWhisperText` strips the timestamps
   * either way, so the only cost is in knowing which models need it.
   */
  timestamps?: boolean;
}
export const SPEECH_MODELS: readonly SpeechModel[] = [
  { id: "small", file: "ggml-small-q5_1.bin", label: "Small", note: "Fastest. Makes mistakes on short clips and outside English." },
  { id: "medium", file: "ggml-medium-q5_0.bin", label: "Medium", note: "Clearly more accurate. About 3 times slower than Small." },
  { id: "turbo", file: "ggml-large-v3-turbo-q5_0.bin", label: "Large v3 turbo", note: "The most faithful. About 5 times slower than Small on a short clip, close to Medium on a long one.", timestamps: true },
];

/** The model when nobody chose one in the cockpit: the operator's, else small. */
export const MODEL_FILE = process.env.SHADOK_WHISPER_MODEL?.trim() || "ggml-small-q5_1.bin";

/**
 * What the cockpit chose, pushed in by the server at boot and on every change
 * (`setSpeechSettings`). Module state rather than a parameter because four
 * unrelated callers transcribe (web, Telegram, WhatsApp, video) and none of
 * them should have to know there is a setting.
 */
let chosenModelId: string | null = null;
let languageSetting: SpeechLanguageSetting = "smart";
let webEngine: WebDictationEngine = "server";

/**
 * Who transcribes a Dictate click in the WEB composer: this server's whisper,
 * or the browser's own recogniser (live, but the audio goes to the browser's
 * maker — hence opt-in and "server" for anything unrecognised). Voice notes
 * from Telegram and WhatsApp are files and always come here.
 */
export type WebDictationEngine = "server" | "browser";
export function normalizeWebEngine(v: unknown): WebDictationEngine {
  return v === "browser" ? "browser" : "server";
}

export function setSpeechSettings(s: { model?: string | null; language?: unknown; web?: unknown }): void {
  chosenModelId = SPEECH_MODELS.some((m) => m.id === s.model) ? (s.model as string) : null;
  languageSetting = normalizeLanguageSetting(s.language);
  webEngine = normalizeWebEngine(s.web);
}

/** The language rule and the web engine in force, for the routes that answer
 *  a browser about to dictate. */
export function speechSettings(): { language: SpeechLanguageSetting; web: WebDictationEngine } {
  return { language: languageSetting, web: webEngine };
}

/** Pure: the model file in force — the cockpit's choice, else the default. */
export function activeModelFile(choice: string | null = chosenModelId, fallback: string = MODEL_FILE): string {
  return SPEECH_MODELS.find((m) => m.id === choice)?.file ?? fallback;
}

/**
 * SHA-256 of every artifact this module downloads. The tags and file names
 * above say WHICH artifact; only a hash says the bytes are the ones we checked.
 * Everything here is run as root on untrusted Telegram media (ffmpeg, the
 * whisper.cpp build) or parsed by C++ (the model), so "it came from the right
 * URL" is not enough: a release asset can be replaced, a CDN can be poisoned,
 * and `SHADOK_WHISPER_DIR` can be a directory another container writes to.
 *
 * Obtained 2026-11-06 by downloading each artifact and hashing it, then
 * cross-checked against an independent source for each: GitHub's own
 * release-asset `digest` (ffmpeg), and the Hugging Face LFS object id, which IS
 * the SHA-256 (models). The whisper.cpp tarball is a GitHub-generated tag
 * archive; it has no published digest, so its hash rests on that one download.
 *
 * To bump: change the tag / revision, download the new artifact, `sha256sum`
 * it, cross-check it the same way, and replace the hash here in the same
 * commit. A tag bump without a hash bump fails closed (mismatch → refused).
 */
export const FFMPEG_SHA256: Record<string, string> = {
  "ffmpeg-linux-x64": "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99",
  "ffmpeg-linux-arm64": "6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce",
};
/** `archive/refs/tags/${WHISPER_TAG}.tar.gz`. */
export const WHISPER_SRC_SHA256 = "57e280cee375ab02425b806ad5146b99f6eb9357e3c2b31357c8a6af2e2e44ae";
export const MODEL_SHA256: Record<string, string> = {
  "ggml-small-q5_1.bin": "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
  "ggml-medium-q5_0.bin": "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
  // Added 2026-11-26, same method: downloaded and hashed, then checked against
  // the Hub's LFS object id at MODEL_REV.
  "ggml-large-v3-turbo-q5_0.bin": "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
};
/**
 * The model repository's commit, not `main`: `/resolve/main/` is a moving ref,
 * which is exactly what "pinned to an exact version" rules out. This is the
 * head of ggerganov/whisper.cpp on the Hub as of 2026-11-06 (last modified
 * 2024-10-29), read from `https://huggingface.co/api/models/ggerganov/whisper.cpp`.
 */
export const MODEL_REV = "5359861c739e955e79d9a303bcbc70fb988958b1";
export const modelUrl = (file: string): string =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REV}/${file}`;
export const MODEL_URL = modelUrl(MODEL_FILE);

/**
 * Pure: the hash a model must have, or null = refuse it.
 *
 * A model we never hashed (`SHADOK_WHISPER_MODEL` pointed at another file) is
 * REFUSED unless the operator supplies its hash in `SHADOK_WHISPER_MODEL_SHA256`.
 * Allowing it with a warning would make the env var a way around every pin
 * above, and a warning in a server log is read by nobody. An operator hash wins
 * even for a known name: they chose that file and said what it must be.
 */
export function modelSha256(file: string, envSha: string | undefined): string | null {
  const given = envSha?.trim().toLowerCase();
  if (given) return /^[0-9a-f]{64}$/.test(given) ? given : null;
  return MODEL_SHA256[file] ?? null;
}
/** What it should weigh, to catch a truncated download or an HTML error page.
 *  An unknown model name has no expected size, so any non-trivial file passes. */
export const MODEL_BYTES = MODELS[MODEL_FILE] ?? 0;
/** A cheap pre-check before hashing: "roughly right" catches a 4 kB error page
 *  with a clearer message than a hash mismatch. The hash is the real gate. */
export const MODEL_BYTES_SLACK = 32 * 1024 * 1024;

export interface WhisperPaths {
  dir: string;
  ffmpeg: string;
  model: string;
  /** Where the built CLI lands. Newer whisper.cpp calls it `whisper-cli`; older
   *  builds called it `main`, and a machine may carry either. */
  binCandidates: string[];
  src: string;
}

/**
 * Where everything lives. SHARED on purpose, and the sharing is an OPERATOR
 * gesture shadok cannot make for itself: it can only put the path behind
 * `SHADOK_WHISPER_DIR` and write there. Mounting one host directory into
 * several containers turns ~600 MB per container into ~600 MB total; without
 * that mount this degrades, correctly, to one copy each.
 */
export function whisperPaths(dir: string, modelFile: string = MODEL_FILE): WhisperPaths {
  return {
    dir,
    ffmpeg: path.join(dir, "ffmpeg"),
    model: path.join(dir, modelFile),
    src: path.join(dir, `whisper.cpp-${WHISPER_TAG.replace(/^v/, "")}`),
    binCandidates: [
      path.join(dir, "whisper-cli"),
      path.join(dir, `whisper.cpp-${WHISPER_TAG.replace(/^v/, "")}`, "build", "bin", "whisper-cli"),
      path.join(dir, `whisper.cpp-${WHISPER_TAG.replace(/^v/, "")}`, "build", "bin", "main"),
    ],
  };
}

export function whisperDir(): string {
  const env = process.env.SHADOK_WHISPER_DIR?.trim();
  return env || path.join(os.homedir(), ".shadok-ai", "whisper");
}

/**
 * Pure: the static ffmpeg for this machine, or null when we do not know.
 *
 * Refusing an unrecognised platform is the point. Guessing would download an
 * x86-64 binary onto an arm box and fail at `execve` with something opaque —
 * the exact shape invariant 32 spends four rules avoiding. A clear "not
 * supported here" is a better answer than a broken binary.
 */
export function ffmpegAsset(platform: string, arch: string): string | null {
  if (platform !== "linux") return null;
  const name = arch === "x64" ? "ffmpeg-linux-x64" : arch === "arm64" ? "ffmpeg-linux-arm64" : null;
  return name
    ? `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/${name}`
    : null;
}

export type WhisperPart = "cmake" | "ffmpeg" | "whisper" | "model";

/** Pure: what is still missing, in the order it should be installed. */
export function missingParts(present: Record<WhisperPart, boolean>): WhisperPart[] {
  const order: WhisperPart[] = ["cmake", "ffmpeg", "whisper", "model"];
  return order.filter((p) => !present[p]);
}

/**
 * Pure: the one-line notice shown the FIRST time, before anything downloads.
 *
 * Without it the user sends a voice note and gets silence for minutes while
 * ~600 MB arrives and a compiler runs — which looks exactly like a broken bot.
 */
export function installNotice(parts: readonly WhisperPart[], modelFile: string = MODEL_FILE): string | null {
  if (!parts.length) return null;
  const heavy = parts.includes("model");
  const bytes = MODELS[modelFile] ?? 0;
  const mb = Math.round((bytes + 80 * 1024 * 1024) / 1_000_000);
  return `🎙 première fois : j'installe la transcription${heavy && bytes ? ` (~${mb} Mo)` : ""}, je te réponds dès que c'est prêt.`;
}

/** Pure: why it could not be installed, said once and never repeated. */
export function installFailure(reason: string): string {
  return `🎙 je ne peux pas transcrire les vocaux : ${reason}. La transcription reste désactivée jusqu'au prochain redémarrage — les autres messages fonctionnent normalement.`;
}

/**
 * Pure: the text whisper.cpp printed, cleaned.
 *
 * The CLI writes progress and model information to stderr and the transcript to
 * stdout, one line per segment. With `-nt` the segments carry no timestamps, but
 * a build that ignores the flag still emits `[00:00:00.000 --> …]` prefixes, so
 * they are stripped rather than assumed absent.
 */
export function parseWhisperText(stdout: string): string {
  return String(stdout ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*\[[0-9:.\s\->]+\]\s*/, "").trim())
    // A line that is NOTHING BUT a sound tag is not speech. whisper.cpp writes
    // those in brackets AND in parentheses — `[MUSIC]`, `(Bell)`, `(wind
    // blowing)` — and a 440 Hz tone really did come back as `(Bell)`, which
    // the video path would have quoted to the agent as something that was said.
    // Only a whole-line tag goes: "(laughs) yes, ship it" is speech.
    .filter((l) => l && !/^[[(][^[\]()]*[\])]$/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Why there is no text, not merely that there is none.
 *
 * A voice note shows the same notice either way, but a VIDEO must not: "I
 * understood nothing in that voice message" is wrong twice over for a silent
 * screen recording nobody asked to be transcribed. `empty` is a fact about the
 * audio, `failed`/`unavailable` are faults on our side.
 */
export type TranscriptionResult =
  | { ok: true; text: string }
  | { ok: false; kind: "empty" | "failed" | "unavailable"; notice: string };

/**
 * Pure: what to do with a transcription.
 *
 * An empty result is REPORTED, never passed on as an empty prompt: a voice
 * message that produced nothing must say so, or it is indistinguishable from
 * the silent drop this whole feature exists to remove.
 */
export function transcriptionOutcome(text: string): TranscriptionResult {
  const t = parseWhisperText(text);
  if (!t) return { ok: false, kind: "empty", notice: "🎙 je n'ai rien compris dans ce vocal — peux-tu réessayer ou écrire ?" };
  return { ok: true, text: t };
}

/**
 * Pure: what the topic shows for a transcription that WILL be acted on.
 *
 * Load-bearing, not a courtesy. A transcription can be wrong, and an
 * instruction that was misheard and then acted on in silence is far worse than
 * a voice message that was ignored — the user has to see what the agent
 * actually received, while there is still time to correct it.
 */
export function heardNotice(text: string): string {
  return `🎙 « ${text} »`;
}

/**
 * The temp-file extension for an audio clip the web composer records with
 * MediaRecorder. ffmpeg sniffs the container by content, so this is only
 * cosmetic — but a truthful extension keeps the temp file honest and costs
 * nothing. Unknown types fall back to `webm`, the usual MediaRecorder output.
 * Pure/testable.
 */
export function audioClipExtension(contentType: string): string {
  const t = contentType.split(";")[0].trim().toLowerCase();
  switch (t) {
    case "audio/ogg":
    case "audio/ogg; codecs=opus":
      return "ogg";
    case "audio/mp4":
    case "audio/mpeg":
    case "audio/aac":
      return "m4a";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    default:
      return "webm";
  }
}

/** Is a downloaded model plausibly the model, rather than an error page? */
export function modelLooksComplete(size: number, modelFile: string = MODEL_FILE): boolean {
  // An unknown model (someone pointed SHADOK_WHISPER_MODEL at another file) has
  // no expected size: accept anything that is plainly not an error page rather
  // than refuse a model we simply have no number for.
  const bytes = MODELS[modelFile] ?? 0;
  if (!bytes) return size > 8 * 1024 * 1024;
  return Math.abs(size - bytes) <= MODEL_BYTES_SLACK;
}

/** The built CLI, or null when none of the candidates is there. */
export function existingBin(p: WhisperPaths): string | null {
  for (const c of p.binCandidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Pure: how to install a build tool on this host, or null when we cannot.
 *
 * Deliberately the same shape as `tmuxInstallCommand`, which already solved
 * this for tmux: the package managers, the root question, and the honest null
 * for a host we do not know how to serve.
 */
export function pkgInstallCommand(
  platform: NodeJS.Platform,
  has: (bin: string) => boolean,
  pkg: string,
): { cmd: string; args: string[]; needsRoot: boolean } | null {
  if (platform === "darwin") return has("brew") ? { cmd: "brew", args: ["install", pkg], needsRoot: false } : null;
  if (platform === "linux") {
    if (has("apt-get")) return { cmd: "apt-get", args: ["install", "-y", "--no-install-recommends", pkg], needsRoot: true };
    if (has("apk")) return { cmd: "apk", args: ["add", pkg], needsRoot: true };
    if (has("dnf")) return { cmd: "dnf", args: ["install", "-y", pkg], needsRoot: true };
    if (has("yum")) return { cmd: "yum", args: ["install", "-y", pkg], needsRoot: true };
    if (has("pacman")) return { cmd: "pacman", args: ["-S", "--noconfirm", pkg], needsRoot: true };
  }
  return null;
}

export type WhisperState =
  | { kind: "ready"; bin: string; ffmpeg: string; model: string }
  | { kind: "unavailable"; reason: string };
type ToolState = { kind: "ready"; bin: string; ffmpeg: string } | { kind: "unavailable"; reason: string };
type ModelState = { kind: "ready"; path: string } | { kind: "unavailable"; reason: string };

/**
 * ONE install for the whole process, and one refusal too.
 *
 * Single-flight is not a nicety here: two voice messages arriving a second
 * apart would otherwise start two 514 MB downloads into the same path and two
 * compiles in the same directory. That is exactly how the first-boot
 * `ENOTEMPTY` happened (invariant 32) — two installs racing over one tree.
 *
 * A failure is remembered, so a broken host is not asked to download 600 MB
 * again on every voice note. It is cleared by a restart, or by an admin picking
 * a model in the cockpit (`prefetchSpeech`) — both are moments when someone has
 * plausibly fixed whatever was wrong.
 *
 * The toolchain (cmake, ffmpeg, the whisper.cpp build) and the MODELS are
 * tracked apart, because the model is now a setting: changing it must cost one
 * download, never a rebuild, and each model file is its own single flight.
 */
let toolInFlight: Promise<ToolState> | null = null;
let toolSettled: ToolState | null = null;
const modelInFlight = new Map<string, Promise<ModelState>>();
const modelSettled = new Map<string, ModelState>();
/** Bytes received so far, per model being downloaded — for the settings row. */
const modelProgress = new Map<string, number>();
/** The model that last proved usable in this process: what a clip is
 *  transcribed with while a newly chosen one is still downloading. */
let lastReadyModel: string | null = null;

export function whisperState(): WhisperState | null {
  const model = modelSettled.get(activeModelFile());
  if (!toolSettled || !model) return null;
  if (toolSettled.kind !== "ready") return toolSettled;
  if (model.kind !== "ready") return model;
  return { kind: "ready", bin: toolSettled.bin, ffmpeg: toolSettled.ffmpeg, model: model.path };
}

/** Test seam: forget what this process decided. */
export function resetWhisper(): void {
  toolInFlight = null;
  toolSettled = null;
  modelInFlight.clear();
  modelSettled.clear();
  modelProgress.clear();
  lastReadyModel = null;
  chosenModelId = null;
  languageSetting = "smart";
  ffInFlight = null;
  ffSettled = null;
}

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

const run = promisify(execFile);
/** Is this tool on PATH? `require` would throw in an ESM module — tsc says
 *  nothing about that, only running it does. */
const HAS = (b: string): boolean => {
  try {
    execFileSync("sh", ["-lc", `command -v ${b}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(fs.createReadStream(file), h);
  return h.digest("hex");
}

/** Our own record that a file was hashed and matched, beside the file. */
const markerPath = (file: string): string => `${file}.sha256-ok`;

/**
 * Pure: may we skip hashing this file again?
 *
 * Hashing a 190 MB model on every voice note would cost a second each time, so
 * a verified file gets a marker. The marker is only a CACHE of our verdict and
 * is void the moment the file's size or mtime moves — a file replaced in a
 * shared directory is hashed again before it is trusted. (Someone who can write
 * both the file and a matching marker can also replace the binary we built; the
 * marker does not claim to defend against a writer of the directory itself.)
 */
export function markerValid(
  marker: unknown,
  st: { size: number; mtimeMs: number },
  expected: string,
): boolean {
  if (!marker || typeof marker !== "object") return false;
  const m = marker as Record<string, unknown>;
  return m.sha256 === expected && m.size === st.size && m.mtimeMs === st.mtimeMs;
}

async function writeMarker(file: string, sha256: string): Promise<void> {
  const st = await fs.promises.stat(file);
  await fs.promises.writeFile(markerPath(file), JSON.stringify({ sha256, size: st.size, mtimeMs: st.mtimeMs }));
}

/**
 * Is the file already here, and is it the pinned one?
 *
 * `mismatch` is not a crash: the caller removes it and downloads the pinned
 * artifact again, which is what heals a directory left by an older build or a
 * neighbour container — and refuses, through the download's own check, if the
 * network keeps serving the wrong bytes.
 */
export async function verifyCached(file: string, expected: string): Promise<"ok" | "missing" | "mismatch"> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return "missing";
  }
  try {
    const m = JSON.parse(await fs.promises.readFile(markerPath(file), "utf8"));
    if (markerValid(m, st, expected)) return "ok";
  } catch {
    /* no marker, or unreadable: hash it */
  }
  const actual = await sha256File(file);
  if (actual !== expected) {
    console.log(`whisper: ${path.basename(file)} does not match its pinned SHA-256 (got ${actual}) — replacing it`);
    return "mismatch";
  }
  await writeMarker(file, expected).catch(() => {});
  return "ok";
}

/** A cached file that is not the pinned one is removed, so it is re-fetched. */
async function presentAndPinned(file: string, expected: string): Promise<boolean> {
  const v = await verifyCached(file, expected);
  if (v === "mismatch") {
    await fs.promises.rm(file, { force: true });
    await fs.promises.rm(markerPath(file), { force: true });
  }
  return v === "ok";
}

/**
 * Download to a TEMP name, verify, THEN rename.
 *
 * The temp name already meant a killed download never leaves a half file the
 * next run mistakes for an install. The hash is checked on the temp file, so a
 * file that is not the pinned artifact never reaches its real name — not even
 * for the instant between the rename and a check made afterwards, which is the
 * instant another container sharing the directory could pick it up.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  opts: { sha256: string; mode?: number; fetchImpl?: typeof fetch; onProgress?: (bytes: number) => void },
): Promise<void> {
  const tmp = `${dest}.part-${process.pid}`;
  const r = await (opts.fetchImpl ?? fetch)(url, { redirect: "follow" });
  if (!r.ok || !r.body) throw new Error(`${url} → HTTP ${r.status}`);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    const h = createHash("sha256");
    const src = Readable.fromWeb(r.body as never);
    let got = 0;
    src.on("data", (c: Buffer) => {
      h.update(c);
      got += c.length;
      opts.onProgress?.(got);
    });
    await pipeline(src, fs.createWriteStream(tmp));
    const actual = h.digest("hex");
    if (actual !== opts.sha256) {
      throw new Error(`SHA-256 mismatch for ${path.basename(dest)}: expected ${opts.sha256}, got ${actual} — refusing it`);
    }
    await fs.promises.chmod(tmp, opts.mode ?? 0o644);
    await fs.promises.rename(tmp, dest);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  await writeMarker(dest, opts.sha256).catch(() => {});
}

async function installPkg(pkg: string): Promise<void> {
  const plan = pkgInstallCommand(process.platform, HAS, pkg);
  if (!plan) throw new Error(`no package manager here to install ${pkg}`);
  const root = process.getuid?.() === 0;
  const [cmd, args] = root || !plan.needsRoot
    ? [plan.cmd, plan.args]
    : ["sudo", ["-n", plan.cmd, ...plan.args]];
  // apt needs its lists before it can install anything on a slim image.
  if (plan.cmd === "apt-get") {
    await run(root ? "apt-get" : "sudo", root ? ["update"] : ["-n", "apt-get", "update"], { timeout: 300_000 }).catch(() => {});
  }
  await run(cmd, args as string[], { timeout: 900_000 });
}

export type FfmpegState = { kind: "ready"; ffmpeg: string } | { kind: "unavailable"; reason: string };

let ffInFlight: Promise<FfmpegState> | null = null;
let ffSettled: FfmpegState | null = null;

/** Said once, before the first byte moves: a download nobody announced looks
 *  like a bot that stopped answering. */
export const FFMPEG_NOTICE = "🎬 first time: fetching the video toolchain (~80 MB), one moment.";

/**
 * The static ffmpeg alone — no cmake, no whisper build, no 600 MB model.
 *
 * Split out of `ensureWhisper` because the video path needs ONLY this: stills
 * from a silent clip must not cost a speech-to-text install. Single-flight and
 * sticky-on-failure for the same reasons stated there, and it is now the one
 * place that writes `ffmpeg` — `ensureWhisper` goes through it too.
 */
export async function ensureFfmpeg(notify?: (line: string) => void): Promise<FfmpegState> {
  if (ffSettled) return ffSettled;
  if (ffInFlight) return ffInFlight;
  ffInFlight = (async (): Promise<FfmpegState> => {
    const p = whisperPaths(whisperDir());
    try {
      const url = ffmpegAsset(process.platform, process.arch);
      if (!url) throw new Error(`no static ffmpeg for ${process.platform}/${process.arch}`);
      const pin = FFMPEG_SHA256[path.basename(url)];
      if (!pin) throw new Error(`no pinned SHA-256 for ${path.basename(url)}`);
      if (!(await presentAndPinned(p.ffmpeg, pin))) {
        notify?.(FFMPEG_NOTICE);
        await fs.promises.mkdir(p.dir, { recursive: true });
        await downloadVerified(url, p.ffmpeg, { sha256: pin, mode: 0o755 });
      }
      ffSettled = { kind: "ready", ffmpeg: p.ffmpeg };
      console.log(`ffmpeg: ready (${p.ffmpeg})`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      ffSettled = { kind: "unavailable", reason };
      console.log(`ffmpeg: unavailable — ${reason}`);
    }
    return ffSettled;
  })().finally(() => { ffInFlight = null; });
  return ffInFlight;
}

/** cmake, ffmpeg and the whisper.cpp CLI — everything but a model. */
async function ensureToolchain(): Promise<ToolState> {
  if (toolSettled) return toolSettled;
  if (toolInFlight) return toolInFlight;
  toolInFlight = (async (): Promise<ToolState> => {
    const dir = whisperDir();
    const p = whisperPaths(dir);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      if (!HAS("cmake")) await installPkg("cmake");
      // ALWAYS through the same single-flight as the video path, even when a
      // file is already there: that is where a cached ffmpeg is checked
      // against its pin. And two provisioners writing `${dest}.part-${pid}`
      // from one pid is the ENOTEMPTY-shaped race this file already paid for.
      const ff = await ensureFfmpeg();
      if (ff.kind !== "ready") throw new Error(ff.reason);
      if (!existingBin(p)) {
        const tgz = path.join(dir, `whisper-${WHISPER_TAG}.tar.gz`);
        // Verified BEFORE extraction: what is built from it runs as root.
        await downloadVerified(`https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER_TAG}.tar.gz`, tgz,
          { sha256: WHISPER_SRC_SHA256 });
        await run("tar", ["xzf", tgz, "-C", dir], { timeout: 300_000 });
        await fs.promises.rm(tgz, { force: true });
        await fs.promises.rm(markerPath(tgz), { force: true });
        // -DWHISPER_BUILD_TESTS=OFF: we need one CLI, not their test suite, and
        // on a box already running dozens of agents every avoided object file
        // is a second of somebody else's CPU.
        await run("cmake", ["-B", "build", "-DCMAKE_BUILD_TYPE=Release", "-DWHISPER_BUILD_TESTS=OFF",
          "-DWHISPER_BUILD_EXAMPLES=ON"], { cwd: p.src, timeout: 900_000 });
        await run("cmake", ["--build", "build", "--config", "Release", "-j", "2"], { cwd: p.src, timeout: 1_800_000 });
      }
      const bin = existingBin(p);
      if (!bin) throw new Error("whisper built but no CLI was produced");
      toolSettled = { kind: "ready", bin, ffmpeg: p.ffmpeg };
      console.log(`whisper: ready (${bin})`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      toolSettled = { kind: "unavailable", reason };
      console.log(`whisper: unavailable — ${reason}`);
    }
    return toolSettled;
  })().finally(() => { toolInFlight = null; });
  return toolInFlight;
}

/** One model file: already there and pinned, or downloaded and verified. */
async function ensureModel(file: string): Promise<ModelState> {
  const done = modelSettled.get(file);
  if (done) return done;
  const flying = modelInFlight.get(file);
  if (flying) return flying;
  const job = (async (): Promise<ModelState> => {
    let state: ModelState;
    try {
      // The operator's hash speaks for the operator's file, and only for it.
      const pin = modelSha256(file, file === MODEL_FILE ? process.env.SHADOK_WHISPER_MODEL_SHA256 : undefined);
      if (!pin) throw new Error(`no pinned SHA-256 for the model ${file} — set SHADOK_WHISPER_MODEL_SHA256 to its hash`);
      const dest = path.join(whisperDir(), file);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      const have = fs.existsSync(dest) && modelLooksComplete(fs.statSync(dest).size, file)
        && (await presentAndPinned(dest, pin));
      if (!have) {
        // The hash is the gate; a truncated file or an HTML error page fails it
        // too, before it ever takes the model's name.
        console.log(`whisper: downloading the model ${file}`);
        modelProgress.set(file, 0);
        await downloadVerified(modelUrl(file), dest, { sha256: pin, onProgress: (n) => modelProgress.set(file, n) });
      }
      state = { kind: "ready", path: dest };
      lastReadyModel = file;
      console.log(`whisper: model ready (${file})`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      state = { kind: "unavailable", reason };
      console.log(`whisper: model ${file} unavailable — ${reason}`);
    }
    modelProgress.delete(file);
    modelSettled.set(file, state);
    return state;
  })().finally(() => { modelInFlight.delete(file); });
  modelInFlight.set(file, job);
  return job;
}

/**
 * Provision everything, once. Returns the same answer to every later caller.
 *
 * `notify` is called ONCE, before the first byte moves, so the user learns that
 * a long install started rather than watching silence.
 */
export async function ensureWhisper(
  notify?: (line: string) => void,
  modelFile: string = activeModelFile(),
): Promise<WhisperState> {
  const knownModel = modelSettled.get(modelFile);
  if (!toolSettled || !knownModel) {
    // Announced only for an install that is about to START: a caller joining
    // one in flight, or hitting a remembered failure, has nothing new to hear.
    const starting = !toolInFlight && !modelInFlight.has(modelFile)
      && toolSettled?.kind !== "unavailable" && knownModel?.kind !== "unavailable";
    if (starting) {
      const p = whisperPaths(whisperDir(), modelFile);
      const notice = installNotice(missingParts({
        cmake: HAS("cmake"),
        ffmpeg: fs.existsSync(p.ffmpeg),
        whisper: !!existingBin(p),
        model: fs.existsSync(p.model) && modelLooksComplete(fs.statSync(p.model).size, modelFile),
      }), modelFile);
      if (notice) notify?.(notice);
    }
  }
  // The toolchain first: a host that cannot build whisper must not be made to
  // download several hundred MB of model it will never run.
  const tool = await ensureToolchain();
  if (tool.kind !== "ready") return tool;
  const model = await ensureModel(modelFile);
  if (model.kind !== "ready") return model;
  return { kind: "ready", bin: tool.bin, ffmpeg: tool.ffmpeg, model: model.path };
}

/**
 * Pure: how many threads one transcription takes.
 *
 * whisper.cpp defaults to 4 whatever the machine. Measured on a 24-core host
 * already busy with agents, 8 threads against 4 took a 4-second clip from 15.6s
 * to 8.8s on `small` and from 77s to 41s on the turbo model — the difference
 * between a dictation that feels slow and one that feels broken. Half the
 * cores, never more than 8 (the gain flattens and the agents need the rest),
 * and never fewer than whisper's own default would have used.
 */
export function whisperThreads(cpus: number): number {
  const n = Math.max(1, Math.floor(cpus) || 1);
  return Math.min(8, Math.max(Math.min(4, n), Math.floor(n / 2)));
}

/** `checking` is a file already on disk being hashed against its pin — a
 *  second or two, and not a download: saying "downloading" for it would be a lie
 *  about several hundred MB. */
export type ModelAvailability = "ready" | "checking" | "downloading" | "failed" | "absent";

/**
 * Pure: the model to transcribe THIS clip with.
 *
 * A model picked in the cockpit takes minutes to arrive, and a download can
 * fail. Neither should take dictation away from an instance that was
 * transcribing a moment ago: until the chosen model is usable, the one that
 * last worked keeps answering.
 */
export function modelForClip(chosen: string, state: ModelAvailability, lastReady: string | null): string {
  if (state !== "ready" && state !== "absent" && lastReady && lastReady !== chosen) return lastReady;
  return chosen;
}

function availability(file: string): { state: ModelAvailability; reason?: string; percent?: number } {
  const done = modelSettled.get(file);
  if (done?.kind === "ready") return { state: "ready" };
  if (modelInFlight.has(file)) {
    const total = MODELS[file] ?? 0;
    const got = modelProgress.get(file);
    // In flight with no byte counted yet: hashing a file that is there, or
    // about to download one that is not.
    if (got === undefined) return { state: fs.existsSync(path.join(whisperDir(), file)) ? "checking" : "downloading" };
    return { state: "downloading", ...(total ? { percent: Math.min(99, Math.floor((got / total) * 100)) } : {}) };
  }
  if (done) return { state: "failed", reason: done.reason };
  // Not looked at by this process yet: on disk at the right size counts as
  // there. (Its hash is checked before first use, as always.)
  try {
    if (modelLooksComplete(fs.statSync(path.join(whisperDir(), file)).size, file)) return { state: "ready" };
  } catch { /* absent */ }
  return { state: "absent" };
}

export interface SpeechStatus {
  model: string;
  language: SpeechLanguageSetting;
  web: WebDictationEngine;
  models: { id: string; label: string; note: string; mb: number; state: ModelAvailability; percent?: number; reason?: string }[];
}

/** What the settings row shows: the choice in force and where each model is. */
export function speechStatus(): SpeechStatus {
  const active = activeModelFile();
  const list: SpeechModel[] = [...SPEECH_MODELS];
  // An operator's own model (env) is shown so the row never lies about what
  // runs; it cannot be picked, only left by picking another.
  if (!list.some((m) => m.file === MODEL_FILE)) {
    list.push({ id: "custom", file: MODEL_FILE, label: MODEL_FILE, note: "set by SHADOK_WHISPER_MODEL" });
  }
  return {
    model: list.find((m) => m.file === active)?.id ?? "small",
    language: languageSetting,
    web: webEngine,
    models: list.map((m) => ({
      id: m.id, label: m.label, note: m.note, mb: Math.round((MODELS[m.file] ?? 0) / 1_000_000),
      ...availability(m.file),
    })),
  };
}

/**
 * Start fetching the model in force now, in the background — called when an
 * admin picks one, so the download is over before the next person dictates
 * rather than starting under them. Picking is also a retry: a remembered
 * failure is forgotten first.
 */
export function prefetchSpeech(): void {
  const file = activeModelFile();
  if (modelSettled.get(file)?.kind === "unavailable") modelSettled.delete(file);
  if (toolSettled?.kind === "unavailable") toolSettled = null;
  void ensureWhisper(undefined, file);
}

/**
 * Transcribe one audio file. Returns the text, or a notice to show instead.
 *
 * The WAV is written beside the source and removed afterwards: whisper.cpp
 * reads 16 kHz mono PCM and Telegram sends OGG/Opus, so the conversion is not
 * optional.
 *
 * `expect` is what the context says about the language (`src/speech-lang.ts`).
 * It never replaces whisper's own detection: the clip is detected first, and
 * transcribed a second time only when that detection was both unexpected and
 * unsure — see `retryLanguage`.
 */
export async function transcribe(
  audioPath: string,
  notify?: (line: string) => void,
  opts?: { expect?: ExpectedLanguage },
): Promise<TranscriptionResult> {
  const chosen = activeModelFile();
  const state = await ensureWhisper(notify, modelForClip(chosen, availability(chosen).state, lastReadyModel));
  if (state.kind !== "ready") return { ok: false, kind: "unavailable", notice: installFailure(state.reason) };
  const wav = `${audioPath}.16k.wav`;
  const keepTimestamps = SPEECH_MODELS.some((m) => m.timestamps && m.file === path.basename(state.model));
  const whisper = (lang: string) =>
    run(state.bin, [
      "-m", state.model, "-f", wav, ...(keepTimestamps ? [] : ["-nt"]),
      "-l", lang, "-t", String(whisperThreads(os.availableParallelism())),
    ], { timeout: 600_000, maxBuffer: 1 << 24 });
  try {
    await run(state.ffmpeg, ["-nostdin", "-y", "-i", audioPath, "-ar", "16000", "-ac", "1", "-f", "wav", wav],
      { timeout: 120_000 });
    const setting = languageSetting;
    const first = await whisper(setting === "smart" || setting === "auto" ? "auto" : setting);
    let out = transcriptionOutcome(first.stdout);
    if (setting === "smart") {
      const detected = parseDetectedLanguage(first.stderr);
      const again = retryLanguage(opts?.expect, detected);
      if (again) {
        console.log(`whisper: detected ${detected?.lang} (p=${detected?.p.toFixed(2)}) where ${again} was expected — transcribing again in ${again}`);
        // The first transcript is still a transcript: a second run that fails
        // or hears nothing must not lose it.
        const second = await whisper(again).then((r) => transcriptionOutcome(r.stdout)).catch(() => null);
        if (second?.ok) out = second;
      }
    }
    return out;
  } catch (e) {
    return { ok: false, kind: "failed", notice: `🎙 la transcription a échoué : ${e instanceof Error ? e.message.slice(0, 200) : e}` };
  } finally {
    await fs.promises.rm(wav, { force: true }).catch(() => {});
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Local speech-to-text for Telegram voice messages.
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
};

export const MODEL_FILE = process.env.SHADOK_WHISPER_MODEL?.trim() || "ggml-small-q5_1.bin";
export const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`;
/** What it should weigh, to catch a truncated download or an HTML error page.
 *  An unknown model name has no expected size, so any non-trivial file passes. */
export const MODEL_BYTES = MODELS[MODEL_FILE] ?? 0;
/** The file is content-addressed by NAME, not by hash, so an exact match is too
 *  strict while "roughly right" still catches a 4 kB error page. */
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
export function whisperPaths(dir: string): WhisperPaths {
  return {
    dir,
    ffmpeg: path.join(dir, "ffmpeg"),
    model: path.join(dir, MODEL_FILE),
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
export function installNotice(parts: readonly WhisperPart[]): string | null {
  if (!parts.length) return null;
  const heavy = parts.includes("model");
  const mb = Math.round((MODEL_BYTES + 80 * 1024 * 1024) / 1_000_000);
  return `🎙 première fois : j'installe la transcription${heavy && MODEL_BYTES ? ` (~${mb} Mo)` : ""}, je te réponds dès que c'est prêt.`;
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
    .filter((l) => l && !/^\[.*\]$/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pure: what to do with a transcription.
 *
 * An empty result is REPORTED, never passed on as an empty prompt: a voice
 * message that produced nothing must say so, or it is indistinguishable from
 * the silent drop this whole feature exists to remove.
 */
export function transcriptionOutcome(text: string): { ok: true; text: string } | { ok: false; notice: string } {
  const t = parseWhisperText(text);
  if (!t) return { ok: false, notice: "🎙 je n'ai rien compris dans ce vocal — peux-tu réessayer ou écrire ?" };
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

/** Is a downloaded model plausibly the model, rather than an error page? */
export function modelLooksComplete(size: number): boolean {
  // An unknown model (someone pointed SHADOK_WHISPER_MODEL at another file) has
  // no expected size: accept anything that is plainly not an error page rather
  // than refuse a model we simply have no number for.
  if (!MODEL_BYTES) return size > 8 * 1024 * 1024;
  return Math.abs(size - MODEL_BYTES) <= MODEL_BYTES_SLACK;
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

/**
 * ONE install for the whole process, and one refusal too.
 *
 * Single-flight is not a nicety here: two voice messages arriving a second
 * apart would otherwise start two 514 MB downloads into the same path and two
 * compiles in the same directory. That is exactly how the first-boot
 * `ENOTEMPTY` happened (invariant 32) — two installs racing over one tree.
 *
 * A failure is remembered, so a broken host is not asked to download 600 MB
 * again on every voice note. It is cleared only by a restart, which is the
 * moment someone has plausibly fixed whatever was wrong.
 */
let inFlight: Promise<WhisperState> | null = null;
let settled: WhisperState | null = null;

export function whisperState(): WhisperState | null {
  return settled;
}

/** Test seam: forget what this process decided. */
export function resetWhisper(): void {
  inFlight = null;
  settled = null;
}

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

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

/** Download to a TEMP name then rename: a killed download must never leave a
 *  half file that the next run mistakes for an install. */
async function fetchTo(url: string, dest: string, mode = 0o644): Promise<void> {
  const tmp = `${dest}.part-${process.pid}`;
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok || !r.body) throw new Error(`${url} → HTTP ${r.status}`);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(r.body as never), fs.createWriteStream(tmp));
  await fs.promises.chmod(tmp, mode);
  await fs.promises.rename(tmp, dest);
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

/**
 * Provision everything, once. Returns the same answer to every later caller.
 *
 * `notify` is called ONCE, before the first byte moves, so the user learns that
 * a long install started rather than watching silence.
 */
export async function ensureWhisper(notify?: (line: string) => void): Promise<WhisperState> {
  if (settled) return settled;
  if (inFlight) return inFlight;
  inFlight = (async (): Promise<WhisperState> => {
    const dir = whisperDir();
    const p = whisperPaths(dir);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const present = {
        cmake: HAS("cmake"),
        ffmpeg: fs.existsSync(p.ffmpeg),
        whisper: !!existingBin(p),
        model: fs.existsSync(p.model) && modelLooksComplete(fs.statSync(p.model).size),
      };
      const missing = missingParts(present);
      const notice = installNotice(missing);
      if (notice) notify?.(notice);

      if (!present.cmake) await installPkg("cmake");
      if (!present.ffmpeg) {
        const url = ffmpegAsset(process.platform, process.arch);
        if (!url) throw new Error(`no static ffmpeg for ${process.platform}/${process.arch}`);
        await fetchTo(url, p.ffmpeg, 0o755);
      }
      if (!present.whisper) {
        const tgz = path.join(dir, `whisper-${WHISPER_TAG}.tar.gz`);
        await fetchTo(`https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER_TAG}.tar.gz`, tgz);
        await run("tar", ["xzf", tgz, "-C", dir], { timeout: 300_000 });
        await fs.promises.rm(tgz, { force: true });
        // -DWHISPER_BUILD_TESTS=OFF: we need one CLI, not their test suite, and
        // on a box already running dozens of agents every avoided object file
        // is a second of somebody else's CPU.
        await run("cmake", ["-B", "build", "-DCMAKE_BUILD_TYPE=Release", "-DWHISPER_BUILD_TESTS=OFF",
          "-DWHISPER_BUILD_EXAMPLES=ON"], { cwd: p.src, timeout: 900_000 });
        await run("cmake", ["--build", "build", "--config", "Release", "-j", "2"], { cwd: p.src, timeout: 1_800_000 });
      }
      if (!present.model) {
        await fetchTo(MODEL_URL, p.model);
        const size = fs.statSync(p.model).size;
        // A redirect to an HTML error page weighs kilobytes and would otherwise
        // sit there forever as "the model", failing at every transcription.
        if (!modelLooksComplete(size)) {
          await fs.promises.rm(p.model, { force: true });
          throw new Error(`the model downloaded to ${size} bytes, not ~${MODEL_BYTES}`);
        }
      }
      const bin = existingBin(p);
      if (!bin) throw new Error("whisper built but no CLI was produced");
      settled = { kind: "ready", bin, ffmpeg: p.ffmpeg, model: p.model };
      console.log(`whisper: ready (${bin})`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      settled = { kind: "unavailable", reason };
      console.log(`whisper: unavailable — ${reason}`);
    }
    return settled;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Transcribe one audio file. Returns the text, or a notice to show instead.
 *
 * The WAV is written beside the source and removed afterwards: whisper.cpp
 * reads 16 kHz mono PCM and Telegram sends OGG/Opus, so the conversion is not
 * optional.
 */
export async function transcribe(
  audioPath: string,
  notify?: (line: string) => void,
): Promise<{ ok: true; text: string } | { ok: false; notice: string }> {
  const state = await ensureWhisper(notify);
  if (state.kind !== "ready") return { ok: false, notice: installFailure(state.reason) };
  const wav = `${audioPath}.16k.wav`;
  try {
    await run(state.ffmpeg, ["-nostdin", "-y", "-i", audioPath, "-ar", "16000", "-ac", "1", "-f", "wav", wav],
      { timeout: 120_000 });
    const { stdout } = await run(state.bin, ["-m", state.model, "-f", wav, "-nt", "-l", "auto"],
      { timeout: 600_000, maxBuffer: 1 << 24 });
    return transcriptionOutcome(stdout);
  } catch (e) {
    return { ok: false, notice: `🎙 la transcription a échoué : ${e instanceof Error ? e.message.slice(0, 200) : e}` };
  } finally {
    await fs.promises.rm(wav, { force: true }).catch(() => {});
  }
}

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ensureFfmpeg, transcribe } from "./whisper.js";

/**
 * Turning a video into things an agent can actually read.
 *
 * A Telegram video used to be dropped before it reached any binding (it has no
 * `msg.text`, and `attachmentOf` did not know the field). Recognising it is only
 * half the fix: `Read` opens images, PDFs and text — never an mp4 — and this
 * container has no `ffmpeg` on PATH, so an agent handed a path cannot help
 * itself either. So the bridge does the work the voice pipeline already does for
 * speech: it extracts STILLS (vision, i.e. actually seeing the clip) over the
 * same static ffmpeg `src/whisper.ts` provisions on demand.
 *
 * See docs/superpowers/specs/2026-10-16-telegram-video-design.md.
 */

const run = promisify(execFile);

/** Stills for a lone video. Six is a storyboard; more is a context bill nobody
 *  asked for, since each one is an image the model has to look at. */
export const MAX_FRAMES = 6;
/** In an album, per video: ten clips × six stills is sixty images in one turn. */
export const ALBUM_FRAMES = 2;
/** One still per ~5 s of footage, until the cap. */
export const FRAME_EVERY_SEC = 5;

/**
 * Pure: when to take the stills, in seconds.
 *
 * Telegram sends `duration` with every video, so nothing here needs `ffprobe`.
 * Each instant sits in the MIDDLE of its slice rather than at its start: the
 * first frame of a clip is routinely black (a fade-in, a camera still opening),
 * and a black still is a frame budget spent on nothing.
 *
 * An unknown duration is the one case that takes `0` — with no length there is
 * nothing to place a frame against, and one still from the start beats none.
 */
export function frameTimestamps(durationSec: number | undefined, max = MAX_FRAMES): number[] {
  const d = typeof durationSec === "number" && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (!d) return [0];
  const n = Math.max(1, Math.min(max, Math.ceil(d / FRAME_EVERY_SEC)));
  const slice = d / n;
  return Array.from({ length: n }, (_, i) => Math.round((i + 0.5) * slice * 100) / 100);
}

/** Pure: `0:07`, `1:05`, `12:03` — the way a player shows a position. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Pure: does ffmpeg's own stream listing mention an audio track?
 *
 * Read rather than guessed, per invariant 27. A silent screen recording and a
 * conversion that failed must not produce the same notice: one is a fact about
 * the clip, the other is a bug to report.
 */
export function hasAudioStream(ffmpegStderr: string): boolean {
  return /^\s*Stream #\d+:\d+.*:\s*Audio:/m.test(ffmpegStderr);
}

/** One extracted still: the file, and where in the clip it was taken. */
export interface VideoFrame {
  path: string;
  atSec: number;
}

/** Why no still could be produced — shown to the user, so it names the cause. */
export type FramesOutcome =
  | { ok: true; frames: VideoFrame[] }
  | { ok: false; reason: string };

/**
 * Extract stills next to the video, one ffmpeg call per instant.
 *
 * `-ss` BEFORE `-i` so the seek is the fast one (it jumps instead of decoding
 * everything up to that point); `-frames:v 1` so each call writes exactly one
 * image. Capped at 1280px wide: the model reads a 1280px screenshot fine and a
 * phone's 4K frame is four times the pixels for nothing.
 */
export async function extractFrames(
  src: string,
  times: number[],
  notify?: (line: string) => void,
): Promise<FramesOutcome> {
  const st = await ensureFfmpeg(notify);
  if (st.kind !== "ready") return { ok: false, reason: st.reason };
  const dir = path.dirname(src);
  const base = path.basename(src).replace(/\.[^.]+$/, "");
  const frames: VideoFrame[] = [];
  for (let i = 0; i < times.length; i++) {
    const out = path.join(dir, `${base}-f${i + 1}.jpg`);
    try {
      await run(
        st.ffmpeg,
        ["-nostdin", "-y", "-ss", String(times[i]), "-i", src, "-frames:v", "1",
          // The comma inside min() is escaped: unescaped it would split the
          // filtergraph in two and ffmpeg would refuse the whole thing.
          "-vf", "scale=min(1280\\,iw):-2", "-q:v", "4", out],
        { timeout: 30_000 },
      );
      // A seek past a truncated stream exits 0 and writes nothing, so the file
      // is what proves the frame exists — not the exit code.
      if (fs.existsSync(out) && fs.statSync(out).size > 0) frames.push({ path: out, atSec: times[i] });
    } catch {
      // One unreadable instant must not lose the frames that did come out.
    }
  }
  return frames.length ? { ok: true, frames } : { ok: false, reason: "ffmpeg produced no still" };
}

/**
 * Pure: the clip's length, off ffmpeg's `Duration: 00:00:18.43` line.
 *
 * Telegram usually tells us, but not always — a video sent AS A FILE arrives as
 * a `document` with no duration at all, and without this it would get a single
 * still from the first frame instead of a storyboard.
 */
export function parseDurationSec(ffmpegStderr: string): number | undefined {
  const m = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(ffmpegStderr);
  if (!m) return undefined;
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(sec) && sec > 0 ? sec : undefined;
}

/**
 * What ffmpeg can tell us about a file without decoding it.
 *
 * `audio: null` means we could not look (no static ffmpeg for this platform),
 * which is NOT the same answer as "it is silent" — invariant 27 again: only
 * what was observed gets asserted.
 */
export async function probeVideo(src: string): Promise<{ audio: boolean | null; durationSec?: number }> {
  const st = await ensureFfmpeg();
  if (st.kind !== "ready") return { audio: null };
  const read = (err: string) => ({ audio: hasAudioStream(err), durationSec: parseDurationSec(err) });
  try {
    // No output file, so ffmpeg prints the stream listing and exits non-zero —
    // the listing is the point, the exit code is noise here.
    const { stderr } = await run(st.ffmpeg, ["-hide_banner", "-nostdin", "-i", src], { timeout: 30_000 });
    return read(stderr);
  } catch (e: any) {
    const err = typeof e?.stderr === "string" ? e.stderr : "";
    return err ? read(err) : { audio: null };
  }
}

/**
 * How long a clip may be before its sound is left unheard.
 *
 * whisper runs at roughly 1.4x realtime on the default model and the agent's
 * turn cannot start until the prompt is sent, so a ten-minute clip would hold
 * the conversation for a quarter of an hour. Past the ceiling the prompt SAYS
 * the audio was not listened to, which is what lets the agent offer to do it
 * instead of assuming silence.
 */
export const TRANSCRIBE_MAX_SEC = 120;

/** Everything the bridge could learn about a clip. `trouble` is for the USER
 *  (a Telegram notice), the rest goes into the agent's prompt. */
export interface VideoLook {
  durationSec?: number;
  frames?: VideoFrame[];
  transcript?: string;
  audioNote?: string;
  trouble?: string;
}

/**
 * Look at a downloaded video: stills always, speech when it is worth the wait.
 *
 * The audio track is PROBED rather than assumed. A silent clip then says
 * nothing at all (there is nothing to report), while audio we chose not to
 * transcribe, or failed to, is named in the prompt — an agent told nothing
 * about the sound concludes there was none.
 */
export async function lookAtVideo(
  src: string,
  opts: { durationSec?: number; maxFrames?: number; transcribe?: boolean; notify?: (line: string) => void } = {},
): Promise<VideoLook> {
  const probed = await probeVideo(src);
  const durationSec = opts.durationSec ?? probed.durationSec;
  const shot = await extractFrames(src, frameTimestamps(durationSec, opts.maxFrames ?? MAX_FRAMES), opts.notify);
  const look: VideoLook = { ...(durationSec ? { durationSec } : {}), ...(shot.ok ? { frames: shot.frames } : {}) };
  if (!shot.ok) {
    look.trouble = `🎬 I could not pull any still out of that video (${shot.reason}) — the agent has the file itself.`;
  }
  if (probed.audio === null) {
    // We could not even look, which is not the same as "it is silent".
    look.audioNote = "the audio track was not examined (no ffmpeg available here).";
    return look;
  }
  if (!probed.audio) return look; // genuinely silent: nothing to say
  if (opts.transcribe === false) {
    look.audioNote = "this clip has sound, left untranscribed because several arrived at once — say so if it matters.";
    return look;
  }
  if (durationSec && durationSec > TRANSCRIBE_MAX_SEC) {
    look.audioNote = `this clip has sound, not transcribed because it runs ${clock(durationSec)} (ceiling ${clock(TRANSCRIBE_MAX_SEC)}) — ask and it can be.`;
    return look;
  }
  const out = await transcribe(src, opts.notify);
  if (out.ok) look.transcript = out.text;
  else if (out.kind === "empty") look.audioNote = "it has an audio track, but no speech was recognised in it.";
  else look.audioNote = "it has an audio track, which could not be transcribed here.";
  return look;
}

import assert from "node:assert/strict";
import test from "node:test";

import { frameTimestamps, clock, hasAudioStream, parseDurationSec, MAX_FRAMES, ALBUM_FRAMES } from "../src/video.js";

/**
 * A Telegram video used to be dropped before it reached any binding. These
 * cover the planning half of the fix — what gets extracted, and what ffmpeg's
 * own output says about the clip. The extraction itself needs a real ffmpeg and
 * a real file, so it is verified by running it, not here.
 */

test("frameTimestamps: an unknown duration still yields one still", () => {
  // A video sent AS A FILE carries no duration. One frame from the start beats
  // none at all — and it is the only case allowed to sit at 0.
  assert.deepEqual(frameTimestamps(undefined), [0]);
  assert.deepEqual(frameTimestamps(0), [0]);
  assert.deepEqual(frameTimestamps(-4), [0]);
  assert.deepEqual(frameTimestamps(Number.NaN), [0]);
});

test("frameTimestamps: a short clip gets one still, taken mid-clip", () => {
  // Never the first frame: a fade-in or an opening shutter makes it black, and
  // a black still is the whole budget of a 2-second clip spent on nothing.
  assert.deepEqual(frameTimestamps(2), [1]);
});

test("frameTimestamps: one still per ~5 s, each in the middle of its slice", () => {
  assert.deepEqual(frameTimestamps(18), [2.25, 6.75, 11.25, 15.75]);
});

test("frameTimestamps: capped, and the cap is a budget the caller can lower", () => {
  assert.equal(frameTimestamps(600).length, MAX_FRAMES);
  // An album: ten clips at six stills each would be sixty images in one turn.
  assert.equal(frameTimestamps(600, ALBUM_FRAMES).length, ALBUM_FRAMES);
});

test("frameTimestamps: every instant is inside the clip and in order", () => {
  for (const d of [1, 3, 7, 11, 60, 125, 3600]) {
    const t = frameTimestamps(d);
    assert.ok(t.length >= 1);
    assert.ok(t[0] > 0, `first still of a ${d}s clip must not be frame zero`);
    assert.ok(t[t.length - 1] < d, `last still of a ${d}s clip must be inside it`);
    for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
  }
});

test("clock: a position the way a player shows it", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(7.4), "0:07");
  assert.equal(clock(65), "1:05");
  assert.equal(clock(723), "12:03");
});

// Real `ffmpeg -i` output, which is what the probe actually parses.
const WITH_AUDIO = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/media/AQAD.mp4':
  Metadata:
    major_brand     : isom
  Duration: 00:00:18.43, start: 0.000000, bitrate: 1829 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1280x720, 1745 kb/s, 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)
At least one output file must be specified`;

const SILENT = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/media/BQAD.mp4':
  Duration: 00:01:04.10, start: 0.000000, bitrate: 912 kb/s
  Stream #0:0[0x1](und): Video: h264 (Main), yuv420p, 886x1920, 30 fps
At least one output file must be specified`;

test("hasAudioStream: an audio track is READ, not guessed", () => {
  // The distinction is load-bearing: a silent screen recording must not produce
  // the same notice as a conversion that broke.
  assert.equal(hasAudioStream(WITH_AUDIO), true);
  assert.equal(hasAudioStream(SILENT), false);
  assert.equal(hasAudioStream(""), false);
});

test("parseDurationSec: the length ffmpeg reports, for a clip Telegram did not size", () => {
  assert.equal(parseDurationSec(WITH_AUDIO), 18.43);
  assert.equal(parseDurationSec(SILENT), 64.1);
  assert.equal(parseDurationSec("ffmpeg: No such file or directory"), undefined);
  // A stream of unknown length must not become a zero-second clip.
  assert.equal(parseDurationSec("  Duration: 00:00:00.00, start: 0.0"), undefined);
});

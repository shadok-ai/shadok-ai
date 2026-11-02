import assert from "node:assert/strict";
import test from "node:test";
import { isImageFile, isVideoFile, telegramPhotoable, contentTypeFor, fileCard, parseByteRange, toolFiles, sentFilePaths } from "../src/download.js";

test("isImageFile covers what an <img> renders", () => {
  for (const n of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.svg", "g.avif"]) assert.equal(isImageFile(n), true, n);
  for (const n of ["h.pdf", "i.html", "j.txt", "k", "l.zip", "m.mp4"]) assert.equal(isImageFile(n), false, n);
});

test("isVideoFile covers what a <video> renders", () => {
  for (const n of ["a.mp4", "b.M4V", "c.webm", "d.ogv", "e.MOV"]) assert.equal(isVideoFile(n), true, n);
  for (const n of ["f.png", "g.gif", "h.pdf", "i", "j.mp3", "k.avi"]) assert.equal(isVideoFile(n), false, n);
});

test("telegramPhotoable is narrower than isImageFile (svg/gif go as documents)", () => {
  assert.equal(telegramPhotoable("a.png"), true);
  assert.equal(telegramPhotoable("a.jpg"), true);
  assert.equal(telegramPhotoable("a.svg"), false);
  assert.equal(telegramPhotoable("a.gif"), false);
  assert.equal(telegramPhotoable("a.pdf"), false);
});

test("contentTypeFor maps known types, else octet-stream", () => {
  assert.equal(contentTypeFor("x.png"), "image/png");
  assert.equal(contentTypeFor("x.html"), "text/html");
  assert.equal(contentTypeFor("x.svg"), "image/svg+xml");
  assert.equal(contentTypeFor("x.mp4"), "video/mp4");
  assert.equal(contentTypeFor("x.webm"), "video/webm");
  assert.equal(contentTypeFor("x.mov"), "video/quicktime");
  assert.equal(contentTypeFor("x.unknownext"), "application/octet-stream");
});

test("fileCard = {path, basename, image, video}", () => {
  assert.deepEqual(fileCard("/tmp/go1/report.pdf"), { path: "/tmp/go1/report.pdf", name: "report.pdf", image: false, video: false });
  assert.deepEqual(fileCard("/a/b/chart.png"), { path: "/a/b/chart.png", name: "chart.png", image: true, video: false });
  assert.deepEqual(fileCard("/a/b/clip.mp4"), { path: "/a/b/clip.mp4", name: "clip.mp4", image: false, video: true });
});

test("parseByteRange handles the forms a <video> sends", () => {
  // no header / blank unit → whole file (200)
  assert.equal(parseByteRange(undefined, 100), null);
  assert.equal(parseByteRange("bytes=-", 100), null);
  assert.equal(parseByteRange("chunks=0-10", 100), null);
  // explicit start-end, inclusive
  assert.deepEqual(parseByteRange("bytes=0-499", 1000), { start: 0, end: 499 });
  // open-ended → to the last byte
  assert.deepEqual(parseByteRange("bytes=500-", 1000), { start: 500, end: 999 });
  // clamp an end past EOF
  assert.deepEqual(parseByteRange("bytes=900-5000", 1000), { start: 900, end: 999 });
  // suffix: the last N bytes
  assert.deepEqual(parseByteRange("bytes=-200", 1000), { start: 800, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-5000", 1000), { start: 0, end: 999 });
  // out of bounds → unsatisfiable (416)
  assert.equal(parseByteRange("bytes=1000-1001", 1000), "unsatisfiable");
  assert.equal(parseByteRange("bytes=-0", 1000), "unsatisfiable");
  // a zero-size file has no satisfiable range
  assert.equal(parseByteRange("bytes=0-0", 0), null);
});

test("toolFiles only returns paths for SendUserFile", () => {
  assert.deepEqual(toolFiles("SendUserFile", { files: ["/a", "/b"] }), ["/a", "/b"]);
  assert.deepEqual(toolFiles("SendUserFile", { files: ["/a", 3, ""] }), ["/a"]);
  assert.deepEqual(toolFiles("Read", { file_path: "/a" }), []);
  assert.deepEqual(toolFiles("SendUserFile", {}), []);
});

test("sentFilePaths scans a real transcript (tool_use + attachments)", () => {
  // Two real lines captured from a live session's .jsonl.
  const toolUse = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "SendUserFile", input: { files: ["/tmp/go1/un-seul-branchement-standalone.html"], status: "normal" } },
    ] },
  });
  const toolResult = JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ tool_use_id: "t1", type: "tool_result", content: "1 file delivered to user." }] },
    toolUseResult: { attachments: [{ path: "/tmp/go1/un-seul-branchement-standalone.html", size: 15900, media_type: "text/html", file_uuid: "abc" }] },
  });
  const noise = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "SendUserFile is a tool" }] } });
  const set = sentFilePaths([noise, toolUse, toolResult].join("\n"));
  assert.deepEqual([...set], ["/tmp/go1/un-seul-branchement-standalone.html"]);
});

test("sentFilePaths ignores an arbitrary path never sent (no traversal)", () => {
  assert.equal(sentFilePaths("").size, 0);
  assert.equal(sentFilePaths("just prose mentioning /etc/passwd").size, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { isImageFile, telegramPhotoable, contentTypeFor, fileCard, toolFiles, sentFilePaths } from "../src/download.js";

test("isImageFile covers what an <img> renders", () => {
  for (const n of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.svg", "g.avif"]) assert.equal(isImageFile(n), true, n);
  for (const n of ["h.pdf", "i.html", "j.txt", "k", "l.zip"]) assert.equal(isImageFile(n), false, n);
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
  assert.equal(contentTypeFor("x.unknownext"), "application/octet-stream");
});

test("fileCard = {path, basename, image}", () => {
  assert.deepEqual(fileCard("/tmp/go1/report.pdf"), { path: "/tmp/go1/report.pdf", name: "report.pdf", image: false });
  assert.deepEqual(fileCard("/a/b/chart.png"), { path: "/a/b/chart.png", name: "chart.png", image: true });
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

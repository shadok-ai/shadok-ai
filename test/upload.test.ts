import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error — pure ESM module loaded by the browser too, no types.
import { uploadFailure } from "../public/upload.js";

// A paste/drag upload POSTs the file to /paste and reads r.json(). But a reverse
// proxy rejects an oversized body with its OWN error page (413 text/html) that
// never reaches our JSON route — so r.json() threw `Unexpected token '<',
// "<html>… is not valid JSON`, and the composer showed THAT instead of "too
// large". Decide from the status + content-type BEFORE parsing.

test("uploadFailure: a JSON response is left for the caller to parse", () => {
  // Our server always answers JSON — success OR {error} — so return null and let
  // the existing r.json()/j.line path handle both.
  assert.equal(uploadFailure(200, "application/json"), null);
  assert.equal(uploadFailure(400, "application/json; charset=utf-8"), null);
  assert.equal(uploadFailure(500, "application/json"), null);
});

test("uploadFailure: a proxy 413 (html) becomes a clear \"too large\"", () => {
  const msg = uploadFailure(413, "text/html");
  assert.ok(msg && /too large/i.test(msg), msg ?? "null");
});

test("uploadFailure: any other non-JSON response names the status, never parses html", () => {
  const msg = uploadFailure(502, "text/html");
  assert.ok(msg && /502/.test(msg), msg ?? "null");
  // A missing content-type is still not JSON.
  assert.ok(uploadFailure(504, "") !== null);
});

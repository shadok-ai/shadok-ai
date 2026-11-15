import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";

const DIR = new URL("../context/instance-context-skill/", import.meta.url);

test("SKILL.md carries the once-only rule, the suggest rule and the language", () => {
  const md = fs.readFileSync(new URL("SKILL.md", DIR), "utf8");
  assert.match(md, /^---\nname: shadok-instance-context\n/);
  assert.match(md, /\bonce\b/i);
  assert.match(md, /suggest/i);
  assert.match(md, /language/i);
  assert.match(md, /--stdin/);
});

test("write.mjs sends stdin with the session key to /instance-context/first", async () => {
  let got: { url?: string; method?: string; key?: string; body?: string } = {};
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      got = { url: req.url, method: req.method, key: String(req.headers["x-shadok-session-key"]), body: b };
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const text = "Side projects with friends.\nLanguage: French; deliverables in English.";
  const code = await new Promise<number>((resolve) => {
    const p = spawn(process.execPath, [new URL("scripts/write.mjs", DIR).pathname, "--stdin"], {
      env: { ...process.env, SHADOK_PORT: String(port), SHADOK_SESSION_KEY: "id.mac" },
      stdio: ["pipe", "ignore", "ignore"],
    });
    p.stdin.end(text);
    p.on("exit", (c) => resolve(c ?? 1));
  });
  srv.close();
  assert.equal(code, 0);
  assert.equal(got.url, "/instance-context/first");
  assert.equal(got.method, "PUT");
  assert.equal(got.key, "id.mac");
  assert.deepEqual(JSON.parse(got.body!), { text });
});

test("write.mjs refuses text on the command line", async () => {
  const code = await new Promise<number>((resolve) => {
    const p = spawn(process.execPath, [new URL("scripts/write.mjs", DIR).pathname, "some text"], {
      env: { ...process.env, SHADOK_PORT: "1", SHADOK_SESSION_KEY: "k" }, stdio: "ignore",
    });
    p.on("exit", (c) => resolve(c ?? 0));
  });
  assert.notEqual(code, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "context", "secrets-skill", "scripts", "secret.py");

/** A stand-in for the cockpit: records what the script sent, answers `status`. */
function fakeServer(status: number, body: unknown) {
  const seen: { body?: any; cookie?: string } = {};
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.body = raw ? JSON.parse(raw) : null;
      seen.cookie = req.headers.cookie;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return { server, seen };
}

/** Runs secret.py against `port`, feeding `stdin`. Never puts a value in argv. */
function run(args: string[], port: number, stdin: string) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = execFile(
      "python3",
      [SCRIPT, ...args],
      { env: { ...process.env, SHADOK_PORT: String(port), SHADOK_AUTH: "sk_auth=tok" } },
      (e, out, err) => resolve({ code: e ? ((e as any).code ?? 1) : 0, out, err }),
    );
    child.stdin!.end(stdin);
  });
}

async function listening(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as any).port;
}

test("set reads the value from stdin and sends it in the body", async () => {
  const { server, seen } = fakeServer(200, { names: ["A"], result: "created" });
  const port = await listening(server);
  const res = await run(["set", "A", "--stdin"], port, "s3cr3t\n");
  server.close();
  assert.equal(res.code, 0);
  assert.deepEqual(seen.body, { name: "A", value: "s3cr3t" });
  assert.equal(seen.cookie, "sk_auth=tok");
  // The value must never be echoed back — the reply lands in the transcript.
  assert.doesNotMatch(res.out, /s3cr3t/);
  // And the user has to be told the secret is inert until attached.
  assert.match(res.out, /profile/i);
});

test("set requires --stdin, so a value can never be passed in argv", async () => {
  const { server } = fakeServer(200, {});
  const port = await listening(server);
  const res = await run(["set", "A"], port, "");
  server.close();
  assert.notEqual(res.code, 0);
  assert.match(res.err, /--stdin/);
});

test("an existing name is refused, and the script does not retry", async () => {
  const { server } = fakeServer(409, { error: "exists", name: "A" });
  const port = await listening(server);
  const res = await run(["set", "A", "--stdin"], port, "v");
  server.close();
  assert.notEqual(res.code, 0);
  assert.match(res.err, /already exists/i);
});

test("empty stdin is refused before anything is sent", async () => {
  const { server, seen } = fakeServer(200, {});
  const port = await listening(server);
  const res = await run(["set", "A", "--stdin"], port, "   \n");
  server.close();
  assert.notEqual(res.code, 0);
  assert.equal(seen.body, undefined);
});

#!/usr/bin/env node
// shadok-reload: respawn MY OWN agent session so it picks up a changed pilot
// prompt or newly-seeded skills. Scoped by the per-session key (SHADOK_SESSION_KEY)
// so an agent can only reload itself — the public session id proves nothing.
import http from "node:http";

const key = process.env.SHADOK_SESSION_KEY;
const port = process.env.SHADOK_PORT || "3789";
const cookie = process.env.SHADOK_AUTH; // "sk_auth=…" when a GUI password is set

if (!key) {
  console.error("SHADOK_SESSION_KEY is not set — not running under the shadok-ai cockpit?");
  process.exit(1);
}

const body = JSON.stringify({ key });
const req = http.request(
  {
    host: "127.0.0.1",
    port,
    path: "/reload",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      ...(cookie ? { cookie } : {}),
      // The key authenticates too, and unlike the cookie it cannot age out —
      // which matters most here: an expired cookie left the agent unable to
      // reach the one endpoint that would have repaired it.
      "x-shadok-session-key": key,
    },
  },
  (r) => {
    let d = "";
    r.on("data", (c) => (d += c));
    r.on("end", () => {
      // The server restarts THIS process right after replying, so we may be torn
      // down before printing — that's expected; the reload is what we asked for.
      console.log(d || `HTTP ${r.statusCode}`);
      process.exit(r.statusCode && r.statusCode < 400 ? 0 : 1);
    });
  },
);
req.on("error", (e) => {
  console.error("reload failed:", e.message);
  process.exit(1);
});
req.write(body);
req.end();

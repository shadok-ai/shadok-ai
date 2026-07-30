// Diagnostic tool: logs the raw terminal sequences exchanged with the
// claude TUI, then tests a few keystrokes. Useful when a CLI update breaks
// the detection heuristics.
//   node debug/probe.mjs [cwd]
import pty from "node-pty";
import xterm from "@xterm/headless";

const { Terminal } = xterm;
const cwd = process.argv[2] ?? process.cwd();

const term = new Terminal({ cols: 100, rows: 40, scrollback: 5000, allowProposedApi: true });

const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue;
  if (/^(CLAUDE|CLAUDECODE|AI_AGENT)/.test(k)) continue;
  env[k] = v;
}

const proc = pty.spawn("claude", [], {
  name: "xterm-256color",
  cols: 100,
  rows: 40,
  cwd,
  env,
});

const esc = (s) => JSON.stringify(s).slice(1, -1);

proc.onData((d) => {
  term.write(d);
  // Only log short control sequences (likely queries).
  if (d.length < 80) console.error(`APP→TERM: ${esc(d)}`);
});
term.onData((d) => {
  console.error(`TERM→APP (response): ${esc(d)}`);
  proc.write(d);
});
proc.onExit(({ exitCode }) => {
  console.error(`EXIT ${exitCode}`);
  process.exit(0);
});

const screen = () => {
  const buf = term.buffer.active;
  const lines = [];
  const start = Math.max(0, buf.length - term.rows);
  for (let i = start; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n");
};

// After 8s: send keystrokes one by one.
setTimeout(() => {
  console.error("=== sending 'h' then 'i' one at a time ===");
  proc.write("h");
  setTimeout(() => proc.write("i"), 400);
  setTimeout(() => {
    const s = screen();
    const promptLine = s.split("\n").filter((l) => l.includes("❯"));
    console.error("=== prompt line after keystrokes:", JSON.stringify(promptLine));
    console.error("=== testing shift+tab (cycles the mode) ===");
    proc.write("\x1b[Z");
  }, 1500);
  setTimeout(() => {
    const s = screen();
    const status = s.split("\n").slice(-3).join(" | ");
    console.error("=== status after shift+tab:", JSON.stringify(status));
    console.error("=== full screen ===");
    console.log(screen());
    proc.kill();
    process.exit(0);
  }, 4000);
}, 8000);

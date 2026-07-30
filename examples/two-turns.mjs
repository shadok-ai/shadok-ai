// Example: two conversation turns in the same TUI session.
//   node examples/two-turns.mjs [cwd]
import { PtyPilot } from "../dist/session.js";

const cwd = process.argv[2] ?? process.cwd();
const pilot = new PtyPilot({ cwd });

pilot.start();
await pilot.waitForIdle({ stableMs: 1200, timeoutMs: 60_000 });

console.log("— turn 1 —");
await pilot.submit("Reply with exactly: ONE");
await pilot.waitForIdle({ stableMs: 2000, timeoutMs: 180_000 });
console.log(pilot.screen().split("\n").filter((l) => l.startsWith("⏺")).join("\n"));

console.log("— turn 2 —");
await pilot.submit("Reply with exactly: TWO");
await pilot.waitForIdle({ stableMs: 2000, timeoutMs: 180_000 });
console.log(pilot.screen().split("\n").filter((l) => l.startsWith("⏺")).join("\n"));

await pilot.stop();
console.log("— session ended —");
process.exit(0);

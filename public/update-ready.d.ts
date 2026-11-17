// `update-ready.js` is plain JS: the browser loads it as is (no client-side
// build). The server imports it too — the Claude Code auto-install reads the same
// footer (src/claude-auto-update.ts) — hence this types file, which keeps ONE
// single implementation.

/** Claude Code's update footer on a rendered TUI screen. */
export function claudeUpdateState(screen: string): "restart" | "failed" | null;

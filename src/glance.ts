/**
 * A channel row's at-a-glance data — when it last spoke and how full its
 * context is — read from the END of its transcript, without resuming the agent.
 *
 * Why it exists: on a page load every row stayed blank (no "3m ago", no %)
 * until its own WebSocket resume finished, and a resume of a reclaimed agent
 * spawns `claude` and replays the WHOLE transcript. With a dozen agents the
 * column filled in one late burst. These two facts sit in the last few lines
 * of the `.jsonl`, so one cheap read per channel paints every row at once and
 * the resume replaces them with the authoritative values when it lands.
 *
 * Read-only and bounded: only the last `TAIL_BYTES` are read, async, so a huge
 * transcript costs the same as a small one and never blocks the event loop.
 */
import fs from "node:fs/promises";
import { parseTimestamp, parseUsage, type TokenUsage } from "./tail.js";
import { userPromptText } from "./prompt-kind.js";

/** Enough for the last exchange of any realistic session (one assistant line
 *  with a big tool result is the worst case). Past this we just find nothing. */
export const TAIL_BYTES = 256 * 1024;

export interface Glance {
  /** The last message a human sees in the chat (prompt or answer text), ms. */
  lastAt: number | null;
  /** The last assistant message's usage — the context fill's input. */
  usage: TokenUsage | null;
}

function hasText(e: any): boolean {
  const c = e?.message?.content;
  if (typeof c === "string") return !!c.trim();
  return Array.isArray(c) && c.some((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.trim());
}

/**
 * Pure: scan a transcript's tail backwards. The first line may be cut in half
 * by the byte window — it fails to parse and is skipped like any bad line.
 */
export function glanceFromTail(text: string): Glance {
  let lastAt: number | null = null;
  let usage: TokenUsage | null = null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && (lastAt === null || usage === null); i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "assistant") {
      if (usage === null) usage = parseUsage(e.message);
      if (lastAt === null && hasText(e)) lastAt = parseTimestamp(e.timestamp);
    } else if (lastAt === null && userPromptText(e) !== null) {
      lastAt = parseTimestamp(e.timestamp);
    }
  }
  return { lastAt, usage };
}

/** Reads the last `TAIL_BYTES` of `file` and glances at them. Missing file → empty. */
export async function glanceFile(file: string): Promise<Glance> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(file, "r");
    const { size } = await fh.stat();
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return glanceFromTail(buf.toString("utf8"));
  } catch {
    return { lastAt: null, usage: null };
  } finally {
    await fh?.close().catch(() => {});
  }
}

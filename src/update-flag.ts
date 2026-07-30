import fs from "node:fs";
import path from "node:path";
import { SHADOK_DIR } from "./config.js";

/**
 * The one-shot handshake between the supervisor (which performs an update) and
 * the freshly-spawned server (which announces the outcome to the board group).
 * Written by the supervisor after `/update`, read+deleted once on server boot.
 */
export interface UpdateResult {
  ok: boolean;
  version?: string;
  error?: string;
}

const RESULT_FILE = path.join(SHADOK_DIR, ".update-result");

export function writeUpdateResult(r: UpdateResult): void {
  try {
    fs.mkdirSync(SHADOK_DIR, { recursive: true });
    fs.writeFileSync(RESULT_FILE, JSON.stringify(r));
  } catch {
    // Non-fatal: worst case the update just isn't announced.
  }
}

/** Read the pending update result, deleting it so it announces exactly once. */
export function readAndClearUpdateResult(): UpdateResult | null {
  let raw: string;
  try {
    raw = fs.readFileSync(RESULT_FILE, "utf8");
  } catch {
    return null;
  }
  try {
    fs.rmSync(RESULT_FILE, { force: true });
  } catch {
    /* ignore */
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

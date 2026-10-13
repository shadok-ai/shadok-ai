// Types for the skill's pure core, so the SERVER can import the one source of
// the ledger's logic instead of growing a second copy of it (CLAUDE.md: this
// file is the single source, no duplication to drift). The core itself stays
// plain .mjs — it is copied verbatim into ~/.claude/skills/ at every boot and
// must run with no build step of its own.
export interface LedgerCoreRow {
  id?: string;
  entity: string;
  status: string;
  kind?: string;
  note?: string;
  source?: string;
  updatedAt?: number;
  verifiedAt?: number;
}
export type LedgerKind = "task" | "fact" | "decision";
export const KINDS: LedgerKind[];
export function normEntity(s: unknown): string;
export function normKind(k: unknown): LedgerKind | null;
export function rowKind(entry: unknown): LedgerKind;
export function resolveId<T extends LedgerCoreRow>(entries: T[], idOrPrefix: unknown): T | null;
export function upsertEntry<T extends LedgerCoreRow>(
  entries: T[],
  patch: Partial<LedgerCoreRow> & { verified?: boolean },
  now: number,
  newId?: string,
): T[];
export function tokenize(s: unknown): string[];
export function searchEntries<T extends LedgerCoreRow>(
  entries: T[],
  query: string,
  opts?: { strong?: number; weak?: number },
): { strong: T[]; weak: T[] };
export function ageDays(entry: { updatedAt?: number; verifiedAt?: number }, now: number): number;

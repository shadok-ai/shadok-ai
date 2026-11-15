/**
 * Claude Code's `--append-system-prompt <prompt>` takes ONE value. Given the
 * flag several times, the model sees only the LAST one — measured on 2.1.319:
 * three flags carrying three codewords, and the model reported only the third.
 *
 * shadok appended four separate blocks at spawn — the profile's role, the
 * environment note, the pilot prompt and the ledger reflex — so with the ledger
 * on, every agent silently kept the ledger reflex alone: no role, no cockpit
 * context. Nothing errors and nothing shows; the agent just behaves as if it had
 * never been told. This collapses them into ONE flag, in their order, at the
 * position of the first, joined by a blank line. Pure, tested.
 */
const FLAG = "--append-system-prompt";

export function mergeAppendedPrompts(args: readonly string[]): string[] {
  const out: string[] = [];
  const values: string[] = [];
  let at = -1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === FLAG && i + 1 < args.length) {
      if (at < 0) {
        at = out.length;
        out.push(FLAG, "");
      }
      values.push(args[i + 1]);
      i++; // the value is consumed whatever it looks like
      continue;
    }
    out.push(args[i]);
  }
  if (at >= 0) out[at + 1] = values.join("\n\n");
  return out;
}

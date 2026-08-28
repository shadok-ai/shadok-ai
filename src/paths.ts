/**
 * The launch directory, encoded as a filename.
 *
 * Channels, crons and the instance lock each key their store on this same
 * expression, inlined in four different files. Anything NEW that is per
 * instance uses this one instead of adding a fifth copy — a store that keyed on
 * a slightly different string would silently belong to another instance.
 *
 * The six existing sites are deliberately left alone: rewriting them would bury
 * the change that needed this.
 */
export function instanceKey(cwd: string = process.cwd()): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

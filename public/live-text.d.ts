// `live-text.js` is plain JS: the browser loads it as is (no client-side
// build). The server imports it too — to attach a dialog's preface, see
// docs/superpowers/specs/2026-07-28-telegram-dialog-preface-design.md — hence
// this types file, which keeps ONE single implementation.

/** The last assistant text block visible on screen, unwrapped; "" otherwise. */
export function extractLiveText(screen: string): string;

// The entry of the on-demand WhatsApp library directory (src/wa-library.ts).
//
// Copied beside package.json and npm-shrinkwrap.json into
// ~/.shadok-ai/whatsapp-lib/<fingerprint>/, where `npm ci` installs the tree.
// A dynamic import() resolves from the module that makes it, so importing the
// packages HERE resolves them from that directory's node_modules — never from
// the app's own, which the auto-update rewrites and which no longer carries them.
const ALLOWED = new Set(["baileys", "qrcode"]);

export function load(name) {
  if (!ALLOWED.has(name)) return Promise.reject(new Error(`not a package of this directory: ${name}`));
  return import(name);
}

export interface Args {
  port?: number;
  noTelegram: boolean;
  /** Skip opening the browser on the first launch. */
  noOpen: boolean;
  help: boolean;
  version: boolean;
  /** GUI password to require (also settable via SHADOK_GUI_PASSWORD). */
  password?: string;
}

/** Parse the CLI flags. Unknown flags are ignored (forward-compatible). */
export function parseArgs(argv: string[]): Args {
  const a: Args = { noTelegram: false, noOpen: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") a.port = Number(argv[++i]);
    else if (arg === "--no-telegram") a.noTelegram = true;
    else if (arg === "--no-open") a.noOpen = true;
    else if (arg === "--password") a.password = argv[++i];
    else if (arg === "--help" || arg === "-h") a.help = true;
    else if (arg === "--version" || arg === "-v") a.version = true;
  }
  return a;
}

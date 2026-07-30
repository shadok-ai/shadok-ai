import readline from "node:readline";

/**
 * First-run prompt for the Telegram bot token. Masked input (the token is a
 * secret — never echoed). Returns the trimmed token, or null if the user just
 * pressed Enter to skip. TTY-only; callers must not invoke it headless.
 */
export function promptToken(): Promise<string | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  // Mask keystrokes: overwrite whatever readline would echo.
  const output = process.stdout;
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
    // Let the prompt text and newlines through; hide the typed characters.
    if (s.includes("\n") || s.startsWith("Telegram")) output.write(s);
  };

  return new Promise((resolve) => {
    rl.question(
      "Telegram bot token? (Enter to skip — you can add it later) ",
      (answer) => {
        rl.close();
        output.write("\n");
        const t = answer.trim();
        resolve(t.length ? t : null);
      },
    );
  });
}

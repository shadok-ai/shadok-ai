# Running an agent's `!` command from the chat — design

**Status:** shipped 2026-09-26.

## The request

An agent regularly asks the human to type a `!` command — *"fais
`! ssh ubuntu@vps1… 'docker exec shadok-ai claude --version'`"* — because it
cannot run it itself. The user wanted a button that "posts it into the CLI", and
then, rightly, a dedicated API rather than a trick on the prompt path.

## Three facts measured on a bench before any code

1. **A `!` sent as a prompt is not shell mode.** shadok prepends a context
   header (`⟦web · time · who⟧`) to every human prompt, so the `!` is no longer
   the first character. The transcript shows the MODEL receiving it as text and
   then choosing to run it through its own Bash tool — a model turn, the
   profile's guardrails and the auto-mode classifier between the click and the
   command, any of which may refuse or rewrite it.
2. **Shell mode is not the Bash tool, so a profile's `deny` does not apply.**
   Under `Shadok-Boss`, whose profile denies `Bash(git commit:*)`, a shell-mode
   `git commit` created the commit; the agent's own reply was *"You ran that one
   yourself"*. That is the escape hatch wanted — and the reason the door is for
   a human only.
3. **Shell mode is visible on screen**: the input line becomes `!` + a
   non-breaking space at column 0, and the footer shows an indented
   `! for shell mode`. `inputText` already read that line.

## Design

- **`run` {command}** on the WebSocket, distinct from `prompt`. Refused unless
  the connection is a same-origin **browser** (decided once at connect, from the
  upgrade headers — never from the frame), refused mid-turn (`busy`), refused
  multi-line (shell mode reads one line; gluing lines would run something the
  human never saw), bounded in length. The server types `!`, **waits** for shell
  mode (never a fixed delay — invariant 3), then reuses the robust `submit`; on
  any failure it presses Escape so no stray `!` turns the next prompt into a
  command.
- **In the chat**, an agent message's `! cmd` — inline code, or a line of its
  own — gets a ▶ button. The click shows the exact command and says it runs
  outside the agent's guardrails. Prose with an exclamation mark never matches.
- **The exchange is content, read from the transcript**: the TUI writes
  `<bash-input>` / `<bash-stdout>` as user messages. The tail streams them
  (`stream-bash`) and `loadHistory` replays them as a `bash` turn, so live and
  reload show the same card — including for a command typed by hand in the
  terminal view, which used to vanish from the chat on reload.

## Found by the browser, not the tests

The live card did not appear on the first real run while the reload showed it.
`parseLine` dropped every message whose content was not an array, and the TUI
writes `<bash-input>` as a plain string — so the tail's bash branch was
unreachable. `loadHistory` has its own reader, which is why the replay worked.
A tail test now pins string content.

## Out of scope

- Telegram (the same `run` message can serve it later).
- Running anything without a click.

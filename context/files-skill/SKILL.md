---
name: shadok-files
description: Hand a file to the person you are talking to — a report, an export, a screenshot, a built artifact. Use whenever your result IS a file. They are in a browser or on Telegram, NOT on this machine, so a local path is a string they cannot open.
---

# shadok-files

The person reading you is in a web cockpit or on Telegram. **They are not on
this machine.** Printing `/workspace/report.pdf` gives them a string they cannot
click, cannot open and cannot save. Hand the file over instead:

```bash
node ~/.claude/skills/shadok-files/scripts/send.mjs /abs/path/report.pdf
node ~/.claude/skills/shadok-files/scripts/send.mjs a.png b.png --caption "before / after"
```

It appears in the chat as a download card — inline if it is an image — and is
uploaded into the Telegram topic when the agent is mirrored.

## When to use it, and when not

**Use it when the file IS the deliverable**: a report you generated, an export,
a screenshot, a diagram, an archive, a built binary.

**Do not use it for a path you are merely citing.** `src/server.ts:412` in a
review is a reference, not a deliverable — attaching the file there is noise.

**Do not publish an artifact instead.** An artifact is a page on claude.ai; the
person asked for a file. Several shipped roles deny the tool outright.

**Do not send the same file again** unless it has meaningfully changed. Each
call renders a card, and a row of cards for one file is noise.

## Paths

Give an **absolute** path. The server's working directory is its launch
directory and never yours, so a relative path would resolve somewhere else —
the script resolves it against your cwd before sending, but being explicit
costs nothing and removes the question.

## If something is missing

If this skill is not installed, or the call fails, **say so plainly and stop**.
Do not invent a replacement convention — a `fichier: /path/to/x` line of your
own making looks like a feature to the person reading it, and is not one. Ask
them to check the cockpit instead.

## Authenticating a direct API call

The command above does this for you. If you call the cockpit's API yourself,
send your session key — it is in your environment and it does not expire:

```bash
curl -sS -X POST -H "content-type: application/json" \
  -H "x-shadok-session-key: $SHADOK_SESSION_KEY" \
  -d '{"paths":["/abs/path/report.pdf"],"caption":"the report"}' \
  "http://127.0.0.1:$SHADOK_PORT/files"
```

`$SHADOK_AUTH` (a cookie) is still accepted elsewhere, but it was frozen into
this process's environment at spawn and expires after a week, so never rely on
it alone. A `401` or `403` means that header is missing — or that you were
started before this existed, in which case nothing you hold can authenticate
any more and only a human can fix it: ask them for *Reload agent* on your ⋯
menu.

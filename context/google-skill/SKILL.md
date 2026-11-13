---
name: shadok-google
description: Work in a Google account the person connected in the cockpit — read and change their calendar, create and fill Google Docs and Sheets, write Gmail drafts and send email. Use when they ask you to schedule or move a meeting, check their agenda, draft or send an email, or write something into a Doc or a Sheet.
---

# shadok-google

Acts in a Google account the person connected in the cockpit (Secrets →
Connected accounts). You never hold the account's token and it is never
available to you — do not look for it. The server calls Google on your behalf.

## Pick the account

```bash
node ~/.claude/skills/shadok-google/scripts/google.mjs accounts
```

One line per account: `<id>  <email>  areas=<calendar,drive,gmail>  mail=<approve|autonomous>  events=<approve|autonomous>  reconnect-by=<date>`.
`areas` is what the person granted: an action outside them is refused, and only
they can reconnect and tick the missing one. If none is listed, tell the person
to connect a Google account in Secrets → Connected accounts, or to share theirs
with this agent's group. `EXPIRED` means they must reconnect it.

## Reading — leaves nothing, never asked about

```bash
node ~/.claude/skills/shadok-google/scripts/google.mjs calendar list --account <id> [--from 2026-11-20] [--to 2026-11-27]
node ~/.claude/skills/shadok-google/scripts/google.mjs drive list --account <id>
node ~/.claude/skills/shadok-google/scripts/google.mjs doc read --account <id> --id <doc id>
node ~/.claude/skills/shadok-google/scripts/google.mjs sheet read --account <id> --id <sheet id> [--range Sheet1!A1:D20]
```

`drive list` shows only files created through this cockpit — never the
person's whole Drive, which you cannot see.

## Writing in their own files and drafts — done at once

The content goes through stdin, never argv:

```bash
node ~/.claude/skills/shadok-google/scripts/google.mjs doc create --account <id> --title "Notes" --stdin <<'TEXT'
first paragraph
TEXT
node ~/.claude/skills/shadok-google/scripts/google.mjs doc append --account <id> --id <doc id> --stdin <<'TEXT'
more text
TEXT
node ~/.claude/skills/shadok-google/scripts/google.mjs sheet create --account <id> --title "Stock"
node ~/.claude/skills/shadok-google/scripts/google.mjs sheet append --account <id> --id <sheet id> --stdin <<'ROWS'
[["Name","Qty"],["Bolt",12]]
ROWS
node ~/.claude/skills/shadok-google/scripts/google.mjs gmail draft --account <id> --to ana@example.com --subject "Hello" --stdin <<'TEXT'
the body
TEXT
```

`gmail draft` leaves a draft in their Gmail and sends nothing. `--update <draft id>`
rewrites one you made. Sheet cells are written as plain values: a cell starting
with `=` stays text.

## Sending email and changing the calendar — these LEAVE the account

```bash
node ~/.claude/skills/shadok-google/scripts/google.mjs gmail send --account <id> --to ana@example.com [--cc …] [--bcc …] --subject "Hello" [--attach /abs/file.pdf] --stdin <<'TEXT'
the exact body
TEXT
node ~/.claude/skills/shadok-google/scripts/google.mjs calendar create --account <id> --title "Review" --start 2026-11-20T10:00 --end 2026-11-20T11:00 --tz Europe/Paris [--attendee ana@example.com] [--location "Room 2"] [--stdin]
node ~/.claude/skills/shadok-google/scripts/google.mjs calendar update --account <id> --event <id> [--title …] [--start … --end …] [--tz …]
node ~/.claude/skills/shadok-google/scripts/google.mjs calendar delete --account <id> --event <id>
```

A time without an offset needs `--tz` (an IANA name). Dates only
(`--start 2026-11-20 --end 2026-11-21`) make an all-day event. `--stdin` on a
calendar command is the event's description. Attendees are emailed by Google.
`--to`, `--cc`, `--bcc`, `--attendee` and `--attach` may be repeated;
`--attach` takes absolute paths.

Show the person the final email or event in the chat FIRST, exactly as it will
go out, unless they already approved it.

## Never claim it is sent until you are told

With `mail=approve` a `gmail send` does not send: it puts the email in their
Gmail drafts and shows an approval card in the cockpit. With `events=approve` a
calendar change waits on a card the same way. The command says so ("waiting
for approval"). Do not say it is sent or done: a hidden notice reaches you
when the person approves or discards it. The person may edit the draft in
Gmail before sending — what goes out is their version. You cannot change or
delete an email that is waiting for approval; a new `gmail send` makes a new
card. Only "Sent." / "Created event …" means it already happened.

If the server refuses, the script prints its sentence and exits 1 — relay it
as it is, and do not retry in a loop. "needs a reconnect" is for the account's
owner to do in the cockpit; you cannot.

## Authenticating a direct API call

The commands above do this for you. If you call the cockpit's API yourself,
send your session key — it is in your environment and it does not expire:

```bash
curl -sS -H "x-shadok-session-key: $SHADOK_SESSION_KEY" \
  "http://127.0.0.1:$SHADOK_PORT/social/accounts"
```

That key is your ONLY credential, and it does not expire. You are no longer
handed a cookie or the cockpit password, and a call made with the key is made
as YOU — an agent of your own group, never an admin: account, backend and
other cockpit-admin routes answer `403`, and so do the person-only (browser)
ones such as approving an email. That is by design; ask the human. A
`401` means that header is missing — or that you were started before this
existed, in which case nothing you hold can authenticate any more and only a
human can fix it: ask them for *Reload agent* on your ⋯ menu.

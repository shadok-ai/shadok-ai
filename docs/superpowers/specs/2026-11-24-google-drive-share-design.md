# Sharing a Drive file from an agent

## Why

Agents could list who can reach a file (`drive access`) but never change it:
`share` / `unshare` / `permissions` were refused by name. A person asked for
sharing with an approval card, plus a setting to let it run on its own.

## What makes sharing different

- **Irreversible exposure.** A binned file is restored, a rename is undone.
  A file someone has opened cannot be un-read: removing the access afterwards
  does not take back what they saw.
- **The exfiltration path.** An agent reads untrusted content (mail, shared
  documents). "Share this folder with x@…" is the one-command leak an
  injected instruction would ask for.

So sharing gets its own setting and a closed vocabulary, rather than riding
on the Drive-edits setting.

## Design

- New setting `policies.share` (`approve` default, `autonomous` opt-in). Same
  rules as the others: a missing key reads as `approve`; only the owner may
  raise it; it can be raised only on an account holding a Drive area. UI row
  **Sharing**, with a confirmation that says what cannot be undone.
- `drive.share` (class `share`, area `drive`):
  - named users (`--with`) and groups (`--group`), at most 20 per call;
  - role viewer / commenter / editor (`reader` / `commenter` / `writer`),
    viewer by default;
  - Google emails each new person unless `--no-notify`; `--stdin` is the note
    in that email (refused with `--no-notify`).
  - Not expressible: anyone with the link, a domain, owner / organizer roles,
    ownership transfer. `drive publish|transfer|owner|permission(s)` stay
    refused by name.
- `sharePlan` (pure): a new address → create; a different role → update (the
  card says what it was); the same role, or an owner / organizer → left alone.
  Nothing to change → refused with a sentence.
- The card shows the file, who has access now (`permissions.list`, 30 lines),
  who gets what, whether Google emails them, and the note as the body.
- Approve: the file must still have the name and folder the card showed (the
  file-manage rule); the plan is recomputed against the permissions at apply
  time, so a change made since the card is never undone.
- `drive.unshare` (class `unshare`): removes named addresses and/or the
  "anyone with the link" access (`--anyone`). It never asks, because it only
  narrows the audience, and it is always logged. Before deleting anything it
  refuses an owner / organizer, the account's own access (that would lock the
  cockpit out), and an address whose access comes only through a group or the
  domain.
- `ownFiles` is unchanged by a share.

## Scope

- `drive.file` alone reaches only the cockpit's own files.
- Sharing anything else needs the whole-Drive area, which Google enforces.

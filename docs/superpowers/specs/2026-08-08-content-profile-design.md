# Shadok-Content — organic content, distinct from paid

Date: 2026-08-08
Status: agreed, implemented

## The question asked

"A content-creation profile, SEO-oriented — or does Shadok-Marketing already
cover the ground?"

## Why it does not

`Shadok-Marketing` is explicitly **paid**: "paid-marketing & growth", "ad copy",
"campaign plans", "conversion-focused". The only overlap is "audience/keyword
research" — and in that context those are keywords to **bid on**.

Editorial SEO is another job: search intent, a cluster around a primary query, Hn
structure, title/meta, internal linking. And above all a different deliverable:
an **article**, not a campaign.

Widening `Shadok-Marketing` to cover both would give one bloated profile whose
prompt tries to be an ad copywriter and an SEO editor at once — bad at both ends.
And the boss, which picks a role at the moment of delegating, would no longer
have a clean boundary. Hence two sibling profiles: **Marketing buys the audience,
Content earns it**, and each prompt names the other so the boundary is legible
from the inside.

## The profile

Inserted after `Shadok-Marketing` — they are siblings, they read together.

- `deny: READONLY_DENY`, like Marketing and Support.
- `secrets: []`, no forced `model` — consistent with the others; the user
  attaches what they want from the Profiles panel.

The prompt fits in five blocks: start from the product and not from the keyword;
work the intent (who is searching, what they already know, what they must be able
to do next); deliver a Markdown file with front matter; what it is allowed to do;
and the ban on filler.

### The trap fixed: read-only ≠ write nothing

`READONLY_DENY` blocks **git** writes only, never `Write`/`Edit`. But
`Shadok-Marketing`'s wording — "You have READ-ONLY access to the code — git
writes are blocked, never modify or commit it" — is enough to make an agent
refuse to create any file at all. For a profile whose **deliverable is a file**,
that would be fatal. So the prompt says explicitly: *You MAY write and edit
files: your drafts are the deliverable*; what is forbidden is touching the
product's code, and git stays blocked so the review stays human.

### Secrets, without hardcoding them

One conditional sentence: if Search Console / analytics credentials are available
**as environment variables**, use them to choose topics from real queries rather
than by guesswork. Nothing is hardcoded — the profile is global and reusable on
any repo, and it is `envVarsNote` that dynamically announces what is actually
injected.

## The boss must know the new role

`Shadok-Boss` enumerates the delegable roles; without an update it would never
have delegated to `Shadok-Content`. The line becomes: dev for code, Marketing for
paid acquisition and ad copy, Content for articles and organic work, Support for
user-facing answers. A test locks down that every role the boss names does exist
in `DEFAULT_PROFILES`.

## Delivery

`seedDefaultProfiles` only seeds when the file is empty: so the profile is also
created in the running vault through `PUT /profiles`, and the boss's prompt is
refreshed there. Checked beforehand that the running boss had **no**
customisation (a prompt identical to the code's, no secret or model attached) —
otherwise it would have needed asking before overwriting.

## Tests

- `profiles.test.ts`: Content is read-only; its prompt says it **may** write
  files, that git is blocked, names the boundary with Marketing, and describes the
  deliverable (Markdown + front matter). The boss names the four roles, and each
  one exists.
- In the browser: the card appears between Marketing and Support, blurb "the
  organic-content & SEO agent.", badge `🔒 read-only`, and the new agent's default
  name follows the card (`Shadok-Content`). Zero console errors.

# Update channels: alpha and beta — design

**Date:** 2026-08-23
**Goal:** let one instance follow every merge while another only moves on a
deliberate promotion — without adding a single credential to CI.

## The problem

Every merge to `main` publishes `0.<minor>.<commitcount>` to npm under the
default dist-tag, and every running instance polls `shadok-ai@latest` and
installs it. There is exactly one speed, and it is "immediately". A user who
wants a quiet instance has only one lever: turning auto-update off entirely,
which then never updates at all.

## The shape

Two channels, chosen per instance:

| Channel | Moves on | For |
|---|---|---|
| `alpha` | every merge to `main` | instances that want the newest work at once |
| `beta` (default) | a promotion only | everyone else |

A promotion is a **minor bump**: `0.2.x` → `0.3.0`. The minor is the generation,
and it needs no separate release commit.

The patch counts **commits since the minor began**, so it restarts at 0 at every
promotion and a version says where it sits inside its generation: `0.6.4` is the
fourth merge of the 0.6 line. A promotion is not a special case — the promoting
merge is the commit that set the minor, so its count is 0.

Two earlier spellings were worse. The global commit count gave `0.3.77`, which
reads as the 77th patch of a 0.3 series whose earlier patches never existed.
Special-casing the promotion to `.0` fixed the milestone but left alphas numbered
by repository age, which says nothing useful about the release.

Changing the rule **must happen in the same merge as a promotion**: restarting
the count on its own would publish a version LOWER than the one already tagged
`alpha` (0.5.2 against a published 0.5.123), and every alpha instance would
silently stop updating — `isNewer` is false — until the next promotion.

## Why dist-tags, and why only `npm publish`

npm's dist-tags are the mechanism this feature is asking for, so the updater
installs `shadok-ai@<tag>` instead of a hardcoded `@latest`.

The obvious implementation — publish everything under `alpha`, then move `beta`
and `latest` with `npm dist-tag add` on promotion — **does not work here**. CI
authenticates with npm Trusted Publishing (OIDC), which
[covers `npm publish` and nothing else](https://docs.npmjs.com/trusted-publishers):
"Other npm commands such as `install`, `view`, or `access` still require
traditional authentication methods." Moving a tag afterwards would mean storing
a long-lived npm automation token as a repository secret — a permanent
credential added to solve a release-plumbing detail.

So the design uses the one authenticated command available, and the fact that
`npm publish` **sets** a tag:

- ordinary merge → `npm publish --tag alpha` — only `alpha` moves;
- promotion → `npm publish` with no tag → npm moves **`latest`**.

`latest` therefore IS the beta channel. That was already the desired behaviour
for a fresh `npx shadok-ai`: a newcomer lands on the promoted version, not on
the head of the stream.

Alternatives rejected:

- **A long-lived npm token in secrets.** Works, and adds a credential that can
  publish anything, forever, to solve a tagging problem. The whole point of
  Trusted Publishing was removing that token.
- **Publishing the promotion twice** (once per tag) — npm refuses a duplicate
  version, so it would mean two version numbers for one build, and the alpha
  and beta streams would drift apart by construction.
- **A separate `beta` dist-tag** alongside `latest`. Needs `dist-tag add`, i.e.
  the token again, and leaves two tags to keep in sync for no gain.

## Promotion detection is stateless

CI does not diff commits or read git history to decide what it is doing. It
compares the minor in `package.json` with the minor of what is currently
published as `latest`:

```
BASE=0.3   (from package.json)      LATEST=0.2.73  → minors differ → PROMOTION
BASE=0.2   (from package.json)      LATEST=0.2.73  → same minor    → alpha
```

Idempotent and self-correcting: a re-run, a revert, or a workflow replay reaches
the same verdict from the registry's own state. Nothing to store, nothing to get
out of sync.

Promoting is therefore one edit — bump the minor in `package.json`, merge — and
the version that lands as `latest` is the merge itself, carrying everything the
alphas had been testing.

## The window where alpha is behind beta

A promotion publish moves `latest` and leaves `alpha` pointing at the previous
build, so for the span of one merge an alpha instance resolves to a version
*older* than beta. Left alone it heals on the next merge, but until then the
"newest" channel is the stale one, which reads as a bug.

The updater closes it client-side: **the alpha channel resolves to the newer of
`@alpha` and `@latest`**. Pure comparison, no CI trickery, and it keeps the
invariant that alpha ≥ beta at all times.

## Surfaces

- `config.json` gains `updateChannel: "alpha" | "beta"`, absent meaning `beta`
  — an existing instance keeps updating, just on the calmer channel.
- `GET /version` reports the channel alongside `current`/`latest`, so the
  cockpit can show which stream an instance follows.
- `PUT /channel` sets it, next to the existing auto-update toggle.
- `src/update-channel.ts` holds the pure cores: `resolveChannel` (config → a
  valid channel, unknown values falling back to `beta` rather than throwing) and
  `pickTarget` (the alpha ≥ beta rule). Both unit-tested; the network and the
  install stay in `updater.ts`.

## What does not change

The supervisor, the update-and-respawn dance, the `SHADOK_VERSION_CHECK_MIN`
gate and the `autoUpdate` switch are untouched. A channel decides *which*
version is the target; everything about *how* the swap happens is as before.

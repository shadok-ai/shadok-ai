# The "read-only" checkbox finally tells the truth

Date: 2026-08-09
Status: agreed, implemented

## The symptom

"When you edit a profile, you cannot change the git flag — or rather it does not
represent the status?"

Both at once.

## The two defects

**It did not represent the state.** `fillProfileForm` did
`$("profReadonly").checked = false;` **unconditionally**. Opening
`Shadok-Content`, which does carry the 7 `deny` patterns, showed the box
unticked. For every profile, always.

**It drove nothing.** The handler was one-way:
`if (e.target.checked) profDeny.value = READONLY_DENY.join("\n")`. Ticking
overwrote the area; **unticking did nothing**. Removing read-only meant emptying
the textarea by hand.

The origin is in the intent: "Read-only **preset**" had been designed as a
"fill this list for me" button, not as a state. Presented as a checkbox, it reads
as a state — hence a real switch.

## The rule adopted

`deny` remains **the source of truth**. The box is a view of it, never the
reverse.

- **Ticked** if and only if **all** 7 preset patterns are present. A
  half-applied preset must not pretend to be in place.
- **Unticking** removes those 7 patterns and **keeps** the custom ones.
- **Ticking** adds the missing ones, without duplicates and without touching the
  rest.
- **Editing the area by hand** resyncs the box — otherwise it would start lying
  again on the first line typed.

Deliberately stricter than the card's badge, which answers a different question —
"does this profile have guardrails?" — and lights up as soon as a `deny` exists,
custom or not. The two coexist because they do not assert the same thing.

## Pure cores

`hasReadonlyPreset(deny, preset)` and `applyReadonlyPreset(deny, on, preset)` in
`public/profile-card.js`, with the preset passed as a parameter rather than
captured.

**An anti-drift guard** comes with them: `READONLY_DENY` is duplicated in
`index.html` (the browser cannot import the TypeScript). A test compares the
HTML's copy to `src/profiles.ts`'s — without it, a server-side change would leave
the checkbox setting stale guardrails, silently.

## Verification

434 tests green. In the browser, against the real profiles:

| Action | Result |
|---|---|
| open `Shadok-Content` (read-only) | box **ticked** — it was always unticked before |
| open `Shadok-dev` (full access) | unticked |
| add `Bash(rm:*)` by hand | stays ticked |
| untick | only `Bash(rm:*)` remains — the custom pattern survives |
| tick again | 8 patterns, custom one kept, no duplicate |
| empty the area by hand | unticks |

Zero console errors.

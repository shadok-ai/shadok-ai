# A default name when creating an agent

Date: 2026-08-01
Status: agreed, implemented

## Problem

An agent's default name is `basename(cwd)` (`launchTab`). Every agent launched
on the same repo is therefore called **the same thing** — a whole column of
"shadok-ai" tabs you can only tell apart by opening them. Each agent had to be
renamed by hand, after the fact, with a double-click.

## Design

### A `Name` field in the creation popin

Placed between the profile grid and the directory: **who** this agent is, **what
we call it**, then **where** it works. Prefilled with the computed default and
editable — you name it at the moment you know what the agent will do.

### The default is the profile's name

`defaultAgentName(profileName, cwd)` (pure, in `public/profile-card.js`):

1. the **profile** when there is one — that is what tells two agents on the same
   repo apart;
2. otherwise the **directory's name** (the current behaviour);
3. otherwise `"agent"` — never an empty string, an unnamed tab is unreadable.

**No numeric suffix.** Two agents of the same profile will therefore carry the
same default name; since the field is editable at launch, they get told apart on
the spot. This is an explicit choice of simplicity, reversible if it starts to
grate.

### When the default is re-proposed

Same rule as the profile memory: **on opening** the popin, on every **profile
card change** (otherwise you would launch a "Shadok-dev" actually running on
Shadok-Support), and on a **directory change** (with no profile, the default IS
the directory).

Never when the user typed their own (`nameTouched`). **Clearing the field hands
control back to the default** — the simplest way back, with no dedicated button.

### Applying it at launch

The name is set on the tab **before** `launchTab`, which would otherwise
overwrite it with `basename(cwd)`, and `customName = true` also protects it from
`ready` and from the channel restore.

## Tests

- `profile-card.test.ts`: the profile wins, falls back to the directory (with or
  without a trailing slash), final fallback to `"agent"`, whitespace ignored.
- In the browser: no profile → `shadok-ai`; `Shadok-dev` → `Shadok-dev`; changing
  card → the default follows; a manual entry never overwritten; a cleared field →
  the default comes back; and the typed name does land on the created tab.

# Teams light, corporate dark, and a logo

## Why

The cockpit read as playful and amber-heavy. The owner wanted something that
looks serious enough for a company to adopt. Several mockups were tried. The
owner picked two:

- **light mode** looks like Microsoft Teams;
- **dark mode** uses the neutral "corporate" mockup: near-black, one indigo
  accent, Slack/Linear-like.

The owner also wanted the Shadok line drawing on a coloured tile as the logo.

## What changes

This is a re-skin through the existing tokens only. The layout and the
behaviour are untouched.

- `:root` (dark, the default) gets new values:
  - neutral surfaces `#0c0c0e` / `#131315` / `#1c1c1f`;
  - `--amber` becomes indigo `#7b93ff`;
  - `--radius` goes from 12px to 8px.
- `:root[data-mode="light"]` follows Teams:
  - grey chrome `#ebebeb` and `#f5f5f5`, white cards;
  - text `#242424` / `#616161`;
  - Segoe UI first in the font stack;
  - 6px corners;
  - `--amber: #5b5fc7` when no palette is chosen.
- `--phosphor` in light mode is derived from the accent. The old fixed dark
  amber was only right for the amber palette.
- New token `--on-accent`: the text colour on an accent fill (primary button,
  update banner, re-login banner). It is dark on the pale dark-mode accents and
  white on the light-mode purple. It stays dark for a chosen palette, whose
  accents are pale.
- The header's `◆` is replaced by `.brand-logo`, an accent tile carrying the
  Shadok's line drawing.

## Decisions

- **The default palette keeps the stored key `amber`.** Renaming it would
  orphan every instance's saved choice and change the `/theme` contract. Only
  its swatch label (*Shadok*) and its colours change. As a result, the old
  amber accent is no longer offered.
- **The palettes stay as they are.** A chosen palette still overrides the
  default accent in both modes.
- **The favicon is not touched.** It already reads `--amber` and `--bg` live,
  so it follows the new colours on its own.

## Not in this change

The structural parts of the mockups are not included:

- Teams' app bar and collapsible group sections;
- presence dots;
- adaptive-card dialogs.

They would turn a theme switch into a layout fork, so they are left for a
follow-up if wanted.

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

## Layout: Teams

The owner then asked for the cockpit itself to match the mockups, not only its
colours. One layout serves both modes, and the colours stay the theme. Two
layouts selected by the theme would mean maintaining two interfaces in one
10k-line page.

- **Title bar.** It holds the brand mark and name, a search box
  (`#agentSearch`), the quota dials and the ⋯ menu.
  - The search narrows the agents list as you type and unfolds collapsed groups
    while a query is present.
  - Enter opens the first match, Escape clears.
  - Under 1100px the GitHub star moves into the ⋯ menu.
- **App bar (`#appBar`).**
  - *Activity* shows how many agents wait for an answer, and a click cycles
    through them.
  - *Agents* focuses the search.
  - The global tools follow. `reflowHeaderTools` moves the real buttons there
    on a desktop, so their handlers come along. On a phone it moves them to the
    ⋯ menu, as before.
- **Agents pane.** `#groupRail` is hidden. Every group is a collapsible section
  of `#tabbar`, exactly as the phone sheet already showed them. The group's
  icon sits on a tile:
  - a click on the icon opens the icon picker, which used to be reachable only
    from the rail;
  - its `＋` opens the setup popin for that group (`openSetup(groupId)`).
- **Agents.** Each tab gets a round avatar (`paintTabAvatar`): initials, plus a
  colour from the Teams persona palette hashed from the name, so it needs no
  storage. The state LED rides its corner as a presence dot: green when ready,
  red while working, hollow when the process is dead.
- **Channel header.** The bar has:
  - the avatar and name;
  - Chat / Changes tabs, which drive the terminal mode and the diff panel's
    existing toggle;
  - Schedule and Terminal as labelled tabs.
- **Messages.** Bubbles get 6px corners. Your messages sit on an accent tint,
  the agent's on a white card. A dialog becomes an *Approval requested* card
  with an accent top border.
- **Composer.** A card with the accent underline.

Everything lives in a "Teams layer" at the end of the stylesheet, so the older
rules underneath stay readable and the phone layout (≤640px) keeps its own
behaviour. On a phone the mark is dropped from the one-row header: there is no
room for it beside the name, the version and the dials, and the favicon
carries it there.

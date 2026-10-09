# Game header guidelines

How a game lays out the top of its screen so it sits cleanly under the host's
chrome. This is about **position and size**, not look: each game keeps its own
fonts and colours.

## The host's chrome

The mobile app runs games full-screen. Everything it draws over the game is:

```
┌──────────────────────────────────────────┐
│ status bar (device safe area)            │  --oddsrabbit-safe-top (edge mode)
├──────────────────────────────────────────┤ ─┐
│ (←)                                      │  │ 56px "chrome row"
├────┬─────────────────────────────────────┤ ─┘
│    │                                     │
  └─ 56px "start lane": 12px + 32px button + 12px
```

- The **back button** is a 32px disc, 12px from the left edge, vertically
  centred in a 56px row directly under the status bar.
- The **home indicator** / bottom safe area: `--oddsrabbit-safe-bottom`. In
  `edge` mode the game draws under it but keeps controls out of it; in the
  other modes the host insets it away.

On **web** there is no floating chrome and no safe area.

## Three modes

A game picks one with a meta tag, which **must come before the SDK's
`<script>`** (the SDK reports it to the host from the game's `<head>`, so the
host has laid the game out before its first paint):

```html
<meta name="oddsrabbit-chrome" content="edge" />
```

**Edge to edge (`edge`, what new first-party games use).** The game's viewport
is the whole screen. Its backgrounds, canvas and full-screen overlays run under
the status bar and the home indicator by themselves, so any scrim or screen
colour change reaches the edges with no help from the host. The game pads its
**content** by the insets the host hands it (below), and its first row is its
header, laid out in the chrome row beside the back button.

**Inline header (`inline`, the older first-party mode).** The host pads the
status bar and home indicator and paints them in a colour it reads from the
game's `<body>`; the game's document starts right under the status bar with
its header in the chrome row. Anything the game layers over `<body>` (a dark
scrim on a start screen, say) does **not** reach the padded insets, which is
why new games use `edge`.

**Reserved band (no meta, or a game on another origin).** The game is pushed
below the chrome row, and the host paints the insets as for `inline`. Safe for
any game, but it spends 56px on a row that holds a single button.

The host sets these on the game's `<html>`:

| Variable | Mode | Mobile app | Web | Not set (standalone load, older app) |
|---|---|---|---|---|
| `--oddsrabbit-chrome-height` | edge, inline | `56px` — height of the chrome row | `64px` | use 48px |
| `--oddsrabbit-chrome-start` | edge, inline | `56px` — width of the back button's lane | not set | use your edge padding (12px) |
| `--oddsrabbit-safe-top` | edge | status bar height (above the chrome row) | `0px` | use 0 |
| `--oddsrabbit-safe-right` / `-bottom` / `-left` | edge | device safe areas (home indicator, landscape notch) | `0px` | use 0 |

It also sets `data-oddsrabbit-surface="app"` or `"web"` on the game's `<html>`
(in every mode), for styling that depends on the host rather than on the
insets — e.g. a larger header on desktop web, where no back button constrains
the row (2048 does this). Only style up from the compact row with it: the app
must keep the row rules below.

Always read them with those fallbacks. The web row height is set by the host
(`WEB_CHROME_HEIGHT` in `src/host/host.ts`) so web spacing is tuned in one place
for every game. App builds that predate the chrome row send no chrome variables
and fold the chrome row into `--oddsrabbit-safe-top`, so the same markup puts
the header under the button there.

## Rules

1. **The header row is the first thing in the document, flush to the top.** No
   body margin or padding above it. Whatever sits above it would push it out of
   the button's row. In `edge` mode it starts at the top of the screen and pads
   the status bar itself; its background, if any, runs up under the status bar.

   ```css
   .header-row {
     box-sizing: border-box;
     min-height: calc(var(--oddsrabbit-safe-top, 0px) + var(--oddsrabbit-chrome-height, 48px));
     padding: var(--oddsrabbit-safe-top, 0px)
              calc(12px + var(--oddsrabbit-safe-right, 0px))
              0
              calc(var(--oddsrabbit-chrome-start, 12px) + var(--oddsrabbit-safe-left, 0px));
     display: flex;
     align-items: center;
     gap: 8px;
   }
   ```

2. **Keep the start lane empty.** Nothing interactive or important in the first
   `--oddsrabbit-chrome-start` px of the header row. A centred title pads both
   sides by the lane so it stays centred:
   `padding-inline: var(--oddsrabbit-chrome-start, 12px);`.

3. **Centre everything on the row's centre line** (`align-items: center`), so
   controls line up with the back button.

4. **Sizes.** Icon buttons and score chips are **32px tall**, matching the back
   button, with a **44px** tap area (pad with an invisible pseudo-element or
   padding if the visual is smaller). **8px** between controls. **12px** from
   the right edge, mirroring the button's 12px on the left.

5. **Order.** Title / status after the lane on the left; actions, then scores,
   on the right (scores last, at the far edge).

6. **Title is optional.** One line, 16–20px, ellipsised. The player launched
   this game by name; drop the title before squeezing controls.

7. **Nothing but the row in the row.** Taglines, intros and "how to play" do not
   go in the header: put them on the idle/start overlay or behind a `?` button.
   Secondary strips (timers, stage banners, second button rows) go **below** the
   header row.

8. **Background (`edge`).** Draw to every edge: page background, canvas and
   full-screen overlays (`position: fixed; inset: 0`) all run under the status
   bar and home indicator. Only content is inset: pad whatever must stay
   readable or tappable by `--oddsrabbit-safe-*` (overlay contents, bottom
   buttons, toasts, the document's bottom margin). Modals that must also clear
   the back button pad their top by
   `max(16px, calc(var(--oddsrabbit-safe-top, 0px) + var(--oddsrabbit-chrome-height, 0px)))`
   (the shared leaderboard modal already does).

   The host still reads `<body>`'s background (then `<html>`'s) to pick a
   legible status-bar and back-button tone. When something covers the top of
   the screen in a different colour — a dark scrim on a start screen — set
   `--oddsrabbit-edge-top` to an opaque approximation of what the status bar
   now sits on, on `<html>` or `<body>`, for as long as it shows (toggle an
   attribute on `<html>`: the host watches its attributes).

   *`inline` / reserved only:* the host paints the padded insets in `<body>`'s
   colour, or `--oddsrabbit-edge-top` / `--oddsrabbit-edge-bottom` when set.
   `<body>` must then be the colour at the top and bottom edges, on every
   screen.

9. **No `env(safe-area-inset-*)` in games.** The host owns the insets, and
   inside the game's iframe those values are 0 anyway. Use
   `--oddsrabbit-safe-*`.

10. **No in-game "back" in the top-left.** That corner is the app's exit. For a
    game's own sub-screens, put a Close/Done control at the **right** of the
    header row.

11. **Full-bleed games** (the board is the screen, controls float over it) put
    their HUD in the same row: `position: absolute; top: 0;` with the header-row
    height and padding above (status bar included), and reserve that height in their layout maths if
    the board mustn't sit under it.

12. **Scrolling.** Prefer scrolling a container below the header row over
    scrolling the document. If the document does scroll, content passes under
    the back button, which is acceptable but less tidy.

## Checklist for a new game

- [ ] `<meta name="oddsrabbit-chrome" content="edge">` in `<head>`, before the SDK script
- [ ] header row first, flush to the top, padded by `--oddsrabbit-safe-top`, sized from `--oddsrabbit-chrome-*`
- [ ] start lane empty; controls 32px, centred, 12px right edge
- [ ] backgrounds and overlays reach every edge; content padded by `--oddsrabbit-safe-*`
- [ ] `--oddsrabbit-edge-top` set while a differently coloured layer covers the top
- [ ] no `env(safe-area-inset-*)`, no top-left back button

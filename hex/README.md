# Hex Rush

Hexagonal block-stacker for the OddsRabbit Games surface. Original
implementation; not a port.

A hexagon sits at the centre of the board. Blocks drift inward along six fixed
lanes, and the player rotates the hexagon so that the side facing an incoming
block is the colour they want it to land on. Three or more connected same-colour
blocks clear, everything above them collapses inward, and a chain of clears
multiplies the score.

## On the genre, and on Hextris

The rotate-a-hexagon-to-catch-falling-blocks mechanic is best known from
[Hextris](https://github.com/Hextris/hextris). This game is **not** a port or a
fork of it, and no upstream code was consulted while writing it: Hextris is
GPL-3.0, and taking any of it would put this repository's MIT licence out of
reach. Game mechanics are not copyrightable, so the idea is fair to build on —
the implementation here is written from scratch, and the rules below differ from
Hextris in several places (single-block clears, the combo window, the
save-on-overflow rule, the difficulty curve).

The same applies to the art: nothing is copied. The board is drawn as canvas
geometry, so the game ships no image assets at all.

## Design

Dark board, four saturated block colours, one large central hexagon.

`js/renderer.js` draws the board as concentric hexagonal **rings**. Ring `d` on
side `j` is the trapezoid between the hexagon of apothem `a + d*h` and the one of
apothem `a + (d+1)*h`, clipped to that side's sixth of the perimeter. Because a
regular hexagon's side length is a fixed multiple of its apothem
(`s = 2a/√3`), consecutive rings tessellate exactly — the outer edge of ring `d`
*is* the inner edge of ring `d+1`, with no seam to fudge.

Two things about that geometry are worth knowing before changing it:

- **`CORE_APOTHEM_UNITS` controls how much a stack flares, and it has to stay
  large.** A ring's side grows in proportion to its apothem, so a block at depth
  `d` is `(core + d) / core` times as wide as one sitting on the bare hexagon.
  At a small core that runs away: at `2.15` a depth-7 block is over four times
  the width of the face beneath it, and a column reads as a funnel rather than a
  stack. At `8.5` the same column widens by about 1.8× over its full height. The
  cost is board area, since the core is inert space, so the value in the file is
  the largest one that still leaves a usable approach runway.
- **Falling blocks are drawn at a fixed width**, not at the true width of the
  ring they currently occupy (`_cellPath`'s `widthDepth` argument). Drawn true to
  size out at the spawn radius, an incoming block is nearly three times the size
  of the one it is about to become, and arrives as a long bar sweeping across the
  board. Pinning the width to depth 0 makes it exactly the size of a block on the
  bare hexagon, which is what the player needs to read it as.

Unlike snake, match3 and solitaire, this board is **not** pixel art. It rotates
continuously, and a rotating pixel grid crawls and shimmers at every angle that
isn't a multiple of 90°. So the canvas renders smooth at device-pixel resolution
and takes its retro character from a flat high-contrast palette instead. The
chrome keeps the shared Press Start 2P font so the game still reads as part of
the same suite.

## Game rules

- Six sides. A side holds at most **7** blocks; going over ends the run.
- Blocks enter on six fixed **world** lanes and fall inward at a speed measured
  in block-thicknesses per second, so difficulty reads the same on a phone and a
  desktop. (A pixels-per-second speed would make the larger board harder.)
- Rotating turns the hexagon one sixth-turn. Which side catches a given lane is
  resolved against the **committed** rotation, not the animated one, so a
  last-moment rotation takes effect immediately rather than losing to its own
  easing.
- A block lands on whichever side faces its lane when it arrives, stacking
  outward from the hexagon.
- **Clearing:** any connected group of 3+ same-colour blocks clears. Adjacency
  is inward/outward within a side's stack, and sideways to the neighbouring side
  at the same depth — but only where that neighbour actually holds a block, so
  groups never clear across a visible gap. All qualifying groups clear together
  in one pass.
- **Collapse and cascade:** survivors slide inward to close the gap. If that
  creates a new group, it clears too, as the next link in the chain.
- **Overflow is checked after the cascade.** A block that lands on a full side
  and immediately completes a match is a save, not a loss — losing to a stack
  that was about to disappear reads as the game cheating.
- **Scoring:** `blocks cleared × 10 × combo`. The combo starts at ×1, steps up
  after each clear, caps at ×9, and decays back to ×1 after 2.6s without one.
- **Difficulty** ramps with score, not elapsed time — a player who is clearing
  well gets pushed; one who is barely surviving doesn't get pushed for staying
  alive. Fall speed and spawn rate both scale linearly and clamp. A fourth
  colour is introduced at 700 points, which is a much sharper step than any
  speed increase and so lands after the other curves have had time to bite.

## Controls

- **Touch:** tap the left or right half of the board to turn the hexagon. Every
  tap on the board is a rotation, which is why pause has its own on-screen
  button rather than sharing the tap the way snake does.
- **Keyboard:** ← / → (also A/D, H/L) to turn, space to pause, R to restart.
- Any rotation input on an idle or finished board starts a run, and on a paused
  one resumes it.

## Scoring and leaderboards

Two global boards, both public, read back by `js/leaderboard.js`:

- **This Month** — best score this calendar month, round key `month-YYYY-MM`.
- **All Time** — best score ever, round key `highscore`.

Both submit with `keepBest: true`, so the server keeps the maximum under a key
that is written more than once. Without it the second submit of a rising best
would reject as already-submitted and freeze the player's row at their first
score. The month key follows §3.7 of `docs/proposals/unified-leaderboard.md`: an
all-time board ossifies, and a per-month key buys a live board for the cost of
one extra `scores.top` read. It is **not** `scores.season`, which aggregates a
month of *daily* keys server-side and does not apply to an arcade game.

Submissions are confirmed-and-retried rather than fired and forgotten. Storage
records what the platform actually accepted (written only on a resolved submit),
and any gap between that and the real best is retried on load, on game over, and
on both background and foreground. See `submitBests()` in `js/application.js`.

The month boundary is **UTC**, matching `src/ui/season.ts`, so every player rolls
over at the same instant.

## Manifest scopes required

- `bridge:storage` — best score, month best, submission markers, mute setting.
- `bridge:scores` — the two leaderboards above.
- `bridge:share` — the share modal on the game-over overlay.

The game also calls `actions.haptic` on a clear and on game over. That verb is
**not** scope-gated — the backend's scope vocabulary is exactly
`bridge:storage`, `bridge:share`, `bridge:scores` and `bridge:publishPost`
(`tools/setup-apps-platform.php` in the `oddsrabbit` WP repo), and there is no
`bridge:haptics`. Declaring one would fail manifest validation.

## File layout

```
hex/
├── LICENSE.txt
├── README.md
├── index.html
├── styles.css
├── fonts/                 (copied from snake/ at build time)
└── js/
    ├── input_manager.js   rotation + pause/restart events
    ├── storage_manager.js bests, submission markers, round keys
    ├── sound_manager.js   procedural WebAudio, no asset files
    ├── game.js            rules engine — depth units, no pixels
    ├── renderer.js        hexagonal ring geometry
    ├── application.js     bridge wiring, share modal, score submission
    └── leaderboard.js     the two boards
```

`js/game.js` deliberately knows nothing about pixels: every position is in
**depth units**, where one unit is one block's thickness measured outward from
the hexagon's face. The renderer is the only thing that converts to pixels, which
is what lets the board resize freely and lets the rules be tested without a
canvas.

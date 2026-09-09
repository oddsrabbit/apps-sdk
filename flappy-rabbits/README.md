# Flappy Rabbits

One-button side-scroller for the OddsRabbit Games surface. Original
implementation; not a port.

A rabbit falls under gravity across a scrolling garden. Every tap gives it one
upward hop. Hedges grow from the ground and hang from the sky with a gap between
them; clearing a gap scores a point, touching anything ends the run.

## The name, and the slug

The game ships as **Flappy Rabbits** under the slug `flappy-rabbits`: the
deployed path is `apps.oddsrabbit.com/flappy-rabbits/` and the landing page
`oddsrabbit.com/games/flappy-rabbits/`. It was developed under the working slug
`hop` and renamed before its first production release, so nothing had to be
migrated. The code identifiers (`HopGame`, `HopRenderer`, `window.HopRounds`,
the `hop:` log prefix, `GAME_HOP_JS` in the build) kept the short name — a
rename there would touch every file to change a word nobody sees.

## On the genre, and on Clumsy Bird

The one-button flap-through-gaps mechanic is best known from Flappy Bird and its
many clones, including [Clumsy
Bird](https://github.com/ellisonleao/clumsy-bird). This game is **not** a port or
a fork of any of them, and no upstream code was consulted while writing it.

Two reasons that matters for Clumsy Bird specifically:

1. **Its licence is contradictory.** The repository ships a GPL-3.0
   `LICENSE.md` while its `package.json` claims MIT. A contradiction is not a
   permission — the safe reading is the copyleft one, which is incompatible with
   this repository.
2. **Its art is Flappy Bird's art.** The sprite sheet is a direct clone of Dong
   Nguyen's assets, so it carries a second, separate problem that no licence on
   the code would fix.

Game mechanics are not copyrightable, so the idea is fair to build on. Everything
here is written and drawn from scratch, and the game ships no image assets at
all — every sprite is drawn as integer rects at runtime.

The name is a genre reference and nothing more: no code, art or asset from any
of those games is in this one. Worth knowing that "Flappy Bird" is a mark of its
author and that app stores have, in the past, bounced third-party titles built
around the word — a consideration for the store listing, not for this
repository, which publishes to the web surface.

The obstacles are hedges rather than carrots on purpose: the player is a rabbit,
and an obstacle shaped like the thing rabbits chase reads as a collectible no
matter how it is coloured.

## Design

### Full-bleed, on a constant play field

The scene **is** the page. There is no title bar, no framed board and no
explanation column: the canvas fills the viewport, the score/best chips and the
pause and mute controls float over the sky, and every word of text — the name,
how to play, the buttons — lives on the overlay, where it is read between runs
and gone during them. A permanent header spends the best real estate on the
screen telling the player something they already know.

The scene grows to fill any viewport. What does **not** grow is the *play
field* — the game has global leaderboards, so what a run demands of a player has
to be identical on a phone and a 27-inch monitor. Each axis buys that a
different way.

**Height.** The physics in `js/game.js` is expressed in a fixed 320×480 world,
and the 480 never moves. `HopRenderer.resize` fits by width and draws the spare
height as scenery: extra sky above the field, extra earth below it (about 70/30,
both capped). A taller screen sees more garden, never more room to fly in.

**Width.** A window wider than the world's 2:3 used to fit by height and let the
page background letterbox the sides — on a 1400×800 desktop that was 433 px of
flat green either side of a 533 px scene, more of the screen than the game. The
world now widens instead, and what keeps that honest is `SPAWN_LEAD`:

> Gates spawn at the **right edge of the view**, and the rabbit sits
> `SPAWN_LEAD` (244 world px) in from that edge on every screen. `rabbitX` is
> derived from it — `viewW - SPAWN_LEAD` — rather than being a number of its
> own.

So the visible run-up in front of the rabbit is always 244 px, about 1.7 gates
at `GATE_SPACING`, and every extra pixel of width is garden the rabbit has
*already passed*. Gates still never pop into existence in open air, because the
spawn point is the edge itself. Driving the same autopilot through view widths
from 320 to 1600 gives the same score at the same step, with the gates ahead of
the rabbit agreeing to within 2e-11 world px — float noise, not geometry.

The cost is that on a wide desktop window the rabbit flies about 70% of the way
across the screen rather than a quarter of the way. That is forced: a constant
run-up plus a wide view puts the rabbit near the right edge, and the only
alternative is letting a big screen see further ahead, which is exactly the
advantage the leaderboard can't have.

Four consequences worth knowing before changing any of it:

- **The ceiling can't move with the screen.** It clamps the rabbit at world
  y = 0, so however much sky is drawn above that line, the rabbit still stops at
  it. The sky band is capped (170 px) to keep that stop near the top edge, where
  it reads as the top of the world, and the hedges hanging from the ceiling are
  drawn from the top of the *canvas* rather than from world y = 0 so the line
  has something visible to be.
- **A resize translates the whole garden, not just the rabbit.** Gate `x` values
  are absolute world coordinates, so `setViewWidth` moves every one of them by
  the same delta it moves `rabbitX`. Skip that and a rotate mid-run teleports
  the rabbit past a screenful of hedges, scoring them all and possibly landing
  it inside one.
- **The renderer draws the rabbit where the simulation says it is.** `rabbitX`
  rides in the render state rather than being a literal in `renderer.js` (it was
  `76`), because it is now a number that moves with the viewport and the two
  have to agree.
- **The overlay's type is sized from the scene, not the viewport.** `resize`
  publishes the scene's CSS size as `--stage-w` / `--stage-h`. These now track
  the viewport closely, but they stay the honest measurement: a viewport past
  about 2.5:1 still letterboxes top and bottom, where the sky and earth caps
  stop the scene growing.

### The mute icon

Drawn as inline SVG rather than set as `🔊` / `🔇`. The emoji were the one
full-colour, rounded, anti-aliased thing on a screen otherwise made entirely of
flat integer rects, and they render differently on every platform. The drawn
speaker inherits `currentColor`, so it takes the chip's own colour and sits in
the same visual family as the pause glyph beside it. Off is the waves going and
a slash coming across — both CSS off `aria-pressed`, so `application.js` sets
the ARIA state and nothing else, and the visual and accessible states can't
drift apart. Solitaire's toggle is the same icon, for the same reasons.

### Pixel art

Pixel art at a **320 px** minimum internal width — 320×480 of play field, plus
whatever the screen adds on either axis — upscaled by CSS with
`image-rendering: pixelated`.
The same approach as snake and solitaire, and the right one here because nothing
in this scene rotates. Every draw call is an axis-aligned integer rect, so the
upscale lands on exact pixel blocks at any size.

The rabbit is built from about twenty rects rather than authored as a sprite
sheet. At this size that costs nothing and buys two things a PNG wouldn't: no
second HTTP request on the mobile WebView, and a pose that can be nudged by a
parameter (`_drawRabbit`'s `tilt`) instead of needing three hand-drawn frames
kept in sync. The three poses lay the ears back and move the front foot rather
than rotating anything, which keeps every edge axis-aligned and therefore crisp.

Background depth comes from three layers at different parallax rates: clouds at
0.18×, far hills at 0.32×, near hills at 0.52×, and the ground itself at 1.0×.
The ground is the only layer at full rate, and it is what makes the scroll speed
legible.

The sky is banded, not graduated — a real gradient would dither. Both bands are
measured **up from the horizon** rather than down from the top of the canvas: on
a full-screen board, a band anchored to the top drifts into the middle of the
sky, where a hard horizontal line has nothing to explain it. There are two steps
rather than one for the same reason — at full-screen size a single edge that big
reads as a waterline. The clouds are placed at fractions of the sky band for the
same reason, so they spread through the extra sky instead of bunching at the
horizon.

Two things in `_drawHills` are worth knowing before changing it:

- **The mound widths are fractions of the layer's `spacing`, not of its
  height.** Keyed to height, a short-and-wide layer produces bars wider than the
  gap between mounds and the whole range merges into one flat slab.
- **The width has to grow from peak to base.** The bars are drawn top-down, so
  shrinking the width builds the mound upside down — a wide cap over a narrow
  foot — which again merges the range into a speckled band.

The three greens are separated by **value**, not hue: far hills lightest, near
hills in between, the grass strip darkest. They are all green, so hue can't do
that work. Both hill layers are based *on* the ground line rather than above it,
because a sliver of sky showing between the hills and the grass reads as a
glowing seam across the busiest part of the screen.

## Game rules

- The rabbit sits at a fixed x and the world moves past it.
- **Gravity** is 0.45 px/step², a hop launches at −7.2 px/step, and fall speed
  caps at 10.5 px/step. A hop is an *assignment*, not an addition, so tapping
  while already rising doesn't stack into an un-loseable climb.
- **The ceiling clamps; it does not kill.** Dying on the top edge punishes the
  player for the safest thing they can do when a gap is high.
- The **ground** ends the run. So does any hedge.
- The **hitbox is inset** from the drawn sprite: ears and tail are silhouette,
  not collision. Erring generous here is the single biggest thing that makes a
  one-button game feel fair rather than fussy. The hedge lip likewise overhangs
  its column by a few decorative pixels that cannot kill.
- A gate scores the instant its trailing edge clears the rabbit's leading edge —
  the same moment the player sees themselves come through.
- **Difficulty** ramps with score and clamps: scroll speed 2.05 → 3.35 px/step,
  gap 122 → 92 px. Consecutive gaps never shift more than 86 px vertically,
  because two gates at opposite extremes are not reachable at full speed however
  well the player flies.
- **Score is one point per gap**, which is the honest metric for this genre.

## Fixed timestep

A game whose pieces move linearly can integrate them over a variable delta
exactly, and most of the arcade games here do. This one integrates gravity, and
that is **not** delta-invariant: one 32 ms step and two 16 ms steps give
different heights. Left variable, the hop arc would differ measurably between a
60 Hz phone and a 120 Hz one, and the gaps are tuned tightly enough that players
would notice.

So the simulation advances in fixed 1/60 s steps and the frame loop only decides
how many to run. Two guards sit on that:

- The frame delta is clamped, so a backgrounded tab doesn't fast-forward the
  rabbit into a hedge it never had a chance to clear.
- Steps per frame are capped. Below roughly 10 fps the game deliberately runs in
  slow motion rather than teleporting, which is the kinder failure.

The backlog is dropped **only when the frame both hit the cap and still owes more
than a whole step**. Zeroing on the cap alone throws away the ordinary sub-step
remainder every frame leaves, which at the cap's own frame rate quietly runs the
game about 8% slow.

## Controls

- **Touch:** tap anywhere to hop — and "anywhere" is now the whole screen. Every
  tap on the board is a hop, which is why pause has its own on-screen button,
  and why the HUD bar is `pointer-events: none` except on the controls
  themselves: the dead space between them still passes the tap through.
- **Keyboard:** space / ↑ / W to hop, P or Esc to pause, R to restart. Key
  auto-repeat is ignored, since a held key would otherwise be a continuous
  thruster and remove the entire skill of the game.
- A tap on an idle board starts the run **and** is its first hop; requiring a
  second tap would drop the rabbit for the length of the player's reaction time.
- A tap after a game over deliberately does nothing. The tap that kills you is
  very often still in flight when the run ends, and restarting on it would throw
  the player into a fresh run before they have seen their score.

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

The game also calls `actions.haptic` once per gate cleared, and on game over.
Deliberately not on the hop itself: a hop fires several times a second, and a
haptic at that rate stops reading as feedback and starts reading as a fault.
That verb is **not** scope-gated — the backend's scope vocabulary is exactly
`bridge:storage`, `bridge:share`, `bridge:scores` and `bridge:publishPost`
(`tools/setup-apps-platform.php` in the `oddsrabbit` WP repo), and there is no
`bridge:haptics`. Declaring one would fail manifest validation.

## File layout

```
flappy-rabbits/
├── LICENSE.txt
├── README.md
├── index.html
├── styles.css
├── fonts/                 (copied from snake/ at build time)
└── js/
    ├── input_manager.js   one tap event, plus pause/restart
    ├── storage_manager.js bests, submission markers, round keys
    ├── sound_manager.js   procedural WebAudio, no asset files
    ├── game.js            physics and rules, fixed timestep
    ├── renderer.js        pixel art, drawn as integer rects
    ├── application.js     bridge wiring, share modal, score submission
    └── leaderboard.js     the two boards
```

Everything in `js/game.js` is in **world pixels** — the 320×480 coordinate system
the renderer draws into before upscaling. That makes the physics constants
literal and comparable (a hop lifts about 58 px; the gap starts at 122 px) and
keeps the game identical on every screen size. `js/renderer.js` is the only file
that knows the canvas is bigger than that: it adds `offsetY` on the way from
world coordinates to canvas ones, and nothing it draws in the overscan can be
touched.

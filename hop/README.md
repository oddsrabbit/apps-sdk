# Hop

One-button side-scroller for the OddsRabbit Games surface. Original
implementation; not a port.

A rabbit falls under gravity across a scrolling garden. Every tap gives it one
upward hop. Hedges grow from the ground and hang from the sky with a gap between
them; clearing a gap scores a point, touching anything ends the run.

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

The obstacles are hedges rather than carrots on purpose: the player is a rabbit,
and an obstacle shaped like the thing rabbits chase reads as a collectible no
matter how it is coloured.

## Design

Pixel art at a fixed **320×480** internal resolution, upscaled by CSS with
`image-rendering: pixelated` — the same approach as snake and solitaire, and the
right one here because nothing in this scene rotates. Every draw call is an
axis-aligned integer rect, so the upscale lands on exact pixel blocks at any
size.

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

Unlike Hex Rush — whose blocks move linearly, so integrating them over a variable
delta is exact — this game integrates gravity, and that is **not**
delta-invariant: one 32 ms step and two 16 ms steps give different heights. Left
variable, the hop arc would differ measurably between a 60 Hz phone and a 120 Hz
one, and the gaps are tuned tightly enough that players would notice.

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

- **Touch:** tap anywhere to hop. Every tap on the board is a hop, which is why
  pause has its own on-screen button.
- **Keyboard:** space / ↑ / W to hop, P or Esc to pause, R to restart. Key
  auto-repeat is ignored, since a held key would otherwise be a continuous
  thruster and remove the entire skill of the game.
- A tap on an idle board starts the run **and** is its first hop; requiring a
  second tap would drop the rabbit for the length of the player's reaction time.
- A tap after a game over deliberately does nothing. The tap that kills you is
  very often still in flight when the run ends, and restarting on it would throw
  the player into a fresh run before they have seen their score.

## Scoring and leaderboards

Identical to Hex Rush: a **This Month** board (`month-YYYY-MM`) and an **All
Time** board (`highscore`), both public, both submitted with `keepBest: true`,
both confirmed-and-retried through storage markers so a dropped request is
recoverable. The month boundary is UTC, matching `src/ui/season.ts`. See
`hex/README.md` for the full rationale — it applies unchanged here.

## Manifest scopes required

- `bridge:storage` — best score, month best, submission markers, mute setting.
- `bridge:scores` — the two leaderboards above.
- `bridge:share` — the share modal on the game-over overlay.

The game also calls `actions.haptic` once per gate cleared, and on game over.
Deliberately not on the hop itself: a hop fires several times a second, and a
haptic at that rate stops reading as feedback and starts reading as a fault.
That verb is **not** scope-gated — see `hex/README.md` for the backend's actual
scope vocabulary, which has no `bridge:haptics` in it.

## File layout

```
hop/
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
keeps the game identical on every screen size.

# Snake

Game Boy DMG-styled snake for the OddsRabbit Games surface. Original implementation; not a port.

## Design

Visual palette is the classic Game Boy four-shade green ramp washed toward a paler mint background, with one deliberate exception: the carrot food sprite uses two warm oranges so it reads instantly as the goal at sprite size — leaning into the OddsRabbit rabbit/carrot theme. The outer board frame is a CSS-tiled embossed-button pattern (single SVG repeated); the inner playfield wall and snake/food are drawn into the canvas at a fixed 480×320 internal resolution and CSS-upscaled with `image-rendering: pixelated` so the art stays crisp on any display.

The snake's head segment overlays the OddsRabbit "karat" rabbit-face icon (`images/head.png`, the same artwork as the in-app currency mark) on top of the green body fill. Loaded async — if it hasn't arrived yet, the renderer falls back to a single mint pixel as the direction indicator so the head is still distinguishable. Locks the rabbit/carrot motif together: rabbit chasing carrots, snake-shaped.

Grid is 24×16 cells of 20px each. Wall is 1 cell thick around the perimeter, leaving a 22×14 playable area.

## Game rules

- Snake starts length 3, centered, defaulting to face right. The first directional input both starts the run and sets the initial heading — swipe/press any direction (including "back-the-way-it's-pointing") to launch. Opposite-direction starts flip the body so the head leads.
- +10 score per food. Tick interval starts at 180ms and drops 4ms per food, floor 70ms.
- Solid walls: hitting the border ends the run.
- Self-collision ends the run, except the snake's own retreating tail (won't kill you in the same tick it moves out of the way).
- Once underway, a 180° reversal against the *committed* direction is rejected (so pressing ← while moving → won't U-turn into your own neck).

## Controls

- **Keyboard:** arrow keys, WASD, or HJKL to steer. Space to start/pause/resume. R to restart.
- **Touch:** swipe to steer. Tap (anywhere on the iframe body) to start/pause/resume.

## SDK integration

- `bridge:storage` — best score (`bestScore` key). In-progress runs are not persisted by design (real-time game with no meaningful resume point).
- `bridge:share` — fires once per page load on a new personal best ≥ 100.
- Haptics: `light` per food, `error` on death, `success` on a new personal best that triggers the share.
- `OR.lifecycle.on('pause')` auto-pauses the game so backgrounding doesn't crash the snake.

## Manifest scopes required

- `bridge:storage`
- `bridge:share`

## License

MIT — see `LICENSE.txt`.

The Press Start 2P font (`fonts/press-start-2p-latin.woff2`) is © 2012 The Press Start 2P Project Authors, licensed under SIL OFL 1.1 — see `fonts/OFL.txt`.

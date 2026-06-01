# Solitaire

Klondike solitaire for the OddsRabbit Games surface. Original implementation; not a port.

## Design

Game Boy DMG-leaning palette (mint, four greens, plus cream card faces and red/black pips) so the game sits next to Snake without clashing. Internal canvas resolution is 480×720 with `image-rendering: pixelated`, so all art is hand-placed against integer pixel coordinates and stays crisp on any display.

Court cards are pixel rabbits in the OddsRabbit voice: J's ear is bent jester-style, Q wears a flower, K wears a crown. Card backs use the same carrot motif as Snake's food sprite, tiled to fill the back. Suit pips are hand-drawn at 9×9 px.

## Game rules

- **Klondike, draw 1**, infinite recycle of the stock.
- Tableau: 7 columns, dealt 1–7 cards with only the top of each column face-up.
- Foundations: 4 slots, build up by suit from ace to king.
- Tableau builds: down by alternating colour. Any face-up card (and any cards stacked on it) can be moved to another tableau column whose top card is the next rank up in the opposite colour. Empty columns accept any king.
- **Auto-send:** tap (or click) any face-up tableau-top or waste card to send it to a legal foundation. Dragging a card always takes priority — auto-send only fires on a tap that didn't cross the drag threshold.
- **Auto-complete:** once every tableau card is face-up, a "Finish" button appears in the message overlay — one tap drains everything to the foundations.
- **Undo:** unlimited within the current deal. Resets on every new deal.

## Daily deal

Every UTC day, all players see the same shuffle. The seed is the integer number of UTC days since `2026-01-01`, run through a mulberry32 PRNG → Fisher-Yates shuffle. The aggregate completion percentage shown on win/loss ("23% of players finished today's deal") is keyed off this seed, so the comparison is meaningful.

A **Random deal** button is available too — random deals are playable but do not contribute to the daily aggregate.

## Controls

- **Touch:** drag a card (and any cards stacked on it) to another column or foundation. Tap a tableau-top or waste card to auto-send it to a foundation. Tap the stock to draw; tap the empty stock to recycle the waste.
- **Mouse:** click-and-drag for moves. Click a tableau-top or waste card to auto-send. Same stock/recycle behaviour.
- **Keyboard:** `U` for undo, `R` for new deal, `Space` to draw from stock.

## SDK integration

- `bridge:storage` — `bestTimeMs`, `winStreak`, `savedGame`, `lastDailyId` + `lastDailyWon` so we don't double-count daily completions. `savedGame` is flushed on **both** `lifecycle.pause` and the browser `pagehide` event, so a backgrounded app *or* a hard tab-close mid-deal is resumable on next launch.
- `bridge:share` — user-initiated only. The Share button on the won overlay opens a share modal (copy / native-on-touch / X / Threads / Bluesky / Reddit / WhatsApp / Facebook), mirroring snake + rabbit-words. We never auto-fire share on win — the OS sheet would step on the "I solved it" moment.
- `bridge:scores` — daily deals submit to a per-deal leaderboard (`roundKey = daily-{seed}`). The score inverts solve time (faster = higher; `metadata = { timeMs, moves }`), and the won overlay renders a friends panel from `scores.friends`. Anonymous players get a `requestSignIn` CTA; signed-in players with no friend scores yet get an invite CTA. Random deals have no shared round and skip scores entirely.
- `bridge:aggregate` — `daily-{seed}` / `won` bucket, incremented on first win of the daily deal, decorates the overlay with the community completion count. k=5 anonymity floor handled — shows "stats unlock once a few more players finish" below k.
- Haptics: `light` on card pickup and successful drop, `error` on rejected drop, `success` on a card sent to foundation, `success` again on the win.
- `OR.lifecycle.on('resume')` is a no-op (the saved state is already on screen).

## Manifest scopes required

- `bridge:storage`
- `bridge:share`
- `bridge:scores`
- `bridge:aggregate`

## Android touch checklist

Drag-heavy game — both rules from the parent README are required. Both are wired in:

- `touch-action: none` on `html, body` and `.game-canvas`.
- `{ passive: false }` on every `touchstart` / `touchmove` listener in `input_manager.js`.
- `overscroll-behavior: none` on `html, body`.

## License

MIT — see `LICENSE.txt`.

The Press Start 2P font (`../snake/fonts/press-start-2p-latin.woff2`, reused via the parent build) is © 2012 The Press Start 2P Project Authors, licensed under SIL OFL 1.1.

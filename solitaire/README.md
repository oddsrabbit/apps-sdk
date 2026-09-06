# Solitaire

Klondike solitaire for the OddsRabbit Games surface. Original implementation; not a port.

## Design

Green felt with white pixel-art cards. Internal canvas resolution is 998×1036 with `image-rendering: pixelated`, upscaled by CSS to whatever the column allows (≤720 px on desktop, ~350 px on a phone). Card art is authored at 42×60 and blitted at `SCALE = 3`, so a card is 126×180 on the board and every art pixel is a crisp 3×3 block. `SCALE` in `js/renderer.js` is the one knob that resizes the deck; every layout offset is expressed as a multiple of it, so nothing shears when it moves.

Card faces come from [Kenney's Playing Cards Pack](https://kenney.nl/assets/playing-cards-pack) (CC0). They replaced a hand-drawn deck whose 3×5 rank glyphs rendered at roughly 2×4 device pixels on a phone — unreadable, and unfixable without redrawing all 52 faces, since there was no room to make the glyph bigger. Kenney's ranks are 8 px tall and sit clear of `FACE_UP_OFFSET`, so a face-up card's peek strip in a tableau column always shows its whole rank. That is the property the whole deck exists to provide; if you change `FACE_UP_OFFSET`, check it against the glyph's authored rows (5–12) first.

The card back is ours, not Kenney's: deep green with a carrot lattice. A face-down card in a column shows only its top 5 authored pixels, so those carry a hard light/orange/shadow band — a column of face-downs reads as crisp repeating pinstripes rather than a flat slab.

Empty slots (foundations, empty columns, the exhausted stock and its recycle arrow) stay hand-drawn in `renderer.js`. Kenney ships a `card_empty`, but it is a white card with a decorative frame, which on the felt reads as a blank card you could pick up — wrong for a hole.

### Card atlas

All 53 sprites live in one PNG, `images/cards.png` (546×300, ~7 KB), so the board costs a single image request on the mobile WebView. It is a 13-column × 5-row grid of 42×60 cells: rows 0–3 are the suits in `deck.js` order and columns 0–12 the ranks A..K, which makes a cell's index identical to the engine's own card integer (`suit * 13 + rank`). Row 4 holds the card back; the rest of row 4 is deliberately spare.

Regenerate it with:

```
python3 solitaire/tools/build-atlas.py --kenney /path/to/unzipped/kenney-pack
```

The Kenney pack is not vendored — only the derived atlas and `images/KENNEY-LICENSE.txt` are. The script owns the crop geometry, the palette remap (Kenney's slate "black" → near-black, for contrast on the felt) and the card-back art. Card art changes belong in that script, not in `renderer.js`.

The atlas is an image, so it loads async: `Renderer.load(url)` resolves once it has decoded, and `application.js` constructs the renderer with the result. The URL is carried on the canvas' `data-atlas` attribute rather than hardcoded in JS, because `index.html` is the only file the build substitutes `__BUILD_ID__` into — see `docs/deploy-cache-policy.md`. A failed atlas load surfaces the `.bootstrap-error` banner instead of leaving the player on bare felt.

Court cards are currently Kenney's crowns. Replacing them with OddsRabbit rabbits drawn at 42×60 is a follow-up, and belongs in the atlas script.

## Game rules

- **Klondike, draw 1**, infinite recycle of the stock.
- Tableau: 7 columns, dealt 1–7 cards with only the top of each column face-up.
- Foundations: 4 slots, build up by suit from ace to king.
- Tableau builds: down by alternating colour. Any face-up card (and any cards stacked on it) can be moved to another tableau column whose top card is the next rank up in the opposite colour. Empty columns accept any king.
- **Auto-send:** tap (or click) any face-up tableau-top or waste card to send it to a legal foundation. Dragging a card always takes priority — auto-send only fires on a tap that didn't cross the drag threshold.
- **Auto-complete:** once every tableau card is face-up, a "Finish" button appears in the message overlay — one tap drains everything to the foundations.
- **Undo:** unlimited within the current deal. Resets on every new deal.

## Daily deal

Every UTC day, all players see the same shuffle. The seed is the integer number of UTC days since `2026-01-01`, run through a mulberry32 PRNG → Fisher-Yates shuffle. The daily leaderboard (`scores.friends`) is keyed off this seed, so comparisons are meaningful.

A **Random deal** button is available too — random deals are playable but do not contribute to the streak or the daily leaderboard.

## Controls

- **Touch:** drag a card (and any cards stacked on it) to another column or foundation. Tap a tableau-top or waste card to auto-send it to a foundation. Tap the stock to draw; tap the empty stock to recycle the waste.
- **Mouse:** click-and-drag for moves. Click a tableau-top or waste card to auto-send. Same stock/recycle behaviour.
- **Keyboard:** `U` for undo, `R` for new deal, `Space` to draw from stock.

## SDK integration

- `bridge:storage` — `bestTimeMs`, `winStreak`, `savedGame`, `lastDailyId` + `lastDailyWon` so we don't double-count daily completions. `savedGame` is flushed on **both** `lifecycle.pause` and the browser `pagehide` event, so a backgrounded app *or* a hard tab-close mid-deal is resumable on next launch.
- `bridge:share` — user-initiated only. The Share button on the won overlay opens a share modal (copy / native-on-touch / X / Threads / Bluesky / Reddit / WhatsApp / Facebook), mirroring snake + rabbit-words. We never auto-fire share on win — the OS sheet would step on the "I solved it" moment.
- `bridge:scores` — daily deals submit to a per-deal leaderboard (`roundKey = daily-{seed}`). The score inverts solve time (faster = higher; `metadata = { timeMs, moves }`), and the won overlay renders a friends panel from `scores.friends`. Anonymous players get a `requestSignIn` CTA; signed-in players with no friend scores yet get an invite CTA. Random deals have no shared round and skip scores entirely.
- Haptics: `light` on card pickup and successful drop, `error` on rejected drop, `success` on a card sent to foundation, `success` again on the win.
- `OR.lifecycle.on('resume')` is a no-op (the saved state is already on screen).

## Manifest scopes required

- `bridge:storage`
- `bridge:share`
- `bridge:scores`

## Android touch checklist

Drag-heavy game — both rules from the parent README are required. Both are wired in:

- `touch-action: none` on `html, body` and `.game-canvas`.
- `{ passive: false }` on every `touchstart` / `touchmove` listener in `input_manager.js`.
- `overscroll-behavior: none` on `html, body`.

## License

MIT — see `LICENSE.txt`.

The Press Start 2P font (`../snake/fonts/press-start-2p-latin.woff2`, reused via the parent build) is © 2012 The Press Start 2P Project Authors, licensed under SIL OFL 1.1.

Card faces in `images/cards.png` are derived from Kenney's Playing Cards Pack (CC0 1.0, [kenney.nl](https://kenney.nl/assets/playing-cards-pack)). CC0 does not require attribution; the credit is here because Kenney asks for it and because redistributed art should say where it came from. The pack's own license text ships as `images/KENNEY-LICENSE.txt`.

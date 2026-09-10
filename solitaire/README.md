# Solitaire

Klondike solitaire for the OddsRabbit Games surface. Original implementation; not a port.

## Design

Green felt with white pixel-art cards. Card art is authored at 42×60 and blitted at `SCALE = 3`, so a card is 126×180 on the board and every art pixel is a crisp 3×3 block. `SCALE` in `js/renderer.js` is the one knob that resizes the deck; every layout offset is expressed as a multiple of it, so nothing shears when it moves.

### Full-bleed, on an elastic board

The felt **is** the page. There is no title bar, no framed board, no intro line and no how-to-play footer: the canvas fills the viewport, the undo / new-deal / sound controls and the moves and time chips float over a band reserved at the top of the board, and every word of text — the name, how to play, the buttons — lives on the overlay, where it is read between deals and gone during them.

The board itself flexes, and it does **not** flex the way `flappy-rabbits` does. That game has a fixed 320×480 world and paints spare height as scenery; solitaire has no scenery, and its board is nearly square (998×1036) against a phone's 0.46. Stretching a fixed aspect ratio to fill the screen would leave a small board floating in half a screen of dead felt.

So only the horizontal half is fixed. Seven tableau columns side by side is what Klondike is, so `INTERNAL_W` is a constant 998 and the card width is always the viewport's width over seven — no layout can make a card bigger on a phone. The **vertical** half is recomputed on every resize by `Renderer.prototype.resize`, which fits by width and then spends whatever height is left on the offsets that actually change what a player can read:

| | floor | ceiling | what it buys |
|---|---|---|---|
| `FACE_UP_OFFSET` | 42 (14 authored px) | 78 (26) | how much of a stacked card is visible. Takes the budget first. |
| `FACE_DOWN_OFFSET` | 15 (5) | 24 (8) | depth cue only — a hidden card tells the player nothing, so it is capped low. |
| badge gap | 30 | 90 | clearance between the top row and the tableau. |
| bottom felt | — | — | whatever is still spare, which is where the Finish button and the dead-end banner float. |

On a 390×750 phone that lands the buffer at 998×1919, the peek at its 78 ceiling, and about 30 CSS px of every stacked card visible — double the 15 px the fixed layout gave, in the same physical space.

Three things to know before changing any of it:

- **The fit is closed-form, and the HUD is part of it.** The bar is specified in CSS pixels (`HUD_BAND_CSS`, plus the safe-area inset read back out of a probe element) and consumed in internal ones, which looks circular. It isn't: the constraint is `hudCss + scale * BOARD_MIN_H <= vh`, which rearranges to a plain upper bound on `scale`. Reserving the band matters — unlike a side-scroller there is no empty sky here, and an unreserved bar sits on the foundations.
- **`BOARD_MIN_H` is the deepest *legal* column, not the current one.** Six face-down plus a 13-card K→A run. Sizing to the board actually on screen would make the whole layout jump every time a column grew.
- **Everything under `--- Elastic vertical layout ---` in `renderer.js` is a live value.** `TOP_ROW_Y`, `TABLEAU_Y`, both offsets and `INTERNAL_H` are rewritten by `applyLayout()` on each resize, and `Renderer.prototype.layout` is the same object rather than a snapshot. Read them; never cache them.

The one case this loses on is a **landscape phone**. A 0.96-aspect board in a 1.9-aspect window fits by height, so the cards come out around 42 px and the sides letterbox. The old framed layout gave 90 px cards there — by overflowing the viewport and making the player scroll the page mid-drag, which is worse for a game whose whole interaction is dragging. Portrait is the orientation this is tuned for.

Undo and New deal are icons rather than labelled buttons: labelled, the pair is about 145 px of a 390 px phone's HUD, which the moves and time chips need more. Both keep an `aria-label`, and New deal already confirms before discarding a deal, so the glyph cannot cost anyone their game.

The page background is the same felt the canvas paints, so the letterbox a wide desktop window leaves is invisible — which is also what makes the crisp-scale snap in `resize()` free. It can hand back up to 8% of the width to land art pixels on whole device pixels, and in the framed layout that showed up as a pair of margins.

Card faces come from [Kenney's Playing Cards Pack](https://kenney.nl/assets/playing-cards-pack) (CC0). They replaced a hand-drawn deck whose 3×5 rank glyphs rendered at roughly 2×4 device pixels on a phone — unreadable, and unfixable without redrawing all 52 faces, since there was no room to make the glyph bigger. Kenney's ranks are 8 px tall and sit clear of `FACE_UP_OFFSET`, so a face-up card's peek strip in a tableau column always shows its whole rank. That is the property the whole deck exists to provide, and it is why the offset now has a **floor** rather than a value: `MIN_FACE_UP_OFFSET` is 14 authored px, which clears the glyph's authored rows (5–12) with a row to spare. The elastic layout only ever grows it. If you change that floor, check it against those rows first.

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

Every UTC day, all players see the same shuffle. The day id is the integer number of UTC days since `2026-01-01`; a seed derived from it is run through a mulberry32 PRNG → Fisher-Yates shuffle. The daily leaderboard (`scores.friends`) is keyed off the **day id**, so every player on a given day lands in the same round.

**The dealt seed is winnability-filtered** (`js/solver.js`). Because everyone shares one daily shuffle, an unwinnable board would break every player's streak at once and leave nobody able to tell a misplay from an impossible deal — so the day id is only the *start* of a deterministic seed sequence, and the deal uses the first seed the solver can actually prove winnable. The search is pure and deterministic, so every device resolves the same seed for a given day. It is sound but not complete: a deal it approves is definitely winnable, while a hard-but-winnable deal may be skipped in favour of the next seed — which biases the daily toward the more tractable end of winnable.

If no seed can be vouched for — `solver.js` missing (a stale or partially-loaded bundle) or the seed sequence exhausted, the latter being effectively unreachable — **the daily is disabled rather than dealt unfiltered**: `findSolvableSeed` returns `null`, `game.newDeal` refuses and returns `false`, and the overlay greys out the daily buttons with an explanation. Random stays fully playable, so the failure degrades the game instead of bricking it.

A **Random deal** button is available too — random deals skip the solver entirely (an unwinnable one costs nothing: no streak, just reroll) and do not contribute to the streak or the daily leaderboard.

## Controls

- **Touch:** drag a card (and any cards stacked on it) to another column or foundation. Tap a tableau-top or waste card to auto-send it to a foundation. Tap the stock to draw; tap the empty stock to recycle the waste.
- **Mouse:** click-and-drag for moves. Click a tableau-top or waste card to auto-send. Same stock/recycle behaviour.
- **Keyboard:** `U` for undo, `R` for new deal, `Space` to draw from stock.

## SDK integration

- `bridge:storage` — `bestTimeMs`, `winStreak`, `savedGame`, `lastDailyId` + `lastDailyWon` so we don't double-count daily completions. `savedGame` is flushed on **both** `lifecycle.pause` and the browser `pagehide` event, so a backgrounded app *or* a hard tab-close mid-deal is resumable on next launch.
- `bridge:share` — user-initiated only. The Share button on the won overlay opens a share modal (copy / native-on-touch / X / Threads / Bluesky / Reddit / WhatsApp / Facebook), mirroring snake + rabbit-words. We never auto-fire share on win — the OS sheet would step on the "I solved it" moment.
- `bridge:scores` — daily deals submit to a per-deal leaderboard (`roundKey = daily-{seed}`). The score inverts solve time (faster = higher; `metadata = { timeMs, moves }`), and the won overlay renders a friends panel from `scores.friends`. Anonymous players get a `requestSignIn` CTA; signed-in players with no friend scores yet get an invite CTA. Random deals have no shared round and skip scores entirely.
- Haptics: `light` on card pickup and successful drop, `error` on rejected drop, `success` on a card sent to foundation, `success` again on the win. Every one of them routes through a single `haptic()` shim, which is the only reason one switch can turn them all off.
- **Vibration toggle** (`hapticsOff` in storage, `"1"` meaning off). Stored separately from the mute setting, because sound and vibration get silenced for different reasons — somewhere quiet versus the buzzing being distracting — and one switch for both would make a player who wants neither give up the other. Inverted so that a missing key, a failed read and an explicit "on" all agree: haptics default to on, and a storage failure must not quietly disable something the player never turned off.

  Shown on **touch devices only**, and deliberately not gated on `capabilities.has('actions.haptic')`. That check is the house pattern for host-dependent UI but the wrong instrument here: the web host declares `actions.haptic` and answers it as a no-op, so gating on it puts the button on desktops where nothing can buzz. The trade is that a player who switches vibration off on their phone can't switch it back on from a desktop; the setting syncs, so their phone still shows it off and can undo it.

  The icon is inline SVG, not an emoji. The two candidate glyphs (`📳` / `📴`) are both orange rounded squares that are near-indistinguishable at 16px, and the orange fights a palette that is otherwise entirely green. Drawn, it inherits `currentColor` and carries a slash, which is the part players actually read. CSS draws the slash off `aria-pressed`, so the visual and accessible states can't drift apart.

- **Sound toggle.** Drawn too, and for the same reason the vibration one is. `🔊` / `🔇` were the one thing in the HUD rendered by the system's emoji font — full-colour, rounded and anti-aliased, sitting between an undo glyph and a moves chip built out of 2px borders and a pixel typeface, and different on every platform. The drawn speaker inherits `currentColor`, so the three icons in the bar are one set. Off is the waves going and the same slash coming across; both are CSS off `aria-pressed`, so `application.js` no longer swaps any glyph — it only sets the ARIA state.
- `OR.lifecycle.on('resume')` is a no-op (the saved state is already on screen).

## Manifest scopes required

- `bridge:storage`
- `bridge:share`
- `bridge:scores`

## Android touch checklist

Drag-heavy game — both rules from the parent README are required. Both are wired in:

- `touch-action: none` on `.game-canvas`, and **only** there. It is the one surface with a gesture on it, and putting it on `html, body` would also catch the leaderboard list inside the won overlay, which has to stay flickable.
- `{ passive: false }` on every `touchstart` / `touchmove` listener in `input_manager.js`.
- `overflow: hidden` and `overscroll-behavior: none` on `html, body`. The renderer fits the whole board into the viewport, so a scroll port would only ever be somewhere to lose the board to — and removing it is also what stops the WebView compositor claiming a drag for scroll, with `overscroll-behavior` covering pull-to-refresh.

## License

MIT — see `LICENSE.txt`.

The Press Start 2P font (`../snake/fonts/press-start-2p-latin.woff2`, reused via the parent build) is © 2012 The Press Start 2P Project Authors, licensed under SIL OFL 1.1.

Card faces in `images/cards.png` are derived from Kenney's Playing Cards Pack (CC0 1.0, [kenney.nl](https://kenney.nl/assets/playing-cards-pack)). CC0 does not require attribution; the credit is here because Kenney asks for it and because redistributed art should say where it came from. The pack's own license text ships as `images/KENNEY-LICENSE.txt`.

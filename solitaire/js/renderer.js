// Canvas renderer. Internal resolution is INTERNAL_W × INTERNAL_H with
// `image-rendering: pixelated` CSS upscale, so all art is hand-placed at
// integer pixel positions and stays crisp on any display.
//
// Each of the 52 card faces is prerendered once into an offscreen canvas,
// then blitted via drawImage on every frame. Card backs, empty-slot ghosts,
// and the stock-recycle icon are cached the same way. This keeps the main
// loop cheap — even on the lowest-tier Android WebView the redraw is one
// fillRect + ~30 drawImage calls per frame.

(function () {
  var Deck = window.SolitaireDeck;

  // --- Layout ---
  //
  // Every card sprite is AUTHORED at CARD_W × CARD_H (the historical 56×80)
  // but PAINTED into an offscreen canvas that is SCALE× larger, through a
  // ctx.scale(SCALE) transform. Each hand-placed 1px becomes a crisp SCALE×
  // SCALE block, so the art reads sharp at the bigger on-board size without a
  // single sprite coordinate changing. The board then lays those scaled
  // sprites out using the post-scale dimensions CW × CH. SCALE is the one
  // knob that makes the cards physically bigger and crisper — bumping it
  // never touches the art code below.
  var SCALE = 2;
  var CARD_W = 56;               // art-authoring card width (sprite internals)
  var CARD_H = 80;               // art-authoring card height
  var CW = CARD_W * SCALE;       // 112 — on-board card width (layout + blits)
  var CH = CARD_H * SCALE;       // 160 — on-board card height

  // Board geometry, in on-board (post-scale) pixels. The old 480×720 portrait
  // crushed seven columns into thumbnail cards and left the bottom half of
  // the felt empty; this is a wide, near-square board sized just tall enough
  // for the longest legal tableau run so the cards can be big.
  var COL_GAP = 12;
  var MARGIN = 22;
  var TOP_ROW_Y = 40;
  var TABLEAU_Y = 220;
  var FACE_DOWN_OFFSET = 12;
  var FACE_UP_OFFSET = 32;
  var INTERNAL_W = 2 * MARGIN + 7 * CW + 6 * COL_GAP;   // 900
  var INTERNAL_H = 860;          // covers TABLEAU_Y + ~6 down + ~12 up + a card

  // 7 column x-positions reused by top row (stock/waste/foundations) and
  // tableau columns. Stock at col 0, waste at col 1, foundations at cols
  // 3–6. The col-2 slot in the top row stays empty by convention — gives
  // visual breathing room between the draw piles and the foundations and
  // matches the original Klondike layout players expect.
  var COL_X = new Array(7);
  for (var c = 0; c < 7; c++) {
    COL_X[c] = MARGIN + c * (CW + COL_GAP);
  }
  var STOCK_X = COL_X[0];
  var WASTE_X = COL_X[1];
  var FOUNDATION_X = [COL_X[3], COL_X[4], COL_X[5], COL_X[6]];

  // --- Palette ---

  // Card-face colours. Cream-ish white is gentle on the light-oak felt and
  // close enough to a deck's actual paper colour. Pip reds and blacks are
  // slightly desaturated to sit on the cream face without clipping
  // visually. Pixel art tradition: never pure 0/255 on warm surfaces.
  var COL_FELT = "#d9b483";          // light-oak table surface (mirrors --wood)
  var COL_FELT_DARK = "#c79a66";     // recessed wood under cards / empty slots
  var COL_CARD = "#f5ecd6";          // cream face
  var COL_CARD_EDGE = "#3a2615";     // dark warm edge / 1px border
  var COL_RED = "#c01818";
  var COL_BLACK = "#1a1a1a";
  var COL_BACK_PRIMARY = "#8a5a30";  // card-back base (warm wood — pops on light felt)
  var COL_BACK_ACCENT = "#5c3a1e";   // darker inner panel
  var COL_CARROT = "#e8893e";
  var COL_CARROT_DARK = "#c45e1a";
  var COL_LEAF = "#5a8c3a";
  // Empty-slot ghost colour: needs to read against the recessed-wood fill we
  // use for empty-slot backgrounds (COL_FELT_DARK #c79a66). A dark wood tone
  // gives the dashed border + recycle arrow real contrast against the lighter
  // recess without competing with the cards laid over them.
  var COL_GHOST = "#8a5a30";
  var COL_RABBIT_BODY = "#fff8e7";
  var COL_RABBIT_EAR = "#f4c2c2";    // pink inner ear
  var COL_RABBIT_NOSE = "#d97a8a";
  var COL_RABBIT_EYE = "#1a1a1a";
  var COL_CROWN = "#f5c84c";
  var COL_CROWN_DARK = "#c8951a";
  var COL_FLOWER = "#e8467c";
  var COL_FLOWER_CENTER = "#f5d56a";
  // Drop-target highlight — pale, warm cream so it pops off the felt
  // without competing with cards. Drawn as a 2px-thick frame around the
  // top card / empty slot of every legal drop target while a drag is in
  // flight, then cleared on drop or cancel.
  var COL_HIGHLIGHT = "#f5d56a";

  // --- Rank glyphs (3×5 pixel font) ---

  // Hand-rolled 3-wide × 5-tall digit/letter glyphs. Press Start 2P would
  // get us anti-aliasing trouble at this nominal size (8px renders as ~6px
  // visible against image-rendering: pixelated), so we ship our own
  // pixel font for the rank corners. Each row is exactly 3 chars; 'O' is
  // filled, '.' is transparent.
  var RANK_GLYPHS = {
    // Ace
    "A": [".O.", "O.O", "OOO", "O.O", "O.O"],
    // Numbers 2-9
    "2": ["OO.", "..O", ".O.", "O..", "OOO"],
    "3": ["OO.", "..O", ".OO", "..O", "OO."],
    "4": ["O.O", "O.O", "OOO", "..O", "..O"],
    "5": ["OOO", "O..", "OO.", "..O", "OO."],
    "6": [".OO", "O..", "OO.", "O.O", ".O."],
    "7": ["OOO", "..O", ".O.", ".O.", ".O."],
    "8": [".O.", "O.O", ".O.", "O.O", ".O."],
    "9": [".O.", "O.O", ".OO", "..O", "OO."],
    // Court — designed at 3×5 so they share footprint with the digits.
    // J: top bar, vertical right, curved hook at the bottom-left.
    // Q: rounded oval with a tail trailing bottom-right.
    // K: vertical left bar with a < angled to the right.
    J: ["OOO", "..O", "..O", "O.O", ".O."],
    Q: [".O.", "O.O", "O.O", "OOO", "..O"],
    K: ["O.O", "OO.", "O..", "OO.", "O.O"],
    // 0/1 are never produced by rankKey (ten renders via the "10" special
    // case in drawRankAt) — they exist for the stock pile-depth counter.
    "0": ["OOO", "O.O", "O.O", "O.O", "OOO"],
    "1": [".O.", "OO.", ".O.", ".O.", "OOO"],
  };

  // Map a rank 0..12 to the glyph key used above. Rank 0 is the ace; ranks
  // 1..8 map to "2".."9" (the literal digit chars). Rank 9 is ten (special
  // — drawn as two stacked digits to fit the 3-wide corner). 10/11/12 are
  // J/Q/K.
  function rankKey(rank) {
    if (rank === 0) return "A";
    if (rank >= 1 && rank <= 8) return String(rank + 1);
    if (rank === 9) return "10";
    if (rank === 10) return "J";
    if (rank === 11) return "Q";
    return "K";
  }

  // --- Suit pip sprites (9×9 pixel art) ---

  // Heart, diamond, spade, club at 9x9. Each row is exactly 9 chars; 'O'
  // is filled with the suit colour, '.' is transparent. Order matches
  // Deck.SUIT_* constants (clubs, diamonds, hearts, spades).
  var SUIT_SPRITES = [
    // Clubs — three round lobes (top + left + right) over a stem and splayed
    // base. The previous sprite tapered to a point and merged the lobes into
    // one mass, which made clubs nearly indistinguishable from spades at card
    // size. This one keeps a flat-round top lobe and cuts notches on row 3
    // (top lobe vs side lobes) and row 6 (side lobes vs stem) so the trefoil
    // silhouette survives the small scale.
    [
      "...OOO...",
      "..OOOOO..",
      "..OOOOO..",
      "OO.OOO.OO",
      "OOOOOOOOO",
      "OOOOOOOOO",
      ".OO.O.OO.",
      "...OOO...",
      "..OO.OO..",
    ],
    // Diamonds
    [
      "....O....",
      "...OOO...",
      "..OOOOO..",
      ".OOOOOOO.",
      "OOOOOOOOO",
      ".OOOOOOO.",
      "..OOOOO..",
      "...OOO...",
      "....O....",
    ],
    // Hearts — two distinct lobe tops with a clean V-dip between them, then
    // the body rounds straight into the point. The old sprite had a stray
    // pixel in the dip plus three full-width rows that read as a rectangle.
    [
      ".OO...OO.",
      "OOOO.OOOO",
      "OOOOOOOOO",
      "OOOOOOOOO",
      ".OOOOOOO.",
      "..OOOOO..",
      "...OOO...",
      "....O....",
      ".........",
    ],
    // Spades
    [
      "....O....",
      "...OOO...",
      "..OOOOO..",
      ".OOOOOOO.",
      "OOOOOOOOO",
      "OOOOOOOOO",
      "...OOO...",
      "..OO.OO..",
      ".OO...OO.",
    ],
  ];

  // --- Sprite painter ---

  // Generic 1-bit pixel sprite painter. `sprite` is an array of equal-
  // length strings; 'O' draws a pixel of `color`, anything else is
  // transparent. Used by suit pips and rank glyphs alike.
  function paintMonoSprite(ctx, sprite, x, y, color) {
    ctx.fillStyle = color;
    for (var row = 0; row < sprite.length; row++) {
      var line = sprite[row];
      for (var col = 0; col < line.length; col++) {
        if (line.charAt(col) === "O") {
          ctx.fillRect(x + col, y + row, 1, 1);
        }
      }
    }
  }

  // --- Card face composition ---

  // Build one card face into a fresh offscreen canvas. Called 52 times at
  // boot, cached in `Renderer._cardSprites`. The returned canvas can be
  // blitted directly via drawImage.
  function buildCardFace(card) {
    var suit = Deck.suitOf(card);
    var rank = Deck.rankOf(card);
    var key = rankKey(rank);
    var pipColor = (suit === Deck.SUIT_DIAMONDS || suit === Deck.SUIT_HEARTS) ? COL_RED : COL_BLACK;

    var off = document.createElement("canvas");
    off.width = CW;
    off.height = CH;
    var ctx = off.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.scale(SCALE, SCALE);

    // Cream body + 1px dark edge frame.
    ctx.fillStyle = COL_CARD;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    ctx.fillStyle = COL_CARD_EDGE;
    ctx.fillRect(0, 0, CARD_W, 1);
    ctx.fillRect(0, CARD_H - 1, CARD_W, 1);
    ctx.fillRect(0, 0, 1, CARD_H);
    ctx.fillRect(CARD_W - 1, 0, 1, CARD_H);
    // Corner pixels removed to fake a rounded card. 1px tucks at each
    // corner; the underlying felt shows through.
    ctx.clearRect(0, 0, 1, 1);
    ctx.clearRect(CARD_W - 1, 0, 1, 1);
    ctx.clearRect(0, CARD_H - 1, 1, 1);
    ctx.clearRect(CARD_W - 1, CARD_H - 1, 1, 1);

    // Top-left rank + pip stack. Rank glyph: 3-wide for A/digits; 6-wide
    // for "10" (drawn as 1+0 side-by-side). Suit pip 9x9 sits below.
    var cornerX = 4;
    var cornerY = 4;
    drawRankAt(ctx, key, cornerX, cornerY, pipColor);
    paintMonoSprite(ctx, SUIT_SPRITES[suit], cornerX - 1, cornerY + 7, pipColor);

    // Bottom-right mirrored rank + pip (no rotation — easier to read for
    // mobile-sized cards than upside-down corners, and matches several
    // modern decks).
    var brX = CARD_W - 4 - rankWidth(key);
    var brY = CARD_H - 4 - 5;
    drawRankAt(ctx, key, brX, brY, pipColor);
    paintMonoSprite(ctx, SUIT_SPRITES[suit], brX - 1, brY - 11, pipColor);

    // Center art varies by rank.
    if (rank === 0) {
      // Ace: one big centered pip, 2x-scaled. We re-paint the pip larger
      // by drawing each sprite "pixel" as a 2x2 block.
      paintMonoSpriteScaled(ctx, SUIT_SPRITES[suit], 19, 30, pipColor, 2);
    } else if (rank >= 1 && rank <= 9) {
      // 2-10: arrange small pips per traditional layout. layoutPipPositions
      // returns center coords for the count.
      var count = rank + 1;
      var positions = pipLayout(count);
      for (var p = 0; p < positions.length; p++) {
        // Pip region is inset clear of the corner rank+pip stacks: pips span
        // cols 12-43 and rows 15-65, so the unit-square layout can never
        // collide with the top-left stack (cols ≤ 11) or the bottom-right
        // one (cols ≥ 45, rows ≥ 60). The old near-full-card span overprinted
        // the bottom-right rank digit on every 4-10.
        var px = Math.round(positions[p][0] * 23) + 12;
        var py = Math.round(positions[p][1] * 42) + 15;
        paintMonoSprite(ctx, SUIT_SPRITES[suit], px, py, pipColor);
      }
    } else {
      // J / Q / K: pixel rabbit court card.
      drawCourtRabbit(ctx, rank, suit, pipColor);
    }

    return off;
  }

  // Rank glyph width in pixels. "10" is the only multi-char case: the "1"
  // paints at col 0 (the sprite reserves col 1 but it's empty) and the "0"
  // paints at cols 3–5, so the visible footprint runs col 0 to col 5 — 6
  // wide, not 7. Returning 7 used to nudge the bottom-right "10" one pixel
  // further left than every other rank, since brX = CARD_W - 4 - width.
  function rankWidth(key) {
    return key === "10" ? 6 : 3;
  }

  function drawRankAt(ctx, key, x, y, color) {
    if (key === "10") {
      // "1" is drawn narrower (just the vertical bar) so the two chars
      // share a 7-wide footprint without overlapping.
      var one = ["O.", "O.", "O.", "O.", "O."];
      var zero = ["OOO", "O.O", "O.O", "O.O", "OOO"];
      paintMonoSprite(ctx, one, x, y, color);
      paintMonoSprite(ctx, zero, x + 3, y, color);
      return;
    }
    var glyph = RANK_GLYPHS[key];
    if (!glyph) return;
    paintMonoSprite(ctx, glyph, x, y, color);
  }

  function paintMonoSpriteScaled(ctx, sprite, x, y, color, scale) {
    ctx.fillStyle = color;
    for (var row = 0; row < sprite.length; row++) {
      var line = sprite[row];
      for (var col = 0; col < line.length; col++) {
        if (line.charAt(col) === "O") {
          ctx.fillRect(x + col * scale, y + row * scale, scale, scale);
        }
      }
    }
  }

  // Classic Klondike pip layout. Returns an array of [x, y] in the unit
  // square [0..1]^2, suitable for scaling to a card's pip region. The
  // layouts here mirror what you'd see on a Bicycle deck — 2 is top+
  // bottom, 3 adds a middle, etc.
  function pipLayout(n) {
    switch (n) {
      case 2:  return [[0.5, 0], [0.5, 1]];
      case 3:  return [[0.5, 0], [0.5, 0.5], [0.5, 1]];
      case 4:  return [[0, 0], [1, 0], [0, 1], [1, 1]];
      case 5:  return [[0, 0], [1, 0], [0.5, 0.5], [0, 1], [1, 1]];
      case 6:  return [[0, 0], [1, 0], [0, 0.5], [1, 0.5], [0, 1], [1, 1]];
      case 7:  return [[0, 0], [1, 0], [0.5, 0.25], [0, 0.5], [1, 0.5], [0, 1], [1, 1]];
      case 8:  return [[0, 0], [1, 0], [0.5, 0.25], [0, 0.5], [1, 0.5], [0.5, 0.75], [0, 1], [1, 1]];
      case 9:  return [[0, 0], [1, 0], [0, 0.33], [1, 0.33], [0.5, 0.5], [0, 0.66], [1, 0.66], [0, 1], [1, 1]];
      case 10: return [[0, 0], [1, 0], [0.5, 0.17], [0, 0.33], [1, 0.33], [0, 0.66], [1, 0.66], [0.5, 0.83], [0, 1], [1, 1]];
      default: return [];
    }
  }

  // --- Pixel rabbit court cards ---

  // J/Q/K all share the same rabbit head silhouette; the rank flag tweaks
  // the accessory (J: jester ear-flop, Q: flower, K: crown). Centered in
  // the card; small enough to leave the corner glyphs and a thin suit-
  // colour banner along the head's frame border.
  //
  // Outlining strategy: each rabbit slab is drawn twice — once in the
  // dark warm outline colour at +1 px in every direction, then in cream
  // at full size. Adjacent slabs are arranged to overlap by 1 px on the
  // shared edge so the outline never shows as an internal seam, only at
  // the silhouette perimeter.
  function drawCourtRabbit(ctx, rank, suit, pipColor) {
    // Suit-tinted portrait banner inside the card body.
    var tint = (pipColor === COL_RED) ? "#f0c8c8" : "#d8d4d0";
    ctx.fillStyle = tint;
    ctx.fillRect(9, 14, CARD_W - 18, CARD_H - 28);
    ctx.fillStyle = pipColor;
    ctx.fillRect(9, 14, CARD_W - 18, 1);
    ctx.fillRect(9, CARD_H - 15, CARD_W - 18, 1);
    ctx.fillRect(9, 14, 1, CARD_H - 28);
    ctx.fillRect(CARD_W - 10, 14, 1, CARD_H - 28);

    var cx = 28;          // rabbit horizontal centre inside the portrait
    var headTopY = 24;    // top of the head silhouette

    // -- Outline pass (dark warm, drawn under the cream so the perimeter
    //    pixels remain visible after the cream slab is laid down) --
    ctx.fillStyle = COL_CARD_EDGE;
    // Ears. Left always vertical; right vertical for Q/K, jester-bent for
    // J — the tip kinks 4 px right and curls back across to dramatize the
    // ear-flop. Bigger kink than the original so the J reads as J even at
    // tableau scale where the corner glyph is tiny.
    ctx.fillRect(cx - 9, headTopY - 15, 6, 17);            // left ear outline
    if (rank === 10) {
      ctx.fillRect(cx + 3, headTopY - 4, 6, 6);            // base (short stub)
      ctx.fillRect(cx + 6, headTopY - 10, 6, 8);           // mid-bend
      ctx.fillRect(cx + 9, headTopY - 14, 6, 6);           // tip flopped out to the right
    } else {
      ctx.fillRect(cx + 3, headTopY - 15, 6, 17);          // right ear outline
    }
    // Head + body silhouette, slab by slab. The slabs overlap on every
    // shared y by 1 row in the cream pass so this dark fill stays hidden
    // at internal seams.
    ctx.fillRect(cx - 9, headTopY - 1, 18, 5);             // forehead
    ctx.fillRect(cx - 10, headTopY + 2, 20, 11);           // mid head (widest)
    ctx.fillRect(cx - 9, headTopY + 11, 18, 5);            // chin
    ctx.fillRect(cx - 7, headTopY + 14, 14, 3);            // jaw bottom
    ctx.fillRect(cx - 8, headTopY + 16, 16, 4);            // upper body
    ctx.fillRect(cx - 9, headTopY + 19, 18, 7);            // chest
    ctx.fillRect(cx - 8, headTopY + 25, 16, 4);            // lower body / feet

    // -- Cream body pass (overlapping slabs so the dark outline pass
    //    only survives at the perimeter) --
    ctx.fillStyle = COL_RABBIT_BODY;
    // Ears.
    ctx.fillRect(cx - 8, headTopY - 14, 4, 15);
    if (rank === 10) {
      // J's three-segment jester ear. Each cream slab is extended by 1 row
      // toward its neighbour so the kink between segments shows as a clean
      // 1-px outline, not a chunky 4-5-wide dark block (the bottom of the
      // mid-bend slab overlapping the top of the next slab's outline).
      ctx.fillRect(cx + 4, headTopY - 4, 4, 6);            // base stub (extended up 1 row toward mid)
      ctx.fillRect(cx + 7, headTopY - 10, 4, 8);           // mid bend (extended 1 row each way)
      // Tip shares its left column with the mid-bend slab (rows -10..-9) so
      // the cream connects through the kink — one column further right the
      // segments only touched diagonally and the tip floated as a detached
      // block.
      ctx.fillRect(cx + 10, headTopY - 13, 4, 5);          // floppy tip
    } else {
      ctx.fillRect(cx + 4, headTopY - 14, 4, 15);
    }
    // Head + body slabs, each overlapping the next by 1 row in y.
    ctx.fillRect(cx - 8, headTopY, 16, 4);                 // forehead
    ctx.fillRect(cx - 9, headTopY + 3, 18, 10);            // mid head (overlaps forehead at headTopY+3)
    ctx.fillRect(cx - 8, headTopY + 12, 16, 4);            // chin (overlaps mid head at headTopY+12)
    ctx.fillRect(cx - 6, headTopY + 15, 12, 2);            // jaw bottom
    ctx.fillRect(cx - 7, headTopY + 17, 14, 3);            // upper body (overlaps jaw at headTopY+17)
    ctx.fillRect(cx - 8, headTopY + 20, 16, 6);            // chest
    ctx.fillRect(cx - 7, headTopY + 26, 14, 3);            // lower body

    // -- Pink inner-ear stripes --
    ctx.fillStyle = COL_RABBIT_EAR;
    ctx.fillRect(cx - 7, headTopY - 12, 2, 12);
    if (rank === 10) {
      ctx.fillRect(cx + 5, headTopY - 2, 2, 4);            // pink in base stub
      ctx.fillRect(cx + 8, headTopY - 8, 2, 4);            // pink in mid bend
      ctx.fillRect(cx + 11, headTopY - 11, 2, 3);          // pink in floppy tip
    } else {
      ctx.fillRect(cx + 5, headTopY - 12, 2, 12);
    }

    // -- Eyes (2px squares with a 1px cream highlight on the upper-left) --
    ctx.fillStyle = COL_RABBIT_EYE;
    ctx.fillRect(cx - 5, headTopY + 5, 2, 2);
    ctx.fillRect(cx + 3, headTopY + 5, 2, 2);
    ctx.fillStyle = COL_RABBIT_BODY;
    ctx.fillRect(cx - 5, headTopY + 5, 1, 1);
    ctx.fillRect(cx + 3, headTopY + 5, 1, 1);

    // -- Nose (small pink triangle) --
    ctx.fillStyle = COL_RABBIT_NOSE;
    ctx.fillRect(cx - 2, headTopY + 9, 4, 1);
    ctx.fillRect(cx - 1, headTopY + 10, 2, 1);

    // -- Mouth (two pink pixels making a tiny smile) --
    ctx.fillRect(cx - 2, headTopY + 12, 1, 1);
    ctx.fillRect(cx + 1, headTopY + 12, 1, 1);

    // -- Accessory --
    if (rank === 11) {
      // Q: flower tucked beside the left ear. cx-16 keeps the flower's
      // 7-wide middle row clear of the ear at col cx-9 (was cx-14, which
      // overlapped 2 cols into the ear and overwrote its left outline +
      // cream interior with flower pink).
      drawFlower(ctx, cx - 16, headTopY - 11);
    } else if (rank === 12) {
      // K: crown sitting on the forehead between the ear roots.
      drawCrown(ctx, cx - 9, headTopY - 5);
    }

    // The four corner glyphs (rank + pip in each diagonal pair) already
    // identify the suit; an extra in-banner pip near the bottom-right used
    // to live here, but at this card size it sat right above the bottom-
    // right corner glyph and read as the inner banner's own corner — making
    // J/Q/K look like a card-within-a-card. Removed.
  }

  // 18×7 crown — three main peaks with gold finial balls, a base band with
  // dark shadow under it, and a red centre gem. Outlined under-and-around
  // in the same dark warm as the rabbit so it sits as part of the silhouette
  // rather than floating on top.
  function drawCrown(ctx, x, y) {
    // Outline silhouette.
    ctx.fillStyle = COL_CARD_EDGE;
    ctx.fillRect(x - 1, y + 2, 20, 5);          // base band outline
    ctx.fillRect(x - 1, y - 2, 5, 5);           // left peak
    ctx.fillRect(x + 6, y - 3, 6, 6);           // centre peak
    ctx.fillRect(x + 13, y - 2, 5, 5);          // right peak
    // Gold fills inside the outline.
    ctx.fillStyle = COL_CROWN;
    ctx.fillRect(x, y + 3, 18, 3);              // base band
    ctx.fillRect(x, y - 1, 3, 4);               // left peak
    ctx.fillRect(x + 7, y - 2, 4, 5);           // centre peak
    ctx.fillRect(x + 15, y - 1, 3, 4);          // right peak
    // Finial balls atop the outer peaks.
    ctx.fillRect(x + 1, y - 2, 1, 1);
    ctx.fillRect(x + 16, y - 2, 1, 1);
    // Darker gold under-band shadow gives the crown thickness.
    ctx.fillStyle = COL_CROWN_DARK;
    ctx.fillRect(x, y + 5, 18, 1);
    // Centre red gem.
    ctx.fillStyle = COL_RED;
    ctx.fillRect(x + 8, y + 3, 2, 2);
  }

  // 7×7 flower with five distinct petals around a yellow centre. Outline
  // sits 1 px around the petals so the bloom reads as its own shape
  // against the rabbit ear behind it.
  function drawFlower(ctx, x, y) {
    ctx.fillStyle = COL_CARD_EDGE;
    // Petal outline silhouette.
    ctx.fillRect(x + 2, y - 1, 3, 1);           // top petal
    ctx.fillRect(x + 1, y, 5, 3);
    ctx.fillRect(x, y + 2, 7, 3);               // mid row (left + right petals + centre)
    ctx.fillRect(x + 1, y + 5, 5, 2);
    ctx.fillRect(x + 2, y + 7, 3, 1);           // bottom petal
    // Petal fills.
    ctx.fillStyle = COL_FLOWER;
    ctx.fillRect(x + 2, y, 3, 2);               // top
    ctx.fillRect(x, y + 3, 2, 2);               // left
    ctx.fillRect(x + 5, y + 3, 2, 2);           // right
    ctx.fillRect(x + 1, y + 5, 2, 2);           // bottom-left
    ctx.fillRect(x + 4, y + 5, 2, 2);           // bottom-right
    // Yellow centre disc.
    ctx.fillStyle = COL_FLOWER_CENTER;
    ctx.fillRect(x + 2, y + 2, 3, 3);
  }

  // --- Card back ---

  // Carrot-tiled card back. 4 carrots arranged 2×2 against the dark-green
  // back colour, with a thin cream border so the back reads as "stacked
  // card edge" at small sizes.
  function buildCardBack() {
    var off = document.createElement("canvas");
    off.width = CW;
    off.height = CH;
    var ctx = off.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = COL_BACK_PRIMARY;
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    // Inner darker rectangle — 2px in from the edge.
    ctx.fillStyle = COL_BACK_ACCENT;
    ctx.fillRect(3, 3, CARD_W - 6, CARD_H - 6);

    // 2x2 grid of carrot sprites. Each sprite is roughly 12 wide × 16 tall.
    // The top pair sits at y=2 — high enough that the carrot leaves (rows
    // 0–3 of the sprite) land inside the 6px FACE_DOWN_OFFSET peek window.
    // Without this lift, a stacked face-down column shows only the cream
    // edge + warm-brown band + dark accent (all flat), and the back motif
    // never reads. With it, every face-down peek shows two green leaf
    // tufts and the column looks like a deck of cards. The bottom pair
    // stays put — they only need to look right on the unstacked top of
    // the stock pile.
    drawCarrotSprite(ctx, 7, 2);
    drawCarrotSprite(ctx, CARD_W - 19, 2);
    drawCarrotSprite(ctx, 7, CARD_H - 25);
    drawCarrotSprite(ctx, CARD_W - 19, CARD_H - 25);

    // Cream edge.
    ctx.fillStyle = COL_CARD;
    ctx.fillRect(0, 0, CARD_W, 1);
    ctx.fillRect(0, CARD_H - 1, CARD_W, 1);
    ctx.fillRect(0, 0, 1, CARD_H);
    ctx.fillRect(CARD_W - 1, 0, 1, CARD_H);
    // Round the corners by clearing single pixels.
    ctx.clearRect(0, 0, 1, 1);
    ctx.clearRect(CARD_W - 1, 0, 1, 1);
    ctx.clearRect(0, CARD_H - 1, 1, 1);
    ctx.clearRect(CARD_W - 1, CARD_H - 1, 1, 1);
    return off;
  }

  // Reused from snake's carrot sprite philosophy — leaves on top, tapered
  // body, single highlight pixel. Tuned to fit a 12×16 footprint.
  function drawCarrotSprite(ctx, x, y) {
    // Leaves
    ctx.fillStyle = COL_LEAF;
    ctx.fillRect(x + 4, y, 1, 3);
    ctx.fillRect(x + 6, y, 1, 3);
    ctx.fillRect(x + 5, y + 1, 1, 3);
    ctx.fillRect(x + 3, y + 3, 5, 1);
    // Body
    ctx.fillStyle = COL_CARROT_DARK;
    ctx.fillRect(x + 4, y + 4, 3, 1);
    ctx.fillRect(x + 3, y + 5, 5, 2);
    ctx.fillRect(x + 4, y + 7, 3, 2);
    ctx.fillRect(x + 4, y + 9, 2, 2);
    ctx.fillRect(x + 5, y + 11, 1, 1);
    // Highlight
    ctx.fillStyle = COL_CARROT;
    ctx.fillRect(x + 4, y + 5, 1, 1);
  }

  // --- Empty-slot sprites ---

  // Foundation ghost: a faded suit pip on a darker rectangle, telling the
  // player "any of this suit goes here". We build 4 — one per suit slot.
  // (The player can place any suit in any slot — Klondike doesn't require
  // a pre-committed mapping — but showing a different pip in each slot
  // would mislead. We just draw a ghost of *whatever* shape is currently
  // there: empty → no pip at all, just the outline.)
  function buildEmptyFoundation() {
    var off = document.createElement("canvas");
    off.width = CW;
    off.height = CH;
    var ctx = off.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.scale(SCALE, SCALE);
    drawEmptyOutline(ctx);
    return off;
  }

  // Stock-recycle ghost — a circular arrow icon, telling the player a tap
  // here flips the waste back into the stock.
  function buildEmptyStock() {
    var off = document.createElement("canvas");
    off.width = CW;
    off.height = CH;
    var ctx = off.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.scale(SCALE, SCALE);
    drawEmptyOutline(ctx);
    // Circular arrow — half-ring + arrowhead. Simple 16×16 sprite centered.
    ctx.fillStyle = COL_GHOST;
    var cx = CARD_W / 2;
    var cy = CARD_H / 2;
    // Arc from just past 3 o'clock around to the upper-right, leaving a real
    // gap for the arrowhead. (The old bounds 0.15π..2.2π spanned more than a
    // full turn, so the ring drew closed and the arrowhead vanished into it.)
    for (var a = Math.PI * 0.05; a < Math.PI * 1.7; a += 0.18) {
      var rx = Math.round(cx + Math.cos(a) * 9);
      var ry = Math.round(cy + Math.sin(a) * 9);
      ctx.fillRect(rx, ry, 2, 2);
    }
    // Arrowhead — stepped solid triangle at the arc's end, pointing
    // clockwise (down-right) into the gap.
    ctx.fillRect(cx + 1, cy - 10, 6, 2);
    ctx.fillRect(cx + 3, cy - 8, 4, 2);
    ctx.fillRect(cx + 5, cy - 6, 2, 2);
    return off;
  }

  // Generic empty-card outline — dashed border on a recessed-wood fill,
  // used for both foundation slots and the empty stock.
  function drawEmptyOutline(ctx) {
    ctx.fillStyle = COL_FELT_DARK;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    ctx.fillStyle = COL_GHOST;
    // Dashed border — 3px dashes with 2px gaps along each edge.
    for (var x = 2; x < CARD_W - 2; x += 5) {
      ctx.fillRect(x, 1, 3, 1);
      ctx.fillRect(x, CARD_H - 2, 3, 1);
    }
    for (var y = 2; y < CARD_H - 2; y += 5) {
      ctx.fillRect(1, y, 1, 3);
      ctx.fillRect(CARD_W - 2, y, 1, 3);
    }
  }

  // --- Renderer ---

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    canvas.width = INTERNAL_W;
    canvas.height = INTERNAL_H;

    // Sprite cache.
    this._cardSprites = new Array(Deck.DECK_SIZE);
    for (var i = 0; i < Deck.DECK_SIZE; i++) {
      this._cardSprites[i] = buildCardFace(i);
    }
    this._cardBack = buildCardBack();
    this._emptyFoundation = buildEmptyFoundation();
    this._emptyStock = buildEmptyStock();

    // Frame state (set per draw call).
    this._lastBoard = null;
    this._lastDrag = null;
  }

  Renderer.INTERNAL_W = INTERNAL_W;
  Renderer.INTERNAL_H = INTERNAL_H;
  Renderer.CARD_W = CW;
  Renderer.CARD_H = CH;
  // Exported so application.js paints the same felt on the pre-deal canvas
  // (it previously hardcoded a stale dark-wood hex that didn't match).
  Renderer.COL_FELT = COL_FELT;

  // Repaint the entire scene.
  //   dragState (optional): { source, pointer:{x,y}, offset:{x,y},
  //                           cards:[int...] }
  //   legalTargets (optional): array of { kind, col? index? } locations
  //                            that are valid drop sites for the current
  //                            drag — painted as highlight frames so the
  //                            player sees where the moving stack can land.
  Renderer.prototype.draw = function (board, dragState, legalTargets) {
    this._lastBoard = board;
    this._lastDrag = dragState || null;
    var ctx = this.ctx;

    // Felt background.
    ctx.fillStyle = COL_FELT;
    ctx.fillRect(0, 0, INTERNAL_W, INTERNAL_H);

    // Stock / waste / foundations / tableau.
    this._drawStock(board, dragState);
    this._drawWaste(board, dragState);
    this._drawFoundations(board, dragState);
    this._drawTableau(board, dragState);

    // Drop-target highlights sit above the pile art but below the drag
    // preview, so the moving cards float over the highlight as the
    // player approaches a legal slot.
    if (legalTargets && legalTargets.length) {
      this._drawHighlights(board, dragState, legalTargets);
    }

    // Drag preview last so it sits on top of everything.
    if (dragState && dragState.cards && dragState.cards.length) {
      this._drawDragPreview(dragState);
    }
  };

  // Pale 2px frame around a card-shaped rect. Four fillRect calls keep
  // it cheap to repaint every pointermove. The pulse animation that
  // tempted me here would be nice but would force a 60fps redraw loop;
  // skipping for now — the static frame is enough signal.
  Renderer.prototype._drawHighlights = function (board, dragState, targets) {
    var ctx = this.ctx;
    ctx.fillStyle = COL_HIGHLIGHT;
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var rect = this._targetRect(board, t);
      if (!rect) continue;
      // 2px frame.
      ctx.fillRect(rect.x - 1, rect.y - 1, rect.w + 2, 2);             // top
      ctx.fillRect(rect.x - 1, rect.y + rect.h - 1, rect.w + 2, 2);    // bottom
      ctx.fillRect(rect.x - 1, rect.y - 1, 2, rect.h + 2);             // left
      ctx.fillRect(rect.x + rect.w - 1, rect.y - 1, 2, rect.h + 2);    // right
    }
  };

  // Where would the moving stack land for this drop target? Returns the
  // top-card rect (or empty-slot rect) — what the player needs to see
  // outlined.
  Renderer.prototype._targetRect = function (board, target) {
    if (target.kind === "foundation") {
      return { x: FOUNDATION_X[target.index], y: TOP_ROW_Y, w: CW, h: CH };
    }
    if (target.kind === "tableau") {
      // Highlight targets never include the drag's own source column (the
      // legal-target list excludes it), so the top card here is always a real
      // landing spot — no need to account for a suppressed source slice.
      var stack = board.tableau[target.col];
      if (!stack || stack.length === 0) {
        return { x: COL_X[target.col], y: TABLEAU_Y, w: CW, h: CH };
      }
      return { x: COL_X[target.col], y: this._cardYAt(target.col, stack.length - 1, board), w: CW, h: CH };
    }
    return null;
  };

  Renderer.prototype._drawStock = function (board) {
    var x = STOCK_X;
    var y = TOP_ROW_Y;
    if (board.stock.length === 0) {
      this.ctx.drawImage(this._emptyStock, x, y);
    } else {
      // Stacked-stock indicator — a second card-back peeking out diagonally
      // up-left when there's depth, then the real top on top of it. The
      // diagonal offset shows two edges of the card beneath (top + left) so
      // it reads as a stacked deck; a horizontal-only offset exposed just a
      // cream sliver that read as a rendering artifact.
      if (board.stock.length > 1) this.ctx.drawImage(this._cardBack, x - 4, y - 4);
      this.ctx.drawImage(this._cardBack, x, y);
      // Pile-depth count in the gap under the top row, so players can see
      // how many draws remain before the next recycle.
      this._drawPileCount(board.stock.length, x + CW / 2, TOP_ROW_Y + CH + 6);
    }
  };

  // Small pixel number centered under a pile. Digits reuse the 3×5 rank-
  // glyph font at the same SCALE as the card corners; drawn in the ghost
  // colour so the badge reads as a table marking, not a card.
  Renderer.prototype._drawPileCount = function (n, centerX, y) {
    var str = String(n);
    var w = (str.length * 4 - 1) * SCALE; // 3px digits + 1px gaps
    var x = Math.round(centerX - w / 2);
    for (var i = 0; i < str.length; i++) {
      var glyph = RANK_GLYPHS[str.charAt(i)];
      if (!glyph) continue;
      paintMonoSpriteScaled(this.ctx, glyph, x, y, COL_GHOST, SCALE);
      x += 4 * SCALE;
    }
  };

  Renderer.prototype._drawWaste = function (board, dragState) {
    if (board.waste.length === 0) return;
    var x = WASTE_X;
    var y = TOP_ROW_Y;
    // Show only the top card. If the drag source IS the waste, suppress
    // the top card and show whatever is beneath.
    var suppressTop = dragState && dragState.source && dragState.source.kind === "waste";
    var topIdx = suppressTop ? board.waste.length - 2 : board.waste.length - 1;
    if (topIdx < 0) return;
    this.ctx.drawImage(this._cardSprites[board.waste[topIdx]], x, y);
  };

  Renderer.prototype._drawFoundations = function (board, dragState) {
    for (var i = 0; i < 4; i++) {
      var x = FOUNDATION_X[i];
      var y = TOP_ROW_Y;
      var pile = board.foundations[i];
      var suppressTop = dragState && dragState.source && dragState.source.kind === "foundation" && dragState.source.index === i;
      var topIdx = suppressTop ? pile.length - 2 : pile.length - 1;
      if (topIdx < 0) {
        this.ctx.drawImage(this._emptyFoundation, x, y);
      } else {
        this.ctx.drawImage(this._cardSprites[pile[topIdx]], x, y);
      }
    }
  };

  Renderer.prototype._drawTableau = function (board, dragState) {
    for (var col = 0; col < 7; col++) {
      var stack = board.tableau[col];
      var hidden = board.tableauHidden[col];
      var x = COL_X[col];
      // Cards being dragged are suppressed from their home column. When the
      // drag source is this column, only paint up to (but excluding) the
      // source index.
      var paintCount = stack.length;
      if (dragState && dragState.source && dragState.source.kind === "tableau" && dragState.source.col === col) {
        paintCount = Math.min(paintCount, dragState.source.index);
      }
      if (paintCount === 0) {
        // Empty column placeholder.
        this.ctx.drawImage(this._emptyFoundation, x, TABLEAU_Y);
        continue;
      }
      for (var i = 0; i < paintCount; i++) {
        var y = this._cardYAt(col, i, board);
        if (i < hidden) {
          this.ctx.drawImage(this._cardBack, x, y);
        } else {
          this.ctx.drawImage(this._cardSprites[stack[i]], x, y);
        }
      }
    }
  };

  // Card-y math for a tableau column given the hidden-count. Pulled out
  // because both draw and hit-test need it.
  Renderer.prototype._cardYAt = function (col, index, board) {
    var hidden = board.tableauHidden[col];
    if (index < hidden) {
      return TABLEAU_Y + index * FACE_DOWN_OFFSET;
    }
    return TABLEAU_Y + hidden * FACE_DOWN_OFFSET + (index - hidden) * FACE_UP_OFFSET;
  };

  Renderer.prototype._drawDragPreview = function (dragState) {
    var px = dragState.pointer.x - dragState.offset.x;
    var py = dragState.pointer.y - dragState.offset.y;
    // Subtle shadow under the stack. Only the L-shaped strip that pokes
    // past the bottom card's right and bottom edges is actually visible —
    // the rest of the stack-sized rectangle would just be hidden under the
    // cards. We paint exactly that L so the shadow reads as a drop shadow
    // and not as a faint tint visible at the card edges.
    var stackH = CH + (dragState.cards.length - 1) * FACE_UP_OFFSET;
    this.ctx.fillStyle = "rgba(0,0,0,0.25)";
    // Right-edge strip (3 px wide, from top of stack to its full bottom).
    this.ctx.fillRect(px + CW, py + 6, 3, stackH);
    // Bottom-edge strip (6 px tall, under the bottom card only).
    this.ctx.fillRect(px + 3, py + stackH, CW, 6);
    for (var i = 0; i < dragState.cards.length; i++) {
      this.ctx.drawImage(this._cardSprites[dragState.cards[i]], px, py + i * FACE_UP_OFFSET);
    }
  };

  // --- Hit testing ---

  // Map an internal-canvas coordinate to a logical location:
  //   { kind: "stock" }
  // | { kind: "waste" }
  // | { kind: "foundation", index }
  // | { kind: "tableau", col, index }
  // Returns null if outside any pile.
  //
  // For tableau columns we walk top-of-stack first so the topmost (most
  // recently dealt) card wins when y falls inside multiple overlapping
  // card rects.
  Renderer.prototype.hitTest = function (x, y) {
    // Top row: stock + waste + foundations.
    if (y >= TOP_ROW_Y && y < TOP_ROW_Y + CH) {
      if (x >= STOCK_X && x < STOCK_X + CW) return { kind: "stock" };
      if (x >= WASTE_X && x < WASTE_X + CW) return { kind: "waste" };
      for (var i = 0; i < 4; i++) {
        if (x >= FOUNDATION_X[i] && x < FOUNDATION_X[i] + CW) {
          return { kind: "foundation", index: i };
        }
      }
    }
    // Tableau.
    if (!this._lastBoard) return null;
    for (var col = 0; col < 7; col++) {
      var cx = COL_X[col];
      if (x < cx || x >= cx + CW) continue;
      var stack = this._lastBoard.tableau[col];
      if (stack.length === 0) {
        // Empty column — accept any y within a card-height of the tableau row.
        if (y >= TABLEAU_Y && y < TABLEAU_Y + CH) {
          return { kind: "tableau", col: col, index: -1 };
        }
        return null;
      }
      // Top-card-first iteration.
      for (var i = stack.length - 1; i >= 0; i--) {
        var cy = this._cardYAt(col, i, this._lastBoard);
        if (y >= cy && y < cy + CH) {
          return { kind: "tableau", col: col, index: i };
        }
      }
      return null;
    }
    return null;
  };

  // Drag-source eligibility. Stock is tap-only; empty slots and face-down
  // tableau cards can't be picked up.
  Renderer.prototype.isDraggable = function (loc) {
    if (!loc || !this._lastBoard) return false;
    if (loc.kind === "stock") return false;
    if (loc.kind === "waste") return this._lastBoard.waste.length > 0;
    if (loc.kind === "foundation") return this._lastBoard.foundations[loc.index].length > 0;
    if (loc.kind === "tableau") {
      if (loc.index < 0) return false;
      var hidden = this._lastBoard.tableauHidden[loc.col];
      return loc.index >= hidden;
    }
    return false;
  };

  // Top-left position of a card at a given location. Used by the
  // application to compute the drag offset so picked-up cards don't jump
  // under the pointer on the first frame.
  Renderer.prototype.cardScreenPosition = function (loc, board) {
    if (loc.kind === "stock") return { x: STOCK_X, y: TOP_ROW_Y };
    if (loc.kind === "waste") return { x: WASTE_X, y: TOP_ROW_Y };
    if (loc.kind === "foundation") return { x: FOUNDATION_X[loc.index], y: TOP_ROW_Y };
    if (loc.kind === "tableau") {
      return { x: COL_X[loc.col], y: this._cardYAt(loc.col, loc.index, board) };
    }
    return { x: 0, y: 0 };
  };

  Renderer.prototype.layout = {
    INTERNAL_W: INTERNAL_W,
    INTERNAL_H: INTERNAL_H,
    CARD_W: CW,
    CARD_H: CH,
    TOP_ROW_Y: TOP_ROW_Y,
    TABLEAU_Y: TABLEAU_Y,
    FACE_UP_OFFSET: FACE_UP_OFFSET,
    FACE_DOWN_OFFSET: FACE_DOWN_OFFSET,
    COL_X: COL_X,
    STOCK_X: STOCK_X,
    WASTE_X: WASTE_X,
    FOUNDATION_X: FOUNDATION_X,
  };

  window.SolitaireRenderer = Renderer;
})();

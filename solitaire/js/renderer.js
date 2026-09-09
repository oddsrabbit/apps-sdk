// Canvas renderer. Internal resolution is INTERNAL_W × INTERNAL_H with
// `image-rendering: pixelated` CSS upscale, so all art sits on integer pixel
// positions and stays crisp on any display.
//
// The 52 card faces and the card back come from one atlas PNG
// (images/cards.png, built by tools/build-atlas.py). Each is cropped out of
// the atlas once at boot into its own offscreen canvas, then blitted via
// drawImage on every frame. Empty-slot ghosts and the stock-recycle icon are
// still drawn procedurally — they are table markings, not cards, and they
// need to follow the felt palette. This keeps the main loop cheap: even on
// the lowest-tier Android WebView the redraw is one fillRect + ~30 drawImage
// calls per frame, exactly as before the atlas landed.
//
// The atlas is an image, so it loads async. Renderer.load(url) resolves once
// it has decoded; application.js constructs the renderer with the result.

(function () {
  var Deck = window.SolitaireDeck;

  // --- Layout ---
  //
  // Card art is AUTHORED at CARD_W × CARD_H — the atlas cell size — and
  // BLITTED into an offscreen canvas SCALE× larger with smoothing off, so
  // each authored pixel becomes a crisp SCALE × SCALE block. The board then
  // lays those scaled sprites out using the post-scale dimensions CW × CH.
  // SCALE is the one knob that makes the cards physically bigger; nothing
  // below hardcodes a post-scale number.
  //
  // Every vertical offset below is a multiple of SCALE. That matters: the
  // peek strips (FACE_DOWN_OFFSET / FACE_UP_OFFSET) slice the sprite, and a
  // slice that lands mid-authored-pixel shears the art differently on each
  // card in a column.
  var SCALE = 3;
  var CARD_W = 42;               // atlas cell width  (art-authoring size)
  var CARD_H = 60;               // atlas cell height
  var CW = CARD_W * SCALE;       // 126 — on-board card width (layout + blits)
  var CH = CARD_H * SCALE;       // 180 — on-board card height

  // Board geometry, in on-board (post-scale) pixels.
  //
  // The HORIZONTAL half is fixed. Seven tableau columns side by side is what
  // Klondike is, so the card width is always the viewport's width divided by
  // seven — no layout can make a card wider on a phone. INTERNAL_W therefore
  // never moves, and neither does anything derived from it (COL_X, MARGIN,
  // the atlas scale). This is also what keeps the pixel art crisp: one
  // authored pixel is always SCALE internal pixels.
  //
  // The VERTICAL half is ELASTIC. The board is nearly square (998 x 1036) and
  // a phone is not, so a fixed aspect ratio strands a third of a portrait
  // screen as empty felt while the tableau columns stay crammed at their
  // minimum peek. `Renderer.prototype.resize` fits by width and then spends
  // whatever height the viewport has left on the vertical offsets, via
  // applyLayout() below. Everything under `--- Elastic vertical layout ---`
  // is a live value, not a constant: read it, never cache it.
  var COL_GAP = 12;
  var MARGIN = 22;
  var INTERNAL_W = 2 * MARGIN + 7 * CW + 6 * COL_GAP;   // 998

  // --- Elastic vertical layout ---

  // Floors. These are exactly the values the board shipped with when the
  // layout was fixed, so the tightest possible screen still gets the old
  // board rather than something worse.
  var MIN_TOP_ROW_Y = 40;
  // Gap between the bottom of the top row and the tableau, sized for the
  // stock's pile-depth badge, which prints just under the stock and is
  // 5 * SCALE tall. At SCALE 2 the top row ended at 200 and 220 was clear;
  // at SCALE 3 the row reaches 220 on its own, so the badge needs this.
  var MIN_BADGE_ROOM = 30;
  var MIN_FACE_DOWN_OFFSET = 5 * SCALE;   // 15 — a face-down peek shows 5 authored px
  // 14 authored px. The atlas rank glyph occupies authored rows 5–12, so this
  // clears it with a row to spare — a face-up peek strip always shows the
  // whole rank, which is the entire point of the deck swap.
  var MIN_FACE_UP_OFFSET = 14 * SCALE;    // 42

  // Ceilings, in authored pixels so they read against the art rather than
  // against the board.
  //
  // A face-up peek can usefully grow to 26 authored px: rank, the pip beside
  // it and a band of the face below, which is as much as a stacked card ever
  // needs to show. Past that the column just gets long and the player scrolls
  // their eyes instead of reading. A face-down peek stays much smaller — it
  // carries no information at all, it only has to look like depth.
  var MAX_FACE_UP_OFFSET = 26 * SCALE;    // 78
  var MAX_FACE_DOWN_OFFSET = 8 * SCALE;   // 24
  var MAX_BADGE_ROOM = 90;

  // Height of everything below TOP_ROW_Y at the tightest layout: the top row
  // itself, the badge gap, the deepest legal tableau column (6 face-down plus
  // a 13-card K→A run, so 6 down-offsets and 12 up-offsets before the last
  // card), and a little breathing room under it. resize() solves for the
  // scale that makes this fit, so it is the one number the fit depends on.
  var BOARD_MIN_H = CH + MIN_BADGE_ROOM +
                    6 * MIN_FACE_DOWN_OFFSET + 12 * MIN_FACE_UP_OFFSET +
                    CH + 4 * SCALE;                     // 996
  var MIN_INTERNAL_H = MIN_TOP_ROW_Y + BOARD_MIN_H;     // 1036 — the old fixed height

  // Live values. applyLayout() rewrites all five on every resize; they start
  // at the floors so a draw that somehow lands before the first resize gets
  // the old board instead of a divide-by-zero.
  var TOP_ROW_Y = MIN_TOP_ROW_Y;
  var TABLEAU_Y = MIN_TOP_ROW_Y + CH + MIN_BADGE_ROOM;  // 250
  var FACE_DOWN_OFFSET = MIN_FACE_DOWN_OFFSET;
  var FACE_UP_OFFSET = MIN_FACE_UP_OFFSET;
  var INTERNAL_H = MIN_INTERNAL_H;

  // CSS pixels reserved at the top of the board for the floating HUD (the
  // undo / new-deal / sound controls and the moves + time chips). The band is
  // inside the canvas rather than a bar above it, so the felt runs edge to
  // edge and the controls sit on it — but it has to be reserved in the fit,
  // or on a short window the chips land on the foundations. 8px of padding,
  // a 36px control, 10px of clearance.
  var HUD_BAND_CSS = 54;

  // Every vertical offset must stay a multiple of SCALE. The peek strips
  // slice the card sprite, and a slice that lands mid-authored-pixel shears
  // the art differently on each card in a column.
  function quantizeUp(v) { return Math.ceil(v / SCALE) * SCALE; }
  function quantizeDown(v) { return Math.floor(v / SCALE) * SCALE; }

  // Spend `h - topRowY - BOARD_MIN_H` of spare internal height on the
  // vertical offsets, in priority order, and publish the result.
  //
  // The face-up peek goes first and takes as much as it can: it is the only
  // one of these that changes what the player can read off a stacked column,
  // which is the whole reason the layout flexes. Face-down depth is next but
  // capped low — six hidden cards eat 6px of the budget per step and tell the
  // player nothing. The badge gap takes a share of what is left so the top
  // row doesn't sit flush against the tableau, and everything still spare
  // stays as felt under the bottom of the board, which is where the Finish
  // button and the dead-end banner float.
  function applyLayout(h, topRowY) {
    TOP_ROW_Y = topRowY;
    INTERNAL_H = h;
    var spare = Math.max(0, h - topRowY - BOARD_MIN_H);

    var upRoom = (MAX_FACE_UP_OFFSET - MIN_FACE_UP_OFFSET) / SCALE;
    var upSteps = Math.max(0, Math.min(Math.floor(spare / (12 * SCALE)), upRoom));
    FACE_UP_OFFSET = MIN_FACE_UP_OFFSET + upSteps * SCALE;
    spare -= 12 * upSteps * SCALE;

    var downRoom = (MAX_FACE_DOWN_OFFSET - MIN_FACE_DOWN_OFFSET) / SCALE;
    var downSteps = Math.max(0, Math.min(Math.floor(spare / (6 * SCALE)), downRoom));
    FACE_DOWN_OFFSET = MIN_FACE_DOWN_OFFSET + downSteps * SCALE;
    spare -= 6 * downSteps * SCALE;

    var badgeRoom = MIN_BADGE_ROOM +
      Math.min(quantizeDown(spare * 0.4), MAX_BADGE_ROOM - MIN_BADGE_ROOM);
    TABLEAU_Y = TOP_ROW_Y + CH + badgeRoom;

    // Keep the published layout object in step. It is handed out live (see
    // Renderer.prototype.layout) rather than rebuilt, so callers holding a
    // reference from boot still read today's numbers.
    LAYOUT.INTERNAL_H = INTERNAL_H;
    LAYOUT.TOP_ROW_Y = TOP_ROW_Y;
    LAYOUT.TABLEAU_Y = TABLEAU_Y;
    LAYOUT.FACE_UP_OFFSET = FACE_UP_OFFSET;
    LAYOUT.FACE_DOWN_OFFSET = FACE_DOWN_OFFSET;
  }

  // env(safe-area-inset-top) is only readable from CSS, and resize() needs it
  // as a number: on a notched phone the HUD band has to clear the inset as
  // well as its own height, or the time chip lands under the status bar.
  // A zero-sized probe carrying the inset as padding is the cheapest way to
  // get the resolved value; it is created once and read per resize.
  var safeProbe = null;
  function safeAreaTop() {
    if (!safeProbe) {
      if (!document.body) return 0;
      safeProbe = document.createElement("div");
      safeProbe.setAttribute("aria-hidden", "true");
      safeProbe.style.cssText =
        "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;" +
        "pointer-events:none;padding-top:env(safe-area-inset-top,0px);";
      document.body.appendChild(safeProbe);
    }
    var v = parseFloat(window.getComputedStyle(safeProbe).paddingTop);
    return v > 0 ? v : 0;
  }

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

  // Green felt. The cards are the atlas's pure white, which the old light-oak
  // table (#d9b483) could not hold — white on tan washed out at every size,
  // and the drop-target highlight had nothing to sit against. Green is also
  // the universal solitaire cue. styles.css mirrors these in --wood-*; change
  // both or the chrome drifts from the board.
  var COL_FELT = "#2e7d4f";          // table surface (mirrors --wood)
  var COL_FELT_DARK = "#256640";     // recessed felt under empty slots
  // Empty-slot ghost: the dashed border and the recycle arrow, drawn ON the
  // recess. Lighter than the recess (the wood palette went the other way,
  // dark-on-light) because a dark line on dark green disappears.
  var COL_GHOST = "#5aad80";
  // Pile-depth badge under the stock. Drawn on the felt itself, not on a
  // recess, so it needs to be lighter than COL_FELT rather than COL_GHOST.
  var COL_TABLE_MARK = "#a9d9be";
  // Drop-target highlight — warm cream, the one non-green on the board, so
  // legal landing spots read instantly against felt and cards alike.
  var COL_HIGHLIGHT = "#f5d56a";

  // --- Atlas ---

  // images/cards.png, a 13 × 5 grid of CARD_W × CARD_H cells. Rows 0–3 are
  // the suits in Deck order and columns 0–12 the ranks A..K, so a cell's
  // index IS the engine's card integer (suit * 13 + rank) — faces need no
  // lookup table. Row 4 col 0 is the card back; the rest of row 4 is spare
  // (rabbit court cards, seasonal backs). tools/build-atlas.py owns all of
  // this; keep the two in sync.
  var ATLAS_BACK_COL = 0;
  var ATLAS_BACK_ROW = 4;

  // Load the atlas. Resolves with a decoded HTMLImageElement, rejects if the
  // image 404s or fails to decode — application.js turns that into the
  // bootstrap-error banner rather than a blank felt.
  function loadAtlas(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("solitaire: could not load card atlas " + url)); };
      img.src = url;
    });
  }

  // Crop one atlas cell into its own offscreen canvas at CW × CH. Returns a
  // canvas rather than drawing from the atlas per frame so the per-frame path
  // stays a plain 1:1 blit, and so the nearest-neighbour upscale happens once.
  function spriteFromAtlas(atlas, col, row) {
    var off = document.createElement("canvas");
    off.width = CW;
    off.height = CH;
    var ctx = off.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      atlas,
      col * CARD_W, row * CARD_H, CARD_W, CARD_H,
      0, 0, CW, CH
    );
    return off;
  }

  function buildCardFace(atlas, card) {
    return spriteFromAtlas(atlas, Deck.rankOf(card), Deck.suitOf(card));
  }

  function buildCardBack(atlas) {
    return spriteFromAtlas(atlas, ATLAS_BACK_COL, ATLAS_BACK_ROW);
  }

  // --- Digit glyphs (3×5 pixel font) ---

  // The only text the renderer still draws is the stock's pile-depth badge.
  // Press Start 2P would need anti-aliasing we deliberately don't have (8px
  // renders as ~6px visible under image-rendering: pixelated), so the badge
  // keeps its own pixel font. Each row is exactly 3 chars; 'O' is filled.
  var DIGIT_GLYPHS = {
    "0": ["OOO", "O.O", "O.O", "O.O", "OOO"],
    "1": [".O.", "OO.", ".O.", ".O.", "OOO"],
    "2": ["OO.", "..O", ".O.", "O..", "OOO"],
    "3": ["OO.", "..O", ".OO", "..O", "OO."],
    "4": ["O.O", "O.O", "OOO", "..O", "..O"],
    "5": ["OOO", "O..", "OO.", "..O", "OO."],
    "6": [".OO", "O..", "OO.", "O.O", ".O."],
    "7": ["OOO", "..O", ".O.", ".O.", ".O."],
    "8": [".O.", "O.O", ".O.", "O.O", ".O."],
    "9": [".O.", "O.O", ".OO", "..O", "OO."],
  };

  // Paint a 1-bit sprite with each source pixel as a `scale`-square block.
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

  // --- Empty-slot sprites ---

  // Empty slots stay hand-drawn. The atlas has a Kenney `card_empty`, but it
  // is a white card with a decorative frame — on the felt it reads as a blank
  // card you could pick up, which is exactly wrong for a hole. A recess with a
  // dashed ghost border reads as "nothing is here".

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
    // Circular arrow — half-ring + arrowhead, centred in the card.
    ctx.fillStyle = COL_GHOST;
    var cx = CARD_W / 2;
    var cy = CARD_H / 2;
    // Arc from just past 3 o'clock around to the upper-right, leaving a real
    // gap for the arrowhead. (The old bounds 0.15π..2.2π spanned more than a
    // full turn, so the ring drew closed and the arrowhead vanished into it.)
    for (var a = Math.PI * 0.05; a < Math.PI * 1.7; a += 0.18) {
      var rx = Math.round(cx + Math.cos(a) * 8);
      var ry = Math.round(cy + Math.sin(a) * 8);
      ctx.fillRect(rx, ry, 2, 2);
    }
    // Arrowhead — stepped solid triangle at the arc's end, pointing
    // clockwise (down-right) into the gap.
    ctx.fillRect(cx + 1, cy - 9, 5, 2);
    ctx.fillRect(cx + 3, cy - 7, 3, 2);
    ctx.fillRect(cx + 4, cy - 5, 2, 2);
    return off;
  }

  // Generic empty-card outline — dashed border on a recessed-felt fill, used
  // for both foundation slots and the empty stock. Corners are cut to match
  // how the atlas cards fake a rounded edge, so a slot lines up with the card
  // that will land in it.
  function drawEmptyOutline(ctx) {
    ctx.fillStyle = COL_FELT_DARK;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    ctx.clearRect(0, 0, 1, 1);
    ctx.clearRect(CARD_W - 1, 0, 1, 1);
    ctx.clearRect(0, CARD_H - 1, 1, 1);
    ctx.clearRect(CARD_W - 1, CARD_H - 1, 1, 1);
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

  // `atlas` is the decoded image from Renderer.load(). It is only read here,
  // in the constructor — every sprite is cropped out of it up front, so the
  // atlas can be garbage-collected afterwards and the draw loop never touches
  // it.
  function Renderer(canvas, atlas) {
    if (!atlas) throw new Error("solitaire: Renderer needs a loaded atlas — use Renderer.load()");
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    canvas.width = INTERNAL_W;
    canvas.height = INTERNAL_H;

    // The renderer owns the canvas's CSS size as well as its buffer: the
    // board is the page, so there is no column for CSS to fit it into.
    // No redraw is scheduled here — solitaire repaints on demand rather than
    // on a frame loop, so application.js re-renders after a resize.
    var self = this;
    this._onResize = function () {
      self.resize();
      // Resizing the buffer clears it, and there is no frame loop to repaint
      // on the next tick — solitaire draws on demand.
      if (self._lastBoard) self.draw(self._lastBoard, self._lastDrag, null);
      else self.drawEmptyTable();
    };
    window.addEventListener("resize", this._onResize);
    // iOS fires this before `resize` has the new dimensions on some versions,
    // and Android WebViews sometimes fire only this one.
    window.addEventListener("orientationchange", this._onResize);

    // Sprite cache.
    this._cardSprites = new Array(Deck.DECK_SIZE);
    for (var i = 0; i < Deck.DECK_SIZE; i++) {
      this._cardSprites[i] = buildCardFace(atlas, i);
    }
    this._cardBack = buildCardBack(atlas);
    this._emptyFoundation = buildEmptyFoundation();
    this._emptyStock = buildEmptyStock();

    // Frame state (set per draw call).
    this._lastBoard = null;
    this._lastDrag = null;

    // Sizes the buffer and the element, and spends the height budget. Must
    // run before the first draw: the width/height attributes in index.html
    // are only what the browser lays out with before the scripts run.
    this.resize();
  }

  // Size the buffer and the element to the viewport, and re-spend the height
  // budget on the vertical offsets. Safe to call as often as you like — it is
  // pure arithmetic plus two style writes, and it skips the buffer assignment
  // (which clears the canvas and resets the 2D context) when the height is
  // unchanged.
  //
  // THE FIT. Card width is bound by seven columns across, so the natural move
  // is to fit by width and let the height fall where it may. That works on a
  // phone and fails on anything short: the board would run off the bottom.
  // The board must therefore satisfy, all in CSS pixels,
  //
  //     hudCss + scale * BOARD_MIN_H  <=  vh
  //
  // — the reserved HUD band plus the tightest legal board has to fit the
  // viewport — which rearranges to a plain upper bound on `scale`, so there
  // is no iteration here despite the HUD band being specified in CSS pixels
  // and consumed in internal ones. The `+ SCALE` in that denominator is slack
  // for quantising TOP_ROW_Y up to the art grid below; without it a window
  // that fits to the pixel comes out one quantum short. The third term covers
  // the case where MIN_TOP_ROW_Y is taller than the HUD band needs (a big
  // desktop window), where the binding constraint is the old fixed height.
  Renderer.prototype.resize = function () {
    var vw = Math.max(1, window.innerWidth || INTERNAL_W);
    var vh = Math.max(1, window.innerHeight || MIN_INTERNAL_H);
    var hudCss = HUD_BAND_CSS + safeAreaTop();

    var scale = Math.min(
      vw / INTERNAL_W,
      (vh - hudCss) / (BOARD_MIN_H + SCALE),
      vh / MIN_INTERNAL_H
    );
    // A viewport shorter than the HUD band itself is not a real device, but
    // it must not produce a zero or negative scale.
    if (!(scale > 0)) scale = vh / MIN_INTERNAL_H;

    // Crisp-scale snapping. Nearest-neighbour renders art pixels in
    // alternating widths — a subtle wobble in the 1px card borders — unless
    // the upscale lands on a whole number of device pixels per art pixel. One
    // art pixel is SCALE internal px, so the board is wobble-free when
    // (cssWidth x dpr) is a multiple of INTERNAL_W / SCALE. Snap down to that
    // when it costs less than 8% of the width; past that, keep the wobble —
    // a narrow phone at 3x would otherwise give up ~15% of the board. What
    // the snap gives up is invisible either way now that the page background
    // is the same felt as the board.
    var dpr = window.devicePixelRatio || 1;
    var cssW = INTERNAL_W * scale;
    var step = (INTERNAL_W / SCALE) / dpr;
    var snapped = Math.floor(cssW / step) * step;
    if (snapped > 0 && cssW - snapped <= cssW * 0.08) {
      cssW = snapped;
      scale = cssW / INTERNAL_W;
    }

    // The canvas covers the viewport's full height; the fit above guarantees
    // the board fits inside it, and any surplus is felt below the tableau.
    var h = Math.max(MIN_INTERNAL_H, Math.round(vh / scale));
    var topRowY = Math.max(MIN_TOP_ROW_Y, quantizeUp(hudCss / scale));
    // Only reachable if the quantise slack above was not enough (a fractional
    // devicePixelRatio, say). Losing a pixel or two of HUD clearance beats
    // pushing the last tableau card off the bottom of the board.
    if (topRowY + BOARD_MIN_H > h) {
      topRowY = Math.max(MIN_TOP_ROW_Y, quantizeDown(h - BOARD_MIN_H));
    }
    applyLayout(h, topRowY);

    if (this.canvas.height !== h) {
      // Assigning the buffer size clears the canvas and resets the 2D context
      // state, so this is guarded and the nearest-neighbour flag is re-applied
      // after it.
      this.canvas.height = h;
      this.ctx.imageSmoothingEnabled = false;
    }
    cssW = Math.round(cssW);
    var cssH = Math.round(h * scale);
    this.canvas.style.width = cssW + "px";
    this.canvas.style.height = cssH + "px";

    // Publish the board's size to CSS. The overlay's type and the HUD have to
    // scale with the BOARD, and on a wide window the board is only part of the
    // viewport — `vw` would size them against the letterbox as well. styles.css
    // reads these with viewport fallbacks for the paint before the first call.
    var root = document.documentElement;
    root.style.setProperty("--stage-w", cssW + "px");
    root.style.setProperty("--stage-h", cssH + "px");
  };

  // Drop the resize listeners. Nothing in the app tears a renderer down today
  // — it is constructed once at boot and lives as long as the page — but the
  // constructor registers on `window`, so the undo is worth having next to it.
  Renderer.prototype.destroy = function () {
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("orientationchange", this._onResize);
  };

  // Fetch and decode the card atlas. Resolves with the image; the caller
  // passes it straight to the constructor. Rejecting here (rather than
  // failing silently to a blank felt) is what lets application.js surface
  // the bootstrap-error banner.
  Renderer.load = loadAtlas;

  Renderer.INTERNAL_W = INTERNAL_W;
  // The FLOOR, not the current height — the buffer is as tall as the viewport
  // (see resize). Named so nothing reads it as "the board is this tall".
  Renderer.MIN_INTERNAL_H = MIN_INTERNAL_H;
  Renderer.CARD_W = CW;
  Renderer.CARD_H = CH;
  // Exported so the crisp-scale snap in resize() and anything else that has to
  // land on the art grid can size itself: one authored pixel is SCALE
  // internal pixels.
  Renderer.SCALE = SCALE;
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

  // The table before a deal: felt plus the slot ghosts, no cards. The idle
  // overlay is translucent, and what shows through it is the difference
  // between a card table waiting for a deal and a blank green screen — which
  // is what a flat felt fill became once the board went full-bleed and the
  // page had nothing else on it.
  Renderer.prototype.drawEmptyTable = function () {
    var ctx = this.ctx;
    this._lastBoard = null;
    this._lastDrag = null;
    ctx.fillStyle = COL_FELT;
    ctx.fillRect(0, 0, INTERNAL_W, INTERNAL_H);
    ctx.drawImage(this._emptyStock, STOCK_X, TOP_ROW_Y);
    for (var i = 0; i < 4; i++) {
      ctx.drawImage(this._emptyFoundation, FOUNDATION_X[i], TOP_ROW_Y);
    }
    for (var col = 0; col < 7; col++) {
      ctx.drawImage(this._emptyFoundation, COL_X[col], TABLEAU_Y);
    }
  };

  // Cream frame around a card-shaped rect. Four fillRect calls keep it cheap
  // to repaint every pointermove. The pulse animation that tempted me here
  // would be nice but would force a 60fps redraw loop; skipping for now — the
  // static frame is enough signal.
  //
  // Thickness is one authored pixel (SCALE internal px), not a literal, so
  // the frame keeps its visual weight relative to the cards if SCALE moves.
  // At the old literal 2 it thinned out as the art got bigger.
  Renderer.prototype._drawHighlights = function (board, dragState, targets) {
    var ctx = this.ctx;
    var t2 = SCALE;
    ctx.fillStyle = COL_HIGHLIGHT;
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var rect = this._targetRect(board, t);
      if (!rect) continue;
      ctx.fillRect(rect.x - t2, rect.y - t2, rect.w + 2 * t2, t2);              // top
      ctx.fillRect(rect.x - t2, rect.y + rect.h, rect.w + 2 * t2, t2);          // bottom
      ctx.fillRect(rect.x - t2, rect.y - t2, t2, rect.h + 2 * t2);              // left
      ctx.fillRect(rect.x + rect.w, rect.y - t2, t2, rect.h + 2 * t2);          // right
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
      // pale sliver of the back's border that read as a rendering artifact.
      if (board.stock.length > 1) this.ctx.drawImage(this._cardBack, x - 2 * SCALE, y - 2 * SCALE);
      this.ctx.drawImage(this._cardBack, x, y);
      // Pile-depth count in the gap under the top row, so players can see
      // how many draws remain before the next recycle. TABLEAU_Y leaves room
      // for it; see the layout constants.
      this._drawPileCount(board.stock.length, x + CW / 2, TOP_ROW_Y + CH + 2 * SCALE);
    }
  };

  // Small pixel number centered under a pile, in the 3×5 digit font at the
  // board's SCALE. Drawn in the table-marking colour so the badge reads as
  // something painted on the felt rather than a card.
  Renderer.prototype._drawPileCount = function (n, centerX, y) {
    var str = String(n);
    var w = (str.length * 4 - 1) * SCALE; // 3px digits + 1px gaps
    var x = Math.round(centerX - w / 2);
    for (var i = 0; i < str.length; i++) {
      var glyph = DIGIT_GLYPHS[str.charAt(i)];
      if (!glyph) continue;
      paintMonoSpriteScaled(this.ctx, glyph, x, y, COL_TABLE_MARK, SCALE);
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
    // Offsets in authored pixels so the shadow keeps its proportions if SCALE
    // moves — these were literals tuned when SCALE was 2 and would have gone
    // hairline against the bigger art.
    var near = 1 * SCALE;
    var far = 2 * SCALE;
    this.ctx.fillStyle = "rgba(0,0,0,0.25)";
    // Right-edge strip, from just below the top of the stack to its bottom.
    this.ctx.fillRect(px + CW, py + far, near, stackH);
    // Bottom-edge strip, under the bottom card only.
    this.ctx.fillRect(px + near, py + stackH, CW, far);
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

  // Live, not a snapshot: applyLayout() writes the elastic fields back into
  // this same object on every resize, so a caller may hold the reference.
  // INTERNAL_W and the card/column geometry are fixed and never rewritten.
  var LAYOUT = {
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
  Renderer.prototype.layout = LAYOUT;

  window.SolitaireRenderer = Renderer;
})();

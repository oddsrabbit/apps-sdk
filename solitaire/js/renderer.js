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
  var COL_GAP = 12;
  var MARGIN = 22;
  var TOP_ROW_Y = 40;
  // Below the top row (TOP_ROW_Y + CH = 220), with room for the stock's
  // pile-depth badge, which prints just under it and is 5 * SCALE tall. At
  // SCALE 2 the top row ended at 200 and 220 was clear; at SCALE 3 the row
  // reaches 220 on its own and the badge would print under the tableau.
  var TABLEAU_Y = 250;
  var FACE_DOWN_OFFSET = 5 * SCALE;   // 15 — a face-down peek shows 5 authored px
  // 14 authored px. The atlas rank glyph occupies authored rows 5–12, so this
  // clears it with a row to spare — a face-up peek strip always shows the
  // whole rank, which is the entire point of the deck swap.
  var FACE_UP_OFFSET = 14 * SCALE;    // 42
  var INTERNAL_W = 2 * MARGIN + 7 * CW + 6 * COL_GAP;   // 998
  // Tallest legal tableau column is 6 face-down + a 13-card K→A run, so the
  // deepest card starts at 6 down-offsets + 12 up-offsets. Plus a card and a
  // little breathing room under it.
  var INTERNAL_H = TABLEAU_Y + 6 * FACE_DOWN_OFFSET + 12 * FACE_UP_OFFSET + CH + 4 * SCALE;  // 1036

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
  }

  // Fetch and decode the card atlas. Resolves with the image; the caller
  // passes it straight to the constructor. Rejecting here (rather than
  // failing silently to a blank felt) is what lets application.js surface
  // the bootstrap-error banner.
  Renderer.load = loadAtlas;

  Renderer.INTERNAL_W = INTERNAL_W;
  Renderer.INTERNAL_H = INTERNAL_H;
  Renderer.CARD_W = CW;
  Renderer.CARD_H = CH;
  // Exported so application.js can size its device-pixel snap to the art
  // grid: one authored pixel is SCALE internal pixels.
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

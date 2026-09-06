// Hop — canvas renderer.
//
// Pixel art at a fixed 320x480 internal resolution, upscaled by CSS with
// `image-rendering: pixelated` — the same approach as snake and solitaire, and
// the right one here because nothing in this scene rotates. Every draw call is
// an axis-aligned integer rect, so the upscale lands on exact pixel blocks at
// any size.
//
// The rabbit is built out of rects rather than authored as a sprite sheet. At
// this size that is fewer than twenty rects, and it buys two things a PNG
// wouldn't: no second HTTP request on the mobile WebView, and a pose that can
// be nudged by a parameter (see _drawRabbit's `tilt`) instead of needing three
// hand-drawn frames kept in sync.

(function () {
  var W = 320;
  var H = 480;
  var GROUND_Y = 424;

  // Sky, back to front.
  var SKY_TOP = "#7ec8ef";
  var SKY_BOTTOM = "#9ad8f3";
  var CLOUD = "#e8f6fd";
  var HILL_FAR = "#93c98d";
  var HILL_NEAR = "#6aa862";

  // Ground. Deliberately the DARKEST of the three greens: the far hills are
  // the lightest and the near hills sit between them. Value separation is what
  // sorts the layers by distance here — they are all green, so hue can't.
  var GRASS = "#4e8c47";
  var GRASS_DARK = "#35682f";
  var EARTH = "#9a6b43";
  var EARTH_DARK = "#7a5233";

  // Hedges — the obstacle. Deliberately NOT carrots: the player is a rabbit,
  // and an obstacle shaped like the thing rabbits chase reads as a collectible
  // no matter how it is coloured. A hedge is unambiguous.
  var HEDGE = "#4a9b3f";
  var HEDGE_LIGHT = "#6fc25e";
  var HEDGE_DARK = "#2f6b28";
  var HEDGE_EDGE = "#1f4a1b";

  // Rabbit.
  var FUR = "#f7f2e8";
  var FUR_SHADE = "#d9d0be";
  var OUTLINE = "#3a3226";
  var PINK = "#f2a0b4";
  var EYE = "#2a2420";

  // Parallax rates, as a fraction of the world's scroll speed.
  var CLOUD_RATE = 0.18;
  var HILL_FAR_RATE = 0.32;
  var HILL_NEAR_RATE = 0.52;

  function HopRenderer(canvas) {
    this.canvas = canvas;
    // The buffer is a fixed size and CSS scales it, so this never needs to
    // react to layout — unlike Hex Rush's renderer, which derives geometry
    // from the element box and has to observe it.
    canvas.width = W;
    canvas.height = H;
    this.ctx = canvas.getContext("2d");
    // Nearest-neighbour on the way in too, so anything the browser has to
    // resample stays blocky rather than going soft.
    this.ctx.imageSmoothingEnabled = false;

    // Cloud positions are fixed in world space; only the offset moves. Seeded
    // once so they don't reshuffle every frame.
    this.clouds = [
      { x: 30, y: 54, w: 46 },
      { x: 150, y: 96, w: 62 },
      { x: 250, y: 40, w: 38 },
      { x: 355, y: 118, w: 52 },
      { x: 460, y: 70, w: 44 },
    ];
    this.cloudSpan = 560;
  }

  HopRenderer.prototype._rect = function (x, y, w, h, color) {
    var ctx = this.ctx;
    ctx.fillStyle = color;
    // Rounded to whole pixels so the upscale can't produce a half-lit column.
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  };

  HopRenderer.prototype._drawSky = function () {
    // Two flat bands rather than a gradient — a gradient would dither and
    // break the pixel look. The split sits low and the two tones are close, so
    // it reads as haze near the horizon instead of as a second horizon line.
    var split = Math.round(H * 0.62);
    this._rect(0, 0, W, split, SKY_TOP);
    this._rect(0, split, W, H - split, SKY_BOTTOM);
  };

  // A cloud is three overlapping bars — wide in the middle, narrower above.
  // Enough to read as a cloud at this scale, and it stays crisp because every
  // edge is on a pixel boundary.
  HopRenderer.prototype._drawClouds = function (scroll) {
    var offset = (scroll * CLOUD_RATE) % this.cloudSpan;
    for (var pass = 0; pass < 2; pass++) {
      var base = -offset + pass * this.cloudSpan;
      for (var i = 0; i < this.clouds.length; i++) {
        var c = this.clouds[i];
        var x = base + c.x;
        if (x > W || x + c.w < 0) continue;
        this._rect(x, c.y + 6, c.w, 7, CLOUD);
        this._rect(x + 8, c.y, c.w - 20, 7, CLOUD);
        this._rect(x + 16, c.y - 5, c.w - 34, 6, CLOUD);
      }
    }
  };

  // Deterministic 0..1 from an integer. Used to vary hill heights so the
  // skyline isn't a row of identical bumps, while staying stable as a mound
  // scrolls across the screen — a Math.random() here would make every hill
  // flicker to a new height on every frame.
  function hash(n) {
    var x = Math.sin(n * 127.1) * 43758.5453;
    return x - Math.floor(x);
  }

  // Rolling hills: one mound per `spacing` of world, drawn as a stack of
  // centred bars that narrows toward the top. Two layers at different rates
  // give the depth cue that tells the player the world is moving even when no
  // hedge is on screen.
  //
  // The widths are expressed as fractions of `spacing`, not of the mound's
  // height. Keyed to height, a short-and-wide layer produces bars wider than
  // the gap between mounds, and the whole range merges into one flat slab with
  // no visible mound shape at all. Tying them to the spacing keeps the bases
  // just touching and the peaks clearly separate at any size.
  HopRenderer.prototype._drawHills = function (scroll, rate, baseY, height, color, spacing, phase) {
    var STEPS = 5;
    var offset = (scroll * rate) % spacing;
    // One mound either side of the viewport so none pops in at the edges.
    // Must match the index `cx` below places the mound at, which derives from
    // `offset` (an unshifted modulo) — folding `phase` in here instead makes
    // the two disagree by one whenever (scroll * rate) % spacing < phase, and
    // every mound in the layer snaps to its neighbour's height.
    var firstIndex = Math.floor((scroll * rate) / spacing) - 1;

    for (var i = -1; i <= Math.ceil(W / spacing) + 1; i++) {
      var cx = -offset + phase + i * spacing;
      if (cx + spacing < 0 || cx - spacing > W) continue;
      // Height varies per mound, keyed to its position in the world rather
      // than to its position on screen, so it stays the same mound as it moves.
      var h = height * (0.66 + 0.34 * hash(firstIndex + i + 1));
      for (var s = 0; s < STEPS; s++) {
        // t runs 0 at the mound's PEAK to nearly 1 at its base, so the width
        // has to GROW with t. Shrinking it instead builds the mound upside
        // down — a wide cap over a narrow foot — and since the caps are then
        // wider than the gap between mounds, the whole range merges into one
        // speckled band with no hill shape anywhere in it.
        var t = s / STEPS;
        var halfW = spacing * (0.22 + t * 0.40);
        var y = baseY - h * (1 - t);
        this._rect(cx - halfW, y, halfW * 2, h / STEPS + 1, color);
      }
    }
  };

  HopRenderer.prototype._drawGround = function (scroll) {
    this._rect(0, GROUND_Y, W, H - GROUND_Y, EARTH);
    this._rect(0, GROUND_Y, W, 10, GRASS);
    this._rect(0, GROUND_Y + 10, W, 2, GRASS_DARK);

    // Scrolling texture: grass tufts on the surface and pebbles below, both
    // keyed to world position so they move at exactly the world's speed. This
    // is the only layer at rate 1.0, and it's what makes the scroll speed
    // legible.
    var tuftSpacing = 14;
    var offset = scroll % tuftSpacing;
    for (var x = -offset; x < W; x += tuftSpacing) {
      // Blades stand above the strip in the strip's own colour, so they read
      // as grass against the lighter hills behind rather than as loose specks.
      this._rect(x, GROUND_Y - 3, 2, 3, GRASS);
      this._rect(x + 5, GROUND_Y - 2, 2, 2, GRASS);
      this._rect(x + 9, GROUND_Y + 3, 3, 2, GRASS_DARK);
    }
    var pebbleSpacing = 37;
    var pOffset = scroll % pebbleSpacing;
    for (var px = -pOffset; px < W; px += pebbleSpacing) {
      this._rect(px + 6, GROUND_Y + 20, 4, 3, EARTH_DARK);
      this._rect(px + 20, GROUND_Y + 34, 3, 2, EARTH_DARK);
    }
  };

  // One hedge column. `capAtBottom` says which end faces the gap, so the
  // thicker lip is drawn on the edge the player is actually threading past.
  //
  // The lip overhangs the column by `capOverhang` on each side, and collision
  // (js/game.js) tests the column's width only — so the outer few pixels of the
  // lip are decorative and cannot kill. That asymmetry is deliberate and in the
  // player's favour: the corner of the lip is exactly where a near-miss
  // happens, and dying to it feels arbitrary in a way that clipping it visibly
  // does not. Keep it small enough that the pass still looks like a pass.
  HopRenderer.prototype._drawHedgeColumn = function (x, top, height, capAtBottom) {
    if (height <= 0) return;
    var w = 46;              // must match GATE_W in js/game.js
    var capH = 12;
    var capOverhang = 4;

    this._rect(x, top, w, height, HEDGE);
    // Vertical shading: a lit left edge and a dark right edge give the column
    // volume without any gradient.
    this._rect(x, top, 4, height, HEDGE_LIGHT);
    this._rect(x + w - 5, top, 5, height, HEDGE_DARK);
    this._rect(x, top, 1, height, HEDGE_EDGE);
    this._rect(x + w - 1, top, 1, height, HEDGE_EDGE);

    // Leaf texture — short horizontal dashes, offset per row so they don't
    // line up into stripes.
    for (var y = top + 6; y < top + height - 4; y += 9) {
      var jog = ((y / 9) | 0) % 2 === 0 ? 8 : 18;
      this._rect(x + jog, y, 7, 2, HEDGE_DARK);
      this._rect(x + jog + 12, y + 4, 5, 2, HEDGE_LIGHT);
    }

    // The lip at the gap end.
    var capY = capAtBottom ? top + height - capH : top;
    this._rect(x - capOverhang, capY, w + capOverhang * 2, capH, HEDGE);
    this._rect(x - capOverhang, capY, 4, capH, HEDGE_LIGHT);
    this._rect(x + w + capOverhang - 5, capY, 5, capH, HEDGE_DARK);
    this._rect(x - capOverhang, capY, w + capOverhang * 2, 2,
      capAtBottom ? HEDGE_LIGHT : HEDGE_EDGE);
    this._rect(x - capOverhang, capY + capH - 2, w + capOverhang * 2, 2,
      capAtBottom ? HEDGE_EDGE : HEDGE_DARK);
    this._rect(x - capOverhang, capY, 1, capH, HEDGE_EDGE);
    this._rect(x + w + capOverhang - 1, capY, 1, capH, HEDGE_EDGE);
  };

  HopRenderer.prototype._drawGates = function (gates) {
    for (var i = 0; i < gates.length; i++) {
      var gate = gates[i];
      var gapTop = gate.gapY - gate.gap / 2;
      var gapBottom = gate.gapY + gate.gap / 2;
      this._drawHedgeColumn(gate.x, 0, gapTop, true);
      this._drawHedgeColumn(gate.x, gapBottom, GROUND_Y - gapBottom, false);
    }
  };

  // The rabbit, facing right. `tilt` is -1 rising, 0 level, 1 diving; it lays
  // the ears back and shifts the head rather than rotating anything, which
  // keeps every edge axis-aligned and therefore crisp.
  HopRenderer.prototype._drawRabbit = function (x, y, tilt) {
    var earLean = tilt === -1 ? 2 : (tilt === 1 ? -1 : 0);
    var earH = tilt === -1 ? 5 : 8;
    var noseDrop = tilt === 1 ? 2 : (tilt === -1 ? -1 : 0);

    // Outline pass: the body silhouette one pixel larger on every side. Cheaper
    // and more even than stroking each piece.
    this._rect(x + 1, y + 5, 20, 12, OUTLINE);
    this._rect(x + 3, y + 3, 16, 16, OUTLINE);

    // Ears, drawn before the body so the body's outline overlaps their base.
    this._rect(x + 6 - earLean, y - earH + 4, 3, earH, OUTLINE);
    this._rect(x + 11 - earLean, y - earH + 4, 3, earH, OUTLINE);
    this._rect(x + 7 - earLean, y - earH + 5, 1, earH - 2, PINK);
    this._rect(x + 12 - earLean, y - earH + 5, 1, earH - 2, PINK);

    // Body.
    this._rect(x + 2, y + 6, 18, 10, FUR);
    this._rect(x + 4, y + 4, 14, 14, FUR);
    // Underside shading.
    this._rect(x + 4, y + 14, 14, 3, FUR_SHADE);
    this._rect(x + 2, y + 12, 3, 4, FUR_SHADE);

    // Tail, at the back.
    this._rect(x, y + 8, 3, 4, OUTLINE);
    this._rect(x + 1, y + 9, 2, 2, FUR);

    // Face, at the front.
    this._rect(x + 15, y + 8 + noseDrop, 2, 2, EYE);
    this._rect(x + 19, y + 11 + noseDrop, 2, 2, PINK);
    this._rect(x + 18, y + 10 + noseDrop, 1, 1, FUR_SHADE);

    // Front foot, tucked when rising and extended when diving — the clearest
    // single cue for which way the rabbit is going.
    if (tilt === 1) {
      this._rect(x + 13, y + 17, 5, 3, OUTLINE);
      this._rect(x + 14, y + 17, 3, 2, FUR);
    } else if (tilt === -1) {
      this._rect(x + 8, y + 16, 5, 3, OUTLINE);
      this._rect(x + 9, y + 16, 3, 2, FUR);
    } else {
      this._rect(x + 10, y + 17, 5, 3, OUTLINE);
      this._rect(x + 11, y + 17, 3, 2, FUR);
    }
  };

  HopRenderer.prototype.draw = function (state) {
    var scroll = state.scroll;

    this._drawSky();
    this._drawClouds(scroll);
    // Spacing, not a wrap width: each layer draws one mound every N world px.
    // The far layer is wider-spaced and taller, the near one tighter and
    // shorter, which reads as distance.
    // Both layers are based ON the ground line (the near one a little below
    // it, where the grass strip covers the join). Basing them above it leaves a
    // sliver of sky between the hills and the grass, which reads as a glowing
    // seam right across the busiest part of the screen.
    this._drawHills(scroll, HILL_FAR_RATE, GROUND_Y - 3, 48, HILL_FAR, 96, 0);
    this._drawHills(scroll, HILL_NEAR_RATE, GROUND_Y + 3, 33, HILL_NEAR, 68, 34);
    this._drawGates(state.gates);
    this._drawGround(scroll);
    this._drawRabbit(76, state.y, state.tilt);
  };

  window.HopRenderer = HopRenderer;
})();

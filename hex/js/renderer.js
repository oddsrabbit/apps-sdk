// Hex Rush — canvas renderer.
//
// The board is drawn as a set of concentric hexagonal rings. Ring d on side j
// is the trapezoid between the hexagon of apothem `a + d*h` and the one of
// apothem `a + (d+1)*h`, clipped to that side's sixth of the perimeter. Because
// a regular hexagon's side length is a fixed multiple of its apothem
// (s = 2a/sqrt(3)), consecutive rings tessellate exactly: the outer edge of
// ring d IS the inner edge of ring d+1, with no seam to fudge.
//
// WHY NOT PIXEL ART. Snake, Fruit Match and Solitaire are all authored at a
// fixed low internal resolution and upscaled with `image-rendering: pixelated`.
// That is the wrong choice here: this board rotates continuously, and a
// rotating pixel grid crawls and shimmers at every angle that isn't a multiple
// of 90 degrees. So this one renders smooth, at device-pixel resolution, and
// takes its retro character from a flat high-contrast palette instead of from
// visible pixels.

(function () {
  var SIDES = 6;

  // Board geometry, all expressed as multiples of one block's thickness so the
  // whole layout scales from a single number (see _layout).
  //
  // CORE_APOTHEM_UNITS IS THE IMPORTANT ONE, AND IT HAS TO BE LARGE. A ring's
  // side length grows in proportion to its apothem, so a block at depth d is
  // (core + d) / core times as wide as a block sitting directly on the core.
  // With a small core that ratio runs away: at 2.15 units a depth-7 block is
  // over four times the width of the face it is stacked on, and a column reads
  // as a funnel flaring off the hexagon rather than as a stack. At 8.5 the same
  // column only widens by about 1.8x over its full height, which reads as a
  // stack. The cost is board area — the core is inert space — so this is the
  // largest value that still leaves a usable approach runway.
  var CORE_APOTHEM_UNITS = 8.5;    // the central hexagon, in block thicknesses
  var VISIBLE_DEPTH = 13;          // depth that sits at the edge of the canvas
  var EDGE_MARGIN = 6;             // css px of breathing room outside that

  // tan(30 degrees). Half the width of a hexagon's side, per unit of apothem.
  var HALF_WIDTH_PER_APOTHEM = Math.tan(Math.PI / 6);

  // Block fills, plus the lighter bevel drawn along each block's outer edge.
  // Four hues chosen for separation at small size on the dark board rather
  // than for theme: orange and green are the OddsRabbit carrot/leaf pair, blue
  // and purple are the two remaining hues that stay distinct from both under a
  // colour-blind simulation of the set.
  var COLORS = [
    { fill: "#f2873c", edge: "#ffb877" },  // carrot
    { fill: "#54b45c", edge: "#8fdd94" },  // leaf
    { fill: "#3f9ede", edge: "#84c9f5" },  // sky
    { fill: "#a76fd8", edge: "#d0a6f2" },  // berry
  ];

  var BG = "#151d27";
  var CORE_FILL = "#243141";
  var CORE_EDGE = "#3d5268";
  var DANGER = "#e6484d";

  function HexRenderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.unit = 10;
    this.coreApothem = 0;
    this._resize();

    var self = this;
    // Canvas is CSS-sized by the layout; a viewport change or an orientation
    // flip has to re-derive the pixel buffer or the board draws at the old
    // scale, letterboxed. ResizeObserver where available (it also catches the
    // container changing without the window doing so, e.g. the host iframe
    // being resized), window resize as the fallback.
    if (typeof window.ResizeObserver === "function") {
      this._observer = new window.ResizeObserver(function () { self._resize(); });
      this._observer.observe(canvas);
    } else {
      window.addEventListener("resize", function () { self._resize(); });
    }
  }

  HexRenderer.prototype._resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var cssW = Math.max(1, Math.round(rect.width));
    var cssH = Math.max(1, Math.round(rect.height));
    // Cap at 2. Beyond that the extra pixels are invisible on a phone and the
    // fill rate is not: a rotating board redraws every ring every frame.
    var dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (this.width === cssW && this.height === cssH && this.dpr === dpr) return;

    this.width = cssW;
    this.height = cssH;
    this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this._layout();
  };

  // One block thickness, derived so that VISIBLE_DEPTH lands exactly at the
  // nearest canvas edge. Everything else on the board is a multiple of it.
  HexRenderer.prototype._layout = function () {
    var radius = Math.min(this.width, this.height) / 2 - EDGE_MARGIN;
    this.unit = radius / (CORE_APOTHEM_UNITS + VISIBLE_DEPTH);
    this.coreApothem = this.unit * CORE_APOTHEM_UNITS;
  };

  // Corner points of one ring cell, in canvas space. `normalAngle` is where the
  // cell's side faces; `depth` may be fractional, which is what lets a falling
  // block use the identical shape as a landed one.
  //
  // `widthDepth` overrides the depth used for the block's WIDTH only, leaving
  // its position alone. Landed blocks don't pass it: their width has to match
  // the ring they occupy or the board wouldn't tessellate. Falling blocks do,
  // and must — a ring's side grows with its radius, so a block drawn true to
  // size out at the spawn radius is nearly three times the width of the one it
  // is about to become, and arrives as a long bar sweeping across the board
  // rather than as a block. Pinning the width to depth 0 makes an incoming
  // block exactly the size of a block sitting on the bare hexagon, which is
  // what the player is being asked to read it as.
  HexRenderer.prototype._cellPath = function (normalAngle, depth, widthDepth) {
    var nx = Math.cos(normalAngle);
    var ny = Math.sin(normalAngle);
    // Along the side, perpendicular to the normal.
    var dx = -ny;
    var dy = nx;

    var inner = this.coreApothem + depth * this.unit;
    var outer = inner + this.unit;

    var wInner = widthDepth == null ? inner : this.coreApothem + widthDepth * this.unit;
    var wOuter = wInner + this.unit;
    var wi = wInner * HALF_WIDTH_PER_APOTHEM;
    var wo = wOuter * HALF_WIDTH_PER_APOTHEM;

    return [
      { x: nx * inner - dx * wi, y: ny * inner - dy * wi },
      { x: nx * inner + dx * wi, y: ny * inner + dy * wi },
      { x: nx * outer + dx * wo, y: ny * outer + dy * wo },
      { x: nx * outer - dx * wo, y: ny * outer - dy * wo },
    ];
  };

  HexRenderer.prototype._tracePoints = function (points) {
    var ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (var i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
  };

  // Side j of the hexagon, rotated by `rotation` steps. Side 0 unrotated faces
  // straight up, which is also lane 0 — so the same expression with the lane
  // index and zero rotation gives a falling block's angle.
  function angleFor(index, rotation) {
    return (-Math.PI / 2) + ((index + rotation) * Math.PI / 3);
  }

  HexRenderer.prototype._drawCell = function (normalAngle, depth, color, alpha, scale, widthDepth) {
    var ctx = this.ctx;
    var points = this._cellPath(normalAngle, depth, widthDepth);

    if (scale && scale !== 1) {
      // Scale about the cell's own centroid, so a popping block grows in place
      // rather than sliding outward from the board's centre.
      var cx = 0, cy = 0, i;
      for (i = 0; i < points.length; i++) { cx += points[i].x; cy += points[i].y; }
      cx /= points.length; cy /= points.length;
      for (i = 0; i < points.length; i++) {
        points[i].x = cx + (points[i].x - cx) * scale;
        points[i].y = cy + (points[i].y - cy) * scale;
      }
    }

    ctx.globalAlpha = alpha == null ? 1 : alpha;
    this._tracePoints(points);
    ctx.fillStyle = color.fill;
    ctx.fill();

    // A light bevel along the outer edge only. A full stroke would turn a
    // stack into a grid of outlines and bury the colour, which is the one
    // thing the player actually reads.
    ctx.beginPath();
    ctx.moveTo(points[2].x, points[2].y);
    ctx.lineTo(points[3].x, points[3].y);
    ctx.strokeStyle = color.edge;
    ctx.lineWidth = Math.max(1, this.unit * 0.09);
    ctx.stroke();

    // Hairline gap between neighbouring cells so a run of same-coloured blocks
    // still reads as individual blocks rather than one bar.
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    ctx.lineTo(points[1].x, points[1].y);
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.globalAlpha = 1;
  };

  HexRenderer.prototype._drawCore = function (rotation, danger) {
    var ctx = this.ctx;
    var points = [];
    // The core is the hexagon of apothem `coreApothem`. Each side contributes
    // one vertex (the start of its inner edge); walking j = 0..5 in order
    // therefore visits all six exactly once. Pushing both endpoints instead
    // would repeat every vertex, since adjacent sides share them.
    for (var j = 0; j < SIDES; j++) {
      points.push(this._cellPath(angleFor(j, rotation), 0)[0]);
    }

    this._tracePoints(points);
    ctx.fillStyle = CORE_FILL;
    ctx.fill();
    ctx.strokeStyle = danger ? DANGER : CORE_EDGE;
    ctx.lineWidth = Math.max(1.5, this.unit * 0.1);
    ctx.stroke();

    // Orientation mark: a wedge on side 0, so the hexagon's rotation is
    // readable even when the core is otherwise a featureless shape. Without it
    // a rotation of a symmetric hexagon is invisible unless blocks happen to
    // be stacked, which is exactly when a new player is trying to learn what
    // the control does.
    var markAngle = angleFor(0, rotation);
    var r = this.coreApothem * 0.52;
    ctx.beginPath();
    ctx.moveTo(Math.cos(markAngle) * r, Math.sin(markAngle) * r);
    ctx.lineTo(
      Math.cos(markAngle + 2.5) * r * 0.55,
      Math.sin(markAngle + 2.5) * r * 0.55
    );
    ctx.lineTo(
      Math.cos(markAngle - 2.5) * r * 0.55,
      Math.sin(markAngle - 2.5) * r * 0.55
    );
    ctx.closePath();
    ctx.fillStyle = danger ? DANGER : CORE_EDGE;
    ctx.globalAlpha = 0.75;
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  HexRenderer.prototype.draw = function (state) {
    this._resize();
    var ctx = this.ctx;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, this.width, this.height);

    // Everything below is drawn about the board centre.
    ctx.translate(this.width / 2, this.height / 2);

    var j, d;

    // Is any side one block from ending the run? Drives the core outline and
    // the warning tint, so the player gets a signal before the loss rather
    // than an explanation after it.
    var danger = false;
    for (j = 0; j < SIDES; j++) {
      if (state.stacks[j].length >= state.maxDepth) { danger = true; break; }
    }

    this._drawCore(state.rotation, danger);

    // Landed blocks, rotating with the hexagon.
    for (j = 0; j < SIDES; j++) {
      var angle = angleFor(j, state.rotation);
      var stack = state.stacks[j];
      for (d = 0; d < stack.length; d++) {
        this._drawCell(angle, d, COLORS[stack[d] % COLORS.length], 1, 1);
      }
      // Tint the outermost block of a side that is at the limit. Colouring the
      // whole side would fight the block colours the player is matching on.
      if (stack.length >= state.maxDepth) {
        var pts = this._cellPath(angle, stack.length - 1);
        this._tracePoints(pts);
        ctx.fillStyle = DANGER;
        ctx.globalAlpha = 0.28;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // Clear animation: grow and fade in place.
    for (var p = 0; p < state.pops.length; p++) {
      var pop = state.pops[p];
      var t = Math.min(1, pop.age / pop.life);
      this._drawCell(
        angleFor(pop.side, state.rotation),
        pop.depth,
        COLORS[pop.color % COLORS.length],
        (1 - t) * 0.85,
        1 + t * 0.65
      );
    }

    // Falling blocks. These do NOT rotate — they travel down fixed world
    // lanes, and the whole game is about rotating the hexagon to meet them.
    for (var f = 0; f < state.falling.length; f++) {
      var block = state.falling[f];
      // Fade in over the first stretch of the approach so a block doesn't pop
      // into existence at the canvas edge.
      var fade = 1;
      if (block.depth > VISIBLE_DEPTH - 1) {
        fade = Math.max(0, 1 - (block.depth - (VISIBLE_DEPTH - 1)) / 1.6);
      }
      if (fade <= 0) continue;
      this._drawCell(
        angleFor(block.lane, 0),
        block.depth,
        COLORS[block.color % COLORS.length],
        fade,
        1,
        0                       // width of a block on the bare hexagon
      );
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  HexRenderer.COLORS = COLORS;
  window.HexRenderer = HexRenderer;
})();

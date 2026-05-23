// Canvas renderer. Tiles are vivid coloured rounded-rect "cards" with a
// fruit emoji centred on top, plus optional overlays for special tiles
// (diagonal stripes for striped tiles, dark rainbow swirl for bombs).
//
// Internal canvas pixel size is `cssSize * dpr` so the rendering stays
// crisp on retina. CSS width comes from the surrounding container; we
// re-measure on resize via .resize().
//
// Renderer is a pure draw consumer of the state object passed to .draw().
// Every animation hint (selected pulse, shake, popup positions, hint
// arrow, etc.) is computed in game.js and just read here.

(function () {
  var FRUITS = [
    { emoji: "🍎", card: "#FF5252", shadow: "#B71C1C" },
    { emoji: "🍌", card: "#FFD54F", shadow: "#B28704" },
    { emoji: "🍇", card: "#9C27B0", shadow: "#4A148C" },
    { emoji: "🍉", card: "#2ECC71", shadow: "#0B6B30" },
    { emoji: "🍊", card: "#FF9800", shadow: "#B25E00" },
    { emoji: "🫐", card: "#3F8EFC", shadow: "#0E3D8C" },
  ];

  var BG_COLOR = "#F4EFE3";
  var CARD_INSET = 0.08;
  var CORNER_RADIUS = 0.18;
  var SELECT_OUTLINE = "#1A1A2E";
  var HINT_COLOR = "#1A1A2E";

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cssSize = 0;
    this.cols = 8;
    this.rows = 8;
    this.dpr = window.devicePixelRatio || 1;
    this._lastState = null;
  }

  Renderer.prototype.resize = function (cols, rows) {
    if (cols) this.cols = cols;
    if (rows) this.rows = rows;
    var rect = this.canvas.getBoundingClientRect();
    var cssSize = Math.min(rect.width, rect.height);
    if (cssSize <= 0) return;
    var dpr = window.devicePixelRatio || 1;
    this.cssSize = cssSize;
    this.dpr = dpr;
    this.canvas.width = Math.round(cssSize * dpr);
    this.canvas.height = Math.round(cssSize * dpr);
    this.canvas.style.height = cssSize + "px";
    if (this._lastState) this.draw(this._lastState);
  };

  Renderer.prototype.draw = function (state) {
    this._lastState = state;
    var ctx = this.ctx;
    var cssSize = this.cssSize;
    if (!cssSize) return;
    var dpr = this.dpr;
    var cellPx = cssSize / state.cols;

    // Compute screen-shake offset for this frame. A random jitter in
    // [-amp, amp] scaled by remaining shake time so the shake naturally
    // tapers off. Done here (not in game.js) so it changes per-frame and
    // looks like a vibration rather than a sustained offset.
    var shakeX = 0, shakeY = 0;
    if (state.shakeAmp > 0 && state.shakeT > 0) {
      var taper = Math.min(1, state.shakeT / 0.2);
      shakeX = (Math.random() - 0.5) * 2 * state.shakeAmp * taper;
      shakeY = (Math.random() - 0.5) * 2 * state.shakeAmp * taper;
    }

    // setTransform to dpr space, plus the shake offset. All subsequent
    // coords are in CSS px.
    ctx.setTransform(dpr, 0, 0, dpr, shakeX * dpr, shakeY * dpr);
    // Clear the full physical canvas, not just the CSS-sized area —
    // otherwise the shake offset leaves smear at the edges.
    ctx.clearRect(-cssSize, -cssSize, cssSize * 3, cssSize * 3);

    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, cssSize, cssSize);

    var swapAnim = null;
    if (state.currentMove && (state.phase === "swap-fwd" || state.phase === "swap-back")) {
      var t = Math.min(1, state.animTime / state.animTotal);
      var eased = state.phase === "swap-back"
        ? easeInQuad(1 - t)
        : easeOutCubic(t);
      swapAnim = { eased: eased, move: state.currentMove };
    }

    var fallAnim = null;
    if (state.phase === "resolve") {
      var ft = Math.min(1, state.animTime / state.animTotal);
      fallAnim = { eased: easeOutCubic(ft) };
    }

    var refillAnim = null;
    if (state.phase === "refill") {
      var rt = Math.min(1, state.animTime / state.animTotal);
      refillAnim = { eased: easeOutCubic(rt) };
    }

    // Selection pulse: subtle scale 1.0 ↔ 1.08 sine, ~1s period. Same time
    // base for all selected-tile work so the ring and the card move together.
    var pulse = 1 + Math.sin(state.now / 1000 * Math.PI * 2) * 0.04;

    for (var i = 0; i < state.cols; i++) {
      for (var j = 0; j < state.rows; j++) {
        var tile = state.tiles[i][j];
        if (tile.type < 0) continue;
        var x = i * cellPx;
        var y = j * cellPx;

        if (swapAnim) {
          if (i === swapAnim.move.c1 && j === swapAnim.move.r1) {
            var dxFwd = (swapAnim.move.c2 - swapAnim.move.c1) * cellPx;
            var dyFwd = (swapAnim.move.r2 - swapAnim.move.r1) * cellPx;
            x += dxFwd * swapAnim.eased;
            y += dyFwd * swapAnim.eased;
          } else if (i === swapAnim.move.c2 && j === swapAnim.move.r2) {
            var dxBack = (swapAnim.move.c1 - swapAnim.move.c2) * cellPx;
            var dyBack = (swapAnim.move.r1 - swapAnim.move.r2) * cellPx;
            x += dxBack * swapAnim.eased;
            y += dyBack * swapAnim.eased;
          }
        }

        if (fallAnim && tile.shift > 0) {
          y += tile.shift * cellPx * fallAnim.eased;
        }
        if (refillAnim && tile.fallFrom > 0) {
          y -= tile.fallFrom * cellPx * (1 - refillAnim.eased);
        }

        // Pulse only the currently-selected tile, only when ready.
        var thisIsSelected = state.selected
          && state.selected.c === i && state.selected.r === j
          && state.phase === "ready";
        var tileScale = thisIsSelected ? pulse : 1;

        drawTile(ctx, x, y, cellPx, tile.type, tile.special, tileScale);
      }
    }

    // Cluster shrink ghosts on top, only during resolve.
    if (state.phase === "resolve" && state.clusters && state.clusters.length > 0) {
      var cct = Math.min(1, state.animTime / state.animTotal);
      var scale = 1 - cct;
      if (scale > 0) {
        for (var k = 0; k < state.clusters.length; k++) {
          var cl = state.clusters[k];
          for (var n = 0; n < cl.length; n++) {
            var cc = cl.horizontal ? cl.column + n : cl.column;
            var cr = cl.horizontal ? cl.row : cl.row + n;
            drawTile(ctx, cc * cellPx, cr * cellPx, cellPx, cl.type, null, scale);
          }
        }
      }
    }

    // Selection ring (over the pulsing card so the outline tracks the pulse).
    if (state.selected && state.phase === "ready") {
      drawSelection(ctx, state.selected.c * cellPx, state.selected.r * cellPx, cellPx, pulse);
    }

    // Idle hint: pulsing arrow between two adjacent tiles. Drawn over
    // everything (so it's visible against bright cards) but only when in
    // the 'ready' phase and the game has set hintMove.
    if (state.hintMove && state.phase === "ready") {
      drawHintArrow(ctx, state.hintMove, cellPx, state.now);
    }

    // Floating popups (text)
    if (state.popups && state.popups.length > 0) {
      for (var pp = 0; pp < state.popups.length; pp++) {
        drawPopup(ctx, state.popups[pp], cellPx);
      }
    }

    // Tile-clear particles
    if (state.particles && state.particles.length > 0) {
      for (var p = 0; p < state.particles.length; p++) {
        drawParticle(ctx, state.particles[p], cellPx);
      }
    }

    // Confetti, drawn last so it sits over the game-over overlay's dim
    // background and the player can see it celebrating.
    if (state.confetti && state.confetti.length > 0) {
      for (var cf = 0; cf < state.confetti.length; cf++) {
        drawConfetti(ctx, state.confetti[cf], cellPx);
      }
    }
  };

  // Draw one tile. `special` is null | 'h-striped' | 'v-striped' | 'bomb';
  // each gets a distinct overlay so the player can tell them apart at a
  // glance. scale is the per-tile multiplier (used for selection pulse +
  // cluster shrink ghosts).
  function drawTile(ctx, x, y, cellPx, type, special, scale) {
    if (special === "bomb") {
      drawBombTile(ctx, x, y, cellPx, scale != null ? scale : 1);
      return;
    }
    var fruit = FRUITS[type];
    if (!fruit) return;
    var inset = cellPx * CARD_INSET;
    var size = cellPx - inset * 2;
    var s = scale != null ? scale : 1;
    if (s <= 0) return;
    if (s !== 1) {
      var pad = (size * (1 - s)) / 2;
      x += pad;
      y += pad;
      size *= s;
    }
    var radius = size * CORNER_RADIUS;

    var shadowOffset = cellPx * 0.04;
    ctx.fillStyle = fruit.shadow;
    roundRect(ctx, x + inset, y + inset + shadowOffset, size, size, radius);
    ctx.fill();

    ctx.fillStyle = fruit.card;
    roundRect(ctx, x + inset, y + inset, size, size, radius);
    ctx.fill();

    // Glossy highlight
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    roundRect(ctx, x + inset + size * 0.08, y + inset + size * 0.08, size * 0.84, size * 0.35, radius * 0.6);
    ctx.fill();

    // Special: diagonal stripes overlay for striped tiles. Horizontal
    // stripes for h-striped (clears row), vertical for v-striped (clears
    // column) — the direction matches the chain effect direction.
    if (special === "h-striped" || special === "v-striped") {
      drawStripes(ctx, x + inset, y + inset, size, radius, special === "h-striped");
    }

    var fontSize = Math.round(size * 0.62);
    ctx.font = fontSize + "px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(fruit.emoji, x + inset + size / 2, y + inset + size / 2 + size * 0.02);
  }

  // Bomb tile — dark base, animated rainbow ring, sparkle in the middle.
  // No fruit emoji because it's color-agnostic.
  function drawBombTile(ctx, x, y, cellPx, scale) {
    var inset = cellPx * CARD_INSET;
    var size = cellPx - inset * 2;
    if (scale <= 0) return;
    if (scale !== 1) {
      var pad = (size * (1 - scale)) / 2;
      x += pad;
      y += pad;
      size *= scale;
    }
    var radius = size * CORNER_RADIUS;
    var cx = x + inset + size / 2;
    var cy = y + inset + size / 2;

    // Dark base
    ctx.fillStyle = "#1A1A2E";
    roundRect(ctx, x + inset, y + inset, size, size, radius);
    ctx.fill();

    // Rainbow ring — six wedges in the fruit palette
    var ringR = size * 0.42;
    var ringW = size * 0.13;
    for (var i = 0; i < 6; i++) {
      var a1 = (i / 6) * Math.PI * 2 - Math.PI / 2;
      var a2 = ((i + 1) / 6) * Math.PI * 2 - Math.PI / 2;
      ctx.fillStyle = FRUITS[i].card;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, a1, a2);
      ctx.arc(cx, cy, ringR - ringW, a2, a1, true);
      ctx.closePath();
      ctx.fill();
    }

    // Sparkle dot in the center
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.08, 0, Math.PI * 2);
    ctx.fill();
  }

  // Diagonal-ish stripes overlay for striped tiles. Three semi-transparent
  // light bands at 45° (for horizontal stripes — the bands ARE horizontal
  // visually) or 135° (vertical). Clipped to the rounded-rect card so the
  // stripes don't bleed past the corners.
  function drawStripes(ctx, x, y, size, radius, horizontal) {
    ctx.save();
    roundRect(ctx, x, y, size, size, radius);
    ctx.clip();
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    var bandH = size * 0.13;
    var gap = size * 0.18;
    if (horizontal) {
      for (var i = 0; i < 4; i++) {
        var by = y + size * 0.1 + i * (bandH + gap);
        ctx.fillRect(x, by, size, bandH);
      }
    } else {
      for (var i2 = 0; i2 < 4; i2++) {
        var bx = x + size * 0.1 + i2 * (bandH + gap);
        ctx.fillRect(bx, y, bandH, size);
      }
    }
    ctx.restore();
  }

  function drawSelection(ctx, x, y, cellPx, pulseScale) {
    var inset = cellPx * CARD_INSET;
    var size = cellPx - inset * 2;
    var s = pulseScale != null ? pulseScale : 1;
    var pad = (size * (1 - s)) / 2;
    var sx = x + inset + pad;
    var sy = y + inset + pad;
    var ss = size * s;
    var radius = ss * CORNER_RADIUS;
    ctx.save();
    ctx.strokeStyle = SELECT_OUTLINE;
    ctx.lineWidth = Math.max(2, cellPx * 0.04);
    roundRect(ctx, sx, sy, ss, ss, radius);
    ctx.stroke();
    ctx.restore();
  }

  // Idle hint arrow — pulses between the two tiles so it's hard to miss.
  // Drawn as a fat line with an arrowhead, slightly oscillating along its
  // axis (so it feels like it's "pointing" toward the swap target).
  function drawHintArrow(ctx, move, cellPx, now) {
    var ax = move.c1 * cellPx + cellPx / 2;
    var ay = move.r1 * cellPx + cellPx / 2;
    var bx = move.c2 * cellPx + cellPx / 2;
    var by = move.r2 * cellPx + cellPx / 2;
    // Shrink the arrow so it doesn't overlap the tile centers entirely —
    // keeps both fruits visible behind it.
    var t = 0.18; // fraction to pull back from each endpoint
    var ax2 = ax + (bx - ax) * t;
    var ay2 = ay + (by - ay) * t;
    var bx2 = bx - (bx - ax) * t;
    var by2 = by - (by - ay) * t;

    // Pulse alpha 0.45 ↔ 0.95 over ~1s.
    var alpha = 0.45 + (Math.sin(now / 1000 * Math.PI * 2) + 1) * 0.25;
    ctx.save();
    ctx.globalAlpha = alpha;

    // Outer halo for legibility on any card colour
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = cellPx * 0.16;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(ax2, ay2);
    ctx.lineTo(bx2, by2);
    ctx.stroke();

    // Inner stroke
    ctx.strokeStyle = HINT_COLOR;
    ctx.lineWidth = cellPx * 0.09;
    ctx.beginPath();
    ctx.moveTo(ax2, ay2);
    ctx.lineTo(bx2, by2);
    ctx.stroke();

    // Arrowhead — short equilateral triangle pointing from b2 outward.
    var dx = bx2 - ax2;
    var dy = by2 - ay2;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / len, uy = dy / len;
    // Perpendicular
    var px = -uy, py = ux;
    var head = cellPx * 0.18;
    ctx.fillStyle = HINT_COLOR;
    ctx.beginPath();
    ctx.moveTo(bx2 + ux * head * 0.5, by2 + uy * head * 0.5);
    ctx.lineTo(bx2 - ux * head * 0.5 + px * head * 0.5, by2 - uy * head * 0.5 + py * head * 0.5);
    ctx.lineTo(bx2 - ux * head * 0.5 - px * head * 0.5, by2 - uy * head * 0.5 - py * head * 0.5);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  // Score / time-bonus popup. Bold text, dark outline for legibility on any
  // card colour, scaled by p.scale (pop-in animation), alpha = life.
  function drawPopup(ctx, p, cellPx) {
    var fontSize = Math.round(cellPx * 0.4 * p.scale);
    if (fontSize <= 0) return;
    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.font = "900 " + fontSize + "px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = fontSize * 0.22;
    ctx.strokeStyle = "rgba(20,15,30,0.85)";
    ctx.lineJoin = "round";
    var x = p.col * cellPx;
    var y = p.row * cellPx;
    ctx.strokeText(p.text, x, y);
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, x, y);
    ctx.restore();
  }

  function drawParticle(ctx, p, cellPx) {
    var fruit = FRUITS[p.type] || FRUITS[0];
    var radius = cellPx * 0.08 * Math.max(0, p.life);
    if (radius <= 0) return;
    ctx.fillStyle = fruit.card;
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.beginPath();
    ctx.arc(p.col * cellPx, p.row * cellPx, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Confetti — small rotated rectangles in vivid colours. Drawn in canvas
  // (not DOM) so the new-best burst is bounded to the board frame and
  // can't leak past the share modal if it's already open.
  function drawConfetti(ctx, p, cellPx) {
    if (p.life <= 0) return;
    ctx.save();
    ctx.globalAlpha = Math.min(1, p.life);
    ctx.translate(p.col * cellPx, p.row * cellPx);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    var w = p.w * cellPx;
    var h = p.h * cellPx;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function easeOutCubic(t) {
    var p = 1 - t;
    return 1 - p * p * p;
  }

  function easeInQuad(t) {
    return t * t;
  }

  window.Match3Renderer = Renderer;
})();

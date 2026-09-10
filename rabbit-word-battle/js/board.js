// Board renderer + gestures for the word game. A 15×15 grid drawn on a canvas
// at a fixed 40px world cell, with pan and pinch because a phone cannot show
// fifteen tappable columns at once: the board opens fitted to the screen, and
// the player zooms into the corner they are playing in.
//
// Gestures (pointer events, `touch-action: none` on the canvas — see the
// README's Android checklist):
//   - one pointer, moved past a small threshold → pan
//   - one pointer, released without moving      → tap → onCellTap(row, col)
//   - two pointers                                → pinch zoom about the midpoint
//   - wheel                                       → zoom about the cursor (desktop)
//   - double tap ON THE SAME CELL                 → toggle between fit and 2.2×
//
// That last qualifier matters. A plain "any tap within 300 ms" test made every
// second tap of a quickly-laid word zoom instead of placing a tile, which is
// exactly the flow the rack's auto-advance is built for. A double tap now has
// to land on the cell the previous tap did, and is suppressed outright while a
// rack tile is selected — during placement the player means to place.
//
// The renderer holds no game logic: it draws the `board` and `layout` from
// the server's view plus the pending tiles application.js is holding, and
// highlights whatever cells it is told to. Colours come from the CSS custom
// properties in styles.css so the canvas and the DOM rack are the same
// material in both themes rather than two palettes that drift apart.

(function () {
  var SIZE = 15;
  var CELL = 40;
  var WORLD = SIZE * CELL;
  // 10, not 6: at fit on a phone a cell is ~24 css px, and a thumb tap that
  // slid 7px used to become a silent pan with no tile placed.
  var DRAG_THRESHOLD = 10;
  var DOUBLE_TAP_MS = 300;
  // Below this many css px per cell the board is fitted but not really
  // playable, so a match opens zoomed into the action instead.
  var MIN_READABLE_CELL = 26;
  var MINIMAP = 54;
  // The minimap is a scrollbar, not furniture: it answers "where am I" right
  // after the view moves and then gets out of the way, because it sits on top
  // of squares the player can tap.
  var MINIMAP_HOLD_MS = 1400;
  var MINIMAP_FADE_MS = 400;

  // Two lines, in words. "TW" and "DL" are Scrabble shorthand a newcomer has
  // to be taught; "3x / WORD" is the rule itself, and the cell is big enough
  // to hold it once the label is stacked.
  var PREMIUM_LABEL = {
    W: ["3\u00d7", "WORD"],
    w: ["2\u00d7", "WORD"],
    L: ["3\u00d7", "LETTER"],
    l: ["2\u00d7", "LETTER"]
  };
  var PREMIUM_TITLE = {
    W: "triple word score", w: "double word score",
    L: "triple letter score", l: "double letter score"
  };

  var FALLBACK = {
    bg: "#e9e4d6", plain: "#f6f2e6", grid: "#cfc7b2",
    W: "#c1402f", w: "#f0a59a", L: "#2f6ba8", l: "#9cc3e6",
    ink: "#5a564b", inkStrong: "#ffffff", star: "#c9a227",
    tile: "#f7e7c1", tilePending: "#ffe9a8", tileEdge: "#b59a5b",
    tileInk: "#1f2937", tileBlankInk: "#6b7280", tileValueInk: "#4b5563",
    selected: "#d97706", last: "#2f855a", hint: "#2f855a", cursor: "#c9542b"
  };

  var VARS = {
    bg: "--board-bg", plain: "--sq-plain", grid: "--sq-grid",
    W: "--sq-tw", w: "--sq-dw", L: "--sq-tl", l: "--sq-dl",
    ink: "--sq-ink", inkStrong: "--sq-ink-strong", star: "--sq-star",
    tile: "--tile", tilePending: "--tile-pending", tileEdge: "--tile-edge",
    tileInk: "--tile-ink", tileBlankInk: "--tile-blank-ink",
    tileValueInk: "--tile-value-ink", selected: "--tile-selected",
    last: "--turn", hint: "--hint", cursor: "--accent"
  };

  function readPalette() {
    var out = {};
    var styles = null;
    try { styles = getComputedStyle(document.documentElement); } catch (_) {}
    Object.keys(VARS).forEach(function (key) {
      var value = styles ? styles.getPropertyValue(VARS[key]).trim() : "";
      out[key] = value || FALLBACK[key];
    });
    return out;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function TilesBoard(canvas, handlers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.handlers = handlers || {};
    this.board = null;
    this.layout = null;
    this.pending = [];
    this.highlight = {};
    this.hints = {};
    this.selected = null;
    this.drop = null;
    this.cursor = null;
    this.cursorDir = [0, 1];
    this.placing = false;
    this.scale = 1;
    this.minScale = 1;
    this.ox = 0;
    this.oy = 0;
    this.pointers = {};
    this.gesture = null;
    this.lastTap = null;
    this.mapUntil = 0;
    this.mapRaf = 0;
    this.palette = readPalette();
    this._bind();
    this.resize();
  }

  TilesBoard.prototype.setTheme = function () {
    this.palette = readPalette();
    this.draw();
  };

  TilesBoard.prototype.setView = function (board, layout, highlightCells) {
    this.board = board;
    this.layout = layout;
    this.highlight = {};
    (highlightCells || []).forEach(function (cell) { this.highlight[cell[0] + "," + cell[1]] = true; }, this);
    this.draw();
  };

  TilesBoard.prototype.setPending = function (pending, selectedKey) {
    this.pending = pending || [];
    this.selected = selectedKey || null;
    this.draw();
  };

  // Empty squares the next tile would connect on. Advisory only — see
  // TilesRules.hints; the renderer just dots them so the player is not
  // hunting a 225-square grid for somewhere legal to start.
  TilesBoard.prototype.setHints = function (cells) {
    this.hints = {};
    (cells || []).forEach(function (cell) { this.hints[cell[0] + "," + cell[1]] = true; }, this);
    this.draw();
  };

  // True while a rack tile is selected: suppresses double-tap zoom so a fast
  // second tap always places rather than zooming.
  TilesBoard.prototype.setPlacing = function (active) {
    this.placing = !!active;
  };

  // The square a tile being dragged from the rack would land on, or null.
  TilesBoard.prototype.setDropTarget = function (cell) {
    var next = cell ? cell[0] + "," + cell[1] : null;
    var current = this.drop ? this.drop[0] + "," + this.drop[1] : null;
    if (next === current) return;
    this.drop = cell ? [cell[0], cell[1]] : null;
    this.draw();
  };

  // Hit-test in viewport coordinates, for a drag that started on a rack tile
  // and therefore reports positions relative to the page, not the canvas.
  TilesBoard.prototype.cellAtClient = function (clientX, clientY) {
    var rect = this.canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right) return null;
    if (clientY < rect.top || clientY > rect.bottom) return null;
    return this.cellAt(clientX - rect.left, clientY - rect.top);
  };

  // ---- keyboard caret

  TilesBoard.prototype.setCursor = function (row, col, dir) {
    if (row === null || row === undefined) {
      this.cursor = null;
    } else {
      this.cursor = [Math.max(0, Math.min(SIZE - 1, row)), Math.max(0, Math.min(SIZE - 1, col))];
      if (dir) this.cursorDir = dir;
      this._revealCursor();
    }
    this.draw();
  };

  TilesBoard.prototype.getCursor = function () { return this.cursor ? this.cursor.slice() : null; };
  TilesBoard.prototype.getCursorDir = function () { return this.cursorDir.slice(); };

  // Pan the minimum distance that brings the caret fully into view. Typing
  // with arrow keys must never walk the caret off the edge of the screen.
  TilesBoard.prototype._revealCursor = function () {
    if (!this.cursor) return;
    var s = CELL * this.scale;
    var x = this.ox + this.cursor[1] * s, y = this.oy + this.cursor[0] * s;
    var pad = s * 0.5;
    if (x - pad < 0) this.ox += pad - x;
    if (y - pad < 0) this.oy += pad - y;
    if (x + s + pad > this.cssW) this.ox -= x + s + pad - this.cssW;
    if (y + s + pad > this.cssH) this.oy -= y + s + pad - this.cssH;
    this._clamp();
  };

  // A short spoken description of a square, for the live region that stands in
  // for a canvas no screen reader can read.
  TilesBoard.prototype.describe = function (row, col) {
    var where = "row " + (row + 1) + ", column " + (col + 1);
    var tile = this.board && this.board[row] ? this.board[row][col] : null;
    var pend = null;
    this.pending.forEach(function (t) { if (t.row === row && t.col === col) pend = t; });
    if (pend) return where + ", your " + (pend.blank ? "blank as " : "") + pend.letter + ", not played yet";
    if (tile) return where + ", " + (tile.b ? "blank as " : "") + tile.l;
    if (row === 7 && col === 7) return where + ", centre star, empty";
    var code = this.layout ? this.layout[row].charAt(col) : ".";
    if (PREMIUM_TITLE[code]) return where + ", " + PREMIUM_TITLE[code] + ", empty";
    return where + ", empty";
  };

  // ---- geometry

  TilesBoard.prototype.resize = function (force) {
    var rect = this.canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    if (!force && w === this.cssW && h === this.cssH && dpr === this.dpr) return false;
    this.cssW = w;
    this.cssH = h;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.dpr = dpr;
    var wasFit = !this.minScale || Math.abs(this.scale - this.minScale) < 1e-6;
    this.minScale = Math.min(this.cssW, this.cssH) / WORLD;
    this.maxScale = this.minScale * 4;
    if (wasFit || !this.scale) this.fit(); else this._clamp();
    this.draw();
    return true;
  };

  TilesBoard.prototype.fit = function () {
    this.scale = this.minScale;
    this.ox = (this.cssW - WORLD * this.scale) / 2;
    this.oy = (this.cssH - WORLD * this.scale) / 2;
    this.draw();
    this._changed();
  };

  TilesBoard.prototype.isZoomed = function () { return this.scale > this.minScale * 1.01; };

  // Whether the canvas has a box worth doing geometry against yet. Both the
  // frame callback and the resize observer race to apply the opening zoom, and
  // whichever arrives first must not spend it on a 1x1 canvas.
  TilesBoard.prototype.hasSize = function () { return this.cssW > 8 && this.cssH > 8; };

  // Zoom so `cells` (array of [r,c]) is centred and readable. Used when the
  // opponent's last move lands off-screen.
  TilesBoard.prototype.focusCells = function (cells) {
    if (!cells || !cells.length) return;
    var rs = cells.map(function (c) { return c[0]; }), cs = cells.map(function (c) { return c[1]; });
    var r = (Math.min.apply(null, rs) + Math.max.apply(null, rs) + 1) / 2;
    var c = (Math.min.apply(null, cs) + Math.max.apply(null, cs) + 1) / 2;
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.minScale * 2.2));
    this.ox = this.cssW / 2 - c * CELL * this.scale;
    this.oy = this.cssH / 2 - r * CELL * this.scale;
    this._clamp();
    this.draw();
    this._changed();
  };

  // Opening view for a match. Where the whole board fits at a size worth
  // tapping — a tablet, a desktop iframe — show all of it: the overview is
  // more useful than a close-up, and the last move is outlined anyway. Only
  // when a fitted cell would be too small to hit does the board open zoomed,
  // on the opponent's last word if there is one and on the centre if not.
  TilesBoard.prototype.openAt = function (cells) {
    if (this.minScale * CELL >= MIN_READABLE_CELL) { this.fit(); return; }
    this.focusCells(cells && cells.length ? cells : [[7, 7]]);
  };

  TilesBoard.prototype.zoomBy = function (factor) {
    this._zoomAt(factor, this.cssW / 2, this.cssH / 2);
  };

  // Wake the minimap and keep redrawing until it has faded out.
  TilesBoard.prototype._touchMap = function () {
    this.mapUntil = Date.now() + MINIMAP_HOLD_MS + MINIMAP_FADE_MS;
    if (this.mapRaf || !this.isZoomed()) return;
    var self = this;
    var step = function () {
      self.mapRaf = 0;
      self.draw();
      if (Date.now() < self.mapUntil && self.isZoomed()) {
        self.mapRaf = requestAnimationFrame(step);
      }
    };
    this.mapRaf = requestAnimationFrame(step);
  };

  TilesBoard.prototype._clamp = function () {
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.scale));
    var w = WORLD * this.scale, h = WORLD * this.scale;
    // When the board is smaller than the viewport on an axis, centre it;
    // otherwise keep the edges from leaving the viewport.
    this.ox = w <= this.cssW ? (this.cssW - w) / 2 : Math.min(0, Math.max(this.cssW - w, this.ox));
    this.oy = h <= this.cssH ? (this.cssH - h) / 2 : Math.min(0, Math.max(this.cssH - h, this.oy));
  };

  TilesBoard.prototype._changed = function () {
    this._touchMap();
    if (this.handlers.onViewChange) this.handlers.onViewChange(this.isZoomed());
  };

  TilesBoard.prototype._zoomAt = function (factor, x, y) {
    var before = this.scale;
    var after = Math.min(this.maxScale, Math.max(this.minScale, before * factor));
    if (after === before) return;
    this.ox = x - (x - this.ox) * (after / before);
    this.oy = y - (y - this.oy) * (after / before);
    this.scale = after;
    this._clamp();
    this.draw();
    this._changed();
  };

  TilesBoard.prototype.cellAt = function (x, y) {
    var c = Math.floor((x - this.ox) / (CELL * this.scale));
    var r = Math.floor((y - this.oy) / (CELL * this.scale));
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
    return [r, c];
  };

  // ---- gestures

  TilesBoard.prototype._bind = function () {
    var self = this;
    var el = this.canvas;
    function pos(e) {
      var rect = el.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    el.addEventListener("pointerdown", function (e) {
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      self.pointers[e.pointerId] = pos(e);
      var ids = Object.keys(self.pointers);
      if (ids.length === 1) {
        var p = self.pointers[e.pointerId];
        self.gesture = { type: "tap", startX: p.x, startY: p.y, lastX: p.x, lastY: p.y };
      } else if (ids.length === 2) {
        var a = self.pointers[ids[0]], b = self.pointers[ids[1]];
        self.gesture = { type: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y) };
      }
      e.preventDefault();
    });
    el.addEventListener("pointermove", function (e) {
      if (!self.pointers[e.pointerId]) return;
      self.pointers[e.pointerId] = pos(e);
      var g = self.gesture;
      if (!g) return;
      var ids = Object.keys(self.pointers);
      if (g.type === "pinch" && ids.length >= 2) {
        var a = self.pointers[ids[0]], b = self.pointers[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        if (g.dist > 0) self._zoomAt(d / g.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
        g.dist = d;
        return;
      }
      if (g.type === "tap" || g.type === "pan") {
        var p = self.pointers[e.pointerId];
        if (g.type === "tap" && Math.hypot(p.x - g.startX, p.y - g.startY) > DRAG_THRESHOLD) g.type = "pan";
        if (g.type === "pan") {
          self.ox += p.x - g.lastX;
          self.oy += p.y - g.lastY;
          self._clamp();
          self._touchMap();
          self.draw();
        }
        g.lastX = p.x;
        g.lastY = p.y;
      }
      e.preventDefault();
    });
    function up(e) {
      var g = self.gesture;
      var p = self.pointers[e.pointerId];
      delete self.pointers[e.pointerId];
      if (g && g.type === "pan") self._changed();
      if (g && g.type === "tap" && p) {
        var now = Date.now();
        var cell = self.cellAt(p.x, p.y);
        // A double tap has to be the SAME square twice, and never counts while
        // a rack tile is selected — otherwise laying a word at speed zooms.
        var repeat = self.lastTap && cell
          && now - self.lastTap.t < DOUBLE_TAP_MS
          && self.lastTap.row === cell[0] && self.lastTap.col === cell[1];
        if (repeat && !self.placing) {
          self.lastTap = null;
          if (self.isZoomed()) self.fit();
          else self.focusCells([cell]);
        } else {
          self.lastTap = cell ? { t: now, row: cell[0], col: cell[1] } : null;
          if (cell && self.handlers.onCellTap) self.handlers.onCellTap(cell[0], cell[1]);
        }
      }
      self.gesture = null;
      e.preventDefault();
    }
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", function (e) {
      var p = pos(e);
      self._zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
      e.preventDefault();
    }, { passive: false });

    // The canvas is sized from its box, and the box is 0x0 until the match
    // screen is shown. Waiting on a single requestAnimationFrame to catch that
    // leaves the board one pixel wide wherever rAF is throttled — a hidden
    // tab, a backgrounded WebView. Watch the box instead, and let the app know
    // when a real size finally arrives so it can apply its opening zoom.
    if (typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(function () {
        if (self.resize() && self.handlers.onResized) self.handlers.onResized();
      });
      this.observer.observe(el);
    }
  };

  // ---- drawing

  TilesBoard.prototype.draw = function () {
    var ctx = this.ctx;
    if (!ctx) return;
    var colors = this.palette;
    var dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    if (!this.layout) return;

    ctx.save();
    ctx.translate(this.ox, this.oy);
    ctx.scale(this.scale, this.scale);

    var pendingMap = {};
    this.pending.forEach(function (t) { pendingMap[t.row + "," + t.col] = t; });

    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var x = c * CELL, y = r * CELL;
        var code = this.layout[r].charAt(c);
        ctx.fillStyle = colors[code] || colors.plain;
        ctx.fillRect(x, y, CELL, CELL);
        ctx.strokeStyle = colors.grid;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
        var tile = this.board && this.board[r] ? this.board[r][c] : null;
        var pend = pendingMap[r + "," + c];
        if (!tile && !pend) {
          if (r === 7 && c === 7) {
            ctx.fillStyle = colors.star;
            ctx.font = "bold 20px system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("★", x + CELL / 2, y + CELL / 2 + 1);
          } else if (PREMIUM_LABEL[code]) {
            // Word multipliers carry the saturated fills, so their labels take
            // the strong ink; the pale letter squares keep the muted one.
            ctx.fillStyle = code === "W" || code === "L" ? colors.inkStrong : colors.ink;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            var lines = PREMIUM_LABEL[code];
            ctx.font = "bold 13px system-ui, sans-serif";
            ctx.fillText(lines[0], x + CELL / 2, y + CELL / 2 - 6);
            // "LETTER" is the long one; shrink to fit rather than overflow the
            // square, so both words sit on one baseline across the board.
            var size = 9;
            ctx.font = "bold " + size + "px system-ui, sans-serif";
            while (size > 5.5 && ctx.measureText(lines[1]).width > CELL - 7) {
              size -= 0.5;
              ctx.font = "bold " + size + "px system-ui, sans-serif";
            }
            ctx.fillText(lines[1], x + CELL / 2, y + CELL / 2 + 7);
          }
          if (this.hints[r + "," + c]) this._drawHint(ctx, x, y, colors);
          continue;
        }
        this._drawTile(ctx, x, y, tile || { l: pend.letter, b: pend.blank }, !!pend, !!this.highlight[r + "," + c],
          !!(pend && this.selected === (r + "," + c)), colors);
      }
    }
    if (this.drop) this._drawDrop(ctx, colors);
    if (this.cursor) this._drawCursor(ctx, colors);
    ctx.restore();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var remaining = this.mapUntil - Date.now();
    if (this.isZoomed() && remaining > 0) {
      this._drawMinimap(ctx, colors, Math.min(1, remaining / MINIMAP_FADE_MS));
    }
  };

  TilesBoard.prototype._drawHint = function (ctx, x, y, colors) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = colors.hint;
    roundRect(ctx, x + 5, y + 5, CELL - 10, CELL - 10, 4);
    ctx.stroke();
    ctx.restore();
  };

  TilesBoard.prototype._drawDrop = function (ctx, colors) {
    var x = this.drop[1] * CELL, y = this.drop[0] * CELL;
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = colors.selected;
    roundRect(ctx, x + 2, y + 2, CELL - 4, CELL - 4, 5);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = colors.selected;
    roundRect(ctx, x + 2, y + 2, CELL - 4, CELL - 4, 5);
    ctx.stroke();
    ctx.restore();
  };

  TilesBoard.prototype._drawCursor = function (ctx, colors) {
    var x = this.cursor[1] * CELL, y = this.cursor[0] * CELL;
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = colors.cursor;
    roundRect(ctx, x + 1.5, y + 1.5, CELL - 3, CELL - 3, 5);
    ctx.stroke();
    // A chevron on the leading edge: typing runs this way, and arrow keys set it.
    ctx.fillStyle = colors.cursor;
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var across = this.cursorDir[1] !== 0;
    var glyph = across ? (this.cursorDir[1] > 0 ? "›" : "‹") : (this.cursorDir[0] > 0 ? "⌄" : "⌃");
    ctx.fillText(glyph, x + (across ? (this.cursorDir[1] > 0 ? CELL - 6 : 6) : CELL / 2),
      y + (across ? CELL / 2 : (this.cursorDir[0] > 0 ? CELL - 7 : 7)));
    ctx.restore();
  };

  // A thumbnail of the whole board with the viewport marked, because zoomed in
  // on a 15×15 grid there is otherwise nothing to say where you are.
  TilesBoard.prototype._drawMinimap = function (ctx, colors, alpha) {
    var pad = 8;
    var x0 = this.cssW - MINIMAP - pad, y0 = this.cssH - MINIMAP - pad;
    var k = MINIMAP / WORLD;
    ctx.save();
    ctx.globalAlpha = 0.92 * alpha;
    roundRect(ctx, x0, y0, MINIMAP, MINIMAP, 6);
    ctx.fillStyle = colors.plain;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = colors.grid;
    ctx.stroke();

    ctx.fillStyle = colors.tileEdge;
    if (this.board) {
      for (var r = 0; r < SIZE; r++) {
        for (var c = 0; c < SIZE; c++) {
          if (!this.board[r][c]) continue;
          ctx.fillRect(x0 + c * CELL * k, y0 + r * CELL * k, CELL * k, CELL * k);
        }
      }
    }
    ctx.fillStyle = colors.selected;
    this.pending.forEach(function (t) {
      ctx.fillRect(x0 + t.col * CELL * k, y0 + t.row * CELL * k, CELL * k, CELL * k);
    });
    ctx.fillStyle = colors.last;
    Object.keys(this.highlight).forEach(function (key) {
      var parts = key.split(",");
      ctx.fillRect(x0 + Number(parts[1]) * CELL * k, y0 + Number(parts[0]) * CELL * k, CELL * k, CELL * k);
    });

    // The viewport, in world units, scaled down.
    var vx = -this.ox / this.scale, vy = -this.oy / this.scale;
    var vw = this.cssW / this.scale, vh = this.cssH / this.scale;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colors.cursor;
    ctx.strokeRect(
      x0 + Math.max(0, vx) * k, y0 + Math.max(0, vy) * k,
      Math.min(WORLD, vw) * k, Math.min(WORLD, vh) * k
    );
    ctx.restore();
  };

  TilesBoard.prototype._drawTile = function (ctx, x, y, tile, pending, highlighted, selected, colors) {
    var pad = 2.5;
    var w = CELL - pad * 2;
    roundRect(ctx, x + pad, y + pad, w, w, 5);
    ctx.fillStyle = pending ? colors.tilePending : colors.tile;
    ctx.fill();
    ctx.lineWidth = selected ? 3 : highlighted ? 2.5 : 1;
    ctx.strokeStyle = selected ? colors.selected : highlighted ? colors.last : colors.tileEdge;
    ctx.stroke();

    // The glyph sits on the cell's true centre. The value is drawn in the
    // corner afterwards, so there is nothing to nudge it away from.
    ctx.fillStyle = tile.b ? colors.tileBlankInk : colors.tileInk;
    ctx.font = "bold 21px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(tile.l, x + CELL / 2, y + CELL / 2 + 1);
    var v = tile.b ? 0 : (window.TilesRules.VALUES[tile.l] || 0);
    ctx.font = "bold 9px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = colors.tileValueInk;
    ctx.fillText(String(v), x + CELL - pad - 3, y + CELL - pad - 3);
  };

  TilesBoard.SIZE = SIZE;
  window.TilesBoard = TilesBoard;
})();

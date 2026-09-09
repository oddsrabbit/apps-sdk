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
//   - double tap                                  → toggle between fit and 2.5× on that cell
//
// The renderer holds no game logic: it draws the `board` and `layout` from
// the server's view plus the pending tiles application.js is holding, and
// highlights whatever cells it is told to.

(function () {
  var SIZE = 15;
  var CELL = 40;
  var WORLD = SIZE * CELL;
  var DRAG_THRESHOLD = 6;

  var PREMIUM_LABEL = { W: "TW", w: "DW", L: "TL", l: "DL" };

  function TilesBoard(canvas, handlers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.handlers = handlers || {};
    this.board = null;
    this.layout = null;
    this.pending = [];
    this.highlight = {};
    this.selected = null;
    this.scale = 1;
    this.minScale = 1;
    this.ox = 0;
    this.oy = 0;
    this.pointers = {};
    this.gesture = null;
    this.lastTap = 0;
    this.dark = false;
    this._bind();
    this.resize();
  }

  TilesBoard.prototype.setTheme = function (dark) {
    this.dark = !!dark;
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

  // ---- geometry

  TilesBoard.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    this.cssW = Math.max(1, rect.width);
    this.cssH = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.dpr = dpr;
    var wasFit = !this.minScale || Math.abs(this.scale - this.minScale) < 1e-6;
    this.minScale = Math.min(this.cssW, this.cssH) / WORLD;
    this.maxScale = this.minScale * 4;
    if (wasFit || !this.scale) this.fit(); else this._clamp();
    this.draw();
  };

  TilesBoard.prototype.fit = function () {
    this.scale = this.minScale;
    this.ox = (this.cssW - WORLD * this.scale) / 2;
    this.oy = (this.cssH - WORLD * this.scale) / 2;
    this.draw();
  };

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
  };

  TilesBoard.prototype._clamp = function () {
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.scale));
    var w = WORLD * this.scale, h = WORLD * this.scale;
    // When the board is smaller than the viewport on an axis, centre it;
    // otherwise keep the edges from leaving the viewport.
    this.ox = w <= this.cssW ? (this.cssW - w) / 2 : Math.min(0, Math.max(this.cssW - w, this.ox));
    this.oy = h <= this.cssH ? (this.cssH - h) / 2 : Math.min(0, Math.max(this.cssH - h, this.oy));
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
      el.setPointerCapture(e.pointerId);
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
      if (g && g.type === "tap" && p) {
        var now = Date.now();
        var cell = self.cellAt(p.x, p.y);
        if (now - self.lastTap < 300 && cell) {
          self.lastTap = 0;
          if (self.scale > self.minScale * 1.01) self.fit();
          else self.focusCells([cell]);
        } else {
          self.lastTap = now;
          if (cell && self.handlers.onCellTap) self.handlers.onCellTap(cell[0], cell[1]);
        }
      }
      self.gesture = Object.keys(self.pointers).length ? null : null;
      e.preventDefault();
    }
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", function (e) {
      var p = pos(e);
      self._zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
      e.preventDefault();
    }, { passive: false });
  };

  // ---- drawing

  TilesBoard.prototype.draw = function () {
    var ctx = this.ctx;
    if (!ctx) return;
    var dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = this.dark ? "#14151b" : "#e9e4d6";
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    if (!this.layout) return;

    ctx.translate(this.ox, this.oy);
    ctx.scale(this.scale, this.scale);

    var colors = this.dark
      ? { plain: "#22242d", grid: "#0f1015", W: "#8a2f2f", w: "#a4635a", L: "#2f5f8a", l: "#4f7fa6", text: "#c8c5b8", star: "#e2c04a" }
      : { plain: "#f6f2e6", grid: "#cfc7b2", W: "#e0574f", w: "#f0a59a", L: "#3b7dbb", l: "#9cc3e6", text: "#5a564b", star: "#c9a227" };

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
            ctx.fillStyle = code === "W" || code === "L" ? "#ffffff" : colors.text;
            ctx.font = "bold 11px system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(PREMIUM_LABEL[code], x + CELL / 2, y + CELL / 2);
          }
          continue;
        }
        this._drawTile(ctx, x, y, tile || { l: pend.letter, b: pend.blank }, !!pend, !!this.highlight[r + "," + c],
          pend && this.selected === (r + "," + c));
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  TilesBoard.prototype._drawTile = function (ctx, x, y, tile, pending, highlighted, selected) {
    var pad = 2.5;
    var w = CELL - pad * 2;
    var radius = 5;
    ctx.beginPath();
    ctx.moveTo(x + pad + radius, y + pad);
    ctx.arcTo(x + pad + w, y + pad, x + pad + w, y + pad + w, radius);
    ctx.arcTo(x + pad + w, y + pad + w, x + pad, y + pad + w, radius);
    ctx.arcTo(x + pad, y + pad + w, x + pad, y + pad, radius);
    ctx.arcTo(x + pad, y + pad, x + pad + w, y + pad, radius);
    ctx.closePath();
    ctx.fillStyle = pending ? "#ffe9a8" : "#f7e7c1";
    ctx.fill();
    ctx.lineWidth = selected ? 3 : highlighted ? 2.5 : 1;
    ctx.strokeStyle = selected ? "#d97706" : highlighted ? "#2f855a" : "#b59a5b";
    ctx.stroke();

    ctx.fillStyle = tile.b ? "#6b7280" : "#1f2937";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(tile.l, x + CELL / 2 - 2, y + CELL / 2 + 1);
    var v = tile.b ? 0 : (window.TilesRules.VALUES[tile.l] || 0);
    ctx.font = "bold 9px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#4b5563";
    ctx.fillText(String(v), x + CELL - pad - 3, y + CELL - pad - 3);
  };

  window.TilesBoard = TilesBoard;
})();

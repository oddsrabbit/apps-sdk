// Match-3 input. Two interchangeable swap gestures:
//   - tap-tap: tap a tile, then tap an orthogonal neighbour → swap.
//   - swipe:   press a tile and drag >SWIPE_MIN px in a cardinal direction →
//              swap with the neighbour in that direction.
// Both gestures emit a single high-level 'swap' event with the two grid
// coords; selection state (which tile is highlighted) is also managed here
// so the game/renderer stay UI-event-agnostic.
//
// Bound to the canvas (not document.body, the way snake does) because the
// match-3 board has UI chrome above and below that needs to remain clickable.

(function () {
  // Below this CSS-px movement the gesture is treated as a tap, not a swipe.
  // ~14px matches snake; below it the gesture is almost always an unintended
  // drift while pressing.
  var SWIPE_MIN = 14;

  function InputManager(canvas) {
    this.canvas = canvas;
    this.events = {};
    this.cols = 8;
    this.rows = 8;
    // Currently selected tile, or null. Mirrored to listeners via 'select'
    // events so the renderer can highlight it.
    this.selected = null;
    // Keyboard cursor cell, or null until the user presses an arrow key.
    // Mirrored via 'focus' events; the renderer paints a dashed ring on it.
    this._focused = null;
    this._tracking = false;
    this._startX = 0;
    this._startY = 0;
    this._startTile = null;
    this._listen();
  }

  InputManager.prototype.on = function (event, callback) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(callback);
  };

  InputManager.prototype.emit = function (event, data) {
    var callbacks = this.events[event];
    if (!callbacks) return;
    for (var i = 0; i < callbacks.length; i++) callbacks[i](data);
  };

  // The game tells us its grid dimensions so pointer→tile math stays
  // consistent if we ever support non-8x8 boards.
  InputManager.prototype.setGrid = function (cols, rows) {
    this.cols = cols;
    this.rows = rows;
  };

  // Clear selection state — called by the game when entering a non-ready
  // state (paused, over, mid-animation) so the highlight doesn't linger.
  InputManager.prototype.clearSelection = function () {
    if (this.selected) {
      this.selected = null;
      this.emit("select", null);
    }
  };

  // CSS-pixel coords → grid coords, using getBoundingClientRect so a
  // CSS-scaled canvas (which match-3 always is — internal pixels are DPR-
  // scaled while CSS width follows the container) still maps correctly.
  InputManager.prototype._tileFromEvent = function (clientX, clientY) {
    var rect = this.canvas.getBoundingClientRect();
    var x = clientX - rect.left;
    var y = clientY - rect.top;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
    var c = Math.floor((x / rect.width) * this.cols);
    var r = Math.floor((y / rect.height) * this.rows);
    if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) return null;
    return { c: c, r: r };
  };

  // Two tiles are swappable iff they're orthogonal neighbours.
  function neighbours(a, b) {
    if (!a || !b) return false;
    var dc = Math.abs(a.c - b.c);
    var dr = Math.abs(a.r - b.r);
    return (dc === 1 && dr === 0) || (dc === 0 && dr === 1);
  }

  InputManager.prototype._listen = function () {
    var self = this;

    // Pointer Events would be cleaner but Safari on iOS still has quirks
    // around getting the right coalesced sequence inside a sandboxed iframe.
    // Mouse + touch listeners are duplicated rather than unified for that
    // reason — same handlers, different event shapes.
    function onDown(clientX, clientY, e) {
      var tile = self._tileFromEvent(clientX, clientY);
      if (!tile) return;
      if (e && e.preventDefault) e.preventDefault();
      self._tracking = true;
      self._startX = clientX;
      self._startY = clientY;
      self._startTile = tile;
      // Pointer interaction supersedes keyboard mode. Without this, a
      // keyboard user who pressed arrow once and then switched to touch
      // would see the dashed focus ring stuck on their last keyboard
      // cursor position alongside every new tap's selection ring.
      if (self._focused) {
        self._focused = null;
        self.emit("focus", null);
      }
    }

    // Released without enough movement → treat as a tap. Either select the
    // tile (no prior selection or non-adjacent) or, if the prior selection
    // is a neighbour, swap.
    function onTap(tile) {
      if (self.selected && neighbours(self.selected, tile)) {
        // Tapping the same tile again deselects; tapping a neighbour swaps.
        if (tile.c === self.selected.c && tile.r === self.selected.r) {
          self.clearSelection();
          return;
        }
        var a = self.selected;
        self.clearSelection();
        self.emit("swap", { c1: a.c, r1: a.r, c2: tile.c, r2: tile.r });
        return;
      }
      // Tapping the currently selected tile deselects.
      if (self.selected && self.selected.c === tile.c && self.selected.r === tile.r) {
        self.clearSelection();
        return;
      }
      self.selected = tile;
      self.emit("select", tile);
    }

    function onUp(clientX, clientY, e) {
      if (!self._tracking) return;
      self._tracking = false;
      var start = self._startTile;
      self._startTile = null;
      if (!start) return;

      var dx = clientX - self._startX;
      var dy = clientY - self._startY;
      var absDx = Math.abs(dx);
      var absDy = Math.abs(dy);

      if (Math.max(absDx, absDy) < SWIPE_MIN) {
        // Tap path — fall back to the tile under the *release* point in case
        // the finger drifted a few pixels (still below SWIPE_MIN). Keeps the
        // tap registered against the tile the user is looking at, not the
        // one they happened to land on a half-pixel away from the edge.
        var releaseTile = self._tileFromEvent(clientX, clientY) || start;
        onTap(releaseTile);
        return;
      }

      // Swipe path — derive the neighbour from the dominant axis. Diagonal
      // swipes are ambiguous; we resolve to whichever axis moved further.
      var dc = 0, dr = 0;
      if (absDx > absDy) dc = dx > 0 ? 1 : -1;
      else dr = dy > 0 ? 1 : -1;

      var target = { c: start.c + dc, r: start.r + dr };
      if (target.c < 0 || target.c >= self.cols || target.r < 0 || target.r >= self.rows) {
        // Swipe off the edge — silently drop. Don't deselect either; the
        // user might be trying to swipe a different direction next.
        return;
      }
      // Swipe overrides any prior tap-selection.
      self.clearSelection();
      self.emit("swap", { c1: start.c, r1: start.r, c2: target.c, r2: target.r });
    }

    this.canvas.addEventListener("mousedown", function (e) {
      onDown(e.clientX, e.clientY, e);
    });
    this.canvas.addEventListener("mouseup", function (e) {
      onUp(e.clientX, e.clientY, e);
    });
    // mouseleave (not mouseout) — mouseout fires when crossing child element
    // boundaries inside the canvas, which would cancel valid drags.
    this.canvas.addEventListener("mouseleave", function () {
      self._tracking = false;
      self._startTile = null;
    });

    this.canvas.addEventListener("touchstart", function (e) {
      if (e.touches.length > 1) { self._tracking = false; return; }
      var t = e.touches[0];
      onDown(t.clientX, t.clientY, e);
    }, { passive: false });
    this.canvas.addEventListener("touchmove", function (e) {
      // Stop iOS rubber-banding while a swap drag is in progress.
      if (self._tracking) e.preventDefault();
    }, { passive: false });
    this.canvas.addEventListener("touchend", function (e) {
      var t = e.changedTouches[0];
      onUp(t.clientX, t.clientY, e);
    });
    this.canvas.addEventListener("touchcancel", function () {
      self._tracking = false;
      self._startTile = null;
    });

    // Keyboard: arrows move a focus cursor, Enter/Space taps (select or
    // swap, same flow as a touch tap), Shift+Arrow performs a direct swap
    // (skips the two-step pick-then-swap). Escape toggles pause/resume.
    // Bound to the canvas (which is tabindex="0") rather than the document
    // so arrow keys still scroll the page when the canvas isn't focused.
    function clampFocus() {
      if (!self._focused) {
        self._focused = { c: Math.floor(self.cols / 2), r: Math.floor(self.rows / 2) };
        self.emit("focus", self._focused);
        return true; // initialised this press; don't move further
      }
      return false;
    }
    function moveFocus(dc, dr) {
      if (clampFocus()) return;
      var nc = Math.max(0, Math.min(self.cols - 1, self._focused.c + dc));
      var nr = Math.max(0, Math.min(self.rows - 1, self._focused.r + dr));
      if (nc === self._focused.c && nr === self._focused.r) return;
      self._focused = { c: nc, r: nr };
      self.emit("focus", self._focused);
    }
    function swapFocus(dc, dr) {
      if (clampFocus()) return;
      var nc = self._focused.c + dc;
      var nr = self._focused.r + dr;
      if (nc < 0 || nc >= self.cols || nr < 0 || nr >= self.rows) return;
      self.clearSelection();
      self.emit("swap", { c1: self._focused.c, r1: self._focused.r, c2: nc, r2: nr });
      // Move the cursor onto the destination so subsequent moves continue
      // from where the player was just looking.
      self._focused = { c: nc, r: nr };
      self.emit("focus", self._focused);
    }
    function activate() {
      if (clampFocus()) return;
      onTap(self._focused);
    }
    this.canvas.addEventListener("keydown", function (e) {
      switch (e.key) {
        case "ArrowLeft":  e.preventDefault();
          if (e.shiftKey) swapFocus(-1, 0); else moveFocus(-1, 0); return;
        case "ArrowRight": e.preventDefault();
          if (e.shiftKey) swapFocus(1, 0); else moveFocus(1, 0); return;
        case "ArrowUp":    e.preventDefault();
          if (e.shiftKey) swapFocus(0, -1); else moveFocus(0, -1); return;
        case "ArrowDown":  e.preventDefault();
          if (e.shiftKey) swapFocus(0, 1); else moveFocus(0, 1); return;
        case "Enter":
        case " ":
          e.preventDefault(); activate(); return;
        case "Escape":
          e.preventDefault(); self.emit("toggle"); return;
      }
    });

    this._bindButton(".restart-button", "restart");
    this._bindButton(".retry-button", "restart");
    this._bindButton(".start-button", "toggle");
    this._bindButton(".resume-button", "toggle");
  };

  InputManager.prototype._bindButton = function (selector, event) {
    var self = this;
    var el = document.querySelector(selector);
    if (!el) return;
    var handler = function (e) {
      e.preventDefault();
      e.stopPropagation();
      self.emit(event);
    };
    el.addEventListener("click", handler);
    el.addEventListener("touchend", handler);
  };

  window.Match3InputManager = InputManager;
})();

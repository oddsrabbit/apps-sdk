// Pointer + touch + keyboard input. Emits high-level events the application
// consumes — hit-testing is delegated to the renderer (it owns layout), so
// this file stays UI-event-shaped and doesn't grow card-position math.
//
// Events:
//   'pickup'      (source, pointerCanvas)   — drag started on a valid source.
//   'pointermove' (pointerCanvas)           — drag in progress.
//   'drop'        (pointerCanvas)           — drag released; app hit-tests
//                                              for the target itself.
//   'tap'         (location)                — pointerup on the same card the
//                                              press began on, without
//                                              exceeding the drag threshold.
//   'cancel'      ()                        — touch interrupted (e.g. system
//                                              gesture) before release.
//   'keyboard'    (action)                  — 'undo'|'restart'|'draw'.

(function () {
  // Below this CSS-px movement the gesture is treated as a tap, not a drag.
  // Tighter than match3 (14px) because in solitaire the press always starts
  // on a specific card — there's no "swipe across the board" gesture to
  // disambiguate from, so the threshold can be small without false drag
  // starts.
  var DRAG_MIN_PX = 8;

  function InputManager(canvas, opts) {
    this.canvas = canvas;
    this.events = {};
    this._hitTest = opts.hitTest;     // (x, y) → location object or null
    this._isDraggable = opts.isDraggable; // (location) → boolean
    this._tracking = false;
    this._dragging = false;
    this._pointerId = null;
    this._startX = 0;
    this._startY = 0;
    this._startLoc = null;
    this._listen();
  }

  InputManager.prototype.on = function (event, callback) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(callback);
  };

  InputManager.prototype.emit = function (event, data) {
    var listeners = this.events[event];
    if (!listeners) return;
    for (var i = 0; i < listeners.length; i++) listeners[i](data);
  };

  InputManager.prototype._listen = function () {
    var self = this;

    // Touch handlers MUST be { passive: false } — both because the engine
    // calls preventDefault() to stop iOS Safari's double-tap-to-zoom on
    // adjacent taps, and because Android Chrome silently downgrades
    // listeners to passive without the explicit flag (and then ignores any
    // preventDefault we issue). See CLAUDE.md / Android touch checklist.
    this.canvas.addEventListener("touchstart", function (e) {
      self._onPointerDown(e.touches[0].clientX, e.touches[0].clientY, e);
    }, { passive: false });

    this.canvas.addEventListener("touchmove", function (e) {
      if (!self._tracking) return;
      var t = e.touches[0];
      // Always preventDefault while a touch we own is in flight, otherwise
      // the page scrolls under our drag.
      e.preventDefault();
      self._onPointerMove(t.clientX, t.clientY);
    }, { passive: false });

    this.canvas.addEventListener("touchend", function (e) {
      if (!self._tracking) return;
      // touchend's `changedTouches` carries the lifted touch (touches/
      // targetTouches are empty at that point on iOS).
      var t = e.changedTouches[0];
      e.preventDefault();
      self._onPointerUp(t.clientX, t.clientY);
    }, { passive: false });

    this.canvas.addEventListener("touchcancel", function () {
      self._cancel();
    });

    // Mouse fallbacks. Mouse moves get listened on document.body (not the
    // canvas) so a fast drag that briefly leaves the canvas mid-move
    // doesn't lose tracking; same for mouseup which can fire outside the
    // canvas if the user releases past the edge.
    this.canvas.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return; // left click only
      self._onPointerDown(e.clientX, e.clientY, e);
    });

    document.addEventListener("mousemove", function (e) {
      if (!self._tracking) return;
      self._onPointerMove(e.clientX, e.clientY);
    });

    document.addEventListener("mouseup", function (e) {
      if (!self._tracking) return;
      self._onPointerUp(e.clientX, e.clientY);
    });

    // Keyboard shortcuts. Use a document-level listener so the canvas
    // doesn't need to be focused. Ignore when an input/button has focus
    // (basically never in this game, but cheap insurance).
    document.addEventListener("keydown", function (e) {
      if (e.defaultPrevented) return;
      var target = e.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      switch (e.key) {
        case "u":
        case "U":
          self.emit("keyboard", "undo");
          e.preventDefault();
          break;
        case "r":
        case "R":
          self.emit("keyboard", "restart");
          e.preventDefault();
          break;
        case " ":
        case "Spacebar":
          self.emit("keyboard", "draw");
          e.preventDefault();
          break;
      }
    });
  };

  // Convert a viewport (clientX/Y) coordinate into the canvas's internal
  // pixel coordinate system. The canvas is CSS-scaled to fit the viewport;
  // dividing by the current displayed size and multiplying by the intrinsic
  // size gives us a stable hit-test position regardless of how the canvas
  // was sized.
  InputManager.prototype._toCanvasCoords = function (clientX, clientY) {
    var rect = this.canvas.getBoundingClientRect();
    var x = (clientX - rect.left) * (this.canvas.width / rect.width);
    var y = (clientY - rect.top) * (this.canvas.height / rect.height);
    return { x: x, y: y };
  };

  InputManager.prototype._onPointerDown = function (clientX, clientY, originalEvent) {
    var pt = this._toCanvasCoords(clientX, clientY);
    var loc = this._hitTest(pt.x, pt.y);
    if (!loc) return;
    // Record start regardless of draggability, so an undraggable card (e.g.
    // stock face-down pile) can still emit a tap on release.
    this._tracking = true;
    this._dragging = false;
    this._startX = pt.x;
    this._startY = pt.y;
    this._startLoc = loc;
    // Stop the default so iOS Safari's tap highlight + selection don't
    // flicker over the canvas during a drag.
    if (originalEvent && typeof originalEvent.preventDefault === "function") {
      originalEvent.preventDefault();
    }
  };

  InputManager.prototype._onPointerMove = function (clientX, clientY) {
    if (!this._tracking) return;
    var pt = this._toCanvasCoords(clientX, clientY);
    if (!this._dragging) {
      var dx = pt.x - this._startX;
      var dy = pt.y - this._startY;
      if (dx * dx + dy * dy < DRAG_MIN_PX * DRAG_MIN_PX) return;
      // Promote to drag — but only if the source is something draggable
      // (the stock pile, for example, is tap-only).
      if (!this._isDraggable(this._startLoc)) {
        // Movement on a non-draggable source: abandon the gesture so we
        // don't fire a tap when the player lifts somewhere else.
        this._tracking = false;
        this._startLoc = null;
        return;
      }
      this._dragging = true;
      this.emit("pickup", { source: this._startLoc, pointer: pt });
    }
    this.emit("pointermove", pt);
  };

  InputManager.prototype._onPointerUp = function (clientX, clientY) {
    if (!this._tracking) return;
    var pt = this._toCanvasCoords(clientX, clientY);
    if (this._dragging) {
      this.emit("drop", pt);
    } else if (this._startLoc) {
      this.emit("tap", this._startLoc);
    }
    this._tracking = false;
    this._dragging = false;
    this._startLoc = null;
  };

  InputManager.prototype._cancel = function () {
    if (!this._tracking) return;
    if (this._dragging) this.emit("cancel");
    this._tracking = false;
    this._dragging = false;
    this._startLoc = null;
  };

  InputManager.DRAG_MIN_PX = DRAG_MIN_PX;
  window.SolitaireInputManager = InputManager;
})();

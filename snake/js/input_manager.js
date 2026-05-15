// Event-emitter input manager. Same shape as 2048's KeyboardInputManager so
// the game logic can subscribe with `.on('direction', cb)` etc., but adapted
// for snake's directional steering (4 vectors) instead of swipe-as-discrete-
// move. Touch swipes feed 'direction'; a tap with no swipe is treated as the
// pause toggle so the game can be played one-handed on mobile.

(function () {
  // A swipe shorter than this (in CSS px) is treated as a tap. ~14px is the
  // smallest deliberate finger movement on a high-DPI screen; below that, the
  // gesture is almost always an unintended drift while pressing.
  var SWIPE_MIN = 14;

  function InputManager() {
    this.events = {};
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

  InputManager.prototype._listen = function () {
    var self = this;

    // event.key → unit vector. Arrows, WASD, and Vim/HJKL all routed the
    // same way; HJKL kept for parity with 2048's keyboard binding.
    var keyMap = {
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
      s: { x: 0, y: 1 },  S: { x: 0, y: 1 },
      a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
      d: { x: 1, y: 0 },  D: { x: 1, y: 0 },
      k: { x: 0, y: -1 }, K: { x: 0, y: -1 },
      j: { x: 0, y: 1 },  J: { x: 0, y: 1 },
      h: { x: -1, y: 0 }, H: { x: -1, y: 0 },
      l: { x: 1, y: 0 },  L: { x: 1, y: 0 },
    };

    document.addEventListener("keydown", function (event) {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      var vec = keyMap[event.key];
      if (vec) {
        event.preventDefault();
        self.emit("direction", vec);
        return;
      }
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        self.emit("toggle");
      } else if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        self.emit("restart");
      }
    });

    // Touch handling. Bound to document.body (not the canvas) so the area
    // around the board still responds — same rationale as 2048: in a tight
    // mobile iframe the thumb often lands below the playable region.
    var startX = 0, startY = 0, startTime = 0, tracking = false;
    document.body.addEventListener("touchstart", function (event) {
      if (event.touches.length > 1) { tracking = false; return; }
      var t = event.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      startTime = Date.now();
      tracking = true;
      event.preventDefault();
    }, { passive: false });

    document.body.addEventListener("touchmove", function (event) {
      // Always prevent default to stop iOS rubber-banding while the user is
      // mid-gesture. Safe because nothing inside the iframe is scrollable.
      event.preventDefault();
    }, { passive: false });

    // touchcancel fires when the OS hijacks the gesture (incoming call,
    // system-level edge swipe, app switcher). Without resetting `tracking`
    // the next legitimate touchend would compute dx/dy against a stale
    // start point — usually emitting a spurious direction or pause.
    document.body.addEventListener("touchcancel", function () {
      tracking = false;
    });

    document.body.addEventListener("touchend", function (event) {
      if (!tracking) return;
      tracking = false;
      var t = event.changedTouches[0];
      var dx = t.clientX - startX;
      var dy = t.clientY - startY;
      var absDx = Math.abs(dx);
      var absDy = Math.abs(dy);
      if (Math.max(absDx, absDy) < SWIPE_MIN) {
        // Tap → toggle. The game decides whether that means start, pause, or
        // resume based on its own state.
        self.emit("toggle");
      } else if (absDx > absDy) {
        self.emit("direction", { x: dx > 0 ? 1 : -1, y: 0 });
      } else {
        self.emit("direction", { x: 0, y: dy > 0 ? 1 : -1 });
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
      // Stop the click/touch from bubbling up to body where the touch handler
      // would also fire 'toggle'. Without this, tapping "Resume" would
      // immediately re-pause.
      e.stopPropagation();
      self.emit(event);
    };
    el.addEventListener("click", handler);
    el.addEventListener("touchend", handler);
  };

  window.SnakeInputManager = InputManager;
})();

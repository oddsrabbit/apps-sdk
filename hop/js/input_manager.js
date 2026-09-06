// Event-emitter input manager. Same `.on(event, cb)` shape as the other games,
// reduced to what a one-button game needs: a single "tap" that means start,
// hop, or resume depending on the state the game is in (see HopGame.tap).
//
// Because every tap on the board is a hop, pausing gets its own on-screen
// button rather than sharing the tap the way snake does — the same trade Hex
// Rush makes, for the same reason.

(function () {
  // A touch that travels further than this is a drag, not a tap. There is no
  // drag gesture to conflict with; this only rejects the accidental swipe.
  var TAP_SLOP = 30;

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

    document.addEventListener("keydown", function (event) {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      // Auto-repeat would turn a held key into a continuous thruster, which
      // removes the entire skill of the game.
      if (event.repeat) return;

      if (event.key === " " || event.code === "Space" ||
          event.key === "ArrowUp" || event.key === "w" || event.key === "W") {
        event.preventDefault();
        self.emit("tap");
        return;
      }
      if (event.key === "p" || event.key === "P" || event.key === "Escape") {
        event.preventDefault();
        self.emit("toggle");
      } else if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        self.emit("restart");
      }
    });

    // Touch on document.body rather than the canvas — same rationale as the
    // other games: in a tight mobile iframe the thumb regularly lands just
    // outside the board, and a hop that only works over the canvas reads as
    // dropped input at exactly the worst moment.
    var startX = 0, startY = 0, tracking = false;

    document.body.addEventListener("touchstart", function (event) {
      if (event.touches.length > 1) { tracking = false; return; }
      // A press on a button must keep its synthesised click: preventDefault()
      // here suppresses it, and the click is the only thing the click-only
      // controls (share, leaderboard, mute, share-modal backdrop) listen for.
      // Skipping it costs nothing — `user-scalable=no` and `touch-action: none`
      // already block the zoom and scroll this call would otherwise stop.
      if (self._isInteractive(event.target)) { tracking = false; return; }
      var t = event.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      tracking = true;
      event.preventDefault();
    }, { passive: false });

    document.body.addEventListener("touchmove", function (event) {
      // Stops iOS rubber-banding mid-gesture. Safe because nothing inside the
      // iframe scrolls. Skipped over buttons for the same reason as touchstart:
      // a slight finger move during a press would otherwise cancel the click.
      if (self._isInteractive(event.target)) return;
      event.preventDefault();
    }, { passive: false });

    document.body.addEventListener("touchcancel", function () {
      tracking = false;
    });

    // The hop fires on touchEND rather than touchstart. That costs a few
    // milliseconds of latency, but it is the only way to tell a tap from the
    // start of a drag, and it keeps this consistent with the button handling
    // below (which must not also hop).
    document.body.addEventListener("touchend", function (event) {
      if (!tracking) return;
      tracking = false;
      // Same guard the click handler below applies. It cannot be left to that
      // handler: touchstart calls preventDefault(), so no click is synthesised
      // for a tap, and without this a press on a click-only control (share,
      // leaderboard, mute) drives the board instead of the button.
      if (self._isInteractive(event.target)) return;
      var t = event.changedTouches[0];
      if (Math.abs(t.clientX - startX) > TAP_SLOP) return;
      if (Math.abs(t.clientY - startY) > TAP_SLOP) return;
      self.emit("tap");
    });

    // Mouse click for desktop, gated on the event genuinely coming from a
    // mouse. Without the guard this double-fires on touch devices, where a tap
    // synthesises a click after touchend and the rabbit hops twice.
    document.body.addEventListener("click", function (event) {
      if (event.detail === 0) return;             // keyboard-activated click
      if (self._isInteractive(event.target)) return;
      if (typeof event.pointerType === "string" && event.pointerType !== "mouse") return;
      if (event.sourceCapabilities && event.sourceCapabilities.firesTouchEvents) return;
      self.emit("tap");
    });

    this._bindButton(".restart-button", "restart");
    this._bindButton(".retry-button", "restart");
    this._bindButton(".start-button", "tap");
    this._bindButton(".resume-button", "tap");
    this._bindButton(".pause-button", "toggle");
  };

  // Buttons, links and any open modal must not also hop the rabbit underneath
  // the thing the player actually pressed.
  InputManager.prototype._isInteractive = function (node) {
    while (node && node !== document.body) {
      if (node.nodeType === 1) {
        var tag = node.tagName;
        if (tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "SELECT") return true;
        if (node.classList && node.classList.contains("lb-backdrop")) return true;
        if (node.classList && node.classList.contains("share-modal-backdrop")) return true;
      }
      node = node.parentNode;
    }
    return false;
  };

  InputManager.prototype._bindButton = function (selector, event) {
    var self = this;
    var el = document.querySelector(selector);
    if (!el) return;
    var handler = function (e) {
      e.preventDefault();
      // Keep the press from bubbling to body, where the touch/click handlers
      // would fire a second hop. Without this, tapping "Resume" resumes and
      // immediately hops.
      e.stopPropagation();
      self.emit(event);
    };
    el.addEventListener("click", handler);
    el.addEventListener("touchend", handler);
  };

  window.HopInputManager = InputManager;
})();

// Event-emitter input manager. Same `.on(event, cb)` shape as snake's and
// match3's, adapted to Hex Rush's single axis of control: the hexagon turns one
// side left or one side right, and nothing else.
//
// TAP-TO-ROTATE IS THE WHOLE TOUCH SCHEME. A tap on the left half of the board
// turns the hexagon one way, the right half the other. That leaves no tap
// gesture free to mean "pause", which is why pausing has its own on-screen
// button rather than sharing the tap the way snake does. Getting this wrong in
// the other direction — a tap-anywhere pause plus swipe-to-rotate — was worse
// in practice: rotation is needed several times a second and a swipe is far
// slower to repeat than a tap.

(function () {
  // A touch that moves further than this is a drag, not a tap. Rotation is
  // fired on touchend, so this only exists to ignore the accidental scroll-ish
  // gesture; there is no drag control to conflict with.
  var TAP_SLOP = 26;

  function InputManager(target) {
    this.events = {};
    // The element whose midpoint splits left from right. The canvas rather
    // than the window: the board is centred in a wider page on desktop, and
    // splitting on the window would make the whole left margin rotate
    // counter-clockwise even though it is nowhere near the hexagon.
    this.target = target || document.body;
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

  // Which way a tap at clientX turns the hexagon: left of the board's centre
  // is counter-clockwise, right is clockwise.
  InputManager.prototype._dirForX = function (clientX) {
    var rect = this.target.getBoundingClientRect();
    var mid = rect.left + rect.width / 2;
    return clientX < mid ? -1 : 1;
  };

  InputManager.prototype._listen = function () {
    var self = this;

    var keyMap = {
      ArrowLeft: -1, ArrowRight: 1,
      a: -1, A: -1, d: 1, D: 1,
      h: -1, H: -1, l: 1, L: 1,
    };

    document.addEventListener("keydown", function (event) {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      var dir = keyMap[event.key];
      if (dir) {
        event.preventDefault();
        self.emit("rotate", dir);
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

    // Pointer handling on the document body rather than the canvas — same
    // rationale as snake: inside a tight mobile iframe the thumb regularly
    // lands just outside the board, and a rotation that only works when you
    // hit the canvas reads as dropped input.
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

    // Fires when the OS takes the gesture (call, app switcher, edge swipe).
    // Without clearing `tracking` the next touchend would rotate off a stale
    // start point.
    document.body.addEventListener("touchcancel", function () {
      tracking = false;
    });

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
      self.emit("rotate", self._dirForX(t.clientX));
    });

    // Mouse click for desktop, gated on the event actually coming from a
    // mouse. Without the guard this double-fires on touch devices, where a tap
    // synthesises a click after touchend and the hexagon spins twice.
    document.body.addEventListener("click", function (event) {
      if (event.detail === 0) return;              // keyboard-activated click
      if (self._isInteractive(event.target)) return;
      if (typeof event.pointerType === "string" && event.pointerType !== "mouse") return;
      if (event.sourceCapabilities && event.sourceCapabilities.firesTouchEvents) return;
      self.emit("rotate", self._dirForX(event.clientX));
    });

    this._bindButton(".restart-button", "restart");
    this._bindButton(".retry-button", "restart");
    this._bindButton(".start-button", "toggle");
    this._bindButton(".resume-button", "toggle");
    this._bindButton(".pause-button", "toggle");
  };

  // Buttons, links and the leaderboard modal must not also rotate the board
  // underneath the thing the player actually pressed.
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
      // would also fire a rotation. Without this, tapping "Resume" resumes and
      // immediately turns the hexagon.
      e.stopPropagation();
      self.emit(event);
    };
    el.addEventListener("click", handler);
    el.addEventListener("touchend", handler);
  };

  window.HexInputManager = InputManager;
})();

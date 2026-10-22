function KeyboardInputManager() {
  this.events = {};

  if (window.navigator.msPointerEnabled) {
    //Internet Explorer 10 style
    this.eventTouchstart    = "MSPointerDown";
    this.eventTouchmove     = "MSPointerMove";
    this.eventTouchend      = "MSPointerUp";
  } else {
    this.eventTouchstart    = "touchstart";
    this.eventTouchmove     = "touchmove";
    this.eventTouchend      = "touchend";
  }

  this.listen();
}

KeyboardInputManager.prototype.on = function (event, callback) {
  if (!this.events[event]) {
    this.events[event] = [];
  }
  this.events[event].push(callback);
};

KeyboardInputManager.prototype.emit = function (event, data) {
  var callbacks = this.events[event];
  if (callbacks) {
    callbacks.forEach(function (callback) {
      callback(data);
    });
  }
};

KeyboardInputManager.prototype.listen = function () {
  var self = this;

  var map = {
    38: 0, // Up
    39: 1, // Right
    40: 2, // Down
    37: 3, // Left
    75: 0, // Vim up
    76: 1, // Vim right
    74: 2, // Vim down
    72: 3, // Vim left
    87: 0, // W
    68: 1, // D
    83: 2, // S
    65: 3  // A
  };

  // Respond to direction keys
  document.addEventListener("keydown", function (event) {
    var modifiers = event.altKey || event.ctrlKey || event.metaKey ||
                    event.shiftKey;
    var mapped    = map[event.which];

    if (!modifiers) {
      if (mapped !== undefined) {
        event.preventDefault();
        self.emit("move", mapped);
      }
    }

    // R key restarts the game
    if (!modifiers && event.which === 82) {
      self.restart.call(self, event);
    }
  });

  // Respond to button presses
  this.bindButtonPress(".retry-button", this.restart);
  this.bindButtonPress(".restart-button", this.restart);
  this.bindButtonPress(".keep-playing-button", this.keepPlaying);

  // Respond to swipe events. Upstream bound these to `.game-container`, which
  // left the area below the board (the "How to play" copy and any extra
  // iframe whitespace) dead to touch — bad UX in a mobile mini-app where the
  // thumb naturally lands in the lower half of the screen. We bind to
  // `document.body` instead so swipes register anywhere in the iframe.
  // Safe because nothing inside the body is scrollable (the iframe itself
  // owns any scroll), so the touchmove preventDefault doesn't block
  // legitimate scrolling.
  //
  // `{ passive: false }` is required on Android Chrome / WebView — listeners
  // attached to body/document/window are passive-by-default since Chrome 56,
  // and a passive listener's preventDefault() is silently ignored. Without
  // this, the WebView's scroll/pan heuristic steals the gesture mid-swipe
  // and swipes only register in narrow areas where the heuristic doesn't fire.
  var touchStartClientX, touchStartClientY;
  var gameContainer = document.body;

  // Because swipe detection covers the whole body (see above), a tap on a
  // CONTROL enters these handlers too — and `preventDefault()` on touchstart
  // suppresses the browser's synthesized mouse events for that entire
  // sequence, `click` included. A control wired to a plain `click` listener is
  // therefore dead to touch while still working perfectly under a mouse.
  //
  // That is exactly how the leaderboard button broke: the same code worked on
  // the web page (mouse) and was inert in the mobile WebView (tap), which is
  // what made it look like a platform or caching problem. 2048's own controls
  // escaped only because `bindButtonPress` binds `touchend` alongside `click`
  // — anything that forgets that pairing is silently touch-only-broken.
  //
  // Rather than require every control added from here on to remember it, leave
  // the default behaviour intact when the gesture STARTS on one. A tap on a
  // button is not the beginning of a board swipe, so nothing is lost.
  //
  // The leaderboard modal is in the selector for a second reason: it is
  // appended to `document.body`, so the unconditional touchmove
  // `preventDefault()` below would otherwise make its scrollable list (up to
  // 100 rows) impossible to scroll with a finger.
  var INTERACTIVE_SELECTOR =
    "button, a, input, select, textarea, [role='button'], .lb-backdrop";

  function startedOnControl(target) {
    return !!(target && target.closest && target.closest(INTERACTIVE_SELECTOR));
  }

  // Set on touchstart and held for the whole gesture: once the finger moves,
  // touchmove/touchend can report a different target than touchstart did, so
  // re-testing per event would flip mid-swipe.
  var gestureOnControl = false;

  gameContainer.addEventListener(this.eventTouchstart, function (event) {
    if ((!window.navigator.msPointerEnabled && event.touches.length > 1) ||
        event.targetTouches.length > 1) {
      return; // Ignore if touching with more than 1 finger
    }

    gestureOnControl = startedOnControl(event.target);

    if (window.navigator.msPointerEnabled) {
      touchStartClientX = event.pageX;
      touchStartClientY = event.pageY;
    } else {
      touchStartClientX = event.touches[0].clientX;
      touchStartClientY = event.touches[0].clientY;
    }

    if (gestureOnControl) return; // let the browser synthesize the click
    event.preventDefault();
  }, { passive: false });

  gameContainer.addEventListener(this.eventTouchmove, function (event) {
    if (gestureOnControl) return; // let the modal's list scroll
    event.preventDefault();
  }, { passive: false });

  gameContainer.addEventListener(this.eventTouchend, function (event) {
    if ((!window.navigator.msPointerEnabled && event.touches.length > 0) ||
        event.targetTouches.length > 0) {
      return; // Ignore if still touching with one or more fingers
    }

    // A gesture that began on a control belongs to that control, not to the
    // board — its start/end coordinates would otherwise read as a swipe.
    if (gestureOnControl) {
      gestureOnControl = false;
      return;
    }

    var touchEndClientX, touchEndClientY;

    if (window.navigator.msPointerEnabled) {
      touchEndClientX = event.pageX;
      touchEndClientY = event.pageY;
    } else {
      touchEndClientX = event.changedTouches[0].clientX;
      touchEndClientY = event.changedTouches[0].clientY;
    }

    var dx = touchEndClientX - touchStartClientX;
    var absDx = Math.abs(dx);

    var dy = touchEndClientY - touchStartClientY;
    var absDy = Math.abs(dy);

    if (Math.max(absDx, absDy) > 10) {
      // (right : left) : (down : up)
      self.emit("move", absDx > absDy ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
    }
  });
};

KeyboardInputManager.prototype.restart = function (event) {
  event.preventDefault();
  this.emit("restart");
};

KeyboardInputManager.prototype.keepPlaying = function (event) {
  event.preventDefault();
  this.emit("keepPlaying");
};

KeyboardInputManager.prototype.bindButtonPress = function (selector, fn) {
  var button = document.querySelector(selector);
  button.addEventListener("click", fn.bind(this));
  button.addEventListener(this.eventTouchend, fn.bind(this));
};

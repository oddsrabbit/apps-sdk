// Hop — rules engine. Original implementation.
//
// A rabbit falls under gravity across a scrolling garden. Every tap gives it
// one upward hop. Hedges grow from the ground and hang from the sky with a gap
// between them; clearing a gap scores a point, touching anything ends the run.
//
// FIXED TIMESTEP, DELIBERATELY. Unlike Hex Rush — whose blocks move linearly,
// so integrating them over a variable delta is exact — this game integrates
// gravity, and that is NOT delta-invariant: applying one 32ms step and two
// 16ms steps to the same rabbit gives two different heights. Left variable,
// the hop arc would be measurably different on a 60Hz phone and a 120Hz one,
// and the gaps are tuned tightly enough that players would notice. So the
// simulation advances in fixed 1/60s steps and the frame loop only decides how
// many of them to run.
//
// Everything here is in WORLD pixels — the fixed 320x480 coordinate system the
// renderer draws into before upscaling. That makes the physics constants
// literal and comparable (a hop lifts the rabbit ~58px; the gap is 122px) and
// keeps the game identical on every screen size.

(function () {
  var WIDTH = 320;
  var HEIGHT = 480;
  var GROUND_Y = 424;         // top of the ground strip; the floor that kills
  var CEILING_Y = 0;

  // The rabbit sits at a fixed x and the world moves past it.
  var RABBIT_X = 76;
  var RABBIT_W = 22;
  var RABBIT_H = 18;
  // The hitbox is inset from the drawn sprite. Pixel art reads as its silhouette
  // — ears and tail included — but being killed by an ear tip feels like a bug,
  // so collision uses the body only. Erring generous here is the single biggest
  // thing that makes a one-button game feel fair rather than fussy.
  var HIT_INSET_X = 4;
  var HIT_INSET_Y = 3;

  var START_Y = 190;

  // Per fixed step, not per second, because that is the unit they are applied
  // in. At 60 steps/s: gravity 0.45px/step^2 is 1620px/s^2, and a hop leaves
  // the rabbit at -7.2px/step = -432px/s.
  var GRAVITY = 0.45;
  var FLAP_VELOCITY = -7.2;
  var MAX_FALL = 10.5;

  // Hedges.
  var GATE_W = 46;
  var GATE_SPACING = 142;     // horizontal distance between gate centres
  var GAP_START = 122;
  var GAP_MIN = 92;
  var GAP_PER_POINT = 1.1;

  var SPEED_START = 2.05;     // world px per step
  var SPEED_MAX = 3.35;
  var SPEED_PER_POINT = 0.021;

  // Keep a gap clear of the ceiling and the ground, so no gate demands a
  // pixel-perfect hop against a hard boundary.
  var GAP_MARGIN_TOP = 46;
  var GAP_MARGIN_BOTTOM = 40;
  // Ceiling on how far a gap may move between consecutive gates. Without it,
  // two gates in a row can sit at opposite extremes, which at full scroll speed
  // is not reachable however well the player flies.
  var MAX_GAP_SHIFT = 86;

  // Frame budget. A backgrounded tab returns with a delta measured in seconds;
  // running every step it "owes" would fast-forward the rabbit into a hedge it
  // never had a chance to clear. Clamp the delta, then cap the steps per frame
  // as a second guard and drop whatever is left over.
  var MAX_FRAME_MS = 250;
  var STEP_MS = 1000 / 60;
  var MAX_STEPS_PER_FRAME = 6;

  // Idle bob, so the title screen is alive and the rabbit's shape is legible
  // before the player commits to a run.
  var BOB_AMPLITUDE = 5;
  var BOB_SPEED = 0.0042;

  function HopGame(options) {
    this.renderer = options.renderer;
    this.storage = options.storage;
    this.input = options.input;
    this.sound = options.sound || null;
    this.listener = options.listener || {};

    this.state = "idle";
    this.score = 0;
    this.best = this.storage ? this.storage.getBest() : 0;

    this.y = START_Y;
    this.vy = 0;
    this.gates = [];
    this.scroll = 0;            // total world distance travelled, for parallax
    this.tilt = 0;              // -1 rising, 0 level, 1 diving (render hint)

    this._accumulator = 0;
    // null, not 0, means "no previous frame". A timestamp of exactly 0 is a
    // legal value for the clock the frame loop is handed, and a falsy sentinel
    // would read that as "no previous frame" and silently drop the delta.
    this._lastFrame = null;
    this._elapsed = 0;          // drives the idle bob
    this._rafId = 0;
    this._boundFrame = this._frame.bind(this);

    this._bindInput();
  }

  // -------- lifecycle --------

  HopGame.prototype.boot = function () {
    this._reset();
    this._setState("idle");
    this._emitScore();
    this._emitBest();
    this._startLoop();
  };

  HopGame.prototype._reset = function () {
    this.score = 0;
    this.y = START_Y;
    this.vy = 0;
    this.scroll = 0;
    this.tilt = 0;
    this.gates = [];
    this._accumulator = 0;
    // First gate starts off the right edge, so a run opens with a moment of
    // clear air to find the rhythm in rather than an immediate obstacle.
    this._spawnGate(WIDTH + 60, HEIGHT / 2 - 30);
  };

  HopGame.prototype.start = function () {
    if (this.state === "playing") return;
    this._reset();
    this._emitScore();
    this._setState("playing");
    // The gesture that starts a run is also its first hop. Requiring a second
    // tap would drop the rabbit for the length of the player's reaction time,
    // which at these gravity values is most of the way to the ground.
    this._flap();
  };

  HopGame.prototype.pause = function () {
    if (this.state !== "playing") return;
    this._setState("paused");
  };

  HopGame.prototype.resume = function () {
    if (this.state !== "paused") return;
    // Drop the accumulated wall-clock gap and any partial step, so the first
    // frame back doesn't integrate the pause.
    this._lastFrame = null;
    this._accumulator = 0;
    this._setState("playing");
  };

  // One gesture, resolved against the current state: start, hop, or resume.
  // Keeping the decision here (rather than in the input manager) is what lets
  // a single tap serve all three without the input layer knowing the rules.
  HopGame.prototype.tap = function () {
    if (this.state === "idle") { this.start(); return; }
    if (this.state === "paused") { this.resume(); return; }
    if (this.state === "playing") { this._flap(); return; }
    // "over" deliberately does nothing. The tap that kills you is very often
    // still in flight when the run ends, and restarting on it would throw the
    // player into a fresh run before they have seen their score. The overlay's
    // Try again button is the way back.
  };

  HopGame.prototype.toggle = function () {
    if (this.state === "playing") this.pause();
    else if (this.state === "paused") this.resume();
  };

  HopGame.prototype.restart = function () {
    this._reset();
    this._emitScore();
    this._setState("playing");
    this._flap();
  };

  HopGame.prototype._setState = function (state) {
    this.state = state;
    if (this.listener.onState) this.listener.onState(state);
  };

  HopGame.prototype._flap = function () {
    // Assignment, not addition: a hop is a fixed launch speed, so tapping while
    // already rising doesn't stack into an un-loseable climb.
    this.vy = FLAP_VELOCITY;
    if (this.sound) this.sound.playFlap();
    if (this.listener.onFlap) this.listener.onFlap();
  };

  // -------- input --------

  HopGame.prototype._bindInput = function () {
    var self = this;
    if (!this.input) return;
    this.input.on("tap", function () { self.tap(); });
    this.input.on("toggle", function () { self.toggle(); });
    this.input.on("restart", function () { self.restart(); });
  };

  // -------- main loop --------

  HopGame.prototype._startLoop = function () {
    if (this._rafId) return;
    this._lastFrame = null;
    this._rafId = window.requestAnimationFrame(this._boundFrame);
  };

  HopGame.prototype._frame = function (now) {
    this._rafId = window.requestAnimationFrame(this._boundFrame);

    var dt = 0;
    if (this._lastFrame !== null) dt = Math.min(now - this._lastFrame, MAX_FRAME_MS);
    this._lastFrame = now;
    this._elapsed += dt;

    if (this.state === "playing") {
      this._accumulator += dt;
      var steps = 0;
      while (this._accumulator >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
        this._step();
        this._accumulator -= STEP_MS;
        steps++;
        if (this.state !== "playing") break;
      }
      // Hit the cap AND still owe more than a whole step: the machine cannot
      // keep up, or the tab just came back. Discard the backlog rather than
      // carrying it into the next frame, where it would compound into a spiral
      // of ever-longer catch-up.
      //
      // The second half of that condition matters. A frame that needed exactly
      // MAX_STEPS_PER_FRAME steps is not backlogged — it was served in full,
      // and what remains is the ordinary sub-step remainder every frame leaves.
      // Zeroing on the cap alone throws that remainder away, which at the cap's
      // own frame rate (~10fps) quietly runs the game about 8% slow.
      if (steps >= MAX_STEPS_PER_FRAME && this._accumulator > STEP_MS) {
        this._accumulator = 0;
      }
    }

    this._draw();
  };

  HopGame.prototype._step = function () {
    var speed = this._speed();

    this.vy = Math.min(this.vy + GRAVITY, MAX_FALL);
    this.y += this.vy;
    this.scroll += speed;

    // The ceiling clamps rather than kills. A rabbit that dies on the top edge
    // punishes the player for the safest thing they can do when a gap is high,
    // and every version of this genre that kills on the ceiling is worse for it.
    if (this.y < CEILING_Y) {
      this.y = CEILING_Y;
      if (this.vy < 0) this.vy = 0;
    }

    this.tilt = this.vy < -1.5 ? -1 : (this.vy > 4 ? 1 : 0);

    this._moveGates(speed);

    if (this._hitsGround() || this._hitsGate()) {
      this._gameOver();
    }
  };

  HopGame.prototype._speed = function () {
    return Math.min(SPEED_MAX, SPEED_START + this.score * SPEED_PER_POINT);
  };

  HopGame.prototype._gapHeight = function () {
    return Math.max(GAP_MIN, GAP_START - this.score * GAP_PER_POINT);
  };

  HopGame.prototype._spawnGate = function (x, gapY) {
    var gap = this._gapHeight();
    var min = GAP_MARGIN_TOP + gap / 2;
    var max = GROUND_Y - GAP_MARGIN_BOTTOM - gap / 2;

    var target;
    if (gapY == null) {
      var previous = this.gates.length ? this.gates[this.gates.length - 1].gapY : HEIGHT / 2;
      var low = Math.max(min, previous - MAX_GAP_SHIFT);
      var high = Math.min(max, previous + MAX_GAP_SHIFT);
      target = low + Math.random() * (high - low);
    } else {
      target = gapY;
    }

    this.gates.push({
      x: x,
      gapY: Math.max(min, Math.min(max, target)),
      gap: gap,
      passed: false,
    });
  };

  HopGame.prototype._moveGates = function (speed) {
    var alive = [];
    for (var i = 0; i < this.gates.length; i++) {
      var gate = this.gates[i];
      gate.x -= speed;

      // Scored the instant the gate's trailing edge clears the rabbit's leading
      // edge — the same moment the player sees themselves come through.
      if (!gate.passed && gate.x + GATE_W < RABBIT_X + HIT_INSET_X) {
        gate.passed = true;
        this.score++;
        this._emitScore();
        if (this.sound) this.sound.playScore();
        if (this.listener.onPass) this.listener.onPass(this.score);
      }

      if (gate.x + GATE_W > -8) alive.push(gate);
    }
    this.gates = alive;

    var last = this.gates.length ? this.gates[this.gates.length - 1] : null;
    if (!last || last.x < WIDTH - GATE_SPACING) {
      this._spawnGate(last ? last.x + GATE_SPACING : WIDTH, null);
    }
  };

  // -------- collision --------

  HopGame.prototype._hitbox = function () {
    return {
      left: RABBIT_X + HIT_INSET_X,
      right: RABBIT_X + RABBIT_W - HIT_INSET_X,
      top: this.y + HIT_INSET_Y,
      bottom: this.y + RABBIT_H - HIT_INSET_Y,
    };
  };

  HopGame.prototype._hitsGround = function () {
    return this._hitbox().bottom >= GROUND_Y;
  };

  HopGame.prototype._hitsGate = function () {
    var box = this._hitbox();
    for (var i = 0; i < this.gates.length; i++) {
      var gate = this.gates[i];
      if (box.right <= gate.x || box.left >= gate.x + GATE_W) continue;
      var gapTop = gate.gapY - gate.gap / 2;
      var gapBottom = gate.gapY + gate.gap / 2;
      if (box.top < gapTop || box.bottom > gapBottom) return true;
    }
    return false;
  };

  // -------- scoring / end --------

  HopGame.prototype._emitScore = function () {
    if (this.listener.onScore) this.listener.onScore(this.score);
  };

  HopGame.prototype._emitBest = function () {
    if (this.listener.onBest) this.listener.onBest(this.best);
  };

  HopGame.prototype._gameOver = function () {
    var isNewBest = this.score > this.best;
    if (isNewBest) {
      this.best = this.score;
      if (this.storage) this.storage.setBest(this.score);
      this._emitBest();
    }
    if (this.sound) this.sound.playHit();
    this._setState("over");
    if (this.listener.onGameOver) {
      this.listener.onGameOver({ score: this.score, isNewBest: isNewBest });
    }
  };

  // -------- render handoff --------

  HopGame.prototype._draw = function () {
    if (!this.renderer) return;

    // The idle rabbit bobs. Purely presentational, so it is computed here at
    // draw time rather than in _step: the simulation isn't running yet, and a
    // bob that fed back into `this.y` would change where the first hop starts.
    var drawY = this.y;
    if (this.state === "idle") {
      drawY = this.y + Math.sin(this._elapsed * BOB_SPEED) * BOB_AMPLITUDE;
    }

    this.renderer.draw({
      y: drawY,
      tilt: this.state === "idle" ? 0 : this.tilt,
      gates: this.gates,
      scroll: this.scroll,
      state: this.state,
      score: this.score,
    });
  };

  HopGame.WORLD = {
    WIDTH: WIDTH,
    HEIGHT: HEIGHT,
    GROUND_Y: GROUND_Y,
    RABBIT_X: RABBIT_X,
    RABBIT_W: RABBIT_W,
    RABBIT_H: RABBIT_H,
    GATE_W: GATE_W,
  };
  window.HopGame = HopGame;
})();

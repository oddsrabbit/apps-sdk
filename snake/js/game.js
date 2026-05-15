// Snake game logic. Pure state machine + setTimeout tick — no DOM, no canvas
// (the renderer and overlays are wired in by application.js). Keeping the
// game logic UI-free makes the speed/collision rules easy to reason about
// without scrolling past styling concerns.

(function () {
  var COLS = 24;
  var ROWS = 16;
  var INITIAL_LENGTH = 3;
  var SCORE_PER_FOOD = 10;
  var TICK_START_MS = 180;
  var TICK_FLOOR_MS = 70;
  // Per-food speed-up. 4ms × 27 foods to reach the floor — gentler curve than
  // ramazancetinkaya's 5ms (which hits the floor in 20 foods and gets twitchy
  // for casual play). Tuned so a reasonable score takes ~2 minutes.
  var TICK_DECREMENT_MS = 4;

  // States: 'idle' (pre-game, awaiting first input), 'playing', 'paused', 'over'.
  function SnakeGame(opts) {
    this.renderer = opts.renderer;
    this.storage = opts.storage;
    this.input = opts.input;
    this.listener = opts.listener || {};

    this._tickHandle = null;
  }

  SnakeGame.prototype._wireInput = function () {
    var self = this;
    this.input.on("direction", function (vec) { self._onDirection(vec); });
    this.input.on("toggle", function () { self._onToggle(); });
    this.input.on("restart", function () { self.restart(); });
  };

  SnakeGame.prototype.boot = function () {
    // _setup populates direction/snake/state *before* input handlers are
    // wired, so an event firing between bridge-ready and the first paint
    // can't hit an uninitialized state machine.
    this._setup();
    this._wireInput();
    this._setState("idle");
    this._render();
  };

  SnakeGame.prototype._setup = function () {
    // Start centered, length 3, facing right. Tail at (cx-2, cy), head at
    // (cx, cy). Player has ~10 ticks at the starting speed (1.8s) before
    // the wall arrives — enough breathing room to register the first input.
    var cy = Math.floor(ROWS / 2);
    var cx = Math.floor(COLS / 2);
    this.snake = [];
    for (var i = 0; i < INITIAL_LENGTH; i++) {
      this.snake.push({ x: cx - i, y: cy });
    }
    this.direction = { x: 1, y: 0 };
    this.pendingDirection = null;
    this.score = 0;
    this.tickMs = TICK_START_MS;
    this.food = this._spawnFood();
    this._notifyScore();
  };

  SnakeGame.prototype.restart = function () {
    this._stopTick();
    this._setup();
    this._setState("idle");
    this._render();
  };

  // The pause toggle. What it does depends on current state:
  //  idle    → start the game (commit any pending direction, run first tick)
  //  playing → pause
  //  paused  → resume
  //  over    → no-op (use restart instead)
  SnakeGame.prototype._onToggle = function () {
    if (this.state === "idle") {
      this._setState("playing");
      this._scheduleTick();
    } else if (this.state === "playing") {
      this._setState("paused");
      this._stopTick();
    } else if (this.state === "paused") {
      this._setState("playing");
      this._scheduleTick();
    }
  };

  SnakeGame.prototype.pause = function () {
    if (this.state !== "playing") return;
    this._setState("paused");
    this._stopTick();
  };

  SnakeGame.prototype._onDirection = function (vec) {
    if (this.state === "over" || this.state === "paused") return;

    if (this.state === "idle") {
      // Pre-game: the snake hasn't moved yet, so any direction is a valid
      // start input — including the spawn-facing direction (player swiped
      // the way the snake was already pointed) and the reverse direction
      // (player swiped "backwards"). For the reverse case we flip the body
      // so the head leads; otherwise the first tick would walk the head
      // straight into the second segment and trigger an instant game-over.
      if (vec.x === -this.direction.x && vec.y === -this.direction.y) {
        this.snake.reverse();
      }
      this.direction = vec;
      this.pendingDirection = null;
      this._setState("playing");
      this._scheduleTick();
      return;
    }

    // In-flight: reject a 180° reversal against the *committed* direction —
    // pressing ← while moving → would U-turn into your own neck. Comparing
    // against `this.direction` (not pendingDirection) lets the player still
    // queue a perpendicular turn during the same tick a previous turn was
    // queued. Same-direction repeats are dropped so a fast tap doesn't
    // overwrite an already-queued perpendicular turn.
    if (vec.x === -this.direction.x && vec.y === -this.direction.y) return;
    if (vec.x === this.direction.x && vec.y === this.direction.y) return;
    this.pendingDirection = vec;
  };

  SnakeGame.prototype._scheduleTick = function () {
    var self = this;
    this._tickHandle = setTimeout(function () {
      self._tickHandle = null;
      self._tick();
      if (self.state === "playing") self._scheduleTick();
    }, this.tickMs);
  };

  SnakeGame.prototype._stopTick = function () {
    if (this._tickHandle != null) {
      clearTimeout(this._tickHandle);
      this._tickHandle = null;
    }
  };

  SnakeGame.prototype._tick = function () {
    if (this.pendingDirection) {
      this.direction = this.pendingDirection;
      this.pendingDirection = null;
    }
    var head = this.snake[0];
    var nx = head.x + this.direction.x;
    var ny = head.y + this.direction.y;

    // Wall collision: the playable area is the inside of the 1-cell-thick
    // border. Hitting a wall cell ends the run.
    if (nx <= 0 || nx >= COLS - 1 || ny <= 0 || ny >= ROWS - 1) {
      this._gameOver();
      return;
    }

    var ate = (nx === this.food.x && ny === this.food.y);

    // Self-collision: scan all body cells *except* the tail, which is about
    // to move out of the way this tick — unless we ate (snake grows; tail
    // stays). Skipping the tail when not eating is a small but classic snake
    // bug fix: without it, the snake "dies" by chasing its own retreating
    // tail one cell behind.
    var bodyEnd = ate ? this.snake.length : this.snake.length - 1;
    for (var i = 0; i < bodyEnd; i++) {
      if (this.snake[i].x === nx && this.snake[i].y === ny) {
        this._gameOver();
        return;
      }
    }

    this.snake.unshift({ x: nx, y: ny });
    if (ate) {
      this.score += SCORE_PER_FOOD;
      if (this.tickMs > TICK_FLOOR_MS) {
        this.tickMs = Math.max(TICK_FLOOR_MS, this.tickMs - TICK_DECREMENT_MS);
      }
      this.food = this._spawnFood();
      this._notifyScore();
      if (this.listener.onAte) this.listener.onAte(this.score);
    } else {
      this.snake.pop();
    }

    this._render();
  };

  SnakeGame.prototype._gameOver = function () {
    this._stopTick();
    this._setState("over");
    this._render();
    var prevBest = this.storage ? this.storage.getBest() : 0;
    var isNewBest = this.score > prevBest;
    if (isNewBest && this.storage) this.storage.setBest(this.score);
    if (this.listener.onGameOver) {
      this.listener.onGameOver({ score: this.score, isNewBest: isNewBest, prevBest: prevBest });
    }
    if (isNewBest) this._notifyBest(this.score);
  };

  // Pick a random unoccupied cell. With a near-full board (worst case ~308
  // playable cells, snake fills them) this could in theory loop a long time;
  // in practice the snake reaches max length only at scores far beyond what
  // the speed cap allows, so a simple retry loop is fine.
  SnakeGame.prototype._spawnFood = function () {
    while (true) {
      var x = 1 + Math.floor(Math.random() * (COLS - 2));
      var y = 1 + Math.floor(Math.random() * (ROWS - 2));
      var clash = false;
      for (var i = 0; i < this.snake.length; i++) {
        if (this.snake[i].x === x && this.snake[i].y === y) { clash = true; break; }
      }
      if (!clash) return { x: x, y: y };
    }
  };

  SnakeGame.prototype._render = function () {
    this.renderer.draw({ snake: this.snake, food: this.food });
  };

  SnakeGame.prototype._setState = function (next) {
    this.state = next;
    if (this.listener.onState) this.listener.onState(next);
  };

  SnakeGame.prototype._notifyScore = function () {
    if (this.listener.onScore) this.listener.onScore(this.score);
  };

  SnakeGame.prototype._notifyBest = function (best) {
    if (this.listener.onBest) this.listener.onBest(best);
  };

  window.SnakeGame = SnakeGame;
})();

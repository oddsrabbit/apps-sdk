// Snake game logic. Pure state machine + setTimeout tick — no DOM, no canvas
// (the renderer and overlays are wired in by application.js). Keeping the
// game logic UI-free makes the speed/collision rules easy to reason about
// without scrolling past styling concerns.

(function () {
  var INITIAL_COLS = 24;
  var INITIAL_ROWS = 16;
  // World grows in fixed increments so cells stay on the grid and the aspect
  // ratio drifts predictably (24×16 = 3:2 → 40×32 ≈ 5:4). +2 each axis lets us
  // translate the snake +1,+1 on grow and keep it roughly centered.
  var GROW_COLS_PER_STEP = 2;
  var GROW_ROWS_PER_STEP = 2;
  var MAX_COLS = 40;
  var MAX_ROWS = 32;
  var FOODS_PER_GROW = 8;
  var INITIAL_LENGTH = 3;
  var SCORE_PER_FOOD = 10;
  // Bonus carrot. Worth 5× a regular carrot, appears probabilistically after
  // the player has eaten BONUS_MIN_INTERVAL regular carrots since the last
  // bonus, and vanishes after BONUS_LIFETIME_TICKS ticks if not eaten. The
  // tick-based lifetime makes it harder to grab as the game speeds up
  // (lifetime stays 40 ticks but each tick is shorter → less wall-clock
  // time) — a nice difficulty escalation that piggybacks on the existing
  // speed ramp. Eating a bonus grows the snake (same as a regular carrot)
  // and adds SCORE_PER_BONUS to the score, but does NOT increment
  // foodsEaten — so bonuses don't accelerate the speed-up or world-grow
  // cadence. The growth and points are the reward; the difficulty curve
  // stays anchored to regular-carrot count.
  var SCORE_PER_BONUS = 50;
  var BONUS_LIFETIME_TICKS = 40;
  var BONUS_MIN_INTERVAL = 3;
  var BONUS_SPAWN_CHANCE = 0.35;
  var TICK_START_MS = 180;
  var TICK_FLOOR_MS = 70;
  var TICK_DECREMENT_MS = 3;

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
    // Start centered, length 3, facing right. World dimensions live on the
    // instance now (not module constants) because they grow as the player
    // eats — see _maybeGrowWorld. Resetting to INITIAL_* here means restart
    // shrinks the arena back to the starting size.
    this.cols = INITIAL_COLS;
    this.rows = INITIAL_ROWS;
    if (this.renderer && this.renderer.resize) {
      this.renderer.resize(this.cols, this.rows);
    }
    var cy = Math.floor(this.rows / 2);
    var cx = Math.floor(this.cols / 2);
    this.snake = [];
    for (var i = 0; i < INITIAL_LENGTH; i++) {
      this.snake.push({ x: cx - i, y: cy });
    }
    this.direction = { x: 1, y: 0 };
    this.pendingDirection = null;
    this.score = 0;
    this.foodsEaten = 0;
    this.tickMs = TICK_START_MS;
    this.food = this._spawnFood();
    this.bonusFood = null;
    this.foodsSinceBonus = 0;
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

    // Bonus food expires by tick, not wall-clock — paused games freeze the
    // countdown naturally (setTimeout is cleared on pause). Decrement before
    // the collision check, but only despawn once ticksLeft has gone *below*
    // zero, so the bonus is still on the board for the tick where ticksLeft
    // lands on 0 — giving the player exactly BONUS_LIFETIME_TICKS eat
    // opportunities (off-by-one trap: removing at `<= 0` would silently drop
    // the final tick).
    if (this.bonusFood) {
      this.bonusFood.ticksLeft -= 1;
      if (this.bonusFood.ticksLeft < 0) this.bonusFood = null;
    }

    var head = this.snake[0];
    var nx = head.x + this.direction.x;
    var ny = head.y + this.direction.y;

    // Wall collision: the playable area is the full canvas now (the in-canvas
    // wall cells were removed so the .board-frame embossed CSS border isn't
    // doubled). Crossing the canvas edge ends the run.
    if (nx < 0 || nx >= this.cols || ny < 0 || ny >= this.rows) {
      this._gameOver();
      return;
    }

    var ateRegular = (nx === this.food.x && ny === this.food.y);
    var ateBonus = !!(this.bonusFood && nx === this.bonusFood.x && ny === this.bonusFood.y);
    var ate = ateRegular || ateBonus;

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

    if (ateBonus) {
      this.score += SCORE_PER_BONUS;
      this.bonusFood = null;
      // Reset cooldown so two bonuses can't appear back-to-back; the player
      // has to eat at least MIN_INTERVAL more regular carrots before another
      // bonus can roll.
      this.foodsSinceBonus = 0;
      if (this.listener.onAteBonus) this.listener.onAteBonus(this.score);
    }

    if (ateRegular) {
      this.score += SCORE_PER_FOOD;
      this.foodsEaten += 1;
      this.foodsSinceBonus += 1;
      if (this.tickMs > TICK_FLOOR_MS) {
        this.tickMs = Math.max(TICK_FLOOR_MS, this.tickMs - TICK_DECREMENT_MS);
      }
      // Grow world before spawning the next carrot so the spawn picks from
      // the expanded cell range.
      this._maybeGrowWorld();
      this.food = this._spawnFood();
      this._maybeSpawnBonusFood();
      if (this.listener.onAte) this.listener.onAte(this.score);
    }

    if (!ate) {
      this.snake.pop();
    }

    if (ate) this._notifyScore();
    this._render();
  };

  // Every FOODS_PER_GROW carrots, expand the playfield by GROW_*_PER_STEP
  // along each axis (capped at MAX_*). Snake and food are translated by half
  // the step so the existing layout stays roughly centered in the new arena
  // rather than getting pinned to the top-left corner. The renderer is
  // resized via its own `resize` hook so the canvas's internal pixel
  // dimensions track the cell grid (CSS keeps the displayed width fixed, so
  // adding cells visually zooms the playfield out).
  SnakeGame.prototype._maybeGrowWorld = function () {
    if (this.foodsEaten === 0 || this.foodsEaten % FOODS_PER_GROW !== 0) return;
    var nextCols = Math.min(MAX_COLS, this.cols + GROW_COLS_PER_STEP);
    var nextRows = Math.min(MAX_ROWS, this.rows + GROW_ROWS_PER_STEP);
    if (nextCols === this.cols && nextRows === this.rows) return;
    var dx = Math.floor((nextCols - this.cols) / 2);
    var dy = Math.floor((nextRows - this.rows) / 2);
    this.cols = nextCols;
    this.rows = nextRows;
    for (var i = 0; i < this.snake.length; i++) {
      this.snake[i].x += dx;
      this.snake[i].y += dy;
    }
    if (this.food) {
      this.food.x += dx;
      this.food.y += dy;
    }
    if (this.bonusFood) {
      this.bonusFood.x += dx;
      this.bonusFood.y += dy;
    }
    if (this.renderer && this.renderer.resize) {
      this.renderer.resize(this.cols, this.rows);
    }
  };

  // Probabilistic bonus carrot spawn. Called only after a regular eat, so
  // the cadence is naturally driven by player success rather than wall-clock
  // time. Skips if a bonus is already on the board (no stacking) or if the
  // post-bonus cooldown hasn't elapsed (MIN_INTERVAL regular carrots since
  // the last bonus disappeared, eaten or expired).
  SnakeGame.prototype._maybeSpawnBonusFood = function () {
    if (this.bonusFood) return;
    if (this.foodsSinceBonus < BONUS_MIN_INTERVAL) return;
    if (Math.random() >= BONUS_SPAWN_CHANCE) return;
    var spawn = this._spawnBonusFood();
    if (spawn) this.bonusFood = spawn;
  };

  // Pick an unoccupied cell that's also not the current regular food. Capped
  // attempts so a near-full board can't deadlock — bonus food is optional,
  // so giving up silently is fine.
  SnakeGame.prototype._spawnBonusFood = function () {
    for (var attempts = 0; attempts < 200; attempts++) {
      var x = Math.floor(Math.random() * this.cols);
      var y = Math.floor(Math.random() * this.rows);
      if (this.food && this.food.x === x && this.food.y === y) continue;
      var clash = false;
      for (var i = 0; i < this.snake.length; i++) {
        if (this.snake[i].x === x && this.snake[i].y === y) { clash = true; break; }
      }
      if (!clash) return { x: x, y: y, ticksLeft: BONUS_LIFETIME_TICKS };
    }
    return null;
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
      var x = Math.floor(Math.random() * this.cols);
      var y = Math.floor(Math.random() * this.rows);
      if (this.bonusFood && this.bonusFood.x === x && this.bonusFood.y === y) continue;
      var clash = false;
      for (var i = 0; i < this.snake.length; i++) {
        if (this.snake[i].x === x && this.snake[i].y === y) { clash = true; break; }
      }
      if (!clash) return { x: x, y: y };
    }
  };

  SnakeGame.prototype._render = function () {
    this.renderer.draw({ snake: this.snake, food: this.food, bonusFood: this.bonusFood });
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

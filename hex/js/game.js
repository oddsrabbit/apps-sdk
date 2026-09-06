// Hex Rush — rules engine. Original implementation.
//
// A hexagon sits at the centre of the board. Blocks drift inward along six
// fixed world lanes; the player rotates the hexagon so the side facing an
// incoming block is the colour they want it to stack on. Three or more
// connected same-colour blocks clear, everything above them collapses inward,
// and a chain of clears multiplies the score.
//
// GEOMETRY LIVES IN THE RENDERER, NOT HERE. Every position in this file is
// expressed in DEPTH UNITS: one unit is one block's thickness, measured
// outward from the hexagon's flat face. A falling block at depth 6.3 is 6.3
// blocks out; a side holding four blocks occupies depths 0..3 and its next
// block lands at depth 4. The renderer is the only thing that knows what a
// depth unit is worth in pixels, which is what lets the board resize freely
// (and lets this file be reasoned about without a canvas).
//
// The other consequence is that fall speed is in depth units per second, so
// difficulty reads the same on a phone and a desktop. A pixels-per-second
// speed would make the game meaningfully harder on the larger board, because
// the same wall-clock second would cover fewer blocks.

(function () {
  var SIDES = 6;

  // Stack height that ends the run. Seven is the number that makes the
  // hexagon fill the board at the renderer's chosen scale, so "about to lose"
  // is legible as "blocks are near the edge" rather than as an abstract count.
  var MAX_DEPTH = 7;

  // Where a block enters. Just outside the renderer's VISIBLE_DEPTH, so a block
  // starts fading in almost immediately after it spawns. Pushing it much
  // further out only adds invisible travel time, which reads to the player as
  // the board going quiet for no reason.
  var SPAWN_DEPTH = 14.5;

  // Two blocks in the same lane must not overlap in flight. A new spawn is
  // refused if the lane's newest block hasn't yet travelled this far inward.
  var LANE_CLEARANCE = 1.8;

  // Difficulty ramp, driven by score rather than elapsed time: a player who is
  // clearing well should be pushed, and a player who is barely surviving
  // shouldn't be pushed for merely staying alive. Both curves are linear in
  // score and clamped, so the game reaches its terminal difficulty at a
  // predictable place instead of accelerating forever.
  var SPEED_START = 2.1;      // depth units / second
  var SPEED_PER_POINT = 1 / 620;
  var SPEED_MAX = 6.4;

  var SPAWN_START = 1150;     // ms between spawns
  var SPAWN_PER_POINT = 1 / 7;
  var SPAWN_MIN = 360;

  // Three colours to begin with, four once the player has proven they can
  // clear. Adding the fourth colour is a much sharper difficulty step than any
  // speed increase, so it lands after the ramp above has already had time to
  // bite rather than at the same moment.
  var COLORS_EARLY = 3;
  var COLORS_LATE = 4;
  var FOURTH_COLOR_AT = 700;

  var MIN_GROUP = 3;          // connected same-colour cells needed to clear
  var POINTS_PER_BLOCK = 10;

  // How long after a clear a further clear still counts as part of the same
  // chain. Generous enough that a deliberate two-step setup reads as a combo,
  // short enough that unrelated clears half a screen apart don't.
  var COMBO_WINDOW_MS = 2600;
  var COMBO_MAX = 9;

  // Rotation animation speed, in steps (60 degrees) per second. The hexagon
  // does not snap: a visible sweep is what tells the player which way it went
  // when they tap twice quickly.
  var ROT_SPEED = 7.5;

  // Clear animation bookkeeping — purely cosmetic, handed to the renderer.
  var POP_MS = 260;

  // Largest frame delta we will integrate. A backgrounded tab resumes with a
  // multi-second delta; without this clamp every falling block would teleport
  // past the stack and land at once.
  var MAX_FRAME_MS = 50;

  function HexGame(options) {
    this.renderer = options.renderer;
    this.storage = options.storage;
    this.input = options.input;
    this.sound = options.sound || null;
    this.listener = options.listener || {};

    this.state = "idle";
    this.score = 0;
    this.best = this.storage ? this.storage.getBest() : 0;

    // stacks[side] is an array of colour indices, innermost first. Its length
    // is the side's height, so `stacks[side].length` is both "how many blocks"
    // and "the depth the next block lands at" — the two are the same number
    // and deliberately never tracked separately.
    this.stacks = [];
    this.falling = [];
    this.pops = [];

    // Rotation is tracked as an UNBOUNDED integer count of sixth-turns, not as
    // a value wrapped into 0..5. Wrapping is what makes rotation animation
    // fiddly: once the target has wrapped, "shortest path from here" and "the
    // direction the player actually pressed" stop agreeing, and correcting for
    // that means nudging the animated angle by hand on every input. An
    // unbounded target has neither problem — the animation always sweeps
    // monotonically toward it, in the pressed direction, by construction. The
    // hexagon's actual orientation is this value mod 6 (see _step), and the
    // renderer multiplies the animated float by 60 degrees, which is correct
    // for any value.
    this.rotationTarget = 0;    // committed, integer, unbounded
    this.rotationAngle = 0;     // animated, float, in sixth-turns
    this.combo = 1;
    this.comboTimer = 0;

    this._spawnTimer = 0;
    // null, not 0, means "no previous frame". A timestamp of exactly 0 is a
    // legal value for the clock the frame loop is handed, and a falsy sentinel
    // would read that as "no previous frame" and silently drop the delta.
    this._lastFrame = null;
    this._rafId = 0;
    this._boundFrame = this._frame.bind(this);

    this._bindInput();
  }

  // -------- lifecycle --------

  HexGame.prototype.boot = function () {
    this._reset();
    this._setState("idle");
    this._emitScore();
    this._emitBest();
    this._startLoop();
  };

  HexGame.prototype._reset = function () {
    this.stacks = [];
    for (var i = 0; i < SIDES; i++) this.stacks.push([]);
    this.falling = [];
    this.pops = [];
    this.score = 0;
    this.rotationTarget = 0;
    this.rotationAngle = 0;
    this.combo = 1;
    this.comboTimer = 0;
    // First block arrives on a short fuse rather than a full interval, so
    // starting a run doesn't open with a second of empty board.
    this._spawnTimer = 420;
  };

  HexGame.prototype.start = function () {
    if (this.state === "playing") return;
    this._reset();
    this._emitScore();
    this._setState("playing");
  };

  HexGame.prototype.pause = function () {
    if (this.state !== "playing") return;
    this._setState("paused");
  };

  HexGame.prototype.resume = function () {
    if (this.state !== "paused") return;
    // Drop the accumulated wall-clock gap. Without this the first frame after
    // a resume integrates the entire pause.
    this._lastFrame = null;
    this._setState("playing");
  };

  // What a tap or the space bar means, resolved against the current state.
  // Keeping this decision in the game (rather than in the input manager) is
  // what lets one gesture serve as start, pause and resume.
  HexGame.prototype.toggle = function () {
    if (this.state === "idle" || this.state === "over") this.start();
    else if (this.state === "playing") this.pause();
    else if (this.state === "paused") this.resume();
  };

  HexGame.prototype.restart = function () {
    this._reset();
    this._emitScore();
    this._setState("playing");
  };

  HexGame.prototype._setState = function (state) {
    this.state = state;
    if (this.listener.onState) this.listener.onState(state);
  };

  // -------- input --------

  HexGame.prototype._bindInput = function () {
    var self = this;
    if (!this.input) return;
    this.input.on("rotate", function (dir) { self._rotate(dir); });
    this.input.on("toggle", function () { self.toggle(); });
    this.input.on("restart", function () { self.restart(); });
  };

  // Rotation doubles as the "any input starts the game" affordance. A tap on
  // either half of the board and an arrow key both arrive here, so an idle or
  // finished board begins a run rather than silently swallowing the gesture —
  // and a paused one resumes. Only once a run is live does the input actually
  // turn the hexagon. Space (and the pause button) are the separate `toggle`
  // path, because on touch every tap is a rotation and pausing needs its own
  // control.
  HexGame.prototype._rotate = function (dir) {
    if (this.state === "idle" || this.state === "over") { this.start(); return; }
    if (this.state === "paused") { this.resume(); return; }
    this.rotationTarget += dir;
    if (this.sound) this.sound.playRotate();
  };

  // The hexagon's orientation: which sixth-turn it is committed to, in 0..5.
  HexGame.prototype._step = function () {
    return (((this.rotationTarget % SIDES) + SIDES) % SIDES);
  };

  // Which hexagon side currently faces a given world lane.
  //
  // Side j of the hexagon points at world lane (j + step). Inverting that
  // gives the side facing lane L. This reads the COMMITTED step rather
  // than the animated angle on purpose: a rotation the player has already
  // entered takes effect for landing immediately, even while the hexagon is
  // still visibly sweeping into place. The alternative — waiting for the
  // animation — makes a correct last-moment rotation lose to its own easing,
  // which is indistinguishable from the input being dropped.
  HexGame.prototype._sideForLane = function (lane) {
    return (((lane - this._step()) % SIDES) + SIDES) % SIDES;
  };

  // -------- main loop --------

  HexGame.prototype._startLoop = function () {
    if (this._rafId) return;
    this._lastFrame = null;
    this._rafId = window.requestAnimationFrame(this._boundFrame);
  };

  HexGame.prototype._frame = function (now) {
    this._rafId = window.requestAnimationFrame(this._boundFrame);

    var dt = 0;
    if (this._lastFrame !== null) dt = Math.min(now - this._lastFrame, MAX_FRAME_MS);
    this._lastFrame = now;

    if (this.state === "playing") this._update(dt);
    // Pops keep animating while paused or after a game over so the last clear
    // finishes on screen rather than freezing mid-flash.
    this._agePops(dt);
    this._animateRotation(dt);
    this._draw();
  };

  HexGame.prototype._animateRotation = function (dt) {
    var delta = this.rotationTarget - this.rotationAngle;
    if (delta === 0) return;
    var advance = ROT_SPEED * (dt / 1000);
    if (advance >= Math.abs(delta)) this.rotationAngle = this.rotationTarget;
    else this.rotationAngle += (delta > 0 ? 1 : -1) * advance;
  };

  HexGame.prototype._agePops = function (dt) {
    if (!this.pops.length) return;
    var alive = [];
    for (var i = 0; i < this.pops.length; i++) {
      this.pops[i].age += dt;
      if (this.pops[i].age < POP_MS) alive.push(this.pops[i]);
    }
    this.pops = alive;
  };

  HexGame.prototype._update = function (dt) {
    this._tickCombo(dt);
    this._tickSpawn(dt);
    this._tickFalling(dt);
  };

  HexGame.prototype._tickCombo = function (dt) {
    if (this.combo <= 1) return;
    this.comboTimer -= dt;
    if (this.comboTimer <= 0) {
      this.combo = 1;
      this.comboTimer = 0;
      if (this.listener.onCombo) this.listener.onCombo(1, 0);
    } else if (this.listener.onCombo) {
      this.listener.onCombo(this.combo, this.comboTimer / COMBO_WINDOW_MS);
    }
  };

  HexGame.prototype._tickSpawn = function (dt) {
    this._spawnTimer -= dt;
    if (this._spawnTimer > 0) return;
    this._spawnTimer += this._spawnInterval();
    this._spawn();
  };

  HexGame.prototype._spawnInterval = function () {
    return Math.max(SPAWN_MIN, SPAWN_START - this.score * SPAWN_PER_POINT);
  };

  HexGame.prototype._fallSpeed = function () {
    return Math.min(SPEED_MAX, SPEED_START + this.score * SPEED_PER_POINT);
  };

  HexGame.prototype._colorCount = function () {
    return this.score >= FOURTH_COLOR_AT ? COLORS_LATE : COLORS_EARLY;
  };

  HexGame.prototype._spawn = function () {
    // Pick a lane with room. Lanes are tried in a random rotation rather than
    // by repeated independent guesses so a crowded board still spawns
    // somewhere valid instead of rolling the same busy lane three times and
    // giving up. If every lane is genuinely occupied we skip this spawn; the
    // timer will come back around.
    var offset = Math.floor(Math.random() * SIDES);
    var lane = -1;
    for (var i = 0; i < SIDES; i++) {
      var candidate = (offset + i) % SIDES;
      if (this._laneHasRoom(candidate)) { lane = candidate; break; }
    }
    if (lane < 0) return;

    this.falling.push({
      lane: lane,
      color: Math.floor(Math.random() * this._colorCount()),
      depth: SPAWN_DEPTH,
    });
  };

  HexGame.prototype._laneHasRoom = function (lane) {
    for (var i = 0; i < this.falling.length; i++) {
      var b = this.falling[i];
      if (b.lane === lane && b.depth > SPAWN_DEPTH - LANE_CLEARANCE) return false;
    }
    return true;
  };

  HexGame.prototype._tickFalling = function (dt) {
    var speed = this._fallSpeed() * (dt / 1000);
    var moved = this.falling;
    var landed = [];
    var i;

    for (i = 0; i < moved.length; i++) moved[i].depth -= speed;

    // Landing is resolved in a second pass over the already-moved blocks.
    // Doing it inline above would let an earlier block's clear change `stacks`
    // underneath a later block in the same frame, so two blocks arriving
    // together would resolve against different boards depending purely on
    // their order in the array.
    this.falling = [];
    for (i = 0; i < moved.length; i++) {
      var block = moved[i];
      var side = this._sideForLane(block.lane);
      if (block.depth <= this.stacks[side].length) {
        landed.push({ block: block, side: side });
      } else {
        this.falling.push(block);
      }
    }

    for (var k = 0; k < landed.length; k++) {
      this._land(landed[k].block, landed[k].side);
      if (this.state !== "playing") return;
    }
  };

  HexGame.prototype._land = function (block, side) {
    this.stacks[side].push(block.color);
    if (this.sound) this.sound.playLand();
    if (this.listener.onLand) this.listener.onLand();

    var cleared = this._resolve();

    // The height check runs AFTER the cascade, so a block that lands on a
    // full-looking side and immediately completes a match is a save rather
    // than a loss. Losing to a stack that was about to disappear reads as the
    // game cheating, and this is the whole reason the check isn't in the push
    // above.
    if (!cleared && this.stacks[side].length > MAX_DEPTH) {
      this._gameOver();
    }
  };

  // -------- matching --------

  // Clears every connected same-colour group of MIN_GROUP or more, repeatedly,
  // until the board is stable. Returns whether anything cleared at all.
  //
  // Each pass is one link in the combo chain: the collapse from one clear can
  // create the next, and a player who set that up should be paid for it.
  HexGame.prototype._resolve = function () {
    var clearedAnything = false;

    for (;;) {
      var groups = this._findGroups();
      if (!groups.length) break;
      clearedAnything = true;

      var count = 0;
      var i, j;
      // Cells are recorded for the pop animation before removal, because after
      // the collapse their depths no longer mean anything.
      for (i = 0; i < groups.length; i++) {
        for (j = 0; j < groups[i].length; j++) {
          var cell = groups[i][j];
          this.pops.push({
            side: cell.side,
            depth: cell.depth,
            color: this.stacks[cell.side][cell.depth],
            age: 0,
            life: POP_MS,
          });
          count++;
        }
      }

      this._removeCells(groups);
      this._awardClear(count);
    }

    return clearedAnything;
  };

  // Every connected same-colour component of at least MIN_GROUP cells.
  //
  // Adjacency is (a) inward/outward within one side's stack and (b) sideways
  // to the neighbouring side at the SAME depth — but only where that
  // neighbour actually holds a block. Without the occupancy test a short stack
  // would connect through empty space to a tall one beside it, and groups
  // would clear across a visible gap.
  HexGame.prototype._findGroups = function () {
    var seen = {};
    var groups = [];
    var side, depth;

    for (side = 0; side < SIDES; side++) {
      for (depth = 0; depth < this.stacks[side].length; depth++) {
        var key = side + ":" + depth;
        if (seen[key]) continue;
        var group = this._flood(side, depth, seen);
        if (group.length >= MIN_GROUP) groups.push(group);
      }
    }
    return groups;
  };

  HexGame.prototype._flood = function (side, depth, seen) {
    var color = this.stacks[side][depth];
    var group = [];
    var queue = [{ side: side, depth: depth }];
    seen[side + ":" + depth] = true;

    while (queue.length) {
      var cell = queue.pop();
      group.push(cell);

      var neighbours = [
        { side: cell.side, depth: cell.depth - 1 },
        { side: cell.side, depth: cell.depth + 1 },
        { side: (cell.side + 1) % SIDES, depth: cell.depth },
        { side: (cell.side + SIDES - 1) % SIDES, depth: cell.depth },
      ];

      for (var i = 0; i < neighbours.length; i++) {
        var n = neighbours[i];
        if (n.depth < 0 || n.depth >= this.stacks[n.side].length) continue;
        if (this.stacks[n.side][n.depth] !== color) continue;
        var nkey = n.side + ":" + n.depth;
        if (seen[nkey]) continue;
        seen[nkey] = true;
        queue.push(n);
      }
    }

    return group;
  };

  // Rebuilds each affected side without the cleared depths. Filtering in order
  // IS the collapse: surviving blocks keep their relative order and slide
  // inward to close the gap, which is exactly the gravity this board has.
  HexGame.prototype._removeCells = function (groups) {
    var doomed = {};
    var i, j;
    for (i = 0; i < groups.length; i++) {
      for (j = 0; j < groups[i].length; j++) {
        var cell = groups[i][j];
        if (!doomed[cell.side]) doomed[cell.side] = {};
        doomed[cell.side][cell.depth] = true;
      }
    }

    for (var key in doomed) {
      if (!Object.prototype.hasOwnProperty.call(doomed, key)) continue;
      var side = Number(key);
      var next = [];
      var stack = this.stacks[side];
      for (var d = 0; d < stack.length; d++) {
        if (!doomed[key][d]) next.push(stack[d]);
      }
      this.stacks[side] = next;
    }
  };

  HexGame.prototype._awardClear = function (count) {
    var gained = count * POINTS_PER_BLOCK * this.combo;
    var multiplier = this.combo;

    this.score += gained;
    this._emitScore();

    if (this.sound) this.sound.playClear(multiplier);
    if (this.listener.onClear) {
      this.listener.onClear({ count: count, multiplier: multiplier, gained: gained });
    }

    // The multiplier applies to the clear that was already in flight, then
    // steps up for the next one. Incrementing first would pay a lone clear at
    // double, which makes the chain bonus meaningless.
    if (this.combo < COMBO_MAX) this.combo++;
    this.comboTimer = COMBO_WINDOW_MS;
    if (this.listener.onCombo) this.listener.onCombo(this.combo, 1);
  };

  // -------- scoring / end --------

  HexGame.prototype._emitScore = function () {
    if (this.listener.onScore) this.listener.onScore(this.score);
  };

  HexGame.prototype._emitBest = function () {
    if (this.listener.onBest) this.listener.onBest(this.best);
  };

  HexGame.prototype._gameOver = function () {
    var isNewBest = this.score > this.best;
    if (isNewBest) {
      this.best = this.score;
      if (this.storage) this.storage.setBest(this.score);
      this._emitBest();
    }
    if (this.sound) this.sound.playGameOver();
    this._setState("over");
    if (this.listener.onGameOver) {
      this.listener.onGameOver({ score: this.score, isNewBest: isNewBest });
    }
  };

  // -------- render handoff --------

  HexGame.prototype._draw = function () {
    if (!this.renderer) return;
    this.renderer.draw({
      stacks: this.stacks,
      falling: this.falling,
      pops: this.pops,
      rotation: this.rotationAngle,
      state: this.state,
      combo: this.combo,
      comboFrac: this.combo > 1 ? this.comboTimer / COMBO_WINDOW_MS : 0,
      maxDepth: MAX_DEPTH,
      spawnDepth: SPAWN_DEPTH,
    });
  };

  HexGame.SIDES = SIDES;
  HexGame.MAX_DEPTH = MAX_DEPTH;
  window.HexGame = HexGame;
})();

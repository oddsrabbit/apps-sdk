// Match-3 game engine. Pure state machine + requestAnimationFrame loop — no
// DOM, no canvas-drawing. Renderer reads the public board state each frame;
// application.js wires score/state/best/over/combo events into the UI chrome.
//
// Mechanics: 8x8 grid, cluster-find, cascade, score = length² × combo.
// Polish layered on top of the core: floating score popups, cascade combo
// multiplier, screen shake on big clears, idle hint after 8s of inactivity,
// new-best confetti, initial cascade-in animation, and special tiles for
// 4/5+ matches (striped + rainbow bomb).
//
// Outer state (consumed by application.js):
//   'idle'    — board generated, awaiting first tap to start the timer
//   'playing' — timer is running, swaps are accepted
//   'paused'  — backgrounded or manually paused; timer frozen
//   'over'    — timer expired or no valid moves remain
//
// Inner animation phases:
//   ready     — accepting input
//   swap-fwd  — animating the player's swap forward
//   swap-back — animating the swap rewinding (invalid swap, no cluster)
//   resolve   — clusters shrinking + survivors falling into the gaps below
//   refill    — fresh tiles falling in from above to fill the empty rows
// Animations run in 'idle' too (initial board cascade-in), but no-moves
// detection and the timer only run in 'playing'.

(function () {
  var COLS = 8;
  var ROWS = 8;
  var TILE_TYPES = 6;
  var ANIM_TIME = 0.18; // seconds per animation phase

  var TIMER_START = 90;
  var SCORE_TO_TIME = 3;     // pts per second of timer bonus
  var TIMER_DRAIN_SCALE = 2000;

  // Stage definitions — endless mode with escalating rules. Advancing
  // through stages is score-gated (not time-gated), so a careful low-score
  // player still progresses if they survive long enough. The curve runs to
  // stage 7 (FRENZY) and stops there: by then the drain multiplier alone is
  // ~2.9× and, stacked on the score-based ramp in _currentDrainRate, the
  // clock empties fast enough that the run is decided on reflexes, not on
  // ever-steeper numbers — escalating past it would stop reading as progress
  // and start reading as a wall. lockRate / lockDoubleRate are probabilities
  // applied per refilled tile in _shiftAndRefill; drainMult stacks
  // multiplicatively on top of the score-based drain in _currentDrainRate.
  // Order in the array matches stage IDs (1-7) so the index→id mapping is
  // just +1.
  //
  // Tuning note: the drain felt far too slow in early playtests (a fresh
  // board barely moved the bar). Both levers were sharpened — the per-stage
  // drainMult ramps harder and TIMER_DRAIN_SCALE was lowered so the
  // score-based term climbs sooner — so the timer's pace visibly accelerates
  // as a run goes deep instead of flat-lining at ~1/sec.
  var STAGES = [
    { id: 1, minScore: 0,    drainMult: 1.0,  lockRate: 0.0,  lockDoubleRate: 0.0,  label: "" },
    { id: 2, minScore: 200,  drainMult: 1.2,  lockRate: 0.08, lockDoubleRate: 0.0,  label: "LOCKED TILES" },
    { id: 3, minScore: 500,  drainMult: 1.45, lockRate: 0.12, lockDoubleRate: 0.0,  label: "FASTER" },
    { id: 4, minScore: 1000, drainMult: 1.7,  lockRate: 0.18, lockDoubleRate: 0.03, label: "REINFORCED" },
    { id: 5, minScore: 2000, drainMult: 2.0,  lockRate: 0.25, lockDoubleRate: 0.05, label: "ENDURANCE" },
    { id: 6, minScore: 3500, drainMult: 2.4,  lockRate: 0.30, lockDoubleRate: 0.07, label: "RELENTLESS" },
    { id: 7, minScore: 5500, drainMult: 2.9,  lockRate: 0.35, lockDoubleRate: 0.10, label: "FRENZY" },
  ];

  function stageFor(score) {
    for (var i = STAGES.length - 1; i >= 0; i--) {
      if (score >= STAGES[i].minScore) return STAGES[i];
    }
    return STAGES[0];
  }

  // Fruit hex colours mirror renderer.js's FRUITS palette — duplicated here
  // so the engine can colour popup text per fruit without an upward import.
  // Order must match renderer FRUITS array.
  var FRUIT_HEX = ["#FF5252", "#FFD54F", "#9C27B0", "#2ECC71", "#FF9800", "#3F8EFC"];

  // Confetti palette — vivid party colours, intentionally distinct from the
  // fruit palette so a new-best burst reads as a celebration, not gameplay.
  var CONFETTI_HEX = ["#FF3D7F", "#FFA63D", "#FFE93D", "#3DDB7C", "#3DABFF", "#B14DFF"];

  function Game(opts) {
    this.renderer = opts.renderer;
    this.storage = opts.storage;
    this.input = opts.input;
    this.listener = opts.listener || {};

    this._rafHandle = null;
    this._lastFrame = 0;
  }

  Game.prototype._wireInput = function () {
    var self = this;
    this.input.on("swap", function (move) { self._onSwap(move); });
    this.input.on("select", function (tile) { self._onSelect(tile); });
    this.input.on("focus", function (tile) { self._onFocus(tile); });
    this.input.on("toggle", function () { self._onToggle(); });
    this.input.on("restart", function () { self.restart(); });
  };

  Game.prototype.boot = function () {
    this._setup();
    this._wireInput();
    this.input.setGrid(COLS, ROWS);
    this._setState("idle");
    this._loop = this._loop.bind(this);
    this._rafHandle = window.requestAnimationFrame(this._loop);
  };

  Game.prototype._setup = function () {
    this.cols = COLS;
    this.rows = ROWS;
    this.tileTypes = TILE_TYPES;

    // 2D grid of tiles. Each cell carries:
    //   type     — 0..TILE_TYPES-1 (fruit), or -1 when flagged for removal
    //   shift    — per-resolve fall distance (cells) for the renderer
    //   fallFrom — per-refill drop-in distance (cells) for the renderer
    //   special  — null | 'h-striped' | 'v-striped' | 'bomb'
    //   locked   — 0 (normal) | 1 (locked once) | 2 (double-locked)
    // shift/fallFrom are renderer hints, reset each phase. special and
    // locked persist until the tile is cleared. locked tiles are excluded
    // from cluster matching (effectiveType returns -1) and unlock by being
    // adjacent to a cleared cluster cell — see _removeClusters.
    this.tiles = new Array(COLS);
    for (var i = 0; i < COLS; i++) {
      this.tiles[i] = new Array(ROWS);
      for (var j = 0; j < ROWS; j++) {
        this.tiles[i][j] = { type: 0, shift: 0, fallFrom: 0, special: null, locked: 0 };
      }
    }

    this._generateValidBoard();

    this.score = 0;
    this.timer = TIMER_START;
    this.timerMax = TIMER_START;

    // Initial cascade-in: every tile starts ROWS+1 cells above its slot so
    // the entire board drops in on first paint. Phase 'refill' is set so
    // the loop animates this even though state stays 'idle' until the
    // first player input.
    for (var ic = 0; ic < this.cols; ic++) {
      for (var jc = 0; jc < this.rows; jc++) {
        this.tiles[ic][jc].fallFrom = this.rows + 1;
      }
    }

    this.phase = "refill";
    this.animTime = 0;
    this.currentMove = null;
    this.clusters = [];
    this.selected = null;

    // Polish state -------------------------------------------------
    this.particles = [];      // small bursts on tile clear
    this.popups = [];         // floating "+N" / "+5s" text
    this.confetti = [];       // new-best celebration only
    this.comboCount = 0;      // per-turn cascade depth; resets on player swap
    this.shakeT = 0;          // remaining shake duration, seconds
    this.shakeAmp = 0;        // current peak shake amplitude, CSS px
    this.focused = null;      // keyboard cursor cell (null until first key press)

    // Stage state — STAGES[0] is the silent warm-up (no banner emitted on
    // entry). _stage is the full config object kept on the instance so the
    // drain rate + refill spawn rate can read it without a lookup; this.stage
    // is the public id duplicated for renderer/listener use.
    this._stage = STAGES[0];
    this.stage = this._stage.id;

    // Memoised _findMoves(). Holds the result for the current phase so the
    // per-frame no-moves check + idle-hint pick share one scan instead of
    // re-running it 60×/sec. Invalidated on every phase change in _setPhase
    // (the only points where the board can mutate).
    this._movesCache = null;
  };

  Game.prototype.restart = function () {
    this._stopTimer();
    this._setup();
    if (this.input && this.input.clearSelection) this.input.clearSelection();
    this._setState("idle");
    this._notifyScore();
    this._notifyTimer();
  };

  // Toggle: idle → playing (start the timer), playing ↔ paused, over → no-op.
  Game.prototype._onToggle = function () {
    if (this.state === "idle") {
      this._setState("playing");
      this._startTimer();
    } else if (this.state === "playing") {
      this._setState("paused");
      this._stopTimer();
    } else if (this.state === "paused") {
      this._setState("playing");
      this._startTimer();
    }
  };

  Game.prototype.pause = function () {
    if (this.state !== "playing") return;
    this._setState("paused");
    this._stopTimer();
  };

  Game.prototype._onSelect = function (tile) {
    // The renderer only draws the selection ring when phase === 'ready', so
    // latching a selection during an animation would invisibly queue it and
    // then "magically" appear when phase returns to ready, swapping a tile
    // the player no longer intended. Drop it instead. tile===null comes
    // from clearSelection echoing back; suppress to avoid a reentrant loop.
    if (this.phase !== "ready") {
      if (tile && this.input && this.input.clearSelection) {
        this.input.clearSelection();
      }
      return;
    }
    this.selected = tile;
  };

  Game.prototype._onFocus = function (tile) {
    this.focused = tile;
  };

  // Player-initiated swap. Gated to playing + ready (or idle, in which case
  // the first swap starts the timer). Bomb activation is handled here as a
  // special case before the normal swap-and-check-clusters path.
  Game.prototype._onSwap = function (move) {
    if (this.state === "idle") {
      this._setState("playing");
      this._startTimer();
    }
    if (this.state !== "playing") return;
    if (this.phase !== "ready") return;

    var tileA = this.tiles[move.c1][move.r1];
    var tileB = this.tiles[move.c2][move.r2];

    // Locked tiles can't be moved — the gesture is silently dropped.
    // No swap-back animation because no swap happened: this avoids the
    // confusing "I tapped a fruit and it shook" experience when the
    // player tries to swap an iced tile they don't yet know is inert.
    if (tileA.locked > 0 || tileB.locked > 0) return;

    // Bomb activation: swap a rainbow bomb with a regular tile → clear all
    // tiles of the regular tile's colour (plus the bomb itself). Skips the
    // swap-fwd animation since the activation goes straight into resolve.
    // (Bomb + bomb is allowed but degrades to "clear bomb's neighbour
    // colour" — kept rather than letting a board-clear-everything case
    // exist, which felt too powerful in playtesting equivalents.)
    if (tileA.special === "bomb" || tileB.special === "bomb") {
      var bombIsA = tileA.special === "bomb";
      var partner = bombIsA ? tileB : tileA;
      var targetType = partner.type;
      if (targetType < 0) return; // partner is also a bomb; bail (rare)
      // Visually commit the swap so the bomb ends up at the partner slot.
      this._swap(move.c1, move.r1, move.c2, move.r2);
      this.currentMove = move;
      this.comboCount = 0;
      if (this.listener.onSwap) this.listener.onSwap();
      this._activateBomb(move, targetType);
      return;
    }

    this.currentMove = move;
    this.comboCount = 0;
    if (this.listener.onSwap) this.listener.onSwap();
    this._swap(move.c1, move.r1, move.c2, move.r2);
    this._setPhase("swap-fwd");
  };

  // --- Main loop -----------------------------------------------------

  Game.prototype._loop = function (t) {
    this._rafHandle = window.requestAnimationFrame(this._loop);
    var dt = this._lastFrame ? (t - this._lastFrame) / 1000 : 0;
    this._lastFrame = t;
    this._update(dt);
    this._render();
  };

  Game.prototype._update = function (dt) {
    // Background effects always animate (so confetti keeps flying on the
    // game-over screen, popups don't freeze on pause, etc.).
    this._updateParticles();
    this._updatePopups(dt);
    this._updateConfetti(dt);
    this._updateShake(dt);

    // Timer drain — rAF-driven (was setInterval @1Hz, which let game-over
    // fire while the CSS-transitioned bar still visually showed time at
    // high drain rates: a 3.5→0 tick at ×4 drain would trigger TIME'S UP
    // while the bar was still mid-transition between the previous tick's
    // and the new value). Per-frame updates keep the bar truthful and let
    // us check timeOut at the same resolution.
    if (this.state === "playing") {
      var prev = this.timer;
      this.timer = Math.max(0, this.timer - this._currentDrainRate() * dt);
      if (prev !== this.timer) this._notifyTimer();
      if (this.timer === 0) {
        this._gameOver("timeOut");
        return;
      }
    }

    // Paused/over: freeze the phase machine and skip no-moves/idle logic.
    if (this.state === "paused" || this.state === "over") return;

    if (this.phase === "ready") {
      // No-moves and idle-hint detection only apply while actively playing.
      if (this.state !== "playing") return;
      // Single _getMoves() call shared by both checks — the result is
      // memoised for the rest of this ready phase, so the per-frame cost
      // drops from "scan 112 swaps × find clusters" to "look up a cached array".
      var moves = this._getMoves();
      if (moves.length === 0) {
        // Deadlock recovery — instead of ending the run, shuffle the
        // unlocked tiles into a configuration with at least one valid
        // move. The game now only ends on the timer. (Locks stay in
        // place because they're a board-state mechanic, not a fruit
        // mechanic; shuffling them would feel like cheating to the
        // player who'd been "earning" their unlock by adjacency.)
        this._shuffleBoard();
        return;
      }
      return;
    }

    this.animTime += dt;
    if (this.animTime < ANIM_TIME) return;
    this.animTime = 0;

    if (this.phase === "swap-fwd") {
      this.clusters = this._findClusters();
      if (this.clusters.length > 0) {
        this._scoreClusters(this.clusters);
        this._removeClusters(this.clusters);
        this._setPhase("resolve");
      } else {
        // No cluster formed — the swap is about to rewind. Fire here (not in
        // the swap-back branch) so the "denied" cue lands the instant the
        // move is rejected, in sync with the rewind animation starting.
        if (this.listener.onInvalidSwap) this.listener.onInvalidSwap();
        this._setPhase("swap-back");
      }
    } else if (this.phase === "swap-back") {
      this._swap(this.currentMove.c1, this.currentMove.r1, this.currentMove.c2, this.currentMove.r2);
      this.currentMove = null;
      this.clusters = [];
      this._setPhase("ready");
    } else if (this.phase === "resolve") {
      this._shiftAndRefill();
      this.clusters = [];
      this._setPhase("refill");
    } else if (this.phase === "refill") {
      for (var i = 0; i < this.cols; i++) {
        for (var j = 0; j < this.rows; j++) {
          this.tiles[i][j].fallFrom = 0;
        }
      }
      this.clusters = this._findClusters();
      if (this.clusters.length > 0) {
        this._scoreClusters(this.clusters);
        this._removeClusters(this.clusters);
        this._setPhase("resolve");
      } else {
        this.currentMove = null;
        this._setPhase("ready");
      }
    }
  };

  Game.prototype._render = function () {
    if (!this.renderer) return;
    this.renderer.draw({
      tiles: this.tiles,
      cols: this.cols,
      rows: this.rows,
      tileTypes: this.tileTypes,
      phase: this.phase,
      animTime: this.animTime,
      animTotal: ANIM_TIME,
      currentMove: this.currentMove,
      clusters: this.clusters,
      selected: this.selected,
      focused: this.focused,
      particles: this.particles,
      popups: this.popups,
      confetti: this.confetti,
      shakeAmp: this.shakeAmp,
      shakeT: this.shakeT,
      now: (typeof performance !== "undefined" ? performance.now() : Date.now()),
    });
  };

  // --- Board generation ---------------------------------------------

  Game.prototype._generateValidBoard = function () {
    var done = false;
    var safety = 100;
    while (!done && safety-- > 0) {
      for (var i = 0; i < this.cols; i++) {
        for (var j = 0; j < this.rows; j++) {
          this.tiles[i][j].type = this._randomTile();
          this.tiles[i][j].shift = 0;
          this.tiles[i][j].special = null;
        }
      }
      this._resolveStartingClusters();
      if (this._findMoves().length > 0) done = true;
    }
    if (!done && typeof console !== "undefined" && console.warn) {
      // Effectively unreachable with 6 fruit types on an 8x8 grid, but a
      // future tweak (more types, smaller board, special seeding) could trip
      // it. Loud > silent.
      console.warn("match3: _generateValidBoard exhausted retries; board may have no valid moves");
    }
  };

  Game.prototype._randomTile = function () {
    return Math.floor(Math.random() * this.tileTypes);
  };

  Game.prototype._resolveStartingClusters = function () {
    var safety = 100;
    while (safety-- > 0) {
      var clusters = this._findClusters();
      if (clusters.length === 0) return;
      for (var k = 0; k < clusters.length; k++) {
        var cl = clusters[k];
        for (var n = 0; n < cl.length; n++) {
          var c = cl.horizontal ? cl.column + n : cl.column;
          var r = cl.horizontal ? cl.row : cl.row + n;
          this.tiles[c][r].type = this._randomTile();
        }
      }
    }
    if (typeof console !== "undefined" && console.warn) {
      console.warn("match3: _resolveStartingClusters exhausted retries; board may still contain pre-formed clusters");
    }
  };

  // --- Cluster + move detection -------------------------------------

  // Bombs are wildcards in matching theory, but to keep the cluster finder
  // simple we exclude them from runs entirely — bombs only activate via
  // swap, not by being part of an incidental 3-match. Locked tiles are
  // similarly excluded: they're inert until adjacency clears their lock.
  // Both cases return -1 so the run-based scan never extends through them.
  function effectiveType(tile) {
    if (tile.special === "bomb") return -1;
    if (tile.locked > 0) return -1;
    return tile.type;
  }

  Game.prototype._findClusters = function () {
    var clusters = [];

    // Horizontal runs
    for (var j = 0; j < this.rows; j++) {
      var runStart = 0;
      var runType = effectiveType(this.tiles[0][j]);
      for (var i = 1; i <= this.cols; i++) {
        var type = i < this.cols ? effectiveType(this.tiles[i][j]) : -2;
        if (type === runType && runType >= 0) continue;
        var len = i - runStart;
        if (len >= 3 && runType >= 0) {
          clusters.push({ column: runStart, row: j, length: len, horizontal: true, type: runType });
        }
        runStart = i;
        runType = type;
      }
    }

    // Vertical runs
    for (var c = 0; c < this.cols; c++) {
      var rStart = 0;
      var rType = effectiveType(this.tiles[c][0]);
      for (var r = 1; r <= this.rows; r++) {
        var t = r < this.rows ? effectiveType(this.tiles[c][r]) : -2;
        if (t === rType && rType >= 0) continue;
        var vlen = r - rStart;
        if (vlen >= 3 && rType >= 0) {
          clusters.push({ column: c, row: rStart, length: vlen, horizontal: false, type: rType });
        }
        rStart = r;
        rType = t;
      }
    }

    return clusters;
  };

  // Memoised wrapper around _findMoves. Cleared in _setPhase on every phase
  // transition (the only times the board can mutate), so the cache covers an
  // entire ready phase without ever returning stale data.
  Game.prototype._getMoves = function () {
    if (!this._movesCache) {
      this._movesCache = this._findMoves();
    }
    return this._movesCache;
  };

  // Non-mutating predicate: would swapping the two cells produce any 3+ run?
  // Avoids the swap-in-place trick the original _findMoves used — that was
  // fast in steady state but corrupted live state if anything between the
  // two swaps ever threw, and required us to scan every cell each call.
  // Bomb swaps short-circuit to true (they activate on any neighbour, the
  // cluster machinery is bypassed in _onSwap).
  Game.prototype._swapWouldMatch = function (c1, r1, c2, r2) {
    var self = this;
    var tileA = this.tiles[c1][r1];
    var tileB = this.tiles[c2][r2];
    // Locked check FIRST — _onSwap rejects locked partners, so any swap
    // involving one is not a valid move even if the other side is a bomb
    // (a bomb-vs-locked false positive would otherwise hide a real
    // no-moves state and keep the game running with no playable swaps).
    if (tileA.locked > 0 || tileB.locked > 0) return false;
    // Bomb-vs-bomb is also rejected by _onSwap (the inner partner.type<0
    // early return), so it isn't a valid move either.
    if (tileA.special === "bomb" && tileB.special === "bomb") return false;
    if (tileA.special === "bomb" || tileB.special === "bomb") return true;

    var typeA = tileA.type;
    var typeB = tileB.type;

    function typeAt(c, r) {
      // Virtual swap: the two source cells report their swapped types;
      // every other cell reports its real (bomb/locked-excluded) type so
      // existing bombs and locked tiles can't extend runs through them.
      // Without the locked exclusion, a virtual swap that places an
      // apple beside a locked apple would falsely register as a 3-match
      // (since locked tiles don't participate in real cluster scans).
      if (c === c1 && r === r1) return typeB;
      if (c === c2 && r === r2) return typeA;
      var t = self.tiles[c][r];
      if (t.special === "bomb") return -1;
      if (t.locked > 0) return -1;
      return t.type;
    }

    function hasRunAt(c, r) {
      var t = typeAt(c, r);
      if (t < 0) return false;
      var h = 1;
      for (var x = c - 1; x >= 0 && typeAt(x, r) === t; x--) h++;
      for (var x2 = c + 1; x2 < self.cols && typeAt(x2, r) === t; x2++) h++;
      if (h >= 3) return true;
      var v = 1;
      for (var y = r - 1; y >= 0 && typeAt(c, y) === t; y--) v++;
      for (var y2 = r + 1; y2 < self.rows && typeAt(c, y2) === t; y2++) v++;
      return v >= 3;
    }

    return hasRunAt(c1, r1) || hasRunAt(c2, r2);
  };

  Game.prototype._findMoves = function () {
    var moves = [];
    var seen = Object.create(null);
    function add(c1, r1, c2, r2) {
      var key = c1 + "," + r1 + "->" + c2 + "," + r2;
      if (seen[key]) return;
      seen[key] = true;
      moves.push({ c1: c1, r1: r1, c2: c2, r2: r2 });
    }

    for (var j = 0; j < this.rows; j++) {
      for (var i = 0; i < this.cols - 1; i++) {
        if (this._swapWouldMatch(i, j, i + 1, j)) add(i, j, i + 1, j);
      }
    }
    for (var c = 0; c < this.cols; c++) {
      for (var r = 0; r < this.rows - 1; r++) {
        if (this._swapWouldMatch(c, r, c, r + 1)) add(c, r, c, r + 1);
      }
    }
    // Bomb swaps activate unconditionally. Dedup against moves we already
    // added (a bomb adjacent to a real match still gets a single entry) and
    // skip bomb↔bomb pairs entirely — _onSwap rejects them, so listing them
    // would bias the random idle-hint pick toward dead moves.
    for (var cc = 0; cc < this.cols; cc++) {
      for (var rr = 0; rr < this.rows; rr++) {
        if (this.tiles[cc][rr].special !== "bomb") continue;
        var deltas = [[1, 0], [0, 1], [-1, 0], [0, -1]];
        for (var d = 0; d < 4; d++) {
          var nc = cc + deltas[d][0];
          var nr = rr + deltas[d][1];
          if (nc < 0 || nc >= this.cols || nr < 0 || nr >= this.rows) continue;
          if (this.tiles[nc][nr].special === "bomb") continue;
          // Locked partner means the swap would be rejected by _onSwap
          // (immovable), so don't surface it as a valid move and bias
          // idle-hint picks toward dead moves.
          if (this.tiles[nc][nr].locked > 0) continue;
          add(cc, rr, nc, nr);
        }
      }
    }
    return moves;
  };

  // --- Mutation ------------------------------------------------------

  Game.prototype._swap = function (c1, r1, c2, r2) {
    var a = this.tiles[c1][r1];
    this.tiles[c1][r1] = this.tiles[c2][r2];
    this.tiles[c2][r2] = a;
  };

  // Score the just-found clusters. Combo multiplier comes from this.comboCount,
  // bumped here before scoring so the first cluster in a chain scores ×1 and
  // each subsequent cascade scores ×N. Triggers floating popups and (for
  // big matches) screen shake + the onCombo listener.
  Game.prototype._scoreClusters = function (clusters) {
    this.comboCount += 1;
    var mult = this.comboCount;
    var totalThisRound = 0;
    var anyBig = false;
    for (var i = 0; i < clusters.length; i++) {
      var cl = clusters[i];
      var len = cl.length;
      var pts = len * len * mult;
      this.score += pts;
      totalThisRound += pts;

      var bonusSec = Math.floor(pts / SCORE_TO_TIME);
      if (bonusSec > 0) {
        this.timer = Math.min(this.timerMax, this.timer + bonusSec);
      }

      // Float "+N" at the cluster's centre, coloured to match the fruit.
      var cx = cl.horizontal ? cl.column + cl.length / 2 - 0.5 : cl.column;
      var cy = cl.horizontal ? cl.row : cl.row + cl.length / 2 - 0.5;
      this._spawnPopup(cx, cy, "+" + pts, FRUIT_HEX[cl.type] || "#FFFFFF");

      // Float "+Ns" at the cluster centre, slightly offset down, so it
      // doesn't overlap the score popup. Suppressed if the bonus rounds to 0.
      if (bonusSec > 0) {
        this._spawnPopup(cx, cy + 0.5, "+" + bonusSec + "s", "#3DDB7C");
      }

      if (len >= 4) anyBig = true;
    }

    // Shake on big clears or cascades — combo gets a stronger shake at
    // higher depths so the player physically feels the chain building.
    if (anyBig || mult >= 2) {
      var amp = 2 + (anyBig ? 2 : 0) + Math.min(4, (mult - 1) * 1.5);
      this._triggerShake(amp, 0.18);
    }

    if (this.listener.onMatch) this.listener.onMatch(clusters, mult);
    if (mult >= 2 && this.listener.onCombo) this.listener.onCombo(mult, totalThisRound);
    this._notifyScore();
  };

  // Remove the just-found clusters. Steps:
  //   1. Pick spawn positions for new specials (one per cluster ≥4).
  //   2. Expand the removal set with chain effects from any striped tiles
  //      that were in the original cluster cells.
  //   3. Remove all tiles in the expanded set, except those reserved for
  //      special spawns — those cells get the new special type instead.
  //   4. Compute per-column shifts so the renderer can animate survivors
  //      falling into the gaps.
  Game.prototype._removeClusters = function (clusters) {
    var toRemove = Object.create(null); // 'c,r' → true

    // Step 1 — reserve special-spawn positions per cluster ≥4.
    var spawns = [];
    for (var k = 0; k < clusters.length; k++) {
      var cl = clusters[k];
      if (cl.length >= 4) {
        var spawn = this._chooseSpecialSpawn(cl);
        var specialType = cl.length >= 5
          ? "bomb"
          : (cl.horizontal ? "h-striped" : "v-striped");
        spawns.push({ c: spawn.col, r: spawn.row, special: specialType, type: cl.type });
      }
    }
    function isSpawn(c, r) {
      for (var i = 0; i < spawns.length; i++) {
        if (spawns[i].c === c && spawns[i].r === r) return true;
      }
      return false;
    }

    // Step 2 — collect cluster cells, then chain-expand for any striped
    // tiles within them. Bombs in clusters can't happen (excluded from
    // matching) so only stripes trigger here.
    //
    // Also record the 4-neighbours of the ORIGINAL cluster cells (before
    // chain expansion). Those are the cells whose locks get decremented
    // in step 5. Computed pre-expansion so a striped tile's row-sweep
    // doesn't blanket-unlock half the board.
    var queue = [];
    var unlockTargets = Object.create(null);
    var unlockDeltas = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var k2 = 0; k2 < clusters.length; k2++) {
      var cl2 = clusters[k2];
      for (var n = 0; n < cl2.length; n++) {
        var c = cl2.horizontal ? cl2.column + n : cl2.column;
        var r = cl2.horizontal ? cl2.row : cl2.row + n;
        var key = c + "," + r;
        if (!toRemove[key]) {
          toRemove[key] = true;
          queue.push({ c: c, r: r });
        }
        for (var d = 0; d < 4; d++) {
          var nc = c + unlockDeltas[d][0];
          var nr = r + unlockDeltas[d][1];
          if (nc < 0 || nc >= this.cols || nr < 0 || nr >= this.rows) continue;
          unlockTargets[nc + "," + nr] = true;
        }
      }
    }
    while (queue.length > 0) {
      var pos = queue.shift();
      var tile = this.tiles[pos.c][pos.r];
      if (tile.special === "h-striped" && !isSpawn(pos.c, pos.r)) {
        // Row chain — every cell in this row joins the removal set.
        for (var cc = 0; cc < this.cols; cc++) {
          var kk = cc + "," + pos.r;
          if (!toRemove[kk] && !isSpawn(cc, pos.r)) {
            toRemove[kk] = true;
            queue.push({ c: cc, r: pos.r });
          }
        }
      } else if (tile.special === "v-striped" && !isSpawn(pos.c, pos.r)) {
        for (var rr = 0; rr < this.rows; rr++) {
          var kk2 = pos.c + "," + rr;
          if (!toRemove[kk2] && !isSpawn(pos.c, rr)) {
            toRemove[kk2] = true;
            queue.push({ c: pos.c, r: rr });
          }
        }
      }
    }

    // Step 3 — apply removals (skipping reserved spawn cells), then write
    // the new specials onto the reserved cells.
    var removalKeys = Object.keys(toRemove);
    for (var idx = 0; idx < removalKeys.length; idx++) {
      var parts = removalKeys[idx].split(",");
      var rc = parseInt(parts[0], 10);
      var rr2 = parseInt(parts[1], 10);
      if (isSpawn(rc, rr2)) continue;
      var prevType = this.tiles[rc][rr2].type;
      this.tiles[rc][rr2].type = -1;
      this.tiles[rc][rr2].special = null;
      this._spawnParticles(rc, rr2, prevType);
    }
    for (var s = 0; s < spawns.length; s++) {
      var sp = spawns[s];
      this.tiles[sp.c][sp.r].type = sp.type;
      this.tiles[sp.c][sp.r].special = sp.special;
      // A spawned special replaces a cleared cell, so any latent lock on
      // that cell would visually conflict with the new striped/bomb art.
      // Clear it.
      this.tiles[sp.c][sp.r].locked = 0;
    }

    // Step 5 — adjacency unlock. Each cell adjacent to an ORIGINAL cluster
    // cell decrements its lock count by 1. Cells that were themselves
    // cleared (their type was set to -1) skip — locked is meaningless on
    // an empty cell and the refill will reset it anyway.
    var unlockKeys = Object.keys(unlockTargets);
    for (var u = 0; u < unlockKeys.length; u++) {
      var parts2 = unlockKeys[u].split(",");
      var uc = parseInt(parts2[0], 10);
      var ur = parseInt(parts2[1], 10);
      var ut = this.tiles[uc][ur];
      if (ut.type < 0) continue;
      if (ut.locked > 0) ut.locked -= 1;
    }

    this._recomputeShifts();
  };

  // For each column, walk bottom-up and tag each surviving tile with the
  // number of empty cells beneath it — the renderer animates that distance
  // as a fall. Called after any removal (cluster clear or bomb sweep).
  Game.prototype._recomputeShifts = function () {
    for (var i = 0; i < this.cols; i++) {
      var shift = 0;
      for (var j = this.rows - 1; j >= 0; j--) {
        if (this.tiles[i][j].type === -1) {
          shift++;
          this.tiles[i][j].shift = 0;
        } else {
          this.tiles[i][j].shift = shift;
        }
      }
    }
  };

  // Prefer the player's swap position if it's inside the cluster (mirrors
  // Candy Crush — the special spawns where the player triggered it). Falls
  // back to the cluster's middle for cluster-cascade matches that didn't
  // come from a direct swap.
  Game.prototype._chooseSpecialSpawn = function (cluster) {
    if (this.currentMove) {
      for (var n = 0; n < cluster.length; n++) {
        var c = cluster.horizontal ? cluster.column + n : cluster.column;
        var r = cluster.horizontal ? cluster.row : cluster.row + n;
        if ((c === this.currentMove.c1 && r === this.currentMove.r1) ||
            (c === this.currentMove.c2 && r === this.currentMove.r2)) {
          return { col: c, row: r };
        }
      }
    }
    var mid = Math.floor(cluster.length / 2);
    return {
      col: cluster.horizontal ? cluster.column + mid : cluster.column,
      row: cluster.horizontal ? cluster.row : cluster.row + mid,
    };
  };

  // Bomb activation by swap — clears every tile matching targetType plus
  // the bomb itself, scores per *total* cleared tile (factored by combo),
  // then routes into the standard resolve→refill cascade so post-bomb
  // chains still trigger normally.
  //
  // Restructured into three phases so chain-cleared tiles from caught
  // striped tiles actually count toward the score. Previously the chain
  // mutated the board but wasn't reflected in `cleared.length`, so a bomb
  // that swept up a striped tile cleared more cells than it scored.
  Game.prototype._activateBomb = function (move, targetType) {
    this.comboCount += 1;
    var mult = this.comboCount;
    var self = this;

    // Phase 1: initial sweep — every tile of targetType plus all bombs.
    // Use an ordered list + key set so we can dedup chain-added cells.
    var toClear = Object.create(null);
    var ordered = [];
    function enqueue(c, r) {
      var key = c + "," + r;
      if (toClear[key]) return;
      if (self.tiles[c][r].type < 0) return; // already empty
      toClear[key] = true;
      ordered.push({ c: c, r: r });
    }
    for (var c = 0; c < this.cols; c++) {
      for (var r = 0; r < this.rows; r++) {
        var t = this.tiles[c][r];
        if (t.type === targetType || t.special === "bomb") enqueue(c, r);
      }
    }

    // Phase 2: chain-expand for striped tiles in the initial set. One step
    // of chain, not recursive — keeping the same single-level depth the
    // previous implementation had so the gameplay feel is unchanged; the
    // fix here is purely accounting (score reflects total cleared).
    var initialLen = ordered.length;
    for (var ip = 0; ip < initialLen; ip++) {
      var pos = ordered[ip];
      var tile = this.tiles[pos.c][pos.r];
      if (tile.special === "h-striped") {
        for (var cc = 0; cc < this.cols; cc++) enqueue(cc, pos.r);
      } else if (tile.special === "v-striped") {
        for (var rr = 0; rr < this.rows; rr++) enqueue(pos.c, rr);
      }
    }

    // Phase 3: score + bonus seconds using the true total.
    var pts = ordered.length * 10 * mult;
    this.score += pts;
    var bonusSec = Math.floor(pts / SCORE_TO_TIME);
    if (bonusSec > 0) {
      this.timer = Math.min(this.timerMax, this.timer + bonusSec);
    }

    // Phase 4: apply removals + spawn particles. Particle color uses the
    // tile's actual type (falls back to targetType for cells that were
    // already empty mid-iteration — defensive, shouldn't occur after the
    // enqueue guard).
    //
    // Also collect unlock targets from the ORIGINAL sweep cells (the same
    // pre-chain-expansion rule clusters use, so the unlock budget stays
    // consistent across match types). ordered[0..initialLen] are the
    // originals; the rest were added by the striped-tile chain in phase 2.
    var bombUnlockTargets = Object.create(null);
    var bombUnlockDeltas = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var origIdx = 0; origIdx < initialLen; origIdx++) {
      var orig = ordered[origIdx];
      for (var ud = 0; ud < 4; ud++) {
        var unc = orig.c + bombUnlockDeltas[ud][0];
        var unr = orig.r + bombUnlockDeltas[ud][1];
        if (unc < 0 || unc >= this.cols || unr < 0 || unr >= this.rows) continue;
        bombUnlockTargets[unc + "," + unr] = true;
      }
    }
    for (var k = 0; k < ordered.length; k++) {
      var cell = ordered[k];
      var prevType = this.tiles[cell.c][cell.r].type;
      this._spawnParticles(cell.c, cell.r, prevType >= 0 ? prevType : targetType);
      this.tiles[cell.c][cell.r].type = -1;
      this.tiles[cell.c][cell.r].special = null;
    }
    // Apply unlocks. Skip cleared cells (type < 0) — same guard as the
    // cluster path; the cell is about to be refilled anyway.
    var bombUnlockKeys = Object.keys(bombUnlockTargets);
    for (var bu = 0; bu < bombUnlockKeys.length; bu++) {
      var bparts = bombUnlockKeys[bu].split(",");
      var buc = parseInt(bparts[0], 10);
      var bur = parseInt(bparts[1], 10);
      var but = this.tiles[buc][bur];
      if (but.type < 0) continue;
      if (but.locked > 0) but.locked -= 1;
    }

    this._spawnPopup(move.c2 + 0.5, move.r2 + 0.5, "+" + pts, FRUIT_HEX[targetType] || "#FFFFFF");
    if (bonusSec > 0) {
      this._spawnPopup(move.c2 + 0.5, move.r2 + 1.0, "+" + bonusSec + "s", "#3DDB7C");
    }
    this._triggerShake(8, 0.24);

    if (this.listener.onMatch) this.listener.onMatch([{ length: ordered.length, type: targetType }], mult);
    this._notifyScore();

    this._recomputeShifts();
    this._setPhase("resolve");
  };

  Game.prototype._shiftAndRefill = function () {
    var maxLockedPerColumn = Math.floor(this.rows / 3);
    for (var i = 0; i < this.cols; i++) {
      for (var j = this.rows - 1; j >= 0; j--) {
        if (this.tiles[i][j].type !== -1) {
          var shift = this.tiles[i][j].shift;
          if (shift > 0) {
            this._swap(i, j, i, j + shift);
          }
        }
        this.tiles[i][j].shift = 0;
      }

      var emptyCount = 0;
      for (var k = 0; k < this.rows; k++) {
        if (this.tiles[i][k].type === -1) emptyCount++;
        else break;
      }

      // Count existing locked tiles in this column so the per-column cap
      // (floor(rows/3) = 2 for an 8-row board) holds across refills as
      // well as the initial spawn. Without this a cluster that clears
      // half the column could refill 4 new locked tiles, deadlocking it.
      var lockedInColumn = 0;
      for (var lc = 0; lc < this.rows; lc++) {
        if (this.tiles[i][lc].locked > 0) lockedInColumn++;
      }

      var stage = this._stage;
      for (var m = 0; m < this.rows; m++) {
        if (this.tiles[i][m].type === -1) {
          this.tiles[i][m].type = this._randomTile();
          this.tiles[i][m].special = null;
          this.tiles[i][m].fallFrom = emptyCount;

          var locked = 0;
          if (stage && stage.lockRate > 0 && lockedInColumn < maxLockedPerColumn) {
            // One roll covers both tiers: lockDoubleRate < lockRate so a
            // roll below the double rate counts as 2, below the single
            // rate as 1, otherwise 0. Doing it as a single random keeps
            // the joint distribution sane (P(double) is exactly the
            // double rate, not double rate × single rate).
            var roll = Math.random();
            if (roll < stage.lockDoubleRate) {
              locked = 2;
              lockedInColumn++;
            } else if (roll < stage.lockRate) {
              locked = 1;
              lockedInColumn++;
            }
          }
          this.tiles[i][m].locked = locked;
        }
      }
    }

    // No deadlock recovery here. A refill that leaves the board with no
    // valid move (most likely when the lock RNG fills a column) used to be
    // patched up in-place by silently stripping locks until a move existed.
    // That gave the player no feedback (locks just vanished) and bypassed
    // the visible shuffle entirely — exactly the case where the board most
    // needs to announce "no moves" and rearrange. Instead we let the
    // deadlock fall through to the cascade's end: the phase machine drives
    // refill → ready, and the no-moves check in _update catches it there
    // and routes to _shuffleBoard (popup via onShuffle + reshuffle, with
    // locks preserved). That keeps a single, player-visible recovery path.
  };

  // Deadlock-recovery shuffle. Called from _update when the board has no
  // valid moves. Preserves the locked-tile layout (locks stay in their
  // grid slots, lock counts unchanged) and shuffles the unlocked tiles'
  // contents (type + special) into a new arrangement with at least one
  // valid move. Reuses the refill phase to animate the rearrangement —
  // every shuffled tile gets fallFrom = rows+1 so the whole board drops
  // back in from above.
  Game.prototype._shuffleBoard = function () {
    var safety = 50;
    while (safety-- > 0) {
      // Gather unlocked tile contents in row-major order.
      var positions = [];
      var contents = [];
      for (var i = 0; i < this.cols; i++) {
        for (var j = 0; j < this.rows; j++) {
          var t = this.tiles[i][j];
          if (t.locked === 0 && t.type >= 0) {
            positions.push({ c: i, r: j });
            contents.push({ type: t.type, special: t.special });
          }
        }
      }
      // Fisher-Yates shuffle.
      for (var k = contents.length - 1; k > 0; k--) {
        var jj = Math.floor(Math.random() * (k + 1));
        var tmp = contents[k];
        contents[k] = contents[jj];
        contents[jj] = tmp;
      }
      // Reassign to the same positions.
      for (var p = 0; p < positions.length; p++) {
        var pos = positions[p];
        this.tiles[pos.c][pos.r].type = contents[p].type;
        this.tiles[pos.c][pos.r].special = contents[p].special;
      }
      // Resolve any pre-formed clusters the shuffle happened to create.
      // (_resolveStartingClusters mutates only cluster cells, and locked
      // tiles never appear in clusters, so this is locked-safe.)
      this._resolveStartingClusters();
      if (this._findMoves().length > 0) break;

      // Still deadlocked — too many locks for the remaining unlocked
      // tiles to form anything. Unlock one tile and try again. This
      // gradually peels back the lock pressure until the board becomes
      // playable; in practice fires zero or one iterations.
      var unlocked = false;
      for (var c = 0; c < this.cols && !unlocked; c++) {
        for (var r = 0; r < this.rows && !unlocked; r++) {
          if (this.tiles[c][r].locked > 0) {
            this.tiles[c][r].locked = 0;
            unlocked = true;
          }
        }
      }
      if (!unlocked) break; // nothing more we can do; loop exit is the only safe path
    }

    // Cascade-in animation: every unlocked tile drops back in from above.
    // Locked tiles aren't animated — they stayed put, so animating them
    // would visually contradict the "shuffle preserves locks" rule.
    for (var ic = 0; ic < this.cols; ic++) {
      for (var jc = 0; jc < this.rows; jc++) {
        if (this.tiles[ic][jc].locked === 0 && this.tiles[ic][jc].type >= 0) {
          this.tiles[ic][jc].fallFrom = this.rows + 1;
        }
      }
    }

    if (this.listener.onShuffle) this.listener.onShuffle();
    this._setPhase("refill");
  };

  // --- Particles -----------------------------------------------------

  Game.prototype._spawnParticles = function (col, row, type) {
    for (var i = 0; i < 6; i++) {
      var angle = Math.random() * Math.PI * 2;
      var speed = 1.2 + Math.random() * 1.8;
      this.particles.push({
        col: col + 0.5,
        row: row + 0.5,
        vx: Math.cos(angle) * speed * 0.08,
        vy: Math.sin(angle) * speed * 0.08,
        life: 1,
        type: type < 0 ? 0 : type,
      });
    }
  };

  Game.prototype._updateParticles = function () {
    var keep = [];
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      p.col += p.vx;
      p.row += p.vy;
      p.vy += 0.012;
      p.life -= 0.04;
      if (p.life > 0) keep.push(p);
    }
    this.particles = keep;
  };

  // --- Floating popups ----------------------------------------------

  // Popups float up + fade out, drawn as bold text by the renderer. col/row
  // are in grid units (matching particle space) so the renderer can place
  // them in canvas coords with the same cellPx math.
  Game.prototype._spawnPopup = function (col, row, text, color) {
    this.popups.push({
      col: col,
      row: row,
      text: text,
      color: color || "#FFFFFF",
      life: 1,
      vy: -0.04,
      scale: 1,
    });
  };

  Game.prototype._updatePopups = function (dt) {
    var keep = [];
    for (var i = 0; i < this.popups.length; i++) {
      var p = this.popups[i];
      p.row += p.vy;
      p.vy *= 0.96; // friction so they slow as they rise
      // Brief pop-in: scale goes 1 → 1.15 → 1 over first 0.15s of life.
      var age = 1 - p.life;
      p.scale = age < 0.12 ? 1 + age * 1.2 : 1.15 - Math.min(0.15, (age - 0.12) * 1.5);
      p.life -= dt * 1.4;
      if (p.life > 0) keep.push(p);
    }
    this.popups = keep;
  };

  // --- Confetti (new-best only) -------------------------------------

  Game.prototype._spawnConfetti = function () {
    var cx = this.cols / 2;
    var cy = this.rows / 2;
    for (var i = 0; i < 80; i++) {
      var angle = Math.random() * Math.PI * 2;
      var speed = 0.06 + Math.random() * 0.18;
      this.confetti.push({
        col: cx,
        row: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.18, // bias upward — feels celebratory
        life: 2,
        color: CONFETTI_HEX[Math.floor(Math.random() * CONFETTI_HEX.length)],
        rot: Math.random() * Math.PI * 2,
        rotV: (Math.random() - 0.5) * 0.3,
        w: 0.12 + Math.random() * 0.08,
        h: 0.06 + Math.random() * 0.04,
      });
    }
  };

  Game.prototype._updateConfetti = function (dt) {
    if (this.confetti.length === 0) return;
    var keep = [];
    for (var i = 0; i < this.confetti.length; i++) {
      var p = this.confetti[i];
      p.col += p.vx;
      p.row += p.vy;
      p.vy += 0.025;        // gravity
      p.vx *= 0.99;          // slight drag
      p.rot += p.rotV;
      p.life -= dt * 0.4;
      if (p.life > 0) keep.push(p);
    }
    this.confetti = keep;
  };

  // --- Shake ---------------------------------------------------------

  Game.prototype._triggerShake = function (amp, duration) {
    this.shakeT = Math.max(this.shakeT, duration);
    this.shakeAmp = Math.max(this.shakeAmp, amp);
  };

  Game.prototype._updateShake = function (dt) {
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      if (this.shakeT <= 0) {
        this.shakeT = 0;
        this.shakeAmp = 0;
      }
    }
  };

  // --- Timer ---------------------------------------------------------

  Game.prototype._currentDrainRate = function () {
    var base = 1 + (this.score / TIMER_DRAIN_SCALE);
    // Stage multiplier stacks on top of the score-based drain. e.g. at
    // stage 4 (×1.25) with score 1500, drain = 1.5 × 1.25 = 1.875/sec.
    return base * (this._stage ? this._stage.drainMult : 1);
  };

  Game.prototype._notifyTimer = function () {
    if (this.listener.onTimer) {
      this.listener.onTimer(this.timer, this.timerMax, this._currentDrainRate());
    }
  };

  // Kept as call-site stubs after the setInterval→rAF migration. _update
  // owns drain and gameOver-on-zero now; these just push a UI snapshot so
  // the bar paints the initial value the moment the player starts.
  Game.prototype._startTimer = function () {
    this._notifyTimer();
  };

  Game.prototype._stopTimer = function () {
    /* no-op — timer is gated by this.state in _update */
  };

  // --- Game over -----------------------------------------------------

  Game.prototype._gameOver = function (reason) {
    this._stopTimer();
    this._setState("over");
    if (this.input && this.input.clearSelection) this.input.clearSelection();
    var prevBest = this.storage ? this.storage.getBest() : 0;
    var isNewBest = this.score > prevBest;
    if (isNewBest && this.storage) this.storage.setBest(this.score);
    if (isNewBest) {
      this._spawnConfetti();
      this._triggerShake(6, 0.5);
    }
    if (this.listener.onGameOver) {
      this.listener.onGameOver({
        score: this.score,
        isNewBest: isNewBest,
        prevBest: prevBest,
        reason: reason,
      });
    }
    if (isNewBest && this.listener.onBest) this.listener.onBest(this.score);
  };

  // --- State notifications ------------------------------------------

  Game.prototype._setState = function (next) {
    this.state = next;
    if (this.listener.onState) this.listener.onState(next);
  };

  Game.prototype._setPhase = function (next) {
    this.phase = next;
    this.animTime = 0;
    // Board can only mutate across a phase boundary (resolve writes -1s,
    // refill writes new types, etc.) so this is the right invalidation
    // point for the memoised _findMoves result.
    this._movesCache = null;
  };

  Game.prototype._notifyScore = function () {
    if (this.listener.onScore) this.listener.onScore(this.score);
    // Score is monotonic, so a stage check here covers every advancement
    // path (cluster scoring, bomb activation) without needing duplicate
    // checks at each call site. We compare by id rather than identity so
    // a restart that resets _stage to STAGES[0] doesn't re-emit stage 1.
    var next = stageFor(this.score);
    if (next.id > this._stage.id) {
      this._stage = next;
      this.stage = next.id;
      if (this.listener.onStage) {
        this.listener.onStage({ id: next.id, label: next.label });
      }
    }
  };

  // Surfaced as a static so application.js can paint the initial timer bar
  // from this file's TIMER_START rather than duplicating the starting value.
  Game.TIMER_START = TIMER_START;

  window.Match3Game = Game;
})();

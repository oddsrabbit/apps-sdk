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

  var TIMER_START = 120;
  var SCORE_TO_TIME = 3;     // pts per second of timer bonus
  var TIMER_DRAIN_SCALE = 3000;

  // Idle hint kicks in after this many ms of no input while ready to play.
  // Long enough that a player taking a careful look doesn't get the hint
  // popping over their board on every move, short enough that a confused
  // player gets help.
  var IDLE_HINT_MS = 8000;

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
    this._timerHandle = null;
  }

  Game.prototype._wireInput = function () {
    var self = this;
    this.input.on("swap", function (move) { self._onSwap(move); });
    this.input.on("select", function (tile) { self._onSelect(tile); });
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
    // shift/fallFrom are renderer hints, reset each phase. special survives
    // until the tile is matched, then triggers its chain effect on removal.
    this.tiles = new Array(COLS);
    for (var i = 0; i < COLS; i++) {
      this.tiles[i] = new Array(ROWS);
      for (var j = 0; j < ROWS; j++) {
        this.tiles[i][j] = { type: 0, shift: 0, fallFrom: 0, special: null };
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
    this.idleSince = (typeof performance !== "undefined" ? performance.now() : Date.now());
    this.hintMove = null;     // suggested move when idle threshold reached
  };

  Game.prototype.restart = function () {
    this._stopTimer();
    this._setup();
    if (this.input && this.input.clearSelection) this.input.clearSelection();
    this._setState("idle");
    this._notifyScore();
    if (this.listener.onTimer) this.listener.onTimer(this.timer, this.timerMax);
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
    this.selected = tile;
    this._resetIdle();
  };

  Game.prototype._resetIdle = function () {
    this.idleSince = (typeof performance !== "undefined" ? performance.now() : Date.now());
    this.hintMove = null;
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

    this._resetIdle();

    var tileA = this.tiles[move.c1][move.r1];
    var tileB = this.tiles[move.c2][move.r2];

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
      this._activateBomb(move, targetType);
      return;
    }

    this.currentMove = move;
    this.comboCount = 0;
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

    // Paused/over: freeze the phase machine and skip no-moves/idle logic.
    if (this.state === "paused" || this.state === "over") return;

    if (this.phase === "ready") {
      // No-moves and idle-hint detection only apply while actively playing.
      if (this.state !== "playing") return;
      if (this._findMoves().length === 0) {
        this._gameOver("noMoves");
        return;
      }
      // Idle hint: surface a valid move if the player's stalled.
      var now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      if (!this.hintMove && now - this.idleSince > IDLE_HINT_MS) {
        var moves = this._findMoves();
        if (moves.length > 0) {
          this.hintMove = moves[Math.floor(Math.random() * moves.length)];
        }
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
      particles: this.particles,
      popups: this.popups,
      confetti: this.confetti,
      hintMove: this.hintMove,
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
  };

  // --- Cluster + move detection -------------------------------------

  // Bombs are wildcards in matching theory, but to keep the cluster finder
  // simple we exclude them from runs entirely — bombs only activate via
  // swap, not by being part of an incidental 3-match. effectiveType returns
  // -1 for bomb tiles so they don't match anything in the run-based scan.
  function effectiveType(tile) {
    if (tile.special === "bomb") return -1;
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

  Game.prototype._findMoves = function () {
    var moves = [];
    for (var j = 0; j < this.rows; j++) {
      for (var i = 0; i < this.cols - 1; i++) {
        this._swap(i, j, i + 1, j);
        if (this._findClusters().length > 0) {
          moves.push({ c1: i, r1: j, c2: i + 1, r2: j });
        }
        this._swap(i, j, i + 1, j);
      }
    }
    for (var c = 0; c < this.cols; c++) {
      for (var r = 0; r < this.rows - 1; r++) {
        this._swap(c, r, c, r + 1);
        if (this._findClusters().length > 0) {
          moves.push({ c1: c, r1: r, c2: c, r2: r + 1 });
        }
        this._swap(c, r, c, r + 1);
      }
    }
    // Bomb swaps are always valid (bomb activates on any neighbour).
    for (var cc = 0; cc < this.cols; cc++) {
      for (var rr = 0; rr < this.rows; rr++) {
        if (this.tiles[cc][rr].special === "bomb") {
          if (cc + 1 < this.cols) moves.push({ c1: cc, r1: rr, c2: cc + 1, r2: rr });
          if (rr + 1 < this.rows) moves.push({ c1: cc, r1: rr, c2: cc, r2: rr + 1 });
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

    if (this.listener.onMatch) this.listener.onMatch(clusters);
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
    var queue = [];
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
    for (var key2 in toRemove) {
      var parts = key2.split(",");
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
    }

    // Step 4 — column shifts.
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
  // the bomb itself, scores per cleared tile (factored by combo), and
  // routes into the standard resolve→refill cascade so post-bomb chains
  // still trigger normally.
  Game.prototype._activateBomb = function (move, targetType) {
    this.comboCount += 1;
    var mult = this.comboCount;
    var cleared = [];
    for (var c = 0; c < this.cols; c++) {
      for (var r = 0; r < this.rows; r++) {
        var t = this.tiles[c][r];
        if (t.type === targetType || t.special === "bomb") {
          cleared.push({ c: c, r: r, type: t.type, special: t.special });
        }
      }
    }
    // 10 pts per cleared tile × combo multiplier. A typical bomb hits ~10
    // tiles for ~100 pts at combo 1 — roughly equivalent to a 10-cluster,
    // which feels right for "wiped out a colour".
    var pts = cleared.length * 10 * mult;
    this.score += pts;

    var bonusSec = Math.floor(pts / SCORE_TO_TIME);
    if (bonusSec > 0) {
      this.timer = Math.min(this.timerMax, this.timer + bonusSec);
    }

    for (var k = 0; k < cleared.length; k++) {
      var cell = cleared[k];
      // Chain-trigger any striped tiles caught in the bomb sweep, so a
      // bomb that includes a striped tile also clears its row/column.
      // (This is rare but rewarding when it happens.)
      if (cell.special === "h-striped" || cell.special === "v-striped") {
        if (cell.special === "h-striped") {
          for (var cc = 0; cc < this.cols; cc++) {
            if (this.tiles[cc][cell.r].type >= 0) {
              this._spawnParticles(cc, cell.r, this.tiles[cc][cell.r].type);
              this.tiles[cc][cell.r].type = -1;
              this.tiles[cc][cell.r].special = null;
            }
          }
        } else {
          for (var rr = 0; rr < this.rows; rr++) {
            if (this.tiles[cell.c][rr].type >= 0) {
              this._spawnParticles(cell.c, rr, this.tiles[cell.c][rr].type);
              this.tiles[cell.c][rr].type = -1;
              this.tiles[cell.c][rr].special = null;
            }
          }
        }
      }
      this._spawnParticles(cell.c, cell.r, cell.type < 0 ? targetType : cell.type);
      this.tiles[cell.c][cell.r].type = -1;
      this.tiles[cell.c][cell.r].special = null;
    }

    this._spawnPopup(move.c2 + 0.5, move.r2 + 0.5, "+" + pts, FRUIT_HEX[targetType] || "#FFFFFF");
    if (bonusSec > 0) {
      this._spawnPopup(move.c2 + 0.5, move.r2 + 1.0, "+" + bonusSec + "s", "#3DDB7C");
    }
    this._triggerShake(8, 0.24);

    if (this.listener.onMatch) this.listener.onMatch([{ length: cleared.length, type: targetType }]);
    this._notifyScore();

    // Column shifts so the resolve phase can animate survivors falling.
    for (var i2 = 0; i2 < this.cols; i2++) {
      var sh = 0;
      for (var j2 = this.rows - 1; j2 >= 0; j2--) {
        if (this.tiles[i2][j2].type === -1) {
          sh++;
          this.tiles[i2][j2].shift = 0;
        } else {
          this.tiles[i2][j2].shift = sh;
        }
      }
    }

    this._setPhase("resolve");
  };

  Game.prototype._shiftAndRefill = function () {
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

      for (var m = 0; m < this.rows; m++) {
        if (this.tiles[i][m].type === -1) {
          this.tiles[i][m].type = this._randomTile();
          this.tiles[i][m].special = null;
          this.tiles[i][m].fallFrom = emptyCount;
        }
      }
    }
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

  Game.prototype._startTimer = function () {
    var self = this;
    if (this._timerHandle) return;
    this._timerHandle = window.setInterval(function () {
      if (self.state !== "playing") return;
      self.timer -= 1 + (self.score / TIMER_DRAIN_SCALE);
      if (self.timer <= 0) {
        self.timer = 0;
        self._gameOver("timeOut");
      }
      if (self.listener.onTimer) self.listener.onTimer(self.timer, self.timerMax);
    }, 1000);
    if (this.listener.onTimer) this.listener.onTimer(this.timer, this.timerMax);
  };

  Game.prototype._stopTimer = function () {
    if (this._timerHandle != null) {
      window.clearInterval(this._timerHandle);
      this._timerHandle = null;
    }
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
  };

  Game.prototype._notifyScore = function () {
    if (this.listener.onScore) this.listener.onScore(this.score);
  };

  window.Match3Game = Game;
})();

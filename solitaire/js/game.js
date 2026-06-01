// Klondike state machine. Pure logic — no canvas, no DOM. The renderer
// reads state via `getState()`; application.js wires it to the input layer.
//
// Move sources/targets are encoded as plain objects so the input layer can
// hit-test screen positions to a source and then ask `tryMove(source,
// target)` without leaking layout math into game logic.
//   source: { kind: "waste" }
//         | { kind: "tableau", col, index }   (index = position in column)
//         | { kind: "foundation", index }
//   target: { kind: "tableau", col }
//         | { kind: "foundation", index }
//
// Undo stack: every move appends one entry that records enough state to
// reverse the move (including "did this move flip a face-down tableau
// card?"). Undo is unlimited within a deal; cleared on new deal or restore.

(function () {
  var Deck = window.SolitaireDeck;

  // Game lifecycle states. We don't have a "lost" terminal — Klondike can
  // get stuck but the player can always undo, so a deal is either active
  // ("playing") or successfully completed ("won"). "idle" is the pre-deal
  // state before the player picks daily vs random.
  var STATE_IDLE = "idle";
  var STATE_PLAYING = "playing";
  var STATE_WON = "won";

  // Deal modes. Daily = today's UTC seed, contributes to streak + community
  // aggregate. Random = freeplay; results don't affect the streak.
  var MODE_DAILY = "daily";
  var MODE_RANDOM = "random";

  function SolitaireGame(opts) {
    this.storage = opts.storage;
    this.listener = opts.listener || {};
    this._state = STATE_IDLE;
    this._mode = null;
    this._seed = 0;
    this._dailyId = -1;
    this._board = null;          // { tableau, tableauHidden, foundations, stock, waste }
    this._undo = [];
    this._moves = 0;
    this._startMs = 0;
    this._endMs = 0;
  }

  SolitaireGame.prototype.getState = function () { return this._state; };
  SolitaireGame.prototype.getMode = function () { return this._mode; };
  SolitaireGame.prototype.getSeed = function () { return this._seed; };
  SolitaireGame.prototype.getDailyId = function () { return this._dailyId; };
  SolitaireGame.prototype.getBoard = function () { return this._board; };
  SolitaireGame.prototype.getMoves = function () { return this._moves; };
  SolitaireGame.prototype.getUndoDepth = function () { return this._undo.length; };

  // Elapsed wall-clock for the current deal. Frozen at win time so the
  // overlay shows the final time, not the time-since-win.
  SolitaireGame.prototype.getElapsedMs = function () {
    if (this._state === STATE_IDLE || this._startMs === 0) return 0;
    if (this._state === STATE_WON) return this._endMs - this._startMs;
    return Date.now() - this._startMs;
  };

  // Whether the "Finish" auto-complete button should surface. Two gates:
  // first, no face-down cards (a hidden card can't be auto-sent — it has to be
  // revealed by a tableau move the autoplay doesn't make). Second, and unlike
  // the old "stock + waste empty" rule, we actually SIMULATE the autoplay
  // policy to confirm it runs the whole board out. That lets Finish appear
  // earlier (while the stock still has cards — draw-1 with everything face-up
  // is always winnable by cycling) while refusing to offer a Finish that would
  // stall half-done because a needed card is buried inside a tableau run.
  SolitaireGame.prototype.canAutoComplete = function () {
    if (this._state !== STATE_PLAYING) return false;
    var hidden = this._board.tableauHidden;
    for (var i = 0; i < hidden.length; i++) {
      if (hidden[i] > 0) return false;
    }
    return this._canFinishByAutoplay();
  };

  // Dry-run of the exact policy autoCompleteStep follows — send any tableau or
  // waste top to a foundation, otherwise draw/recycle to expose the next card
  // — on throwaway copies, reporting whether it empties the whole deck onto
  // the foundations. Because the live cascade uses the identical policy, a
  // `true` here guarantees the cascade reaches a win (and terminates).
  SolitaireGame.prototype._canFinishByAutoplay = function () {
    var b = this._board;
    var tops = [];
    var total = 0;
    for (var i = 0; i < b.foundations.length; i++) {
      var f = b.foundations[i];
      tops.push(f.length ? f[f.length - 1] : null);
      total += f.length;
    }
    var tableau = [];
    for (var c = 0; c < b.tableau.length; c++) tableau.push(b.tableau[c].slice());
    var stock = b.stock.slice();
    var waste = b.waste.slice();
    var drawsSinceProgress = 0;
    while (total < Deck.DECK_SIZE) {
      var moved = false;
      for (var col = 0; col < tableau.length; col++) {
        var stack = tableau[col];
        if (stack.length === 0) continue;
        var dest = Deck.findFoundationTarget(stack[stack.length - 1], tops);
        if (dest >= 0) { tops[dest] = stack.pop(); total++; moved = true; break; }
      }
      if (!moved && waste.length) {
        var wdest = Deck.findFoundationTarget(waste[waste.length - 1], tops);
        if (wdest >= 0) { tops[wdest] = waste.pop(); total++; moved = true; }
      }
      if (moved) { drawsSinceProgress = 0; continue; }
      // No foundation move available — cycle the stock to expose another card.
      if (stock.length === 0 && waste.length === 0) return false;
      if (stock.length === 0) { stock = waste.slice().reverse(); waste = []; }
      else { waste.push(stock.pop()); }
      // Tableau tops only change on a foundation move, so a full pass through
      // the stock + waste with no such move means we're wedged.
      if (++drawsSinceProgress > stock.length + waste.length + 1) return false;
    }
    return true;
  };

  SolitaireGame.prototype.isDailyWonAlready = function () {
    var today = Deck.dailyId();
    return this.storage.getLastDailyId() === today && this.storage.getLastDailyWon();
  };

  SolitaireGame.prototype.newDeal = function (mode, opts) {
    opts = opts || {};
    this._mode = mode;
    var Solver = window.SolitaireSolver;
    if (mode === MODE_DAILY) {
      this._dailyId = Deck.dailyId();
      // Daily is winnability-filtered so no streak hinges on an unwinnable
      // shuffle. The app precomputes the solvable seed during idle and hands it
      // in via opts.seed, making the tapped deal instant; if it isn't ready we
      // resolve it here, and if the solver is absent we fall back to the raw
      // day id. The search is deterministic, so however it's resolved every
      // device lands on the same seed for a given day.
      if (opts.seed != null) {
        this._seed = opts.seed | 0;
      } else {
        this._seed = Solver ? Solver.findSolvableSeed(this._dailyId) : this._dailyId;
      }
    } else {
      // Random is freeplay — dealt straight from the seed, no winnability
      // filter. An unwinnable random costs nothing (no streak; the player just
      // rerolls), and skipping the solver keeps the deal instant. A fresh
      // per-deal seed from the high-res clock is plenty of shuffle diversity;
      // opts.seed lets tests pin a specific deal.
      this._dailyId = -1;
      this._seed = (opts.seed != null) ? (opts.seed | 0) : ((Date.now() & 0x7fffffff) | 0);
    }
    this._board = Deck.deal(this._seed);
    this._undo = [];
    this._moves = 0;
    this._startMs = Date.now();
    this._endMs = 0;
    this._setState(STATE_PLAYING);
    this._emitChange();
  };

  // Drop the current deal and return to the pre-deal idle state. Used by the
  // toolbar "New Deal" button, which pops the player back to the daily/random
  // chooser rather than silently rerolling. Transitioning state (vs just
  // painting the idle overlay) is what stops the time ticker and keeps
  // getState() honest — leaving the engine in "playing" behind an idle
  // overlay leaks the interval and lets the move/time chips keep counting.
  SolitaireGame.prototype.resetToIdle = function () {
    this._mode = null;
    this._seed = 0;
    this._dailyId = -1;
    this._board = null;
    this._undo = [];
    this._moves = 0;
    this._startMs = 0;
    this._endMs = 0;
    this._setState(STATE_IDLE);
    this._emitChange();
  };

  // Restore an in-progress deal from storage. Snapshot shape must match
  // what `snapshot()` produces — caller is trusted (only our own writes
  // land here).
  SolitaireGame.prototype.restoreSaved = function (snap) {
    if (!snap || !snap.board) return false;
    this._mode = snap.mode;
    this._seed = snap.seed | 0;
    this._dailyId = snap.dailyId != null ? (snap.dailyId | 0) : -1;
    this._board = snap.board;
    this._undo = snap.undo || [];
    this._moves = snap.moves | 0;
    // Restoring resumes the clock at the elapsed point — don't penalise
    // the player for backgrounding the app. Save records elapsed-ms-at-
    // pause; we shift _startMs into the past by that amount.
    var elapsedAtPause = snap.elapsedMs | 0;
    this._startMs = Date.now() - elapsedAtPause;
    this._endMs = 0;
    this._setState(STATE_PLAYING);
    this._emitChange();
    return true;
  };

  // Serialize for persistence. Cards are already integers, so the board
  // round-trips through JSON without any custom revivers.
  SolitaireGame.prototype.snapshot = function () {
    if (this._state !== STATE_PLAYING) return null;
    return {
      mode: this._mode,
      seed: this._seed,
      dailyId: this._dailyId,
      board: this._board,
      undo: this._undo,
      moves: this._moves,
      elapsedMs: this.getElapsedMs(),
    };
  };

  // --- Stock / waste ---

  // Draw one from stock to waste. If the stock is empty, instead recycle
  // the waste back into the stock (face-down again). Both branches push
  // distinct undo entries so the player can step back through the cycle.
  SolitaireGame.prototype.drawStock = function () {
    if (this._state !== STATE_PLAYING) return false;
    if (this._board.stock.length === 0) {
      if (this._board.waste.length === 0) return false; // nothing to recycle
      // Recycle: move waste back to stock, reversed (so the bottom of the
      // waste becomes the next draw — matches a physical deck flip).
      var recycled = this._board.waste.slice().reverse();
      this._undo.push({ kind: "recycle", count: recycled.length });
      this._board.stock = recycled;
      this._board.waste = [];
      this._moves++;
      this._emitChange();
      return true;
    }
    var card = this._board.stock.pop();
    this._board.waste.push(card);
    this._undo.push({ kind: "draw" });
    this._moves++;
    this._emitChange();
    return true;
  };

  // --- Moves ---

  // Top-level entry point for the input layer. Returns true if the move was
  // legal and committed. Source kinds: 'waste', 'tableau' (with col +
  // index), 'foundation' (with index). Target kinds: 'tableau' (col),
  // 'foundation' (index). All combinations are validated before any state
  // is mutated, so a rejected move leaves the board untouched.
  SolitaireGame.prototype.tryMove = function (source, target) {
    if (this._state !== STATE_PLAYING) return false;
    if (!source || !target) return false;

    if (target.kind === "foundation") {
      return this._tryToFoundation(source, target.index);
    }
    if (target.kind === "tableau") {
      return this._tryToTableau(source, target.col);
    }
    return false;
  };

  SolitaireGame.prototype._tryToFoundation = function (source, foundIdx) {
    var foundation = this._board.foundations[foundIdx];
    if (!foundation) return false;
    var movingCard = this._peekSource(source);
    if (movingCard == null) return false;
    // Foundations only accept a single card per move (you can't drop a
    // tableau run on a foundation), so any source with sub-stack semantics
    // is rejected unless it's the top of its column.
    if (source.kind === "tableau") {
      if (source.index !== this._board.tableau[source.col].length - 1) return false;
    }
    var top = foundation.length ? foundation[foundation.length - 1] : null;
    if (!Deck.canPlaceOnFoundation(movingCard, top)) return false;

    // Commit. Pull from source, push to foundation, record undo info
    // including any face-flip that the source-column reveal triggers.
    var flipped = false;
    if (source.kind === "waste") {
      this._board.waste.pop();
      this._undo.push({ kind: "wasteToFoundation", foundationIdx: foundIdx });
    } else if (source.kind === "tableau") {
      this._board.tableau[source.col].pop();
      flipped = this._maybeFlipColumn(source.col);
      this._undo.push({
        kind: "tableauToFoundation",
        fromCol: source.col,
        foundationIdx: foundIdx,
        flippedHidden: flipped,
      });
    } else if (source.kind === "foundation") {
      // Foundation → foundation is never legal (next-rank-same-suit is the
      // same slot). Reject.
      return false;
    } else {
      return false;
    }
    foundation.push(movingCard);
    this._moves++;
    this._checkWin();
    this._emitChange();
    return true;
  };

  SolitaireGame.prototype._tryToTableau = function (source, toCol) {
    // Reject self-moves up front. The input layer should already filter
    // these, but the game contract treats them as no-ops anyway.
    if (source.kind === "tableau" && source.col === toCol) return false;

    var targetCol = this._board.tableau[toCol];
    if (!targetCol) return false;
    var targetTop = targetCol.length ? targetCol[targetCol.length - 1] : null;

    if (source.kind === "waste") {
      var w = this._board.waste;
      if (w.length === 0) return false;
      var card = w[w.length - 1];
      if (!Deck.canStackOnTableau(card, targetTop)) return false;
      w.pop();
      targetCol.push(card);
      this._undo.push({ kind: "wasteToTableau", toCol: toCol });
      this._moves++;
      this._emitChange();
      return true;
    }

    if (source.kind === "foundation") {
      var f = this._board.foundations[source.index];
      if (!f || f.length === 0) return false;
      var fCard = f[f.length - 1];
      if (!Deck.canStackOnTableau(fCard, targetTop)) return false;
      f.pop();
      targetCol.push(fCard);
      this._undo.push({ kind: "foundationToTableau", foundationIdx: source.index, toCol: toCol });
      this._moves++;
      this._emitChange();
      return true;
    }

    if (source.kind === "tableau") {
      var fromCol = this._board.tableau[source.col];
      if (!fromCol) return false;
      // Index must be at or above the first face-up card (can't drag face-
      // down cards) and must reference a real card.
      var firstFaceUp = this._board.tableauHidden[source.col];
      if (source.index < firstFaceUp || source.index >= fromCol.length) return false;
      var head = fromCol[source.index];
      if (!Deck.canStackOnTableau(head, targetTop)) return false;
      // Move the slice [index..end] to target column in order.
      var moving = fromCol.splice(source.index);
      for (var i = 0; i < moving.length; i++) targetCol.push(moving[i]);
      var flipped = this._maybeFlipColumn(source.col);
      this._undo.push({
        kind: "tableauToTableau",
        fromCol: source.col,
        count: moving.length,
        toCol: toCol,
        flippedHidden: flipped,
      });
      this._moves++;
      this._emitChange();
      return true;
    }

    return false;
  };

  // Peek (without mutating) the top card of a source. For tableau sources
  // with an `index`, returns that specific card (the head of the moving
  // stack). Used by predicate checks before commit.
  SolitaireGame.prototype._peekSource = function (source) {
    if (source.kind === "waste") {
      var w = this._board.waste;
      return w.length ? w[w.length - 1] : null;
    }
    if (source.kind === "foundation") {
      var f = this._board.foundations[source.index];
      return f && f.length ? f[f.length - 1] : null;
    }
    if (source.kind === "tableau") {
      var col = this._board.tableau[source.col];
      if (!col || source.index >= col.length) return null;
      return col[source.index];
    }
    return null;
  };

  // After moving cards off a tableau column, if the new top of column was
  // hidden, flip it face-up. Returns whether a flip happened, so undo can
  // re-hide it on reverse.
  SolitaireGame.prototype._maybeFlipColumn = function (col) {
    var hidden = this._board.tableauHidden[col];
    var len = this._board.tableau[col].length;
    if (hidden > 0 && hidden >= len) {
      // The exposed card was at index hidden-1 (since 'hidden' counts how
      // many face-down cards from the bottom); flipping it means lowering
      // the count by 1.
      this._board.tableauHidden[col] = hidden - 1;
      return true;
    }
    return false;
  };

  // --- Undo ---

  SolitaireGame.prototype.undo = function () {
    if (this._state !== STATE_PLAYING) return false;
    if (this._undo.length === 0) return false;
    var entry = this._undo.pop();
    var b = this._board;

    switch (entry.kind) {
      case "draw":
        // Move top of waste back to stock (face-down again is fine — the
        // engine doesn't track face state for stock cards).
        b.stock.push(b.waste.pop());
        break;
      case "recycle":
        // Reverse-recycle: stock back to waste in opposite order. The
        // forward recycle reversed the waste, so undoing reverses again.
        b.waste = b.stock.slice().reverse();
        b.stock = [];
        break;
      case "wasteToFoundation":
        b.waste.push(b.foundations[entry.foundationIdx].pop());
        break;
      case "tableauToFoundation":
        if (entry.flippedHidden) {
          // Re-hide the card the move had revealed.
          b.tableauHidden[entry.fromCol]++;
        }
        b.tableau[entry.fromCol].push(b.foundations[entry.foundationIdx].pop());
        break;
      case "wasteToTableau":
        b.waste.push(b.tableau[entry.toCol].pop());
        break;
      case "foundationToTableau":
        b.foundations[entry.foundationIdx].push(b.tableau[entry.toCol].pop());
        break;
      case "tableauToTableau":
        if (entry.flippedHidden) {
          b.tableauHidden[entry.fromCol]++;
        }
        var toCol = b.tableau[entry.toCol];
        var moved = toCol.splice(toCol.length - entry.count, entry.count);
        var fromCol = b.tableau[entry.fromCol];
        for (var i = 0; i < moved.length; i++) fromCol.push(moved[i]);
        break;
      default:
        // Unknown entry — shove it back on the stack and bail. Better than
        // silently corrupting state.
        this._undo.push(entry);
        return false;
    }
    // Undo does NOT decrement the move counter — that's the cost of taking
    // back a move, and it matches every solitaire client I've ever used.
    this._emitChange();
    return true;
  };

  // --- Auto-complete ---

  // Single auto-complete step: find any tableau-top or waste card that can
  // legally go to a foundation, and move it. Returns true if a move was
  // made. The application layer loops on this with a short delay between
  // steps so the cascade animates rather than snapping.
  SolitaireGame.prototype.autoCompleteStep = function () {
    if (this._state !== STATE_PLAYING) return false;
    var b = this._board;
    var foundationTops = this._foundationTops();

    // Prefer tableau cards (more visually satisfying — the cascade drains
    // the board), then the waste.
    for (var col = 0; col < b.tableau.length; col++) {
      var stack = b.tableau[col];
      if (stack.length === 0) continue;
      var top = stack[stack.length - 1];
      var dest = Deck.findFoundationTarget(top, foundationTops);
      if (dest >= 0) {
        this._tryToFoundation({ kind: "tableau", col: col, index: stack.length - 1 }, dest);
        return true;
      }
    }
    if (b.waste.length) {
      var w = b.waste[b.waste.length - 1];
      var wdest = Deck.findFoundationTarget(w, foundationTops);
      if (wdest >= 0) {
        this._tryToFoundation({ kind: "waste" }, wdest);
        return true;
      }
    }
    // No foundation move available — cycle the stock so the next card surfaces.
    // canAutoComplete only green-lights Finish when this exact policy runs the
    // board out (see _canFinishByAutoplay), so the draw can't loop forever.
    if (b.stock.length || b.waste.length) {
      return this.drawStock();
    }
    return false;
  };

  SolitaireGame.prototype._foundationTops = function () {
    var tops = [];
    for (var i = 0; i < this._board.foundations.length; i++) {
      var f = this._board.foundations[i];
      tops.push(f.length ? f[f.length - 1] : null);
    }
    return tops;
  };

  // --- Win detection ---

  SolitaireGame.prototype._checkWin = function () {
    var f = this._board.foundations;
    var total = 0;
    for (var i = 0; i < f.length; i++) total += f[i].length;
    if (total === Deck.DECK_SIZE) {
      this._endMs = Date.now();
      this._setState(STATE_WON);
    }
  };

  // --- State change emit ---

  SolitaireGame.prototype._setState = function (s) {
    if (this._state === s) return;
    this._state = s;
    if (this.listener.onStateChange) this.listener.onStateChange(s);
  };

  SolitaireGame.prototype._emitChange = function () {
    if (this.listener.onChange) this.listener.onChange();
  };

  SolitaireGame.STATE_IDLE = STATE_IDLE;
  SolitaireGame.STATE_PLAYING = STATE_PLAYING;
  SolitaireGame.STATE_WON = STATE_WON;
  SolitaireGame.MODE_DAILY = MODE_DAILY;
  SolitaireGame.MODE_RANDOM = MODE_RANDOM;
  window.SolitaireGame = SolitaireGame;
})();

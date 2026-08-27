// Persists the all-time best, this month's best, and which of those two the
// platform has already accepted. Same shape as snake's storage_manager for the
// best score — a real-time game's in-progress board has no meaningful "resume
// from move N" once the timer has elapsed in the background, so the board
// itself is never saved.
//
// The month best exists because the leaderboard has a monthly board next to the
// all-time one (js/leaderboard.js): the server keeps the max under a per-month
// round key, but only this game knows what this player scored this month, so
// the number has to be tracked here and submitted like any other score.

(function () {
  var BEST_SCORE_KEY = "bestScore";
  // "YYYY-MM:score". One key, not one per month: only the current month's best
  // is ever submitted, so a past month's number is dead weight the moment the
  // boundary passes — and a key per month would grow the per-user store forever
  // for a value nothing reads back.
  var MONTH_BEST_KEY = "monthBest";
  // What the platform has confirmed, in the same two shapes. Written only when
  // a submit RESOLVES, which is what makes a dropped request recoverable: the
  // marker stays behind the real best, and the next load (or game over, or
  // background) retries it. See submitBests() in application.js.
  var SUBMITTED_BEST_KEY = "submittedBest";
  var SUBMITTED_MONTH_KEY = "submittedMonthBest";

  /**
   * `YYYY-MM` for the current month, in UTC — deliberately the same rule as the
   * shared UI's `currentPeriod` (src/ui/season.ts), for the same reason: a month
   * boundary has to be one instant for every player. Read locally, a player in
   * UTC+13 would start submitting to September's board while UTC-11 players are
   * still filling August's, and the two would never see the same table.
   */
  function currentPeriod(date) {
    var d = date || new Date();
    var month = String(d.getUTCMonth() + 1);
    if (month.length < 2) month = "0" + month;
    return d.getUTCFullYear() + "-" + month;
  }

  /** Round key for a month's board. Kept next to the storage that stamps it. */
  function monthRoundKey(period) {
    return "month-" + (period || currentPeriod());
  }

  // "YYYY-MM:1234" → { period: "2026-08", score: 1234 }, or null if it doesn't
  // read as one. A stamped value that won't parse is treated as absent rather
  // than as period-less, so a corrupt write can't be mistaken for this month.
  function parseStamped(raw) {
    if (raw == null) return null;
    var parts = String(raw).split(":");
    if (parts.length !== 2) return null;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(parts[0])) return null;
    var score = parseInt(parts[1], 10);
    if (isNaN(score)) return null;
    return { period: parts[0], score: score };
  }

  function stamp(period, score) {
    return period + ":" + String(score);
  }

  // One key, read so that its failure can't take the other three down with it.
  //
  // WHY NOT A BARE Promise.all OF THE GETS. That rejects as a unit, so a dead
  // marker key would discard the best score that read back fine — and hydrating
  // the best as 0 doesn't just lose a number on the chip: game.js compares the
  // next run against it (`_gameOver`), so the first score of the session reads
  // as a new best and OVERWRITES the real one, with confetti. A failed read of
  // a submission marker costs at most one server-deduped resubmit; a failed
  // read of the best score, propagated, costs the player the score itself.
  function readKey(bridge, key) {
    return bridge.get(key).catch(function (err) {
      console.warn("match3: storage read failed for " + key, err);
      return null;
    });
  }

  function StorageManager() {
    this._best = 0;
    this._monthBest = null;
    this._submittedBest = 0;
    this._submittedMonth = null;
    this._bridge = null;
  }

  StorageManager.prototype.hydrate = function () {
    var self = this;
    if (!window.OddsRabbit || !window.OddsRabbit.storage) {
      return Promise.resolve();
    }
    self._bridge = window.OddsRabbit.storage;
    return Promise.all([
      readKey(self._bridge, BEST_SCORE_KEY),
      readKey(self._bridge, MONTH_BEST_KEY),
      readKey(self._bridge, SUBMITTED_BEST_KEY),
      readKey(self._bridge, SUBMITTED_MONTH_KEY),
    ]).then(function (values) {
      var parsedBest = parseInt(values[0], 10);
      if (!isNaN(parsedBest)) self._best = parsedBest;
      self._monthBest = parseStamped(values[1]);
      var parsedSubmitted = parseInt(values[2], 10);
      if (!isNaN(parsedSubmitted)) self._submittedBest = parsedSubmitted;
      self._submittedMonth = parseStamped(values[3]);
    }).catch(function (err) {
      // Backstop only: the reads themselves can no longer reject (readKey
      // absorbs that), so reaching here means the parse above threw. Swallowed
      // so a malformed stored value can't stop the game booting — the fields it
      // didn't reach keep their zero values, which for the markers costs one
      // server-deduped resubmit.
      console.warn("match3: storage hydrate failed", err);
    });
  };

  StorageManager.prototype.getBest = function () {
    return this._best || 0;
  };

  StorageManager.prototype.setBest = function (score) {
    this._best = score;
    if (this._bridge) {
      this._bridge.set(BEST_SCORE_KEY, String(score)).catch(function () {});
    }
  };

  // Zero for any month other than the stored one, so a month rolling over
  // resets the target without a write — the stale value is simply never read
  // again, and the next run of the new month overwrites it.
  StorageManager.prototype.getMonthBest = function (period) {
    var p = period || currentPeriod();
    return this._monthBest && this._monthBest.period === p ? this._monthBest.score : 0;
  };

  // Records `score` as this month's best when it beats what's stored. Returns
  // whether it did, so the caller can skip a submit that would change nothing.
  StorageManager.prototype.recordMonthScore = function (score, period) {
    var p = period || currentPeriod();
    if (score <= this.getMonthBest(p)) return false;
    this._monthBest = { period: p, score: score };
    if (this._bridge) {
      this._bridge.set(MONTH_BEST_KEY, stamp(p, score)).catch(function () {});
    }
    return true;
  };

  StorageManager.prototype.getSubmittedBest = function () {
    return this._submittedBest || 0;
  };

  StorageManager.prototype.markBestSubmitted = function (score) {
    if (score <= this._submittedBest) return;
    this._submittedBest = score;
    if (this._bridge) {
      this._bridge.set(SUBMITTED_BEST_KEY, String(score)).catch(function () {});
    }
  };

  StorageManager.prototype.getSubmittedMonthBest = function (period) {
    var p = period || currentPeriod();
    return this._submittedMonth && this._submittedMonth.period === p
      ? this._submittedMonth.score
      : 0;
  };

  StorageManager.prototype.markMonthBestSubmitted = function (score, period) {
    var p = period || currentPeriod();
    if (score <= this.getSubmittedMonthBest(p)) return;
    this._submittedMonth = { period: p, score: score };
    if (this._bridge) {
      this._bridge.set(SUBMITTED_MONTH_KEY, stamp(p, score)).catch(function () {});
    }
  };

  window.Match3StorageManager = StorageManager;

  // Round keys and the month boundary, shared by application.js (which submits)
  // and js/leaderboard.js (which reads the boards back). Both must agree on the
  // key exactly or the game writes to a board the modal never opens; this file
  // owns them because it's the one that stamps stored values with the period,
  // and it loads before either consumer.
  window.Match3Rounds = {
    HIGHSCORE: "highscore",
    currentPeriod: currentPeriod,
    monthRoundKey: monthRoundKey,
  };
})();

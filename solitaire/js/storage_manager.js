// Per-user persistence via OR.storage. Solitaire is turn-based with a
// meaningful resume point (mid-deal), so unlike snake we DO persist the
// in-progress game on pause. Keys:
//
//   bestTimeMs       — fastest completed win in ms (any deal).
//   winStreak        — consecutive daily-deal wins. There's no "loss" event
//                      (Klondike has no terminal loss), so the streak isn't
//                      reset eagerly; instead it's recomputed at each daily
//                      win (see finalizeWin): a win continues the streak only
//                      if the last logged daily was yesterday's and was won,
//                      otherwise it restarts at 1. A missed day therefore
//                      surfaces as a reset on the next win, never sooner.
//   lastDailyId      — most recent daily seed the player engaged with.
//   lastDailyWon     — whether they won it (for streak math + aggregate
//                      dedup so refreshing a won deal doesn't double-count).
//   savedGame        — JSON blob of in-progress state (deal + history).
//                      Cleared on win/loss/new-deal.

(function () {
  var KEY_BEST_TIME = "bestTimeMs";
  var KEY_STREAK = "winStreak";
  var KEY_LAST_DAILY = "lastDailyId";
  var KEY_LAST_DAILY_WON = "lastDailyWon";
  var KEY_SAVED_GAME = "savedGame";

  function StorageManager() {
    this._best = 0;
    this._streak = 0;
    this._lastDailyId = -1;
    this._lastDailyWon = false;
    this._savedGame = null;
    this._bridge = null;
  }

  StorageManager.prototype.hydrate = function () {
    var self = this;
    if (!window.OddsRabbit || !window.OddsRabbit.storage) {
      return Promise.resolve();
    }
    self._bridge = window.OddsRabbit.storage;
    // Parallel fetch — none of these depend on each other, so a single
    // round-trip-equivalent for all five. Failures degrade silently to the
    // defaults set in the constructor (best=0, streak=0, no saved game).
    return Promise.all([
      self._bridge.get(KEY_BEST_TIME).then(function (raw) {
        if (raw == null) return;
        var parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed > 0) self._best = parsed;
      }).catch(noop),
      self._bridge.get(KEY_STREAK).then(function (raw) {
        if (raw == null) return;
        var parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed >= 0) self._streak = parsed;
      }).catch(noop),
      self._bridge.get(KEY_LAST_DAILY).then(function (raw) {
        if (raw == null) return;
        var parsed = parseInt(raw, 10);
        if (!isNaN(parsed)) self._lastDailyId = parsed;
      }).catch(noop),
      self._bridge.get(KEY_LAST_DAILY_WON).then(function (raw) {
        self._lastDailyWon = raw === "1";
      }).catch(noop),
      self._bridge.get(KEY_SAVED_GAME).then(function (raw) {
        if (!raw) return;
        try {
          self._savedGame = JSON.parse(raw);
        } catch (e) {
          // Corrupted save shouldn't brick the boot; just discard.
          self._savedGame = null;
        }
      }).catch(noop),
    ]).then(noop);
  };

  function noop() {}

  StorageManager.prototype.getBest = function () { return this._best; };
  StorageManager.prototype.getStreak = function () { return this._streak; };
  StorageManager.prototype.getLastDailyId = function () { return this._lastDailyId; };
  StorageManager.prototype.getLastDailyWon = function () { return this._lastDailyWon; };
  StorageManager.prototype.getSavedGame = function () { return this._savedGame; };

  StorageManager.prototype.setBest = function (ms) {
    this._best = ms;
    this._write(KEY_BEST_TIME, String(ms));
  };
  StorageManager.prototype.setStreak = function (n) {
    this._streak = n;
    this._write(KEY_STREAK, String(n));
  };
  StorageManager.prototype.setLastDaily = function (id, won) {
    this._lastDailyId = id;
    this._lastDailyWon = !!won;
    this._write(KEY_LAST_DAILY, String(id));
    this._write(KEY_LAST_DAILY_WON, won ? "1" : "0");
  };
  StorageManager.prototype.setSavedGame = function (snapshot) {
    this._savedGame = snapshot;
    if (snapshot == null) {
      this._write(KEY_SAVED_GAME, "");
    } else {
      this._write(KEY_SAVED_GAME, JSON.stringify(snapshot));
    }
  };
  StorageManager.prototype.clearSavedGame = function () {
    this.setSavedGame(null);
  };

  // Fire-and-forget. The in-memory copy is already updated; a failed write
  // only means the next page load might show a slightly-stale value (e.g.
  // a best time set in the same session but not persisted).
  StorageManager.prototype._write = function (key, value) {
    if (!this._bridge) return;
    this._bridge.set(key, value).catch(noop);
  };

  window.SolitaireStorageManager = StorageManager;
})();

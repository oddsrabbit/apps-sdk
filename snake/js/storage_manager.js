// Stripped-down version of 2048's storage_manager. Snake doesn't persist the
// in-progress run (a real-time game has no meaningful "resume from move N"
// the way a turn-based game does — if the page closes mid-tick, the right
// behavior is to start fresh next time). So this only tracks bestScore.

(function () {
  var BEST_SCORE_KEY = "bestScore";

  function StorageManager() {
    this._best = 0;
    this._bridge = null;
  }

  StorageManager.prototype.hydrate = function () {
    var self = this;
    if (!window.OddsRabbit || !window.OddsRabbit.storage) {
      return Promise.resolve();
    }
    self._bridge = window.OddsRabbit.storage;
    return self._bridge.get(BEST_SCORE_KEY).then(function (raw) {
      if (raw == null) return;
      var parsed = parseInt(raw, 10);
      if (!isNaN(parsed)) self._best = parsed;
    }).catch(function (err) {
      console.warn("snake: storage hydrate failed", err);
    });
  };

  StorageManager.prototype.getBest = function () {
    return this._best || 0;
  };

  StorageManager.prototype.setBest = function (score) {
    this._best = score;
    if (this._bridge) {
      // Fire-and-forget; the in-memory value is already updated, so a failed
      // write just means the next page load might show a slightly stale best.
      this._bridge.set(BEST_SCORE_KEY, String(score)).catch(function () {});
    }
  };

  window.SnakeStorageManager = StorageManager;
})();

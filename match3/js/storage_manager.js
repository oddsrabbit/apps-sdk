// Persists best score only. Same shape as snake's storage_manager — a real-
// time game's in-progress board has no meaningful "resume from move N" once
// the timer has elapsed in the background, so we only track the high score.

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

  window.Match3StorageManager = StorageManager;
})();

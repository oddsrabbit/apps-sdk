// Bridge-backed replacement for the original local_storage_manager.js.
// Same synchronous prototype interface so game_manager.js stays unchanged;
// values hydrate once at startup and writes go fire-and-forget to the
// OddsRabbit bridge so per-user state syncs across mobile and web.

// Game state is written on every actuate (every move). Coalesce rapid writes
// into a single trailing-edge bridge call so a fast player doesn't generate
// 2-3 storage.set RPCs per second. Best score is written rarely (only on a
// new personal best) so it stays immediate.
var STATE_WRITE_DEBOUNCE_MS = 500;

function StorageManager() {
  this.bestScoreKey = "bestScore";
  this.gameStateKey = "gameState";
  this._best = 0;
  this._state = null;
  this._bridge = null;
  this._stateWriteTimer = null;
}

// Called once after OR.whenReady() resolves, before GameManager is constructed.
// Always resolves: if the bridge is absent or storage reads fail, the game
// boots with fresh state (best score = 0, no saved game). Note this fallback
// only covers post-init failures — if the host never sends init,
// OR.whenReady() hangs upstream and this function is never reached.
StorageManager.prototype.hydrate = function () {
  var self = this;
  if (!window.OddsRabbit || !window.OddsRabbit.storage) {
    return Promise.resolve();
  }
  self._bridge = window.OddsRabbit.storage;
  // Flush pending state writes before the page unloads so a quick tab switch
  // or close right after a move doesn't lose the last bit of progress.
  window.addEventListener("pagehide", function () { self.flushStateWrite(); });
  return Promise.all([
    self._bridge.get(self.bestScoreKey),
    self._bridge.get(self.gameStateKey),
  ]).then(function (values) {
    var bestRaw = values[0];
    var stateRaw = values[1];
    if (bestRaw != null) {
      var parsed = parseInt(bestRaw, 10);
      if (!isNaN(parsed)) self._best = parsed;
    }
    if (stateRaw != null) {
      try { self._state = JSON.parse(stateRaw); } catch (_) {}
    }
  }).catch(function (err) {
    console.warn("2048: storage hydrate failed", err);
  });
};

StorageManager.prototype.getBestScore = function () {
  return this._best || 0;
};

StorageManager.prototype.setBestScore = function (score) {
  this._best = score;
  if (this._bridge) {
    this._bridge.set(this.bestScoreKey, String(score)).catch(function () {});
  }
};

StorageManager.prototype.getGameState = function () {
  return this._state;
};

StorageManager.prototype.setGameState = function (state) {
  this._state = state;
  if (!this._bridge) return;
  var self = this;
  if (this._stateWriteTimer) clearTimeout(this._stateWriteTimer);
  this._stateWriteTimer = setTimeout(function () {
    self._stateWriteTimer = null;
    self._bridge.set(self.gameStateKey, JSON.stringify(self._state)).catch(function () {});
  }, STATE_WRITE_DEBOUNCE_MS);
};

StorageManager.prototype.clearGameState = function () {
  this._state = null;
  if (this._stateWriteTimer) {
    clearTimeout(this._stateWriteTimer);
    this._stateWriteTimer = null;
  }
  if (this._bridge) {
    this._bridge.delete(this.gameStateKey).catch(function () {});
  }
};

StorageManager.prototype.flushStateWrite = function () {
  if (!this._stateWriteTimer) return;
  clearTimeout(this._stateWriteTimer);
  this._stateWriteTimer = null;
  if (this._bridge && this._state != null) {
    this._bridge.set(this.gameStateKey, JSON.stringify(this._state)).catch(function () {});
  }
};

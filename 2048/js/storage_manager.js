// Bridge-backed replacement for the original local_storage_manager.js.
// Same synchronous prototype interface so game_manager.js stays unchanged;
// values hydrate once at startup and writes go fire-and-forget to the
// OddsRabbit bridge so per-user state syncs across mobile and web.

// Game state is written on every actuate (every move). Coalesce rapid writes
// into a single trailing-edge bridge call so a fast player doesn't generate
// 2-3 storage.set RPCs per second. Best score is written rarely (only on a
// new personal best) so it stays immediate.
var STATE_WRITE_DEBOUNCE_MS = 500;

// Sentinel stored under pendingWinKey once the platform confirms a win. Any
// value that can't be read as a score works; see the state table on
// getPendingWin() for why confirmation writes rather than deletes.
var WIN_RECORDED_VALUE = "done";

function StorageManager() {
  this.bestScoreKey = "bestScore";
  this.gameStateKey = "gameState";
  this.pendingWinKey = "pendingWin";
  this._best = 0;
  this._state = null;
  this._pendingWin = null;
  this._winRecorded = false;
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
    self._bridge.get(self.pendingWinKey),
  ]).then(function (values) {
    var bestRaw = values[0];
    var stateRaw = values[1];
    var pendingWinRaw = values[2];
    if (bestRaw != null) {
      var parsed = parseInt(bestRaw, 10);
      if (!isNaN(parsed)) self._best = parsed;
    }
    if (stateRaw != null) {
      try { self._state = JSON.parse(stateRaw); } catch (_) {}
    }
    // Sentinel first — it doesn't parse as a number, so the score branch below
    // would otherwise read it as a corrupt marker and retry a confirmed win
    // forever. Past that, presence is the signal and not the value: an
    // unparseable marker still means "a win is unconfirmed", so fall back to 0
    // rather than dropping it.
    if (pendingWinRaw === WIN_RECORDED_VALUE) {
      self._winRecorded = true;
    } else if (pendingWinRaw != null) {
      var pending = parseInt(pendingWinRaw, 10);
      self._pendingWin = isNaN(pending) ? 0 : pending;
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

// One key, three states — "confirmed" has to be distinguishable from "never
// won", not collapsed into it:
//
//   absent      nothing known. A restored game whose `won` flag is set may
//               predate this marker entirely, so it's worth one backfill.
//   "<number>"  a win at that score is NOT on record yet. Retry it.
//   "done"      the platform has this player's win. Never submit again.
//
// Confirmation therefore WRITES the sentinel instead of deleting the key. If it
// deleted, "confirmed" and "never won" would look identical, and the boot-time
// backfill in application.js would see a bare `won` saved game — which survives
// until a game over or a restart, so typically forever after a win — and
// resubmit on every single load for the rest of that player's life.
//
// Written immediately rather than debounced like game state: a win happens once
// and the marker has to outlive a close right after it.
//
// Deliberately NOT touched by clearGameState(). A game over wipes the saved
// game — including its `won` flag — but an unconfirmed win still needs
// retrying, so this outlives it. See submitWin() in application.js.
StorageManager.prototype.getPendingWin = function () {
  return this._pendingWin;
};

StorageManager.prototype.isWinRecorded = function () {
  return this._winRecorded;
};

StorageManager.prototype.setPendingWin = function (score) {
  this._pendingWin = score;
  if (this._bridge) {
    this._bridge.set(this.pendingWinKey, String(score)).catch(function () {});
  }
};

StorageManager.prototype.markWinRecorded = function () {
  this._pendingWin = null;
  this._winRecorded = true;
  if (this._bridge) {
    this._bridge.set(this.pendingWinKey, WIN_RECORDED_VALUE).catch(function () {});
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

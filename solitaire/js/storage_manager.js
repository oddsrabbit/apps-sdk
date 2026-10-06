// Per-user persistence via OR.storage. Solitaire is turn-based with a
// meaningful resume point (mid-deal), so unlike snake we DO persist the
// in-progress game on pause. Keys:
//
//   bestDailyMs      — fastest completed daily win in ms.
//   bestRandomMs     — fastest completed random (freeplay) win in ms. Kept
//                      separate from daily: random deals can be re-rolled
//                      until easy, so mixing the two made "Best" gameable.
//   bestTimeMs       — legacy any-mode best from before the split; read once
//                      at hydrate and migrated into bestDailyMs (the headline
//                      stat shown next to the streak), never written again.
//   winStreak        — consecutive daily-deal wins. There's no "loss" event
//                      (Klondike has no terminal loss), so the streak isn't
//                      reset eagerly; instead it's recomputed at each daily
//                      win (see finalizeWin): a win continues the streak only
//                      if the last logged daily was yesterday's and was won,
//                      otherwise it restarts at 1. A missed day therefore
//                      surfaces as a reset on the next win, never sooner.
//   lastDailyId      — most recent daily seed the player engaged with.
//   lastDailyWon     — whether they won it (for streak math — refreshing a
//                      won deal doesn't re-increment the streak).
//   savedGame        — JSON blob of in-progress state (deal + history).
//                      Cleared on win/loss/new-deal.
//   dailyAttempts    — "<dailyId>:<count>", how many times the player has
//                      started today's deal and made a move in it. The
//                      daily ranks on retries (count - 1), so this lives in
//                      server-side storage rather than the browser: clearing
//                      site data or switching devices doesn't reset it. One
//                      key for the latest deal only — older counts have no
//                      further use once that deal's score is in.
//   soundMuted       — "1" when the player muted the sound.
//   hapticsOff       — "1" when the player switched vibration off.
//
// The two settings are read here, in the same parallel hydrate as the game
// keys, rather than by their own OR.storage.get calls in application.js as
// they used to be. Those resolved on their own schedule — after OR.ready(),
// so after the host had dropped its cover — and a muted player watched the
// speaker icon flip from on to off a beat after load. Hydrated here, the HUD
// is painted from the saved state before it is revealed (see the `.ready`
// class on .hud-controls).

(function () {
  var KEY_BEST_TIME = "bestTimeMs"; // legacy, migrate-only
  var KEY_BEST_DAILY = "bestDailyMs";
  var KEY_BEST_RANDOM = "bestRandomMs";
  var KEY_STREAK = "winStreak";
  var KEY_LAST_DAILY = "lastDailyId";
  var KEY_LAST_DAILY_WON = "lastDailyWon";
  var KEY_SAVED_GAME = "savedGame";
  var KEY_DAILY_ATTEMPTS = "dailyAttempts";
  var KEY_MUTED = "soundMuted";
  // Vibration on/off, persisted separately from the mute setting. They are two
  // different senses and players silence them for different reasons — sound
  // because they are somewhere quiet, vibration because the buzzing is
  // distracting or drains the battery — so one switch for both would force a
  // player who wants neither one of them to give up the other.
  //
  // Stored inverted ("1" means OFF) so that the absence of the key, a failed
  // read, and an explicit "on" all mean the same thing. Haptics are on by
  // default, and a storage failure must not silently disable a feature the
  // player never asked to turn off.
  var KEY_HAPTICS_OFF = "hapticsOff";

  function StorageManager() {
    this._bestDaily = 0;
    this._bestRandom = 0;
    this._streak = 0;
    this._lastDailyId = -1;
    this._lastDailyWon = false;
    this._savedGame = null;
    this._attemptsId = -1;
    this._attempts = 0;
    // Both default to the "never expressed a choice" value — sound on,
    // vibration on — which is also what a failed read leaves behind.
    this._muted = false;
    this._hapticsOff = false;
    this._bridge = null;
  }

  StorageManager.prototype.hydrate = function () {
    var self = this;
    if (!window.OddsRabbit || !window.OddsRabbit.storage) {
      return Promise.resolve();
    }
    self._bridge = window.OddsRabbit.storage;
    // Parallel fetch — none of these depend on each other, so a single
    // round-trip-equivalent for all of them. Each read carries its own catch,
    // so failures degrade one key at a time to the defaults set in the
    // constructor (best=0, streak=0, no saved game, sound and vibration on).
    var legacyBest = 0;
    return Promise.all([
      self._bridge.get(KEY_BEST_DAILY).then(function (raw) {
        if (raw == null) return;
        var parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed > 0) self._bestDaily = parsed;
      }).catch(noop),
      self._bridge.get(KEY_BEST_RANDOM).then(function (raw) {
        if (raw == null) return;
        var parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed > 0) self._bestRandom = parsed;
      }).catch(noop),
      self._bridge.get(KEY_BEST_TIME).then(function (raw) {
        if (raw == null) return;
        var parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed > 0) legacyBest = parsed;
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
      self._bridge.get(KEY_DAILY_ATTEMPTS).then(function (raw) {
        var parsed = parseAttempts(raw);
        if (parsed) {
          self._attemptsId = parsed.id;
          self._attempts = parsed.count;
        }
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
      self._bridge.get(KEY_MUTED).then(function (raw) {
        self._muted = raw === "1";
      }).catch(noop),
      self._bridge.get(KEY_HAPTICS_OFF).then(function (raw) {
        self._hapticsOff = raw === "1";
      }).catch(noop),
    ]).then(function () {
      // One-time migration: a pre-split best (recorded before daily/random
      // were tracked separately) seeds the daily slot if it's still empty.
      // In-memory only — the legacy key is left as-is and simply unused.
      if (self._bestDaily === 0 && legacyBest > 0) self._bestDaily = legacyBest;
    });
  };

  function noop() {}

  // "<dailyId>:<count>" → { id, count }, or null for anything else.
  function parseAttempts(raw) {
    if (!raw) return null;
    var parts = String(raw).split(":");
    var id = parseInt(parts[0], 10);
    var count = parseInt(parts[1], 10);
    if (isNaN(id) || isNaN(count) || count < 0) return null;
    return { id: id, count: count };
  }

  // mode is SolitaireGame.MODE_DAILY ("daily") or MODE_RANDOM ("random").
  StorageManager.prototype.getBestFor = function (mode) {
    return mode === "daily" ? this._bestDaily : this._bestRandom;
  };
  StorageManager.prototype.getStreak = function () { return this._streak; };
  StorageManager.prototype.getLastDailyId = function () { return this._lastDailyId; };
  StorageManager.prototype.getLastDailyWon = function () { return this._lastDailyWon; };
  StorageManager.prototype.getSavedGame = function () { return this._savedGame; };
  StorageManager.prototype.getDailyAttempts = function (id) {
    return this._attemptsId === id ? this._attempts : 0;
  };
  StorageManager.prototype.getMuted = function () { return this._muted; };
  StorageManager.prototype.getHapticsEnabled = function () { return !this._hapticsOff; };

  StorageManager.prototype.setBestFor = function (mode, ms) {
    if (mode === "daily") {
      this._bestDaily = ms;
      this._write(KEY_BEST_DAILY, String(ms));
    } else {
      this._bestRandom = ms;
      this._write(KEY_BEST_RANDOM, String(ms));
    }
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
  // Counts locally at once, then re-reads the stored count before writing.
  // The cache is only as fresh as hydrate(), so a second session opened
  // earlier (another tab, the phone) would otherwise write over the attempts
  // made there — scout on one, play clean on the other. Taking the larger of
  // the two keeps whichever saw more.
  StorageManager.prototype.bumpDailyAttempts = function (id) {
    var self = this;
    if (this._attemptsId !== id) {
      this._attemptsId = id;
      this._attempts = 0;
    }
    this._attempts++;
    if (!this._bridge) return;
    this._bridge.get(KEY_DAILY_ATTEMPTS).catch(noop).then(function (raw) {
      var stored = parseAttempts(raw);
      if (self._attemptsId !== id) return; // a newer deal took over the key
      if (stored && stored.id === id) {
        self._attempts = Math.max(self._attempts, stored.count + 1);
      }
      self._write(KEY_DAILY_ATTEMPTS, id + ":" + self._attempts);
    });
  };
  StorageManager.prototype.setMuted = function (muted) {
    this._muted = !!muted;
    this._write(KEY_MUTED, muted ? "1" : "0");
  };
  StorageManager.prototype.setHapticsEnabled = function (enabled) {
    this._hapticsOff = !enabled;
    this._write(KEY_HAPTICS_OFF, enabled ? "0" : "1");
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

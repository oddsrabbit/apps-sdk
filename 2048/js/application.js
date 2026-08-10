// Async bootstrap: wait for the OddsRabbit bridge to deliver init (user +
// session) before reading any persisted state, then construct the game.
// Replaces the original one-line localStorage-only bootstrap.

(function () {
  var LANDING_URL = "https://www.oddsrabbit.com/games/2048/";

  var OR = window.OddsRabbit;
  if (!OR) {
    console.error("2048: OddsRabbit bridge not available — game requires the SDK host.");
    showFatalError("This game needs to run inside the OddsRabbit app or website.");
    return;
  }

  var storage = new StorageManager();

  // GameManager calls `new StorageManager`. JS treats an explicit object return
  // from a constructor as the result of `new`, so this factory hands back the
  // already-hydrated singleton instead of starting fresh.
  function StorageManagerFactory() {
    return storage;
  }

  // Wraps a freshly-constructed game's actuator to (a) share on first win,
  // (b) fire haptics for moves and terminal transitions, (c) record the win.
  // Instance-level (not prototype-level) so the closure state is scoped to this
  // GameManager — a second instance on the same page would get its own flags.
  // Applied AFTER `new GameManager` so the constructor's initial setup() actuate
  // runs unwrapped.
  function attachBridgeEffects(game) {
    var actuator = game.actuator;
    var origActuate = actuator.actuate.bind(actuator);
    var sharedThisLoad = false;
    var prevScore = null;
    // Seeded from the restored game, NOT `false`. Attaching after construction
    // only keeps the first actuate from reading as a transition; `won` and
    // `over` are restored from the saved state and stay set, so with these
    // hardcoded false the SECOND actuate — the first move made in keepPlaying
    // mode on a reloaded won game — looks like a brand new win and re-fires the
    // share sheet, the success haptic, and the win submit.
    var prevWon = game.won;
    var prevOver = game.over;

    actuator.actuate = function (grid, metadata) {
      origActuate(grid, metadata);

      var wonTransition = !prevWon && metadata.won;
      var overTransition = !prevOver && metadata.over;
      // Score-change is our proxy for "a merge happened this move." Slide-only
      // moves with no merge produce no haptic — accepting that trade-off so we
      // don't also haptic on restart-to-fresh-state actuates (which would
      // require coupling to the input manager).
      var scoreChanged = prevScore !== null && metadata.score !== prevScore;

      try {
        if (wonTransition) {
          OR.actions.haptic("success").catch(noop);
        } else if (overTransition) {
          OR.actions.haptic("error").catch(noop);
        } else if (scoreChanged) {
          OR.actions.haptic("light").catch(noop);
        }
      } catch (_) {}

      // On game over, record the player's all-time best to the "highscore" board
      // (keep-best: the server keeps the max, so submitting each game is safe).
      // Separate from the "win" round below, which drives achievements.
      if (overTransition) {
        submitHighScore();
      }

      if (wonTransition && !sharedThisLoad) {
        sharedThisLoad = true;
        try {
          OR.actions
            .share({
              title: "2048",
              text: "I just hit 2048! 🎉\n\nPlay at " + LANDING_URL,
            })
            .catch(noop);
        } catch (_) {}
      }

      // Mark the win as unconfirmed BEFORE attempting to record it, so a submit
      // that never lands is retried on the next load. Skipped once the platform
      // has this player's win: roundKey is the constant "win", so a second win
      // can never be recorded and its marker would never clear. See submitWin()
      // for why the marker exists at all.
      if (wonTransition && !storage.isWinRecorded() && canSubmitScores()) {
        storage.setPendingWin(metadata.score);
        submitWin(metadata.score);
      }

      prevScore = metadata.score;
      prevWon = metadata.won;
      prevOver = metadata.over;
    };
  }

  function noop() {}

  // Whether a score submission is worth attempting at all.
  //
  // Guests are excluded, and that exclusion is NOT deferred: the endpoint needs
  // a signed-in user, and while `user` is null the host serves storage.* from
  // this origin's localStorage instead of the per-user server store. Nothing
  // migrates one to the other, so a marker written as a guest sits in a
  // namespace the signed-in session never reads. Writing one would be dead
  // weight rather than a win credited later, so a guest's win is simply not
  // recorded — same as before this marker existed.
  //
  // The capability check reflects what this host has already proven: the SDK
  // retires a verb the host rejects as unknown, so after one such rejection we
  // stop writing markers for a call that just demonstrated it can't land. It is
  // guarded because sdk-v1.js is deployed separately and may predate it.
  function canSubmitScores() {
    if (!OR.user || !OR.scores || typeof OR.scores.submit !== "function") return false;
    try {
      if (OR.capabilities && typeof OR.capabilities.has === "function") {
        return OR.capabilities.has("scores.submit");
      }
    } catch (_) {}
    return true;
  }

  // Record a 2048 win to the platform so it lands in the app_scores table
  // (metadata.won === true sets the backend's won_flag). roundKey is the
  // constant "win", so scores.submit's (app, roundKey, user) uniqueness means
  // each player's FIRST win is recorded once; a repeat rejects with
  // `scores/already-submitted`, which — like success — proves the win is on
  // record, so both mark it recorded.
  //
  // WHY THE MARKER. This is a permanent public honor (the Hall of Fame board is
  // ordered by created_at, oldest first), and the win transition fires exactly
  // once per saved game. A dropped request used to be unrecoverable: `won` is
  // restored from the saved state, so wonTransition never fires again, and a
  // later game over calls clearGameState() and wipes even that. The pending
  // marker is written to storage before the request and survives both, so the
  // next load retries until the platform confirms.
  //
  // EVERY other failure leaves the marker set, not just network ones. We can't
  // tell a dropped request from a permanent rejection, and the two mistakes are
  // not symmetric: over-retrying costs one request per load, under-retrying
  // costs a player an honor they earned and can never earn again. A marker
  // stranded on a host that doesn't implement scores.submit isn't wasted
  // either — signed-in storage is per-user and syncs across mobile and web, so
  // it retries on the next host that does.
  var winSubmitInFlight = false;
  function submitWin(score) {
    if (winSubmitInFlight) return;
    if (!canSubmitScores()) return;
    winSubmitInFlight = true;
    try {
      OR.scores
        .submit({
          roundKey: "win",
          score: score,
          metadata: { won: true, tile: 2048 },
        })
        .then(function () {
          winSubmitInFlight = false;
          storage.markWinRecorded();
        })
        .catch(function (err) {
          winSubmitInFlight = false;
          if (err && err.code === "scores/already-submitted") {
            storage.markWinRecorded();
          }
        });
    } catch (_) {
      winSubmitInFlight = false;
    }
  }

  // Submit the player's all-time best to the global "highscore" leaderboard.
  // Uses keepBest so the server keeps the max under this constant roundKey — a
  // rising best can't be frozen by the one-submission 409. Signed-in only (the
  // endpoint requires a user, and there'd be no one to rank). Skips redundant
  // resubmits within a load; the server dedups the rest.
  var lastSubmittedBest = 0;
  function submitHighScore() {
    if (!OR.user || !OR.scores || typeof OR.scores.submit !== "function") return;
    var best = storage.getBestScore();
    if (!best || best <= 0 || best === lastSubmittedBest) return;
    lastSubmittedBest = best;
    try {
      OR.scores
        .submit({ roundKey: "highscore", score: best, keepBest: true, metadata: { best: true } })
        .catch(noop);
    } catch (_) {}
  }

  // Surface fatal errors to the user instead of leaving them on a half-painted
  // (or empty) game. role="alert" auto-announces to assistive tech without
  // making the rest of the container a live region.
  function showFatalError(message) {
    if (document.querySelector(".bootstrap-error")) return;
    var banner = document.createElement("div");
    banner.className = "bootstrap-error";
    banner.setAttribute("role", "alert");
    banner.textContent = message;
    var target = document.querySelector(".container") || document.body;
    if (target === document.body) {
      target.appendChild(banner);
    } else {
      target.insertBefore(banner, target.firstChild);
    }
  }

  OR.whenReady()
    .then(function () {
      return storage.hydrate();
    })
    .then(function () {
      // Flush pending state writes on host-driven pause (mobile background,
      // tab switch via the host). Complements the pagehide listener in
      // storage_manager.js — pause is the bridge-native signal, pagehide
      // is the browser fallback. Both are best-effort.
      try {
        OR.lifecycle.on("pause", function () {
          storage.flushStateWrite();
          // Also flush the best score to the leaderboard on background/close —
          // covers players who set a new best and leave without a game-over.
          submitHighScore();
        });
      } catch (_) {}

      window.requestAnimationFrame(function () {
        var game = new GameManager(4, KeyboardInputManager, HTMLActuator, StorageManagerFactory);
        attachBridgeEffects(game);

        // Retry any win the platform hasn't confirmed. This is the only path
        // that can credit a restored won game: the constructor's setup()
        // actuate runs before attachBridgeEffects, unwrapped, and every later
        // actuate now compares against the restored `won`, so reloading a won
        // game produces no wonTransition and would otherwise never submit.
        var pendingWin = storage.getPendingWin();
        if (pendingWin !== null) {
          submitWin(pendingWin);
        } else if (game.won && !storage.isWinRecorded() && canSubmitScores()) {
          // A game won before the marker existed carries none, and may never
          // have been recorded. One idempotent attempt repairs those; for
          // everyone already on the board it rejects as already-submitted.
          // Either outcome writes the "recorded" sentinel, which is what keeps
          // this a one-time backfill per player rather than a resubmit on every
          // load — a won game stays in storage until a game over or a restart,
          // so the `won` flag alone would keep qualifying indefinitely.
          //
          // The score submitted is the restored game's CURRENT score, which for
          // a kept-playing game is higher than it was at the moment of the win.
          // Nothing recorded the score at the win, and the board is ordered by
          // created_at rather than score, so the honor lands correctly even
          // where the number is generous.
          storage.setPendingWin(game.score);
          submitWin(game.score);
        }
        // Subtle confirmation that the "New Game" tap registered. Move/win/
        // lose haptics live in attachBridgeEffects on the actuator; restart
        // is the only player-initiated action that doesn't go through there.
        try {
          game.inputManager.on("restart", function () {
            try { OR.actions.haptic("light").catch(noop); } catch (_) {}
          });
        } catch (_) {}
        try { OR.ready(); } catch (_) {}
      });
    })
    .catch(function (err) {
      // Reachable only if storage.hydrate() rejects. hydrate() catches its own
      // errors so this is effectively unused, but it keeps the chain from
      // going unhandled if a future change throws synchronously.
      console.error("2048: bootstrap failed", err);
      showFatalError("Couldn't start the game. Try reloading the page.");
    });
})();

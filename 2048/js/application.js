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

  // Wraps a freshly-constructed actuator instance to (a) share on first win,
  // (b) fire haptics for moves and terminal transitions. Instance-level (not
  // prototype-level) so the closure state is scoped to this GameManager —
  // a second instance on the same page would get its own flags. Applied AFTER
  // `new GameManager` so the constructor's initial setup() actuate runs
  // unwrapped: reloading an already-won saved game won't spuriously fire share
  // or success-haptic.
  function attachBridgeEffects(actuator) {
    var origActuate = actuator.actuate.bind(actuator);
    var sharedThisLoad = false;
    var submittedWinThisLoad = false;
    var prevScore = null;
    var prevWon = false;
    var prevOver = false;

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

      // Record the win to the platform so it lands in the app_scores table
      // (metadata.won === true sets the backend's won_flag). roundKey is the
      // constant "win", so scores.submit's (app, roundKey, user) uniqueness
      // means each player's FIRST 2048 win is recorded once — repeat wins
      // reject with 409 already-submitted, which we swallow. Guests can't
      // submit (the endpoint requires a signed-in user) and there'd be no one
      // to credit in a post, so we skip them. Once-per-load flag mirrors the
      // share guard above.
      if (
        wonTransition &&
        !submittedWinThisLoad &&
        OR.user &&
        OR.scores &&
        typeof OR.scores.submit === "function"
      ) {
        submittedWinThisLoad = true;
        try {
          OR.scores
            .submit({
              roundKey: "win",
              score: metadata.score,
              metadata: { won: true, tile: 2048 },
            })
            .catch(noop); // 409 on a repeat win (already-submitted) is expected.
        } catch (_) {}
      }

      prevScore = metadata.score;
      prevWon = metadata.won;
      prevOver = metadata.over;
    };
  }

  function noop() {}

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
        attachBridgeEffects(game.actuator);
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

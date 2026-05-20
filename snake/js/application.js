// Async bootstrap. Mirrors 2048/js/application.js in shape: wait for the
// OddsRabbit bridge to deliver init, hydrate persisted best score, then
// construct the game and call OR.ready() so the host can hide its skeleton.

(function () {
  var LANDING_URL = "https://www.oddsrabbit.com/games/snake/";
  // Threshold for the milestone share. A first-ever run usually scores under
  // 100 (just learning controls), so this filters out the noisy "you set a
  // new best of 30!" share on the very first game. Same idea as 2048 only
  // sharing once you reach the canonical 2048 tile.
  var SHARE_MIN_SCORE = 100;
  // Floor below which the community note is suppressed — at sub-50 scores
  // the player is still learning the controls and "you reached the 0-49
  // range" reads as a sneer, not a leaderboard. Same intent as SHARE_MIN_SCORE
  // but a lower bar (any score worth comparing, not just brag-worthy ones).
  var COMMUNITY_MIN_SCORE = 50;
  var WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  // Touch-vs-keyboard branch for the idle overlay text. `maxTouchPoints` is
  // the modern signal (handles desktops with touchscreens correctly); the
  // legacy `ontouchstart in window` check is the iOS Safari fallback for old
  // engines that don't report maxTouchPoints. Either being truthy → mobile-
  // ish UX, so we prefer "tap" wording over "press any key".
  var IS_TOUCH = (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0)
    || ("ontouchstart" in window);
  var IDLE_TEXT = IS_TOUCH ? "TAP OR SWIPE" : "PRESS ANY KEY";

  var OR = window.OddsRabbit;
  if (!OR) {
    console.error("snake: OddsRabbit bridge not available — game requires the SDK host.");
    showFatalError("This game needs to run inside the OddsRabbit app or website.");
    return;
  }

  var storage = new SnakeStorageManager();

  function noop() {}

  // Score → band. Bands are coarse on purpose — finer bands fragment the
  // population and push individual buckets below the k=5 anonymity floor,
  // hiding the community line for everyone.
  function scoreBand(score) {
    if (score < 50) return "0-49";
    if (score < 100) return "50-99";
    if (score < 200) return "100-199";
    if (score < 500) return "200-499";
    return "500+";
  }

  // 7-day rolling bucket. Aligned to UTC epoch (not local Monday) so all
  // clients agree on which "week" a play belongs to without having to round-
  // trip through the host. Resets weekly so old data doesn't dominate.
  function currentWeek() {
    return Math.floor(Date.now() / WEEK_MS);
  }

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

  // Score chips. Updating textContent only when the value actually changes
  // avoids forcing a layout pass every tick. aria-label is kept in sync so
  // screen readers announce "Score 120" rather than reading the CSS
  // generated "SCORE" label inconsistently (some readers do, some don't).
  var scoresContainerEl = document.querySelector(".scores-container");
  var scoreEl = document.querySelector(".score-container");
  var bestEl = document.querySelector(".best-container");
  function setScore(n) {
    var text = String(n);
    if (scoreEl.firstChild && scoreEl.firstChild.nodeType === 3) {
      if (scoreEl.firstChild.nodeValue !== text) scoreEl.firstChild.nodeValue = text;
    } else {
      scoreEl.textContent = text;
    }
    scoreEl.setAttribute("aria-label", "Score " + text);
  }
  function setBest(n) {
    var text = String(n);
    if (bestEl.firstChild && bestEl.firstChild.nodeType === 3) {
      if (bestEl.firstChild.nodeValue !== text) bestEl.firstChild.nodeValue = text;
    } else {
      bestEl.textContent = text;
    }
    bestEl.setAttribute("aria-label", "Best " + text);
  }

  // Game-state overlay (idle/paused/over). Setting `data-state` lets the
  // CSS show the correct button (Start vs Resume vs Try again) without JS
  // having to manage button visibility imperatively.
  var overlayEl = document.querySelector(".game-message");
  var overlayTextEl = document.querySelector(".game-message-text");
  var communityNoteEl = document.querySelector(".community-note");
  function setOverlay(state) {
    overlayEl.setAttribute("data-state", state);
    // Community note only applies to game-over; clear when leaving that
    // state so a restarted game doesn't carry stale text into the next
    // idle/over cycle.
    if (state !== "over") communityNoteEl.textContent = "";
    if (state === "playing") {
      overlayEl.classList.remove("visible");
      return;
    }
    overlayEl.classList.add("visible");
    if (state === "idle") overlayTextEl.textContent = IDLE_TEXT;
    else if (state === "paused") overlayTextEl.textContent = "PAUSED";
    else if (state === "over") overlayTextEl.textContent = "GAME OVER";
  }

  // Decorates the game-over overlay with a community-context line. Async
  // because aggregate.count is a bridge round-trip; if the player restarts
  // before it resolves we drop the result (gated on the overlay still
  // showing 'over'). All failures are silent — the community note is a
  // nice-to-have, not load-bearing.
  function fetchCommunityNote(score) {
    if (score < COMMUNITY_MIN_SCORE) return;
    if (!OR.aggregate || !OR.aggregate.count) return;
    var band = scoreBand(score);
    var key = "weekly-score-" + currentWeek();
    try {
      OR.aggregate
        .count(key, "band-" + band)
        .then(function (count) {
          if (overlayEl.getAttribute("data-state") !== "over") return;
          if (count == null) {
            communityNoteEl.textContent =
              "Community stats unlock once a few more players finish a run.";
          } else {
            communityNoteEl.textContent =
              count.toLocaleString() + " players reached the " + band + " range this week.";
          }
        })
        .catch(noop);
    } catch (_) {}
  }

  OR.whenReady()
    .then(function () { return storage.hydrate(); })
    .then(function () {
      // The share-once flag is page-load scoped: even if the player beats
      // their best three times in one session, only the first new-best fires
      // a share to avoid spamming the share sheet. Resets on reload.
      var sharedThisLoad = false;

      var canvas = document.querySelector(".game-canvas");
      var renderer = new SnakeRenderer(canvas);
      var input = new SnakeInputManager();

      var game = new SnakeGame({
        renderer: renderer,
        storage: storage,
        input: input,
        listener: {
          onState: function (state) { setOverlay(state); },
          onScore: function (score) { setScore(score); },
          onBest: function (best) { setBest(best); },
          onAte: function () {
            // Light haptic per food. Same level 2048 uses for tile-merge —
            // present but not buzzy enough to fatigue on a long run.
            try { OR.actions.haptic("light").catch(noop); } catch (_) {}
          },
          onAteBonus: function () {
            // Medium haptic distinguishes a bonus carrot from a regular one
            // — same level used elsewhere for "got something good" feedback,
            // a step up from the per-food light tap without claiming the
            // success haptic reserved for personal bests.
            try { OR.actions.haptic("medium").catch(noop); } catch (_) {}
          },
          onGameOver: function (info) {
            try { OR.actions.haptic("error").catch(noop); } catch (_) {}
            if (info.isNewBest && info.score >= SHARE_MIN_SCORE && !sharedThisLoad) {
              sharedThisLoad = true;
              try {
                OR.actions.share({
                  title: "Snake",
                  text: "New high score: " + info.score + "!\n\nPlay at " + LANDING_URL,
                }).catch(noop);
              } catch (_) {}
              // success haptic is reserved for genuine personal-best moments
              // — distinct from the per-food light haptic so the player
              // *feels* the achievement.
              try { OR.actions.haptic("success").catch(noop); } catch (_) {}
            }
            // Aggregate-driven community line on the game-over overlay.
            // Fire-and-decorate: don't await before showing GAME OVER (the
            // overlay flips synchronously via onState above).
            fetchCommunityNote(info.score);
          },
        },
      });

      // Auto-pause when the host signals the app went to background. Mobile
      // users tabbing away or backgrounding the app would otherwise come
      // back to a snake that crashed into a wall while they were gone.
      try {
        OR.lifecycle.on("pause", function () { game.pause(); });
      } catch (_) {}

      setBest(storage.getBest());
      // Reveal the score chips only after the hydrated best is written so
      // a returning player doesn't see "0 → 540" flash on first paint.
      scoresContainerEl.classList.add("ready");
      window.requestAnimationFrame(function () {
        game.boot();
        try { OR.ready(); } catch (_) {}
      });
    })
    .catch(function (err) {
      console.error("snake: bootstrap failed", err);
      showFatalError("Couldn't start the game. Try reloading the page.");
    });
})();

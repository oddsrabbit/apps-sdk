// Bootstrap. Mirrors snake/js/application.js: wait for the OddsRabbit
// bridge, hydrate the best score, construct game/renderer/input, then call
// OR.ready() so the host can hide its skeleton. The match-3-specific bits
// are the timer bar wiring and the swap-driven first-tick start.

(function () {
  var LANDING_URL = "https://www.oddsrabbit.com/games/match3/";

  var IS_TOUCH = (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0)
    || ("ontouchstart" in window);
  var IDLE_TEXT = IS_TOUCH ? "TAP OR SWIPE A FRUIT" : "CLICK A FRUIT TO START";

  var OR = window.OddsRabbit;
  if (!OR) {
    console.error("match3: OddsRabbit bridge not available — game requires the SDK host.");
    showFatalError("This game needs to run inside the OddsRabbit app or website.");
    return;
  }

  var storage = new Match3StorageManager();

  // Procedural audio (js/sound_manager.js). Constructed up front but stays
  // silent until resume() runs inside the first user gesture — browsers keep
  // the AudioContext suspended otherwise. All play* calls are no-ops while
  // muted / suspended, so the listener handlers below never need to guard.
  var sound = new Match3SoundManager();
  var MUTED_KEY = "soundMuted";

  function noop() {}

  // Score submission ---------------------------------------------------
  // Two boards, both read back by js/leaderboard.js: an all-time best under the
  // constant "highscore" round, and this month's best under "month-YYYY-MM".
  // Both use keepBest, so the server keeps the max under a key that is written
  // more than once — without it the second submit of a rising best would reject
  // as already-submitted and freeze the player's row at their first score.
  var ROUNDS = window.Match3Rounds;

  // Whether a score submission is worth attempting at all.
  //
  // Guests are excluded, and that exclusion is NOT deferred: the endpoint needs
  // a signed-in user, and while `user` is null the host serves storage.* from
  // this origin's localStorage instead of the per-user server store. A
  // "submitted" marker written as a guest would sit in a namespace the signed-in
  // session never reads — dead weight rather than a score credited later.
  //
  // The capability check reflects what this host has already proven: the SDK
  // retires a verb the host rejects as unknown, so after one such rejection we
  // stop trying. It is guarded because sdk-v1.js is deployed separately and may
  // predate it.
  function canSubmitScores() {
    if (!OR.user || !OR.scores || typeof OR.scores.submit !== "function") return false;
    try {
      if (OR.capabilities && typeof OR.capabilities.has === "function") {
        return OR.capabilities.has("scores.submit");
      }
    } catch (_) {}
    return true;
  }

  // A failed submit is recoverable by design — the marker stays behind and the
  // next trigger retries — which is exactly why it needs a log: a host that
  // rejects EVERY submit is otherwise indistinguishable, from the outside, from
  // one where everything landed. Nothing user-facing: the player has no action
  // to take, and the retry is already running.
  function warnSubmitFailed(roundKey, err) {
    try { console.warn("match3: score submit failed for " + roundKey, err); } catch (_) {}
  }

  // Submit whatever the platform hasn't confirmed yet, for both rounds.
  //
  // WHY THE MARKERS. A submit that never lands used to be unrecoverable in the
  // games that just fired and forgot: the best score lives on in local storage,
  // but nothing remembers that the server never got it, so the row stays missing
  // until the player beats their own best again — which, for a good run, may be
  // never. Storage records what the platform CONFIRMED (on a resolved submit
  // only), so any gap between that and the real best is retried here on the next
  // load, the next game over, and the next background AND foreground — the four
  // moments this is called. A rejection leaves the marker behind and simply
  // retries later; over-retrying costs one deduped request, under-retrying costs
  // a player their place on the board.
  //
  // In-flight flags rather than a queue: these are idempotent keepBest upserts,
  // so a dropped attempt loses nothing that the next call doesn't redo, and two
  // concurrent submits of the same round would only race each other's markers.
  // A score beaten WHILE its submit is in flight is therefore skipped here and
  // picked up by the re-entrant call each success makes — which terminates
  // immediately once the markers match the stored bests. Only successes recurse;
  // a failure must wait for the next real trigger, or a host that always rejects
  // would spin.
  var bestSubmitInFlight = false;
  var monthSubmitInFlight = false;
  function submitBests() {
    if (!ROUNDS || !canSubmitScores()) return;

    var best = storage.getBest();
    if (best > 0 && best > storage.getSubmittedBest() && !bestSubmitInFlight) {
      bestSubmitInFlight = true;
      try {
        OR.scores
          .submit({
            roundKey: ROUNDS.HIGHSCORE,
            score: best,
            keepBest: true,
            metadata: { best: true }
          })
          .then(function () {
            bestSubmitInFlight = false;
            storage.markBestSubmitted(best);
            submitBests();
          })
          .catch(function (err) {
            bestSubmitInFlight = false;
            warnSubmitFailed(ROUNDS.HIGHSCORE, err);
          });
      } catch (err) {
        bestSubmitInFlight = false;
        warnSubmitFailed(ROUNDS.HIGHSCORE, err);
      }
    }

    // Resolved per call so a session left open across UTC midnight on the 1st
    // starts writing to the new month's key on its next run, rather than topping
    // up a board the modal has already stopped showing.
    var period = ROUNDS.currentPeriod();
    var monthBest = storage.getMonthBest(period);
    if (monthBest > 0 && monthBest > storage.getSubmittedMonthBest(period) && !monthSubmitInFlight) {
      monthSubmitInFlight = true;
      try {
        OR.scores
          .submit({
            roundKey: ROUNDS.monthRoundKey(period),
            score: monthBest,
            keepBest: true,
            metadata: { period: period }
          })
          .then(function () {
            monthSubmitInFlight = false;
            storage.markMonthBestSubmitted(monthBest, period);
            submitBests();
          })
          .catch(function (err) {
            monthSubmitInFlight = false;
            warnSubmitFailed(ROUNDS.monthRoundKey(period), err);
          });
      } catch (err) {
        monthSubmitInFlight = false;
        warnSubmitFailed(ROUNDS.monthRoundKey(period), err);
      }
    }
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

  // Score / best chips ------------------------------------------------
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

  // Stage banner ------------------------------------------------------
  // Fires once per stage transition (2→3, 3→4, etc.) and also re-used
  // for the SHUFFLE notice when the engine recovers from a no-moves
  // deadlock. Bigger + more central than the combo banner because both
  // events are rare and carry information the player needs to read.
  //
  // When a stage banner fires we also (a) flash the board (parallel
  // radial-glow element) and (b) immediately hide the combo banner —
  // a long cascade can naturally trigger a stage-up, and we don't want
  // the combo banner sitting at top:14% drawing the eye away from the
  // centered stage banner.
  var stageBannerEl = document.querySelector(".stage-banner");
  var stageFlashEl = document.querySelector(".stage-flash");
  var stageHideHandle = null;
  function showStageBanner(text) {
    if (!stageBannerEl) return;
    stageBannerEl.textContent = text;
    stageBannerEl.classList.add("visible");
    stageBannerEl.classList.remove("bump");
    void stageBannerEl.offsetWidth;
    stageBannerEl.classList.add("bump");

    // Parallel flash. Restart the keyframe by toggling the class to
    // handle back-to-back banners (rare, but possible if a shuffle
    // happens right after a stage-up).
    if (stageFlashEl) {
      stageFlashEl.classList.remove("flash");
      void stageFlashEl.offsetWidth;
      stageFlashEl.classList.add("flash");
    }

    // Push the combo banner out of the way so the stage banner owns
    // the visual moment.
    if (comboBannerEl) {
      comboBannerEl.classList.remove("visible");
      comboBannerEl.classList.remove("bump");
      if (comboHideHandle) window.clearTimeout(comboHideHandle);
    }

    if (stageHideHandle) window.clearTimeout(stageHideHandle);
    stageHideHandle = window.setTimeout(function () {
      stageBannerEl.classList.remove("visible");
      stageBannerEl.classList.remove("bump");
    }, 2000);
  }
  function showStage(info) {
    var text = "STAGE " + info.id;
    if (info.label) text += " — " + info.label;
    showStageBanner(text);
  }
  function showShuffle() {
    // Reuses the stage banner's visual treatment — same scale, same
    // attention-grabbing flash — so the player understands "something
    // important just happened to the board" without a new mental
    // category to learn. Names the cause ("no moves") so the rearranging
    // board doesn't read as a glitch — the player sees why it happened.
    showStageBanner("NO MOVES — SHUFFLING");
  }

  // Combo banner ------------------------------------------------------
  // Shows "COMBO ×N!" briefly on each cascade ≥2. Reuses the same element
  // so a rapid chain visually escalates (×2 → ×3 → ×4) rather than
  // stacking duplicate banners. Timeout extends on each new bump.
  var comboBannerEl = document.querySelector(".combo-banner");
  var comboHideHandle = null;
  function showCombo(mult, roundPts) {
    if (!comboBannerEl) return;
    comboBannerEl.textContent = "COMBO ×" + mult + "! +" + roundPts;
    comboBannerEl.classList.add("visible");
    // Bump animation: removing and re-adding the class restarts the
    // CSS keyframe so each new combo visibly punches in even if the
    // banner was still showing from the previous bump.
    comboBannerEl.classList.remove("bump");
    // Force reflow before re-adding so the keyframe restarts.
    void comboBannerEl.offsetWidth;
    comboBannerEl.classList.add("bump");
    if (comboHideHandle) window.clearTimeout(comboHideHandle);
    comboHideHandle = window.setTimeout(function () {
      comboBannerEl.classList.remove("visible");
      comboBannerEl.classList.remove("bump");
    }, 1200);
  }

  // Timer bar ---------------------------------------------------------
  // Width tracks remaining time; hue drifts from green → red as the bar
  // empties so the urgency cue is colour + width, not width alone. The
  // speed indicator surfaces the score-driven drain multiplier — without
  // it, bonus seconds at high scores feel mysteriously short ("I bought
  // +5s but only got ~1.5s back" at score 9000, drain ×4).
  var timerFillEl = document.querySelector(".timer-fill");
  var timerSpeedEl = document.querySelector(".timer-speed");
  function setTimer(remaining, total, drainRate) {
    if (!timerFillEl) return;
    var ratio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
    timerFillEl.style.width = (ratio * 100).toFixed(1) + "%";
    // HSL 120 (green) → 0 (red). Saturation/lightness fixed.
    var hue = Math.round(120 * ratio);
    timerFillEl.style.background = "hsl(" + hue + ", 70%, 48%)";
    if (timerSpeedEl) {
      // Threshold at 1.1× — below that the speed-up is imperceptible and
      // the badge would just be visual noise from the moment scoring starts.
      if (drainRate && drainRate >= 1.1) {
        timerSpeedEl.textContent = "×" + drainRate.toFixed(1);
        timerSpeedEl.classList.add("visible");
      } else {
        timerSpeedEl.classList.remove("visible");
      }
    }
  }

  // Overlay -----------------------------------------------------------
  var overlayEl = document.querySelector(".game-message");
  var overlayTextEl = document.querySelector(".game-message-text");
  var newBestNoteEl = document.querySelector(".new-best-note");
  var finalScoreEl = document.querySelector(".final-score");
  var shareButtonEl = document.querySelector(".share-button");
  var restartButtonEl = document.querySelector(".restart-button");
  function setOverlay(state) {
    overlayEl.setAttribute("data-state", state);
    if (state !== "over") {
      newBestNoteEl.textContent = "";
      finalScoreEl.textContent = "";
    }
    // Hide the top-right "New Game" button while actively playing — too
    // easy to thumb-graze on mobile and instantly nuke a good run with no
    // confirm. Players who want a fresh board mid-run can pause first.
    if (restartButtonEl) restartButtonEl.hidden = (state === "playing");
    if (state === "playing") {
      overlayEl.classList.remove("visible");
      return;
    }
    overlayEl.classList.add("visible");
    if (state === "idle") overlayTextEl.textContent = IDLE_TEXT;
    else if (state === "paused") overlayTextEl.textContent = "PAUSED";
    else if (state === "over") overlayTextEl.textContent = "TIME'S UP";
  }

  // -------- Share modal --------
  // User-initiated only. Ported from snake/js/application.js with the title
  // and landing URL swapped. The whole modal is built imperatively rather
  // than via a hidden template so a partial bundle (e.g. CDN race) never
  // leaves an empty dialog behind.
  var IS_TOUCH_DEVICE = IS_TOUCH;

  function buildShareTitle(result) {
    return result.isNewBest
      ? "Fruit Match — new high score: " + result.score
      : "Fruit Match — score: " + result.score;
  }

  function buildShareText(result) {
    return buildShareTitle(result) + "\n\nPlay at " + LANDING_URL;
  }

  function showShareModal(result) {
    var title = buildShareTitle(result);
    var text = buildShareText(result);
    var supportsNativeShare = IS_TOUCH_DEVICE && typeof navigator.share === "function";

    var backdrop = document.createElement("div");
    backdrop.className = "share-modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "share-modal-title");

    var nativeBtn = supportsNativeShare
      ? '<button type="button" class="share-action" data-action="native">Share via apps…</button>'
      : "";

    backdrop.innerHTML =
      '<div class="share-modal">' +
        '<h2 id="share-modal-title">Share your result</h2>' +
        '<div class="share-preview">' + escapeHtml(text) + '</div>' +
        '<button type="button" class="share-action" data-action="copy">Copy result</button>' +
        nativeBtn +
        '<div class="share-section-label">Share to social</div>' +
        '<div class="share-buttons">' +
          '<button type="button" class="share-button-social" data-action="twitter" aria-label="Share to X">X</button>' +
          '<button type="button" class="share-button-social" data-action="threads" aria-label="Share to Threads">Threads</button>' +
          '<button type="button" class="share-button-social" data-action="bluesky" aria-label="Share to Bluesky">Bluesky</button>' +
          '<button type="button" class="share-button-social" data-action="reddit" aria-label="Share to Reddit">Reddit</button>' +
          '<button type="button" class="share-button-social" data-action="whatsapp" aria-label="Share to WhatsApp">WhatsApp</button>' +
          '<button type="button" class="share-button-social" data-action="facebook" aria-label="Share to Facebook">Facebook</button>' +
        '</div>' +
        '<button type="button" class="share-action" data-action="close">Close</button>' +
      '</div>';

    document.body.appendChild(backdrop);

    function close() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);

    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) close();
    });

    backdrop.addEventListener("click", function (e) {
      var target = e.target;
      if (!target || !target.dataset || !target.dataset.action) return;
      runShareAction(target.dataset.action, title, text, close);
    });
  }

  function runShareAction(action, title, text, close) {
    switch (action) {
      case "close":
        close();
        return;
      case "copy":
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            function () { showToast("Copied to clipboard"); },
            function () { showToast("Could not copy"); }
          );
        } else {
          showToast("Could not copy");
        }
        return;
      case "native":
        try {
          OR.actions
            .share({ title: "Fruit Match", text: text })
            .catch(function () { showToast("Could not share"); });
        } catch (_) {
          showToast("Could not share");
        }
        return;
      case "twitter":
        openShareUrl("https://x.com/intent/post?text=" + encodeURIComponent(text));
        return;
      case "threads":
        openShareUrl("https://www.threads.net/intent/post?text=" + encodeURIComponent(text));
        return;
      case "bluesky":
        openShareUrl("https://bsky.app/intent/compose?text=" + encodeURIComponent(text));
        return;
      case "reddit":
        openShareUrl(
          "https://www.reddit.com/submit?url=" + encodeURIComponent(LANDING_URL) +
          "&title=" + encodeURIComponent(title)
        );
        return;
      case "whatsapp":
        openShareUrl("https://wa.me/?text=" + encodeURIComponent(text));
        return;
      case "facebook":
        openShareUrl(
          "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(LANDING_URL)
        );
        return;
    }
  }

  function openShareUrl(url) {
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showToast(message) {
    var existing = document.querySelector(".toast");
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "alert");
    toast.textContent = message;
    document.body.appendChild(toast);

    window.requestAnimationFrame(function () { toast.classList.add("toast-show"); });

    window.setTimeout(function () {
      toast.classList.remove("toast-show");
      window.setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 1500);
  }

  // Bootstrap ---------------------------------------------------------
  OR.whenReady()
    .then(function () { return storage.hydrate(); })
    .then(function () {
      var lastResult = null;

      shareButtonEl.addEventListener("click", function () {
        if (!lastResult) return;
        showShareModal(lastResult);
      });

      var canvas = document.querySelector(".game-canvas");
      var renderer = new Match3Renderer(canvas);
      var input = new Match3InputManager(canvas);

      var game = new Match3Game({
        renderer: renderer,
        storage: storage,
        input: input,
        listener: {
          onState: function (state) { setOverlay(state); },
          onScore: function (score) { setScore(score); },
          onBest: function (best) { setBest(best); },
          onTimer: function (remaining, total, drainRate) { setTimer(remaining, total, drainRate); },
          onSwap: function () {
            // Soft click the instant a swap is committed (before we know if
            // it matches). Pairs with the match pop / invalid thud that
            // follows once the board resolves.
            sound.swap();
          },
          onInvalidSwap: function () {
            sound.invalidSwap();
          },
          onMatch: function (clusters, combo) {
            // Match pop. Pitch scales with the longest cluster cleared this
            // resolve step and with the cascade depth, so a chain walks up
            // the scale. (Bomb sweeps arrive as a single big-length cluster.)
            var maxLen = 0;
            for (var i = 0; i < clusters.length; i++) {
              if (clusters[i].length > maxLen) maxLen = clusters[i].length;
            }
            sound.match(maxLen, combo);
            // Light haptic per match. A long cascade fires once per resolve
            // step rather than once per cluster — feels like a chain rather
            // than a buzzer.
            try { OR.actions.haptic("light").catch(noop); } catch (_) {}
            // Promote the haptic intensity for big clears (5+ tiles).
            if (maxLen >= 5) {
              try { OR.actions.haptic("medium").catch(noop); } catch (_) {}
            }
          },
          onCombo: function (mult, roundPts) {
            showCombo(mult, roundPts);
            sound.combo(mult);
            // Medium haptic on every combo step — a chain physically
            // building feels right. Higher combos already trigger a
            // bigger screen shake (handled in game.js).
            try { OR.actions.haptic("medium").catch(noop); } catch (_) {}
          },
          onStage: function (info) {
            showStage(info);
            sound.stage();
            // Success haptic on stage-up — reused from new-best because
            // both events are "you cleared a milestone" moments. Higher
            // intensity than combos so the player feels the difference
            // between "good chain" and "you advanced".
            try { OR.actions.haptic("success").catch(noop); } catch (_) {}
          },
          onShuffle: function () {
            showShuffle();
            sound.shuffle();
            // Medium haptic — same "something rearranged on the board"
            // weight as a combo, lower than stage-up because shuffle is
            // a rescue rather than an achievement.
            try { OR.actions.haptic("medium").catch(noop); } catch (_) {}
          },
          onGameOver: function (info) {
            // New-best gets its own celebratory jingle (below); a normal
            // run-end gets the falling "time's up" tone.
            if (!info.isNewBest) sound.gameOver();
            try { OR.actions.haptic("error").catch(noop); } catch (_) {}
            lastResult = { score: info.score, isNewBest: info.isNewBest };
            finalScoreEl.textContent = "Score: " + info.score;
            // setOverlay("over") already painted "TIME'S UP"; override
            // when the end was actually a deadlocked board so the player
            // doesn't wonder why TIME'S UP appeared with seconds on the bar.
            if (info.reason === "noMoves") {
              overlayTextEl.textContent = "NO MOVES LEFT";
            }
            if (info.isNewBest) {
              newBestNoteEl.textContent = "NEW BEST!";
              sound.newBest();
              try { OR.actions.haptic("success").catch(noop); } catch (_) {}
            }
            // Every run is a candidate for the monthly board, not just an
            // all-time best: a player who peaked in March can still top this
            // month with a score well under their own record. game.js already
            // stored the all-time best (it owns that comparison); this stores
            // the month's, and submitBests() sends whichever of the two the
            // platform is now behind on.
            storage.recordMonthScore(info.score);
            submitBests();
          },
        },
      });

      // Opening the leaderboard mid-run must not cost the player time: the
      // timer drains while a modal covers the board, and the top-row button
      // stays tappable during a run (unlike New Game, which is hidden because a
      // stray tap there is unrecoverable). js/leaderboard.js calls this before
      // it opens the modal — a no-op unless a run is actually in progress, so
      // the idle and game-over entry points are unaffected. Deliberately not a
      // resume: the player closes the board when they're ready, and the paused
      // overlay behind it already offers Resume.
      window.Match3PauseForModal = function () { game.pause(); };

      // Auto-pause when the host backgrounds the app, same as snake. Match-3
      // is less time-pressured than snake but the timer still drains, so a
      // backgrounded run would silently game-over.
      try {
        OR.lifecycle.on("pause", function () {
          game.pause();
          // Also a retry point for anything the platform hasn't confirmed —
          // covers a player who set a score and backgrounded the app before the
          // first attempt landed, which on a flaky connection is exactly when it
          // didn't. No-op when both markers are current.
          submitBests();
        });
        // And retry on the way back in. `pause` is the WORST moment to be
        // depending on: the app is being backgrounded, often because the player
        // walked out of range, so that attempt is the one most likely to fail —
        // and the next trigger after it is a whole game away, or a whole app
        // launch away. `resume` is when the connection has typically come back,
        // and it costs nothing when the markers are already current.
        //
        // Deliberately does NOT unpause the run: the auto-pause above exists so
        // a backgrounded game doesn't silently time out, and resuming it for a
        // player who isn't looking at the board yet would throw that away.
        OR.lifecycle.on("resume", function () {
          submitBests();
        });
      } catch (_) {}

      // Sound: unlock + mute toggle ----------------------------------
      // Browsers keep the AudioContext suspended until a user gesture, so
      // resume() on the first pointer/key event. once:true tears the
      // listeners down after the first hit; capture so we see the gesture
      // even when the canvas handlers stopPropagation.
      function unlockAudio() { sound.resume(); }
      var unlockOpts = { once: true, capture: true };
      document.addEventListener("pointerdown", unlockAudio, unlockOpts);
      document.addEventListener("touchstart", unlockAudio, unlockOpts);
      document.addEventListener("keydown", unlockAudio, unlockOpts);

      var soundToggleEl = document.querySelector(".sound-toggle");
      function paintSoundToggle() {
        if (!soundToggleEl) return;
        var muted = sound.isMuted();
        soundToggleEl.textContent = muted ? "🔇" : "🔊";
        soundToggleEl.setAttribute("aria-pressed", muted ? "true" : "false");
        soundToggleEl.setAttribute("aria-label", muted ? "Unmute sound" : "Mute sound");
      }
      // Hydrate the saved preference, then paint. Defaults to unmuted on any
      // read failure (the safer default for a brand-new player who hasn't
      // expressed a choice yet).
      if (OR.storage && OR.storage.get) {
        OR.storage.get(MUTED_KEY)
          .then(function (raw) { sound.setMuted(raw === "1"); })
          .catch(noop)
          .then(paintSoundToggle);
      } else {
        paintSoundToggle();
      }
      if (soundToggleEl) {
        soundToggleEl.addEventListener("click", function () {
          // A click is a gesture — make sure the context is live so the
          // unmute is immediately audible on the very next event.
          sound.resume();
          var muted = sound.toggleMute();
          paintSoundToggle();
          if (OR.storage && OR.storage.set) {
            OR.storage.set(MUTED_KEY, muted ? "1" : "0").catch(noop);
          }
        });
      }

      // Tap-anywhere-to-start on the idle overlay. The overlay sits on top of
      // the board (z-index 100), so a player following the "CLICK A FRUIT TO
      // START" hint taps the covered board and nothing happens — the only live
      // control is the Start button. Make the whole idle overlay a start
      // target so that instinct works, while keeping the Start button.
      //
      // Routes through input.emit("toggle"), the exact event the Start button
      // fires (see input_manager _bindButton), so idle → playing goes through
      // one code path. Guards:
      //   - idle only: in paused/over the overlay shows Resume / Try again +
      //     Share, where a stray background tap must NOT start or restart.
      //   - button taps are skipped here: the Start button's own handler calls
      //     stopPropagation so its tap never reaches this listener, but the
      //     closest("button") check keeps that intent explicit and survives
      //     any future button that forgets to stop propagation.
      // click + touchend mirror _bindButton; preventDefault on touchend
      // suppresses the synthesized ghost click so a touch tap toggles once.
      function onIdleOverlayActivate(e) {
        if (overlayEl.getAttribute("data-state") !== "idle") return;
        if (e.target.closest && e.target.closest("button")) return;
        e.preventDefault();
        sound.resume();
        input.emit("toggle");
      }
      overlayEl.addEventListener("click", onIdleOverlayActivate);
      overlayEl.addEventListener("touchend", onIdleOverlayActivate);

      // Responsive canvas — keep the internal pixel size in sync with the
      // CSS-computed display size. Resize fires on rotation + window resize
      // + the host iframe being resized.
      function syncCanvas() {
        renderer.resize(8, 8);
      }
      window.addEventListener("resize", syncCanvas);
      window.addEventListener("orientationchange", syncCanvas);

      setBest(storage.getBest());
      // Boot-time retry: hydrate has just told us what the platform confirmed,
      // so anything scored on a previous load that never landed goes now. Also
      // the path that backfills a player whose best predates this game having a
      // leaderboard at all — their stored best has no marker, so it submits once
      // and is marked.
      submitBests();
      var initialTimer = (window.Match3Game && window.Match3Game.TIMER_START) || 120;
      setTimer(initialTimer, initialTimer, 1);
      scoresContainerEl.classList.add("ready");

      window.requestAnimationFrame(function () {
        syncCanvas();
        game.boot();
        try { OR.ready(); } catch (_) {}
      });
    })
    .catch(function (err) {
      console.error("match3: bootstrap failed", err);
      showFatalError("Couldn't start the game. Try reloading the page.");
    });
})();

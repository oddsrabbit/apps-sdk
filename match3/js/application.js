// Bootstrap. Mirrors snake/js/application.js: wait for the OddsRabbit
// bridge, hydrate the best score, construct game/renderer/input, then call
// OR.ready() so the host can hide its skeleton. The match-3-specific bits
// are the timer bar wiring and the swap-driven first-tick start.

(function () {
  var LANDING_URL = "https://www.oddsrabbit.com/games/match3/";
  // Floor below which the community note is suppressed — at sub-100 scores
  // the player is just learning the swap mechanic and the leaderboard line
  // adds noise rather than signal.
  var COMMUNITY_MIN_SCORE = 100;
  var WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

  // Coarse score bands. Same shape as snake's, scaled for the much larger
  // match-3 score range. Coarse bands keep each bucket densely populated
  // so the weekly community readout has meaningful counts to compare.
  function scoreBand(score) {
    if (score < 200) return "0-199";
    if (score < 500) return "200-499";
    if (score < 1000) return "500-999";
    if (score < 2000) return "1000-1999";
    return "2000+";
  }

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
  var communityNoteEl = document.querySelector(".community-note");
  var newBestNoteEl = document.querySelector(".new-best-note");
  var finalScoreEl = document.querySelector(".final-score");
  var shareButtonEl = document.querySelector(".share-button");
  var restartButtonEl = document.querySelector(".restart-button");
  function setOverlay(state) {
    overlayEl.setAttribute("data-state", state);
    if (state !== "over") {
      communityNoteEl.textContent = "";
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

  // Community note ----------------------------------------------------
  // High-water-mark dedup: each band counts at most once per player per
  // week. A player who hits "200-499" then later "1000-1999" registers in
  // both (matches the "reached the X range" wording — they did reach both).
  // A player who replays in the same band doesn't double-count. We store
  // the set of already-counted bands as a CSV under "counted-bands-<W>"
  // because there's no decrement on the aggregate API and band names
  // happen to contain no commas.
  function renderCommunityCount(count, band) {
    if (overlayEl.getAttribute("data-state") !== "over") return;
    if (count == null) {
      communityNoteEl.textContent =
        "Community stats unlock once a few more players finish a run.";
    } else {
      communityNoteEl.textContent =
        count.toLocaleString() + " players reached the " + band + " range this week.";
    }
  }

  function fetchCommunityNote(score) {
    if (score < COMMUNITY_MIN_SCORE) return;
    if (!OR.aggregate || !OR.aggregate.count) return;
    var band = scoreBand(score);
    var week = currentWeek();
    var aggregateKey = "weekly-score-" + week;
    var bucket = "band-" + band;
    var dedupKey = "counted-bands-" + week;

    var storageGet = OR.storage && OR.storage.get
      ? OR.storage.get(dedupKey).catch(function () { return null; })
      : Promise.resolve(null);

    storageGet.then(function (raw) {
      var counted = raw ? String(raw).split(",") : [];
      var already = counted.indexOf(band) >= 0;

      if (already) {
        // Already in this band this week — read without bumping. If the
        // host doesn't expose .read, fall through to a null count (renders
        // the "unlock once more players finish" copy, which is the safer
        // failure than re-counting).
        if (OR.aggregate.read) {
          return OR.aggregate.read(aggregateKey, bucket).catch(function () { return null; });
        }
        return null;
      }

      // First finish in this band this week: count + persist the new band.
      counted.push(band);
      if (OR.storage && OR.storage.set) {
        OR.storage.set(dedupKey, counted.join(",")).catch(noop);
      }
      return OR.aggregate.count(aggregateKey, bucket).catch(function () { return null; });
    }).then(function (count) {
      renderCommunityCount(count, band);
    }).catch(noop);
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
            fetchCommunityNote(info.score);
          },
        },
      });

      // Auto-pause when the host backgrounds the app, same as snake. Match-3
      // is less time-pressured than snake but the timer still drains, so a
      // backgrounded run would silently game-over.
      try {
        OR.lifecycle.on("pause", function () { game.pause(); });
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

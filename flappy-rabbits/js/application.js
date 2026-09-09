// Bootstrap. Mirrors the shape of the other arcade games: wait for the
// OddsRabbit bridge to deliver init, hydrate the persisted bests, construct
// game/renderer/input/sound, then call OR.ready() so the host can hide its
// loading skeleton.
//
// Two things are specific to this game. The pause button, which it needs
// because every tap on the board is a hop and pausing therefore can't share
// the tap — and which setOverlay hides outside a live run, since it sits over
// the picture. And the layout: the scene is full-bleed, so the chips and the
// controls float over the canvas and every word of text lives on the overlay,
// which is why every string here is short enough to survive on one.
//
// The game ships as "Flappy Rabbits" under the slug `flappy-rabbits`. It was
// developed under the working slug `hop`, and the code identifiers (HopGame,
// HopRenderer, window.HopRounds, the `hop:` log prefix) deliberately kept the
// short name — see README.md.

(function () {
  var LANDING_URL = "https://www.oddsrabbit.com/games/flappy-rabbits/";

  // `maxTouchPoints` is the modern signal and handles desktops with
  // touchscreens correctly; `ontouchstart` is the fallback for engines that
  // don't report it. Either being truthy means we prefer tap wording.
  var IS_TOUCH = (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0)
    || ("ontouchstart" in window);
  // Short on purpose. This sits on the full-screen idle overlay in Press
  // Start 2P, whose advance is a full em per character: "PRESS SPACE TO HOP"
  // wraps to three ragged lines on a phone, and the same instruction is spelt
  // out in full in the how-to line below it either way.
  var IDLE_TEXT = IS_TOUCH ? "TAP TO HOP" : "SPACE TO HOP";

  var OR = window.OddsRabbit;
  if (!OR) {
    console.error("hop: OddsRabbit bridge not available — game requires the SDK host.");
    showFatalError("This game needs to run inside the OddsRabbit app or website.");
    return;
  }

  var storage = new HopStorageManager();
  var sound = new HopSoundManager();
  var ROUNDS = window.HopRounds;

  function noop() {}

  // -------- score submission --------
  // Two boards, both read back by js/leaderboard.js: an all-time best under the
  // constant "highscore" round, and this month's best under "month-YYYY-MM".
  // Both use keepBest, so the server keeps the max under a key that is written
  // more than once — without it the second submit of a rising best would reject
  // as already-submitted and freeze the player's row at their first score.

  // Whether a submission is worth attempting at all.
  //
  // Guests are excluded, and that exclusion is NOT deferred: the endpoint needs
  // a signed-in user, and while `user` is null the host serves storage.* from
  // this origin's localStorage rather than the per-user server store. A
  // "submitted" marker written as a guest would sit in a namespace the
  // signed-in session never reads — dead weight rather than a score credited
  // later.
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
  // to take and the retry is already running.
  function warnSubmitFailed(roundKey, err) {
    try { console.warn("hop: score submit failed for " + roundKey, err); } catch (_) {}
  }

  // Submit whatever the platform hasn't confirmed yet, for both rounds.
  //
  // WHY THE MARKERS. A submit that never lands would otherwise be
  // unrecoverable: the best score lives on in storage, but nothing remembers
  // that the server never got it, so the player's row stays missing until they
  // beat their own best again — which, after a good run, may be never. Storage
  // records what the platform CONFIRMED (on a resolved submit only), so any gap
  // between that and the real best is retried at the four moments this is
  // called: load, game over, background, and foreground.
  //
  // In-flight flags rather than a queue: these are idempotent keepBest upserts,
  // so a dropped attempt loses nothing the next call doesn't redo. A score
  // beaten WHILE its submit is in flight is skipped here and picked up by the
  // re-entrant call each success makes, which terminates as soon as the markers
  // match the stored bests. Only successes recurse; a failure waits for the
  // next real trigger, or a host that always rejects would spin.
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
    // starts writing to the new month's key on its next run, rather than
    // topping up a board the modal has already stopped showing.
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
    // Appended to the body, not to a wrapper: the layout is full-bleed and the
    // canvas has no sized container to insert above. The banner is fixed and
    // centred in CSS, which also means it works before the renderer has sized
    // anything — the case this exists for.
    document.body.appendChild(banner);
  }

  // -------- score chips --------
  // Updating the text node only when the value actually changes avoids forcing
  // a layout pass on every clear. aria-label is kept in sync so a screen reader
  // announces "Score 320" rather than reading the CSS-generated label
  // inconsistently.
  var scoresContainerEl = document.querySelector(".scores-container");
  var scoreEl = document.querySelector(".score-container");
  var bestEl = document.querySelector(".best-container");
  function setChip(el, label, n) {
    var text = String(n);
    if (el.firstChild && el.firstChild.nodeType === 3) {
      if (el.firstChild.nodeValue !== text) el.firstChild.nodeValue = text;
    } else {
      el.textContent = text;
    }
    el.setAttribute("aria-label", label + " " + text);
  }
  function setScore(n) { setChip(scoreEl, "Score", n); }
  function setBest(n) { setChip(bestEl, "Best", n); }

  // -------- overlay --------
  // Setting `data-state` lets CSS pick the right button (Start / Resume / Try
  // again) without JS managing visibility imperatively.
  var overlayEl = document.querySelector(".game-message");
  var overlayTextEl = document.querySelector(".game-message-text");
  var finalScoreEl = document.querySelector(".final-score");
  var newBestNoteEl = document.querySelector(".new-best-note");
  var shareButtonEl = document.querySelector(".share-button");
  var pauseButtonEl = document.querySelector(".pause-button");

  function setOverlay(state) {
    overlayEl.setAttribute("data-state", state);
    // The new-best banner and final score only apply to game-over; clear them
    // when leaving so a restarted run doesn't carry stale text forward.
    if (state !== "over") {
      newBestNoteEl.textContent = "";
      finalScoreEl.textContent = "";
    }
    // The pause button is only meaningful during a live run; leaving it up
    // while the overlay is showing gives two controls for the same thing.
    if (pauseButtonEl) pauseButtonEl.hidden = state !== "playing";

    if (state === "playing") {
      overlayEl.classList.remove("visible");
      return;
    }
    overlayEl.classList.add("visible");
    if (state === "idle") overlayTextEl.textContent = IDLE_TEXT;
    else if (state === "paused") overlayTextEl.textContent = "PAUSED";
    else if (state === "over") overlayTextEl.textContent = "GAME OVER";
  }

  // -------- share modal --------
  // User-initiated only, opened from the Share button on the game-over overlay.
  // Mirrors snake's modal: a text preview, primary actions (copy, plus native
  // share on touch), then a row of social-intent links. Native share is gated
  // to touch because the desktop OS share sheet is anemic and the value of a
  // native picker — one tap to a specific contact — only exists on phones.
  function buildShareTitle(result) {
    return result.isNewBest
      ? "Flappy Rabbits — new high score: " + result.score
      : "Flappy Rabbits — score: " + result.score;
  }

  function buildShareText(result) {
    return buildShareTitle(result) + "\n\nPlay at " + LANDING_URL;
  }

  function showShareModal(result) {
    var title = buildShareTitle(result);
    var text = buildShareText(result);
    var supportsNativeShare = IS_TOUCH && typeof navigator.share === "function";

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
      // Backdrop click (but not a click inside the modal body) closes. Also
      // stops the click reaching document.body, where the input manager would
      // read it as a rotation.
      e.stopPropagation();
      if (e.target === backdrop) { close(); return; }
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
        // Routed through the SDK so the call runs in the outer host's context
        // (the WP page on web, the RN host on mobile) where Permissions Policy
        // doesn't gate navigator.share.
        try {
          OR.actions
            .share({ title: "Flappy Rabbits", text: text })
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
        // Facebook strips text from share intents — URL-only is what lands.
        // The og:image / og:title on the landing page produces the card.
        openShareUrl(
          "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(LANDING_URL)
        );
        return;
    }
  }

  function openShareUrl(url) {
    // noopener so the destination tab can't reach back into our window.
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

  // -------- boot --------
  OR.whenReady()
    .then(function () { return storage.hydrate(); })
    .then(function () {
      // Last finished run, populated on each game over and read by the Share
      // button. Null before the first game over, so a stray press (CSS hides
      // the button off-state, but the guard doesn't depend on that) is a no-op
      // rather than sharing "score: undefined".
      var lastResult = null;

      shareButtonEl.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!lastResult) return;
        showShareModal(lastResult);
      });

      sound.setMuted(storage.isMuted());

      var canvas = document.querySelector(".game-canvas");
      var renderer = new HopRenderer(canvas);
      var input = new HopInputManager();

      var game = new HopGame({
        renderer: renderer,
        storage: storage,
        input: input,
        sound: sound,
        listener: {
          onState: function (state) { setOverlay(state); },
          onScore: function (score) { setScore(score); },
          onBest: function (best) { setBest(best); },
          onPass: function () {
            // One light tap per gate cleared. Deliberately not on the hop
            // itself: a hop fires several times a second, and a haptic at that
            // rate stops reading as feedback and starts reading as a fault.
            try { OR.actions.haptic("light").catch(noop); } catch (_) {}
          },
          onGameOver: function (info) {
            try { OR.actions.haptic("error").catch(noop); } catch (_) {}
            lastResult = { score: info.score, isNewBest: info.isNewBest };
            finalScoreEl.textContent = "SCORE " + info.score;
            if (info.isNewBest) {
              newBestNoteEl.textContent = "NEW BEST!";
              // success is reserved for a genuine personal best, distinct from
              // the per-clear haptic, so the player FEELS the achievement.
              try { OR.actions.haptic("success").catch(noop); } catch (_) {}
            }
            // Record before submitting: the month tracker is what submitBests
            // reads, so a score recorded after the call would wait a whole
            // trigger to go out.
            storage.recordMonthScore(info.score);
            submitBests();
          },
        },
      });

      // Opening the leaderboard mid-run must not cost the player the run: the
      // world keeps scrolling behind a modal. js/leaderboard.js calls this before
      // it opens — a no-op unless a run is in progress, so the idle and
      // game-over entry points are unaffected. Deliberately not a resume: the
      // player closes the board when they're ready, and the paused overlay
      // behind it already offers Resume.
      window.HopPauseForModal = function () { game.pause(); };

      try {
        // Auto-pause when the host backgrounds the app. The world scrolls in
        // real time, so a backgrounded run would silently end.
        OR.lifecycle.on("pause", function () {
          game.pause();
          // Also a retry point for anything unconfirmed — covers a player who
          // set a score and backgrounded before the first attempt landed, which
          // on a flaky connection is exactly when it didn't.
          submitBests();
        });
        // And retry on the way back in. `pause` is the worst moment to depend
        // on: the app is being backgrounded, often because the player walked
        // out of range, so that attempt is the most likely to fail — and the
        // next trigger after it is a whole game away. Deliberately does NOT
        // unpause: the auto-pause exists so a backgrounded run doesn't end
        // silently, and resuming for a player who isn't looking yet throws
        // that away.
        OR.lifecycle.on("resume", function () { submitBests(); });
      } catch (_) {}

      // Browsers keep an AudioContext suspended until a user gesture, so
      // resume on the first one. once + capture so we see it even though the
      // board's own handlers call stopPropagation.
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
      if (soundToggleEl) {
        soundToggleEl.addEventListener("click", function (e) {
          e.preventDefault();
          // Without this the click also reaches document.body and hops the
          // rabbit behind the button.
          e.stopPropagation();
          var next = !sound.isMuted();
          sound.setMuted(next);
          storage.setMuted(next);
          paintSoundToggle();
        });
        paintSoundToggle();
      }

      setBest(storage.getBest());
      // Reveal the chips only after the hydrated best is written, so a
      // returning player doesn't see "0 → 4210" flash on first paint.
      scoresContainerEl.classList.add("ready");

      // Anything the platform never confirmed from a previous session.
      submitBests();

      window.requestAnimationFrame(function () {
        game.boot();
        try { OR.ready(); } catch (_) {}
      });
    })
    .catch(function (err) {
      console.error("hop: bootstrap failed", err);
      showFatalError("Couldn't start the game. Try reloading the page.");
    });
})();

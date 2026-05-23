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

  function noop() {}

  // Coarse score bands. Same shape as snake's, scaled for the much larger
  // match-3 score range. Bands stay coarse enough to keep each bucket above
  // the k=5 anonymity floor on the aggregate count.
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
  // empties so the urgency cue is colour + width, not width alone.
  var timerFillEl = document.querySelector(".timer-fill");
  function setTimer(remaining, total) {
    if (!timerFillEl) return;
    var ratio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
    timerFillEl.style.width = (ratio * 100).toFixed(1) + "%";
    // HSL 120 (green) → 0 (red). Saturation/lightness fixed.
    var hue = Math.round(120 * ratio);
    timerFillEl.style.background = "hsl(" + hue + ", 70%, 48%)";
  }

  // Overlay -----------------------------------------------------------
  var overlayEl = document.querySelector(".game-message");
  var overlayTextEl = document.querySelector(".game-message-text");
  var communityNoteEl = document.querySelector(".community-note");
  var newBestNoteEl = document.querySelector(".new-best-note");
  var finalScoreEl = document.querySelector(".final-score");
  var shareButtonEl = document.querySelector(".share-button");
  function setOverlay(state) {
    overlayEl.setAttribute("data-state", state);
    if (state !== "over") {
      communityNoteEl.textContent = "";
      newBestNoteEl.textContent = "";
      finalScoreEl.textContent = "";
    }
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
          onTimer: function (remaining, total) { setTimer(remaining, total); },
          onMatch: function (clusters) {
            // Light haptic per match. A long cascade fires once per resolve
            // step rather than once per cluster — feels like a chain rather
            // than a buzzer.
            try { OR.actions.haptic("light").catch(noop); } catch (_) {}
            // Promote the haptic intensity for big clears (5+ tiles).
            for (var i = 0; i < clusters.length; i++) {
              if (clusters[i].length >= 5) {
                try { OR.actions.haptic("medium").catch(noop); } catch (_) {}
                break;
              }
            }
          },
          onCombo: function (mult, roundPts) {
            showCombo(mult, roundPts);
            // Medium haptic on every combo step — a chain physically
            // building feels right. Higher combos already trigger a
            // bigger screen shake (handled in game.js).
            try { OR.actions.haptic("medium").catch(noop); } catch (_) {}
          },
          onGameOver: function (info) {
            try { OR.actions.haptic("error").catch(noop); } catch (_) {}
            lastResult = { score: info.score, isNewBest: info.isNewBest };
            finalScoreEl.textContent = "Score: " + info.score;
            if (info.isNewBest) {
              newBestNoteEl.textContent = "NEW BEST!";
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

      // Responsive canvas — keep the internal pixel size in sync with the
      // CSS-computed display size. Resize fires on rotation + window resize
      // + the host iframe being resized.
      function syncCanvas() {
        renderer.resize(8, 8);
      }
      window.addEventListener("resize", syncCanvas);
      window.addEventListener("orientationchange", syncCanvas);

      setBest(storage.getBest());
      setTimer(120, 120);
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

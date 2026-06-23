// Async bootstrap. Mirrors 2048/js/application.js in shape: wait for the
// OddsRabbit bridge to deliver init, hydrate persisted best score, then
// construct the game and call OR.ready() so the host can hide its skeleton.

(function () {
  var LANDING_URL = "https://www.oddsrabbit.com/games/snake/";

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
  var newBestNoteEl = document.querySelector(".new-best-note");
  var shareButtonEl = document.querySelector(".share-button");
  function setOverlay(state) {
    overlayEl.setAttribute("data-state", state);
    // The new-best banner only applies to game-over; clear it when leaving
    // that state so a restarted game doesn't carry stale text into the next
    // idle/over cycle.
    if (state !== "over") {
      newBestNoteEl.textContent = "";
    }
    if (state === "playing") {
      overlayEl.classList.remove("visible");
      return;
    }
    overlayEl.classList.add("visible");
    if (state === "idle") overlayTextEl.textContent = IDLE_TEXT;
    else if (state === "paused") overlayTextEl.textContent = "PAUSED";
    else if (state === "over") overlayTextEl.textContent = "GAME OVER";
  }

  // -------- Share modal --------
  // User-initiated only. Opened from the Share button on the game-over
  // overlay; never auto-fires. Mirrors rabbit-words' modal shape: a text
  // preview, primary actions (copy + native on touch), then a row of
  // social-intent links. Native share is gated to touch devices since the
  // desktop OS share sheet is anemic (Mail/AirDrop only) and the value of
  // a native picker — one-tap to a specific contact — only exists on phones.
  var IS_TOUCH_DEVICE = IS_TOUCH;

  function buildShareTitle(result) {
    return result.isNewBest
      ? "Snake — new high score: " + result.score
      : "Snake — score: " + result.score;
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

    // Backdrop click (but not modal-body click) closes.
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
        // Route through the SDK so the call runs in the outer host's context
        // (WP page on web, RN host on mobile) where Permissions Policy
        // doesn't gate navigator.share.
        try {
          OR.actions
            .share({ title: "Snake", text: text })
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

  OR.whenReady()
    .then(function () { return storage.hydrate(); })
    .then(function () {
      // Last finished run's score, populated on each game-over and read by
      // the share button. Null before the first game-over so a stray tap on
      // the button (shouldn't be possible, since CSS hides it off-state) is
      // a no-op rather than sharing "Score: undefined".
      var lastResult = null;

      shareButtonEl.addEventListener("click", function () {
        if (!lastResult) return;
        showShareModal(lastResult);
      });

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
            lastResult = { score: info.score, isNewBest: info.isNewBest };
            if (info.isNewBest) {
              newBestNoteEl.textContent = "NEW BEST!";
              // success haptic is reserved for genuine personal-best moments
              // — distinct from the per-food light haptic so the player
              // *feels* the achievement.
              try { OR.actions.haptic("success").catch(noop); } catch (_) {}
            }
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

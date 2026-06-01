// Bootstrap. Awaits the OddsRabbit bridge, hydrates storage, restores any
// saved game, wires the input → renderer → game loop, and calls OR.ready()
// after first paint so the host skeleton can hide.
//
// Drag state ownership lives here (not in input or renderer) because it
// crosses both: input emits low-level pointer events, the renderer paints
// the lifted cards, and the game commits the move on drop. Centralising
// the state object means the loop is "input event → mutate dragState →
// renderer.draw(board, dragState)" and the components stay decoupled.

(function () {
  var Deck = window.SolitaireDeck;
  var GameClass = window.SolitaireGame;
  var RendererClass = window.SolitaireRenderer;
  var InputClass = window.SolitaireInputManager;
  var StorageClass = window.SolitaireStorageManager;

  var LANDING_URL = "https://www.oddsrabbit.com/games/solitaire/";

  var OR = window.OddsRabbit;
  if (!OR) {
    console.error("solitaire: OddsRabbit bridge not available — game requires the SDK host.");
    showFatalError("This game needs to run inside the OddsRabbit app or website.");
    return;
  }

  // --- DOM handles ---

  var canvas = document.querySelector(".game-canvas");
  var statsContainerEl = document.querySelector(".stats-container");
  var movesEl = document.querySelector(".moves-container");
  var timeEl = document.querySelector(".time-container");
  var undoBtn = document.querySelector(".undo-button");
  var restartBtn = document.querySelector(".restart-button");
  var overlay = document.querySelector(".game-message");
  var overlayText = document.querySelector(".game-message-text");
  var overlaySub = document.querySelector(".game-message-sub");
  var communityNote = document.querySelector(".community-note");
  var friendsPanelEl = document.querySelector(".friends-panel");
  var startDailyBtn = document.querySelector(".start-daily-button");
  var startRandomBtn = document.querySelector(".start-random-button");
  var finishBtn = document.querySelector(".finish-button");
  var retryDailyBtn = document.querySelector(".retry-daily-button");
  var retryRandomBtn = document.querySelector(".retry-random-button");
  var shareBtn = document.querySelector(".share-button");

  // --- Instances ---

  var storage = new StorageClass();
  var renderer = new RendererClass(canvas);
  var game = new GameClass({
    storage: storage,
    listener: {
      onChange: onBoardChange,
      onStateChange: onStateChange,
    },
  });
  var input = new InputClass(canvas, {
    hitTest: function (x, y) { return renderer.hitTest(x, y); },
    isDraggable: function (loc) { return renderer.isDraggable(loc); },
  });

  // --- Drag state ---

  // dragState: { source, pointer:{x,y}, offset:{x,y}, cards:[int...] }
  // The cards array is the moving slice. For tableau drags it can be many;
  // for waste/foundation drags it's always exactly one. The renderer
  // suppresses the source location's top while a drag is active so the
  // lift-off is visible.
  var dragState = null;

  // --- Overlay state ---

  // Overlay's data-state controls which sub-buttons show via CSS. Possible
  // values: 'idle' (pre-deal), 'playing' (hidden), 'won' (post-win).
  function setOverlayState(state) {
    overlay.setAttribute("data-state", state);
    overlay.classList.toggle("visible", state !== "playing");
  }

  function setOverlayText(main, sub) {
    overlayText.textContent = main || "";
    overlaySub.textContent = sub || "";
  }

  function setCommunityNote(text) {
    communityNote.textContent = text || "";
  }

  // --- Stats chips ---

  function refreshStats() {
    movesEl.textContent = String(game.getMoves());
    movesEl.setAttribute("aria-label", "Moves " + game.getMoves());
    var ms = game.getElapsedMs();
    var s = Math.floor(ms / 1000);
    var mm = Math.floor(s / 60);
    var ss = s % 60;
    var text = pad2(mm) + ":" + pad2(ss);
    timeEl.textContent = text;
    timeEl.setAttribute("aria-label", "Time " + text);
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  // Live time ticker — kicks while playing so the time chip updates once a
  // second without needing the game to fire onChange every frame.
  var timeTickHandle = null;
  function startTimeTick() {
    stopTimeTick();
    timeTickHandle = setInterval(refreshStats, 250);
  }
  function stopTimeTick() {
    if (timeTickHandle != null) {
      clearInterval(timeTickHandle);
      timeTickHandle = null;
    }
  }

  // --- Render loop ---

  function render() {
    var board = game.getBoard();
    if (!board) {
      // Pre-deal — paint the empty wooden table so the canvas doesn't flash
      // white behind the idle overlay (matches COL_FELT in renderer.js).
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#6b4327";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    var targets = dragState ? dragState.legalTargets : null;
    renderer.draw(board, dragState, targets);
  }

  // Legal-target enumeration for the current drag. Called once on pickup
  // and cached on the dragState — predicates are cheap but the highlight
  // set is stable for the duration of a single drag, so there's no need
  // to recompute on every pointermove.
  function computeLegalTargets(board, cards, sourceLoc) {
    var head = cards[0];
    var canStack = Deck.canStackOnTableau;
    var canFound = Deck.canPlaceOnFoundation;
    var targets = [];
    // Foundations accept single-card moves only.
    if (cards.length === 1) {
      for (var i = 0; i < board.foundations.length; i++) {
        // Don't highlight the source foundation as a self-target.
        if (sourceLoc.kind === "foundation" && sourceLoc.index === i) continue;
        var f = board.foundations[i];
        var top = f.length ? f[f.length - 1] : null;
        if (canFound(head, top)) targets.push({ kind: "foundation", index: i });
      }
    }
    // Tableau accepts the head + any cards stacked on it.
    for (var c = 0; c < board.tableau.length; c++) {
      if (sourceLoc.kind === "tableau" && sourceLoc.col === c) continue;
      var col = board.tableau[c];
      var colTop = col.length ? col[col.length - 1] : null;
      if (canStack(head, colTop)) targets.push({ kind: "tableau", col: c });
    }
    return targets;
  }

  function onBoardChange() {
    render();
    refreshStats();
    undoBtn.disabled = game.getUndoDepth() === 0;
    finishBtn.style.display = game.canAutoComplete() ? "inline-block" : "none";
  }

  function onStateChange(state) {
    if (state === GameClass.STATE_PLAYING) {
      setOverlayState("playing");
      startTimeTick();
    } else if (state === GameClass.STATE_WON) {
      stopTimeTick();
      finalizeWin();
    } else if (state === GameClass.STATE_IDLE) {
      stopTimeTick();
      showIdleOverlay();
    }
  }

  // --- Game lifecycle ---

  function showIdleOverlay() {
    setOverlayState("idle");
    // Resolve today's winnable daily seed in the background while the player
    // reads the chooser, so tapping "Daily deal" is instant.
    ensureDailySeedAsync();
    // Update labels each time we re-enter idle so streak/best info is
    // current even if it changed mid-session (e.g. won and bounced back
    // to idle via a manual New Deal).
    var streak = storage.getStreak();
    var bestMs = storage.getBest();
    var subParts = [];
    if (streak > 0) subParts.push("Streak " + streak);
    if (bestMs > 0) subParts.push("Best " + formatTime(bestMs));
    var alreadyWon = game.isDailyWonAlready();
    var mainText = alreadyWon ? "TODAY'S DEAL SOLVED" : "PICK A DEAL";
    setOverlayText(mainText, subParts.join("   ·   "));
    setCommunityNote("");
    clearFriendsPanel();
    // Daily-button labelling: when we've already solved today, the
    // primary button becomes a replay (won't double-count, won't move
    // the streak). The Random button stays as-is for fresh boards.
    startDailyBtn.textContent = alreadyWon ? "Replay daily" : "Daily deal";
    // Surface the current community count on idle when applicable —
    // gives the player a teaser of "you solved a deal X others also
    // beat" without waiting until they tap into a board.
    if (alreadyWon) {
      readDailyAggregate(Deck.dailyId(), "idle");
    }
  }

  // --- Daily solvable-seed cache ---
  //
  // The daily deal is filtered to a winnable seed by the solver (see
  // game.js / solver.js). That search is deterministic but synchronous and can
  // take a beat on low-end devices, so we resolve it lazily while the player is
  // sitting on the idle chooser — well before they tap "Daily deal" — and cache
  // the result. The tap then deals instantly from the cached seed. If they tap
  // before the idle precompute lands, getDailySeed() resolves it synchronously
  // as a fallback (the cost the precompute was hiding, but never lost).
  var dailySeed = { id: -1, value: null, scheduled: false };

  function ensureDailySeedAsync() {
    if (!window.SolitaireSolver) return; // no solver → game.js falls back to raw id
    var today = Deck.dailyId();
    if (dailySeed.id === today && dailySeed.value != null) return;
    if (dailySeed.scheduled) return;
    dailySeed.scheduled = true;
    // Defer past the current paint so the idle overlay renders first.
    setTimeout(function () {
      dailySeed.scheduled = false;
      var t = Deck.dailyId();
      if (dailySeed.id === t && dailySeed.value != null) return;
      dailySeed.value = window.SolitaireSolver.findSolvableSeed(t);
      dailySeed.id = t;
    }, 0);
  }

  function getDailySeed() {
    var today = Deck.dailyId();
    if (dailySeed.id === today && dailySeed.value != null) return dailySeed.value;
    if (!window.SolitaireSolver) return null; // let game.js fall back to the raw id
    dailySeed.value = window.SolitaireSolver.findSolvableSeed(today);
    dailySeed.id = today;
    return dailySeed.value;
  }

  function startDeal(mode) {
    setCommunityNote("");
    clearFriendsPanel();
    storage.clearSavedGame();
    if (mode === GameClass.MODE_DAILY) {
      var seed = getDailySeed();
      game.newDeal(mode, seed != null ? { seed: seed } : undefined);
    } else {
      game.newDeal(mode);
    }
  }

  function finalizeWin() {
    var won = game.getState() === GameClass.STATE_WON;
    if (!won) return;
    var ms = game.getElapsedMs();
    var moves = game.getMoves();
    var isDaily = game.getMode() === GameClass.MODE_DAILY;
    var bestMs = storage.getBest();
    var isNewBest = bestMs === 0 || ms < bestMs;
    if (isNewBest) storage.setBest(ms);

    // Streak + aggregate are daily-only. Random wins are still celebrated
    // but don't move the community-comparison numbers.
    if (isDaily) {
      var dailyId = game.getDailyId();
      var lastId = storage.getLastDailyId();
      var lastWon = storage.getLastDailyWon();
      var alreadyCounted = (lastId === dailyId && lastWon);
      if (!alreadyCounted) {
        // Streak rule: increment if yesterday's daily was the last one we
        // logged AND we won it. Otherwise reset to 1 (a win today is at
        // minimum a streak of 1, never 0).
        var nextStreak = (lastId === dailyId - 1 && lastWon) ? storage.getStreak() + 1 : 1;
        storage.setStreak(nextStreak);
        storage.setLastDaily(dailyId, true);
        countDailyWin(dailyId);
      } else {
        // Replay of an already-counted daily — use the read-only API so
        // the player still sees the community total without us
        // double-counting them into the bucket.
        readDailyAggregate(dailyId, "won");
      }
      // Submit to the daily leaderboard + populate the friends panel. The
      // submit is idempotent server-side (a replay 409s on already-submitted
      // and is swallowed), so it's safe to call on counted + replay alike.
      submitDailyScore(dailyId, ms, moves);
      loadAndRenderFriends(dailyId, { won: true, timeMs: ms, moves: moves });
    } else {
      // Random wins have no shared round to compare against — no leaderboard.
      clearFriendsPanel();
    }

    storage.clearSavedGame();
    setOverlayState("won");
    var mainText = isDaily ? "DAILY #" + game.getDailyId() + " SOLVED" : "YOU WON";
    var subText = formatTime(ms) + "  ·  " + moves + " moves" + (isNewBest ? "  ·  NEW BEST" : "");
    setOverlayText(mainText, subText);
    haptic("success");
  }

  // --- Scores / friends leaderboard ---
  //
  // Daily deals are a shared round, so they map cleanly onto the platform
  // scores API: every player races the same shuffle, and a faster solve
  // should rank higher. scores.friends sorts score DESC (then earliest
  // submission), so we invert time into the score — see dailyScore. The raw
  // time + move count ride along in metadata for display. Random deals have
  // no shared round and are skipped entirely.

  // roundKey is stable across the UTC day (matches the daily seed) so every
  // player on the same deal lands in the same leaderboard.
  function dailyRoundKey(id) { return "daily-" + id; }

  // Faster solve → higher score. We cap at an hour and count down by the
  // second so a 2-minute solve (3480) outranks a 10-minute one (3000). Floor
  // at 1 so even a slow win still registers a positive score.
  var SCORE_TIME_CAP_MS = 60 * 60 * 1000;
  function dailyScore(ms) {
    var capped = Math.min(Math.max(ms, 0), SCORE_TIME_CAP_MS);
    return Math.max(1, Math.round((SCORE_TIME_CAP_MS - capped) / 1000));
  }

  function submitDailyScore(id, ms, moves) {
    if (!OR.scores || typeof OR.scores.submit !== "function") return;
    try {
      OR.scores
        .submit({
          roundKey: dailyRoundKey(id),
          score: dailyScore(ms),
          metadata: { timeMs: ms, moves: moves },
        })
        .catch(function () {}); // 409 on replay (already-submitted) is expected.
    } catch (_) {}
  }

  // Fetch the people-you-follow leaderboard for this daily and render the
  // panel. Async + best-effort: the win overlay is already up, so a slow or
  // failed fetch just leaves the panel in its CTA/empty state. Guarded on the
  // overlay still showing "won" so a fetch that resolves after the player has
  // moved on (New Deal, replay) doesn't paint a stale list.
  function loadAndRenderFriends(id, viewerResult) {
    renderFriendsPanel(null, viewerResult); // optimistic: viewer row + CTA immediately
    if (!OR.user) return;                    // anon: CTA only, no fetch
    if (!OR.scores || typeof OR.scores.friends !== "function") return;
    try {
      OR.scores
        .friends({ roundKey: dailyRoundKey(id) })
        .then(function (friends) {
          if (overlay.getAttribute("data-state") !== "won") return;
          renderFriendsPanel(friends, viewerResult);
        })
        .catch(function () {});
    } catch (_) {}
  }

  function clearFriendsPanel() {
    friendsPanelEl.innerHTML = "";
  }

  // Build the friends panel for the won overlay. Three shapes, mirroring
  // rabbit-words: signed-out → sign-in CTA; signed-in but no friends played →
  // invite CTA; otherwise the viewer's own row on top of the followed-players
  // list. `friends` is null on the optimistic first paint (before the fetch
  // resolves) and an array afterward.
  function renderFriendsPanel(friends, viewerResult) {
    clearFriendsPanel();

    var title = document.createElement("h3");
    title.className = "friends-title";
    title.textContent = "Friends";
    friendsPanelEl.appendChild(title);

    if (!OR.user) {
      appendFriendsCta(
        "Sign in to see how people you follow did on today's deal.",
        "Sign in",
        function () {
          try {
            if (OR.actions && OR.actions.requestSignIn) {
              OR.actions.requestSignIn("See how your friends did on today's deal").catch(function () {});
            }
          } catch (_) {}
        }
      );
      return;
    }

    var list = document.createElement("ul");
    list.className = "friends-list";
    if (viewerResult) {
      var viewerName = OR.user.username ? "@" + OR.user.username : "You";
      appendFriendRow(list, viewerName, viewerResult.timeMs, true);
    }

    if (friends && friends.length) {
      for (var i = 0; i < friends.length; i++) {
        var f = friends[i];
        var meta = f.metadata || null;
        var timeMs = meta && typeof meta.timeMs === "number" ? meta.timeMs : null;
        appendFriendRow(list, "@" + f.username, timeMs, false);
      }
      friendsPanelEl.appendChild(list);
      return;
    }

    // Signed in, but nobody we follow has a score yet (or the fetch hasn't
    // landed). Show the viewer's row plus an invite nudge so the panel still
    // reads as social rather than empty.
    friendsPanelEl.appendChild(list);
    appendFriendsCta(
      "None of your friends have solved today's deal yet. Invite one?",
      "Invite a friend",
      runInviteShare
    );
  }

  function appendFriendRow(list, name, timeMs, isViewer) {
    var li = document.createElement("li");
    li.className = isViewer ? "friends-row friends-row-you" : "friends-row";

    var nameEl = document.createElement("span");
    nameEl.className = "friends-name";
    nameEl.textContent = isViewer ? name + " (you)" : name;
    li.appendChild(nameEl);

    var resultEl = document.createElement("span");
    resultEl.className = "friends-result";
    resultEl.textContent = (timeMs != null) ? formatTime(timeMs) : "Solved";
    li.appendChild(resultEl);

    list.appendChild(li);
  }

  function appendFriendsCta(blurbText, btnText, onClick) {
    var cta = document.createElement("div");
    cta.className = "friends-cta";

    var blurb = document.createElement("p");
    blurb.className = "friends-cta-blurb";
    blurb.textContent = blurbText;
    cta.appendChild(blurb);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "friends-cta-btn";
    btn.textContent = btnText;
    btn.addEventListener("click", onClick);
    cta.appendChild(btn);

    friendsPanelEl.appendChild(cta);
  }

  function runInviteShare() {
    var text = "Play OddsRabbit Solitaire with me — a daily Klondike deal. " + LANDING_URL;
    try {
      if (OR.actions && OR.actions.share) {
        OR.actions.share({ title: "Solitaire", text: text }).catch(function () {
          copyToClipboard(text, "Invite copied to clipboard", "Could not share");
        });
        return;
      }
    } catch (_) {}
    copyToClipboard(text, "Invite copied to clipboard", "Could not share");
  }

  // --- Share ---
  //
  // User-initiated only, from the Share button on the won overlay — we don't
  // auto-fire on win because the OS share sheet over the win overlay would
  // block the satisfying "I solved it" moment. The modal mirrors snake's /
  // rabbit-words' shape: a text preview, copy + native (touch only), then a
  // row of social-intent links. Native share is gated to touch devices since
  // the desktop OS share sheet is anemic (Mail/AirDrop only) and a one-tap-
  // to-a-contact picker only meaningfully exists on phones.
  var IS_TOUCH_DEVICE = (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0)
    || ("ontouchstart" in window);

  function buildShareTitle() {
    if (game.getMode() === GameClass.MODE_DAILY) {
      return "OddsRabbit Solitaire — Daily #" + game.getDailyId();
    }
    return "OddsRabbit Solitaire";
  }

  function buildShareText() {
    var ms = game.getElapsedMs();
    var moves = game.getMoves();
    var lines = [];
    lines.push(buildShareTitle());
    lines.push("Solved in " + formatTime(ms) + " (" + moves + " moves)");
    lines.push("🥕");
    lines.push("");
    lines.push("Play at " + LANDING_URL);
    return lines.join("\n");
  }

  function showShareModal() {
    var title = buildShareTitle();
    var text = buildShareText();
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
      // Backdrop click (outside the modal body) closes.
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
        copyToClipboard(text, "Copied to clipboard", "Could not copy");
        return;
      case "native":
        // Route through the SDK so the call runs in the outer host's context
        // (WP page on web, RN host on mobile) where Permissions Policy
        // doesn't gate navigator.share.
        try {
          OR.actions
            .share({ title: title, text: text })
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

  function copyToClipboard(text, okMsg, failMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { showToast(okMsg); },
        function () { showToast(failMsg); }
      );
    } else {
      showToast(failMsg);
    }
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

  function formatTime(ms) {
    var s = Math.floor(ms / 1000);
    var mm = Math.floor(s / 60);
    var ss = s % 60;
    return pad2(mm) + ":" + pad2(ss);
  }

  // --- Aggregate (community completion count) ---
  //
  // OR.aggregate.count(key, bucket) registers the caller into the bucket
  // and returns the post-write count — use exactly once per first win of
  // a daily deal.
  //
  // OR.aggregate.read(key, bucket) is the read-only counterpart used for
  // already-solved replays + the idle overlay's "you solved today" line,
  // so refreshing the page (or replaying for fun) doesn't double-count
  // the same player in the bucket.

  function dailyAggregateKey(id) { return "daily-" + id; }

  function setNoteFromCount(count, expectedOverlayState) {
    if (expectedOverlayState && overlay.getAttribute("data-state") !== expectedOverlayState) return;
    if (count == null) {
      setCommunityNote("Stats unlock once a few more players finish today's deal.");
    } else {
      setCommunityNote(
        count.toLocaleString() + " " + (count === 1 ? "player has" : "players have") + " solved today's deal so far."
      );
    }
  }

  function countDailyWin(id) {
    if (!OR.aggregate || typeof OR.aggregate.count !== "function") return;
    try {
      OR.aggregate
        .count(dailyAggregateKey(id), "won")
        .then(function (count) { setNoteFromCount(count, "won"); })
        .catch(function () {});
    } catch (_) {}
  }

  function readDailyAggregate(id, expectedOverlayState) {
    if (!OR.aggregate || typeof OR.aggregate.read !== "function") return;
    try {
      OR.aggregate
        .read(dailyAggregateKey(id), "won")
        .then(function (count) { setNoteFromCount(count, expectedOverlayState); })
        .catch(function () {});
    } catch (_) {}
  }

  // --- Input wiring ---

  input.on("tap", function (loc) {
    if (game.getState() !== GameClass.STATE_PLAYING) return;
    if (loc.kind === "stock") {
      var ok = game.drawStock();
      if (ok) haptic("light");
      return;
    }
    // Tap on the top of a tableau column or the waste → try auto-send to
    // foundation. Avoids forcing the player to drag every foundation move.
    if (loc.kind === "tableau") {
      var stack = game.getBoard().tableau[loc.col];
      if (loc.index !== stack.length - 1) return; // not the top
      tryAutoSend({ kind: "tableau", col: loc.col, index: loc.index });
      return;
    }
    if (loc.kind === "waste") {
      tryAutoSend({ kind: "waste" });
    }
  });

  function tryAutoSend(source) {
    var board = game.getBoard();
    var card;
    if (source.kind === "waste") {
      if (board.waste.length === 0) return;
      card = board.waste[board.waste.length - 1];
    } else if (source.kind === "tableau") {
      card = board.tableau[source.col][source.index];
    } else {
      return;
    }
    var tops = [];
    for (var i = 0; i < board.foundations.length; i++) {
      var f = board.foundations[i];
      tops.push(f.length ? f[f.length - 1] : null);
    }
    var target = Deck.findFoundationTarget(card, tops);
    if (target < 0) return;
    var ok = game.tryMove(source, { kind: "foundation", index: target });
    if (ok) haptic("success");
  }

  input.on("pickup", function (e) {
    var board = game.getBoard();
    if (!board) return;
    // Build the moving stack. For tableau, that's index..end of column.
    // For waste/foundation, exactly one card.
    var cards = [];
    var src = e.source;
    if (src.kind === "tableau") {
      var col = board.tableau[src.col];
      for (var i = src.index; i < col.length; i++) cards.push(col[i]);
    } else if (src.kind === "waste") {
      cards.push(board.waste[board.waste.length - 1]);
    } else if (src.kind === "foundation") {
      var f = board.foundations[src.index];
      cards.push(f[f.length - 1]);
    } else {
      return;
    }
    // Offset = pointer - source-card-screen-position. Keeps the picked-up
    // card aligned to the grab point so it doesn't jump.
    var pos = renderer.cardScreenPosition(src, board);
    dragState = {
      source: src,
      cards: cards,
      pointer: e.pointer,
      offset: { x: e.pointer.x - pos.x, y: e.pointer.y - pos.y },
      legalTargets: computeLegalTargets(board, cards, src),
    };
    haptic("light");
    render();
  });

  input.on("pointermove", function (pt) {
    if (!dragState) return;
    dragState.pointer = pt;
    render();
  });

  input.on("drop", function (pt) {
    if (!dragState) return;
    var src = dragState.source;
    // Hit-test the dragged card's centre, not the raw pointer. The lifted
    // card is painted at `pointer - offset` (see renderer._drawDragPreview),
    // so for a stack grabbed off-centre (or a multi-card run grabbed at its
    // head) the finger sits well away from where the card actually is. Using
    // the card centre makes the drop land where the player sees the card —
    // and matches the legal-target highlights, which are drawn at the card's
    // landing rects rather than under the pointer.
    var layout = renderer.layout;
    var cardX = pt.x - dragState.offset.x + layout.CARD_W / 2;
    var cardY = pt.y - dragState.offset.y + layout.CARD_H / 2;
    var target = renderer.hitTest(cardX, cardY);
    dragState = null;
    if (!target) {
      render();
      haptic("error");
      return;
    }
    // Translate hit-test result into a drop target the game understands.
    // Tableau hits return their card index; the game.tryMove signature for
    // tableau targets only cares about the column.
    var dropTarget;
    if (target.kind === "tableau") {
      dropTarget = { kind: "tableau", col: target.col };
    } else if (target.kind === "foundation") {
      dropTarget = { kind: "foundation", index: target.index };
    } else {
      render();
      haptic("error");
      return;
    }
    var ok = game.tryMove(src, dropTarget);
    if (ok) {
      haptic("success");
    } else {
      haptic("error");
      render();
    }
  });

  input.on("cancel", function () {
    dragState = null;
    render();
  });

  input.on("keyboard", function (action) {
    if (action === "undo") return doUndo();
    if (action === "restart") {
      storage.clearSavedGame();
      game.resetToIdle();
      return;
    }
    if (action === "draw") {
      if (game.getState() === GameClass.STATE_PLAYING) {
        if (game.drawStock()) haptic("light");
      }
    }
  });

  // --- Buttons ---

  undoBtn.addEventListener("click", doUndo);
  restartBtn.addEventListener("click", function () {
    // "New Deal" on the toolbar always pops the player back to the idle
    // chooser — feels safer than silently rerolling a random deal and
    // matches what other solitaire clients do. resetToIdle() transitions the
    // engine to IDLE, which fires onStateChange → stopTimeTick + the idle
    // overlay; doing it via state (not just setOverlayState) is what stops
    // the time ticker from leaking and the chips from counting a dead deal.
    storage.clearSavedGame();
    game.resetToIdle();
  });

  startDailyBtn.addEventListener("click", function () { startDeal(GameClass.MODE_DAILY); });
  startRandomBtn.addEventListener("click", function () { startDeal(GameClass.MODE_RANDOM); });
  retryDailyBtn.addEventListener("click", function () { startDeal(GameClass.MODE_DAILY); });
  retryRandomBtn.addEventListener("click", function () { startDeal(GameClass.MODE_RANDOM); });
  shareBtn.addEventListener("click", showShareModal);
  finishBtn.addEventListener("click", runAutoComplete);

  function doUndo() {
    if (game.getState() !== GameClass.STATE_PLAYING) return;
    if (game.undo()) haptic("light");
  }

  // Auto-complete cascade — one autoplay step (foundation send, or a stock
  // draw to expose the next card) every 60ms until the board is won. Using a
  // real timer (vs synchronously flushing all moves) lets the player watch the
  // foundations fill up, and matches the satisfying "rip" most solitaire
  // clients do. The guard is pure insurance: canAutoComplete has already
  // proven this cascade terminates in a win, so it should never trip.
  function runAutoComplete() {
    if (!game.canAutoComplete()) return;
    finishBtn.style.display = "none";
    var guard = 0;
    function step() {
      if (guard++ > 1000) return;
      var didMove = game.autoCompleteStep();
      if (didMove && game.getState() === GameClass.STATE_PLAYING) {
        setTimeout(step, 60);
      }
    }
    step();
  }

  // --- Haptics shim ---

  function haptic(kind) {
    if (!OR.actions || typeof OR.actions.haptic !== "function") return;
    try { OR.actions.haptic(kind).catch(function () {}); } catch (_) {}
  }

  // --- Lifecycle ---

  // Flush the in-progress deal to storage. snapshot() returns null unless a
  // deal is actually in progress, so this is a no-op at idle/won.
  function persistSnapshot() {
    var snap = game.snapshot();
    if (snap) storage.setSavedGame(snap);
  }

  // Persist on BOTH the bridge-native pause and the browser-native pagehide.
  // pause is the signal a host sends when the mini-app is backgrounded; but a
  // hard tab-close (or a host that never emits pause) would otherwise lose a
  // mid-deal game silently. pagehide is the belt-and-suspenders fallback —
  // same pattern 2048 uses (see 2048/js/storage_manager.js). Both are
  // best-effort; the storage write is fire-and-forget.
  if (OR.lifecycle && typeof OR.lifecycle.on === "function") {
    OR.lifecycle.on("pause", persistSnapshot);
  }
  window.addEventListener("pagehide", persistSnapshot);

  // --- Bootstrap sequence ---

  function bootstrap() {
    OR.whenReady().then(function () {
      return storage.hydrate();
    }).then(function () {
      // Restore an in-progress deal if we have one. Daily deals only
      // restore if the seed still matches today — yesterday's deal
      // wouldn't count toward today's streak, so silently discarding it
      // is safer than confusing the player by reviving a stale board.
      var saved = storage.getSavedGame();
      var today = Deck.dailyId();
      if (saved && (saved.mode === GameClass.MODE_RANDOM || saved.dailyId === today)) {
        if (game.restoreSaved(saved)) {
          statsContainerEl.classList.add("ready");
          OR.ready();
          return;
        }
      }
      // No restore — start at the idle overlay.
      storage.clearSavedGame();
      showIdleOverlay();
      statsContainerEl.classList.add("ready");
      refreshStats();
      render();
      OR.ready();
    }).catch(function (err) {
      console.error("solitaire: bootstrap failed", err);
      showFatalError("Couldn't start the game. Try reloading.");
      try { OR.ready(); } catch (e) {}
    });
  }

  function showFatalError(message) {
    if (document.querySelector(".bootstrap-error")) return;
    var banner = document.createElement("div");
    banner.className = "bootstrap-error";
    banner.setAttribute("role", "alert");
    banner.textContent = message;
    var target = document.querySelector(".container") || document.body;
    if (target === document.body) target.appendChild(banner);
    else target.insertBefore(banner, target.firstChild);
  }

  bootstrap();
})();

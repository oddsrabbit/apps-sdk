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
  var SoundClass = window.SolitaireSoundManager;

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
  var friendsPanelEl = document.querySelector(".friends-panel");
  // Shared leaderboard component (dist/leaderboard-v1.js). Absent on a stale
  // cached bundle, which renderFriendsPanel treats as "no panel" rather than
  // failing.
  var UI = window.OddsRabbitUI;

  // Rows to fetch for a public board. The REST route and the SDK schema both
  // cap this at 100, so it is "everyone the server will hand over". Was 20,
  // which was a placeholder and had begun cutting real players off on the
  // deeper boards in the other games. The panel bounds its own height and
  // scrolls, so a deeper board costs reachable rows, not hidden ones.
  var BOARD_LIMIT = 100;
  var startDailyBtn = document.querySelector(".start-daily-button");
  var startRandomBtn = document.querySelector(".start-random-button");
  var finishBtn = document.querySelector(".finish-button");
  var retryDailyBtn = document.querySelector(".retry-daily-button");
  var retryRandomBtn = document.querySelector(".retry-random-button");
  var shareBtn = document.querySelector(".share-button");

  // --- Instances ---

  var storage = new StorageClass();
  // The card art lives in an atlas PNG, so the renderer cannot exist until
  // that image has decoded. The fetch starts here, at module scope, so it
  // overlaps the bridge handshake and the storage hydrate rather than adding
  // its latency on top of them; bootstrap() awaits it and assigns `renderer`.
  // Everything that touches `renderer` runs after first paint (pointer
  // handlers, render()), and both guard for the gap.
  //
  // The URL comes off the canvas' data-atlas attribute rather than being
  // hardcoded here, because index.html is the only file the build rewrites
  // __BUILD_ID__ in — see docs/deploy-cache-policy.md for why an unversioned
  // asset URL goes stale.
  var atlasPromise = RendererClass.load(canvas.getAttribute("data-atlas") || "./images/cards.png");
  // The rejection is really handled in bootstrap(), which awaits this promise
  // and falls through to showFatalError. This no-op catch only exists so a
  // failure that lands before bootstrap attaches its handler can't surface as
  // an unhandled rejection in the host console.
  atlasPromise.catch(function () {});
  var renderer = null;
  // Procedural audio (js/sound_manager.js). Constructed up front but stays
  // suspended until the first user gesture unlocks it (see initSound); the
  // play* methods self-guard when muted/suspended, so handlers below never
  // need to check.
  var sound = new SoundClass();
  var MUTED_KEY = "soundMuted";
  var game = new GameClass({
    storage: storage,
    listener: {
      onChange: onBoardChange,
      onStateChange: onStateChange,
    },
  });
  var input = new InputClass(canvas, {
    hitTest: function (x, y) { return renderer ? renderer.hitTest(x, y) : null; },
    isDraggable: function (loc) { return renderer ? renderer.isDraggable(loc) : false; },
  });

  // --- Drag state ---

  // dragState: { source, pointer:{x,y}, offset:{x,y}, cards:[int...] }
  // The cards array is the moving slice. For tableau drags it can be many;
  // for waste/foundation drags it's always exactly one. The renderer
  // suppresses the source location's top while a drag is active so the
  // lift-off is visible.
  var dragState = null;

  // True while the Finish cascade is running. onBoardChange fires once per
  // auto-complete step and would otherwise re-show the Finish button (which
  // canAutoComplete keeps green-lit until the last card), making it blink over
  // the cascade. This flag keeps it hidden for the duration.
  var autoCompleting = false;

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
      // white behind the idle overlay. Uses the renderer's exported felt
      // colour so the idle board can't drift from the in-game one again (a
      // stale dark-wood hex used to live here).
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = RendererClass.COL_FELT;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    // A board exists but the atlas hasn't decoded yet — only reachable if a
    // restore lands before the atlas resolves. Leave the felt as painted
    // above; bootstrap renders again once the renderer is up.
    if (!renderer) return;
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
    finishBtn.style.display = (!autoCompleting && game.canAutoComplete()) ? "inline-block" : "none";
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
    // "Best" on the chooser is the daily best — it sits next to the streak,
    // and random deals (re-rollable until easy) track their own best.
    var bestMs = storage.getBestFor(GameClass.MODE_DAILY);
    var subParts = [];
    if (streak > 0) subParts.push("Streak " + streak);
    if (bestMs > 0) subParts.push("Best " + formatTime(bestMs));
    var alreadyWon = game.isDailyWonAlready();
    var mainText = alreadyWon ? "TODAY'S DEAL SOLVED" : "PICK A DEAL";
    setOverlayText(mainText, subParts.join("   ·   "));
    clearFriendsPanel();
    // Daily-button labelling: when we've already solved today, the
    // primary button becomes a replay (won't double-count, won't move
    // the streak). The Random button stays as-is for fresh boards.
    startDailyBtn.textContent = alreadyWon ? "Replay daily" : "Daily deal";
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
    // Time-sliced search: one seed attempt per timeout tick instead of the
    // whole findSolvableSeed loop in one synchronous burst. A single attempt
    // is bounded by the solver's node budget (~tens of ms worst case), so
    // the main thread stays responsive on low-end devices even when several
    // consecutive seeds fail to prove out. The attempt sequence (base+k,
    // falling back to base) mirrors findSolvableSeed exactly, so this lands
    // on the identical seed every device-and-path computes.
    var Solver = window.SolitaireSolver;
    var maxAttempts = Solver._internal.MAX_SEED_ATTEMPTS;
    var k = 0;
    function step() {
      var t = Deck.dailyId();
      if (dailySeed.id === t && dailySeed.value != null) {
        dailySeed.scheduled = false; // resolved elsewhere (sync fallback)
        return;
      }
      if (t !== today) { today = t; k = 0; } // crossed UTC midnight mid-search
      var seed = (today + k) | 0;
      if (Solver.isSolvable(Deck.deal(seed))) {
        dailySeed.value = seed;
        dailySeed.id = today;
        dailySeed.scheduled = false;
        return;
      }
      if (++k >= maxAttempts) {
        // Same unfiltered fallback findSolvableSeed uses; effectively never
        // reached in practice.
        dailySeed.value = today;
        dailySeed.id = today;
        dailySeed.scheduled = false;
        return;
      }
      setTimeout(step, 0);
    }
    // Defer past the current paint so the idle overlay renders first.
    setTimeout(step, 0);
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
    clearFriendsPanel();
    storage.clearSavedGame();
    if (mode === GameClass.MODE_DAILY) {
      var seed = getDailySeed();
      game.newDeal(mode, seed != null ? { seed: seed } : undefined);
    } else {
      game.newDeal(mode);
    }
    sound.deal();
  }

  function finalizeWin() {
    var won = game.getState() === GameClass.STATE_WON;
    if (!won) return;
    var ms = game.getElapsedMs();
    var moves = game.getMoves();
    var isDaily = game.getMode() === GameClass.MODE_DAILY;
    // Best times are per-mode: random deals can be re-rolled until easy, so
    // letting them set the shared best made the stat gameable.
    var bestMs = storage.getBestFor(game.getMode());
    var isNewBest = bestMs === 0 || ms < bestMs;
    if (isNewBest) storage.setBestFor(game.getMode(), ms);

    // Streak is daily-only. Random wins are still celebrated but don't move
    // the streak or the daily leaderboard.
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
    if (isNewBest) sound.newBest();
    else sound.win();
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

  // Render the boards for this daily. The fetching now belongs to the shared
  // panel — each tab loads itself, shows its own loading and error states, and
  // a board that fails leaves the others usable. Staleness is handled by
  // clearFriendsPanel() destroying the panel when a new deal starts, rather
  // than by re-checking the overlay state after every resolve.
  function loadAndRenderFriends(id, viewerResult) {
    renderFriendsPanel(id, viewerResult);
  }

  // Live panel, so a new deal can tear the old one down before its fetches
  // land. Without this, a board that resolves after the player has moved on
  // would still be holding listeners on detached nodes.
  var currentPanel = null;

  function clearFriendsPanel() {
    if (currentPanel) {
      currentPanel.destroy();
      currentPanel = null;
    }
    friendsPanelEl.innerHTML = "";
  }

  // Friends + Global boards for today's deal, rendered by the shared
  // leaderboard component (src/ui/leaderboard.ts, loaded as window.OddsRabbitUI).
  // Replaces this game's own row/CTA rendering; what stays here is solitaire's
  // part — which rounds, and that a "score" reads back as a solve time.
  //
  // Rows carry `metadata.timeMs`, which is what the player actually cares about;
  // the stored score is a derived speed value (see dailyScore) and would be
  // meaningless on screen.
  function renderFriendsPanel(id, viewerResult) {
    clearFriendsPanel();
    // Nothing to render the boards with (an old cached bundle, a page that
    // didn't get the script tag, or an SDK too old to expose scores.friends):
    // leave the container empty. `.friends-panel:empty` hides it, so the win
    // overlay loses a section rather than gaining a broken one. Checked here
    // rather than left to load() because this runs BEFORE setOverlayState —
    // anything that throws out of here costs the player their win screen.
    if (!UI || !OR.capabilities) return;
    if (!OR.scores || typeof OR.scores.friends !== "function") return;

    var roundKey = dailyRoundKey(id);

    function formatResult(row) {
      var meta = row.metadata || null;
      var timeMs = meta && typeof meta.timeMs === "number" ? meta.timeMs : null;
      return timeMs != null ? formatTime(timeMs) : "Solved";
    }

    // The viewer's own row comes from the just-finished game, so it can be shown
    // without waiting on the backend to have recorded it.
    function withViewer(friends) {
      var rows = [];
      var i;
      for (i = 0; i < friends.length; i++) {
        if (!friends[i].isSelf) rows.push(friends[i]);
      }
      if (viewerResult && OR.user) {
        rows.push({
          uuid: OR.user.uuid,
          username: OR.user.username,
          score: dailyScore(viewerResult.timeMs),
          createdAt: "",
          avatar: OR.user.avatar || null,
          metadata: { timeMs: viewerResult.timeMs },
          isSelf: true
        });
      } else {
        for (i = 0; i < friends.length; i++) {
          if (friends[i].isSelf) rows.push(friends[i]);
        }
      }
      // Nobody but the viewer isn't a comparison — fall through to the invite
      // prompt instead of rendering a leaderboard of one.
      var others = 0;
      for (i = 0; i < rows.length; i++) if (!rows[i].isSelf) others++;
      if (others === 0) return [];
      // Higher score = faster solve, so this is fastest-first.
      rows.sort(function (a, b) {
        return b.score - a.score || (a.isSelf ? -1 : b.isSelf ? 1 : 0);
      });
      return rows;
    }

    var tabs = [
      {
        id: "friends",
        label: "Friends",
        emptyText: "None of your friends have solved today's deal yet.",
        emptyPrompt: {
          blurb: "None of your friends have solved today's deal yet. Invite one?",
          label: "Invite a friend",
          onClick: runInviteShare
        },
        load: function () {
          return OR.scores.friends({ roundKey: roundKey }).then(withViewer);
        },
        formatValue: formatResult,
        signInPrompt: OR.user
          ? null
          : {
              blurb: "Sign in to see how people you follow did on today's deal.",
              label: "Sign in",
              onClick: function () {
                try {
                  if (OR.actions && OR.actions.requestSignIn) {
                    OR.actions
                      .requestSignIn("See how your friends did on today's deal")
                      .catch(function () {});
                  }
                } catch (_) {}
              }
            }
      }
    ];

    // Public read, so guests get this board too — but only where the host
    // implements the verb and the loaded SDK can call it.
    if (OR.capabilities.has("scores.top") && typeof OR.scores.top === "function") {
      var globalTab = {
        id: "global",
        label: "Global",
        emptyText: "Nobody has solved today's deal yet — be the first!",
        load: function () {
          return OR.scores.top({ roundKey: roundKey, order: "top", limit: BOARD_LIMIT });
        },
        formatValue: formatResult
      };
      // The viewer's own placement when they're outside the top 20. Gated
      // separately from the board — `scores.rank` ships after `scores.top`, so
      // a host can have one and not the other — and on `pinnedFromRank` being
      // present, since this game reaches the UI through a script tag that may
      // be an older bundle than the SDK next to it.
      if (OR.capabilities.has("scores.rank") && typeof UI.pinnedFromRank === "function") {
        globalTab.loadPinned = function () {
          return OR.scores
            .rank({ roundKey: roundKey, order: "top" })
            .then(UI.pinnedFromRank);
        };
      }
      tabs.push(globalTab);
    }

    // Monthly board — total points, which for solitaire means total speed
    // across the month's deals (the daily score is already speed-derived, see
    // dailyScore). Unlike the daily board this one accumulates, so a run of
    // good solves adds up to something instead of resetting at midnight.
    if (OR.capabilities.has("scores.season") && typeof UI.createSeasonTab === "function") {
      var seasonOptions = {
        load: function () {
          return OR.scores.season({ period: UI.currentPeriod(), limit: BOARD_LIMIT });
        },
        emptyText: "No solves this month yet — win a deal to get on the board."
      };
      if (OR.capabilities.has("scores.seasonRank")) {
        seasonOptions.loadRank = function () {
          return OR.scores.seasonRank({ period: UI.currentPeriod() });
        };
      }
      tabs.push(UI.createSeasonTab(seasonOptions));
    }

    currentPanel = UI.createLeaderboardPanel({
      tabs: tabs,
      viewerUuid: OR.user && OR.user.uuid ? OR.user.uuid : null
    });

    var title = document.createElement("h3");
    title.className = "friends-title";
    title.textContent = "Leaderboard";
    friendsPanelEl.appendChild(title);
    friendsPanelEl.appendChild(currentPanel.element);
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

  // --- Confirm dialog ---
  //
  // Felt-styled yes/no modal for destructive actions (currently just "New
  // Deal" mid-game). window.confirm would break the in-app look and is blocked
  // in some embedded hosts, so we roll our own. Single-instance: if one is
  // already open we no-op, so a repeated tap / 'r' keypress can't stack them.
  function showConfirm(message, confirmLabel, onConfirm) {
    if (document.querySelector(".confirm-modal-backdrop")) return;

    var backdrop = document.createElement("div");
    backdrop.className = "confirm-modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.innerHTML =
      '<div class="confirm-modal">' +
        '<p class="confirm-text"></p>' +
        '<div class="confirm-buttons">' +
          '<button type="button" class="confirm-cancel" data-action="cancel">Cancel</button>' +
          '<button type="button" class="confirm-ok" data-action="ok"></button>' +
        '</div>' +
      '</div>';
    // Set text via textContent (not innerHTML) so the message can't inject markup.
    backdrop.querySelector(".confirm-text").textContent = message;
    backdrop.querySelector(".confirm-ok").textContent = confirmLabel;
    document.body.appendChild(backdrop);

    function close() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);

    backdrop.addEventListener("click", function (e) {
      // Backdrop click (outside the modal body) cancels.
      if (e.target === backdrop) { close(); return; }
      var action = e.target && e.target.dataset ? e.target.dataset.action : null;
      if (action === "cancel") { close(); return; }
      if (action === "ok") { close(); onConfirm(); }
    });
  }

  // --- Input wiring ---

  // Draw (or recycle) from the stock with matching feedback. Shared by the
  // stock tap and the spacebar shortcut. The recycle case is detected before
  // the move since drawStock handles both behind one return value.
  function doDraw() {
    if (game.getState() !== GameClass.STATE_PLAYING) return;
    var board = game.getBoard();
    var isRecycle = board.stock.length === 0 && board.waste.length > 0;
    if (game.drawStock()) {
      haptic("light");
      if (isRecycle) sound.recycle();
      else sound.draw();
    }
  }

  input.on("tap", function (loc) {
    if (game.getState() !== GameClass.STATE_PLAYING) return;
    if (loc.kind === "stock") {
      doDraw();
      return;
    }
    // Tap on the top of a tableau column or the waste → auto-move it. Avoids
    // forcing the player to drag every move.
    if (loc.kind === "tableau") {
      var stack = game.getBoard().tableau[loc.col];
      if (loc.index !== stack.length - 1) return; // not the top
      tryAutoMove({ kind: "tableau", col: loc.col, index: loc.index });
      return;
    }
    if (loc.kind === "waste") {
      tryAutoMove({ kind: "waste" });
    }
  });

  // Auto-move the tapped card to the best legal destination. Priority:
  // foundation first (always progress), then a non-empty tableau column
  // (building on an existing run), then an empty column (kings). The empty-
  // column branch is suppressed when the source is a lone tableau card
  // (index 0) — relocating it from one bare column to another reveals nothing
  // and just churns the board. Foundation-first means a tap never strands a
  // card on the tableau when it could be banked.
  function tryAutoMove(source) {
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

    // 1) Foundation.
    var tops = [];
    for (var i = 0; i < board.foundations.length; i++) {
      var f = board.foundations[i];
      tops.push(f.length ? f[f.length - 1] : null);
    }
    var fTarget = Deck.findFoundationTarget(card, tops);
    if (fTarget >= 0) {
      if (game.tryMove(source, { kind: "foundation", index: fTarget })) {
        haptic("success");
        sound.foundation();
      }
      return;
    }

    // 2) Tableau. Take the first non-empty legal column; remember the first
    // empty one as a fallback for kings.
    var emptyCol = -1;
    for (var c = 0; c < board.tableau.length; c++) {
      if (source.kind === "tableau" && source.col === c) continue;
      var col = board.tableau[c];
      var colTop = col.length ? col[col.length - 1] : null;
      if (!Deck.canStackOnTableau(card, colTop)) continue;
      if (colTop == null) {
        if (emptyCol < 0) emptyCol = c;
        continue;
      }
      if (game.tryMove(source, { kind: "tableau", col: c })) {
        haptic("success");
        sound.place();
      }
      return;
    }
    if (emptyCol >= 0) {
      var pointless = source.kind === "tableau" && source.index === 0;
      if (!pointless && game.tryMove(source, { kind: "tableau", col: emptyCol })) {
        haptic("success");
        sound.place();
      }
    }
  }

  input.on("pickup", function (e) {
    // State gate: after a win the overlay leaves a thin ring of live canvas
    // around its inset, and a drag started there would lift cards off a
    // finished board. tryMove would reject the drop anyway, but don't paint
    // the pickup either.
    if (game.getState() !== GameClass.STATE_PLAYING) return;
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
      if (dropTarget.kind === "foundation") sound.foundation();
      else sound.place();
    } else {
      haptic("error");
      sound.invalid();
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
      requestNewDeal();
      return;
    }
    if (action === "draw") {
      doDraw();
    }
  });

  // --- Buttons ---

  undoBtn.addEventListener("click", doUndo);
  restartBtn.addEventListener("click", requestNewDeal);

  // "New Deal" pops the player back to the idle chooser. resetToIdle()
  // transitions the engine to IDLE, which fires onStateChange → stopTimeTick +
  // the idle overlay; doing it via state (not just setOverlayState) is what
  // stops the time ticker from leaking and the chips from counting a dead
  // deal. Because the move history and saved game are discarded with no resume
  // path, we confirm first whenever there's real progress to lose — an
  // accidental tap deep into a hard daily would otherwise be unrecoverable.
  function requestNewDeal() {
    var inProgress = game.getState() === GameClass.STATE_PLAYING && game.getMoves() > 0;
    if (inProgress) {
      showConfirm("Leave this deal? Your progress will be lost.", "New deal", doNewDeal);
      return;
    }
    doNewDeal();
  }

  function doNewDeal() {
    storage.clearSavedGame();
    game.resetToIdle();
  }

  startDailyBtn.addEventListener("click", function () { startDeal(GameClass.MODE_DAILY); });
  startRandomBtn.addEventListener("click", function () { startDeal(GameClass.MODE_RANDOM); });
  retryDailyBtn.addEventListener("click", function () { startDeal(GameClass.MODE_DAILY); });
  retryRandomBtn.addEventListener("click", function () { startDeal(GameClass.MODE_RANDOM); });
  shareBtn.addEventListener("click", showShareModal);
  finishBtn.addEventListener("click", runAutoComplete);

  function doUndo() {
    if (game.getState() !== GameClass.STATE_PLAYING) return;
    if (game.undo()) {
      haptic("light");
      sound.undo();
    }
  }

  // Auto-complete cascade — one autoplay step (foundation send, or a stock
  // draw to expose the next card) every 60ms until the board is won. Using a
  // real timer (vs synchronously flushing all moves) lets the player watch the
  // foundations fill up, and matches the satisfying "rip" most solitaire
  // clients do. The guard is pure insurance: canAutoComplete has already
  // proven this cascade terminates in a win, so it should never trip.
  function runAutoComplete() {
    if (!game.canAutoComplete()) return;
    autoCompleting = true;
    // The game is decided the moment Finish is tapped — the cascade is pure
    // show — so pin the clock here. Otherwise the animation (60ms × dozens
    // of steps) inflates the leaderboard time.
    game.freezeElapsed();
    finishBtn.style.display = "none";
    var guard = 0;
    function step() {
      if (guard++ > 1000) { autoCompleting = false; game.unfreezeElapsed(); return; }
      var didMove = game.autoCompleteStep();
      if (didMove) sound.cascade(guard);
      if (didMove && game.getState() === GameClass.STATE_PLAYING) {
        setTimeout(step, 60);
      } else {
        // Cascade finished (won, or — defensively — nothing left to move).
        // On the won path _checkWin already consumed the frozen time;
        // unfreeze covers the defensive stall so the clock can't stay
        // pinned on a still-playing board.
        autoCompleting = false;
        game.unfreezeElapsed();
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
  //
  // Backgrounding also pauses the deal clock: the daily leaderboard ranks by
  // solve time, so minutes spent in another app shouldn't count against the
  // player. visibilitychange mirrors the bridge events for plain-browser
  // hosts; pauseClock/resumeClock are idempotent, so double-firing is safe.
  if (OR.lifecycle && typeof OR.lifecycle.on === "function") {
    OR.lifecycle.on("pause", function () {
      persistSnapshot();
      game.pauseClock();
    });
    OR.lifecycle.on("resume", function () {
      game.resumeClock();
    });
  }
  window.addEventListener("pagehide", persistSnapshot);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      persistSnapshot();
      game.pauseClock();
    } else {
      game.resumeClock();
    }
  });

  // --- Sound unlock + mute toggle ---

  // Browsers keep the AudioContext suspended until a user gesture, so
  // resume() on the first pointer/key event. once:true tears the listeners
  // down after the first hit; capture so we see the gesture even when the
  // canvas handlers stop propagation. The mute preference persists via the
  // storage bridge under MUTED_KEY (same shape as match3).
  function initSound() {
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
        .catch(function () {})
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
          OR.storage.set(MUTED_KEY, muted ? "1" : "0").catch(function () {});
        }
      });
    }
  }

  // --- Crisp-scale snapping ---

  // The canvas is CSS-scaled to the column width, which generally lands the
  // pixel art at a fractional device-pixel ratio — nearest-neighbour then
  // renders art pixels in alternating widths, a subtle wobble in the 1px
  // card borders. Each art pixel is SCALE internal px, so the art is
  // wobble-free when (cssWidth × dpr) is a multiple of INTERNAL_W / SCALE.
  // Reading SCALE off the renderer rather than repeating the literal is what
  // keeps this honest — it was hardcoded to 2, and would have silently
  // targeted the wrong grid the moment SCALE moved. When the column
  // width is within 8% of such a size, snap down to it; otherwise keep the
  // full width — a small wobble beats giant side margins (e.g. narrow phones
  // at 3× would lose ~15% of the board).
  //
  // The snap is applied to .board-frame, NOT the canvas: the frame is the
  // positioning context for the game-message overlay and the Finish button,
  // so shrinking only the canvas would leave both overhanging the board.
  // The canvas stays width:100% of the frame; flex centering on
  // .game-container keeps the narrower frame centred.
  function snapCanvasWidth() {
    var frame = canvas.parentElement; // .board-frame
    if (!frame) return;
    // Clear any previous snap so clientWidth reports the natural CSS width
    // (100% of the column, capped by the frame's max-width).
    frame.style.width = "";
    var avail = frame.clientWidth;
    if (!avail) return;
    var dpr = window.devicePixelRatio || 1;
    var step = (RendererClass.INTERNAL_W / RendererClass.SCALE) / dpr;
    var snapped = Math.floor(avail / step) * step;
    if (snapped > 0 && avail - snapped <= avail * 0.08) {
      frame.style.width = snapped + "px";
    }
  }
  window.addEventListener("resize", snapCanvasWidth);

  // --- Bootstrap sequence ---

  function bootstrap() {
    OR.whenReady().then(function () {
      return Promise.all([storage.hydrate(), atlasPromise]);
    }).then(function (results) {
      renderer = new RendererClass(canvas, results[1]);
      initSound();
      snapCanvasWidth();
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
      // Covers a failed atlas as well as a failed bridge or storage — a
      // missing cards.png would otherwise leave the player on bare felt with
      // no explanation.
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

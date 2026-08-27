// Fruit Match leaderboard modal — two global, public boards backed by the
// platform scores API:
//   • This Month — top players by their best score this calendar month
//     (roundKey "month-YYYY-MM", order "top")
//   • All Time — top players by their best score ever (roundKey "highscore",
//     order "top")
//
// The modal, rows, avatars, medals and ranking come from the shared leaderboard
// component (src/ui/leaderboard.ts, loaded as window.OddsRabbitUI). What's left
// here is the match-3-specific part: which rounds, how a value reads, and the
// capability gating on the entry points.
//
// WHY A MONTH BOARD AND NOT JUST 2048'S SINGLE ALL-TIME ONE. An all-time board
// ossifies (§3.7 of docs/proposals/unified-leaderboard.md): a few months in, the
// top 100 is frozen and a new player has nothing on it to move. 2048 can't fix
// that cheaply — a season aggregation needs daily rows and it has none — but
// this game is adopting scores from scratch, so it submits a per-month round key
// game-side and gets the live board for the cost of one more `scores.top` read.
// That is the shape §3.7 prescribes for a game with no daily rounds; it is NOT
// `scores.season`, which aggregates a month of DAILY keys server-side.
//
// ES5-style vanilla JS to match the rest of match3 (copied static, not bundled).

(function () {
  var OR = window.OddsRabbit;
  var UI = window.OddsRabbitUI;
  var ROUNDS = window.Match3Rounds;
  var buttons = [
    document.querySelector(".leaderboard-button"),
    document.querySelector(".leaderboard-button-overlay"),
  ].filter(Boolean);

  // Hide the entry points on a host that can't serve a global board, rather
  // than opening a modal that always errors.
  //
  // NOTE: do NOT feature-detect `typeof OR.scores.top === "function"` — it ships
  // in every SDK bundle, so that test always passes while the HOST may still not
  // implement the verb (the mobile app lagged the web host by an App Store
  // review). Ask the host via capabilities instead; `has()` also flips to false
  // once a call has been rejected as unsupported, which covers hosts too old to
  // declare capabilities at all.
  if (!OR || !OR.scores || !OR.capabilities || !OR.whenReady || !UI || !ROUNDS) {
    hideButtons();
    return;
  }
  if (!buttons.length) return;

  // The API caps a board at 100 rows and the SDK schema enforces the same, so
  // this is "everyone the server will give us". The modal already scrolls
  // (`.lb-modal`, max-height 85vh), so a longer board costs height the user can
  // reach rather than rows they can't.
  var BOARD_LIMIT = 100;

  function hideButtons() {
    for (var i = 0; i < buttons.length; i++) buttons[i].hidden = true;
  }

  function hostSupportsGlobalBoard() {
    return OR.capabilities.has("scores.top");
  }

  // The capability answer rides in on `init`, which is a postMessage — and this
  // file is a plain <script>, so at this point in the parse no host has spoken
  // yet and `has()` would just echo the SDK's pre-handshake guess. Start hidden
  // and decide in the whenReady continuation, once the host's real answer is in.
  // (If whenReady never resolves, no init ever arrived — application.js is
  // blocked on the same promise and the board itself never renders, so a
  // leaderboard button is moot. Staying hidden is the right resting state.)
  hideButtons();
  OR.whenReady().then(function () {
    if (!hostSupportsGlobalBoard()) return;
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].hidden = false;
      buttons[i].addEventListener("click", onButtonClick);
    }
  });

  // The overlay copy sits inside `.game-message`, whose idle state is a
  // tap-anywhere-to-start target (see onIdleOverlayActivate in application.js).
  // That handler skips taps on buttons, but stopPropagation here keeps the
  // exemption from depending on it — opening the board must never also start a
  // run behind the modal.
  function onButtonClick(e) {
    e.stopPropagation();
    openLeaderboard();
  }

  function formatScore(row) {
    return Number(row.score).toLocaleString();
  }

  // Fetch a board, and retire the entry points if this call is what reveals the
  // host can't serve them. Reaching that branch means the host declared
  // `scores.top` at init and then rejected it anyway — a host too old to declare
  // capabilities, corrected by the SDK's runtime detection. Rejecting (rather
  // than resolving []) keeps the modal from claiming nobody has ever played.
  function loadBoard(roundKey) {
    return OR.scores
      .top({ roundKey: roundKey, order: "top", limit: BOARD_LIMIT })
      .then(function (rows) {
        if (!hostSupportsGlobalBoard()) {
          hideButtons();
          var err = new Error("scores.top is unsupported on this host");
          err.unsupported = true;
          throw err;
        }
        return rows;
      });
  }

  // The viewer's own placement, for the pinned row under a board they didn't
  // make. Returns undefined — not a function — when this host or this bundle
  // can't do it, so `loadPinned` lands as absent rather than as a hook that
  // always resolves null; the panel tests for the hook's presence to decide
  // whether to fetch anything at all.
  //
  // Gated separately from `scores.top`: the rank verb ships after the board, so
  // a host can serve one and not the other. Also gated on `UI.pinnedFromRank`,
  // because this game reaches the shared UI through a script tag that can be an
  // older bundle than the SDK loaded beside it.
  function pinnedLoaderFor(roundKey) {
    if (!OR.capabilities.has("scores.rank")) return undefined;
    if (typeof UI.pinnedFromRank !== "function") return undefined;
    return function () {
      return OR.scores.rank({ roundKey: roundKey, order: "top" }).then(UI.pinnedFromRank);
    };
  }

  // "Try again" is the wrong thing to say about a host that will never serve
  // this board — the buttons are being retired underneath the user as they read
  // it. Distinguish that from a transient failure, which genuinely is worth a
  // retry. Passed to both tabs, since either can be the call that finds out.
  function boardErrorText(error) {
    return error && error.unsupported
      ? "Leaderboards aren't available in this version of the app."
      : "Couldn't load the leaderboard. Try again.";
  }

  function openLeaderboard() {
    // The timer drains behind a modal, so pause first — application.js installs
    // this hook once the game exists and it's a no-op outside a live run. Absent
    // until then (and if bootstrap failed), hence the typeof guard.
    if (typeof window.Match3PauseForModal === "function") {
      try { window.Match3PauseForModal(); } catch (_) {}
    }

    // Resolved per open, not once at load: a page left open across UTC midnight
    // on the 1st would otherwise keep reading last month's board — and keep
    // reading it under a key application.js has already stopped writing to.
    var period = ROUNDS.currentPeriod();
    var monthRound = ROUNDS.monthRoundKey(period);

    UI.openLeaderboardModal({
      title: "Leaderboard",
      viewerUuid: OR.user && OR.user.uuid ? OR.user.uuid : null,
      tabs: [
        {
          id: "month",
          label: "This Month",
          emptyText: "No scores this month yet — play a game to get on the board.",
          load: function () {
            return loadBoard(monthRound);
          },
          loadPinned: pinnedLoaderFor(monthRound),
          errorText: boardErrorText,
          formatValue: formatScore,
          // Names the month and says the board resets, because neither is
          // deducible from a list of names and scores — and a player who can't
          // see that this table empties on the 1st reads a short board as a dead
          // game rather than as a fresh month.
          renderHeader: function () {
            var note = document.createElement("p");
            note.className = "lb-note";
            var label = typeof UI.formatPeriod === "function" ? UI.formatPeriod(period) : period;
            note.textContent = "Best score in " + label + ". Resets on the 1st.";
            return note;
          }
        },
        {
          id: "alltime",
          label: "All Time",
          emptyText: "No scores yet — play a game to get on the board.",
          load: function () {
            return loadBoard(ROUNDS.HIGHSCORE);
          },
          // This board ossifies (§3.7) — after a few months the top is frozen
          // and a newer player can't appear on it. The pinned row is the only
          // thing that gives them a number of their own to move.
          loadPinned: pinnedLoaderFor(ROUNDS.HIGHSCORE),
          errorText: boardErrorText,
          formatValue: formatScore
        }
      ]
      // No `defaultTab`. The panel opens on the first tab that HAS rows, which
      // is what we want on the 1st of a month: an empty monthly board falls back
      // to All Time instead of greeting the day's first player with a blank
      // table.
    });
  }
})();

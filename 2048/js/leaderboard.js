// 2048 leaderboard modal — two global, public boards backed by the platform
// scores API:
//   • High Scores — top players by best score (roundKey "highscore", order "top")
//   • Hall of Fame — players who've beaten 2048, earliest first (roundKey "win",
//     order "first"), plus a "N players have beaten 2048" line from the win
//     distribution.
//
// The modal, rows, avatars, medals and ranking come from the shared leaderboard
// component (src/ui/leaderboard.ts, loaded as window.OddsRabbitUI). What's left
// here is the 2048-specific part: which rounds, how a value reads, and the
// capability gating on the entry point.
//
// ES5-style vanilla JS to match the rest of 2048 (copied static, not bundled).

(function () {
  var OR = window.OddsRabbit;
  var UI = window.OddsRabbitUI;
  var button = document.querySelector(".leaderboard-button");

  // Hide the entry point on a host that can't serve a global board, rather than
  // opening a modal that always errors.
  //
  // NOTE: do NOT feature-detect `typeof OR.scores.top === "function"` — it ships
  // in every SDK bundle, so that test always passes while the HOST may still not
  // implement the verb (the mobile app lagged the web host by an App Store
  // review). Ask the host via capabilities instead; `has()` also flips to false
  // once a call has been rejected as unsupported, which covers hosts too old to
  // declare capabilities at all.
  if (!OR || !OR.scores || !OR.capabilities || !OR.whenReady || !UI) {
    if (button) button.style.display = "none";
    return;
  }
  if (!button) return;

  var HIGHSCORE_ROUND = "highscore";
  var WIN_ROUND = "win";
  var LIMIT = 20;

  function hideButton() {
    button.style.display = "none";
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
  hideButton();
  OR.whenReady().then(function () {
    if (!hostSupportsGlobalBoard()) return;
    button.style.display = "";
    button.addEventListener("click", openLeaderboard);
  });

  function formatScore(row) {
    return Number(row.score).toLocaleString();
  }

  function formatDate(row) {
    try {
      var d = new Date(row.createdAt);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch (_) {
      return "";
    }
  }

  function sumCounts(distribution) {
    var total = 0;
    if (distribution && distribution.length) {
      for (var i = 0; i < distribution.length; i++) total += distribution[i].count || 0;
    }
    return total;
  }

  // Fetch a board, and retire the entry point if this call is what reveals the
  // host can't serve it. Reaching that branch means the host declared
  // `scores.top` at init and then rejected it anyway — a host too old to declare
  // capabilities, corrected by the SDK's runtime detection. Rejecting (rather
  // than resolving []) keeps the modal from claiming nobody has ever played.
  function loadBoard(roundKey, order) {
    return OR.scores
      .top({ roundKey: roundKey, order: order, limit: LIMIT })
      .then(function (rows) {
        if (!hostSupportsGlobalBoard()) {
          hideButton();
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
  function pinnedLoaderFor(roundKey, order) {
    if (!OR.capabilities.has("scores.rank")) return undefined;
    if (typeof UI.pinnedFromRank !== "function") return undefined;
    return function () {
      return OR.scores.rank({ roundKey: roundKey, order: order }).then(UI.pinnedFromRank);
    };
  }

  // "Try again" is the wrong thing to say about a host that will never serve
  // this board — the button is being retired underneath the user as they read
  // it. Distinguish that from a transient failure, which genuinely is worth a
  // retry. Passed to both tabs, since either can be the call that finds out.
  function boardErrorText(error) {
    return error && error.unsupported
      ? "Leaderboards aren't available in this version of the app."
      : "Couldn't load the leaderboard. Try again.";
  }

  function openLeaderboard() {
    // Count of everyone who has ever won, from the win-round distribution.
    // Stashed by the Hall of Fame tab's load() and read by its header, which the
    // shared component only calls after that load has resolved.
    var winnerCount = 0;

    UI.openLeaderboardModal({
      title: "Leaderboard",
      viewerUuid: OR.user && OR.user.uuid ? OR.user.uuid : null,
      tabs: [
        {
          id: "highscores",
          label: "High Scores",
          emptyText: "No scores yet — play a game to get on the board.",
          load: function () {
            return loadBoard(HIGHSCORE_ROUND, "top");
          },
          // 2048's board is all-time and ossifies (§3.7) — after a few months
          // the top 20 is frozen and no new player can appear on it. The pinned
          // row is the only thing that gives a newer player a number of their
          // own to move, so it matters more here than anywhere else.
          loadPinned: pinnedLoaderFor(HIGHSCORE_ROUND, "top"),
          errorText: boardErrorText,
          formatValue: formatScore
        },
        {
          id: "halloffame",
          label: "Hall of Fame",
          emptyText: "Nobody has reached the 2048 tile yet — be the first!",
          // Ordered by who got there first, not by score — so ranks are
          // positional. Sharing a rank between two 2048-tile wins would claim a
          // tie that the board isn't actually expressing.
          rankTies: false,
          load: function () {
            var rows = loadBoard(WIN_ROUND, "first");
            // The histogram is a nice-to-have next to the board itself: if the
            // host lacks the verb it resolves [] (count 0, line omitted), and a
            // genuine failure shouldn't take the winners list down with it.
            var counts = OR.capabilities.has("scores.distribution")
              ? OR.scores.distribution({ roundKey: WIN_ROUND }).catch(function () { return []; })
              : Promise.resolve([]);
            return Promise.all([rows, counts]).then(function (results) {
              winnerCount = sumCounts(results[1]);
              return results[0];
            });
          },
          // `order: "first"` to match this board — a rank computed by score
          // would point at a completely different row.
          loadPinned: pinnedLoaderFor(WIN_ROUND, "first"),
          errorText: boardErrorText,
          formatValue: formatDate,
          renderHeader: function () {
            if (winnerCount <= 0) return null;
            var p = document.createElement("p");
            p.className = "lb-count";
            var strong = document.createElement("strong");
            strong.textContent = winnerCount.toLocaleString();
            p.appendChild(strong);
            p.appendChild(document.createTextNode(
              winnerCount === 1 ? " player has beaten 2048" : " players have beaten 2048"
            ));
            return p;
          }
        }
      ]
    });
  }

  // No season tab here, deliberately. `scores.season` aggregates a month of
  // DAILY rows, and 2048 has none: its only round keys are the constants
  // "highscore" (submitted with keepBest, so the server holds one row per
  // player, updated in place) and "win" (once per player, ever). There is
  // nothing per-day to collapse, and 2048 isn't in DailyGameRegistry.
  //
  // The motivation was real — all-time boards ossify, and a monthly window
  // would give new players a live target — but it needs a monthly best tracked
  // game-side and submitted under a per-month round key, not a season
  // aggregation. See §3.7 of docs/proposals/unified-leaderboard.md.
})();

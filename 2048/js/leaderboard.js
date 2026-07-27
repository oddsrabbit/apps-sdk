// 2048 leaderboard modal — two global, public boards backed by the platform
// scores API:
//   • High Scores — top players by best score (roundKey "highscore", order "top")
//   • Hall of Fame — players who've beaten 2048, earliest first (roundKey "win",
//     order "first"), plus a "N players have beaten 2048" line from the win
//     distribution.
// ES5-style vanilla JS to match the rest of 2048 (copied static, not bundled).
// Rows are built with createElement + textContent (never innerHTML) so a
// username can never inject markup.

(function () {
  var OR = window.OddsRabbit;
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
  if (!OR || !OR.scores || !OR.capabilities || !OR.whenReady) {
    if (button) button.style.display = "none";
    return;
  }
  if (!button) return;

  function hideButton() {
    button.style.display = "none";
  }

  function showButton() {
    button.style.display = "";
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
    showButton();
    button.addEventListener("click", openLeaderboard);
  });

  var HIGHSCORE_ROUND = "highscore";
  var WIN_ROUND = "win";
  var LIMIT = 20;

  function noop() {}

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function viewerUuid() {
    return OR.user && OR.user.uuid ? OR.user.uuid : null;
  }

  function formatDate(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch (_) {
      return "";
    }
  }

  // Colored-initial avatar with an optional photo layered on top (revealed only
  // once it loads, dropped on error) — mirrors the RabbitGlobe leaderboard.
  function avatarEl(name, url) {
    var clean = (name || "?").replace(/^@/, "");
    var node = el("span", "lb-avatar");
    var h = 0;
    for (var i = 0; i < clean.length; i++) h = (h * 31 + clean.charCodeAt(i)) >>> 0;
    node.style.background = "hsl(" + (h % 360) + " 55% 52%)";
    node.textContent = (clean.charAt(0) || "?").toUpperCase();
    if (url) {
      var img = document.createElement("img");
      img.className = "lb-avatar-img";
      img.alt = "";
      img.src = url;
      img.addEventListener("load", function () { node.classList.add("lb-avatar-has-img"); });
      img.addEventListener("error", function () { if (img.parentNode) img.parentNode.removeChild(img); });
      node.appendChild(img);
    }
    return node;
  }

  var MEDALS = ["🥇", "🥈", "🥉"]; // 🥇🥈🥉

  // Render one board's rows into `listEl`. `valueFn(row)` returns the right-hand
  // text (a score, or a date for the hall of fame). Rank is positional (rows
  // arrive pre-ordered from the server).
  function renderRows(listEl, rows, valueFn) {
    var me = viewerUuid();
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var isSelf = me !== null && row.uuid === me;
      var li = el("li", isSelf ? "lb-row lb-row-you" : "lb-row");

      var rank = i + 1;
      var rankEl = el("span", "lb-rank", rank <= 3 ? MEDALS[rank - 1] : String(rank));

      var name = row.username ? "@" + row.username : "player";
      var nameEl = el("span", "lb-name", isSelf ? name + " (you)" : name);

      var valueEl = el("span", "lb-value", valueFn(row));

      li.appendChild(rankEl);
      li.appendChild(avatarEl(name, row.avatar || null));
      li.appendChild(nameEl);
      li.appendChild(valueEl);
      listEl.appendChild(li);
    }
  }

  function renderBoard(container, title, rows, valueFn, emptyText) {
    var section = el("section", "lb-section");
    section.appendChild(el("h3", "lb-section-title", title));
    if (!rows || rows.length === 0) {
      section.appendChild(el("p", "lb-empty", emptyText));
    } else {
      var list = el("ul", "lb-list");
      renderRows(list, rows, valueFn);
      section.appendChild(list);
    }
    container.appendChild(section);
  }

  function sumCounts(distribution) {
    var total = 0;
    if (distribution && distribution.length) {
      for (var i = 0; i < distribution.length; i++) total += distribution[i].count || 0;
    }
    return total;
  }

  function openLeaderboard() {
    // Only one modal at a time.
    var existing = document.querySelector(".lb-backdrop");
    if (existing) existing.parentNode.removeChild(existing);

    var backdrop = el("div", "lb-backdrop");
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-label", "2048 leaderboard");

    var modal = el("div", "lb-modal");
    var header = el("div", "lb-modal-header");
    header.appendChild(el("h2", "lb-modal-title", "Leaderboard"));
    var closeBtn = el("button", "lb-close", "×"); // ×
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    header.appendChild(closeBtn);
    modal.appendChild(header);

    var body = el("div", "lb-modal-body");
    body.appendChild(el("p", "lb-loading", "Loading…"));
    modal.appendChild(body);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    function close() {
      document.removeEventListener("keydown", onKey);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", function (e) { if (e.target === backdrop) close(); });
    closeBtn.addEventListener("click", close);

    // Fetch all three in parallel. An UNSUPPORTED verb resolves to [] rather
    // than rejecting (the SDK swallows those), so a host missing one of the
    // three still renders the rest. Every other failure — network, auth, a
    // malformed request — still rejects, and the .catch below blanks the modal
    // with a retry message, which is the honest answer for a transient fault.
    Promise.all([
      OR.scores.top({ roundKey: HIGHSCORE_ROUND, order: "top", limit: LIMIT }),
      OR.scores.top({ roundKey: WIN_ROUND, order: "first", limit: LIMIT }),
      OR.capabilities.has("scores.distribution")
        ? OR.scores.distribution({ roundKey: WIN_ROUND })
        : Promise.resolve([])
    ]).then(function (results) {
      if (!backdrop.parentNode) return; // closed while loading

      // The reads resolve to [] rather than rejecting when the host doesn't
      // implement the verb, so re-check afterwards. Reaching here means the
      // host declared scores.top at init and then rejected it anyway (a host
      // too old to declare capabilities, corrected by runtime detection), so
      // retire the button instead of claiming nobody has played. Say why rather
      // than yanking the modal shut — an unexplained disappearance reads as a
      // crash, and the button is about to vanish too.
      if (!hostSupportsGlobalBoard()) {
        hideButton();
        body.textContent = "";
        body.appendChild(el("p", "lb-empty", "Leaderboards aren't available in this version of the app."));
        return;
      }

      var highScores = results[0] || [];
      var winners = results[1] || [];
      var winnerCount = sumCounts(results[2] || []);

      body.textContent = "";

      renderBoard(
        body,
        "High Scores",
        highScores,
        function (row) { return Number(row.score).toLocaleString(); },
        "No scores yet — play a game to get on the board."
      );

      if (winnerCount > 0) {
        var count = el("p", "lb-count");
        var strong = el("strong", null, winnerCount.toLocaleString());
        count.appendChild(strong);
        count.appendChild(document.createTextNode(
          winnerCount === 1 ? " player has beaten 2048" : " players have beaten 2048"
        ));
        body.appendChild(count);
      }

      renderBoard(
        body,
        "Hall of Fame",
        winners,
        function (row) { return formatDate(row.createdAt); },
        "Nobody has reached the 2048 tile yet — be the first!"
      );
    }).catch(function () {
      if (!backdrop.parentNode) return;
      body.textContent = "";
      body.appendChild(el("p", "lb-empty", "Couldn't load the leaderboard. Try again."));
    });
  }
})();

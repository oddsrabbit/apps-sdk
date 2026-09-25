// Bootstrap and screens for Rabbit Word Battle, slug `rabbit-word-battle`.
//
// Three screens: the match list, the new-game setup, and one match. Every
// piece of game state on screen comes from the server's per-viewer MatchView
// (`OR.matches.get` / the `watch` poll): this file holds only the tiles the
// player is in the middle of laying down (`pending`) and which tile is
// selected. A move is sent as an ACTION — the tiles placed, the letters
// exchanged, or a pass — and the server answers with the new view or a
// `match/*` reason, which is shown verbatim.
//
// The whole multiplayer surface is gated on `capabilities.has('matches.get')`
// after `whenReady()`: the mobile host ships these verbs behind App Store
// review, and a button that always fails is worse than no button.
//
// Rendering rules shared with every game here: usernames go through
// `textContent`, never `innerHTML`; avatars come from the shared leaderboard
// component so they hash to the same colour everywhere. (The one `innerHTML`
// below writes a fixed how-to-play string with nothing interpolated into it.)

(function () {
  var OR = window.OddsRabbit;
  var UI = window.OddsRabbitUI;
  var Rules = window.TilesRules;
  if (!OR) {
    showFatal("This game needs to run inside the OddsRabbit app or website.");
    return;
  }

  // The RULES-CLASS id the server selects on, not the app slug. It stays
  // "tiles" whatever the game is called: it is stored in `game` on every match
  // row, `MatchService::rulesFor()` switches on it, and `TilesRules::gameId()`
  // returns it. Renaming it would need a PHP change and a migration of live
  // matches to buy nothing a player can see.
  var GAME = "tiles";
  var GAME_NAME = "Rabbit Word Battle";
  var LANDING_URL = "https://www.oddsrabbit.com/games/rabbit-word-battle/";
  var JOIN_STASH = "rwb.joinCode";
  var LIST_POLL_MS = 20000;
  // `matches.invitable` answers at most 200 rows per call, so a follow graph
  // bigger than that has to be paged with `offset` — otherwise search runs
  // over a truncated list and reports people missing who are not.
  var INVITABLE_PAGE = 200;
  // 20 pages is 4000 people, past any real follow graph, and it bounds the
  // work if a host ever answers pages that never shorten.
  var INVITABLE_MAX_PAGES = 20;
  // Below this many people a search field is just another thing on screen.
  var SEARCH_THRESHOLD = 8;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var els = {
    screens: {
      list: $(".screen-list"),
      "new": $(".screen-new"),
      match: $(".screen-match")
    },
    listBody: $(".match-list"),
    listStatus: $(".list-status"),
    hero: $(".hero"),
    heroActions: $(".hero-actions"),
    actionBar: $(".action-bar"),
    newGameButtons: $$(".new-game-button"),
    joinOpenButtons: $$(".join-open-button"),
    helpButtons: $$(".help-button"),
    signIn: $(".sign-in"),
    signInNote: $(".sign-in-note"),
    unsupported: $(".unsupported"),
    invitableList: $(".invitable-list"),
    invitableEmpty: $(".invitable-empty"),
    inviteSearch: $(".invite-search"),
    inviteInput: $(".invite-input"),
    inviteCount: $(".invite-count"),
    inviteClear: $(".invite-clear"),
    seats: $(".seats-value"),
    seatsMinus: $(".seats-minus"),
    seatsPlus: $(".seats-plus"),
    tableNote: $(".table-note"),
    createButton: $(".create-button"),
    createStatus: $(".create-status"),
    backButtons: $$(".back-button"),
    players: $(".players"),
    menuButton: $(".menu-button"),
    turnMain: $(".turn-main"),
    chipTimer: $(".chip-timer"),
    chipBag: $(".chip-bag"),
    turnWarning: $(".turn-warning"),
    lastMove: $(".last-move"),
    lobbyPanel: $(".lobby-panel"),
    lobbyLead: $(".lobby-lead"),
    lobbyCode: $(".lobby-code"),
    lobbySeats: $(".lobby-seats"),
    shareCodeButton: $(".share-code-button"),
    boardWrap: $(".board-wrap"),
    boardCanvas: $(".board-canvas"),
    boardStatus: $(".board-status"),
    zoomIn: $(".zoom-in"),
    zoomOut: $(".zoom-out"),
    zoomFit: $(".zoom-fit"),
    scorePop: $(".score-pop"),
    rack: $(".rack"),
    preview: $(".preview"),
    playButton: $(".play-button"),
    recallButton: $(".recall-button"),
    shuffleButton: $(".shuffle-button"),
    exchangeButton: $(".exchange-button"),
    passButton: $(".pass-button"),
    over: $(".game-over"),
    overTitle: $(".game-over-title"),
    overText: $(".game-over-text"),
    overBack: $(".game-over-back"),
    dialogWrap: $(".dialog-backdrop"),
    dialogCard: $(".dialog"),
    dialogTitle: $(".dialog-title"),
    dialogBody: $(".dialog-body"),
    dialogConfirm: $(".dialog-confirm"),
    dialogCancel: $(".dialog-cancel"),
    toast: $(".toast")
  };

  var state = {
    screen: "list",
    match: null,
    pending: [],
    rackFree: [],
    selectedRack: null,
    dragSlot: null,
    stopWatch: null,
    invitable: [],
    inviteQuery: "",
    inviteCapped: false,
    inviteRun: 0,
    invitees: {},
    open: false,
    seats: 2,
    busy: false,
    rows: [],
    listSignature: "",
    listTimer: null,
    lastPlayed: null,
    announcedPly: null,
    pendingFocus: undefined
  };

  var board = null;
  var dialogState = null;

  // ------------------------------------------------------------ utilities

  function showFatal(text) {
    var node = document.querySelector(".fatal");
    if (node) { node.textContent = text; node.hidden = false; }
  }

  function toast(text, isError) {
    els.toast.textContent = text;
    els.toast.classList.toggle("is-error", !!isError);
    els.toast.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { els.toast.hidden = true; }, 3200);
  }

  function haptic(kind) {
    try { OR.actions.haptic(kind); } catch (_) {}
  }

  // Hosts differ in how much of a rejection survives the bridge: some pass the
  // rules class's reason through ("not-a-word: QZX"), others flatten every
  // failure to one generic sentence. When the text says nothing specific, the
  // error code is the only thing left that does, so it goes in the message
  // rather than being dropped on the floor.
  var GENERIC_ERROR = /^(match|bridge)?\s*operation failed\.?$|^(request|operation) failed\.?$|^error\.?$/i;

  function errorText(err, fallback) {
    var message = err && typeof err.message === "string" ? err.message.trim() : "";
    var code = errorCode(err);
    if (message && (!GENERIC_ERROR.test(message) || !code)) return message;
    if (code) {
      if (message) console.warn("[word-battle]", code, err);
      return (message || fallback) + " (" + code + ")";
    }
    return message || fallback;
  }

  function errorCode(err) {
    return err && typeof err.code === "string" ? err.code : "";
  }

  // The clock, when a game has one. Rabbit Word Battle does not: TilesRules
  // returns a deadline of 0 and the server sends `turnDeadline: null`, so the
  // chip and the warning never render. The code stays because the deadline is
  // a per-game rule, not a platform one, and a game that wants a clock should
  // get the urgent styling rather than a grey aside nobody reads.
  function deadline(iso) {
    if (!iso) return null;
    var ms = new Date(iso).getTime() - Date.now();
    if (isNaN(ms)) return null;
    if (!(ms > 0)) return { ms: 0, text: "Overdue", level: "urgent" };
    var hours = ms / 3600000;
    var text;
    if (hours >= 48) text = Math.floor(hours / 24) + "d left";
    else if (hours >= 1) text = Math.floor(hours) + "h left";
    else text = Math.max(1, Math.round(ms / 60000)) + "m left";
    return { ms: ms, text: text, level: hours < 1 ? "urgent" : hours < 6 ? "soon" : "" };
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function avatar(username, url) {
    if (UI && typeof UI.leaderboardAvatar === "function") return UI.leaderboardAvatar(username, url);
    return el("span", "avatar-fallback", (username || "?").charAt(0).toUpperCase());
  }

  function meIn(view) {
    for (var i = 0; i < view.players.length; i++) if (view.players[i].isSelf) return view.players[i];
    return null;
  }

  function opponentsOf(view) {
    return view.players.filter(function (p) { return !p.isSelf; });
  }

  function nameOf(player) {
    return player.isSelf ? "You" : "@" + player.username;
  }

  function boardIsEmpty(grid) {
    return !grid || grid.every(function (row) {
      return row.every(function (cell) { return cell === null; });
    });
  }

  function showScreen(name) {
    state.screen = name;
    Object.keys(els.screens).forEach(function (key) { els.screens[key].hidden = key !== name; });
    if (name !== "match") stopWatching();
    // The board is sized from its box, and its box is 0x0 while the screen is
    // hidden — so it has to be measured again once the screen is up, or every
    // match opens one pixel wide.
    //
    // Measure synchronously first: the screen is visible as of the line above,
    // so this reads the real box, and it is the only path that does not depend
    // on a callback the host might never run (rAF is throttled in a hidden or
    // backgrounded WebView, and ResizeObserver is not everywhere). The frame
    // callback stays as a follow-up for hosts that defer layout.
    if (name === "match" && board) {
      board.resize();
      applyPendingFocus();
      requestAnimationFrame(function () {
        board.resize();
        applyPendingFocus();
      });
    }
  }

  // The opening zoom, applied the moment the board actually has a size —
  // whichever of the resize observer or the frame callback gets there first.
  function applyPendingFocus() {
    if (!board || state.pendingFocus === undefined || !board.hasSize()) return;
    board.openAt(state.pendingFocus);
    state.pendingFocus = undefined;
  }

  // A join code that arrived before the player was signed in. `requestSignIn`
  // can take the WebView away and bring it back on a fresh load, so the
  // invite has to survive that or the friend who tapped the link lands on an
  // empty list with no idea what happened.
  function stashJoin(code) { try { sessionStorage.setItem(JOIN_STASH, code); } catch (_) {} }
  function peekJoin() { try { return sessionStorage.getItem(JOIN_STASH); } catch (_) { return null; } }
  function takeJoin() {
    var code = peekJoin();
    try { sessionStorage.removeItem(JOIN_STASH); } catch (_) {}
    return code;
  }

  // ------------------------------------------------------------- dialog

  // One modal for every prompt in the game: blank-letter picking, exchanging,
  // the match menu, join-by-code, how-to-play and the two confirmations that
  // used to be `window.confirm` (which in a WebView prints the origin above
  // the question and can be suppressed outright).
  function dialogFocusables() {
    return $$("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])", els.dialogCard)
      .filter(function (node) { return !node.hidden && !node.disabled && node.offsetParent !== null; });
  }

  function openDialog(opts) {
    if (dialogState) closeDialog(null);
    var restore = document.activeElement;
    els.dialogTitle.textContent = opts.title;
    els.dialogBody.className = "dialog-body"
      + (opts.prose ? " is-prose" : "")
      + (opts.menu ? " is-menu" : "");
    clear(els.dialogBody);
    var api = (opts.build ? opts.build(els.dialogBody, function (result) { closeDialog(result); }) : null) || {};
    els.dialogConfirm.hidden = !opts.confirmLabel;
    els.dialogConfirm.textContent = opts.confirmLabel || "OK";
    els.dialogConfirm.classList.toggle("is-danger", !!opts.danger);
    els.dialogCancel.hidden = opts.cancelLabel === null;
    els.dialogCancel.textContent = opts.cancelLabel || "Cancel";
    els.dialogWrap.hidden = false;
    // For the host, which reads the colour the status bar sits on from <html>
    // (styles.css, html[data-overlay]).
    document.documentElement.setAttribute("data-overlay", "dialog");
    dialogState = { api: api, done: opts.onClose || function () {}, restore: restore };
    els.dialogCard.scrollTop = 0;
    // Focusing a footer button inside a scrolling card scrolls the card to it,
    // so a long read (how to play) would open at its last line. Prose takes
    // the card itself; everything else takes the button it is about to press.
    var target = api.focus || (opts.prose ? els.dialogCard : (opts.confirmLabel ? els.dialogConfirm : els.dialogCancel));
    setTimeout(function () {
      if (target && target.focus) target.focus();
      els.dialogCard.scrollTop = 0;
    }, 0);
  }

  function closeDialog(result) {
    if (!dialogState) return;
    var current = dialogState;
    dialogState = null;
    els.dialogWrap.hidden = true;
    document.documentElement.removeAttribute("data-overlay");
    clear(els.dialogBody);
    if (current.restore && current.restore.focus) {
      try { current.restore.focus(); } catch (_) {}
    }
    current.done(result);
  }

  function wireDialog() {
    els.dialogConfirm.addEventListener("click", function () {
      if (!dialogState) return;
      closeDialog(dialogState.api.value ? dialogState.api.value() : true);
    });
    els.dialogCancel.addEventListener("click", function () { closeDialog(null); });
    els.dialogWrap.addEventListener("click", function (e) {
      if (e.target === els.dialogWrap) closeDialog(null);
    });
    els.dialogWrap.addEventListener("keydown", function (e) {
      if (!dialogState) return;
      if (e.key === "Escape") { e.preventDefault(); closeDialog(null); return; }
      if (e.key !== "Tab") return;
      var list = dialogFocusables();
      if (!list.length) return;
      e.preventDefault();
      var index = list.indexOf(document.activeElement);
      var next = e.shiftKey
        ? (index <= 0 ? list.length - 1 : index - 1)
        : (index === -1 || index === list.length - 1 ? 0 : index + 1);
      list[next].focus();
    });
  }

  function confirmDialog(opts, done) {
    openDialog({
      title: opts.title,
      prose: true,
      danger: opts.danger,
      confirmLabel: opts.confirmLabel || "OK",
      cancelLabel: opts.cancelLabel || "Cancel",
      build: function (body) {
        if (opts.text) body.appendChild(el("p", "muted", opts.text));
        return { value: function () { return true; } };
      },
      onClose: function (result) { if (result === true) done(); }
    });
  }

  // ------------------------------------------------------------ how to play

  // The rules-heaviest game on the platform shipped without a word of
  // explanation: premium squares were bare abbreviations, and nothing said
  // that letting the clock run out loses the game outright.
  var HOW_TO_HTML = [
    '<div class="howto">',
    '<h3>The idea</h3>',
    '<p>Take turns building words on the board, crossword style. Highest score when the tiles run out wins. There is no clock to sit at — a turn lasts days.</p>',
    '<h3>Your turn</h3>',
    '<ul>',
    '<li>Drag a tile from your rack onto a square — or tap the tile, then the square. Dashed squares show where it would connect.</li>',
    '<li>Drag a tile sideways along the rack to reorder it; rearranging is how words turn up.</li>',
    '<li>Tap a tile you have placed to take it back, or use <strong>Recall</strong> for all of them.</li>',
    '<li>The first word of the game must cover the ★ centre square. Every word after that has to touch what is already on the board.</li>',
    '<li>Your tiles must all land in one row or one column, with no gaps once the letters already there are counted.</li>',
    '<li>Nothing is sent until you press <strong>Play</strong>. The server checks the words against the dictionary and hands the tiles back if one is not in it.</li>',
    '</ul>',
    '<h3>Premium squares</h3>',
    '<p>They count only the first time a tile covers them. Letter multipliers apply first, then word multipliers.</p>',
    '<div class="legend">',
    '<span class="legend-swatch sq-star">★</span><span>Centre — the first word must cross it</span>',
    '<span class="legend-swatch sq-l"><b>2×</b><i>LETTER</i></span><span>That letter scores double</span>',
    '<span class="legend-swatch sq-L"><b>3×</b><i>LETTER</i></span><span>That letter scores triple</span>',
    '<span class="legend-swatch sq-w"><b>2×</b><i>WORD</i></span><span>The whole word scores double</span>',
    '<span class="legend-swatch sq-W"><b>3×</b><i>WORD</i></span><span>The whole word scores triple</span>',
    '</div>',
    '<h3>Tiles</h3>',
    '<ul>',
    '<li>The small number is what the letter is worth.</li>',
    '<li>A <strong>blank</strong> (?) can stand in for any letter, but scores nothing — you pick the letter as you place it.</li>',
    '<li>Use all seven tiles in one turn for a <strong>bingo</strong>: +50 on top of the word.</li>',
    '<li><strong>Swap</strong> trades tiles back into the bag and ends your turn. <strong>Pass</strong> ends it for nothing — two full rounds of passes end the game.</li>',
    '</ul>',
    '<h3>Who you can play</h3>',
    '<p>You can invite people you follow, or who follow you — nobody can drop a stranger into your game. To play with anyone else, start an <strong>open table</strong>: it gives you a six-character code, and whoever you send it to can take a seat.</p>',
    '<h3>Taking your time</h3>',
    '<p>There is no turn clock. Take as long as you like between moves — nobody is timed out, and no game is lost by not opening it. If you want out of one, use <strong>Resign</strong> from the ⋯ menu.</p>',
    '<h3 class="keys">Keyboard</h3>',
    '<div class="keys"><ul>',
    '<li>Arrow keys move the caret and set which way typing runs.</li>',
    '<li>Type a letter to place it; a blank is used automatically if you have no matching tile.</li>',
    '<li><strong>Backspace</strong> takes the last tile back, <strong>Enter</strong> plays, <strong>Esc</strong> recalls everything.</li>',
    '</ul></div>',
    '</div>'
  ].join("");

  function showHowTo() {
    openDialog({
      title: "How to play",
      prose: true,
      cancelLabel: "Close",
      build: function (body) {
        var wrap = document.createElement("div");
        wrap.innerHTML = HOW_TO_HTML; // fixed string, nothing interpolated
        body.appendChild(wrap);
        return {};
      }
    });
  }

  // ------------------------------------------------------------- list

  function loadList(quiet) {
    if (!quiet) els.listStatus.textContent = "Loading…";
    return OR.matches.list({ status: "all", limit: 100 }).then(function (rows) {
      els.listStatus.textContent = "";
      state.rows = rows;
      renderList(rows);
    }).catch(function (err) {
      if (!quiet) els.listStatus.textContent = errorText(err, "Couldn't load your games.");
    });
  }

  function startListPolling() {
    stopListPolling();
    state.listTimer = setInterval(function () {
      if (state.screen !== "list" || document.hidden || dialogState) return;
      loadList(true);
    }, LIST_POLL_MS);
  }

  function stopListPolling() {
    if (state.listTimer) { clearInterval(state.listTimer); state.listTimer = null; }
  }

  function listSignature(rows) {
    return rows.map(function (m) {
      return [m.matchUuid, m.status, m.isMyTurn ? 1 : 0, m.turnDeadline || "",
        m.players.map(function (p) { return p.score + ":" + p.status; }).join("/")].join("|");
    }).join(";");
  }

  function renderList(rows) {
    var groups = [
      { title: "Your move", rows: rows.filter(function (m) { return m.status === "active" && m.isMyTurn; }) },
      { title: "Their move", rows: rows.filter(function (m) { return m.status === "active" && !m.isMyTurn; }) },
      { title: "Waiting for players", rows: rows.filter(function (m) { return m.status === "lobby"; }) },
      { title: "Finished", rows: rows.filter(function (m) { return m.status === "finished" || m.status === "abandoned"; }) }
    ];
    var any = groups.some(function (g) { return g.rows.length > 0; });

    // The landing has two shapes. With nothing to show, a centred hero holds
    // the only two things worth doing; with games, the list is the screen and
    // those actions drop to a bar at the bottom where they cannot push the
    // list off the fold.
    els.hero.hidden = any;
    els.actionBar.hidden = !any;

    // Re-rendering identical rows every poll would throw away the player's
    // scroll position twice a minute.
    var signature = listSignature(rows);
    if (signature === state.listSignature && els.listBody.firstChild) return;
    state.listSignature = signature;

    var scroll = els.listBody.scrollTop;
    clear(els.listBody);
    groups.forEach(function (group) {
      if (!group.rows.length) return;
      els.listBody.appendChild(el("h2", "group-title", group.title));
      group.rows.forEach(function (m) { els.listBody.appendChild(renderRow(m)); });
    });
    els.listBody.scrollTop = scroll;
  }

  // "12 – 30" in seat order could not answer the only question a player has
  // looking at this list, which is whether they are winning.
  function scoreLine(m) {
    var frag = document.createDocumentFragment();
    var me = meIn(m);
    var ordered = (me ? [me] : []).concat(opponentsOf(m));
    var best = Math.max.apply(null, ordered.map(function (p) { return p.score; }));
    ordered.forEach(function (p, i) {
      if (i) frag.appendChild(document.createTextNode(" · "));
      frag.appendChild(document.createTextNode(nameOf(p) + " "));
      var cls = p.score === best ? "lead" : "trail";
      frag.appendChild(el("span", p.isSelf ? cls : "", String(p.score)));
    });
    return frag;
  }

  function renderRow(m) {
    var row = el("button", "match-row");
    row.type = "button";
    var faces = el("div", "match-faces");
    var opponents = opponentsOf(m);
    (opponents.length ? opponents : m.players).slice(0, 3).forEach(function (p) {
      faces.appendChild(avatar(p.username, p.avatar));
    });
    row.appendChild(faces);

    var text = el("div", "match-text");
    var names = opponents.length ? opponents.map(function (p) { return "@" + p.username; }).join(", ") : "Open table";
    text.appendChild(el("div", "match-names", names));
    var detail = el("div", "match-detail");
    var me = meIn(m);
    var clock = m.isMyTurn ? deadline(m.turnDeadline) : null;
    if (m.status === "finished") {
      detail.appendChild(document.createTextNode(
        (m.winnerSeat === null ? "Draw" : (me && m.winnerSeat === me.seat ? "Won" : "Lost")) + " · "));
      detail.appendChild(scoreLine(m));
    } else if (m.status === "abandoned") {
      detail.textContent = "Abandoned";
    } else if (m.status === "lobby") {
      detail.textContent = m.players.length + " of " + m.maxPlayers + " seated · code " + (m.joinCode || "—");
    } else {
      detail.appendChild(scoreLine(m));
      if (clock) detail.appendChild(document.createTextNode(" · " + clock.text));
    }
    text.appendChild(detail);
    row.appendChild(text);

    if (m.isMyTurn) {
      var badge = el("span", "badge" + (clock && clock.level === "urgent" ? " is-urgent" : ""), "Play");
      row.appendChild(badge);
    }
    row.setAttribute("aria-label", names + ". " + detail.textContent + (m.isMyTurn ? ". Your move." : ""));
    row.addEventListener("click", function () {
      if (row.classList.contains("is-busy")) return;
      row.classList.add("is-busy");
      openMatch(m.matchUuid).then(function () {
        row.classList.remove("is-busy");
      });
    });
    return row;
  }

  function openJoinDialog() {
    openDialog({
      title: "Join a game",
      prose: true,
      confirmLabel: "Join",
      build: function (body, close) {
        body.appendChild(el("p", "muted", "Enter the six-character code your friend shared."));
        var input = document.createElement("input");
        input.className = "join-field";
        input.type = "text";
        input.inputMode = "text";
        input.autocapitalize = "characters";
        input.autocomplete = "off";
        input.maxLength = 6;
        input.placeholder = "ABC123";
        input.setAttribute("aria-label", "Join code");
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); close(input.value); }
        });
        body.appendChild(input);
        return { focus: input, value: function () { return input.value; } };
      },
      onClose: function (code) { if (code) joinByCode(code); }
    });
  }

  // -------------------------------------------------------------- new game

  function openNewGame() {
    state.invitees = {};
    state.open = false; // derived in renderSeats from the seats left spare
    state.seats = 2;
    state.inviteQuery = "";
    state.inviteCapped = false;
    els.inviteInput.value = "";
    els.inviteSearch.hidden = true;
    els.createStatus.textContent = "";
    renderSeats();
    showScreen("new");
    els.invitableEmpty.hidden = true;
    els.inviteCount.textContent = "";
    clear(els.invitableList);
    els.invitableList.appendChild(el("p", "muted", "Loading people you can invite…"));
    loadInvitable();
  }

  /**
   * Fetch the whole invitable set, a page at a time.
   *
   * The stop conditions are what make this safe on a host that has never heard
   * of `offset`: such a host answers every page with the first one, so the
   * second page contributes no unseen uuids and the loop ends there — exactly
   * today's behaviour, no worse. A short page means the end of the set, and
   * the page budget bounds everything else.
   *
   * Each page renders as it lands, so the picker is usable on the first 200
   * while the rest arrive rather than sitting on a spinner.
   */
  function loadInvitable() {
    var seen = {};
    var run = state.inviteRun = (state.inviteRun || 0) + 1;
    state.invitable = [];
    state.inviteCapped = false;

    function page(offset, budget) {
      return OR.matches.invitable({ limit: INVITABLE_PAGE, offset: offset }).then(function (rows) {
        if (run !== state.inviteRun) return; // the screen was reopened
        var fresh = 0;
        rows.forEach(function (person) {
          if (!person || seen[person.uuid]) return;
          seen[person.uuid] = true;
          state.invitable.push(person);
          fresh++;
        });
        var done = !fresh || rows.length < INVITABLE_PAGE;
        if (done) {
          // A FULL page that repeated rows we already hold means the host
          // ignored `offset` — so there may be people past it we cannot
          // reach, and the picker should say it is showing a partial set. A
          // compliant host with exactly 200 people answers page 2 with [],
          // which is a short page and correctly not treated as truncation.
          if (!fresh && rows.length >= INVITABLE_PAGE) state.inviteCapped = true;
          renderInvitable();
          return;
        }
        if (budget <= 1) { state.inviteCapped = true; renderInvitable(); return; }
        renderInvitable();
        return page(offset + rows.length, budget - 1);
      });
    }

    return page(0, INVITABLE_MAX_PAGES).catch(function () {
      if (run !== state.inviteRun) return;
      renderInvitable();
    });
  }

  // `relation` is the viewer's side of the follow edge. Only two of the three
  // are worth a badge: that someone follows you is the non-obvious half.
  var RELATION_LABEL = { mutual: "mutual", follower: "follows you" };

  // Mutuals first, then people who follow you, then people you follow;
  // alphabetical inside each. The server treats all three the same — this is
  // only about which name a player is most likely to be hunting for.
  var RELATION_RANK = { mutual: 0, follower: 1, following: 2 };
  function byRelationThenName(a, b) {
    var ra = RELATION_RANK[a.relation], rb = RELATION_RANK[b.relation];
    if (ra !== rb) return (ra === undefined ? 9 : ra) - (rb === undefined ? 9 : rb);
    return a.username.toLowerCase() < b.username.toLowerCase() ? -1 : 1;
  }

  function inviteRow(person) {
    var label = el("label", "invitable-row");
    var box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!state.invitees[person.uuid];
    box.addEventListener("change", function () {
      if (box.checked) {
        if (Object.keys(state.invitees).length >= 3) {
          box.checked = false;
          toast("Up to three friends per table.");
          return;
        }
        state.invitees[person.uuid] = person;
      } else {
        delete state.invitees[person.uuid];
      }
      renderSeats();
      renderInvitable();
    });
    label.appendChild(box);
    label.appendChild(avatar(person.username, person.avatar));
    label.appendChild(el("span", "invitable-name", "@" + person.username));
    var relation = RELATION_LABEL[person.relation];
    if (relation) label.appendChild(el("span", "muted small relation", relation));
    return label;
  }

  function renderInvitable() {
    // Ticking a box re-renders the list to regroup it; without this the
    // roster jumps back to the top every time someone is picked.
    var scroll = els.invitableList.scrollTop;
    clear(els.invitableList);
    var total = state.invitable.length;
    var query = state.inviteQuery.trim().toLowerCase();
    els.inviteSearch.hidden = total <= SEARCH_THRESHOLD;

    var ordered = state.invitable.slice().sort(byRelationThenName);
    var matches = function (p) { return !query || p.username.toLowerCase().indexOf(query) !== -1; };
    // Anyone already picked stays on screen whatever is typed, so a selection
    // cannot quietly scroll out of the list mid-search.
    var picked = ordered.filter(function (p) { return !!state.invitees[p.uuid]; });
    var rest = ordered.filter(function (p) { return !state.invitees[p.uuid] && matches(p); });
    // Counted over everyone, not just the unpicked: someone you already
    // invited still matches what you typed, and saying "0 match" with their
    // row on screen reads as a bug.
    var matchCount = ordered.filter(matches).length;

    if (picked.length && query) els.invitableList.appendChild(el("div", "invite-group", "Invited"));
    picked.forEach(function (p) { els.invitableList.appendChild(inviteRow(p)); });
    if (picked.length && query && rest.length) els.invitableList.appendChild(el("div", "invite-group", "Results"));
    rest.forEach(function (p) { els.invitableList.appendChild(inviteRow(p)); });

    els.inviteClear.hidden = !els.inviteInput.value;

    // `total` is however many rows came back, and when that equals the limit we
    // asked for, it is a truncation rather than a count — so it must not be
    // read out as "of 200 people". Search only covers what was fetched, and
    // saying so is the difference between "they are not on here" and "they are
    // not in the part of the list I can see".
    var capped = state.inviteCapped;
    els.inviteCount.textContent = !total ? ""
      : query
        ? (matchCount === 0 ? "" // the empty-state line below says this better
          : matchCount + " of " + (capped ? "the first " + total : String(total))
            + " match “" + state.inviteQuery.trim() + "”")
      : capped
        ? "Showing " + total + " — search to narrow it down"
        : total + " " + (total === 1 ? "person" : "people") + " you can invite";

    // The rule itself lives in the note above the list, which is always on
    // screen; this only has to cover the two empty cases.
    var nothing = !picked.length && !rest.length;
    els.invitableEmpty.hidden = !nothing;
    if (nothing) {
      els.invitableEmpty.textContent = !total
        ? "Nobody to invite yet — follow a few people, or start the table anyway and share the code."
        : "Nobody matching that — you can only invite people you follow or who follow you. Share the join code with anyone else.";
    }
    els.invitableList.scrollTop = scroll;
  }

  // Who is at the table, written out. Usernames go through textContent like
  // everywhere else — this builds a plain string, never markup.
  function seatedNames() {
    var names = Object.keys(state.invitees).map(function (uuid) {
      return "@" + state.invitees[uuid].username;
    });
    if (!names.length) return "You";
    if (names.length === 1) return "You and " + names[0];
    return "You, " + names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  }

  // Seats and invitees are the only two things to set, and `open` is derived
  // from them rather than asked about: every seat an invitee does not take is
  // one only a join code can fill, so the code is minted exactly when there is
  // a seat left over. Start is never disabled — there is no invalid state left
  // to guard against.
  function renderSeats() {
    var invited = Object.keys(state.invitees).length;
    var floor = Math.max(2, invited + 1);
    state.seats = Math.min(4, Math.max(floor, state.seats));
    var spare = state.seats - 1 - invited;
    state.open = spare > 0;

    els.seats.textContent = String(state.seats);
    els.seatsMinus.disabled = state.seats <= floor;
    els.seatsPlus.disabled = state.seats >= 4;

    clear(els.tableNote);
    els.tableNote.appendChild(document.createTextNode(seatedNames() + ", "));
    if (spare > 0) {
      els.tableNote.appendChild(el("span", "code-hint",
        "plus " + spare + " empty seat" + (spare > 1 ? "s" : "") + "."));
      els.tableNote.appendChild(document.createTextNode(
        " You'll get a join code — whoever you send it to takes " + (spare > 1 ? "a seat" : "the seat") + "."));
    } else {
      els.tableNote.appendChild(el("span", "code-hint", "and that's everyone."));
      els.tableNote.appendChild(document.createTextNode(" The game starts as soon as you press Start."));
    }
    els.createStatus.textContent = "";
    els.createButton.disabled = false;
  }

  function createMatch() {
    if (state.busy) return;
    state.busy = true;
    els.createButton.disabled = true;
    els.createStatus.textContent = "Setting the table…";
    OR.matches.create({
      game: GAME,
      maxPlayers: state.seats,
      invitees: Object.keys(state.invitees),
      open: state.open
    }).then(function (view) {
      state.busy = false;
      haptic("success");
      enterMatch(view);
    }).catch(function (err) {
      state.busy = false;
      els.createButton.disabled = false;
      els.createStatus.textContent = errorText(err, "Couldn't create the game.");
    });
  }

  function joinByCode(code) {
    code = (code || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) { toast("Codes are six letters or digits.", true); return; }
    els.listStatus.textContent = "Joining " + code + "…";
    OR.matches.join({ joinCode: code }).then(function (view) {
      els.listStatus.textContent = "";
      haptic("success");
      enterMatch(view);
    }).catch(function (err) {
      els.listStatus.textContent = "";
      toast(errorText(err, "Couldn't join that table."), true);
    });
  }

  // ---------------------------------------------------------------- match

  function openMatch(uuid) {
    return OR.matches.get({ matchUuid: uuid }).then(enterMatch).catch(function (err) {
      toast(errorText(err, "Couldn't open that game."), true);
    });
  }

  function enterMatch(view) {
    state.pending = [];
    state.selectedRack = null;
    state.lastPlayed = null;
    state.announcedPly = view.lastMove ? view.lastMove.ply : null;
    applyView(view, true);
    showScreen("match");
    startWatching(view.matchUuid);
  }

  function startWatching(uuid) {
    stopWatching();
    state.stopWatch = OR.matches.watch(uuid, function (view) {
      if (state.match && state.match.version === view.version) return;
      var wasMyTurn = state.match && state.match.isMyTurn;
      applyView(view, false);
      celebrateOpponent(view);
      if (!wasMyTurn && view.isMyTurn) haptic("light");
    }, { onError: function () {} });
  }

  function stopWatching() {
    if (state.stopWatch) { state.stopWatch(); state.stopWatch = null; }
  }

  // Take a fresh server view. Pending tiles survive if their squares are still
  // free and the rack still holds them — otherwise they go back.
  function applyView(view, focus) {
    state.match = view;
    var v = view.view || {};
    var rack = (v.myRack || []).slice();
    var keep = [];
    state.pending.forEach(function (t) {
      var need = t.blank ? "_" : t.letter;
      var i = rack.indexOf(need);
      var free = v.board && v.board[t.row] && v.board[t.row][t.col] === null;
      if (i !== -1 && free) { rack.splice(i, 1); keep.push(t); }
    });
    state.pending = keep;
    state.rackFree = rack;
    if (state.selectedRack !== null && state.selectedRack >= rack.length) state.selectedRack = null;

    els.screens.match.classList.toggle("is-lobby", view.status === "lobby");
    els.screens.match.classList.toggle("is-over", view.status === "finished" || view.status === "abandoned");

    renderPlayers(view);
    renderTurnStrip(view);
    renderLastMove(view);
    renderLobby(view);
    renderRack();
    renderBoard(view, focus);
    renderPreview();
    renderOver(view);
  }

  function lastMoveCells(view) {
    var lm = view.lastMove;
    if (!lm || !lm.move || lm.move.type !== "place" || !Array.isArray(lm.move.tiles)) return [];
    return lm.move.tiles.map(function (t) { return [t.row, t.col]; });
  }

  function renderBoard(view, focus) {
    var v = view.view || {};
    if (!board) {
      board = new window.TilesBoard(els.boardCanvas, {
        onCellTap: onCellTap,
        onViewChange: function (zoomed) { els.zoomFit.disabled = !zoomed; },
        onResized: applyPendingFocus
      });
      board.setTheme();
    }
    if (v.board && v.layout) {
      var cells = lastMoveCells(view);
      board.setView(v.board, v.layout, cells);
      if (focus) { state.pendingFocus = cells; board.openAt(cells); }
    } else {
      board.setView(null, Rules.layout(), []);
      if (focus) { state.pendingFocus = null; board.openAt(null); }
    }
    syncBoard();
  }

  // Pending tiles, the selection, and the advisory "this square connects"
  // dots, all derived from one place so they cannot disagree.
  function syncBoard() {
    if (!board) return;
    board.setPending(state.pending, null);
    board.setPlacing(state.selectedRack !== null);
    var m = state.match;
    var live = m && m.status === "active" && m.isMyTurn && m.view && m.view.board;
    if (live && (state.selectedRack !== null || state.dragSlot !== null || state.pending.length)) {
      board.setHints(Rules.hints(m.view.board, state.pending, boardIsEmpty(m.view.board)));
    } else {
      board.setHints([]);
    }
  }

  function renderPlayers(view) {
    clear(els.players);
    view.players.forEach(function (p) {
      var card = el("div", "player" + (view.turnSeat === p.seat ? " is-turn" : "") + (p.isSelf ? " is-self" : ""));
      card.appendChild(avatar(p.username, p.avatar));
      var col = el("div", "player-text");
      col.appendChild(el("div", "player-name", nameOf(p)));
      var sub = String(p.score);
      if (p.status === "resigned") sub += " · resigned";
      else if (p.status === "forfeited") sub += " · timed out";
      else if (view.view && view.view.rackCounts && !p.isSelf && view.status === "active") {
        var n = view.view.rackCounts[String(p.seat)];
        if (typeof n === "number") sub += " · " + n + " tiles";
      }
      col.appendChild(el("div", "player-score", sub));
      card.appendChild(col);
      els.players.appendChild(card);
    });
  }

  function renderTurnStrip(view) {
    var main = "";
    var mine = false;
    if (view.status === "lobby") {
      main = "Waiting for players";
    } else if (view.status === "active") {
      mine = !!view.isMyTurn;
      var onTurn = view.players.filter(function (p) { return p.seat === view.turnSeat; })[0];
      main = mine ? "Your move" : (onTurn ? "@" + onTurn.username + "’s move" : "");
    } else if (view.status === "finished") {
      main = "Final";
    } else if (view.status === "abandoned") {
      main = "Table closed";
    }
    els.turnMain.textContent = main;
    els.turnMain.classList.toggle("is-mine", mine);

    var clock = view.status === "active" ? deadline(view.turnDeadline) : null;
    els.chipTimer.hidden = !clock;
    if (clock) {
      els.chipTimer.textContent = clock.text;
      els.chipTimer.className = "chip chip-timer" + (clock.level ? " is-" + clock.level : "");
      els.chipTimer.title = "An expired turn is forfeited.";
    }
    var bag = view.view && typeof view.view.bagCount === "number" ? view.view.bagCount : null;
    els.chipBag.hidden = bag === null || view.status !== "active";
    if (bag !== null) {
      els.chipBag.textContent = bag + " in bag";
      els.chipBag.title = "Tiles left to draw. When the bag empties, the first player to use their last tile ends the game.";
    }

    var warn = mine && clock && clock.level === "urgent";
    els.turnWarning.hidden = !warn;
    if (warn) {
      els.turnWarning.textContent = clock.ms > 0
        ? "Your turn is nearly up. If the clock runs out you forfeit this game."
        : "This turn is overdue — play now or you forfeit this game.";
    }

    var active = view.status === "active" && view.isMyTurn;
    els.exchangeButton.disabled = !active || !(view.view && view.view.bagCount >= 7);
    els.exchangeButton.title = active && !(view.view && view.view.bagCount >= 7)
      ? "Swapping needs at least seven tiles left in the bag." : "";
    els.passButton.disabled = !active;
    els.shuffleButton.disabled = view.status !== "active";
  }

  // What just happened, in words. `lastMove` carries the squares and the
  // points; the word itself is only readable off the board the move was
  // applied to, which is exactly what the view we just received holds.
  function renderLastMove(view) {
    var lm = view.lastMove;
    if (!lm || view.status === "lobby") { els.lastMove.hidden = true; return; }
    var player = view.players.filter(function (p) { return p.seat === lm.seat; })[0];
    var who = player ? nameOf(player) : "Someone";
    var move = lm.move || {};
    var points = typeof lm.scoreDelta === "number" ? lm.scoreDelta : null;

    clear(els.lastMove);
    if (move.type === "place") {
      var word = Rules.wordThrough(view.view && view.view.board, lastMoveCells(view));
      els.lastMove.appendChild(document.createTextNode(who + " played "));
      els.lastMove.appendChild(el("span", "word", word || "a word"));
      if (points !== null) {
        els.lastMove.appendChild(document.createTextNode(" for "));
        els.lastMove.appendChild(el("span", "pts", points + (points === 1 ? " point" : " points")));
      }
    } else if (move.type === "exchange") {
      els.lastMove.textContent = who + " swapped tiles.";
    } else if (move.type === "pass") {
      els.lastMove.textContent = who + " passed.";
    } else {
      els.lastMove.hidden = true;
      return;
    }
    els.lastMove.hidden = false;
  }

  function renderLobby(view) {
    if (view.status !== "lobby") { els.lobbyPanel.hidden = true; return; }
    els.lobbyPanel.hidden = false;
    var missing = view.maxPlayers - view.players.length;
    els.lobbyLead.textContent = missing > 0
      ? "Waiting for " + missing + " more player" + (missing > 1 ? "s" : "") + ". Share the code and the game starts as soon as the table is full."
      : "Everyone is seated — starting…";
    els.lobbyCode.textContent = view.joinCode || "—";
    els.lobbyCode.parentNode.hidden = !view.joinCode;
    els.shareCodeButton.hidden = !view.joinCode;
    clear(els.lobbySeats);
    view.players.forEach(function (p) {
      var seat = el("span", "lobby-seat");
      seat.appendChild(avatar(p.username, p.avatar));
      seat.appendChild(el("span", "", nameOf(p)));
      els.lobbySeats.appendChild(seat);
    });
    for (var i = 0; i < missing; i++) {
      els.lobbySeats.appendChild(el("span", "lobby-seat is-open", "Empty seat"));
    }
  }

  function rackActive() {
    var m = state.match;
    return !!(m && m.status === "active" && m.isMyTurn);
  }

  function renderRack() {
    clear(els.rack);
    var active = rackActive();
    state.rackFree.forEach(function (letter, index) {
      var tile = el("button", "tile" + (state.selectedRack === index ? " is-selected" : "") + (letter === "_" ? " is-blank" : ""));
      tile.type = "button";
      tile.disabled = !active;
      tile.setAttribute("aria-pressed", state.selectedRack === index ? "true" : "false");
      tile.setAttribute("aria-label", letter === "_"
        ? "Blank tile, scores nothing"
        : letter + ", " + (Rules.VALUES[letter] || 0) + (Rules.VALUES[letter] === 1 ? " point" : " points"));
      tile.appendChild(el("span", "tile-letter", letter === "_" ? "" : letter));
      tile.appendChild(el("span", "tile-value", String(Rules.VALUES[letter] || 0)));
      bindRackTile(tile, index);
      els.rack.appendChild(tile);
    });
    els.rack.classList.toggle("is-inactive", !active);
    els.recallButton.disabled = !state.pending.length;
  }

  // A tile dropped somewhere it cannot go returns to the rack. Without a beat
  // of feedback that is indistinguishable from the drag not having registered.
  function rejectDrop(tile) {
    haptic("error");
    tile.classList.remove("is-rejected");
    void tile.offsetWidth; // restart the animation
    tile.classList.add("is-rejected");
    setTimeout(function () { tile.classList.remove("is-rejected"); }, 400);
  }

  function selectRack(index) {
    state.selectedRack = state.selectedRack === index ? null : index;
    renderRack();
    syncBoard();
    renderPreview();
  }

  // One gesture, three outcomes, chosen by the dominant axis of the first few
  // pixels of movement:
  //   no movement   → tap to select (and the keyboard's click lands here too)
  //   sideways      → reorder the rack, which is how players find words
  //   towards the board → carry the tile to a square and drop it
  // A ghost follows the pointer during a board drag because the real tile is a
  // flex child of the rack and cannot leave it.
  function bindRackTile(tile, index) {
    var startX = 0, startY = 0, mode = null, target = index, siblings = null, step = 1;
    var ghost = null, dropCell = null;

    function makeGhost() {
      ghost = tile.cloneNode(true);
      ghost.classList.add("tile-ghost");
      ghost.classList.remove("is-selected");
      ghost.removeAttribute("disabled");
      document.body.appendChild(ghost);
      tile.classList.add("is-lifted");
    }

    function moveGhost(x, y) {
      if (ghost) ghost.style.transform = "translate(" + x + "px, " + (y - 34) + "px) translate(-50%, -50%)";
    }

    function clearGhost() {
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      ghost = null;
      tile.classList.remove("is-lifted");
      if (board) board.setDropTarget(null);
      dropCell = null;
      if (state.dragSlot !== null) { state.dragSlot = null; syncBoard(); }
    }

    tile.addEventListener("pointerdown", function (e) {
      if (!rackActive()) return;
      try { tile.setPointerCapture(e.pointerId); } catch (_) {}
      startX = e.clientX;
      startY = e.clientY;
      mode = null;
      target = index;
      siblings = $$(".tile", els.rack);
      step = tile.getBoundingClientRect().width + 6;
    });

    tile.addEventListener("pointermove", function (e) {
      if (!siblings) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (!mode) {
        if (Math.hypot(dx, dy) <= 8) return;
        // Upward is towards the board; sideways is along the rack.
        mode = Math.abs(dy) > Math.abs(dx) ? "board" : "reorder";
        if (mode === "board") {
          makeGhost();
          // The dashed "this connects" squares are shown for a selected tile;
          // a dragged tile wants them just as much, and wants them before the
          // drop rather than after it fails.
          state.dragSlot = index;
          syncBoard();
        } else {
          tile.classList.add("is-dragging");
        }
      }
      if (mode === "board") {
        moveGhost(e.clientX, e.clientY);
        var cell = board ? board.cellAtClient(e.clientX, e.clientY - 34) : null;
        var free = cell && state.match && state.match.view
          && state.match.view.board[cell[0]][cell[1]] === null
          && !state.pending.some(function (t) { return t.row === cell[0] && t.col === cell[1]; });
        dropCell = free ? cell : null;
        board.setDropTarget(dropCell);
        e.preventDefault();
        return;
      }
      tile.style.transform = "translateX(" + dx + "px)";
      var next = Math.max(0, Math.min(siblings.length - 1, index + Math.round(dx / step)));
      if (next !== target) {
        siblings.forEach(function (node) { node.classList.remove("is-drop-target"); });
        if (next !== index) siblings[next].classList.add("is-drop-target");
        target = next;
      }
      e.preventDefault();
    });

    function finish() {
      if (!siblings) return;
      var landed = dropCell;
      var how = mode;
      tile.style.transform = "";
      tile.classList.remove("is-dragging");
      siblings.forEach(function (node) { node.classList.remove("is-drop-target"); });
      siblings = null;
      mode = null;
      state.dragSlot = null;
      clearGhost();
      // A pointer sequence is followed by a synthetic click — but only
      // sometimes: a drag that moved far enough usually emits none. A sticky
      // "already handled" flag therefore outlived the gesture and swallowed
      // the player's NEXT tap, leaving the tile dead until something happened
      // to re-render the rack.
      //
      // A short deadline expires on its own instead. It is deliberately tight:
      // the synthetic click follows within a few milliseconds (the rack sets
      // `touch-action: none`, so there is no 300ms tap delay to wait out), and
      // erring long risks eating a real tap again — which is the bug. Erring
      // short only risks selecting a tile the player just dragged, which is
      // what they were reaching for anyway.
      tile._clickDeadline = Date.now() + 120;

      if (how === "board") {
        if (landed) placeFromRack(index, landed[0], landed[1]);
        else rejectDrop(tile);
        return;
      }
      if (how === "reorder") {
        if (target !== index) {
          var moved = state.rackFree.splice(index, 1)[0];
          state.rackFree.splice(target, 0, moved);
          state.selectedRack = null;
          haptic("light");
          renderRack();
          syncBoard();
        }
        return;
      }
      selectRack(index);
    }

    tile.addEventListener("pointerup", finish);
    tile.addEventListener("pointercancel", finish);
    // Keyboard activation still arrives as a click with no pointer sequence,
    // and must always select — hence a deadline rather than a flag.
    tile.addEventListener("click", function () {
      if (tile._clickDeadline && Date.now() < tile._clickDeadline) {
        tile._clickDeadline = 0;
        return;
      }
      tile._clickDeadline = 0;
      selectRack(index);
    });
  }

  function renderPreview() {
    var m = state.match;
    els.preview.className = "preview";
    els.playButton.textContent = "Play";
    if (!m || m.status !== "active" || !m.isMyTurn) {
      els.preview.textContent = "";
      els.playButton.disabled = true;
      return;
    }
    if (!state.pending.length) {
      els.preview.classList.add("is-hint");
      els.preview.textContent = state.selectedRack === null
        ? "Drag a tile onto the board, or tap one then a square."
        : "Now tap a square — the dashed ones connect.";
      els.playButton.disabled = true;
      return;
    }
    var v = m.view;
    var result = Rules.evaluate(v.board, state.pending, v.layout, boardIsEmpty(v.board));
    if (!result.ok) {
      els.preview.classList.add("is-error");
      els.preview.textContent = result.reason;
      els.playButton.disabled = true;
      return;
    }
    clear(els.preview);
    result.words.forEach(function (w, i) {
      if (i) els.preview.appendChild(document.createTextNode(" · "));
      els.preview.appendChild(document.createTextNode(w.word + " " + w.score));
    });
    if (result.bingo) {
      els.preview.appendChild(document.createTextNode(" · "));
      els.preview.appendChild(el("span", "bingo", "bingo +50"));
    }
    if (result.words.length > 1 || result.bingo) {
      els.preview.appendChild(document.createTextNode(" = "));
      els.preview.appendChild(el("span", "score", String(result.score)));
    }
    els.playButton.disabled = false;
    els.playButton.textContent = "Play for " + result.score;
  }

  function renderOver(view) {
    var done = view.status === "finished" || view.status === "abandoned";
    els.over.hidden = !done;
    if (!done) return;
    var me = meIn(view);
    if (view.status === "abandoned") {
      els.overTitle.textContent = "Table closed";
      els.overText.textContent = "This game never got going.";
      return;
    }
    if (view.winnerSeat === null) {
      els.overTitle.textContent = "Draw";
    } else if (me && view.winnerSeat === me.seat) {
      els.overTitle.textContent = "You won!";
      haptic("success");
    } else {
      var winner = view.players.filter(function (p) { return p.seat === view.winnerSeat; })[0];
      els.overTitle.textContent = winner ? "@" + winner.username + " won" : "Game over";
    }
    els.overText.textContent = view.players.map(function (p) { return nameOf(p) + " " + p.score; }).join(" · ");
  }

  // ------------------------------------------------------------ celebration

  function popScore(points, bingo, word) {
    clear(els.scorePop);
    if (word) els.scorePop.appendChild(el("span", "pop-word", word));
    els.scorePop.appendChild(el("span", "pop-score", "+" + points));
    if (bingo) els.scorePop.appendChild(el("span", "pop-bingo", "BINGO +50"));
    els.scorePop.hidden = false;
    els.scorePop.classList.remove("is-live");
    void els.scorePop.offsetWidth; // restart the animation
    els.scorePop.classList.add("is-live");
    clearTimeout(popScore.timer);
    popScore.timer = setTimeout(function () {
      els.scorePop.hidden = true;
      els.scorePop.classList.remove("is-live");
    }, 1700);
  }

  // The opponent's word, announced the same way yours is, once per ply.
  function celebrateOpponent(view) {
    var lm = view.lastMove;
    if (!lm || lm.ply === state.announcedPly) return;
    state.announcedPly = lm.ply;
    var player = view.players.filter(function (p) { return p.seat === lm.seat; })[0];
    if (!player || player.isSelf) return;
    if (!lm.move || lm.move.type !== "place" || typeof lm.scoreDelta !== "number") return;
    popScore(lm.scoreDelta, false, Rules.wordThrough(view.view && view.view.board, lastMoveCells(view)));
  }

  // ------------------------------------------------------------ placing

  function onCellTap(row, col) {
    var m = state.match;
    if (!m || m.status !== "active" || !m.isMyTurn) return;
    var existing = null;
    for (var i = 0; i < state.pending.length; i++) {
      if (state.pending[i].row === row && state.pending[i].col === col) existing = i;
    }
    if (existing !== null) {
      // Tap a laid tile to pick it back up.
      var t = state.pending.splice(existing, 1)[0];
      state.rackFree.push(t.blank ? "_" : t.letter);
      state.selectedRack = null;
      renderRack();
      syncBoard();
      renderPreview();
      return;
    }
    if (state.selectedRack === null) {
      if (state.rackFree.length) toast("Pick a tile from your rack, or drag one onto the board.");
      return;
    }
    placeFromRack(state.selectedRack, row, col);
  }

  // Put rack tile `slot` on (row, col). Shared by tap-to-place, drag-to-place
  // and the keyboard, so all three obey the same rules and the blank picker
  // only exists once.
  function placeFromRack(slot, row, col) {
    var m = state.match;
    if (!m || m.status !== "active" || !m.isMyTurn) return false;
    if (slot === null || slot === undefined || slot < 0 || slot >= state.rackFree.length) return false;
    if (!m.view || !m.view.board || m.view.board[row][col] !== null) return false;
    var taken = state.pending.some(function (t) { return t.row === row && t.col === col; });
    if (taken) return false;
    var letter = state.rackFree[slot];
    if (letter === "_") {
      pickLetter(function (chosen) {
        if (!chosen) return;
        commitPlace(row, col, chosen, true, slot);
      });
      return true;
    }
    commitPlace(row, col, letter, false, slot);
    return true;
  }

  function commitPlace(row, col, letter, blank, slot) {
    if (slot === null || slot === undefined || slot >= state.rackFree.length) return;
    state.rackFree.splice(slot, 1);
    state.pending.push({ row: row, col: col, letter: letter, blank: blank });
    // Keep a tile selected so a word can be laid with alternating taps: the
    // one that slid into this slot, or the last tile once the rack shortens.
    state.selectedRack = state.rackFree.length
      ? Math.min(slot, state.rackFree.length - 1)
      : null;
    haptic("light");
    renderRack();
    syncBoard();
    renderPreview();
  }

  function recall() {
    state.pending.forEach(function (t) { state.rackFree.push(t.blank ? "_" : t.letter); });
    state.pending = [];
    state.selectedRack = null;
    renderRack();
    syncBoard();
    renderPreview();
  }

  function shuffleRack() {
    for (var i = state.rackFree.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = state.rackFree[i]; state.rackFree[i] = state.rackFree[j]; state.rackFree[j] = tmp;
    }
    state.selectedRack = null;
    renderRack();
    syncBoard();
  }

  // ------------------------------------------------------------ keyboard

  function announce(row, col) {
    if (board) els.boardStatus.textContent = board.describe(row, col);
  }

  function moveCursor(row, col, dir) {
    var size = window.TilesBoard.SIZE;
    row = Math.max(0, Math.min(size - 1, row));
    col = Math.max(0, Math.min(size - 1, col));
    board.setCursor(row, col, dir);
    announce(row, col);
  }

  function occupiedAt(row, col) {
    var m = state.match;
    if (!m || !m.view || !m.view.board) return false;
    if (m.view.board[row][col]) return true;
    return state.pending.some(function (t) { return t.row === row && t.col === col; });
  }

  // Walk the caret forward past anything already on the board, so typing
  // through an existing word does what a player expects.
  function advanceCursor(row, col, dir) {
    var size = window.TilesBoard.SIZE;
    var r = row + dir[0], c = col + dir[1];
    while (r >= 0 && c >= 0 && r < size && c < size && occupiedAt(r, c)) { r += dir[0]; c += dir[1]; }
    if (r < 0 || c < 0 || r >= size || c >= size) return [row, col];
    return [r, c];
  }

  function typeLetter(letter) {
    var cursor = board.getCursor();
    var dir = board.getCursorDir();
    if (occupiedAt(cursor[0], cursor[1])) {
      cursor = advanceCursor(cursor[0], cursor[1], dir);
      if (occupiedAt(cursor[0], cursor[1])) { toast("No room that way."); return; }
    }
    var slot = state.rackFree.indexOf(letter);
    var blank = false;
    if (slot === -1) {
      slot = state.rackFree.indexOf("_");
      blank = slot !== -1;
    }
    if (slot === -1) { toast("No " + letter + " on your rack.", true); return; }
    state.selectedRack = slot;
    commitPlace(cursor[0], cursor[1], letter, blank, slot);
    var next = advanceCursor(cursor[0], cursor[1], dir);
    board.setCursor(next[0], next[1], dir);
    announce(next[0], next[1]);
  }

  function backspaceTile() {
    if (!state.pending.length) return;
    var t = state.pending.pop();
    state.rackFree.push(t.blank ? "_" : t.letter);
    state.selectedRack = null;
    renderRack();
    syncBoard();
    renderPreview();
    board.setCursor(t.row, t.col, board.getCursorDir());
    announce(t.row, t.col);
  }

  function onKeyDown(e) {
    if (dialogState) return; // the dialog traps its own keys
    if (state.screen !== "match" || !board) return;
    var target = e.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var m = state.match;
    if (!m || m.status !== "active" || !m.isMyTurn) return;

    var key = e.key;
    var arrows = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    var first = !board.getCursor();
    if (first && (arrows[key] || /^[a-zA-Z]$/.test(key))) {
      board.setCursor(7, 7, [0, 1]);
      try { els.boardCanvas.focus({ preventScroll: true }); } catch (_) { els.boardCanvas.focus(); }
      announce(7, 7);
      if (arrows[key]) { e.preventDefault(); return; } // the first arrow just reveals the caret
    }

    if (arrows[key]) {
      var cursor = board.getCursor();
      moveCursor(cursor[0] + arrows[key][0], cursor[1] + arrows[key][1], arrows[key]);
      e.preventDefault();
      return;
    }
    if (key === "Enter") {
      if (!els.playButton.disabled) play();
      e.preventDefault();
      return;
    }
    if (key === "Escape") {
      if (state.pending.length) recall();
      e.preventDefault();
      return;
    }
    if (key === "Backspace") {
      backspaceTile();
      e.preventDefault();
      return;
    }
    if (/^[a-zA-Z]$/.test(key)) {
      typeLetter(key.toUpperCase());
      e.preventDefault();
    }
  }

  // ------------------------------------------------------------- moves

  function sendMove(move, okText) {
    if (state.busy || !state.match) return;
    state.busy = true;
    els.playButton.disabled = true;
    var uuid = state.match.matchUuid;
    OR.matches.move({ matchUuid: uuid, version: state.match.version, move: move }).then(function (view) {
      state.busy = false;
      state.pending = [];
      state.selectedRack = null;
      state.announcedPly = view.lastMove ? view.lastMove.ply : state.announcedPly;
      haptic("success");
      if (okText) toast(okText);
      applyView(view, false);
      if (state.lastPlayed) {
        popScore(state.lastPlayed.score, state.lastPlayed.bingo, state.lastPlayed.word);
        state.lastPlayed = null;
      }
    }).catch(function (err) {
      state.busy = false;
      state.lastPlayed = null;
      var code = errorCode(err);
      if (code === "match/version-conflict" || code === "match/not-your-turn") {
        toast("The game moved on — refreshing.", true);
        OR.matches.get({ matchUuid: uuid }).then(function (view) { applyView(view, true); }).catch(function () {});
        return;
      }
      haptic("error");
      // The tiles stay where they are: a refusal is usually one word the
      // dictionary does not have, and the player wants to adjust it, not lay
      // the whole move out again.
      console.warn("[word-battle] move refused", err);
      toast(errorText(err, "That move was refused — your tiles are still on the board."), true);
      renderPreview();
    });
  }

  function play() {
    if (!state.pending.length) return;
    var m = state.match;
    var preview = Rules.evaluate(m.view.board, state.pending, m.view.layout, boardIsEmpty(m.view.board));
    state.lastPlayed = preview.ok
      ? { score: preview.score, bingo: !!preview.bingo, word: preview.words[0] ? preview.words[0].word : "" }
      : null;
    var tiles = state.pending.map(function (t) {
      var o = { row: t.row, col: t.col, letter: t.letter };
      if (t.blank) o.blank = true;
      return o;
    });
    sendMove({ type: "place", tiles: tiles }, null);
  }

  function exchange() {
    if (!rackActive()) return;
    var go = function () {
      recall();
      pickTiles(state.rackFree, function (letters) {
        if (!letters || !letters.length) return;
        sendMove({ type: "exchange", letters: letters }, "Tiles exchanged.");
      });
    };
    if (state.pending.length) {
      confirmDialog({
        title: "Swap tiles?",
        text: "The " + state.pending.length + " tile" + (state.pending.length > 1 ? "s" : "")
          + " you have placed will go back to your rack first.",
        confirmLabel: "Continue"
      }, go);
      return;
    }
    go();
  }

  function pass() {
    if (!rackActive()) return;
    confirmDialog({
      title: "Pass your turn?",
      text: "You score nothing this turn."
        + (state.pending.length ? " The tiles you have placed go back to your rack." : "")
        + " Two full rounds of passes end the game.",
      confirmLabel: "Pass"
    }, function () {
      recall();
      sendMove({ type: "pass" }, "Passed.");
    });
  }

  function resign() {
    var m = state.match;
    if (!m) return;
    var lobby = m.status === "lobby";
    confirmDialog({
      title: lobby ? "Leave this table?" : "Resign this game?",
      text: lobby
        ? "The seat opens up again for someone else."
        : "You forfeit the game and your opponents keep their scores. This cannot be undone.",
      confirmLabel: lobby ? "Leave" : "Resign",
      danger: true
    }, function () {
      OR.matches.resign({ matchUuid: m.matchUuid }).then(function (view) {
        applyView(view, false);
        if (view.status !== "active") { showScreen("list"); loadList(); }
      }).catch(function (err) { toast(errorText(err, "Couldn't resign."), true); });
    });
  }

  function shareCode() {
    var m = state.match;
    if (!m || !m.joinCode) return;
    var url = LANDING_URL + "?target=join&code=" + m.joinCode;
    var text = "Join my " + GAME_NAME + " table on OddsRabbit with code " + m.joinCode + " — " + url;
    OR.actions.share({ title: GAME_NAME, text: text }).catch(function () {
      // Copy the LINK, not the bare code: the fallback should hand over the
      // same thing the share sheet would have.
      try {
        var done = navigator.clipboard.writeText(url);
        if (done && done.then) done.then(function () { toast("Invite link copied."); }, function () {});
        else toast("Invite link copied.");
      } catch (_) {}
    });
  }

  function openMatchMenu() {
    var m = state.match;
    openDialog({
      title: "Match options",
      menu: true,
      confirmLabel: null,
      cancelLabel: "Close",
      build: function (body, close) {
        function item(label, danger, run) {
          var button = el("button", "menu-item" + (danger ? " is-danger" : ""), label);
          button.type = "button";
          button.addEventListener("click", function () { close(null); run(); });
          body.appendChild(button);
        }
        item("How to play", false, showHowTo);
        if (m && m.joinCode && m.status === "lobby") item("Share invite", false, shareCode);
        if (m && (m.status === "active" || m.status === "lobby")) {
          item(m.status === "lobby" ? "Leave table" : "Resign", true, resign);
        }
        return {};
      }
    });
  }

  // ------------------------------------------------------------ pickers

  function pickLetter(done) {
    openDialog({
      title: "Blank tile — choose a letter",
      confirmLabel: null,
      build: function (body, close) {
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").forEach(function (letter) {
          var button = el("button", "picker-letter", letter);
          button.type = "button";
          button.addEventListener("click", function () { close(letter); });
          body.appendChild(button);
        });
        return {};
      },
      onClose: function (letter) { done(letter); }
    });
  }

  function pickTiles(letters, done) {
    openDialog({
      title: "Swap which tiles?",
      confirmLabel: "Swap",
      build: function (body) {
        var chosen = {};
        letters.forEach(function (letter, index) {
          var button = el("button", "tile" + (letter === "_" ? " is-blank" : ""));
          button.type = "button";
          button.setAttribute("aria-pressed", "false");
          button.appendChild(el("span", "tile-letter", letter === "_" ? "" : letter));
          button.appendChild(el("span", "tile-value", String(Rules.VALUES[letter] || 0)));
          button.addEventListener("click", function () {
            chosen[index] = !chosen[index];
            button.classList.toggle("is-selected", chosen[index]);
            button.setAttribute("aria-pressed", chosen[index] ? "true" : "false");
          });
          body.appendChild(button);
        });
        return {
          value: function () { return letters.filter(function (_, i) { return chosen[i]; }); }
        };
      },
      onClose: function (picked) { done(picked); }
    });
  }

  // ------------------------------------------------------------- boot

  function applyTheme() {
    var dark = OR.colorScheme === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    if (board) board.setTheme();
  }

  function handleDeepLink() {
    var initial = OR.initialState;
    if (initial && typeof initial === "object") {
      if (initial.target === "match" && typeof initial.matchUuid === "string") {
        takeJoin();
        openMatch(initial.matchUuid);
        return true;
      }
      if (initial.target === "join" && typeof initial.joinCode === "string") {
        takeJoin();
        joinByCode(initial.joinCode);
        return true;
      }
    }
    var stashed = takeJoin();
    if (stashed) { joinByCode(stashed); return true; }
    return false;
  }

  function backToList() {
    showScreen("list");
    loadList();
  }

  function wire() {
    els.newGameButtons.forEach(function (b) { b.addEventListener("click", openNewGame); });
    els.joinOpenButtons.forEach(function (b) { b.addEventListener("click", openJoinDialog); });
    els.helpButtons.forEach(function (b) { b.addEventListener("click", showHowTo); });
    els.backButtons.forEach(function (b) { b.addEventListener("click", backToList); });
    els.menuButton.addEventListener("click", openMatchMenu);
    els.seatsMinus.addEventListener("click", function () { state.seats--; renderSeats(); });
    els.seatsPlus.addEventListener("click", function () { state.seats++; renderSeats(); });
    els.inviteInput.addEventListener("input", function () {
      state.inviteQuery = els.inviteInput.value;
      renderInvitable();
    });
    els.inviteClear.addEventListener("click", function () {
      els.inviteInput.value = "";
      state.inviteQuery = "";
      renderInvitable();
      els.inviteInput.focus();
    });
    els.inviteInput.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !els.inviteInput.value) return;
      els.inviteInput.value = "";
      state.inviteQuery = "";
      renderInvitable();
      e.stopPropagation();
    });
    els.createButton.addEventListener("click", createMatch);
    els.playButton.addEventListener("click", play);
    els.recallButton.addEventListener("click", recall);
    els.shuffleButton.addEventListener("click", shuffleRack);
    els.exchangeButton.addEventListener("click", exchange);
    els.passButton.addEventListener("click", pass);
    els.shareCodeButton.addEventListener("click", shareCode);
    els.overBack.addEventListener("click", backToList);
    els.signIn.addEventListener("click", function () {
      var code = peekJoin();
      OR.actions.requestSignIn(code
        ? "Sign in to take your seat at this table."
        : "Sign in to play against friends.");
    });

    els.zoomIn.addEventListener("click", function () { board && board.zoomBy(1.4); });
    els.zoomOut.addEventListener("click", function () { board && board.zoomBy(1 / 1.4); });
    els.zoomFit.addEventListener("click", function () { board && board.fit(); });
    els.boardCanvas.addEventListener("focus", function () {
      if (!board) return;
      var cursor = board.getCursor() || [7, 7];
      board.setCursor(cursor[0], cursor[1], board.getCursorDir());
      announce(cursor[0], cursor[1]);
    });
    els.boardCanvas.addEventListener("blur", function () { if (board) board.setCursor(null); });

    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", function () { if (board && state.screen === "match") board.resize(true); });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && state.screen === "list") loadList(true);
    });
    OR.lifecycle.on("resume", function () { if (state.screen === "list") loadList(true); });

  }

  function showHeroOnly(noteText) {
    els.hero.hidden = false;
    els.actionBar.hidden = true;
    els.listBody.hidden = true;
    if (noteText) {
      els.signInNote.textContent = noteText;
      els.signInNote.hidden = false;
    }
  }

  OR.whenReady().then(function () {
    applyTheme();
    wireDialog();
    wire();
    showScreen("list");

    if (!OR.capabilities.has("matches.get")) {
      els.unsupported.hidden = false;
      els.hero.hidden = true;
      els.actionBar.hidden = true;
      els.listBody.hidden = true;
      OR.ready();
      return;
    }
    if (!OR.user) {
      // Hold on to an invite across the sign-in round trip, and say what the
      // player is being asked to sign in FOR.
      var initial = OR.initialState;
      if (initial && typeof initial === "object" && initial.target === "join" && typeof initial.joinCode === "string") {
        stashJoin(String(initial.joinCode).toUpperCase());
      }
      var invite = peekJoin();
      els.heroActions.hidden = true;
      showHeroOnly(invite
        ? "You’ve been invited to a table (code " + invite + "). Sign in to take your seat."
        : null);
      els.signIn.hidden = !OR.capabilities.has("actions.requestSignIn");
      OR.ready();
      return;
    }

    startListPolling();
    var linked = handleDeepLink();
    loadList().then(function () { OR.ready(); });
    if (linked) OR.ready();
  });
})();

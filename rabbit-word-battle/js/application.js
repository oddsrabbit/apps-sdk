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
// component so they hash to the same colour everywhere.

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

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var els = {
    screens: {
      list: $(".screen-list"),
      "new": $(".screen-new"),
      match: $(".screen-match")
    },
    listBody: $(".match-list"),
    listEmpty: $(".match-list-empty"),
    listStatus: $(".list-status"),
    newGameButton: $(".new-game-button"),
    joinForm: $(".join-form"),
    joinInput: $(".join-input"),
    signIn: $(".sign-in"),
    unsupported: $(".unsupported"),
    invitableList: $(".invitable-list"),
    invitableEmpty: $(".invitable-empty"),
    seats: $(".seats-value"),
    seatsMinus: $(".seats-minus"),
    seatsPlus: $(".seats-plus"),
    openToggle: $(".open-toggle"),
    createButton: $(".create-button"),
    createStatus: $(".create-status"),
    backButtons: $$(".back-button"),
    players: $(".players"),
    turnLine: $(".turn-line"),
    boardCanvas: $(".board-canvas"),
    rack: $(".rack"),
    preview: $(".preview"),
    playButton: $(".play-button"),
    recallButton: $(".recall-button"),
    shuffleButton: $(".shuffle-button"),
    exchangeButton: $(".exchange-button"),
    passButton: $(".pass-button"),
    resignButton: $(".resign-button"),
    lobby: $(".lobby"),
    lobbyCode: $(".lobby-code"),
    shareCodeButton: $(".share-code-button"),
    over: $(".game-over"),
    overTitle: $(".game-over-title"),
    overText: $(".game-over-text"),
    overBack: $(".game-over-back"),
    picker: $(".picker"),
    pickerTitle: $(".picker-title"),
    pickerBody: $(".picker-body"),
    pickerConfirm: $(".picker-confirm"),
    pickerCancel: $(".picker-cancel"),
    toast: $(".toast")
  };

  var state = {
    screen: "list",
    match: null,
    pending: [],
    selectedRack: null,
    stopWatch: null,
    invitable: [],
    invitees: {},
    open: false,
    seats: 2,
    busy: false
  };

  var board = null;

  // ------------------------------------------------------------ utilities

  function showFatal(text) {
    var el = document.querySelector(".fatal");
    if (el) { el.textContent = text; el.hidden = false; }
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

  function errorText(err, fallback) {
    if (err && typeof err.message === "string" && err.message) return err.message;
    return fallback;
  }

  function errorCode(err) {
    return err && typeof err.code === "string" ? err.code : "";
  }

  function timeLeft(iso) {
    if (!iso) return "";
    var ms = new Date(iso).getTime() - Date.now();
    if (!(ms > 0)) return "overdue";
    var h = Math.floor(ms / 3600000);
    if (h >= 48) return Math.floor(h / 24) + "d left";
    if (h >= 1) return h + "h left";
    return Math.max(1, Math.floor(ms / 60000)) + "m left";
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
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

  function showScreen(name) {
    state.screen = name;
    Object.keys(els.screens).forEach(function (k) { els.screens[k].hidden = k !== name; });
    if (name !== "match") stopWatching();
    if (name === "match" && board) requestAnimationFrame(function () { board.resize(); });
  }

  // ------------------------------------------------------------- list

  function loadList() {
    els.listStatus.textContent = "Loading…";
    return OR.matches.list({ status: "all", limit: 100 }).then(function (rows) {
      els.listStatus.textContent = "";
      renderList(rows);
    }).catch(function (err) {
      els.listStatus.textContent = errorText(err, "Couldn't load your games.");
    });
  }

  function renderList(rows) {
    clear(els.listBody);
    var groups = [
      { title: "Your move", rows: rows.filter(function (m) { return m.status === "active" && m.isMyTurn; }) },
      { title: "Their move", rows: rows.filter(function (m) { return m.status === "active" && !m.isMyTurn; }) },
      { title: "Waiting for players", rows: rows.filter(function (m) { return m.status === "lobby"; }) },
      { title: "Finished", rows: rows.filter(function (m) { return m.status === "finished" || m.status === "abandoned"; }) }
    ];
    var any = false;
    groups.forEach(function (g) {
      if (!g.rows.length) return;
      any = true;
      els.listBody.appendChild(el("h2", "group-title", g.title));
      g.rows.forEach(function (m) { els.listBody.appendChild(renderRow(m)); });
    });
    els.listEmpty.hidden = any;
  }

  function renderRow(m) {
    var row = el("button", "match-row");
    row.type = "button";
    var faces = el("div", "match-faces");
    var opps = opponentsOf(m);
    (opps.length ? opps : m.players).slice(0, 3).forEach(function (p) { faces.appendChild(avatar(p.username, p.avatar)); });
    row.appendChild(faces);
    var text = el("div", "match-text");
    var names = opps.length ? opps.map(function (p) { return "@" + p.username; }).join(", ") : "Open table";
    text.appendChild(el("div", "match-names", names));
    var me = meIn(m);
    var detail;
    if (m.status === "finished") {
      detail = m.winnerSeat === null ? "Draw" : (me && m.winnerSeat === me.seat ? "You won" : "You lost");
      detail += " · " + m.players.map(function (p) { return p.score; }).join(" – ");
    } else if (m.status === "abandoned") {
      detail = "Abandoned";
    } else if (m.status === "lobby") {
      detail = m.players.length + " of " + m.maxPlayers + " seated";
    } else {
      detail = m.players.map(function (p) { return p.score; }).join(" – ") + (m.isMyTurn ? " · " + timeLeft(m.turnDeadline) : "");
    }
    text.appendChild(el("div", "match-detail", detail));
    row.appendChild(text);
    if (m.isMyTurn) row.appendChild(el("span", "badge", "Play"));
    row.addEventListener("click", function () { openMatch(m.matchUuid); });
    return row;
  }

  // -------------------------------------------------------------- new game

  function openNewGame() {
    state.invitees = {};
    state.open = false;
    state.seats = 2;
    els.openToggle.checked = false;
    els.createStatus.textContent = "";
    renderSeats();
    showScreen("new");
    els.invitableEmpty.hidden = true;
    clear(els.invitableList);
    els.invitableList.appendChild(el("p", "muted", "Loading people you follow…"));
    OR.matches.invitable().then(function (people) {
      state.invitable = people;
      renderInvitable();
    }).catch(function () {
      state.invitable = [];
      renderInvitable();
    });
  }

  function renderInvitable() {
    clear(els.invitableList);
    els.invitableEmpty.hidden = state.invitable.length > 0;
    state.invitable.forEach(function (p) {
      var label = el("label", "invitable-row");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!state.invitees[p.uuid];
      box.addEventListener("change", function () {
        if (box.checked) {
          if (Object.keys(state.invitees).length >= 3) { box.checked = false; toast("Up to three friends per table."); return; }
          state.invitees[p.uuid] = p;
        } else {
          delete state.invitees[p.uuid];
        }
        state.seats = Math.max(state.seats, 1 + Object.keys(state.invitees).length);
        renderSeats();
      });
      label.appendChild(box);
      label.appendChild(avatar(p.username, p.avatar));
      label.appendChild(el("span", "invitable-name", "@" + p.username));
      if (p.relation === "mutual") label.appendChild(el("span", "muted small", "follows you"));
      els.invitableList.appendChild(label);
    });
  }

  function renderSeats() {
    var invited = Object.keys(state.invitees).length;
    state.seats = Math.min(4, Math.max(2, Math.max(state.seats, invited + 1)));
    els.seats.textContent = String(state.seats);
    var openSeats = state.seats - 1 - invited;
    els.openToggle.disabled = openSeats <= 0;
    if (openSeats <= 0) { els.openToggle.checked = false; state.open = false; }
    els.createStatus.textContent = openSeats > 0 && !state.open
      ? openSeats + " seat" + (openSeats > 1 ? "s" : "") + " left — turn on “open table” or invite more friends."
      : "";
    els.createButton.disabled = openSeats > 0 && !state.open;
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
    OR.matches.join({ joinCode: code }).then(function (view) {
      haptic("success");
      enterMatch(view);
    }).catch(function (err) {
      toast(errorText(err, "Couldn't join that table."), true);
    });
  }

  // ---------------------------------------------------------------- match

  function openMatch(uuid) {
    OR.matches.get({ matchUuid: uuid }).then(enterMatch).catch(function (err) {
      toast(errorText(err, "Couldn't open that game."), true);
    });
  }

  function enterMatch(view) {
    state.pending = [];
    state.selectedRack = null;
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

    renderPlayers(view);
    renderTurnLine(view);
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
      board = new window.TilesBoard(els.boardCanvas, { onCellTap: onCellTap });
      board.setTheme(document.documentElement.getAttribute("data-theme") === "dark");
    }
    if (v.board && v.layout) {
      var cells = lastMoveCells(view);
      board.setView(v.board, v.layout, cells);
      if (focus && cells.length) board.focusCells(cells);
    } else {
      board.setView(null, Rules.layout(), []);
    }
    board.setPending(state.pending, state.selectedPending);
  }

  function renderPlayers(view) {
    clear(els.players);
    view.players.forEach(function (p) {
      var card = el("div", "player" + (view.turnSeat === p.seat ? " is-turn" : "") + (p.isSelf ? " is-self" : ""));
      card.appendChild(avatar(p.username, p.avatar));
      var col = el("div", "player-text");
      col.appendChild(el("div", "player-name", p.isSelf ? "You" : "@" + p.username));
      var sub = String(p.score);
      if (p.status === "resigned") sub += " · resigned";
      else if (p.status === "forfeited") sub += " · forfeited";
      else if (view.view && view.view.rackCounts && !p.isSelf && view.status === "active") {
        var n = view.view.rackCounts[String(p.seat)];
        if (typeof n === "number") sub += " · " + n + " tiles";
      }
      col.appendChild(el("div", "player-score", sub));
      card.appendChild(col);
      els.players.appendChild(card);
    });
  }

  function renderTurnLine(view) {
    var text = "";
    if (view.status === "lobby") text = "Waiting for " + (view.maxPlayers - view.players.length) + " more to join.";
    else if (view.status === "active") {
      var onTurn = view.players.filter(function (p) { return p.seat === view.turnSeat; })[0];
      text = view.isMyTurn ? "Your move · " + timeLeft(view.turnDeadline)
        : (onTurn ? "@" + onTurn.username + "'s move · " + timeLeft(view.turnDeadline) : "");
      if (view.view && typeof view.view.bagCount === "number") text += " · " + view.view.bagCount + " in bag";
    }
    els.turnLine.textContent = text;
    var active = view.status === "active" && view.isMyTurn;
    els.exchangeButton.disabled = !active || !(view.view && view.view.bagCount >= 7);
    els.passButton.disabled = !active;
    els.shuffleButton.disabled = view.status !== "active";
    els.resignButton.hidden = !(view.status === "active" || view.status === "lobby");
  }

  function renderLobby(view) {
    var show = view.status === "lobby" && view.joinCode;
    els.lobby.hidden = !show;
    if (show) els.lobbyCode.textContent = view.joinCode;
  }

  function renderRack() {
    clear(els.rack);
    state.rackFree.forEach(function (letter, i) {
      var tile = el("button", "tile" + (state.selectedRack === i ? " is-selected" : "") + (letter === "_" ? " is-blank" : ""));
      tile.type = "button";
      tile.appendChild(el("span", "tile-letter", letter === "_" ? "" : letter));
      tile.appendChild(el("span", "tile-value", String(Rules.VALUES[letter] || 0)));
      tile.addEventListener("click", function () {
        state.selectedRack = state.selectedRack === i ? null : i;
        state.selectedPending = null;
        renderRack();
        board.setPending(state.pending, null);
      });
      els.rack.appendChild(tile);
    });
    var active = state.match && state.match.status === "active" && state.match.isMyTurn;
    els.rack.classList.toggle("is-inactive", !active);
    els.recallButton.disabled = !state.pending.length;
  }

  function renderPreview() {
    var m = state.match;
    if (!m || m.status !== "active" || !m.isMyTurn) {
      els.preview.textContent = "";
      els.playButton.disabled = true;
      return;
    }
    if (!state.pending.length) {
      els.preview.textContent = "Tap a tile, then a square.";
      els.playButton.disabled = true;
      return;
    }
    var v = m.view;
    var empty = !v.board.some(function (row) { return row.some(function (c) { return c !== null; }); });
    var result = Rules.evaluate(v.board, state.pending, v.layout, empty);
    if (!result.ok) {
      els.preview.textContent = result.reason;
      els.playButton.disabled = true;
      return;
    }
    els.preview.textContent = result.words.map(function (w) { return w.word + " " + w.score; }).join(" · ")
      + (result.bingo ? " · bingo +50" : "") + " = " + result.score;
    els.playButton.disabled = false;
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
    } else {
      var w = view.players.filter(function (p) { return p.seat === view.winnerSeat; })[0];
      els.overTitle.textContent = w ? "@" + w.username + " won" : "Game over";
    }
    els.overText.textContent = view.players.map(function (p) { return (p.isSelf ? "You" : "@" + p.username) + " " + p.score; }).join(" · ");
  }

  // ------------------------------------------------------------ placing

  function onCellTap(row, col) {
    var m = state.match;
    if (!m || m.status !== "active" || !m.isMyTurn) return;
    var key = row + "," + col;
    var existing = null;
    for (var i = 0; i < state.pending.length; i++) if (state.pending[i].row === row && state.pending[i].col === col) existing = i;
    if (existing !== null) {
      // Tap a laid tile to pick it back up.
      var t = state.pending.splice(existing, 1)[0];
      state.rackFree.push(t.blank ? "_" : t.letter);
      state.selectedRack = null;
      renderRack();
      board.setPending(state.pending, null);
      renderPreview();
      return;
    }
    if (state.selectedRack === null) return;
    if (m.view.board[row][col] !== null) return;
    var letter = state.rackFree[state.selectedRack];
    if (letter === "_") {
      pickLetter(function (chosen) {
        if (!chosen) return;
        commitPlace(row, col, chosen, true);
      });
      return;
    }
    commitPlace(row, col, letter, false);
  }

  function commitPlace(row, col, letter, blank) {
    if (state.selectedRack === null) return;
    state.rackFree.splice(state.selectedRack, 1);
    state.pending.push({ row: row, col: col, letter: letter, blank: blank });
    // Keep selecting: the next rack tile in line, so a word can be laid with
    // alternating taps instead of re-selecting every time.
    state.selectedRack = state.rackFree.length ? Math.min(state.selectedRack, state.rackFree.length - 1) : null;
    if (state.selectedRack !== null && state.pending.length && state.rackFree.length > 0) {
      // Only auto-advance when the user has not deselected; a lone tile keeps
      // the selection on it.
    }
    haptic("light");
    renderRack();
    board.setPending(state.pending, null);
    renderPreview();
  }

  function recall() {
    state.pending.forEach(function (t) { state.rackFree.push(t.blank ? "_" : t.letter); });
    state.pending = [];
    state.selectedRack = null;
    renderRack();
    board.setPending([], null);
    renderPreview();
  }

  function shuffleRack() {
    for (var i = state.rackFree.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = state.rackFree[i]; state.rackFree[i] = state.rackFree[j]; state.rackFree[j] = tmp;
    }
    state.selectedRack = null;
    renderRack();
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
      haptic("success");
      if (okText) toast(okText);
      applyView(view, false);
    }).catch(function (err) {
      state.busy = false;
      var code = errorCode(err);
      if (code === "match/version-conflict" || code === "match/not-your-turn") {
        toast("The game moved on — refreshing.", true);
        OR.matches.get({ matchUuid: uuid }).then(function (view) { applyView(view, true); }).catch(function () {});
        return;
      }
      haptic("error");
      toast(errorText(err, "That move was refused."), true);
      renderPreview();
    });
  }

  function play() {
    if (!state.pending.length) return;
    var tiles = state.pending.map(function (t) {
      var o = { row: t.row, col: t.col, letter: t.letter };
      if (t.blank) o.blank = true;
      return o;
    });
    sendMove({ type: "place", tiles: tiles }, null);
  }

  function exchange() {
    if (!state.match || !state.match.isMyTurn) return;
    recall();
    pickTiles(state.rackFree, function (letters) {
      if (!letters || !letters.length) return;
      sendMove({ type: "exchange", letters: letters }, "Tiles exchanged.");
    });
  }

  function pass() {
    if (!state.match || !state.match.isMyTurn) return;
    if (!window.confirm("Pass your turn?")) return;
    recall();
    sendMove({ type: "pass" }, "Passed.");
  }

  function resign() {
    if (!state.match) return;
    if (!window.confirm(state.match.status === "lobby" ? "Leave this table?" : "Resign this game?")) return;
    OR.matches.resign({ matchUuid: state.match.matchUuid }).then(function (view) {
      applyView(view, false);
      if (view.status !== "active") { showScreen("list"); loadList(); }
    }).catch(function (err) { toast(errorText(err, "Couldn't resign."), true); });
  }

  function shareCode() {
    if (!state.match || !state.match.joinCode) return;
    var text = "Join my " + GAME_NAME + " table on OddsRabbit with code " + state.match.joinCode + " — " + LANDING_URL + "?target=join&code=" + state.match.joinCode;
    OR.actions.share({ title: GAME_NAME, text: text }).catch(function () {
      try { navigator.clipboard.writeText(state.match.joinCode); toast("Code copied."); } catch (_) {}
    });
  }

  // ------------------------------------------------------------ pickers

  function openPicker(title, buildBody, onConfirm, confirmLabel) {
    els.pickerTitle.textContent = title;
    clear(els.pickerBody);
    var api = buildBody(els.pickerBody);
    els.pickerConfirm.textContent = confirmLabel || "OK";
    els.pickerConfirm.hidden = !api.needsConfirm;
    els.picker.hidden = false;
    function close(result) {
      els.picker.hidden = true;
      els.pickerConfirm.onclick = null;
      els.pickerCancel.onclick = null;
      onConfirm(result);
    }
    els.pickerConfirm.onclick = function () { close(api.value()); };
    els.pickerCancel.onclick = function () { close(null); };
    api.close = close;
  }

  function pickLetter(done) {
    openPicker("Blank tile — choose a letter", function (body) {
      var api = { needsConfirm: false, value: function () { return null; } };
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").forEach(function (l) {
        var b = el("button", "picker-letter", l);
        b.type = "button";
        b.addEventListener("click", function () { api.close(l); });
        body.appendChild(b);
      });
      return api;
    }, done);
  }

  function pickTiles(letters, done) {
    openPicker("Exchange which tiles?", function (body) {
      var chosen = {};
      letters.forEach(function (l, i) {
        var b = el("button", "tile picker-tile" + (l === "_" ? " is-blank" : ""));
        b.type = "button";
        b.appendChild(el("span", "tile-letter", l === "_" ? "" : l));
        b.appendChild(el("span", "tile-value", String(Rules.VALUES[l] || 0)));
        b.addEventListener("click", function () {
          chosen[i] = !chosen[i];
          b.classList.toggle("is-selected", chosen[i]);
        });
        body.appendChild(b);
      });
      return {
        needsConfirm: true,
        value: function () { return letters.filter(function (_, i) { return chosen[i]; }); }
      };
    }, done, "Exchange");
  }

  // ------------------------------------------------------------- boot

  function applyTheme() {
    var dark = OR.colorScheme === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    if (board) board.setTheme(dark);
  }

  function handleDeepLink() {
    var s = OR.initialState;
    if (!s || typeof s !== "object") return false;
    if (s.target === "match" && typeof s.matchUuid === "string") { openMatch(s.matchUuid); return true; }
    if (s.target === "join" && typeof s.joinCode === "string") { joinByCode(s.joinCode); return true; }
    return false;
  }

  function wire() {
    els.newGameButton.addEventListener("click", openNewGame);
    els.joinForm.addEventListener("submit", function (e) { e.preventDefault(); joinByCode(els.joinInput.value); els.joinInput.value = ""; });
    els.backButtons.forEach(function (b) { b.addEventListener("click", function () { showScreen("list"); loadList(); }); });
    els.seatsMinus.addEventListener("click", function () { state.seats--; renderSeats(); });
    els.seatsPlus.addEventListener("click", function () { state.seats++; renderSeats(); });
    els.openToggle.addEventListener("change", function () { state.open = els.openToggle.checked; renderSeats(); });
    els.createButton.addEventListener("click", createMatch);
    els.playButton.addEventListener("click", play);
    els.recallButton.addEventListener("click", recall);
    els.shuffleButton.addEventListener("click", shuffleRack);
    els.exchangeButton.addEventListener("click", exchange);
    els.passButton.addEventListener("click", pass);
    els.resignButton.addEventListener("click", resign);
    els.shareCodeButton.addEventListener("click", shareCode);
    els.overBack.addEventListener("click", function () { showScreen("list"); loadList(); });
    els.signIn.addEventListener("click", function () { OR.actions.requestSignIn("Sign in to play against friends."); });
    window.addEventListener("resize", function () { if (board && state.screen === "match") board.resize(); });
    OR.lifecycle.on("resume", function () { if (state.screen === "list") loadList(); });
  }

  OR.whenReady().then(function () {
    applyTheme();
    wire();
    if (!OR.capabilities.has("matches.get")) {
      els.unsupported.hidden = false;
      els.newGameButton.hidden = true;
      els.joinForm.hidden = true;
      OR.ready();
      return;
    }
    if (!OR.user) {
      els.signIn.hidden = false;
      els.newGameButton.hidden = true;
      els.joinForm.hidden = true;
      els.listEmpty.hidden = true;
      OR.ready();
      return;
    }
    showScreen("list");
    var linked = handleDeepLink();
    loadList().then(function () { OR.ready(); });
    if (linked) OR.ready();
  });
})();

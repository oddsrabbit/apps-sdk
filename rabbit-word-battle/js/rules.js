// Client mirror of the server's TilesRules (rest-routes/services/matches/
// TilesRules.php in the WordPress repo — the PHP class keeps the `Tiles` name,
// as does `window.TilesRules` here, because the rules-class id on the wire is
// `tiles`): placement geometry and scoring, so a
// player sees "CAT · 10" and "tiles must form one unbroken line" the instant
// they lay tiles, without a round trip.
//
// It is a PREVIEW, not an authority. The server applies the move to its own
// state, checks the dictionary (this file has none), and answers with the new
// view or a `match/illegal-move` reason. If the two ever disagree, the server
// is right and this file has a bug — application.js shows the server's message
// either way.
//
// The premium layout is generated from the same coordinate lists with the same
// eight-fold reflection as the PHP, but the client never trusts its own copy:
// every view from the server carries `layout`, and the renderer draws that.
// The copy here only exists so scoring can run before the first view arrives.

(function () {
  var SIZE = 15;
  var CENTER = 7;
  var RACK = 7;
  var BINGO = 50;

  var VALUES = {
    A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5, L: 1, M: 3,
    N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10, _: 0
  };

  var PREMIUMS = {
    W: [[0, 4]],
    w: [[2, 2], [3, 3], [4, 4], [5, 5], [7, 7]],
    L: [[0, 7], [3, 7], [2, 6]],
    l: [[1, 3], [6, 6], [4, 7], [1, 7]]
  };

  function layout() {
    var grid = [];
    for (var r = 0; r < SIZE; r++) grid.push(new Array(SIZE).fill("."));
    var last = SIZE - 1;
    Object.keys(PREMIUMS).forEach(function (code) {
      PREMIUMS[code].forEach(function (cell) {
        var r = cell[0], c = cell[1];
        [[r, c], [c, r]].forEach(function (p) {
          var a = p[0], b = p[1];
          [[a, b], [a, last - b], [last - a, b], [last - a, last - b]].forEach(function (q) {
            grid[q[0]][q[1]] = code;
          });
        });
      });
    });
    return grid.map(function (row) { return row.join(""); });
  }

  // Walk the run of tiles through (r, c) along (dr, dc). `at(r, c)` returns a
  // tile object or null; it lets the caller overlay pending tiles on the board.
  function wordAt(at, r, c, dr, dc) {
    while (r - dr >= 0 && c - dc >= 0 && at(r - dr, c - dc)) { r -= dr; c -= dc; }
    var cells = [];
    while (r < SIZE && c < SIZE && at(r, c)) { cells.push([r, c]); r += dr; c += dc; }
    return cells;
  }

  /**
   * Validate and score a placement.
   *
   * @param board   15x15 of null | {l, b, s} from the server view
   * @param placed  [{row, col, letter, blank}] pending tiles from the rack
   * @param lay     layout strings from the server view
   * @param boardEmpty whether the board has no tiles yet
   * @returns {{ok: true, words: [{word, score, cells}], score: number}}
   *        | {{ok: false, reason: string}}
   */
  function evaluate(board, placed, lay, boardEmpty) {
    if (!placed.length) return { ok: false, reason: "Place a tile." };
    if (placed.length > RACK) return { ok: false, reason: "Too many tiles." };

    var pending = {};
    for (var i = 0; i < placed.length; i++) {
      var p = placed[i];
      var key = p.row + "," + p.col;
      if (pending[key] || board[p.row][p.col]) return { ok: false, reason: "That square is taken." };
      pending[key] = { l: p.letter, b: !!p.blank, pending: true };
    }
    var at = function (r, c) { return pending[r + "," + c] || board[r][c] || null; };

    var rows = {}, cols = {};
    placed.forEach(function (t) { rows[t.row] = true; cols[t.col] = true; });
    var nRows = Object.keys(rows).length, nCols = Object.keys(cols).length;
    if (nRows > 1 && nCols > 1) return { ok: false, reason: "Tiles must be in one row or one column." };
    var single = placed.length === 1;
    var horizontal = single || nRows === 1;

    var r0 = Math.min.apply(null, placed.map(function (t) { return t.row; }));
    var c0 = Math.min.apply(null, placed.map(function (t) { return t.col; }));
    var main = horizontal ? wordAt(at, r0, c0, 0, 1) : wordAt(at, r0, c0, 1, 0);
    var mainSet = {};
    main.forEach(function (cell) { mainSet[cell[0] + "," + cell[1]] = true; });
    for (var j = 0; j < placed.length; j++) {
      if (!mainSet[placed[j].row + "," + placed[j].col]) {
        return { ok: false, reason: "Tiles must form one unbroken line." };
      }
    }

    var words = [];
    if (main.length > 1) words.push(main);
    var crossWords = 0;
    placed.forEach(function (t) {
      var cross = horizontal ? wordAt(at, t.row, t.col, 1, 0) : wordAt(at, t.row, t.col, 0, 1);
      if (cross.length > 1) { words.push(cross); crossWords++; }
    });

    if (boardEmpty) {
      if (!pending[CENTER + "," + CENTER]) return { ok: false, reason: "The first word must cover the centre square." };
      if (placed.length < 2) return { ok: false, reason: "The first word needs at least two letters." };
    } else if (main.length === placed.length && crossWords === 0) {
      return { ok: false, reason: "New tiles must connect to a word on the board." };
    }
    if (!words.length) return { ok: false, reason: "That does not form a word." };

    var total = 0;
    var scored = words.map(function (cells) {
      var sum = 0, mult = 1, str = "";
      cells.forEach(function (cell) {
        var r = cell[0], c = cell[1];
        var tile = at(r, c);
        var v = tile.b ? 0 : (VALUES[tile.l] || 0);
        if (pending[r + "," + c]) {
          var code = lay[r].charAt(c);
          if (code === "l") v *= 2;
          else if (code === "L") v *= 3;
          else if (code === "w") mult *= 2;
          else if (code === "W") mult *= 3;
        }
        sum += v;
        str += tile.l;
      });
      var s = sum * mult;
      total += s;
      return { word: str, score: s, cells: cells };
    });
    if (placed.length === RACK) total += BINGO;
    return { ok: true, words: scored, score: total, bingo: placed.length === RACK };
  }

  function rackValue(rack) {
    return rack.reduce(function (sum, l) { return sum + (VALUES[l] || 0); }, 0);
  }

  window.TilesRules = {
    SIZE: SIZE,
    CENTER: CENTER,
    RACK: RACK,
    BINGO: BINGO,
    VALUES: VALUES,
    layout: layout,
    evaluate: evaluate,
    rackValue: rackValue
  };
})();

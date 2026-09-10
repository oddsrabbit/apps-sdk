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

  /**
   * Empty squares where the next tile would join what is already down.
   *
   * A HINT, not a rule: `onCellTap` still accepts any free square, because a
   * word is often laid from its far end inward and the tiles only have to
   * connect once the whole move is on the board. With nothing pending these
   * are the anchors around the existing tiles (or the centre star on an empty
   * board); once tiles are pending they are the two open ends of the line
   * being built, hopping over tiles already on the board, which is what a
   * player mid-word actually wants pointed out.
   */
  function hints(board, pending, boardEmpty) {
    if (boardEmpty && !pending.length) return [[CENTER, CENTER]];
    if (!board) return [];
    var pend = {};
    (pending || []).forEach(function (t) { pend[t.row + "," + t.col] = true; });
    function inside(r, c) { return r >= 0 && c >= 0 && r < SIZE && c < SIZE; }
    function filled(r, c) { return inside(r, c) && !!(pend[r + "," + c] || board[r][c]); }

    var out = [], seen = {};
    function push(r, c) {
      if (!inside(r, c) || filled(r, c) || seen[r + "," + c]) return;
      seen[r + "," + c] = true;
      out.push([r, c]);
    }

    if (!pending || !pending.length) {
      for (var r = 0; r < SIZE; r++) {
        for (var c = 0; c < SIZE; c++) {
          if (!board[r][c]) continue;
          push(r - 1, c); push(r + 1, c); push(r, c - 1); push(r, c + 1);
        }
      }
      return out;
    }

    var rows = {}, cols = {};
    pending.forEach(function (t) { rows[t.row] = true; cols[t.col] = true; });
    var dirs;
    if (pending.length === 1) dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
    else if (Object.keys(rows).length === 1) dirs = [[0, 1], [0, -1]];
    else if (Object.keys(cols).length === 1) dirs = [[1, 0], [-1, 0]];
    else return out; // not a line yet; nothing honest to suggest
    dirs.forEach(function (d) {
      var r = pending[0].row, c = pending[0].col;
      while (filled(r + d[0], c + d[1])) { r += d[0]; c += d[1]; }
      push(r + d[0], c + d[1]);
    });
    return out;
  }

  /**
   * The main word a set of cells spells on a board the move has ALREADY been
   * applied to. Used to tell a player what their opponent just played, from
   * the view alone — `lastMove.move.tiles` carries the squares, not the word,
   * and the letters either side of them are only on the board.
   */
  function wordThrough(board, cells) {
    if (!board || !cells || !cells.length) return "";
    var at = function (r, c) {
      return (r >= 0 && c >= 0 && r < SIZE && c < SIZE) ? board[r][c] : null;
    };
    var r0 = cells[0][0], c0 = cells[0][1];
    var run;
    if (cells.length === 1) {
      var h = wordAt(at, r0, c0, 0, 1), v = wordAt(at, r0, c0, 1, 0);
      run = h.length >= v.length ? h : v;
    } else {
      var sameRow = cells.every(function (cell) { return cell[0] === r0; });
      run = sameRow ? wordAt(at, r0, c0, 0, 1) : wordAt(at, r0, c0, 1, 0);
    }
    return run.map(function (cell) {
      var t = at(cell[0], cell[1]);
      return t ? t.l : "";
    }).join("");
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
    hints: hints,
    wordThrough: wordThrough,
    rackValue: rackValue
  };
})();

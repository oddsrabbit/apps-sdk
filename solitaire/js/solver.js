// Klondike (draw-1) solvability filter. UI-free; consumed by game.js at deal
// time to pick a seed whose deal is actually winnable.
//
// Soundness vs completeness: the search only ever returns `true` after it has
// reached a genuine goal state by applying legal moves, so a deal it approves
// is guaranteed winnable. It is NOT complete — it gives up once it burns
// through a node budget, so a hard-but-solvable deal can come back `false`.
// That's fine for our use: a false "false" just means we re-roll to a
// different (still winnable) seed, never that we ship a broken board.
//
// Determinism: the search is pure and deterministic (fixed move ordering, no
// clock, no Math.random), so every device that runs findSolvableSeed on the
// same starting seed lands on the same approved seed. That's what keeps the
// daily deal identical across players even though the dealt seed is no longer
// just the raw daily id.

(function () {
  var Deck = window.SolitaireDeck;

  var suitOf = Deck.suitOf;
  var rankOf = Deck.rankOf;
  var isRed = Deck.isRed;
  var KING = 12;

  // Per-attempt search ceiling (states expanded). Deliberately small: because
  // findSolvableSeed re-rolls on a miss, the expensive case is a deep search
  // that ends up *not* proving the seed, so a tight budget keeps each miss
  // cheap. Most winnable deals the solver can prove are proven in well under
  // this many states; harder ones are simply skipped (a different, still
  // proven-winnable seed is chosen). End-to-end this lands deal generation at
  // ~tens of ms typical and well under a second in the tail.
  var NODE_BUDGET = 4000;
  // How many seeds in the deterministic sequence we try before falling back to
  // the start seed unfiltered. Each attempt proves out with probability ~1/2,
  // so reaching this many consecutive misses is effectively impossible; the
  // generous cap makes the unfiltered fallback (a possibly-hard deal, i.e. the
  // pre-solver status quo) something we never actually hit in practice.
  var MAX_SEED_ATTEMPTS = 40;

  // --- Predicates (mirror deck.js, kept local so the solver is self-contained) ---

  function foundationEligible(card, found) {
    // found[suit] = highest rank placed on that suit's foundation, or -1.
    return rankOf(card) === found[suitOf(card)] + 1;
  }

  // Microsoft-style "safe autoplay": a card can be sent to its foundation with
  // zero risk if both opposite-colour foundations are already at least one rank
  // below it (so no opposite-colour card that might want to sit on it still
  // needs the tableau). Aces and twos are always safe. Forcing these collapses
  // long forced runs out of the search tree without ever hiding a solution.
  function safeToFoundation(card, found) {
    var r = rankOf(card);
    if (r <= 1) return true;
    var oppA, oppB;
    if (isRed(card)) { oppA = Deck.SUIT_CLUBS; oppB = Deck.SUIT_SPADES; }
    else { oppA = Deck.SUIT_DIAMONDS; oppB = Deck.SUIT_HEARTS; }
    return found[oppA] >= r - 1 && found[oppB] >= r - 1;
  }

  function canStack(moving, destTop) {
    if (destTop == null) return rankOf(moving) === KING; // empty col → kings
    if (isRed(moving) === isRed(destTop)) return false;
    return rankOf(moving) === rankOf(destTop) - 1;
  }

  function colTop(col) { return col.length ? col[col.length - 1] : null; }

  // --- State ---
  //
  // Search state is deliberately separate from game.js's board so the solver
  // can clone cheaply and key a visited-set off it. Shape:
  //   tableau: 7 arrays of card ints (bottom..top)
  //   hidden:  7 ints — face-down count from the bottom of each column
  //   found:   4 ints indexed BY SUIT — top rank placed, or -1
  //   stock:   array, draw from the end
  //   waste:   array, top at the end

  function stateFromBoard(board) {
    var found = [-1, -1, -1, -1];
    for (var i = 0; i < board.foundations.length; i++) {
      var f = board.foundations[i];
      if (f.length) {
        var top = f[f.length - 1];
        found[suitOf(top)] = rankOf(top);
      }
    }
    var tableau = [];
    for (var c = 0; c < board.tableau.length; c++) tableau.push(board.tableau[c].slice());
    return {
      tableau: tableau,
      hidden: board.tableauHidden.slice(),
      found: found,
      stock: board.stock.slice(),
      waste: board.waste.slice(),
    };
  }

  function cloneState(s) {
    var tableau = [];
    for (var c = 0; c < s.tableau.length; c++) tableau.push(s.tableau[c].slice());
    return {
      tableau: tableau,
      hidden: s.hidden.slice(),
      found: s.found.slice(),
      stock: s.stock.slice(),
      waste: s.waste.slice(),
    };
  }

  function isGoal(s) {
    return s.found[0] === KING && s.found[1] === KING && s.found[2] === KING && s.found[3] === KING;
  }

  // Compact round-trippable serialization. Doubles as both the visited-set key
  // AND the frontier's stored form — keeping states as short strings instead
  // of nested arrays holds the best-first frontier's memory in check even when
  // it grows to tens of thousands of entries. parseState is its inverse.
  function serialize(s) {
    var cols = [];
    for (var c = 0; c < s.tableau.length; c++) {
      cols.push(s.hidden[c] + ":" + s.tableau[c].join(","));
    }
    return cols.join("/") + "#" + s.found.join(",") + "#" + s.stock.join(",") + "#" + s.waste.join(",");
  }

  function nums(str) {
    if (str === "") return [];
    var parts = str.split(",");
    var out = new Array(parts.length);
    for (var i = 0; i < parts.length; i++) out[i] = parseInt(parts[i], 10);
    return out;
  }

  function parseState(str) {
    var sections = str.split("#");
    var colStrs = sections[0].split("/");
    var tableau = [];
    var hidden = [];
    for (var c = 0; c < colStrs.length; c++) {
      var sep = colStrs[c].indexOf(":");
      hidden.push(parseInt(colStrs[c].slice(0, sep), 10));
      tableau.push(nums(colStrs[c].slice(sep + 1)));
    }
    return {
      tableau: tableau,
      hidden: hidden,
      found: nums(sections[1]),
      stock: nums(sections[2]),
      waste: nums(sections[3]),
    };
  }

  // Best-first ranking (higher = more promising): foundation progress
  // dominates, then fewer face-down cards, with a light nudge toward draining
  // the stock/waste. Only an ordering heuristic — it never affects soundness,
  // just which winnable lines surface first within the node budget.
  function priorityOf(s) {
    var fTotal = (s.found[0] + 1) + (s.found[1] + 1) + (s.found[2] + 1) + (s.found[3] + 1);
    var hiddenTotal = 0;
    for (var c = 0; c < s.hidden.length; c++) hiddenTotal += s.hidden[c];
    return fTotal * 1000 - hiddenTotal * 10 - s.stock.length - s.waste.length;
  }

  // After removing the top of a column, flip the newly-exposed card face-up if
  // the column is now all face-down. Mirrors game.js _maybeFlipColumn.
  function maybeFlip(s, col) {
    var hidden = s.hidden[col];
    var len = s.tableau[col].length;
    if (hidden > 0 && hidden >= len) s.hidden[col] = hidden - 1;
  }

  // --- Moves ---
  //
  // Move descriptors are plain objects so the search and the (test-only) path
  // reconstruction share one vocabulary:
  //   { t:'tf', col }            tableau col top  → its foundation
  //   { t:'wf' }                 waste top        → its foundation
  //   { t:'tt', src, i, dest }   tableau slice [i..] → dest column
  //   { t:'wt', dest }           waste top        → dest column
  //   { t:'draw' }               stock top        → waste
  //   { t:'recycle' }            waste (reversed) → stock

  function applyMove(s, m) {
    var n = cloneState(s);
    switch (m.t) {
      case "tf": {
        var card = n.tableau[m.col].pop();
        n.found[suitOf(card)] = rankOf(card);
        maybeFlip(n, m.col);
        break;
      }
      case "wf": {
        var wc = n.waste.pop();
        n.found[suitOf(wc)] = rankOf(wc);
        break;
      }
      case "tt": {
        var moving = n.tableau[m.src].splice(m.i);
        for (var k = 0; k < moving.length; k++) n.tableau[m.dest].push(moving[k]);
        maybeFlip(n, m.src);
        break;
      }
      case "wt": {
        n.tableau[m.dest].push(n.waste.pop());
        break;
      }
      case "draw": {
        n.waste.push(n.stock.pop());
        break;
      }
      case "recycle": {
        n.stock = n.waste.slice().reverse();
        n.waste = [];
        break;
      }
    }
    return n;
  }

  // The single safe foundation move to force, if any (tableau tops first, then
  // waste). Returns a move descriptor or null.
  function findForcedMove(s) {
    for (var c = 0; c < s.tableau.length; c++) {
      var col = s.tableau[c];
      if (!col.length) continue;
      var top = col[col.length - 1];
      if (foundationEligible(top, s.found) && safeToFoundation(top, s.found)) {
        return { t: "tf", col: c };
      }
    }
    if (s.waste.length) {
      var w = s.waste[s.waste.length - 1];
      if (foundationEligible(w, s.found) && safeToFoundation(w, s.found)) {
        return { t: "wf" };
      }
    }
    return null;
  }

  // All branching moves for a state with no forced move. Order matters only
  // for which solution is found first (we push to a LIFO stack, so the last
  // pushed is explored first): we want foundation/relocation tries before the
  // stock draw, so draws are pushed first.
  function genMoves(s) {
    var moves = [];

    // Stock cycling (pushed first → explored last).
    if (s.stock.length) {
      moves.push({ t: "draw" });
    } else if (s.waste.length) {
      moves.push({ t: "recycle" });
    }


    // Tableau → tableau relocations.
    for (var src = 0; src < s.tableau.length; src++) {
      var col = s.tableau[src];
      var firstFaceUp = s.hidden[src];
      for (var i = firstFaceUp; i < col.length; i++) {
        var head = col[i];
        for (var dest = 0; dest < s.tableau.length; dest++) {
          if (dest === src) continue;
          var destCol = s.tableau[dest];
          if (!canStack(head, colTop(destCol))) continue;
          // Prune the classic king-shuffle: moving an entire face-up column
          // (reveals nothing) onto an empty column is a reversible no-op that
          // only churns the search. Skip it.
          if (destCol.length === 0 && i === firstFaceUp && firstFaceUp === 0) continue;
          moves.push({ t: "tt", src: src, i: i, dest: dest });
        }
      }
    }

    // Waste → tableau.
    if (s.waste.length) {
      var wcard = s.waste[s.waste.length - 1];
      for (var d = 0; d < s.tableau.length; d++) {
        if (canStack(wcard, colTop(s.tableau[d]))) moves.push({ t: "wt", dest: d });
      }
    }

    // Optional (non-safe) foundation moves — pushed last so they're explored
    // first. Safe ones are already handled as forced moves upstream.
    if (s.waste.length) {
      var wt = s.waste[s.waste.length - 1];
      if (foundationEligible(wt, s.found) && !safeToFoundation(wt, s.found)) moves.push({ t: "wf" });
    }
    for (var c2 = 0; c2 < s.tableau.length; c2++) {
      var col2 = s.tableau[c2];
      if (!col2.length) continue;
      var t2 = col2[col2.length - 1];
      if (foundationEligible(t2, s.found) && !safeToFoundation(t2, s.found)) moves.push({ t: "tf", col: c2 });
    }

    return moves;
  }

  // Binary max-heap over frontier entries, ordered by `.pr`. Plain array
  // implementation — no dependencies, deterministic, fast enough for the
  // frontier sizes we hit.
  function heapPush(heap, node) {
    heap.push(node);
    var i = heap.length - 1;
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (heap[parent].pr >= heap[i].pr) break;
      var tmp = heap[parent]; heap[parent] = heap[i]; heap[i] = tmp;
      i = parent;
    }
  }
  function heapPop(heap) {
    var topNode = heap[0];
    var last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      var i = 0, n = heap.length;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, best = i;
        if (l < n && heap[l].pr > heap[best].pr) best = l;
        if (r < n && heap[r].pr > heap[best].pr) best = r;
        if (best === i) break;
        var tmp = heap[i]; heap[i] = heap[best]; heap[best] = tmp;
        i = best;
      }
    }
    return topNode;
  }

  // Best-first search with a visited-set and a node budget. The frontier holds
  // serialized states (compact) ranked by priorityOf, so the most promising
  // line is always expanded next — which proves winnable deals far faster (and
  // within a far smaller budget) than blind DFS, while never affecting
  // soundness: we still only return success after reaching a real goal state.
  //
  // When wantPath is set (tests), entries carry the move + parent link so a
  // winning line can be reconstructed and replayed for verification.
  function search(initial, wantPath) {
    var visited = {};
    var nodes = 0;
    var heap = [];
    var startKey = serialize(initial);
    heapPush(heap, { k: startKey, pr: priorityOf(initial), m: null, p: null });

    while (heap.length) {
      var entry = heapPop(heap);
      if (visited[entry.k]) continue;
      visited[entry.k] = 1;
      // Budget counts distinct states expanded, not raw pops, so duplicate
      // heap entries (the same state reached by several parents) don't eat
      // into the real exploration depth.
      if (nodes++ > NODE_BUDGET) return wantPath ? null : false;
      var s = parseState(entry.k);

      if (isGoal(s)) {
        if (!wantPath) return true;
        var path = [];
        for (var e = entry; e && e.m; e = e.p) path.push(e.m);
        path.reverse();
        return path;
      }

      var forced = findForcedMove(s);
      var children = forced ? [forced] : genMoves(s);
      for (var i = 0; i < children.length; i++) {
        var next = applyMove(s, children[i]);
        var key = serialize(next);
        if (visited[key]) continue;
        heapPush(heap, { k: key, pr: priorityOf(next), m: wantPath ? children[i] : null, p: wantPath ? entry : null });
      }
    }
    return wantPath ? null : false;
  }

  function isSolvable(board) {
    return search(stateFromBoard(board), false) === true;
  }

  // Walk a deterministic seed sequence and return the first seed whose deal
  // the solver can win. Falls back to the start seed if none of the attempts
  // prove out, so deal generation never blocks forever or fails to produce a
  // board.
  function findSolvableSeed(startSeed) {
    var base = startSeed | 0;
    for (var k = 0; k < MAX_SEED_ATTEMPTS; k++) {
      var seed = (base + k) | 0;
      if (isSolvable(Deck.deal(seed))) return seed;
    }
    return base;
  }

  window.SolitaireSolver = {
    isSolvable: isSolvable,
    findSolvableSeed: findSolvableSeed,
    // Exposed for offline verification harnesses only.
    _internal: {
      stateFromBoard: stateFromBoard,
      applyMove: applyMove,
      search: search,
      NODE_BUDGET: NODE_BUDGET,
      MAX_SEED_ATTEMPTS: MAX_SEED_ATTEMPTS,
    },
  };
})();

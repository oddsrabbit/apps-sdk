// Card model + seeded shuffle + move predicates. UI-free; consumed by
// game.js for state transitions and by renderer.js for paint metadata.
//
// Cards are encoded as integers 0..51 so the engine can hold them in tiny
// typed-style arrays without allocating per-card objects on every move. The
// integer is `suit * 13 + rank` with rank 0..12 = A..K and suit 0..3 =
// clubs, diamonds, hearts, spades. The suit ordering keeps red suits
// (diamonds + hearts) adjacent so colour predicates are a single bit-check.

(function () {
  var RANKS = 13;
  var SUITS = 4;
  var DECK_SIZE = RANKS * SUITS; // 52

  // Suit indices. Order chosen so (suit & 1) tells us the colour: 0 black,
  // 1 red. Cheaper than a per-suit lookup and lines up with how Klondike's
  // alternating-colour rule actually cares about the bit, not the suit.
  var SUIT_CLUBS = 0;
  var SUIT_DIAMONDS = 1;
  var SUIT_HEARTS = 2;
  var SUIT_SPADES = 3;

  function suitOf(card) { return (card / RANKS) | 0; }
  function rankOf(card) { return card % RANKS; }
  // Red = diamonds (1) or hearts (2). Both have bit 1 set among the low 2
  // bits of suit, so (suit >> 1) ^ (suit & 1) ... no, that's overthinking.
  // Just direct check: 1 or 2.
  function isRed(card) {
    var s = suitOf(card);
    return s === SUIT_DIAMONDS || s === SUIT_HEARTS;
  }

  // Klondike daily-deal seed. Day index since the epoch below; resets daily
  // at UTC midnight. Choosing a recent fixed epoch (rather than Unix 0)
  // keeps the integer small enough to display cleanly as "Daily #142".
  var EPOCH_MS = Date.UTC(2026, 0, 1);
  var DAY_MS = 24 * 60 * 60 * 1000;

  function dailyId(nowMs) {
    var t = (typeof nowMs === "number") ? nowMs : Date.now();
    return Math.floor((t - EPOCH_MS) / DAY_MS);
  }

  // mulberry32 — a 32-bit non-cryptographic PRNG. Plenty for shuffling a
  // 52-card deck; the period is 2^32 which is laughably long for our needs.
  // Picked over Math.random because we need reproducible shuffles from a
  // seed (daily deal).
  function mulberry32(seed) {
    var state = seed >>> 0;
    return function () {
      state = (state + 0x6D2B79F5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Fisher-Yates with an injected PRNG so the daily seed produces the same
  // sequence on every device. Returns a fresh Array<number> 0..51 in the
  // shuffled order — the caller decides how to deal it.
  function shuffledDeck(seed) {
    var rng = mulberry32(seed);
    var deck = new Array(DECK_SIZE);
    for (var i = 0; i < DECK_SIZE; i++) deck[i] = i;
    for (var j = DECK_SIZE - 1; j > 0; j--) {
      var k = Math.floor(rng() * (j + 1));
      var tmp = deck[j];
      deck[j] = deck[k];
      deck[k] = tmp;
    }
    return deck;
  }

  // Tableau stacking predicate. The moving card must be one rank lower than
  // the top of the target column, AND in the opposite colour. Empty columns
  // only accept kings — the most restrictive empty-slot rule in solitaire,
  // and the one that gives Klondike its difficulty curve.
  function canStackOnTableau(moving, target) {
    if (target == null) {
      // Empty column → only kings.
      return rankOf(moving) === 12;
    }
    if (isRed(moving) === isRed(target)) return false;
    return rankOf(moving) === rankOf(target) - 1;
  }

  // Foundation predicate. Foundations are per-suit, building up A..K. An
  // empty foundation accepts only that suit's ace; a populated one accepts
  // the next rank of the same suit. The foundation slot itself remembers
  // its suit (set on first placement) so the engine doesn't need to inspect
  // the underlying card array on every drop.
  function canPlaceOnFoundation(moving, foundationTop) {
    if (foundationTop == null) {
      return rankOf(moving) === 0; // Ace
    }
    if (suitOf(moving) !== suitOf(foundationTop)) return false;
    return rankOf(moving) === rankOf(foundationTop) + 1;
  }

  // Auto-send target finder. Given a card and the four foundation tops
  // (entries may be null), return the foundation index that will accept it,
  // or -1. Used both for double-tap-to-send and for the auto-complete loop.
  function findFoundationTarget(card, foundationTops) {
    for (var i = 0; i < foundationTops.length; i++) {
      if (canPlaceOnFoundation(card, foundationTops[i])) return i;
    }
    return -1;
  }

  // Deal a fresh Klondike from a shuffled deck. Returns a state shape the
  // game can take ownership of:
  //   tableau:    7 columns, column i has i+1 cards, only the last face-up.
  //   foundations: 4 empty arrays.
  //   stock:      the remaining 24 cards, all face-down.
  //   waste:      empty.
  // Cards are integers; face-up vs face-down is tracked per-column with a
  // parallel `tableauHidden` array (count of face-down cards from the bottom
  // of the column). This is more compact than wrapping each card in an
  // object and lets the renderer iterate by index without indirection.
  function deal(seed) {
    var deck = shuffledDeck(seed);
    var tableau = [[], [], [], [], [], [], []];
    var tableauHidden = [0, 0, 0, 0, 0, 0, 0];
    var idx = 0;
    for (var col = 0; col < 7; col++) {
      for (var row = 0; row <= col; row++) {
        tableau[col].push(deck[idx++]);
      }
      // All but the last card in each column start face-down.
      tableauHidden[col] = col; // col cards hidden, 1 face-up at the top.
    }
    var stock = deck.slice(idx); // 52 - 28 = 24
    return {
      tableau: tableau,
      tableauHidden: tableauHidden,
      foundations: [[], [], [], []],
      stock: stock,
      waste: [],
    };
  }

  window.SolitaireDeck = {
    RANKS: RANKS,
    SUITS: SUITS,
    DECK_SIZE: DECK_SIZE,
    SUIT_CLUBS: SUIT_CLUBS,
    SUIT_DIAMONDS: SUIT_DIAMONDS,
    SUIT_HEARTS: SUIT_HEARTS,
    SUIT_SPADES: SUIT_SPADES,
    suitOf: suitOf,
    rankOf: rankOf,
    isRed: isRed,
    dailyId: dailyId,
    mulberry32: mulberry32,
    shuffledDeck: shuffledDeck,
    canStackOnTableau: canStackOnTableau,
    canPlaceOnFoundation: canPlaceOnFoundation,
    findFoundationTarget: findFoundationTarget,
    deal: deal,
  };
})();

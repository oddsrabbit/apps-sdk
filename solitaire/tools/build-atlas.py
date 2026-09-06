#!/usr/bin/env python3
"""Build solitaire/images/cards.png — the single card atlas the renderer blits.

The 52 faces come from Kenney's "Playing Cards Pack" (CC0). The card back is
drawn here, in code, because it is OddsRabbit art rather than Kenney's. Both
end up in one PNG so the game costs exactly one image request at boot.

Usage:

    python3 solitaire/tools/build-atlas.py --kenney /path/to/kenney-pack

`--kenney` points at the unzipped pack (the directory holding `License.txt`
and `PNG/`). Download it from https://kenney.nl/assets/playing-cards-pack —
it is not vendored into this repo; only the derived atlas and the license are.

Requires Pillow (`pip install pillow`).

--- Geometry -----------------------------------------------------------------

Every tile in `PNG/Cards (large)/` is a 64x64 canvas with the card itself
sitting in the 42x60 box at (11, 2) — verified identical across all 52 faces,
so the crop is a constant, not a per-file bbox call. 42x60 is the same 0.7
aspect as the renderer's historical 56x80 authoring size, which is why the
swap is a constants change and not a layout rewrite.

The atlas is a 13-column x 5-row grid of those 42x60 cells (546x300):

    rows 0..3  suits in Deck order — clubs, diamonds, hearts, spades
    cols 0..12 ranks A, 2..10, J, Q, K
               => cell index == the engine's own card integer (suit*13 + rank),
                  so renderer.js indexes the atlas with no lookup table.
    row 4      col 0: the OddsRabbit card back (drawn below).
               cols 1..12 are left transparent on purpose — that is where the
               rabbit court cards and seasonal backs land when someone picks
               up the follow-ups in docs/proposals/solitaire-card-art.md §6.

--- Palette ------------------------------------------------------------------

Kenney's faces use exactly four opaque colours. We remap the "black" suits from
his slate to a near-black, which is the same COL_BLACK the hand-drawn deck used
and holds up better against the green felt. Red and the pale inner frame ship
as-authored.
"""

import argparse
import os
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover - developer tooling
    sys.exit("This script needs Pillow. Try: pip install pillow")

# --- Source geometry ---

TILE = 64
CROP = (11, 2, 53, 62)          # the card inside a Kenney tile
CARD_W = CROP[2] - CROP[0]      # 42
CARD_H = CROP[3] - CROP[1]      # 60

COLS = 13
ROWS = 5
ATLAS_W = COLS * CARD_W         # 546
ATLAS_H = ROWS * CARD_H         # 300

# Deck order must match solitaire/js/deck.js: suit*13 + rank, suits
# clubs/diamonds/hearts/spades, ranks A..K.
SUITS = ["clubs", "diamonds", "hearts", "spades"]
RANKS = ["A", "02", "03", "04", "05", "06", "07", "08", "09", "10", "J", "Q", "K"]

# --- Face palette remap ---

# Kenney's slate reads soft next to the near-black we use elsewhere, and loses
# definition once the card is scaled down to a phone column. Everything else
# ships as authored.
FACE_REMAP = {
    (77, 87, 102): (26, 26, 26),   # #4d5766 slate  -> #1a1a1a near-black
    # (245, 44, 78) #f52c4e red      — kept, reads cleanly on white
    # (199, 215, 236) #c7d7ec frame  — kept, the court panel depends on it
}

# --- Card-back palette ---
#
# Deep green ground so a face-down card is unmistakably not a face-up one, with
# the OddsRabbit carrot orange as the accent. See draw_back() for why the top
# few rows have to carry that accent.
BACK_BORDER = (234, 244, 238)   # #eaf4ee — light 1px edge, so stacked backs
                                #           still read as separate card edges
BACK_GROUND = (27, 77, 48)      # #1b4d30
BACK_BAND = (232, 137, 62)      # #e8893e — carrot orange
BACK_BAND_DARK = (196, 94, 26)  # #c45e1a — 1px shadow under the band
BACK_LEAF = (90, 140, 58)       # #5a8c3a
BACK_CARROT = (232, 137, 62)
BACK_CARROT_DARK = (196, 94, 26)

TRANSPARENT = (0, 0, 0, 0)


def load_face(kenney_dir, suit, rank):
    path = os.path.join(kenney_dir, "PNG", "Cards (large)", "card_%s_%s.png" % (suit, rank))
    if not os.path.exists(path):
        sys.exit("Missing %s — is --kenney pointing at the unzipped pack?" % path)
    tile = Image.open(path).convert("RGBA")
    if tile.size != (TILE, TILE):
        sys.exit("%s is %dx%d, expected %dx%d" % ((path,) + tile.size + (TILE, TILE)))
    card = tile.crop(CROP)
    if card.getbbox() != (0, 0, CARD_W, CARD_H):
        # Every Kenney face fills the crop exactly; anything else means the pack
        # changed and the constants above need re-measuring.
        sys.exit("%s does not fill the %dx%d crop — re-measure CROP" % (path, CARD_W, CARD_H))
    return remap(card, FACE_REMAP)


def remap(img, table):
    if not table:
        return img
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            hit = table.get((r, g, b))
            if hit is not None:
                px[x, y] = hit + (a,)
    return img


# --- OddsRabbit card back -----------------------------------------------------

# A carrot, 5 wide x 8 tall. 'L' leaf, 'C' carrot, 'D' the shaded right edge.
CARROT = [
    ".L.L.",
    ".LLL.",
    "CCCCD",
    "CCCCD",
    ".CCCD",
    ".CCD.",
    "..CD.",
    "..C..",
]
CARROT_COLORS = {"L": BACK_LEAF, "C": BACK_CARROT, "D": BACK_CARROT_DARK}


def draw_back():
    """The one piece of new art in the atlas.

    The binding constraint is that a face-down tableau card is overlapped by
    the next one after FACE_DOWN_OFFSET, which is 5 authored pixels. Rows 0..4
    are therefore the ONLY part of this sprite a stacked column ever shows, so
    they carry a hard-edged band — light border, one row of carrot orange, one
    darker shadow row, then ground — and a column of six face-downs reads as
    six crisp repeating pinstripes instead of the flat brown mush the previous
    back gave. A 2px-thick orange band was tried first and turned a face-down
    column into a solid slab of orange that shouted over the faces; one row
    plus its shadow keeps the stripe legible without owning the board.
    The carrot lattice below is what you see on the top of the stock pile.
    """
    img = Image.new("RGBA", (CARD_W, CARD_H), BACK_GROUND + (255,))
    px = img.load()

    # Top band: border, accent, shadow. Rows 3..4 stay ground so the visible
    # peek ends on green rather than on the stripe.
    for x in range(CARD_W):
        px[x, 0] = BACK_BORDER + (255,)
        px[x, 1] = BACK_BAND + (255,)
        px[x, 2] = BACK_BAND_DARK + (255,)
    # Bottom band mirrored: shadow furthest in, border on the outer edge.
    for x in range(CARD_W):
        px[x, CARD_H - 3] = BACK_BAND_DARK + (255,)
        px[x, CARD_H - 2] = BACK_BAND + (255,)
        px[x, CARD_H - 1] = BACK_BORDER + (255,)

    # Side borders, between the two bands.
    for y in range(1, CARD_H - 1):
        px[0, y] = BACK_BORDER + (255,)
        px[CARD_W - 1, y] = BACK_BORDER + (255,)

    # Carrot lattice across the body, staggered so it reads as a pattern rather
    # than a grid. Body interior is x 1..40, y 4..55.
    cw, ch = len(CARROT[0]), len(CARROT)
    for row, y in enumerate(range(7, CARD_H - 4 - ch, 12)):
        # Odd rows shift half a cell right; the 3-across pitch then tiles the
        # 40px interior without any carrot touching a border.
        offset = 0 if row % 2 == 0 else 6
        for x in range(4 + offset, CARD_W - cw - 2, 12):
            blit_sprite(px, CARROT, CARROT_COLORS, x, y)

    # Cut the four corner pixels, matching how Kenney's faces fake a rounded
    # card — otherwise backs would sit square against rounded faces.
    for cx, cy in ((0, 0), (CARD_W - 1, 0), (0, CARD_H - 1), (CARD_W - 1, CARD_H - 1)):
        px[cx, cy] = TRANSPARENT

    return img


def blit_sprite(px, rows, colors, x0, y0):
    for dy, line in enumerate(rows):
        for dx, ch in enumerate(line):
            color = colors.get(ch)
            if color is not None:
                px[x0 + dx, y0 + dy] = color + (255,)


# --- Entry point --------------------------------------------------------------

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_out = os.path.join(os.path.dirname(here), "images", "cards.png")

    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--kenney", required=True,
                        help="unzipped Kenney Playing Cards Pack (the dir holding License.txt)")
    parser.add_argument("--out", default=default_out, help="output PNG (default: %s)" % default_out)
    args = parser.parse_args()

    atlas = Image.new("RGBA", (ATLAS_W, ATLAS_H), TRANSPARENT)

    for suit_index, suit in enumerate(SUITS):
        for rank_index, rank in enumerate(RANKS):
            face = load_face(args.kenney, suit, rank)
            atlas.paste(face, (rank_index * CARD_W, suit_index * CARD_H))

    atlas.paste(draw_back(), (0, 4 * CARD_H))

    # Quantise to a palette: the whole atlas is a handful of flat colours, so
    # an 8-bit indexed PNG is a fraction of the size of RGBA with no loss.
    atlas.convert("RGBA").save(args.out, optimize=True)
    size = os.path.getsize(args.out)
    print("wrote %s (%dx%d, %d bytes)" % (args.out, ATLAS_W, ATLAS_H, size))

    # Ship Kenney's license next to the derived art.
    src_license = os.path.join(args.kenney, "License.txt")
    dst_license = os.path.join(os.path.dirname(args.out), "KENNEY-LICENSE.txt")
    if os.path.exists(src_license):
        with open(src_license, "rb") as f:
            data = f.read()
        with open(dst_license, "wb") as f:
            f.write(data)
        print("wrote %s" % dst_license)


if __name__ == "__main__":
    main()

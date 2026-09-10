// Hop — canvas renderer. (Shipped as "Flappy Rabbits"; the slug stays `hop`.)
//
// Pixel art at a fixed 320px internal WIDTH, upscaled by CSS with
// `image-rendering: pixelated` — the same approach as snake and solitaire.
// Every draw call in the SCENERY is an axis-aligned integer rect, so the
// upscale lands on exact pixel blocks at any size.
//
// The RABBIT is the one exception, and it is a knowing one: it is the mobile
// app's hopping bunny, which is a round bezier shape that tilts through its
// arc. See the rabbit section at the bottom of this file.
//
// FULL-BLEED, WITHOUT MAKING THE PLAY FIELD RESPONSIVE. The canvas fills the
// viewport, but the PLAY FIELD is always the same 320x480 world the physics in
// js/game.js is expressed in. Spare screen height is drawn as extra sky above
// the field and extra earth below it (see resize + `offsetY`), so a taller
// phone sees more scenery and never more playable room. That distinction is
// load-bearing: the game has global leaderboards, and a world that grew with
// the screen would mean a tall device played an easier game for the same board.
//
// WIDTH grows instead of letterboxing. A window wider than the world's 2:3
// used to fit by height and leave the page background as bars down both sides
// — on a 1400x800 desktop that was 433 px of flat green either side of a
// 533 px board, more of the screen than the game. So a wide view now fits by
// HEIGHT and widens the world to fill the rest.
//
// What makes that safe is that the rabbit moves with the right edge: gates
// spawn at the edge of the view and the rabbit sits SPAWN_LEAD (244 world px)
// in from it on every screen, so the visible run-up in front of it is
// identical everywhere and the extra width is garden the rabbit has already
// passed. See the difficulty-invariant note in js/game.js. Gates still never
// pop into existence in open air, because the spawn point is the edge itself.
//
// The rabbit is drawn with paths rather than authored as a sprite sheet, which
// buys two things a PNG wouldn't: no second HTTP request on the mobile WebView,
// and a pose that is a continuous function of the physics (see the rabbit
// section) instead of three hand-drawn frames kept in sync.

(function () {
  // The world's narrowest width, and what a portrait phone plays at. `this.w`
  // is the live one — resize() may widen it, never narrow it. Mirrors
  // MIN_WIDTH in js/game.js.
  var MIN_W = 320;
  var H = 480;
  var GROUND_Y = 424;

  // How the spare screen height is spent, in world pixels.
  //
  // Sky takes the larger share because it is the half that stays alive: the
  // clouds drift through it, the HUD floats over it, and the hedges hanging
  // from the ceiling run up through it. Earth below the grass line is pure
  // foreground — past a point it is just a brown band, so it gets the smaller
  // cut and the lower cap.
  //
  // The sky cap is the one with teeth. The ceiling CLAMPS the rabbit at world
  // y = 0 (js/game.js) and that line cannot move with the screen — the game
  // has global leaderboards, so the playable box has to be identical on every
  // device. However much sky is drawn above the line, the rabbit still stops
  // at it, so the band is capped to keep that stop up near the top edge where
  // it reads as the top of the world rather than as a hover in mid-air.
  var SKY_SHARE = 0.7;
  var SKY_EXTRA_MAX = 170;
  var EARTH_EXTRA_MAX = 120;
  // The sky is banded rather than graduated — a real gradient would dither and
  // break the pixel look. Both bands are measured UP FROM THE HORIZON, not down
  // from the top of the canvas: anchored to the top, a taller screen would push
  // the haze into the middle of the sky, where a hard horizontal line has
  // nothing to explain it. Anchored to the ground it stays where atmospheric
  // haze belongs, just above the hills, at any height. Two steps rather than
  // one because on a full-screen canvas a single edge that big reads as a
  // waterline; split in two, each step is half the jump.
  var HAZE_MID_ABOVE_HORIZON = 186;
  var HAZE_LOW_ABOVE_HORIZON = 92;

  // Sky, back to front.
  var SKY_TOP = "#7ec8ef";
  var SKY_MID = "#8ad0f1";
  var SKY_BOTTOM = "#9ad8f3";
  var CLOUD = "#e8f6fd";
  var HILL_FAR = "#93c98d";
  var HILL_NEAR = "#6aa862";

  // Ground. Deliberately the DARKEST of the three greens: the far hills are
  // the lightest and the near hills sit between them. Value separation is what
  // sorts the layers by distance here — they are all green, so hue can't.
  var GRASS = "#4e8c47";
  var GRASS_DARK = "#35682f";
  var EARTH = "#9a6b43";
  var EARTH_DARK = "#7a5233";

  // Hedges — the obstacle. Deliberately NOT carrots: the player is a rabbit,
  // and an obstacle shaped like the thing rabbits chase reads as a collectible
  // no matter how it is coloured. A hedge is unambiguous.
  var HEDGE = "#4a9b3f";
  var HEDGE_LIGHT = "#6fc25e";
  var HEDGE_DARK = "#2f6b28";
  var HEDGE_EDGE = "#1f4a1b";

  // Rabbit. Straight off the app: RabbitLoader's `color` default is #FFFFFF and
  // its eye is #3f3334. There is no second fur tone, no outline and no pink in
  // the mobile bunny, so there is none here either — see the rabbit section.
  var FUR = "#ffffff";
  var EYE = "#3f3334";
  // The app's `<Shadow dx={0} dy={2} blur={4} rgba(0,0,0,0.1) />` under the body,
  // scaled to world px. The alpha is the one number lifted rather than copied:
  // at 160px of Skia canvas 10% black is a visible lift, and at a 22px sprite it
  // is nothing at all. This is the smallest value that still parts white fur
  // from a white cloud, which is the one place an unoutlined rabbit can vanish.
  var BODY_SHADOW = "rgba(0, 0, 0, 0.2)";
  // The dust the mobile loader sheds at push-off, in its own colour. Kept small
  // and short-lived precisely BECAUSE the sky already has clouds in it: at this
  // size and this fade a light puff reads as motion rather than as weather.
  var DUST = "#e5e5e5";
  // The mobile loader's ground shadow is #666 on a flat panel. Retinted here —
  // it falls on grass, and neutral grey on green reads as a washed-out patch
  // rather than as shade.
  var SHADOW_RGB = "40, 56, 34";

  // Sprite footprint. Must match RABBIT_W / RABBIT_H in js/game.js: the hitbox
  // is this box inset by (4, 3), and the body below is scaled to sit inside it.
  var RABBIT_W = 22;
  var RABBIT_H = 18;
  // Mobile unit -> world px. The mobile bunny is authored against a 50x30 body;
  // scaling that to RABBIT_W wide makes it 13.2 tall, within a pixel of the
  // 12-tall hitbox. So the drawn body IS very nearly the box that kills, and the
  // ears, tail and legs hanging outside it stay decorative — exactly the split
  // the old rect sprite had.
  var K = RABBIT_W / 50;

  // Mirrors js/game.js. Only used to normalise vy into an angle and a shadow
  // size, so drift here costs a few degrees of tilt rather than desyncing
  // anything that matters.
  var FLAP_VELOCITY = -7.2;
  var MAX_FALL = 10.5;

  // The mobile loader rotates -10deg (0.175 rad) climbing and +10deg falling.
  // The climb keeps that angle exactly. The dive is allowed well past it,
  // because in a loader the fall lasts three frames and here it lasts seconds
  // and is the cue the player steers by — capped at +10deg the rabbit reads as
  // level all the way into the ground.
  var TILT_UP = 0.175;
  var TILT_DOWN = 0.62;

  // Ear sweep, from the mobile loader's two ear rotations. Negative is back.
  var EAR_ROT_BACK = -0.65;
  var EAR_ROT_FRONT = -0.2;

  // How long the leg kick and the dust puff run after a flap, in ms. The mobile
  // loader spends about a fifth of its 1.2s cycle on the kick and lets the dust
  // live a little longer; these are those two spans, and they are what the
  // flap-driven parts are measured against instead of `progress`.
  var KICK_MS = 260;
  var DUST_MS = 420;
  // A flap can come every few frames, so the pool is capped. Oldest out first.
  var DUST_MAX = 6;

  // Parallax rates, as a fraction of the world's scroll speed.
  var CLOUD_RATE = 0.18;
  var HILL_FAR_RATE = 0.32;
  var HILL_NEAR_RATE = 0.52;

  function HopRenderer(canvas) {
    this.canvas = canvas;
    canvas.width = MIN_W;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;

    // Buffer size and the world's vertical offset within it, all set by
    // resize(). `offsetY` is added to every world y on the way to the canvas.
    // `w` is read by the game's frame loop, which is how the simulation finds
    // out the view got wider.
    this.w = MIN_W;
    this.h = H;
    this.offsetY = 0;

    // Cloud positions are fixed in world space; only the offset moves. Seeded
    // once so they don't reshuffle every frame.
    //
    // `yf` is a FRACTION of the sky band rather than an absolute y, and the
    // fractions run deeper than the original five did (which all sat in the
    // top 120 px of a 480-tall board). On a full-screen canvas that left the
    // whole middle of the sky empty — and the middle of the sky is most of what
    // the player is looking at. Seven clouds spread over 0.10–0.40 of the band
    // keeps the parallax readable there without crowding the gap zone, which
    // starts around 0.45 once the offset is counted in.
    this.clouds = [
      { x: 30, yf: 0.10, w: 46 },
      { x: 118, yf: 0.29, w: 38 },
      { x: 205, yf: 0.17, w: 62 },
      { x: 300, yf: 0.39, w: 44 },
      { x: 380, yf: 0.23, w: 52 },
      { x: 455, yf: 0.34, w: 40 },
      { x: 520, yf: 0.13, w: 56 },
    ];
    this.cloudSpan = 560;

    // Flap-driven animation state. `_flapPending` is set by flap() and consumed
    // by the next draw, because the puff needs the rabbit's position and the
    // world's scroll to be anchored — and the caller (js/application.js, off the
    // game's onFlap) knows neither.
    this._flapPending = false;
    // -Infinity, not 0: at 0 the first frame would read as "flapped just now"
    // and the rabbit would kick its legs out on the title screen.
    this._flapAt = -Infinity;
    this._dust = [];

    var self = this;
    this._onResize = function () { self.resize(); };
    window.addEventListener("resize", this._onResize);
    // iOS fires this before `resize` has the new dimensions on some versions,
    // and Android WebViews sometimes fire only this one.
    window.addEventListener("orientationchange", this._onResize);
    this.resize();
  }

  // Size the buffer and the element to the viewport. No redraw here: the frame
  // loop in js/game.js runs continuously (it drives the idle bob), so the next
  // frame repaints at the new size on its own.
  HopRenderer.prototype.resize = function () {
    // Measured from the viewport, NOT from the element box: the stage
    // shrink-wraps the canvas, so measuring the element would feed its own
    // previous size back in and it could never shrink.
    var vw = Math.max(1, window.innerWidth || MIN_W);
    var vh = Math.max(1, window.innerHeight || H);

    var scale = vw / MIN_W;
    var h = Math.round(vh / scale);
    var w = MIN_W;
    var offset = 0;

    if (h < H) {
      // Wider than the world's 2:3, so the play field can't fill the width at
      // this scale. Fit by HEIGHT and spend the surplus width on more world
      // instead of on bars: the rabbit rides SPAWN_LEAD in from the right
      // edge wherever that edge lands, so the widening happens behind it and
      // the run-up in front is unchanged (see js/game.js). Rounded UP so the
      // canvas can never come out a hair narrower than the viewport and leave
      // a one-pixel seam of page background down one side.
      scale = vh / H;
      h = H;
      w = Math.max(MIN_W, Math.ceil(vw / scale));
    } else {
      // Split the spare height between sky and earth, capped.
      var extra = h - H;
      var sky = Math.min(SKY_EXTRA_MAX, Math.round(extra * SKY_SHARE));
      var earth = Math.min(EARTH_EXTRA_MAX, extra - sky);
      // Hand back whatever the earth's cap refused, so the screen still fills
      // exactly while EITHER side has room. Only a viewport taller than both
      // caps together (past about 2.5:1, which no shipping device is) ends up
      // letterboxed top and bottom instead — the right trade at that point,
      // since the alternative is a slab of dirt half the screen deep.
      if (sky + earth < extra) sky = Math.min(SKY_EXTRA_MAX, extra - earth);
      h = H + sky + earth;
      offset = sky;
    }

    this.offsetY = offset;
    this.h = h;
    this.w = w;
    if (this.canvas.width !== w) {
      // Same guard as the height below: assigning either dimension clears the
      // buffer and resets the context.
      this.canvas.width = w;
      this.ctx.imageSmoothingEnabled = false;
    }
    if (this.canvas.height !== h) {
      // Assigning the buffer size also clears it and resets the 2D context
      // state, so this is guarded — an orientation change that lands on the
      // same height shouldn't blank a frame — and the nearest-neighbour flag
      // is re-applied after it. Nearest neighbour on the way IN too, so
      // anything the browser has to resample stays blocky rather than soft.
      this.canvas.height = h;
      this.ctx.imageSmoothingEnabled = false;
    }
    var cssW = Math.round(w * scale);
    var cssH = Math.round(h * scale);
    this.canvas.style.width = cssW + "px";
    this.canvas.style.height = cssH + "px";

    // Publish the picture's size to CSS, for the overlay's type and the HUD.
    // These now track the viewport closely — the scene fills it on both axes
    // in every normal case — but they stay the honest measurement rather than
    // `100vw`/`100vh`, because a viewport past about 2.5:1 still letterboxes
    // top and bottom (see the earth cap above). styles.css reads them with
    // viewport fallbacks for the paint before this first runs.
    var root = document.documentElement;
    root.style.setProperty("--stage-w", cssW + "px");
    root.style.setProperty("--stage-h", cssH + "px");
  };

  HopRenderer.prototype._rect = function (x, y, w, h, color) {
    var ctx = this.ctx;
    ctx.fillStyle = color;
    // Rounded to whole pixels so the upscale can't produce a half-lit column.
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  };

  HopRenderer.prototype._drawSky = function (horizon) {
    // Painted top-down, each band over the last, so the whole buffer is
    // covered whatever the height and no seam can open between them.
    var mid = Math.max(0, horizon - HAZE_MID_ABOVE_HORIZON);
    var low = Math.max(0, horizon - HAZE_LOW_ABOVE_HORIZON);
    this._rect(0, 0, this.w, this.h, SKY_TOP);
    this._rect(0, mid, this.w, this.h - mid, SKY_MID);
    this._rect(0, low, this.w, this.h - low, SKY_BOTTOM);
  };

  // A cloud is three overlapping bars — wide in the middle, narrower above.
  // Enough to read as a cloud at this scale, and it stays crisp because every
  // edge is on a pixel boundary.
  HopRenderer.prototype._drawClouds = function (scroll, horizon) {
    var offset = (scroll * CLOUD_RATE) % this.cloudSpan;
    // One tile of the cloud field is `cloudSpan` wide, so a view wider than
    // that needs more than the two passes a 320-wide world got — on a desktop
    // the world runs to ~840 px and the right third of the sky would come out
    // empty. Two spare passes cover the scroll offset at either end.
    var passes = Math.ceil(this.w / this.cloudSpan) + 2;
    for (var pass = 0; pass < passes; pass++) {
      var base = -offset + pass * this.cloudSpan;
      for (var i = 0; i < this.clouds.length; i++) {
        var c = this.clouds[i];
        var x = base + c.x;
        if (x > this.w || x + c.w < 0) continue;
        var cy = Math.round(c.yf * horizon);
        this._rect(x, cy + 6, c.w, 7, CLOUD);
        this._rect(x + 8, cy, c.w - 20, 7, CLOUD);
        this._rect(x + 16, cy - 5, c.w - 34, 6, CLOUD);
      }
    }
  };

  // Deterministic 0..1 from an integer. Used to vary hill heights so the
  // skyline isn't a row of identical bumps, while staying stable as a mound
  // scrolls across the screen — a Math.random() here would make every hill
  // flicker to a new height on every frame.
  function hash(n) {
    var x = Math.sin(n * 127.1) * 43758.5453;
    return x - Math.floor(x);
  }

  // Rolling hills: one mound per `spacing` of world, drawn as a stack of
  // centred bars that narrows toward the top. Two layers at different rates
  // give the depth cue that tells the player the world is moving even when no
  // hedge is on screen.
  //
  // The widths are expressed as fractions of `spacing`, not of the mound's
  // height. Keyed to height, a short-and-wide layer produces bars wider than
  // the gap between mounds, and the whole range merges into one flat slab with
  // no visible mound shape at all. Tying them to the spacing keeps the bases
  // just touching and the peaks clearly separate at any size.
  HopRenderer.prototype._drawHills = function (scroll, rate, baseY, height, color, spacing, phase) {
    var STEPS = 5;
    var offset = (scroll * rate) % spacing;
    // One mound either side of the viewport so none pops in at the edges.
    // Must match the index `cx` below places the mound at, which derives from
    // `offset` (an unshifted modulo) — folding `phase` in here instead makes
    // the two disagree by one whenever (scroll * rate) % spacing < phase, and
    // every mound in the layer snaps to its neighbour's height.
    var firstIndex = Math.floor((scroll * rate) / spacing) - 1;

    for (var i = -1; i <= Math.ceil(this.w / spacing) + 1; i++) {
      var cx = -offset + phase + i * spacing;
      if (cx + spacing < 0 || cx - spacing > this.w) continue;
      // Height varies per mound, keyed to its position in the world rather
      // than to its position on screen, so it stays the same mound as it moves.
      var h = height * (0.66 + 0.34 * hash(firstIndex + i + 1));
      for (var s = 0; s < STEPS; s++) {
        // t runs 0 at the mound's PEAK to nearly 1 at its base, so the width
        // has to GROW with t. Shrinking it instead builds the mound upside
        // down — a wide cap over a narrow foot — and since the caps are then
        // wider than the gap between mounds, the whole range merges into one
        // speckled band with no hill shape anywhere in it.
        var t = s / STEPS;
        var halfW = spacing * (0.22 + t * 0.40);
        var y = baseY - h * (1 - t);
        this._rect(cx - halfW, y, halfW * 2, h / STEPS + 1, color);
      }
    }
  };

  // `horizon` is the ground line in CANVAS coordinates. The earth runs from
  // there to the bottom of the buffer, so a tall screen deepens the foreground
  // instead of leaving a gap under a fixed-height strip.
  HopRenderer.prototype._drawGround = function (scroll, horizon) {
    this._rect(0, horizon, this.w, this.h - horizon, EARTH);
    this._rect(0, horizon, this.w, 10, GRASS);
    this._rect(0, horizon + 10, this.w, 2, GRASS_DARK);

    // Scrolling texture: grass tufts on the surface and pebbles below, both
    // keyed to world position so they move at exactly the world's speed. This
    // is the only layer at rate 1.0, and it's what makes the scroll speed
    // legible.
    var tuftSpacing = 14;
    var offset = scroll % tuftSpacing;
    for (var x = -offset; x < this.w; x += tuftSpacing) {
      // Blades stand above the strip in the strip's own colour, so they read
      // as grass against the lighter hills behind rather than as loose specks.
      this._rect(x, horizon - 3, 2, 3, GRASS);
      this._rect(x + 5, horizon - 2, 2, 2, GRASS);
      this._rect(x + 9, horizon + 3, 3, 2, GRASS_DARK);
    }
    // Two rows of pebbles at different depths, the second only where the
    // foreground is deep enough to hold it — on a 2:3 screen there is no room
    // below the first row.
    var pebbleSpacing = 37;
    var pOffset = scroll % pebbleSpacing;
    for (var px = -pOffset; px < this.w; px += pebbleSpacing) {
      this._rect(px + 6, horizon + 20, 4, 3, EARTH_DARK);
      this._rect(px + 20, horizon + 34, 3, 2, EARTH_DARK);
      if (this.h - horizon > 100) {
        this._rect(px + 13, horizon + 66, 4, 3, EARTH_DARK);
        this._rect(px + 29, horizon + 82, 3, 2, EARTH_DARK);
      }
    }
  };

  // One hedge column. `capAtBottom` says which end faces the gap, so the
  // thicker lip is drawn on the edge the player is actually threading past.
  //
  // The lip overhangs the column by `capOverhang` on each side, and collision
  // (js/game.js) tests the column's width only — so the outer few pixels of the
  // lip are decorative and cannot kill. That asymmetry is deliberate and in the
  // player's favour: the corner of the lip is exactly where a near-miss
  // happens, and dying to it feels arbitrary in a way that clipping it visibly
  // does not. Keep it small enough that the pass still looks like a pass.
  HopRenderer.prototype._drawHedgeColumn = function (x, top, height, capAtBottom) {
    if (height <= 0) return;
    var w = 46;              // must match GATE_W in js/game.js
    var capH = 12;
    var capOverhang = 4;

    this._rect(x, top, w, height, HEDGE);
    // Vertical shading: a lit left edge and a dark right edge give the column
    // volume without any gradient.
    this._rect(x, top, 4, height, HEDGE_LIGHT);
    this._rect(x + w - 5, top, 5, height, HEDGE_DARK);
    this._rect(x, top, 1, height, HEDGE_EDGE);
    this._rect(x + w - 1, top, 1, height, HEDGE_EDGE);

    // Leaf texture — short horizontal dashes, offset per row so they don't
    // line up into stripes.
    for (var y = top + 6; y < top + height - 4; y += 9) {
      var jog = ((y / 9) | 0) % 2 === 0 ? 8 : 18;
      this._rect(x + jog, y, 7, 2, HEDGE_DARK);
      this._rect(x + jog + 12, y + 4, 5, 2, HEDGE_LIGHT);
    }

    // The lip at the gap end.
    var capY = capAtBottom ? top + height - capH : top;
    this._rect(x - capOverhang, capY, w + capOverhang * 2, capH, HEDGE);
    this._rect(x - capOverhang, capY, 4, capH, HEDGE_LIGHT);
    this._rect(x + w + capOverhang - 5, capY, 5, capH, HEDGE_DARK);
    this._rect(x - capOverhang, capY, w + capOverhang * 2, 2,
      capAtBottom ? HEDGE_LIGHT : HEDGE_EDGE);
    this._rect(x - capOverhang, capY + capH - 2, w + capOverhang * 2, 2,
      capAtBottom ? HEDGE_EDGE : HEDGE_DARK);
    this._rect(x - capOverhang, capY, 1, capH, HEDGE_EDGE);
    this._rect(x + w + capOverhang - 1, capY, 1, capH, HEDGE_EDGE);
  };

  HopRenderer.prototype._drawGates = function (gates, horizon) {
    var off = this.offsetY;
    for (var i = 0; i < gates.length; i++) {
      var gate = gates[i];
      var gapTop = gate.gapY - gate.gap / 2;
      var gapBottom = gate.gapY + gate.gap / 2;
      // The ceiling column is drawn from the TOP OF THE CANVAS, not from world
      // y = 0: the sky band above the field is decorative, and a hedge that
      // stopped at the field's edge would hang in mid-air with a stripe of sky
      // above it. Its length grows by `off`; its GAP end does not move, so
      // collision (which only knows the world) is untouched.
      this._drawHedgeColumn(gate.x, 0, gapTop + off, true);
      this._drawHedgeColumn(gate.x, gapBottom + off, horizon - (gapBottom + off), false);
    }
  };

  // -------- the rabbit --------
  //
  // Ported from the mobile app's hopping bunny
  // (oddsrabbit-app/src/components/ui/RabbitLoader.tsx), which is itself a Skia
  // recreation of the web app's CSS loader
  // (app/public/inc/css/elements/rabbit-loader.css). Same silhouette — the
  // `border-radius: 70% 90% 60% 50%` body, the two swept-back ear ovals, the
  // circle tail and legs — and the same four moving parts: a tilt through the
  // arc, legs that kick out and tuck back, dust shed at the push-off, and a
  // ground shadow that shrinks and fades as the rabbit climbs.
  //
  // WHAT THE PORT CHANGED, and why. The loader plays a fixed 1.2s clock:
  // `progress` runs 0..1 and every moving part is an interpolate() off it. There
  // is no cycle to read here — the rabbit is a physics body whose next move is
  // the player's — so the clock is replaced by the two things the simulation
  // actually knows. `vy` drives the tilt, the ear sweep and the shadow; the
  // moment of the last flap drives the kick and the dust. Every ratio below is
  // the mobile one. Only what parameterises them differs.
  //
  // WHAT THE PORT NO LONGER CHANGES. An earlier pass here drew the rabbit with a
  // dark outline, a cream fur with a shaded belly, a pink inner ear and a pink
  // nose — none of which the app has. They were added for contrast: white fur
  // crosses pale sky, white clouds and light hills, and a flat silhouette can
  // dissolve into all three at the moment the player most needs to see it. All
  // four are gone. The rabbit is the app's flat white silhouette, and the
  // contrast job is done the way the app already does it — by the soft drop
  // shadow under the body — rather than by drawing a different rabbit.
  //
  // One departure is left, and it is structural rather than stylistic:
  //
  //   - THE RABBIT IS THE ONE THING IN THE SCENE OFF THE PIXEL GRID. The scenery
  //     is integer rects that survive the upscale as exact blocks; these are
  //     bezier fills, so the rabbit carries an anti-aliased fringe that the
  //     upscale enlarges into soft blocks along its curves. That is the accepted
  //     cost of using the round shape rather than a rect approximation of it.

  // The body outline, traced with (0,0) at the body centre — which is also the
  // point the tilt rotates about, the origin the mobile loader uses. Reads as
  // the CSS `border-radius: 70% 90% 60% 50%`: a high round shoulder at the back,
  // the roundest corner at the top front where the head is, a flatter belly.
  function traceBody(ctx) {
    var bw = 50 * K;
    var bh = 30 * K;
    var left = -bw / 2, right = bw / 2, top = -bh / 2, bottom = bh / 2;
    var tlR = bw * 0.7, trR = bw * 0.9, brR = bw * 0.6, blR = bw * 0.5;

    ctx.beginPath();
    ctx.moveTo(left, 0);
    ctx.bezierCurveTo(left, top + bh * 0.3, left + tlR * 0.3, top, left + tlR * 0.5, top);
    ctx.lineTo(right - trR * 0.5, top);
    ctx.bezierCurveTo(right - trR * 0.2, top, right, top + bh * 0.1, right, -bh * 0.1);
    ctx.bezierCurveTo(right, bh * 0.2, right - brR * 0.2, bottom, right - brR * 0.4, bottom);
    ctx.lineTo(left + blR * 0.4, bottom);
    ctx.bezierCurveTo(left + blR * 0.2, bottom, left, bh * 0.3, left, 0);
    ctx.closePath();
  }

  // `ctx.ellipse` is the whole point of the shape and has been everywhere for
  // years, but the fallback costs three lines: build the arc under a squashed
  // transform, which puts the same oval into the path in user space.
  function traceOval(ctx, cx, cy, rx, ry) {
    ctx.beginPath();
    if (ctx.ellipse) {
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      return;
    }
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(rx / ry, 1);
    ctx.arc(0, 0, ry, 0, Math.PI * 2);
    ctx.restore();
  }

  function traceCircle(ctx, cx, cy, r) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }

  // Fill only. The mobile bunny is a flat silhouette — every part is the same
  // `color` with no stroke — so there is nothing to trace twice.
  function paint(ctx, color) {
    ctx.fillStyle = color;
    ctx.fill();
  }

  // Called by js/application.js off the game's onFlap. Deferred rather than
  // acted on, see `_flapPending` in the constructor.
  HopRenderer.prototype.flap = function () {
    this._flapPending = true;
  };

  // One dust cloud, the mobile loader's three lobes in one record: a big one at
  // the origin with a smaller one either side and slightly below. Anchored to
  // the world's scroll at spawn, so it falls behind at exactly the world's speed
  // and reads as being left in the air rather than as trailing the rabbit.
  HopRenderer.prototype._spawnDust = function (x, worldY, scroll, elapsed) {
    if (this._dust.length >= DUST_MAX) this._dust.shift();
    this._dust.push({
      x: x + RABBIT_W / 2 - 6 * K,
      y: worldY + RABBIT_H / 2 + 6 * K,
      scroll: scroll,
      t0: elapsed,
    });
  };

  HopRenderer.prototype._drawDust = function (scroll, elapsed) {
    var ctx = this.ctx;
    var alive = [];
    for (var i = 0; i < this._dust.length; i++) {
      var d = this._dust[i];
      var u = (elapsed - d.t0) / DUST_MS;
      if (u < 0 || u >= 1) continue;
      alive.push(d);

      // Mobile: opacity 0 -> 0.75 by 40% of the puff's life, then out by 55%.
      // Same peak, same shape, stretched over the whole life so the tail of the
      // fade isn't a step.
      var alpha = u < 0.45 ? 0.75 * (u / 0.45) : 0.75 * (1 - (u - 0.45) / 0.55);
      // Drifts back 40 mobile units over its life, on TOP of the world's scroll.
      var dx = (d.x - (scroll - d.scroll)) - 40 * K * u;
      var dy = d.y + this.offsetY;
      var g = 1 + 0.5 * u;   // and spreads as it goes

      ctx.globalAlpha = Math.max(0, alpha);
      ctx.fillStyle = DUST;
      traceCircle(ctx, dx, dy, 10 * K * g);
      ctx.fill();
      traceCircle(ctx, dx - 12 * K * g, dy + 2 * K, 6 * K * g);
      ctx.fill();
      traceCircle(ctx, dx + 10 * K * g, dy + 2 * K, 7 * K * g);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    this._dust = alive;
  };

  // The ground shadow, on the grass rather than at the ground line: the bottom
  // hedge columns are drawn before the ground strip, so a shadow ON the line
  // would paint over the base of whichever hedge the rabbit is passing.
  //
  // In the loader the shadow squashes to 40% and fades to a third of its opacity
  // at the top of a 40px hop. Here the same two curves are driven by real height
  // above the ground, which is the version the mobile one was approximating.
  HopRenderer.prototype._drawShadow = function (x, worldY, horizon) {
    var ctx = this.ctx;
    var altitude = GROUND_Y - (worldY + RABBIT_H);
    var t = Math.max(0, Math.min(1, altitude / (GROUND_Y - RABBIT_H)));
    var scale = 1 - 0.6 * t;
    var alpha = 0.3 - 0.2 * t;

    traceOval(ctx, x + RABBIT_W / 2, horizon + 5, 20 * K * scale, 3 * K);
    ctx.fillStyle = "rgba(" + SHADOW_RGB + ", " + alpha + ")";
    ctx.fill();
  };

  // `y` is the sprite's top-left in CANVAS coordinates; `vy` and `elapsed` come
  // straight off the simulation.
  HopRenderer.prototype._drawRabbit = function (x, y, vy, elapsed) {
    var ctx = this.ctx;
    var bh = 30 * K;

    // Two normalised readings of the vertical speed. `rise` is 1 at the instant
    // of a flap, `dive` is 1 at terminal velocity, and both are 0 at the hang
    // point between them — so every pose below is continuous through the top of
    // the arc rather than snapping between three states the way the old
    // three-valued `tilt` did.
    var rise = Math.max(0, Math.min(1, vy / FLAP_VELOCITY));
    var dive = Math.max(0, Math.min(1, vy / MAX_FALL));
    var rot = -TILT_UP * rise + TILT_DOWN * dive;

    // Ears blow back on the climb and settle forward in a dive, on top of the
    // mobile loader's two resting angles.
    var sweep = -0.3 * rise + 0.12 * dive;

    // The kick. One arch over KICK_MS: legs swing out and tuck back, the mobile
    // loader's legPeek / backLegKick / frontLegReach amplitudes on a sine rather
    // than on its keyframes. Past KICK_MS the legs are tucked and hidden, which
    // is the loader's resting state too.
    var kick = Math.max(0, Math.min(1, (elapsed - this._flapAt) / KICK_MS));
    var extend = Math.sin(Math.PI * kick);

    ctx.save();
    ctx.translate(x + RABBIT_W / 2, y + RABBIT_H / 2);
    ctx.rotate(rot);

    // Legs, behind everything. Both are the app's plain `color` circles — the
    // back one 5 units, the front one 3 — and both fade in with `extend` as well
    // as moving with it: at rest the loader hides them entirely, and a rabbit in
    // a glide reads better tucked.
    if (extend > 0.01) {
      var legY = bh / 2 - 4 * K + 5 * K * extend;
      ctx.globalAlpha = Math.min(1, extend * 2);
      traceCircle(ctx, -14 * K - 5 * K * extend, legY, 5 * K);
      paint(ctx, FUR);
      traceCircle(ctx, 14 * K + 6 * K * extend, legY, 3 * K);
      paint(ctx, FUR);
      ctx.globalAlpha = 1;
    }

    // Tail, then body, then ears over the top — the app's own paint order. The
    // ears used to go under the body so its outline could close over their
    // bases; with no outline to close, they sit on top the way Skia draws them.
    traceCircle(ctx, -25 * K + 3 * K, -15 * K + 8 * K, 5 * K);
    paint(ctx, FUR);

    // Body. The one shape that carries the app's drop shadow, and the reason a
    // white rabbit still reads against a white cloud. Reset immediately: a
    // shadow left on would fall from the ears and the face dot too, and at this
    // size that reads as grime rather than as depth.
    ctx.shadowColor = BODY_SHADOW;
    ctx.shadowBlur = 4 * K;
    ctx.shadowOffsetY = 2 * K;
    traceBody(ctx);
    paint(ctx, FUR);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    var earW = 7.5 * K, earH = 18 * K;
    var earBaseX = 6 * K;
    // The mobile source writes this drop as `- earH + 6` with an unscaled 6,
    // so its ears creep down the head as `size` grows. Scaled here, which is
    // what that line meant.
    var earY = (-bh / 2 + 2 * K) - earH + 6 * K;
    var ears = [
      { x: earBaseX - 4 * K, rot: EAR_ROT_BACK + sweep },
      { x: earBaseX + 3 * K, rot: EAR_ROT_FRONT + sweep },
    ];
    for (var i = 0; i < ears.length; i++) {
      ctx.save();
      // Rotated about the top of the body, where an ear is actually hinged.
      ctx.translate(0, -bh / 2);
      ctx.rotate(ears[i].rot);
      ctx.translate(0, bh / 2);
      traceOval(ctx, ears[i].x + earW / 2, earY + earH / 2, earW / 2, earH / 2);
      paint(ctx, FUR);
      ctx.restore();
    }

    // Face — the app's whole face: one eye and its glint, at the app's offsets
    // (eyeR * 0.15 across, eyeR * 0.2 up, 0.35 of the radius). The eye itself is
    // a touch larger than the app's 2.5 units, which was authored on a rabbit
    // three times this size — at the honest ratio it lands under two pixels
    // across and the rabbit has no expression at all. There is no nose: the app
    // leaves it off, and the head shape carries the front without one.
    var eyeR = 1.6;
    var eyeX = 50 * K * 0.3, eyeY = -bh * 0.15;
    traceCircle(ctx, eyeX, eyeY, eyeR);
    paint(ctx, EYE);
    traceCircle(ctx, eyeX + eyeR * 0.15, eyeY - eyeR * 0.2, eyeR * 0.35);
    paint(ctx, "#ffffff");

    ctx.restore();
  };

  HopRenderer.prototype.draw = function (state) {
    var scroll = state.scroll;
    // Everything below is in CANVAS coordinates: world y + offsetY. The ground
    // line is the one both halves of the scene hang off, so it's resolved once.
    var off = this.offsetY;
    var horizon = GROUND_Y + off;

    this._drawSky(horizon);
    this._drawClouds(scroll, horizon);
    // Spacing, not a wrap width: each layer draws one mound every N world px.
    // The far layer is wider-spaced and taller, the near one tighter and
    // shorter, which reads as distance.
    // Both layers are based ON the ground line (the near one a little below
    // it, where the grass strip covers the join). Basing them above it leaves a
    // sliver of sky between the hills and the grass, which reads as a glowing
    // seam right across the busiest part of the screen.
    this._drawHills(scroll, HILL_FAR_RATE, horizon - 3, 48, HILL_FAR, 96, 0);
    this._drawHills(scroll, HILL_NEAR_RATE, horizon + 3, 33, HILL_NEAR, 68, 34);
    this._drawGates(state.gates, horizon);
    this._drawGround(scroll, horizon);

    // A flap is consumed here rather than in flap() itself, because this is the
    // first point that knows where the rabbit was and how far the world had
    // scrolled when it happened.
    var elapsed = state.elapsed || 0;
    if (this._flapPending) {
      this._flapPending = false;
      this._flapAt = elapsed;
      this._spawnDust(state.rabbitX, state.y, scroll, elapsed);
    }

    // Shadow first (it lies on the grass), then the dust, then the rabbit over
    // both — the rabbit has just left the dust behind, so it belongs in front.
    this._drawShadow(state.rabbitX, state.y, horizon);
    this._drawDust(scroll, elapsed);
    this._drawRabbit(state.rabbitX, state.y + off, state.vy || 0, elapsed);
  };

  window.HopRenderer = HopRenderer;
})();

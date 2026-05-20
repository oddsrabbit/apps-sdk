// Canvas renderer. Internal resolution is CELL * cols × CELL * rows where
// cols/rows can grow mid-run (see `resize`); the canvas is upscaled by CSS
// with `image-rendering: pixelated` so the art stays crisp at any display
// size without needing devicePixelRatio math.

(function () {
  var CELL = 20;
  var INITIAL_COLS = 24;
  var INITIAL_ROWS = 16;

  // Game Boy palette — kept in sync with styles.css custom properties.
  var COLOR_MINT = "#cde4c4";
  var COLOR_WALL_DARK = "#0f380f";
  var COLOR_SNAKE_DARK = "#0f380f";
  var COLOR_SNAKE_MID = "#306230";
  // The one deliberate palette break: the carrot food sprite uses two warm
  // oranges so it reads instantly as the goal at sprite size. Rabbits eat
  // carrots (and the platform is OddsRabbit), so the thematic pull is worth
  // the broken-DMG-purity cost. Kept narrow — two oranges only, used by
  // _drawFood alone — so the rest of the board stays four-greens-and-mint.
  var COLOR_CARROT = "#c45e1a";
  var COLOR_CARROT_HI = "#e8893e";
  // Bonus carrot — same shape as the regular carrot, swapped to a gold
  // palette so it reads as "special" without breaking the DMG aesthetic
  // further than the carrot already does.
  var COLOR_BONUS = "#d4a017";
  var COLOR_BONUS_HI = "#f5d56a";
  // Tick threshold at which the bonus food starts flickering to signal it's
  // about to expire. Skipping the draw on alternating ticks gives a visible
  // strobe that scales naturally with game speed.
  var BONUS_FLICKER_TICKS = 10;

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    // Grid size lives on the instance because the game can grow the world
    // mid-run. Renderer.resize updates these alongside the canvas's intrinsic
    // pixel size. Force the canvas's intrinsic size from JS so it can't
    // silently desync from the HTML width/height attrs if INITIAL_* changes.
    this.cols = INITIAL_COLS;
    this.rows = INITIAL_ROWS;
    this.canvas.width = INITIAL_COLS * CELL;
    this.canvas.height = INITIAL_ROWS * CELL;

    // Snake-head sprite — the OddsRabbit "karat" rabbit icon. Loaded async;
    // until it arrives we fall back to the pre-existing mint pixel so the
    // head is still distinguishable. _lastState lets the load handler kick
    // off an immediate redraw if the first frame painted without the image
    // (otherwise the head stays plain until the next game tick).
    var self = this;
    this._lastState = null;
    this.headImage = new Image();
    this.headImageReady = false;
    this.headImage.addEventListener("load", function () {
      self.headImageReady = true;
      if (self._lastState) self.draw(self._lastState);
    });
    // No cache-busting query string: the file is tiny (~1.3KB) and renames
    // are the natural cache buster if the artwork ever changes.
    this.headImage.src = "./images/head.png";
  }

  Renderer.CELL = CELL;

  // Resize the playfield mid-game. Setting canvas.width/height resets the 2D
  // context, so imageSmoothingEnabled has to be re-applied. CSS keeps the
  // canvas's displayed width pinned at 100% of the board-frame, so growing
  // the internal grid visually zooms the cells out rather than stretching
  // the canvas.
  Renderer.prototype.resize = function (cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.canvas.width = cols * CELL;
    this.canvas.height = rows * CELL;
    this.ctx.imageSmoothingEnabled = false;
  };

  Renderer.prototype.draw = function (state) {
    // Cache the latest state so headImage.onload can repaint with the new
    // sprite if the image arrived after the first frame was already drawn.
    this._lastState = state;
    var ctx = this.ctx;
    ctx.fillStyle = COLOR_MINT;
    ctx.fillRect(0, 0, this.cols * CELL, this.rows * CELL);

    // No in-canvas wall: the .board-frame CSS pattern is the visual wall, and
    // collision now uses the canvas edges directly. Drawing wall cells here
    // duplicated the framing visually (the "double wall" effect).
    if (state.food) this._drawFood(state.food);
    if (state.bonusFood) this._drawBonusFood(state.bonusFood);
    this._drawSnake(state.snake);
  };

  Renderer.prototype._drawSnake = function (snake) {
    if (!snake || snake.length === 0) return;
    for (var i = 0; i < snake.length; i++) {
      var seg = snake[i];
      var x = seg.x * CELL;
      var y = seg.y * CELL;
      this._drawSegment(x, y, i === 0);
    }
  };

  // Body segment is a chunky dark square with a slightly brighter inset.
  // The head overlays the OddsRabbit karat (rabbit-face) sprite on top of
  // that body fill; if the sprite hasn't loaded yet, fall back to the
  // original single mint pixel so the head still reads as the head.
  Renderer.prototype._drawSegment = function (x, y, isHead) {
    var ctx = this.ctx;
    ctx.fillStyle = COLOR_SNAKE_DARK;
    ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
    ctx.fillStyle = COLOR_SNAKE_MID;
    ctx.fillRect(x + 4, y + 4, CELL - 8, CELL - 8);
    if (isHead) {
      if (this.headImageReady) {
        // Draw at full CELL size so the rabbit fills the head segment edge-
        // to-edge. The source is 32x32 → 20x20 target is a 1.6× downscale
        // with imageSmoothingEnabled=false, so it stays pixel-art-crisp at
        // the cost of dropping a few source rows/cols — fine at this size.
        ctx.drawImage(this.headImage, x, y, CELL, CELL);
      } else {
        ctx.fillStyle = COLOR_MINT;
        ctx.fillRect(x + 8, y + 8, 4, 4);
      }
    }
  };

  // Carrot sprite. Three-leaf frond in dark green on top, tapered body
  // below. Pixel coordinates are hand-placed against a 20px cell — shifting
  // CELL would require redoing them by hand (no scaling math). bodyColor
  // and hiColor are parameterised so the bonus carrot can reuse the exact
  // sprite shape with a gold palette.
  Renderer.prototype._drawCarrotSprite = function (x, y, bodyColor, hiColor) {
    var ctx = this.ctx;

    // Fronds — left tip, right tip, center stem, and a base row that spans
    // the carrot's shoulder line so the leaves visually attach to the body.
    ctx.fillStyle = COLOR_WALL_DARK;
    ctx.fillRect(x + 8, y + 2, 1, 2);
    ctx.fillRect(x + 10, y + 2, 1, 2);
    ctx.fillRect(x + 9, y + 3, 1, 2);
    ctx.fillRect(x + 7, y + 4, 6, 1);

    // Body — taper from a 6-wide shoulder down to a single-pixel tip. The
    // neck is one pixel narrower than the shoulders so the leaves read as
    // sitting on the carrot, not floating beside it.
    ctx.fillStyle = bodyColor;
    ctx.fillRect(x + 8, y + 5, 4, 1);
    ctx.fillRect(x + 7, y + 6, 6, 2);
    ctx.fillRect(x + 8, y + 8, 4, 2);
    ctx.fillRect(x + 9, y + 10, 2, 2);
    ctx.fillRect(x + 10, y + 12, 1, 1);

    // Single-pixel highlight on the upper-left shoulder. At 1/144 of the
    // sprite it's barely visible, but it's enough to suggest a light source
    // and break the body's flat-fill silhouette.
    ctx.fillStyle = hiColor;
    ctx.fillRect(x + 8, y + 6, 1, 1);
  };

  Renderer.prototype._drawFood = function (food) {
    this._drawCarrotSprite(food.x * CELL, food.y * CELL, COLOR_CARROT, COLOR_CARROT_HI);
  };

  // Bonus carrot — same sprite, gold palette, and a flicker on its last few
  // ticks so the player gets a "running out" cue. The flicker skips the
  // draw on every other tick once ticksLeft is low; because ticksLeft is
  // decremented before draw (in game.js), the odd/even parity changes each
  // frame and the sprite visibly strobes.
  Renderer.prototype._drawBonusFood = function (bonus) {
    // Flicker on the last few ticks, but always draw on ticksLeft === 0 —
    // that's still an eatable tick (game.js despawns at < 0), and a
    // silent-but-still-collidable bonus would be unfair.
    if (
      bonus.ticksLeft <= BONUS_FLICKER_TICKS &&
      bonus.ticksLeft > 0 &&
      bonus.ticksLeft % 2 === 0
    ) {
      return;
    }
    this._drawCarrotSprite(bonus.x * CELL, bonus.y * CELL, COLOR_BONUS, COLOR_BONUS_HI);
  };

  window.SnakeRenderer = Renderer;
})();

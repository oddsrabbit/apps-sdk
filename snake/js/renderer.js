// Canvas renderer. Internal resolution is fixed (CELL * COLS x CELL * ROWS)
// and the canvas is upscaled by CSS with `image-rendering: pixelated` so the
// art stays crisp at any display size without needing devicePixelRatio math.

(function () {
  var CELL = 20;
  var COLS = 24;
  var ROWS = 16;

  // Game Boy palette — kept in sync with styles.css custom properties.
  var COLOR_MINT = "#cde4c4";
  var COLOR_WALL_DARK = "#0f380f";
  var COLOR_WALL_MID = "#2c5934";
  var COLOR_WALL_HI = "#4a7c4a";
  var COLOR_SNAKE_DARK = "#0f380f";
  var COLOR_SNAKE_MID = "#306230";
  // The one deliberate palette break: the carrot food sprite uses two warm
  // oranges so it reads instantly as the goal at sprite size. Rabbits eat
  // carrots (and the platform is OddsRabbit), so the thematic pull is worth
  // the broken-DMG-purity cost. Kept narrow — two oranges only, used by
  // _drawFood alone — so the rest of the board stays four-greens-and-mint.
  var COLOR_CARROT = "#c45e1a";
  var COLOR_CARROT_HI = "#e8893e";

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;

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

  Renderer.COLS = COLS;
  Renderer.ROWS = ROWS;
  Renderer.CELL = CELL;

  Renderer.prototype.draw = function (state) {
    // Cache the latest state so headImage.onload can repaint with the new
    // sprite if the image arrived after the first frame was already drawn.
    this._lastState = state;
    var ctx = this.ctx;
    ctx.fillStyle = COLOR_MINT;
    ctx.fillRect(0, 0, COLS * CELL, ROWS * CELL);

    this._drawWall();
    if (state.food) this._drawFood(state.food);
    this._drawSnake(state.snake);
  };

  // Inner playfield wall: 1 cell thick around the perimeter. Drawn as solid
  // dark blocks with a single-pixel mid-green highlight on the top/left of
  // each block — same bevel idiom as the outer board frame so the two
  // visually nest.
  Renderer.prototype._drawWall = function () {
    var ctx = this.ctx;
    for (var x = 0; x < COLS; x++) {
      this._drawWallCell(x, 0);
      this._drawWallCell(x, ROWS - 1);
    }
    for (var y = 1; y < ROWS - 1; y++) {
      this._drawWallCell(0, y);
      this._drawWallCell(COLS - 1, y);
    }
    // 1px outline of the playable area so the playfield reads as a sunken
    // tray rather than the wall just stopping abruptly.
    ctx.fillStyle = COLOR_WALL_DARK;
    ctx.fillRect(CELL - 1, CELL - 1, (COLS - 2) * CELL + 2, 1);
    ctx.fillRect(CELL - 1, (ROWS - 1) * CELL, (COLS - 2) * CELL + 2, 1);
    ctx.fillRect(CELL - 1, CELL - 1, 1, (ROWS - 2) * CELL + 2);
    ctx.fillRect((COLS - 1) * CELL, CELL - 1, 1, (ROWS - 2) * CELL + 2);
  };

  Renderer.prototype._drawWallCell = function (cx, cy) {
    var ctx = this.ctx;
    var x = cx * CELL;
    var y = cy * CELL;
    ctx.fillStyle = COLOR_WALL_DARK;
    ctx.fillRect(x, y, CELL, CELL);
    ctx.fillStyle = COLOR_WALL_MID;
    ctx.fillRect(x + 3, y + 3, CELL - 6, CELL - 6);
    ctx.fillStyle = COLOR_WALL_HI;
    ctx.fillRect(x + 3, y + 3, CELL - 6, 1);
    ctx.fillRect(x + 3, y + 3, 1, CELL - 6);
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

  // Body segment is a chunky dark square with a slightly brighter inset —
  // same bevel rhythm as the wall so they read as the same "device". The
  // head overlays the OddsRabbit karat (rabbit-face) sprite on top of that
  // body fill; if the sprite hasn't loaded yet, fall back to the original
  // single mint pixel so the head still reads as the head.
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

  // Carrot sprite. Three-leaf frond in dark green on top, tapered orange
  // body below. Pixel coordinates are hand-placed against a 20px cell —
  // shifting CELL would require redoing them by hand (no scaling math).
  Renderer.prototype._drawFood = function (food) {
    var ctx = this.ctx;
    var x = food.x * CELL;
    var y = food.y * CELL;

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
    ctx.fillStyle = COLOR_CARROT;
    ctx.fillRect(x + 8, y + 5, 4, 1);
    ctx.fillRect(x + 7, y + 6, 6, 2);
    ctx.fillRect(x + 8, y + 8, 4, 2);
    ctx.fillRect(x + 9, y + 10, 2, 2);
    ctx.fillRect(x + 10, y + 12, 1, 1);

    // Single-pixel highlight on the upper-left shoulder. At 1/144 of the
    // sprite it's barely visible, but it's enough to suggest a light source
    // and break the body's flat-fill silhouette.
    ctx.fillStyle = COLOR_CARROT_HI;
    ctx.fillRect(x + 8, y + 6, 1, 1);
  };

  window.SnakeRenderer = Renderer;
})();

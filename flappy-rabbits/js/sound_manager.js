// Procedural audio. No asset files: every sound here is a short synthesised
// envelope, which keeps the game a single HTTP request for its JS and avoids
// shipping (and licensing) audio for three blips.
//
// Same contract as match3's sound_manager — construct freely, but nothing is
// audible until resume() runs inside a real user gesture, because browsers
// start an AudioContext suspended. All play* methods are no-ops while muted or
// suspended, so callers never guard.

(function () {
  var Ctx = window.AudioContext || window.webkitAudioContext;

  function SoundManager() {
    this.ctx = null;
    this.muted = false;
    this._failed = !Ctx;
  }

  // Called from the first user gesture. Safe to call repeatedly.
  SoundManager.prototype.resume = function () {
    if (this._failed || this.muted) return;
    try {
      if (!this.ctx) this.ctx = new Ctx();
      if (this.ctx.state === "suspended") this.ctx.resume();
    } catch (_) {
      // A context that won't construct (autoplay policy, no output device)
      // permanently disables audio rather than throwing on every blip.
      this._failed = true;
    }
  };

  SoundManager.prototype.setMuted = function (muted) {
    this.muted = !!muted;
    if (this.muted && this.ctx && this.ctx.state === "running") {
      try { this.ctx.suspend(); } catch (_) {}
    } else if (!this.muted) {
      this.resume();
    }
  };

  SoundManager.prototype.isMuted = function () {
    return this.muted;
  };

  SoundManager.prototype._ready = function () {
    return !this._failed && !this.muted && this.ctx && this.ctx.state === "running";
  };

  // One oscillator through one gain envelope. `type` shapes the timbre,
  // `from`/`to` sweep the pitch, `dur` is the whole envelope in seconds.
  SoundManager.prototype._blip = function (opts) {
    if (!this._ready()) return;
    try {
      var ctx = this.ctx;
      var now = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();

      osc.type = opts.type || "square";
      osc.frequency.setValueAtTime(opts.from, now);
      if (opts.to && opts.to !== opts.from) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), now + opts.dur);
      }

      // A tiny attack rather than an instant one: a gain step from 0 to full
      // in a single sample is a click, and at this rate of firing the clicks
      // are what the ear notices rather than the notes.
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(opts.gain, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + opts.dur);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + opts.dur + 0.02);
    } catch (_) {}
  };

  // A short upward chirp. Quiet and brief: this fires several times a second
  // during a good run, and anything longer or louder becomes grating within
  // about twenty hops.
  SoundManager.prototype.playFlap = function () {
    this._blip({ type: "triangle", from: 380, to: 620, dur: 0.06, gain: 0.05 });
  };

  SoundManager.prototype.playScore = function () {
    this._blip({ type: "square", from: 660, to: 990, dur: 0.1, gain: 0.06 });
  };

  SoundManager.prototype.playHit = function () {
    this._blip({ type: "sawtooth", from: 260, to: 60, dur: 0.42, gain: 0.09 });
  };

  window.HopSoundManager = SoundManager;
})();

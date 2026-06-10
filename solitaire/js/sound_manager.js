// Procedural sound for Solitaire. Same synthesis engine as match3's
// sound_manager: no audio assets — every effect is synthesised live through
// the Web Audio API, so there's nothing to load, version with __BUILD_ID__,
// or 404 on a flaky CDN. One shared AudioContext, created lazily and resumed
// only on a user gesture (browsers keep audio suspended until the player
// interacts, so we can't open it at boot).
//
// Every public play* method is a no-op when muted, when the context failed
// to open, or when it isn't running yet — callers (application.js handlers)
// never have to guard. The mute flag lives here; persistence is the caller's
// job (application.js stores it via the OddsRabbit storage bridge).
//
// Voicing leans soft and woody to match the card-table theme: low sine
// "thocks" for card placement, brighter triangle blips for foundation
// progress, and filtered noise sweeps for the shuffle/recycle whoosh.

(function () {
  function SoundManager() {
    this._ctx = null;
    this._master = null;
    this._muted = false;
    this._failed = false; // set if AudioContext construction throws — stay silent
  }

  // Lazily build the context. Called on the first resume() (a user gesture)
  // and defensively before each sound. Returns the context or null.
  SoundManager.prototype._ensureCtx = function () {
    if (this._ctx || this._failed) return this._ctx;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) { this._failed = true; return null; }
    try {
      this._ctx = new Ctor();
      this._master = this._ctx.createGain();
      // Headroom: individual voices peak around 0.15–0.25, and the win
      // fanfare stacks a few at once, so hold the bus below unity.
      this._master.gain.value = 0.6;
      this._master.connect(this._ctx.destination);
    } catch (_) {
      this._failed = true;
      this._ctx = null;
    }
    return this._ctx;
  };

  // Unlock/resume audio. Must be invoked from within a user-gesture handler
  // (pointerdown/keydown) the first time, or the context stays "suspended"
  // and nothing plays. Safe to call repeatedly.
  SoundManager.prototype.resume = function () {
    var ctx = this._ensureCtx();
    if (!ctx) return;
    if (ctx.state === "suspended" && ctx.resume) {
      ctx.resume().catch(function () {});
    }
  };

  SoundManager.prototype.setMuted = function (muted) {
    this._muted = !!muted;
  };
  SoundManager.prototype.isMuted = function () {
    return this._muted;
  };
  SoundManager.prototype.toggleMute = function () {
    this._muted = !this._muted;
    return this._muted;
  };

  // True only when we can actually make noise right now. Gates every play*.
  SoundManager.prototype._live = function () {
    if (this._muted) return false;
    var ctx = this._ensureCtx();
    return !!ctx && ctx.state === "running";
  };

  // One decaying oscillator voice. opts: type, freq, freqEnd (glide target),
  // dur (seconds), peak (gain at attack), delay (start offset), detune.
  SoundManager.prototype._voice = function (opts) {
    var ctx = this._ctx;
    var t0 = ctx.currentTime + (opts.delay || 0);
    var dur = opts.dur || 0.15;
    var peak = opts.peak == null ? 0.25 : opts.peak;

    var osc = ctx.createOscillator();
    osc.type = opts.type || "sine";
    if (opts.detune) osc.detune.value = opts.detune;
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.freqEnd && opts.freqEnd !== opts.freq) {
      // Exponential glide (pitches can't pass through 0, so this is safe for
      // the strictly-positive frequencies we use) — reads as a slide/whoop.
      osc.frequency.exponentialRampToValueAtTime(opts.freqEnd, t0 + dur);
    }

    var gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.008); // ~8ms attack
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); // exp decay tail

    osc.connect(gain);
    gain.connect(this._master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  };

  // Filtered white-noise burst — the shuffle/recycle whoosh. The low-pass
  // cutoff glides down so it reads as a sweep rather than a flat hiss.
  SoundManager.prototype._noise = function (opts) {
    var ctx = this._ctx;
    var t0 = ctx.currentTime + (opts.delay || 0);
    var dur = opts.dur || 0.3;
    var frames = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    var src = ctx.createBufferSource();
    src.buffer = buf;

    var filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(opts.cutoffStart || 1800, t0);
    filter.frequency.exponentialRampToValueAtTime(opts.cutoffEnd || 400, t0 + dur);

    var gain = ctx.createGain();
    var peak = opts.peak == null ? 0.18 : opts.peak;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this._master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  };

  // --- Public effects -------------------------------------------------

  // Quick paper flick when a stock card flips onto the waste.
  SoundManager.prototype.draw = function () {
    if (!this._live()) return;
    this._voice({ type: "triangle", freq: 520, freqEnd: 640, dur: 0.05, peak: 0.12 });
  };

  // Soft wooden thock for a successful tableau move.
  SoundManager.prototype.place = function () {
    if (!this._live()) return;
    this._voice({ type: "sine", freq: 310, freqEnd: 240, dur: 0.09, peak: 0.2 });
  };

  // Brighter rising blip when a card banks onto a foundation — the
  // "progress" sound, distinct from the neutral tableau thock.
  SoundManager.prototype.foundation = function () {
    if (!this._live()) return;
    this._voice({ type: "sine", freq: 660, freqEnd: 880, dur: 0.11, peak: 0.18 });
    this._voice({ type: "triangle", freq: 1320, dur: 0.07, peak: 0.07, delay: 0.02 });
  };

  // One tick of the Finish cascade. Pitch walks up with the step index so
  // the rip to the win audibly climbs; quieter than a manual foundation
  // send since dozens fire in quick succession.
  SoundManager.prototype.cascade = function (step) {
    if (!this._live()) return;
    var s = Math.min(step || 0, 26);
    var freq = 660 * Math.pow(2, s / 26); // up one octave over the cascade
    this._voice({ type: "sine", freq: freq, freqEnd: freq * 1.2, dur: 0.06, peak: 0.1 });
  };

  // Low wooden thud when a drop is rejected.
  SoundManager.prototype.invalid = function () {
    if (!this._live()) return;
    this._voice({ type: "sine", freq: 200, freqEnd: 120, dur: 0.14, peak: 0.18 });
  };

  // Short descending blip on undo — the inverse of the foundation rise.
  SoundManager.prototype.undo = function () {
    if (!this._live()) return;
    this._voice({ type: "triangle", freq: 500, freqEnd: 360, dur: 0.08, peak: 0.13 });
  };

  // Descending filtered whoosh when the waste recycles back into the stock.
  SoundManager.prototype.recycle = function () {
    if (!this._live()) return;
    this._noise({ dur: 0.26, cutoffStart: 2000, cutoffEnd: 380, peak: 0.14 });
  };

  // Brighter, longer shuffle whoosh when a new board deals out.
  SoundManager.prototype.deal = function () {
    if (!this._live()) return;
    this._noise({ dur: 0.34, cutoffStart: 2600, cutoffEnd: 420, peak: 0.16 });
  };

  // Three-note rising fanfare on a win.
  SoundManager.prototype.win = function () {
    if (!this._live()) return;
    var notes = [523.25, 659.25, 783.99]; // C5 E5 G5
    for (var i = 0; i < notes.length; i++) {
      this._voice({ type: "triangle", freq: notes[i], dur: 0.22, peak: 0.22, delay: i * 0.09 });
    }
  };

  // Upbeat four-note arpeggio when the win is also a new personal best.
  SoundManager.prototype.newBest = function () {
    if (!this._live()) return;
    var notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    for (var i = 0; i < notes.length; i++) {
      this._voice({ type: "triangle", freq: notes[i], dur: 0.26, peak: 0.22, delay: i * 0.1 });
    }
  };

  window.SolitaireSoundManager = SoundManager;
})();

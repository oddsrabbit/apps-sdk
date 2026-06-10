// Procedural sound for Fruit Match. There are no audio assets — every effect
// is synthesised live through the Web Audio API, so there's nothing to load,
// version with __BUILD_ID__, or 404 on a flaky CDN. One shared AudioContext,
// created lazily and resumed only on a user gesture (browsers keep audio
// suspended until the player interacts, so we can't open it at boot).
//
// Every public play* method is a no-op when muted, when the context failed to
// open, or when it isn't running yet — callers (application.js listeners)
// never have to guard. The mute flag lives here; persistence is the caller's
// job (application.js stores it via the OddsRabbit storage bridge).
//
// Voicing is deliberately short and bright to sit on top of the existing
// haptics without muddying them: plucky sine/triangle blips with fast
// attack + exponential decay, a touch of detune on the bigger events, and a
// filtered noise burst for the shuffle whoosh.

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
      // Headroom: individual voices peak around 0.2–0.35, and a big clear can
      // stack a few at once, so hold the bus well below unity to avoid clipping.
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

  // Filtered white-noise burst — the shuffle whoosh. sweep glides the
  // low-pass cutoff so it reads as a sweep rather than a flat hiss.
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

  // Soft two-blip click when the player commits a swap.
  SoundManager.prototype.swap = function () {
    if (!this._live()) return;
    this._voice({ type: "triangle", freq: 520, dur: 0.06, peak: 0.16 });
    this._voice({ type: "triangle", freq: 700, dur: 0.07, peak: 0.14, delay: 0.045 });
  };

  // Low wooden thud when a swap forms no match and rewinds.
  SoundManager.prototype.invalidSwap = function () {
    if (!this._live()) return;
    this._voice({ type: "sine", freq: 200, freqEnd: 120, dur: 0.16, peak: 0.22 });
  };

  // Match pop. Pitch climbs with the longest cluster cleared and with the
  // cascade depth (combo), so a long chain audibly walks up the scale. A big
  // clear (5+, including a bomb sweep) layers a brighter overtone for "oomph".
  // maxLen: longest cluster this resolve step; combo: 1-based cascade depth.
  SoundManager.prototype.match = function (maxLen, combo) {
    if (!this._live()) return;
    var len = maxLen || 3;
    var depth = combo || 1;
    // Semitone steps: +1 per tile past 3, +2 per cascade past the first,
    // clamped so a deep cascade on a long run doesn't scream off the top.
    var steps = Math.min(20, (len - 3) + (depth - 1) * 2);
    var base = 440 * Math.pow(2, steps / 12);
    this._voice({ type: "sine", freq: base, freqEnd: base * 1.5, dur: 0.13, peak: 0.24 });
    if (len >= 5) {
      // Bright detuned octave on big clears / bomb sweeps.
      this._voice({ type: "triangle", freq: base * 2, dur: 0.18, peak: 0.16, detune: 6, delay: 0.01 });
    }
  };

  // Rising chime stacked on top of the match pop on each combo step.
  SoundManager.prototype.combo = function (mult) {
    if (!this._live()) return;
    var steps = Math.min(24, (mult - 1) * 3);
    var freq = 660 * Math.pow(2, steps / 12);
    this._voice({ type: "triangle", freq: freq, freqEnd: freq * 1.25, dur: 0.16, peak: 0.2 });
  };

  // Three-note rising fanfare on stage advancement.
  SoundManager.prototype.stage = function () {
    if (!this._live()) return;
    var notes = [523.25, 659.25, 783.99]; // C5 E5 G5
    for (var i = 0; i < notes.length; i++) {
      this._voice({ type: "triangle", freq: notes[i], dur: 0.22, peak: 0.22, delay: i * 0.09 });
    }
  };

  // Descending filtered whoosh when the board reshuffles out of a deadlock.
  SoundManager.prototype.shuffle = function () {
    if (!this._live()) return;
    this._noise({ dur: 0.34, cutoffStart: 2400, cutoffEnd: 350, peak: 0.16 });
  };

  // Falling two-tone "time's up" on game over.
  SoundManager.prototype.gameOver = function () {
    if (!this._live()) return;
    this._voice({ type: "sine", freq: 392, freqEnd: 196, dur: 0.5, peak: 0.24 });
    this._voice({ type: "triangle", freq: 261.63, freqEnd: 130.8, dur: 0.6, peak: 0.14, delay: 0.12 });
  };

  // Upbeat four-note arpeggio for a new personal best.
  SoundManager.prototype.newBest = function () {
    if (!this._live()) return;
    var notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    for (var i = 0; i < notes.length; i++) {
      this._voice({ type: "triangle", freq: notes[i], dur: 0.26, peak: 0.22, delay: i * 0.1 });
    }
  };

  window.Match3SoundManager = SoundManager;
})();

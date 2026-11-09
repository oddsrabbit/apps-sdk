/*!
 * oddsrabbit-adapter.js (v1)
 * https://www.oddsrabbit.com/developers/games/porting/
 *
 * One build of your game that runs on OddsRabbit and anywhere else. Load it
 * right after the SDK, in <head>:
 *
 *   <script src="https://apps.oddsrabbit.com/sdk-v1.js"></script>
 *   <script src="oddsrabbit-adapter.js"></script>
 *
 * On OddsRabbit it uses the SDK: synced saves, leaderboards, haptics and the
 * host's pause and resume. Anywhere else (your own site, another portal, a
 * file on disk) it saves to localStorage and the OddsRabbit-only calls do
 * nothing, so the game never waits for a host that isn't there.
 *
 * It installs window.ORGame. Promise-based engines call it directly. Engines
 * that can't hold a Promise (Unity, Godot, GameMaker, Defold) use the *ById
 * calls and read results as events, pushed with onEventJson() or pulled each
 * frame with poll().
 *
 * MIT licence. Copy it into your project and change SAVE_PREFIX.
 */
(function () {
  'use strict';

  // Loaded twice (a script tag plus an engine bundle)? Keep the first.
  if (window.ORGame) return;

  // localStorage namespace when the game isn't on OddsRabbit. Make it yours.
  var SAVE_PREFIX = 'my-game:';
  var MAX_QUEUED_EVENTS = 200;

  var OR = window.OddsRabbit;
  var params = new URLSearchParams(window.location.search);
  // The OddsRabbit host always frames the game and adds ?colorScheme= to its
  // URL, in the playground too. Without both, no host will ever answer.
  var hosted = !!OR && window.parent !== window && params.has('colorScheme');

  var listener = null;
  var queue = [];

  function noop() {}

  function emit(type, data) {
    var event = { type: type, data: data === undefined ? null : data };
    if (listener) {
      try {
        listener(event);
      } catch (err) {
        console.error('[ORGame] event handler threw', err);
      }
      return;
    }
    queue.push(event);
    if (queue.length > MAX_QUEUED_EVENTS) queue.shift();
  }

  function errorCode(err) {
    if (err && typeof err.code === 'string') return err.code;
    return String((err && err.message) || err || 'error');
  }

  function localGet(key) {
    try {
      return window.localStorage.getItem(SAVE_PREFIX + key);
    } catch (err) {
      return null; // storage blocked (private mode, sandboxed file)
    }
  }

  function localSet(key, value) {
    try {
      window.localStorage.setItem(SAVE_PREFIX + key, value);
    } catch (err) {
      // Full or blocked. Same as a refused write on OddsRabbit.
      return Promise.reject(err);
    }
    return Promise.resolve();
  }

  function localDelete(key) {
    try {
      window.localStorage.removeItem(SAVE_PREFIX + key);
    } catch (err) {
      // ignore
    }
    return Promise.resolve();
  }

  function systemScheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  var ORGame = {
    /** True when running inside OddsRabbit (web or app, or the playground). */
    hosted: hosted,
    /** { uuid, username } after whenReady(), or null for guests and off OddsRabbit. */
    user: null,
    /** 'light' or 'dark'. */
    colorScheme: params.get('colorScheme') === 'dark' ? 'dark' : hosted ? 'light' : systemScheme(),

    /** Resolves with { hosted, user, colorScheme }. Never hangs. */
    whenReady: function () {
      return ready;
    },

    /** Call once your first screen is drawn. Hides the host's loading skeleton. */
    shown: function () {
      if (hosted) OR.ready();
    },

    /** Whether this host supports an SDK verb, e.g. ORGame.can('scores.submit'). */
    can: function (verb) {
      return hosted && OR.capabilities.has(verb);
    },

    /** Resolves the saved string, or null. */
    load: function (key) {
      return ready.then(function () {
        return hosted ? OR.storage.get(key) : localGet(key);
      });
    },

    /** Saves a string (at most 16 KB a key on OddsRabbit). Rejects if refused. */
    save: function (key, value) {
      return ready.then(function () {
        return hosted ? OR.storage.set(key, String(value)) : localSet(key, String(value));
      });
    },

    remove: function (key) {
      return ready.then(function () {
        return hosted ? OR.storage.delete(key) : localDelete(key);
      });
    },

    /**
     * Records a whole-number score for a round. keepBest: true keeps a rising
     * best under a constant round key (an all-time board). Resolves true when
     * recorded, false for guests, off OddsRabbit, or a round already played.
     */
    submitScore: function (roundKey, score, keepBest) {
      return ready.then(function () {
        if (!hosted || !OR.user || !OR.capabilities.has('scores.submit')) return false;
        return OR.scores
          .submit({ roundKey: String(roundKey), score: Math.round(Number(score)), keepBest: !!keepBest })
          .then(
            function () {
              return true;
            },
            function (err) {
              if (errorCode(err) === 'scores/already-submitted') return false;
              throw err;
            }
          );
      });
    },

    /** 'light' | 'medium' | 'success' | 'error'. Buzzes in the app only. */
    haptic: function (type) {
      if (hosted) OR.actions.haptic(type || 'light').catch(noop);
    },

    /** System share sheet in the app, Web Share elsewhere when there is one. */
    share: function (title, text) {
      var payload = { title: title || undefined, text: text || undefined };
      if (hosted) return OR.actions.share(payload).catch(noop);
      if (navigator.share) return navigator.share(payload).catch(noop);
      return Promise.resolve();
    },

    /** Asks a guest to sign in, where the host supports it (web today). */
    requestSignIn: function (reason) {
      if (!ORGame.can('actions.requestSignIn')) return Promise.resolve();
      return OR.actions.requestSignIn(reason).catch(noop);
    },

    /**
     * Events: ready, pause, resume, terminating, loaded, saved, scored.
     * Events sent before a listener is set are delivered to it on arrival.
     */
    onEvent: function (fn) {
      listener = fn;
      var pending = queue;
      queue = [];
      pending.forEach(function (event) {
        emit(event.type, event.data);
      });
    },

    /** onEvent, with each event as a JSON string (Unity, Godot). */
    onEventJson: function (fn) {
      ORGame.onEvent(function (event) {
        fn(JSON.stringify(event));
      });
    },

    /** Returns queued events as a JSON array string (GameMaker, Defold). */
    poll: function () {
      var pending = queue;
      queue = [];
      return JSON.stringify(pending);
    },

    /** Emits 'loaded' { id, key, found, value } (value is '' when not found). */
    loadById: function (id, key) {
      ORGame.load(key).then(
        function (value) {
          emit('loaded', { id: id, key: key, found: value != null, value: value == null ? '' : value, error: '' });
        },
        function (err) {
          emit('loaded', { id: id, key: key, found: false, value: '', error: errorCode(err) });
        }
      );
    },

    /** Emits 'saved' { id, key, ok, error }. */
    saveById: function (id, key, value) {
      ORGame.save(key, value).then(
        function () {
          emit('saved', { id: id, key: key, ok: true, error: '' });
        },
        function (err) {
          emit('saved', { id: id, key: key, ok: false, error: errorCode(err) });
        }
      );
    },

    /** Emits 'scored' { id, ok, error }. ok is false when nothing was recorded. */
    submitScoreById: function (id, roundKey, score, keepBest) {
      ORGame.submitScore(roundKey, score, keepBest).then(
        function (ok) {
          emit('scored', { id: id, ok: ok, error: '' });
        },
        function (err) {
          emit('scored', { id: id, ok: false, error: errorCode(err) });
        }
      );
    },
  };

  var ready = (hosted ? OR.whenReady() : Promise.resolve()).then(function () {
    if (hosted) {
      ORGame.user = OR.user ? { uuid: OR.user.uuid, username: OR.user.username } : null;
      ORGame.colorScheme = OR.colorScheme === 'dark' ? 'dark' : 'light';
    }
    var info = { hosted: hosted, user: ORGame.user, colorScheme: ORGame.colorScheme };
    emit('ready', info);
    return info;
  });

  // Pause and resume: from the host on OddsRabbit (the app going to the
  // background, say), from tab visibility everywhere else.
  if (hosted) {
    ['pause', 'resume', 'terminating'].forEach(function (name) {
      OR.lifecycle.on(name, function () {
        emit(name);
      });
    });
  } else {
    document.addEventListener('visibilitychange', function () {
      emit(document.hidden ? 'pause' : 'resume');
    });
  }

  window.ORGame = ORGame;
})();

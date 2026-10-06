// Bridge bootstrap for Liquid. The fluid simulation self-initialises at
// script.js parse time, so this file's only jobs are: tell the host we're
// ready (so the loading skeleton hides) and wire lifecycle pause/resume into
// the simulation so the GPU stops chewing battery when backgrounded.

(function () {
  // script.js runs first and sets __liquidStarted only once the simulation is
  // up; a throw there (no WebGL, a shader that won't compile) would otherwise
  // leave a black canvas behind a host that's been told we're ready.
  if (!window.__liquidStarted) {
    showFatalError(window.__liquidError || "Couldn't start the simulation. Try reloading the page.");
  }

  // The GPU can drop the context (driver reset, memory pressure, a long
  // background on mobile). Rebuilding every program and framebuffer in place
  // isn't worth it: say so, and reload once the context is back.
  // preventDefault() on the loss is what lets the browser restore it.
  var canvas = document.querySelector("canvas");
  if (canvas) {
    canvas.addEventListener("webglcontextlost", function (e) {
      e.preventDefault();
      showFatalError("Graphics were interrupted. Reloading…");
    });
    canvas.addEventListener("webglcontextrestored", function () {
      location.reload();
    });
  }

  var OR = window.OddsRabbit;
  if (!OR) {
    console.error("Liquid: OddsRabbit bridge not available — game requires the SDK host.");
    showFatalError("This game needs to run inside the OddsRabbit app or website.");
    return;
  }

  function noop() {}

  // Surface fatal errors instead of leaving the user staring at a black canvas.
  // role="alert" auto-announces to assistive tech without making the rest of
  // the page a live region.
  function showFatalError(message) {
    if (document.querySelector(".bootstrap-error")) return;
    var banner = document.createElement("div");
    banner.className = "bootstrap-error";
    banner.setAttribute("role", "alert");
    banner.textContent = message;
    document.body.appendChild(banner);
  }

  function setPaused(paused) {
    var setter = window.__liquidSetPaused;
    if (typeof setter === "function") setter(paused);
  }

  OR.whenReady()
    .then(function () {
      // pause/resume: stop the GPU work when the user backgrounds the app or
      // switches tabs in the host, via the helper exposed in script.js. It
      // sets a flag separate from the user's own "paused" control, so resume
      // leaves a sim the user paused paused.
      try {
        OR.lifecycle.on("pause", function () { setPaused(true); });
        OR.lifecycle.on("resume", function () { setPaused(false); });
      } catch (_) {}

      try { OR.ready(); } catch (_) {}
    })
    .catch(function (err) {
      console.error("Liquid: bootstrap failed", err);
      showFatalError("Couldn't start the simulation. Try reloading the page.");
    });
})();

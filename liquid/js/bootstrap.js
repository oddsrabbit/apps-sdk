// Bridge bootstrap for Liquid. The fluid simulation self-initialises at
// script.js parse time, so this file's only jobs are: tell the host we're
// ready (so the loading skeleton hides) and wire lifecycle pause/resume into
// the simulation so the GPU stops chewing battery when backgrounded.

(function () {
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
      // switches tabs in the host. The fluid sim has a built-in PAUSED flag
      // we toggle via the helper exposed in script.js.
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

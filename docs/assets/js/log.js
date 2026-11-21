/*
 * log.js: a small levelled logger for the handbook's scripts.
 *
 * Levels, lowest to highest: debug < info < warn < error. Messages below the
 * active level are dropped. The default level is "warn" so readers' consoles
 * stay quiet; authors can raise verbosity without editing code:
 *
 *   page URL:      chapter.html?log=debug
 *   or console:    localStorage.setItem("hb.log", "debug")
 *
 * Usage:  var log = HB.log.scope("shell");  log.info("ready", details);
 */
(function () {
  "use strict";

  var HB = (window.HB = window.HB || {});
  var LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

  function readLevel() {
    var fromUrl = null;
    try {
      fromUrl = new URLSearchParams(window.location.search).get("log");
    } catch (err) {
      fromUrl = null;
    }
    if (fromUrl && LEVELS[fromUrl]) return fromUrl;
    try {
      var stored = window.localStorage.getItem("hb.log");
      if (stored && LEVELS[stored]) return stored;
    } catch (err) {
      /* Storage blocked: use the default. */
    }
    return "warn";
  }

  var active = readLevel();

  function emit(level, scope, args) {
    if (LEVELS[level] < LEVELS[active]) return;
    var method = level === "debug" ? "log" : level;
    var prefix = "[hb:" + scope + "]";
    // eslint-disable-next-line no-console
    console[method].apply(console, [prefix].concat(Array.prototype.slice.call(args)));
  }

  function scope(name) {
    return {
      debug: function () { emit("debug", name, arguments); },
      info: function () { emit("info", name, arguments); },
      warn: function () { emit("warn", name, arguments); },
      error: function () { emit("error", name, arguments); }
    };
  }

  HB.log = {
    scope: scope,
    level: function () { return active; },
    setLevel: function (level) {
      if (LEVELS[level]) active = level;
    }
  };
})();

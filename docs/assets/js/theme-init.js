/*
 * theme-init.js: applies the reader's saved theme before the first paint.
 *
 * Loaded synchronously in <head> so the page never flashes the wrong theme.
 * With no saved choice the page follows the OS (no data-theme attribute).
 * Storage can be unavailable (private windows, file:// in some browsers),
 * so every access is guarded and failure simply means "follow the OS".
 */
(function () {
  "use strict";
  try {
    var saved = window.localStorage.getItem("hb.theme");
    if (saved === "\"light\"" || saved === "\"dark\"") {
      document.documentElement.setAttribute("data-theme", JSON.parse(saved));
    }
  } catch (err) {
    /* Storage blocked: follow the OS theme. */
  }
})();

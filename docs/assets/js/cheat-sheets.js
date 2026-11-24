/*
 * cheat-sheets.js: print buttons for cheat-sheets.html.
 *
 * The page works without this script: the browser's own Print prints all
 * four sheets, one per page (site.css). The script only reveals the buttons,
 * which are hidden in the markup so a reader without JavaScript never sees
 * a control that does nothing.
 *
 * "Print this sheet" marks one sheet as the target and sets
 * body[data-print-one]; the print stylesheet then hides the other three.
 * The marks are cleared on "afterprint", and also straight after print()
 * returns, because some browsers fire afterprint before the dialog closes
 * and others not at all.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("cheat-sheets");
  var buttons = document.querySelectorAll("[data-print]");
  if (!buttons.length || typeof window.print !== "function") return;

  function clear() {
    delete document.body.dataset.printOne;
    document.querySelectorAll(".cs-sheet.is-print-target").forEach(function (el) {
      el.classList.remove("is-print-target");
    });
  }

  function printSheets(target) {
    clear();
    if (target !== "all") {
      var sheet = document.getElementById(target);
      if (!sheet) {
        log.warn("no sheet with id", target);
        return;
      }
      sheet.classList.add("is-print-target");
      document.body.dataset.printOne = target;
    }
    log.debug("print", target);
    window.print();
    // print() blocks until the dialog closes in most browsers.
    window.setTimeout(clear, 0);
  }

  window.addEventListener("afterprint", clear);
  buttons.forEach(function (btn) {
    btn.hidden = false;
    btn.addEventListener("click", function () {
      printSheets(btn.getAttribute("data-print"));
    });
  });
})();

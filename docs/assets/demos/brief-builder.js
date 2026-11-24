/*
 * brief-builder.js: chapter 12.2's interactive.
 *
 * The reader starts from a weak one-line brief ("Shadows are too slow. Make
 * them faster.") and switches on the seven elements of a strong brief:
 *
 *   engine        engine, exact version and render path
 *   platform      target platforms, frame rate and frame budget
 *   numbers       current measurements, where and with which tool
 *   symptom       what is wrong, where it appears, how to reproduce it
 *   constraints   what must not change, and the limits
 *   deliverables  what to hand back, in what order
 *   verification  acceptance criteria, how they are checked, evidence
 *
 * The brief text assembles as elements are switched on, a seven-segment
 * meter and a readout score it, and a list shows what the AI would still
 * have to guess. Three worked tasks (an optimisation, a bug and a new
 * feature, in three engines) share the same seven elements; their text
 * matches the worked briefs in the chapter. A copy button copies the
 * assembled brief.
 *
 * No timers run except the 1.8 s reset of the copy button's label after a
 * click, and nothing animates.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("brief-builder");
  var h = HB.html;
  var svgEl = HB.svg.el;

  /* ---------- Model: the seven elements and three worked tasks ---------- */

  var ELEMENTS = [
    { id: "engine", label: "Engine and version", guess: "which engine and version, so which settings and APIs exist" },
    { id: "platform", label: "Platform and target frame rate", guess: "which hardware, and how fast is fast enough" },
    { id: "numbers", label: "Current numbers", guess: "how far off it is, from what starting point, measured how" },
    { id: "symptom", label: "Symptom and where it appears", guess: "what exactly is wrong, where, and how to see it" },
    { id: "constraints", label: "Constraints", guess: "what it may change, and what must stay as it is" },
    { id: "deliverables", label: "Deliverables", guess: "what to hand back, and when to stop" },
    { id: "verification", label: "Verification", guess: "how anyone will know it worked" }
  ];

  /* Each task: the one-line ask, then one paragraph per element. The
     optimisation matches the chapter's lead figure and chapter 11.5's
     worked capture; the numbers are illustrative. */
  var TASKS = [
    {
      id: "optimise", label: "Optimisation",
      ask: "Shadows are too slow. Make them faster.",
      parts: {
        engine: "Context: Unreal Engine 5.8, deferred renderer, Lumen GI. The sun uses cascaded shadow maps with 4 cascades (Shadow Map Method: Shadow Maps, so virtual shadow maps are off).",
        platform: "Target: PS5 and Xbox Series S in the 60 fps performance mode, so a 16.7 ms frame budget. We are GPU-bound.",
        numbers: "Now: GPU time is 19.8 ms at camera bookmark 3 in MarketSquare on the PS5 devkit. Shadow depths take 4.6 ms against a 2.0 ms budget. Unreal Insights trace and our per-pass budget table attached.",
        symptom: "Where: cascades 2 and 3 cost 3.4 ms, and 1,280 of their 1,750 draws are grass clumps. Interiors are within budget. To see it: load MarketSquare, go to bookmark 3, wait 10 s for streaming, run stat gpu.",
        constraints: "Constraints: keep the look at cameras 1 to 5. Do not change the time of day, foliage density or cascade count. Series S must not get slower. No more than 16 MB of new memory.",
        deliverables: "Deliver: first the causes, ranked by cost, with evidence from the trace. Then the smallest change that fixes the biggest cause, as a patch with config diffs and what it trades away. Stop there for review.",
        verification: "Done when: Shadow depths is at or under 2.0 ms on PS5 at bookmark 3, measured the same way (median of 300 frames in Insights); Series S is no slower; before and after screenshots of cameras 1 to 5 go to the art lead for sign-off."
      }
    },
    {
      id: "bug", label: "Bug",
      ask: "The shadows flicker. Fix it.",
      parts: {
        engine: "Context: Unity 6.6 (6000.6), URP with the Forward+ rendering path. One directional light with 4 shadow cascades and a 60 m Max Distance.",
        platform: "Target: Windows PC (Direct3D 12) and Steam Deck, both at 60 fps. Seen on an RTX 3060 PC and on Steam Deck.",
        numbers: "Now: the frame is 14.2 ms on Steam Deck at 1280 × 800, so there is 2.5 ms of headroom. The main light's shadow pass takes 1.9 ms in a RenderDoc capture on the PC.",
        symptom: "Symptom: shadow edges on the courtyard floor shimmer and crawl while the camera pans slowly, and are still when it stops. It started after last week's shadow settings change. Steps: open Courtyard.unity, select the Medium quality level, play, go to camera bookmark Pan-02, pan right for 5 s. Happens 10 times out of 10 on both machines. Video attached.",
        constraints: "Constraints: keep 4 cascades and the 60 m shadow distance. Do not edit the High quality level's URP Asset. Add no more than 0.2 ms of GPU time on Steam Deck.",
        deliverables: "Deliver: the root cause, with evidence from a Frame Debugger or RenderDoc capture, then the fix, and an automated check that would catch it coming back if one is possible.",
        verification: "Done when: a 60 fps video of the pan at Pan-02 shows no crawling on both machines, the lighting artist signs off, and the shadow pass on Steam Deck changes by less than 0.2 ms."
      }
    },
    {
      id: "feature", label: "New feature",
      ask: "Add an ambient occlusion option to the settings menu.",
      parts: {
        engine: "Context: Godot 4.7 with the Forward+ rendering method. SSAO is set on the WorldEnvironment's Environment resource; the settings menu lives in ui/settings_menu.gd.",
        platform: "Target: Windows PC and Steam Deck at 60 fps, a 16.7 ms frame budget.",
        numbers: "Now: Steam Deck runs our heaviest scene at 14.5 ms with SSAO off. SSAO at the project's default quality costs 1.3 ms there in the Visual Profiler.",
        symptom: "What and where: a new option in the Graphics tab, between Shadows and Reflections, with Off, Low, Medium and High. Steam Deck defaults to Low, PC to High. It must apply at once, without a restart.",
        constraints: "Constraints: use the existing settings save file and menu style. No new autoloads. Low must cost no more than 0.6 ms on Steam Deck.",
        deliverables: "Deliver: the menu code, the mapping from each level to Environment and RenderingServer settings, the defaults per platform, and a table of each level's measured cost.",
        verification: "Done when: each level visibly changes the image at cameras 1 to 3 (screenshots attached), Low costs at most 0.6 ms and High at most 1.5 ms on Steam Deck in the Visual Profiler, and the choice survives a restart."
      }
    }
  ];

  function taskById(id) {
    for (var i = 0; i < TASKS.length; i++) if (TASKS[i].id === id) return TASKS[i];
    return TASKS[0];
  }

  /* Assembles the brief text: the ask, then each switched-on element in the
     template's order, one paragraph each. Exposed for tests. */
  function compose(taskId, on) {
    var task = taskById(taskId);
    var paras = [task.ask];
    ELEMENTS.forEach(function (el) {
      if (on[el.id]) paras.push(task.parts[el.id]);
    });
    return paras.join("\n\n");
  }

  /* Score: elements present, guesses left, and a one-word verdict. */
  function score(on) {
    var n = ELEMENTS.filter(function (el) { return on[el.id]; }).length;
    var verdict = n <= 2 ? "Weak" : n <= 5 ? "Workable" : "Strong";
    return { count: n, left: ELEMENTS.length - n, verdict: verdict, checkable: Boolean(on.verification) };
  }

  HB.briefBuilder = { elements: ELEMENTS, tasks: TASKS, compose: compose, score: score };

  /* ---------- Clipboard ---------- */

  function copyText(text, body, done) {
    function fallback() {
      // Older app views refuse the async clipboard: select the text instead.
      var range = document.createRange();
      range.selectNodeContents(body);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
      done(ok ? "Copied" : "Selected, press Ctrl+C");
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done("Copied"); }, fallback);
    } else {
      fallback();
    }
  }

  /* ---------- Demo ---------- */

  function init(root) {
    var state = { task: "optimise", on: {} };
    ELEMENTS.forEach(function (el) { state.on[el.id] = false; });

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Brief builder" }),
      h("span", { class: "demo-hint", text: "Start from the one-line brief, then add the elements of a strong one and watch the guesses disappear. Switch tasks to see the same template applied to a bug and a new feature. Copy the result when you are done." })
    ]));

    /* Controls: task, the seven elements, and two shortcuts. */
    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Task", TASKS.map(function (t) { return { value: t.id, label: t.label }; }), state.task, function (v) {
      state.task = v;
      render();
    }));
    var allBtn = h("button", { class: "btn", type: "button", text: "Add all" });
    var clearBtn = h("button", { class: "btn", type: "button", text: "Back to one line" });
    controls.appendChild(h("div", { class: "control" }, [h("span", { class: "label", text: "Shortcuts" }), h("div", { style: "display:flex;gap:.5rem;flex-wrap:wrap" }, [allBtn, clearBtn])]));
    root.appendChild(controls);

    var boxes = {};
    var checks = h("div", { class: "checks" });
    ELEMENTS.forEach(function (el, i) {
      var box = h("input", { type: "checkbox", id: "bb2-" + el.id });
      box.addEventListener("change", function () {
        state.on[el.id] = box.checked;
        render();
      });
      boxes[el.id] = box;
      checks.appendChild(h("label", { for: "bb2-" + el.id }, [box, (i + 1) + ". " + el.label]));
    });
    root.appendChild(h("div", { class: "control" }, [h("span", { class: "label", text: "Add to the brief" }), checks]));

    function setAll(value) {
      ELEMENTS.forEach(function (el) {
        state.on[el.id] = value;
        boxes[el.id].checked = value;
      });
      render();
    }
    allBtn.addEventListener("click", function () { setAll(true); });
    clearBtn.addEventListener("click", function () { setAll(false); });

    /* Panels: score and guesses on the left, the brief on the right. */
    var panels = h("div", { class: "demo-panels is-split" });
    var left = h("div", { class: "demo-panel" });
    var meter = svgEl("svg", { class: "dg", viewBox: "0 0 280 56", role: "img", "aria-label": "Brief score" });
    var verdictEl = h("p", { class: "label" });
    var guessTitle = h("p", { class: "demo-hint" });
    var guessList = h("ul", { class: "demo-hint", style: "margin:0;padding-left:0;list-style:none" });
    left.append(meter, verdictEl, guessTitle, guessList);

    var right = h("div", { class: "demo-panel" });
    var body = h("pre", { class: "prompt-body", "aria-live": "polite" });
    var copyBtn = h("button", { class: "btn copy-btn", type: "button", text: "Copy brief" });
    var prompt = h("div", { class: "prompt" }, [
      h("div", { class: "prompt-head" }, [h("span", { class: "label", text: "Your brief" }), h("span", { class: "use-when", text: "assembled from the elements switched on" }), copyBtn]),
      body
    ]);
    right.appendChild(prompt);
    panels.append(left, right);
    root.appendChild(panels);

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    copyBtn.addEventListener("click", function () {
      copyText(compose(state.task, state.on), body, function (label) {
        copyBtn.textContent = label;
        setTimeout(function () { copyBtn.textContent = "Copy brief"; }, 1800);
      });
    });

    /* ---------- Drawing ---------- */

    function drawMeter(s) {
      HB.svg.clear(meter);
      var w = 36;
      var gap = 4;
      ELEMENTS.forEach(function (el, i) {
        var x = i * (w + gap);
        var on = state.on[el.id];
        svgEl("rect", { x: x, y: 8, width: w, height: 22, rx: 4, class: on ? "f-acc s-acc" : "f-surface s-strong" }, meter);
        svgEl("text", { x: x + w / 2, y: 23.5, class: "t-small t-strong mid" + (on ? " t-on-acc" : " t-muted"), text: String(i + 1) }, meter);
      });
      svgEl("text", { x: 0, y: 50, class: "t-small t-muted", text: s.count + " of " + ELEMENTS.length + " elements in the brief" }, meter);
      meter.setAttribute("aria-label", "Brief score: " + s.count + " of " + ELEMENTS.length + " elements, " + s.verdict.toLowerCase() + ".");
    }

    function drawGuesses(s) {
      verdictEl.textContent = s.verdict + " brief";
      guessList.replaceChildren();
      if (!s.left) {
        guessTitle.textContent = "Nothing important is left to guess. The AI can start, and you can check what comes back.";
        return;
      }
      guessTitle.textContent = "The AI still has to guess:";
      ELEMENTS.forEach(function (el, i) {
        if (!state.on[el.id]) guessList.appendChild(h("li", { text: (i + 1) + ". " + el.guess }));
      });
    }

    function drawReadout(s) {
      function cell(label, value) {
        return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
      }
      var text = compose(state.task, state.on);
      var words = text.split(/\s+/).filter(Boolean).length;
      readout.replaceChildren(
        cell("Elements", s.count + " of " + ELEMENTS.length),
        cell("Left to guess", String(s.left)),
        cell("Can the result be checked?", s.checkable ? "Yes" : "No"),
        cell("Length", words + " words")
      );
    }

    function render() {
      var s = score(state.on);
      body.textContent = compose(state.task, state.on);
      drawMeter(s);
      drawGuesses(s);
      drawReadout(s);
      log.debug("render", state.task, s.count);
    }

    render();
  }

  HB.demos.register("brief-builder", init);
})();

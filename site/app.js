/* Terminal reveal: plays the log through once on load.
   The markup is complete without JS — the staging class is only added
   here, so a failed script or a reduced-motion preference just shows
   the finished transcript. */
(function () {
  var body = document.getElementById("term-body");
  if (!body) return;

  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return;

  var lines = Array.prototype.slice.call(body.querySelectorAll(".ln"));
  if (!lines.length) return;

  body.classList.add("is-staged");

  var i = 0;
  function step() {
    if (i >= lines.length) return;
    var line = lines[i++];
    line.classList.add("is-in");
    // A pause before each shell prompt makes it read as two commands,
    // not one undifferentiated dump.
    var next = line.querySelector(".p") ? 380 : 95;
    window.setTimeout(step, next);
  }

  window.setTimeout(step, 260);
})();

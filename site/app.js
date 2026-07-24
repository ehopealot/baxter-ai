/* Conversation reveal: plays the exchange through once on load.
   The markup is complete without JS. The staging class is only added
   here, so a failed script or a reduced-motion preference just shows
   the finished conversation. */
(function () {
  var log = document.getElementById("chat-log");
  if (!log) return;

  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return;

  var msgs = Array.prototype.slice.call(log.querySelectorAll(".msg"));
  if (!msgs.length) return;

  log.classList.add("is-staged");

  var i = 0;
  function step() {
    if (i >= msgs.length) return;
    var msg = msgs[i++];
    msg.classList.add("is-in");
    // Longer beat before Baxter answers than before a human's short reply:
    // an instant response reads as canned rather than considered.
    var next = msg.classList.contains("is-bax") ? 900 : 650;
    window.setTimeout(step, next);
  }

  window.setTimeout(step, 300);
})();

/* Marks the nav link for whichever section you're currently reading. Nothing
   here is load-bearing: with JS off the nav is still five working anchors,
   just without the highlight. */
(function () {
  var links = Array.prototype.slice.call(
    document.querySelectorAll(".topnav a[href^='#']")
  );
  if (!links.length || !window.IntersectionObserver) return;

  var byId = {};
  var sections = [];
  links.forEach(function (link) {
    var section = document.getElementById(link.hash.slice(1));
    if (!section) return;
    byId[section.id] = link;
    sections.push(section);
  });
  if (!sections.length) return;

  var visible = {};

  function paint() {
    // Topmost visible section wins, so scrolling past a short section doesn't
    // leave two links lit or flicker between them.
    var current = null;
    sections.forEach(function (section) {
      if (visible[section.id] && !current) current = section;
    });
    links.forEach(function (link) {
      if (current && byId[current.id] === link) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
  }

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        visible[entry.target.id] = entry.isIntersecting;
      });
      paint();
    },
    // Discount the sticky topbar at the top, and require a section to reach
    // the upper half of the viewport before it counts as the one you're on.
    { rootMargin: "-15% 0px -55% 0px" }
  );

  sections.forEach(function (section) {
    observer.observe(section);
  });
})();

/* Copy buttons on the code blocks. Injected rather than authored into the
   markup, so a browser without the clipboard API gets no button instead of a
   dead one. */
(function () {
  if (!navigator.clipboard || !navigator.clipboard.writeText) return;

  var blocks = Array.prototype.slice.call(document.querySelectorAll("pre"));
  if (!blocks.length) return;

  // One shared live region: the button's own label change isn't announced
  // reliably across screen readers, and one region beats seven.
  var live = document.createElement("div");
  live.className = "sr-only";
  live.setAttribute("role", "status");
  document.body.appendChild(live);

  var shortcut = /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘C" : "Ctrl+C";

  blocks.forEach(function (pre) {
    var wrap = document.createElement("div");
    wrap.className = "snip";
    pre.parentNode.insertBefore(wrap, pre);

    // Above the block, not floating over it: several of these commands are
    // wider than their container and scroll, so an overlaid button would sit
    // on top of the code it's offering to copy.
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy";
    btn.textContent = "Copy";
    wrap.appendChild(btn);
    wrap.appendChild(pre);

    var revert;
    function say(label, announce) {
      btn.textContent = label;
      if (announce) {
        live.textContent = "";
        live.textContent = announce;
      }
      window.clearTimeout(revert);
      revert = window.setTimeout(function () {
        btn.textContent = "Copy";
      }, 2000);
    }

    btn.addEventListener("click", function () {
      navigator.clipboard.writeText(pre.innerText.replace(/\s+$/, "")).then(
        function () {
          say("Copied", "Copied to clipboard");
        },
        function () {
          // Select the block so the keyboard shortcut still gets them there.
          var range = document.createRange();
          range.selectNodeContents(pre);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          say(shortcut, "Copying was blocked. The text is selected, so press " + shortcut + ".");
        }
      );
    });
  });
})();

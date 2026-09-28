/* ============================================================
   Cinematic motion
   ------------------------------------------------------------
   - Work cards rise, scale up and un-crop as they scroll in (scrubbed)
   - Screenshots inside cards drift at their own depth (parallax)
   - Hero is still; its shapes and title only shift with the cursor (desktop)
   - Headings and supporting cards fade up from a soft blur, once

   Content is never hidden unless this script is running, and
   nothing moves for visitors who ask for reduced motion.
   ============================================================ */
(function () {
  "use strict";
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var root = document.documentElement;
  var started = false;
  var ticking = false;
  var shapeSpeeds = [0.18, 0.32, 0.12, 0.42, 0.26];

  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };

  /* ---- one-time reveals ---- */
  var io = "IntersectionObserver" in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      io.unobserve(e.target);
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }) : null;

  function markReveals() {
    var groups = [
      document.querySelectorAll("main h2"),
      document.querySelectorAll(".case > h3"),
      document.querySelectorAll("[data-bcard]"),
      document.querySelectorAll('#about [style*="minmax(220px"] > div'),
      document.querySelectorAll("#contact > div > div")
    ];
    groups.forEach(function (list) {
      Array.prototype.forEach.call(list, function (el, i) {
        if (el.classList.contains("mo-rise")) return;
        el.classList.add("mo-rise");
        el.style.setProperty("--mo-delay", (Math.min(i, 5) * 90) + "ms");
        if (io) io.observe(el); else el.classList.add("in");
      });
    });
  }

  /* ---- scrubbed motion ---- */
  function update() {
    ticking = false;
    var vh = window.innerHeight || 800;
    var y = window.scrollY || (document.scrollingElement && document.scrollingElement.scrollTop) || 0;

    /* cards: 0 when the card top reaches the bottom of the screen, 1 by the time it is a quarter of the way up */
    var cards = document.querySelectorAll(".case .tone");
    for (var i = 0; i < cards.length; i++) {
      var r = cards[i].getBoundingClientRect();
      var p = clamp((vh - r.top) / (vh * 0.75), 0, 1);
      p = 1 - Math.pow(1 - p, 3); // ease-out so cards settle softly
      cards[i].style.setProperty("--p", p.toFixed(4));

      var img = cards[i].querySelector(".tone-shot img");
      if (img) {
        /* -1 .. 1 as the card travels through the screen; the image is scaled 1.08,
           so it has ~4% spare height per side and must not drift further than that */
        var center = clamp((r.top + r.height / 2 - vh / 2) / vh, -1, 1);
        var room = img.offsetHeight * 0.035;
        img.style.setProperty("--iy", (center * -room).toFixed(1));
      }
    }

    /* the hero has no scroll motion; it only reacts to the cursor (see below) */
  }

  /* ---- case study windows: tour through the 5 screens ----
     desktop: while the card is hovered or focused; touch: while the card is on screen */
  var STEP_MS = 1800;
  function bindTours() {
    var fine = window.matchMedia && window.matchMedia("(pointer: fine)").matches;
    Array.prototype.forEach.call(document.querySelectorAll(".case"), function (card) {
      var strip = card.querySelector(".tone-strip");
      if (!strip || card.__tour) return;
      card.__tour = true;
      var n = strip.children.length, dots = card.querySelectorAll(".tone-steps i");
      var idx = 0, timer = 0, lead = 0, steps = 0;
      /* touch screens play it by themselves, so keep that run under 5s (WCAG 2.2.2) and then rest */
      var stepMs = fine ? STEP_MS : 1300, maxSteps = fine ? Infinity : 3;
      function go(k) {
        idx = k;
        strip.style.transform = "translateY(" + (-100 * k) + "%)";
        for (var d = 0; d < dots.length; d++) dots[d].classList.toggle("on", d === k);
      }
      function loadShots() {
        if (card.__shots) return;
        card.__shots = true;
        Array.prototype.forEach.call(strip.querySelectorAll("img[data-src]"), function (im) {
          if (!im.getAttribute("src")) im.src = im.getAttribute("data-src");
        });
      }
      if ("IntersectionObserver" in window) {
        var near = new IntersectionObserver(function (entries) {
          if (entries[0].isIntersecting) { loadShots(); near.disconnect(); }
        }, { rootMargin: "400px 0px" });
        near.observe(card);
      } else loadShots();
      function play() {
        loadShots();
        if (timer || lead) return;
        lead = setTimeout(function () {             // short pause so a passing cursor doesn't trigger it
          lead = 0;
          go((idx + 1) % n);
          steps = 1;
          timer = setInterval(function () {
            go((idx + 1) % n);
            if (++steps >= maxSteps) { clearInterval(timer); timer = -1; }   // -1: done until the card leaves
          }, stepMs);
        }, 700);             // also lets the window finish straightening before the first screen change
      }
      function stop() {
        clearTimeout(lead); lead = 0;
        clearInterval(timer); timer = 0;
        go(0);
      }
      if (fine) {
        card.addEventListener("mouseenter", play);
        card.addEventListener("mouseleave", stop);
        card.addEventListener("focusin", play);
        card.addEventListener("focusout", function (e) { if (!card.contains(e.relatedTarget)) stop(); });
      } else if ("IntersectionObserver" in window) {
        new IntersectionObserver(function (entries) {
          entries.forEach(function (e) { card.classList.toggle("is-live", e.isIntersecting); if (e.isIntersecting) play(); else stop(); });
        }, { threshold: 0.6 }).observe(card);
      }
    });
  }

  /* ---- pointer depth on the hero (desktop, fine pointer only) ---- */
  var mx = 0, my = 0, tx = 0, ty = 0, pRaf = 0;
  function depthLoop() {
    mx += (tx - mx) * 0.08;
    my += (ty - my) * 0.08;
    var shapes = document.querySelectorAll(".hero-shapes .eshape");
    for (var s = 0; s < shapes.length; s++) {
      var d = shapeSpeeds[s % shapeSpeeds.length] * 70;          // nearer shapes move more
      shapes[s].style.setProperty("--mx", (mx * -d).toFixed(1));
      shapes[s].style.setProperty("--my", (my * -d * 0.6).toFixed(1));
    }
    var title = document.querySelector(".hero-section h1");
    if (title) {
      title.style.setProperty("--tx", (mx * 6).toFixed(2));
      title.style.setProperty("--ty", (my * 4).toFixed(2));
    }
    if (Math.abs(tx - mx) > 0.001 || Math.abs(ty - my) > 0.001) pRaf = requestAnimationFrame(depthLoop);
    else pRaf = 0;
  }
  function bindPointer() {
    if (!window.matchMedia || !window.matchMedia("(pointer: fine)").matches) return;
    var hero = document.querySelector(".hero-section");
    if (!hero || hero.__moDepth) return;
    hero.__moDepth = true;
    hero.addEventListener("mousemove", function (e) {
      var r = hero.getBoundingClientRect();
      tx = clamp((e.clientX - r.left) / r.width * 2 - 1, -1, 1);
      ty = clamp((e.clientY - r.top) / r.height * 2 - 1, -1, 1);
      if (!pRaf) pRaf = requestAnimationFrame(depthLoop);
    });
    hero.addEventListener("mouseleave", function () {
      tx = 0; ty = 0;
      if (!pRaf) pRaf = requestAnimationFrame(depthLoop);
    });
  }

  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }

  /* safety net: anything already on screen is never left hidden */
  function revealVisible() {
    var vh = window.innerHeight || 800;
    Array.prototype.forEach.call(document.querySelectorAll(".mo-rise:not(.in)"), function (el) {
      if (el.getBoundingClientRect().top < vh) el.classList.add("in");
    });
  }

  function start() {
    /* the raw template lives inside <x-dc> until the runtime renders the real page */
    var first = document.querySelector(".case");
    if (!first || first.closest("x-dc")) return;
    /* hero pointer depth (title/shapes following the cursor) is off: the hero only glows under the cursor */
    if (started) { markReveals(); bindTours(); update(); return; }
    started = true;
    bindTours();
    setTimeout(revealVisible, 2500);
    root.classList.add("mo-ready");
    markReveals();
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("resize", onScroll, { passive: true });
  }

  /* the page is rendered by a runtime after load, so wait for the work section to exist */
  function boot() {
    start();
    var mo = new MutationObserver(function () { start(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(function () { mo.disconnect(); }, 15000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

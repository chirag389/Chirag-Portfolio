/* ============================================================
   Portfolio analytics
   ------------------------------------------------------------
   GA4     -> visitors, sources, countries, events   (LIVE)
   Clarity -> heatmaps, session recordings           (add ID below)

   Only the two lines under CONFIG ever need editing.
   ============================================================ */

/* ---------------- CONFIG ---------------- */
var GA_ID      = "G-8LDJC6KZ0D";        // already set
var CLARITY_ID = "PASTE_YOUR_ID_HERE";  // clarity.microsoft.com -> Settings -> Overview
/* ---------------------------------------- */

(function () {
  var hasGA = GA_ID && GA_ID.indexOf("G-") === 0;
  var hasClarity = CLARITY_ID && CLARITY_ID !== "PASTE_YOUR_ID_HERE";

  /* ---- 1. Google Analytics 4 ---- */
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { dataLayer.push(arguments); };

  if (hasGA) {
    var g = document.createElement("script");
    g.async = true;
    g.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
    document.head.appendChild(g);
    gtag("js", new Date());

    // GitHub Pages serves the home page at both "/" and "/index.html",
    // which GA4 would otherwise count as two different pages.
    // Report both as "/" so the numbers stay in one row.
    gtag("config", GA_ID, {
      page_location: location.href.replace(/index\.html(?=$|[?#])/, "")
    });
  }

  /* ---- 2. Microsoft Clarity ---- */
  if (hasClarity) {
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, "clarity", "script", CLARITY_ID);
  } else {
    console.warn("[analytics] Clarity ID not set — heatmaps and recordings are off.");
  }

  /* ---- 3. Send one event to both tools ---- */
  function track(name, params) {
    params = params || {};
    if (hasGA) {
      params.transport_type = "beacon";   // survives the page unload
      gtag("event", name, params);
    }
    if (window.clarity) clarity("event", name.slice(0, 50));
  }

  /* ---- 4. Visit source from ?r= in the URL ----
     Send yoursite.com/?r=zomato to a company and you can isolate
     that company's visit in both dashboards afterwards.          */
  var ref = null;
  try {
    ref = new URLSearchParams(window.location.search).get("r");
    if (ref) {
      ref = ref.toLowerCase().slice(0, 40);
      if (window.clarity) clarity("set", "source", ref);
      if (hasGA) gtag("set", "user_properties", { visit_source: ref });
      track("visit_tagged", { source: ref });
    }
  } catch (e) {}

  var page = (location.pathname.split("/").pop() || "index").replace(".html", "") || "index";
  if (window.clarity) clarity("set", "page", page);

  /* ---- 5. Delegated click tracking ----
     Listens on the document, so it survives your redesigns —
     no data-track attributes to re-add in the markup.            */
  document.addEventListener("click", function (e) {
    // cards are <article onClick=...>, not <a> — so match those too
    var el = e.target.closest("a, button, [role='button'], [data-track], [onclick], article");
    if (!el) return;

    var label = el.getAttribute("data-track");
    if (!label) {
      var href = el.getAttribute("href") || "";

      // clicked a card/wrapper: borrow the link sitting inside it
      if (!href && el.querySelector) {
        var inner = el.querySelector("a[href]");
        if (inner) href = inner.getAttribute("href") || "";
      }

      // icon-only buttons have no text — fall back to aria-label / title
      var text = (el.innerText || el.textContent || "").trim()
                 || el.getAttribute("aria-label")
                 || el.getAttribute("title")
                 || "";
      text = text.trim().slice(0, 40);

      if (/\.pdf/i.test(href)) {
        label = "resume_open";
      } else if (/^https?:/i.test(href)) {
        var host = "";
        try { host = new URL(href, location.href).hostname.replace(/^www\./, ""); } catch (x) {}
        label = host ? "outbound_" + host.split(".")[0] : "";
      } else if (/\.html/i.test(href)) {
        label = "open_" + href.replace(/.*\//, "").replace(".html", "");
      } else if (/^#/.test(href)) {
        label = "nav_" + href.slice(1);
      } else {
        var slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        label = slug ? "click_" + slug : "";   // no name -> send nothing
      }
    }

    label = (label || "").trim();
    if (!label || /_$/.test(label)) return;   // drop empty / trailing-underscore junk

    track(label.slice(0, 40), { page: page, link_text: (el.innerText || "").trim().slice(0, 60) });
  }, true);

  /* ---- 6. Scroll depth ----
     Shows whether recruiters reach your outcomes section
     or bail right after the hero.                                */
  var fired = {};
  window.addEventListener("scroll", function () {
    var h = document.documentElement;
    var pct = (h.scrollTop + window.innerHeight) / h.scrollHeight * 100;
    [25, 50, 75, 100].forEach(function (mark) {
      if (pct >= mark && !fired[mark]) {
        fired[mark] = true;
        track("scroll_" + mark, { page: page });
      }
    });
  }, { passive: true });

  /* ---- 7. Browser Back fix (bfcache) ----
     Clicking a case study leaves the home page frozen with its
     loading overlay switched on. Chrome's Back button restores that
     frozen copy, overlay and all, so it hangs forever. On a restored
     page, reload once so the state starts clean. Assets come from
     cache, so it's fast.                                            */
  window.addEventListener("pageshow", function (e) {
    if (!e.persisted) return;

    // the frozen overlay still says "Quick Chat / Opening case study".
    // relabel it to Home so the moment before the reload reads right.
    try {
      var spans = document.querySelectorAll("span");
      for (var i = 0; i < spans.length; i++) {
        if ((spans[i].textContent || "").trim() === "Opening case study") {
          spans[i].textContent = "Going back";
          var lbl = spans[i].previousElementSibling;
          if (lbl) lbl.textContent = "Home";
          break;
        }
      }
    } catch (err) {}

    window.location.reload();
  });

  /* ---- 7. Time on page (GA4 alone is unreliable on exits) ---- */
  [15, 30, 60, 120].forEach(function (sec) {
    setTimeout(function () { track("time_" + sec + "s", { page: page }); }, sec * 1000);
  });
})();

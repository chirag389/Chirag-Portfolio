/* ============================================================
   Hero field — the hero seen as a floor of hexagon prisms (WebGL2)
   ------------------------------------------------------------
   How it works
   - The hero copy (badge, title, text, buttons) is painted into an
     offscreen 2D canvas from the live DOM layout, together with the
     hero background and the dot band. That canvas is the "page".
   - A fragment shader looks at the page through a slightly tilted
     perspective camera. The page is cut into large pointy-top hexagon
     prisms; each pixel's ray walks the hex columns until it hits a
     tile top or a tile wall. Tile tops show the page, walls are dark.
   - The cursor feeds a soft "presence" field (a coarse grid on the
     CPU): every frame the pointer adds a wide gaussian splat and the
     field fades a little. Per tile:
        strong presence  -> the tile is flat, seamless and unlit,
                            so the page reads cleanly around the cursor
        weak presence    -> the tile rises (a ring around the cursor),
                            its walls show and the copy breaks along
                            the tile edges
        none             -> the tile rests: a fine bevel on its edges
                            and soft lighting with an iridescent sheen
   - When the cursor leaves, the field fades, the ring sweeps back
     over the tiles and everything settles.
   - The real DOM copy stays in place (invisible) for screen readers,
     selection and keyboard focus; pointer clicks and hovers are mapped
     through the camera back onto the page.
   Touch screens: the real copy stays on top; an unseen "cursor" drifts
   around the hero's edges so the tiles move by themselves, and a finger
   takes over while it touches the hero (resumes 2.5 s after lifting).
   It runs at ~30 fps and only while the hero is on screen.
   Fallbacks: no WebGL2 -> the DOM hero is shown as is. Reduced motion
   -> one still frame of the tiles behind the real copy.
   ============================================================ */
(function () {
  "use strict";

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var fine = window.matchMedia && window.matchMedia("(pointer: fine)").matches;
  var live = fine;   // a mouse-driven field is user-initiated, so it stays on with reduced motion (only the self-moving touch drift is off)
  var touchMode = !fine && !reduce;   // phones/tablets: ambient drift + finger
  var PAINT_COPY = false;     // false: text + CTAs stay as the real, still DOM copy; only the background tiles lift
  var textOn = false;         // the copy is painted into the tiles only once the web fonts have arrived

  /* look — sizes are CSS px */
  var CELL = 189;             // hexagon width, flat side to flat side
  var TILT = 12;              // camera tilt in degrees (top of the hero is further away)
  var DIST = 1.17;            // camera distance as a multiple of the hero height (lower = stronger perspective)
  var LIFT = 0.24;            // how high the ring of tiles rises, in cells
  var BEVEL = 1.5;            // bevel width on resting tile edges
  var SHINE = 0.25;           // specular strength
  var IRID = 0.85;            // iridescent tint of the highlights
  /* feel */
  var RADIUS = 920;           // size of the cursor's presence
  var FADE = 0.912;           // presence kept per frame (60 fps); lower = shorter trail
  var FEED = 10;              // presence added per second under the cursor
  var FIELD_W = 96;           // presence grid width (height follows the hero's aspect)
  var T_RADIUS = 560;         // touch: smaller presence so the ring reads on a narrow hero
  var T_LAP = 16;             // touch: seconds for the unseen cursor to go once around the edges
  var T_FRAME = 30;           // touch: ms between frames (~30 fps, easier on the battery)

  var hero, copy, canvas, gl, prog, U = {}, texPage, texFlow, paint, pctx;
  var w = 0, h = 0, scale = 1, gw = FIELD_W, gh = 32, field = null;
  var clear = [0, 0, 1e-3, 1e-3], cam = null, bg = [0, 0, 0], tintRgb = [1, 1, 1], links = [], hoverIdx = -1;
  var pointerOn = false, px = 0, py = 0, raf = 0, lastT = 0, activeUntil = 0;
  var heroSeen = true, fingerUntil = 0, lastDraw = 0;

  /* ---------------------------------------------------------------- shader */
  var VS = "#version 300 es\nlayout(location=0) in vec2 aPos; out vec2 vUv;\n" +
    "void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }";

  var FS = [
    "#version 300 es",
    "precision highp float;",
    "in vec2 vUv; out vec4 outColor;",
    "uniform sampler2D uPage, uFlow;",
    "uniform vec2 uRes, uPage2;          // canvas px, page size in cells",
    "uniform vec3 uEye;                  // camera position (cells; z up)",
    "uniform vec3 uFwd, uUp;",
    "uniform float uFocal, uLift, uBev, uShine, uIrid, uLight;",
    "uniform vec3 uBg, uSeam, uTint;",
    "uniform vec4 uClear;               // clear zone behind the copy: centre, radii (cells)",
    "const float R3 = 0.8660254;",
    "const vec2 E0 = vec2(1.0, 0.0), E1 = vec2(0.5, R3), E2 = vec2(-0.5, R3);",
    "",
    "// nearest tile centre: axial coordinates on the lattice (1,0) / (0.5, sqrt3/2), cube rounding",
    "vec2 tileOf(vec2 p){",
    "  float r = p.y / R3, q = p.x - 0.5 * r, s = -q - r;",
    "  float a = floor(q + 0.5), b = floor(r + 0.5), c = floor(s + 0.5);",
    "  float da = abs(a - q), db = abs(b - r), dc = abs(c - s);",
    "  if (da > db && da > dc) a = -b - c; else if (db > dc) b = -a - c;",
    "  return vec2(a + 0.5 * b, b * R3);",
    "}",
    "float edgeDist(vec2 d){ return max(abs(d.x), max(abs(dot(d, E1)), abs(dot(d, E2)))); }",
    "float presence(vec2 c){",
    "  vec2 uv = c / uPage2;",
    "  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;",
    "  return texture(uFlow, uv).r;",
    "}",
    "float calm(float f){ return smoothstep(0.18, 0.85, f); }",
    "float clearAt(vec2 p){ return 1.0 - smoothstep(0.8, 1.3, length((p - uClear.xy) / uClear.zw)); }",
    "float rise(float f){ return uLift * smoothstep(0.02, 0.14, f) * (1.0 - smoothstep(0.14, 0.6, f)); }",
    "vec3 pageAt(vec2 p){",
    "  vec2 uv = p / uPage2;",
    "  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return uBg;",
    "  vec4 c = texture(uPage, uv);",
    "  return mix(uBg, c.rgb, c.a);",
    "}",
    "",
    "vec3 render(vec2 frag){",
    "  vec2 ndc = (frag / uRes) * 2.0 - 1.0;",
    "  ndc.x *= uRes.x / uRes.y;",
    "  vec3 right = vec3(1.0, 0.0, 0.0);",
    "  vec3 rd = normalize(ndc.x * right + ndc.y * uUp + uFocal * uFwd);",
    "  if (rd.z > -1e-4) return uBg;",
    "  float top = uLift + 0.002, floorZ = -0.16;",
    "  float tFloor = (floorZ - uEye.z) / rd.z;",
    "  float tStart = (top - uEye.z) / rd.z;",
    "  vec2 c = tileOf(uEye.xy + rd.xy * tStart);",
    "  bool hit = false, onTop = false; float tHit = 0.0, f = 0.0, z = 0.0; vec3 n = vec3(0.0, 0.0, 1.0);",
    "  for (int i = 0; i < 48; i++) {",
    "    f = presence(c); z = rise(f) * (1.0 - clearAt(c));",
    "    // span of the ray inside this hex column",
    "    float tIn = -1e9, tOut = 1e9; vec2 nIn = vec2(0.0);",
    "    for (int k = 0; k < 3; k++) {",
    "      vec2 e = k == 0 ? E0 : (k == 1 ? E1 : E2);",
    "      float dv = dot(rd.xy, e), ov = dot(uEye.xy - c, e);",
    "      if (abs(dv) < 1e-6) continue;",
    "      float t1 = (-0.5 - ov) / dv, t2 = (0.5 - ov) / dv;",
    "      if (min(t1, t2) > tIn) { tIn = min(t1, t2); nIn = -sign(dv) * e; }",
    "      tOut = min(tOut, max(t1, t2));",
    "    }",
    "    float tTop = (z - uEye.z) / rd.z;       // the ray is inside the prism once it is below its top",
    "    float tEnter = max(tIn, tTop);",
    "    if (tEnter <= tOut && tEnter < tFloor) {",
    "      hit = true; tHit = tEnter; onTop = tTop >= tIn;",
    "      n = onTop ? vec3(0.0, 0.0, 1.0) : vec3(nIn, 0.0);",
    "      break;",
    "    }",
    "    if (tOut >= tFloor) break;",
    "    // step into the neighbour across the side the ray leaves through",
    "    float best = 1e9; vec2 stepv = vec2(0.0);",
    "    for (int k = 0; k < 3; k++) {",
    "      vec2 e = k == 0 ? E0 : (k == 1 ? E1 : E2);",
    "      float dv = dot(rd.xy, e);",
    "      if (abs(dv) < 1e-6) continue;",
    "      float te = (0.5 * sign(dv) - dot(uEye.xy - c, e)) / dv;",
    "      if (te < best) { best = te; stepv = sign(dv) * e; }",
    "    }",
    "    c += stepv;",
    "  }",
    "  if (!hit) return uSeam * 0.6;",
    "",
    "  vec3 p = uEye + rd * tHit;",
    "  float k = max(calm(f), clearAt(p.xy));   // behind the copy the page stays flat and seamless",
    "  if (onTop) {                          // bevel: the last few px of a resting tile roll off toward its side",
    "    vec2 d = p.xy - c; float e = 0.5 - edgeDist(d);",
    "    if (e < uBev) {",
    "      float a0 = abs(d.x), a1 = abs(dot(d, E1)), a2 = abs(dot(d, E2));",
    "      vec2 side = a0 > a1 && a0 > a2 ? E0 : (a1 > a2 ? E1 : E2);",
    "      side *= sign(dot(d, side));",
    "      float b = (1.0 - smoothstep(0.0, uBev, e)) * (1.0 - k);",
    "      n = normalize(mix(vec3(0.0, 0.0, 1.0), vec3(side * 0.85, 0.6), b));",
    "    }",
    "  }",
    "  vec3 V = -rd;",
    "  vec3 key = normalize(vec3(-0.35, -0.5, 0.78));   // upper left, above",
    "  vec3 rim = normalize(vec3(0.55, -0.25, 0.8));    // right, above",
    "  float lam = max(dot(n, key), 0.0);",
    "  float hiKey = pow(max(dot(n, normalize(key + V)), 0.0), 220.0);",
    "  float hiRim = pow(max(dot(n, normalize(rim + V)), 0.0), 14.0) * 0.35;",
    "  float spec = (hiKey + hiRim) * uShine * (1.0 - k);",
    "  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0) * (1.0 - k);",
    "  float phase = dot(n, V) * 7.7 + (p.x + p.y) * 0.77;",
    "  vec3 tint = uTint * (1.0 + uIrid * 0.3 * cos(phase + vec3(0.0, 2.094, 4.189)) * (uTint.r > 0.99 ? 1.0 : 0.25));",
    "  vec3 sheen = spec * tint;",
    "  if (onTop) {",
    "    vec3 face = pageAt(p.xy);",
    "    vec3 lit = face * (0.86 + 0.14 * lam + z * 0.06) + sheen * 0.9 * uLight + fres * tint * 0.12 * uShine * uLight;",
    "    return mix(lit, face, k);",
    "  }",
    "  float ao = 1.0 - 0.4 * smoothstep(z, floorZ, p.z);",
    "  return uSeam * mix(0.55, 1.0, lam) * ao + (sheen * 1.3 + fres * tint * 0.28 * uShine) * uLight;",
    "}",
    "",
    "void main(){",
    "  vec2 frag = vec2(vUv.x, vUv.y) * uRes;",
    "  vec3 a = render(frag + vec2(0.25, -0.25));",
    "  vec3 b = render(frag + vec2(-0.25, 0.25));",
    "  outColor = vec4((a + b) * 0.5, 1.0);",
    "}"
  ].join("\n");

  /* ---------------------------------------------------------------- helpers */
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  function rgbOf(css) {
    probe.clearRect(0, 0, 1, 1); probe.fillStyle = "#000"; probe.fillStyle = css; probe.fillRect(0, 0, 1, 1);
    var d = probe.getImageData(0, 0, 1, 1).data;
    return [d[0] / 255, d[1] / 255, d[2] / 255];
  }
  /* "linear-gradient(90deg, rgb(..) 0%, ...)" -> { angle, stops:[[color, pos|null]] } */
  function parseGradient(s) {
    var m = /linear-gradient\((.*)\)\s*$/.exec(s || "");
    if (!m) return null;
    var body = m[1], angle = 180, am = /^\s*(-?[\d.]+)deg\s*,/.exec(body);
    if (am) { angle = parseFloat(am[1]); body = body.slice(am[0].length); }
    else if (/^\s*to right\s*,/.test(body)) { angle = 90; body = body.replace(/^\s*to right\s*,/, ""); }
    var stops = [], re = /(rgba?\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+)\s*([\d.]+%)?/gi, x;
    while ((x = re.exec(body))) stops.push([x[1], x[2] ? parseFloat(x[2]) / 100 : null]);
    stops.forEach(function (st, i) { if (st[1] === null) st[1] = stops.length > 1 ? i / (stops.length - 1) : 0; });
    return { angle: angle, stops: stops };
  }
  function makeGradient(ctx, g, r) {
    var a = (g.angle - 90) * Math.PI / 180, cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    var len = Math.abs(r.w * Math.cos(a)) + Math.abs(r.h * Math.sin(a));
    var dx = Math.cos(a) * len / 2, dy = Math.sin(a) * len / 2;
    var lg = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    g.stops.forEach(function (st) { try { lg.addColorStop(clamp(st[1], 0, 1), st[0]); } catch (e) {} });
    return lg;
  }
  function roundRect(ctx, x, y, ww, hh, r) {
    r = Math.min(r, hh / 2, ww / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + ww, y, x + ww, y + hh, r); ctx.arcTo(x + ww, y + hh, x, y + hh, r);
    ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + ww, y, r); ctx.closePath();
  }
  function stretchOf(s) {
    var v = parseFloat(s); if (isNaN(v)) return "normal";
    return v >= 120 ? "expanded" : v >= 108 ? "semi-expanded" : v <= 92 ? "semi-condensed" : "normal";
  }

  /* ---------------------------------------------------------------- the page */
  function paintPage() {
    var hr = hero.getBoundingClientRect();
    var d = Math.min(window.devicePixelRatio || 1, 2);
    paint.width = Math.max(1, Math.round(w * d)); paint.height = Math.max(1, Math.round(h * d));
    var ctx = pctx;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    var root = getComputedStyle(document.documentElement), hs = getComputedStyle(hero);

    /* background: the hero's own base (--hero-base, falls back to the page colour), then the hero gradient */
    var base = hs.getPropertyValue("--hero-base").trim() || root.getPropertyValue("--c-bg").trim() || "#030303";
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    var hg = parseGradient(hs.backgroundImage);
    if (hg) { ctx.fillStyle = makeGradient(ctx, hg, { x: 0, y: 0, w: w, h: h }); ctx.fillRect(0, 0, w, h); }
    bg = rgbOf(base);
    /* colour of the tile highlights (--hex-tint on the hero); white keeps the original iridescent look */
    var tintCss = hs.getPropertyValue("--hex-tint").trim();
    tintRgb = tintCss ? rgbOf(tintCss) : [1, 1, 1];

    /* dot band along the bottom */
    var dotRgb = (hs.getPropertyValue("--hex-rgb").trim() || "237,237,243");
    var dotA = parseFloat(hs.getPropertyValue("--hex-dot-a")) || 0.14;
    var topY = h * 0.7;
    for (var y = topY; y < h; y += 11) {
      var depth = (y - topY) / (h - topY);
      ctx.fillStyle = "rgba(" + dotRgb + "," + (dotA * (0.25 + 0.75 * depth)).toFixed(3) + ")";
      for (var x = 5.5; x < w; x += 11) ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
    }

    if (!live || !textOn || !PAINT_COPY) return uploadPage();   // touch / reduced motion / fonts still loading: the real copy sits on top

    /* boxes: pill backgrounds, borders, the badge dot */
    links = [];
    var all = [copy].concat(Array.prototype.slice.call(copy.querySelectorAll("*")));
    all.forEach(function (el) {
      var cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var box = { x: r.left - hr.left, y: r.top - hr.top, w: r.width, h: r.height };
      if (el.tagName === "A") links.push({ el: el, x: box.x, y: box.y, w: box.w, h: box.h });
      var clipText = (cs.webkitBackgroundClip || cs.backgroundClip) === "text";
      if (clipText) return;
      var bgc = cs.backgroundColor, bw = parseFloat(cs.borderTopWidth) || 0;
      var hasBg = bgc && !/rgba\(0, 0, 0, 0\)|transparent/.test(bgc);
      if (!hasBg && !bw) return;
      var rad = parseFloat(cs.borderTopLeftRadius) || 0;
      var hov = el.tagName === "A" && links.length - 1 === hoverIdx;
      ctx.save();
      var sh = /(rgba?\([^)]*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/.exec(cs.boxShadow || "");
      if (sh) { ctx.shadowColor = sh[1]; ctx.shadowOffsetX = +sh[2]; ctx.shadowOffsetY = +sh[3]; ctx.shadowBlur = +sh[4]; }
      if (hov && el.getAttribute("href") === "#work") ctx.filter = "brightness(1.1)";
      roundRect(ctx, box.x + bw / 2, box.y + bw / 2, box.w - bw, box.h - bw, rad);
      if (hasBg) { ctx.fillStyle = bgc; ctx.fill(); }
      if (hov && el.getAttribute("href") === "#contact") { ctx.fillStyle = hs.getPropertyValue("--ghost-hover").trim() || "rgba(237,237,243,.08)"; ctx.fill(); }
      ctx.shadowColor = "transparent";
      if (bw) { ctx.lineWidth = bw; ctx.strokeStyle = cs.borderTopColor; ctx.stroke(); }
      ctx.restore();
    });

    /* text: every word drawn where the browser laid it out */
    var walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT), node, range = document.createRange();
    while ((node = walker.nextNode())) {
      var text = node.nodeValue;
      if (!/\S/.test(text)) continue;
      var pe = node.parentElement, cs = getComputedStyle(pe);
      ctx.save();
      ctx.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
      try { ctx.fontStretch = stretchOf(cs.fontStretch); } catch (e) {}
      try { ctx.letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing; } catch (e) {}
      ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";

      /* colour: a background-clip:text ancestor gives a gradient over its own box */
      var fill = cs.color, glowEl = null;
      for (var a = pe; a && a !== hero; a = a.parentElement) {
        var acs = getComputedStyle(a);
        if (!glowEl && /drop-shadow/.test(acs.filter)) glowEl = acs.filter;
        if (fill === cs.color && (acs.webkitBackgroundClip || acs.backgroundClip) === "text") {
          var g = parseGradient(acs.backgroundImage), ar = a.getBoundingClientRect();
          if (g) fill = makeGradient(ctx, g, { x: ar.left - hr.left, y: ar.top - hr.top, w: ar.width, h: ar.height });
        }
      }
      ctx.fillStyle = fill;
      if (glowEl) {
        var gm = /drop-shadow\((rgba?\([^)]*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/.exec(glowEl);
        if (gm) { ctx.shadowColor = gm[1]; ctx.shadowBlur = +gm[4]; }
      }
      var re = /\S+/g, m;
      while ((m = re.exec(text))) {
        range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
        var rects = range.getClientRects();
        if (!rects.length) continue;
        var rr = rects[0], asc = ctx.measureText(m[0]).fontBoundingBoxAscent || parseFloat(cs.fontSize) * 0.8;
        ctx.fillText(m[0], rr.left - hr.left, rr.top - hr.top + asc);
      }
      ctx.restore();
    }
    uploadPage();
  }
  function uploadPage() {
    gl.bindTexture(gl.TEXTURE_2D, texPage);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, paint);
  }

  /* ---------------------------------------------------------------- camera */
  /* page plane z = 0 (x right, y down, in cells); the camera sits above the lower half and
     looks down, tilted so the top of the hero is further away. Focal length and height are
     solved so the hero's top and bottom edges land exactly on the canvas's top and bottom. */
  function solveCamera() {
    var a = TILT * Math.PI / 180, sa = Math.sin(a), ca = Math.cos(a);
    var H = h / CELL, oz = DIST * H * ca;
    var yAt = function (k, s) { return -oz * (s * ca + k * sa) / (k * ca - s * sa); };   // page y hit by screen row s (+1 top, -1 bottom), relative to camera
    var lo = Math.tan(a) + 1e-4, hi = 60;
    for (var i = 0; i < 60; i++) {
      var mid = (lo + hi) / 2;
      if (yAt(mid, -1) - yAt(mid, 1) > H) lo = mid; else hi = mid;
    }
    var k = (lo + hi) / 2;
    cam = { k: k, eye: [w / CELL / 2, -yAt(k, 1), oz], fwd: [0, -sa, -ca], up: [0, -ca, sa] };
  }
  /* screen point (hero css px) -> page point (hero css px) */
  function toPage(sx, sy) {
    if (!cam) return null;
    var nx = (sx / w * 2 - 1) * (w / h), ny = 1 - sy / h * 2;
    var dx = nx, dy = ny * cam.up[1] + cam.k * cam.fwd[1], dz = ny * cam.up[2] + cam.k * cam.fwd[2];
    if (dz > -1e-6) return null;
    var t = -cam.eye[2] / dz;
    return [(cam.eye[0] + dx * t) * CELL, (cam.eye[1] + dy * t) * CELL];
  }

  /* ---------------------------------------------------------------- presence field */
  function stepField(dt, drift) {
    if (!field) return 0;
    var keep = Math.pow(FADE, dt * 60), n = gw * gh, max = 0, i;
    for (i = 0; i < n; i++) field[i] *= keep;
    if (pointerOn || drift) {
      var p = toPage(px, py);
      if (p) {
        var fx = p[0] / w, fy = p[1] / h, asp = w / h;
        var R = touchMode ? T_RADIUS : RADIUS;
        var rad = (R / h) * (R / h) * 0.28, add = FEED * dt;
        for (var y = 0; y < gh; y++) {
          var dy = (y + 0.5) / gh - fy;
          for (var x = 0; x < gw; x++) {
            var dx = ((x + 0.5) / gw - fx) * asp;
            i = y * gw + x;
            field[i] = Math.min(4, field[i] + add * Math.exp(-(dx * dx + dy * dy) / rad));
          }
        }
      }
    }
    for (i = 0; i < n; i++) if (field[i] > max) max = field[i];
    gl.bindTexture(gl.TEXTURE_2D, texFlow);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, gw, gh, 0, gl.RED, gl.FLOAT, field);
    return max;
  }

  /* ---------------------------------------------------------------- render */
  function draw() {
    if (!cam || !w) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texPage); gl.uniform1i(U.uPage, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texFlow); gl.uniform1i(U.uFlow, 1);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform2f(U.uPage2, w / CELL, h / CELL);
    gl.uniform3f(U.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);
    gl.uniform3f(U.uFwd, cam.fwd[0], cam.fwd[1], cam.fwd[2]);
    gl.uniform3f(U.uUp, cam.up[0], cam.up[1], cam.up[2]);
    gl.uniform1f(U.uFocal, cam.k);
    gl.uniform1f(U.uLift, LIFT);
    gl.uniform1f(U.uBev, BEVEL / CELL);
    gl.uniform1f(U.uShine, SHINE);
    gl.uniform1f(U.uIrid, IRID);
    var lum = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2], dark = lum < 0.5;
    gl.uniform1f(U.uLight, dark ? 1 : 0.6);
    gl.uniform3f(U.uBg, bg[0], bg[1], bg[2]);
    var sk = dark ? 0.35 : 0.72;
    gl.uniform3f(U.uSeam, bg[0] * sk, bg[1] * sk, bg[2] * sk);
    gl.uniform3f(U.uTint, tintRgb[0], tintRgb[1], tintRgb[2]);
    gl.uniform4f(U.uClear, clear[0], clear[1], clear[2], clear[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /* touch: the unseen cursor's path, a rounded rectangle hugging the hero's edges */
  function driftPoint(t) {
    var a = t * Math.PI * 2 / T_LAP, c = Math.cos(a), s = Math.sin(a);
    var ex = (c < 0 ? -1 : 1) * Math.pow(Math.abs(c), 0.45), ey = (s < 0 ? -1 : 1) * Math.pow(Math.abs(s), 0.45);
    return [w * (0.5 + 0.44 * ex), h * (0.5 + 0.44 * ey)];
  }
  function drifting(now) { return touchMode && heroSeen && !document.hidden && !pointerOn && now > fingerUntil; }

  function loop(now) {
    raf = 0;
    if (touchMode && now - lastDraw < T_FRAME) { raf = requestAnimationFrame(loop); return; }
    lastDraw = now;
    var dt = Math.min(Math.max((now - (lastT || now - 16)) / 1000, 0), 1 / 30);
    lastT = now;
    var drift = drifting(now);
    if (drift) { var d = driftPoint(now / 1000); px = d[0]; py = d[1]; }
    var max = stepField(dt, drift);
    draw();
    if (pointerOn || drift || now < activeUntil || max > 0.002) raf = requestAnimationFrame(loop);
    else lastT = 0;
  }
  function wake() { if (!raf) raf = requestAnimationFrame(loop); }

  /* ---------------------------------------------------------------- setup */
  function layout() {
    var r = hero.getBoundingClientRect();
    w = Math.round(r.width); h = Math.round(r.height);
    if (!w || !h) return false;
    scale = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    gw = FIELD_W; gh = Math.max(16, Math.round(FIELD_W * h / w));
    /* tiles fade in only toward the edges: a soft oval around the copy stays plain */
    var copy = hero.lastElementChild;
    if (copy && copy !== canvas) {
      var cr = copy.getBoundingClientRect();
      clear = [(cr.left - r.left + cr.width / 2) / CELL, (cr.top - r.top + cr.height / 2) / CELL,
               cr.width / 2 / CELL + 0.35, cr.height / 2 / CELL + 0.3];
    }
    var old = field; field = new Float32Array(gw * gh);
    if (old && old.length === field.length) field.set(old);
    solveCamera();
    paintPage();
    stepField(0);
    return true;
  }

  function initGL() {
    gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
    if (!gl) { console.warn("hero-field: WebGL2 not available"); return false; }
    var sh = function (type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn("hero-field:", gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    var v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, FS);
    if (!v || !f) return false;
    prog = gl.createProgram(); gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn("hero-field: link failed", gl.getProgramInfoLog(prog)); return false; }
    ["uPage", "uFlow", "uRes", "uPage2", "uEye", "uFwd", "uUp", "uFocal", "uLift", "uBev", "uShine", "uIrid", "uLight", "uBg", "uSeam", "uTint", "uClear"]
      .forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    var tex = function () {
      var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    texPage = tex(); texFlow = tex();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);  // rows stay top-down: texture v = 0 is the top of the hero, like page y
    return true;
  }

  function linkAt(e) {
    var r = canvas.getBoundingClientRect();
    var p = toPage(e.clientX - r.left, e.clientY - r.top);
    if (!p) return -1;
    for (var i = 0; i < links.length; i++) {
      var L = links[i];
      if (p[0] >= L.x - 4 && p[0] <= L.x + L.w + 4 && p[1] >= L.y - 4 && p[1] <= L.y + L.h + 4) return i;
    }
    return -1;
  }

  /* The tiles start on the static first-paint hero (#boot-shell) as soon as this script runs, so the
     background arrives with the text instead of ~1 s later. When React renders the live hero, the same
     running canvas is moved into it (a moved canvas keeps its WebGL context: no restart, no second fade)
     and the per-hero listeners are bound again. If this script runs after React, it starts on the live hero. */
  var started = false;
  function relayout() { if (layout()) draw(); }

  function attach(section) {
    var c = section.querySelector("canvas.hex-field");
    if (!c || c.__field) return;
    c.__field = true;
    if (!started) {
      hero = section; canvas = c;
      copy = hero.querySelector(":scope > div:last-of-type");
      if (!copy || !initGL()) { canvas.style.display = "none"; return; }
      started = true;
      paint = document.createElement("canvas"); pctx = paint.getContext("2d");
      /* show the tiles straight away (real text on top); swap to painted text once the fonts are in,
         so the background never waits on the font download */
      var textReady = function () {
        textOn = true;
        if (live) hero.classList.add("hexgl-live");                    // hex cursor + mouse-driven field
        if (live && PAINT_COPY) hero.classList.add("hexgl-paint");    // hides the DOM copy only when it is painted into the tiles
        paintPage(); draw();
      };
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(textReady); else textReady();
      window.addEventListener("load", function () { setTimeout(relayout, 300); });
      new MutationObserver(function () { setTimeout(function () { paintPage(); draw(); }, 30); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      canvas.addEventListener("webglcontextlost", function (e) { e.preventDefault(); hero.classList.remove("hexgl-on", "hexgl-live"); });
      canvas.addEventListener("webglcontextrestored", function () {   // Safari/mobile drop the GPU context under load: rebuild instead of staying blank
        if (!initGL()) return;
        hero.classList.add("hexgl-on"); if (live) hero.classList.add("hexgl-live");
        field = null; relayout();
      });
      if (touchMode) {
        document.addEventListener("visibilitychange", function () { if (!document.hidden) wake(); });
        setTimeout(wake, 600);
      }
    } else {
      /* handover to the live hero: its classes first (so the canvas is already visible there), then the move */
      section.classList.add("hexgl-on");
      if (textOn && live) section.classList.add("hexgl-live");
      if (textOn && live && PAINT_COPY) section.classList.add("hexgl-paint");
      canvas.style.transition = "none";
      c.style.display = "none";
      c.parentNode.insertBefore(canvas, c);
      hero = section;
      copy = hero.querySelector(":scope > div:last-of-type");
      hoverIdx = -1;
    }
    bindHero();
    if (started) { paintPage(); draw(); }
  }

  /* everything tied to one hero element; runs again after the handover */
  function bindHero() {
    var h0 = hero;
    hero.classList.add("hexgl-on"); relayout();
    if ("ResizeObserver" in window) new ResizeObserver(function () { if (hero === h0) relayout(); }).observe(hero);

    if (touchMode) {
      /* a finger drives the field while it touches the hero (passive: scrolling is never blocked) */
      var at = function (t) {
        var r = canvas.getBoundingClientRect();
        px = (t.clientX - r.left) * (w / r.width); py = (t.clientY - r.top) * (h / r.height);
      };
      var down = function (e) { if (e.touches && e.touches[0]) { at(e.touches[0]); pointerOn = true; wake(); } };
      var up = function () { pointerOn = false; fingerUntil = activeUntil = performance.now() + 2500; wake(); };
      hero.addEventListener("touchstart", down, { passive: true });
      hero.addEventListener("touchmove", down, { passive: true });
      hero.addEventListener("touchend", up, { passive: true });
      hero.addEventListener("touchcancel", up, { passive: true });
      /* only animate while the hero is on screen and the tab is visible (an old, removed hero is ignored) */
      if ("IntersectionObserver" in window) new IntersectionObserver(function (en) {
        if (hero !== h0) return;
        heroSeen = en[0].isIntersecting; if (heroSeen) wake();
      }, { threshold: 0.05 }).observe(hero);
      return;
    }

    if (!live) return;
    hero.addEventListener("pointermove", function (e) {
      if (e.pointerType && e.pointerType !== "mouse") return;
      var r = canvas.getBoundingClientRect();
      px = (e.clientX - r.left) * (w / r.width); py = (e.clientY - r.top) * (h / r.height);
      pointerOn = true; activeUntil = performance.now() + 4000;
      var k = linkAt(e);
      if (k !== hoverIdx) { hoverIdx = k; hero.classList.toggle("hexgl-link", k >= 0); paintPage(); }
      wake();
    }, { passive: true });
    hero.addEventListener("pointerleave", function () {
      pointerOn = false;
      if (hoverIdx !== -1) { hoverIdx = -1; hero.classList.remove("hexgl-link"); paintPage(); }
      wake();
    }, { passive: true });
    hero.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest("a,button")) return;   // a real control (keyboard fallback) handles itself
      var k = linkAt(e);
      if (k >= 0) links[k].el.click();
    });
  }

  function find() {
    var all = document.querySelectorAll(".hero-section"), early = null;   // skip the raw template
    for (var i = 0; i < all.length; i++) {
      if (all[i].closest("x-dc")) continue;
      if (all[i].closest("#boot-shell")) { early = early || all[i]; continue; }
      attach(all[i]); return;                                               // the live hero (start or handover)
    }
    if (early && !started) attach(early);                                   // first-paint hero, before React
  }
  function boot() {
    find();
    var mo = new MutationObserver(find);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(function () { mo.disconnect(); }, 15000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

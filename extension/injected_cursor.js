// Runs in the page's MAIN world (not the extension isolated world).
(() => {
  if (window.__RH_CURSOR_V5__) return;

  const state = {
    cursorPrice: null,
    lastMouseClientY: null,
    lastSent: 0,
    lastSentPrice: null,
    hooked: false
  };
  window.__RH_CURSOR_V5__ = state;

  try {
    if (document?.documentElement) document.documentElement.dataset.rhwidgetCursorInjected = "1";
  } catch {
    // ignore
  }

  // Track the latest mouse Y in client coordinates globally so we can compute the mouse position
  // in *each* canvas's coordinate space. This avoids breaking when panes/canvases are added/removed
  // (e.g. indicators like MACD), which can change which canvas receives mouse events.
  try {
    window.addEventListener(
      "mousemove",
      (ev) => {
        state.lastMouseClientY = ev?.clientY ?? null;
      },
      { passive: true, capture: true }
    );
  } catch {
    // ignore
  }

  function extractNumber(raw) {
    const s0 = String(raw || "").trim();
    if (!s0) return null;
    const s = s0.replace(/,/g, "");
    if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }

  function extractNumberToken(raw) {
    const s0 = String(raw || "").trim();
    if (!s0) return null;
    const m = s0.replace(/,/g, "").match(/[0-9]+(?:\.[0-9]+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }

  function parseRgb(style) {
    if (!style) return null;
    const s = String(style).trim().toLowerCase();
    const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) return { r: +m[1], g: +m[2], b: +m[3] };

    if (s.startsWith("#")) {
      let hex = s.slice(1);
      if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
      if (hex.length !== 6) return null;
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16)
      };
    }
    return null;
  }

  function isGreen(style) {
    const c = parseRgb(style);
    if (!c) return false;
    return c.g > 150 && c.g > c.r + 40 && c.g > c.b + 40;
  }

  function isRed(style) {
    const c = parseRgb(style);
    if (!c) return false;
    return c.r > 150 && c.r > c.g + 40 && c.r > c.b + 40;
  }

  function isNeutralDark(style) {
    const c = parseRgb(style);
    if (!c) return false;

    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    if (lum >= 90) return false;

    const rg = Math.abs(c.r - c.g);
    const gb = Math.abs(c.g - c.b);
    const rb = Math.abs(c.r - c.b);
    const maxDiff = Math.max(rg, gb, rb);
    return maxDiff < 22;
  }

  function post(price) {
    const n = Number(price);
    if (!Number.isFinite(n) || n <= 0) return;
    state.cursorPrice = n;

    const now = performance.now();
    if (now - state.lastSent < 50) return; // ~20Hz
    // Heartbeat identical values so the content script doesn't treat the value as stale.
    if (state.lastSentPrice === n && now - state.lastSent < 350) return;
    state.lastSent = now;
    state.lastSentPrice = n;

    try {
      const target = window.top && window.top !== window ? window.top : window;
      target.postMessage({ __rhwidget: true, type: "cursor_price", price: n, ts: Date.now() }, "*");
    } catch {
      // ignore
    }
  }

  function styleRgb(styleValue) {
    const c = parseRgb(styleValue);
    if (!c) return null;
    return c;
  }

  function hasOpaqueBg(style) {
    if (!style) return false;
    const bg = styleRgb(style.backgroundColor);
    if (!bg) return false;
    // parseRgb doesn't include alpha; treat transparent strings as no-bg
    const s = String(style.backgroundColor || "").toLowerCase();
    if (s.includes("transparent")) return false;
    return true;
  }

  function scoreDomLabel(el, yBase) {
    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch {
      return -1e9;
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) return -1e9;
    if (rect.width < 22 || rect.width > 320) return -1e9;
    if (rect.height < 12 || rect.height > 90) return -1e9;

    let style;
    try {
      style = getComputedStyle(el);
    } catch {
      style = null;
    }
    if (!style) return -1e9;

    const bgOk = hasOpaqueBg(style) && isNeutralDark(style.backgroundColor) && !isGreen(style.backgroundColor) && !isRed(style.backgroundColor);
    const yCenter = rect.top + rect.height / 2;
    const yDist = Math.abs(yCenter - yBase);
    const nearRight = rect.left > window.innerWidth * 0.55;

    return (bgOk ? 400 : -150) + (nearRight ? 120 : 0) - yDist * 2 - Math.abs(rect.right - window.innerWidth) * 0.6;
  }

  function readDomCursorPriceAtRightEdge() {
    const cy = state.lastMouseClientY;
    if (cy == null) return null;
    const y = Math.max(2, Math.min(window.innerHeight - 2, cy));

    // The chart's y-axis is often NOT at the window edge (e.g. news panel on the right).
    // Anchor our sampling X positions to the active y-axis labels canvas.
    let axisRect = null;
    let yAxes = [];
    try {
      yAxes = Array.from(document.querySelectorAll('canvas[data-element="yAxisLabelsCanvas"]'));
    } catch {
      yAxes = [];
    }
    for (const canvas of yAxes) {
      let r;
      try {
        r = canvas.getBoundingClientRect();
      } catch {
        r = null;
      }
      if (!r || r.width <= 0 || r.height <= 0) continue;
      if (y < r.top || y > r.bottom) continue;
      // Prefer the axis rect closest to the right edge of the viewport.
      if (!axisRect || r.right > axisRect.right) axisRect = r;
    }

    const anchorRight = axisRect ? axisRect.right : window.innerWidth;
    const anchorLeft = axisRect ? axisRect.left : window.innerWidth - 260;
    const xs = [
      anchorRight - 6,
      anchorRight - 22,
      anchorRight - 46,
      Math.max(anchorLeft + 6, anchorRight - 120),
      Math.max(anchorLeft + 6, anchorRight - 180)
    ]
      .map((n) => Math.max(2, Math.min(window.innerWidth - 2, Math.round(n))))
      .filter((n, i, arr) => arr.indexOf(n) === i);
    const ys = [y, y - 1, y + 1, y - 2, y + 2].filter((n) => n >= 0);

    const candidates = new Set();
    for (const x of xs) {
      for (const yy of ys) {
        try {
          for (const el of document.elementsFromPoint(x, yy)) {
            if (el instanceof Element) candidates.add(el);
          }
        } catch {
          // ignore
        }
      }
    }

    let best = null;
    let bestScore = -1e9;
    for (const el of candidates) {
      const raw =
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent) ||
        el.getAttribute?.("aria-label") ||
        el.getAttribute?.("title") ||
        el.getAttribute?.("data-value") ||
        "";
      const val = extractNumber(raw);
      if (val == null) continue;

      // Filter out giant container nodes that happen to contain numbers.
      const text = String(raw || "").trim();
      if (text.length > 18) continue;
      if (text.split(/\s+/).length > 2) continue;

      const score = scoreDomLabel(el, y);
      if (score > bestScore) {
        bestScore = score;
        best = val;
      }
    }

    // Require at least a minimally plausible match (prevents grabbing random axis tick labels).
    if (bestScore < 40) return null;
    return best;
  }

  const trackedCanvases = new Set();

  function hookCanvas2D(canvas) {
    if (!canvas || canvas.__rhHookedV5) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.__rhHookedV5 = true;
    trackedCanvases.add(canvas);

    const origFillRect = ctx.fillRect.bind(ctx);
    const origFillText = ctx.fillText.bind(ctx);
    let lastRect = null;

    ctx.fillRect = function (x, y, w, h) {
      if (w > 28 && w < 260 && h > 14 && h < 80) {
        lastRect = { t: performance.now(), fill: ctx.fillStyle };
      }
      return origFillRect(x, y, w, h);
    };

    ctx.fillText = function (text, x, y, maxWidth) {
      try {
        const val = extractNumberToken(text);
        if (val != null) {
          const nearRight = x > canvas.width * 0.72;
          if (nearRight) {
            let dy = 9999;
            const cy = state.lastMouseClientY;
            if (cy != null) {
              try {
                const rect = canvas.getBoundingClientRect();
                if (rect && rect.height > 0) {
                  const scaleY = canvas.height / rect.height;
                  const mouseY_canvas = (cy - rect.top) * scaleY;
                  dy = Math.abs(y - mouseY_canvas);
                }
              } catch {
                // ignore
              }
            }

            // Exact: label drawn at the crosshair Y.
            if (dy < 10) post(val);

            // Exact: label drawn on a dark neutral badge near the crosshair Y.
            const recent = !!lastRect && performance.now() - lastRect.t < 12;
            const bgOk =
              recent && isNeutralDark(lastRect.fill) && !isGreen(lastRect.fill) && !isRed(lastRect.fill);
            if (bgOk && dy < 35) post(val);
          }
        }
      } catch {
        // ignore
      }
      return origFillText(text, x, y, maxWidth);
    };

    state.hooked = true;
  }

  function installOnce() {
    // Legends canvases (best-case)
    let yAxes = [];
    let cross = [];
    let hit = [];
    try {
      yAxes = Array.from(document.querySelectorAll('canvas[data-element="yAxisLabelsCanvas"]'));
      cross = Array.from(document.querySelectorAll('canvas[data-element="crossToolCanvas"]'));
      hit = Array.from(document.querySelectorAll('canvas[data-element="hitTestCanvas"]'));
    } catch {
      yAxes = [];
      cross = [];
      hit = [];
    }

    yAxes.forEach(hookCanvas2D);
    cross.forEach(hookCanvas2D);
    hit.forEach(hookCanvas2D);

    // If selectors changed, try a few canvases so we still catch the price label canvas.
    if (!state.hooked) {
      let all = [];
      try {
        all = Array.from(document.querySelectorAll("canvas"));
      } catch {
        all = [];
      }
      all.slice(0, 18).forEach(hookCanvas2D);
    }
  }

  function tick() {
    const p = readDomCursorPriceAtRightEdge();
    if (p != null) post(p);
  }

  const mo = new MutationObserver(() => installOnce());
  try {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    // ignore
  }

  installOnce();
  tick();
  setInterval(installOnce, 1200);
  setInterval(tick, 80);
})();

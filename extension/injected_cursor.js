// Runs in the page's MAIN world (not the extension isolated world).
(() => {
  if (window.__RH_CURSOR_V5__) return;

  const state = {
    cursorPrice: null,
    mouseY_canvas: null,
    lastSent: 0,
    lastSentPrice: null,
    hooked: false
  };
  window.__RH_CURSOR_V5__ = state;

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
    if (state.lastSentPrice === n) return;
    state.lastSent = now;
    state.lastSentPrice = n;

    try {
      const target = window.top && window.top !== window ? window.top : window;
      target.postMessage({ __rhwidget: true, type: "cursor_price", price: n, ts: Date.now() }, "*");
    } catch {
      // ignore
    }
  }

  function hookCanvas2D(canvas) {
    if (!canvas || canvas.__rhHookedV5) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.__rhHookedV5 = true;

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
        const s = String(text).trim();
        if (/^\d+(\.\d+)?$/.test(s)) {
          const val = parseFloat(s);
          if (Number.isFinite(val) && val > 0) {
            const nearRight = x > canvas.width * 0.72;
            const dy = state.mouseY_canvas == null ? 9999 : Math.abs(y - state.mouseY_canvas);
            const recent = !!lastRect && performance.now() - lastRect.t < 10;
            const bgOk = recent && isNeutralDark(lastRect.fill) && !isGreen(lastRect.fill) && !isRed(lastRect.fill);

            if (nearRight && bgOk && dy < 35) post(val);
          }
        }
      } catch {
        // ignore
      }
      return origFillText(text, x, y, maxWidth);
    };

    state.hooked = true;
  }

  function attachMouseTracker(canvas) {
    if (!canvas || canvas.__rhMouseV5) return;
    canvas.__rhMouseV5 = true;

    canvas.addEventListener(
      "mousemove",
      (ev) => {
        try {
          const rect = canvas.getBoundingClientRect();
          const scaleY = canvas.height / rect.height;
          state.mouseY_canvas = (ev.clientY - rect.top) * scaleY;
        } catch {
          // ignore
        }
      },
      { passive: true }
    );
  }

  function installOnce() {
    const yAxes = Array.from(document.querySelectorAll('canvas[data-element="yAxisLabelsCanvas"]'));
    const cross = Array.from(document.querySelectorAll('canvas[data-element="crossToolCanvas"]'));
    const hit = Array.from(document.querySelectorAll('canvas[data-element="hitTestCanvas"]'));

    attachMouseTracker(cross[0] || hit[0] || yAxes[0] || null);
    yAxes.forEach(hookCanvas2D);
    cross.forEach(hookCanvas2D);
    hit.forEach(hookCanvas2D);
  }

  const mo = new MutationObserver(() => installOnce());
  try {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    // ignore
  }
  installOnce();
  setInterval(installOnce, 1000);
})();


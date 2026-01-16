(() => {
  const WIDGET_ID = "rh-momo-widget-root";
  const IS_TOP = window.top === window;
  if (IS_TOP && document.getElementById(WIDGET_ID)) return;

  function installCanvasCursorReader() {
    if (window.__RH_WIDGET_CANVAS_CURSOR__) return;
    window.__RH_WIDGET_CANVAS_CURSOR__ = true;

    function inject() {
      try {
        if (!document.documentElement) return;
        if (document.documentElement.dataset.rhwidgetCursorInjected === "1") return;

        const script = document.createElement("script");
        script.textContent = String.raw`(() => {
  if (window.__RH_CURSOR_V5__) return;

  const state = {
    cursorPrice: null,
    mouseY_canvas: null,
    lastSent: 0,
    lastSentPrice: null,
    hooked: false,
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
        b: parseInt(hex.slice(4, 6), 16),
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

  function send(price) {
    const n = Number(price);
    if (!Number.isFinite(n) || n <= 0) return;
    state.cursorPrice = n;

    const now = performance.now();
    if (now - state.lastSent < 50) return; // ~20Hz
    if (state.lastSentPrice === n) return;
    state.lastSent = now;
    state.lastSentPrice = n;

    try {
      (window.top || window).postMessage({ __rhwidget: true, type: "cursor_price", price: n, ts: Date.now() }, "*");
    } catch {}
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
            const bgOk =
              recent && isNeutralDark(lastRect.fill) && !isGreen(lastRect.fill) && !isRed(lastRect.fill);

            if (nearRight && bgOk && dy < 35) send(val);
          }
        }
      } catch {}
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
        } catch {}
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
  } catch {}
  installOnce();
  setInterval(installOnce, 1000);
})();`;

        (document.documentElement || document.head || document.body).appendChild(script);
        script.remove();
        document.documentElement.dataset.rhwidgetCursorInjected = "1";
      } catch {
        // ignore
      }
    }

    const mo = new MutationObserver(() => inject());
    try {
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      // ignore
    }
    inject();
    setInterval(inject, 2000);
  }

  installCanvasCursorReader();
  if (!IS_TOP) return;

  const DEFAULTS = {
    apiBase: "http://127.0.0.1:8787",
    pollMs: 2000,
    limit: 30,
    symbolClickSelector: "",
    symbolTypeSelector: "",
    activeSymbolPath: [],
    activeSymbolRegion: null,
    widgetPos: null,
    widgetSize: null,
    newsVisible: false,
    newsPos: null,
    newsSize: null,
    orderType: "market",
    buyQtyMode: "dollars",
    buyQty: 1,
    limitOffset: "",
    autoStop: false
  };

  const cssUrl = chrome.runtime.getURL("styles.css");
  try {
    console.info("[RHWidget] content script loaded:", location.href);
  } catch {
    // ignore
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  const _TICKER_STOPWORDS = new Set([
    "UNTITLED",
    "ALL",
    "EQUITIES",
    "FUTURES",
    "CRYPTO",
    "INDEXES",
    "SYMBOL",
    "PRICE",
    "CHANGE",
    "VOLUME",
    "FLOAT",
    "TIME"
  ]);

  function extractTicker(raw) {
    const s = String(raw || "").trim().toUpperCase();
    if (!s) return "";

    // Find any compact "ticker-like" tokens. Then strip leading digits (e.g. "5AAPL" -> "AAPL").
    const candidates = s.match(/[A-Z0-9][A-Z0-9.\-]{0,14}/g) || [];
    let best = "";
    for (const c0 of candidates) {
      const c = c0.replace(/^[0-9]+/, "");
      if (!c) continue;
      if (!/^[A-Z]/.test(c)) continue; // tickers start with a letter
      if (c.length < 1 || c.length > 7) continue; // keep conservative (covers most equities + BRK.B)
      if (_TICKER_STOPWORDS.has(c)) continue;
      // Prefer the longest reasonable token.
      if (c.length > best.length) best = c;
    }
    return best;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function setNativeValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") desc.set.call(input, value);
    else input.value = value;
  }

  function safeCssEscape(value) {
    try {
      return window.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    } catch {
      return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    }
  }

  function firstVisible(nodeList) {
    return Array.from(nodeList || []).find((e) => isVisible(e) && !e.disabled && !e.readOnly) || null;
  }

  function deepActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    return el;
  }

  function elementTextOrValue(el) {
    if (!el) return "";
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value || "";
    return String(el.textContent || "");
  }

  function findLegendSymbolInput() {
    const candidates = [
      'input[type="search"]',
      'input[placeholder*="Search" i]',
      'input[aria-label*="Search" i]',
      'input[placeholder*="Symbol" i]',
      'input[aria-label*="Symbol" i]',
      '[role="combobox"] input'
    ];
    for (const sel of candidates) {
      const hit = firstVisible(document.querySelectorAll(sel));
      if (hit) return hit;
    }
    return null;
  }

  function attrValueEscape(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function buildSelectorFor(el) {
    if (!el || !(el instanceof Element)) return "";
    const tag = el.tagName.toLowerCase();

    const id = el.getAttribute("id");
    if (id) return `#${safeCssEscape(id)}`;

    for (const attr of ["data-testid", "data-test", "data-qa"]) {
      const v = el.getAttribute(attr);
      if (v) return `${tag}[${attr}="${attrValueEscape(v)}"]`;
    }

    for (const attr of ["aria-label", "placeholder", "name"]) {
      const v = el.getAttribute(attr);
      if (v) return `${tag}[${attr}="${attrValueEscape(v)}"]`;
    }

    const parts = [];
    let cur = el;
    while (cur && cur instanceof Element && cur !== document.body && parts.length < 7) {
      const t = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
      const idx = siblings.indexOf(cur) + 1;
      parts.unshift(`${t}:nth-of-type(${idx})`);
      cur = parent;
    }
    return parts.join(" > ");
  }

  function buildSelectorPath(el) {
    if (!el || !(el instanceof Element)) return [];
    const parts = [buildSelectorFor(el)].filter(Boolean);
    let root = el.getRootNode?.();
    while (root && root.host && root.host instanceof Element) {
      const host = root.host;
      const hostSel = buildSelectorFor(host);
      if (hostSel) parts.unshift(hostSel);
      root = host.getRootNode?.();
    }
    return parts;
  }

  function queryByPath(path) {
    if (!Array.isArray(path) || path.length === 0) return null;
    let root = document;
    let node = null;
    for (let i = 0; i < path.length; i++) {
      const sel = String(path[i] || "").trim();
      if (!sel) return null;
      try {
        node = root.querySelector(sel);
      } catch {
        return null;
      }
      if (!node) return null;
      if (i < path.length - 1) root = node.shadowRoot || node;
    }
    return node;
  }

  function queryFromSelector(sel) {
    if (!sel) return null;
    try {
      return firstVisible(document.querySelectorAll(sel));
    } catch {
      return null;
    }
  }

  function queryAnyFromSelector(sel) {
    if (!sel) return null;
    try {
      return document.querySelector(sel);
    } catch {
      return null;
    }
  }

  function findAutocompleteOptionForSymbol(symbol) {
    const s = String(symbol || "").trim().toUpperCase();
    if (!s) return null;
    const selectors = ['[role="listbox"] [role="option"]', '[role="menu"] [role="menuitem"]'];
    for (const sel of selectors) {
      const opts = Array.from(document.querySelectorAll(sel)).filter(isVisible);
      const hit =
        opts.find((el) => String(el.textContent || "").trim().toUpperCase() === s) ||
        opts.find((el) => String(el.textContent || "").trim().toUpperCase().startsWith(s)) ||
        opts.find((el) => String(el.textContent || "").toUpperCase().includes(s));
      if (hit) return hit;
    }
    return null;
  }

  function isTypeable(el) {
    if (!el) return false;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    return false;
  }

  function _keyCodeFor(key) {
    if (key === "Enter") return 13;
    if (key === "ArrowDown") return 40;
    if (key === "ArrowUp") return 38;
    if (key === "Escape") return 27;
    return 0;
  }

  function pressKey(el, key, code) {
    const target = el && el.dispatchEvent ? el : document;
    const keyCode = _keyCodeFor(key);
    const evtInit = { bubbles: true, composed: true, cancelable: true, key, code, keyCode, which: keyCode };
    const dispatchTo = (t) => {
      try {
        t.dispatchEvent(new KeyboardEvent("keydown", evtInit));
        t.dispatchEvent(new KeyboardEvent("keypress", evtInit));
        t.dispatchEvent(new KeyboardEvent("keyup", evtInit));
      } catch {
        // ignore
      }
    };
    dispatchTo(target);
    dispatchTo(document);
    dispatchTo(window);
  }

  function findAndClickSuggestion(symbol, anchorEl) {
    const s = String(symbol || "").trim().toUpperCase();
    if (!s) return false;

    const anchor = anchorEl instanceof Element ? anchorEl : null;
    const root = anchor?.getRootNode?.() || document;
    const roots = [root];
    if (root !== document) roots.push(document);

    const selectors = [
      '[role="option"]',
      '[role="menuitem"]',
      '[role="treeitem"]',
      '[data-testid]',
      "li",
      "div",
      "button",
      "a",
      "[tabindex]"
    ].join(",");

    const scored = [];
    const anchorRect = anchor?.getBoundingClientRect?.() || null;
    const isClickable = (el) => {
      const role = el.getAttribute?.("role") || "";
      if (role === "option" || role === "menuitem" || role === "treeitem") return true;
      const tabindex = el.getAttribute?.("tabindex");
      if (tabindex != null && String(tabindex) !== "-1") return true;
      if (el.hasAttribute?.("onclick")) return true;
      try {
        const c = window.getComputedStyle(el).cursor;
        if (c === "pointer") return true;
      } catch {
        // ignore
      }
      return el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement;
    };
    const scoreFor = (el) => {
      const t = String(el.textContent || "").toUpperCase();
      if (!t.includes(s)) return null;
      if (!isVisible(el)) return null;
      if (!isClickable(el)) return null;
      const r = el.getBoundingClientRect();
      const dx = anchorRect ? Math.abs(r.left - anchorRect.left) : 0;
      const dy = anchorRect ? Math.max(0, r.top - anchorRect.bottom) : 0;
      const penalty = t.startsWith(s) ? 0 : 20;
      return dy * 10 + dx + penalty;
    };

    for (const rt of roots) {
      const qsa = rt.querySelectorAll?.bind(rt);
      if (!qsa) continue;
      const els = Array.from(qsa(selectors));
      for (const el of els) {
        if (!(el instanceof Element)) continue;
        const sc = scoreFor(el);
        if (sc == null) continue;
        scored.push({ el, sc });
      }
      if (scored.length) break;
    }

    if (!scored.length) return false;
    scored.sort((a, b) => a.sc - b.sc);
    const best = scored[0].el;
    try {
      best.scrollIntoView?.({ block: "nearest" });
    } catch {
      // ignore
    }
    try {
      best.click();
      return true;
    } catch {
      return false;
    }
  }

  async function writeIntoElement(el, text) {
    const s = String(text || "");
    if (!el) return false;

    try {
      el.focus?.();
    } catch {
      // ignore
    }

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.disabled || el.readOnly) return false;
      try {
        el.setSelectionRange?.(0, el.value?.length ?? 0);
      } catch {
        // ignore
      }
      try {
        el.dispatchEvent(
          new InputEvent("beforeinput", { bubbles: true, data: s, inputType: "insertText", cancelable: true })
        );
      } catch {
        // ignore
      }
      try {
        // Some controlled inputs ignore value sets unless they also see key events.
        el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a", code: "KeyA", ctrlKey: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a", code: "KeyA", ctrlKey: true }));
      } catch {
        // ignore
      }
      setNativeValue(el, s);
      try {
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: s, inputType: "insertText" }));
      } catch {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Some controlled inputs immediately overwrite/format `value`; treat dispatch as success.
      return true;
    }

    if (el instanceof HTMLElement && el.isContentEditable) {
      try {
        document.execCommand("selectAll", false);
        document.execCommand("insertText", false, s);
      } catch {
        // ignore
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    return false;
  }

  function isLegendRoute() {
    const p = (location.pathname || "").toLowerCase();
    return p.includes("/legend");
  }

  let currentCfg = { ...DEFAULTS };
  let lastActivatedSymbol = "";
  let loginRequested = false;
  let lastMousePos = null;
  let lastFrameCursorPrice = null;
  let lastFrameCursorTs = 0;

  async function bindSymbolInput(ui) {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;pointer-events:none;" +
      "background:rgba(0,0,0,.22);display:flex;align-items:flex-start;justify-content:center;padding-top:18px;";
    const card = document.createElement("div");
    card.style.cssText =
      "pointer-events:none;background:rgba(16,20,33,.96);color:#fff;border:1px solid rgba(255,255,255,.18);" +
      "border-radius:12px;padding:10px 12px;max-width:720px;width:calc(100vw - 40px);font:13px system-ui;";
    card.textContent = "Binding mode: click the Legend symbol/search input (press Esc to cancel).";
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const cleanup = () => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("click", onClick, true);
    };

    const onKey = async (e) => {
      if (e.key !== "Escape") return;
      cleanup();
      setStatus(ui, "ok", "canceled");
      await sleep(800);
      setStatus(ui, "ok", "live");
    };

    const onClick = async (e) => {
      if (ui.root.contains(e.target)) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;

      let el = target;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.isContentEditable) {
        const inner = el.querySelector?.('input, textarea, [contenteditable="true"]');
        if (inner) el = inner;
      }

      const clickSel = buildSelectorFor(target);
      if (!clickSel) return;

      await sleep(50);
      const active = deepActiveElement();
      const typeEl = isTypeable(active) ? active : isTypeable(el) ? el : null;
      const typeSel = typeEl ? buildSelectorFor(typeEl) : "";

      await chrome.storage.local.set({ symbolClickSelector: clickSel, symbolTypeSelector: typeSel });
      currentCfg.symbolClickSelector = clickSel;
      currentCfg.symbolTypeSelector = typeSel;
      cleanup();
      setStatus(ui, "ok", "bound");
      await sleep(900);
      setStatus(ui, "ok", "live");
    };

    window.addEventListener("keydown", onKey, true);
    document.addEventListener("click", onClick, true);
  }

  async function bindActiveSymbol(ui) {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;pointer-events:none;" +
      "background:rgba(0,0,0,.22);display:flex;align-items:flex-start;justify-content:center;padding-top:18px;";
    const card = document.createElement("div");
    card.style.cssText =
      "pointer-events:none;background:rgba(16,20,33,.96);color:#fff;border:1px solid rgba(255,255,255,.18);" +
      "border-radius:12px;padding:10px 12px;max-width:720px;width:calc(100vw - 40px);font:13px system-ui;";
    card.textContent = "Train active symbol: drag to select the on-screen region (press Esc to cancel).";
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const selection = document.createElement("div");
    selection.style.cssText =
      "position:fixed;border:2px dashed rgba(255,255,255,.8);background:rgba(120,170,255,.15);" +
      "pointer-events:none;display:none;z-index:2147483647;";
    document.body.appendChild(selection);

    const cleanup = () => {
      overlay.remove();
      selection.remove();
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    };

    const onKey = async (e) => {
      if (e.key !== "Escape") return;
      cleanup();
      setStatus(ui, "ok", "canceled");
      await sleep(800);
      setStatus(ui, "ok", "live");
    };

    let start = null;
    const onDown = (e) => {
      if (ui.root.contains(e.target)) return;
      start = { x: e.clientX, y: e.clientY };
      selection.style.left = `${start.x}px`;
      selection.style.top = `${start.y}px`;
      selection.style.width = "0px";
      selection.style.height = "0px";
      selection.style.display = "";
    };

    const onMove = (e) => {
      if (!start) return;
      const x = Math.min(start.x, e.clientX);
      const y = Math.min(start.y, e.clientY);
      const w = Math.abs(e.clientX - start.x);
      const h = Math.abs(e.clientY - start.y);
      selection.style.left = `${x}px`;
      selection.style.top = `${y}px`;
      selection.style.width = `${w}px`;
      selection.style.height = `${h}px`;
    };

    const onUp = async (e) => {
      if (!start) return;
      const x = Math.min(start.x, e.clientX);
      const y = Math.min(start.y, e.clientY);
      const w = Math.abs(e.clientX - start.x);
      const h = Math.abs(e.clientY - start.y);
      start = null;
      if (w < 6 || h < 6) return;

      const vw = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
      const vh = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
      const region = {
        x: x / vw,
        y: y / vh,
        w: w / vw,
        h: h / vh
      };

      await chrome.storage.local.set({ activeSymbolRegion: region, activeSymbolPath: [] });
      currentCfg.activeSymbolRegion = region;
      currentCfg.activeSymbolPath = [];
      cleanup();
      setStatus(ui, "ok", "trained");
      await sleep(900);
      setStatus(ui, "ok", "live");
    };

    window.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  }

  async function bindCursorPriceAxis(ui) {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;pointer-events:none;" +
      "background:rgba(0,0,0,.22);display:flex;align-items:flex-start;justify-content:center;padding-top:18px;";
    const card = document.createElement("div");
    card.style.cssText =
      "pointer-events:none;background:rgba(16,20,33,.96);color:#fff;border:1px solid rgba(255,255,255,.18);" +
      "border-radius:12px;padding:10px 12px;max-width:720px;width:calc(100vw - 40px);font:13px system-ui;";
    card.textContent =
      "Train cursor price axis: drag-select the y-axis price labels area (include the floating crosshair label with the '+' icon if possible). " +
      "Press Esc to cancel.";
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const selection = document.createElement("div");
    selection.style.cssText =
      "position:fixed;border:2px dashed rgba(255,255,255,.8);background:rgba(120,170,255,.15);" +
      "pointer-events:none;display:none;z-index:2147483647;";
    document.body.appendChild(selection);

    const cleanup = () => {
      overlay.remove();
      selection.remove();
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    };

    const onKey = async (e) => {
      if (e.key !== "Escape") return;
      cleanup();
      setStatus(ui, "ok", "canceled");
      await sleep(800);
      setStatus(ui, "ok", "live");
    };

    let start = null;
    const onDown = (e) => {
      if (ui.root.contains(e.target)) return;
      start = { x: e.clientX, y: e.clientY };
      selection.style.left = `${start.x}px`;
      selection.style.top = `${start.y}px`;
      selection.style.width = "0px";
      selection.style.height = "0px";
      selection.style.display = "";
    };

    const onMove = (e) => {
      if (!start) return;
      const x = Math.min(start.x, e.clientX);
      const y = Math.min(start.y, e.clientY);
      const w = Math.abs(e.clientX - start.x);
      const h = Math.abs(e.clientY - start.y);
      selection.style.left = `${x}px`;
      selection.style.top = `${y}px`;
      selection.style.width = `${w}px`;
      selection.style.height = `${h}px`;
    };

    const onUp = async (e) => {
      if (!start) return;
      const x = Math.min(start.x, e.clientX);
      const y = Math.min(start.y, e.clientY);
      const w = Math.abs(e.clientX - start.x);
      const h = Math.abs(e.clientY - start.y);
      start = null;
      if (w < 6 || h < 6) return;

      const vw = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
      const vh = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
      const region = {
        x: x / vw,
        y: y / vh,
        w: w / vw,
        h: h / vh
      };

      await chrome.storage.local.set({ cursorPriceAxisRegion: region });
      currentCfg.cursorPriceAxisRegion = region;
      cleanup();
      setStatus(ui, "ok", "price axis trained");
      await sleep(900);
      setStatus(ui, "ok", "live");
    };

    window.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  }

  async function bindCursorPriceElement(ui) {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;pointer-events:none;" +
      "background:rgba(0,0,0,.22);display:flex;align-items:flex-start;justify-content:center;padding-top:18px;";
    const card = document.createElement("div");
    card.style.cssText =
      "pointer-events:none;background:rgba(16,20,33,.96);color:#fff;border:1px solid rgba(255,255,255,.18);" +
      "border-radius:12px;padding:10px 12px;max-width:720px;width:calc(100vw - 40px);font:13px system-ui;";
    card.textContent =
      "Bind cursor price: click the white crosshair price label (next to the '+') to bind it. Press Esc to cancel.";
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const cleanup = () => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("click", onClick, true);
    };

    const onKey = async (e) => {
      if (e.key !== "Escape") return;
      cleanup();
      setStatus(ui, "ok", "canceled");
      await sleep(800);
      setStatus(ui, "ok", "live");
    };

    const onClick = async (e) => {
      if (ui.root.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();

      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;

      const path = buildSelectorPath(target);
      if (!path.length) return;

      await chrome.storage.local.set({ cursorPricePath: path });
      currentCfg.cursorPricePath = path;
      cleanup();
      setStatus(ui, "ok", "cursor bound");
      await sleep(900);
      setStatus(ui, "ok", "live");
    };

    window.addEventListener("keydown", onKey, true);
    document.addEventListener("click", onClick, true);
  }

  async function activateSymbol(symbol) {
    const s = extractTicker(symbol);
    if (!s) return false;
    lastActivatedSymbol = s;

    try {
      const url = new URL(location.href);
      if (!url.searchParams.get("symbol")) {
        url.searchParams.set("symbol", s);
        history.pushState({}, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
    } catch {
      // ignore
    }

    const clickSel = String(currentCfg.symbolClickSelector || "").trim();
    const typeSel = String(currentCfg.symbolTypeSelector || "").trim();
    const clickEl = queryFromSelector(clickSel);
    const typeEl = queryAnyFromSelector(typeSel);
    const fallbackInput = findLegendSymbolInput();

    const focusEl = clickEl || typeEl || fallbackInput;
    if (focusEl) {
      try {
        focusEl.click();
      } catch {
        // ignore
      }
      await sleep(80);
    }

    const active = deepActiveElement();
    const target =
      (typeEl && isTypeable(typeEl) && typeEl) ||
      (active && isTypeable(active) && active) ||
      (fallbackInput && isTypeable(fallbackInput) && fallbackInput) ||
      null;
    let wrote = await writeIntoElement(target, s);
    if (!wrote) {
      try {
        document.execCommand("selectAll", false);
        wrote = document.execCommand("insertText", false, s) || wrote;
      } catch {
        // ignore
      }
    }

    // Give Legend time to populate its autocomplete list.
    await sleep(260);
    if (target) {
      try {
        target.focus?.();
      } catch {
        // ignore
      }
    }

    // Prefer clicking a real suggestion element (more reliable than synthetic Enter on some apps).
    if (findAndClickSuggestion(s, target)) return true;

    // Fallback: highlight first suggestion then accept.
    pressKey(target, "ArrowDown", "ArrowDown");
    await sleep(140);
    if (findAndClickSuggestion(s, target)) return true;
    if (target) {
      try {
        target.focus?.();
      } catch {
        // ignore
      }
    }
    pressKey(target, "Enter", "Enter");
    if (!wrote) {
      try {
        console.warn("[RHWidget] could not type into:", {
          activeTag: active?.tagName,
          activeRole: active?.getAttribute?.("role"),
          activeAria: active?.getAttribute?.("aria-label"),
          activePlaceholder: active?.getAttribute?.("placeholder"),
          typeSel,
          clickSel
        });
      } catch {
        // ignore
      }
    }
    if (!wrote) {
      try {
        await navigator.clipboard.writeText(s);
      } catch {
        // ignore
      }
      return false;
    }
    return true;
  }

  function detectActiveSymbol(ui) {
    // 0) User-trained screen region (sample elements in region).
    const region = currentCfg.activeSymbolRegion;
    if (region && typeof region === "object") {
      const vw = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
      const vh = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
      const rx = Math.floor((region.x || 0) * vw);
      const ry = Math.floor((region.y || 0) * vh);
      const rw = Math.floor((region.w || 0) * vw);
      const rh = Math.floor((region.h || 0) * vh);
      if (rw > 5 && rh > 5) {
        const points = [
          [rx + Math.floor(rw * 0.5), ry + Math.floor(rh * 0.5)],
          [rx + Math.floor(rw * 0.2), ry + Math.floor(rh * 0.2)],
          [rx + Math.floor(rw * 0.8), ry + Math.floor(rh * 0.2)],
          [rx + Math.floor(rw * 0.2), ry + Math.floor(rh * 0.8)],
          [rx + Math.floor(rw * 0.8), ry + Math.floor(rh * 0.8)]
        ];
        const elements = new Set();
        for (const [px, py] of points) {
          const x = Math.min(Math.max(0, px), vw - 1);
          const y = Math.min(Math.max(0, py), vh - 1);
          try {
            for (const el of document.elementsFromPoint(x, y)) {
              if (el instanceof Element) elements.add(el);
            }
          } catch {
            // ignore
          }
        }
        const regionRect = { left: rx, top: ry, right: rx + rw, bottom: ry + rh, area: rw * rh };
        const scoreEl = (el) => {
          if (!(el instanceof Element)) return null;
          if (ui?.root && ui.root.contains(el)) return null;
          if (el === document.body || el === document.documentElement) return null;
          let rect;
          try {
            rect = el.getBoundingClientRect();
          } catch {
            return null;
          }
          if (!rect || rect.width <= 0 || rect.height <= 0) return null;
          const left = Math.max(regionRect.left, rect.left);
          const top = Math.max(regionRect.top, rect.top);
          const right = Math.min(regionRect.right, rect.right);
          const bottom = Math.min(regionRect.bottom, rect.bottom);
          const iw = right - left;
          const ih = bottom - top;
          if (iw <= 0 || ih <= 0) return null;
          const iArea = iw * ih;
          const overlap = iArea / Math.max(1, regionRect.area);
          if (overlap < 0.25) return null;
          const rectArea = rect.width * rect.height;
          if (rectArea > regionRect.area * 6) return null;
          const raw = elementTextOrValue(el) || el.getAttribute?.("aria-label") || el.getAttribute?.("title") || "";
          const sym = extractTicker(raw);
          if (!sym) return null;
          const score = overlap * 100 - rectArea / Math.max(1, regionRect.area) + sym.length * 2;
          return { sym, score };
        };
        let best = null;
        for (const el of elements) {
          const scored = scoreEl(el);
          if (!scored) continue;
          if (!best || scored.score > best.score) best = scored;
        }
        if (best?.sym) return best.sym;
      }
    }

    // 0) User-trained on-screen active symbol element (supports shadow DOM via selector path).
    if (Array.isArray(currentCfg.activeSymbolPath) && currentCfg.activeSymbolPath.length > 0) {
      const el = queryByPath(currentCfg.activeSymbolPath);
      const fromTrained = extractTicker(elementTextOrValue(el));
      if (fromTrained) return fromTrained;
    }

    // 1) If the bound type element is readable, use it.
    const typeSel = String(currentCfg.symbolTypeSelector || "").trim();
    const typeEl = queryAnyFromSelector(typeSel);
    const fromTypeEl = extractTicker(elementTextOrValue(typeEl));
    if (fromTypeEl) return fromTypeEl;

    // 2) If the active element is typeable, use it.
    const active = deepActiveElement();
    const fromActive = extractTicker(elementTextOrValue(active));
    if (fromActive) return fromActive;

    // 3) If URL happens to include a symbol, use it (may be stale).
    try {
      const u = new URL(location.href);
      const qs = extractTicker(u.searchParams.get("symbol"));
      if (qs) return qs;
    } catch {
      // ignore
    }

    // 4) Try common DOM labels (exclude our widget).
    const selectors = [
      '[data-testid*="symbol" i]',
      '[data-testid*="ticker" i]',
      '[aria-label*="symbol" i]',
      '[aria-label*="ticker" i]'
    ];
    const root = ui?.root;
    for (const sel of selectors) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(sel));
      } catch {
        nodes = [];
      }
      for (const el of nodes.slice(0, 80)) {
        if (!(el instanceof Element)) continue;
        if (root && root.contains(el)) continue;
        if (!isVisible(el)) continue;
        const sym = extractTicker(el.textContent);
        if (sym) return sym;
      }
    }

    return lastActivatedSymbol;
  }

  function extractPrice(raw) {
    const s0 = String(raw || "").trim();
    if (!s0) return null;
    const s = s0.replaceAll(",", "");
    const m = s.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) return null;
    if (n <= 0) return null;
    return n;
  }

  function parseRgb(cssColor) {
    const s = String(cssColor || "");
    const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)/i);
    if (!m) return null;
    return {
      r: Number(m[1]),
      g: Number(m[2]),
      b: Number(m[3]),
      a: m[4] == null ? 1 : Number(m[4])
    };
  }

  function colorLuma01(rgb) {
    if (!rgb) return 0;
    const r = Math.max(0, Math.min(255, Number(rgb.r) || 0)) / 255;
    const g = Math.max(0, Math.min(255, Number(rgb.g) || 0)) / 255;
    const b = Math.max(0, Math.min(255, Number(rgb.b) || 0)) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function scorePriceEl({ el, overlap, yDist, preferWhite }) {
    let style;
    try {
      style = getComputedStyle(el);
    } catch {
      style = null;
    }
    const fg = style ? parseRgb(style.color) : null;
    const bg = style ? parseRgb(style.backgroundColor) : null;
    const luma = colorLuma01(fg);
    const minRgb01 = fg ? Math.min(fg.r, fg.g, fg.b) / 255 : 0;
    const redBias = fg ? fg.r / 255 - (fg.g + fg.b) / (2 * 255) : 0;
    const channelSpread01 = fg ? (Math.max(fg.r, fg.g, fg.b) - Math.min(fg.r, fg.g, fg.b)) / 255 : 1;
    const hasBg = bg
      ? (bg.a ?? 1) > 0.05 && !(bg.r === 0 && bg.g === 0 && bg.b === 0 && (bg.a ?? 1) === 0)
      : false;

    const whiteBonus = preferWhite ? minRgb01 * 180 + (1 - channelSpread01) * 80 : 0;
    const colorPenalty = preferWhite ? Math.max(0, channelSpread01 - 0.12) * 240 : 0;

    return (
      overlap * 140 +
      whiteBonus +
      luma * 10 +
      (hasBg ? 45 : 0) -
      Math.max(0, redBias) * 260 -
      colorPenalty -
      yDist / 8
    );
  }

  function detectCursorPriceFromScale(regionRect, yBase) {
    const { left, top, right, bottom } = regionRect;
    const w = right - left;
    const h = bottom - top;
    if (w < 6 || h < 24) return null;

    const xSamples = [
      left + Math.floor(w * 0.25),
      left + Math.floor(w * 0.55),
      left + Math.floor(w * 0.8)
    ];
    const yStep = Math.max(10, Math.floor(h / 18));

    const candidates = new Set();
    for (let y = top + 6; y <= bottom - 6; y += yStep) {
      for (const x0 of xSamples) {
        const x = Math.min(Math.max(left, x0), right - 1);
        try {
          for (const el of document.elementsFromPoint(x, y)) {
            if (el instanceof Element) candidates.add(el);
          }
        } catch {
          // ignore
        }
      }
    }

    const points = [];
    const seen = new Set();
    for (const el of candidates) {
      const raw = elementTextOrValue(el) || el.getAttribute?.("aria-label") || el.getAttribute?.("title") || "";
      const price = extractPrice(raw);
      if (price == null) continue;

      let rect;
      try {
        rect = el.getBoundingClientRect();
      } catch {
        continue;
      }
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      const yCenter = rect.top + rect.height / 2;
      if (yCenter < top - 2 || yCenter > bottom + 2) continue;

      let style;
      try {
        style = getComputedStyle(el);
      } catch {
        style = null;
      }
      const fg = style ? parseRgb(style.color) : null;
      const bg = style ? parseRgb(style.backgroundColor) : null;
      const luma = colorLuma01(fg);
      const channelSpread01 = fg ? (Math.max(fg.r, fg.g, fg.b) - Math.min(fg.r, fg.g, fg.b)) / 255 : 1;
      const minRgb01 = fg ? Math.min(fg.r, fg.g, fg.b) / 255 : 0;
      const redBias = fg ? fg.r / 255 - (fg.g + fg.b) / (2 * 255) : 0;
      const hasBg = bg
        ? (bg.a ?? 1) > 0.05 && !(bg.r === 0 && bg.g === 0 && bg.b === 0 && (bg.a ?? 1) === 0)
        : false;

      // Keep mostly-neutral axis labels; exclude white crosshair + colored last price labels.
      if (hasBg) continue;
      if (luma > 0.9) continue;
      if (luma < 0.22) continue;
      if (minRgb01 > 0.92) continue;
      if (channelSpread01 > 0.14) continue;
      if (Math.abs(redBias) > 0.18) continue;

      const key = `${price.toFixed(4)}@${Math.round(yCenter)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      points.push({ y: yCenter, p: price });
    }

    if (points.length < 3) return null;

    // Least-squares fit: p = a*y + b. Works for linear price scales.
    const n = points.length;
    let sumY = 0,
      sumP = 0,
      sumYY = 0,
      sumYP = 0;
    for (const pt of points) {
      sumY += pt.y;
      sumP += pt.p;
      sumYY += pt.y * pt.y;
      sumYP += pt.y * pt.p;
    }
    const denom = n * sumYY - sumY * sumY;
    if (Math.abs(denom) < 1e-6) return null;
    const a = (n * sumYP - sumY * sumP) / denom;
    const b = (sumP - a * sumY) / n;
    const out = a * yBase + b;
    if (!Number.isFinite(out) || out <= 0) return null;
    return out;
  }

  const CURSOR_STALE_MS = 800;

  function detectCursorPrice(_ui) {
    const now = Date.now();
    if (lastFrameCursorPrice != null && now - lastFrameCursorTs < CURSOR_STALE_MS) return lastFrameCursorPrice;
    return null;
  }

  function setCursorPrice(ui, price) {
    const el = ui.wrap.querySelector(".cursor-price");
    if (!el) return;
    if (price == null) {
      el.textContent = "-";
      return;
    }
    const n = Number(price);
    if (!Number.isFinite(n) || n <= 0) {
      el.textContent = "-";
      return;
    }
    el.textContent = n.toFixed(2);
  }

  async function cursorPriceLoop(ui) {
    let lastGood = null;
    let lastGoodTs = 0;
    while (true) {
      if (!isLegendRoute()) {
        setCursorPrice(ui, null);
        lastGood = null;
        lastGoodTs = 0;
        await sleep(800);
        continue;
      }
      const price = detectCursorPrice(ui);
      const now = Date.now();
      if (price != null && price !== lastGood) {
        lastGood = price;
        lastGoodTs = now;
        setCursorPrice(ui, price);
      } else if (price != null) {
        lastGoodTs = now;
      } else if (lastGood != null && now - lastGoodTs > 1500) {
        lastGood = null;
        setCursorPrice(ui, null);
      }
      await sleep(50);
    }
  }

  function setActiveSymbol(ui, symbol) {
    const el = ui.wrap.querySelector(".active-symbol");
    if (!el) return;
    el.textContent = symbol || "-";
  }

  async function activeSymbolLoop(ui) {
    let prev = "";
    while (true) {
      if (!isLegendRoute()) {
        setActiveSymbol(ui, "—");
        prev = "";
        await sleep(1000);
        continue;
      }
      const sym = detectActiveSymbol(ui);
      // Only update when we have a plausible symbol; otherwise keep the last one.
      if (sym && sym !== prev) {
        prev = sym;
        setActiveSymbol(ui, sym);
      } else if (!sym && !prev) {
        setActiveSymbol(ui, "—");
      }
      await sleep(400);
    }
  }

  function buildUi() {
    const root = document.createElement("div");
    root.id = WIDGET_ID;
    const shadow = root.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .rh-momo-widget { position: fixed; top: 84px; right: 16px; z-index: 2147483647; background: rgba(16,20,33,.92); color: #fff; }
    `;

    const wrap = document.createElement("div");
    wrap.className = "rh-momo-widget";
    wrap.innerHTML = `
      <div class="header">
        <div class="title">Momo Screener</div>
        <div class="active">
          Active: <span class="active-symbol">-</span>
          <span class="cursor-price-wrap">Cursor Price: <span class="cursor-price">-</span></span>
        </div>
        <div class="right">
          <button class="icon-btn bind-btn" title="Bind symbol input" type="button">B</button>
          <button class="icon-btn train-btn" title="Train active-symbol region" type="button">T</button>
          <button class="icon-btn news-btn" title="News" type="button">N</button>
          <button class="icon-btn settings-btn" title="Settings" type="button">⚙</button>
          <button class="login-btn" title="Login to Robinhood" type="button">Login</button>
                  </div>
      </div>
      <div class="meta">
        <div class="updated">Updated: <span class="updated-at">—</span>
          <span class="status-inline" title="Status">
            <span class="dot"></span>
            <span class="text">starting?</span>
          </span>
        </div>
        <div class="hint">Click a ticker to activate it in Legend.</div>
      </div>
      <div class="trade-controls">
        <div class="toggle-group order-type">
          <button class="toggle-btn" data-value="market" type="button">MKT</button>
          <button class="toggle-btn" data-value="limit" type="button">LMT</button>
        </div>
        <div class="toggle-group auto-stop">
          <button class="toggle-btn auto-stop-btn" type="button" title="Auto stop-loss: 1¢ below previous candle low">STOP</button>
        </div>
        <div class="field">
          <label>Buy</label>
          <div class="toggle-group qty-mode" title="Buy amount mode">
            <button class="toggle-btn" data-value="shares" type="button">SH</button>
            <button class="toggle-btn" data-value="dollars" type="button">$</button>
          </div>
          <input class="qty-input" type="number" min="1" step="1" />
        </div>
        <div class="field limit-only">
          <label>Offset</label>
          <input class="limit-input" type="number" step="0.01" />
        </div>
        <div class="trade-status" title="Trade status">
          <span class="dot"></span>
          <span class="text">trade idle</span>
        </div>
      </div>
      <div class="grid">
        <table class="table">
          <thead><tr class="thead-row"></tr></thead>
          <tbody class="tbody"></tbody>
        </table>
      </div>
      <div class="auth-modal hidden">
        <div class="auth-card">
          <div class="auth-title">SMS Code Required</div>
          <div class="auth-row">
            <input class="sms-input" type="text" inputmode="numeric" placeholder="Enter SMS code" />
            <button class="sms-submit" type="button">Submit</button>
          </div>
          <div class="auth-status"></div>
        </div>
      </div>
      <div class="resizer" title="Resize"></div>
    `;

    const newsWrap = document.createElement("div");
    newsWrap.className = "rh-news-widget hidden";
    newsWrap.innerHTML = `
      <div class="news-header">
        <div class="news-title">News: <span class="news-symbol">-</span></div>
        <div class="news-actions">
          <button class="icon-btn news-refresh-btn" title="Refresh" type="button">R</button>
          <button class="icon-btn news-close-btn" title="Close" type="button">×</button>
        </div>
      </div>
      <div class="news-body">
        <div class="news-status">select a ticker…</div>
        <div class="news-analysis hidden">
          <div class="news-sentiment">
            <div class="sentiment-score" title="Sentiment score (0-100)">--</div>
            <div class="sentiment-label">neutral</div>
          </div>
          <div class="sentiment-bar" aria-hidden="true">
            <div class="sentiment-bar-fill"></div>
          </div>
          <div class="news-summary"></div>
          <ul class="news-points"></ul>
        </div>
        <div class="news-list"></div>
      </div>
      <div class="news-resizer" title="Resize"></div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(wrap);
    shadow.appendChild(newsWrap);

    fetch(cssUrl)
      .then((r) => r.text())
      .then((css) => {
        style.textContent = css;
      })
      .catch(() => {
        // Keep minimal fallback styling.
      });

    const settingsBtn = wrap.querySelector(".settings-btn");
    settingsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      if (chrome?.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
    });

    const newsBtn = wrap.querySelector(".news-btn");
    const newsCloseBtn = newsWrap.querySelector(".news-close-btn");
    const newsRefreshBtn = newsWrap.querySelector(".news-refresh-btn");
    newsBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setNewsVisible({ newsWrap }, newsWrap.classList.contains("hidden"));
    });
    newsCloseBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setNewsVisible({ newsWrap }, false);
    });
    newsRefreshBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        window.dispatchEvent(new Event("rhwidget:news-refresh"));
      } catch {
        // ignore
      }
    });

    const loginBtn = wrap.querySelector(".login-btn");
    loginBtn?.addEventListener("click", async (e) => {
      e.preventDefault();
      loginRequested = true;
      loginBtn.disabled = true;
      setLoginButtonState({ wrap }, "pending");
      try {
        const url = `${currentCfg.apiBase.replace(/\/$/, "")}/api/auth/login`;
        const res = await fetch(url, { method: "POST" });
        const data = await res.json();
        if (data?.mfa_required) {
          setAuthModal({ wrap }, true, "enter SMS code");
          setLoginButtonState({ wrap }, "mfa");
        } else if (data?.logged_in) {
          setAuthModal({ wrap }, false, "");
          setLoginButtonState({ wrap }, "ok");
        } else {
          setLoginButtonState({ wrap }, "error");
        }
      } catch {
        setLoginButtonState({ wrap }, "error");
      } finally {
        loginBtn.disabled = false;
      }
    });

    const bindBtn = wrap.querySelector(".bind-btn");
    bindBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      setStatus({ wrap }, "connecting", "bind mode");
      await bindSymbolInput({ root, wrap });
    });

    const trainBtn = wrap.querySelector(".train-btn");
    trainBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      setStatus({ wrap }, "connecting", "train mode");
      await bindActiveSymbol({ root, wrap });
    });

    const cursorBtn = wrap.querySelector(".cursor-btn");
    cursorBtn?.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      setStatus({ wrap }, "connecting", "cursor bind");
      await bindCursorPriceElement({ root, wrap });
    });

    const priceBtn = wrap.querySelector(".price-btn");
    priceBtn?.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      setStatus({ wrap }, "connecting", "price train");
      await bindCursorPriceAxis({ root, wrap });
    });

    const orderButtons = wrap.querySelectorAll(".order-type .toggle-btn");
    const modeButtons = wrap.querySelectorAll(".qty-mode .toggle-btn");
    const autoStopBtn = wrap.querySelector(".auto-stop-btn");
    const qtyInput = wrap.querySelector(".qty-input");
    const limitInput = wrap.querySelector(".limit-input");
    orderButtons.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        orderButtons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        saveTradeConfig({ wrap });
      });
    });
    modeButtons.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        modeButtons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        saveTradeConfig({ wrap });
      });
    });
    autoStopBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      autoStopBtn.classList.toggle("active");
      saveTradeConfig({ wrap });
    });
    qtyInput?.addEventListener("change", () => saveTradeConfig({ wrap }));
    limitInput?.addEventListener("change", () => saveTradeConfig({ wrap }));

    const smsSubmit = wrap.querySelector(".sms-submit");
    const smsInput = wrap.querySelector(".sms-input");
    smsSubmit?.addEventListener("click", async (e) => {
      e.preventDefault();
      const code = String(smsInput?.value || "").trim();
      if (!code) return;
      smsSubmit.disabled = true;
      setAuthModal({ wrap }, true, "submitting...");
      try {
        const url = `${currentCfg.apiBase.replace(/\/$/, "")}/api/auth/sms`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (data?.logged_in) {
          setAuthModal({ wrap }, false, "");
          smsInput.value = "";
          loginRequested = false;
        } else {
          loginRequested = true;
          setAuthModal({ wrap }, true, data?.error || data?.status || "waiting for code");
        }
      } catch {
        setAuthModal({ wrap }, true, "submit failed");
      } finally {
        smsSubmit.disabled = false;
      }
    });

    const header = wrap.querySelector(".header");
    const resizer = wrap.querySelector(".resizer");
    const newsHeader = newsWrap.querySelector(".news-header");
    const newsResizer = newsWrap.querySelector(".news-resizer");

    const startDrag = (downEvent) => {
      if (downEvent.button !== 0) return;
      if (downEvent.target?.closest?.("button,a,input,select,textarea")) return;
      downEvent.preventDefault();
      downEvent.stopPropagation();

      const rect = wrap.getBoundingClientRect();
      const startX = downEvent.clientX;
      const startY = downEvent.clientY;
      const offsetX = startX - rect.left;
      const offsetY = startY - rect.top;

      wrap.style.right = "auto";
      wrap.style.left = `${rect.left}px`;
      wrap.style.top = `${rect.top}px`;

      const onMove = (moveEvent) => {
        const x = Math.min(
          Math.max(0, moveEvent.clientX - offsetX),
          Math.max(0, window.innerWidth - rect.width)
        );
        const y = Math.min(
          Math.max(0, moveEvent.clientY - offsetY),
          Math.max(0, window.innerHeight - rect.height)
        );
        wrap.style.left = `${x}px`;
        wrap.style.top = `${y}px`;
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        saveWidgetLayout({ wrap });
      };

      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    };

    const startResize = (downEvent) => {
      if (downEvent.button !== 0) return;
      downEvent.preventDefault();
      downEvent.stopPropagation();

      const rect = wrap.getBoundingClientRect();
      const startX = downEvent.clientX;
      const startY = downEvent.clientY;
      const startW = rect.width;
      const startH = rect.height;

      const onMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        const w = Math.min(Math.max(320, startW + dx), window.innerWidth - rect.left - 8);
        const h = Math.min(Math.max(240, startH + dy), window.innerHeight - rect.top - 8);
        wrap.style.width = `${w}px`;
        wrap.style.height = `${h}px`;
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        saveWidgetLayout({ wrap });
      };

      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    };

    header.addEventListener("mousedown", startDrag);
    resizer.addEventListener("mousedown", startResize);

    const startNewsDrag = (downEvent) => {
      if (downEvent.button !== 0) return;
      if (downEvent.target?.closest?.("button,a,input,select,textarea")) return;
      downEvent.preventDefault();
      downEvent.stopPropagation();

      newsWrap.dataset.interacting = "1";
      const rect = newsWrap.getBoundingClientRect();
      const startX = downEvent.clientX;
      const startY = downEvent.clientY;
      const offsetX = startX - rect.left;
      const offsetY = startY - rect.top;

      newsWrap.style.right = "auto";
      newsWrap.style.left = `${rect.left}px`;
      newsWrap.style.top = `${rect.top}px`;

      const onMove = (moveEvent) => {
        const x = Math.min(
          Math.max(0, moveEvent.clientX - offsetX),
          Math.max(0, window.innerWidth - rect.width)
        );
        const y = Math.min(
          Math.max(0, moveEvent.clientY - offsetY),
          Math.max(0, window.innerHeight - rect.height)
        );
        newsWrap.style.left = `${x}px`;
        newsWrap.style.top = `${y}px`;
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        delete newsWrap.dataset.interacting;
        saveNewsLayout({ newsWrap });
      };

      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    };

    const startNewsResize = (downEvent) => {
      if (downEvent.button !== 0) return;
      downEvent.preventDefault();
      downEvent.stopPropagation();

      newsWrap.dataset.interacting = "1";
      const rect = newsWrap.getBoundingClientRect();
      const startX = downEvent.clientX;
      const startY = downEvent.clientY;
      const startW = rect.width;
      const startH = rect.height;

      const onMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        const w = Math.min(Math.max(260, startW + dx), window.innerWidth - rect.left - 8);
        const h = Math.min(Math.max(180, startH + dy), window.innerHeight - rect.top - 8);
        newsWrap.style.width = `${w}px`;
        newsWrap.style.height = `${h}px`;
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        delete newsWrap.dataset.interacting;
        saveNewsLayout({ newsWrap });
      };

      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    };

    newsHeader?.addEventListener("mousedown", startNewsDrag);
    newsResizer?.addEventListener("mousedown", startNewsResize);

    applyNewsLayout({ wrap, newsWrap }, currentCfg);

    const mount = document.body || document.documentElement;
    mount.appendChild(root);
    return { root, shadow, wrap, newsWrap };
  }

  function setVisible(ui, visible) {
    ui.wrap.style.display = visible ? "" : "none";
  }

  function installRouteWatcher(ui) {
    const apply = () => setVisible(ui, isLegendRoute());
    const wrapHistory = (name) => {
      const orig = history[name];
      history[name] = function (...args) {
        const out = orig.apply(this, args);
        try {
          window.dispatchEvent(new Event("rhwidget:route"));
        } catch {
          // ignore
        }
        return out;
      };
    };
    wrapHistory("pushState");
    wrapHistory("replaceState");
    window.addEventListener("popstate", apply);
    window.addEventListener("rhwidget:route", apply);
    setInterval(apply, 1000);
    apply();
  }

  function applyWidgetLayout(ui, cfg) {
    const wrap = ui.wrap;
    const pos = cfg?.widgetPos;
    const size = cfg?.widgetSize;
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      wrap.style.right = "auto";
      wrap.style.left = `${Math.max(0, Math.round(pos.left))}px`;
      wrap.style.top = `${Math.max(0, Math.round(pos.top))}px`;
    }
    if (size && Number.isFinite(size.width) && Number.isFinite(size.height)) {
      wrap.style.width = `${Math.max(240, Math.round(size.width))}px`;
      wrap.style.height = `${Math.max(200, Math.round(size.height))}px`;
    }
  }

  function saveWidgetLayout(ui) {
    const rect = ui.wrap.getBoundingClientRect();
    const pos = { left: Math.round(rect.left), top: Math.round(rect.top) };
    const size = { width: Math.round(rect.width), height: Math.round(rect.height) };
    chrome.storage.local.set({ widgetPos: pos, widgetSize: size });
    currentCfg.widgetPos = pos;
    currentCfg.widgetSize = size;
  }

  function applyNewsLayout(ui, cfg) {
    const wrap = ui.newsWrap;
    if (!wrap) return;
    if (wrap.dataset?.interacting === "1") return;

    const pos = cfg?.newsPos;
    const size = cfg?.newsSize;

    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      wrap.style.right = "auto";
      wrap.style.left = `${Math.max(0, Math.round(pos.left))}px`;
      wrap.style.top = `${Math.max(0, Math.round(pos.top))}px`;
    } else if (wrap.dataset?.defaultPlaced !== "1") {
      try {
        const mainRect = ui.wrap.getBoundingClientRect();
        wrap.style.right = "auto";
        wrap.style.left = `${Math.max(0, Math.round(mainRect.left))}px`;
        wrap.style.top = `${Math.max(0, Math.round(mainRect.top + mainRect.height + 12))}px`;
      } catch {
        // ignore
      }
      wrap.dataset.defaultPlaced = "1";
    }

    if (size && Number.isFinite(size.width) && Number.isFinite(size.height)) {
      wrap.style.width = `${Math.max(260, Math.round(size.width))}px`;
      wrap.style.height = `${Math.max(180, Math.round(size.height))}px`;
    } else if (wrap.dataset?.defaultSized !== "1") {
      wrap.style.width = "420px";
      wrap.style.height = "320px";
      wrap.dataset.defaultSized = "1";
    }
  }

  function saveNewsLayout(ui) {
    const wrap = ui.newsWrap;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const pos = { left: Math.round(rect.left), top: Math.round(rect.top) };
    const size = { width: Math.round(rect.width), height: Math.round(rect.height) };
    chrome.storage.local.set({ newsPos: pos, newsSize: size });
    currentCfg.newsPos = pos;
    currentCfg.newsSize = size;
  }

  function setNewsVisible(ui, visible) {
    const wrap = ui.newsWrap;
    if (!wrap) return;
    wrap.classList.toggle("hidden", !visible);
    chrome.storage.local.set({ newsVisible: !!visible });
    currentCfg.newsVisible = !!visible;
  }

  function applyNewsVisible(ui, visible) {
    const wrap = ui.newsWrap;
    if (!wrap) return;
    wrap.classList.toggle("hidden", !visible);
  }

  function normalizeOrderType(value) {
    return String(value || "").toLowerCase() === "limit" ? "limit" : "market";
  }

  function normalizeBuyQtyMode(value) {
    return String(value || "").toLowerCase() === "dollars" ? "dollars" : "shares";
  }

  function getUiActiveElement(wrap) {
    try {
      const root = wrap?.getRootNode?.();
      if (root && root.activeElement) return root.activeElement;
    } catch {
      // ignore
    }
    return document.activeElement;
  }

  function applyQtyInputMode(input, mode) {
    if (!input) return;
    if (mode === "dollars") {
      input.min = "0.01";
      input.step = "0.01";
    } else {
      input.min = "1";
      input.step = "1";
    }
  }

  function applyTradeUi(ui, cfg) {
    const wrap = ui.wrap;
    const orderType = normalizeOrderType(cfg.orderType);
    const buttons = wrap.querySelectorAll(".order-type .toggle-btn");
    buttons.forEach((btn) => {
      const val = btn.getAttribute("data-value");
      if (val === orderType) btn.classList.add("active");
      else btn.classList.remove("active");
    });
    const buyQtyMode = normalizeBuyQtyMode(cfg.buyQtyMode);
    const modeButtons = wrap.querySelectorAll(".qty-mode .toggle-btn");
    modeButtons.forEach((btn) => {
      const val = normalizeBuyQtyMode(btn.getAttribute("data-value"));
      if (val === buyQtyMode) btn.classList.add("active");
      else btn.classList.remove("active");
    });
    const qtyInput = wrap.querySelector(".qty-input");
    const limitInput = wrap.querySelector(".limit-input");
    const activeEl = getUiActiveElement(wrap);
    applyQtyInputMode(qtyInput, buyQtyMode);
    if (qtyInput && activeEl !== qtyInput) qtyInput.value = String(cfg.buyQty ?? 1);
    const offsetVal = cfg.limitOffset ?? cfg.limitPrice ?? "";
    if (limitInput && activeEl !== limitInput) limitInput.value = String(offsetVal);
    const limitWrap = wrap.querySelector(".limit-only");
    if (limitWrap) limitWrap.style.display = orderType === "limit" ? "" : "none";
    const autoStopBtn = wrap.querySelector(".auto-stop-btn");
    if (autoStopBtn) autoStopBtn.classList.toggle("active", !!cfg.autoStop);
  }

  function saveTradeConfig(ui) {
    const wrap = ui.wrap;
    const activeBtn = wrap.querySelector(".order-type .toggle-btn.active");
    const orderType = normalizeOrderType(activeBtn?.getAttribute("data-value"));
    const modeBtn = wrap.querySelector(".qty-mode .toggle-btn.active");
    const buyQtyMode = normalizeBuyQtyMode(modeBtn?.getAttribute("data-value"));
    const autoStopBtn = wrap.querySelector(".auto-stop-btn");
    const autoStop = !!autoStopBtn?.classList?.contains("active");
    const qtyInput = wrap.querySelector(".qty-input");
    const limitInput = wrap.querySelector(".limit-input");
    let buyQtyRaw = Number(qtyInput?.value || 1);
    if (!Number.isFinite(buyQtyRaw)) buyQtyRaw = 1;
    const buyQty =
      buyQtyMode === "dollars"
        ? Math.max(0.01, Math.round(buyQtyRaw * 100) / 100)
        : Math.max(1, Math.floor(buyQtyRaw));
    const limitOffset = String(limitInput?.value || "").trim();
    chrome.storage.local.set({ orderType, buyQtyMode, buyQty, limitOffset, autoStop });
    currentCfg.orderType = orderType;
    currentCfg.buyQtyMode = buyQtyMode;
    currentCfg.buyQty = buyQty;
    currentCfg.limitOffset = limitOffset;
    currentCfg.autoStop = autoStop;
    applyTradeUi(ui, currentCfg);
  }

  function setAuthModal(ui, visible, message) {
    const modal = ui.wrap.querySelector(".auth-modal");
    const status = ui.wrap.querySelector(".auth-status");
    if (!modal) return;
    modal.classList.toggle("hidden", !visible);
    if (status) status.textContent = message || "";
  }

  function setLoginButtonState(ui, state) {
    const btn = ui.wrap.querySelector(".login-btn");
    if (!btn) return;
    btn.classList.remove("ok", "pending", "error", "mfa");
    if (state) btn.classList.add(state);
  }

  async function loadConfig() {
    return await chrome.storage.local.get({ ...DEFAULTS, symbolSelector: "" });
  }

  function setStatus(ui, kind, text) {
    const dot = ui.wrap.querySelector(".status-inline .dot") || ui.wrap.querySelector(".dot");
    const label = ui.wrap.querySelector(".status-inline .text") || ui.wrap.querySelector(".status .text");
    ui.wrap.dataset.status = kind;
    dot.className = `dot ${kind}`;
    label.textContent = text;
  }

  function setTradeStatus(ui, kind, text) {
    const dot = ui.wrap.querySelector(".trade-status .dot");
    const label = ui.wrap.querySelector(".trade-status .text");
    if (!dot || !label) return;
    dot.className = "dot";
    if (kind) dot.classList.add(kind);
    label.textContent = text || "";
  }

  function render(ui, data, cfg) {
    const updatedAt = ui.wrap.querySelector(".updated-at");
    updatedAt.textContent = data?.updated_at ? new Date(data.updated_at).toLocaleTimeString() : "—";

    const rows = Array.isArray(data?.rows) ? data.rows : [];
    const limitedRows = cfg.limit > 0 ? rows.slice(0, cfg.limit) : rows;

    const wantedCols = [
      { label: "Symbol", key: "symbol", kind: "symbol" },
      { label: "Price", match: ["price", "last", "lastprice"], kind: "num" },
      { label: "Change(%)", match: ["change", "changepercent", "changepct", "change(%)"], kind: "signed" },
      { label: "5m", match: ["5m", "5min", "five"], kind: "signed" },
      { label: "Float", match: ["float"], kind: "text" },
      { label: "Volume", match: ["volume", "vol"], kind: "text" },
      { label: "Spr(%)", match: ["spr", "spread", "spr(%)", "spread(%)"], kind: "signed" },
      { label: "Time", match: ["time"], kind: "text" }
    ];

    const normalizeKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

    function pickValue(values, matches) {
      if (!values || typeof values !== "object") return "";
      const keys = Object.keys(values);
      const normToKey = new Map(keys.map((k) => [normalizeKey(k), k]));
      for (const m of matches) {
        const hit = normToKey.get(normalizeKey(m));
        if (hit) return values[hit] ?? "";
      }
      return "";
    }

    function parseSignedNumber(text) {
      const s = String(text || "").trim();
      if (!s) return null;
      const cleaned = s.replace(/[%,$,\s]/g, "");
      const n = Number(cleaned);
      if (Number.isFinite(n)) return n;
      return null;
    }

    const theadRow = ui.wrap.querySelector(".thead-row");
    const tbody = ui.wrap.querySelector(".tbody");
    theadRow.textContent = "";
    tbody.textContent = "";

    for (const c of wantedCols) {
      const th = document.createElement("th");
      th.textContent = c.label;
      theadRow.appendChild(th);
    }

    for (const item of limitedRows) {
      const sym = String(item?.symbol || "").trim().toUpperCase();
      const values = item?.values || {};
      if (!sym) continue;

      const tr = document.createElement("tr");

      for (const c of wantedCols) {
        const td = document.createElement("td");
        if (c.kind === "symbol") {
          const a = document.createElement("a");
          a.href = "#";
          a.textContent = sym;
          // Prevent Robinhood "outside click" handlers from closing the search UI mid-activation.
          a.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation?.();
          });
          a.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation?.();
            const ok = await activateSymbol(sym);
            ui.wrap.querySelectorAll("a.active").forEach((el) => el.classList.remove("active"));
            a.classList.add("active");
            setStatus(ui, ok ? "ok" : "warn", ok ? `activated ${sym}` : `copied ${sym}`);
            await sleep(600);
            setStatus(ui, "ok", "live");
          });
          td.appendChild(a);
        } else {
          const raw = pickValue(values, c.match || []);
          td.textContent = raw || "";
          if (c.kind === "signed") {
            const n = parseSignedNumber(raw);
            if (n != null) td.dataset.signed = n > 0 ? "pos" : n < 0 ? "neg" : "zero";
          }
        }
        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }
  }

  function isEditableTarget(target) {
    if (!target) return false;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
    if (target instanceof HTMLElement && target.isContentEditable) return true;
    return false;
  }

  function matchesHotkey(e, spec) {
    if (!spec) return false;
    const key = String(e.key || "").toLowerCase();
    const code = String(e.code || "");
    const keyMatch = spec.key ? key === spec.key : false;
    const codeMatch = spec.code ? code === spec.code : false;
    if (!keyMatch && !codeMatch) return false;
    if (!!e.altKey !== !!spec.altKey) return false;
    if (!!e.shiftKey !== !!spec.shiftKey) return false;
    if (!!e.ctrlKey !== !!spec.ctrlKey) return false;
    return true;
  }

  async function executeTrade(ui, side) {
    const symbol = detectActiveSymbol(ui);
    if (!symbol) {
      setStatus(ui, "warn", "no active symbol");
      setTradeStatus(ui, "warn", "no active symbol");
      await sleep(800);
      setStatus(ui, "ok", "live");
      return;
    }
    const wrap = ui.wrap;
    const activeOrderBtn = wrap.querySelector(".order-type .toggle-btn.active");
    const orderType = normalizeOrderType(activeOrderBtn?.getAttribute("data-value") || currentCfg.orderType);
    const limitInput = wrap.querySelector(".limit-input");
    const limitOffset = String(limitInput?.value || currentCfg.limitOffset || currentCfg.limitPrice || "").trim();
    if (orderType === "limit" && !limitOffset) {
      setStatus(ui, "warn", "offset needed");
      setTradeStatus(ui, "warn", "offset needed");
      await sleep(800);
      setStatus(ui, "ok", "live");
      return;
    }
    const payload = { symbol, order_type: orderType, limit_offset: limitOffset || null };
    if (side === "buy") {
      const autoStopBtn = wrap.querySelector(".auto-stop-btn");
      payload.auto_stop = !!autoStopBtn?.classList?.contains("active");
      if (payload.auto_stop) {
        const cursorPrice = detectCursorPrice(ui);
        if (cursorPrice != null) payload.stop_ref_price = cursorPrice;
      }
      const activeModeBtn = wrap.querySelector(".qty-mode .toggle-btn.active");
      const buyQtyMode = normalizeBuyQtyMode(activeModeBtn?.getAttribute("data-value") || currentCfg.buyQtyMode);
      const qtyInput = wrap.querySelector(".qty-input");
      const raw = Number(qtyInput?.value || currentCfg.buyQty || 1);
      if (buyQtyMode === "dollars") {
        const amountUsd = Math.round((Number.isFinite(raw) ? raw : 0) * 100) / 100;
        if (amountUsd <= 0) {
          setTradeStatus(ui, "warn", "buy amount needed");
          await sleep(800);
          return;
        }
        payload.amount_usd = amountUsd;
      } else {
        const qty = Math.floor(Number.isFinite(raw) ? raw : 0);
        if (qty <= 0) {
          setTradeStatus(ui, "warn", "buy qty needed");
          await sleep(800);
          return;
        }
        payload.qty = qty;
      }
    }

    try {
      setTradeStatus(ui, "connecting", `${side} submitting`);
      const url = `${currentCfg.apiBase.replace(/\/$/, "")}/api/trade/${side}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const errText = await res.text();
        let detail = "";
        try {
          const parsed = JSON.parse(errText);
          detail = String(parsed?.detail || parsed?.error || "").trim();
        } catch {
          detail = "";
        }
        const msg = detail ? `${side} failed: ${detail}` : `${side} failed`;
        setStatus(ui, "err", msg);
        setTradeStatus(ui, "err", msg);
        console.warn("[RHWidget] trade error", errText);
      } else {
        const data = await res.json().catch(() => null);
        const order = data?.order || data?.result || null;
        const state = String(order?.state || "").trim();
        let extra = "";
        if (side === "buy") {
          const s = data?.auto_stop;
          const stopPrice = Number(s?.stop_price);
          if (s?.enabled && s?.status === "pending" && Number.isFinite(stopPrice) && stopPrice > 0) {
            extra = ` stop @ ${stopPrice.toFixed(2)}`;
          }
        }
        const msg = state ? `${side} ${state} ${symbol}${extra}` : `${side} sent ${symbol}${extra}`;
        setStatus(ui, "ok", msg);
        setTradeStatus(ui, "ok", msg);
      }
    } catch {
      setStatus(ui, "err", "trade failed");
      setTradeStatus(ui, "err", `${side} failed`);
    }
    await sleep(900);
    setStatus(ui, "ok", "live");
  }

  function installHotkeys(ui) {
    const hotkeys = {
      buy: { key: "!", code: "Digit1", altKey: false, shiftKey: true, ctrlKey: false },
      sell: { key: "@", code: "Digit2", altKey: false, shiftKey: true, ctrlKey: false }
    };
    document.addEventListener(
      "keydown",
      (e) => {
        if (!isLegendRoute()) return;
        if (ui.wrap.contains(e.target)) return;
        if (isEditableTarget(e.target)) return;
        if (matchesHotkey(e, hotkeys.buy)) {
          e.preventDefault();
          executeTrade(ui, "buy");
        } else if (matchesHotkey(e, hotkeys.sell)) {
          e.preventDefault();
          executeTrade(ui, "sell");
        }
      },
      true
    );
  }

  async function authLoop(ui) {
    while (true) {
      try {
        const url = `${currentCfg.apiBase.replace(/\/$/, "")}/api/auth/status`;
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (data?.logged_in) {
            setAuthModal(ui, false, "");
            setLoginButtonState(ui, "ok");
            loginRequested = false;
          } else if (data?.mfa_required) {
            setLoginButtonState(ui, "mfa");
            if (loginRequested) {
              const msg =
                data?.challenge_type === "prompt"
                  ? "Approve login in Robinhood app"
                  : data?.challenge_type === "sms"
                    ? "enter SMS code"
                    : data?.challenge_type === "email"
                      ? "enter email code"
                      : "enter verification code";
              setAuthModal(ui, true, msg);
            } else {
              setAuthModal(ui, false, "");
            }
          } else if (data?.status === "logging_in") {
            setLoginButtonState(ui, "pending");
          } else if (data?.status === "error") {
            setLoginButtonState(ui, "error");
          }
        }
      } catch {
        // ignore
      }
      await sleep(3000);
    }
  }

  function renderNews(ui, symbol, payload) {
    const wrap = ui.newsWrap;
    if (!wrap) return;
    const symEl = wrap.querySelector(".news-symbol");
    const statusEl = wrap.querySelector(".news-status");
    const analysisEl = wrap.querySelector(".news-analysis");
    const sentimentEl = wrap.querySelector(".news-sentiment");
    const sentimentScoreEl = wrap.querySelector(".sentiment-score");
    const sentimentLabelEl = wrap.querySelector(".sentiment-label");
    const sentimentBarFillEl = wrap.querySelector(".sentiment-bar-fill");
    const summaryEl = wrap.querySelector(".news-summary");
    const pointsEl = wrap.querySelector(".news-points");
    const listEl = wrap.querySelector(".news-list");
    if (symEl) symEl.textContent = symbol || "-";
    if (!statusEl || !listEl) return;

    const ok = !!payload?.ok;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const err = String(payload?.error || payload?.detail || "").trim();
    const lookbackH = Number(payload?.lookback_hours);
    const analysis = payload?.analysis && typeof payload.analysis === "object" ? payload.analysis : null;

    if (analysisEl) analysisEl.classList.add("hidden");
    if (sentimentScoreEl) sentimentScoreEl.textContent = "--";
    if (sentimentLabelEl) sentimentLabelEl.textContent = "";
    if (sentimentBarFillEl) {
      sentimentBarFillEl.style.width = "0%";
      sentimentBarFillEl.style.background = "";
    }
    if (summaryEl) summaryEl.textContent = "";
    if (pointsEl) pointsEl.textContent = "";

    listEl.textContent = "";
    if (!symbol || symbol === "-" || symbol === "—") {
      statusEl.textContent = "select a ticker…";
      return;
    }
    if (!ok) {
      statusEl.textContent = err ? `error: ${err}` : "error loading news";
      return;
    }
    if (!items.length) {
      statusEl.textContent = "no headlines";
      return;
    }
    statusEl.textContent = "";

    if (analysis && analysisEl && sentimentEl && summaryEl && pointsEl) {
      const aErr = String(analysis?.error || "").trim();
      if (!aErr) {
        const score = Number(analysis?.sentiment_score);
        const label = String(analysis?.sentiment_label || "").trim();
        const scoreInt = Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null;
        const scoreText = scoreInt == null ? "?" : String(scoreInt);
        const lbText = Number.isFinite(lookbackH) && lookbackH > 0 ? ` · last ${lookbackH}h` : "";
        const hue = scoreInt == null ? 0 : Math.round((scoreInt / 100) * 120); // 0=red, 120=green
        const color = `hsl(${hue} 92% 55%)`;
        if (sentimentScoreEl) {
          sentimentScoreEl.textContent = scoreText;
          sentimentScoreEl.style.color = color;
        }
        if (sentimentLabelEl) {
          sentimentLabelEl.textContent = `${label || "neutral"}${lbText}`;
          sentimentLabelEl.style.color = "rgba(255, 255, 255, 0.82)";
        }
        if (sentimentBarFillEl && scoreInt != null) {
          sentimentBarFillEl.style.width = `${scoreInt}%`;
          sentimentBarFillEl.style.background = color;
        }
        summaryEl.textContent = String(analysis?.summary || "").trim();
        const points = Array.isArray(analysis?.key_points) ? analysis.key_points : [];
        for (const p of points.slice(0, 6)) {
          const li = document.createElement("li");
          li.textContent = String(p || "").trim();
          if (li.textContent) pointsEl.appendChild(li);
        }
        analysisEl.classList.remove("hidden");
      } else {
        statusEl.textContent = `analysis error: ${aErr}`;
      }
    }
    for (const item of items.slice(0, 20)) {
      const title = String(item?.title || "").trim();
      const link = String(item?.link || "").trim();
      const source = String(item?.source || "").trim();
      const pub = String(item?.created_at || item?.pub_date || "").trim();
      if (!title || !link) continue;

      const row = document.createElement("div");
      row.className = "news-item";

      const a = document.createElement("a");
      a.className = "news-link";
      a.href = link;
      a.target = "_blank";
      a.rel = "noreferrer noopener";
      a.textContent = title;
      row.appendChild(a);

      const meta = [source, pub].filter(Boolean).join(" · ");
      if (meta) {
        const metaEl = document.createElement("div");
        metaEl.className = "news-meta";
        metaEl.textContent = meta;
        row.appendChild(metaEl);
      }

      listEl.appendChild(row);
    }
  }

  async function newsLoop(ui) {
    let prevSymbol = "";
    let lastFetchMs = 0;
    let forceRefresh = false;
    let inFlight = false;

    window.addEventListener("rhwidget:news-refresh", () => {
      forceRefresh = true;
    });

    while (true) {
      const visible = !!currentCfg.newsVisible && isLegendRoute() && !ui.newsWrap?.classList.contains("hidden");
      if (!visible) {
        await sleep(700);
        continue;
      }

      const symbol = detectActiveSymbol(ui) || "";
      const now = Date.now();
      const shouldFetch =
        forceRefresh || (symbol && symbol !== prevSymbol) || (symbol && now - lastFetchMs > 45_000);

      if (!symbol) {
        renderNews(ui, "-", { ok: true, items: [] });
        prevSymbol = "";
        await sleep(700);
        continue;
      }

      if (shouldFetch && !inFlight) {
        forceRefresh = false;
        prevSymbol = symbol;
        lastFetchMs = now;
        inFlight = true;
        const statusEl = ui.newsWrap?.querySelector?.(".news-status");
        if (statusEl) statusEl.textContent = "loading…";
        const url = `${currentCfg.apiBase.replace(/\/$/, "")}/api/news?symbol=${encodeURIComponent(symbol)}`;
        try {
          const res = await fetch(url, { cache: "no-store" });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            const detail = String(data?.detail || data?.error || "request_failed").trim();
            renderNews(ui, symbol, { ok: false, items: [], error: detail });
          } else {
            renderNews(ui, symbol, data);
          }
        } catch {
          renderNews(ui, symbol, { ok: false, items: [], error: "bridge/news offline" });
        } finally {
          inFlight = false;
        }
      }

      await sleep(650);
    }
  }

  async function initConfig(ui) {
    const cfg = await loadConfig();
    currentCfg = { ...DEFAULTS, ...cfg };
    applyWidgetLayout(ui, currentCfg);
    applyTradeUi(ui, currentCfg);
    applyNewsLayout(ui, currentCfg);
    applyNewsVisible(ui, !!currentCfg.newsVisible);
  }

  async function pollLoop(ui) {
    while (true) {
      if (!isLegendRoute()) {
        setStatus(ui, "ok", "idle");
        await sleep(1000);
        continue;
      }
      const cfg = await loadConfig();
      currentCfg = { ...DEFAULTS, ...cfg };
      applyTradeUi(ui, currentCfg);
      applyNewsLayout(ui, currentCfg);
      applyNewsVisible(ui, !!currentCfg.newsVisible);
      if (!currentCfg.symbolClickSelector && cfg.symbolSelector) currentCfg.symbolClickSelector = cfg.symbolSelector;
      if (!currentCfg.symbolTypeSelector && cfg.symbolSelector) currentCfg.symbolTypeSelector = cfg.symbolSelector;
      const url = `${cfg.apiBase.replace(/\/$/, "")}/api/tickers`;
      try {
        setStatus(ui, "connecting", "fetching…");
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        render(ui, data, cfg);
        if (data?.error) setStatus(ui, "warn", "scrape error");
        else setStatus(ui, "ok", "live");
      } catch (err) {
        setStatus(ui, "err", "bridge offline");
      }
      await sleep(Math.max(500, Number(cfg.pollMs) || DEFAULTS.pollMs));
    }
  }

  const ui = buildUi();
  window.addEventListener(
    "message",
    (e) => {
      const data = e?.data;
      if (!data || data.__rhwidget !== true || data.type !== "cursor_price") return;
      const price = Number(data.price);
      if (!Number.isFinite(price) || price <= 0) return;
      lastFrameCursorPrice = price;
      lastFrameCursorTs = Date.now();
    },
    true
  );
  document.addEventListener(
    "mousemove",
    (e) => {
      if (ui?.wrap?.contains?.(e.target)) return;
      lastMousePos = { x: e.clientX, y: e.clientY };
    },
    true
  );
  initConfig(ui);
  installRouteWatcher(ui);
  installHotkeys(ui);
  activeSymbolLoop(ui);
  cursorPriceLoop(ui);
  authLoop(ui);
  newsLoop(ui);
  pollLoop(ui);
})();

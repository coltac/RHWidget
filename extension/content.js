(() => {
  const WIDGET_ID = "rh-momo-widget-root";
  if (window.top !== window) return;
  if (document.getElementById(WIDGET_ID)) return;

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
    orderType: "market",
    buyQty: 1,
    limitOffset: ""
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

  function setActiveSymbol(ui, symbol) {
    const el = ui.wrap.querySelector(".active-symbol");
    if (!el) return;
    el.textContent = symbol || "—";
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
        <div class="active">Active: <span class="active-symbol">—</span></div>
        <div class="right">
          <button class="icon-btn bind-btn" title="Bind symbol input" type="button">B</button>
          <button class="icon-btn train-btn" title="Train active-symbol region" type="button">T</button>
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
        <div class="field">
          <label>Qty</label>
          <input class="qty-input" type="number" min="1" step="1" />
        </div>
        <div class="field limit-only">
          <label>Offset</label>
          <input class="limit-input" type="number" step="0.01" />
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

    shadow.appendChild(style);
    shadow.appendChild(wrap);

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

    const orderButtons = wrap.querySelectorAll(".order-type .toggle-btn");
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

    const mount = document.body || document.documentElement;
    mount.appendChild(root);
    return { root, shadow, wrap };
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

  function normalizeOrderType(value) {
    return String(value || "").toLowerCase() === "limit" ? "limit" : "market";
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
    const qtyInput = wrap.querySelector(".qty-input");
    const limitInput = wrap.querySelector(".limit-input");
    if (qtyInput) qtyInput.value = String(cfg.buyQty ?? 1);
    const offsetVal = cfg.limitOffset ?? cfg.limitPrice ?? "";
    if (limitInput) limitInput.value = String(offsetVal);
    const limitWrap = wrap.querySelector(".limit-only");
    if (limitWrap) limitWrap.style.display = orderType === "limit" ? "" : "none";
  }

  function saveTradeConfig(ui) {
    const wrap = ui.wrap;
    const activeBtn = wrap.querySelector(".order-type .toggle-btn.active");
    const orderType = normalizeOrderType(activeBtn?.getAttribute("data-value"));
    const qtyInput = wrap.querySelector(".qty-input");
    const limitInput = wrap.querySelector(".limit-input");
    const buyQty = Math.max(1, Number(qtyInput?.value || 1));
    const limitOffset = String(limitInput?.value || "").trim();
    chrome.storage.local.set({ orderType, buyQty, limitOffset });
    currentCfg.orderType = orderType;
    currentCfg.buyQty = buyQty;
    currentCfg.limitOffset = limitOffset;
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
      await sleep(800);
      setStatus(ui, "ok", "live");
      return;
    }
    const orderType = normalizeOrderType(currentCfg.orderType);
    const limitOffset = String(currentCfg.limitOffset || currentCfg.limitPrice || "").trim();
    if (orderType === "limit" && !limitOffset) {
      setStatus(ui, "warn", "offset needed");
      await sleep(800);
      setStatus(ui, "ok", "live");
      return;
    }
    const payload = { symbol, order_type: orderType, limit_offset: limitOffset || null };
    if (side === "buy") payload.qty = Number(currentCfg.buyQty || 1);

    try {
      const url = `${currentCfg.apiBase.replace(/\/$/, "")}/api/trade/${side}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.text();
        setStatus(ui, "err", `${side} failed`);
        console.warn("[RHWidget] trade error", err);
      } else {
        setStatus(ui, "ok", `${side} sent ${symbol}`);
      }
    } catch {
      setStatus(ui, "err", "trade failed");
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

  async function initConfig(ui) {
    const cfg = await loadConfig();
    currentCfg = { ...DEFAULTS, ...cfg };
    applyWidgetLayout(ui, currentCfg);
    applyTradeUi(ui, currentCfg);
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
  initConfig(ui);
  installRouteWatcher(ui);
  installHotkeys(ui);
  activeSymbolLoop(ui);
  authLoop(ui);
  pollLoop(ui);
})();

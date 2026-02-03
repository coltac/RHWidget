const DEFAULTS = {
  apiBase: "http://127.0.0.1:8787",
  pollMs: 2000,
  limit: 30,
  fontFamily: "system",
  fontSize: 12
};

async function load() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  document.getElementById("apiBase").value = cfg.apiBase;
  document.getElementById("pollMs").value = cfg.pollMs;
  document.getElementById("limit").value = cfg.limit;
  document.getElementById("fontFamily").value = cfg.fontFamily;
  document.getElementById("fontSize").value = cfg.fontSize;
}

function setStatus(text) {
  const el = document.getElementById("status");
  el.textContent = text;
  if (text) setTimeout(() => (el.textContent = ""), 1200);
}

async function save(cfg) {
  await chrome.storage.local.set(cfg);
  setStatus("Saved.");
}

document.getElementById("save").addEventListener("click", async () => {
  const apiBase = document.getElementById("apiBase").value.trim() || DEFAULTS.apiBase;
  const pollMs = Math.max(500, Number(document.getElementById("pollMs").value) || DEFAULTS.pollMs);
  const limit = Math.max(0, Number(document.getElementById("limit").value) || DEFAULTS.limit);
  const fontFamily = String(document.getElementById("fontFamily").value || DEFAULTS.fontFamily).trim();
  const fontSizeRaw = Number(document.getElementById("fontSize").value);
  const fontSize = Number.isFinite(fontSizeRaw) ? Math.max(9, Math.min(22, Math.round(fontSizeRaw))) : DEFAULTS.fontSize;
  await save({ apiBase, pollMs, limit, fontFamily, fontSize });
});

document.getElementById("reset").addEventListener("click", async () => {
  await save(DEFAULTS);
  await load();
});

load();

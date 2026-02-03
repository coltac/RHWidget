chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "rhwidget_open_options") {
    (async () => {
      try {
        if (chrome.runtime?.openOptionsPage) {
          await chrome.runtime.openOptionsPage();
        } else {
          await chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
        }
        sendResponse?.({ ok: true });
      } catch (e) {
        try {
          await chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
          sendResponse?.({ ok: true, fallback: true });
        } catch (e2) {
          sendResponse?.({ ok: false, error: String(e2?.message || e2 || e?.message || e) });
        }
      }
    })();
    return true;
  }

  if (!msg || msg.type !== "rhwidget_inject_cursor") return;

  const tabId = sender?.tab?.id;
  if (tabId == null) {
    sendResponse?.({ ok: false, error: "missing_sender" });
    return;
  }

  (async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        files: ["injected_cursor.js"]
      });
      sendResponse?.({ ok: true });
    } catch (e) {
      sendResponse?.({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true;
});

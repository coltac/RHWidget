chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "rhwidget_inject_cursor") return;

  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  if (tabId == null || frameId == null) {
    sendResponse?.({ ok: false, error: "missing_sender" });
    return;
  }

  (async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
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


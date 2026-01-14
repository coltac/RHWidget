# RHWidget (Momo x Robinhood Legend)

This repo contains:

- `momo_screener.py`: Playwright scraper/watcher for `momoscreener.com/scanner`
- `momo_bridge_server.py`: local HTTP API that keeps the latest screener rows in memory
- `extension/`: Chrome extension that injects a small widget into Robinhood Legend and lets you click tickers

## 1) Install prerequisites

```powershell
cd c:\Users\GamingPC\Desktop\RHWidget
python -m pip install -r requirements.txt
python -m playwright install chromium
```

## 2) Run the local bridge server

```powershell
python momo_bridge_server.py
```

Optional (show the browser window for debugging):

```powershell
python momo_bridge_server.py --headful
```

The API will be available at `http://127.0.0.1:8787/api/tickers`.

## 3) Load the extension (Chrome)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder

## 4) Use it on Robinhood Legend

Open Robinhood Legend. A "Momo Screener" panel appears on the right.

- It polls the bridge server and updates the ticker list.
- Clicking a ticker tries to activate it in Legend by finding a search/symbol input and typing + pressing Enter.
- If it can't find the input, it copies the ticker to your clipboard as a fallback.

### Training buttons

The widget header has two small training buttons:

- **B (Bind symbol input):** click this, then click the Legend symbol/search input. This teaches the widget where to click and type when you click a ticker.
- **T (Train active symbol):** click this, then drag a box around the on-screen symbol/ticker that represents the current active chart. This lets hotkeys (buy/sell) know which symbol is active.

Press `Esc` to cancel a training mode.

Extension settings are in the extension's Options page (server URL, poll interval, max tickers).

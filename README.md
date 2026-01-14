# RHWidget (Momo x Robinhood Legend)
Trading on Robinhood Legend is such a crotch punch due to the slow UI, no hotkeys, no way to autoadd symbols. This extension sniffs momoscreener.com/scanner live, and populates the hot stuff there. Ive created a simple widget with a backend that accomplishes these things.  One trick that i like to do is when i train the button locations with the widget, i bind the 'B' Button to the "+ Add" location on the watchlist for Robinhood legends.  Then when you click that ticker, its auto added to the watchlist.  Clicking it again will simply make it active in the Legends App.  If you set your RH_Login info in the .env, then it will be able to submit buys and sells with Shift + 1 (Buy), and Shift + 2 (Sell).  There is also an offset setting if you have the Limit order toggle set to limit.  The API used is robin_stocks, which works for now.  Its not lightning fast, but on my Starlink connection, most orders are completed in less than 900MS.  Good enough for me at this point.  I built this just to help with the drag of Legends, and not wanting to switch to a different broker with a better trading GUI.  Use at your own risk obviously, but in my testing, it works fine.  Its probably buggy, slow, and all of those things, but its been helping me a lot.  I can day trade on Legends with this finally.  Thank you for looking.

<img width="1280" height="696" alt="Capture" src="https://github.com/user-attachments/assets/9bd6e231-c6a9-4b99-8429-492fc4ca3c54" />

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

### Hotkeys

- **Buy:** `Shift+1`
- **Sell:** `Shift+2`

Hotkeys only fire while you are on the Legend page and not typing in an input field.

### Market vs Limit orders

- **Market:** sends a market order immediately.
- **Limit:** uses the offset box in the widget.
  - **Buy limit:** `last price + offset`
  - **Sell limit:** `last price - offset`

Buy orders use the **Qty** field. Sell orders use your full open position for the active symbol.

Extension settings are in the extension's Options page (server URL, poll interval, max tickers).

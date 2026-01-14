from __future__ import annotations

import argparse
import asyncio
import json
import re
from dataclasses import dataclass
from hashlib import blake2b
from typing import AsyncIterator, Iterable, List, Optional, Sequence


DEFAULT_URL = "https://momoscreener.com/scanner"
DEFAULT_TBODY_XPATH = "/html/body/div/div/div[2]/div/div[2]/div/div[2]/div/table/tbody"

_SYMBOL_PREFIX_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-]*")
_STAR_CHARS = {
    "⭐",
    "★",
    "☆",
    "✪",
    "✩",
    "✫",
    "✬",
    "✭",
    "✮",
    "✯",
    "✰",
    "✨",
}


@dataclass(frozen=True)
class Row:
    symbol: str
    values: dict[str, str]


def _normalize_headers(raw_headers: List[str], column_count: int) -> List[str]:
    headers = [h.strip() for h in raw_headers if h is not None]
    headers = [h if h else f"col_{i + 1}" for i, h in enumerate(headers)]
    if len(headers) < column_count:
        headers.extend([f"col_{i + 1}" for i in range(len(headers), column_count)])
    return headers[:column_count]


def _try_parse_float(text: str) -> float | None:
    s = str(text or "").strip()
    if not s:
        return None
    s = s.replace("$", "").replace(",", "")
    s = s.replace("%", "")
    try:
        return float(s)
    except ValueError:
        return None


_COMPACT_RE = re.compile(r"^\s*\$?\s*([0-9]*\.?[0-9]+)\s*([KMBT])?\s*$", re.IGNORECASE)


def parse_compact_number(text: str) -> float | None:
    s = str(text or "").strip()
    if not s or s in {"-", "—", "N/A"}:
        return None
    s = s.replace(",", "")
    m = _COMPACT_RE.match(s)
    if not m:
        return _try_parse_float(s)
    base = float(m.group(1))
    suffix = (m.group(2) or "").upper()
    mult = 1.0
    if suffix == "K":
        mult = 1_000.0
    elif suffix == "M":
        mult = 1_000_000.0
    elif suffix == "B":
        mult = 1_000_000_000.0
    elif suffix == "T":
        mult = 1_000_000_000_000.0
    return base * mult


def parse_millions(text: str) -> float | None:
    n = parse_compact_number(text)
    if n is None:
        return None
    return float(n) / 1_000_000.0


def parse_percent(text: str) -> float | None:
    return _try_parse_float(text)


def _hash_rows(rows: Sequence[Row]) -> str:
    parts: list[str] = []
    for r in rows:
        # Keep stable ordering within each row by sorting keys.
        kv = "|".join(f"{k}={r.values.get(k,'')}" for k in sorted(r.values.keys()))
        parts.append(f"{r.symbol}:{kv}")
    h = blake2b(digest_size=16)
    h.update("\n".join(parts).encode("utf-8", errors="ignore"))
    return h.hexdigest()


def normalize_symbol(raw: str) -> str:
    s = str(raw or "").strip()
    if not s:
        return ""
    for ch in _STAR_CHARS:
        s = s.replace(ch, "")
    s = s.replace("\uFE0F", "")  # emoji variation selector
    s = s.strip().upper()
    # MOMO sometimes appends tags like "(HOD)" or other decorations. Keep only the leading ticker token.
    m = _SYMBOL_PREFIX_RE.match(s)
    return m.group(0) if m else ""


async def _iter_table_rows_from_tbody(tbody_locator) -> AsyncIterator:
    row_locators = tbody_locator.locator("tr")
    count = await row_locators.count()
    for i in range(count):
        yield row_locators.nth(i)


async def scrape_scanner(
    *,
    url: str,
    tbody_xpath: str,
    timeout_ms: int,
    headless: bool,
) -> tuple[List[str], List[Row]]:
    try:
        from playwright.async_api import TimeoutError as PlaywrightTimeoutError
        from playwright.async_api import async_playwright
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(
            "Playwright is required. Install with:\n"
            "  python -m pip install playwright\n"
            "  python -m playwright install chromium\n"
        ) from exc

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=headless)
        context = await browser.new_context()
        page = await context.new_page()

        await page.goto(url, wait_until="domcontentloaded")

        tbody = page.locator(f"xpath={tbody_xpath}")
        try:
            await tbody.wait_for(state="visible", timeout=timeout_ms)
        except PlaywrightTimeoutError:
            fallback = page.locator("table tbody").filter(has=page.locator("tr")).first
            if await fallback.count() == 0:
                raise RuntimeError(f"Could not find table body at XPath: {tbody_xpath}")
            tbody = fallback

        table = tbody.locator("xpath=ancestor::table[1]")
        raw_headers = await table.locator("thead tr th").all_text_contents()

        rows: List[Row] = []
        async for row in _iter_table_rows_from_tbody(tbody):
            cells = [c.strip() for c in await row.locator("td").all_text_contents()]
            if not cells:
                continue
            headers = _normalize_headers(raw_headers, len(cells))
            values = {headers[i]: cells[i] for i in range(len(cells))}
            symbol = normalize_symbol(values.get("Symbol") or values.get("symbol") or cells[0])
            rows.append(Row(symbol=symbol, values=values))

        await browser.close()

    headers = _normalize_headers(raw_headers, max((len(r.values) for r in rows), default=0))
    return headers, rows


class MomoScreenerWatcher:
    def __init__(
        self,
        *,
        url: str = DEFAULT_URL,
        tbody_xpath: str = DEFAULT_TBODY_XPATH,
        timeout_ms: int = 30_000,
        headless: bool = True,
        poll_ms: int = 2_000,
        stable_ms: int = 750,
    ) -> None:
        self._url = url
        self._tbody_xpath = tbody_xpath
        self._timeout_ms = timeout_ms
        self._headless = headless
        self._poll_ms = poll_ms
        self._stable_ms = stable_ms

        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None
        self._tbody = None

    async def __aenter__(self) -> "MomoScreenerWatcher":
        try:
            from playwright.async_api import TimeoutError as PlaywrightTimeoutError
            from playwright.async_api import async_playwright
        except Exception as exc:  # pragma: no cover
            raise RuntimeError(
                "Playwright is required. Install with:\n"
                "  python -m pip install playwright\n"
                "  python -m playwright install chromium\n"
            ) from exc

        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(headless=self._headless)
        self._context = await self._browser.new_context()
        self._page = await self._context.new_page()
        await self._page.goto(self._url, wait_until="domcontentloaded")

        tbody = self._page.locator(f"xpath={self._tbody_xpath}")
        try:
            await tbody.wait_for(state="visible", timeout=self._timeout_ms)
        except PlaywrightTimeoutError:
            fallback = self._page.locator("table tbody").filter(has=self._page.locator("tr")).first
            if await fallback.count() == 0:
                raise RuntimeError(f"Could not find table body at XPath: {self._tbody_xpath}")
            tbody = fallback
        self._tbody = tbody
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        # Close in reverse order; tolerate partial initialization.
        if self._browser is not None:
            try:
                await self._browser.close()
            except Exception:
                pass
        if self._playwright is not None:
            try:
                await self._playwright.stop()
            except Exception:
                pass

        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None
        self._tbody = None

    async def snapshot(self) -> tuple[list[str], list[Row]]:
        if self._tbody is None or self._page is None:
            raise RuntimeError("Watcher is not started; use 'async with MomoScreenerWatcher(...)'.")
        table = self._tbody.locator("xpath=ancestor::table[1]")
        raw_headers = await table.locator("thead tr th").all_text_contents()

        rows: List[Row] = []
        async for row in _iter_table_rows_from_tbody(self._tbody):
            cells = [c.strip() for c in await row.locator("td").all_text_contents()]
            if not cells:
                continue
            headers = _normalize_headers(raw_headers, len(cells))
            values = {headers[i]: cells[i] for i in range(len(cells))}
            symbol = normalize_symbol(values.get("Symbol") or values.get("symbol") or cells[0])
            rows.append(Row(symbol=symbol, values=values))

        headers = _normalize_headers(raw_headers, max((len(r.values) for r in rows), default=0))
        return headers, rows

    async def watch(self) -> AsyncIterator[tuple[list[str], list[Row]]]:
        prev_hash: str | None = None
        while True:
            headers, rows = await self.snapshot()
            h = _hash_rows(rows)
            if h != prev_hash:
                prev_hash = h
                if self._stable_ms > 0:
                    await asyncio.sleep(self._stable_ms / 1000.0)
                # Re-read after stability delay to reduce partial-update churn.
                headers, rows = await self.snapshot()
                prev_hash = _hash_rows(rows)
                yield headers, rows
            await asyncio.sleep(self._poll_ms / 1000.0)


def _print_rows_lines(headers: List[str], rows: List[Row]) -> None:
    if not rows:
        print("No rows found.")
        return
    for row in rows:
        parts = []
        for header in headers:
            value = row.values.get(header, "")
            parts.append(f"{header}={value}")
        print(" ".join(parts))


def _print_rows_json(rows: List[Row]) -> None:
    payload = [{"symbol": r.symbol, **r.values} for r in rows]
    print(json.dumps(payload, indent=2))


async def _amain(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Scrape the momo scanner table rows and print tickers + row data."
    )
    parser.add_argument("--url", default=DEFAULT_URL, help=f"Scanner URL (default: {DEFAULT_URL})")
    parser.add_argument(
        "--tbody-xpath",
        default=DEFAULT_TBODY_XPATH,
        help="XPath to the <tbody> you want to scrape.",
    )
    parser.add_argument(
        "--timeout-ms",
        type=int,
        default=30_000,
        help="How long to wait for the table to appear.",
    )
    parser.add_argument(
        "--headful",
        action="store_true",
        help="Run with a visible browser window (helps when debugging).",
    )
    parser.add_argument(
        "--format",
        choices=("lines", "json"),
        default="lines",
        help="Output format.",
    )
    parser.add_argument(
        "--watch",
        action="store_true",
        help="Stream updates whenever the table changes.",
    )
    args = parser.parse_args(argv)

    if args.watch:
        async with MomoScreenerWatcher(
            url=args.url,
            tbody_xpath=args.tbody_xpath,
            timeout_ms=args.timeout_ms,
            headless=not args.headful,
        ) as watcher:
            async for headers, rows in watcher.watch():
                if args.format == "json":
                    _print_rows_json(rows)
                else:
                    _print_rows_lines(headers, rows)
        return 0

    headers, rows = await scrape_scanner(
        url=args.url,
        tbody_xpath=args.tbody_xpath,
        timeout_ms=args.timeout_ms,
        headless=not args.headful,
    )

    if args.format == "json":
        _print_rows_json(rows)
    else:
        _print_rows_lines(headers, rows)
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    return asyncio.run(_amain(argv))


if __name__ == "__main__":
    raise SystemExit(main())

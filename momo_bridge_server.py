from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import pickle
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from momo_screener import DEFAULT_TBODY_XPATH, DEFAULT_URL, MomoScreenerWatcher
import robin_stocks.robinhood as rh
from robin_stocks.robinhood.authentication import generate_device_token
from robin_stocks.robinhood.helper import request_get, request_post, round_price, set_login_state, update_session
from robin_stocks.robinhood.urls import login_url, positions_url

load_dotenv()


@dataclass(frozen=True)
class BridgeConfig:
    momo_url: str
    momo_tbody_xpath: str
    momo_timeout_ms: int
    headless: bool
    poll_ms: int
    stable_ms: int
    limit: int


@dataclass(frozen=True)
class AuthConfig:
    username: str | None
    password: str | None
    auto_login_delay_s: float


class SmsCodeRequest(BaseModel):
    code: str


class BuyRequest(BaseModel):
    symbol: str
    qty: float | None = 1.0
    amount_usd: float | None = None
    auto_stop: bool | None = None
    stop_ref_price: float | None = None
    stop_price: float | None = None
    order_type: str = "market"
    limit_price: float | None = None
    limit_offset: float | None = None


class SellRequest(BaseModel):
    symbol: str
    order_type: str = "market"
    limit_price: float | None = None
    limit_offset: float | None = None


def create_app(cfg: BridgeConfig, auth_cfg: AuthConfig) -> FastAPI:
    app = FastAPI(title="RHWidget Momo Bridge", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    state_lock = asyncio.Lock()
    state: dict[str, Any] = {
        "updated_at": None,
        "headers": [],
        "rows": [],
        "symbols": [],
        "error": None,
        "source": {"url": cfg.momo_url, "tbody_xpath": cfg.momo_tbody_xpath},
    }

    auth_lock = asyncio.Lock()
    auth_state: dict[str, Any] = {
        "status": "init",
        "logged_in": False,
        "mfa_required": False,
        "error": None,
        "last_login": None,
        "workflow_id": None,
        "device_token": None,
        "machine_id": None,
        "challenge_id": None,
        "challenge_type": None,
        "challenge_status": None,
        "login_payload": None,
        "prompt_validated": False,
    }

    news_lock = asyncio.Lock()
    news_cache: dict[str, dict[str, Any]] = {}

    def build_login_payload(device_token: str) -> dict[str, Any]:
        return {
            "client_id": "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS",
            "expires_in": 86400,
            "grant_type": "password",
            "password": auth_cfg.password,
            "scope": "internal",
            "username": auth_cfg.username,
            "device_token": device_token,
            "try_passkeys": False,
            "token_request_path": "/login",
            "create_read_only_secondary_token": True,
        }

    def session_pickle_path() -> str:
        data_dir = os.path.join(os.path.expanduser("~"), ".tokens")
        os.makedirs(data_dir, exist_ok=True)
        return os.path.join(data_dir, "robinhood.pickle")

    def store_session(data: dict[str, Any], device_token: str) -> None:
        try:
            token_type = data.get("token_type")
            access_token = data.get("access_token")
            refresh_token = data.get("refresh_token")
            if not token_type or not access_token:
                return
            payload = {
                "token_type": token_type,
                "access_token": access_token,
                "refresh_token": refresh_token,
                "device_token": device_token,
            }
            with open(session_pickle_path(), "wb") as f:
                pickle.dump(payload, f)
        except Exception:
            return

    async def load_cached_session() -> bool:
        try:
            path = session_pickle_path()
            if not os.path.isfile(path):
                return False
            with open(path, "rb") as f:
                cached = pickle.load(f)
            access_token = cached.get("access_token")
            token_type = cached.get("token_type")
            device_token = cached.get("device_token")
            if not access_token or not token_type:
                return False
            update_session("Authorization", f"{token_type} {access_token}")
            set_login_state(True)
            res = await asyncio.to_thread(
                request_get, positions_url(), "pagination", {"nonzero": "true"}, False
            )
            if res is None or getattr(res, "status_code", None) != 200:
                set_login_state(False)
                update_session("Authorization", None)
                return False
            async with auth_lock:
                auth_state["status"] = "logged_in_cached"
                auth_state["logged_in"] = True
                auth_state["mfa_required"] = False
                auth_state["error"] = None
                auth_state["device_token"] = device_token
                auth_state["last_login"] = datetime.now(tz=UTC).isoformat()
            return True
        except Exception:
            set_login_state(False)
            update_session("Authorization", None)
            return False

    async def refresh_challenge() -> None:
        async with auth_lock:
            workflow_id = auth_state.get("workflow_id")
            device_token = auth_state.get("device_token")
            machine_id = auth_state.get("machine_id")
        if not workflow_id or not device_token:
            return

        if not machine_id:
            machine_payload = {"device_id": device_token, "flow": "suv", "input": {"workflow_id": workflow_id}}
            machine_data = await asyncio.to_thread(request_post, "https://api.robinhood.com/pathfinder/user_machine/", machine_payload, json=True)
            machine_id = (machine_data or {}).get("id")
            if machine_id:
                async with auth_lock:
                    auth_state["machine_id"] = machine_id
        if not machine_id:
            return

        inquiries_url = f"https://api.robinhood.com/pathfinder/inquiries/{machine_id}/user_view/"
        inquiries = await asyncio.to_thread(request_get, inquiries_url)
        challenge = (inquiries or {}).get("context", {}).get("sheriff_challenge")
        if not challenge:
            return
        async with auth_lock:
            auth_state["challenge_id"] = challenge.get("id")
            auth_state["challenge_type"] = challenge.get("type")
            auth_state["challenge_status"] = challenge.get("status")
            if auth_state["challenge_type"] == "prompt":
                auth_state["status"] = "approval_required"
                auth_state["mfa_required"] = True
            elif auth_state["challenge_type"] in ("sms", "email"):
                auth_state["status"] = "mfa_required"
                auth_state["mfa_required"] = True

        if challenge.get("type") == "prompt" and challenge.get("id"):
            prompt_url = f"https://api.robinhood.com/push/{challenge.get('id')}/get_prompts_status/"
            prompt_resp = await asyncio.to_thread(request_get, prompt_url)
            if (prompt_resp or {}).get("challenge_status") == "validated":
                inquiries_url = f"https://api.robinhood.com/pathfinder/inquiries/{machine_id}/user_view/"
                inquiries_payload = {"sequence": 0, "user_input": {"status": "continue"}}
                await asyncio.to_thread(request_post, inquiries_url, inquiries_payload, json=True)
                async with auth_lock:
                    auth_state["challenge_status"] = "validated"
                    auth_state["prompt_validated"] = True
                    auth_state["status"] = "prompt_validated"
                    auth_state["mfa_required"] = False
                    auth_state["error"] = None

    async def attempt_login(mfa_code: str | None = None) -> None:
        if not auth_cfg.username or not auth_cfg.password:
            async with auth_lock:
                auth_state["status"] = "error"
                auth_state["logged_in"] = False
                auth_state["mfa_required"] = False
                auth_state["error"] = "missing_credentials"
            return

        async with auth_lock:
            auth_state["status"] = "logging_in"
            auth_state["error"] = None

        device_token = auth_state.get("device_token") or generate_device_token()
        login_payload = auth_state.get("login_payload") or build_login_payload(device_token)
        async with auth_lock:
            auth_state["device_token"] = device_token
            auth_state["login_payload"] = login_payload

        data = await asyncio.to_thread(request_post, login_url(), login_payload)
        if data and data.get("verification_workflow"):
            workflow_id = data["verification_workflow"].get("id")
            async with auth_lock:
                auth_state["status"] = "verification_required"
                auth_state["logged_in"] = False
                auth_state["mfa_required"] = True
                auth_state["error"] = "verification_required"
                auth_state["workflow_id"] = workflow_id
            await refresh_challenge()
            return

        if data and data.get("access_token"):
            token = f"{data.get('token_type')} {data.get('access_token')}"
            update_session("Authorization", token)
            set_login_state(True)
            store_session(data, device_token)
            async with auth_lock:
                auth_state["status"] = "logged_in"
                auth_state["logged_in"] = True
                auth_state["mfa_required"] = False
                auth_state["error"] = None
                auth_state["last_login"] = datetime.now(tz=UTC).isoformat()
            return

        async with auth_lock:
            auth_state["status"] = "error"
            auth_state["logged_in"] = False
            auth_state["mfa_required"] = False
            auth_state["error"] = "login_failed"

    async def auth_snapshot() -> dict[str, Any]:
        async with auth_lock:
            snap = dict(auth_state)
        snap.pop("login_payload", None)
        return snap

    async def watcher_loop() -> None:
        while True:
            try:
                async with MomoScreenerWatcher(
                    url=cfg.momo_url,
                    tbody_xpath=cfg.momo_tbody_xpath,
                    timeout_ms=cfg.momo_timeout_ms,
                    headless=cfg.headless,
                    poll_ms=cfg.poll_ms,
                    stable_ms=cfg.stable_ms,
                ) as watcher:
                    async with state_lock:
                        state["error"] = None
                    async for headers, rows in watcher.watch():
                        symbols = [r.symbol for r in rows if r.symbol]
                        if cfg.limit > 0:
                            rows = rows[: cfg.limit]
                            symbols = symbols[: cfg.limit]
                        payload_rows = [{"symbol": r.symbol, "values": r.values} for r in rows]
                        async with state_lock:
                            state["updated_at"] = datetime.now(tz=UTC).isoformat()
                            state["headers"] = headers
                            state["rows"] = payload_rows
                            state["symbols"] = symbols
                            state["error"] = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                async with state_lock:
                    state["error"] = repr(exc)
                await asyncio.sleep(5.0)

    async def auth_startup_loop() -> None:
        await asyncio.sleep(auth_cfg.auto_login_delay_s)
        if await load_cached_session():
            return
        await attempt_login()

    @app.on_event("startup")
    async def _startup() -> None:
        app.state._watcher_task = asyncio.create_task(watcher_loop())
        app.state._auth_task = asyncio.create_task(auth_startup_loop())

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        task = getattr(app.state, "_watcher_task", None)
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        auth_task = getattr(app.state, "_auth_task", None)
        if auth_task is not None:
            auth_task.cancel()
            try:
                await auth_task
            except asyncio.CancelledError:
                pass

    def normalize_order_type(value: str) -> str:
        v = (value or "").strip().lower()
        return "limit" if v == "limit" else "market"

    async def ensure_logged_in() -> None:
        snapshot = await auth_snapshot()
        if not snapshot.get("logged_in"):
            raise HTTPException(status_code=409, detail="not_logged_in")

    def get_latest_price(symbol: str) -> float | None:
        try:
            prices = rh.stocks.get_latest_price(symbol, includeExtendedHours=True)
            if prices and prices[0]:
                return float(prices[0])
        except Exception:
            return None
        return None

    def _parse_datetime(value: str) -> datetime | None:
        if not value:
            return None
        s = value.strip()
        if not s:
            return None
        try:
            # Alpaca commonly returns RFC3339 with "Z".
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            return dt.astimezone(UTC)
        except Exception:
            return None

    def _news_lookback_hours() -> float:
        raw = os.getenv("NEWS_LOOKBACK_HOURS", "6").strip()
        try:
            hours = float(raw)
        except Exception:
            hours = 6.0
        if hours <= 0:
            hours = 6.0
        return min(max(hours, 0.25), 168.0)  # clamp to [15m, 7d]

    def fetch_alpaca_news(symbol: str, start_dt: datetime, limit: int = 12) -> list[dict[str, Any]]:
        api_key = (os.getenv("ALPACA_API_KEY") or os.getenv("APCA_API_KEY_ID") or "").strip()
        api_secret = (os.getenv("ALPACA_API_SECRET") or os.getenv("APCA_API_SECRET_KEY") or "").strip()
        if not api_key or not api_secret:
            raise RuntimeError("missing_alpaca_credentials")

        base = (os.getenv("ALPACA_NEWS_BASE_URL") or "https://data.alpaca.markets/v1beta1").strip()
        if not base:
            base = "https://data.alpaca.markets/v1beta1"

        end_dt = datetime.now(tz=UTC)
        params = {
            "symbols": symbol,
            "start": start_dt.isoformat().replace("+00:00", "Z"),
            "end": end_dt.isoformat().replace("+00:00", "Z"),
            "limit": str(max(1, min(50, int(limit)))),
        }
        url = f"{base.rstrip('/')}/news?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(
            url,
            headers={
                "APCA-API-KEY-ID": api_key,
                "APCA-API-SECRET-KEY": api_secret,
                "Accept": "application/json",
                "User-Agent": "RHWidget/0.1 (+local)",
            },
        )
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        raw_items = []
        if isinstance(data, dict):
            raw_items = data.get("news") or data.get("data") or data.get("items") or []
        if not isinstance(raw_items, list):
            raw_items = []

        items: list[dict[str, Any]] = []
        for it in raw_items:
            if not isinstance(it, dict):
                continue
            created_at = it.get("created_at") or it.get("createdAt") or it.get("time") or ""
            created_dt = _parse_datetime(str(created_at))
            if created_dt and created_dt < start_dt.astimezone(UTC):
                continue
            headline = (it.get("headline") or it.get("title") or "").strip()
            summary = (it.get("summary") or it.get("description") or "").strip()
            link = (it.get("url") or it.get("link") or "").strip()
            source = (it.get("source") or "").strip()
            if not headline:
                continue
            items.append(
                {
                    "title": headline,
                    "summary": summary,
                    "link": link,
                    "source": source,
                    "created_at": created_dt.isoformat() if created_dt else str(created_at),
                }
            )

        # Sort newest first when timestamps are available.
        def sort_key(x: dict[str, Any]) -> float:
            dt = _parse_datetime(str(x.get("created_at") or ""))
            return dt.timestamp() if dt else 0.0

        items.sort(key=sort_key, reverse=True)
        return items

    def _extract_json_object(text: str) -> dict[str, Any] | None:
        if not text:
            return None
        s = text.strip()
        if not s:
            return None
        try:
            obj = json.loads(s)
            return obj if isinstance(obj, dict) else None
        except Exception:
            pass
        # Try to salvage the first JSON object region.
        start = s.find("{")
        end = s.rfind("}")
        if start >= 0 and end > start:
            chunk = s[start : end + 1]
            try:
                obj = json.loads(chunk)
                return obj if isinstance(obj, dict) else None
            except Exception:
                return None
        return None

    def analyze_news_with_lmstudio(symbol: str, items: list[dict[str, Any]]) -> dict[str, Any]:
        base = (os.getenv("LMSTUDIO_BASE_URL") or "http://127.0.0.1:1234/v1").strip()
        model = (os.getenv("LMSTUDIO_MODEL") or "local-model").strip()
        if not base:
            raise RuntimeError("missing_lmstudio_base_url")

        trimmed = []
        for it in items[:20]:
            if not isinstance(it, dict):
                continue
            trimmed.append(
                {
                    "title": str(it.get("title") or "").strip(),
                    "summary": str(it.get("summary") or "").strip(),
                    "source": str(it.get("source") or "").strip(),
                    "created_at": str(it.get("created_at") or "").strip(),
                    "link": str(it.get("link") or "").strip(),
                }
            )

        system = (
            "You summarize recent stock news and rate sentiment.  The sentiment should be based on the new's likelyhood to increase or reduce the price at the market open.\n"
            "Output ONLY a single JSON object with keys:\n"
            "- summary: string (<= 3 sentences)\n"
            "- sentiment_score: integer 0-100 (50 = neutral)\n"
            "- sentiment_label: one of 'bearish','neutral','bullish'\n"
            "- key_points: array of short strings (<= 6 items)\n"
        )
        user = {
            "symbol": symbol,
            "instruction": "Analyze sentiment regarding price impact for the stock based only on the provided recent news items.",
            "news_items": trimmed,
        }

        payload = {
            "model": model,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(user)},
            ],
        }

        url = f"{base.rstrip('/')}/chat/completions"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        content = ""
        try:
            content = str(data["choices"][0]["message"]["content"] or "")
        except Exception:
            content = ""

        obj = _extract_json_object(content)
        if not obj:
            raise RuntimeError("lmstudio_invalid_json")

        score_raw = obj.get("sentiment_score")
        try:
            score = int(score_raw)
        except Exception:
            score = 50
        score = min(max(score, 0), 100)

        label = str(obj.get("sentiment_label") or "").strip().lower()
        if label not in {"bearish", "neutral", "bullish"}:
            label = "neutral" if 40 <= score <= 60 else ("bullish" if score > 60 else "bearish")

        summary = str(obj.get("summary") or "").strip()
        if not summary:
            summary = "No summary available."

        key_points = obj.get("key_points")
        if not isinstance(key_points, list):
            key_points = []
        key_points = [str(x).strip() for x in key_points if str(x).strip()][:6]

        return {"summary": summary, "sentiment_score": score, "sentiment_label": label, "key_points": key_points}

    def _env_bool(name: str, default: bool = False) -> bool:
        raw = (os.getenv(name) or "").strip().lower()
        if not raw:
            return default
        return raw in {"1", "true", "t", "yes", "y", "on"}

    def _env_float(name: str, default: float) -> float:
        raw = (os.getenv(name) or "").strip()
        if not raw:
            return default
        try:
            return float(raw)
        except Exception:
            return default

    def _env_str(name: str, default: str) -> str:
        raw = (os.getenv(name) or "").strip()
        return raw or default

    def _auto_stop_config(payload: BuyRequest) -> dict[str, Any]:
        enabled = payload.auto_stop if payload.auto_stop is not None else _env_bool("AUTO_STOP_ENABLED", False)
        offset = _env_float("AUTO_STOP_OFFSET", 0.01)
        max_wait_s = _env_float("AUTO_STOP_MAX_WAIT_S", 12.0)
        alpaca_feed = _env_str("ALPACA_DATA_FEED", "iex")
        alpaca_data_base = _env_str("ALPACA_DATA_BASE_URL", "https://data.alpaca.markets/v2")
        return {
            "enabled": bool(enabled),
            "offset": offset,
            "max_wait_s": max_wait_s,
            "alpaca_feed": alpaca_feed,
            "alpaca_data_base": alpaca_data_base,
        }

    def _interval_seconds(interval: str) -> int | None:
        v = (interval or "").strip().lower()
        if v in {"1minute", "1min", "minute", "1m"}:
            return 60
        if v == "5minute":
            return 300
        if v == "10minute":
            return 600
        if v == "hour":
            return 3600
        if v == "day":
            return 86400
        if v == "week":
            return 604800
        return None

    def fetch_alpaca_prev_candle_low(symbol: str, feed: str, data_base: str) -> float | None:
        api_key = (os.getenv("ALPACA_API_KEY") or os.getenv("APCA_API_KEY_ID") or "").strip()
        api_secret = (os.getenv("ALPACA_API_SECRET") or os.getenv("APCA_API_SECRET_KEY") or "").strip()
        if not api_key or not api_secret:
            raise RuntimeError("missing_alpaca_credentials")

        base = (data_base or "").strip() or "https://data.alpaca.markets/v2"
        feed = (feed or "").strip().lower() or "iex"
        if feed not in {"iex", "sip"}:
            feed = "iex"

        now = datetime.now(tz=UTC)
        start = now - timedelta(minutes=15)
        params = {
            "timeframe": "1Min",
            "start": start.isoformat().replace("+00:00", "Z"),
            "end": now.isoformat().replace("+00:00", "Z"),
            "limit": "10",
            "adjustment": "raw",
            "feed": feed,
        }
        url = f"{base.rstrip('/')}/stocks/{urllib.parse.quote(symbol)}/bars?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(
            url,
            headers={
                "APCA-API-KEY-ID": api_key,
                "APCA-API-SECRET-KEY": api_secret,
                "Accept": "application/json",
                "User-Agent": "RHWidget/0.1 (+local)",
            },
        )
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        bars = data.get("bars") if isinstance(data, dict) else None
        if not isinstance(bars, list) or not bars:
            return None

        # Alpaca bar timestamps are bar start times. Previous completed bar is the latest bar with t <= now-60s.
        cutoff = now - timedelta(seconds=60)
        best_dt: datetime | None = None
        best_low: float | None = None
        for b in bars:
            if not isinstance(b, dict):
                continue
            t = _parse_datetime(str(b.get("t") or ""))
            if not t or t > cutoff:
                continue
            low_raw = b.get("l")
            if low_raw is None:
                continue
            try:
                low = float(low_raw)
            except Exception:
                continue
            if low <= 0:
                continue
            if best_dt is None or t > best_dt:
                best_dt = t
                best_low = low
        return best_low

    def get_prev_candle_low(symbol: str, interval: str, span: str, bounds: str) -> float | None:
        interval_s = _interval_seconds(interval)
        if not interval_s:
            raise ValueError("invalid_candle_interval")
        if interval_s == 60:
            feed = _env_str("ALPACA_DATA_FEED", "iex")
            data_base = _env_str("ALPACA_DATA_BASE_URL", "https://data.alpaca.markets/v2")
            return fetch_alpaca_prev_candle_low(symbol, feed=feed, data_base=data_base)

        # Robinhood only supports coarse candle intervals (5m+).
        data = rh.stocks.get_stock_historicals(symbol, interval=interval, span=span, bounds=bounds) or []
        if not isinstance(data, list) or not data:
            return None
        now = datetime.now(tz=UTC)
        best_dt: datetime | None = None
        best_low: float | None = None
        for row in data:
            if not isinstance(row, dict):
                continue
            begins_at = _parse_datetime(str(row.get("begins_at") or ""))
            if not begins_at:
                continue
            # Only completed candles.
            if begins_at + timedelta(seconds=interval_s) > now:
                continue
            low_raw = row.get("low_price")
            if low_raw is None:
                continue
            try:
                low = float(low_raw)
            except Exception:
                continue
            if low <= 0:
                continue
            if best_dt is None or begins_at > best_dt:
                best_dt = begins_at
                best_low = low
        return best_low

    async def place_auto_stop_after_buy(
        symbol: str,
        before_qty: float,
        intended_qty: int,
        stop_price: float,
        max_wait_s: float,
    ) -> None:
        try:
            max_wait_s = float(max_wait_s)
        except Exception:
            max_wait_s = 12.0
        max_wait_s = min(max(max_wait_s, 1.0), 120.0)

        started = time.monotonic()
        while time.monotonic() - started < max_wait_s:
            pos_qty = await asyncio.to_thread(get_position_qty, symbol)
            delta = float(pos_qty) - float(before_qty)
            qty_available = int(math.floor(delta + 1e-6))
            qty_to_protect = min(intended_qty, qty_available)
            if qty_to_protect > 0:
                print(f"[trade] placing stop {symbol} qty={qty_to_protect} stop={stop_price}")
                result = await asyncio.to_thread(
                    rh.orders.order_sell_stop_loss,
                    symbol,
                    qty_to_protect,
                    stop_price,
                    None,
                    "gfd",
                )
                order = await _refresh_stock_order(_require_order_ok(result))
                print(f"[trade] stop placed {symbol} id={order.get('id') or '-'} state={order.get('state') or '-'}")
                return
            await asyncio.sleep(0.5)
        print(f"[trade] stop not placed {symbol} (timeout waiting for fill)")

    def get_position_qty(symbol: str) -> float:
        try:
            instruments = rh.stocks.get_instruments_by_symbols(symbol) or []
            instrument = instruments[0] if instruments else None
            inst_url = instrument.get("url") if isinstance(instrument, dict) else None
            if not inst_url:
                return 0.0
            positions = rh.account.get_open_stock_positions() or []
            for pos in positions:
                if pos.get("instrument") == inst_url:
                    return float(pos.get("quantity") or 0)
        except Exception:
            return 0.0
        return 0.0

    def _order_error_detail(result: Any) -> str | None:
        if result is None:
            return "order_submit_failed"
        if not isinstance(result, dict):
            return "unexpected_order_response"
        detail = result.get("detail")
        if isinstance(detail, str) and detail.strip():
            return detail.strip()
        err = result.get("error")
        if isinstance(err, str) and err.strip():
            return err.strip()
        msg = result.get("message")
        if isinstance(msg, str) and msg.strip():
            return msg.strip()
        non_field = result.get("non_field_errors")
        if isinstance(non_field, list) and non_field and isinstance(non_field[0], str):
            return non_field[0].strip() or None
        return None

    def _order_state(result: Any) -> tuple[str | None, str | None, str | None]:
        if not isinstance(result, dict):
            return None, None, None
        order_id = result.get("id") if isinstance(result.get("id"), str) else None
        state = result.get("state") if isinstance(result.get("state"), str) else None
        reject = result.get("reject_reason")
        reject_reason = reject if isinstance(reject, str) and reject.strip() else None
        return order_id, state, reject_reason

    def _require_order_ok(result: Any) -> dict[str, Any]:
        err = _order_error_detail(result)
        order_id, state, reject_reason = _order_state(result)
        if order_id or state or reject_reason:
            print(f"[trade] order status id={order_id or '-'} state={state or '-'} reject={reject_reason or '-'}")
        if reject_reason:
            raise HTTPException(status_code=400, detail=reject_reason)
        if state in {"rejected", "failed", "canceled"}:
            raise HTTPException(status_code=400, detail=f"order_{state}")
        if err and not order_id and not state:
            print(f"[trade] order error {err}")
            if err in {"order_submit_failed", "unexpected_order_response"}:
                raise HTTPException(status_code=502, detail=err)
            raise HTTPException(status_code=400, detail=err)
        if isinstance(result, dict) and (order_id or state):
            return {"id": order_id, "state": state, "reject_reason": reject_reason}
        raise HTTPException(status_code=502, detail="unexpected_order_response")

    async def _refresh_stock_order(order: dict[str, Any]) -> dict[str, Any]:
        order_id = order.get("id")
        state = order.get("state")
        if not order_id or not isinstance(order_id, str):
            return order
        if state != "unconfirmed":
            return order

        for delay_s in (0.25, 0.5, 0.75):
            await asyncio.sleep(delay_s)
            info = await asyncio.to_thread(rh.orders.get_stock_order_info, order_id)
            _, new_state, reject_reason = _order_state(info)
            if reject_reason:
                order["reject_reason"] = reject_reason
                return order
            if new_state and new_state != state:
                order["state"] = new_state
                return order

        return order

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/news")
    async def news(symbol: str = Query(...), limit: int = Query(12, ge=1, le=50)) -> JSONResponse:
        sym = (symbol or "").strip().upper()
        if not sym or sym in {"-", "—"}:
            raise HTTPException(status_code=400, detail="missing_symbol")

        lookback_h = _news_lookback_hours()
        start_dt = datetime.now(tz=UTC) - timedelta(hours=lookback_h)

        now = time.monotonic()
        async with news_lock:
            cached = news_cache.get(sym)
            if (
                cached
                and isinstance(cached.get("ts"), (int, float))
                and now - float(cached["ts"]) < 45
                and cached.get("lookback_h") == lookback_h
            ):
                return JSONResponse(
                    {
                        "ok": True,
                        "symbol": sym,
                        "lookback_hours": lookback_h,
                        "items": cached.get("items") or [],
                        "analysis": cached.get("analysis") or None,
                        "cached": True,
                    },
                    headers={"Cache-Control": "no-store"},
                )

        try:
            items = await asyncio.to_thread(fetch_alpaca_news, sym, start_dt, limit)
        except Exception as exc:
            return JSONResponse(
                {"ok": False, "symbol": sym, "lookback_hours": lookback_h, "items": [], "error": repr(exc)},
                status_code=502,
                headers={"Cache-Control": "no-store"},
            )

        analysis: dict[str, Any] | None = None
        if items:
            try:
                analysis = await asyncio.to_thread(analyze_news_with_lmstudio, sym, items)
            except Exception as exc:
                analysis = {"error": repr(exc)}
        else:
            analysis = {"summary": "No recent news found in lookback window.", "sentiment_score": 50, "sentiment_label": "neutral", "key_points": []}

        async with news_lock:
            news_cache[sym] = {"ts": now, "lookback_h": lookback_h, "items": items, "analysis": analysis}
        return JSONResponse(
            {"ok": True, "symbol": sym, "lookback_hours": lookback_h, "items": items, "analysis": analysis, "cached": False},
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/api/auth/status")
    async def auth_status() -> JSONResponse:
        snapshot = await auth_snapshot()
        if snapshot.get("status") in {"verification_required", "mfa_required", "approval_required"}:
            await refresh_challenge()
            snapshot = await auth_snapshot()
        if snapshot.get("prompt_validated") and not snapshot.get("logged_in"):
            await attempt_login()
            snapshot = await auth_snapshot()
        return JSONResponse(snapshot, headers={"Cache-Control": "no-store"})

    @app.post("/api/auth/sms")
    async def auth_sms(payload: SmsCodeRequest = Body(...)) -> JSONResponse:
        code = (payload.code or "").strip()
        if not code:
            raise HTTPException(status_code=400, detail="missing_code")
        await refresh_challenge()
        async with auth_lock:
            challenge_id = auth_state.get("challenge_id")
            machine_id = auth_state.get("machine_id")
            login_payload = auth_state.get("login_payload")
        if not challenge_id or not machine_id or not login_payload:
            raise HTTPException(status_code=409, detail="no_challenge")
        challenge_url = f"https://api.robinhood.com/challenge/{challenge_id}/respond/"
        challenge_payload = {"response": code}
        challenge_resp = await asyncio.to_thread(request_post, challenge_url, challenge_payload)
        if (challenge_resp or {}).get("status") != "validated":
            async with auth_lock:
                auth_state["status"] = "mfa_required"
                auth_state["error"] = "invalid_code"
            return JSONResponse(await auth_snapshot(), headers={"Cache-Control": "no-store"})

        inquiries_url = f"https://api.robinhood.com/pathfinder/inquiries/{machine_id}/user_view/"
        inquiries_payload = {"sequence": 0, "user_input": {"status": "continue"}}
        await asyncio.to_thread(request_post, inquiries_url, inquiries_payload, json=True)
        await attempt_login()
        return JSONResponse(await auth_snapshot(), headers={"Cache-Control": "no-store"})

    @app.post("/api/auth/login")
    async def auth_login() -> JSONResponse:
        if await load_cached_session():
            return JSONResponse(await auth_snapshot(), headers={"Cache-Control": "no-store"})
        await attempt_login()
        return JSONResponse(await auth_snapshot(), headers={"Cache-Control": "no-store"})

    @app.post("/api/trade/buy")
    async def trade_buy(payload: BuyRequest = Body(...)) -> JSONResponse:
        start_ts = time.monotonic()
        await ensure_logged_in()
        symbol = (payload.symbol or "").strip().upper()
        if not symbol:
            raise HTTPException(status_code=400, detail="missing_symbol")
        before_qty = await asyncio.to_thread(get_position_qty, symbol)
        order_type = normalize_order_type(payload.order_type)
        auto_stop_cfg = _auto_stop_config(payload)
        if auto_stop_cfg.get("enabled") and payload.stop_price is None and payload.stop_ref_price is None:
            raise HTTPException(status_code=400, detail="missing_stop_ref_price")
        stop_info: dict[str, Any] | None = None

        if payload.amount_usd is not None:
            amount_usd = float(payload.amount_usd or 0)
            if amount_usd <= 0:
                raise HTTPException(status_code=400, detail="invalid_amount_usd")

            if order_type == "limit":
                if payload.limit_offset is not None:
                    quote_start = time.monotonic()
                    last = await asyncio.to_thread(get_latest_price, symbol)
                    print(f"[trade] buy quote {symbol} {time.monotonic() - quote_start:.3f}s")
                    if last is None:
                        raise HTTPException(status_code=502, detail="quote_unavailable")
                    limit = last + float(payload.limit_offset)
                elif payload.limit_price is not None:
                    limit = float(payload.limit_price)
                else:
                    raise HTTPException(status_code=400, detail="missing_limit_offset")

                if limit <= 0:
                    raise HTTPException(status_code=400, detail="invalid_limit_price")
                limit = round_price(limit)

                qty_whole = int(math.floor(amount_usd / float(limit)))
                if qty_whole <= 0:
                    raise HTTPException(status_code=400, detail="amount_too_small_for_limit")
                print(f"[trade] buy dollars->shares {symbol} ${amount_usd:.2f} @ {limit:.4f} => {qty_whole} sh")
                order_start = time.monotonic()
                result = await asyncio.to_thread(rh.orders.order_buy_limit, symbol, qty_whole, limit, None, "gfd")
                print(f"[trade] buy limit submit {symbol} {time.monotonic() - order_start:.3f}s")
                intended_qty = int(qty_whole)
            else:
                quote_start = time.monotonic()
                last = await asyncio.to_thread(get_latest_price, symbol)
                print(f"[trade] buy quote {symbol} {time.monotonic() - quote_start:.3f}s")
                if last is None or last <= 0:
                    raise HTTPException(status_code=502, detail="quote_unavailable")
                qty_whole = int(math.floor(amount_usd / float(last)))
                if qty_whole <= 0:
                    raise HTTPException(status_code=400, detail="amount_too_small_for_market")
                print(f"[trade] buy dollars->shares {symbol} ${amount_usd:.2f} @ {last:.4f} => {qty_whole} sh")
                order_start = time.monotonic()
                result = await asyncio.to_thread(rh.orders.order_buy_market, symbol, qty_whole, None, "gfd")
                print(f"[trade] buy market submit {symbol} {time.monotonic() - order_start:.3f}s")
                intended_qty = int(qty_whole)
        else:
            qty = float(payload.qty or 0)
            if qty <= 0:
                raise HTTPException(status_code=400, detail="invalid_qty")
            qty_whole = int(math.floor(qty))
            if qty_whole <= 0 or abs(qty - qty_whole) > 1e-9:
                raise HTTPException(status_code=400, detail="invalid_qty")
            if order_type == "limit":
                if payload.limit_offset is not None:
                    quote_start = time.monotonic()
                    last = await asyncio.to_thread(get_latest_price, symbol)
                    print(f"[trade] buy quote {symbol} {time.monotonic() - quote_start:.3f}s")
                    if last is None:
                        raise HTTPException(status_code=502, detail="quote_unavailable")
                    limit = last + float(payload.limit_offset)
                elif payload.limit_price is not None:
                    limit = float(payload.limit_price)
                else:
                    raise HTTPException(status_code=400, detail="missing_limit_offset")
                if limit <= 0:
                    raise HTTPException(status_code=400, detail="invalid_limit_price")
                limit = round_price(limit)
                order_start = time.monotonic()
                result = await asyncio.to_thread(rh.orders.order_buy_limit, symbol, qty_whole, limit, None, "gfd")
                print(f"[trade] buy limit submit {symbol} {time.monotonic() - order_start:.3f}s")
            else:
                order_start = time.monotonic()
                result = await asyncio.to_thread(rh.orders.order_buy_market, symbol, qty_whole, None, "gfd")
                print(f"[trade] buy market submit {symbol} {time.monotonic() - order_start:.3f}s")
            intended_qty = int(qty_whole)

        if auto_stop_cfg.get("enabled") and intended_qty > 0:
            try:
                offset = float(auto_stop_cfg.get("offset") or 0.01)
                explicit_stop = float(payload.stop_price) if payload.stop_price is not None else None
                ref_price = float(payload.stop_ref_price) if payload.stop_ref_price is not None else None

                source = "cursor"
                if explicit_stop is not None:
                    stop_price = round_price(explicit_stop)
                    source = "explicit"
                elif ref_price is not None:
                    stop_price = round_price(ref_price - offset)
                    source = "cursor"
                else:
                    stop_info = {"enabled": True, "status": "error", "error": "missing_stop_ref_price"}
                    stop_price = None

                if stop_price is None:
                    pass
                elif stop_price <= 0 or not math.isfinite(float(stop_price)):
                    stop_info = {"enabled": True, "status": "error", "error": "invalid_stop_price"}
                else:
                    stop_info = {
                        "enabled": True,
                        "status": "pending",
                        "stop_price": float(stop_price),
                        "source": source,
                        "offset": offset,
                        "ref_price": ref_price if source == "cursor" else None,
                    }
            except Exception as exc:
                stop_info = {"enabled": True, "status": "error", "error": repr(exc)}
        else:
            stop_info = {"enabled": False}
        print(f"[trade] buy total {symbol} {time.monotonic() - start_ts:.3f}s")
        order = await _refresh_stock_order(_require_order_ok(result))
        if stop_info and stop_info.get("enabled") and stop_info.get("status") == "pending":
            asyncio.create_task(
                place_auto_stop_after_buy(
                    symbol=symbol,
                    before_qty=float(before_qty),
                    intended_qty=int(intended_qty),
                    stop_price=float(stop_info["stop_price"]),
                    max_wait_s=float(auto_stop_cfg.get("max_wait_s") or 12.0),
                )
            )
        return JSONResponse({"ok": True, "order": order, "result": result, "auto_stop": stop_info})

    @app.post("/api/trade/sell")
    async def trade_sell(payload: SellRequest = Body(...)) -> JSONResponse:
        start_ts = time.monotonic()
        await ensure_logged_in()
        symbol = (payload.symbol or "").strip().upper()
        if not symbol:
            raise HTTPException(status_code=400, detail="missing_symbol")
        qty = await asyncio.to_thread(get_position_qty, symbol)
        if qty <= 0:
            raise HTTPException(status_code=400, detail="no_position")
        order_type = normalize_order_type(payload.order_type)
        if order_type == "limit":
            if payload.limit_offset is not None:
                quote_start = time.monotonic()
                last = await asyncio.to_thread(get_latest_price, symbol)
                print(f"[trade] sell quote {symbol} {time.monotonic() - quote_start:.3f}s")
                if last is None:
                    raise HTTPException(status_code=502, detail="quote_unavailable")
                limit = last - float(payload.limit_offset)
            elif payload.limit_price is not None:
                limit = float(payload.limit_price)
            else:
                raise HTTPException(status_code=400, detail="missing_limit_offset")
            if limit <= 0:
                raise HTTPException(status_code=400, detail="invalid_limit_price")
            limit = round_price(limit)
            qty_whole = int(math.floor(qty))
            if qty_whole <= 0:
                raise HTTPException(status_code=400, detail="no_whole_shares_for_limit")
            order_start = time.monotonic()
            result = await asyncio.to_thread(rh.orders.order_sell_limit, symbol, qty_whole, limit, None, "gfd")
            print(f"[trade] sell limit submit {symbol} {time.monotonic() - order_start:.3f}s")
        else:
            qty_is_whole = abs(qty - round(qty)) < 1e-6
            order_start = time.monotonic()
            if qty_is_whole:
                result = await asyncio.to_thread(rh.orders.order_sell_market, symbol, int(round(qty)), None, "gfd")
            else:
                qty_frac = round(float(qty), 6)
                result = await asyncio.to_thread(rh.orders.order_sell_fractional_by_quantity, symbol, qty_frac)
            print(f"[trade] sell market submit {symbol} {time.monotonic() - order_start:.3f}s")
        print(f"[trade] sell total {symbol} {time.monotonic() - start_ts:.3f}s")
        order = await _refresh_stock_order(_require_order_ok(result))
        return JSONResponse({"ok": True, "order": order, "result": result})

    @app.get("/api/tickers")
    async def tickers() -> JSONResponse:
        async with state_lock:
            payload = dict(state)
        return JSONResponse(payload, headers={"Cache-Control": "no-store"})

    return app


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Local API server that streams Momoscreener tickers to a browser extension.")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--momo-url", default=DEFAULT_URL)
    p.add_argument("--momo-tbody-xpath", default=DEFAULT_TBODY_XPATH)
    p.add_argument("--momo-timeout-ms", type=int, default=30_000)
    p.add_argument("--headful", action="store_true", help="Show the Playwright browser window.")
    p.add_argument("--poll-ms", type=int, default=2_000, help="How often to poll for changes.")
    p.add_argument("--stable-ms", type=int, default=750, help="Stability delay to reduce partial-update churn.")
    p.add_argument("--limit", type=int, default=30, help="Max rows to keep/serve (0 = no limit).")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    cfg = BridgeConfig(
        momo_url=args.momo_url,
        momo_tbody_xpath=args.momo_tbody_xpath,
        momo_timeout_ms=args.momo_timeout_ms,
        headless=not args.headful,
        poll_ms=args.poll_ms,
        stable_ms=args.stable_ms,
        limit=args.limit,
    )
    auth_cfg = AuthConfig(
        username=os.getenv("RH_USERNAME"),
        password=os.getenv("RH_PASSWORD"),
        auto_login_delay_s=float(os.getenv("RH_AUTO_LOGIN_DELAY_S", "5")),
    )

    import uvicorn

    app = create_app(cfg, auth_cfg)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

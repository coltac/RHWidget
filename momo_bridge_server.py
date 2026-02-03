from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import pickle
import re
import ssl
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from momo_screener import DEFAULT_TBODY_XPATH, DEFAULT_URL, MomoScreenerWatcher
import robin_stocks.robinhood as rh
from robin_stocks.robinhood.authentication import generate_device_token
from robin_stocks.robinhood.helper import request_get, request_post, round_price, set_login_state, update_session
from robin_stocks.robinhood.urls import login_url, orders_url, positions_url

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
        "rvol_updated_at": None,
        "rvol_error": None,
        "rvol": {},
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

    rh_cache_lock = threading.Lock()
    rh_cache: dict[str, Any] = {
        "account_url": None,
        "instrument_url_by_symbol": {},
    }

    stop_lock = asyncio.Lock()
    stop_cache: dict[str, dict[str, Any]] = {}

    news_lock = asyncio.Lock()
    news_cache: dict[str, dict[str, Any]] = {}

    _STAR_CHARS = {
        # Common star glyphs/emoji (use escapes to avoid source encoding issues).
        "\u2B50",  # ⭐
        "\u2605",  # ★
        "\u2606",  # ☆
        "\u272A",  # ✪
        "\u2729",  # ✩
        "\u272B",  # ✫
        "\u272C",  # ✬
        "\u272D",  # ✭
        "\u272E",  # ✮
        "\u272F",  # ✯
        "\u2730",  # ✰
        "\u2728",  # ✨
        # Mojibake variants we've seen in this repo/console output.
        "â­",
        "â˜…",
        "â˜†",
        "âœª",
        "âœ©",
        "âœ«",
        "âœ¬",
        "âœ­",
        "âœ®",
        "âœ¯",
        "âœ°",
        "âœ¨",
    }
    # Match HOD whether Momoscreener formats it as "(HOD)" or just "HOD".
    _HOD_RE = re.compile(r"\bHOD\b", re.IGNORECASE)

    def _symbol_cell_text(values: dict[str, Any] | None) -> str:
        if not isinstance(values, dict) or not values:
            return ""
        # Prefer explicit symbol headers when present; otherwise use first column value.
        for k in ("Symbol", "symbol", "Ticker", "ticker"):
            v = values.get(k)
            if isinstance(v, str) and v.strip():
                return v
        first = next(iter(values.values()), "")
        return first if isinstance(first, str) else str(first or "")

    def _row_flags(values: dict[str, Any] | None) -> tuple[bool, bool]:
        raw = _symbol_cell_text(values)
        has_news = any(ch in raw for ch in _STAR_CHARS)
        is_hod = bool(_HOD_RE.search(raw))
        return has_news, is_hod

    def _build_https_context() -> ssl.SSLContext | None:
        ca_bundle = (os.getenv("RH_CA_BUNDLE") or "").strip()
        if not ca_bundle:
            ca_bundle = (os.getenv("SSL_CERT_FILE") or os.getenv("REQUESTS_CA_BUNDLE") or "").strip()
        if not ca_bundle:
            try:
                import certifi  # type: ignore

                ca_bundle = certifi.where()
            except Exception:
                ca_bundle = ""
        if not ca_bundle:
            return None
        try:
            return ssl.create_default_context(cafile=ca_bundle)
        except Exception:
            return None

    https_context = _build_https_context()

    def _urlopen(req: urllib.request.Request, *, timeout: float):
        if https_context is not None and str(getattr(req, "full_url", "")).startswith("https://"):
            return urllib.request.urlopen(req, timeout=timeout, context=https_context)
        return urllib.request.urlopen(req, timeout=timeout)

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
                        async with state_lock:
                            rvol_snap = dict(state.get("rvol") or {})
                        symbols = [r.symbol for r in rows if r.symbol]
                        if cfg.limit > 0:
                            rows = rows[: cfg.limit]
                            symbols = symbols[: cfg.limit]
                        payload_rows = []
                        for r in rows:
                            # Prefer scraper-detected flags (SVG star icon has no text content).
                            has_news = bool(getattr(r, "has_news", False))
                            is_hod = bool(getattr(r, "is_hod", False))
                            if not has_news or not is_hod:
                                fallback_has_news, fallback_is_hod = _row_flags(r.values)
                                has_news = has_news or fallback_has_news
                                is_hod = is_hod or fallback_is_hod
                            rvol_info = rvol_snap.get(r.symbol) if isinstance(rvol_snap, dict) else None
                            rvol_pct = None
                            today_vol = None
                            if isinstance(rvol_info, dict):
                                rvol_raw = rvol_info.get("rvol_pct")
                                try:
                                    rvol_pct = float(rvol_raw) if rvol_raw is not None else None
                                except Exception:
                                    rvol_pct = None
                                tv_raw = rvol_info.get("today_volume")
                                try:
                                    today_vol = int(float(tv_raw or 0))
                                except Exception:
                                    today_vol = None
                            payload_rows.append(
                                {
                                    "symbol": r.symbol,
                                    "values": r.values,
                                    "has_news": has_news,
                                    "is_hod": is_hod,
                                    "rvol_pct": rvol_pct,
                                    "today_volume": today_vol,
                                }
                            )
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
        app.state._rvol_task = asyncio.create_task(rvol_loop())

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
        rvol_task = getattr(app.state, "_rvol_task", None)
        if rvol_task is not None:
            rvol_task.cancel()
            try:
                await rvol_task
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

    def _rh_cached_account_url() -> str:
        with rh_cache_lock:
            cached = rh_cache.get("account_url")
        if isinstance(cached, str) and cached.strip():
            return cached.strip()
        url = rh.profiles.load_account_profile(info="url")
        if not url:
            raise RuntimeError("missing_account_url")
        out = str(url).strip()
        if not out:
            raise RuntimeError("missing_account_url")
        with rh_cache_lock:
            rh_cache["account_url"] = out
        return out

    def _safe_float(v: Any) -> float | None:
        try:
            f = float(v)
        except Exception:
            return None
        if not math.isfinite(f):
            return None
        return f

    def _rh_quote_snapshot(symbol: str) -> dict[str, Any]:
        sym = (symbol or "").strip().upper()
        if not sym:
            raise ValueError("missing_symbol")
        quotes = rh.stocks.get_quotes(sym) or []
        q = quotes[0] if isinstance(quotes, list) and quotes else None
        if not isinstance(q, dict):
            raise RuntimeError("quote_unavailable")
        return q

    def _rh_instrument_url(symbol: str, quote: dict[str, Any] | None = None) -> str:
        sym = (symbol or "").strip().upper()
        if not sym:
            raise ValueError("missing_symbol")
        with rh_cache_lock:
            cached = (rh_cache.get("instrument_url_by_symbol") or {}).get(sym)
        if isinstance(cached, str) and cached.strip():
            return cached.strip()

        inst = None
        if isinstance(quote, dict):
            inst = quote.get("instrument")
        if not inst:
            instruments = rh.stocks.get_instruments_by_symbols(sym) or []
            inst0 = instruments[0] if instruments and isinstance(instruments, list) else None
            inst = inst0.get("url") if isinstance(inst0, dict) else None
        if not inst or not isinstance(inst, str):
            raise RuntimeError("instrument_unavailable")
        inst = inst.strip()
        with rh_cache_lock:
            d = rh_cache.get("instrument_url_by_symbol")
            if not isinstance(d, dict):
                d = {}
                rh_cache["instrument_url_by_symbol"] = d
            d[sym] = inst
        return inst

    def _submit_stock_order_fast(
        *,
        symbol: str,
        quantity: int,
        side: str,
        limit_price: float | None,
        stop_price: float | None,
        time_in_force: str,
        extended_hours: bool,
        market_hours: str = "regular_hours",
        quote: dict[str, Any] | None = None,
    ) -> Any:
        sym = (symbol or "").strip().upper()
        if not sym:
            raise ValueError("missing_symbol")
        if quantity <= 0:
            raise ValueError("invalid_qty")
        side_v = (side or "").strip().lower()
        if side_v not in {"buy", "sell"}:
            raise ValueError("invalid_side")

        if quote is None:
            quote = _rh_quote_snapshot(sym)

        ask = _safe_float(quote.get("ask_price"))
        bid = _safe_float(quote.get("bid_price"))
        last = _safe_float(quote.get("last_trade_price")) or _safe_float(quote.get("last_extended_hours_trade_price"))

        order_type = "market"
        trigger = "immediate"
        price = None
        stop_price_v = None

        if limit_price is not None and stop_price is not None:
            order_type = "limit"
            trigger = "stop"
            price = round_price(float(limit_price))
            stop_price_v = round_price(float(stop_price))
        elif limit_price is not None:
            order_type = "limit"
            price = round_price(float(limit_price))
        elif stop_price is not None:
            trigger = "stop"
            stop_price_v = round_price(float(stop_price))
            # Robin-stocks sets buy stop price=stop and sell stop price price=None.
            if side_v == "buy":
                price = stop_price_v
        else:
            # Market order: RH expects a price for buys (robin-stocks uses ask/bid).
            ref = ask if side_v == "buy" else bid
            if ref is None or ref <= 0:
                ref = last
            if ref is None or ref <= 0:
                raise RuntimeError("quote_unavailable")
            price = round_price(float(ref))

        account_url = _rh_cached_account_url()
        instrument_url = _rh_instrument_url(sym, quote)

        payload: dict[str, Any] = {
            "account": account_url,
            "instrument": instrument_url,
            "symbol": sym,
            "price": price,
            "ask_price": round_price(float(ask or price or 0.0)),
            "bid_ask_timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f"),
            "bid_price": round_price(float(bid or price or 0.0)),
            "quantity": int(quantity),
            "ref_id": str(uuid4()),
            "type": order_type,
            "stop_price": stop_price_v,
            "time_in_force": time_in_force,
            "trigger": trigger,
            "side": side_v,
            "market_hours": market_hours,
            "extended_hours": bool(extended_hours),
            "order_form_version": 4,
        }

        if order_type == "market":
            if trigger != "stop":
                payload.pop("stop_price", None)

        if market_hours == "regular_hours":
            if side_v == "buy":
                # Match robin-stocks behavior: buys in regular hours are submitted as limit orders with a preset collar.
                payload["preset_percent_limit"] = "0.05"
                payload["type"] = "limit"
            elif order_type == "market" and side_v == "sell":
                payload.pop("price", None)
        elif market_hours in ("extended_hours", "all_day_hours"):
            payload["type"] = "limit"
            payload["quantity"] = int(payload["quantity"])

        url = orders_url()
        return request_post(url, payload, jsonify_data=True)

    async def _cache_stop_order(symbol: str, order_id: str, stop_price: float | None = None) -> None:
        sym = (symbol or "").strip().upper()
        oid = (order_id or "").strip()
        if not sym or not oid:
            return
        payload: dict[str, Any] = {"id": oid, "ts": datetime.now(tz=UTC).isoformat()}
        if stop_price is not None and math.isfinite(float(stop_price)) and float(stop_price) > 0:
            payload["stop_price"] = float(stop_price)
        async with stop_lock:
            stop_cache[sym] = payload

    async def _get_cached_stop_order_id(symbol: str) -> str | None:
        sym = (symbol or "").strip().upper()
        if not sym:
            return None
        async with stop_lock:
            v = stop_cache.get(sym) or {}
        oid = v.get("id")
        return oid.strip() if isinstance(oid, str) and oid.strip() else None

    async def _clear_cached_stop_order(symbol: str, order_id: str | None = None) -> None:
        sym = (symbol or "").strip().upper()
        if not sym:
            return
        async with stop_lock:
            if order_id is None:
                stop_cache.pop(sym, None)
                return
            cur = stop_cache.get(sym) or {}
            cur_id = cur.get("id")
            if isinstance(cur_id, str) and cur_id.strip() == str(order_id).strip():
                stop_cache.pop(sym, None)

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
        with _urlopen(req, timeout=12) as resp:
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

    def _alpaca_stream_endpoint() -> str:
        endpoint = (os.getenv("ALPACA_WS_ENDPOINT") or "").strip()
        if not endpoint:
            feed = (os.getenv("ALPACA_FEED") or os.getenv("ALPACA_DATA_FEED") or "iex").strip()
            endpoint = f"v2/{feed}"
        endpoint = endpoint.strip().lstrip("/")
        return endpoint or "v2/iex"

    def _alpaca_stream_url() -> str:
        return f"wss://stream.data.alpaca.markets/{_alpaca_stream_endpoint()}"

    def _alpaca_market_keys() -> tuple[str, str]:
        api_key = (os.getenv("ALPACA_API_KEY") or os.getenv("APCA_API_KEY_ID") or "").strip()
        api_secret = (os.getenv("ALPACA_API_SECRET") or os.getenv("APCA_API_SECRET_KEY") or "").strip()
        return api_key, api_secret

    async def _queue_put_drop_oldest(queue: asyncio.Queue, item: Any) -> None:
        try:
            queue.put_nowait(item)
            return
        except asyncio.QueueFull:
            pass
        try:
            _ = queue.get_nowait()
        except Exception:
            pass
        try:
            queue.put_nowait(item)
        except Exception:
            pass

    async def _alpaca_trade_producer(symbol: str, queue: asyncio.Queue, stop: asyncio.Event) -> None:
        try:
            import websockets  # type: ignore
        except Exception as exc:
            await _queue_put_drop_oldest(queue, {"type": "error", "message": f"missing_dependency: {exc!r}"})
            return

        api_key, api_secret = _alpaca_market_keys()
        if not api_key or not api_secret:
            await _queue_put_drop_oldest(queue, {"type": "error", "message": "missing_alpaca_credentials"})
            return

        url = _alpaca_stream_url()
        ssl_ctx = _build_https_context()
        sym = (symbol or "").strip().upper()
        if not sym:
            await _queue_put_drop_oldest(queue, {"type": "error", "message": "missing_symbol"})
            return

        while not stop.is_set():
            try:
                await _queue_put_drop_oldest(queue, {"type": "status", "status": "connecting", "symbol": sym})
                async with websockets.connect(url, ping_interval=20, ping_timeout=20, ssl=ssl_ctx) as ws:
                    await ws.send(json.dumps({"action": "auth", "key": api_key, "secret": api_secret}))
                    await ws.send(json.dumps({"action": "subscribe", "trades": [sym]}))
                    await _queue_put_drop_oldest(queue, {"type": "status", "status": "subscribed", "symbol": sym})

                    async for raw in ws:
                        if stop.is_set():
                            break
                        try:
                            payload = json.loads(raw)
                        except Exception:
                            continue
                        msgs = payload if isinstance(payload, list) else [payload]
                        for msg in msgs:
                            if not isinstance(msg, dict):
                                continue
                            t = msg.get("T")
                            if t in {"success", "subscription"}:
                                continue
                            if t == "error":
                                await _queue_put_drop_oldest(
                                    queue,
                                    {
                                        "type": "error",
                                        "code": msg.get("code"),
                                        "message": msg.get("msg") or msg.get("message") or "alpaca_error",
                                    },
                                )
                                return
                            if t == "t":
                                await _queue_put_drop_oldest(
                                    queue,
                                    {
                                        "type": "trade",
                                        "symbol": msg.get("S") or sym,
                                        "ts": msg.get("t"),
                                        "price": msg.get("p"),
                                        "size": msg.get("s"),
                                        "exchange": msg.get("x"),
                                        "id": msg.get("i"),
                                    },
                                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await _queue_put_drop_oldest(queue, {"type": "error", "message": repr(exc)})
                await asyncio.sleep(0.8)

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
        with _urlopen(req, timeout=20) as resp:
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

    def _refresh_unconfirmed_orders(order_type: str) -> bool:
        raw = (os.getenv("RH_REFRESH_UNCONFIRMED") or "").strip().lower()
        if not raw or raw == "auto":
            return order_type == "limit"
        return raw in {"1", "true", "t", "yes", "y", "on"}

    def _fast_orders_enabled() -> bool:
        # robin_stocks' built-in order helpers call multiple quote endpoints per order.
        # This project uses a faster single-quote snapshot + direct orders POST by default.
        return _env_bool("RH_FAST_ORDERS", True)

    def _auto_stop_config(payload: BuyRequest) -> dict[str, Any]:
        enabled = payload.auto_stop if payload.auto_stop is not None else _env_bool("AUTO_STOP_ENABLED", False)
        max_wait_s = _env_float("AUTO_STOP_MAX_WAIT_S", 12.0)
        alpaca_feed = _env_str("ALPACA_DATA_FEED", "iex")
        alpaca_data_base = _env_str("ALPACA_DATA_BASE_URL", "https://data.alpaca.markets/v2")
        return {
            "enabled": bool(enabled),
            "max_wait_s": max_wait_s,
            "alpaca_feed": alpaca_feed,
            "alpaca_data_base": alpaca_data_base,
        }

    def _buy_by_price_allows_auto_stop(payload: BuyRequest) -> bool:
        # When buying by dollars with a market order, we can submit a faster fractional-by-price order.
        # Stop-losses can only be placed for whole shares with this implementation, so we place the stop
        # after the fill for the whole-share portion that appears in the position.
        #
        # Setting RH_BUY_DOLLARS_WHOLE_SHARES=1 forces the older quote->whole-share path.
        if _env_bool("RH_BUY_DOLLARS_WHOLE_SHARES", False):
            return False
        return normalize_order_type(payload.order_type) == "market" and payload.amount_usd is not None

    def _sell_cancel_mode() -> str:
        # Controls whether we cancel open sell orders (typically stop-losses) before submitting a sell.
        # - "stop" (default): cancel only stop-like sell orders (trigger=stop / stop_price / trailing_*).
        # - "all": cancel any open *sell* order for the symbol.
        # - "none"/"0": don't cancel anything (may cause insufficient shares errors).
        raw = (os.getenv("RH_SELL_CANCEL_OPEN") or "").strip().lower()
        if not raw:
            raw = "stop"
        if raw in {"0", "off", "false", "none", "no"}:
            return "none"
        if raw in {"1", "true", "on", "yes", "y"}:
            return "stop"
        if raw in {"all", "any"}:
            return "all"
        if raw in {"stop", "stops", "stoploss", "stop_loss"}:
            return "stop"
        return "stop"

    def _is_stop_like_order(order: dict[str, Any]) -> bool:
        trigger = str(order.get("trigger") or "").strip().lower()
        if trigger == "stop":
            return True
        if order.get("stop_price") not in (None, "", "0", 0):
            return True
        if order.get("trailing_amount") not in (None, "", "0", 0):
            return True
        if order.get("trailing_percent") not in (None, "", "0", 0):
            return True
        typ = str(order.get("type") or "").strip().lower()
        if "stop" in typ or "trail" in typ:
            return True
        return False

    def cancel_open_sell_orders_for_symbol(symbol: str, mode: str) -> dict[str, Any]:
        sym = (symbol or "").strip().upper()
        if not sym:
            return {"ok": False, "error": "missing_symbol", "canceled": [], "attempted": 0}
        mode_v = (mode or "").strip().lower()
        if mode_v not in {"stop", "all"}:
            return {"ok": True, "mode": "none", "canceled": [], "attempted": 0}

        inst_url = None
        try:
            inst_url = _rh_instrument_url(sym)
        except Exception:
            inst_url = None

        canceled: list[str] = []
        attempted = 0
        errors: list[str] = []

        orders = rh.orders.get_all_open_stock_orders() or []
        if not isinstance(orders, list):
            orders = []

        for o in orders:
            if not isinstance(o, dict):
                continue
            side = str(o.get("side") or "").strip().lower()
            if side != "sell":
                continue
            o_sym = str(o.get("symbol") or "").strip().upper()
            if o_sym and o_sym != sym:
                continue
            if not o_sym and inst_url and str(o.get("instrument") or "").strip() != inst_url:
                continue
            if mode_v == "stop" and not _is_stop_like_order(o):
                continue

            order_id = o.get("id")
            if not isinstance(order_id, str) or not order_id.strip():
                continue
            order_id = order_id.strip()
            attempted += 1
            try:
                rh.orders.cancel_stock_order(order_id)
                canceled.append(order_id)
            except Exception as exc:
                errors.append(f"{order_id}:{type(exc).__name__}")

        return {"ok": not errors, "mode": mode_v, "canceled": canceled, "attempted": attempted, "errors": errors}

    def _is_insufficient_shares_error(detail: str | None) -> bool:
        if not detail:
            return False
        s = str(detail).strip().lower()
        if not s:
            return False
        needles = [
            "insufficient",
            "not enough shares",
            "not enough shares to",
            "exceeds available",
            "insufficient shares",
        ]
        return any(n in s for n in needles)

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
        with _urlopen(req, timeout=12) as resp:
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

    def _alpaca_credentials() -> tuple[str, str] | None:
        api_key = (os.getenv("ALPACA_API_KEY") or os.getenv("APCA_API_KEY_ID") or "").strip()
        api_secret = (os.getenv("ALPACA_API_SECRET") or os.getenv("APCA_API_SECRET_KEY") or "").strip()
        if not api_key or not api_secret:
            return None
        return api_key, api_secret

    def _alpaca_feed(feed: str) -> str:
        f = (feed or "").strip().lower() or "iex"
        return f if f in {"iex", "sip"} else "iex"

    def fetch_alpaca_bars_multi(
        symbols: list[str],
        *,
        start: datetime,
        end: datetime,
        timeframe: str,
        data_base: str,
        feed: str,
        limit: int = 10_000,
    ) -> dict[str, list[dict[str, Any]]]:
        creds = _alpaca_credentials()
        if not creds:
            raise RuntimeError("missing_alpaca_credentials")
        api_key, api_secret = creds

        base = (data_base or "").strip() or "https://data.alpaca.markets/v2"
        feed = _alpaca_feed(feed)
        if not symbols:
            return {}
        # Alpaca paginates with page_token; keep pulling until empty.
        page_token: str | None = None
        out: dict[str, list[dict[str, Any]]] = {}
        for s in symbols:
            out[str(s).strip().upper()] = []

        for _ in range(20):  # hard cap pages to avoid infinite loops
            params = {
                "symbols": ",".join(symbols),
                "timeframe": timeframe,
                "start": start.isoformat().replace("+00:00", "Z"),
                "end": end.isoformat().replace("+00:00", "Z"),
                "limit": str(int(limit)),
                "adjustment": "raw",
                "feed": feed,
            }
            if page_token:
                params["page_token"] = page_token
            url = f"{base.rstrip('/')}/stocks/bars?{urllib.parse.urlencode(params)}"
            req = urllib.request.Request(
                url,
                headers={
                    "APCA-API-KEY-ID": api_key,
                    "APCA-API-SECRET-KEY": api_secret,
                    "Accept": "application/json",
                    "User-Agent": "RHWidget/0.1 (+local)",
                },
            )
            with _urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            bars_by_symbol = data.get("bars") if isinstance(data, dict) else None
            if isinstance(bars_by_symbol, dict):
                for sym, bars in bars_by_symbol.items():
                    if not isinstance(sym, str) or not isinstance(bars, list):
                        continue
                    key = sym.strip().upper()
                    if key not in out:
                        out[key] = []
                    out[key].extend([b for b in bars if isinstance(b, dict)])
            page_token = data.get("next_page_token") if isinstance(data, dict) else None
            if not page_token:
                break
        return out

    def _parse_hhmm(value: str, default: str = "04:00") -> tuple[int, int]:
        s = (value or "").strip() or default
        try:
            parts = s.split(":")
            hh = int(parts[0])
            mm = int(parts[1]) if len(parts) > 1 else 0
            hh = min(max(hh, 0), 23)
            mm = min(max(mm, 0), 59)
            return hh, mm
        except Exception:
            return _parse_hhmm(default, default=default)

    def _nth_weekday_of_month(year: int, month: int, weekday: int, n: int) -> datetime:
        # weekday: Monday=0 .. Sunday=6
        first = datetime(year, month, 1, tzinfo=UTC)
        delta = (weekday - first.weekday()) % 7
        day = 1 + delta + (n - 1) * 7
        return datetime(year, month, day, tzinfo=UTC)

    def _us_eastern_offset(dt_utc: datetime) -> timedelta:
        # US/Eastern DST rules (since 2007): starts 2nd Sunday in March 02:00 local, ends 1st Sunday in Nov 02:00 local.
        # Compute boundaries in UTC:
        # - DST starts at 02:00 EST (UTC-5) => 07:00 UTC
        # - DST ends at 02:00 EDT (UTC-4) => 06:00 UTC
        if dt_utc.tzinfo is None:
            dt_utc = dt_utc.replace(tzinfo=UTC)
        year = dt_utc.year
        second_sunday_march_utc = _nth_weekday_of_month(year, 3, weekday=6, n=2)  # Sunday
        first_sunday_nov_utc = _nth_weekday_of_month(year, 11, weekday=6, n=1)  # Sunday
        dst_start_utc = second_sunday_march_utc.replace(hour=7, minute=0, second=0, microsecond=0)
        dst_end_utc = first_sunday_nov_utc.replace(hour=6, minute=0, second=0, microsecond=0)
        if dst_start_utc <= dt_utc < dst_end_utc:
            return timedelta(hours=-4)
        return timedelta(hours=-5)

    def _to_us_eastern(dt_utc: datetime) -> datetime:
        if dt_utc.tzinfo is None:
            dt_utc = dt_utc.replace(tzinfo=UTC)
        off = _us_eastern_offset(dt_utc)
        return dt_utc.astimezone(timezone(off))

    def _et_local_to_utc(local_naive: datetime) -> datetime:
        # Convert an ET local naive datetime to UTC using our DST rules.
        # Try EDT first then EST; for our configured session start times (04:00/09:30) it's unambiguous.
        guess_edt = local_naive.replace(tzinfo=timezone(timedelta(hours=-4))).astimezone(UTC)
        if _us_eastern_offset(guess_edt) == timedelta(hours=-4):
            return guess_edt
        return local_naive.replace(tzinfo=timezone(timedelta(hours=-5))).astimezone(UTC)

    async def rvol_loop() -> None:
        refresh_s = _env_float("RVOL_REFRESH_S", 60.0)
        refresh_s = min(max(refresh_s, 5.0), 600.0)
        lookback_days = int(_env_float("RVOL_LOOKBACK_DAYS", 20))
        lookback_days = min(max(lookback_days, 3), 60)
        timeframe = _env_str("RVOL_TIMEFRAME", "5Min")
        data_base = _env_str("ALPACA_DATA_BASE_URL", "https://data.alpaca.markets/v2")
        feed = _env_str("ALPACA_DATA_FEED", "iex")
        start_hh, start_mm = _parse_hhmm(_env_str("RVOL_SESSION_START_ET", "04:00"), default="04:00")

        while True:
            try:
                async with state_lock:
                    symbols = list(state.get("symbols") or [])
                symbols = [str(s).strip().upper() for s in symbols if str(s).strip()]
                symbols = list(dict.fromkeys(symbols))
                if not symbols:
                    # On startup the watcher populates symbols shortly after boot; don't sleep a full refresh period.
                    await asyncio.sleep(min(2.0, refresh_s))
                    continue

                now = datetime.now(tz=UTC)
                now_et = _to_us_eastern(now)
                today_et = now_et.date()
                session_start_today_utc = _et_local_to_utc(datetime(today_et.year, today_et.month, today_et.day, start_hh, start_mm))
                elapsed = now - session_start_today_utc
                if elapsed.total_seconds() < 0:
                    elapsed = timedelta(seconds=0)
                # Cap elapsed to 16 hours to avoid weird values (weekends/off-hours).
                elapsed = min(elapsed, timedelta(hours=16))

                # Pull enough history to cover weekends/holidays.
                start_range = now - timedelta(days=max(lookback_days * 3, 30))
                end_range = now

                merged: dict[str, dict[str, Any]] = {}
                # Chunk to avoid URL length issues.
                for i in range(0, len(symbols), 100):
                    chunk = symbols[i : i + 100]
                    bars_by_symbol = await asyncio.to_thread(
                        fetch_alpaca_bars_multi,
                        chunk,
                        start=start_range,
                        end=end_range,
                        timeframe=timeframe,
                        data_base=data_base,
                        feed=feed,
                    )

                    for sym in chunk:
                        bars = bars_by_symbol.get(sym) if isinstance(bars_by_symbol, dict) else None
                        if not isinstance(bars, list) or not bars:
                            merged[sym] = {
                                "today_volume": 0,
                                "expected_volume": None,
                                "rvol_pct": None,
                                "mode": "time_adjusted",
                            }
                            continue

                        # Sum volume from session start to (session start + elapsed) for each day.
                        sums_by_day: dict[str, int] = {}
                        session_start_cache: dict[str, datetime] = {}
                        for b in bars:
                            if not isinstance(b, dict):
                                continue
                            t = _parse_datetime(str(b.get("t") or ""))
                            if not t:
                                continue
                            v_raw = b.get("v")
                            if v_raw is None:
                                v_raw = b.get("volume")
                            try:
                                v = int(float(v_raw or 0))
                            except Exception:
                                continue
                            if v <= 0:
                                continue

                            t = t.astimezone(UTC)
                            t_et = _to_us_eastern(t)
                            day_key = t_et.date().isoformat()
                            session_start_utc = session_start_cache.get(day_key)
                            if session_start_utc is None:
                                d = t_et.date()
                                session_start_utc = _et_local_to_utc(datetime(d.year, d.month, d.day, start_hh, start_mm))
                                session_start_cache[day_key] = session_start_utc
                            cutoff_utc = session_start_utc + elapsed
                            if t < session_start_utc or t > cutoff_utc:
                                continue
                            sums_by_day[day_key] = int(sums_by_day.get(day_key, 0) + v)

                        today_key = today_et.isoformat()
                        today_sum = int(sums_by_day.get(today_key, 0))

                        # Use the most recent lookback_days with data (excluding today).
                        prev_keys = sorted(k for k in sums_by_day.keys() if k != today_key)
                        prev_vals = [int(sums_by_day[k]) for k in prev_keys if int(sums_by_day[k]) > 0]
                        prev_vals = prev_vals[-lookback_days:]
                        expected = (float(sum(prev_vals)) / float(len(prev_vals))) if prev_vals else None
                        rvol_pct = (float(today_sum) / float(expected) * 100.0) if expected and expected > 0 else None

                        merged[sym] = {
                            "today_volume": today_sum,
                            "expected_volume": expected,
                            "rvol_pct": rvol_pct,
                            "mode": "time_adjusted",
                            "timeframe": timeframe,
                            "session_start_et": f"{start_hh:02d}:{start_mm:02d}",
                            "lookback_days": lookback_days,
                        }

                async with state_lock:
                    state["rvol"] = merged
                    state["rvol_updated_at"] = datetime.now(tz=UTC).isoformat()
                    state["rvol_error"] = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                async with state_lock:
                    state["rvol_error"] = repr(exc)
                await asyncio.sleep(min(refresh_s, 30.0))
                continue
            await asyncio.sleep(refresh_s)

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

        def _describe_reject(info: Any) -> str:
            if not isinstance(info, dict):
                return "unknown_reject"
            reject = info.get("reject_reason")
            if isinstance(reject, str) and reject.strip():
                return reject.strip()
            detail = _order_error_detail(info)
            if detail:
                return detail
            return "unknown_reject"

        started = time.monotonic()
        while time.monotonic() - started < max_wait_s:
            pos_qty = await asyncio.to_thread(get_position_qty, symbol)
            delta = float(pos_qty) - float(before_qty)
            qty_available = int(math.floor(delta + 1e-6))
            qty_to_protect = min(intended_qty, qty_available)
            if qty_to_protect > 0:
                print(f"[trade] placing stop {symbol} qty={qty_to_protect} stop={stop_price}")

                # Stop orders generally behave best as GTC. If Robinhood rejects the TIF, retry with GFD once.
                for tif in ("gtc", "gfd"):
                    result = await asyncio.to_thread(
                        rh.orders.order_sell_stop_loss,
                        symbol,
                        qty_to_protect,
                        stop_price,
                        None,
                        tif,
                    )
                    order = await _refresh_stock_order(_require_order_ok(result))
                    order_id = order.get("id") or "-"
                    state = order.get("state") or "-"
                    if isinstance(order.get("id"), str) and order.get("id") and str(state) not in {"rejected", "failed", "canceled"}:
                        await _cache_stop_order(symbol, str(order["id"]), stop_price=float(stop_price))

                    info: Any = None
                    try:
                        if order.get("id"):
                            info = await asyncio.to_thread(rh.orders.get_stock_order_info, order["id"])
                    except Exception:
                        info = None

                    final_state = state
                    try:
                        if isinstance(info, dict) and isinstance(info.get("state"), str) and info.get("state"):
                            final_state = info.get("state")
                    except Exception:
                        final_state = state

                    if str(final_state) in {"rejected", "failed", "canceled"}:
                        reason = _describe_reject(info)
                        print(f"[trade] stop rejected {symbol} id={order_id} tif={tif} reason={reason}")
                        if "good til" in reason.lower() or "time_in_force" in reason.lower() or "tif" in reason.lower():
                            continue
                        return

                    print(f"[trade] stop placed {symbol} id={order_id} state={final_state} tif={tif}")
                    return
                return
            await asyncio.sleep(0.5)
        print(f"[trade] stop not placed {symbol} (timeout waiting for fill)")

    def get_position_qty(symbol: str) -> float:
        try:
            inst_url: str | None = None
            try:
                inst_url = _rh_instrument_url(symbol)
            except Exception:
                inst_url = None
            if not inst_url:
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

    @app.get("/api/tas/stream")
    async def time_and_sales_stream(request: Request, symbol: str = Query(...)) -> StreamingResponse:
        sym = (symbol or "").strip().upper()
        if not sym or sym in {"-", "â€”"}:
            raise HTTPException(status_code=400, detail="missing_symbol")

        api_key, api_secret = _alpaca_market_keys()
        if not api_key or not api_secret:
            raise HTTPException(status_code=502, detail="missing_alpaca_credentials")

        queue: asyncio.Queue = asyncio.Queue(maxsize=600)
        stop = asyncio.Event()
        producer = asyncio.create_task(_alpaca_trade_producer(sym, queue, stop))

        async def gen():
            try:
                yield f"data: {json.dumps({'type':'hello','symbol':sym}, separators=(',',':'))}\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        item = await asyncio.wait_for(queue.get(), timeout=15.0)
                        yield f"data: {json.dumps(item, separators=(',',':'))}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keep-alive\n\n"
            finally:
                stop.set()
                producer.cancel()
                try:
                    await producer
                except Exception:
                    pass

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-store",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
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
        order_type = normalize_order_type(payload.order_type)
        auto_stop_cfg = _auto_stop_config(payload)
        if auto_stop_cfg.get("enabled") and payload.stop_price is None and payload.stop_ref_price is None:
            raise HTTPException(status_code=400, detail="missing_stop_ref_price")
        before_qty = 0.0
        before_qty_task: asyncio.Task | None = None
        if auto_stop_cfg.get("enabled"):
            # Fetch baseline position concurrently with any quote fetch to reduce latency.
            before_qty_task = asyncio.create_task(asyncio.to_thread(get_position_qty, symbol))
        stop_info: dict[str, Any] | None = None
        intended_qty = 0

        if payload.amount_usd is not None:
            amount_usd = float(payload.amount_usd or 0)
            if amount_usd <= 0:
                raise HTTPException(status_code=400, detail="invalid_amount_usd")

            if order_type == "limit":
                if payload.limit_offset is not None:
                    quote_start = time.monotonic()
                    quote = await asyncio.to_thread(_rh_quote_snapshot, symbol)
                    last = _safe_float((quote or {}).get("last_trade_price")) or _safe_float((quote or {}).get("ask_price"))
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
                if before_qty_task is not None:
                    before_qty = float(await before_qty_task)
                    before_qty_task = None
                order_start = time.monotonic()
                if _fast_orders_enabled():
                    result = await asyncio.to_thread(
                        _submit_stock_order_fast,
                        symbol=symbol,
                        quantity=qty_whole,
                        side="buy",
                        limit_price=float(limit),
                        stop_price=None,
                        time_in_force="gfd",
                        extended_hours=False,
                        quote=locals().get("quote"),
                    )
                else:
                    result = await asyncio.to_thread(rh.orders.order_buy_limit, symbol, qty_whole, limit, None, "gfd")
                print(f"[trade] buy limit submit {symbol} {time.monotonic() - order_start:.3f}s")
                intended_qty = int(qty_whole)
            else:
                # Fast path for market buys by dollars: submit by-price (fractional) without fetching a quote.
                # If auto-stop is enabled, we place the stop after the fill for the whole-share portion that
                # appears in the position delta.
                if _buy_by_price_allows_auto_stop(payload):
                    amount_usd = round(float(amount_usd), 2)
                    if amount_usd < 0.01:
                        raise HTTPException(status_code=400, detail="amount_too_small_for_market")
                    order_start = time.monotonic()
                    result = await asyncio.to_thread(rh.orders.order_buy_fractional_by_price, symbol, amount_usd)
                    print(f"[trade] buy market $ submit {symbol} {time.monotonic() - order_start:.3f}s")
                    if auto_stop_cfg.get("enabled"):
                        intended_qty = 1_000_000_000  # protect all filled whole shares (position delta limits).
                else:
                    quote_start = time.monotonic()
                    quote = await asyncio.to_thread(_rh_quote_snapshot, symbol)
                    last = _safe_float((quote or {}).get("ask_price")) or _safe_float((quote or {}).get("last_trade_price"))
                    print(f"[trade] buy quote {symbol} {time.monotonic() - quote_start:.3f}s")
                    if last is None or last <= 0:
                        raise HTTPException(status_code=502, detail="quote_unavailable")
                    qty_whole = int(math.floor(amount_usd / float(last)))
                    if qty_whole <= 0:
                        raise HTTPException(status_code=400, detail="amount_too_small_for_market")
                    print(f"[trade] buy dollars->shares {symbol} ${amount_usd:.2f} @ {last:.4f} => {qty_whole} sh")
                    if before_qty_task is not None:
                        before_qty = float(await before_qty_task)
                        before_qty_task = None
                    order_start = time.monotonic()
                    if _fast_orders_enabled():
                        result = await asyncio.to_thread(
                            _submit_stock_order_fast,
                            symbol=symbol,
                            quantity=qty_whole,
                            side="buy",
                            limit_price=None,
                            stop_price=None,
                            time_in_force="gfd",
                            extended_hours=False,
                            quote=quote,
                        )
                    else:
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
                    quote = await asyncio.to_thread(_rh_quote_snapshot, symbol)
                    last = _safe_float((quote or {}).get("last_trade_price")) or _safe_float((quote or {}).get("ask_price"))
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
                if before_qty_task is not None:
                    before_qty = float(await before_qty_task)
                    before_qty_task = None
                order_start = time.monotonic()
                if _fast_orders_enabled():
                    result = await asyncio.to_thread(
                        _submit_stock_order_fast,
                        symbol=symbol,
                        quantity=qty_whole,
                        side="buy",
                        limit_price=float(limit),
                        stop_price=None,
                        time_in_force="gfd",
                        extended_hours=False,
                        quote=locals().get("quote"),
                    )
                else:
                    result = await asyncio.to_thread(rh.orders.order_buy_limit, symbol, qty_whole, limit, None, "gfd")
                print(f"[trade] buy limit submit {symbol} {time.monotonic() - order_start:.3f}s")
            else:
                if before_qty_task is not None:
                    before_qty = float(await before_qty_task)
                    before_qty_task = None
                order_start = time.monotonic()
                if _fast_orders_enabled():
                    result = await asyncio.to_thread(
                        _submit_stock_order_fast,
                        symbol=symbol,
                        quantity=qty_whole,
                        side="buy",
                        limit_price=None,
                        stop_price=None,
                        time_in_force="gfd",
                        extended_hours=False,
                        quote=None,
                    )
                else:
                    result = await asyncio.to_thread(rh.orders.order_buy_market, symbol, qty_whole, None, "gfd")
                print(f"[trade] buy market submit {symbol} {time.monotonic() - order_start:.3f}s")
            intended_qty = int(qty_whole)

        if before_qty_task is not None:
            before_qty = float(await before_qty_task)
            before_qty_task = None

        if auto_stop_cfg.get("enabled"):
            try:
                explicit_stop = float(payload.stop_price) if payload.stop_price is not None else None
                ref_price = float(payload.stop_ref_price) if payload.stop_ref_price is not None else None

                source = "cursor"
                if explicit_stop is not None:
                    stop_price = round_price(explicit_stop)
                    source = "explicit"
                elif ref_price is not None:
                    stop_price = round_price(ref_price)
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
                        "ref_price": ref_price if source == "cursor" else None,
                    }
            except Exception as exc:
                stop_info = {"enabled": True, "status": "error", "error": repr(exc)}
        else:
            stop_info = {"enabled": False}
        print(f"[trade] buy total {symbol} {time.monotonic() - start_ts:.3f}s")
        order0 = _require_order_ok(result)
        order = await _refresh_stock_order(order0) if _refresh_unconfirmed_orders(order_type) else order0
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
        preflight: dict[str, Any] | None = None
        mode = _sell_cancel_mode()
        cancel_task: asyncio.Task | None = None

        cached_stop_id = await _get_cached_stop_order_id(symbol)
        if cached_stop_id:
            preflight = {"mode": mode, "cached_stop_id": cached_stop_id, "canceled": [], "attempted": 0}

            async def _cancel_cached() -> dict[str, Any]:
                try:
                    await asyncio.to_thread(rh.orders.cancel_stock_order, cached_stop_id)
                    await _clear_cached_stop_order(symbol, cached_stop_id)
                    return {"ok": True, "canceled": [cached_stop_id], "attempted": 1}
                except Exception as exc:
                    return {"ok": False, "error": repr(exc), "canceled": [], "attempted": 1}

            cancel_task = asyncio.create_task(_cancel_cached())
        elif mode != "none":
            try:
                preflight = await asyncio.to_thread(cancel_open_sell_orders_for_symbol, symbol, mode)
            except Exception as exc:
                preflight = {"ok": False, "mode": mode, "error": repr(exc), "canceled": [], "attempted": 0}

        qty = await asyncio.to_thread(get_position_qty, symbol)
        if qty <= 0:
            raise HTTPException(status_code=400, detail="no_position")
        order_type = normalize_order_type(payload.order_type)
        if order_type == "limit":
            if payload.limit_offset is not None:
                quote_start = time.monotonic()
                quote = await asyncio.to_thread(_rh_quote_snapshot, symbol)
                last = _safe_float((quote or {}).get("last_trade_price")) or _safe_float((quote or {}).get("bid_price"))
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
            if _fast_orders_enabled():
                result = await asyncio.to_thread(
                    _submit_stock_order_fast,
                    symbol=symbol,
                    quantity=qty_whole,
                    side="sell",
                    limit_price=float(limit),
                    stop_price=None,
                    time_in_force="gfd",
                    extended_hours=False,
                    quote=locals().get("quote"),
                )
            else:
                result = await asyncio.to_thread(rh.orders.order_sell_limit, symbol, qty_whole, limit, None, "gfd")
            print(f"[trade] sell limit submit {symbol} {time.monotonic() - order_start:.3f}s")
        else:
            qty_is_whole = abs(qty - round(qty)) < 1e-6
            max_attempts = 3
            delays = (0.0, 0.18, 0.35)
            result: Any = None
            for attempt in range(max_attempts):
                if attempt < len(delays) and delays[attempt] > 0:
                    await asyncio.sleep(delays[attempt])

                order_start = time.monotonic()
                if qty_is_whole:
                    if _fast_orders_enabled():
                        result = await asyncio.to_thread(
                            _submit_stock_order_fast,
                            symbol=symbol,
                            quantity=int(round(qty)),
                            side="sell",
                            limit_price=None,
                            stop_price=None,
                            time_in_force="gfd",
                            extended_hours=False,
                            quote=None,
                        )
                    else:
                        result = await asyncio.to_thread(rh.orders.order_sell_market, symbol, int(round(qty)), None, "gfd")
                else:
                    qty_frac = round(float(qty), 6)
                    result = await asyncio.to_thread(rh.orders.order_sell_fractional_by_quantity, symbol, qty_frac)
                print(f"[trade] sell market submit {symbol} {time.monotonic() - order_start:.3f}s")

                detail = _order_error_detail(result)
                _, _, reject_reason = _order_state(result)
                merged_detail = reject_reason or detail
                if _is_insufficient_shares_error(merged_detail) and attempt + 1 < max_attempts:
                    cancel_info: dict[str, Any] | None = None
                    if cancel_task is not None and not cancel_task.done():
                        try:
                            cancel_info = await cancel_task
                            if isinstance(preflight, dict) and isinstance(cancel_info, dict):
                                preflight["cached_cancel"] = cancel_info
                        except Exception:
                            pass
                    should_fallback_scan = mode != "none" and attempt == 0 and (
                        not cached_stop_id or (isinstance(cancel_info, dict) and cancel_info.get("ok") is False)
                    )
                    if should_fallback_scan:
                        try:
                            preflight = await asyncio.to_thread(cancel_open_sell_orders_for_symbol, symbol, mode)
                        except Exception:
                            pass
                    continue
                break
        print(f"[trade] sell total {symbol} {time.monotonic() - start_ts:.3f}s")
        order0 = _require_order_ok(result)
        order = await _refresh_stock_order(order0) if _refresh_unconfirmed_orders(order_type) else order0
        if cancel_task is not None and isinstance(preflight, dict) and "cached_cancel" not in preflight:
            try:
                cancel_info = await asyncio.wait_for(cancel_task, timeout=0.35)
                if isinstance(cancel_info, dict):
                    preflight["cached_cancel"] = cancel_info
            except Exception:
                pass
        return JSONResponse({"ok": True, "order": order, "result": result, "preflight": preflight})

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

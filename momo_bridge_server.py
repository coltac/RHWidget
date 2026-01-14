from __future__ import annotations

import argparse
import asyncio
import os
import pickle
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException
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
    qty: float = 1.0
    order_type: str = "market"
    limit_price: float | None = None
    limit_offset: float | None = None
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

    def get_position_qty(symbol: str) -> float:
        try:
            instrument = rh.stocks.get_instrument_by_symbol(symbol)
            inst_url = instrument.get("url") if instrument else None
            if not inst_url:
                return 0.0
            positions = rh.account.get_open_stock_positions() or []
            for pos in positions:
                if pos.get("instrument") == inst_url:
                    return float(pos.get("quantity") or 0)
        except Exception:
            return 0.0
        return 0.0

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

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
        await ensure_logged_in()
        symbol = (payload.symbol or "").strip().upper()
        if not symbol:
            raise HTTPException(status_code=400, detail="missing_symbol")
        qty = float(payload.qty or 0)
        if qty <= 0:
            raise HTTPException(status_code=400, detail="invalid_qty")
        order_type = normalize_order_type(payload.order_type)
        if order_type == "limit":
            if payload.limit_offset is not None:
                last = await asyncio.to_thread(get_latest_price, symbol)
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
            result = await asyncio.to_thread(rh.orders.order_buy_limit, symbol, qty, limit, None, "gfd")
        else:
            result = await asyncio.to_thread(rh.orders.order_buy_market, symbol, qty)
        return JSONResponse({"ok": True, "result": result})

    @app.post("/api/trade/sell")
    async def trade_sell(payload: SellRequest = Body(...)) -> JSONResponse:
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
                last = await asyncio.to_thread(get_latest_price, symbol)
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
            result = await asyncio.to_thread(rh.orders.order_sell_limit, symbol, qty, limit, None, "gfd")
        else:
            result = await asyncio.to_thread(rh.orders.order_sell_market, symbol, qty)
        return JSONResponse({"ok": True, "result": result})

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

# Claude Code Session Plan — Automated Trading System Integration

**Goal:** Add a configurable, auto-executing trading engine to an existing website. Rule-based core first; optional ML signal layer second. Paper-trading enforced until a strategy survives live forward-testing.

> ⚠️ Not financial advice. Backtested edge ≠ live edge. Every phase below is gated on the prior one proving out on paper money. Do not connect real funds until Phase 6.

---

## 0. Pre-Session Context to Hand Claude Code

Before starting, tell Claude Code:
- **Existing stack** — framework (Next.js / Express / Django / Rails?), DB (Postgres / SQLite / Mongo?), auth method, hosting (the OptiPlex homelab? a VPS? Vercel?).
- **Asset class** — stocks, crypto, or both. This decides the broker/exchange layer.
- **Where it runs** — the trading loop is a *long-running background process*, NOT serverless. It needs a persistent host. The OptiPlex 7050 already runs 24/7 services and is ideal.

**Critical architecture note:** a trading bot is a stateful daemon, not a request/response endpoint. The website is the *control panel*; the bot is a *separate worker process*. Do not try to run the trading loop inside web request handlers.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  EXISTING WEBSITE (control panel + dashboard)            │
│  - Strategy config UI    - Live positions / P&L view    │
│  - Start/stop controls   - Backtest results display     │
└───────────────┬─────────────────────────────────────────┘
                │ REST / WebSocket
┌───────────────▼─────────────────────────────────────────┐
│  TRADING API SERVICE (FastAPI)                          │
│  - CRUD strategies   - Trigger backtests                │
│  - Read positions    - Enqueue start/stop commands      │
└───────────────┬─────────────────────────────────────────┘
                │ shared DB + message/flag
┌───────────────▼─────────────────────────────────────────┐
│  TRADING WORKER (persistent daemon, runs on OptiPlex)   │
│  - Data feed → Signal → Risk check → Execution → Log    │
│  - One loop per active strategy                         │
└───────────────┬─────────────────────────────────────────┘
                │ broker/exchange API
        ┌───────▼────────┐
        │ Alpaca (stocks)│  paper=True until Phase 6
        │ ccxt  (crypto) │
        └────────────────┘
```

**Why FastAPI as a sidecar instead of building trading into the existing backend:** keeps the Python ML/trading ecosystem (pandas, vectorbt, ccxt, alpaca-py) isolated from the web app, and lets the worker run independently of web traffic. The website talks to it over HTTP. If the existing site is already Python (Django/Flask), you can merge them — but keep the worker as a separate process either way.

---

## 2. APIs & Libraries Needed

### Broker / Exchange
| Need | Library | Notes |
|------|---------|-------|
| Stocks | `alpaca-py` | Commission-free, free paper account w/ real market data. Start here. |
| Crypto | `ccxt` | One interface, ~100 exchanges. Use exchange's testnet/sandbox where available. |
| Market data (extra) | `yfinance`, Alpaca data API, exchange WS | For history/backtests + live ticks. |

### Trading / Analysis
| Need | Library |
|------|---------|
| Backtesting | `vectorbt` (fast, vectorized) or `backtesting.py` (simpler) |
| Indicators | `pandas-ta` or `ta-lib` |
| Data wrangling | `pandas`, `numpy` |
| API service | `fastapi`, `uvicorn` |
| Scheduling | `apscheduler` (in-process) or system cron/Task Scheduler |
| Optional ML | `scikit-learn` first; `pytorch` only if you go deep |

### Secrets
- API keys in env vars / `.env` (gitignored), **never** committed.
- Exchange keys: **trade permission only, withdrawal DISABLED, IP-whitelisted** to the OptiPlex.

---

## 3. Data Model (add to existing DB)

```
strategies
  id, user_id, name, asset_class, symbol(s),
  signal_type (rule|ml), params (JSON), risk_params (JSON),
  status (draft|backtested|paper|live|stopped), created_at, updated_at

backtests
  id, strategy_id, start_date, end_date,
  total_return, sharpe, max_drawdown, win_rate, trades_json, created_at

positions
  id, strategy_id, symbol, qty, avg_entry, current_price, unrealized_pnl, opened_at

trade_log
  id, strategy_id, symbol, side, qty, price, mode (paper|live),
  signal_reason, broker_order_id, executed_at

bot_state
  strategy_id, is_running, last_heartbeat, last_error
```

`bot_state.last_heartbeat` lets the dashboard show whether a worker is actually alive.

---

## 4. The Signal Layer (the actual "AI/strategy")

The signal function is the whole game. Everything else is plumbing. Standard interface:

```python
def generate_signal(df: pd.DataFrame, params: dict) -> Signal:
    # df: recent OHLCV. Returns BUY / SELL / HOLD + reason + confidence
    ...
```

### Phase A — Rule-based (build first)
Start with proven, debuggable strategies. These are what most profitable retail bots actually run:
- Moving-average crossover (fast/slow)
- RSI mean reversion (buy oversold, sell overbought)
- Breakout (price exits N-period range)

Each is a few lines of pandas. They're transparent — when it makes a bad trade you can see exactly why.

### Phase B — ML signal layer (optional, ONLY after a rule baseline works)

> Reality check: ML on raw price data overfits brutally and rarely beats simple rules live. The point of the rule baseline is to have something to *beat*. If the ML model can't beat MA-crossover on out-of-sample data, don't ship it.

**If pursued, structure:**
- **Framing:** classification (next-bar up/down/flat) is more robust than price regression. Don't predict exact prices.
- **Features:** technical indicators (RSI, MACD, ATR, volume deltas, rolling returns/vol), NOT raw prices. Normalize per-window to avoid lookahead.
- **Model progression:**
  1. `RandomForest` / `GradientBoosting` (sklearn) — strong baseline, hard to overfit, fast.
  2. `XGBoost` / `LightGBM` — if trees help, push here next.
  3. LSTM / Temporal CNN (PyTorch) — only if 1–2 show real signal. Sequence models for time series; heavy, slow, easy to overfit. Likely overkill.
- **Validation:** **walk-forward / purged time-series CV only.** Never random k-fold on time series — it leaks the future into training and produces fake accuracy.
- **Output:** model emits probability → threshold → BUY/SELL/HOLD, same `Signal` interface as rules. Fully swappable.
- **The trap to avoid:** lookahead bias. Any feature using future data inflates backtest results and dies live. Audit every feature for this.

---

## 5. Execution + Risk Layer

Between signal and order, a **non-negotiable risk gate**:
- Position sizing (% of equity per trade, hard cap)
- Max open positions
- Max daily loss → kill switch halts the strategy
- Stop-loss / take-profit on every entry
- Slippage + fee modeling in backtests (a strategy profitable before fees is often a loser after)

```
signal → risk_check() → if approved → broker.submit_order() → log → update positions
```

Idempotency: never submit a duplicate order on worker restart. Reconcile against broker's actual open orders on every loop start.

---

## 6. Build Order for the Session (gated phases)

1. **Scaffold** — FastAPI service + worker skeleton + DB migrations. Wire `paper=True` Alpaca / sandbox ccxt. Confirm a paper order round-trips.
2. **Data + one rule signal** — pull OHLCV, implement MA-crossover, return a `Signal`.
3. **Backtest harness** — run signal over history, output return/Sharpe/drawdown/win-rate. *Most ideas die here — that's success, not failure.*
4. **Paper worker** — daemon loop: fetch → signal → risk → paper-execute → log. Run on the OptiPlex via cron/scheduler, 24/7, like the Minecraft servers.
5. **Website integration** — config UI, dashboard (positions/P&L/heartbeat), start/stop, backtest viewer. Talks to FastAPI.
6. **Live (gated)** — only after a strategy survives *weeks* of paper forward-testing with acceptable drawdown. Flip `paper=False`, start with the smallest possible size. Keep the kill switch one click away.
7. **(Optional) ML layer** — Phase 4B above, benchmarked against the rule baseline. Ship only if it wins out-of-sample.

---

## 7. Pitfalls to Have Claude Code Guard Against

- **Lookahead bias** in features/backtests — single biggest source of fake profitability.
- **Overfitting** — a strategy tuned to past data with 12 parameters will fail forward. Fewer params, walk-forward validation.
- **Serverless trap** — the loop must run on a persistent host, not in web request handlers or serverless functions.
- **Duplicate orders** on restart — reconcile with broker state before acting.
- **Unprotected API keys** — env vars, withdrawal-disabled, IP-whitelisted.
- **No fee/slippage modeling** — backtests without these lie.
- **Treating paper success as guaranteed live success** — it isn't, but it's the minimum bar.

---

## 8. Open Questions to Resolve Before Coding

1. Existing site stack + DB + host? (decides merge-vs-sidecar and where the worker lives)
2. Stocks, crypto, or both? (Alpaca vs ccxt vs both)
3. Single-user (just you) or multi-user platform? (changes auth, isolation, key storage)
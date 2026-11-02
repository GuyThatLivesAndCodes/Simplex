# Simplex — private, encrypted, multi-account workspace

Self-hosted private workspace. A dashboard of apps — starting with **Database**, an
encrypted file vault — built on a vanilla-JS frontend + Express 5 / better-sqlite3 /
multer backend. Every account gets its own **encrypted** 200 GB vault; all data is
encrypted at rest with backend-only keys.

## Run

```bash
npm start                 # node server.js, http://localhost:3824
```

`npm start` runs `run.js` — a tiny supervisor that launches `server.js` and
relaunches it automatically when a restart is requested (see **Restarts** below)
or if it crashes. `server.js` serves both the API and the static frontend on one
port. (`npm run start:direct` runs `server.js` with no supervisor if you ever want
that — but then restarts just shut the process down instead of relaunching.)

First boot creates an **admin** account — username `admin`, password `1234`.
**Change the password immediately** in the app (account menu → My account).

- `PORT` — override the port (default `3824`).
- `SIMPLEX_MASTER_KEY` — supply the master key via env (hex or base64) instead of the
  key file. Useful for keeping the key off the disk / in a secret manager.

## Boot guard

`boot-guard.js` loads first and keeps the page from silently failing:

- All `fetch`es get a timeout, so a hung request can't freeze the UI forever
  (uploads/streams opt out with `{ noTimeout: true }`).
- A genuine JS error during boot shows a real crash overlay (with a copyable report)
  instead of a blank screen, and POSTs the report to `/api/crash` (`vault/crash.log`).

`GET /api/health` is a plain liveness check (returns `{ ok: true }`); use it for an
uptime monitor or a container healthcheck if you want one.

## Restarts

The server restarts to pick up code/backend changes. The `run.js` supervisor
relaunches a fresh process on each restart (exit code `87`).

- **Scheduled** — automatically at admin-configured weekly times (default
  **Monday 9:00 AM** and **Friday 12:00 PM**, server-local time). Edit from
  account menu → *Settings* → *Server* → *Edit schedule*, or via
  `GET`/`PATCH /api/restart-schedule` (admin-only). The schedule is stored in the
  system settings table under `restart.schedule` as
  `{ enabled, slots: [{ day: 0–6 (0=Sun), time: "HH:MM" }] }`.
- **Manual** — admins: account menu → *Settings* → *Server* → *Restart now*
  (`POST /api/restart`, admin-only).

When a restart begins, the server flags it for a few seconds before exiting. Every
connected client (and anyone who reloads or joins during the window) shows a
"server is restarting" gate: the whole UI zooms out and a panel drops in with a
spinner. Clients keep polling `GET /api/restart-status` (public) through the brief
downtime and **hard-reload everyone** the moment the fresh process is back, so all
changes take effect for all users at once.

Tunables (env): `SX_RESTART_GRACE_MS` (default 12000 — the window between
"restart requested" and the process exiting), `SX_RESTART_SCHEDULE_OFF=1` to
disable the weekly scheduler entirely (manual restarts still work).

## Diagnosing freezes / crashes (`vault/diag.log`)

The server writes a one-line vitals snapshot every ~2s to **`vault/diag.log`** (a
file, so it survives even a hard crash). **If the server freezes or crashes, send
that file** — the last lines before the gap show the exact state right before it
locked up, and the timestamp gap shows when.

Each `HB` line reports: uptime, current/max event-loop **lag**, open connections,
open read streams, active handles, RSS/heap, in-flight request count + the **oldest
in-flight request** (the prime suspect), and upload/run/tool job counts. Special lines:

- `### START` / `### EXIT` — process start and clean shutdown.
- `!!! BLOCK ~Nms inflight=[…]` — the event loop was blocked >1s; names the stuck
  request(s). The same thing prints to the console as `EVENT LOOP BLOCKED`.
- `### FATAL …` — a genuinely fatal error (with stack); benign dropped-stream
  errors (EPIPE/ECONNRESET) are ignored and don't crash the server.

Tunables: `SX_DIAG_HEARTBEAT_MS` (default 2000), `SX_DIAG_LOG_MAX_BYTES` (default 5MB,
auto-rotates), `SX_DIAG_HEARTBEAT=0` to disable, `SX_LOOP_BLOCK_MS` (default 1000).
The same live numbers are also at `GET /api/_diag`.

**If the BROWSER TAB freezes (but the server stays healthy):** a client-side watchdog
in `boot-guard.js` samples the page's main-thread lag, JS heap, DOM node count, and
live `<audio>/<video>` elements every few seconds. On a long main-thread block it POSTs
the recent samples to `/api/crash`, so they land in `vault/crash.log` tagged
`CLIENT TAB DIAG` — the trail shows heap/DOM/media growth leading into the freeze. You
can also dump it on demand from the browser console: `SimplexBoot.diag()`.

## Accounts & permissions

- Open the site → enter **username + password** → you're in that account's vault.
  **Reload the page to sign out** (sessions are browser-session-scoped).
- The **admin** account can create, edit, and delete **all** accounts
  (account menu → *Manage accounts*). Admins set username, display name, password,
  admin flag, and per-account quota.
- Every other account can edit **only itself** (display name + password).
- Guards: you can't delete your own account or remove the last admin.
- Each account is fully **isolated** — separate database, separate files directory,
  separate encryption keys. One account can never see another's files.

## Encryption at rest

All keys live **only on the server** (`crypto.js`) and are never sent to any client.

- **Master key** — 32 random bytes at `vault/keys/master.key` (mode 0600), generated
  once on first run and re-read every boot (so data survives reboots). Per-account
  subkeys are derived from it with HKDF, so each account is cryptographically isolated.
- **File blobs** (`vault/accounts/<id>/files/<fileId>.enc`) — encrypted with **two
  stacked AES-256-CTR passes**. CTR is a stream cipher, so HTTP Range requests still
  work and video/audio **scrubbing/seeking is preserved**. A small header stores the
  IV + original size; the rest is ciphertext (the original filename/extension is not
  on disk).
- **Album covers** — encrypted exactly like blobs (`<fileId>.cover.enc`).
- **Text & metadata** (document contents, file names, artist, album) — encrypted with
  **two AES-256-GCM passes then Base64**, stored with an `enc:` marker in SQLite. GCM
  is authenticated, so tampering is detected.
- **Passwords** — `scrypt` with a random per-account salt; verified in constant time,
  off the event loop.
- **Extra hardening** — per-account key isolation; `trust proxy` for correct client
  IP / secure cookies behind a proxy; security headers (CSP, `X-Content-Type-Options`,
  `Referrer-Policy`, `X-Frame-Options`); `Cache-Control: private, no-store` on all API
  responses so decrypted bytes are never cached by any edge/CDN; HttpOnly + SameSite
  (+ Secure over HTTPS) cookies; per-IP brute-force throttle on login; partial uploads
  wiped on boot.

### Master key — back it up!

The master key encrypts everything. **If you lose it, the data is unrecoverable.**

```bash
node key.js path             # where the key is + its fingerprint
node key.js show             # reveal it (hex + base64) to copy into a password manager
node key.js verify <key>     # check a written-down backup matches, without revealing the key
node key.js backup <dest>    # copy the key to a file/folder (e.g. a USB drive)
node key.js restore <src>    # install a key from a backup file or hex/base64 string
```

## Importing an existing (pre-encryption) vault

If an old single-vault `vault/simplex.sqlite` + plaintext `vault/files/` is present,
import it into the admin account — encrypting every blob and verifying each one before
deleting the plaintext original:

```bash
node migrate.js              # idempotent + resumable; safe to re-run
```

## Album covers

Right-click any song (or file) → **Set cover…** → pick an image. It's encrypted and
shown on the grid tile and in the audio player (with the spin-on-play animation).
Right-click → **Remove cover** reverts to the default.

## Live updates

The app polls `/api/poll` every few seconds and quietly refreshes the file grid,
storage meter, and account info when something changes — without interrupting an open
viewer, modal, upload, or selection. Account edits made by an admin (quota, display,
admin flag) and deletions take effect on other sessions automatically; a deleted or
signed-out session is bounced back to the login screen.

---

## AI app — Online & Local

The **AI** app has two tabs, switched from the dropdown at the top-left of the chat
bar:

- **Online** — API providers (xAI/Grok, Cloudflare). Configured by an admin in
  *Settings → AI providers*.
- **Local** — language models that run **entirely on this server**, with nothing
  sent to any external service. No Ollama / LM Studio / external runtime: a
  CPU build of llama.cpp's `llama-server` is **bundled** in [`engine/bin/`](engine)
  (~38 MB) and driven by [`engine/llama-engine.js`](engine/llama-engine.js).

Local models come from two places, both shown in the Local tab:

1. **Server models** — `*.gguf` files an admin drops into the [`models/`](models)
   folder (path configurable in *Settings → AI providers → Local AI*, or the
   `ai.models_dir` setting). Available to every account with *Can use AI*.
2. **User models** — a `.gguf` file a user uploaded into their own encrypted
   Database. It's decrypted to private engine scratch only while loaded.

A model is lazy-loaded on first use (one `llama-server` per model on a private
localhost port), reused for later turns, and unloaded after it's idle
(`SX_LOCAL_AI_IDLE_MS`, default 10 min). At most `SX_LOCAL_AI_MAX_LOADED`
(default 1) stay resident at once. Orphaned model servers from a hard kill/crash
are swept on the next boot, and tree-killed on graceful shutdown/restart.

**Chat templates.** A model is first loaded with its own embedded chat template.
Some models ship a jinja template `llama-server` can't parse (it exits asking for
`--no-jinja --chat-template chatml`); the engine detects that and automatically
retries once with a generic ChatML template, so those models still work (the
status endpoint flags such a model with `templateFallback: true`).

**Thermal safety net.** Local inference pins every CPU core at 100%, which can
heat up a small at-home box. The engine continuously samples CPU/system
temperature (Windows ACPI thermal zones via a no-admin perf-counter query; Linux
`/sys/class/thermal`). If the hottest reading stays at/above `SX_THERMAL_TRIP_C`
(default 90 °C) for `SX_THERMAL_SUSTAIN_MS` (default 30 s), it **trips**: all local
models are unloaded and new local requests are refused for a cooldown
(`SX_THERMAL_COOLDOWN_MS`, default 5 min), after which it resumes once the temp is
back below `SX_THERMAL_RESUME_C` (default 75 °C). The Local tab shows a cooldown
banner; online models are unaffected. Admins can clear a trip early via
`POST /api/ai/local/thermal/reset`. (ACPI zones can read a bit below the true CPU
die and on some boards are flat — treat this as a protective backstop, and tune
the thresholds to your hardware.)

Tunables (env): `SX_LOCAL_AI_CTX` (context size, default 8192),
`SX_LOCAL_AI_MAX_LOADED`, `SX_LOCAL_AI_IDLE_MS`, `SX_LOCAL_AI_PORT_BASE`,
`SX_THERMAL_TRIP_C`, `SX_THERMAL_RESUME_C`, `SX_THERMAL_SUSTAIN_MS`,
`SX_THERMAL_COOLDOWN_MS`, `SX_THERMAL_POLL_MS`.

> The bundled binary is the **win-cpu-x64** build of llama.cpp. On another OS/arch,
> replace `engine/bin/` with that platform's `llama-server` + its runtime libs.

---

## Trading app — one global AI trader, always learning

The **Trading** app lets an AI trade for you. Unlike everything else in Simplex, the
**model is global**: there is exactly one network, shared by every account, and it is
**always training** in the background on the server. Each account just picks how to
use it.

> ⚠️ **Not financial advice.** Automated trading carries real risk of loss. A
> backtested or paper-trading result is **not** a guarantee of live performance. Only
> ever trade money you can afford to lose. The live path is gated for exactly this
> reason, and a one-click **kill switch** halts all of your trading instantly.

### The model

An MLP signal model lives in [`trading-engine.js`](trading-engine.js) — an
isomorphic, dependency-free engine in the same shape as
[`neural-engine.js`](neural-engine.js). The pipeline:

```
OHLCV bars → indicators → per-window-normalized features (NO lookahead)
   → MLP classifier → P(up / flat / down) for the NEXT bar
   → threshold → BUY / SELL / HOLD (+ reason + confidence)
   → risk gate (sizing, caps, stop/take, daily-loss kill) → execution → log
```

- **Architecture (v2).** A **28-feature** input that reaches back ~100 bars across
  several horizons — multi-period returns (1→40), fast/slow RSI, MACD + its slope,
  short/medium/long trend structure, multi-horizon volatility, range position +
  distance from recent highs/lows, and volume context — feeding a **deeper `[64,48,32]`**
  ReLU stack with softmax over down/flat/up. So each inference sees the longer regime
  around the latest move, not just the last few bars.
- **Regularized so it doesn't overfit.** The bigger net is held in check by **dropout
  (0.3)**, **L2 weight decay (1e-3)**, and **label smoothing (0.05)** — together they
  roughly halve the train↔validation loss gap, which is the usual cause of a model
  that "gets worse the more it trains" on noisy market data. Dropout is training-only;
  live inference is fully deterministic. The signal threshold (0.08) is matched to the
  resulting better-calibrated probabilities. *Changing the feature set or architecture
  bumps `FEATURE_VERSION`, and every server auto-rebuilds + retrains the new model on
  next boot (and it must re-earn live approval — see the lifecycle below).*
- **No lookahead.** Every feature at bar *i* uses only bars ≤ *i*; indicators are
  normalized per trailing window. The label for bar *i* is the sign of the *i → i+1*
  return and is never fed back in as a feature.
- **Walk-forward validation.** The train/validation split is by **time** (purged),
  never random k-fold — so the future can't leak into the past. Reported
  `valAcc`/`valLoss` come from the held-out time tail.
- **Always training.** A background loop trains the global model a few Adam steps on a
  rotating set of symbols each tick (default every 3 s, several symbols per tick, on
  the richer intraday data), chunked off the event loop, and persists the weights to
  the encrypted `trading_model` row in the system DB. It reaches a few hundred rounds
  in minutes and keeps improving.
- **Fees + slippage** are modeled in the paper simulator, so a strategy that's only
  profitable *before* costs shows up as a loser.
- **Tradeable-move labels (v3).** The model is trained to predict only **meaningful**
  next-bar moves — a move counts as up/down only if it clears a **volatility-scaled
  threshold** (~0.6× the symbol's recent ATR), otherwise it's "flat". This fixes the
  classic trap where a model gets ~90% accurate by always predicting "flat" on quiet
  bars (trivially right, untradeable); instead it learns to flag the moves a day trader
  would actually act on.

### Day-trader conviction layer (all-in / all-out)

Rather than nibbling a fixed % into every symbol that pokes over the line, the engine
makes a **portfolio-level** decision each step (`decidePortfolio`):

- **All-out (risk-off):** when the book is broadly bearish or there's no edge anywhere,
  it **flattens everything to cash** in one pass — like a day trader who flattens when
  the tape rolls over.
- **All-in (conviction):** it ranks symbols by confidence and **concentrates capital**
  into the strongest one or few signals, sizing *up* with conviction (a single strong
  setup can take a large slice of equity), instead of a flat 10% per name.
- **Exit on flip/decay:** any held name whose signal flips against us or fades toward
  neutral is sold, even without a full flatten.
- **Cooldown:** a symbol can't be re-bought for a few bars after it's sold, so it can't
  thrash in and out on noise. Combined with a higher entry threshold, this cuts the
  trade count dramatically (≈190 → ≈25 in testing) — far less fee bleed.

The same decision layer drives the backtest, the sandbox forward-loop, and the live
Alpaca path, so what you see in the sandbox is what runs live.

### Market data (free, no key)

OHLCV is pulled from Yahoo Finance's public chart endpoint (the same data `yfinance`
wraps) — no API key — for an admin-configured symbol universe (default
`SPY, QQQ, AAPL, MSFT, BTC-USD`), cached in the system DB and refreshed at most hourly.
Two series per symbol: **daily** (2 years) and **intraday 5-minute over ~1 month**
(~1700 bars). The intraday series is what the model trains on and the sandbox replays.

**Why a month, not a few days:** the model trains on the intraday series, and training
on only ~5 similar days let it memorize recent noise and report *fake* ~98% validation
accuracy (train and validation were the same regime). A month of 5-minute bars spans
several regimes, and training uses a **purged validation split** (a gap between the
train and held-out tail) so the reported accuracy is an honest measure of
generalization rather than leakage. All network is timeout-bounded and failure-tolerant:
once the cache is seeded, the model and sandbox work fully offline.

### Sandbox vs. Live

- **Sandbox (default, everyone) — "fake money."** Deposit virtual cash and the model
  trades a **simulated** portfolio against real market data, so you can judge *"is the
  model good enough for me?"* before risking anything. The **first deposit instantly
  backtests** the model over real **1-minute intraday** history with that starting
  balance, then **animates a fast replay** (~9 s) — you *watch* the equity curve and
  trades build, with a timeline, a moving playhead, live-ticking P&L, and a narration
  of what's happening, rather than just seeing a final number. It shows the date range
  + granularity it covered, win rate, return, and max drawdown. From there it **keeps
  simulating forward** on each new bar. "Replay simulation" re-runs from your net
  deposited amount at any time; reset wipes it.

  Markets only emit ~1 real price per minute (and none when closed), so the sandbox
  *replays real intraday history at speed* rather than inventing fake ticks — that's
  what makes a result appear in seconds and feel live. Intraday 1-min bars come from
  the same free Yahoo endpoint (`range=5d&interval=1m`), cached separately under a
  `<SYM>#i` key and refreshed every ~15 min.
- **Live (gated, opt-in) — your own brokerage.** Connect **your own** Alpaca account
  (API key + secret, stored **only** inside your encrypted portfolio doc). **Simplex
  never holds your funds** — it only places orders against your brokerage. Going live
  requires all of: an admin **master-enable** (*Settings → Trading*), your **own
  opt-in** with a risk acknowledgment, and connected keys. It defaults OFF. Use Alpaca
  **paper** keys first. Live orders **reconcile against the broker's open positions
  before acting**, so a server restart can't double-submit.

### Risk gate (non-negotiable)

Between every signal and order: position sizing (≤ a % of equity per trade, hard
cap), max open positions, a **daily-loss kill switch** (auto-halts new buys once the
day's loss hits a threshold), and a stop-loss / take-profit attached to every entry.
Defaults live in `TradingEngine.DEFAULT_RISK`.

**Fractional shares.** Positions are sized by **dollar notional**, so even a tiny
balance works — a $100 sandbox (or live account) can hold 0.018 shares of a $700
stock, just like Cash App / Robinhood / Alpaca fractional orders. The gate only
blocks *dust* trades under a $1 minimum notional. Live fractional buys go to Alpaca
as `notional` (dollar) market orders; sells send the fractional `qty`. Set
`risk.fractional = false` to force whole-share trading instead.

### Admin controls

*Settings → Trading* (admins only): set the symbol universe, flip the **live-money
master switch**, **Kick now** to force an immediate data-fetch + training burst, and
manage the **model lifecycle** (below).

### Model lifecycle — reset & live-usability gate

A model can degrade. Admins can **Reset model** (*Settings → Trading*) to wipe the
shared network back to a fresh, untrained state for everyone. To protect real money,
a reset model is **not usable for live trading** until **both**:

1. it has retrained at least **100 rounds** (`SX_TRADING_MIN_ROUNDS`, default 100), **and**
2. an admin explicitly marks it **usable** again ("Mark usable" — only enabled once
   the round threshold is met).

A reset clears the approval, so it must be re-earned *and* re-approved. The **sandbox
is exempt** — it's how you evaluate whether the retrained model is good enough, so it
keeps simulating regardless. While a model is not cleared, the live opt-in and the
switch-to-live action are blocked (with a clear reason), and the background live trade
loop refuses to place real orders. The approval flag is the system setting
`trading.model_approved`; usability is `trainedSteps ≥ min AND approved`.

### Env tunables

- `SX_TRADING_TRAIN_MS` (default `3000`) — how often the global model trains a burst.
- `SX_TRADING_TRAIN_SYMBOLS` (default `3`) — symbols trained per burst (each is one round).
  Training uses the richer **intraday** series (when cached) for ~10× more examples per
  round, runs chunked off the event loop (`setImmediate` between rounds), and at these
  defaults reaches a few hundred rounds in minutes instead of hours. Lower these (or
  raise the interval) if you want it to use less CPU.
- `SX_TRADING_DATA_MS` (default `3600000`) — minimum interval between market-data refreshes.
- `SX_TRADING_TRADE_MS` (default `300000`) — how often each account's trades are evaluated.
- `SX_TRADING_MIN_ROUNDS` (default `100`) — training rounds required before a model can
  be approved for live (see the lifecycle above).

---

## Music app — a shared library, playlists & jam sessions

The **Music** app is a *global, shared* space (like *Trading* and *Bug Reports*, its data
lives in the **system DB**, not any one account's vault). Every member sees the same
library, can build playlists, and can listen together in sync.

**Adding a song copies it.** When you add one of your own vault audio files to Music, the
bytes are **copied** — decrypted from your vault and re-encrypted into a dedicated
`__music__` blob store (`vault/accounts/__music__/`) with the always-held `keyring('__music__')`
keyset, so *any* signed-in member can stream it. This is the same trick the public *share*
links use: the server holds every vault's keys, so the encryption boundary is user↔disk,
not user↔user. Because it's a copy, the Music track is **independent of the source** — if
you later delete the original from your vault, the Music copy is untouched. Only the
**uploader or an admin** can remove a track (which removes it for everyone).

**Dedup.** A track is keyed by a **SHA-256 of its plaintext bytes** (a unique index), computed
in the same streamed pass as the copy. Adding the same song twice reuses the existing track —
one shared library entry, one copy on disk.

**Playlists** are public (everyone sees them) or private (only the creator / an admin). The
list and single-playlist endpoints filter visibility server-side so private playlists never
leak. Owners/admins can rename, delete, and change visibility. They can also name **Trusted
Editors** — members (chosen from a searchable list) who may **add, remove, and reorder** the
playlist's songs but not rename, delete, or manage editors. People are **notified** when their
edit access is granted or removed. Reorder songs by dragging rows or via a right-click menu
(move up/down, to top/bottom, or by N). A playlist header shows the song count, **total
duration**, and the **average song length**.

**Reporting.** Any member can **report** a library song (reason *Duplicate* or *Other* with a
note). Admins get a **Reports** tab in the Music app — visible only when open reports exist —
where they can play the song, remove it, or **Resolve / Dismiss** the report. Removing a song
clears its reports automatically.

**Browsing.** Clicking a library song opens a detail drawer (cover, metadata, play / add to
playlist / report); right-clicking gives the same actions as a quick menu. The library has a
server-picked **Today's Spotlight** (3 songs, stable until midnight) and a searchable **Full
Library** (by song name, artist, or uploader). Covers load lazily as you scroll.

**Jam sessions — listen together.** Start a jam from whatever you're playing; others join
from the **Jams** tab and hear the **same song at the same moment**. Sync is **poll-based**
(~1s) — there's no websocket; a dedicated `GET /api/music/jam/:id/state` returns the playback
state plus the server clock, and clients extrapolate position and drift-correct (hard-seek if
off by >1s, gently nudge playback rate for small drift). **Everyone can control** (pause/skip/
shuffle/loop); control posts carry the state `version` they saw and a stale one is rejected
(`409`) so concurrent controllers can't clobber each other (last-write-wins). If the **host
leaves, host transfers** to the oldest remaining member, so the jam keeps going; it only ends
when the last member leaves (a background sweep also reaps jams whose members all went away).

**It uses the same player as the Database.** Music plays through Simplex's persistent
**Player** — so you get the 10-band **equalizer**, the **between-song crossfade**, the
spinning **now-playing** visual, speed/volume, and the **docked mini-player that keeps
playing as you move around the site**. Equalizer and crossfade are *personal* settings, so
in a jam each listener keeps their own; only track/position/pause/shuffle/loop are synced.
The equalizer manages its own **headroom**: boost presets (Bass Booster, Loudness…) are
compensated by an automatic preamp trim plus a brickwall limiter, so boosting a loud
master re-shapes the sound instead of hard-clipping it into distortion.

**Streaming quality (Low → Lossless).** Player settings (the gear in now-playing) has a
**Streaming quality** picker for Music-app songs: **Low** (96 kbps), **Medium** (160 kbps),
**High** (256 kbps) or **Lossless** — the untouched original bytes, the default. Lossy
tiers are AAC/M4A transcodes generated **once** per track+tier with ffmpeg, cached
encrypted-at-rest (like video posters), and streamed with full Range/seek support
(`GET .../raw?q=low|medium|high`). A track whose own bitrate is already at/below the
requested tier is served as-is — nothing is ever re-encoded upward. Changing quality
mid-song reloads the current track at the same position. Vault files always stream
their originals; the setting only affects the shared Music library.

**Save to vault.** Any member can copy a shared song **into their own vault**: right-click
a library song (or open its details) → **Save to my vault…** → pick a folder. The server
decrypts the track from the shared store and re-encrypts it into the caller's vault as a
normal audio file — cover art, artist, album and duration included — quota-checked like
any upload and fully independent of the library copy (`POST /api/music/tracks/:id/save`).

**Shuffle & loop are production-standard (and app-wide).** Shuffle builds a **shuffled
permutation** of the queue (Fisher–Yates) and plays through that — it does *not* jump to a
random song each time, and it never reorders the saved playlist; loop wraps to the start of
the queue at the end. This applies to **both** Music and Database audio (one shared player),
with a loop toggle in the now-playing controls.

API surface (all `requireAuth`): `POST/GET/DELETE /api/music/tracks[...]`, `GET .../tracks/:id/raw|cover`,
`GET /api/music/spotlight`, `GET /api/music/members`, `GET/POST/PATCH/DELETE /api/music/playlists[...]`
(+ `/items`, `/order`, `/editors`), the report routes `POST /api/music/reports`, `GET /api/music/reports[/count]`,
`PATCH /api/music/reports/:id` (list/patch are admin-only), and the jam routes `POST /api/music/jam`,
`.../join`, `.../leave`, `GET .../state`, `POST .../control`, `GET /api/music/jams`.

---

## Bug Reports app — file a bug, admins triage

The **Bug Reports** app (next to *Trading* on the dashboard) is a single global inbox
that **any system can write to**. There are two ways in:

1. **Members** — every signed-in account sees a submit form (area, severity, title,
   description). Reports are attributed to their account.
2. **Automated assistants with no account** — an open, unauthenticated POST endpoint
   so an external tool (e.g. the security check) can file a finding without logging in.

**Admins** see the full inbox in the same app: every report with its source
(member vs. automated), severity, and status. They can move a report through
`new → open → resolved / wontfix`, add an internal triage note, or delete it.

### Storage

Reports live in the **system** DB (global, not per-account), in the `bug_reports`
table — same place the global Trading model lives. They are bug descriptions, not
vault data, so they're stored as plain text (no per-account key needed). Both write
paths log a line to the server console, so reports are also visible there.

### Endpoints

| method | path | who | purpose |
|--------|------|-----|---------|
| `POST` | `/api/bugs` | member (session) | file a report, attributed to the account |
| `POST` | `/api/bugs/open` | **public, no auth** | automated assistant files a report |
| `GET` | `/api/bugs` | admin | list reports + status counts |
| `PATCH` | `/api/bugs/:id` | admin | change `status` and/or `notes` |
| `DELETE` | `/api/bugs/:id` | admin | remove a report |

The open endpoint is **write-only** (returns just `{ ok, id }`, never the inbox),
**length-capped** (title ≤ 200, body ≤ 8000 chars), and **rate-limited to 10/min per
IP** (HTTP `429` over the limit) — modeled on the existing `/api/crash` reporter so it
can't be abused to flood the table. Body fields and a worked example are documented in
**`SECURITY_CHECK_RULES.md`** (the security check reads that file to learn how to post).

---

## Cloudflare deployment notes

Domain via **Spaceship**, DNS + tunnel via **Cloudflare**, all safety protocols on.
The app is already built to run cleanly behind the Cloudflare tunnel:

- **Large uploads** are split into 90 MB chunks (under Cloudflare's ~100 MB request-body
  cap) and sent **10 in parallel**. The server writes each chunk at its byte offset and
  reassembles them in any order, so throughput scales with the uplink instead of being
  capped by one-chunk-at-a-time. Over Cloudflare's HTTP/2 the parallel chunks multiplex
  over a single connection, so the browser's ~6-connection limit doesn't apply in
  production. Chunk size + parallelism are advertised by the server (`/api/uploads/init`)
  so they can be tuned in one place.
- **`app.set('trust proxy', true)`** is enabled so `req.secure` and the client IP honor
  Cloudflare's `X-Forwarded-Proto` / `X-Forwarded-For`. This makes the `Secure` cookie
  flag set correctly behind the tunnel and the login throttle key on the real visitor IP.
- **No edge caching of vault data**: every `/api/*` response (especially `/raw` and
  `/cover`) sends `Cache-Control: private, no-store`, so decrypted bytes are never
  cached by Cloudflare. POST/`Set-Cookie` responses aren't cached by default either.
- **Range requests** (video/audio scrubbing) pass through the tunnel unchanged — no
  configuration required.

Recommended (optional) Cloudflare dashboard settings — these are operational, not code:

- **SSL/TLS** mode **Full (strict)** with the tunnel (the tunnel terminates TLS to the
  origin), and **Always Use HTTPS** on.
- A **WAF rate-limiting rule** on `POST /api/login` (e.g. 10 requests/min per IP) as a
  second layer in front of the built-in throttle. Optionally one on the whole `/api/`.
- Leave **Browser Integrity Check** / Bot Fight Mode on; the app makes only same-origin
  `fetch` calls, so it won't trip them.
- No Spaceship change is needed beyond delegating the domain's nameservers to Cloudflare
  (already done for the tunnel).

> Note: the master encryption key lives only on the origin machine
> (`vault/keys/master.key` or `SIMPLEX_MASTER_KEY`). Cloudflare never sees it or any
> plaintext key material — it only proxies already-decrypted HTTPS responses to the
> authenticated browser.

## Layout

```
server.js     Express app: accounts, per-account encrypted stores, files/shares/covers, poll, /api/health; serves the frontend too
boot-guard.js frontend boot guard: fetch timeouts + crash reporter (loads first)
crypto.js     all cryptography (master key, blob + text encryption, scrypt) — keys live here only
key.js        master-key CLI (show / verify / backup / restore / path)
migrate.js    one-time importer: legacy plaintext vault -> encrypted admin vault
app.js        frontend controller (login, browser, viewers wiring, account UI, live polling)
data.js       frontend data layer (API calls, optimistic cache)
viewers.js    video / audio / image / document viewers
neural.js     Neural Network app UI (graph/physics sandbox + text-model trainer)
neural-engine.js  the NN math (MLP + neuroevolution, char-LM); isomorphic — also require()d by server.js for backend compute
trading-engine.js the Trading app's signal model (indicators + MLP classifier + walk-forward trainer + risk gate + paper sim); isomorphic, server-trained
icons.js      inline SVG icon set
index.html / simplex.css   shell + styling
vault/        (gitignored) keys/, system.sqlite, accounts/<id>/{simplex.sqlite, files/}
```

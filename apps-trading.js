/* ============================================================
   TRADING app (apps-trading.js) — control panel for the GLOBAL always-training AI
   trader, extracted from app.js and loaded on demand (openApp -> openLazyApp ->
   loadFeature("apps-trading")). The MODEL itself trains server-side (trading-engine.js,
   server-only) and is unaffected; this is just the UI screen. Plain non-module script
   sharing app.js global scope. (Admin trading-model controls stay in core Settings.)
   See [[lazy-loading-architecture]] and [[trading-app]].
   ============================================================ */
let _tradingTimer = null;
const _tr = { state: null, model: null, signals: null, mode: 'sandbox', busy: false };

function tradingHTML() {
  return `<div class="trading-app" data-screen-label="Trading">
    <div class="tr-head">
      <div>
        <h2 class="tr-title">${svg('trend', 20, 1.8)} AI Trader</h2>
        <p class="tr-sub">One model. Always learning. Trades for everyone — start in the sandbox with fake money.</p>
      </div>
      <div class="tr-head-acts">
        <button class="btn ghost sm" id="trRefresh">${svg('refresh', 14)} Refresh</button>
        <button class="btn ghost sm danger" id="trKill" title="Halt all of your trading immediately">${svg('stop', 14)} Kill switch</button>
      </div>
    </div>

    <div class="tr-disclaimer">${svg('info', 16)}
      <span><b>Not financial advice.</b> Automated trading carries real risk of loss. A backtested or paper result is <b>not</b> a guarantee of live performance. Only ever trade money you can afford to lose. You stay in control — the kill switch halts everything in one click.</span>
    </div>

    <div id="trBody"><div class="tr-loading">${svg('trend', 28)}<span>Loading the trading desk…</span></div></div>
  </div>`;
}

async function wireTrading() {
  const refresh = document.getElementById('trRefresh');
  const kill = document.getElementById('trKill');
  if (refresh) refresh.onclick = () => loadTrading();
  if (kill) kill.onclick = () => confirmModal(
    'Activate kill switch?',
    'This immediately halts ALL of your trading — pauses auto-trading and disables live orders. Your positions are left as-is; nothing is force-sold. You can re-enable trading afterwards.',
    async () => { try { await tradingKill(); toast('Trading halted'); loadTrading(); } catch (e) { toast('Could not halt', 'close'); } },
    'Halt trading'
  );
  // live-refresh every 10s while the app is open; stop on leave. Skip while a replay
  // animation is running so it doesn't yank the chart mid-playback.
  _tradingTimer = setInterval(() => { if (!_tr.busy && !_trReplayRAF) loadTrading(true); }, 10000);
  _appCleanup = () => { if (_tradingTimer) { clearInterval(_tradingTimer); _tradingTimer = null; } if (_trReplayRAF) { cancelAnimationFrame(_trReplayRAF); _trReplayRAF = null; } };
  loadTrading();
}

async function loadTrading(quiet) {
  const body = document.getElementById('trBody');
  if (!body) return;
  _tr.busy = true;
  if (!quiet) body.innerHTML = `<div class="tr-loading">${svg('trend', 28)}<span>Loading the trading desk…</span></div>`;
  try {
    const [state, model, signals] = await Promise.all([tradingState(), tradingModelStatus(), tradingSignals().catch(() => ({ signals: [] }))]);
    _tr.state = state; _tr.model = model; _tr.signals = signals.signals || []; _tr.mode = state.mode;
    body.innerHTML = tradingBodyHTML(state, model, _tr.signals);
    wireTradingBody();
  } catch (e) {
    if (e && e.code === 'AUTH') return relock();
    if (!quiet) body.innerHTML = `<div class="tr-loading">${svg('info', 24)}<span>Couldn't load the trading desk.</span></div>`;
  } finally { _tr.busy = false; }
}

function trMoney(n) { const v = Number(n) || 0; return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function trPct(n) { const v = Number(n) || 0; return (v > 0 ? '+' : '') + (v * 100).toFixed(2) + '%'; }
// fractional-share-aware quantity: whole numbers show plain, fractions show up to 4 dp
function trQty(n) { const v = Number(n); if (!isFinite(v)) return ''; return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''); }
function trSignalClass(a) { return a === 'BUY' ? 'buy' : a === 'SELL' ? 'sell' : 'hold'; }

function tradingBodyHTML(state, model, signals) {
  const sb = state.sandbox;
  const live = state.live;
  const isLive = state.mode === 'live';
  const pnlClass = (sb.pnl || 0) >= 0 ? 'up' : 'down';

  // ----- model status card -----
  const acc = model.valAcc != null ? (model.valAcc * 100).toFixed(1) + '%' : '—';
  const trained = (model.trainedSteps || 0).toLocaleString();
  const seen = (model.examplesSeen || 0).toLocaleString();
  const updated = model.updated ? fmtElapsed(Date.now() - model.updated) + ' ago' : 'never';
  const modelCard = `
    <div class="tr-card tr-model">
      <div class="tr-card-head"><h3>${svg('brain', 16)} The model</h3><span class="eyebrow">global · always training</span></div>
      <div class="tr-modelgrid">
        <div class="tr-stat"><div class="v">${acc}</div><div class="k">Validation accuracy</div></div>
        <div class="tr-stat"><div class="v">${trained}</div><div class="k">Training rounds</div></div>
        <div class="tr-stat"><div class="v">${seen}</div><div class="k">Examples seen</div></div>
        <div class="tr-stat"><div class="v">${model.dataReady || 0}/${(model.symbols || []).length}</div><div class="k">Symbols with data</div></div>
      </div>
      <div class="tr-modelfoot mono">Trades ${(model.symbols || []).join(', ') || '—'} · last trained ${updated}</div>
    </div>`;

  // ----- mode switch -----
  const modeCard = `
    <div class="tr-card">
      <div class="tr-card-head"><h3>Mode</h3></div>
      <div class="tr-modeswitch">
        <button class="tr-mode ${!isLive ? 'on' : ''}" data-mode="sandbox">${svg('checksq', 15)} Sandbox<small>fake money · risk-free</small></button>
        <button class="tr-mode ${isLive ? 'on' : ''}" data-mode="live" ${live.masterEnabled ? '' : 'disabled'}>${svg('globe', 15)} Live<small>${live.masterEnabled ? 'your brokerage · real risk' : 'disabled on this server'}</small></button>
      </div>
      <label class="tr-toggle"><input type="checkbox" id="trAuto" ${state.autoTrade ? 'checked' : ''}/> <span>Let the model trade automatically</span></label>
    </div>`;

  // ----- portfolio (sandbox) -----
  const positionsRows = sb.positions.length ? sb.positions.map(p => `
    <tr>
      <td class="mono">${esc(p.symbol)}</td>
      <td class="num">${trQty(p.qty)}</td>
      <td class="num">${trMoney(p.entry)}</td>
      <td class="num">${trMoney(p.price)}</td>
      <td class="num">${trMoney(p.value)}</td>
      <td class="num ${p.pnl >= 0 ? 'up' : 'down'}">${trMoney(p.pnl)}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="tr-empty">No open positions. The model opens trades when it sees an edge.</td></tr>`;

  const st = sb.stats;
  const zeroTrades = sb.simulated && st && (st.trades || 0) === 0;
  // describe the window in the RIGHT units — minute-granularity sims cover hours, not
  // "days". Prefer the real elapsed time from the stats timestamps; fall back to a
  // bar count labeled with the correct granularity.
  const simSpan = tradingSpanText(sb);
  const fwdUnit = sb.granularity === 'minute' ? 'bar' : 'day';
  const simBanner = zeroTrades
    ? `<div class="tr-simbanner muted">${svg('info', 15)} <span><b>The model placed no trades over ${simSpan}.</b> Right now it's mostly holding — its confidence stayed under the trade threshold the whole window, so it stayed out of the market. As it trains more (or once it sees a clearer edge), it'll start trading. Nothing's broken — this is the model being cautious.</span></div>`
    : sb.simulated && st
    ? `<div class="tr-simbanner">${svg('pulse', 15)} <span><b>Simulated over ${simSpan}.</b> This is what the model would have done with your ${trMoney(st.startCash)} — it keeps trading forward on each new ${fwdUnit}.</span></div>`
    : !sb.simulated && sb.equity > 0
      ? `<div class="tr-simbanner muted">${svg('info', 15)} <span>Hit <b>Run simulation</b> to see what the model would have done with this balance over history.</span></div>`
      : '';
  const simStats = sb.simulated && st ? `
      <div class="tr-simstats">
        <div class="tr-simstat"><div class="v ${(st.returnPct||0)>=0?'up':'down'}">${trPct(st.returnPct)}</div><div class="k">Return</div></div>
        <div class="tr-simstat"><div class="v">${((st.winRate||0)*100).toFixed(0)}%</div><div class="k">Win rate</div></div>
        <div class="tr-simstat"><div class="v">${st.closedTrades||0}</div><div class="k">Closed trades</div></div>
        <div class="tr-simstat"><div class="v down">-${((st.maxDrawdown||0)*100).toFixed(1)}%</div><div class="k">Max drawdown</div></div>
      </div>` : '';

  const sandboxCard = `
    <div class="tr-card">
      <div class="tr-card-head"><h3>${svg('checksq', 16)} Sandbox portfolio</h3><span class="eyebrow">virtual money</span></div>
      ${simBanner}
      <div class="tr-pnlrow">
        <div class="tr-bigstat"><div class="v" id="trEqEquity">${trMoney(sb.equity)}</div><div class="k">Total equity</div></div>
        <div class="tr-bigstat"><div class="v" id="trEqCash">${trMoney(sb.cash)}</div><div class="k">Cash</div></div>
        <div class="tr-bigstat"><div class="v ${pnlClass}" id="trEqPnl">${trMoney(sb.pnl)}</div><div class="k">Net P&amp;L</div></div>
        <div class="tr-bigstat"><div class="v" id="trEqTrades">${sb.trades || 0}</div><div class="k">Trades</div></div>
      </div>
      ${tradingSimPanel(sb)}
      ${simStats}
      <div class="tr-acts">
        <div class="tr-depositrow">
          <input type="number" id="trDepositAmt" class="tr-input" placeholder="Amount" min="0" step="100" value="10000"/>
          <button class="btn sm" id="trDeposit">${svg('plus', 14)} Add funds</button>
          ${[10000, 50000, 100000].map(a => `<button class="chip" data-deposit="${a}">+$${(a/1000)}k</button>`).join('')}
        </div>
        <div class="tr-actbtns">
          ${sb.equity > 0 ? `<button class="btn ghost sm" id="trSimulate">${svg('pulse', 14)} Replay simulation</button>` : ''}
          <button class="btn ghost sm danger" id="trReset">${svg('restore', 14)} Reset sandbox</button>
        </div>
      </div>
      <table class="tr-table">
        <thead><tr><th>Symbol</th><th class="num">Qty</th><th class="num">Entry</th><th class="num">Price</th><th class="num">Value</th><th class="num">P&amp;L</th></tr></thead>
        <tbody>${positionsRows}</tbody>
      </table>
    </div>`;

  // ----- live card (gated) -----
  // The global model must be cleared for live (≥ min rounds + admin-approved). When it
  // isn't, the live opt-in is blocked with a clear reason; sandbox is unaffected.
  const modelLiveUsable = !!(model && model.liveUsable);
  const modelBlock = model && model.blockReason ? model.blockReason : null;
  const liveCard = `
    <div class="tr-card tr-livecard">
      <div class="tr-card-head"><h3>${svg('globe', 16)} Live trading</h3><span class="eyebrow">${live.masterEnabled ? 'real money' : 'disabled by admin'}</span></div>
      ${live.masterEnabled ? `
        ${!modelLiveUsable ? `<div class="tr-liveblock">${svg('lock', 15)} <span><b>The model isn't cleared for live trading yet</b>${modelBlock ? ` — ${esc(modelBlock)}` : ''}. It must finish training and be approved by an admin before it can trade real money. You can still evaluate it in the sandbox.</span></div>` : ''}
        <p class="tr-livenote">Connect your <b>own</b> brokerage (Alpaca). Simplex never holds your funds — it only places orders against your account. Use <b>paper</b> keys first.</p>
        <div class="tr-keyform">
          <label class="tr-toggle"><input type="checkbox" id="trPaper" checked/> <span>Paper account (recommended)</span></label>
          <input type="text" id="trKey" class="tr-input wide" placeholder="Alpaca API key ID" autocomplete="off"/>
          <input type="password" id="trSecret" class="tr-input wide" placeholder="Alpaca API secret" autocomplete="off"/>
          <div class="tr-acts">
            <button class="btn sm" id="trSaveKeys">${svg('key', 14)} ${live.keysSet ? 'Update keys' : 'Connect'}</button>
            ${live.keysSet ? `<button class="btn ghost sm" id="trClearKeys">${svg('trash', 14)} Disconnect</button>` : ''}
            <span class="tr-keystatus ${live.keysSet ? 'ok' : ''}">${live.keysSet ? svg('check', 13) + ' Connected' : 'Not connected'}</span>
          </div>
          <label class="tr-toggle tr-liveenable ${(live.keysSet && modelLiveUsable) ? '' : 'off'}"><input type="checkbox" id="trLiveEnable" ${live.enabled ? 'checked' : ''} ${(live.keysSet && modelLiveUsable) ? '' : 'disabled'}/> <span><b>I understand the risk</b> — enable live trading with real money</span></label>
        </div>` : `
        <p class="tr-livenote">Live trading is turned off on this server. An admin can enable it in <b>Settings → Trading</b>. Until then, use the sandbox.</p>`}
    </div>`;

  // ----- signals -----
  const sigRows = (signals || []).map(s => `
    <div class="tr-sig">
      <span class="mono tr-sigsym">${esc(s.symbol)}</span>
      <span class="tr-sigbadge ${trSignalClass(s.action)}">${s.action}</span>
      <span class="tr-sigbar"><i class="up" style="width:${Math.round((s.probs ? s.probs.up : 0) * 100)}%"></i><i class="down" style="width:${Math.round((s.probs ? s.probs.down : 0) * 100)}%"></i></span>
      <span class="tr-sigreason">${esc(s.reason)}</span>
    </div>`).join('') || `<div class="tr-empty">No signals yet — the model needs market data to warm up.</div>`;
  const signalsCard = `
    <div class="tr-card">
      <div class="tr-card-head"><h3>${svg('pulse', 16)} Live signals</h3><span class="eyebrow">what the model sees now</span></div>
      <div class="tr-signals">${sigRows}</div>
    </div>`;

  // ----- trade log -----
  const logRows = (state.log || []).length ? state.log.map(t => `
    <tr>
      <td class="mono dim">${new Date(t.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
      <td><span class="tr-mode-pill ${t.mode}">${t.mode}</span></td>
      <td class="mono">${esc(t.symbol || '')}</td>
      <td><span class="tr-side ${t.side}">${(t.side || '').toUpperCase()}</span></td>
      <td class="num">${t.qty != null ? trQty(t.qty) : ''}</td>
      <td class="num">${t.price != null ? trMoney(t.price) : ''}</td>
      <td class="num ${t.pnl > 0 ? 'up' : t.pnl < 0 ? 'down' : ''}">${t.pnl != null ? trMoney(t.pnl) : ''}</td>
      <td class="dim tr-logreason">${esc(t.reason || '')}</td>
    </tr>`).join('') : `<tr><td colspan="8" class="tr-empty">No trades yet.</td></tr>`;
  const logCard = `
    <div class="tr-card">
      <div class="tr-card-head"><h3>${svg('clock', 16)} Trade log</h3><button class="btn ghost sm" id="trClearLog">${svg('trash', 13)} Clear</button></div>
      <table class="tr-table tr-logtable">
        <thead><tr><th>When</th><th>Mode</th><th>Symbol</th><th>Side</th><th class="num">Qty</th><th class="num">Price</th><th class="num">P&amp;L</th><th>Why</th></tr></thead>
        <tbody>${logRows}</tbody>
      </table>
    </div>`;

  return `
    <div class="tr-toprow">${modelCard}${modeCard}</div>
    ${isLive ? liveCard + sandboxCard : sandboxCard + liveCard}
    <div class="tr-grid2">${signalsCard}${logCard}</div>`;
}

/* ----- simulation panel -----
   A self-contained, explained playback of the model's run. It shows a timeline
   (the real date range the sim covered + at what granularity), an equity chart with
   a value axis and a moving playhead, and a narration line. The "Replay simulation"
   button animates the already-computed backtest revealing point-by-point over a few
   seconds so the user WATCHES it trade rather than just seeing a final number. */
// Human description of the simulated window, in the RIGHT units for its granularity.
// Minute sims span hours; daily sims span days/months. Uses the real elapsed time
// between the first and last bar (from stats timestamps, else the curve), so it never
// mislabels a bar COUNT as a number of days.
function tradingSpanText(sb) {
  const h = (sb.history || []).filter(p => p && Number.isFinite(p.t));
  const st = sb.stats || {};
  const from = st.fromTs || (h[0] && h[0].t) || 0;
  const to = st.toTs || (h[h.length - 1] && h[h.length - 1].t) || 0;
  const ms = Math.max(0, to - from);
  if (sb.granularity === 'minute') {
    const hours = ms / 3600000;
    if (hours < 1.5) return `${Math.max(1, Math.round(ms / 60000))} minutes of 1-minute bars`;
    if (hours < 30) return `${Math.round(hours)} hours of 1-minute bars`;
    return `${Math.round(hours / 6.5)} trading days of 1-minute bars`;   // ~6.5h market day
  }
  const days = ms / 86400000;
  if (days < 45) return `${Math.max(1, Math.round(days))} days of daily bars`;
  if (days < 400) return `${Math.round(days / 30)} months of daily bars`;
  return `${(days / 365).toFixed(1)} years of daily bars`;
}

function tradingSimPanel(sb) {
  const h = (sb.history || []).filter(p => p && Number.isFinite(p.equity));
  const hasRun = sb.simulated && h.length >= 2;
  if (!hasRun) {
    return `<div class="tr-sim">
      <div class="tr-sim-empty">${svg('pulse', 22)}
        <div><b>No simulation yet.</b><span>Add funds, then hit Replay to watch the model trade your money through real market history.</span></div>
      </div>
    </div>`;
  }
  const st = sb.stats || {};
  const start = st.fromTs ? new Date(st.fromTs) : new Date(h[0].t);
  const end = st.toTs ? new Date(st.toTs) : new Date(h[h.length - 1].t);
  const fmt = (d) => d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: sb.granularity === 'minute' ? '2-digit' : undefined, minute: sb.granularity === 'minute' ? '2-digit' : undefined });
  const spanTxt = tradingSpanText(sb);
  return `<div class="tr-sim" id="trSim"
      data-curve='${esc(JSON.stringify(h))}'
      data-start="${st.startCash || h[0].equity}">
    <div class="tr-sim-bar">
      <div class="tr-sim-narr" id="trSimNarr">${svg('check', 13)} <span>Simulated <b>${esc(spanTxt)}</b> — here's what the model did with ${trMoney(st.startCash || h[0].equity)}.</span></div>
      <button class="tr-sim-replay" id="trReplayBtn" title="Watch it play out">${svg('play', 13)} Replay</button>
    </div>
    ${tradingChartSVG(h, st.startCash || h[0].equity)}
    <div class="tr-sim-axis"><span>${esc(fmt(start))}</span><span class="tr-sim-pos" id="trSimPos"></span><span>${esc(fmt(end))}</span></div>
  </div>`;
}

// equity chart with a baseline (starting cash) + value axis. Returns SVG whose line
// can be animated by tradingPlayReplay (it rewrites the polyline points over time).
function tradingChartSVG(h, startCash) {
  const W = 620, H = 150, padL = 4, padR = 4, padT = 8, padB = 8;
  const eq = h.map(p => p.equity);
  let min = Math.min(startCash, ...eq), max = Math.max(startCash, ...eq);
  if (max - min < 1e-6) { max += 1; min -= 1; }
  const pad = (max - min) * 0.08; min -= pad; max += pad;
  const X = i => padL + (i / (h.length - 1)) * (W - padL - padR);
  const Y = v => H - padB - ((v - min) / (max - min)) * (H - padT - padB);
  const baseY = Y(startCash).toFixed(1);
  const up = eq[eq.length - 1] >= startCash;
  const pts = h.map((p, i) => `${X(i).toFixed(1)},${Y(p.equity).toFixed(1)}`).join(' ');
  return `<div class="tr-chart">
    <div class="tr-chart-yhi">${trMoney(max)}</div>
    <div class="tr-chart-ylo">${trMoney(min)}</div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="tr-chart-svg ${up ? 'up' : 'down'}" id="trChartSvg"
         data-w="${W}" data-h="${H}" data-padl="${padL}" data-padr="${padR}" data-padt="${padT}" data-padb="${padB}"
         data-min="${min}" data-max="${max}">
      <line x1="0" y1="${baseY}" x2="${W}" y2="${baseY}" class="tr-chart-base"/>
      <polygon points="" class="tr-chart-fill" id="trChartFill"/>
      <polyline points="${pts}" class="tr-chart-line" id="trChartLine" fill="none"/>
      <circle r="3.5" class="tr-chart-head" id="trChartHead" style="display:none"/>
    </svg>
  </div>`;
}

/* Animate the simulation: reveal the equity line point-by-point over ~DURATION,
   moving a playhead, ticking the equity/P&L/trade counters, and writing a live
   narration ("▶ Day 12 — buying SPY…"). Reads the data-curve JSON off #trSim. */
let _trReplayRAF = null;
function tradingPlayReplay() {
  const sim = document.getElementById('trSim'); if (!sim) return;
  let curve; try { curve = JSON.parse(sim.dataset.curve); } catch (e) { return; }
  const startCash = Number(sim.dataset.start) || (curve[0] && curve[0].equity) || 0;
  if (!curve || curve.length < 2) return;
  const svgEl = document.getElementById('trChartSvg');
  const line = document.getElementById('trChartLine');
  const fill = document.getElementById('trChartFill');
  const head = document.getElementById('trChartHead');
  const narr = document.getElementById('trSimNarr');
  const posEl = document.getElementById('trSimPos');
  const eqEl = document.getElementById('trEqEquity'), pnlEl = document.getElementById('trEqPnl');
  if (!svgEl || !line) return;
  const W = +svgEl.dataset.w, H = +svgEl.dataset.h, padL = +svgEl.dataset.padl, padR = +svgEl.dataset.padr, padT = +svgEl.dataset.padt, padB = +svgEl.dataset.padb;
  const min = +svgEl.dataset.min, max = +svgEl.dataset.max;
  const X = i => padL + (i / (curve.length - 1)) * (W - padL - padR);
  const Y = v => H - padB - ((v - min) / (max - min)) * (H - padT - padB);
  if (_trReplayRAF) cancelAnimationFrame(_trReplayRAF);
  if (head) head.style.display = '';
  const DURATION = 9000;   // ~9s playback regardless of point count
  const t0 = performance.now();
  function frame(now) {
    const prog = Math.min(1, (now - t0) / DURATION);
    const n = Math.max(2, Math.floor(prog * curve.length));
    const slice = curve.slice(0, n);
    const pts = slice.map((p, i) => `${X(i).toFixed(1)},${Y(p.equity).toFixed(1)}`).join(' ');
    line.setAttribute('points', pts);
    if (fill) fill.setAttribute('points', `${padL},${H - padB} ${pts} ${X(n - 1).toFixed(1)},${H - padB}`);
    const cur = slice[slice.length - 1];
    if (head) { head.setAttribute('cx', X(n - 1).toFixed(1)); head.setAttribute('cy', Y(cur.equity).toFixed(1)); }
    svgEl.classList.toggle('up', cur.equity >= startCash);
    svgEl.classList.toggle('down', cur.equity < startCash);
    if (eqEl) eqEl.textContent = trMoney(cur.equity);
    const pnl = cur.equity - startCash;
    if (pnlEl) { pnlEl.textContent = trMoney(pnl); pnlEl.classList.toggle('up', pnl >= 0); pnlEl.classList.toggle('down', pnl < 0); }
    if (posEl) posEl.textContent = new Date(cur.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (narr) {
      const pct = ((cur.equity - startCash) / startCash * 100);
      narr.innerHTML = `${svg('pulse', 13)} <span><b>Playing back…</b> ${trMoney(cur.equity)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%) — ${new Date(cur.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>`;
    }
    if (prog < 1) { _trReplayRAF = requestAnimationFrame(frame); }
    else { _trReplayRAF = null; if (head) head.style.display = 'none'; if (typeof loadTrading === 'function') setTimeout(() => loadTrading(true), 600); }
  }
  _trReplayRAF = requestAnimationFrame(frame);
}

function wireTradingBody() {
  const byId = (id) => document.getElementById(id);
  // mode switch
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = async () => {
    if (b.disabled) return;
    try { await tradingSetMode(b.dataset.mode); loadTrading(); }
    catch (e) { toast((e && e.error) || 'Could not switch mode', 'close'); }
  });
  // auto-trade toggle
  const auto = byId('trAuto');
  if (auto) auto.onchange = async () => { try { await tradingSetAutoTrade(auto.checked); toast(auto.checked ? 'Auto-trading on' : 'Auto-trading paused'); } catch (e) { toast('Could not update', 'close'); loadTrading(); } };
  // deposit (the first deposit auto-runs the historical simulation server-side)
  const deposit = byId('trDeposit'), amt = byId('trDepositAmt');
  const afterDeposit = async (v, btn) => {
    if (btn) btn.disabled = true; toast(`Adding ${trMoney(v)} & simulating…`);
    try { const r = await tradingDeposit(v); await loadTrading(true); if (r && r.sandbox && r.sandbox.simulated) setTimeout(tradingPlayReplay, 120); }
    catch (e) { toast('Deposit failed', 'close'); if (btn) btn.disabled = false; }
  };
  if (deposit) deposit.onclick = () => { const v = Number(amt && amt.value); if (!(v > 0)) return toast('Enter an amount', 'close'); afterDeposit(v, deposit); };
  document.querySelectorAll('[data-deposit]').forEach(c => c.onclick = () => afterDeposit(Number(c.dataset.deposit), null));
  // run / re-run the historical simulation, then auto-play the replay animation
  const sim = byId('trSimulate');
  if (sim) sim.onclick = async () => {
    sim.disabled = true; toast('Simulating over market history…');
    try { await tradingSimulate(); await loadTrading(true); setTimeout(tradingPlayReplay, 120); }
    catch (e) { toast((e && e.error) || 'Could not simulate', 'close'); sim.disabled = false; }
  };
  // in-panel "Replay" just re-animates the curve already loaded (no refetch)
  const replayBtn = byId('trReplayBtn');
  if (replayBtn) replayBtn.onclick = () => tradingPlayReplay();
  // reset sandbox
  const reset = byId('trReset');
  if (reset) reset.onclick = () => confirmModal(
    'Reset the sandbox?',
    'This wipes your virtual portfolio, positions, and sandbox trade history back to zero. Your live brokerage connection is not touched. This cannot be undone.',
    async () => { try { await tradingReset(); toast('Sandbox reset'); loadTrading(); } catch (e) { toast('Could not reset', 'close'); } },
    'Reset'
  );
  // clear log
  const clearLog = byId('trClearLog');
  if (clearLog) clearLog.onclick = async () => { try { await tradingClearLog(); toast('Log cleared'); loadTrading(); } catch (e) { toast('Could not clear', 'close'); } };
  // live keys
  const saveKeys = byId('trSaveKeys');
  if (saveKeys) saveKeys.onclick = async () => {
    const k = byId('trKey'), s = byId('trSecret'), paper = byId('trPaper');
    if (!k || !s || !k.value.trim() || !s.value.trim()) return toast('Enter both key and secret', 'close');
    saveKeys.disabled = true;
    try { const r = await tradingSaveKeys(k.value.trim(), s.value.trim(), paper ? paper.checked : true); toast('Brokerage connected'); loadTrading(); }
    catch (e) { toast((e && e.error) || 'Keys rejected', 'close'); saveKeys.disabled = false; }
  };
  const clearKeys = byId('trClearKeys');
  if (clearKeys) clearKeys.onclick = () => confirmModal(
    'Disconnect brokerage?',
    'This removes your stored API keys and switches you back to the sandbox. Your brokerage account itself is unaffected.',
    async () => { try { await tradingClearKeys(); toast('Disconnected'); loadTrading(); } catch (e) { toast('Could not disconnect', 'close'); } },
    'Disconnect'
  );
  const liveEnable = byId('trLiveEnable');
  if (liveEnable) liveEnable.onchange = async () => {
    if (liveEnable.checked) {
      confirmModal(
        'Enable LIVE trading?',
        'The model will place REAL orders against your connected brokerage with REAL money. Backtested/paper results do not guarantee live performance. You can hit the kill switch at any time. Are you sure?',
        async () => { try { await tradingEnableLive(true); toast('Live trading enabled'); loadTrading(); } catch (e) { toast((e && e.error) || 'Could not enable', 'close'); loadTrading(); } },
        'Enable live'
      );
      liveEnable.checked = false;   // confirm path re-renders with the real state
    } else {
      try { await tradingEnableLive(false); toast('Live trading disabled'); loadTrading(); } catch (e) { loadTrading(); }
    }
  };
}

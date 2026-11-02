/* ============================================================
   TRADING ENGINE — the math core for the Trading app.
   Shared, dependency-free, and isomorphic: it runs UNCHANGED in the browser
   (so the dashboard can show what the model "thinks" without a round-trip) and in
   Node (where the GLOBAL model is trained, in the background, off the event loop).

   Everything here is plain JS numbers + Float64Array + JSON-serializable model
   objects, exactly like neural-engine.js, so a model can be trained a few steps in
   Node and saved to the (encrypted) trading_model row verbatim, then shipped to a
   browser as JSON to drive the same forward pass.

   What it does, end to end:
     OHLCV bars → indicators → per-window-normalized feature vector (NO LOOKAHEAD)
        → MLP classifier → P(up / flat / down) for the NEXT bar
        → threshold → BUY / SELL / HOLD signal (+ reason + confidence)
        → risk gate (sizing, caps, stop/take, daily-loss kill)
        → paper execution (fees + slippage modeled) → portfolio update + trade log.

   Guardrails baked in (straight from the project plan's "pitfalls"):
     • No lookahead — every feature at bar i uses ONLY bars ≤ i, and indicators are
       normalized per trailing window. The trainer's label for bar i is the sign of
       the return from i → i+1, and that label is NEVER fed back in as a feature.
     • Walk-forward — training/validation split is by TIME (purged), never random,
       so we don't leak the future into the past.
     • Fees + slippage — the paper simulator charges both, so a "profitable" backtest
       that's really a fee loser shows up as one.

   ⚠️ NOT FINANCIAL ADVICE. A backtested/paper edge is not a live edge. The Live
   path in the app is gated precisely because of everything this comment can't fix.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node (backend, global model training)
  if (typeof window !== 'undefined') window.TradingEngine = api;               // browser (dashboard preview)
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- RNG (same seedable mulberry32 the rest of the app uses) ---------- */
  function mulberry32(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clampInt(v, lo, hi, dflt) { v = Math.round(Number(v)); if (!Number.isFinite(v)) return dflt; return Math.max(lo, Math.min(hi, v)); }

  /* ============================================================
     INDICATORS — all causal (value at i depends only on bars ≤ i).
     Each takes an array of closes/bars and returns an aligned array (NaN where the
     window isn't full yet). We never read bar i+1 to compute anything at i.
     ============================================================ */
  function sma(values, period) {
    const out = new Array(values.length).fill(NaN);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }
  function ema(values, period) {
    const out = new Array(values.length).fill(NaN);
    const k = 2 / (period + 1);
    let prev;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (i === 0) { prev = v; out[i] = v; continue; }
      prev = v * k + prev * (1 - k);
      out[i] = i >= period - 1 ? prev : NaN;
    }
    return out;
  }
  // Wilder's RSI (0..100). 50 is neutral; <30 oversold, >70 overbought.
  function rsi(closes, period) {
    const out = new Array(closes.length).fill(NaN);
    if (closes.length < period + 1) return out;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const ch = closes[i] - closes[i - 1];
      if (ch >= 0) avgGain += ch; else avgLoss -= ch;
    }
    avgGain /= period; avgLoss /= period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      const gain = ch > 0 ? ch : 0, loss = ch < 0 ? -ch : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }
  // MACD line (fast EMA − slow EMA) and its signal EMA. Returns { macd, signal, hist }.
  function macd(closes, fast, slow, sig) {
    const ef = ema(closes, fast), es = ema(closes, slow);
    const line = closes.map((_, i) => (Number.isFinite(ef[i]) && Number.isFinite(es[i])) ? ef[i] - es[i] : NaN);
    const valid = line.map(v => Number.isFinite(v) ? v : 0);
    const signalRaw = ema(valid, sig);
    const signal = line.map((v, i) => Number.isFinite(v) ? signalRaw[i] : NaN);
    const hist = line.map((v, i) => (Number.isFinite(v) && Number.isFinite(signal[i])) ? v - signal[i] : NaN);
    return { macd: line, signal, hist };
  }
  // Average True Range — volatility in price units. Used to normalize and to size stops.
  function atr(bars, period) {
    const out = new Array(bars.length).fill(NaN);
    if (bars.length < 2) return out;
    const tr = new Array(bars.length).fill(NaN);
    for (let i = 1; i < bars.length; i++) {
      const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
      tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    let sum = 0, count = 0, prev;
    for (let i = 1; i < bars.length; i++) {
      if (count < period) { sum += tr[i]; count++; if (count === period) { prev = sum / period; out[i] = prev; } }
      else { prev = (prev * (period - 1) + tr[i]) / period; out[i] = prev; }
    }
    return out;
  }
  // rolling stdev of simple returns (volatility), causal.
  function rollingVol(closes, period) {
    const rets = closes.map((c, i) => i === 0 ? 0 : (c / closes[i - 1] - 1));
    const out = new Array(closes.length).fill(NaN);
    for (let i = period; i < closes.length; i++) {
      let mean = 0; for (let j = i - period + 1; j <= i; j++) mean += rets[j]; mean /= period;
      let v = 0; for (let j = i - period + 1; j <= i; j++) { const d = rets[j] - mean; v += d * d; }
      out[i] = Math.sqrt(v / period);
    }
    return out;
  }

  /* ============================================================
     FEATURE BUILDER — turn a window of bars into a fixed feature vector for bar i.
     Every feature is bounded/normalized so the net sees comparable magnitudes
     regardless of the symbol's absolute price (a $4 stock and a $400 stock produce
     the same-scale features). Critically: index i NEVER touches bar i+1.
     ============================================================ */
  // The feature order is FIXED and versioned. If you add/remove a feature, bump
  // FEATURE_VERSION so the server rebuilds models trained on the old layout.
  //
  // v2: a much wider, longer-memory view. The old 12-feature set only looked back
  // ~10 bars; this set reaches back ~100 bars across several horizons (returns,
  // momentum, trend, volatility, range position) so each inference sees far more
  // CONTEXT — short-term wiggle vs. the longer regime it sits in. Everything is still
  // per-window normalized + bounded (tanh / centered ratios) so it's price-scale
  // invariant and causal (bar i never reads bar i+1).
  // v3: volatility-scaled "tradeable move" labels (not any-tiny-move).
  // v4: trained on a longer, more varied window (1mo of 5-min bars) with a purged
  // validation split — forces a clean retrain so old overfit weights are discarded.
  const FEATURE_VERSION = 4;
  const FEATURE_NAMES = [
    // multi-horizon trailing log-returns (short wiggle → long drift)
    'ret1', 'ret2', 'ret3', 'ret5', 'ret10', 'ret20', 'ret40',
    // momentum oscillators at two speeds
    'rsiFast', 'rsiSlow', 'macdHist', 'macdHistSlope',
    // trend structure across short/medium/long moving averages
    'smaFastMed', 'smaMedSlow', 'priceVsMed', 'priceVsSlow', 'trendSlope',
    // volatility regime at multiple horizons
    'atrPct', 'vol20', 'vol50', 'volRatio',
    // where price sits in its recent range + distance from extremes
    'breakout20', 'breakout50', 'fromHigh', 'fromLow',
    // this bar's shape + volume context
    'rangePct', 'bodyPct', 'volZ', 'volTrend',
  ];
  const FEATURE_DIM = FEATURE_NAMES.length;

  const FP = {                  // feature-builder periods. More horizons than v1 so the
                                // model sees both fast moves and the slow regime around them.
    smaFast: 10, smaMed: 30, smaSlow: 60,
    rsiFast: 7, rsiSlow: 14,
    macdFast: 12, macdSlow: 26, macdSig: 9,
    atr: 14, volShort: 20, volLong: 50,
    breakoutShort: 20, breakoutLong: 50, extreme: 50,
  };
  // need enough history for the longest window (slow SMA + MACD slow) to be meaningful
  const WARMUP = Math.max(FP.smaSlow, FP.breakoutLong, FP.macdSlow + FP.macdSig) + 5;

  function tanh(x) { if (x > 20) return 1; if (x < -20) return -1; const e = Math.exp(2 * x); return (e - 1) / (e + 1); }

  // Precompute every indicator series ONCE for a bar array (so building features for
  // many bars is cheap). Returns a context the per-bar builder reads from.
  function indicatorContext(bars) {
    const closes = bars.map(b => b.c), vols = bars.map(b => b.v || 0);
    return {
      bars, closes, vols,
      smaFast: sma(closes, FP.smaFast),
      smaMed: sma(closes, FP.smaMed),
      smaSlow: sma(closes, FP.smaSlow),
      rsiFast: rsi(closes, FP.rsiFast),
      rsiSlow: rsi(closes, FP.rsiSlow),
      macd: macd(closes, FP.macdFast, FP.macdSlow, FP.macdSig),
      atr: atr(bars, FP.atr),
      vol20: rollingVol(closes, FP.volShort),
      vol50: rollingVol(closes, FP.volLong),
    };
  }
  // Build the feature vector for bar index i. Returns null until warmed up.
  function featuresAt(ctx, i) {
    if (i < WARMUP) return null;
    const { bars, closes, vols, smaFast, smaMed, smaSlow, rsiFast, rsiSlow, macd: m, atr: atrArr, vol20, vol50 } = ctx;
    const c = closes[i]; if (!(c > 0)) return null;
    const logRet = (n) => (i - n >= 0 && closes[i - n] > 0) ? Math.log(c / closes[i - n]) : 0;

    // volume z-score + a longer volume trend (recent avg vs older avg)
    let vMean = 0, vCnt = 0;
    for (let j = Math.max(0, i - FP.volShort + 1); j <= i; j++) { vMean += vols[j]; vCnt++; }
    vMean /= Math.max(1, vCnt);
    let vStd = 0; for (let j = Math.max(0, i - FP.volShort + 1); j <= i; j++) { const d = vols[j] - vMean; vStd += d * d; }
    vStd = Math.sqrt(vStd / Math.max(1, vCnt));
    const volZ = vStd > 0 ? tanh((vols[i] - vMean) / vStd) : 0;
    let vOld = 0, vOldCnt = 0;
    for (let j = Math.max(0, i - FP.volLong + 1); j <= i - FP.volShort; j++) { vOld += vols[j]; vOldCnt++; }
    vOld /= Math.max(1, vOldCnt);
    const volTrend = vOld > 0 ? tanh((vMean - vOld) / vOld) : 0;

    // range position + distance from recent extremes over two windows
    const rangePos = (win) => {
      let hi = -Infinity, lo = Infinity;
      for (let j = Math.max(0, i - win + 1); j <= i; j++) { if (bars[j].h > hi) hi = bars[j].h; if (bars[j].l < lo) lo = bars[j].l; }
      return hi > lo ? { pos: 2 * (c - lo) / (hi - lo) - 1, hi, lo } : { pos: 0, hi: c, lo: c };
    };
    const bk20 = rangePos(FP.breakoutShort), bk50 = rangePos(FP.breakoutLong);
    const fromHigh = bk50.hi > 0 ? tanh(((c - bk50.hi) / bk50.hi) * 25) : 0;   // ≤0: how far below the 50-bar high
    const fromLow = bk50.lo > 0 ? tanh(((c - bk50.lo) / bk50.lo) * 25) : 0;    // ≥0: how far above the 50-bar low

    // trend slope: normalized change in the medium SMA over ~10 bars
    let trendSlope = 0;
    if (Number.isFinite(smaMed[i]) && i - 10 >= 0 && Number.isFinite(smaMed[i - 10]) && smaMed[i - 10] > 0) {
      trendSlope = tanh(((smaMed[i] - smaMed[i - 10]) / smaMed[i - 10]) * 60);
    }
    // MACD histogram slope (is momentum accelerating?)
    const macdSlope = (Number.isFinite(m.hist[i]) && i - 3 >= 0 && Number.isFinite(m.hist[i - 3]))
      ? tanh(((m.hist[i] - m.hist[i - 3]) / c) * 400) : 0;

    const bar = bars[i];
    const body = Math.abs(bar.c - bar.o);

    const f = new Float64Array(FEATURE_DIM);
    let k = 0;
    f[k++] = tanh(logRet(1) * 50);
    f[k++] = tanh(logRet(2) * 35);
    f[k++] = tanh(logRet(3) * 25);
    f[k++] = tanh(logRet(5) * 18);
    f[k++] = tanh(logRet(10) * 12);
    f[k++] = tanh(logRet(20) * 8);
    f[k++] = tanh(logRet(40) * 5);
    f[k++] = Number.isFinite(rsiFast[i]) ? (rsiFast[i] - 50) / 50 : 0;
    f[k++] = Number.isFinite(rsiSlow[i]) ? (rsiSlow[i] - 50) / 50 : 0;
    f[k++] = Number.isFinite(m.hist[i]) ? tanh((m.hist[i] / c) * 200) : 0;
    f[k++] = macdSlope;
    f[k++] = (Number.isFinite(smaFast[i]) && Number.isFinite(smaMed[i])) ? tanh(((smaFast[i] - smaMed[i]) / c) * 100) : 0;
    f[k++] = (Number.isFinite(smaMed[i]) && Number.isFinite(smaSlow[i])) ? tanh(((smaMed[i] - smaSlow[i]) / c) * 100) : 0;
    f[k++] = Number.isFinite(smaMed[i]) ? tanh(((c - smaMed[i]) / c) * 50) : 0;
    f[k++] = Number.isFinite(smaSlow[i]) ? tanh(((c - smaSlow[i]) / c) * 40) : 0;
    f[k++] = trendSlope;
    f[k++] = Number.isFinite(atrArr[i]) ? tanh((atrArr[i] / c) * 30) : 0;
    f[k++] = Number.isFinite(vol20[i]) ? tanh(vol20[i] * 60) : 0;
    f[k++] = Number.isFinite(vol50[i]) ? tanh(vol50[i] * 60) : 0;
    f[k++] = (Number.isFinite(vol20[i]) && Number.isFinite(vol50[i]) && vol50[i] > 0) ? tanh((vol20[i] / vol50[i] - 1) * 3) : 0;
    f[k++] = bk20.pos;
    f[k++] = bk50.pos;
    f[k++] = fromHigh;
    f[k++] = fromLow;
    f[k++] = tanh(((bar.h - bar.l) / c) * 40);
    f[k++] = tanh((body / c) * 40) * (bar.c >= bar.o ? 1 : -1);
    f[k++] = volZ;
    f[k++] = volTrend;
    return f;
  }

  /* ============================================================
     MODEL — a small MLP classifier. Input = FEATURE_DIM features, two ReLU hidden
     layers, softmax over 3 classes: 0=DOWN, 1=FLAT, 2=UP (the next bar's direction).
     Trained by backprop + Adam, same idiom as the organizer in neural-engine.js.
     JSON-serializable: weights are plain arrays so the whole model round-trips to
     the encrypted trading_model row and to the browser unchanged.
     ============================================================ */
  const CLASSES = ['down', 'flat', 'up'];
  // Deeper + wider than v1's [24,16]. With the richer 28-feature input there's real
  // structure to compose (regime × momentum × range), and dropout + L2 keep the extra
  // capacity from just memorizing. Three hidden layers is plenty for tabular features.
  const HIDDEN_DEFAULT = [64, 48, 32];

  function randMat(rows, cols, rng, scale) {
    const a = new Float64Array(rows * cols);
    for (let i = 0; i < a.length; i++) a[i] = (rng() * 2 - 1) * scale;
    return a;
  }
  function newModel(opts) {
    opts = opts || {};
    const hidden = Array.isArray(opts.hidden) ? opts.hidden.slice() : HIDDEN_DEFAULT.slice();
    const seed = (opts.seed >>> 0) || 1;
    const rng = mulberry32(seed);
    const sizes = [FEATURE_DIM, ...hidden, CLASSES.length];
    const W = [], b = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const inp = sizes[l], out = sizes[l + 1];
      W.push(Array.from(randMat(out, inp, rng, 1 / Math.sqrt(inp))));
      b.push(Array.from(new Float64Array(out)));
    }
    return {
      v: 2, featureVersion: FEATURE_VERSION, inp: FEATURE_DIM, hidden, classes: CLASSES.slice(),
      W, b, seed,
      // training metadata (filled in by train())
      trainedSteps: 0, examplesSeen: 0, valAcc: null, valLoss: null, trainLoss: null, updated: 0,
    };
  }
  function softmax(logits) {
    let mx = -Infinity; for (const v of logits) if (v > mx) mx = v;
    let sum = 0; const out = new Float64Array(logits.length);
    for (let i = 0; i < logits.length; i++) { out[i] = Math.exp(logits[i] - mx); sum += out[i]; }
    for (let i = 0; i < out.length; i++) out[i] /= (sum || 1);
    return out;
  }
  // Forward pass; caches pre-activations + activations for backprop. If `dropMasks`
  // is supplied (training only), each hidden layer l is multiplied by dropMasks[l] —
  // a 0/scale array implementing inverted dropout (kept units scaled by 1/keepProb so
  // inference needs no rescale). Inference calls forward(m, x) with no masks, so it's
  // fully deterministic — dropout never affects a live prediction.
  function forward(m, x, dropMasks) {
    const acts = [x], pres = [];
    let prev = x;
    const L = m.W.length;
    for (let l = 0; l < L; l++) {
      const Wl = m.W[l], bl = m.b[l], out = bl.length, inp = prev.length;
      const pre = new Float64Array(out), act = new Float64Array(out);
      const last = l === L - 1;
      const mask = (!last && dropMasks) ? dropMasks[l] : null;
      for (let j = 0; j < out; j++) {
        let s = bl[j]; const base = j * inp;
        for (let k = 0; k < inp; k++) s += Wl[base + k] * prev[k];
        pre[j] = s;
        let a = last ? s : (s > 0 ? s : 0);   // ReLU on hidden, raw logits on output
        if (mask) a *= mask[j];               // inverted-dropout (0 or 1/keepProb)
        act[j] = a;
      }
      pres.push(pre);
      const a = last ? softmax(pre) : act;
      acts.push(a); prev = a;
    }
    return { acts, pres, probs: acts[acts.length - 1] };
  }
  // Predict class probabilities for one feature vector. Pure (no training state).
  function predict(m, x) {
    const out = forward(m, x).probs;
    return { down: out[0], flat: out[1], up: out[2] };
  }

  /* ---------- labels ----------
     The supervised target for bar i is the direction of the i → i+1 move, but ONLY
     counted as up/down if the move is BIG ENOUGH to be worth trading after costs —
     otherwise it's "flat". The threshold is VOLATILITY-SCALED: a move must exceed a
     multiple of the symbol's recent ATR (its typical bar size), so we don't call every
     micro-wiggle a signal. This is the fix for "accurate at flat": instead of learning
     that 99% of minute bars are flat (trivially accurate, untradeable), the model
     learns to flag the genuinely tradeable moves and stay flat on the noise.
     `deadband` is a floor (in fractional return) so it works even if ATR is missing.
     The label uses bar i+1 only — never part of the feature vector (anti-lookahead). */
  function labelAt(bars, i, deadband, moveThresh) {
    if (i + 1 >= bars.length) return -1;
    const r = bars[i + 1].c / bars[i].c - 1;
    const th = Math.max(deadband || 0, moveThresh || 0);
    if (r > th) return 2;        // up (a tradeable up-move)
    if (r < -th) return 0;       // down (a tradeable down-move)
    return 1;                    // flat / noise — stay out
  }

  /* ---------- build a labeled dataset from a bar series (causal + walk-forward) ----------
     Returns { X:[Float64Array], y:[int], idx:[barIndex] } in time order. The caller
     splits by TIME for validation (never shuffle across the split boundary). */
  function buildDataset(bars, opts) {
    opts = opts || {};
    // floor deadband + how many ATRs a move must clear to count as up/down. ~0.6×ATR
    // labels the moves that are big relative to the symbol's own noise — the ones a day
    // trader would actually act on — while keeping a small absolute floor.
    const deadband = opts.deadband == null ? 0.0015 : opts.deadband;
    const atrMult = opts.atrMult == null ? 0.6 : opts.atrMult;
    const ctx = indicatorContext(bars);
    const X = [], y = [], idx = [];
    for (let i = WARMUP; i < bars.length - 1; i++) {
      const f = featuresAt(ctx, i); if (!f) continue;
      // per-bar volatility-scaled move threshold: atrMult × (ATR / price)
      const c = ctx.closes[i];
      const atrPct = (Number.isFinite(ctx.atr[i]) && c > 0) ? ctx.atr[i] / c : 0;
      const moveThresh = atrPct * atrMult;
      const lbl = labelAt(bars, i, deadband, moveThresh); if (lbl < 0) continue;
      X.push(f); y.push(lbl); idx.push(i);
    }
    return { X, y, idx };
  }

  /* ---------- train ----------
     Mini-batch SGD + Adam over a labeled dataset, WALK-FORWARD: the last `valFrac`
     of the series (by time) is held out for validation and never trained on. opt
     persists Adam moments across calls so the GLOBAL model can be trained a few
     steps per background tick and keep improving. Returns metrics. */
  function train(m, dataset, opt) {
    opt = opt || {};
    const { X, y } = dataset;
    const n = X.length;
    if (n < 20) return { trained: false, reason: 'not enough data', n };
    const valFrac = opt.valFrac == null ? 0.25 : opt.valFrac;
    // PURGE GAP between train and validation: features/labels straddling the boundary
    // share overlapping windows, so an adjacent val set leaks and reports fake-high
    // accuracy. We drop `purge` examples between them so validation is a genuinely
    // held-out FUTURE slice — the honest measure of generalization.
    const purge = clampInt(opt.purge, 0, 500, Math.max(WARMUP, Math.floor(n * 0.04)));
    const split = Math.max(1, Math.floor(n * (1 - valFrac)));   // [0,split) train, [split+purge,n) validate
    const valStart = Math.min(n, split + purge);
    const lr = opt.lr || 0.008, epochs = clampInt(opt.epochs, 1, 50, 4);
    // Stronger regularization than v1 (1e-5). The bigger net needs it: L2 weight decay,
    // dropout on hidden layers, and label smoothing all fight overfitting — which is
    // the usual reason a model "gets worse the more it trains" on noisy market data.
    // These defaults (dropout 0.3, L2 1e-3) were tuned to roughly HALVE the train↔val
    // loss gap vs. weaker settings while improving validation accuracy.
    const l2 = opt.l2 == null ? 1e-3 : opt.l2;
    const dropout = opt.dropout == null ? 0.3 : Math.max(0, Math.min(0.6, opt.dropout));
    const keepProb = 1 - dropout, dropScale = keepProb > 0 ? 1 / keepProb : 1;
    const smooth = opt.labelSmooth == null ? 0.05 : Math.max(0, Math.min(0.3, opt.labelSmooth));
    const batchSize = clampInt(opt.batch, 1, 1024, 64);
    const C = m.classes.length;

    // Adam state (persisted on opt across ticks)
    const keys = []; for (let l = 0; l < m.W.length; l++) keys.push('W' + l, 'b' + l);
    const tensorOf = (k) => k[0] === 'W' ? m.W[+k.slice(1)] : m.b[+k.slice(1)];
    if (!opt.mom) { opt.mom = {}; opt.vel = {}; for (const k of keys) { const sz = tensorOf(k).length; opt.mom[k] = new Float64Array(sz); opt.vel[k] = new Float64Array(sz); } opt.t = 0; }
    const g = {}; for (const k of keys) g[k] = new Float64Array(tensorOf(k).length);
    const rng = mulberry32((opt.seed ?? m.seed ?? 1) >>> 0 || 1);

    // class weights — markets are mostly "flat"; without this the net collapses to
    // always-predict-flat. Weight inversely to class frequency on the TRAIN split.
    const freq = new Array(C).fill(0);
    for (let i = 0; i < split; i++) freq[y[i]]++;
    const cw = freq.map(f => f > 0 ? split / (C * f) : 1);

    const order = []; for (let i = 0; i < split; i++) order.push(i);
    let trainLoss = 0, trainN = 0;
    for (let ep = 0; ep < epochs; ep++) {
      for (let i = order.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = order[i]; order[i] = order[j]; order[j] = t; }
      for (let bStart = 0; bStart < order.length; bStart += batchSize) {
        const bEnd = Math.min(bStart + batchSize, order.length);
        for (const k of keys) g[k].fill(0);
        let bn = 0;
        for (let oi = bStart; oi < bEnd; oi++) {
          const ix = order[oi]; const x = X[ix], target = y[ix]; const w = cw[target];
          bn++;
          const L = m.W.length;
          // per-example dropout masks for the hidden layers (inverted dropout)
          let dropMasks = null;
          if (dropout > 0) {
            dropMasks = [];
            for (let l = 0; l < L - 1; l++) {
              const sz = m.b[l].length, mk = new Float64Array(sz);
              for (let j = 0; j < sz; j++) mk[j] = rng() < keepProb ? dropScale : 0;
              dropMasks.push(mk);
            }
          }
          const fwd = forward(m, x, dropMasks);
          const probs = fwd.probs;
          trainLoss += -Math.log(Math.max(probs[target], 1e-9)) * w; trainN++;
          // output gradient (softmax cross-entropy with label smoothing): the target
          // distribution is (1-smooth) on the true class + smooth/C spread over all,
          // so the net is never pushed to 100% confidence — generalizes better.
          let dOut = new Float64Array(C);
          for (let c = 0; c < C; c++) {
            const tgt = (c === target ? 1 - smooth : 0) + smooth / C;
            dOut[c] = (probs[c] - tgt) * w;
          }
          // backprop through layers (last → first). Dropped hidden units (mask 0) get
          // no gradient, exactly mirroring the forward pass.
          let dAct = dOut;
          for (let l = L - 1; l >= 0; l--) {
            const prevAct = fwd.acts[l], pre = fwd.pres[l];
            const out = m.b[l].length, inp = prevAct.length;
            const gW = g['W' + l], gB = g['b' + l], Wl = m.W[l];
            const mask = (l < L - 1 && dropMasks) ? dropMasks[l] : null;
            const dPrev = l > 0 ? new Float64Array(inp) : null;
            for (let j = 0; j < out; j++) {
              // ReLU gate on hidden layers (output layer has no activation gate)
              if (l < L - 1 && pre[j] <= 0) continue;
              if (mask && mask[j] === 0) continue;        // dropped unit — no gradient
              let dpre = dAct[j]; if (dpre === 0) continue;
              if (mask) dpre *= mask[j];                  // chain through the dropout scale
              gB[j] += dpre; const base = j * inp;
              for (let k = 0; k < inp; k++) {
                gW[base + k] += dpre * prevAct[k];
                if (dPrev) dPrev[k] += dpre * Wl[base + k];
              }
            }
            if (dPrev) dAct = dPrev;
          }
        }
        if (bn === 0) continue;
        // one Adam step on the mean batch gradient
        const inv = 1 / bn; opt.t++;
        const b1 = 0.9, b2 = 0.999, eps = 1e-8;
        const bc1 = 1 - Math.pow(b1, opt.t), bc2 = 1 - Math.pow(b2, opt.t);
        for (const k of keys) {
          const arr = tensorOf(k), gr = g[k], mo = opt.mom[k], ve = opt.vel[k];
          const decay = k[0] === 'b' ? 0 : l2;
          for (let i = 0; i < arr.length; i++) {
            let gi = gr[i] * inv + decay * arr[i];
            if (gi > 5) gi = 5; else if (gi < -5) gi = -5;
            mo[i] = b1 * mo[i] + (1 - b1) * gi;
            ve[i] = b2 * ve[i] + (1 - b2) * gi * gi;
            arr[i] -= lr * (mo[i] / bc1) / (Math.sqrt(ve[i] / bc2) + eps);
          }
        }
      }
    }

    // validation on the held-out FUTURE tail (after the purge gap; never trained on)
    let valLoss = 0, valCorrect = 0, valN = 0;
    for (let i = valStart; i < n; i++) {
      const fwd = forward(m, X[i]); const probs = fwd.probs; const target = y[i];
      valLoss += -Math.log(Math.max(probs[target], 1e-9));
      let arg = 0; for (let c = 1; c < C; c++) if (probs[c] > probs[arg]) arg = c;
      if (arg === target) valCorrect++; valN++;
    }
    m.trainedSteps = (m.trainedSteps || 0) + 1;
    m.examplesSeen = (m.examplesSeen || 0) + trainN;
    m.trainLoss = trainN ? trainLoss / trainN : null;
    m.valLoss = valN ? valLoss / valN : null;
    m.valAcc = valN ? valCorrect / valN : null;
    m.updated = Date.now();
    return { trained: true, n, split, trainLoss: m.trainLoss, valLoss: m.valLoss, valAcc: m.valAcc, classFreq: freq };
  }

  /* ============================================================
     SIGNAL — turn the model's probabilities at the LATEST bar into an action.
     Confidence = P(up) − P(down). A position is only opened when confidence clears
     a threshold (so "flat / unsure" stays out of the market). Returns the standard
     Signal interface the project plan specifies: { action, confidence, reason }.
     ============================================================ */
  // Default confidence threshold to ACT on a signal. Tuned to the v2 model: label
  // smoothing makes probabilities better-calibrated (less overconfident), so the
  // confidence gap P(up)−P(down) is naturally smaller — 0.08 lets it trade on its
  // more confident ~15-20% of bars and hold the rest, instead of the old 0.15 which
  // left the calibrated model holding ~98% of the time.
  const DEFAULT_THRESHOLD = 0.08;
  function signalFromBars(m, bars, opts) {
    opts = opts || {};
    const threshold = opts.threshold == null ? DEFAULT_THRESHOLD : opts.threshold;
    if (!bars || bars.length < WARMUP + 1) return { action: 'HOLD', confidence: 0, reason: 'warming up (not enough history yet)', probs: null };
    const ctx = indicatorContext(bars);
    const i = bars.length - 1;
    const f = featuresAt(ctx, i);
    if (!f) return { action: 'HOLD', confidence: 0, reason: 'indicators not ready', probs: null };
    const p = predict(m, f);
    const conf = p.up - p.down;
    let action = 'HOLD', reason;
    if (conf >= threshold) { action = 'BUY'; reason = `model favors UP (P=${(p.up * 100).toFixed(0)}% vs DOWN ${(p.down * 100).toFixed(0)}%)`; }
    else if (conf <= -threshold) { action = 'SELL'; reason = `model favors DOWN (P=${(p.down * 100).toFixed(0)}% vs UP ${(p.up * 100).toFixed(0)}%)`; }
    else reason = `no edge — confidence ${(conf * 100).toFixed(0)}% under ±${(threshold * 100).toFixed(0)}% threshold`;
    return { action, confidence: conf, reason, probs: p };
  }

  /* ============================================================
     PORTFOLIO DECISION — day-trader-style conviction layer.
     Instead of nibbling a fixed % into every symbol that pokes over the threshold,
     this looks at ALL symbols at once and makes a portfolio-level call each step:

       • ALL-OUT (risk-off): if the book is broadly bearish/uncertain — the average
         signal is negative, or NOTHING clears the entry bar — flatten EVERYTHING to
         cash in one pass. A day trader who sees the tape roll over goes flat.
       • ALL-IN (conviction): rank symbols by confidence; deploy capital into the top
         high-conviction names, sizing UP with confidence (a strong signal gets a big
         slice, not a fixed 10%). The strongest single setup can take the lion's share.
       • EXIT losers: sell any held name whose signal has flipped against us (or decayed
         below the EXIT band), even if we're not flattening the whole book.
       • COOLDOWN: don't re-buy a symbol within `cooldownBars` of selling it, so it
         can't thrash in and out on noise.

     It returns an ordered list of {side,symbol,confidence,reason,targetFrac} the caller
     turns into real orders via riskGate/applyOrder (sells first, then buys). `state`
     carries cross-step memory (last-exit bar per symbol) and is mutated in place.
     ============================================================ */
  const DEFAULT_DECISION = {
    entryThreshold: 0.15,   // need real conviction to OPEN — calmer, fewer, better trades
    exitThreshold: 0.03,    // exit when the edge decays toward neutral / flips
    maxNames: 4,            // concentrate into at most this many positions at once
    maxFracPerName: 0.6,    // a single high-conviction name can take up to 60% of equity (all-in-ish)
    cooldownBars: 20,       // bars to wait before re-entering a symbol after selling it
    minHoldBars: 15,        // once IN a name, hold it at least this long (no instant flip-out)
    minConfToDeploy: 0.15,  // don't deploy cash unless at least one name clears this
    // HYSTERESIS on the risk-off switch (separate enter/exit bands so we don't chatter
    // on the boundary): go all-out only when clearly bearish, and only come back risk-ON
    // when clearly not. A single shared threshold caused buy/sell whipsaw every bar.
    riskOffEnter: -0.05,    // flatten to cash when the avg signal drops to/below this
    riskOffExit: 0.02,      // only allow deploying again once the avg signal recovers above this
    // Heavily smooth the model's per-bar confidence (EMA ≈ 15-bar average). The model is
    // jumpy bar-to-bar on noisy intraday data; acting on the smoothed conviction — plus
    // the long min-hold/cooldown above — is what stops the whole book whipsawing. Tuned
    // to cut trades ~4× (≈198→≈44) and roughly quarter the noise-bleed.
    smoothAlpha: 0.12,
  };
  // preds: [{ symbol, conf, price }] (conf = P(up)−P(down)). portfolio: the live pf.
  // state carries cross-step memory: lastExit/lastEntry/ema per symbol, barIndex, riskOff.
  function decidePortfolio(preds, portfolio, opts, state) {
    const o = Object.assign({}, DEFAULT_DECISION, opts || {});
    state = state || {};
    state.lastExit = state.lastExit || {};
    state.lastEntry = state.lastEntry || {};
    state.ema = state.ema || {};
    const barIndex = state.barIndex || 0;
    const orders = [];
    if (!preds.length) return orders;

    // SMOOTH each symbol's confidence with an EMA so a single noisy per-bar prediction
    // can't trigger a trade. The model can be jumpy bar-to-bar on minute data; we act on
    // the smoothed conviction, which is what stops the buy/sell-every-bar whipsaw at the
    // source. smoothAlpha≈0.4 ≈ a ~5-bar average.
    const alpha = o.smoothAlpha == null ? 0.4 : o.smoothAlpha;
    for (const p of preds) {
      const prev = state.ema[p.symbol];
      p.raw = p.conf;
      p.conf = prev == null ? p.conf : (alpha * p.conf + (1 - alpha) * prev);
      state.ema[p.symbol] = p.conf;
    }

    const avg = preds.reduce((s, p) => s + p.conf, 0) / preds.length;
    const best = preds.reduce((m, p) => Math.max(m, p.conf), -Infinity);
    const positions = portfolio.positions || {};
    const heldSyms = Object.keys(positions).filter(s => positions[s].qty > 0);

    // ---- 1) RISK-OFF with HYSTERESIS: latch all-out when clearly bearish, stay out
    // until clearly recovered. This is the fix for the buy/sell-every-bar whipsaw.
    // Guard: with only ONE symbol in the book, a single name's swings shouldn't drive an
    // all-out — the "no edge anywhere" trigger needs a real multi-name read, so we only
    // apply the best<minConf trigger when there are ≥2 predictions. ----
    const multi = preds.length >= 2;
    if (state.riskOff) { if (avg >= o.riskOffExit && best >= o.minConfToDeploy) state.riskOff = false; }
    else { if (avg <= o.riskOffEnter || (multi && best < o.minConfToDeploy)) state.riskOff = true; }
    if (state.riskOff) {
      for (const s of heldSyms) {
        orders.push({ side: 'sell', symbol: s, confidence: 0, reason: best < o.minConfToDeploy ? 'all-out — no edge anywhere, going to cash' : 'all-out — book turned bearish' });
        state.lastExit[s] = barIndex;
      }
      return orders;   // when flattening, do nothing else this step
    }

    // ---- 2) EXIT held names whose signal flipped/decayed — but honor a MIN HOLD so a
    // freshly-opened position isn't dumped one bar later on noise (unless it hard-flips
    // clearly DOWN, which always overrides the min-hold). ----
    const confBySym = {}; for (const p of preds) confBySym[p.symbol] = p.conf;
    for (const s of heldSyms) {
      const cf = confBySym[s];
      const heldFor = barIndex - (state.lastEntry[s] ?? -1e9);
      const hardFlip = cf != null && cf <= -o.exitThreshold;     // clearly bearish now
      const decayed = cf == null || cf < o.exitThreshold;        // edge gone
      if (hardFlip || (decayed && heldFor >= o.minHoldBars)) {
        orders.push({ side: 'sell', symbol: s, confidence: cf || 0, reason: hardFlip ? 'exit — signal flipped DOWN' : 'exit — edge decayed' });
        state.lastExit[s] = barIndex;
      }
    }
    const willHold = new Set(heldSyms.filter(s => !orders.find(or => or.symbol === s)));

    // ---- 3) ALL-IN: deploy into the strongest BUY signals, sized by conviction ----
    const buys = preds
      .filter(p => p.conf >= o.entryThreshold && !willHold.has(p.symbol))
      .filter(p => (barIndex - (state.lastExit[p.symbol] ?? -1e9)) >= o.cooldownBars)   // respect cooldown
      .sort((a, b) => b.conf - a.conf);
    const slots = Math.max(0, o.maxNames - willHold.size);
    const picks = buys.slice(0, slots);
    if (picks.length) {
      // weight by confidence so a stronger signal gets a bigger slice; cap per name.
      const totalConf = picks.reduce((s, p) => s + p.conf, 0) || 1;
      for (const p of picks) {
        const frac = Math.min(o.maxFracPerName, (p.conf / totalConf));
        orders.push({ side: 'buy', symbol: p.symbol, confidence: p.conf, targetFrac: frac, reason: `all-in — strongest signal (conf ${(p.conf * 100).toFixed(0)}%)` });
        state.lastEntry[p.symbol] = barIndex;   // record entry for the min-hold guard
      }
    }
    return orders;
  }

  /* ============================================================
     RISK GATE — the NON-NEGOTIABLE check between a signal and an order (plan §5).
     Given a desired action, current portfolio, price and risk params, it returns the
     APPROVED order (or a rejection). Enforces: position sizing cap, max open
     positions, daily-loss kill switch, and attaches stop-loss / take-profit levels.
     ============================================================ */
  const DEFAULT_RISK = {
    perTradePct: 0.1,      // ≤10% of equity per position
    maxPositions: 5,       // at most N symbols held at once
    maxDailyLossPct: 0.05, // if today's realized+unrealized loss hits 5% of start-of-day equity → kill
    stopLossPct: 0.03,     // 3% stop
    takeProfitPct: 0.06,   // 6% target
    fractional: true,      // allow fractional shares so small accounts ($10+) can trade
    minNotional: 1,        // don't place a buy under $1 of notional
  };
  function riskGate({ action, symbol, price, equity, cash, positions, risk, dayStartEquity, realizedToday, sizeFrac }) {
    risk = Object.assign({}, DEFAULT_RISK, risk || {});
    const held = positions[symbol];
    // daily-loss kill switch: once tripped, only EXITS are allowed
    const dayPnl = (equity - (dayStartEquity || equity));
    const killed = dayStartEquity && dayPnl <= -Math.abs(dayStartEquity * risk.maxDailyLossPct);

    if (action === 'SELL' || action === 'HOLD') {
      // SELL closes a held long (we don't model shorting in the paper sim — flat is fine)
      if (held && held.qty > 0 && action === 'SELL') {
        return { ok: true, side: 'sell', symbol, qty: held.qty, price, reason: 'close position' };
      }
      return { ok: false, reason: action === 'HOLD' ? 'hold' : 'nothing to sell' };
    }
    // action === 'BUY'
    if (killed) return { ok: false, reason: `daily-loss kill switch tripped (${(dayPnl / dayStartEquity * 100).toFixed(1)}%)` };
    if (held && held.qty > 0) return { ok: false, reason: 'already in position' };
    if (!(price > 0)) return { ok: false, reason: 'no price' };
    // Position size: the conviction layer passes a sizeFrac (its all-in weight); without
    // one we fall back to the fixed per-trade cap and the max-positions guard.
    let budget;
    if (sizeFrac != null) {
      budget = Math.min(cash, equity * Math.max(0, Math.min(1, sizeFrac)));
    } else {
      const openCount = Object.values(positions).filter(p => p.qty > 0).length;
      if (openCount >= risk.maxPositions) return { ok: false, reason: `max positions (${risk.maxPositions}) reached` };
      budget = Math.min(cash, equity * risk.perTradePct);
    }
    // FRACTIONAL shares (default): size by dollar notional so even a $10 account can
    // trade a $700 stock — like Cash App / Robinhood / Alpaca fractional orders. Only
    // a tiny minimum-notional floor blocks dust trades. Set risk.fractional=false to
    // force whole shares (then we floor to an integer quantity as before).
    const fractional = risk.fractional !== false;
    const minNotional = risk.minNotional == null ? 1 : risk.minNotional;
    if (budget < minNotional) return { ok: false, reason: `position too small (under $${minNotional} at the risk cap)` };
    let qty = fractional ? roundQty(budget / price) : Math.floor(budget / price);
    if (!(qty > 0)) return { ok: false, reason: fractional ? 'position too small' : 'position too small for one whole share at risk cap' };
    return {
      ok: true, side: 'buy', symbol, qty, price, notional: qty * price,
      stop: price * (1 - risk.stopLossPct),
      take: price * (1 + risk.takeProfitPct),
      reason: 'sized within risk caps',
    };
  }
  // round a fractional share quantity to 6 dp (Alpaca's max fractional precision),
  // trimming float noise. Tiny dust (< 1e-6 shares) rounds to 0 -> rejected.
  function roundQty(q) { return Math.round(q * 1e6) / 1e6; }

  /* ============================================================
     PAPER EXECUTION — apply an approved order to a portfolio with fees + slippage
     modeled (plan §5: a strategy profitable BEFORE costs is often a loser after).
     The portfolio is a plain JSON object so it persists verbatim in the per-account
     store. Slippage moves the fill against us; a flat per-trade fee is charged.
     ============================================================ */
  const DEFAULT_COSTS = { slippagePct: 0.0005, feePerTrade: 0 /* commission-free equities */ };
  function newPortfolio(cash) {
    return { cash: Number(cash) || 0, positions: {}, realized: 0, trades: 0, equity: Number(cash) || 0, history: [] };
  }
  function fillPrice(price, side, costs) {
    const slip = price * (costs.slippagePct || 0);
    return side === 'buy' ? price + slip : price - slip;   // always worse for us
  }
  function applyOrder(pf, order, costs) {
    costs = Object.assign({}, DEFAULT_COSTS, costs || {});
    const fee = costs.feePerTrade || 0;
    const px = fillPrice(order.price, order.side, costs);
    if (order.side === 'buy') {
      const cost = px * order.qty + fee;
      if (cost > pf.cash + 1e-9) return { ok: false, reason: 'insufficient cash' };
      pf.cash -= cost; pf.trades++;
      pf.positions[order.symbol] = { qty: order.qty, entry: px, stop: order.stop || null, take: order.take || null, openedAt: Date.now() };
      return { ok: true, side: 'buy', symbol: order.symbol, qty: order.qty, price: px, fee, reason: order.reason };
    } else {
      const held = pf.positions[order.symbol];
      if (!held || held.qty <= 0) return { ok: false, reason: 'no position to sell' };
      const qty = Math.min(order.qty, held.qty);
      const proceeds = px * qty - fee;
      const pnl = (px - held.entry) * qty - fee;
      pf.cash += proceeds; pf.realized += pnl; pf.trades++;
      held.qty = roundQty(held.qty - qty);
      if (held.qty <= 1e-6) delete pf.positions[order.symbol];   // close out (ignore float dust)
      return { ok: true, side: 'sell', symbol: order.symbol, qty, price: px, fee, pnl, reason: order.reason };
    }
  }
  // mark-to-market equity given the latest price per symbol ({SYMBOL: price})
  function markToMarket(pf, prices) {
    let posValue = 0;
    for (const [sym, pos] of Object.entries(pf.positions)) {
      const px = prices[sym]; if (px > 0) posValue += px * pos.qty;
    }
    pf.equity = pf.cash + posValue;
    return pf.equity;
  }
  // check stop-loss / take-profit on held positions against the latest price; returns
  // the list of forced-exit orders to run through applyOrder.
  function stopOrders(pf, prices) {
    const exits = [];
    for (const [sym, pos] of Object.entries(pf.positions)) {
      const px = prices[sym]; if (!(px > 0) || pos.qty <= 0) continue;
      if (pos.stop && px <= pos.stop) exits.push({ side: 'sell', symbol: sym, qty: pos.qty, price: px, reason: 'stop-loss hit' });
      else if (pos.take && px >= pos.take) exits.push({ side: 'sell', symbol: sym, qty: pos.qty, price: px, reason: 'take-profit hit' });
    }
    return exits;
  }

  /* ============================================================
     BACKTEST — replay the model over the symbols' HISTORY with a starting balance,
     so the user instantly sees "what would have happened if I'd given the model $X."
     This is what makes the sandbox a real simulation rather than a wait-and-watch:
     it produces a full equity curve, every simulated buy/sell, and final P&L the
     moment they deposit.

     It walks all symbols in lockstep by bar index (the symbols are daily-aligned),
     and at each step runs the SAME logic the live sandbox loop uses — stop/take exits
     first, then per-symbol signal → risk gate → execute — against ONE shared-cash
     portfolio. No lookahead: the signal at step i is computed from bars[0..i] only.

     bySymbol: { SYMBOL: bars[] }. Returns { portfolio, trades, curve, stats, lastBarTs }.
     The returned portfolio is the state at the end of history; the live loop then
     continues forward from `lastBarTs`. ============================================================ */
  function backtest(model, bySymbol, opts) {
    opts = opts || {};
    const cash = Number(opts.cash) || 0;
    const threshold = opts.threshold == null ? DEFAULT_THRESHOLD : opts.threshold;
    const risk = opts.risk || {};
    const costs = opts.costs || {};
    const symbols = Object.keys(bySymbol).filter(s => Array.isArray(bySymbol[s]) && bySymbol[s].length > WARMUP + 2);
    if (!symbols.length || cash <= 0) return { portfolio: newPortfolio(cash), trades: [], curve: [], stats: emptyStats(cash), lastBarTs: 0 };

    // Align all symbols to the SHORTEST common length so they all "start" together.
    // Without this, a symbol with deeper history (e.g. BTC has more bars than equities)
    // trades ALONE in its early stretch — and a one-symbol book makes the all-out/all-in
    // decision oscillate on that single name. Trimming to a common window removes that
    // whipsaw entirely; the few extra leading bars we drop don't matter for a backtest.
    let minLen = Infinity;
    for (const s of symbols) minLen = Math.min(minLen, bySymbol[s].length);
    if (minLen > 50) { for (const s of symbols) bySymbol[s] = bySymbol[s].slice(-minLen); }

    const ctx = {}; let maxLen = 0;
    for (const s of symbols) { ctx[s] = indicatorContext(bySymbol[s]); maxLen = Math.max(maxLen, bySymbol[s].length); }

    const pf = newPortfolio(cash);
    const trades = [];
    const curve = [];
    let peak = cash, maxDD = 0, wins = 0, losses = 0;
    let dayStartEquity = cash;
    // conviction-layer options + cross-step memory (cooldown bookkeeping)
    const decOpts = opts.decision || {};
    const decState = { lastExit: {}, barIndex: 0 };

    // index offset per symbol so the LAST bars align: symbol s contributes its bar
    // (i - (maxLen - len_s)). Before that offset the symbol isn't "born" yet.
    const off = {}; for (const s of symbols) off[s] = maxLen - bySymbol[s].length;

    let curDay = null;
    for (let i = 0; i < maxLen; i++) {
      // current price per symbol at this step (its aligned bar's close)
      const prices = {};
      for (const s of symbols) { const j = i - off[s]; if (j >= 0) prices[s] = bySymbol[s][j].c; }
      if (!Object.keys(prices).length) continue;
      markToMarket(pf, prices);
      // reset the daily-loss baseline on a real calendar-day change (so the kill switch
      // actually works on intraday data instead of resetting every single bar).
      const tNow = barTs(bySymbol, symbols, i, off);
      const day = new Date(tNow); const dayKey = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
      if (dayKey !== curDay) { curDay = dayKey; dayStartEquity = pf.equity; }

      // 1) forced exits first (stop-loss / take-profit)
      for (const ex of stopOrders(pf, prices)) {
        const r = applyOrder(pf, ex, costs);
        if (r.ok) { trades.push(tradeRow(bySymbol[ex.symbol][i - off[ex.symbol]], r)); if (r.pnl > 0) wins++; else if (r.pnl < 0) losses++; }
      }
      // 2) day-trader conviction layer: score every symbol, then decide the whole book
      // (all-out to cash when bearish/no-edge; all-in into the strongest signals).
      const preds = [];
      for (const s of symbols) {
        const j = i - off[s]; if (j < WARMUP) continue;
        const price = prices[s]; if (!(price > 0)) continue;
        const f = featuresAt(ctx[s], j); if (!f) continue;
        const p = predict(model, f);
        preds.push({ symbol: s, conf: p.up - p.down, price });
      }
      decState.barIndex = i;
      const decisions = decidePortfolio(preds, pf, decOpts, decState);
      // sells first (frees cash for the buys), then buys
      decisions.sort((a, b) => (a.side === 'sell' ? -1 : 1) - (b.side === 'sell' ? -1 : 1));
      for (const d of decisions) {
        const j = i - off[d.symbol]; const price = prices[d.symbol]; if (!(price > 0)) continue;
        markToMarket(pf, prices);
        const gate = riskGate({ action: d.side === 'sell' ? 'SELL' : 'BUY', symbol: d.symbol, price, equity: pf.equity, cash: pf.cash, positions: pf.positions, risk, dayStartEquity, sizeFrac: d.targetFrac });
        if (!gate.ok) continue;
        const r = applyOrder(pf, gate, costs);
        if (r.ok) { trades.push(tradeRow(bySymbol[d.symbol][j], { ...r, reason: d.reason })); if (r.pnl > 0) wins++; else if (r.pnl < 0) losses++; }
      }
      markToMarket(pf, prices);
      if (pf.equity > peak) peak = pf.equity;
      const dd = peak > 0 ? (peak - pf.equity) / peak : 0; if (dd > maxDD) maxDD = dd;
      // sample the curve at a sane density (cap points for the sparkline)
      const tBar = barTs(bySymbol, symbols, i, off);
      curve.push({ t: tBar, equity: Math.round(pf.equity * 100) / 100 });
    }

    // close-out marks at the final prices
    const finalPrices = {}; for (const s of symbols) finalPrices[s] = bySymbol[s][bySymbol[s].length - 1].c;
    markToMarket(pf, finalPrices);
    const closedTrades = wins + losses;
    const stats = {
      startCash: cash, finalEquity: Math.round(pf.equity * 100) / 100,
      pnl: Math.round((pf.equity - cash) * 100) / 100,
      returnPct: cash > 0 ? (pf.equity - cash) / cash : 0,
      trades: pf.trades, closedTrades, wins, losses,
      winRate: closedTrades ? wins / closedTrades : 0,
      maxDrawdown: maxDD, bars: maxLen,
    };
    const lastBarTs = barTs(bySymbol, symbols, maxLen - 1, off);
    return { portfolio: pf, trades, curve: downsample(curve, opts.maxCurve || 400), stats, lastBarTs };
  }
  function emptyStats(cash) { return { startCash: cash, finalEquity: cash, pnl: 0, returnPct: 0, trades: 0, closedTrades: 0, wins: 0, losses: 0, winRate: 0, maxDrawdown: 0, bars: 0 }; }
  function tradeRow(bar, r) {
    return { ts: bar && bar.t ? (typeof bar.t === 'number' ? bar.t : Date.parse(bar.t) || Date.now()) : Date.now(), symbol: r.symbol, side: r.side, qty: r.qty, price: Math.round(r.price * 100) / 100, pnl: r.pnl == null ? null : Math.round(r.pnl * 100) / 100, reason: r.reason };
  }
  function barTs(bySymbol, symbols, i, off) {
    for (const s of symbols) { const j = i - off[s]; const b = bySymbol[s][j]; if (b) return typeof b.t === 'number' ? b.t : (Date.parse(b.t) || Date.now()); }
    return Date.now();
  }
  // keep at most `max` evenly-spaced points (the curve can be ~500+ daily bars)
  function downsample(arr, max) {
    if (arr.length <= max) return arr;
    const out = []; const step = arr.length / max;
    for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
    out.push(arr[arr.length - 1]);
    return out;
  }

  return {
    // meta
    FEATURE_VERSION, FEATURE_NAMES, FEATURE_DIM, FEATURE_PERIODS: FP, WARMUP, CLASSES,
    DEFAULT_RISK, DEFAULT_COSTS, DEFAULT_THRESHOLD, DEFAULT_DECISION,
    decidePortfolio,
    // indicators (exported for tests / dashboard)
    sma, ema, rsi, macd, atr, rollingVol,
    // features + model
    indicatorContext, featuresAt, buildDataset, labelAt,
    newModel, forward, predict, train, signalFromBars,
    // risk + execution
    riskGate, newPortfolio, applyOrder, markToMarket, stopOrders,
    // backtest (instant sandbox simulation over history)
    backtest,
    // rng (so callers can seed deterministically)
    mulberry32,
  };
});

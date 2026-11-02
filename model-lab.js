/* ============================================================
   MODEL LAB — hands-on raw inference for GGUF models
   ------------------------------------------------------------
   Opened from a .gguf file's right-click menu (or the AI app's Local tab). It
   talks ONLY to /api/ai/lab/*, which never adds a persona, memory, tools or a
   system prompt — the model sees exactly the prompt you write (raw), or your
   conversation rendered through the model's OWN chat template (chat).

   Inspect mode : one model. Step token-by-token, see the top-K distribution for
                  the next position, click any candidate to force it, branch from
                  any earlier token, run N tokens, watch per-token confidence /
                  entropy, and get warnings for NaN/Inf, flat logits, loops, etc.
   Compare mode : up to 4 models on the same prompt + sampling settings, run one
                  after another (the server may only hold one in RAM), with
                  side-by-side outputs, stats, an overlay confidence chart, a
                  next-token comparison and the point where outputs diverge.

   Lazy-loaded (data.js LAZY_MODULES['model-lab']); exposes window.openModelLab.
   ============================================================ */
(function () {
  'use strict';

  // stylesheet ships alongside (kept out of the boot CSS so the vault paints fast)
  if (!document.querySelector('link[data-mlab-css]')) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/model-lab.css'; l.dataset.mlabCss = '1';
    document.head.appendChild(l);
  }

  const MAX_COMPARE = 4;
  const COLORS = ['oklch(0.80 0.14 74)', 'oklch(0.76 0.13 235)', 'oklch(0.76 0.14 330)', 'oklch(0.78 0.13 160)'];
  const LN2 = Math.LN2;

  /* ---------- state ---------- */
  let ML = null;            // the open lab (one at a time)

  function freshState() {
    return {
      el: null,
      mode: 'inspect',
      models: [], maxLoaded: 1, loadedIds: new Set(),
      sessions: new Map(),      // id -> session
      order: [],                // ids shown as chips (inspect uses activeId, compare uses all)
      activeId: null,
      prompt: { kind: 'raw', raw: '', messages: [{ role: 'user', content: '' }], addBos: true },
      samp: { temperature: 0.7, top_k: 40, top_p: 0.95, min_p: 0.05, repeat_penalty: 1, seed: -1, n_probs: 10, n_predict: 64, max_reply: 256, ignore_eos: false, post: false },
      autoAccept: false,
      busy: false, ac: null,
      sel: null,                // { id, idx } selected generated token
      mobileTab: 'main',
      showPromptToks: false,
      compareNext: false,       // compare: show next-token distributions
    };
  }

  function newSession(id) {
    const m = ML.models.find(x => x.id === id) || { id, name: id };
    return {
      id, name: m.name, size: m.size || 0, source: m.source,
      color: COLORS[ML.order.length % COLORS.length],
      meta: null, props: null, status: ML.loadedIds.has(id) ? 'ready' : 'idle', stage: '',
      promptKey: null, promptToks: [], gen: [], pending: null, history: [],
      warns: new Map(), timings: null, error: null, rendered: 0,
    };
  }

  /* ---------- helpers ---------- */
  const $ = (sel, root) => (root || ML.el).querySelector(sel);
  const $$ = (sel, root) => [...(root || ML.el).querySelectorAll(sel)];
  const fin = (x) => typeof x === 'number' && Number.isFinite(x);
  const pct = (p) => p == null || !fin(p) ? '—' : (p >= 0.995 ? '100' : p < 0.001 ? (p > 0 ? '<0.1' : '0') : (p * 100).toFixed(p < 0.1 ? 1 : 0)) + '%';
  const fmtN = (n, d = 2) => n == null || !fin(n) ? '—' : (Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : Math.abs(n) >= 10 ? n.toFixed(Math.min(d, 1)) : n.toFixed(d));
  const fmtParams = (n) => !n ? '—' : n >= 1e9 ? (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B' : n >= 1e6 ? Math.round(n / 1e6) + 'M' : Math.round(n / 1e3) + 'K';
  const sizeStr = (b) => (typeof fmtSize === 'function' ? fmtSize(b) : Math.round(b / 1e6) + ' MB');

  /* Display form of a token piece: show invisible characters so token boundaries read. */
  function pieceText(t) {
    let s = (t && t.text != null) ? String(t.text) : '';
    if (s.includes('�') && t && Array.isArray(t.bytes) && t.bytes.length) s = t.bytes.map(b => '<0x' + b.toString(16).toUpperCase().padStart(2, '0') + '>').join('');
    if (s === '') return '∅';
    return s.replace(/\n/g, '↵').replace(/\t/g, '⇥').replace(/\r/g, '␍');
  }
  const probOf = (t) => t == null ? null : (t.prob != null ? (fin(t.prob) ? t.prob : NaN) : (t.logprob == null ? NaN : fin(t.logprob) ? Math.exp(t.logprob) : (t.logprob === -Infinity ? 0 : NaN)));

  /* Build a normalized step from a server token event. */
  function makeStep(ev, forcedId) {
    const top = (ev.top || []).filter(Boolean).map(c => ({ id: c.id, text: c.text, bytes: c.bytes, p: probOf(c), lp: c.logprob }));
    let chosen = { id: ev.id, text: ev.text, bytes: ev.bytes, p: probOf(ev), lp: ev.logprob };
    let forced = false;
    if (forcedId != null && forcedId !== ev.id) {
      const alt = top.find(c => c.id === forcedId);
      chosen = alt ? { ...alt } : { id: forcedId, text: '', p: null };
      forced = true;
    }
    const nan = top.some(c => !fin(c.p)) || (chosen.p != null && Number.isNaN(chosen.p));
    let mass = 0, H = 0;
    for (const c of top) if (fin(c.p) && c.p > 0) { mass += c.p; H -= c.p * Math.log(c.p) / LN2; }
    const sorted = top.filter(c => fin(c.p)).sort((a, b) => b.p - a.p);
    const rank = sorted.findIndex(c => c.id === chosen.id);
    const margin = sorted.length > 1 ? sorted[0].p - sorted[1].p : (sorted[0] ? sorted[0].p : null);
    const argmax = sorted[0] ? sorted[0].id === chosen.id : null;
    const flat = sorted.length >= 5 && (sorted[0].p - sorted[sorted.length - 1].p) < 1e-6;
    return {
      id: chosen.id, text: chosen.text, bytes: chosen.bytes, p: chosen.p, lp: chosen.lp,
      sampledId: ev.id, sampledText: ev.text, sampledP: probOf(ev),
      top: sorted.concat(top.filter(c => !fin(c.p))), H, mass, rank: rank < 0 ? null : rank + 1,
      margin, argmax, flat, nan, forced, ms: ev.ms || 0, noProbs: !!ev.noProbs,
    };
  }

  /* ---------- API ---------- */
  async function api(path, body, opts = {}) {
    const init = body === undefined ? { noTimeout: !!opts.noTimeout } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), noTimeout: !!opts.noTimeout };
    if (opts.signal) init.signal = opts.signal;
    const r = await fetch(path, init);
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error((j && j.error) || ('request failed (' + r.status + ')'));
    return j;
  }

  async function refreshStatus() {
    try {
      const st = await api('/api/ai/local/status');
      ML.models = st.models || [];
      ML.maxLoaded = st.maxLoaded || 1;
      ML.loadedIds = new Set((st.loaded || []).filter(l => l.ready).map(l => l.id));
      ML.available = !!st.available;
      for (const s of ML.sessions.values()) {
        if (s.status === 'ready' && !ML.loadedIds.has(s.id)) s.status = 'idle';
        else if (s.status === 'idle' && ML.loadedIds.has(s.id)) s.status = 'ready';
      }
    } catch (e) { ML.available = false; ML.statusError = e.message; }
  }

  async function loadMeta(s) {
    if (s.meta) return;
    try { const j = await api('/api/ai/lab/meta?id=' + encodeURIComponent(s.id)); s.meta = j.meta; }
    catch (e) { s.meta = { error: e.message }; }
    if (ML) { renderChips(); renderModelCard(); if (ML.mode === 'compare') renderCompare(); }
  }

  /* SSE generate. onToken(ev) per token; resolves with the done event (or null). */
  async function streamGenerate(s, promptIds, nPredict, onToken) {
    const sp = ML.samp;
    const res = await fetch('/api/ai/lab/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, noTimeout: true, signal: ML.ac.signal,
      body: JSON.stringify({
        id: s.id, prompt: promptIds, n_predict: nPredict, n_probs: sp.n_probs,
        temperature: sp.temperature, top_k: sp.top_k, top_p: sp.top_p, min_p: sp.min_p,
        repeat_penalty: sp.repeat_penalty, seed: sp.seed, ignore_eos: sp.ignore_eos, post_sampling_probs: sp.post,
      }),
    });
    if (!res.ok) { let m = 'request failed (' + res.status + ')'; try { m = (await res.json()).error || m; } catch (e) {} throw new Error(m); }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', done = null;
    while (true) {
      const { done: end, value } = await reader.read(); if (end) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const line of lines) {
        const d = line.replace(/^data: ?/, '').trim(); if (!d || d[0] !== '{') continue;
        let ev; try { ev = JSON.parse(d); } catch (e) { continue; }
        if (ev.type === 'token') { if (s.status !== 'ready') { s.status = 'ready'; s.stage = ''; ML.loadedIds.add(s.id); renderChips(); } onToken(ev); }
        else if (ev.type === 'stage') { s.status = 'loading'; s.stage = ev.stage; renderChips(); if (ML.mode === 'compare') renderCompareHead(s); }
        else if (ev.type === 'done') done = ev;
        else if (ev.type === 'error') throw new Error(ev.error);
      }
    }
    return done;
  }

  /* ---------- prompt → token ids (per model: tokenizers differ) ---------- */
  function promptKey() {
    const p = ML.prompt;
    return JSON.stringify(p.kind === 'raw' ? ['raw', p.raw, p.addBos] : ['chat', p.messages.filter(m => m.content.trim() || m.role === 'assistant')]);
  }

  async function ensurePrompt(s) {
    const key = promptKey();
    if (s.promptKey === key && s.promptToks.length) return;
    const p = ML.prompt;
    let text, addSpecial = p.addBos;
    if (p.kind === 'chat') {
      const msgs = p.messages.filter(m => m.content.trim());
      if (!msgs.length) throw new Error('Write a message first.');
      s.status = s.status === 'ready' ? 'ready' : 'loading'; s.stage = s.status === 'loading' ? 'starting' : ''; renderChips();
      const j = await api('/api/ai/lab/template', { id: s.id, messages: msgs }, { noTimeout: true, signal: ML.ac.signal });
      text = j.prompt; addSpecial = true;
      s.templated = text;
    } else {
      text = p.raw;
      if (!text && !addSpecial) throw new Error('Write a prompt first (or enable BOS to start from an empty context).');
    }
    if (s.status !== 'ready') { s.status = 'loading'; s.stage = 'starting'; renderChips(); }
    const j = await api('/api/ai/lab/tokenize', { id: s.id, text, add_special: addSpecial, parse_special: true }, { noTimeout: true, signal: ML.ac.signal });
    s.status = 'ready'; s.stage = ''; ML.loadedIds.add(s.id);
    let toks = (j.tokens || []).map(t => typeof t === 'number' ? { id: t, text: '' } : { id: t.id, text: Array.isArray(t.piece) ? '' : t.piece, bytes: Array.isArray(t.piece) ? t.piece : undefined });
    s.warns.delete('dupbos');
    if (toks.length > 1 && toks[0].id === toks[1].id && s.meta && s.meta.bosId != null && toks[0].id === s.meta.bosId) {
      toks = toks.slice(1);
      addWarn(s, 'dupbos', 'info', 'Template already starts with BOS; removed the duplicate.', 0);
    }
    if (s.promptKey !== key) { pushHistory(s); s.gen = []; s.pending = null; s.rendered = 0; s.timings = null; clearGenWarns(s); if (ML.sel && ML.sel.id === s.id) ML.sel = null; }
    s.promptKey = key; s.promptToks = toks;
    if (!toks.length) throw new Error('Prompt tokenized to nothing.');
  }

  // a user-facing reason the prompt can't run yet (checked before touching any model)
  function promptProblem() {
    const p = ML.prompt;
    if (p.kind === 'chat') return p.messages.some(m => m.content.trim()) ? null : 'Write a message first.';
    return (!p.raw && !p.addBos) ? 'Write a prompt first (or enable BOS to start from an empty context).' : null;
  }

  const allIds = (s) => s.promptToks.map(t => t.id).concat(s.gen.map(g => g.id));

  /* ---------- warnings ---------- */
  function addWarn(s, code, level, msg, at) {
    const w = s.warns.get(code);
    if (w) { w.count++; w.last = at; w.msg = msg; }
    else s.warns.set(code, { code, level, msg, count: 1, first: at, last: at });
  }
  function clearGenWarns(s) { for (const k of [...s.warns.keys()]) if (k !== 'dupbos') s.warns.delete(k); }

  function analyzeStep(s, st, i) {
    if (st.noProbs) addWarn(s, 'noprobs', 'warn', 'Engine returned tokens without probabilities.', i);
    if (st.nan) addWarn(s, 'nan', 'error', 'NaN / Inf in the output distribution — the logits are not finite. Likely broken weights, a bad quant, or an overflow.', i);
    if (fin(st.mass) && st.mass > 1.02) addWarn(s, 'mass', 'error', `Top-K probabilities sum to ${st.mass.toFixed(3)} (> 1): numerical error in the softmax.`, i);
    if (st.flat) addWarn(s, 'flat', 'warn', 'Flat distribution: the top candidates have identical probability. Logits may be all-zero (weights not loaded / corrupted).', i);
    if (fin(st.sampledP) && st.sampledP < 0.02 && !st.forced) addWarn(s, 'lowp', 'info', 'Sampled a token under 2% probability (high temperature or a noisy model).', i);
    if (st.text && st.text.includes('�')) addWarn(s, 'utf8', 'info', 'Partial UTF-8 byte token(s) — shown as hex.', i);
    // repetition loop: an n-gram (2..8 tokens) repeated 3+ times back-to-back at the tail
    const g = s.gen, n = g.length;
    if (n >= 6) {
      for (let L = 1; L <= 8 && L * 3 <= n; L++) {
        let rep = true;
        for (let k = 0; k < L && rep; k++) if (g[n - 1 - k].id !== g[n - 1 - k - L].id || g[n - 1 - k].id !== g[n - 1 - k - 2 * L].id) rep = false;
        if (rep && (L > 1 || n >= 8)) { addWarn(s, 'loop', 'warn', `Repetition loop: a ${L}-token pattern repeats at the end.`, i); break; }
      }
    }
    const ctx = (s.props && s.props.n_ctx) || (s.meta && s.meta.contextLength);
    const used = s.promptToks.length + n;
    if (ctx && used > ctx * 0.9) addWarn(s, 'ctx', 'warn', `Context ${used}/${ctx} tokens — near the limit.`, i);
  }

  function analyzeDone(s, done) {
    if (!done) return;
    s.timings = done.timings || s.timings;
    if (done.stop_type === 'eos') addWarn(s, 'eos', 'info', 'Model emitted end-of-sequence.', s.gen.length - 1);
    if (done.truncated) addWarn(s, 'trunc', 'warn', 'Prompt was truncated to fit the context window.', 0);
  }

  /* ---------- stats ---------- */
  function stats(s) {
    const g = s.gen.filter(x => !x.forced || fin(x.p));
    let lpSum = 0, lpN = 0, pSum = 0, pN = 0, H = 0, hN = 0, arg = 0, argN = 0, ms = 0, low = 0;
    for (const x of g) {
      if (fin(x.p) && x.p > 0) { lpSum += Math.log(x.p); lpN++; pSum += x.p; pN++; if (x.p < 0.1) low++; }
      if (fin(x.H)) { H += x.H; hN++; }
      if (x.argmax != null && !x.forced) { argN++; if (x.argmax) arg++; }
      ms += x.ms || 0;
    }
    const tps = s.timings && fin(s.timings.predicted_per_second) ? s.timings.predicted_per_second : (ms > 0 && s.gen.length ? s.gen.length / (ms / 1000) : null);
    return {
      n: s.gen.length, ppl: lpN ? Math.exp(-lpSum / lpN) : null, conf: pN ? pSum / pN : null,
      H: hN ? H / hN : null, agree: argN ? arg / argN : null, tps, low,
      errors: [...s.warns.values()].filter(w => w.level === 'error').length,
      warnN: [...s.warns.values()].filter(w => w.level !== 'info').length,
    };
  }

  /* ============================================================
     ACTIONS
     ============================================================ */
  function active() { return ML.sessions.get(ML.activeId) || null; }
  function pushHistory(s) { s.history.push(s.gen.slice()); if (s.history.length > 60) s.history.shift(); }

  async function guard(fn) {
    if (ML.busy) return;
    const why = promptProblem();
    if (why) { toast(why, 'info'); return; }
    ML.busy = true; ML.ac = new AbortController(); renderControls();
    try { await fn(); }
    catch (e) {
      const msg = (e && (e.name === 'AbortError' || e.message === 'stopped')) ? null : (e && e.message) || 'Something went wrong';
      if (msg) {
        const s = ML.curErrSession || active();
        if (s) { s.error = msg; s.status = s.status === 'loading' ? 'error' : s.status; addWarn(s, 'error', 'error', msg, s.gen.length); }
        toast(msg, 'close');
      }
    } finally {
      if (!ML) return;
      ML.busy = false; ML.ac = null; ML.curErrSession = null;
      renderAll();
      refreshStatus().then(() => { if (!ML) return; renderChips(); if (ML.mode === 'compare') compareSessions().forEach(renderCompareHead); });
    }
  }

  /* Inspect: get the distribution for the next position without committing. */
  function peek() {
    return guard(async () => {
      const s = active(); if (!s) return;
      ML.curErrSession = s; s.error = null;
      await ensurePrompt(s);
      renderStream(true);
      let got = null;
      const done = await streamGenerate(s, allIds(s), 1, (ev) => { got = ev; });
      if (!got) { analyzeDone(s, done); if (done && done.stop_type === 'eos') toast('Model ended the sequence (EOS). Enable “Ignore EOS” to continue.', 'info'); return; }
      s.pending = makeStep(got);
      s.pendingDone = done;
      if (ML.autoAccept) commit(s, s.pending.sampledId);
    });
  }

  /* Commit a candidate for the pending position (sampled or forced). */
  function commit(s, tokenId) {
    if (!s.pending) return;
    const ev = { id: s.pending.sampledId, text: s.pending.sampledText, logprob: s.pending.top.find(c => c.id === s.pending.sampledId)?.lp, top: s.pending.top.map(c => ({ id: c.id, text: c.text, bytes: c.bytes, logprob: c.lp, prob: c.p })), ms: s.pending.ms };
    const st = makeStep({ ...ev, prob: s.pending.sampledP }, tokenId);
    pushHistory(s);
    s.gen.push(st); s.pending = null;
    analyzeStep(s, st, s.gen.length - 1);
    renderAll();
  }

  /* Force arbitrary text as the next token(s) (tokenized by this model). */
  function forceText(text) {
    return guard(async () => {
      const s = active(); if (!s || !text) return;
      await ensurePrompt(s);
      const j = await api('/api/ai/lab/tokenize', { id: s.id, text, add_special: false, parse_special: true }, { signal: ML.ac.signal });
      const toks = (j.tokens || []).map(t => typeof t === 'number' ? { id: t, text: '' } : { id: t.id, text: Array.isArray(t.piece) ? '' : t.piece });
      if (!toks.length) throw new Error('That text produced no tokens.');
      pushHistory(s);
      toks.forEach((t, k) => {
        const fromPending = k === 0 && s.pending ? s.pending.top.find(c => c.id === t.id) : null;
        const st = {
          id: t.id, text: t.text, p: fromPending ? fromPending.p : null, lp: null, top: k === 0 && s.pending ? s.pending.top : [],
          H: k === 0 && s.pending ? s.pending.H : null, rank: fromPending ? s.pending.top.indexOf(fromPending) + 1 : null,
          margin: null, argmax: null, flat: false, nan: false, forced: true, ms: 0, sampledId: null,
        };
        s.gen.push(st);
      });
      s.pending = null;
      if (toks.length > 1) toast(`Inserted ${toks.length} tokens`, 'check');
    });
  }

  /* Run N tokens, committing each as it streams. */
  function runN(n, s0) {
    return guard(async () => {
      const s = s0 || active(); if (!s) return;
      ML.curErrSession = s; s.error = null;
      await ensurePrompt(s);
      s.pending = null; pushHistory(s);
      renderStream(true);
      let frame = 0;
      const done = await streamGenerate(s, allIds(s), n, (ev) => {
        const st = makeStep(ev); s.gen.push(st); analyzeStep(s, st, s.gen.length - 1);
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (ML) { renderStream(); renderAnalytics(); } });
      });
      analyzeDone(s, done);
    });
  }

  function undo() {
    const s = active(); if (!s || ML.busy) return;
    if (s.pending) { s.pending = null; renderAll(); return; }
    if (!s.history.length) return;
    s.gen = s.history.pop(); s.rendered = 0;
    rebuildWarns(s);
    if (ML.sel && ML.sel.idx >= s.gen.length) ML.sel = null;
    renderAll();
  }
  function rebuildWarns(s) {
    const keep = s.warns.get('dupbos'); s.warns.clear(); if (keep) s.warns.set('dupbos', keep);
    const g = s.gen; s.gen = [];
    for (const st of g) { s.gen.push(st); analyzeStep(s, st, s.gen.length - 1); }
  }
  function resetGen(s) {
    if (!s || ML.busy) return;
    if (s.gen.length || s.pending) pushHistory(s);
    s.gen = []; s.pending = null; s.rendered = 0; s.timings = null; s.error = null; clearGenWarns(s);
    if (ML.sel && ML.sel.id === s.id) ML.sel = null;
  }

  /* Replace token at idx with an alternative candidate from that position. */
  function branch(s, idx, altId) {
    if (ML.busy) return;
    const st = s.gen[idx]; if (!st) return;
    pushHistory(s);
    const alt = st.top.find(c => c.id === altId);
    const nst = { ...st, id: altId, text: alt ? alt.text : '', bytes: alt && alt.bytes, p: alt ? alt.p : null, lp: alt ? alt.lp : null, forced: altId !== st.sampledId, rank: alt ? st.top.indexOf(alt) + 1 : null, argmax: st.top[0] ? st.top[0].id === altId : null };
    s.gen = s.gen.slice(0, idx); s.gen.push(nst); s.pending = null; s.rendered = Math.min(s.rendered, idx);
    rebuildWarns(s);
    ML.sel = { id: s.id, idx };
    renderAll();
    toast('Branched — continue with Step or Run', 'check');
  }

  /* Chat: send a user message → append previous reply → generate until EOS. */
  function chatSend(text) {
    const s = active(); if (!s || ML.busy) return;
    const p = ML.prompt;
    if (s.gen.length && s.promptKey === promptKey()) p.messages.push({ role: 'assistant', content: genText(s) });
    if (text) p.messages.push({ role: 'user', content: text });
    p.messages = p.messages.filter((m, i, a) => m.content.trim() || i === a.length - 1);
    renderPrompt();
    return runN(ML.samp.max_reply);
  }
  function genText(s) { return s.gen.map(g => g.text || '').join(''); }

  /* ---------- compare ---------- */
  function compareSessions() { return ML.order.map(id => ML.sessions.get(id)).filter(Boolean); }

  function compareRun(nextOnly) {
    return guard(async () => {
      ML.compareNext = !!nextOnly;
      for (const s of compareSessions()) {
        if (!ML || ML.ac.signal.aborted) break;
        ML.curErrSession = s; s.error = null;
        try {
          await ensurePrompt(s);
          if (!nextOnly) { resetGen(s); s.history = []; }
          s.pending = null;
          renderCompare();
          if (nextOnly) {
            let got = null;
            const done = await streamGenerate(s, allIds(s), 1, (ev) => { got = ev; });
            s.pending = got ? makeStep(got) : null;
            if (!got) analyzeDone(s, done);
          } else {
            let frame = 0;
            const done = await streamGenerate(s, allIds(s), ML.samp.n_predict, (ev) => {
              const st = makeStep(ev); s.gen.push(st); analyzeStep(s, st, s.gen.length - 1);
              if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (ML) renderCompareCol(s); });
            });
            analyzeDone(s, done);
          }
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.message === 'stopped')) throw e;
          s.error = e.message; addWarn(s, 'error', 'error', e.message, s.gen.length);
        }
        renderCompareCol(s); renderCompareSide();
      }
    });
  }

  /* first character offset where generated texts diverge across models */
  function divergence() {
    const ss = compareSessions().filter(s => s.gen.length);
    if (ss.length < 2) return null;
    const texts = ss.map(genText);
    let i = 0; const min = Math.min(...texts.map(t => t.length));
    while (i < min && texts.every(t => t[i] === texts[0][i])) i++;
    return { at: i, same: texts[0].slice(0, i), all: i >= min && texts.every(t => t.length === min) };
  }

  /* ============================================================
     RENDER
     ============================================================ */
  function shellHTML() {
    return `
    <div class="mlab-bar">
      <div class="mlab-title"><span class="mlab-logo">${svg('pulse', 16, 1.9)}</span><b>Model Lab</b><span class="mlab-sub mono">raw inference · no system prompt</span></div>
      <div class="seg mlab-mode" id="mlMode">
        <button data-mode="inspect">${svg('eye', 13)} Inspect</button>
        <button data-mode="compare">${svg('layers', 13)} Compare</button>
      </div>
      <div class="mlab-chips" id="mlChips"></div>
      <span class="spacer"></span>
      <button class="ic-btn" id="mlExport" title="Export session as JSON">${svg('download', 15)}</button>
      <button class="ic-btn" id="mlClose" title="Close (Esc)">${svg('close', 16)}</button>
    </div>
    <div class="mlab-tabs" id="mlTabs">
      <button data-tab="prompt">Prompt</button><button data-tab="main">Tokens</button><button data-tab="stats">Analytics</button>
    </div>
    <div class="mlab-body" id="mlBody">
      <aside class="mlab-left" id="mlLeft"></aside>
      <main class="mlab-center" id="mlCenter"></main>
      <aside class="mlab-right" id="mlRight"></aside>
    </div>`;
  }

  function renderAll() {
    if (!ML) return;
    const body = $('#mlBody');
    body.className = 'mlab-body mode-' + ML.mode + ' tab-' + ML.mobileTab;
    $$('#mlMode [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === ML.mode));
    $$('#mlTabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === ML.mobileTab));
    $('#mlTabs [data-tab="main"]').textContent = ML.mode === 'compare' ? 'Compare' : (ML.prompt.kind === 'chat' ? 'Chat' : 'Tokens');
    renderChips();
    renderPrompt();
    if (ML.mode === 'inspect') { renderCenterInspect(); renderAnalytics(); }
    else { renderCompare(); renderCompareSide(); }
  }

  /* ---- header chips ---- */
  function renderChips() {
    const host = $('#mlChips'); if (!host) return;
    const chips = ML.order.map(id => {
      const s = ML.sessions.get(id); if (!s) return '';
      const on = ML.mode === 'inspect' ? id === ML.activeId : true;
      const st = s.status === 'loading' ? `<span class="spin"></span>` : `<span class="mlab-dot ${s.status}" style="--c:${s.color}"></span>`;
      const q = s.meta && s.meta.fileType ? `<span class="mlab-chip-q mono">${esc(s.meta.fileType)}</span>` : '';
      return `<span class="mlab-chip ${on ? 'on' : ''}" data-id="${esc(id)}" title="${esc(s.name)}${s.status === 'loading' ? ' — loading…' : s.status === 'ready' ? ' — in memory' : ''}">
        ${st}<span class="mlab-chip-n">${esc(s.name)}</span>${q}
        ${ML.order.length > 1 ? `<button class="mlab-chip-x" data-rm="${esc(id)}" title="Remove" aria-label="Remove ${esc(s.name)}">${svg('close', 11)}</button>` : ''}
      </span>`;
    }).join('');
    const canAdd = ML.models.some(m => !ML.sessions.has(m.id)) && ML.order.length < (ML.mode === 'compare' ? MAX_COMPARE : 12);
    host.innerHTML = chips + (canAdd ? `<button class="mlab-add" id="mlAdd" title="Add a model">${svg('plus', 13)}<span>Model</span></button>` : '');
    $$('.mlab-chip', host).forEach(c => c.onclick = (e) => {
      if (e.target.closest('[data-rm]')) return;
      if (ML.mode === 'inspect' && c.dataset.id !== ML.activeId && !ML.busy) { ML.activeId = c.dataset.id; ML.sel = null; renderAll(); }
    });
    $$('[data-rm]', host).forEach(b => b.onclick = (e) => { e.stopPropagation(); removeModel(b.dataset.rm); });
    const add = $('#mlAdd', host); if (add) add.onclick = (e) => { e.stopPropagation(); openAddMenu(add); };
  }

  function openAddMenu(anchor) {
    closePop();
    const avail = ML.models.filter(m => !ML.sessions.has(m.id));
    const pop = document.createElement('div');
    pop.className = 'mlab-pop';
    pop.innerHTML = `<div class="mlab-pop-h mono">Local models</div>` + (avail.length ? avail.map(m => `<button data-add="${esc(m.id)}">${svg(m.source === 'server' ? 'hdd' : 'cube', 14)}<span>${esc(m.name)}</span><em class="mono">${sizeStr(m.size || 0)}</em></button>`).join('') : `<div class="mlab-pop-empty dim">No other models. Upload a .gguf to your Database.</div>`);
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pr.width - 8)) + 'px';
    pop.style.top = Math.min(r.bottom + 6, innerHeight - pr.height - 8) + 'px';
    $$('[data-add]', pop).forEach(b => b.onclick = () => { closePop(); addModel(b.dataset.add, true); });
    setTimeout(() => document.addEventListener('pointerdown', popAway, true), 0);
    ML.pop = pop;
  }
  function popAway(e) { if (ML && ML.pop && !ML.pop.contains(e.target)) closePop(); }
  function closePop() { if (ML && ML.pop) { ML.pop.remove(); ML.pop = null; } document.removeEventListener('pointerdown', popAway, true); }

  function addModel(id, focus) {
    if (!ML.sessions.has(id)) {
      const s = newSession(id);
      ML.sessions.set(id, s); ML.order.push(id);
      loadMeta(s);
    }
    if (focus && ML.mode === 'inspect') { ML.activeId = id; ML.sel = null; }
    renderAll();
  }
  function removeModel(id) {
    if (ML.busy || ML.order.length <= 1) return;
    ML.sessions.delete(id); ML.order = ML.order.filter(x => x !== id);
    if (ML.activeId === id) ML.activeId = ML.order[0];
    if (ML.sel && ML.sel.id === id) ML.sel = null;
    renderAll();
  }

  /* ---- left: prompt + sampling + model card ---- */
  function renderPrompt() {
    const host = $('#mlLeft'); if (!host) return;
    const p = ML.prompt, sp = ML.samp;
    const focusId = document.activeElement && host.contains(document.activeElement) ? document.activeElement.id || document.activeElement.dataset.mi : null;
    const msgs = p.messages.map((m, i) => `
      <div class="mlab-msg">
        <select class="mlab-role" data-role="${i}" aria-label="Role">${['user', 'assistant', 'system'].map(r => `<option ${m.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
        ${p.messages.length > 1 ? `<button class="mlab-msg-x" data-delmsg="${i}" title="Remove message" aria-label="Remove message">${svg('close', 11)}</button>` : ''}
        <textarea class="mlab-ta" data-mi="${i}" rows="2" placeholder="${m.role === 'system' ? 'Optional — only if YOU want one' : m.role === 'user' ? 'User message…' : 'Assistant message…'}">${esc(m.content)}</textarea>
      </div>`).join('');
    host.innerHTML = `
      <section class="mlab-sec">
        <div class="mlab-sec-h">
          <span>Prompt</span>
          <div class="seg mlab-kind" id="mlKind"><button data-kind="raw" class="${p.kind === 'raw' ? 'on' : ''}">Raw</button><button data-kind="chat" class="${p.kind === 'chat' ? 'on' : ''}">Chat</button></div>
        </div>
        ${p.kind === 'raw' ? `
          <textarea class="mlab-ta mlab-raw" id="mlRaw" rows="7" spellcheck="false" placeholder="Sent to the model verbatim. No template, no system prompt.">${esc(p.raw)}</textarea>
          <label class="mlab-check"><input type="checkbox" id="mlBos" ${p.addBos ? 'checked' : ''}> Prepend BOS / special tokens</label>
        ` : `
          <p class="mlab-hint">Rendered with the model's <b>own</b> chat template. Nothing is added — no system prompt unless you add one.</p>
          <div class="mlab-msgs">${msgs}</div>
          <div class="mlab-row"><button class="btn ghost sm" id="mlAddMsg">${svg('plus', 13)} Message</button><button class="btn ghost sm" id="mlTpl">${svg('code', 13)} Template preview</button></div>
        `}
      </section>
      <details class="mlab-sec mlab-samp" ${ML.sampOpen ? 'open' : ''} id="mlSamp">
        <summary class="mlab-sec-h"><span>Sampling</span><span class="mlab-sum mono">T ${sp.temperature} · top-k ${sp.top_k} · K ${sp.n_probs}</span></summary>
        <div class="mlab-grid">
          ${numIn('temperature', 'Temperature', sp.temperature, 0, 5, 0.05)}
          ${numIn('top_k', 'Top-k', sp.top_k, 0, 1000, 1)}
          ${numIn('top_p', 'Top-p', sp.top_p, 0, 1, 0.01)}
          ${numIn('min_p', 'Min-p', sp.min_p, 0, 1, 0.01)}
          ${numIn('repeat_penalty', 'Repeat penalty', sp.repeat_penalty, 0.5, 3, 0.05)}
          ${numIn('seed', 'Seed (−1 random)', sp.seed, -1, 2147483647, 1)}
          ${numIn('n_probs', 'Candidates shown', sp.n_probs, 1, 50, 1)}
          ${numIn('n_predict', 'Run length', sp.n_predict, 1, 4096, 1)}
          ${numIn('max_reply', 'Chat reply max', sp.max_reply, 1, 4096, 1)}
        </div>
        <label class="mlab-check"><input type="checkbox" data-sb="ignore_eos" ${sp.ignore_eos ? 'checked' : ''}> Ignore EOS (keep generating)</label>
        <label class="mlab-check"><input type="checkbox" data-sb="post" ${sp.post ? 'checked' : ''}> Show post-sampler probabilities</label>
        <div class="mlab-row"><button class="btn ghost sm" id="mlGreedy">Greedy preset</button><button class="btn ghost sm" id="mlCreative">Creative preset</button></div>
      </details>
      <details class="mlab-sec mlab-card" ${ML.cardOpen !== false ? 'open' : ''} id="mlCard"><summary class="mlab-sec-h"><span>Model</span></summary><div id="mlCardBody"></div></details>`;
    renderModelCard();

    $$('#mlKind [data-kind]', host).forEach(b => b.onclick = () => { if (ML.busy) return; p.kind = b.dataset.kind; if (p.kind === 'chat' && !p.messages.length) p.messages = [{ role: 'user', content: '' }]; renderAll(); });
    const raw = $('#mlRaw', host); if (raw) raw.oninput = () => { p.raw = raw.value; markPromptDirty(); };
    const bos = $('#mlBos', host); if (bos) bos.onchange = () => { p.addBos = bos.checked; markPromptDirty(); };
    $$('[data-mi]', host).forEach(t => {
      autoGrow(t);
      t.oninput = () => { p.messages[+t.dataset.mi].content = t.value; autoGrow(t); markPromptDirty(); };
    });
    $$('[data-role]', host).forEach(sel => sel.onchange = () => { p.messages[+sel.dataset.role].role = sel.value; markPromptDirty(); renderPrompt(); });
    $$('[data-delmsg]', host).forEach(b => b.onclick = () => { p.messages.splice(+b.dataset.delmsg, 1); markPromptDirty(); renderPrompt(); });
    const am = $('#mlAddMsg', host); if (am) am.onclick = () => { const last = p.messages[p.messages.length - 1]; p.messages.push({ role: last && last.role === 'user' ? 'assistant' : 'user', content: '' }); renderPrompt(); const ts = $$('[data-mi]', host); if (ts.length) ts[ts.length - 1].focus(); };
    const tp = $('#mlTpl', host); if (tp) tp.onclick = showTemplate;
    $$('[data-sn]', host).forEach(inp => inp.onchange = () => {
      const k = inp.dataset.sn; let v = parseFloat(inp.value);
      if (!Number.isFinite(v)) v = freshState().samp[k];
      v = Math.min(+inp.max, Math.max(+inp.min, v));
      if (['top_k', 'seed', 'n_probs', 'n_predict', 'max_reply'].includes(k)) v = Math.round(v);
      sp[k] = v; inp.value = v; updateSampSummary();
    });
    $$('[data-sb]', host).forEach(c => c.onchange = () => { sp[c.dataset.sb] = c.checked; });
    $('#mlSamp', host).ontoggle = (e) => { ML.sampOpen = e.target.open; };
    $('#mlCard', host).ontoggle = (e) => { ML.cardOpen = e.target.open; };
    $('#mlGreedy', host).onclick = () => { Object.assign(sp, { temperature: 0, top_k: 1, top_p: 1, min_p: 0, repeat_penalty: 1 }); renderPrompt(); };
    $('#mlCreative', host).onclick = () => { Object.assign(sp, { temperature: 0.9, top_k: 60, top_p: 0.95, min_p: 0.03, repeat_penalty: 1.08 }); renderPrompt(); };
    if (focusId) { const f = host.querySelector('#' + CSS.escape(focusId)) || host.querySelector(`[data-mi="${focusId}"]`); if (f) { f.focus(); if (f.setSelectionRange && f.value != null) f.setSelectionRange(f.value.length, f.value.length); } }
  }
  function numIn(k, label, v, min, max, step) {
    return `<label class="mlab-num"><span>${label}</span><input type="number" data-sn="${k}" value="${v}" min="${min}" max="${max}" step="${step}" inputmode="decimal"></label>`;
  }
  function updateSampSummary() { const e = $('.mlab-sum'); if (e) e.textContent = `T ${ML.samp.temperature} · top-k ${ML.samp.top_k} · K ${ML.samp.n_probs}`; }
  function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(220, t.scrollHeight + 2) + 'px'; }
  function markPromptDirty() {
    // tokens are re-derived lazily on the next Step/Run; flag it so the user knows
    const dirty = [...ML.sessions.values()].some(s => s.promptKey && s.promptKey !== promptKey() && (s.gen.length || s.pending));
    const n = $('#mlDirty'); if (n) n.classList.toggle('hidden', !dirty);
  }

  async function showTemplate() {
    const s = active() || compareSessions()[0]; if (!s) return;
    const msgs = ML.prompt.messages.filter(m => m.content.trim());
    if (!msgs.length) { toast('Write a message first', 'info'); return; }
    const bg = document.createElement('div'); bg.className = 'modal-bg mlab-modal-bg';
    bg.innerHTML = `<div class="modal mlab-modal"><h3>Template preview <span class="dim mono">${esc(s.name)}</span></h3><pre class="mlab-pre" id="mlTplOut"><span class="spin"></span> Rendering…</pre><div class="acts"><span class="spacer"></span><button class="btn ghost" data-ok>Close</button></div></div>`;
    document.body.appendChild(bg);
    const close = () => bg.remove();
    bg.querySelector('[data-ok]').onclick = close; bg.onclick = (e) => { if (e.target === bg) close(); };
    try { const j = await api('/api/ai/lab/template', { id: s.id, messages: msgs }, { noTimeout: true }); bg.querySelector('#mlTplOut').textContent = j.prompt; }
    catch (e) { bg.querySelector('#mlTplOut').textContent = 'Error: ' + e.message; }
  }

  function renderModelCard() {
    const host = $('#mlCardBody'); if (!host) return;
    const s = ML.mode === 'inspect' ? active() : null;
    if (ML.mode === 'compare') { host.innerHTML = `<p class="mlab-hint">Each column shows its own model card summary.</p>`; return; }
    if (!s) { host.innerHTML = ''; return; }
    const m = s.meta;
    if (!m) { host.innerHTML = `<div class="dim mono mlab-pad"><span class="spin"></span> Reading GGUF header…</div>`; return; }
    if (m.error) { host.innerHTML = `<div class="mlab-warn-row lvl-warn">${svg('info', 13)} <span>${esc(m.error)}</span></div>`; return; }
    const row = (k, v) => v == null || v === '' ? '' : `<div class="mlab-kv"><span>${k}</span><b class="mono">${esc(String(v))}</b></div>`;
    const mix = (m.quantMix || []).slice(0, 5);
    host.innerHTML = `
      ${row('Name', m.name || s.name)}${row('Architecture', m.architecture)}${row('Parameters', fmtParams(m.params))}
      ${row('Quant', m.fileType)}${row('File', sizeStr(m.fileSize || s.size || 0))}${row('Trained ctx', m.contextLength && m.contextLength.toLocaleString())}
      ${row('Engine ctx', s.props && s.props.n_ctx && s.props.n_ctx.toLocaleString())}${row('Vocab', m.vocabSize && m.vocabSize.toLocaleString())}
      ${row('Layers', m.blockCount)}${row('Heads (KV)', m.headCount != null ? `${m.headCount}${m.headCountKv != null ? ' (' + m.headCountKv + ')' : ''}` : null)}
      ${row('Embedding', m.embeddingLength)}${row('Experts', m.expertCount)}${row('Tokenizer', m.tokenizer)}
      ${mix.length ? `<div class="mlab-mix" title="Share of parameters by tensor type">${mix.map((q, i) => `<span style="flex:${Math.max(q.share, 0.02)};--i:${i}" title="${esc(q.type)} ${(q.share * 100).toFixed(1)}%"></span>`).join('')}</div>
        <div class="mlab-mix-l mono">${mix.map((q, i) => `<span style="--i:${i}"><i></i>${esc(q.type)} ${(q.share * 100).toFixed(q.share < 0.1 ? 1 : 0)}%</span>`).join('')}</div>` : ''}
      ${m.partial ? `<p class="mlab-hint">Header larger than the scan window — some fields may be missing.</p>` : ''}
      ${!m.hasChatTemplate ? `<p class="mlab-hint">${svg('info', 12)} No embedded chat template — Chat mode uses a generic fallback.</p>` : ''}
      ${s.props && s.props.templateFallback ? `<p class="mlab-hint">${svg('info', 12)} Engine fell back to ChatML because the embedded template failed to parse.</p>` : ''}`;
  }

  /* ---- center (inspect) ---- */
  function renderCenterInspect() {
    const host = $('#mlCenter'); if (!host) return;
    const s = active();
    const chat = ML.prompt.kind === 'chat';
    host.innerHTML = `
      <div class="mlab-stream ${chat ? 'is-chat' : ''}" id="mlStream" tabindex="-1"></div>
      <div class="mlab-tray" id="mlTray"></div>
      <div class="mlab-controls" id="mlControls"></div>
      ${chat ? `<div class="mlab-composer"><textarea id="mlChatIn" rows="1" class="mlab-ta" placeholder="Message ${esc(s ? s.name : 'the model')}…  (Enter to send)"></textarea><button class="btn primary" id="mlChatSend" title="Send">${svg('send', 15)}</button></div>` : ''}`;
    if (chat) {
      const ta = $('#mlChatIn'), send = () => { const v = ta.value.trim(); if (!v && !ML.prompt.messages.some(m => m.content.trim())) return; ta.value = ''; autoGrow(ta); chatSend(v); };
      ta.oninput = () => autoGrow(ta);
      ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
      $('#mlChatSend').onclick = send;
    }
    if (s) s.rendered = 0;
    renderStream(true);
    renderTray();
    renderControls();
  }

  function chipHTML(st, i, sid) {
    const p = fin(st.p) ? st.p : null;
    const cls = ['mlab-tok', st.forced ? 'forced' : '', st.nan ? 'nan' : '', p == null && !st.nan ? 'unk' : '', ML.sel && ML.sel.id === sid && ML.sel.idx === i ? 'sel' : ''].join(' ');
    return `<span class="${cls}" data-i="${i}" style="--p:${p == null ? 0.5 : p.toFixed(3)}" title="#${i + 1} · ${esc(pieceText(st))} · ${pct(st.p)}${st.forced ? ' · forced' : ''}">${esc(pieceText(st))}</span>`;
  }

  function renderStream(full) {
    const host = $('#mlStream'); if (!host || ML.mode !== 'inspect') return;
    const s = active();
    if (!s) { host.innerHTML = emptyHTML(); return; }
    const chat = ML.prompt.kind === 'chat';
    if (full || !host.querySelector('.mlab-gen')) {
      const pt = s.promptToks;
      const promptBlock = pt.length ? `
        <div class="mlab-ptoks ${ML.showPromptToks ? 'open' : ''}">
          <button class="mlab-ptoks-h mono" id="mlPT">${svg('chevron-right', 12)} Prompt · ${pt.length} token${pt.length === 1 ? '' : 's'}${(s.props && s.props.n_ctx) ? ` / ${s.props.n_ctx.toLocaleString()} ctx` : ''}</button>
          ${ML.showPromptToks ? `<div class="mlab-ptoks-b">${pt.slice(0, 3000).map(t => `<span class="mlab-ptok" title="id ${t.id}">${esc(pieceText(t))}</span>`).join('')}${pt.length > 3000 ? `<span class="dim mono"> …${pt.length - 3000} more</span>` : ''}</div>` : ''}
        </div>` : '';
      let convo = '';
      if (chat) {
        const msgs = ML.prompt.messages.filter(m => m.content.trim());
        convo = msgs.map(m => `<div class="mlab-bub ${m.role}"><span class="mlab-bub-r mono">${m.role}</span><div>${esc(m.content)}</div></div>`).join('');
      }
      const empty = !s.gen.length && !s.pending && !ML.busy;
      host.innerHTML = promptBlock + convo + `
        <div class="${chat ? 'mlab-bub assistant live' : 'mlab-genwrap'}">
          ${chat ? `<span class="mlab-bub-r mono">assistant · ${esc(s.name)}</span>` : ''}
          <div class="mlab-gen" id="mlGen"></div>
          ${empty ? `<div class="mlab-empty-hint dim">${chat ? 'Send a message, or press <b>Step</b> to pick the reply token by token.' : 'Write a prompt, then <b>Step</b> to see the next-token distribution or <b>Run</b> to generate.'}<span class="mlab-keys mono">Space step · Enter accept · 1–9 pick · ⌫ undo</span></div>` : ''}
        </div>
        <div class="mlab-dirty hidden" id="mlDirty">${svg('info', 12)} Prompt edited — the next Step/Run restarts from the new prompt.</div>`;
      s.rendered = 0;
      const pth = $('#mlPT'); if (pth) pth.onclick = () => { ML.showPromptToks = !ML.showPromptToks; renderStream(true); };
      markPromptDirty();
    }
    const gen = $('#mlGen');
    if (s.rendered > s.gen.length) { gen.innerHTML = ''; s.rendered = 0; }
    if (s.rendered < s.gen.length) {
      const html = s.gen.slice(s.rendered).map((st, k) => chipHTML(st, s.rendered + k, s.id)).join('');
      gen.insertAdjacentHTML('beforeend', html);
      s.rendered = s.gen.length;
      const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 120;
      if (nearBottom || ML.busy) host.scrollTop = host.scrollHeight;
    }
    let caret = gen.querySelector('.mlab-caret');
    if (ML.busy || s.pending) { if (!caret) gen.insertAdjacentHTML('beforeend', `<span class="mlab-caret ${s.pending ? 'pending' : ''}"></span>`); else { gen.appendChild(caret); caret.classList.toggle('pending', !!s.pending); } }
    else if (caret) caret.remove();
    gen.onclick = (e) => { const c = e.target.closest('.mlab-tok'); if (!c) return; selectTok(s.id, +c.dataset.i); };
  }

  function emptyHTML() {
    return `<div class="mlab-empty"><div class="mlab-empty-ico">${svg('cpu', 30, 1.5)}</div><h3>No model selected</h3><p class="dim">Add a local model from the bar above.</p></div>`;
  }

  function selectTok(sid, idx) {
    ML.sel = (ML.sel && ML.sel.id === sid && ML.sel.idx === idx) ? null : { id: sid, idx };
    $$('.mlab-tok.sel').forEach(c => c.classList.remove('sel'));
    if (ML.sel) {
      const root = ML.mode === 'compare' ? $(`.mlab-col[data-id="${CSS.escape(sid)}"]`) : $('#mlGen');
      const c = root && root.querySelector(`.mlab-tok[data-i="${idx}"]`); if (c) c.classList.add('sel');
      if (matchMedia('(max-width: 900px)').matches && ML.mode === 'inspect') { /* stay on tokens; detail shows in tray */ }
    }
    if (ML.mode === 'inspect') { renderTray(); renderAnalytics(); } else renderCompareSide();
  }

  function distBars(top, chosenId, opts = {}) {
    if (!top || !top.length) return `<div class="dim mono mlab-pad">No distribution for this token.</div>`;
    const max = Math.max(...top.map(c => fin(c.p) ? c.p : 0), 1e-9);
    return `<div class="mlab-dist">${top.map((c, k) => {
      const bad = !fin(c.p);
      const w = bad ? 100 : Math.max(0.6, (c.p / (opts.abs ? 1 : max)) * 100);
      return `<button class="mlab-cand ${c.id === chosenId ? 'chosen' : ''} ${c.id === opts.sampledId ? 'sampled' : ''} ${bad ? 'bad' : ''}" data-cid="${c.id}" ${opts.disabled ? 'disabled' : ''} title="id ${c.id}${fin(c.lp) ? ' · logprob ' + c.lp.toFixed(3) : ''}">
        <span class="mlab-cand-k mono">${k < 9 && opts.keys ? k + 1 : ''}</span>
        <span class="mlab-cand-t mono">${esc(pieceText(c))}</span>
        <span class="mlab-cand-bar"><i style="width:${w.toFixed(1)}%"></i></span>
        <span class="mlab-cand-p mono">${bad ? 'NaN' : pct(c.p)}</span>
      </button>`;
    }).join('')}</div>`;
  }

  /* The tray: next-token picker when a step is pending; otherwise the selected token's alternatives. */
  function renderTray() {
    const host = $('#mlTray'); if (!host) return;
    const s = active();
    if (!s) { host.innerHTML = ''; host.classList.add('hidden'); return; }
    if (s.pending) {
      const st = s.pending;
      host.classList.remove('hidden');
      host.innerHTML = `
        <div class="mlab-tray-h"><b>Next token</b><span class="mono dim">#${s.gen.length + 1} · H ${fmtN(st.H)} bits · sampled <span class="mlab-pill">${esc(pieceText({ text: st.sampledText }))}</span> ${pct(st.sampledP)}</span>
          <span class="spacer"></span><button class="btn ghost sm" id="mlForce">${svg('rename', 12)} Type…</button></div>
        ${distBars(st.top, st.sampledId, { keys: true, sampledId: st.sampledId })}
        <div class="mlab-tray-f dim">Click a candidate to force it · <b>Enter</b> accepts the sampled token</div>`;
      $$('[data-cid]', host).forEach(b => b.onclick = () => commit(s, +b.dataset.cid));
      $('#mlForce', host).onclick = () => promptForce();
      return;
    }
    if (ML.sel && ML.sel.id === s.id && s.gen[ML.sel.idx]) {
      const i = ML.sel.idx, st = s.gen[i];
      host.classList.remove('hidden');
      host.innerHTML = `
        <div class="mlab-tray-h"><b>Token #${i + 1}</b> <span class="mlab-pill mono">${esc(pieceText(st))}</span><span class="mono dim">${pct(st.p)}${st.forced ? ' · forced' : ''}${st.rank ? ' · rank ' + st.rank : ''}</span>
          <span class="spacer"></span><button class="ic-btn sm" id="mlSelX" title="Close">${svg('close', 13)}</button></div>
        ${distBars(st.top, st.id, { sampledId: st.sampledId, disabled: ML.busy })}
        <div class="mlab-tray-f dim">Click an alternative to <b>branch</b> from here (later tokens are dropped; Undo restores).</div>`;
      $$('[data-cid]', host).forEach(b => b.onclick = () => { if (+b.dataset.cid !== st.id) branch(s, i, +b.dataset.cid); });
      $('#mlSelX', host).onclick = () => selectTok(s.id, i);
      return;
    }
    host.classList.add('hidden'); host.innerHTML = '';
  }

  function promptForce() {
    const bg = document.createElement('div'); bg.className = 'modal-bg mlab-modal-bg';
    bg.innerHTML = `<div class="modal mlab-modal"><h3>Force next token(s)</h3>
      <p>Tokenized by this model and appended as forced tokens. Whitespace counts — <code>" the"</code> and <code>"the"</code> are different tokens. Use <code>\\n</code> for a newline.</p>
      <input class="mlab-force-in" id="mlForceIn" spellcheck="false" autocomplete="off" placeholder=" the">
      <div class="acts"><span class="spacer"></span><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>Insert</button></div></div>`;
    document.body.appendChild(bg);
    const inp = bg.querySelector('#mlForceIn'); inp.focus();
    const close = () => bg.remove();
    const ok = () => { const v = inp.value.replace(/\\n/g, '\n').replace(/\\t/g, '\t'); close(); if (v) forceText(v); };
    bg.querySelector('[data-x]').onclick = close; bg.querySelector('[data-ok]').onclick = ok;
    bg.onclick = (e) => { if (e.target === bg) close(); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } else if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  }

  function renderControls() {
    const host = $('#mlControls'); if (!host || ML.mode !== 'inspect') return;
    const s = active(); const busy = ML.busy;
    const has = s && (s.gen.length || s.pending);
    host.innerHTML = `
      <button class="btn ghost sm" id="mlReset" ${!has || busy ? 'disabled' : ''} title="Clear generated tokens">${svg('refresh', 14)}<span>Reset</span></button>
      <button class="btn ghost sm" id="mlUndo" ${busy || !s || (!s.pending && !s.history.length) ? 'disabled' : ''} title="Undo (Backspace)">${svg('undo', 14)}<span>Undo</span></button>
      <span class="mlab-ctl-sep"></span>
      <button class="btn ${s && s.pending ? 'ghost' : 'primary'} sm" id="mlStep" ${busy || !s ? 'disabled' : ''} title="Show next-token distribution (Space)">${svg('next', 14)}<span>Step</span></button>
      ${s && s.pending ? `<button class="btn primary sm" id="mlAccept" title="Accept sampled token (Enter)">${svg('check', 14)}<span>Accept</span></button>` : ''}
      <button class="btn ghost sm" id="mlRun" ${busy || !s ? 'disabled' : ''} title="Generate ${ML.samp.n_predict} tokens">${svg('play', 14)}<span>Run ${ML.samp.n_predict}</span></button>
      ${busy ? `<button class="btn ghost sm danger" id="mlStop">${svg('stop', 14)}<span>Stop</span></button>` : ''}
      <span class="spacer"></span>
      <label class="mlab-check sm" title="Commit the sampled token automatically after each Step"><input type="checkbox" id="mlAuto" ${ML.autoAccept ? 'checked' : ''}> Auto-accept</label>
      ${s && s.status === 'loading' ? `<span class="mlab-stage mono"><span class="spin"></span> ${esc(stageLabel(s.stage))}</span>` : ''}`;
    const on = (id, fn) => { const b = $('#' + id, host); if (b) b.onclick = fn; };
    on('mlReset', () => { resetGen(active()); renderAll(); });
    on('mlUndo', undo);
    on('mlStep', peek);
    on('mlAccept', () => { const s2 = active(); if (s2 && s2.pending) commit(s2, s2.pending.sampledId); });
    on('mlRun', () => runN(ML.samp.n_predict));
    on('mlStop', stop);
    const auto = $('#mlAuto', host); if (auto) auto.onchange = () => { ML.autoAccept = auto.checked; };
  }
  function stageLabel(st) { return st === 'resolving' ? 'Preparing model…' : st === 'starting' ? 'Loading model…' : st === 'ready' ? 'Ready' : 'Working…'; }
  function stop() { if (ML && ML.ac) ML.ac.abort(); }

  /* ---- right: analytics (inspect) ---- */
  function renderAnalytics() {
    const host = $('#mlRight'); if (!host || ML.mode !== 'inspect') return;
    const s = active();
    if (!s) { host.innerHTML = ''; return; }
    const st = stats(s);
    const tile = (k, v, sub, cls = '') => `<div class="mlab-tile ${cls}"><span>${k}</span><b class="mono">${v}</b>${sub ? `<em class="mono">${sub}</em>` : ''}</div>`;
    const ctx = (s.props && s.props.n_ctx) || null;
    host.innerHTML = `
      <div class="mlab-tiles">
        ${tile('Tokens', st.n, ctx ? `${s.promptToks.length + st.n}/${ctx} ctx` : `${s.promptToks.length} prompt`)}
        ${tile('Perplexity', fmtN(st.ppl), 'exp(−mean log p)', st.ppl > 50 ? 'bad' : '')}
        ${tile('Confidence', pct(st.conf), `${st.low} under 10%`)}
        ${tile('Entropy', fmtN(st.H), 'bits / token (top-K)')}
        ${tile('Argmax', pct(st.agree), 'sampled = top-1')}
        ${tile('Speed', st.tps ? fmtN(st.tps, 1) : '—', 'tokens / s')}
      </div>
      <div class="mlab-chart-h"><b>Per-token</b><span class="mlab-leg"><i class="c-p"></i>probability<i class="c-h"></i>entropy</span></div>
      <div class="mlab-chart" id="mlChart">${chartSVG([s], { entropy: true })}</div>
      ${selDetailHTML(s)}
      <div class="mlab-chart-h"><b>Warnings</b><span class="mono dim">${st.errors ? `<span class="mlab-bad">${st.errors} error${st.errors > 1 ? 's' : ''}</span>` : ''}${!s.warns.size ? 'none' : ''}</span></div>
      <div class="mlab-warns">${warnsHTML(s)}</div>
      ${s.error || s.warns.has('error') ? `<button class="btn ghost sm" id="mlLog">${svg('terminal', 13)} Engine log</button>` : ''}`;
    wireChart(host, s);
    $$('[data-wat]', host).forEach(b => b.onclick = () => { const i = +b.dataset.wat; if (s.gen[i]) { selectTok(s.id, i); const c = $(`#mlGen .mlab-tok[data-i="${i}"]`); if (c) c.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (matchMedia('(max-width: 900px)').matches) { ML.mobileTab = 'main'; renderAll(); } } });
    const lg = $('#mlLog', host); if (lg) lg.onclick = () => showLog(s);
  }

  function selDetailHTML(s) {
    if (!ML.sel || ML.sel.id !== s.id || !s.gen[ML.sel.idx]) return '';
    const st = s.gen[ML.sel.idx];
    const kv = (k, v) => `<div class="mlab-kv"><span>${k}</span><b class="mono">${v}</b></div>`;
    return `<div class="mlab-seldet">
      <div class="mlab-chart-h"><b>Token #${ML.sel.idx + 1}</b><span class="mlab-pill mono">${esc(pieceText(st))}</span></div>
      ${kv('Token id', st.id)}${kv('Probability', pct(st.p))}${kv('Log-prob', fin(st.lp) ? st.lp.toFixed(4) : (fin(st.p) && st.p > 0 ? Math.log(st.p).toFixed(4) : '—'))}
      ${kv('Surprisal', fin(st.p) && st.p > 0 ? (-Math.log2(st.p)).toFixed(2) + ' bits' : '—')}${kv('Rank', st.rank || '—')}${kv('Margin (p1−p2)', fin(st.margin) ? pct(st.margin) : '—')}
      ${kv('Top-K mass', fin(st.mass) ? pct(st.mass) : '—')}${kv('Latency', st.ms ? st.ms + ' ms' : '—')}${st.forced ? kv('Sampled was', esc(pieceText({ text: st.sampledText })) + ' ' + pct(st.sampledP)) : ''}
    </div>`;
  }

  function warnsHTML(s) {
    if (!s.warns.size) return `<div class="mlab-ok mono">${svg('check', 13)} No issues detected</div>`;
    const order = { error: 0, warn: 1, info: 2 };
    return [...s.warns.values()].sort((a, b) => order[a.level] - order[b.level]).map(w => `
      <button class="mlab-warn-row lvl-${w.level}" data-wat="${w.first}" title="Jump to token #${w.first + 1}">
        ${svg(w.level === 'info' ? 'info' : 'bug', 13)}<span>${esc(w.msg)}</span>${w.count > 1 ? `<em class="mono">×${w.count}</em>` : ''}
      </button>`).join('');
  }

  async function showLog(s) {
    const bg = document.createElement('div'); bg.className = 'modal-bg mlab-modal-bg';
    bg.innerHTML = `<div class="modal mlab-modal"><h3>Engine log <span class="dim mono">${esc(s.name)}</span></h3><pre class="mlab-pre" id="mlLogOut"><span class="spin"></span></pre><div class="acts"><span class="spacer"></span><button class="btn ghost" data-ok>Close</button></div></div>`;
    document.body.appendChild(bg);
    const close = () => bg.remove();
    bg.querySelector('[data-ok]').onclick = close; bg.onclick = (e) => { if (e.target === bg) close(); };
    try { const j = await api('/api/ai/lab/log?id=' + encodeURIComponent(s.id)); bg.querySelector('#mlLogOut').textContent = (j.lines || []).join('\n') || '(model not running — no log)'; }
    catch (e) { bg.querySelector('#mlLogOut').textContent = 'Error: ' + e.message; }
  }

  /* ---- SVG chart: probability per token (one line per session) + optional entropy ---- */
  function chartSVG(sessions, opts = {}) {
    const W = 320, H = 120, PAD = 4;
    const n = Math.max(2, ...sessions.map(s => s.gen.length));
    if (!sessions.some(s => s.gen.length)) return `<div class="mlab-chart-empty dim mono">Generate tokens to see the curve</div>`;
    const x = (i) => PAD + (i / (n - 1)) * (W - PAD * 2);
    const y = (v) => H - PAD - v * (H - PAD * 2);
    const maxPts = 360;
    let out = '';
    // grid
    out += [0.25, 0.5, 0.75].map(g => `<line x1="0" x2="${W}" y1="${y(g)}" y2="${y(g)}" class="g"/>`).join('');
    for (const s of sessions) {
      const g = s.gen; if (!g.length) continue;
      const stepI = Math.max(1, Math.ceil(g.length / maxPts));
      const pts = []; const hp = [];
      for (let i = 0; i < g.length; i += stepI) {
        const p = fin(g[i].p) ? g[i].p : 0;
        pts.push(`${x(i).toFixed(1)},${y(p).toFixed(1)}`);
        if (opts.entropy) { const h = fin(g[i].H) ? Math.min(1, g[i].H / Math.log2(Math.max(2, ML.samp.n_probs))) : 0; hp.push(`${x(i).toFixed(1)},${y(h).toFixed(1)}`); }
      }
      const col = sessions.length > 1 ? s.color : 'var(--acc)';
      if (sessions.length === 1) out += `<polygon class="area" points="${x(0).toFixed(1)},${y(0)} ${pts.join(' ')} ${x((Math.floor((g.length - 1) / stepI)) * stepI).toFixed(1)},${y(0)}"/>`;
      if (opts.entropy && hp.length) out += `<polyline class="h" points="${hp.join(' ')}"/>`;
      out += `<polyline class="p" style="stroke:${col}" points="${pts.join(' ')}"/>`;
      // NaN / forced markers
      g.forEach((st, i) => { if (st.nan) out += `<line class="nanm" x1="${x(i)}" x2="${x(i)}" y1="0" y2="${H}"/>`; });
    }
    if (ML.sel) {
      const s = sessions.find(z => z.id === ML.sel.id);
      if (s && s.gen[ML.sel.idx]) out += `<line class="selm" x1="${x(ML.sel.idx)}" x2="${x(ML.sel.idx)}" y1="0" y2="${H}"/>`;
    }
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-n="${n}">${out}</svg><div class="mlab-chart-ax mono"><span>1</span><span>${n}</span></div>`;
  }
  function wireChart(host, s) {
    const svgEl = host.querySelector('#mlChart svg'); if (!svgEl) return;
    svgEl.onclick = (e) => {
      const r = svgEl.getBoundingClientRect(); const n = +svgEl.dataset.n;
      const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
      if (s.gen[i]) { selectTok(s.id, i); const c = $(`#mlGen .mlab-tok[data-i="${i}"]`); if (c) c.scrollIntoView({ block: 'nearest' }); }
    };
  }

  /* ---- compare mode ---- */
  function renderCompare() {
    const host = $('#mlCenter'); if (!host || ML.mode !== 'compare') return;
    const ss = compareSessions();
    const seq = ss.length > ML.maxLoaded;
    host.innerHTML = `
      ${seq ? `<div class="mlab-banner">${svg('info', 13)} This server keeps ${ML.maxLoaded} model${ML.maxLoaded > 1 ? 's' : ''} in memory at once, so models run one after another and may reload between runs.</div>` : ''}
      <div class="mlab-cols" id="mlCols" style="--cols:${Math.max(1, ss.length)}">${ss.map(s => `<section class="mlab-col" data-id="${esc(s.id)}" style="--c:${s.color}"></section>`).join('')}
        ${ss.length < MAX_COMPARE ? `<button class="mlab-col-add" id="mlColAdd">${svg('plus', 18)}<span>Add model</span></button>` : ''}</div>
      <div class="mlab-controls" id="mlCControls">
        <button class="btn ghost sm" id="mlCReset" ${ML.busy ? 'disabled' : ''}>${svg('refresh', 14)}<span>Reset</span></button>
        <span class="mlab-ctl-sep"></span>
        <button class="btn ghost sm" id="mlCNext" ${ML.busy || !ss.length ? 'disabled' : ''} title="Each model's distribution for the next token">${svg('next', 14)}<span>Next token</span></button>
        <button class="btn primary sm" id="mlCRun" ${ML.busy || !ss.length ? 'disabled' : ''}>${svg('play', 14)}<span>Generate ${ML.samp.n_predict} each</span></button>
        ${ML.busy ? `<button class="btn ghost sm danger" id="mlCStop">${svg('stop', 14)}<span>Stop</span></button>` : ''}
        <span class="spacer"></span><span class="mono dim mlab-cnote">same prompt · same sampling${ML.samp.seed >= 0 ? ' · seed ' + ML.samp.seed : ''}</span>
      </div>`;
    ss.forEach(renderCompareCol);
    const on = (id, fn) => { const b = $('#' + id, host); if (b) b.onclick = fn; };
    on('mlCReset', () => { ss.forEach(s => resetGen(s)); renderAll(); });
    on('mlCNext', () => compareRun(true));
    on('mlCRun', () => compareRun(false));
    on('mlCStop', stop);
    const ca = $('#mlColAdd', host); if (ca) ca.onclick = (e) => { e.stopPropagation(); if (ML.models.some(m => !ML.sessions.has(m.id))) openAddMenu(ca); else toast('No other local models — upload another .gguf', 'info'); };
  }

  function renderCompareHead(s) {
    const col = $(`.mlab-col[data-id="${CSS.escape(s.id)}"] .mlab-col-status`); if (!col) return;
    col.innerHTML = colStatus(s);
  }
  function colStatus(s) {
    return s.status === 'loading' ? `<span class="spin"></span> ${esc(stageLabel(s.stage))}` : s.error ? `<span class="mlab-bad">error</span>` : s.status === 'ready' ? 'in memory' : 'idle';
  }

  function renderCompareCol(s) {
    const col = $(`.mlab-col[data-id="${CSS.escape(s.id)}"]`); if (!col) return;
    const st = stats(s), m = s.meta || {};
    const warns = [...s.warns.values()].filter(w => w.level !== 'info');
    col.innerHTML = `
      <header class="mlab-col-h">
        <span class="mlab-dot" style="--c:${s.color}"></span>
        <div class="mlab-col-t"><b title="${esc(s.name)}">${esc(s.name)}</b><span class="mono dim">${[m.architecture, fmtParams(m.params), m.fileType].filter(x => x && x !== '—').map(esc).join(' · ') || sizeStr(s.size)}</span></div>
        <span class="mlab-col-status mono">${colStatus(s)}</span>
      </header>
      <div class="mlab-col-stats mono">
        <span title="Perplexity">PPL <b>${fmtN(st.ppl)}</b></span><span title="Mean probability of chosen tokens">p̄ <b>${pct(st.conf)}</b></span>
        <span title="Mean entropy (bits)">H <b>${fmtN(st.H)}</b></span><span title="Tokens per second">${st.tps ? fmtN(st.tps, 1) : '—'} t/s</span>
      </div>
      ${warns.length ? `<div class="mlab-col-warns">${warns.map(w => `<span class="mlab-wchip lvl-${w.level}" title="${esc(w.msg)}">${svg('bug', 11)} ${esc(w.code === 'nan' ? 'NaN/Inf' : w.code === 'flat' ? 'flat logits' : w.code === 'loop' ? 'loop' : w.code === 'ctx' ? 'context' : w.code === 'mass' ? 'prob sum' : w.code)}${w.count > 1 ? ' ×' + w.count : ''}</span>`).join('')}</div>` : ''}
      <div class="mlab-col-out">
        ${s.pending ? `<div class="mlab-col-next"><div class="mlab-tray-h"><b>Next token</b><span class="mono dim">H ${fmtN(s.pending.H)} bits</span></div>${distBars(s.pending.top.slice(0, 8), s.pending.sampledId, { abs: true, disabled: true })}</div>` : ''}
        <div class="mlab-gen">${s.gen.map((x, i) => chipHTML(x, i, s.id)).join('')}${!s.gen.length && !s.pending ? `<span class="dim mlab-col-empty">${s.error ? esc(s.error) : 'Waiting to run'}</span>` : ''}</div>
      </div>`;
    const out = col.querySelector('.mlab-col-out'); if (ML.busy) out.scrollTop = out.scrollHeight;
    col.querySelector('.mlab-gen').onclick = (e) => { const c = e.target.closest('.mlab-tok'); if (c) selectTok(s.id, +c.dataset.i); };
  }

  function renderCompareSide() {
    const host = $('#mlRight'); if (!host || ML.mode !== 'compare') return;
    const ss = compareSessions();
    const dv = divergence();
    const rows = ss.map(s => ({ s, st: stats(s) }));
    const best = (k, lowGood) => { const v = rows.map(r => r.st[k]).filter(fin); if (v.length < 2) return null; return lowGood ? Math.min(...v) : Math.max(...v); };
    const bPPL = best('ppl', true), bConf = best('conf'), bTps = best('tps');
    let next = '';
    if (ss.some(s => s.pending)) {
      const tops = ss.filter(s => s.pending).map(s => ({ s, t: s.pending.top[0] }));
      const agree = tops.length > 1 && tops.every(x => x.t && x.t.text === tops[0].t.text);
      next = `<div class="mlab-chart-h"><b>Next token</b><span class="mono ${agree ? 'mlab-good' : 'dim'}">${tops.length > 1 ? (agree ? 'all agree' : 'models disagree') : ''}</span></div>
        <div class="mlab-nexttab">${tops.map(x => `<div><i style="background:${x.s.color}"></i><span>${esc(x.s.name)}</span><b class="mono">${x.t ? esc(pieceText(x.t)) : '—'}</b><em class="mono">${x.t ? pct(x.t.p) : ''}</em></div>`).join('')}</div>`;
    }
    let sel = '';
    if (ML.sel) {
      const s = ML.sessions.get(ML.sel.id); const st = s && s.gen[ML.sel.idx];
      if (st) sel = `<div class="mlab-chart-h"><b>${esc(s.name)} · #${ML.sel.idx + 1}</b><span class="mlab-pill mono">${esc(pieceText(st))}</span></div>${distBars(st.top, st.id, { sampledId: st.sampledId, disabled: true })}`;
    }
    host.innerHTML = `
      <div class="mlab-chart-h"><b>Confidence per token</b></div>
      <div class="mlab-chart" id="mlChart">${chartSVG(ss)}</div>
      <div class="mlab-leg2">${ss.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>
      <div class="mlab-chart-h"><b>Scoreboard</b></div>
      <table class="mlab-tbl mono"><thead><tr><th></th><th>PPL</th><th>p̄</th><th>H</th><th>t/s</th><th>!</th></tr></thead><tbody>
        ${rows.map(({ s, st }) => `<tr><td><i style="background:${s.color}"></i><span title="${esc(s.name)}">${esc(s.name)}</span></td>
          <td class="${st.ppl === bPPL ? 'best' : ''}">${fmtN(st.ppl)}</td><td class="${st.conf === bConf ? 'best' : ''}">${pct(st.conf)}</td><td>${fmtN(st.H)}</td>
          <td class="${st.tps === bTps ? 'best' : ''}">${st.tps ? fmtN(st.tps, 1) : '—'}</td><td class="${st.errors ? 'mlab-bad' : ''}">${st.errors ? st.errors + 'E' : ''}${st.warnN - st.errors > 0 ? (st.warnN - st.errors) + 'W' : (st.errors ? '' : '·')}</td></tr>`).join('')}
      </tbody></table>
      ${dv ? `<div class="mlab-chart-h"><b>Divergence</b></div><p class="mlab-div">${dv.all ? 'All outputs are identical.' : dv.at === 0 || !dv.same.trim() ? 'Outputs differ from the first word.' : `Outputs agree for ${dv.at} character${dv.at === 1 ? '' : 's'}, then split after <code>${esc(dv.same.slice(-48).replace(/\n/g, '↵'))}</code>`}</p>` : ''}
      ${next}
      ${sel}
      <div class="mlab-chart-h"><b>Warnings</b></div>
      <div class="mlab-warns">${ss.map(s => s.warns.size ? `<div class="mlab-wgroup"><span class="mono"><i style="background:${s.color}"></i>${esc(s.name)}</span>${warnsHTML(s)}</div>` : '').join('') || `<div class="mlab-ok mono">${svg('check', 13)} No issues detected</div>`}</div>`;
    const svgEl = host.querySelector('#mlChart svg');
    if (svgEl) svgEl.onclick = (e) => {
      const r = svgEl.getBoundingClientRect(); const n = +svgEl.dataset.n;
      const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
      const s = ss.find(z => z.gen[i]); if (s) selectTok(s.id, i);
    };
    $$('[data-wat]', host).forEach(b => b.onclick = () => {
      const grp = b.closest('.mlab-wgroup'); const idx = +b.dataset.wat;
      const s = ss.find(z => grp && grp.textContent.includes(z.name) && z.gen[idx]); if (s) selectTok(s.id, idx);
    });
  }

  /* ---------- export ---------- */
  function exportJSON() {
    const data = {
      exported: new Date().toISOString(), mode: ML.mode, prompt: ML.prompt, sampling: ML.samp,
      models: [...ML.sessions.values()].map(s => ({
        id: s.id, name: s.name, meta: s.meta, props: s.props, stats: stats(s),
        promptTokens: s.promptToks.map(t => t.id),
        tokens: s.gen.map(g => ({ id: g.id, text: g.text, p: g.p, logprob: g.lp, entropy: g.H, rank: g.rank, forced: g.forced, nan: g.nan, sampled: g.sampledId, top: g.top.map(c => ({ id: c.id, text: c.text, p: c.p })) })),
        warnings: [...s.warns.values()],
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'model-lab-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ---------- keyboard ---------- */
  function onKey(e) {
    if (!ML) return;
    const openModal = document.querySelector('.modal-bg');
    if (openModal) { if (e.key === 'Escape' && openModal.classList.contains('mlab-modal-bg')) { e.preventDefault(); openModal.remove(); } return; }
    if (e.key === 'Escape') { if (ML.pop) closePop(); else if (ML.busy) stop(); else closeLab(); return; }
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.target.isContentEditable) return;
    if (ML.mode !== 'inspect') return;
    const s = active(); if (!s) return;
    if (e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); if (!ML.busy) peek(); }
    else if (e.key === 'Enter' && s.pending) { e.preventDefault(); commit(s, s.pending.sampledId); }
    else if (/^[1-9]$/.test(e.key) && s.pending) { const c = s.pending.top[+e.key - 1]; if (c) { e.preventDefault(); commit(s, c.id); } }
    else if (e.key === 'Backspace') { e.preventDefault(); undo(); }
  }

  /* ---------- open / close ---------- */
  function closeLab() {
    if (!ML) return;
    stop(); closePop();
    document.removeEventListener('keydown', onKey, true);
    const el = ML.el; ML = null;
    el.classList.add('closing');
    setTimeout(() => el.remove(), 160);
  }

  async function openModelLab(opts = {}) {
    if (ML) closeLab();
    ML = freshState();
    ML.mode = opts.mode === 'compare' ? 'compare' : 'inspect';
    if (opts.kind === 'chat') ML.prompt.kind = 'chat';
    const el = document.createElement('div');
    el.className = 'mlab';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Model Lab');
    el.innerHTML = shellHTML();
    document.body.appendChild(el);
    ML.el = el;
    $('#mlClose').onclick = closeLab;
    $('#mlExport').onclick = exportJSON;
    $$('#mlMode [data-mode]').forEach(b => b.onclick = () => {
      if (ML.busy || ML.mode === b.dataset.mode) return;
      ML.mode = b.dataset.mode; ML.sel = null; ML.mobileTab = 'main';
      if (ML.mode === 'compare' && ML.order.length > MAX_COMPARE) { ML.order = ML.order.slice(0, MAX_COMPARE); }
      if (ML.mode === 'compare' && ML.order.length < 2) { const more = ML.models.find(m => !ML.sessions.has(m.id)); if (more) addModel(more.id); }
      renderAll();
    });
    $$('#mlTabs [data-tab]').forEach(b => b.onclick = () => { ML.mobileTab = b.dataset.tab; renderAll(); });
    document.addEventListener('keydown', onKey, true);
    $('#mlCenter').innerHTML = `<div class="mlab-empty"><span class="spin"></span></div>`;

    await refreshStatus();
    if (!ML) return;
    if (!ML.available) {
      $('#mlBody').innerHTML = `<div class="mlab-empty"><div class="mlab-empty-ico">${svg('cpu', 30, 1.5)}</div><h3>Local AI engine unavailable</h3><p class="dim">${esc(ML.statusError || 'The bundled llama.cpp engine is not installed on this server.')}</p></div>`;
      return;
    }
    let ids = (opts.ids || []).filter(id => ML.models.some(m => m.id === id));
    if (!ids.length && opts.ids && opts.ids.length) toast('That model is not available (locked, trashed, or not a .gguf)', 'close');
    if (!ids.length && ML.models.length) ids = [ML.models[0].id];
    if (ML.mode === 'compare' && ids.length < 2) { const more = ML.models.find(m => !ids.includes(m.id)); if (more) ids.push(more.id); }
    ids.slice(0, ML.mode === 'compare' ? MAX_COMPARE : 12).forEach(id => addModel(id));
    ML.activeId = ids[0] || null;
    renderAll();
    if (!ids.length) $('#mlCenter').innerHTML = `<div class="mlab-empty"><div class="mlab-empty-ico">${svg('cpu', 30, 1.5)}</div><h3>No local models</h3><p class="dim">Upload a <code>.gguf</code> file to your Database, then right-click it → <b>Open in Model Lab</b>.</p></div>`;
    // focus the prompt so you can type immediately
    setTimeout(() => { if (!ML) return; const f = ML.prompt.kind === 'chat' ? $('#mlChatIn') : $('#mlRaw'); if (f && !matchMedia('(max-width: 900px)').matches) f.focus(); }, 60);
  }

  window.openModelLab = openModelLab;
  window.closeModelLab = closeLab;
})();

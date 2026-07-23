/* ============================================================
   NEURAL ENGINE — the math core for the Neural app.
   Shared, dependency-free, and isomorphic: it runs UNCHANGED in the browser
   (client / on-device compute) and in Node (backend compute, gated by
   can_neural_backend). Everything here is plain arrays + JSON-serializable model
   objects, so a model can be trained a chunk on either side and the weights handed
   back and forth or saved to the encrypted `networks` table verbatim.

   Two model families live here:
     • LLM — a small-but-real transformer language model the user builds FROM THE
              GROUND UP: choose a tokenizer (char / BPE subwords / whole words /
              sentences), context length, embedding dim, activation, dropout and the
              hidden layer stack; then train it with a real optimizer (AdamW / RAdam
              / Lion / LAMB / SGD) on their own text and chat with the result. This is
              the whole Neural app. Educational-scale by design so a browser tab, the
              Node box, or a phone can actually train it — but it is a genuine
              decoder-only transformer trained by backprop, not a toy.
     • ORGANIZER — a per-user file-organization classifier (path C). NOT part of the
              Neural app UI; it is the brain behind the vault's "AI Organization"
              feature and is required by server.js. Left intact below.

   Determinism: a tiny seedable PRNG (mulberry32) so a saved seed reproduces a run.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;       // Node (backend)
  if (typeof window !== 'undefined') window.NeuralEngine = api;                     // browser (client)
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- RNG ---------- */
  function mulberry32(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gaussian(rng) {            // Box–Muller
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* ---------- shared tensor helpers (used by LLM + organizer) ---------- */
  function zeros(n) { return new Float64Array(n); }
  function randMat(rows, cols, rng, scale) {
    const m = new Float64Array(rows * cols);
    for (let i = 0; i < m.length; i++) m[i] = gaussian(rng) * (scale ?? (1 / Math.sqrt(cols)));
    return m;
  }
  function clampInt(v, lo, hi, d) { v = Math.floor(Number(v)); if (!Number.isFinite(v)) v = d; return Math.max(lo, Math.min(hi, v)); }
  function clampNum(v, lo, hi, d) { v = Number(v); if (!Number.isFinite(v)) v = d; return Math.max(lo, Math.min(hi, v)); }

  /* ---------- activations (value + derivative given the activated output y) ----------
     Each entry: f(x) forward, df(y) derivative expressed in terms of the OUTPUT y
     (cheap for the ones we care about). Used by the transformer MLP block. */
  const ACT = {
    relu:    { f: (x) => (x > 0 ? x : 0),                 df: (y) => (y > 0 ? 1 : 0) },
    leaky:   { f: (x) => (x > 0 ? x : 0.01 * x),          df: (y) => (y > 0 ? 1 : 0.01) },
    tanh:    { f: (x) => Math.tanh(x),                    df: (y) => 1 - y * y },
    sigmoid: { f: (x) => 1 / (1 + Math.exp(-x)),          df: (y) => y * (1 - y) },
    // tanh-approx GELU; df via the same approximation (good enough, stable, cheap).
    gelu:    {
      f: (x) => 0.5 * x * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x * x * x))),
      // derivative of the tanh-GELU (in terms of x, recomputed — y not sufficient here)
      dfx: (x) => {
        const c = 0.7978845608, a = 0.044715;
        const inner = c * (x + a * x * x * x);
        const t = Math.tanh(inner);
        const sech2 = 1 - t * t;
        return 0.5 * (1 + t) + 0.5 * x * sech2 * c * (1 + 3 * a * x * x);
      },
    },
    linear:  { f: (x) => x,                               df: () => 1 },
  };
  function actName(a) { return ACT[a] ? a : 'gelu'; }

  /* ============================================================
     LLM — a small decoder-only transformer the user builds from scratch.

     Model doc shape (all JSON-serializable, arrays not typed arrays on the wire):
       {
         type:'llm', v:2,
         tok: <tokenizer doc>,           // see Tokenizer below
         cfg: { ctx, embed, act, dropout, layers:[h,h,...], heads },
         // parameters, flat Float64 arrays (row-major):
         Wtok:  [V*E],   Wpos:[ctx*E],
         blocks: [ { ln1g,ln1b, Wq,Wk,Wv,Wo, ln2g,ln2b, W1,b1, W2,b2 }, ... ],
         lnFg, lnFb,     Wout:[V*E]  (tied? no — separate head)
       }
     "layers" is the hidden-MLP width PER transformer block (the user's "layer
     structure"): its length = number of transformer blocks, each value = that
     block's feed-forward inner width. heads = attention heads (derived, kept even).
     ============================================================ */

  /* ---------------- Tokenizers ----------------
     One doc shape, four modes. A tokenizer doc:
       { mode:'char'|'bpe'|'word'|'sentence', vocab:[...tokens], merges?:[[a,b],...] }
     vocab[0..3] are reserved specials: <pad> <unk> <bos> <eos>. */
  const SPECIALS = ['<pad>', '<unk>', '<bos>', '<eos>'];
  const PAD = 0, UNK = 1, BOS = 2, EOS = 3;

  function tokenizerTrain(text, opts) {
    const mode = opts && opts.mode || 'char';
    const maxVocab = clampInt(opts && opts.maxVocab, 16, 8000, mode === 'char' ? 512 : 3000);
    text = String(text || '');
    if (mode === 'char') {
      const seen = Object.create(null), vocab = SPECIALS.slice();
      for (const ch of text) if (!(ch in seen) && vocab.length < maxVocab) { seen[ch] = 1; vocab.push(ch); }
      return { mode, vocab };
    }
    if (mode === 'word') {
      return { mode, vocab: SPECIALS.concat(topCounts(wordPieces(text), maxVocab - SPECIALS.length)) };
    }
    if (mode === 'sentence') {
      return { mode, vocab: SPECIALS.concat(topCounts(sentencePieces(text), maxVocab - SPECIALS.length)) };
    }
    // BPE: start from bytes/chars, greedily merge the most frequent adjacent pair.
    return bpeTrain(text, maxVocab);
  }

  // split helpers ------------------------------------------------------------
  function wordPieces(text) {
    // words and standalone punctuation as separate tokens; keep a trailing space
    // marker implicitly by lowercasing nothing (case preserved).
    const out = []; const re = /[A-Za-z0-9']+|[^\sA-Za-z0-9']/g; let m;
    while ((m = re.exec(text))) out.push(m[0]);
    return out;
  }
  function sentencePieces(text) {
    return String(text).split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  }
  function topCounts(pieces, k) {
    const c = new Map();
    for (const p of pieces) c.set(p, (c.get(p) || 0) + 1);
    return Array.from(c.entries()).sort((a, b) => b[1] - a[1]).slice(0, Math.max(0, k)).map(e => e[0]);
  }

  // A compact BPE trainer over characters. Produces vocab + ordered merges.
  function bpeTrain(text, maxVocab) {
    // seed vocab: specials + all unique chars
    const charSet = []; const seen = Object.create(null);
    for (const ch of text) if (!(ch in seen)) { seen[ch] = 1; charSet.push(ch); }
    const vocab = SPECIALS.concat(charSet);
    const vset = new Set(vocab);
    // represent the corpus as an array of symbol-arrays (one per "word" chunk to
    // keep merges from spanning whitespace — standard BPE pre-tokenization).
    const chunks = String(text).split(/(\s+)/).filter(s => s.length).map(w => Array.from(w));
    const merges = [];
    const budget = Math.min(maxVocab - vocab.length, 4000);
    for (let step = 0; step < budget; step++) {
      const pairs = new Map();
      for (const w of chunks) for (let i = 0; i < w.length - 1; i++) {
        const key = w[i] + ' ' + w[i + 1];
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
      let best = null, bestN = 1;
      for (const [k, n] of pairs) if (n > bestN) { bestN = n; best = k; }
      if (!best) break;
      const [a, b] = best.split(' '); const merged = a + b;
      if (vset.has(merged)) continue;
      merges.push([a, b]); vocab.push(merged); vset.add(merged);
      for (const w of chunks) for (let i = 0; i < w.length - 1; i++) {
        if (w[i] === a && w[i + 1] === b) { w.splice(i, 2, merged); }
      }
      if (vocab.length >= maxVocab) break;
    }
    return { mode: 'bpe', vocab, merges };
  }

  function tokVocabSize(tok) { return tok.vocab.length; }
  function tokStoi(tok) {
    if (tok._stoi) return tok._stoi;
    const s = Object.create(null); tok.vocab.forEach((t, i) => s[t] = i);
    Object.defineProperty(tok, '_stoi', { value: s, enumerable: false, configurable: true });
    return s;
  }

  function tokenizerEncode(tok, text) {
    const stoi = tokStoi(tok);
    const ids = [];
    if (tok.mode === 'char') {
      for (const ch of String(text)) ids.push(stoi[ch] ?? UNK);
      return ids;
    }
    if (tok.mode === 'word') {
      for (const p of wordPieces(text)) ids.push(stoi[p] ?? UNK);
      return ids;
    }
    if (tok.mode === 'sentence') {
      for (const p of sentencePieces(text)) ids.push(stoi[p] ?? UNK);
      return ids;
    }
    // bpe: apply learned merges greedily per whitespace chunk
    const chunks = String(text).split(/(\s+)/).filter(s => s.length);
    for (const chunk of chunks) {
      let w = Array.from(chunk);
      for (const [a, b] of (tok.merges || [])) {
        for (let i = 0; i < w.length - 1; i++) if (w[i] === a && w[i + 1] === b) { w.splice(i, 2, a + b); i--; }
      }
      for (const sym of w) ids.push(stoi[sym] ?? UNK);
    }
    return ids;
  }

  function tokenizerDecode(tok, ids) {
    const V = tok.vocab;
    let out = '';
    for (const id of ids) {
      if (id === PAD || id === BOS || id === EOS) continue;
      const t = V[id]; if (t == null) continue;
      if (id === UNK) { out += '�'; continue; }
      if (tok.mode === 'word') out += (out && /[A-Za-z0-9']$/.test(out) && /^[A-Za-z0-9']/.test(t) ? ' ' : (out ? '' : '')) + t;
      else if (tok.mode === 'sentence') out += (out ? ' ' : '') + t;
      else out += t; // char / bpe already carry their own spacing
    }
    // word mode: we joined selectively; ensure spaces between alnum tokens
    if (tok.mode === 'word') return decodeWords(tok, ids);
    return out;
  }
  function decodeWords(tok, ids) {
    const V = tok.vocab; let out = '';
    for (const id of ids) {
      if (id === PAD || id === BOS || id === EOS) continue;
      const t = id === UNK ? '�' : V[id]; if (t == null) continue;
      const isPunct = /^[^\sA-Za-z0-9']$/.test(t);
      if (out && !isPunct) out += ' ';
      out += t;
    }
    return out;
  }

  /* ---------------- Model construction ---------------- */
  // heads: pick the largest divisor of E that is <= a cap, so head dim stays sane.
  function pickHeads(E) {
    for (const h of [8, 6, 4, 3, 2]) if (E % h === 0 && E / h >= 8) return h;
    return 1;
  }
  function newBlock(E, hidden, rng) {
    return {
      ln1g: Array.from(ones(E)), ln1b: Array.from(zeros(E)),
      Wq: Array.from(randMat(E, E, rng, 1 / Math.sqrt(E))),
      Wk: Array.from(randMat(E, E, rng, 1 / Math.sqrt(E))),
      Wv: Array.from(randMat(E, E, rng, 1 / Math.sqrt(E))),
      Wo: Array.from(randMat(E, E, rng, 1 / Math.sqrt(E))),
      ln2g: Array.from(ones(E)), ln2b: Array.from(zeros(E)),
      W1: Array.from(randMat(hidden, E, rng, Math.sqrt(2 / E))), b1: Array.from(zeros(hidden)),
      W2: Array.from(randMat(E, hidden, rng, 1 / Math.sqrt(hidden))), b2: Array.from(zeros(E)),
      h: hidden,
    };
  }
  function ones(n) { const a = new Float64Array(n); a.fill(1); return a; }

  function llmInit(arch) {
    const tok = arch.tok || tokenizerTrain('', { mode: 'char' });
    const V = tokVocabSize(tok);
    const ctx = clampInt(arch.ctx, 8, 512, 64);
    const E = clampInt(arch.embed, 8, 256, 48);
    const layers = (Array.isArray(arch.layers) && arch.layers.length ? arch.layers : [E * 2])
      .map(w => clampInt(w, 8, 1024, E * 2)).slice(0, 8);
    const act = actName(arch.act);
    const dropout = clampNum(arch.dropout, 0, 0.6, 0);
    const heads = pickHeads(E);
    const rng = mulberry32((arch.seed >>> 0) || 7);
    const m = {
      type: 'llm', v: 2, tok, cfg: { ctx, embed: E, act, dropout, layers, heads },
      Wtok: Array.from(randMat(V, E, rng, 0.4)),
      Wpos: Array.from(randMat(ctx, E, rng, 0.02)),
      blocks: layers.map(h => newBlock(E, h, rng)),
      lnFg: Array.from(ones(E)), lnFb: Array.from(zeros(E)),
      Wout: Array.from(randMat(V, E, rng, 1 / Math.sqrt(E))), bout: Array.from(zeros(V)),
      seed: (arch.seed >>> 0) || 7,
    };
    return m;
  }

  function llmParamCount(m) {
    let n = m.Wtok.length + m.Wpos.length + m.Wout.length + m.bout.length + m.lnFg.length + m.lnFb.length;
    for (const b of m.blocks) n += b.Wq.length + b.Wk.length + b.Wv.length + b.Wo.length +
      b.W1.length + b.b1.length + b.W2.length + b.b2.length + b.ln1g.length * 2 + b.ln2g.length * 2;
    return n;
  }

  /* ---------------- Forward / backward ----------------
     We run a full sequence of length T (<= ctx) and predict the next token at every
     position (causal LM). Math is written for clarity + correctness over raw speed;
     it is bounded per call so it stays off the event loop too long. */
  function layerNorm(x, g, b, E, cache) {
    // x: Float64Array length E → normalized y
    let mean = 0; for (let i = 0; i < E; i++) mean += x[i]; mean /= E;
    let v = 0; for (let i = 0; i < E; i++) { const d = x[i] - mean; v += d * d; } v /= E;
    const inv = 1 / Math.sqrt(v + 1e-5);
    const y = new Float64Array(E), xh = new Float64Array(E);
    for (let i = 0; i < E; i++) { xh[i] = (x[i] - mean) * inv; y[i] = xh[i] * g[i] + b[i]; }
    if (cache) { cache.xh = xh; cache.inv = inv; }
    return y;
  }
  // backprop through layernorm: given dy (grad wrt output), accumulate into dg,db and
  // return dx. Uses the standard LN gradient.
  function layerNormBack(dy, xh, inv, g, E, dg, db) {
    const dx = new Float64Array(E);
    let sumDy = 0, sumDyXh = 0;
    const dxh = new Float64Array(E);
    for (let i = 0; i < E; i++) { dxh[i] = dy[i] * g[i]; dg[i] += dy[i] * xh[i]; db[i] += dy[i]; sumDy += dxh[i]; sumDyXh += dxh[i] * xh[i]; }
    for (let i = 0; i < E; i++) dx[i] = inv / E * (E * dxh[i] - sumDy - xh[i] * sumDyXh);
    return dx;
  }
  function matVec(W, x, rows, cols, bias) {
    // W is [rows*cols] row-major, x is [cols] → [rows]
    const o = new Float64Array(rows);
    for (let r = 0; r < rows; r++) { let s = bias ? bias[r] : 0; const base = r * cols; for (let c = 0; c < cols; c++) s += W[base + c] * x[c]; o[r] = s; }
    return o;
  }

  // Full forward+backward over one sequence of token ids; returns {loss, grads}.
  // grads mirrors the model's parameter structure. dropoutMask applied in train only.
  function llmForwardBackward(m, ids, opt, rng) {
    const E = m.cfg.embed, ctx = m.cfg.ctx, heads = m.cfg.heads, hd = E / heads;
    const V = tokVocabSize(m.tok);
    const T = Math.min(ids.length - 1, ctx);
    const actf = ACT[m.cfg.act] || ACT.gelu;
    const drop = opt && opt.training ? m.cfg.dropout : 0;
    const grads = opt ? blankGrads(m) : null;

    // ---- embeddings ----
    const X = [];          // X[t] = Float64Array(E) residual stream input
    for (let t = 0; t < T; t++) {
      const id = ids[t]; const x = new Float64Array(E);
      const tb = id * E, pb = t * E;
      for (let i = 0; i < E; i++) x[i] = m.Wtok[tb + i] + m.Wpos[pb + i];
      X.push(x);
    }

    // caches for backward
    const blkCache = [];
    let stream = X;
    for (let L = 0; L < m.blocks.length; L++) {
      const blk = m.blocks[L];
      const c = { ln1: [], q: [], k: [], v: [], att: [], ctxv: [], ao: [], ln2: [], h: [], mlpPre: [], res1: [] };
      // --- LN1 + self-attention ---
      const normed = [];
      for (let t = 0; t < T; t++) { const cc = {}; normed.push(layerNorm(stream[t], blk.ln1g, blk.ln1b, E, cc)); c.ln1.push(cc); }
      const Q = [], K = [], Vv = [];
      for (let t = 0; t < T; t++) { Q.push(matVec(blk.Wq, normed[t], E, E)); K.push(matVec(blk.Wk, normed[t], E, E)); Vv.push(matVec(blk.Wv, normed[t], E, E)); }
      c.q = Q; c.k = K; c.v = Vv; c.normed1 = normed;
      const attnOut = [];
      const attProb = [];   // attProb[t] = per-head prob arrays
      for (let t = 0; t < T; t++) {
        const outVec = new Float64Array(E);
        const probsHeads = [];
        for (let h = 0; h < heads; h++) {
          const off = h * hd;
          // scores over j<=t
          const scores = new Float64Array(t + 1);
          for (let j = 0; j <= t; j++) { let s = 0; for (let d = 0; d < hd; d++) s += Q[t][off + d] * K[j][off + d]; scores[j] = s / Math.sqrt(hd); }
          // softmax
          let mx = -Infinity; for (let j = 0; j <= t; j++) if (scores[j] > mx) mx = scores[j];
          let sm = 0; for (let j = 0; j <= t; j++) { scores[j] = Math.exp(scores[j] - mx); sm += scores[j]; }
          for (let j = 0; j <= t; j++) scores[j] /= sm;
          probsHeads.push(scores);
          for (let d = 0; d < hd; d++) { let acc = 0; for (let j = 0; j <= t; j++) acc += scores[j] * Vv[j][off + d]; outVec[off + d] = acc; }
        }
        attnOut.push(outVec); attProb.push(probsHeads);
      }
      c.attProb = attProb; c.attnOut = attnOut;
      // output projection + residual
      const res1 = [];
      const proj = [];
      for (let t = 0; t < T; t++) { const p = matVec(blk.Wo, attnOut[t], E, E); proj.push(p); const r = new Float64Array(E); for (let i = 0; i < E; i++) r[i] = stream[t][i] + p[i]; res1.push(r); }
      c.proj = proj; c.res1 = res1;
      // --- LN2 + MLP ---
      const out2 = [];
      const normed2 = [], hAct = [], hPre = [];
      for (let t = 0; t < T; t++) {
        const cc = {}; const n2 = layerNorm(res1[t], blk.ln2g, blk.ln2b, E, cc); normed2.push(n2); c.ln2.push(cc);
        const pre = matVec(blk.W1, n2, blk.h, E, blk.b1);
        const a = new Float64Array(blk.h);
        for (let i = 0; i < blk.h; i++) a[i] = actf.f(pre[i]);
        // dropout on the hidden activation
        if (drop > 0) for (let i = 0; i < blk.h; i++) { if (rng() < drop) a[i] = 0; else a[i] /= (1 - drop); }
        hPre.push(pre); hAct.push(a);
        const o = matVec(blk.W2, a, E, blk.h, blk.b2);
        const r = new Float64Array(E); for (let i = 0; i < E; i++) r[i] = res1[t][i] + o[i];
        out2.push(r);
      }
      c.normed2 = normed2; c.hAct = hAct; c.hPre = hPre;
      blkCache.push(c);
      stream = out2;
    }

    // ---- final LN + output head + loss ----
    let loss = 0; let count = 0;
    const dStream = [];  // grad flowing back into `stream` (post-final-block)
    for (let t = 0; t < T; t++) dStream.push(new Float64Array(E));
    const fCache = [];
    for (let t = 0; t < T; t++) {
      const cc = {}; const fn = layerNorm(stream[t], m.lnFg, m.lnFb, E, cc); fCache.push(cc); cc.fn = fn;
      const logits = matVec(m.Wout, fn, V, E, m.bout);
      // softmax + cross-entropy vs next token
      let mx = -Infinity; for (let i = 0; i < V; i++) if (logits[i] > mx) mx = logits[i];
      let s = 0; const probs = new Float64Array(V);
      for (let i = 0; i < V; i++) { probs[i] = Math.exp(logits[i] - mx); s += probs[i]; }
      for (let i = 0; i < V; i++) probs[i] /= s;
      const y = ids[t + 1];
      loss += -Math.log(Math.max(probs[y], 1e-9)); count++;
      if (grads) {
        // dlogits
        const dlog = probs; dlog[y] -= 1;
        // Wout / bout grads + grad into fn
        const dfn = new Float64Array(E);
        for (let i = 0; i < V; i++) { const dl = dlog[i]; grads.bout[i] += dl; const base = i * E; for (let j = 0; j < E; j++) { grads.Wout[base + j] += dl * fCache[t].fn[j]; dfn[j] += dl * m.Wout[base + j]; } }
        // back through final LN
        const dx = layerNormBack(dfn, cc.xh, cc.inv, m.lnFg, E, grads.lnFg, grads.lnFb);
        for (let j = 0; j < E; j++) dStream[t][j] += dx[j];
      }
    }

    if (!grads) return { loss: loss / Math.max(1, count), count };

    // ---- backward through blocks (reverse) ----
    let dOut = dStream;   // grad wrt each block's output (== next block's input grad)
    for (let L = m.blocks.length - 1; L >= 0; L--) {
      const blk = m.blocks[L], g = grads.blocks[L], c = blkCache[L];
      const dRes1 = []; for (let t = 0; t < T; t++) dRes1.push(new Float64Array(E));
      // --- MLP backward ---
      for (let t = 0; t < T; t++) {
        const dO = dOut[t];
        // residual: out2 = res1 + o  → dres1 += dO ; do = dO
        for (let i = 0; i < E; i++) dRes1[t][i] += dO[i];
        // W2: o = W2 · a
        const a = c.hAct[t]; const da = new Float64Array(blk.h);
        for (let i = 0; i < E; i++) { const dl = dO[i]; g.b2[i] += dl; const base = i * blk.h; for (let k = 0; k < blk.h; k++) { g.W2[base + k] += dl * a[k]; da[k] += dl * blk.W2[base + k]; } }
        // activation backward
        const dpre = new Float64Array(blk.h); const pre = c.hPre[t];
        for (let k = 0; k < blk.h; k++) { const d = actf.dfx ? actf.dfx(pre[k]) : actf.df(a[k]); dpre[k] = da[k] * d; }
        // W1: pre = W1 · n2
        const dn2 = new Float64Array(E); const n2 = c.normed2[t];
        for (let k = 0; k < blk.h; k++) { const dl = dpre[k]; g.b1[k] += dl; const base = k * E; for (let j = 0; j < E; j++) { g.W1[base + j] += dl * n2[j]; dn2[j] += dl * blk.W1[base + j]; } }
        // back through LN2 into res1
        const dx = layerNormBack(dn2, c.ln2[t].xh, c.ln2[t].inv, blk.ln2g, E, g.ln2g, g.ln2b);
        for (let j = 0; j < E; j++) dRes1[t][j] += dx[j];
      }
      // --- attention backward ---
      const dStreamIn = []; for (let t = 0; t < T; t++) dStreamIn.push(new Float64Array(E));
      const dNormed = []; for (let t = 0; t < T; t++) dNormed.push(new Float64Array(E));
      const dAttnOut = []; for (let t = 0; t < T; t++) dAttnOut.push(new Float64Array(E));
      for (let t = 0; t < T; t++) {
        // res1 = stream + proj → dstream += dRes1 ; dproj = dRes1
        for (let i = 0; i < E; i++) dStreamIn[t][i] += dRes1[t][i];
        // Wo: proj = Wo · attnOut
        const ao = c.attnOut[t]; const dO = dRes1[t];
        for (let i = 0; i < E; i++) { const dl = dO[i]; const base = i * E; for (let k = 0; k < E; k++) { g.Wo[base + k] += dl * ao[k]; dAttnOut[t][k] += dl * blk.Wo[base + k]; } }
      }
      // through attention to Q,K,V
      const dQ = []; const dK = []; const dV = [];
      for (let t = 0; t < T; t++) { dQ.push(new Float64Array(E)); dK.push(new Float64Array(E)); dV.push(new Float64Array(E)); }
      const heads2 = heads, hd2 = hd;
      for (let t = 0; t < T; t++) {
        for (let h = 0; h < heads2; h++) {
          const off = h * hd2; const probs = c.attProb[t][h];
          // dV and dscores
          const dScores = new Float64Array(t + 1);
          for (let d = 0; d < hd2; d++) {
            const grad = dAttnOut[t][off + d];
            for (let j = 0; j <= t; j++) { dV[j][off + d] += probs[j] * grad; dScores[j] += grad * c.v[j][off + d]; }
          }
          // softmax backward
          let dot = 0; for (let j = 0; j <= t; j++) dot += dScores[j] * probs[j];
          for (let j = 0; j <= t; j++) { const ds = probs[j] * (dScores[j] - dot) / Math.sqrt(hd2); for (let d = 0; d < hd2; d++) { dQ[t][off + d] += ds * c.k[j][off + d]; dK[j][off + d] += ds * c.q[t][off + d]; } }
        }
      }
      // Q,K,V projections back to normed1
      for (let t = 0; t < T; t++) {
        const n1 = c.normed1[t];
        accumProjGrad(g.Wq, blk.Wq, dQ[t], n1, dNormed[t], E);
        accumProjGrad(g.Wk, blk.Wk, dK[t], n1, dNormed[t], E);
        accumProjGrad(g.Wv, blk.Wv, dV[t], n1, dNormed[t], E);
      }
      // back through LN1 into the block input stream
      for (let t = 0; t < T; t++) {
        const dx = layerNormBack(dNormed[t], c.ln1[t].xh, c.ln1[t].inv, blk.ln1g, E, g.ln1g, g.ln1b);
        for (let j = 0; j < E; j++) dStreamIn[t][j] += dx[j];
      }
      dOut = dStreamIn;
    }

    // ---- embeddings backward ----
    for (let t = 0; t < T; t++) {
      const id = ids[t]; const tb = id * E, pb = t * E;
      for (let i = 0; i < E; i++) { grads.Wtok[tb + i] += dOut[t][i]; grads.Wpos[pb + i] += dOut[t][i]; }
    }

    return { loss: loss / Math.max(1, count), count, grads };
  }
  // proj: y = W · x (rows=E, cols=E). Accumulate dW and dx from dy.
  function accumProjGrad(dW, W, dy, x, dx, E) {
    for (let r = 0; r < E; r++) { const dl = dy[r]; const base = r * E; for (let c = 0; c < E; c++) { dW[base + c] += dl * x[c]; dx[c] += dl * W[base + c]; } }
  }

  function blankGrads(m) {
    const z = (a) => new Float64Array(a.length);
    return {
      Wtok: z(m.Wtok), Wpos: z(m.Wpos), Wout: z(m.Wout), bout: z(m.bout), lnFg: z(m.lnFg), lnFb: z(m.lnFb),
      blocks: m.blocks.map(b => ({
        ln1g: z(b.ln1g), ln1b: z(b.ln1b), Wq: z(b.Wq), Wk: z(b.Wk), Wv: z(b.Wv), Wo: z(b.Wo),
        ln2g: z(b.ln2g), ln2b: z(b.ln2b), W1: z(b.W1), b1: z(b.b1), W2: z(b.W2), b2: z(b.b2),
      })),
    };
  }
  // flat list of {name, arr(model), grad} tensors for the optimizer to iterate.
  function paramTensors(m, grads) {
    const out = [];
    const push = (key, arr, garr) => out.push({ arr, g: garr });
    push('Wtok', m.Wtok, grads.Wtok); push('Wpos', m.Wpos, grads.Wpos);
    push('Wout', m.Wout, grads.Wout); push('bout', m.bout, grads.bout);
    push('lnFg', m.lnFg, grads.lnFg); push('lnFb', m.lnFb, grads.lnFb);
    for (let i = 0; i < m.blocks.length; i++) {
      const b = m.blocks[i], gb = grads.blocks[i];
      for (const k of ['ln1g', 'ln1b', 'Wq', 'Wk', 'Wv', 'Wo', 'ln2g', 'ln2b', 'W1', 'b1', 'W2', 'b2']) push(k, b[k], gb[k]);
    }
    return out;
  }
  function addGrads(dst, src) {
    for (let i = 0; i < dst.Wtok.length; i++) dst.Wtok[i] += src.Wtok[i];
    for (let i = 0; i < dst.Wpos.length; i++) dst.Wpos[i] += src.Wpos[i];
    for (let i = 0; i < dst.Wout.length; i++) dst.Wout[i] += src.Wout[i];
    for (let i = 0; i < dst.bout.length; i++) dst.bout[i] += src.bout[i];
    for (let i = 0; i < dst.lnFg.length; i++) { dst.lnFg[i] += src.lnFg[i]; dst.lnFb[i] += src.lnFb[i]; }
    for (let L = 0; L < dst.blocks.length; L++) {
      const d = dst.blocks[L], s = src.blocks[L];
      for (const k in d) for (let i = 0; i < d[k].length; i++) d[k][i] += s[k][i];
    }
  }

  /* ---------------- Optimizers ----------------
     One step given the accumulated (mean) grads. opt carries persistent moment
     buffers (m,v) keyed by tensor index, plus t. Supports adamw/radam/lion/lamb/sgd.
     We clip grads and apply decoupled weight decay (AdamW/LAMB). */
  function optStep(model, grads, opt) {
    const tensors = paramTensors(model, grads);
    const kind = opt.kind || 'adamw';
    const lr = opt.lr, wd = opt.wd ?? 0.01, b1 = 0.9, b2 = 0.999, eps = 1e-8, clip = 5;
    if (!opt.mom) { opt.mom = tensors.map(t => new Float64Array(t.arr.length)); opt.vel = tensors.map(t => new Float64Array(t.arr.length)); opt.t = 0; }
    opt.t++;
    const bc1 = 1 - Math.pow(b1, opt.t), bc2 = 1 - Math.pow(b2, opt.t);
    for (let ti = 0; ti < tensors.length; ti++) {
      const { arr, g } = tensors[ti], mo = opt.mom[ti], ve = opt.vel[ti];
      if (kind === 'sgd') {
        for (let i = 0; i < arr.length; i++) { let gi = g[i]; if (gi > clip) gi = clip; else if (gi < -clip) gi = -clip; mo[i] = 0.9 * mo[i] + gi; arr[i] -= lr * mo[i]; }
        continue;
      }
      if (kind === 'lion') {
        for (let i = 0; i < arr.length; i++) {
          let gi = g[i]; if (gi > clip) gi = clip; else if (gi < -clip) gi = -clip;
          const upd = Math.sign(0.9 * mo[i] + 0.1 * gi);
          arr[i] -= lr * (upd + wd * arr[i]);
          mo[i] = 0.99 * mo[i] + 0.01 * gi;
        }
        continue;
      }
      // adam-family (adamw / radam / lamb)
      let r1 = 0, r2 = 0;   // for LAMB trust ratio
      const updBuf = kind === 'lamb' ? new Float64Array(arr.length) : null;
      for (let i = 0; i < arr.length; i++) {
        let gi = g[i]; if (gi > clip) gi = clip; else if (gi < -clip) gi = -clip;
        mo[i] = b1 * mo[i] + (1 - b1) * gi;
        ve[i] = b2 * ve[i] + (1 - b2) * gi * gi;
        const mh = mo[i] / bc1, vh = ve[i] / bc2;
        let upd;
        if (kind === 'radam') {
          const rhoInf = 2 / (1 - b2) - 1;
          const rho = rhoInf - 2 * opt.t * Math.pow(b2, opt.t) / bc2;
          if (rho > 4) { const rect = Math.sqrt(((rho - 4) * (rho - 2) * rhoInf) / ((rhoInf - 4) * (rhoInf - 2) * rho)); upd = rect * mh / (Math.sqrt(vh) + eps); }
          else upd = mh; // fall back to plain momentum early
        } else {
          upd = mh / (Math.sqrt(vh) + eps);
        }
        if (kind === 'lamb') { updBuf[i] = upd + wd * arr[i]; r2 += updBuf[i] * updBuf[i]; r1 += arr[i] * arr[i]; }
        else { arr[i] -= lr * (upd + (kind === 'adamw' ? wd * arr[i] : 0)); }
      }
      if (kind === 'lamb') {
        const wNorm = Math.sqrt(r1), uNorm = Math.sqrt(r2) || 1;
        const trust = (wNorm > 0 && uNorm > 0) ? wNorm / uNorm : 1;
        for (let i = 0; i < arr.length; i++) arr[i] -= lr * trust * updBuf[i];
      }
    }
  }

  /* ---------------- Training driver ----------------
     Runs a bounded chunk: `steps` optimizer steps, each over a micro-batch of
     `batch` random windows. Grads are averaged across the batch — this is the
     "parallelism by design" seam: llmTrainBatchGrads computes per-sample grads that
     a Worker pool can produce concurrently and we just sum. Returns updated loss. */
  function sampleWindow(ids, ctx, rng) {
    const T = Math.min(ids.length - 1, ctx);
    const start = ids.length - 1 - T <= 0 ? 0 : (rng() * (ids.length - 1 - T)) | 0;
    return ids.slice(start, start + T + 1);
  }
  // Compute summed grads + loss over a batch (used both inline and by workers).
  function llmBatchGrads(m, batchIds, opt, rng) {
    const total = blankGrads(m); let loss = 0, n = 0;
    for (const win of batchIds) {
      const r = llmForwardBackward(m, win, { training: true }, rng);
      if (r.grads) { addGrads(total, r.grads); loss += r.loss; n++; }
    }
    // mean
    const scale = 1 / Math.max(1, n);
    scaleGrads(total, scale);
    return { grads: total, loss: loss / Math.max(1, n), n };
  }
  function scaleGrads(g, s) {
    for (const key of ['Wtok', 'Wpos', 'Wout', 'bout', 'lnFg', 'lnFb']) for (let i = 0; i < g[key].length; i++) g[key][i] *= s;
    for (const b of g.blocks) for (const k in b) for (let i = 0; i < b[k].length; i++) b[k][i] *= s;
  }

  function llmTrainChunk(m, ids, opt) {
    hydrateLlm(m);
    const ctx = m.cfg.ctx;
    const steps = clampInt(opt.steps, 1, 100, 10);
    const batch = clampInt(opt.batch, 1, 64, 8);
    const rng = mulberry32(((opt.seed ?? m.seed ?? 1) >>> 0) + (opt.iter | 0));
    opt.lr = clampNum(opt.lr, 1e-5, 1, 3e-3);
    opt.kind = ['adamw', 'radam', 'lion', 'lamb', 'sgd'].includes(opt.kind) ? opt.kind : 'adamw';
    let lastLoss = 0;
    for (let s = 0; s < steps; s++) {
      const windows = [];
      for (let b = 0; b < batch; b++) windows.push(sampleWindow(ids, ctx, rng));
      const { grads, loss } = llmBatchGrads(m, windows, opt, rng);
      optStep(m, grads, opt);
      lastLoss = loss;
    }
    return { loss: lastLoss };
  }

  /* ---------------- Sampling / chat ---------------- */
  function llmSample(m, gen) {
    hydrateLlm(m);
    const ctx = m.cfg.ctx;
    const temp = clampNum(gen.temperature, 0.05, 2, 0.9);
    const topK = clampInt(gen.topK, 0, tokVocabSize(m.tok), 0);
    const maxNew = clampInt(gen.length, 1, 400, 120);
    const rng = mulberry32(((gen.seed ?? Date.now()) >>> 0) || 3);
    let ids = tokenizerEncode(m.tok, String(gen.prompt || ''));
    ids = [BOS].concat(ids);
    const startLen = ids.length;
    for (let step = 0; step < maxNew; step++) {
      const window = ids.slice(Math.max(0, ids.length - ctx));
      const logits = llmLogitsLast(m, window);
      for (let i = 0; i < logits.length; i++) logits[i] /= temp;
      // softmax
      let mx = -Infinity; for (let i = 0; i < logits.length; i++) if (logits[i] > mx) mx = logits[i];
      let sm = 0; const probs = new Float64Array(logits.length);
      for (let i = 0; i < logits.length; i++) { probs[i] = Math.exp(logits[i] - mx); sm += probs[i]; }
      for (let i = 0; i < logits.length; i++) probs[i] /= sm;
      let pick = sampleProbs(probs, topK, rng);
      if (pick === EOS) break;
      ids.push(pick);
    }
    return { text: tokenizerDecode(m.tok, ids.slice(startLen)), ids: ids.slice(startLen) };
  }
  function sampleProbs(probs, topK, rng) {
    const V = probs.length;
    if (topK && topK < V) {
      const idx = Array.from(probs.keys()).sort((a, b) => probs[b] - probs[a]).slice(0, topK);
      const keep = new Float64Array(V); let s = 0;
      for (const k of idx) { keep[k] = probs[k]; s += probs[k]; }
      for (let k = 0; k < V; k++) probs[k] = keep[k] / (s || 1);
    }
    let rv = rng(), acc = 0;
    for (let k = 0; k < V; k++) { acc += probs[k]; if (rv <= acc) return k; }
    return V - 1;
  }
  // forward-only, returns logits at the LAST position.
  function llmLogitsLast(m, ids) {
    const E = m.cfg.embed, heads = m.cfg.heads, hd = E / heads;
    const V = tokVocabSize(m.tok);
    const T = Math.min(ids.length, m.cfg.ctx);
    const actf = ACT[m.cfg.act] || ACT.gelu;
    let stream = [];
    for (let t = 0; t < T; t++) { const id = ids[ids.length - T + t]; const x = new Float64Array(E); const tb = id * E, pb = t * E; for (let i = 0; i < E; i++) x[i] = m.Wtok[tb + i] + m.Wpos[pb + i]; stream.push(x); }
    for (const blk of m.blocks) {
      const normed = stream.map(x => layerNorm(x, blk.ln1g, blk.ln1b, E, null));
      const Q = normed.map(n => matVec(blk.Wq, n, E, E)), K = normed.map(n => matVec(blk.Wk, n, E, E)), Vv = normed.map(n => matVec(blk.Wv, n, E, E));
      const attn = [];
      for (let t = 0; t < T; t++) {
        const outVec = new Float64Array(E);
        for (let h = 0; h < heads; h++) {
          const off = h * hd; const scores = new Float64Array(t + 1);
          for (let j = 0; j <= t; j++) { let s = 0; for (let d = 0; d < hd; d++) s += Q[t][off + d] * K[j][off + d]; scores[j] = s / Math.sqrt(hd); }
          let mx = -Infinity; for (let j = 0; j <= t; j++) if (scores[j] > mx) mx = scores[j];
          let sm = 0; for (let j = 0; j <= t; j++) { scores[j] = Math.exp(scores[j] - mx); sm += scores[j]; }
          for (let j = 0; j <= t; j++) scores[j] /= sm;
          for (let d = 0; d < hd; d++) { let acc = 0; for (let j = 0; j <= t; j++) acc += scores[j] * Vv[j][off + d]; outVec[off + d] = acc; }
        }
        attn.push(outVec);
      }
      const res1 = stream.map((x, t) => { const p = matVec(blk.Wo, attn[t], E, E); const r = new Float64Array(E); for (let i = 0; i < E; i++) r[i] = x[i] + p[i]; return r; });
      stream = res1.map((r) => {
        const n2 = layerNorm(r, blk.ln2g, blk.ln2b, E, null);
        const pre = matVec(blk.W1, n2, blk.h, E, blk.b1);
        const a = new Float64Array(blk.h); for (let i = 0; i < blk.h; i++) a[i] = actf.f(pre[i]);
        const o = matVec(blk.W2, a, E, blk.h, blk.b2);
        const out = new Float64Array(E); for (let i = 0; i < E; i++) out[i] = r[i] + o[i]; return out;
      });
    }
    const fn = layerNorm(stream[T - 1], m.lnFg, m.lnFb, E, null);
    return matVec(m.Wout, fn, V, E, m.bout);
  }

  // On the wire, big arrays may arrive as plain Arrays; the math indexes them fine.
  // We just ensure shape fields + drop the non-enumerable stoi cache.
  function hydrateLlm(m) {
    if (!m || m.type !== 'llm') throw new Error('bad llm model');
    if (m.tok && m.tok._stoi) { try { delete m.tok._stoi; } catch (e) {} }
    return m;
  }

  /* ============================================================
     ORGANIZER — a per-user file-organization classifier (path C).
     A small, fast supervised MLP that learns ONE user's filing habits from their
     own vault: given a file's surface signals (name tokens, extension, media type,
     size bucket) it predicts WHERE it probably belongs (which folder) and WHICH
     tags it probably wants. It is the brain behind the "AI Organization" feature.

     Design priorities (in order): isolation, smallness, and out-of-the-box value.
       • Isolation — the model is just JSON weights; it lives in one account's
         encrypted store and never sees another account's data. Nothing here reads
         globals; everything is passed in. (The server enforces the boundary.)
       • Smallness — fixed-width FEATURE HASHING (the "hashing trick") means the
         input layer is a constant size no matter how big the user's vocabulary
         grows, so the weight matrices never balloon. One small hidden layer
         (default 24 units). A whole trained model is a few tens of KB.
       • Out-of-the-box — train() takes labeled examples built from files that
         ALREADY exist (their current folder = the label, their current tags =
         the labels), so the first pass yields useful suggestions with zero new
         uploads. After that it keeps learning from accepted/rejected suggestions.

     Architecture: featurize(x) -> [INPUT] -> dense+ReLU [HIDDEN] -> two heads:
        folderHead: dense -> softmax over known folder ids   (single-label)
        tagHead:    dense -> sigmoid per known tag id         (multi-label)
     Both heads share the hidden layer, so the cheap features do double duty.
     Trained by backprop + Adam. Negative feedback (a rejected/corrected
     suggestion) is just a training example whose label is the CORRECT answer (or,
     for a flat-out wrong tag, a 0 target for that tag) — same machinery, no
     special path. Determinism via the same mulberry32 seed used elsewhere.
     ============================================================ */
  const ORG_INPUT = 1024;           // hashed feature dimension. Bigger = fewer hash
                                    // collisions, so more files stay distinguishable and
                                    // the richer name+content+fingerprint features have
                                    // room to land in their own slots. Still small.
  // The trunk is a STACK of hidden layers (a real MLP with depth). With the richer
  // content-fingerprint features feeding in, three modestly-wide layers give the
  // net room to compose "content shape + name + type" into a folder/tag decision —
  // while a whole model is still only a few hundred KB. A single number means one
  // layer of that width; an array means that many layers of those widths.
  const ORG_HIDDEN_DEFAULT = [48, 48, 48];

  // FNV-1a string hash, folded into [0, mod). Stable across runs/processes so a
  // saved model's feature indices stay meaningful (unlike a random per-run hash).
  function orgHash(s, mod) {
    let h = 2166136261; s = String(s);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) % mod;
  }
  // Break a filename (or any label-ish string) into lowercase alphanumeric tokens,
  // plus a couple of character n-grams so it generalizes to near-duplicate names
  // ("invoice_2024" and "invoice-2025" share the "invoic" stem). Cheap + language
  // agnostic; we never look INSIDE a file, only at its surface metadata.
  function orgTokens(name) {
    const base = String(name || '').toLowerCase();
    const words = base.split(/[^a-z0-9]+/).filter(Boolean);
    const toks = [];
    for (const w of words) {
      toks.push('w:' + w);
      if (w.length >= 4) { for (let i = 0; i + 3 <= w.length && i < 12; i++) toks.push('g:' + w.slice(i, i + 3)); }
    }
    return toks;
  }
  function orgSizeBucket(size) {
    const s = Number(size) || 0;
    if (s <= 0) return 'sz:0';
    const b = Math.min(9, Math.floor(Math.log10(s)));   // 0..9 decades of bytes
    return 'sz:' + b;
  }
  /* ---------- content fingerprint ----------
     A COMPACT, name-independent summary of a small sample of a file's actual bytes,
     so two files with similar CONTENT land near each other in feature space even if
     their names/metadata differ. Deliberately cheap (a few hundred bytes of stats,
     no parsing/decoding) and bounded: the caller samples a few KB and passes it here.

     The fingerprint captures:
       • kind      — 'text' or 'binary' (printable-byte ratio over the sample)
       • entropy   — Shannon entropy of the sample, bucketed 0..8 (random/compressed
                     data ~8; structured text ~4-5; very repetitive ~1-2). Lets the
                     net tell "already-compressed media" from "plain text" from "code".
       • histo     — the byte distribution folded into 16 coarse buckets (each = 16
                     byte values), normalized + quantized to 0..3. This is the heart
                     of "similar content -> similar features": a JPEG, an MP3, and an
                     English doc each have a characteristic bucketed shape.
       • magic     — the first few bytes as a short signature token (PNG, PDF, ID3,
                     ELF, etc.) when recognizable — a strong, tiny type signal.
       • toks      — IF the sample is texty, a handful of frequent content words
                     (same tokenizer as filenames). Gives real lexical signal
                     ("invoice", "dear", "function") without any heavy NLP.
     Returns a small JSON-friendly object; orgFeatures folds it into the SAME fixed
     vector, so model size is unchanged. */
  function fingerprintBytes(bytes, opts) {
    opts = opts || {};
    const n = bytes ? bytes.length : 0;
    if (!n) return null;
    const counts = new Uint32Array(256);
    let printable = 0;
    for (let i = 0; i < n; i++) {
      const b = bytes[i]; counts[b]++;
      if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
    }
    const printRatio = printable / n;
    // Shannon entropy (bits/byte) over the sample
    let ent = 0;
    for (let b = 0; b < 256; b++) { if (!counts[b]) continue; const p = counts[b] / n; ent -= p * Math.log2(p); }
    const entropyBucket = Math.max(0, Math.min(8, Math.round(ent)));
    // 16-bucket coarse histogram, normalized to the peak bucket then quantized 0..3
    const histo = new Array(16).fill(0);
    for (let b = 0; b < 256; b++) histo[b >> 4] += counts[b];
    let peak = 0; for (let i = 0; i < 16; i++) if (histo[i] > peak) peak = histo[i];
    const histoQ = histo.map(h => peak ? Math.min(3, Math.round((h / peak) * 3)) : 0);
    const isText = printRatio > 0.85 && entropyBucket <= 6;
    // magic signature from the leading bytes (best-effort; '' if unrecognized)
    const magic = magicOf(bytes);
    // texty? pull a few of the most frequent content tokens from the sample
    let toks = [];
    if (isText) {
      const txt = bufToLatin1(bytes, Math.min(n, 4096));
      const freq = Object.create(null);
      for (const t of orgTokens(txt)) if (t.charCodeAt(0) === 119) freq[t] = (freq[t] || 0) + 1;   // 'w:' words only
      toks = Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, 10);
    }
    return { kind: isText ? 'text' : 'binary', entropy: entropyBucket, histo: histoQ, magic, toks };
  }
  function bufToLatin1(bytes, len) {
    let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[i]); return s;
  }
  // recognize a handful of common file signatures from leading bytes -> short token
  function magicOf(b) {
    if (!b || b.length < 4) return '';
    const u = (i) => b[i];
    if (u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4e && u(3) === 0x47) return 'png';
    if (u(0) === 0xff && u(1) === 0xd8 && u(2) === 0xff) return 'jpg';
    if (u(0) === 0x47 && u(1) === 0x49 && u(2) === 0x46) return 'gif';
    if (u(0) === 0x25 && u(1) === 0x50 && u(2) === 0x44 && u(3) === 0x46) return 'pdf';     // %PDF
    if (u(0) === 0x50 && u(1) === 0x4b && (u(2) === 0x03 || u(2) === 0x05)) return 'zip';    // PK..
    if (u(0) === 0x49 && u(1) === 0x44 && u(2) === 0x33) return 'id3';                        // MP3 ID3
    if (u(0) === 0xff && (u(1) & 0xe0) === 0xe0) return 'mpegaudio';
    if (u(0) === 0x1a && u(1) === 0x45 && u(2) === 0xdf && u(3) === 0xa3) return 'mkv';       // EBML
    if (u(0) === 0x52 && u(1) === 0x49 && u(2) === 0x46 && u(3) === 0x46) return 'riff';      // RIFF (wav/avi)
    if (u(0) === 0x7f && u(1) === 0x45 && u(2) === 0x4c && u(3) === 0x46) return 'elf';
    if (b.length >= 8 && u(4) === 0x66 && u(5) === 0x74 && u(6) === 0x79 && u(7) === 0x70) return 'mp4';   // ....ftyp
    if (u(0) === 0x7b || u(0) === 0x5b) return 'jsonish';                                     // { or [
    if (u(0) === 0x3c) return 'xmlish';                                                       // <
    return '';
  }

  // Build the sparse feature vector for one file. We bag-of-features hash every
  // signal into `dim` slots (value = presence, capped so a repeated token can't
  // dominate). `dim` is the model's input width (defaults to ORG_INPUT) — bigger
  // tiers use a wider vector so more distinct features get their own slot (fewer
  // hash collisions). `x` = { name, ext, type, size, fp? } where fp is an optional
  // content fingerprint (see fingerprintBytes). Folding fp into this SAME vector is
  // what lets content shape predictions without enlarging the model.
  function orgFeatures(x, dim) {
    const D = dim || ORG_INPUT;
    const v = new Float64Array(D);
    const bump = (key, w) => { const i = orgHash(key, D); const cap = 4; if (v[i] < cap) v[i] = Math.min(cap, v[i] + (w || 1)); };
    // The RELIABLE, discriminative signals — name tokens, extension, media type —
    // get strong weight. These are what actually separate folders for most files;
    // the content fingerprint is SUPPLEMENTARY and must never drown them out.
    for (const t of orgTokens(x.name)) bump(t);
    if (x.ext) bump('e:' + String(x.ext).toLowerCase().replace(/^\./, ''), 3);   // extension is a strong, clean signal
    if (x.type) bump('t:' + String(x.type), 3);                                  // media type likewise
    bump(orgSizeBucket(x.size));
    bump('§bias');   // an always-on feature so the net can learn a prior
    // ---- content fingerprint features (optional; same vector) ----
    const fp = x.fp;
    if (fp) {
      bump('ck:' + fp.kind);                                   // text vs binary
      bump('ce:' + fp.entropy);                                // entropy bucket
      if (fp.magic) bump('cm:' + fp.magic, 2);                 // signature is a clean type signal
      // The byte histogram is only WEAKLY discriminative — and for media files the
      // sampled header is nearly identical across files of the same format, so a
      // strong histogram would be a block of identical features that DROWNS OUT the
      // name/type signal and collapses the model to the majority folder. So we fold
      // it in at LOW weight: helpful when binaries genuinely differ, never dominant.
      // (Text files rely on content TOKENS instead — their histograms are all alike.)
      if (fp.kind !== 'text' && Array.isArray(fp.histo)) {
        for (let i = 0; i < fp.histo.length; i++) { const q = fp.histo[i]; if (q) bump('ch:' + i + ':' + q, 0.25); }
      }
      // content words (texty files) — share the 'w:' space with the name; a recurring
      // content term ("invoice", "function") is a real, reliable signal.
      if (Array.isArray(fp.toks)) for (const t of fp.toks) bump(t, 1.5);
    }
    return v;
  }

  // Normalize a `hidden` spec into an array of layer widths (clamped). Accepts a
  // number (one layer of that width), an array (those widths), or undefined (default).
  function orgHiddenSizes(hidden) {
    let arr = Array.isArray(hidden) ? hidden : (hidden == null ? ORG_HIDDEN_DEFAULT : [hidden]);
    arr = arr.map(h => clampInt(h, 4, 256, 48)).slice(0, 12);   // cap depth at 12 layers, width at 256
    return arr.length ? arr : [48];
  }
  // Create an empty organizer model with the given label sets. folders/tags are
  // arrays of ids (opaque strings the caller owns); the head index == the id's
  // position, so the caller maps ids<->names. `hidden` is a layer-width array (or
  // a number for a single layer); defaults to ORG_HIDDEN_DEFAULT. `input` is the
  // hashed feature width (defaults to ORG_INPUT); the organizer "tier" sets both.
  function organizerInit({ folders, tags, hidden, input, seed }) {
    const rng = mulberry32(seed >>> 0 || 11);
    const sizes = orgHiddenSizes(hidden);
    const inp = clampInt(input, 256, 65536, ORG_INPUT);
    const F = (folders || []).length, T = (tags || []).length;
    const last = sizes[sizes.length - 1];
    // trunk: a stack of dense+ReLU layers. Wh[L] maps the previous width -> sizes[L].
    const Wh = [], bh = [];
    let prev = inp;
    for (const w of sizes) { Wh.push(Array.from(randMat(w, prev, rng, Math.sqrt(2 / prev)))); bh.push(Array.from(zeros(w))); prev = w; }
    return {
      type: 'organizer', v: 2, inp, hidden: sizes.slice(), seed: seed >>> 0 || 11,
      folders: (folders || []).slice(), tags: (tags || []).slice(),
      Wh, bh,                                    // trunk weights (per layer) + biases
      // folder head: LAST HIDDEN -> F (softmax)
      Wf: Array.from(randMat(Math.max(1, F), last, rng, 1 / Math.sqrt(last))), bf: Array.from(zeros(Math.max(1, F))),
      // tag head: LAST HIDDEN -> T (independent sigmoids)
      Wt: Array.from(randMat(Math.max(1, T), last, rng, 1 / Math.sqrt(last))), bt: Array.from(zeros(Math.max(1, T))),
    };
  }
  // Migrate a v1 single-layer model ({W1,b1,H}) to the v2 stacked shape in place,
  // so a model trained before this change keeps working (its one layer becomes the
  // whole trunk). Idempotent.
  function orgMigrate(m) {
    if (m && m.v === 1 && m.W1 && !m.Wh) {
      // v1 was always 256-input; record that so a width mismatch is detectable.
      m.Wh = [m.W1]; m.bh = [m.b1]; m.hidden = [m.H | 0 || 24]; m.inp = m.inp || 256;
      delete m.W1; delete m.b1; m.v = 2;
    }
    if (m && !m.hidden && m.Wh) m.hidden = m.Wh.map((_, i) => m.bh[i].length);
    // models created before `inp` existed were 256-wide; infer it from the first
    // trunk layer (Wh[0].length / hidden[0]) so the server can detect a width change.
    if (m && m.inp == null && m.Wh && m.Wh[0] && m.hidden && m.hidden[0]) m.inp = (m.Wh[0].length / m.hidden[0]) | 0;
    return m;
  }
  // The input width a given model was BUILT for (may differ from the current
  // ORG_INPUT if the constant changed since the model was trained). The server
  // rebuilds on mismatch; this lets it detect that.
  function organizerInputDim(m) { orgMigrate(m); return m.inp || ORG_INPUT; }
  function orgLastWidth(m) { return m.hidden[m.hidden.length - 1]; }
  // Forward pass for one feature vector. Runs the full hidden stack, caching each
  // layer's pre-activations + activations (needed for backprop), then both heads.
  // The INPUT is sparse (only a few dozen of ORG_INPUT slots are non-zero), so the
  // first layer iterates ONLY the non-zero feature indices — the dominant cost at
  // scale. Inner hidden layers are dense (small width) so they loop normally.
  function organizerForward(m, feat) {
    orgMigrate(m);
    const L = m.hidden.length, F = m.folders.length, T = m.tags.length;
    const acts = [feat];                 // acts[0] = input; acts[L] = last hidden
    const pres = [];                     // pres[l] = pre-activation of layer l
    // non-zero input indices (+ values) — computed once, reused for layer 0
    const nzi = [], nzv = [];
    for (let k = 0; k < feat.length; k++) { const v = feat[k]; if (v) { nzi.push(k); nzv.push(v); } }
    let prev = feat, prevW = m.inp || ORG_INPUT, sparse0 = true;
    for (let l = 0; l < L; l++) {
      const w = m.hidden[l], Wl = m.Wh[l], bl = m.bh[l];
      const pre = new Float64Array(w), out = new Float64Array(w);
      if (sparse0) {
        // layer 0: sum only over the non-zero input features
        for (let j = 0; j < w; j++) {
          let s = bl[j]; const base = j * prevW;
          for (let n = 0; n < nzi.length; n++) s += Wl[base + nzi[n]] * nzv[n];
          pre[j] = s; out[j] = s > 0 ? s : 0;
        }
        sparse0 = false;
      } else {
        for (let j = 0; j < w; j++) {
          let s = bl[j]; const base = j * prevW;
          for (let k = 0; k < prevW; k++) { const pv = prev[k]; if (pv) s += Wl[base + k] * pv; }
          pre[j] = s; out[j] = s > 0 ? s : 0;        // ReLU
        }
      }
      pres.push(pre); acts.push(out); prev = out; prevW = w;
    }
    const hLast = acts[L], HW = prevW;
    let folderP = new Float64Array(F), tagP = new Float64Array(T);
    if (F > 0) {
      const logits = new Float64Array(F);
      for (let i = 0; i < F; i++) { let s = m.bf[i]; const base = i * HW; for (let j = 0; j < HW; j++) s += m.Wf[base + j] * hLast[j]; logits[i] = s; }
      folderP = softmax(logits);
    }
    if (T > 0) {
      for (let i = 0; i < T; i++) { let s = m.bt[i]; const base = i * HW; for (let j = 0; j < HW; j++) s += m.Wt[base + j] * hLast[j]; tagP[i] = 1 / (1 + Math.exp(-s)); }
    }
    return { acts, pres, hLast, folderP, tagP };
  }

  /* Train on a batch of labeled examples for a few epochs with Adam.
     Each example: { x:{name,ext,type,size}, folder: <id|null>, tags:[id...],
                     negTags:[id...]?, weight?:number }
       • folder (if present and known) is the single-label softmax target.
       • tags are positive sigmoid targets (1); negTags are explicit negatives (0)
         — that's how a REJECTED tag suggestion teaches the model "not this".
       • For folder/tag heads we only apply gradient on KNOWN, SUPERVISED outputs:
         tag targets that are neither in tags nor negTags are left unsupervised
         for that example (no gradient), so absence of a tag isn't treated as a
         hard negative unless the caller says so. This keeps multi-label training
         honest when the label space is large and sparsely annotated.
     Returns { loss, n }. opt persists Adam moments across calls (like charlm). */
  function organizerTrain(m, examples, opt) {
    opt = opt || {};
    orgMigrate(m);
    const L = m.hidden.length, F = m.folders.length, T = m.tags.length, HW = orgLastWidth(m);
    const lr = opt.lr || 0.02, epochs = clampInt(opt.epochs, 1, 50, 8);
    const l2 = opt.l2 == null ? 1e-5 : opt.l2;
    const folderIdx = Object.create(null); m.folders.forEach((id, i) => folderIdx[id] = i);
    const tagIdx = Object.create(null); m.tags.forEach((id, i) => tagIdx[id] = i);
    // Adam state keyed by a flat name per weight tensor: the per-layer trunk tensors
    // get names 'Wh0','bh0',… plus the two heads. biasKeys never get L2 weight decay.
    const tensorKeys = [];
    for (let l = 0; l < L; l++) { tensorKeys.push('Wh' + l, 'bh' + l); }
    tensorKeys.push('Wf', 'bf', 'Wt', 'bt');
    const isBias = (k) => k[0] === 'b';
    const tensorOf = (k) => k === 'Wf' ? m.Wf : k === 'bf' ? m.bf : k === 'Wt' ? m.Wt : k === 'bt' ? m.bt
      : (k[0] === 'W' ? m.Wh[+k.slice(2)] : m.bh[+k.slice(2)]);
    if (!opt.mom) { opt.mom = {}; opt.vel = {}; for (const k of tensorKeys) { const n = tensorOf(k).length; opt.mom[k] = new Float64Array(n); opt.vel[k] = new Float64Array(n); } opt.t = 0; }
    const rng = mulberry32((opt.seed ?? m.seed ?? 1) >>> 0 || 1);
    const batchSize = clampInt(opt.batch, 1, 4096, 32);
    // pre-featurize once (examples reused each epoch), at the model's input width
    const inpW = m.inp || ORG_INPUT;
    const ex = examples.map(e => ({ feat: orgFeatures(e.x || {}, inpW), e }));
    // Gradient accumulators allocated ONCE and reused (zeroed per batch). Doing a
    // fresh Float64Array per example was a major allocation cost at scale; and the
    // Adam update now runs ONCE PER BATCH instead of per example, which is the big
    // speedup (a per-example Adam pass over ~50k trunk weights, ×N examples ×epochs,
    // is what made big vaults take minutes). Mini-batch SGD also converges more stably.
    const g = {}; for (const k of tensorKeys) g[k] = new Float64Array(tensorOf(k).length);
    let totalLoss = 0, totalN = 0;
    for (let ep = 0; ep < epochs; ep++) {
      // shuffle (Fisher–Yates) for SGD
      for (let i = ex.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const tmp = ex[i]; ex[i] = ex[j]; ex[j] = tmp; }
      for (let bStart = 0; bStart < ex.length; bStart += batchSize) {
        const bEnd = Math.min(bStart + batchSize, ex.length);
        for (const k of tensorKeys) g[k].fill(0);   // reset batch gradients
        let bn = 0;                                  // examples actually contributing this batch
      for (let ix = bStart; ix < bEnd; ix++) {
        const feat = ex[ix].feat, e = ex[ix].e;
        const w = e.weight == null ? 1 : Math.max(0, e.weight);
        if (w === 0) continue;
        bn++;
        const fwd = organizerForward(m, feat);
        const acts = fwd.acts, pres = fwd.pres, hLast = fwd.hLast;
        const dLast = new Float64Array(HW);     // dL/d(last hidden activation)
        // ---- folder head (softmax cross-entropy) ----
        const fi = (e.folder != null && folderIdx[e.folder] != null) ? folderIdx[e.folder] : -1;
        if (F > 0 && fi >= 0) {
          const p = fwd.folderP;
          totalLoss += -Math.log(Math.max(p[fi], 1e-9)) * w; totalN++;
          for (let i = 0; i < F; i++) {
            const d = (p[i] - (i === fi ? 1 : 0)) * w;
            g.bf[i] += d; const base = i * HW;
            for (let j = 0; j < HW; j++) { g.Wf[base + j] += d * hLast[j]; dLast[j] += d * m.Wf[base + j]; }
          }
        }
        // ---- tag head (per-tag binary cross-entropy on supervised tags only) ----
        if (T > 0) {
          const pos = new Set((e.tags || []).map(id => tagIdx[id]).filter(i => i != null));
          const neg = new Set((e.negTags || []).map(id => tagIdx[id]).filter(i => i != null));
          for (let i = 0; i < T; i++) {
            let target = -1;                       // -1 = unsupervised (skip)
            if (pos.has(i)) target = 1; else if (neg.has(i)) target = 0;
            // If this example has ANY positive tags, treat all other known tags as
            // weak negatives (target 0) so the model learns to NOT over-suggest.
            else if (pos.size > 0) target = 0;
            if (target < 0) continue;
            const pt = fwd.tagP[i];
            // weak negatives get a smaller weight than explicit pos/neg signals
            const tw = (pos.has(i) || neg.has(i)) ? w : w * 0.3;
            totalLoss += -(target * Math.log(Math.max(pt, 1e-9)) + (1 - target) * Math.log(Math.max(1 - pt, 1e-9))) * tw; totalN++;
            const d = (pt - target) * tw;
            g.bt[i] += d; const base = i * HW;
            for (let j = 0; j < HW; j++) { g.Wt[base + j] += d * hLast[j]; dLast[j] += d * m.Wt[base + j]; }
          }
        }
        // ---- backprop through the hidden stack (last layer -> first) ----
        // precompute non-zero INPUT indices once (layer 0 only touches those — the
        // input is sparse, so this is the same big win as in the forward pass).
        const inpW = m.inp || ORG_INPUT;
        const bnzi = [], bnzv = [];
        for (let k = 0; k < feat.length; k++) { const v = feat[k]; if (v) { bnzi.push(k); bnzv.push(v); } }
        let dAct = dLast;                          // dL/d(activation of current layer)
        for (let l = L - 1; l >= 0; l--) {
          const width = m.hidden[l], prevW = (l === 0) ? inpW : m.hidden[l - 1];
          const prevAct = acts[l];                 // activation feeding INTO layer l (input if l==0)
          const pre = pres[l], Wl = m.Wh[l], gW = g['Wh' + l], gB = g['bh' + l];
          const dPrev = (l > 0) ? new Float64Array(prevW) : null;
          for (let j = 0; j < width; j++) {
            if (pre[j] <= 0) continue;              // ReLU gate (dead unit -> no gradient)
            const dpre = dAct[j];
            if (dpre === 0) continue;
            gB[j] += dpre; const base = j * prevW;
            if (l === 0) {
              // layer 0: gradient only for the non-zero input features (no dPrev needed)
              for (let n = 0; n < bnzi.length; n++) gW[base + bnzi[n]] += dpre * bnzv[n];
            } else {
              for (let k = 0; k < prevW; k++) {
                const pv = prevAct[k];
                if (pv) gW[base + k] += dpre * pv;
                dPrev[k] += dpre * Wl[base + k];
              }
            }
          }
          if (dPrev) dAct = dPrev;                  // pass gradient to the previous layer
        }
      }   // end per-example loop within the batch
        // ---- ONE Adam update per batch, on the MEAN gradient (no decay on biases) ----
        if (bn === 0) continue;
        const inv = 1 / bn;
        opt.t++;
        const b1 = 0.9, b2 = 0.999, eps = 1e-8;
        const bc1 = 1 - Math.pow(b1, opt.t), bc2 = 1 - Math.pow(b2, opt.t);
        for (const k of tensorKeys) {
          const arr = tensorOf(k), gr = g[k], mo = opt.mom[k], ve = opt.vel[k];
          const decay = isBias(k) ? 0 : l2;
          for (let i = 0; i < arr.length; i++) {
            let gi = gr[i] * inv + decay * arr[i];     // mean gradient over the batch
            if (gi > 5) gi = 5; else if (gi < -5) gi = -5;
            mo[i] = b1 * mo[i] + (1 - b1) * gi;
            ve[i] = b2 * ve[i] + (1 - b2) * gi * gi;
            arr[i] -= lr * (mo[i] / bc1) / (Math.sqrt(ve[i] / bc2) + eps);
          }
        }
      }   // end batch loop
    }
    return { loss: totalLoss / Math.max(1, totalN), n: ex.length };
  }

  // Predict folder + tag suggestions for one file. Returns ranked lists of
  // { id, score } so the caller can map ids to names/paths and apply thresholds.
  function organizerPredict(m, x, opts) {
    opts = opts || {};
    orgMigrate(m);
    const fwd = organizerForward(m, orgFeatures(x || {}, m.inp || ORG_INPUT));
    const folders = [];
    for (let i = 0; i < m.folders.length; i++) folders.push({ id: m.folders[i], score: fwd.folderP[i] });
    folders.sort((a, b) => b.score - a.score);
    const tags = [];
    for (let i = 0; i < m.tags.length; i++) tags.push({ id: m.tags[i], score: fwd.tagP[i] });
    tags.sort((a, b) => b.score - a.score);
    const topFolders = clampInt(opts.topFolders, 1, 10, 3);
    const topTags = clampInt(opts.topTags, 1, 20, 5);
    return { folders: folders.slice(0, topFolders), tags: tags.slice(0, topTags) };
  }

  // Grow a model's label space in place when new folders/tags appear, WITHOUT
  // discarding what it already learned: existing rows are preserved and new
  // output rows are appended with fresh small weights. The trunk is untouched.
  // Returns true if anything changed (so the caller knows to persist).
  function organizerSync(m, folders, tags) {
    orgMigrate(m);
    let changed = false;
    const rng = mulberry32(((m.seed >>> 0) || 11) ^ 0x9e3779b1);
    const width = orgLastWidth(m);            // heads read the LAST hidden layer
    const grow = (head, bias, ids, curIds) => {
      const have = new Set(curIds);
      for (const id of ids) {
        if (have.has(id)) continue;
        const row = randMat(1, width, rng, 1 / Math.sqrt(width));
        for (let k = 0; k < width; k++) head.push(row[k]);
        bias.push(0); curIds.push(id); have.add(id); changed = true;
      }
    };
    // (We never REMOVE rows for deleted folders/tags here — stale rows just stop
    //  being suggested once the caller filters ids it no longer recognizes. The
    //  server compacts on a full retrain. Keeping them avoids reindexing weights.)
    if (folders) grow(m.Wf, m.bf, folders, m.folders);
    if (tags) grow(m.Wt, m.bt, tags, m.tags);
    return changed;
  }

  /* ============================================================
     BACKEND DISPATCH — neuralCompute({op, ...}) used by /api/neural/compute.
     Stateless: the client sends the model + data, we run a bounded chunk of work
     and return the updated model/loss/sample. Bounds keep one request off the
     event loop for long. The organizer ops are unchanged (AI Organization).
     ============================================================ */
  function neuralCompute(req) {
    const op = req && req.op;
    // ---- LLM ops (the Neural app) ----
    if (op === 'llm-tokenize') {
      const tok = tokenizerTrain(req.text || '', req.opts || {});
      return { tok, vocab: tokVocabSize(tok) };
    }
    if (op === 'llm-train') {
      const m = req.model;
      const ids = Array.isArray(req.ids) ? req.ids : tokenizerEncode(m.tok, req.text || '');
      if (!ids || ids.length < 3) throw new Error('not enough training tokens');
      const opt = req.opt || {};
      const r = llmTrainChunk(m, ids, opt);
      return { model: m, loss: r.loss };
    }
    if (op === 'llm-sample') {
      return llmSample(req.model, req.gen || {});
    }
    // ---- Organizer ops (AI Organization; unchanged) ----
    if (op === 'organizer-train') {
      const m = (req.model && req.model.type === 'organizer') ? req.model : organizerInit(req.init || {});
      const r = organizerTrain(m, Array.isArray(req.examples) ? req.examples : [], req.opt || {});
      return { model: m, loss: r.loss, n: r.n };
    }
    if (op === 'organizer-predict') {
      if (!req.model || req.model.type !== 'organizer') throw new Error('bad model');
      return organizerPredict(req.model, req.x || {}, req.opt || {});
    }
    throw new Error('unknown op: ' + op);
  }

  return {
    mulberry32, gaussian, ACT,
    // LLM (the Neural app): tokenizers + transformer
    tokenizerTrain, tokenizerEncode, tokenizerDecode, tokVocabSize,
    llmInit, llmParamCount, llmTrainChunk, llmSample, llmLogitsLast, llmForwardBackward,
    // Organizer (path C: per-user file-organization classifier) — required by server.js
    organizerInit, organizerForward, organizerTrain, organizerPredict, organizerSync,
    organizerInputDim, orgFeatures, orgTokens, fingerprintBytes, ORG_INPUT,
    // backend dispatch
    neuralCompute,
  };
});

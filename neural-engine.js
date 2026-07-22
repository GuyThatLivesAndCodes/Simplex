/* ============================================================
   NEURAL ENGINE — the math core for the Neural Network app.
   Shared, dependency-free, and isomorphic: it runs UNCHANGED in the browser
   (client compute) and in Node (backend compute, gated by can_neural_backend).
   Everything here is plain Float64 arrays + JSON-serializable model objects, so a
   model can be trained a few steps on either side and the weights handed back and
   forth or saved to the encrypted `networks` table verbatim.

   Two model families:
     • MLP  — a small multi-layer perceptron, trained by NEUROEVOLUTION. This is the
              "brain" the graph/physics sandbox (path A) drops into whatever world
              the user wires up. We evolve a population instead of backprop because
              the sandbox's reward is a black-box simulation, not a labeled dataset.
     • CHARLM — a char-level language model (embedding → GRU cell → output), trained
              by backprop/Adam on the user's uploaded text (path B). Internals are
              intentionally hidden from the user; they just upload text and chat.

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

  /* ---------- activations ---------- */
  const ACT = {
    tanh: (x) => Math.tanh(x),
    relu: (x) => (x > 0 ? x : 0),
    sigmoid: (x) => 1 / (1 + Math.exp(-x)),
    linear: (x) => x,
    sin: (x) => Math.sin(x),
  };

  /* ============================================================
     MLP — dense feed-forward net, evolved (path A: the sandbox brain)
     A genome is a flat Float64 weight vector; `mlpShape` describes the layers.
     ============================================================ */
  function mlpLayerSizes(inputs, hidden, outputs) {
    // hidden is an array like [8,8]; build [in, ...hidden, out]
    return [inputs, ...(hidden && hidden.length ? hidden : [8]), outputs];
  }
  function mlpParamCount(sizes) {
    let n = 0;
    for (let i = 0; i < sizes.length - 1; i++) n += sizes[i] * sizes[i + 1] + sizes[i + 1];   // W + b
    return n;
  }
  function mlpRandomGenome(sizes, rng) {
    const n = mlpParamCount(sizes), g = new Float64Array(n);
    for (let i = 0; i < n; i++) g[i] = gaussian(rng) * 0.6;
    return g;
  }
  // forward pass; `act` is the hidden activation name, output is tanh-bounded so the
  // sandbox gets clean [-1,1] control signals.
  function mlpForward(genome, sizes, input, act) {
    const fn = ACT[act] || ACT.tanh;
    let a = input, p = 0;
    for (let L = 0; L < sizes.length - 1; L++) {
      const inN = sizes[L], outN = sizes[L + 1], out = new Float64Array(outN);
      for (let j = 0; j < outN; j++) {
        let s = genome[p + inN * outN + j];                  // bias (stored after weights)
        for (let i = 0; i < inN; i++) s += a[i] * genome[p + i * outN + j];
        out[j] = (L === sizes.length - 2) ? Math.tanh(s) : fn(s);
      }
      p += inN * outN + outN;
      a = out;
    }
    return a;
  }
  function mlpMutate(genome, rate, scale, rng) {
    const out = new Float64Array(genome.length);
    for (let i = 0; i < genome.length; i++) out[i] = genome[i] + (rng() < rate ? gaussian(rng) * scale : 0);
    return out;
  }
  function mlpCrossover(a, b, rng) {
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = rng() < 0.5 ? a[i] : b[i];
    return out;
  }

  /* A "brain" model object is what we save/load for path A networks. */
  function makeBrain({ inputs, outputs, hidden, act, seed }) {
    const sizes = mlpLayerSizes(inputs, hidden || [10, 8], outputs);
    return { type: 'mlp', sizes, act: act || 'tanh', seed: seed >>> 0 || 1 };
  }
  // Build the next generation from ranked genomes (fittest first). Elitism keeps the
  // top few unchanged; the rest are crossover+mutation of tournament-selected parents.
  function evolveGeneration({ ranked, popSize, sizes, mutRate, mutScale, elite, seed }) {
    const rng = mulberry32(seed >>> 0 || 1);
    const next = [];
    const keep = Math.min(elite || 2, ranked.length);
    for (let i = 0; i < keep; i++) next.push(Float64Array.from(ranked[i].genome));
    const pick = () => {
      // tournament of 3 — bias toward the front of the (already sorted) list
      let best = ranked[(rng() * ranked.length) | 0];
      for (let k = 0; k < 2; k++) { const c = ranked[(rng() * ranked.length) | 0]; if (c.rank < best.rank) best = c; }
      return best.genome;
    };
    while (next.length < popSize) {
      const child = mlpCrossover(pick(), pick(), rng);
      next.push(mlpMutate(child, mutRate ?? 0.1, mutScale ?? 0.4, rng));
    }
    return next.map(g => Array.from(g));   // JSON-friendly
  }

  /* ============================================================
     CHARLM — char-level language model (path B: the text template)
     Architecture: embedding(V→E) → GRU(E→H) → linear(H→V), softmax.
     Trained with Adam on next-char prediction. Small by design so a browser tab
     (or the box) can actually train it. Internals are not surfaced to the user.
     ============================================================ */
  function zeros(n) { return new Float64Array(n); }
  function randMat(rows, cols, rng, scale) {
    const m = new Float64Array(rows * cols);
    for (let i = 0; i < m.length; i++) m[i] = gaussian(rng) * (scale ?? (1 / Math.sqrt(cols)));
    return m;
  }
  // Build the vocabulary from a corpus (unique chars, stable order).
  function buildVocab(text) {
    const seen = Object.create(null), chars = [];
    for (const ch of String(text)) if (!(ch in seen)) { seen[ch] = chars.length; chars.push(ch); }
    if (!chars.length) { chars.push('\n'); seen['\n'] = 0; }
    return { chars, stoi: seen, size: chars.length };
  }
  function charlmInit({ vocab, embed, hidden, seed }) {
    const rng = mulberry32(seed >>> 0 || 7);
    const V = vocab.size, E = embed || 24, H = hidden || 64;
    const m = { type: 'charlm', V, E, H, vocab: { chars: vocab.chars }, seed: seed >>> 0 || 7,
      Wemb: Array.from(randMat(V, E, rng, 0.4)),
      // GRU params (z, r, h gates): each maps [E+H] -> H
      Wz: Array.from(randMat(H, E + H, rng)), bz: Array.from(zeros(H)),
      Wr: Array.from(randMat(H, E + H, rng)), br: Array.from(zeros(H)),
      Wh: Array.from(randMat(H, E + H, rng)), bh: Array.from(zeros(H)),
      Wo: Array.from(randMat(V, H, rng)), bo: Array.from(zeros(V)),
    };
    return m;
  }
  function sigmoidArr(x) { const o = new Float64Array(x.length); for (let i = 0; i < x.length; i++) o[i] = 1 / (1 + Math.exp(-x[i])); return o; }
  // one GRU step: returns new hidden state + cache for backprop
  function gruStep(m, xEmb, hPrev) {
    const H = m.H, E = m.E, cat = new Float64Array(E + H);
    cat.set(xEmb, 0); cat.set(hPrev, E);
    const z = new Float64Array(H), r = new Float64Array(H), hh = new Float64Array(H), hNew = new Float64Array(H);
    for (let j = 0; j < H; j++) {
      let sz = m.bz[j], sr = m.br[j];
      const baseZ = j * (E + H);
      for (let k = 0; k < E + H; k++) { sz += m.Wz[baseZ + k] * cat[k]; sr += m.Wr[baseZ + k] * cat[k]; }
      z[j] = 1 / (1 + Math.exp(-sz)); r[j] = 1 / (1 + Math.exp(-sr));
    }
    const catH = new Float64Array(E + H); catH.set(xEmb, 0);
    for (let j = 0; j < H; j++) catH[E + j] = r[j] * hPrev[j];
    for (let j = 0; j < H; j++) {
      let sh = m.bh[j]; const baseH = j * (E + H);
      for (let k = 0; k < E + H; k++) sh += m.Wh[baseH + k] * catH[k];
      hh[j] = Math.tanh(sh);
      hNew[j] = (1 - z[j]) * hPrev[j] + z[j] * hh[j];
    }
    return { hNew, z, r, hh, cat, catH, hPrev, xEmb };
  }
  function softmax(logits) {
    let mx = -Infinity; for (let i = 0; i < logits.length; i++) if (logits[i] > mx) mx = logits[i];
    const e = new Float64Array(logits.length); let s = 0;
    for (let i = 0; i < logits.length; i++) { e[i] = Math.exp(logits[i] - mx); s += e[i]; }
    for (let i = 0; i < logits.length; i++) e[i] /= s;
    return e;
  }
  function outLogits(m, h) {
    const V = m.V, H = m.H, o = new Float64Array(V);
    for (let i = 0; i < V; i++) { let s = m.bo[i]; const base = i * H; for (let j = 0; j < H; j++) s += m.Wo[base + j] * h[j]; o[i] = s; }
    return o;
  }
  // Adam optimizer state lives alongside the model during a training session (not
  // saved — recreated on load). Train on random windows of `seqLen` from `ids`.
  function charlmTrainChunk(m, ids, opt) {
    const seqLen = Math.min(opt.seqLen || 48, Math.max(2, ids.length - 1));
    const steps = opt.steps || 20, lr = opt.lr || 0.01, H = m.H, E = m.E, V = m.V;
    const rng = mulberry32((opt.seed ?? m.seed ?? 1) + (opt.iter || 0) | 0);
    // grad accumulators reused per step
    let totalLoss = 0, totalChars = 0;
    // Adam moment buffers, lazily attached to opt
    const keys = ['Wemb', 'Wz', 'bz', 'Wr', 'br', 'Wh', 'bh', 'Wo', 'bo'];
    if (!opt.mom) { opt.mom = {}; opt.vel = {}; for (const k of keys) { opt.mom[k] = new Float64Array(m[k].length); opt.vel[k] = new Float64Array(m[k].length); } }
    opt.t = (opt.t || 0);
    for (let step = 0; step < steps; step++) {
      const start = (rng() * (ids.length - seqLen - 1)) | 0;
      // forward, caching states
      const caches = []; let h = new Float64Array(H);
      const probsArr = [], targets = [];
      for (let t = 0; t < seqLen; t++) {
        const x = ids[start + t], y = ids[start + t + 1];
        const xEmb = m.Wemb.slice(x * E, x * E + E);
        const c = gruStep(m, Float64Array.from(xEmb), h);
        const logits = outLogits(m, c.hNew);
        const p = softmax(logits);
        caches.push({ c, x, h }); probsArr.push(p); targets.push(y);
        totalLoss += -Math.log(Math.max(p[y], 1e-9)); totalChars++;
        h = c.hNew;
      }
      // backward (BPTT) — accumulate grads
      const g = {}; for (const k of keys) g[k] = new Float64Array(m[k].length);
      let dhNext = new Float64Array(H);
      for (let t = seqLen - 1; t >= 0; t--) {
        const p = probsArr[t], y = targets[t], cc = caches[t].c, x = caches[t].x;
        const dlogits = Float64Array.from(p); dlogits[y] -= 1;
        // output layer grads
        for (let i = 0; i < V; i++) { const base = i * H; const dl = dlogits[i]; g.bo[i] += dl; for (let j = 0; j < H; j++) g.Wo[base + j] += dl * cc.hNew[j]; }
        const dh = new Float64Array(H);
        for (let j = 0; j < H; j++) { let s = dhNext[j]; for (let i = 0; i < V; i++) s += dlogits[i] * m.Wo[i * H + j]; dh[j] = s; }
        // GRU backward
        const { z, r, hh, cat, catH, hPrev, xEmb } = cc;
        const dz = new Float64Array(H), dhh = new Float64Array(H), dhPrev = new Float64Array(H);
        for (let j = 0; j < H; j++) {
          dhh[j] = dh[j] * z[j] * (1 - hh[j] * hh[j]);
          dz[j] = dh[j] * (hh[j] - hPrev[j]) * z[j] * (1 - z[j]);
          dhPrev[j] += dh[j] * (1 - z[j]);
        }
        // Wh / bh
        const dcatH = new Float64Array(E + H);
        for (let j = 0; j < H; j++) { const base = j * (E + H); g.bh[j] += dhh[j]; for (let k = 0; k < E + H; k++) { g.Wh[base + k] += dhh[j] * catH[k]; dcatH[k] += dhh[j] * m.Wh[base + k]; } }
        const dr = new Float64Array(H);
        for (let j = 0; j < H; j++) { dr[j] = dcatH[E + j] * hPrev[j] * r[j] * (1 - r[j]); dhPrev[j] += dcatH[E + j] * r[j]; }
        // Wz / bz, Wr / br
        const dcat = new Float64Array(E + H);
        for (let j = 0; j < H; j++) { const base = j * (E + H); g.bz[j] += dz[j]; g.br[j] += dr[j]; for (let k = 0; k < E + H; k++) { g.Wz[base + k] += dz[j] * cat[k]; g.Wr[base + k] += dr[j] * cat[k]; dcat[k] += dz[j] * m.Wz[base + k] + dr[j] * m.Wr[base + k]; } }
        for (let k = 0; k < E; k++) dcat[k] += dcatH[k];   // embedding grad path
        for (let j = 0; j < H; j++) dhNext[j] = dhPrev[j] + dcat[E + j];
        // embedding grad
        for (let k = 0; k < E; k++) g.Wemb[x * E + k] += dcat[k];
      }
      // Adam update
      opt.t++;
      const b1 = 0.9, b2 = 0.999, eps = 1e-8;
      const bc1 = 1 - Math.pow(b1, opt.t), bc2 = 1 - Math.pow(b2, opt.t);
      for (const k of keys) {
        const arr = m[k], gr = g[k], mo = opt.mom[k], ve = opt.vel[k];
        for (let i = 0; i < arr.length; i++) {
          let gi = gr[i]; if (gi > 5) gi = 5; else if (gi < -5) gi = -5;   // grad clip
          mo[i] = b1 * mo[i] + (1 - b1) * gi;
          ve[i] = b2 * ve[i] + (1 - b2) * gi * gi;
          arr[i] -= lr * (mo[i] / bc1) / (Math.sqrt(ve[i] / bc2) + eps);
        }
      }
    }
    return { loss: totalLoss / Math.max(1, totalChars) };
  }
  // Sample text from a trained model. temperature>0; topK optional.
  function charlmSample(m, { prompt, length, temperature, topK, seed }) {
    const E = m.E, H = m.H, V = m.V, stoi = Object.create(null);
    m.vocab.chars.forEach((c, i) => stoi[c] = i);
    const rng = mulberry32((seed ?? Date.now()) >>> 0 || 3);
    const temp = Math.max(0.05, temperature ?? 0.9);
    let h = new Float64Array(H), out = '';
    const seed0 = String(prompt || '\n');
    let lastId = stoi[seed0[seed0.length - 1]] ?? 0;
    // warm the hidden state on the prompt
    for (let i = 0; i < seed0.length; i++) {
      const id = stoi[seed0[i]]; if (id == null) continue;
      const xEmb = Float64Array.from(m.Wemb.slice(id * E, id * E + E));
      h = gruStep(m, xEmb, h).hNew; lastId = id;
    }
    const N = Math.min(length || 200, 2000);
    for (let i = 0; i < N; i++) {
      const xEmb = Float64Array.from(m.Wemb.slice(lastId * E, lastId * E + E));
      const c = gruStep(m, xEmb, h); h = c.hNew;
      let logits = outLogits(m, h);
      for (let k = 0; k < V; k++) logits[k] /= temp;
      let probs = softmax(logits);
      if (topK && topK < V) {
        const idx = Array.from(probs.keys()).sort((a, b) => probs[b] - probs[a]).slice(0, topK);
        const mask = new Float64Array(V); let s = 0;
        for (const k of idx) { mask[k] = probs[k]; s += probs[k]; }
        for (let k = 0; k < V; k++) probs[k] = mask[k] / (s || 1);
      }
      // sample
      let rv = rng(), acc = 0, pick = V - 1;
      for (let k = 0; k < V; k++) { acc += probs[k]; if (rv <= acc) { pick = k; break; } }
      out += m.vocab.chars[pick];
      lastId = pick;
    }
    return out;
  }
  function encodeIds(text, chars) {
    const stoi = Object.create(null); chars.forEach((c, i) => stoi[c] = i);
    const ids = []; for (const ch of String(text)) { const id = stoi[ch]; if (id != null) ids.push(id); }
    return ids;
  }

  /* ============================================================
     ACTOR LAB — a 2D actor engine with a per-actor node graph (path A, advanced)
     The user authors ACTOR TYPES (Agent, Wall, Obstacle, …). Each type has:
       • custom variables (name -> initial number)
       • a physics body (dynamic / static / none) sized w x h
       • optionally a BRAIN: a shared MLP for all instances of that type, with the
         user declaring its inputs (fed by BrainInput nodes) and outputs (read by
         BrainOutput nodes). One brain per agent type; evolved by neuroevolution.
       • a GRAPH that runs every tick: nodes wired by edges. Pull-based evaluation
         from the "sink" nodes (SetVar / actions / reward).
     A MAP places instances of those types at positions. An episode simulates the
     whole map for maxTicks; total reward (from AddReward nodes) is the fitness.

     The node catalog (type -> behavior) is small but composable:
       events:  onTick (always), onHit(typeName) (fires the tick a collision with
                that type happens; exposes that collision as a gate = 1/0)
       value:   const, getVar(var), brainOut(i), raycast(angle) -> distance,
                rayHitType(angle,typeName) -> 1/0, self(x|y|vx|vy via vars)
       math:    add, sub, mul, div, neg, min, max, abs, sin, cos, clamp, gt, lt, ifte
       sinks:   setVar(var)=in, addReward=in, brainIn(i)=in (feeds the brain),
                destroy=gate, impulse(axis=x|y)=in (adds to vx/vy)
     Everything is plain JSON so a whole lab round-trips through the networks table
     and the backend compute endpoint unchanged.
     ============================================================ */

  /* Pin/edge model (v2): every edge is { from, fromPort, to, toPort }.
       • EXEC (action) flow: white wires. An edge with toPort 'exec' / fromPort
         'exec'|'true'|'false' threads control through the action nodes in order.
       • DATA flow: typed wires (number=green, bool=red, brain=violet). A data
         edge feeds a node's input port (a/b/in/cond/…) from another node's 'out'.
     Data nodes (const/bool/getVar/self/brainOut/raycast/math/compare) are PURE —
     no exec pins; they're pulled on demand by evalNode. Action nodes (setVar/
     impulse/addReward/brainIn/destroy/branch + the event nodes) carry exec pins
     and run only when the exec chain reaches them. */

  // Evaluate one DATA node's value, memoized per tick. Pulls its data inputs.
  function evalNode(graph, nodeId, ctx) {
    if (nodeId == null) return 0;
    if (ctx.cache[nodeId] !== undefined) return ctx.cache[nodeId];
    ctx.cache[nodeId] = 0;                          // cycle guard (default 0)
    if (ctx.depth > 256) return 0; ctx.depth++;
    const n = ctx.byId[nodeId]; let out = 0;
    if (n) {
      const inv = (port) => { const e = ctx.inEdge(nodeId, port); return e ? evalNode(graph, e.from, ctx) : 0; };
      switch (n.t) {
        case 'const': out = +n.v || 0; break;
        case 'bool': out = n.v ? 1 : 0; break;
        case 'getVar': out = ctx.actor.vars[n.var] ?? 0; break;
        case 'brainOut': out = ctx.brainOut[n.i | 0] ?? 0; break;
        case 'raycast': out = ctx.ray(n.angle || 0).dist; break;
        case 'rayHitType': out = ctx.ray(n.angle || 0).type === n.typeName ? 1 : 0; break;
        case 'self': out = n.field === 'x' ? ctx.actor.x : n.field === 'y' ? ctx.actor.y : n.field === 'vx' ? (ctx.actor.vars.velX || 0) : (ctx.actor.vars.velY || 0); break;
        case 'onHitTest': out = ctx.hitTypes.has(n.typeName) ? 1 : 0; break;   // data: "am I touching type?"
        case 'add': out = inv('a') + inv('b'); break;
        case 'sub': out = inv('a') - inv('b'); break;
        case 'mul': out = inv('a') * inv('b'); break;
        case 'div': { const b = inv('b'); out = b ? inv('a') / b : 0; break; }
        case 'neg': out = -inv('a'); break;
        case 'min': out = Math.min(inv('a'), inv('b')); break;
        case 'max': out = Math.max(inv('a'), inv('b')); break;
        case 'abs': out = Math.abs(inv('a')); break;
        case 'sin': out = Math.sin(inv('a')); break;
        case 'cos': out = Math.cos(inv('a')); break;
        case 'clamp': out = Math.max(inv('lo'), Math.min(inv('hi'), inv('a'))); break;
        case 'gt': out = inv('a') > inv('b') ? 1 : 0; break;
        case 'lt': out = inv('a') < inv('b') ? 1 : 0; break;
        case 'eq': out = inv('a') === inv('b') ? 1 : 0; break;
        case 'and': out = (inv('a') && inv('b')) ? 1 : 0; break;
        case 'or': out = (inv('a') || inv('b')) ? 1 : 0; break;
        case 'not': out = inv('a') ? 0 : 1; break;
        case 'ifte': out = inv('c') ? inv('a') : inv('b'); break;
        default: out = 0;
      }
    }
    if (!Number.isFinite(out)) out = 0;
    ctx.cache[nodeId] = out; ctx.depth--;
    return out;
  }

  // Walk the EXEC chain from an event node, running each action node in order.
  // `effects` collects side-effects (reward, brain-input writes) for the caller.
  function runExecChain(graph, startId, ctx, effects) {
    let id = ctx.execOut(startId, 'exec'), guard = 0;
    while (id != null && guard++ < 512) {
      const n = ctx.byId[id]; if (!n) break;
      const inv = (port) => { const e = ctx.inEdge(id, port); return e ? evalNode(graph, e.from, ctx) : 0; };
      let nextPort = 'exec';
      switch (n.t) {
        case 'branch': nextPort = inv('cond') ? 'true' : 'false'; break;
        case 'setVar': ctx.actor.vars[n.var] = inv('value'); break;
        case 'impulse': if (n.axis === 'y') ctx.actor.vars.velY = (ctx.actor.vars.velY || 0) + inv('value'); else ctx.actor.vars.velX = (ctx.actor.vars.velX || 0) + inv('value'); break;
        case 'addReward': effects.reward += inv('value'); break;
        case 'brainIn': effects.brainIn[n.i | 0] = inv('value'); break;
        case 'destroy': ctx.actor.alive = false; return;
        default: break;
      }
      id = ctx.execOut(id, nextPort);
    }
  }

  // Run the whole map for one episode. `lab` is the document; `brains` maps an
  // actor-type id -> genome (Float64Array) for agent types. Returns total reward.
  function actorLabEpisode(lab, brains, opts) {
    const world = lab.world || { w: 600, h: 400, maxTicks: 360 };
    const W = world.w || 600, H = world.h || 400, maxT = clampInt(world.maxTicks, 30, 2000, 360);
    (lab.actorTypes || []).forEach(t => { if (t.graph) migrateActorGraph(t.graph); });   // tolerate v1 graphs
    const typeById = {}; (lab.actorTypes || []).forEach(t => typeById[t.id] = t);
    // spawn instances
    let actors = (lab.instances || []).map((inst, idx) => {
      const T = typeById[inst.typeId]; if (!T) return null;
      const vars = {}; (T.vars || []).forEach(v => vars[v.name] = +v.init || 0);
      return { id: 'a' + idx, type: T, x: inst.x, y: inst.y, w: (T.body && T.body.w) || 24, h: (T.body && T.body.h) || 24, vars, alive: true, hitTypes: new Set() };
    }).filter(Boolean);
    // precompute brain shapes
    const brainSizes = {};
    for (const T of lab.actorTypes || []) if (T.brain && T.brain.inputs && T.brain.outputs && T.brain.outputs.length) brainSizes[T.id] = mlpLayerSizes(Math.max(1, T.brain.inputs.length), T.brain.hidden || [8], T.brain.outputs.length);
    let reward = 0;
    // A ray sweeps from the actor along (its heading + angleDeg) until it hits a
    // solid actor or the world edge. Returns the normalized distance + hit type +
    // the world-space endpoint (for the "Visible Raycasts" overlay during playback).
    const raycastFrom = (actor, angleDeg) => {
      const ang = (angleDeg || 0) * Math.PI / 180; const ca = Math.cos(ang), sa = Math.sin(ang);
      const max = 260, step = 7;
      for (let r = step; r < max; r += step) {
        const px = actor.x + ca * r, py = actor.y + sa * r;
        if (px < 0 || px > W || py < 0 || py > H) return { dist: r / max, type: '__edge', ex: px, ey: py, hit: true };
        for (const o of actors) { if (o === actor || !o.alive || (o.type.body && o.type.body.mode === 'none')) continue; if (px > o.x - o.w / 2 && px < o.x + o.w / 2 && py > o.y - o.h / 2 && py < o.y + o.h / 2) return { dist: r / max, type: o.type.name, ex: px, ey: py, hit: true }; }
      }
      return { dist: 1, type: '', ex: actor.x + ca * max, ey: actor.y + sa * max, hit: false };
    };
    const recording = !!(opts && opts.record);
    for (let tick = 0; tick < maxT; tick++) {
      // 1) compute brain outputs per agent instance. Brain INPUTS come from the
      //    exec chain (brainIn nodes write effects.brainIn), but the brain must run
      //    BEFORE the chain so brainOut nodes have values. We resolve this by
      //    gathering brain inputs via a pre-pass: run the exec chain in "input
      //    mode" (only brainIn writes take effect, brainOut reads as 0), feed the
      //    brain, then run the real chain with brainOut available.
      for (const actor of actors) {
        if (!actor.alive) continue;
        const T = actor.type;
        actor.brainOut = [];
        if (T.brain && brainSizes[T.id] && brains[T.id]) {
          const ctxIn = makeCtx(T.graph, actor, [], actors, raycastFrom, world);
          const pre = { reward: 0, brainIn: {} };
          for (const ev of eventNodes(T.graph, tick, actor)) runExecChain(T.graph, ev, ctxIn, pre);
          const nIn = (T.brain.inputs || []).length || 1;
          const inputs = []; for (let i = 0; i < nIn; i++) inputs.push(pre.brainIn[i] || 0);
          actor.brainOut = Array.from(mlpForward(brains[T.id], brainSizes[T.id], Float64Array.from(inputs), T.brain.act || 'tanh'));
        }
      }
      // 2) run each actor's exec chain for real (brainOut now available) — applies
      //    setVar / impulse / addReward / destroy along the white wire from events.
      if (recording) for (const a of actors) a._recRays = [];   // keep only THIS pass's rays for the overlay
      for (const actor of actors) {
        if (!actor.alive) continue;
        const T = actor.type, g = T.graph || { nodes: [], edges: [] };
        const ctx = makeCtx(g, actor, actor.brainOut, actors, raycastFrom, world);
        const eff = { reward: 0, brainIn: {} };
        for (const ev of eventNodes(g, tick, actor)) { if (!actor.alive) break; runExecChain(g, ev, ctx, eff); }
        reward += eff.reward;
      }
      // 3) integrate motion from velX/velY (dynamic bodies only), reset per-tick hit sets
      for (const actor of actors) {
        actor.hitTypes = new Set();
        if (!actor.alive) continue;
        const mode = actor.type.body ? actor.type.body.mode : 'none';
        if (mode === 'dynamic') {
          actor.x += (actor.vars.velX || 0); actor.y += (actor.vars.velY || 0);
          if (actor.x < actor.w / 2) { actor.x = actor.w / 2; actor.vars.velX = 0; }
          if (actor.x > W - actor.w / 2) { actor.x = W - actor.w / 2; actor.vars.velX = 0; }
          if (actor.y < actor.h / 2) { actor.y = actor.h / 2; actor.vars.velY = 0; }
          if (actor.y > H - actor.h / 2) { actor.y = H - actor.h / 2; actor.vars.velY = 0; }
        }
      }
      // 4) collision detection (AABB) — record hit types; push dynamic out of solids
      for (let i = 0; i < actors.length; i++) {
        const A = actors[i]; if (!A.alive || !A.type.body || A.type.body.mode === 'none') continue;
        for (let j = 0; j < actors.length; j++) {
          if (i === j) continue; const B = actors[j]; if (!B.alive || !B.type.body || B.type.body.mode === 'none') continue;
          if (Math.abs(A.x - B.x) < (A.w + B.w) / 2 && Math.abs(A.y - B.y) < (A.h + B.h) / 2) {
            A.hitTypes.add(B.type.name);
            if (A.type.body.mode === 'dynamic' && B.type.body.mode === 'static') {
              // resolve along the least-overlap axis
              const ox = (A.w + B.w) / 2 - Math.abs(A.x - B.x), oy = (A.h + B.h) / 2 - Math.abs(A.y - B.y);
              if (ox < oy) { A.x += A.x < B.x ? -ox : ox; A.vars.velX = 0; } else { A.y += A.y < B.y ? -oy : oy; A.vars.velY = 0; }
            }
          }
        }
      }
      if (opts && opts.record) opts.record(tick, actors, reward);
    }
    return { reward, actors };
  }
  // a lightweight per-evaluation context (edge lookups + raycast + cache)
  function makeCtx(graph, actor, brainOut, actors, raycastFrom, world) {
    const byId = {}; (graph.nodes || []).forEach(n => byId[n.id] = n);
    const edges = graph.edges || [];
    const rayCache = {};
    return {
      byId, actor, brainOut: brainOut || [], world, cache: {}, depth: 0,
      hitTypes: actor.hitTypes || new Set(),
      // a DATA input edge into (toId, toPort)
      inEdge: (toId, port) => edges.find(e => e.to === toId && (e.toPort || e.port || 'in') === port),
      // follow an EXEC wire out of (fromId, fromPort) -> the next node id
      execOut: (fromId, fromPort) => { const e = edges.find(e => e.from === fromId && (e.fromPort || 'exec') === fromPort && (e.toPort || 'exec') === 'exec'); return e ? e.to : null; },
      ray: (angle) => {
        const key = angle | 0;
        if (rayCache[key]) return rayCache[key];
        const res = rayCache[key] = raycastFrom(actor, angle);
        // when recording (playback), remember every ray this actor casts this tick
        // so the "Visible Raycasts" overlay can draw them. Cheap; off otherwise.
        if (actor._recRays) actor._recRays.push({ x: actor.x, y: actor.y, ex: res.ex, ey: res.ey, hit: res.hit });
        return res;
      },
    };
  }
  // which event nodes fire this tick for this actor: onTick always; onSpawn on
  // tick 0; onHit when the actor collided with the node's chosen type this tick.
  function eventNodes(graph, tick, actor) {
    const out = [];
    for (const n of graph.nodes || []) {
      if (n.t === 'onTick') out.push(n.id);
      else if (n.t === 'onSpawn' && tick === 0) out.push(n.id);
      else if (n.t === 'onHit' && actor.hitTypes && actor.hitTypes.has(n.typeName)) out.push(n.id);
    }
    return out;
  }
  // Migrate a v1 (sink-style, no exec wires) graph to v2 (exec flow). Detect v1 by
  // the absence of any exec edge and presence of legacy 'gate'/'in' ports. We thread
  // an On Tick -> [all sink nodes] exec chain, remap legacy data ports, and convert
  // the old data-driven 'destroy'/gates into a best-effort branch-free chain.
  function migrateActorGraph(g) {
    if (!g || !Array.isArray(g.nodes)) return g;
    const edges = g.edges || [];
    const hasExec = edges.some(e => (e.toPort || e.port) === 'exec' || (e.fromPort && e.fromPort !== 'out'));
    const looksV1 = edges.some(e => { const p = e.toPort || e.port || 'in'; return p === 'gate' || p === 'in'; }) || g.nodes.some(n => ['setVar', 'impulse', 'addReward', 'brainIn', 'destroy'].includes(n.t));
    if (hasExec || !looksV1) { return g; }   // already v2 (or empty) — leave alone
    // remap legacy data ports: setVar/impulse/addReward/brainIn used 'in' -> 'value'
    const newEdges = [];
    for (const e of edges) {
      const p = e.toPort || e.port || 'in';
      if (p === 'gate') continue;                                   // gates become exec ordering; drop the data gate
      const toPort = (p === 'in') ? 'value' : p;
      newEdges.push({ from: e.from, fromPort: e.fromPort || 'out', to: e.to, toPort });
    }
    // ensure an On Tick node exists
    let tickNode = g.nodes.find(n => n.t === 'onTick');
    if (!tickNode) { tickNode = { id: 'evtick', t: 'onTick', x: 20, y: 20 }; g.nodes.unshift(tickNode); }
    // thread exec: onTick -> each action node in node order
    const SINKS = new Set(['setVar', 'impulse', 'addReward', 'brainIn', 'destroy', 'branch']);
    const sinks = g.nodes.filter(n => SINKS.has(n.t));
    let prev = tickNode.id;
    for (const s of sinks) { newEdges.push({ from: prev, fromPort: 'exec', to: s.id, toPort: 'exec' }); prev = s.id; }
    g.edges = newEdges;
    return g;
  }

  // Evolve per-agent-type brains for one generation. `pops` maps typeId -> array
  // of genomes; we evaluate each candidate set, rank, and breed. To keep it simple
  // and fast we co-evolve: index k uses genome[k] from every type's population.
  function actorLabEvolve(lab, pops, cfg) {
    const agentTypes = (lab.actorTypes || []).filter(T => T.brain && T.brain.outputs && T.brain.outputs.length);
    const popSize = clampInt(cfg.pop, 2, 200, 30);
    const sizesByType = {};
    for (const T of agentTypes) sizesByType[T.id] = mlpLayerSizes(Math.max(1, (T.brain.inputs || []).length), T.brain.hidden || [8], T.brain.outputs.length);
    // ensure populations exist + correct length
    for (const T of agentTypes) {
      const want = mlpParamCount(sizesByType[T.id]);
      if (!pops[T.id] || !pops[T.id].length || pops[T.id][0].length !== want) {
        const rng = mulberry32(((cfg.seed || 1) ^ hashStr(T.id)) >>> 0);
        pops[T.id] = []; for (let i = 0; i < popSize; i++) pops[T.id].push(Array.from(mlpRandomGenome(sizesByType[T.id], rng)));
      }
    }
    // evaluate each candidate index
    const fits = new Array(popSize).fill(0);
    for (let k = 0; k < popSize; k++) {
      const brains = {}; for (const T of agentTypes) brains[T.id] = Float64Array.from(pops[T.id][k]);
      fits[k] = actorLabEpisode(lab, brains, null).reward;
    }
    const order = fits.map((f, k) => ({ f, k })).sort((a, b) => b.f - a.f);
    const bestFit = order.length ? order[0].f : 0, bestK = order.length ? order[0].k : 0;
    // breed each type independently using the same ranking
    const rng = mulberry32(((cfg.seed || 1) + 7) >>> 0);
    const nextPops = {};
    for (const T of agentTypes) {
      const ranked = order.map(o => ({ genome: Float64Array.from(pops[T.id][o.k]) }));
      const next = [];
      const keep = Math.min(clampInt(cfg.elite, 0, 50, 2), ranked.length);
      for (let i = 0; i < keep; i++) next.push(Array.from(ranked[i].genome));
      const pick = () => { let best = ranked[(rng() * ranked.length) | 0], bi = ranked.indexOf(best); for (let z = 0; z < 2; z++) { const ci = (rng() * ranked.length) | 0; if (ci < bi) { best = ranked[ci]; bi = ci; } } return best.genome; };
      while (next.length < popSize) next.push(Array.from(mlpMutate(mlpCrossover(pick(), pick(), rng), cfg.mutRate ?? 0.12, cfg.mutScale ?? 0.4, rng)));
      nextPops[T.id] = next;
    }
    const bestBrains = {}; for (const T of agentTypes) bestBrains[T.id] = pops[T.id][bestK];
    return { pops: nextPops, bestFit, best: bestBrains };
  }
  function hashStr(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

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
     event loop for long (the LLM steps are capped; evolution is per-generation).
     ============================================================ */
  function clampInt(v, lo, hi, d) { v = Math.floor(Number(v)); if (!Number.isFinite(v)) v = d; return Math.max(lo, Math.min(hi, v)); }

  function neuralCompute(req) {
    const op = req && req.op;
    if (op === 'charlm-train') {
      const m = hydrateCharlm(req.model);
      const ids = Array.isArray(req.ids) ? req.ids : encodeIds(req.text || '', m.vocab.chars);
      if (ids.length < 3) throw new Error('not enough training text');
      const opt = req.opt || {};
      opt.steps = clampInt(opt.steps, 1, 200, 20);
      opt.seqLen = clampInt(opt.seqLen, 4, 128, 48);
      const r = charlmTrainChunk(m, ids, opt);
      return { model: dehydrateCharlm(m), loss: r.loss };
    }
    if (op === 'charlm-sample') {
      const m = hydrateCharlm(req.model);
      return { text: charlmSample(m, req.gen || {}) };
    }
    if (op === 'evolve') {
      const next = evolveGeneration({
        ranked: (req.ranked || []).map((g, i) => ({ genome: Float64Array.from(g.genome || g), rank: g.rank ?? i })),
        popSize: clampInt(req.popSize, 2, 500, 40),
        sizes: req.sizes, mutRate: req.mutRate, mutScale: req.mutScale,
        elite: clampInt(req.elite, 0, 50, 2), seed: req.seed >>> 0 || 1,
      });
      return { population: next };
    }
    if (op === 'actorlab-evolve') {
      if (!req.lab || !Array.isArray(req.lab.actorTypes)) throw new Error('bad lab');
      const r = actorLabEvolve(req.lab, req.pops || {}, req.cfg || {});
      return { pops: r.pops, bestFit: r.bestFit, best: r.best };
    }
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
  // model arrays come over JSON as plain arrays; keep them as arrays (the math
  // indexes them fine) — only ensure shape fields exist.
  function hydrateCharlm(model) {
    if (!model || model.type !== 'charlm') throw new Error('bad model');
    return model;
  }
  function dehydrateCharlm(m) { return m; }

  return {
    mulberry32, gaussian, ACT,
    // MLP / evolution (path A)
    mlpLayerSizes, mlpParamCount, mlpRandomGenome, mlpForward, mlpMutate, mlpCrossover,
    makeBrain, evolveGeneration,
    // CharLM (path B)
    buildVocab, charlmInit, charlmTrainChunk, charlmSample, encodeIds, gruStep, outLogits, softmax,
    // Actor Lab (path A advanced)
    actorLabEpisode, actorLabEvolve, evalNode, migrateActorGraph,
    // Organizer (path C: per-user file-organization classifier)
    organizerInit, organizerForward, organizerTrain, organizerPredict, organizerSync,
    organizerInputDim, orgFeatures, orgTokens, fingerprintBytes, ORG_INPUT,
    // backend dispatch
    neuralCompute,
  };
});

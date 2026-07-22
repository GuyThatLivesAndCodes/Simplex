/* ============================================================
   NEURAL NETWORK APP — frontend controller
   Two ways to build a network, both saved to the encrypted `networks` table so
   work is never lost (autosaved while you train + an explicit Save):

     A. GRAPH SANDBOX — a node graph wired over a 2D physics world the user builds
        themselves (bodies, sensors, actuators, a fitness expression). An MLP
        "brain" reads the sensors and drives the actuators; it's trained by
        neuroevolution against the user's fitness. No prebuilt "car"/"physics"
        templates — you wire up whatever world you want.

     B. TEXT MODEL — an upload-and-train char-level language model (path B). You
        feed it text (pre-training + fine-tuning), it trains, and you chat with it.
        The internals are deliberately hidden; you just get a model that talks.

   Compute runs CLIENT-side (in this tab) by default. If the account has backend
   compute enabled (can_neural_backend), each network can be flipped to run on the
   SERVER instead. The math itself lives in neural-engine.js (window.NeuralEngine),
   shared verbatim with the backend.
   ============================================================ */

const NE = (typeof window !== 'undefined' && window.NeuralEngine) || null;
let _nnNetworks = [];          // {id, kind, name, updated} list
let _nnCaps = { backend: false };
let _nnDoc = null;             // the open network document (full data)
let _nnId = null;              // open network id
let _nnView = 'home';          // 'home' | 'graph' | 'llm'
let _nnDirty = false, _nnSaveTimer = null, _nnTraining = false, _nnStop = false;

function nnUid() { return (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)); }

/* ---------- entry ---------- */
function neuralHTML() {
  return `<div class="nn-app" id="nnApp"><div class="dim mono pad-sm">Loading…</div></div>`;
}
async function wireNeural() {
  _nnView = 'home'; _nnDoc = null; _nnId = null; _nnDirty = false; _nnTraining = false;
  // training loops + autosave must stop when leaving the app or switching networks
  _appCleanup = () => { _nnStop = true; _nnTraining = false; clearTimeout(_nnSaveTimer); flushNeuralSave(); };
  if (!NE) {
    document.getElementById('nnApp').innerHTML = `<div class="nn-empty"><div class="ico">${svg('brain', 40, 1.4)}</div><p>The neural engine failed to load.<br><span class="mono dim">Reload the page to try again.</span></p></div>`;
    return;
  }
  try { _nnCaps = await neuralCaps(); } catch (e) { _nnCaps = { backend: false }; }
  await refreshNeuralList();
}
async function refreshNeuralList() {
  try { _nnNetworks = await listNetworks(); } catch (e) { if (e && e.code === 'AUTH') return relock(); _nnNetworks = []; }
  if (_nnView === 'home') renderNeuralHome();
}

/* ---------- home: saved networks + create cards ---------- */
function renderNeuralHome() {
  _nnView = 'home'; _nnDoc = null; _nnId = null;
  const app = document.getElementById('nnApp'); if (!app) return;
  const list = _nnNetworks.length ? `
    <div class="nn-saved">
      <span class="eyebrow">Your networks</span>
      <div class="nn-card-grid">
        ${_nnNetworks.map(nnSavedCardHTML).join('')}
      </div>
    </div>` : `<div class="nn-saved"><span class="eyebrow">Your networks</span><div class="nn-none mono dim">No networks yet — create one below. Everything you build is saved to your encrypted vault.</div></div>`;
  app.innerHTML = `
    <div class="nn-home">
      <div class="nn-hero">
        <div class="nn-hero-ico bg-audio t-audio">${svg('brain', 30, 1.6)}</div>
        <div class="nn-hero-txt">
          <div class="nn-hero-h">Neural Networks</div>
          <div class="nn-hero-s mono">Build a network, train it, and run it — saved safely to your vault.</div>
        </div>
        <div class="nn-compute-note mono ${_nnCaps.backend ? 'on' : ''}">${_nnCaps.backend ? svg('check', 13) + ' Backend compute enabled' : svg('info', 13) + ' Client-only compute'}</div>
      </div>
      <div class="nn-new">
        <span class="eyebrow">Create new</span>
        <div class="nn-new-grid">
          <button class="nn-new-card feature" data-new="actorlab">
            <span class="nnc-ico bg-audio t-audio">${svg('grid', 24, 1.6)}</span>
            <span class="nnc-h">Actor Lab</span>
            <span class="nnc-s">Design your own 2D world like a game engine: build actor types (agents, walls, obstacles…), give each a node graph for its per-tick logic, AI inputs/outputs, physics &amp; raycasts — then place them on a map and evolve the agents.</span>
            <span class="nnc-go">Create ${svg('back', 12, 2)}</span>
          </button>
          <button class="nn-new-card" data-new="graph">
            <span class="nnc-ico bg-audio t-audio">${svg('refresh', 24, 1.6)}</span>
            <span class="nnc-h">Quick Sandbox</span>
            <span class="nnc-s">The simple version — a fixed agent &amp; target, pick sensors and a fitness rule, and it evolves. Great for a fast first network.</span>
            <span class="nnc-go">Build ${svg('back', 12, 2)}</span>
          </button>
          <button class="nn-new-card" data-new="llm">
            <span class="nnc-ico bg-document t-document">${svg('note', 24, 1.6)}</span>
            <span class="nnc-h">Text Model</span>
            <span class="nnc-s">Upload text to pre-train &amp; fine-tune a language model, then chat with it. A GPT-style model — the internals stay under the hood.</span>
            <span class="nnc-go">Train ${svg('back', 12, 2)}</span>
          </button>
        </div>
      </div>
      ${list}
    </div>`;
  app.querySelectorAll('[data-new]').forEach(b => b.onclick = () => newNetwork(b.dataset.new));
  app.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openNetwork(b.dataset.open));
  app.querySelectorAll('[data-del]').forEach(b => b.onclick = (e) => { e.stopPropagation(); removeNetwork(b.dataset.del); });
}
function nnSavedCardHTML(n) {
  const meta = { llm: { ico: 'note', tint: 'document', label: 'Text model' }, actorlab: { ico: 'grid', tint: 'audio', label: 'Actor Lab' }, graph: { ico: 'refresh', tint: 'audio', label: 'Quick sandbox' } }[n.kind] || { ico: 'grid', tint: 'audio', label: 'Network' };
  return `<div class="nn-saved-card" data-open="${n.id}">
    <span class="nsc-ico bg-${meta.tint} t-${meta.tint}">${svg(meta.ico, 18, 1.7)}</span>
    <span class="nsc-main">
      <span class="nsc-name">${esc(n.name)}</span>
      <span class="nsc-sub mono">${meta.label} · ${fmtDate(n.updated)}</span>
    </span>
    <button class="nsc-del" data-del="${n.id}" title="Delete">${svg('trash', 14)}</button>
  </div>`;
}

/* ---------- create / open / delete / persistence ---------- */
function freshDocFor(kind) { return kind === 'llm' ? freshLlmDoc() : kind === 'actorlab' ? freshActorDoc() : freshGraphDoc(); }
function openEditorFor(kind) { if (kind === 'llm') openLlmEditor(); else if (kind === 'actorlab') openActorEditor(); else openGraphEditor(); }
async function newNetwork(kind) {
  const name = kind === 'llm' ? 'New text model' : kind === 'actorlab' ? 'New lab' : 'New sandbox';
  const data = freshDocFor(kind);
  try {
    const n = await createNetwork({ kind, name, data });
    await refreshNeuralList();
    openNetwork(n.id);
  } catch (e) { toast('Could not create network', 'close'); }
}
async function openNetwork(id) {
  await flushNeuralSave();
  let net; try { net = await getNetwork(id); } catch (e) { toast('Could not open network', 'close'); return; }
  _nnId = id; _nnDoc = net.data || freshDocFor(net.kind);
  _nnDoc.__name = net.name; _nnDoc.__kind = net.kind;
  _nnStop = false; _nnDirty = false;
  openEditorFor(net.kind);
}
async function removeNetwork(id) {
  const n = _nnNetworks.find(x => x.id === id);
  if (!confirm(`Delete "${n ? n.name : 'this network'}"? This permanently removes the saved model.`)) return;
  try { await deleteNetwork(id); } catch (e) {}
  if (_nnId === id) { _nnId = null; _nnDoc = null; }
  await refreshNeuralList();
  toast('Network deleted', 'trash');
}
function markNeuralDirty() {
  _nnDirty = true;
  const st = document.getElementById('nnSaveStatus'); if (st) { st.textContent = 'unsaved…'; st.classList.remove('saved'); }
  clearTimeout(_nnSaveTimer); _nnSaveTimer = setTimeout(flushNeuralSave, 1500);
}
async function flushNeuralSave() {
  if (!_nnDirty || !_nnId || !_nnDoc) return;
  _nnDirty = false;
  const payload = { ...(_nnDoc) }; delete payload.__name; delete payload.__kind;
  try {
    await updateNetwork(_nnId, { name: _nnDoc.__name || 'Untitled network', data: payload });
    const st = document.getElementById('nnSaveStatus'); if (st) { st.textContent = 'saved'; st.classList.add('saved'); }
    const i = _nnNetworks.findIndex(x => x.id === _nnId); if (i >= 0) { _nnNetworks[i].name = _nnDoc.__name; _nnNetworks[i].updated = Date.now(); }
  } catch (e) {
    _nnDirty = true;   // keep trying
    const st = document.getElementById('nnSaveStatus'); if (st) { st.textContent = (e && e.status === 413) ? 'too large to save' : 'save failed'; st.classList.remove('saved'); }
  }
}
async function saveNeuralNow() {
  _nnDirty = true; clearTimeout(_nnSaveTimer);
  const st = document.getElementById('nnSaveStatus'); if (st) st.textContent = 'saving…';
  await flushNeuralSave();
  if (!_nnDirty) toast('Saved to your vault', 'save');
}

/* shared editor chrome: back button, name field, compute toggle, save status */
function nnEditorBar(extraHTML) {
  const backendOpt = _nnCaps.backend
    ? `<button type="button" data-compute="backend" class="${_nnDoc.compute === 'backend' ? 'on' : ''}">Backend</button>`
    : `<button type="button" disabled title="Ask an admin to enable backend compute for your account">Backend 🔒</button>`;
  return `<div class="nn-edbar">
    <button class="btn ghost sm" data-nnhome>${svg('back', 14)} All networks</button>
    <input class="nn-name" id="nnName" value="${esc(_nnDoc.__name || '')}" placeholder="Network name" spellcheck="false" />
    <div class="nn-compute" title="Where the model runs">
      <span class="eyebrow">Run on</span>
      <div class="seg set-seg" id="nnCompute">
        <button type="button" data-compute="client" class="${_nnDoc.compute !== 'backend' ? 'on' : ''}">This device</button>
        ${backendOpt}
      </div>
    </div>
    <div class="spacer"></div>
    ${extraHTML || ''}
    <span class="nn-save-status mono saved" id="nnSaveStatus">saved</span>
    <button class="btn ghost sm" id="nnSaveBtn" title="Save now">${svg('save', 14)} Save</button>
  </div>`;
}
function wireEditorBar(root) {
  root.querySelectorAll('[data-nnhome]').forEach(b => b.onclick = async () => { _nnStop = true; _nnTraining = false; await flushNeuralSave(); renderNeuralHome(); });
  const nameEl = root.querySelector('#nnName');
  if (nameEl) nameEl.oninput = () => { _nnDoc.__name = nameEl.value.slice(0, 120); markNeuralDirty(); };
  const seg = root.querySelector('#nnCompute');
  if (seg) seg.querySelectorAll('[data-compute]:not([disabled])').forEach(b => b.onclick = () => {
    _nnDoc.compute = b.dataset.compute; seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); markNeuralDirty();
  });
  const sb = root.querySelector('#nnSaveBtn'); if (sb) sb.onclick = saveNeuralNow;
}
// run a compute op either client-side (NeuralEngine) or on the backend, per the
// network's compute setting. Always resolves to the same shape.
async function nnRun(op, payload) {
  if (_nnDoc && _nnDoc.compute === 'backend' && _nnCaps.backend) {
    // The backend rebuilds Adam moment buffers itself, so don't ship them over the
    // wire (they double the payload). The local `opt` keeps its moments for when
    // compute flips back to this device.
    let p = payload;
    if (payload && payload.opt && (payload.opt.mom || payload.opt.vel)) {
      const { mom, vel, ...rest } = payload.opt;
      p = { ...payload, opt: rest };
    }
    return await neuralCompute({ op, ...p });
  }
  return NE.neuralCompute({ op, ...payload });
}

/* ============================================================
   PATH B — TEXT MODEL (char-level language model)
   ============================================================ */
function freshLlmDoc() {
  return { kind: 'llm', compute: 'client',
    hp: { embed: 24, hidden: 96, seqLen: 56, lr: 0.01 },
    corpus: '', model: null, trained: 0, lossHistory: [],
  };
}
function openLlmEditor() {
  _nnView = 'llm';
  const app = document.getElementById('nnApp'); if (!app) return;
  const d = _nnDoc, hasModel = !!d.model;
  app.innerHTML = nnEditorBar() + `
    <div class="nn-llm">
      <div class="nn-llm-left">
        <div class="nn-panel">
          <div class="nn-panel-h">${svg('note', 15)} Training text</div>
          <p class="nn-panel-p">Paste or upload text to teach the model. More text — and more training — means it talks more like your data. Pre-training (lots of general text) then fine-tuning (your target style) both just go here.</p>
          <textarea class="nn-corpus" id="nnCorpus" placeholder="Paste training text here…  (stories, transcripts, chat logs, anything text)">${esc(d.corpus || '')}</textarea>
          <div class="nn-corpus-row">
            <label class="btn ghost sm nn-upload">${svg('download', 13)} Upload .txt<input type="file" id="nnCorpusFile" accept=".txt,.md,.csv,.json,text/*" hidden></label>
            <span class="nn-corpus-stat mono" id="nnCorpusStat"></span>
          </div>
        </div>
        <div class="nn-panel">
          <div class="nn-panel-h">${svg('gear', 15)} Model size</div>
          <div class="nn-hp-grid">
            <label>Embedding<input type="number" id="hpEmbed" min="8" max="64" step="4" value="${d.hp.embed}"></label>
            <label>Hidden units<input type="number" id="hpHidden" min="16" max="256" step="16" value="${d.hp.hidden}"></label>
            <label>Sequence<input type="number" id="hpSeq" min="16" max="128" step="8" value="${d.hp.seqLen}"></label>
            <label>Learn rate<input type="number" id="hpLr" min="0.001" max="0.1" step="0.001" value="${d.hp.lr}"></label>
          </div>
          <p class="nn-panel-p mono dim">Bigger models learn more but train slower. Changing size starts a fresh model.</p>
        </div>
      </div>
      <div class="nn-llm-right">
        <div class="nn-panel nn-train-panel">
          <div class="nn-panel-h">${svg('spark', 15)} Training ${hasModel ? `<span class="nn-trained-pill mono">${d.trained.toLocaleString()} steps</span>` : ''}</div>
          <canvas class="nn-loss" id="nnLoss" width="520" height="120"></canvas>
          <div class="nn-train-row">
            <button class="btn primary" id="nnTrainBtn">${svg('play', 14)} ${hasModel ? 'Continue training' : 'Start training'}</button>
            <button class="btn ghost" id="nnStopBtn" disabled>${svg('stop', 14)} Stop</button>
            <span class="nn-train-stat mono" id="nnTrainStat">${hasModel ? 'loss ' + (d.lossHistory.length ? d.lossHistory[d.lossHistory.length - 1].toFixed(3) : '—') : 'not trained yet'}</span>
          </div>
        </div>
        <div class="nn-panel nn-chat-panel">
          <div class="nn-panel-h">${svg('send', 15)} Talk to your model</div>
          <div class="nn-gen-opts">
            <label class="mono">Creativity <input type="range" id="nnTemp" min="0.2" max="1.4" step="0.05" value="0.85"></label>
            <label class="mono">Length <input type="number" id="nnLen" min="40" max="600" step="20" value="200"></label>
          </div>
          <div class="nn-prompt-row">
            <input type="text" id="nnPrompt" class="nn-prompt" placeholder="Start it off with a few words…" ${hasModel ? '' : 'disabled'}>
            <button class="btn primary" id="nnGenBtn" ${hasModel ? '' : 'disabled'}>${svg('send', 14)} Generate</button>
          </div>
          <div class="nn-gen-out" id="nnGenOut">${hasModel ? '<span class="dim mono">Generated text shows up here.</span>' : '<span class="dim mono">Train the model first, then it can write for you.</span>'}</div>
        </div>
      </div>
    </div>`;
  const app2 = document.getElementById('nnApp');
  wireEditorBar(app2);
  wireLlmEditor();
  drawLossChart();
  updateCorpusStat();
}

function wireLlmEditor() {
  const d = _nnDoc;
  const corpus = document.getElementById('nnCorpus');
  corpus.oninput = () => { d.corpus = corpus.value; updateCorpusStat(); markNeuralDirty(); };
  document.getElementById('nnCorpusFile').onchange = (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast('Please keep training text under 8 MB', 'close'); return; }
    const r = new FileReader();
    r.onload = () => { corpus.value = (corpus.value ? corpus.value + '\n' : '') + String(r.result || ''); d.corpus = corpus.value; updateCorpusStat(); markNeuralDirty(); };
    r.readAsText(f);
  };
  ['hpEmbed:embed', 'hpHidden:hidden', 'hpSeq:seqLen', 'hpLr:lr'].forEach(pair => {
    const [id, key] = pair.split(':'); const el = document.getElementById(id);
    el.onchange = () => { d.hp[key] = +el.value; if (key !== 'lr' && key !== 'seqLen') { d.model = null; d.trained = 0; d.lossHistory = []; refreshLlmTrainedUI(); } markNeuralDirty(); };
  });
  document.getElementById('nnTrainBtn').onclick = startLlmTraining;
  document.getElementById('nnStopBtn').onclick = () => { _nnStop = true; };
  document.getElementById('nnGenBtn').onclick = llmGenerate;
  const prompt = document.getElementById('nnPrompt');
  prompt.onkeydown = (e) => { if (e.key === 'Enter') llmGenerate(); };
}
function updateCorpusStat() {
  const el = document.getElementById('nnCorpusStat'); if (!el) return;
  const len = (_nnDoc.corpus || '').length, uniq = new Set(_nnDoc.corpus || '').size;
  el.textContent = len ? `${len.toLocaleString()} chars · ${uniq} unique` : 'no text yet';
}
function refreshLlmTrainedUI() {
  const stat = document.getElementById('nnTrainStat'); if (stat) stat.textContent = _nnDoc.model ? 'ready to continue' : 'not trained yet';
  const btn = document.getElementById('nnTrainBtn'); if (btn) btn.innerHTML = `${svg('play', 14)} ${_nnDoc.model ? 'Continue training' : 'Start training'}`;
  const has = !!_nnDoc.model;
  ['nnPrompt', 'nnGenBtn'].forEach(id => { const e = document.getElementById(id); if (e) e.disabled = !has; });
  drawLossChart();
}

async function startLlmTraining() {
  if (_nnTraining) return;
  const d = _nnDoc;
  const text = (d.corpus || '').trim();
  if (text.length < 20) { toast('Add some training text first', 'close'); return; }
  _nnTraining = true; _nnStop = false;
  const trainBtn = document.getElementById('nnTrainBtn'), stopBtn = document.getElementById('nnStopBtn'), stat = document.getElementById('nnTrainStat');
  trainBtn.disabled = true; stopBtn.disabled = false;
  // (re)build the model if needed
  if (!d.model) {
    const vocab = NE.buildVocab(text);
    d.model = NE.charlmInit({ vocab, embed: d.hp.embed, hidden: d.hp.hidden, seed: (Math.random() * 1e9) | 0 });
    d.trained = 0; d.lossHistory = [];
  }
  const ids = NE.encodeIds(text, d.model.vocab.chars);
  if (ids.length < d.hp.seqLen + 2) { toast('Need a bit more text for this sequence length', 'close'); _nnTraining = false; trainBtn.disabled = false; stopBtn.disabled = true; return; }
  const opt = { steps: 25, seqLen: d.hp.seqLen, lr: d.hp.lr, iter: 0 };
  // run in chunks so the tab (or the backend) stays responsive
  const loop = async () => {
    if (_nnStop || !_nnTraining) return finishLlmTraining();
    opt.iter = d.trained;
    try {
      const r = await nnRun('charlm-train', { model: d.model, ids, opt });
      d.model = r.model; d.trained += opt.steps;
      d.lossHistory.push(r.loss); if (d.lossHistory.length > 400) d.lossHistory.shift();
      stat.textContent = `step ${d.trained.toLocaleString()} · loss ${r.loss.toFixed(3)}`;
      drawLossChart();
      markNeuralDirty();
    } catch (e) {
      stat.textContent = 'training error: ' + (e && e.message || 'failed');
      return finishLlmTraining();
    }
    // yield to the event loop / repaint
    if ('requestAnimationFrame' in window) requestAnimationFrame(() => setTimeout(loop, 0)); else setTimeout(loop, 0);
  };
  loop();
}
function finishLlmTraining() {
  _nnTraining = false; _nnStop = false;
  const trainBtn = document.getElementById('nnTrainBtn'), stopBtn = document.getElementById('nnStopBtn');
  if (trainBtn) { trainBtn.disabled = false; trainBtn.innerHTML = `${svg('play', 14)} Continue training`; }
  if (stopBtn) stopBtn.disabled = true;
  refreshLlmTrainedUI();
  flushNeuralSave();
}
async function llmGenerate() {
  const d = _nnDoc; if (!d.model) return;
  const out = document.getElementById('nnGenOut'), btn = document.getElementById('nnGenBtn');
  const prompt = (document.getElementById('nnPrompt').value || '').slice(0, 200);
  const temperature = +document.getElementById('nnTemp').value || 0.85;
  const length = Math.min(+document.getElementById('nnLen').value || 200, 600);
  btn.disabled = true; out.innerHTML = '<span class="nn-gen-think mono">thinking…</span>';
  try {
    const r = await nnRun('charlm-sample', { model: d.model, gen: { prompt, length, temperature, seed: (Math.random() * 1e9) | 0 } });
    out.textContent = (prompt ? prompt : '') + (r.text || '');
  } catch (e) { out.innerHTML = `<span class="nn-err mono">${esc(e && e.message || 'generation failed')}</span>`; }
  btn.disabled = false;
}
function drawLossChart() {
  const cv = document.getElementById('nnLoss'); if (!cv) return;
  const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const hist = _nnDoc.lossHistory || [];
  const css = getComputedStyle(document.documentElement);
  const acc = (css.getPropertyValue('--aud') || '#b07cd6').trim() || '#b07cd6';
  const grid = 'rgba(255,255,255,0.06)';
  ctx.strokeStyle = grid; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) { const y = (H / 4) * i; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  if (hist.length < 2) { ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.font = '12px ui-monospace,monospace'; ctx.fillText('loss curve appears as you train', 12, H / 2); return; }
  const max = Math.max(...hist), min = Math.min(...hist), rng = (max - min) || 1;
  ctx.strokeStyle = acc; ctx.lineWidth = 2; ctx.beginPath();
  hist.forEach((v, i) => { const x = (i / (hist.length - 1)) * (W - 6) + 3; const y = H - 6 - ((v - min) / rng) * (H - 16); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '11px ui-monospace,monospace';
  ctx.fillText('loss ' + min.toFixed(3), 6, 14);
}

/* ============================================================
   PATH A — GRAPH SANDBOX
   A 2D world the user builds, wired to an MLP brain trained by neuroevolution.
   The user defines: the agent body (a circle that can thrust + turn) and its
   start, obstacles (static walls), a target (goal), which SENSORS feed the brain,
   and a FITNESS expression scored every episode. The MLP reads the chosen sensors
   and outputs thrust + turn each tick; a whole population runs the same world and
   the fittest are bred into the next generation. No prebuilt scenarios — the world
   is whatever the user lays out on the canvas.
   ============================================================ */
const NN_SENSORS = [
  { id: 'distX', label: 'dx to target', desc: 'horizontal offset to the target' },
  { id: 'distY', label: 'dy to target', desc: 'vertical offset to the target' },
  { id: 'dist', label: 'distance to target', desc: 'straight-line distance' },
  { id: 'angle', label: 'heading to target', desc: 'angle from facing to target' },
  { id: 'velX', label: 'velocity x', desc: 'current horizontal speed' },
  { id: 'velY', label: 'velocity y', desc: 'current vertical speed' },
  { id: 'speed', label: 'speed', desc: 'overall speed magnitude' },
  { id: 'heading', label: 'own heading', desc: 'the agent facing angle' },
  { id: 'rayF', label: 'wall ahead', desc: 'distance to nearest wall in front' },
  { id: 'rayL', label: 'wall left', desc: 'distance to wall on the left' },
  { id: 'rayR', label: 'wall right', desc: 'distance to wall on the right' },
];
const NN_ACTUATORS = [
  { id: 'thrust', label: 'thrust', desc: 'accelerate along facing' },
  { id: 'turn', label: 'turn', desc: 'rotate left/right' },
];
const NN_WORLD_W = 600, NN_WORLD_H = 400;

function freshGraphDoc() {
  return { kind: 'graph', compute: 'client',
    world: {
      agent: { x: 80, y: 200, r: 12 },
      target: { x: 520, y: 200, r: 18 },
      walls: [ { x: 280, y: 120, w: 40, h: 160 } ],
      maxTicks: 360, friction: 0.92, thrustPower: 0.5, turnPower: 0.12,
    },
    sensors: ['dist', 'angle', 'speed', 'rayF'],
    actuators: ['thrust', 'turn'],
    fitness: '100 - dist*0.2 - ticks*0.02 + (reached ? 300 : 0) - hits*40',
    brain: { hidden: [10, 8], act: 'tanh' },
    pop: 40, mutRate: 0.12, mutScale: 0.4, elite: 3,
    population: null, gen: 0, best: null, bestFit: null, fitHistory: [],
  };
}

let _gEditTool = 'agent';   // what a canvas click places/moves: agent|target|wall|erase
let _gSim = null;           // running sim state during playback
let _gRaf = 0;

function openGraphEditor() {
  _nnView = 'graph';
  const app = document.getElementById('nnApp'); if (!app) return;
  const d = _nnDoc;
  app.innerHTML = nnEditorBar() + `
    <div class="nn-graph">
      <div class="nn-graph-left">
        <div class="nn-panel">
          <div class="nn-panel-h">${svg('grid', 15)} World</div>
          <p class="nn-panel-p">Lay out your world: place the agent (start), the target (goal), and walls. The brain learns to drive the agent to the target however your fitness rewards it.</p>
          <div class="nn-tool-row" id="nnTools">
            <button data-tool="agent" class="on">${svg('user', 13)} Agent</button>
            <button data-tool="target">${svg('star', 13)} Target</button>
            <button data-tool="wall">${svg('grid', 13)} Wall</button>
            <button data-tool="erase">${svg('trash', 13)} Erase wall</button>
          </div>
          <canvas class="nn-world" id="nnWorld" width="${NN_WORLD_W}" height="${NN_WORLD_H}"></canvas>
          <div class="nn-world-foot mono dim">Click to place · drag the agent/target to move · with Erase, click a wall to remove it</div>
        </div>
      </div>
      <div class="nn-graph-right">
        <div class="nn-panel">
          <div class="nn-panel-h">${svg('plug', 15)} Brain wiring</div>
          <div class="nn-wire">
            <div class="nn-wire-col">
              <span class="eyebrow">Inputs (sensors)</span>
              <div class="nn-chiplist" id="nnSensors">${NN_SENSORS.map(s => `<label class="nn-chip ${d.sensors.includes(s.id) ? 'on' : ''}" title="${esc(s.desc)}"><input type="checkbox" data-sensor="${s.id}" ${d.sensors.includes(s.id) ? 'checked' : ''}>${esc(s.label)}</label>`).join('')}</div>
            </div>
            <div class="nn-wire-mid">${svg('brain', 26, 1.5)}<span class="mono dim" id="nnNetShape"></span></div>
            <div class="nn-wire-col">
              <span class="eyebrow">Outputs (actuators)</span>
              <div class="nn-chiplist">${NN_ACTUATORS.map(a => `<label class="nn-chip on locked" title="${esc(a.desc)}">${esc(a.label)}</label>`).join('')}</div>
              <span class="eyebrow" style="margin-top:10px">Hidden layers</span>
              <input type="text" class="nn-hidden" id="nnHidden" value="${(d.brain.hidden || []).join(', ')}" placeholder="10, 8">
            </div>
          </div>
        </div>
        <div class="nn-panel">
          <div class="nn-panel-h">${svg('spark', 15)} Fitness — what to reward</div>
          <p class="nn-panel-p mono dim">A JS expression scored at the end of each run. Vars: <b>dist</b>, <b>ticks</b>, <b>reached</b>, <b>hits</b>, <b>x</b>, <b>y</b>, <b>speed</b>. Higher is better.</p>
          <input type="text" class="nn-fitness" id="nnFitness" value="${esc(d.fitness)}" spellcheck="false">
          <div class="nn-fit-err mono" id="nnFitErr"></div>
        </div>
        <div class="nn-panel">
          <div class="nn-panel-h">${svg('refresh', 15)} Evolve</div>
          <div class="nn-hp-grid">
            <label>Population<input type="number" id="gPop" min="6" max="200" step="2" value="${d.pop}"></label>
            <label>Mutation<input type="number" id="gMut" min="0.01" max="0.8" step="0.01" value="${d.mutRate}"></label>
            <label>Mut. scale<input type="number" id="gScale" min="0.05" max="1.5" step="0.05" value="${d.mutScale}"></label>
            <label>Elite<input type="number" id="gElite" min="0" max="20" step="1" value="${d.elite}"></label>
          </div>
          <canvas class="nn-loss" id="nnFitChart" width="520" height="90"></canvas>
          <div class="nn-train-row">
            <button class="btn primary" id="gTrainBtn">${svg('play', 14)} ${d.population ? 'Keep evolving' : 'Start evolving'}</button>
            <button class="btn ghost" id="gStopBtn" disabled>${svg('stop', 14)} Stop</button>
            <button class="btn ghost" id="gWatchBtn" ${d.best ? '' : 'disabled'}>${svg('eye', 14)} Watch best</button>
            <span class="nn-train-stat mono" id="gStat">${d.gen ? 'gen ' + d.gen + ' · best ' + (d.bestFit != null ? d.bestFit.toFixed(1) : '—') : 'not evolved yet'}</span>
          </div>
        </div>
      </div>
    </div>`;
  wireEditorBar(document.getElementById('nnApp'));
  wireGraphEditor();
  drawWorld();
  drawFitChart();
  updateNetShape();
}

function wireGraphEditor() {
  const d = _nnDoc;
  const tools = document.getElementById('nnTools');
  tools.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => { _gEditTool = b.dataset.tool; tools.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
  wireWorldCanvas();
  document.getElementById('nnSensors').querySelectorAll('[data-sensor]').forEach(cb => cb.onchange = () => {
    const id = cb.dataset.sensor;
    if (cb.checked) { if (!d.sensors.includes(id)) d.sensors.push(id); } else d.sensors = d.sensors.filter(s => s !== id);
    cb.closest('.nn-chip').classList.toggle('on', cb.checked);
    d.population = null; d.best = null;   // a wiring change invalidates the trained brain
    updateNetShape(); markNeuralDirty();
  });
  const hidden = document.getElementById('nnHidden');
  hidden.onchange = () => { d.brain.hidden = hidden.value.split(',').map(x => parseInt(x.trim(), 10)).filter(n => n > 0).slice(0, 4); hidden.value = d.brain.hidden.join(', '); d.population = null; d.best = null; updateNetShape(); markNeuralDirty(); };
  const fit = document.getElementById('nnFitness');
  fit.onchange = () => { d.fitness = fit.value; validateFitness(); markNeuralDirty(); };
  ['gPop:pop', 'gMut:mutRate', 'gScale:mutScale', 'gElite:elite'].forEach(p => { const [id, key] = p.split(':'); const el = document.getElementById(id); el.onchange = () => { d[key] = +el.value; markNeuralDirty(); }; });
  document.getElementById('gTrainBtn').onclick = startEvolving;
  document.getElementById('gStopBtn').onclick = () => { _nnStop = true; };
  document.getElementById('gWatchBtn').onclick = watchBest;
  validateFitness();
}
function updateNetShape() {
  const el = document.getElementById('nnNetShape'); if (!el) return;
  const sizes = NE.mlpLayerSizes(Math.max(1, _nnDoc.sensors.length), _nnDoc.brain.hidden, NN_ACTUATORS.length);
  el.textContent = sizes.join('→');
}
function validateFitness() {
  const err = document.getElementById('nnFitErr'); if (!err) return true;
  try { compileFitness(_nnDoc.fitness)({ dist: 1, ticks: 1, reached: 0, hits: 0, x: 0, y: 0, speed: 0 }); err.textContent = ''; return true; }
  catch (e) { err.textContent = 'Invalid fitness: ' + (e && e.message || 'error'); return false; }
}
// Compile the user's fitness expression. Restricted to the provided vars + Math;
// a bad expression throws and is surfaced inline (it never crashes the app).
function compileFitness(expr) {
  const safe = String(expr || '0');
  if (/[^\w\s+\-*/%.,()?:<>=&|!]/.test(safe.replace(/Math\.\w+/g, ''))) throw new Error('unexpected characters');
  const fn = new Function('v', `with(v){ return (${safe}); }`);
  return (vars) => { const r = fn({ Math, ...vars }); if (!Number.isFinite(r)) throw new Error('not a number'); return r; };
}

/* ---------- world canvas: draw + edit ---------- */
function worldEventPos(cv, e) { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) }; }
function wireWorldCanvas() {
  const cv = document.getElementById('nnWorld'); if (!cv) return;
  const d = _nnDoc; let drag = null, wallStart = null;
  cv.onmousedown = (e) => {
    const p = worldEventPos(cv, e);
    if (_gEditTool === 'agent') { if (dist2(p, d.world.agent) < 400) drag = 'agent'; else { d.world.agent.x = p.x; d.world.agent.y = p.y; markNeuralDirty(); drawWorld(); } }
    else if (_gEditTool === 'target') { if (dist2(p, d.world.target) < 600) drag = 'target'; else { d.world.target.x = p.x; d.world.target.y = p.y; markNeuralDirty(); drawWorld(); } }
    else if (_gEditTool === 'wall') { wallStart = p; }
    else if (_gEditTool === 'erase') { const i = d.world.walls.findIndex(w => p.x >= w.x && p.x <= w.x + w.w && p.y >= w.y && p.y <= w.y + w.h); if (i >= 0) { d.world.walls.splice(i, 1); markNeuralDirty(); drawWorld(); } }
  };
  cv.onmousemove = (e) => {
    const p = worldEventPos(cv, e);
    if (drag === 'agent') { d.world.agent.x = clamp(p.x, 10, NN_WORLD_W - 10); d.world.agent.y = clamp(p.y, 10, NN_WORLD_H - 10); drawWorld(); }
    else if (drag === 'target') { d.world.target.x = clamp(p.x, 10, NN_WORLD_W - 10); d.world.target.y = clamp(p.y, 10, NN_WORLD_H - 10); drawWorld(); }
    else if (wallStart) { drawWorld(); const ctx = cv.getContext('2d'); ctx.strokeStyle = 'rgba(176,124,214,0.8)'; ctx.setLineDash([4, 3]); ctx.strokeRect(Math.min(wallStart.x, p.x), Math.min(wallStart.y, p.y), Math.abs(p.x - wallStart.x), Math.abs(p.y - wallStart.y)); ctx.setLineDash([]); }
  };
  cv.onmouseup = (e) => {
    if (wallStart) { const p = worldEventPos(cv, e); const w = { x: Math.min(wallStart.x, p.x), y: Math.min(wallStart.y, p.y), w: Math.abs(p.x - wallStart.x), h: Math.abs(p.y - wallStart.y) }; if (w.w > 6 && w.h > 6) { d.world.walls.push(w); markNeuralDirty(); } wallStart = null; drawWorld(); }
    if (drag) { markNeuralDirty(); drag = null; }
  };
  cv.onmouseleave = () => { if (drag) { markNeuralDirty(); drag = null; } wallStart = null; drawWorld(); };
}
function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function drawWorld(agentState) {
  const cv = document.getElementById('nnWorld'); if (!cv) return;
  const ctx = cv.getContext('2d'), d = _nnDoc, W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.02)'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
  for (let x = 40; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 40; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  d.world.walls.forEach(w => ctx.fillRect(w.x, w.y, w.w, w.h));
  const t = d.world.target;
  ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, 7); ctx.fillStyle = 'rgba(120,200,140,0.25)'; ctx.fill();
  ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, 7); ctx.strokeStyle = 'rgba(120,220,150,0.9)'; ctx.lineWidth = 2; ctx.stroke();
  const a = agentState || d.world.agent;
  ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(a.heading || 0);
  ctx.beginPath(); ctx.arc(0, 0, d.world.agent.r, 0, 7); ctx.fillStyle = '#b07cd6'; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(d.world.agent.r + 6, 0); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  ctx.restore();
}

/* ---------- the simulation: one episode of one genome ---------- */
function runEpisode(genome, sizes, fitFn) {
  const d = _nnDoc, w = d.world;
  const a = { x: w.agent.x, y: w.agent.y, vx: 0, vy: 0, heading: 0 };
  let ticks = 0, hits = 0, reached = false;
  const maxT = w.maxTicks || 360;
  for (ticks = 0; ticks < maxT; ticks++) {
    const sensors = readSensors(a, d);
    const out = NE.mlpForward(genome, sizes, sensors, d.brain.act);
    const thrust = (out[0] + 1) / 2;                 // 0..1
    const turn = out[1];                             // -1..1
    a.heading += turn * (w.turnPower || 0.12);
    a.vx += Math.cos(a.heading) * thrust * (w.thrustPower || 0.5);
    a.vy += Math.sin(a.heading) * thrust * (w.thrustPower || 0.5);
    a.vx *= (w.friction || 0.92); a.vy *= (w.friction || 0.92);
    a.x += a.vx; a.y += a.vy;
    if (a.x < 0 || a.x > NN_WORLD_W || a.y < 0 || a.y > NN_WORLD_H) { hits++; a.x = clamp(a.x, 0, NN_WORLD_W); a.y = clamp(a.y, 0, NN_WORLD_H); a.vx *= -0.4; a.vy *= -0.4; }
    for (const wall of w.walls) if (a.x > wall.x && a.x < wall.x + wall.w && a.y > wall.y && a.y < wall.y + wall.h) { hits++; a.vx *= -0.5; a.vy *= -0.5; a.x += a.vx * 2; a.y += a.vy * 2; }
    const dd = Math.hypot(a.x - w.target.x, a.y - w.target.y);
    if (dd < w.target.r + w.agent.r) { reached = true; break; }
  }
  const dist = Math.hypot(a.x - w.target.x, a.y - w.target.y);
  const speed = Math.hypot(a.vx, a.vy);
  let fit;
  try { fit = fitFn({ dist, ticks, reached: reached ? 1 : 0, hits, x: a.x, y: a.y, speed }); } catch (e) { fit = -1e9; }
  return { fit, end: a, reached, ticks };
}
// The sensor vector the brain sees, in the user's chosen order.
function readSensors(a, d) {
  const w = d.world, t = w.target;
  const dx = t.x - a.x, dy = t.y - a.y, dist = Math.hypot(dx, dy) || 1;
  const ray = (ang) => {
    let r = 0; const step = 8, max = 200; const ca = Math.cos(a.heading + ang), sa = Math.sin(a.heading + ang);
    for (r = step; r < max; r += step) { const px = a.x + ca * r, py = a.y + sa * r; if (px < 0 || px > NN_WORLD_W || py < 0 || py > NN_WORLD_H) break; let hit = false; for (const wl of w.walls) if (px > wl.x && px < wl.x + wl.w && py > wl.y && py < wl.y + wl.h) { hit = true; break; } if (hit) break; }
    return 1 - Math.min(r, max) / max;   // 1 = wall right here, 0 = clear
  };
  const map = {
    distX: dx / NN_WORLD_W, distY: dy / NN_WORLD_H, dist: dist / Math.hypot(NN_WORLD_W, NN_WORLD_H),
    angle: Math.atan2(dy, dx) - a.heading, velX: a.vx / 8, velY: a.vy / 8, speed: Math.hypot(a.vx, a.vy) / 8,
    heading: a.heading / Math.PI, rayF: ray(0), rayL: ray(-Math.PI / 2), rayR: ray(Math.PI / 2),
  };
  return Float64Array.from(d.sensors.map(s => { let v = map[s] ?? 0; if (s === 'angle') { while (v > Math.PI) v -= 2 * Math.PI; while (v < -Math.PI) v += 2 * Math.PI; v /= Math.PI; } return v; }));
}

/* ---------- evolution loop ---------- */
async function startEvolving() {
  if (_nnTraining) return;
  if (!validateFitness()) { toast('Fix the fitness expression first', 'close'); return; }
  if (!_nnDoc.sensors.length) { toast('Pick at least one sensor input', 'close'); return; }
  _nnTraining = true; _nnStop = false; cancelAnimationFrame(_gRaf); _gSim = null;
  const d = _nnDoc;
  const trainBtn = document.getElementById('gTrainBtn'), stopBtn = document.getElementById('gStopBtn'), stat = document.getElementById('gStat');
  trainBtn.disabled = true; stopBtn.disabled = false;
  const sizes = NE.mlpLayerSizes(d.sensors.length, d.brain.hidden, NN_ACTUATORS.length);
  const rng = NE.mulberry32((Math.random() * 1e9) | 0);
  if (!d.population || !d.population.length || (d.population[0] && d.population[0].length !== NE.mlpParamCount(sizes))) {
    d.population = []; for (let i = 0; i < d.pop; i++) d.population.push(Array.from(NE.mlpRandomGenome(sizes, rng)));
    d.gen = 0; d.fitHistory = [];
  }
  const fitFn = compileFitness(d.fitness);
  const loop = async () => {
    if (_nnStop || !_nnTraining) return finishEvolving();
    const scored = d.population.map((g, i) => { const r = runEpisode(Float64Array.from(g), sizes, fitFn); return { genome: g, fit: r.fit, i }; });
    scored.sort((a, b) => b.fit - a.fit);
    d.best = scored[0].genome; d.bestFit = scored[0].fit;
    d.fitHistory.push(scored[0].fit); if (d.fitHistory.length > 300) d.fitHistory.shift();
    d.gen++;
    const ranked = scored.map((s, rank) => ({ genome: s.genome, rank }));
    try {
      const r = await nnRun('evolve', { ranked, popSize: d.pop, sizes, mutRate: d.mutRate, mutScale: d.mutScale, elite: d.elite, seed: (Math.random() * 1e9) | 0 });
      d.population = r.population;
    } catch (e) { stat.textContent = 'evolve error: ' + (e && e.message); return finishEvolving(); }
    stat.textContent = `gen ${d.gen} · best ${d.bestFit.toFixed(1)}`;
    drawFitChart();
    const wb = document.getElementById('gWatchBtn'); if (wb) wb.disabled = false;
    markNeuralDirty();
    if ('requestAnimationFrame' in window) requestAnimationFrame(() => setTimeout(loop, 0)); else setTimeout(loop, 0);
  };
  loop();
}
function finishEvolving() {
  _nnTraining = false; _nnStop = false;
  const trainBtn = document.getElementById('gTrainBtn'), stopBtn = document.getElementById('gStopBtn');
  if (trainBtn) { trainBtn.disabled = false; trainBtn.innerHTML = `${svg('play', 14)} Keep evolving`; }
  if (stopBtn) stopBtn.disabled = true;
  flushNeuralSave();
}
// Animate the best genome driving the world, so the user can SEE what it learned.
function watchBest() {
  const d = _nnDoc; if (!d.best) return;
  cancelAnimationFrame(_gRaf);
  const sizes = NE.mlpLayerSizes(d.sensors.length, d.brain.hidden, NN_ACTUATORS.length);
  const genome = Float64Array.from(d.best), w = d.world;
  const a = { x: w.agent.x, y: w.agent.y, vx: 0, vy: 0, heading: 0 };
  let tick = 0; const maxT = w.maxTicks || 360;
  const step = () => {
    const sensors = readSensors(a, d);
    const out = NE.mlpForward(genome, sizes, sensors, d.brain.act);
    const thrust = (out[0] + 1) / 2, turn = out[1];
    a.heading += turn * (w.turnPower || 0.12);
    a.vx += Math.cos(a.heading) * thrust * (w.thrustPower || 0.5);
    a.vy += Math.sin(a.heading) * thrust * (w.thrustPower || 0.5);
    a.vx *= (w.friction || 0.92); a.vy *= (w.friction || 0.92);
    a.x = clamp(a.x + a.vx, 0, NN_WORLD_W); a.y = clamp(a.y + a.vy, 0, NN_WORLD_H);
    drawWorld(a);
    const dd = Math.hypot(a.x - w.target.x, a.y - w.target.y);
    tick++;
    if (dd < w.target.r + w.agent.r || tick > maxT) { drawWorld(a); return; }
    _gRaf = requestAnimationFrame(step);
  };
  step();
}
function drawFitChart() {
  const cv = document.getElementById('nnFitChart'); if (!cv) return;
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height, hist = _nnDoc.fitHistory || [];
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  for (let i = 1; i < 3; i++) { const y = (H / 3) * i; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  if (hist.length < 2) { ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.font = '11px ui-monospace,monospace'; ctx.fillText('best fitness per generation appears here', 10, H / 2); return; }
  const max = Math.max(...hist), min = Math.min(...hist), rng = (max - min) || 1;
  ctx.strokeStyle = '#7fcf96'; ctx.lineWidth = 2; ctx.beginPath();
  hist.forEach((v, i) => { const x = (i / (hist.length - 1)) * (W - 6) + 3; const y = H - 6 - ((v - min) / rng) * (H - 14); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '11px ui-monospace,monospace';
  ctx.fillText('best ' + max.toFixed(1), 6, 13);
}

/* ============================================================
   PATH A (ADVANCED) — ACTOR LAB
   A 2D actor engine where the user authors actor TYPES (each with custom
   variables, a physics body, an optional AI brain, and a node graph that runs
   every tick), then places INSTANCES of them on a map. Agent-type brains are
   evolved by neuroevolution to maximize the total reward the graphs produce.
   The simulation + evolution live in neural-engine.js (shared with the backend);
   this file is the editor: map view, actor-type editor, and the node-graph editor.
   ============================================================ */

/* The node catalog — UI metadata for each node type.
   Pin model: `execIn` (white action input) / `execOut` (array of white action
   output port names; ['exec'] for a plain pass-through, ['true','false'] for a
   Branch). `in` is an array of typed DATA input ports {p, type}; `out` is the
   single data output's type (data nodes only). `fields` are inline config inputs.
   PIN_TYPES gives each type its color. Pure data nodes have no exec pins and are
   pulled on demand; action/event nodes carry exec pins and run along the chain. */
const PIN_TYPES = {
  exec:   { color: '#e8e8e8', label: 'action' },
  number: { color: '#7fcf96', label: 'number' },
  bool:   { color: '#e0654a', label: 'boolean' },
};
const NODE_CATALOG = {
  // ---- events (exec sources) ----
  onTick:  { cat: 'Event', label: 'On Tick', desc: 'runs every tick — the start of your logic', execOut: ['exec'] },
  onHit:   { cat: 'Event', label: 'On Hit', desc: 'runs the tick this actor touches the chosen type', execOut: ['exec'], fields: [{ k: 'typeName', t: 'type', label: 'with' }] },
  onSpawn: { cat: 'Event', label: 'On Spawn', desc: 'runs once on the first tick', execOut: ['exec'] },
  // ---- value (pure data, green = number) ----
  const:   { cat: 'Value', label: 'Number', desc: 'a constant number', out: 'number', fields: [{ k: 'v', t: 'num', label: '=' }] },
  bool:    { cat: 'Value', label: 'Boolean', desc: 'a true/false constant', out: 'bool', fields: [{ k: 'v', t: 'bool', label: '' }] },
  getVar:  { cat: 'Value', label: 'Get Var', desc: 'read one of this actor\'s variables', out: 'number', fields: [{ k: 'var', t: 'var', label: 'var' }] },
  self:    { cat: 'Value', label: 'Self', desc: 'this actor\'s position/velocity', out: 'number', fields: [{ k: 'field', t: 'sel', label: 'field', opts: ['x', 'y', 'vx', 'vy'] }] },
  // ---- sensors (pure data) ----
  raycast:    { cat: 'Sensor', label: 'Raycast', desc: 'distance to the nearest actor along an angle (0=clear … 1=touching)', out: 'number', fields: [{ k: 'angle', t: 'num', label: 'angle°' }] },
  rayHitType: { cat: 'Sensor', label: 'Ray Hits Type?', desc: 'true if the ray at this angle hits the chosen type', out: 'bool', fields: [{ k: 'angle', t: 'num', label: 'angle°' }, { k: 'typeName', t: 'type', label: 'type' }] },
  onHitTest:  { cat: 'Sensor', label: 'Touching Type?', desc: 'true if currently overlapping the chosen type', out: 'bool', fields: [{ k: 'typeName', t: 'type', label: 'type' }] },
  // ---- AI (pure data out / brainOut; brainIn is an action) ----
  brainOut: { cat: 'AI', label: 'Brain Output', desc: 'read output #i from the AI brain (−1…1)', out: 'number', fields: [{ k: 'i', t: 'int', label: '# out' }] },
  // ---- math (pure data, number in/out) ----
  add:  { cat: 'Math', label: '+', in: [['a', 'number'], ['b', 'number']], out: 'number' },
  sub:  { cat: 'Math', label: '−', in: [['a', 'number'], ['b', 'number']], out: 'number' },
  mul:  { cat: 'Math', label: '×', in: [['a', 'number'], ['b', 'number']], out: 'number' },
  div:  { cat: 'Math', label: '÷', in: [['a', 'number'], ['b', 'number']], out: 'number' },
  neg:  { cat: 'Math', label: 'negate', in: [['a', 'number']], out: 'number' },
  min:  { cat: 'Math', label: 'min', in: [['a', 'number'], ['b', 'number']], out: 'number' },
  max:  { cat: 'Math', label: 'max', in: [['a', 'number'], ['b', 'number']], out: 'number' },
  abs:  { cat: 'Math', label: 'abs', in: [['a', 'number']], out: 'number' },
  sin:  { cat: 'Math', label: 'sin', in: [['a', 'number']], out: 'number' },
  cos:  { cat: 'Math', label: 'cos', in: [['a', 'number']], out: 'number' },
  clamp:{ cat: 'Math', label: 'clamp', in: [['a', 'number'], ['lo', 'number'], ['hi', 'number']], out: 'number' },
  ifte: { cat: 'Math', label: 'pick (if/else)', desc: 'output a if cond is true, else b', in: [['c', 'bool'], ['a', 'number'], ['b', 'number']], out: 'number' },
  // ---- logic (pure data, bool out) ----
  gt:  { cat: 'Logic', label: 'a > b', in: [['a', 'number'], ['b', 'number']], out: 'bool' },
  lt:  { cat: 'Logic', label: 'a < b', in: [['a', 'number'], ['b', 'number']], out: 'bool' },
  eq:  { cat: 'Logic', label: 'a = b', in: [['a', 'number'], ['b', 'number']], out: 'bool' },
  and: { cat: 'Logic', label: 'and', in: [['a', 'bool'], ['b', 'bool']], out: 'bool' },
  or:  { cat: 'Logic', label: 'or', in: [['a', 'bool'], ['b', 'bool']], out: 'bool' },
  not: { cat: 'Logic', label: 'not', in: [['a', 'bool']], out: 'bool' },
  // ---- flow ----
  branch: { cat: 'Flow', label: 'Branch', desc: 'split the action flow on a boolean: True or False', execIn: true, execOut: ['true', 'false'], in: [['cond', 'bool']] },
  // ---- actions (exec in + out, do something) ----
  setVar:    { cat: 'Action', label: 'Set Var', desc: 'write a value into a variable', execIn: true, execOut: ['exec'], in: [['value', 'number']], fields: [{ k: 'var', t: 'var', label: 'var' }] },
  impulse:   { cat: 'Action', label: 'Add Velocity', desc: 'add to velX or velY (moves dynamic bodies)', execIn: true, execOut: ['exec'], in: [['value', 'number']], fields: [{ k: 'axis', t: 'sel', label: 'axis', opts: ['x', 'y'] }] },
  addReward: { cat: 'Action', label: 'Add Reward', desc: 'add (or subtract) reward — this is the training signal', execIn: true, execOut: ['exec'], in: [['value', 'number']] },
  brainIn:   { cat: 'AI', label: 'Brain Input', desc: 'feed a value into brain input #i', execIn: true, execOut: ['exec'], in: [['value', 'number']], fields: [{ k: 'i', t: 'int', label: '# in' }] },
  destroy:   { cat: 'Action', label: 'Destroy', desc: 'remove this actor (ends its logic this tick)', execIn: true, execOut: [] },
};
const NODE_CATS = ['Event', 'Flow', 'Value', 'Sensor', 'AI', 'Math', 'Logic', 'Action'];
function nodeHasExecIn(t) { return !!(NODE_CATALOG[t] && NODE_CATALOG[t].execIn); }
function nodeExecOuts(t) { return (NODE_CATALOG[t] && NODE_CATALOG[t].execOut) || []; }
function nodeDataIns(t) { return (NODE_CATALOG[t] && NODE_CATALOG[t].in) || []; }
function nodeDataOut(t) { return NODE_CATALOG[t] && NODE_CATALOG[t].out; }   // type string or undefined

const ACTOR_PALETTE = ['#b07cd6', '#7fcf96', '#e0654a', '#e0a64a', '#5aa9e6', '#d65a9a', '#8c8c8c'];

function freshActorDoc() {
  // Seed a fully-wired starting Agent on the EXEC-flow model with a 360° view:
  //   On Tick → Set velX(=velX*0.9) → Set velY(=velY*0.9)
  //           → Brain In0..7 = 8 raycasts at 45° around the agent
  //           → Brain In8(velX) → In9(velY)
  //           → Add Velocity X(brainOut0*0.6) → Add Velocity Y(brainOut1*0.6)
  //   On Hit[Target] → Add Reward(+10)
  // plus a Target and two Walls. The 8 rays give the brain enough spatial sense to
  // actually find the target and dodge walls out of the box.
  const agentId = 'ty_agent', targetId = 'ty_target', wallId = 'ty_wall';
  const g = { nodes: [], edges: [] }; let i = 0;
  const node = (o) => { o.id = 'nd' + (i++); o.x = o.x || 40; o.y = o.y || 40; g.nodes.push(o); return o; };
  const dataEd = (from, to, toPort) => g.edges.push({ from: from.id, fromPort: 'out', to: to.id, toPort });
  const execEd = (from, to, fromPort) => g.edges.push({ from: from.id, fromPort: fromPort || 'exec', to: to.id, toPort: 'exec' });
  // events
  const onTick = node({ t: 'onTick', x: 20, y: 40 });
  const onHit = node({ t: 'onHit', typeName: 'Target', x: 20, y: 1180 });
  // friction velX *= 0.9
  const gx = node({ t: 'getVar', var: 'velX', x: 240, y: 20 }), c9 = node({ t: 'const', v: 0.9, x: 240, y: 110 });
  const mx = node({ t: 'mul', x: 420, y: 40 }); dataEd(gx, mx, 'a'); dataEd(c9, mx, 'b');
  const sx = node({ t: 'setVar', var: 'velX', x: 600, y: 40 }); dataEd(mx, sx, 'value');
  // friction velY *= 0.9
  const gy = node({ t: 'getVar', var: 'velY', x: 240, y: 220 }), c9b = node({ t: 'const', v: 0.9, x: 240, y: 310 });
  const my = node({ t: 'mul', x: 420, y: 240 }); dataEd(gy, my, 'a'); dataEd(c9b, my, 'b');
  const sy = node({ t: 'setVar', var: 'velY', x: 600, y: 240 }); dataEd(my, sy, 'value');
  // 8 raycasts at 45° around -> brain inputs 0..7
  const rayBI = [];
  for (let k = 0; k < 8; k++) {
    const ang = k * 45;
    const ry = 60 + k * 120;
    const rc = node({ t: 'raycast', angle: ang, x: 760, y: ry });
    const bi = node({ t: 'brainIn', i: k, x: 980, y: ry }); dataEd(rc, bi, 'value');
    rayBI.push(bi);
  }
  // velX/velY -> brain inputs 8, 9
  const bi8 = node({ t: 'brainIn', i: 8, x: 980, y: 1020 }); dataEd(gx, bi8, 'value');
  const bi9 = node({ t: 'brainIn', i: 9, x: 980, y: 1100 }); dataEd(gy, bi9, 'value');
  // brain outputs -> impulses
  const bo0 = node({ t: 'brainOut', i: 0, x: 1240, y: 200 }), cp = node({ t: 'const', v: 0.6, x: 1240, y: 290 });
  const m0 = node({ t: 'mul', x: 1420, y: 220 }); dataEd(bo0, m0, 'a'); dataEd(cp, m0, 'b');
  const ix = node({ t: 'impulse', axis: 'x', x: 1600, y: 180 }); dataEd(m0, ix, 'value');
  const bo1 = node({ t: 'brainOut', i: 1, x: 1240, y: 380 }), cp2 = node({ t: 'const', v: 0.6, x: 1240, y: 470 });
  const m1 = node({ t: 'mul', x: 1420, y: 400 }); dataEd(bo1, m1, 'a'); dataEd(cp2, m1, 'b');
  const iy = node({ t: 'impulse', axis: 'y', x: 1600, y: 360 }); dataEd(m1, iy, 'value');
  // reward on touching Target
  const cr = node({ t: 'const', v: 10, x: 240, y: 1180 });
  const ar = node({ t: 'addReward', x: 420, y: 1180 }); dataEd(cr, ar, 'value');
  // exec chain: onTick -> sx -> sy -> [8 ray brainIns] -> bi8 -> bi9 -> ix -> iy
  execEd(onTick, sx); execEd(sx, sy);
  let prev = sy; for (const bi of rayBI) { execEd(prev, bi); prev = bi; }
  execEd(prev, bi8); execEd(bi8, bi9); execEd(bi9, ix); execEd(ix, iy);
  // exec chain: onHit -> addReward
  execEd(onHit, ar);
  return {
    kind: 'actorlab', compute: 'client',
    world: { w: 600, h: 400, maxTicks: 360, visibleRays: false },
    actorTypes: [
      { id: agentId, name: 'Agent', color: '#b07cd6', isAgent: true,
        vars: [{ name: 'velX', init: 0 }, { name: 'velY', init: 0 }],
        body: { mode: 'dynamic', w: 20, h: 20 },
        brain: { hidden: [12, 8], act: 'tanh', inputs: ['ray0', 'ray45', 'ray90', 'ray135', 'ray180', 'ray225', 'ray270', 'ray315', 'velX', 'velY'], outputs: ['accelX', 'accelY'] },
        graph: g },
      { id: targetId, name: 'Target', color: '#7fcf96', isAgent: false, vars: [], body: { mode: 'static', w: 30, h: 30 }, brain: null, graph: { nodes: [], edges: [] } },
      { id: wallId, name: 'Wall', color: '#8c8c8c', isAgent: false, vars: [], body: { mode: 'static', w: 40, h: 130 }, brain: null, graph: { nodes: [], edges: [] } },
    ],
    instances: [
      { typeId: agentId, x: 70, y: 200 }, { typeId: targetId, x: 530, y: 200 },
      { typeId: wallId, x: 300, y: 90 }, { typeId: wallId, x: 300, y: 310 },
    ],
    evo: { pop: 30, mutRate: 0.12, mutScale: 0.4, elite: 2 },
    pops: {}, gen: 0, bestFit: null, fitHistory: [], bestBrains: null,
  };
}

let _alView = 'map';        // 'map' | 'type' | 'graph'
let _alTypeId = null;       // actor type being edited (type/graph views)
let _alTool = null;         // map placement: a typeId to place, or 'erase', or null (select)
let _alRaf = 0;

function actorTypeById(id) { return (_nnDoc.actorTypes || []).find(t => t.id === id); }

function openActorEditor() {
  _alView = 'map'; _alTool = null;
  // migrate any v1 (sink-style) graphs to the v2 exec-flow model so old saved labs
  // open correctly in the new editor (the engine migrates too, but the editor needs
  // the converted edges to render typed pins).
  if (NE && NE.migrateActorGraph) (_nnDoc.actorTypes || []).forEach(t => { if (t.graph) NE.migrateActorGraph(t.graph); });
  renderActorLab();
}

function renderActorLab() {
  const app = document.getElementById('nnApp'); if (!app) return;
  app.innerHTML = nnEditorBar(`<div class="al-tabs">
      <button data-altab="map" class="${_alView === 'map' ? 'on' : ''}">${svg('grid', 13)} Map</button>
      <button data-altab="types" class="${_alView !== 'map' ? 'on' : ''}">${svg('user', 13)} Actor types</button>
    </div>`);
  const body = document.createElement('div'); body.className = 'al-body'; body.id = 'alBody';
  app.appendChild(body);
  wireEditorBar(app);
  app.querySelectorAll('[data-altab]').forEach(b => b.onclick = () => { if (b.dataset.altab === 'map') { _alView = 'map'; } else { _alView = 'type'; _alTypeId = _alTypeId || (_nnDoc.actorTypes[0] && _nnDoc.actorTypes[0].id); } renderActorLab(); });
  if (_alView === 'map') renderMapView(body);
  else if (_alView === 'graph') renderGraphView(body);
  else renderTypesView(body);
}

/* ---------- MAP VIEW: place instances, world settings, train/watch ---------- */
function renderMapView(body) {
  const d = _nnDoc;
  body.innerHTML = `
    <div class="al-map-wrap">
      <div class="al-palette">
        <span class="eyebrow">Place actors</span>
        ${d.actorTypes.map(t => `<button class="al-pal-btn" data-place="${t.id}"><span class="al-swatch" style="background:${esc(t.color)}"></span>${esc(t.name)}${t.isAgent ? ' <span class="al-agent-tag">AI</span>' : ''}</button>`).join('')}
        <button class="al-pal-btn erase" data-place="erase">${svg('trash', 13)} Erase</button>
        <button class="al-pal-btn select ${_alTool === null ? 'on' : ''}" data-place="select">${svg('move', 13)} Move</button>
        <div class="al-world-set">
          <span class="eyebrow">World</span>
          <label>Width<input type="number" id="alW" min="200" max="1200" step="20" value="${d.world.w}"></label>
          <label>Height<input type="number" id="alH" min="200" max="900" step="20" value="${d.world.h}"></label>
          <label>Ticks / run<input type="number" id="alTicks" min="60" max="2000" step="30" value="${d.world.maxTicks}"></label>
          <label class="al-world-check" title="Draw each actor's raycasts during Watch best"><input type="checkbox" id="alRays" ${d.world.visibleRays ? 'checked' : ''}> Visible raycasts</label>
        </div>
      </div>
      <div class="al-stage">
        <canvas class="al-canvas" id="alCanvas"></canvas>
        <div class="al-stage-foot mono dim">Pick an actor and click to place · Move tool drags instances · Erase removes them</div>
      </div>
      <div class="al-train">
        <div class="nn-panel">
          <div class="nn-panel-h">${svg('refresh', 15)} Evolve the agents</div>
          <div class="nn-hp-grid">
            <label>Population<input type="number" id="alPop" min="4" max="120" step="2" value="${d.evo.pop}"></label>
            <label>Mutation<input type="number" id="alMut" min="0.01" max="0.8" step="0.01" value="${d.evo.mutRate}"></label>
            <label>Mut. scale<input type="number" id="alScale" min="0.05" max="1.5" step="0.05" value="${d.evo.mutScale}"></label>
            <label>Elite<input type="number" id="alElite" min="0" max="20" step="1" value="${d.evo.elite}"></label>
          </div>
          <canvas class="nn-loss" id="alFitChart" width="320" height="84"></canvas>
          <div class="nn-train-row">
            <button class="btn primary" id="alTrainBtn">${svg('play', 14)} ${d.gen ? 'Keep evolving' : 'Start evolving'}</button>
            <button class="btn ghost" id="alStopBtn" disabled>${svg('stop', 14)} Stop</button>
          </div>
          <div class="nn-train-row">
            <button class="btn ghost" id="alWatchBtn" ${d.bestBrains ? '' : 'disabled'}>${svg('eye', 14)} Watch best</button>
            <span class="nn-train-stat mono" id="alStat">${d.gen ? 'gen ' + d.gen + ' · best ' + (d.bestFit != null ? d.bestFit.toFixed(1) : '—') : 'not evolved yet'}</span>
          </div>
          <p class="nn-panel-p mono dim" style="margin-top:10px">Fitness = total reward your graphs produce in one run. Edit an actor type to change its logic, AI, and reward.</p>
        </div>
      </div>
    </div>`;
  // place tools
  body.querySelectorAll('[data-place]').forEach(b => b.onclick = () => {
    const v = b.dataset.place; _alTool = (v === 'select') ? null : v;
    body.querySelectorAll('[data-place]').forEach(x => x.classList.toggle('on', x === b));
    document.getElementById('alCanvas').style.cursor = _alTool && _alTool !== 'erase' ? 'copy' : _alTool === 'erase' ? 'not-allowed' : 'grab';
  });
  // world settings
  const bind = (id, fn) => { const e = document.getElementById(id); if (e) e.onchange = () => { fn(+e.value); markNeuralDirty(); sizeMapCanvas(); drawMap(); }; };
  bind('alW', v => d.world.w = clamp(v, 200, 1200)); bind('alH', v => d.world.h = clamp(v, 200, 900)); bind('alTicks', v => d.world.maxTicks = clamp(v, 60, 2000));
  const raysCb = document.getElementById('alRays'); if (raysCb) raysCb.onchange = () => { d.world.visibleRays = raysCb.checked; markNeuralDirty(); };
  ['alPop:pop', 'alMut:mutRate', 'alScale:mutScale', 'alElite:elite'].forEach(p => { const [id, k] = p.split(':'); const e = document.getElementById(id); e.onchange = () => { d.evo[k] = +e.value; markNeuralDirty(); }; });
  document.getElementById('alTrainBtn').onclick = startActorEvolving;
  document.getElementById('alStopBtn').onclick = () => { _nnStop = true; };
  document.getElementById('alWatchBtn').onclick = watchActorBest;
  sizeMapCanvas(); wireMapCanvas(); drawMap(); drawActorFitChart();
}

function sizeMapCanvas() {
  const cv = document.getElementById('alCanvas'); if (!cv) return;
  cv.width = _nnDoc.world.w; cv.height = _nnDoc.world.h;
}
function wireMapCanvas() {
  const cv = document.getElementById('alCanvas'); if (!cv) return;
  const d = _nnDoc; let drag = null;
  const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) }; };
  const hitInst = (p) => { for (let k = d.instances.length - 1; k >= 0; k--) { const inst = d.instances[k]; const T = actorTypeById(inst.typeId); if (!T) continue; const w = (T.body && T.body.w) || 24, h = (T.body && T.body.h) || 24; if (Math.abs(p.x - inst.x) < w / 2 + 3 && Math.abs(p.y - inst.y) < h / 2 + 3) return k; } return -1; };
  cv.onmousedown = (e) => {
    const p = pos(e);
    if (_alTool === 'erase') { const k = hitInst(p); if (k >= 0) { d.instances.splice(k, 1); markNeuralDirty(); drawMap(); } return; }
    if (_alTool && _alTool !== 'erase') { d.instances.push({ typeId: _alTool, x: Math.round(p.x), y: Math.round(p.y) }); markNeuralDirty(); drawMap(); return; }
    const k = hitInst(p); if (k >= 0) { drag = k; cv.style.cursor = 'grabbing'; }
  };
  cv.onmousemove = (e) => { if (drag == null) return; const p = pos(e); d.instances[drag].x = Math.round(clamp(p.x, 0, cv.width)); d.instances[drag].y = Math.round(clamp(p.y, 0, cv.height)); drawMap(); };
  cv.onmouseup = () => { if (drag != null) { markNeuralDirty(); drag = null; cv.style.cursor = _alTool ? 'copy' : 'grab'; } };
  cv.onmouseleave = () => { if (drag != null) { markNeuralDirty(); drag = null; } };
  cv.style.cursor = _alTool && _alTool !== 'erase' ? 'copy' : _alTool === 'erase' ? 'not-allowed' : 'grab';
}
function drawMap(liveActors) {
  const cv = document.getElementById('alCanvas'); if (!cv) return;
  const ctx = cv.getContext('2d'), d = _nnDoc, W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.015)'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  for (let x = 40; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 40; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const drawBox = (x, y, w, h, color, label, alive) => {
    ctx.globalAlpha = alive === false ? 0.18 : 1;
    ctx.fillStyle = color + '33'; ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.fillRect(x - w / 2, y - h / 2, w, h); ctx.strokeRect(x - w / 2, y - h / 2, w, h);
    if (label) { ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '10px ui-monospace,monospace'; ctx.fillText(label, x - w / 2, y - h / 2 - 3); }
    ctx.globalAlpha = 1;
  };
  if (liveActors) {
    // Visible Raycasts: draw each actor's rays under the bodies (green=clear, red=hit).
    liveActors.forEach(a => {
      if (!a.rays || !a.rays.length) return;
      a.rays.forEach(r => {
        ctx.beginPath(); ctx.moveTo(r.x, r.y); ctx.lineTo(r.ex, r.ey);
        ctx.strokeStyle = r.hit ? 'rgba(224,101,74,0.55)' : 'rgba(127,207,150,0.35)'; ctx.lineWidth = 1.5; ctx.stroke();
        if (r.hit) { ctx.beginPath(); ctx.arc(r.ex, r.ey, 2.5, 0, 7); ctx.fillStyle = 'rgba(224,101,74,0.9)'; ctx.fill(); }
      });
    });
    liveActors.forEach(a => drawBox(a.x, a.y, a.w, a.h, a.type.color || '#aaa', '', a.alive));
  } else {
    d.instances.forEach(inst => { const T = actorTypeById(inst.typeId); if (!T) return; const w = (T.body && T.body.w) || 24, h = (T.body && T.body.h) || 24; drawBox(inst.x, inst.y, w, h, T.color || '#aaa', T.name); });
  }
}
function drawActorFitChart() {
  const cv = document.getElementById('alFitChart'); if (!cv) return;
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height, hist = _nnDoc.fitHistory || [];
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  for (let i = 1; i < 3; i++) { const y = (H / 3) * i; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  if (hist.length < 2) { ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.font = '11px ui-monospace,monospace'; ctx.fillText('best fitness per generation', 10, H / 2); return; }
  const max = Math.max(...hist), min = Math.min(...hist), rng = (max - min) || 1;
  ctx.strokeStyle = '#7fcf96'; ctx.lineWidth = 2; ctx.beginPath();
  hist.forEach((v, i) => { const x = (i / (hist.length - 1)) * (W - 6) + 3; const y = H - 6 - ((v - min) / rng) * (H - 14); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '10px ui-monospace,monospace'; ctx.fillText('best ' + max.toFixed(1), 6, 12);
}

/* ---------- evolution + playback ---------- */
async function startActorEvolving() {
  if (_nnTraining) return;
  const d = _nnDoc;
  const agentTypes = d.actorTypes.filter(t => t.brain && t.brain.outputs && t.brain.outputs.length);
  if (!agentTypes.length) { toast('Give at least one actor type an AI brain first', 'close'); return; }
  if (!d.instances.some(i => agentTypes.find(t => t.id === i.typeId))) { toast('Place at least one agent on the map', 'close'); return; }
  _nnTraining = true; _nnStop = false; cancelAnimationFrame(_alRaf);
  const trainBtn = document.getElementById('alTrainBtn'), stopBtn = document.getElementById('alStopBtn'), stat = document.getElementById('alStat');
  trainBtn.disabled = true; stopBtn.disabled = false;
  const labFor = () => ({ world: d.world, actorTypes: d.actorTypes, instances: d.instances });
  const loop = async () => {
    if (_nnStop || !_nnTraining) return finishActorEvolving();
    try {
      const r = await nnRun('actorlab-evolve', { lab: labFor(), pops: d.pops || {}, cfg: { ...d.evo, seed: (Math.random() * 1e9) | 0 } });
      d.pops = r.pops; d.bestBrains = r.best; d.bestFit = r.bestFit; d.gen++;
      d.fitHistory.push(r.bestFit); if (d.fitHistory.length > 300) d.fitHistory.shift();
      stat.textContent = `gen ${d.gen} · best ${r.bestFit.toFixed(1)}`;
      drawActorFitChart();
      const wb = document.getElementById('alWatchBtn'); if (wb) wb.disabled = false;
      markNeuralDirty();
    } catch (e) { stat.textContent = 'evolve error: ' + (e && e.message); return finishActorEvolving(); }
    if ('requestAnimationFrame' in window) requestAnimationFrame(() => setTimeout(loop, 0)); else setTimeout(loop, 0);
  };
  loop();
}
function finishActorEvolving() {
  _nnTraining = false; _nnStop = false;
  const trainBtn = document.getElementById('alTrainBtn'), stopBtn = document.getElementById('alStopBtn');
  if (trainBtn) { trainBtn.disabled = false; trainBtn.innerHTML = `${svg('play', 14)} Keep evolving`; }
  if (stopBtn) stopBtn.disabled = true;
  flushNeuralSave();
}
// Replay the best brains live on the map canvas using the SAME engine, recording
// each tick and animating it so the user sees what the agents learned.
function watchActorBest() {
  const d = _nnDoc; if (!d.bestBrains || !NE) return;
  cancelAnimationFrame(_alRaf);
  const frames = [];
  const showRays = !!d.world.visibleRays;
  const lab = { world: d.world, actorTypes: d.actorTypes, instances: d.instances };
  const brains = {}; for (const k in d.bestBrains) brains[k] = Float64Array.from(d.bestBrains[k]);
  NE.actorLabEpisode(lab, brains, { record: (tick, actors) => {
    frames.push(actors.map(a => ({ x: a.x, y: a.y, w: a.w, h: a.h, alive: a.alive, type: { color: a.type.color }, rays: showRays ? (a._recRays || []).map(r => ({ x: r.x, y: r.y, ex: r.ex, ey: r.ey, hit: r.hit })) : null })));
  } });
  let f = 0;
  const stat = document.getElementById('alStat');
  const play = () => {
    if (f >= frames.length) { drawMap(); if (stat) stat.textContent = `gen ${d.gen} · best ${d.bestFit != null ? d.bestFit.toFixed(1) : '—'}`; return; }
    drawMap(frames[f]); if (stat) stat.textContent = `playing… tick ${f}/${frames.length}`;
    f += 2; _alRaf = requestAnimationFrame(play);
  };
  play();
}

/* ---------- ACTOR TYPES VIEW: list + per-type properties ---------- */
function renderTypesView(body) {
  const d = _nnDoc;
  const tid = _alTypeId && actorTypeById(_alTypeId) ? _alTypeId : (d.actorTypes[0] && d.actorTypes[0].id);
  _alTypeId = tid; const T = actorTypeById(tid);
  body.innerHTML = `
    <div class="al-types">
      <div class="al-type-list">
        <div class="al-type-list-head"><span class="eyebrow">Actor types</span><button class="btn primary sm" id="alAddType">${svg('plus', 13)} New</button></div>
        ${d.actorTypes.map(t => `<button class="al-type-item ${t.id === tid ? 'on' : ''}" data-type="${t.id}"><span class="al-swatch" style="background:${esc(t.color)}"></span><span class="al-ti-name">${esc(t.name)}</span>${t.isAgent ? '<span class="al-agent-tag">AI</span>' : ''}</button>`).join('')}
      </div>
      <div class="al-type-edit" id="alTypeEdit">${T ? actorTypeEditHTML(T) : '<div class="dim mono pad-sm">No actor type selected.</div>'}</div>
    </div>`;
  body.querySelector('#alAddType').onclick = addActorType;
  body.querySelectorAll('[data-type]').forEach(b => b.onclick = () => { _alTypeId = b.dataset.type; renderActorLab(); });
  if (T) wireActorTypeEdit(T);
}
function actorTypeEditHTML(T) {
  return `
    <div class="al-te-head">
      <input class="al-te-name" id="teName" value="${esc(T.name)}" spellcheck="false">
      <div class="al-te-colors">${ACTOR_PALETTE.map(c => `<button class="al-color ${c === T.color ? 'on' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}</div>
      <button class="btn ghost sm danger" id="teDelete" title="Delete type">${svg('trash', 13)}</button>
    </div>
    <div class="al-te-grid">
      <div class="nn-panel">
        <div class="nn-panel-h">${svg('grid', 14)} Physics body</div>
        <label class="al-row">Body type
          <select class="set-select" id="teBody">
            <option value="dynamic" ${T.body.mode === 'dynamic' ? 'selected' : ''}>Dynamic (moves, collides)</option>
            <option value="static" ${T.body.mode === 'static' ? 'selected' : ''}>Static (solid, immovable)</option>
            <option value="none" ${T.body.mode === 'none' ? 'selected' : ''}>None (no collision)</option>
          </select>
        </label>
        <div class="al-row2"><label>Width<input type="number" id="teW" min="6" max="400" step="2" value="${T.body.w}"></label><label>Height<input type="number" id="teH" min="6" max="400" step="2" value="${T.body.h}"></label></div>
      </div>
      <div class="nn-panel">
        <div class="nn-panel-h">${svg('info', 14)} Variables</div>
        <div class="al-vars" id="teVars">${(T.vars || []).map((v, i) => `<div class="al-var-row"><input class="al-var-name" data-vi="${i}" value="${esc(v.name)}" spellcheck="false" placeholder="name"><input class="al-var-init" type="number" data-vi="${i}" value="${v.init}" step="0.1"><button class="al-var-del" data-vdel="${i}">${svg('close', 12)}</button></div>`).join('')}</div>
        <button class="btn ghost sm" id="teAddVar">${svg('plus', 12)} Add variable</button>
        <p class="nn-panel-p mono dim" style="margin-top:8px">Tip: a Dynamic body uses <b>velX</b>/<b>velY</b> to move each tick.</p>
      </div>
      <div class="nn-panel">
        <div class="nn-panel-h">${svg('brain', 14)} AI brain</div>
        <label class="al-check"><input type="checkbox" id="teBrain" ${T.brain ? 'checked' : ''}> This actor has an AI brain (it will be trained)</label>
        <div id="teBrainCfg" class="${T.brain ? '' : 'hidden'}">
          <div class="al-row2"><label>Inputs (count)<input type="number" id="teIn" min="1" max="24" step="1" value="${T.brain ? (T.brain.inputs || []).length : 3}"></label><label>Outputs (count)<input type="number" id="teOut" min="1" max="12" step="1" value="${T.brain ? (T.brain.outputs || []).length : 2}"></label></div>
          <label class="al-row">Hidden layers<input type="text" id="teHidden" value="${T.brain ? (T.brain.hidden || []).join(', ') : '10, 8'}" placeholder="10, 8"></label>
          <p class="nn-panel-p mono dim">Feed inputs with <b>Brain Input</b> nodes (#0…) and read results with <b>Brain Output</b> nodes in the graph.</p>
        </div>
      </div>
    </div>
    <div class="al-te-actions">
      <button class="btn primary" id="teEditGraph">${svg('plug', 14)} Edit ${esc(T.name)}'s node graph ${svg('back', 12, 2)}</button>
      <span class="mono dim">${(T.graph.nodes || []).length} nodes · ${(T.graph.edges || []).length} wires</span>
    </div>`;
}
function wireActorTypeEdit(T) {
  const root = document.getElementById('alTypeEdit');
  root.querySelector('#teName').oninput = (e) => { T.name = e.target.value.slice(0, 40); markNeuralDirty(); };
  root.querySelectorAll('[data-color]').forEach(b => b.onclick = () => { T.color = b.dataset.color; root.querySelectorAll('[data-color]').forEach(x => x.classList.toggle('on', x === b)); markNeuralDirty(); });
  root.querySelector('#teDelete').onclick = () => deleteActorType(T.id);
  root.querySelector('#teBody').onchange = (e) => { T.body.mode = e.target.value; markNeuralDirty(); };
  root.querySelector('#teW').onchange = (e) => { T.body.w = clamp(+e.target.value, 6, 400); markNeuralDirty(); };
  root.querySelector('#teH').onchange = (e) => { T.body.h = clamp(+e.target.value, 6, 400); markNeuralDirty(); };
  root.querySelector('#teAddVar').onclick = () => { T.vars = T.vars || []; T.vars.push({ name: 'var' + (T.vars.length + 1), init: 0 }); markNeuralDirty(); renderActorLab(); };
  root.querySelectorAll('.al-var-name').forEach(inp => inp.onchange = () => { T.vars[+inp.dataset.vi].name = inp.value.replace(/[^\w]/g, '').slice(0, 20) || 'v'; markNeuralDirty(); });
  root.querySelectorAll('.al-var-init').forEach(inp => inp.onchange = () => { T.vars[+inp.dataset.vi].init = +inp.value || 0; markNeuralDirty(); });
  root.querySelectorAll('[data-vdel]').forEach(b => b.onclick = () => { T.vars.splice(+b.dataset.vdel, 1); markNeuralDirty(); renderActorLab(); });
  const brainCb = root.querySelector('#teBrain');
  brainCb.onchange = () => {
    if (brainCb.checked) { T.brain = T.brain || { hidden: [10, 8], act: 'tanh', inputs: ['in0', 'in1', 'in2'], outputs: ['out0', 'out1'] }; T.isAgent = true; }
    else { T.brain = null; T.isAgent = false; }
    markNeuralDirty(); renderActorLab();
  };
  if (T.brain) {
    root.querySelector('#teIn').onchange = (e) => { const n = clamp(+e.target.value, 1, 24); T.brain.inputs = Array.from({ length: n }, (_, i) => (T.brain.inputs && T.brain.inputs[i]) || ('in' + i)); markNeuralDirty(); };
    root.querySelector('#teOut').onchange = (e) => { const n = clamp(+e.target.value, 1, 12); T.brain.outputs = Array.from({ length: n }, (_, i) => (T.brain.outputs && T.brain.outputs[i]) || ('out' + i)); markNeuralDirty(); };
    root.querySelector('#teHidden').onchange = (e) => { T.brain.hidden = e.target.value.split(',').map(x => parseInt(x.trim(), 10)).filter(n => n > 0).slice(0, 4); e.target.value = T.brain.hidden.join(', '); markNeuralDirty(); };
  }
  root.querySelector('#teEditGraph').onclick = () => { _alView = 'graph'; renderActorLab(); };
}
function addActorType() {
  const d = _nnDoc;
  const id = 'ty_' + nnUid();
  d.actorTypes.push({ id, name: 'Actor ' + (d.actorTypes.length + 1), color: ACTOR_PALETTE[d.actorTypes.length % ACTOR_PALETTE.length], isAgent: false, vars: [], body: { mode: 'dynamic', w: 24, h: 24 }, brain: null, graph: { nodes: [], edges: [] } });
  _alTypeId = id; markNeuralDirty(); renderActorLab();
}
function deleteActorType(id) {
  const d = _nnDoc;
  if (d.actorTypes.length <= 1) { toast('Keep at least one actor type', 'close'); return; }
  if (!confirm('Delete this actor type and all its instances on the map?')) return;
  d.actorTypes = d.actorTypes.filter(t => t.id !== id);
  d.instances = d.instances.filter(i => i.typeId !== id);
  if (d.pops) delete d.pops[id];
  _alTypeId = d.actorTypes[0] && d.actorTypes[0].id;
  markNeuralDirty(); renderActorLab();
}

/* ============================================================
   NODE-GRAPH EDITOR — the per-actor-type Blueprint canvas.
   Nodes are absolutely-positioned cards on a pannable surface; wires are an SVG
   overlay. Two pin kinds: WHITE action (exec) pins that thread the run order, and
   typed DATA pins (green=number, red=boolean) that carry values. Drag from an
   output pin to a matching input pin — connections are STRICT (same kind, and for
   data, same type). Branch splits the action flow into True / False outputs.
   ============================================================ */
let _ngWire = null;     // in-progress wire drag { from, kind, ptype, fromPort, x, y }

function renderGraphView(body) {
  const T = actorTypeById(_alTypeId);
  if (!T) { _alView = 'type'; return renderActorLab(); }
  body.innerHTML = `
    <div class="ng-wrap">
      <div class="ng-bar">
        <button class="btn ghost sm" id="ngBack">${svg('back', 13)} ${esc(T.name)} properties</button>
        <div class="ng-title"><span class="al-swatch" style="background:${esc(T.color)}"></span>${esc(T.name)} · node graph</div>
        <div class="spacer"></div>
        <span class="ng-legend mono"><span class="ng-leg"><i style="background:#e8e8e8"></i>action</span><span class="ng-leg"><i style="background:#7fcf96"></i>number</span><span class="ng-leg"><i style="background:#e0654a"></i>boolean</span></span>
        <button class="btn ghost sm" id="ngAdd">${svg('plus', 13)} Add node</button>
      </div>
      <div class="ng-surface" id="ngSurface">
        <svg class="ng-wires" id="ngWires"></svg>
        <div class="ng-nodes" id="ngNodes"></div>
      </div>
    </div>`;
  body.querySelector('#ngBack').onclick = () => { _alView = 'type'; renderActorLab(); };
  body.querySelector('#ngAdd').onclick = (e) => openNodePalette(e.clientX, e.clientY, T);
  // right-click the empty surface to add a node there too
  const surface = body.querySelector('#ngSurface');
  surface.oncontextmenu = (e) => { if (e.target === surface || e.target.id === 'ngNodes' || e.target.id === 'ngWires') { e.preventDefault(); openNodePalette(e.clientX, e.clientY, T); } };
  renderNodes(T); drawWires(T);
}

function renderNodes(T) {
  const host = document.getElementById('ngNodes'); if (!host) return;
  const g = T.graph;
  host.innerHTML = (g.nodes || []).map(n => nodeCardHTML(n, T)).join('');
  host.querySelectorAll('.ng-node').forEach(el => wireNodeCard(el, T));
}
function nodeCardHTML(n, T) {
  const spec = NODE_CATALOG[n.t] || { label: n.t, cat: '?' };
  const execIn = nodeHasExecIn(n.t), execOuts = nodeExecOuts(n.t);
  const dataIns = nodeDataIns(n.t), dataOut = nodeDataOut(n.t);
  const fields = (spec.fields || []).map(f => fieldHTML(n, f, T)).join('');
  // left column: exec-in pin (white) on top, then typed data-in pins
  const leftPins = (execIn ? `<div class="ng-port in exec" data-pk="exec" data-port="exec" data-node="${n.id}" title="action in"><span class="ng-dot" style="--pc:${PIN_TYPES.exec.color}"></span><span class="ng-plabel">▶</span></div>` : '')
    + dataIns.map(([p, ty]) => `<div class="ng-port in data" data-pk="data" data-ptype="${ty}" data-port="${p}" data-node="${n.id}" title="${PIN_TYPES[ty] ? PIN_TYPES[ty].label : ty}"><span class="ng-dot" style="--pc:${(PIN_TYPES[ty] || {}).color || '#aaa'}"></span><span class="ng-plabel">${esc(p)}</span></div>`).join('');
  // right column: exec-out pins (white) then a single typed data-out
  const rightPins = execOuts.map(po => `<div class="ng-port out exec" data-pk="exec" data-fromport="${po}" data-node="${n.id}" title="action out"><span class="ng-plabel">${po === 'exec' ? '▶' : esc(po)}</span><span class="ng-dot" style="--pc:${PIN_TYPES.exec.color}"></span></div>`).join('')
    + (dataOut ? `<div class="ng-port out data" data-pk="data" data-ptype="${dataOut}" data-fromport="out" data-node="${n.id}" title="${PIN_TYPES[dataOut] ? PIN_TYPES[dataOut].label : dataOut}"><span class="ng-plabel">${PIN_TYPES[dataOut] ? PIN_TYPES[dataOut].label : 'out'}</span><span class="ng-dot" style="--pc:${(PIN_TYPES[dataOut] || {}).color || '#aaa'}"></span></div>` : '');
  return `<div class="ng-node cat-${spec.cat}" data-node="${n.id}" style="left:${n.x}px;top:${n.y}px">
    <div class="ng-node-head"><span class="ng-node-name">${esc(spec.label)}</span><button class="ng-node-del" data-ndel="${n.id}" title="Delete">${svg('close', 11)}</button></div>
    <div class="ng-node-body">
      <div class="ng-ports-in">${leftPins}</div>
      ${fields ? `<div class="ng-fields">${fields}</div>` : ''}
      <div class="ng-ports-out">${rightPins}</div>
    </div>
  </div>`;
}
function fieldHTML(n, f, T) {
  if (f.t === 'num' || f.t === 'int') return `<label class="ng-field"><span>${esc(f.label)}</span><input type="number" data-field="${f.k}" value="${n[f.k] ?? 0}" step="${f.t === 'int' ? 1 : 'any'}"></label>`;
  if (f.t === 'bool') return `<label class="ng-field bool"><span>${esc(f.label)}</span><select data-field="${f.k}"><option value="1" ${n[f.k] ? 'selected' : ''}>true</option><option value="0" ${!n[f.k] ? 'selected' : ''}>false</option></select></label>`;
  if (f.t === 'sel') return `<label class="ng-field"><span>${esc(f.label)}</span><select data-field="${f.k}">${f.opts.map(o => `<option value="${o}" ${n[f.k] === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
  if (f.t === 'var') { const vars = (T.vars || []).map(v => v.name); return `<label class="ng-field"><span>${esc(f.label)}</span><select data-field="${f.k}">${vars.length ? vars.map(v => `<option value="${v}" ${n[f.k] === v ? 'selected' : ''}>${esc(v)}</option>`).join('') : '<option value="">(add a variable)</option>'}</select></label>`; }
  if (f.t === 'type') { const types = (_nnDoc.actorTypes || []).map(t => t.name); return `<label class="ng-field"><span>${esc(f.label)}</span><select data-field="${f.k}">${types.map(t => `<option value="${esc(t)}" ${n[f.k] === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`; }
  return '';
}
function wireNodeCard(el, T) {
  const id = el.dataset.node, n = T.graph.nodes.find(x => x.id === id);
  const head = el.querySelector('.ng-node-head');
  head.onmousedown = (e) => {
    if (e.target.closest('.ng-node-del')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y;
    const move = (ev) => { n.x = Math.max(0, ox + (ev.clientX - sx)); n.y = Math.max(0, oy + (ev.clientY - sy)); el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; drawWires(T); };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); markNeuralDirty(); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  };
  el.querySelector('[data-ndel]').onclick = () => { T.graph.nodes = T.graph.nodes.filter(x => x.id !== id); T.graph.edges = T.graph.edges.filter(e => e.from !== id && e.to !== id); markNeuralDirty(); renderNodes(T); drawWires(T); };
  el.querySelectorAll('[data-field]').forEach(inp => inp.onchange = () => {
    const k = inp.dataset.field; let v = inp.value;
    if (inp.type === 'number') v = +v || 0;
    else if (k === 'v' && (n.t === 'bool')) v = +v ? 1 : 0;
    n[k] = v; markNeuralDirty();
  });
  // start a wire from any OUTPUT port (exec or data), carrying its kind+type
  el.querySelectorAll('.ng-port.out').forEach(p => p.onmousedown = (e) => {
    e.preventDefault(); e.stopPropagation();
    startWire({ from: id, kind: p.dataset.pk, ptype: p.dataset.ptype, fromPort: p.dataset.fromport }, T);
  });
  // finish on any matching INPUT port
  el.querySelectorAll('.ng-port.in').forEach(p => p.onmouseup = (e) => { if (_ngWire) { e.stopPropagation(); finishWire(p, T); } });
}
function startWire(src, T) {
  _ngWire = src;   // { from, kind:'exec'|'data', ptype, fromPort }
  const surface = document.getElementById('ngSurface');
  highlightCompatible(src, true);
  const move = (e) => { const r = surface.getBoundingClientRect(); _ngWire.x = e.clientX - r.left + surface.scrollLeft; _ngWire.y = e.clientY - r.top + surface.scrollTop; drawWires(T); };
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); highlightCompatible(src, false); setTimeout(() => { _ngWire = null; drawWires(T); }, 0); };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
}
// STRICT typing: an input accepts a wire only if same kind, and for data, same type.
function portCompatible(src, inEl) {
  if (!src) return false;
  const kind = inEl.dataset.pk;
  if (src.kind !== kind) return false;
  if (kind === 'data' && src.ptype !== inEl.dataset.ptype) return false;
  if (inEl.dataset.node === src.from) return false;    // no self-wires
  return true;
}
function highlightCompatible(src, on) {
  document.querySelectorAll('.ng-port.in').forEach(p => p.classList.toggle('ok', on && portCompatible(src, p)));
}
function finishWire(inEl, T) {
  const src = _ngWire; _ngWire = null;
  if (!src || !portCompatible(src, inEl)) { drawWires(T); return; }
  const toId = inEl.dataset.node, toPort = src.kind === 'exec' ? 'exec' : inEl.dataset.port;
  if (src.kind === 'exec') {
    // one wire per exec OUTPUT pin (a pin fans to exactly one next node)
    T.graph.edges = T.graph.edges.filter(e => !(e.from === src.from && (e.fromPort || 'exec') === src.fromPort && (e.toPort || '') === 'exec'));
  } else {
    // one wire per data INPUT port
    T.graph.edges = T.graph.edges.filter(e => !(e.to === toId && (e.toPort || e.port || 'in') === toPort));
  }
  T.graph.edges.push({ from: src.from, fromPort: src.fromPort, to: toId, toPort });
  markNeuralDirty(); renderNodes(T); drawWires(T);
}
function portCenter(nodeId, side, port) {
  let sel;
  if (side === 'out') sel = `.ng-node[data-node="${nodeId}"] .ng-port.out[data-fromport="${port}"] .ng-dot`;
  else sel = `.ng-node[data-node="${nodeId}"] .ng-port.in[data-port="${port}"] .ng-dot`;
  const dot = document.querySelector(sel), surface = document.getElementById('ngSurface');
  if (!dot || !surface) return null;
  const r = dot.getBoundingClientRect(), sr = surface.getBoundingClientRect();
  return { x: r.left + r.width / 2 - sr.left + surface.scrollLeft, y: r.top + r.height / 2 - sr.top + surface.scrollTop };
}
function edgeColor(e, T) {
  const toPort = e.toPort || e.port || 'in';
  if (toPort === 'exec') return PIN_TYPES.exec.color;
  // color a data wire by the destination port's declared type
  const toNode = T.graph.nodes.find(n => n.id === e.to);
  if (toNode) { const di = nodeDataIns(toNode.t).find(([p]) => p === toPort); if (di) return (PIN_TYPES[di[1]] || {}).color || '#aaa'; }
  return '#aaa';
}
function drawWires(T) {
  const svgEl = document.getElementById('ngWires'); if (!svgEl) return;
  const surface = document.getElementById('ngSurface');
  svgEl.setAttribute('width', surface.scrollWidth); svgEl.setAttribute('height', surface.scrollHeight);
  let html = '';
  for (const e of T.graph.edges || []) {
    const a = portCenter(e.from, 'out', e.fromPort || 'out'), b = portCenter(e.to, 'in', e.toPort || e.port || 'in');
    if (!a || !b) continue;
    html += wirePath(a, b, e, edgeColor(e, T));
  }
  if (_ngWire && _ngWire.x != null) { const a = portCenter(_ngWire.from, 'out', _ngWire.fromPort); const col = _ngWire.kind === 'exec' ? PIN_TYPES.exec.color : (PIN_TYPES[_ngWire.ptype] || {}).color || '#aaa'; if (a) html += `<path d="${bezier(a, { x: _ngWire.x, y: _ngWire.y })}" stroke="${col}" stroke-width="2.5" stroke-dasharray="5 4" opacity="0.8" fill="none"/>`; }
  svgEl.innerHTML = html;
  svgEl.querySelectorAll('[data-edge]').forEach(p => p.onclick = () => { const [from, fromPort, to, toPort] = p.dataset.edge.split('|'); T.graph.edges = T.graph.edges.filter(e => !(e.from === from && (e.fromPort || 'out') === fromPort && e.to === to && (e.toPort || e.port || 'in') === toPort)); markNeuralDirty(); drawWires(T); });
}
function bezier(a, b) { const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5); return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`; }
function wirePath(a, b, e, color) {
  const d = bezier(a, b);
  const key = `${e.from}|${e.fromPort || 'out'}|${e.to}|${e.toPort || e.port || 'in'}`;
  return `<path d="${d}" class="ng-wire-hit" fill="none" data-edge="${key}"/><path d="${d}" stroke="${color}" stroke-width="2.5" opacity="0.9" fill="none"/>`;
}

/* node palette popover — pick a node type to add at (clientX, clientY) */
function openNodePalette(cx, cy, T) {
  closeNodePalette();
  const pop = document.createElement('div'); pop.className = 'ng-palette'; pop.id = 'ngPalette';
  pop.innerHTML = `<div class="ng-pal-head">Add node</div>` + NODE_CATS.map(cat => {
    const items = Object.entries(NODE_CATALOG).filter(([, s]) => s.cat === cat);
    return `<div class="ng-pal-cat"><span class="eyebrow">${cat}</span><div class="ng-pal-items">${items.map(([t, s]) => `<button class="ng-pal-item" data-add="${t}" title="${esc(s.desc || '')}">${esc(s.label)}</button>`).join('')}</div></div>`;
  }).join('');
  document.body.appendChild(pop);
  const vw = window.innerWidth, vh = window.innerHeight, r = pop.getBoundingClientRect();
  pop.style.left = Math.min(cx, vw - r.width - 12) + 'px';
  pop.style.top = Math.min(cy, vh - r.height - 12) + 'px';
  // place new node near the surface center / click point
  const surface = document.getElementById('ngSurface'); const sr = surface.getBoundingClientRect();
  const nx = Math.max(10, cx - sr.left + surface.scrollLeft - 60), ny = Math.max(10, cy - sr.top + surface.scrollTop - 20);
  pop.querySelectorAll('[data-add]').forEach(b => b.onclick = () => { addNode(b.dataset.add, nx, ny, T); closeNodePalette(); });
  setTimeout(() => document.addEventListener('mousedown', paletteOutside), 0);
}
function paletteOutside(e) { if (!e.target.closest('#ngPalette')) closeNodePalette(); }
function closeNodePalette() { const p = document.getElementById('ngPalette'); if (p) p.remove(); document.removeEventListener('mousedown', paletteOutside); }
function addNode(t, x, y, T) {
  const spec = NODE_CATALOG[t]; if (!spec) return;
  const n = { id: 'nd' + nnUid(), t, x: Math.round(x), y: Math.round(y) };
  (spec.fields || []).forEach(f => {
    n[f.k] = f.t === 'var' ? ((T.vars[0] && T.vars[0].name) || '')
      : f.t === 'type' ? ((_nnDoc.actorTypes[0] && _nnDoc.actorTypes[0].name) || '')
      : f.t === 'sel' ? f.opts[0]
      : f.t === 'bool' ? 0
      : f.k === 'v' && t === 'const' ? 1 : 0;
  });
  T.graph.nodes.push(n); markNeuralDirty(); renderNodes(T); drawWires(T);
}

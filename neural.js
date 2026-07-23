/* ============================================================
   NEURAL — the "train an LLM from the ground up" app (frontend controller).

   You BUILD a language model from scratch: a create wizard walks you through the
   architecture (tokenizer, context length, embedding dim, activation, dropout, and
   the hidden layer stack). Each model then opens on a three-tab workspace:

     • DATA      — pre-training samples + fine-tuning sets. Add/paste/upload text, or
                   STACK data in from any template or any model you already own.
     • TRAINING  — pick an optimizer (AdamW / RAdam / Lion / LAMB / SGD) with learning
                   rate, batch size, epochs and a seed; watch the live loss curve.
                   Bottom of the tab: UPGRADE — re-run the architecture wizard on an
                   existing model, keeping all its data (fix overfit / resize).
     • INFERENCE — a chat room. Talk to your creation as it was trained.

   TEMPLATES are pre-built, untrained models (optimized structure + all the data they
   need) — you just train and test. Everything is saved to your encrypted vault.

   Compute runs on THIS DEVICE by default; if the account has backend compute enabled
   (can_neural_backend) a model can be flipped to train on the SERVER. The math lives
   in neural-engine.js (window.NeuralEngine), shared verbatim with the backend and the
   iOS app.
   ============================================================ */

const NE = (typeof window !== 'undefined' && window.NeuralEngine) || null;
let _nnNetworks = [];          // {id, kind, name, updated} list
let _nnCaps = { backend: false };
let _nnDoc = null;             // the open model document (full data)
let _nnId = null;              // open model id
let _nnView = 'home';          // 'home' | 'wizard' | 'workspace'
let _nnTab = 'data';           // active workspace tab
let _nnDirty = false, _nnSaveTimer = null, _nnTraining = false, _nnStop = false;
let _nnWizard = null;          // in-progress wizard state (arch being built)

function nnUid() { return (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)); }

/* ---------- entry ---------- */
function neuralHTML() {
  return `<div class="nn-app" id="nnApp"><div class="dim mono pad-sm">Loading…</div></div>`;
}
async function wireNeural() {
  _nnView = 'home'; _nnDoc = null; _nnId = null; _nnDirty = false; _nnTraining = false;
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

/* ============================================================
   HOME — your models + the template gallery + a "New model" button
   ============================================================ */
function renderNeuralHome() {
  _nnView = 'home'; _nnDoc = null; _nnId = null;
  const app = document.getElementById('nnApp'); if (!app) return;
  const yours = _nnNetworks.length ? `
      <div class="nn-card-grid">${_nnNetworks.map(nnSavedCardHTML).join('')}</div>`
    : `<div class="nn-none mono dim">No models yet. Start from a template below, or build one from scratch — everything you make is saved to your encrypted vault.</div>`;
  app.innerHTML = `
    <div class="nn-home">
      <div class="nn-hero">
        <div class="nn-hero-ico bg-audio t-audio">${svg('brain', 30, 1.6)}</div>
        <div class="nn-hero-txt">
          <div class="nn-hero-h">Neural</div>
          <div class="nn-hero-s mono">Train a language model from the ground up, then chat with it.</div>
        </div>
        <div class="nn-compute-note mono ${_nnCaps.backend ? 'on' : ''}">${_nnCaps.backend ? svg('check', 13) + ' Backend compute enabled' : svg('info', 13) + ' Trains on this device'}</div>
      </div>

      <div class="nn-sec">
        <div class="nn-sec-head"><span class="eyebrow">Your models</span>
          <button class="btn primary sm" id="nnCreateBtn">${svg('plus', 14)} New model</button></div>
        ${yours}
      </div>

      <div class="nn-sec">
        <span class="eyebrow">Templates — pre-built, ready to train</span>
        <div class="nn-tpl-grid">${NN_TEMPLATES.map(nnTemplateCardHTML).join('')}</div>
      </div>
    </div>`;
  app.querySelector('#nnCreateBtn').onclick = () => startWizard(null);
  app.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openNetwork(b.dataset.open));
  app.querySelectorAll('[data-del]').forEach(b => b.onclick = (e) => { e.stopPropagation(); removeNetwork(b.dataset.del); });
  app.querySelectorAll('[data-tpl]').forEach(b => b.onclick = () => createFromTemplate(b.dataset.tpl));
}
function nnSavedCardHTML(n) {
  const d = n.data || {};
  const arch = d.arch || {};
  const trained = d.trainState && d.trainState.steps ? `${d.trainState.steps.toLocaleString()} steps` : 'untrained';
  const sub = `${(arch.tokMode || 'char')} · ${trained}`;
  return `<div class="nn-saved-card" data-open="${n.id}">
    <span class="nsc-ico bg-audio t-audio">${svg('brain', 18, 1.7)}</span>
    <span class="nsc-main">
      <span class="nsc-name">${esc(n.name)}</span>
      <span class="nsc-sub mono">${sub} · ${fmtDate(n.updated)}</span>
    </span>
    <button class="nsc-del" data-del="${n.id}" title="Delete">${svg('trash', 14)}</button>
  </div>`;
}
function nnTemplateCardHTML(t) {
  return `<button class="nn-tpl-card" data-tpl="${t.id}">
    <span class="nnt-ico bg-${t.tint} t-${t.tint}">${svg(t.icon, 22, 1.6)}</span>
    <span class="nnt-h">${esc(t.name)}</span>
    <span class="nnt-s">${esc(t.desc)}</span>
    <span class="nnt-meta mono">${t.arch.tokMode} · ctx ${t.arch.ctx} · dim ${t.arch.embed} · ${(t.pretrain.length + t.finetune.length)} data sets</span>
    <span class="nnt-go">Use template ${svg('back', 12, 2)}</span>
  </button>`;
}

/* ============================================================
   CREATE / OPEN / DELETE / PERSISTENCE
   A model document:
     { arch:{tokMode,maxVocab,ctx,embed,act,dropout,layers[]}, compute,
       data:{ pretrain:[{id,name,text}], finetune:[{id,name,text}] },
       model:<llm weights|null>, tok:<tokenizer|null>,
       trainState:{ steps, lossHistory:[], opt:{kind,lr,batch,epochs,seed} },
       __name, __kind }
   ============================================================ */
function freshDoc(arch, name) {
  return {
    __name: name || 'New model', __kind: 'llm2', compute: 'client',
    arch: arch || defaultArch(),
    data: { pretrain: [], finetune: [] },
    model: null, tok: null,
    trainState: { steps: 0, lossHistory: [], opt: { kind: 'adamw', lr: 0.003, batch: 8, epochs: 1, seed: (Math.random() * 1e9) | 0 } },
  };
}
function defaultArch() {
  return { tokMode: 'char', maxVocab: 512, ctx: 64, embed: 48, act: 'gelu', dropout: 0.0, layers: [96, 96] };
}

/* ============================================================
   CHAT TEMPLATE — the ONE schema used for BOTH fine-tuning and inference, so the
   model is trained on exactly the format it's later prompted with. Each turn is one
   JSON object on its own line (JSONL), e.g.
       {"role":"user","content":"Hi"}
       {"role":"assistant","content":"Hello! How can I help?"}
   A conversation is BOS-wrapped and turns are newline-separated. At inference we feed
   the history + an OPEN assistant turn and stop as soon as the model closes it.
   ============================================================ */
const CHAT = {
  // one turn -> a JSON line. We keep it compact (no spaces) so a small model spends its
  // tokens on words, not whitespace.
  turnLine: (role, content) => JSON.stringify({ role, content }),
  // the exact prefix we hand the model to make it BEGIN an assistant reply. The model
  // has learned to continue from here with the content then `"}`.
  assistantOpen: '{"role":"assistant","content":"',
  // generation stops the moment the model emits this (the close of the JSON string+obj).
  stop: '"}',
};
/* Serialize a whole conversation (array of {role,content}) to the training text. */
function chatSerializeConversation(turns) {
  return (turns || []).filter(t => t && t.content != null && String(t.content).trim())
    .map(t => CHAT.turnLine(t.role === 'assistant' ? 'assistant' : 'user', String(t.content))).join('\n');
}
/* Build the inference PROMPT: the recent history serialized, then an open assistant
   turn for the model to complete. `history` is [{role,content}] (UI messages). */
function chatBuildPrompt(history, maxTurns) {
  const recent = (history || []).slice(-(maxTurns || 8));
  const lines = recent.map(m => CHAT.turnLine(m.role === 'assistant' ? 'assistant' : 'user', String(m.content)));
  lines.push(CHAT.assistantOpen);   // no trailing newline: the model continues THIS line
  return lines.join('\n');
}
/* Given the raw model output that FOLLOWS assistantOpen, extract the assistant's reply:
   everything up to the stop sequence, JSON-unescaped. Falls back gracefully. */
function chatExtractReply(raw) {
  let s = String(raw || '');
  const stopAt = s.indexOf(CHAT.stop);
  if (stopAt >= 0) s = s.slice(0, stopAt);
  // also cut if the model ran into the next turn instead of stopping cleanly
  const nextTurn = s.indexOf('{"role"');
  if (nextTurn >= 0) s = s.slice(0, nextTurn);
  s = s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
  return s;
}
/* JSONL <-> conversation turns, for the paste/import escape hatch. Blank line = new
   conversation boundary; returns {conversations:[[turns]], errors:[...]}. */
function chatParseJSONL(text) {
  const conversations = [], errors = [];
  let cur = [];
  const lines = String(text || '').split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) { if (cur.length) { conversations.push(cur); cur = []; } return; }
    let obj;
    try { obj = JSON.parse(t); } catch (e) { errors.push(`Line ${i + 1}: not valid JSON`); return; }
    // accept {role,content} OR the shorthand {"User":"…"} / {"AI":"…"}
    let role, content;
    if (obj.role && obj.content != null) { role = obj.role; content = obj.content; }
    else if (obj.User != null) { role = 'user'; content = obj.User; }
    else if (obj.AI != null || obj.Assistant != null) { role = 'assistant'; content = obj.AI ?? obj.Assistant; }
    else { errors.push(`Line ${i + 1}: expected {"role","content"} or {"User"/"AI":…}`); return; }
    role = (String(role).toLowerCase().startsWith('a')) ? 'assistant' : 'user';
    cur.push({ role, content: String(content) });
  });
  if (cur.length) conversations.push(cur);
  return { conversations, errors };
}
function chatToJSONL(turns) {
  return (turns || []).map(t => CHAT.turnLine(t.role === 'assistant' ? 'assistant' : 'user', String(t.content))).join('\n');
}

async function openNetwork(id) {
  await flushNeuralSave();
  let net; try { net = await getNetwork(id); } catch (e) { toast('Could not open model', 'close'); return; }
  _nnId = id; _nnDoc = migrateDoc(net.data) || freshDoc();
  _nnDoc.__name = net.name; _nnDoc.__kind = net.kind || 'llm2';
  _nnStop = false; _nnDirty = false; _nnTab = 'data';
  openWorkspace();
}
// tolerate older/foreign docs — always land on the current shape.
function migrateDoc(d) {
  if (!d || typeof d !== 'object') return null;
  d.arch = Object.assign(defaultArch(), d.arch || {});
  d.data = d.data || { pretrain: [], finetune: [] };
  d.data.pretrain = d.data.pretrain || []; d.data.finetune = d.data.finetune || [];
  // Fine-tune sets are now CONVERSATIONS ({id,name,turns:[{role,content}]}). Migrate any
  // old free-text finetune set into a single user→assistant turn pair so nothing is lost.
  d.data.finetune = d.data.finetune.map(s => {
    if (Array.isArray(s.turns)) return s;
    const t = (s.text || '').trim();
    return { id: s.id || nnUid(), name: s.name || 'Conversation', turns: t ? [{ role: 'user', content: t }] : [] };
  });
  d.trainState = d.trainState || { steps: 0, lossHistory: [], opt: { kind: 'adamw', lr: 0.003, batch: 8, epochs: 1, seed: 1 } };
  d.trainState.opt = Object.assign({ kind: 'adamw', lr: 0.003, batch: 8, epochs: 1, seed: 1 }, d.trainState.opt || {});
  d.trainState.lossHistory = d.trainState.lossHistory || [];
  if (d.compute !== 'backend') d.compute = 'client';
  return d;
}
async function createModelDoc(doc) {
  try {
    const payload = { ...doc }; const name = doc.__name; delete payload.__name; delete payload.__kind;
    const n = await createNetwork({ kind: 'llm2', name, data: payload });
    await refreshNeuralList();
    openNetwork(n.id);
  } catch (e) { toast('Could not create model', 'close'); }
}
async function createFromTemplate(tplId) {
  const t = NN_TEMPLATES.find(x => x.id === tplId); if (!t) return;
  const doc = freshDoc(JSON.parse(JSON.stringify(t.arch)), t.name);
  doc.data.pretrain = t.pretrain.map(s => ({ id: nnUid(), name: s.name, text: s.text }));
  doc.data.finetune = (t.finetune || []).map(s => ({ id: nnUid(), name: s.name, turns: (s.turns || []).map(x => ({ ...x })) }));
  await createModelDoc(doc);
}
async function removeNetwork(id) {
  const n = _nnNetworks.find(x => x.id === id);
  if (!confirm(`Delete "${n ? n.name : 'this model'}"? This permanently removes the saved model and its data.`)) return;
  try { await deleteNetwork(id); } catch (e) {}
  if (_nnId === id) { _nnId = null; _nnDoc = null; }
  await refreshNeuralList();
  toast('Model deleted', 'trash');
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
    await updateNetwork(_nnId, { name: _nnDoc.__name || 'Untitled model', data: payload });
    const st = document.getElementById('nnSaveStatus'); if (st) { st.textContent = 'saved'; st.classList.add('saved'); }
    const i = _nnNetworks.findIndex(x => x.id === _nnId); if (i >= 0) { _nnNetworks[i].name = _nnDoc.__name; _nnNetworks[i].updated = Date.now(); _nnNetworks[i].data = payload; }
  } catch (e) {
    _nnDirty = true;
    const st = document.getElementById('nnSaveStatus'); if (st) { st.textContent = (e && e.status === 413) ? 'too large to save' : 'save failed'; st.classList.remove('saved'); }
  }
}
async function saveNeuralNow() {
  _nnDirty = true; clearTimeout(_nnSaveTimer);
  const st = document.getElementById('nnSaveStatus'); if (st) st.textContent = 'saving…';
  await flushNeuralSave();
  if (!_nnDirty) toast('Saved to your vault', 'save');
}

// run a compute op client-side (NeuralEngine) or on the backend, per compute setting.
async function nnRun(op, payload) {
  if (_nnDoc && _nnDoc.compute === 'backend' && _nnCaps.backend) {
    let p = payload;
    if (payload && payload.opt && (payload.opt.mom || payload.opt.vel)) {
      const { mom, vel, ...rest } = payload.opt; p = { ...payload, opt: rest };
    }
    return await neuralCompute({ op, ...p });
  }
  return NE.neuralCompute({ op, ...payload });
}

/* ============================================================
   THE CREATE WIZARD — a few pages of architecture choices.
   `base` is a doc to UPGRADE (keep its data), or null for a brand-new model.
   ============================================================ */
const TOK_MODES = [
  { id: 'char', name: 'Characters', hint: 'Every letter is a token. Smallest vocab, learns spelling; needs the most context to form words. Great first model.' },
  { id: 'bpe', name: 'BPE subwords', hint: 'Learns frequent letter-chunks (like real LLMs). Balanced — compact vocab that still captures words. Recommended.' },
  { id: 'word', name: 'Whole words', hint: 'Each word is a token. Very readable output, but the vocab explodes on big/varied text.' },
  { id: 'sentence', name: 'Sentences / phrases', hint: 'Whole sentences are tokens. Tiny sequences, near-verbatim recall — best for short, structured sets.' },
];
const ACTS = [
  { id: 'relu', name: 'ReLU' }, { id: 'leaky', name: 'Leaky ReLU' }, { id: 'gelu', name: 'GELU' },
  { id: 'tanh', name: 'Tanh' }, { id: 'sigmoid', name: 'Sigmoid' },
];

function startWizard(base) {
  _nnView = 'wizard';
  _nnWizard = {
    step: 0, upgrade: !!base,
    baseId: base ? _nnId : null,
    name: base ? (_nnDoc.__name + '') : 'New model',
    arch: base ? JSON.parse(JSON.stringify(_nnDoc.arch)) : defaultArch(),
    layersText: (base ? _nnDoc.arch.layers : defaultArch().layers).join(', '),
  };
  renderWizard();
}
const WIZ_STEPS = ['Tokenizer', 'Context & size', 'Activation & dropout', 'Layer structure', 'Review'];
function renderWizard() {
  const app = document.getElementById('nnApp'); if (!app) return;
  const w = _nnWizard, a = w.arch;
  const dots = WIZ_STEPS.map((s, i) => `<span class="nn-wz-dot ${i === w.step ? 'on' : ''} ${i < w.step ? 'done' : ''}">${i < w.step ? svg('check', 11) : (i + 1)}<b>${s}</b></span>`).join('');
  let body = '';
  if (w.step === 0) {
    body = `<div class="nn-wz-h">How should text be broken into tokens?</div>
      <div class="nn-wz-sub mono">A token is the smallest unit the model reads and predicts.</div>
      <div class="nn-opt-list">${TOK_MODES.map(m => `
        <button class="nn-opt ${a.tokMode === m.id ? 'on' : ''}" data-tok="${m.id}">
          <span class="nn-opt-h">${m.name}${m.id === 'bpe' ? ' <em>· recommended</em>' : ''}</span>
          <span class="nn-opt-s">${m.hint}</span></button>`).join('')}</div>
      <label class="nn-wz-field"><span>Max vocabulary <b class="mono">${a.maxVocab}</b></span>
        <input type="range" min="64" max="4000" step="32" value="${a.maxVocab}" data-arch="maxVocab"></label>`;
  } else if (w.step === 1) {
    body = `<div class="nn-wz-h">Context & embedding size</div>
      <div class="nn-wz-sub mono">Context = how many tokens back it can see. Embedding = the width of each token's vector.</div>
      <label class="nn-wz-field"><span>Context length <b class="mono">${a.ctx}</b> tokens</span>
        <input type="range" min="8" max="256" step="8" value="${a.ctx}" data-arch="ctx"></label>
      <label class="nn-wz-field"><span>Embedding dim <b class="mono">${a.embed}</b></span>
        <input type="range" min="16" max="192" step="8" value="${a.embed}" data-arch="embed"></label>
      <div class="nn-wz-note mono">${svg('info', 12)} Bigger = smarter but slower to train. These are small by design so a browser tab or phone can train them.</div>`;
  } else if (w.step === 2) {
    body = `<div class="nn-wz-h">Activation & dropout</div>
      <div class="nn-wz-sub mono">The nonlinearity inside each block, and how much to randomly drop while training (fights overfitting).</div>
      <div class="nn-seg-row">${ACTS.map(x => `<button class="nn-seg-btn ${a.act === x.id ? 'on' : ''}" data-act="${x.id}">${x.name}</button>`).join('')}</div>
      <label class="nn-wz-field"><span>Dropout <b class="mono">${a.dropout.toFixed(2)}</b></span>
        <input type="range" min="0" max="0.5" step="0.05" value="${a.dropout}" data-arch="dropout"></label>`;
  } else if (w.step === 3) {
    body = `<div class="nn-wz-h">Hidden layer structure</div>
      <div class="nn-wz-sub mono">Each number is one transformer block's feed-forward width. Two or three blocks is plenty at this scale.</div>
      <label class="nn-wz-field col"><span>Layers (comma-separated widths)</span>
        <input class="nn-wz-input mono" id="nnLayers" value="${esc(w.layersText)}" placeholder="96, 96" spellcheck="false"></label>
      <div class="nn-wz-note mono" id="nnLayersPreview"></div>`;
  } else {
    const est = estimateParams(a);
    body = `<div class="nn-wz-h">Review${w.upgrade ? ' the upgrade' : ''}</div>
      <div class="nn-wz-sub mono">${w.upgrade ? 'Your data is kept. The model is rebuilt with this structure (training resets).' : 'A fresh, untrained model with this structure. You can upgrade it later.'}</div>
      <div class="nn-review">
        ${reviewRow('Name', esc(w.name))}
        ${reviewRow('Tokenizer', TOK_MODES.find(t => t.id === a.tokMode).name + ' · vocab ≤ ' + a.maxVocab)}
        ${reviewRow('Context', a.ctx + ' tokens')}
        ${reviewRow('Embedding', a.embed)}
        ${reviewRow('Activation', ACTS.find(x => x.id === a.act).name)}
        ${reviewRow('Dropout', a.dropout.toFixed(2))}
        ${reviewRow('Blocks', a.layers.join(' → ') + ' (' + a.layers.length + ')')}
        ${reviewRow('Est. parameters', '~' + est.toLocaleString())}
      </div>`;
  }
  app.innerHTML = `
    <div class="nn-wizard">
      <div class="nn-wz-bar">
        <button class="btn ghost sm" id="nnWzCancel">${svg('close', 14)} Cancel</button>
        <input class="nn-name" id="nnWzName" value="${esc(w.name)}" placeholder="Model name" spellcheck="false" ${w.step === 0 ? '' : ''}/>
      </div>
      <div class="nn-wz-steps">${dots}</div>
      <div class="nn-wz-body">${body}</div>
      <div class="nn-wz-foot">
        <button class="btn ghost" id="nnWzBack" ${w.step === 0 ? 'disabled' : ''}>${svg('back', 14)} Back</button>
        <div class="spacer"></div>
        <button class="btn primary" id="nnWzNext">${w.step === WIZ_STEPS.length - 1 ? (w.upgrade ? 'Rebuild model' : 'Create model') : 'Next'} ${svg('back', 13, 2)}</button>
      </div>
    </div>`;
  wireWizard(app);
  if (w.step === 3) updateLayersPreview();
}
function reviewRow(k, v) { return `<div class="nn-rev-row"><span class="mono dim">${k}</span><span>${v}</span></div>`; }
function estimateParams(a) {
  const V = Math.min(a.maxVocab, 4000), E = a.embed;
  let n = V * E + a.ctx * E + V * E; // tok emb + pos + head
  for (const h of a.layers) n += 4 * E * E + 2 * E * h;
  return n;
}
function wireWizard(app) {
  const w = _nnWizard;
  app.querySelector('#nnWzCancel').onclick = () => { _nnWizard = null; if (w.upgrade) openWorkspace(); else renderNeuralHome(); };
  const nameEl = app.querySelector('#nnWzName'); if (nameEl) nameEl.oninput = () => { w.name = nameEl.value.slice(0, 120); };
  app.querySelector('#nnWzBack').onclick = () => { if (w.step > 0) { w.step--; renderWizard(); } };
  app.querySelector('#nnWzNext').onclick = () => wizardNext();
  app.querySelectorAll('[data-tok]').forEach(b => b.onclick = () => { w.arch.tokMode = b.dataset.tok; renderWizard(); });
  app.querySelectorAll('[data-act]').forEach(b => b.onclick = () => { w.arch.act = b.dataset.act; renderWizard(); });
  app.querySelectorAll('input[data-arch]').forEach(el => {
    el.oninput = () => {
      const k = el.dataset.arch; const v = +el.value;
      w.arch[k] = (k === 'dropout') ? v : Math.round(v);
      const lbl = el.parentElement.querySelector('b'); if (lbl) lbl.textContent = (k === 'dropout') ? v.toFixed(2) : w.arch[k];
    };
  });
  const layersEl = app.querySelector('#nnLayers');
  if (layersEl) layersEl.oninput = () => { w.layersText = layersEl.value; updateLayersPreview(); };
}
function parseLayers(text) {
  const arr = String(text).split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0).map(n => Math.max(8, Math.min(1024, n))).slice(0, 8);
  return arr.length ? arr : [96];
}
function updateLayersPreview() {
  const el = document.getElementById('nnLayersPreview'); if (!el) return;
  const layers = parseLayers(_nnWizard.layersText);
  el.innerHTML = `${svg('info', 12)} ${layers.length} block${layers.length > 1 ? 's' : ''}: ${layers.join(' → ')}`;
}
function wizardNext() {
  const w = _nnWizard;
  if (w.step === 3) w.arch.layers = parseLayers(w.layersText);
  if (w.step < WIZ_STEPS.length - 1) { w.step++; renderWizard(); return; }
  // finish
  if (w.upgrade) applyUpgrade(); else {
    const doc = freshDoc(w.arch, w.name);
    _nnWizard = null;
    createModelDoc(doc);
  }
}
function applyUpgrade() {
  const w = _nnWizard;
  _nnDoc.arch = w.arch; _nnDoc.__name = w.name;
  _nnDoc.model = null; _nnDoc.tok = null;      // rebuild from scratch, keep data
  _nnDoc.trainState.steps = 0; _nnDoc.trainState.lossHistory = [];
  _nnWizard = null; _nnTab = 'training'; markNeuralDirty();
  toast('Model rebuilt — data kept, ready to train', 'refresh');
  openWorkspace();
}

/* ============================================================
   WORKSPACE — the three tabs
   ============================================================ */
function openWorkspace() {
  _nnView = 'workspace';
  const app = document.getElementById('nnApp'); if (!app) return;
  app.innerHTML = `
    <div class="nn-ws">
      ${nnEditorBar('')}
      <div class="nn-tabs" id="nnTabs">
        <button data-tab="data" class="${_nnTab === 'data' ? 'on' : ''}">${svg('note', 14)} Data</button>
        <button data-tab="training" class="${_nnTab === 'training' ? 'on' : ''}">${svg('spark', 14)} Training</button>
        <button data-tab="inference" class="${_nnTab === 'inference' ? 'on' : ''}">${svg('send', 14)} Inference</button>
      </div>
      <div class="nn-tab-body" id="nnTabBody"></div>
    </div>`;
  wireEditorBar(app);
  app.querySelectorAll('#nnTabs [data-tab]').forEach(b => b.onclick = () => { _nnTab = b.dataset.tab; renderTab(); app.querySelectorAll('#nnTabs [data-tab]').forEach(x => x.classList.toggle('on', x === b)); });
  renderTab();
}
function renderTab() {
  if (_nnTab === 'data') renderDataTab();
  else if (_nnTab === 'training') renderTrainingTab();
  else renderInferenceTab();
}

/* shared editor chrome: back, name, compute toggle, save status */
function nnEditorBar(extraHTML) {
  const backendOpt = _nnCaps.backend
    ? `<button type="button" data-compute="backend" class="${_nnDoc.compute === 'backend' ? 'on' : ''}">Backend</button>`
    : `<button type="button" disabled title="Ask an admin to enable backend compute for your account">Backend 🔒</button>`;
  return `<div class="nn-edbar">
    <button class="btn ghost sm" data-nnhome>${svg('back', 14)} All models</button>
    <input class="nn-name" id="nnName" value="${esc(_nnDoc.__name || '')}" placeholder="Model name" spellcheck="false" />
    <div class="nn-compute" title="Where the model trains">
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

/* ---------------- DATA TAB ---------------- */
function renderDataTab() {
  const body = document.getElementById('nnTabBody'); if (!body) return;
  const d = _nnDoc.data;
  body.innerHTML = `
    <div class="nn-data">
      ${dataSectionHTML('pretrain', 'Pre-training data', 'The bulk free text the model learns general language patterns from.', d.pretrain)}
      ${finetuneSectionHTML(d.finetune)}
    </div>`;
  body.querySelectorAll('[data-add]').forEach(b => b.onclick = () => addDataSet(b.dataset.add));
  body.querySelectorAll('[data-stack]').forEach(b => b.onclick = () => openStackPicker(b.dataset.stack));
  body.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editDataSet(b.dataset.section, b.dataset.edit));
  body.querySelectorAll('[data-rmset]').forEach(b => b.onclick = () => { removeDataSet(b.dataset.section, b.dataset.rmset); });
  const conv = body.querySelector('[data-newconvo]'); if (conv) conv.onclick = () => editConversation(null);
  const imp = body.querySelector('[data-importjsonl]'); if (imp) imp.onclick = () => importJSONL();
  const fstack = body.querySelector('[data-stackft]'); if (fstack) fstack.onclick = () => openStackPicker('finetune');
  body.querySelectorAll('[data-editconvo]').forEach(b => b.onclick = () => editConversation(b.dataset.editconvo));
}
/* Fine-tuning is now CONVERSATIONS (User↔AI turns). It shows the chat schema so it's
   obvious what the model is being trained to produce. */
function finetuneSectionHTML(sets) {
  const totalTurns = sets.reduce((n, s) => n + (s.turns || []).length, 0);
  const rows = sets.length ? sets.map(s => {
    const turns = s.turns || [];
    const preview = turns.length ? esc(String(turns[0].content || '').slice(0, 60)) : 'empty';
    return `<div class="nn-set-row" data-editconvo="${s.id}" style="cursor:pointer">
      <span class="nn-set-ico bg-audio t-audio">${svg('send', 15)}</span>
      <span class="nn-set-main"><span class="nn-set-name">${esc(s.name)}</span>
        <span class="nn-set-sub mono">${turns.length} turn${turns.length !== 1 ? 's' : ''} · “${preview}”</span></span>
      <button class="nn-set-btn" data-section="finetune" data-rmset="${s.id}" title="Remove">${svg('trash', 14)}</button>
    </div>`;
  }).join('') : `<div class="nn-none mono dim">No conversations yet. The model learns to reply in a chat format from these User↔AI examples.</div>`;
  return `<div class="nn-panel nn-data-panel">
    <div class="nn-panel-h">Fine-tuning conversations <span class="nn-set-count mono">${sets.length} convo${sets.length !== 1 ? 's' : ''} · ${totalTurns} turns</span></div>
    <div class="nn-panel-p mono">User↔AI examples that teach the model to respond in a chat format. Each turn is trained as <code>{"role":"user","content":…}</code> / <code>{"role":"assistant","content":…}</code> — the same schema used in the Inference chat.</div>
    <div class="nn-set-list">${rows}</div>
    <div class="nn-set-actions">
      <button class="btn sm" data-newconvo>${svg('plus', 13)} New conversation</button>
      <button class="btn ghost sm" data-importjsonl>${svg('upload', 13)} Import JSONL</button>
      <button class="btn ghost sm" data-stackft>${svg('copy', 13)} Stack from…</button>
    </div>
  </div>`;
}
function dataSectionHTML(section, title, sub, sets) {
  const total = sets.reduce((n, s) => n + (s.text || '').length, 0);
  const rows = sets.length ? sets.map(s => `
    <div class="nn-set-row">
      <span class="nn-set-ico bg-document t-document">${svg('note', 15)}</span>
      <span class="nn-set-main"><span class="nn-set-name">${esc(s.name)}</span>
        <span class="nn-set-sub mono">${(s.text || '').length.toLocaleString()} chars</span></span>
      <button class="nn-set-btn" data-section="${section}" data-edit="${s.id}" title="Edit">${svg('rename', 14)}</button>
      <button class="nn-set-btn" data-section="${section}" data-rmset="${s.id}" title="Remove">${svg('trash', 14)}</button>
    </div>`).join('') : `<div class="nn-none mono dim">No ${section === 'pretrain' ? 'pre-training' : 'fine-tuning'} sets yet.</div>`;
  return `<div class="nn-panel nn-data-panel">
    <div class="nn-panel-h">${title} <span class="nn-set-count mono">${sets.length} set${sets.length !== 1 ? 's' : ''} · ${total.toLocaleString()} chars</span></div>
    <div class="nn-panel-p mono">${sub}</div>
    <div class="nn-set-list">${rows}</div>
    <div class="nn-set-actions">
      <button class="btn sm" data-add="${section}">${svg('plus', 13)} Add text</button>
      <button class="btn ghost sm" data-stack="${section}">${svg('copy', 13)} Stack from…</button>
    </div>
  </div>`;
}
function addDataSet(section) { editDataSetModal(section, null); }
function editDataSet(section, id) { editDataSetModal(section, id); }
function editDataSetModal(section, id) {
  const sets = _nnDoc.data[section];
  const existing = id ? sets.find(s => s.id === id) : null;
  const nameV = existing ? existing.name : (section === 'pretrain' ? 'Corpus' : 'Examples');
  const textV = existing ? existing.text : '';
  openModal(`${existing ? 'Edit' : 'Add'} ${section === 'pretrain' ? 'pre-training' : 'fine-tuning'} text`, `
    <label class="nn-modal-field"><span>Name</span><input id="nnSetName" class="nn-wz-input" value="${esc(nameV)}" spellcheck="false"></label>
    <label class="nn-modal-field"><span>Text</span><textarea id="nnSetText" class="nn-corpus" rows="12" placeholder="Paste text here…" spellcheck="false">${esc(textV)}</textarea></label>
    <div class="nn-modal-row"><button class="btn ghost sm" id="nnSetUpload">${svg('upload', 13)} Load a .txt file</button>
      <span class="mono dim" id="nnSetStat"></span></div>
  `, [
    { label: 'Cancel', class: 'ghost', onClick: closeModal },
    { label: existing ? 'Save' : 'Add', class: 'primary', onClick: () => {
      const name = (document.getElementById('nnSetName').value || 'Untitled').slice(0, 80);
      const text = document.getElementById('nnSetText').value || '';
      if (!text.trim()) { toast('Add some text first', 'close'); return; }
      if (existing) { existing.name = name; existing.text = text; }
      else sets.push({ id: nnUid(), name, text });
      markNeuralDirty(); closeModal(); renderDataTab();
    } },
  ]);
  const up = document.getElementById('nnSetUpload');
  if (up) up.onclick = () => pickTextFile(t => { const ta = document.getElementById('nnSetText'); ta.value = (ta.value ? ta.value + '\n' : '') + t; document.getElementById('nnSetStat').textContent = t.length.toLocaleString() + ' chars loaded'; });
}
function pickTextFile(cb) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.txt,.md,.json,.csv,text/*';
  inp.onchange = () => { const f = inp.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => cb(String(r.result || '').slice(0, 2_000_000)); r.readAsText(f); };
  inp.click();
}
function removeDataSet(section, id) {
  _nnDoc.data[section] = _nnDoc.data[section].filter(s => s.id !== id);
  markNeuralDirty(); renderDataTab();
}

/* ---- FINE-TUNE CONVERSATION editor: turn-by-turn User/AI rows ---- */
let _nnEditConvo = null;   // working copy while the modal is open
function editConversation(id) {
  const existing = id ? _nnDoc.data.finetune.find(s => s.id === id) : null;
  _nnEditConvo = existing
    ? { id: existing.id, name: existing.name, turns: (existing.turns || []).map(t => ({ ...t })) }
    : { id: nnUid(), name: 'Conversation ' + (_nnDoc.data.finetune.length + 1), turns: [{ role: 'user', content: '' }, { role: 'assistant', content: '' }] };
  openModal(existing ? 'Edit conversation' : 'New conversation', convoModalBody(), [
    { label: 'Cancel', class: 'ghost', onClick: () => { _nnEditConvo = null; closeModal(); } },
    { label: existing ? 'Save' : 'Add', class: 'primary', onClick: () => saveConversation(!!existing) },
  ]);
  wireConvoModal();
}
function convoModalBody() {
  const c = _nnEditConvo;
  const turns = c.turns.map((t, i) => `
    <div class="nn-turn ${t.role}" data-turn="${i}">
      <div class="nn-turn-head">
        <button type="button" class="nn-role-toggle" data-roletoggle="${i}">${t.role === 'assistant' ? 'AI' : 'User'}</button>
        <span class="spacer"></span>
        <button type="button" class="nn-set-btn" data-turnup="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">${svg('arrowup', 13)}</button>
        <button type="button" class="nn-set-btn" data-turndel="${i}" title="Remove turn">${svg('trash', 13)}</button>
      </div>
      <textarea class="nn-turn-text" data-turntext="${i}" rows="2" placeholder="${t.role === 'assistant' ? 'What the AI should reply…' : 'What the user says…'}" spellcheck="false">${esc(t.content)}</textarea>
    </div>`).join('');
  return `
    <label class="nn-modal-field"><span>Name</span><input id="nnConvoName" class="nn-wz-input" value="${esc(c.name)}" spellcheck="false"></label>
    <div class="nn-panel-p mono">Alternate <b>User</b> and <b>AI</b> turns. This trains the model to reply in the same chat format.</div>
    <div class="nn-turns" id="nnTurns">${turns}</div>
    <div class="nn-turn-add">
      <button type="button" class="btn ghost sm" id="nnAddUser">${svg('plus', 12)} User turn</button>
      <button type="button" class="btn ghost sm" id="nnAddAI">${svg('plus', 12)} AI turn</button>
    </div>`;
}
function wireConvoModal() {
  const nameEl = document.getElementById('nnConvoName');
  if (nameEl) nameEl.oninput = () => { _nnEditConvo.name = nameEl.value.slice(0, 80); };
  const rerender = () => { const host = document.querySelector('.nn-modal-body'); if (host) { host.innerHTML = convoModalBody(); wireConvoModal(); } };
  // capture text edits live (so re-render/reorder keeps them)
  document.querySelectorAll('[data-turntext]').forEach(el => el.oninput = () => { _nnEditConvo.turns[+el.dataset.turntext].content = el.value; });
  document.querySelectorAll('[data-roletoggle]').forEach(b => b.onclick = () => { const i = +b.dataset.roletoggle; _nnEditConvo.turns[i].role = _nnEditConvo.turns[i].role === 'assistant' ? 'user' : 'assistant'; rerender(); });
  document.querySelectorAll('[data-turndel]').forEach(b => b.onclick = () => { _nnEditConvo.turns.splice(+b.dataset.turndel, 1); rerender(); });
  document.querySelectorAll('[data-turnup]').forEach(b => b.onclick = () => { const i = +b.dataset.turnup; if (i > 0) { const t = _nnEditConvo.turns; [t[i - 1], t[i]] = [t[i], t[i - 1]]; rerender(); } });
  const au = document.getElementById('nnAddUser'); if (au) au.onclick = () => { _nnEditConvo.turns.push({ role: 'user', content: '' }); rerender(); };
  const aa = document.getElementById('nnAddAI'); if (aa) aa.onclick = () => { _nnEditConvo.turns.push({ role: 'assistant', content: '' }); rerender(); };
}
function saveConversation(isEdit) {
  const c = _nnEditConvo; if (!c) return;
  c.turns = c.turns.filter(t => String(t.content || '').trim());
  if (!c.turns.length) { toast('Add at least one turn with text', 'close'); return; }
  const set = { id: c.id, name: c.name || 'Conversation', turns: c.turns };
  if (isEdit) { const i = _nnDoc.data.finetune.findIndex(s => s.id === c.id); if (i >= 0) _nnDoc.data.finetune[i] = set; else _nnDoc.data.finetune.push(set); }
  else _nnDoc.data.finetune.push(set);
  _nnEditConvo = null; markNeuralDirty(); closeModal(); renderDataTab();
}

/* ---- Import fine-tune conversations from JSONL (bulk escape hatch) ---- */
function importJSONL() {
  openModal('Import conversations (JSONL)', `
    <div class="nn-panel-p mono">One turn per line as <code>{"role":"user","content":"…"}</code> or the shorthand <code>{"User":"…"}</code> / <code>{"AI":"…"}</code>. A <b>blank line</b> starts a new conversation.</div>
    <textarea id="nnJsonl" class="nn-corpus" rows="12" spellcheck="false" placeholder='{"User":"Hi"}
{"AI":"Hello! How can I help?"}

{"User":"What is 2+2?"}
{"AI":"4."}'></textarea>
    <div class="nn-modal-row"><button class="btn ghost sm" id="nnJsonlFile">${svg('upload', 13)} Load a .jsonl/.txt file</button><span class="mono dim" id="nnJsonlStat"></span></div>
  `, [
    { label: 'Cancel', class: 'ghost', onClick: closeModal },
    { label: 'Import', class: 'primary', onClick: () => {
      const txt = document.getElementById('nnJsonl').value || '';
      const { conversations, errors } = chatParseJSONL(txt);
      if (errors.length) { toast(errors[0] + (errors.length > 1 ? ` (+${errors.length - 1} more)` : ''), 'close'); return; }
      if (!conversations.length) { toast('No conversations found', 'close'); return; }
      conversations.forEach((turns, i) => _nnDoc.data.finetune.push({ id: nnUid(), name: `Imported ${_nnDoc.data.finetune.length + 1}`, turns }));
      markNeuralDirty(); closeModal(); renderDataTab();
      toast(`Imported ${conversations.length} conversation${conversations.length > 1 ? 's' : ''}`, 'check');
    } },
  ]);
  const f = document.getElementById('nnJsonlFile');
  if (f) f.onclick = () => pickTextFile(t => { const ta = document.getElementById('nnJsonl'); ta.value = (ta.value ? ta.value + '\n' : '') + t; document.getElementById('nnJsonlStat').textContent = t.length.toLocaleString() + ' chars loaded'; });
}

/* ---- STACKING: import data sets from templates or your own models ---- */
async function openStackPicker(targetSection) {
  // gather sources: templates + your saved models (need their full data)
  const sources = [];
  for (const t of NN_TEMPLATES) sources.push({ kind: 'tpl', id: t.id, name: t.name, sub: 'Template', pretrain: t.pretrain, finetune: t.finetune });
  const others = _nnNetworks.filter(n => n.id !== _nnId);
  openModal('Stack data from…', `
    <div class="nn-panel-p mono">Copy pre-training or fine-tuning sets from a template or another of your models into this one's ${targetSection === 'pretrain' ? 'pre-training' : 'fine-tuning'} data.</div>
    <div id="nnStackList" class="nn-stack-list"><div class="dim mono">Loading sources…</div></div>
  `, [{ label: 'Done', class: 'ghost', onClick: () => { closeModal(); renderDataTab(); } }]);
  // fetch full docs for owned models (list only has meta+cached data)
  for (const n of others) {
    let data = n.data;
    if (!data) { try { const full = await getNetwork(n.id); data = full.data; n.data = data; } catch (e) { data = null; } }
    if (data) sources.push({ kind: 'net', id: n.id, name: n.name, sub: 'Your model', pretrain: (data.data && data.data.pretrain) || [], finetune: (data.data && data.data.finetune) || [] });
  }
  const listEl = document.getElementById('nnStackList'); if (!listEl) return;
  // Only offer sets that MATCH the target section (pretrain=free text, finetune=convos)
  // so stacking always produces the right shape.
  const rows = sources.map((src, si) => {
    const sets = (targetSection === 'pretrain' ? src.pretrain : src.finetune);
    if (!sets.length) return '';
    return `<div class="nn-stack-src"><div class="nn-stack-src-h">${esc(src.name)} <span class="mono dim">${src.sub}</span></div>
      ${sets.map((s) => {
        const meta = targetSection === 'pretrain' ? `${(s.text || '').length.toLocaleString()} chars` : `${(s.turns || []).length} turns`;
        return `<label class="nn-stack-item"><input type="checkbox" data-si="${si}" data-name="${esc(s.name)}"><span>${esc(s.name)}</span><span class="mono dim">${meta}</span></label>`;
      }).join('')}</div>`;
  }).join('') || `<div class="nn-none mono dim">No matching ${targetSection === 'pretrain' ? 'pre-training text' : 'conversations'} available to stack.</div>`;
  const anyMatch = sources.some(s => (targetSection === 'pretrain' ? s.pretrain.length : s.finetune.length));
  listEl.innerHTML = rows + (anyMatch ? `<button class="btn primary sm" id="nnStackApply" style="margin-top:12px">${svg('plus', 13)} Add selected</button>` : '');
  const apply = document.getElementById('nnStackApply');
  if (apply) apply.onclick = () => {
    const boxes = Array.from(listEl.querySelectorAll('input[type=checkbox]:checked'));
    let added = 0;
    boxes.forEach(box => {
      const src = sources[+box.dataset.si]; const name = box.dataset.name;
      const set = (targetSection === 'pretrain' ? src.pretrain : src.finetune).find(s => s.name === name);
      if (!set) return;
      if (targetSection === 'pretrain') { if (set.text) { _nnDoc.data.pretrain.push({ id: nnUid(), name: set.name, text: set.text }); added++; } }
      else { const turns = (set.turns || []).map(t => ({ ...t })); if (turns.length) { _nnDoc.data.finetune.push({ id: nnUid(), name: set.name, turns }); added++; } }
    });
    if (added) { markNeuralDirty(); toast(`Stacked ${added} set${added > 1 ? 's' : ''}`, 'copy'); }
    closeModal(); renderDataTab();
  };
}

/* ---------------- TRAINING TAB ---------------- */
const OPTIMIZERS = [
  { id: 'adamw', name: 'AdamW', hint: 'Robust default with weight decay.' },
  { id: 'radam', name: 'RAdam', hint: 'Rectified Adam — steadier early on.' },
  { id: 'lion', name: 'Lion', hint: 'Sign-based, memory-light, fast.' },
  { id: 'lamb', name: 'LAMB', hint: 'Layer-wise trust — good for bigger batches.' },
  { id: 'sgd', name: 'SGD', hint: 'Plain momentum. Simple and predictable.' },
];
function renderTrainingTab() {
  const body = document.getElementById('nnTabBody'); if (!body) return;
  const ts = _nnDoc.trainState, o = ts.opt;
  const dataChars = totalDataChars();
  const trained = ts.steps > 0;
  body.innerHTML = `
    <div class="nn-train">
      <div class="nn-panel">
        <div class="nn-panel-h">Optimizer</div>
        <div class="nn-seg-row wrap">${OPTIMIZERS.map(x => `<button class="nn-seg-btn ${o.kind === x.id ? 'on' : ''}" data-opt="${x.id}" title="${x.hint}">${x.name}</button>`).join('')}</div>
        <div class="nn-hp-grid">
          ${hpField('lr', 'Learning rate', o.lr, 'number', '0.0001', '1', '0.0001')}
          ${hpField('batch', 'Batch size', o.batch, 'range', '1', '32', '1')}
          ${hpField('epochs', 'Epochs (passes)', o.epochs, 'range', '1', '50', '1')}
          ${hpField('seed', 'Seed', o.seed, 'number', '0', '', '1')}
        </div>
        <div class="nn-train-run">
          <button class="btn primary" id="nnTrainBtn" ${dataChars < 8 ? 'disabled title="Add training data first"' : ''}>${svg('play', 14)} ${trained ? 'Continue training' : 'Start training'}</button>
          <button class="btn ghost" id="nnStopBtn" disabled>${svg('close', 14)} Stop</button>
          <span class="nn-train-stat mono" id="nnTrainStat">${trained ? `${ts.steps.toLocaleString()} steps · loss ${lastLoss(ts)}` : (dataChars < 8 ? 'add data on the Data tab' : 'not trained yet')}</span>
        </div>
      </div>

      <div class="nn-panel">
        <div class="nn-panel-h">Loss <span class="mono dim">lower = better</span></div>
        <canvas class="nn-loss" id="nnLossCanvas" width="640" height="180"></canvas>
      </div>

      <div class="nn-panel nn-upgrade">
        <div class="nn-panel-h">${svg('refresh', 15)} Upgrade this model</div>
        <div class="nn-panel-p mono">Change the architecture — bigger, smaller, a different tokenizer — while keeping all your data. Use it if the model is overfit or you just want a different structure without re-entering data. Training resets.</div>
        <button class="btn" id="nnUpgradeBtn">${svg('refresh', 13)} Upgrade…</button>
      </div>
    </div>`;
  body.querySelectorAll('[data-opt]').forEach(b => b.onclick = () => { o.kind = b.dataset.opt; body.querySelectorAll('[data-opt]').forEach(x => x.classList.toggle('on', x === b)); markNeuralDirty(); });
  body.querySelectorAll('[data-hp]').forEach(el => el.oninput = () => {
    const k = el.dataset.hp; let v = +el.value;
    o[k] = (k === 'lr') ? v : Math.round(v);
    const lbl = el.parentElement.querySelector('b'); if (lbl) lbl.textContent = (k === 'lr') ? o[k] : o[k];
    markNeuralDirty();
  });
  document.getElementById('nnTrainBtn').onclick = startTraining;
  document.getElementById('nnStopBtn').onclick = () => { _nnStop = true; };
  document.getElementById('nnUpgradeBtn').onclick = () => startWizard('upgrade');
  drawLoss();
}
function hpField(key, label, val, type, min, max, step) {
  const showVal = type === 'range' ? `<b class="mono">${val}</b>` : '';
  const attrs = type === 'range' ? `type="range" min="${min}" max="${max}" step="${step}"` : `type="number" min="${min}" ${max ? `max="${max}"` : ''} step="${step}"`;
  return `<label class="nn-hp"><span>${label} ${showVal}</span><input data-hp="${key}" ${attrs} value="${val}"></label>`;
}
function lastLoss(ts) { return ts.lossHistory.length ? ts.lossHistory[ts.lossHistory.length - 1].toFixed(3) : '—'; }
function totalDataChars() {
  const d = _nnDoc.data;
  return d.pretrain.reduce((n, s) => n + (s.text || '').length, 0) + finetuneChars();
}
function buildCorpus() {
  const d = _nnDoc.data;
  // Pre-training = free text (general patterns). Fine-tuning = conversations serialized
  // in the CHAT TEMPLATE, so the model learns to produce the exact JSON turn format it's
  // prompted with at inference. Each conversation is its own block (blank-line separated).
  const pre = d.pretrain.map(s => s.text).join('\n\n');
  const convos = d.finetune.map(s => chatSerializeConversation(s.turns)).filter(Boolean);
  const fine = convos.join('\n\n');
  // Fine-tune data is usually small vs pretrain; repeat it so the chat format isn't
  // drowned out (this is a poor-man's loss weighting for the tiny model).
  const fineRepeat = fine ? (fine + '\n\n').repeat(pre.length > fine.length * 2 ? 3 : 2) : '';
  return (pre + '\n\n' + fineRepeat).trim();
}
/* Count fine-tune content for the "enough data" check (turns' content chars). */
function finetuneChars() {
  return _nnDoc.data.finetune.reduce((n, s) => n + (s.turns || []).reduce((m, t) => m + String(t.content || '').length, 0), 0);
}

async function startTraining() {
  if (_nnTraining) return;
  const corpus = buildCorpus();
  if (corpus.length < 8) { toast('Add training data first', 'close'); return; }
  const d = _nnDoc, ts = d.trainState, o = ts.opt;
  const trainBtn = document.getElementById('nnTrainBtn'), stopBtn = document.getElementById('nnStopBtn'), stat = document.getElementById('nnTrainStat');
  _nnTraining = true; _nnStop = false;
  trainBtn.disabled = true; stopBtn.disabled = false;

  // (re)build tokenizer + model if needed
  if (!d.model || !d.tok) {
    stat.textContent = 'building tokenizer…';
    try {
      const tk = await nnRun('llm-tokenize', { text: corpus.slice(0, 500_000), opts: { mode: d.arch.tokMode, maxVocab: d.arch.maxVocab } });
      d.tok = tk.tok;
      d.model = NE.llmInit({ tok: d.tok, ctx: d.arch.ctx, embed: d.arch.embed, act: d.arch.act, dropout: d.arch.dropout, layers: d.arch.layers, seed: o.seed >>> 0 });
      ts.steps = 0; ts.lossHistory = [];
    } catch (e) { toast('Could not build the model', 'close'); return finishTraining(); }
  }
  // encode once
  const ids = NE.tokenizerEncode(d.tok, corpus);
  if (ids.length < d.arch.ctx + 2) { toast('Not enough text for this context length', 'close'); return finishTraining(); }

  // epochs → total step budget. Each "iteration" = a bounded chunk (steps × batch).
  const stepsPerIter = 5;
  const itersPerEpoch = Math.max(4, Math.min(60, Math.round(ids.length / (d.arch.ctx * o.batch))));
  const totalIters = itersPerEpoch * Math.max(1, o.epochs);
  const opt = { kind: o.kind, lr: o.lr, batch: o.batch, seed: o.seed >>> 0, steps: stepsPerIter };

  let iter = 0;
  const tick = async () => {
    if (_nnStop || !_nnTraining) return finishTraining();
    try {
      const r = await nnRun('llm-train', { model: d.model, ids, opt: { ...opt, iter: ts.steps } });
      d.model = r.model;
      ts.steps += stepsPerIter;
      ts.lossHistory.push(r.loss);
      if (ts.lossHistory.length > 400) ts.lossHistory = ts.lossHistory.slice(-400);
      stat.textContent = `${ts.steps.toLocaleString()} steps · loss ${r.loss.toFixed(3)} · epoch ${Math.min(o.epochs, Math.floor(iter / itersPerEpoch) + 1)}/${o.epochs}`;
      drawLoss();
      markNeuralDirty();
    } catch (e) { toast('Training error: ' + ((e && e.message) || 'failed'), 'close'); return finishTraining(); }
    iter++;
    if (iter >= totalIters) return finishTraining(true);
    setTimeout(tick, 0);   // yield to keep UI responsive
  };
  tick();
}
function finishTraining(done) {
  _nnTraining = false; _nnStop = false;
  const trainBtn = document.getElementById('nnTrainBtn'), stopBtn = document.getElementById('nnStopBtn');
  if (trainBtn) { trainBtn.disabled = totalDataChars() < 8; trainBtn.innerHTML = `${svg('play', 14)} ${_nnDoc.trainState.steps ? 'Continue training' : 'Start training'}`; }
  if (stopBtn) stopBtn.disabled = true;
  if (done) toast('Training finished — try it on the Inference tab', 'check');
  flushNeuralSave();
}
function drawLoss() {
  const c = document.getElementById('nnLossCanvas'); if (!c) return;
  const ctx = c.getContext('2d'); const h = _nnDoc.trainState.lossHistory;
  const W = c.width, H = c.height; ctx.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const accent = (css.getPropertyValue('--acc') || '#e0a64a').trim() || '#e0a64a';
  const dim = (css.getPropertyValue('--ink-faint') || '#888').trim() || '#888';
  if (!h.length) { ctx.fillStyle = dim; ctx.font = '12px monospace'; ctx.fillText('Loss appears here as it trains.', 12, 24); return; }
  const max = Math.max(...h), min = Math.min(...h), pad = 18;
  const x = i => pad + (W - pad * 2) * (h.length === 1 ? 0.5 : i / (h.length - 1));
  const y = v => H - pad - (H - pad * 2) * (max === min ? 0.5 : (v - min) / (max - min));
  // axes
  ctx.strokeStyle = dim + '55'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad, pad); ctx.lineTo(pad, H - pad); ctx.lineTo(W - pad, H - pad); ctx.stroke();
  ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath();
  h.forEach((v, i) => { const px = x(i), py = y(v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); ctx.stroke();
  ctx.fillStyle = dim; ctx.font = '11px monospace';
  ctx.fillText(max.toFixed(2), 2, pad + 4); ctx.fillText(min.toFixed(2), 2, H - pad);
}

/* ---------------- INFERENCE TAB (chat) ---------------- */
function renderInferenceTab() {
  const body = document.getElementById('nnTabBody'); if (!body) return;
  const trained = _nnDoc.trainState.steps > 0 && _nnDoc.model;
  // chat history is PER MODEL — reset it whenever a different model is open.
  if (!_nnChat || _nnChatFor !== _nnId) { _nnChat = []; _nnChatFor = _nnId; }
  body.innerHTML = `
    <div class="nn-chat">
      <div class="nn-chat-bar">
        <span class="mono dim">${trained ? 'Talking to your model in a chat format' : 'Not trained yet'}</span>
        <span class="spacer"></span>
        <button class="btn ghost sm" id="nnChatReset" title="Clear the conversation and start over" ${_nnChat.length ? '' : 'disabled'}>${svg('refresh', 13)} Reset chat</button>
      </div>
      ${!trained ? `<div class="nn-chat-empty mono dim">${svg('info', 14)} Train the model first (Training tab) — then it can chat here as it was trained.</div>` : ''}
      <div class="nn-chat-log" id="nnChatLog">${_nnChat.map(chatBubbleHTML).join('') || (trained ? `<div class="nn-chat-hint mono dim">Say something to your model. Each turn is sent as <code>{"role":"user","content":…}</code> and it replies as the assistant.</div>` : '')}</div>
      <div class="nn-gen-opts mono">
        <label>Creativity <input type="range" id="nnTemp" min="0.1" max="1.5" step="0.05" value="0.8"><b id="nnTempV">0.80</b></label>
        <label>Reply length <input type="range" id="nnLen" min="20" max="300" step="10" value="120"><b id="nnLenV">120</b></label>
      </div>
      <div class="nn-chat-input">
        <input id="nnChatBox" class="nn-prompt" placeholder="${trained ? 'Message your model…' : 'Train the model to chat'}" ${trained ? '' : 'disabled'} spellcheck="false">
        <button class="btn primary" id="nnChatSend" ${trained ? '' : 'disabled'}>${svg('send', 15, 2)}</button>
      </div>
    </div>`;
  const temp = body.querySelector('#nnTemp'), len = body.querySelector('#nnLen');
  if (temp) temp.oninput = () => body.querySelector('#nnTempV').textContent = (+temp.value).toFixed(2);
  if (len) len.oninput = () => body.querySelector('#nnLenV').textContent = len.value;
  const box = body.querySelector('#nnChatBox'), send = body.querySelector('#nnChatSend');
  if (send) send.onclick = () => sendChat();
  if (box) box.onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
  const reset = body.querySelector('#nnChatReset'); if (reset) reset.onclick = () => resetChat();
  scrollChat();
}
let _nnChat = null;      // [{role:'user'|'assistant', content, thinking?}]
let _nnChatFor = null;   // the model id _nnChat belongs to
function resetChat() { _nnChat = []; _nnChatFor = _nnId; renderInferenceTab(); }
function chatBubbleHTML(m) {
  const who = m.role === 'user' ? 'You' : 'Model';
  return `<div class="nn-bubble ${m.role === 'user' ? 'user' : 'bot'}"><span class="nn-bubble-role mono">${who}</span><span class="nn-bubble-txt">${esc(m.content)}${m.thinking ? '<span class="nn-gen-think">▍</span>' : ''}</span></div>`;
}
function scrollChat() { const l = document.getElementById('nnChatLog'); if (l) l.scrollTop = l.scrollHeight; }
async function sendChat() {
  const box = document.getElementById('nnChatBox'); if (!box) return;
  const text = box.value.trim(); if (!text) return;
  if (!_nnDoc.model || !_nnDoc.trainState.steps) { toast('Train the model first', 'close'); return; }
  box.value = '';
  _nnChat.push({ role: 'user', content: text });
  const botMsg = { role: 'assistant', content: '', thinking: true };
  _nnChat.push(botMsg);
  redrawChat();
  const temp = +document.getElementById('nnTemp').value, len = +document.getElementById('nnLen').value;
  // Serialize the conversation in the CHAT TEMPLATE and prompt an open assistant turn;
  // the model completes it and we stop at the closing "}. (Same schema it was fine-tuned
  // on — that's what makes it reply like a chat assistant.)
  const history = _nnChat.filter(m => !m.thinking);
  const prompt = chatBuildPrompt(history, 8);
  try {
    const r = await nnRun('llm-sample', { model: _nnDoc.model, gen: { prompt, length: len, temperature: temp, topK: 40, stop: CHAT.stop, seed: (Math.random() * 1e9) | 0 } });
    botMsg.content = chatExtractReply(r.text) || '…'; botMsg.thinking = false;
  } catch (e) { botMsg.content = '(generation failed)'; botMsg.thinking = false; }
  redrawChat();
}
function redrawChat() {
  const log = document.getElementById('nnChatLog'); if (!log) return;
  log.innerHTML = _nnChat.map(chatBubbleHTML).join('');
  scrollChat();
  const reset = document.getElementById('nnChatReset'); if (reset) reset.disabled = _nnChat.length === 0;
}

/* ============================================================
   Lightweight modal (reuses the app's .modal-bg / .modal CSS). Self-contained so
   the app doesn't depend on the file-browser's prompt-style modal().
   buttons: [{label, class, onClick}]
   ============================================================ */
let _nnModalBg = null;
function openModal(title, bodyHTML, buttons) {
  closeModal();
  const bg = document.createElement('div'); bg.className = 'modal-bg nn-modal-bg';
  const btns = (buttons || [{ label: 'Close', class: 'ghost', onClick: closeModal }])
    .map((b, i) => `<button class="btn ${b.class || 'ghost'}" data-mbtn="${i}">${esc(b.label)}</button>`).join('');
  bg.innerHTML = `<div class="modal nn-modal"><h3>${esc(title)}</h3><div class="nn-modal-body">${bodyHTML}</div><div class="acts">${btns}</div></div>`;
  document.body.appendChild(bg);
  _nnModalBg = bg;
  (buttons || []).forEach((b, i) => { const el = bg.querySelector(`[data-mbtn="${i}"]`); if (el) el.onclick = () => b.onClick && b.onClick(); });
  bg.onclick = e => { if (e.target === bg) closeModal(); };
  document.addEventListener('keydown', _nnModalEsc);
  const first = bg.querySelector('input, textarea'); if (first) first.focus();
}
function _nnModalEsc(e) { if (e.key === 'Escape') closeModal(); }
function closeModal() {
  if (_nnModalBg) { _nnModalBg.remove(); _nnModalBg = null; document.removeEventListener('keydown', _nnModalEsc); }
}

/* ============================================================
   TEMPLATES — pre-built, untrained models: an optimized structure + all the data
   they need. The user just trains and chats (and can upgrade later). Data is small
   and self-contained so a template trains into something recognizable in a minute.
   ============================================================ */
const NN_TEMPLATES = [
  {
    id: 'tinytales', name: 'Tiny Storyteller', tint: 'document', icon: 'note',
    desc: 'A character-level model that writes short fairy-tale style sentences. A great first train.',
    arch: { tokMode: 'char', maxVocab: 96, ctx: 64, embed: 48, act: 'gelu', dropout: 0.05, layers: [96, 96] },
    pretrain: [{ name: 'Little stories', text:
`Once upon a time a small fox lived by a river. The fox loved to watch the stars.
One night the moon was bright and the fox made a wish. A gentle owl heard the wish and smiled.
The little fox ran through the tall grass and found a shiny stone. The stone glowed in the dark.
Every morning the sun rose over the green hills and the birds began to sing.
A kind rabbit shared her carrots with the hungry fox. They became the best of friends.
The wind whispered secrets to the old oak tree, and the tree told them to the leaves.
When winter came, the animals gathered warm and safe inside the cozy den.
The fox and the owl and the rabbit told stories until the fire grew low and soft.
And so the little fox learned that the world is full of friends, if only you are kind.
The river sang a quiet song as it flowed gently toward the wide and shining sea.`.repeat(4) }],
    finetune: [
      { name: 'Ask for a story', turns: [
        { role: 'user', content: 'Tell me a story.' },
        { role: 'assistant', content: 'Once upon a time, a brave little mouse set out to find the shining stone beyond the hills.' },
      ] },
      { name: 'Story about a bear', turns: [
        { role: 'user', content: 'Tell me about a bear.' },
        { role: 'assistant', content: 'Long ago, in a land of snow, a friendly bear woke up and went to greet the morning sun.' },
      ] },
      { name: 'A gentle ending', turns: [
        { role: 'user', content: 'How does it end?' },
        { role: 'assistant', content: 'And so they all became the best of friends, and the little fox learned that the world is full of kindness.' },
      ] },
    ],
  },
  {
    id: 'chatbot', name: 'Politeness Bot', tint: 'audio', icon: 'send',
    desc: 'A subword model fine-tuned on short, friendly question→answer pairs.',
    arch: { tokMode: 'bpe', maxVocab: 800, ctx: 48, embed: 56, act: 'gelu', dropout: 0.1, layers: [112, 112] },
    pretrain: [{ name: 'Everyday sentences', text:
`Hello there. How are you today? I am doing very well, thank you.
It is a lovely day outside. The sky is clear and the sun is warm.
Please let me know if you need any help. I am happy to assist you.
Thank you so much for your patience. Have a wonderful afternoon.
I hope you have a great day. Take care and stay safe out there.
Good morning. Would you like a cup of tea or some coffee?
That sounds like a good idea. Let us get started right away.`.repeat(6) }],
    finetune: [
      { name: 'Greeting', turns: [
        { role: 'user', content: 'How are you?' },
        { role: 'assistant', content: 'I am doing great, thank you for asking! How can I help you today?' },
      ] },
      { name: 'Name', turns: [
        { role: 'user', content: 'What is your name?' },
        { role: 'assistant', content: 'You can call me Simplex, your friendly model.' },
      ] },
      { name: 'Help', turns: [
        { role: 'user', content: 'Can you help me?' },
        { role: 'assistant', content: 'Of course! I would be glad to help you.' },
      ] },
      { name: 'Thanks', turns: [
        { role: 'user', content: 'Thank you.' },
        { role: 'assistant', content: 'You are very welcome. Anytime!' },
      ] },
      { name: 'Capabilities', turns: [
        { role: 'user', content: 'What can you do?' },
        { role: 'assistant', content: 'I can chat with you about all sorts of things. Ask me anything!' },
      ] },
      { name: 'Goodbye', turns: [
        { role: 'user', content: 'Goodbye.' },
        { role: 'assistant', content: 'Goodbye! Have a wonderful day.' },
      ] },
    ],
  },
  {
    id: 'poet', name: 'Couplet Poet', tint: 'document', icon: 'spark',
    desc: 'A word-level model that learns rhythmic, rhyming lines from a small poem set.',
    arch: { tokMode: 'word', maxVocab: 1200, ctx: 24, embed: 64, act: 'tanh', dropout: 0.1, layers: [128] },
    pretrain: [{ name: 'Little poems', text:
`the moon is bright the night is deep the little stars begin to sleep
the river flows the willows bend the winding road will never end
the morning light the golden sun the day has only just begun
the autumn leaves come drifting down they paint the fields in red and brown
the quiet snow the frozen lake the world is still and half awake
the summer breeze the humming bee the shade beneath the apple tree`.repeat(8) }],
    finetune: [],
  },
];

/* ============================================================
   Notes: openModal/closeModal are defined above. toast/svg/esc/fmtDate/relock come
   from app.js; the API helpers (listNetworks/getNetwork/createNetwork/updateNetwork/
   deleteNetwork/neuralCaps/neuralCompute) come from data.js.
   ============================================================ */

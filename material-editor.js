/* ============================================================
   MATERIAL MANAGER — a UE5-style PBR material editor for the Tools app.
   Lazy-loaded via loadFeature('material-editor') the first time the tool opens
   (see openTool() in app.js). Plain (non-module) script sharing app.js's global
   scope, so it SEES core helpers (svg / esc / toast / pickVaultFile / createDoc /
   saveDocContent / fetchDocText / mediaUrl / _decryptItemBlobUrl / mvePromptModal)
   and DEFINES the two entry points the dispatcher calls: matEditorHTML(t) +
   wireMaterialEditor(t).

   WHAT IT IS
     Users build a material as a NODE GRAPH (forked from the Simplex Visual
     blueprint editor — same interaction model, same .vis-* chrome) whose leaf
     nodes are the PBR output channels (Base Color / Normal / Roughness / …).
     Texture Sample nodes import images straight from the user's vault. Multiply /
     Add / Lerp / parameter nodes shape the values. A fresh WebGL2 previewer bakes
     each channel to a texture and lights a sphere/cube/plane. Export bundles every
     channel as a PNG in a ZIP (pure-JS store-only writer — no external lib).

   STORAGE (vault files, no server changes)
     · a MATERIAL is a `.material.json` doc: { v, name, mode, graph, ui }
     · an INSTANCE is a `.matinst.json` doc: { v, name, parentId, overrides }
       (only parameter overrides; the graph is inherited from the parent)

   NAMESPACE: everything is MAT_* / mat* so it never collides with the Visual
   engine's VIS_* / vis* globals even though both may be loaded.
   ============================================================ */

const MAT_SCHEMA = 1;
const MAT_EXT = '.material.json';
const MAT_INST_EXT = '.matinst.json';

/* ---- PBR output channels (the leaf nodes every graph flows into) ----
   `type` is the value type the channel wants; `def` is the fallback flat value
   when nothing is wired (0..1 scalar, or [r,g,b] 0..1 vector). Order here is the
   order they appear in the preview / export list. */
const MAT_CHANNELS = [
  { k: 'baseColor', label: 'Base Color', file: 'BaseColor', out: 'Primary', type: 'vector', def: [0.5, 0.5, 0.5], srgb: true },
  { k: 'normal',    label: 'Normal',     file: 'Normal',    out: 'Normal',    type: 'vector', def: [0.5, 0.5, 1.0], srgb: false },
  { k: 'roughness', label: 'Roughness',  file: 'Roughness', out: 'Roughness', type: 'float',  def: 0.6, srgb: false },
  { k: 'metallic',  label: 'Metallic',   file: 'Metallic',  out: 'Metallic',  type: 'float',  def: 0.0, srgb: false },
  { k: 'ao',        label: 'Ambient Occlusion', file: 'AO',  out: 'AO',        type: 'float',  def: 1.0, srgb: false },
  { k: 'emissive',  label: 'Emissive',   file: 'Emissive',  out: 'Emissive',  type: 'vector', def: [0, 0, 0], srgb: true },
  { k: 'opacity',   label: 'Opacity',    file: 'Opacity',   out: 'Opacity',   type: 'float',  def: 1.0, srgb: false },
];
const MAT_CHAN = {}; MAT_CHANNELS.forEach(c => MAT_CHAN[c.k] = c);

/* ============================================================
   NODE REGISTRY — the single source of truth for material node types. The editor
   renders pins from this; matEvalGraph() evaluates handlers keyed by the SAME ids.
   Pin model (mirrors the blueprint editor, MINUS exec flow — materials are a pure
   dataflow graph, so there are no exec pins at all):
     · dataIn  [{ k, label, type, def }]   — value inputs (wire or inline literal)
     · dataOut { type }                     — the single main output ('out')
     · dataOuts [{ k, label, type }]        — extra named outputs (channel split)
     · props   [{ k, label, type, def }]    — inline editable fields (texture pick,
                                               colour, number, param-name)
   Value types: 'float' (scalar 0..1-ish) and 'vector' (rgb triple). A float wired
   into a vector pin broadcasts to (x,x,x); a vector into a float takes luminance.
   ============================================================ */
const MAT_NODES = {
  // ----- INPUTS (value sources) -----
  'tex.sample': { cat: 'tex', title: 'Texture Sample',
    props: [{ k: 'fileId', label: '', type: 'texture', def: '' }, { k: 'srgb', label: 'sRGB', type: 'bool', def: true }],
    dataOuts: [
      { k: 'rgb', label: 'RGB', type: 'vector' },
      { k: 'r', label: 'R', type: 'float' }, { k: 'g', label: 'G', type: 'float' },
      { k: 'b', label: 'B', type: 'float' }, { k: 'a', label: 'A', type: 'float' },
    ] },
  'input.uv':    { cat: 'input', title: 'Texture Coordinate', dataOut: { type: 'vector' },
    props: [{ k: 'tileX', label: 'Tile X', type: 'number', def: 1 }, { k: 'tileY', label: 'Tile Y', type: 'number', def: 1 }] },
  'const.scalar':{ cat: 'input', title: 'Constant',       dataOut: { type: 'float' },
    props: [{ k: 'value', label: '', type: 'number', def: 1 }] },
  'const.color': { cat: 'input', title: 'Color',          dataOut: { type: 'vector' },
    props: [{ k: 'value', label: '', type: 'color', def: '#ffffff' }] },

  // ----- PARAMETERS (the tweakable knobs instances override) -----
  'param.scalar':{ cat: 'param', title: 'Scalar Parameter', dataOut: { type: 'float' },
    props: [{ k: 'name', label: 'Name', type: 'text', def: 'Param' }, { k: 'value', label: '', type: 'number', def: 1 }] },
  'param.vector':{ cat: 'param', title: 'Vector Parameter', dataOut: { type: 'vector' },
    props: [{ k: 'name', label: 'Name', type: 'text', def: 'Color' }, { k: 'value', label: '', type: 'color', def: '#ffffff' }] },

  // ----- MATH -----
  'math.multiply': { cat: 'math', title: 'Multiply', dataOut: { type: 'vector' },
    dataIn: [{ k: 'a', label: 'A', type: 'vector', def: 1 }, { k: 'b', label: 'B', type: 'vector', def: 1 }] },
  'math.add':      { cat: 'math', title: 'Add', dataOut: { type: 'vector' },
    dataIn: [{ k: 'a', label: 'A', type: 'vector', def: 0 }, { k: 'b', label: 'B', type: 'vector', def: 0 }] },
  'math.subtract': { cat: 'math', title: 'Subtract', dataOut: { type: 'vector' },
    dataIn: [{ k: 'a', label: 'A', type: 'vector', def: 0 }, { k: 'b', label: 'B', type: 'vector', def: 0 }] },
  'math.lerp':     { cat: 'math', title: 'Lerp', dataOut: { type: 'vector' },
    dataIn: [{ k: 'a', label: 'A', type: 'vector', def: 0 }, { k: 'b', label: 'B', type: 'vector', def: 1 }, { k: 't', label: 'Alpha', type: 'float', def: 0.5 }] },
  'math.power':    { cat: 'math', title: 'Power', dataOut: { type: 'vector' },
    dataIn: [{ k: 'base', label: 'Base', type: 'vector', def: 0 }, { k: 'exp', label: 'Exp', type: 'float', def: 2 }] },
  'math.oneminus': { cat: 'math', title: 'One Minus', dataOut: { type: 'vector' },
    dataIn: [{ k: 'v', label: 'Value', type: 'vector', def: 0 }] },
  'math.clamp':    { cat: 'math', title: 'Clamp', dataOut: { type: 'vector' },
    dataIn: [{ k: 'v', label: 'Value', type: 'vector', def: 0 }, { k: 'min', label: 'Min', type: 'float', def: 0 }, { k: 'max', label: 'Max', type: 'float', def: 1 }] },
  'math.normalize':{ cat: 'math', title: 'Normalize', dataOut: { type: 'vector' },
    dataIn: [{ k: 'v', label: 'Value', type: 'vector', def: 0 }] },

  // ----- VECTOR (make / break) -----
  'vec.make':  { cat: 'vec', title: 'Make Vector', dataOut: { type: 'vector' },
    dataIn: [{ k: 'x', label: 'R', type: 'float', def: 0 }, { k: 'y', label: 'G', type: 'float', def: 0 }, { k: 'z', label: 'B', type: 'float', def: 0 }] },
  'vec.break': { cat: 'vec', title: 'Break Vector',
    dataIn: [{ k: 'v', label: 'Vec', type: 'vector', def: 0 }],
    dataOuts: [{ k: 'x', label: 'R', type: 'float' }, { k: 'y', label: 'G', type: 'float' }, { k: 'z', label: 'B', type: 'float' }] },
};

/* the OUTPUT node (one per graph) is generated so its rows exactly match
   MAT_CHANNELS — each channel is a data-IN pin. It has no output pin. */
MAT_NODES['output'] = {
  cat: 'output', title: 'Material Output', fixed: true,
  dataIn: MAT_CHANNELS.map(c => ({ k: c.k, label: c.label, type: c.type, def: c.def })),
};

/* creator groups (order + labels for the searchable Add-Node menu) */
const MAT_NODE_GROUPS = [
  { label: 'Inputs',     types: ['tex.sample', 'input.uv', 'const.scalar', 'const.color'] },
  { label: 'Parameters', types: ['param.scalar', 'param.vector'] },
  { label: 'Math',       types: ['math.multiply', 'math.add', 'math.subtract', 'math.lerp', 'math.power', 'math.oneminus', 'math.clamp', 'math.normalize'] },
  { label: 'Vector',     types: ['vec.make', 'vec.break'] },
];

/* ---- editor state (one live material at a time) ---- */
let MAT = null;
function matNewGraph() {
  return { nodes: [{ id: 'out', type: 'output', x: 520, y: 120, props: {} }], wires: [] };
}
function matNewMaterial(name) {
  return { v: MAT_SCHEMA, name: name || 'Untitled Material', mode: 'visual', graph: matNewGraph(),
           code: matDefaultCode(), ui: { mesh: 'sphere' } };
}
function matUid(p) { return (p || 'n_') + Math.random().toString(36).slice(2, 9); }
function matNow() { return Date.now(); }

/* ============================================================
   ENTRY POINTS
   ============================================================ */
function matEditorHTML(t) {
  return `<div class="mat-app" id="matApp"><div class="dim mono pad-sm">Loading…</div></div>`;
}

async function wireMaterialEditor(t) {
  MAT = { mat: matNewMaterial(), docId: null, dirty: false, mode: 'visual',
          sel: {}, cam: { x: 40, y: 40, zoom: 1 }, clip: null, texCache: {}, preview: null,
          saveTimer: null };
  matRenderShell();
}

/* the whole editor chrome: top bar (name + mode tabs + actions), split body
   (graph / code on the left, live 3D preview on the right). */
function matRenderShell() {
  const app = document.getElementById('matApp'); if (!app) return;
  const m = MAT.mat;
  app.innerHTML = `
    <div class="mat-topbar">
      <div class="mat-name" id="matName" title="Rename material">${esc(m.name)}</div>
      <div class="mat-modes seg" id="matModes">
        <button data-mode="visual" class="${MAT.mode === 'visual' ? 'on' : ''}">${svg('brain', 13)} Visual</button>
        <button data-mode="code" class="${MAT.mode === 'code' ? 'on' : ''}">${svg('code', 13)} Code</button>
      </div>
      <div class="mat-save" id="matSaved">${MAT.docId ? 'saved' : 'unsaved'}</div>
      <div class="spacer"></div>
      <button class="btn ghost sm" id="matNew">${svg('plus', 14)} New</button>
      <button class="btn ghost sm" id="matOpen">${svg('files', 14)} Open</button>
      <button class="btn ghost sm" id="matInstances" title="Material instances">${svg('layers', 14)} Instances</button>
      <button class="btn ghost sm" id="matSave">${svg('save', 14)} Save</button>
      <button class="btn primary sm" id="matExport">${svg('download', 14)} Export</button>
    </div>
    <div class="mat-body">
      <div class="mat-main" id="matMain"></div>
      <div class="mat-preview" id="matPreview"></div>
    </div>`;

  // top-bar wiring
  app.querySelector('#matModes').querySelectorAll('[data-mode]').forEach(b => b.onclick = () => matSwitchMode(b.dataset.mode));
  app.querySelector('#matNew').onclick = matNewCmd;
  app.querySelector('#matOpen').onclick = matOpenCmd;
  app.querySelector('#matInstances').onclick = matInstancesCmd;
  app.querySelector('#matSave').onclick = () => matSave(false);
  app.querySelector('#matExport').onclick = matOpenExport;
  matWireNameEdit();

  matRenderMain();
  matBuildPreview();
}

function matSwitchMode(mode) {
  if (mode === MAT.mode) return;
  MAT.mode = mode;
  document.getElementById('matModes').querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  if (mode === 'code') matSyncCodeFromGraph();
  matRenderMain();
}

function matRenderMain() {
  const main = document.getElementById('matMain'); if (!main) return;
  if (MAT.mode === 'visual') matRenderGraph();
  else matRenderCode();
}

/* inline rename of the material (click the title) */
function matWireNameEdit() {
  const el = document.getElementById('matName'); if (!el) return;
  el.onclick = () => {
    const inp = document.createElement('input');
    inp.className = 'mat-name-input'; inp.value = MAT.mat.name;
    el.replaceWith(inp); inp.focus(); inp.select();
    const commit = () => {
      const v = inp.value.trim() || 'Untitled Material';
      MAT.mat.name = v; matRenderShell(); matMarkDirty();
    };
    inp.onblur = commit;
    inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = MAT.mat.name; inp.blur(); } };
  };
}

function matMarkDirty() {
  MAT.dirty = true;
  const s = document.getElementById('matSaved'); if (s) { s.textContent = 'unsaved changes'; s.className = 'mat-save is-pending'; }
  matQueuePreview();
}

/* ============================================================
   GRAPH EDITOR — forked from the Simplex Visual blueprint editor, trimmed to a
   pure dataflow graph (no exec pins). Reuses the .vis-* CSS classes. All state
   lives on MAT (cam/sel/graph) so there's no per-tab bookkeeping.
   ============================================================ */
const MB_NODE_W = 158, MB_HEAD_H = 26, MB_ROW_H = 24, MB_BODY_PAD = 6;
const MB_ZOOM_MIN = 0.3, MB_ZOOM_MAX = 2.2;

function matGraph() { return MAT.mat.graph; }
function matNode(id) { return matGraph().nodes.find(n => n.id === id) || null; }
function matRootZoom() { const z = parseFloat(getComputedStyle(document.documentElement).zoom); return z && isFinite(z) && z > 0 ? z : 1; }

/* body-row model — order: props, then data-ins, then the single data-out or the
   named dataOuts. Returns { rows, height }. */
function matLayout(def) {
  const rows = [];
  (def.props || []).forEach(pr => rows.push({ prop: pr.k }));
  (def.dataIn || []).forEach(d => rows.push({ left: d.k }));
  if (def.dataOut) rows.push({ right: 'out' });
  (def.dataOuts || []).forEach(o => rows.push({ right: o.k }));
  const bodyH = rows.length ? (rows.length * MB_ROW_H + MB_BODY_PAD * 2) : 0;
  return { rows, height: MB_HEAD_H + bodyH };
}
function matPinWorld(n, pinKey, dir) {
  const def = MAT_NODES[n.type]; if (!def) return { x: n.x, y: n.y };
  const lay = matLayout(def);
  let idx = lay.rows.findIndex(r => (dir === 'out' ? r.right : r.left) === pinKey);
  if (idx < 0) idx = 0;
  const y = n.y + MB_HEAD_H + MB_BODY_PAD + idx * MB_ROW_H + MB_ROW_H / 2;
  return { x: dir === 'out' ? n.x + MB_NODE_W : n.x, y };
}

function matRenderGraph() {
  const main = document.getElementById('matMain'); if (!main) return;
  main.innerHTML = `
    <div class="vis-bp">
      <div class="vis-bp-toolbar">
        <button class="vis-tool" id="mbAdd">${svg('plus', 13)} Add Node</button>
        <span class="vis-bp-hint dim">Right-click for nodes · drag a pin to connect · left-drag to box-select · right-drag to pan · scroll to zoom · Del to delete</span>
        <div class="spacer"></div>
        <div class="vis-bp-zoom">
          <button class="vis-mini" id="mbZoomOut" title="Zoom out">${svg('minus', 12)}</button>
          <span id="mbZoomLbl" class="vis-bp-zoomlbl">${Math.round(MAT.cam.zoom * 100)}%</span>
          <button class="vis-mini" id="mbZoomIn" title="Zoom in">${svg('plus', 12)}</button>
          <button class="vis-mini" id="mbZoomFit" title="Frame all nodes">${svg('zoomfit', 12)}</button>
        </div>
      </div>
      <div class="vis-bp-canvaswrap" id="mbWrap">
        <div class="vis-bp-content" id="mbContent">
          <svg class="vis-bp-wires" id="mbWires"><g id="mbWireG"></g><path id="mbDragWire" class="vis-wire vis-wire-drag" style="display:none"></path></svg>
          <div class="vis-bp-nodes" id="mbNodes"></div>
          <div class="vis-marquee" id="mbMarquee" style="display:none"></div>
        </div>
      </div>
    </div>`;
  document.getElementById('mbAdd').onclick = (e) => matOpenCreator(e.clientX, e.clientY, null);
  document.getElementById('mbZoomIn').onclick = () => matZoomBy(1.2);
  document.getElementById('mbZoomOut').onclick = () => matZoomBy(1 / 1.2);
  document.getElementById('mbZoomFit').onclick = matFrameAll;
  matApplyCam();
  matRenderNodes();
  matWireCanvas();
  matInstallHotkeys();
}

function matApplyCam() {
  const content = document.getElementById('mbContent'), wrap = document.getElementById('mbWrap');
  if (content) content.style.transform = `translate(${MAT.cam.x}px, ${MAT.cam.y}px) scale(${MAT.cam.zoom})`;
  if (wrap) { const g = 22 * MAT.cam.zoom; wrap.style.backgroundSize = `${g}px ${g}px`; wrap.style.backgroundPosition = `${MAT.cam.x}px ${MAT.cam.y}px`; }
  const lbl = document.getElementById('mbZoomLbl'); if (lbl) lbl.textContent = Math.round(MAT.cam.zoom * 100) + '%';
}

function matTypeClass(type) { return 'vis-pin-t-' + (type === 'vector' ? 'vector' : 'float'); }

function matRenderNodes() {
  const host = document.getElementById('mbNodes'); if (!host) return;
  const g = matGraph();
  host.innerHTML = g.nodes.map(n => matNodeHTML(n, !!MAT.sel[n.id])).join('');
  host.querySelectorAll('[data-node]').forEach(el => {
    const nid = el.getAttribute('data-node');
    const header = el.querySelector('.vis-node-head');
    if (header) header.onmousedown = (e) => matStartNodeDrag(e, nid);
    el.querySelectorAll('[data-pin]').forEach(pin => {
      pin.onmousedown = (e) => { e.stopPropagation(); matStartWire(e, nid, pin.getAttribute('data-pin'), pin.getAttribute('data-pindir')); };
    });
    el.querySelectorAll('[data-prop]').forEach(inp => {
      inp.onmousedown = (e) => e.stopPropagation();
      const key = inp.getAttribute('data-prop');
      if (inp.getAttribute('data-textpick')) { inp.onclick = () => matPickTexture(nid); return; }
      const handler = () => {
        const nn = matNode(nid); if (!nn) return;
        nn.props = nn.props || {};
        nn.props[key] = inp.type === 'checkbox' ? inp.checked : inp.value;
        matMarkDirty();
      };
      inp.oninput = handler; inp.onchange = handler;
    });
  });
  matRedrawWires();
}

function matNodeHTML(n, selected) {
  const def = MAT_NODES[n.type]; if (!def) return '';
  const lay = matLayout(def);
  const propByKey = {}; (def.props || []).forEach(p => propByKey[p.k] = p);
  const dinByKey = {}; (def.dataIn || []).forEach(d => dinByKey[d.k] = d);
  const doutByKey = {}; (def.dataOuts || []).forEach(o => doutByKey[o.k] = o);
  const body = lay.rows.map(r => {
    if (r.prop != null) {
      const pr = propByKey[r.prop];
      return `<div class="vis-node-row vis-node-prop">${pr.label ? `<span class="vis-pin-label">${esc(pr.label)}</span>` : ''}${matPropInput(n, pr)}</div>`;
    }
    if (r.left != null) {
      const d = dinByKey[r.left];
      const t = d.type;
      return `<div class="vis-node-row vis-node-row-in">
        <div class="vis-pin vis-pin-data ${matTypeClass(t)} vis-pin-in" data-pin="${esc(d.k)}" data-pindir="in" title="${esc(d.label)} (${t})"></div>
        <span class="vis-pin-label">${esc(d.label)}</span>${matInlineInput(n, d)}</div>`;
    }
    if (r.right != null) {
      const key = r.right;
      const spec = key === 'out' ? def.dataOut : doutByKey[key];
      const t = spec.type;
      const label = key === 'out' ? '' : (doutByKey[key] ? doutByKey[key].label : key);
      return `<div class="vis-node-row vis-node-row-out">
        <span class="vis-pin-label">${esc(label)}</span>
        <div class="vis-pin vis-pin-data ${matTypeClass(t)} vis-pin-out" data-pin="${esc(key)}" data-pindir="out" title="out (${t})"></div></div>`;
    }
    return '';
  }).join('');
  const canDrag = !def.fixed;
  return `<div class="vis-node vis-node-${def.cat}${selected ? ' sel' : ''}${def.fixed ? ' mat-node-fixed' : ''}" data-node="${esc(n.id)}" style="left:${n.x || 0}px;top:${n.y || 0}px;width:${MB_NODE_W}px;">
      <div class="vis-node-head"${canDrag ? '' : ' style="cursor:move"'}><span class="vis-node-title">${esc(def.title)}</span></div>
      <div class="vis-node-body">${body}</div>
    </div>`;
}

/* inline fallback literal for an unwired data-in */
function matInlineInput(n, d) {
  const wired = matGraph().wires.some(w => w.to === n.id + ':' + d.k);
  if (wired) return `<span class="vis-inline-wired dim">wired</span>`;
  const v = (n.props && n.props[d.k] != null) ? n.props[d.k] : d.def;
  if (d.type === 'vector') {
    // a vector literal is edited as a colour swatch for base-color-ish pins,
    // otherwise as a single number that broadcasts to (x,x,x).
    return `<input type="number" step="0.05" class="vis-node-inp" data-prop="${esc(d.k)}" value="${matScalarOf(v)}">`;
  }
  return `<input type="number" step="0.05" class="vis-node-inp" data-prop="${esc(d.k)}" value="${matScalarOf(v)}">`;
}
function matScalarOf(v) { if (Array.isArray(v)) return v[0]; return v == null ? 0 : v; }

function matPropInput(n, pr) {
  const v = (n.props && n.props[pr.k] != null) ? n.props[pr.k] : pr.def;
  if (pr.type === 'texture') {
    const f = v ? (typeof DB !== 'undefined' && DB.files || []).find(x => x.id === v) : null;
    const name = f ? f.name : 'Pick texture…';
    return `<button class="mat-texbtn" data-prop="${esc(pr.k)}" data-textpick="1" title="${esc(name)}">${svg('image', 13)} <span class="mat-texbtn-lbl">${esc(name)}</span></button>`;
  }
  if (pr.type === 'color') return `<input type="color" class="vis-node-inp mat-color" data-prop="${esc(pr.k)}" value="${esc(v || '#ffffff')}">`;
  if (pr.type === 'bool') return `<input type="checkbox" class="vis-node-inp" data-prop="${esc(pr.k)}" ${v ? 'checked' : ''}>`;
  if (pr.type === 'text') return `<input type="text" class="vis-node-inp mat-text" data-prop="${esc(pr.k)}" value="${esc(v == null ? '' : v)}" placeholder="name">`;
  return `<input type="number" step="0.05" class="vis-node-inp" data-prop="${esc(pr.k)}" value="${v == null ? 0 : v}">`;
}

/* ---- wire geometry & drawing ---- */
function matWirePath(p1, p2) {
  const dx = Math.max(40, Math.abs(p2.x - p1.x) * 0.5);
  return `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
}
function matRedrawWires() {
  const g = document.getElementById('mbWireG'); if (!g) return;
  const graph = matGraph();
  g.innerHTML = graph.wires.map(w => {
    const [fn, fp] = w.from.split(':'), [tn, tp] = w.to.split(':');
    const nf = matNode(fn), nt = matNode(tn);
    if (!nf || !nt) return '';
    const a = matPinWorld(nf, fp, 'out'), b = matPinWorld(nt, tp, 'in');
    const t = matOutType(nf, fp);
    return `<path class="vis-wire vis-wire-data vis-wire-${t === 'vector' ? 'vector' : 'number'}" d="${matWirePath(a, b)}" data-wire="${esc(w.id)}"></path>`;
  }).join('');
  g.querySelectorAll('[data-wire]').forEach(p => {
    p.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); matDeleteWire(p.getAttribute('data-wire')); };
    p.onclick = (e) => { if (e.altKey) matDeleteWire(p.getAttribute('data-wire')); };
  });
}
function matOutType(n, pinKey) {
  const def = MAT_NODES[n.type];
  const spec = pinKey === 'out' ? def.dataOut : (def.dataOuts || []).find(o => o.k === pinKey);
  return spec ? spec.type : 'float';
}

/* ---- node drag ---- */
function matStartNodeDrag(e, nodeId) {
  e.preventDefault(); e.stopPropagation();
  if (e.shiftKey) { matSelectToggle(nodeId); return; }
  if (!MAT.sel[nodeId]) matSelectOnly(nodeId);
  const Z = matRootZoom();
  const ids = matSelIds();
  const starts = {}; ids.forEach(id => { const n = matNode(id); if (n) starts[id] = { x: n.x, y: n.y }; });
  const m0 = { x: e.clientX, y: e.clientY }; let moved = false;
  const onMove = (ev) => {
    const dx = (ev.clientX - m0.x) / Z / MAT.cam.zoom, dy = (ev.clientY - m0.y) / Z / MAT.cam.zoom;
    if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
    ids.forEach(id => {
      const n = matNode(id); if (!n) return;
      n.x = Math.round(starts[id].x + dx); n.y = Math.round(starts[id].y + dy);
      const el = document.querySelector(`[data-node="${CSS.escape(id)}"]`);
      if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
    });
    matRedrawWires();
  };
  const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); if (moved) matMarkDirty(); };
  document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
}

/* ---- wire drag ---- */
function matStartWire(e, nodeId, pinKey, dir) {
  e.preventDefault(); e.stopPropagation();
  const from = { nodeId, pinKey, dir };
  const n = matNode(nodeId);
  const startPt = matPinWorld(n, pinKey, dir);
  const dragPath = document.getElementById('mbDragWire');
  dragPath.style.display = '';
  const onMove = (ev) => { const w = matScreenToWorld(ev.clientX, ev.clientY); dragPath.setAttribute('d', matWirePath(startPt, w)); };
  const onUp = (ev) => {
    document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
    dragPath.style.display = 'none';
    const target = ev.target.closest ? ev.target.closest('[data-pin]') : null;
    if (target) {
      const tNode = target.closest('[data-node]').getAttribute('data-node');
      matTryConnect(from, { nodeId: tNode, pinKey: target.getAttribute('data-pin'), dir: target.getAttribute('data-pindir') });
    } else {
      matOpenCreator(ev.clientX, ev.clientY, from);
    }
  };
  document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
}

/* validate + create a wire.  data-OUT = many, data-IN = single (one source per
   input). Types are flexible: any vector/float can connect (broadcast/luminance
   is handled at eval time), so there's no hard type rejection. */
function matTryConnect(from, to) {
  const out = from.dir === 'out' ? from : to;
  const inn = from.dir === 'in' ? from : to;
  if (out.dir !== 'out' || inn.dir !== 'in') return false;
  if (out.nodeId === inn.nodeId) return false;
  const graph = matGraph();
  const toRef = inn.nodeId + ':' + inn.pinKey, fromRef = out.nodeId + ':' + out.pinKey;
  graph.wires = graph.wires.filter(w => w.to !== toRef);                 // data-in single
  graph.wires = graph.wires.filter(w => !(w.from === fromRef && w.to === toRef));
  graph.wires.push({ id: matUid('wr_'), from: fromRef, to: toRef });
  matRenderNodes(); matMarkDirty();
  return true;
}

/* ---- searchable node creator (right-click / Add Node / drag-off-pin) ---- */
function matOpenCreator(clientX, clientY, connectFrom) {
  matCloseCreator();
  const wrap = document.getElementById('mbWrap'); if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  const world = matScreenToWorld(clientX, clientY);
  const menu = document.createElement('div');
  menu.className = 'vis-creator'; menu.id = 'mbCreator';
  menu.style.left = Math.min(clientX - r.left, r.width - 232) + 'px';
  menu.style.top = Math.min(clientY - r.top, Math.max(8, r.height - 320)) + 'px';
  menu.innerHTML = `<input type="text" class="vis-creator-search" id="mbCreatorSearch" placeholder="Search nodes…" autocomplete="off">
    <div class="vis-creator-list" id="mbCreatorList"></div>`;
  wrap.appendChild(menu);

  // when dragging FROM an out pin we want nodes with an IN pin, and vice versa
  function compatible(type) {
    if (!connectFrom) return true;
    const def = MAT_NODES[type];
    const wantDir = connectFrom.dir === 'out' ? 'in' : 'out';
    if (wantDir === 'in') return !!(def.dataIn && def.dataIn.length);
    return !!(def.dataOut || (def.dataOuts && def.dataOuts.length));
  }
  const all = [];
  MAT_NODE_GROUPS.forEach(gp => gp.types.forEach(ty => { if (compatible(ty)) all.push({ type: ty, title: MAT_NODES[ty].title, grp: gp.label, cat: MAT_NODES[ty].cat }); }));

  const listEl = menu.querySelector('#mbCreatorList');
  const searchEl = menu.querySelector('#mbCreatorSearch');
  let active = 0;
  const draw = (q) => {
    const s = (q || '').toLowerCase();
    const items = all.filter(x => !s || x.title.toLowerCase().includes(s) || x.grp.toLowerCase().includes(s));
    active = Math.min(active, Math.max(0, items.length - 1));
    listEl.innerHTML = items.length ? items.map((x, i) => `<button class="vis-creator-item ${i === active ? 'active' : ''}" data-type="${esc(x.type)}">
      <span class="vis-palette-dot vis-node-${x.cat}"></span>
      <span class="vis-creator-title">${esc(x.title)}</span><span class="vis-creator-grp dim">${esc(x.grp)}</span></button>`).join('')
      : `<div class="vis-creator-empty dim">No nodes match.</div>`;
    listEl.querySelectorAll('[data-type]').forEach(b => b.onclick = () => matCreatorPick(b.getAttribute('data-type'), world, connectFrom));
  };
  draw('');
  searchEl.oninput = () => draw(searchEl.value);
  searchEl.onkeydown = (e) => {
    const items = listEl.querySelectorAll('[data-type]');
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, items.length - 1); draw(searchEl.value); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); draw(searchEl.value); e.preventDefault(); }
    else if (e.key === 'Enter') { const b = items[active]; if (b) matCreatorPick(b.getAttribute('data-type'), world, connectFrom); e.preventDefault(); }
    else if (e.key === 'Escape') matCloseCreator();
  };
  setTimeout(() => searchEl.focus(), 20);
  setTimeout(() => document.addEventListener('mousedown', matCreatorOutside), 0);
}
function matCreatorOutside(e) { if (!e.target.closest('#mbCreator')) matCloseCreator(); }
function matCloseCreator() { const m = document.getElementById('mbCreator'); if (m) m.remove(); document.removeEventListener('mousedown', matCreatorOutside); }

function matCreatorPick(type, world, connectFrom) {
  matCloseCreator();
  const n = matAddNode(type, world.x - 20, world.y - 14);
  if (connectFrom && n) {
    const def = MAT_NODES[type];
    if (connectFrom.dir === 'out') {
      const firstIn = def.dataIn && def.dataIn[0];
      if (firstIn) matTryConnect(connectFrom, { nodeId: n.id, pinKey: firstIn.k, dir: 'in' });
    } else {
      const firstOut = def.dataOut ? 'out' : (def.dataOuts && def.dataOuts[0] && def.dataOuts[0].k);
      if (firstOut) matTryConnect({ nodeId: n.id, pinKey: firstOut, dir: 'out' }, connectFrom);
    }
  }
}

function matAddNode(type, x, y) {
  const graph = matGraph();
  const n = { id: matUid('nd_'), type, x: Math.round(x), y: Math.round(y), props: {} };
  const def = MAT_NODES[type];
  (def.props || []).forEach(pr => { if (pr.def !== undefined && pr.def !== '') n.props[pr.k] = pr.def; });
  graph.nodes.push(n);
  matRenderNodes(); matMarkDirty();
  return n;
}
function matDeleteNodes(ids) {
  const set = new Set(ids.filter(id => { const n = matNode(id); return n && !MAT_NODES[n.type].fixed; }));  // never delete Output
  if (!set.size) return;
  const graph = matGraph();
  graph.nodes = graph.nodes.filter(n => !set.has(n.id));
  graph.wires = graph.wires.filter(w => !set.has(w.from.split(':')[0]) && !set.has(w.to.split(':')[0]));
  ids.forEach(id => delete MAT.sel[id]);
  matRenderNodes(); matMarkDirty();
}
function matDeleteWire(id) {
  const graph = matGraph();
  graph.wires = graph.wires.filter(w => w.id !== id);
  matRenderNodes(); matMarkDirty();
}

/* ---- selection ---- */
function matSelectOnly(id) { MAT.sel = {}; if (id) MAT.sel[id] = true; matRenderNodes(); }
function matSelectToggle(id) { if (MAT.sel[id]) delete MAT.sel[id]; else MAT.sel[id] = true; matRenderNodes(); }
function matSelectAll() { MAT.sel = {}; matGraph().nodes.forEach(n => MAT.sel[n.id] = true); matRenderNodes(); }
function matClearSel() { MAT.sel = {}; matRenderNodes(); }
function matSelIds() { return Object.keys(MAT.sel).filter(k => MAT.sel[k]); }

/* ---- coords ---- */
function matScreenToWorld(clientX, clientY) {
  const Z = matRootZoom();
  const content = document.getElementById('mbContent');
  if (content) { const cr = content.getBoundingClientRect(); return { x: ((clientX - cr.left) / Z) / MAT.cam.zoom, y: ((clientY - cr.top) / Z) / MAT.cam.zoom }; }
  const wrap = document.getElementById('mbWrap'); const r = wrap.getBoundingClientRect();
  return { x: ((clientX - r.left) / Z - MAT.cam.x) / MAT.cam.zoom, y: ((clientY - r.top) / Z - MAT.cam.y) / MAT.cam.zoom };
}

/* ---- zoom / frame ---- */
function matZoomBy(factor, pivotClientX, pivotClientY) {
  const Z = matRootZoom();
  const wrap = document.getElementById('mbWrap'); if (!wrap) return;
  const wr = wrap.getBoundingClientRect();
  const cx = pivotClientX == null ? (wr.left + wr.width / 2) * Z : pivotClientX;
  const cy = pivotClientY == null ? (wr.top + wr.height / 2) * Z : pivotClientY;
  const before = matScreenToWorld(cx, cy);
  MAT.cam.zoom = Math.max(MB_ZOOM_MIN, Math.min(MB_ZOOM_MAX, MAT.cam.zoom * factor));
  matApplyCam();
  const cr = document.getElementById('mbContent').getBoundingClientRect();
  const nowClientX = cr.left + before.x * MAT.cam.zoom * Z, nowClientY = cr.top + before.y * MAT.cam.zoom * Z;
  MAT.cam.x += (cx - nowClientX) / Z; MAT.cam.y += (cy - nowClientY) / Z;
  matApplyCam();
}
function matFrameAll() {
  const graph = matGraph(); const wrap = document.getElementById('mbWrap'); if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  if (!graph.nodes.length) { MAT.cam = { x: 40, y: 40, zoom: 1 }; matApplyCam(); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  graph.nodes.forEach(n => { const h = matLayout(MAT_NODES[n.type]).height; minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + MB_NODE_W); maxY = Math.max(maxY, n.y + h); });
  const pad = 60, bw = maxX - minX + pad * 2, bh = maxY - minY + pad * 2;
  MAT.cam.zoom = Math.max(MB_ZOOM_MIN, Math.min(MB_ZOOM_MAX, Math.min(r.width / bw, r.height / bh)));
  MAT.cam.x = (r.width - (maxX + minX) * MAT.cam.zoom) / 2;
  MAT.cam.y = (r.height - (maxY + minY) * MAT.cam.zoom) / 2;
  matApplyCam();
}

/* ---- canvas interactions ---- */
function matWireCanvas() {
  const wrap = document.getElementById('mbWrap'); if (!wrap) return;
  wrap.onmousedown = (e) => {
    if (e.target.closest('.vis-node') || e.target.closest('[data-pin]') || e.target.closest('.vis-creator') || e.target.closest('[data-wire]')) return;
    if (e.button === 2 || e.button === 1) { matStartPan(e); e.preventDefault(); return; }
    if (e.button === 0) matStartMarquee(e);
  };
  let rcDown = null;
  wrap.addEventListener('mousedown', (e) => { if (e.button === 2) rcDown = { x: e.clientX, y: e.clientY, onNode: !!(e.target.closest('.vis-node') || e.target.closest('[data-wire]')) }; });
  wrap.oncontextmenu = (e) => {
    e.preventDefault();
    if (rcDown && !rcDown.onNode && Math.abs(e.clientX - rcDown.x) < 4 && Math.abs(e.clientY - rcDown.y) < 4) matOpenCreator(e.clientX, e.clientY, null);
    rcDown = null;
  };
  wrap.onwheel = (e) => {
    if (e.target.closest && e.target.closest('.vis-creator')) return;
    e.preventDefault(); matZoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
  };
}
function matStartPan(e) {
  const Z = matRootZoom();
  const start = { mx: e.clientX, my: e.clientY, cx: MAT.cam.x, cy: MAT.cam.y };
  const onMove = (ev) => { MAT.cam.x = start.cx + (ev.clientX - start.mx) / Z; MAT.cam.y = start.cy + (ev.clientY - start.my) / Z; matApplyCam(); };
  const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
}
function matStartMarquee(e) {
  const box = document.getElementById('mbMarquee');
  const additive = e.shiftKey;
  const base = additive ? Object.assign({}, MAT.sel) : {};
  const startW = matScreenToWorld(e.clientX, e.clientY);
  let dragged = false;
  const onMove = (ev) => {
    const cur = matScreenToWorld(ev.clientX, ev.clientY);
    const x = Math.min(startW.x, cur.x), y = Math.min(startW.y, cur.y);
    const w = Math.abs(cur.x - startW.x), h = Math.abs(cur.y - startW.y);
    if (w + h > 3) dragged = true;
    box.style.display = ''; box.style.left = x + 'px'; box.style.top = y + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px';
    const x2 = x + w, y2 = y + h;
    MAT.sel = Object.assign({}, base);
    matGraph().nodes.forEach(n => { const hh = matLayout(MAT_NODES[n.type]).height; if (n.x + MB_NODE_W >= x && n.x <= x2 && n.y + hh >= y && n.y <= y2) MAT.sel[n.id] = true; });
    matRenderNodes();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
    box.style.display = 'none';
    if (!dragged && !additive) matClearSel();
  };
  document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
}

/* ---- hotkeys (scoped to the visual mode) ---- */
function matInstallHotkeys() {
  if (MAT._keyHandler) { document.removeEventListener('keydown', MAT._keyHandler); MAT._keyHandler = null; }
  const handler = (e) => {
    if (MAT.mode !== 'visual' || !document.getElementById('mbNodes')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.target.isContentEditable) return;
    const mod = e.ctrlKey || e.metaKey; const k = (e.key || '').toLowerCase();
    if (e.key === 'Delete' || e.key === 'Backspace') { const ids = matSelIds(); if (ids.length) { matDeleteNodes(ids); e.preventDefault(); } }
    else if (mod && k === 'a') { matSelectAll(); e.preventDefault(); }
    else if (mod && k === 'c') { matCopy(); e.preventDefault(); }
    else if (mod && k === 'v') { matPaste(); e.preventDefault(); }
    else if (mod && k === 'd') { matCopy(); matPaste(); e.preventDefault(); }
    else if (e.key === 'Escape') { matCloseCreator(); matClearSel(); }
  };
  MAT._keyHandler = handler;
  document.addEventListener('keydown', handler);
}
function matCopy() {
  const ids = new Set(matSelIds().filter(id => { const n = matNode(id); return n && !MAT_NODES[n.type].fixed; }));
  if (!ids.size) return;
  const graph = matGraph();
  const nodes = graph.nodes.filter(n => ids.has(n.id)).map(n => JSON.parse(JSON.stringify(n)));
  const wires = graph.wires.filter(w => ids.has(w.from.split(':')[0]) && ids.has(w.to.split(':')[0])).map(w => JSON.parse(JSON.stringify(w)));
  MAT.clip = { nodes, wires };
}
function matPaste() {
  const clip = MAT.clip; if (!clip || !clip.nodes.length) return;
  const graph = matGraph();
  const idMap = {};
  const newSel = {};
  clip.nodes.forEach(n => { const nid = matUid('nd_'); idMap[n.id] = nid; graph.nodes.push(Object.assign(JSON.parse(JSON.stringify(n)), { id: nid, x: n.x + 24, y: n.y + 24 })); newSel[nid] = true; });
  clip.wires.forEach(w => {
    const [fn, fp] = w.from.split(':'), [tn, tp] = w.to.split(':');
    if (idMap[fn] && idMap[tn]) graph.wires.push({ id: matUid('wr_'), from: idMap[fn] + ':' + fp, to: idMap[tn] + ':' + tp });
  });
  MAT.sel = newSel;
  matRenderNodes(); matMarkDirty();
}

/* ---- texture picker (imports a vault image into a Texture Sample node) ---- */
function matPickTexture(nodeId) {
  pickVaultFile({ kinds: ['image'], onPick: (f) => {
    if (!f) return;
    const n = matNode(nodeId); if (!n) return;
    n.props = n.props || {}; n.props.fileId = f.id;
    matRenderNodes(); matMarkDirty();
  } });
}

/* ============================================================
   TEXTURE LOADING — pull a vault image's pixels into an offscreen canvas so the
   graph baker can sample it. Handles encrypted (locked) items via the core
   decrypt path. Cached per-fileId on MAT.texCache.
   ============================================================ */
async function matLoadTexture(fileId) {
  if (!fileId) return null;
  if (MAT.texCache[fileId]) return MAT.texCache[fileId];
  const f = (typeof DB !== 'undefined' && DB.files || []).find(x => x.id === fileId);
  if (!f) return null;
  let url, revoke = null;
  try {
    if (typeof _parseLockSpec === 'function' && _parseLockSpec(f)) { url = await _decryptItemBlobUrl(f); revoke = url; }
    else url = (typeof mediaUrl === 'function' && mediaUrl(f)) || ('/api/files/' + f.id + '/raw');
  } catch (e) { url = '/api/files/' + f.id + '/raw'; }
  const img = await new Promise((resolve) => {
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im); im.onerror = () => resolve(null);
    im.src = url;
  });
  if (revoke) { try { URL.revokeObjectURL(revoke); } catch (e) {} }
  if (!img) return null;
  const tex = { img, w: img.naturalWidth || img.width || 1, h: img.naturalHeight || img.height || 1 };
  MAT.texCache[fileId] = tex;
  return tex;
}

/* pre-load every texture referenced by the graph (so baking is synchronous) */
async function matPreloadTextures() {
  const ids = new Set();
  matGraph().nodes.forEach(n => { if (n.type === 'tex.sample' && n.props && n.props.fileId) ids.add(n.props.fileId); });
  await Promise.all([...ids].map(id => matLoadTexture(id).catch(() => null)));
}

/* ============================================================
   GRAPH EVALUATION — the baker. Evaluate the graph per-pixel for a channel and
   return ImageData. Values flow as {r,g,b} triples; a scalar broadcasts to
   (v,v,v); luminance collapses a triple where a float pin needs one. `overrides`
   maps a parameter NAME -> overriding value (instances). Cycles guarded per eval.
   ============================================================ */
function matGetImageData(tex) {
  if (tex.data !== undefined) return tex;
  const c = document.createElement('canvas'); c.width = tex.w; c.height = tex.h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(tex.img, 0, 0);
  try { tex.data = ctx.getImageData(0, 0, tex.w, tex.h).data; } catch (e) { tex.data = null; }
  return tex;
}
function matSampleTex(tex, u, v) {
  const d = matGetImageData(tex).data;
  if (!d) return { r: 1, g: 1, b: 1, a: 1 };
  u = u - Math.floor(u); v = v - Math.floor(v);
  const x = Math.min(tex.w - 1, Math.max(0, Math.floor(u * tex.w)));
  const y = Math.min(tex.h - 1, Math.max(0, Math.floor(v * tex.h)));
  const i = (y * tex.w + x) * 4;
  return { r: d[i] / 255, g: d[i + 1] / 255, b: d[i + 2] / 255, a: d[i + 3] / 255 };
}
function matHexToRGB(hex) {
  hex = (hex || '#ffffff').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const n = parseInt(hex, 16) || 0;
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
function matAsVec(v) { if (typeof v === 'number') return { r: v, g: v, b: v }; if (v && v.r != null) return v; return { r: 0, g: 0, b: 0 }; }
function matLum(v) { const c = matAsVec(v); return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b; }
function matAsScalarInput(v) { return (v && v.r != null) ? matLum(v) : (typeof v === 'number' ? v : 0); }

function matResolveParam(n, overrides) {
  const name = (n.props && n.props.name) || '';
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) {
    const ov = overrides[name];
    if (n.type === 'param.vector') return matHexToRGB(ov);
    return typeof ov === 'number' ? ov : (parseFloat(ov) || 0);
  }
  if (n.type === 'param.vector') return matHexToRGB((n.props && n.props.value) || '#ffffff');
  return parseFloat((n.props && n.props.value)) || 0;
}

function matEvalPin(nodeId, pinKey, u, v, ctx) {
  const key = nodeId + ':' + pinKey;
  if (ctx.stack.has(key)) return 0;
  const n = matNode(nodeId); if (!n) return 0;
  ctx.stack.add(key);
  let res = 0;
  switch (n.type) {
    case 'tex.sample': {
      const tex = n.props && n.props.fileId ? MAT.texCache[n.props.fileId] : null;
      const s = tex ? matSampleTex(tex, u, v) : { r: 0.5, g: 0.5, b: 0.5, a: 1 };
      if (pinKey === 'rgb') res = { r: s.r, g: s.g, b: s.b };
      else if (pinKey === 'r') res = s.r; else if (pinKey === 'g') res = s.g;
      else if (pinKey === 'b') res = s.b; else res = s.a;
      break;
    }
    case 'input.uv': { const tx = parseFloat(n.props && n.props.tileX) || 1, ty = parseFloat(n.props && n.props.tileY) || 1; res = { r: u * tx, g: v * ty, b: 0 }; break; }
    case 'const.scalar': res = parseFloat(n.props && n.props.value) || 0; break;
    case 'const.color': res = matHexToRGB(n.props && n.props.value); break;
    case 'param.scalar': res = matResolveParam(n, ctx.overrides); break;
    case 'param.vector': res = matResolveParam(n, ctx.overrides); break;
    case 'math.multiply': { const a = matEvalInVec(n, 'a', u, v, ctx), b = matEvalInVec(n, 'b', u, v, ctx); res = { r: a.r * b.r, g: a.g * b.g, b: a.b * b.b }; break; }
    case 'math.add':      { const a = matEvalInVec(n, 'a', u, v, ctx), b = matEvalInVec(n, 'b', u, v, ctx); res = { r: a.r + b.r, g: a.g + b.g, b: a.b + b.b }; break; }
    case 'math.subtract': { const a = matEvalInVec(n, 'a', u, v, ctx), b = matEvalInVec(n, 'b', u, v, ctx); res = { r: a.r - b.r, g: a.g - b.g, b: a.b - b.b }; break; }
    case 'math.lerp':     { const a = matEvalInVec(n, 'a', u, v, ctx), b = matEvalInVec(n, 'b', u, v, ctx), t = matEvalInScalar(n, 't', u, v, ctx); res = { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }; break; }
    case 'math.power':    { const a = matEvalInVec(n, 'base', u, v, ctx), e = matEvalInScalar(n, 'exp', u, v, ctx); res = { r: Math.pow(Math.max(0, a.r), e), g: Math.pow(Math.max(0, a.g), e), b: Math.pow(Math.max(0, a.b), e) }; break; }
    case 'math.oneminus': { const a = matEvalInVec(n, 'v', u, v, ctx); res = { r: 1 - a.r, g: 1 - a.g, b: 1 - a.b }; break; }
    case 'math.clamp':    { const a = matEvalInVec(n, 'v', u, v, ctx), lo = matEvalInScalar(n, 'min', u, v, ctx), hi = matEvalInScalar(n, 'max', u, v, ctx); const cl = (x) => Math.min(hi, Math.max(lo, x)); res = { r: cl(a.r), g: cl(a.g), b: cl(a.b) }; break; }
    case 'math.normalize':{ const a = matEvalInVec(n, 'v', u, v, ctx); const l = Math.hypot(a.r, a.g, a.b) || 1; res = { r: a.r / l, g: a.g / l, b: a.b / l }; break; }
    case 'vec.make':      { res = { r: matEvalInScalar(n, 'x', u, v, ctx), g: matEvalInScalar(n, 'y', u, v, ctx), b: matEvalInScalar(n, 'z', u, v, ctx) }; break; }
    case 'vec.break':     { const a = matEvalInVec(n, 'v', u, v, ctx); res = pinKey === 'x' ? a.r : pinKey === 'y' ? a.g : a.b; break; }
    default: res = 0;
  }
  ctx.stack.delete(key);
  return res;
}
function matEvalInVec(n, pinKey, u, v, ctx) { return matAsVec(matEvalInput(n, pinKey, u, v, ctx)); }
function matEvalInScalar(n, pinKey, u, v, ctx) { return matAsScalarInput(matEvalInput(n, pinKey, u, v, ctx)); }
function matEvalInput(n, pinKey, u, v, ctx) {
  const w = matGraph().wires.find(x => x.to === n.id + ':' + pinKey);
  if (w) { const parts = w.from.split(':'); return matEvalPin(parts[0], parts[1], u, v, ctx); }
  const def = MAT_NODES[n.type];
  const spec = (def.dataIn || []).find(d => d.k === pinKey);
  const raw = (n.props && n.props[pinKey] != null) ? n.props[pinKey] : (spec ? spec.def : 0);
  if (Array.isArray(raw)) return { r: raw[0], g: raw[1], b: raw[2] };
  return parseFloat(raw) || 0;
}

/* evaluate ONE channel across an RxR grid -> ImageData. */
function matBakeChannel(chanKey, res, overrides) {
  const chan = MAT_CHAN[chanKey];
  const out = matNode('out');
  const wired = matGraph().wires.some(w => w.to === 'out:' + chanKey);
  const img = new ImageData(res, res);
  const data = img.data;
  for (let y = 0; y < res; y++) {
    const v = y / (res - 1 || 1);
    for (let x = 0; x < res; x++) {
      const u = x / (res - 1 || 1);
      let col;
      if (wired) col = matEvalInput(out, chanKey, u, v, { overrides: overrides || null, stack: new Set() });
      else col = Array.isArray(chan.def) ? { r: chan.def[0], g: chan.def[1], b: chan.def[2] } : chan.def;
      const c = chan.type === 'vector' ? matAsVec(col) : (function () { const s = matAsScalarInput(col); return { r: s, g: s, b: s }; })();
      const i = (y * res + x) * 4;
      data[i] = Math.round(Math.min(1, Math.max(0, c.r)) * 255);
      data[i + 1] = Math.round(Math.min(1, Math.max(0, c.g)) * 255);
      data[i + 2] = Math.round(Math.min(1, Math.max(0, c.b)) * 255);
      data[i + 3] = 255;
    }
  }
  return img;
}
function matBakeCanvas(chanKey, res, overrides) {
  const c = document.createElement('canvas'); c.width = res; c.height = res;
  c.getContext('2d').putImageData(matBakeChannel(chanKey, res, overrides), 0, 0);
  return c;
}

/* ============================================================
   WEBGL2 PREVIEW — a fresh, dependency-free renderer (no three.js). It bakes each
   PBR channel to a texture, then lights a sphere / cube / plane with a compact
   Cook-Torrance shader under a fixed "Simplex" 3-light rig (key + fill + rim).
   Orbit with left-drag, zoom with the wheel. Falls back to a flat swatch grid if
   WebGL2 is unavailable.
   ============================================================ */
function matBuildPreview() {
  const host = document.getElementById('matPreview'); if (!host) return;
  host.innerHTML = `
    <div class="mat-prev-head">
      <span class="eyebrow">3D Preview</span>
      <div class="seg mat-mesh" id="matMesh">
        <button data-mesh="sphere" class="${MAT.mat.ui.mesh === 'sphere' ? 'on' : ''}">Sphere</button>
        <button data-mesh="cube" class="${MAT.mat.ui.mesh === 'cube' ? 'on' : ''}">Cube</button>
        <button data-mesh="plane" class="${MAT.mat.ui.mesh === 'plane' ? 'on' : ''}">Plane</button>
      </div>
    </div>
    <div class="mat-prev-canvaswrap" id="matCanvasWrap">
      <canvas class="mat-prev-canvas" id="matCanvas"></canvas>
      <div class="mat-prev-msg dim mono" id="matPrevMsg" style="display:none"></div>
    </div>
    <div class="mat-prev-chans" id="matChanThumbs"></div>`;
  host.querySelector('#matMesh').querySelectorAll('[data-mesh]').forEach(b => b.onclick = () => {
    MAT.mat.ui.mesh = b.dataset.mesh;
    host.querySelectorAll('[data-mesh]').forEach(x => x.classList.toggle('on', x === b));
    matMarkDirty(); if (MAT.preview) MAT.preview.setMesh(b.dataset.mesh);
  });
  matInitGL();
  matQueuePreview();
}

/* debounced re-bake+upload so dragging sliders doesn't thrash */
function matQueuePreview() {
  if (MAT._prevTimer) clearTimeout(MAT._prevTimer);
  MAT._prevTimer = setTimeout(() => { matRefreshPreview(); }, 180);
}
async function matRefreshPreview() {
  await matPreloadTextures();
  matRenderThumbs();
  if (MAT.preview) {
    const R = 256;
    const maps = {};
    MAT_CHANNELS.forEach(c => { maps[c.k] = matBakeChannel(c.k, R, MAT.previewOverrides || null); });
    MAT.preview.setMaps(maps, R);
    MAT.preview.render();
  }
}

/* small per-channel thumbnails under the preview */
function matRenderThumbs() {
  const host = document.getElementById('matChanThumbs'); if (!host) return;
  const R = 48;
  host.innerHTML = '';
  MAT_CHANNELS.forEach(c => {
    const wired = matGraph().wires.some(w => w.to === 'out:' + c.k);
    const cv = matBakeCanvas(c.k, R, MAT.previewOverrides || null);
    const wrap = document.createElement('div');
    wrap.className = 'mat-chan-thumb' + (wired ? ' on' : '');
    wrap.title = c.label + (wired ? '' : ' (default)');
    cv.className = 'mat-chan-cv';
    wrap.appendChild(cv);
    const lbl = document.createElement('span'); lbl.className = 'mat-chan-lbl'; lbl.textContent = c.label;
    wrap.appendChild(lbl);
    host.appendChild(wrap);
  });
}

/* ---- the GL renderer ---- */
function matInitGL() {
  const canvas = document.getElementById('matCanvas'); if (!canvas) return;
  const msg = document.getElementById('matPrevMsg');
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!gl) { if (msg) { msg.style.display = ''; msg.textContent = 'WebGL2 not available — showing channel thumbnails only.'; } MAT.preview = null; return; }
  const prog = matGLProgram(gl);
  if (!prog) { if (msg) { msg.style.display = ''; msg.textContent = 'Shader failed to compile.'; } return; }
  gl.useProgram(prog);

  // geometry buffers (built lazily per mesh)
  const meshes = {};
  function mesh(kind) {
    if (meshes[kind]) return meshes[kind];
    const g = kind === 'cube' ? matCubeGeo() : kind === 'plane' ? matPlaneGeo() : matSphereGeo(48, 96);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const put = (data, loc, size) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); };
    put(g.pos, 0, 3); put(g.nrm, 1, 3); put(g.uv, 2, 2);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    meshes[kind] = { vao, count: g.idx.length };
    return meshes[kind];
  }

  // one texture per channel
  const texUnits = { baseColor: 0, normal: 1, roughness: 2, metallic: 3, ao: 4, emissive: 5, opacity: 6 };
  const textures = {};
  MAT_CHANNELS.forEach(c => {
    const tx = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + texUnits[c.k]); gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    textures[c.k] = tx;
    gl.uniform1i(gl.getUniformLocation(prog, 'u_' + c.k), texUnits[c.k]);
  });

  const uni = {
    proj: gl.getUniformLocation(prog, 'u_proj'), view: gl.getUniformLocation(prog, 'u_view'),
    model: gl.getUniformLocation(prog, 'u_model'), cam: gl.getUniformLocation(prog, 'u_cam'),
  };

  const state = { mesh: MAT.mat.ui.mesh || 'sphere', yaw: 0.6, pitch: 0.3, dist: 3.2 };

  function resize() {
    const wrap = document.getElementById('matCanvasWrap'); if (!wrap) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = wrap.clientWidth, h = wrap.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  }

  function render() {
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.DEPTH_TEST); gl.clearColor(0.055, 0.06, 0.075, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(prog);
    const aspect = canvas.width / canvas.height;
    const proj = matPerspective(Math.PI / 4, aspect, 0.1, 100);
    const cx = state.dist * Math.cos(state.pitch) * Math.sin(state.yaw);
    const cy = state.dist * Math.sin(state.pitch);
    const cz = state.dist * Math.cos(state.pitch) * Math.cos(state.yaw);
    const view = matLookAt([cx, cy, cz], [0, 0, 0], [0, 1, 0]);
    const model = matIdentity();
    gl.uniformMatrix4fv(uni.proj, false, proj); gl.uniformMatrix4fv(uni.view, false, view); gl.uniformMatrix4fv(uni.model, false, model);
    gl.uniform3f(uni.cam, cx, cy, cz);
    const mo = mesh(state.mesh); gl.bindVertexArray(mo.vao);
    gl.drawElements(gl.TRIANGLES, mo.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  function setMaps(maps, R) {
    MAT_CHANNELS.forEach(c => {
      gl.activeTexture(gl.TEXTURE0 + texUnits[c.k]); gl.bindTexture(gl.TEXTURE_2D, textures[c.k]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, R, R, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(maps[c.k].data.buffer));
    });
  }
  function setMesh(k) { state.mesh = k; render(); }

  // orbit + zoom
  canvas.onmousedown = (e) => {
    if (e.button !== 0) return; e.preventDefault();
    const s = { x: e.clientX, y: e.clientY, yaw: state.yaw, pitch: state.pitch };
    const mv = (ev) => { state.yaw = s.yaw + (ev.clientX - s.x) * 0.01; state.pitch = Math.max(-1.4, Math.min(1.4, s.pitch + (ev.clientY - s.y) * 0.01)); render(); };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  };
  canvas.onwheel = (e) => { e.preventDefault(); state.dist = Math.max(1.6, Math.min(8, state.dist * (e.deltaY < 0 ? 0.92 : 1.08))); render(); };

  MAT.preview = { render, setMaps, setMesh, gl };
  // keep the canvas sized on container resize
  if (MAT._ro) MAT._ro.disconnect();
  MAT._ro = new ResizeObserver(() => { if (MAT.preview) render(); });
  const wrap = document.getElementById('matCanvasWrap'); if (wrap) MAT._ro.observe(wrap);
}

function matGLProgram(gl) {
  const vs = `#version 300 es
  layout(location=0) in vec3 a_pos; layout(location=1) in vec3 a_nrm; layout(location=2) in vec2 a_uv;
  uniform mat4 u_proj, u_view, u_model;
  out vec3 v_wpos; out vec3 v_nrm; out vec2 v_uv;
  void main(){ vec4 wp = u_model * vec4(a_pos,1.0); v_wpos = wp.xyz; v_nrm = mat3(u_model)*a_nrm; v_uv = a_uv; gl_Position = u_proj*u_view*wp; }`;
  const fs = `#version 300 es
  precision highp float;
  in vec3 v_wpos; in vec3 v_nrm; in vec2 v_uv; out vec4 o_col;
  uniform sampler2D u_baseColor, u_normal, u_roughness, u_metallic, u_ao, u_emissive, u_opacity;
  uniform vec3 u_cam;
  const float PI = 3.14159265;
  vec3 srgb(vec3 c){ return pow(c, vec3(1.0/2.2)); }
  vec3 tolin(vec3 c){ return pow(c, vec3(2.2)); }
  float D_GGX(float NoH, float a){ float a2=a*a; float d=(NoH*NoH*(a2-1.0)+1.0); return a2/(PI*d*d+1e-6); }
  float G_Smith(float NoV, float NoL, float a){ float k=a*a/2.0; float gv=NoV/(NoV*(1.0-k)+k); float gl=NoL/(NoL*(1.0-k)+k); return gv*gl; }
  vec3 F_Schlick(float cosT, vec3 F0){ return F0 + (1.0-F0)*pow(1.0-cosT,5.0); }
  void main(){
    vec3 base = tolin(texture(u_baseColor, v_uv).rgb);
    float rough = clamp(texture(u_roughness, v_uv).r, 0.04, 1.0);
    float metal = texture(u_metallic, v_uv).r;
    float ao = texture(u_ao, v_uv).r;
    vec3 emis = tolin(texture(u_emissive, v_uv).rgb);
    // perturb normal from the normal map (tangent-space, approximated in world up-frame)
    vec3 nTex = texture(u_normal, v_uv).rgb * 2.0 - 1.0;
    vec3 N = normalize(v_nrm);
    vec3 T = normalize(cross(vec3(0.0,1.0,0.0), N) + vec3(1e-4,0.0,0.0));
    vec3 B = cross(N, T);
    N = normalize(mat3(T,B,N) * normalize(nTex + vec3(0.0,0.0,0.35)));
    vec3 V = normalize(u_cam - v_wpos);
    float NoV = max(dot(N,V), 1e-3);
    vec3 F0 = mix(vec3(0.04), base, metal);
    // Simplex 3-light rig: key (warm), fill (cool), rim (bright)
    vec3 L[3]; vec3 Lc[3];
    L[0]=normalize(vec3(0.6,0.8,0.7));   Lc[0]=vec3(1.0,0.96,0.9)*3.0;
    L[1]=normalize(vec3(-0.7,0.2,0.5));  Lc[1]=vec3(0.55,0.65,0.85)*1.3;
    L[2]=normalize(vec3(0.1,0.5,-0.9));  Lc[2]=vec3(0.9,0.95,1.0)*1.6;
    vec3 col = vec3(0.0);
    for(int i=0;i<3;i++){
      vec3 Ld=L[i]; vec3 H=normalize(V+Ld); float NoL=max(dot(N,Ld),0.0);
      float NoH=max(dot(N,H),0.0); float VoH=max(dot(V,H),0.0);
      float D=D_GGX(NoH,rough); float G=G_Smith(NoV,NoL,rough); vec3 F=F_Schlick(VoH,F0);
      vec3 spec=(D*G)*F/(4.0*NoV*NoL+1e-4);
      vec3 kd=(1.0-F)*(1.0-metal);
      col += (kd*base/PI + spec)*Lc[i]*NoL;
    }
    vec3 amb = base*vec3(0.10,0.11,0.13)*ao;
    col = col*ao + amb + emis;
    o_col = vec4(srgb(col/(col+vec3(1.0))*1.15), 1.0);
  }`;
  const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error('[material] shader', gl.getShaderInfoLog(s)); return null; } return s; };
  const v = compile(gl.VERTEX_SHADER, vs), f = compile(gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const p = gl.createProgram(); gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error('[material] link', gl.getProgramInfoLog(p)); return null; }
  return p;
}

/* ---- tiny mat4 + geometry helpers ---- */
function matIdentity() { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }
function matPerspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
}
function matLookAt(eye, center, up) {
  const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
  const norm = (a) => { const l = Math.hypot(a[0],a[1],a[2])||1; return [a[0]/l,a[1]/l,a[2]/l]; };
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const dot = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const z = norm(sub(eye, center)), x = norm(cross(up, z)), y = cross(z, x);
  return new Float32Array([x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0, -dot(x,eye),-dot(y,eye),-dot(z,eye),1]);
}
function matSphereGeo(stacks, slices) {
  const pos = [], nrm = [], uv = [], idx = [];
  for (let i = 0; i <= stacks; i++) {
    const phi = i / stacks * Math.PI;
    for (let j = 0; j <= slices; j++) {
      const theta = j / slices * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(theta), y = Math.cos(phi), z = Math.sin(phi) * Math.sin(theta);
      pos.push(x, y, z); nrm.push(x, y, z); uv.push(j / slices, i / stacks);
    }
  }
  for (let i = 0; i < stacks; i++) for (let j = 0; j < slices; j++) {
    const a = i * (slices + 1) + j, b = a + slices + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: new Uint32Array(idx) };
}
function matCubeGeo() {
  const faces = [
    { n: [0,0,1],  u: [1,0,0], v: [0,1,0] }, { n: [0,0,-1], u: [-1,0,0], v: [0,1,0] },
    { n: [1,0,0],  u: [0,0,-1], v: [0,1,0] }, { n: [-1,0,0], u: [0,0,1], v: [0,1,0] },
    { n: [0,1,0],  u: [1,0,0], v: [0,0,-1] }, { n: [0,-1,0], u: [1,0,0], v: [0,0,1] },
  ];
  const pos = [], nrm = [], uv = [], idx = []; let base = 0;
  faces.forEach(f => {
    const c = f.n;
    const corners = [[-1,-1],[1,-1],[1,1],[-1,1]];
    corners.forEach(([su, sv]) => {
      pos.push(c[0]*0.9 + f.u[0]*su*0.9 + f.v[0]*sv*0.9, c[1]*0.9 + f.u[1]*su*0.9 + f.v[1]*sv*0.9, c[2]*0.9 + f.u[2]*su*0.9 + f.v[2]*sv*0.9);
      nrm.push(c[0], c[1], c[2]); uv.push((su+1)/2, (sv+1)/2);
    });
    idx.push(base, base+1, base+2, base, base+2, base+3); base += 4;
  });
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: new Uint32Array(idx) };
}
function matPlaneGeo() {
  const s = 1.4;
  const pos = new Float32Array([-s,0,-s, s,0,-s, s,0,s, -s,0,s]);
  const nrm = new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0]);
  const uv = new Float32Array([0,0, 1,0, 1,1, 0,1]);
  const idx = new Uint32Array([0,1,2, 0,2,3]);
  return { pos, nrm, uv, idx };
}

/* ============================================================
   CODE MODE — scaffolded now, language deferred. It round-trips the material as a
   readable JSON view of the node model. Editing the JSON and clicking "Apply to
   graph" re-parses it back into the graph, so the plumbing is fully wired even
   while the higher-level DSL is still to come.
   ============================================================ */
function matDefaultCode() { return ''; }
function matSyncCodeFromGraph() { MAT.mat.code = JSON.stringify({ nodes: matGraph().nodes, wires: matGraph().wires }, null, 2); }
function matRenderCode() {
  const main = document.getElementById('matMain'); if (!main) return;
  if (!MAT.mat.code) matSyncCodeFromGraph();
  main.innerHTML = `
    <div class="mat-code">
      <div class="mat-code-bar">
        <span class="dim mono">Code mode — beta. Edit the material model as JSON; a higher-level material language is coming.</span>
        <div class="spacer"></div>
        <button class="btn ghost sm" id="matCodeFrom">${svg('refresh', 13)} From graph</button>
        <button class="btn primary sm" id="matCodeApply">${svg('check', 13)} Apply to graph</button>
      </div>
      <textarea class="mat-code-area" id="matCodeArea" spellcheck="false"></textarea>
      <div class="mat-code-status mono" id="matCodeStatus"></div>
    </div>`;
  const area = main.querySelector('#matCodeArea'); area.value = MAT.mat.code;
  area.oninput = () => { MAT.mat.code = area.value; };
  main.querySelector('#matCodeFrom').onclick = () => { matSyncCodeFromGraph(); area.value = MAT.mat.code; };
  main.querySelector('#matCodeApply').onclick = () => {
    const status = main.querySelector('#matCodeStatus');
    try {
      const parsed = JSON.parse(area.value);
      if (!parsed || !Array.isArray(parsed.nodes)) throw new Error('need { nodes:[], wires:[] }');
      if (!parsed.nodes.some(n => n.type === 'output')) throw new Error('graph must include the "output" node');
      MAT.mat.graph = { nodes: parsed.nodes, wires: Array.isArray(parsed.wires) ? parsed.wires : [] };
      status.className = 'mat-code-status mono ok'; status.textContent = 'Applied. Switch to Visual to see it.';
      matMarkDirty();
    } catch (e) { status.className = 'mat-code-status mono err'; status.textContent = e.message || 'Invalid JSON'; }
  };
}

/* ============================================================
   SAVE / OPEN / NEW — materials are `.material.json` vault docs (createDoc /
   saveDocContent / fetchDocText, same as the Mini Video Editor).
   ============================================================ */
function matSerialize() { return JSON.stringify({ v: MAT_SCHEMA, name: MAT.mat.name, mode: MAT.mode, graph: MAT.mat.graph, ui: MAT.mat.ui }, null, 2); }
async function matSave(silent) {
  const content = matSerialize();
  const fileName = MAT.mat.name.replace(/[^\w.\- ]+/g, '_') + MAT_EXT;
  const s = document.getElementById('matSaved'); if (s) { s.textContent = 'saving…'; s.className = 'mat-save is-saving'; }
  try {
    if (MAT.docId) await saveDocContent(MAT.docId, content);
    else { const rec = await createDoc({ name: fileName, content, lang: 'json' }); MAT.docId = rec.id; }
    MAT.dirty = false;
    if (s) { s.textContent = 'saved · ' + new Date().toLocaleTimeString(); s.className = 'mat-save is-saved'; }
    if (!silent) toast('Material saved to your vault', 'check');
  } catch (e) { if (s) { s.textContent = 'save failed'; s.className = 'mat-save is-error'; } toast(e.message || 'Could not save', 'close'); }
}
function matNewCmd() {
  if (MAT.dirty && !confirm('Discard unsaved changes and start a new material?')) return;
  MAT.mat = matNewMaterial(); MAT.docId = null; MAT.dirty = false; MAT.sel = {}; MAT.cam = { x: 40, y: 40, zoom: 1 }; MAT.texCache = {}; MAT.mode = 'visual'; MAT.previewOverrides = null;
  matRenderShell();
}
function matOpenCmd() {
  matPickDoc(MAT_EXT, 'Open a material', async (f) => {
    try {
      const { text } = await fetchDocText(f, {});
      const data = JSON.parse(text);
      if (!data || !data.graph) return toast('Not a material file', 'close');
      MAT.mat = { v: MAT_SCHEMA, name: data.name || f.name.replace(MAT_EXT, ''), mode: data.mode || 'visual',
                  graph: data.graph, code: '', ui: data.ui || { mesh: 'sphere' } };
      MAT.docId = f.id; MAT.dirty = false; MAT.sel = {}; MAT.cam = { x: 40, y: 40, zoom: 1 }; MAT.texCache = {}; MAT.mode = 'visual'; MAT.previewOverrides = null;
      matRenderShell();
      setTimeout(matFrameAll, 30);
      toast('Material loaded', 'check');
    } catch (e) { toast('Could not open that material', 'close'); }
  });
}

/* doc picker filtered to a name suffix (mirrors mvePickDoc) */
async function matPickDoc(suffix, title, onPick) {
  try { await ensureAiDB(); } catch (e) { toast('Could not load your files', 'close'); return; }
  const all = DB.files.filter(f => !f.trashed && f.type !== 'folder' && f.name && f.name.toLowerCase().endsWith(suffix));
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal picker-modal">
    <h3>${esc(title)}</h3>
    <p>Pick a saved <span class="mono">${esc(suffix)}</span> file from your vault.</p>
    <input type="text" class="picker-search" id="pkSearch" placeholder="Search…">
    <div class="picker-list" id="pkList"></div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  const listEl = bg.querySelector('#pkList');
  const render = (q) => {
    let items = all;
    if (q) { const s = q.toLowerCase(); items = all.filter(f => f.name.toLowerCase().includes(s)); }
    items = items.slice(0, 300);
    if (!items.length) { listEl.innerHTML = `<div class="picker-empty dim mono">${all.length ? 'No matches.' : 'Nothing saved yet.'}</div>`; return; }
    listEl.innerHTML = items.map(f => `<button class="picker-item" data-id="${f.id}"><span class="pi-ic t-document">${svg('cube', 16)}</span><span class="pi-main"><span class="pi-name">${esc(f.name)}</span><span class="pi-sub mono">${esc(aiPathOf(f))}</span></span></button>`).join('');
    listEl.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { const f = all.find(x => x.id === b.dataset.id); close(); onPick(f); });
  };
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  const search = bg.querySelector('#pkSearch'); search.oninput = () => render(search.value.trim());
  render(''); search.focus();
}

/* ============================================================
   INSTANCES — a material instance stores only parameter OVERRIDES against a parent
   material. The panel lists this material's parameters (Scalar / Vector Parameter
   nodes), lets the user tweak each, previews with the overrides live, and saves a
   `.matinst.json`. Opening an instance loads its parent's graph then applies the
   overrides.
   ============================================================ */
function matListParams() {
  return matGraph().nodes.filter(n => n.type === 'param.scalar' || n.type === 'param.vector')
    .map(n => ({ name: (n.props && n.props.name) || 'Param', type: n.type === 'param.vector' ? 'vector' : 'scalar',
                 def: n.type === 'param.vector' ? (n.props && n.props.value || '#ffffff') : (parseFloat(n.props && n.props.value) || 0) }));
}
function matInstancesCmd() {
  const params = matListParams();
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  const inst = { name: MAT.mat.name + ' Instance', overrides: {} };
  bg.innerHTML = `<div class="modal mat-inst-modal">
    <h3>${svg('layers', 16)} Material Instance</h3>
    <p>Override this material's parameters without touching the graph. Save it as its own file; the preview updates live.</p>
    <label class="login-field"><span class="eyebrow">Instance name</span><input type="text" class="mve-input" id="matInstName" value="${esc(inst.name)}"></label>
    <div class="mat-inst-params" id="matInstParams"></div>
    <div class="acts">
      <button class="btn ghost" id="matInstOpen">${svg('files', 14)} Open instance</button>
      <div class="spacer"></div>
      <button class="btn ghost" data-cancel>Close</button>
      <button class="btn primary" id="matInstSave">${svg('save', 14)} Save instance</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => { MAT.previewOverrides = null; matQueuePreview(); bg.remove(); };
  const paramsHost = bg.querySelector('#matInstParams');
  const drawParams = () => {
    if (!params.length) { paramsHost.innerHTML = `<div class="dim mono mat-inst-empty">This material has no parameters yet. Add Scalar/Vector Parameter nodes in the graph to expose knobs here.</div>`; return; }
    paramsHost.innerHTML = params.map(p => {
      const cur = inst.overrides[p.name] != null ? inst.overrides[p.name] : p.def;
      const ctrl = p.type === 'vector'
        ? `<input type="color" data-p="${esc(p.name)}" value="${esc(cur)}">`
        : `<input type="number" step="0.05" data-p="${esc(p.name)}" value="${cur}">`;
      return `<div class="mat-inst-row"><span class="mat-inst-name">${esc(p.name)}</span><span class="mat-inst-type dim mono">${p.type}</span>${ctrl}</div>`;
    }).join('');
    paramsHost.querySelectorAll('[data-p]').forEach(inp => {
      inp.oninput = () => {
        inst.overrides[inp.getAttribute('data-p')] = inp.type === 'number' ? parseFloat(inp.value) || 0 : inp.value;
        MAT.previewOverrides = Object.assign({}, inst.overrides); matQueuePreview();
      };
    });
  };
  drawParams();
  const nameEl = bg.querySelector('#matInstName');
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('#matInstSave').onclick = async () => {
    const name = nameEl.value.trim() || 'Instance';
    if (!MAT.docId) { toast('Save the material first, then its instances can reference it', 'close'); return; }
    const content = JSON.stringify({ v: MAT_SCHEMA, kind: 'instance', name, parentId: MAT.docId, parentName: MAT.mat.name, overrides: inst.overrides }, null, 2);
    try {
      await createDoc({ name: name.replace(/[^\w.\- ]+/g, '_') + MAT_INST_EXT, content, lang: 'json' });
      toast('Instance saved to your vault', 'check'); close();
    } catch (e) { toast(e.message || 'Could not save instance', 'close'); }
  };
  bg.querySelector('#matInstOpen').onclick = () => {
    close();
    matPickDoc(MAT_INST_EXT, 'Open a material instance', async (f) => {
      try {
        const { text } = await fetchDocText(f, {});
        const data = JSON.parse(text);
        if (!data || data.kind !== 'instance') return toast('Not an instance file', 'close');
        // load the parent material, then apply overrides
        const parent = (DB.files || []).find(x => x.id === data.parentId);
        if (!parent) return toast('Parent material not found in your vault', 'close');
        const pt = await fetchDocText(parent, {});
        const pdata = JSON.parse(pt.text);
        MAT.mat = { v: MAT_SCHEMA, name: pdata.name || 'Material', mode: 'visual', graph: pdata.graph, code: '', ui: pdata.ui || { mesh: 'sphere' } };
        MAT.docId = parent.id; MAT.dirty = false; MAT.sel = {}; MAT.cam = { x: 40, y: 40, zoom: 1 }; MAT.texCache = {}; MAT.mode = 'visual';
        MAT.previewOverrides = data.overrides || {};
        matRenderShell(); setTimeout(matFrameAll, 30);
        toast(`Instance "${data.name}" loaded over "${MAT.mat.name}"`, 'check');
      } catch (e) { toast('Could not open that instance', 'close'); }
    });
  };
}

/* ============================================================
   EXPORT — bake each selected channel to a PNG at the chosen resolution and bundle
   them into a ZIP. Uses a pure-JS store-only ZIP writer (PNGs are already
   compressed, so "stored" is ideal) — no external library, no CSP change.
   ============================================================ */
function matOpenExport() {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  const sel = {}; MAT_CHANNELS.forEach(c => { sel[c.k] = matGraph().wires.some(w => w.to === 'out:' + c.k); });
  // always include base color even if nothing wired (flat default) so there's at least one map
  if (!Object.values(sel).some(Boolean)) sel.baseColor = true;
  bg.innerHTML = `<div class="modal mat-export-modal">
    <h3>${svg('download', 16)} Export material</h3>
    <p>Bake each texture channel to a PNG and download them as a ZIP. Channels with nothing wired export their flat default.</p>
    <label class="login-field"><span class="eyebrow">Resolution</span>
      <select class="set-select" id="matExpRes">
        <option value="256">256 × 256</option><option value="512">512 × 512</option>
        <option value="1024" selected>1024 × 1024</option><option value="2048">2048 × 2048</option><option value="4096">4096 × 4096</option>
      </select></label>
    <div class="eyebrow" style="margin-top:10px">Channels</div>
    <div class="mat-exp-chans" id="matExpChans">${MAT_CHANNELS.map(c => {
      const wired = matGraph().wires.some(w => w.to === 'out:' + c.k);
      return `<label class="mat-exp-chan"><input type="checkbox" data-ch="${c.k}" ${sel[c.k] ? 'checked' : ''}><span>${esc(c.label)}</span><span class="dim mono">${c.file}.png${wired ? '' : ' · default'}</span></label>`;
    }).join('')}</div>
    <div class="mat-exp-status mono dim" id="matExpStatus"></div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" id="matExpGo">${svg('download', 14)} Export ZIP</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelectorAll('[data-ch]').forEach(cb => cb.onchange = () => { sel[cb.getAttribute('data-ch')] = cb.checked; });
  bg.querySelector('#matExpGo').onclick = async () => {
    const res = parseInt(bg.querySelector('#matExpRes').value, 10) || 1024;
    const chans = MAT_CHANNELS.filter(c => sel[c.k]);
    if (!chans.length) { toast('Pick at least one channel', 'close'); return; }
    const status = bg.querySelector('#matExpStatus'); const go = bg.querySelector('#matExpGo');
    go.disabled = true; status.textContent = 'Loading textures…';
    try {
      await matPreloadTextures();
      const files = [];
      for (let i = 0; i < chans.length; i++) {
        const c = chans[i];
        status.textContent = `Baking ${c.label} (${i + 1}/${chans.length}) at ${res}px…`;
        await new Promise(r => setTimeout(r, 0));   // let the status paint
        const canvas = matBakeCanvas(c.k, res, MAT.previewOverrides || null);
        const blob = await new Promise(rs => canvas.toBlob(rs, 'image/png'));
        const buf = new Uint8Array(await blob.arrayBuffer());
        const base = MAT.mat.name.replace(/[^\w.\- ]+/g, '_');
        files.push({ name: `${base}_${c.file}.png`, data: buf });
      }
      status.textContent = 'Packing ZIP…';
      const zip = matBuildZip(files);
      const zipBlob = new Blob([zip], { type: 'application/zip' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a'); a.href = url; a.download = MAT.mat.name.replace(/[^\w.\- ]+/g, '_') + '_material.zip';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
      status.textContent = `Exported ${files.length} map${files.length === 1 ? '' : 's'}.`;
      toast(`Exported ${files.length} texture${files.length === 1 ? '' : 's'}`, 'check');
      setTimeout(close, 700);
    } catch (e) { status.textContent = e.message || 'Export failed'; go.disabled = false; }
  };
}

/* ---- pure-JS store-only ZIP writer (no compression; CRC32 per entry) ---- */
const _matCrcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function matCrc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = _matCrcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function matBuildZip(files) {
  const enc = new TextEncoder();
  const chunks = []; const central = []; let offset = 0;
  const u16 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255]);
  const u32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
  const push = (arr, part) => { arr.push(part); };
  files.forEach(f => {
    const nameBytes = enc.encode(f.name);
    const crc = matCrc32(f.data), size = f.data.length;
    const local = [];
    push(local, u32(0x04034b50)); push(local, u16(20)); push(local, u16(0)); push(local, u16(0)); // sig, ver, flags, method(0=store)
    push(local, u16(0)); push(local, u16(0)); // time, date
    push(local, u32(crc)); push(local, u32(size)); push(local, u32(size));
    push(local, u16(nameBytes.length)); push(local, u16(0));
    push(local, nameBytes); push(local, f.data);
    const localBuf = matConcat(local);
    chunks.push(localBuf);
    const cen = [];
    push(cen, u32(0x02014b50)); push(cen, u16(20)); push(cen, u16(20)); push(cen, u16(0)); push(cen, u16(0));
    push(cen, u16(0)); push(cen, u16(0));
    push(cen, u32(crc)); push(cen, u32(size)); push(cen, u32(size));
    push(cen, u16(nameBytes.length)); push(cen, u16(0)); push(cen, u16(0)); push(cen, u16(0)); push(cen, u16(0));
    push(cen, u32(0)); push(cen, u32(offset));
    push(cen, nameBytes);
    central.push(matConcat(cen));
    offset += localBuf.length;
  });
  const centralBuf = matConcat(central);
  const end = [];
  push(end, u32(0x06054b50)); push(end, u16(0)); push(end, u16(0));
  push(end, u16(files.length)); push(end, u16(files.length));
  push(end, u32(centralBuf.length)); push(end, u32(offset)); push(end, u16(0));
  return matConcat([matConcat(chunks), centralBuf, matConcat(end)]);
}
function matConcat(parts) {
  let len = 0; parts.forEach(p => len += p.length);
  const out = new Uint8Array(len); let o = 0;
  parts.forEach(p => { out.set(p, o); o += p.length; });
  return out;
}

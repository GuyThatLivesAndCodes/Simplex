/* ============================================================
   SIMPLEX VISUAL (apps-visual.js) — a 2D, UE5-flavoured visual game engine.
   Extracted from the old apps-misc.js scaffold and loaded on demand
   (openApp -> openLazyApp -> loadFeature("apps-visual")). Plain non-module
   script sharing app.js's global scope, so EVERYTHING lives under the single
   `VIS` namespace to avoid the top-level-const collisions that scope is prone
   to (see [[tweaks-jsx-global-scope]]).

   MENTAL MODEL (mirrors UE5): "place in Viewport, select in Outliner, configure
   in Details, manage assets in the Content Browser."
     · assets   = Content Browser items (inline textures for now)
     · actors   = reusable classes (like a Blueprint) — sprite, size, colour
     · scene    = the 2D canvas: INSTANCES that each reference an actor class
   Drag an actor from the Content Browser onto the Viewport -> a new instance.
   Everything is one JSON document (schema-versioned) saved to the account's
   encrypted DB via /api/visual/projects (see server.js visual_projects + the
   data.js vis* helpers). Debounced auto-save; per-account, so a project is only
   ever visible to its owner.

   ACTORS (schema v2) are openable documents: each has PARTS (its appearance, on
   the Canvas panel), PARAMS (named variables an instance can override + a
   blueprint can read/write) and a BLUEPRINT node graph (its behaviour). The
   class-level blueprint runs for every placed instance against that instance's
   own state. Opening an actor adds a document TAB next to the "Project" tab.
   The shared runtime (visual-runtime.js) executes blueprints in Play mode.
   ============================================================ */

const VIS_SCHEMA = 2;                 // bump when the document format changes (v2: actors have parts+params+blueprint)
const VIS_SAVE_DEBOUNCE = 1500;       // ms after the last edit before we persist
const VIS_SAVE_SAFETY = 30000;        // ms periodic safety save while editing
const VIS_GRID = 32;                  // viewport grid size (px) + snap step

/* ============================================================
   NODE REGISTRY — the single source of truth for blueprint node types.
   The editor renders pins from this; visual-runtime.js executes handlers keyed
   by the SAME type ids. Keep them in sync when adding a node.

   Pin model (deliberately tiny):
     · exec pins carry FLOW ("do this next"); wires between them define order.
       An event node has one exec OUT; an action has one exec IN + one exec OUT.
     · data pins carry VALUES (number/bool/string); an action reads a data pin
       either from a wired data node or from its own inline prop as a fallback.
   `props` describes inline editable fields shown on the node body.
   ============================================================ */
const VIS_NODES = {
  // ----- EVENTS (flow starts here; exec OUT only) -----
  'event.tick':      { cat: 'event', title: 'On Tick',        execOut: true },
  'event.start':     { cat: 'event', title: 'On Start',       execOut: true },
  'event.keyDown':   { cat: 'event', title: 'On Key Down',    execOut: true, props: [{ k: 'key', label: 'Key', type: 'key', def: 'w' }] },
  'event.keyUp':     { cat: 'event', title: 'On Key Up',      execOut: true, props: [{ k: 'key', label: 'Key', type: 'key', def: 'w' }] },
  'event.click':     { cat: 'event', title: 'On Click',       execOut: true },
  'event.dragStart': { cat: 'event', title: 'On Drag Start',  execOut: true },
  'event.drag':      { cat: 'event', title: 'On Drag',        execOut: true },
  'event.dragEnd':   { cat: 'event', title: 'On Drag End',    execOut: true },
  // Overlap: fires when this instance's AABB starts/stops intersecting another's.
  // The Other actor is exposed as an out data pin (its instance id, as a string).
  'event.overlapBegin': { cat: 'event', title: 'On Overlap Begin', execOut: true, dataOuts: [{ k: 'other', label: 'Other', type: 'string' }] },
  'event.overlapEnd':   { cat: 'event', title: 'On Overlap End',   execOut: true, dataOuts: [{ k: 'other', label: 'Other', type: 'string' }] },

  // ----- FLOW CONTROL -----
  // Branch: exec-in, a bool condition, and TWO named exec-outs (true / false).
  // Uses execOuts (an array) instead of the single execOut flag.
  'flow.branch':     { cat: 'action', title: 'Branch',        execIn: true,
                       execOuts: [{ k: 'true', label: 'True' }, { k: 'false', label: 'False' }],
                       dataIn: [{ k: 'cond', label: 'Condition', type: 'bool', def: true }] },

  // ----- ACTIONS (exec IN + exec OUT; may read data pins) -----
  // Move is a RAW add of dx/dy — no implicit delta. Multiply by the Delta node
  // yourself for frame-rate-independent motion.
  'act.move':        { cat: 'action', title: 'Move',          execIn: true, execOut: true,
                       dataIn: [{ k: 'dx', label: 'ΔX', type: 'number', def: 0 }, { k: 'dy', label: 'ΔY', type: 'number', def: 0 }] },
  'act.rotate':      { cat: 'action', title: 'Rotate',        execIn: true, execOut: true,
                       dataIn: [{ k: 'deg', label: 'Degrees', type: 'number', def: 2 }] },
  'act.setScale':    { cat: 'action', title: 'Set Scale',     execIn: true, execOut: true,
                       dataIn: [{ k: 'scale', label: 'Scale', type: 'number', def: 1 }] },
  'act.setVisible':  { cat: 'action', title: 'Set Visible',   execIn: true, execOut: true,
                       dataIn: [{ k: 'visible', label: 'Visible', type: 'bool', def: true }] },
  'act.setPartRotation': { cat: 'action', title: 'Rotate Part', execIn: true, execOut: true,
                       props: [{ k: 'part', label: 'Part', type: 'part', def: '' }],
                       dataIn: [{ k: 'deg', label: 'Degrees', type: 'number', def: 2 }] },
  // Set Variable: the value pin's TYPE follows the chosen variable (dynType:'param').
  'act.setVar':      { cat: 'action', title: 'Set Variable',  execIn: true, execOut: true,
                       props: [{ k: 'name', label: 'Variable', type: 'param', def: '' }],
                       dataIn: [{ k: 'value', label: 'Value', type: 'number', def: 0, dynType: 'param' }] },

  // ----- TRANSFORM (Set/Get Location, Rotation, Scale for the Actor or a Part) -----
  // `target` prop = 'self' (the actor) or a part id. Location is a Vec2, Rotation
  // a Float (degrees), Scale a Float. Part transforms are actor-LOCAL.
  'act.setLocation': { cat: 'action', title: 'Set Location', execIn: true, execOut: true,
                       props: [{ k: 'target', label: 'Target', type: 'target', def: 'self' }],
                       dataIn: [{ k: 'loc', label: 'Location', type: 'vec2', def: 0 }] },
  'act.setRotation': { cat: 'action', title: 'Set Rotation', execIn: true, execOut: true,
                       props: [{ k: 'target', label: 'Target', type: 'target', def: 'self' }],
                       dataIn: [{ k: 'deg', label: 'Degrees', type: 'float', def: 0 }] },
  'act.setWScale':   { cat: 'action', title: 'Set Scale',    execIn: true, execOut: true,
                       props: [{ k: 'target', label: 'Target', type: 'target', def: 'self' }],
                       dataIn: [{ k: 'scale', label: 'Scale', type: 'float', def: 1 }] },
  'data.getLocation': { cat: 'data', title: 'Get Location',  dataOut: { type: 'vec2' },
                       props: [{ k: 'target', label: '', type: 'target', def: 'self' }] },
  'data.getRotation': { cat: 'data', title: 'Get Rotation',  dataOut: { type: 'float' },
                       props: [{ k: 'target', label: '', type: 'target', def: 'self' }] },
  'data.getScale':   { cat: 'data', title: 'Get Scale',      dataOut: { type: 'float' },
                       props: [{ k: 'target', label: '', type: 'target', def: 'self' }] },

  // ----- DATA (value sources; data OUT only) -----
  'data.number':     { cat: 'data', title: 'Number',          dataOut: { type: 'number' }, props: [{ k: 'value', label: '', type: 'number', def: 0 }] },
  'data.bool':       { cat: 'data', title: 'Boolean',         dataOut: { type: 'bool' },   props: [{ k: 'value', label: '', type: 'bool', def: true }] },
  // Get Variable: the OUT pin's type follows the chosen variable (dynType:'param').
  'data.param':      { cat: 'data', title: 'Get Variable',    dataOut: { type: 'number', dynType: 'param' }, props: [{ k: 'name', label: '', type: 'param', def: '' }] },
  'data.delta':      { cat: 'data', title: 'Delta (s)',       dataOut: { type: 'number' } },
  'data.keyHeld':    { cat: 'data', title: 'Key Held?',       dataOut: { type: 'bool' },   props: [{ k: 'key', label: '', type: 'key', def: 'w' }] },
  'data.mathAdd':    { cat: 'data', title: 'Add',             dataOut: { type: 'number' },
                       dataIn: [{ k: 'a', label: 'A', type: 'number', def: 0 }, { k: 'b', label: 'B', type: 'number', def: 0 }] },
  'data.mathMul':    { cat: 'data', title: 'Multiply',        dataOut: { type: 'number' },
                       dataIn: [{ k: 'a', label: 'A', type: 'number', def: 0 }, { k: 'b', label: 'B', type: 'number', def: 0 }] },
  'data.mathSub':    { cat: 'data', title: 'Subtract',        dataOut: { type: 'number' },
                       dataIn: [{ k: 'a', label: 'A', type: 'number', def: 0 }, { k: 'b', label: 'B', type: 'number', def: 0 }] },
  // Divide: 0-safe — if the dividend OR divisor is 0 the result is 0 (never NaN/Inf).
  'data.mathDiv':    { cat: 'data', title: 'Divide',          dataOut: { type: 'number' },
                       dataIn: [{ k: 'a', label: 'A', type: 'number', def: 0 }, { k: 'b', label: 'B', type: 'number', def: 1 }] },
  'data.mathMax':    { cat: 'data', title: 'Max',             dataOut: { type: 'number' },
                       dataIn: [{ k: 'a', label: 'A', type: 'number', def: 0 }, { k: 'b', label: 'B', type: 'number', def: 0 }] },
  'data.mathMin':    { cat: 'data', title: 'Min',             dataOut: { type: 'number' },
                       dataIn: [{ k: 'a', label: 'A', type: 'number', def: 0 }, { k: 'b', label: 'B', type: 'number', def: 0 }] },
  // Interpolate (lerp): A + (B-A)*T, T normally 0..1.
  'data.mathLerp':   { cat: 'data', title: 'Interpolate',     dataOut: { type: 'number' },
                       dataIn: [{ k: 'a', label: 'A', type: 'number', def: 0 }, { k: 'b', label: 'B', type: 'number', def: 0 }, { k: 't', label: 'T', type: 'number', def: 0.5 }] },
  // Round any numeric to an Integer.
  'data.round':      { cat: 'data', title: 'Round',           dataOut: { type: 'int' },
                       dataIn: [{ k: 'v', label: 'Value', type: 'number', def: 0 }] },

  // ----- VECTORS (multi-component values) -----
  'data.makeVec2':   { cat: 'data', title: 'Make Vec2',       dataOut: { type: 'vec2' },
                       dataIn: [{ k: 'x', label: 'X', type: 'number', def: 0 }, { k: 'y', label: 'Y', type: 'number', def: 0 }] },
  'data.breakVec2':  { cat: 'data', title: 'Break Vec2',
                       dataIn: [{ k: 'v', label: 'Vec2', type: 'vec2', def: 0 }],
                       dataOuts: [{ k: 'x', label: 'X', type: 'float' }, { k: 'y', label: 'Y', type: 'float' }] },
  'data.makeVec':    { cat: 'data', title: 'Make Vector',     dataOut: { type: 'vector' },
                       dataIn: [{ k: 'x', label: 'X', type: 'number', def: 0 }, { k: 'y', label: 'Y', type: 'number', def: 0 }, { k: 'z', label: 'Z', type: 'number', def: 0 }] },
  'data.breakVec':   { cat: 'data', title: 'Break Vector',
                       dataIn: [{ k: 'v', label: 'Vector', type: 'vector', def: 0 }],
                       dataOuts: [{ k: 'x', label: 'X', type: 'float' }, { k: 'y', label: 'Y', type: 'float' }, { k: 'z', label: 'Z', type: 'float' }] },
};

/* ============================================================
   NUMBER SUBTYPES (UE5-style, byte-optimized). These are STRICT pin types: a
   Byte pin will not connect to an Integer pin — convert explicitly. 'number' /
   'float' are the generic scalar (kept compatible for legacy nodes like Move).
   ============================================================ */
const VIS_NUM_TYPES = [
  { t: 'byte',   label: 'Byte',    hint: '0..255' },
  { t: 'byte64', label: 'Byte64',  hint: '0..2^64-1' },
  { t: 'int',    label: 'Integer', hint: 'whole' },
  { t: 'float',  label: 'Float',   hint: 'decimal' },
];
/* Generated conversion + comparison nodes are folded in here. `bool.toFloat`,
   `num.toFloat.<t>`, `num.round.<t>`, `num.to.<t>.<u>` (convert), plus per-type
   comparison nodes (gt/gte/lt/lte/eq/neq/between). */
(function buildNumberNodes() {
  // Boolean -> Float
  VIS_NODES['bool.toFloat'] = { cat: 'data', title: 'Bool → Float', dataOut: { type: 'float' },
    dataIn: [{ k: 'b', label: 'Bool', type: 'bool', def: false }] };

  VIS_NUM_TYPES.forEach(src => {
    // To Float (from any number type)
    if (src.t !== 'float') {
      VIS_NODES['num.toFloat.' + src.t] = { cat: 'data', title: src.label + ' → Float', dataOut: { type: 'float' },
        dataIn: [{ k: 'v', label: src.label, type: src.t, def: 0 }] };
    }
    // Round to Integer (from any number type)
    if (src.t !== 'int') {
      VIS_NODES['num.round.' + src.t] = { cat: 'data', title: 'Round ' + src.label, dataOut: { type: 'int' },
        dataIn: [{ k: 'v', label: src.label, type: src.t, def: 0 }] };
    }
    // Convert to every OTHER number type
    VIS_NUM_TYPES.forEach(dst => {
      if (dst.t === src.t) return;
      VIS_NODES['num.to.' + src.t + '.' + dst.t] = { cat: 'data',
        title: src.label + ' → ' + dst.label, dataOut: { type: dst.t },
        dataIn: [{ k: 'v', label: src.label, type: src.t, def: 0 }] };
    });
    // Comparison nodes — one set PER number type (both inputs of that type).
    const cmp = [
      { k: 'gt',  op: '>',  title: 'Greater Than' },
      { k: 'gte', op: '>=', title: 'Greater / Equal' },
      { k: 'lt',  op: '<',  title: 'Less Than' },
      { k: 'lte', op: '<=', title: 'Less / Equal' },
      { k: 'eq',  op: '==', title: 'Equal' },
      { k: 'neq', op: '!=', title: 'Not Equal' },
    ];
    cmp.forEach(c => {
      VIS_NODES['cmp.' + c.k + '.' + src.t] = { cat: 'data',
        title: c.title + ' (' + src.label + ')', cmpOp: c.k, dataOut: { type: 'bool' },
        dataIn: [{ k: 'a', label: 'A', type: src.t, def: 0 }, { k: 'b', label: 'B', type: src.t, def: 0 }] };
    });
    // In Between (min <= v <= max) — per number type.
    VIS_NODES['cmp.between.' + src.t] = { cat: 'data',
      title: 'In Between (' + src.label + ')', cmpOp: 'between', dataOut: { type: 'bool' },
      dataIn: [{ k: 'v', label: 'Value', type: src.t, def: 0 }, { k: 'min', label: 'Min', type: src.t, def: 0 }, { k: 'max', label: 'Max', type: src.t, def: 0 }] };
  });
})();
/* palette groupings shown in the "add node" menu */
const VIS_NODE_GROUPS = [
  { label: 'Events', types: ['event.tick', 'event.start', 'event.keyDown', 'event.keyUp', 'event.click', 'event.dragStart', 'event.drag', 'event.dragEnd', 'event.overlapBegin', 'event.overlapEnd'] },
  { label: 'Flow', types: ['flow.branch'] },
  { label: 'Actions', types: ['act.move', 'act.rotate', 'act.setScale', 'act.setVisible', 'act.setPartRotation', 'act.setVar'] },
  { label: 'Transform', types: ['act.setLocation', 'act.setRotation', 'act.setWScale', 'data.getLocation', 'data.getRotation', 'data.getScale'] },
  { label: 'Data', types: ['data.number', 'data.bool', 'data.param', 'data.delta', 'data.keyHeld'] },
  { label: 'Math', types: ['data.mathAdd', 'data.mathSub', 'data.mathMul', 'data.mathDiv', 'data.mathMax', 'data.mathMin', 'data.mathLerp', 'data.round'] },
  { label: 'Vectors', types: ['data.makeVec2', 'data.breakVec2', 'data.makeVec', 'data.breakVec'] },
  // Convert + Compare are large generated families — list them programmatically.
  { label: 'Convert', types: (function () {
      const a = ['bool.toFloat'];
      VIS_NUM_TYPES.forEach(s => { if (s.t !== 'float') a.push('num.toFloat.' + s.t); });
      VIS_NUM_TYPES.forEach(s => { if (s.t !== 'int') a.push('num.round.' + s.t); });
      VIS_NUM_TYPES.forEach(s => VIS_NUM_TYPES.forEach(d => { if (d.t !== s.t) a.push('num.to.' + s.t + '.' + d.t); }));
      return a;
    })() },
  { label: 'Compare', types: (function () {
      const a = [];
      ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between'].forEach(k => VIS_NUM_TYPES.forEach(s => a.push('cmp.' + k + '.' + s.t)));
      return a;
    })() },
];

/* All engine state in one namespace — nothing leaks into the shared global scope. */
const VIS = {
  view: 'browser',      // 'browser' | 'editor'
  projects: [],         // browser list rows {id,name,updated}
  id: null,             // open project id
  doc: null,            // the open project document (see visNewDoc)
  sel: null,            // selected instance id (Project tab)
  dirty: false,         // unsaved changes pending
  saving: false,        // a save request is in flight
  saveTimer: null,      // debounce timer
  safetyTimer: null,    // periodic safety-save timer
  drag: null,           // active viewport drag state
  loading: false,
  // ---- document tabs (UE5-style): first tab is always the Project (level),
  // then one tab per opened actor. ----
  tabs: [],             // [{ kind:'project' } | { kind:'actor', actorId, sub:'canvas'|'blueprint' }]
  active: 0,            // index into tabs
  undo: [],             // stack of prior doc snapshots (JSON strings)
  redo: [],             // stack of undone snapshots
  undoBase: null,       // snapshot taken at the start of a coalesced drag
};

/* ---- tiny helpers -------------------------------------------------------- */
function visUid(p) { return p + Math.random().toString(36).slice(2, 8); }
function visClamp(n, lo, hi) { n = +n; if (!isFinite(n)) n = lo; return n < lo ? lo : n > hi ? hi : n; }
function visSnap(n) { return Math.round(n / VIS_GRID) * VIS_GRID; }
function visNow() { return Date.now(); }

/* ============================================================
   UNDO / REDO — one history for the whole open project doc. We snapshot the doc
   (JSON) BEFORE a committed mutation; Ctrl+Z restores the previous snapshot,
   Ctrl+Y / Ctrl+Shift+Z replays. Rapid drags coalesce: visPushUndo at drag start,
   and if nothing actually changed the entry is dropped (visPopUndoIfUnchanged).
   ============================================================ */
const VIS_UNDO_MAX = 60;
function visSnapshot() { try { return JSON.stringify(VIS.doc); } catch (e) { return null; } }
/* Record the current doc as an undo point (call BEFORE mutating). */
function visPushUndo() {
  if (!VIS.doc) return;
  const snap = visSnapshot(); if (snap == null) return;
  VIS.undo.push(snap);
  if (VIS.undo.length > VIS_UNDO_MAX) VIS.undo.shift();
  VIS.redo.length = 0;              // a new action invalidates the redo stack
  VIS.undoBase = snap;             // remember for the "nothing changed" check
}
/* If the doc is identical to the last pushed snapshot, drop that entry (a click
   that pushed undo but then didn't move anything). */
function visPopUndoIfUnchanged() {
  if (VIS.undoBase != null && VIS.undo.length && VIS.undo[VIS.undo.length - 1] === VIS.undoBase && visSnapshot() === VIS.undoBase) {
    VIS.undo.pop();
  }
  VIS.undoBase = null;
}
function visUndo() {
  if (!VIS.undo.length) return;
  const cur = visSnapshot();
  const prev = VIS.undo.pop();
  if (cur != null) VIS.redo.push(cur);
  visApplySnapshot(prev);
}
function visRedo() {
  if (!VIS.redo.length) return;
  const cur = visSnapshot();
  const next = VIS.redo.pop();
  if (cur != null) VIS.undo.push(cur);
  visApplySnapshot(next);
}
/* Replace the live doc with a snapshot and re-render whatever's on screen. */
function visApplySnapshot(snap) {
  let doc; try { doc = JSON.parse(snap); } catch (e) { return; }
  VIS.doc = visNormalizeDoc(doc, doc && doc.meta && doc.meta.name);
  // drop selections that may no longer exist
  VIS.sel = null;
  VIS.tabs.forEach(t => { if (t.kind === 'actor') { if (!visActor(t.actorId)) { /* actor gone */ } t.selPart = null; t.selParts = {}; if (t.sel) t.sel = {}; } });
  // close tabs whose actor was removed by the undo
  VIS.tabs = VIS.tabs.filter(t => t.kind === 'project' || visActor(t.actorId));
  if (VIS.active >= VIS.tabs.length) VIS.active = VIS.tabs.length - 1;
  VIS.doc.meta.modified = visNow();
  visRerenderActive();
  visQueueSave();
}
/* Re-render the active tab from scratch (used after undo/redo). */
function visRerenderActive() {
  const t = VIS.tabs[VIS.active];
  visRenderTabs && visRenderTabs();
  if (!t || t.kind === 'project') { if (typeof visRenderProjectTab === 'function') visRenderProjectTab(); }
  else if (typeof visRenderActorTab === 'function') visRenderActorTab(t.actorId);
}

/* A fresh, valid project document. This is the single source of truth for the
   ".simplexvisual" format — every reader/writer goes through this shape. */
function visNewDoc(name) {
  return {
    schema: VIS_SCHEMA,
    meta: { name: name || 'Untitled project', created: visNow(), modified: visNow() },
    assets: [],     // { id, name, kind:'texture', data:<dataURL> }
    actors: [],     // see visMakeActor
    scene: {
      camera: { x: 0, y: 0, zoom: 1 },
      instances: [], // { id, actor:<actorId>, x, y, rotation, scale, name, props:{} }
    },
    world: visNewWorld(),
  };
}

/* World/level settings. Physics gravity is OFF by default (0). Mobility lives
   per-actor; the world just supplies the gravity vector every Movable object
   feels, plus scene lighting. */
function visNewWorld() {
  return {
    physics: { gravity: 0, gravityX: 0, gravityY: 1 },   // gravity magnitude (px/s²·scale) × unit dir
    light: {
      ambientColor: '#ffffff', ambientIntensity: 1,       // 1 = fully lit (no darkening)
      points: [],   // { id, name, x, y, color, radius, intensity }
    },
  };
}

/* A fresh v2 actor. An actor is a small tree of PARTS (its appearance, edited on
   the Canvas panel) + PARAMS (named variables an instance can override / a
   blueprint can read+write) + a BLUEPRINT graph (its behaviour). The class-level
   blueprint runs for every placed instance against that instance's own state. */
function visMakeActor(name, colorSeed) {
  const w = 64, h = 64;
  return {
    id: visUid('act_'),
    name: name || 'Actor',
    size: { w, h },                 // overall bounds (used for hit box + default part)
    parts: [                        // { id, name, sprite:<assetId|null>, color, x, y, w, h, rotation, z }
      { id: visUid('prt_'), name: 'Body', sprite: null, color: visActorColor(colorSeed || 1), x: 0, y: 0, w, h, rotation: 0, z: 0 },
    ],
    params: [],                     // { id, name, type:<var type>, value } — see VIS_VAR_TYPES
    blueprint: { nodes: [], wires: [] },   // see the Blueprint editor
    mobility: 'static',             // 'static' | 'movable' (physics; movable feels gravity + integrates velocity)
  };
}

/* Every type a VARIABLE can be — a superset of the pin types: bool, string, the
   four numeric subtypes, and the vectors. The var dropdown lists ALL of these. */
const VIS_VAR_TYPES = [
  { t: 'float',  label: 'Float' },
  { t: 'int',    label: 'Integer' },
  { t: 'byte',   label: 'Byte' },
  { t: 'byte64', label: 'Byte64' },
  { t: 'bool',   label: 'Boolean' },
  { t: 'string', label: 'Text' },
  { t: 'vec2',   label: 'Vec2' },
  { t: 'vector', label: 'Vector' },
];
function visIsNumType(t) { return t === 'float' || t === 'int' || t === 'byte' || t === 'byte64' || t === 'number'; }

/* Coerce ANY actor (fresh, v1, or half-written) into a valid v2 actor, in place.
   v1 actors carried flat sprite/color/size + script:null — fold those into a
   single default part and an empty blueprint so old projects keep working. */
function visMigrateActor(a) {
  if (!a || typeof a !== 'object') return visMakeActor();
  if (!a.id) a.id = visUid('act_');
  if (!a.name) a.name = 'Actor';
  a.size = a.size && typeof a.size === 'object' ? { w: +a.size.w || 64, h: +a.size.h || 64 } : { w: 64, h: 64 };
  if (!Array.isArray(a.parts) || !a.parts.length) {
    // v1 -> v2: the old single sprite/color becomes one "Body" part.
    a.parts = [{ id: visUid('prt_'), name: 'Body', sprite: a.sprite || null, color: a.color || '#8a8f98',
      x: 0, y: 0, w: a.size.w, h: a.size.h, rotation: 0, z: 0 }];
  } else {
    a.parts.forEach((p, idx) => {
      if (!p.id) p.id = visUid('prt_');
      if (p.sprite === undefined) p.sprite = null;
      if (!p.color) p.color = '#8a8f98';
      p.x = +p.x || 0; p.y = +p.y || 0;
      p.w = +p.w || a.size.w; p.h = +p.h || a.size.h;
      p.rotation = +p.rotation || 0;
      p.z = p.z == null ? idx : +p.z;
      if (!p.name) p.name = 'Part ' + (idx + 1);
    });
  }
  if (!Array.isArray(a.params)) a.params = [];
  a.params.forEach(pr => { if (!pr.id) pr.id = visUid('par_'); if (!pr.type) pr.type = 'number'; if (!pr.name) pr.name = 'var'; if (pr.value === undefined) pr.value = visVarDefault(pr.type); });
  if (a.mobility !== 'movable') a.mobility = 'static';
  a.blueprint = a.blueprint && typeof a.blueprint === 'object' ? a.blueprint : {};
  if (!Array.isArray(a.blueprint.nodes)) a.blueprint.nodes = [];
  if (!Array.isArray(a.blueprint.wires)) a.blueprint.wires = [];
  // shed the dead v1 fields so they don't linger
  delete a.sprite; delete a.color; delete a.script;
  return a;
}

/* Forward-compat: coerce whatever the server hands back into a valid v2 doc so a
   half-written or older document never crashes the editor. */
function visNormalizeDoc(d, fallbackName) {
  if (!d || typeof d !== 'object') return visNewDoc(fallbackName);
  d.schema = VIS_SCHEMA;
  d.meta = d.meta || {}; d.meta.name = d.meta.name || fallbackName || 'Untitled project';
  if (!Array.isArray(d.assets)) d.assets = [];
  if (!Array.isArray(d.actors)) d.actors = [];
  d.actors.forEach(visMigrateActor);
  d.scene = d.scene || {};
  d.scene.camera = d.scene.camera || { x: 0, y: 0, zoom: 1 };
  if (!Array.isArray(d.scene.instances)) d.scene.instances = [];
  d.scene.instances.forEach(i => { if (!i.props || typeof i.props !== 'object') i.props = {}; });
  d.world = visNormalizeWorld(d.world);
  return d;
}

/* Coerce a world block (older docs have none) into a valid shape. */
function visNormalizeWorld(w) {
  const base = visNewWorld();
  if (!w || typeof w !== 'object') return base;
  const ph = w.physics || {};
  base.physics.gravity = +ph.gravity || 0;
  base.physics.gravityX = ph.gravityX == null ? 0 : +ph.gravityX;
  base.physics.gravityY = ph.gravityY == null ? 1 : +ph.gravityY;
  const li = w.light || {};
  base.light.ambientColor = typeof li.ambientColor === 'string' ? li.ambientColor : '#ffffff';
  base.light.ambientIntensity = li.ambientIntensity == null ? 1 : visClamp(li.ambientIntensity, 0, 4);
  base.light.points = Array.isArray(li.points) ? li.points.map(p => ({
    id: p.id || visUid('lit_'), name: p.name || 'Light',
    x: +p.x || 0, y: +p.y || 0, color: typeof p.color === 'string' ? p.color : '#ffd9a0',
    radius: p.radius == null ? 200 : Math.max(1, +p.radius), intensity: p.intensity == null ? 1 : visClamp(p.intensity, 0, 4),
  })) : [];
  return base;
}

function visActor(id) { return VIS.doc && VIS.doc.actors.find(a => a.id === id) || null; }
function visAsset(id) { return VIS.doc && VIS.doc.assets.find(a => a.id === id) || null; }
function visInst(id) { return VIS.doc && VIS.doc.scene.instances.find(i => i.id === id) || null; }
/* parts sorted bottom->top for painting */
function visActorParts(a) { return a && Array.isArray(a.parts) ? a.parts.slice().sort((p, q) => (p.z || 0) - (q.z || 0)) : []; }

/* ============================================================
   ENTRY POINTS (called by openLazyApp): visualHTML + wireVisual
   ============================================================ */
function visualHTML() {
  return `<div class="visual-app" data-screen-label="Simplex Visual">
    <div class="vis-warnbar">${svg('info', 15)}<span><b>Experimental</b> — Simplex Visual is an early build. Expect rough edges; your projects auto-save to your account.</span></div>
    <div class="vis-root" id="visRoot">
      <div class="vis-loading">${svg('cube', 26)}<span>Loading Simplex Visual…</span></div>
    </div>
  </div>`;
}

async function wireVisual() {
  // Flush + tear down timers when the user leaves the app (nav to dashboard/other app).
  _appCleanup = () => { visFlushSave(); if (VIS.saveTimer) clearTimeout(VIS.saveTimer); if (VIS.safetyTimer) clearInterval(VIS.safetyTimer); VIS.saveTimer = VIS.safetyTimer = null; if (VIS._bpKeyHandler) { document.removeEventListener('keydown', VIS._bpKeyHandler); VIS._bpKeyHandler = null; } if (VIS._undoKeyHandler) { document.removeEventListener('keydown', VIS._undoKeyHandler); VIS._undoKeyHandler = null; } visCloseCreator(); };
  VIS.view = 'browser';
  await visLoadProjects();
}

/* ============================================================
   PROJECT BROWSER — the UE5-style "pick or create a project" screen.
   ============================================================ */
async function visLoadProjects() {
  const root = document.getElementById('visRoot');
  if (!root) return;
  VIS.loading = true;
  try {
    VIS.projects = await listVisProjects();
  } catch (e) {
    root.innerHTML = `<div class="vis-empty"><h2>Couldn't load your projects</h2><p class="dim">Check your connection and try again.</p></div>`;
    return;
  }
  VIS.loading = false;
  if (currentApp !== 'visual') return;   // navigated away while loading
  visRenderBrowser();
}

function visRenderBrowser() {
  const root = document.getElementById('visRoot');
  if (!root) return;
  const rows = VIS.projects.map(p => `
    <div class="vis-proj" data-open="${esc(p.id)}" tabindex="0" role="button">
      <div class="vis-proj-thumb">${svg('cube', 30, 1.3)}</div>
      <div class="vis-proj-meta">
        <div class="vis-proj-name" data-name="${esc(p.id)}">${esc(p.name)}</div>
        <div class="vis-proj-sub dim">Edited ${visAgo(p.updated)}</div>
      </div>
      <div class="vis-proj-acts">
        <button class="btn ghost xs" data-rename="${esc(p.id)}" title="Rename">${svg('rename', 13)}</button>
        <button class="btn ghost xs danger" data-del="${esc(p.id)}" title="Delete">${svg('trash', 13)}</button>
      </div>
    </div>`).join('');

  root.innerHTML = `
    <div class="vis-browser">
      <div class="vis-browser-head">
        <div>
          <h2 class="vis-browser-title">${svg('cube', 20, 1.6)} Your Projects</h2>
          <p class="vis-browser-sub dim">Create a project, then place actors on the 2D canvas. Everything auto-saves.</p>
        </div>
        <button class="btn primary" id="visNew">${svg('plus', 15)} New Project</button>
      </div>
      <div class="vis-proj-grid">
        ${rows || `<div class="vis-noproj"><div class="vis-noproj-ico">${svg('cube', 40, 1.2)}</div><h3>No projects yet</h3><p class="dim">Click <b>New Project</b> to start your first level.</p></div>`}
      </div>
    </div>`;

  const nb = document.getElementById('visNew');
  if (nb) nb.onclick = visCreateProject;
  root.querySelectorAll('[data-open]').forEach(el => {
    el.onclick = (e) => { if (e.target.closest('[data-rename],[data-del]')) return; visOpenProject(el.getAttribute('data-open')); };
    el.onkeydown = (e) => { if (e.key === 'Enter') visOpenProject(el.getAttribute('data-open')); };
  });
  root.querySelectorAll('[data-rename]').forEach(b => b.onclick = (e) => { e.stopPropagation(); visRenameProjectInline(b.getAttribute('data-rename')); });
  root.querySelectorAll('[data-del]').forEach(b => b.onclick = (e) => { e.stopPropagation(); visDeleteProject(b.getAttribute('data-del')); });
}

function visAgo(ts) {
  if (!ts) return 'just now';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

async function visCreateProject() {
  const nb = document.getElementById('visNew');
  if (nb) { nb.disabled = true; nb.textContent = 'Creating…'; }
  try {
    const doc = visNewDoc('Untitled project');
    const rec = await createVisProject({ name: doc.meta.name, data: doc });
    await visOpenProject(rec.id, doc);
  } catch (e) {
    toast('Could not create project', 'close');
    if (nb) { nb.disabled = false; nb.textContent = 'New Project'; }
  }
}

function visRenameProjectInline(id) {
  const nameEl = document.querySelector(`.vis-proj-name[data-name="${CSS.escape(id)}"]`);
  if (!nameEl) return;
  const old = nameEl.textContent;
  const input = document.createElement('input');
  input.className = 'vis-rename-input';
  input.value = old; input.maxLength = 120;
  nameEl.replaceWith(input);
  input.focus(); input.select();
  const commit = async (save) => {
    const val = input.value.trim() || old;
    const span = document.createElement('div');
    span.className = 'vis-proj-name'; span.setAttribute('data-name', id); span.textContent = save ? val : old;
    input.replaceWith(span);
    span.parentElement && span.parentElement.querySelector('[data-rename]') && (span.parentElement.querySelector('[data-rename]').onclick = (e) => { e.stopPropagation(); visRenameProjectInline(id); });
    if (save && val !== old) {
      try { await updateVisProject(id, { name: val }); const row = VIS.projects.find(p => p.id === id); if (row) row.name = val; }
      catch (e) { toast('Rename failed', 'close'); span.textContent = old; }
    }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); };
  input.onblur = () => commit(true);
}

function visDeleteProject(id) {
  const row = VIS.projects.find(p => p.id === id);
  confirmModal(
    'Delete this project?',
    `“${(row && row.name) || 'This project'}” will be permanently deleted. This can't be undone.`,
    async () => {
      try { await deleteVisProject(id); VIS.projects = VIS.projects.filter(p => p.id !== id); visRenderBrowser(); toast('Project deleted'); }
      catch (e) { toast('Could not delete', 'close'); }
    }
  );
}

/* ============================================================
   EDITOR — the UE5 3-panel shell (toolbar / outliner+content / viewport / details)
   ============================================================ */
async function visOpenProject(id, preDoc) {
  const root = document.getElementById('visRoot');
  if (root) root.innerHTML = `<div class="vis-loading">${svg('cube', 26)}<span>Opening project…</span></div>`;
  let doc = preDoc;
  if (!doc) {
    try { const rec = await getVisProject(id); doc = visNormalizeDoc(rec && rec.data, rec && rec.name); }
    catch (e) { toast('Could not open project', 'close'); visRenderBrowser(); return; }
  } else {
    doc = visNormalizeDoc(doc, doc.meta && doc.meta.name);
  }
  if (currentApp !== 'visual') return;
  VIS.view = 'editor'; VIS.id = id; VIS.doc = doc; VIS.sel = null; VIS.dirty = false;
  VIS.tabs = [{ kind: 'project' }]; VIS.active = 0;   // start with just the Project tab
  VIS.undo = []; VIS.redo = []; VIS.undoBase = null;  // fresh history per opened project
  visRenderEditor();
  visInstallUndoKeys();
  // periodic safety save while the editor is open
  if (VIS.safetyTimer) clearInterval(VIS.safetyTimer);
  VIS.safetyTimer = setInterval(() => { if (VIS.dirty) visFlushSave(); }, VIS_SAVE_SAFETY);
}

/* Editor-wide Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z (works on any tab). Installed while
   the editor is open; ignores keystrokes while typing in a field. */
function visInstallUndoKeys() {
  if (VIS._undoKeyHandler) { document.removeEventListener('keydown', VIS._undoKeyHandler); VIS._undoKeyHandler = null; }
  const handler = (e) => {
    if (VIS.view !== 'editor') return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.target.isContentEditable) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'z' && !e.shiftKey) { visUndo(); e.preventDefault(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { visRedo(); e.preventDefault(); }
  };
  VIS._undoKeyHandler = handler;
  document.addEventListener('keydown', handler);
}

/* ---- editor shell: the persistent tab strip + the active tab's body -------- */
function visRenderEditor() {
  const root = document.getElementById('visRoot');
  if (!root || !VIS.doc) return;
  root.innerHTML = `
    <div class="vis-editor">
      <div class="vis-tabbar">
        <button class="btn ghost sm vis-tabbar-back" id="visBack" title="Back to projects">${svg('back', 15)}</button>
        <div class="vis-tabstrip" id="visTabStrip"></div>
        <div class="spacer"></div>
        <button class="vis-play" id="visPlay" title="Play this project in a new tab">${svg('play', 14)} Play</button>
        <div class="vis-save" id="visSaveState" title="Auto-save status">${svg('save', 14)} <span>Saved</span></div>
      </div>
      <div class="vis-tabbody" id="visTabBody"></div>
    </div>`;

  document.getElementById('visBack').onclick = visLeaveEditor;
  document.getElementById('visPlay').onclick = visPlayProject;
  visRenderTabs();
  visRenderActiveTab();
}

function visLeaveEditor() {
  visFlushSave();
  if (VIS.safetyTimer) clearInterval(VIS.safetyTimer); VIS.safetyTimer = null;
  if (VIS._bpKeyHandler) { document.removeEventListener('keydown', VIS._bpKeyHandler); VIS._bpKeyHandler = null; }
  if (VIS._undoKeyHandler) { document.removeEventListener('keydown', VIS._undoKeyHandler); VIS._undoKeyHandler = null; }
  VIS.view = 'browser'; VIS.tabs = []; VIS.active = 0; VIS.undo = []; VIS.redo = [];
  visLoadProjects();
}

/* Open the project at its own /visual/play/<id> route in a new tab. */
function visPlayProject() {
  if (!VIS.id) return;
  visFlushSave();
  window.open('/visual/play/' + encodeURIComponent(VIS.id), '_blank', 'noopener');
}

/* ---- tab strip ---- */
function visRenderTabs() {
  const strip = document.getElementById('visTabStrip');
  if (!strip) return;
  strip.innerHTML = VIS.tabs.map((t, idx) => {
    const activeCls = idx === VIS.active ? ' active' : '';
    if (t.kind === 'project') {
      return `<div class="vis-tab vis-tab-project${activeCls}" data-tab="${idx}" title="The level / project">${svg('cube', 12)}<span>Project</span></div>`;
    }
    const a = visActor(t.actorId);
    const name = a ? a.name : 'Actor';
    return `<div class="vis-tab${activeCls}" data-tab="${idx}" title="${esc(name)}">${svg('window', 12)}<span class="vis-tab-name">${esc(name)}</span><button class="vis-tab-x" data-close="${idx}" title="Close">${svg('close', 11)}</button></div>`;
  }).join('');
  strip.querySelectorAll('[data-tab]').forEach(el => {
    el.onclick = (e) => { if (e.target.closest('[data-close]')) return; visActivateTab(+el.getAttribute('data-tab')); };
  });
  strip.querySelectorAll('[data-close]').forEach(b => b.onclick = (e) => { e.stopPropagation(); visCloseTab(+b.getAttribute('data-close')); });
}

function visActivateTab(idx) {
  if (idx < 0 || idx >= VIS.tabs.length || idx === VIS.active) { if (idx === VIS.active) return; }
  VIS.active = idx;
  visRenderTabs();
  visRenderActiveTab();
}

/* Open (or focus) an actor's document tab. */
function visOpenActorTab(actorId) {
  if (!visActor(actorId)) return;
  const existing = VIS.tabs.findIndex(t => t.kind === 'actor' && t.actorId === actorId);
  if (existing >= 0) { visActivateTab(existing); return; }
  VIS.tabs.push({ kind: 'actor', actorId, sub: 'canvas' });
  VIS.active = VIS.tabs.length - 1;
  visRenderTabs();
  visRenderActiveTab();
}

/* Close a tab. The Project tab (index 0) can't be closed. Everything autosaves,
   so closing is normally silent; only warn if a save genuinely failed/pending. */
function visCloseTab(idx) {
  const t = VIS.tabs[idx];
  if (!t || t.kind === 'project') return;
  const doClose = () => {
    VIS.tabs.splice(idx, 1);
    if (VIS.active >= VIS.tabs.length) VIS.active = VIS.tabs.length - 1;
    else if (idx < VIS.active) VIS.active--;
    visRenderTabs();
    visRenderActiveTab();
  };
  // Only prompt if there are unsaved changes we couldn't flush (error state or in-flight).
  if (VIS.dirty && (VIS.saving || VIS.saveError)) {
    confirmModal('Close this actor tab?', 'A save is still in progress or failed to complete. Closing now is safe — your work stays in the project and will save on the next change — but the very latest edit may not be persisted yet.', doClose, 'Close');
  } else {
    visFlushSave();   // best-effort flush the last edit, then close
    doClose();
  }
}

/* Keep an actor tab's label in sync when the actor is renamed. */
function visSyncActorTabName(actorId) {
  const idx = VIS.tabs.findIndex(t => t.kind === 'actor' && t.actorId === actorId);
  if (idx >= 0) visRenderTabs();
}

/* Render whichever tab is active into the shared body. */
function visRenderActiveTab() {
  const t = VIS.tabs[VIS.active] || VIS.tabs[0];
  if (!t) return;
  if (t.kind === 'project') visRenderProjectTab();
  else visRenderActorTab(t.actorId);
}

/* ---- the PROJECT tab: the level editor (outliner + viewport + details) ---- */
function visRenderProjectTab() {
  const body = document.getElementById('visTabBody');
  if (!body) return;
  body.innerHTML = `
    <div class="vis-projtab">
      <div class="vis-subbar">
        <div class="vis-tb-name" id="visDocName" title="Rename project">${esc(VIS.doc.meta.name)}</div>
        <div class="vis-tb-tools">
          <button class="vis-tool" data-tool="add-actor" title="New actor class">${svg('plus', 14)} Actor</button>
          <button class="vis-tool" data-tool="upload-tex" title="Upload a texture">${svg('image', 14)} Texture</button>
        </div>
      </div>
      <div class="vis-body">
        <div class="vis-left">
          <div class="vis-panel vis-outliner">
            <div class="vis-panel-h">${svg('listul', 13)} Outliner</div>
            <div class="vis-panel-b" id="visOutliner"></div>
          </div>
          <div class="vis-panel vis-content">
            <div class="vis-panel-h">${svg('folder', 13)} Content Browser
              <div class="vis-panel-h-acts">
                <button class="vis-mini" data-tool="add-actor" title="New actor">${svg('plus', 12)}</button>
                <button class="vis-mini" data-tool="upload-tex" title="Upload texture">${svg('image', 12)}</button>
              </div>
            </div>
            <div class="vis-panel-b" id="visContent"></div>
          </div>
        </div>
        <div class="vis-viewport-wrap">
          <div class="vis-viewport" id="visViewport">
            <div class="vis-vp-grid" aria-hidden="true"></div>
            <div class="vis-vp-origin" aria-hidden="true"></div>
            <div class="vis-stage" id="visStage"></div>
          </div>
          <div class="vis-vp-hint dim" id="visVpHint">Drag an actor from the Content Browser onto the canvas to place it. Double-click an actor to open its Canvas &amp; Blueprint.</div>
        </div>
        <div class="vis-right">
          <div class="vis-panel vis-details">
            <div class="vis-panel-h">${svg('gear', 13)} Details</div>
            <div class="vis-panel-b" id="visDetails"></div>
          </div>
        </div>
      </div>
    </div>`;

  const nameEl = document.getElementById('visDocName');
  if (nameEl) nameEl.onclick = visRenameDocInline;
  body.querySelectorAll('[data-tool="add-actor"]').forEach(b => b.onclick = visAddActor);
  body.querySelectorAll('[data-tool="upload-tex"]').forEach(b => b.onclick = visUploadTexture);

  visRenderContent();
  visRenderOutliner();
  visRenderStage();
  visRenderDetails();
  visWireViewport();
}

/* ---- the ACTOR tab: Canvas (appearance) | Blueprint (behaviour) ---------- */
function visRenderActorTab(actorId) {
  const body = document.getElementById('visTabBody');
  const a = visActor(actorId);
  if (!body || !a) return;
  const tab = VIS.tabs[VIS.active];
  const sub = (tab && tab.sub) || 'canvas';
  body.innerHTML = `
    <div class="vis-actortab">
      <div class="vis-subbar">
        <div class="vis-actor-name" id="visActorName" title="Rename actor">${esc(a.name)}</div>
        <div class="vis-subtabs">
          <button class="vis-subtab ${sub === 'canvas' ? 'on' : ''}" data-sub="canvas">${svg('image', 13)} Canvas</button>
          <button class="vis-subtab ${sub === 'blueprint' ? 'on' : ''}" data-sub="blueprint">${svg('brain', 13)} Blueprint</button>
        </div>
        <div class="spacer"></div>
        <button class="vis-tool" id="visActorToLevel" title="Go to the Project tab">${svg('cube', 13)} Project</button>
      </div>
      <div class="vis-actorbody" id="visActorBody"></div>
    </div>`;

  const nameEl = document.getElementById('visActorName');
  if (nameEl) nameEl.onclick = () => visRenameActorInline(actorId);
  body.querySelectorAll('[data-sub]').forEach(btn => btn.onclick = () => {
    if (tab) tab.sub = btn.getAttribute('data-sub');
    visRenderActorTab(actorId);
  });
  document.getElementById('visActorToLevel').onclick = () => visActivateTab(0);

  if (sub === 'blueprint') visRenderActorBlueprint(actorId);
  else visRenderActorCanvas(actorId);
}

/* Inline-rename an actor from its tab (keeps the tab label + content browser in sync). */
function visRenameActorInline(actorId) {
  const host = document.getElementById('visActorName');
  const a = visActor(actorId);
  if (!host || !a) return;
  const old = a.name;
  const input = document.createElement('input');
  input.className = 'vis-actor-name-input'; input.value = old; input.maxLength = 80;
  host.replaceWith(input); input.focus(); input.select();
  const commit = (save) => {
    const val = input.value.trim() || old;
    if (save && val !== old) { a.name = val; visSyncActorTabName(actorId); visRenderContent(); VIS.doc.meta.modified = visNow(); visQueueSave(); }
    visRenderActorTab(actorId);
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); };
  input.onblur = () => commit(true);
}

/* ============================================================
   ACTOR CANVAS — the actor's appearance: a tree of PARTS + its VARIABLES.
   Layout mirrors the level editor: left = parts + variables, centre = a live
   preview of the assembled actor (parts selectable + draggable), right = the
   selected part's properties.
   ============================================================ */
function visActorTab(actorId) { return VIS.tabs.find(t => t.kind === 'actor' && t.actorId === actorId); }
function visSelPart(actorId) { const t = visActorTab(actorId); return t ? t.selPart : null; }   // the PRIMARY selected part (for the Part panel)
/* ---- Canvas transform tools + multi-part selection ---- */
function visCVTool(actorId) { const t = visActorTab(actorId); return (t && t.tool) || 'move'; }   // select|move|rotate|scale
function visCVSpace(actorId) { const t = visActorTab(actorId); return (t && t.moveSpace) || 'global'; }   // global|local
function visCVSelSet(actorId) { const t = visActorTab(actorId); if (!t.selParts) t.selParts = {}; return t.selParts; }
function visCVSelIds(actorId) { const s = visCVSelSet(actorId); return Object.keys(s).filter(k => s[k]); }
function visCVSetTool(actorId, tool) { const t = visActorTab(actorId); if (t) t.tool = tool; visRenderActorCanvas(actorId); }

function visRenderActorCanvas(actorId) {
  const box = document.getElementById('visActorBody');
  const a = visActor(actorId);
  if (!box || !a) return;
  box.innerHTML = `
    <div class="vis-canvas">
      <div class="vis-cv-left">
        <div class="vis-panel vis-cv-parts">
          <div class="vis-panel-h">${svg('listul', 13)} Parts
            <div class="vis-panel-h-acts"><button class="vis-mini" id="vcAddPart" title="Add a part">${svg('plus', 12)}</button></div>
          </div>
          <div class="vis-panel-b" id="vcPartsList"></div>
        </div>
        <div class="vis-panel vis-cv-vars">
          <div class="vis-panel-h">${svg('gear', 13)} Variables
            <div class="vis-panel-h-acts"><button class="vis-mini" id="vcAddVar" title="Add a variable">${svg('plus', 12)}</button></div>
          </div>
          <div class="vis-panel-b" id="vcVarsList"></div>
        </div>
      </div>
      <div class="vis-cv-stagewrap">
        <div class="vis-cv-tools" id="vcTools">
          <button class="vis-cv-tool" data-tool="select" title="Select (marquee)">${svg('move', 13)}<span>Select</span></button>
          <button class="vis-cv-tool" data-tool="move" title="Move">${svg('arrowup', 13)}<span>Move</span></button>
          <button class="vis-cv-tool" data-tool="rotate" title="Rotate">${svg('refresh', 13)}<span>Rotate</span></button>
          <button class="vis-cv-tool" data-tool="scale" title="Scale">${svg('full', 13)}<span>Scale</span></button>
          <div class="vis-cv-tools-sp"></div>
          <div class="vis-cv-space" id="vcSpace">
            <button class="vis-cv-spbtn" data-space="global" title="Move along world X/Y">Global</button>
            <button class="vis-cv-spbtn" data-space="local" title="Move along the part's rotation">Local</button>
          </div>
        </div>
        <div class="vis-cv-stage" id="vcStage">
          <div class="vis-cv-content" id="vcContent">
            <div class="vis-cv-actor" id="vcActor"></div>
            <div class="vis-cv-gizmo" id="vcGizmo"></div>
            <div class="vis-marquee" id="vcMarquee" style="display:none"></div>
          </div>
        </div>
        <div class="vis-bp-zoom vis-cv-zoom">
          <button class="vis-mini" id="vcZoomOut" title="Zoom out">${svg('minus', 12)}</button>
          <span id="vcZoomLbl" class="vis-bp-zoomlbl">100%</span>
          <button class="vis-mini" id="vcZoomIn" title="Zoom in">${svg('plus', 12)}</button>
          <button class="vis-mini" id="vcZoomFit" title="Center the actor">${svg('zoomfit', 12)}</button>
        </div>
        <div class="vis-vp-hint dim" id="vcHint"></div>
      </div>
      <div class="vis-cv-right">
        <div class="vis-panel vis-cv-props">
          <div class="vis-panel-h">${svg('gear', 13)} Part</div>
          <div class="vis-panel-b" id="vcPartProps"></div>
        </div>
      </div>
    </div>`;
  document.getElementById('vcAddPart').onclick = () => visAddPart(actorId);
  document.getElementById('vcAddVar').onclick = () => visAddParam(actorId);
  document.getElementById('vcZoomIn').onclick = () => visCVZoomBy(actorId, 1.2);
  document.getElementById('vcZoomOut').onclick = () => visCVZoomBy(actorId, 1 / 1.2);
  document.getElementById('vcZoomFit').onclick = () => visCVCenter(actorId);
  // transform tool bar
  const tool = visCVTool(actorId), space = visCVSpace(actorId);
  box.querySelectorAll('.vis-cv-tool').forEach(b => { b.classList.toggle('on', b.getAttribute('data-tool') === tool); b.onclick = () => visCVSetTool(actorId, b.getAttribute('data-tool')); });
  const spaceEl = document.getElementById('vcSpace');
  spaceEl.style.display = tool === 'move' ? '' : 'none';
  spaceEl.querySelectorAll('.vis-cv-spbtn').forEach(b => { b.classList.toggle('on', b.getAttribute('data-space') === space); b.onclick = () => { const t = visActorTab(actorId); if (t) t.moveSpace = b.getAttribute('data-space'); visRenderActorCanvas(actorId); }; });
  const hints = { select: 'Drag a box to select parts · Shift-click to add · right-drag to pan · scroll to zoom', move: 'Drag the arrows to move the part · right-drag to pan · scroll to zoom', rotate: 'Drag a corner to rotate the part · right-drag to pan', scale: 'Drag a side handle to scale · hold Alt for uniform · right-drag to pan' };
  const hintEl = document.getElementById('vcHint'); if (hintEl) hintEl.textContent = hints[tool] || '';
  visRenderPartsList(actorId);
  visRenderVarsList(actorId);
  visCVApplyCam(actorId, true);   // center the actor on first render
  visRenderActorPreview(actorId);
  visRenderPartProps(actorId);
  visCVWireStage(actorId);
  visRenderGizmo(actorId);
}

/* ---- actor-Canvas camera (same model as the blueprint canvas) ---- */
function visCVCam(actorId) { const t = visActorTab(actorId); if (!t.ccam) t.ccam = { x: 0, y: 0, zoom: 1, init: false }; return t.ccam; }
function visCVApplyCam(actorId, centerIfNew) {
  const cam = visCVCam(actorId);
  const stage = document.getElementById('vcStage');
  const content = document.getElementById('vcContent');
  if (!stage || !content) return;
  if (centerIfNew && !cam.init) {   // first time: put world origin at stage centre
    const r = stage.getBoundingClientRect();
    cam.x = r.width / 2; cam.y = r.height / 2; cam.init = true;
  }
  content.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`;
  stage.style.backgroundSize = (26 * cam.zoom) + 'px ' + (26 * cam.zoom) + 'px';
  stage.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
  const lbl = document.getElementById('vcZoomLbl'); if (lbl) lbl.textContent = Math.round(cam.zoom * 100) + '%';
}
function visCVScreenToWorld(actorId, clientX, clientY) {
  const cam = visCVCam(actorId);
  const Z = visRootZoom();
  const content = document.getElementById('vcContent');
  const cr = content.getBoundingClientRect();
  return { x: ((clientX - cr.left) / Z) / cam.zoom, y: ((clientY - cr.top) / Z) / cam.zoom };
}
function visCVZoomBy(actorId, factor, px, py) {
  const cam = visCVCam(actorId);
  const Z = visRootZoom();
  const stage = document.getElementById('vcStage');
  const sr = stage.getBoundingClientRect();
  const cx = px == null ? (sr.left + sr.width / 2) * Z : px;   // client (visual) px
  const cy = py == null ? (sr.top + sr.height / 2) * Z : py;
  const before = visCVScreenToWorld(actorId, cx, cy);
  cam.zoom = Math.max(0.3, Math.min(4, cam.zoom * factor));
  visCVApplyCam(actorId);
  const cr = document.getElementById('vcContent').getBoundingClientRect();   // VISUAL px
  const nowClientX = cr.left + before.x * cam.zoom * Z, nowClientY = cr.top + before.y * cam.zoom * Z;
  cam.x += (cx - nowClientX) / Z; cam.y += (cy - nowClientY) / Z;
  visCVApplyCam(actorId);
}
function visCVCenter(actorId) { const cam = visCVCam(actorId); cam.zoom = 1; cam.init = false; visCVApplyCam(actorId, true); }
function visCVWireStage(actorId) {
  const stage = document.getElementById('vcStage');
  if (!stage) return;
  stage.onmousedown = (e) => {
    if (e.target.closest('[data-part]') || e.target.closest('[data-giz]')) return;
    if (e.button === 2 || e.button === 1) {   // pan
      e.preventDefault();
      const cam = visCVCam(actorId);
      const Z = visRootZoom();
      const s = { mx: e.clientX, my: e.clientY, cx: cam.x, cy: cam.y };
      const mv = (ev) => { cam.x = s.cx + (ev.clientX - s.mx) / Z; cam.y = s.cy + (ev.clientY - s.my) / Z; visCVApplyCam(actorId); };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    } else if (e.button === 0 && visCVTool(actorId) === 'select') {   // marquee-select parts
      visCVStartMarquee(e, actorId);
    } else if (e.button === 0) {
      // clicking empty canvas with a transform tool clears the selection
      if (!e.shiftKey) visSelectPart(actorId, null);
    }
  };
  stage.onwheel = (e) => { e.preventDefault(); visCVZoomBy(actorId, e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY); };
  let rc = null;
  stage.addEventListener('mousedown', (e) => { if (e.button === 2) rc = { x: e.clientX, y: e.clientY, onPart: !!e.target.closest('[data-part]') }; });
  stage.oncontextmenu = (e) => {
    e.preventDefault();
    if (rc && !rc.onPart && Math.abs(e.clientX - rc.x) < 4 && Math.abs(e.clientY - rc.y) < 4) {
      // add a part centred at the right-click world point (relative to actor centre)
      const a = visActor(actorId);
      const w = visCVScreenToWorld(actorId, e.clientX, e.clientY);
      visAddPartAt(actorId, Math.round(w.x - a.size.w / 2), Math.round(w.y - a.size.h / 2));
    }
    rc = null;
  };
}

/* Marquee-select parts (Select tool). World-space, like the blueprint marquee.
   Selects parts whose bounding box (in world coords, centred at part x/y) overlaps
   the box. The marquee div lives inside #vcContent so world px map straight. */
function visCVStartMarquee(e, actorId) {
  const box = document.getElementById('vcMarquee');
  const a = visActor(actorId);
  const additive = e.shiftKey;
  const t = visActorTab(actorId);
  const base = additive ? Object.assign({}, visCVSelSet(actorId)) : {};
  const startW = visCVScreenToWorld(actorId, e.clientX, e.clientY);
  let dragged = false;
  const onMove = (ev) => {
    const cur = visCVScreenToWorld(actorId, ev.clientX, ev.clientY);
    const x = Math.min(startW.x, cur.x), y = Math.min(startW.y, cur.y);
    const w = Math.abs(cur.x - startW.x), h = Math.abs(cur.y - startW.y);
    if (w + h > 3) dragged = true;
    box.style.display = ''; box.style.left = x + 'px'; box.style.top = y + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px';
    const x2 = x + w, y2 = y + h;
    t.selParts = Object.assign({}, base);
    a.parts.forEach(p => {
      const hw = (p.w || 0) / 2, hh = (p.h || 0) / 2, cx = p.x || 0, cy = p.y || 0;
      if (cx + hw >= x && cx - hw <= x2 && cy + hh >= y && cy - hh <= y2) t.selParts[p.id] = true;
    });
    t.selPart = visCVSelIds(actorId)[0] || null;
    visRenderPartsList(actorId); visRenderActorPreview(actorId); visRenderGizmo(actorId);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
    box.style.display = 'none';
    if (!dragged && !additive) { t.selParts = {}; t.selPart = null; visRenderPartsList(actorId); visRenderActorPreview(actorId); visRenderGizmo(actorId); }
    visRenderPartProps(actorId);
  };
  document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
}

/* Left: the parts list (paint order = z; top of list = frontmost). */
function visRenderPartsList(actorId) {
  const box = document.getElementById('vcPartsList');
  const a = visActor(actorId);
  if (!box || !a) return;
  const selSet = visCVSelSet(actorId);
  // show front-to-back (highest z first) so the list reads like layers
  const ordered = a.parts.slice().sort((p, q) => (q.z || 0) - (p.z || 0));
  box.innerHTML = ordered.length ? ordered.map(p => `
    <div class="vis-ol-row ${selSet[p.id] ? 'sel' : ''}" data-part-row="${esc(p.id)}">
      <span class="vis-ol-ico">${svg('image', 12)}</span>
      <span class="vis-ol-name">${esc(p.name)}</span>
      <button class="vis-ol-del" data-part-del="${esc(p.id)}" title="Delete part">${svg('trash', 11)}</button>
    </div>`).join('') : `<div class="vis-ol-empty dim">No parts.</div>`;
  box.querySelectorAll('[data-part-row]').forEach(r => r.onclick = (e) => { if (e.target.closest('[data-part-del]')) return; visSelectPart(actorId, r.getAttribute('data-part-row'), e.shiftKey); });
  box.querySelectorAll('[data-part-del]').forEach(b => b.onclick = (e) => { e.stopPropagation(); visDeletePart(actorId, b.getAttribute('data-part-del')); });
}

/* Left: the variables (params) list. */
function visRenderVarsList(actorId) {
  const box = document.getElementById('vcVarsList');
  const a = visActor(actorId);
  if (!box || !a) return;
  box.innerHTML = a.params.length ? a.params.map(pr => `
    <div class="vis-var-row" data-var="${esc(pr.id)}">
      <input class="vis-var-name" data-var-name="${esc(pr.id)}" value="${esc(pr.name)}" maxlength="40" title="Variable name">
      <select class="vis-var-type set-select" data-var-type="${esc(pr.id)}" title="Type">
        ${VIS_VAR_TYPES.map(vt => `<option value="${vt.t}" ${pr.type === vt.t || (vt.t === 'float' && pr.type === 'number') ? 'selected' : ''}>${esc(vt.label)}</option>`).join('')}
      </select>
      ${visVarValueInput(pr)}
      <button class="vis-var-del" data-var-del="${esc(pr.id)}" title="Delete variable">${svg('trash', 12)}</button>
    </div>`).join('') : `<div class="vis-ol-empty dim">No variables. Add one to expose a per-instance value (e.g. speed).</div>`;

  const changed = () => { VIS.doc.meta.modified = visNow(); visQueueSave(); };
  box.querySelectorAll('[data-var-name]').forEach(inp => inp.oninput = (e) => { const pr = a.params.find(x => x.id === inp.getAttribute('data-var-name')); if (pr) { pr.name = e.target.value; changed(); } });
  box.querySelectorAll('[data-var-type]').forEach(sel => sel.onchange = (e) => { const pr = a.params.find(x => x.id === sel.getAttribute('data-var-type')); if (pr) { pr.type = e.target.value; pr.value = visVarDefault(pr.type); visRenderVarsList(actorId); visBPOnVarTypeChanged(actorId); changed(); } });
  box.querySelectorAll('[data-var-val]').forEach(inp => inp.oninput = (e) => { const pr = a.params.find(x => x.id === inp.getAttribute('data-var-val')); if (pr) { pr.value = visVarCoerce(pr.type, inp.type === 'checkbox' ? inp.checked : e.target.value); changed(); } });
  // vec2/vector value editors write into a component of the array value
  box.querySelectorAll('[data-var-vec]').forEach(inp => inp.oninput = () => {
    const pr = a.params.find(x => x.id === inp.getAttribute('data-var-vec')); if (!pr) return;
    const idx = +inp.getAttribute('data-vec-i');
    if (!Array.isArray(pr.value)) pr.value = visVarDefault(pr.type);
    pr.value[idx] = +inp.value || 0; changed();
  });
  box.querySelectorAll('[data-var-del]').forEach(b => b.onclick = () => visDeleteParam(actorId, b.getAttribute('data-var-del')));
}
function visVarValueInput(pr) {
  const id = esc(pr.id);
  if (pr.type === 'bool') return `<input type="checkbox" class="vis-var-val" data-var-val="${id}" ${pr.value ? 'checked' : ''} title="Default value">`;
  if (pr.type === 'string') return `<input type="text" class="vis-var-val" data-var-val="${id}" value="${esc(pr.value == null ? '' : pr.value)}" title="Default value">`;
  if (pr.type === 'vec2' || pr.type === 'vector') {
    const v = Array.isArray(pr.value) ? pr.value : visVarDefault(pr.type);
    const labels = pr.type === 'vec2' ? ['X', 'Y'] : ['X', 'Y', 'Z'];
    return `<span class="vis-var-vec">${labels.map((L, i) => `<input type="number" class="vis-var-val vis-var-vec-inp" data-var-vec="${id}" data-vec-i="${i}" value="${+v[i] || 0}" title="${L}" placeholder="${L}">`).join('')}</span>`;
  }
  return `<input type="number" class="vis-var-val" data-var-val="${id}" value="${pr.value == null ? 0 : pr.value}" title="Default value">`;
}
function visVarDefault(type) {
  if (type === 'bool') return false;
  if (type === 'string') return '';
  if (type === 'vec2') return [0, 0];
  if (type === 'vector') return [0, 0, 0];
  return 0;
}
/* Coerce a scalar-ish input to the variable's type (byte/int clamp too). */
function visVarCoerce(type, v) {
  if (type === 'bool') return !!v;
  if (type === 'string') return String(v);
  let n = +v || 0;
  if (type === 'int') n = Math.round(n);
  else if (type === 'byte') n = Math.min(255, Math.max(0, Math.round(n)));
  else if (type === 'byte64') n = Math.max(0, Math.round(n));
  return n;
}

/* Centre: the live assembled preview. Clicking a part selects it; the transform
   gizmo (drawn separately) performs move/rotate/scale. */
function visRenderActorPreview(actorId) {
  const host = document.getElementById('vcActor');
  const a = visActor(actorId);
  if (!host || !a) return;
  const selSet = visCVSelSet(actorId);
  host.style.width = a.size.w + 'px';
  host.style.height = a.size.h + 'px';
  // place the actor box so its CENTRE sits on the world origin (0,0)
  host.style.left = (-a.size.w / 2) + 'px';
  host.style.top = (-a.size.h / 2) + 'px';
  host.innerHTML = visActorParts(a).map(p =>
    visPartHTML(p, a.size.w, a.size.h).replace('vis-part-layer', 'vis-part-layer vis-part-edit' + (selSet[p.id] ? ' sel' : ''))
  ).join('');
  host.querySelectorAll('[data-part]').forEach(el => {
    const pid = el.getAttribute('data-part');
    el.style.pointerEvents = 'auto';
    el.onmousedown = (e) => {
      e.stopPropagation();
      const tool = visCVTool(actorId);
      // select the part; in Move mode, a body-drag also moves it (grab anywhere)
      if (!visCVSelSet(actorId)[pid] || e.shiftKey) visSelectPart(actorId, pid, e.shiftKey);
      if (tool === 'move' && !e.shiftKey) visCVBeginTransform(e, actorId, 'move', null);
    };
  });
}

/* world-space centre of a part (parts are authored around the actor centre = world 0,0) */
function visPartCenterWorld(p) { return { x: p.x || 0, y: p.y || 0 }; }

/* Draw the transform gizmo for the current tool around the primary selected part.
   Lives inside #vcContent (world frame) but handle SIZES are counter-scaled by
   1/(cam.zoom) so they stay a constant on-screen size. */
function visRenderGizmo(actorId) {
  const g = document.getElementById('vcGizmo');
  const a = visActor(actorId);
  if (!g || !a) return;
  const tool = visCVTool(actorId);
  const p = a.parts.find(x => x.id === visSelPart(actorId));
  if (!p || tool === 'select') { g.innerHTML = ''; g.style.display = 'none'; return; }
  g.style.display = '';
  const cam = visCVCam(actorId);
  const s = 1 / cam.zoom;                 // handle scale to keep constant screen size
  const c = visPartCenterWorld(p);
  const rot = p.rotation || 0;
  // gizmo container centred on the part, rotated to match it
  g.style.left = c.x + 'px'; g.style.top = c.y + 'px';
  g.innerHTML = visGizmoHTML(actorId, p, tool, s);
  // wire handles
  g.querySelectorAll('[data-giz]').forEach(h => {
    h.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); visCVBeginTransform(e, actorId, tool, h.getAttribute('data-giz')); };
  });
}

function visGizmoHTML(actorId, p, tool, s) {
  const rot = p.rotation || 0;
  const space = visCVSpace(actorId);
  const hw = (p.w || 20) / 2, hh = (p.h || 20) / 2;
  if (tool === 'move') {
    // arrows along axes. Local → rotate the whole gizmo with the part; Global → screen axes.
    const gizRot = space === 'local' ? rot : 0;
    const len = 46 * s, aw = 9 * s;
    return `<div class="vis-giz-move" style="transform:translate(-50%,-50%) rotate(${gizRot}deg)">
      <div class="vis-giz-axis vis-giz-x" data-giz="x" style="width:${len}px;height:${2*s}px;left:0;top:${-s}px;">
        <span class="vis-giz-arrow" style="border-width:${aw/2}px 0 ${aw/2}px ${aw}px;right:${-aw}px;top:${-(aw/2-s)}px;"></span></div>
      <div class="vis-giz-axis vis-giz-y" data-giz="y" style="height:${len}px;width:${2*s}px;top:${-len}px;left:${-s}px;">
        <span class="vis-giz-arrow" style="border-width:0 ${aw/2}px ${aw}px ${aw/2}px;top:${-aw}px;left:${-(aw/2-s)}px;"></span></div>
      <div class="vis-giz-center" data-giz="both" style="width:${11*s}px;height:${11*s}px;left:${-5.5*s}px;top:${-5.5*s}px;"></div>
    </div>`;
  }
  if (tool === 'rotate') {
    const r = Math.max(hw, hh) + 16 * s;
    const cs = 16 * s;
    // four curved corner handles on a ring; drag any to rotate
    return `<div class="vis-giz-rot" style="transform:translate(-50%,-50%) rotate(${rot}deg)">
      <div class="vis-giz-ring" style="width:${2*r}px;height:${2*r}px;left:${-r}px;top:${-r}px;border-width:${1.5*s}px;"></div>
      ${[[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sy]) => `<div class="vis-giz-corner" data-giz="rot" style="width:${cs}px;height:${cs}px;left:${sx*r - cs/2}px;top:${sy*r - cs/2}px;"></div>`).join('')}
    </div>`;
  }
  if (tool === 'scale') {
    const bar = 18 * s, th = 6 * s;
    // one bar handle per side, positioned at the part edges, rotated with the part
    return `<div class="vis-giz-scale" style="transform:translate(-50%,-50%) rotate(${rot}deg)">
      <div class="vis-giz-sbar vis-giz-e" data-giz="e" style="width:${th}px;height:${bar}px;left:${hw - th/2}px;top:${-bar/2}px;"></div>
      <div class="vis-giz-sbar vis-giz-w" data-giz="w" style="width:${th}px;height:${bar}px;left:${-hw - th/2}px;top:${-bar/2}px;"></div>
      <div class="vis-giz-sbar vis-giz-s" data-giz="s" style="height:${th}px;width:${bar}px;top:${hh - th/2}px;left:${-bar/2}px;"></div>
      <div class="vis-giz-sbar vis-giz-n" data-giz="n" style="height:${th}px;width:${bar}px;top:${-hh - th/2}px;left:${-bar/2}px;"></div>
      <div class="vis-giz-box" style="width:${p.w}px;height:${p.h}px;left:${-hw}px;top:${-hh}px;border-width:${1.5*s}px;"></div>
    </div>`;
  }
  return '';
}

function visRenderPartProps(actorId) {
  const box = document.getElementById('vcPartProps');
  const a = visActor(actorId);
  if (!box || !a) return;
  const p = a.parts.find(x => x.id === visSelPart(actorId));
  if (!p) { box.innerHTML = `<div class="vis-det-empty dim">${svg('image', 22, 1.2)}<p>Select a part to edit it.</p></div>`; return; }
  const texOpts = ['<option value="">— none (colour) —</option>'].concat(
    VIS.doc.assets.map(as => `<option value="${esc(as.id)}" ${as.id === p.sprite ? 'selected' : ''}>${esc(as.name)}</option>`)
  ).join('');
  box.innerHTML = `
    <label class="vis-field"><span>Name</span><input type="text" id="vpName" maxlength="60" value="${esc(p.name)}"></label>
    <label class="vis-field"><span>Texture</span><select class="set-select" id="vpSprite">${texOpts}</select></label>
    <label class="vis-field"><span>Colour (no texture)</span><input type="color" id="vpColor" value="${esc(p.color || '#8a8f98')}"></label>
    <div class="vis-field-row">
      <label class="vis-field"><span>Offset X</span><input type="number" id="vpX" value="${p.x || 0}"></label>
      <label class="vis-field"><span>Offset Y</span><input type="number" id="vpY" value="${p.y || 0}"></label>
    </div>
    <div class="vis-field-row">
      <label class="vis-field"><span>Width</span><input type="number" id="vpW" min="1" value="${p.w}"></label>
      <label class="vis-field"><span>Height</span><input type="number" id="vpH" min="1" value="${p.h}"></label>
    </div>
    <div class="vis-field-row">
      <label class="vis-field"><span>Rotation°</span><input type="number" id="vpRot" value="${p.rotation || 0}"></label>
      <label class="vis-field"><span>Layer (z)</span><input type="number" id="vpZ" value="${p.z || 0}"></label>
    </div>`;
  const changed = () => { VIS.doc.meta.modified = visNow(); visRenderActorPreview(actorId); visRenderContent(); visRenderStage(); visQueueSave(); };
  box.querySelector('#vpName').oninput = (e) => { p.name = e.target.value || 'Part'; visRenderPartsList(actorId); visQueueSave(); };
  box.querySelector('#vpSprite').onchange = (e) => { p.sprite = e.target.value || null; changed(); };
  box.querySelector('#vpColor').oninput = (e) => { p.color = e.target.value; changed(); };
  box.querySelector('#vpX').oninput = (e) => { p.x = Math.round(+e.target.value || 0); changed(); };
  box.querySelector('#vpY').oninput = (e) => { p.y = Math.round(+e.target.value || 0); changed(); };
  box.querySelector('#vpW').oninput = (e) => { p.w = visClamp(e.target.value, 1, 4096); changed(); };
  box.querySelector('#vpH').oninput = (e) => { p.h = visClamp(e.target.value, 1, 4096); changed(); };
  box.querySelector('#vpRot').oninput = (e) => { p.rotation = (+e.target.value || 0) % 360; changed(); };
  box.querySelector('#vpZ').oninput = (e) => { p.z = Math.round(+e.target.value || 0); visRenderPartsList(actorId); changed(); };
}

/* ---- part selection + mutation ---- */
function visSelectPart(actorId, partId, additive) {
  const t = visActorTab(actorId); if (!t) return;
  if (!t.selParts) t.selParts = {};
  if (additive) { if (t.selParts[partId]) delete t.selParts[partId]; else t.selParts[partId] = true; }
  else { t.selParts = {}; if (partId) t.selParts[partId] = true; }
  // primary = the just-clicked one if still selected, else any remaining
  t.selPart = t.selParts[partId] ? partId : (visCVSelIds(actorId)[0] || null);
  visRenderPartsList(actorId); visRenderActorPreview(actorId); visRenderPartProps(actorId);
  if (typeof visRenderGizmo === 'function') visRenderGizmo(actorId);
}
function visAddPart(actorId) { visAddPartAt(actorId, 0, 0); }
function visAddPartAt(actorId, x, y) {
  visPushUndo();
  const a = visActor(actorId);
  const maxZ = a.parts.reduce((m, p) => Math.max(m, p.z || 0), -1);
  const p = { id: visUid('prt_'), name: 'Part ' + (a.parts.length + 1), sprite: null, color: visActorColor(a.parts.length + 1), x: Math.round(x) || 0, y: Math.round(y) || 0, w: Math.round(a.size.w / 2), h: Math.round(a.size.h / 2), rotation: 0, z: maxZ + 1 };
  a.parts.push(p);
  VIS.doc.meta.modified = visNow();
  visRenderActorPreview(actorId);
  visSelectPart(actorId, p.id);
  visRenderContent(); visRenderStage(); visQueueSave();
}
function visDeletePart(actorId, partId) {
  const a = visActor(actorId);
  if (a.parts.length <= 1) { toast('An actor needs at least one part', 'close'); return; }
  visPushUndo();
  a.parts = a.parts.filter(p => p.id !== partId);
  const t = visActorTab(actorId); if (t && t.selPart === partId) t.selPart = null;
  VIS.doc.meta.modified = visNow();
  visRenderPartsList(actorId); visRenderActorPreview(actorId); visRenderPartProps(actorId);
  visRenderContent(); visRenderStage(); visQueueSave();
}

/* ---- variable (param) mutation ---- */
function visAddParam(actorId) {
  visPushUndo();
  const a = visActor(actorId);
  const base = 'var'; let n = a.params.length + 1, name = base + n;
  while (a.params.some(pr => pr.name === name)) { n++; name = base + n; }
  a.params.push({ id: visUid('par_'), name, type: 'number', value: 0 });
  VIS.doc.meta.modified = visNow();
  visRenderVarsList(actorId); visQueueSave();
}
function visDeleteParam(actorId, parId) {
  visPushUndo();
  const a = visActor(actorId);
  a.params = a.params.filter(pr => pr.id !== parId);
  VIS.doc.meta.modified = visNow();
  visRenderVarsList(actorId); visQueueSave();
}

/* ---- drag a part around the preview stage ---- */
/* Unified transform drag for the Canvas gizmos. `mode` = move|rotate|scale,
   `handle` = which gizmo part was grabbed (x/y/both, rot, or n/e/s/w).
   All math is done in WORLD space via visCVScreenToWorld (already uiScale+zoom
   correct). Applies to the PRIMARY selected part; move applies to all selected. */
function visCVBeginTransform(e, actorId, mode, handle) {
  const a = visActor(actorId);
  const p = a.parts.find(x => x.id === visSelPart(actorId)); if (!p) return;
  visPushUndo();   // snapshot before the drag (undo coalesces the whole drag to one step)
  const startW = visCVScreenToWorld(actorId, e.clientX, e.clientY);
  const c0 = { x: p.x || 0, y: p.y || 0 };
  const rot0 = p.rotation || 0, w0 = p.w, h0 = p.h;
  const ids = mode === 'move' ? visCVSelIds(actorId) : [visSelPart(actorId)];
  const starts = {}; ids.forEach(id => { const q = a.parts.find(x => x.id === id); if (q) starts[id] = { x: q.x || 0, y: q.y || 0 }; });
  const space = visCVSpace(actorId);
  const startAngle = Math.atan2(startW.y - c0.y, startW.x - c0.x);
  let dirty = false;

  const onMove = (ev) => {
    const w = visCVScreenToWorld(actorId, ev.clientX, ev.clientY);
    dirty = true;
    if (mode === 'move') {
      let dx = w.x - startW.x, dy = w.y - startW.y;
      if (handle === 'x' || handle === 'y') {
        // constrain to one axis; Local rotates the axis by the part's rotation
        const ang = (space === 'local' ? rot0 * Math.PI / 180 : 0);
        const ax = handle === 'x' ? Math.cos(ang) : -Math.sin(ang);
        const ay = handle === 'x' ? Math.sin(ang) : Math.cos(ang);
        const proj = dx * ax + dy * ay;   // distance along the axis
        dx = proj * ax; dy = proj * ay;
      }
      ids.forEach(id => { const q = a.parts.find(x => x.id === id); if (q && starts[id]) { q.x = Math.round(starts[id].x + dx); q.y = Math.round(starts[id].y + dy); } });
    } else if (mode === 'rotate') {
      const ang = Math.atan2(w.y - c0.y, w.x - c0.x);
      let deg = rot0 + (ang - startAngle) * 180 / Math.PI;
      if (ev.shiftKey) deg = Math.round(deg / 15) * 15;   // snap to 15° with Shift
      p.rotation = Math.round(((deg % 360) + 360) % 360);
    } else if (mode === 'scale') {
      // work in the part's LOCAL frame: rotate the drag delta by -rotation
      const ang = -rot0 * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang);
      const ldx = (w.x - startW.x) * ca - (w.y - startW.y) * sa;
      const ldy = (w.x - startW.x) * sa + (w.y - startW.y) * ca;
      const uniform = ev.altKey;
      let nw = w0, nh = h0, shiftX = 0, shiftY = 0;   // shift in LOCAL space to keep opposite edge fixed
      if (handle === 'e') { nw = Math.max(2, w0 + ldx); shiftX = (nw - w0) / 2; }
      else if (handle === 'w') { nw = Math.max(2, w0 - ldx); shiftX = -(nw - w0) / 2; }
      else if (handle === 's') { nh = Math.max(2, h0 + ldy); shiftY = (nh - h0) / 2; }
      else if (handle === 'n') { nh = Math.max(2, h0 - ldy); shiftY = -(nh - h0) / 2; }
      if (uniform) {
        // scale the perpendicular dimension by the same ratio, from the centre
        if (handle === 'e' || handle === 'w') { const r = nw / w0; nh = Math.max(2, h0 * r); shiftY = 0; }
        else { const r = nh / h0; nw = Math.max(2, w0 * r); shiftX = 0; }
      }
      p.w = Math.round(nw); p.h = Math.round(nh);
      // convert the local-space centre shift back to world and apply
      const rr = rot0 * Math.PI / 180, cr = Math.cos(rr), sr = Math.sin(rr);
      p.x = Math.round(c0.x + shiftX * cr - shiftY * sr);
      p.y = Math.round(c0.y + shiftX * sr + shiftY * cr);
    }
    visRenderActorPreview(actorId);
    visRenderGizmo(actorId);
    visSyncPartFields(p);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (dirty) { VIS.doc.meta.modified = visNow(); visRenderStage(); visRenderContent(); visRenderPartProps(actorId); visQueueSave(); }
    else visPopUndoIfUnchanged();   // a click with no drag shouldn't leave an undo entry
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
/* live-update the Part panel numeric fields during a drag */
function visSyncPartFields(p) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('vpX', p.x || 0); set('vpY', p.y || 0); set('vpW', p.w); set('vpH', p.h); set('vpRot', p.rotation || 0);
}

/* ============================================================
   BLUEPRINT EDITOR — a wired node graph with a proper WORLD-SPACE camera
   (pan / zoom / anchored grid), node selection + marquee + hotkeys, and a
   searchable node creator (right-click, or drag off a pin into empty space).

   Coordinate model: there is ONE camera {x,y,zoom} (on the tab). A single
   #vbContent group is transformed `translate(cam.x,cam.y) scale(cam.zoom)` and
   holds BOTH the wire <svg> and the nodes, so pins + wires always share one
   frame — wire geometry is computed in WORLD coords from node.x/y + fixed pin
   offsets (never re-measured after transform), which is what keeps the drag
   wire glued to the pin at any zoom.
   ============================================================ */
function visBP(actorId) { const a = visActor(actorId); return a && a.blueprint ? a.blueprint : { nodes: [], wires: [] }; }
function visBPNode(actorId, nodeId) { return visBP(actorId).nodes.find(n => n.id === nodeId) || null; }
function visBPCam(actorId) { const t = visActorTab(actorId); if (!t.cam) t.cam = { x: 40, y: 40, zoom: 1 }; return t.cam; }
function visBPSel(actorId) { const t = visActorTab(actorId); if (!t.sel) t.sel = {}; return t.sel; }

/* fixed node layout constants — pin geometry is derived from these, NOT measured */
const VB_NODE_W = 150, VB_HEAD_H = 26, VB_ROW_H = 24, VB_BODY_PAD = 6, VB_PIN = 12;
const VB_ZOOM_MIN = 0.3, VB_ZOOM_MAX = 2.2;

/* The app applies a root CSS `zoom` for the uiScale appearance pref (app.js
   applyPrefs: root.style.zoom). Under `zoom:Z`, getBoundingClientRect() reports
   LAYOUT px but MouseEvent.clientX/Y report VISUAL px (= layout×Z). Any coordinate
   math mixing the two — or using a raw client delta as a layout distance — must
   divide the client value by Z. This returns Z (1 when uiScale is 100%). */
function visRootZoom() { const z = parseFloat(getComputedStyle(document.documentElement).zoom); return z && isFinite(z) && z > 0 ? z : 1; }

/* Body-row model. Each row may carry a LEFT pin (in) and/or a RIGHT pin (out).
   Order: named exec-outs first (so a Branch's True/False sit near the top),
   then props, then data-ins, then the single data-out.
   Header carries the single exec-in (left) and single exec-out (right).
   Returns { rows:[{ left?, right?, prop? }], height }. A pin entry is
   { key, kind:'exec'|'data' }. */
function visBPLayout(def) {
  const rows = [];
  (def.execOuts || []).forEach(eo => rows.push({ right: { key: eo.k, kind: 'exec' }, label: eo.label }));
  (def.props || []).forEach(pr => rows.push({ prop: pr.k }));
  (def.dataIn || []).forEach(d => rows.push({ left: { key: d.k, kind: 'data' } }));
  if (def.dataOut) rows.push({ right: { key: 'out', kind: 'data' } });
  (def.dataOuts || []).forEach(o => rows.push({ right: { key: o.k, kind: 'data' } }));
  const bodyH = rows.length ? (rows.length * VB_ROW_H + VB_BODY_PAD * 2) : 0;
  return { rows, height: VB_HEAD_H + bodyH };
}
/* world-space centre of a pin on node n */
function visBPPinWorld(n, pinKey, dir, kind) {
  const def = VIS_NODES[n.type]; if (!def) return { x: n.x, y: n.y };
  // header exec-in (single) and header exec-out (single, only for non-multi nodes)
  if (kind === 'exec' && dir === 'in' && pinKey === 'in') return { x: n.x, y: n.y + VB_HEAD_H / 2 };
  if (kind === 'exec' && dir === 'out' && pinKey === 'out' && def.execOut) return { x: n.x + VB_NODE_W, y: n.y + VB_HEAD_H / 2 };
  // everything else lives on a body row
  const lay = visBPLayout(def);
  let idx = lay.rows.findIndex(r => (dir === 'out' ? r.right : r.left) && (dir === 'out' ? r.right.key : r.left.key) === pinKey);
  if (idx < 0) idx = 0;
  const y = n.y + VB_HEAD_H + VB_BODY_PAD + idx * VB_ROW_H + VB_ROW_H / 2;
  return { x: dir === 'out' ? n.x + VB_NODE_W : n.x, y };
}

function visRenderActorBlueprint(actorId) {
  const box = document.getElementById('visActorBody');
  const a = visActor(actorId);
  if (!box || !a) return;
  const cam = visBPCam(actorId);
  box.innerHTML = `
    <div class="vis-bp">
      <div class="vis-bp-toolbar">
        <button class="vis-tool" id="vbAdd">${svg('plus', 13)} Add Node</button>
        <span class="vis-bp-hint dim">Right-click for nodes · drag a pin to connect (or into space to create) · left-drag to box-select · right-drag to pan · scroll to zoom · Del to delete</span>
        <div class="spacer"></div>
        <div class="vis-bp-zoom">
          <button class="vis-mini" id="vbZoomOut" title="Zoom out">${svg('minus', 12)}</button>
          <span id="vbZoomLbl" class="vis-bp-zoomlbl">${Math.round(cam.zoom * 100)}%</span>
          <button class="vis-mini" id="vbZoomIn" title="Zoom in">${svg('plus', 12)}</button>
          <button class="vis-mini" id="vbZoomFit" title="Frame all nodes">${svg('zoomfit', 12)}</button>
        </div>
      </div>
      <div class="vis-bp-canvaswrap" id="vbCanvasWrap">
        <div class="vis-bp-content" id="vbContent">
          <svg class="vis-bp-wires" id="vbWires"><g id="vbWireG"></g><path id="vbDragWire" class="vis-wire vis-wire-drag" style="display:none"></path></svg>
          <div class="vis-bp-nodes" id="vbNodes"></div>
          <div class="vis-marquee" id="vbMarquee" style="display:none"></div>
        </div>
        <div class="vis-bp-empty dim" id="vbEmpty" style="display:none">${svg('brain', 26)}<p>No nodes yet. <b>Right-click</b> (or click <b>Add Node</b>) and start with an event like <b>On Tick</b> or <b>On Key Down</b>.</p></div>
      </div>
    </div>`;
  document.getElementById('vbAdd').onclick = (e) => visBPOpenCreator(actorId, e.clientX, e.clientY, null);
  document.getElementById('vbZoomIn').onclick = () => visBPZoomBy(actorId, 1.2);
  document.getElementById('vbZoomOut').onclick = () => visBPZoomBy(actorId, 1 / 1.2);
  document.getElementById('vbZoomFit').onclick = () => visBPFrameAll(actorId);
  visBPApplyCam(actorId);
  visBPRenderNodes(actorId);
  visBPWireCanvas(actorId);
  visBPInstallHotkeys(actorId);
}

/* apply the camera transform + move the grid inverse so it looks world-anchored */
function visBPApplyCam(actorId) {
  const cam = visBPCam(actorId);
  const content = document.getElementById('vbContent');
  const wrap = document.getElementById('vbCanvasWrap');
  if (content) content.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`;
  if (wrap) {
    const g = 22 * cam.zoom;
    wrap.style.backgroundSize = `${g}px ${g}px`;
    wrap.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
  }
  const lbl = document.getElementById('vbZoomLbl'); if (lbl) lbl.textContent = Math.round(cam.zoom * 100) + '%';
}

function visBPRenderNodes(actorId) {
  const host = document.getElementById('vbNodes');
  const bp = visBP(actorId);
  if (!host) return;
  const empty = document.getElementById('vbEmpty');
  if (empty) empty.style.display = bp.nodes.length ? 'none' : '';
  const sel = visBPSel(actorId);
  host.innerHTML = bp.nodes.map(n => visBPNodeHTML(actorId, n, !!sel[n.id])).join('');
  host.querySelectorAll('[data-node]').forEach(el => {
    const nid = el.getAttribute('data-node');
    const header = el.querySelector('.vis-node-head');
    if (header) header.onmousedown = (e) => visBPStartNodeDrag(e, actorId, nid);
    el.querySelectorAll('[data-pin]').forEach(pin => {
      pin.onmousedown = (e) => { e.stopPropagation(); visBPStartWire(e, actorId, nid, pin.getAttribute('data-pin'), pin.getAttribute('data-pindir'), pin.getAttribute('data-pinkind')); };
    });
    el.querySelectorAll('[data-prop]').forEach(inp => {
      inp.onmousedown = (e) => e.stopPropagation();
      const key = inp.getAttribute('data-prop');
      const handler = () => {
        const nn = visBPNode(actorId, nid); if (!nn) return;
        nn.props = nn.props || {};
        nn.props[key] = inp.type === 'checkbox' ? inp.checked : inp.value;
        VIS.doc.meta.modified = visNow();
        // changing the selected variable can change this node's pin types -> prune
        // now-incompatible wires and re-render so the pin colours/inputs update.
        if (key === 'name' && (nn.type === 'data.param' || nn.type === 'act.setVar')) { visBPPruneBadWires(actorId, nid); visBPRenderNodes(actorId); }
        visQueueSave();
      };
      inp.oninput = handler; inp.onchange = handler;
    });
  });
  visBPRedrawWires(actorId);
}

/* CSS class + short glyph for a data pin's type (typed pins) */
function visBPTypeClass(type) { return 'vis-pin-t-' + (type || 'number'); }

function visBPNodeHTML(actorId, n, selected) {
  const def = VIS_NODES[n.type];
  if (!def) return '';
  const execIn = def.execIn ? `<div class="vis-pin vis-pin-exec vis-pin-in" data-pin="in" data-pindir="in" data-pinkind="exec" title="exec in"></div>` : '';
  const execOut = def.execOut ? `<div class="vis-pin vis-pin-exec vis-pin-out" data-pin="out" data-pindir="out" data-pinkind="exec" title="exec out"></div>` : '';
  // build body rows from the SAME layout the pin geometry uses, so pins line up
  const lay = visBPLayout(def);
  const propByKey = {}; (def.props || []).forEach(p => propByKey[p.k] = p);
  const dinByKey = {}; (def.dataIn || []).forEach(d => dinByKey[d.k] = d);
  const eoutByKey = {}; (def.execOuts || []).forEach(e => eoutByKey[e.k] = e);
  const body = lay.rows.map(r => {
    if (r.right && r.right.kind === 'exec') {   // named exec-out (Branch True/False)
      const eo = eoutByKey[r.right.key];
      return `<div class="vis-node-row vis-node-row-out">
        <span class="vis-pin-label">${esc(eo.label)}</span>
        <div class="vis-pin vis-pin-exec vis-pin-out" data-pin="${esc(r.right.key)}" data-pindir="out" data-pinkind="exec" title="${esc(eo.label)}"></div></div>`;
    }
    if (r.prop != null) {
      const pr = propByKey[r.prop];
      return `<div class="vis-node-row vis-node-prop"><span class="vis-pin-label">${esc(pr.label)}</span>${visBPPropInput(actorId, n, pr)}</div>`;
    }
    if (r.left && r.left.kind === 'data') {      // data-in row
      const d = dinByKey[r.left.key];
      const t = visBPPinType(actorId, n, 'in', d.k);
      return `<div class="vis-node-row vis-node-row-in">
        <div class="vis-pin vis-pin-data ${visBPTypeClass(t)} vis-pin-in" data-pin="${esc(d.k)}" data-pindir="in" data-pinkind="data" title="${esc(d.label)} (${t})"></div>
        <span class="vis-pin-label">${esc(d.label)}</span>${visBPInlineInput(actorId, n, d)}</div>`;
    }
    if (r.right && r.right.kind === 'data') {     // data-out row (single 'out' or a named dataOuts pin)
      const key = r.right.key;
      const t = visBPPinType(actorId, n, 'out', key);
      const outSpec = (def.dataOuts || []).find(o => o.k === key);
      const label = outSpec ? outSpec.label : t;
      return `<div class="vis-node-row vis-node-row-out">
        <span class="vis-pin-label">${esc(label)}</span>
        <div class="vis-pin vis-pin-data ${visBPTypeClass(t)} vis-pin-out" data-pin="${esc(key)}" data-pindir="out" data-pinkind="data" title="value out (${t})"></div></div>`;
    }
    return '';
  }).join('');
  return `<div class="vis-node vis-node-${def.cat}${selected ? ' sel' : ''}" data-node="${esc(n.id)}" style="left:${n.x || 0}px;top:${n.y || 0}px;width:${VB_NODE_W}px;">
      <div class="vis-node-head">${execIn}<span class="vis-node-title">${esc(def.title)}</span>${execOut}</div>
      <div class="vis-node-body">${body}</div>
    </div>`;
}

/* the resolved TYPE of a data pin — normally from the def, but 'param'-dyn pins
   (Get/Set Variable) take the type of the selected variable. */
function visBPPinType(actorId, n, dir, pinKey) {
  const def = VIS_NODES[n.type];
  let spec;
  if (dir === 'out') spec = (def.dataOuts || []).find(o => o.k === pinKey) || def.dataOut;
  else spec = (def.dataIn || []).find(d => d.k === pinKey);
  if (!spec) return 'number';
  if (spec.dynType === 'param') {
    const a = visActor(actorId);
    const varName = n.props && n.props.name;
    const pr = a && a.params.find(p => p.name === varName);
    return pr ? pr.type : 'number';
  }
  return spec.type || 'number';
}
/* Two data pins are compatible if their resolved types match. Number subtypes
   (byte/byte64/int/float) are STRICT — they only match themselves — EXCEPT the
   legacy generic scalar 'number', which is interchangeable with 'float' so old
   graphs (Move ΔX, Add, Get/Set var) keep working. bool/string/vec2/vector are
   exact-match only. */
function visBPTypeMatch(a, b) {
  if (a === b) return true;
  const scalar = t => (t === 'number' || t === 'float');
  return scalar(a) && scalar(b);
}
function visBPTypesCompatible(actorId, out, inn) {
  const no = visBPNode(actorId, out.nodeId), ni = visBPNode(actorId, inn.nodeId);
  if (!no || !ni) return false;
  return visBPTypeMatch(visBPPinType(actorId, no, 'out', out.pinKey), visBPPinType(actorId, ni, 'in', inn.pinKey));
}
/* Drop any DATA wire whose endpoints' resolved types no longer match (used after a
   variable's type changes, or a Get/Set-Variable node's selected var changes).
   `onlyNodeId`, if given, limits the check to wires touching that node. */
function visBPPruneBadWires(actorId, onlyNodeId) {
  const bp = visBP(actorId);
  const kept = bp.wires.filter(w => {
    if (w.kind !== 'data') return true;
    const [fn, fp] = w.from.split(':'), [tn, tp] = w.to.split(':');
    if (onlyNodeId && fn !== onlyNodeId && tn !== onlyNodeId) return true;
    return visBPTypesCompatible(actorId, { nodeId: fn, pinKey: fp }, { nodeId: tn, pinKey: tp });
  });
  if (kept.length !== bp.wires.length) { bp.wires = kept; VIS.doc.meta.modified = visNow(); }
}
/* Called when an actor VARIABLE's type changes — prune every now-bad data wire
   across the actor's blueprint (get/set nodes bound to it may have changed type). */
function visBPOnVarTypeChanged(actorId) {
  visBPPruneBadWires(actorId, null);
  if (VIS.tabs[VIS.active] && VIS.tabs[VIS.active].sub === 'blueprint') visBPRenderNodes(actorId);
  visQueueSave();
}

/* inline fallback input for a data-in pin (used when nothing is wired into it).
   Uses the pin's RESOLVED type (so a Set-Variable value box matches the var). */
function visBPInlineInput(actorId, n, d) {
  const wired = visBP(actorId).wires.some(w => w.to === n.id + ':' + d.k);
  if (wired) return `<span class="vis-inline-wired dim">wired</span>`;
  const t = visBPPinType(actorId, n, 'in', d.k);
  const v = (n.props && n.props[d.k] != null) ? n.props[d.k] : d.def;
  if (t === 'bool') return `<input type="checkbox" class="vis-node-inp" data-prop="${esc(d.k)}" ${v ? 'checked' : ''}>`;
  if (t === 'string') return `<input type="text" class="vis-node-inp" data-prop="${esc(d.k)}" value="${esc(v == null ? '' : v)}">`;
  // Vec2/Vector have no scalar literal — they must be wired from a Make node.
  if (t === 'vec2' || t === 'vector') return `<span class="vis-inline-wired dim">wire ${esc(t)}</span>`;
  // byte/byte64/int/float/number all edit as a number literal.
  return `<input type="number" class="vis-node-inp" data-prop="${esc(d.k)}" value="${v == null ? 0 : v}">`;
}

/* editor for a node PROP (key selector, part selector, param selector, number) */
function visBPPropInput(actorId, n, pr) {
  const a = visActor(actorId);
  const v = (n.props && n.props[pr.k] != null) ? n.props[pr.k] : pr.def;
  if (pr.type === 'part') {
    const opts = ['<option value="">— part —</option>'].concat(a.parts.map(p => `<option value="${esc(p.id)}" ${p.id === v ? 'selected' : ''}>${esc(p.name)}</option>`)).join('');
    return `<select class="vis-node-inp set-select" data-prop="${esc(pr.k)}">${opts}</select>`;
  }
  if (pr.type === 'param') {
    const opts = ['<option value="">— variable —</option>'].concat(a.params.map(p => `<option value="${esc(p.name)}" ${p.name === v ? 'selected' : ''}>${esc(p.name)}</option>`)).join('');
    return `<select class="vis-node-inp set-select" data-prop="${esc(pr.k)}">${opts}</select>`;
  }
  if (pr.type === 'target') {
    const tv = v || 'self';
    const opts = [`<option value="self" ${tv === 'self' ? 'selected' : ''}>Actor</option>`]
      .concat(a.parts.map(p => `<option value="${esc(p.id)}" ${p.id === tv ? 'selected' : ''}>${esc(p.name)}</option>`)).join('');
    return `<select class="vis-node-inp set-select" data-prop="${esc(pr.k)}">${opts}</select>`;
  }
  if (pr.type === 'key') return `<input type="text" class="vis-node-inp vis-node-key" data-prop="${esc(pr.k)}" maxlength="12" value="${esc(v)}" placeholder="key">`;
  if (pr.type === 'bool') return `<input type="checkbox" class="vis-node-inp" data-prop="${esc(pr.k)}" ${v ? 'checked' : ''}>`;
  return `<input type="number" class="vis-node-inp" data-prop="${esc(pr.k)}" value="${v == null ? 0 : v}">`;
}

/* ---- node mutation ---- */
function visBPAddNode(actorId, type, worldX, worldY) {
  visPushUndo();
  const bp = visBP(actorId);
  const n = { id: visUid('nd_'), type, x: Math.round(worldX), y: Math.round(worldY), props: {} };
  const def = VIS_NODES[type];
  (def.props || []).forEach(pr => { if (pr.def !== undefined && pr.def !== '') n.props[pr.k] = pr.def; });
  (def.dataIn || []).forEach(d => { n.props[d.k] = d.def; });
  bp.nodes.push(n);
  VIS.doc.meta.modified = visNow();
  visBPRenderNodes(actorId); visQueueSave();
  return n;
}
function visBPDeleteNodes(actorId, ids) {
  visPushUndo();
  const set = new Set(ids);
  const bp = visBP(actorId);
  bp.nodes = bp.nodes.filter(n => !set.has(n.id));
  bp.wires = bp.wires.filter(w => !set.has(w.from.split(':')[0]) && !set.has(w.to.split(':')[0]));
  const sel = visBPSel(actorId); ids.forEach(id => delete sel[id]);
  VIS.doc.meta.modified = visNow();
  visBPRenderNodes(actorId); visQueueSave();
}
function visBPDeleteWire(actorId, wireId) {
  visPushUndo();
  const bp = visBP(actorId);
  bp.wires = bp.wires.filter(w => w.id !== wireId);
  VIS.doc.meta.modified = visNow();
  visBPRenderNodes(actorId); visQueueSave();
}

/* ---- selection ---- */
function visBPSelectOnly(actorId, nodeId) { const t = visActorTab(actorId); t.sel = {}; if (nodeId) t.sel[nodeId] = true; visBPRenderNodes(actorId); }
function visBPSelectToggle(actorId, nodeId) { const sel = visBPSel(actorId); if (sel[nodeId]) delete sel[nodeId]; else sel[nodeId] = true; visBPRenderNodes(actorId); }
function visBPSelectAll(actorId) { const t = visActorTab(actorId); t.sel = {}; visBP(actorId).nodes.forEach(n => t.sel[n.id] = true); visBPRenderNodes(actorId); }
function visBPClearSel(actorId) { const t = visActorTab(actorId); t.sel = {}; visBPRenderNodes(actorId); }
function visBPSelIds(actorId) { const sel = visBPSel(actorId); return Object.keys(sel).filter(k => sel[k]); }

/* ---- coordinate conversion: screen(client) <-> world ---- */
function visBPScreenToWorld(actorId, clientX, clientY) {
  // Anchor to the CONTENT group's own rendered rect. Because #vbContent carries
  // the translate(cam)+scale(zoom) transform, its measured top-left already IS
  // the on-screen origin of world (0,0) and its box is scaled by zoom — so this
  // is self-consistent with how the browser actually painted it, immune to page
  // zoom / OS scaling / ancestor-transform quirks that a wrap-rect + cam math
  // approach can get wrong. Fall back to the wrap+cam math if content is missing.
  const cam = visBPCam(actorId);
  const Z = visRootZoom();
  const content = document.getElementById('vbContent');
  if (content) {
    const cr = content.getBoundingClientRect();
    // (client − rect) is a mix of visual + layout px; divide by Z to make it a
    // pure LAYOUT distance, then by cam.zoom to reach world coords.
    return { x: ((clientX - cr.left) / Z) / cam.zoom, y: ((clientY - cr.top) / Z) / cam.zoom };
  }
  const wrap = document.getElementById('vbCanvasWrap');
  const r = wrap.getBoundingClientRect();
  return { x: ((clientX - r.left) / Z - cam.x) / cam.zoom, y: ((clientY - r.top) / Z - cam.y) / cam.zoom };
}

/* ---- zoom ---- */
function visBPZoomBy(actorId, factor, pivotClientX, pivotClientY) {
  const cam = visBPCam(actorId);
  const Z = visRootZoom();
  const wrap = document.getElementById('vbCanvasWrap');
  const wr = wrap.getBoundingClientRect();
  // pivot in CLIENT (visual) px — default to the wrap centre expressed in visual px
  const cx = pivotClientX == null ? (wr.left + wr.width / 2) * Z : pivotClientX;
  const cy = pivotClientY == null ? (wr.top + wr.height / 2) * Z : pivotClientY;
  // the world point under the pivot BEFORE zooming (content-anchored, exact)
  const before = visBPScreenToWorld(actorId, cx, cy);
  cam.zoom = Math.max(VB_ZOOM_MIN, Math.min(VB_ZOOM_MAX, cam.zoom * factor));
  visBPApplyCam(actorId);
  // Where does that world point land now, in CLIENT (visual) px? content.rect is
  // reported in VISUAL px (it's inside the zoomed root), so this is client space.
  const cr = document.getElementById('vbContent').getBoundingClientRect();
  const nowClientX = cr.left + before.x * cam.zoom * Z, nowClientY = cr.top + before.y * cam.zoom * Z;
  // the cam translate is a LAYOUT-space value → convert the client error by ÷Z
  cam.x += (cx - nowClientX) / Z; cam.y += (cy - nowClientY) / Z;
  visBPApplyCam(actorId);
}
function visBPFrameAll(actorId) {
  const bp = visBP(actorId); const cam = visBPCam(actorId);
  const wrap = document.getElementById('vbCanvasWrap'); if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  if (!bp.nodes.length) { cam.x = 40; cam.y = 40; cam.zoom = 1; visBPApplyCam(actorId); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  bp.nodes.forEach(n => { const h = visBPLayout(VIS_NODES[n.type]).height; minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + VB_NODE_W); maxY = Math.max(maxY, n.y + h); });
  const pad = 60, bw = maxX - minX + pad * 2, bh = maxY - minY + pad * 2;
  cam.zoom = Math.max(VB_ZOOM_MIN, Math.min(VB_ZOOM_MAX, Math.min(r.width / bw, r.height / bh)));
  cam.x = (r.width - (maxX + minX) * cam.zoom) / 2;
  cam.y = (r.height - (maxY + minY) * cam.zoom) / 2;
  visBPApplyCam(actorId);
}

/* ---- wire geometry (WORLD coords, computed not measured) ---- */
function visBPWirePath(p1, p2, dir) {
  const dx = Math.max(40, Math.abs(p2.x - p1.x) * 0.5);
  const s = dir === 'out' ? 1 : -1;
  return `M ${p1.x} ${p1.y} C ${p1.x + s * dx} ${p1.y}, ${p2.x - s * dx} ${p2.y}, ${p2.x} ${p2.y}`;
}
function visBPRedrawWires(actorId) {
  const g = document.getElementById('vbWireG');
  const bp = visBP(actorId);
  if (!g) return;
  g.innerHTML = bp.wires.map(w => {
    const [fn, fp] = w.from.split(':'), [tn, tp] = w.to.split(':');
    const nf = visBPNode(actorId, fn), nt = visBPNode(actorId, tn);
    if (!nf || !nt) return '';
    const a = visBPPinWorld(nf, fp, 'out', w.kind), b = visBPPinWorld(nt, tp, 'in', w.kind);
    let cls = w.kind === 'exec' ? 'vis-wire vis-wire-exec' : 'vis-wire vis-wire-data vis-wire-' + visBPPinType(actorId, nf, 'out', fp);
    return `<path class="${cls}" d="${visBPWirePath(a, b, 'out')}" data-wire="${esc(w.id)}"></path>`;
  }).join('');
  g.querySelectorAll('[data-wire]').forEach(p => {
    p.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); visBPDeleteWire(actorId, p.getAttribute('data-wire')); };
    p.onclick = (e) => { if (e.altKey) visBPDeleteWire(actorId, p.getAttribute('data-wire')); };
  });
}

/* ---- node drag (moves the whole selection if the node is selected) ---- */
function visBPStartNodeDrag(e, actorId, nodeId) {
  e.preventDefault(); e.stopPropagation();
  const sel = visBPSel(actorId);
  if (e.shiftKey) { visBPSelectToggle(actorId, nodeId); return; }
  if (!sel[nodeId]) visBPSelectOnly(actorId, nodeId);   // clicking an unselected node selects just it
  visPushUndo();   // snapshot before the drag; dropped on release if nothing moved
  const cam = visBPCam(actorId);
  const Z = visRootZoom();
  const ids = visBPSelIds(actorId);
  const starts = {}; ids.forEach(id => { const n = visBPNode(actorId, id); if (n) starts[id] = { x: n.x, y: n.y }; });
  const m0 = { x: e.clientX, y: e.clientY };
  let moved = false;
  const onMove = (ev) => {
    const dx = (ev.clientX - m0.x) / Z / cam.zoom, dy = (ev.clientY - m0.y) / Z / cam.zoom;
    if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
    ids.forEach(id => {
      const n = visBPNode(actorId, id); if (!n) return;
      n.x = Math.round(starts[id].x + dx); n.y = Math.round(starts[id].y + dy);
      const el = document.querySelector(`[data-node="${CSS.escape(id)}"]`);
      if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
    });
    visBPRedrawWires(actorId);
  };
  const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); if (moved) { VIS.doc.meta.modified = visNow(); visQueueSave(); } else visPopUndoIfUnchanged(); };
  document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
}

/* ---- wire drag (pin -> pin, or pin -> empty = open creator) ---- */
function visBPStartWire(e, actorId, nodeId, pinKey, dir, kind) {
  e.preventDefault(); e.stopPropagation();
  const from = { nodeId, pinKey, dir, kind };
  const n = visBPNode(actorId, nodeId);
  const startPt = visBPPinWorld(n, pinKey, dir, kind);
  const dragPath = document.getElementById('vbDragWire');
  dragPath.style.display = '';
  dragPath.setAttribute('class', 'vis-wire vis-wire-drag ' + (kind === 'exec' ? 'vis-wire-exec' : 'vis-wire-data'));
  const onMove = (ev) => {
    const w = visBPScreenToWorld(actorId, ev.clientX, ev.clientY);
    dragPath.setAttribute('d', visBPWirePath(startPt, w, dir));
  };
  const onUp = (ev) => {
    document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
    dragPath.style.display = 'none';
    const target = ev.target.closest ? ev.target.closest('[data-pin]') : null;
    if (target) {
      const tNode = target.closest('[data-node]').getAttribute('data-node');
      visBPTryConnect(actorId, from, { nodeId: tNode, pinKey: target.getAttribute('data-pin'), dir: target.getAttribute('data-pindir'), kind: target.getAttribute('data-pinkind') });
    } else {
      // dropped in empty space -> open the creator, auto-connect the new node
      visBPOpenCreator(actorId, ev.clientX, ev.clientY, from);
    }
  };
  document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
}

/* validate + create a wire.
   Cardinality (UE-like):
     · exec-OUT  = single  (linear flow: one thing runs next)
     · exec-IN   = MANY    (several triggers can merge into one action)
     · data-OUT  = many    (one value can feed many inputs)
     · data-IN   = single  (a value pin reads exactly one source)
   Plus: same kind, no self-loop, type-compatible (see visBPPinType). */
function visBPTryConnect(actorId, from, to) {
  const out = from.dir === 'out' ? from : to;
  const inn = from.dir === 'in' ? from : to;
  if (out.dir !== 'out' || inn.dir !== 'in') return false;
  if (out.kind !== inn.kind) return false;
  if (out.nodeId === inn.nodeId) return false;
  // data type compatibility (exec pins are always compatible)
  if (out.kind === 'data' && !visBPTypesCompatible(actorId, out, inn)) { toast('Those pins are different types', 'close'); return false; }
  visPushUndo();
  const bp = visBP(actorId);
  const toRef = inn.nodeId + ':' + inn.pinKey, fromRef = out.nodeId + ':' + out.pinKey;
  if (out.kind === 'exec') {
    bp.wires = bp.wires.filter(w => w.from !== fromRef);          // exec-out single
  } else {
    bp.wires = bp.wires.filter(w => w.to !== toRef);             // data-in single
  }
  // never duplicate the exact same wire
  bp.wires = bp.wires.filter(w => !(w.from === fromRef && w.to === toRef));
  bp.wires.push({ id: visUid('wr_'), kind: out.kind, from: fromRef, to: toRef });
  VIS.doc.meta.modified = visNow();
  visBPRenderNodes(actorId); visQueueSave();
  return true;
}

/* ---- searchable node creator ----
   `connectFrom` (optional) = the pin a wire was dragged from; the chosen node is
   auto-connected to it (picking the first compatible pin of opposite direction). */
function visBPOpenCreator(actorId, clientX, clientY, connectFrom) {
  visCloseCreator();
  const wrap = document.getElementById('vbCanvasWrap');
  const r = wrap.getBoundingClientRect();
  const world = visBPScreenToWorld(actorId, clientX, clientY);
  const menu = document.createElement('div');
  menu.className = 'vis-creator'; menu.id = 'vbCreator';
  menu.style.left = Math.min(clientX - r.left, r.width - 232) + 'px';
  menu.style.top = Math.min(clientY - r.top, Math.max(8, r.height - 320)) + 'px';
  menu.innerHTML = `
    <input type="text" class="vis-creator-search" id="vbCreatorSearch" placeholder="Search nodes…" autocomplete="off">
    <div class="vis-creator-list" id="vbCreatorList"></div>`;
  wrap.appendChild(menu);

  // build the flat filtered list of {type,title,cat} compatible with connectFrom
  function compatible(type) {
    if (!connectFrom) return true;
    const def = VIS_NODES[type];
    const wantDir = connectFrom.dir === 'out' ? 'in' : 'out';
    return visBPNodeHasPin(def, wantDir, connectFrom.kind);
  }
  const all = [];
  VIS_NODE_GROUPS.forEach(g => g.types.forEach(t => { if (compatible(t)) all.push({ type: t, title: VIS_NODES[t].title, cat: VIS_NODES[t].cat, grp: g.label }); }));

  const listEl = menu.querySelector('#vbCreatorList');
  const search = menu.querySelector('#vbCreatorSearch');
  let active = 0;
  function render(filter) {
    const f = (filter || '').trim().toLowerCase();
    const items = all.filter(it => !f || it.title.toLowerCase().includes(f) || it.cat.includes(f) || it.grp.toLowerCase().includes(f));
    active = Math.min(active, Math.max(0, items.length - 1));
    listEl.innerHTML = items.length ? items.map((it, i) => `
      <button class="vis-creator-item ${i === active ? 'active' : ''}" data-type="${esc(it.type)}">
        <span class="vis-palette-dot vis-node-${it.cat}"></span><span class="vis-creator-title">${esc(it.title)}</span><span class="vis-creator-grp dim">${esc(it.grp)}</span>
      </button>`).join('') : `<div class="vis-creator-empty dim">No matching nodes</div>`;
    listEl.querySelectorAll('[data-type]').forEach((b, i) => {
      b.onmouseenter = () => { active = i; highlight(); };
      b.onclick = () => choose(b.getAttribute('data-type'));
    });
    return items;
  }
  function highlight() { listEl.querySelectorAll('.vis-creator-item').forEach((b, i) => b.classList.toggle('active', i === active)); }
  function choose(type) {
    // place the node so its relevant pin lands near the drop point
    const def = VIS_NODES[type];
    let nx = world.x, ny = world.y - VB_HEAD_H / 2;
    if (connectFrom) { if (connectFrom.dir === 'out') nx = world.x; else nx = world.x - VB_NODE_W; }
    const node = visBPAddNode(actorId, type, nx, ny);
    if (connectFrom && node) {
      const wantDir = connectFrom.dir === 'out' ? 'in' : 'out';
      const pin = visBPFirstPin(def, wantDir, connectFrom.kind);
      if (pin) visBPTryConnect(actorId, connectFrom, { nodeId: node.id, pinKey: pin, dir: wantDir, kind: connectFrom.kind });
    }
    visCloseCreator();
  }
  let items = render('');
  search.oninput = () => { active = 0; items = render(search.value); };
  search.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, listEl.querySelectorAll('.vis-creator-item').length - 1); highlight(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); highlight(); e.preventDefault(); }
    else if (e.key === 'Enter') { const b = listEl.querySelectorAll('.vis-creator-item')[active]; if (b) choose(b.getAttribute('data-type')); e.preventDefault(); }
    else if (e.key === 'Escape') { visCloseCreator(); }
  };
  setTimeout(() => { search.focus(); document.addEventListener('mousedown', visCreatorOutside); }, 0);
}
function visBPNodeHasPin(def, dir, kind) { return !!visBPFirstPin(def, dir, kind); }
function visBPFirstPin(def, dir, kind) {
  if (kind === 'exec') {
    if (dir === 'in' && def.execIn) return 'in';
    if (dir === 'out' && def.execOut) return 'out';
    if (dir === 'out' && def.execOuts && def.execOuts.length) return def.execOuts[0].k;   // Branch True/False
    return null;
  }
  if (dir === 'in' && def.dataIn && def.dataIn.length) return def.dataIn[0].k;
  if (dir === 'out' && def.dataOut) return 'out';
  if (dir === 'out' && def.dataOuts && def.dataOuts.length) return def.dataOuts[0].k;
  return null;
}
function visCreatorOutside(e) { if (!e.target.closest('#vbCreator')) visCloseCreator(); }
function visCloseCreator() { const m = document.getElementById('vbCreator'); if (m) m.remove(); document.removeEventListener('mousedown', visCreatorOutside); }

/* ---- canvas interactions: right/middle-drag pan, left-drag marquee, wheel zoom, right-click creator ---- */
function visBPWireCanvas(actorId) {
  const wrap = document.getElementById('vbCanvasWrap');
  if (!wrap) return;

  wrap.onmousedown = (e) => {
    if (e.target.closest('.vis-node') || e.target.closest('[data-pin]') || e.target.closest('.vis-creator') || e.target.closest('[data-wire]')) return;
    if (e.button === 2 || e.button === 1) { visBPStartPan(e, actorId); e.preventDefault(); return; }   // right/middle = pan
    if (e.button === 0) { visBPStartMarquee(e, actorId); }                                              // left on empty = marquee
  };
  // right-click on empty canvas (no drag) opens the creator; suppress native menu
  let rcDown = null;
  wrap.addEventListener('mousedown', (e) => { if (e.button === 2) rcDown = { x: e.clientX, y: e.clientY, onNode: !!(e.target.closest('.vis-node') || e.target.closest('[data-wire]')) }; });
  wrap.oncontextmenu = (e) => {
    e.preventDefault();
    if (rcDown && !rcDown.onNode && Math.abs(e.clientX - rcDown.x) < 4 && Math.abs(e.clientY - rcDown.y) < 4) {
      visBPOpenCreator(actorId, e.clientX, e.clientY, null);
    }
    rcDown = null;
  };
  wrap.onwheel = (e) => {
    // if the node creator is open and the pointer is over it, let the list scroll natively
    if (e.target.closest && e.target.closest('.vis-creator')) return;
    e.preventDefault();
    visBPZoomBy(actorId, e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
  };
}

function visBPStartPan(e, actorId) {
  const cam = visBPCam(actorId);
  const Z = visRootZoom();
  const start = { mx: e.clientX, my: e.clientY, cx: cam.x, cy: cam.y };
  const onMove = (ev) => { cam.x = start.cx + (ev.clientX - start.mx) / Z; cam.y = start.cy + (ev.clientY - start.my) / Z; visBPApplyCam(actorId); };
  const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
}

function visBPStartMarquee(e, actorId) {
  const box = document.getElementById('vbMarquee');
  const additive = e.shiftKey;
  const base = additive ? Object.assign({}, visBPSel(actorId)) : {};
  // Work entirely in WORLD space (same frame as the nodes), so the box tracks the
  // cursor exactly at any zoom/pan and regardless of page scaling. The marquee div
  // lives inside #vbContent (transformed), so world px map straight to its style.
  const startW = visBPScreenToWorld(actorId, e.clientX, e.clientY);
  let dragged = false;
  const onMove = (ev) => {
    const cur = visBPScreenToWorld(actorId, ev.clientX, ev.clientY);
    const x = Math.min(startW.x, cur.x), y = Math.min(startW.y, cur.y);
    const w = Math.abs(cur.x - startW.x), h = Math.abs(cur.y - startW.y);
    if (w + h > 3) dragged = true;
    box.style.display = ''; box.style.left = x + 'px'; box.style.top = y + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px';
    const x2 = x + w, y2 = y + h;
    const t = visActorTab(actorId); t.sel = Object.assign({}, base);
    visBP(actorId).nodes.forEach(n => {
      const hh = visBPLayout(VIS_NODES[n.type]).height;
      if (n.x + VB_NODE_W >= x && n.x <= x2 && n.y + hh >= y && n.y <= y2) t.sel[n.id] = true;
    });
    visBPRenderNodes(actorId);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
    box.style.display = 'none';
    if (!dragged && !additive) visBPClearSel(actorId);   // a plain click on empty space clears
  };
  document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
}

/* ---- hotkeys (scoped to the blueprint tab) ---- */
function visBPInstallHotkeys(actorId) {
  if (VIS._bpKeyHandler) { document.removeEventListener('keydown', VIS._bpKeyHandler); VIS._bpKeyHandler = null; }
  const handler = (e) => {
    // only when the blueprint tab is showing and we're not typing in a field
    const tab = VIS.tabs[VIS.active];
    if (!tab || tab.kind !== 'actor' || tab.actorId !== actorId || tab.sub !== 'blueprint') return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.target.isContentEditable) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = (e.key || '').toLowerCase();
    if (e.key === 'Delete' || e.key === 'Backspace') { const ids = visBPSelIds(actorId); if (ids.length) { visBPDeleteNodes(actorId, ids); e.preventDefault(); } }
    else if (mod && k === 'a') { visBPSelectAll(actorId); e.preventDefault(); }
    else if (mod && k === 'c') { visBPCopy(actorId); e.preventDefault(); }
    else if (mod && k === 'x') { visBPCopy(actorId); visBPDeleteNodes(actorId, visBPSelIds(actorId)); e.preventDefault(); }
    else if (mod && k === 'v') { visBPPaste(actorId); e.preventDefault(); }
    else if (mod && k === 'd') { visBPCopy(actorId); visBPPaste(actorId); e.preventDefault(); }
    else if (e.key === 'Escape') { visCloseCreator(); visBPClearSel(actorId); }
  };
  VIS._bpKeyHandler = handler;
  document.addEventListener('keydown', handler);
}

/* copy the current selection to an in-app clipboard (nodes + internal wires) */
function visBPCopy(actorId) {
  const ids = new Set(visBPSelIds(actorId));
  if (!ids.size) return;
  const bp = visBP(actorId);
  const nodes = bp.nodes.filter(n => ids.has(n.id)).map(n => JSON.parse(JSON.stringify(n)));
  // keep only wires fully inside the selection
  const wires = bp.wires.filter(w => ids.has(w.from.split(':')[0]) && ids.has(w.to.split(':')[0])).map(w => JSON.parse(JSON.stringify(w)));
  VIS._bpClip = { nodes, wires };
}
/* paste the clipboard with fresh ids + a small offset; the copies become selected */
function visBPPaste(actorId) {
  const clip = VIS._bpClip;
  if (!clip || !clip.nodes.length) return;
  visPushUndo();
  const bp = visBP(actorId);
  const idMap = {};
  const off = 28;
  const t = visActorTab(actorId); t.sel = {};
  clip.nodes.forEach(n => {
    const nid = visUid('nd_');
    idMap[n.id] = nid;
    const copy = JSON.parse(JSON.stringify(n));
    copy.id = nid; copy.x = (n.x || 0) + off; copy.y = (n.y || 0) + off;
    bp.nodes.push(copy);
    t.sel[nid] = true;
  });
  clip.wires.forEach(w => {
    const [fn, fp] = w.from.split(':'), [tn, tp] = w.to.split(':');
    if (idMap[fn] && idMap[tn]) bp.wires.push({ id: visUid('wr_'), kind: w.kind, from: idMap[fn] + ':' + fp, to: idMap[tn] + ':' + tp });
  });
  VIS.doc.meta.modified = visNow();
  visBPRenderNodes(actorId); visQueueSave();
}

/* ---- Content Browser (assets + actor classes) ---------------------------- */
function visRenderContent() {
  const box = document.getElementById('visContent');
  if (!box) return;
  const actorTiles = VIS.doc.actors.map(a => {
    const selCls = VIS.sel === '#' + a.id ? ' sel-actor' : '';
    // a mini assembled preview: scale the actor's parts to fit the tile art box
    const scale = Math.min(1, 52 / Math.max(a.size.w, a.size.h, 1));
    const preview = `<div class="vis-tile-preview" style="width:${a.size.w}px;height:${a.size.h}px;transform:scale(${scale});">${visPartsHTML(a)}</div>`;
    return `<div class="vis-tile vis-tile-actor${selCls}" draggable="true" data-actor="${esc(a.id)}" title="Drag onto the canvas to place • click to select • double-click to open">
      <div class="vis-tile-art">${preview}</div>
      <div class="vis-tile-name">${esc(a.name)}</div>
    </div>`;
  }).join('');
  const texTiles = VIS.doc.assets.map(as => `
    <div class="vis-tile vis-tile-tex" data-asset="${esc(as.id)}" title="${esc(as.name)}">
      <div class="vis-tile-art"><img src="${esc(as.data)}" alt=""></div>
      <div class="vis-tile-name">${esc(as.name)}</div>
    </div>`).join('');

  box.innerHTML = `
    <div class="vis-cb-group">
      <div class="vis-cb-label eyebrow">Actors</div>
      <div class="vis-cb-grid">${actorTiles || `<div class="vis-cb-empty dim">No actors yet — add one to place on the canvas.</div>`}</div>
    </div>
    <div class="vis-cb-group">
      <div class="vis-cb-label eyebrow">Textures</div>
      <div class="vis-cb-grid">${texTiles || `<div class="vis-cb-empty dim">No textures uploaded.</div>`}</div>
    </div>`;

  // actor tiles: click to select/edit the class, drag to place an instance
  box.querySelectorAll('[data-actor]').forEach(t => {
    const aid = t.getAttribute('data-actor');
    t.onclick = () => visSelectActor(aid);
    t.ondblclick = () => visOpenActorTab(aid);
    t.ondragstart = (e) => { e.dataTransfer.setData('text/vis-actor', aid); e.dataTransfer.effectAllowed = 'copy'; };
  });
}

/* ---- Outliner (the scene tree of placed instances) ----------------------- */
function visRenderOutliner() {
  const box = document.getElementById('visOutliner');
  if (!box) return;
  const items = VIS.doc.scene.instances;
  if (!items.length) { box.innerHTML = `<div class="vis-ol-empty dim">The scene is empty.</div>`; return; }
  box.innerHTML = items.map(i => {
    const a = visActor(i.actor);
    return `<div class="vis-ol-row ${i.id === VIS.sel ? 'sel' : ''}" data-inst="${esc(i.id)}">
      <span class="vis-ol-ico">${svg('cube', 12)}</span>
      <span class="vis-ol-name">${esc(i.name || (a ? a.name : 'Instance'))}</span>
      <button class="vis-ol-del" data-del-inst="${esc(i.id)}" title="Delete">${svg('trash', 11)}</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-inst]').forEach(r => r.onclick = (e) => { if (e.target.closest('[data-del-inst]')) return; visSelect(r.getAttribute('data-inst')); });
  box.querySelectorAll('[data-del-inst]').forEach(b => b.onclick = (e) => { e.stopPropagation(); visDeleteInstance(b.getAttribute('data-del-inst')); });
}

/* ---- Viewport / stage (the 2D DOM canvas) -------------------------------- */
function visRenderStage() {
  const stage = document.getElementById('visStage');
  if (!stage) return;
  const w = VIS.doc.world;
  const lightMarkers = (w && w.light && Array.isArray(w.light.points) ? w.light.points : []).map(lp =>
    `<div class="vis-light-marker" title="${esc(lp.name)}" style="left:${+lp.x || 0}px;top:${+lp.y || 0}px;--lit:${esc(lp.color || '#ffd9a0')};"></div>`).join('');
  stage.innerHTML = VIS.doc.scene.instances.map(i => visInstHTML(i)).join('') + lightMarkers;
  stage.querySelectorAll('[data-inst-el]').forEach(el => {
    const id = el.getAttribute('data-inst-el');
    // Placed instances are SELECT-only — clicking selects (shows Details), but
    // instances are NOT draggable in the level. Position is set via Details X/Y;
    // an in-game drag is something the creator wires up themselves with mouse nodes.
    el.onmousedown = (e) => { e.stopPropagation(); visSelect(id); };
  });
}

/* Render one part as an absolutely-positioned layer inside an actor box of size
   (aw,ah). Parts are authored around the actor's CENTRE (x/y are offsets from it),
   which is what the runtime and Canvas preview assume too. */
function visPartHTML(p, aw, ah) {
  const asset = p.sprite ? visAsset(p.sprite) : null;
  const bg = asset ? `background-image:url('${esc(asset.data)}');background-size:cover;background-repeat:no-repeat;` : `background:${esc(p.color || '#8a8f98')};`;
  const cx = aw / 2 + (p.x || 0), cy = ah / 2 + (p.y || 0);
  return `<div class="vis-part-layer" data-part="${esc(p.id)}"
      style="left:${cx}px;top:${cy}px;width:${p.w}px;height:${p.h}px;transform:translate(-50%,-50%) rotate(${p.rotation || 0}deg);${bg}"></div>`;
}
/* The assembled visual of an actor (all its parts, bottom-to-top). */
function visPartsHTML(a) {
  if (!a) return '';
  return visActorParts(a).map(p => visPartHTML(p, a.size.w, a.size.h)).join('');
}

function visInstHTML(i) {
  const a = visActor(i.actor);
  const aw = a ? a.size.w : 64, ah = a ? a.size.h : 64;
  const s = i.scale || 1;
  // Outer box is the actor's natural size; a single scale() on the parts layer
  // handles per-instance scaling, and translate(-50%,-50%) centres it on (x,y).
  return `<div class="vis-inst ${i.id === VIS.sel ? 'sel' : ''}" data-inst-el="${esc(i.id)}"
      style="left:${i.x}px;top:${i.y}px;width:${aw * s}px;height:${ah * s}px;transform:translate(-50%,-50%) rotate(${i.rotation || 0}deg);">
      <div class="vis-inst-parts" style="width:${aw}px;height:${ah}px;transform:scale(${s});transform-origin:top left;">${visPartsHTML(a)}</div>
    </div>`;
}

/* ---- Details (properties of the selection) ------------------------------- */
function visRenderDetails() {
  const box = document.getElementById('visDetails');
  if (!box) return;
  // instance selected?
  const inst = VIS.sel && VIS.sel[0] !== '#' ? visInst(VIS.sel) : null;
  if (inst) { visRenderInstanceDetails(box, inst); return; }
  // actor class selected? (prefixed with '#')
  if (VIS.sel && VIS.sel[0] === '#') { const a = visActor(VIS.sel.slice(1)); if (a) { visRenderActorDetails(box, a); return; } }
  // nothing selected -> World Settings (gravity + lighting)
  visRenderWorldDetails(box);
}

/* World Settings panel (shown in Details when nothing is selected). Physics
   gravity + scene lighting (ambient + point lights). */
function visRenderWorldDetails(box) {
  const w = VIS.doc.world = visNormalizeWorld(VIS.doc.world);
  const p = w.physics, l = w.light;
  box.innerHTML = `
    <div class="vis-det-head">${svg('globe', 14)} <span>World Settings</span></div>
    <div class="vis-ivars-h">${svg('cube', 12)} Physics</div>
    <label class="vis-field"><span>Gravity</span><input type="number" id="vwGrav" step="1" value="${p.gravity}" title="0 = no gravity (default). Only Movable actors feel it."></label>
    <div class="vis-field-row">
      <label class="vis-field"><span>Dir X</span><input type="number" id="vwGX" step="0.1" value="${p.gravityX}"></label>
      <label class="vis-field"><span>Dir Y</span><input type="number" id="vwGY" step="0.1" value="${p.gravityY}" title="Down is +Y"></label>
    </div>
    <div class="vis-ivars-h">${svg('image', 12)} Lighting</div>
    <div class="vis-field-row">
      <label class="vis-field"><span>Ambient</span><input type="color" id="vwAmbC" value="${esc(l.ambientColor)}"></label>
      <label class="vis-field"><span>Intensity</span><input type="number" id="vwAmbI" step="0.1" min="0" max="4" value="${l.ambientIntensity}" title="1 = fully lit; lower to darken the scene"></label>
    </div>
    <div class="vis-lights" id="vwLights">${w.light.points.map(visLightRowHTML).join('') || '<div class="vis-ol-empty dim">No point lights.</div>'}</div>
    <div class="vis-det-acts"><button class="btn ghost sm" id="vwAddLight">${svg('plus', 13)} Point light</button></div>`;

  const changed = () => { VIS.doc.meta.modified = visNow(); visRenderStage(); visQueueSave(); };
  box.querySelector('#vwGrav').oninput = (e) => { p.gravity = +e.target.value || 0; changed(); };
  box.querySelector('#vwGX').oninput = (e) => { p.gravityX = +e.target.value || 0; changed(); };
  box.querySelector('#vwGY').oninput = (e) => { p.gravityY = +e.target.value || 0; changed(); };
  box.querySelector('#vwAmbC').oninput = (e) => { l.ambientColor = e.target.value; changed(); };
  box.querySelector('#vwAmbI').oninput = (e) => { l.ambientIntensity = visClamp(e.target.value, 0, 4); changed(); };
  box.querySelector('#vwAddLight').onclick = () => {
    visPushUndo();
    l.points.push({ id: visUid('lit_'), name: 'Light ' + (l.points.length + 1), x: 0, y: 0, color: '#ffd9a0', radius: 200, intensity: 1 });
    visRenderDetails(); changed();
  };
  box.querySelectorAll('[data-light]').forEach(row => {
    const lp = l.points.find(x => x.id === row.getAttribute('data-light')); if (!lp) return;
    row.querySelector('[data-lf="name"]').oninput = (e) => { lp.name = e.target.value; changed(); };
    row.querySelector('[data-lf="x"]').oninput = (e) => { lp.x = +e.target.value || 0; changed(); };
    row.querySelector('[data-lf="y"]').oninput = (e) => { lp.y = +e.target.value || 0; changed(); };
    row.querySelector('[data-lf="color"]').oninput = (e) => { lp.color = e.target.value; changed(); };
    row.querySelector('[data-lf="radius"]').oninput = (e) => { lp.radius = Math.max(1, +e.target.value || 1); changed(); };
    row.querySelector('[data-lf="intensity"]').oninput = (e) => { lp.intensity = visClamp(e.target.value, 0, 4); changed(); };
    row.querySelector('[data-lf="del"]').onclick = () => { visPushUndo(); l.points = l.points.filter(x => x.id !== lp.id); visRenderDetails(); changed(); };
  });
}
function visLightRowHTML(lp) {
  return `<div class="vis-light-row" data-light="${esc(lp.id)}">
    <div class="vis-light-top"><input type="text" class="vis-light-name" data-lf="name" value="${esc(lp.name)}" maxlength="40">
      <input type="color" data-lf="color" value="${esc(lp.color)}" title="Colour">
      <button class="vis-var-del" data-lf="del" title="Remove light">${svg('trash', 12)}</button></div>
    <div class="vis-field-row">
      <label class="vis-field"><span>X</span><input type="number" data-lf="x" value="${lp.x}"></label>
      <label class="vis-field"><span>Y</span><input type="number" data-lf="y" value="${lp.y}"></label>
    </div>
    <div class="vis-field-row">
      <label class="vis-field"><span>Radius</span><input type="number" data-lf="radius" min="1" value="${lp.radius}"></label>
      <label class="vis-field"><span>Power</span><input type="number" data-lf="intensity" step="0.1" min="0" max="4" value="${lp.intensity}"></label>
    </div>
  </div>`;
}

function visRenderInstanceDetails(box, i) {
  const a = visActor(i.actor);
  box.innerHTML = `
    <div class="vis-det-head">${svg('cube', 14)} <span>Instance</span> <em class="dim">${esc(a ? a.name : 'Actor')}</em></div>
    <label class="vis-field"><span>Name</span><input type="text" id="viName" maxlength="80" value="${esc(i.name || '')}" placeholder="${esc(a ? a.name : 'Instance')}"></label>
    <div class="vis-field-row">
      <label class="vis-field"><span>X</span><input type="number" id="viX" value="${i.x}"></label>
      <label class="vis-field"><span>Y</span><input type="number" id="viY" value="${i.y}"></label>
    </div>
    <div class="vis-field-row">
      <label class="vis-field"><span>Rotation°</span><input type="number" id="viRot" value="${i.rotation || 0}"></label>
      <label class="vis-field"><span>Scale</span><input type="number" id="viScale" step="0.1" min="0.1" value="${i.scale || 1}"></label>
    </div>
    ${visInstanceVarsHTML(a, i)}
    <div class="vis-det-acts"><button class="btn ghost sm danger" id="viDel">${svg('trash', 13)} Delete instance</button></div>`;

  const upd = (patch) => { Object.assign(i, patch); VIS.doc.meta.modified = visNow(); visRenderStage(); visRenderOutliner(); visQueueSave(); };
  box.querySelector('#viName').oninput = (e) => { i.name = e.target.value; visRenderOutliner(); visQueueSave(); };
  box.querySelector('#viX').oninput = (e) => upd({ x: Math.round(+e.target.value || 0) });
  box.querySelector('#viY').oninput = (e) => upd({ y: Math.round(+e.target.value || 0) });
  box.querySelector('#viRot').oninput = (e) => upd({ rotation: (+e.target.value || 0) % 360 });
  box.querySelector('#viScale').oninput = (e) => upd({ scale: visClamp(e.target.value, 0.1, 20) });
  box.querySelector('#viDel').onclick = () => visDeleteInstance(i.id);
  visWireInstanceVars(box, a, i);
}

/* Per-instance variable OVERRIDES. Each of the actor's params shows an input; an
   empty override falls back to the class default (shown as the placeholder). A set
   value writes instance.props[name] — the same store the runtime reads at Play. */
function visInstanceVarsHTML(a, i) {
  if (!a || !a.params.length) return '';
  const rows = a.params.map(pr => {
    const has = i.props && Object.prototype.hasOwnProperty.call(i.props, pr.name);
    const val = has ? i.props[pr.name] : '';
    if (pr.type === 'bool') {
      const checked = has ? !!i.props[pr.name] : !!pr.value;
      return `<div class="vis-ivar-row"><span class="vis-ivar-name" title="default: ${esc(pr.value)}">${esc(pr.name)}</span>
        <label class="vis-ivar-bool"><input type="checkbox" data-ivar="${esc(pr.name)}" data-itype="bool" ${checked ? 'checked' : ''}> <span class="dim">${has ? 'override' : 'default'}</span></label></div>`;
    }
    if (pr.type === 'vec2' || pr.type === 'vector') {
      const arr = has && Array.isArray(i.props[pr.name]) ? i.props[pr.name] : (Array.isArray(pr.value) ? pr.value : visVarDefault(pr.type));
      const labels = pr.type === 'vec2' ? ['X', 'Y'] : ['X', 'Y', 'Z'];
      return `<div class="vis-ivar-row"><span class="vis-ivar-name" title="${has ? 'override' : 'default'}">${esc(pr.name)}</span>
        <span class="vis-var-vec">${labels.map((L, k) => `<input type="number" class="vis-ivar-vec vis-var-vec-inp" data-ivar="${esc(pr.name)}" data-vec-i="${k}" value="${+arr[k] || 0}" title="${L}">`).join('')}</span></div>`;
    }
    const inputType = pr.type === 'string' ? 'text' : 'number';
    return `<div class="vis-ivar-row"><span class="vis-ivar-name">${esc(pr.name)}</span>
      <input type="${inputType}" class="vis-ivar-inp" data-ivar="${esc(pr.name)}" data-itype="${esc(pr.type)}" value="${has ? esc(val) : ''}" placeholder="${esc(pr.value)}" title="Default: ${esc(pr.value)} — leave blank to use it"></div>`;
  }).join('');
  return `<div class="vis-ivars"><div class="vis-ivars-h">${svg('gear', 12)} Variables</div>${rows}</div>`;
}
function visWireInstanceVars(box, a, i) {
  if (!a) return;
  // scalar / bool / string overrides
  box.querySelectorAll('[data-ivar]:not(.vis-ivar-vec)').forEach(inp => {
    const name = inp.getAttribute('data-ivar'), type = inp.getAttribute('data-itype');
    const commit = () => {
      i.props = i.props || {};
      if (type === 'bool') { i.props[name] = inp.checked; }
      else if (inp.value === '') { delete i.props[name]; }   // blank = revert to class default
      else { i.props[name] = type === 'string' ? inp.value : visVarCoerce(type, inp.value); }
      VIS.doc.meta.modified = visNow(); visQueueSave();
    };
    inp.oninput = commit; inp.onchange = commit;
  });
  // vec2/vector overrides — always write the whole array (grouped by var name)
  box.querySelectorAll('.vis-ivar-vec').forEach(inp => {
    inp.oninput = () => {
      const name = inp.getAttribute('data-ivar');
      const pr = a.params.find(p => p.name === name); if (!pr) return;
      const len = pr.type === 'vector' ? 3 : 2;
      const cur = Array.isArray(i.props[name]) ? i.props[name].slice() : (Array.isArray(pr.value) ? pr.value.slice() : visVarDefault(pr.type));
      cur[+inp.getAttribute('data-vec-i')] = +inp.value || 0;
      i.props = i.props || {}; i.props[name] = cur.slice(0, len);
      VIS.doc.meta.modified = visNow(); visQueueSave();
    };
  });
}

function visRenderActorDetails(box, a) {
  const count = VIS.doc.scene.instances.filter(i => i.actor === a.id).length;
  box.innerHTML = `
    <div class="vis-det-head">${svg('cube', 14)} <span>Actor class</span></div>
    <label class="vis-field"><span>Name</span><input type="text" id="vaName" maxlength="80" value="${esc(a.name)}"></label>
    <div class="vis-field-row">
      <label class="vis-field"><span>Width</span><input type="number" id="vaW" min="4" value="${a.size.w}"></label>
      <label class="vis-field"><span>Height</span><input type="number" id="vaH" min="4" value="${a.size.h}"></label>
    </div>
    <label class="vis-field"><span>Mobility</span>
      <select id="vaMob" class="set-select" title="Static objects never move; Movable objects feel gravity and can be moved by physics/blueprints.">
        <option value="static" ${a.mobility !== 'movable' ? 'selected' : ''}>Static</option>
        <option value="movable" ${a.mobility === 'movable' ? 'selected' : ''}>Movable</option>
      </select></label>
    <p class="vis-det-note dim">${a.parts.length} part${a.parts.length === 1 ? '' : 's'} · ${a.params.length} variable${a.params.length === 1 ? '' : 's'} · ${count} instance${count === 1 ? '' : 's'} placed.</p>
    <div class="vis-det-acts vis-det-acts-col">
      <button class="btn primary sm" id="vaOpen">${svg('window', 13)} Open actor</button>
      <button class="btn ghost sm danger" id="vaDel">${svg('trash', 13)} Delete actor</button>
    </div>`;

  const changed = () => { VIS.doc.meta.modified = visNow(); visRenderContent(); visRenderStage(); visQueueSave(); };
  box.querySelector('#vaName').oninput = (e) => { a.name = e.target.value || 'Actor'; if (typeof visSyncActorTabName === 'function') visSyncActorTabName(a.id); changed(); };
  box.querySelector('#vaW').oninput = (e) => { a.size.w = visClamp(e.target.value, 4, 4096); changed(); };
  box.querySelector('#vaH').oninput = (e) => { a.size.h = visClamp(e.target.value, 4, 4096); changed(); };
  box.querySelector('#vaMob').onchange = (e) => { a.mobility = e.target.value === 'movable' ? 'movable' : 'static'; changed(); };
  box.querySelector('#vaOpen').onclick = () => { if (typeof visOpenActorTab === 'function') visOpenActorTab(a.id); };
  box.querySelector('#vaDel').onclick = () => visDeleteActor(a.id);
}

/* ============================================================
   SELECTION
   ============================================================ */
function visSelect(instId) { VIS.sel = instId; visRenderStage(); visRenderOutliner(); visRenderDetails(); }
function visSelectActor(actorId) { VIS.sel = '#' + actorId; visRenderStage(); visRenderOutliner(); visRenderContent(); visRenderDetails(); }

/* ============================================================
   MUTATIONS — actors, textures, instances
   ============================================================ */
function visAddActor() {
  visPushUndo();
  const n = VIS.doc.actors.length + 1;
  const a = visMakeActor('Actor ' + n, n);
  VIS.doc.actors.push(a);
  VIS.doc.meta.modified = visNow();
  visRenderContent();
  visSelectActor(a.id);
  visQueueSave();
}
function visActorColor(n) { const palette = ['#5b8def', '#57c785', '#e0a13b', '#d9534f', '#9b6bdb', '#3bb0c9', '#d76ba0']; return palette[(n - 1) % palette.length]; }

function visDeleteActor(id) {
  const used = VIS.doc.scene.instances.filter(i => i.actor === id).length;
  const go = () => {
    visPushUndo();
    VIS.doc.actors = VIS.doc.actors.filter(a => a.id !== id);
    VIS.doc.scene.instances = VIS.doc.scene.instances.filter(i => i.actor !== id);
    if (VIS.sel === '#' + id) VIS.sel = null;
    VIS.doc.meta.modified = visNow();
    visRenderContent(); visRenderOutliner(); visRenderStage(); visRenderDetails(); visQueueSave();
  };
  if (used) confirmModal('Delete this actor?', `This actor has ${used} instance${used === 1 ? '' : 's'} in the scene. Deleting the actor removes ${used === 1 ? 'it' : 'them all'} too.`, go);
  else go();
}

/* Add a texture asset from a data-URL, refresh the UI, and save. */
function visAddTextureAsset(name, dataUrl) {
  const as = { id: visUid('ast_'), name: String(name || 'texture').slice(0, 80), kind: 'texture', data: dataUrl };
  VIS.doc.assets.push(as);
  VIS.doc.meta.modified = visNow();
  visRenderContent();
  visRenderDetails();   // if an actor class is selected, its sprite dropdown updates
  if (typeof visRenderActorTab === 'function' && VIS.tabs[VIS.active] && VIS.tabs[VIS.active].kind === 'actor') visRenderActorTab(VIS.tabs[VIS.active].actorId);
  toast('Texture added');
  visQueueSave();
  return as;
}

/* Texture source chooser: from the device, or from the user's Simplex vault. */
function visUploadTexture() {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal vis-texsrc-modal">
    <h3>${svg('image', 16)} Add a texture</h3>
    <p class="dim">Bring in an image from your device, or pick one already in your vault.</p>
    <div class="vis-texsrc-opts">
      <button class="vis-texsrc-opt" data-src="device">${svg('upload', 22)}<span>From device</span><em class="dim">Upload an image file</em></button>
      <button class="vis-texsrc-opt" data-src="vault">${svg('folder', 22)}<span>From vault</span><em class="dim">Choose an image you've stored</em></button>
    </div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('[data-src="device"]').onclick = () => { close(); visUploadTextureDevice(); };
  bg.querySelector('[data-src="vault"]').onclick = () => { close(); visUploadTextureVault(); };
}

/* Device upload (the original FileReader flow). */
function visUploadTextureDevice() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast('Texture too large (max 8 MB)', 'close'); return; }
    const r = new FileReader();
    r.onload = () => visAddTextureAsset(f.name, String(r.result));
    r.onerror = () => toast('Could not read that image', 'close');
    r.readAsDataURL(f);
  };
  inp.click();
}

/* Vault picker: a grid of the account's image files; choosing one fetches its
   decrypted bytes (/api/files/:id/raw) and stores them inline as a texture. */
function visUploadTextureVault() {
  const files = (typeof DB !== 'undefined' && DB && Array.isArray(DB.files)) ? DB.files : [];
  const images = files.filter(f => f && f.type === 'image' && !f.trashed);
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  const grid = images.length ? images.map(f => `
    <button class="vis-vaultpick" data-file="${esc(f.id)}" title="${esc(f.name)}">
      <span class="vis-vaultpick-art"><img src="/api/files/${esc(f.id)}/raw" alt="" loading="lazy"></span>
      <span class="vis-vaultpick-name">${esc(f.name)}</span>
    </button>`).join('') : `<div class="vis-vaultpick-empty dim">No images in your vault yet. Upload some in the Database first, or use “From device”.</div>`;
  bg.innerHTML = `<div class="modal vis-vault-modal">
    <h3>${svg('folder', 16)} Choose a vault image</h3>
    <div class="vis-vault-grid">${grid}</div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelectorAll('[data-file]').forEach(btn => btn.onclick = async () => {
    const id = btn.getAttribute('data-file');
    const f = images.find(x => x.id === id);
    if (f && f.size > 8 * 1024 * 1024) { toast('That image is large — it may bloat the project', 'info'); }
    btn.classList.add('loading');
    try {
      const res = await fetch('/api/files/' + id + '/raw');
      if (!res.ok) throw new Error('fetch failed');
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(blob); });
      close();
      visAddTextureAsset(f ? f.name : 'texture', dataUrl);
    } catch (e) {
      btn.classList.remove('loading');
      toast('Could not load that image', 'close');
    }
  });
}

function visAddInstance(actorId, x, y) {
  const a = visActor(actorId);
  if (!a) return;
  visPushUndo();
  const n = VIS.doc.scene.instances.filter(i => i.actor === actorId).length + 1;
  const inst = { id: visUid('ins_'), actor: actorId, x: Math.round(x), y: Math.round(y), rotation: 0, scale: 1, name: a.name + '_' + n, props: {} };
  VIS.doc.scene.instances.push(inst);
  VIS.doc.meta.modified = visNow();
  visRenderStage(); visRenderOutliner();
  visSelect(inst.id);
  visQueueSave();
}

function visDeleteInstance(id) {
  visPushUndo();
  VIS.doc.scene.instances = VIS.doc.scene.instances.filter(i => i.id !== id);
  if (VIS.sel === id) VIS.sel = null;
  VIS.doc.meta.modified = visNow();
  visRenderStage(); visRenderOutliner(); visRenderDetails(); visQueueSave();
}

/* ============================================================
   VIEWPORT INTERACTION — drop-to-place + drag-to-move
   ============================================================ */
function visWireViewport() {
  const vp = document.getElementById('visViewport');
  if (!vp) return;
  vp.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; vp.classList.add('drop'); };
  vp.ondragleave = () => vp.classList.remove('drop');
  vp.ondrop = (e) => {
    e.preventDefault(); vp.classList.remove('drop');
    const actorId = e.dataTransfer.getData('text/vis-actor');
    if (!actorId) return;
    const pt = visVpPoint(vp, e.clientX, e.clientY);
    visAddInstance(actorId, pt.x, pt.y);
  };
  // click empty canvas to deselect
  vp.onmousedown = (e) => { if (e.target === vp || e.target.classList.contains('vis-stage') || e.target.classList.contains('vis-vp-grid') || e.target.classList.contains('vis-vp-origin')) { if (VIS.sel) { VIS.sel = null; visRenderStage(); visRenderOutliner(); visRenderContent(); visRenderDetails(); } } };
}

/* convert a client (mouse) point to stage coordinates, honouring scroll + camera */
function visVpPoint(vp, clientX, clientY) {
  const stage = document.getElementById('visStage');
  const r = stage.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}


/* ============================================================
   RENAME the open document (inline, from the toolbar)
   ============================================================ */
function visRenameDocInline() {
  const host = document.getElementById('visDocName');
  if (!host) return;
  const old = VIS.doc.meta.name;
  const input = document.createElement('input');
  input.className = 'vis-tb-name-input'; input.value = old; input.maxLength = 120;
  host.replaceWith(input); input.focus(); input.select();
  const commit = (save) => {
    const val = input.value.trim() || old;
    const div = document.createElement('div');
    div.className = 'vis-tb-name'; div.id = 'visDocName'; div.title = 'Rename project'; div.textContent = save ? val : old;
    input.replaceWith(div); div.onclick = visRenameDocInline;
    if (save && val !== old) { VIS.doc.meta.name = val; const row = VIS.projects.find(p => p.id === VIS.id); if (row) row.name = val; visQueueSave(); }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); };
  input.onblur = () => commit(true);
}

/* ============================================================
   AUTO-SAVE — debounced write of the whole document, with status pill.
   ============================================================ */
function visQueueSave() {
  VIS.dirty = true;
  visSetSaveState('pending');
  if (VIS.saveTimer) clearTimeout(VIS.saveTimer);
  VIS.saveTimer = setTimeout(visFlushSave, VIS_SAVE_DEBOUNCE);
}

async function visFlushSave() {
  if (VIS.saveTimer) { clearTimeout(VIS.saveTimer); VIS.saveTimer = null; }
  if (!VIS.dirty || !VIS.id || !VIS.doc) return;
  if (VIS.saving) { return; }   // a save is running; the dirty flag keeps us honest and safety-timer/next edit will re-fire
  VIS.saving = true; VIS.dirty = false;
  visSetSaveState('saving');
  try {
    await updateVisProject(VIS.id, { name: VIS.doc.meta.name, data: VIS.doc });
    visSetSaveState('saved');
  } catch (e) {
    VIS.dirty = true;   // keep it pending so we retry
    visSetSaveState('error');
  } finally {
    VIS.saving = false;
    // if edits landed while saving, schedule another flush
    if (VIS.dirty) { if (VIS.saveTimer) clearTimeout(VIS.saveTimer); VIS.saveTimer = setTimeout(visFlushSave, VIS_SAVE_DEBOUNCE); }
  }
}

function visSetSaveState(s) {
  VIS.saveError = (s === 'error');
  const el = document.getElementById('visSaveState');
  if (!el) return;
  el.classList.remove('is-pending', 'is-saving', 'is-saved', 'is-error');
  const map = { pending: ['is-pending', 'Unsaved…'], saving: ['is-saving', 'Saving…'], saved: ['is-saved', 'Saved'], error: ['is-error', 'Save failed — retrying'] };
  const [cls, label] = map[s] || map.saved;
  el.classList.add(cls);
  el.innerHTML = `${svg(s === 'error' ? 'info' : 'save', 14)} <span>${label}</span>`;
}

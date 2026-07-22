/* ============================================================
   SIMPLEX VISUAL — RUNTIME (visual-runtime.js)
   ------------------------------------------------------------
   The shared engine that RUNS a project. Used by the standalone play page
   (play.html at /visual/play/<id>) and, later, any in-editor preview. It is
   self-contained: no dependency on app.js/data.js helpers, so it can boot in a
   lean page. Exposes window.VisualRuntime.

   HOW IT RUNS (kept deliberately small — see the node registry in apps-visual.js):
     · compileActor(actor) flattens the blueprint into a HANDLER TABLE:
       for each event node, walk its exec wires to produce an ordered list of
       action steps; each step resolves its data inputs (wired data node OR the
       node's inline prop) at run time.
     · createRuntime(doc, mount) builds a live STATE per placed instance
       (x, y, rotation, scale, visible, vars = {...paramDefaults, ...instance.props}),
       wires up keyboard/mouse input, and ticks every frame with requestAnimationFrame,
       applying transform/visibility to the instance's DOM element.
   No physics/collision yet — those layer cleanly on top of this loop later.
   ============================================================ */
(function () {
  'use strict';

  /* ---- helpers (standalone) ---- */
  function partsSorted(actor) {
    return (actor && Array.isArray(actor.parts) ? actor.parts.slice() : []).sort((p, q) => (p.z || 0) - (q.z || 0));
  }
  function escAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

  /* Build the DOM for one instance's assembled parts (matches the editor's look). */
  function instanceEl(doc, inst, actor) {
    const aw = actor ? actor.size.w : 64, ah = actor ? actor.size.h : 64;
    const wrap = document.createElement('div');
    wrap.className = 'vr-inst';
    wrap.style.position = 'absolute';
    wrap.style.width = aw + 'px';
    wrap.style.height = ah + 'px';
    const inner = document.createElement('div');
    inner.className = 'vr-inst-parts';
    inner.style.position = 'relative';
    inner.style.width = aw + 'px';
    inner.style.height = ah + 'px';
    partsSorted(actor).forEach(p => {
      const asset = p.sprite ? (doc.assets || []).find(a => a.id === p.sprite) : null;
      const layer = document.createElement('div');
      layer.setAttribute('data-part', p.id);
      layer.style.position = 'absolute';
      layer.style.width = p.w + 'px';
      layer.style.height = p.h + 'px';
      const cx = aw / 2 + (p.x || 0), cy = ah / 2 + (p.y || 0);
      layer.style.left = cx + 'px';
      layer.style.top = cy + 'px';
      layer.dataset.baseRot = String(p.rotation || 0);
      layer.dataset.baseX = String(p.x || 0);
      layer.dataset.baseY = String(p.y || 0);
      layer.dataset.cx = String(cx); layer.dataset.cy = String(cy);
      layer.style.transform = 'translate(-50%,-50%) rotate(' + (p.rotation || 0) + 'deg)';
      if (asset) { layer.style.backgroundImage = "url('" + asset.data + "')"; layer.style.backgroundSize = 'cover'; layer.style.backgroundRepeat = 'no-repeat'; }
      else { layer.style.background = p.color || '#8a8f98'; }
      layer.style.borderRadius = '2px';
      inner.appendChild(layer);
    });
    wrap.appendChild(inner);
    return wrap;
  }

  function isEventType(t) { return typeof t === 'string' && t.indexOf('event.') === 0; }

  /* ---- COMPILE: blueprint graph -> handler table ---- */
  // Returns { events: { <eventType>: [chain,...] }, hasEvent(type), fire(type,ctx) }.
  // Event nodes are detected by the "event." type prefix, so the runtime needs no
  // external node registry — it stays self-contained for the lean play page.
  function compileActor(actor) {
    const bp = (actor && actor.blueprint) || { nodes: [], wires: [] };
    const nodes = {}; bp.nodes.forEach(n => nodes[n.id] = n);
    // index exec wires: fromRef -> toNodeId ; data wires: toRef -> {node,pin}
    const execNext = {};   // "nodeId:out" -> nodeId (of the next exec node)
    const dataFrom = {};   // "nodeId:pinKey" -> { node:sourceNodeId, pin:sourcePinKey }
    (bp.wires || []).forEach(w => {
      if (w.kind === 'exec') execNext[w.from] = w.to.split(':')[0];
      else { const fp = w.from.split(':'); dataFrom[w.to] = { node: fp[0], pin: fp[1] || 'out' }; }
    });

    /* Value model: a data pin carries either a NUMBER (bool = 1/0) or a
       component ARRAY for vectors ([x,y] for vec2, [x,y,z] for vector). Scalar
       consumers use resolveInput (arrays coerce to 0); vec consumers use
       resolveVec. `evalData` takes the requested OUT pin key so Break nodes can
       return the right component. */
    function evalSource(ref, ctx) { const s = ref && nodes[ref.node]; return s ? evalData(s, ctx, ref.pin) : undefined; }
    // resolve a data value for node n's input pin `key` -> scalar number
    function resolveInput(n, key, ctx) {
      const val = evalSource(dataFrom[n.id + ':' + key], ctx);
      if (val !== undefined) return Array.isArray(val) ? 0 : val;
      const v = n.props ? n.props[key] : undefined;
      return v === undefined ? 0 : coerceNum(v);
    }
    // resolve a vec input pin -> component array of the given length (defaults 0)
    function resolveVec(n, key, ctx, len) {
      const val = evalSource(dataFrom[n.id + ':' + key], ctx);
      const out = new Array(len).fill(0);
      if (Array.isArray(val)) for (let i = 0; i < len; i++) out[i] = coerceNum(val[i]);
      else if (typeof val === 'number') out[0] = val;
      return out;
    }
    function resolveBool(n, key, ctx) {
      const val = evalSource(dataFrom[n.id + ':' + key], ctx);
      if (val !== undefined) return Array.isArray(val) ? false : val > 0.5;
      const v = n.props ? n.props[key] : undefined;
      return v === undefined ? false : (v === true || v === 'true' || +v > 0.5);
    }
    // 0-safe divide: 0 if EITHER operand is 0 (per spec), or divisor non-finite.
    function safeDiv(a, b) { if (a === 0 || b === 0 || !isFinite(b)) return 0; const r = a / b; return isFinite(r) ? r : 0; }
    // evaluate a data node -> number OR component array. `outPin` selects which
    // output (used by Break Vec nodes; ignored by single-output nodes).
    function evalData(n, ctx, outPin) {
      const t = n.type;
      switch (t) {
        case 'data.number': return coerceNum(n.props && n.props.value);
        case 'data.bool': { const v = n.props && n.props.value; return (v === true || v === 'true' || +v > 0.5) ? 1 : 0; }
        case 'data.param': { const name = n.props && n.props.name; const st = ctx.state; const val = st && st.vars ? st.vars[name] : undefined; if (Array.isArray(val)) return val.slice(); return val == null ? 0 : coerceNum(val); }
        case 'data.delta': return ctx.dt || 0;
        case 'data.keyHeld': { const k = normKey(n.props && n.props.key); return ctx.input.keys[k] ? 1 : 0; }
        case 'data.mathAdd': return resolveInput(n, 'a', ctx) + resolveInput(n, 'b', ctx);
        case 'data.mathMul': return resolveInput(n, 'a', ctx) * resolveInput(n, 'b', ctx);
        case 'data.mathSub': return resolveInput(n, 'a', ctx) - resolveInput(n, 'b', ctx);
        case 'data.mathDiv': return safeDiv(resolveInput(n, 'a', ctx), resolveInput(n, 'b', ctx));
        case 'data.mathMax': return Math.max(resolveInput(n, 'a', ctx), resolveInput(n, 'b', ctx));
        case 'data.mathMin': return Math.min(resolveInput(n, 'a', ctx), resolveInput(n, 'b', ctx));
        case 'data.mathLerp': { const a = resolveInput(n, 'a', ctx), b = resolveInput(n, 'b', ctx), tt = resolveInput(n, 't', ctx); return a + (b - a) * tt; }
        case 'data.round': return Math.round(resolveInput(n, 'v', ctx));
        case 'bool.toFloat': return resolveBool(n, 'b', ctx) ? 1 : 0;
        // vectors
        case 'data.makeVec2': return [resolveInput(n, 'x', ctx), resolveInput(n, 'y', ctx)];
        case 'data.makeVec': return [resolveInput(n, 'x', ctx), resolveInput(n, 'y', ctx), resolveInput(n, 'z', ctx)];
        case 'data.breakVec2': { const v = resolveVec(n, 'v', ctx, 2); return outPin === 'y' ? v[1] : v[0]; }
        case 'data.breakVec': { const v = resolveVec(n, 'v', ctx, 3); return outPin === 'z' ? v[2] : outPin === 'y' ? v[1] : v[0]; }
        // transform GET (Actor or Part). Part transforms are actor-local.
        case 'data.getLocation': { const tgt = n.props && n.props.target; const st = ctx.state;
          if (tgt && tgt !== 'self') { const p = st.partX && st.partX[tgt] !== undefined; return [ (st.partX && st.partX[tgt]) || 0, (st.partY && st.partY[tgt]) || 0 ]; }
          return [st.x, st.y]; }
        case 'data.getRotation': { const tgt = n.props && n.props.target; const st = ctx.state;
          if (tgt && tgt !== 'self') return (st.partRot && st.partRot[tgt]) || 0;
          return st.rotation; }
        case 'data.getScale': { const tgt = n.props && n.props.target; const st = ctx.state;
          if (tgt && tgt !== 'self') return (st.partScale && st.partScale[tgt] != null) ? st.partScale[tgt] : 1;
          return st.scale; }
        case 'event.overlapBegin':
        case 'event.overlapEnd':
          // the "Other" pin exposes the overlapping instance id (a string)
          return (ctx.eventData && ctx.eventData.other != null) ? ctx.eventData.other : '';
        default:
          // Generated families: conversions (num.*, bool.*) + comparisons (cmp.*).
          if (t.indexOf('num.') === 0) return evalNumConvert(n, t, ctx);
          if (t.indexOf('cmp.') === 0) return evalCompare(n, t, ctx) ? 1 : 0;
          return 0;
      }
    }
    // clamp/round helpers for the strict number subtypes
    function coerceTo(type, v) {
      switch (type) {
        case 'byte':   { let i = Math.round(v); return i < 0 ? 0 : i > 255 ? 255 : i; }
        case 'byte64': { let i = Math.round(v); return i < 0 ? 0 : i; }   // non-negative whole
        case 'int':    return Math.round(v);
        default:       return v;   // float / number
      }
    }
    // num.toFloat.<t> | num.round.<t> | num.to.<src>.<dst>
    function evalNumConvert(n, t, ctx) {
      const v = resolveInput(n, 'v', ctx);
      const parts = t.split('.');
      if (parts[1] === 'toFloat') return v;
      if (parts[1] === 'round') return Math.round(v);
      if (parts[1] === 'to') return coerceTo(parts[3], v);
      return v;
    }
    // cmp.<op>.<t> comparisons + cmp.between.<t>
    function evalCompare(n, t, ctx) {
      const op = t.split('.')[1];
      if (op === 'between') { const v = resolveInput(n, 'v', ctx), lo = resolveInput(n, 'min', ctx), hi = resolveInput(n, 'max', ctx); return v >= lo && v <= hi; }
      const a = resolveInput(n, 'a', ctx), b = resolveInput(n, 'b', ctx);
      switch (op) {
        case 'gt':  return a > b;
        case 'gte': return a >= b;
        case 'lt':  return a < b;
        case 'lte': return a <= b;
        case 'eq':  return a === b;
        case 'neq': return a !== b;
        default:    return false;
      }
    }

    // Run an exec node and RETURN which exec-out pin fired next (default 'out';
    // Branch returns 'true'/'false'). Actions mutate state.
    function runExec(n, ctx) {
      const st = ctx.state;
      switch (n.type) {
        case 'flow.branch': return resolveBool(n, 'cond', ctx) ? 'true' : 'false';
        case 'act.move': st.x += resolveInput(n, 'dx', ctx); st.y += resolveInput(n, 'dy', ctx); return 'out';
        case 'act.rotate': st.rotation = (st.rotation + resolveInput(n, 'deg', ctx)) % 360; return 'out';
        case 'act.setScale': st.scale = Math.max(0.01, resolveInput(n, 'scale', ctx)); return 'out';
        case 'act.setVisible': st.visible = resolveBool(n, 'visible', ctx); return 'out';
        case 'act.setPartRotation': { const pid = n.props && n.props.part; if (pid) st.partRot[pid] = resolveInput(n, 'deg', ctx); return 'out'; }
        case 'act.setVar': { const name = n.props && n.props.name; if (name) {
          // preserve vector values (wired from a Make/vec source) as arrays
          const raw = evalSource(dataFrom[n.id + ':value'], ctx);
          st.vars[name] = raw !== undefined ? (Array.isArray(raw) ? raw.slice() : raw) : resolveInput(n, 'value', ctx);
        } return 'out'; }
        // transform SET (Actor or Part; part transforms are actor-local)
        case 'act.setLocation': { const tgt = n.props && n.props.target; const loc = resolveVec(n, 'loc', ctx, 2);
          if (tgt && tgt !== 'self') { st.partX = st.partX || {}; st.partY = st.partY || {}; st.partX[tgt] = loc[0]; st.partY[tgt] = loc[1]; }
          else { st.x = loc[0]; st.y = loc[1]; } return 'out'; }
        case 'act.setRotation': { const tgt = n.props && n.props.target; const deg = resolveInput(n, 'deg', ctx) % 360;
          if (tgt && tgt !== 'self') st.partRot[tgt] = deg; else st.rotation = deg; return 'out'; }
        case 'act.setWScale': { const tgt = n.props && n.props.target; const sc = Math.max(0.01, resolveInput(n, 'scale', ctx));
          if (tgt && tgt !== 'self') { st.partScale = st.partScale || {}; st.partScale[tgt] = sc; } else st.scale = sc; return 'out'; }
        default: return 'out';
      }
    }

    // Walk the exec graph from an event node at FIRE time (handles Branch + merges;
    // a per-fire visit budget prevents infinite loops from cyclic wiring).
    function walkFrom(startNodeId, ctx) {
      let cur = execNext[startNodeId + ':out'];
      let budget = 10000;
      while (cur && nodes[cur] && budget-- > 0) {
        const n = nodes[cur];
        const outPin = runExec(n, ctx);
        cur = execNext[n.id + ':' + outPin];
      }
    }

    // gather event nodes by type, keyed for fireKeyed matching
    const events = {};
    bp.nodes.forEach(n => { if (isEventType(n.type)) (events[n.type] = events[n.type] || []).push(n.id); });
    return {
      events,
      hasEvent: function (t) { return !!events[t]; },
      fire: function (t, ctx) { const ids = events[t]; if (!ids) return; for (const id of ids) walkFrom(id, ctx); },
      fireNode: function (nodeId, ctx) { walkFrom(nodeId, ctx); },
      eventNodes: function (t) { return events[t] || []; },
      nodeProp: function (nodeId, key) { const n = nodes[nodeId]; return n && n.props ? n.props[key] : undefined; },
    };
  }

  function coerceNum(v) { if (typeof v === 'boolean') return v ? 1 : 0; const n = +v; return isFinite(n) ? n : 0; }
  function normKey(k) { return String(k || '').trim().toLowerCase(); }

  /* ---- CREATE RUNTIME ---- */
  function createRuntime(doc, mount, opts) {
    opts = opts || {};
    const actorsById = {}; (doc.actors || []).forEach(a => actorsById[a.id] = a);
    const compiled = {};   // actorId -> compiled blueprint
    (doc.actors || []).forEach(a => compiled[a.id] = compileActor(a));

    const input = { keys: Object.create(null), mouse: { x: 0, y: 0, down: false } };
    const insts = [];      // live instance states

    // build DOM + state for each placed instance
    mount.innerHTML = '';
    mount.style.position = 'relative';
    (doc.scene.instances || []).forEach(inst => {
      const actor = actorsById[inst.actor];
      const el = instanceEl(doc, inst, actor);
      mount.appendChild(el);
      const vars = {};
      if (actor) (actor.params || []).forEach(p => vars[p.name] = Array.isArray(p.value) ? p.value.slice() : p.value);
      if (inst.props) for (const k in inst.props) vars[k] = Array.isArray(inst.props[k]) ? inst.props[k].slice() : inst.props[k];
      insts.push({
        id: inst.id, inst, actor, el,
        x: inst.x, y: inst.y, rotation: inst.rotation || 0, scale: inst.scale || 1,
        visible: true, vars, partRot: {}, partX: {}, partY: {}, partScale: {},
        vx: 0, vy: 0,                             // physics velocity (px/s)
        movable: actor && actor.mobility === 'movable',
        _overlaps: Object.create(null),          // set of instance ids currently overlapping
        // per-instance transient input flags
        _dragging: false,
      });
    });

    function applyTransforms() {
      for (const s of insts) {
        s.el.style.left = s.x + 'px';
        s.el.style.top = s.y + 'px';
        s.el.style.transform = 'translate(-50%,-50%) rotate(' + s.rotation + 'deg) scale(' + s.scale + ')';
        s.el.style.display = s.visible ? '' : 'none';
        // per-part runtime transform overrides (rotation added onto authored;
        // location/scale REPLACE the authored value when a Set node ran).
        const layers = s.el.querySelectorAll('[data-part]');
        layers.forEach(l => {
          const pid = l.getAttribute('data-part');
          const rotSet = s.partRot && s.partRot[pid] != null;
          const locSet = s.partX && s.partX[pid] !== undefined;
          const scaleSet = s.partScale && s.partScale[pid] != null;
          if (!rotSet && !locSet && !scaleSet) return;
          // position: base center + (override location - authored offset)
          if (locSet) {
            const cx0 = +l.dataset.cx || 0, cy0 = +l.dataset.cy || 0;
            const bx = +l.dataset.baseX || 0, by = +l.dataset.baseY || 0;
            l.style.left = (cx0 - bx + s.partX[pid]) + 'px';
            l.style.top = (cy0 - by + s.partY[pid]) + 'px';
          }
          const rot = (+l.dataset.baseRot || 0) + (rotSet ? s.partRot[pid] : 0);
          const scl = scaleSet ? s.partScale[pid] : 1;
          l.style.transform = 'translate(-50%,-50%) rotate(' + rot + 'deg) scale(' + scl + ')';
        });
      }
    }

    // current frame delta (seconds) — exposed to blueprints via the Delta node
    let curDt = 0;
    function ctxFor(s, eventData) { return { state: s, input: input, dt: curDt, eventData: eventData || null }; }

    // ---- world (physics + lighting) ----
    const world = (doc && doc.world) || {};
    const phys = world.physics || { gravity: 0, gravityX: 0, gravityY: 1 };
    const light = world.light || { ambientColor: '#ffffff', ambientIntensity: 1, points: [] };

    // AABB (axis-aligned; rotation ignored for the box) of an instance, in scene px
    function aabb(s) {
      const a = s.actor; const w = (a ? a.size.w : 64) * s.scale, h = (a ? a.size.h : 64) * s.scale;
      return { l: s.x - w / 2, r: s.x + w / 2, t: s.y - h / 2, b: s.y + h / 2 };
    }
    function overlaps(a, b) { return a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t; }

    // integrate physics for Movable instances, then run AABB overlap begin/end.
    function stepPhysics(dt) {
      if (dt > 0) {
        const gx = (+phys.gravity || 0) * (+phys.gravityX || 0);
        const gy = (+phys.gravity || 0) * (+phys.gravityY || 0);
        for (const s of insts) {
          if (!s.movable || s._dragging) continue;
          s.vx += gx * dt; s.vy += gy * dt;
          s.x += s.vx * dt; s.y += s.vy * dt;
        }
      }
      // overlap detection (both directions get the event; "Other" = the other id)
      const boxes = insts.map(aabb);
      for (let i = 0; i < insts.length; i++) {
        for (let j = i + 1; j < insts.length; j++) {
          const now = overlaps(boxes[i], boxes[j]);
          const si = insts[i], sj = insts[j];
          const was = !!si._overlaps[sj.id];
          if (now && !was) {
            si._overlaps[sj.id] = true; sj._overlaps[si.id] = true;
            fireOverlap(si, sj, 'event.overlapBegin'); fireOverlap(sj, si, 'event.overlapBegin');
          } else if (!now && was) {
            delete si._overlaps[sj.id]; delete sj._overlaps[si.id];
            fireOverlap(si, sj, 'event.overlapEnd'); fireOverlap(sj, si, 'event.overlapEnd');
          }
        }
      }
    }
    function fireOverlap(s, other, type) {
      const c = compiled[s.inst.actor];
      if (c && c.hasEvent(type)) c.fire(type, ctxFor(s, { other: other.id }));
    }

    // ---- lighting: two overlays over the scene ----
    //  · shade  (mix-blend multiply): ambient tint. intensity 1 = white = no change;
    //    <1 darkens toward black, tinted by ambient colour.
    //  · glow   (mix-blend screen): additive point-light halos that lighten.
    let shadeLayer = null, glowLayer = null;
    function ensureLayer(ref, blend) {
      let el = ref();
      if (!el) { el = document.createElement('div'); el.className = 'vr-lighting'; el.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:9999;mix-blend-mode:' + blend + ';'; mount.appendChild(el); }
      return el;
    }
    function buildLighting() {
      const amb = light.ambientIntensity == null ? 1 : +light.ambientIntensity;
      const pts = Array.isArray(light.points) ? light.points : [];
      // ambient shade (only when dimmed below full)
      if (amb < 1) {
        shadeLayer = shadeLayer || (function () { const e = document.createElement('div'); e.className = 'vr-lighting'; e.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:9998;mix-blend-mode:multiply;'; mount.appendChild(e); return e; })();
        shadeLayer.style.background = hexA(light.ambientColor || '#ffffff', 1);
        shadeLayer.style.opacity = String(Math.max(0, Math.min(1, 1 - amb)));
      } else if (shadeLayer) { shadeLayer.remove(); shadeLayer = null; }
      // point-light glows
      if (pts.length) {
        glowLayer = glowLayer || (function () { const e = document.createElement('div'); e.className = 'vr-lighting'; e.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:9999;mix-blend-mode:screen;'; mount.appendChild(e); return e; })();
        const cw = mount.clientWidth / 2, ch = mount.clientHeight / 2;
        glowLayer.style.background = pts.map(p =>
          'radial-gradient(circle ' + Math.max(1, +p.radius || 200) + 'px at ' +
          (cw + (+p.x || 0)) + 'px ' + (ch + (+p.y || 0)) + 'px, ' +
          hexA(p.color || '#ffd9a0', Math.max(0, Math.min(1, (p.intensity == null ? 1 : +p.intensity)))) + ' 0%, transparent 70%)'
        ).join(',');
      } else if (glowLayer) { glowLayer.remove(); glowLayer = null; }
    }
    function hexA(hex, a) {
      const h = String(hex || '#ffffff').replace('#', '');
      const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0');
      const r = parseInt(n.slice(0, 2), 16) || 0, g = parseInt(n.slice(2, 4), 16) || 0, b = parseInt(n.slice(4, 6), 16) || 0;
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }

    // ---- input wiring ----
    function onKeyDown(e) { const k = normKey(e.key); if (input.keys[k]) return; input.keys[k] = true; fireKeyEvent('event.keyDown', k); }
    function onKeyUp(e) { const k = normKey(e.key); input.keys[k] = false; fireKeyEvent('event.keyUp', k); }
    function fireAll(type) {
      for (const s of insts) { const c = compiled[s.inst.actor]; if (c && c.hasEvent(type)) c.fire(type, ctxFor(s)); }
    }
    // key events: only run event nodes whose configured key matches the pressed key
    function fireKeyEvent(type, key) {
      for (const s of insts) {
        const c = compiled[s.inst.actor]; if (!c || !c.hasEvent(type)) continue;
        c.eventNodes(type).forEach(nid => {
          if (normKey(c.nodeProp(nid, 'key')) === key) c.fireNode(nid, ctxFor(s));
        });
      }
    }

    // mouse: click + drag on an instance element
    function onMouseDown(e) {
      const target = e.target.closest('.vr-inst');
      input.mouse.down = true;
      for (const s of insts) {
        if (s.el === target) {
          s._dragging = true; s._dragOff = { x: e.clientX, y: e.clientY, sx: s.x, sy: s.y };
          fireInst(s, 'event.click'); fireInst(s, 'event.dragStart');
        }
      }
    }
    function onMouseMove(e) {
      input.mouse.x = e.clientX; input.mouse.y = e.clientY;
      for (const s of insts) {
        if (s._dragging) {
          // move to follow cursor (blueprint 'On Drag' can add its own behaviour too)
          s.x = s._dragOff.sx + (e.clientX - s._dragOff.x);
          s.y = s._dragOff.sy + (e.clientY - s._dragOff.y);
          fireInst(s, 'event.drag');
        }
      }
    }
    function onMouseUp() {
      input.mouse.down = false;
      for (const s of insts) { if (s._dragging) { s._dragging = false; fireInst(s, 'event.dragEnd'); } }
    }
    function fireInst(s, type) { const c = compiled[s.inst.actor]; if (c && c.hasEvent(type)) c.fire(type, ctxFor(s)); }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    mount.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    // ---- main loop ----
    let raf = 0, running = true, started = false, lastT = 0;
    function frame(now) {
      if (!running) return;
      // frame delta in seconds, clamped so a background tab doesn't produce a huge jump
      curDt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
      lastT = now;
      if (!started) { started = true; fireAll('event.start'); }
      for (const s of insts) { const c = compiled[s.inst.actor]; if (c && c.hasEvent('event.tick')) c.fire('event.tick', ctxFor(s)); }
      stepPhysics(curDt);       // gravity integration + AABB overlap begin/end events
      applyTransforms();
      buildLighting();
      raf = requestAnimationFrame(frame);
    }
    stepPhysics(0);             // seed overlap state (fires begin for already-touching pairs)
    applyTransforms();
    buildLighting();
    raf = requestAnimationFrame(frame);

    return {
      stop: function () {
        running = false; cancelAnimationFrame(raf);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        mount.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        if (shadeLayer) { shadeLayer.remove(); shadeLayer = null; }
        if (glowLayer) { glowLayer.remove(); glowLayer = null; }
      },
      instances: insts,
    };
  }

  window.VisualRuntime = { compileActor: compileActor, createRuntime: createRuntime };
})();

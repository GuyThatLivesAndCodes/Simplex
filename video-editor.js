/* ============================================================
   MINI VIDEO EDITOR (video-editor.js) — extracted from app.js, loaded on demand
   by openTool("mini-video") so its ~900 lines stay out of the boot path. Plain
   (non-module) script: shares app.js global scope, so it SEES core helpers
   (svg/esc/toast/pickVaultFile/mvePromptModal/mveExport/startToolProgressPoll/
   _toolsFfmpeg/fmtDur/…) and DEFINES mveEditorHTML + wireMiniVideoEditor that the
   Tools dispatcher calls. See [[lazy-loading-architecture]].
   ============================================================ */
/* ============================================================
   MINI VIDEO EDITOR (v2) — a vault-only, multi-track video editor in the spirit
   of DaVinci Resolve / Premiere / CapCut. Create a project, then add videos &
   audio from the vault onto stacked Video/Audio tracks. Clips are trimmed/moved
   on a shared time ruler; a video's audio is auto-split onto a linked audio clip
   you can edit independently. Volume & pitch are keyframable with curves. Preview
   runs in-browser (approximate); EXPORT renders the authoritative mp4 server-side
   (ffmpeg) back into the vault. The project itself saves as a .mve.json document.
   All media must already live in the vault — no upload here by design.
   ============================================================ */
const MVE_EXT = '.mve.json';
const MVE_POS_OPTS = [['tl', '↖'], ['tc', '↑'], ['tr', '↗'], ['ml', '←'], ['mc', '•'], ['mr', '→'], ['bl', '↙'], ['bc', '↓'], ['br', '↘']];
const MVE_CURVES = ['linear', 'ease', 'hold'];
let _mve = null;   // active editor state (null when not open)
let _mveSeq = 0;
function mveId(p) { return p + (++_mveSeq) + '_' + Math.random().toString(36).slice(2, 7); }

function mveBlankProject() {
  return {
    v: 2, name: 'Untitled edit', fps: 30, w: 1280, h: 720, duration: 0,
    tracks: [
      { id: mveId('t'), kind: 'video', name: 'V1', muted: false, hidden: false, clips: [] },
      { id: mveId('t'), kind: 'audio', name: 'A1', muted: false, clips: [] },
    ],
    overlays: [], export: null,
  };
}

/* default clip skeleton (audio fields apply to audio clips AND a video clip's own
   embedded audio while it stays linked) */
function mveMakeClip(kind, f, start) {
  const dur = f.dur || 0;
  return {
    id: mveId('c'), fileId: f.id, name: f.name, kind,
    start: start || 0, in: 0, out: dur || 5, srcDur: dur,
    linkId: null, volume: 1, pitch: 0, mute: false,
    volumeKfs: [], pitchKfs: [],
    fadeIn: 0, fadeOut: 0,   // seconds; video clips fade the picture, audio clips fade the sound
  };
}
/* a clip's played length on the timeline (out-in), clamped ≥ 0 */
function mveClipLen(c) { return Math.max(0, (c.out || 0) - (c.in || 0)); }
/* fade multiplier (0..1) at clip-local time t, from fadeIn/fadeOut envelopes.
   Mirrored on the server (mveFadeMul) so preview matches the render. */
function mveFadeMul(c, tLocal) {
  const len = mveClipLen(c); if (len <= 0) return 1;
  let m = 1;
  const fi = Math.min(c.fadeIn || 0, len), fo = Math.min(c.fadeOut || 0, len);
  if (fi > 0 && tLocal < fi) m = Math.min(m, tLocal / fi);
  if (fo > 0 && tLocal > len - fo) m = Math.min(m, Math.max(0, (len - tLocal) / fo));
  return Math.max(0, Math.min(1, m));
}

/* ---- keyframe evaluation (shared with preview; mirrored on the server) ---- */
function mveEaseT(a, b, frac, curve) {
  if (curve === 'hold') return a;
  if (curve === 'ease') frac = frac * frac * (3 - 2 * frac);   // smoothstep
  return a + (b - a) * frac;
}
/* value of a keyframe list at clip-local time t (seconds). dflt when no kfs. */
function mveKfValue(kfs, t, dflt) {
  if (!kfs || !kfs.length) return dflt;
  const s = [...kfs].sort((x, y) => x.t - y.t);
  if (t <= s[0].t) return s[0].v;
  if (t >= s[s.length - 1].t) return s[s.length - 1].v;
  for (let i = 0; i < s.length - 1; i++) {
    if (t >= s[i].t && t <= s[i + 1].t) {
      const span = s[i + 1].t - s[i].t || 1e-6;
      return mveEaseT(s[i].v, s[i + 1].v, (t - s[i].t) / span, s[i].curve || 'linear');
    }
  }
  return s[s.length - 1].v;
}

/* ---- track/clip lookups ---- */
function mveVideoTracks() { return _mve.project.tracks.filter(t => t.kind === 'video'); }
function mveAudioTracks() { return _mve.project.tracks.filter(t => t.kind === 'audio'); }
function mveFirst(kind) { return _mve.project.tracks.find(t => t.kind === kind); }
function mveAllClips() { const out = []; _mve.project.tracks.forEach(t => t.clips.forEach(c => out.push({ track: t, clip: c }))); return out; }
function mveFindClip(id) { for (const t of _mve.project.tracks) { const c = t.clips.find(x => x.id === id); if (c) return { track: t, clip: c }; } return null; }
function mveClipEnd(c) { return (c.start || 0) + Math.max(0, (c.out || 0) - (c.in || 0)); }
function mveComputeDuration() { let d = 0; mveAllClips().forEach(({ clip }) => { d = Math.max(d, mveClipEnd(clip)); }); _mve.project.duration = d; return d; }

/* migrate a v1 project to the v2 track model */
function mveMigrateV1(p) {
  const np = mveBlankProject();
  np.name = p.name || 'Untitled edit';
  np.overlays = Array.isArray(p.overlays) ? p.overlays : [];
  const vTrack = mveFirstOf(np, 'video'), aTrack = mveFirstOf(np, 'audio');
  if (p.source && p.source.fileId) {
    const inP = (p.trim && p.trim.in) || 0, outP = (p.trim && p.trim.out) || p.source.dur || 0;
    // split [in,out] minus interior cuts into kept segments -> sequential clips
    const cuts = (Array.isArray(p.cuts) ? p.cuts : []).slice().sort((a, b) => a.start - b.start);
    let cur = inP, tlStart = 0;
    const segs = [];
    for (const c of cuts) { if (c.start > cur) segs.push([cur, Math.min(c.start, outP)]); cur = Math.max(cur, c.end); if (cur >= outP) break; }
    if (cur < outP) segs.push([cur, outP]);
    if (!segs.length) segs.push([inP, outP]);
    for (const [s, e] of segs) {
      const len = e - s;
      const vc = { id: mveId('c'), fileId: p.source.fileId, name: p.source.name || 'video', kind: 'video', start: tlStart, in: s, out: e, srcDur: p.source.dur || 0, linkId: null, volume: (p.sourceAudio && p.sourceAudio.volume) ?? 1, pitch: 0, mute: !!(p.sourceAudio && p.sourceAudio.mute), volumeKfs: [], pitchKfs: [] };
      const ac = { id: mveId('c'), fileId: p.source.fileId, name: p.source.name || 'audio', kind: 'audio', start: tlStart, in: s, out: e, srcDur: p.source.dur || 0, linkId: vc.id, volume: vc.volume, pitch: 0, mute: vc.mute, volumeKfs: [], pitchKfs: [] };
      vc.linkId = ac.id;
      vTrack.clips.push(vc); aTrack.clips.push(ac);
      tlStart += len;
    }
  }
  (Array.isArray(p.audioTracks) ? p.audioTracks : []).forEach(tr => {
    aTrack.clips.push({ id: mveId('c'), fileId: tr.fileId, name: tr.name || 'audio', kind: 'audio', start: tr.start || 0, in: tr.in || 0, out: tr.out || 0, srcDur: 0, linkId: null, volume: tr.volume ?? 1, pitch: tr.pitch || 0, mute: !!tr.mute, volumeKfs: [], pitchKfs: [] });
  });
  np.export = p.export || null;
  return np;
}
function mveFirstOf(proj, kind) { return proj.tracks.find(t => t.kind === kind); }

function mveEditorHTML(t) {
  return `<div class="mve" id="mve">
    <div class="mve-toolbar">
      <div class="mve-name" id="mveName" title="Rename project">Untitled edit</div>
      <span class="mve-saved mono" id="mveSaved"></span>
      <button class="btn ghost sm" id="mveUndo" title="Undo (Ctrl+Z)" disabled>${svg('undo', 14)}</button>
      <button class="btn ghost sm" id="mveRedo" title="Redo (Ctrl+Shift+Z)" disabled>${svg('redo', 14)}</button>
      <div class="spacer"></div>
      <button class="btn ghost sm" id="mveOpen">${svg('folder', 14)} Open</button>
      <button class="btn ghost sm" id="mveSave">${svg('save', 14)} Save</button>
      <button class="btn primary sm" id="mveExport" disabled>${svg('video', 14)} Export</button>
    </div>
    <div class="mve-stage">
      <div class="mve-preview-wrap">
        <div class="mve-preview" id="mvePreview">
          <video id="mveVideo" class="mve-video hidden" playsinline></video>
          <div class="mve-prev-black" id="mvePrevBlack"></div>
          <div class="mve-overlay-layer" id="mveOverlayLayer"></div>
          <div class="mve-prev-note mono" id="mvePrevNote">preview is approximate — export for the final render</div>
        </div>
        <div class="mve-transport" id="mveTransport">
          <button class="mve-pp" id="mvePlay" title="Play / pause (Space)">${svg('play', 16)}</button>
          <span class="mve-time mono" id="mveTime">0:00 / 0:00</span>
          <span class="spacer"></span>
          <span class="mve-keys mono" title="Space play · S split · Del delete · ←/→ step (Shift = 1s) · Ctrl+Z undo · Ctrl+D duplicate">${svg('info', 13)} shortcuts</span>
        </div>
      </div>
      <div class="mve-side" id="mveSide">
        <div class="mve-inspector" id="mveInspector"></div>
      </div>
    </div>
    <div class="mve-tlbar" id="mveTlbar"></div>
    <div class="mve-timeline" id="mveTimeline"></div>
    <div class="mve-result" id="mveResult"></div>
  </div>`;
}

/* ---- editor lifecycle ---- */
function mveVideoEl() { return document.getElementById('mveVideo'); }

function wireMiniVideoEditor(t) {
  _mve = {
    project: mveBlankProject(),
    docId: null,            // vault doc id once saved
    dirty: false,
    sel: null,              // { kind:'clip'|'overlay'|'track'|null, id/i }
    pps: 80,                // pixels per second (timeline zoom)
    playhead: 0,            // seconds on the timeline
    playing: false,
    snap: true,
    clipAudios: {},         // fileId -> hidden <audio> for preview
    curVideoFile: null,     // which fileId the preview <video> currently holds
    raf: null,
    exporting: false,
    abort: null,
    history: [],            // past project snapshots (JSON strings) for undo
    future: [],             // snapshots undone, for redo
    lastCommitted: null,    // the project state as of the last settled edit
    histTimer: null,        // debounce so a drag-burst collapses to one undo step
  };
  _mve.lastCommitted = mveSnap();
  _appCleanup = () => {
    mvePreviewStop();
    document.removeEventListener('keydown', mveKeyHandler, true);
    if (_mve) { if (_mve.histTimer) clearTimeout(_mve.histTimer); Object.values(_mve.clipAudios).forEach(a => { try { a.pause(); a.src = ''; } catch (e) {} }); if (_mve.abort) { try { _mve.abort.abort(); } catch (e) {} } }
    _mve = null;
  };

  document.getElementById('mveName').onclick = mveRenameProject;
  document.getElementById('mveOpen').onclick = mveOpenProject;
  document.getElementById('mveSave').onclick = () => mveSaveProject(false);
  document.getElementById('mveExport').onclick = mveExportProject;
  document.getElementById('mvePlay').onclick = mveTogglePlay;
  document.getElementById('mveUndo').onclick = mveUndo;
  document.getElementById('mveRedo').onclick = mveRedo;

  const v = mveVideoEl();
  v.addEventListener('ended', () => {});   // we drive time ourselves

  document.addEventListener('keydown', mveKeyHandler, true);   // editor shortcuts
  mveRefresh();
}

/* ---- undo / redo (project-snapshot stack) ---- */
const MVE_HIST_CAP = 60;
function mveSnap() { return _mve ? JSON.stringify(_mve.project) : null; }
/* record that an edit happened. Debounced: a burst (e.g. a drag emitting many
   mveMarkDirty calls) collapses into ONE history entry — the state before the burst. */
function mvePushHistory() {
  if (!_mve) return;
  if (_mve.histTimer) return;   // a burst is already pending; the pre-burst snapshot is captured
  const before = _mve.lastCommitted;
  _mve.histTimer = setTimeout(() => {
    _mve.histTimer = null;
    const after = mveSnap();
    if (after === before) return;              // nothing actually changed
    _mve.history.push(before);
    if (_mve.history.length > MVE_HIST_CAP) _mve.history.shift();
    _mve.future = [];                          // a new edit invalidates the redo stack
    _mve.lastCommitted = after;
    mveUpdateHistButtons();
  }, 220);
}
function mveApplySnap(json) {
  try { _mve.project = JSON.parse(json); } catch (e) { return; }
  _mve.sel = null; _mve.lastCommitted = mveSnap();
  _mve.dirty = true; const s = document.getElementById('mveSaved'); if (s) s.textContent = 'unsaved changes';
  mveRefresh(); mveUpdateHistButtons();
}
function mveUndo() {
  if (!_mve || !_mve.history.length) return;
  if (_mve.histTimer) { clearTimeout(_mve.histTimer); _mve.histTimer = null; _mve.lastCommitted = mveSnap(); }
  _mve.future.push(mveSnap());
  const prev = _mve.history.pop();
  mveApplySnap(prev);
  toast('Undo', 'info');
}
function mveRedo() {
  if (!_mve || !_mve.future.length) return;
  _mve.history.push(mveSnap());
  const next = _mve.future.pop();
  mveApplySnap(next);
  toast('Redo', 'info');
}
function mveUpdateHistButtons() {
  const u = document.getElementById('mveUndo'), r = document.getElementById('mveRedo');
  if (u) u.disabled = !_mve || !_mve.history.length;
  if (r) r.disabled = !_mve || !_mve.future.length;
}

/* ---- keyboard shortcuts (only while the editor is the open app & not typing) ---- */
function mveKeyHandler(e) {
  if (!_mve) return;
  const el = document.getElementById('mve'); if (!el) return;
  // ignore when typing in an input/textarea/contenteditable
  const tgt = e.target;
  if (tgt && (tgt.matches('input,textarea,select,[contenteditable]') || tgt.isContentEditable)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? mveRedo() : mveUndo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); mveRedo(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); if (_mve.sel && _mve.sel.kind === 'clip') mveDuplicateClip(_mve.sel.id); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); mveSaveProject(false); return; }
  if (mod) return;   // leave other ctrl/cmd combos to the browser
  switch (e.key) {
    case ' ': e.preventDefault(); mveTogglePlay(); break;
    case 's': case 'S': e.preventDefault(); mveSplitAtPlayhead(); break;
    case 'Delete': case 'Backspace': e.preventDefault(); mveDeleteSelection(); break;
    case 'ArrowLeft': e.preventDefault(); mveNudgePlayhead(e.shiftKey ? -1 : -(1 / (_mve.project.fps || 30))); break;
    case 'ArrowRight': e.preventDefault(); mveNudgePlayhead(e.shiftKey ? 1 : (1 / (_mve.project.fps || 30))); break;
    case 'Home': e.preventDefault(); mveSetPlayhead(0); break;
    case 'End': e.preventDefault(); mveSetPlayhead(mveComputeDuration()); break;
    case '+': case '=': e.preventDefault(); _mve.pps = Math.min(400, _mve.pps * 1.4); mveRenderTimeline(); break;
    case '-': case '_': e.preventDefault(); _mve.pps = Math.max(12, _mve.pps / 1.4); mveRenderTimeline(); break;
    default: break;
  }
}
function mveNudgePlayhead(dt) { mveSetPlayhead(Math.max(0, Math.min(mveComputeDuration(), _mve.playhead + dt))); }
/* delete whatever's selected (clip or overlay) — used by the Delete key */
function mveDeleteSelection() {
  const sel = _mve.sel; if (!sel) return;
  if (sel.kind === 'clip') {
    const f = mveFindClip(sel.id); if (!f) return;
    f.track.clips = f.track.clips.filter(x => x.id !== sel.id);
    if (f.clip.linkId) { const l = mveFindClip(f.clip.linkId); if (l) l.clip.linkId = null; }
    _mve.sel = null; mveMarkDirty(); mveRefresh();
  } else if (sel.kind === 'overlay') {
    _mve.project.overlays.splice(sel.i, 1); _mve.sel = null; mveMarkDirty(); mveRefresh();
  }
}

function mveMarkDirty() { if (_mve) { _mve.dirty = true; mvePushHistory(); const s = document.getElementById('mveSaved'); if (s) s.textContent = 'unsaved changes'; } }

/* re-render everything that depends on the project model */
function mveRefresh() {
  if (!_mve) return;
  mveComputeDuration();
  document.getElementById('mveName').textContent = _mve.project.name || 'Untitled edit';
  const hasMedia = mveAllClips().length > 0;
  document.getElementById('mveExport').disabled = !hasMedia;
  mveRebuildClipAudios();
  mveRenderInspector();
  mveRenderTimelineBar();
  mveRenderTimeline();
  mveRenderOverlays();
  mveCompositeAt(_mve.playhead);
}

/* ---- add media (create-then-add; auto-split video audio, linked) ---- */
function mveAddMedia() {
  pickVaultFile({ kinds: ['video', 'audio'], onPick: (f) => {
    if (!f) return;
    const at = mvePlayheadOrEnd();
    if (f.type === 'video') {
      // adopt canvas size from the first video if still default-empty
      const vc = mveMakeClip('video', f, at);
      const ac = mveMakeClip('audio', f, at);
      vc.linkId = ac.id; ac.linkId = vc.id;
      mveFirst('video').clips.push(vc);
      mveFirst('audio').clips.push(ac);
      _mve.sel = { kind: 'clip', id: vc.id };
      // pull true duration from metadata so the clip length is right
      mveProbeDuration(f.id, (dur) => {
        if (!_mve) return;
        if (dur) { if (vc.out <= vc.in + 0.01 || !vc.srcDur) { vc.out = dur; vc.srcDur = dur; } if (ac.out <= ac.in + 0.01 || !ac.srcDur) { ac.out = dur; ac.srcDur = dur; } }
        mveRefresh();
      });
    } else {
      const ac = mveMakeClip('audio', f, at);
      mveFirst('audio').clips.push(ac);
      _mve.sel = { kind: 'clip', id: ac.id };
      mveProbeDuration(f.id, (dur) => { if (!_mve) return; if (dur && (ac.out <= ac.in + 0.01 || !ac.srcDur)) { ac.out = dur; ac.srcDur = dur; } mveRefresh(); });
    }
    mveMarkDirty(); mveRefresh();
  }});
}
/* probe a vault media file's duration via a throwaway media element */
function mveProbeDuration(fileId, cb) {
  const el = document.createElement('video');
  el.preload = 'metadata'; el.muted = true;
  el.onloadedmetadata = () => { cb(el.duration || 0); el.src = ''; };
  el.onerror = () => cb(0);
  el.src = '/api/files/' + fileId + '/raw';
}
function mvePlayheadOrEnd() { return _mve.playhead || 0; }

/* hidden <audio> per unique fileId used across clips, for preview mixing */
function mveRebuildClipAudios() {
  if (!_mve) return;
  const needed = new Set(mveAllClips().filter(({ clip }) => clip.kind === 'audio').map(({ clip }) => clip.fileId));
  // drop unused
  for (const id of Object.keys(_mve.clipAudios)) { if (!needed.has(id)) { try { _mve.clipAudios[id].pause(); _mve.clipAudios[id].remove(); } catch (e) {} delete _mve.clipAudios[id]; } }
  // add missing
  needed.forEach(id => {
    if (_mve.clipAudios[id]) return;
    const a = document.createElement('audio');
    a.src = '/api/files/' + id + '/raw'; a.preload = 'auto';
    const host = document.getElementById('mve'); if (host) host.appendChild(a);
    _mve.clipAudios[id] = a;
  });
}

/* ---- overlays (preview) ---- */
function mveRenderOverlays() {
  const layer = document.getElementById('mveOverlayLayer'); if (!layer) return;
  layer.innerHTML = (_mve.project.overlays || []).map((ov, i) => {
    const posClass = 'mvp-' + (ov.pos || 'bc');
    return `<div class="mve-ov ${posClass}" data-ov="${i}" style="--mve-ov-size:${Math.round((ov.size || 36) / 10)}px;color:${esc(ov.color || '#ffffff')}">${esc(ov.text || '')}</div>`;
  }).join('');
  mveUpdateOverlayVisibility(mveVideoEl().currentTime || 0);
}
function mveUpdateOverlayVisibility(t) {
  const layer = document.getElementById('mveOverlayLayer'); if (!layer || !_mve) return;
  layer.querySelectorAll('[data-ov]').forEach(el => {
    const ov = _mve.project.overlays[+el.dataset.ov]; if (!ov) return;
    const on = t >= (ov.start || 0) && t <= (ov.end == null ? 1e9 : ov.end);
    el.style.opacity = on ? '1' : '0.12';
  });
}

/* ---- reusable drag engine (the v1 bug was re-rendering mid-drag, which
   destroyed the element being dragged). Here pointer events go on window, we
   mutate inline styles live, and only re-render on pointerup. ---- */
function mveBeginDrag(e, onMove, onEnd) {
  e.preventDefault();
  const startX = e.clientX, startY = e.clientY;
  _mve.drag = true;
  const move = (ev) => { onMove(ev.clientX - startX, ev.clientY - startY, ev); };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    _mve.drag = false;
    if (onEnd) onEnd(ev.clientX - startX, ev.clientY - startY, ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
function mveSnapTime(t, exceptClipId) {
  if (!_mve.snap) return t;
  const targets = [0, _mve.playhead];
  mveAllClips().forEach(({ clip }) => { if (clip.id === exceptClipId) return; targets.push(clip.start, mveClipEnd(clip)); });
  const px = 7 / _mve.pps;   // ~7px snap radius in seconds
  let best = t, bestD = px;
  for (const tg of targets) { const d = Math.abs(tg - t); if (d < bestD) { bestD = d; best = tg; } }
  return best;
}

/* ---- timeline bar (toolbar above the tracks) ---- */
function mveRenderTimelineBar() {
  const el = document.getElementById('mveTlbar'); if (!el) return;
  el.innerHTML = `
    <button class="btn primary sm" id="mveAddMedia">${svg('plus', 13)} Add media</button>
    <button class="btn ghost sm" id="mveSplit" title="Split selected clip at the playhead">${svg('cut', 13)} Split</button>
    <button class="btn ghost sm" id="mveAddText">${svg('rename', 13)} Add text</button>
    <button class="btn ghost sm" id="mveAddVTrack" title="Add video track">+V</button>
    <button class="btn ghost sm" id="mveAddATrack" title="Add audio track">+A</button>
    <div class="spacer"></div>
    <button class="mve-snap${_mve.snap ? ' on' : ''}" id="mveSnap" title="Snapping">${svg('checksq', 13)} Snap</button>
    <button class="btn ghost sm" id="mveZoomOut" title="Zoom out">${svg('minus', 13)}</button>
    <button class="btn ghost sm" id="mveZoomFit" title="Fit">${svg('zoomfit', 13)}</button>
    <button class="btn ghost sm" id="mveZoomIn" title="Zoom in">${svg('plus', 13)}</button>`;
  el.querySelector('#mveAddMedia').onclick = mveAddMedia;
  el.querySelector('#mveSplit').onclick = mveSplitAtPlayhead;
  el.querySelector('#mveAddText').onclick = mveAddTextOverlay;
  el.querySelector('#mveAddVTrack').onclick = () => mveAddTrack('video');
  el.querySelector('#mveAddATrack').onclick = () => mveAddTrack('audio');
  el.querySelector('#mveSnap').onclick = () => { _mve.snap = !_mve.snap; mveRenderTimelineBar(); };
  el.querySelector('#mveZoomOut').onclick = () => { _mve.pps = Math.max(12, _mve.pps / 1.4); mveRenderTimeline(); };
  el.querySelector('#mveZoomIn').onclick = () => { _mve.pps = Math.min(400, _mve.pps * 1.4); mveRenderTimeline(); };
  el.querySelector('#mveZoomFit').onclick = mveZoomFit;
}
function mveZoomFit() {
  const dur = Math.max(1, mveComputeDuration());
  const lane = document.querySelector('.mve-lanes');
  const w = (lane ? lane.clientWidth : 700) - 24;
  _mve.pps = Math.max(12, Math.min(400, w / dur));
  mveRenderTimeline();
}

/* ---- the multi-track timeline ---- */
function mveRenderTimeline() {
  const el = document.getElementById('mveTimeline'); if (!el) return;
  const dur = Math.max(mveComputeDuration(), 1);
  const pps = _mve.pps;
  const totalW = Math.max(dur * pps + 40, 200);
  const sel = _mve.sel || {};

  // time ruler ticks (~every 80px)
  const stepSec = mveTickStep(pps);
  let ticks = '';
  for (let s = 0; s <= dur + stepSec; s += stepSec) ticks += `<span class="mve-tick" style="left:${s * pps}px"><i></i><b>${fmtDur(s)}</b></span>`;

  const trackRow = (tr) => {
    const clips = tr.clips.map(c => mveClipHTML(tr, c, sel)).join('');
    const muted = tr.muted ? ' muted' : '', hidden = tr.kind === 'video' && tr.hidden ? ' hidden-tr' : '';
    return `<div class="mve-trow ${tr.kind}${muted}${hidden}" data-track="${tr.id}">
      <div class="mve-thead">
        <span class="mve-tname mono">${esc(tr.name)}</span>
        <div class="mve-tctrls">
          <button class="mve-tbtn${tr.muted ? ' on' : ''}" data-mute="${tr.id}" title="Mute">${svg(tr.muted ? 'volmute' : 'vol', 12)}</button>
          ${tr.kind === 'video' ? `<button class="mve-tbtn${tr.hidden ? ' on' : ''}" data-hide="${tr.id}" title="Hide">${svg('eye', 12)}</button>` : ''}
          <button class="mve-tbtn mve-solo-locked" data-solo="${tr.id}" title="Solo — coming soon">S</button>
          <button class="mve-tbtn" data-deltrack="${tr.id}" title="Delete track">${svg('trash', 12)}</button>
        </div>
      </div>
      <div class="mve-lane" data-lane="${tr.id}" style="width:${totalW}px">${clips}</div>
    </div>`;
  };

  el.innerHTML = `
    <div class="mve-lanes" id="mveLanes">
      <div class="mve-ruler-row">
        <div class="mve-thead mve-ruler-head"></div>
        <div class="mve-ruler" id="mveRuler" style="width:${totalW}px">${ticks}<span class="mve-playline" id="mvePlayline" style="left:${_mve.playhead * pps}px"></span></div>
      </div>
      <div class="mve-trows">${_mve.project.tracks.map(trackRow).join('')}
        <div class="mve-playoverlay" id="mvePlayOverlay" style="left:${_mve.playhead * pps}px"></div>
      </div>
    </div>`;

  // playhead scrub (click/drag on the ruler)
  const ruler = document.getElementById('mveRuler');
  ruler.onpointerdown = (e) => {
    const r = ruler.getBoundingClientRect();
    const set = (cx) => mveSetPlayhead(Math.max(0, (cx - r.left) / pps));
    set(e.clientX);
    mveBeginDrag(e, (dx, dy, ev) => set(ev.clientX));
  };

  // wire track header controls
  el.querySelectorAll('[data-mute]').forEach(b => b.onclick = (e) => { e.stopPropagation(); const tr = _mve.project.tracks.find(t => t.id === b.dataset.mute); tr.muted = !tr.muted; mveMarkDirty(); mveRenderTimeline(); mveCompositeAt(_mve.playhead); });
  el.querySelectorAll('[data-hide]').forEach(b => b.onclick = (e) => { e.stopPropagation(); const tr = _mve.project.tracks.find(t => t.id === b.dataset.hide); tr.hidden = !tr.hidden; mveMarkDirty(); mveRenderTimeline(); mveCompositeAt(_mve.playhead); });
  el.querySelectorAll('[data-solo]').forEach(b => b.onclick = (e) => { e.stopPropagation(); toast('Solo is coming soon', 'info'); });
  el.querySelectorAll('[data-deltrack]').forEach(b => b.onclick = (e) => { e.stopPropagation(); mveDeleteTrack(b.dataset.deltrack); });

  // wire each clip (select + drag move + trim handles)
  el.querySelectorAll('[data-clip]').forEach(node => mveWireClip(node));
}

function mveTickStep(pps) {
  const targetPx = 90;
  const raw = targetPx / pps;   // seconds per ~90px
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if (s >= raw) return s;
  return 600;
}

function mveClipHTML(tr, c, sel) {
  const pps = _mve.pps;
  const left = (c.start || 0) * pps, w = Math.max(8, ((c.out || 0) - (c.in || 0)) * pps);
  const on = sel.kind === 'clip' && sel.id === c.id;
  const linked = c.linkId ? ' linked' : '';
  const kfDots = (c.kind === 'audio' || tr.kind === 'audio') && c.volumeKfs && c.volumeKfs.length
    ? `<div class="mve-kflane">${c.volumeKfs.map(k => `<span class="mve-kfdot" style="left:${(k.t / Math.max(0.001, (c.out - c.in))) * 100}%"></span>`).join('')}</div>` : '';
  const label = esc((c.name || tr.kind).replace(/\.[^.]+$/, '').slice(0, 26));
  // fade wedges: width = fade seconds as a fraction of the clip's played length
  const len = Math.max(0.001, (c.out - c.in));
  const fadeIn = (c.fadeIn || 0) > 0 ? `<span class="mve-fade in" style="width:${Math.min(100, (c.fadeIn / len) * 100).toFixed(1)}%"></span>` : '';
  const fadeOut = (c.fadeOut || 0) > 0 ? `<span class="mve-fade out" style="width:${Math.min(100, (c.fadeOut / len) * 100).toFixed(1)}%"></span>` : '';
  return `<div class="mve-clip ${tr.kind}${on ? ' on' : ''}${linked}${c.mute ? ' cmute' : ''}" data-clip="${c.id}" style="left:${left}px;width:${w}px">
    <span class="mve-clip-handle l" data-trim="l"></span>
    ${fadeIn}${fadeOut}
    <span class="mve-clip-body">${svg(tr.kind === 'video' ? 'video' : 'audio', 12)} <span class="mve-clip-name">${label}</span></span>
    ${kfDots}
    <span class="mve-clip-handle r" data-trim="r"></span>
  </div>`;
}

function mveWireClip(node) {
  const id = node.dataset.clip;
  const found = mveFindClip(id); if (!found) return;
  const { track, clip } = found;
  const pps = _mve.pps;
  const selectThis = () => { _mve.sel = { kind: 'clip', id }; mveRenderInspector(); mveRenderTimeline(); };

  // body: move along the timeline (and the linked partner moves too)
  const body = node.querySelector('.mve-clip-body');
  body.onpointerdown = (e) => {
    e.stopPropagation(); selectThis();
    const startPos = clip.start || 0;
    const partner = clip.linkId ? mveFindClip(clip.linkId) : null;
    const partnerStart = partner ? partner.clip.start : 0;
    mveBeginDrag(e, (dx) => {
      let ns = Math.max(0, startPos + dx / pps);
      ns = mveSnapTime(ns, id);
      const delta = ns - startPos;
      clip.start = ns;
      node.style.left = (ns * pps) + 'px';
      if (partner) { partner.clip.start = Math.max(0, partnerStart + delta); }
    }, () => { mveMarkDirty(); mveRefresh(); });
  };

  // left/right trim handles
  node.querySelectorAll('[data-trim]').forEach(h => {
    h.onpointerdown = (e) => {
      e.stopPropagation(); selectThis();
      const side = h.dataset.trim;
      const startIn = clip.in, startOut = clip.out, startPos = clip.start;
      const partner = clip.linkId ? mveFindClip(clip.linkId) : null;
      mveBeginDrag(e, (dx) => {
        const dt = dx / pps;
        if (side === 'l') {
          let ni = Math.min(startOut - 0.1, Math.max(0, startIn + dt));
          const moved = ni - startIn;
          clip.in = ni; clip.start = Math.max(0, startPos + moved);
          if (partner) { partner.clip.in = ni; partner.clip.start = clip.start; }
        } else {
          let no = Math.max(startIn + 0.1, startOut + dt);
          if (clip.srcDur) no = Math.min(no, clip.srcDur);
          clip.out = no;
          if (partner) partner.clip.out = no;
        }
        node.style.left = (clip.start * pps) + 'px';
        node.style.width = Math.max(8, (clip.out - clip.in) * pps) + 'px';
      }, () => { mveMarkDirty(); mveRefresh(); });
    };
  });
}

/* ---- track + clip edit actions ---- */
function mveAddTrack(kind) {
  const same = _mve.project.tracks.filter(t => t.kind === kind).length;
  const name = (kind === 'video' ? 'V' : 'A') + (same + 1);
  // keep ordering: video tracks first, then audio
  const tr = { id: mveId('t'), kind, name, muted: false, hidden: false, clips: [] };
  if (kind === 'video') { const idx = _mve.project.tracks.findIndex(t => t.kind === 'audio'); _mve.project.tracks.splice(idx < 0 ? _mve.project.tracks.length : idx, 0, tr); }
  else _mve.project.tracks.push(tr);
  mveMarkDirty(); mveRenderTimeline();
}
function mveDeleteTrack(tid) {
  const tr = _mve.project.tracks.find(t => t.id === tid); if (!tr) return;
  const kindCount = _mve.project.tracks.filter(t => t.kind === tr.kind).length;
  if (kindCount <= 1) return toast('Keep at least one ' + tr.kind + ' track', 'info');
  const doDel = () => { _mve.project.tracks = _mve.project.tracks.filter(t => t.id !== tid); if (_mve.sel && _mve.sel.kind === 'clip' && !mveFindClip(_mve.sel.id)) _mve.sel = null; mveMarkDirty(); mveRefresh(); };
  if (tr.clips.length) confirmModal('Delete track?', `“${tr.name}” has ${tr.clips.length} clip(s). This removes the track and its clips.`, doDel, 'Delete');
  else doDel();
}
function mveSplitAtPlayhead() {
  const sel = _mve.sel;
  const t = _mve.playhead;
  let target = null;
  if (sel && sel.kind === 'clip') { const f = mveFindClip(sel.id); if (f && t > f.clip.start && t < mveClipEnd(f.clip)) target = f; }
  if (!target) { // fall back: any clip under the playhead (topmost)
    const hits = mveAllClips().filter(({ clip }) => t > clip.start && t < mveClipEnd(clip));
    target = hits[hits.length - 1] || null;
  }
  if (!target) return toast('Put the playhead over a clip to split it', 'info');
  mveSplitClip(target.track, target.clip, t);
}
function mveSplitClip(track, clip, t) {
  const localCut = clip.in + (t - clip.start);   // source time of the cut
  if (localCut <= clip.in + 0.02 || localCut >= clip.out - 0.02) return;
  const right = JSON.parse(JSON.stringify(clip));
  right.id = mveId('c');
  right.in = localCut; right.start = t; right.linkId = null;
  // shift keyframes of the right half to be clip-local
  const off = localCut - clip.in;
  right.volumeKfs = (clip.volumeKfs || []).filter(k => k.t >= off).map(k => ({ ...k, t: k.t - off }));
  right.pitchKfs = (clip.pitchKfs || []).filter(k => k.t >= off).map(k => ({ ...k, t: k.t - off }));
  clip.out = localCut;
  clip.volumeKfs = (clip.volumeKfs || []).filter(k => k.t < off);
  clip.pitchKfs = (clip.pitchKfs || []).filter(k => k.t < off);
  clip.linkId = null;   // splitting breaks the A/V link on the split clip
  // fades belong to the outer edges: left half keeps fadeIn, right half keeps fadeOut.
  right.fadeIn = 0; clip.fadeOut = 0;
  track.clips.push(right);
  mveMarkDirty(); mveRefresh();
  toast('Clip split', 'check');
}
/* Duplicate a clip: an identical copy placed right after it on the same track. */
function mveDuplicateClip(id) {
  const found = mveFindClip(id); if (!found) return;
  const { track, clip } = found;
  const copy = JSON.parse(JSON.stringify(clip));
  copy.id = mveId('c');
  copy.start = mveClipEnd(clip);   // butt it up right after the original
  copy.linkId = null;              // the copy is independent (no A/V link)
  track.clips.push(copy);
  _mve.sel = { kind: 'clip', id: copy.id };
  mveMarkDirty(); mveRefresh();
  toast('Clip duplicated', 'check');
}

/* ---- edit actions ---- */
function mveAddTextOverlay() {
  if (!mveAllClips().length) return toast('Add a video first', 'info');
  const t = _mve.playhead || 0, dur = Math.max(mveComputeDuration(), t + 3);
  _mve.project.overlays.push({ text: 'New text', start: t, end: Math.min(dur, t + 3), pos: 'bc', size: 36, color: '#ffffff' });
  _mve.sel = { kind: 'overlay', i: _mve.project.overlays.length - 1 };
  mveMarkDirty(); mveRefresh();
}

/* ---- locked / coming-soon badge (used over not-yet-finished controls) ---- */
function mveLockedBadge(label) {
  return `<span class="mve-locked" title="${esc(label)} — coming soon">${svg('lock', 11)} ${esc(label)}</span>`;
}

/* ---- inspector (context panel for the current selection) ---- */
function mveRenderInspector() {
  const el = document.getElementById('mveInspector'); if (!el) return;
  const sel = _mve.sel || {};
  if (!mveAllClips().length) { el.innerHTML = `<div class="mve-insp-empty dim mono">Empty project. Use <b>Add media</b> on the timeline to drop a video or audio clip from your vault.</div>`; return; }
  if (sel.kind === 'overlay') return mveInspectOverlay(el, sel.i);
  if (sel.kind === 'clip') { const f = mveFindClip(sel.id); if (f) return mveInspectClip(el, f.track, f.clip); }
  return mveInspectProject(el);
}

function mveField(label, inner) { return `<label class="mve-field"><span class="eyebrow">${esc(label)}</span>${inner}</label>`; }

function mveInspectProject(el) {
  const p = _mve.project;
  el.innerHTML = `<div class="mve-insp-title">${svg('video', 15)} Project</div>
    <div class="mve-insp-name mono">${mveAllClips().length} clip(s) · ${fmtDur(mveComputeDuration())}</div>
    <div class="mve-2col">
      ${mveField('Width', `<input type="number" class="mve-input" id="mveCW" step="2" min="16" value="${p.w}">`)}
      ${mveField('Height', `<input type="number" class="mve-input" id="mveCH" step="2" min="16" value="${p.h}">`)}
    </div>
    ${mveField('FPS', `<input type="number" class="mve-input" id="mveFPS" step="1" min="1" max="60" value="${p.fps}">`)}
    <div class="mve-insp-hint dim mono">Select a clip on the timeline to edit its trim, volume, pitch & keyframes.</div>`;
  el.querySelector('#mveCW').onchange = (e) => { p.w = Math.max(16, parseInt(e.target.value) || 1280); mveMarkDirty(); };
  el.querySelector('#mveCH').onchange = (e) => { p.h = Math.max(16, parseInt(e.target.value) || 720); mveMarkDirty(); };
  el.querySelector('#mveFPS').onchange = (e) => { p.fps = Math.min(60, Math.max(1, parseInt(e.target.value) || 30)); mveMarkDirty(); };
}

function mveInspectClip(el, track, c) {
  const isVid = track.kind === 'video';
  const linked = c.linkId && mveFindClip(c.linkId);
  el.innerHTML = `<div class="mve-insp-title">${svg(isVid ? 'video' : 'audio', 15)} ${isVid ? 'Video' : 'Audio'} clip ${linked ? '<span class="mve-linkpill" title="Linked to its '+(isVid?'audio':'video')+'">link</span>' : ''}</div>
    <div class="mve-insp-name mono">${esc(c.name)}</div>
    ${mveField('Position on timeline (s)', `<input type="number" class="mve-input" id="mveCStart" step="0.1" min="0" value="${(c.start || 0).toFixed(2)}">`)}
    <div class="mve-2col">
      ${mveField('Trim in (s)', `<input type="number" class="mve-input" id="mveCIn" step="0.1" min="0" value="${(c.in || 0).toFixed(2)}">`)}
      ${mveField('Trim out (s)', `<input type="number" class="mve-input" id="mveCOut" step="0.1" min="0" value="${(c.out || 0).toFixed(2)}">`)}
    </div>
    <div class="mve-2col">
      ${mveField(`Fade in (s)`, `<input type="number" class="mve-input" id="mveCFadeIn" step="0.1" min="0" value="${(c.fadeIn || 0).toFixed(1)}">`)}
      ${mveField(`Fade out (s)`, `<input type="number" class="mve-input" id="mveCFadeOut" step="0.1" min="0" value="${(c.fadeOut || 0).toFixed(1)}">`)}
    </div>
    <div class="mve-insp-hint dim mono">${isVid ? 'Fades the picture (and its audio) at the clip edges.' : 'Fades the sound at the clip edges.'}</div>
    <label class="mve-check"><input type="checkbox" id="mveCMute" ${c.mute ? 'checked' : ''}> Mute this clip's audio</label>
    ${mveKfEditorHTML('Volume', 'vol', c.volumeKfs, c.volume ?? 1, c)}
    ${mveKfEditorHTML('Pitch', 'pit', c.pitchKfs, c.pitch || 0, c)}
    <div class="mve-clip-acts">
      <button class="btn ghost sm" id="mveCDup" title="Duplicate clip (Ctrl+D)">${svg('copy', 13)} Duplicate</button>
      ${linked ? `<button class="btn ghost sm" id="mveUnlink">${svg('link', 13)} Unlink A/V</button>` : ''}
      <button class="btn danger sm mve-del" id="mveCDel">${svg('trash', 13)} Delete clip</button>
    </div>`;
  el.querySelector('#mveCStart').onchange = (e) => { const ns = Math.max(0, parseFloat(e.target.value) || 0); const d = ns - c.start; c.start = ns; if (linked) linked.clip.start = Math.max(0, linked.clip.start + d); mveMarkDirty(); mveRefresh(); };
  el.querySelector('#mveCIn').onchange = (e) => { c.in = Math.max(0, Math.min(parseFloat(e.target.value) || 0, c.out - 0.1)); if (linked) linked.clip.in = c.in; mveMarkDirty(); mveRefresh(); };
  el.querySelector('#mveCOut').onchange = (e) => { c.out = Math.max(c.in + 0.1, parseFloat(e.target.value) || 0); if (c.srcDur) c.out = Math.min(c.out, c.srcDur); if (linked) linked.clip.out = c.out; mveMarkDirty(); mveRefresh(); };
  el.querySelector('#mveCMute').onchange = (e) => { c.mute = e.target.checked; mveMarkDirty(); mveRenderTimeline(); };
  const clampFade = (v) => Math.max(0, Math.min(mveClipLen(c), parseFloat(v) || 0));
  el.querySelector('#mveCFadeIn').onchange = (e) => { c.fadeIn = clampFade(e.target.value); if (linked) linked.clip.fadeIn = c.fadeIn; mveMarkDirty(); mveRenderInspector(); mveRenderTimeline(); mveCompositeAt(_mve.playhead); };
  el.querySelector('#mveCFadeOut').onchange = (e) => { c.fadeOut = clampFade(e.target.value); if (linked) linked.clip.fadeOut = c.fadeOut; mveMarkDirty(); mveRenderInspector(); mveRenderTimeline(); mveCompositeAt(_mve.playhead); };
  const dup = el.querySelector('#mveCDup'); if (dup) dup.onclick = () => mveDuplicateClip(c.id);
  const unlink = el.querySelector('#mveUnlink'); if (unlink) unlink.onclick = () => { if (linked) linked.clip.linkId = null; c.linkId = null; mveMarkDirty(); mveRenderInspector(); mveRenderTimeline(); toast('Audio unlinked — edit it independently', 'check'); };
  el.querySelector('#mveCDel').onclick = () => {
    track.clips = track.clips.filter(x => x.id !== c.id);
    if (linked) { const lt = _mve.project.tracks.find(t => t.clips.includes(linked.clip)); /* keep partner but unlink */ linked.clip.linkId = null; }
    _mve.sel = null; mveMarkDirty(); mveRefresh();
  };
  mveWireKfEditor(el, 'vol', c, 'volumeKfs', { min: 0, max: 2, dflt: c.volume ?? 1, fmt: v => Math.round(v * 100) + '%', toVal: p0to1 => p0to1 * 2 });
  mveWireKfEditor(el, 'pit', c, 'pitchKfs', { min: -12, max: 12, dflt: c.pitch || 0, fmt: v => (v > 0 ? '+' : '') + v.toFixed(1), toVal: p0to1 => (p0to1 * 24) - 12 });
}

/* keyframe editor: a small draggable graph + curve chips. `kind` = 'vol'|'pit'. */
function mveKfEditorHTML(label, kind, kfs, base, c) {
  const has = kfs && kfs.length;
  return `<div class="mve-kf" data-kf="${kind}">
    <div class="mve-kf-head"><span class="eyebrow">${esc(label)}${kind === 'pit' ? ' (semitones)' : ''}</span>
      <span class="mve-kf-cur mono" id="mveKfCur_${kind}"></span>
      <div class="spacer"></div>
      <button class="mve-kf-btn" data-kfadd="${kind}" title="Add keyframe at playhead">${svg('plus', 12)}</button>
      ${has ? `<button class="mve-kf-btn" data-kfclear="${kind}" title="Clear keyframes">${svg('trash', 12)}</button>` : ''}
    </div>
    ${!has ? `<div class="mve-rangerow"><input type="range" class="mve-kf-base" data-kfbase="${kind}" min="0" max="100" value="${kind === 'vol' ? Math.round((base) * 50) : Math.round(((base) + 12) / 24 * 100)}"><span class="mve-rval mono" id="mveKfBaseV_${kind}"></span></div>` : ''}
    <div class="mve-kf-graph${has ? '' : ' flat'}" data-kfgraph="${kind}"><svg viewBox="0 0 100 40" preserveAspectRatio="none" class="mve-kf-svg" id="mveKfSvg_${kind}"></svg></div>
    ${has ? `<div class="mve-kf-curverow"><span class="eyebrow">curve</span>${MVE_CURVES.map(cv => `<button class="mve-curvechip" data-kfcurve="${kind}:${cv}">${cv}</button>`).join('')}</div>` : ''}
  </div>`;
}

function mveWireKfEditor(root, kind, clip, field, opt) {
  const graph = root.querySelector(`[data-kfgraph="${kind}"]`);
  const svg = root.querySelector(`#mveKfSvg_${kind}`);
  const dur = Math.max(0.001, clip.out - clip.in);
  const kfs = clip[field];
  const yFor = (v) => 40 - ((v - opt.min) / (opt.max - opt.min)) * 40;
  const vFor = (y) => opt.min + (1 - y / 40) * (opt.max - opt.min);
  const xFor = (t) => (t / dur) * 100;
  const tFor = (x) => (x / 100) * dur;

  const draw = () => {
    const pts = [...kfs].sort((a, b) => a.t - b.t);
    let path = '', dots = '';
    if (pts.length) {
      // sample the curve for a smooth polyline
      const N = 60; let d = '';
      for (let i = 0; i <= N; i++) { const t = (i / N) * dur; const v = mveKfValue(pts, t, opt.dflt); d += (i ? 'L' : 'M') + xFor(t).toFixed(1) + ',' + yFor(v).toFixed(1) + ' '; }
      path = `<path d="${d}" class="mve-kf-path"/>`;
      dots = pts.map((k, i) => `<circle cx="${xFor(k.t).toFixed(1)}" cy="${yFor(k.v).toFixed(1)}" r="2.4" class="mve-kf-pt" data-kfi="${i}"/>`).join('');
    } else {
      const y = yFor(opt.dflt); path = `<line x1="0" y1="${y.toFixed(1)}" x2="100" y2="${y.toFixed(1)}" class="mve-kf-path flat"/>`;
    }
    svg.innerHTML = path + dots;
    svg.querySelectorAll('.mve-kf-pt').forEach(pt => {
      pt.onpointerdown = (e) => {
        e.stopPropagation();
        const i = +pt.dataset.kfi; const k = [...kfs].sort((a, b) => a.t - b.t)[i];
        const r = graph.getBoundingClientRect();
        mveBeginDrag(e, (dx, dy, ev) => {
          const x = Math.min(100, Math.max(0, ((ev.clientX - r.left) / r.width) * 100));
          const y = Math.min(40, Math.max(0, ((ev.clientY - r.top) / r.height) * 40));
          k.t = Math.min(dur, Math.max(0, tFor(x))); k.v = vFor(y);
          draw();
        }, () => { mveMarkDirty(); mveRenderTimeline(); });
      };
      pt.oncontextmenu = (e) => { e.preventDefault(); const i = +pt.dataset.kfi; const sorted = [...kfs].sort((a, b) => a.t - b.t); const k = sorted[i]; const idx = kfs.indexOf(k); if (idx >= 0) kfs.splice(idx, 1); if (!kfs.length) { mveMarkDirty(); mveRenderInspector(); } else draw(); mveMarkDirty(); mveRenderTimeline(); };
    });
  };
  // click empty graph area -> add a keyframe there
  if (graph) graph.onpointerdown = (e) => {
    if (e.target.classList.contains('mve-kf-pt')) return;
    const r = graph.getBoundingClientRect();
    const x = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100));
    const y = Math.min(40, Math.max(0, ((e.clientY - r.top) / r.height) * 40));
    kfs.push({ t: tFor(x), v: vFor(y), curve: 'linear' });
    mveMarkDirty(); mveRenderInspector(); mveRenderTimeline();
  };
  draw();

  // base slider (when no keyframes) sets the constant value
  const baseSl = root.querySelector(`[data-kfbase="${kind}"]`);
  const baseV = root.querySelector(`#mveKfBaseV_${kind}`);
  if (baseSl) {
    const setLabel = () => { baseV.textContent = opt.fmt(opt.dflt); };
    setLabel();
    baseSl.oninput = () => { const v = opt.toVal((+baseSl.value) / 100); if (field === 'volumeKfs') clip.volume = v; else clip.pitch = v; opt.dflt = v; setLabel(); mveMarkDirty(); };
  }
  // add-at-playhead, clear, curve chips
  const addBtn = root.querySelector(`[data-kfadd="${kind}"]`);
  if (addBtn) addBtn.onclick = () => { const t = Math.min(dur, Math.max(0, _mve.playhead - clip.start)); const v = mveKfValue([...kfs], t, opt.dflt); kfs.push({ t, v, curve: 'linear' }); mveMarkDirty(); mveRenderInspector(); mveRenderTimeline(); };
  const clrBtn = root.querySelector(`[data-kfclear="${kind}"]`);
  if (clrBtn) clrBtn.onclick = () => { clip[field] = []; mveMarkDirty(); mveRenderInspector(); mveRenderTimeline(); };
  root.querySelectorAll(`[data-kfcurve^="${kind}:"]`).forEach(b => b.onclick = () => {
    const cv = b.dataset.kfcurve.split(':')[1];
    kfs.forEach(k => k.curve = cv);
    mveMarkDirty(); mveRenderInspector(); mveRenderTimeline();
  });
}

function mveInspectOverlay(el, i) {
  const ov = _mve.project.overlays[i]; if (!ov) { _mve.sel = null; return mveRenderInspector(); }
  el.innerHTML = `<div class="mve-insp-title">${svg('rename', 15)} Text overlay</div>
    ${mveField('Text', `<input type="text" class="mve-input" id="mveOvText" value="${esc(ov.text || '')}">`)}
    <div class="mve-2col">
      ${mveField('Start (s)', `<input type="number" class="mve-input" id="mveOvStart" step="0.1" min="0" value="${(ov.start || 0).toFixed(2)}">`)}
      ${mveField('End (s)', `<input type="number" class="mve-input" id="mveOvEnd" step="0.1" min="0" value="${(ov.end || 0).toFixed(2)}">`)}
    </div>
    <div class="mve-2col">
      ${mveField('Size', `<input type="number" class="mve-input" id="mveOvSize" step="1" min="8" max="200" value="${ov.size || 36}">`)}
      ${mveField('Color', `<input type="color" class="mve-color" id="mveOvColor" value="${esc(ov.color || '#ffffff')}">`)}
    </div>
    ${mveField('Position', `<div class="mve-grid9" id="mveOvPos">${MVE_POS_OPTS.map(([k, g]) => `<button type="button" class="${ov.pos === k ? 'on' : ''}" data-pos="${k}">${g}</button>`).join('')}</div>`)}
    <button class="btn danger sm mve-del" id="mveOvDel">${svg('trash', 13)} Delete overlay</button>`;
  const upd = () => { mveMarkDirty(); mveRenderOverlays(); mveRenderTimeline(); };
  el.querySelector('#mveOvText').oninput = (e) => { ov.text = e.target.value; upd(); };
  el.querySelector('#mveOvStart').onchange = (e) => { ov.start = Math.max(0, parseFloat(e.target.value) || 0); upd(); };
  el.querySelector('#mveOvEnd').onchange = (e) => { ov.end = Math.max(ov.start + 0.1, parseFloat(e.target.value) || 0); upd(); };
  el.querySelector('#mveOvSize').onchange = (e) => { ov.size = Math.min(200, Math.max(8, parseInt(e.target.value) || 36)); upd(); };
  el.querySelector('#mveOvColor').oninput = (e) => { ov.color = e.target.value; upd(); };
  el.querySelectorAll('#mveOvPos [data-pos]').forEach(b => b.onclick = () => { ov.pos = b.dataset.pos; mveRenderInspector(); upd(); });
  el.querySelector('#mveOvDel').onclick = () => { _mve.project.overlays.splice(i, 1); _mve.sel = null; mveMarkDirty(); mveRefresh(); };
}

/* ---- project name / save / open ---- */
async function mveRenameProject() {
  const name = await mvePromptModal({ title: 'Project name', label: 'Name', value: _mve.project.name || '', okLabel: 'Rename' });
  if (name) { _mve.project.name = name; mveMarkDirty(); mveRefresh(); }
}

async function mveSaveProject(silent) {
  if (!_mve) return;
  if (!_mve.project.name) { const n = await mvePromptModal({ title: 'Name your project', label: 'Project name', value: 'Untitled edit', okLabel: 'Save' }); if (!n) return; _mve.project.name = n; }
  const content = JSON.stringify(_mve.project, null, 2);
  const fileName = _mve.project.name.replace(/[^\w.\- ]+/g, '_') + MVE_EXT;
  try {
    if (_mve.docId) { await saveDocContent(_mve.docId, content); }
    else { const rec = await createDoc({ name: fileName, content, lang: 'json' }); _mve.docId = rec.id; }
    _mve.dirty = false;
    const s = document.getElementById('mveSaved'); if (s) s.textContent = 'saved · ' + new Date().toLocaleTimeString();
    if (!silent) toast('Project saved to your vault', 'check');
  } catch (e) { toast(e.message || 'Could not save project', 'close'); }
}

function mveOpenProject() {
  mvePickDoc(MVE_EXT, async (f) => {
    try {
      const { text } = await fetchDocText(f, {});
      let proj = JSON.parse(text);
      if (!proj || !proj.v) return toast('Not a Mini Video Editor project', 'close');
      if (proj.v === 1) proj = mveMigrateV1(proj);
      else if (proj.v !== 2) return toast('Unsupported project version', 'close');
      mveLoadProject(proj, f.id);
    } catch (e) { toast('Could not open that project', 'close'); }
  });
}

function mveLoadProject(proj, docId) {
  mvePreviewStop();
  _mve.project = proj;
  _mve.docId = docId || null;
  _mve.dirty = false;
  _mve.sel = null;
  _mve.playhead = 0;
  _mve.curVideoFile = null;
  mveRefresh();
  mveZoomFit();
  const s = document.getElementById('mveSaved'); if (s) s.textContent = 'opened';
  toast('Project loaded', 'check');
}

/* doc picker filtered to a name suffix (e.g. .mve.json) */
async function mvePickDoc(suffix, onPick) {
  try { await ensureAiDB(); } catch (e) { toast('Could not load your files', 'close'); return; }
  const all = DB.files.filter(f => !f.trashed && f.type !== 'folder' && f.name && f.name.toLowerCase().endsWith(suffix));
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal picker-modal">
    <h3>Open a project</h3>
    <p>Pick a saved <span class="mono">${esc(suffix)}</span> project from your vault.</p>
    <input type="text" class="picker-search" id="pkSearch" placeholder="Search projects…">
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
    if (!items.length) { listEl.innerHTML = `<div class="picker-empty dim mono">${all.length ? 'No matches.' : 'No saved projects yet — save one first.'}</div>`; return; }
    listEl.innerHTML = items.map(f => `<button class="picker-item" data-id="${f.id}"><span class="pi-ic t-document">${svg('document', 16)}</span><span class="pi-main"><span class="pi-name">${esc(f.name)}</span><span class="pi-sub mono">${esc(aiPathOf(f))}</span></span></button>`).join('');
    listEl.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { const f = all.find(x => x.id === b.dataset.id); close(); onPick(f); });
  };
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  const search = bg.querySelector('#pkSearch'); search.oninput = () => render(search.value.trim());
  render(''); search.focus();
}

/* ============================================================
   PREVIEW COMPOSITOR — playhead-driven, best-effort. The single <video> shows
   the top-most active video clip; hidden <audio> els play active audio clips with
   keyframed volume. Authoritative render is the server export.
   ============================================================ */
function mveTopVideoClipAt(t) {
  // last (top-most) video track wins; within a track, the clip covering t
  let hit = null;
  _mve.project.tracks.forEach(tr => {
    if (tr.kind !== 'video' || tr.hidden) return;
    tr.clips.forEach(c => { if (t >= c.start && t < mveClipEnd(c)) hit = c; });
  });
  return hit;
}
function mveActiveAudioClipsAt(t) {
  const out = [];
  _mve.project.tracks.forEach(tr => {
    if (tr.kind === 'audio' && tr.muted) return;
    if (tr.kind === 'video' && tr.hidden) return;
    tr.clips.forEach(c => { if (!c.mute && t >= c.start && t < mveClipEnd(c)) out.push(c); });
  });
  return out;
}
/* position the preview at timeline time t (paused-friendly) */
function mveCompositeAt(t) {
  if (!_mve) return;
  const v = mveVideoEl(), black = document.getElementById('mvePrevBlack');
  const vc = mveTopVideoClipAt(t);
  if (vc) {
    if (_mve.curVideoFile !== vc.fileId) { _mve.curVideoFile = vc.fileId; v.src = '/api/files/' + vc.fileId + '/raw'; }
    v.classList.remove('hidden'); if (black) black.classList.add('hidden');
    const local = vc.in + (t - vc.start);
    if (v.readyState >= 1 && Math.abs(v.currentTime - local) > 0.25) { try { v.currentTime = local; } catch (e) {} }
    // a video clip's own audio (if linked/un-muted) is handled via the <audio> path too,
    // so keep the <video> element muted to avoid double audio.
    v.muted = true;
    // picture fade in/out at the clip edges (matches the server render's fade filter)
    v.style.opacity = mveFadeMul(vc, t - vc.start).toFixed(3);
  } else {
    v.classList.add('hidden'); if (black) black.classList.remove('hidden');
    _mve.curVideoFile = null;
  }
  mveSyncAudio(t);
  mveUpdateOverlayVisibility(t);
  // playhead marker + time label
  const pps = _mve.pps;
  const line = document.getElementById('mvePlayline'), ov = document.getElementById('mvePlayOverlay');
  if (line) line.style.left = (t * pps) + 'px';
  if (ov) ov.style.left = (t * pps) + 'px';
  const te = document.getElementById('mveTime'); if (te) te.textContent = `${fmtDur(t)} / ${fmtDur(mveComputeDuration())}`;
}
/* drive hidden audio elements + per-clip keyframed volume */
function mveSyncAudio(t) {
  if (!_mve) return;
  const active = mveActiveAudioClipsAt(t);
  const activeIds = new Set(active.map(c => c.fileId));
  // one <audio> per fileId; if several clips share a file we approximate with the first active
  Object.entries(_mve.clipAudios).forEach(([fid, a]) => {
    const c = active.find(x => x.fileId === fid);
    if (!c) { if (!a.paused) a.pause(); return; }
    const local = c.in + (t - c.start);
    const vol = mveKfValue(c.volumeKfs, t - c.start, c.volume ?? 1) * mveFadeMul(c, t - c.start);
    a.volume = Math.min(1, Math.max(0, vol));   // preview can't exceed 1.0
    if (_mve.playing) {
      if (Math.abs(a.currentTime - local) > 0.3) { try { a.currentTime = local; } catch (e) {} }
      if (a.paused) a.play().catch(() => {});
    } else if (!a.paused) a.pause();
  });
}
function mveSetPlayhead(t) {
  if (!_mve) return;
  _mve.playhead = Math.max(0, Math.min(t, Math.max(0.0001, mveComputeDuration())));
  mveCompositeAt(_mve.playhead);
}
function mveTogglePlay() { if (!_mve || !mveAllClips().length) return; _mve.playing ? mvePreviewStop() : mvePreviewPlay(); }
function mveSetPlayIcon(p) { const b = document.getElementById('mvePlay'); if (b) b.innerHTML = svg(p ? 'pause' : 'play', 16); }
function mvePreviewPlay() {
  if (!_mve) return;
  const dur = mveComputeDuration();
  if (_mve.playhead >= dur - 0.02) _mve.playhead = 0;
  _mve.playing = true; mveSetPlayIcon(true);
  const vc0 = mveTopVideoClipAt(_mve.playhead); const v = mveVideoEl();
  if (vc0) { try { v.play().catch(() => {}); } catch (e) {} }
  let last = performance.now();
  const tick = (now) => {
    if (!_mve || !_mve.playing) return;
    const dt = (now - last) / 1000; last = now;
    _mve.playhead += dt;
    if (_mve.playhead >= mveComputeDuration() - 0.01) { mvePreviewStop(); _mve.playhead = mveComputeDuration(); mveCompositeAt(_mve.playhead); return; }
    mveCompositeAt(_mve.playhead);
    _mve.raf = requestAnimationFrame(tick);
  };
  _mve.raf = requestAnimationFrame(tick);
}
function mvePreviewStop() {
  if (!_mve) return;
  _mve.playing = false; mveSetPlayIcon(false);
  if (_mve.raf) { cancelAnimationFrame(_mve.raf); _mve.raf = null; }
  try { mveVideoEl().pause(); } catch (e) {}
  Object.values(_mve.clipAudios || {}).forEach(a => { try { a.pause(); } catch (e) {} });
}

/* ---- export (server render) ---- */
async function mveExportProject() {
  if (!_mve || !mveAllClips().length) return toast('Add some media first', 'info');
  if (_mve.exporting) return;
  if (!_toolsFfmpeg) return toast('ffmpeg isn’t installed on the server — export is unavailable', 'close');
  mvePreviewStop();
  const hadExport = _mve.project.export && _mve.project.export.fileId;
  const resultEl = document.getElementById('mveResult');
  _mve.exporting = true;
  document.getElementById('mveExport').disabled = true;
  mveVideoEl().pause();
  resultEl.innerHTML = `<div class="tool-working">
    <div class="tw-top"><span class="mono" id="twLabel">Rendering…</span><button class="btn ghost sm" id="mveCancel">Cancel</button></div>
    <div class="tool-prog indet"><i id="twBar"></i></div></div>`;
  _mve.abort = new AbortController();
  document.getElementById('mveCancel').onclick = () => { if (_mve.abort) _mve.abort.abort(); };
  const poll = startToolProgressPoll('Rendering');
  try {
    const r = await mveExport({
      project: _mve.project,
      output: hadExport ? 'replace' : 'save',
      replaceId: hadExport ? _mve.project.export.fileId : undefined,
      signal: _mve.abort.signal,
    });
    const f = r.file;
    _mve.project.export = { fileId: f.id, name: f.name };
    mveMarkDirty();
    resultEl.innerHTML = `<div class="tool-done">
      <div class="td-row"><span class="td-ok">${svg('check', 16)} ${r.output === 'replace' ? 'Re-exported' : 'Exported'} <b>${esc(f.name)}</b></span><span class="mono dim">${fmtSize(r.outSize)}</span></div>
      <video controls src="${esc(mediaUrl(f) || ('/api/files/' + f.id + '/raw'))}" class="tool-prev"></video>
      <div class="mve-done-acts"><button class="btn ghost" id="mveGoDb">${svg('database', 15)} Show in Database</button></div>
    </div>`;
    const go = document.getElementById('mveGoDb'); if (go) go.onclick = () => openApp('database');
    toast('Exported to your vault', 'check');
  } catch (e) {
    resultEl.innerHTML = e.name === 'AbortError'
      ? `<div class="tool-err mono">Export cancelled.</div>`
      : `<div class="tool-err mono">${svg('close', 14)} ${esc(e.message || 'Export failed')}</div>`;
  } finally {
    poll.stop(); _mve.abort = null; _mve.exporting = false;
    const b = document.getElementById('mveExport'); if (b) b.disabled = false;
  }
}

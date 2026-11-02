/* player.js — the new UI's own media player (video + audio). No browser chrome:
   a glass control bar, a scrubber with buffered range + hover time, speed menu,
   volume, captions, theater mode, PiP, fullscreen, auto-hiding interface,
   keyboard control, our own loading/stall/error states, and resume-where-you-
   left-off (synced server-side). While anything is mounted, thumbnail loading
   pauses so the stream keeps its connection (see thumbs.js). destroy() aborts
   the download outright.
   `host` is the element around the player (the viewer): it gets `vw-idle` while
   the interface is hidden and `vw-theater` in theater mode, so it can hide its
   own header and arrows too, and activity anywhere on it counts. */
import { html, raw, el, icon, esc, ext, fmtDur, api, animate, SPRING } from './lib.js';
import * as prefs from './prefs.js';
import { menu, toast, pushEsc } from './ui.js';
import { pauseThumbs, resumeThumbs } from './thumbs.js';
import { struggling } from './perf.js';
import { fileSources, embeddedSources, loadCues, cuesAt, sameLang, attach, detach, isSubFile, SUB_EXT } from './captions.js';
import { pickFiles } from './pick.js';
import { uploadAndWait } from './upload.js';

const ICON = {
  play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  back10: '<path d="M11 5 7 8.5 11 12"/><path d="M7.5 8.5H14a6 6 0 1 1-6 6"/>',
  fwd10: '<path d="m13 5 4 3.5-4 3.5"/><path d="M16.5 8.5H10a6 6 0 1 0 6 6"/>',
  vol: '<path d="M4 9.5h3l4.5-4v13l-4.5-4H4z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h3l4.5-4v13l-4.5-4H4z"/><path d="m16 9.5 5 5m0-5-5 5"/>',
  full: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
  unfull: '<path d="M9 4v4H5M15 4v4h4M9 20v-4H5M15 20v-4h4"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11.5" width="7" height="5.5" rx="1.2" fill="currentColor" stroke="none"/>',
  cc: '<rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M10.5 10.3a2.3 2.3 0 1 0 0 3.4M17 10.3a2.3 2.3 0 1 0 0 3.4"/>',
  theater: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10v4M18 10v4"/>',
};
const ic = (n, s = 20) => raw(`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICON[n]}</svg>`);
const IDLE_MS = 5000;
const CAP_SIZES = { s: ['Small', 0.036], m: ['Medium', 0.046], l: ['Large', 0.058], xl: ['Extra large', 0.072] };
const stem = n => String(n || '').replace(/\.[^.]+$/, '');
const fmtDelay = d => (d === 0 ? 'in sync' : (d > 0 ? '+' : '−') + Math.abs(d).toFixed(2).replace(/0$/, '') + 's');

export function mountPlayer(f, { kind = 'video', cover, onFail, host, autoResume = false, upNext = null } = {}) {
  const isVideo = kind === 'video';
  const root = el(html`<div class="player ${isVideo ? 'is-video' : 'is-audio'} paused loading" tabindex="0"${isVideo ? raw(' data-own-drop') : ''}>
    ${isVideo ? raw('<video playsinline preload="metadata"></video><div class="p-cap" hidden></div><div class="p-osd" hidden></div>') : html`
      <div class="pa-art tint t-audio">${cover ? raw(`<img src="${esc(cover)}" alt="">`) : icon('audio', 64, 1.3)}</div>
      <div class="pa-meta"><b>${f.name.replace(/\.[^.]+$/, '')}</b><small>${[f.artist, f.album].filter(Boolean).join(' · ') || 'Unknown artist'}</small></div>
      <audio preload="metadata"></audio>`}
    <div class="p-spin"><span></span></div>
    <button class="p-big" aria-label="Play">${ic('play', 34)}</button>
    <div class="p-note" hidden></div>
    <div class="p-bar">
      <div class="p-scrub" role="slider" aria-label="Seek" tabindex="0"><div class="p-track"><i class="p-buf"></i><i class="p-fill"></i></div><span class="p-knob"></span><span class="p-tip">0:00</span></div>
      <div class="p-row">
        <button class="p-btn" data-p="play" aria-label="Play">${ic('play')}</button>
        <button class="p-btn" data-p="back" aria-label="Back 10 seconds">${ic('back10')}</button>
        <button class="p-btn" data-p="fwd" aria-label="Forward 10 seconds">${ic('fwd10')}</button>
        <span class="p-time">0:00 <i>/ ${fmtDur(f.dur || 0)}</i></span>
        <span class="p-sp"></span>
        ${isVideo ? html`<button class="p-btn p-cc" data-p="cc" aria-label="Captions" title="Captions (C)">${ic('cc')}</button>` : ''}
        <button class="p-btn p-rate" data-p="rate" aria-label="Playback speed">1×</button>
        <div class="p-vol"><button class="p-btn" data-p="mute" aria-label="Mute">${ic('vol')}</button><input type="range" min="0" max="100" step="1" aria-label="Volume"></div>
        ${isVideo && host ? html`<button class="p-btn" data-p="theater" aria-label="Theater mode" title="Theater mode (T)">${ic('theater')}</button>` : ''}
        ${isVideo && document.pictureInPictureEnabled ? html`<button class="p-btn" data-p="pip" aria-label="Picture in picture">${ic('pip')}</button>` : ''}
        ${isVideo ? html`<button class="p-btn" data-p="full" aria-label="Fullscreen" title="Fullscreen (F)">${ic('full')}</button>` : ''}
      </div>
    </div>
  </div>`.s);

  const m = root.querySelector(isVideo ? 'video' : 'audio');
  const $ = s => root.querySelector(s);
  const fill = $('.p-fill'), buf = $('.p-buf'), knob = $('.p-knob'), tip = $('.p-tip'), time = $('.p-time'), scrub = $('.p-scrub'), vol = $('.p-vol input'), note = $('.p-note');
  let dur = f.dur || 0, dragging = false, destroyed = false, hideTimer = null, stallTimer = null, saveTimer = null, lastSaved = -1;

  pauseThumbs();
  m.volume = (prefs.get('volume') ?? 90) / 100;
  m.playbackRate = Number(prefs.get('rate')) || 1;
  m.loop = !!prefs.get('loop') && isVideo;
  vol.value = String(Math.round(m.volume * 100));
  paintVol();
  $('.p-rate').textContent = fmtRate(m.playbackRate);
  m.src = f.url;

  /* ---------- state painting ---------- */
  const setPlaying = on => {
    root.classList.toggle('paused', !on);
    root.querySelector('[data-p=play]').innerHTML = ic(on ? 'pause' : 'play').s;
    root.querySelector('[data-p=play]').setAttribute('aria-label', on ? 'Pause' : 'Play');
    if (on) { armHide(); capLoop(); } else showControls(true);
  };
  const paintTime = () => {
    const t = m.currentTime || 0, d = dur || m.duration || 0;
    const p = d ? Math.min(1, t / d) : 0;
    if (!dragging) { fill.style.width = p * 100 + '%'; knob.style.left = p * 100 + '%'; }
    time.innerHTML = `${fmtDur(t)} <i>/ ${fmtDur(d)}</i>`;
    scrub.setAttribute('aria-valuenow', String(Math.round(t)));
  };
  const paintBuf = () => {
    const d = m.duration; if (!d || !m.buffered.length) return;
    // the buffered range that contains the playhead (or the last one)
    let end = 0; for (let i = 0; i < m.buffered.length; i++) { if (m.buffered.start(i) <= m.currentTime + 0.5) end = m.buffered.end(i); }
    buf.style.width = Math.min(100, end / d * 100) + '%';
  };
  function paintVol() {
    const v = m.muted ? 0 : m.volume;
    vol.style.setProperty('--fill', v * 100 + '%');
    root.querySelector('[data-p=mute]').innerHTML = ic(v === 0 ? 'mute' : 'vol').s;
  }
  let noteKind = null;   // 'stall' | 'resume' | 'error' | 'caps' — each only ever clears its own note
  const loading = on => {
    root.classList.toggle('loading', on);
    clearTimeout(stallTimer);
    if (on) stallTimer = setTimeout(() => showNote('Still loading — the connection may be slow.', true, null, 'stall'), 15000);
    else if (noteKind === 'stall') hideNote();
  };
  function showNote(text, retry, actions, kind) {
    noteKind = kind || null;
    note.hidden = false;
    note.innerHTML = html`<span>${text}</span>${retry ? html`<button class="b sm" data-p="retry">Retry</button>` : ''}${actions || ''}`.s;
    animate(note, [{ opacity: 0, transform: 'translate(-50%, 8px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 300 });
  }
  function hideNote() { note.hidden = true; noteKind = null; }
  /* a short message in the corner (speed, caption timing, loop…) */
  let osdTimer = null;
  function osd(text) {
    const o = $('.p-osd'); if (!o) return toast(text, { ic: 'check' });
    o.textContent = text; o.hidden = false;
    clearTimeout(osdTimer); osdTimer = setTimeout(() => { o.hidden = true; }, 1300);
  }

  /* ---------- media events ---------- */
  m.addEventListener('loadedmetadata', () => { if (isFinite(m.duration)) dur = m.duration; scrub.setAttribute('aria-valuemax', String(Math.round(dur))); paintTime(); maybeResume(); if (isVideo) setTimeout(autoCaptions, 400); });
  m.addEventListener('timeupdate', () => { paintTime(); queueSave(); watchFrames(); if (m.paused) paintCap(); });
  /* the device can't keep up (laptop graphics + live blur): dropped frames pile up.
     Measured over a few seconds of real playback; switches to light effects once. */
  let fq = null;
  function watchFrames() {
    if (!isVideo || m.paused || typeof m.getVideoPlaybackQuality !== 'function') return;
    const q = m.getVideoPlaybackQuality(), now = performance.now();
    if (!fq || now - fq.t > 8000) { fq = { t: now, total: q.totalVideoFrames, dropped: q.droppedVideoFrames }; return; }
    if (now - fq.t < 3000) return;
    const total = q.totalVideoFrames - fq.total, dropped = q.droppedVideoFrames - fq.dropped;
    fq = { t: now, total: q.totalVideoFrames, dropped: q.droppedVideoFrames };
    if (total >= 30 && dropped / total > 0.16) struggling(`video was dropping ${Math.round(dropped / total * 100)}% of frames`);
  }
  m.addEventListener('progress', paintBuf);
  m.addEventListener('play', () => setPlaying(true));
  m.addEventListener('pause', () => { setPlaying(false); saveNow(); });
  m.addEventListener('waiting', () => loading(true));
  m.addEventListener('stalled', () => { if (!m.paused) loading(true); });
  m.addEventListener('canplay', () => loading(false));
  m.addEventListener('playing', () => loading(false));
  m.addEventListener('seeking', () => loading(true));
  m.addEventListener('seeked', () => { loading(false); paintCap(); });
  m.addEventListener('ended', () => {
    setPlaying(false);
    if (!isVideo) return;
    api(`/api/files/${f.id}/progress?finished=1`, { method: 'DELETE' }).catch(() => {});   // played to the end = watched
    if (upNext && !m.loop) countdownNext();
  });
  m.addEventListener('ratechange', () => { $('.p-rate').textContent = fmtRate(m.playbackRate); });
  m.addEventListener('volumechange', paintVol);
  m.addEventListener('error', () => {
    if (destroyed) return;
    // can't decode at all (unsupported codec/container): let the viewer explain + offer conversion
    const fatal = m.error && (m.error.code === 4 || m.error.code === 3) && !(m.currentTime > 0);
    if (fatal && onFail) { onFail(); return; }
    loading(false); root.classList.add('failed');
    showNote('This file couldn’t be played here.', false, html`<button class="b sm" data-p="retry">Retry</button>`, 'error');
  });

  /* ---------- resume ---------- */
  let resumeChecked = false;
  async function maybeResume() {
    if (resumeChecked || !isVideo || !prefs.get('resume')) { startAuto(); return; }
    resumeChecked = true;
    let r = null;
    try { r = (await api(`/api/files/${f.id}/progress`, { timeout: 6000 })).resume; } catch (e) {}
    if (destroyed) return;
    const d = dur || m.duration || 0;
    // a series episode carries on where it was left, without asking
    if (autoResume && r && r.pos > 5 && (!d || r.pos < d - 10)) { m.currentTime = r.pos; osd('Resumed at ' + fmtDur(r.pos)); startAuto(); return; }
    if (r && r.pos > 10 && (!d || r.pos < d - 10)) {
      showNote(`Pick up at ${fmtDur(r.pos)}?`, false, html`<button class="b sm pri" data-p="resume" data-pos="${r.pos}">Resume</button><button class="b sm" data-p="over">Start over</button>`, 'resume');
      setTimeout(() => { if (noteKind === 'resume') hideNote(); }, 12000);
    }
    startAuto();
  }
  function startAuto() { if (prefs.get('autoplay')) m.play().catch(() => setPlaying(false)); }
  function queueSave() { if (!isVideo || !prefs.get('resume') || saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 10000); }
  function saveNow() {
    if (!isVideo || !prefs.get('resume')) return;
    const pos = Math.floor(m.currentTime || 0);
    if (pos < 5 || pos === lastSaved) return;
    lastSaved = pos;
    api(`/api/files/${f.id}/progress`, { method: 'POST', json: { pos, dur: Math.floor(dur || 0) }, timeout: 8000 }).catch(() => {});
  }

  /* ---------- controls ---------- */
  const toggle = () => { if (m.paused) m.play().catch(err => toast(err.message || 'Can’t play', { bad: true })); else m.pause(); };
  const seekBy = s => { m.currentTime = Math.max(0, Math.min((dur || m.duration || 0) - 0.1, (m.currentTime || 0) + s)); flash(s > 0 ? 'fwd10' : 'back10'); };
  const setRate = r => { m.playbackRate = r; osd('Speed ' + fmtRate(r)); };
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-p], .p-big');
    if (!b) { if (isVideo && (e.target === m || e.target.closest('.p-cap'))) toggle(); return; }
    if (b.classList.contains('p-big')) return toggle();
    const a = b.dataset.p;
    if (a === 'play') toggle();
    else if (a === 'back') seekBy(-10);
    else if (a === 'fwd') seekBy(10);
    else if (a === 'mute') { m.muted = !m.muted; if (!m.muted && m.volume === 0) m.volume = 0.5; }
    else if (a === 'full') toggleFull();
    else if (a === 'theater') setTheater(!theater);
    else if (a === 'cc') ccMenu(b);
    else if (a === 'pip') { (document.pictureInPictureElement ? document.exitPictureInPicture() : m.requestPictureInPicture()).catch(() => {}); }
    else if (a === 'rate') menu([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(r => ({ label: fmtRate(r) + (r === 1 ? '  Normal' : ''), ic: m.playbackRate === r ? 'check' : 'play', run: () => setRate(r) })), b);
    else if (a === 'resume') { m.currentTime = Number(b.dataset.pos) || 0; hideNote(); m.play().catch(() => {}); }
    else if (a === 'over') { hideNote(); api(`/api/files/${f.id}/progress`, { method: 'DELETE' }).catch(() => {}); }
    else if (a === 'retry') { const t = m.currentTime; root.classList.remove('failed'); hideNote(); loading(true); m.load(); m.currentTime = t; m.play().catch(() => {}); }
  });
  if (isVideo) m.addEventListener('dblclick', toggleFull);
  vol.addEventListener('input', () => { m.muted = false; m.volume = Number(vol.value) / 100; });

  // scrubbing (pointer, with a hover time tip)
  const posAt = x => { const r = scrub.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)); };
  scrub.addEventListener('pointermove', e => { const p = posAt(e.clientX); tip.textContent = fmtDur(p * (dur || m.duration || 0)); tip.style.left = p * 100 + '%'; if (dragging) { fill.style.width = knob.style.left = p * 100 + '%'; } });
  scrub.addEventListener('pointerdown', e => { dragging = true; scrub.setPointerCapture(e.pointerId); root.classList.add('scrubbing'); const p = posAt(e.clientX); fill.style.width = knob.style.left = p * 100 + '%'; });
  const endDrag = e => { if (!dragging) return; dragging = false; root.classList.remove('scrubbing'); m.currentTime = posAt(e.clientX) * (dur || m.duration || 0); };
  scrub.addEventListener('pointerup', endDrag);
  scrub.addEventListener('pointercancel', () => { dragging = false; root.classList.remove('scrubbing'); });
  scrub.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); seekBy(e.key === 'ArrowRight' ? 5 : -5); } });

  /* ---------- hiding the interface ----------
     While a video plays, five seconds without a mouse move, click, scroll or key
     hides the controls, the viewer's header and arrows, and the pointer. Theater
     mode hides all of it as soon as playback runs and keeps it hidden - moving the
     mouse doesn't bring it back - until a pause. */
  let theater = false, popTheaterEsc = null;
  const watched = host || root;
  const setIdle = on => { root.classList.toggle('idle', on); if (host) host.classList.toggle('vw-idle', on); };
  // don't hide from under the pointer or the keyboard while someone is using the controls
  const busy = () => dragging || !!root.querySelector('.p-bar:hover, .p-bar :focus-visible') || !!(host && host.querySelector('.vt:hover')) || !!document.querySelector('.menu, .scrim');
  function showControls(stay) {
    if (theater && !m.paused) return;
    setIdle(false); clearTimeout(hideTimer);
    if (!stay) armHide();
  }
  function armHide() {
    clearTimeout(hideTimer);
    if (!isVideo || m.paused) return;
    if (theater) { hideTimer = setTimeout(() => { if (!m.paused) setIdle(true); }, 700); return; }
    hideTimer = setTimeout(() => { if (m.paused) return; if (busy()) armHide(); else setIdle(true); }, IDLE_MS);
  }
  const onActivity = () => showControls();
  if (isVideo) ['pointermove', 'pointerdown', 'wheel'].forEach(t => watched.addEventListener(t, onActivity, { passive: true }));

  function setTheater(on) {
    if (!isVideo || !host || on === theater) return;
    theater = on;
    root.classList.toggle('theater', on); host.classList.toggle('vw-theater', on);
    const b = $('[data-p=theater]');
    if (b) { b.classList.toggle('on', on); b.setAttribute('aria-label', on ? 'Leave theater mode' : 'Theater mode'); b.title = on ? 'Leave theater mode (T or Esc)' : 'Theater mode (T)'; }
    if (on) {
      popTheaterEsc = pushEsc(() => setTheater(false));
      osd('Theater mode — pause to see the controls');
      if (m.paused) m.play().catch(() => {}); else armHide();
    } else {
      if (popTheaterEsc) popTheaterEsc(); popTheaterEsc = null;
      showControls();
    }
    sizeCaps();
  }

  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else (root.requestFullscreen ? root.requestFullscreen() : Promise.reject()).catch(() => { if (m.webkitEnterFullscreen) m.webkitEnterFullscreen(); });
  }
  const onFs = () => { const b = root.querySelector('[data-p=full]'); if (b) b.innerHTML = ic(document.fullscreenElement === root ? 'unfull' : 'full').s; };
  document.addEventListener('fullscreenchange', onFs);

  function flash(name) {
    const n = el(html`<span class="p-flash">${ic(name, 30)}</span>`.s); root.appendChild(n);
    animate(n, [{ opacity: 0, transform: 'translate(-50%,-50%) scale(0.7)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.3 }, { opacity: 0, transform: 'translate(-50%,-50%) scale(1.15)' }], { duration: 600, fill: 'forwards' }).then(() => n.remove());
  }

  /* ---------- captions ---------- */
  const cap = isVideo ? $('.p-cap') : null;
  const C = { files: null, emb: null, embLoad: null, embErr: '', cur: null, last: null, cues: [], delay: 0, raf: 0, shown: null, tok: null };
  function capStyle() { root.classList.toggle('cap-nobg', !prefs.get('capBg')); sizeCaps(); }
  // caption text scales with the picture, like a TV's
  function sizeCaps() {
    if (!cap) return;
    const h = root.clientHeight || 400, k = (CAP_SIZES[prefs.get('capSize')] || CAP_SIZES.m)[1];
    root.style.setProperty('--cap-px', Math.max(14, Math.round(h * k)) + 'px');
  }
  const ro = isVideo && 'ResizeObserver' in window ? new ResizeObserver(sizeCaps) : null;
  if (ro) ro.observe(root);
  function loadFiles() { if (!C.files) C.files = fileSources(f).catch(() => []); return C.files; }
  function loadEmb() {
    if (!C.embLoad) C.embLoad = embeddedSources(f).then(l => (C.emb = l)).catch(e => { C.embErr = e.message || 'error'; return (C.emb = []); });
    return C.embLoad;
  }
  /* turn captions on by themselves when the viewer had them on last time (same
     language), or when the video carries a forced track (signs, foreign dialogue) */
  async function autoCaptions() {
    if (destroyed || !isVideo) return;
    capStyle();
    const want = prefs.get('capLang');
    const files = await loadFiles();
    if (destroyed || C.cur) return;
    let pick = null;
    if (want) pick = files.find(s => !s.forced && (want === '*' || sameLang(s.lang, want))) || files.find(s => !s.forced && !s.lang);
    if (!pick) {
      const emb = await loadEmb();
      if (destroyed || C.cur) return;
      if (want) pick = emb.find(s => s.usable && !s.forced && (want === '*' || sameLang(s.lang, want)));
      if (!pick) pick = emb.find(s => s.usable && s.forced && s.isDefault) || null;
    } else loadEmb();
    if (pick) choose(pick, { quiet: true });
  }
  async function choose(src, { quiet } = {}) {
    if (!src) {
      C.tok = null; C.cur = null; C.cues = []; paintCap(true); ccState();
      if (!quiet) { prefs.set({ capLang: '' }); osd('Captions off'); }
      return;
    }
    if (src.kind === 'embedded' && !src.usable) { toast(src.detail, { bad: true }); return; }
    const tok = C.tok = {};
    C.cur = src; ccState(true);
    if (src.kind === 'embedded') showNote('Loading captions from the video…', false, null, 'caps');
    let cues;
    try { cues = await loadCues(f, src); if (!cues.length) throw new Error('No captions found in that file.'); }
    catch (e) {
      if (C.tok !== tok || destroyed) return;
      C.cur = null; C.cues = []; ccState(); if (noteKind === 'caps') hideNote();
      if (!quiet) toast(e.message || 'Those captions couldn’t be loaded', { bad: true });
      return;
    }
    if (C.tok !== tok || destroyed) return;
    if (noteKind === 'caps') hideNote();
    C.cues = cues; C.last = src; ccState(); paintCap(true); capLoop();
    if (!quiet) { prefs.set({ capLang: src.lang || '*' }); osd('Captions: ' + src.label); }
  }
  function ccState(loading) {
    const b = $('[data-p=cc]'); if (!b) return;
    b.classList.toggle('on', !!C.cur); b.classList.toggle('busy', !!loading);
    b.setAttribute('aria-pressed', C.cur ? 'true' : 'false');
  }
  function paintCap(force) {
    if (!cap) return;
    const on = C.cur && C.cues.length ? cuesAt(C.cues, (m.currentTime || 0) - C.delay) : [];
    const h = on.map(c => `<span>${c.html}</span>`).join('<br>');
    if (h === C.shown && !force) return;
    C.shown = h; cap.innerHTML = h; cap.hidden = !h;
  }
  function capLoop() {
    cancelAnimationFrame(C.raf);
    if (!C.cur || m.paused || destroyed) return;
    paintCap(); C.raf = requestAnimationFrame(capLoop);
  }
  async function toggleCaptions() {
    if (C.cur) return choose(null);
    if (C.last) return choose(C.last);
    const files = await loadFiles();
    let pick = files.find(s => !s.forced) || files[0];
    if (!pick) { osd('Looking for captions…'); pick = (await loadEmb()).find(s => s.usable && !s.forced) || C.emb.find(s => s.usable); }
    if (pick) choose(pick); else toast('No captions for this video yet — add a subtitle file from the CC menu', { ic: 'info' });
  }
  function shiftDelay(d) {
    if (!C.cur) return;
    C.delay = Math.round((C.delay + d) * 100) / 100; paintCap(true);
    osd('Caption timing ' + fmtDelay(C.delay));
  }
  async function ccMenu(anchor) {
    const files = await loadFiles(); loadEmb();
    if (destroyed) return;
    const cur = C.cur && C.cur.key;
    const mark = s => (cur === s.key ? 'check' : s.kind === 'embedded' ? 'video' : 'file');
    const emb = C.emb;
    menu([
      { label: 'Off', ic: cur ? 'close' : 'check', run: () => choose(null) },
      files.length && { header: 'Subtitle files' },
      ...files.map(s => ({ label: s.label, ic: mark(s), run: () => choose(s) })),
      C.cur && C.cur.kind === 'local' && { label: C.cur.label, ic: 'check' },
      { header: 'In the video' },
      ...(emb == null ? [{ label: 'Checking the video…', ic: 'clock', run: () => C.embLoad.then(() => ccMenu(anchor)) }]
        : emb.length ? emb.map(s => ({ label: s.label + (s.usable ? '' : ' (picture subtitles — not supported)'), ic: s.usable ? mark(s) : 'info', run: () => choose(s) }))
          : [{ label: C.embErr ? 'Couldn’t check this video' : 'None in this file', ic: 'info' }]),
      '-',
      { label: 'Add from Database…', ic: 'database', run: addFromVault },
      { label: 'Upload a subtitle file…', ic: 'upload', run: pickLocal },
      C.cur && C.cur.kind === 'file' && C.cur.linked && { label: 'Detach this file from the video', ic: 'close', run: detachCur },
      '-',
      C.cur && { label: `Timing: ${fmtDelay(C.delay)}`, ic: 'clock', key: 'G / H', run: () => timingMenu(anchor) },
      { label: `Text size: ${(CAP_SIZES[prefs.get('capSize')] || CAP_SIZES.m)[0]}`, ic: 'fit', run: () => sizeMenu(anchor) },
      { label: prefs.get('capBg') ? 'Background box: on' : 'Background box: off', ic: 'window', run: () => { prefs.set({ capBg: !prefs.get('capBg') }); capStyle(); } },
    ], anchor);
  }
  function sizeMenu(anchor) {
    menu(Object.entries(CAP_SIZES).map(([k, [label]]) => ({ label, ic: prefs.get('capSize') === k ? 'check' : 'fit', run: () => { prefs.set({ capSize: k }); sizeCaps(); } })), anchor);
  }
  function timingMenu(anchor) {
    menu([-2, -1, -0.5, -0.25, 0, 0.25, 0.5, 1, 2].map(d => ({
      label: d === 0 ? 'Reset (in sync)' : (d < 0 ? 'Earlier by ' : 'Later by ') + Math.abs(d) + 's', ic: d === 0 ? 'restore' : d < 0 ? 'back' : 'chevron',
      run: () => { if (d === 0) { C.delay = 0; paintCap(true); osd('Caption timing in sync'); } else shiftDelay(d); },
    })), anchor);
  }
  async function addFromVault() {
    const same = x => (x.parent ?? null) === (f.parent ?? null);
    const ids = await pickFiles({ title: 'Add subtitles', filter: isSubFile, rank: x => (same(x) ? 1 : 0), okLabel: 'Use',
      empty: 'No subtitle files (.srt, .vtt, .ass) in your Database yet', hint: 'The file stays attached to this video, so it’s there next time.' });
    if (!ids || destroyed) return;
    try { await attach(f, ids[0]); } catch (e) { toast(e.message, { bad: true }); }
    C.files = null;
    const s = (await loadFiles()).find(x => x.id === ids[0]);
    if (s) choose(s);
  }
  function pickLocal() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.srt,.vtt,.ass,.ssa';
    inp.onchange = () => { if (inp.files[0]) useLocal(inp.files[0]); };
    inp.click();
  }
  /* a subtitle file from the computer: show it straight away, then keep a copy
     beside the video and attach it so it's there next time */
  async function useLocal(file) {
    if (!SUB_EXT.has(ext(file.name))) return toast('That isn’t a subtitle file (.srt, .vtt, .ass)', { bad: true });
    let text; try { text = await file.text(); } catch (e) { return toast('Couldn’t read that file', { bad: true }); }
    const local = { key: 'l:' + Date.now(), kind: 'local', text, lang: '', label: stem(file.name) };
    await choose(local);
    if (C.cur !== local) return;
    try {
      const row = await uploadAndWait(file, f.parent ?? null);
      if (!row || destroyed) return;
      await attach(f, row.id);
      C.files = null;
      const s = (await loadFiles()).find(x => x.id === row.id);
      if (s && C.cur === local) { s.key = local.key; C.cur = C.last = s; }
      toast('Subtitles saved with the video', { ic: 'check' });
    } catch (e) { toast('Showing them now, but they couldn’t be saved: ' + (e.message || 'error'), { bad: true }); }
  }
  async function detachCur() {
    const s = C.cur; if (!s || s.kind !== 'file') return;
    try { await detach(f, s.id); } catch (e) { return toast(e.message, { bad: true }); }
    choose(null, { quiet: true }); C.files = null; C.last = null;
    toast('Detached — the file itself is still in your Database', { ic: 'check' });
  }
  // drop a subtitle file on the video to use it
  if (isVideo) {
    root.addEventListener('dragover', e => { if ([...(e.dataTransfer.types || [])].includes('Files')) { e.preventDefault(); root.classList.add('drop'); } });
    root.addEventListener('dragleave', e => { if (!root.contains(e.relatedTarget)) root.classList.remove('drop'); });
    root.addEventListener('drop', e => {
      e.preventDefault(); root.classList.remove('drop');
      const file = [...(e.dataTransfer.files || [])].find(x => SUB_EXT.has(ext(x.name)));
      if (file) useLocal(file); else toast('Drop a subtitle file (.srt, .vtt, .ass) here to use it with this video', { ic: 'info' });
    });
  }

  /* ---------- up next (series): the following episode starts after a short count */
  let nextTimer = null;
  function countdownNext() {
    let n = 8;
    const paint = () => showNote(`Up next: ${upNext.label} — in ${n}s`, false, html`<button class="b sm pri" data-p="nextnow">Play now</button><button class="b sm" data-p="nextcancel">Cancel</button>`, 'next');
    paint(); showControls(true);
    nextTimer = setInterval(() => { if (destroyed || noteKind !== 'next') return clearInterval(nextTimer); if (--n <= 0) { clearInterval(nextTimer); hideNote(); upNext.go(); } else paint(); }, 1000);
  }
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-p=nextnow], [data-p=nextcancel]'); if (!b) return;
    clearInterval(nextTimer); hideNote();
    if (b.dataset.p === 'nextnow') upNext.go();
  });
  m.addEventListener('play', () => { if (noteKind === 'next') { clearInterval(nextTimer); hideNote(); } });

  /* ---------- extras (the viewer's menu offers these) ---------- */
  function snapshot() {
    if (!isVideo || !m.videoWidth) return toast('No picture to save yet', { bad: true });
    try {
      const c = document.createElement('canvas'); c.width = m.videoWidth; c.height = m.videoHeight;
      c.getContext('2d').drawImage(m, 0, 0);
      c.toBlob(b => {
        if (!b) return toast('Couldn’t capture this frame', { bad: true });
        const a = document.createElement('a'); a.href = URL.createObjectURL(b);
        a.download = `${stem(f.name)} ${fmtDur(m.currentTime).replace(/:/g, '-')}.png`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        osd('Frame saved');
      }, 'image/png');
    } catch (e) { toast('Couldn’t capture this frame', { bad: true }); }
  }
  function toggleLoop() { m.loop = !m.loop; prefs.set({ loop: m.loop }); osd(m.loop ? 'Loop on' : 'Loop off'); }
  const KEYS = [
    ['Space / K', 'Play or pause'], ['J / L', 'Back / forward 10 seconds'], ['← / →', 'Back / forward 5 seconds'], ['↑ / ↓', 'Volume'],
    ['M', 'Mute'], ['0 – 9', 'Jump to 0% – 90%'], ['Home / End', 'Start / end'], ['< / >', 'Slower / faster'],
    ...(isVideo ? [[', / .', 'Previous / next frame (paused)'], ['C', 'Captions on / off'], ['G / H', 'Captions earlier / later'], ['T', 'Theater mode'], ['F', 'Full screen']] : []),
    ['Shift + ← / →', 'Previous / next file'], ['?', 'This list'],
  ];
  function help() {
    let h = $('.p-help');
    if (h) { h.remove(); return; }
    h = el(html`<div class="p-help" role="dialog" aria-label="Keyboard shortcuts"><b>Keyboard shortcuts</b><dl>${raw(KEYS.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`.s).join(''))}</dl><button class="b sm" data-x>Close</button></div>`.s);
    h.querySelector('[data-x]').onclick = () => h.remove();
    root.appendChild(h);
    animate(h, [{ opacity: 0, transform: 'translate(-50%, -48%) scale(0.96)' }, { opacity: 1, transform: 'translate(-50%, -50%)' }], { duration: 260, easing: SPRING });
  }

  /* keyboard — the viewer forwards keys here while this player is open */
  function key(e) {
    const k = e.key.toLowerCase();
    const onButton = document.activeElement && document.activeElement.tagName === 'BUTTON';
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (k === ' ' && onButton) return false;   // the focused button handles Space itself
    showControls();
    if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); return true; }
    if (k === 'j') { seekBy(-10); return true; }
    if (k === 'l') { seekBy(10); return true; }
    if (e.key === 'ArrowLeft' && !e.shiftKey) { e.preventDefault(); seekBy(-5); return true; }
    if (e.key === 'ArrowRight' && !e.shiftKey) { e.preventDefault(); seekBy(5); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); m.volume = Math.min(1, m.volume + 0.05); m.muted = false; osd('Volume ' + Math.round(m.volume * 100) + '%'); return true; }
    if (e.key === 'ArrowDown') { e.preventDefault(); m.volume = Math.max(0, m.volume - 0.05); osd('Volume ' + Math.round(m.volume * 100) + '%'); return true; }
    if (k === 'm') { m.muted = !m.muted; osd(m.muted ? 'Muted' : 'Sound on'); return true; }
    if (/^[0-9]$/.test(e.key)) { const d = dur || m.duration; if (d) m.currentTime = d * Number(e.key) / 10; return true; }
    if (e.key === 'Home') { e.preventDefault(); m.currentTime = 0; return true; }
    if (e.key === 'End') { e.preventDefault(); const d = dur || m.duration; if (d) m.currentTime = Math.max(0, d - 0.5); return true; }
    if (e.key === '<' || e.key === '>') { const rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3], i = rates.indexOf(m.playbackRate); setRate(rates[Math.max(0, Math.min(rates.length - 1, (i < 0 ? 3 : i) + (e.key === '>' ? 1 : -1)))]); return true; }
    if (e.key === '?') { help(); return true; }
    if (!isVideo) return false;
    if ((e.key === ',' || e.key === '.') && m.paused) { m.currentTime = Math.max(0, (m.currentTime || 0) + (e.key === '.' ? 1 : -1) / 30); return true; }
    if (k === 'f') { toggleFull(); return true; }
    if (k === 'c') { toggleCaptions(); return true; }
    if (k === 'g') { shiftDelay(-0.25); return true; }
    if (k === 'h') { shiftDelay(0.25); return true; }
    if (k === 't' && host) { setTheater(!theater); return true; }
    return false;
  }

  function destroy() {
    if (destroyed) return; destroyed = true;
    saveNow();
    clearTimeout(hideTimer); clearTimeout(stallTimer); clearTimeout(saveTimer); clearTimeout(osdTimer); clearInterval(nextTimer);
    cancelAnimationFrame(C.raf);
    if (ro) ro.disconnect();
    if (popTheaterEsc) popTheaterEsc();
    if (host) { host.classList.remove('vw-idle', 'vw-theater'); ['pointermove', 'pointerdown', 'wheel'].forEach(t => host.removeEventListener(t, onActivity)); }
    document.removeEventListener('fullscreenchange', onFs);
    if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
    if (document.pictureInPictureElement === m) document.exitPictureInPicture().catch(() => {});
    // abort the download: pausing alone keeps the connection open
    try { m.pause(); m.removeAttribute('src'); m.load(); } catch (e) {}
    resumeThumbs();
  }

  loading(true);
  return {
    el: root, media: m, key, destroy,
    // for the viewer's menu
    extras: () => isVideo ? [
      host && { label: theater ? 'Leave theater mode' : 'Theater mode', ic: 'desktop', key: 'T', run: () => setTheater(!theater) },
      { label: C.cur ? 'Captions off' : 'Captions', ic: 'note', key: 'C', run: toggleCaptions },
      { label: 'Save this frame', ic: 'image', run: snapshot },
      { label: m.loop ? 'Loop: on' : 'Loop: off', ic: 'restore', run: toggleLoop },
      { label: 'Keyboard shortcuts', ic: 'keyboard', key: '?', run: help },
    ].filter(Boolean) : [
      { label: m.loop ? 'Loop: on' : 'Loop: off', ic: 'restore', run: toggleLoop },
      { label: 'Keyboard shortcuts', ic: 'keyboard', key: '?', run: help },
    ],
  };
}
const fmtRate = r => (Number(r) === 1 ? '1×' : Number(r) + '×');

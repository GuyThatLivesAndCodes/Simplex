/* ============================================================
   VIEWERS — video / audio players, image viewer, text editor
   ============================================================ */

let activeViewer = null; // { el, cleanup, blobUrl }

/* Resolve a media src. For a LOCKED item this decrypts the bytes in-browser and
   returns a blob: URL — which pins the entire decrypted file in memory until it is
   revoked. We stash it on activeViewer so closeViewer() can revoke it; without
   that, opening/closing locked media leaks the full file size each time (a prime
   cause of the tab freezing "after media playback"). Unlocked items return a plain
   /raw URL (nothing to revoke). */
let _pendingBlobUrl = null;   // blob: URL produced by the last _resolveMediaSrc, claimed by mountViewer
async function _resolveMediaSrc(f) {
  _pendingBlobUrl = null;
  if (f && f.locked && typeof unlockItemForUse === 'function' && typeof _decryptItemBlobUrl === 'function') {
    const pass = await unlockItemForUse(f);
    if (pass == null) return null;
    const url = await _decryptItemBlobUrl(f);
    // remember it so mountViewer can attach it to the new viewer for revocation.
    // (_resolveMediaSrc runs BEFORE mountViewer, which resets activeViewer, so we
    // can't stash directly on activeViewer here.)
    if (typeof url === 'string' && url.startsWith('blob:')) _pendingBlobUrl = url;
    return url;
  }
  const url = mediaUrl(f) || ('/api/files/' + f.id + '/raw');
  // shared Music tracks honor the player's streaming-quality setting (app.js);
  // vault files pass through unchanged
  return (typeof musicStreamUrl === 'function') ? musicStreamUrl(url) : url;
}

function closeViewer() {
  if (activeViewer) {
    if (activeViewer.cleanup) activeViewer.cleanup();
    // release the decrypted-blob URL (if any) so its bytes can be GC'd
    if (activeViewer.blobUrl) { try { URL.revokeObjectURL(activeViewer.blobUrl); } catch (e) {} activeViewer.blobUrl = null; }
    activeViewer.el.remove();
    activeViewer = null;
  }
  const c = document.getElementById('content'); if (c) c.classList.remove('viewer-open');
  try { _currentOpenFile = null; } catch (e) {}   // remote assistant: no file is open anymore
}
function mountViewer(html) {
  closeViewer();
  const el = document.createElement('div');
  el.className = 'viewer';
  el.innerHTML = html;
  const content = document.getElementById('content');
  content.appendChild(el);
  // the viewer fills the content area as a full overlay — freeze the list scroll
  // behind it so scrolling doesn't slide the player off the top (close to resume).
  content.scrollTop = 0;
  content.classList.add('viewer-open');
  activeViewer = { el, cleanup: null, blobUrl: _pendingBlobUrl };
  _pendingBlobUrl = null;   // claimed — don't let it bleed into the next viewer
  return el;
}
function viewerHead(f, extraBtns = '') {
  // share mode is read-only: no star; download only if the link allows it
  const starBtn = SHARE.active ? '' : `<button class="iconbtn" data-vstar title="Star">${svg('star', 18)}</button>`;
  const dlBtn = (!SHARE.active || SHARE.allowDownload) ? `<button class="iconbtn" data-vdl title="Download">${svg('download', 18)}</button>` : '';
  return `<div class="vhead">
    <span class="ti bg-${f.type} t-${f.type}">${svg(f.type, 16, 1.8)}</span>
    <div class="titles"><div class="nm">${esc(f.name)}</div><div class="sub">${(fileExt(f.name) || f.type)} · ${fmtSize(f.size)}${f.dur ? ' · ' + fmtDur(f.dur) : ''}</div></div>
    <div class="spacer"></div>
    ${f.locked ? '<span class="lock-chip">' + svg('lock', 13) + ' Locked</span>' : ''}
    ${extraBtns}
    ${starBtn}
    ${dlBtn}
    <button class="iconbtn" data-vclose title="Close">${svg('close', 18)}</button>
  </div>`;
}
function wireHead(el, f) {
  // If this viewer owns a /database/file/<id> URL, closing it should step the history
  // back (so the address bar returns to the folder/category and Back/Forward stay
  // consistent). popstate → route() → go() then closes the viewer. If the file was
  // opened directly via a deep link (no prior in-app entry to go back to), close the
  // viewer and replace the URL with the file's folder/category so we don't leave the app.
  el.querySelector('[data-vclose]').onclick = () => {
    if (typeof location !== 'undefined' && /^\/database\/file\//.test(location.pathname)) {
      if (typeof _viewerHasHistoryBack === 'function' && _viewerHasHistoryBack()) { history.back(); return; }
      closeViewer();
      if (typeof syncUrl === 'function') { try { syncUrl(true); } catch (e) {} }   // replace file url with current view's url
    } else closeViewer();
  };
  const dl = el.querySelector('[data-vdl]'); if (dl) dl.onclick = () => downloadFile(f.id);
  const star = el.querySelector('[data-vstar]');
  if (star) {
    const sync = () => { star.classList.toggle('on', !!byId(f.id).starred); };
    sync();
    star.onclick = () => { toggleStar(f.id); sync(); };
  }
}

/* shared media clock: drives a scrubber for real OR simulated playback */
function mediaClock({ media, duration, frame, fill, knob, timeEl, onEnd, autoplay = true }) {
  let playing = false, simT = 0, raf = null, last = 0, rate = 1;
  const dur = () => (media && isFinite(media.duration) && media.duration) ? media.duration : duration;
  const cur = () => media ? media.currentTime : simT;
  function paint() {
    // while the user is dragging the scrubber, the preview owns the visuals —
    // don't let the playback paint loop yank the knob back to currentTime.
    if (previewT != null) return;
    const d = dur() || 1, t = Math.min(cur(), d), p = (t / d) * 100;
    fill.style.width = p + '%'; if (knob) knob.style.left = p + '%';
    if (timeEl) timeEl.textContent = `${fmtDur(t)} / ${fmtDur(d)}`;
  }
  function loop(ts) {
    if (!playing) return;
    if (!media) { if (!last) last = ts; simT += ((ts - last) / 1000) * rate; last = ts; if (simT >= dur()) { simT = dur(); playing = false; paint(); onEnd && onEnd(); return; } }
    paint(); raf = requestAnimationFrame(loop);
  }
  function seekTo(t) { const d = dur(); t = Math.max(0, Math.min(d, t)); if (media) media.currentTime = t; else simT = t; last = 0; paint(); }
  // Preview a scrub position WITHOUT issuing a media seek. Dragging the scrubber
  // fires a pointermove per frame; pushing each one to media.currentTime made the
  // browser abort and reopen the /raw Range request dozens of times a second,
  // which froze the tab (esp. Firefox). During a drag we only move the visual
  // fill/knob here and commit the real seek at a throttled rate (see scrubWire).
  let previewT = null;
  function seekFracPreview(fr) {
    fr = Math.max(0, Math.min(1, fr));
    previewT = fr * dur();
    const d = dur() || 1, p = (Math.min(previewT, d) / d) * 100;
    fill.style.width = p + '%'; if (knob) knob.style.left = p + '%';
    if (timeEl) timeEl.textContent = `${fmtDur(Math.min(previewT, d))} / ${fmtDur(d)}`;
  }
  function endPreview() { previewT = null; }
  const api = {
    play() { playing = true; last = 0; if (media) media.play().catch(() => {}); if (!media) raf = requestAnimationFrame(loop); else { raf = requestAnimationFrame(function m(){ if(!playing) return; paint(); raf = requestAnimationFrame(m); }); } api.onstate && api.onstate(true); },
    pause() { playing = false; if (media) media.pause(); cancelAnimationFrame(raf); api.onstate && api.onstate(false); },
    toggle() { playing ? api.pause() : api.play(); },
    seekFrac(fr) { fr = Math.max(0, Math.min(1, fr)); endPreview(); seekTo(fr * dur()); },
    seekFracPreview,
    endPreview,
    seekTo,
    seekBy(delta) { seekTo(cur() + delta); },
    setRate(r) { rate = r; if (media) media.playbackRate = r; },
    getRate: () => rate,
    getTime: cur,
    getDuration: dur,
    isPlaying: () => playing,
    destroy() {
      playing = false; cancelAnimationFrame(raf);
      if (media) {
        // fully release the media element so the browser drops its open stream
        // to /api/.../raw — pausing alone leaves the connection (and a server
        // socket) alive, which accumulates across a long session.
        try { media.pause(); } catch (e) {}
        try { media.removeAttribute('src'); media.load(); } catch (e) {}
      }
    },
    paint,
  };
  if (media) { media.addEventListener('ended', () => { api.pause(); onEnd && onEnd(); }); media.addEventListener('loadedmetadata', paint); }
  paint();
  if (autoplay) api.play();
  return api;
}

/* playback-speed dropdown (reuses the .ctx popup machinery + outside-click close) */
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
function fmtRate(r) { return (r === 1 ? '1' : String(r).replace(/0+$/, '').replace(/\.$/, '')) + '×'; }
function showSpeedMenu(anchor, clock, labelEl, onPick) {
  hideCtx();
  const curR = clock.getRate();
  const menu = document.createElement('div');
  menu.className = 'ctx speed-menu';
  menu.innerHTML = SPEEDS.map(s =>
    `<button data-s="${s}" class="${s === curR ? 'on' : ''}">${s === curR ? svg('check', 14) : '<span class="sp"></span>'} ${fmtRate(s)}</button>`).join('');
  document.body.appendChild(menu);
  ctxEl = menu;
  const r = anchor.getBoundingClientRect(), mr = menu.getBoundingClientRect();
  menu.style.left = Math.min(r.left, innerWidth - mr.width - 10) + 'px';
  menu.style.top = Math.max(10, r.top - mr.height - 6) + 'px';
  menu.querySelectorAll('[data-s]').forEach(b => b.onclick = (e) => {
    e.stopPropagation(); hideCtx();
    const s = parseFloat(b.dataset.s);
    clock.setRate(s); if (labelEl) labelEl.textContent = fmtRate(s); if (onPick) onPick(s);
  });
}

/* ---------------- VIDEO ---------------- */
async function openVideo(id) {
  const f = byId(id);
  const vurl = await _resolveMediaSrc(f);
  const frameInner = vurl
    ? `<video src="${vurl}" playsinline></video>`
    : `<div class="ph"><span class="lbl">video · ${fmtDur(f.dur || 0)} · drop a real file to play</span></div>`;
  const el = mountViewer(`${viewerHead(f)}
    <div class="vbody"><div class="stage">
      <div class="player-frame" id="vframe">
        ${frameInner}
        <div class="controls">
          <div class="scrub" id="vscrub"><div class="fill" id="vfill"></div><div class="knob" id="vknob"></div></div>
          <div class="crow">
            <button class="cbtn" id="vback" title="Back 10s">${svg('back10', 18)}</button>
            <button class="pbtn" id="vplay">${svg('pause', 18)}</button>
            <button class="cbtn" id="vfwd" title="Forward 10s">${svg('fwd10', 18)}</button>
            <span class="time" id="vtime">0:00 / ${fmtDur(f.dur || 0)}</span>
            <span class="spacer"></span>
            <button class="cbtn spd" id="vspeed" title="Playback speed">1×</button>
            <button class="cbtn" id="vmute">${svg('vol', 18)}</button>
            <div class="vol" id="vvol"><div class="fill" style="width:80%"></div></div>
            ${vurl ? `<button class="cbtn" id="vmin" title="Minimize — keep watching while you work">${svg('window', 18)}</button>` : ''}
            <button class="cbtn" id="vfull">${svg('full', 18)}</button>
          </div>
        </div>
      </div>
    </div></div>`);
  wireHead(el, f);
  const media = el.querySelector('video');
  const playBtn = el.querySelector('#vplay');
  let handedOff = false;   // true once the <video> is handed to the persistent mini-player
  const clock = mediaClock({
    media, duration: f.dur || 60, autoplay: false,
    fill: el.querySelector('#vfill'), knob: el.querySelector('#vknob'),
    timeEl: el.querySelector('#vtime'),
    onEnd: () => playBtn.innerHTML = svg('play', 18),
  });
  clock.onstate = (p) => playBtn.innerHTML = svg(p ? 'pause' : 'play', 18);
  clock.play();
  playBtn.onclick = () => clock.toggle();
  el.querySelector('#vframe').addEventListener('click', e => { if (e.target.closest('.controls')) return; clock.toggle(); });
  scrubWire(el.querySelector('#vscrub'), clock);
  el.querySelector('#vback').onclick = () => { clock.seekBy(-10); toast('-10s', 'back'); };
  el.querySelector('#vfwd').onclick = () => { clock.seekBy(10); toast('+10s', 'next'); };
  const vspeed = el.querySelector('#vspeed');
  vspeed.onclick = (e) => { e.stopPropagation(); showSpeedMenu(vspeed, clock, vspeed); };
  // volume
  if (media) {
    const vol = el.querySelector('#vvol'), vfill = vol.firstElementChild, mute = el.querySelector('#vmute');
    const setVol = fr => { fr = Math.max(0, Math.min(1, fr)); media.volume = fr; media.muted = fr === 0; vfill.style.width = fr * 100 + '%'; mute.innerHTML = svg(fr === 0 ? 'volmute' : 'vol', 18); };
    media.volume = 0.8;
    wireBar(vol, setVol);
    mute.onclick = () => setVol(media.muted || media.volume === 0 ? 0.8 : 0);
  } else {
    el.querySelector('#vmute').onclick = () => toast('Demo clip — no audio track');
  }
  const frame = el.querySelector('#vframe');
  el.querySelector('#vfull').onclick = () => { frame.requestFullscreen ? frame.requestFullscreen() : toast('Fullscreen unavailable'); };
  // minimize: hand the live <video> to the persistent mini-player so it keeps
  // playing while you use the rest of the site (cleanup below skips releasing it)
  const minBtn = el.querySelector('#vmin');
  if (minBtn && media) minBtn.onclick = () => {
    handedOff = true;
    const wasPlaying = !media.paused;
    clock.pause();                       // stop the RAF loop without releasing the element
    // transfer blob-URL ownership to the mini-player so closeViewer() doesn't revoke
    // a URL the still-playing <video> depends on; the mini-player revokes it on close.
    const heldBlob = activeViewer && activeViewer.blobUrl;
    if (activeViewer) activeViewer.blobUrl = null;
    if (typeof adoptVideo === 'function') adoptVideo(media, f, heldBlob);
    if (wasPlaying) media.play().catch(() => {});
    closeViewer();
  };

  // ---- fullscreen: bare video, no cursor, no UI; space/click = pause, Esc = exit ----
  function isFs() { return document.fullscreenElement === frame; }
  // idle-cursor: show cursor briefly on move, then hide while in fullscreen
  let idleTimer = null;
  function onFsMove() {
    if (!isFs()) return;
    frame.classList.remove('cursor-hidden');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (isFs()) frame.classList.add('cursor-hidden'); }, 1800);
  }
  function onFsChange() {
    if (isFs()) {
      frame.classList.add('fs-active');
      frame.addEventListener('mousemove', onFsMove);
      onFsMove();
    } else {
      frame.classList.remove('fs-active', 'cursor-hidden');
      frame.removeEventListener('mousemove', onFsMove);
      clearTimeout(idleTimer);
    }
  }
  // space toggles play only while fullscreen (so it doesn't fight the editor etc.)
  function onFsKey(e) {
    if (!isFs()) return;
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); clock.toggle(); onFsMove(); }
    // Esc is handled natively by the browser to exit fullscreen; we stop it from
    // also closing the viewer (see the guarded global Esc handler below).
  }
  document.addEventListener('fullscreenchange', onFsChange);
  window.addEventListener('keydown', onFsKey);

  // arrow keys seek ±10s while the video viewer is open (ignored when typing)
  function onSeekKey(e) {
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); clock.seekBy(-10); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); clock.seekBy(10); }
  }
  window.addEventListener('keydown', onSeekKey);

  activeViewer.cleanup = () => {
    if (!handedOff) clock.destroy();   // when minimized, keep the <video> alive in the mini-player
    document.removeEventListener('fullscreenchange', onFsChange);
    window.removeEventListener('keydown', onFsKey);
    window.removeEventListener('keydown', onSeekKey);
    clearTimeout(idleTimer);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
}

/* Click-or-drag horizontal bar — calls onFrac(0..1) while the pointer moves. */
function wireBar(el, onFrac) {
  if (!el || !onFrac) return;
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const apply = ev => {
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      onFrac(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)));
    };
    apply(e);
    el.setPointerCapture(e.pointerId);
    const move = ev => apply(ev);
    const up = ev => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

/* Scrubbing drives a PREVIEW on every pointermove (cheap, paint-only) and commits
   the real media seek at most every COMMIT_MS, plus once on release. This collapses
   a drag's dozens-of-seeks-per-second into a few, so the browser doesn't abort and
   reopen the /raw Range request fast enough to wedge the tab. A plain click (no
   drag) commits immediately on pointerup. */
function scrubWire(scrub, clock) {
  if (!scrub) return;
  const COMMIT_MS = 150;
  scrub.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    let lastCommit = 0, pendingFr = null, timer = null;
    const fracAt = ev => {
      const r = scrub.getBoundingClientRect();
      if (!r.width) return null;
      return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    };
    const commit = fr => { lastCommit = performance.now(); pendingFr = null; clock.seekFrac(fr); };
    const onMove = ev => {
      const fr = fracAt(ev); if (fr == null) return;
      clock.seekFracPreview(fr);          // instant visual feedback, no network seek
      pendingFr = fr;
      const since = performance.now() - lastCommit;
      if (since >= COMMIT_MS) { commit(fr); }
      else if (!timer) {                   // schedule the trailing commit
        timer = setTimeout(() => { timer = null; if (pendingFr != null) commit(pendingFr); }, COMMIT_MS - since);
      }
    };
    const start = fracAt(e);
    if (start != null) clock.seekFracPreview(start);
    pendingFr = start;
    scrub.setPointerCapture(e.pointerId);
    const up = ev => {
      scrub.releasePointerCapture(ev.pointerId);
      scrub.removeEventListener('pointermove', onMove);
      scrub.removeEventListener('pointerup', up);
      scrub.removeEventListener('pointercancel', up);
      if (timer) { clearTimeout(timer); timer = null; }
      const fr = fracAt(ev);
      clock.seekFrac(fr != null ? fr : (pendingFr != null ? pendingFr : start));  // final, authoritative seek (also ends preview)
    };
    scrub.addEventListener('pointermove', onMove);
    scrub.addEventListener('pointerup', up);
    scrub.addEventListener('pointercancel', up);
  });
}

/* ---------------- AUDIO ---------------- */
async function openAudio(id) {
  let f = byId(id);
  // build playlist from siblings of same type in same parent (or all audio if smart view)
  let playlist = (state.view === 'cat' && state.sub === 'audio') ? allOfType('audio')
    : children(f.parent).filter(x => x.type === 'audio');
  if (!playlist.find(x => x.id === id)) playlist = [f, ...playlist];
  let idx = playlist.findIndex(x => x.id === id);
  let clock = null;
  let mediaBlobUrl = null;   // current track's decrypted-blob URL (locked tracks), revoked on track change/close

  const el = mountViewer(`${viewerHead(f)}
    <div class="vbody">
      <div class="audio-stage">
        <div class="album" id="album">${f.coverUrl ? `<img src="${f.coverUrl}${f.coverVer ? '?v=' + f.coverVer : ''}" alt="" class="cover-img">` : '<div class="ph"><span class="lbl">album art</span></div>'}</div>
        <div class="np-title"><div class="t" id="npT">${esc(f.name)}</div><div class="a" id="npA">${esc(f.artist || 'Unknown artist')} · ${esc(f.album || '')}</div></div>
        <div class="audio-controls">
          <div class="scrub" id="ascrub"><div class="fill" id="afill"></div><div class="knob" id="aknob"></div></div>
          <div class="crow">
            <span class="time" id="atime">0:00 / ${fmtDur(f.dur || 0)}</span>
            <span class="spacer"></span>
            <button class="cbtn" id="ashuf">${svg('shuffle', 17)}</button>
            <button class="cbtn" id="aback" title="Back 10s">${svg('back10', 18)}</button>
            <button class="cbtn" id="aprev">${svg('prev', 20)}</button>
            <button class="pbtn" id="aplay">${svg('pause', 18)}</button>
            <button class="cbtn" id="anext">${svg('next', 20)}</button>
            <button class="cbtn" id="afwd" title="Forward 10s">${svg('fwd10', 18)}</button>
            <button class="cbtn" id="arep">${svg('clock', 17)}</button>
          </div>
          <div class="crow arow2">
            <button class="cbtn spd" id="aspeed" title="Playback speed">1×</button>
            <span class="spacer"></span>
            <button class="cbtn" id="amute" title="Mute">${svg('vol', 17)}</button>
            <div class="vol" id="avol"><div class="fill" style="width:100%"></div></div>
          </div>
        </div>
      </div>
      <div class="vside">
        <div class="vhd"><span class="eyebrow">Up next · ${playlist.length} tracks</span></div>
        <div class="vlist" id="alist"></div>
      </div>
    </div>`);
  wireHead(el, f);

  const album = el.querySelector('#album');
  const playBtn = el.querySelector('#aplay');
  let shuffle = false, media = null, curRate = 1, curVol = 1, muted = false;

  function renderList() {
    el.querySelector('#alist').innerHTML = playlist.map((t, i) => `
      <div class="track ${i === idx ? 'playing' : ''}" data-t="${i}">
        <span class="tn">${i === idx && clock && clock.isPlaying() ? '♪' : String(i + 1).padStart(2, '0')}</span>
        <div class="ti2"><div class="t">${esc(t.name.replace(/\.\w+$/, ''))}</div><div class="a">${esc(t.artist || 'Unknown')}</div></div>
        <span class="d">${fmtDur(t.dur || 0)}</span>
      </div>`).join('');
    el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => load(+b.dataset.t, true));
  }
  /* fully release an <audio> element so it drops its open connection to the
     server. Just removing it from the DOM is not enough — you must clear src
     and call load() or the browser keeps the media resource (and its socket)
     alive. Without this, cycling tracks leaks an audio element + a server
     stream every time, which slowly exhausts the browser AND the server. */
  function teardownMedia() {
    if (!media) return;
    try { media.pause(); } catch (e) {}
    try { media.removeAttribute('src'); media.load(); } catch (e) {}   // forces the browser to release the stream
    try { media.remove(); } catch (e) {}
    media = null;
    // a LOCKED track's src is a decrypted-blob URL — revoke it or each track change
    // leaks the whole decrypted track in memory (a cause of freezing after playback).
    if (mediaBlobUrl) { try { URL.revokeObjectURL(mediaBlobUrl); } catch (e) {} mediaBlobUrl = null; }
  }
  async function load(i, autoplay) {
    if (clock) clock.destroy();
    teardownMedia();   // release the previous track's <audio> + its open stream before making a new one
    idx = (i + playlist.length) % playlist.length;
    f = playlist[idx];
    el.querySelector('#npT').textContent = f.name;
    el.querySelector('#npA').textContent = `${f.artist || 'Unknown artist'} · ${f.album || ''}`;
    el.querySelector('.vhead .nm').textContent = f.name;
    const aurl = await _resolveMediaSrc(f);
    mediaBlobUrl = _pendingBlobUrl; _pendingBlobUrl = null;   // own this track's blob URL for revocation in teardownMedia
    album.innerHTML = f.coverUrl ? `<img src="${f.coverUrl}${f.coverVer ? '?v=' + f.coverVer : ''}" alt="" class="cover-img">`
      : aurl ? `<div class="ph"><span class="lbl">${esc(f.artist || 'audio')}</span></div>`
      : `<div class="ph"><span class="lbl">album art</span></div>`;
    // real audio element if uploaded
    media = null;
    if (aurl) { media = document.createElement('audio'); media.preload = 'metadata'; media.src = aurl; el.appendChild(media); media.volume = muted ? 0 : curVol; }
    clock = mediaClock({
      media, duration: f.dur || 200, autoplay: false,
      fill: el.querySelector('#afill'), knob: el.querySelector('#aknob'), timeEl: el.querySelector('#atime'),
      onEnd: () => next(),
    });
    clock.setRate(curRate);   // carry playback speed across tracks
    clock.onstate = p => { playBtn.innerHTML = svg(p ? 'pause' : 'play', 18); album.classList.toggle('spin', p && window.__albumSpin !== false); renderList(); };
    renderList();
    if (autoplay) clock.play();
    activeViewer.cleanup = () => { if (clock) clock.destroy(); teardownMedia(); };   // closing the player releases the stream
  }
  function next() { void load(shuffle ? Math.floor(Math.random() * playlist.length) : idx + 1, true); }
  function prev() { if (clock && clock.getTime() > 3) { clock.seekTo(0); return; } void load(idx - 1, true); }

  playBtn.onclick = () => clock.toggle();
  el.querySelector('#anext').onclick = next;
  el.querySelector('#aprev').onclick = prev;
  el.querySelector('#aback').onclick = () => { clock.seekBy(-10); toast('-10s', 'back'); };
  el.querySelector('#afwd').onclick = () => { clock.seekBy(10); toast('+10s', 'next'); };
  el.querySelector('#ashuf').onclick = e => { shuffle = !shuffle; e.currentTarget.classList.toggle('on', shuffle); toast(shuffle ? 'Shuffle on' : 'Shuffle off'); };
  el.querySelector('#arep').onclick = () => toast('Repeat — coming soon');

  // playback speed (persists across tracks via curRate)
  const aspeed = el.querySelector('#aspeed');
  aspeed.onclick = (e) => { e.stopPropagation(); showSpeedMenu(aspeed, clock, aspeed, r => { curRate = r; }); };

  // volume
  const avol = el.querySelector('#avol'), avfill = avol.firstElementChild, amute = el.querySelector('#amute');
  function applyVol() {
    const v = muted ? 0 : curVol;
    avfill.style.width = (v * 100) + '%';
    amute.innerHTML = svg(v === 0 ? 'volmute' : 'vol', 17);
    if (media) media.volume = v;
  }
  wireBar(avol, fr => { curVol = fr; muted = curVol === 0; applyVol(); });
  amute.onclick = () => { muted = !muted; if (!muted && curVol === 0) curVol = 1; applyVol(); };

  scrubWire(el.querySelector('#ascrub'), { seekFrac: fr => clock.seekFrac(fr) });
  void load(idx, true);
  applyVol();
}

/* ---------------- IMAGE ---------------- */
/* image types the browser can't render natively (exr/tiff) — shown via the
   server-rendered PNG preview and offered as heightmaps. Mirrors the server's
   PREVIEW_EXTS. */
const PREVIEW_IMG_EXTS = new Set(['exr', 'tif', 'tiff']);
function needsServerPreview(f) {
  return !!f && f.type === 'image' && PREVIEW_IMG_EXTS.has((fileExt(f.name) || '').toLowerCase());
}

async function openImage(id) {
  let f = byId(id);
  let gallery = (state.view === 'cat' && state.sub === 'image') ? allOfType('image')
    : (state.view === 'starred') ? starred().filter(x => x.type === 'image')
    : children(f.parent).filter(x => x.type === 'image');
  if (!gallery.find(x => x.id === id)) gallery = [f];
  let idx = gallery.findIndex(x => x.id === id);
  let zoom = 1;
  let seq = 0;

  const el = mountViewer(`${viewerHead(f, gallery.length > 1 ? `<span class="mono" id="igidx" style="color:var(--ink-faint);font-size:11px;margin-right:6px"></span>` : '')}
    <div class="vbody"><div class="img-stage" id="istage">
      <div class="wrap" id="iwrap"></div>
      <div class="zoombar">
        ${gallery.length > 1 ? `<button id="iprev" title="Previous">${svg('prev', 18)}</button>` : ''}
        <button id="izout">${svg('minus', 18)}</button>
        <span class="z" id="izlbl">100%</span>
        <button id="izin">${svg('plus', 18)}</button>
        <button id="ifit" title="Fit">${svg('zoomfit', 17)}</button>
        ${gallery.length > 1 ? `<button id="inext" title="Next">${svg('next', 18)}</button>` : ''}
      </div>
    </div></div>`);
  wireHead(el, f);

  async function show() {
    const token = ++seq;
    f = gallery[idx]; zoom = 1;
    el.querySelector('.vhead .nm').textContent = f.name;
    const wrap = el.querySelector('#iwrap');
    // EXR/TIFF can't render in an <img>; the server renders a viewable PNG preview
    // (the /poster endpoint). Everything else loads its raw bytes directly.
    const iurl = needsServerPreview(f)
      ? (f.locked ? null : '/api/files/' + f.id + '/poster')
      : await _resolveMediaSrc(f);
    if (token !== seq) return;
    wrap.innerHTML = iurl
      ? `<img src="${iurl}" alt="">`
      : `<div class="phbox"><div class="ph"><span class="lbl">${esc(f.name)} · ${f.w || ''}×${f.h || ''}</span></div></div>`;
    applyZoom();
    const ig = el.querySelector('#igidx'); if (ig) ig.textContent = `${idx + 1} / ${gallery.length}`;
  }
  function applyZoom() { el.querySelector('#iwrap').style.transform = `scale(${zoom})`; el.querySelector('#izlbl').textContent = Math.round(zoom * 100) + '%'; }
  el.querySelector('#izin').onclick = () => { zoom = Math.min(4, zoom + 0.25); applyZoom(); };
  el.querySelector('#izout').onclick = () => { zoom = Math.max(0.25, zoom - 0.25); applyZoom(); };
  el.querySelector('#ifit').onclick = () => { zoom = 1; applyZoom(); };
  const ip = el.querySelector('#iprev'), inx = el.querySelector('#inext');
  if (ip) ip.onclick = () => { idx = (idx - 1 + gallery.length) % gallery.length; void show(); };
  if (inx) inx.onclick = () => { idx = (idx + 1) % gallery.length; void show(); };
  el.querySelector('#istage').addEventListener('wheel', e => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoom = Math.max(0.25, Math.min(4, zoom - e.deltaY * 0.002)); applyZoom(); }, { passive: false });
  void show();
}

/* ---------------- TEXT / CODE EDITOR ---------------- */
const EDITOR_INLINE_CAP = 2 * 1024 * 1024;   // load at most 2MB of text up front; bigger files offer "load full"
const GUTTER_LINE_CAP = 50000;               // beyond this, skip per-line gutter spans so typing stays responsive

/* Extensions that are binary / not meaningfully readable as text. These still
   live in the vault as 'document'-type items (anything that isn't video/audio/
   image/model3d is) and you can still OPEN them — we just don't dump their raw
   bytes into the text editor, where they'd render as garbage and could be huge.
   Instead the editor shows a "not readable" notice with a "Load Anyway" escape
   hatch for the user who really wants to see/edit the bytes as text. */
const BINARY_EXTS = new Set([
  // executables / installers / libraries
  'exe', 'dll', 'so', 'dylib', 'bin', 'msi', 'app', 'apk', 'dmg', 'deb', 'rpm',
  'jar', 'class', 'pyc', 'pyo', 'o', 'a', 'lib', 'wasm', 'elf',   // ('obj' is a 3D model here → model3d viewer)
  // databases
  'sqlite', 'sqlite3', 'db', 'db3', 'mdb', 'accdb', 'dat', 'realm', 'frm', 'myd',
  // archives / compressed
  'zip', 'rar', '7z', 'gz', 'tar', 'tgz', 'bz2', 'xz', 'zst', 'lz', 'cab', 'iso',
  // documents that aren't plain text (office, pdf)
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // images / media not handled by a dedicated viewer
  'psd', 'ai', 'sketch', 'fig', 'ico', 'icns', 'bmp', 'heic', 'raw', 'cr2', 'nef',   // (tif/tiff/exr are images now → openImage)
  'avi', 'wmv', 'flv', 'm4v', 'aac', 'wma', 'aiff', 'opus',
  // misc binary / serialized
  'pak', 'pyd', 'node', 'pdb', 'bson', 'pickle', 'pkl', 'npy', 'npz', 'parquet', 'avro',
]);
/* true if the file's extension is a known binary type the text editor can't read */
function isBinaryDoc(name) {
  const ext = (fileExt(name) || '').toLowerCase();
  return ext !== '' && BINARY_EXTS.has(ext);
}

function openEditor(id) {
  const f = byId(id);
  const lockedMode = !!(f && f.locked);
  // recognize language from the filename (works for existing files too)
  const li = (typeof langForName === 'function') ? langForName(f.name) : { lang: f.lang || 'text', label: 'Plain text', recognized: true };
  const isMd = (li.lang === 'markdown') || (f.lang === 'markdown') || /\.md$/i.test(f.name);
  const isHtml = (li.lang === 'html') || /\.html?$/i.test(f.name);
  const hasPreview = isMd || isHtml;
  let dirty = false, mode = 'edit';
  let truncated = false;                 // true while only the first EDITOR_INLINE_CAP is loaded
  const loadAbort = new AbortController();

  const langBadge = `<span class="ed-lang ${li.recognized ? '' : 'unknown'}" title="${li.recognized ? 'Recognized: ' + esc(li.label) : 'Unrecognized file type — opened as raw text'}">${esc(li.label)}</span>`;
  const warnBar = li.recognized ? '' :
    `<div class="ed-warn" id="edwarn">${svg('info', 14)} <span>Unrecognized file type — showing raw text. Editing still works and saves normally.</span></div>`;

  const el = mountViewer(`${viewerHead(f, hasPreview ? `<div class="seg" id="edmode" style="margin-right:6px"><button data-m="edit" class="on">${svg('code',14)}</button><button data-m="preview">${svg('eye',14)}</button></div>` : '')}
    <div class="vbody"><div class="editor">
      <div class="editor-bar">
        <span class="stat ${SHARE.active || lockedMode ? '' : 'saved'}" id="edstat">${SHARE.active ? 'read-only' : lockedMode ? 'locked' : 'saved'}</span>
        ${langBadge}
        <span class="spacer"></span>
        <span class="stat" id="edmeta"></span>
        ${SHARE.active || lockedMode ? '' : `<button class="btn primary" id="edsave" style="padding:6px 13px">${svg('save', 14)} Save</button>`}
      </div>
      ${warnBar}
      <div class="ed-truncbar" id="edtrunc" style="display:none">${svg('info', 14)} <span class="tt"></span> <button class="btn ghost" id="edloadfull">Load full file</button></div>
      <div class="ed-binblock" id="edbinblock" style="display:none">
        <div class="ed-binicon" id="edbinicon">${svg('document', 30, 1.6)}</div>
        <div class="ed-bintitle">Not readable by the text editor</div>
        <div class="ed-binsub"></div>
        <div class="ed-binacts">
          <button class="btn primary" id="edbinload">Load Anyway</button>
        </div>
      </div>
      <div class="editor-wrap" id="edwrap">
        <div class="gutter" id="edgut"></div>
        <textarea class="editor-area" id="edarea" spellcheck="false" ${SHARE.active || lockedMode ? 'readonly' : ''}></textarea>
      </div>
    </div></div>`);
  wireHead(el, f);

  const area = el.querySelector('#edarea');
  const gutter = el.querySelector('#edgut');
  const stat = el.querySelector('#edstat');
  const meta = el.querySelector('#edmeta');
  const truncBar = el.querySelector('#edtrunc');

  function syncGutter() {
    const lines = area.value.split('\n').length;
    // For very large files, a span-per-line gutter is the freeze risk on every
    // keystroke — fall back to a single placeholder so editing stays responsive.
    if (lines > GUTTER_LINE_CAP) gutter.innerHTML = `<span class="dim">${lines} lines</span>`;
    else gutter.innerHTML = Array.from({ length: lines }, (_, i) => `<span>${i + 1}</span>`).join('');
    gutter.scrollTop = area.scrollTop;
    meta.textContent = `${lines} lines · ${area.value.length} chars` + (truncated ? ' · partial' : '');
  }
  function setDirty(d) { if (SHARE.active) return; dirty = d; stat.textContent = d ? 'unsaved changes' : 'saved'; stat.className = 'stat ' + (d ? 'unsaved' : 'saved'); }
  function save() {
    if (SHARE.active) return;
    if (truncated) { toast('Load the full file before saving', 'close'); return; }   // never save a partial file over the whole one
    saveDoc(f.id, area.value); setDirty(false); toast('Saved to vault'); renderStorage();
  }

  area.addEventListener('input', () => { setDirty(true); syncGutter(); });
  area.addEventListener('scroll', () => gutter.scrollTop = area.scrollTop);
  area.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
    if (e.key === 'Tab') { e.preventDefault(); const s = area.selectionStart, en = area.selectionEnd; area.value = area.value.slice(0, s) + '  ' + area.value.slice(en); area.selectionStart = area.selectionEnd = s + 2; setDirty(true); syncGutter(); }
  });
  const saveBtn = el.querySelector('#edsave'); if (saveBtn) saveBtn.onclick = save;

  // ---- load the document text (inline f.content, or fetched from the blob) ----
  function showTruncBar(show) {
    truncBar.style.display = show ? '' : 'none';
    if (show) truncBar.querySelector('.tt').textContent = `Showing the first ${fmtSize(EDITOR_INLINE_CAP)} of ${fmtSize(f.size)} — editing is disabled until the full file loads.`;
    area.readOnly = SHARE.active || lockedMode || show;
  }
  async function loadText(limit) {
    try {
      const { text, truncated: tr } = await fetchDocText(f, { limit, signal: loadAbort.signal });
      truncated = tr;
      area.value = text;
      if (!tr) { byId(f.id) && (byId(f.id).content = text); }   // cache full text so reopen is instant + save works
      showTruncBar(tr);
      syncGutter(); setDirty(false);
      if (mode === 'preview') renderPreview();
    } catch (e) {
      if (e.name === 'AbortError') return;
      area.value = ''; meta.textContent = 'Could not load file';
      toast('Could not open ' + f.name, 'close');
    }
  }

  // ---- preview (markdown render OR sandboxed HTML iframe) ----
  let pvFrame = null;
  function killPreviewFrame() {
    if (pvFrame) { try { pvFrame.src = 'about:blank'; } catch (e) {} pvFrame.remove(); pvFrame = null; }
  }
  function renderPreview() {
    const wrap = el.querySelector('#edwrap');
    if (isHtml) {
      // sandboxed: scripts run so the page "works", but no same-origin access to
      // the vault's cookies/storage. Rebuilt fresh each time preview is entered.
      killPreviewFrame();
      const frame = document.createElement('iframe');
      frame.className = 'md-preview html-preview'; frame.id = 'edpv';
      frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms allow-modals');
      frame.setAttribute('srcdoc', area.value);
      pvFrame = frame;
      wrap.replaceChildren(frame);
    } else {
      const pv = document.createElement('div'); pv.className = 'md-preview'; pv.id = 'edpv'; pv.innerHTML = mdToHtml(area.value);
      wrap.replaceChildren(pv);
    }
  }
  if (hasPreview) {
    const seg = el.querySelector('#edmode');
    const setMode = (b) => {
      mode = b.dataset.m;
      seg.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('on', x === b));
      if (mode === 'preview') {
        renderPreview();
      } else {
        killPreviewFrame();   // kill any running HTML scripts/timers immediately on leaving preview
        el.querySelector('#edwrap').replaceChildren(gutter, area); syncGutter();
      }
    };
    seg.querySelectorAll('[data-m]').forEach(b => b.onclick = () => setMode(b));
    if (SHARE.active && isMd) setMode(seg.querySelector('[data-m="preview"]'));   // shared markdown opens rendered
  }

  // initial state
  area.value = ''; area.readOnly = true; meta.textContent = '';

  // kick off the actual text load (also used by "Load Anyway" to bypass the binary gate)
  function beginLoad() {
    area.value = 'Loading…'; meta.textContent = 'loading…';
    loadText(EDITOR_INLINE_CAP);
  }

  // Binary / non-text file types (EXE, SQLite, archives, …) aren't dumped into the
  // editor — they'd render as garbage. Show a notice with a "Load Anyway" escape
  // hatch instead. Recognized text/code (LANGS) is never gated, even if the same
  // extension somehow appears in BINARY_EXTS.
  const binBlock = el.querySelector('#edbinblock');
  if (!li.recognized && isBinaryDoc(f.name)) {
    const ext = (fileExt(f.name) || '').toUpperCase();
    const warnEl = el.querySelector('#edwarn');   // the "showing raw text" bar contradicts the binary notice
    el.querySelector('#edwrap').style.display = 'none';
    if (warnEl) warnEl.style.display = 'none';
    binBlock.querySelector('.ed-binsub').textContent =
      `This looks like a ${ext ? ext + ' ' : ''}file (${fmtSize(f.size)}) — a binary format that isn't text, so the editor can't display it.`;
    binBlock.style.display = '';
    meta.textContent = 'binary file';
    // For an executable, show its real embedded icon above the notice (the server
    // extracts it from the PE on first request). If there's no icon (404/error),
    // we just keep the generic document glyph already in place.
    if (f.iconUrl) {
      const iconHost = el.querySelector('#edbinicon');
      const img = document.createElement('img');
      img.className = 'ed-binexe'; img.alt = '';
      img.onload = () => { iconHost.classList.add('has-img'); iconHost.replaceChildren(img); };
      img.src = f.iconUrl;   // onerror: leave the fallback glyph untouched
    }
    binBlock.querySelector('#edbinload').onclick = () => {
      binBlock.style.display = 'none';
      el.querySelector('#edwrap').style.display = '';
      if (warnEl) warnEl.style.display = '';   // now we really are showing raw text — restore the warning
      beginLoad();
    };
  } else {
    beginLoad();
  }

  const loadFullBtn = el.querySelector('#edloadfull');
  if (loadFullBtn) loadFullBtn.onclick = () => { meta.textContent = 'loading full file…'; loadText(0); };

  activeViewer.cleanup = () => {
    loadAbort.abort();
    killPreviewFrame();
    if (dirty && !truncated) saveDoc(f.id, area.value);   // never auto-save a partial file over the whole one
  };
}

/* tiny markdown renderer */
/* HTML-escape helper shared by mdToHtml and the codeblock renderer */
function _mdEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/* language token (```js) -> a friendly label + a download filename extension.
   Kept small + permissive: unknown languages still render, just labelled raw. */
const CODE_LANG = {
  js: ['JavaScript', 'js'], javascript: ['JavaScript', 'js'], jsx: ['JSX', 'jsx'], ts: ['TypeScript', 'ts'], tsx: ['TSX', 'tsx'],
  py: ['Python', 'py'], python: ['Python', 'py'], lua: ['Lua', 'lua'], rb: ['Ruby', 'rb'], ruby: ['Ruby', 'rb'],
  go: ['Go', 'go'], rs: ['Rust', 'rs'], rust: ['Rust', 'rs'], c: ['C', 'c'], h: ['C header', 'h'], cpp: ['C++', 'cpp'], 'c++': ['C++', 'cpp'],
  cs: ['C#', 'cs'], csharp: ['C#', 'cs'], java: ['Java', 'java'], kt: ['Kotlin', 'kt'], swift: ['Swift', 'swift'],
  php: ['PHP', 'php'], sh: ['Shell', 'sh'], bash: ['Bash', 'sh'], zsh: ['Zsh', 'sh'], ps1: ['PowerShell', 'ps1'], powershell: ['PowerShell', 'ps1'],
  sql: ['SQL', 'sql'], html: ['HTML', 'html'], xml: ['XML', 'xml'], css: ['CSS', 'css'], scss: ['SCSS', 'scss'],
  json: ['JSON', 'json'], yaml: ['YAML', 'yaml'], yml: ['YAML', 'yml'], toml: ['TOML', 'toml'], ini: ['INI', 'ini'],
  md: ['Markdown', 'md'], markdown: ['Markdown', 'md'], diff: ['Diff', 'diff'], dockerfile: ['Dockerfile', 'dockerfile'],
  text: ['Text', 'txt'], txt: ['Text', 'txt'], '': ['Code', 'txt'],
};
function codeLangInfo(tok) {
  const key = String(tok || '').trim().toLowerCase();
  return CODE_LANG[key] || [key ? key.toUpperCase() : 'Code', /^[a-z0-9]{1,8}$/i.test(key) ? key : 'txt'];
}
/* Render ONE fenced code block as a collapsible component. `streaming` = the
   block is still being written (closing fence not seen yet) -> show as
   "Coding…" with a small always-collapsed preview. When closed, it's collapsed
   by default with Open / Copy / Download controls. The raw code is stashed
   base64 in a data-attr so the (globally-delegated) buttons need no re-parse. */
/* remembers which code blocks the user expanded, keyed by a stable content hash,
   so a transcript re-render (every streamed token, or sending a new message)
   doesn't collapse a block they opened. */
const _cbOpen = new Set();
function _cbHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return 'cb' + (h >>> 0).toString(36); }
function codeBlockHTML(lang, code, streaming) {
  const [label, ext] = codeLangInfo(lang);
  const lines = code.split('\n');
  const lineCount = code === '' ? 0 : lines.length;
  const preview = _mdEsc(lines.slice(0, 3).join('\n')) + (lines.length > 3 ? '\n…' : '');
  // stash the exact code so Copy/Download are byte-accurate (encodeURIComponent
  // keeps it attribute-safe and unicode-clean; buttons decode on click)
  const payload = encodeURIComponent(code);
  if (streaming) {
    return `<div class="codeblock coding" data-code="${payload}" data-ext="${_mdEsc(ext)}" data-lang="${_mdEsc(label)}">
      <div class="cb-head"><span class="cb-spin"></span><span class="cb-lang">Coding…</span><span class="cb-meta mono">${_mdEsc(label)}</span></div>
      <pre class="cb-preview"><code>${preview || '&nbsp;'}</code></pre>
    </div>`;
  }
  const id = _cbHash(lang + ' ' + code);
  const open = _cbOpen.has(id);
  return `<div class="codeblock${open ? ' open' : ''}" data-cbid="${id}" data-code="${payload}" data-ext="${_mdEsc(ext)}" data-lang="${_mdEsc(label)}">
    <div class="cb-head">
      <button class="cb-toggle" data-cb="toggle" title="${open ? 'Hide code' : 'Show code'}" aria-label="${open ? 'Hide code' : 'Show code'}">${_cbArrow}</button>
      <span class="cb-lang">${_mdEsc(label)}</span>
      <span class="cb-meta mono">${lineCount} line${lineCount === 1 ? '' : 's'}</span>
      <span class="cb-actions">
        <button class="cb-btn" data-cb="copy" title="Copy code">${_cbCopy}<span>Copy</span></button>
        <button class="cb-btn" data-cb="download" title="Download file">${_cbDownload}<span>Download</span></button>
      </span>
    </div>
    <pre class="cb-body"><code>${_mdEsc(code)}</code></pre>
  </div>`;
}
// tiny inline SVGs (self-contained so mdToHtml stays dependency-free / usable anywhere)
const _cbArrow = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
const _cbCopy = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>';
const _cbDownload = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>';

function mdToHtml(src) {
  const esc2 = _mdEsc;
  // Only allow links that are clearly safe: absolute http(s), site-relative (/…),
  // or in-page anchors (#…). Anything else (javascript:, data:, vbscript:, …) would
  // execute on click, so it falls back to a dead "#" href. Note the URL here has
  // already been HTML-escaped by esc2, so `"` can't break out of the attribute and
  // the scheme text is still intact for this test.
  const safeHref = url => /^(https?:\/\/|\/|#)/i.test(url.trim()) ? url : '#';
  const lines = src.split('\n'); let out = '', i = 0;
  const inline = s => esc2(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => `<a href="${safeHref(url)}" target="_blank" rel="noopener">${text}</a>`);
  while (i < lines.length) {
    const start = i;                 // guard: every branch must advance i past here
    let l = lines[i];
    // fenced code block: ```lang … ```  (an UNCLOSED fence while streaming renders
    // as a live "Coding…" preview instead of leaking raw ``` into the prose)
    const fence = l.match(/^\s*```+\s*([^\s`]*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const body = []; i++;
      let closed = false;
      while (i < lines.length) {
        if (/^\s*```+\s*$/.test(lines[i])) { closed = true; i++; break; }
        body.push(lines[i]); i++;
      }
      out += codeBlockHTML(lang, body.join('\n'), !closed);
      continue;
    }
    if (/^\s*$/.test(l)) { i++; continue; }
    if (/^#{1,6}\s/.test(l)) { const lv = l.match(/^#+/)[0].length; out += `<h${lv}>${inline(l.replace(/^#+\s/, ''))}</h${lv}>`; i++; continue; }
    if (/^>\s?/.test(l)) { let buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(inline(lines[i].replace(/^>\s?/, ''))); i++; } out += `<blockquote>${buf.join('<br>')}</blockquote>`; continue; }
    if (/^(-{3,}|\*{3,})$/.test(l.trim())) { out += '<hr>'; i++; continue; }
    if (/^\s*[-*]\s/.test(l)) { let buf = []; while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) { buf.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s/, ''))}</li>`); i++; } out += `<ul>${buf.join('')}</ul>`; continue; }
    if (/^\s*\d+\.\s/.test(l)) { let buf = []; while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) { buf.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s/, ''))}</li>`); i++; } out += `<ol>${buf.join('')}</ol>`; continue; }
    // paragraph: consume lines until a blank or a line that BEGINS a block.
    // (Previously this could stall: a line like "#tag" / "*x" / "-y" matches the
    //  block-start test but no block rule above, so the loop made no progress and
    //  the whole renderer hung. The `start`/`i === start` guard below makes the
    //  current line always get consumed, guaranteeing forward progress.)
    let buf = []; while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*([#>]|[-*]\s|\d+\.\s|-{3,}|\*{3,})/.test(lines[i])) { buf.push(inline(lines[i])); i++; }
    if (i === start) { buf.push(inline(lines[i])); i++; }   // safety net: force-consume one line
    out += `<p>${buf.join('<br>')}</p>`;
  }
  return out;
}

/* ---------------- 3D MODEL VIEWER (GLTF / GLB / OBJ / FBX / STL) ----------------
   three.js + its loaders are big and rarely needed, so they are NOT bundled with
   the app or loaded at boot. We dynamic-import them from a CDN the first time a
   model is opened (cached for the session). Like the tweaks panel, this is the one
   place we accept a CDN dependency; if the network is unavailable the viewer shows
   a clear error instead of breaking the rest of the vault.

   Locked items decrypt to a blob: URL via _resolveMediaSrc (same path as media),
   which closeViewer() revokes. Note: a multi-file .gltf that references external
   .bin/texture files by relative URL can't resolve those from a single blob — use
   .glb (self-contained) for guaranteed-complete scenes; .obj/.fbx/.stl are single
   files and always load whole. */

// three.js version — keep in sync with the import map in index.html
const THREE_VERSION = '0.169.0';
let _threeMod = null;            // cached { THREE, OrbitControls, loaders... }, set on first successful load

async function _loadThree() {
  if (_threeMod) return _threeMod;
  // Resolved via the <script type="importmap"> in index.html. The addon loaders
  // themselves `import ... from "three"`, which only works because of that map.
  const THREE = await import('three');
  const [{ OrbitControls }, { GLTFLoader }, { OBJLoader }, { FBXLoader }, { STLLoader }] = await Promise.all([
    import('three/addons/controls/OrbitControls.js'),
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/loaders/OBJLoader.js'),
    import('three/addons/loaders/FBXLoader.js'),
    import('three/addons/loaders/STLLoader.js'),
  ]);
  _threeMod = { THREE, OrbitControls, GLTFLoader, OBJLoader, FBXLoader, STLLoader };
  return _threeMod;
}

/* Parse model bytes into a THREE.Object3D for the given extension. STL/OBJ return
   raw geometry/groups we wrap in a sensible default material so they're visible. */
function _parseModel(mod, ext, buf, url) {
  const { THREE } = mod;
  const stdMat = () => new THREE.MeshStandardMaterial({ color: 0xb0b4bc, metalness: 0.1, roughness: 0.75, flatShading: false });
  return new Promise((resolve, reject) => {
    try {
      if (ext === 'glb' || ext === 'gltf') {
        new mod.GLTFLoader().parse(buf, url, (g) => resolve(g.scene || g.scenes[0]), reject);
      } else if (ext === 'fbx') {
        resolve(new mod.FBXLoader().parse(buf, url));
      } else if (ext === 'obj') {
        const text = new TextDecoder().decode(buf);
        const obj = new mod.OBJLoader().parse(text);
        // OBJLoader gives meshes a default white MeshPhongMaterial; swap for our standard
        // material so unlit/material-less OBJs still shade nicely under the scene lights.
        obj.traverse(o => { if (o.isMesh) o.material = stdMat(); });
        resolve(obj);
      } else if (ext === 'stl') {
        const geo = new mod.STLLoader().parse(buf);
        if (!geo.attributes.normal) geo.computeVertexNormals();
        resolve(new THREE.Mesh(geo, stdMat()));
      } else {
        reject(new Error('Unsupported 3D format: .' + ext));
      }
    } catch (e) { reject(e); }
  });
}

async function openModel3D(id) {
  const f = byId(id);
  const ext = (fileExt(f.name) || '').toLowerCase();

  const el = mountViewer(`${viewerHead(f)}
    <div class="vbody"><div class="model-stage" id="m3dstage">
      <div class="m3d-overlay" id="m3dload"><div class="m3d-spin"></div><div class="lbl">Loading 3D engine…</div><div class="sub">First model this session — fetching the renderer.</div></div>
      <div class="m3d-hint">drag to orbit · scroll to zoom · right-drag to pan</div>
      <div class="m3dbar" id="m3dbar" style="display:none">
        <button id="m3dreset" title="Reset view">${svg('zoomfit', 16)}</button>
        <button id="m3dwire" title="Wireframe">${svg('cube', 16)}</button>
        <button id="m3dgrid" class="on" title="Toggle grid">${svg('grid', 15)}</button>
        <button id="m3dspin" title="Auto-rotate">${svg('refresh', 15)}</button>
        <span class="sep"></span>
        <span class="m3d-meta" id="m3dmeta"></span>
      </div>
    </div></div>`);
  wireHead(el, f);

  const stage = el.querySelector('#m3dstage');
  const loadEl = el.querySelector('#m3dload');
  const bar = el.querySelector('#m3dbar');

  // disposables collected here so cleanup() releases GPU memory + the WebGL context
  let renderer = null, controls = null, raf = null, ro = null, disposed = false;

  function fail(msg, detail) {
    if (disposed) return;
    loadEl.className = 'm3d-overlay err';
    loadEl.innerHTML = `<div class="lbl">${esc(msg)}</div>${detail ? `<div class="sub">${esc(detail)}</div>` : ''}`;
  }

  try {
    // 1) load three.js (may fail offline) and the model bytes in parallel
    const srcP = _resolveMediaSrc(f);            // blob: for locked, /raw URL otherwise
    const modP = _loadThree();
    const [src, mod] = await Promise.all([srcP, modP]);
    // claim any decrypted-blob URL so closeViewer() revokes it (same contract as media
    // viewers). Do this BEFORE the disposed check so a viewer closed mid-load still has
    // its blob URL revoked rather than leaking into _pendingBlobUrl for the next viewer.
    if (_pendingBlobUrl) {
      if (disposed) { try { URL.revokeObjectURL(_pendingBlobUrl); } catch (_) {} }
      else if (activeViewer) activeViewer.blobUrl = _pendingBlobUrl;
      _pendingBlobUrl = null;
    }
    if (disposed) return;
    if (src == null) { fail('Locked', 'Unlock this item to view the model.'); return; }

    loadEl.querySelector('.lbl').textContent = 'Loading model…';
    loadEl.querySelector('.sub').textContent = f.name;

    const resp = await fetch(src);
    if (!resp.ok) throw new Error('fetch ' + resp.status);
    const buf = await resp.arrayBuffer();
    if (disposed) return;

    const { THREE } = mod;
    const root = await _parseModel(mod, ext, buf, src);
    if (disposed) return;

    // ---- scene ----
    const scene = new THREE.Scene();
    scene.background = null;   // transparent canvas; the CSS gradient shows through
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(4, 8, 6); scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(-6, 2, -4); scene.add(fill);
    scene.add(root);

    // ---- fit camera to the model's bounding box ----
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    // recenter the model at the origin so orbit pivots around it
    root.position.sub(center);

    const w = stage.clientWidth || 800, h = stage.clientHeight || 600;
    const camera = new THREE.PerspectiveCamera(45, w / h, maxDim / 1000, maxDim * 100);
    const dist = maxDim / (2 * Math.tan((Math.PI * camera.fov) / 360)) * 1.6;
    camera.position.set(dist * 0.6, dist * 0.5, dist);
    camera.lookAt(0, 0, 0);

    // ---- renderer ----
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    stage.insertBefore(renderer.domElement, loadEl);

    // ---- ground grid sized to the model ----
    const grid = new THREE.GridHelper(maxDim * 4, 20, 0x555a66, 0x33373f);
    grid.position.y = box.min.y - center.y;   // sit at the model's lowest point (root was recentered on the origin)
    scene.add(grid);

    // ---- orbit controls ----
    controls = new mod.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    controls.minDistance = maxDim * 0.1;
    controls.maxDistance = maxDim * 20;
    controls.update();

    // ---- render loop ----
    let autoSpin = false;
    function tick() {
      if (disposed) return;
      raf = requestAnimationFrame(tick);
      if (autoSpin) root.rotation.y += 0.005;
      controls.update();
      renderer.render(scene, camera);
    }
    tick();

    // ---- resize handling (content area is flexible) ----
    ro = new ResizeObserver(() => {
      const nw = stage.clientWidth, nh = stage.clientHeight;
      if (!nw || !nh) return;
      camera.aspect = nw / nh; camera.updateProjectionMatrix();
      renderer.setSize(nw, nh, false);
    });
    ro.observe(stage);

    // ---- toolbar wiring ----
    loadEl.style.display = 'none';
    bar.style.display = '';
    // count triangles + meshes for the meta readout
    let tris = 0, meshes = 0;
    root.traverse(o => { if (o.isMesh && o.geometry) { meshes++; const g = o.geometry; tris += (g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0)) / 3; } });
    el.querySelector('#m3dmeta').textContent = `${ext.toUpperCase()} · ${meshes} mesh${meshes === 1 ? '' : 'es'} · ${Math.round(tris).toLocaleString()} tris`;

    const homePos = camera.position.clone();
    el.querySelector('#m3dreset').onclick = () => { camera.position.copy(homePos); controls.target.set(0, 0, 0); controls.update(); };

    let wire = false;
    const wireBtn = el.querySelector('#m3dwire');
    wireBtn.onclick = () => {
      wire = !wire; wireBtn.classList.toggle('on', wire);
      root.traverse(o => { if (o.isMesh && o.material) { const mats = Array.isArray(o.material) ? o.material : [o.material]; mats.forEach(m => { m.wireframe = wire; }); } });
    };

    const gridBtn = el.querySelector('#m3dgrid');
    gridBtn.onclick = () => { grid.visible = !grid.visible; gridBtn.classList.toggle('on', grid.visible); };

    const spinBtn = el.querySelector('#m3dspin');
    spinBtn.onclick = () => { autoSpin = !autoSpin; spinBtn.classList.toggle('on', autoSpin); };

  } catch (e) {
    const offline = /Failed to fetch|dynamically imported module|NetworkError|import/i.test(String(e && e.message));
    if (offline && !_threeMod) fail('3D engine unavailable', 'The renderer is loaded from the network the first time. Check your connection and reopen.');
    else fail('Could not display this model', (e && e.message) ? e.message : 'Unsupported or corrupt file.');
  }

  // ---- cleanup: stop the loop, drop the WebGL context, free GPU memory ----
  activeViewer.cleanup = () => {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    if (ro) { try { ro.disconnect(); } catch (_) {} }
    if (controls) { try { controls.dispose(); } catch (_) {} }
    if (renderer) {
      try { renderer.dispose(); } catch (_) {}
      try { renderer.forceContextLoss(); } catch (_) {}
      try { renderer.domElement.remove(); } catch (_) {}
    }
    // the decrypted-blob URL for a locked model (if any) lives on activeViewer.blobUrl
    // and is revoked by closeViewer() — no separate handling needed here.
  };
}

/* ---------------- HEIGHTMAP 3D VIEWER ----------------
   Renders an exr/tiff (or any) image as a displaced 3D terrain. The server decodes
   the image to a downsampled grayscale grid (GET /heightdata → raw gray8 bytes +
   X-Height-W/H headers); we build a plane whose vertices are pushed up by each
   pixel's brightness. Reuses the same three.js module as the model viewer. */
async function openHeightmap(id) {
  const f = byId(id);

  const el = mountViewer(`${viewerHead(f)}
    <div class="vbody"><div class="model-stage" id="hmstage">
      <div class="m3d-overlay" id="hmload"><div class="m3d-spin"></div><div class="lbl">Loading 3D engine…</div><div class="sub">Building the terrain mesh from the image.</div></div>
      <div class="m3d-hint">drag to orbit · scroll to zoom · right-drag to pan</div>
      <div class="m3dbar" id="hmbar" style="display:none">
        <button id="hmreset" title="Reset view">${svg('zoomfit', 16)}</button>
        <button id="hmwire" title="Wireframe">${svg('cube', 16)}</button>
        <button id="hmspin" title="Auto-rotate">${svg('refresh', 15)}</button>
        <span class="sep"></span>
        <label class="hm-hgt" title="Height scale">${svg('model3d', 14)}<input type="range" id="hmscale" min="5" max="120" value="35"></label>
        <span class="sep"></span>
        <span class="m3d-meta" id="hmmeta"></span>
      </div>
    </div></div>`);
  wireHead(el, f);

  const stage = el.querySelector('#hmstage');
  const loadEl = el.querySelector('#hmload');
  const bar = el.querySelector('#hmbar');
  let renderer = null, controls = null, raf = null, ro = null, disposed = false;

  function fail(msg, detail) {
    if (disposed) return;
    loadEl.className = 'm3d-overlay err';
    loadEl.innerHTML = `<div class="lbl">${esc(msg)}</div>${detail ? `<div class="sub">${esc(detail)}</div>` : ''}`;
  }

  try {
    const [resp, mod] = await Promise.all([fetch('/api/files/' + f.id + '/heightdata'), _loadThree()]);
    if (disposed) return;
    if (!resp.ok) {
      let m = 'Could not build the heightmap.';
      try { m = (await resp.json()).error || m; } catch (_) {}
      fail(resp.status === 503 ? 'ffmpeg unavailable' : 'Could not build the heightmap', m);
      return;
    }
    const W = parseInt(resp.headers.get('X-Height-W') || '0', 10);
    const H = parseInt(resp.headers.get('X-Height-H') || '0', 10);
    const data = new Uint8Array(await resp.arrayBuffer());
    if (disposed) return;
    if (!W || !H || data.length !== W * H) { fail('Could not build the heightmap', 'Unexpected pixel data.'); return; }

    const { THREE } = mod;
    const scene = new THREE.Scene();
    scene.background = null;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x33343c, 1.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(6, 10, 4); scene.add(key);

    // plane sized so its longest side is 100 units, subdivided W-1 × H-1 so each
    // vertex maps to one pixel. Built in the XZ plane (rotated flat) with Y = height.
    const span = 100, aspect = W / H;
    const planeW = aspect >= 1 ? span : span * aspect;
    const planeH = aspect >= 1 ? span / aspect : span;
    const geo = new THREE.PlaneGeometry(planeW, planeH, W - 1, H - 1);
    geo.rotateX(-Math.PI / 2);   // lay flat: X right, Z toward camera, Y up
    const pos = geo.attributes.position;
    // vertex order matches row-major pixels (PlaneGeometry rows go top→bottom).
    let hgtScale = 0.35 * (span / 100);
    const applyHeights = (scale) => {
      for (let i = 0; i < pos.count; i++) pos.setY(i, (data[i] / 255) * span * scale);
      pos.needsUpdate = true; geo.computeVertexNormals();
    };
    applyHeights(hgtScale);

    const mat = new THREE.MeshStandardMaterial({ color: 0x9aa3b2, metalness: 0.05, roughness: 0.9, flatShading: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);

    const w = stage.clientWidth || 800, h = stage.clientHeight || 600;
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, span * 20);
    camera.position.set(span * 0.7, span * 0.7, span * 0.9);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    stage.insertBefore(renderer.domElement, loadEl);

    controls = new mod.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    controls.minDistance = span * 0.2; controls.maxDistance = span * 8;
    controls.update();

    let autoSpin = false;
    function tick() {
      if (disposed) return;
      raf = requestAnimationFrame(tick);
      if (autoSpin) mesh.rotation.y += 0.004;
      controls.update();
      renderer.render(scene, camera);
    }
    tick();

    ro = new ResizeObserver(() => {
      const nw = stage.clientWidth, nh = stage.clientHeight;
      if (!nw || !nh) return;
      camera.aspect = nw / nh; camera.updateProjectionMatrix();
      renderer.setSize(nw, nh, false);
    });
    ro.observe(stage);

    loadEl.style.display = 'none';
    bar.style.display = '';
    el.querySelector('#hmmeta').textContent = `Heightmap · ${W}×${H} grid`;

    const homePos = camera.position.clone();
    el.querySelector('#hmreset').onclick = () => { camera.position.copy(homePos); mesh.rotation.y = 0; controls.target.set(0, 0, 0); controls.update(); };

    let wire = false;
    const wireBtn = el.querySelector('#hmwire');
    wireBtn.onclick = () => { wire = !wire; wireBtn.classList.toggle('on', wire); mat.wireframe = wire; };

    const spinBtn = el.querySelector('#hmspin');
    spinBtn.onclick = () => { autoSpin = !autoSpin; spinBtn.classList.toggle('on', autoSpin); };

    el.querySelector('#hmscale').oninput = (e) => { hgtScale = (parseInt(e.target.value, 10) / 100); applyHeights(hgtScale); };

  } catch (e) {
    const offline = /Failed to fetch|dynamically imported module|NetworkError|import/i.test(String(e && e.message));
    if (offline && !_threeMod) fail('3D engine unavailable', 'The renderer loads from the network the first time. Check your connection and reopen.');
    else fail('Could not display this heightmap', (e && e.message) ? e.message : 'Unsupported or corrupt file.');
  }

  activeViewer.cleanup = () => {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    if (ro) { try { ro.disconnect(); } catch (_) {} }
    if (controls) { try { controls.dispose(); } catch (_) {} }
    if (renderer) {
      try { renderer.dispose(); } catch (_) {}
      try { renderer.forceContextLoss(); } catch (_) {}
      try { renderer.domElement.remove(); } catch (_) {}
    }
  };
}

/* ---------------- UNREAL .uasset INSPECTOR ----------------
   A .uasset is a serialized UE package, not a self-contained mesh — the cooked
   geometry lives in a separate .uexp/.ubulk sidecar the vault stores on its own,
   so there's nothing to render from a standalone file. What we CAN do reliably is
   read the package header to identify the asset's class (StaticMesh, Texture2D,
   Material, …) and tell the user what they're looking at. Parsing lives in
   uasset.js (global UASSET); this is read-only (no editor, unlike the .sav path). */
async function openUasset(id) {
  const f = byId(id);
  const ext = (fileExt(f.name) || 'uasset').toLowerCase();

  const el = mountViewer(`${viewerHead(f)}
    <div class="vbody"><div class="uasset-stage" id="uastage">
      <div class="uasset-panel"><div class="ua-kind">Reading…</div>
        <div class="ua-title">Unreal asset</div>
        <div class="ua-msg mono dim">Parsing the package header…</div></div>
    </div></div>`);
  wireHead(el, f);
  const stage = el.querySelector('#uastage');

  // nothing to dispose (no WebGL/RAF/blob) — but set cleanup so closeViewer()'s
  // contract holds and future additions have a hook.
  activeViewer.cleanup = () => {};

  const facts = (info) => {
    const items = [];
    if (info.fileVersionUE5) items.push(`<span class="fact"><b>UE5</b> v${info.fileVersionUE5}</span>`);
    if (info.fileVersionUE4) items.push(`<span class="fact"><b>UE4</b> v${info.fileVersionUE4}</span>`);
    if (info.nameCount) items.push(`<span class="fact"><b>${info.nameCount}</b> names</span>`);
    return items.length ? `<div class="uasset-facts">${items.join('')}</div>` : '';
  };

  try {
    // uasset.js is loaded on demand (not at boot) — fetch it on first open.
    if (typeof UASSET === 'undefined' && typeof loadFeature === 'function') {
      try { await loadFeature('uasset'); } catch (e) {}
    }
    if (typeof UASSET === 'undefined') throw new Error('Asset inspector failed to load.');
    const file = await vaultFileToFile(f);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = UASSET.parse(bytes);

    if (info.isMesh) {
      // a mesh asset — detected, but not renderable from a standalone .uasset
      stage.innerHTML = `<div class="uasset-panel">
        <div class="ua-icon bg-uasset t-uasset">${svg('uasset', 38, 1.6)}</div>
        <div class="ua-kind">${esc(info.label || 'Mesh')} · mesh asset</div>
        <div class="ua-title">${esc(info.label || 'Mesh')} detected</div>
        <div class="ua-msg">This is a mesh <code>.uasset</code>. A standalone <code>.uasset</code> doesn't contain the cooked geometry needed to draw it — that lives in a separate <code>.uexp</code>/<code>.ubulk</code> file — so a 3D preview isn't available here.</div>
        ${facts(info)}
      </div>`;
    } else if (info.assetClass) {
      // recognized non-mesh — name the type, say it's not previewable
      stage.innerHTML = `<div class="uasset-panel">
        <div class="ua-icon bg-uasset t-uasset">${svg('uasset', 38, 1.6)}</div>
        <div class="ua-kind">${esc(info.assetClass)}</div>
        <div class="ua-title">${esc(info.label || info.assetClass)} asset</div>
        <div class="ua-msg">Recognized as an Unreal <code>${esc(info.assetClass)}</code>. Previewing this asset type isn't supported yet — only mesh assets are inspected here, and even those can't be rendered from a lone <code>.uasset</code>.</div>
        ${facts(info)}
      </div>`;
    } else {
      // valid package, but we couldn't pin down the class
      stage.innerHTML = `<div class="uasset-panel">
        <div class="ua-icon bg-uasset t-uasset">${svg('uasset', 38, 1.6)}</div>
        <div class="ua-kind">Unreal package</div>
        <div class="ua-title">Unrecognized asset type</div>
        <div class="ua-msg">This is a valid Unreal <code>.uasset</code> package, but its asset class wasn't one we recognize, so there's nothing to preview.</div>
        ${facts(info)}
      </div>`;
    }
  } catch (e) {
    if (e && e.message === 'cancelled') { closeViewer(); return; }
    stage.innerHTML = `<div class="uasset-panel err">
      <div class="ua-icon bg-uasset t-uasset">${svg('uasset', 38, 1.6)}</div>
      <div class="ua-kind">Couldn't read</div>
      <div class="ua-title">Not a readable .uasset</div>
      <div class="ua-msg">${esc((e && e.message) || 'This file could not be read as an Unreal Engine package.')}</div>
    </div>`;
  }
}

/* keyboard: Esc closes viewer — but if a fullscreen element is active, Esc only
   exits fullscreen (handled natively); don't also close the viewer. */
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && activeViewer && !document.fullscreenElement) { closeViewer(); }
});

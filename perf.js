/* ============================================================
   PERF — adaptive performance tier for low-end devices
   ------------------------------------------------------------
   Picks a rendering tier ('high' | 'mid' | 'low') and stamps it on
   <html data-perf="...">. CSS keys heavy effects (blurs, ambience,
   entrance motion) off that attribute; JS loops (video scrubber,
   video-editor compositor, Fire ambience) read SxPerf.hz().

   Mode is chosen PER DEVICE (localStorage, never synced to the account —
   a phone and a desktop on the same account need different settings):
     auto     — detect from RAM / cores / Save-Data / software GPU, then
                learn from real frame times + dropped video frames
     quality  — always 'high'
     balanced — always 'mid'
     saver    — always 'low'

   Also sets <html data-vplay> while a video is playing so ambience
   animation pauses (the compositor then only has to move video frames).
   Loaded synchronously right after boot-guard so the tier is in place
   before first paint (no flash of heavy effects on a slow device).
   ============================================================ */
(function () {
  'use strict';
  var KEY = 'simplex.perf';            // { mode }
  var LEARN_KEY = 'simplex.perf.learn';// { tier, at } — auto-mode downgrade learned at runtime
  var LEARN_TTL = 7 * 864e5;           // re-test a week later (drivers/browser may improve)
  var MODES = ['auto', 'quality', 'balanced', 'saver'];
  var ORDER = ['low', 'mid', 'high'];
  var MODE_TIER = { quality: 'high', balanced: 'mid', saver: 'low' };
  var root = document.documentElement;

  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function minTier(a, b) { return ORDER[Math.min(ORDER.indexOf(a), ORDER.indexOf(b))]; }
  function lower(t) { return ORDER[Math.max(0, ORDER.indexOf(t) - 1)]; }

  var saved = lsGet(KEY) || {};
  var mode = MODES.indexOf(saved.mode) >= 0 ? saved.mode : 'auto';

  /* ---------- static hardware detection (instant, no work) ---------- */
  var nav = navigator || {};
  var conn = nav.connection || {};
  var mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent || '') || (nav.maxTouchPoints > 1 && /Mac/.test(nav.platform || ''));
  var hw = {
    mem: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,   // GB (Chromium; capped at 8)
    cores: nav.hardwareConcurrency || null,
    saveData: !!conn.saveData,
    mobile: mobile,
    gpu: null,          // filled in lazily (WebGL renderer string)
    softGpu: false,     // software rasterizer = no GPU acceleration at all
    fps: null,          // measured idle frame rate
  };
  function staticTier() {
    if (hw.saveData || hw.softGpu) return 'low';
    if ((hw.mem != null && hw.mem <= 2) || (hw.cores != null && hw.cores <= 2)) return 'low';
    if ((hw.mem != null && hw.mem <= 4) || (hw.cores != null && hw.cores <= 4)) return 'mid';
    return 'high';
  }

  /* learned (runtime) downgrade, auto mode only */
  var learn = lsGet(LEARN_KEY);
  if (learn && (!learn.at || Date.now() - learn.at > LEARN_TTL || ORDER.indexOf(learn.tier) < 0)) { learn = null; lsSet(LEARN_KEY, null); }

  var tier = 'high';
  function computeTier() {
    if (mode !== 'auto') return MODE_TIER[mode];
    var t = staticTier();
    if (learn) t = minTier(t, learn.tier);
    return t;
  }
  function apply(reason) {
    var next = computeTier();
    var changed = next !== tier || root.getAttribute('data-perf') !== next;
    tier = next;
    root.setAttribute('data-perf', tier);
    if (changed) { try { window.dispatchEvent(new CustomEvent('sx-perf', { detail: { tier: tier, mode: mode, reason: reason || '' } })); } catch (e) {} }
  }
  apply('boot');

  function learnDowngrade(reason) {
    if (mode !== 'auto') return false;
    var cur = computeTier();
    if (cur === 'low') return false;
    learn = { tier: lower(cur), at: Date.now(), why: reason };
    lsSet(LEARN_KEY, learn);
    apply(reason);
    return true;
  }

  /* ---------- GPU probe (idle, once) ----------
     A software WebGL renderer (SwiftShader / llvmpipe / "Microsoft Basic Render")
     means the browser has no GPU acceleration: every blur and composited layer is
     painted by the CPU. That is the single strongest "go easy" signal. */
  function probeGpu() {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl', { failIfMajorPerformanceCaveat: false }) || c.getContext('experimental-webgl');
      if (!gl) { hw.gpu = 'none'; hw.softGpu = true; }
      else {
        var ext = gl.getExtension('WEBGL_debug_renderer_info');
        hw.gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
        hw.softGpu = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(hw.gpu);
        var lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();   // free it right away
      }
    } catch (e) {}
    if (hw.softGpu) apply('software-gpu');
  }

  /* ---------- idle frame-rate probe ----------
     ~2s of rAF timing once the page has settled. A device that can't hold ~45fps
     while idle will stutter worse during video, so auto mode steps down a tier. */
  var probing = false;
  function probeFps(done) {
    if (probing || document.hidden) { if (done) done(null); return; }
    probing = true;
    var ts = [], start = 0;
    function f(t) {
      if (document.hidden) { probing = false; if (done) done(null); return; }
      if (!start) start = t;
      ts.push(t);
      if (t - start < 2000) return requestAnimationFrame(f);
      probing = false;
      var d = [];
      for (var i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
      d.sort(function (a, b) { return a - b; });
      var med = d.length ? d[d.length >> 1] : 16.7;
      hw.fps = Math.round(1000 / med);
      // count real hitches too: lots of >50ms frames is a struggling main thread
      var long = 0; for (var j = 0; j < d.length; j++) if (d[j] > 50) long++;
      if (done) done({ fps: hw.fps, long: long, n: d.length });
    }
    requestAnimationFrame(f);
  }
  function autoProbe() {
    probeFps(function (r) {
      if (!r) return;
      if (r.fps < 40 || r.long > Math.max(4, r.n * 0.08)) learnDowngrade('slow-frames');
    });
  }
  function idle(fn, ms) {
    setTimeout(function () { (window.requestIdleCallback || function (cb) { cb(); })(fn, { timeout: 2000 }); }, ms);
  }
  idle(probeGpu, 1500);
  idle(function () { if (mode === 'auto') autoProbe(); }, 6000);

  /* ---------- video playback watchdog ----------
     Watches dropped frames on a playing <video>. In auto mode a struggling
     device steps down a tier on its own (ambience + blurs off, slower UI
     refresh), which frees GPU/CPU for decoding. In a manual mode we only
     suggest Saver once per session instead of overriding the user. */
  var playing = new Set();
  var suggested = false;
  function setVPlay() { if (playing.size) root.setAttribute('data-vplay', ''); else root.removeAttribute('data-vplay'); try { window.dispatchEvent(new CustomEvent('sx-vplay', { detail: { on: !!playing.size } })); } catch (e) {} }
  function notify(msg) { try { if (typeof window.toast === 'function') window.toast(msg, 'info'); } catch (e) {} }
  function watchVideo(v) {
    if (!v || v.__sxPerfWatch) return function () {};
    var last = null, timer = null, strikes = 0;
    function q() {
      try {
        if (v.getVideoPlaybackQuality) { var p = v.getVideoPlaybackQuality(); return { tot: p.totalVideoFrames, drop: p.droppedVideoFrames }; }
        if ('webkitDecodedFrameCount' in v) return { tot: v.webkitDecodedFrameCount + v.webkitDroppedFrameCount, drop: v.webkitDroppedFrameCount };
      } catch (e) {}
      return null;
    }
    function tick() {
      if (v.paused || document.hidden) { last = q(); return; }
      var cur = q(); if (!cur) return;
      if (last && cur.tot - last.tot >= 30) {
        var ratio = (cur.drop - last.drop) / (cur.tot - last.tot);
        strikes = ratio > 0.12 ? strikes + 1 : 0;
        if (strikes >= 2) {            // two bad windows in a row (~6s), not one hiccup
          strikes = 0;
          if (learnDowngrade('dropped-frames')) notify('Playback was stuttering, so Simplex switched to a lighter look for this device.');
          else if (!suggested && mode !== 'auto' && tier !== 'low') { suggested = true; notify('Video is dropping frames. Try Settings → Performance → Saver.'); }
        }
      }
      last = cur;
    }
    function on() { playing.add(v); setVPlay(); if (!timer) { last = q(); timer = setInterval(tick, 3000); } }
    function off() { playing.delete(v); setVPlay(); if (timer) { clearInterval(timer); timer = null; } }
    v.addEventListener('playing', on);
    v.addEventListener('pause', off);
    v.addEventListener('ended', off);
    v.addEventListener('emptied', off);
    v.__sxPerfWatch = true;
    if (!v.paused) on();
    return function stop() { off(); v.removeEventListener('playing', on); v.removeEventListener('pause', off); v.removeEventListener('ended', off); v.removeEventListener('emptied', off); v.__sxPerfWatch = false; };
  }

  /* ---------- memory budget for in-browser decrypts ----------
     Opening a LOCKED video decrypts the whole file into memory (raw + plaintext +
     Blob copy ≈ 3× file size at peak). On a low-RAM phone that can kill the tab.
     Returns a rough safe byte budget for that peak. */
  function memBudget() {
    var gb = hw.mem != null ? hw.mem : (hw.mobile ? 3 : 8);
    var b = gb * 1073741824 * (hw.mobile ? 0.25 : 0.35);
    try { if (performance.memory && performance.memory.jsHeapSizeLimit) b = Math.min(b, performance.memory.jsHeapSizeLimit * 0.9); } catch (e) {}
    return b;
  }

  /* refresh rate for UI loops tied to playback (scrubbers, timeline playheads) */
  var HZ = { high: 60, mid: 24, low: 8 };

  window.SxPerf = {
    MODES: MODES,
    mode: function () { return mode; },
    tier: function () { return tier; },
    hz: function () { return HZ[tier] || 60; },
    setMode: function (m) {
      if (MODES.indexOf(m) < 0) return;
      mode = m; lsSet(KEY, { mode: m });
      apply('user');
    },
    /* forget the learned downgrade and re-measure now (Settings → "Re-check") */
    recheck: function (cb) {
      learn = null; lsSet(LEARN_KEY, null);
      apply('recheck');
      probeFps(function (r) {
        if (r && mode === 'auto' && (r.fps < 40 || r.long > Math.max(4, r.n * 0.08))) learnDowngrade('slow-frames');
        if (cb) cb(r);
      });
    },
    info: function () { return { hw: hw, mode: mode, tier: tier, detected: staticTier(), learned: learn ? learn.tier : null, learnedWhy: learn ? learn.why : null }; },
    watchVideo: watchVideo,
    memBudget: memBudget,
    videoPlaying: function () { return playing.size > 0; },
  };
})();

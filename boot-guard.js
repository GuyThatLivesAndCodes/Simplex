/* ============================================================
   BOOT GUARD + CRASH REPORTER  (lightweight)
   ------------------------------------------------------------
   Loaded FIRST, before any other script, with no dependencies.

   This is a plain single-server site, so the guard is intentionally small:
     - a fetch() wrapper that gives every request a timeout (so a hung
       request can't freeze the UI forever),
     - a global error / unhandledrejection trap that surfaces a real crash
       overlay (with a copyable report) instead of a silent blank screen,
     - the small window.SimplexBoot API the app calls (ready/stage/fatal/…).

   There is no backend health-poller or "reconnecting" banner anymore — the
   frontend and backend are served by the same process, so if the page loaded,
   the backend is up. A genuine JS error still shows the crash overlay and is
   POSTed to /api/crash (vault/crash.log).
   ============================================================ */
(function () {
  'use strict';

  // ---- config ----
  var FETCH_TIMEOUT_MS = 20000;   // default per-request ceiling (long uploads/streams opt out, see below)
  var CRASH_ENDPOINT = '/api/crash';
  var MAX_REPORTS = 6;            // don't spam the server if something throws in a loop

  // Build stamp — bump when boot-guard changes. It appears on every crash/diag
  // report and is logged to the console at load, so we can instantly tell whether
  // the BROWSER is actually running the latest code (vs. a stale, un-reloaded tab).
  var BUILD = 'bg-2026-06-20.4';
  try { console.log('[simplex] boot-guard ' + BUILD + ' loaded'); } catch (e) {}

  var booted = false;
  var reportsSent = 0;
  var lastReportKey = '';
  var STAGE = 'startup';          // updated by the app so a crash report says where we were

  // ============================================================
  // 1. fetch() timeout wrapper — nothing should hang forever.
  //    Streaming / upload / long-poll callers can opt out with
  //    { noTimeout: true } or by passing their own AbortSignal.
  // ============================================================
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      init = init || {};
      // Caller manages its own lifecycle (AbortController for stop/cancel, or a
      // deliberately unbounded request like upload/stream) — don't interfere.
      if (init.signal || init.noTimeout) {
        if (init.noTimeout) { init = Object.assign({}, init); delete init.noTimeout; }
        return nativeFetch(input, init);
      }
      var ms = (typeof init.timeout === 'number') ? init.timeout : FETCH_TIMEOUT_MS;
      if (init.timeout != null) { init = Object.assign({}, init); delete init.timeout; }
      var ctrl;
      try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
      if (!ctrl) return nativeFetch(input, init);
      var to = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, ms);
      var opts = Object.assign({}, init, { signal: ctrl.signal });
      return nativeFetch(input, opts).then(function (r) {
        clearTimeout(to); return r;
      }, function (err) {
        clearTimeout(to);
        // Normalize an aborted-by-timeout into a clearer, reportable error.
        if (err && err.name === 'AbortError') {
          var e = new Error('request timed out after ' + ms + 'ms: ' + describeUrl(input));
          e.code = 'TIMEOUT'; e.url = describeUrl(input);
          throw e;
        }
        throw err;
      });
    };
  }

  function describeUrl(input) {
    try { return typeof input === 'string' ? input : (input && input.url) || String(input); }
    catch (e) { return 'unknown'; }
  }

  // True for our own assets: a relative/protocol-relative path, or an absolute URL
  // whose origin matches the page. Anything on a different host (unpkg, fonts CDN)
  // is treated as external. Defaults to "same origin" only for clearly-relative
  // paths; an absolute URL we can't resolve is treated as external (don't report).
  function isSameOrigin(src) {
    if (!src) return true;                       // empty/unknown: our own inline/resource
    if (src.indexOf('//') !== 0 && src.indexOf('://') < 0) return true;  // relative path
    try {
      var u = new URL(src, location.href);
      return u.origin === location.origin;
    } catch (e) {
      return false;                              // unparseable absolute URL: treat as external
    }
  }

  // ============================================================
  // 2. crash report payload + delivery
  // ============================================================
  // Stringify a thrown value WITHOUT collapsing objects to "[object Object]".
  // A reject({code,...}) or `throw {…}` would otherwise log as the useless
  // "[object Object]" (which is exactly what happened in vault/crash.log). Try
  // JSON first, then a few well-known fields, then fall back to String().
  function describeValue(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.message || String(v);
    try {
      var s = JSON.stringify(v, function (k, val) {
        if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack };
        return val;
      });
      if (s && s !== '{}' && s !== 'null') return s;
    } catch (e) { /* circular / non-serializable — fall through */ }
    if (v.message) return String(v.message);
    if (v.type || v.code) return String(v.type || '') + (v.code ? ' (' + v.code + ')' : '');
    try { return String(v); } catch (e) { return '[unstringifiable]'; }
  }

  function buildReport(kind, detail) {
    return {
      kind: kind,                         // 'error' | 'unhandledrejection' | 'manual'
      stage: STAGE,
      message: detail && detail.message != null ? describeValue(detail.message) : describeValue(detail),
      stack: detail && detail.stack ? String(detail.stack) : null,
      source: detail && detail.source ? String(detail.source) : null,
      line: detail && detail.line != null ? detail.line : null,
      col: detail && detail.col != null ? detail.col : null,
      url: location.href,
      online: navigator.onLine,
      ua: navigator.userAgent,
      ts: new Date().toISOString(),
      booted: booted
    };
  }

  function sendReport(report) {
    if (reportsSent >= MAX_REPORTS) return;
    // de-dupe identical back-to-back errors (e.g. a loop that keeps throwing)
    var key = report.kind + '|' + report.message + '|' + (report.line || '');
    if (key === lastReportKey) return;
    lastReportKey = key; reportsSent++;
    try {
      var body = JSON.stringify(report);
      // sendBeacon survives an imminent reload/navigation; fall back to fetch.
      if (navigator.sendBeacon) {
        var ok = navigator.sendBeacon(CRASH_ENDPOINT, new Blob([body], { type: 'application/json' }));
        if (ok) return;
      }
      if (nativeFetch) {
        nativeFetch(CRASH_ENDPOINT, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: body, keepalive: true
        }).catch(function () {});
      }
    } catch (e) { /* reporting must never throw */ }
  }

  // ============================================================
  // 3. crash overlay — only shown on a genuine error, never a spinner.
  // ============================================================
  function overlayEl() { return document.getElementById('__simplex_guard'); }

  function showOverlay(opts) {
    // opts: { title, body, primaryLabel, onPrimary, secondaryLabel, onSecondary, report }
    if (overlayEl()) return;   // already shown — don't stack
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () { showOverlay(opts); }, { once: true });
      return;
    }
    var wrap = document.createElement('div');
    wrap.id = '__simplex_guard';
    wrap.setAttribute('role', 'alertdialog');
    wrap.setAttribute('aria-live', 'assertive');
    wrap.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'justify-content:center',
      'padding:24px', 'box-sizing:border-box',
      'background:#16140f', 'color:#efeae0',
      'font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      '-webkit-font-smoothing:antialiased'
    ].join(';');

    var reportText = opts.report ? formatReportText(opts.report) : '';
    var card = document.createElement('div');
    card.style.cssText = 'max-width:520px;width:100%;text-align:center';
    card.innerHTML =
      '<div style="display:inline-flex;align-items:center;gap:8px;font:600 12px/1 JetBrains Mono,ui-monospace,monospace;letter-spacing:.28em;color:#e0a64a;margin-bottom:22px">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:#e0a64a;display:inline-block"></span>SIMPLEX</div>' +
      '<h1 style="font-size:21px;font-weight:700;margin:0 0 10px">' + esc(opts.title) + '</h1>' +
      '<p style="font-size:14.5px;line-height:1.6;color:#b8b1a4;margin:0 auto 22px;max-width:430px">' + opts.body + '</p>' +
      '<div id="__guard_actions" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap"></div>' +
      (reportText
        ? '<details style="margin-top:22px;text-align:left">' +
            '<summary style="cursor:pointer;font:500 12px JetBrains Mono,monospace;color:#8a8377;letter-spacing:.04em">Technical details</summary>' +
            '<pre id="__guard_report" style="margin:10px 0 0;padding:12px;background:#0e0d09;border:1px solid #2a261d;border-radius:8px;font:11px/1.5 JetBrains Mono,ui-monospace,monospace;color:#9a9384;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto">' + esc(reportText) + '</pre>' +
            '<button id="__guard_copy" style="margin-top:8px;' + btnCss('ghost') + '">Copy report</button>' +
          '</details>'
        : '');

    wrap.appendChild(card);
    document.body.appendChild(wrap);

    var actions = card.querySelector('#__guard_actions');
    addBtn(actions, opts.primaryLabel || 'Reload', 'primary', opts.onPrimary || function () { location.reload(); });
    if (opts.secondaryLabel) addBtn(actions, opts.secondaryLabel, 'ghost', opts.onSecondary || function () {});

    var copyBtn = card.querySelector('#__guard_copy');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      copyToClipboard(reportText);
      copyBtn.textContent = 'Copied ✓';
      setTimeout(function () { copyBtn.textContent = 'Copy report'; }, 1600);
    });
  }

  function hideOverlay() { var el = overlayEl(); if (el) el.remove(); }

  function btnCss(kind) {
    var base = 'cursor:pointer;border-radius:9px;padding:10px 18px;font:600 13.5px Inter,system-ui,sans-serif;transition:filter .12s,background .12s;';
    if (kind === 'primary') return base + 'background:#e0a64a;color:#1a160d;border:1px solid #e0a64a';
    return base + 'background:transparent;color:#d8d2c6;border:1px solid #3a352a';
  }
  function addBtn(parent, label, kind, onClick) {
    var b = document.createElement('button');
    b.textContent = label; b.style.cssText = btnCss(kind);
    b.addEventListener('click', onClick);
    b.addEventListener('mouseenter', function () { b.style.filter = 'brightness(1.08)'; });
    b.addEventListener('mouseleave', function () { b.style.filter = ''; });
    parent.appendChild(b);
    return b;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function formatReportText(r) {
    return [
      'kind:    ' + r.kind,
      'stage:   ' + r.stage,
      'message: ' + r.message,
      r.source ? 'source:  ' + r.source + (r.line != null ? ':' + r.line : '') : null,
      'online:  ' + r.online,
      'time:    ' + r.ts,
      r.stack ? '\n' + r.stack : null
    ].filter(Boolean).join('\n');
  }
  function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return; }
    } catch (e) {}
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    } catch (e) {}
  }

  // True for our fetch-timeout sentinel or a network failure reaching the backend.
  function isBackendConnectivityError(err) {
    if (!err) return false;
    if (err.code === 'TIMEOUT') return true;
    var msg = (err.message || String(err)).toLowerCase();
    return msg.indexOf('failed to fetch') >= 0 || msg.indexOf('networkerror') >= 0 ||
           msg.indexOf('load failed') >= 0 || msg.indexOf('timed out') >= 0;
  }

  function showCrash(report) {
    var offline = !navigator.onLine;
    showOverlay({
      title: offline ? 'You appear to be offline' : 'Something went wrong loading Simplex',
      body: offline
        ? 'We can’t reach the server right now. Check your connection and reload.'
        : 'The page hit an unexpected error while starting up. You can try again, or reload the page.',
      primaryLabel: 'Reload',
      onPrimary: function () { location.reload(); },
      secondaryLabel: 'Try again',
      onSecondary: function () { hideOverlay(); retryBoot(); },
      report: report
    });
  }

  function retryBoot() {
    // Prefer an app-provided re-entry so we don't have to do a full reload.
    if (window.SimplexBoot && typeof window.SimplexBoot._retry === 'function') {
      try { window.SimplexBoot._retry(); return; } catch (e) {}
    }
    location.reload();
  }

  // ============================================================
  // 4. global error traps
  // ============================================================
  window.addEventListener('error', function (ev) {
    // Resource load errors (e.g. a CDN <script>, a font, or an <img> 404) arrive
    // as an 'error' event whose target is the element, not a JS exception. These
    // do NOT crash the app — only a hard JS error should. Report them under a
    // distinct kind ('resource') so they're never confused with a real crash, and
    // skip the ones we already expect to be flaky and handle ourselves.
    if (ev && ev.target && (ev.target.tagName === 'SCRIPT' || ev.target.tagName === 'LINK' || ev.target.tagName === 'IMG')) {
      var src = ev.target.src || ev.target.href || '';
      // Only report SAME-ORIGIN asset failures (a genuinely missing /app.js etc.
      // that we'd want to know about). The optional tweaks-panel CDN deps
      // (React/ReactDOM/Babel on unpkg) and Google Fonts are 3rd-party,
      // non-essential, already handle their own onerror, and are expected to be
      // occasionally flaky — reporting a unpkg blip or an SRI mismatch as a
      // "failure" is pure noise, so skip anything cross-origin.
      if (isSameOrigin(src)) {
        sendReport(buildReport('resource', { message: 'failed to load resource', source: src }));
      }
      return;   // let the app keep going regardless
    }
    var report = buildReport('error', {
      message: ev && ev.message, stack: ev && ev.error && ev.error.stack,
      source: ev && ev.filename, line: ev && ev.lineno, col: ev && ev.colno
    });
    sendReport(report);
    if (!booted) showCrash(report);   // a throw before boot = blank screen; surface it
  }, true);

  window.addEventListener('unhandledrejection', function (ev) {
    var reason = ev && ev.reason;
    var report = buildReport('unhandledrejection', {
      message: reason && reason.message ? reason.message : reason,
      stack: reason && reason.stack
    });
    sendReport(report);
    if (!booted) showCrash(report);
  });

  // ============================================================
  // 4b. CLIENT-SIDE WATCHDOG — catch a frozen/leaking TAB (not the server)
  //   The backend can be perfectly healthy while the PAGE freezes (a blocked main
  //   thread or a memory leak in the tab). This watchdog runs a 1s timer: if it
  //   fires late, the main thread was blocked for ~that long. It also samples JS
  //   heap, DOM node count, and live <audio>/<video> elements every few seconds and
  //   keeps a ring buffer. On a long block (or via SimplexBoot.diag()) it POSTs the
  //   recent samples to /api/crash so a freeze leaves a trail in vault/crash.log.
  // ============================================================
  var TICK_MS = 1000;
  var BLOCK_MS = 2000;          // a tick this late = the tab was frozen ~this long
  var SAMPLE_EVERY = 3;         // sample heap/DOM every N ticks (~3s)
  var RING = 40;                // keep ~2 min of samples
  var samples = [];
  var lastTick = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  var tickN = 0;
  var blockReportsSent = 0;
  // A backgrounded tab has its setInterval throttled by the browser, so the next
  // tick fires seconds late and `lag` looks like a huge freeze that never happened.
  // Track whether the tab was hidden at any point across the current interval so we
  // can discount that time instead of crying wolf.
  var hiddenSinceTick = (typeof document !== 'undefined' && document.hidden) || false;
  // Firefox (and others) throttle timers for an UNFOCUSED tab even when it is still
  // `document.hidden === false` (e.g. another window is on top, but the tab is on a
  // visible part of the screen — exactly "listening to music with the tab not
  // focused"). That throttle makes the next tick fire seconds late and looks like a
  // multi-second freeze that never happened. `document.hidden` alone misses it, so we
  // ALSO taint the interval whenever the page lacks focus. Initialized from the
  // current focus state in case we load unfocused.
  var blurSinceTick = (typeof document !== 'undefined' && typeof document.hasFocus === 'function') ? !document.hasFocus() : false;
  // Recent long tasks (>50ms) — the substance behind a freeze. Filled by the Long
  // Tasks API (Chromium) and/or a requestAnimationFrame wrapper (Firefox fallback).
  var longTasks = [];
  var LT_RING = 30;
  function pushLongTask(rec) { longTasks.push(rec); if (longTasks.length > LT_RING) longTasks.shift(); }
  // Hook the app can call to record that one of its OWN heavy functions ran long
  // (e.g. render, loadDB). Safe, opt-in, and names the exact app function in a freeze
  // report — covers sync click handlers that the timer/rAF wraps can't see.
  window.__sxMark = function (label, ms) {
    if (typeof ms === 'number' && ms > 50) pushLongTask({ t: new Date().toISOString(), durMs: Math.round(ms), start: Math.round(nowMs() - ms), attr: 'app:' + label });
  };

  // Track the last user interaction so a freeze report can name what the user was
  // doing right before the main thread locked up (the trigger). Captured globally
  // in the capture phase so it sees the event even before app handlers run.
  var lastAction = '-';
  function describeTarget(el) {
    try {
      if (!el || !el.tagName) return '?';
      var id = el.id ? '#' + el.id : '';
      var cls = (typeof el.className === 'string' && el.className) ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      var data = el.dataset && Object.keys(el.dataset)[0] ? '[data-' + Object.keys(el.dataset)[0] + ']' : '';
      var txt = (el.textContent || '').trim().slice(0, 24);
      return (el.tagName.toLowerCase() + id + cls + data + (txt ? ' "' + txt + '"' : '')).slice(0, 80);
    } catch (e) { return '?'; }
  }
  function recordAction(type) {
    return function (ev) { try { lastAction = type + ' ' + describeTarget(ev && ev.target); } catch (e) {} };
  }
  try {
    document.addEventListener('click', recordAction('click'), true);
    document.addEventListener('keydown', recordAction('key'), true);
    // When the tab goes hidden, mark the interval tainted. When it returns, reset the
    // clock so the throttled catch-up gap isn't counted as a freeze on the first tick.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) hiddenSinceTick = true;
      else lastTick = nowMs();
    }, true);
    // Same treatment for focus: losing focus taints the interval (timers may be
    // throttled); regaining it resets the clock so the catch-up gap on the first
    // tick back isn't miscounted as a freeze.
    window.addEventListener('blur', function () { blurSinceTick = true; }, true);
    window.addEventListener('focus', function () { lastTick = nowMs(); }, true);
  } catch (e) {}

  // Read the app's current view without depending on it existing.
  function appView() {
    try {
      var a = (typeof window.currentApp !== 'undefined') ? window.currentApp : '?';
      var s = window.state || {};
      return a + (s.view ? '/' + s.view : '') + (s.sub ? ':' + s.sub : '');
    } catch (e) { return '?'; }
  }

  function nowMs() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }

  // ---- Long-task capture: name WHAT ran long, not just that something did ----
  // Chromium: the Long Tasks API reports tasks >50ms with attribution (which
  // frame/script). Firefox has no longtask support, so we ALSO wrap rAF (boot-guard
  // loads first, before viewers/app register their loops) to time each callback —
  // this labels the mediaClock scrubber loop and the thumbnail sweeps.
  try {
    if (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes
        && PerformanceObserver.supportedEntryTypes.indexOf('longtask') >= 0) {
      new PerformanceObserver(function (list) {
        var es = list.getEntries();
        for (var i = 0; i < es.length; i++) {
          var e = es[i], a = e.attribution && e.attribution[0];
          pushLongTask({
            t: new Date().toISOString(), durMs: Math.round(e.duration), start: Math.round(e.startTime),
            attr: a ? (a.containerType + (a.containerName ? ':' + a.containerName : '') + (a.containerId ? '#' + a.containerId : '')) : 'longtask'
          });
        }
      }).observe({ entryTypes: ['longtask'] });
    }
  } catch (e) {}
  try {
    if (window.requestAnimationFrame) {
      var _raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = function (cb) {
        return _raf(function (ts) {
          var s = nowMs();
          try { return cb(ts); }
          finally { var d = nowMs() - s; if (d > 50) pushLongTask({ t: new Date().toISOString(), durMs: Math.round(d), start: Math.round(s), attr: 'raf' }); }
        });
      };
    }
  } catch (e) {}

  // Wrap setTimeout/setInterval so a slow timer callback (e.g. a poll tick, a
  // crossfade/seek timer, a deferred render) is timed and named. boot-guard loads
  // first, so this catches timers the app registers later.
  function timeWrap(label, fn) {
    if (typeof fn !== 'function') return fn;
    return function () {
      var s = nowMs();
      try { return fn.apply(this, arguments); }
      finally { var d = nowMs() - s; if (d > 50) pushLongTask({ t: new Date().toISOString(), durMs: Math.round(d), start: Math.round(s), attr: label }); }
    };
  }
  try {
    var _setTimeout = window.setTimeout;
    window.setTimeout = function (fn, ms) { arguments[0] = timeWrap('setTimeout', fn); return _setTimeout.apply(window, arguments); };
    var _setInterval = window.setInterval;
    window.setInterval = function (fn, ms) { arguments[0] = timeWrap('setInterval', fn); return _setInterval.apply(window, arguments); };
  } catch (e) {}

  // NOTE: we deliberately do NOT wrap EventTarget.addEventListener. Pairing a wrapper
  // back to the original for removeEventListener is error-prone (same fn on multiple
  // targets / options) and a botched removal would leak listeners app-wide — a worse
  // bug than the one we're diagnosing. Instead, a slow EVENT handler is attributed via
  // (a) the existing `lastAction` capture (names the click/keydown target), plus (b) the
  // rAF + timer wraps above, which catch the work most handlers actually defer into.
  // The browser itself also charges most listener time to the dispatching task, which a
  // Chromium Long Task picks up. If a freeze is purely inside a sync click handler with
  // no timer/rAF, `lastAction` + the tiny suspect surface narrow it down.

  function snapshot(lag) {
    var mem = (performance && performance.memory) ? performance.memory : null;
    return {
      t: new Date().toISOString(),
      stage: STAGE,
      app: appView(),
      action: lastAction,
      lagMs: Math.round(lag),
      domNodes: (document.getElementsByTagName('*') || []).length,
      media: document.querySelectorAll('audio,video').length,
      blobImgs: document.querySelectorAll('img[src^="blob:"]').length,
      heapMB: mem ? Math.round(mem.usedJSHeapSize / 1e6) : null,
      heapLimitMB: mem ? Math.round(mem.jsHeapSizeLimit / 1e6) : null,
      hidden: document.hidden
    };
  }
  function pushSample(s) { samples.push(s); if (samples.length > RING) samples.shift(); }

  function reportClientDiag(reason) {
    if (blockReportsSent >= 4) return;   // don't spam if it keeps stuttering
    blockReportsSent++;
    var latest = samples[samples.length - 1] || snapshot(0);
    try {
      var body = JSON.stringify({
        kind: 'clientdiag',
        stage: STAGE,
        // headline names the BUILD (so we know the tab is on fresh code), WHERE
        // (app/view), and the last user action before the block
        message: '[' + BUILD + '] ' + reason + ' | app=' + latest.app + ' lastAction=' + latest.action
          + ' | heap=' + latest.heapMB + 'MB dom=' + latest.domNodes + ' media=' + latest.media + ' blobImgs=' + latest.blobImgs
          + ' | longTasks=' + longTasks.length
          + (longTasks.length ? ' top=' + longTasks.slice(-3).map(function (l) { return l.durMs + 'ms(' + l.attr + ')'; }).join(',') : ''),
        // pack the recent ring + the long tasks into the stack field (server caps it at 4000 chars)
        stack: samples.map(function (s) {
          return s.t + ' lag=' + s.lagMs + 'ms app=' + s.app + ' heap=' + s.heapMB + 'MB dom=' + s.domNodes
            + ' media=' + s.media + ' blobImgs=' + s.blobImgs + (s.hidden ? ' (hidden)' : '') + ' act=' + s.action;
        }).join('\n')
          + (longTasks.length
              ? '\n--- long tasks (>50ms) ---\n' + longTasks.map(function (l) { return l.t + ' dur=' + l.durMs + 'ms start=' + l.start + ' attr=' + l.attr; }).join('\n')
              : ''),
        url: location.href, online: navigator.onLine, ua: navigator.userAgent,
        ts: new Date().toISOString(), booted: booted
      });
      if (navigator.sendBeacon) { if (navigator.sendBeacon(CRASH_ENDPOINT, new Blob([body], { type: 'application/json' }))) return; }
      if (nativeFetch) nativeFetch(CRASH_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
    } catch (e) { /* never throw from the watchdog */ }
  }

  function watchdogTick() {
    var now = nowMs();
    var lag = now - lastTick - TICK_MS;   // how late this tick fired = main-thread block
    lastTick = now;
    tickN++;
    // If the tab was hidden OR unfocused at any point this interval, the lag is
    // browser timer throttling, not a real freeze — discount it and never report it.
    // Only a block that happened entirely while the tab was VISIBLE AND FOCUSED is a
    // genuine user-facing hang. (Unfocused-but-visible is the "listening to music in
    // a background window" case that produced phantom multi-second block reports.)
    var hasFocus = (typeof document.hasFocus === 'function') ? document.hasFocus() : true;
    var throttled = hiddenSinceTick || document.hidden || blurSinceTick || !hasFocus;
    hiddenSinceTick = document.hidden;    // reset for the next interval
    blurSinceTick = !hasFocus;
    if (throttled) lag = 0;
    if (tickN % SAMPLE_EVERY === 0 || lag >= BLOCK_MS) pushSample(snapshot(lag));
    if (lag >= BLOCK_MS && !document.hidden && hasFocus) reportClientDiag('main-thread blocked ~' + Math.round(lag) + 'ms');
  }
  // setInterval keeps ~real cadence; a frozen tab makes the NEXT tick fire late,
  // which is exactly what we measure. (It can't run DURING a freeze, but it reports
  // the moment the thread frees up — and the heap/DOM trend leading in is captured.)
  try { setInterval(watchdogTick, TICK_MS); } catch (e) {}
  pushSample(snapshot(0));

  // ============================================================
  // 5. public API for the app
  // ============================================================
  window.SimplexBoot = {
    // Manually dump the recent client-diagnostic samples to vault/crash.log.
    diag: function () { reportClientDiag('manual diag dump'); return samples.slice(); },
    // The app calls this once it has painted a usable screen.
    ready: function () { booted = true; hideOverlay(); },
    // Update the current phase so a crash report says where we were.
    stage: function (name) { STAGE = String(name || STAGE); },
    // Let the app surface a boot error itself (e.g. its boot catch). A transient
    // connectivity blip AFTER a usable screen is already painted shouldn't throw
    // up a scary overlay — just log it and leave the UI up (reload re-runs boot).
    // Only a genuine error, or a failure before any screen painted, overlays.
    fatal: function (err) {
      var report = buildReport('manual', { message: err && err.message ? err.message : err, stack: err && err.stack });
      sendReport(report);
      if (booted && isBackendConnectivityError(err)) return;
      showCrash(report);
    },
    // The app registers a no-reload retry entry point here.
    onRetry: function (fn) { window.SimplexBoot._retry = fn; },
    // Kept for API compatibility; there is no backend monitor in a single-server
    // setup, so this never fires. Reload re-runs the app's recovery path.
    onBackendUp: function () {},
    // Backend is up whenever the page is up (same process serves both).
    backendUp: function () { return true; },
    isBooted: function () { return booted; }
  };
})();

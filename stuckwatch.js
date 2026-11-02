/* ============================================================
   STUCK WATCH — names what froze the server, WHILE it is frozen.

   The in-loop block detector in server.js can only report a freeze after it
   ends, and only lists requests still in flight then — a synchronous handler
   starts and finishes inside the freeze, so it never shows up. A freeze that
   never ends (the server looks "silently crashed" until someone kills it)
   leaves no trace at all.

   This module runs a tiny worker thread. The main thread bumps a shared counter
   every 250ms and keeps a short label of what it is doing right now (the
   request it is handling, a program it is starting, a database statement, a
   console write). When the counter stops moving, the WORKER — which keeps
   running while the main thread is stuck — writes to diag.log:

     *** MAIN THREAD STUCK 12s — doing: <label> <hint> | last request … | memory …
         at <function> (<file>:<line>)            ← the actual JavaScript stack
         …

   The stack comes from the inspector: while a risky request is running (armed
   by server.js — AI chats and writes that take >1.5s), the worker keeps a
   debugger session attached to the main thread; on a freeze it pauses it, reads
   the call stack and resumes it at once. The session must be attached BEFORE the
   freeze (a stuck thread can't process the attach), and is detached when nothing
   risky is running, so normal use pays nothing.

   Hints for the usual Windows causes:
     console write   → the server window is in text-selection mode ("QuickEdit")
     spawn …         → Windows (often antivirus) is holding a new process at start
     db: …           → a database write is waiting on the file (antivirus scans)

   install() patches console/child_process/better-sqlite3 so labels are set; it
   must run before other modules grab references to those functions. start()
   launches the worker once the log path is known; arm(fn) tells it when to keep
   the debugger attached.
   ============================================================ */
'use strict';
const { Worker } = require('worker_threads');

const LABEL_BYTES = 240, HEAD = 32;
const sab = new SharedArrayBuffer(HEAD + LABEL_BYTES * 2);
const ints = new Int32Array(sab, 0, HEAD / 4);       // [beat, doingLen, lastReqLen, lastReqAtSec, armed]
const doingBuf = new Uint8Array(sab, HEAD, LABEL_BYTES);
const lastReqBuf = new Uint8Array(sab, HEAD + LABEL_BYTES, LABEL_BYTES);
const enc = new TextEncoder();

function put(buf, slot, s) {
  const b = enc.encode(String(s || '').slice(0, 200));
  const n = Math.min(b.length, LABEL_BYTES);
  buf.set(b.subarray(0, n));
  Atomics.store(ints, slot, n);
}
let current = '';
/* run fn with `what` as the main thread's current activity */
function doing(what, fn) {
  const prev = current;
  current = what; put(doingBuf, 1, what);
  try { return fn(); }
  finally { current = prev; put(doingBuf, 1, prev); }
}
/* remember the latest request (shown as context when the thread is stuck in a callback) */
function sawRequest(what) { put(lastReqBuf, 2, what); Atomics.store(ints, 3, Math.floor(Date.now() / 1000)); }

let installed = false;
function install() {
  if (installed) return; installed = true;
  // console writes (stdout/stderr) — the QuickEdit trap on Windows
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream);
    stream.write = (...a) => doing('console write', () => orig(...a));
  }
  // starting programs — CreateProcess runs on the main thread
  const cp = require('child_process');
  for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const orig = cp[fn]; if (typeof orig !== 'function') continue;
    cp[fn] = function (cmd, ...rest) { return doing(`spawn ${String(cmd).split(/[\\/]/).pop().slice(0, 60)}${fn.endsWith('Sync') ? ' (waits for it to finish)' : ''}`, () => orig.call(this, cmd, ...rest)); };
  }
  // database statements (better-sqlite3 is synchronous)
  try {
    const Database = require('better-sqlite3');
    const probe = new Database(':memory:');
    const proto = Object.getPrototypeOf(probe.prepare('select 1'));
    for (const fn of ['run', 'get', 'all', 'iterate']) {
      const orig = proto[fn]; if (typeof orig !== 'function') continue;
      proto[fn] = function (...a) { return doing('db: ' + String(this.source || '').replace(/\s+/g, ' ').slice(0, 80), () => orig.apply(this, a)); };
    }
    const dproto = Object.getPrototypeOf(probe);
    for (const fn of ['exec', 'pragma']) {
      const orig = dproto[fn]; if (typeof orig !== 'function') continue;
      dproto[fn] = function (sql, ...a) { return doing('db: ' + String(sql).replace(/\s+/g, ' ').slice(0, 80), () => orig.call(this, sql, ...a)); };
    }
    probe.close();
  } catch (e) { /* better-sqlite3 missing — nothing to label */ }
}

const WORKER = `
const { workerData } = require('worker_threads');
const fs = require('fs'), os = require('os'), inspector = require('inspector');
const { sab, logPath, stuckMs, LABEL_BYTES, HEAD, root } = workerData;
const ints = new Int32Array(sab, 0, HEAD / 4);
const doingBuf = new Uint8Array(sab, HEAD, LABEL_BYTES), lastReqBuf = new Uint8Array(sab, HEAD + LABEL_BYTES, LABEL_BYTES);
const dec = new TextDecoder();
const read = (buf, slot) => dec.decode(buf.slice(0, Atomics.load(ints, slot)));
const hint = d => /^console/.test(d) ? ' — the server window is probably in text-selection mode (QuickEdit): click it and press Esc'
  : /^spawn/.test(d) ? ' — Windows is holding a program launch (often antivirus scanning it)'
  : /^db:/.test(d) ? ' — a database statement is waiting (antivirus scanning the database file can cause this)'
  : !d ? ' — inside an async callback or timer (no label)' : '';
const write = line => { try { fs.appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + line + '\\n'); } catch (e) {} };
const mb = n => Math.round(n / 1048576);
const memLine = () => { let rss = 0; try { rss = process.memoryUsage.rss(); } catch (e) {} return 'memory: process ' + mb(rss) + 'MB, PC free ' + mb(os.freemem()) + ' of ' + mb(os.totalmem()) + 'MB'; };

/* debugger session, attached only while the main thread is armed */
let sess = null, enabled = false, detachAt = 0, capturing = false;
const scripts = new Map();   // scriptId -> url (paused frames carry only the id)
function attach() {
  if (sess) return;
  try { sess = new inspector.Session(); sess.connectToMainThread(); } catch (e) { sess = null; return; }
  sess.on('Debugger.scriptParsed', ({ params }) => { if (params.url) scripts.set(params.scriptId, params.url); });
  sess.post('Debugger.enable', err => { enabled = !err; });
}
function detach() {
  if (!sess || capturing) return;
  const s = sess; sess = null; enabled = false; scripts.clear();
  try { s.post('Debugger.disable', () => { try { s.disconnect(); } catch (e) {} }); } catch (e) { try { s.disconnect(); } catch (e2) {} }
}
const short = u => { if (!u) return '(native)'; let p = String(u); try { p = decodeURIComponent(p); } catch (e) {} return p.split(/[\\\\/]/).slice(-2).join('/'); };
function captureStack() {
  if (!sess || !enabled || capturing) return write('    (no JavaScript stack: nothing risky was running when it froze, so the debugger was not attached)');
  capturing = true;
  let done = false;
  const s = sess;
  const finish = msg => { if (done) return; done = true; capturing = false; if (msg) write(msg); };
  s.once('Debugger.paused', ({ params }) => {
    const frames = (params.callFrames || []).slice(0, 14).map(f => '    at ' + (f.functionName || '(anonymous)') + ' (' + short(f.url || scripts.get(f.location.scriptId)) + ':' + (f.location.lineNumber + 1) + ')');
    try { s.post('Debugger.resume'); } catch (e) {}
    finish(frames.length ? frames.join('\\n') : '    (paused, but no frames)');
  });
  try { s.post('Debugger.pause'); } catch (e) { return finish('    (could not pause: ' + e.message + ')'); }
  // a thread stuck in native code (a file/OS call, a console write) can't be paused
  setTimeout(() => finish('    (no JavaScript running — stuck inside a native call: file system, OS, console or a native module)'), 3000);
}

let last = Atomics.load(ints, 0), lastMove = Date.now(), stuck = false, nextReport = 0;
setInterval(() => {
  const b = Atomics.load(ints, 0), now = Date.now();
  // keep the debugger attached while something risky runs (attach needs a responsive main thread)
  if (Atomics.load(ints, 4)) { detachAt = now + 15000; if (!stuck) attach(); }
  else if (sess && !stuck && now > detachAt) detach();
  if (b !== last) {
    if (stuck) write('*** MAIN THREAD RECOVERED after about ' + Math.round((now - lastMove) / 1000) + 's');
    last = b; lastMove = now; stuck = false; nextReport = 0; return;
  }
  if (now - lastMove < stuckMs || now < nextReport) return;
  const first = !stuck;
  stuck = true; nextReport = now + 30000;   // say so at once, then every 30s while it lasts
  const d = read(doingBuf, 1), lr = read(lastReqBuf, 2), at = Atomics.load(ints, 3);
  write('*** MAIN THREAD STUCK ' + Math.round((now - lastMove) / 1000) + 's — doing: ' + (d || '(no label)') + hint(d)
    + (lr ? ' | last request: ' + lr + ' (' + Math.max(0, Math.round(now / 1000 - at)) + 's ago)' : '') + ' | ' + memLine());
  if (first) captureStack();
}, 1000);
`;
let worker = null, armFn = null;
function start(logPath, { stuckMs = 4000 } = {}) {
  if (worker) return;
  try {
    worker = new Worker(WORKER, { eval: true, workerData: { sab, logPath, stuckMs, LABEL_BYTES, HEAD, root: require('path').dirname(__filename) } });
    worker.on('error', () => {});
    worker.unref();
    setInterval(() => {
      Atomics.add(ints, 0, 1);
      if (armFn) { let a = false; try { a = !!armFn(); } catch (e) {} Atomics.store(ints, 4, a ? 1 : 0); }
    }, 250).unref();
  } catch (e) { worker = null; }
}
/* fn() → true while something is running that could freeze (keeps the debugger attached) */
function arm(fn) { armFn = fn; }

module.exports = { install, start, arm, doing, sawRequest };

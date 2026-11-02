/* vms.js — Virtual machines (#/vms). A disposable Windows desktop, in the browser.

   The server (engine/sandbox-vm.js) builds a throwaway Hyper-V guest from a
   read-only Windows 11 image: it can reach the internet but not the home network,
   and it is erased — disk and all — when it ends, goes idle, or hits its time
   limit. This page starts one, shows its desktop (a real remote desktop through
   guacd: mouse, keyboard, clipboard), and moves files in from the vault or straight
   from this computer, then opens them inside the guest.

   Routes: #/vms · #/vms/run:<fileId> (start with that program) · #/vms/send:<fileId>
   (send that file in, starting a machine first if needed). Leaving the page only
   disconnects the viewer; the machine keeps running until it is ended. */
import { html, raw, el, icon, esc, fmtSize, fmtDate, plural, api, lsGet, lsSet, animate, SPRING, debounce } from './lib.js';
import * as store from './store.js';
import { toast, dialog, confirm, menu, pushEsc } from './ui.js';
import { pickFiles as pickFrom } from './pick.js';

// 1.5.0 is the newest published version, and it ships only as an ES module
const GUAC_JS = 'https://unpkg.com/guacamole-common-js@1.5.0/dist/esm/guacamole-common.min.js';
const STEPS = [
  { key: 'disk', label: 'Clean disk', match: /clean disk/i },
  { key: 'vm', label: 'Virtual machine', match: /creating the virtual/i },
  { key: 'boot', label: 'Windows', match: /starting windows/i },
  { key: 'rdp', label: 'Remote desktop', match: /remote desktop/i },
  { key: 'files', label: 'Your file', match: /copying/i },
];
const V = {
  status: null, poll: 0, root: null, client: null, keyboard: null, mouse: null, ro: null,
  pending: [], files: [], uploads: [], clip: '', connected: false, startedClickAt: 0, frameTimer: 0,
};
const isTouch = () => matchMedia('(pointer: coarse)').matches;

/* ---------------- entry ---------------- */
export async function renderVMs(stage, route) {
  stage.innerHTML = '<div class="vms page-enter" data-own-drop><div class="vm-load"><span class="spin"></span></div></div>';
  V.root = stage.firstElementChild;
  // files dropped here go into the machine, never into the vault (see upload.js)
  V.root.addEventListener('dragover', e => { if ([...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault(); });
  V.root.addEventListener('drop', e => { if (!e.defaultPrevented) e.preventDefault(); });
  const arg = route.arg || '';
  if (/^run:/.test(arg)) V.pending.push({ id: arg.slice(4), run: true, start: true });
  else if (/^send:/.test(arg)) V.pending.push({ id: arg.slice(5), run: false });
  if (arg) try { history.replaceState(history.state, '', '#/vms'); } catch (e) {}
  await refresh();
  if (!V.root) return;
  // "Run in a virtual machine" from Files: start right away with that program
  const auto = V.pending.find(p => p.start);
  if (auto) {
    auto.start = false;
    if (!V.status.session && V.status.ready && !V.status.busy) { V.pending = V.pending.filter(p => p !== auto); return start(auto.id); }
  }
  paint();
  schedule();
}
export function leaveVMs() { disconnect(); clearTimeout(V.poll); clearInterval(V.frameTimer); V.root = null; }

async function refresh() {
  try { V.status = await api('/api/vm/status', { timeout: 30000 }); }
  catch (e) { V.status = { allowed: true, ready: false, reason: 'Couldn’t reach the server: ' + e.message }; }
  const s = V.status.session;
  V.files = s ? (s.files || []) : [];
  return V.status;
}
/* poll fast while something is happening, slowly otherwise */
function schedule() {
  clearTimeout(V.poll);
  if (!V.root) return;
  const s = V.status && V.status.session;
  const busy = s && ['creating', 'booting', 'stopping'].includes(s.state);
  V.poll = setTimeout(async () => {
    const before = s ? s.state + (s.note || '') : 'none';
    await refresh();
    if (!V.root) return;
    const n = V.status.session;
    const after = n ? n.state + (n.note || '') : 'none';
    if (before !== after) paint(); else tick();
    schedule();
  }, busy ? 1500 : 8000);
}

/* ---------------- page ---------------- */
function paint() {
  const st = V.status || {}, s = st.session;
  if (!V.root) return;
  if (!st.allowed) return paintNotice('lock', 'Virtual machines aren’t on for your account', 'An administrator can turn on “Can use the EXE sandbox” for you.');
  if (!st.ready && !s) return paintNotice('info', 'Virtual machines aren’t set up on this server', st.reason || 'The server can’t run virtual machines right now.', store.S.account && store.S.account.is_admin);
  if (!s) return paintIdle();
  if (s.state === 'error') return paintError(s);
  if (s.state === 'running') return paintRunning(s);
  return paintStarting(s);
}
function paintNotice(ic, title, text, admin) {
  disconnect();
  V.root.innerHTML = html`<div class="vm-hero"><div class="vm-orb">${icon(ic, 30, 1.6)}</div><h1>${title}</h1><p>${text}</p>
    ${admin ? html`<p class="dim vm-small">On the server, run <code>setup-sandbox.ps1</code> in an administrator PowerShell, then restart Simplex.</p>` : ''}</div>`.s;
}

/* ---- no machine ---- */
function paintIdle() {
  disconnect();
  const st = V.status, lim = st.limits || {};
  const waiting = V.pending.filter(p => store.byId(p.id));
  V.root.innerHTML = html`<div class="vm-hero">
      <div class="vm-orb">${icon('desktop', 30, 1.6)}</div>
      <h1>Virtual machines</h1>
      <p>A clean Windows desktop that runs on the server. Try programs, open files you don’t trust, install things — then end it and every trace is gone.</p>
      ${waiting.length ? html`<div class="vm-queued">${icon('file', 15)} Ready to send in: <b>${waiting.map(p => store.byId(p.id).name).join(', ')}</b></div>` : ''}
      ${st.busy ? html`<div class="vm-warn">${icon('info', 15)} Someone else is using the virtual machine right now — this server runs ${plural(lim.maxSessions || 1, 'machine')} at a time.</div>` : ''}
      <div class="vm-cta">
        <button class="b pri lg" data-start ${st.busy ? 'disabled' : ''}>${icon('power', 17)} Start a machine</button>
        <button class="b lg" data-startwith ${st.busy ? 'disabled' : ''}>${icon('folder', 17)} Start with a file…</button>
      </div>
      <div class="vm-specs">
        <div>${icon('desktop', 16)}<b>Windows 11</b><span>2 cores · 2 GB memory</span></div>
        <div>${icon('lock', 16)}<b>Walled off</b><span>Internet yes, your network no</span></div>
        <div>${icon('trash', 16)}<b>Disposable</b><span>Erased when it ends</span></div>
        <div>${icon('clock', 16)}<b>Up to ${Math.round((lim.maxLifeMs || 3600e3) / 60000)} min</b><span>Ends after ${Math.round((lim.idleMs || 300e3) / 60000)} min idle</span></div>
      </div>
      ${st.mode !== 'rdp' && st.ready ? html`<p class="dim vm-small">${icon('info', 12)} Remote desktop isn’t available right now, so machines start with a keyboard-only view.</p>` : ''}
    </div>`.s;
  V.root.querySelector('[data-start]').onclick = () => start();
  V.root.querySelector('[data-startwith]').onclick = () => pickFiles({ title: 'Start with a file', runnable: true, multi: false }).then(ids => { if (ids && ids.length) start(ids[0]); });
}
async function start(fileId) {
  const runnable = fileId && /\.(exe|msi|bat|cmd|com|scr|jar|ps1)$/i.test((store.byId(fileId) || {}).name || '');
  if (fileId && !runnable) { V.pending.push({ id: fileId, run: true }); fileId = null; }   // anything else goes in once it's up
  V.startedClickAt = Date.now();
  try {
    const r = await api('/api/vm/session', { method: 'POST', json: fileId ? { fileId } : {}, timeout: 60000 });
    V.status.session = r.session;
    if (fileId) V.pending = V.pending.filter(p => p.id !== fileId);
    paint(); schedule();
  } catch (e) { toast(e.message, { bad: true }); await refresh(); paint(); }
}

/* ---- starting ---- */
function bootEstimate() { return Number(lsGet('nx.vm.boot', '0')) || 40000; }
function paintStarting(s) {
  disconnect();
  const idx = Math.max(0, STEPS.findIndex(x => x.match.test(s.note || '')));
  const stopping = s.state === 'stopping';
  V.root.innerHTML = html`<div class="vm-hero vm-starting">
      <div class="vm-screen-ghost"><div class="vm-scan"></div>${icon('desktop', 40, 1.2)}</div>
      <h1>${stopping ? 'Ending the machine…' : 'Starting your machine'}</h1>
      <p class="dim" data-note>${stopping ? 'Erasing its disk.' : s.note || 'Getting ready…'}</p>
      ${stopping ? '' : html`<div class="vm-steps">${STEPS.filter(x => x.key !== 'files' || s.fileName).map((x, i) => html`<div class="vm-step ${i < idx ? 'done' : i === idx ? 'on' : ''}"><i>${i < idx ? icon('check', 12, 2.6) : i === idx ? raw('<span class="spin"></span>') : ''}</i><span>${x.label}</span></div>`)}</div>
      <div class="vm-bar"><i data-bar></i></div><small class="dim" data-eta></small>
      <button class="b sm flat" data-cancel>${icon('close', 14)} Cancel</button>`}
    </div>`.s;
  const c = V.root.querySelector('[data-cancel]'); if (c) c.onclick = () => end(true);
  tick();
}
/* the parts that move every poll without a repaint */
function tick() {
  const s = V.status && V.status.session; if (!s || !V.root) return;
  const bar = V.root.querySelector('[data-bar]');
  if (bar) {
    const t = Date.now() - s.startedAt, est = bootEstimate();
    const p = Math.min(0.96, 1 - Math.exp(-2.4 * t / est));
    bar.style.width = (p * 100).toFixed(1) + '%';
    const left = Math.round((est - t) / 1000);
    V.root.querySelector('[data-eta]').textContent = left > 2 ? `About ${left}s left` : 'Almost there…';
  }
  const tl = V.root.querySelector('[data-timeleft]');
  if (tl) {
    const left = Math.max(0, s.expiresAt - Date.now()), idle = (V.status.limits || {}).idleMs || 300000;
    const idleLeft = Math.max(0, idle - (Date.now() - s.lastInputAt));
    tl.textContent = `${Math.ceil(left / 60000)} min left`;
    tl.title = `Ends at ${new Date(s.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, or after ${Math.round(idle / 60000)} minutes without input`;
    tl.classList.toggle('warn', idleLeft < 60000 || left < 5 * 60000);
  }
}

/* ---- error ---- */
function paintError(s) {
  disconnect();
  V.root.innerHTML = html`<div class="vm-hero"><div class="vm-orb bad">${icon('info', 28, 1.6)}</div><h1>The machine didn’t start</h1>
    <p>${s.error || 'Something went wrong while building it.'}</p>
    <div class="vm-cta"><button class="b pri" data-retry>${icon('restore', 15)} Try again</button></div></div>`.s;
  V.root.querySelector('[data-retry]').onclick = async () => { try { await api('/api/vm/session/' + s.id, { method: 'DELETE', timeout: 90000 }); } catch (e) {} await refresh(); start(); };
}

/* ---- running ---- */
function paintRunning(s) {
  if (!V.startedClickAt || !lsGet('nx.vm.boot')) {} // keep the learned estimate below
  if (V.startedClickAt) { lsSet('nx.vm.boot', String(Math.round(Date.now() - s.startedAt))); V.startedClickAt = 0; }
  const rdp = s.mode === 'rdp';
  V.root.innerHTML = html`<div class="vm-run">
      <header class="vm-bar-top">
        <span class="vm-live"><i></i>${rdp ? 'Running' : 'Running · keyboard only'}</span>
        <span class="vm-time" data-timeleft></span>
        <span class="sp"></span>
        <button class="b sm" data-add>${icon('plus', 14)} Add files</button>
        <button class="ib${V.filesOpen ? ' on' : ''}" data-files title="Files in the machine">${icon('folder', 17)}<em data-fcount>${V.files.length || ''}</em></button>
        ${rdp ? html`<button class="ib" data-clip title="Clipboard">${icon('file', 17)}</button><button class="ib" data-cad title="Send Ctrl+Alt+Del">${icon('keyboard', 17)}</button><button class="ib" data-refresh title="Refresh the view (reconnects; the machine keeps running)">${icon('restore', 17)}</button>` : ''}
        ${isTouch() ? html`<button class="ib" data-kbd title="On-screen keyboard">${icon('keyboard', 17)}</button>` : ''}
        <button class="ib" data-full title="Full screen">${icon('expand', 17)}</button>
        <button class="b sm danger" data-end>${icon('power', 14)} End</button>
      </header>
      <div class="vm-body">
        <div class="vm-screen" tabindex="0" data-capture-keys>
          <div class="vm-connecting"><span class="spin"></span><span>Connecting to the desktop…</span></div>
        </div>
        <aside class="vm-files"${V.filesOpen ? '' : ' hidden'}></aside>
        <div class="vm-drop" hidden><div>${icon('upload', 28, 1.6)}<b>Drop to send into the machine</b></div></div>
      </div>
      ${s.modeNote ? html`<p class="vm-note">${icon('info', 13)} ${s.modeNote}</p>` : ''}
      ${s.deliveryWarning ? html`<p class="vm-note bad">${icon('info', 13)} ${s.deliveryWarning}</p>` : ''}
      <input type="file" multiple hidden data-pick>
      <textarea class="vm-softkbd" data-softkbd autocapitalize="off" autocomplete="off" spellcheck="false"></textarea>
    </div>`.s;
  wireRunning(s);
  paintFiles();
  tick();
  if (rdp) connect(s); else startFrames(s);
  flushPending(s);
}
function wireRunning(s) {
  const r = V.root;
  r.querySelector('[data-end]').onclick = () => end();
  r.querySelector('[data-add]').onclick = e => menu([
    { label: 'From Database…', ic: 'database', run: () => pickFiles({ title: 'Send files into the machine', multi: true }).then(ids => ids && ids.forEach(id => sendVault(s, id))) },
    { label: 'From this computer…', ic: 'upload', run: () => r.querySelector('[data-pick]').click() },
  ], e.currentTarget);
  r.querySelector('[data-pick]').onchange = e => { [...e.target.files].forEach(f => sendLocal(s, f)); e.target.value = ''; };
  r.querySelector('[data-files]').onclick = () => { V.filesOpen = !V.filesOpen; r.querySelector('.vm-files').hidden = !V.filesOpen; r.querySelector('[data-files]').classList.toggle('on', V.filesOpen); fit(); };
  r.querySelector('[data-full]').onclick = () => { const b = r.querySelector('.vm-run'); if (document.fullscreenElement) document.exitFullscreen(); else (b.requestFullscreen ? b.requestFullscreen() : Promise.reject()).catch(() => toast('Full screen isn’t available here', { bad: true })); };
  const cad = r.querySelector('[data-cad]'); if (cad) cad.onclick = () => sendCombo([0xFFE3, 0xFFE9, 0xFFFF]);
  const rf = r.querySelector('[data-refresh]'); if (rf) rf.onclick = () => reconnect(s, 'Refreshing the view…');
  const clip = r.querySelector('[data-clip]'); if (clip) clip.onclick = e => clipboardPop(e.currentTarget);
  const kbd = r.querySelector('[data-kbd]'); if (kbd) kbd.onclick = () => softKeyboard();
  // drag files from the computer onto the desktop
  const body = r.querySelector('.vm-body'), drop = r.querySelector('.vm-drop');
  let depth = 0;
  body.addEventListener('dragenter', e => { if (![...(e.dataTransfer.types || [])].includes('Files')) return; e.preventDefault(); depth++; drop.hidden = false; });
  body.addEventListener('dragover', e => { if ([...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault(); });
  body.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.hidden = true; } });
  body.addEventListener('drop', e => { e.preventDefault(); depth = 0; drop.hidden = true; [...e.dataTransfer.files].forEach(f => sendLocal(s, f)); });
}

/* ---------------- remote desktop (guacamole-common-js over our tunnel) ---------------- */
let guacLoading = null;
function loadGuac() {
  if (window.Guacamole) return Promise.resolve();
  if (guacLoading) return guacLoading;
  guacLoading = import(GUAC_JS).then(m => { window.Guacamole = m.default; })
    .catch(() => { guacLoading = null; throw new Error('Couldn’t load the remote desktop library.'); });
  return guacLoading;
}
async function connect(s) {
  const screen = V.root && V.root.querySelector('.vm-screen'); if (!screen) return;
  try { await loadGuac(); } catch (e) { return screenMsg(e.message, true); }
  if (!V.root || !screen.isConnected) return;
  const Guac = window.Guacamole;
  const box = screen.getBoundingClientRect();
  const w = Math.max(800, Math.round(box.width)), h = Math.max(600, Math.round(box.height));
  const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/vm/tunnel?id=${encodeURIComponent(s.id)}&w=${w}&h=${h}`;
  const tunnel = new Guac.WebSocketTunnel(url);
  const client = new Guac.Client(tunnel);
  V.client = client;
  /* Watch for a frozen picture. Some Windows 11 surfaces (the Start menu above all)
     can leave the RDP stream sending nothing; the machine is fine, the view isn't.
     Count real drawing coming back - the client wires tunnel.oninstruction in its
     constructor, so wrap that - and if four clicks or keys get no drawing at all,
     offer a refresh (a reconnect redraws the whole desktop). */
  const onInst = tunnel.oninstruction;
  V.lastDraw = Date.now(); V.inputsSinceDraw = 0;
  tunnel.oninstruction = (op, args) => {
    if (op !== 'sync' && op !== 'nop' && op !== '') { V.lastDraw = Date.now(); V.inputsSinceDraw = 0; stallHint(false); }
    onInst.call(tunnel, op, args);
  };
  const noteInput = () => {
    if (V.client !== client || !V.connected) return;
    V.inputsSinceDraw++;
    clearTimeout(V.stallTimer);
    V.stallTimer = setTimeout(() => { if (V.client === client && V.inputsSinceDraw >= 4 && Date.now() - V.lastDraw > 6000) stallHint(true, s); }, 6200);
  };
  client.onerror = st => screenMsg('The remote desktop stopped: ' + ((st && st.message) || 'connection lost'), true);
  client.onstatechange = state => {
    if (state === 3) {          // connected
      V.connected = true;
      const c = screen.querySelector('.vm-connecting'); if (c) c.remove();
      screen.focus({ preventScroll: true });
      fit();
    } else if (state === 5 && V.client === client) {   // disconnected
      V.connected = false;
      if (V.root) refresh().then(st => { if (!st.session) { toast('The machine ended', { ic: 'power' }); paint(); } else screenMsg('Disconnected from the desktop.', true); });
    }
  };
  client.onclipboard = (stream, mime) => {
    if (!/^text\//.test(mime)) return;
    const reader = new Guac.StringReader(stream); let data = '';
    reader.ontext = t => { data += t; };
    reader.onend = () => { V.clip = data; };
  };
  const display = client.getDisplay();
  const de = display.getElement();
  de.classList.add('vm-display');
  screen.appendChild(de);
  display.onresize = () => fit();
  /* Pointer input, done here rather than with Guacamole.Mouse: in 1.5.0 that helper
     measures positions against whichever internal canvas layer is under the
     pointer, so clicks landed near the guest's top-left corner. Pointer events
     cover mouse, pen and touch alike; positions come from the display's own box
     and current scale, so they stay right while it is scaled to fit. */
  let btn = 0;   // guacamole mask: 1 left, 2 middle, 4 right, 8 wheel up, 16 wheel down
  const at = e => { const r = de.getBoundingClientRect(), sc = display.getScale() || 1; return [Math.max(0, Math.round((e.clientX - r.left) / sc)), Math.max(0, Math.round((e.clientY - r.top) / sc))]; };
  const send = (x, y, mask) => { if (V.client !== client) return; client.sendMouseState(new Guac.Mouse.State(x, y, !!(mask & 1), !!(mask & 2), !!(mask & 4), !!(mask & 8), !!(mask & 16))); };
  const maskOf = b => (b & 1 ? 1 : 0) | (b & 4 ? 2 : 0) | (b & 2 ? 4 : 0);   // DOM buttons -> guacamole
  de.addEventListener('pointerdown', e => { e.preventDefault(); screen.focus({ preventScroll: true }); try { de.setPointerCapture(e.pointerId); } catch (er) {} btn = maskOf(e.buttons || 1); send(...at(e), btn); noteInput(); });
  de.addEventListener('pointermove', e => { btn = e.pointerType === 'touch' && !e.buttons ? 0 : maskOf(e.buttons); send(...at(e), btn); });
  de.addEventListener('pointerup', e => { btn = maskOf(e.buttons); send(...at(e), btn); });
  de.addEventListener('pointercancel', e => { btn = 0; send(...at(e), 0); });
  de.addEventListener('wheel', e => { e.preventDefault(); const [x, y] = at(e), dir = e.deltaY < 0 ? 8 : 16; send(x, y, btn | dir); send(x, y, btn); }, { passive: false });
  de.addEventListener('contextmenu', e => e.preventDefault());
  de.style.touchAction = 'none';
  // the guest's own pointer (arrow, I-beam, resize…) becomes the browser cursor here
  display.showCursor(false);
  display.oncursor = (canvas, x, y) => { try { de.style.cursor = `url(${canvas.toDataURL('image/png')}) ${x} ${y}, default`; } catch (er) {} };
  // keyboard: only while the desktop has focus, so the rest of the page still types normally
  const kb = new Guac.Keyboard(screen);
  kb.onkeydown = sym => { if (V.client === client) { client.sendKeyEvent(1, sym); noteInput(); } return false; };
  kb.onkeyup = sym => { if (V.client === client) client.sendKeyEvent(0, sym); };
  V.keyboard = kb;
  screen.addEventListener('blur', () => { try { kb.reset(); } catch (e) {} });
  screen.addEventListener('mousedown', () => screen.focus({ preventScroll: true }));
  /* Keep it fitting the box. Small changes just rescale; a real change of size
     (fullscreen, a much bigger window) reconnects at the new resolution - live
     resizing of the remote session isn't reliable with this RDP stack (the
     server's notes in sandbox-vm.js explain). The machine itself keeps running. */
  V.size = { w, h };
  V.ro = new ResizeObserver(debounce(() => {
    if (V.client !== client || !V.connected) return;
    fit();
    const b = screen.getBoundingClientRect(), nw = Math.max(800, Math.round(b.width)), nh = Math.max(600, Math.round(b.height));
    if (Math.abs(nw - V.size.w) / V.size.w > 0.15 || Math.abs(nh - V.size.h) / V.size.h > 0.15) reconnect(s);
  }, 700));
  V.ro.observe(screen);
  try { client.connect(''); } catch (e) { screenMsg(e.message, true); }
}
/* reconnect the viewer (same machine) - after a big size change, or to redraw a stuck view */
function reconnect(s, text) {
  const screen = V.root && V.root.querySelector('.vm-screen'); if (!screen) return;
  disconnect(true);
  screen.innerHTML = html`<div class="vm-connecting"><span class="spin"></span><span>${text || 'Adjusting to the new size…'}</span></div>`.s;
  connect(s);
}
function stallHint(show, s) {
  const screen = V.root && V.root.querySelector('.vm-screen'); if (!screen) return;
  let el = screen.querySelector('.vm-stall');
  if (!show) { if (el) el.remove(); return; }
  if (el) return;
  el = document.createElement('div'); el.className = 'vm-stall';
  el.innerHTML = html`<span>Screen not updating?</span><button class="b sm pri" data-go>${icon('restore', 13)} Refresh view</button><button class="ib x" data-x title="Dismiss">${icon('close', 14)}</button>`.s;
  el.querySelector('[data-go]').onclick = () => reconnect(s, 'Refreshing the view…');
  el.querySelector('[data-x]').onclick = () => { V.inputsSinceDraw = -1e9; el.remove(); };
  screen.appendChild(el);
}
/* scale the remote display down to fit its box (never up — it stays crisp) */
function fit() {
  if (!V.client || !V.root) return;
  const screen = V.root.querySelector('.vm-screen'), d = V.client.getDisplay();
  if (!screen || !d.getWidth()) return;
  const b = screen.getBoundingClientRect();
  d.scale(Math.min(1, b.width / d.getWidth(), b.height / d.getHeight()));
}
function screenMsg(text, retry) {
  const screen = V.root && V.root.querySelector('.vm-screen'); if (!screen) return;
  disconnect(true);
  screen.innerHTML = html`<div class="vm-connecting">${icon('info', 18)}<span>${text}</span>${retry ? html`<button class="b sm" data-reconnect>${icon('restore', 14)} Reconnect</button>` : ''}</div>`.s;
  const b = screen.querySelector('[data-reconnect]'); if (b) b.onclick = () => { const s = V.status.session; if (s) { screen.innerHTML = '<div class="vm-connecting"><span class="spin"></span><span>Connecting to the desktop…</span></div>'; connect(s); } };
}
function disconnect(keepScreen) {
  if (V.ro) { try { V.ro.disconnect(); } catch (e) {} V.ro = null; }
  if (V.keyboard) { try { V.keyboard.onkeydown = V.keyboard.onkeyup = null; V.keyboard.reset(); } catch (e) {} V.keyboard = null; }
  if (V.mouse) { V.mouse = null; }
  if (V.client) { const c = V.client; V.client = null; try { c.disconnect(); } catch (e) {} }
  V.connected = false;
  clearTimeout(V.stallTimer);
  clearInterval(V.frameTimer); V.frameTimer = 0;
}
function sendCombo(syms) {
  if (!V.client) return;
  syms.forEach(k => V.client.sendKeyEvent(1, k));
  syms.slice().reverse().forEach(k => V.client.sendKeyEvent(0, k));
  toast('Sent Ctrl+Alt+Del', { ic: 'keyboard' });
}
function clipboardPop(anchor) {
  const d = dialog({
    ic: 'file', title: 'Clipboard',
    body: html`<p class="dim" style="margin-bottom:10px">Text copied inside the machine shows up here. Edit it and press Send to paste it in there with Ctrl+V.</p>
      <textarea class="in" rows="6" data-cliptext placeholder="Nothing copied in the machine yet">${V.clip}</textarea>`,
    actions: [
      { label: 'Copy here', run: (_c, r) => { navigator.clipboard && navigator.clipboard.writeText(r.querySelector('[data-cliptext]').value).then(() => toast('Copied', { ic: 'check' })); return false; } },
      { label: 'Send to machine', kind: 'pri', run: (_c, r) => {
        const text = r.querySelector('[data-cliptext]').value; if (!V.client || !window.Guacamole) return;
        const w = new window.Guacamole.StringWriter(V.client.createClipboardStream('text/plain'));
        w.sendText(text); w.sendEnd(); V.clip = text; toast('Ready to paste in the machine', { ic: 'check' });
        setTimeout(() => { const sc = V.root && V.root.querySelector('.vm-screen'); sc && sc.focus(); }, 250);
      } },
    ],
  });
  return d;
}
/* phones: a hidden textarea brings up the system keyboard; typed text becomes key presses */
function softKeyboard() {
  const ta = V.root.querySelector('[data-softkbd]'); if (!ta || !V.client) return;
  ta.value = ''; ta.focus();
  if (ta._wired) return; ta._wired = true;
  const key = sym => { V.client.sendKeyEvent(1, sym); V.client.sendKeyEvent(0, sym); };
  ta.addEventListener('input', e => {
    if (e.inputType === 'deleteContentBackward') key(0xFF08);
    else if (e.data) for (const ch of e.data) { const c = ch.codePointAt(0); key(c >= 0x100 ? 0x01000000 | c : c); }
    ta.value = '';
  });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); key(0xFF0D); } else if (e.key === 'Backspace' && !ta.value) { e.preventDefault(); key(0xFF08); } });
}

/* ---------------- keyboard-only fallback: polled frames ---------------- */
function startFrames(s) {
  const screen = V.root.querySelector('.vm-screen');
  screen.innerHTML = html`<img class="vm-frame" alt="Machine screen"><div class="vm-typebar"><input class="in" data-type placeholder="Type here, then Enter to send it to the machine" spellcheck="false"><button class="b sm" data-key="13">Enter</button><button class="b sm" data-key="27">Esc</button><button class="b sm" data-key="9">Tab</button></div>`.s;
  const img = screen.querySelector('img');
  let busy = false;
  const pull = async () => {
    if (busy || !V.root) return; busy = true;
    try { const r = await fetch(`/api/vm/session/${encodeURIComponent(s.id)}/frame?t=${Date.now()}`, { credentials: 'same-origin' }); if (r.ok) { const u = URL.createObjectURL(await r.blob()); const old = img.src; img.src = u; if (old.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(old), 1000); } } catch (e) {}
    busy = false;
  };
  pull(); V.frameTimer = setInterval(pull, 700);
  const inp = screen.querySelector('[data-type]');
  const send = body => api(`/api/vm/session/${encodeURIComponent(s.id)}/input`, { method: 'POST', json: body }).then(() => setTimeout(pull, 250)).catch(e => toast(e.message, { bad: true }));
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && inp.value) { e.preventDefault(); send({ text: inp.value }); inp.value = ''; } });
  screen.querySelectorAll('[data-key]').forEach(b => { b.onclick = () => send({ keys: [Number(b.dataset.key)] }); });
}

/* ---------------- files into the machine ---------------- */
function paintFiles() {
  const p = V.root && V.root.querySelector('.vm-files'); if (!p) return;
  const cnt = V.root.querySelector('[data-fcount]'); if (cnt) cnt.textContent = V.files.length || '';
  p.innerHTML = html`<div class="vm-fh"><b>In the machine</b><small class="dim">on the desktop</small></div>
    <div class="vm-flist">
      ${V.uploads.map(u => html`<div class="vm-f up"><span class="vm-fi">${icon(u.done ? 'check' : 'upload', 15)}</span><div><b>${u.name}</b><small>${u.error ? u.error : u.done ? 'Sent in' : u.p != null ? `Sending… ${Math.round(u.p * 100)}%` : 'Sending…'}</small>${!u.done && !u.error ? html`<div class="vm-fbar"><i style="width:${((u.p || 0) * 100).toFixed(1)}%"></i></div>` : ''}</div></div>`)}
      ${V.files.length ? V.files.map(n => html`<div class="vm-f"><span class="vm-fi">${icon(fileIc(n), 15)}</span><div><b>${n}</b><small>Desktop</small></div><button class="b sm" data-open="${n}">${icon('play', 12)} Open</button></div>`) : V.uploads.length ? '' : html`<div class="vm-fempty">${icon('upload', 20, 1.6)}<span>Drop files on the desktop, or use Add files. They land on the machine’s desktop.</span></div>`}
    </div>`.s;
  p.onclick = async e => {
    const b = e.target.closest('[data-open]'); if (!b) return;
    const s = V.status.session; if (!s) return;
    b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try { await api(`/api/vm/session/${encodeURIComponent(s.id)}/run`, { method: 'POST', json: { name: b.dataset.open }, timeout: 90000 }); toast(`Opening ${b.dataset.open} in the machine`, { ic: 'play' }); }
    catch (err) { toast(err.message, { bad: true }); }
    b.disabled = false; b.innerHTML = html`${icon('play', 12)} Open`.s;
  };
}
const fileIc = n => /\.(exe|msi|bat|cmd|ps1|com|jar)$/i.test(n) ? 'window' : /\.(png|jpe?g|gif|webp|bmp)$/i.test(n) ? 'image' : /\.(mp4|mkv|mov|avi|webm)$/i.test(n) ? 'video' : /\.(mp3|wav|flac|ogg|m4a)$/i.test(n) ? 'audio' : /\.(zip|7z|rar|tar|gz)$/i.test(n) ? 'folder' : 'file';
function openFilesPanel() { if (!V.filesOpen && V.root) { V.filesOpen = true; const a = V.root.querySelector('.vm-files'); if (a) a.hidden = false; const b = V.root.querySelector('[data-files]'); if (b) b.classList.add('on'); fit(); } }
function sendDone(name, run) {
  if (name && !V.files.includes(name)) V.files.push(name);
  paintFiles();
  const s = V.status.session;
  if (run && s && name) api(`/api/vm/session/${encodeURIComponent(s.id)}/run`, { method: 'POST', json: { name }, timeout: 90000 }).then(() => toast(`Opening ${name}`, { ic: 'play' })).catch(e => toast(e.message, { bad: true }));
}
async function sendVault(s, id, run) {
  const f = store.byId(id); if (!f) return;
  const u = { name: f.name, p: null }; V.uploads.push(u); openFilesPanel(); paintFiles();
  try { const r = await api(`/api/vm/session/${encodeURIComponent(s.id)}/files`, { method: 'POST', json: { fileId: id }, timeout: 15 * 60000 }); u.done = true; V.uploads = V.uploads.filter(x => x !== u); sendDone(r.name, run); toast(`${f.name} is in the machine`, { ic: 'check' }); }
  catch (e) { u.error = e.message; paintFiles(); toast(e.message, { bad: true }); }
}
function sendLocal(s, file) {
  const u = { name: file.name, p: 0 }; V.uploads.push(u); openFilesPanel(); paintFiles();
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/vm/session/${encodeURIComponent(s.id)}/upload?name=${encodeURIComponent(file.name)}`);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.upload.onprogress = e => { if (e.lengthComputable) { u.p = e.loaded / e.total; const now = performance.now(); if (!u.t || now - u.t > 200) { u.t = now; paintFiles(); } } };
  xhr.onload = () => {
    let r = {}; try { r = JSON.parse(xhr.responseText); } catch (e) {}
    if (xhr.status >= 200 && xhr.status < 300) { V.uploads = V.uploads.filter(x => x !== u); sendDone(r.name); toast(`${file.name} is in the machine`, { ic: 'check' }); }
    else { u.error = r.error || 'Couldn’t send it in'; paintFiles(); toast(u.error, { bad: true }); }
  };
  xhr.onerror = () => { u.error = 'The upload was interrupted'; paintFiles(); };
  xhr.send(file);
}
/* files queued from elsewhere (Files → "Send to virtual machine") go in once it's running */
function flushPending(s) {
  const list = V.pending.splice(0);
  list.forEach(p => { if (store.byId(p.id)) sendVault(s, p.id, p.run); });
}

/* pick vault files (searchable): programs first when starting a machine */
const RUNNABLE = /\.(exe|msi|bat|cmd|ps1)$/i;
function pickFiles({ title, runnable, multi }) {
  return pickFrom({
    title, multi, filter: f => !!f.url, rank: runnable ? f => RUNNABLE.test(f.name) : null,
    okLabel: multi ? 'Send in' : 'Start',
    hint: runnable ? 'Programs (.exe, .msi, scripts) open automatically. Anything else is placed on the desktop.' : '',
  });
}

/* ---------------- ending ---------------- */
async function end(skipAsk) {
  const s = V.status && V.status.session; if (!s) return;
  if (!skipAsk && !(await confirm({ title: 'End this machine?', text: 'It shuts down and its disk is erased — anything installed or saved inside it is gone for good.', ok: 'End and erase', danger: true, ic: 'power' }))) return;
  disconnect();
  V.status.session = { ...s, state: 'stopping' };
  paint();
  try { await api('/api/vm/session/' + encodeURIComponent(s.id), { method: 'DELETE', timeout: 120000 }); } catch (e) {}
  V.files = []; V.uploads = [];
  await refresh(); paint(); schedule();
  toast('Machine ended and erased', { ic: 'power' });
}

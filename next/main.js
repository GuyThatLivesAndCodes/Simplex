/* main.js — boots the new Simplex interface: session check, sign-in, the frame
   (top bar + stage + dock), hash routing, home, settings and the ⌘K palette. */
import { html, raw, el, icon, esc, fmtSize, plural, lsGet, lsSet, animate, SPRING, debounce, $$ } from './lib.js';
import * as store from './store.js';
import { toast, dialog, palette, sheet, closeSheet, overlayOpen } from './ui.js';
import * as files from './files.js';
import { viewerOpen, openViewer } from './viewer.js';
import { pickAndUpload, wireDropzone } from './upload.js';
import { UI_KEY, APPS, visibleApps, lockedApp, openClassic } from './classic.js';
import * as prefs from './prefs.js';
import * as perf from './perf.js';
import { renderSettings } from './settings.js';
import { lazy } from './thumbs.js';
import { renderAI, leaveAI } from './ai.js';
import { renderVMs, leaveVMs } from './vms.js';
import { renderTools, leaveTools } from './tools.js';
import { renderSeries, leaveSeries } from './series.js';
import { itemMenuItems } from './files.js';
import { menu } from './ui.js';
import { toggle as toggleActivity } from './tasks.js';
import * as passkeys from './passkeys.js';

const root = document.getElementById('root');

/* ============================================================ BOOT */
async function boot() {
  // landing here (not via ?ui=classic) means this browser uses the new interface
  if (lsGet(UI_KEY) !== 'next') lsSet(UI_KEY, 'next');
  perf.detect();   // low-power graphics get light effects before the first heavy frame
  try { await store.loadMe(); prefs.adoptFromAccount(store.S.account); startApp(); }
  catch (e) { if (e.status === 401) showLogin(); else showFatal(e); }
}
function showFatal(e) {
  root.innerHTML = html`<div class="auth"><div class="auth-card"><div class="orb"></div><h1>Can’t reach Simplex</h1><p class="lead">${e.message || 'The server didn’t answer.'}</p>
    <div style="display:flex;gap:8px"><button class="b pri" data-retry style="flex:1">Try again</button><button class="b" data-classic>Classic</button></div></div></div>`.s;
  root.querySelector('[data-retry]').onclick = () => location.reload();
  root.querySelector('[data-classic]').onclick = () => openClassic('/');
}

/* ============================================================ SIGN-IN */
function showLogin(note) {
  files.leave();
  root.innerHTML = html`<main class="auth"><div class="auth-card">
    <div class="orb"></div>
    <h1>Welcome back</h1>
    <p class="lead">${note || 'Sign in to your private workspace.'}</p>
    <form autocomplete="on" novalidate>
      <input class="in" name="username" placeholder="Username" autocomplete="username webauthn" autocapitalize="off" spellcheck="false" required>
      <input class="in" name="password" type="password" placeholder="Password" autocomplete="current-password" required>
      <div class="err" role="alert"></div>
      <button class="b pri" type="submit">Sign in</button>
    </form>
    ${passkeys.supported() ? html`<div class="pk-or"><span>or</span></div>
    <button class="b pk-signin" type="button" data-passkey>${icon('passkey', 17)}<span>Sign in with a passkey</span></button>` : ''}
    <div class="alt">No account? <button data-c>Request one</button> · <button data-c>Forgot password</button></div>
  </div></main>`.s;
  const card = root.querySelector('.auth-card'), form = card.querySelector('form'), err = card.querySelector('.err'), btn = form.querySelector('button');
  $$('[data-c]', card).forEach(b => b.onclick = () => openClassic('/'));
  form.username.focus();
  // passkeys: an explicit button, plus the browser's autofill suggestions on the
  // username field (conditional mediation), renewed before the 5-minute challenge lapses
  let pkCtl = null, pkTimer = null, pkBusy = false;
  const pkBtn = card.querySelector('[data-passkey]');
  const pkStop = () => { clearTimeout(pkTimer); if (pkCtl) { try { pkCtl.abort(); } catch (e) {} pkCtl = null; } };
  const pkDone = r => { pkStop(); afterLogin(r); };
  const pkFail = ex => { const m = passkeys.signInError(ex); if (m) fail(m); };
  async function pkAutofill() {
    pkStop();
    if (!card.isConnected || pkBusy || !(await passkeys.conditionalAvailable())) return;
    const ctl = pkCtl = new AbortController();
    pkTimer = setTimeout(pkAutofill, 4 * 60_000);
    try { pkDone(await passkeys.signIn({ conditional: true, signal: ctl.signal })); }
    catch (ex) { if (pkCtl === ctl && card.isConnected) { pkFail(ex); if (!pkBusy) pkTimer = setTimeout(pkAutofill, 3000); } }
  }
  if (pkBtn) {
    pkBtn.onclick = async () => {
      if (pkBusy) return;
      pkStop(); pkBusy = true; err.textContent = '';
      pkBtn.disabled = true; pkBtn.querySelector('span').textContent = 'Waiting for your passkey…';
      try { pkDone(await passkeys.signIn()); }
      catch (ex) { pkFail(ex); }
      finally { pkBusy = false; if (card.isConnected) { pkBtn.disabled = false; pkBtn.querySelector('span').textContent = 'Sign in with a passkey'; pkAutofill(); } }
    };
    pkAutofill();
  }
  form.onsubmit = async e => {
    e.preventDefault();
    const u = form.username.value.trim(), p = form.password.value;
    if (!u || !p) { fail('Enter your username and password'); return; }
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; err.textContent = '';
    try {
      const r = await store.login(u, p);
      pkStop();
      if (r.need2fa) return showCode(r.tk);
      afterLogin(r);
    } catch (ex) {
      btn.disabled = false; btn.textContent = 'Sign in';
      if (ex.data && ex.data.banned) fail(`Too many attempts — try again ${new Date(ex.data.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
      else fail(ex.status === 401 ? 'That username and password don’t match' : ex.message);
      form.password.select();
    }
  };
  function fail(msg) { err.textContent = msg; card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); }
  function showCode(tk) {
    card.querySelectorAll('.pk-or, [data-passkey]').forEach(n => n.remove());
    card.querySelector('h1').textContent = 'Two-step sign-in';
    card.querySelector('.lead').textContent = 'Enter the 6-digit code from your authenticator app.';
    form.innerHTML = html`<input class="in code-in" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••"><div class="err" role="alert"></div><button class="b pri" type="submit">Verify</button>`.s;
    const code = form.code, e2 = form.querySelector('.err'), b2 = form.querySelector('button');
    code.focus();
    code.oninput = () => { code.value = code.value.replace(/\D/g, ''); if (code.value.length === 6) form.requestSubmit(); };
    form.onsubmit = async ev => {
      ev.preventDefault(); b2.disabled = true;
      try { afterLogin(await store.login2fa(tk, code.value)); }
      catch (ex) {
        b2.disabled = false; e2.textContent = ex.message; card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); code.select();
        if (ex.data && ex.data.restart) setTimeout(() => showLogin('That sign-in expired — please start again.'), 1200);
      }
    };
  }
}
async function afterLogin(r) {
  store.S.account = r.account; store.S.used = r.used || 0;
  prefs.adoptFromAccount(r.account);
  const card = root.querySelector('.auth-card');
  if (card) await animate(card, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(1.04)', filter: 'blur(10px)' }], { duration: 360, fill: 'forwards' });
  startApp();
  // steps the new interface doesn't handle yet happen in classic
  if (r.pwWeak || (r.keys && r.keys.locked)) {
    dialog({
      ic: 'lock', title: 'One more step', text: r.pwWeak ? 'Your password needs to be changed before you continue. That screen is still in the classic interface.' : 'Your encryption keys need to be unlocked. That screen is still in the classic interface.',
      actions: [{ label: 'Later' }, { label: 'Continue in classic', kind: 'pri', run: () => openClassic('/') }],
    });
  }
}

/* ============================================================ FRAME */
let stage, dock;
function startApp() {
  root.innerHTML = html`<div id="app">
    <header class="tb">
      <a class="brand" href="#/"><span class="orb"></span><span>Simplex</span></a>
      <button class="search-pill" data-pal>${icon('search', 17)}<span>Search files, apps, actions…</span><span class="kbd">${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'} K</span></button>
      <div class="tb-right">
        <button class="ib" data-up aria-label="Upload" title="Upload">${icon('upload', 19)}</button>
        <button class="avatar" data-me aria-label="Account & settings"></button>
      </div>
    </header>
    <main class="stage" id="stage"></main>
    <div class="dock-wrap"><nav class="dock" aria-label="Navigation"></nav></div>
  </div>`.s;
  stage = document.getElementById('stage');
  dock = root.querySelector('.dock');
  root.querySelector('[data-pal]').onclick = openPalette;
  root.querySelector('[data-me]').onclick = () => { location.hash = '#/settings'; };
  root.querySelector('[data-me]').oncontextmenu = e => { e.preventDefault(); menu([{ label: 'Settings', ic: 'settings', run: () => { location.hash = '#/settings'; } }, { label: 'Classic interface', ic: 'swap', run: () => openClassic('/') }, '-', { label: 'Sign out', ic: 'logout', danger: true, run: () => window.dispatchEvent(new CustomEvent('nx:signout')) }], { x: e.clientX, y: e.clientY }); };
  root.querySelector('[data-up]').onclick = () => pickAndUpload(files.currentFolder());
  paintAccount(); drawDock(); wireDockMagnify();
  lastKey = null; lastSig = null;
  if (!wired) {   // app-lifetime listeners: wire once, even across sign-out/sign-in
    wired = true;
    store.on('account', paintAccount);
    store.on('change', debounce(() => render(true), 80));
    store.on('signedout', () => { toast('You were signed out', { bad: true }); showLogin('Your session ended — please sign in again.'); });
    window.addEventListener('nx:signout', async () => { store.stopPolling(); await store.logout(); showLogin('You’re signed out.'); });
    // settings that change what a listing shows re-render it (not the Settings page itself)
    prefs.onPrefs(patch => { if (Object.keys(patch).some(k => ['view', 'showExt', 'foldersFirst', 'homeRecent', 'homeApps', 'openWith'].includes(k)) && parse().name !== 'settings') render(true); });
  }
  stage.innerHTML = '<div class="page"><div class="empty"><span class="spin"></span></div></div>';
  store.loadFiles().then(() => render()).catch(e => toast(e.message, { bad: true }));
  store.startPolling();
  wireDropzone(() => files.currentFolder());
}
function paintAccount() {
  const a = store.S.account; if (!a) return;
  const b = root.querySelector('[data-me]'); if (!b) return;
  const name = a.display || a.username || '?';
  b.textContent = name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  b.title = name;
}

const DOCK = [
  { id: 'home', ic: 'home', label: 'Home', href: '#/' },
  { id: 'files', ic: 'folder', label: 'All files', href: '#/files' },
  { id: 'starred', ic: 'star', label: 'Starred', href: '#/starred' },
  { id: 'recent', ic: 'clock', label: 'Recent', href: '#/recent' },
  { id: 'trash', ic: 'trash', label: 'Trash', href: '#/trash' },
  '-',
  { id: 'ai', ic: 'spark', label: 'AI', href: '#/ai' },
  '-',
  { id: 'apps', ic: 'apps', label: 'Apps', run: () => openApps() },
  { id: 'settings', ic: 'settings', label: 'Settings', href: '#/settings' },
];
function drawDock() {
  dock.innerHTML = DOCK.map(d => d === '-' ? '<span class="sep"></span>' : d.href
    ? html`<a class="dk" href="${d.href}" data-dk="${d.id}" aria-label="${d.label}">${icon(d.ic, 22)}<span class="tip">${d.label}</span></a>`.s
    : html`<button class="dk" data-dk="${d.id}" aria-label="${d.label}">${icon(d.ic, 22)}<span class="tip">${d.label}</span></button>`.s).join('');
  dock.addEventListener('click', e => { const b = e.target.closest('button[data-dk]'); if (!b) return; const d = DOCK.find(x => x.id === b.dataset.dk); d && d.run && d.run(); });
  dock.addEventListener('contextmenu', e => {
    const b = e.target.closest('[data-dk]'); if (!b) return; e.preventDefault();
    const d = DOCK.find(x => x.id === b.dataset.dk);
    menu([{ label: 'Open ' + d.label, ic: d.ic, run: () => (d.href ? (location.hash = d.href) : d.run()) }, d.id === 'trash' && { label: 'Empty Trash…', ic: 'trash', danger: true, run: () => { location.hash = '#/trash'; } }].filter(Boolean), { x: e.clientX, y: e.clientY });
  });
}
/* macOS-style magnification: icons near the pointer swell, eased by the CSS spring */
function wireDockMagnify() {
  const items = () => $$('.dk', dock);
  dock.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || document.documentElement.dataset.motion !== 'on' || !prefs.get('dockMagnify')) return;
    items().forEach(it => { const r = it.getBoundingClientRect(); const d = Math.abs(e.clientX - (r.left + r.width / 2)); it.style.setProperty('--s', (1 + 0.32 * Math.max(0, 1 - d / 120)).toFixed(3)); });
  });
  dock.addEventListener('pointerleave', () => items().forEach(it => it.style.setProperty('--s', 1)));
}

/* ============================================================ ROUTER */
function parse() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [name = '', arg = '', ...rest] = h.split('/');
  if (name === 'search') return { name, q: [arg, ...rest].join('/') };
  return { name: name || 'home', arg: arg || null, sub: rest.join('/') || null };
}
let lastKey = null, lastSig = null, settleUntil = 0, deferred = null, wired = false;
/* what the current page shows, as a string — equal strings mean nothing visible changed */
function signature(r) {
  if (r.name === 'ai') return 'ai/' + (r.arg || '');
  if (r.name === 'vms') return 'vms/' + (r.arg || '');
  if (r.name === 'tools' || r.name === 'series') return r.name + '/' + (r.arg || '') + '/' + (r.sub || '');   // these pages refresh themselves
  if (r.name === 'settings') return 'settings';
  if (r.name === 'home') {
    const a = store.S.account || {};
    return ['home', a.display, store.S.used, prefs.get('homeRecent'), prefs.get('homeApps'), store.live().length,
      ...store.recent(14).map(f => f.id + ':' + f.name + ':' + f.date)].join('|');
  }
  return files.signature(r);
}
function render(quiet) {
  if (!stage || !store.S.loaded) return;
  const r = parse();
  const key = r.name + '/' + (r.arg || r.q || '') + (r.sub ? '/' + r.sub : '');
  const sig = signature(r);
  if (quiet && key === lastKey) {
    // a background refresh: skip it when nothing visible changed, and never swap the
    // page out while its entrance animation is still running (that's what made
    // elements snap into place) — re-run once it has settled
    if (sig === lastSig) return;
    const wait = settleUntil - performance.now();
    if (wait > 0) { clearTimeout(deferred); deferred = setTimeout(() => render(true), wait + 20); return; }
  }
  clearTimeout(deferred);
  const fresh = key !== lastKey;
  stage.toggleAttribute('data-quiet', !fresh);
  if (fresh && lastKey && lastKey.startsWith('ai/') && r.name !== 'ai') leaveAI();
  if (fresh && lastKey && lastKey.startsWith('vms/')) leaveVMs();
  if (fresh && lastKey && lastKey.startsWith('tools/')) leaveTools();
  if (fresh && lastKey && lastKey.startsWith('series/')) leaveSeries();
  if (fresh) { files.leave(); stage.scrollTop = 0; settleUntil = performance.now() + 900 * (window.__nxSpeed || 1); }
  lastKey = key; lastSig = sig;
  $$('.dk', dock).forEach(d => d.classList.toggle('on', d.dataset.dk === (r.name === 'c' || r.name === 'search' ? '' : r.name)));
  if (r.name === 'home') renderHome();
  else if (r.name === 'settings') renderSettings(stage);
  else if (r.name === 'ai') renderAI(stage, r);
  else if (r.name === 'vms') renderVMs(stage, r);
  else if (r.name === 'tools') renderTools(stage, r);
  else if (r.name === 'series') renderSeries(stage, r);
  else files.renderFiles(stage, r);
  document.title = r.name === 'home' ? 'Simplex' : (stage.querySelector('h1') ? stage.querySelector('h1').textContent + ' · Simplex' : 'Simplex');
}
window.addEventListener('hashchange', () => render());

/* ============================================================ HOME */
function renderHome() {
  const a = store.S.account || {};
  const h = new Date().getHours();
  const greet = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const name = (a.display || a.username || '').split(/\s+/)[0];
  const quota = a.quota_bytes || 0, used = store.S.used || 0, pct = quota ? Math.min(1, used / quota) : 0;
  const C = 2 * Math.PI * 22;
  const cats = store.CATEGORIES.map(c => { const items = store.ofType(c.id); const peek = items.map(store.cheapThumb).find(Boolean); return { ...c, n: items.length, peek }; }).filter(c => c.n || ['image', 'video', 'audio', 'document'].includes(c.id));
  const rec = store.recent(14);
  stage.innerHTML = html`<div class="page page-enter">
    <section class="hero">
      <div><h1>${greet}${name ? html`, <span>${name}</span>` : ''}.</h1><div class="sub">${plural(store.live().filter(f => f.type !== 'folder').length, 'file')} in your vault · ${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div></div>
      <a class="ring" href="#/files" title="Storage">
        <svg width="52" height="52" viewBox="0 0 52 52"><circle class="track" cx="26" cy="26" r="22" fill="none" stroke-width="5"/><circle class="val" cx="26" cy="26" r="22" fill="none" stroke-width="5" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>
        <div><b>${fmtSize(used)}</b><small>of ${quota ? fmtSize(quota) : '∞'} used</small></div>
      </a>
    </section>
    <div class="sect"><h2>Library</h2><a href="#/files">All files ${icon('chevron', 13)}</a></div>
    <div class="cats">${cats.map((c, i) => html`<a class="cat t-${c.id}" href="#/c/${c.path}" style="animation:rise var(--d3) var(--spring) ${i * 40}ms backwards">
      ${c.peek ? raw(`<span class="peek" style="background-image:url('${esc(c.peek)}')"></span>`) : ''}
      <span class="ci tint">${icon(c.ic, 20)}</span><div><b>${c.label}</b><small>${plural(c.n, 'item')}</small></div></a>`)}</div>
    ${rec.length && prefs.get('homeRecent') ? html`<div class="sect"><h2>Recent</h2><a href="#/recent">See all ${icon('chevron', 13)}</a></div>
      <div class="recent">${rec.map((f, i) => { const t = store.thumbUrl(f); return html`<article class="fcard" data-rid="${f.id}" style="--i:${i}" tabindex="0">
        <div class="th">${t ? raw(`<img data-src="${esc(t)}" alt="" draggable="false">`) : html`<span class="big tint t-${f.type}">${icon(f.type, 28, 1.6)}</span>`}</div>
        <div class="nm">${f.name}</div><div class="sb">${fmtSize(f.size)}</div></article>`; })}</div>` : ''}
    ${prefs.get('homeApps') ? html`<div class="sect" id="apps"><h2>Apps</h2><span class="dim" style="font-size:12.5px">${icon('lock', 12)} Locked apps open in the classic interface</span></div>
    ${appsGrid(a)}` : ''}
  </div>`.s;
  // (inline onload= handlers are blocked by the CSP, so fade-ins are wired here)
  stage.querySelector('.page').addEventListener('contextmenu', e => {
    const rc = e.target.closest('[data-rid]'), cat = e.target.closest('.cat'), app = e.target.closest('[data-app]');
    if (rc) { e.preventDefault(); menu(itemMenuItems(rc.dataset.rid), { x: e.clientX, y: e.clientY }); }
    else if (cat) { e.preventDefault(); menu([{ label: 'Open ' + cat.querySelector('b').textContent, ic: 'folder', run: () => { location.hash = cat.getAttribute('href'); } }], { x: e.clientX, y: e.clientY }); }
    else if (app) { e.preventDefault(); const a = APPS.find(x => x.id === app.dataset.app); menu(a.ready ? [{ label: 'Open ' + a.name, ic: a.ic, run: () => { location.hash = appHref(a); } }] : [{ label: a.name + ' (classic only)', ic: 'lock', run: () => lockedApp(a) }, { label: 'Open in classic', ic: 'swap', run: () => openClassic('/' + a.id) }], { x: e.clientX, y: e.clientY }); }
  });
  const recBox = stage.querySelector('.recent');
  if (recBox) lazy(recBox, img => img.replaceWith(el(html`<span class="big tint t-video">${icon('video', 28, 1.6)}</span>`.s)));
  requestAnimationFrame(() => { const v = stage.querySelector('.ring .val'); if (v) v.style.strokeDashoffset = String(C * (1 - pct)); });
  stage.querySelector('.recent') && stage.querySelector('.recent').addEventListener('click', e => { const c = e.target.closest('[data-rid]'); if (c) openViewer(store.byId(c.dataset.rid), rec); });
  const appsBox = stage.querySelector('.apps');
  if (appsBox) appsBox.addEventListener('click', e => {
    const b = e.target.closest('[data-app]'); if (!b) return;
    const app = APPS.find(x => x.id === b.dataset.app);
    if (app.ready) location.hash = appHref(app); else lockedApp(app);
  });
}

const appsGrid = a => html`<div class="apps">${visibleApps(a).map(app => html`<button class="apptile${app.ready ? '' : ' locked'}" data-app="${app.id}">
      <span class="ati tint ${app.ready ? 't-folder' : 't-app'}">${icon(app.ic, 19)}</span><span><b>${app.name}</b><small>${app.desc}</small></span>
      ${app.ready ? '' : html`<span class="lk">${icon('lock', 13)}</span>`}</button>`)}</div>`;
/* the dock's Apps button: every app in a sheet, wherever you are */
function openApps() {
  sheet({
    title: 'Apps', body: html`<p class="dim" style="font-size:13px;margin:-4px 4px 0">${icon('lock', 12)} Locked apps haven’t been rebuilt yet — they open in the classic interface.</p>${appsGrid(store.S.account)}`,
    onMount: box => box.addEventListener('click', e => {
      const b = e.target.closest('[data-app]'); if (!b) return;
      const app = APPS.find(x => x.id === b.dataset.app);
      if (app.ready) { closeSheet(); location.hash = appHref(app); } else lockedApp(app);
    }),
  });
}

const appHref = app => app.id === 'database' ? '#/files' : '#/' + app.id;

/* ============================================================ PALETTE */
function openPalette() {
  const acct = store.S.account;
  const go = h => () => { location.hash = h; };
  const base = [
    { group: 'Go to', label: 'Home', ic: 'home', run: go('#/') },
    { group: 'Go to', label: 'AI', ic: 'spark', run: go('#/ai') },
    { group: 'Go to', label: 'AI image edits', ic: 'image', tint: 't-image', run: go('#/ai/edits') },
    { group: 'Go to', label: 'All files', ic: 'folder', tint: 't-folder', run: go('#/files') },
    ...store.CATEGORIES.map(c => ({ group: 'Go to', label: c.label, ic: c.ic, tint: 't-' + c.id, run: go('#/c/' + c.path) })),
    { group: 'Go to', label: 'Starred', ic: 'star', tint: 't-folder', run: go('#/starred') },
    { group: 'Go to', label: 'Recent', ic: 'clock', run: go('#/recent') },
    { group: 'Go to', label: 'Trash', ic: 'trash', tint: 't-video', run: go('#/trash') },
    { group: 'Actions', label: 'New AI chat', ic: 'spark', run: go('#/ai') },
    ...(acct && (acct.is_admin || acct.can_vm) ? [{ group: 'Go to', label: 'Virtual machines', ic: 'desktop', run: go('#/vms') }] : []),
    { group: 'Go to', label: 'Tools', ic: 'wrench', run: go('#/tools') },
    { group: 'Go to', label: 'Series', desc: 'your shows', ic: 'video', tint: 't-video', run: go('#/series') },
    { group: 'Actions', label: 'Convert a file', ic: 'swap', run: go('#/tools/convert') },
    { group: 'Actions', label: 'Series Maker', ic: 'video', tint: 't-video', run: go('#/tools/series') },
    { group: 'Actions', label: 'Activity (uploads, downloads, conversions)', ic: 'swap', run: () => toggleActivity(true) },
    { group: 'Actions', label: 'Upload files', ic: 'upload', run: () => pickAndUpload(files.currentFolder()) },
    { group: 'Actions', label: 'New folder', ic: 'newfolder', tint: 't-folder', run: () => files.newFolder(files.currentFolder()) },
    { group: 'Actions', label: 'Settings', ic: 'settings', run: () => { location.hash = '#/settings'; } },
    { group: 'Actions', label: 'Switch to classic interface', ic: 'swap', run: () => openClassic('/') },
    ...visibleApps(acct).filter(a => !a.ready).map(a => ({ group: 'Apps', label: a.name, desc: 'classic only', ic: a.ic, locked: true, run: () => lockedApp(a) })),
  ];
  palette({
    placeholder: 'Search files, apps, actions…',
    source: q => {
      if (!q) return base;
      const score = s => { s = s.toLowerCase(); const i = s.indexOf(q); return i < 0 ? 0 : i === 0 ? 2 : 1; };
      const fileHits = store.search(q, 8).map(f => {
        const parent = store.pathOf(f.id).slice(0, -1).pop();
        const openIt = () => (f.type === 'folder' ? (location.hash = files.hrefFolder(f.id)) : openViewer(f, [f]));
        // right-click gets the same menu as in the file browser, with Open doing what clicking does here
        const menu = () => files.itemMenuItems(f.id).map((x, i) => (i === 0 && x && /^Open/.test(x.label) ? { ...x, run: openIt } : x));
        return { group: 'Files', label: f.name, desc: parent ? parent.name : 'All files', ic: f.type === 'folder' ? 'folder' : f.type, tint: 't-' + f.type, img: store.thumbUrl(f), run: openIt, menu };
      });
      const cmd = base.map(b => [b, score(b.label)]).filter(x => x[1]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
      const all = { group: 'Files', label: `Search everything for “${q}”`, ic: 'search', run: () => { location.hash = '#/search/' + encodeURIComponent(q); } };
      return [...fileHits, ...(fileHits.length >= 8 ? [all] : []), ...cmd];
    },
  });
}

/* ============================================================ KEYS */
document.addEventListener('keydown', e => {
  if (!stage || !stage.isConnected) return;
  const ae = document.activeElement;
  if (ae && ae.closest && ae.closest('[data-capture-keys]')) return;   // a focused remote desktop owns the keyboard (click outside it to use shortcuts)
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ae && ae.tagName) || (ae && ae.isContentEditable);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (typing || viewerOpen() || overlayOpen()) return;
  if (e.key === '/') { e.preventDefault(); openPalette(); return; }
  files.onKey(e);
});

boot();

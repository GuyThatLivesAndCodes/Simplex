/* settings.js — the Settings page (#/settings). Every control applies instantly
   and saves itself (prefs.js); nothing waits on an "Apply" button. */
import { html, raw, el, icon, fmtSize, plural, $$, api } from './lib.js';
import * as store from './store.js';
import * as prefs from './prefs.js';
import { toast, confirm, seg } from './ui.js';
import { openClassic, lockedApp, APPS } from './classic.js';
import * as perf from './perf.js';

const SECTIONS = [
  ['account', 'Account', 'logout'],
  ['appearance', 'Appearance', 'eye'],
  ['motion', 'Motion', 'spark'],
  ['home', 'Home', 'home'],
  ['files', 'Files', 'folder'],
  ['playback', 'Playback', 'play'],
  ['storage', 'Storage', 'database'],
  ['interface', 'Interface', 'swap'],
];

/* ---------- row builders ---------- */
const row = (title, sub, control) => html`<div class="row"><div class="rm"><b>${title}</b>${sub ? html`<small>${sub}</small>` : ''}</div>${control}</div>`;
const segCtl = (key, opts) => html`<div class="seg" data-pref-seg="${key}">${opts.map(([v, l]) => html`<button data-v="${v}">${l}</button>`)}</div>`;
const sw = key => html`<label class="sw"><input type="checkbox" data-pref-sw="${key}" ${prefs.get(key) ? 'checked' : ''}><span></span></label>`;
const range = (key, min, max, step, unit) => html`<div class="rng"><input type="range" data-pref-range="${key}" min="${min}" max="${max}" step="${step}" value="${prefs.get(key)}"><span data-out="${key}">${prefs.get(key)}${unit}</span></div>`;
const section = (id, title, body) => html`<section class="set-sec" id="set-${id}"><h2>${title}</h2><div class="group">${body}</div></section>`;

/* what Performance is doing on this device, in words */
function perfLine() {
  const p = prefs.get('perf');
  if (p === 'full') return 'Live blur and moving backdrop everywhere — best on dedicated graphics';
  if (p === 'light') return 'Same look, computed once — smooth video and scrolling on laptop graphics';
  if (p === 'saver') return 'No glow or frosted glass, quicker animations — for older phones and laptops';
  return 'Auto: ' + perf.autoReason();
}

export function renderSettings(stage) {
  const a = store.S.account || {};
  const P = prefs.get();
  const initials = (a.display || a.username || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const used = store.S.used || 0, quota = a.quota_bytes || 0;
  const byType = {};
  store.live().forEach(f => { if (f.type !== 'folder') byType[f.type] = (byType[f.type] || 0) + (f.size || 0); });
  const breakdown = Object.entries(byType).sort((x, y) => y[1] - x[1]);

  stage.innerHTML = html`<div class="page page-enter set-wrap">
    <aside class="set-nav">
      <h1>Settings</h1>
      <span class="sync" data-sync>${icon('check', 13, 2.4)} Saved to your account</span>
      <nav>${SECTIONS.map(([id, label, ic]) => html`<button data-jump="${id}">${icon(ic, 16)}<span>${label}</span></button>`)}</nav>
    </aside>
    <div class="set-main">
      ${section('account', 'Account', html`
        <div class="row who"><span class="avatar">${initials}</span><div class="rm"><b>${a.display || a.username}</b><small>@${a.username} · ${a.is_admin ? 'Administrator' : 'Member'}</small></div></div>
        ${row('Display name', 'How you appear to other members', html`<input class="in sm" data-display value="${a.display || ''}" maxlength="40" spellcheck="false">`)}
        ${row('Password & two-step sign-in', 'Still in the classic interface', html`<button class="b sm" data-classic="/settings">${icon('lock', 14)} Open</button>`)}
        ${row('Sign out', 'Ends this session on this device', html`<button class="b sm danger" data-signout>${icon('logout', 14)} Sign out</button>`)}`)}

      ${section('appearance', 'Appearance', html`
        ${row('Accent', 'Buttons, highlights and the background glow', html`<div class="swatches">${prefs.ACCENTS.map(x => html`<button class="swatch" data-accent="${x.id}" title="${x.label}" style="--sw:${x.c}"></button>`)}<label class="swatch custom" title="Custom color"><input type="color" data-accent-custom value="${/^#/.test(P.accent) ? P.accent : '#8b7cff'}"></label></div>`)}
        ${row('Backdrop', 'What sits behind everything', segCtl('backdrop', [['aurora', 'Aurora'], ['calm', 'Still'], ['solid', 'Plain']]))}
        ${row('Backdrop intensity', null, range('backdropLevel', 0, 150, 10, '%'))}
        ${row('Glass', 'How frosted panels, menus and the dock look', segCtl('glass', [['off', 'Solid'], ['light', 'Light'], ['normal', 'Normal'], ['heavy', 'Heavy']]))}
        ${row('Performance', html`<span data-perf-why>${perfLine()}</span><br><span class="dim">This device only</span>`, html`<div class="perf-ctl">${segCtl('perf', [['auto', 'Auto'], ['full', 'Full effects'], ['light', 'Light'], ['saver', 'Saver']])}<button class="b sm flat" data-perf-recheck title="Detect again on this device">${icon('restore', 14)} Check again</button></div>`)}
        ${row('Corners', null, segCtl('corners', [['sharp', 'Sharp'], ['round', 'Round'], ['extra', 'Extra round']]))}
        ${row('Font', null, segCtl('font', [['inter', 'Inter'], ['system', 'System'], ['rounded', 'Rounded']]))}
        ${row('Interface size', 'Scales text, icons and spacing together', range('scale', 90, 115, 5, '%'))}
        ${row('Density', 'How tightly cards and rows pack', segCtl('density', [['compact', 'Compact'], ['comfortable', 'Comfortable'], ['spacious', 'Spacious']]))}`)}

      ${section('motion', 'Motion', html`
        ${row('Animations', 'Reduced keeps fades but nothing moves or bounces', segCtl('motion', [['full', 'Full'], ['reduced', 'Reduced'], ['off', 'Off']]))}
        ${row('Animation speed', null, segCtl('speed', [['relaxed', 'Relaxed'], ['normal', 'Normal'], ['snappy', 'Snappy']]))}
        ${row('Dock magnification', 'Icons swell as the pointer passes over them', sw('dockMagnify'))}`)}

      ${section('home', 'Home', html`
        ${row('Recent files', 'Show your latest files on Home', sw('homeRecent'))}
        ${row('Apps', 'Show the app list on Home', sw('homeApps'))}`)}

      ${section('files', 'Files', html`
        ${row('Default view', null, segCtl('view', [['grid', 'Grid'], ['list', 'List']]))}
        ${row('Thumbnail size', 'Grid view', segCtl('thumbSize', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']]))}
        ${row('Open files with', 'Double-click lets a single click just select', segCtl('openWith', [['single', 'One click'], ['double', 'Double-click']]))}
        ${row('Show file extensions', 'e.g. “report.pdf” instead of “report”', sw('showExt'))}
        ${row('Folders first', 'Keep folders above files when sorting', sw('foldersFirst'))}`)}

      ${section('playback', 'Playback', html`
        ${row('Autoplay', 'Start videos and music as soon as they open', sw('autoplay'))}
        ${row('Resume where you left off', 'Videos remember their position across devices', sw('resume'))}
        ${row('Default volume', null, range('volume', 0, 100, 5, '%'))}
        ${row('Default speed', null, segCtl('rate', [['0.75', '0.75×'], ['1', '1×'], ['1.25', '1.25×'], ['1.5', '1.5×'], ['2', '2×']]))}
        ${row('Loop videos', null, sw('loop'))}`)}

      ${section('storage', 'Storage', html`
        <div class="row" style="flex-direction:column;align-items:stretch;gap:12px">
          <div style="display:flex;justify-content:space-between;align-items:baseline"><b style="font-size:20px">${fmtSize(used)}</b><span class="dim">${quota ? 'of ' + fmtSize(quota) + ' · ' + Math.round(used / quota * 100) + '% used' : 'no limit'}</span></div>
          <div class="stack">${breakdown.map(([t, n]) => html`<i class="t-${t}" style="width:${quota ? (n / quota * 100).toFixed(2) : (n / (used || 1) * 100).toFixed(2)}%" title="${t}: ${fmtSize(n)}"></i>`)}</div>
          <div class="legend">${breakdown.map(([t, n]) => html`<span class="t-${t}"><i></i>${({ image: 'Photos', video: 'Films', audio: 'Music', document: 'Documents', model3d: '3D models', uasset: 'Game assets' })[t] || t} · ${fmtSize(n)}</span>`)}</div>
        </div>
        ${row('Trash', plural(store.trashed().length, 'item') + ' waiting to be deleted', html`<a class="b sm" href="#/trash">${icon('trash', 14)} Open</a>`)}`)}

      ${section('interface', 'Interface', html`
        ${row('Classic interface', 'The previous Simplex, with every app', html`<button class="b sm" data-classic="/">${icon('swap', 14)} Switch</button>`)}
        ${row('Members, AI & admin settings', 'Still in the classic interface', html`<button class="b sm" data-locked>${icon('lock', 14)} Open</button>`)}
        <div class="row" style="flex-direction:column;align-items:stretch"><b>Keyboard shortcuts</b><dl class="keys">
          ${[['Ctrl/⌘ K or /', 'Search & commands'], ['Ctrl/⌘ A', 'Select all'], ['Delete', 'Move selection to Trash'], ['F2', 'Rename'], ['Esc', 'Clear selection / close'], ['← →', 'Previous / next file in a viewer'], ['Space · J · L', 'Play/pause · back 10s · forward 10s'], ['F · M', 'Fullscreen · mute'], ['Ctrl/⌘ S', 'Save in the text editor']].map(([k, v]) => html`<div><dt><span class="kbd">${k}</span></dt><dd>${v}</dd></div>`)}
        </dl></div>
        ${row('Reset settings', 'Put everything on this page back to its default', html`<button class="b sm" data-reset>${icon('restore', 14)} Reset</button>`)}`)}
    </div>
  </div>`.s;

  const page = stage.firstElementChild;
  // segmented controls with sliding thumbs
  $$('[data-pref-seg]', page).forEach(s => { const k = s.dataset.prefSeg; seg(s, String(prefs.get(k)), v => prefs.set({ [k]: k === 'rate' ? Number(v) : v })); });
  // switches + sliders
  page.addEventListener('change', e => { const k = e.target.dataset.prefSw; if (k) prefs.set({ [k]: e.target.checked }); });
  page.addEventListener('input', e => {
    const k = e.target.dataset.prefRange;
    if (k) { const v = Number(e.target.value); paintRange(e.target); page.querySelector(`[data-out="${k}"]`).textContent = v + '%'; prefs.set({ [k]: v }); }
    if (e.target.matches('[data-accent-custom]')) { prefs.set({ accent: e.target.value }); markAccent(); }
  });
  $$('input[type=range]', page).forEach(paintRange);
  markAccent();
  page.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.jump) { const t = page.querySelector('#set-' + b.dataset.jump); t && t.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (b.dataset.accent) { prefs.set({ accent: b.dataset.accent }); markAccent(); return; }
    if (b.dataset.classic) return openClassic(b.dataset.classic);
    if (b.hasAttribute('data-perf-recheck')) { prefs.set({ perf: 'auto' }); perf.recheck(); renderSettings(stage); toast('Checking this device…', { ic: 'restore' }); setTimeout(() => { const w = stage.querySelector('[data-perf-why]'); if (w) w.textContent = perfLine(); }, 4500); return; }
    if (b.hasAttribute('data-locked')) return lockedApp(APPS.find(x => x.id === 'settings'));
    if (b.hasAttribute('data-signout')) return window.dispatchEvent(new CustomEvent('nx:signout'));
    if (b.hasAttribute('data-reset')) {
      if (await confirm({ title: 'Reset all settings?', text: 'Appearance, motion, files and playback go back to their defaults.', ok: 'Reset', ic: 'restore' })) { prefs.reset(); renderSettings(stage); toast('Settings reset', { ic: 'restore' }); }
    }
  });
  // display name: saves on Enter or when the field loses focus
  const dn = page.querySelector('[data-display]');
  const saveName = async () => {
    const v = dn.value.trim(); if (!v || v === (store.S.account.display || '')) return;
    try { const r = await api('/api/accounts/me', { method: 'PATCH', json: { display: v } }); store.S.account = r.account; store.emit('account'); toast('Name updated', { ic: 'check' }); }
    catch (err) { toast(err.message, { bad: true }); dn.value = store.S.account.display || ''; }
  };
  dn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); dn.blur(); } });
  dn.addEventListener('blur', saveName);
  // highlight the section in view
  const navBtns = $$('[data-jump]', page);
  const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) navBtns.forEach(b => b.classList.toggle('on', 'set-' + b.dataset.jump === en.target.id)); }), { root: stage, rootMargin: '-20% 0px -70% 0px' });
  $$('.set-sec', page).forEach(s => io.observe(s));
  // the "Saved" chip pulses whenever a setting changes
  const sync = page.querySelector('[data-sync]');
  const offPerf = prefs.onPrefs(p => { if (!page.isConnected) return offPerf(); if ('perf' in p) { if (p.perf === 'auto') perf.detect(); const w = page.querySelector('[data-perf-why]'); if (w) w.textContent = perfLine(); } });
  const off = prefs.onPrefs(() => { if (!sync.isConnected) return off(); sync.classList.remove('pulse'); void sync.offsetWidth; sync.classList.add('pulse'); });

  function markAccent() {
    const cur = prefs.get('accent');
    $$('[data-accent]', page).forEach(s => s.classList.toggle('on', s.dataset.accent === cur));
    const c = page.querySelector('.swatch.custom'); c && c.classList.toggle('on', /^#/.test(cur));
  }
}
function paintRange(r) { const p = (r.value - r.min) / (r.max - r.min) * 100; r.style.setProperty('--fill', p + '%'); }

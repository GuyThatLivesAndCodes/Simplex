/* prefs.js — every user-adjustable setting in the new UI.
 *
 * One flat object with defaults. apply() turns it into CSS variables / root
 * attributes, so a change is visible instantly with no re-render. Saved to
 * localStorage right away and synced (debounced) to the account under
 * prefs.nx, which the server MERGES — classic's own prefs are never touched.
 */
import { api, lsGet, lsSet } from './lib.js';

export const DEFAULTS = {
  // appearance
  accent: 'violet',          // preset id or '#rrggbb'
  backdrop: 'aurora',        // aurora | calm | solid
  backdropLevel: 100,        // 0–150 (% of default intensity)
  glass: 'normal',           // off | light | normal | heavy
  corners: 'round',          // sharp | round | extra
  scale: 100,                // 90–115 (% interface size)
  font: 'inter',             // inter | system | rounded
  density: 'comfortable',    // compact | comfortable | spacious
  // performance
  perf: 'auto',              // auto | full | light | saver — per DEVICE: never synced to the account (perf.js)
  // motion
  motion: 'full',            // full | reduced | off
  speed: 'normal',           // relaxed | normal | snappy
  dockMagnify: true,
  // home
  homeRecent: true,
  homeApps: true,
  // files
  view: 'grid',              // grid | list
  thumbSize: 'm',            // s | m | l
  showExt: true,
  openWith: 'single',        // single | double
  foldersFirst: true,
  // playback
  autoplay: true,
  resume: true,
  volume: 90,                // 0–100
  rate: 1,                   // 0.5–2
  loop: false,
  capLang: '',               // captions: '' off, else the language last chosen ('*' = a file with no language)
  capSize: 'm',              // s | m | l | xl
  capBg: true,               // dark box behind caption text
  // AI
  aiMode: 'auto',            // auto | ask | allow — when tools check with the user first
  aiAutoMemory: true,        // learn memories from conversations automatically
  aiHistory: true,           // let the AI search past chats
  aiPrompt: 'full',          // none | minimal | full — how much instruction goes with every message
};

export const ACCENTS = [
  { id: 'violet', label: 'Violet', c: 'oklch(0.74 0.16 285)' },
  { id: 'blue', label: 'Blue', c: 'oklch(0.72 0.15 250)' },
  { id: 'teal', label: 'Teal', c: 'oklch(0.76 0.12 190)' },
  { id: 'green', label: 'Green', c: 'oklch(0.77 0.15 150)' },
  { id: 'amber', label: 'Amber', c: 'oklch(0.80 0.14 75)' },
  { id: 'rose', label: 'Rose', c: 'oklch(0.73 0.16 355)' },
  { id: 'red', label: 'Red', c: 'oklch(0.69 0.18 25)' },
  { id: 'silver', label: 'Silver', c: 'oklch(0.86 0.01 270)' },
];

const LS = 'nx.prefs';
let P = { ...DEFAULTS, ...safeParse(lsGet(LS)) };
const subs = new Set();
function safeParse(s) { try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }

export const get = k => (k ? P[k] : P);
export function onPrefs(fn) { subs.add(fn); return () => subs.delete(fn); }

export function set(patch) {
  P = { ...P, ...patch };
  lsSet(LS, JSON.stringify(P));
  apply();
  subs.forEach(fn => { try { fn(patch, P); } catch (e) { console.error(e); } });
  queueSync();
}
export function reset() { P = { ...DEFAULTS }; lsSet(LS, JSON.stringify(P)); apply(); subs.forEach(fn => fn({ ...DEFAULTS }, P)); queueSync(); }

/* adopt the account's copy at sign-in (it wins over this browser's) */
export function adoptFromAccount(account) {
  const nx = account && account.prefs && account.prefs.nx;
  if (!nx || typeof nx !== 'object') { queueSync(); return; }   // first time: push ours up
  // performance is a property of THIS device (a phone and a desktop on one account
  // need different settings), so the account copy never overrides it
  P = { ...DEFAULTS, ...nx, perf: P.perf };
  lsSet(LS, JSON.stringify(P));
  apply();
  subs.forEach(fn => fn(P, P));
}

let syncTimer = null;
const LOCAL_ONLY = new Set(['perf']);   // device settings: stay in this browser
function queueSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    // only non-default values go up — keeps the shared prefs blob small (server caps it at 4KB)
    const diff = {};
    for (const k in P) if (P[k] !== DEFAULTS[k] && !LOCAL_ONLY.has(k)) diff[k] = P[k];
    api('/api/accounts/me', { method: 'PATCH', json: { prefs: { nx: diff } } }).catch(() => {});
  }, 900);
}

/* ---------- apply to the page ---------- */
export function apply() {
  const r = document.documentElement, s = r.style;
  const preset = ACCENTS.find(a => a.id === P.accent);
  const hex = /^#[0-9a-f]{6}$/i.test(P.accent) ? P.accent : null;
  s.setProperty('--acc', hex || (preset || ACCENTS[0]).c);
  r.dataset.backdrop = ['aurora', 'calm', 'solid'].includes(P.backdrop) ? P.backdrop : 'aurora';
  s.setProperty('--bg-o', String(clamp(P.backdropLevel, 0, 150) / 100));
  r.dataset.glass = ['off', 'light', 'normal', 'heavy'].includes(P.glass) ? P.glass : 'normal';
  s.setProperty('--rk', String({ sharp: 0.4, round: 1, extra: 1.4 }[P.corners] || 1));
  const sc = clamp(P.scale, 90, 115) / 100;
  s.zoom = sc === 1 ? '' : String(sc);
  s.setProperty('--zoom', String(sc));
  r.dataset.font = ['inter', 'system', 'rounded'].includes(P.font) ? P.font : 'inter';
  if (P.font === 'rounded') loadFont('Nunito:wght@400;500;600;700;800');
  s.setProperty('--den', String({ compact: 0.78, comfortable: 1, spacious: 1.22 }[P.density] || 1));
  r.dataset.motion = P.motion === 'off' ? 'off' : P.motion === 'reduced' ? 'reduced' : 'on';
  const spd = { relaxed: 1.45, normal: 1, snappy: 0.68 }[P.speed] || 1;
  s.setProperty('--spd', String(spd));
  window.__nxSpeed = spd;
  s.setProperty('--card-w', ({ s: 140, m: 176, l: 236 }[P.thumbSize] || 176) + 'px');
  r.toggleAttribute('data-hide-ext', !P.showExt);
  // light effects: chosen, or decided automatically on this device (perf.js)
  const autoLvl = String(lsGet('nx.perf.auto', '') || '').split(':')[0];   // '' | full | lite | saver
  const saver = P.perf === 'saver' || (P.perf === 'auto' && autoLvl === 'saver');
  r.toggleAttribute('data-lite', saver || P.perf === 'light' || (P.perf === 'auto' && autoLvl === 'lite'));
  r.toggleAttribute('data-saver', saver);
}
function clamp(v, lo, hi) { v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; }
const loadedFonts = new Set();
function loadFont(spec) {
  if (loadedFonts.has(spec)) return; loadedFonts.add(spec);
  const l = document.createElement('link'); l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=' + spec + '&display=swap';
  document.head.appendChild(l);
}

apply();   // first paint already reflects this browser's saved settings

/* perf.js — keeps the interface smooth on low-power graphics (laptop iGPUs).

   The look relies on two GPU-heavy effects: live "frosted glass" (backdrop-filter,
   which re-blurs whatever is behind a panel every time it changes) and a drifting,
   heavily blurred glow behind everything. Together they keep a dedicated GPU busy
   and choke an integrated one — video drops to a few frames per second.

   Light effects (root attribute data-lite) keep the same design but compute it once:
   panels get a slightly denser tint instead of a live blur, the glow holds still.
   Saver (root attribute data-saver, on top of data-lite) is for genuinely weak
   devices — old phones, 2-core laptops, software rendering: no backdrop glow at
   all, no frosted glass anywhere (incl. the small chips on every file card), and
   entrance animations without their blur filter.
   Settings → Performance chooses Auto (default) / Full / Light / Saver. Auto decides from:
     1. the graphics chip (WebGL renderer: Intel HD/UHD/Iris, AMD APU graphics,
        software renderers…) and core/memory counts — instant, no jank at boot
     2. a short frame-rate sample after the app loads
     3. video playback: if the player starts dropping frames, it switches on the spot
   An automatic decision is remembered on this device (never sent to the account),
   and "Check again" in Settings clears it. */
import { lsGet, lsSet } from './lib.js';
import * as prefs from './prefs.js';

const KEY = 'nx.perf.auto';          // '' | 'saver:<reason>' | 'lite:<reason>' | 'full:<reason>'
const SOFT_GPU = /swiftshader|llvmpipe|softpipe|basic render|microsoft basic|no webgl/i;   // no GPU acceleration at all
const WEAK_GPU = /intel|\buhd\b|\biris\b|hd graphics|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|mali|adreno|powervr|swiftshader|llvmpipe|softpipe|basic render|microsoft basic|virtualbox|vmware|parallels/i;

let gpu = null;
export function gpuName() {
  if (gpu != null) return gpu;
  gpu = '';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl', { failIfMajorPerformanceCaveat: false }) || c.getContext('experimental-webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
      const lose = gl.getExtension('WEBGL_lose_context'); lose && lose.loseContext();   // give the context back right away
    } else gpu = 'no WebGL';
  } catch (e) { gpu = ''; }
  return gpu;
}
const prettyGpu = () => gpuName().replace(/^ANGLE \((.*)\)$/, '$1').replace(/\s*Direct3D.*$/i, '').replace(/^[^,]*,\s*/, '').replace(/\s*\(0x[0-9a-f]+\)/gi, '').trim();

const saved = () => lsGet(KEY, '') || '';
/* level: 'full' | 'lite' | 'saver' (true/false kept for the light/full calls) */
function decide(level, why) { const l = level === true ? 'lite' : level === false ? 'full' : level; lsSet(KEY, l + ':' + why); prefs.apply(); }
export const autoSaver = () => saved().startsWith('saver:');
export const autoLite = () => saved().startsWith('lite:') || autoSaver();
export function autoReason() {
  const s = saved(); if (!s) return 'Checking…';
  const why = s.slice(s.indexOf(':') + 1);
  return (autoSaver() ? 'Saver' : s.startsWith('lite:') ? 'Light effects' : 'Full effects') + (why ? ' — ' + why : '');
}

/* 1 + 2: called once the app is on screen */
export function detect() {
  if (prefs.get('perf') !== 'auto' || saved()) return;
  const g = gpuName(), cores = navigator.hardwareConcurrency || 8, mem = navigator.deviceMemory || 8;
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  // the weakest devices go straight to Saver
  if (SOFT_GPU.test(g)) return decide('saver', 'no graphics acceleration');
  if (saveData) return decide('saver', 'Data Saver is on');
  if (cores <= 2 || mem <= 2) return decide('saver', `${cores} CPU threads, ${mem} GB memory`);
  if (g === 'no WebGL' || WEAK_GPU.test(g) && !/apple|nvidia|geforce|quadro|rtx|radeon rx|radeon pro|arc a\d/i.test(g)) return decide(true, prettyGpu() || 'integrated graphics');
  if (cores <= 4 || mem <= 4) return decide(true, `${cores} CPU threads, ${mem} GB memory`);
  sampleFrames(fps => { if (fps < 28) decide('saver', `about ${Math.round(fps)} frames per second`); else if (fps < 42) decide(true, `about ${Math.round(fps)} frames per second`); else decide(false, prettyGpu() || 'fast graphics'); });
}
/* median frame rate over ~2s of normal animation (only while the tab is visible) */
function sampleFrames(done) {
  if (document.visibilityState !== 'visible') return;
  const gaps = []; let last = 0, n = 0;
  const step = t => {
    if (document.visibilityState !== 'visible') return;   // a hidden tab is throttled — the sample would lie
    if (last) gaps.push(t - last);
    last = t;
    if (++n < 130) requestAnimationFrame(step);
    else { gaps.sort((a, b) => a - b); done(1000 / gaps[Math.floor(gaps.length / 2)]); }
  };
  setTimeout(() => requestAnimationFrame(step), 1500);   // let the boot animations settle first
}
/* 3: the player reports struggling playback */
/* Auto steps down one level per struggle: full → light, and if video still drops
   frames with light effects on, light → saver. */
let warned = '';
export function struggling(why) {
  if (prefs.get('perf') !== 'auto' || autoSaver()) return false;
  const next = autoLite() ? 'saver' : 'lite';
  decide(next, why);
  if (warned !== next) {
    warned = next;
    const msg = next === 'saver' ? 'Switched to Saver so playback stays smooth' : 'Switched to light effects so playback stays smooth';
    import('./ui.js').then(u => u.toast(msg, { ic: 'play', action: 'Settings', onAction: () => { location.hash = '#/settings'; } }));
  }
  return true;
}
export function recheck() { lsSet(KEY, null); prefs.apply(); detect(); }

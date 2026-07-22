/* Tweaks layer — mounts a React panel that drives CSS variables on the vanilla app.
   Wrapped in an IIFE: Babel-standalone injects each text/babel script at the top
   level of the SHARED global scope, so a bare top-level `const` here collides with
   the same name in app.js (e.g. `ACCENTS`) and throws "redeclaration of const",
   which aborts this whole file (theme + panel never mount). Keeping our locals
   inside a function scope avoids that. The panel components come from
   tweaks-panel.jsx via window.*, so we still read them as globals below. */
(function () {
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "amber",
  "tone": "warm",
  "radius": 11,
  "scanlines": true,
  "albumSpin": true
}/*EDITMODE-END*/;

const ACCENTS = { amber: 74, blue: 235, emerald: 162, violet: 300, rose: 18 };
const TONES = { warm: 66, slate: 250, graphite: 305 };

/* The per-account Appearance system (applyPrefs in app.js) owns these variables:
   themes work via [data-theme] presets on :root, and inline styles ALWAYS beat
   attribute selectors. So this legacy layer must only pin a variable when the
   user actually tweaked it away from the factory look — writing the factory
   values inline (as it used to at boot) silently disabled every theme, including
   the light modes. Track what we set so returning to a default cleans up. */
let _accSet = false, _toneSet = false, _radSet = false;
function applyTweaks(t) {
  const r = document.documentElement.style;
  if (t.accent !== 'amber') {
    const aH = ACCENTS[t.accent] ?? 74;
    r.setProperty('--acc', `oklch(0.815 0.135 ${aH})`);
    r.setProperty('--acc-deep', `oklch(0.70 0.13 ${aH})`);
    r.setProperty('--acc-glow', `oklch(0.815 0.135 ${aH} / 0.18)`);
    _accSet = true;
  } else if (_accSet) {
    r.removeProperty('--acc'); r.removeProperty('--acc-deep'); r.removeProperty('--acc-glow');
    _accSet = false;
  }
  if (t.tone !== 'warm') {
    const sH = TONES[t.tone] ?? 66;
    r.setProperty('--bg',        `oklch(0.165 0.008 ${sH})`);
    r.setProperty('--bg-deep',   `oklch(0.135 0.007 ${sH})`);
    r.setProperty('--raised',    `oklch(0.205 0.009 ${sH})`);
    r.setProperty('--card',      `oklch(0.232 0.010 ${sH})`);
    r.setProperty('--card-hi',   `oklch(0.275 0.011 ${sH})`);
    r.setProperty('--line',      `oklch(0.315 0.011 ${sH})`);
    r.setProperty('--line-soft', `oklch(0.262 0.010 ${sH})`);
    _toneSet = true;
  } else if (_toneSet) {
    for (const p of ['--bg', '--bg-deep', '--raised', '--card', '--card-hi', '--line', '--line-soft']) r.removeProperty(p);
    _toneSet = false;
  }
  if (t.radius !== 11) {
    r.setProperty('--radius', t.radius + 'px');
    r.setProperty('--radius-sm', Math.max(3, t.radius - 4) + 'px');
    _radSet = true;
  } else if (_radSet) {
    r.removeProperty('--radius'); r.removeProperty('--radius-sm');
    _radSet = false;
  }
  const lock = document.getElementById('lock');
  if (lock) lock.style.setProperty('--scan-op', t.scanlines ? '0.5' : '0');
  window.__albumSpin = t.albumSpin;
}

function TweaksApp() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  React.useEffect(() => { applyTweaks(t); }, [t]);
  return (
    <TweaksPanel title="Tweaks">
      <TweakSection label="Accent" />
      <TweakColor label="Accent color" value={accentHex(t.accent)}
        options={Object.keys(ACCENTS).map(accentHex)}
        onChange={(v) => setTweak('accent', accentName(v))} />
      <TweakSection label="Surface" />
      <TweakRadio label="Tone" value={t.tone} options={['warm', 'slate', 'graphite']}
        onChange={(v) => setTweak('tone', v)} />
      <TweakSlider label="Corner radius" value={t.radius} min={2} max={20} step={1} unit="px"
        onChange={(v) => setTweak('radius', v)} />
      <TweakSection label="Atmosphere" />
      <TweakToggle label="Lock-screen scanlines" value={t.scanlines}
        onChange={(v) => setTweak('scanlines', v)} />
      <TweakToggle label="Spin album art on play" value={t.albumSpin}
        onChange={(v) => setTweak('albumSpin', v)} />
    </TweaksPanel>
  );
}

// map accent name <-> representative hex (for the swatch control)
const ACCENT_HEX = { amber: '#e0a64a', blue: '#5b8def', emerald: '#3fb88a', violet: '#a98ce6', rose: '#e08a6f' };
function accentHex(name) { return ACCENT_HEX[name] || name; }
function accentName(hex) { return Object.keys(ACCENT_HEX).find(k => ACCENT_HEX[k] === hex) || 'amber'; }

// apply persisted tweaks immediately (defaults reflect the last saved EDITMODE block).
// This sets the theme CSS vars and runs WITHOUT React, so it must not be guarded
// away — but the CSS :root defaults already match, so even a no-op is safe.
applyTweaks(TWEAK_DEFAULTS);

// Mount the panel only if its React/Babel deps actually loaded. If a CDN script
// failed (see index.html onerror -> __simplexTweaksMissing), skip quietly — the
// core app does not depend on the panel, and the theme above is already applied.
if (typeof React !== 'undefined' && typeof ReactDOM !== 'undefined' &&
    typeof TweaksPanel !== 'undefined' && document.getElementById('tweaks-root')) {
  ReactDOM.createRoot(document.getElementById('tweaks-root')).render(<TweaksApp />);
}
})();

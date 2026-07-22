/* ============================================================
   THERMAL GUARD — protect an at-home box from sustained overheating
   ------------------------------------------------------------
   This is a SAFETY NET, not a precise governor. Local AI inference pins the CPU
   at 100% across all cores; on a small machine (e.g. a home OptiPlex with stock
   cooling) a long session can push temperatures up. If the measured temperature
   stays at/above a trip threshold for a sustained window, we:
     1. stop all local AI (the engine unloads every model + refuses new loads),
     2. start a fixed cooldown (default 5 minutes), and
     3. only resume once the cooldown has elapsed AND the temperature has dropped
        back below a safe "resume" level (otherwise the cooldown extends).

   Temperature source (no admin, no extra dependency):
     • Windows — Win32_PerfFormattedData_Counters_ThermalZoneInformation via a
       short PowerShell CIM query. Values are ACPI thermal-zone temps in Kelvin;
       we take the hottest zone as the representative reading. NB: ACPI zones can
       read somewhat below the true CPU-die temperature and on some boards are
       flat — so this guard is conservative by nature. Thresholds are tunable.
     • Linux  — /sys/class/thermal/thermal_zoneN/temp (milli-°C), hottest zone.
     • Other  — no reading; the guard stays dormant (never trips) so the feature
       degrades to "no thermal protection" rather than blocking everything.

   The poll is async (spawned child / async file read) so it never blocks the
   event loop — see the EVENT-LOOP-BLOCKED history in the project notes.
   ============================================================ */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');

function numEnv(name, dflt) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : dflt; }

/* ---------- tunables (all overridable via env) ---------- */
const POLL_MS         = numEnv('SX_THERMAL_POLL_MS', 10_000);    // how often to sample temperature
const TRIP_SUSTAIN_MS = numEnv('SX_THERMAL_SUSTAIN_MS', 30_000); // must stay hot this long before tripping (ignore brief spikes)
const COOLDOWN_MS     = numEnv('SX_THERMAL_COOLDOWN_MS', 5 * 60 * 1000);  // how long local AI stays disabled after a trip

// Trip / resume temperatures are admin-tunable at runtime (Settings → Local AI),
// persisted server-side and applied via configure(); env provides the default.
let TRIP_C   = numEnv('SX_THERMAL_TRIP_C', 90);        // sustained at/above this (°C) → trip
let RESUME_C = numEnv('SX_THERMAL_RESUME_C', 75);      // after cooldown, only resume once back below this (°C)

/* Clamp + apply admin thresholds. Both optional; ignores out-of-range/garbage.
   RESUME must stay safely below TRIP so we can't trip-then-instantly-resume. */
function configure({ tripC, resumeC } = {}) {
  if (Number.isFinite(+tripC)) TRIP_C = Math.min(110, Math.max(40, +tripC));
  if (Number.isFinite(+resumeC)) RESUME_C = Math.min(105, Math.max(30, +resumeC));
  if (RESUME_C >= TRIP_C) RESUME_C = Math.max(30, TRIP_C - 5);   // keep a gap
  return { tripC: TRIP_C, resumeC: RESUME_C };
}

/* ---------- state ---------- */
let started = false;
let pollTimer = null;
let lastTempC = null;        // most recent reading (°C), or null if unavailable
let lastReadAt = 0;
let hotSince = null;         // timestamp the temp first went >= TRIP_C in the current hot streak
let tripped = false;
let cooldownUntil = 0;       // epoch ms; local AI disabled until then (and until cool)
let tripCount = 0;
let onTripCb = null;         // called once when we trip (engine wires this to unload all)
let supported = null;        // null=unknown, true/false after first read attempt

/* register the action to run the moment we trip (e.g. unload all local models) */
function onTrip(fn) { onTripCb = fn; }

function start() {
  if (started) return;
  started = true;
  // kick an immediate read, then poll
  sample().catch(() => {});
  pollTimer = setInterval(() => { sample().catch(() => {}); }, POLL_MS);
  if (pollTimer.unref) pollTimer.unref();   // don't keep the process alive for this
}
function stop() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } started = false; }

/* ---------- temperature readers ---------- */
function readWindows() {
  return new Promise((resolve) => {
    // hottest ACPI thermal zone, in Kelvin (Temperature is K; HighPrecision is dK)
    const ps = 'try { (Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction Stop '
      + '| Measure-Object -Property HighPrecisionTemperature -Maximum).Maximum } catch { "" }';
    let out = '';
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    } catch (e) { return finish(null); }
    const killTimer = setTimeout(() => { try { child.kill(); } catch (e) {} finish(null); }, 6000);
    if (killTimer.unref) killTimer.unref();
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.on('error', () => { clearTimeout(killTimer); finish(null); });
    child.on('close', () => {
      clearTimeout(killTimer);
      const dK = parseFloat(String(out).trim());      // deci-Kelvin
      if (!Number.isFinite(dK) || dK <= 0) return finish(null);
      finish((dK / 10) - 273.15);                      // → °C
    });
  });
}

async function readLinux() {
  try {
    const base = '/sys/class/thermal';
    const zones = (await fsp.readdir(base)).filter(z => /^thermal_zone\d+$/.test(z));
    let max = null;
    for (const z of zones) {
      try {
        const raw = await fsp.readFile(`${base}/${z}/temp`, 'utf8');
        const milliC = parseInt(raw.trim(), 10);
        if (Number.isFinite(milliC)) { const c = milliC / 1000; if (max == null || c > max) max = c; }
      } catch (e) {}
    }
    return max;
  } catch (e) { return null; }
}

async function readTempC() {
  if (process.platform === 'win32') return readWindows();
  if (process.platform === 'linux') return readLinux();
  return null;   // unsupported platform → no reading
}

/* ---------- the sampling + state machine ---------- */
async function sample() {
  const t = await readTempC();
  lastReadAt = Date.now();
  if (t == null) { supported = supported || false; lastTempC = null; return; }
  supported = true;
  lastTempC = Math.round(t * 10) / 10;
  const now = Date.now();

  if (tripped) {
    // stay tripped until BOTH the cooldown elapsed AND we're back below RESUME_C
    if (now >= cooldownUntil && lastTempC <= RESUME_C) {
      tripped = false; hotSince = null;
    } else if (now >= cooldownUntil && lastTempC > RESUME_C) {
      // cooled-down period passed but still warm — extend a little rather than thrash
      cooldownUntil = now + Math.min(COOLDOWN_MS, 60_000);
    }
    return;
  }

  if (lastTempC >= TRIP_C) {
    if (hotSince == null) hotSince = now;
    if (now - hotSince >= TRIP_SUSTAIN_MS) trip();
  } else {
    hotSince = null;   // cooled off before the sustain window → reset the streak
  }
}

function trip() {
  if (tripped) return;
  tripped = true;
  tripCount++;
  cooldownUntil = Date.now() + COOLDOWN_MS;
  console.warn(`[simplex] THERMAL TRIP — ${lastTempC}°C ≥ ${TRIP_C}°C sustained; disabling local AI for ${Math.round(COOLDOWN_MS / 1000)}s to cool down`);
  if (onTripCb) { try { onTripCb(); } catch (e) {} }
}

/* Manually clear a trip (admin override). Respects nothing — use sparingly. */
function reset() { tripped = false; hotSince = null; cooldownUntil = 0; }

/* ---------- queries used by the engine + API ---------- */
function isBlocked() { return tripped; }
function cooldownRemainingMs() { return tripped ? Math.max(0, cooldownUntil - Date.now()) : 0; }

function state() {
  return {
    supported: supported !== false,            // unknown(null) is treated as "maybe" until first read
    tempC: lastTempC,
    lastReadAt,
    tripped,
    cooldownRemainingMs: cooldownRemainingMs(),
    tripCount,
    thresholds: { tripC: TRIP_C, resumeC: RESUME_C, sustainMs: TRIP_SUSTAIN_MS, cooldownMs: COOLDOWN_MS },
  };
}

module.exports = { start, stop, onTrip, configure, sample, state, isBlocked, cooldownRemainingMs, reset, readTempC };

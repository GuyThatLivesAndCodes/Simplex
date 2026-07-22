/* ============================================================
   LOCAL AI ENGINE — self-hosted GGUF inference, no external apps
   ------------------------------------------------------------
   Runs local language models entirely on the backend by managing bundled
   llama.cpp `llama-server` child processes (engine/bin/). No Ollama / LM Studio /
   any installed runtime — the binary ships inside the repo (CPU build, ~38 MB),
   so the only dependency is the OS loader.

   Model sources (both surfaced as "Local" models to the AI app):
     • SERVER models  — *.gguf the admin drops into  <ROOT>/models/.  Read straight
                        off disk (already plaintext).
     • USER models    — *.gguf a user uploaded into their own encrypted vault. The
                        bytes are AES-encrypted at rest, so before a load we
                        DECRYPT the blob to a private temp file (engine cache) and
                        point llama-server at that.

   For each distinct model we lazy-spawn ONE llama-server on a private localhost
   port the first time it's used, reuse it for subsequent turns, and idle-unload it
   after IDLE_MS. A small LRU cap bounds how many run at once (each holds the whole
   model in RAM). llama-server exposes an OpenAI-compatible streaming
   /v1/chat/completions, which maps directly onto the app's existing SSE chat shape.

   This module is backend-only and holds no vault keys itself: the caller passes in
   an already-opened `store` (which owns the keys) so we can decrypt a user blob.
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const vault = require('../crypto');
const thermal = require('./thermal');   // CPU-temperature safety net (cools down local AI when hot)

/* Reliably terminate a llama-server child + everything it spawned. `proc.kill()`
   alone is unreliable on Windows (the child can detach / outlive the parent),
   which orphans a ~0.5 GB process. On Windows we taskkill the whole tree by PID;
   elsewhere a SIGKILL on the (process-group) child suffices. `sync` is used from
   the exit handler, where the event loop is already shutting down so an async
   spawn would never complete. */
function killTree(proc, sync) {
  if (!proc || proc.killed || proc.pid == null) return;
  if (process.platform === 'win32') {
    const args = ['/PID', String(proc.pid), '/F', '/T'];
    try {
      if (sync) spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } catch (e) {}
    try { proc.kill(); } catch (e) {}
  } else {
    try { proc.kill('SIGKILL'); } catch (e) {}
  }
}

const ENGINE_DIR = __dirname;
const ROOT = path.join(ENGINE_DIR, '..');
const BIN_DIR = path.join(ENGINE_DIR, 'bin');
const SERVER_EXE = path.join(BIN_DIR, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
// Where admins drop pre-uploaded models. Configurable, but defaults to <ROOT>/models.
let MODELS_DIR = path.join(ROOT, 'models');
// Decrypted copies of user vault models + scratch live here (wiped on boot).
const CACHE_DIR = path.join(ENGINE_DIR, 'cache');

/* ---------- tunables (overridable via env) ---------- */
const IDLE_MS = intEnv('SX_LOCAL_AI_IDLE_MS', 10 * 60 * 1000);    // unload a model after 10 min idle
const MAX_LOADED = intEnv('SX_LOCAL_AI_MAX_LOADED', 1);           // how many models may be resident at once
const CTX_SIZE = intEnv('SX_LOCAL_AI_CTX', 8192);                 // context window passed to llama-server (capped by the model's own trained max)
const SPAWN_TIMEOUT_MS = intEnv('SX_LOCAL_AI_SPAWN_TIMEOUT_MS', 180 * 1000);  // model load can be slow (big file / cold disk)
const PORT_BASE = intEnv('SX_LOCAL_AI_PORT_BASE', 11500);
const PORT_SPAN = 200;

function intEnv(name, dflt) { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : dflt; }

/* ============================================================
   ENGINE STATE
   ============================================================ */
// Map<modelKey, instance>  — modelKey is the public model id (see idFor).
const loaded = new Map();
// Map<modelKey, Promise<instance>> — in-flight loads so concurrent turns share one spawn.
const loading = new Map();

function ensureDirs() {
  try { fs.mkdirSync(MODELS_DIR, { recursive: true }); } catch (e) {}
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) {}
}

/* On boot: make sure dirs exist, wipe decrypted user-model scratch, and sweep any
   orphaned model servers from a previous process. Both matter because a HARD kill
   of the parent on Windows (or a crash) can't run our exit handler — it would
   leave a ~0.5 GB llama-server running and a plaintext .gguf in cache. Since a
   restart relaunches server.js (run.js supervisor), this fresh-boot sweep is the
   reliable backstop. Same defensive pattern as the RUN_DIR/TOOLS_DIR wipe. */
function init({ modelsDir } = {}) {
  if (modelsDir) MODELS_DIR = path.resolve(modelsDir);
  ensureDirs();
  sweepOrphans();
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      try { fs.rmSync(path.join(CACHE_DIR, f), { recursive: true, force: true }); } catch (e) {}
    }
  } catch (e) {}
  // Thermal safety net: the moment it trips, stop all local AI (free the CPU so
  // the box can cool). New loads/turns are refused during the cooldown — see the
  // thermal.isBlocked() guard in ensureRunning.
  thermal.onTrip(() => { unloadAll(false); });
  thermal.start();
}

/* Kill any leftover llama-server processes that were launched from OUR bundled
   binary (matched by executable path, so we never touch an unrelated llama-server
   the host might run). Best-effort + synchronous: it only runs once at boot. */
function sweepOrphans() {
  if (process.platform !== 'win32') {
    // POSIX: match the full path in the process table; SIGKILL any survivors.
    try { spawnSync('pkill', ['-f', SERVER_EXE], { stdio: 'ignore' }); } catch (e) {}
    return;
  }
  try {
    // WMIC is deprecated; PowerShell CIM is the durable way to match by path.
    const ps = `Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | `
      + `Where-Object { $_.ExecutablePath -eq '${SERVER_EXE.replace(/'/g, "''")}' } | `
      + `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: 'ignore', timeout: 8000 });
  } catch (e) {}
}

function setModelsDir(dir) {
  MODELS_DIR = path.resolve(dir || path.join(ROOT, 'models'));
  ensureDirs();
}
function getModelsDir() { return MODELS_DIR; }

/* Is the engine usable at all? (binary present.) The whole Local feature is gated
   on this so a missing/partial vendor dir degrades gracefully to "unavailable". */
function engineAvailable() {
  try { return fs.existsSync(SERVER_EXE); } catch (e) { return false; }
}

/* ============================================================
   MODEL DISCOVERY
   ============================================================ */
// real extension is .gguf; we also accept the common .guff misspelling
const GGUF_RE = /\.(gguf|guff)$/i;

/* a friendly display name from a gguf filename: strip ext, quant suffix noise */
function prettyName(file) {
  let n = String(file).replace(GGUF_RE, '');
  n = n.replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim();
  return n || file;
}

/* Server-folder models. Public id: "local:server:<filename>". */
function listServerModels() {
  ensureDirs();
  let out = [];
  let names = [];
  try { names = fs.readdirSync(MODELS_DIR); } catch (e) { names = []; }
  for (const f of names) {
    if (!GGUF_RE.test(f)) continue;
    const full = path.join(MODELS_DIR, f);
    let size = 0; try { size = fs.statSync(full).size; } catch (e) { continue; }
    out.push({
      id: 'local:server:' + f,
      name: prettyName(f),
      file: f,
      provider: 'Local',
      source: 'server',
      size,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/* User vault models — pulled from a `store` that exposes ggufFiles().
   Public id: "local:user:<fileId>". */
function listUserModels(store) {
  if (!store || typeof store.ggufFiles !== 'function') return [];
  let rows = [];
  try { rows = store.ggufFiles() || []; } catch (e) { rows = []; }
  return rows.map(r => ({
    id: 'local:user:' + r.id,
    name: prettyName(r.name),
    file: r.name,
    provider: 'Local',
    source: 'user',
    size: r.size || 0,
    fileId: r.id,
  }));
}

/* Every local model visible to this request's account. */
function listModels(store) {
  if (!engineAvailable()) return [];
  return [...listServerModels(), ...listUserModels(store)];
}

function isLocalModel(id) { return typeof id === 'string' && id.startsWith('local:'); }

/* Parse a public id back to { source, key }. */
function parseId(id) {
  if (!isLocalModel(id)) return null;
  const rest = id.slice('local:'.length);
  const i = rest.indexOf(':');
  if (i < 0) return null;
  return { source: rest.slice(0, i), key: rest.slice(i + 1) };
}

/* ============================================================
   RESOLVING A MODEL ID -> A PLAINTEXT .gguf PATH ON DISK
   Server models are already plaintext. User models must be decrypted from the
   account vault to a cache file (once; reused while the model stays loaded).
   ============================================================ */
async function resolvePath(id, store) {
  const p = parseId(id);
  if (!p) throw new Error('not a local model id');

  if (p.source === 'server') {
    // basename-only guard: never let an id escape the models dir
    const file = path.basename(p.key);
    if (!GGUF_RE.test(file)) throw new Error('not a gguf model');
    const full = path.join(MODELS_DIR, file);
    if (!fs.existsSync(full)) throw new Error('model file not found');
    return { path: full, temp: false };
  }

  if (p.source === 'user') {
    if (!store) throw new Error('no vault for user model');
    const row = store.getById(p.key);
    if (!row) throw new Error('model not found in your files');
    const name = store.decName(row) || '';
    if (!GGUF_RE.test(name)) throw new Error('that file is not a .gguf model');
    const enc = store.blobPath(row);
    if (!fs.existsSync(enc)) throw new Error('model blob missing');
    // decrypt to a stable cache path keyed by account+file so a reload reuses it
    const cacheName = `u_${store.id}_${p.key}.gguf`;
    const dest = path.join(CACHE_DIR, cacheName);
    if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
      await decryptBlobToFile(enc, store.keys, dest);
    }
    return { path: dest, temp: true };
  }

  throw new Error('unknown local model source');
}

/* Stream-decrypt a whole encrypted blob to a plaintext file. Uses the same
   range-decrypt primitive the media server uses (whole-file range = null,null). */
function decryptBlobToFile(encPath, keys, destPath) {
  return new Promise((resolve, reject) => {
    let head;
    try { head = vault.readBlobHeader(encPath); } catch (e) { return reject(e); }
    if (!head) return reject(new Error('bad model blob header'));
    const r = vault.decryptBlobRange(encPath, keys, null, null, head);
    if (!r || !r.stream) return reject(new Error('cannot read model blob'));
    const tmp = destPath + '.part';
    const out = fs.createWriteStream(tmp);
    r.stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => {
      try { fs.renameSync(tmp, destPath); resolve(destPath); }
      catch (e) { reject(e); }
    });
    r.stream.pipe(out);
  });
}

/* ============================================================
   PORT ALLOCATION — find a free localhost port in our band
   ============================================================ */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}
async function pickPort() {
  for (let i = 0; i < PORT_SPAN; i++) {
    const port = PORT_BASE + ((Math.floor(Math.random() * PORT_SPAN) + i) % PORT_SPAN);
    if (await portFree(port)) return port;
  }
  throw new Error('no free local port for the model server');
}

/* ============================================================
   SPAWNING / LIFECYCLE
   ============================================================ */
/* Wait until llama-server answers /health with status "ok" (model loaded). */
async function waitHealthy(port, signal, deadline) {
  const url = `http://127.0.0.1:${port}/health`;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('cancelled');
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (!j.status || j.status === 'ok') return true;
      }
    } catch (e) { /* not up yet */ }
    await sleep(350);
  }
  throw new Error('model failed to load in time');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Make sure a model is loaded and its llama-server is healthy; returns the
   instance { port, ... }. Concurrent callers share one in-flight load. */
async function ensureRunning(id, store, { onStage } = {}) {
  if (!engineAvailable()) throw new Error('Local AI engine is not installed on this server');
  // Thermal safety net: refuse to (re)load while cooling down. Phrased for the user.
  if (thermal.isBlocked()) throw new Error(thermalMessage());
  const key = id;
  const have = loaded.get(key);
  if (have && have.proc && !have.proc.killed) { touch(have); return have; }
  if (loading.has(key)) return loading.get(key);

  const p = (async () => {
    if (onStage) onStage('resolving');
    const resolved = await resolvePath(id, store);
    if (onStage) onStage('starting');
    await evictIfNeeded();

    // First attempt: let llama-server use the model's OWN embedded chat template
    // (best fidelity). Some models ship a jinja template the engine can't parse and
    // it exits asking for --no-jinja --chat-template chatml; we detect that and
    // retry once with a safe generic template. We don't force chatml up front
    // because it would mangle models whose native template works (Llama-3, etc.).
    let inst;
    try {
      inst = await spawnServer(id, resolved, []);
    } catch (e) {
      if (isJinjaTemplateError(e)) {
        if (onStage) onStage('starting');
        inst = await spawnServer(id, resolved, ['--no-jinja', '--chat-template', 'chatml']);
        inst.templateFallback = true;
      } else {
        throw e;
      }
    }

    inst.ready = true;
    loaded.set(key, inst);
    scheduleIdle(inst);
    if (onStage) onStage('ready');
    return inst;
  })().finally(() => loading.delete(key));

  loading.set(key, p);
  return p;
}

/* True if llama-server died because it couldn't apply the model's jinja chat
   template (the "please consider disabling jinja" exit). */
function isJinjaTemplateError(e) {
  const m = String((e && e.message) || '');
  return /jinja|chat[ _-]?template/i.test(m);
}

/* Spawn one llama-server for `resolved` (a {path,temp}) with `extraArgs`, wait
   until it's healthy, and resolve the instance. Rejects (with the captured log
   tail) if the process exits before becoming healthy. */
async function spawnServer(id, resolved, extraArgs) {
  const port = await pickPort();
  const args = [
    '-m', resolved.path,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-c', String(CTX_SIZE),
    '--no-webui',          // we only use the API
    '-fa', 'auto',         // flash-attention when the model supports it
    ...extraArgs,
  ];
  const threads = Math.max(1, Math.min(os.cpus().length, 8));
  args.push('-t', String(threads));

  const proc = spawn(SERVER_EXE, args, {
    cwd: BIN_DIR,                 // so it finds its sibling DLLs
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const inst = {
    id, key: id, port, proc,
    path: resolved.path, temp: resolved.temp,
    name: (parseId(id) || {}).key,
    startedAt: Date.now(), lastUsed: Date.now(),
    ready: false, log: [], idleTimer: null,
  };
  const cap = (buf) => { const s = buf.toString('utf8'); inst.log.push(s); if (inst.log.length > 60) inst.log.shift(); };
  proc.stdout.on('data', cap);
  proc.stderr.on('data', cap);

  let exited = null;
  proc.once('exit', (code, sig) => { exited = { code, sig }; cleanupInstance(inst, false); });

  const ac = new AbortController();
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  try {
    // race the health check against an early process exit
    await Promise.race([
      waitHealthy(port, ac.signal, deadline),
      (async () => { while (!exited && Date.now() < deadline) await sleep(200); if (exited) throw new Error(spawnError(inst)); })(),
    ]);
  } catch (e) {
    ac.abort();
    killTree(proc, false);   // robust: a half-started server must not be orphaned
    throw new Error(e.message || 'model failed to start');
  }
  return inst;
}

function spawnError(inst) {
  const tail = (inst.log || []).join('').split('\n').filter(Boolean).slice(-4).join(' | ');
  return 'model server exited' + (tail ? ': ' + tail.slice(0, 300) : '');
}

function touch(inst) { inst.lastUsed = Date.now(); scheduleIdle(inst); }
function scheduleIdle(inst) {
  if (inst.idleTimer) clearTimeout(inst.idleTimer);
  inst.idleTimer = setTimeout(() => unload(inst.key, 'idle'), IDLE_MS);
  if (inst.idleTimer.unref) inst.idleTimer.unref();   // never keep the process alive just for this
}

/* LRU evict to honor MAX_LOADED before spawning a new one. */
async function evictIfNeeded() {
  while (loaded.size >= MAX_LOADED) {
    let oldestKey = null, oldest = Infinity;
    for (const [k, v] of loaded) if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k; }
    if (!oldestKey) break;
    unload(oldestKey, 'evict');
  }
}

function cleanupInstance(inst, killProc, sync) {
  if (!inst) return;
  if (inst.idleTimer) { clearTimeout(inst.idleTimer); inst.idleTimer = null; }
  if (killProc) killTree(inst.proc, sync);
  loaded.delete(inst.key);
  // leave decrypted user-model cache file in place: a quick re-load reuses it;
  // it's wiped on next boot anyway and lives outside the vault.
}

function unload(key, reason) {
  const inst = loaded.get(key);
  if (!inst) return false;
  cleanupInstance(inst, true, false);
  return true;
}

/* Tear down every model server. `sync` forces a synchronous tree-kill — required
   from the 'exit' handler (incl. the restart path's process.exit(87)) where an
   async taskkill would never run before the process is gone. */
function unloadAll(sync) { for (const k of [...loaded.keys()]) { const inst = loaded.get(k); cleanupInstance(inst, true, sync); } }
// best-effort cleanup so we don't orphan ~0.5 GB model servers when the parent
// dies — graceful shutdown, restart (exit 87), Ctrl-C, or a kill signal.
process.once('exit', () => unloadAll(true));
process.once('SIGINT', () => { unloadAll(true); process.exit(0); });
process.once('SIGTERM', () => { unloadAll(true); process.exit(0); });

/* ============================================================
   STREAMING CHAT — proxy to the model server's OpenAI-compatible endpoint
   ------------------------------------------------------------
   Calls onText(deltaString) for each token chunk. Resolves when the stream ends.
   `signal` (from the request) aborts the upstream fetch on client disconnect.
   Messages are [{role, content}]; `system` is prepended as a system message.
   ============================================================ */
async function chatStream({ id, store, messages, system, maxTokens, temperature, signal, onText, onStage }) {
  const inst = await ensureRunning(id, store, { onStage });
  touch(inst);

  const msgs = [];
  if (system && String(system).trim()) msgs.push({ role: 'system', content: String(system) });
  for (const m of (messages || [])) {
    if (!m || !m.role) continue;
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') });
  }

  const body = {
    messages: msgs,
    stream: true,
    cache_prompt: true,
    max_tokens: Number.isFinite(+maxTokens) ? +maxTokens : 1024,
    temperature: Number.isFinite(+temperature) ? +temperature : 0.7,
  };

  const r = await fetch(`http://127.0.0.1:${inst.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`local model ${r.status}: ${t.slice(0, 200)}`);
  }

  // parse the SSE delta stream (OpenAI shape) -> plain text deltas
  let buf = '';
  for await (const chunk of r.body) {
    if (signal && signal.aborted) break;
    buf += Buffer.from(chunk).toString('utf8');
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const line of lines) {
      const data = line.replace(/^data: ?/, '').trim();
      if (!data || data === '[DONE]') continue;
      try {
        const t = JSON.parse(data).choices?.[0]?.delta?.content || '';
        if (t) onText(t);
      } catch (e) { /* keep-alive / partial — ignore */ }
    }
  }
  touch(inst);
}

/* User-facing message while the thermal guard is cooling the box down. */
function thermalMessage() {
  const mins = Math.max(1, Math.ceil(thermal.cooldownRemainingMs() / 60000));
  return `Local AI is paused — the server got too warm and is cooling down. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`;
}

/* ============================================================
   STATUS — for the UI ("engine ready", which models are resident)
   ============================================================ */
function status(store) {
  return {
    available: engineAvailable(),
    modelsDir: MODELS_DIR,
    idleMs: IDLE_MS,
    maxLoaded: MAX_LOADED,
    ctx: CTX_SIZE,
    thermal: thermal.state(),       // { supported, tempC, tripped, cooldownRemainingMs, ... }
    models: listModels(store),
    loaded: [...loaded.values()].map(i => ({
      id: i.id, ready: i.ready, port: i.port,
      startedAt: i.startedAt, lastUsed: i.lastUsed,
      templateFallback: !!i.templateFallback,
    })),
  };
}

/* True if a given model id is currently resident + healthy. */
function isLoaded(id) { const i = loaded.get(id); return !!(i && i.ready && i.proc && !i.proc.killed); }

module.exports = {
  init, setModelsDir, getModelsDir,
  engineAvailable,
  listModels, listServerModels, listUserModels,
  isLocalModel, parseId,
  ensureRunning, chatStream,
  unload, unloadAll, isLoaded,
  status,
  // thermal safety net (admin reset + state + threshold config pass-through)
  thermalState: () => thermal.state(),
  thermalReset: () => thermal.reset(),
  thermalConfigure: (opts) => thermal.configure(opts),
};

/* ============================================================
   DATA LAYER — backend-backed persistence (Express + SQLite)
   Queries read in-memory DB.files; mutations update optimistically
   then sync to the server via /api/*.
   ============================================================ */
/* ============================================================
   LAZY MODULE LOADER
   ------------------------------------------------------------
   Injects a same-origin <script> on demand and resolves once it has run. Used to
   keep heavy, rarely-needed code (the Neural app, the .sav/.uasset parsers, the
   3D/heightmap viewers, and — as they're extracted — the individual apps) OUT of
   the boot path so the login screen and file vault paint fast. Same-origin scripts
   satisfy our strict CSP under 'self' with no nonce needed (only INLINE scripts
   need the per-request nonce), so a runtime-injected `/foo.js` just works.

   Contract: `loadScript('/neural.js')` returns a Promise that resolves after the
   file has loaded+executed (and its globals are defined), or rejects on network
   error. Each URL is fetched at most once; concurrent callers share one Promise.
   Groups (loadModule) express "these files, in order" for paired deps. */
const _scriptPromises = new Map();   // url -> Promise (dedupe; also a "loaded" set)
function loadScript(url) {
  if (_scriptPromises.has(url)) return _scriptPromises.get(url);
  const p = new Promise((resolve, reject) => {
    // if it's somehow already on the page (e.g. shipped in index.html), don't refetch
    if (document.querySelector(`script[data-lazy="${url}"], script[src="${url}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = url;
    s.async = false;            // preserve execution order for multi-file loadModule groups
    s.dataset.lazy = url;
    s.onload = () => resolve();
    s.onerror = () => { _scriptPromises.delete(url); s.remove(); reject(new Error('Failed to load ' + url)); };
    document.head.appendChild(s);
  });
  _scriptPromises.set(url, p);
  return p;
}
/* Load an ordered list of scripts (later ones may depend on earlier globals, e.g.
   neural.js reads window.NeuralEngine at parse time → engine must run first). */
function loadModule(urls) {
  return urls.reduce((chain, url) => chain.then(() => loadScript(url)), Promise.resolve());
}
/* Named bundles so call sites don't hardcode file lists. */
const LAZY_MODULES = {
  neural: ['/neural-engine.js', '/neural.js'],   // engine defines window.NeuralEngine, app reads it
  gvas: ['/gvas.js'],                            // window.GVAS — the .sav save editor
  uasset: ['/uasset.js'],                        // window.UASSET — the asset inspector
  viewers: ['/viewers.js'],                      // openImage/openModel3D/openHeightmap/openEditor
  'tools-clients': ['/tools-clients.js'],        // CLIENT_TOOLS registry + build*/ct* browser tools
  'video-editor': ['/video-editor.js'],          // Mini Video Editor (mveEditorHTML/wireMiniVideoEditor)
  'material-editor': ['/material-editor.js'],     // Material Manager (matEditorHTML/wireMaterialEditor)
  guide: ['/guide.js'],                          // in-app wiki (docsHTML/wireDocs + DOCS dataset)
  'apps-misc': ['/apps-misc.js'],                // Analytics + Bug Reports
  'apps-visual': ['/apps-visual.js'],            // Simplex Visual — the 2D visual game engine
  'visual-runtime': ['/visual-runtime.js'],      // Simplex Visual — the shared blueprint runtime (also loaded by play.html)
  'apps-editors': ['/apps-editors.js'],          // Notes + Code apps
  'apps-discord': ['/apps-discord.js'],          // Discord Bot admin panel
  'apps-trading': ['/apps-trading.js'],          // Trading app UI screen
  'apps-music': ['/apps-music.js'],              // Music library/playlist screen + Jam (Player/EQ stay core)
};
function loadFeature(name) {
  const urls = LAZY_MODULES[name];
  if (!urls) return Promise.reject(new Error('unknown module ' + name));
  return loadModule(urls);
}

const STORE_KEY = 'simplex.vault.v1';
/* Per-account storage limit. Default 200 GB; overwritten by setQuota() from
   /api/login and /api/me so the meter reflects the logged-in account. */
let TOTAL_BYTES = 200 * 1e9;
function setQuota(limit, used) { if (Number.isFinite(limit) && limit > 0) TOTAL_BYTES = limit; }

/* How the browser reached the server, reported by /api/me + /api/uploads/init.
   'cloudflare' = via the safe domain (TLS, but a ~100MB/request cap → big files
   must be chunked); 'direct' = a LAN IP / no proxy (no cap). Drives the upload
   strategy. Defaults to 'cloudflare' (the safe assumption: chunk large files)
   until the server tells us otherwise. */
let CONN = 'cloudflare';
function setConn(kind) { if (kind === 'direct' || kind === 'cloudflare') CONN = kind; }

/* Server clocks for the Database home stats, supplied by /api/login + /api/me:
   SERVER_STARTED_AT = current process start (drives "Last Restart");
   VAULT_BORN_AT     = the day the vault was first created (drives lifetime "Uptime"). */
let SERVER_STARTED_AT = null;
let VAULT_BORN_AT = null;
function setServerTimes(startedAt, vaultBornAt) {
  if (Number.isFinite(startedAt)) SERVER_STARTED_AT = startedAt;
  if (Number.isFinite(vaultBornAt)) VAULT_BORN_AT = vaultBornAt;
  // Seed the restart gate's baseline so it can later tell a fresh process apart
  // from the current one. RestartGate is defined in app.js (loaded after this).
  if (Number.isFinite(startedAt) && typeof RestartGate !== 'undefined') RestartGate.rememberStartedAt(startedAt);
}

const day = 864e5;

function uid() { return 'f' + Math.random().toString(36).slice(2, 9); }

/* ---- share mode ----
   When the page is served at /s/<token>, the app runs as a read-only public
   viewer scoped to one shared subtree instead of the full vault. */
const _shareMatch = location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);
const SHARE = { active: !!_shareMatch, token: _shareMatch ? _shareMatch[1] : null, root: null, allowDownload: true, invalid: false };

/* ---- persistence ---- */
let DB = null;
async function loadDB() {
  if (SHARE.active) {
    const res = await fetch('/api/shares/' + SHARE.token);
    if (!res.ok) { SHARE.invalid = true; DB = { files: [] }; return; }
    const data = await res.json();
    SHARE.root = data.root;
    SHARE.allowDownload = !!data.allowDownload;
    DB = { files: data.items };   // server already scoped + rewrote blob urls through the token
    return;
  }
  const res = await fetch('/api/files');
  if (res.status === 401) { const e = new Error('unauthorized'); e.code = 'AUTH'; throw e; }
  DB = { files: await res.json() };
  await loadTags();   // keep the tag dictionary in sync with the file list
}
function saveDB() {}   // no-op: server is source of truth
function resetDB() {}  // no-op: managed server-side

/* ---- shares (owner side; the session cookie rides along automatically) ---- */
async function createShare(fileId, allowDownload = true) {
  const res = await fetch('/api/shares', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId, allowDownload }),
  });
  if (!res.ok) { const e = new Error('share failed (' + res.status + ')'); e.status = res.status; throw e; }
  return res.json();
}
async function listShares() {
  const res = await fetch('/api/shares');
  if (!res.ok) { const e = new Error('list failed (' + res.status + ')'); e.status = res.status; throw e; }
  return res.json();
}
async function deleteShare(token) {
  await fetch('/api/shares/' + token, { method: 'DELETE' }).catch(() => {});
}
/* set (or clear, with '') a share's custom slug. Returns the updated share shape;
   throws with .status 400 (bad slug) / 409 (taken) so the UI can explain. */
async function setShareSlug(token, slug) {
  const res = await fetch('/api/shares/' + token + '/slug', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'could not set name'); e.status = res.status; throw e; }
  return data;
}

/* ---- accounts (admin) + self-service ---- */
async function apiJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  if (res.status === 401) { const e = new Error('unauthorized'); e.code = 'AUTH'; throw e; }
  let body = null; try { body = await res.json(); } catch (e) {}
  if (!res.ok) {
    const e = new Error((body && body.error) || ('request failed (' + res.status + ')'));
    e.status = res.status;
    if (body && body.code) e.code = body.code;           // LEGACY / MIGRATING / SHARE_ASLEEP …
    if (body && body.progress) e.progress = body.progress;
    throw e;
  }
  return body;
}

/* ---- per-user encryption keys ---- */
function keysStatus() { return apiJSON('/api/keys/status'); }
function keysUnlock(payload) { return apiJSON('/api/keys/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
function keysSwap(password, totp) { return apiJSON('/api/keys/swap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, totp }) }); }
function keysRecovery(password, totp) { return apiJSON('/api/keys/recovery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, totp }) }); }
function keysReveal(password, totp) { return apiJSON('/api/keys/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, totp }) }); }
function reencryptFile(id) { return apiJSON('/api/files/' + id + '/reencrypt', { method: 'POST' }); }
function reencryptVault() { return apiJSON('/api/keys/reencrypt-vault', { method: 'POST' }); }
function getMe() { return apiJSON('/api/me'); }
/* ---- restart system ---- */
// Public liveness + restart state. Used both to detect an in-progress restart
// (raise the gate) and to detect when a FRESH server is up (startedAt changed).
async function getRestartStatus() {
  const res = await fetch('/api/restart-status', { cache: 'no-store' });
  if (!res.ok) throw new Error('restart-status ' + res.status);
  return res.json();
}
// admin: trigger a manual restart
function requestRestart() { return apiJSON('/api/restart', { method: 'POST' }); }
// admin: read / write the weekly scheduled-restart config
function getRestartSchedule() { return apiJSON('/api/restart-schedule'); }
function setRestartSchedule(schedule) { return apiJSON('/api/restart-schedule', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(schedule) }); }
function listAccounts() { return apiJSON('/api/accounts'); }
function createAccount(data) { return apiJSON('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function updateAccount(id, data) { return apiJSON('/api/accounts/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function deleteAccount(id) { return apiJSON('/api/accounts/' + id, { method: 'DELETE' }); }
function updateMe(data) { return apiJSON('/api/accounts/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }

/* ---- account safety: 2FA sign-in, email, safety level, captcha, resets ---- */
function myEmail(email, totp) { return apiJSON('/api/me/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, totp }) }); }
function mySafety(level, totp) { return apiJSON('/api/me/safety', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level, totp }) }); }
function twofaBegin() { return apiJSON('/api/me/2fa/begin', { method: 'POST' }); }
function twofaVerify(code) { return apiJSON('/api/me/2fa/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }); }
function twofaEnable(code, captcha) { return apiJSON('/api/me/2fa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, captcha }) }); }
function twofaDisable(code) { return apiJSON('/api/me/2fa/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }); }
function captchaNew() { return apiJSON('/api/captcha'); }
function captchaCheck(id, answer) { return apiJSON('/api/captcha/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, answer }) }); }
function resetRequest(username) { return apiJSON('/api/reset/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) }); }
function resetComplete(username, code, password) { return apiJSON('/api/reset/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, code, password }) }); }
function adminResetCode(id) { return apiJSON('/api/security/resets/' + encodeURIComponent(id) + '/code', { method: 'POST' }); }
function adminResetDismiss(id) { return apiJSON('/api/security/resets/' + encodeURIComponent(id), { method: 'DELETE' }); }

/* ---- login security tiers + IP bans (admin) ---- */
function getSecurity() { return apiJSON('/api/security'); }
function setSecurityDefault(tier) { return apiJSON('/api/security', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultTier: tier }) }); }
function unbanIp(ip) { return apiJSON('/api/security/bans/' + encodeURIComponent(ip), { method: 'DELETE' }); }

/* ---- self-serve signup (public submit + admin approval queue) ---- */
// Public: no session required. Returns { ok:true } (or throws with a neutral message).
function submitSignup(data) { return apiJSON('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function listSignups() { return apiJSON('/api/signups'); }
function approveSignup(id, quotaGb) { return apiJSON('/api/signups/' + id + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(quotaGb != null ? { quota_gb: quotaGb } : {}) }); }
function rejectSignup(id) { return apiJSON('/api/signups/' + id + '/reject', { method: 'POST' }); }

/* ---- Custom API keys (self-serve) ---- */
function listApiKeys() { return apiJSON('/api/apikeys'); }
function createApiKey(data) { return apiJSON('/api/apikeys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function updateApiKey(id, data) { return apiJSON('/api/apikeys/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function deleteApiKey(id) { return apiJSON('/api/apikeys/' + id, { method: 'DELETE' }); }

/* ---- notes app ---- */
function listNotes() { return apiJSON('/api/notes'); }
function getNote(id) { return apiJSON('/api/notes/' + id); }
function createNote(data) { return apiJSON('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function updateNote(id, data) { return apiJSON('/api/notes/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function deleteNote(id) { return apiJSON('/api/notes/' + id, { method: 'DELETE' }); }

/* ---- Analytics app (private per-account usage stats) ----
   trackEvent() is fire-and-forget and BATCHED: events queue and flush on a short
   timer (or immediately when the tab is hidden / unloaded), so a burst of activity
   is one request, and a closing tab still reports its last events via sendBeacon.
   This data is the user's own — surfaced only in the Analytics app, used by nobody
   else. Only a fixed set of event types is accepted server-side. */
const ANALYTICS_EVENT_TYPES = ['session', 'app_open', 'upload', 'ai_message', 'tool_use', 'file_view', 'download', 'share', 'note_edit', 'convert'];
let _analyticsQueue = [];
let _analyticsTimer = null;
function trackEvent(type, meta) {
  if (SHARE.active) return;                                  // public share viewer: never tracks
  if (!ANALYTICS_EVENT_TYPES.includes(type)) return;
  _analyticsQueue.push({ type, meta: meta || undefined });
  if (_analyticsQueue.length >= 25) return flushAnalytics();
  if (!_analyticsTimer) _analyticsTimer = setTimeout(flushAnalytics, 4000);
}
function flushAnalytics(useBeacon) {
  if (_analyticsTimer) { clearTimeout(_analyticsTimer); _analyticsTimer = null; }
  if (!_analyticsQueue.length) return;
  const events = _analyticsQueue.splice(0, _analyticsQueue.length);
  const body = JSON.stringify({ events });
  // On unload, sendBeacon survives the teardown where fetch() would be cancelled.
  if (useBeacon && navigator.sendBeacon) {
    try { navigator.sendBeacon('/api/analytics/event', new Blob([body], { type: 'application/json' })); return; } catch (e) {}
  }
  fetch('/api/analytics/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}
// Flush whatever's queued when the tab is hidden or about to unload.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAnalytics(true); });
  window.addEventListener('pagehide', () => flushAnalytics(true));
}
function getAnalyticsSummary() { return apiJSON('/api/analytics/summary'); }
function clearAnalytics() { return apiJSON('/api/analytics', { method: 'DELETE' }); }

/* ---- Trading app (global always-training model + per-account paper/live trader) ---- */
function tradingModelStatus() { return apiJSON('/api/trading/model'); }
function tradingState() { return apiJSON('/api/trading/state'); }
function tradingSignals() { return apiJSON('/api/trading/signals'); }
function tradingDeposit(amount) { return apiJSON('/api/trading/sandbox/deposit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }) }); }
function tradingReset() { return apiJSON('/api/trading/sandbox/reset', { method: 'POST' }); }
function tradingSimulate() { return apiJSON('/api/trading/sandbox/simulate', { method: 'POST' }); }
function tradingSetAutoTrade(on) { return apiJSON('/api/trading/autotrade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) }); }
function tradingSetMode(mode) { return apiJSON('/api/trading/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) }); }
function tradingSaveKeys(apiKey, apiSecret, paper) { return apiJSON('/api/trading/live/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey, apiSecret, paper }) }); }
function tradingClearKeys() { return apiJSON('/api/trading/live/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true }) }); }
function tradingEnableLive(on) { return apiJSON('/api/trading/live/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) }); }
function tradingKill() { return apiJSON('/api/trading/kill', { method: 'POST' }); }
function tradingClearLog() { return apiJSON('/api/trading/log', { method: 'DELETE' }); }
function tradingAdminConfig() { return apiJSON('/api/trading/admin/config'); }
function tradingAdminSaveConfig(cfg) { return apiJSON('/api/trading/admin/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }); }
function tradingAdminKick() { return apiJSON('/api/trading/admin/kick', { method: 'POST' }); }
function tradingAdminResetModel() { return apiJSON('/api/trading/admin/reset-model', { method: 'POST' }); }
function tradingAdminApproveModel(approved) { return apiJSON('/api/trading/admin/approve-model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved }) }); }

/* ---- Music app (global shared library + playlists + live "jam" sessions) ----
   The library + playlists live in the system DB; songs are copied (not proxied) into
   the Music store when added, so playback is independent of the uploader's vault. */
const _json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function musicLibrary() { return apiJSON('/api/music/tracks'); }
function musicAddTrack(fileId) { return apiJSON('/api/music/tracks', _json({ fileId })); }
function musicRemoveTrack(id) { return apiJSON('/api/music/tracks/' + id, { method: 'DELETE' }); }
/* copy a shared track into the caller's own vault (parent = destination folder id or null) */
async function musicSaveTrack(id, parent) {
  const data = await apiJSON('/api/music/tracks/' + id + '/save', _json({ parent: parent ?? null }));
  if (data.file && typeof DB !== 'undefined' && DB && DB.files) DB.files.push(data.file);
  return data;
}
function musicPlaylists() { return apiJSON('/api/music/playlists'); }
function musicPlaylist(id) { return apiJSON('/api/music/playlists/' + id); }
function musicCreatePlaylist(name, isPublic) { return apiJSON('/api/music/playlists', _json({ name, public: isPublic !== false })); }
function musicUpdatePlaylist(id, data) { return apiJSON('/api/music/playlists/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function musicDeletePlaylist(id) { return apiJSON('/api/music/playlists/' + id, { method: 'DELETE' }); }
function musicAddToPlaylist(id, trackId) { return apiJSON('/api/music/playlists/' + id + '/items', _json({ trackId })); }
function musicRemoveFromPlaylist(id, trackId) { return apiJSON('/api/music/playlists/' + id + '/items/' + trackId, { method: 'DELETE' }); }
function musicReorderPlaylist(id, trackIds) { return apiJSON('/api/music/playlists/' + id + '/order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackIds }) }); }
function musicSetEditors(id, editorIds) { return apiJSON('/api/music/playlists/' + id + '/editors', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ editorIds }) }); }
function musicMembers() { return apiJSON('/api/music/members'); }
function musicSpotlight() { return apiJSON('/api/music/spotlight'); }
function musicReportTrack(trackId, reason, detail) { return apiJSON('/api/music/reports', _json({ trackId, reason, detail })); }
function musicReports() { return apiJSON('/api/music/reports'); }
function musicReportsCount() { return apiJSON('/api/music/reports/count'); }
function musicResolveReport(id) { return apiJSON('/api/music/reports/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'resolved' }) }); }
function musicDismissReport(id) { return apiJSON('/api/music/reports/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'dismissed' }) }); }
function musicJams() { return apiJSON('/api/music/jams'); }
function jamCreate(queue, name) { return apiJSON('/api/music/jam', _json({ queue, name })); }
function jamJoin(id) { return apiJSON('/api/music/jam/' + id + '/join', { method: 'POST' }); }
function jamLeave(id) { return apiJSON('/api/music/jam/' + id + '/leave', { method: 'POST' }); }
function jamState(id) { return apiJSON('/api/music/jam/' + id + '/state'); }
/* control returns the new jam state on success; on a 409 (someone else moved first)
   it returns the SERVER's fresh state tagged { conflict:true } so the caller can
   re-resolve rather than clobber. 404 (jam ended) and 403 surface as { error }. */
async function jamControl(id, version, patch) {
  const res = await fetch('/api/music/jam/' + id + '/control', _json({ version, patch }));
  if (res.status === 401) { const e = new Error('unauthorized'); e.code = 'AUTH'; throw e; }
  let body = null; try { body = await res.json(); } catch (e) {}
  if (res.status === 409) return { ...(body || {}), conflict: true };
  if (!res.ok) return { error: (body && body.error) || ('request failed (' + res.status + ')'), status: res.status };
  return body;
}

/* ---- Bug Reports app ----
   Members file reports (bugSubmit); admins read + triage the inbox (bugList/Update/Delete).
   The OPEN post endpoint (/api/bugs/open) is for unauthenticated automated assistants
   and is NOT wrapped here — it's documented in SECURITY_CHECK_RULES.md + README.md. */
function bugSubmit(data) { return apiJSON('/api/bugs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function bugList() { return apiJSON('/api/bugs'); }
function bugUpdate(id, data) { return apiJSON('/api/bugs/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function bugDelete(id) { return apiJSON('/api/bugs/' + id, { method: 'DELETE' }); }

/* ---- code app (workspace files + run/stop) ---- */
function codeFiles() { return apiJSON('/api/code/files'); }
function codeCreate(data) { return apiJSON('/api/code/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function codeUpdate(id, data) { return apiJSON('/api/code/files/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function codeDelete(id) { return apiJSON('/api/code/files/' + id, { method: 'DELETE' }); }
function codeStop(runId) { return fetch('/api/code/stop/' + runId, { method: 'POST' }).catch(() => {}); }
function codeStopAll() { try { return fetch('/api/code/stopall', { method: 'POST', keepalive: true }); } catch (e) {} }

/* ---- Neural Network app (saved networks + optional backend compute) ---- */
function listNetworks() { return apiJSON('/api/networks'); }
function getNetwork(id) { return apiJSON('/api/networks/' + id); }
function createNetwork(data) { return apiJSON('/api/networks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function updateNetwork(id, data) { return apiJSON('/api/networks/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function deleteNetwork(id) { return apiJSON('/api/networks/' + id, { method: 'DELETE' }); }

/* ---- Simplex Visual app (saved projects — the ".simplexvisual" documents) ---- */
function listVisProjects() { return apiJSON('/api/visual/projects'); }
function getVisProject(id) { return apiJSON('/api/visual/projects/' + id); }
function createVisProject(data) { return apiJSON('/api/visual/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function updateVisProject(id, data) { return apiJSON('/api/visual/projects/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function deleteVisProject(id) { return apiJSON('/api/visual/projects/' + id, { method: 'DELETE' }); }
function neuralCaps() { return apiJSON('/api/neural/caps'); }
function neuralCompute(payload) { return apiJSON('/api/neural/compute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }

/* ---- AI Organization (per-user organizer model: folder/tag suggestions) ---- */
function organizerStatus() { return apiJSON('/api/organizer/status'); }
function organizerSettings(patch) { return apiJSON('/api/organizer/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch || {}) }); }
function organizerSetEnabled(enabled) { return organizerSettings({ enabled }); }
function organizerSetThreshold(threshold) { return organizerSettings({ threshold }); }
function organizerSetTier(tier) { return organizerSettings({ tier }); }
function organizerTrain() { return apiJSON('/api/organizer/train', { method: 'POST' }); }
function organizerReset() { return apiJSON('/api/organizer/model', { method: 'DELETE' }); }
function organizerSuggestions(fileId, fresh) { return apiJSON('/api/organizer/suggestions/' + fileId + (fresh ? '?fresh=1' : '')); }
function organizerFeedback(fileId, body) { return apiJSON('/api/organizer/suggestions/' + fileId + '/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }

/* ---- AI app ---- */
function aiModels() { return apiJSON('/api/ai/models'); }
/* Local AI engine (bundled GGUF inference) */
function aiLocalStatus() { return apiJSON('/api/ai/local/status'); }
function aiLocalUnload(id) { return apiJSON('/api/ai/local/unload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(id ? { id } : {}) }); }
function aiLocalThermalReset() { return apiJSON('/api/ai/local/thermal/reset', { method: 'POST' }); }
function aiConfigGet() { return apiJSON('/api/ai/config'); }
function aiConfigSet(data) { return apiJSON('/api/ai/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function aiChats() { return apiJSON('/api/ai/chats'); }
function aiChatGet(id) { return apiJSON('/api/ai/chats/' + id); }
function aiChatCreate(data) { return apiJSON('/api/ai/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function aiChatUpdate(id, data) { return apiJSON('/api/ai/chats/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function aiChatDelete(id) { return apiJSON('/api/ai/chats/' + id, { method: 'DELETE' }); }
/* personalization (name, role, style, custom instructions) + persistent memory */
function aiPersonaGet() { return apiJSON('/api/ai/persona'); }
function aiPersonaSet(data) { return apiJSON('/api/ai/persona', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function aiMemoryAdd(text) { return apiJSON('/api/ai/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); }
function aiMemoryUpdate(id, data) { return apiJSON('/api/ai/memory/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function aiMemoryDelete(id) { return apiJSON('/api/ai/memory/' + id, { method: 'DELETE' }); }
function aiMemoryClear() { return apiJSON('/api/ai/memory/clear', { method: 'POST' }); }
/* AI tools */
function aiWebSearch(query) { return apiJSON('/api/ai/tools/web_search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) }); }

/* ---- connectors + notifications ---- */
function connectorCatalog() { return apiJSON('/api/connectors/catalog'); }
function listConnectors() { return apiJSON('/api/connectors'); }
function installConnector(data) { return apiJSON('/api/connectors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function updateConnector(id, data) { return apiJSON('/api/connectors/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function deleteConnector(id) { return apiJSON('/api/connectors/' + id, { method: 'DELETE' }); }
function listNotifications() { return apiJSON('/api/notifications'); }
function ackNotification(id) { return apiJSON('/api/notifications/' + id + '/ack', { method: 'POST' }); }
function readNotification(id) { return apiJSON('/api/notifications/' + id + '/read', { method: 'POST' }); }
function readAllNotifications() { return apiJSON('/api/notifications/read-all', { method: 'POST' }); }
function deleteNotification(id) { return apiJSON('/api/notifications/' + id, { method: 'DELETE' }); }
/* create a content-backed text document in the vault (editor/download read `content`) */
async function createDoc({ name, content, parent, lang }) {
  const rec = await apiJSON('/api/files/doc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content, parent: parent ?? null, lang }) });
  DB.files.push(rec);
  return rec;
}
/* stream a chat completion; onText(delta) per token, onError(msg) on in-band error.
   Resolves when the stream ends. Pass an AbortSignal to support Stop. */
/* ---- tools app ---- */
function toolsInfo() { return apiJSON('/api/tools'); }
function toolProgress() { return apiJSON('/api/tools/progress'); }
/* ---- embedded file metadata (EXIF / ID3 / container tags) ---- */
/* read the metadata baked into a vault file's bytes (ffprobe on the server). */
function fileMetadata(id) { return apiJSON('/api/files/' + id + '/metadata'); }
/* (re)extract embedded artist/album/cover from an audio file into its DB fields.
   Used to backfill tracks uploaded before auto-extraction existed. Updates cache. */
async function extractTags(id) {
  const data = await apiJSON('/api/files/' + id + '/extract-tags', { method: 'POST' });
  if (data.file && typeof DB !== 'undefined' && DB && DB.files) {
    const i = DB.files.findIndex(f => f.id === data.file.id);
    if (i >= 0) DB.files[i] = data.file; else DB.files.push(data.file);
  }
  return data;
}
/* overwrite a file's bytes in place (used by the .sav Save Editor). Updates cache. */
async function replaceFileBytes(id, bytes, name) {
  const fd = new FormData();
  fd.append('file', new File([bytes], name || 'file.bin', { type: 'application/octet-stream' }));
  const res = await fetch('/api/files/' + id + '/replace', { method: 'POST', body: fd });
  if (!res.ok) { let msg = 'save failed'; try { msg = (await res.json()).error || msg; } catch (e) {} const err = new Error(msg); err.status = res.status; throw err; }
  const rec = await res.json();
  if (typeof DB !== 'undefined' && DB && DB.files) { const i = DB.files.findIndex(f => f.id === id); if (i >= 0) DB.files[i] = rec; }
  return rec;
}
/* strip non-essential embedded metadata in place; updates the cached record. */
async function purgeMetadata(id) {
  const data = await apiJSON('/api/files/' + id + '/purge-metadata', { method: 'POST' });
  if (data.file && typeof DB !== 'undefined' && DB && DB.files) {
    const i = DB.files.findIndex(f => f.id === data.file.id);
    if (i >= 0) DB.files[i] = data.file; else DB.files.push(data.file);
  }
  return data;
}
/* Convert/compress a file already in the vault (no upload — dodges Cloudflare's
   request cap). output: 'download' returns a Blob; 'save'/'replace' returns the
   resulting vault file record (and updates the local DB cache). */
async function convertTool({ tool, fileId, format, preset, mode, value, output = 'download', signal }) {
  const res = await fetch('/api/tools/convert', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ tool, fileId, format, preset, mode, value, output }),
  });
  if (!res.ok) { let msg = 'conversion failed'; try { msg = (await res.json()).error || msg; } catch (e) {} const err = new Error(msg); err.status = res.status; throw err; }
  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    const data = await res.json();
    if (data.file && typeof DB !== 'undefined' && DB && DB.files) {
      const i = DB.files.findIndex(f => f.id === data.file.id);
      if (i >= 0) DB.files[i] = data.file; else DB.files.push(data.file);
    }
    return { kind: 'saved', ...data };
  }
  const outSize = Number(res.headers.get('X-Output-Size')) || null;
  return { kind: 'download', blob: await res.blob(), outSize };
}

/* ---- Mini Video Editor ---- */
/* Render a project to a video in the vault (server ffmpeg). output 'save' adds a
   new file; 'replace' (with replaceId) overwrites a previous export. Returns the
   resulting vault file record and updates the local DB cache (like convertTool). */
async function mveExport({ project, output = 'save', replaceId, signal }) {
  const res = await fetch('/api/tools/mve/export', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ project, output, replaceId }),
  });
  if (!res.ok) { let msg = 'export failed'; try { msg = (await res.json()).error || msg; } catch (e) {} const err = new Error(msg); err.status = res.status; throw err; }
  const data = await res.json();
  if (data.file && typeof DB !== 'undefined' && DB && DB.files) {
    const i = DB.files.findIndex(f => f.id === data.file.id);
    if (i >= 0) DB.files[i] = data.file; else DB.files.push(data.file);
  }
  return data;
}
/* awaitable save of a content-backed document's text; updates the cache + returns
   the fresh record. Used by the editor to persist a project .mve.json. */
async function saveDocContent(id, content) {
  const rec = await apiJSON('/api/files/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, size: (content || '').length, date: Date.now() }) });
  if (typeof DB !== 'undefined' && DB && DB.files) { const i = DB.files.findIndex(f => f.id === id); if (i >= 0) DB.files[i] = rec; }
  return rec;
}

async function streamAIChat({ model, messages, system, signal, onText, onError, onStage }) {
  const res = await fetch('/api/ai/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, system }), signal,
  });
  if (!res.ok) { let msg = 'request failed'; try { msg = (await res.json()).error || msg; } catch (e) {} throw new Error(msg); }
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const line of lines) {
      const d = line.replace(/^data: ?/, '').trim(); if (!d) continue;
      let obj; try { obj = JSON.parse(d); } catch (e) { continue; }
      if (obj.type === 'text' && obj.text) onText(obj.text);
      else if (obj.type === 'stage') { if (onStage) onStage(obj.stage); }   // local engine: 'resolving' | 'starting' | 'ready'
      else if (obj.type === 'error') onError(obj.error);
    }
  }
}

/* ---- album covers ---- */
async function setCover(id, file) {
  const fd = new FormData(); fd.append('cover', file);
  const rec = await apiJSON('/api/files/' + id + '/cover', { method: 'POST', body: fd });
  const f = byId(id); if (f && rec) { f.coverUrl = rec.coverUrl; f.coverVer = (f.coverVer || 0) + 1; }
  return rec;
}
async function clearCover(id) {
  const rec = await apiJSON('/api/files/' + id + '/cover', { method: 'DELETE' });
  const f = byId(id); if (f) { delete f.coverUrl; f.coverVer = (f.coverVer || 0) + 1; }
  return rec;
}

/* ---- extract a .zip into a new folder; pushes all created rows into DB.files ---- */
async function extractZip(id, parent) {
  const body = (parent === undefined) ? {} : { parent: parent ?? null };
  const res = await fetch('/api/files/' + id + '/extract', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    const e = new Error(d.error || ('extract failed (' + res.status + ')'));
    if (res.status === 413) e.code = 'LIMIT';
    throw e;
  }
  const data = await res.json();
  (data.created || []).forEach(rec => DB.files.push(rec));
  return data;
}

/* ---- tags ----
   The tag dictionary (id -> {name,color}) lives in TAGS, refreshed alongside the
   file list. Files carry an array of tag ids in f.tags. */
let TAGS = [];
async function loadTags() {
  if (SHARE.active) { TAGS = []; return TAGS; }
  try { TAGS = await apiJSON('/api/tags'); } catch (e) { TAGS = []; }
  return TAGS;
}
function allTags() { return TAGS; }
function tagById(id) { return TAGS.find(t => t.id === id) || null; }
/* resolved tag objects for a file, in dictionary order, skipping dangling ids */
function tagsOf(f) {
  if (!f || !Array.isArray(f.tags) || !f.tags.length) return [];
  const set = new Set(f.tags);
  return TAGS.filter(t => set.has(t.id));
}
/* every non-trashed item carrying tag `id` */
function itemsWithTag(id) { return DB.files.filter(f => !f.trashed && Array.isArray(f.tags) && f.tags.includes(id)); }
function countWithTag(id) { return itemsWithTag(id).length; }

function createTag(data) { return apiJSON('/api/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function updateTag(id, data) { return apiJSON('/api/tags/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function deleteTag(id) { return apiJSON('/api/tags/' + id, { method: 'DELETE' }); }
/* replace the tag id-array on a file/folder; updates the local DB cache optimistically */
async function setFileTags(id, ids) {
  const f = byId(id); if (f) f.tags = [...ids];
  try {
    const rec = await apiJSON('/api/files/' + id + '/tags', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: ids }) });
    const i = DB.files.findIndex(x => x.id === id); if (i >= 0) DB.files[i] = rec;
    return rec;
  } catch (e) { return null; }
}

/* ---- queries ---- */
const TYPES = ['folder', 'video', 'audio', 'image', 'document', 'model3d', 'uasset'];
function byId(id) { return DB.files.find(f => f.id === id); }
function children(pid) { return DB.files.filter(f => f.parent === pid && !f.trashed); }
function allOfType(t) { return DB.files.filter(f => f.type === t && !f.trashed); }
function trashed() { return DB.files.filter(f => f.trashed); }
function starred() { return DB.files.filter(f => f.starred && !f.trashed); }
function descendants(id) {
  const out = [];
  const walk = (p) => DB.files.filter(f => f.parent === p).forEach(c => { out.push(c); if (c.type === 'folder') walk(c.id); });
  walk(id); return out;
}
function pathOf(id) {
  const chain = []; let cur = byId(id);
  while (cur) { chain.unshift(cur); cur = cur.parent ? byId(cur.parent) : null; }
  return chain;
}

/* ---- mutations ---- */
/* addFile is used only for folders (uploads go through uploadFile). Awaits the
   server so the real id is in DB.files before the UI navigates into it. */
async function addFile(o) {
  const body = { name: o.name, parent: o.parent ?? null };
  try {
    const srv = await (await fetch('/api/folders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })).json();
    DB.files.push(srv);
    return srv;
  } catch (e) {
    // offline fallback: keep an optimistic local record
    const temp = { id: uid(), parent: null, size: 0, date: Date.now(), trashed: false, starred: false, ...o };
    DB.files.push(temp);
    return temp;
  }
}
function renameFile(id, name) {
  const f = byId(id); if (!f) return;
  f.name = name;
  fetch('/api/files/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => {});
}
function trashFile(id) {
  const f = byId(id); if (!f) return;
  f.trashed = true; if (f.type === 'folder') descendants(id).forEach(d => d.trashed = true);
  fetch('/api/files/' + id + '/trash', { method: 'POST' }).catch(() => {});
}
function restoreFile(id) {
  const f = byId(id); if (!f) return;
  f.trashed = false; if (f.type === 'folder') descendants(id).forEach(d => d.trashed = false);
  fetch('/api/files/' + id + '/restore', { method: 'POST' }).catch(() => {});
}
function deleteForever(id) {
  const kill = new Set([id, ...descendants(id).map(d => d.id)]);
  DB.files = DB.files.filter(f => !kill.has(f.id));
  fetch('/api/files/' + id, { method: 'DELETE' }).catch(() => {});
}
function emptyTrash() {
  DB.files = DB.files.filter(f => !f.trashed);
  fetch('/api/trash/empty', { method: 'POST' }).catch(() => {});
}
function toggleStar(id) {
  const f = byId(id); if (!f) return;
  f.starred = !f.starred;
  fetch('/api/files/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ starred: f.starred }) }).catch(() => {});
}
function saveDoc(id, content) {
  const f = byId(id); if (!f) return;
  f.content = content; f.size = content.length; f.date = Date.now();
  fetch('/api/files/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, size: f.size, date: f.date }) })
    .then(async res => {
      // Legacy (old-key) blob-backed doc: the server refuses the edit until the
      // file is re-encrypted — surface the re-encrypt dialog instead of silently
      // dropping the save (the text is still in the editor; save again after).
      if (res.status === 409) {
        let body = null; try { body = await res.json(); } catch (e) {}
        if (body && body.code === 'LEGACY' && typeof legacyModal === 'function') legacyModal(f, 'edit');
      }
    })
    .catch(() => {});
}
/* Read the text of a document. Two storage flavors exist:
   - content-backed (typed in-app / AI artifacts): text is in the `content` column.
     The file LIST no longer ships the body (kept light), so f.content is usually
     absent and f.hasContent is set — we fetch it from /api/files/:id/content.
     (It IS inline right after a save, or in share mode, where content is included.)
   - blob-backed (uploaded files): text lives in an encrypted blob at /raw and
     f.content is empty — we must fetch it.
   `limit` caps the bytes fetched (Range request) so a huge file doesn't have to
   be pulled in full just to open; pass null/0 for the whole file. Returns
   { text, truncated } — truncated is true when we stopped at the limit. */
async function fetchDocText(f, { limit = 0, signal } = {}) {
  if (f && f.locked && typeof decryptItemTextForOpen === 'function') {
    return decryptItemTextForOpen(f, { limit, signal });
  }
  if (f && f.content != null) return { text: f.content, truncated: false };
  const url = mediaUrl(f);
  if (!url) {
    // content-backed doc: the list no longer ships the body (kept light); fetch it.
    // hasContent is set by the server for rows that have a `content` column value.
    if (f && f.hasContent && f.id) {
      const r = await fetch('/api/files/' + f.id + '/content', { signal });
      if (!r.ok) throw new Error('could not read file (' + r.status + ')');
      const { content } = await r.json();
      return { text: content || '', truncated: false };
    }
    return { text: '', truncated: false };
  }
  const headers = {};
  if (limit && f.size && f.size > limit) headers.Range = `bytes=0-${limit - 1}`;
  const res = await fetch(url, { headers, signal });
  if (!res.ok && res.status !== 206) throw new Error('could not read file (' + res.status + ')');
  const text = await res.text();
  // truncated if we asked for a range AND the server honored it (or the body is short of full size)
  const truncated = !!(limit && f.size && f.size > limit);
  return { text, truncated };
}
function newFolder(parent, name) { return addFile({ name, type: 'folder', parent }); } // returns a Promise<record>

/* set star to an explicit value (bulk-friendly; toggleStar flips one) */
function setStar(id, val) {
  const f = byId(id); if (!f || !!f.starred === !!val) return;
  f.starred = !!val;
  fetch('/api/files/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ starred: f.starred }) }).catch(() => {});
}

/* true if `ancestorId` is `id` itself or one of its ancestors — i.e. dropping
   into `ancestorId` would put a folder inside its own subtree (a cycle). */
function isDescendantOf(id, ancestorId) {
  let cur = byId(id);
  while (cur) {
    if (cur.id === ancestorId) return true;
    cur = cur.parent ? byId(cur.parent) : null;
  }
  return false;
}

/* move ids into `parent` (null = root). Filters cycles + no-ops client-side,
   updates DB.files optimistically, then syncs. Returns the ids actually moved. */
function moveFiles(ids, parent) {
  const dest = parent ?? null;
  const valid = ids.filter(id => {
    const f = byId(id); if (!f) return false;
    if (f.type === 'folder' && dest !== null && isDescendantOf(dest, id)) return false;
    return (f.parent ?? null) !== dest;
  });
  valid.forEach(id => { byId(id).parent = dest; });
  if (valid.length) {
    fetch('/api/files/move', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: valid, parent: dest }),
    }).catch(() => {});
  }
  return valid;
}

/* copy/duplicate ids into `parent` (null = root). Omit `parent` entirely to keep
   each copy in its source folder (Duplicate). Server deep-copies folders and
   duplicates blobs; new rows are pushed into DB.files. Returns the new records.
   Throws an error with .code === 'LIMIT' if the vault is full. */
async function copyItems(ids, parent) {
  const sameFolder = (parent === undefined);   // Duplicate-in-place vs. paste into a folder
  const body = sameFolder ? {} : { parent: parent ?? null };
  const created = [];
  for (const id of ids) {
    const res = await fetch('/api/files/' + id + '/copy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 413) { const e = new Error('storage limit'); e.code = 'LIMIT'; throw e; }
      continue;
    }
    const data = await res.json();
    (data.created || []).forEach(rec => { DB.files.push(rec); created.push(rec); });
  }
  return created;
}

/* XHR-based sender with STREAMING upload progress. fetch() can't report how many
   bytes of a request body have gone out, so a single big POST/PUT would show no
   movement until it finished — the "jumps 0→20→50 in bursts" the users saw (each
   jump was a whole chunk landing at once). XHR's upload.onprogress fires as bytes
   leave the browser, giving a smooth rise. Resolves { status, responseText } for
   any completed response (caller checks status); rejects on network error, abort,
   or timeout. onProgress(loadedBytes) is called as the body uploads. */
function xhrSend(method, url, body, { headers, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    if (headers) for (const k of Object.keys(headers)) xhr.setRequestHeader(k, headers[k]);
    const onAbort = () => { try { xhr.abort(); } catch (e) {} };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const done = (fn, arg) => { if (signal) signal.removeEventListener('abort', onAbort); fn(arg); };
    if (xhr.upload && onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => done(resolve, { status: xhr.status, responseText: xhr.responseText });
    xhr.onerror = () => done(reject, new Error('network error'));
    xhr.ontimeout = () => done(reject, new Error('timed out'));
    xhr.onabort = () => done(reject, new DOMException('aborted', 'AbortError'));
    xhr.send(body);
  });
}

/* upload a real file: blob to disk + metadata in SQLite, returns server record.
   Single POST — used for small files (≤ the CF cap) on any connection. */
async function uploadFile(file, parent, extra = {}, signal, onProgress) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('parent', parent == null ? 'null' : parent);
  fd.append('type', extra.type || 'document');
  if (extra.lang != null) fd.append('lang', extra.lang);
  if (extra.dur != null) fd.append('dur', String(extra.dur));
  if (extra.w != null) fd.append('w', String(extra.w));
  if (extra.h != null) fd.append('h', String(extra.h));
  const size = file.size || 1;
  const log = newUploadLog(file);
  log.type = extra.type || 'document';
  log.add('single-start', { size: file.size });
  let res;
  try { res = await xhrSend('POST', '/api/files', fd, {
    signal, onProgress: onProgress ? (loaded => onProgress(Math.min(1, loaded / size))) : null,
  }); } catch (e) {
    log.add('single-throw', { msg: String(e && e.message || e) });
    if (e.name !== 'AbortError') { e.code = e.code || 'NETWORK'; e.uploadLog = log; }
    throw e;
  }
  if (res.status < 200 || res.status >= 300) {
    const err = new Error('upload failed (' + res.status + ')');
    err.code = res.status === 413 ? 'LIMIT' : 'UNKNOWN';
    log.add('single-fail', { status: res.status });
    err.uploadLog = log;
    throw err;
  }
  const rec = JSON.parse(res.responseText);
  DB.files.push(rec);
  return rec;
}

/* ---- chunked upload ----
   Used when a file is bigger than the connection allows in one request. Chunks
   are sent in PARALLEL (a worker pool) and written by byte offset on the server,
   which reassembles them in any order. The server dictates the chunk size per
   connection via /api/uploads/init: ~90MB over Cloudflare (under its ~100MB
   request cap) and much larger on a DIRECT connection (no cap → fewer requests
   for multi-GB files). With several chunks in flight a fast uplink stays saturated
   instead of sending one piece at a time. */
const CHUNK_SIZE = 16 * 1024 * 1024;          // fallback if the server omits chunkSize
const CF_REQUEST_CAP = 100 * 1024 * 1024;     // Cloudflare's ~100MB/request limit — the chunk threshold
const MAX_PARALLEL = 10;                       // concurrent chunk requests

/* ---- upload event buffer ----
   A bounded log of what actually happened during an upload. When one fails, the
   "Uh oh!" dialog posts this to /api/uploads/report, where the server staples on
   its own trace — so a user on a phone reports a bug by tapping one button
   instead of trying to find a console. */
const UPLOAD_EVENTS_MAX = 200;
function newUploadLog(file) {
  return {
    events: [], uploadId: null, conn: null, chunkSize: 0, startedAt: Date.now(),
    name: file && file.name || '', size: file && file.size || 0, type: '',
    add(event, data) {
      this.events.push({ t: Date.now() - this.startedAt, event, ...(data || {}) });
      if (this.events.length > UPLOAD_EVENTS_MAX) this.events.splice(0, this.events.length - UPLOAD_EVENTS_MAX);
    },
  };
}
/* Turn a failure into something a human can act on. Falls back to the raw message
   so an unrecognized failure still reports rather than showing a shrug. */
const UPLOAD_CAUSES = {
  SESSION_GONE: 'The server lost track of this upload before it finished saving. It usually means the upload sat idle too long, or the connection stalled partway through.',
  INCOMPLETE: 'Some pieces of the file never arrived, so the server had nothing complete to save.',
  ENCRYPT_FAILED: 'The file uploaded, but the server could not encrypt it into your vault.',
  LIMIT: "This file would put you over your storage limit, so it wasn't saved.",
  NETWORK: 'The connection dropped during the upload.',
};
function uploadCauseText(code, message) {
  return UPLOAD_CAUSES[code] || message || 'The upload stopped before the file was saved.';
}
async function sendUploadReport(log, code, message, note) {
  try {
    const r = await fetch('/api/uploads/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId: log.uploadId, code, message: message || '', note: note || '',
        name: log.name, size: log.size, type: log.type,
        conn: log.conn, chunkSize: log.chunkSize, events: log.events,
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.reportId || null;
  } catch (e) { return null; }
}

async function uploadFileChunked(file, parent, extra = {}, onProgress, signal) {
  const log = newUploadLog(file);
  log.type = extra.type || 'document';
  const initRes = await fetch('/api/uploads/init', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({
      name: file.name, size: file.size, type: extra.type || 'document',
      parent: parent == null ? null : parent, lang: extra.lang, dur: extra.dur, w: extra.w, h: extra.h,
    }),
  });
  if (!initRes.ok) {
    const err = new Error('upload init failed (' + initRes.status + ')');
    if (initRes.status === 413) err.code = 'LIMIT';
    log.add('init-fail', { status: initRes.status });
    err.uploadLog = log;
    throw err;
  }
  const init = await initRes.json();
  if (init.conn) setConn(init.conn);           // authoritative per-request connection type
  const id = init.uploadId;
  const chunkSize = init.chunkSize || CHUNK_SIZE;
  const parallel = Math.max(1, init.maxParallel || MAX_PARALLEL);
  log.uploadId = id; log.conn = init.conn || null; log.chunkSize = chunkSize;
  log.add('init', { conn: init.conn, chunkSize, parallel, size: file.size });

  // build the list of [offset, end) chunks
  const chunks = [];
  for (let off = 0; off < file.size; off += chunkSize) chunks.push([off, Math.min(off + chunkSize, file.size)]);

  // Aggregate progress across parallel chunks: completed bytes + each in-flight
  // chunk's live `loaded`. Emitting the sum on every upload.onprogress gives one
  // smooth bar instead of a step per finished chunk.
  const total = file.size || 1;
  let doneBytes = 0, next = 0, failed = null;
  const inflight = new Map();   // chunk index -> bytes uploaded so far
  const emit = () => {
    if (!onProgress) return;
    let live = 0; for (const v of inflight.values()) live += v;
    onProgress(Math.min(1, (doneBytes + live) / total));
  };
  const worker = async () => {
    while (next < chunks.length && !failed) {
      const idx = next++;
      const [start, end] = chunks[idx];
      inflight.set(idx, 0);
      const at = Date.now();
      try {
        await putChunkWithRetry(id, file.slice(start, end), start, 3, signal, (loaded) => { inflight.set(idx, loaded); emit(); }, log);
        doneBytes += end - start;
        log.add('chunk-ok', { idx, start, bytes: end - start, ms: Date.now() - at });
      } catch (e) {
        failed = failed || e;
        log.add('chunk-fail', { idx, start, ms: Date.now() - at, msg: String(e && e.message || e) });
      }
      finally { inflight.delete(idx); emit(); }
    }
  };
  // run up to `parallel` workers pulling from the shared chunk queue
  await Promise.all(Array.from({ length: Math.min(parallel, chunks.length) }, worker));
  if (failed) {
    fetch(`/api/uploads/${id}`, { method: 'DELETE' }).catch(() => {});   // abort + free the temp file (cancel or error)
    if (failed.name !== 'AbortError') { failed.code = failed.code || 'NETWORK'; failed.uploadLog = log; }
    throw failed;
  }

  let compRes;
  try { compRes = await fetch(`/api/uploads/${id}/complete`, { method: 'POST', signal }); }
  catch (e) {
    fetch(`/api/uploads/${id}`, { method: 'DELETE' }).catch(() => {});
    log.add('complete-throw', { msg: String(e && e.message || e) });
    if (e.name !== 'AbortError') { e.code = e.code || 'NETWORK'; e.uploadLog = log; }
    throw e;   // cancelled during finalize
  }
  if (!compRes.ok) {
    fetch(`/api/uploads/${id}`, { method: 'DELETE' }).catch(() => {});
    // the server names the cause (SESSION_GONE / INCOMPLETE / ENCRYPT_FAILED) — carry it
    let body = null; try { body = await compRes.json(); } catch (_) {}
    const err = new Error('upload complete failed (' + compRes.status + ')');
    err.code = (body && body.code) || (compRes.status === 413 ? 'LIMIT' : 'UNKNOWN');
    log.add('complete-fail', { status: compRes.status, code: err.code, received: body && body.received, size: body && body.size });
    err.uploadLog = log;
    throw err;
  }
  const rec = await compRes.json();
  log.add('complete-ok', {});
  DB.files.push(rec);
  return rec;
}

async function putChunkWithRetry(id, blob, offset, tries, signal, onChunkProgress, log) {
  for (let i = 0; i < tries; i++) {
    if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      const r = await xhrSend('PUT', `/api/uploads/${id}?offset=${offset}`, blob, {
        headers: { 'Content-Type': 'application/octet-stream' }, signal, onProgress: onChunkProgress,
      });
      if (r.status >= 200 && r.status < 300) return;
      throw new Error('chunk ' + r.status);   // 404 session gone / 413 over quota / other — retried below unless last try
    } catch (e) {
      if (e.name === 'AbortError') throw e;     // cancelled — don't retry
      if (log) log.add('chunk-retry', { offset, try: i + 1, msg: String(e && e.message || e) });
      if (i === tries - 1) throw e;
      await new Promise(res => setTimeout(res, 500 * (i + 1)));   // backoff
    }
  }
}

/* Pick the upload strategy from size + connection.
   - Files at or under Cloudflare's ~100MB request cap always go as ONE request
     (fast, simple) regardless of connection.
   - Bigger files are chunked. The server's init sizes the chunks for us: ~90MB
     over Cloudflare (stays under its cap) or a large chunk on a DIRECT connection
     (which has no cap), so a direct upload is a handful of big requests. */
async function uploadAny(file, parent, extra, onProgress, signal) {
  if (file.size > CF_REQUEST_CAP) return uploadFileChunked(file, parent, extra, onProgress, signal);
  onProgress && onProgress(0);
  const rec = await uploadFile(file, parent, extra, signal, onProgress);
  onProgress && onProgress(1);
  return rec;
}

/* ---- helpers ---- */
function usedBytes() { return DB.files.filter(f => !f.trashed && f.type !== 'folder').reduce((s, f) => s + (f.size || 0), 0); }
function bytesByType() {
  const m = { video: 0, audio: 0, image: 0, document: 0, model3d: 0 };
  DB.files.filter(f => !f.trashed && m[f.type] != null).forEach(f => m[f.type] += f.size || 0);
  return m;
}
function fmtSize(b) {
  if (!b) return '—';
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
  return b + ' B';
}
function fmtDur(s) {
  if (s == null) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
function fmtDate(ms) {
  const d = new Date(ms), diff = (Date.now() - ms) / day;
  if (diff < 1) return 'today';
  if (diff < 2) return 'yesterday';
  if (diff < 7) return Math.floor(diff) + ' days ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
/* compact elapsed-time for the home stats ("Last Restart" / "Uptime"):
   picks the two most-significant units, e.g. 3m, 5h 12m, 12d 4h, 1y 23d. */
function fmtElapsed(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const yr = Math.floor(s / 31557600);
  const dys = Math.floor((s % 31557600) / 86400);
  const hrs = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (yr) return dys ? `${yr}y ${dys}d` : `${yr}y`;
  if (dys) return hrs ? `${dys}d ${hrs}h` : `${dys}d`;
  if (hrs) return mins ? `${hrs}h ${mins}m` : `${hrs}h`;
  if (mins) return `${mins}m`;
  return `${s}s`;
}
function fileExt(name) { const m = name.match(/\.([a-z0-9]+)$/i); return m ? m[1].toUpperCase() : ''; }
/* a usable, persistent media URL — ignores dead blob: URLs from stale records */
function mediaUrl(f) { const u = f && f.url; return (u && !u.startsWith('blob:')) ? u : null; }

/* ---- Discord Bot app (admin-only) ---- */
function discordGetConfig() { return apiJSON('/api/discord/config'); }
function discordSetConfig(data) { return apiJSON('/api/discord/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
function discordStatus() { return apiJSON('/api/discord/status'); }
function discordLogFetch(since) { return apiJSON('/api/discord/log' + (since ? '?since=' + since : '')); }
function discordStart() { return apiJSON('/api/discord/start', { method: 'POST' }); }
function discordStop() { return apiJSON('/api/discord/stop', { method: 'POST' }); }
function discordRestart() { return apiJSON('/api/discord/restart', { method: 'POST' }); }
function discordHangup() { return apiJSON('/api/discord/hangup', { method: 'POST' }); }

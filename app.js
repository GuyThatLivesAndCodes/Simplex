/* ============================================================
   SIMPLEX — core controller: lock, shell, browse, upload
   ============================================================ */

/* ---------- LOGIN ----------
   Passwords never persist client-side. We POST {username,password} to
   /api/login; the server sets a session cookie and we boot into that account's
   vault. Signing out = reloading the page (the cookie is session-scoped). */
let ACCOUNT = null;          // { id, username, display, is_admin, quota_bytes, ... }
let checking = false;

/* ============================================================
   PER-ITEM ENCRYPTION  (single AES-256-GCM passphrase)
   ------------------------------------------------------------
   A file/folder can be "locked" with one passphrase. The bytes are encrypted in
   the browser (PBKDF2 -> AES-256-GCM) before upload, so the passphrase never
   reaches the server; only the ciphertext + a public lockSpec (salt/iv/params,
   NO secret) are stored. Two ways to open a locked item:
     - UNLOCK (temporary): enter the passphrase; it's cached in sessionStorage so
       the item stays open across reloads, and is cleared on sign-out / tab close.
     - DECRYPT (permanent): enter the passphrase; the item is re-uploaded as a
       normal unencrypted file and the lock is removed for good.
   ============================================================ */
const _encTextEncoder = new TextEncoder();
const _encTextDecoder = new TextDecoder();
const PBKDF2_ITERATIONS = 210000;

/* Passphrase cache for temporarily-unlocked items. sessionStorage survives a
   page reload but is wiped when the tab closes or the user signs out (reload). */
const LOCK_CACHE_KEY = 'simplex.unlocked.v2';
function _loadLockCache() {
  try { return JSON.parse(sessionStorage.getItem(LOCK_CACHE_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}
function _cacheLockPass(specId, pass) {
  if (!specId) return;
  try { const c = _loadLockCache(); c[specId] = pass; sessionStorage.setItem(LOCK_CACHE_KEY, JSON.stringify(c)); }
  catch (e) { /* storage full / disabled — unlock just won't persist this session */ }
}
function _cachedLockPass(specId) {
  if (!specId) return null;
  const c = _loadLockCache();
  return Object.prototype.hasOwnProperty.call(c, specId) ? c[specId] : null;
}
function _forgetLockPass(specId) {
  if (!specId) return;
  try { const c = _loadLockCache(); delete c[specId]; sessionStorage.setItem(LOCK_CACHE_KEY, JSON.stringify(c)); } catch (e) {}
}

function _u8ToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function _b64ToU8(text) {
  const bin = atob(String(text || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function _parseLockSpec(f) {
  if (!f || !f.lockSpec) return null;
  if (typeof f.lockSpec === 'object') return f.lockSpec;
  try { return JSON.parse(f.lockSpec); } catch (e) { return null; }
}
function _lockSpecId(spec) { return spec && spec.id || null; }
/* An item is "locked" (shows the lock UI) only if the server says it's locked
   AND we don't already have its passphrase cached for this session. */
function _looksLocked(f) {
  const spec = _parseLockSpec(f);
  return !!(f && f.locked && spec && !_cachedLockPass(_lockSpecId(spec)));
}
function _mimeForName(name, kind) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  const map = {
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
    mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    gltf: 'model/gltf+json', glb: 'model/gltf-binary', obj: 'text/plain', fbx: 'application/octet-stream', stl: 'model/stl',
  };
  return map[ext] || (kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : kind === 'image' ? 'image/png' : 'application/octet-stream');
}

/* derive a 256-bit AES-GCM key from a passphrase + salt via PBKDF2-SHA256 */
async function _deriveKey(pass, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', _encTextEncoder.encode(String(pass || '')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iterations || PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
/* encrypt bytes with a fresh salt+iv; returns { cipher, spec } where spec is the
   public, secret-free descriptor stored alongside the ciphertext on the server. */
async function _encryptBytes(bytes, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await _deriveKey(pass, salt, PBKDF2_ITERATIONS);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const spec = {
    id: 'lk' + Math.random().toString(36).slice(2, 10),
    v: 2, alg: 'aes-256-gcm',
    salt: _u8ToB64(salt), iv: _u8ToB64(iv), it: PBKDF2_ITERATIONS,
  };
  return { cipher, spec };
}
/* decrypt ciphertext using the spec's salt/iv. Throws on a wrong passphrase
   (AES-GCM auth tag fails), which callers turn into "incorrect passphrase". */
async function _decryptBytes(cipher, pass, spec) {
  const salt = _b64ToU8(spec.salt), iv = _b64ToU8(spec.iv);
  const key = await _deriveKey(pass, salt, spec.it || PBKDF2_ITERATIONS);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher));
}

/* read an item's raw stored bytes (the ciphertext for a locked item). A
   blob-backed item exposes a `url` (set by the server's rowToApi); only a
   blob-less inline document carries its bytes in `content`. (hasBlob is not sent
   to the client, so we use url/content presence to tell them apart.) */
async function _readItemBytes(item) {
  if (!item) return new Uint8Array();
  const hasBlob = !!(item.url || item.hasBlob);
  if (!hasBlob && item.content != null) return _encTextEncoder.encode(String(item.content));
  const url = mediaUrl(item) || (`/api/files/${item.id}/raw`);
  const res = await fetch(url, { noTimeout: true });
  if (!res.ok) throw new Error('could not read encrypted item (' + res.status + ')');
  return new Uint8Array(await res.arrayBuffer());
}
/* yield one macrotask so the browser can paint a frame between heavy synchronous
   steps — keeps the tab responsive while a large locked item is decrypted/copied. */
function _yieldToEventLoop() { return new Promise(r => setTimeout(r, 0)); }

/* fetch + decrypt a locked item to its original plaintext bytes, using a known
   passphrase (from the unlock cache or a fresh prompt).
   NOTE: a locked item has NO range streaming — the WHOLE encrypted file is fetched
   and decrypted in one shot (single-shot AES-GCM can't be range-streamed like the
   unlocked CTR /raw path). We yield around the heavy steps so the marshalling of a
   large file (arrayBuffer -> Uint8Array -> decrypt -> Blob copy) doesn't stall the
   main thread in one unbroken block. */
async function _decryptItemBytes(item, pass) {
  const spec = _parseLockSpec(item);
  const raw = await _readItemBytes(item);
  if (!spec) return raw;
  await _yieldToEventLoop();              // let the UI breathe before the decrypt
  return _decryptBytes(raw, pass, spec);
}
async function _decryptItemBlobUrl(item) {
  const spec = _parseLockSpec(item);
  const pass = _cachedLockPass(_lockSpecId(spec));
  const bytes = await _decryptItemBytes(item, pass);
  await _yieldToEventLoop();              // let the UI breathe before the (large) Blob copy
  return URL.createObjectURL(new Blob([bytes], { type: _mimeForName(item.name, item.type) }));
}

/* modal asking for a passphrase. mode: 'encrypt' (with confirm field),
   'unlock', or 'decrypt'. Resolves to the passphrase string, or null if cancelled. */
function _promptPassphrase(mode = 'unlock') {
  const titles = { encrypt: 'Encrypt item', unlock: 'Unlock item', decrypt: 'Decrypt item' };
  const intros = {
    encrypt: 'Set a passphrase. The file is encrypted in your browser before upload — the passphrase never leaves this device, and there is no way to recover it if you forget it.',
    unlock: 'Enter the passphrase to open this item. It stays unlocked on this browser until you sign out.',
    decrypt: 'Enter the passphrase to permanently remove encryption. The item becomes a normal, unencrypted file.',
  };
  const okLabels = { encrypt: 'Encrypt', unlock: 'Unlock', decrypt: 'Decrypt' };
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal lock-modal"><h3>${titles[mode]}</h3>
      <p>${intros[mode]}</p>
      <div class="lock-fields">
        <input type="password" class="lock-pass" placeholder="Passphrase" autocomplete="off" />
        ${mode === 'encrypt' ? '<input type="password" class="lock-pass2" placeholder="Confirm passphrase" autocomplete="off" />' : ''}
        <div class="lock-err" hidden></div>
      </div>
      <div class="acts">
        <button class="btn ghost" data-cancel>Cancel</button>
        <button class="btn primary" data-ok>${okLabels[mode]}</button>
      </div></div>`;
    document.body.appendChild(bg);
    const pass = bg.querySelector('.lock-pass');
    const pass2 = bg.querySelector('.lock-pass2');
    const err = bg.querySelector('.lock-err');
    const showErr = (msg) => { err.textContent = msg; err.hidden = false; };
    const close = (val) => { bg.remove(); resolve(val); };
    bg.querySelector('[data-cancel]').onclick = () => close(null);
    bg.onclick = e => { if (e.target === bg) close(null); };
    const submit = () => {
      const v = pass.value;
      if (!v) { showErr('Enter a passphrase'); return; }
      if (mode === 'encrypt' && v !== pass2.value) { showErr('Passphrases do not match'); return; }
      close(v);
    };
    bg.querySelector('[data-ok]').onclick = submit;
    pass.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    if (pass2) pass2.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    setTimeout(() => pass.focus(), 30);
  });
}

async function doLogin(ev) {
  if (ev) ev.preventDefault();
  if (checking) return;
  const hint = document.getElementById('lockHint');
  const userEl = document.getElementById('loginUser');
  const passEl = document.getElementById('loginPass');
  const btn = document.getElementById('loginBtn');
  const username = userEl.value.trim();
  const password = passEl.value;
  hint.classList.remove('err'); hint.textContent = '';
  if (!username || !password) { hint.classList.add('err'); hint.textContent = 'enter your username and password'; return; }
  checking = true; btn.disabled = true; btn.textContent = 'Signing in...';
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      const data = await res.json();
      // two-auth: the password checked out but this device/IP isn't trusted —
      // the server holds a short-lived ticket (tk) until a code arrives.
      // The password rides along IN MEMORY ONLY — the key-unlock flow may need
      // it to rewrap the user key (it is never stored or logged).
      if (data.need2fa) { passEl.value = ''; twofaLoginPrompt(data.tk, password); return; }
      passEl.value = '';
      postLogin(data, password);
      return;
    }
    if (res.status === 403) {
      // IP is banned (a security tier kicked in). Reload so the server's ban
      // middleware replaces the page with the full-screen ban + countdown screen.
      const d = await res.json().catch(() => ({}));
      if (d && d.banned) { location.reload(); return; }
      hint.classList.add('err'); hint.textContent = 'access blocked — try again later';
    } else if (res.status === 429) {
      const d = await res.json().catch(() => ({}));
      hint.classList.add('err'); hint.textContent = `too many attempts - wait ${d.retryAfter || 30}s`;
    } else {
      hint.classList.add('err'); hint.textContent = 'incorrect username or password';
      const card = document.querySelector('.login-card');
      card.classList.add('shake'); setTimeout(() => card.classList.remove('shake'), 450);
    }
  } catch (e) {
      hint.classList.add('err'); hint.textContent = 'connection error - try again';
  } finally {
    checking = false; btn.disabled = false; btn.textContent = 'Sign in';
  }
}
function unlock() {
  const lock = document.getElementById('lock');
  lock.classList.add('dismiss');
  setTimeout(() => {
    lock.classList.add('hidden');
    bootDashboard();   // land on the dashboard launcher, not directly in the vault
  }, 520);
}
/* the session expired/was revoked, or the account was deleted — return to login.
   We reset to a clean signed-out state; the user just signs in again. */
function relock(msg) {
  closeViewer();
  if (typeof unmountRemoteAssistant === 'function') unmountRemoteAssistant();
  if (typeof closePlayer === 'function') closePlayer();
  stopPolling();
  ACCOUNT = null;
  currentApp = 'dashboard';
  ['shell', 'launcher', 'appscreen'].forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
  document.getElementById('shell').classList.remove('show');
  const lock = document.getElementById('lock');
  lock.classList.remove('hidden', 'dismiss');
  checking = false;
  const btn = document.getElementById('loginBtn'); if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
  const passEl = document.getElementById('loginPass'); if (passEl) passEl.value = '';
  const hint = document.getElementById('lockHint');
  if (hint) { hint.classList.remove('err'); hint.textContent = msg || 'signed out — sign in to continue'; }
}
async function signOut() {
  // WAIT for the server to actually clear the session cookie before leaving — a
  // fire-and-forget logout used to race the reload, so the page came back up with
  // the cookie still set and silently signed the user right back in. Awaiting the
  // logout guarantees the Set-Cookie (Max-Age=0) lands first.
  try { await fetch('/api/logout', { method: 'POST' }); } catch (e) {}
  // Hard-navigate to the bare app URL with the session gone. We use assign (not
  // reload) so any /whats-new or deep path also returns to a clean login screen.
  try { location.replace(location.origin + location.pathname.replace(/\/(whats-new|s\/.*)?$/, '/')); }
  catch (e) { location.reload(); }
}
/* ---------- post-login gate: restart gate → key walls → weak-password wall ---------- */
function postLogin(data, password) {
  ACCOUNT = data.account;
  if (data.used != null) setQuota(data.account.quota_bytes, data.used);
  if (data.conn) setConn(data.conn);
  setServerTimes(data.startedAt, data.vaultBornAt);
  // signed in mid-restart: don't drop into a backend that's about to bounce —
  // raise the gate and let the watcher reload us when it's back.
  if (data.restarting) { RestartGate.onRestartingPayload(data); return; }
  const k = data.keys || {};
  const next = () => {
    // weak password (short / common / the shipped "1234" default): the server
    // flagged it at sign-in. Block the app behind a forced change.
    if (data.pwWeak) forcePwChange(); else unlock();
  };
  // first sign-in since the per-user-key update: the enrollment is silent —
  // the recovery key stays sealed on the server (Settings → Safety reveals it
  // on request). Just a light note, nothing to manage.
  if (k.justEnrolled) setTimeout(() => toast('Your vault now has its own encryption key — only your password opens it', 'key'), 1200);
  // the key wrap rides an older password (unswapped change or a reset) — the
  // password verified but couldn't unwrap. Unlock before entering the vault.
  if (k.locked) { keyUnlockModal(password, next); return; }
  if (k.stale) setTimeout(() => toast('Your encryption key still rides your previous password — swap it in Settings → Safety', 'key'), 1200);
  next();
}

/* ---------- per-user keys: reveal modal + unlock wall ----------
   The recovery key is server-sealed and shown ONLY here, on explicit request.
   The modal offers regeneration in place (old key stops working). */
function keyRecoveryModal(code, mode, then) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  const intro = mode === 'regen'
    ? `<p>Here is your <b>new recovery key</b> — the old one no longer works. It's the only way into your files if you ever forget your password. Anyone holding it can unlock your vault, so treat it like a password:</p>`
    : `<p>This is your account's <b>recovery key</b>. Simplex keeps it sealed inside your vault — you don't need it day to day. It matters in exactly one case: if you <b>forget your password</b>, this key is the only way back into your files. Anyone holding it can unlock your vault, so treat it like a password:</p>`;
  bg.innerHTML = `<div class="modal twofa-modal">
    <div class="forcepw-badge">${svg('key', 18)}</div>
    <h3>${mode === 'regen' ? 'New recovery key' : 'Your recovery key'}</h3>
    ${intro}
    <div class="key-rc mono">${esc(code)}</div>
    <div class="acts">
      <button class="btn ghost sm" id="krcCopy">${svg('copy', 14)} Copy</button>
      ${mode !== 'regen' ? `<button class="btn ghost sm" id="krcRegen">${svg('refresh', 14)} New key…</button>` : ''}
      <span class="spacer"></span>
      <button class="btn primary" id="krcDone">Done</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  bg.querySelector('#krcCopy').onclick = () => { copyText(code); toast('Recovery key copied', 'check'); };
  const regen = bg.querySelector('#krcRegen');
  if (regen) regen.onclick = () => {
    bg.remove();
    keyPasswordPrompt('New recovery key', 'This generates a NEW recovery key and invalidates the current one. Enter your password to continue.',
      async (password, totp) => { const r = await keysRecovery(password, totp); keyRecoveryModal(r.code, 'regen', null); });
  };
  bg.querySelector('#krcDone').onclick = () => { bg.remove(); if (then) then(); };
}

function keyUnlockModal(password, then) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal twofa-modal">
    <div class="forcepw-badge">${svg('lock', 18)}</div>
    <h3>Unlock your vault keys</h3>
    <p>Your password changed, but your encryption key still rides the old one. Prove it's you with your <b>previous password</b> — or your <b>recovery code</b> — and the key moves to your current password.</p>
    <div class="form-fields">
      <label class="form-field"><span class="eyebrow">Previous password</span><input type="password" id="kuOld" autocomplete="off"></label>
      <label class="form-field"><span class="eyebrow">…or recovery key</span><input id="kuRc" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="your recovery key (Settings → Safety → View key)"></label>
    </div>
    <div class="form-err" id="kuErr"></div>
    <div class="acts"><button class="btn ghost" id="kuOut">Sign out</button><button class="btn primary" id="kuGo">Unlock</button></div>
  </div>`;
  document.body.appendChild(bg);
  const err = bg.querySelector('#kuErr');
  bg.querySelector('#kuOut').onclick = () => signOut();
  bg.querySelector('#kuGo').onclick = async () => {
    err.textContent = '';
    const oldPassword = bg.querySelector('#kuOld').value;
    const recovery = bg.querySelector('#kuRc').value.trim();
    if (!oldPassword && !recovery) { err.textContent = 'enter your previous password or your recovery code'; return; }
    const btn = bg.querySelector('#kuGo'); btn.disabled = true;
    try {
      await keysUnlock(oldPassword ? { password, oldPassword } : { password, recovery });
      if (ACCOUNT) ACCOUNT.key_stale = false;
      bg.remove();
      toast('Keys unlocked — and moved to your current password', 'check');
      if (then) then();
    } catch (e) { err.textContent = e.message || 'could not unlock'; }
    finally { btn.disabled = false; }
  };
}

/* after a password change: per policy the key wrap does NOT follow silently —
   offer the swap as an explicit one-click (the "manual swap" moment). */
function offerKeySwap(newPassword) {
  if (!ACCOUNT || !ACCOUNT.keys_enrolled) return;
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal twofa-modal">
    <div class="forcepw-badge">${svg('key', 18)}</div>
    <h3>Move your key too?</h3>
    <p>Your password changed, but your <b>encryption key</b> still rides the old one until you swap it. Swap now, or later in Settings → Safety.</p>
    ${ACCOUNT.totp_enabled ? `<div class="form-fields"><label class="form-field"><span class="eyebrow">Two-auth code</span><input id="ksTotp" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code"></label></div>` : ''}
    <div class="form-err" id="ksErr"></div>
    <div class="acts"><button class="btn ghost" data-later>Later</button><button class="btn primary" id="ksGo">Swap key</button></div>
  </div>`;
  document.body.appendChild(bg);
  bg.querySelector('[data-later]').onclick = () => bg.remove();
  bg.querySelector('#ksGo').onclick = async () => {
    const err = bg.querySelector('#ksErr'); err.textContent = '';
    const btn = bg.querySelector('#ksGo'); btn.disabled = true;
    try {
      await keysSwap(newPassword, bg.querySelector('#ksTotp')?.value);
      if (ACCOUNT) ACCOUNT.key_stale = false;
      bg.remove();
      toast('Key swapped to your new password', 'check');
    } catch (e) { err.textContent = e.message || 'swap failed'; btn.disabled = false; }
  };
}

/* the two-auth code step of a sign-in (untrusted device/IP) */
function twofaLoginPrompt(tk, password) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal twofa-modal">
    <h3>Two-auth check</h3>
    <p>This device isn't trusted for this account yet. Enter the 6-digit code from your authenticator app.</p>
    <input class="twofa-code" id="tfaLogin" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
    <div class="form-err" id="tfaLoginErr"></div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" id="tfaLoginGo">Verify</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  const inp = bg.querySelector('#tfaLogin'), err = bg.querySelector('#tfaLoginErr');
  inp.focus();
  const go = async () => {
    err.textContent = '';
    const btn = bg.querySelector('#tfaLoginGo'); btn.disabled = true;
    try {
      const res = await fetch('/api/login/2fa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tk, code: inp.value }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { close(); postLogin(data, password); return; }
      if (data.restart) {   // ticket expired or too many wrong codes — back to square one
        close();
        const hint = document.getElementById('lockHint');
        if (hint) { hint.classList.add('err'); hint.textContent = data.error || 'sign-in expired — try again'; }
        return;
      }
      err.textContent = data.error || 'wrong code — try again';
      inp.value = ''; inp.focus();
    } catch (e) { err.textContent = 'connection error — try again'; }
    finally { btn.disabled = false; }
  };
  bg.querySelector('#tfaLoginGo').onclick = go;
  inp.onkeydown = e => { if (e.key === 'Enter') go(); };
}

/* ---------- forced password change (weak/default password wall) ----------
   No cancel, no backdrop-close: the only ways forward are a strong password
   or signing out. Mirrors the server's isWeakPassword policy client-side for
   instant feedback (the server still has the final say). */
const WEAK_PW_CLIENT = ['1234', '12345', '123456', '1234567', '12345678', '123456789', '0000', '1111',
  'password', 'passw0rd', 'admin', 'letmein', 'qwerty', 'abc123', 'welcome', 'iloveyou', 'dragon', 'monkey', 'simplex'];
function pwWeakClient(pw, username) {
  const l = String(pw || '').toLowerCase();
  return !pw || pw.length < 6 || WEAK_PW_CLIENT.includes(l) || (username && l === String(username).toLowerCase());
}
function forcePwChange() {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal twofa-modal">
    <div class="forcepw-badge">${svg('lock', 18)}</div>
    <h3>Your password is too weak</h3>
    <p>It's short or common (looking at you, “1234”). Set a stronger one to get into Simplex — at least 6 characters, nothing guessable.</p>
    <div class="form-fields">
      <label class="form-field"><span class="eyebrow">New password</span><input type="password" id="fpw1" autocomplete="new-password"></label>
      <label class="form-field"><span class="eyebrow">Repeat it</span><input type="password" id="fpw2" autocomplete="new-password"></label>
      ${ACCOUNT && ACCOUNT.totp_enabled ? `<label class="form-field"><span class="eyebrow">Two-auth code</span><input id="fpwTotp" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code"></label>` : ''}
    </div>
    <div class="form-err" id="fpwErr"></div>
    ${ACCOUNT && !ACCOUNT.totp_enabled ? `<div class="forcepw-tip">${svg('info', 14)} Recommended: turn on <b>two-auth</b> afterwards (Settings → Safety) — then a stolen password alone can't unlock your account.</div>` : ''}
    <div class="acts"><button class="btn ghost" id="fpwOut">Sign out</button><button class="btn primary" id="fpwGo">Change password</button></div>
  </div>`;
  document.body.appendChild(bg);
  const err = bg.querySelector('#fpwErr');
  bg.querySelector('#fpwOut').onclick = () => signOut();
  bg.querySelector('#fpwGo').onclick = async () => {
    const p1 = bg.querySelector('#fpw1').value, p2 = bg.querySelector('#fpw2').value;
    err.textContent = '';
    if (pwWeakClient(p1, ACCOUNT.username)) { err.textContent = 'still too weak — 6+ characters, not a common password'; return; }
    if (p1 !== p2) { err.textContent = 'those don\'t match'; return; }
    const payload = { password: p1 };
    const totpEl = bg.querySelector('#fpwTotp'); if (totpEl) payload.totp = totpEl.value;
    try {
      const r = await updateMe(payload);
      ACCOUNT = r.account;
      bg.remove();
      toast('Password updated — welcome in', 'check');
      unlock();
      // the key wrap still rides the old (weak) password — offer the swap now
      setTimeout(() => offerKeySwap(p1), 700);
    } catch (e) { err.textContent = e.message || 'could not change password'; }
  };
}

/* ---------- forgot password (request → admin emails a code → finish here) ---------- */
function openForgotFlow() {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal twofa-modal"><div id="fpBody"></div></div>`;
  document.body.appendChild(bg);
  const body = bg.querySelector('#fpBody');
  const close = () => bg.remove();
  bg.onclick = e => { if (e.target === bg) close(); };

  function stepAsk() {
    body.innerHTML = `<h3>Forgot password</h3>
      <p>Tell us the account and we'll flag it for the admins — they'll email a one-time reset code to the account's recovery address.</p>
      <div class="form-fields"><label class="form-field"><span class="eyebrow">Username</span><input id="fpUser" autocapitalize="off" autocorrect="off" spellcheck="false"></label></div>
      <div class="form-err" id="fpErr"></div>
      <div class="acts">
        <button class="btn ghost sm" id="fpHave">I already have a code</button>
        <span class="spacer"></span>
        <button class="btn ghost" data-cancel>Cancel</button>
        <button class="btn primary" id="fpGo">Request reset</button>
      </div>`;
    body.querySelector('[data-cancel]').onclick = close;
    body.querySelector('#fpHave').onclick = stepCode;
    const inp = body.querySelector('#fpUser'); inp.focus();
    body.querySelector('#fpGo').onclick = async () => {
      const u = inp.value.trim();
      if (!u) { body.querySelector('#fpErr').textContent = 'enter your username'; return; }
      try { await resetRequest(u); } catch (e) { /* neutral no matter what */ }
      body.innerHTML = `<h3>Request sent</h3>
        <p>If that account exists, the admins have been notified and will email a reset code to its recovery address. Codes expire 24 hours after they're issued.</p>
        <div class="acts"><button class="btn ghost" data-cancel>Close</button><button class="btn primary" id="fpHave2">I have a code</button></div>`;
      body.querySelector('[data-cancel]').onclick = close;
      body.querySelector('#fpHave2').onclick = stepCode;
    };
  }
  function stepCode() {
    body.innerHTML = `<h3>Enter your reset code</h3>
      <p>The code an admin emailed you, plus your new password.</p>
      <div class="form-fields">
        <label class="form-field"><span class="eyebrow">Username</span><input id="fpUser2" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
        <label class="form-field"><span class="eyebrow">Reset code</span><input id="fpCode" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="e.g. K7M2XQ4R"></label>
        <label class="form-field"><span class="eyebrow">New password</span><input type="password" id="fpNew1" autocomplete="new-password"></label>
        <label class="form-field"><span class="eyebrow">Repeat it</span><input type="password" id="fpNew2" autocomplete="new-password"></label>
      </div>
      <div class="form-err" id="fpErr2"></div>
      <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" id="fpFinish">Set new password</button></div>`;
    body.querySelector('[data-cancel]').onclick = close;
    const err = body.querySelector('#fpErr2');
    body.querySelector('#fpUser2').focus();
    body.querySelector('#fpFinish').onclick = async () => {
      err.textContent = '';
      const u = body.querySelector('#fpUser2').value.trim();
      const code = body.querySelector('#fpCode').value.trim();
      const p1 = body.querySelector('#fpNew1').value, p2 = body.querySelector('#fpNew2').value;
      if (!u || !code) { err.textContent = 'username and code are required'; return; }
      if (pwWeakClient(p1, u)) { err.textContent = 'too weak — 6+ characters, not a common password'; return; }
      if (p1 !== p2) { err.textContent = 'those don\'t match'; return; }
      try {
        await resetComplete(u, code, p1);
        close();
        const hint = document.getElementById('lockHint');
        if (hint) { hint.classList.remove('err'); hint.textContent = 'password reset — sign in with your new password'; }
        const uEl = document.getElementById('loginUser'); if (uEl) uEl.value = u;
      } catch (e) { err.textContent = e.message || 'invalid or expired code'; }
    };
  }
  stepAsk();
}

(function wireLogin() {
  const form = document.getElementById('loginForm');
  if (form) form.addEventListener('submit', doLogin);
  const eye = document.getElementById('pwEye');
  if (eye) eye.onclick = () => {
    const p = document.getElementById('loginPass');
    p.type = p.type === 'password' ? 'text' : 'password';
    eye.classList.toggle('on', p.type === 'text');
  };
  const u = document.getElementById('loginUser'); if (u) u.focus();
  const su = document.getElementById('signupBtn');
  if (su) su.addEventListener('click', openSignup);
  const fb = document.getElementById('forgotBtn');
  if (fb) fb.addEventListener('click', openForgotFlow);
})();

/* ---------- STATE / ROUTER ---------- */
/* currentApp = which top-level Simplex app is open: the dashboard launcher, the
   Database file vault, Settings, or a not-yet-built app (Coming Soon). The file
   vault's own `state.view` router below stays scoped to the Database app. */
let currentApp = 'dashboard';
let state = { view: 'home', folder: null, sub: null, query: '' };
let viewMode = localStorage.getItem('simplex.viewmode') || 'grid';
let sortKey = localStorage.getItem('simplex.sortkey') || 'name';
let sortDir = localStorage.getItem('simplex.sortdir') || 'asc';

/* ---------- SELECTION / CLIPBOARD ---------- */
let selection = new Set();   // ids currently selected
let anchorId = null;         // shift-click / shift-arrow range anchor
let cursorId = null;         // keyboard focus position
let clipboard = null;        // { mode: 'cut' | 'copy', ids: [...] } — survives navigation
let internalDrag = false;    // true while dragging items (so OS-file upload zone stays hidden)
let dragIds = null;          // ids being dragged for a move

/* views where the file-manager behavior (select, drag-move, bulk) is active.
   Home stays a click-to-open dashboard. */
function selectionEnabled() { return !SHARE.active && ['browse', 'cat', 'starred', 'trash', 'search', 'tag'].includes(state.view); }
/* raw items backing the current view */
function viewItems() {
  if (state.view === 'browse') return children(state.folder);
  if (state.view === 'cat') return allOfType(state.sub);
  if (state.view === 'starred') return starred();
  if (state.view === 'trash') return trashed();
  if (state.view === 'search') return searchItems(state.query, state.scope);
  if (state.view === 'tag') return itemsWithTag(state.tag);
  return [];
}
/* items in the exact order they appear on screen (folders first, then the sort) */
function displayedItems() { return sortItems(viewItems()); }
const SORTS = [
  { k: 'name', label: 'Name' },
  { k: 'size', label: 'Size' },
  { k: 'type', label: 'Kind' },
  { k: 'date', label: 'Date modified' },
  { k: 'tag', label: 'Tags' },
];

const NAV = [
  { group: 'Vault', items: [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'files', label: 'All files', icon: 'files', count: () => children(null).length },
    { id: 'starred', label: 'Starred', icon: 'star', count: () => starred().length },
    { id: 'tags', label: 'Tags', icon: 'tag', count: () => allTags().length },
    { id: 'docs', label: 'Guide', icon: 'info' },
  ]},
  { group: 'Library', items: [
    { id: 'video', label: 'Films', icon: 'video', count: () => allOfType('video').length },
    { id: 'audio', label: 'Music', icon: 'audio', count: () => allOfType('audio').length },
    { id: 'image', label: 'Photos', icon: 'image', count: () => allOfType('image').length },
    { id: 'document', label: 'Documents', icon: 'document', count: () => allOfType('document').length },
    { id: 'model3d', label: 'Models', icon: 'model3d', count: () => allOfType('model3d').length },
    { id: 'uasset', label: 'Game Assets', icon: 'uasset', count: () => allOfType('uasset').length },
  ]},
  { group: 'System', items: [
    { id: 'customapi', label: 'Custom API', icon: 'key' },
    { id: 'trash', label: 'Trash', icon: 'trash', count: () => trashed().length },
  ]},
];

function go(view, opts = {}) {
  closeViewer();
  selection.clear(); anchorId = cursorId = null;   // selection is per-location; clipboard persists
  state = { view, folder: opts.folder ?? null, sub: opts.sub ?? null, query: '', tag: opts.tag ?? null };
  document.getElementById('search').value = '';
  render();
}

/* ---------- pinned folders (sidebar Pins section) ----------
   The set of pinned folder IDs lives in the account prefs (PREFS.pinnedFolders),
   so it persists per-account and syncs across this user's sessions via setPrefs.
   We store IDs (not paths), so a pin survives renaming or moving the folder.
   Stale pins (folder deleted or in trash) are filtered out at read time and
   pruned lazily, so the sidebar never shows a pin that no longer resolves. */
function pinnedRaw() { return Array.isArray(PREFS.pinnedFolders) ? PREFS.pinnedFolders : []; }
function isPinned(id) { return pinnedRaw().includes(id); }
/* live pinned folders, in pin order, dropping any that no longer resolve to a
   real, non-trashed folder. Also prunes the stored list if it drifted. */
function pinnedFolders() {
  const raw = pinnedRaw();
  const live = raw.filter(id => { const f = byId(id); return f && f.type === 'folder' && !f.trashed; });
  if (live.length !== raw.length) setPrefs({ pinnedFolders: live });   // prune dead pins
  return live.map(byId);
}
function pinFolder(id) {
  const f = byId(id); if (!f || f.type !== 'folder' || f.trashed) return;
  if (isPinned(id)) return;
  setPrefs({ pinnedFolders: [...pinnedRaw().filter(x => byId(x)), id] });
  renderNav();
  toast(`Pinned “${f.name}”`);
}
function unpinFolder(id, quiet) {
  if (!isPinned(id)) return;
  setPrefs({ pinnedFolders: pinnedRaw().filter(x => x !== id) });
  renderNav();
  if (!quiet) { const f = byId(id); toast(f ? `Unpinned “${f.name}”` : 'Unpinned'); }
}
function togglePin(id) { isPinned(id) ? unpinFolder(id) : pinFolder(id); }

/* ============================================================
   APP SYSTEM — top-level launcher + app switching
   The dashboard is a full-screen launcher of app icons. "Database" opens the
   existing file vault (#shell); Settings + every not-yet-built app render into a
   generic full-screen frame (#appscreen). Add a new app by appending to APPS,
   giving it a body (else it falls through to the Coming Soon template), and
   flipping its status to 'ready'.
   ============================================================ */
const APPS = [
  { id: 'database',   name: 'Database',   icon: 'database', tint: 'folder',   status: 'ready', desc: 'Your encrypted files, media & folders.' },
  { id: 'ai',         name: 'AI',         icon: 'spark',    tint: 'audio',    status: 'ready', beta: true, desc: 'Chat with AI models, streamed live.' },
  { id: 'code',       name: 'Code',       icon: 'code',     tint: '',         status: 'ready', beta: true, desc: 'Edit & run code in the cloud.' },
  { id: 'notes',      name: 'Notes',      icon: 'note',     tint: 'document', status: 'ready', desc: 'Rich, encrypted notes & docs.' },
  { id: 'tools',      name: 'Tools',      icon: 'wrench',   tint: 'image',    status: 'ready', beta: true, desc: 'Converters & handy utilities.' },
  { id: 'settings',   name: 'Settings',   icon: 'gear',     tint: '',         status: 'ready', beta: true, desc: 'Account, members & appearance.' },
  { id: 'connectors', name: 'Connectors', icon: 'plug',     tint: '',         status: 'ready', beta: true, desc: 'Link services & automate with connectors.' },
  { id: 'neural',     name: 'Neural Network', icon: 'brain', tint: 'audio',   status: 'ready', beta: true, desc: 'Build, train & run your own neural networks.' },
  { id: 'analytics',  name: 'Analytics',  icon: 'chart',    tint: 'video',    status: 'ready', beta: true, desc: 'See how & when you use your workspace.' },
  { id: 'trading',    name: 'Trading',    icon: 'trend',    tint: 'audio',    status: 'ready', beta: true, desc: 'Let an always-learning AI trade — sandbox or live.' },
  { id: 'music',      name: 'Music',      icon: 'audio',    tint: 'audio',    status: 'ready', beta: true, desc: 'A shared library, playlists & listening together.' },
  { id: 'bugs',       name: 'Bug Reports',icon: 'bug',      tint: 'video',    status: 'ready', desc: 'Report a bug — admins read & triage them here.' },
  { id: 'visual',     name: 'Simplex Visual', icon: 'cube', tint: 'image',    status: 'ready', beta: true, desc: 'A 2D visual game engine — place actors on a canvas, build levels.' },
  { id: 'discord',    name: 'Discord Bot',icon: 'discord',  tint: 'audio',    status: 'ready', beta: true, adminOnly: true, desc: 'A voice assistant that lives in your Discord server.' },
];
/* apps flagged adminOnly are hidden from members entirely (tile + deep link) */
function visibleApps() { return APPS.filter(a => !a.adminOnly || (ACCOUNT && ACCOUNT.is_admin)); }

const SCREENS = ['lock', 'launcher', 'appscreen', 'shell'];
function showScreen(name) {
  SCREENS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const on = id === name;
    el.classList.toggle('hidden', !on);
    if (id === 'shell') el.classList.toggle('show', on);   // shell fades in via .show
  });
}

/* load the signed-in account once (the launcher needs the name + chip). The file
   list is loaded lazily when the Database app is actually opened. */
async function ensureSession() {
  if (!ACCOUNT) { const me = await getMe(); ACCOUNT = me.account; setQuota(ACCOUNT.quota_bytes, me.used); if (me.conn) setConn(me.conn); setServerTimes(me.startedAt, me.vaultBornAt); }
  if (ACCOUNT && ACCOUNT.prefs) { PREFS = { ...PREFS, ...ACCOUNT.prefs }; savePrefsLocal(); applyPrefs(PREFS); }
}

function targetPath() { const p = location.pathname; return (!p || p === '/' || p === '/index.html') ? '/dash' : p; }
async function bootDashboard() {
  SimplexBoot.stage('bootDashboard');
  try {
    await ensureSession();
    document.getElementById('lock').classList.add('hidden');
    startPolling();
    ActivityTracker.start();   // begin counting active time for the Analytics app
    NetWatch.start();          // connection-quality pings driving the lag bar
    await route(targetPath());   // honor the deep link (e.g. /database/music) on entry
    mountRemoteAssistant();       // the always-on "where you are" assistant bar
    SimplexBoot.ready();          // a usable screen is painted — disarm the watchdog
  } catch (e) {
    if (e && e.code === 'AUTH') relock();
    else {
      // Boot failure after the session resolved (e.g. /api/files hung or 500).
      // SimplexBoot.fatal keeps the UI up + reconnects for connectivity errors,
      // and only shows the crash overlay for a genuine frontend error.
      console.error('boot failed', e);
      SimplexBoot.fatal(e);
    }
  }
}
/* on page load, restore an existing session straight into the routed view (so a
   reload or a shared deep link keeps you where you were instead of the lock).

   Two-thread contract: the UI ("Thread 1") must ALWAYS be usable, independent of
   the backend ("Thread 2"). The login screen ships visible in the static HTML, so
   the UI is already painted before any fetch. We therefore signal ready() up front
   (the lock screen is a valid resting state) and treat session restore as a
   background concern. If the backend is down, we don't crash — we leave the UI up,
   let the boot guard show its reconnect banner, and auto-resume once it returns. */
let _restoreInFlight = false;
async function restoreSession() {
  // In share mode (/s/<token>) the page is a self-contained read-only viewer owned
  // by bootShare(). Restoring the owner's session here would call bootDashboard()
  // and route to /dash, yanking the visitor off the share they opened. So if the
  // viewer is logged in, the share page would flash then redirect to the dashboard.
  // Share mode must NOT touch session restore.
  if (SHARE.active) return;
  if (_restoreInFlight) return;
  _restoreInFlight = true;
  SimplexBoot.stage('restoreSession');
  // The login UI is already on screen — the frontend has loaded. Disarm the
  // watchdog now so a slow/absent backend never turns into a "failed to load".
  SimplexBoot.ready();
  try {
    await getMe();
    await bootDashboard();
  } catch (e) {
    if (e && (e.code === 'AUTH' || e.status === 401)) return;   // not signed in: lock screen stays
    // Banned IP (a security tier kicked in mid-session): reload so the server's ban
    // middleware replaces the whole page with the ban + countdown screen.
    if (e && e.status === 403) { location.reload(); return; }
    // Backend unreachable / timed out: keep the UI up. The boot guard shows the
    // reconnect banner; we re-run restore automatically when the backend is back.
    console.warn('session restore deferred — backend unavailable:', e && e.message);
    SimplexBoot.fatal(e);   // guard keeps UI up for connectivity errors, overlays only true crashes
  } finally {
    _restoreInFlight = false;
  }
}
// allow the crash overlay's "Try again" to re-run boot without a full reload
SimplexBoot.onRetry(restoreSession);
// when the backend transitions down -> up, resume where we left off automatically
SimplexBoot.onBackendUp(restoreSession);
restoreSession();
// if a restart is ALREADY in progress when this page loads, raise the gate right
// away (covers a reload mid-restart, or a brand-new visitor arriving during one).
// Deferred to a macrotask so RestartGate (defined later in this file) exists.
if (!SHARE.active) setTimeout(() => { try { RestartGate.checkOnLoad(); } catch (e) {} }, 0);

/* apps that need to clean up on exit (Code stops runs, Notes flushes autosave)
   register a callback here; it runs whenever we switch away. */
let _appCleanup = null;
function runAppCleanup() {
  if (_appCleanup) { try { _appCleanup(); } catch (e) {} _appCleanup = null; }
  if (typeof Player !== 'undefined' && Player.expanded) collapsePlayer();   // drop the now-playing overlay; keep playing in the mini dock
}

function goDashboard() {
  runAppCleanup();
  hideCtx(); closeViewer();
  currentApp = 'dashboard';
  try { window.currentApp = currentApp; } catch (e) {}   // watchdog view label
  showScreen('launcher');
  renderDashboard();
  syncUrl();
}

/* Open an app whose code lives in a lazy module: show a Loading placeholder, load
   the module, then render via its (now-defined) HTML + wire fns resolved by name.
   Bails if the user navigated to a different app while it loaded. */
async function openLazyApp(app, id, moduleName, htmlFnName, wireFnName) {
  openAppScreen(app, `<div class="pad-sm dim mono">Loading ${esc(app.name || id)}…</div>`, { wide: true });
  try { await loadFeature(moduleName); } catch (e) {
    if (currentApp === id) openAppScreen(app, `<div class="pad-sm">Couldn't load ${esc(app.name || id)}. Check your connection and try again.</div>`);
    return;
  }
  if (currentApp !== id) return;   // navigated away while it loaded
  const htmlFn = window[htmlFnName], wireFn = window[wireFnName];
  if (typeof htmlFn !== 'function') { openAppScreen(app, `<div class="pad-sm">Couldn't start ${esc(app.name || id)}.</div>`); return; }
  openAppScreen(app, htmlFn(), { wide: true });
  if (typeof wireFn === 'function') wireFn();
}

async function openApp(id) {
  const app = APPS.find(a => a.id === id);
  if (!app) return;
  runAppCleanup();
  try { await ensureSession(); } catch (e) { if (e && e.code === 'AUTH') return relock(); else return; }
  if (app.adminOnly && !(ACCOUNT && ACCOUNT.is_admin)) return goDashboard();   // admin-only app (e.g. Discord Bot)
  if (typeof trackEvent === 'function') trackEvent('app_open', { app: id });   // Analytics app
  if (id === 'database') return openDatabase();
  currentApp = id;
  try { window.currentApp = currentApp; } catch (e) {}   // watchdog view label
  if (id === 'settings') { openAppScreen(app, settingsHTML()); wireSettings(); }
  else if (id === 'notes') { await openLazyApp(app, id, 'apps-editors', 'notesHTML', 'wireNotes'); }
  else if (id === 'code') { await openLazyApp(app, id, 'apps-editors', 'codeHTML', 'wireCode'); }
  else if (id === 'ai') { openAppScreen(app, aiHTML(), { wide: true }); wireAI(); }
  else if (id === 'tools') { openAppScreen(app, toolsHTML(), { wide: true }); wireTools(); }
  else if (id === 'connectors') { openAppScreen(app, connectorsHTML(), { wide: true }); wireConnectors(); }
  else if (id === 'neural') {
    // neural.js + neural-engine.js (~200KB) are loaded on demand, not at boot.
    openAppScreen(app, `<div class="pad-sm dim mono">Loading Neural Network…</div>`, { wide: true });
    try { await loadFeature('neural'); } catch (e) { openAppScreen(app, `<div class="pad-sm">Couldn't load the Neural Network app. Check your connection and try again.</div>`); return; }
    if (currentApp !== 'neural') return;   // user navigated away while it loaded
    openAppScreen(app, neuralHTML(), { wide: true }); wireNeural();
  }
  else if (id === 'analytics') { await openLazyApp(app, id, 'apps-misc', 'analyticsHTML', 'wireAnalytics'); }
  else if (id === 'trading') { await openLazyApp(app, id, 'apps-trading', 'tradingHTML', 'wireTrading'); }
  else if (id === 'music') { await openLazyApp(app, id, 'apps-music', 'musicHTML', 'wireMusic'); }
  else if (id === 'bugs') { await openLazyApp(app, id, 'apps-misc', 'bugsHTML', 'wireBugs'); }
  else if (id === 'visual') { await openLazyApp(app, id, 'apps-visual', 'visualHTML', 'wireVisual'); }
  else if (id === 'discord') { await openLazyApp(app, id, 'apps-discord', 'discordHTML', 'wireDiscord'); }
  else openAppScreen(app, comingSoonHTML(app));   // any not-yet-built app
  if (typeof raUpdateCtxChip === 'function') raUpdateCtxChip();   // assistant context chip follows the open app
  syncUrl();
}

async function openDatabase() {
  runAppCleanup();
  currentApp = 'database';
  showScreen('shell');
  // Wipe any value a browser/password-manager autofilled into the search box before
  // it can seed a spurious "search" state that would override the routed view.
  const _sb = document.getElementById('search'); if (_sb && _sb.value) _sb.value = '';
  try { await loadDB(); } catch (e) { if (e && e.code === 'AUTH') return relock(); }
  renderAccountBox();
  render();
  wireBrandHome();
}

/* ============================================================
   URL ROUTING — every app/view has a real path (/dash, /database/music, /ai,
   /tools/<id>, …). The work functions above still do the work; here we keep the
   address bar in sync and translate paths back into app/view state. Switching is
   instant because all app state stays in memory (nothing re-fetches needlessly).
   ============================================================ */
let _routing = false;
const DB_SUB = {   // /database/<sub>  <->  state.view
  files: ['browse', { folder: null }], music: ['cat', { sub: 'audio' }], films: ['cat', { sub: 'video' }],
  photos: ['cat', { sub: 'image' }], documents: ['cat', { sub: 'document' }], models: ['cat', { sub: 'model3d' }], assets: ['cat', { sub: 'uasset' }], starred: ['starred', {}],
  trash: ['trash', {}], api: ['customapi', {}], customapi: ['customapi', {}], guide: ['docs', {}], tags: ['tags', {}],
};
const DB_PATH = { browse: 'files', audio: 'music', video: 'films', image: 'photos', document: 'documents', model3d: 'models', uasset: 'assets', starred: 'starred', trash: 'trash', customapi: 'api', docs: 'guide', tags: 'tags' };
function pathFor() {
  if (currentApp === 'dashboard') return '/dash';
  if (currentApp === 'database') {
    const v = state.view;
    if (v === 'home' || v === 'search') return '/database';
    if (v === 'browse') return state.folder ? '/database/folder/' + state.folder : '/database/files';
    if (v === 'cat') return '/database/' + (DB_PATH[state.sub] || state.sub);
    if (v === 'tag') return '/database/tag/' + state.tag;
    return '/database/' + (DB_PATH[v] || v);
  }
  if (currentApp === 'tools') return (_toolView && _toolView !== 'grid') ? '/tools/' + _toolView : '/tools';
  if (currentApp === 'whatsnew') return '/whats-new';
  return '/' + currentApp;   // ai, code, notes, settings, connectors, neural
}
function syncUrl(replace) {
  if (_routing) return;
  const p = pathFor();
  if (location.pathname === p) return;
  try { history[replace ? 'replaceState' : 'pushState']({ p }, '', p); } catch (e) {}
}
async function route(pathname) {
  _routing = true;
  try {
    const seg = String(pathname || '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    const top = seg[0] || 'dash';
    if (top === 'dash') goDashboard();
    else if (top === 'database') {
      await openDatabase();
      if (seg[1] === 'folder' && seg[2] && byId(seg[2])) go('browse', { folder: seg[2] });
      else if (seg[1] === 'tag' && seg[2] && tagById(seg[2])) go('tag', { tag: seg[2] });
      else if (seg[1] === 'file' && seg[2] && byId(seg[2])) { go('browse', { folder: byId(seg[2]).parent || null }); openFileById(seg[2]); }
      else if (seg[1] && DB_SUB[seg[1]]) { const [v, o] = DB_SUB[seg[1]]; go(v, o); }
      else go('home');   // bare /database → the Database home view
    }
    else if (top === 'tools') { await openApp('tools'); if (seg[1] && TOOLS.find(t => t.id === seg[1])) openTool(seg[1]); }
    else if (top === 'whats-new') { try { await ensureSession(); } catch (e) { if (e && e.code === 'AUTH') return relock(); } openWhatsNew(); }
    else if (top === 'music') { await openApp('music'); if (seg[1] === 'playlist' && seg[2]) musicOpenPlaylist(seg[2]); }
    else if (['ai', 'code', 'notes', 'settings', 'connectors', 'neural', 'analytics', 'trading', 'bugs', 'visual', 'discord'].includes(top)) await openApp(top);
    else goDashboard();
  } catch (e) { console.error('route failed', e); }
  finally { _routing = false; syncUrl(true); }
}
function navigate(path) { if (location.pathname !== path) { try { history.pushState({ p: path }, '', path); } catch (e) {} } route(path); }
/* true if opening the current file viewer pushed a history entry we can go back to
   (vs. the file being opened directly via a deep link / page load). */
let _viewerPushedHistory = false;
function _viewerHasHistoryBack() { return _viewerPushedHistory; }
window.addEventListener('popstate', () => { _viewerPushedHistory = false; route(location.pathname); });

/* ---------- real links: URL for a nav id / an app id ----------
   These let nav items and app tiles be genuine <a href> anchors (middle-click /
   Ctrl-click opens the real URL in a new tab, right-click → copy link works, and
   the browser previews the destination on hover). A plain left-click is caught by
   the global interceptor below and routed IN-APP with no reload. */
function hrefForNav(id) {
  if (id === 'home') return '/database';
  if (id === 'files') return '/database/files';
  if (TYPES.includes(id)) return '/database/' + (DB_PATH[id] || id);
  return '/database/' + (DB_PATH[id] || id);   // starred/tags/docs/customapi/trash
}
function hrefForApp(id) {
  if (id === 'database') return '/database';
  if (id === 'dashboard') return '/dash';
  if (id === 'whatsnew') return '/whats-new';
  return '/' + id;
}
/* Global click interceptor for in-app links. Any <a> carrying data-link (or a
   same-origin /path href we recognize) routes in-app on a plain left-click; we let
   the browser handle modified clicks (new tab / new window / download) natively. */
function _isModifiedClick(e) {
  return e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[data-link]');
  if (!a) return;
  if (_isModifiedClick(e)) return;               // new-tab / new-window: let the browser open the real URL
  const href = a.getAttribute('href');
  if (!href || !href.startsWith('/')) return;    // external / non-path links pass through
  e.preventDefault();
  navigate(href);
  if (window.innerWidth <= 820 && typeof closeSidebar === 'function') closeSidebar();
});

/* the SIM·PLEX mark in the vault sidebar doubles as a "back to dashboard" button */
let _brandWired = false;
function wireBrandHome() {
  if (_brandWired || SHARE.active) return;
  const brand = document.querySelector('#shell .side-brand');
  if (!brand) return;
  brand.classList.add('clickable');
  brand.title = 'Back to dashboard';
  brand.onclick = goDashboard;
  _brandWired = true;
}

/* ---------- launcher (dashboard of app icons) ---------- */
function renderDashboard() {
  const el = document.getElementById('launcher');
  if (!el) return;
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = ACCOUNT ? (ACCOUNT.display || ACCOUNT.username) : '';
  el.innerHTML = `
    <div class="launch">
      <div class="launch-top">
        <div class="launch-brand"><span class="dot"></span>SIM<span class="x">PLEX</span></div>
        <div class="account-box compact" id="launchAccountBox"></div>
      </div>
      <div class="launch-hero">
        <div class="lh-greet">${greet}${name ? `, ${esc(name)}` : ''}.</div>
        <div class="lh-sub">Your private workspace — pick where to go.</div>
      </div>
      <button class="whatsnew-banner" data-whatsnew title="See what's new in Simplex">
        <span class="wnb-ico">${svg('spark', 18, 1.7)}</span>
        <span class="wnb-text">
          <span class="wnb-tag">${esc(wnLatestRealTag())} · just landed</span>
          <span class="wnb-head">What's new in Simplex</span>
          <span class="wnb-sub">The AI app can now run models entirely on this server — a new Local tab runs your own GGUF models privately, with a CPU-temperature safety net so long sessions can't overheat the hardware.</span>
        </span>
        <span class="wnb-go">Read it ${svg('back', 13, 2)}</span>
      </button>
      <div class="app-grid">${visibleApps().map(appTileHTML).join('')}</div>
      <div class="launch-foot mono">SIMPLEX · encrypted · self-hosted</div>
    </div>`;
  mountAccountChip(document.getElementById('launchAccountBox'));
  // ready app tiles are anchors handled by the global data-link interceptor; only the
  // inert "soon" buttons need a click handler (to show their coming-soon screen).
  el.querySelectorAll('button.app-tile[data-app]').forEach(t => t.onclick = () => openApp(t.dataset.app));
  const wn = el.querySelector('[data-whatsnew]'); if (wn) wn.onclick = openWhatsNew;
}
function appTileHTML(app) {
  const soon = app.status !== 'ready';
  const inner = `${soon ? '<span class="soon-rib">Soon</span>' : (app.beta ? '<span class="beta-rib">Beta</span>' : '')}
    <span class="at-ico bg-${app.tint || 'folder'} t-${app.tint || 'folder'}">${svg(app.icon, 26, 1.7)}</span>
    <span class="at-name">${esc(app.name)}</span>
    <span class="at-desc">${esc(app.desc)}</span>`;
  // ready apps are real links (open-in-new-tab, copy-link, hover-preview); "soon"
  // tiles stay inert buttons.
  return soon
    ? `<button class="app-tile soon" data-app="${app.id}">${inner}</button>`
    : `<a class="app-tile" href="${hrefForApp(app.id)}" data-link data-app="${app.id}">${inner}</a>`;
}

/* generic full-screen app frame (settings / code / notes / coming-soon).
   opts.wide = full-width body (Code IDE, Notes); opts.barExtra = HTML injected
   into the top bar before the account chip (Run/Stop, note actions, …). */
function openAppScreen(app, bodyHTML, opts = {}) {
  showScreen('appscreen');
  const scr = document.getElementById('appscreen');
  scr.classList.toggle('full', !!opts.wide);
  scr.innerHTML = `
    <div class="appscreen-bar">
      <button class="btn ghost as-back" data-dash title="Back to dashboard">${svg('back', 16)} Dashboard</button>
      <div class="as-title"><span class="as-ico bg-${app.tint || 'folder'} t-${app.tint || 'folder'}">${svg(app.icon, 17, 1.7)}</span>${esc(app.name)}${app.beta ? '<span class="beta-tag">Beta</span>' : ''}</div>
      <div class="as-barextra" id="appBarExtra">${opts.barExtra || ''}</div>
      <div class="spacer"></div>
      <div class="account-box compact" id="appAccountBox"></div>
    </div>
    <div class="appscreen-body${opts.wide ? ' wide' : ''}">${bodyHTML}</div>`;
  scr.querySelectorAll('[data-dash]').forEach(b => b.onclick = goDashboard);
  mountAccountChip(document.getElementById('appAccountBox'));
}

function comingSoonHTML(app) {
  return `<div class="coming">
    <div class="cs-ico bg-${app.tint || 'folder'} t-${app.tint || 'folder'}">${svg(app.icon, 40, 1.5)}</div>
    <div class="cs-badge eyebrow">Coming soon</div>
    <h2>${esc(app.name)}</h2>
    <p>${esc(app.desc)}</p>
    <p class="cs-note mono">We're building this. It'll light up here the moment it's ready.</p>
    <button class="btn ghost" data-dash>${svg('back', 14)} Back to dashboard</button>
  </div>`;
}

/* ---------- What's New (changelog) ----------
   Reachable from the dashboard banner and at /whats-new. No version numbers —
   we ship "Updates". This is Update 1; future updates get appended on top. */
function openWhatsNew() {
  runAppCleanup();
  currentApp = 'whatsnew';
  _wnPage = 0;                               // always start on the newest page
  _wnOpen = new Set([0]);                     // newest update expanded by default (index 0 = newest)
  // a synthetic "app" just to reuse the standard screen header
  openAppScreen({ id: 'whatsnew', name: "What's New", icon: 'spark', tint: 'audio' }, whatsNewHTML());
  wireWhatsNew();
  syncUrl();
}

/* ---- changelog data ----
   Single source of truth, NEWEST FIRST. Each entry: { date:'YYYY-MM-DD', title,
   dek, items }. The "Update N" number and the relative "when" text are DERIVED
   (see wnTagFor / wnRelTime) — never hardcoded. To ship an update, prepend one
   object here; the banner, footer, numbering, dates and paging all follow. */
const WHATS_NEW = [
  {
    date: '2026-07-18',
    title: 'The High-Quality Image update — EXR & TIFF support',
    dek: `Simplex now handles <strong>.exr</strong> and <strong>.tif</strong>/<strong>.tiff</strong> — the ultra-high-quality formats used for height, colour and displacement maps. Browsers can't show them, so the server renders a preview; you also get a <strong>3D heightmap viewer</strong> and full <strong>conversion in both directions</strong>.`,
    items: [
      {
        icon: 'image', tint: 'image',
        head: 'View EXR & TIFF like any photo',
        badge: { text: 'New', cls: 'new' },
        body: `Upload an <strong>.exr</strong> or <strong>.tif</strong>/<strong>.tiff</strong> and it lands in Photos with a real thumbnail and a zoomable viewer. Since no browser can decode these formats, the server renders a viewable preview (EXR's high-dynamic-range float is tonemapped down to a normal image) — the original bytes stay untouched in your vault.`,
      },
      {
        icon: 'model3d', tint: 'model3d',
        head: 'View as heightmap — in 3D',
        badge: { text: 'New', cls: 'new' },
        body: `Right-click any image → <strong>View as heightmap…</strong> and it opens as interactive 3D terrain: each pixel's brightness becomes elevation. Orbit, zoom, toggle wireframe, and drag the <strong>height scale</strong> slider. Perfect for the displacement and height maps EXR/TIFF are usually made for.`,
      },
      {
        icon: 'convert', tint: 'document',
        head: 'Convert to — and from — EXR/TIFF',
        badge: { text: 'New', cls: 'new' },
        body: `Right-click → <strong>Convert to…</strong> turns an EXR or TIFF into PNG, JPG, WebP, or BMP — and turns any ordinary image <em>into</em> TIFF or EXR. It reads straight from your vault and drops the result alongside the original, no re-uploading.`,
      },
    ],
  },
  {
    date: '2026-07-06',
    title: 'The Listening update — cleaner sound, quality picker & save to vault',
    dek: `Three upgrades for Music: the equalizer no longer distorts boosted songs, the player settings grew a <strong>streaming quality</strong> picker (Low → Lossless), and any shared song can now be <strong>saved into your own vault</strong>.`,
    items: [
      {
        icon: 'audio', tint: 'audio',
        head: 'The equalizer stops clipping',
        badge: { text: 'Fixed', cls: 'good' },
        body: `Boost presets like <strong>Bass Booster</strong> or <strong>Loudness</strong> used to push loud songs past full volume, and the browser hard-clipped the sound — a crunchy, "low quality" distortion that was most obvious on car and bass-heavy speakers. The equalizer now automatically makes headroom for whatever it boosts (plus a safety limiter), so presets shape the sound instead of crushing it.`,
      },
      {
        icon: 'gear', tint: 'video',
        head: 'Streaming quality — Low to Lossless',
        badge: { text: 'New', cls: 'new' },
        body: `Player settings (the gear in now-playing) has a new <strong>Streaming quality</strong> picker for Music-app songs: <strong>Low</strong> (96 kbps), <strong>Medium</strong> (160 kbps), <strong>High</strong> (256 kbps) or <strong>Lossless</strong> — the untouched original file, which stays the default. Changing it mid-song reloads the track right where you were.`,
        points: [
          `Lower tiers are transcoded once on the server, cached, and streamed with full seeking — handy on mobile data.`,
          `A song that's already below the tier you picked streams as-is; nothing is ever re-encoded upward.`,
        ],
      },
      {
        icon: 'download', tint: 'document',
        head: 'Save shared songs to your vault',
        badge: { text: 'New', cls: 'new' },
        body: `Found something you love in the shared library? Right-click it (or open its details) → <strong>Save to my vault…</strong>, pick a folder, and a full-quality copy — cover art, artist and album included — lands in your own encrypted Database, yours even if the shared copy is ever removed.`,
      },
    ],
  },
  {
    date: '2026-07-05',
    title: 'The Safety update — weak passwords, two-auth & recovery',
    dek: `Simplex now looks after your account, not just your files. Weak passwords (yes, “1234”) get walled off at sign-in until changed, a new <strong>Safety level</strong> lives in Settings, <strong>two-auth</strong> protects sign-ins from unknown devices, and <strong>Forgot password?</strong> finally exists.`,
    items: [
      {
        icon: 'lock', tint: 'video',
        head: 'No more “1234”',
        badge: { text: 'Security', cls: 'new' },
        body: `If your password is too short or too common, your next sign-in stops at a full-screen wall: pick a stronger password (6+ characters, nothing guessable) and you're in. Weak passwords are also rejected everywhere they could be set.`,
      },
      {
        icon: 'lock', tint: 'image',
        head: 'Safety levels & two-auth',
        badge: { text: 'New', cls: 'new' },
        body: `<strong>Settings → Safety</strong> has a three-step safety bar: <strong>Minimal</strong> (password), <strong>Moderate</strong> (+ recovery email), <strong>Maximum</strong> (+ two-auth). Setting up two-auth shows a QR for your authenticator app — or a copyable text secret — then verifies a 6-digit code, asks if you're one of the humans, and finishes with a quick captcha. You can regenerate the secret anytime if it leaked.`,
        points: [
          `With two-auth on, signing in from a <strong>new device or IP</strong> needs a code. Devices you sign in from regularly stay trusted — until you sign out manually, which untrusts that device on purpose.`,
          `Changing your password or email with two-auth on also requires a code.`,
        ],
      },
      {
        icon: 'key', tint: 'document',
        head: 'Forgot password?',
        badge: { text: 'New', cls: 'new' },
        body: `A new link on the sign-in screen. Request a reset and the admins get pinged with your recovery email; they generate a one-time code (visible in <strong>Manage accounts → Security</strong>, with a ready-made email draft) and send it to you. Enter the code with a new password and you're back in. Codes expire after 24 hours.`,
      },
    ],
  },
  {
    date: '2026-07-03',
    title: 'A fresh coat — light mode, ambience & motion',
    dek: `Simplex looks new today. Choose between <strong>dark and light themes</strong> (dark stays the default), set a <strong>background ambience</strong> — a drifting aurora, a live fire simulation, or classic scanlines — and enjoy subtler touches everywhere: content glides in, cards lift, buttons glow. All of it respects <strong>Reduce motion</strong>.`,
    items: [
      {
        icon: 'gear', tint: 'image',
        head: 'Light mode has arrived',
        badge: { text: 'New', cls: 'new' },
        body: `Two light themes join the family: <strong>Daylight</strong>, a warm paper look, and <strong>Frost</strong>, a cool bright one. Find them in <strong>Settings → Appearance → Theme</strong>, now grouped into Dark and Light. Your accent color carries over either way, and even your phone's status bar follows the theme.`,
      },
      {
        icon: 'spark', tint: 'audio',
        head: 'Ambience & motion',
        badge: { text: 'New', cls: 'new' },
        body: `A new <strong>Background ambience</strong> setting paints the space behind the app: <strong>Aurora</strong> (two layers of drifting glow in your accent color), <strong>Fire</strong> (a real, live fire simulation — softly blurred flames rising behind everything), <strong>Soft glow</strong>, <strong>Scanlines</strong>, or <strong>None</strong>. On top of that, screens now ease in, file grids stagger to life, and dialogs pop.`,
        points: [
          `New fonts too: <strong>Space Grotesk</strong> for the interface and <strong>Fira Code</strong> for code.`,
          `Three new accent colors: Crimson, Ice and Sage.`,
          `Prefer stillness? <strong>Reduce motion</strong> switches every new animation off — and Simplex now honors your device's reduced-motion preference as well.`,
        ],
      },
    ],
  },
  {
    date: '2026-07-01',
    title: 'Make it yours — new appearance settings',
    dek: `Settings just got a lot more customizable. Scale the <strong>whole interface</strong> up or down, give <strong>reading text</strong> an extra nudge, choose how the <strong>now-playing cover</strong> spins, tune <strong>density</strong> and <strong>corner roundness</strong>, and switch on <strong>reduce motion</strong> — all live, and all saved to your account.`,
    items: [
      {
        icon: 'gear', tint: 'document',
        head: 'Size everything to taste',
        badge: { text: 'New', cls: 'new' },
        body: `Open <strong>Settings → Appearance</strong>. <strong>Interface size</strong> scales the entire app — text, icons, and spacing together — while <strong>Text size</strong> nudges just the reading text in content areas. Set them once and every screen follows.`,
        points: [
          `<strong>Density</strong> packs lists and cards tighter (Compact) or gives them more room (Roomy).`,
          `<strong>Corner roundness</strong> takes buttons and panels from square to pill-round.`,
        ],
      },
      {
        icon: 'audio', tint: 'audio',
        head: 'Your player, your motion',
        badge: { text: 'New', cls: 'new' },
        body: `Pick how the now-playing <strong>album cover rotates</strong>: while playing, always, only when paused, or never. Prefer a calmer interface? <strong>Reduce motion</strong> quiets animations and transitions across the whole app.`,
        points: [
          `Everything applies instantly and is remembered per account — and there's a one-click <strong>Reset appearance</strong> if you want the defaults back.`,
        ],
      },
    ],
  },
  {
    date: '2026-06-29',
    title: 'Listen together with Music',
    dek: `Say hello to the <strong>Music</strong> app — a <strong>shared</strong> place for everyone on this workspace to hear each other's songs. Add audio straight from your vault and it joins a library everyone can see and play. Build <strong>playlists</strong> (keep them public or private), and when you're listening, turn it into a <strong>jam</strong>: a friend hits join and you're both on the exact same song, in sync, with shared controls.`,
    items: [
      {
        icon: 'audio', tint: 'audio',
        head: 'A library everyone shares',
        badge: { text: 'New', cls: 'new' },
        body: `Open Music, hit <strong>Add from vault</strong>, and pick any audio you've uploaded — each song is copied into the shared library so everyone can play it, even if you later delete the original from your vault. Adding the same song twice is detected automatically, so the library stays tidy. Only the person who added a song (or an admin) can remove it.`,
        points: [
          `<strong>Playlists, public or private.</strong> Make a playlist and choose who sees it: public ones show up for everyone, private ones stay just yours.`,
          `Songs carry their artist and cover art across, just like in your Database.`,
        ],
      },
      {
        icon: 'user', tint: 'video',
        head: 'Jam — listen together, in perfect sync',
        badge: { text: 'New', cls: 'new' },
        body: `Playing something good? Hit <strong>Start a jam</strong>. Anyone can join from the <strong>Jams</strong> tab and they'll hear the very same song at the very same moment. <strong>Everyone</strong> shares the controls — pause, skip, shuffle, loop — and it stays in sync within about a second. If the person who started it leaves, the jam keeps going for everyone else.`,
        points: [
          `<strong>Real shuffle.</strong> Shuffle now reorders the whole queue for your session (a true shuffled order) instead of just jumping to a random song — and it never changes the saved playlist.`,
          `<strong>Loop</strong> runs the queue from the top again when it reaches the end.`,
        ],
      },
    ],
  },
  {
    date: '2026-06-24',
    title: 'Your own private AI, running on the server',
    dek: `The <strong>AI</strong> app can now run language models <strong>entirely on this server</strong> — nothing leaves the machine, no API key, no outside service. A new <strong>Local</strong> tab sits next to the usual <strong>Online</strong> one: pick a model an admin pre-loaded on the server, or use a <code>.gguf</code> model file you've uploaded to your own Database. It streams just like the online models, and a built-in safety net watches the CPU temperature so a long session can't cook the hardware.`,
    items: [
      {
        icon: 'cpu', tint: 'document',
        head: 'Online and Local, in one switch',
        badge: { text: 'New', cls: 'new' },
        body: `Open the AI app and flip the switch at the top-left between <strong>Online</strong> (the cloud providers you already had) and <strong>Local</strong> (models running right here on the server). Local chats stream live, save to your encrypted history, and work with the same personalization — they just never touch the internet.`,
        points: [
          `<strong>Two kinds of local models.</strong> Use one an admin dropped into the server's models folder, or upload your own <code>.gguf</code> file into your Database and it appears in the Local list automatically — decrypted into memory only while it's running.`,
          `<strong>It loads on demand.</strong> The first message wakes the model up (you'll see "loading model…"); after that it answers instantly and quietly unloads when idle to free memory.`,
        ],
      },
      {
        icon: 'lock', tint: 'image',
        head: 'Fully private — no external services',
        badge: { text: 'New', cls: 'new' },
        body: `There's no Ollama, no LM Studio, nothing to install — the inference engine ships inside Simplex and runs as part of the server. Your uploaded models stay encrypted at rest like every other file, and your conversations stay on your account.`,
        points: [
          `Bring any compatible <code>.gguf</code> model (a 0.5–3B model is a comfortable starting point on a home machine). Models with quirky chat templates that used to refuse to start now load automatically on a safe fallback.`,
        ],
      },
      {
        icon: 'thermometer', tint: 'video',
        head: 'A temperature safety net for your hardware',
        badge: { text: 'New', cls: 'new' },
        body: `Running a model locally pushes the CPU hard, so Simplex keeps an eye on the temperature. If the server gets too hot for too long, it <strong>stops local AI and pauses it for five minutes to cool down</strong> — you'll see a friendly notice, and online models keep working the whole time.`,
        points: [
          `<strong>Admins are in control.</strong> Settings → AI providers → Local AI now shows the live CPU temperature and lets you set the trip and resume temperatures to match your machine.`,
          `It's a protective backstop, not a nuisance: brief spikes are ignored, and everything resumes on its own once things cool off.`,
        ],
      },
    ],
  },
  {
    date: '2026-06-22',
    title: 'AI that learns how you organize',
    dek: `Simplex now has a private <strong>AI Organization</strong> model that learns from <em>your</em> vault — your filenames, folders, tags, file types, and a lightweight peek at file contents — and suggests where new files belong. It's on by default, trains itself in the background, and never leaves your account: every user gets their own model, and one account's model can never see another's files.`,
    items: [
      {
        icon: 'brain', tint: 'audio',
        head: 'Folder & tag suggestions, tuned to your habits',
        badge: { text: 'New', cls: 'new' },
        body: `Upload a file and Simplex suggests a <strong>folder to file it in</strong> and <strong>tags to add</strong>, based on patterns it learned from how you've organized everything else. Suggestions appear as small chips under the file for an hour, then tuck away — reach them any time by right-clicking a file and choosing <strong>AI Store…</strong>. Nothing is ever applied automatically; you decide.`,
        points: [
          `<strong>Useful from day one.</strong> The moment you turn it on, it trains on the files you already have — your current folders and tags become its examples — so it starts making real suggestions without a single new upload.`,
          `<strong>Apply all, in one click.</strong> The AI Store has an <strong>Apply all</strong> button that adds every suggested tag and files the item into the best-matching folder, all at once.`,
          `<strong>It learns from you.</strong> Accepting a suggestion reinforces the model; correcting or dismissing one teaches it what <em>not</em> to do. It keeps getting better as you use it.`,
        ],
      },
      {
        icon: 'gear', tint: 'document',
        head: 'Yours to control, in Settings',
        badge: { text: 'New', cls: 'new' },
        body: `A new <strong>AI Organization</strong> section in Settings shows your model's accuracy, how much data it has trained on, and when it last trained. You can retrain on demand, set how confident a suggestion must be before it shows, or reset the model entirely.`,
        points: [
          `<strong>Confidence threshold.</strong> A single slider (default 60%) decides how sure the model must be before a suggestion appears or gets applied — raise it for only the safest picks, lower it to see more.`,
          `<strong>Off whenever you want.</strong> Turn it off and all training and suggestions stop; your model and data stay put until you choose to reset them.`,
        ],
      },
      {
        icon: 'lock', tint: 'image',
        head: 'Private by design',
        badge: { text: 'New', cls: 'new' },
        body: `Your model lives only in your encrypted vault and trains only on your files. It reads filenames, folder structure, tags, and a small content fingerprint — but <strong>encrypted and locked files are excluded entirely</strong>, so their contents and metadata are never analyzed.`,
        points: [
          `The content fingerprint is a tiny statistical summary of a small sample of each file — enough that two similar files look similar to the model, without any heavy parsing, OCR, or transcription.`,
          `Everything stays on your account. There is no shared model and no cross-account access — by construction.`,
        ],
      },
    ],
  },
  {
    scrap: true, tag: 'Scrap',
    date: '2026-06-22',
    title: 'Game save recognition (scrapped)',
    dek: `This one was built and then pulled. The idea: right-click a folder, have Simplex read its structure to recognize a <strong>Minecraft: Java</strong> world, and open a grayscale 3D preview of its terrain. It worked — but we scrapped it because, honestly, almost no one would use it, and it ran too slowly on big worlds to be worth keeping. Logging it here so the thinking isn't lost.`,
    items: [
      {
        icon: 'cube', tint: '',
        head: 'What it was going to be',
        badge: { text: 'Scrapped', cls: 'scrap' },
        body: `A "Recognize Save" action on folders that read their actual structure (not just the name) to identify a known game save, starting with <strong>Minecraft: Java</strong> (and a stub for Bedrock). Recognized worlds would gain a <strong>Preview Save</strong> option that opened a texture-free, grayscale 3D view of the world's surface — terrain, hills, water and builds — that you could orbit and zoom like the 3D model viewer, re-rendering around the camera as you moved.`,
      },
      {
        icon: 'close', tint: 'video',
        head: 'Why we scrapped it',
        badge: { text: 'Scrapped', cls: 'scrap' },
        body: `Two reasons. First, <strong>it would go basically unused</strong> — it's a niche toy that doesn't fit what Simplex is actually for. Second, <strong>it was slow on big worlds</strong>: decoding the region files to a renderable surface got expensive fast, and a real world is large enough that the preview never felt snappy. Not worth the weight, so it's out — the code's been fully removed.`,
        points: [
          `The underlying file format work (UE4 <code>.sav</code> editing) still ships — that one's genuinely useful and stayed.`,
          `If we ever revisit game-save tooling, it'll be something with a clearer payoff than a grayscale world preview.`,
        ],
      },
    ],
  },
  {
    date: '2026-06-22',
    title: 'Convert, clean up, and edit game saves',
    dek: `A batch of things that make your files do more right where they live. Convert media and images without leaving the Database, strip hidden metadata out of your photos and music, and — for the tinkerers — crack open Unreal Engine <code>.sav</code> game saves and edit them in place. Plus a quieter win: your music finally shows its real artist and cover art.`,
    items: [
      {
        icon: 'convert', tint: 'audio',
        head: 'Convert files right from the Database',
        badge: { text: 'New', cls: 'new' },
        body: `Right-click any video, audio, or image and pick <strong>Convert to…</strong> — a menu of every format it can become. No trip to the Tools app, no re-uploading: it reads the file straight from your vault and drops the converted copy right back in.`,
        points: [
          `<strong>Video</strong> converts to other formats (MP4, MKV, WebM, MOV, AVI…) <em>or</em> extracts straight to audio (MP3, M4A, FLAC…).`,
          `<strong>Audio</strong> and <strong>images</strong> convert between their formats too — PNG ⇄ JPG ⇄ WebP and the rest.`,
          `The image tools in the Tools app now pick from your vault as well, instead of asking you to upload a file you already have.`,
        ],
      },
      {
        icon: 'info', tint: 'image',
        head: 'See — and scrub — hidden metadata',
        badge: { text: 'New', cls: 'new' },
        body: `Open a file's <strong>Details</strong> and hit <strong>Edit Metadata</strong> to see everything baked into it — the camera and GPS location in a photo, the tags and encoder info in a song or video. One <strong>Purge</strong> button strips the non-essential bits while keeping the file perfectly playable.`,
        points: [
          `<strong>Real privacy.</strong> Photos are re-encoded so embedded EXIF — including GPS coordinates and camera model — is actually removed, not just hidden.`,
          `Audio and video keep their quality: tags are stripped without re-encoding the media.`,
        ],
      },
      {
        icon: 'audio', tint: 'audio',
        head: 'Music shows its artist and cover art',
        badge: { text: 'Fixed', cls: 'good' },
        body: `Upload a song and Simplex now reads the artist, album, and embedded cover art out of the file itself — so the player shows the real details and album art instead of "Unknown artist" and a generic icon.`,
        points: [
          `Works on new uploads automatically; tracks you uploaded earlier fill in their details the first time you play them.`,
        ],
      },
      {
        icon: 'code', tint: 'document',
        head: 'Edit Unreal Engine game saves',
        badge: { text: 'New', cls: 'new' },
        body: `Have a <code>.sav</code> from an Unreal Engine game? Right-click it and choose <strong>Edit Save…</strong> to open a proper save editor — like the paid sites, but built right in and free. Search and change values (toggles, numbers, names) and save back to your vault.`,
        points: [
          `<strong>Everything's editable.</strong> It reads every value in the save, even ones buried deep inside lists and groups.`,
          `<strong>Safe by design.</strong> The file is rebuilt byte-perfectly, so an unchanged save comes back identical — and you can always “Save as new…” to keep the original.`,
          `Tested against a real game save to make sure edits land exactly where they should and the file still loads.`,
        ],
      },
    ],
  },
  {
    date: '2026-06-21',
    title: 'Build your own neural networks',
    dek: `The old Music tile is now a full <strong>Neural Network</strong> app. Build a network two ways — a visual sandbox you wire up over a 2D world, or an upload-and-train text model — and run it right in your browser. Everything you make is saved to your encrypted vault automatically.`,
    items: [
      {
        icon: 'grid', tint: 'audio',
        head: 'Actor Lab — design your own 2D world, like a game engine',
        badge: { text: 'New', cls: 'new' },
        body: `Build your own <strong>actor types</strong> — agents, walls, obstacles, targets, anything — and give each one a <strong>node graph</strong> (Blueprint-style) that runs every tick. There are two kinds of wire: <strong>white action wires</strong> that thread the run order through your nodes, and <strong>colored data wires</strong> (green numbers, red booleans) that carry values. Wire up variables, math, physics, <strong>raycasts</strong>, collisions, branches, and rewards; declare what your AI sees and what its outputs do. Place them on a map and <strong>evolve</strong> the agents to maximize the reward you defined. No presets — you build the rules.`,
        points: [
          `<strong>Action &amp; data flow, like UE5 Blueprints.</strong> Events (On Tick, On Hit, On Spawn) start a white action chain; pure nodes (Get Var, math, Raycast, Brain Output) feed in typed, color-coded values.`,
          `<strong>Branch on conditions.</strong> A Branch node splits the action flow into <em>True</em> and <em>False</em> paths from a boolean — so an obstacle can punish the agent only when it's actually touching.`,
          `<strong>Strict, colored pins.</strong> Each pin has a type and color (white = action, green = number, red = boolean) and only matching pins connect — no more guessing what links to what.`,
          `<strong>Place &amp; evolve.</strong> Drop instances on the map, hit evolve, and watch the best agents replay live. One brain per agent type, shared across its instances.`,
          `Prefer something quick? A simple <strong>Quick Sandbox</strong> (fixed agent + target, pick sensors and a fitness rule) is still there for a fast first network.`,
        ],
      },
      {
        icon: 'note', tint: 'document',
        head: 'Text Model — train something that talks',
        badge: { text: 'New', cls: 'new' },
        body: `Paste or upload text, hit train, and watch the loss curve fall as a language model learns your data. Then chat with it — give it a few words and it writes more in the same style. The model internals stay under the hood; you just feed it text and talk to it.`,
        points: [
          `<strong>Pre-train and fine-tune</strong> from the same place — more text and more training make it sound more like your data.`,
          `<strong>Tune the voice.</strong> A creativity dial and length control shape what it generates.`,
        ],
      },
      {
        icon: 'gear', tint: '',
        head: 'Runs on your device — or the server',
        body: `Every network runs in your browser by default. Admins can enable <strong>backend compute</strong> per account (Manage accounts → permissions), letting heavier training run on the server instead. Either way, each network has a home in your encrypted vault and is saved as you go.`,
      },
    ],
  },
  {
    date: '2026-06-21',
    title: 'Restarts on your schedule',
    dek: `Automatic restarts now run on a weekly schedule you control — by default Monday mornings and Friday middays — instead of every few hours. Set the days and times that suit you, right from Settings.`,
    items: [
      {
        icon: 'refresh', tint: 'audio',
        head: 'A restart schedule you can edit',
        badge: { text: 'New', cls: 'new' },
        body: `Admins can now pick exactly when the server restarts itself, from <strong>Settings → Server → Edit schedule</strong>. Out of the box it's <strong>Monday 9:00 AM</strong> and <strong>Friday 12:00 PM</strong> — add, change, or remove times whenever you like.`,
        points: [
          `<strong>Weekly, not hourly.</strong> Restarts happen on the days and times you choose, so they land when it's convenient.`,
          `<strong>Fully yours.</strong> Add as many slots as you want, or switch automatic restarts off entirely and just restart by hand.`,
          `Manual “Restart now” still works exactly as before, and everyone still sees the tidy be-right-back screen.`,
        ],
      },
    ],
  },
  {
    date: '2026-06-20',
    title: 'Your 3D models, viewable in the vault',
    dek: `Simplex now understands 3D models as their own kind of file. Drop one in and you can spin it around right in the browser — no downloading, no separate app, no guessing what's inside from the filename. Models join videos, music, photos, and documents as a first-class file type with their own spot in the sidebar.`,
    items: [
      {
        icon: 'model3d', tint: 'model3d',
        head: 'New file type: 3D Models',
        badge: { text: 'New', cls: 'new' },
        body: `Upload a model and Simplex recognizes it automatically, files it under the new <strong>Models</strong> category, and gives it its own amber icon — so it's easy to spot at a glance instead of getting lumped in with documents.`,
        points: [
          `<strong>Five formats supported:</strong> <code>.glb</code>, <code>.gltf</code>, <code>.obj</code>, <code>.fbx</code>, and <code>.stl</code>.`,
          `<strong>Find them fast.</strong> A new <strong>Models</strong> entry in the sidebar (and a tile on your home screen) gathers every model in one place, with a live count and total size.`,
          `Everything stays encrypted at rest, exactly like your other files — including models you've put a passphrase lock on.`,
        ],
      },
      {
        icon: 'cube', tint: 'image',
        head: 'A built-in 3D viewer',
        badge: { text: 'New', cls: 'new' },
        body: `Double-click a model to open it in an interactive viewer. Drag to orbit, scroll to zoom, right-drag to pan — the camera frames the model for you automatically, so it's centered and sized right the moment it opens.`,
        points: [
          `<strong>Wireframe toggle</strong> to peek at the mesh, an <strong>auto-rotate</strong> spin, a <strong>grid</strong> for a sense of scale, and a <strong>reset</strong> button to snap back to the starting view.`,
          `A quick readout shows the format, mesh count, and triangle count so you know what you're looking at.`,
          `The renderer loads only the first time you open a model, so it never slows down the rest of Simplex.`,
        ],
      },
    ],
  },
  {
    date: '2026-06-20',
    title: 'Restarts, done gracefully',
    dek: `Simplex now restarts itself to pick up changes — on a schedule and on demand — without leaving anyone staring at a half-broken page. When it goes down for a moment, everyone sees the same tidy "be right back" screen and is reloaded automatically the instant it's back.`,
    items: [
      {
        icon: 'refresh', tint: 'audio',
        head: 'Automatic + manual restarts',
        badge: { text: 'New', cls: 'new' },
        body: `The server now relaunches itself every <strong>4 hours</strong> to apply any backend changes, and admins can trigger a restart any time from <strong>Settings → Server → Restart now</strong>. Behind the scenes a small supervisor brings a fresh server right back up.`,
        points: [
          `<strong>Scheduled.</strong> A clean restart every 4 hours keeps things fresh with zero babysitting.`,
          `<strong>On demand.</strong> Changed how the backend works? One click and it's live for everyone.`,
        ],
      },
      {
        icon: 'lock', tint: 'image',
        head: 'A friendly "restarting" screen for everyone',
        badge: { text: 'New', cls: 'new' },
        body: `When a restart starts, the whole interface gently zooms out and a panel drops in with a spinner letting you know the server is coming back. Reload or show up mid-restart and you'll see the same screen — no errors, no broken buttons.`,
        points: [
          `Everyone on the site is <strong>automatically reloaded</strong> the moment the fresh server is ready, so the new version takes effect for all at once.`,
          `It's only a few seconds — anything mid-flight (an upload or a run) is interrupted, so it picks a calm moment when it can.`,
        ],
      },
    ],
  },
  {
    date: '2026-06-19',
    title: 'Steadier, sharper, and a little more powerful',
    dek: `A lot of this update is the quiet kind of work — the stuff you only notice because things <em>stop</em> going wrong. We spent real time chasing down the freezes and the "it loads forever" moments, then added a couple of genuinely new toys on top. Here's the rundown — skim the headers, or dig into the details.`,
    items: [
      {
        icon: 'hdd', tint: 'folder',
        head: 'A more stable backend (and we can finally see what it\'s doing)',
        badge: { text: 'Reliability', cls: 'good' },
        body: `The server used to occasionally wedge itself — slow to respond, or stuck behind a loading screen with nothing useful in the logs. We rebuilt how it runs: it's now a single, straightforward process instead of a tangle of watchdogs restarting each other, which removed a whole category of "why did it just restart?" gremlins.`,
        points: [
          `<strong>No more mystery hangs.</strong> Heavy work (copying big folders, reading encrypted media, running tools) no longer blocks everything else while it churns.`,
          `<strong>Always-on diagnostics.</strong> The server keeps a lightweight health journal, so if something <em>does</em> misbehave, we can actually tell what and when — instead of guessing.`,
          `<strong>Faster, calmer streaming.</strong> Playing and seeking through large videos and audio is smoother, and one stuck stream can't drag the rest down with it.`,
          `<strong>It loads, period.</strong> The page paints right away and recovers on its own instead of leaving you staring at a spinner.`,
        ],
      },
      {
        icon: 'video', tint: 'image',
        head: 'New: Mini Video Editor in Tools',
        badge: { text: 'New', cls: 'new' },
        body: `Tucked into the <strong>Tools</strong> section is a brand-new Mini Video Editor — a quick, no-fuss way to trim and tidy a clip without leaving Simplex or installing anything. It's built for the "I just need to cut the boring part out" moments, not a full studio.`,
        points: [
          `Trim and stitch sections of a video right in the browser.`,
          `Mix in audio tracks and export a finished file back into your vault.`,
          `Runs server-side so your laptop fan doesn't take off — and the result lands straight in your encrypted storage.`,
        ],
      },
      {
        icon: 'lock', tint: '',
        head: 'New: per-file & per-folder encryption',
        badge: { text: 'Experimental', cls: 'beta' },
        body: `Everything in Simplex is already encrypted at rest — but now you can put an <em>extra</em> passphrase lock on a specific file or folder, so even an open session can't peek inside without it. Right-click an item and choose <strong>Encrypt…</strong> to set a passphrase.`,
        points: [
          `<strong>Unlock</strong> opens an item temporarily — it stays open until you sign out, and survives a page reload.`,
          `<strong>Decrypt</strong> removes the lock permanently, turning it back into a normal file.`,
          `The passphrase is only ever used in your browser; it never touches the server, and there's no recovery if you forget it — so pick something you'll remember.`,
          `Marked experimental on purpose: it works, but we're still refining the edges. Don't lock your only copy of something irreplaceable just yet.`,
        ],
      },
      {
        icon: 'document', tint: 'document',
        head: 'Fixes for large-file editing & previewing',
        badge: { text: 'Fixed', cls: 'good' },
        body: `Big files used to be where things got janky — slow previews, the occasional freeze when opening a hefty document or scrubbing a long video. We went through those paths and smoothed them out.`,
        points: [
          `Previews and thumbnails load lazily and politely, so a folder full of media doesn't stall the whole view.`,
          `Opening and editing large text/code files is snappier and far less likely to hang the tab.`,
          `Media players now fully let go of a file when you close them, so long sessions of watching or listening don't slowly eat your browser's memory.`,
        ],
      },
    ],
  },
];

const WN_PER_PAGE = 10;
let _wnPage = 0;                 // current page (0 = newest 10)
let _wnOpen = new Set();         // set of GLOBAL update indices currently expanded

/* The tag shown for an entry. Scrapped entries carry their own tag (e.g. "Scrap")
   and DON'T consume an update number; real updates are numbered "Update N" with
   the oldest = 1. A real entry's number = how many non-scrap entries exist from it
   onward (since the list is newest-first). */
function wnTagFor(i) {
  const u = WHATS_NEW[i];
  if (u && u.scrap) return u.tag || 'Scrap';
  let n = 0;
  for (let k = i; k < WHATS_NEW.length; k++) if (!WHATS_NEW[k].scrap) n++;
  return 'Update ' + n;
}
/* the newest REAL (non-scrap) update — used by the banner + footer */
function wnLatestReal() { return WHATS_NEW.find(u => !u.scrap) || WHATS_NEW[0]; }
function wnLatestRealTag() { const i = WHATS_NEW.findIndex(u => !u.scrap); return i < 0 ? 'Update 1' : wnTagFor(i); }

/* friendly changelog date: today / yesterday / N days ago / N weeks ago /
   N months ago / a full date for anything older. Stays honest as time passes. */
function wnRelTime(dateStr) {
  const then = new Date(dateStr + 'T12:00:00');
  if (isNaN(then)) return '';
  const now = new Date();
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(then.getFullYear(), then.getMonth(), then.getDate())) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return days + ' days ago';
  if (days < 14) return 'last week';
  if (days < 31) return Math.floor(days / 7) + ' weeks ago';
  if (days < 61) return 'last month';
  if (days < 365) return Math.floor(days / 30) + ' months ago';
  return then.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/* one update block. `i` is the global index; `open` controls collapsed state.
   Scrapped entries get a red treatment (.scrap) and a "Scrap" tag instead of a number. */
function wnUpdate(u, i, open) {
  return `<section class="wn-update${open ? ' open' : ''}${u.scrap ? ' scrap' : ''}" data-wn="${i}">
    <button class="wn-uhead" data-wntoggle="${i}" aria-expanded="${open ? 'true' : 'false'}">
      <span class="wn-utag${u.scrap ? ' scrap' : ''}">${esc(wnTagFor(i))}</span>
      <h2 class="wn-utitle">${esc(u.title)}</h2>
      <span class="wn-uwhen mono">${esc(wnRelTime(u.date))}</span>
      <span class="wn-uchev">${svg('chevron-right', 16)}</span>
    </button>
    <div class="wn-ubody">
      ${u.dek ? `<p class="wn-udek">${u.dek}</p>` : ''}
      <div class="wn-items">${u.items.map(wnItem).join('')}</div>
    </div>
  </section>`;
}
function wnItem({ icon, tint, badge, head, body, points }) {
  return `<article class="wn-item">
    <div class="wn-i-ico bg-${tint || 'folder'} t-${tint || 'folder'}">${svg(icon || 'spark', 20, 1.7)}</div>
    <div class="wn-i-main">
      <div class="wn-i-head">${esc(head)}${badge ? `<span class="wn-i-badge ${badge.cls || ''}">${esc(badge.text)}</span>` : ''}</div>
      <p class="wn-i-body">${body}</p>
      ${points && points.length ? `<ul class="wn-i-points">${points.map(p => `<li>${p}</li>`).join('')}</ul>` : ''}
    </div>
  </article>`;
}

function whatsNewHTML() {
  return `<div class="whatsnew">
    <div class="wn-hero">
      <div class="wn-hero-ico bg-audio t-audio">${svg('spark', 30, 1.6)}</div>
      <h1>What's New</h1>
      <p class="wn-hero-sub">The latest changes, fixes, and shiny new things in Simplex. We ship in numbered <strong>Updates</strong> — newest first. Click any update to expand it.</p>
    </div>
    <div class="wn-list" id="wnList">${wnListHTML()}</div>
    <div class="wn-foot">
      <p class="mono">That's everything for ${esc(wnLatestRealTag())}. More on the way — thanks for using Simplex. 🐢</p>
      <button class="btn ghost" data-dash>${svg('back', 14)} Back to dashboard</button>
    </div>
  </div>`;
}

/* the paginated list of updates for the current page + a pager. Re-rendered in
   place (no navigation) when the user opens an update or changes page. */
function wnListHTML() {
  const pages = Math.max(1, Math.ceil(WHATS_NEW.length / WN_PER_PAGE));
  _wnPage = Math.min(Math.max(0, _wnPage), pages - 1);
  const start = _wnPage * WN_PER_PAGE;
  const slice = WHATS_NEW.slice(start, start + WN_PER_PAGE);
  const blocks = slice.map((u, k) => wnUpdate(u, start + k, _wnOpen.has(start + k))).join('');
  return blocks + wnPagerHTML(pages);
}
function wnPagerHTML(pages) {
  if (pages <= 1) return '';
  return `<div class="wn-pager">
    <button class="btn ghost sm" data-wnpage="${_wnPage - 1}" ${_wnPage === 0 ? 'disabled' : ''}>${svg('back', 13)} Newer</button>
    <span class="wn-pageinfo mono">Page ${_wnPage + 1} of ${pages}</span>
    <button class="btn ghost sm" data-wnpage="${_wnPage + 1}" ${_wnPage >= pages - 1 ? 'disabled' : ''}>Older ${svg('chevron-right', 13)}</button>
  </div>`;
}

/* wire clicks for collapse-toggle and pagination. Only the list re-renders, so
   the page never navigates and the header/footer stay put. */
function wireWhatsNew() {
  const list = document.getElementById('wnList');
  if (!list) return;
  list.onclick = (e) => {
    const tog = e.target.closest('[data-wntoggle]');
    if (tog) { const i = +tog.dataset.wntoggle; if (_wnOpen.has(i)) _wnOpen.delete(i); else _wnOpen.add(i); rerenderWnList(); return; }
    const pg = e.target.closest('[data-wnpage]');
    if (pg && !pg.disabled) { _wnPage = +pg.dataset.wnpage; rerenderWnList(); list.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
  };
}
function rerenderWnList() { const list = document.getElementById('wnList'); if (list) list.innerHTML = wnListHTML(); }

/* ---------- Settings app ---------- */
function settingsHTML() {
  const a = ACCOUNT || {};
  const role = a.is_admin ? 'Administrator' : 'Member';
  return `<div class="settings">
    <div class="set-section">
      <span class="eyebrow">Account</span>
      <div class="set-row">
        <div class="sr-main">
          <div class="sr-title">${esc(a.display || a.username || '')}</div>
          <div class="sr-sub mono">${esc(a.username || '')} · ${role}</div>
        </div>
        <button class="btn ghost" id="setAccount">${svg('rename', 14)} Edit profile</button>
      </div>
    </div>
    ${a.is_admin ? `<div class="set-section">
      <span class="eyebrow">Members</span>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Manage accounts</div><div class="sr-sub mono" id="setMembersSub">create, edit &amp; set storage limits</div></div>
        <button class="btn ghost" id="setMembers">${svg('files', 14)} Open</button>
      </div>
    </div>
    <div class="set-section">
      <span class="eyebrow">AI providers</span>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Connect AI (Online)</div><div class="sr-sub mono" id="setAiStatus">xAI key &amp; Cloudflare worker</div></div>
        <button class="btn ghost" id="setAi">${svg('spark', 14)} Configure</button>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Local AI (on-device)</div><div class="sr-sub mono" id="setLocalAiStatus">bundled GGUF engine</div></div>
        <button class="btn ghost" id="setLocalAi">${svg('cpu', 14)} Configure</button>
      </div>
    </div>
    <div class="set-section">
      <span class="eyebrow">Server</span>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Restart server</div><div class="sr-sub mono">applies code/backend changes · everyone is hard-reloaded</div></div>
        <button class="btn ghost" id="setRestart">${svg('refresh', 14)} Restart now</button>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Restart schedule</div><div class="sr-sub mono" id="setSchedSub">automatic weekly restarts</div></div>
        <button class="btn ghost" id="setSchedule">${svg('refresh', 14)} Edit schedule</button>
      </div>
    </div>
    <div class="set-section">
      <span class="eyebrow">Trading</span>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">AI Trader</div><div class="sr-sub mono" id="setTradingSub">symbol universe · live-money switch</div></div>
        <button class="btn ghost" id="setTrading">${svg('trend', 14)} Configure</button>
      </div>
    </div>` : ''}
    <div class="set-section">
      <span class="eyebrow">Appearance</span>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Accent color</div><div class="sr-sub mono">buttons, links &amp; highlights</div></div>
        <div class="swatches" id="setAccent">
          ${ACCENTS.map(a => `<button class="swatch ${(PREFS.accent || null) === a.val ? 'on' : ''}" data-accent="${a.val || ''}" title="${esc(a.name)}" style="--sw:${a.val || 'var(--acc)'}"></button>`).join('')}
          <label class="swatch custom" title="Custom color"><input type="color" id="setAccentCustom" value="${esc(normalizeHex(PREFS.accent) || '#e0a64a')}"></label>
        </div>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Theme</div><div class="sr-sub mono">dark &amp; light color moods — dark is the default</div></div>
        <div class="theme-groups" id="setTheme">
          ${['dark', 'light'].map(mode => `<div class="theme-group"><span class="theme-group-label">${mode}</span><div class="theme-chips">
            ${THEMES.filter(t => t.mode === mode).map(t => `<button class="theme-chip ${(PREFS.theme || 'charcoal') === t.id ? 'on' : ''}" data-theme="${t.id}"><span class="tc-dot" data-th="${t.id}"></span>${esc(t.label)}</button>`).join('')}
          </div></div>`).join('')}
        </div>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Background ambience</div><div class="sr-sub mono">the atmosphere behind everything</div></div>
        <select class="set-select" id="setBgFx">
          ${[['aurora', 'Aurora — drifting glow'], ['fire', 'Fire — live simulation'], ['glow', 'Soft glow'], ['grain', 'Scanlines'], ['none', 'None']].map(([v, l]) => `<option value="${v}" ${(PREFS.bgFx || 'aurora') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Interface font</div><div class="sr-sub mono">app text</div></div>
        <select class="set-select" id="setUiFont">${FONTS.ui.map(f => `<option value="${f.key}" ${(PREFS.uiFont || 'plex') === f.key ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Editor font</div><div class="sr-sub mono">code &amp; monospace</div></div>
        <select class="set-select" id="setMonoFont">${FONTS.mono.map(f => `<option value="${f.key}" ${(PREFS.monoFont || 'plexmono') === f.key ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Default file view</div><div class="sr-sub mono">how the Database opens folders</div></div>
        <div class="seg set-seg" id="setViewSeg">
          <button data-v="grid" class="${viewMode === 'grid' ? 'on' : ''}">Grid</button>
          <button data-v="list" class="${viewMode === 'list' ? 'on' : ''}">List</button>
        </div>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Mini-player dock</div><div class="sr-sub mono">where the music/video player sits</div></div>
        <select class="set-select" id="setPlayerPos">
          ${[['br', 'Bottom right'], ['bl', 'Bottom left'], ['tr', 'Top right'], ['tl', 'Top left']].map(([v, l]) => `<option value="${v}" ${playerPos() === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Interface size</div><div class="sr-sub mono">scale the whole app — text, icons &amp; spacing</div></div>
        <div class="set-slider">
          <input type="range" id="setUiScale" min="70" max="150" step="5" value="${PREFS.uiScale || 100}" />
          <span class="set-slider-val" id="setUiScaleVal">${PREFS.uiScale || 100}%</span>
        </div>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Text size</div><div class="sr-sub mono">extra nudge to reading text in content areas</div></div>
        <div class="set-slider">
          <input type="range" id="setTextScale" min="80" max="140" step="5" value="${PREFS.textScale || 100}" />
          <span class="set-slider-val" id="setTextScaleVal">${PREFS.textScale || 100}%</span>
        </div>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Corner roundness</div><div class="sr-sub mono">from square to very round</div></div>
        <div class="set-slider">
          <input type="range" id="setRoundness" min="0" max="200" step="10" value="${PREFS.roundness == null ? 100 : PREFS.roundness}" />
          <span class="set-slider-val" id="setRoundnessVal">${PREFS.roundness == null ? 100 : PREFS.roundness}%</span>
        </div>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Density</div><div class="sr-sub mono">how tight lists, rows &amp; cards pack together</div></div>
        <div class="seg set-seg" id="setDensity">
          ${[['compact', 'Compact'], ['comfortable', 'Comfortable'], ['roomy', 'Roomy']].map(([v, l]) => `<button data-den="${v}" class="${(PREFS.density || 'comfortable') === v ? 'on' : ''}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Album cover rotation</div><div class="sr-sub mono">how the now-playing cover art spins</div></div>
        <select class="set-select" id="setAlbumSpin">
          ${[['play', 'While playing'], ['always', 'Always'], ['paused', 'Only when paused'], ['never', 'Never']].map(([v, l]) => `<option value="${v}" ${(PREFS.albumSpin || 'play') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Reduce motion</div><div class="sr-sub mono">minimize animations &amp; transitions</div></div>
        <label class="switch" title="Reduce motion"><input type="checkbox" id="setReduceMotion" ${PREFS.reduceMotion ? 'checked' : ''}><span class="switch-track"></span></label>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Reset appearance</div><div class="sr-sub mono">restore all appearance settings to their defaults</div></div>
        <button class="btn ghost" id="setResetAppearance">${svg('refresh', 14)} Reset to defaults</button>
      </div>
      <div class="appr-applybar" id="apprApplyBar" hidden>
        <span class="appr-applybar-note">${svg('info', 14)} You're previewing changes — apply to keep them.</span>
        <div class="appr-applybar-acts">
          <button class="btn ghost sm" id="apprRevert">Revert</button>
          <button class="btn primary sm" id="apprApply">Apply changes</button>
        </div>
      </div>
    </div>
    <div class="set-section" id="setOrgSection">
      <span class="eyebrow">AI Organization</span>
      <div class="set-row">
        <div class="sr-main">
          <div class="sr-title">Smart folder &amp; tag suggestions</div>
          <div class="sr-sub mono">a private model, trained only on your vault, suggests where new files go</div>
        </div>
        <label class="switch" title="Enable AI Organization"><input type="checkbox" id="setOrgEnabled"><span class="switch-track"></span></label>
      </div>
      <div class="org-stats" id="setOrgStats"><div class="org-loading dim mono">${svg('brain', 14)} Loading…</div></div>
      <div class="set-row org-actions" id="setOrgActions" style="display:none">
        <div class="sr-main"><div class="sr-title">Model</div><div class="sr-sub mono" id="setOrgModelSub">train on demand, or reset to start over</div></div>
        <div class="org-btns">
          <button class="btn ghost" id="setOrgTrain">${svg('refresh', 14)} Retrain now</button>
          <button class="btn ghost danger" id="setOrgReset">${svg('trash', 14)} Reset model</button>
        </div>
      </div>
    </div>
    <div class="set-section">
      <span class="eyebrow">Safety</span>
      <div class="set-row saf-bar-row">
        <div class="sr-main">
          <div class="sr-title">Safety level</div>
          <div class="sr-sub mono" id="safDesc">${esc(SAFETY_DESC[ACCOUNT.safety || 'minimal'])}</div>
        </div>
        <div class="safety-bar" id="safetyBar" data-cur="${esc(ACCOUNT.safety || 'minimal')}">
          ${[['minimal', 'Minimal', 'password'], ['moderate', 'Moderate', '+ email'], ['maximum', 'Maximum', '+ two-auth']].map(([v, l, s], i) =>
            `<button class="saf-seg ${SAFETY_RANK[ACCOUNT.safety || 'minimal'] >= i ? 'fill' : ''} ${(ACCOUNT.safety || 'minimal') === v ? 'cur' : ''}" data-lvl="${v}"><b>${l}</b><span>${s}</span></button>`).join('')}
        </div>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Recovery email</div><div class="sr-sub mono">${ACCOUNT.email ? esc(ACCOUNT.email) : 'not set — needed for Moderate & Maximum'}</div></div>
        <button class="btn ghost" id="safEmail">${svg('rename', 14)} ${ACCOUNT.email ? 'Change' : 'Set email'}</button>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Password</div><div class="sr-sub mono">6+ characters, nothing common — no more “1234”</div></div>
        <button class="btn ghost" id="safPw">${svg('key', 14)} Change password</button>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Two-auth</div><div class="sr-sub mono">${ACCOUNT.totp_enabled ? 'on — new devices need a 6-digit code to sign in' : 'off — 6-digit codes from an authenticator app'}</div></div>
        <div class="org-btns">
          ${ACCOUNT.totp_enabled
            ? `<button class="btn ghost" id="safRegen">${svg('refresh', 14)} Regenerate</button><button class="btn ghost danger" id="saf2faOff">Turn off</button>`
            : `<button class="btn primary" id="saf2faOn">${svg('lock', 14)} Set up two-auth</button>`}
        </div>
      </div>
      <div class="set-row">
        <div class="sr-main">
          <div class="sr-title">Encryption keys${ACCOUNT.key_stale ? ' <span class="key-stale-chip">riding your old password</span>' : ''}</div>
          <div class="sr-sub mono" id="safKeysSub">${ACCOUNT.keys_enrolled ? 'checking your vault…' : 'your personal key activates at your next sign-in'}</div>
        </div>
        <div class="org-btns" id="safKeysBtns">
          ${ACCOUNT.keys_enrolled ? `
            ${ACCOUNT.key_stale ? `<button class="btn primary" id="safKeySwap">${svg('key', 14)} Swap key…</button>` : ''}
            <button class="btn ghost" id="safKeyRc">${svg('eye', 14)} View key…</button>
            <button class="btn ghost" id="safKeyMig" style="display:none">${svg('lock', 14)} Re-encrypt vault…</button>
          ` : ''}
        </div>
      </div>
    </div>
    <div class="set-section">
      <span class="eyebrow">Session</span>
      <div class="set-row">
        <div class="sr-main"><div class="sr-title">Sign out</div><div class="sr-sub mono">reloads and returns to the login screen — this device will need two-auth again</div></div>
        <button class="btn ghost" id="setSignout">${svg('lock', 14)} Sign out</button>
      </div>
    </div>
  </div>`;
}
function wireSettings() {
  const ac = document.getElementById('setAccount'); if (ac) ac.onclick = openMyAccount;
  const mb = document.getElementById('setMembers'); if (mb) mb.onclick = openAdminPanel;
  // surface a pending account-request count on the Manage accounts row (admins only)
  if (mb && ACCOUNT && ACCOUNT.is_admin) {
    getSecurity().then(sec => {
      const n = (sec && sec.signups && sec.signups.length) || 0;
      const sub = document.getElementById('setMembersSub');
      if (sub && n) sub.innerHTML = `create, edit &amp; set storage limits · <span style="color:var(--acc)">${n} request${n === 1 ? '' : 's'} pending</span>`;
    }).catch(() => {});
  }
  const so = document.getElementById('setSignout'); if (so) so.onclick = signOut;
  const rs = document.getElementById('setRestart'); if (rs) rs.onclick = confirmRestart;
  const sch = document.getElementById('setSchedule'); if (sch) sch.onclick = openRestartSchedule;
  const schSub = document.getElementById('setSchedSub');
  if (schSub) getRestartSchedule().then(r => { schSub.textContent = restartScheduleSummary(r.schedule); }).catch(() => {});
  const tr = document.getElementById('setTrading'); if (tr) tr.onclick = openTradingConfig;
  const trSub = document.getElementById('setTradingSub');
  if (trSub) tradingAdminConfig().then(c => { trSub.textContent = `${(c.symbols || []).length} symbols · live ${c.liveEnabled ? 'ON' : 'off'}`; }).catch(() => {});
  const seg = document.getElementById('setViewSeg');
  if (seg) seg.querySelectorAll('button').forEach(b => b.onclick = () => {
    viewMode = b.dataset.v; localStorage.setItem('simplex.viewmode', viewMode);
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === viewMode));
    toast('Default view updated', 'check');
  });
  wireAppearanceSettings();
  wireSafetySettings();
  wireKeySettings();
  const aiBtn = document.getElementById('setAi'); if (aiBtn) aiBtn.onclick = openAiConfig;
  const localAiBtn = document.getElementById('setLocalAi'); if (localAiBtn) localAiBtn.onclick = openLocalAiConfig;
  const aiStatus = document.getElementById('setAiStatus');
  const localStatus = document.getElementById('setLocalAiStatus');
  if (aiStatus || localStatus) aiConfigGet().then(c => {
    if (aiStatus) aiStatus.textContent = `Cloudflare ${c.workerUrl ? '✓ ready' : '— not set'} · xAI ${c.xaiKeySet ? '✓ connected' : '— optional key'}`;
    if (localStatus) localStatus.textContent = c.localEngine
      ? `✓ engine ready · ${(c.serverModels || []).length} server model${(c.serverModels || []).length === 1 ? '' : 's'}`
      : '— engine binary not found';
  }).catch(() => {});
  wireOrgSettings();
}

/* ============================================================
   APPEARANCE SETTINGS — staged preview + apply-with-countdown.
   To avoid "wrecking your settings", appearance controls only PREVIEW live; nothing
   is saved until you Apply, which opens a 10s Confirm/Undo dialog that auto-reverts if
   it runs out (like OS display-resolution dialogs). _apprBaseline is the last SAVED
   state we revert to; _apprDraft holds the pending (previewed-but-unsaved) changes. */
let _apprBaseline = null;   // snapshot of the saved appearance prefs when the panel opened
let _apprDraft = null;      // { key: value } pending changes (subset of APPEARANCE_KEYS)

function _apprPreviewPrefs() { return { ...PREFS, ..._apprDraft }; }
function _apprPreview() {
  // apply the previewed prefs to the DOM WITHOUT saving; refresh album-spin too
  applyPrefs(_apprPreviewPrefs());
  if (typeof reflectPlayState === 'function') reflectPlayState();
}
function _apprDirty() { return _apprDraft && Object.keys(_apprDraft).some(k => _apprDraft[k] !== _apprBaseline[k]); }
function _apprUpdateBar() {
  const bar = document.getElementById('apprApplyBar'); if (!bar) return;
  bar.hidden = !_apprDirty();
}
/* stage one appearance change: RECORD it and show the apply bar, but do NOT touch the
   live UI. Nothing changes on screen until Apply is clicked (which previews it under the
   countdown) and Confirmed. This is what makes the apply system meaningful. */
function apprStage(patch) {
  _apprDraft = { ..._apprDraft, ...patch };
  _apprUpdateBar();
}
/* revert the preview back to the last saved state (drops all pending changes). */
function apprRevert() {
  _apprDraft = {};
  applyPrefs(PREFS);   // PREFS is still the saved baseline (we never saved the draft)
  if (typeof reflectPlayState === 'function') reflectPlayState();
  // re-render the panel so every control snaps back to the saved values
  openAppScreen({ id: 'settings', name: 'Settings', icon: 'gear' }, settingsHTML()); wireSettings();
}

function wireAppearanceSettings() {
  _apprBaseline = {}; for (const k of APPEARANCE_KEYS) _apprBaseline[k] = PREFS[k];
  _apprDraft = {};

  const accBox = document.getElementById('setAccent');
  if (accBox) accBox.querySelectorAll('[data-accent]').forEach(b => b.onclick = () => {
    apprStage({ accent: b.dataset.accent || null });
    accBox.querySelectorAll('.swatch').forEach(x => x.classList.remove('on')); b.classList.add('on');
  });
  const accCustom = document.getElementById('setAccentCustom');
  if (accCustom) accCustom.oninput = () => { apprStage({ accent: accCustom.value }); accBox && accBox.querySelectorAll('.swatch').forEach(x => x.classList.remove('on')); };
  const thBox = document.getElementById('setTheme');
  if (thBox) thBox.querySelectorAll('[data-theme]').forEach(b => b.onclick = () => {
    apprStage({ theme: b.dataset.theme });
    thBox.querySelectorAll('.theme-chip').forEach(x => x.classList.toggle('on', x === b));
  });
  const uiF = document.getElementById('setUiFont'); if (uiF) uiF.onchange = () => apprStage({ uiFont: uiF.value });
  const moF = document.getElementById('setMonoFont'); if (moF) moF.onchange = () => apprStage({ monoFont: moF.value });
  const uiSc = document.getElementById('setUiScale'), uiScV = document.getElementById('setUiScaleVal');
  if (uiSc) uiSc.oninput = () => { const v = +uiSc.value; if (uiScV) uiScV.textContent = v + '%'; apprStage({ uiScale: v }); };
  const txSc = document.getElementById('setTextScale'), txScV = document.getElementById('setTextScaleVal');
  if (txSc) txSc.oninput = () => { const v = +txSc.value; if (txScV) txScV.textContent = v + '%'; apprStage({ textScale: v }); };
  const rnd = document.getElementById('setRoundness'), rndV = document.getElementById('setRoundnessVal');
  if (rnd) rnd.oninput = () => { const v = +rnd.value; if (rndV) rndV.textContent = v + '%'; apprStage({ roundness: v }); };
  const den = document.getElementById('setDensity');
  if (den) den.querySelectorAll('[data-den]').forEach(b => b.onclick = () => { apprStage({ density: b.dataset.den }); den.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
  const asp = document.getElementById('setAlbumSpin'); if (asp) asp.onchange = () => apprStage({ albumSpin: asp.value });
  const bfx = document.getElementById('setBgFx'); if (bfx) bfx.onchange = () => apprStage({ bgFx: bfx.value });
  const rm = document.getElementById('setReduceMotion'); if (rm) rm.onchange = () => apprStage({ reduceMotion: rm.checked });

  // "Reset to defaults" stages the defaults as a preview (still needs Apply to keep).
  const resetA = document.getElementById('setResetAppearance');
  if (resetA) resetA.onclick = () => {
    const defaults = {}; for (const k of APPEARANCE_KEYS) defaults[k] = DEFAULT_PREFS[k];
    _apprDraft = defaults;
    _apprPreview();
    // re-render so controls show the default values, then re-open the bar
    openAppScreen({ id: 'settings', name: 'Settings', icon: 'gear' }, settingsHTML());
    // preserve the draft across the re-render
    const draft = { ...defaults };
    wireSettings();
    _apprDraft = draft; _apprPreview(); _apprUpdateBar();
    toast('Previewing defaults — apply to keep', 'info');
  };

  const applyBtn = document.getElementById('apprApply');
  if (applyBtn) applyBtn.onclick = () => { if (_apprDirty()) apprConfirmDialog(); };
  const revertBtn = document.getElementById('apprRevert');
  if (revertBtn) revertBtn.onclick = apprRevert;

  // leaving Settings with an un-applied preview drops it (the saved look is restored).
  _appCleanup = () => {
    if (_apprDraft && Object.keys(_apprDraft).length) { _apprDraft = {}; applyPrefs(PREFS); if (typeof reflectPlayState === 'function') reflectPlayState(); }
  };

  _apprUpdateBar();
}

/* the countdown Confirm/Undo dialog. Opening it APPLIES the staged changes to the live
   UI so you can see them during the countdown (like OS display dialogs — change first,
   then "keep it?"). Confirm persists; Undo, backdrop, or the timer running out reverts. */
function apprConfirmDialog() {
  _apprPreview();   // NOW the interface actually changes — user judges it under the timer
  const SECONDS = 12;
  let left = SECONDS, timer = null;
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal appr-confirm">
    <div class="appr-confirm-ring"><svg viewBox="0 0 44 44"><circle class="appr-ring-bg" cx="22" cy="22" r="19"/><circle class="appr-ring-fg" id="apprRing" cx="22" cy="22" r="19"/></svg><span id="apprCount">${SECONDS}</span></div>
    <h3>Keep these display settings?</h3>
    <p>Your appearance will revert automatically if you don't confirm — in case something looks wrong.</p>
    <div class="acts"><button class="btn ghost" data-undo>Undo</button><button class="btn primary" data-confirm>Confirm</button></div>
  </div>`;
  document.body.appendChild(bg);
  const ring = bg.querySelector('#apprRing');
  const countEl = bg.querySelector('#apprCount');
  const circ = 2 * Math.PI * 19;
  if (ring) { ring.style.strokeDasharray = circ.toFixed(1); ring.style.strokeDashoffset = '0'; }

  const cleanup = () => { if (timer) clearInterval(timer); timer = null; bg.remove(); };
  const confirm = () => {
    cleanup();
    setPrefs({ ..._apprDraft });   // persist the pending changes (also re-applies)
    _apprBaseline = {}; for (const k of APPEARANCE_KEYS) _apprBaseline[k] = PREFS[k];
    _apprDraft = {};
    _apprUpdateBar();
    toast('Appearance saved', 'check');
  };
  const undo = () => {
    cleanup();
    apprRevert();   // drops the draft, restores saved prefs, re-renders the panel
    toast('Changes reverted', 'info');
  };
  bg.querySelector('[data-confirm]').onclick = confirm;
  bg.querySelector('[data-undo]').onclick = undo;
  // don't let a stray backdrop click confirm OR silently dismiss — treat it as undo
  bg.onclick = e => { if (e.target === bg) undo(); };

  const t0 = Date.now();
  timer = setInterval(() => {
    const elapsed = (Date.now() - t0) / 1000;
    left = Math.max(0, SECONDS - elapsed);
    if (countEl) countEl.textContent = Math.ceil(left);
    if (ring) ring.style.strokeDashoffset = (circ * (1 - left / SECONDS)).toFixed(1);
    if (left <= 0) undo();
  }, 100);
}

/* ---- AI Organization settings (enable, live stats, retrain, reset) ---- */
let _orgPollTimer = null;
function _orgFmtWhen(ts) {
  if (!ts) return 'never';
  const d = new Date(ts), now = Date.now(), diff = now - ts;
  if (diff < 60e3) return 'just now';
  if (diff < 3600e3) { const m = Math.round(diff / 60e3); return m + ' min ago'; }
  if (diff < 864e5 && d.getDate() === new Date().getDate()) return 'today ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function renderOrgStats(s) {
  const box = document.getElementById('setOrgStats');
  const actions = document.getElementById('setOrgActions');
  const toggle = document.getElementById('setOrgEnabled');
  if (!box) return;
  if (toggle) toggle.checked = !!s.enabled;
  if (actions) actions.style.display = s.enabled ? '' : 'none';
  if (!s.enabled) {
    box.innerHTML = `<div class="org-off dim mono">${svg('brain', 14)} Off — no training or suggestions. Your model and data are preserved.</div>`;
    return;
  }
  const acc = s.accuracy == null ? '—' : Math.round(s.accuracy * 100) + '%';
  const trainingNote = s.training ? `<span class="org-badge">${svg('refresh', 11)} training…</span>` : '';
  const thr = Math.round((s.threshold == null ? 0.6 : s.threshold) * 100);
  const tiers = s.availableTiers || [{ id: 'small', label: 'Small' }];
  const tierBlurb = { small: 'Lightweight — fast, low resource use. Learns from names, types & a small content peek.', medium: 'Reads more of each file for better quality. A bit more training time.', high: 'Reads most files in full for the most accurate results. Heaviest on resources.' };
  const curTier = s.tier || 'small';
  box.innerHTML = `
    <div class="org-grid">
      <div class="org-stat"><span class="os-k">Accuracy</span><span class="os-v">${acc}</span></div>
      <div class="org-stat"><span class="os-k">Training data</span><span class="os-v">${fmtSize(s.datasetBytes)}</span></div>
      <div class="org-stat"><span class="os-k">Files trained</span><span class="os-v">${s.fileCount || 0}</span></div>
      <div class="org-stat"><span class="os-k">Last trained</span><span class="os-v">${esc(_orgFmtWhen(s.lastTrained))}</span></div>
    </div>
    <div class="org-thresh">
      <div class="ot-head"><span class="ot-title">Organizer scale</span></div>
      <div class="seg org-tierseg" id="setOrgTier">
        ${tiers.map(t => `<button data-tier="${esc(t.id)}" class="${t.id === curTier ? 'on' : ''}">${esc(t.label)}</button>`).join('')}
      </div>
      <div class="ot-sub mono dim" id="setOrgTierBlurb">${esc(tierBlurb[curTier] || '')}${s.maxTier && s.maxTier !== 'high' ? ' · higher scales are admin-granted' : ''}</div>
    </div>
    <div class="org-thresh">
      <div class="ot-head">
        <span class="ot-title">Confidence threshold</span>
        <span class="ot-val mono" id="setOrgThreshVal">${thr}%</span>
      </div>
      <input type="range" id="setOrgThresh" class="org-slider" min="5" max="95" step="5" value="${thr}">
      <div class="ot-sub mono dim">Only show (and apply) folder &amp; tag suggestions at or above this confidence.</div>
    </div>
    <div class="org-foot mono dim">${s.eligibleFiles || 0} eligible file${s.eligibleFiles === 1 ? '' : 's'} in your vault · encrypted &amp; locked files are excluded ${trainingNote}</div>`;
  // wire the tier segmented control (changing scale rebuilds the model)
  const tierSeg = document.getElementById('setOrgTier');
  if (tierSeg) tierSeg.querySelectorAll('[data-tier]').forEach(b => b.onclick = () => {
    const t = b.dataset.tier; if (t === (s.tier || 'small')) return;
    tierSeg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    const blurb = document.getElementById('setOrgTierBlurb'); if (blurb) blurb.textContent = tierBlurb[t] || '';
    organizerSetTier(t).then(rs => {
      toast(`Organizer scale set to ${(tiers.find(x => x.id === t) || {}).label || t} — retraining`, 'brain');
      renderOrgStats(rs); _orgStartPolling();
    }).catch(() => { toast('Could not change scale', 'close'); renderOrgStats(s); });
  });
  // wire the slider (re-wired on each render since the markup is regenerated)
  const slider = document.getElementById('setOrgThresh'), valEl = document.getElementById('setOrgThreshVal');
  if (slider) {
    slider.oninput = () => { if (valEl) valEl.textContent = slider.value + '%'; };
    slider.onchange = () => {
      const t = Math.max(0.05, Math.min(0.95, (+slider.value) / 100));
      organizerSetThreshold(t).then(() => toast(`Confidence threshold set to ${Math.round(t * 100)}%`, 'check'))
        .catch(() => toast('Could not update threshold', 'close'));
    };
  }
}
function wireOrgSettings() {
  if (_orgPollTimer) { clearInterval(_orgPollTimer); _orgPollTimer = null; }
  const toggle = document.getElementById('setOrgEnabled');
  if (!toggle) return;
  const load = () => organizerStatus().then(renderOrgStats).catch(() => {
    const box = document.getElementById('setOrgStats'); if (box) box.innerHTML = `<div class="org-off dim mono">Couldn't load AI Organization status.</div>`;
  });
  load();
  toggle.onchange = () => {
    const on = toggle.checked;
    organizerSetEnabled(on).then(s => {
      renderOrgStats(s);
      toast(on ? 'AI Organization on — learning from your vault' : 'AI Organization turned off', on ? 'brain' : 'lock');
      if (on && !s.lastTrained) _orgStartPolling();   // initial pass kicked off server-side
    }).catch(() => { toggle.checked = !on; toast('Could not update setting', 'close'); });
  };
  const trainBtn = document.getElementById('setOrgTrain');
  if (trainBtn) trainBtn.onclick = () => {
    trainBtn.disabled = true;
    organizerTrain().then(() => { toast('Retraining started…', 'refresh'); _orgStartPolling(); })
      .catch(e => toast(e && e.status === 400 ? 'AI Organization is off' : 'Could not start training', 'close'))
      .finally(() => { setTimeout(() => { trainBtn.disabled = false; }, 1500); });
  };
  const resetBtn = document.getElementById('setOrgReset');
  if (resetBtn) resetBtn.onclick = () => confirmModal(
    'Reset the AI model?',
    'This deletes the learned model and all stored suggestions. Your files, folders, and tags are NOT affected. The model will retrain from scratch the next time it runs.',
    () => organizerReset().then(() => { toast('Model reset', 'check'); load(); }).catch(() => toast('Reset failed', 'close')),
    'Reset',
  );
}
/* poll status until a background training pass finishes, then stop. */
function _orgStartPolling() {
  if (_orgPollTimer) clearInterval(_orgPollTimer);
  let ticks = 0;
  _orgPollTimer = setInterval(() => {
    ticks++;
    organizerStatus().then(s => {
      renderOrgStats(s);
      if (!s.training && (s.lastTrained || ticks > 3)) { clearInterval(_orgPollTimer); _orgPollTimer = null; }
      if (ticks > 40) { clearInterval(_orgPollTimer); _orgPollTimer = null; }   // safety stop
    }).catch(() => { clearInterval(_orgPollTimer); _orgPollTimer = null; });
  }, 1500);
}

/* admin: configure AI providers. The Cloudflare worker is open (no creds); xAI just
   needs an API key. The key is write-only — encrypted server-side, never returned. */
async function openAiConfig() {
  let c = {}; try { c = await aiConfigGet(); } catch (e) {}
  formModal({
    title: 'AI providers',
    desc: 'Cloudflare models work out of the box via the worker. Add an xAI key to enable Grok. The key is encrypted on the server and never sent back — leave it blank to keep the current one.',
    extraClass: 'account-modal',
    fields: [
      { key: 'workerUrl', label: 'Cloudflare worker URL', value: c.workerUrl || '' },
      { key: 'xaiKey', label: `xAI API key ${c.xaiKeySet ? '(connected — blank keeps it)' : '(optional — enables Grok)'}`, type: 'password', placeholder: c.xaiKeySet ? '••••••••' : 'xai-…', attrs: 'autocomplete="off"' },
    ],
    okLabel: 'Save',
    onSubmit: async (vals, close) => {
      const payload = {};
      if (vals.workerUrl !== undefined && vals.workerUrl.trim() !== (c.workerUrl || '')) payload.workerUrl = vals.workerUrl.trim();
      if (vals.xaiKey) payload.xaiKey = vals.xaiKey;
      await aiConfigSet(payload);
      close(); toast('AI providers updated', 'check'); reopenSettingsIfOpen();
    },
  });
}
/* admin: configure the Local AI engine — the bundled, on-device GGUF runner. The
   only setting is which server folder holds the pre-loaded .gguf models; the
   engine binary ships with the app. (Users also get their own uploaded .gguf
   files automatically — no config needed for those.) */
async function openLocalAiConfig() {
  let c = {}; try { c = await aiConfigGet(); } catch (e) {}
  const sm = c.serverModels || [];
  const list = c.localEngine
    ? (sm.length
        ? '<ul class="la-models">' + sm.map(m => `<li>${svg('cpu', 13)} <span>${esc(m.name)}</span> <span class="dim mono">${esc(m.file)} · ${fmtSize(m.size || 0)}</span></li>`).join('') + '</ul>'
        : '<div class="dim mono" style="margin:4px 0 2px">No .gguf files in the models folder yet.</div>')
    : '<div class="dim mono" style="margin:4px 0 2px">⚠ Engine binary not found in engine/bin — local models are unavailable.</div>';

  const t = c.thermal || {};
  const th = t.thresholds || {};
  const tripC = Number.isFinite(th.tripC) ? th.tripC : 90;
  const resumeC = Number.isFinite(th.resumeC) ? th.resumeC : 75;

  formModal({
    title: 'Local AI engine',
    desc: 'Runs language models entirely on this server with no external services. Drop <code>.gguf</code> files into the models folder below; users can also use <code>.gguf</code> files from their own Database.',
    descHtml: true,
    extraClass: 'account-modal',
    bodyHtml: `
      <div class="la-status">${list}</div>
      <div class="la-thermal">
        <div class="lat-head"><span class="eyebrow">Temperature safety net</span>${laThermalBadge(t)}</div>
        <div class="lat-gauge" id="latGauge">${laThermalGaugeHTML(t)}</div>
        <p class="lat-note dim">If the CPU stays at/above the <b>trip</b> temperature, local AI is stopped and paused for 5 minutes so the machine can cool. It resumes once the temperature falls back below the <b>resume</b> temperature.${t.tripped ? ' <button type="button" class="lat-reset" id="latReset">Resume now</button>' : ''}</p>
      </div>`,
    fields: [
      { key: 'modelsDir', label: 'Server models folder', value: c.modelsDir || '', placeholder: 'models' },
      { key: 'thermalTripC', label: 'Trip temperature (°C) — stop local AI at/above this', type: 'number', value: String(tripC), attrs: 'min="40" max="110" step="1"' },
      { key: 'thermalResumeC', label: 'Resume temperature (°C) — must be below the trip temp', type: 'number', value: String(resumeC), attrs: 'min="30" max="105" step="1"' },
    ],
    okLabel: 'Save',
    onSubmit: async (vals, close) => {
      const payload = {};
      if (vals.modelsDir !== undefined && vals.modelsDir.trim() !== (c.modelsDir || '')) payload.modelsDir = vals.modelsDir.trim();
      const nTrip = parseFloat(vals.thermalTripC), nResume = parseFloat(vals.thermalResumeC);
      if (Number.isFinite(nTrip) && nTrip !== tripC) payload.thermalTripC = nTrip;
      if (Number.isFinite(nResume) && nResume !== resumeC) payload.thermalResumeC = nResume;
      if (Number.isFinite(nTrip) && Number.isFinite(nResume) && nResume >= nTrip) { throw new Error('Resume temperature must be below the trip temperature.'); }
      await aiConfigSet(payload);
      close(); toast('Local AI updated', 'check'); reopenSettingsIfOpen();
    },
  });

  // wire the "Resume now" override + start a light live-temperature refresh while open
  const resetBtn = document.getElementById('latReset');
  if (resetBtn) resetBtn.onclick = async () => { try { await aiLocalThermalReset(); toast('Thermal trip cleared', 'check'); } catch (e) {} const bg = resetBtn.closest('.modal-bg'); if (bg) bg.remove(); openLocalAiConfig(); };
  laThermalLiveRefresh();
}

/* admin: configure the global AI Trader. Sets the symbol universe the model trades,
   the data source, and the LIVE-money master switch (off by default — while off, no
   account can place real orders regardless of their own opt-in). The model itself is
   global and trains automatically; "Kick now" forces an immediate data+train pass. */
async function openTradingConfig() {
  let c = {}; try { c = await tradingAdminConfig(); } catch (e) {}
  const m = c.model || null;
  const status = m
    ? `Model: ${m.valAcc != null ? (m.valAcc * 100).toFixed(1) + '% val acc' : 'warming up'} · ${(m.trainedSteps || 0).toLocaleString()} rounds · data for ${(c.cachedSymbols || []).length}/${(c.symbols || []).length} symbols`
    : 'Model has not trained yet — kick a data+train pass to start.';
  const bg = formModal({
    title: 'AI Trader',
    desc: 'One global model trades for every account and trains continuously in the background. Set the symbols it trades below. Live trading lets members connect their own brokerage and use real money — it is OFF by default.',
    extraClass: 'account-modal',
    bodyHtml: `
      <div class="tr-adminstatus mono dim">${svg('brain', 13)} ${esc(status)} <button type="button" class="btn ghost sm" id="trAdminKick">${svg('refresh', 13)} Kick now</button></div>
      <div class="tr-adminmodel" id="trAdminModel">${tradingAdminModelHTML(c)}</div>
      <label class="tr-adminswitch"><input type="checkbox" id="trAdminLive" ${c.liveEnabled ? 'checked' : ''}/> <span><b>Enable live trading on this server</b> — allow members to trade real money via their own brokerage. Leave off to keep everyone in the sandbox.</span></label>`,
    fields: [
      { key: 'symbols', label: 'Symbols (comma-separated tickers)', value: (c.symbols || []).join(', '), placeholder: 'SPY, QQQ, AAPL, BTC-USD' },
    ],
    okLabel: 'Save',
    onSubmit: async (vals, close) => {
      const live = bg.querySelector('#trAdminLive');
      await tradingAdminSaveConfig({ symbols: vals.symbols || '', liveEnabled: live ? live.checked : false });
      close(); toast('Trading settings saved', 'check'); reopenSettingsIfOpen();
    },
  });
  const kick = bg.querySelector('#trAdminKick');
  if (kick) kick.onclick = async () => {
    kick.disabled = true; toast('Fetching data & training…');
    try { await tradingAdminKick(); toast('Model kicked', 'check'); await trAdminRefreshModel(bg); } catch (e) { toast('Kick failed', 'close'); }
    kick.disabled = false;
  };
  wireTradingAdminModel(bg);
}

// the model-lifecycle block (usable badge + Reset + Approve/Revoke). Reused on refresh.
function tradingAdminModelHTML(c) {
  const rounds = (c.model && c.model.trainedSteps) || 0;
  const minR = c.minRounds || 100;
  const usable = !!c.liveUsable;
  const approved = !!c.approved;
  const badge = usable
    ? `<span class="tr-mbadge ok">${svg('check', 12)} Usable for live</span>`
    : `<span class="tr-mbadge bad">${svg('lock', 12)} Not live-usable</span>`;
  const reason = c.blockReason ? `<div class="tr-mreason">${esc(c.blockReason)}</div>` : '';
  const progress = Math.min(100, Math.round((rounds / minR) * 100));
  const canApprove = rounds >= minR;
  return `
    <div class="tr-mhead">${badge}<span class="tr-mrounds mono">${rounds.toLocaleString()}/${minR} rounds</span></div>
    <div class="tr-mtrack"><i style="width:${progress}%"></i></div>
    ${reason}
    <div class="tr-macts">
      <button type="button" class="btn ghost sm danger" id="trResetModel">${svg('trash', 13)} Reset model</button>
      ${approved
        ? `<button type="button" class="btn ghost sm" id="trRevokeModel">${svg('lock', 13)} Revoke approval</button>`
        : `<button type="button" class="btn sm" id="trApproveModel" ${canApprove ? '' : 'disabled title="needs more training rounds first"'}>${svg('check', 13)} Mark usable</button>`}
    </div>`;
}
async function trAdminRefreshModel(bg) {
  let c = {}; try { c = await tradingAdminConfig(); } catch (e) { return; }
  const box = bg.querySelector('#trAdminModel');
  if (box) { box.innerHTML = tradingAdminModelHTML(c); wireTradingAdminModel(bg); }
  // also refresh the one-line status row
  const statusRow = bg.querySelector('.tr-adminstatus');
  if (statusRow && c.model) {
    const m = c.model;
    const txt = `Model: ${m.valAcc != null ? (m.valAcc * 100).toFixed(1) + '% val acc' : 'warming up'} · ${(m.trainedSteps || 0).toLocaleString()} rounds · data for ${(c.cachedSymbols || []).length}/${(c.symbols || []).length} symbols`;
    const span = statusRow.childNodes; // keep the kick button; just replace the text node
    statusRow.firstChild && (statusRow.innerHTML = `${svg('brain', 13)} ${esc(txt)} <button type="button" class="btn ghost sm" id="trAdminKick">${svg('refresh', 13)} Kick now</button>`);
    const kick = statusRow.querySelector('#trAdminKick');
    if (kick) kick.onclick = async () => { kick.disabled = true; toast('Fetching data & training…'); try { await tradingAdminKick(); toast('Model kicked', 'check'); await trAdminRefreshModel(bg); } catch (e) { toast('Kick failed', 'close'); } kick.disabled = false; };
  }
}
function wireTradingAdminModel(bg) {
  const reset = bg.querySelector('#trResetModel');
  if (reset) reset.onclick = () => confirmModal(
    'Reset the global model?',
    'This wipes the shared AI model back to a fresh, untrained network for EVERYONE. It will immediately stop being usable for live trading until it has retrained at least 100 rounds AND you mark it usable again. Sandbox simulations keep working. This cannot be undone.',
    async () => { try { await tradingAdminResetModel(); toast('Model reset', 'check'); await trAdminRefreshModel(bg); } catch (e) { toast('Reset failed', 'close'); } },
    'Reset model'
  );
  const approve = bg.querySelector('#trApproveModel');
  if (approve) approve.onclick = () => confirmModal(
    'Mark the model usable for live?',
    'This approves the current model for REAL-money live trading by members who have opted in. Only do this after reviewing its sandbox performance and being satisfied it is good enough. You can revoke this at any time.',
    async () => { try { await tradingAdminApproveModel(true); toast('Model approved for live', 'check'); await trAdminRefreshModel(bg); } catch (e) { toast((e && e.error) || 'Could not approve', 'close'); } },
    'Mark usable'
  );
  const revoke = bg.querySelector('#trRevokeModel');
  if (revoke) revoke.onclick = async () => {
    try { await tradingAdminApproveModel(false); toast('Approval revoked', 'check'); await trAdminRefreshModel(bg); } catch (e) { toast('Could not revoke', 'close'); }
  };
}

/* small colored badge summarizing the current thermal state */
function laThermalBadge(t) {
  if (!t || t.supported === false) return `<span class="lat-badge unknown">no sensor</span>`;
  if (t.tripped) { const m = Math.max(1, Math.ceil((t.cooldownRemainingMs || 0) / 60000)); return `<span class="lat-badge hot">cooling · ${m} min</span>`; }
  return `<span class="lat-badge ok">normal</span>`;
}
/* live temperature gauge: current °C vs the trip threshold */
function laThermalGaugeHTML(t) {
  const th = (t && t.thresholds) || {};
  const trip = Number.isFinite(th.tripC) ? th.tripC : 90;
  if (!t || t.tempC == null) return `<div class="lat-temp dim mono">temperature unavailable on this machine</div>`;
  const temp = Math.round(t.tempC);
  const pct = Math.max(4, Math.min(100, Math.round((t.tempC / trip) * 100)));
  const cls = t.tempC >= trip ? 'hot' : t.tempC >= (th.resumeC || 75) ? 'warm' : 'cool';
  return `<div class="lat-temp"><b class="lat-deg ${cls}">${temp}°C</b><span class="dim mono">trip at ${trip}°C · resume ${Number.isFinite(th.resumeC) ? th.resumeC : 75}°C</span></div>
    <div class="lat-bar"><i class="${cls}" style="width:${pct}%"></i><span class="lat-trip" style="left:100%"></span></div>`;
}
/* refresh the gauge in the open modal every few seconds (cleared when modal closes) */
function laThermalLiveRefresh() {
  const tick = async () => {
    const gauge = document.getElementById('latGauge');
    if (!gauge || !document.body.contains(gauge)) return;   // modal closed → stop
    try { const s = await aiLocalStatus(); gauge.innerHTML = laThermalGaugeHTML(s.thermal || {}); } catch (e) {}
    if (document.body.contains(gauge)) setTimeout(tick, 5000);
  };
  setTimeout(tick, 5000);
}
/* admin: manual server restart. Confirms, fires the request, then lets the gate
   take over (the server reports restarting:true and our own poll/status flow
   raises the overlay for everyone, including this admin). */
function confirmRestart() {
  if (!ACCOUNT || !ACCOUNT.is_admin) return;
  confirmModal(
    'Restart the server?',
    'This restarts the backend to apply any code or backend changes. Everyone currently on the site sees a "restarting" screen and is automatically reloaded when it comes back (a few seconds). Uploads or runs in progress will be interrupted.',
    async () => {
      try {
        const r = await requestRestart();
        toast('Restarting the server…', 'refresh');
        // Raise the gate locally right away rather than waiting for the next poll.
        RestartGate.onRestartingPayload(r);
      } catch (e) {
        toast(e && e.status === 403 ? 'Admins only' : 'Restart failed — try again', 'info');
      }
    },
    'Restart',
  );
}
/* ---- scheduled-restart editor (admin) ---- */
const _DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const _DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/* "HH:MM" (24h) -> "9:00 AM" for display */
function fmt12h(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); if (!m) return t || '';
  let h = +m[1]; const mm = m[2]; const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${mm} ${ap}`;
}
function restartScheduleSummary(sched) {
  if (!sched || !sched.enabled) return 'automatic restarts off';
  if (!sched.slots || !sched.slots.length) return 'no times set';
  return sched.slots.slice().sort((a, b) => a.day - b.day || a.time.localeCompare(b.time))
    .map(s => `${_DOW[s.day]} ${fmt12h(s.time)}`).join(' · ');
}
/* admin: open the weekly restart-schedule editor. A list of day+time rows the admin
   can add to / remove, plus a master on/off toggle. Saves via PATCH. */
async function openRestartSchedule() {
  if (!ACCOUNT || !ACCOUNT.is_admin) return;
  let sched;
  try { sched = (await getRestartSchedule()).schedule; }
  catch (e) { toast(e && e.status === 403 ? 'Admins only' : 'Could not load schedule', 'close'); return; }
  // working copy
  let enabled = sched.enabled !== false;
  let slots = (sched.slots || []).map(s => ({ day: s.day, time: s.time }));

  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal sched-modal">
    <h3>Automatic restart schedule</h3>
    <p>The server restarts automatically at these times (server's local time) to apply changes. Everyone on the site sees the restart screen and is reloaded when it's back. Admins can still restart manually any time.</p>
    <label class="sched-enable"><input type="checkbox" id="schEnabled" ${enabled ? 'checked' : ''}> <span>Enable automatic restarts</span></label>
    <div class="sched-rows" id="schRows"></div>
    <button class="btn ghost sm" id="schAdd">+ Add a time</button>
    <div class="acts">
      <button class="btn ghost" data-cancel>Cancel</button>
      <button class="btn primary" id="schSave">Save schedule</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  const rowsEl = bg.querySelector('#schRows');
  const enabledEl = bg.querySelector('#schEnabled');

  const renderRows = () => {
    if (!slots.length) { rowsEl.innerHTML = `<div class="sched-empty dim mono">No times — the server won't auto-restart.</div>`; return; }
    rowsEl.innerHTML = slots.map((s, i) => `
      <div class="sched-row" data-i="${i}">
        <select class="set-select sched-day" data-i="${i}">
          ${_DOW_FULL.map((d, di) => `<option value="${di}" ${di === s.day ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
        <input type="time" class="set-select sched-time" data-i="${i}" value="${esc(s.time)}">
        <button class="iconbtn sched-del" data-i="${i}" title="Remove">${svg('trash', 15)}</button>
      </div>`).join('');
    rowsEl.querySelectorAll('.sched-day').forEach(sel => sel.onchange = () => { slots[+sel.dataset.i].day = +sel.value; });
    rowsEl.querySelectorAll('.sched-time').forEach(inp => inp.onchange = () => { if (inp.value) slots[+inp.dataset.i].time = inp.value; });
    rowsEl.querySelectorAll('.sched-del').forEach(b => b.onclick = () => { slots.splice(+b.dataset.i, 1); renderRows(); });
  };
  renderRows();

  bg.querySelector('#schAdd').onclick = () => { slots.push({ day: 1, time: '09:00' }); renderRows(); };
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('#schSave').onclick = async () => {
    const payload = { enabled: enabledEl.checked, slots };
    try {
      const r = await setRestartSchedule(payload);
      close();
      toast('Restart schedule saved', 'check');
      const sub = document.getElementById('setSchedSub');
      if (sub) sub.textContent = restartScheduleSummary(r.schedule);
    } catch (e) {
      toast(e && e.status === 403 ? 'Admins only' : 'Could not save schedule', 'close');
    }
  };
}

/* re-render the Settings body in place (e.g. after a profile edit changed the name) */
function reopenSettingsIfOpen() {
  if (currentApp !== 'settings') return;
  const app = APPS.find(a => a.id === 'settings');
  openAppScreen(app, settingsHTML()); wireSettings();
}

/* ============================================================
   APPEARANCE / THEMING — per-account prefs applied via CSS variables
   ============================================================ */
const ACCENTS = [
  { name: 'Amber (default)', val: null },
  { name: 'Blue', val: '#5aa9e6' }, { name: 'Green', val: '#7ed957' },
  { name: 'Coral', val: '#e6685a' }, { name: 'Violet', val: '#b07ee6' },
  { name: 'Teal', val: '#46c2b6' }, { name: 'Pink', val: '#e6a0c4' },
  { name: 'Crimson', val: '#d9506b' }, { name: 'Ice', val: '#a8cbe8' }, { name: 'Sage', val: '#9fbf8f' },
];
const THEMES = [
  { id: 'charcoal', label: 'Warm charcoal', mode: 'dark' }, { id: 'slate', label: 'Cool slate', mode: 'dark' },
  { id: 'midnight', label: 'Midnight', mode: 'dark' }, { id: 'contrast', label: 'High contrast', mode: 'dark' },
  { id: 'daylight', label: 'Daylight', mode: 'light' }, { id: 'frost', label: 'Frost', mode: 'light' },
];
/* mobile browser chrome color per theme (meta theme-color, updated by applyPrefs) */
const THEME_CHROME = {
  charcoal: '#221f1b', slate: '#20242c', midnight: '#191c2c', contrast: '#101010',
  daylight: '#f2eee4', frost: '#eef2f7',
};
const FONTS = {
  ui: [
    { key: 'plex', label: 'IBM Plex Sans', stack: '"IBM Plex Sans", -apple-system, system-ui, sans-serif' },
    { key: 'inter', label: 'Inter', stack: '"Inter", -apple-system, system-ui, sans-serif' },
    { key: 'grotesk', label: 'Space Grotesk', stack: '"Space Grotesk", "IBM Plex Sans", system-ui, sans-serif' },
    { key: 'system', label: 'System UI', stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif' },
  ],
  mono: [
    { key: 'plexmono', label: 'IBM Plex Mono', stack: '"IBM Plex Mono", ui-monospace, Menlo, monospace' },
    { key: 'jetbrains', label: 'JetBrains Mono', stack: '"JetBrains Mono", ui-monospace, Menlo, monospace' },
    { key: 'fira', label: 'Fira Code', stack: '"Fira Code", ui-monospace, Menlo, monospace' },
    { key: 'system', label: 'System Mono', stack: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  ],
};
const DEFAULT_PREFS = {
  accent: null, theme: 'charcoal', uiFont: 'plex', monoFont: 'plexmono',
  playerPos: 'br', fadeEnabled: false, fadeSeconds: 3, eq: null,
  musicQuality: 'lossless', // Music app streaming quality: 'low' | 'medium' | 'high' | 'lossless'
  // ---- appearance customization ----
  uiScale: 100,          // overall interface size, % (fonts + icons + spacing)
  textScale: 100,        // extra nudge to text size, %
  albumSpin: 'play',     // 'play' | 'always' | 'paused' | 'never' — now-playing cover rotation
  reduceMotion: false,   // reduce/disable animations & transitions
  density: 'comfortable',// 'compact' | 'comfortable' | 'roomy'
  roundness: 100,        // corner roundness, % of the default radius (0 = square, 200 = very round)
  bgFx: 'aurora',        // background ambience: 'aurora' | 'glow' | 'grain' | 'none'
};
const APPEARANCE_KEYS = ['accent', 'theme', 'uiFont', 'monoFont', 'uiScale', 'textScale', 'albumSpin', 'reduceMotion', 'density', 'roundness', 'bgFx'];
function loadPrefsLocal() { try { return JSON.parse(localStorage.getItem('simplex.prefs')) || {}; } catch (e) { return {}; } }
function savePrefsLocal() { try { localStorage.setItem('simplex.prefs', JSON.stringify(PREFS)); } catch (e) {} }
let PREFS = { ...DEFAULT_PREFS, ...loadPrefsLocal() };

function normalizeHex(h) { if (!h) return null; h = String(h).trim(); return /^#?[0-9a-fA-F]{6}$/.test(h) ? (h[0] === '#' ? h : '#' + h) : null; }
function _hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function _rgba(hex, a) { const [r, g, b] = _hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }
function _shade(hex, amt) { const [r, g, b] = _hexToRgb(hex); const f = c => Math.max(0, Math.min(255, Math.round(c + amt * 255))); return '#' + [f(r), f(g), f(b)].map(c => c.toString(16).padStart(2, '0')).join(''); }

/* ============================================================
   FIRE AMBIENCE (bgFx: 'fire') — full-screen ember smoke, simulated.
   A domain-warped fractal-noise (fbm) density field: a low-frequency
   warp field bends the coordinate space (that's what makes the clouds
   BILLOW and curl instead of just scrolling), and the main field rises
   through it over time. Color = ember light from below (gold bed →
   orange clouds → dark maroon smoke up top; green is impossible — the
   g channel is locked to a fraction of r). Rendered on a ~176px-wide
   canvas that simplex.css stretches over the viewport (#sx-fire,
   z-index:-1) and blurs. The noise is sampled on coarse lattices
   (warp every 6px, density every 2px) and bilinearly interpolated —
   the blur erases the difference and it makes a frame ~2.5ms at 30fps.
   Honors reduce motion (in-app toggle OR the OS preference) by drawing
   a single still frame; pauses when the tab is hidden.
   ============================================================ */
const FireFX = (() => {
  let cv = null, cx = null, W = 0, H = 0, frame = null;
  let wxG = null, wyG = null, vG = null;
  let raf = 0, last = 0, active = false, still = false, rsT = 0, t0 = 0;

  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  function n2(xi, yi) {
    let n = (xi * 374761393 + yi * 668265263) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  }
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = n2(xi, yi), b = n2(xi + 1, yi), c = n2(xi, yi + 1), d = n2(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y) {
    return 0.53 * vnoise(x, y) + 0.28 * vnoise(x * 2.13 + 7.3, y * 2.13 + 1.9) + 0.19 * vnoise(x * 4.31 + 3.1, y * 4.31 + 5.7);
  }

  // coarse lattice the smooth noise is computed on, bilinearly sampled per pixel
  function grid(step) {
    const gw = Math.ceil(W / step) + 2, gh = Math.ceil(H / step) + 2;
    return { step, gw, gh, data: new Float32Array(gw * gh) };
  }
  function fill(g, fn) {
    for (let j = 0; j < g.gh; j++) for (let i = 0; i < g.gw; i++) g.data[j * g.gw + i] = fn(i * g.step, j * g.step);
  }
  function sample(g, x, y) {
    const gx = x / g.step, gy = y / g.step;
    const i = gx | 0, j = gy | 0, u = gx - i, v = gy - j;
    const o = j * g.gw + i, d = g.data;
    const a = d[o], b = d[o + 1], c = d[o + g.gw], e = d[o + g.gw + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + e) * u * v;
  }

  function size() {
    W = 176;
    H = Math.max(60, Math.min(200, Math.round(W * window.innerHeight / Math.max(1, window.innerWidth))));
    cv.width = W; cv.height = H;
    frame = cx.createImageData(W, H);
    wxG = grid(6); wyG = grid(6); vG = grid(2);
  }
  function mount() {
    if (cv) return;
    cv = document.createElement('canvas'); cv.id = 'sx-fire';
    document.body.prepend(cv);
    cx = cv.getContext('2d');
    size();
    t0 = performance.now() - 60000;   // start mid-flow, not at the field's "origin"
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
  }
  function unmount() {
    stop();
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVis);
    if (cv) cv.remove();
    cv = cx = frame = wxG = wyG = vG = null;
  }
  function onResize() {
    clearTimeout(rsT);
    rsT = setTimeout(() => { if (cv) { size(); if (still) render(performance.now() - t0); } }, 200);
  }
  function onVis() { if (!active || still) return; if (document.hidden) stop(); else start(); }

  function render(tms) {
    const t = tms / 1000;
    const rise = t * 0.55, drift = t * 0.12, wobble = t * 0.21;
    fill(wxG, (x, y) => fbm(x / H * 2.2 + 100 + drift, y / H * 2.2 - wobble));
    fill(wyG, (x, y) => fbm(x / H * 2.2 + 200 - drift * 0.7, y / H * 2.2 - wobble * 1.3));
    fill(vG, (x, y) => fbm(x / H * 3.1 + sample(wxG, x, y) * 1.15 + drift, y / H * 3.1 - rise + sample(wyG, x, y) * 1.15));
    const d = frame.data;
    for (let y = 0; y < H; y++) {
      const ny = y / (H - 1);
      const heat = Math.pow(ny, 1.55);                      // hot at the bottom
      const glow = heat * heat;
      for (let x = 0; x < W; x++) {
        const v = clamp01((sample(vG, x, y) - 0.28) * 2.2); // carve cloud shapes
        const warm = clamp01(glow * (0.7 + 0.9 * v) + 0.17 * v);
        const core = clamp01((heat - 0.8) * 4.5) * v;       // gold bed only at the very bottom
        const r = 255 * warm + 95 * v * (1 - warm);
        const o = (y * W + x) * 4;
        d[o]     = r;
        d[o + 1] = r * (0.26 + 0.30 * warm + 0.19 * core);  // g ≤ r: orange, never green
        d[o + 2] = r * (0.10 + 0.06 * (1 - warm));
        d[o + 3] = 255 * clamp01(v * (0.4 + 0.6 * heat) * 1.3);
      }
    }
    cx.putImageData(frame, 0, 0);
  }
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (ts - last < 33) return;               // ~30fps is plenty behind a blur
    last = ts;
    render(ts - t0);
  }
  function start() { if (!raf) raf = requestAnimationFrame(loop); }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  function sync(on, reduced) {
    const osReduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    still = !!(reduced || osReduced);
    active = !!on;
    if (!active) { unmount(); return; }
    mount();
    if (still) { stop(); render(performance.now() - t0); }
    else if (!document.hidden) start();
  }
  return { sync };
})();

function applyPrefs(p) {
  const prefs = { ...DEFAULT_PREFS, ...(p || {}) };
  const root = document.documentElement;
  if (prefs.theme && prefs.theme !== 'charcoal') root.setAttribute('data-theme', prefs.theme); else root.removeAttribute('data-theme');
  // keep the browser chrome (mobile status bar) + native-widget palette in sync with the theme
  const themeDef = THEMES.find(t => t.id === prefs.theme) || THEMES[0];
  const chromeMeta = document.querySelector('meta[name="theme-color"]');
  if (chromeMeta) chromeMeta.setAttribute('content', THEME_CHROME[themeDef.id] || THEME_CHROME.charcoal);
  const schemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (schemeMeta) schemeMeta.setAttribute('content', themeDef.mode === 'light' ? 'light' : 'dark');
  // background ambience layer (body::before variants in simplex.css)
  const fx = ['aurora', 'fire', 'glow', 'grain', 'none'].includes(prefs.bgFx) ? prefs.bgFx : 'aurora';
  if (fx !== 'none') root.setAttribute('data-bgfx', fx); else root.removeAttribute('data-bgfx');
  FireFX.sync(fx === 'fire', !!prefs.reduceMotion);
  const acc = normalizeHex(prefs.accent);
  if (acc) {
    root.style.setProperty('--acc', acc);
    root.style.setProperty('--acc-deep', _shade(acc, -0.10));
    root.style.setProperty('--acc-glow', _rgba(acc, 0.18));
  } else { root.style.removeProperty('--acc'); root.style.removeProperty('--acc-deep'); root.style.removeProperty('--acc-glow'); }
  const ui = FONTS.ui.find(f => f.key === prefs.uiFont) || FONTS.ui[0];
  const mono = FONTS.mono.find(f => f.key === prefs.monoFont) || FONTS.mono[0];
  root.style.setProperty('--sans', ui.stack);
  root.style.setProperty('--mono', mono.stack);

  // ---- overall interface size: `zoom` scales fonts + icons + spacing uniformly.
  // (zoom is honored by Chromium & Safari; Firefox 126+.) Clamp to a sane range. ----
  const scale = Math.max(70, Math.min(150, Number(prefs.uiScale) || 100)) / 100;
  root.style.zoom = scale === 1 ? '' : String(scale);
  // Chromium multiplies viewport-unit lengths by the zoom factor, so a 100dvh
  // surface renders at scale×viewport — at uiScale 90 the shell/sidebar stopped
  // ~10% short of the screen bottom. --zoom lets --app-h divide that back out.
  root.style.setProperty('--zoom', String(scale));
  // ---- text nudge: an extra multiplier applied ONLY to content text (see --text-scale
  // usage in simplex.css). Keeps icons/layout put while bumping just readable text. ----
  const textScale = Math.max(80, Math.min(140, Number(prefs.textScale) || 100)) / 100;
  root.style.setProperty('--text-scale', String(textScale));
  // ---- corner roundness: scale the two radius tokens everything derives from. ----
  const round = Math.max(0, Math.min(220, Number(prefs.roundness) == null ? 100 : Number(prefs.roundness))) / 100;
  root.style.setProperty('--radius', (11 * round).toFixed(2) + 'px');
  root.style.setProperty('--radius-sm', (7 * round).toFixed(2) + 'px');
  // ---- reduced motion + density as root attributes CSS keys off ----
  if (prefs.reduceMotion) root.setAttribute('data-motion', 'reduce'); else root.removeAttribute('data-motion');
  const density = ['compact', 'comfortable', 'roomy'].includes(prefs.density) ? prefs.density : 'comfortable';
  if (density !== 'comfortable') root.setAttribute('data-density', density); else root.removeAttribute('data-density');
}
let _savePrefsTimer = null;
function setPrefs(patch) {
  PREFS = { ...PREFS, ...patch };
  savePrefsLocal(); applyPrefs(PREFS);
  if (typeof reflectPlayState === 'function') reflectPlayState();   // live album-spin mode change
  clearTimeout(_savePrefsTimer);
  _savePrefsTimer = setTimeout(() => { updateMe({ prefs: PREFS }).then(r => { if (r && r.account) ACCOUNT = r.account; }).catch(() => {}); }, 500);
}
applyPrefs(PREFS);   // theme the page immediately, before login

/* NOTES + CODE apps extracted to apps-editors.js (lazy via openLazyApp). */

/* ============================================================
   AI APP — chat with models (xAI / Cloudflare), streamed live
   ============================================================ */
let _aiChats = [], _aiActive = null, _aiMessages = [], _aiModels = [], _aiModel = null;
let _aiScope = 'online';   // 'online' (API providers) | 'local' (bundled GGUF engine)
let _aiThermal = null, _aiThermalTimer = null;   // local-engine thermal state + Local-tab poll
let _aiStreaming = false, _aiAbort = null;
let _aiPersona = {}, _aiMemory = [], _aiView = 'chat';
let _aiToolsOn = true, _aiArtifacts = [], _aiArtifactOpen = null, _aiStreamIdx = -1, _aiToolMsgIdx = -1;
const TOOL_ICON = { web_search: 'globe', list_files: 'files', read_file: 'eye', write_file: 'newfile', edit_file: 'rename', create_artifact: 'window', update_artifact: 'window' };
const TOOL_LABEL = { web_search: 'Web search', list_files: 'List files', read_file: 'Read file', write_file: 'Create file', edit_file: 'Edit file', create_artifact: 'Create artifact', update_artifact: 'Update artifact' };
const AI_TRAITS = [
  { id: 'concise', label: 'Concise', text: 'Keep responses brief and to the point' },
  { id: 'detailed', label: 'Detailed', text: 'Give thorough, in-depth answers' },
  { id: 'friendly', label: 'Friendly', text: 'Use a warm, casual, conversational tone' },
  { id: 'formal', label: 'Formal', text: 'Use a professional, formal tone' },
  { id: 'direct', label: 'Direct', text: 'Skip preamble; get to the point' },
  { id: 'encouraging', label: 'Encouraging', text: 'Be encouraging and supportive' },
  { id: 'technical', label: 'Technical', text: 'Assume expertise; use precise terms' },
  { id: 'eli5', label: 'Explain simply', text: 'Explain as if to a beginner' },
];

function aiHTML() {
  return `<div class="ai-app">
    <div class="ai-list">
      <div class="ai-list-head"><span class="eyebrow">Chats</span><button class="btn primary sm" id="aiNew">${svg('plus', 14)} New</button></div>
      <div class="ai-items" id="aiItems"></div>
    </div>
    <div class="ai-main" id="aiMain"><div class="dim mono pad-sm">Loading…</div></div>
  </div>`;
}
async function wireAI() {
  document.getElementById('aiNew').onclick = aiNewChat;
  _appCleanup = () => { aiStopStream(); stopAiThermalPoll(); };
  const main = document.getElementById('aiMain');
  if (!(ACCOUNT && ACCOUNT.can_ai)) { main.innerHTML = aiNoticeHTML('AI isn\'t enabled for your account.', 'Ask an admin to turn on "Can use AI".'); return; }
  try { const m = await aiModels(); _aiModels = m.models || []; } catch (e) { _aiModels = []; }
  if (!_aiModels.length) {
    main.innerHTML = aiNoticeHTML('No AI providers are configured yet.', ACCOUNT.is_admin ? '<button class="btn ghost sm" id="aiGoSettings">' + svg('gear', 14) + ' Configure providers</button>' : 'Ask an admin to set them up.', true);
    const g = document.getElementById('aiGoSettings'); if (g) g.onclick = () => openApp('settings');
    return;
  }
  // pick an initial scope that actually has models — prefer the remembered one,
  // then Online, then Local — and select the first model within it.
  const remembered = localStorage.getItem('simplex.ai.scope');
  _aiScope = aiModelsInScope(remembered).length ? remembered
    : aiModelsInScope('online').length ? 'online' : 'local';
  _aiModel = (aiModelsInScope(_aiScope)[0] || _aiModels[0]).id;
  _aiView = 'chat';
  _aiToolsOn = localStorage.getItem('simplex.ai.tools') !== 'off';
  try { const p = await aiPersonaGet(); _aiPersona = p.persona || {}; _aiMemory = p.memory || []; } catch (e) { _aiPersona = {}; _aiMemory = []; }
  await refreshAiChats();
  aiNewChat();
  if (_aiScope === 'local') startAiThermalPoll();
}
function aiNoticeHTML(title, sub, htmlSub) {
  return `<div class="ai-empty dim" style="margin:auto"><div class="ico">${svg('spark', 40, 1.4)}</div><p>${esc(title)}<br>${htmlSub ? sub : esc(sub)}</p></div>`;
}

/* ---- Online vs Local scope ---- */
function aiModelsInScope(scope) { return _aiModels.filter(m => (m.scope || 'online') === scope); }
function aiModelById(id) { return _aiModels.find(m => m.id === id) || null; }
function aiHasLocal() { return aiModelsInScope('local').length > 0; }
function aiHasOnline() { return aiModelsInScope('online').length > 0; }
/* switch tabs; remember the choice and re-select a sensible model in the new scope */
function setAiScope(scope) {
  if (scope !== 'online' && scope !== 'local') return;
  if (scope === _aiScope) return;
  _aiScope = scope;
  localStorage.setItem('simplex.ai.scope', scope);
  const inScope = aiModelsInScope(scope);
  // keep the current model only if it belongs to the new scope; else pick the first
  if (!inScope.find(m => m.id === _aiModel)) _aiModel = inScope.length ? inScope[0].id : null;
  if (scope === 'local') startAiThermalPoll(); else stopAiThermalPoll();
  renderAiView();
}
/* human label for a local-model load stage emitted by the engine over SSE */
function aiStageLabel(stage) {
  return stage === 'resolving' ? 'Preparing model…'
    : stage === 'starting' ? 'Loading model into memory…'
    : stage === 'ready' ? 'Model ready' : 'Working…';
}
/* option label for the model dropdown */
/* Pretty display names for xAI models. The server enumerates them live from
   /v1/models (so new models appear automatically as raw ids like "grok-4.5");
   this just gives the known ones a clean label. Unknown grok ids fall back to a
   title-cased version of the id so a brand-new model still reads nicely. */
const GROK_NAMES = {
  'grok-4.5': 'Grok 4.5', 'grok-4.5-latest': 'Grok 4.5',
  'grok-4.3': 'Grok 4.3', 'grok-4.3-latest': 'Grok 4.3',
  'grok-4.1-fast': 'Grok 4.1 Fast', 'grok-4-1-fast': 'Grok 4.1 Fast',
  'grok-4': 'Grok 4', 'grok-4-latest': 'Grok 4', 'grok-4-0709': 'Grok 4',
  'grok-3': 'Grok 3', 'grok-3-latest': 'Grok 3', 'grok-3-mini': 'Grok 3 Mini',
  'grok-code-fast-1': 'Grok Code Fast', 'grok-build-latest': 'Grok Build',
};
function prettyModelName(m) {
  const id = String(m.id || m.name || '');
  if (GROK_NAMES[id.toLowerCase()]) return GROK_NAMES[id.toLowerCase()];
  // unknown grok id -> "grok-4.7-fast" => "Grok 4.7 Fast"
  if (/grok/i.test(id)) {
    return id.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bGrok\b/i, 'Grok');
  }
  return m.name || id;   // Cloudflare (and any other) provider already supplies a friendly name
}
function aiModelLabel(m) {
  if ((m.scope || 'online') === 'local') {
    const where = m.source === 'user' ? 'your files' : 'server';
    return `${m.name} · ${m.size ? fmtSize(m.size) + ' · ' : ''}${where}`;
  }
  return `${prettyModelName(m)} · ${m.provider}`;
}

/* ---- Local AI thermal safety net (cooldown banner) ----
   The server stops local AI when it overheats and reports the state via
   /api/ai/local/status. We poll lightly while the Local tab is open and show a
   banner with the remaining cooldown. */
function aiThermalBannerHTML() {
  const t = _aiThermal;
  if (!t || !t.tripped) return '';
  const mins = Math.max(1, Math.ceil((t.cooldownRemainingMs || 0) / 60000));
  const temp = (t.tempC != null) ? ` (reached ${Math.round(t.tempC)}°C)` : '';
  return `<div class="ai-thermal-banner">${svg('thermometer', 15)}
    <div class="atb-text"><b>Cooling down${temp}</b><span>The server got too warm, so local AI is paused for about ${mins} more minute${mins === 1 ? '' : 's'} to protect the hardware. Online models still work.</span></div>
  </div>`;
}
function refreshThermalBanner() {
  const el = document.getElementById('aiThermalBanner');
  if (el && _aiScope === 'local') el.innerHTML = aiThermalBannerHTML();
}
function startAiThermalPoll() {
  stopAiThermalPoll();
  const tick = async () => {
    try { const s = await aiLocalStatus(); _aiThermal = s.thermal || null; } catch (e) { _aiThermal = null; }
    refreshThermalBanner();
  };
  tick();
  _aiThermalTimer = setInterval(tick, 15000);
}
function stopAiThermalPoll() { if (_aiThermalTimer) { clearInterval(_aiThermalTimer); _aiThermalTimer = null; } }

async function refreshAiChats() {
  try { _aiChats = await aiChats(); } catch (e) { _aiChats = []; }
  renderAiList();
}
function renderAiList() {
  const box = document.getElementById('aiItems'); if (!box) return;
  if (!_aiChats.length) { box.innerHTML = `<div class="dim mono pad-sm">No chats yet.</div>`; return; }
  box.innerHTML = _aiChats.map(c => `<button class="ai-item ${c.id === _aiActive ? 'on' : ''}" data-chat="${c.id}">
    <div class="ai-it-title">${esc(c.title || 'New chat')}</div>
    <div class="ai-it-sub mono">${fmtDate(c.updated)}</div>
  </button>`).join('');
  box.querySelectorAll('[data-chat]').forEach(b => b.onclick = () => openAiChat(b.dataset.chat));
}
function closeAiList() { const l = document.querySelector('.ai-app .ai-list'); if (l) l.classList.remove('open'); }
function aiNewChat() {
  if (_aiStreaming) aiStopStream();
  _aiActive = null; _aiMessages = []; _aiView = 'chat';
  _aiArtifacts = []; _aiArtifactOpen = null;
  closeAiList();
  renderAiList(); renderAiView();
}
async function openAiChat(id) {
  if (_aiStreaming) aiStopStream();
  let ch; try { ch = await aiChatGet(id); } catch (e) { return; }
  _aiActive = ch.id; _aiMessages = ch.messages || []; _aiView = 'chat';
  closeAiList();
  // rebuild the artifact set from saved messages (same object refs so edits persist)
  _aiArtifacts = []; _aiArtifactOpen = null;
  _aiMessages.forEach(m => { if (Array.isArray(m.artifacts)) m.artifacts.forEach(a => { if (a && a.content != null) _aiArtifacts.push(a); }); });
  if (ch.model && _aiModels.find(m => m.id === ch.model)) _aiModel = ch.model;
  renderAiList(); renderAiView();
}
async function aiDeleteChat(id) {
  if (!id || !confirm('Delete this chat?')) return;
  try { await aiChatDelete(id); } catch (e) {}
  if (_aiActive === id) aiNewChat();
  await refreshAiChats();
}

function renderAiView() {
  const main = document.getElementById('aiMain'); if (!main) return;
  if (_aiView === 'settings') return renderAiSettings();
  const memOn = _aiPersona.memoryEnabled !== false && _aiMemory.length;
  const scoped = aiModelsInScope(_aiScope);
  const modelSel = scoped.length
    ? `<select class="ai-model set-select" id="aiModelSel">${scoped.map(m => `<option value="${esc(m.id)}" ${m.id === _aiModel ? 'selected' : ''}>${esc(aiModelLabel(m))}</option>`).join('')}</select>`
    : `<span class="ai-model-empty dim mono">${_aiScope === 'local' ? 'No local models — add a .gguf' : 'No online models configured'}</span>`;
  main.innerHTML = `
    <div class="ai-bar">
      <button class="ic-btn ai-chats-btn" id="aiChatsBtn" title="Chats" aria-label="Show chats">${svg('files', 16)}</button>
      <div class="seg ai-scope-seg" id="aiScopeSeg" title="Online = API providers · Local = on-device GGUF models">
        <button data-scope="online" class="${_aiScope === 'online' ? 'on' : ''}">${svg('globe', 13)} Online</button>
        <button data-scope="local" class="${_aiScope === 'local' ? 'on' : ''}">${svg('cpu', 13)} Local</button>
      </div>
      ${modelSel}
      <span class="spacer"></span>
      ${memOn ? `<span class="ai-mem-pill mono" title="${_aiMemory.length} memories in use">${svg('brain', 13)} ${_aiMemory.length}</span>` : ''}
      <button class="ic-btn ${_aiToolsOn ? 'on' : ''}" id="aiToolsBtn" title="Tools ${_aiToolsOn ? 'on — the AI can search, read/write files & make artifacts' : 'off'}">${svg('wrench', 15)}</button>
      ${_aiActive ? `<button class="ic-btn" id="aiDelete" title="Delete chat">${svg('trash', 15)}</button>` : ''}
      <button class="ic-btn" id="aiPersonaBtn" title="Personalize & memory">${svg('user', 16)}</button>
    </div>
    <div id="aiThermalBanner">${_aiScope === 'local' ? aiThermalBannerHTML() : ''}</div>
    <div class="ai-transcript" id="aiTranscript">${_aiMessages.length ? aiTranscriptHTML() : aiEmptyForScope()}</div>
    <div class="ai-composer">
      <textarea class="ai-input" id="aiInput" rows="1" placeholder="Message the AI…  (Enter to send, Shift+Enter for newline)"></textarea>
      <button class="btn primary ai-send" id="aiSend" title="Send">${svg('send', 16)}</button>
      <button class="btn ghost ai-stop hidden" id="aiStop" title="Stop">${svg('stop', 16)}</button>
    </div>`;
  const sel = document.getElementById('aiModelSel'); if (sel) sel.onchange = e => { _aiModel = e.target.value; };
  document.querySelectorAll('#aiScopeSeg [data-scope]').forEach(b => b.onclick = () => setAiScope(b.dataset.scope));
  const del = document.getElementById('aiDelete'); if (del) del.onclick = () => aiDeleteChat(_aiActive);
  document.getElementById('aiPersonaBtn').onclick = () => { _aiView = 'settings'; renderAiView(); };
  document.getElementById('aiToolsBtn').onclick = () => {
    _aiToolsOn = !_aiToolsOn; localStorage.setItem('simplex.ai.tools', _aiToolsOn ? 'on' : 'off');
    renderAiView(); toast(_aiToolsOn ? 'Tools enabled' : 'Tools disabled', _aiToolsOn ? 'check' : 'close');
  };
  const chatsBtn = document.getElementById('aiChatsBtn'); if (chatsBtn) chatsBtn.onclick = () => { const l = document.querySelector('.ai-app .ai-list'); if (l) l.classList.toggle('open'); };
  const input = document.getElementById('aiInput');
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 170) + 'px'; });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSend(); } });
  document.getElementById('aiSend').onclick = aiSend;
  document.getElementById('aiStop').onclick = aiStopStream;
  wireAiTranscript();
  renderArtifactPanel();
  scrollAiBottom();
}
function aiTranscriptHTML() { return _aiMessages.map((m, i) => aiMsgHTML(m, i)).join(''); }
function wireAiTranscript() {
  document.querySelectorAll('#aiTranscript [data-sg]').forEach(b => b.onclick = () => {
    const input = document.getElementById('aiInput'); if (!input) return;
    input.value = b.dataset.sg + ' '; input.focus();
    input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 170) + 'px';
  });
  document.querySelectorAll('#aiTranscript .ai-tchip').forEach(c => c.onclick = () => c.classList.toggle('open'));
  document.querySelectorAll('#aiTranscript [data-art]').forEach(c => c.onclick = () => { _aiArtifactOpen = c.dataset.art; renderArtifactPanel(); });
}
function aiMsgHTML(m, i) {
  if (m.role === 'user') {
    if (m.toolResult) return '';   // internal tool-result feed — not shown in the transcript
    return `<div class="ai-msg me" data-mi="${i}"><div class="bub"><div class="bub-text">${esc(m.content)}</div></div></div>`;
  }
  const streaming = (i === _aiStreamIdx);
  const prose = streaming ? streamingProse(m.content || '') : stripToolBlocks(m.content || '');
  const inner = prose.trim() ? mdToHtml(prose) : (streaming ? '<span class="ai-thinking">Working…</span>' : '');
  const bubble = (prose.trim() || streaming)
    ? `<div class="ai-msg ai" data-mi="${i}"><div class="bub"><div class="bub-text md">${inner}</div></div></div>` : '';
  const tools = (m.tools && m.tools.length) ? `<div class="ai-tools-row">${m.tools.map(toolChipHTML).join('')}</div>` : '';
  const arts = (m.artifacts && m.artifacts.length) ? `<div class="ai-art-cards">${m.artifacts.map(artifactCardHTML).join('')}</div>` : '';
  return bubble + tools + arts;
}
/* tool-call protocol parsing + display helpers */
function stripToolBlocks(text) { return String(text || '').replace(/```tool_use\s*[\s\S]*?```/gi, '').replace(/\n{3,}/g, '\n\n').trim(); }
function streamingProse(text) { const i = String(text || '').indexOf('```tool_use'); return i >= 0 ? text.slice(0, i) : text; }
function parseToolCalls(text) {
  const calls = []; const re = /```tool_use\s*\n?([\s\S]*?)```/gi; let m;
  while ((m = re.exec(text))) {
    let body = m[1].trim();
    try { const o = JSON.parse(body); if (o && o.tool) calls.push({ tool: String(o.tool), args: o.args || {} }); } catch (e) {}
  }
  return calls;
}
function toolChipHTML(t) {
  const ic = TOOL_ICON[t.name] || 'wrench', label = TOOL_LABEL[t.name] || t.name, st = t.status || 'done';
  const dot = st === 'running' ? '<span class="tspin"></span>' : st === 'error' ? svg('close', 12) : svg('check', 12);
  const detail = (t.args || t.result != null)
    ? `<div class="tchip-detail mono">${esc(JSON.stringify(t.args || {}))}${t.result != null ? '\n\n' + esc(String(t.result).slice(0, 1200)) : ''}</div>` : '';
  return `<div class="ai-tchip ${st}"><div class="tchip-head">${svg(ic, 13)}<span class="tchip-name">${esc(label)}</span><span class="tchip-arg">${esc(toolArgSummary(t.name, t.args))}</span><span class="tchip-status">${dot}</span></div>${detail}</div>`;
}
function toolArgSummary(name, args) {
  args = args || {};
  const v = args.query || args.name || args.title || args.id || args.path || '';
  return String(v).slice(0, 80);
}
function artifactCardHTML(a) {
  return `<button class="ai-art-card" data-art="${a.id}">${svg('window', 16)}<span class="aac-main"><span class="aac-title">${esc(a.title)}</span><span class="aac-type mono">${esc(a.type)}${a.language ? ' · ' + esc(a.language) : ''}</span></span><span class="aac-open">Open ›</span></button>`;
}
function aiEmptyHTML() {
  const name = _aiPersona.name ? esc(_aiPersona.name) : '';
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const sugg = ['Help me write', 'Explain a concept', 'Brainstorm ideas', 'Draft an email', 'Debug some code', 'Summarize this:'];
  return `<div class="ai-welcome">
    <div class="aw-spark">${svg('spark', 30, 1.4)}</div>
    <h2 class="aw-greet">${greet}${name ? `, ${name}` : ''}.</h2>
    <p class="aw-sub dim">How can I help you today?</p>
    <div class="ai-suggest">${sugg.map(s => `<button class="ai-sg" data-sg="${esc(s)}">${esc(s)}</button>`).join('')}</div>
  </div>`;
}
/* Local tab with no models yet: explain the two ways to add one. */
function aiLocalEmptyHTML() {
  return `<div class="ai-welcome ai-local-empty">
    <div class="aw-spark">${svg('cpu', 30, 1.4)}</div>
    <h2 class="aw-greet">Local AI</h2>
    <p class="aw-sub dim">Run a language model entirely on this server — nothing leaves the box.</p>
    <div class="ai-local-how">
      <div class="alh-card">${svg('newfile', 16)}<div><b>Upload a model</b><span class="dim">Add a <code>.gguf</code> file to your Database — it'll appear here automatically.</span></div></div>
      <div class="alh-card">${svg('hdd', 16)}<div><b>Server models</b><span class="dim">${ACCOUNT && ACCOUNT.is_admin ? 'Drop <code>.gguf</code> files into the server <code>models/</code> folder.' : 'An admin can pre-load models on the server for everyone.'}</span></div></div>
    </div>
  </div>`;
}
/* the right empty state for the current scope */
function aiEmptyForScope() {
  return (_aiScope === 'local' && !aiModelsInScope('local').length) ? aiLocalEmptyHTML() : aiEmptyHTML();
}

function renderAiTranscript() {
  const t = document.getElementById('aiTranscript'); if (!t) return;
  t.innerHTML = _aiMessages.length ? aiTranscriptHTML() : aiEmptyForScope();
  wireAiTranscript();
  scrollAiBottom();
}
let _aiStage = '';   // local-model load stage ('' once tokens flow); shown in the thinking placeholder
function updateStreamBubble(text) {
  if (_aiStreamIdx < 0) return;
  const t = document.getElementById('aiTranscript'); if (!t) return;
  const el = t.querySelector(`.ai-msg[data-mi="${_aiStreamIdx}"] .bub-text`);
  if (el) {
    const p = streamingProse(text).trim();
    const placeholder = `<span class="ai-thinking">${esc(_aiStage || 'Working…')}</span>`;
    el.innerHTML = p ? mdToHtml(p) : placeholder; scrollAiBottom();
  }
}
/* called as the local engine reports load progress; refresh the placeholder text */
function aiSetStage(stage) {
  _aiStage = stage === 'ready' ? '' : aiStageLabel(stage);
  updateStreamBubble(_aiStreamIdx >= 0 && _aiMessages[_aiStreamIdx] ? _aiMessages[_aiStreamIdx].content || '' : '');
}
function scrollAiBottom() { const t = document.getElementById('aiTranscript'); if (t) t.scrollTop = t.scrollHeight; }
function setAiStreaming(on) {
  _aiStreaming = on;
  const s = document.getElementById('aiSend'), st = document.getElementById('aiStop'), inp = document.getElementById('aiInput');
  if (s) s.classList.toggle('hidden', on);
  if (st) st.classList.toggle('hidden', !on);
  if (inp) inp.disabled = on;
}
function aiStopStream() { if (_aiAbort) { try { _aiAbort.abort(); } catch (e) {} _aiAbort = null; } _aiStreamIdx = -1; setAiStreaming(false); }

/* provider-facing history: strip UI-only meta down to {role, content} */
function providerMessages(beforeIdx) {
  return _aiMessages.slice(0, beforeIdx).map(m => ({ role: m.role, content: m.content || '' }));
}

async function aiSend() {
  if (_aiStreaming) return;
  const input = document.getElementById('aiInput');
  const text = (input.value || '').trim();
  if (!text) return;
  if (!_aiModel) { toast('Pick a model', 'close'); return; }
  input.value = ''; input.style.height = 'auto';
  _aiMessages.push({ role: 'user', content: text });
  renderAiTranscript();
  setAiStreaming(true);
  _aiAbort = new AbortController();
  try { await aiRunTurn(); } catch (e) { /* per-step handling below */ }
  _aiStreamIdx = -1; setAiStreaming(false); _aiAbort = null;
  renderAiTranscript();
  await persistAiChat();
}

/* agentic loop: stream a reply, run any tool calls it emits, feed results back,
   and repeat until the model answers with no tool calls (cross-model, text-protocol). */
const AI_MAX_STEPS = 6;
async function aiRunTurn() {
  const sys = _aiToolsOn ? aiToolsSystemPrompt() : undefined;
  for (let step = 0; step < AI_MAX_STEPS; step++) {
    const idx = _aiMessages.push({ role: 'assistant', content: '' }) - 1;
    _aiStreamIdx = idx;
    renderAiTranscript();
    let acc = '', errored = null;
    _aiStage = '';
    try {
      await streamAIChat({
        model: _aiModel, messages: providerMessages(idx), system: sys, signal: _aiAbort.signal,
        onStage: s => aiSetStage(s),
        onText: t => { if (_aiStage) _aiStage = ''; acc += t; _aiMessages[idx].content = acc; updateStreamBubble(acc); },
        onError: msg => { errored = msg; },
      });
    } catch (e) {
      if (e.name === 'AbortError') { _aiMessages[idx].content = stripToolBlocks(acc) || '_(stopped)_'; return; }
      errored = e.message || 'request failed';
    }
    if (errored) { _aiMessages[idx].content = (stripToolBlocks(acc) ? stripToolBlocks(acc) + '\n\n' : '') + '⚠ï¸ ' + errored; return; }

    const calls = _aiToolsOn ? parseToolCalls(acc) : [];
    if (!calls.length) { if (!acc) _aiMessages[idx].content = '_(no response)_'; _aiStreamIdx = -1; renderAiTranscript(); return; }

    // run the tool calls, attaching live status to this assistant message
    _aiStreamIdx = -1;
    _aiToolMsgIdx = idx;
    _aiMessages[idx].tools = calls.map(c => ({ name: c.tool, args: c.args, status: 'running' }));
    renderAiTranscript();
    const results = [];
    for (let k = 0; k < calls.length; k++) {
      const c = calls[k]; let out;
      try {
        const tool = AI_TOOLS[c.tool];
        if (!tool) throw new Error('unknown tool "' + c.tool + '"');
        out = await tool.run(c.args || {});
        _aiMessages[idx].tools[k].status = 'done';
      } catch (e) { out = 'Error: ' + (e.message || 'tool failed'); _aiMessages[idx].tools[k].status = 'error'; }
      _aiMessages[idx].tools[k].result = String(out);
      results.push(`[${c.tool}] ${String(out).slice(0, 6000)}`);
      renderAiTranscript();
    }
    // feed results back to the model as an internal (hidden) user turn, then loop
    _aiMessages.push({ role: 'user', content: 'TOOL_RESULTS\n' + results.join('\n\n'), toolResult: true });
  }
  // hit the step cap — leave the last assistant message as-is
}
async function persistAiChat() {
  const firstUser = _aiMessages.find(m => m.role === 'user' && !m.toolResult);
  const title = firstUser ? firstUser.content.slice(0, 60) : 'New chat';
  try {
    if (!_aiActive) { const ch = await aiChatCreate({ title, model: _aiModel, messages: _aiMessages }); _aiActive = ch.id; }
    else await aiChatUpdate(_aiActive, { title, model: _aiModel, messages: _aiMessages });
    await refreshAiChats();
  } catch (e) {}
}

/* ============================================================
   AI TOOLS — cross-model "function calling" over a plain-text protocol.
   The model emits ```tool_use {json}``` blocks; aiRunTurn parses, runs the tool
   here, and feeds the result back. Works with any text model (native function
   calling not required). Tools touch the same vault/data the rest of the app uses.
   ============================================================ */
function ensureAiDB() { return (typeof DB !== 'undefined' && DB && DB.files) ? Promise.resolve() : loadDB(); }
function aiFindFile(a) {
  if (!DB || !DB.files) return null;
  if (a.id) { const byId = DB.files.find(f => f.id === a.id); if (byId) return byId; }
  const name = String(a.name || a.id || '').toLowerCase();
  if (!name) return null;
  return DB.files.find(f => !f.trashed && f.name.toLowerCase() === name)
    || DB.files.find(f => !f.trashed && f.name.toLowerCase().includes(name)) || null;
}
function aiPathOf(f) { try { return pathOf(f.id).map(n => n.name).join('/'); } catch (e) { return f.name; } }

const AI_TOOLS = {
  web_search: {
    desc: 'Search the web for current/factual info. args: {"query": string}',
    run: async (a) => {
      const r = await aiWebSearch(String(a.query || '').trim());
      if (!r.results || !r.results.length) return 'No results found.';
      return r.results.map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${x.snippet || ''}`.trim()).join('\n\n');
    },
  },
  list_files: {
    desc: 'List/search the user\'s Database files. args: {"query"?: string, "type"?: "document"|"image"|"video"|"audio"|"folder"}',
    run: async (a) => {
      await ensureAiDB();
      let items = DB.files.filter(f => !f.trashed);
      if (a.type) items = items.filter(f => f.type === a.type);
      if (a.query) { const q = String(a.query).toLowerCase(); items = items.filter(f => f.name.toLowerCase().includes(q)); }
      items = items.slice(0, 80);
      if (!items.length) return 'No matching files.';
      return items.map(f => `${f.id} | ${aiPathOf(f)} | ${f.type}${f.type !== 'folder' ? ' | ' + fmtSize(f.size) : ''}`).join('\n');
    },
  },
  read_file: {
    desc: 'Read the text content of a Database file. args: {"id"?: string, "name"?: string}',
    run: async (a) => {
      await ensureAiDB();
      const f = aiFindFile(a); if (!f) return 'File not found.';
      if (f.type === 'folder') return 'That is a folder, not a file.';
      let text = null;
      try { const r = await fetchDocText(f); text = r.text; } catch (e) { return 'Could not read file.'; }
      if (text == null || text === '') return 'No readable text content.';
      return text.length > 60000 ? text.slice(0, 60000) + '\n…(truncated)' : text;
    },
  },
  write_file: {
    desc: 'Create a new text/code file in the Database. args: {"name": string (with extension), "content": string, "folder"?: string}',
    run: async (a) => {
      await ensureAiDB();
      const name = String(a.name || '').trim(); if (!name) return 'name is required.';
      let parent = null;
      if (a.folder) { const fl = DB.files.find(f => f.type === 'folder' && !f.trashed && (f.id === a.folder || f.name.toLowerCase() === String(a.folder).toLowerCase())); if (fl) parent = fl.id; }
      const rec = await createDoc({ name, content: String(a.content || ''), parent });
      return `Created "${rec.name}" (id ${rec.id}, ${fmtSize(rec.size)}). It is now in the user's Database.`;
    },
  },
  edit_file: {
    desc: 'Replace the full content of an existing Database text file. args: {"id"?: string, "name"?: string, "content": string}',
    run: async (a) => {
      await ensureAiDB();
      const f = aiFindFile(a); if (!f) return 'File not found.';
      if (f.type === 'folder') return 'That is a folder, not a file.';
      saveDoc(f.id, String(a.content || ''));   // PATCHes content + size, updates DB cache
      return `Updated "${f.name}".`;
    },
  },
  create_artifact: {
    desc: 'Create a viewable/editable artifact shown in a side panel — use for substantial code, documents, HTML or SVG. args: {"title": string, "type": "code"|"markdown"|"html"|"svg"|"text", "content": string, "language"?: string}',
    run: async (a) => { const art = aiCreateArtifact(a); return `Artifact "${art.title}" created (id ${art.id}) and shown in the side panel.`; },
  },
  update_artifact: {
    desc: 'Replace an artifact\'s content (defaults to the most recent). args: {"id"?: string, "content": string, "title"?: string}',
    run: async (a) => { const art = aiUpdateArtifact(a); return art ? `Artifact "${art.title}" updated.` : 'Artifact not found.'; },
  },
};

function aiToolsSystemPrompt() {
  const list = Object.entries(AI_TOOLS).map(([n, t]) => `- ${n}: ${t.desc}`).join('\n');
  return [
    'You have tools you can call. Available tools:',
    list,
    '',
    'To call a tool, output a fenced code block in EXACTLY this format (and nothing else inside the fence):',
    '```tool_use',
    '{"tool": "tool_name", "args": { ... }}',
    '```',
    'Rules:',
    '- You may emit several tool_use blocks at once to call multiple tools.',
    '- After you emit tool calls, stop and wait. You will then receive a message starting with "TOOL_RESULTS" containing the outputs; use them to continue.',
    '- Use tools when they help: web_search for current facts, list_files/read_file to look at the user\'s Database, write_file/edit_file to save work, create_artifact for substantial code/documents.',
    '- When you have everything you need, reply to the user normally with NO tool_use block.',
    '- Never invent file ids or search results — get them from the tools.',
  ].join('\n');
}

/* ---------- artifacts (side-panel working documents) ---------- */
const ARTIFACT_TYPES = ['code', 'markdown', 'html', 'svg', 'text'];
function aiCreateArtifact(a) {
  const id = 'art' + Math.random().toString(36).slice(2, 8);
  const art = {
    id, title: String(a.title || 'Untitled').slice(0, 120),
    type: ARTIFACT_TYPES.includes(a.type) ? a.type : 'text',
    language: String(a.language || '').slice(0, 30), content: String(a.content || ''),
  };
  _aiArtifacts.push(art);
  if (_aiToolMsgIdx >= 0 && _aiMessages[_aiToolMsgIdx]) { const m = _aiMessages[_aiToolMsgIdx]; (m.artifacts = m.artifacts || []).push(art); }
  _aiArtifactOpen = id;
  renderAiTranscript(); renderArtifactPanel();
  return art;
}
function aiUpdateArtifact(a) {
  const art = a.id ? _aiArtifacts.find(x => x.id === a.id) : _aiArtifacts[_aiArtifacts.length - 1];
  if (!art) return null;
  if (a.content != null) art.content = String(a.content);
  if (a.title) art.title = String(a.title).slice(0, 120);
  _aiArtifactOpen = art.id;
  renderAiTranscript(); renderArtifactPanel();
  return art;
}
function artifactExt(art) {
  if (art.type === 'markdown') return 'md';
  if (art.type === 'html') return 'html';
  if (art.type === 'svg') return 'svg';
  if (art.type === 'code') {
    const L = (art.language || '').toLowerCase();
    const map = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', go: 'go', rust: 'rs', rs: 'rs', ruby: 'rb', php: 'php', html: 'html', css: 'css', json: 'json', sql: 'sql', sh: 'sh', bash: 'sh', yaml: 'yaml', yml: 'yaml', markdown: 'md' };
    return map[L] || 'txt';
  }
  return 'txt';
}
function artifactFileName(art) {
  const base = (art.title || 'artifact').replace(/[^a-z0-9 ._-]/gi, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'artifact';
  return /\.[a-z0-9]+$/i.test(base) ? base : base + '.' + artifactExt(art);
}
function artifactPreviewHTML(art) {
  if (art.type === 'markdown') return `<div class="md-preview art-md">${mdToHtml(art.content)}</div>`;
  if (art.type === 'svg') return `<div class="art-svg"><img src="data:image/svg+xml;utf8,${encodeURIComponent(art.content)}" alt="${esc(art.title)}"></div>`;
  if (art.type === 'html') return `<iframe class="art-frame" sandbox="allow-scripts allow-popups" srcdoc="${esc(art.content)}"></iframe>`;
  return '';
}
function artifactHasPreview(art) { return art.type === 'markdown' || art.type === 'svg' || art.type === 'html'; }
let _artifactTab = 'preview', _artifactEditing = false;
function renderArtifactPanel() {
  const main = document.getElementById('aiMain'); if (!main) return;
  const existing = main.querySelector('.ai-artifact-panel'); if (existing) existing.remove();
  main.classList.toggle('has-artifact', !!_aiArtifactOpen);
  if (!_aiArtifactOpen) return;
  const art = _aiArtifacts.find(a => a.id === _aiArtifactOpen);
  if (!art) { _aiArtifactOpen = null; main.classList.remove('has-artifact'); return; }
  const hasPv = artifactHasPreview(art);
  const tab = hasPv ? _artifactTab : 'code';
  const body = _artifactEditing
    ? `<textarea class="art-edit" id="artEdit" spellcheck="false">${esc(art.content)}</textarea>`
    : (tab === 'preview' && hasPv ? artifactPreviewHTML(art) : `<pre class="art-code"><code>${esc(art.content)}</code></pre>`);
  const panel = document.createElement('div');
  panel.className = 'ai-artifact-panel';
  panel.innerHTML = `
    <div class="art-head">
      <div class="art-titlewrap">
        <span class="art-ico">${svg('window', 16)}</span>
        <div class="art-tt"><div class="art-title">${esc(art.title)}</div><div class="art-type mono">${esc(art.type)}${art.language ? ' · ' + esc(art.language) : ''}</div></div>
      </div>
      <button class="ic-btn" id="artClose" title="Close">${svg('close', 16)}</button>
    </div>
    ${(_aiArtifacts.length > 1) ? `<div class="art-switch">${_aiArtifacts.map(a => `<button class="art-sw ${a.id === art.id ? 'on' : ''}" data-sw="${a.id}">${esc(a.title)}</button>`).join('')}</div>` : ''}
    <div class="art-toolbar">
      ${hasPv ? `<div class="seg art-tabs"><button data-tab="preview" class="${tab === 'preview' ? 'on' : ''}">${svg('eye', 13)} Preview</button><button data-tab="code" class="${tab === 'code' ? 'on' : ''}">${svg('code', 13)} Source</button></div>` : ''}
      <span class="spacer"></span>
      <button class="btn ghost sm" id="artEditBtn">${svg('rename', 13)} ${_artifactEditing ? 'Done' : 'Edit'}</button>
      <button class="btn ghost sm" id="artCopy">${svg('copy', 13)} Copy</button>
      <button class="btn ghost sm" id="artDownload">${svg('download', 13)} Download</button>
      <button class="btn primary sm" id="artSaveVault">${svg('save', 13)} Save to vault</button>
    </div>
    <div class="art-body">${body}</div>`;
  main.appendChild(panel);

  panel.querySelector('#artClose').onclick = () => { _aiArtifactOpen = null; _artifactEditing = false; renderArtifactPanel(); };
  panel.querySelectorAll('[data-sw]').forEach(b => b.onclick = () => { _aiArtifactOpen = b.dataset.sw; _artifactEditing = false; renderArtifactPanel(); });
  panel.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { _artifactTab = b.dataset.tab; renderArtifactPanel(); });
  panel.querySelector('#artEditBtn').onclick = () => {
    if (_artifactEditing) { const ta = panel.querySelector('#artEdit'); if (ta) { art.content = ta.value; renderAiTranscript(); } }
    _artifactEditing = !_artifactEditing; renderArtifactPanel();
  };
  panel.querySelector('#artCopy').onclick = () => { copyText(art.content); toast('Copied artifact', 'copy'); };
  panel.querySelector('#artDownload').onclick = () => {
    const blob = new Blob([art.content], { type: 'text/plain' }); const u = URL.createObjectURL(blob);
    const aEl = document.createElement('a'); aEl.href = u; aEl.download = artifactFileName(art); aEl.click(); URL.revokeObjectURL(u);
  };
  panel.querySelector('#artSaveVault').onclick = async () => {
    try { await ensureAiDB(); const rec = await createDoc({ name: artifactFileName(art), content: art.content }); toast('Saved "' + rec.name + '" to vault', 'check'); }
    catch (e) { toast(e.message || 'Save failed', 'close'); }
  };
}

/* ---------- AI personalization & memory (Claude-style profile) ---------- */
function renderAiSettings() {
  const main = document.getElementById('aiMain'); if (!main) return;
  const p = _aiPersona || {};
  main.innerHTML = `<div class="ai-settings">
    <div class="ai-set-head">
      <button class="btn ghost sm" id="aiBack">${svg('back', 14)} Back to chat</button>
      <div class="ai-set-title">${svg('user', 15)} Personalization &amp; memory</div>
    </div>
    <div class="ai-set-body">
      <div class="set-section">
        <span class="eyebrow">About you</span>
        <p class="api-note">Tell the AI who you are so it can tailor every response.</p>
        <label class="form-field"><span class="eyebrow">Preferred name</span>
          <input type="text" id="apName" maxlength="60" placeholder="What should the AI call you?" value="${esc(p.name || '')}"></label>
        <label class="form-field"><span class="eyebrow">What you do</span>
          <input type="text" id="apRole" maxlength="200" placeholder="e.g. Software engineer, student, novelist…" value="${esc(p.role || '')}"></label>
      </div>

      <div class="set-section">
        <span class="eyebrow">Response style</span>
        <p class="api-note">Pick any that fit how you like answers. (Optional)</p>
        <div class="ai-traits" id="apTraits">
          ${AI_TRAITS.map(t => `<button class="ai-trait ${(p.traits || []).includes(t.id) ? 'on' : ''}" data-trait="${t.id}" title="${esc(t.text)}">${esc(t.label)}</button>`).join('')}
        </div>
      </div>

      <div class="set-section">
        <span class="eyebrow">Custom instructions</span>
        <p class="api-note">Anything the AI should always keep in mind — context, preferences, formatting rules.</p>
        <textarea id="apInstr" class="ai-instr" rows="5" maxlength="4000" placeholder="e.g. I prefer answers in British English. When I share code, point out bugs before explaining.">${esc(p.instructions || '')}</textarea>
      </div>

      <div class="ai-set-save">
        <button class="btn primary" id="apSave">${svg('save', 14)} Save profile</button>
        <span class="ai-save-hint mono dim" id="apHint"></span>
      </div>

      <div class="set-section">
        <div class="api-section-head">
          <span class="eyebrow">Memory</span>
          <label class="ai-mem-toggle"><input type="checkbox" id="apMem" ${p.memoryEnabled !== false ? 'checked' : ''}><span>Use memory in chats</span></label>
        </div>
        <p class="api-note">Facts the AI remembers across <b>all</b> your chats. When memory is on, they're added to every conversation.</p>
        <div class="ai-mem-add">
          <input type="text" id="apMemNew" placeholder="Add something to remember…" maxlength="2000">
          <button class="btn ghost sm" id="apMemAdd">${svg('plus', 14)} Add</button>
        </div>
        <div id="apMemList" class="ai-mem-list"></div>
      </div>
    </div>
  </div>`;

  document.getElementById('aiBack').onclick = () => { _aiView = 'chat'; renderAiView(); };
  document.querySelectorAll('#apTraits .ai-trait').forEach(b => b.onclick = () => b.classList.toggle('on'));
  document.getElementById('apSave').onclick = () => saveAiPersona(false);
  document.getElementById('apMem').onchange = () => saveAiPersona(true);   // persist toggle immediately
  document.getElementById('apMemAdd').onclick = addAiMemoryFromInput;
  document.getElementById('apMemNew').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addAiMemoryFromInput(); } };
  renderAiMemory();
}

function collectAiPersona() {
  return {
    name: (document.getElementById('apName').value || '').trim(),
    role: (document.getElementById('apRole').value || '').trim(),
    instructions: (document.getElementById('apInstr').value || '').trim(),
    traits: [...document.querySelectorAll('#apTraits .ai-trait.on')].map(b => b.dataset.trait),
    memoryEnabled: document.getElementById('apMem').checked,
  };
}
async function saveAiPersona(silent) {
  const persona = collectAiPersona();
  try {
    const r = await aiPersonaSet(persona);
    _aiPersona = r.persona || persona;
    if (!silent) {
      const h = document.getElementById('apHint');
      if (h) { h.textContent = 'Saved ✓'; setTimeout(() => { if (h) h.textContent = ''; }, 2000); }
      toast('Personalization saved', 'check');
    }
  } catch (e) { toast(e.message || 'Save failed', 'close'); }
}

function renderAiMemory() {
  const box = document.getElementById('apMemList'); if (!box) return;
  if (!_aiMemory.length) { box.innerHTML = `<div class="ai-mem-empty dim mono">Nothing remembered yet.</div>`; return; }
  box.innerHTML = _aiMemory.map(m => `
    <div class="ai-mem ${m.pinned ? 'pinned' : ''}" data-mem="${m.id}">
      <span class="amem-text">${esc(m.text)}</span>
      <span class="amem-acts">
        <button class="ic-btn sm" data-pin title="${m.pinned ? 'Unpin' : 'Pin to top'}">${svg('star', 13)}</button>
        <button class="ic-btn sm" data-edit title="Edit">${svg('rename', 13)}</button>
        <button class="ic-btn sm" data-del title="Delete">${svg('trash', 13)}</button>
      </span>
    </div>`).join('') +
    `<button class="btn ghost sm ai-mem-clear" id="apMemClear">${svg('trash', 13)} Clear all memory</button>`;
  box.querySelectorAll('[data-mem]').forEach(row => {
    const id = row.dataset.mem;
    row.querySelector('[data-del]').onclick = async () => {
      try { await aiMemoryDelete(id); _aiMemory = _aiMemory.filter(x => x.id !== id); renderAiMemory(); } catch (e) { toast(e.message || 'failed', 'close'); }
    };
    row.querySelector('[data-pin]').onclick = async () => {
      const m = _aiMemory.find(x => x.id === id); if (!m) return;
      try { const r = await aiMemoryUpdate(id, { pinned: !m.pinned }); Object.assign(m, r); sortAiMemory(); renderAiMemory(); } catch (e) { toast(e.message || 'failed', 'close'); }
    };
    row.querySelector('[data-edit]').onclick = () => editAiMemoryRow(row, id);
  });
  const clr = document.getElementById('apMemClear');
  if (clr) clr.onclick = () => confirmModal('Clear all memory', 'Permanently remove everything the AI remembers about you. This cannot be undone.', async () => {
    try { await aiMemoryClear(); _aiMemory = []; renderAiMemory(); toast('Memory cleared', 'trash'); } catch (e) { toast(e.message || 'failed', 'close'); }
  });
}
function sortAiMemory() { _aiMemory.sort((a, b) => (b.pinned - a.pinned) || (b.created - a.created)); }
function editAiMemoryRow(row, id) {
  const m = _aiMemory.find(x => x.id === id); if (!m) return;
  row.innerHTML = `<input class="amem-edit" type="text" maxlength="2000" value="${esc(m.text)}">
    <span class="amem-acts"><button class="btn primary sm" data-save>Save</button><button class="btn ghost sm" data-cancel>Cancel</button></span>`;
  const inp = row.querySelector('.amem-edit'); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  const save = async () => {
    const t = inp.value.trim(); if (!t) { renderAiMemory(); return; }
    try { const r = await aiMemoryUpdate(id, { text: t }); Object.assign(m, r); } catch (e) { toast(e.message || 'failed', 'close'); }
    renderAiMemory();
  };
  row.querySelector('[data-save]').onclick = save;
  row.querySelector('[data-cancel]').onclick = renderAiMemory;
  inp.onkeydown = e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') renderAiMemory(); };
}
async function addAiMemoryFromInput() {
  const inp = document.getElementById('apMemNew'); if (!inp) return;
  const t = (inp.value || '').trim(); if (!t) return;
  try {
    const m = await aiMemoryAdd(t);
    _aiMemory.unshift(m); sortAiMemory();
    inp.value = ''; renderAiMemory();
  } catch (e) { toast(e.message || 'Could not add', 'close'); }
}

/* ============================================================
   TOOLS APP — grid of converters & utilities (most "Coming soon")
   ============================================================ */
const BITRATE_PRESETS = [{ v: '320', label: '320 kbps (high)' }, { v: '192', label: '192 kbps (standard)' }, { v: '128', label: '128 kbps (small)' }, { v: '96', label: '96 kbps (tiny)' }];

/* client specs for the REAL tools — must stay in sync with TOOL_SPECS in server.js */
const TOOL_FORMATS = {
  'video-to-audio': { inputKinds: ['video'], hint: 'a video from your vault', formats: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'], def: 'mp3', presets: BITRATE_PRESETS, presetLabel: 'Bitrate', kind: 'audio' },
  'audio-convert': { inputKinds: ['audio'], hint: 'an audio file from your vault', formats: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'], def: 'mp3', presets: BITRATE_PRESETS, presetLabel: 'Bitrate', kind: 'audio' },
  'video-convert': { inputKinds: ['video'], hint: 'a video from your vault', formats: ['mp4', 'ts', 'mkv', 'webm', 'mov', 'avi'], def: 'mp4', presets: null, kind: 'video' },
  'video-compress': { inputKinds: ['video'], hint: 'a video from your vault', formats: ['mp4'], def: 'mp4', lockFormat: true, sizeTarget: true, kind: 'video' },
  'audio-compress': { inputKinds: ['audio'], hint: 'an audio file from your vault', formats: ['mp3'], def: 'mp3', lockFormat: true, sizeTarget: true, kind: 'audio' },
};

const TOOLS = [
  // Minis — mini editors (kept above Media). Only the video editor is built;
  // the photo & audio editors fall through to the Coming-soon template.
  { id: 'mini-video', name: 'Mini Video Editor', icon: 'video', tint: 'video', cat: 'Minis', status: 'ready', desc: 'Cut, caption & remix video — saves straight to your vault.' },
  { id: 'mini-photo', name: 'Mini Photo Editor', icon: 'image', tint: 'image', cat: 'Minis', status: 'soon', desc: 'Crop, adjust & annotate photos.' },
  { id: 'mini-audio', name: 'Mini Audio Editor', icon: 'audio', tint: 'audio', cat: 'Minis', status: 'soon', desc: 'Trim, mix & re-pitch audio tracks.' },
  // Media — the real, working ones
  { id: 'video-to-audio', name: 'Video → Audio', icon: 'audio', tint: 'audio', cat: 'Media', status: 'ready', desc: 'Extract the audio track from any video.' },
  { id: 'audio-convert', name: 'Audio Converter', icon: 'convert', tint: 'audio', cat: 'Media', status: 'ready', desc: 'Convert between mp3, wav, flac, m4a & more.' },
  { id: 'video-convert', name: 'Video Converter', icon: 'video', tint: 'video', cat: 'Media', status: 'ready', desc: 'Convert between mp4, mkv, webm, mov & more.' },
  { id: 'video-compress', name: 'Video Compressor', icon: 'compress', tint: 'video', cat: 'Media', status: 'ready', desc: 'Shrink video to a target size or %.' },
  { id: 'audio-compress', name: 'Audio Compressor', icon: 'compress', tint: 'audio', cat: 'Media', status: 'ready', desc: 'Shrink audio to a target size or %.' },
  // Media — soon
  { id: 'video-to-gif', name: 'Video → GIF', icon: 'image', tint: 'image', cat: 'Media', status: 'soon', desc: 'Turn a clip into an animated GIF.' },
  { id: 'audio-trim', name: 'Audio Trimmer', icon: 'audio', tint: 'audio', cat: 'Media', status: 'soon', desc: 'Cut a clip out of an audio file.' },
  { id: 'video-trim', name: 'Video Trimmer', icon: 'video', tint: 'video', cat: 'Media', status: 'soon', desc: 'Cut a clip out of a video.' },
  { id: 'subtitle-extract', name: 'Subtitle Extractor', icon: 'document', tint: 'document', cat: 'Media', status: 'soon', desc: 'Pull subtitles out of a video.' },
  { id: 'metadata', name: 'Media Metadata', icon: 'info', tint: '', cat: 'Media', status: 'soon', desc: 'Inspect codecs, bitrate, duration.' },
  { id: 'speed-change', name: 'Speed Changer', icon: 'play', tint: 'video', cat: 'Media', status: 'soon', desc: 'Speed up or slow down media.' },
  // Image — canvas-based, run entirely in the browser
  { id: 'image-convert', name: 'Image Converter', icon: 'image', tint: 'image', cat: 'Image', status: 'ready', desc: 'png · jpg · webp.' },
  { id: 'image-compress', name: 'Image Compressor', icon: 'compress', tint: 'image', cat: 'Image', status: 'ready', desc: 'Shrink images without losing much.' },
  { id: 'image-resize', name: 'Image Resizer', icon: 'image', tint: 'image', cat: 'Image', status: 'ready', desc: 'Resize or crop to any dimensions.' },
  { id: 'image-to-pdf', name: 'Images → PDF', icon: 'document', tint: 'document', cat: 'Image', status: 'ready', desc: 'Combine images into a PDF.' },
  { id: 'watermark', name: 'Watermark', icon: 'image', tint: 'image', cat: 'Image', status: 'ready', desc: 'Stamp text onto an image.' },
  { id: 'bg-remove', name: 'Background Remover', icon: 'image', tint: 'image', cat: 'Image', status: 'soon', desc: 'Cut out the subject automatically.' },
  // Document
  { id: 'pdf-to-images', name: 'PDF → Images', icon: 'image', tint: 'image', cat: 'Document', status: 'soon', desc: 'Render each page to an image.' },
  { id: 'pdf-merge', name: 'PDF Merge', icon: 'document', tint: 'document', cat: 'Document', status: 'soon', desc: 'Join several PDFs into one.' },
  { id: 'pdf-split', name: 'PDF Split', icon: 'document', tint: 'document', cat: 'Document', status: 'soon', desc: 'Split a PDF into pages or ranges.' },
  { id: 'pdf-compress', name: 'PDF Compress', icon: 'compress', tint: 'document', cat: 'Document', status: 'soon', desc: 'Reduce a PDF\'s file size.' },
  { id: 'doc-convert', name: 'Document Converter', icon: 'document', tint: 'document', cat: 'Document', status: 'soon', desc: 'docx · odt · txt · rtf.' },
  { id: 'md-to-pdf', name: 'Markdown → PDF', icon: 'document', tint: 'document', cat: 'Document', status: 'ready', desc: 'Render Markdown to a clean PDF.' },
  // Data
  { id: 'csv-json', name: 'CSV ↔ JSON', icon: 'convert', tint: '', cat: 'Data', status: 'ready', desc: 'Convert tabular data both ways.' },
  { id: 'json-format', name: 'JSON Formatter', icon: 'code', tint: '', cat: 'Data', status: 'ready', desc: 'Pretty-print, minify & validate.' },
  { id: 'yaml-json', name: 'YAML ↔ JSON', icon: 'convert', tint: '', cat: 'Data', status: 'ready', desc: 'Convert config formats.' },
  { id: 'base64', name: 'Base64', icon: 'code', tint: '', cat: 'Data', status: 'ready', desc: 'Encode or decode Base64.' },
  { id: 'hash', name: 'Hash Generator', icon: 'lock', tint: '', cat: 'Data', status: 'ready', desc: 'md5 · sha-1 · sha-256.' },
  { id: 'url-encode', name: 'URL Encode', icon: 'link', tint: '', cat: 'Data', status: 'ready', desc: 'Encode or decode URL components.' },
  // Text
  { id: 'case-convert', name: 'Case Converter', icon: 'rename', tint: '', cat: 'Text', status: 'ready', desc: 'UPPER, lower, Title, camelCase…' },
  { id: 'word-count', name: 'Word Counter', icon: 'info', tint: '', cat: 'Text', status: 'ready', desc: 'Words, characters, reading time.' },
  { id: 'lorem', name: 'Lorem Ipsum', icon: 'document', tint: '', cat: 'Text', status: 'ready', desc: 'Generate placeholder text.' },
  { id: 'diff', name: 'Diff Checker', icon: 'code', tint: '', cat: 'Text', status: 'ready', desc: 'Compare two blocks of text.' },
  // Utility
  { id: 'qr', name: 'QR Generator', icon: 'grid', tint: '', cat: 'Utility', status: 'ready', desc: 'Make a QR code from any text/URL.' },
  { id: 'color', name: 'Color Converter', icon: 'image', tint: 'image', cat: 'Utility', status: 'ready', desc: 'hex · rgb · hsl, with a picker.' },
  { id: 'unit', name: 'Unit Converter', icon: 'convert', tint: '', cat: 'Utility', status: 'ready', desc: 'Length, weight, temperature & more.' },
  { id: 'timestamp', name: 'Timestamp Converter', icon: 'clock', tint: '', cat: 'Utility', status: 'ready', desc: 'Unix epoch ↔ human dates.' },
  { id: 'password', name: 'Password Generator', icon: 'lock', tint: '', cat: 'Utility', status: 'ready', desc: 'Strong, random passwords.' },
  // Game — asset tooling for game makers
  { id: 'material-mgr', name: 'Material Manager', icon: 'cube', tint: 'image', cat: 'Game', status: 'ready', desc: 'Build UE5-style PBR materials from your textures — preview & export.' },
];

/* ============================================================
   UNIFIED CONVERSION MAP — single source of truth for "what can this
   file become, and who does the work". Drives BOTH the Tools-app pickers
   and the right-click "Convert to..." submenu in the Database. Each entry
   maps a SOURCE extension to its possible target formats and the engine:
     · server tool (ffmpeg, via convertTool) — media
     · client canvas — images (png/jpg/webp), no server round-trip
   Keep the format lists in step with TOOL_SPECS on the server.
   ============================================================ */
const CONV_VIDEO_EXTS = ['mp4', 'ts', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v', 'wmv', 'mpg', 'mpeg', '3gp'];
const CONV_AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'];
const CONV_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
// EXR/TIFF can't be decoded by an <img>/canvas, so they convert server-side (ffmpeg).
const CONV_IMAGE_SERVER_EXTS = ['exr', 'tif', 'tiff'];
const CONV_VIDEO_TARGETS = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'ts'];
const CONV_AUDIO_TARGETS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'];
const CONV_IMAGE_TARGETS = ['png', 'jpg', 'webp'];
// formats only the server (ffmpeg) can write — offered for every image source.
const CONV_IMAGE_SERVER_TARGETS = ['tiff', 'exr'];

/* Conversion options for a vault file: a flat list of
   { format, engine, tool } the file can be turned into (excluding its own
   current format). engine is 'server' (ffmpeg) or 'image' (canvas). */
function conversionTargetsFor(f) {
  if (!f || f.type === 'folder') return [];
  const ext = (fileExt(f.name) || '').toLowerCase();
  const out = [];
  if (f.type === 'video' || CONV_VIDEO_EXTS.includes(ext)) {
    // video → other video containers (video-convert) AND video → audio (video-to-audio)
    CONV_VIDEO_TARGETS.forEach(fmt => { if (fmt !== ext) out.push({ format: fmt, engine: 'server', tool: 'video-convert', group: 'Video' }); });
    CONV_AUDIO_TARGETS.forEach(fmt => out.push({ format: fmt, engine: 'server', tool: 'video-to-audio', group: 'Audio' }));
  } else if (f.type === 'audio' || CONV_AUDIO_EXTS.includes(ext)) {
    CONV_AUDIO_TARGETS.forEach(fmt => { if (fmt !== ext) out.push({ format: fmt, engine: 'server', tool: 'audio-convert', group: 'Audio' }); });
  } else if (CONV_IMAGE_SERVER_EXTS.includes(ext)) {
    // EXR/TIFF source — the browser can't decode these, so ALL targets go through
    // the server image-convert tool (png/jpg/webp/bmp + tiff/exr).
    const norm = ext === 'tif' ? 'tiff' : ext;
    [...CONV_IMAGE_TARGETS, ...CONV_IMAGE_SERVER_TARGETS].forEach(fmt => {
      if (fmt !== norm) out.push({ format: fmt, engine: 'server', tool: 'image-convert', group: 'Image' });
    });
  } else if (f.type === 'image' || CONV_IMAGE_EXTS.includes(ext)) {
    // Standard image: png/jpg/webp convert in-browser (fast, offline). tiff/exr
    // can only be written server-side, so those targets use the image-convert tool.
    CONV_IMAGE_TARGETS.forEach(fmt => { if (fmt !== ext && !(fmt === 'jpg' && ext === 'jpeg')) out.push({ format: fmt, engine: 'image', group: 'Image' }); });
    CONV_IMAGE_SERVER_TARGETS.forEach(fmt => out.push({ format: fmt, engine: 'server', tool: 'image-convert', group: 'Image' }));
  }
  return out;
}

/* Fetch a vault file's decrypted bytes as a browser File object (handles
   locked items via the in-browser decrypt path). Used by the client image
   tools and the native image converter so they can read straight from the
   vault — no upload required. */
async function vaultFileToFile(f) {
  if (!f) throw new Error('No file');
  const mime = _mimeForName(f.name, f.type);
  if (_looksLocked(f)) {
    const pass = await unlockItemForUse(f);
    if (pass == null) throw new Error('cancelled');
    const bytes = await _decryptItemBytes(f, pass);
    return new File([bytes], f.name, { type: mime });
  }
  const url = mediaUrl(f) || ('/api/files/' + f.id + '/raw');
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not read that file from your vault');
  const blob = await res.blob();
  return new File([blob], f.name, { type: blob.type || mime });
}

/* Convert an IMAGE vault file to png/jpg/webp entirely in the browser (canvas),
   then upload the result into the same folder. Returns the new vault record. */
async function convertImageInBrowser(f, format) {
  const file = await vaultFileToFile(f);
  const img = await ctReadImageFile(file);
  const mime = format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  const canvas = document.createElement('canvas');
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }   // flatten transparency for JPG
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.92));
  if (!blob) throw new Error("This browser couldn't encode that format.");
  const base = (f.name.replace(/\.[^.]+$/, '') || 'image');
  const parent = f.parent ?? null;
  const outName = uniqueNameIn(parent, base + '.' + format);
  const outFile = new File([blob], outName, { type: mime });
  const w = img.width, h = img.height;
  try { URL.revokeObjectURL(img.src); } catch (e) {}
  return uploadFile(outFile, parent, { type: 'image', w, h });
}

/* pick a name that doesn't collide with existing (non-trashed) files in a folder,
   appending " (2)", " (3)", … before the extension — mirroring the server's
   dedupeName so client-side saves don't quietly create same-named duplicates. */
function uniqueNameIn(parent, name) {
  const taken = new Set(children(parent).map(c => c.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n < 1000; n++) { const cand = `${stem} (${n})${ext}`; if (!taken.has(cand.toLowerCase())) return cand; }
  return name;
}

/* tiny indeterminate "working…" modal for native conversions. Returns a close fn. */
function convertingModal(title) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h3>${esc(title)}</h3>
    <div class="tool-prog indet" style="margin:14px 0 4px"><i></i></div>
    <p class="mono dim" id="cvMsg">Working…</p></div>`;
  document.body.appendChild(bg);
  return { setMsg(m) { const e = bg.querySelector('#cvMsg'); if (e) e.textContent = m; }, close() { bg.remove(); } };
}

/* The native "Convert to…" action. Picks the right engine for the file and
   saves the result straight into the vault (no Tools-app round-trip, no upload
   prompt). `target` is one entry from conversionTargetsFor(). */
async function convertFileTo(f, target) {
  if (!f || !target) return;
  if (_looksLocked(f)) {
    // server-side media conversion can't read an encrypted blob; require unlocking first.
    if (target.engine === 'server') { toast('Unlock this file before converting it', 'lock'); return; }
  }
  const m = convertingModal(`Converting to ${target.format.toUpperCase()}…`);
  try {
    let rec;
    if (target.engine === 'image') {
      rec = await convertImageInBrowser(f, target.format);
    } else {
      const r = await convertTool({ tool: target.tool, fileId: f.id, format: target.format, output: 'save' });
      rec = r.file;
    }
    m.close();
    if (rec) {
      toast(`Converted to ${rec.name}`, 'check');
      try { render(); } catch (e) {}
    } else {
      toast('Converted', 'check');
    }
  } catch (e) {
    m.close();
    if (e && e.message === 'cancelled') return;     // user dismissed the unlock prompt
    toast(e && e.message ? e.message : 'Conversion failed', 'close');
  }
}

/* ---- native "Compress…" (right in the file browser) ----
   Same server engine as the Tools-app compressors (video-compress / audio-compress
   via convertTool), but reachable straight from a file's right-click menu. Only
   video/audio can be compressed this way (image compression is a browser-canvas
   tool, offered separately). The result is saved as a NEW file beside the
   original — the original is kept. */
function canCompress(f) {
  if (!f || f.type === 'folder') return false;
  const ext = (fileExt(f.name) || '').toLowerCase();
  return f.type === 'video' || f.type === 'audio' || CONV_VIDEO_EXTS.includes(ext) || CONV_AUDIO_EXTS.includes(ext);
}
function compressKind(f) {
  const ext = (fileExt(f.name) || '').toLowerCase();
  return (f.type === 'video' || CONV_VIDEO_EXTS.includes(ext)) ? 'video' : 'audio';
}

/* The "Compress…" dialog: pick percent-of-original or a target size, then run the
   server compressor and save the shrunk copy into the same folder. */
function openCompressDialog(f) {
  if (!f || !canCompress(f)) return;
  if (_looksLocked(f)) { toast('Unlock this file before compressing it', 'lock'); return; }
  const kind = compressKind(f);
  const tool = kind === 'video' ? 'video-compress' : 'audio-compress';
  const outFmt = kind === 'video' ? 'mp4' : 'mp3';   // the compressors' fixed target (matches TOOL_SPECS)

  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">
    <h3>${svg('compress', 16)} Compress ${kind === 'video' ? 'video' : 'audio'}</h3>
    <p class="mono dim" style="margin:-2px 0 12px">${esc(f.name)} · ${fmtSize(f.size)}</p>
    <div class="tool-opt"><span class="eyebrow">Compress by</span>
      <div class="seg set-seg" id="cmpMode"><button type="button" data-m="percent" class="on">Percentage</button><button type="button" data-m="size">Target size</button></div>
    </div>
    <label class="tool-opt"><span class="eyebrow" id="cmpLabel">Percent of original</span>
      <div class="size-val"><input type="number" id="cmpVal" class="tool-num" value="50" min="1" max="99" step="1"><span class="size-unit" id="cmpUnit">%</span></div>
    </label>
    <div class="size-hint mono" id="cmpHint"></div>
    <div class="tool-result" id="cmpResult"></div>
    <div class="acts" style="margin-top:14px">
      <button class="btn ghost" id="cmpCancel">Cancel</button>
      <button class="btn primary" id="cmpGo">${svg('compress', 15)} Compress</button>
    </div>
  </div>`;
  document.body.appendChild(bg);

  let mode = 'percent';
  const seg = bg.querySelector('#cmpMode'), valEl = bg.querySelector('#cmpVal');
  const unitEl = bg.querySelector('#cmpUnit'), labelEl = bg.querySelector('#cmpLabel');
  const hintEl = bg.querySelector('#cmpHint'), resultEl = bg.querySelector('#cmpResult');
  const goBtn = bg.querySelector('#cmpGo'), cancelBtn = bg.querySelector('#cmpCancel');
  const updateHint = () => {
    if (mode === 'percent') {
      const pct = Math.min(99, Math.max(1, parseFloat(valEl.value) || 0));
      hintEl.textContent = `${fmtSize(f.size)} → aiming for about ${fmtSize(f.size * pct / 100)}`;
    } else {
      hintEl.textContent = `Original is ${fmtSize(f.size)} — actual result may vary slightly from the target.`;
    }
  };
  seg.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
    mode = b.dataset.m;
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (mode === 'percent') { labelEl.textContent = 'Percent of original'; unitEl.textContent = '%'; valEl.min = '1'; valEl.max = '99'; valEl.step = '1'; valEl.value = '50'; }
    else { labelEl.textContent = 'Target size'; unitEl.textContent = 'MB'; valEl.min = '0.1'; valEl.removeAttribute('max'); valEl.step = '0.1'; valEl.value = String(Math.max(0.1, Math.round(f.size / 1048576 * 0.5 * 10) / 10)); }
    updateHint();
  });
  valEl.oninput = updateHint;
  updateHint();

  const close = () => { if (_toolAbort) { try { _toolAbort.abort(); } catch (e) {} _toolAbort = null; } bg.remove(); };
  cancelBtn.onclick = close;
  bg.onclick = (e) => { if (e.target === bg) close(); };

  goBtn.onclick = async () => {
    const value = valEl.value;
    if (mode === 'size' && (!(parseFloat(value) > 0))) { toast('Enter a target size in MB', 'close'); return; }
    goBtn.disabled = true; cancelBtn.disabled = true;
    resultEl.innerHTML = `<div class="tool-working" style="margin-top:12px">
      <div class="tw-top"><span class="mono" id="twLabel">Compressing…</span></div>
      <div class="tool-prog indet"><i id="twBar"></i></div>
    </div>`;
    _toolAbort = new AbortController();
    const poll = startToolProgressPoll('Compressing');
    try {
      const r = await convertTool({ tool, fileId: f.id, format: outFmt, mode, value, output: 'save', signal: _toolAbort.signal });
      poll.stop(); _toolAbort = null;
      const saved = r.file;
      const pctOfOrig = r.srcSize ? Math.round((r.outSize / r.srcSize) * 100) : null;
      close();
      toast(pctOfOrig != null
        ? `Compressed to ${saved ? saved.name : outFmt.toUpperCase()} · ${fmtSize(r.outSize)} (${pctOfOrig}% of original)`
        : `Compressed · ${fmtSize(r.outSize)}`, 'check');
      try { render(); } catch (e) {}
    } catch (e) {
      poll.stop(); _toolAbort = null;
      if (e && (e.name === 'AbortError' || e.message === 'aborted')) { close(); return; }
      goBtn.disabled = false; cancelBtn.disabled = false;
      resultEl.innerHTML = `<p class="mono" style="color:var(--danger,#e0574a);margin-top:10px">${esc(e && e.message ? e.message : 'Compression failed')}</p>`;
    }
  };
}

let _toolView = 'grid', _toolAbort = null, _toolsFfmpeg = true;

function toolsHTML() { return `<div class="tools-app" id="toolsApp"><div class="dim mono pad-sm">Loading…</div></div>`; }
async function wireTools() {
  _toolView = 'grid';
  _appCleanup = () => { if (_toolAbort) { try { _toolAbort.abort(); } catch (e) {} _toolAbort = null; } };
  try { const info = await toolsInfo(); _toolsFfmpeg = !!info.ffmpeg; } catch (e) { _toolsFfmpeg = true; }
  renderToolsGrid();
}
function renderToolsGrid() {
  _toolView = 'grid';
  const app = document.getElementById('toolsApp'); if (!app) return;
  const cats = [...new Set(TOOLS.map(t => t.cat))];
  app.innerHTML = `<div class="tools-grid-wrap">
    <div class="tools-intro"><div class="big">Tools</div><div class="sub mono">quick converters & utilities — more coming soon</div></div>
    ${cats.map(cat => `<div class="tools-cat">
      <span class="eyebrow">${esc(cat)}</span>
      <div class="tool-grid">${TOOLS.filter(t => t.cat === cat).map(toolTileHTML).join('')}</div>
    </div>`).join('')}
  </div>`;
  app.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => openTool(b.dataset.tool));
  syncUrl();
}
function toolTileHTML(t) {
  const soon = t.status !== 'ready';
  return `<button class="tool-tile${soon ? ' soon' : ''}" data-tool="${t.id}">
    ${soon ? '<span class="soon-rib">Soon</span>' : ''}
    <span class="tt-ico bg-${t.tint || 'folder'} t-${t.tint || 'folder'}">${svg(t.icon, 19, 1.7)}</span>
    <span class="tt-name">${esc(t.name)}</span>
    <span class="tt-desc">${esc(t.desc)}</span>
  </button>`;
}
function toolBackBar(t) { return `<div class="tool-topbar"><button class="btn ghost sm" data-toolback>${svg('back', 14)} All tools</button><div class="tool-title"><span class="t-${t.tint || 'folder'}">${svg(t.icon, 16)}</span>${esc(t.name)}</div></div>`; }

/* The ids handled by tools-clients.js (browser-only tools). Kept in core so
   openTool can route to the lazy file without the CLIENT_TOOLS map being loaded.
   MUST stay in sync with the CLIENT_TOOLS registry in tools-clients.js. */
const CLIENT_TOOL_IDS = new Set([
  'csv-json', 'json-format', 'yaml-json', 'base64', 'hash', 'url-encode',
  'case-convert', 'word-count', 'lorem', 'diff', 'qr', 'color', 'unit',
  'timestamp', 'password', 'image-convert', 'image-compress', 'image-resize',
  'image-to-pdf', 'watermark', 'md-to-pdf',
]);
async function openTool(id) {
  const t = TOOLS.find(x => x.id === id); if (!t) return;
  _toolView = id;
  if (typeof trackEvent === 'function' && t.status === 'ready') trackEvent('tool_use', { tool: id });   // Analytics app
  syncUrl();
  const app = document.getElementById('toolsApp'); if (!app) return;
  if (t.status !== 'ready') {
    app.innerHTML = toolBackBar(t) + `<div class="coming"><div class="cs-ico bg-${t.tint || 'folder'} t-${t.tint || 'folder'}">${svg(t.icon, 40, 1.5)}</div><div class="cs-badge eyebrow">Coming soon</div><h2>${esc(t.name)}</h2><p>${esc(t.desc)}</p><p class="cs-note mono">This one isn't built yet — it'll light up here soon.</p><button class="btn ghost" data-toolback>${svg('back', 14)} Back to tools</button></div>`;
    app.querySelectorAll('[data-toolback]').forEach(b => b.onclick = renderToolsGrid);
    return;
  }
  // The Mini Video Editor is its own full editor, not a one-shot converter panel.
  // Its code lives in video-editor.js, loaded on demand (not at boot).
  if (id === 'mini-video') {
    app.innerHTML = toolBackBar(t) + `<div class="dim mono pad-sm">Loading editor…</div>`;
    app.querySelectorAll('[data-toolback]').forEach(b => b.onclick = renderToolsGrid);
    try { await loadFeature('video-editor'); } catch (e) {
      app.innerHTML = toolBackBar(t) + `<div class="tool-err mono">${svg('close', 14)} Couldn't load the video editor — check your connection.</div>`;
      app.querySelectorAll('[data-toolback]').forEach(b => b.onclick = renderToolsGrid);
      return;
    }
    if (_toolView !== 'mini-video' || !document.getElementById('toolsApp')) return;   // navigated away
    app.innerHTML = toolBackBar(t) + mveEditorHTML(t);
    app.querySelectorAll('[data-toolback]').forEach(b => b.onclick = renderToolsGrid);
    wireMiniVideoEditor(t);
    return;
  }
  // The Material Manager is its own full editor (node graph + WebGL preview),
  // not a one-shot converter panel. Its code lives in material-editor.js, loaded
  // on demand (not at boot). Mirrors the Mini Video Editor flow above.
  if (id === 'material-mgr') {
    app.innerHTML = toolBackBar(t) + `<div class="dim mono pad-sm">Loading editor…</div>`;
    app.querySelectorAll('[data-toolback]').forEach(b => b.onclick = renderToolsGrid);
    try { await loadFeature('material-editor'); } catch (e) {
      app.innerHTML = toolBackBar(t) + `<div class="tool-err mono">${svg('close', 14)} Couldn't load the Material Manager — check your connection.</div>`;
      app.querySelectorAll('[data-toolback]').forEach(b => b.onclick = renderToolsGrid);
      return;
    }
    if (_toolView !== 'material-mgr' || !document.getElementById('toolsApp')) return;   // navigated away
    app.innerHTML = toolBackBar(t) + matEditorHTML(t);
    app.querySelectorAll('[data-toolback]').forEach(b => b.onclick = renderToolsGrid);
    wireMaterialEditor(t);
    return;
  }
  // Client-side tools (Data, Text, Utility, Image, md→pdf) run entirely in the
  // browser — no server round-trip, no ffmpeg. Their code lives in tools-clients.js,
  // loaded on demand (not at boot). We know an id is a client tool from the static
  // CLIENT_TOOL_IDS set below, so routing doesn't need the (lazy) CLIENT_TOOLS map.
  if (CLIENT_TOOL_IDS.has(id)) {
    app.innerHTML = toolBackBar(t) + `<div class="ctool" id="ctoolBody"><div class="dim mono pad-sm">Loading…</div></div>`;
    app.querySelectorAll('[data-toolback]').forEach(b => b.onclick = renderToolsGrid);
    const body = () => document.getElementById('ctoolBody');
    try {
      await loadFeature('tools-clients');
      if (_toolView !== id || !body()) return;   // user navigated away while it loaded
      CLIENT_TOOLS[id](body(), t);
    } catch (e) {
      if (body()) body().innerHTML = `<div class="tool-err mono">${svg('close', 14)} ${esc(e.message || 'Could not open this tool')}</div>`;
    }
    return;
  }
  const spec = TOOL_FORMATS[id];
  if (!_toolsFfmpeg) {
    app.innerHTML = toolBackBar(t) + `<div class="coming"><div class="cs-ico bg-${t.tint} t-${t.tint}">${svg(t.icon, 40, 1.5)}</div><h2>${esc(t.name)}</h2><p class="cs-note mono">ffmpeg isn't installed on the server, so media tools are unavailable.</p><button class="btn ghost" data-toolback>${svg('back', 14)} Back to tools</button></div>`;
    app.querySelectorAll('[data-toolback]').forEach(b => b.onclick = renderToolsGrid);
    return;
  }
  app.innerHTML = toolBackBar(t) + `
    <div class="tool-panel">
      <button class="tool-pick" id="toolPick">
        <span class="tp-ico">${svg('files', 24, 1.5)}</span>
        <span class="tp-text"><span class="tp-big" id="toolPickTitle">Choose a file from your vault</span><span class="tp-sub mono">${esc(spec.hint)} · upload big files in the Database first</span></span>
        <span class="tp-act" id="toolPickAct">Browse ›</span>
      </button>
      <div class="tool-opts">
        ${spec.lockFormat ? '' : `<label class="tool-opt"><span class="eyebrow">Output format</span><select class="set-select" id="toolFormat">${spec.formats.map(f => `<option value="${f}" ${f === spec.def ? 'selected' : ''}>${f.toUpperCase()}</option>`).join('')}</select></label>`}
        ${spec.presets ? `<label class="tool-opt"><span class="eyebrow">${esc(spec.presetLabel || 'Quality')}</span><select class="set-select" id="toolPreset">${spec.presets.map(p => `<option value="${p.v}">${esc(p.label)}</option>`).join('')}</select></label>` : ''}
        ${spec.sizeTarget ? `
        <div class="tool-opt"><span class="eyebrow">Compress by</span>
          <div class="seg set-seg" id="toolSizeMode"><button type="button" data-m="percent" class="on">Percentage</button><button type="button" data-m="size">Target size</button></div>
        </div>
        <label class="tool-opt"><span class="eyebrow" id="toolSizeLabel">Percent of original</span>
          <div class="size-val"><input type="number" id="toolSizeVal" class="tool-num" value="50" min="1" max="99" step="1"><span class="size-unit" id="toolSizeUnit">%</span></div>
        </label>` : ''}
        <label class="tool-opt"><span class="eyebrow">When finished</span>
          <div class="seg set-seg" id="toolOutput"><button type="button" data-o="download" class="on">Download</button><button type="button" data-o="save">Save to vault</button><button type="button" data-o="replace">Replace original</button></div>
        </label>
        <button class="btn primary tool-go" id="toolConvert" disabled>${svg(spec.sizeTarget ? 'compress' : 'convert', 15)} ${spec.sizeTarget ? 'Compress' : 'Convert'}</button>
      </div>
      ${spec.sizeTarget ? `<div class="size-hint mono" id="toolSizeHint"></div>` : ''}
      <div class="tool-result" id="toolResult"></div>
    </div>`;
  app.querySelectorAll('[data-toolback]').forEach(b => b.onclick = renderToolsGrid);
  wireToolPanel(t, spec);
}

function wireToolPanel(t, spec) {
  const pickBtn = document.getElementById('toolPick'), titleEl = document.getElementById('toolPickTitle');
  const actEl = document.getElementById('toolPickAct'), convertBtn = document.getElementById('toolConvert');
  let chosen = null, afterFile = null, output = 'download';

  const setFile = (f) => {
    if (!f) return;
    chosen = f;
    titleEl.textContent = f.name + '  ·  ' + fmtSize(f.size);
    if (actEl) actEl.textContent = 'Change';
    pickBtn.classList.add('has');
    convertBtn.disabled = false;
    if (afterFile) afterFile();
  };
  pickBtn.onclick = () => pickVaultFile({ kinds: spec.inputKinds, onPick: setFile });

  // output destination: download / save new / replace
  const outSeg = document.getElementById('toolOutput');
  outSeg.querySelectorAll('[data-o]').forEach(b => b.onclick = () => {
    output = b.dataset.o;
    outSeg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  });

  // compressors: "compress by percentage / target size"
  let sizeMode = 'percent';
  if (spec.sizeTarget) {
    const seg = document.getElementById('toolSizeMode'), valEl = document.getElementById('toolSizeVal');
    const unitEl = document.getElementById('toolSizeUnit'), labelEl = document.getElementById('toolSizeLabel');
    const hintEl = document.getElementById('toolSizeHint');
    const updateHint = () => {
      if (!chosen) { hintEl.textContent = 'Choose a file to see an estimate.'; return; }
      if (sizeMode === 'percent') {
        const pct = Math.min(99, Math.max(1, parseFloat(valEl.value) || 0));
        hintEl.textContent = `${fmtSize(chosen.size)} → aiming for about ${fmtSize(chosen.size * pct / 100)}`;
      } else {
        hintEl.textContent = `Original is ${fmtSize(chosen.size)} — actual result may vary slightly from the target.`;
      }
    };
    afterFile = updateHint;
    seg.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
      sizeMode = b.dataset.m;
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      if (sizeMode === 'percent') { labelEl.textContent = 'Percent of original'; unitEl.textContent = '%'; valEl.min = '1'; valEl.max = '99'; valEl.step = '1'; valEl.value = '50'; }
      else { labelEl.textContent = 'Target size'; unitEl.textContent = 'MB'; valEl.min = '0.1'; valEl.removeAttribute('max'); valEl.step = '0.1'; valEl.value = chosen ? String(Math.max(0.1, Math.round(chosen.size / 1048576 * 0.5 * 10) / 10)) : '5'; }
      updateHint();
    });
    valEl.oninput = updateHint;
    updateHint();
  }

  const run = async () => {
    if (!chosen) return;
    const format = spec.lockFormat ? spec.def : document.getElementById('toolFormat').value;
    const presetEl = document.getElementById('toolPreset');
    const preset = presetEl ? presetEl.value : '';
    const sizeVal = spec.sizeTarget ? document.getElementById('toolSizeVal').value : '';
    const resultEl = document.getElementById('toolResult');
    const verb = spec.sizeTarget ? 'Compressing' : 'Converting';
    convertBtn.disabled = true;
    resultEl.innerHTML = `<div class="tool-working">
      <div class="tw-top"><span class="mono" id="twLabel">${verb}…</span><button class="btn ghost sm" id="toolCancel">Cancel</button></div>
      <div class="tool-prog indet"><i id="twBar"></i></div>
    </div>`;
    document.getElementById('toolCancel').onclick = () => { if (_toolAbort) _toolAbort.abort(); };
    _toolAbort = new AbortController();
    const poll = startToolProgressPoll(verb);
    try {
      const r = await convertTool({ tool: t.id, fileId: chosen.id, format, preset, mode: spec.sizeTarget ? sizeMode : undefined, value: spec.sizeTarget ? sizeVal : undefined, output, signal: _toolAbort.signal });
      if (r.kind === 'download') {
        const url = URL.createObjectURL(r.blob);
        const outName = chosen.name.replace(/\.[^.]+$/, '') + '.' + format;
        const ratio = chosen.size ? Math.round((1 - r.blob.size / chosen.size) * 100) : 0;
        const prev = spec.kind === 'audio' ? `<audio controls src="${url}" class="tool-prev"></audio>` : spec.kind === 'video' ? `<video controls src="${url}" class="tool-prev"></video>` : '';
        resultEl.innerHTML = `<div class="tool-done">
          <div class="td-row"><span class="td-ok">${svg('check', 16)} Done</span><span class="mono dim">${fmtSize(chosen.size)} → ${fmtSize(r.blob.size)}${ratio > 0 ? ' · ' + ratio + '% smaller' : ''}</span></div>
          ${prev}
          <a class="btn primary" href="${url}" download="${esc(outName)}">${svg('download', 15)} Download ${esc(outName)}</a>
        </div>`;
      } else {
        const f = r.file, ratio = r.srcSize ? Math.round((1 - r.outSize / r.srcSize) * 100) : 0;
        const what = r.output === 'replace' ? `Replaced <b>${esc(f.name)}</b>` : `Saved <b>${esc(f.name)}</b> to your vault`;
        resultEl.innerHTML = `<div class="tool-done">
          <div class="td-row"><span class="td-ok">${svg('check', 16)} ${what}</span><span class="mono dim">${fmtSize(r.srcSize)} → ${fmtSize(r.outSize)}${ratio > 0 ? ' · ' + ratio + '% smaller' : ''}</span></div>
          <button class="btn ghost" id="toolGoDb">${svg('database', 15)} Show in Database</button>
        </div>`;
        const go = document.getElementById('toolGoDb'); if (go) go.onclick = () => openApp('database');
        // if we replaced the chosen file, reflect its new name/size in the picker
        if (r.output === 'replace') setFile({ id: f.id, name: f.name, size: f.size, type: f.type });
      }
    } catch (e) {
      resultEl.innerHTML = e.name === 'AbortError'
        ? `<div class="tool-err mono">Cancelled.</div>`
        : `<div class="tool-err mono">${svg('close', 14)} ${esc(e.message || 'Conversion failed')}</div>`;
    } finally { poll.stop(); _toolAbort = null; convertBtn.disabled = false; }
  };

  convertBtn.onclick = () => {
    if (!chosen) return;
    if (output === 'replace') confirmModal('Replace original?', `This overwrites “${chosen.name}” in your vault with the converted result. This can't be undone.`, run, 'Replace');
    else run();
  };
}

/* poll the server's live conversion progress and drive the progress bar.
   Falls back to an indeterminate (striped) bar when duration is unknown. */
function startToolProgressPoll(verb) {
  let stopped = false, timer = null;
  const phaseLabel = { processing: verb + '…', saving: 'Saving to vault…', download: 'Preparing download…' };
  const tick = async () => {
    if (stopped) return;
    let p = null; try { p = await toolProgress(); } catch (e) {}
    if (stopped) return;
    const bar = document.getElementById('twBar'), lbl = document.getElementById('twLabel'), wrap = document.querySelector('.tool-prog');
    if (bar && wrap) {
      if (p && p.active && p.pct != null) {
        wrap.classList.remove('indet'); bar.style.width = p.pct + '%';
        if (lbl) lbl.textContent = `${phaseLabel[p.phase] || verb + '…'} ${p.pct}%`;
      } else {
        wrap.classList.add('indet'); bar.style.width = '';
        if (lbl) lbl.textContent = p && p.active ? (phaseLabel[p.phase] || verb + '…') : (verb + '…');
      }
    }
    timer = setTimeout(tick, 650);
  };
  timer = setTimeout(tick, 350);
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

/* CLIENT TOOLS were extracted to tools-clients.js (lazy-loaded via loadFeature
   in openTool). These two helpers stay here because AI codeblocks and native
   image-convert use them even when tools-clients.js has not been loaded. */
/* lazy-load a CDN script once, mirroring how three.js is loaded for the 3D viewer */
const _ctScripts = {};
function ctLoadScript(src) {
  if (_ctScripts[src]) return _ctScripts[src];
  _ctScripts[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = src; s.async = true;
    s.onload = () => resolve(); s.onerror = () => { delete _ctScripts[src]; reject(new Error('Could not load a required library — check your connection.')); };
    document.head.appendChild(s);
  });
  return _ctScripts[src];
}
function ctReadImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => { resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}

/* reusable vault file picker (used by the Tools app). kinds = ['video'] etc. */
async function pickVaultFile({ kinds, onPick }) {
  try { await ensureAiDB(); } catch (e) { toast('Could not load your files', 'close'); return; }
  const all = DB.files.filter(f => !f.trashed && f.type !== 'folder' && (!kinds || kinds.includes(f.type)));
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal picker-modal">
    <h3>Choose a file</h3>
    <p>Pick from your vault${kinds ? ' (' + kinds.join(' & ') + ' files)' : ''}. Big files? Upload them in the Database app first — they're not size-capped there.</p>
    <input type="text" class="picker-search" id="pkSearch" placeholder="Search files…">
    <div class="picker-list" id="pkList"></div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  const listEl = bg.querySelector('#pkList');
  const iconFor = (ty) => ty === 'video' ? 'video' : ty === 'audio' ? 'audio' : ty === 'image' ? 'image' : 'document';
  const render = (q) => {
    let items = all;
    if (q) { const s = q.toLowerCase(); items = all.filter(f => f.name.toLowerCase().includes(s)); }
    items = items.slice(0, 300);
    if (!items.length) { listEl.innerHTML = `<div class="picker-empty dim mono">${all.length ? 'No matches.' : 'No matching files yet — upload some in the Database app.'}</div>`; return; }
    listEl.innerHTML = items.map(f => `<button class="picker-item" data-id="${f.id}"><span class="pi-ic t-${f.type}">${svg(iconFor(f.type), 16)}</span><span class="pi-main"><span class="pi-name">${esc(f.name)}</span><span class="pi-sub mono">${esc(aiPathOf(f))} · ${fmtSize(f.size)}</span></span></button>`).join('');
    listEl.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { const f = all.find(x => x.id === b.dataset.id); close(); onPick(f); });
  };
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  const search = bg.querySelector('#pkSearch'); search.oninput = () => render(search.value.trim());
  render(''); search.focus();
}

/* small single-field text modal (project name / save-as). Resolves the value or
   null on cancel. Reuses the shared .modal-bg / .modal markup. */
function mvePromptModal({ title, label, value = '', okLabel = 'Save', placeholder = '' }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal"><h3>${esc(title)}</h3>
      <label class="login-field"><span class="eyebrow">${esc(label)}</span>
        <input type="text" class="mve-input" id="mvePrompt" value="${esc(value)}" placeholder="${esc(placeholder)}"></label>
      <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>${esc(okLabel)}</button></div></div>`;
    document.body.appendChild(bg);
    const inp = bg.querySelector('#mvePrompt');
    const close = (v) => { bg.remove(); resolve(v); };
    bg.querySelector('[data-cancel]').onclick = () => close(null);
    bg.querySelector('[data-ok]').onclick = () => { const v = inp.value.trim(); close(v || null); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = inp.value.trim(); close(v || null); } if (e.key === 'Escape') close(null); };
    bg.onclick = e => { if (e.target === bg) close(null); };
    inp.focus(); inp.select();
  });
}

/* MINI VIDEO EDITOR was extracted to video-editor.js (lazy-loaded via
   loadFeature in openTool). Its entry points mveEditorHTML + wireMiniVideoEditor
   are defined there; mvePromptModal (above) stays in core, shared with save-as. */

/* ============================================================
   CONNECTORS — marketplace-style, data-driven. The catalog (built-ins + future
   user-published) all share one shape; installing one creates a configured
   per-account instance. The Schedule connector pings you via notifications.
   ============================================================ */
let _connCatalog = [], _connInstalled = [];
const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function connectorsHTML() {
  return `<div class="conn-app" id="connApp"><div class="dim mono pad-sm">Loading…</div></div>`;
}
async function wireConnectors() {
  try {
    const [cat, inst] = await Promise.all([connectorCatalog(), listConnectors()]);
    _connCatalog = cat.catalog || []; _connInstalled = inst || [];
  } catch (e) { if (e && e.code === 'AUTH') return relock(); _connCatalog = []; _connInstalled = []; }
  renderConnectors();
}
function catEntry(type) { return _connCatalog.find(c => c.id === type); }
function connectorsHTMLBody() {
  const installed = _connInstalled;
  const connectedHTML = installed.length ? installed.map(connCardHTML).join('')
    : `<div class="conn-empty"><div class="ico">${svg('plug', 24, 1.4)}</div><p>No connectors yet. Add one to automate your workspace.</p></div>`;
  return `<div class="conn-wrap">
    <div class="conn-head">
      <div><div class="big">Connectors</div><div class="sub mono">link services &amp; automate — ${installed.length} connected</div></div>
      <button class="btn primary" id="connAdd">${svg('plus', 15)} Add connector</button>
    </div>
    <div class="conn-section"><span class="eyebrow">Connected</span><div class="conn-list">${connectedHTML}</div></div>
    <div class="conn-note mono">Connectors are built on an open, marketplace-style system — every built-in here is defined exactly the way a shared community connector would be.</div>
  </div>`;
}
function renderConnectors() {
  const app = document.getElementById('connApp'); if (!app) return;
  app.innerHTML = connectorsHTMLBody();
  app.querySelector('#connAdd').onclick = openAddConnector;
  app.querySelectorAll('[data-conn]').forEach(card => wireConnCard(card));
}
function connSummary(c) {
  const e = catEntry(c.type);
  if (c.type === 'schedule') {
    const cfg = c.config || {};
    const days = Array.isArray(cfg.days) && cfg.days.length ? (cfg.days.length === 7 ? 'every day' : cfg.days.slice().sort().map(d => DAY_LABELS[d]).join(' ')) : 'every day';
    return `${cfg.time || '—'} · ${days}`;
  }
  return e ? e.category : c.type;
}
function connCardHTML(c) {
  const e = catEntry(c.type) || { name: c.type, icon: 'plug' };
  return `<div class="conn-card${c.enabled ? '' : ' off'}" data-conn="${c.id}">
    <span class="cc-ico">${svg(e.icon || 'plug', 18, 1.7)}</span>
    <div class="cc-main">
      <div class="cc-title">${esc(c.label || e.name)}<span class="cc-type mono">${esc(e.name)}</span></div>
      <div class="cc-sub mono">${esc(connSummary(c))}</div>
    </div>
    <div class="cc-acts">
      <button class="btn ghost sm" data-toggle>${svg(c.enabled ? 'pause' : 'play', 13)} ${c.enabled ? 'Pause' : 'Resume'}</button>
      <button class="btn ghost sm" data-edit title="Settings">${svg('gear', 13)}</button>
      <button class="btn ghost sm danger" data-del title="Remove">${svg('trash', 13)}</button>
    </div>
  </div>`;
}
function wireConnCard(card) {
  const id = card.dataset.conn;
  const c = _connInstalled.find(x => x.id === id); if (!c) return;
  card.querySelector('[data-toggle]').onclick = async () => {
    try { const u = await updateConnector(id, { enabled: !c.enabled }); Object.assign(c, u); renderConnectors(); toast(u.enabled ? 'Connector resumed' : 'Connector paused', 'check'); }
    catch (e) { toast(e.message || 'failed', 'close'); }
  };
  card.querySelector('[data-edit]').onclick = () => openConnectorConfig(catEntry(c.type), c);
  card.querySelector('[data-del]').onclick = () => confirmModal('Remove connector', `Remove “${c.label || (catEntry(c.type) || {}).name}”? This stops its automations.`, async () => {
    try { await deleteConnector(id); _connInstalled = _connInstalled.filter(x => x.id !== id); renderConnectors(); toast('Connector removed', 'trash'); }
    catch (e) { toast(e.message || 'failed', 'close'); }
  });
}

/* ---- Add connector: searchable, categorized marketplace grid ---- */
function openAddConnector() {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal conn-market">
    <h3>Add a connector</h3>
    <p>Browse the marketplace. Ready ones install instantly; more are on the way.</p>
    <input type="text" class="picker-search" id="cmSearch" placeholder="Search connectors…">
    <div class="cm-grid" id="cmGrid"></div>
    <div class="acts"><button class="btn ghost" data-cancel>Close</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  const grid = bg.querySelector('#cmGrid');
  const render = (q) => {
    let items = _connCatalog;
    if (q) { const s = q.toLowerCase(); items = items.filter(c => (c.name + ' ' + c.desc + ' ' + c.category).toLowerCase().includes(s)); }
    const cats = [...new Set(items.map(c => c.category))];
    if (!items.length) { grid.innerHTML = `<div class="picker-empty dim mono">No connectors match.</div>`; return; }
    grid.innerHTML = cats.map(cat => `<div class="cm-cat"><span class="eyebrow">${esc(cat)}</span><div class="cm-tiles">${items.filter(c => c.category === cat).map(cmTileHTML).join('')}</div></div>`).join('');
    grid.querySelectorAll('[data-cm]').forEach(t => t.onclick = () => {
      const e = _connCatalog.find(c => c.id === t.dataset.cm);
      if (!e || e.status !== 'ready') return;
      close(); openConnectorConfig(e, null);
    });
  };
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  const search = bg.querySelector('#cmSearch'); search.oninput = () => render(search.value.trim());
  render(''); search.focus();
}
function cmTileHTML(c) {
  const soon = c.status !== 'ready';
  return `<button class="cm-tile${soon ? ' soon' : ''}" data-cm="${c.id}" ${soon ? 'disabled' : ''}>
    ${soon ? '<span class="soon-rib">Soon</span>' : ''}
    <span class="cm-ico">${svg(c.icon || 'plug', 20, 1.7)}</span>
    <span class="cm-name">${esc(c.name)}</span>
    <span class="cm-desc">${esc(c.desc || '')}</span>
  </button>`;
}

/* ---- install / edit a connector via its field spec ---- */
function openConnectorConfig(entry, existing) {
  if (!entry) return;
  const cfg = (existing && existing.config) || {};
  const fieldHTML = (f) => {
    const val = cfg[f.key] != null ? cfg[f.key] : (f.default != null ? f.default : '');
    if (f.type === 'time') return `<input type="time" data-f="${f.key}" value="${esc(val || '09:00')}">`;
    if (f.type === 'days') {
      const sel = Array.isArray(val) ? val : [];
      return `<div class="day-pick" data-f="${f.key}">${DAY_LABELS.map((d, i) => `<button type="button" class="day ${sel.includes(i) ? 'on' : ''}" data-day="${i}">${d}</button>`).join('')}</div>`;
    }
    return `<input type="text" data-f="${f.key}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}" maxlength="200">`;
  };
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal account-modal">
    <h3>${svg(entry.icon || 'plug', 16)} ${esc(existing ? 'Edit' : 'Add')} ${esc(entry.name)}</h3>
    <p>${esc(entry.desc || '')}</p>
    <div class="form-fields">
      <label class="form-field"><span class="eyebrow">Name</span><input type="text" id="connLabel" value="${esc(existing ? existing.label : entry.name)}" maxlength="80"></label>
      ${(entry.fields || []).map(f => `<label class="form-field"><span class="eyebrow">${esc(f.label)}${f.required ? ' *' : ''}</span>${fieldHTML(f)}</label>`).join('')}
    </div>
    <div class="form-err" id="connErr"></div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>${existing ? 'Save' : 'Add connector'}</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  const err = bg.querySelector('#connErr');
  bg.querySelectorAll('.day-pick .day').forEach(b => b.onclick = () => b.classList.toggle('on'));
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('[data-ok]').onclick = async () => {
    const config = {};
    bg.querySelectorAll('[data-f]').forEach(el => {
      const k = el.dataset.f;
      if (el.classList.contains('day-pick')) config[k] = [...el.querySelectorAll('.day.on')].map(d => +d.dataset.day);
      else config[k] = el.value;
    });
    // validate required
    for (const f of (entry.fields || [])) { if (f.required && (config[f.key] == null || String(config[f.key]).trim() === '')) { err.textContent = `${f.label} is required.`; return; } }
    if (existing) config.lastFired = (existing.config || {}).lastFired;   // preserve dedupe key
    const label = bg.querySelector('#connLabel').value.trim() || entry.name;
    const ok = bg.querySelector('[data-ok]'); ok.disabled = true; err.textContent = '';
    try {
      if (existing) { const u = await updateConnector(existing.id, { label, config }); Object.assign(existing, u); }
      else { const u = await installConnector({ type: entry.id, label, config }); _connInstalled.push(u); }
      close(); renderConnectors(); toast(existing ? 'Connector updated' : 'Connector added', 'check');
      if (entry.id === 'schedule' && !existing) requestDeviceNotifications();
    } catch (e) { err.textContent = e.message || 'Could not save'; ok.disabled = false; }
  };
}

/* ============================================================
   NOTIFICATIONS — in-app bell + optional device (browser) notifications.
   ============================================================ */
let _notifUnread = 0, _lastNotifShown = null;
function notifIcon(type) { return type === 'schedule' ? 'clock' : 'bell'; }
async function openNotifPanel(anchor) {
  hideCtx();
  const open = document.querySelector('.notif-panel');
  if (open) { open.remove(); return; }   // toggle
  const panel = document.createElement('div'); panel.className = 'notif-panel';
  const deviceBtn = ('Notification' in window && Notification.permission !== 'granted')
    ? `<button class="btn ghost sm" id="npDevice">${svg('bell', 13)} Device alerts</button>` : '';
  panel.innerHTML = `<div class="np-head"><span class="eyebrow">Notifications</span><span class="spacer"></span>${deviceBtn}<button class="btn ghost sm" id="npReadAll">Mark read</button></div><div class="np-list" id="npList"><div class="dim mono pad-sm">Loading…</div></div>`;
  document.body.appendChild(panel);
  const r = anchor.getBoundingClientRect(), pr = panel.getBoundingClientRect();
  panel.style.top = (r.bottom + 8) + 'px';
  panel.style.left = Math.max(10, Math.min(r.right - pr.width, innerWidth - pr.width - 10)) + 'px';
  const close = () => { panel.remove(); document.removeEventListener('mousedown', onDoc, true); };
  const onDoc = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
  const dev = panel.querySelector('#npDevice'); if (dev) dev.onclick = () => requestDeviceNotifications();
  panel.querySelector('#npReadAll').onclick = async () => { try { await readAllNotifications(); } catch (e) {} _notifUnread = 0; updateNotifBadges(); loadNotifList(panel); };
  await loadNotifList(panel);
  try { await readAllNotifications(); } catch (e) {}   // opening clears the unread badge
  _notifUnread = 0; updateNotifBadges();
}
async function loadNotifList(panel) {
  const list = panel.querySelector('#npList'); if (!list) return;
  let items = [];
  try { items = (await listNotifications()).items || []; } catch (e) { list.innerHTML = `<div class="dim mono pad-sm">Couldn't load.</div>`; return; }
  if (!items.length) { list.innerHTML = `<div class="np-empty dim mono">You're all caught up.</div>`; return; }
  list.innerHTML = items.map(notifItemHTML).join('');
  list.querySelectorAll('[data-notif]').forEach(row => {
    const id = row.dataset.notif;
    const ack = row.querySelector('[data-ack]'); if (ack) ack.onclick = async () => { try { await ackNotification(id); } catch (e) {} loadNotifList(panel); };
    const del = row.querySelector('[data-ndel]'); if (del) del.onclick = async () => { try { await deleteNotification(id); } catch (e) {} loadNotifList(panel); };
  });
}
function notifItemHTML(n) {
  const when = fmtNotifTime(n.created);
  const action = n.requires_ack
    ? (n.acked ? `<span class="ni-done">${svg('check', 13)} Done</span>` : `<button class="btn primary sm" data-ack>Mark done</button>`)
    : '';
  return `<div class="notif-item${n.read ? '' : ' unread'}" data-notif="${n.id}">
    <span class="ni-ico">${svg(notifIcon(n.type), 15)}</span>
    <div class="ni-main">
      <div class="ni-title">${esc(n.title)}</div>
      ${n.body ? `<div class="ni-body">${esc(n.body)}</div>` : ''}
      <div class="ni-meta mono">${when}</div>
    </div>
    <div class="ni-acts">${action}<button class="ic-btn sm" data-ndel title="Dismiss">${svg('close', 13)}</button></div>
  </div>`;
}
function fmtNotifTime(ms) {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return fmtDate(ms);
}
function requestDeviceNotifications() {
  if (!('Notification' in window)) { toast('This browser has no notifications', 'close'); return; }
  if (Notification.permission === 'granted') { toast('Device alerts already on', 'check'); return; }
  Notification.requestPermission().then(p => { if (p === 'granted') toast('Device alerts enabled', 'check'); });
}
async function maybeBrowserNotify() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const items = (await listNotifications()).items || [];
    const newest = items.find(n => !n.read);
    if (newest && newest.id !== _lastNotifShown) {
      _lastNotifShown = newest.id;
      const nt = new Notification(newest.title || 'Simplex', { body: newest.body || '', tag: newest.id });
      nt.onclick = () => { window.focus(); openApp('connectors'); };
    }
  } catch (e) {}
}

/* ============================================================
   PERSISTENT PLAYER — music/video keeps playing as a docked mini-player when you
   navigate anywhere; expand to a full now-playing view. Dock corner is a setting.
   ============================================================ */

/* CoverLoader — CORE (music covers upgrade lo→hi res). The persistent Player +
   muProgressiveImgHTML use it whether or not the Music app has loaded, so it must
   live in core, not apps-music.js (where it was wrongly extracted). */
/* ---------- CoverLoader: progressive (low→high res) music artwork ----------
   Music covers load in two steps: the tiny `?lo=1` variant paints first, and the
   full-res version is fetched later — ONLY while the connection is good (NetWatch
   level 0) AND the audio element isn't starving. Audio always wins: if the player
   is trying to play but hasn't buffered ahead yet (readyState < HAVE_FUTURE_DATA),
   or a crossfade is mid-flight, artwork upgrades wait and retry. Upgrades preload
   into an off-DOM Image and swap src on load, so there's no flicker. */
const CoverLoader = (() => {
  const pend = new Map();      // <img> -> full-res url awaiting upgrade
  let timer = null;
  const isMusic = (u) => typeof u === 'string' && u.indexOf('/api/music/') === 0;
  /* low-res url for a music cover; any other url passes through unchanged */
  const loUrl = (u) => isMusic(u) ? u + (u.includes('?') ? '&' : '?') + 'lo=1' : u;

  /* Full-res covers we've ALREADY loaded once (this session or a past one —
     persisted so it lines up with the browser's HTTP cache): for these, the
     low-res step is pure waste (an extra request + a blurry flash), so every
     render path skips straight to the original. If the HTTP cache was evicted
     since, nothing breaks — the full-res just loads over the network directly.
     Keys include any ?v= cover version, so a re-tagged cover re-qualifies. */
  const KNOWN_KEY = 'simplex.coversHi';
  let known = new Set();
  try { known = new Set(JSON.parse(localStorage.getItem(KNOWN_KEY)) || []); } catch (e) {}
  let saveT = null;
  function markKnown(u) {
    if (known.has(u)) return;
    known.add(u);
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try { localStorage.setItem(KNOWN_KEY, JSON.stringify([...known].slice(-800))); } catch (e) {}
    }, 400);
  }
  function audioStarving() {
    if (typeof Player === 'undefined') return false;
    if (Player._crossfading) return true;
    const a = Player.audio;
    return !!(a && a.src && !a.paused && a.readyState < 3);   // playing but not buffered ahead
  }
  function schedule(ms) { if (!timer) timer = setTimeout(pump, ms || 300); }
  function pump() {
    timer = null;
    if (!pend.size) return;
    if (NetWatch.level() > 0 || audioStarving()) { schedule(1500); return; }   // wait for calm
    let started = 0;
    for (const [img, hi] of pend) {
      if (!img.isConnected) { pend.delete(img); continue; }   // card re-rendered away
      if (started >= 4) break;                                // a few at a time, never a burst
      pend.delete(img); started++;
      const pre = new Image();
      pre.onload = () => { markKnown(hi); if (img.isConnected) img.src = hi; };
      pre.src = hi;
    }
    if (pend.size) schedule(800);
  }
  return {
    loUrl, isMusic,
    known: (u) => known.has(u),
    /* the right src to render NOW: the original if we've loaded it before
       (it's in cache — low-res would waste a request), else the low-res */
    srcFor: (u) => known.has(u) ? u : loUrl(u),
    /* point an <img> at the low-res variant now, full-res later (music covers only) */
    progressive(img, url) {
      if (isMusic(url) && known.has(url)) { img.src = url; return; }   // cached original: one request, zero flash
      img.src = loUrl(url);
      if (isMusic(url)) { pend.set(img, url); schedule(); }
    },
    /* queue upgrades for freshly-rendered `<img data-hi="...">` under root */
    wire(root) {
      (root || document).querySelectorAll('img[data-hi]').forEach(img => {
        const hi = img.dataset.hi; img.removeAttribute('data-hi');
        if (hi) pend.set(img, hi);
      });
      schedule();
    },
  };
})();

const Player = { audio: null, audioAlt: null, kind: null, list: [], idx: -1, rate: 1, vol: 1, muted: false, shuffle: false, order: null, loop: false, jam: null, expanded: false, settingsOpen: false, videoEl: null, videoFile: null, _crossfading: false };
let _fadeAnim = null;

/* ============================================================
   EQUALIZER — a 10-band graphic EQ for the music player, built on the Web Audio
   API (BiquadFilter "peaking" nodes). Each playing <audio> element is routed
   through a chain of band filters before the speakers; gains are in dB (−12…+12).
   Presets mirror the familiar Apple Music / Spotify set; editing any band switches
   to the "Custom" preset. State lives in PREFS.eq and persists per account.

   Web Audio notes that drive the design:
   - createMediaElementSource() can be called only ONCE per element and, once made,
     the element's sound flows ONLY through the graph — so we wire BOTH the primary
     and the crossfade-alt element, and cache each element's source node on itself.
   - An AudioContext must be created/resumed from a user gesture, so we build it
     lazily on the first play/enable and resume it whenever playback starts.
   - The <audio>.volume the player already sets still works: it's applied to the
     element upstream of the source node, so EQ and volume/crossfade compose. */
const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];   // Hz, per band
const EQ_GAIN_MAX = 12;   // dB clamp (matches Apple Music's ±12 dB range)
/* Presets: gains per band (10 values, dB). Curated from the Apple Music set. */
const EQ_PRESETS = [
  { id: 'flat',     name: 'Flat',           gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'acoustic', name: 'Acoustic',       gains: [5, 5, 4, 1, 2, 2, 4, 4, 3, 1] },
  { id: 'bassboost',name: 'Bass Booster',   gains: [6, 5, 4, 3, 1, 0, 0, 0, 0, 0] },
  { id: 'basscut',  name: 'Bass Reducer',   gains: [-6,-5,-4,-3,-1, 0, 0, 0, 0, 0] },
  { id: 'classical',name: 'Classical',      gains: [5, 4, 3, 2,-1,-1, 0, 2, 3, 4] },
  { id: 'dance',    name: 'Dance',          gains: [6, 5, 2, 0, 1, 3, 4, 4, 3, 0] },
  { id: 'deep',     name: 'Deep',           gains: [5, 4, 2, 1, 2, 1,-1,-3,-4,-5] },
  { id: 'electronic',name:'Electronic',     gains: [5, 4, 1, 0,-1, 1, 1, 2, 4, 5] },
  { id: 'hiphop',   name: 'Hip-Hop',        gains: [6, 5, 2, 3,-1,-1, 1, 1, 2, 3] },
  { id: 'jazz',     name: 'Jazz',           gains: [4, 3, 1, 2,-1,-1, 0, 1, 3, 4] },
  { id: 'latin',    name: 'Latin',          gains: [4, 3, 0, 0,-1,-1,-1, 0, 3, 5] },
  { id: 'loudness', name: 'Loudness',       gains: [6, 5, 0, 0,-2, 0,-1, 0, 5, 6] },
  { id: 'lounge',   name: 'Lounge',         gains: [-3,-1, 0, 1, 3, 2, 0,-1, 1, 2] },
  { id: 'piano',    name: 'Piano',          gains: [3, 2, 0, 2, 3, 1, 3, 4, 3, 3] },
  { id: 'pop',      name: 'Pop',            gains: [-2,-1, 0, 2, 4, 4, 2, 0,-1,-2] },
  { id: 'rnb',      name: 'R&B',            gains: [6, 5, 4, 1,-2,-1, 2, 2, 3, 4] },
  { id: 'rock',     name: 'Rock',           gains: [5, 4, 3, 1,-1,-1, 1, 3, 4, 5] },
  { id: 'smallspk', name: 'Small Speakers', gains: [6, 5, 4, 2, 1, 0,-1,-2,-3,-4] },
  { id: 'spoken',   name: 'Spoken Word',    gains: [-4,-3, 0, 2, 4, 4, 4, 3, 1, 0] },
  { id: 'trebleboost',name:'Treble Booster',gains: [0, 0, 0, 0, 0, 1, 3, 4, 5, 6] },
  { id: 'treblecut',name: 'Treble Reducer', gains: [0, 0, 0, 0, 0,-1,-3,-4,-5,-6] },
  { id: 'vocal',    name: 'Vocal Booster',  gains: [-2,-3,-3, 1, 4, 4, 4, 3, 0,-2] },
];
function eqPresetById(id) { return EQ_PRESETS.find(p => p.id === id) || EQ_PRESETS[0]; }
function eqClampGains(g) {
  const arr = Array.isArray(g) ? g.slice(0, EQ_BANDS.length) : [];
  while (arr.length < EQ_BANDS.length) arr.push(0);
  return arr.map(v => { const n = +v; return Number.isFinite(n) ? Math.max(-EQ_GAIN_MAX, Math.min(EQ_GAIN_MAX, n)) : 0; });
}
/* the live EQ state, normalized from PREFS (with sane defaults). */
function eqState() {
  const e = PREFS.eq || {};
  return {
    enabled: !!e.enabled,
    preset: typeof e.preset === 'string' ? e.preset : 'flat',
    gains: eqClampGains(e.gains && e.gains.length ? e.gains : eqPresetById(e.preset || 'flat').gains),
  };
}
function eqEnabled() { return eqState().enabled; }

const AudioEQ = (() => {
  let ctx = null;            // shared AudioContext
  let unsupported = false;   // set if Web Audio isn't available
  // Per-element graph: element -> { source, filters: [BiquadFilter] }.
  const graphs = new WeakMap();

  function ensureCtx() {
    if (ctx || unsupported) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { unsupported = true; return null; }
    try { ctx = new AC(); } catch (e) { unsupported = true; ctx = null; }
    return ctx;
  }
  // Build (once) the source -> filter chain -> destination for one <audio> element.
  function wireElement(el) {
    if (!el || unsupported) return null;
    let g = graphs.get(el);
    if (g) return g;
    const c = ensureCtx();
    if (!c) return null;
    let source;
    try { source = c.createMediaElementSource(el); }
    catch (e) { /* already connected elsewhere, or blocked */ return null; }
    const filters = EQ_BANDS.map((freq, i) => {
      const f = c.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = freq;
      f.Q.value = 1.0;             // ~1 octave; gentle, musical
      f.gain.value = 0;
      return f;
    });
    // HEADROOM: modern masters already peak at ~0 dBFS, so any boost preset
    // (Bass Booster +6 dB, Loudness, R&B…) pushes the signal past full scale and
    // the destination hard-CLIPS it — audible crunch/distortion that reads as
    // "low quality", worst on bass-heavy speakers (cars). The preamp trims the
    // whole signal by the largest boosted band so boosts re-shape instead of
    // clip, and the limiter is a brickwall backstop for anything that still peaks.
    const preamp = c.createGain();
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.001; limiter.release.value = 0.25;
    // source -> f0 -> f1 -> ... -> preamp -> limiter -> destination
    source.connect(filters[0]);
    for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
    filters[filters.length - 1].connect(preamp);
    preamp.connect(limiter);
    limiter.connect(c.destination);
    g = { source, filters, preamp };
    graphs.set(el, g);
    applyToGraph(g);
    return g;
  }
  function applyToGraph(g) {
    if (!g) return;
    const st = eqState();
    const gains = st.enabled ? st.gains : EQ_BANDS.map(() => 0);   // disabled = bypass (flat)
    const t = ctx ? ctx.currentTime : 0;
    g.filters.forEach((f, i) => {
      const v = gains[i] || 0;
      try { f.gain.setTargetAtTime(v, t, 0.03); } catch (e) { f.gain.value = v; }
    });
    // compensate the largest boost so the summed signal stays under 0 dBFS
    if (g.preamp) {
      const maxBoost = Math.max(0, ...gains);
      const trim = Math.pow(10, -maxBoost / 20);
      try { g.preamp.gain.setTargetAtTime(trim, t, 0.03); } catch (e) { g.preamp.gain.value = trim; }
    }
  }
  return {
    supported() { return !unsupported && !!(window.AudioContext || window.webkitAudioContext); },
    // Wire an audio element into the EQ graph — but ONLY when EQ is enabled. We
    // avoid creating the MediaElementSource for users who never touch the EQ,
    // because that node permanently reroutes the element's sound through the graph
    // (irreversible) and would needlessly depend on the AudioContext being resumed.
    // When the user first enables EQ, apply() wires whatever is currently playing.
    attach(el) { if (this.supported() && eqEnabled()) wireElement(el); },
    // Resume the context on a user-driven play (autoplay policies suspend it).
    resume() { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); },
    // Re-apply current gains to every known element (on toggle / preset / slider).
    apply() {
      if (unsupported) return;
      // make sure the currently-active elements are wired so a first-ever enable
      // takes effect immediately on the playing track
      [Player.audio, Player.audioAlt].forEach(el => { if (el) wireElement(el); });
      ctx && ctx.state === 'suspended' && ctx.resume().catch(() => {});
      // apply to all graphs we hold (WeakMap isn't iterable; re-apply via the two
      // live elements, which are the only ones that exist at any moment)
      [Player.audio, Player.audioAlt].forEach(el => { const g = el && graphs.get(el); if (g) applyToGraph(g); });
    },
  };
})();
/* persist + apply an EQ patch (enabled / preset / gains). */
function setEq(patch) {
  const cur = eqState();
  const next = { ...cur, ...patch };
  next.gains = eqClampGains(next.gains);
  setPrefs({ eq: { enabled: !!next.enabled, preset: next.preset, gains: next.gains } });
  AudioEQ.apply();
}
/* ---- Music streaming quality ----
   Applies ONLY to shared Music-app tracks (their /api/music/tracks/:id/raw URL
   grows a ?q= param the server answers with a cached AAC transcode). Vault files
   always stream their original bytes. 'lossless' (the default) = no param. */
const MUSIC_QUALITIES = [
  { id: 'low',      name: 'Low',      sub: '96 kbps' },
  { id: 'medium',   name: 'Medium',   sub: '160 kbps' },
  { id: 'high',     name: 'High',     sub: '256 kbps' },
  { id: 'lossless', name: 'Lossless', sub: 'original file' },
];
function musicQuality() { return MUSIC_QUALITIES.some(o => o.id === PREFS.musicQuality) ? PREFS.musicQuality : 'lossless'; }
function musicStreamUrl(url) {
  const q = musicQuality();
  return (q !== 'lossless' && typeof url === 'string' && /^\/api\/music\/tracks\/[^/?]+\/raw$/.test(url)) ? url + '?q=' + q : url;
}
/* the user changed quality mid-listen: reload the current MUSIC track in place,
   keeping position and play state (vault tracks are untouched — no ?q for them). */
async function playerApplyQualityChange() {
  const a = Player.audio, f = curTrack();
  if (!a || !f || Player.kind !== 'audio' || !/^\/api\/music\/tracks\//.test(f.url || '')) return;
  const pos = a.currentTime || 0, wasPlaying = !!a.src && !a.paused;
  const url = await _resolveMediaSrc(f); if (!url) return;
  cancelFadeAnim();
  setMediaSrc(a, url);
  a.playbackRate = Player.rate; a.volume = playerTargetVol();
  const restore = () => { try { a.currentTime = pos; } catch (e) {} if (wasPlaying) a.play().catch(() => {}); };
  if (a.readyState >= 1) restore(); else a.addEventListener('loadedmetadata', restore, { once: true });
}
function playerFadeEnabled() { return !!PREFS.fadeEnabled; }
function playerFadeSec() { const s = +PREFS.fadeSeconds || 3; return Math.max(1, Math.min(12, s)); }
function playerTargetVol() { return Player.muted ? 0 : Player.vol; }
function cancelFadeAnim() { if (_fadeAnim) { cancelAnimationFrame(_fadeAnim); _fadeAnim = null; } Player._crossfading = false; }
/* Set a media element's src, revoking any decrypted-blob URL it previously held so
   the old track's bytes can be GC'd. For LOCKED tracks _resolveMediaSrc returns a
   blob: URL that pins the whole decrypted file until revoked; cycling a playlist
   without this leaks one track per change — a cause of freezing after playback. */
function setMediaSrc(el, url) {
  if (!el) return;
  if (el._sxBlobUrl && el._sxBlobUrl !== url) { try { URL.revokeObjectURL(el._sxBlobUrl); } catch (e) {} }
  el._sxBlobUrl = (typeof url === 'string' && url.startsWith('blob:')) ? url : null;
  if (url) el.src = url; else { el.removeAttribute('src'); el.load(); }
}
function releaseAudioEl(el) {
  if (!el) return;
  try { el.pause(); } catch (e) {}
  if (el._sxBlobUrl) { try { URL.revokeObjectURL(el._sxBlobUrl); } catch (e) {} el._sxBlobUrl = null; }
  try { el.removeAttribute('src'); el.load(); } catch (e) {}
}
function applyPlayerVolume() {
  const v = playerTargetVol();
  const m = playerMediaEl();
  if (m && !Player._crossfading) m.volume = v;
  document.querySelectorAll('[data-vfill]').forEach(el => el.style.width = (v * 100) + '%');
  document.querySelectorAll('[data-vmute]').forEach(b => b.innerHTML = svg(v === 0 ? 'volmute' : 'vol', 17));
}
const PLAYER_CORNERS = ['br', 'bl', 'tl', 'tr'];
function playerPos() { return PLAYER_CORNERS.includes(PREFS.playerPos) ? PREFS.playerPos : 'br'; }
function cyclePlayerPos() { const i = PLAYER_CORNERS.indexOf(playerPos()); setPrefs({ playerPos: PLAYER_CORNERS[(i + 1) % 4] }); applyPlayerPos(); }
function applyPlayerPos() { const m = document.getElementById('miniplayer'); if (m) m.dataset.pos = playerPos(); }

function wirePrimaryAudio(a) {
  if (a._wired) return;
  a._wired = true;
  a.addEventListener('timeupdate', () => { if (Player.audio === a) { paintPlayer(); checkAutoCrossfade(); } });
  a.addEventListener('play', reflectPlayState);
  a.addEventListener('play', () => AudioEQ.resume());   // wake the EQ context (suspended by autoplay policy)
  a.addEventListener('pause', reflectPlayState);
  a.addEventListener('ended', () => { if (Player.audio === a && !Player._crossfading) audioNext(); });
  a.addEventListener('loadedmetadata', () => { if (Player.audio === a) paintPlayer(); });
}
function ensureAudioEl() {
  if (Player.audio) return Player.audio;
  const a = document.createElement('audio'); a.id = 'gAudio'; a.preload = 'metadata';
  document.body.appendChild(a);
  wirePrimaryAudio(a);
  AudioEQ.attach(a);   // route through the equalizer graph
  Player.audio = a; return a;
}
function ensureAudioAlt() {
  if (Player.audioAlt) return Player.audioAlt;
  const a = document.createElement('audio'); a.id = 'gAudioAlt'; a.preload = 'metadata';
  document.body.appendChild(a);
  a.addEventListener('play', () => AudioEQ.resume());
  AudioEQ.attach(a);   // the crossfade element must also feed the EQ graph
  Player.audioAlt = a; return a;
}
function crossfadeVolumes(outEl, inEl, outFrom, inTo, ms, done) {
  const t0 = performance.now();
  function step(now) {
    const p = Math.min(1, (now - t0) / ms);
    if (outEl) outEl.volume = outFrom * (1 - p);
    if (inEl) inEl.volume = inTo * p;
    if (p < 1) _fadeAnim = requestAnimationFrame(step);
    else { _fadeAnim = null; done && done(); }
  }
  _fadeAnim = requestAnimationFrame(step);
}
function checkAutoCrossfade() {
  // no crossfade while jamming — the jam state drives transitions and seeks must stay tight
  if (Player.jam) return;
  if (!playerFadeEnabled() || Player._crossfading || Player.kind !== 'audio' || Player.list.length <= 1) return;
  const a = Player.audio;
  if (!a || a.paused || !a.src) return;
  const d = (isFinite(a.duration) && a.duration) ? a.duration : (curTrack() && curTrack().dur) || 0;
  if (!d) return;
  const remaining = d - a.currentTime;
  if (remaining * 1000 <= playerFadeSec() * 1000 && remaining > 0.05) {
    const next = playerAdvanceIndex(1);
    if (next != null) crossfadeTo(next, true);   // null = queue ended, loop off: let it end naturally
  }
}
async function crossfadeTo(i, autoplay) {
  try {
  if (!Player.list.length) return;
  cancelFadeAnim();
  Player._crossfading = true;
  const fadeMs = playerFadeSec() * 1000;
  const vol = playerTargetVol();
  const out = Player.audio || ensureAudioEl();
  const incoming = ensureAudioAlt();
  const idx = (i + Player.list.length) % Player.list.length;
  const f = Player.list[idx];
  const url = await _resolveMediaSrc(f);
  if (!url) { Player._crossfading = false; loadAudio(i, autoplay); return; }
  const outVol = out.volume;
  setMediaSrc(incoming, url);
  incoming.playbackRate = Player.rate;
  incoming.volume = 0;
  Player.idx = idx;
  const finish = () => {
    wirePrimaryAudio(incoming);
    releaseAudioEl(out);
    Player.audio = incoming;
    Player.audioAlt = out;
    Player._crossfading = false;
    renderMini();
    if (Player.expanded) renderNowPlaying();
    paintPlayer();
  };
  const start = () => {
    if (autoplay) incoming.play().catch(() => {});
    crossfadeVolumes(out, incoming, outVol, vol, fadeMs, finish);
    renderMini();
    if (Player.expanded && !Player.settingsOpen) renderNowPlaying();
  };
  if (incoming.readyState >= 2) start();
  else incoming.addEventListener('canplay', start, { once: true });
  } catch (e) { Player._crossfading = false; console.error('[simplex] audio crossfade failed', e); toast(e && e.message ? e.message : 'Could not open audio', 'close'); }
}
function transitionAudio(i, autoplay) {
  cancelFadeAnim();
  const a = Player.audio;
   if (playerFadeEnabled() && a && a.src && !a.paused && autoplay) void crossfadeTo(i, true);
   else void loadAudio(i, autoplay);
}
/* new openAudio — routes music through the persistent player (overrides the old
   modal viewer in viewers.js so playback survives navigation). */
async function openAudio(id) {
  const f = byId(id); if (!f) return;
  let list = (state.view === 'cat' && state.sub === 'audio') ? allOfType('audio')
    : (state.view === 'starred') ? starred().filter(x => x.type === 'audio')
    : children(f.parent).filter(x => x.type === 'audio');
  if (!list.find(x => x.id === id)) list = [f, ...list];
  if (Player.jam) muLeaveJam(true);                 // a fresh vault queue leaves any jam
  Player.kind = 'audio'; Player.list = list; Player.idx = list.findIndex(x => x.id === id);
  playerSetShuffle(Player.shuffle);                  // rebuild the shuffle order for the new list (or clear it)
  Player.expanded = true;
  void loadAudio(Player.idx, true);
  renderNowPlaying();
}
function curTrack() { return Player.kind === 'audio' ? Player.list[Player.idx] : Player.videoFile; }
async function loadAudio(i, autoplay) {
  try {
  cancelFadeAnim();
  releaseAudioEl(Player.audioAlt);
  const a = ensureAudioEl();
  if (!Player.list.length) return;
  Player.idx = (i + Player.list.length) % Player.list.length;
  const f = Player.list[Player.idx];
  const url = await _resolveMediaSrc(f);
  try { a.pause(); } catch (e) {}
  if (url) { setMediaSrc(a, url); a.playbackRate = Player.rate; a.volume = playerTargetVol(); if (autoplay) a.play().catch(() => {}); }
  else { setMediaSrc(a, null); }
  renderMini();
  if (Player.expanded) renderNowPlaying();
  maybeBackfillTags(f);
  } catch (e) { console.error('[simplex] audio load failed', e); toast(e && e.message ? e.message : 'Could not open audio', 'close'); }
}

/* Tracks uploaded before server-side tag extraction existed show "Unknown artist"
   and the generic icon. The first time we play such a track (no artist AND no
   cover, not locked), ask the server to pull its embedded tags/art, then refresh
   the player if anything was found. Guarded so each id is only attempted once. */
const _triedTagBackfill = new Set();
async function maybeBackfillTags(f) {
  if (!f || f.type !== 'audio' || _looksLocked(f) || f.locked) return;
  if (f.artist || f.coverUrl) return;            // already has metadata — nothing to do
  if (_triedTagBackfill.has(f.id)) return;
  _triedTagBackfill.add(f.id);
  try {
    const { file } = await extractTags(f.id);
    if (file && (file.artist || file.coverUrl)) {
      // the cache is already updated by extractTags; repaint whatever's showing it
      if (curTrack() && curTrack().id === file.id) { renderMini(); if (Player.expanded) renderNowPlaying(); }
      try { render(); } catch (e) {}
    }
  } catch (e) { /* best-effort; leave the track as-is */ }
}
/* ---- production-standard shuffle (a real shuffled order) + loop ----
   Player.order is a permutation of list indices = the play order for this session;
   null means sequential. Player.idx stays the ACTUAL list index playing (so curTrack,
   loadAudio, and the up-next list are unchanged). playerAdvanceIndex walks `order`. */
function _orderPos() {
  if (!Player.order) return Player.idx;
  const p = Player.order.indexOf(Player.idx);
  return p < 0 ? 0 : p;
}
/* next/prev ACTUAL list index honoring order + loop. Returns null = "stop" (queue
   ended with loop off). dir = +1 | -1. */
function playerAdvanceIndex(dir) {
  const n = Player.list.length;
  if (!n) return null;
  const ord = Player.order || Player.list.map((_, i) => i);
  let pos = _orderPos() + dir;
  if (pos >= n) { if (!Player.loop) return null; pos = 0; }
  else if (pos < 0) { pos = Player.loop ? n - 1 : 0; }
  return ord[pos];
}
/* build (or clear) the shuffled play order via Fisher–Yates, keeping the current
   track current. Used by Database and Music alike. */
function playerSetShuffle(on) {
  Player.shuffle = !!on;
  const n = Player.list.length;
  if (!on || n <= 1) { Player.order = null; return; }
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  // float the currently-playing track to the front so it keeps playing
  if (Player.idx >= 0) { const at = order.indexOf(Player.idx); if (at > 0) { order.splice(at, 1); order.unshift(Player.idx); } }
  Player.order = order;
}
function toggleLoop() { Player.loop = !Player.loop; toast(Player.loop ? 'Loop on' : 'Loop off'); if (Player.expanded) renderNowPlaying(); renderMini(); }
function toggleShuffle() {
  if (Player.jam) return muJamControl({ shuffle: !Player.shuffle });
  playerSetShuffle(!Player.shuffle);
  toast(Player.shuffle ? 'Shuffle on' : 'Shuffle off');
  if (Player.expanded) renderNowPlaying();
}
function audioNext() {
  if (Player.jam) return muJamControl({ advance: 'next' });
  if (Player.kind !== 'audio' || !Player.list.length) return;
  const next = playerAdvanceIndex(1);
  if (next == null) { const a = Player.audio; if (a) { try { a.pause(); a.currentTime = 0; } catch (e) {} } return; }   // queue ended, loop off
  transitionAudio(next, true);
}
function audioPrev() {
  if (Player.jam) return muJamControl({ advance: 'prev' });
  const a = Player.audio; if (a && a.currentTime > 3) { a.currentTime = 0; return; }
  const prev = playerAdvanceIndex(-1);
  transitionAudio(prev == null ? Player.idx : prev, true);
}
function togglePlay() {
  if (Player.kind === 'video' && Player.videoEl) { Player.videoEl.paused ? Player.videoEl.play().catch(() => {}) : Player.videoEl.pause(); return; }
  const a = Player.audio; if (!a) return;
  if (Player.jam) return muJamControl({ paused: !a.paused });
  a.paused ? a.play().catch(() => {}) : a.pause();
}
function playerMediaEl() { return Player.kind === 'video' ? Player.videoEl : Player.audio; }
function playerIsPlaying() { const m = playerMediaEl(); return m && !m.paused; }

/* should the now-playing album art rotate right now? governed by PREFS.albumSpin:
   'play' (default) = only while playing · 'always' = always · 'paused' = only while
   NOT playing · 'never' = off. reduceMotion forces it off. */
function albumShouldSpin() {
  if (PREFS.reduceMotion) return false;
  const mode = PREFS.albumSpin || 'play';
  const playing = playerIsPlaying();
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  if (mode === 'paused') return !playing;
  return playing;   // 'play'
}
function reflectPlayState() {
  const playing = playerIsPlaying();
  document.querySelectorAll('[data-pp]').forEach(b => b.innerHTML = svg(playing ? 'pause' : 'play', b.dataset.pp === 'big' ? 20 : 16));
  const al = document.querySelector('#npOverlay .np-album'); if (al) al.classList.toggle('spin', albumShouldSpin());
}
function paintPlayer() {
  const m = playerMediaEl(); if (!m) return;
  const d = (isFinite(m.duration) && m.duration) ? m.duration : (curTrack() && curTrack().dur) || 0;
  const t = m.currentTime || 0; const pct = d ? (t / d * 100) : 0;
  document.querySelectorAll('[data-pfill]').forEach(el => el.style.width = pct + '%');
  document.querySelectorAll('[data-ptime]').forEach(el => el.textContent = `${fmtDur(t)} / ${fmtDur(d)}`);
}
function seekPlayerFrac(fr) {
  const m = playerMediaEl(); if (!m) return;
  const d = (isFinite(m.duration) && m.duration) ? m.duration : (curTrack() && curTrack().dur) || 0;
  if (!d) return;
  const pos = Math.max(0, Math.min(1, fr)) * d;
  if (Player.jam && Player.kind === 'audio') { MU.scrubUntil = Date.now() + 1500; muJamControl({ posSec: pos }); return; }
  m.currentTime = pos;
}

/* ---- mini dock ---- */
function miniEl() {
  let el = document.getElementById('miniplayer');
  if (!el) { el = document.createElement('div'); el.id = 'miniplayer'; document.body.appendChild(el); }
  el.dataset.pos = playerPos();
  return el;
}
function renderMini() {
  const f = curTrack();
  if (!f || Player.expanded) { const e = document.getElementById('miniplayer'); if (e) e.classList.remove('show'); return; }
  const el = miniEl();
  if (Player.kind === 'video') {
    el.classList.add('show', 'video');
    el.innerHTML = `<div class="mini-vid" id="miniVidSlot"></div>
      <div class="mini-main"><div class="mini-title">${esc(f.name)}</div></div>
      <div class="mini-ctrls">
        <button class="mpb" data-pp title="Play/Pause">${svg(playerIsPlaying() ? 'pause' : 'play', 16)}</button>
        <button class="mpb" id="mpExpand" title="Fullscreen">${svg('full', 15)}</button>
        <button class="mpb" id="mpClose" title="Close">${svg('close', 15)}</button>
      </div>`;
    const slot = el.querySelector('#miniVidSlot'); if (Player.videoEl && Player.videoEl.parentElement !== slot) slot.appendChild(Player.videoEl);
    el.querySelector('#mpExpand').onclick = () => { if (Player.videoEl && Player.videoEl.requestFullscreen) Player.videoEl.requestFullscreen().catch(() => {}); };
  } else {
    el.classList.add('show'); el.classList.remove('video');
    // the mini cover renders ~40px — low-res is full quality there, but if the
    // original is already cached (srcFor), reuse it instead of a second request
    const cover = f.coverUrl ? `<img src="${esc(CoverLoader.srcFor(f.coverUrl + (f.coverVer ? '?v=' + f.coverVer : '')))}" alt="">` : svg('audio', 18);
    el.innerHTML = `<button class="mini-cover" id="mpExpand" title="Open player">${cover}</button>
      <div class="mini-main" id="mpExpand2">
        <div class="mini-title">${esc(f.name.replace(/\.\w+$/, ''))}</div>
        <div class="mini-artist mono">${esc(f.artist || 'Unknown artist')}</div>
        <div class="mini-bar" data-seek><i data-pfill></i></div>
      </div>
      <div class="mini-ctrls">
        <button class="mpb" id="mpPrev" title="Previous">${svg('prev', 16)}</button>
        <button class="mpb play" data-pp title="Play/Pause">${svg(playerIsPlaying() ? 'pause' : 'play', 16)}</button>
        <button class="mpb" id="mpNext" title="Next">${svg('next', 16)}</button>
        <button class="mpb" id="mpPos" title="Move corner">${svg('move', 15)}</button>
        <button class="mpb" id="mpClose" title="Close">${svg('close', 15)}</button>
      </div>`;
    el.querySelector('#mpPrev').onclick = audioPrev;
    el.querySelector('#mpNext').onclick = audioNext;
    el.querySelector('#mpPos').onclick = cyclePlayerPos;
    el.querySelector('#mpExpand').onclick = expandPlayer;
    el.querySelector('#mpExpand2').onclick = (e) => { if (!e.target.closest('[data-seek]')) expandPlayer(); };
    wireBar(el.querySelector('[data-seek]'), seekPlayerFrac);
  }
  el.querySelectorAll('[data-pp]').forEach(b => b.onclick = togglePlay);
  el.querySelector('#mpClose').onclick = closePlayer;
  paintPlayer();
}
function expandPlayer() { Player.expanded = true; renderNowPlaying(); renderMini(); }
function collapsePlayer() { Player.expanded = false; Player.settingsOpen = false; const o = document.getElementById('npOverlay'); if (o) o.remove(); renderMini(); }

function playerSettingsHTML() {
  const fadeOn = playerFadeEnabled();
  const fadeSec = playerFadeSec();
  return `<div class="np-card np-settings">
    <button class="np-collapse" id="npSetBack" title="Back">${svg('back', 16)} Back to player</button>
    <div class="np-set-title">${svg('gear', 16)} Music player</div>
    <div class="np-set-body settings">
      <div class="set-section">
        <span class="eyebrow">Playback</span>
        <div class="set-row">
          <div class="sr-main"><div class="sr-title">Crossfade</div><div class="sr-sub mono">Fade smoothly between tracks</div></div>
          <label class="np-fade-toggle"><input type="checkbox" id="npFadeOn" ${fadeOn ? 'checked' : ''}><span>Enable</span></label>
        </div>
        <div class="set-row${fadeOn ? '' : ' dim'}" id="npFadeSecRow">
          <div class="sr-main"><div class="sr-title">Fade duration</div><div class="sr-sub mono">1–12 seconds between songs</div></div>
          <select class="set-select" id="npFadeSec"${fadeOn ? '' : ' disabled'}>
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(s => `<option value="${s}"${fadeSec === s ? ' selected' : ''}>${s} s</option>`).join('')}
          </select>
        </div>
        <div class="set-row">
          <div class="sr-main"><div class="sr-title">Streaming quality</div><div class="sr-sub mono">Music app songs · Lossless streams the original file</div></div>
          <select class="set-select" id="npQuality">
            ${MUSIC_QUALITIES.map(o => `<option value="${o.id}"${musicQuality() === o.id ? ' selected' : ''}>${o.name} · ${o.sub}</option>`).join('')}
          </select>
        </div>
      </div>
      ${eqSectionHTML()}
    </div>
  </div>`;
}

/* The Equalizer block inside the player settings: enable toggle, preset picker,
   and a 10-band slider editor. Editing any band switches the preset to "Custom". */
function eqSectionHTML() {
  if (!AudioEQ.supported()) {
    return `<div class="set-section">
      <span class="eyebrow">Equalizer</span>
      <div class="set-row dim"><div class="sr-main"><div class="sr-title">Not available</div><div class="sr-sub mono">This browser can't run the audio equalizer.</div></div></div>
    </div>`;
  }
  const st = eqState();
  const isCustom = !EQ_PRESETS.some(p => p.id === st.preset) || !eqGainsMatchPreset(st.gains, st.preset);
  const presetVal = isCustom ? 'custom' : st.preset;
  const fmtHz = (hz) => hz >= 1000 ? (hz % 1000 === 0 ? (hz / 1000) + 'k' : (hz / 1000).toFixed(1) + 'k') : String(hz);
  const bars = EQ_BANDS.map((hz, i) => {
    const g = st.gains[i] || 0;
    return `<div class="eq-band">
      <input type="range" class="eq-slider" data-eqband="${i}" min="${-EQ_GAIN_MAX}" max="${EQ_GAIN_MAX}" step="0.5" value="${g}" orient="vertical" aria-label="${fmtHz(hz)}Hz" ${st.enabled ? '' : 'disabled'}>
      <span class="eq-val mono" data-eqval="${i}">${eqFmtGain(g)}</span>
      <span class="eq-hz mono">${fmtHz(hz)}</span>
    </div>`;
  }).join('');
  return `<div class="set-section eq-section${st.enabled ? '' : ' eq-off'}">
    <span class="eyebrow">Equalizer</span>
    <div class="set-row">
      <div class="sr-main"><div class="sr-title">Equalizer</div><div class="sr-sub mono">Shape the sound across 10 bands</div></div>
      <label class="np-fade-toggle"><input type="checkbox" id="npEqOn" ${st.enabled ? 'checked' : ''}><span>Enable</span></label>
    </div>
    <div class="set-row${st.enabled ? '' : ' dim'}" id="npEqPresetRow">
      <div class="sr-main"><div class="sr-title">Preset</div><div class="sr-sub mono">Start from a tuned curve</div></div>
      <select class="set-select" id="npEqPreset"${st.enabled ? '' : ' disabled'}>
        ${EQ_PRESETS.map(p => `<option value="${p.id}"${presetVal === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
        <option value="custom"${presetVal === 'custom' ? ' selected' : ''}>Custom</option>
      </select>
    </div>
    <div class="eq-editor${st.enabled ? '' : ' dim'}" id="npEqEditor">
      <div class="eq-scale mono"><span>+${EQ_GAIN_MAX}</span><span>0</span><span>−${EQ_GAIN_MAX}</span></div>
      <div class="eq-bands">${bars}</div>
    </div>
    <div class="set-row${st.enabled ? '' : ' dim'}">
      <div class="sr-main"><div class="sr-sub mono">dB gain per frequency band · drag to fine-tune</div></div>
      <button class="btn ghost sm" id="npEqReset"${st.enabled ? '' : ' disabled'}>${svg('refresh', 13)} Reset</button>
    </div>
  </div>`;
}
function eqFmtGain(g) { const v = Math.round(g * 10) / 10; return (v > 0 ? '+' : '') + v; }
/* do these gains equal the named preset's curve (within rounding)? */
function eqGainsMatchPreset(gains, presetId) {
  const p = EQ_PRESETS.find(x => x.id === presetId); if (!p) return false;
  const a = eqClampGains(gains), b = eqClampGains(p.gains);
  return a.every((v, i) => Math.abs(v - b[i]) < 0.05);
}
function wirePlayerSettings(o) {
  o.querySelector('#npSetBack').onclick = () => { Player.settingsOpen = false; renderNowPlaying(); };
  const toggle = o.querySelector('#npFadeOn');
  const row = o.querySelector('#npFadeSecRow');
  const sel = o.querySelector('#npFadeSec');
  toggle.onchange = () => {
    setPrefs({ fadeEnabled: toggle.checked });
    row.classList.toggle('dim', !toggle.checked);
    sel.disabled = !toggle.checked;
    toast(toggle.checked ? 'Crossfade on' : 'Crossfade off');
  };
  sel.onchange = () => { setPrefs({ fadeSeconds: +sel.value }); toast(`Fade time · ${sel.value}s`); };
  const qSel = o.querySelector('#npQuality');
  if (qSel) qSel.onchange = () => {
    setPrefs({ musicQuality: qSel.value });
    const opt = MUSIC_QUALITIES.find(x => x.id === qSel.value);
    toast(`Streaming quality · ${opt ? opt.name : qSel.value}`);
    void playerApplyQualityChange();   // reload the playing music track at the new quality
  };
  wireEqSection(o);
}

/* Wire the Equalizer controls: enable toggle, preset picker, the 10 band sliders
   (which switch the preset to "Custom" as you drag), and Reset. Live changes apply
   to playback instantly via AudioEQ.apply(). */
function wireEqSection(o) {
  const onToggle = o.querySelector('#npEqOn');
  if (!onToggle) return;   // unsupported-browser block has no controls
  const section = o.querySelector('.eq-section');
  const presetRow = o.querySelector('#npEqPresetRow');
  const presetSel = o.querySelector('#npEqPreset');
  const editor = o.querySelector('#npEqEditor');
  const resetBtn = o.querySelector('#npEqReset');
  const sliders = [...o.querySelectorAll('.eq-slider')];

  const setDisabled = (off) => {
    if (presetSel) presetSel.disabled = off;
    if (resetBtn) resetBtn.disabled = off;
    sliders.forEach(s => s.disabled = off);
    [presetRow, editor].forEach(el => el && el.classList.toggle('dim', off));
    section && section.classList.toggle('eq-off', off);
  };
  // sync the preset dropdown to whatever the current gains represent
  const syncPresetSelect = () => {
    if (!presetSel) return;
    const st = eqState();
    const match = EQ_PRESETS.find(p => eqGainsMatchPreset(st.gains, p.id));
    presetSel.value = match ? match.id : 'custom';
  };
  // make sure a "custom" option exists in the dropdown (added in HTML already)

  onToggle.onchange = () => {
    setEq({ enabled: onToggle.checked });
    setDisabled(!onToggle.checked);
    toast(onToggle.checked ? 'Equalizer on' : 'Equalizer off');
  };

  if (presetSel) presetSel.onchange = () => {
    const v = presetSel.value;
    if (v === 'custom') return;   // selecting "Custom" explicitly keeps current gains
    const p = eqPresetById(v);
    setEq({ preset: p.id, gains: p.gains.slice() });
    // reflect the new curve on the sliders + labels without a full re-render
    sliders.forEach((s, i) => { s.value = p.gains[i]; });
    o.querySelectorAll('[data-eqval]').forEach((lbl, i) => { lbl.textContent = eqFmtGain(p.gains[i]); });
    toast(`Equalizer · ${p.name}`);
  };

  sliders.forEach(s => {
    const i = +s.dataset.eqband;
    const lbl = o.querySelector(`[data-eqval="${i}"]`);
    s.oninput = () => {
      const gains = eqState().gains.slice();
      gains[i] = +s.value;
      if (lbl) lbl.textContent = eqFmtGain(+s.value);
      // dragging a band = a custom curve; mark preset 'custom' and show it
      setEq({ preset: 'custom', gains });
      syncPresetSelect();
    };
  });

  if (resetBtn) resetBtn.onclick = () => {
    const flat = eqPresetById('flat');
    setEq({ preset: 'flat', gains: flat.gains.slice() });
    sliders.forEach((s, i) => { s.value = 0; });
    o.querySelectorAll('[data-eqval]').forEach((lbl) => { lbl.textContent = eqFmtGain(0); });
    if (presetSel) presetSel.value = 'flat';
    toast('Equalizer reset');
  };
}

function renderNowPlaying() {
  if (Player.kind !== 'audio') { Player.expanded = false; return; }
  const f = Player.list[Player.idx]; if (!f) return;
  let o = document.getElementById('npOverlay');
  if (!o) { o = document.createElement('div'); o.id = 'npOverlay'; document.body.appendChild(o); }
  if (Player.settingsOpen) { o.innerHTML = playerSettingsHTML(); wirePlayerSettings(o); return; }
  o.dataset.trackId = f.id || '';   // so the lightweight jam refresh can detect track changes
  const cover = f.coverUrl ? muProgressiveImgHTML(f.coverUrl + (f.coverVer ? '?v=' + f.coverVer : '')) : `<div class="np-ph">${svg('audio', 44, 1.3)}</div>`;
  const jam = Player.jam;
  const isMusic = !!(f && typeof f.url === 'string' && f.url.indexOf('/api/music/') === 0);
  const jamBar = jam
    ? `<div class="np-jam-pill" title="${esc((jam.members || []).map(m => m.name).join(', '))}">${svg('user', 13)} Jam · ${(jam.members || []).length} listening${jam.isHost ? ' · host' : ''}<button class="np-jam-leave" id="npJamLeave">Leave</button></div>`
    : (isMusic ? `<button class="np-jam-start" id="npJamStart">${svg('user', 13)} Start a jam</button>` : '');
  o.innerHTML = `<div class="np-card">
    <button class="np-collapse" id="npCollapse" title="Minimize">${svg('back', 16)} Minimize</button>
    ${jamBar ? `<div class="np-jam-row">${jamBar}</div>` : ''}
    <div class="np-album ${albumShouldSpin() ? 'spin' : ''}">${cover}</div>
    <div class="np-meta"><div class="np-t">${esc((f.name || '').replace(/\.\w+$/, ''))}</div><div class="np-a mono">${esc(f.artist || 'Unknown artist')}${f.album ? ' · ' + esc(f.album) : ''}</div></div>
    <div class="np-scrub" data-seek><i data-pfill></i></div>
    <div class="np-time mono" data-ptime>0:00 / 0:00</div>
    <div class="np-controls">
      <button class="npc ${Player.shuffle ? 'on' : ''}" id="npShuf" title="Shuffle">${svg('shuffle', 18)}</button>
      <button class="npc" id="npPrev" title="Previous">${svg('prev', 22)}</button>
      <button class="npc big" data-pp="big" title="Play/Pause">${svg(playerIsPlaying() ? 'pause' : 'play', 20)}</button>
      <button class="npc" id="npNext" title="Next">${svg('next', 22)}</button>
      <button class="npc ${Player.loop ? 'on' : ''}" id="npLoop" title="Loop">${svg('repeat', 18)}</button>
    </div>
    <div class="np-controls np-controls-sub">
      <button class="npc" id="npSpeed" title="Speed">${fmtRate ? fmtRate(Player.rate) : Player.rate + '×'}</button>
      <button class="npc" id="npSettings" title="Player settings">${svg('gear', 17)}</button>
    </div>
    <div class="np-vol-row">
      <button class="npc sm" id="npMute" data-vmute title="Mute">${svg((Player.muted || Player.vol === 0) ? 'volmute' : 'vol', 17)}</button>
      <div class="np-vol" id="npVol"><i data-vfill style="width:${(Player.muted ? 0 : Player.vol) * 100}%"></i></div>
    </div>
    <div class="np-upnext">
      <span class="eyebrow">Up next · ${Player.list.length} tracks${Player.shuffle ? ' · shuffled' : ''}</span>
      <div class="np-list">${npUpNextOrder().map(i => { const t = Player.list[i]; return `<button class="np-track ${i === Player.idx ? 'on' : ''}" data-track="${i}"><span class="nt-n">${i === Player.idx && playerIsPlaying() ? '♪' : ''}</span><span class="nt-t">${esc((t.name || '').replace(/\.\w+$/, ''))}</span><span class="nt-d mono">${fmtDur(t.dur || 0)}</span></button>`; }).join('')}</div>
    </div>
  </div>`;
  o.querySelector('#npCollapse').onclick = collapsePlayer;
  o.querySelector('#npPrev').onclick = audioPrev;
  o.querySelector('#npNext').onclick = audioNext;
  o.querySelector('[data-pp]').onclick = togglePlay;
  o.querySelector('#npShuf').onclick = toggleShuffle;
  o.querySelector('#npLoop').onclick = toggleLoop;
  o.querySelector('#npSpeed').onclick = (e) => { e.stopPropagation(); showSpeedMenu(e.currentTarget, { getRate: () => Player.rate, setRate: r => { Player.rate = r; if (Player.audio) Player.audio.playbackRate = r; if (Player.audioAlt) Player.audioAlt.playbackRate = r; } }, e.currentTarget, r => { Player.rate = r; }); };
  o.querySelector('#npSettings').onclick = () => { Player.settingsOpen = true; renderNowPlaying(); };
  o.querySelectorAll('[data-track]').forEach(b => b.onclick = () => { if (Player.jam) muJamControl({ idx: +b.dataset.track }); else transitionAudio(+b.dataset.track, true); });
  // Jam lives in apps-music.js (lazy). Starting a jam from the now-playing overlay
  // may happen before the Music app was ever opened, so load the module first.
  const js = o.querySelector('#npJamStart'); if (js) js.onclick = async () => { await loadFeature('apps-music'); if (typeof muStartJam === 'function') muStartJam(); };
  const jl = o.querySelector('#npJamLeave'); if (jl) jl.onclick = () => { if (typeof muLeaveJam === 'function') muLeaveJam(); };
  wireBar(o.querySelector('[data-seek]'), seekPlayerFrac);
  wireBar(o.querySelector('#npVol'), fr => { Player.vol = fr; Player.muted = Player.vol === 0; applyPlayerVolume(); });
  o.querySelector('#npMute').onclick = () => { Player.muted = !Player.muted; if (!Player.muted && Player.vol === 0) Player.vol = 1; applyPlayerVolume(); };
  CoverLoader.wire(o);   // upgrade the album art to full-res once audio + network allow
  paintPlayer();
}
/* up-next ordering: when shuffled, show the play order starting from the current
   track; otherwise sequential. Returns an array of list indices. */
function npUpNextOrder() {
  const n = Player.list.length;
  if (!Player.order) return Player.list.map((_, i) => i);
  const pos = _orderPos();
  const out = [];
  for (let k = 0; k < n; k++) out.push(Player.order[(pos + k) % n]);
  return out;
}

/* Update only the DYNAMIC bits of the now-playing overlay in place — WITHOUT rebuilding
   it. Rebuilding recreates the .np-album element, which restarts the spin animation
   (that was the "cover resets every second in a jam" bug). Used by the 1s jam poll. */
function muRefreshJamUI() {
  const o = document.getElementById('npOverlay'); if (!o || Player.settingsOpen) return;
  const jam = Player.jam;
  // jam pill
  const pill = o.querySelector('.np-jam-pill');
  if (jam && pill) {
    pill.setAttribute('title', (jam.members || []).map(m => m.name).join(', '));
    pill.childNodes.forEach(n => { if (n.nodeType === 3) n.textContent = ` Jam · ${(jam.members || []).length} listening${jam.isHost ? ' · host' : ''}`; });
  }
  // shuffle / loop on-states
  const sh = o.querySelector('#npShuf'); if (sh) sh.classList.toggle('on', Player.shuffle);
  const lp = o.querySelector('#npLoop'); if (lp) lp.classList.toggle('on', Player.loop);
  // up-next: rebuild just the list (cheap; no album element touched)
  const list = o.querySelector('.np-list');
  if (list) {
    list.innerHTML = npUpNextOrder().map(i => { const t = Player.list[i]; return `<button class="np-track ${i === Player.idx ? 'on' : ''}" data-track="${i}"><span class="nt-n">${i === Player.idx && playerIsPlaying() ? '♪' : ''}</span><span class="nt-t">${esc((t.name || '').replace(/\.\w+$/, ''))}</span><span class="nt-d mono">${fmtDur(t.dur || 0)}</span></button>`; }).join('');
    list.querySelectorAll('[data-track]').forEach(b => b.onclick = () => { if (Player.jam) muJamControl({ idx: +b.dataset.track }); else transitionAudio(+b.dataset.track, true); });
  }
  const eyebrow = o.querySelector('.np-upnext .eyebrow'); if (eyebrow) eyebrow.textContent = `Up next · ${Player.list.length} tracks${Player.shuffle ? ' · shuffled' : ''}`;
  reflectPlayState();
  paintPlayer();
}
/* the track id currently shown in the now-playing overlay (to detect real changes). */
function muNpShownId() { const o = document.getElementById('npOverlay'); return o ? o.dataset.trackId : null; }
function closePlayer() {
  cancelFadeAnim();
  if (Player.jam) muLeaveJam(true);              // closing the player leaves any jam
  releaseAudioEl(Player.audio);
  releaseAudioEl(Player.audioAlt);
  if (Player.videoEl) { try { Player.videoEl.pause(); Player.videoEl.removeAttribute('src'); Player.videoEl.load(); Player.videoEl.remove(); } catch (e) {} Player.videoEl = null; }
  // release a handed-off locked video's decrypted-blob URL so its bytes can be GC'd
  if (Player.blobUrl) { try { URL.revokeObjectURL(Player.blobUrl); } catch (e) {} Player.blobUrl = null; }
  Player.audio = null; Player.audioAlt = null; Player.kind = null; Player.list = []; Player.idx = -1; Player.order = null; Player.expanded = false; Player.settingsOpen = false; Player.videoFile = null;
  const m = document.getElementById('miniplayer'); if (m) m.remove();
  const o = document.getElementById('npOverlay'); if (o) o.remove();
}
/* video handoff: the video viewer's <video> is reparented here so it keeps playing
   in the corner (with native controls + fullscreen) after the viewer closes. */
function adoptVideo(videoEl, f, blobUrl) {
  if (Player.audio) { try { Player.audio.pause(); } catch (e) {} }   // don't double-play audio
  if (Player.videoEl && Player.videoEl !== videoEl) { try { Player.videoEl.remove(); } catch (e) {} }
  // a previously-adopted locked video's blob URL must be released before we replace it
  if (Player.blobUrl && Player.blobUrl !== blobUrl) { try { URL.revokeObjectURL(Player.blobUrl); } catch (e) {} }
  Player.blobUrl = blobUrl || null;   // owned by the mini-player now; revoked on close
  Player.kind = 'video'; Player.videoEl = videoEl; Player.videoFile = f; Player.expanded = false; Player.list = [];
  videoEl.controls = true; videoEl.classList.add('mini-video-el');
  videoEl.addEventListener('play', reflectPlayState); videoEl.addEventListener('pause', reflectPlayState);
  renderMini();
  toast('Playing in mini-player', 'audio');
}

/* ---------- SIDEBAR ---------- */
function renderNav() {
  const nav = document.getElementById('nav');
  const active = state.view === 'browse' ? 'files'
    : state.view === 'cat' ? state.sub
    : state.view === 'tag' ? 'tags'
    : state.view;
  // Render the standard groups; splice the dynamic "Pins" group in right after Vault.
  const groupsHTML = NAV.map(g => {
    const main = `
    <div class="nav-group">
      <span class="eyebrow">${g.group}</span>
      ${g.items.map(it => `
        <a class="nav-item ${active === it.id ? 'active' : ''}" href="${hrefForNav(it.id)}" data-link data-nav="${it.id}">
          <span class="ic t-${navTint(it.id)}">${svg(it.icon, 17, 1.8)}</span>
          <span>${it.label}</span>
          ${it.count ? `<span class="count">${it.count()}</span>` : ''}
        </a>`).join('')}
    </div>`;
    return g.group === 'Vault' ? main + pinsGroupHTML() : main;
  }).join('');
  nav.innerHTML = groupsHTML;
  // Navigation itself is handled by the anchor href + the global data-link click
  // interceptor (so middle/Ctrl-click open a real new tab). We only wire the
  // drop-target here so files can be dropped onto "All files" to move them to root.
  nav.querySelectorAll('[data-nav="files"]').forEach(b => wireDropTarget(b, null));
  // wire each pin: click navigates into the folder; its X unpins; drop = move into it
  nav.querySelectorAll('[data-pin]').forEach(b => {
    const id = b.dataset.pin;
    b.onclick = (e) => { if (e.target.closest('[data-unpin]')) return; go('browse', { folder: id }); if (window.innerWidth <= 820) closeSidebar(); };
    wireDropTarget(b, id);   // dropping items onto a pin moves them into that folder
    const x = b.querySelector('[data-unpin]');
    if (x) x.onclick = (e) => { e.stopPropagation(); unpinFolder(id); };
  });
}
/* The "Pins" sidebar group — rendered only when at least one live pin exists, and
   slotted between Vault and Library. Each pin shows the folder icon, its name, and
   an unpin (✕) that appears on hover. */
function pinsGroupHTML() {
  if (SHARE.active) return '';
  const pins = pinnedFolders();
  if (!pins.length) return '';
  return `
    <div class="nav-group">
      <span class="eyebrow">Pins</span>
      ${pins.map(f => `
        <button class="nav-item nav-pin ${state.view === 'browse' && state.folder === f.id ? 'active' : ''}" data-pin="${esc(f.id)}" title="${esc(f.name)}">
          <span class="ic t-folder">${svg('folder', 17, 1.8)}</span>
          <span class="nav-pin-name">${esc(f.name)}</span>
          <span class="nav-unpin" data-unpin title="Unpin">${svg('close', 13, 2)}</span>
        </button>`).join('')}
    </div>`;
}
function navTint(id) { return ({ video: 'video', audio: 'audio', image: 'image', document: 'document', model3d: 'model3d', uasset: 'uasset', files: 'folder' })[id] || ''; }
function navTo(id) {
  if (id === 'home') go('home');
  else if (id === 'files') go('browse', { folder: null });
  else if (id === 'starred') go('starred');
  else if (id === 'tags') go('tags');
  else if (id === 'docs') go('docs');
  else if (id === 'customapi') go('customapi');
  else if (id === 'trash') go('trash');
  else if (TYPES.includes(id)) go('cat', { sub: id });
  if (window.innerWidth <= 820) closeSidebar();
}

function renderStorage() {
  const used = usedBytes(), pct = Math.min(100, (used / TOTAL_BYTES) * 100);
  const bt = bytesByType();
  const segs = [['video', 'var(--vid)'], ['audio', 'var(--aud)'], ['image', 'var(--img)'], ['document', 'var(--doc)'], ['model3d', 'var(--mdl)'], ['uasset', 'var(--uas)']];
  const el = document.getElementById('storage');
  el.innerHTML = `
    <div class="top"><b>${fmtSize(used)}</b><span class="eyebrow">of ${Math.round(TOTAL_BYTES / 1e9)} GB</span></div>
    <div class="bar">${segs.map(([t, c]) => `<i style="width:${(bt[t] / TOTAL_BYTES) * 100}%;background:${c}"></i>`).join('')}</div>
    <div class="legend">
      ${segs.map(([t, c]) => `<span style="--c:${c}">${cap({ image: 'photos', document: 'docs', video: 'films', audio: 'music', model3d: 'models', uasset: 'assets' }[t] || t)}</span>`).join('')}
    </div>`;
}

/* ---------- TOPBAR / CRUMBS ---------- */
function renderCrumbs() {
  const c = document.getElementById('crumbs');
  // Keep the search box hint in sync: inside a folder, searching narrows to it.
  const _sb = document.getElementById('search');
  if (_sb && !SHARE.active) {
    const inFolder = state.view === 'browse' && state.folder && byId(state.folder);
    _sb.placeholder = inFolder ? `Search in ${inFolder.name}…` : 'Search the vault…';
  }
  let parts = [];
  if (SHARE.active) {
    // crumbs stay within the shared subtree; no "All files" root that could leak the vault
    const chain = state.folder ? pathOf(state.folder) : [];
    if (!chain.length) parts.push({ label: SHARE.root ? SHARE.root.name : 'Shared' });
    else chain.forEach(f => parts.push({ label: f.name, go: () => go('browse', { folder: f.id }) }));
  } else if (state.view === 'browse') {
    parts.push({ label: 'All files', drop: null, go: () => go('browse', { folder: null }) });
    if (state.folder) pathOf(state.folder).forEach(f => parts.push({ label: f.name, drop: f.id, go: () => go('browse', { folder: f.id }) }));
  } else if (state.view === 'tag') {
    parts.push({ label: 'Tags', go: () => go('tags') });
    const t = tagById(state.tag);
    parts.push({ label: t ? t.name : 'Tag' });
  } else {
    const _scopeName = (state.view === 'search' && state.scope != null && byId(state.scope)) ? byId(state.scope).name : null;
    const titles = { home: 'Home', starred: 'Starred', trash: 'Trash', tags: 'Tags', customapi: 'Custom API', search: `Search · "${state.query}"` + (_scopeName ? ` · ${_scopeName}` : ''),
      cat: { video: 'Films', audio: 'Music', image: 'Photos', document: 'Documents' }[state.sub] };
    parts.push({ label: titles[state.view] || titles.cat || '—' });
  }
  c.innerHTML = parts.map((p, i) =>
    `${i ? '<span class="sep">/</span>' : ''}<button class="${i === parts.length - 1 ? 'cur' : ''}" data-i="${i}">${esc(p.label)}</button>`).join('');
  c.querySelectorAll('button').forEach((b, i) => {
    if (parts[i].go) b.onclick = parts[i].go;
    // a crumb (except the current folder) is a move target: drop items to reparent them up the tree
    if (parts[i].drop !== undefined && i !== parts.length - 1) wireDropTarget(b, parts[i].drop);
  });
}

function setViewMode(m) {
  viewMode = m; localStorage.setItem('simplex.viewmode', m);
  document.querySelectorAll('#viewseg button').forEach(b => b.classList.toggle('on', b.dataset.v === m));
  render();
}

/* ---------- RENDER DISPATCH ---------- */
function render() {
  const _t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (currentApp === 'database') syncUrl();
  // mirror the current view onto window so the boot-guard watchdog can name WHERE a
  // freeze happened (it can't read these module-scoped vars otherwise -> reports app=?)
  try { window.currentApp = currentApp; window.state = state; } catch (e) {}
  _render();
  if (typeof raUpdateCtxChip === 'function') raUpdateCtxChip();   // keep the assistant's context chip live as the user navigates
  // self-time render so a freeze that happens INSIDE a sync render() (e.g. on a nav
  // click) is named in the watchdog report as app:render — the timer/rAF wraps can't
  // see a purely-synchronous click handler.
  try { const _d = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - _t0; if (window.__sxMark) window.__sxMark('render(' + (state && state.view) + ')', _d); } catch (e) {}
}
/* HOME view (Database dashboard) — CORE, not lazy: _render() paints it for
   state.view==="home" before any app module loads, so it must live here. (It was
   accidentally swept into apps-music.js during the Music extraction.) */
/* ---------- HOME ---------- */
function homeHTML() {
  const used = usedBytes();
  const recents = [...DB.files.filter(f => !f.trashed && f.type !== 'folder')].sort((a, b) => b.date - a.date).slice(0, 6);
  const tiles = [
    { t: 'video', label: 'Films', icon: 'video' }, { t: 'audio', label: 'Music', icon: 'audio' },
    { t: 'image', label: 'Photos', icon: 'image' }, { t: 'document', label: 'Documents', icon: 'document' },
    { t: 'model3d', label: 'Models', icon: 'model3d' }, { t: 'uasset', label: 'Game Assets', icon: 'uasset' },
  ];
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return `<div class="pad" data-screen-label="Home">
    <div class="hero">
      <div>
        <div class="big">${greet}.</div>
        <div class="greet-sub">optiplex-7070 · online · ${DB.files.filter(f=>!f.trashed&&f.type!=='folder').length} files on the vault</div>
      </div>
      <div class="stats">
        <div class="stat"><div class="v acc">${fmtSize(used)}</div><div class="k">Stored</div></div>
        <div class="stat"><div class="v">${fmtSize(Math.max(0, TOTAL_BYTES - used))}</div><div class="k">Free</div></div>
        <div class="stat"><div class="v">${SERVER_STARTED_AT ? fmtElapsed(Date.now() - SERVER_STARTED_AT) : '—'}</div><div class="k">Last restart</div></div>
        <div class="stat"><div class="v">${VAULT_BORN_AT ? fmtElapsed(Date.now() - VAULT_BORN_AT) : '—'}</div><div class="k">Uptime</div></div>
      </div>
    </div>
    <div class="tiles">
      ${tiles.map(t => `<div class="tile" data-tile="${t.t}">
        <div class="ti bg-${t.t} t-${t.t}">${svg(t.icon, 22, 1.7)}</div>
        <div class="k">${t.label}</div>
        <div class="c">${allOfType(t.t).length} items · ${fmtSize(bytesByType()[t.t])}</div>
      </div>`).join('')}
    </div>
    <div class="block-head"><h2>Recently added</h2><button data-allfiles>View all files →</button></div>
    <div class="grid">${recents.map(cardHTML).join('')}</div>
  </div>`;
}
function wireHome() {
  document.querySelectorAll('[data-tile]').forEach(t => t.onclick = () => go('cat', { sub: t.dataset.tile }));
  const af = document.querySelector('[data-allfiles]'); if (af) af.onclick = () => go('browse', { folder: null });
  wireItems();
  wireThumbs();
}

function _render() {
  renderNav(); renderStorage(); renderCrumbs(); renderSortBtn();
  document.querySelectorAll('#viewseg button').forEach(b => b.classList.toggle('on', b.dataset.v === viewMode));
  const content = document.getElementById('content');
  content.scrollTop = 0;
  if (state.view === 'home') { content.innerHTML = homeHTML(); wireHome(); return; }
  if (state.view === 'docs') {
    // The Guide (docsHTML/wireDocs + the whole DOCS wiki dataset) lives in guide.js,
    // loaded on demand — _render() is sync, so show a placeholder and re-render once
    // the module has loaded. Guard by typeof so subsequent renders are instant.
    if (typeof docsHTML === 'function') { content.innerHTML = docsHTML(); wireDocs(); return; }
    content.innerHTML = `<div class="pad-sm dim mono">Loading Guide…</div>`;
    loadFeature('guide').then(() => { if (state.view === 'docs') _render(); })
      .catch(() => { const c = document.getElementById('content'); if (c && state.view === 'docs') c.innerHTML = `<div class="pad-sm">Couldn't load the Guide — check your connection.</div>`; });
    return;
  }
  if (state.view === 'customapi') { content.innerHTML = customApiHTML(); wireCustomApi(); return; }
  if (state.view === 'tags') { content.innerHTML = tagsManagerHTML(); wireTagsManager(); return; }
  let items, title, sub;
  if (state.view === 'browse') { items = children(state.folder); title = state.folder ? byId(state.folder).name : 'All files'; sub = `${items.length} items`; }
  else if (state.view === 'cat') { items = allOfType(state.sub); title = { video: 'Films', audio: 'Music', image: 'Photos', document: 'Documents', model3d: 'Models', uasset: 'Game Assets' }[state.sub]; sub = `${items.length} items · ${fmtSize(items.reduce((s, f) => s + (f.size || 0), 0))}`; }
  else if (state.view === 'starred') { items = starred(); title = 'Starred'; sub = `${items.length} items`; }
  else if (state.view === 'trash') { items = trashed(); title = 'Trash'; sub = `${items.length} items`; }
  else if (state.view === 'search') {
    items = searchItems(state.query, state.scope);
    const scoped = state.scope != null && byId(state.scope);
    title = 'Search';
    sub = `${items.length} result${items.length === 1 ? '' : 's'} for "${state.query}"` + (scoped ? ` in ${scoped.name}` : '');
  }
  else if (state.view === 'tag') {
    const t = tagById(state.tag);
    items = itemsWithTag(state.tag);
    title = t ? t.name : 'Tag';
    sub = `${items.length} item${items.length === 1 ? '' : 's'} tagged`;
  }
  content.innerHTML = `<div class="pad" data-screen-label="${esc(title)}">${listHeader(title, sub)}${renderItems(items)}</div>`;
  wireItems();
  wireThumbs();          // lazy, connection-limited thumbnail loading (prevents connection-pool exhaustion)
  wireContentSurface();
  renderSelectionBar();
}

function listHeader(title, sub) {
  let extra = '';
  if (state.view === 'trash' && trashed().length) {
    extra = `<button class="btn ghost" id="emptyTrashBtn" style="margin-left:auto">${svg('trash', 14)} Empty trash</button>`;
  } else if (state.view === 'search') {
    // File-Explorer style scope switch: when scoped to a folder offer "search
    // everywhere"; when searching all and a folder is in the path, offer to
    // narrow. The scope toggle only shows when there's a folder to scope to.
    const scoped = state.scope != null && byId(state.scope);
    if (scoped) {
      extra = `<button class="btn ghost" id="searchScopeBtn" style="margin-left:auto" title="Search the whole database instead">${svg('hdd', 14)} Search everywhere</button>`;
    }
  }
  return `<div class="section-head"><h1>${esc(title)}</h1><span class="sub">${esc(sub)}</span>${extra}</div>`;
}

function renderItems(items) {
  if (!items.length) return emptyHTML();
  items = sortItems(items);
  return viewMode === 'grid' ? gridHTML(items) : listHTML(items);
}
function sortKind(f) { return f.type === 'folder' ? '' : (fileExt(f.name) || f.type); }
function sortItems(items) {
  const dir = sortDir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    // folders always grouped before files, regardless of the active sort
    if ((a.type === 'folder') !== (b.type === 'folder')) return a.type === 'folder' ? -1 : 1;
    let cmp;
    if (sortKey === 'size') cmp = (a.size || 0) - (b.size || 0);
    else if (sortKey === 'date') cmp = (a.date || 0) - (b.date || 0);
    else if (sortKey === 'type') cmp = sortKind(a).localeCompare(sortKind(b));
    else if (sortKey === 'tag') {
      // sort by first tag's name; untagged items sort last (within their group)
      const ta = tagsOf(a), tb = tagsOf(b);
      const sa = ta.length ? ta[0].name.toLowerCase() : '￿';
      const sb = tb.length ? tb[0].name.toLowerCase() : '￿';
      cmp = sa.localeCompare(sb);
    }
    else cmp = a.name.localeCompare(b.name);
    if (cmp === 0) cmp = a.name.localeCompare(b.name);   // stable name tiebreak
    return cmp * dir;
  });
}
function setSort(k) {
  if (sortKey === k) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  else { sortKey = k; sortDir = (k === 'date' || k === 'size') ? 'desc' : 'asc'; }
  localStorage.setItem('simplex.sortkey', sortKey);
  localStorage.setItem('simplex.sortdir', sortDir);
  render();
}
function renderSortBtn() {
  const b = document.getElementById('sortBtn'); if (!b) return;
  const s = SORTS.find(x => x.k === sortKey) || SORTS[0];
  b.querySelector('#sortLabel').textContent = s.label;
  b.querySelector('#sortDir').innerHTML = svg(sortDir === 'asc' ? 'arrowup' : 'arrowdown', 14);
}
function showSortMenu(anchor) {
  hideCtx();
  const menu = document.createElement('div');
  menu.className = 'ctx sort-menu';
  menu.innerHTML = SORTS.map(s => {
    const on = s.k === sortKey;
    return `<button data-k="${s.k}" class="${on ? 'on' : ''}">${on ? svg('check', 14) : '<span class="sp"></span>'} ${s.label}${on ? `<span class="dir">${svg(sortDir === 'asc' ? 'arrowup' : 'arrowdown', 13)}</span>` : ''}</button>`;
  }).join('');
  document.body.appendChild(menu); ctxEl = menu;
  const r = anchor.getBoundingClientRect(), mr = menu.getBoundingClientRect();
  menu.style.left = Math.min(r.left, innerWidth - mr.width - 10) + 'px';
  menu.style.top = (r.bottom + 6) + 'px';
  menu.querySelectorAll('[data-k]').forEach(btn => btn.onclick = (e) => { e.stopPropagation(); hideCtx(); setSort(btn.dataset.k); });
}
function emptyHTML() {
  const msg = state.view === 'trash' ? 'trash is empty' : state.view === 'starred' ? 'nothing starred yet' : state.view === 'search' ? 'no matches' : state.view === 'tag' ? 'nothing tagged with this yet' : 'this folder is empty';
  const showUpload = state.view !== 'trash' && state.view !== 'search' && state.view !== 'tag';
  // Note: no inline onclick — the CSP forbids inline handlers. A delegated click
  // listener (see setup near the global click handler) acts on data-act="upload".
  return `<div class="empty"><div class="ico">${svg('hdd', 40, 1.4)}</div><p>${msg}</p>${showUpload ? '<button class="btn ghost" data-act="upload">'+svg('download',14)+' Upload files</button>' : ''}</div>`;
}

/* ---------- GRID ---------- */
function gridHTML(items) {
  return `<div class="grid">${items.map(cardHTML).join('')}</div>`;
}
/* per-item selection decorations, only in file-manager views */
function selClasses(id) {
  let c = '';
  if (selection.has(id)) c += ' sel';
  if (clipboard && clipboard.mode === 'cut' && clipboard.ids.includes(id)) c += ' cut';
  return c;
}
function selCheckbox() { return selectionEnabled() ? `<span class="selcb" title="Select">${svg('check', 12, 2.4)}</span>` : ''; }

function cardHTML(f) {
  // In search results, surface each match's location (File-Explorer style).
  const locLine = state.view === 'search'
    ? `<div class="det"><span class="loc" title="${esc(locationLabel(f))}">${svg('folder', 11, 1.6)} ${esc(locationLabel(f))}</span></div>` : '';
  const tagLine = (() => { const h = fileTagsHTML(f); return h ? `<div class="card-tags">${h}</div>` : ''; })();
  if (f.type === 'folder') {
    const n = children(f.id).length;
    return `<div class="card folder${selClasses(f.id)}" data-id="${f.id}">
      <div class="thumb">${selCheckbox()}<span class="fic">${svg('folder', 52, 1.3)}</span>${_looksLocked(f) ? `<span class="lock-badge">${svg('lock', 12)}</span>` : ''}</div>
      <div class="meta"><div class="nm">${esc(f.name)}</div><div class="det"><span>${n} item${n !== 1 ? 's' : ''}</span><span>${fmtDate(f.date)}</span></div>${locLine}${tagLine}</div>
    </div>`;
  }
  return `<div class="card${selClasses(f.id)}" data-id="${f.id}">
    <div class="thumb">${selCheckbox()}${thumbHTML(f)}
      ${f.type === 'video' && f.dur ? `<span class="dur">${fmtDur(f.dur)}</span>` : ''}
      ${f.type === 'audio' && f.dur ? `<span class="dur">${fmtDur(f.dur)}</span>` : ''}
      <span class="badge">${fileExt(f.name) || f.type}</span>
      ${isLegacyFile(f) ? `<span class="legacy-badge" title="Stored under the old key — re-encrypt to edit or download">LEGACY</span>` : ''}
      ${_looksLocked(f) ? `<span class="lock-badge">${svg('lock', 12)}</span>` : ''}
      ${(f.type === 'video' || f.type === 'audio') ? `<div class="play-ov"><div class="pbtn">${svg('play', 18)}</div></div>` : ''}
    </div>
    <div class="meta"><div class="nm">${esc(f.name)}</div><div class="det"><span>${fmtSize(f.size)}</span><span>${fmtDate(f.date)}</span></div>${locLine}${tagLine}${uploadSuggestionChipsHTML(f.id)}</div>
  </div>`;
}
/* Thumbnails are LAZY and connection-limited.
   Critical: the browser caps simultaneous connections per host (~6). A folder
   with many videos/images that each eagerly open a stream to /api/files/ID/raw
   will exhaust that pool — and because the app's own /api/files and /api/poll
   calls go to the same host, the whole page stops responding once you open a
   media-heavy folder and switch around. So:
     - videos NEVER auto-stream for a thumbnail (a <video> streams the file just
       to grab a frame — the single worst offender); they show a static icon
       unless the user set a cover image.
     - images + covers load lazily via a small queue (loadThumb) that caps how
       many thumbnail connections are open at once, and are cancelled when the
       view re-renders (navigating away). */
function thumbHTML(f) {
  if (_looksLocked(f)) return `<span class="t-folder" style="display:flex;align-items:center;justify-content:center;opacity:.8">${svg('lock', 34, 1.3)}</span>`;
  const cover = f.coverUrl ? coverSrc(f) : null;
  if (cover) return `<img class="cover-img lazy-thumb" data-thumb="${esc(cover)}" alt="">`;
  // exr/tiff images can't render in an <img>; use the server PNG preview (posterUrl),
  // falling back to the image icon if the preview isn't available (e.g. ffmpeg missing).
  if (f.type === 'image' && needsImgPreview(f)) {
    if (f.posterUrl) return `<img class="lazy-thumb" data-thumb="${esc(f.posterUrl)}" data-fallback="image" alt="">`;
    return `<span class="t-image" style="opacity:.62">${svg('image', 44, 1.2)}</span>`;
  }
  if (f.type === 'image' && mediaUrl(f)) return `<img class="lazy-thumb" data-thumb="${esc(mediaUrl(f))}" alt="">`;
  // video: the SERVER generates a poster frame with ffmpeg (f.posterUrl) and we load
  // it lazily as a tiny image — just like a cover. The browser no longer downloads the
  // video file itself to build a thumbnail (which used to flood connections and freeze
  // a video-heavy folder). A missing/failed poster falls back to the video icon.
  if (f.type === 'video') {
    if (f.posterUrl) return `<img class="cover-img lazy-thumb vid-thumb" data-thumb="${esc(f.posterUrl)}" data-fallback="video" alt="">`;
    return `<span class="t-video" style="opacity:.62">${svg('video', 44, 1.2)}</span>`;
  }
  // executable (.exe/.dll/…): show the icon embedded in the file itself. The
  // server extracts it from the PE resources on first request (f.iconUrl); we
  // load it lazily like any thumbnail and fall back to the document icon if the
  // file has no extractable icon (server returns 404 -> data-fallback swap).
  if (f.iconUrl) {
    return `<div class="exe-thumb"><img class="exe-icon lazy-thumb" data-thumb="${esc(f.iconUrl)}" data-fallback="exe" alt=""></div>`;
  }
  // document: a text snippet card. Content-backed docs render their first lines
  // inline (no network); blob-backed (uploaded) docs fetch a tiny range lazily.
  if (f.type === 'document') {
    const langLbl = (typeof langForName === 'function') ? langForName(f.name).label : '';
    const tag = langLbl ? `<span class="snip-tag mono">${esc(langLbl)}</span>` : '';
    if (f.content != null) return `<div class="thumb-snippet">${tag}<pre>${esc(snippetOf(f.content))}</pre></div>`;
    // blob-backed OR content-backed (body no longer in the list): load snippet lazily
    if (mediaUrl(f) || f.hasContent) return `<div class="thumb-snippet" data-snippet="${esc(f.id)}">${tag}<pre></pre></div>`;
    return `<span class="t-document" style="opacity:.6">${svg('document', 44, 1.2)}</span>`;
  }
  // 3D model: a cube icon thumbnail (rendering a live preview per card would be far
  // too heavy — the full WebGL viewer opens on click).
  if (f.type === 'model3d') return `<span class="t-model3d" style="opacity:.62">${svg('model3d', 44, 1.2)}</span>`;
  // Unreal .uasset: a package-box icon thumbnail; the inspector opens on click.
  if (f.type === 'uasset') return `<span class="t-uasset" style="opacity:.62">${svg('uasset', 44, 1.2)}</span>`;
  const labels = { audio: 'album art', image: 'photo' };
  return `<div class="ph"><span class="lbl">${labels[f.type] || 'preview'}</span></div>`;
}
/* first ~12 non-empty-ish lines, clipped, for a snippet card */
function snippetOf(text) {
  return String(text || '').replace(/\t/g, '  ').split('\n').slice(0, 12).join('\n').slice(0, 600);
}
/* cache-busting cover url so a freshly-changed cover repaints immediately */
function coverSrc(f) { return f.coverUrl + (f.coverVer ? (f.coverUrl.includes('?') ? '&' : '?') + 'v=' + f.coverVer : ''); }

/* ---------- lazy thumbnail loader (bounded concurrency) ----------
   Handles two kinds of lazily-built preview cards, sharing ONE small concurrency
   budget so a media-heavy folder can never exhaust the browser's ~6-connections-
   per-host limit (which would also stall /api/files & /api/poll):
     - <img.lazy-thumb>      image / cover / VIDEO-POSTER thumbnails (load via data-thumb)
     - [data-snippet]        text snippet cards for uploaded docs (tiny range GET)
   Video posters are tiny server-generated JPEGs (data-fallback="video" -> icon on
   error); the browser no longer downloads video files to build thumbnails. */
const THUMB_MAX_CONCURRENT = 4;        // leave headroom under the ~6/host cap for API calls
let _thumbActive = 0;
let _thumbQueue = [];
let _thumbObserver = null;
let _thumbAbort = null;                // aborts in-flight snippet fetches on renavigate
/* cancel everything in flight/queued — call before re-rendering a view so
   thumbnails for the folder you just left stop competing for connections */
function resetThumbs() {
  if (_thumbObserver) { _thumbObserver.disconnect(); _thumbObserver = null; }
  if (_thumbAbort) { try { _thumbAbort.abort(); } catch (e) {} }
  _thumbAbort = new AbortController();
  _thumbQueue = [];
  // abort any <img> still loading by clearing its src
  document.querySelectorAll('img.lazy-thumb[data-loading]').forEach(img => { img.removeAttribute('src'); img.removeAttribute('data-loading'); });
  document.querySelectorAll('[data-loading]').forEach(el => el.removeAttribute('data-loading'));
  _thumbActive = 0;
}
function pumpThumbs() {
  while (_thumbActive < THUMB_MAX_CONCURRENT && _thumbQueue.length) {
    const el = _thumbQueue.shift();
    if (!el || !el.isConnected || el.hasAttribute('data-loading') || el.hasAttribute('data-done')) continue;
    _thumbActive++;
    el.setAttribute('data-loading', '1');
    const done = () => { el.removeAttribute('data-loading'); el.setAttribute('data-done', '1'); _thumbActive--; pumpThumbs(); };
    if (el.tagName === 'IMG') loadImgThumb(el, done);
    else if (el.dataset.snippet) loadSnippetThumb(el, done);
    else done();
  }
}
function loadImgThumb(img, done) {
  if (!img.dataset.thumb) return done();
  img.onload = done;
  img.onerror = () => {
    // a video poster that isn't ready / failed (404, ffmpeg unavailable) — swap in the
    // plain video icon instead of a broken image, so the grid degrades gracefully.
    if (img.dataset.fallback === 'video' && img.parentNode) {
      const span = document.createElement('span');
      span.className = 't-video'; span.style.opacity = '.62';
      span.innerHTML = svg('video', 44, 1.2);
      img.replaceWith(span);
    }
    // an exr/tiff whose server PNG preview failed (404, ffmpeg unavailable) —
    // show the generic image glyph rather than a broken thumbnail.
    else if (img.dataset.fallback === 'image' && img.parentNode) {
      const span = document.createElement('span');
      span.className = 't-image'; span.style.opacity = '.62';
      span.innerHTML = svg('image', 44, 1.2);
      img.replaceWith(span);
    }
    // an executable with no extractable icon (server 404) — fall back to the
    // generic document icon so the card doesn't show a broken image.
    else if (img.dataset.fallback === 'exe' && img.parentNode) {
      const span = document.createElement('span');
      span.className = 't-document'; span.style.opacity = '.6';
      span.innerHTML = svg('document', 44, 1.2);
      (img.closest('.exe-thumb') || img).replaceWith(span);
    }
    // list-view: restore the small generic document glyph inside the .ti chip
    else if (img.dataset.fallback === 'exe-sm') {
      const ti = img.closest('.ti');
      if (ti) { ti.className = 'ti bg-document t-document'; ti.innerHTML = svg('document', 16, 1.7); }
    }
    done();
  };
  img.src = img.dataset.thumb;
}
/* fetch the first ~2KB of an uploaded doc's text and fill the snippet card */
function loadSnippetThumb(card, done) {
  const f = byId(card.dataset.snippet);
  if (!f) return done();
  const sig = _thumbAbort && _thumbAbort.signal;
  const url = mediaUrl(f);
  // blob-backed doc: tiny range GET of the raw text. content-backed doc: the body
  // isn't in the list anymore, so pull it from the content endpoint (JSON).
  const p = url
    ? fetch(url, { headers: { Range: 'bytes=0-2047' }, signal: sig })
        .then(r => (r.ok || r.status === 206) ? r.text() : Promise.reject())
    : (f.hasContent
        ? fetch('/api/files/' + f.id + '/content', { signal: sig })
            .then(r => r.ok ? r.json() : Promise.reject())
            .then(j => j.content || '')
        : Promise.reject());
  p.then(txt => { const pre = card.querySelector('pre'); if (pre) pre.textContent = snippetOf(txt); })
    .catch(() => {})
    .finally(done);
}
/* wire up lazy loading for the preview cards currently in the DOM */
function wireThumbs() {
  resetThumbs();
  const cards = [...document.querySelectorAll('img.lazy-thumb, [data-snippet]')];
  if (!cards.length) return;
  const root = document.getElementById('content');
  if (!('IntersectionObserver' in window)) {     // fallback: just queue them all
    cards.forEach(c => _thumbQueue.push(c)); pumpThumbs(); return;
  }
  _thumbObserver = new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (e.isIntersecting) { obs.unobserve(e.target); _thumbQueue.push(e.target); }
    }
    pumpThumbs();
  }, { root, rootMargin: '200px' });
  cards.forEach(c => _thumbObserver.observe(c));
  // Eagerly queue cards already in view. The observer's first async pass can miss
  // these on mobile when wire-up happens before #shell finishes its fade-in /
  // layout settles — leaving thumbnails blank until the user scrolls. A direct
  // rect check doesn't depend on that timing, so visible previews load right away.
  sweepVisibleThumbs(cards, root);
  // one more sweep after layout/fade settles, for anything not measurable yet
  requestAnimationFrame(() => sweepVisibleThumbs(cards, root));
}
/* queue any card whose box currently overlaps the scroll viewport (+200px) */
function sweepVisibleThumbs(cards, root) {
  const vr = root ? root.getBoundingClientRect() : { top: 0, bottom: innerHeight };
  const top = vr.top - 200, bottom = vr.bottom + 200;
  for (const c of cards) {
    if (!c.isConnected || c.hasAttribute('data-loading') || c.hasAttribute('data-done')) continue;
    const r = c.getBoundingClientRect();
    if (r.height === 0 && r.width === 0) continue;        // not laid out yet — leave it to the observer/next sweep
    if (r.bottom >= top && r.top <= bottom) {
      if (_thumbObserver) _thumbObserver.unobserve(c);
      _thumbQueue.push(c);
    }
  }
  pumpThumbs();
}

/* ---------- ALBUM COVERS ---------- */
let _coverInput = null;
function pickCover(id) {
  if (!_coverInput) {
    _coverInput = document.createElement('input');
    _coverInput.type = 'file'; _coverInput.accept = 'image/*'; _coverInput.className = 'hidden';
    document.body.appendChild(_coverInput);
  }
  _coverInput.value = '';
  _coverInput.onchange = async () => {
    const file = _coverInput.files && _coverInput.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Pick an image file', 'close'); return; }
    try {
      await setCover(id, file);
      render();
      if (activeViewer && byId(id) && byId(id).type === 'audio') refreshAudioCover(id);
      toast('Cover updated', 'image');
    } catch (e) { toast(e.message || 'Could not set cover', 'close'); }
  };
  _coverInput.click();
}
async function removeCover(id) {
  try { await clearCover(id); render(); if (activeViewer) refreshAudioCover(id); toast('Cover removed', 'trash'); }
  catch (e) { toast(e.message || 'Could not remove cover', 'close'); }
}
/* if the audio viewer is open for this track, repaint its album art live */
function refreshAudioCover(id) {
  const album = document.querySelector('.viewer #album'); if (!album) return;
  const f = byId(id); if (!f) return;
  if (f.coverUrl) album.innerHTML = `<img src="${coverSrc(f)}" alt="" class="cover-img">`;
  else album.innerHTML = `<div class="ph"><span class="lbl">album art</span></div>`;
}

/* ---------- EXTRACT ZIP ---------- */
async function extractZipItem(id) {
  const f = byId(id); if (!f) return;
  const parent = f.parent ?? null;
  toast('Extracting ' + f.name + '…', 'folder');
  try {
    const data = await extractZip(id, parent);
    render();
    toast(`Extracted into “${data.folderName}” · ${data.count} item${data.count !== 1 ? 's' : ''}`, 'check');
  } catch (e) {
    if (e.code === 'LIMIT') toast('Not enough storage to extract this zip', 'close');
    else if (e.code === 'AUTH') relock();
    else toast(e.message || 'Could not extract zip', 'close');
  }
}

/* ---------- LIST ---------- */
function listHTML(items) {
  const col = (k, label) => `<span class="col ${sortKey === k ? 'active' : ''}" data-sort="${k}">${label}${sortKey === k ? svg(sortDir === 'asc' ? 'arrowup' : 'arrowdown', 12) : ''}</span>`;
  return `<div class="list">
    <div class="list-head">${col('name', 'Name')}${col('size', 'Size')}${col('type', 'Kind')}${col('date', 'Modified')}<span></span></div>
    ${items.map(rowHTML).join('')}
  </div>`;
}
function rowHTML(f) {
  const kind = f.type === 'folder' ? `${children(f.id).length} items` : (fileExt(f.name) || f.type);
  // compact meta line shown under the name on mobile (where the columns are hidden)
  let sub = f.type === 'folder' ? esc(kind) : `${fmtSize(f.size)} · ${esc(kind)} · ${fmtDate(f.date)}`;
  // In search results, show where each match lives (File-Explorer style), so
  // identically-named items in different folders are distinguishable.
  if (state.view === 'search') {
    const loc = locationLabel(f);
    sub = `${esc(loc)} · ${sub}`;
  }
  // executables show their own embedded icon (extracted server-side) in place of
  // the generic type glyph; falls back to the type glyph if none is extractable.
  const icoCell = f.iconUrl
    ? `<span class="ti exe-ti"><img class="exe-icon-sm lazy-thumb" data-thumb="${esc(f.iconUrl)}" data-fallback="exe-sm" alt=""></span>`
    : `<span class="ti bg-${f.type} t-${f.type}">${svg(f.type, 16, 1.7)}</span>`;
  return `<div class="row${selClasses(f.id)}" data-id="${f.id}">
    <div class="nmcell">
      ${selCheckbox()}
      ${icoCell}
      <span class="nm-wrap">
        <span class="nm">${esc(f.name)}</span>
        <span class="nm-sub mono">${sub}</span>
      </span>
      ${fileTagsHTML(f)}
      ${f.type !== 'folder' ? uploadSuggestionChipsHTML(f.id) : ''}
      ${isLegacyFile(f) ? `<span class="legacy-badge" title="Stored under the old key — re-encrypt to edit or download">LEGACY</span>` : ''}
      ${f.locked ? `<span class="lock-badge">${svg('lock', 12)}</span>` : ''}
      ${f.starred ? `<span class="t-folder" style="flex:none">${svg('star', 13, 1.7)}</span>` : ''}
    </div>
    <div class="cell">${f.type === 'folder' ? '—' : fmtSize(f.size)}</div>
    <div class="cell">${esc(kind)}</div>
    <div class="cell">${fmtDate(f.date)}</div>
    <div class="rowact"><button class="iconbtn" data-more="${f.id}">${svg('more', 16)}</button></div>
  </div>`;
}

/* Analytics, Simplex Visual & Bug Reports extracted to apps-misc.js
   (lazy-loaded via loadFeature in openApp). */
/* DISCORD BOT app extracted to apps-discord.js (lazy via openLazyApp). */

/* MUSIC + JAM screen extracted to apps-music.js (lazy via openLazyApp).
   The Player/EQ + these Player-touched helpers stay here in core: */
const MU = {
  tab: 'library',                 // 'library' | 'playlists' | 'jams'
  tracks: [],                     // shared library (track api objects)
  playlists: [],                  // visible playlists
  openPlaylist: null,             // { playlist, tracks, canManage } when viewing one
  selectMode: false,              // library multi-select on/off
  selected: new Set(),            // selected track ids while in select mode
  search: '',                     // library search query (title / artist / uploader)
  spotlight: null,                // cached 3 random "today" track ids (stable per load)
  reportCount: 0,                 // open report count (admins) → shows the Reports tab
  // ---- jam (drives Player) ----
  jamTimer: null,
  jamBusy: false,
  applyingRemote: false,          // guard: don't echo remote-driven Player events back as control
  scrubUntil: 0,                  // suppress drift-seek while the user scrubs
  _pendingPos: null,
};
function muOnMusic() { return currentApp === 'music'; }
function muProgressiveImgHTML(url) {
  if (!CoverLoader.isMusic(url)) return `<img src="${esc(url)}" alt="">`;
  if (CoverLoader.known(url)) return `<img src="${esc(url)}" alt="">`;   // original already cached — skip the lo step
  return `<img src="${esc(CoverLoader.loUrl(url))}" data-hi="${esc(url)}" alt="">`;
}
async function musicOpenPlaylist(id) {
  if (!muOnMusic()) { await openApp('music'); }
  // openApp('music') loads apps-music.js, but guard in case we were already "on music"
  // via a stale state; musicPlaylist/renderMusicBody live in that lazy module.
  try { await loadFeature('apps-music'); } catch (e) {}
  try {
    const data = await musicPlaylist(id);
    MU.openPlaylist = data; MU.tab = 'playlists';
    renderMusicBody();
  } catch (e) {
    if (e && e.code === 'AUTH') return relock();
    toast(e.message || 'Could not open playlist', 'close');
  }
}
/* ============================================================
   TAGS — create/manage tags, attach to files/folders, browse by tag.
   The dictionary (TAGS) + per-file id-arrays live server-side; helpers in data.js.
   ============================================================ */
const TAG_COLORS = ['#e0a64a', '#5aa9e6', '#7ed957', '#e6685a', '#b07ee6', '#46c2b6', '#e6a0c4', '#9aa0a6'];
function tagColor(t) { return (t && t.color) || 'var(--acc)'; }

/* a single tag chip; clickable variant navigates to the tag's filter view */
function tagChip(t, { clickable = false } = {}) {
  if (!t) return '';
  const click = clickable ? ` data-tagchip="${t.id}" role="button" tabindex="0"` : '';
  return `<span class="tag-chip${clickable ? ' clickable' : ''}" style="--tc:${esc(tagColor(t))}"${click}><i class="dot"></i>${esc(t.name)}</span>`;
}
/* compact chip strip for a file's tags (used on rows/cards) */
function fileTagsHTML(f) {
  const ts = tagsOf(f);
  if (!ts.length) return '';
  return `<span class="tag-strip">${ts.map(t => tagChip(t)).join('')}</span>`;
}

function tagsManagerHTML() {
  const tags = allTags();
  const rows = tags.map(t => {
    const n = countWithTag(t.id);
    return `<div class="tag-row" data-tagid="${t.id}">
      <button class="tag-open" data-open="${t.id}" title="Browse items with this tag">
        <span class="tag-chip lg" style="--tc:${esc(tagColor(t))}"><i class="dot"></i>${esc(t.name)}</span>
      </button>
      <span class="tag-count">${n} item${n === 1 ? '' : 's'}</span>
      <span class="tag-acts">
        <button class="iconbtn" data-edit="${t.id}" title="Edit tag">${svg('rename', 15)}</button>
        <button class="iconbtn" data-del="${t.id}" title="Delete tag">${svg('trash', 15)}</button>
      </span>
    </div>`;
  }).join('');
  return `<div class="pad" data-screen-label="Tags">
    <div class="section-head">
      <h1>Tags</h1>
      <span class="sub">${tags.length} tag${tags.length === 1 ? '' : 's'}</span>
      <button class="btn primary" id="newTagBtn" style="margin-left:auto">${svg('plus', 14)} New tag</button>
    </div>
    ${tags.length ? `<div class="tag-list">${rows}</div>`
      : `<div class="empty"><div class="ico">${svg('tag', 40, 1.4)}</div><p>no tags yet</p><button class="btn ghost" id="newTagBtn2">${svg('plus', 14)} Create your first tag</button></div>`}
  </div>`;
}
function wireTagsManager() {
  const openNew = () => editTagModal(null);
  const a = document.getElementById('newTagBtn'); if (a) a.onclick = openNew;
  const b = document.getElementById('newTagBtn2'); if (b) b.onclick = openNew;
  document.querySelectorAll('[data-open]').forEach(el => el.onclick = () => go('tag', { tag: el.dataset.open }));
  document.querySelectorAll('[data-edit]').forEach(el => el.onclick = (e) => { e.stopPropagation(); editTagModal(el.dataset.edit); });
  document.querySelectorAll('[data-del]').forEach(el => el.onclick = (e) => { e.stopPropagation(); confirmDeleteTag(el.dataset.del); });
}

/* create (id=null) or edit a tag: name + color */
function editTagModal(id) {
  const existing = id ? tagById(id) : null;
  let color = existing ? tagColor(existing) : TAG_COLORS[0];
  if (color === 'var(--acc)') color = TAG_COLORS[0];
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal tag-modal">
    <h3>${existing ? 'Edit tag' : 'New tag'}</h3>
    <p>Name it and pick a color.</p>
    <input id="tagName" maxlength="60" placeholder="e.g. Important" value="${existing ? esc(existing.name) : ''}" autocomplete="off" />
    <div class="tag-swatches" id="tagSwatches">
      ${TAG_COLORS.map(c => `<button type="button" class="swatch ${c === color ? 'on' : ''}" data-c="${c}" style="--sw:${c}"></button>`).join('')}
      <label class="swatch custom" title="Custom color"><input type="color" id="tagCustom" value="${esc(color)}"></label>
    </div>
    <div class="tag-preview"><span class="eyebrow">Preview</span> <span class="tag-chip" id="tagPrev" style="--tc:${esc(color)}"><i class="dot"></i>${existing ? esc(existing.name) : 'Tag'}</span></div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>${existing ? 'Save' : 'Create'}</button></div>
  </div>`;
  document.body.appendChild(bg);
  const nameEl = bg.querySelector('#tagName');
  const swatches = bg.querySelector('#tagSwatches');
  const custom = bg.querySelector('#tagCustom');
  const prev = bg.querySelector('#tagPrev');
  const syncPrev = () => { prev.style.setProperty('--tc', color); prev.lastChild.textContent = nameEl.value.trim() || 'Tag'; };
  const pick = (c) => { color = c; swatches.querySelectorAll('.swatch').forEach(s => s.classList.toggle('on', s.dataset.c === c)); custom.value = c; syncPrev(); };
  swatches.querySelectorAll('[data-c]').forEach(s => s.onclick = () => pick(s.dataset.c));
  custom.oninput = () => { color = custom.value; swatches.querySelectorAll('.swatch').forEach(s => s.classList.remove('on')); syncPrev(); };
  nameEl.oninput = syncPrev;
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = (e) => { if (e.target === bg) close(); };
  nameEl.focus();
  const save = async () => {
    const name = nameEl.value.trim();
    if (!name) { nameEl.focus(); return; }
    try {
      if (existing) await updateTag(id, { name, color });
      else await createTag({ name, color });
      await loadTags();
      close();
      render();
      toast(existing ? 'Tag updated' : 'Tag created');
    } catch (e) { toast(e && e.message ? e.message : 'Could not save tag', 'close'); }
  };
  bg.querySelector('[data-ok]').onclick = save;
  nameEl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') close(); };
}

function confirmDeleteTag(id) {
  const t = tagById(id); if (!t) return;
  const n = countWithTag(id);
  const msg = n ? `"${t.name}" will be removed from ${n} item${n === 1 ? '' : 's'}. The items are not deleted.` : `Delete "${t.name}"?`;
  confirmModal('Delete tag', msg, async () => {
    try {
      await deleteTag(id);
      await loadDB();   // file rows change (tag stripped) — reload everything
      if (state.view === 'tag' && state.tag === id) go('tags'); else render();
      toast('Tag deleted');
    } catch (e) { toast(e && e.message ? e.message : 'Could not delete tag', 'close'); }
  }, 'Delete');
}

/* toggle tags on a set of files/folders via a small popover of all tags.
   Positioned at `pt` (defaults to where the context menu last opened). */
function openTagPicker(ids, pt) {
  const at = pt || _lastCtxPt || { x: innerWidth / 2, y: innerHeight / 2 };
  hideCtx();
  if (!ids.length) return;
  const tags = allTags();
  const panel = document.createElement('div');
  panel.className = 'ctx tag-picker';
  // a tag is "on" for the selection only if EVERY item carries it
  const onFor = (tid) => ids.every(i => { const f = byId(i); return f && Array.isArray(f.tags) && f.tags.includes(tid); });
  const someFor = (tid) => ids.some(i => { const f = byId(i); return f && Array.isArray(f.tags) && f.tags.includes(tid); });
  panel.innerHTML = `
    <div class="ctxhead">Tags${ids.length > 1 ? ` · ${ids.length} items` : ''}</div>
    ${tags.length ? tags.map(t => {
      const on = onFor(t.id), some = someFor(t.id);
      return `<button data-tt="${t.id}" class="tagopt ${on ? 'on' : some ? 'partial' : ''}">
        <span class="chk">${on ? svg('check', 14) : some ? '–' : '<span class="sp"></span>'}</span>
        <span class="tag-chip" style="--tc:${esc(tagColor(t))}"><i class="dot"></i>${esc(t.name)}</span>
      </button>`;
    }).join('') : '<div class="ctxhead" style="opacity:.6">No tags yet</div>'}
    <div class="div"></div>
    <button data-newtag class="tagopt">${svg('plus', 14)} <span>New tag…</span></button>`;
  document.body.appendChild(panel); ctxEl = panel;
  panel.style.left = Math.min(at.x, innerWidth - panel.offsetWidth - 10) + 'px';
  panel.style.top = Math.min(at.y, innerHeight - panel.offsetHeight - 10) + 'px';
  panel.querySelectorAll('[data-tt]').forEach(btn => btn.onclick = async (e) => {
    e.stopPropagation();
    const tid = btn.dataset.tt;
    const turnOn = !onFor(tid);   // if not on-for-all, turning on adds to everyone; else remove
    for (const i of ids) {
      const f = byId(i); if (!f) continue;
      const cur = new Set(Array.isArray(f.tags) ? f.tags : []);
      if (turnOn) cur.add(tid); else cur.delete(tid);
      await setFileTags(i, [...cur]);
    }
    // refresh the popover state + the underlying view, reopening at the same spot
    hideCtx(); render(); openTagPicker(ids, at);
  });
  const nt = panel.querySelector('[data-newtag]');
  if (nt) nt.onclick = (e) => { e.stopPropagation(); hideCtx(); editTagModal(null); };
}

/* ============================================================
   AI ORGANIZATION — suggestion chips (post-upload) + "AI Store…" modal
   The per-user organizer model (server-side) returns suggested folders and tags
   with confidence scores. We surface them two ways:
     • A transient CHIP bar under a just-uploaded file's row/tile for one hour.
     • The "AI Store…" modal (right-click), which works any time — including after
       the chip has auto-hidden — by re-reading the stored suggestion.
   Accepting reinforces the model (and moves/tags the file); dismissing/rejecting
   is negative feedback. All of that rides the /api/organizer/* endpoints.
   ============================================================ */

/* merge a server file record back into the local cache + repaint. */
function _applyFileRec(rec) {
  if (!rec || !rec.id) return;
  const i = DB.files.findIndex(x => x.id === rec.id);
  if (i >= 0) DB.files[i] = rec; else DB.files.push(rec);
  render();
}

/* The "AI Store…" modal — shows recommended folders + tags with confidence, and
   lets the user file the item or apply tags. Reads the (possibly hidden) stored
   suggestion; recomputes a fresh one if none is stored yet. */
async function openAiStore(id) {
  const f = byId(id); if (!f) return;
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal aistore-modal">
    <h3>${svg('brain', 18)} AI Store</h3>
    <p class="aistore-file mono dim">${esc(f.name || '')}</p>
    <div class="aistore-body" id="aistoreBody"><div class="org-loading dim mono">${svg('brain', 14)} Thinking…</div></div>
    <div class="acts"><button class="btn ghost" data-close>Close</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-close]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };

  const body = bg.querySelector('#aistoreBody');
  let sug;
  try { sug = await organizerSuggestions(id, true); }
  catch (e) { body.innerHTML = `<div class="aistore-empty dim">Couldn't load suggestions.</div>`; return; }

  const render = () => {
    const folders = sug.folders || [], tags = sug.tags || [];
    if (!folders.length && !tags.length) {
      body.innerHTML = `<div class="aistore-empty">
        <div class="ae-ic">${svg('brain', 26)}</div>
        <div class="ae-t">No suggestions yet</div>
        <div class="ae-s mono dim">As your model learns from how you file things, suggestions for this file will appear here.</div>
      </div>`;
      return;
    }
    const conf = (c) => `<span class="aist-conf" title="confidence">${Math.round((c || 0) * 100)}%</span>`;
    body.innerHTML = `
      ${folders.length ? `<div class="aist-group"><div class="aist-head">${svg('folder', 13)} Suggested folder</div>
        ${folders.map((fo, i) => `<div class="aist-row" data-folder="${esc(fo.id)}">
          <span class="aist-label">${esc(fo.path)}</span>
          ${conf(fo.confidence)}
          <button class="btn sm ${i === 0 ? 'primary' : 'ghost'} aist-move" data-folder="${esc(fo.id)}">Move here</button>
        </div>`).join('')}</div>` : ''}
      ${tags.length ? `<div class="aist-group"><div class="aist-head">${svg('tag', 13)} Suggested tags</div>
        <div class="aist-tags">${tags.map(t => `<button class="aist-tag" data-tag="${esc(t.id)}" style="--tc:${esc(t.color || 'var(--acc)')}">
          <i class="dot"></i><span>${esc(t.name)}</span>${conf(t.confidence)}<span class="aist-add">${svg('plus', 12)}</span>
        </button>`).join('')}</div></div>` : ''}
      <div class="aist-foot">
        <span class="aist-foot-note mono dim">applies every suggestion above your confidence threshold</span>
        <button class="btn primary sm" data-applyall>${svg('check', 13)} Apply all</button>
      </div>`;

    body.querySelectorAll('.aist-move').forEach(btn => btn.onclick = async () => {
      btn.disabled = true;
      try {
        const r = await organizerFeedback(id, { acceptFolder: btn.dataset.folder });
        if (r && r.file) _applyFileRec(r.file);
        toast('Filed by AI suggestion', 'check');
        hideUploadSuggestion(id);
        close();
      } catch (e) { btn.disabled = false; toast('Could not move', 'close'); }
    });
    body.querySelectorAll('.aist-tag').forEach(btn => btn.onclick = async () => {
      const tid = btn.dataset.tag;
      btn.disabled = true;
      try {
        const r = await organizerFeedback(id, { acceptTags: [tid] });
        if (r && r.file) _applyFileRec(r.file);
        // drop the accepted tag from the working set + repaint the modal
        sug.tags = (sug.tags || []).filter(t => t.id !== tid);
        toast('Tag added', 'check');
        render();
        if (!(sug.folders || []).length && !(sug.tags || []).length) { hideUploadSuggestion(id); }
      } catch (e) { btn.disabled = false; toast('Could not add tag', 'close'); }
    });
    const ap = body.querySelector('[data-applyall]');
    if (ap) ap.onclick = async () => {
      ap.disabled = true;
      try {
        // server resolves applyAll: adds every tag ≥ threshold and moves to the
        // single highest-confidence folder (only if it clears the threshold).
        const r = await organizerFeedback(id, { applyAll: true });
        if (r && r.file) _applyFileRec(r.file);
        const bits = [];
        if (r && r.moved) bits.push('moved');
        if (r && r.appliedTags) bits.push(`${r.appliedTags} tag${r.appliedTags !== 1 ? 's' : ''}`);
        toast(bits.length ? `Applied — ${bits.join(' · ')}` : 'Nothing to apply', bits.length ? 'check' : 'info');
        hideUploadSuggestion(id);
        close();
      } catch (e) { ap.disabled = false; toast('Could not apply', 'close'); }
    };
  };
  render();
}

/* ---- transient post-upload suggestion chips ----
   After an upload, we fetch the file's suggestion and, if there's anything worth
   showing, remember it. The grid/list item renderer paints a small chip bar for
   any file in `_uploadSuggestions` whose suggestion is still within its 1-hour
   window; a timer prunes expired ones so the UI self-cleans. */
const _uploadSuggestions = new Map();   // fileId -> { folders, tags, expiresAt }
let _orgSuggestSweep = null;

function _ensureSuggestSweep() {
  if (_orgSuggestSweep) return;
  _orgSuggestSweep = setInterval(() => {
    const now = Date.now(); let changed = false;
    for (const [fid, s] of _uploadSuggestions) if (now >= s.expiresAt) { _uploadSuggestions.delete(fid); changed = true; }
    if (!_uploadSuggestions.size) { clearInterval(_orgSuggestSweep); _orgSuggestSweep = null; }
    if (changed) render();
  }, 30_000);
}
function hideUploadSuggestion(fileId) {
  if (_uploadSuggestions.delete(fileId)) render();
}
/* Called after a successful upload. Best-effort; silently no-ops if AI org is off
   or there's nothing to suggest. */
async function noteUploadForSuggestion(fileId) {
  try {
    const sug = await organizerSuggestions(fileId, true);
    if (!sug || !sug.active) return;
    if (!(sug.folders || []).length && !(sug.tags || []).length) return;
    const ttl = 60 * 60 * 1000;
    const age = sug.created ? (Date.now() - sug.created) : 0;
    _uploadSuggestions.set(fileId, { folders: sug.folders || [], tags: sug.tags || [], expiresAt: Date.now() + Math.max(0, ttl - age) });
    _ensureSuggestSweep();
    render();
  } catch (e) { /* advisory only */ }
}
/* Build the inline notice HTML for a file that has fresh suggestions (or '' if
   none). Rather than crowding the tile with folder/tag chips, we show ONE quiet
   pill that points at the full AI Store modal — clicking it opens the recommendations. */
function uploadSuggestionChipsHTML(fileId) {
  const s = _uploadSuggestions.get(fileId);
  if (!s) return '';
  const n = (s.folders ? s.folders.length : 0) + (s.tags ? s.tags.length : 0);
  if (!n) return '';
  return `<div class="org-note" data-org-for="${esc(fileId)}">
    <button class="org-note-btn" data-org-open="${esc(fileId)}" title="See AI Store recommendations">
      ${svg('brain', 11)}<span>AI Store has ${n} recommendation${n !== 1 ? 's' : ''}</span>
    </button>
    <button class="org-note-x" data-org-dismiss="${esc(fileId)}" title="Dismiss recommendations">${svg('close', 11)}</button>
  </div>`;
}
/* Wire the notice inside rendered items. Clicking the pill opens the AI Store modal;
   the × dismisses the recommendation. (stopPropagation so neither selects the item.) */
function wireUploadSuggestionChips(scope) {
  scope.querySelectorAll('[data-org-open]').forEach(btn => btn.onclick = (e) => {
    e.stopPropagation(); openAiStore(btn.dataset.orgOpen);
  });
  scope.querySelectorAll('[data-org-dismiss]').forEach(btn => btn.onclick = (e) => {
    e.stopPropagation(); dismissUploadSuggestions([btn.dataset.orgDismiss]);
  });
}

/* Dismiss the AI recommendations for one or more files: tell the server (records it
   as negative feedback + drops the stored suggestion) and hide the notice locally. */
function dismissUploadSuggestions(ids) {
  ids = (ids || []).filter(id => _uploadSuggestions.has(id));
  if (!ids.length) return;
  for (const id of ids) {
    const s = _uploadSuggestions.get(id);
    const rejectTags = s ? (s.tags || []).map(t => t.id) : [];
    organizerFeedback(id, { dismiss: true, rejectTags }).catch(() => {});
    _uploadSuggestions.delete(id);
  }
  render();
  toast(`Dismissed ${ids.length} recommendation${ids.length !== 1 ? 's' : ''}`, 'check');
}

/* GUIDE / DOCUMENTATION extracted to guide.js (lazy-loaded via loadFeature
   in _render when state.view==="docs"). docsHTML/wireDocs + DOCS dataset live there. */

/* ============================================================
   CUSTOM API — self-serve API keys (System tab). Lets an account drive its
   vault from an external app/workspace over the public /api/v1 surface.
   ============================================================ */
const API_SCOPE_INFO = [
  { id: 'read',     label: 'Read',            desc: 'List files & folders and read their metadata' },
  { id: 'download', label: 'Download & play', desc: 'Stream or download file contents (seeking supported)' },
  { id: 'upload',   label: 'Upload',          desc: 'Upload new files and create folders' },
  { id: 'delete',   label: 'Delete',          desc: 'Move files & folders to Trash' },
];
function apiBase() { return location.origin; }
function scopeLabel(id) { const s = API_SCOPE_INFO.find(x => x.id === id); return s ? s.label : id; }

function customApiHTML() {
  const base = esc(apiBase());
  return `<div class="pad api-pad" data-screen-label="Custom API">
    <div class="section-head"><h1>Custom API</h1><span class="sub">Use your account from your own apps & workspaces — free with every account</span></div>

    <div class="api-intro">
      <div class="api-ico">${svg('key', 26, 1.6)}</div>
      <div class="api-intro-body">
        <div class="api-intro-title">Build on your own vault</div>
        <p>Create a key, give it only the permissions you want, and use it to list, upload, download, and play your files from anywhere — your own website, a script, or another app. Don't like this UI? Wire your account straight into your own workflow. It's free as long as you have an account.</p>
        <div class="api-base mono">Base URL <code>${base}</code></div>
      </div>
    </div>

    <div class="set-section">
      <div class="api-section-head">
        <span class="eyebrow">Your API keys</span>
        <button class="btn primary" id="apiNew">${svg('plus', 14)} New API key</button>
      </div>
      <div id="apiKeyList" class="api-keylist"><div class="api-empty mono">Loading…</div></div>
    </div>

    ${apiQuickstartHTML(base)}
  </div>`;
}

function apiQuickstartHTML(base) {
  const ex = (lines) => `<pre class="api-code mono">${esc(lines.join('\n'))}</pre>`;
  return `<div class="set-section">
    <span class="eyebrow">Quickstart</span>
    <p class="api-note">Send your key in an <code>Authorization: Bearer</code> header (or an <code>X-API-Key</code> header). CORS is open, so you can also call it straight from a browser app.</p>

    <div class="api-doc-block">
      <div class="api-doc-h">List your files</div>
      ${ex([`curl ${base}/api/v1/files \\`, `  -H "Authorization: Bearer YOUR_API_KEY"`])}
    </div>
    <div class="api-doc-block">
      <div class="api-doc-h">Upload a file</div>
      ${ex([`curl ${base}/api/v1/files \\`, `  -H "Authorization: Bearer YOUR_API_KEY" \\`, `  -F "file=@song.mp3"`])}
    </div>
    <div class="api-doc-block">
      <div class="api-doc-h">Download or play a file</div>
      ${ex([`curl -L ${base}/api/v1/files/FILE_ID/raw \\`, `  -H "Authorization: Bearer YOUR_API_KEY" -o out.bin`])}
      <p class="api-note">The <code>/raw</code> endpoint honors <code>Range</code> requests, so you can seek &amp; stream media (audio/video) directly.</p>
    </div>
    <div class="api-doc-block">
      <div class="api-doc-h">All endpoints</div>
      ${ex([
        'GET    /api/v1/me',
        'GET    /api/v1/files?parent=&type=&search=&trashed=',
        'GET    /api/v1/files/:id',
        'GET    /api/v1/files/:id/raw      # stream / play / download',
        'GET    /api/v1/files/:id/cover',
        'POST   /api/v1/files             # multipart: file, parent?, type?',
        'POST   /api/v1/folders           # json: name, parent?',
        'DELETE /api/v1/files/:id         # moves to Trash',
      ])}
    </div>
  </div>`;
}

function wireCustomApi() {
  const newBtn = document.getElementById('apiNew');
  if (newBtn) newBtn.onclick = () => openCreateApiKey(loadApiKeys);
  loadApiKeys();
}

async function loadApiKeys() {
  const box = document.getElementById('apiKeyList');
  if (!box) return;
  try {
    const keys = await listApiKeys();
    if (!keys.length) {
      box.innerHTML = `<div class="api-empty"><div class="ico">${svg('key', 22, 1.4)}</div><p>No API keys yet — create one to start using the API.</p></div>`;
      return;
    }
    box.innerHTML = keys.map(apiKeyRowHTML).join('');
    box.querySelectorAll('[data-key]').forEach(wireApiKeyRow);
  } catch (e) {
    if (e && e.code === 'AUTH') return relock();
    box.innerHTML = `<div class="api-empty mono">Couldn't load keys: ${esc(e.message || 'error')}</div>`;
  }
}

function apiKeyRowHTML(k) {
  const scopes = (k.scopes || []).length
    ? k.scopes.map(s => `<span class="api-scope">${esc(scopeLabel(s))}</span>`).join('')
    : '<span class="api-scope none">no permissions</span>';
  const used = k.last_used ? `used ${esc(fmtDate(k.last_used))}` : 'never used';
  return `<div class="api-key ${k.enabled ? '' : 'off'}" data-key="${k.id}">
    <div class="ak-main">
      <div class="ak-top">
        <span class="ak-label">${esc(k.label || 'API key')}</span>
        <span class="ak-state ${k.enabled ? 'on' : ''}">${k.enabled ? 'Enabled' : 'Disabled'}</span>
      </div>
      <div class="ak-prefix mono">${esc(k.prefix)}<span class="ak-dots">••••••••</span></div>
      <div class="ak-scopes">${scopes}</div>
      <div class="ak-meta mono">created ${esc(fmtDate(k.created))} · ${used}</div>
    </div>
    <div class="ak-acts">
      <button class="btn ghost sm" data-toggle>${svg(k.enabled ? 'pause' : 'play', 13)} ${k.enabled ? 'Disable' : 'Enable'}</button>
      <button class="btn ghost sm" data-edit title="Edit permissions">${svg('rename', 13)}</button>
      <button class="btn ghost sm danger" data-del title="Delete key">${svg('trash', 13)}</button>
    </div>
  </div>`;
}

function wireApiKeyRow(row) {
  const id = row.dataset.key;
  const tgl = row.querySelector('[data-toggle]');
  const ed = row.querySelector('[data-edit]');
  const del = row.querySelector('[data-del]');
  if (tgl) tgl.onclick = async () => {
    const enabling = row.classList.contains('off');
    try { await updateApiKey(id, { enabled: enabling }); toast(enabling ? 'Key enabled' : 'Key disabled', 'check'); loadApiKeys(); }
    catch (e) { toast(e.message || 'Update failed', 'close'); }
  };
  if (ed) ed.onclick = () => openEditApiKey(id);
  if (del) del.onclick = () => confirmModal('Delete API key',
    'Apps using this key will stop working immediately. This cannot be undone.',
    async () => { try { await deleteApiKey(id); toast('Key deleted', 'trash'); loadApiKeys(); } catch (e) { toast(e.message || 'Delete failed', 'close'); } });
}

/* ---------- create / edit (custom modal: label + scope toggles) ---------- */
function scopeTogglesHTML(selected) {
  return API_SCOPE_INFO.map(s => `
    <label class="api-scope-opt">
      <input type="checkbox" data-scope="${s.id}" ${selected.includes(s.id) ? 'checked' : ''}>
      <span class="aso-text"><span class="aso-label">${esc(s.label)}</span><span class="aso-desc">${esc(s.desc)}</span></span>
    </label>`).join('');
}
function apiKeyModal({ title, desc, label, scopes, okLabel, onSubmit }) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal account-modal api-modal">
    <h3>${esc(title)}</h3><p>${esc(desc)}</p>
    <label class="form-field"><span class="eyebrow">Label</span>
      <input type="text" id="akLabel" value="${esc(label || '')}" placeholder="e.g. My website" maxlength="80"></label>
    <div class="eyebrow ak-perm-h">Permissions</div>
    <div class="api-scopes">${scopeTogglesHTML(scopes || [])}</div>
    <div class="form-err" id="akErr"></div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>${esc(okLabel)}</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  const err = bg.querySelector('#akErr');
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('[data-ok]').onclick = async () => {
    const lbl = bg.querySelector('#akLabel').value.trim();
    const picked = [...bg.querySelectorAll('[data-scope]:checked')].map(i => i.dataset.scope);
    if (!picked.length) { err.textContent = 'Pick at least one permission.'; return; }
    const ok = bg.querySelector('[data-ok]'); ok.disabled = true; err.textContent = '';
    try { await onSubmit({ label: lbl, scopes: picked }, close); }
    catch (e) { err.textContent = e.message || 'Something went wrong'; ok.disabled = false; }
  };
  bg.querySelector('#akLabel').focus();
}
function openCreateApiKey(onDone) {
  apiKeyModal({
    title: 'New API key',
    desc: "Name it and choose what it can do. You'll see the secret token once — copy it then.",
    label: '', scopes: ['read', 'download'], okLabel: 'Create key',
    onSubmit: async (vals, close) => { const rec = await createApiKey(vals); close(); revealTokenModal(rec, onDone); },
  });
}
function openEditApiKey(id) {
  listApiKeys().then(keys => {
    const k = keys.find(x => x.id === id); if (!k) return;
    apiKeyModal({
      title: 'Edit API key',
      desc: 'Update the label or what this key can do. Changes take effect immediately.',
      label: k.label || '', scopes: k.scopes || [], okLabel: 'Save',
      onSubmit: async (vals, close) => { await updateApiKey(id, vals); close(); toast('Key updated', 'check'); loadApiKeys(); },
    });
  }).catch(() => {});
}
function revealTokenModal(rec, onDone) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal account-modal api-modal">
    <h3>${svg('check', 18)} API key created</h3>
    <p class="api-warn">Copy your secret token now — it's hashed on the server for your security and <b>won't be shown again</b>.</p>
    <div class="api-token-box">
      <code class="api-token mono">${esc(rec.token)}</code>
      <button class="btn ghost sm" id="akCopy" title="Copy token">${svg('copy', 14)} Copy</button>
    </div>
    <p class="api-note">Permissions: ${(rec.scopes || []).map(s => `<span class="api-scope">${esc(scopeLabel(s))}</span>`).join(' ') || '—'}</p>
    <div class="acts"><button class="btn primary" data-ok>Done</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); if (onDone) onDone(); };
  bg.querySelector('[data-ok]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('#akCopy').onclick = () => { copyText(rec.token); toast('Token copied', 'copy'); };
}

/* ---------- ITEM WIRING ---------- */
function wireItems() {
  const manage = selectionEnabled();
  document.querySelectorAll('.card[data-id], .row[data-id]').forEach(el => {
    const id = el.dataset.id;
    if (!manage) {
      // dashboard (Home): single click opens, like before
      el.onclick = (e) => { if (e.target.closest('[data-more]')) return; openItem(id); };
      el.oncontextmenu = (e) => { e.preventDefault(); showCtx(e.clientX, e.clientY, id); };
      return;
    }
    // file-manager views: click selects, double-click opens (Explorer / Drive model)
    el.onclick = (e) => {
      if (e.target.closest('[data-more]')) return;
      if (e.target.closest('.selcb')) {                       // checkbox = additive toggle
        e.stopPropagation(); toggleSel(id); anchorId = cursorId = id; return;
      }
      if (e.shiftKey && anchorId) selectRange(anchorId, id);
      else if (e.metaKey || e.ctrlKey) { toggleSel(id); anchorId = cursorId = id; }
      else selectOnly(id);
    };
    el.ondblclick = (e) => { if (e.target.closest('[data-more], .selcb')) return; openItem(id); };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      if (!selection.has(id)) selectOnly(id);                 // right-click an unselected item selects just it
      showCtx(e.clientX, e.clientY, id);
    };
    // drag to move
    el.draggable = true;
    el.addEventListener('dragstart', (e) => onItemDragStart(e, id));
    el.addEventListener('dragend', onItemDragEnd);
    if (byId(id) && byId(id).type === 'folder') wireDropTarget(el, id);
  });
  document.querySelectorAll('[data-more]').forEach(b => b.onclick = (e) => {
    e.stopPropagation(); const r = b.getBoundingClientRect(); showCtx(r.right, r.bottom + 4, b.dataset.more, true);
  });
  const et = document.getElementById('emptyTrashBtn'); if (et) et.onclick = () => { emptyTrash(); selection.clear(); render(); toast('Trash emptied'); };
  const ssb = document.getElementById('searchScopeBtn'); if (ssb) ssb.onclick = () => setSearchScope(null);
  document.querySelectorAll('.list-head [data-sort]').forEach(s => s.onclick = () => setSort(s.dataset.sort));
  // AI Organization suggestion chips live inside item cards/rows; wire their
  // accept/dismiss/more buttons (they stopPropagation so they don't select the item).
  if (_uploadSuggestions.size) wireUploadSuggestionChips(document);
}
/* the file most recently opened in a viewer/editor — read by the remote assistant
   so it knows "you have <name> (<type>) open". Cleared by closeViewer(). */
let _currentOpenFile = null;
function openItem(id) {
  const f = byId(id); if (!f) return;
  if (state.view === 'trash') { toast('Restore to open this file'); return; }
  if (f.type !== 'folder') { _currentOpenFile = f; if (typeof trackEvent === 'function') trackEvent('file_view', { kind: f.type }); }   // Analytics app
  if (f.type === 'folder') {
    if (_looksLocked(f)) return void unlockItemForUse(f).then(pass => { if (pass != null) go('browse', { folder: id }); });
    return go('browse', { folder: id });
  }
  // give the open viewer a real URL (deep-linkable / refresh-safe / Back closes it).
  // Only when opened while browsing the Database — viewers opened from other apps
  // (e.g. an AI file preview) keep their own context. Mark that we pushed a history
  // entry so the viewer's close button knows history.back() will land in-app (vs. a
  // direct deep link with nothing to go back to).
  if (!_routing && currentApp === 'database') {
    try { history.pushState({ p: '/database/file/' + id, fileView: true }, '', '/database/file/' + id); _viewerPushedHistory = true; } catch (e) {}
  }
  if (f.type === 'video') return void openVideo(id).catch(e => toast(e && e.message ? e.message : 'Could not open file', 'close'));
  if (f.type === 'audio') return void openAudio(id).catch(e => toast(e && e.message ? e.message : 'Could not open file', 'close'));
  if (f.type === 'image') return void openImage(id).catch(e => toast(e && e.message ? e.message : 'Could not open file', 'close'));
  if (f.type === 'model3d') return void openModel3D(id).catch(e => toast(e && e.message ? e.message : 'Could not open file', 'close'));
  if (f.type === 'uasset') return void openUasset(id).catch(e => toast(e && e.message ? e.message : 'Could not open file', 'close'));
  if (f.type === 'document') return openEditor(id);
}
/* keep the assistant's "sees: …" chip in sync the moment a file opens */
const _raOrigOpenItem = openItem;
openItem = function (id) { const r = _raOrigOpenItem(id); if (typeof raUpdateCtxChip === 'function') raUpdateCtxChip(); return r; };
/* open a file by id from the router (/database/file/<id>). No-op if the id is gone
   (e.g. a stale shared link). The viewer's own URL push is suppressed under _routing. */
function openFileById(id) { if (byId(id)) openItem(id); }

/* ---------- SEARCH ----------
   File-Explorer style: searches the whole vault by name, but if `scope` is a
   folder id the results are limited to that folder's subtree (everything under
   it, at any depth). scope === null/undefined => the entire database. */
function searchItems(q, scope) {
  q = q.toLowerCase().trim(); if (!q) return [];
  const pool = (scope != null) ? descendants(scope) : DB.files;
  // tags whose name matches the query — an item also matches if it carries one
  const tagHits = new Set(allTags().filter(t => t.name.toLowerCase().includes(q)).map(t => t.id));
  return pool.filter(f => {
    if (f.trashed) return false;
    if (f.name.toLowerCase().includes(q)) return true;
    return tagHits.size && Array.isArray(f.tags) && f.tags.some(id => tagHits.has(id));
  });
}
/* Remember the view we entered search FROM, so clearing the box returns there
   instead of always bouncing to the Database home. */
let _searchReturn = null;
document.getElementById('search').addEventListener('input', e => {
  // Ignore input that isn't the user actually typing. Browser/password-manager
  // autofill (which used to treat this box as a username field) and programmatic
  // value changes fire 'input' too; reacting to those on load flipped the app into
  // "search" state and bounced deep links like /database/files back to /database.
  if (!e.isTrusted) return;
  // Never let a search event fight the URL router while it's mid-navigation.
  if (_routing) return;
  // Only meaningful inside the Database app — the box doesn't exist elsewhere.
  if (currentApp !== 'database') return;

  const q = e.target.value;
  const scope = (state.view === 'search') ? state.scope
    : (state.view === 'browse' && state.folder) ? state.folder
    : null;

  if (!q.trim()) {
    // Cleared the box: leave search only if we're actually IN it, and return to
    // where the search began (falling back to Database home) — no forced redirect
    // when we were never searching (which is what clobbered fresh deep links).
    if (state.view === 'search') {
      const back = _searchReturn; _searchReturn = null;
      if (back && back.view) go(back.view, back.opts || {}); else go('home');
    }
    return;
  }

  if (state.view !== 'search') _searchReturn = { view: state.view, opts: { folder: state.folder, sub: state.sub, tag: state.tag } };
  closeViewer();
  state = { view: 'search', folder: null, sub: null, query: q, scope: scope ?? null };
  render();
});
/* Human-readable location of an item's parent folder, for search results.
   e.g. "All files", "All files / Projects", "All files / Projects / 2026". */
function locationLabel(f) {
  if (!f || f.parent == null) return 'All files';
  const chain = pathOf(f.parent).map(p => p.name);
  return 'All files / ' + chain.join(' / ');
}
/* Toggle the current search between "this folder" and "everywhere". */
function setSearchScope(scope) {
  if (state.view !== 'search') return;
  state = { ...state, scope: scope ?? null };
  render();
}

/* ---------- CONTEXT MENU ---------- */
let ctxEl = null;
let ctxSubs = [];   // open fly-out submenu panels (e.g. "Convert to…"), torn down by hideCtx
let _lastCtxPt = { x: 0, y: 0 };   // where the menu opened, so follow-up popovers can anchor there
function showCtx(x, y, id, fromBtn) {
  _lastCtxPt = { x, y };
  hideCtx();
  const f = byId(id); if (!f) return;
  // operate on the whole selection when the clicked item is part of a multi-selection
  const ids = (selection.size > 1 && selection.has(id)) ? [...selection] : [id];
  const multi = ids.length > 1;
  const inTrash = f.trashed;
  const items = [];
  if (multi) items.push({ head: `${ids.length} selected` });

  if (SHARE.active) {
    // public read-only viewer: view + (optional) download + details, nothing mutating
    if (f.type !== 'folder') items.push({ ic: 'eye', label: 'Open', fn: () => openItem(id) });
    if (f.type !== 'folder' && SHARE.allowDownload) items.push({ ic: 'download', label: 'Download', fn: () => downloadFile(id) });
    items.push({ ic: 'info', label: 'Details', fn: () => showDetails(id) });
  } else if (!inTrash) {
    if (!multi && f.type !== 'folder') items.push({ ic: 'eye', label: 'Open', fn: () => openItem(id) });
    if (ids.some(i => byId(i) && byId(i).type !== 'folder')) items.push({ ic: 'download', label: 'Download', fn: () => bulkDownload(ids) });
    items.push({ div: true });
    items.push({ ic: 'cut', label: 'Cut', fn: () => cutItems(ids) });
    items.push({ ic: 'copy', label: 'Copy', fn: () => copyToClipboard(ids) });
    items.push({ ic: 'copy', label: multi ? 'Duplicate' : 'Duplicate', fn: () => duplicateItems(ids) });
    items.push({ ic: 'move', label: 'Move to...', fn: () => openMoveDialog(ids) });
    if (!multi) items.push({ ic: 'share', label: 'Share...', fn: () => openShareDialog(id) });
    // Pin a folder to the sidebar (Pins section). Single folders only.
    if (!multi && f.type === 'folder') {
      items.push(isPinned(id)
        ? { ic: 'pin', label: 'Unpin from sidebar', fn: () => unpinFolder(id) }
        : { ic: 'pin', label: 'Pin to sidebar', fn: () => pinFolder(id) });
    }
    // extract a .zip into a new folder
    if (!multi && f.type !== 'folder' && /\.zip$/i.test(f.name)) {
      items.push({ ic: 'folder', label: 'Extract here', fn: () => extractZipItem(id) });
    }
    // album cover / icon: available for any non-folder file (esp. audio)
    if (!multi && f.type !== 'folder') {
      items.push({ ic: 'image', label: f.coverUrl ? 'Change cover...' : 'Set cover...', fn: () => pickCover(id) });
      if (f.coverUrl) items.push({ ic: 'trash', label: 'Remove cover', fn: () => removeCover(id) });
    }
    // native "Convert to…": one sub-button per format this file can become.
    // Group the fly-out by kind (e.g. a video offers "Video" containers AND
    // "Audio" extraction) with a small header before each group.
    if (!multi && f.type !== 'folder') {
      const targets = conversionTargetsFor(f);
      if (targets.length) {
        const groups = [...new Set(targets.map(t => t.group))];
        const sub = [];
        groups.forEach((g, gi) => {
          if (groups.length > 1) sub.push({ head: g });
          targets.filter(t => t.group === g).forEach(t => sub.push({ ic: 'convert', label: t.format.toUpperCase(), fn: () => convertFileTo(f, t) }));
        });
        items.push({ ic: 'convert', label: 'Convert to...', sub });
      }
      // native "Compress…": shrink a video/audio to a target size/% (server ffmpeg),
      // saved as a new file beside the original.
      if (canCompress(f) && !_looksLocked(f)) {
        items.push({ ic: 'compress', label: 'Compress...', fn: () => openCompressDialog(f) });
      }
      // "View as heightmap…": render any image as displaced 3D terrain (server
      // decodes to a grayscale grid → three.js). Especially useful for the EXR/TIFF
      // height/displacement maps browsers can't open otherwise.
      if (f.type === 'image' && !_looksLocked(f) && !f.locked && typeof openHeightmap === 'function') {
        items.push({ ic: 'model3d', label: 'View as heightmap...', fn: () => void openHeightmap(id) });
      }
    }
    // UE4 save files (.sav/.save): open the GVAS property editor
    if (!multi && f.type !== 'folder' && /\.(sav|save)$/i.test(f.name) && !_looksLocked(f) && !f.locked) {
      items.push({ ic: 'code', label: 'Edit Save...', fn: () => showSaveEditor(id) });
    }
    if (!multi) {
      if (_looksLocked(f)) {
        // Unlock = open temporarily (until sign-out); Decrypt = remove encryption for good.
        items.push({ ic: 'lock', label: 'Unlock...', fn: () => unlockItemForUse(f) });
        items.push({ ic: 'lock', label: 'Decrypt...', fn: () => decryptItem(id) });
      } else if (f.locked) {
        // already unlocked this session — still offer permanent decrypt
        items.push({ ic: 'lock', label: 'Decrypt...', fn: () => decryptItem(id) });
      } else {
        items.push({ ic: 'lock', label: 'Encrypt...', fn: () => encryptItem(id) });
      }
    }
    // Legacy (old-key) rows: one-click upgrade to the account's own key
    if (!multi && isLegacyFile(f)) {
      items.push({ ic: 'key', label: 'Re-encrypt...', fn: () => legacyModal(f, 'edit') });
    }
    items.push({ div: true });
    const anyUnstarred = ids.some(i => byId(i) && !byId(i).starred);
    items.push({ ic: 'star', label: anyUnstarred ? 'Star' : 'Unstar', fn: () => setStarBulk(ids, anyUnstarred) });
    items.push({ ic: 'tag', label: 'Tags...', fn: () => openTagPicker(ids) });
    // AI Organization: stored folder/tag suggestions for this file (hidden after an
    // hour, but always reachable here). Offered for real, unlocked, non-folder files;
    // the modal handles the "off / nothing to suggest" cases gracefully.
    if (!multi && f.type !== 'folder' && !_looksLocked(f) && !f.locked && !SHARE.active) {
      items.push({ ic: 'brain', label: 'AI Store...', fn: () => openAiStore(id) });
    }
    // Dismiss the AI recommendation notice(s) on the selected file(s) — only shown
    // when at least one selected item actually has a live notice.
    if (!SHARE.active) {
      const withNotes = ids.filter(i => _uploadSuggestions.has(i));
      if (withNotes.length) {
        items.push({ ic: 'close', label: withNotes.length > 1 ? `Dismiss ${withNotes.length} notifications` : 'Dismiss notification', fn: () => dismissUploadSuggestions(withNotes) });
      }
    }
    if (!multi) items.push({ ic: 'rename', label: 'Rename', fn: () => renameModal(id) });
    if (!multi) items.push({ ic: 'info', label: 'Details', fn: () => showDetails(id) });
    items.push({ div: true });
    items.push({ ic: 'trash', label: multi ? `Move ${ids.length} to trash` : 'Move to trash', danger: true, fn: () => bulkTrash(ids) });
  } else {
    items.push({ ic: 'restore', label: multi ? `Restore ${ids.length}` : 'Restore', fn: () => bulkRestore(ids) });
    items.push({ ic: 'trash', label: 'Delete forever', danger: true, fn: () => bulkDeleteForever(ids) });
  }

  ctxEl = buildCtxPanel(items);
  document.body.appendChild(ctxEl);
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.min(x, innerWidth - r.width - 10) + 'px';
  ctxEl.style.top = Math.min(y, innerHeight - r.height - 10) + 'px';
}

/* Build a .ctx panel from an items list. Items may be { head }, { div },
   { sub: [...] } (a fly-out submenu), or a plain action { ic, label, fn }.
   Submenus are themselves .ctx panels, opened on hover/click to the side and
   tracked in ctxSubs so hideCtx() can tear the whole stack down. */
function buildCtxPanel(items) {
  const panel = document.createElement('div'); panel.className = 'ctx';
  panel.innerHTML = items.map((it, i) => it.head ? `<div class="ctxhead">${esc(it.head)}</div>`
    : it.div ? '<div class="div"></div>'
    : `<button data-ci="${i}" class="${it.danger ? 'danger' : ''}${it.sub ? ' has-sub' : ''}">${svg(it.ic, 15)} <span class="ctx-lbl">${esc(it.label)}</span>${it.sub ? `<span class="ctx-arrow">${svg('chevron-right', 13)}</span>` : ''}</button>`).join('');
  panel.querySelectorAll('[data-ci]').forEach(b => {
    const it = items[b.dataset.ci];
    if (it.sub) {
      const open = () => openCtxSub(b, it.sub);
      b.onclick = (e) => { e.stopPropagation(); open(); };
      b.onmouseenter = open;
    } else {
      b.onclick = () => { hideCtx(); it.fn(); };
      // hovering a plain row in the ROOT panel dismisses any open fly-out; rows
      // inside a fly-out leave it be (the panel itself carries .ctx-sub).
      b.onmouseenter = () => { if (!panel.classList.contains('ctx-sub')) closeCtxSubs(); };
    }
  });
  return panel;
}

/* open (or re-open) a submenu next to its parent button, closing any sibling
   submenu first so only one fly-out is visible at a time. */
function openCtxSub(btn, subItems) {
  // close existing submenus that aren't ancestors of this button
  closeCtxSubs();
  const sub = buildCtxPanel(subItems);
  sub.classList.add('ctx-sub');
  document.body.appendChild(sub);
  ctxSubs.push(sub);
  const br = btn.getBoundingClientRect(), sr = sub.getBoundingClientRect();
  let left = br.right - 4;
  if (left + sr.width > innerWidth - 6) left = br.left - sr.width + 4;   // flip to the left edge if it would overflow
  let top = br.top - 5;
  if (top + sr.height > innerHeight - 6) top = Math.max(6, innerHeight - sr.height - 6);
  sub.style.left = Math.max(6, left) + 'px';
  sub.style.top = top + 'px';
}
function closeCtxSubs() { while (ctxSubs.length) { const s = ctxSubs.pop(); try { s.remove(); } catch (e) {} } }
function hideCtx() { closeCtxSubs(); if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
window.addEventListener('click', e => { if (ctxEl && !e.target.closest('.ctx')) hideCtx(); });
// Delegated action hooks for buttons rendered as HTML strings (the CSP forbids
// inline on*= handlers). data-act="upload" → open the file picker (empty-state).
window.addEventListener('click', e => {
  const act = e.target.closest('[data-act]');
  if (act && act.dataset.act === 'upload') document.getElementById('uploader').click();
});
window.addEventListener('scroll', hideCtx, true);

/* Right-click on the empty area of a view (not on an item) -> location actions:
   New folder / Upload / Paste / Select all, tailored to the current view. */
function showBgCtx(x, y) {
  hideCtx();
  if (SHARE.active) return;                 // public read-only viewer: no actions
  const items = [];
  if (state.view === 'trash') {
    if (!trashed().length) return;
    items.push({ ic: 'trash', label: 'Empty trash', danger: true, fn: () => { emptyTrash(); selection.clear(); render(); toast('Trash emptied'); } });
  } else {
    // creation only makes sense where a real location exists (a folder or All files)
    const canCreate = state.view === 'browse' || state.view === 'cat' || state.view === 'starred';
    if (canCreate) {
      items.push({ ic: 'folder', label: 'New folder', fn: () => newFolderModal() });
      items.push({ ic: 'download', label: 'Upload files', fn: () => document.getElementById('uploader').click() });
      items.push({ ic: 'folder', label: 'Upload folder', fn: () => document.getElementById('folderUploader').click() });
    }
    // Paste lands in the open folder; only meaningful while browsing
    if (clipboard && state.view === 'browse') {
      if (items.length) items.push({ div: true });
      items.push({ ic: 'paste', label: `Paste${clipboard.ids.length > 1 ? ' ' + clipboard.ids.length + ' items' : ''}`, fn: () => pasteClipboard() });
    }
    if (selectionEnabled() && displayedItems().length) {
      if (items.length) items.push({ div: true });
      items.push({ ic: 'check', label: 'Select all', fn: () => selectAll() });
    }
  }
  if (!items.length) return;                 // nothing to offer here

  ctxEl = document.createElement('div'); ctxEl.className = 'ctx';
  ctxEl.innerHTML = items.map((it, i) => it.div ? '<div class="div"></div>'
    : `<button data-ci="${i}" class="${it.danger ? 'danger' : ''}">${svg(it.ic, 15)} ${esc(it.label)}</button>`).join('');
  document.body.appendChild(ctxEl);
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.min(x, innerWidth - r.width - 10) + 'px';
  ctxEl.style.top = Math.min(y, innerHeight - r.height - 10) + 'px';
  ctxEl.querySelectorAll('[data-ci]').forEach(b => b.onclick = () => { hideCtx(); items[b.dataset.ci].fn(); });
}

/* ============================================================
   SELECTION ENGINE — multi-select, marquee, drag-move, clipboard,
   bulk actions, keyboard shortcuts (the file-manager layer)
   ============================================================ */

/* ---------- selection primitives ---------- */
function refreshSelectionUI() {
  document.querySelectorAll('.card[data-id], .row[data-id]').forEach(el => {
    const id = el.dataset.id;
    el.classList.toggle('sel', selection.has(id));
    el.classList.toggle('cut', !!(clipboard && clipboard.mode === 'cut' && clipboard.ids.includes(id)));
  });
  renderSelectionBar();
}
function toggleSel(id) { selection.has(id) ? selection.delete(id) : selection.add(id); refreshSelectionUI(); }
function selectOnly(id) { selection = new Set([id]); anchorId = cursorId = id; refreshSelectionUI(); }
function selectRange(fromId, toId) {
  const ids = displayedItems().map(f => f.id);
  const a = ids.indexOf(fromId), b = ids.indexOf(toId);
  if (a < 0 || b < 0) return selectOnly(toId);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  selection = new Set(ids.slice(lo, hi + 1));
  cursorId = toId; refreshSelectionUI();
}
function selectAll() {
  if (!selectionEnabled()) return;
  const ids = displayedItems().map(f => f.id);
  selection = new Set(ids);
  anchorId = ids[0] || null; cursorId = ids[ids.length - 1] || null;
  refreshSelectionUI();
}
function clearSelection() { if (selection.size) { selection.clear(); anchorId = cursorId = null; refreshSelectionUI(); } }

/* ---------- selection action bar ---------- */
function renderSelectionBar() {
  let bar = document.getElementById('selbar');
  if (!selectionEnabled() || selection.size === 0) { if (bar) bar.classList.remove('show'); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'selbar'; document.querySelector('.main').appendChild(bar); }
  const ids = [...selection];
  const btn = (act, ic, label) => `<button data-act="${act}" title="${esc(label)}">${svg(ic, 16)}<span>${esc(label)}</span></button>`;
  let actions;
  if (state.view === 'trash') {
    actions = btn('restore', 'restore', 'Restore') + btn('delete', 'trash', 'Delete forever');
  } else {
    const anyUnstarred = ids.some(i => byId(i) && !byId(i).starred);
    actions = btn('move', 'move', 'Move to…')
      + btn('star', 'star', anyUnstarred ? 'Star' : 'Unstar')
      + (ids.some(i => byId(i) && byId(i).type !== 'folder') ? btn('download', 'download', 'Download') : '')
      + btn('trash', 'trash', 'Trash');
  }
  bar.innerHTML = `<button class="selbar-x" data-act="clear" title="Clear selection (Esc)">${svg('close', 16)}</button>
    <span class="selbar-n">${ids.length} selected</span><span class="selbar-sp"></span>${actions}`;
  bar.classList.add('show');
  bar.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
    const a = b.dataset.act, cur = [...selection];
    if (a === 'clear') clearSelection();
    else if (a === 'move') openMoveDialog(cur);
    else if (a === 'star') setStarBulk(cur, cur.some(i => byId(i) && !byId(i).starred));
    else if (a === 'download') bulkDownload(cur);
    else if (a === 'trash') bulkTrash(cur);
    else if (a === 'restore') bulkRestore(cur);
    else if (a === 'delete') bulkDeleteForever(cur);
  });
}

/* ---------- content surface: marquee + click-empty-to-clear ---------- */
function wireContentSurface() {
  const content = document.getElementById('content');
  content.onmousedown = (e) => {
    if (!selectionEnabled() || e.button !== 0) return;
    if (e.target.closest('.card, .row, .selcb, .list-head, .section-head, button, a, input, textarea, #selbar')) return;
    startMarquee(e);
  };
  // right-click on empty space -> our location actions instead of the browser menu.
  // (items have their own oncontextmenu in wireItems; we only handle the gaps here.)
  content.oncontextmenu = (e) => {
    if (e.target.closest('.card, .row, button, a, input, textarea, #selbar')) return;
    e.preventDefault();
    showBgCtx(e.clientX, e.clientY);
  };
}
function startMarquee(e) {
  const sx = e.clientX, sy = e.clientY;
  const additive = e.ctrlKey || e.metaKey || e.shiftKey;
  const base = additive ? new Set(selection) : new Set();
  const els = [...document.querySelectorAll('.card[data-id], .row[data-id]')];
  let box = null, moved = false;
  const onMove = (ev) => {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    if (!moved) { moved = true; box = document.createElement('div'); box.className = 'marquee'; document.body.appendChild(box); document.body.classList.add('marquee-active'); }
    const x = Math.min(sx, ev.clientX), y = Math.min(sy, ev.clientY), w = Math.abs(dx), h = Math.abs(dy);
    box.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
    const r = { left: x, top: y, right: x + w, bottom: y + h };
    const next = new Set(base);
    for (const el of els) {
      const b = el.getBoundingClientRect();
      if (b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top) next.add(el.dataset.id);
    }
    selection = next; refreshSelectionUI();
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
    document.body.classList.remove('marquee-active');
    if (box) box.remove();
    if (!moved && !additive) clearSelection();
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

/* ---------- drag to move ---------- */
function onItemDragStart(e, id) {
  if (!selection.has(id)) selectOnly(id);
  dragIds = [...selection];
  internalDrag = true;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', dragIds.join(',')); } catch (_) {}
  const ghost = document.createElement('div'); ghost.className = 'drag-ghost';
  ghost.innerHTML = `${svg(dragIds.length > 1 ? 'files' : byId(id).type, 15)}<span>${dragIds.length > 1 ? dragIds.length + ' items' : esc(byId(id).name)}</span>`;
  document.body.appendChild(ghost);
  try { e.dataTransfer.setDragImage(ghost, 14, 14); } catch (_) {}
  setTimeout(() => ghost.remove(), 0);
}
function onItemDragEnd() {
  internalDrag = false; dragIds = null;
  document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
}
/* make `el` a destination that reparents dragged items to `destId` (null = root) */
function wireDropTarget(el, destId) {
  el.addEventListener('dragover', (e) => {
    if (!dragIds) return;
    if (destId !== null && dragIds.includes(destId)) return;   // never drop onto a dragged item
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    if (!dragIds) return;
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('drop-target');
    doMove(dragIds, destId);
  });
}
function doMove(ids, dest) {
  const moved = moveFiles(ids, dest);
  clearSelection(); render();
  const where = dest == null ? 'All files' : (byId(dest) ? byId(dest).name : 'folder');
  toast(moved.length ? `Moved ${moved.length} item${moved.length !== 1 ? 's' : ''} to ${where}` : 'Already there', moved.length ? 'move' : 'close');
}

/* ---------- "Move to…" folder picker ---------- */
function folderTree(excludeIds) {
  const exclude = new Set(excludeIds);
  excludeIds.forEach(id => { if (byId(id) && byId(id).type === 'folder') descendants(id).forEach(d => exclude.add(d.id)); });
  const out = [{ id: null, name: 'All files', depth: 0 }];
  const walk = (pid, depth) => {
    children(pid).filter(f => f.type === 'folder' && !exclude.has(f.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(f => { out.push({ id: f.id, name: f.name, depth }); walk(f.id, depth + 1); });
  };
  walk(null, 1);
  return out;
}
function openMoveDialog(ids) {
  hideCtx();
  const tree = folderTree(ids);
  let dest = state.view === 'browse' ? (state.folder ?? null) : null;
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal move-modal">
    <h3>Move ${ids.length} item${ids.length !== 1 ? 's' : ''}</h3>
    <p>Pick a destination folder.</p>
    <div class="tree" id="moveTree">${tree.map(t => `
      <button class="tree-item ${t.id === dest ? 'on' : ''}" data-id="${t.id == null ? '' : t.id}" style="padding-left:${10 + t.depth * 17}px">
        <span class="t-folder">${svg(t.id == null ? 'hdd' : 'folder', 15)}</span><span class="tn">${esc(t.name)}</span>
      </button>`).join('')}</div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Move here</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  const treeEl = bg.querySelector('#moveTree');
  treeEl.querySelectorAll('.tree-item').forEach(b => b.onclick = () => {
    dest = b.dataset.id === '' ? null : b.dataset.id;
    treeEl.querySelectorAll('.tree-item').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
  });
  bg.querySelector('[data-cancel]').onclick = close;
  bg.querySelector('[data-ok]').onclick = () => { close(); doMove(ids, dest); };
  bg.onclick = e => { if (e.target === bg) close(); };
}

/* ---------- clipboard: cut / copy / paste / duplicate ---------- */
function cutItems(ids) { clipboard = { mode: 'cut', ids: [...ids] }; refreshSelectionUI(); toast(`Cut ${ids.length} item${ids.length !== 1 ? 's' : ''}`, 'cut'); }
function copyToClipboard(ids) { clipboard = { mode: 'copy', ids: [...ids] }; refreshSelectionUI(); toast(`Copied ${ids.length} item${ids.length !== 1 ? 's' : ''}`, 'copy'); }
async function pasteClipboard() {
  if (!clipboard) return;
  if (state.view !== 'browse') { toast('Open a folder to paste here', 'close'); return; }
  const dest = state.folder ?? null;
  if (clipboard.mode === 'cut') {
    const moved = moveFiles(clipboard.ids, dest);
    clipboard = null; clearSelection(); render();
    toast(moved.length ? `Moved ${moved.length} item${moved.length !== 1 ? 's' : ''} here` : 'Already here', moved.length ? 'move' : 'close');
  } else {
    try {
      const created = await copyItems(clipboard.ids, dest);   // copy keeps clipboard so you can paste again
      clearSelection(); render();
      toast(`Pasted ${created.length} item${created.length !== 1 ? 's' : ''}`, 'paste');
    } catch (err) { pasteError(err); }
  }
}
async function duplicateItems(ids) {
  try {
    const created = await copyItems(ids);   // no parent => same folder as each source
    render();
    toast(`Duplicated ${ids.length} item${ids.length !== 1 ? 's' : ''}`, 'copy');
  } catch (err) { pasteError(err); }
}
function pasteError(err) {
  if (err && err.code === 'LIMIT') toast(`Storage limit reached — ${Math.round(TOTAL_BYTES / 1e9)} GB max.`, 'close');
  else toast('Copy failed', 'close');
}

/* ---------- bulk actions ---------- */
function bulkDownload(ids) {
  const files = ids.map(byId).filter(f => f && f.type !== 'folder');
  if (!files.length) { toast('Folders can’t be downloaded directly', 'close'); return; }
  files.forEach((f, i) => setTimeout(() => downloadFile(f.id), i * 350));   // stagger so the browser allows them
  if (files.length > 1) toast(`Downloading ${files.length} files`, 'download');
}
function setStarBulk(ids, val) { ids.forEach(i => setStar(i, val)); render(); toast(val ? `Starred ${ids.length}` : `Unstarred ${ids.length}`, 'star'); }
function bulkTrash(ids) { ids.forEach(i => trashFile(i)); clearSelection(); render(); toast(`Moved ${ids.length} item${ids.length !== 1 ? 's' : ''} to trash`, 'trash'); }
function bulkRestore(ids) { ids.forEach(i => restoreFile(i)); clearSelection(); render(); toast(`Restored ${ids.length} item${ids.length !== 1 ? 's' : ''}`, 'restore'); }
function bulkDeleteForever(ids) {
  const n = ids.length;
  confirmModal(`Delete ${n} item${n !== 1 ? 's' : ''} forever?`, 'This permanently removes them from the vault and can’t be undone.', () => {
    ids.forEach(i => deleteForever(i)); clearSelection(); render(); toast(`Deleted ${n} item${n !== 1 ? 's' : ''}`, 'trash');
  });
}

/* ---------- details / properties ---------- */
function showDetails(id) {
  const f = byId(id); if (!f) return;
  const rows = [['Name', f.name], ['Kind', f.type === 'folder' ? 'Folder' : (fileExt(f.name) || f.type)]];
  if (f.type === 'folder') {
    const kids = descendants(id);
    const nf = kids.filter(k => k.type !== 'folder').length, nd = kids.filter(k => k.type === 'folder').length;
    rows.push(['Contents', `${nf} file${nf !== 1 ? 's' : ''}, ${nd} folder${nd !== 1 ? 's' : ''}`]);
    rows.push(['Size', fmtSize(kids.filter(k => k.type !== 'folder').reduce((s, k) => s + (k.size || 0), 0))]);
  } else rows.push(['Size', fmtSize(f.size)]);
  if (f.w && f.h) rows.push(['Dimensions', `${f.w} × ${f.h}`]);
  if (f.dur) rows.push(['Duration', fmtDur(f.dur)]);
  if (f.artist) rows.push(['Artist', f.artist]);
  if (f.album) rows.push(['Album', f.album]);
  rows.push(['Location', pathOf(id).slice(0, -1).map(p => p.name).join(' / ') || 'All files']);
  rows.push(['Modified', new Date(f.date).toLocaleString()]);
  if (f.starred) rows.push(['Starred', 'Yes']);
  // "Edit Metadata" is offered for real, unlocked, non-folder file blobs — it reads
  // the EXIF/ID3/container tags baked into the bytes (server-side ffprobe) and can
  // purge them. Content-backed docs (no blob) and locked items don't qualify.
  const canMeta = !SHARE.active && f.type !== 'folder' && !!f.url && !_looksLocked(f) && !f.locked;
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal details-modal">
    <div class="details-head"><span class="ti bg-${f.type} t-${f.type}">${svg(f.type, 18, 1.7)}</span><h3>${esc(f.name)}</h3></div>
    <div class="details-list">${rows.map(([k, v]) => `<div class="drow"><span class="dk">${esc(k)}</span><span class="dv">${esc(String(v))}</span></div>`).join('')}</div>
    <div class="acts">${canMeta ? `<button class="btn ghost" data-meta>${svg('info', 14)} Edit Metadata</button>` : ''}<button class="btn primary" data-ok>Close</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-ok]').onclick = close;
  const metaBtn = bg.querySelector('[data-meta]');
  if (metaBtn) metaBtn.onclick = () => { close(); showMetadataEditor(id); };
  bg.onclick = e => { if (e.target === bg) close(); };
}

/* ---------- ADVANCED METADATA EDITOR ----------
   Reads the metadata embedded in a file's bytes (EXIF/ID3/container & stream
   tags) and offers a one-click Purge that strips the non-essential ones. The
   heavy lifting is server-side (ffprobe to read, ffmpeg -map_metadata -1 to
   strip); this is purely the viewer + the Purge button. */
function showMetadataEditor(id) {
  const f = byId(id); if (!f) return;
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal meta-modal">
    <div class="details-head"><span class="ti bg-${f.type} t-${f.type}">${svg(f.type, 18, 1.7)}</span>
      <div class="meta-titles"><h3>${esc(f.name)}</h3><span class="meta-sub mono">Embedded metadata</span></div></div>
    <div class="meta-body" id="metaBody"><div class="meta-loading mono"><span class="spin"></span> Reading metadata…</div></div>
    <div class="acts">
      <button class="btn danger" id="metaPurge" disabled>${svg('trash', 14)} Purge metadata</button>
      <span class="spacer"></span>
      <button class="btn primary" data-ok>Close</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-ok]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  const body = bg.querySelector('#metaBody'), purgeBtn = bg.querySelector('#metaPurge');

  // render the grouped tag list returned by the server into the body
  const renderGroups = (data) => {
    const groups = (data && data.groups) || [];
    const total = data ? data.total : 0;
    if (!total) {
      body.innerHTML = `<div class="meta-empty"><span class="meta-ok">${svg('check', 18)}</span><div><div class="meta-empty-big">No embedded metadata</div><div class="mono dim">This file carries no non-essential tags — nothing to purge.</div></div></div>`;
      purgeBtn.disabled = true;
      return;
    }
    body.innerHTML = `<div class="meta-count mono">${total} tag${total === 1 ? '' : 's'} found across ${groups.length} section${groups.length === 1 ? '' : 's'}. Purging keeps the file playable but removes things like GPS location, camera model, author, software and timestamps.</div>` +
      groups.map(g => `<div class="meta-group">
        <div class="meta-glabel eyebrow">${esc(g.label)} <span class="meta-gn mono">${g.count}</span></div>
        <div class="meta-rows">${Object.entries(g.tags).map(([k, v]) => `<div class="meta-row"><span class="meta-k mono">${esc(k)}</span><span class="meta-v">${esc(String(v))}</span></div>`).join('')}</div>
      </div>`).join('');
    purgeBtn.disabled = false;
  };

  const load = async () => {
    try { renderGroups(await fileMetadata(id)); }
    catch (e) {
      body.innerHTML = `<div class="tool-err mono">${svg('close', 14)} ${esc(e.message || 'Could not read metadata')}</div>`;
      purgeBtn.disabled = true;
    }
  };

  purgeBtn.onclick = () => confirmModal('Purge metadata?',
    `This permanently strips embedded metadata (EXIF, tags, encoder info) from “${f.name}”. The file stays usable, but this can’t be undone.`,
    async () => {
      purgeBtn.disabled = true;
      const prev = purgeBtn.innerHTML; purgeBtn.innerHTML = `<span class="spin"></span> Purging…`;
      try {
        const data = await purgeMetadata(id);
        purgeBtn.innerHTML = prev;
        renderGroups(data);
        toast('Metadata purged', 'check');
        try { render(); } catch (e) {}
      } catch (e) {
        purgeBtn.innerHTML = prev; purgeBtn.disabled = false;
        toast(e && e.message ? e.message : 'Purge failed', 'close');
      }
    }, 'Purge');

  load();
}

/* ---------- UE4 SAVE EDITOR (.sav / .save) ----------
   Reads a GVAS save from the vault, flattens it to editable scalar leaves, and
   lets the user change values with type-appropriate inputs, then writes the bytes
   back (overwrite or save-as). Parsing/serialization live in gvas.js and are
   verified to round-trip byte-for-byte. Big nested saves can have hundreds of
   fields, so the list is searchable and grouped by path. */
async function showSaveEditor(id) {
  const f = byId(id); if (!f) return;
  // gvas.js is loaded on demand (not at boot). Fetch it the first time the editor opens.
  if (typeof GVAS === 'undefined') {
    try { await loadFeature('gvas'); } catch (e) { toast('Save editor failed to load', 'close'); return; }
  }
  if (typeof GVAS === 'undefined') { toast('Save editor failed to load', 'close'); return; }
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal save-modal">
    <div class="details-head"><span class="ti bg-document t-document">${svg('code', 18, 1.7)}</span>
      <div class="meta-titles"><h3>${esc(f.name)}</h3><span class="meta-sub mono">UE4 save editor</span></div></div>
    <input type="text" class="picker-search" id="svSearch" placeholder="Search fields…" autocomplete="off" style="display:none">
    <div class="save-body" id="svBody"><div class="meta-loading mono"><span class="spin"></span> Reading save…</div></div>
    <div class="acts">
      <span class="save-status mono" id="svStatus"></span>
      <span class="spacer"></span>
      <button class="btn ghost" id="svSaveAs" disabled>Save as new…</button>
      <button class="btn primary" id="svSave" disabled>${svg('save', 14)} Save</button>
      <button class="btn ghost" data-ok>Close</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-ok]').onclick = () => { if (!dirty || confirmDiscard()) close(); };
  bg.onclick = e => { if (e.target === bg && (!dirty || confirmDiscard())) close(); };
  const body = bg.querySelector('#svBody'), search = bg.querySelector('#svSearch');
  const saveBtn = bg.querySelector('#svSave'), saveAsBtn = bg.querySelector('#svSaveAs'), statusEl = bg.querySelector('#svStatus');

  let save = null, leaves = [], dirty = 0;
  const confirmDiscard = () => true;   // edits live only in memory until Save; closing simply drops them

  const markDirty = () => { dirty++; saveBtn.disabled = false; saveAsBtn.disabled = false; statusEl.textContent = dirty + ' change' + (dirty === 1 ? '' : 's'); statusEl.className = 'save-status mono'; };

  // group leaves by their parent path so the list reads as labelled sections
  const groupOf = (l) => l.path.length > 1 ? l.path.slice(0, -1).join(' / ') : '(top level)';
  const rowHTML = (l, i) => {
    const val = l.get();
    let input;
    if (l.kind === 'bool') input = `<label class="sv-toggle"><input type="checkbox" data-li="${i}" ${val ? 'checked' : ''}><span class="sv-tk"></span></label>`;
    else if (l.kind === 'int') input = `<input type="number" step="1" class="sv-input" data-li="${i}" value="${esc(String(val))}">`;
    else if (l.kind === 'float') input = `<input type="number" step="any" class="sv-input" data-li="${i}" value="${esc(String(val))}">`;
    else input = `<input type="text" class="sv-input wide" data-li="${i}" value="${esc(String(val))}">`;
    return `<div class="sv-row"><span class="sv-k mono" title="${esc(l.path.join(' / '))}">${esc(l.label)}</span>${input}</div>`;
  };
  const rerender = (q) => {
    const ql = (q || '').toLowerCase();
    const shown = ql ? leaves.filter(l => l.path.join(' / ').toLowerCase().includes(ql)) : leaves;
    if (!shown.length) { body.innerHTML = `<div class="picker-empty dim mono">No fields match “${esc(q)}”.</div>`; return; }
    // bucket by group, preserving first-seen order; data-li indexes into `shown`
    const order = []; const gmap = new Map();
    shown.forEach((l, i) => { const g = groupOf(l); if (!gmap.has(g)) { gmap.set(g, []); order.push(g); } gmap.get(g).push([l, i]); });
    body.innerHTML = order.map(g => `<div class="sv-group">
        <div class="sv-glabel eyebrow">${esc(g)}</div>
        <div class="sv-rows">${gmap.get(g).map(([l, i]) => rowHTML(l, i)).join('')}</div>
      </div>`).join('');
    body.querySelectorAll('[data-li]').forEach(el => {
      const l = shown[+el.dataset.li];
      if (l.kind === 'bool') el.onchange = () => { l.set(el.checked); markDirty(); };
      else el.onchange = el.oninput = () => { l.set(el.value); markDirty(); };
    });
  };
  search.oninput = () => rerender(search.value.trim());

  const doSave = async (mode) => {
    saveBtn.disabled = saveAsBtn.disabled = true;
    statusEl.textContent = 'Saving…'; statusEl.className = 'save-status mono';
    try {
      const bytes = GVAS.serialize(save);
      if (mode === 'as') {
        const base = f.name.replace(/\.(sav|save)$/i, '');
        const ext = (fileExt(f.name) || 'sav').toLowerCase();
        const name = await mvePromptModal({ title: 'Save as new file', label: 'File name', value: uniqueNameIn(f.parent ?? null, base + '-edited.' + ext), okLabel: 'Save' });
        if (!name) { statusEl.textContent = ''; saveBtn.disabled = saveAsBtn.disabled = false; return; }
        await uploadFile(new File([bytes], name, { type: 'application/octet-stream' }), f.parent ?? null, { type: 'document' });
        toast('Saved ' + name, 'check'); dirty = 0;
        statusEl.textContent = 'Saved as new file'; statusEl.className = 'save-status mono ok';
      } else {
        await replaceFileBytes(id, bytes, f.name);
        toast('Save updated', 'check'); dirty = 0;
        statusEl.textContent = 'Saved'; statusEl.className = 'save-status mono ok';
      }
      try { render(); } catch (e) {}
    } catch (e) {
      statusEl.textContent = (e && e.message) || 'Save failed'; statusEl.className = 'save-status mono err';
      saveBtn.disabled = saveAsBtn.disabled = false;
    }
  };
  saveBtn.onclick = () => confirmModal('Overwrite this save?', `This writes your changes back over “${f.name}” in the vault. Consider “Save as new…” to keep the original. Continue?`, () => doSave('over'), 'Overwrite');
  saveAsBtn.onclick = () => doSave('as');

  (async () => {
    try {
      const file = await vaultFileToFile(f);
      const buf = new Uint8Array(await file.arrayBuffer());
      save = GVAS.parse(buf);
      leaves = GVAS.flatten(save);
      if (!leaves.length) { body.innerHTML = `<div class="picker-empty dim mono">This save has no editable fields.</div>`; return; }
      search.style.display = '';
      rerender('');
    } catch (e) {
      if (e && e.message === 'cancelled') { close(); return; }
      body.innerHTML = `<div class="tool-err mono">${svg('close', 14)} ${esc((e && e.message) || 'Could not read this save file')}</div>`;
    }
  })();
}

/* yes/no confirmation modal (destructive actions) */
function confirmModal(title, desc, onYes, okLabel = 'Delete') {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><p>${esc(desc)}</p>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn danger" data-ok>${esc(okLabel)}</button></div></div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  bg.querySelector('[data-ok]').onclick = () => { close(); onYes(); };
  bg.onclick = e => { if (e.target === bg) close(); };
}

/* ---------- upload failure report ("Uh oh!") ----------
   An upload that dies mid-flight used to leave a toast that scrolled away, so the
   only report we ever got was second-hand ("it's nowhere to be seen"). This shows
   what actually broke and offers to send the client+server trace as a bug report,
   which matters most on mobile where there's no console to copy from. */
function uploadErrorModal(file, err) {
  const log = err && err.uploadLog;
  const code = (err && err.code) || 'UNKNOWN';
  const cause = uploadCauseText(code, err && err.message);
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal upload-err-modal"><h3>Uh oh! That upload didn’t save</h3>
    <p class="ue-cause"><b class="ue-file">${esc(file && file.name || 'Your file')}</b> — ${esc(cause)}</p>
    <p class="dim">Nothing was saved to your vault, so you can safely try again.${log ? ' Sending a report helps us fix the cause.' : ''}</p>
    ${log ? `<input id="uNote" placeholder="What were you doing? (optional)" />` : ''}
    <div class="acts"><button class="btn ghost" data-cancel>Close</button>${log ? `<button class="btn primary" data-send>Send bug report</button>` : ''}</div></div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  const send = bg.querySelector('[data-send]');
  if (send) send.onclick = async () => {
    send.disabled = true; send.textContent = 'Sending…';
    const note = (bg.querySelector('#uNote') || {}).value || '';
    const id = await sendUploadReport(log, code, err && err.message, note);
    close();
    toast(id ? 'Bug report sent — thank you! (' + id + ')' : 'Could not send the report', id ? 'check' : 'close');
  };
}

/* ---------- keyboard navigation ---------- */
function gridColumns() {
  const g = document.querySelector('.grid'); if (!g) return 1;
  return Math.max(1, getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length);
}
function arrowNav(key, extend) {
  const ids = displayedItems().map(f => f.id); if (!ids.length) return;
  const cols = viewMode === 'grid' ? gridColumns() : 1;
  let cur = cursorId && ids.includes(cursorId) ? ids.indexOf(cursorId) : -1;
  let next = cur < 0 ? 0
    : key === 'ArrowRight' ? Math.min(ids.length - 1, cur + 1)
    : key === 'ArrowLeft' ? Math.max(0, cur - 1)
    : key === 'ArrowDown' ? Math.min(ids.length - 1, cur + cols)
    : Math.max(0, cur - cols);
  const nid = ids[next];
  if (extend) { if (!anchorId) anchorId = cursorId || nid; selectRange(anchorId, nid); }
  else selectOnly(nid);
  cursorId = nid;
  const el = document.querySelector(`[data-id="${nid}"]`); if (el) el.scrollIntoView({ block: 'nearest' });
}

window.addEventListener('keydown', (e) => {
  if (!document.getElementById('lock').classList.contains('hidden')) return;   // locked
  if (activeViewer) return;                                                     // a viewer owns the keys
  const openModal = document.querySelector('.modal-bg');
  if (openModal) { if (e.key === 'Escape') openModal.remove(); return; }        // Esc closes the topmost dialog
  const tag = document.activeElement && document.activeElement.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA';
  const mod = e.metaKey || e.ctrlKey;

  if (mod && !e.shiftKey && (e.key === 'a' || e.key === 'A')) { if (!typing && selectionEnabled()) { e.preventDefault(); selectAll(); } return; }
  if (mod && (e.key === 'x' || e.key === 'X')) { if (!typing && selection.size) { e.preventDefault(); cutItems([...selection]); } return; }
  if (mod && (e.key === 'c' || e.key === 'C')) { if (!typing && selection.size) { e.preventDefault(); copyToClipboard([...selection]); } return; }
  if (mod && (e.key === 'v' || e.key === 'V')) { if (!typing && clipboard) { e.preventDefault(); pasteClipboard(); } return; }
  if (mod && e.shiftKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newFolderModal(); return; }

  if (typing) return;

  if (e.key === 'Escape') { if (selection.size) { e.preventDefault(); clearSelection(); } return; }
  if (e.key === 'Backspace') { if (state.view === 'browse' && state.folder) { e.preventDefault(); const p = byId(state.folder); go('browse', { folder: p && p.parent ? p.parent : null }); } return; }
  if (!selectionEnabled()) return;
  if (e.key === 'Delete') { if (selection.size) { e.preventDefault(); state.view === 'trash' ? bulkDeleteForever([...selection]) : bulkTrash([...selection]); } return; }
  if (e.key === 'F2') { if (selection.size === 1) { e.preventDefault(); renameModal([...selection][0]); } return; }
  if (e.key === 'Enter') { if (selection.size === 1) { e.preventDefault(); openItem([...selection][0]); } return; }
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { if (displayedItems().length) { e.preventDefault(); arrowNav(e.key, e.shiftKey); } return; }
});

/* ---------- MODALS ---------- */
function modal(title, desc, value, onok) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><p>${esc(desc)}</p>
    <input id="mInput" value="${esc(value)}" />
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Save</button></div></div>`;
  document.body.appendChild(bg);
  const input = bg.querySelector('#mInput'); input.focus(); input.select();
  const close = () => bg.remove();
  const ok = () => { const v = input.value.trim(); if (v) onok(v); close(); };
  bg.querySelector('[data-cancel]').onclick = close;
  bg.querySelector('[data-ok]').onclick = ok;
  bg.onclick = e => { if (e.target === bg) close(); };
  input.onkeydown = e => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') close(); };
}
function renameModal(id) { const f = byId(id); modal('Rename', 'Give this item a new name.', f.name, v => { renameFile(id, v); render(); toast('Renamed'); }); }
function newFolderModal() {
  const parent = state.view === 'browse' ? state.folder : null;
  modal('New folder', 'Create a folder in the current location.', 'Untitled folder', async v => {
    await newFolder(parent, v);
    if (state.view !== 'browse') go('browse', { folder: parent }); else render();
    toast('Folder created');
  });
}

/* keep the in-memory DB row in sync after a server mutation, then repaint */
function _replaceDbRow(updated) {
  if (typeof DB !== 'undefined' && DB && DB.files && updated && updated.id) {
    const idx = DB.files.findIndex(f => f.id === updated.id);
    if (idx >= 0) DB.files[idx] = updated; else DB.files.push(updated);
  }
}
/* POST encrypted bytes + the public lockSpec; server stores the ciphertext blob
   and marks the row locked. Returns the updated row. */
async function _sealFileOnServer(fileId, itemName, bytes, plainSize, lockSpec) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'application/octet-stream' }), itemName + '.sx');
  fd.append('plainSize', String(plainSize));
  fd.append('lockSpec', JSON.stringify(lockSpec));
  const res = await fetch('/api/files/' + fileId + '/seal', { method: 'POST', body: fd, noTimeout: true });
  if (!res.ok) {
    let msg = 'encrypt failed';
    try { msg = (await res.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}
/* POST decrypted plaintext bytes; server stores them unencrypted and clears the
   lock. Returns the updated (now-unlocked) row. */
async function _unsealFileOnServer(fileId, itemName, bytes) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'application/octet-stream' }), itemName);
  const res = await fetch('/api/files/' + fileId + '/unseal', { method: 'POST', body: fd, noTimeout: true });
  if (!res.ok) {
    let msg = 'decrypt failed';
    try { msg = (await res.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

/* ENCRYPT — lock a file (or every file in a folder) under one passphrase. */
async function encryptItem(id) {
  const root = byId(id);
  if (!root) return;
  if (root.trashed) { toast('Restore the item before encrypting it', 'close'); return; }
  const targets = root.type === 'folder' ? descendants(root.id).filter(f => f.type !== 'folder') : [root];
  if (!targets.length) { toast('Nothing to encrypt in this folder', 'close'); return; }
  const pass = await _promptPassphrase('encrypt');
  if (pass == null) return;
  let done = 0;
  try {
    // One shared lockSpec id for the whole folder so a single unlock opens all of
    // its files; each file still gets its own salt/iv (fresh _encryptBytes call).
    let sharedId = null;
    for (const target of targets) {
      const plain = await _readItemBytes(target);
      const { cipher, spec } = await _encryptBytes(plain, pass);
      if (sharedId) spec.id = sharedId; else sharedId = spec.id;
      const updated = await _sealFileOnServer(target.id, target.name, cipher, plain.length, spec);
      _replaceDbRow(updated);
      done++;
    }
    if (root.type === 'folder' && sharedId) {
      const folderSpec = { id: sharedId, v: 2, alg: 'aes-256-gcm' };  // marker only; folder has no blob
      const updated = await apiJSON('/api/files/' + root.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locked: true, lockSpec: JSON.stringify(folderSpec) }),
      });
      _replaceDbRow(updated);
    }
    render();
    toast(`Encrypted ${done} item${done !== 1 ? 's' : ''}`, 'lock');
  } catch (e) {
    toast(e.message || 'Could not encrypt item', 'close');
  }
}

/* UNLOCK (temporary) — get the passphrase (cached or prompted), verify it by
   decrypting, cache it in sessionStorage so the item stays open across reloads,
   and repaint so the lock badge clears immediately (no reload needed).
   Returns the passphrase, or null if cancelled / wrong. */
async function unlockItemForUse(item) {
  if (!item) return null;
  const spec = _parseLockSpec(item);
  if (!spec) return null;
  const specId = _lockSpecId(spec);
  const cached = _cachedLockPass(specId);
  if (cached != null) return cached;
  const pass = await _promptPassphrase('unlock');
  if (pass == null) return null;
  // Verify by decrypting. A folder marker has no blob to test, so verify against
  // the first encrypted file under it instead. (hasBlob isn't sent to the client,
  // but a locked non-folder item is always backed by a blob — the seal enforces it.)
  try {
    const probe = item.type !== 'folder' ? item : descendants(item.id).find(f => f.type !== 'folder' && f.locked);
    if (probe) await _decryptItemBytes(probe, pass);
  } catch (e) {
    toast('Incorrect passphrase', 'close');
    return null;
  }
  _cacheLockPass(specId, pass);
  render();
  return pass;
}

/* DECRYPT (permanent) — remove encryption for good. Decrypts every target's bytes
   and re-uploads them as a normal unencrypted file via /unseal. */
async function decryptItem(id) {
  const root = byId(id);
  if (!root) return;
  const spec = _parseLockSpec(root);
  if (!spec) return;
  const specId = _lockSpecId(spec);
  let pass = _cachedLockPass(specId);
  if (pass == null) {
    pass = await _promptPassphrase('decrypt');
    if (pass == null) return;
  }
  // Targets are the locked, non-folder items (a locked non-folder always has a
  // blob — hasBlob isn't exposed to the client, so we key off type + locked).
  const targets = (root.type === 'folder' ? descendants(root.id).filter(f => f.type !== 'folder') : [root])
    .filter(f => f.locked);
  let done = 0;
  try {
    for (const target of targets) {
      const plain = await _decryptItemBytes(target, pass);
      const updated = await _unsealFileOnServer(target.id, target.name, plain);
      _replaceDbRow(updated);
      done++;
    }
    if (root.type === 'folder') {
      const updated = await apiJSON('/api/files/' + root.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locked: false, lockSpec: null }),
      });
      _replaceDbRow(updated);
    }
    _forgetLockPass(specId);   // no longer locked; drop any cached passphrase
    render();
    toast(`Decrypted ${done} item${done !== 1 ? 's' : ''}`, 'unlock');
  } catch (e) {
    // a wrong cached passphrase will fail the AES-GCM auth tag here
    toast(e.message && /decrypt|operation/i.test(e.message) ? 'Incorrect passphrase' : (e.message || 'Could not decrypt item'), 'close');
  }
}

async function decryptItemTextForOpen(item, opts = {}) {
  if (!_looksLocked(item)) return fetchDocText(item, opts);
  const pass = await unlockItemForUse(item);
  if (pass == null) throw new Error('unlock canceled');
  const bytes = await _decryptItemBytes(item, pass);
  const text = _encTextDecoder.decode(bytes);
  if (opts.limit && bytes.length > opts.limit) return { text: text.slice(0, opts.limit), truncated: true };
  return { text, truncated: false };
}

/* ---------- file-type / language recognition ----------
   Maps a file extension to a human language label. Anything here opens in the
   code/text editor with its language shown; anything not here still opens as raw
   text, but the editor shows an "unrecognized" warning. */
const LANGS = {
  // web
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript (JSX)',
  ts: 'TypeScript', tsx: 'TypeScript (TSX)', html: 'HTML', htm: 'HTML', css: 'CSS',
  scss: 'SCSS', sass: 'Sass', less: 'Less', vue: 'Vue', svelte: 'Svelte',
  // data / config
  json: 'JSON', jsonc: 'JSON', json5: 'JSON5', xml: 'XML', yaml: 'YAML', yml: 'YAML',
  toml: 'TOML', ini: 'INI', conf: 'Config', cfg: 'Config', env: 'Dotenv', csv: 'CSV',
  tsv: 'TSV', properties: 'Properties',
  // popular languages
  py: 'Python', pyw: 'Python', rb: 'Ruby', php: 'PHP', java: 'Java', kt: 'Kotlin',
  kts: 'Kotlin', scala: 'Scala', groovy: 'Groovy', go: 'Go', rs: 'Rust', swift: 'Swift',
  c: 'C', h: 'C header', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++ header',
  cs: 'C#', m: 'Objective-C', mm: 'Objective-C++', dart: 'Dart', lua: 'Lua', r: 'R',
  pl: 'Perl', pm: 'Perl', ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', hs: 'Haskell',
  clj: 'Clojure', cljs: 'ClojureScript', fs: 'F#', ml: 'OCaml', jl: 'Julia', nim: 'Nim',
  zig: 'Zig', v: 'V', sol: 'Solidity',
  // shell / scripts
  sh: 'Shell', bash: 'Bash', zsh: 'Zsh', fish: 'Fish', ps1: 'PowerShell', psm1: 'PowerShell',
  bat: 'Batch', cmd: 'Batch',
  // db / query
  sql: 'SQL', graphql: 'GraphQL', gql: 'GraphQL', prisma: 'Prisma',
  // markup / docs
  md: 'Markdown', markdown: 'Markdown', mdx: 'MDX', rst: 'reStructuredText', tex: 'LaTeX',
  txt: 'Plain text', log: 'Log', diff: 'Diff', patch: 'Diff',
  // build / misc
  dockerfile: 'Dockerfile', makefile: 'Makefile', mk: 'Makefile', gradle: 'Gradle',
  cmake: 'CMake', proto: 'Protobuf', gitignore: 'Gitignore', editorconfig: 'EditorConfig',
};
/* special filenames with no/odd extension */
const LANG_FILENAMES = {
  dockerfile: 'Dockerfile', makefile: 'Makefile', '.gitignore': 'Gitignore',
  '.env': 'Dotenv', '.editorconfig': 'EditorConfig', 'cmakelists.txt': 'CMake',
  '.npmrc': 'Config', '.bashrc': 'Bash', '.zshrc': 'Zsh', 'license': 'Plain text',
};
/* returns { lang: 'text'|'markdown'|<code key>, label, recognized } for a name */
function langForName(name) {
  const lower = String(name || '').toLowerCase();
  const base = lower.split('/').pop();
  if (LANG_FILENAMES[base]) {
    const label = LANG_FILENAMES[base];
    return { lang: label === 'Markdown' ? 'markdown' : 'text', label, recognized: true };
  }
  const m = base.match(/\.([a-z0-9]+)$/);
  const ext = m ? m[1] : '';
  if (ext && LANGS[ext]) {
    const label = LANGS[ext];
    return { lang: ext === 'md' || ext === 'markdown' ? 'markdown' : ext, label, recognized: true };
  }
  return { lang: 'text', label: ext ? ('.' + ext) : 'No extension', recognized: false };
}

/* ---------- UPLOAD ---------- */
function typeForFile(file) {
  // 3D model formats first: the browser reports no (or a useless) MIME type for
  // .fbx/.obj/.stl/.glb/.gltf, so they'd otherwise fall through to 'document' and
  // open in the text editor. Key off the extension, matching the server's
  // authoritative typeForExt() so the stored type agrees with what gets uploaded.
  const ext = (fileExt(file.name) || '').toLowerCase();
  if (['gltf', 'glb', 'obj', 'fbx', 'stl'].includes(ext)) return 'model3d';
  // EXR/TIFF: high-quality images the browser can't render natively. Classify as
  // 'image' (server renders a PNG preview) so they land in Photos, get a 2D viewer,
  // and expose "View as heightmap…" + convert. Matches the server's typeForExt().
  if (['exr', 'tif', 'tiff'].includes(ext)) return 'image';
  // .uasset is an Unreal Engine package; the browser reports no MIME for it, so
  // key off the extension to route it to the asset inspector instead of the text
  // editor. Matches the server's typeForExt().
  if (ext === 'uasset') return 'uasset';
  const t = file.type;
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('image/')) return 'image';
  // everything else opens in the text/code editor
  return 'document';
}
/* true for image files the browser can't decode in an <img> (exr/tiff) — these
   rely on the server-rendered PNG preview (posterUrl) for thumbnails and viewing.
   Mirrors the server's PREVIEW_EXTS / needsPreview(). */
function needsImgPreview(f) {
  if (!f || f.type !== 'image') return false;
  const ext = (fileExt(f.name) || '').toLowerCase();
  return ext === 'exr' || ext === 'tif' || ext === 'tiff';
}
/* the relative path of a file within a dropped/selected folder, if any.
   Folder <input webkitdirectory> sets webkitRelativePath; the drag tree-walk
   attaches _relPath. Plain files have neither. Returns e.g. "app/src/main.js". */
function relPathOf(file) {
  const rp = file._relPath || file.webkitRelativePath || '';
  return rp && rp.includes('/') ? rp : '';
}

/* ============================================================
   TERMS OF SERVICE — acceptance gate before the first upload
   ============================================================
   Returns true if the account has already accepted the current ToS version, or
   the user accepts it now; false if they decline (caller abandons the upload).
   The server enforces this independently (451 { code:'TOS' }); this is the UX. */
async function ensureTosAccepted() {
  if (ACCOUNT && ACCOUNT.tos_accepted) return true;
  let tos;
  try { tos = await getTos(); }
  catch (e) { toast('Could not load the Terms of Service — try again', 'close'); return false; }
  const agreed = await tosModal(tos.text);
  if (!agreed) return false;
  try {
    const r = await acceptTos();
    if (r && r.account) { ACCOUNT = r.account; if (typeof refreshAccountChips === 'function') refreshAccountChips(); }
    else if (ACCOUNT) ACCOUNT.tos_accepted = true;
    return true;
  } catch (e) {
    toast('Could not record your acceptance — try again', 'close');
    return false;
  }
}

/* The agreement dialog. Resolves true on "I Agree", false on decline/backdrop/Esc.
   The Agree button is disabled until the user scrolls the terms to the end, so the
   acceptance is meaningful. */
function tosModal(text) {
  return new Promise(resolve => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal tos-modal" role="dialog" aria-modal="true" aria-label="Terms of Service">
      <h3>Terms of Service &amp; Safety Notice</h3>
      <p class="tos-lead">Before adding content to your vault, please read and agree to the terms below. This applies to every upload, whether from your phone or your computer.</p>
      <div class="tos-body mono" id="tosBody" tabindex="0"></div>
      <label class="tos-check"><input type="checkbox" id="tosAck" /> <span>I have read and agree to the Terms of Service, and I understand I am responsible and liable for the content I upload.</span></label>
      <div class="acts">
        <button class="btn ghost" data-cancel>Not now</button>
        <button class="btn primary" data-ok disabled>I Agree</button>
      </div>
    </div>`;
    document.body.appendChild(bg);
    const body = bg.querySelector('#tosBody');
    body.textContent = text || '';
    const ack = bg.querySelector('#tosAck');
    const okBtn = bg.querySelector('[data-ok]');
    let scrolledEnd = false;
    // enable Agree only once they've scrolled to the bottom AND ticked the box
    const sync = () => { okBtn.disabled = !(scrolledEnd && ack.checked); };
    const checkScroll = () => {
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 8) { scrolledEnd = true; sync(); }
    };
    // if the terms are short enough not to scroll, count as read immediately
    if (body.scrollHeight <= body.clientHeight + 8) scrolledEnd = true;
    body.addEventListener('scroll', checkScroll);
    ack.addEventListener('change', sync);
    sync();
    const done = (v) => { bg.remove(); resolve(v); };
    bg.querySelector('[data-cancel]').onclick = () => done(false);
    okBtn.onclick = () => { if (!okBtn.disabled) done(true); };
    bg.onclick = e => { if (e.target === bg) done(false); };
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', esc); done(false); }
    });
  });
}

async function handleFiles(fileList) {
  // Legal gate: the FIRST upload after the current Terms of Service version must be
  // preceded by acceptance. Show the agreement and only proceed once accepted; if
  // the user declines, the upload is abandoned (they can re-trigger it after).
  if (typeof ensureTosAccepted === 'function') {
    const ok = await ensureTosAccepted();
    if (!ok) return;
  }
  const baseParent = state.view === 'browse' ? state.folder : null;
  const files = [...fileList];
  let added = 0, limitHit = false, foldersMade = 0;
  const failures = [];           // {file, err} — surfaced in one "Uh oh!" modal after the batch
  let projected = usedBytes();   // running total incl. files added in this batch
  const _justUploadedIds = [];   // collect ids to fetch AI-organization suggestions for
  _uploadAbort = new AbortController();
  _uploadCancelled = false;

  // Register the upload visually *immediately*, before any per-file prep
  // (folder creation, duration probing) runs — otherwise the UI shows nothing
  // for seconds while big media files are probed, and it looks frozen.
  UploadUI.begin(files);

  // resolve (and create on demand) a nested folder path under baseParent.
  // cache maps "app/src" -> folderId so each dir is created once.
  const dirCache = new Map();
  async function resolveDir(relDir) {
    if (!relDir) return baseParent;
    if (dirCache.has(relDir)) return dirCache.get(relDir);
    const segs = relDir.split('/');
    let parent = baseParent, acc = '';
    for (const seg of segs) {
      acc = acc ? acc + '/' + seg : seg;
      if (dirCache.has(acc)) { parent = dirCache.get(acc); continue; }
      // reuse an existing same-named child folder if present, else create
      let existing = children(parent).find(c => c.type === 'folder' && c.name === seg);
      let id;
      if (existing) id = existing.id;
      else { const rec = await newFolder(parent, seg); id = rec.id; foldersMade++; }
      dirCache.set(acc, id);
      parent = id;
    }
    return parent;
  }

  for (let i = 0; i < files.length; i++) {
    if (_uploadCancelled) break;
    const file = files[i];
    if (projected + file.size > TOTAL_BYTES) {
      limitHit = true;
      UploadUI.fileDone(i, 'skipped');
      console.warn('skipping (storage limit):', file.name);
      continue;
    }
    const rp = relPathOf(file);
    const relDir = rp ? rp.slice(0, rp.lastIndexOf('/')) : '';
    let parent;
    try { parent = await resolveDir(relDir); }
    catch (e) { console.error('folder create failed for', relDir, e); parent = baseParent; }
    UploadUI.setCurrent(i, uploadDestLabel(parent));

    const type = typeForFile(file);
    const extra = { type };
    if (type === 'document') extra.lang = langForName(file.name).lang;
    if (type === 'video' || type === 'audio') {
      // Duration is a nice-to-have metadatum, not required to upload. Probe with
      // a short timeout so a slow/odd file never stalls the queue; the upload
      // proceeds either way (a missing dur can be backfilled on first playback).
      const tmp = URL.createObjectURL(file);
      try { extra.dur = await probeDuration(tmp, type); } catch (e) {}
      URL.revokeObjectURL(tmp);
    }
    try {
      const rec = await uploadAny(file, parent, extra,
        frac => UploadUI.progress(i, frac),
        _uploadAbort.signal);
      added++;
      projected += file.size;
      UploadUI.fileDone(i, 'done');
      if (rec && rec.id) _justUploadedIds.push(rec.id);
    } catch (e) {
      if (e && (e.name === 'AbortError' || _uploadCancelled)) { _uploadCancelled = true; break; }
      if (e && e.code === 'LIMIT') { limitHit = true; UploadUI.fileDone(i, 'skipped'); }
      else { console.error('upload failed for', file.name, e); failures.push({ file, err: e }); UploadUI.fileDone(i, 'failed'); }
    }
  }
  _uploadAbort = null;
  UploadUI.hide();
  if (state.view !== 'browse') go('browse', { folder: baseParent }); else render();
  const limitGB = Math.round(TOTAL_BYTES / 1e9);
  if (_uploadCancelled) toast(added ? `Upload cancelled — ${added} already saved` : 'Upload cancelled', 'close');
  else if (limitHit) toast(`Storage limit reached — ${limitGB} GB max. ` + (added ? `${added} uploaded, the rest were skipped.` : 'Upload skipped.'), 'close');
  else if (added) toast(`${added} file${added !== 1 ? 's' : ''} uploaded` + (foldersMade ? ` · ${foldersMade} folder${foldersMade !== 1 ? 's' : ''} created` : ''));
  // one modal for the batch (the first failure carries the trace); extras get a toast
  if (failures.length && !_uploadCancelled) {
    uploadErrorModal(failures[0].file, failures[0].err);
    if (failures.length > 1) toast(`${failures.length} uploads failed`, 'close');
  }
  // AI Organization: fetch folder/tag suggestions for the just-uploaded files so
  // their chips appear under them (limited to a handful to avoid a request storm
  // on a big multi-file drop — the rest stay reachable via "AI Store…").
  if (!SHARE.active) _justUploadedIds.slice(0, 8).forEach(id => noteUploadForSuggestion(id));
}
let _uploadAbort = null, _uploadCancelled = false;
function cancelUpload() {
  if (!_uploadAbort) return;
  _uploadCancelled = true;
  try { _uploadAbort.abort(); } catch (e) {}
  UploadUI.setCancelling();
}
/* human-readable destination for the upload screen: "All files / Media / Films" */
function uploadDestLabel(parent) {
  const root = SHARE.active && SHARE.root ? SHARE.root.name : 'All files';
  if (parent == null) return root;
  return [root, ...pathOf(parent).map(f => f.name)].join(' / ');
}

/* walk a dropped DataTransfer for directory entries (webkitGetAsEntry API).
   Returns a flat File[] where folder files carry _relPath. Falls back to a plain
   file list when the browser doesn't expose entries. */
async function filesFromDataTransfer(dt) {
  const items = dt.items ? [...dt.items] : [];
  const entries = items.map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return dt.files ? [...dt.files] : [];
  const out = [];
  const readEntry = (entry, prefix) => new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(f => { if (prefix) try { f._relPath = prefix + f.name; } catch (e) {} out.push(f); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const dirPrefix = prefix + entry.name + '/';
      const readBatch = () => reader.readEntries(async (batch) => {
        if (!batch.length) return resolve();
        for (const e of batch) await readEntry(e, dirPrefix);
        readBatch();   // directories can return entries in batches; keep reading
      }, () => resolve());
      readBatch();
    } else resolve();
  });
  // top-level entries: files keep no prefix, directories seed the path
  for (const e of entries) await readEntry(e, '');
  return out;
}
function probeDuration(url, type) {
  return new Promise((res, rej) => {
    const el = document.createElement(type === 'video' ? 'video' : 'audio');
    el.preload = 'metadata'; el.src = url;
    el.onloadedmetadata = () => res(isFinite(el.duration) ? el.duration : null);
    el.onerror = rej; setTimeout(rej, 1500);   // short: never let one file stall the upload queue
  });
}
document.getElementById('uploader').addEventListener('change', e => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ''; });
document.getElementById('folderUploader').addEventListener('change', e => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ''; });
/* Upload button opens a small menu: files or a whole folder */
document.getElementById('uploadBtn').onclick = (e) => {
  e.stopPropagation();
  hideCtx();
  const menu = document.createElement('div'); menu.className = 'ctx'; ctxEl = menu;
  const items = [
    { ic: 'download', label: 'Upload files', fn: () => document.getElementById('uploader').click() },
    { ic: 'folder', label: 'Upload folder', fn: () => document.getElementById('folderUploader').click() },
  ];
  menu.innerHTML = items.map((it, i) => `<button data-ci="${i}">${svg(it.ic, 15)} ${esc(it.label)}</button>`).join('');
  document.body.appendChild(menu);
  const r = e.currentTarget.getBoundingClientRect(), mr = menu.getBoundingClientRect();
  menu.style.left = Math.min(r.left, innerWidth - mr.width - 10) + 'px';
  menu.style.top = (r.bottom + 6) + 'px';
  menu.querySelectorAll('[data-ci]').forEach(b => b.onclick = () => { hideCtx(); items[b.dataset.ci].fn(); });
};
document.getElementById('newFolderBtn').onclick = newFolderModal;

/* ---------- mobile sidebar drawer ---------- */
function setSidebar(open) {
  const sb = document.querySelector('#shell .sidebar'), bd = document.getElementById('sidebarBackdrop');
  if (sb) sb.classList.toggle('open', open);
  if (bd) bd.classList.toggle('show', open);
}
function closeSidebar() { setSidebar(false); }
{
  const mb = document.getElementById('menuBtn'); if (mb) mb.onclick = () => { const sb = document.querySelector('#shell .sidebar'); setSidebar(!sb.classList.contains('open')); };
  const bd = document.getElementById('sidebarBackdrop'); if (bd) bd.onclick = closeSidebar;
}

/* drag & drop — OS files = upload. Internal item drags (move) are ignored here:
   they carry no 'Files' and set internalDrag, so the upload overlay stays hidden. */
let dragDepth = 0;
const dz = document.getElementById('dropzone');
const isFileDrag = e => !internalDrag && e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', e => { if (document.getElementById('shell').classList.contains('hidden')) return; if (!isFileDrag(e)) return; e.preventDefault(); dragDepth++; dz.classList.add('show'); });
window.addEventListener('dragover', e => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('dragleave', e => { if (internalDrag) return; dragDepth--; if (dragDepth <= 0) { dragDepth = 0; dz.classList.remove('show'); } });
window.addEventListener('drop', async e => {
  if (internalDrag) return;
  e.preventDefault(); dragDepth = 0; dz.classList.remove('show');
  if (!e.dataTransfer) return;
  // directory-aware: a dropped folder is walked into a structured file list
  const files = await filesFromDataTransfer(e.dataTransfer);
  if (files.length) handleFiles(files);
});

/* ---------- PER-USER KEYS: legacy files (client side) ----------
   kv=1 rows predate the account's own key (still master-derived). They stay
   watchable/viewable, but editing and downloading require re-encryption —
   either per-file here, or the whole vault at once from Settings → Safety. */
function isLegacyFile(f) { return !!f && f.type !== 'folder' && f.kv === 1 && !SHARE.active; }

function legacyModal(f, action) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal twofa-modal">
    <div class="forcepw-badge">${svg('key', 18)}</div>
    <h3>This file uses the old key</h3>
    <p><b>${esc(f.name)}</b> was stored before your account got its own encryption key, so it's marked <b>Legacy</b>. You can still watch and view it — but to ${action === 'download' ? 'download' : 'edit'} it, re-encrypt it under your key first. Takes a moment; the file itself doesn't change.</p>
    <div class="form-err" id="lgErr"></div>
    <div class="acts"><button class="btn ghost" data-cancel>Not now</button><button class="btn primary" id="lgGo">${svg('key', 14)} Re-encrypt now</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('#lgGo').onclick = async () => {
    const btn = bg.querySelector('#lgGo'); btn.disabled = true; btn.textContent = 'Re-encrypting…';
    try {
      const rec = await reencryptFile(f.id);
      const i = DB.files.findIndex(x => x.id === f.id);
      if (i >= 0) DB.files[i] = rec;
      close(); render();
      toast('Re-encrypted under your key', 'check');
      if (action === 'download') downloadFile(f.id);
    } catch (e) {
      bg.querySelector('#lgErr').textContent = e.message || 're-encryption failed';
      btn.disabled = false; btn.innerHTML = `${svg('key', 14)} Re-encrypt now`;
    }
  };
}

/* full-screen blurred overlay while the vault re-encrypts (option B). Polls
   /api/keys/status — the one endpoint the migration gate leaves open — and
   reloads into the fresh all-v2 vault when the run finishes. */
const KeyGate = (() => {
  let timer = null;
  function ensure() {
    let el = document.getElementById('keyGate');
    if (el) return el;
    el = document.createElement('div'); el.id = 'keyGate';
    el.innerHTML = `<div class="kg-card">
      <div class="kg-ic">${svg('key', 22)}</div>
      <h3>Re-encrypting your vault</h3>
      <p>Every file is moving to your personal key. The vault is locked until it finishes — leave this page open (or come back later; it keeps running).</p>
      <div class="kg-track"><i></i></div>
      <div class="kg-line mono"><span class="kg-count"></span><span class="kg-cur"></span></div>
    </div>`;
    document.body.appendChild(el);
    return el;
  }
  function paint(p) {
    const el = ensure();
    el.classList.add('show');
    const total = p && p.total || 0, done = p && p.done || 0;
    const frac = total ? Math.min(1, done / total) : 0;
    el.querySelector('.kg-track i').style.width = (frac * 100) + '%';
    el.querySelector('.kg-count').textContent = p && p.phase === 'text'
      ? 'securing notes, chats & networks…'
      : `${done} / ${total} items · ${fmtSize(p && p.bytesDone || 0)} of ${fmtSize(p && p.bytesTotal || 0)}`;
    el.querySelector('.kg-cur').textContent = p && p.cur ? String(p.cur).slice(0, 48) : '';
  }
  async function poll() {
    try {
      const s = await keysStatus();
      if (!s.migrating || s.migrating.phase === 'done') { location.reload(); return; }
      paint(s.migrating);
    } catch (e) {
      if (e.code === 'MIGRATING' && e.progress) { paint(e.progress); return; }
      if (e.code === 'AUTH' || e.code === 'KEY') location.reload();
    }
  }
  return {
    show(progress) { paint(progress || null); if (!timer) timer = setInterval(poll, 1000); },
    active: () => !!timer,
  };
})();

/* ---------- Settings → Safety: the Encryption keys row ---------- */
function wireKeySettings() {
  if (!ACCOUNT || !ACCOUNT.keys_enrolled) return;
  const sub = document.getElementById('safKeysSub');
  if (!sub) return;
  keysStatus().then(s => {
    if (s.migrating) { KeyGate.show(s.migrating); return; }
    if (!sub.isConnected) return;
    if (s.legacy && s.legacy.files > 0) {
      sub.innerHTML = `<span style="color:var(--acc)">${s.legacy.files} legacy file${s.legacy.files === 1 ? '' : 's'} (${fmtSize(s.legacy.bytes)})</span> still on the old key`;
      const mig = document.getElementById('safKeyMig'); if (mig) mig.style.display = '';
    } else {
      sub.textContent = 'every file is sealed under your personal key';
    }
  }).catch(() => { if (sub.isConnected) sub.textContent = 'could not check key status'; });
  const swap = document.getElementById('safKeySwap');
  if (swap) swap.onclick = () => keyPasswordPrompt('Swap key to current password',
    'Your encryption key still rides your previous password. Enter your current password to move it over.',
    async (password, totp) => {
      await keysSwap(password, totp);
      ACCOUNT.key_stale = false;
      toast('Key swapped to your current password', 'check');
      reopenSettingsIfOpen();
    });
  const rc = document.getElementById('safKeyRc');
  if (rc) rc.onclick = () => keyPasswordPrompt('View your recovery key',
    'Your recovery key stays sealed inside your vault — this reveals it once, to you only. Enter your password to continue.',
    async (password, totp) => {
      const r = await keysReveal(password, totp);
      keyRecoveryModal(r.code, r.regenerated ? 'regen' : 'view', null);
    });
  const mig = document.getElementById('safKeyMig');
  if (mig) mig.onclick = confirmVaultReencrypt;
}
function keyPasswordPrompt(title, text, action) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal twofa-modal">
    <h3>${esc(title)}</h3>
    <p>${esc(text)}</p>
    <div class="form-fields">
      <label class="form-field"><span class="eyebrow">Current password</span><input type="password" id="kppPw" autocomplete="current-password"></label>
      ${ACCOUNT.totp_enabled ? `<label class="form-field"><span class="eyebrow">Two-auth code</span><input id="kppTotp" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code"></label>` : ''}
    </div>
    <div class="form-err" id="kppErr"></div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" id="kppGo">Continue</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('#kppGo').onclick = async () => {
    const err = bg.querySelector('#kppErr'); err.textContent = '';
    const btn = bg.querySelector('#kppGo'); btn.disabled = true;
    try { await action(bg.querySelector('#kppPw').value, bg.querySelector('#kppTotp')?.value); close(); }
    catch (e) { err.textContent = e.message || 'failed'; btn.disabled = false; }
  };
}
function confirmVaultReencrypt() {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal twofa-modal">
    <div class="forcepw-badge">${svg('key', 18)}</div>
    <h3>Re-encrypt your entire vault?</h3>
    <p>Every legacy file moves to your personal key in one go. While it runs, <b>your vault locks down</b> — a progress screen replaces the app until it finishes (a few minutes for most vaults; large ones take longer). Your files themselves don't change.</p>
    <div class="acts"><button class="btn ghost" data-cancel>Not now</button><button class="btn primary" id="vreGo">Lock down &amp; re-encrypt</button></div>
  </div>`;
  document.body.appendChild(bg);
  bg.querySelector('[data-cancel]').onclick = () => bg.remove();
  bg.onclick = e => { if (e.target === bg) bg.remove(); };
  bg.querySelector('#vreGo').onclick = async () => {
    try {
      const r = await reencryptVault();
      bg.remove();
      KeyGate.show(r.progress);
    } catch (e) { bg.remove(); toast(e.message || 'could not start re-encryption', 'close'); }
  };
}

/* ---------- DOWNLOAD ---------- */
async function downloadFile(id) {
  try {
    if (SHARE.active && !SHARE.allowDownload) { toast('Downloads are disabled for this link', 'close'); return; }
    const f = byId(id);
    // Legacy rows can't download until re-encrypted (server enforces via ?dl=1)
    if (isLegacyFile(f)) { legacyModal(f, 'download'); return; }
    if (_looksLocked(f)) {
      const pass = await unlockItemForUse(f);
      if (pass == null) return;
      const bytes = await _decryptItemBytes(f, pass);
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = f.name; a.click(); toast('Downloading ' + f.name); return;
    }
    const u = mediaUrl(f);
    // ?dl=1 marks this as a DOWNLOAD (the server gates Legacy rows on it;
    // plain streaming for playback carries no flag and stays open)
    if (u) { const a = document.createElement('a'); a.href = u + (u.includes('?') ? '&' : '?') + 'dl=1'; a.download = f.name; a.click(); toast('Downloading ' + f.name); return; }
    if (f.type === 'document') {
      // content-backed doc: the body isn't in the list anymore — fetch it before saving
      let text = f.content;
      if (text == null) { try { text = (await fetchDocText(f)).text; } catch (e) { text = ''; } }
      const blob = new Blob([text || ''], { type: 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = f.name; a.click(); toast('Downloading ' + f.name); return;
    }
    toast('Demo file - upload your own to download');
  } catch (e) { toast(e && e.message ? e.message : 'Could not download item', 'close'); }
}

/* ---------- TOAST ---------- */
let toastTimer;
function toast(msg, icon = 'save') {
  const t = document.getElementById('toast');
  t.innerHTML = `<span class="ti">${svg(icon, 16)}</span>${esc(msg)}`;
  t.classList.add('show'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------- UPLOAD PROGRESS (UploadUI) ----------
   One upload state, two presentations the user can flip between mid-batch:
   - MAXIMIZED (default): a full upload screen over a blurred backdrop — the file
     being sent + where it's going, live specs (speed / ping / time left / data
     moved / connection / elapsed) and the whole batch as a checklist.
   - MINIMIZED: the compact pill at the bottom (the old indicator) + an expand
     button. The choice sticks in localStorage so the next batch opens the way
     the user left it. */
const UploadUI = (() => {
  const MIN_KEY = 'simplex.uploadUiMin';
  const LIST_CAP = 100;               // checklist rows rendered; bigger batches get "+N more"
  let items = [];                     // { name, size, status: queued|up|done|failed|skipped, frac, _pct }
  let cur = -1, curDest = '';
  let totalBytes = 0, startedAt = 0;
  let minimized = localStorage.getItem(MIN_KEY) === '1';
  let cancelling = false, shown = false;
  let samples = [], emaBps = null, lastSpecPaint = 0, tick = null;

  const fmtBps = bps => {
    if (bps == null) return '—';
    const m = bps / 1e6;
    return (m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2)) + ' MB/s';
  };
  const fmtEta = s => {
    if (s == null || !isFinite(s)) return '—';
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  };
  const fmtB = b => b ? fmtSize(b) : '0 B';

  function doneBytes() {
    let b = 0;
    for (const it of items) { if (it.status === 'done') b += it.size; else if (it.status === 'up') b += it.frac * it.size; }
    return b;
  }
  // failed/skipped files never move, so they leave the denominator too
  function lostBytes() { let b = 0; for (const it of items) if (it.status === 'failed' || it.status === 'skipped') b += it.size; return b; }

  /* speed = bytes moved across a sliding ~8s window, smoothed with an EMA so the
     readout doesn't jitter with every XHR onprogress event. The 1s tick keeps
     sampling during stalls so a dead uplink decays toward 0 instead of freezing. */
  function sampleSpeed() {
    const t = performance.now(), b = doneBytes();
    samples.push({ t, b });
    while (samples.length > 2 && t - samples[0].t > 8000) samples.shift();
    const first = samples[0];
    if (t - first.t >= 400) {
      const inst = Math.max(0, (b - first.b) / ((t - first.t) / 1000));
      emaBps = emaBps == null ? inst : inst * 0.3 + emaBps * 0.7;
    }
  }

  /* ---- DOM: the maximized screen ---- */
  function screenEl() {
    let el = document.getElementById('uploadScreen');
    if (el) return el;
    el = document.createElement('div'); el.id = 'uploadScreen';
    const SPECS = [['speed', 'Speed'], ['ping', 'Ping'], ['eta', 'Time left'], ['moved', 'Uploaded'], ['conn', 'Connection'], ['elapsed', 'Elapsed']];
    // the Cloudflare notice only makes sense where Cloudflare is actually in the path
    const cfNote = location.hostname === 'data.guythatlives.net'
      ? `<div class="us-notice">${svg('info', 14)}<span>Uploads here can feel slower than in other programs. Every file uploaded to or downloaded from the database is run through all checks made by Cloudflare, to ensure safety on both sides: client/user and server/owners.</span></div>` : '';
    el.innerHTML = `<div class="us-card">
      <div class="us-head"><span class="us-ic">${svg('upload', 17)}</span><div class="us-title">Uploading<span class="us-count"></span></div><button class="us-min" title="Minimize" aria-label="Minimize upload screen">${svg('minus', 16)}</button></div>
      <div class="us-now"><div class="us-name"></div><div class="us-dest"></div><div class="us-track"><i></i></div><div class="us-line"><span class="us-pct"></span><span class="us-nof"></span></div></div>
      <div class="us-specs">${SPECS.map(([k, l]) => `<div class="us-spec"><span class="eyebrow">${l}</span><b data-k="${k}">—</b></div>`).join('')}</div>
      <div class="us-list"></div>
      ${cfNote}
      <div class="us-foot"><button class="us-cancel">Cancel upload</button></div>
    </div>`;
    document.body.appendChild(el);
    el.querySelector('.us-min').onclick = () => setMin(true);
    el.querySelector('.us-cancel').onclick = cancelUpload;
    return el;
  }

  /* ---- DOM: the minimized pill (the old indicator + an expand button) ---- */
  function barEl() {
    let el = document.getElementById('uploadbar');
    if (el) return el;
    el = document.createElement('div'); el.id = 'uploadbar';
    el.innerHTML = '<div class="ub-top"><div class="ub-label"></div><button class="ub-max" title="Show upload screen" aria-label="Show upload screen">' + svg('full', 13) + '</button><button class="ub-cancel" title="Cancel upload" aria-label="Cancel upload">' + svg('close', 15) + '</button></div><div class="ub-track"><i></i></div>';
    document.body.appendChild(el);
    el.querySelector('.ub-max').onclick = () => setMin(false);
    el.querySelector('.ub-cancel').onclick = cancelUpload;
    return el;
  }

  function buildList() {
    const list = screenEl().querySelector('.us-list');
    list.innerHTML = '';
    items.slice(0, LIST_CAP).forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'us-row queued'; row.dataset.i = i;
      const st = document.createElement('span'); st.className = 'us-st';
      const nm = document.createElement('span'); nm.className = 'us-fn'; nm.textContent = it.name;
      const sz = document.createElement('span'); sz.className = 'us-fs'; sz.textContent = fmtSize(it.size);
      row.append(st, nm, sz);
      list.appendChild(row);
    });
    if (items.length > LIST_CAP) {
      const more = document.createElement('div'); more.className = 'us-more';
      more.textContent = '+ ' + (items.length - LIST_CAP) + ' more files';
      list.appendChild(more);
    }
  }

  function paintRow(i) {
    if (i < 0 || i >= LIST_CAP) return;
    const it = items[i];
    const row = screenEl().querySelector(`.us-row[data-i="${i}"]`);
    if (!row || !it) return;
    row.className = 'us-row ' + it.status;
    const st = row.querySelector('.us-st');
    if (it.status === 'done') st.innerHTML = svg('check', 12);
    else if (it.status === 'failed') st.innerHTML = svg('close', 12);
    else if (it.status === 'skipped') st.textContent = 'skip';
    else if (it.status === 'up') st.textContent = Math.round(it.frac * 100) + '%';
    else st.textContent = '';
  }

  function scrollCur() {
    if (cur < 0 || cur >= LIST_CAP) return;
    const row = document.querySelector(`#uploadScreen .us-row[data-i="${cur}"]`);
    if (!row) return;
    const list = row.parentElement;
    list.scrollTop = Math.max(0, row.offsetTop - list.clientHeight / 2 + row.clientHeight / 2);
  }

  function paintSpecs(force) {
    if (minimized || !shown) return;
    const now = performance.now();
    if (!force && now - lastSpecPaint < 250) return;
    lastSpecPaint = now;
    const el = screenEl();
    const q = k => el.querySelector(`[data-k="${k}"]`);
    const done = doneBytes(), eff = Math.max(1, totalBytes - lostBytes());
    q('speed').textContent = fmtBps(emaBps);
    let ping = null;
    if (typeof NetWatch !== 'undefined' && NetWatch.ms) ping = NetWatch.ms();   // live RTT from the lag monitor
    q('ping').textContent = ping != null ? Math.round(ping) + ' ms' : '—';
    q('eta').textContent = emaBps > 1000 ? fmtEta((eff - done) / emaBps) : '—';
    q('moved').textContent = fmtB(done) + ' of ' + fmtB(eff);
    q('conn').textContent = (typeof CONN !== 'undefined' && CONN === 'direct') ? 'Direct (LAN)' : 'Cloudflare';
    q('elapsed').textContent = startedAt ? fmtEta((Date.now() - startedAt) / 1000) : '—';
  }

  function paint() {
    if (!shown) return;
    const it = items[cur] || null;
    const nOf = Math.min(cur + 1, items.length) || 1;
    const frac = it ? (it.status === 'done' ? 1 : it.frac) : 0;
    const pct = Math.round(frac * 100);
    if (minimized) {
      const el = barEl();
      el.querySelector('.ub-label').textContent = cancelling ? 'Cancelling…' :
        `Uploading ${it ? it.name : '…'} — ${pct}%` + (items.length > 1 ? ` · ${nOf}/${items.length} files` : '');
      el.querySelector('.ub-track i').style.width = pct + '%';
    } else {
      const el = screenEl();
      el.querySelector('.us-name').textContent = cancelling ? 'Cancelling…' : (it ? it.name : 'Preparing…');
      el.querySelector('.us-dest').textContent = curDest ? 'to ' + curDest : '';
      el.querySelector('.us-count').textContent = items.length > 1 ? `${nOf} / ${items.length}` : '';
      el.querySelector('.us-track i').style.width = pct + '%';
      el.querySelector('.us-pct').textContent = pct + '%';
      el.querySelector('.us-nof').textContent = items.length > 1 ? `file ${nOf} of ${items.length}` : (it ? fmtSize(it.size) : '');
      paintSpecs(false);
    }
  }

  function syncCancel() {
    const bc = document.querySelector('#uploadbar .ub-cancel'); if (bc) bc.disabled = cancelling;
    const sc = document.querySelector('#uploadScreen .us-cancel'); if (sc) sc.disabled = cancelling;
  }

  function applyVis() {
    const s = document.getElementById('uploadScreen');
    if (s) s.classList.toggle('show', shown && !minimized);
    const b = (shown && minimized) ? barEl() : document.getElementById('uploadbar');
    if (b) b.classList.toggle('show', shown && minimized);
  }

  function startTick() {
    stopTick();
    tick = setInterval(() => { if (!shown) return; sampleSpeed(); paintSpecs(true); }, 1000);
  }
  function stopTick() { if (tick) { clearInterval(tick); tick = null; } }

  function setMin(v) {
    minimized = !!v;
    try { localStorage.setItem(MIN_KEY, minimized ? '1' : '0'); } catch (e) {}
    if (!shown) return;
    applyVis(); paint();
    if (!minimized) { paintSpecs(true); scrollCur(); }
  }

  return {
    begin(files) {
      items = [...files].map(f => ({ name: relPathOf(f) || f.name, size: f.size || 0, status: 'queued', frac: 0, _pct: -1 }));
      totalBytes = items.reduce((s, it) => s + it.size, 0);
      cur = -1; curDest = ''; cancelling = false; shown = true;
      startedAt = Date.now(); samples = []; emaBps = null; lastSpecPaint = 0;
      screenEl();          // exists even when starting minimized, so expanding is instant
      buildList(); syncCancel(); applyVis(); paint(); paintSpecs(true); startTick();
    },
    setCurrent(i, dest) {
      cur = i; curDest = dest || '';
      const it = items[i]; if (it && it.status === 'queued') it.status = 'up';
      paintRow(i); paint(); scrollCur();
    },
    progress(i, frac) {
      const it = items[i]; if (!it) return;
      if (it.status === 'queued') it.status = 'up';
      it.frac = frac;
      sampleSpeed();
      const pct = Math.round(frac * 100);
      if (pct !== it._pct) { it._pct = pct; paintRow(i); }
      paint();
    },
    fileDone(i, status) {
      const it = items[i]; if (!it) return;
      it.status = status; if (status === 'done') it.frac = 1;
      paintRow(i); paint(); paintSpecs(false);
    },
    hide() { shown = false; cancelling = false; stopTick(); applyVis(); },
    setCancelling() { cancelling = true; syncCancel(); paint(); },
    active: () => shown,
  };
})();

/* ---------- UTIL ---------- */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

document.querySelectorAll('#viewseg button').forEach(b => b.onclick = () => setViewMode(b.dataset.v));
document.getElementById('sortBtn').onclick = (e) => { e.stopPropagation(); showSortMenu(e.currentTarget); };

/* ---------- SHARE DIALOG (owner) ---------- */
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  ta.remove();
}

/* ---------- code blocks (AI chat / assistant / notes preview) ----------
   mdToHtml (viewers.js) emits collapsible .codeblock components with their raw
   code stashed in data-code. ONE delegated listener drives every one of them —
   Open (toggle), Copy (code only, no language tag), Download (as the file type)
   — so no consumer has to wire buttons and freshly-streamed blocks work too. */
let _cbSeq = 0;
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.codeblock [data-cb]');
  if (!btn) return;
  const cb = btn.closest('.codeblock');
  if (!cb) return;
  const action = btn.dataset.cb;
  const code = (() => { try { return decodeURIComponent(cb.dataset.code || ''); } catch (_) { return cb.dataset.code || ''; } })();
  if (action === 'toggle') {
    const open = cb.classList.toggle('open');
    btn.setAttribute('title', open ? 'Hide code' : 'Show code');
    btn.setAttribute('aria-label', open ? 'Hide code' : 'Show code');
    // remember across re-renders (streaming rebuilds the transcript constantly)
    const id = cb.dataset.cbid;
    if (id && typeof _cbOpen !== 'undefined') { if (open) _cbOpen.add(id); else _cbOpen.delete(id); }
  } else if (action === 'copy') {
    copyText(code).then(() => toast('Code copied', 'check')).catch(() => toast('Could not copy', 'close'));
  } else if (action === 'download') {
    const ext = cb.dataset.ext || 'txt';
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `snippet-${Date.now().toString(36)}-${++_cbSeq}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Downloaded .' + ext, 'download');
  }
});
async function openShareDialog(id) {
  hideCtx();
  const f = byId(id); if (!f) return;
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal share-modal">
    <div class="share-head">
      <span class="ti bg-${f.type} t-${f.type}">${svg('share', 17, 1.7)}</span>
      <div><h3>Share “${esc(f.name)}”</h3><p>Anyone with a link can view this ${f.type === 'folder' ? 'folder and everything in it' : 'file'} — no login required.</p></div>
    </div>
    <div class="share-links" id="shareLinks"><div class="share-empty mono">loading…</div></div>
    <label class="share-newopt"><input type="checkbox" id="shareDl" checked> <span>Allow downloads</span></label>
    <div class="acts">
      <button class="btn ghost" data-close>Done</button>
      <button class="btn primary" id="shareCreate">${svg('plus', 14)} Create link</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-close]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };

  const listEl = bg.querySelector('#shareLinks');
  async function refresh() {
    let all;
    try { all = await listShares(); }
    catch (e) { listEl.innerHTML = `<div class="share-empty mono">${e.status === 401 ? 'unlock the vault to manage links' : 'could not load links'}</div>`; return; }
    const mine = all.filter(s => s.fileId === id);
    if (!mine.length) { listEl.innerHTML = `<div class="share-empty mono">no links yet</div>`; return; }
    listEl.innerHTML = mine.map(s => shareLinkRowHTML(s)).join('');
    listEl.querySelectorAll('.share-link').forEach(row => wireShareLinkRow(row, refresh));
  }
  bg.querySelector('#shareCreate').onclick = async () => {
    try {
      const s = await createShare(id, bg.querySelector('#shareDl').checked);
      copyText(location.origin + s.url);
      toast('Link created & copied', 'link');
      refresh();
    } catch (e) {
      toast(e.status === 401 ? 'Unlock the vault to create links' : 'Could not create link', 'close');
    }
  };
  refresh();
}

/* One share link row: a Simplex-page / Raw-file toggle (raw only for file shares),
   the selected URL (copyable), an editable custom name (slug), and delete. State for
   which mode is showing lives on the row's dataset so re-renders aren't needed. */
function shareLinkRowHTML(s) {
  const hasRaw = !!s.rawUrl;                       // folders have no raw url
  const nativeUrl = location.origin + s.url;
  const rawUrl = hasRaw ? location.origin + s.rawUrl : '';
  const slug = s.slug || '';
  return `
    <div class="share-link" data-token="${s.token}" data-native="${esc(nativeUrl)}" data-raw="${esc(rawUrl)}" data-mode="native">
      <div class="sl-top">
        ${hasRaw ? `<div class="seg sl-modeseg">
            <button type="button" data-mode="native" class="on" title="Opens the Simplex viewer page">${svg('window', 12)} Simplex</button>
            <button type="button" data-mode="raw" title="Direct link to the file itself — for Discord & other embeds">${svg('link', 12)} Raw</button>
          </div>` : '<span class="sl-onlylabel mono">Simplex link</span>'}
        ${s.allowDownload ? '' : '<span class="sl-badge" title="View only — downloads disabled">view-only</span>'}
        <div class="spacer"></div>
        <button class="iconbtn sl-del" title="Delete link">${svg('trash', 15)}</button>
      </div>
      <div class="sl-urlrow">
        <input class="sl-url" readonly value="${esc(nativeUrl)}">
        <button class="iconbtn sl-copy" title="Copy link">${svg('copy', 15)}</button>
      </div>
      <div class="sl-slugrow">
        <span class="sl-slughint mono">custom name</span>
        <input class="sl-slug" placeholder="e.g. my-clip" value="${esc(slug)}" spellcheck="false" autocomplete="off" maxlength="48">
        <button class="btn ghost sm sl-slugsave">Save</button>
        ${slug ? '<button class="btn ghost sm sl-slugclear" title="Remove custom name">Reset</button>' : ''}
      </div>
    </div>`;
}
function wireShareLinkRow(row, refresh) {
  const token = row.dataset.token;
  const urlEl = row.querySelector('.sl-url');
  const currentUrl = () => row.dataset.mode === 'raw' ? row.dataset.raw : row.dataset.native;
  const applyMode = () => { urlEl.value = currentUrl(); };
  // native/raw toggle
  row.querySelectorAll('.sl-modeseg [data-mode]').forEach(b => b.onclick = () => {
    row.dataset.mode = b.dataset.mode;
    row.querySelectorAll('.sl-modeseg [data-mode]').forEach(x => x.classList.toggle('on', x === b));
    applyMode();
  });
  urlEl.onclick = e => e.target.select();
  row.querySelector('.sl-copy').onclick = () => { copyText(currentUrl()); toast(row.dataset.mode === 'raw' ? 'Raw link copied' : 'Link copied', 'copy'); };
  row.querySelector('.sl-del').onclick = async () => { await deleteShare(token); toast('Link deleted', 'trash'); refresh(); };
  // custom slug save / clear
  const slugEl = row.querySelector('.sl-slug');
  const saveSlug = async (value) => {
    try {
      await setShareSlug(token, value);
      toast(value ? 'Custom name set' : 'Custom name removed', 'check');
      refresh();
    } catch (e) { toast(e.message || 'Could not set name', 'close'); }
  };
  row.querySelector('.sl-slugsave').onclick = () => saveSlug(slugEl.value.trim());
  slugEl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); saveSlug(slugEl.value.trim()); } };
  const clr = row.querySelector('.sl-slugclear'); if (clr) clr.onclick = () => saveSlug('');
}

/* ============================================================
   ACCOUNT UI — account chip (sidebar + launcher + app bar), menus, panels
   ============================================================ */
function avatarInitials(name) { return String(name || '?').trim().slice(0, 2).toUpperCase(); }

/* mount the account chip into any .account-box container (the vault sidebar, the
   launcher top bar, and the generic app bar all reuse it) */
function mountAccountChip(box) {
  if (!box || !ACCOUNT) return;
  box.innerHTML = `
    <button class="notif-bell" title="Notifications" aria-label="Notifications">${svg('bell', 17)}<span class="notif-dot${_notifUnread ? ' on' : ''}">${_notifUnread ? (_notifUnread > 9 ? '9+' : _notifUnread) : ''}</span></button>
    <button class="acct-chip" title="Account">
      <span class="acct-av" style="--av:${esc(ACCOUNT.avatar_color || 'var(--acc)')}">${esc(avatarInitials(ACCOUNT.display || ACCOUNT.username))}</span>
      <span class="acct-meta">
        <span class="acct-name">${esc(ACCOUNT.display || ACCOUNT.username)}</span>
        <span class="acct-sub mono">${ACCOUNT.is_admin ? 'administrator' : 'member'}</span>
      </span>
      ${svg('more', 16)}
    </button>`;
  const chip = box.querySelector('.acct-chip');
  chip.onclick = (e) => { e.stopPropagation(); showAccountMenu(chip); };
  const bell = box.querySelector('.notif-bell');
  bell.onclick = (e) => { e.stopPropagation(); openNotifPanel(bell); };
}
function updateNotifBadges() {
  document.querySelectorAll('.account-box .notif-dot').forEach(d => {
    d.classList.toggle('on', _notifUnread > 0);
    d.textContent = _notifUnread ? (_notifUnread > 9 ? '9+' : _notifUnread) : '';
  });
}
function renderAccountBox() { mountAccountChip(document.getElementById('accountBox')); }
/* keep every mounted chip (whichever screen is showing) in sync after a poll */
function refreshAccountChips() { document.querySelectorAll('.account-box').forEach(mountAccountChip); }

function showAccountMenu(anchor) {
  hideCtx();
  const items = [];
  if (currentApp !== 'dashboard' && !SHARE.active) items.push({ ic: 'grid', label: 'Dashboard', fn: goDashboard });
  items.push({ ic: 'rename', label: 'My account', fn: openMyAccount });
  if (ACCOUNT.is_admin) items.push({ ic: 'files', label: 'Manage accounts', fn: openAdminPanel });
  items.push({ div: true });
  items.push({ ic: 'lock', label: 'Sign out', fn: signOut });
  const menu = document.createElement('div'); menu.className = 'ctx'; ctxEl = menu;
  menu.innerHTML = items.map((it, i) => it.div ? '<div class="div"></div>'
    : `<button data-ci="${i}">${svg(it.ic, 15)} ${esc(it.label)}</button>`).join('');
  document.body.appendChild(menu);
  // position-aware: drop below the anchor, flip up if there's no room, clamp to viewport
  const r = anchor.getBoundingClientRect(), mr = menu.getBoundingClientRect();
  let top = r.bottom + 6;
  if (top + mr.height > innerHeight - 8) top = r.top - mr.height - 6;
  let left = r.left;
  if (left + mr.width > innerWidth - 8) left = r.right - mr.width;
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = Math.max(8, top) + 'px';
  menu.querySelectorAll('[data-ci]').forEach(b => b.onclick = () => { hideCtx(); items[b.dataset.ci].fn(); });
}

/* a small modal builder that runs an async submit and shows inline errors */
function formModal({ title, desc, descHtml = false, bodyHtml = '', fields, okLabel = 'Save', onSubmit, extraClass = '' }) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${extraClass}">
    <h3>${esc(title)}</h3>${desc ? `<p>${descHtml ? desc : esc(desc)}</p>` : ''}
    ${bodyHtml || ''}
    <div class="form-fields">
      ${fields.map(f => `
        <label class="form-field">
          <span class="eyebrow">${esc(f.label)}</span>
          ${f.type === 'checkbox'
            ? `<input type="checkbox" data-k="${f.key}" ${f.value ? 'checked' : ''}>`
            : f.type === 'select'
            ? `<select class="set-select" data-k="${f.key}">${(f.options || []).map(o => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
            : f.type === 'textarea'
            ? `<textarea class="form-textarea" data-k="${f.key}" placeholder="${esc(f.placeholder || '')}" rows="${f.rows || 3}" ${f.attrs || ''}>${esc(f.value ?? '')}</textarea>`
            : `<input type="${f.type || 'text'}" data-k="${f.key}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" ${f.attrs || ''}>`}
        </label>`).join('')}
    </div>
    <div class="form-err" id="formErr"></div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>${esc(okLabel)}</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  const errEl = bg.querySelector('#formErr');
  const collect = () => {
    const out = {};
    bg.querySelectorAll('[data-k]').forEach(i => { out[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value; });
    return out;
  };
  const submit = async () => {
    errEl.textContent = ''; const okBtn = bg.querySelector('[data-ok]'); okBtn.disabled = true;
    try { await onSubmit(collect(), close); }
    catch (e) { errEl.textContent = e.message || 'something went wrong'; okBtn.disabled = false; }
  };
  bg.querySelector('[data-cancel]').onclick = close;
  bg.querySelector('[data-ok]').onclick = submit;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelectorAll('input').forEach(i => i.onkeydown = e => { if (e.key === 'Enter' && i.type !== 'checkbox') submit(); if (e.key === 'Escape') close(); });
  const first = bg.querySelector('input'); if (first) first.focus();
  return bg;
}

/* Public self-serve signup, opened from the login screen. Collects the request and
   queues it for admin approval; no account exists or is created here. */
function openSignup() {
  formModal({
    title: 'Request an account',
    desc: 'Tell us a bit about you and your storage needs. An admin will review your request before your account is created.',
    extraClass: 'account-modal signup-modal',
    fields: [
      { key: 'username', label: 'Username', placeholder: 'e.g. taylor', attrs: 'autocapitalize="off" autocorrect="off" spellcheck="false"' },
      { key: 'display', label: 'Display name', placeholder: 'optional' },
      { key: 'password', label: 'Password', type: 'password', attrs: 'autocomplete="new-password"' },
      { key: 'email', label: 'Email (optional)', type: 'email', placeholder: 'optional', attrs: 'autocapitalize="off" autocorrect="off" spellcheck="false"' },
      { key: 'explanation', label: 'Who are you & what will you store?', type: 'textarea', rows: 4, placeholder: 'A few words about you — this helps us size your storage.' },
      { key: 'requested_gb', label: 'Storage you think you need (GB)', type: 'number', placeholder: 'e.g. 50', attrs: 'min="1" step="1"' },
    ],
    okLabel: 'Send request',
    onSubmit: async (vals, close) => {
      const username = (vals.username || '').trim();
      if (!username) throw new Error('username required');
      if (!vals.password || vals.password.length < 6) throw new Error('password must be at least 6 characters');
      const payload = {
        username,
        display: (vals.display || '').trim(),
        password: vals.password,
        email: (vals.email || '').trim(),
        explanation: (vals.explanation || '').trim(),
      };
      const gb = parseFloat(vals.requested_gb);
      if (Number.isFinite(gb) && gb > 0) payload.requested_gb = gb;
      await submitSignup(payload);
      close();
      toast('Request sent — an admin will review it', 'check');
    },
  });
}

/* ============================================================
   ACCOUNT SAFETY (Settings → Safety)
   The safety bar (Minimal / Moderate / Maximum), recovery email, and the
   two-auth setup wizard: QR (or copyable text secret) → 6-digit code →
   "Are you one of the humans?" → native captcha → enabled. See the matching
   server endpoints under ACCOUNT SAFETY in server.js.
   ============================================================ */
const SAFETY_RANK = { minimal: 0, moderate: 1, maximum: 2 };
const SAFETY_DESC = {
  minimal: 'password only — the door has one lock',
  moderate: 'password + recovery email — you can be rescued',
  maximum: 'password + email + two-auth — new devices need a code',
};

function wireSafetySettings() {
  const bar = document.getElementById('safetyBar'); if (!bar) return;
  bar.querySelectorAll('[data-lvl]').forEach(b => b.onclick = () => safetyPick(b.dataset.lvl));
  const em = document.getElementById('safEmail'); if (em) em.onclick = () => safetyEmailModal();
  const pw = document.getElementById('safPw'); if (pw) pw.onclick = openMyAccount;
  const on = document.getElementById('saf2faOn'); if (on) on.onclick = () => {
    if (!ACCOUNT.email) { toast('Set a recovery email first', 'info'); return safetyEmailModal(() => twofaWizard()); }
    twofaWizard();
  };
  const rg = document.getElementById('safRegen');
  if (rg) rg.onclick = () => confirmModal('Regenerate two-auth',
    'This walks you through setup again with a brand-new secret (use this if the old QR or text secret may have leaked). Your current codes keep working until the new setup completes.',
    () => twofaWizard(), 'Start over');
  const off = document.getElementById('saf2faOff');
  if (off) off.onclick = async () => {
    const code = await promptTotpCode('Turning two-auth off — enter a code to confirm it\'s you.');
    if (code == null) return;
    try {
      const r = await twofaDisable(code);
      ACCOUNT = r.account;
      toast('Two-auth is off', 'check');
      refreshAccountChips(); reopenSettingsIfOpen();
    } catch (e) { toast(e.message || 'Could not turn off two-auth', 'close'); }
  };
}

async function safetyPick(level) {
  const cur = ACCOUNT.safety || 'minimal';
  if (level === cur) return;
  try {
    if (level === 'maximum') {
      if (ACCOUNT.totp_enabled) return;
      if (!ACCOUNT.email) { toast('Maximum needs a recovery email first', 'info'); return safetyEmailModal(() => twofaWizard()); }
      return twofaWizard();
    }
    if (level === 'moderate' && !ACCOUNT.email) {
      return safetyEmailModal(async () => {
        const r = await mySafety('moderate');
        ACCOUNT = r.account; refreshAccountChips(); reopenSettingsIfOpen();
        toast('Safety level: Moderate', 'check');
      });
    }
    let totp;
    if (ACCOUNT.totp_enabled) {   // stepping down from Maximum switches two-auth off
      totp = await promptTotpCode('Lowering your safety level turns two-auth off — enter a code to confirm.');
      if (totp == null) return;
    }
    const r = await mySafety(level, totp);
    ACCOUNT = r.account; refreshAccountChips(); reopenSettingsIfOpen();
    toast('Safety level: ' + level[0].toUpperCase() + level.slice(1), 'check');
  } catch (e) { toast(e.message || 'Could not change safety level', 'close'); }
}

function safetyEmailModal(after) {
  const fields = [{ key: 'email', label: 'Email address', type: 'email', value: ACCOUNT.email || '', placeholder: 'you@example.com', attrs: 'autocapitalize="off" autocorrect="off" spellcheck="false"' }];
  if (ACCOUNT.totp_enabled) fields.push({ key: 'totp', label: 'Two-auth code', placeholder: '000000', attrs: 'inputmode="numeric" maxlength="6" autocomplete="one-time-code"' });
  formModal({
    title: ACCOUNT.email ? 'Change recovery email' : 'Set recovery email',
    desc: 'Where an admin can email you a password-reset code if you\'re ever locked out. Also required for two-auth.',
    fields,
    okLabel: 'Save email',
    onSubmit: async (vals, close) => {
      const r = await myEmail((vals.email || '').trim(), vals.totp);
      ACCOUNT = r.account;
      close();
      toast('Recovery email saved', 'check');
      refreshAccountChips(); reopenSettingsIfOpen();
      if (after) await after();
    },
  });
}

/* small promise-modal asking for a 6-digit code; resolves null on cancel */
function promptTotpCode(desc) {
  return new Promise(resolve => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal twofa-modal"><h3>Two-auth code</h3>
      <p>${esc(desc || 'Enter the 6-digit code from your authenticator app.')}</p>
      <input class="twofa-code" id="ptcIn" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
      <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Confirm</button></div></div>`;
    document.body.appendChild(bg);
    const done = v => { bg.remove(); resolve(v); };
    bg.querySelector('[data-cancel]').onclick = () => done(null);
    bg.onclick = e => { if (e.target === bg) done(null); };
    const inp = bg.querySelector('#ptcIn'); inp.focus();
    bg.querySelector('[data-ok]').onclick = () => done(inp.value);
    inp.onkeydown = e => { if (e.key === 'Enter') done(inp.value); };
  });
}

/* draw an otpauth:// URI as a QR into el (reuses the Tools QR library) */
async function drawQrInto(el, text) {
  try {
    await ctLoadScript('https://unpkg.com/qrcode-generator@1.4.4/qrcode.js');
    const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
    const count = qr.getModuleCount(), margin = 2, total = count + margin * 2, size = 440;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d'), cell = size / total;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++)
      if (qr.isDark(r, c)) ctx.fillRect(Math.round((c + margin) * cell), Math.round((r + margin) * cell), Math.ceil(cell), Math.ceil(cell));
    el.innerHTML = ''; el.appendChild(canvas);
  } catch (e) { el.innerHTML = `<div class="tool-err mono">${esc(e.message || 'Could not draw the QR')}</div>`; }
}

/* the two-auth setup wizard (also used for Regenerate — begin() re-mints) */
async function twofaWizard() {
  let secret = null, otpauth = null, savedCode = '';
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal twofa-modal"><div id="twofaBody"><div class="dim mono pad-sm">Preparing…</div></div></div>`;
  document.body.appendChild(bg);
  const body = bg.querySelector('#twofaBody');
  const close = () => bg.remove();
  bg.onclick = e => { if (e.target === bg) close(); };   // abandoning is safe: a pending secret is inert

  async function begin() { const r = await twofaBegin(); secret = r.secret; otpauth = r.otpauth; }

  function stepQR() {
    body.innerHTML = `
      <h3>Set up two-auth</h3>
      <p>Scan this with your authenticator app (Google Authenticator, Authy, 1Password…). No camera? Show the text secret and paste it in instead.</p>
      <div class="twofa-qr" id="twofaQr"><div class="dim mono">Drawing…</div></div>
      <div class="twofa-secret hidden" id="twofaSecretBox">
        <code class="mono">${esc(secret)}</code>
        <button class="btn ghost sm" id="twofaCopy">${svg('copy', 13)} Copy</button>
      </div>
      <div class="acts twofa-acts">
        <button class="btn ghost sm" id="twofaShowText">Show text secret</button>
        <button class="btn ghost sm" id="twofaRegen" title="Mint a fresh secret if this one may have been seen">${svg('refresh', 13)} Regenerate</button>
        <span class="spacer"></span>
        <button class="btn ghost" data-cancel>Cancel</button>
        <button class="btn primary" id="twofaNext">Next</button>
      </div>`;
    drawQrInto(body.querySelector('#twofaQr'), otpauth);
    body.querySelector('#twofaShowText').onclick = () => body.querySelector('#twofaSecretBox').classList.toggle('hidden');
    body.querySelector('#twofaCopy').onclick = async () => {
      try { await navigator.clipboard.writeText(secret); toast('Secret copied', 'check'); }
      catch (e) { toast('Could not copy — select it by hand', 'close'); }
    };
    body.querySelector('#twofaRegen').onclick = async () => {
      try { await begin(); stepQR(); toast('New secret — rescan / recopy it', 'refresh'); }
      catch (e) { toast(e.message || 'Could not regenerate', 'close'); }
    };
    body.querySelector('[data-cancel]').onclick = close;
    body.querySelector('#twofaNext').onclick = stepCode;
  }

  function stepCode() {
    body.innerHTML = `
      <h3>Enter the 6-digit code</h3>
      <p>Type the code your authenticator app is showing for Simplex right now.</p>
      <input class="twofa-code" id="twofaCodeIn" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
      <div class="form-err" id="twofaErr"></div>
      <div class="acts"><button class="btn ghost" id="twofaBack">Back</button><button class="btn primary" id="twofaVerifyBtn">Verify</button></div>`;
    const inp = body.querySelector('#twofaCodeIn'), err = body.querySelector('#twofaErr');
    inp.focus();
    body.querySelector('#twofaBack').onclick = stepQR;
    const go = async () => {
      err.textContent = '';
      try { await twofaVerify(inp.value); savedCode = inp.value; stepHuman(); }
      catch (e) { err.textContent = e.message || 'wrong code'; inp.select(); }
    };
    body.querySelector('#twofaVerifyBtn').onclick = go;
    inp.onkeydown = e => { if (e.key === 'Enter') go(); };
  }

  function stepHuman() {
    body.innerHTML = `
      <h3>Are you one of the humans?</h3>
      <p>Quick check before we switch this on.</p>
      <div class="acts twofa-human">
        <button class="btn primary" id="humanYes">Yep, I'm real</button>
        <button class="btn ghost" id="humanNo">No, I'm a bot</button>
      </div>`;
    body.querySelector('#humanYes').onclick = stepCaptcha;
    body.querySelector('#humanNo').onclick = () => {
      body.innerHTML = `<h3>That's too bad.</h3>
        <p>Robots can't have two-auth. Come back when you're one of the humans.</p>
        <div class="acts"><button class="btn primary" id="humanOk">Okay</button></div>`;
      body.querySelector('#humanOk').onclick = stepQR;   // restarts the setup, per policy
    };
  }

  async function stepCaptcha() {
    body.innerHTML = `<h3>Prove it</h3>
      <p>Type the characters you see. Humans are great at this.</p>
      <div class="twofa-captcha" id="capBox"><div class="dim mono">Loading…</div></div>
      <input class="twofa-code cap" id="capIn" maxlength="5" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="•••••">
      <div class="form-err" id="capErr"></div>
      <div class="acts">
        <button class="btn ghost sm" id="capNew">${svg('refresh', 13)} New image</button>
        <span class="spacer"></span>
        <button class="btn primary" id="capGo">Verify</button>
      </div>`;
    const boxEl = body.querySelector('#capBox'), inEl = body.querySelector('#capIn'), errEl = body.querySelector('#capErr');
    let capId = null;
    const load = async () => {
      try { const c = await captchaNew(); capId = c.id; boxEl.innerHTML = c.svg; }
      catch (e) { boxEl.innerHTML = `<div class="tool-err mono">${esc(e.message || 'could not load')}</div>`; }
    };
    await load();
    inEl.focus();
    body.querySelector('#capNew').onclick = () => { inEl.value = ''; load(); inEl.focus(); };
    const go = async () => {
      errEl.textContent = '';
      try {
        const r = await captchaCheck(capId, inEl.value);
        await finish(r.token);
      } catch (e) { errEl.textContent = e.message || 'wrong answer'; inEl.value = ''; load(); inEl.focus(); }
    };
    body.querySelector('#capGo').onclick = go;
    inEl.onkeydown = e => { if (e.key === 'Enter') go(); };
  }

  async function finish(captchaToken, freshCode) {
    try {
      const r = await twofaEnable(freshCode || savedCode, captchaToken);
      ACCOUNT = r.account;
      refreshAccountChips(); reopenSettingsIfOpen();
      body.innerHTML = `<h3>Two-auth is on</h3>
        <p>Safety level: <b>Maximum</b>. Signing in from a new device or IP now needs a code — this device stays trusted until you sign out manually.</p>
        <div class="acts"><button class="btn primary" data-done>Done</button></div>`;
      body.querySelector('[data-done]').onclick = close;
    } catch (e) {
      if (e && e.message && /code expired/i.test(e.message)) {
        // the TOTP rotated while doing the captcha — same captcha token, fresh code
        body.innerHTML = `<h3>Almost there</h3>
          <p>Your code expired during the captcha — enter a fresh one to finish.</p>
          <input class="twofa-code" id="twofaFinal" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
          <div class="form-err" id="twofaFinalErr"></div>
          <div class="acts"><button class="btn primary" id="twofaFinishBtn">Finish</button></div>`;
        const inp = body.querySelector('#twofaFinal'); inp.focus();
        body.querySelector('#twofaFinishBtn').onclick = () => finish(captchaToken, inp.value);
        inp.onkeydown = ev => { if (ev.key === 'Enter') finish(captchaToken, inp.value); };
      } else if (e && e.message && /captcha/i.test(e.message)) {
        stepCaptcha();
      } else {
        body.innerHTML = `<h3>Setup failed</h3><p>${esc((e && e.message) || 'Something went wrong.')}</p>
          <div class="acts"><button class="btn ghost" data-cancel>Close</button><button class="btn primary" id="twofaRetry">Start over</button></div>`;
        body.querySelector('[data-cancel]').onclick = close;
        body.querySelector('#twofaRetry').onclick = stepQR;
      }
    }
  }

  try { await begin(); stepQR(); }
  catch (e) {
    body.innerHTML = `<h3>Two-auth</h3><p>${esc((e && e.message) || 'Could not start setup.')}</p>
      <div class="acts"><button class="btn ghost" data-cancel>Close</button></div>`;
    body.querySelector('[data-cancel]').onclick = close;
  }
}

function openMyAccount() {
  formModal({
    title: 'My account',
    desc: `Signed in as ${ACCOUNT.username}. Leave password blank to keep it unchanged.`,
    extraClass: 'account-modal',
    fields: [
      { key: 'display', label: 'Display name', value: ACCOUNT.display || '' },
      { key: 'password', label: 'New password', type: 'password', placeholder: 'unchanged', attrs: 'autocomplete="new-password"' },
      ...(ACCOUNT.totp_enabled ? [{ key: 'totp', label: 'Two-auth code (required to change the password)', placeholder: '000000', attrs: 'inputmode="numeric" maxlength="6" autocomplete="one-time-code"' }] : []),
    ],
    okLabel: 'Save changes',
    onSubmit: async (vals, close) => {
      const payload = {};
      if (vals.display && vals.display.trim() && vals.display.trim() !== ACCOUNT.display) payload.display = vals.display.trim();
      if (vals.password) {
        if (pwWeakClient(vals.password, ACCOUNT.username)) throw new Error('that password is too weak — 6+ characters, nothing common');
        payload.password = vals.password;
        if (ACCOUNT.totp_enabled) payload.totp = vals.totp;
      }
      if (!Object.keys(payload).length) { close(); return; }
      const r = await updateMe(payload);
      ACCOUNT = r.account;
      refreshAccountChips(); reopenSettingsIfOpen();
      close();
      toast(payload.password ? 'Password updated' : 'Account updated', 'check');
      // per policy the encryption-key wrap does NOT follow a password change —
      // offer the manual swap right away (or it waits in Settings → Safety)
      if (payload.password) setTimeout(() => offerKeySwap(payload.password), 500);
    },
  });
}

/* ---------- admin: accounts manager ---------- */
async function openAdminPanel() {
  if (!ACCOUNT.is_admin) return;
  // Full-page overlay (was a cramped modal): its own fixed layer with a top bar,
  // a wide two-column body (Accounts | Security), and its own scroll. Closing
  // returns to wherever the admin came from — no navigation state to restore.
  const page = document.createElement('div'); page.className = 'admin-page';
  page.innerHTML = `
    <div class="admin-pagebar">
      <button class="btn ghost as-back" id="adminBack" title="Close">${svg('back', 16)} Back</button>
      <div class="as-title"><span class="as-ico bg-folder t-folder">${svg('files', 17, 1.7)}</span>Manage accounts</div>
      <div class="spacer"></div>
      <button class="btn primary" id="adminNew">${svg('plus', 14)} New account</button>
    </div>
    <div class="admin-pagebody">
      <div class="admin-col admin-col-accounts">
        <div class="admin-colhead"><h3>Accounts</h3><p>Create, edit, and remove vault accounts. Each has its own encrypted vault.</p></div>
        <div class="admin-list" id="adminList"><div class="share-empty mono">loading…</div></div>
      </div>
      <div class="admin-col admin-col-security">
        <div class="sec-section" id="secSection"></div>
      </div>
    </div>`;
  document.body.appendChild(page);
  requestAnimationFrame(() => page.classList.add('show'));
  const close = () => { page.classList.remove('show'); setTimeout(() => page.remove(), 220); };
  page.querySelector('#adminBack').onclick = close;
  // Esc closes, matching modal muscle memory
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  const listEl = page.querySelector('#adminList');
  const secEl = page.querySelector('#secSection');
  const bg = page;   // the inner logic references bg.querySelector(...) — alias to the page root

  async function refresh() {
    let accts;
    try { accts = await listAccounts(); }
    catch (e) { if (e.code === 'AUTH') { close(); relock(); return; } listEl.innerHTML = `<div class="share-empty mono">could not load accounts</div>`; return; }
    listEl.innerHTML = accts.map(a => {
      const pct = a.quota_bytes ? Math.min(100, (a.used / a.quota_bytes) * 100) : 0;
      return `<div class="admin-row" data-id="${a.id}">
        <span class="acct-av" style="--av:${esc(a.avatar_color || 'var(--acc)')}">${esc(avatarInitials(a.display || a.username))}</span>
        <div class="admin-who">
          <div class="admin-name">${esc(a.display || a.username)} ${a.is_admin ? '<span class="admin-badge">admin</span>' : ''}</div>
          <div class="admin-sub mono">@${esc(a.username)} · ${fmtSize(a.used)} / ${fmtSize(a.quota_bytes)}</div>
          <div class="admin-bar"><i style="width:${pct}%"></i></div>
        </div>
        <button class="iconbtn" data-edit="${a.id}" title="Edit">${svg('rename', 15)}</button>
        <button class="iconbtn" data-del="${a.id}" title="Delete" ${a.id === ACCOUNT.id ? 'disabled' : ''}>${svg('trash', 15)}</button>
      </div>`;
    }).join('');
    listEl.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editAccount(accts.find(a => a.id === b.dataset.edit), refresh));
    listEl.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      const a = accts.find(x => x.id === b.dataset.del); if (!a) return;
      confirmModal('Delete account', `Permanently delete “${a.display || a.username}” and its entire encrypted vault? This cannot be undone.`, async () => {
        try { await deleteAccount(a.id); toast('Account deleted', 'trash'); refresh(); }
        catch (e) { toast(e.message || 'Could not delete', 'close'); }
      }, 'Delete account');
    });
  }
  const TIER_LABELS = { minimal: 'Minimal — lenient throttle', limited: 'Limited — 5 fails ban 15 min + alert admins', locked: 'Locked — 1 fail bans; 5 bans → 1 day' };
  function tierOptions(sel) {
    return ['minimal', 'limited', 'locked'].map(t => `<option value="${t}" ${t === sel ? 'selected' : ''}>${esc(TIER_LABELS[t])}</option>`).join('');
  }
  function fmtRemain(untilMs) {
    let s = Math.max(0, Math.round((untilMs - Date.now()) / 1000));
    if (s >= 3600) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    if (s >= 60) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return s + 's';
  }
  async function refreshSecurity() {
    let sec;
    try { sec = await getSecurity(); }
    catch (e) { if (e.code === 'AUTH') { close(); relock(); return; } secEl.innerHTML = `<h4>Security</h4><div class="sec-empty">could not load security settings</div>`; return; }
    const signups = sec.signups || [];
    const bans = sec.bans || [];
    const resets = sec.resets || [];
    secEl.innerHTML = `
      <div class="admin-colhead"><h3>Security</h3><p>Login protection, account requests, password resets, and banned addresses.</p></div>
      <h4>Login security</h4>
      <p>The tier on the account whose username is typed at sign-in decides how failed attempts are punished (the offending IP is banned). Set a per-account tier when editing that account.</p>
      <div class="sec-tier-row">
        <select class="set-select" id="secDefaultTier">${tierOptions(sec.defaultTier)}</select>
      </div>
      <div class="sec-note" style="margin-top:4px">Default tier — reserved for future use. Unknown usernames currently always use Minimal, so this setting has no effect yet.</div>

      <h4 style="margin-top:18px">Account requests ${signups.length ? `<span class="sec-count">${signups.length}</span>` : ''}</h4>
      ${signups.length ? `<div class="sec-list">${signups.map(s => `
        <div class="sec-row" data-sid="${esc(s.id)}">
          <div class="sec-main">
            <div class="sec-title">@${esc(s.username)}${s.display ? ' · ' + esc(s.display) : ''}</div>
            <div class="sec-sub">${s.email ? esc(s.email) + ' · ' : ''}${s.requested_gb ? esc(String(s.requested_gb)) + ' GB requested' : 'no GB estimate'}${s.explanation ? '<br>' + esc(s.explanation) : ''}</div>
          </div>
          <div class="sec-acts">
            <button class="btn primary" data-approve="${esc(s.id)}">Approve</button>
            <button class="iconbtn" data-reject="${esc(s.id)}" title="Reject">${svg('trash', 15)}</button>
          </div>
        </div>`).join('')}</div>` : `<div class="sec-empty">no pending requests</div>`}

      <h4 style="margin-top:18px">Password reset requests ${resets.length ? `<span class="sec-count">${resets.length}</span>` : ''}</h4>
      ${resets.length ? `<div class="sec-list">${resets.map(r => `
        <div class="sec-row" data-rid="${esc(r.id)}">
          <div class="sec-main">
            <div class="sec-title">@${esc(r.username)}${r.display && r.display !== r.username ? ' · ' + esc(r.display) : ''}</div>
            <div class="sec-sub">${r.email ? 'email the code to <b>' + esc(r.email) + '</b>' : '<b>no recovery email on file</b> — reach them another way'} · asked ${esc(new Date(r.created).toLocaleString())}${r.status === 'sent' ? ' · <b>code issued</b>' : ''}</div>
          </div>
          <div class="sec-acts">
            <button class="btn primary" data-rescode="${esc(r.id)}">${r.status === 'sent' ? 'New code' : 'Generate code'}</button>
            <button class="iconbtn" data-resdel="${esc(r.id)}" title="Dismiss">${svg('trash', 15)}</button>
          </div>
        </div>`).join('')}</div>` : `<div class="sec-empty">no reset requests</div>`}
      <div class="sec-note">Generating a code shows it to you ONCE — email it to the user yourself. Codes expire after 24 hours; the user finishes at the sign-in screen via “Forgot password?”.</div>

      <h4 style="margin-top:18px">Banned IPs ${bans.length ? `<span class="sec-count">${bans.length}</span>` : ''}</h4>
      ${bans.length ? `<div class="sec-list">${bans.map(b => `
        <div class="sec-row" data-banip="${esc(b.ip)}">
          <div class="sec-main">
            <div class="sec-title mono">${esc(b.ip)}</div>
            <div class="sec-sub">${esc(b.reason || 'banned')} · ${b.ban_count ? b.ban_count + ' strike' + (b.ban_count === 1 ? '' : 's') + ' · ' : ''}<span class="ban-remain">${fmtRemain(b.until)} left</span></div>
          </div>
          <div class="sec-acts"><button class="btn ghost" data-unban="${esc(b.ip)}">Unban</button></div>
        </div>`).join('')}</div>` : `<div class="sec-empty">no active bans</div>`}
      <div class="sec-note">A banned IP is blocked from everything except the countdown screen. Note: if your own network is banned you'll be locked out too until the timer ends or you unban from a different IP.</div>`;

    secEl.querySelector('#secDefaultTier').onchange = async (e) => {
      try { await setSecurityDefault(e.target.value); toast('Default tier updated', 'check'); }
      catch (err) { toast(err.message || 'Could not update', 'close'); refreshSecurity(); }
    };
    secEl.querySelectorAll('[data-approve]').forEach(btn => btn.onclick = () => {
      const s = signups.find(x => x.id === btn.dataset.approve); if (!s) return;
      approveSignupFlow(s, () => { refresh(); refreshSecurity(); });
    });
    secEl.querySelectorAll('[data-reject]').forEach(btn => btn.onclick = () => {
      const s = signups.find(x => x.id === btn.dataset.reject); if (!s) return;
      confirmModal('Reject request', `Discard @${s.username}'s account request? Their submitted details (including the password) are deleted.`, async () => {
        try { await rejectSignup(s.id); toast('Request rejected', 'trash'); refreshSecurity(); }
        catch (e) { toast(e.message || 'Could not reject', 'close'); }
      }, 'Reject');
    });
    secEl.querySelectorAll('[data-unban]').forEach(btn => btn.onclick = async () => {
      try { await unbanIp(btn.dataset.unban); toast('IP unbanned', 'check'); refreshSecurity(); }
      catch (e) { toast(e.message || 'Could not unban', 'close'); }
    });
    secEl.querySelectorAll('[data-rescode]').forEach(btn => btn.onclick = async () => {
      const r = resets.find(x => x.id === btn.dataset.rescode); if (!r) return;
      try {
        const out = await adminResetCode(r.id);
        showResetCodeModal(r, out.code, refreshSecurity);
      } catch (e) { toast(e.message || 'Could not generate a code', 'close'); }
    });
    secEl.querySelectorAll('[data-resdel]').forEach(btn => btn.onclick = () => {
      const r = resets.find(x => x.id === btn.dataset.resdel); if (!r) return;
      confirmModal('Dismiss reset request', `Drop @${r.username}'s password-reset request? Any issued code stops working.`, async () => {
        try { await adminResetDismiss(r.id); toast('Request dismissed', 'trash'); refreshSecurity(); }
        catch (e) { toast(e.message || 'Could not dismiss', 'close'); }
      }, 'Dismiss');
    });
  }

  bg.querySelector('#adminNew').onclick = () => newAccount(() => { refresh(); refreshSecurity(); });
  refresh();
  refreshSecurity();
}

/* show a freshly generated reset code to the admin — the one and only time the
   plaintext exists. Copy it, or open a pre-filled email draft to the user. */
function showResetCodeModal(r, code, after) {
  const mailHref = r.email ? 'mailto:' + encodeURIComponent(r.email)
    + '?subject=' + encodeURIComponent('Simplex password reset code')
    + '&body=' + encodeURIComponent(
      `Hi ${r.display || r.username},\n\nYour Simplex password reset code is:\n\n    ${code}\n\nOn the sign-in screen choose "Forgot password?" -> "I already have a code", then enter this code with your new password. It expires in 24 hours.\n`) : null;
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal twofa-modal">
    <h3>Reset code for @${esc(r.username)}</h3>
    <p>Shown once — we only keep a hash. Email it to ${r.email ? `<b>${esc(r.email)}</b>` : 'the user (no recovery email on file!)'}. Expires in 24 hours.</p>
    <div class="reset-code mono" id="resetCodeBox">${esc(code)}</div>
    <div class="acts">
      <button class="btn ghost" id="resetCopy">${svg('copy', 14)} Copy code</button>
      ${mailHref ? `<a class="btn primary" id="resetMail" href="${esc(mailHref)}">${svg('rename', 14)} Open email draft</a>` : ''}
      <span class="spacer"></span>
      <button class="btn ghost" data-close>Done</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); after && after(); };
  bg.querySelector('[data-close]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('#resetCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(code); toast('Code copied', 'check'); }
    catch (e) { toast('Could not copy — select it by hand', 'close'); }
  };
}

/* Approve a pending signup, letting the admin confirm/override the storage quota
   (prefilled from the request's GB estimate). Creates the account on confirm. */
function approveSignupFlow(s, after) {
  formModal({
    title: 'Approve account request',
    desc: `Create an account for @${s.username}${s.explanation ? '. They wrote: “' + s.explanation + '”' : '.'}`,
    extraClass: 'account-modal',
    fields: [
      { key: 'quota_gb', label: 'Storage limit (GB)', type: 'number', value: (Number.isFinite(s.requested_gb) && s.requested_gb > 0) ? s.requested_gb : 200, attrs: 'min="1" step="1"' },
    ],
    okLabel: 'Approve & create',
    onSubmit: async (vals, close) => {
      const gb = parseFloat(vals.quota_gb);
      if (!Number.isFinite(gb) || gb <= 0) throw new Error('storage limit must be a positive number of GB');
      await approveSignup(s.id, gb);
      close(); toast('Account created', 'check'); after && after();
    },
  });
}

function newAccount(after) {
  formModal({
    title: 'New account',
    desc: 'Create a new account with its own encrypted, isolated 200 GB vault.',
    extraClass: 'account-modal',
    fields: [
      { key: 'username', label: 'Username', placeholder: 'e.g. taylor', attrs: 'autocapitalize="off" autocorrect="off" spellcheck="false"' },
      { key: 'display', label: 'Display name', placeholder: 'optional' },
      { key: 'password', label: 'Password', type: 'password', attrs: 'autocomplete="new-password"' },
      { key: 'quota_gb', label: 'Storage limit (GB)', type: 'number', value: 200, attrs: 'min="1" step="1"' },
      { key: 'is_admin', label: 'Administrator (can manage all accounts)', type: 'checkbox', value: false },
      { key: 'can_code', label: 'Can run code (execute programs in the Code app)', type: 'checkbox', value: false },
      { key: 'can_ai', label: 'Can use AI (chat in the AI app)', type: 'checkbox', value: false },
      { key: 'can_neural_backend', label: 'Can use backend compute (run Neural Network training on the server)', type: 'checkbox', value: false },
      { key: 'org_max_tier', label: 'AI Organization — highest scale this account may pick', type: 'select', value: 'medium', options: [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
      { key: 'security_tier', label: 'Login security tier (how failed sign-ins are punished)', type: 'select', value: 'minimal', options: [{ value: 'minimal', label: 'Minimal' }, { value: 'limited', label: 'Limited' }, { value: 'locked', label: 'Locked' }] },
    ],
    okLabel: 'Create account',
    onSubmit: async (vals, close) => {
      if (!vals.username || !vals.username.trim()) throw new Error('username required');
      if (!vals.password) throw new Error('password required');
      const gb = parseFloat(vals.quota_gb);
      if (!Number.isFinite(gb) || gb <= 0) throw new Error('storage limit must be a positive number of GB');
      await createAccount({ username: vals.username.trim(), display: (vals.display || '').trim(), password: vals.password, is_admin: !!vals.is_admin, can_code: !!vals.can_code, can_ai: !!vals.can_ai, can_neural_backend: !!vals.can_neural_backend, org_max_tier: vals.org_max_tier || 'medium', security_tier: vals.security_tier || 'minimal', quota_bytes: Math.round(gb * 1e9) });
      close(); toast('Account created', 'check'); after && after();
    },
  });
}

function editAccount(a, after) {
  if (!a) return;
  formModal({
    title: 'Edit account',
    desc: `Editing @${a.username}. Leave password blank to keep it unchanged.`,
    extraClass: 'account-modal',
    fields: [
      { key: 'username', label: 'Username', value: a.username, attrs: 'autocapitalize="off" autocorrect="off" spellcheck="false"' },
      { key: 'display', label: 'Display name', value: a.display || '' },
      { key: 'email', label: 'Recovery email', type: 'email', value: a.email || '', placeholder: 'none on file', attrs: 'autocapitalize="off" autocorrect="off" spellcheck="false"' },
      { key: 'password', label: 'New password', type: 'password', placeholder: 'unchanged', attrs: 'autocomplete="new-password"' },
      { key: 'quota_gb', label: 'Storage limit (GB)', type: 'number', value: +(a.quota_bytes / 1e9).toFixed(2).replace(/\.00$/, ''), attrs: 'min="1" step="1"' },
      { key: 'is_admin', label: 'Administrator', type: 'checkbox', value: !!a.is_admin },
      { key: 'can_code', label: 'Can run code (Code app execution)', type: 'checkbox', value: !!a.can_code },
      { key: 'can_ai', label: 'Can use AI (AI app)', type: 'checkbox', value: !!a.can_ai },
      { key: 'can_neural_backend', label: 'Can use backend compute (Neural Network server training)', type: 'checkbox', value: !!a.can_neural_backend },
      { key: 'org_max_tier', label: 'AI Organization — highest scale this account may pick', type: 'select', value: a.org_max_tier || 'medium', options: [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
      { key: 'security_tier', label: 'Login security tier (how failed sign-ins are punished)', type: 'select', value: a.security_tier || 'minimal', options: [{ value: 'minimal', label: 'Minimal' }, { value: 'limited', label: 'Limited' }, { value: 'locked', label: 'Locked' }] },
    ],
    okLabel: 'Save changes',
    onSubmit: async (vals, close) => {
      const payload = {};
      if (vals.username && vals.username.trim() !== a.username) payload.username = vals.username.trim();
      if ((vals.display || '').trim() !== (a.display || '')) payload.display = (vals.display || '').trim() || a.username;
      if ((vals.email || '').trim() !== (a.email || '')) payload.email = (vals.email || '').trim();
      if (vals.password) payload.password = vals.password;
      if (!!vals.is_admin !== !!a.is_admin) payload.is_admin = !!vals.is_admin;
      if (!!vals.can_code !== !!a.can_code) payload.can_code = !!vals.can_code;
      if (!!vals.can_ai !== !!a.can_ai) payload.can_ai = !!vals.can_ai;
      if (!!vals.can_neural_backend !== !!a.can_neural_backend) payload.can_neural_backend = !!vals.can_neural_backend;
      if ((vals.org_max_tier || 'medium') !== (a.org_max_tier || 'medium')) payload.org_max_tier = vals.org_max_tier || 'medium';
      if ((vals.security_tier || 'minimal') !== (a.security_tier || 'minimal')) payload.security_tier = vals.security_tier || 'minimal';
      const gb = parseFloat(vals.quota_gb);
      if (Number.isFinite(gb) && gb > 0 && Math.round(gb * 1e9) !== a.quota_bytes) payload.quota_bytes = Math.round(gb * 1e9);
      if (!Object.keys(payload).length) { close(); return; }
      const r = await updateAccount(a.id, payload);
      if (a.id === ACCOUNT.id) { ACCOUNT = r.account; refreshAccountChips(); reopenSettingsIfOpen(); }   // edited self
      close(); toast('Account updated', 'check'); after && after();
    },
  });
}

/* ============================================================
   RESTART GATE — when the server is restarting, a full-screen "garage door"
   rolls smoothly down over ~3s and stays as a cover for the whole restart, with
   a rotating loader + status on it. The gate shows for: (a)
   clients connected when a restart starts, (b) anyone who reloads / joins while
   it's in progress. While gated we keep pinging /api/restart-status; the moment
   a FRESH process answers (a new startedAt, or simply server-back-after-being-
   down), we hard-reload everyone so all changes take effect.
   ============================================================ */
const RestartGate = (() => {
  let active = false;
  let watchTimer = null;
  // The server startedAt we consider "current". We reload when the live server
  // reports a startedAt GREATER than this (a genuinely new process).
  let knownStartedAt = null;
  let sawDown = false;          // we observed the server unreachable during the gate
  let reloading = false;

  function rememberStartedAt(v) {
    if (Number.isFinite(v)) {
      // Track the highest we've seen so a late/cached response can't fool us.
      if (knownStartedAt === null || v > knownStartedAt) knownStartedAt = v;
    }
  }

  function isActive() { return active; }

  function show(reason, by) {
    if (active) { updateText(reason, by); return; }
    active = true;
    document.body.classList.add('sx-restarting');

    let panel = document.getElementById('sxRestartGate');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'sxRestartGate';
      panel.className = 'sx-gate';
      panel.setAttribute('role', 'alertdialog');
      panel.setAttribute('aria-live', 'assertive');
      // A full-screen roll-up "garage door": the door itself fills the viewport
      // and rolls smoothly down from above over ~3s, then stays. Ribbed slat
      // panels sell the storage-unit look; the content (loader + status) rides
      // in the centre of the door so it's covered too.
      panel.innerHTML = `
        <div class="sx-gate-door" aria-hidden="false">
          <div class="sx-gate-slats" aria-hidden="true"></div>
          <div class="sx-gate-rail sx-gate-rail-l" aria-hidden="true"></div>
          <div class="sx-gate-rail sx-gate-rail-r" aria-hidden="true"></div>
          <div class="sx-gate-content">
            <div class="sx-gate-loader" aria-hidden="true"><span></span><span></span><span></span></div>
            <div class="sx-gate-title">Server is restarting</div>
            <div class="sx-gate-sub" id="sxGateSub">Applying updates — hang tight.</div>
            <div class="sx-gate-meta mono" id="sxGateMeta"></div>
          </div>
          <div class="sx-gate-floor" aria-hidden="true"></div>
        </div>`;
      document.body.appendChild(panel);
    }
    updateText(reason, by);
    // roll the door down: force the drop animation to (re)play
    const door = panel.querySelector('.sx-gate-door');
    if (door) { door.classList.remove('drop'); void door.offsetWidth; door.classList.add('drop'); }

    // stop the normal data polling — nothing to refresh while we're going down
    if (typeof stopPolling === 'function') { try { stopPolling(); } catch (e) {} }
    startWatching();
  }

  function updateText(reason, by) {
    const sub = document.getElementById('sxGateSub');
    const meta = document.getElementById('sxGateMeta');
    if (sub) {
      sub.textContent = reason === 'scheduled'
        ? 'Scheduled maintenance restart — applying updates.'
        : 'Applying updates — hang tight.';
    }
    if (meta) meta.textContent = by ? ('triggered by ' + by) : '';
  }

  /* Begin the gate from a poll/health/status payload that says restarting:true. */
  function onRestartingPayload(p) {
    if (p && Number.isFinite(p.startedAt)) rememberStartedAt(p.startedAt);
    show(p && p.restartReason, p && p.restartBy);
  }

  function startWatching() {
    if (watchTimer) return;
    // Poll a touch faster than normal so the reload feels snappy once it's back.
    watchTimer = setInterval(tick, 1500);
    tick();
  }

  async function tick() {
    if (reloading) return;
    let s = null;
    try { s = await getRestartStatus(); }
    catch (e) {
      // Server unreachable -> it's mid-bounce (closing/exiting). Note it; when it
      // answers again it'll be the fresh process and we'll reload.
      sawDown = true;
      return;
    }
    if (!s || !Number.isFinite(s.startedAt)) return;

    // A new process: startedAt advanced beyond what we knew, OR the server is up
    // again after we saw it go down and it's no longer flagging a restart.
    const freshProcess = (knownStartedAt !== null && s.startedAt > knownStartedAt);
    const recovered = sawDown && !s.restarting;
    if (freshProcess || recovered) { hardReload(); return; }

    // Still the same (old) process winding down, or a new restart was just
    // announced before we'd recorded a baseline. Keep the gate up & text current.
    if (s.restarting) { rememberStartedAt(s.startedAt); updateText(s.restartReason, s.restartBy); }
    else if (knownStartedAt === null) { knownStartedAt = s.startedAt; }
  }

  function hardReload() {
    if (reloading) return;
    reloading = true;
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    const sub = document.getElementById('sxGateSub');
    if (sub) sub.textContent = 'Back online — reloading…';
    // small beat so the user sees "Back online" before the white flash of reload
    setTimeout(() => { try { location.reload(); } catch (e) { location.href = location.href; } }, 600);
  }

  /* Called once on boot: if a restart is already in progress, raise the gate so
     a fresh visitor sees it immediately instead of a broken/half-loaded app. */
  async function checkOnLoad() {
    let s = null;
    try { s = await getRestartStatus(); } catch (e) { return; }
    if (!s) return;
    knownStartedAt = Number.isFinite(s.startedAt) ? s.startedAt : knownStartedAt;
    if (s.restarting) onRestartingPayload(s);
  }

  return { show, onRestartingPayload, checkOnLoad, isActive, rememberStartedAt };
})();

/* ============================================================
   LIVE AUTO-UPDATE — poll the server; refresh quietly when safe
   ============================================================ */
let pollTimer = null;
let lastFilesRev = null, lastAccountsRev = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollTick, 10000);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } lastFilesRev = lastAccountsRev = null; }

/* ---------- active-time heartbeat (Analytics app) ----------
   Measures how long the workspace is actually IN USE — only counting time while the
   tab is visible AND focused, so a tab left open in the background doesn't inflate
   the number. Every ~60s of accumulated active time we emit one 'session' heartbeat
   carrying those seconds; the Analytics summary sums them into "time spent". This is
   the user's own private stat. Started once at boot; never tracks in share mode. */
const ActivityTracker = (() => {
  let lastTick = null, acc = 0, timer = null;
  const active = () => (typeof document === 'undefined') || (document.visibilityState !== 'hidden' && document.hasFocus());
  function tick() {
    const now = Date.now();
    if (lastTick != null && active()) acc += (now - lastTick) / 1000;
    lastTick = now;
    if (acc >= 60) { const s = Math.round(acc); acc = 0; if (typeof trackEvent === 'function') trackEvent('session', { seconds: s }); }
  }
  return {
    start() {
      if (timer || (typeof SHARE !== 'undefined' && SHARE.active)) return;
      lastTick = Date.now();
      timer = setInterval(tick, 15000);
      // when the tab is hidden, bank whatever active time we've accrued so it isn't lost
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { tick(); if (acc >= 5 && typeof trackEvent === 'function') { trackEvent('session', { seconds: Math.round(acc) }); acc = 0; } lastTick = null; } else lastTick = Date.now(); });
    },
  };
})();

/* ---------- NetWatch: connection-quality monitor + lag bar ----------
   Times a tiny GET /api/health every few seconds and classifies the round-trip:
     level 0 good · 1 lagging a bit · 2 lagging badly · 3 connection lost.
   Levels 1–3 show a closable bar at the bottom of the screen; closing it keeps it
   hidden unless the lag gets WORSE than the level it was closed at, and everything
   resets once the connection is good again. Other code (CoverLoader) reads
   NetWatch.level() to decide when it's safe to fetch full-res artwork.

   Escalation needs two agreeing samples in a row (one slow ping is noise);
   recovery is immediate. We never sample while the tab is hidden — background
   timer throttling inflates RTTs and would fake lag (the boot-guard watchdog
   false-positive lesson). */
const NetWatch = (() => {
  const GOOD_MS = 450, BAD_MS = 1200;        // rtt bands: <GOOD good, <BAD "a bit", else "badly"
  const PING_TIMEOUT = 6000;
  let timer = null, level = 0, prevCand = 0, fails = 0, dismissedAt = 0, lastMs = null;
  const BAR = [null,
    { cls: 'warn', text: `You're lagging a bit — things may load a little slowly. Closing other downloads or video streams usually helps.` },
    { cls: 'bad',  text: `You're lagging pretty badly — Simplex will keep your music playing and hold off on artwork. Moving closer to your router or switching networks may help.` },
    { cls: 'down', text: `Connection lost — trying to reconnect…` }];

  function renderBar() {
    let bar = document.getElementById('netBar');
    const show = level > 0 && level > dismissedAt;
    if (!show) { if (bar) bar.classList.remove('show'); return; }
    const fresh = !bar;
    if (fresh) {
      bar = document.createElement('div'); bar.id = 'netBar';
      bar.innerHTML = `<span class="netbar-dot"></span><span class="netbar-msg"></span><button class="netbar-x" title="Dismiss">${svg('close', 13)}</button>`;
      bar.querySelector('.netbar-x').onclick = () => { dismissedAt = level; renderBar(); };
      document.body.appendChild(bar);
    }
    bar.className = BAR[level].cls + (fresh ? '' : ' show');
    bar.querySelector('.netbar-msg').textContent = BAR[level].text;
    if (fresh) { const b = bar; requestAnimationFrame(() => b.classList.add('show')); }   // let the slide-up transition run
  }

  function setLevel(cand) {
    let next = level;
    if (cand < level) next = cand;                          // recovery: immediate
    else if (cand > level && prevCand >= cand) next = cand; // escalation: 2 samples agree
    prevCand = cand;
    if (next !== level) {
      level = next;
      if (level === 0) dismissedAt = 0;   // back to good — a future lag spell shows the bar again
      renderBar();
    }
  }

  async function sample() {
    if (document.hidden) return;                            // throttled timers fake lag
    if (typeof RestartGate !== 'undefined' && RestartGate.isActive()) return;   // gate owns "server down" UX
    if (navigator.onLine === false) { fails = 2; setLevel(3); return; }
    const ctl = new AbortController();
    const kill = setTimeout(() => ctl.abort(), PING_TIMEOUT);
    const t0 = performance.now();
    try {
      const r = await fetch('/api/health', { cache: 'no-store', signal: ctl.signal });
      lastMs = performance.now() - t0;
      if (!r.ok) throw new Error('bad status');
      fails = 0;
      setLevel(lastMs < GOOD_MS ? 0 : lastMs < BAD_MS ? 1 : 2);
    } catch (e) {
      lastMs = null; fails++;
      if (fails >= 2) { prevCand = 3; setLevel(3); }        // lost (bypass the 2-sample wait via prevCand)
      else setLevel(2);                                     // one blip: call it "lagging badly", not "lost"
    } finally { clearTimeout(kill); }
    // re-arm faster while degraded so recovery is noticed quickly
    if (timer) { clearInterval(timer); timer = setInterval(sample, level > 0 ? 2500 : 5000); }
  }

  return {
    start() {
      if (timer || (typeof SHARE !== 'undefined' && SHARE.active)) return;
      timer = setInterval(sample, 5000);
      window.addEventListener('offline', () => { fails = 2; prevCand = 3; setLevel(3); });
      window.addEventListener('online', () => { void sample(); });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) void sample(); });
      void sample();
    },
    level: () => level,
    ms: () => lastMs,
  };
})();

/* a "busy" UI we shouldn't yank data out from under: open viewer, modal, upload,
   active selection, or in-progress text edit */
function uiBusy() {
  return !!activeViewer || !!document.querySelector('.modal-bg') || UploadUI.active()
    || (selection && selection.size > 0) || !!document.querySelector('.editor-area:focus');
}
async function pollTick() {
  if (RestartGate.isActive()) return;   // gate is up & running its own watcher
  if (document.hidden) return;
  let p;
  try { p = await apiJSON('/api/poll'); }
  catch (e) {
    if (e.code === 'AUTH') { relock('your session ended — sign in again'); }
    // this account's vault is re-encrypting (started here or in another tab) —
    // raise the blurred progress gate; it reloads when the run completes
    else if (e.code === 'MIGRATING') { KeyGate.show(e.progress); }
    return;
  }
  // a restart was announced — raise the gate (it takes over from here)
  if (p && p.restarting) { RestartGate.onRestartingPayload(p); return; }
  if (p && Number.isFinite(p.startedAt)) RestartGate.rememberStartedAt(p.startedAt);
  // account changes (quota/display/admin) — keep local copy + visible chip fresh
  if (p.account) {
    const changed = !ACCOUNT || p.account.display !== ACCOUNT.display || p.account.is_admin !== ACCOUNT.is_admin || p.account.quota_bytes !== ACCOUNT.quota_bytes;
    ACCOUNT = p.account; setQuota(p.account.quota_bytes, p.used);
    if (changed) refreshAccountChips();
  }
  if (typeof p.notifUnread === 'number' && p.notifUnread !== _notifUnread) {
    const rose = p.notifUnread > _notifUnread;
    _notifUnread = p.notifUnread; updateNotifBadges();
    if (rose) maybeBrowserNotify();
  }
  if (lastFilesRev === null) { lastFilesRev = p.filesRev; lastAccountsRev = p.accountsRev; return; }
  lastAccountsRev = p.accountsRev;
  if (p.filesRev === lastFilesRev) return;          // nothing new
  // only the Database app renders the file list; other apps reload it on entry (openDatabase)
  if (currentApp !== 'database') return;
  if (uiBusy()) { renderStorage(); return; }        // user is busy — keep the meter fresh, retry next tick
  lastFilesRev = p.filesRev;                         // only advance once we actually apply the change
  try { await loadDB(); render(); } catch (e) { if (e.code === 'AUTH') relock(); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && ACCOUNT) pollTick(); });

/* share mode: a read-only public viewer scoped to one shared subtree, no lock */
async function bootShare() {
  SimplexBoot.stage('bootShare');
  document.body.classList.add('share-mode');
  document.getElementById('lock').classList.add('hidden');
  const shell = document.getElementById('shell');
  shell.classList.remove('hidden');
  requestAnimationFrame(() => shell.classList.add('show'));
  await loadDB();
  SimplexBoot.ready();   // share view resolved (valid or "link unavailable") — disarm watchdog
  if (SHARE.invalid) { renderShareInvalid(); return; }
  setupShareShell();
  if (SHARE.root && SHARE.root.type === 'folder') go('browse', { folder: SHARE.root.id });
  else if (SHARE.root) { go('browse', { folder: null }); openItem(SHARE.root.id); }
}
function setupShareShell() {
  const sidebar = document.querySelector('.sidebar');
  if (sidebar && !document.getElementById('shareNote')) {
    const note = document.createElement('div');
    note.id = 'shareNote'; note.className = 'share-note';
    note.innerHTML = `<span class="eyebrow">Shared with you</span>
      <div class="sn-name">${svg(SHARE.root ? SHARE.root.type : 'folder', 16, 1.7)}<span>${esc(SHARE.root ? SHARE.root.name : 'Shared')}</span></div>
      <div class="sn-sub mono">read-only${SHARE.allowDownload ? '' : ' · no downloads'}</div>`;
    const brand = sidebar.querySelector('.side-brand');
    brand ? brand.after(note) : sidebar.prepend(note);
  }
}
function renderShareInvalid() {
  document.getElementById('crumbs').innerHTML = `<span class="mono" style="color:var(--ink-faint);letter-spacing:.2em">SIMPLEX</span>`;
  document.getElementById('content').innerHTML = `<div class="empty" style="padding-top:120px">
    <div class="ico">${svg('link', 40, 1.4)}</div>
    <p>this link is no longer available</p>
  </div>`;
}

if (SHARE.active) bootShare().catch(e => { console.error('share boot failed', e); SimplexBoot.fatal(e); });

/* ============================================================
   REMOTE ASSISTANT — a small "where you are" AI that lives at the middle-top of
   every signed-in screen. Hover the bar to reveal an input; type + Enter spins up
   a floating, draggable, closeable chat window. It reuses the AI app's plumbing
   (streamAIChat, AI_TOOLS, the agentic tool loop) but keeps its own short-lived
   conversation, and it feeds the model a live snapshot of WHERE the user is —
   which app, which Database location, and which file (name + type) is open.
   Not shown in share mode (no account) — see mountRemoteAssistant().
   ============================================================ */
const RA = {
  mounted: false, open: false, messages: [], streaming: false, abort: null,
  streamIdx: -1, toolMsgIdx: -1, model: null, models: [], pos: null, drag: null,
};

/* Build the live context line(s) injected into the system prompt. Reads the same
   module state the rest of the app routes on, so it always matches the UI. */
function raContextText() {
  const app = APPS.find(a => a.id === currentApp);
  const lines = [];
  lines.push(`The user is in the "${app ? app.name : currentApp}" app.`);
  if (currentApp === 'database') {
    let where = 'Database home';
    if (state.view === 'browse') {
      const chain = state.folder ? pathOf(state.folder).map(f => f.name).join(' / ') : '';
      where = chain ? `the folder "${chain}"` : 'All files (Database root)';
    } else if (state.view === 'cat') {
      where = ({ video: 'the Films view', audio: 'the Music view', image: 'the Photos view', document: 'the Documents view', model3d: 'the 3D Models view', uasset: 'the Game Assets view' })[state.sub] || 'a category view';
    } else if (state.view === 'search') where = `search results for "${state.query}"`;
    else if (state.view === 'starred') where = 'Starred items';
    else if (state.view === 'trash') where = 'the Trash';
    lines.push(`They are looking at ${where}.`);
  }
  const f = (typeof _currentOpenFile !== 'undefined') ? _currentOpenFile : null;
  if (f) {
    const ext = (typeof fileExt === 'function' && fileExt(f.name)) || f.type;
    lines.push(`They currently have a file open: "${f.name}" (type: ${f.type}${ext && ext !== f.type ? ', ' + ext : ''}, ${typeof fmtSize === 'function' ? fmtSize(f.size) : f.size + ' bytes'}). You can read it with read_file using id ${f.id}.`);
  }
  return lines.join('\n');
}
function raSystemPrompt() {
  const base = [
    'You are Simplex Assistant, a helpful AI built into the user\'s private Simplex workspace.',
    'You help with their work in the workspace as well as general/personal questions.',
    '',
    'CURRENT CONTEXT (where the user is right now):',
    raContextText(),
    '',
    'Use this context to make your answers relevant — e.g. if they ask "summarize this", they likely mean the open file. Do not mention the context unless it is useful.',
  ].join('\n');
  // tools available? append the same tool protocol the AI app uses
  return RA.toolsOn === false ? base : base + '\n\n' + aiToolsSystemPrompt();
}

/* ---------- the bar (collapsed pill -> hover/focus reveals input) ---------- */
function mountRemoteAssistant() {
  if (RA.mounted || SHARE.active || !ACCOUNT) return;
  if (!(ACCOUNT && ACCOUNT.can_ai)) return;   // respect the per-account AI gate
  RA.toolsOn = localStorage.getItem('simplex.ai.tools') !== 'off';
  const bar = document.createElement('div');
  bar.id = 'raBar';
  bar.className = 'ra-bar';
  bar.innerHTML = `
    <button class="ra-pill" id="raPill" title="Ask the assistant" aria-label="Ask the assistant">
      ${svg('spark', 16, 1.5)}<span class="ra-pill-label">Ask</span>
    </button>
    <form class="ra-quick" id="raQuick" autocomplete="off">
      <span class="ra-q-spark">${svg('spark', 15, 1.5)}</span>
      <input class="ra-q-input" id="raQuickInput" placeholder="Ask about your work or anything…" />
      <button type="submit" class="ra-q-send" title="Open chat" aria-label="Send">${svg('send', 15)}</button>
    </form>`;
  document.body.appendChild(bar);
  const form = bar.querySelector('#raQuick');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const inp = bar.querySelector('#raQuickInput');
    const text = (inp.value || '').trim();
    inp.value = '';
    raOpenWindow(text || null);
  });
  // clicking the pill also opens the (empty) window
  bar.querySelector('#raPill').addEventListener('click', () => { if (!RA.open) raOpenWindow(null); else raFocusWindow(); });
  RA.mounted = true;
}
function unmountRemoteAssistant() {
  raCloseWindow();
  const bar = document.getElementById('raBar'); if (bar) bar.remove();
  RA.mounted = false;
}

/* ---------- the floating chat window ---------- */
async function raOpenWindow(initialText) {
  if (RA.open) { raFocusWindow(); if (initialText) raSubmit(initialText); return; }
  RA.open = true;
  // lazily load the model list (shared endpoint with the AI app)
  if (!RA.models.length) { try { const m = await aiModels(); RA.models = m.models || []; } catch (e) { RA.models = []; } }
  if (!RA.models.length) { toast('No AI providers configured', 'close'); RA.open = false; return; }
  if (!RA.model || !RA.models.find(m => m.id === RA.model)) RA.model = RA.models[0].id;

  const win = document.createElement('div');
  win.id = 'raWin';
  win.className = 'ra-win';
  const start = RA.pos || { left: Math.max(20, (window.innerWidth - 420) / 2), top: 84 };
  win.style.left = start.left + 'px';
  win.style.top = start.top + 'px';
  win.innerHTML = `
    <div class="ra-win-head" id="raHead">
      <span class="ra-win-title">${svg('spark', 14, 1.5)} Assistant</span>
      <span class="ra-win-ctx mono" id="raCtx" title="What the assistant can see"></span>
      <span class="spacer"></span>
      <select class="ra-win-model set-select" id="raModel">${RA.models.map(m => `<option value="${esc(m.id)}" ${m.id === RA.model ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      <button class="ic-btn ${RA.toolsOn ? 'on' : ''}" id="raTools" title="Tools ${RA.toolsOn ? 'on' : 'off'}">${svg('wrench', 14)}</button>
      <button class="ic-btn" id="raClear" title="New conversation">${svg('plus', 15)}</button>
      <button class="ic-btn" id="raClose" title="Close">${svg('close', 15)}</button>
    </div>
    <div class="ra-win-body" id="raBody"></div>
    <form class="ra-win-composer" id="raComposer">
      <textarea class="ra-win-input" id="raInput" rows="1" placeholder="Message the assistant…  (Enter to send)"></textarea>
      <button type="submit" class="btn primary ra-win-send" id="raSend" title="Send">${svg('send', 15)}</button>
      <button type="button" class="btn ghost ra-win-stop hidden" id="raStopBtn" title="Stop">${svg('stop', 15)}</button>
    </form>`;
  document.body.appendChild(win);

  win.querySelector('#raModel').onchange = e => { RA.model = e.target.value; };
  win.querySelector('#raClose').onclick = raCloseWindow;
  win.querySelector('#raClear').onclick = () => { if (RA.streaming) raStop(); RA.messages = []; raRenderBody(); raFocusWindow(); };
  win.querySelector('#raTools').onclick = () => {
    RA.toolsOn = !RA.toolsOn; localStorage.setItem('simplex.ai.tools', RA.toolsOn ? 'on' : 'off');
    win.querySelector('#raTools').classList.toggle('on', RA.toolsOn);
    win.querySelector('#raTools').title = 'Tools ' + (RA.toolsOn ? 'on' : 'off');
    toast(RA.toolsOn ? 'Tools enabled' : 'Tools disabled', RA.toolsOn ? 'check' : 'close');
  };
  win.querySelector('#raStopBtn').onclick = raStop;
  const input = win.querySelector('#raInput');
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); win.querySelector('#raComposer').requestSubmit(); } });
  win.querySelector('#raComposer').addEventListener('submit', e => { e.preventDefault(); const t = (input.value || '').trim(); if (!t) return; input.value = ''; input.style.height = 'auto'; raSubmit(t); });

  raMakeDraggable(win.querySelector('#raHead'), win);
  raUpdateCtxChip();
  raRenderBody();
  raFocusWindow();
  if (initialText) raSubmit(initialText);
}
function raCloseWindow() {
  if (RA.streaming) raStop();
  const win = document.getElementById('raWin');
  if (win) { RA.pos = { left: parseInt(win.style.left, 10) || 0, top: parseInt(win.style.top, 10) || 0 }; win.remove(); }
  RA.open = false;
}
function raFocusWindow() { const i = document.getElementById('raInput'); if (i) i.focus(); }
function raUpdateCtxChip() {
  const c = document.getElementById('raCtx'); if (!c) return;
  const f = (typeof _currentOpenFile !== 'undefined') ? _currentOpenFile : null;
  const app = APPS.find(a => a.id === currentApp);
  c.textContent = f ? `sees: ${f.name}` : `sees: ${app ? app.name : currentApp}`;
}

/* drag the window by its header. Keeps it on-screen; persists position in RA.pos. */
function raMakeDraggable(handle, win) {
  handle.addEventListener('pointerdown', e => {
    if (e.target.closest('button, select')) return;   // controls aren't drag handles
    const r = win.getBoundingClientRect();
    RA.drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
  });
  handle.addEventListener('pointermove', e => {
    if (!RA.drag) return;
    const w = win.offsetWidth, h = win.offsetHeight;
    let left = e.clientX - RA.drag.dx, top = e.clientY - RA.drag.dy;
    left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
    top = Math.max(6, Math.min(top, window.innerHeight - h - 6));
    win.style.left = left + 'px'; win.style.top = top + 'px';
  });
  const end = e => { if (RA.drag) { RA.drag = null; handle.classList.remove('dragging'); try { handle.releasePointerCapture(e.pointerId); } catch (_) {} } };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/* ---------- transcript render (mirrors the AI app's message rendering) ---------- */
function raRenderBody() {
  const body = document.getElementById('raBody'); if (!body) return;
  if (!RA.messages.length) {
    body.innerHTML = `<div class="ra-welcome dim">
      <div class="ra-w-spark">${svg('spark', 26, 1.4)}</div>
      <p>Ask me anything about your work — or anything at all.<br><span class="mono">I can see where you are and what file you have open.</span></p>
    </div>`;
    return;
  }
  body.innerHTML = RA.messages.map((m, i) => raMsgHTML(m, i)).join('');
  body.querySelectorAll('.ai-tchip').forEach(c => c.onclick = () => c.classList.toggle('open'));
  body.scrollTop = body.scrollHeight;
}
function raMsgHTML(m, i) {
  if (m.role === 'user') {
    if (m.toolResult) return '';
    return `<div class="ra-msg me"><div class="ra-bub">${esc(m.content)}</div></div>`;
  }
  const streaming = (i === RA.streamIdx);
  const prose = streaming ? streamingProse(m.content || '') : stripToolBlocks(m.content || '');
  const inner = prose.trim() ? mdToHtml(prose) : (streaming ? '<span class="ai-thinking">Working…</span>' : '');
  const bubble = (prose.trim() || streaming) ? `<div class="ra-msg ai"><div class="ra-bub md">${inner}</div></div>` : '';
  const tools = (m.tools && m.tools.length) ? `<div class="ra-tools">${m.tools.map(toolChipHTML).join('')}</div>` : '';
  return bubble + tools;
}
function raStreamUpdate(text) {
  if (RA.streamIdx < 0) return;
  raRenderBody();   // simple + correct; transcripts here are short
}

/* ---------- send + agentic loop (same protocol as aiRunTurn) ---------- */
function raSetStreaming(on) {
  RA.streaming = on;
  const s = document.getElementById('raSend'), st = document.getElementById('raStopBtn'), inp = document.getElementById('raInput');
  if (s) s.classList.toggle('hidden', on);
  if (st) st.classList.toggle('hidden', !on);
  if (inp) inp.disabled = on;
}
function raStop() { if (RA.abort) { try { RA.abort.abort(); } catch (e) {} RA.abort = null; } RA.streamIdx = -1; raSetStreaming(false); }
function raProviderMessages(beforeIdx) { return RA.messages.slice(0, beforeIdx).map(m => ({ role: m.role, content: m.content || '' })); }

async function raSubmit(text) {
  if (RA.streaming || !RA.open) return;
  if (!RA.model) { toast('No model available', 'close'); return; }
  RA.messages.push({ role: 'user', content: text });
  raRenderBody();
  raSetStreaming(true);
  RA.abort = new AbortController();
  // snapshot the system prompt at send time so the context reflects where they were
  const sys = raSystemPrompt();
  try {
    for (let step = 0; step < AI_MAX_STEPS; step++) {
      const idx = RA.messages.push({ role: 'assistant', content: '' }) - 1;
      RA.streamIdx = idx; raRenderBody();
      let acc = '', errored = null;
      try {
        await streamAIChat({
          model: RA.model, messages: raProviderMessages(idx), system: sys, signal: RA.abort.signal,
          onText: t => { acc += t; RA.messages[idx].content = acc; raStreamUpdate(acc); },
          onError: msg => { errored = msg; },
        });
      } catch (e) {
        if (e.name === 'AbortError') { RA.messages[idx].content = stripToolBlocks(acc) || '_(stopped)_'; break; }
        errored = e.message || 'request failed';
      }
      if (errored) { RA.messages[idx].content = (stripToolBlocks(acc) ? stripToolBlocks(acc) + '\n\n' : '') + '⚠️ ' + errored; break; }
      const calls = RA.toolsOn ? parseToolCalls(acc) : [];
      if (!calls.length) { if (!acc) RA.messages[idx].content = '_(no response)_'; RA.streamIdx = -1; raRenderBody(); break; }
      // run the tools, then feed results back as a hidden user turn
      RA.streamIdx = -1; RA.toolMsgIdx = idx;
      RA.messages[idx].tools = calls.map(c => ({ name: c.tool, args: c.args, status: 'running' }));
      raRenderBody();
      const results = [];
      for (let k = 0; k < calls.length; k++) {
        const c = calls[k]; let out;
        try {
          const tool = AI_TOOLS[c.tool];
          if (!tool) throw new Error('unknown tool "' + c.tool + '"');
          out = await tool.run(c.args || {});
          RA.messages[idx].tools[k].status = 'done';
        } catch (e) { out = 'Error: ' + (e.message || 'tool failed'); RA.messages[idx].tools[k].status = 'error'; }
        RA.messages[idx].tools[k].result = String(out);
        results.push(`[${c.tool}] ${String(out).slice(0, 6000)}`);
        raRenderBody();
      }
      RA.messages.push({ role: 'user', content: 'TOOL_RESULTS\n' + results.join('\n\n'), toolResult: true });
    }
  } catch (e) { /* per-step handled above */ }
  RA.streamIdx = -1; raSetStreaming(false); RA.abort = null;
  raRenderBody();
}


/* Raise libuv's thread pool BEFORE anything uses it (fs/crypto/dns run on this
   pool). The default is 4 — far too small for a media server doing concurrent
   ENCRYPTED streaming: each /raw range request's file reads occupy pool threads.
   With AES-CTR decryption being CPU/IO bound, we need a LARGE pool to avoid
   starving the event loop. Setting this here takes effect because the pool
   hasn't initialized yet at the top of the entry module.

   64 threads can still be exhausted by many concurrent audio streams. Better
   to have 256+ and let the OS scheduler handle it than to block the event loop. */
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '256';

/* ============================================================
   SIMPLEX — self-hosted backend (multi-account, encrypted at rest)
   Express 5 + multer + better-sqlite3.
   - System DB (vault/system.sqlite): accounts, settings, shares.
   - Per-account vault: vault/accounts/<id>/simplex.sqlite + files/<id>.enc.
   - Blobs: double AES-256-CTR (seekable). Text fields: double AES-256-GCM +
     base64. Keys live only on the server (crypto.js).
   - ALL blob streaming goes through stream.pipeline so an aborted request
     (e.g. a video seek) tears the whole chain down — no leaked file
     descriptors. (Leaked fds on aborted range reads are what made the old
     server eventually wedge: it would stop accepting connections while still
     showing as "running".)
   ============================================================ */
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const os = require('os');
const { pipeline } = require('stream');
const { spawn } = require('child_process');   // spawnSync intentionally NOT used — it blocks the event loop (see probeProcess)
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const vault = require('./crypto');
const unzip = require('./unzip');
const peicon = require('./peicon');   // extract embedded icons from Windows .exe/.dll (PE resources)
const { neuralCompute } = require('./neural-engine');   // Neural Network app: backend compute (gated)
const NeuralEngine = require('./neural-engine');        // organizer classifier (AI Organization feature)
const TradingEngine = require('./trading-engine');      // Trading app: global always-training signal model + paper sim
const localAI = require('./engine/llama-engine');       // Local AI: bundled llama.cpp GGUF inference (no external apps)
const DiscordBot = require('./discord-bot');            // Discord Bot app: voice assistant engine (admin-only)

const ROOT = __dirname;
// SIMPLEX_VAULT_DIR: run against an alternate vault (isolated testing/staging)
const VAULT_DIR = process.env.SIMPLEX_VAULT_DIR ? path.resolve(process.env.SIMPLEX_VAULT_DIR) : path.join(ROOT, 'vault');
const ACCOUNTS_DIR = path.join(VAULT_DIR, 'accounts');
const RUN_DIR = path.join(VAULT_DIR, 'run');                       // throwaway Code-app run sandboxes
const TOOLS_DIR = path.join(VAULT_DIR, 'tools');                   // throwaway Tools-app ffmpeg jobs
const SYSTEM_DB_PATH = path.join(VAULT_DIR, 'system.sqlite');
const LEGACY_DB_PATH = path.join(VAULT_DIR, 'simplex.sqlite');     // pre-accounts single vault
const PORT = process.env.PORT || 3824;
const DEFAULT_QUOTA = 200 * 1e9;                                   // 200 GB per account
const ADMIN_DEFAULT_PASSWORD = '1234';

fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });

/* wipe any Code-app run sandboxes left over from a previous process (a crash
   could orphan a run dir + its child). Each run gets a fresh dir under RUN_DIR. */
(function wipeRunDir() {
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(RUN_DIR, { recursive: true });
  try { fs.rmSync(TOOLS_DIR, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
})();

/* one-time cleanup: the pre-accounts server kept partial uploads in a shared
   vault/tmp. Per-account uploads now live under accounts/<id>/tmp, so wipe the
   legacy dir on boot — no plaintext upload scraps should linger in the vault. */
(function wipeLegacyTmp() {
  const legacyTmp = path.join(VAULT_DIR, 'tmp');
  try {
    if (fs.existsSync(legacyTmp)) {
      for (const f of fs.readdirSync(legacyTmp)) { try { fs.rmSync(path.join(legacyTmp, f), { recursive: true, force: true }); } catch (e) {} }
    }
  } catch (e) {}
})();

/* ---------- master key + per-account keyring ---------- */
const MASTER_KEY = vault.loadMasterKey(VAULT_DIR);
const keyring = vault.makeKeyring(MASTER_KEY);

/* ---------- per-user keys (v2): RAM-resident UDK cache ----------
   The unwrapped User Data Key lives ONLY here, keyed by account id, from the
   moment the owner signs in until the process exits. Nothing on disk can
   produce it without the owner's password (or recovery code) — that is the
   whole point: a stolen master key + disk reads v1 (legacy) data only.
   Consequences we accept on purpose:
   - after a restart, an enrolled account's session must sign in again (the
     requireAuth gate returns 401 until the UDK is back);
   - share links / API keys serving v2 data sleep until the owner signs in. */
const UDK_KEYS = new Map();    // accountId -> { ctr1, ctr2, txt1, txt2 } (v2 subkeys)
const UDK_RAW = new Map();     // accountId -> Buffer(32) — kept for re-wrapping (swap / recovery)
function cacheUdk(accountId, udk) { UDK_RAW.set(accountId, udk); UDK_KEYS.set(accountId, vault.udkSubkeys(udk)); }
function udkResident(accountId) { return UDK_KEYS.has(accountId); }

function persistEnrollment(accountId, kekSalt, wrapPw, rcSalt, wrapRc, rcEnc) {
  sys.prepare('UPDATE accounts SET key_enrolled = ?, key_kek_salt = ?, key_wrap_pw = ?, key_rc_salt = ?, key_wrap_rc = ?, key_rc_enc = ?, key_wrap_stale = 0 WHERE id = ?')
    .run(Date.now(), kekSalt, wrapPw, rcSalt, wrapRc, rcEnc, accountId);
}
function persistPwWrap(accountId, kekSalt, wrapPw) {
  sys.prepare('UPDATE accounts SET key_kek_salt = ?, key_wrap_pw = ?, key_wrap_stale = 0 WHERE id = ?')
    .run(kekSalt, wrapPw, accountId);
}
function persistRcWrap(accountId, rcSalt, wrapRc, rcEnc) {
  sys.prepare('UPDATE accounts SET key_rc_salt = ?, key_wrap_rc = ?, key_rc_enc = ? WHERE id = ?').run(rcSalt, wrapRc, rcEnc, accountId);
}
/* keys for sealing the recovery-key plaintext under the UDK (so "View key" in
   Settings can show it back — only while the owner's UDK is resident) */
function rcViewKeys(udk) {
  return { txt1: vault.hkdf(udk, 'simplex.udk.rcview.1'), txt2: vault.hkdf(udk, 'simplex.udk.rcview.2') };
}
function markWrapStale(accountId) {
  try { sys.prepare('UPDATE accounts SET key_wrap_stale = 1 WHERE id = ? AND key_enrolled != 0').run(accountId); } catch (e) {}
}

/* Runs during sign-in, with the (verified) plaintext password in hand.
   - Not yet enrolled: mint a UDK + recovery code, wrap under password + code,
     persist, cache. Returns { enrolled: true, recoveryCode } — the code is
     shown to the user ONCE and never stored in plaintext.
   - Enrolled: derive the KEK, unwrap, cache. A failed unwrap means the wrap
     rides an older password (admin reset / unswapped change) — returns
     { locked: true } so the client can offer previous-password / recovery.
   crypto.scrypt is async; nothing here blocks the event loop. */
async function prepareUserKeys(account, password) {
  const id = account.id;
  if (!account.key_enrolled) {
    const udk = crypto.randomBytes(32);
    const kekSalt = crypto.randomBytes(16);
    const kek = await vault.deriveKek(password, kekSalt, MASTER_KEY, id);
    // The recovery key is minted SILENTLY: the user is never shown it at
    // enrollment. It's sealed under the UDK so Settings → "View key" can
    // reveal it later to a signed-in owner who explicitly asks.
    const recoveryCode = vault.makeRecoveryCode();
    const rcSalt = crypto.randomBytes(16);
    const rcKek = await vault.deriveKek(vault.normRecoveryCode(recoveryCode), rcSalt, MASTER_KEY, id);
    persistEnrollment(id, kekSalt, vault.wrapKey(kek, udk), rcSalt, vault.wrapKey(rcKek, udk),
      vault.encText(recoveryCode, rcViewKeys(udk)));
    cacheUdk(id, udk);
    console.log(`[simplex] enrolled per-user keys for account ${account.username}`);
    return { enrolled: true };
  }
  if (udkResident(id)) return { ok: true, stale: !!account.key_wrap_stale };
  const kek = await vault.deriveKek(password, account.key_kek_salt, MASTER_KEY, id);
  const udk = vault.unwrapKey(kek, account.key_wrap_pw);
  if (!udk) return { locked: true };   // wrap rides an older password
  cacheUdk(id, udk);
  return { ok: true, stale: !!account.key_wrap_stale };
}

/* ---------- vault re-encryption (the "lockdown" migration) ----------
   User-initiated bulk upgrade of every legacy (kv=1) row to v2 keys. While it
   runs, the account's API is held at 423 (except /api/keys/*) and the client
   shows a blurred progress screen. Each file is upgraded atomically (write
   .rekey, rename over), so a crash mid-run leaves a clean mix of v1/v2 rows
   and the user simply runs it again. */
const KEY_MIG = new Map();   // accountId -> { phase, total, done, bytesTotal, bytesDone, cur, errors, startedAt }
function keyMigProgress(accountId) {
  const m = KEY_MIG.get(accountId);
  if (!m) return null;
  return { phase: m.phase, total: m.total, done: m.done, bytesTotal: m.bytesTotal, bytesDone: m.bytesDone, cur: m.cur, errors: m.errors.length, startedAt: m.startedAt };
}

/* Replace `to` with `from`, retrying on Windows sharing violations. A freshly
   written file (or the rename target) can be held open for a moment by
   real-time antivirus scanning .enc blobs — this server's AV has done exactly
   that before (see the readBlobHeader stall) — and the rename fails EPERM even
   though nothing is actually wrong. A few backoff retries (~3s worst case)
   outlast any scan; async so the event loop keeps breathing. */
async function replaceFileWithRetry(from, to, tries = 5) {
  let delay = 120;
  for (let i = 0; ; i++) {
    try { await fsp.rename(from, to); return; }
    catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || i >= tries - 1) throw e;
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(Math.round(delay * 2.5), 2000);
    }
  }
}

/* upgrade ONE files-table row: blob + cover re-encrypted streaming (user data),
   regenerable derivatives dropped, text fields rewritten, kv stamped 2. */
async function reencryptRow(store, row) {
  for (const p of [row.hasBlob ? store.blobPath(row) : null, row.hasCover ? store.coverPath(row) : null]) {
    if (!p || !fs.existsSync(p)) continue;
    const head = await vault.readBlobHeaderAsync(p);
    if (!head || head.ver !== 1) continue;               // already v2 (or unreadable — leave as-is)
    const tmp = p + '.rekey';
    try {
      await vault.reencryptBlob(p, tmp, store.keys);
      await replaceFileWithRetry(tmp, p);                // atomic replace (MoveFileEx semantics on Windows)
    } catch (e) {
      // nothing committed — the original .enc is untouched. Drop the temp so
      // failed attempts never litter the files dir.
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
      throw e;
    }
  }
  // posters / PE icons / low-res covers are derived caches — drop v1 copies and
  // clear their flags so the endpoints regenerate them under v2 on next request
  const flagResets = [];
  for (const [p, flag] of [[store.posterPath(row), 'hasPoster'], [store.iconPath(row), 'hasIcon'], [store.coverSmPath(row), null]]) {
    try {
      if (fs.existsSync(p)) {
        const h = await vault.readBlobHeaderAsync(p);
        if (h && h.ver === 1) { fs.unlinkSync(p); if (flag && row[flag] === 1) flagResets.push(`${flag} = 0`); }
      }
    } catch (e) {}
  }
  if (flagResets.length) store.db.prepare(`UPDATE files SET ${flagResets.join(', ')} WHERE id = ?`).run(row.id);
  // text fields: only values still carrying the v1 marker are rewritten
  const sets = [], vals = {};
  for (const c of TEXT_COLS) {
    if (row[c] != null && vault.textVer(row[c]) === 1) {
      sets.push(`${c} = @${c}`);
      vals[c] = vault.encText(vault.decText(row[c], store.keys), store.keys);
    }
  }
  vals.id = row.id;
  store.db.prepare(`UPDATE files SET ${sets.concat('kv = 2').join(', ')} WHERE id = @id`).run(vals);
}

/* rewrite the text-only tables (notes, code, chats, neural networks, trading,
   tags) from v1 to v2 markers. Row-at-a-time with yields — network weights and
   chat logs can be sizable, and the event loop must keep breathing. */
async function reencryptTextTables(store) {
  const db = store.db, keys = store.keys;
  const tables = [
    ['notes', 'id', ['title', 'body']],
    ['code', 'id', ['name', 'content']],
    ['chats', 'id', ['title', 'messages']],
    ['networks', 'id', ['name', 'data']],
    ['visual_projects', 'id', ['name', 'data']],
    ['trading_account', 'id', ['data']],
    ['tags', 'id', ['name']],
  ];
  for (const [table, idCol, cols] of tables) {
    let rows;
    try { rows = db.prepare(`SELECT * FROM ${table}`).all(); } catch (e) { continue; }
    let n = 0;
    for (const row of rows) {
      const sets = [], vals = {};
      for (const c of cols) {
        if (row[c] != null && vault.textVer(row[c]) === 1) {
          sets.push(`${c} = @${c}`);
          vals[c] = vault.encText(vault.decText(row[c], keys), keys);
        }
      }
      if (sets.length) {
        vals.__id = row[idCol];
        db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${idCol} = @__id`).run(vals);
      }
      if (++n % 25 === 0) await new Promise(r => setImmediate(r));
    }
    await new Promise(r => setImmediate(r));
  }
}

async function runVaultReencrypt(store, accountId) {
  const m = KEY_MIG.get(accountId);
  try {
    m.phase = 'text';
    await reencryptTextTables(store);
    m.phase = 'files';
    const rows = store.st.all.all().filter(r => (r.kv || 1) === 1);
    for (const row of rows) {
      try { m.cur = vault.decText(row.name, store.keys); } catch (e) { m.cur = null; }
      try {
        await reencryptRow(store, row);
      } catch (e) {
        m.errors.push({ id: row.id, msg: String(e && e.message || e) });
      }
      m.done++; m.bytesDone += row.size || 0;
      await new Promise(r => setImmediate(r));   // yield between files — never starve the loop
    }
    m.phase = 'done';
  } catch (e) {
    m.phase = 'done';
    m.errors.push({ msg: String(e && e.message || e) });
  } finally {
    m.cur = null; m.finishedAt = Date.now();
    try { store.bump(); } catch (e) {}
    console.log(`[simplex] vault re-encryption for ${accountId}: ${m.done}/${m.total} rows, ${m.errors.length} error(s)`);
    // linger briefly so the polling client sees phase:'done', then lift the gate
    setTimeout(() => { if (KEY_MIG.get(accountId) === m) KEY_MIG.delete(accountId); }, 15_000).unref();
  }
}

/* ---------- column model (per-account files table) ---------- */
const COLS = ['id', 'name', 'type', 'parent', 'size', 'date', 'trashed', 'starred',
  'content', 'lang', 'dur', 'w', 'h', 'artist', 'album', 'locked', 'lockSpec', 'hasBlob', 'storedExt',
  'hasCover', 'coverExt', 'tags', 'kv'];
const TEXT_COLS = ['name', 'content', 'artist', 'album', 'lockSpec'];   // encrypted at rest

const FILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, parent TEXT,
  size INTEGER NOT NULL DEFAULT 0, date INTEGER NOT NULL,
  trashed INTEGER NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0,
  content TEXT, lang TEXT, dur REAL, w INTEGER, h INTEGER, artist TEXT, album TEXT,
  locked INTEGER NOT NULL DEFAULT 0, lockSpec TEXT,
  hasBlob INTEGER NOT NULL DEFAULT 0, storedExt TEXT,
  hasCover INTEGER NOT NULL DEFAULT 0, coverExt TEXT,
  tags TEXT,
  kv INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent);
CREATE INDEX IF NOT EXISTS idx_files_type   ON files(type);
`;

function rowForInsert(o) {
  return {
    id: o.id, name: o.name, type: o.type, parent: o.parent ?? null,
    size: o.size ?? 0, date: o.date ?? Date.now(),
    trashed: o.trashed ? 1 : 0, starred: o.starred ? 1 : 0,
    content: o.content ?? null, lang: o.lang ?? null, dur: o.dur ?? null,
    w: o.w ?? null, h: o.h ?? null, artist: o.artist ?? null, album: o.album ?? null,
    locked: o.locked ? 1 : 0, lockSpec: o.lockSpec ?? null,
    hasBlob: o.hasBlob ? 1 : 0, storedExt: o.storedExt ?? null,
    hasCover: o.hasCover ? 1 : 0, coverExt: o.coverExt ?? null,
    // tags: JSON array of tag ids (opaque references — not sensitive plaintext, so
    // stored unencrypted; the tag NAMES/COLORS live encrypted in the tags table).
    tags: o.tags == null ? null : (typeof o.tags === 'string' ? o.tags : JSON.stringify(o.tags)),
    // key generation this row's artifacts were written under (1 = master-derived
    // legacy, 2 = per-user UDK). Existing rows keep the DEFAULT 1.
    kv: o.kv ?? 1,
  };
}

/* a tag color must be a #rgb/#rrggbb hex (or null) — reject anything else so a
   color value can be dropped straight into CSS without escaping. */
function normTagColor(c) {
  if (c == null) return null;
  const s = String(c).trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s.toLowerCase() : null;
}

/* ---------- ids ---------- */
function uid() { return 'f' + crypto.randomBytes(6).toString('hex'); }
function aid() { return 'a' + crypto.randomBytes(6).toString('hex'); }

/* ---------- live-update revisions ----------
   Bumped on any mutation; the client polls /api/poll and refreshes when these
   change. accountsRev is global (account list/quotas); each store has its own
   filesRev. */
let accountsRev = 1;
function bumpAccounts() { accountsRev++; }

/* ============================================================
   SYSTEM DB — accounts / settings / shares
   ============================================================ */
const sys = new Database(SYSTEM_DB_PATH);
sys.pragma('journal_mode = WAL');
sys.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display TEXT,
  pw_salt BLOB NOT NULL, pw_hash BLOB NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  quota_bytes INTEGER NOT NULL DEFAULT ${DEFAULT_QUOTA},
  avatar_color TEXT, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT );
CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY, account_id TEXT NOT NULL, file_id TEXT NOT NULL,
  created INTEGER NOT NULL, allow_download INTEGER NOT NULL DEFAULT 1,
  slug TEXT
);
CREATE INDEX IF NOT EXISTS idx_shares_acct ON shares(account_id);
`);
// custom slug: a friendly alias usable in place of the random token (both /s/<slug>
// and /r/<slug>.<ext> resolve). Older share tables predate the column — add it, THEN
// the unique partial index (creating the index before the column exists would throw,
// which is exactly the boot crash we're avoiding here).
try {
  const cols = new Set(sys.prepare('PRAGMA table_info(shares)').all().map(c => c.name));
  if (!cols.has('slug')) sys.exec('ALTER TABLE shares ADD COLUMN slug TEXT');
  sys.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_slug ON shares(slug) WHERE slug IS NOT NULL');
} catch (e) { console.warn('[simplex] shares.slug migration:', e && e.message); }
/* additive account columns (theme prefs JSON + per-account app permissions) */
{
  const have = new Set(sys.prepare('PRAGMA table_info(accounts)').all().map(c => c.name));
  if (!have.has('prefs')) sys.exec('ALTER TABLE accounts ADD COLUMN prefs TEXT');
  if (!have.has('can_code')) sys.exec('ALTER TABLE accounts ADD COLUMN can_code INTEGER NOT NULL DEFAULT 0');
  if (!have.has('can_ai')) sys.exec('ALTER TABLE accounts ADD COLUMN can_ai INTEGER NOT NULL DEFAULT 0');
  // Lets a member run Neural Network models on the SERVER (backend compute) instead
  // of only in their own browser. Off by default — backend compute uses the box's
  // CPU, so it's admin-granted per account. Client compute is always available.
  if (!have.has('can_neural_backend')) sys.exec('ALTER TABLE accounts ADD COLUMN can_neural_backend INTEGER NOT NULL DEFAULT 0');
  // Highest AI-Organization tier this account may select ('small' | 'medium' | 'high').
  // Bigger tiers use a wider/deeper network and read more of each file's bytes — more
  // accurate but more CPU/I-O — so the CEILING is admin-granted. Default 'medium' (so
  // Small + Medium are available to everyone); admins can raise an account to 'high'.
  if (!have.has('org_max_tier')) sys.exec("ALTER TABLE accounts ADD COLUMN org_max_tier TEXT NOT NULL DEFAULT 'medium'");
  // Per-account login-security tier ('minimal' | 'limited' | 'locked'). The TYPED
  // username at the login screen selects which policy applies to the requesting IP;
  // see the ip_bans table + tiered /api/login below. Default 'minimal' (today's
  // lenient throttle) so existing accounts behave exactly as before until changed.
  if (!have.has('security_tier')) sys.exec("ALTER TABLE accounts ADD COLUMN security_tier TEXT NOT NULL DEFAULT 'minimal'");
  // ---- Safety update: recovery email, safety level, TOTP two-auth ----
  // safety: 'minimal' (password) | 'moderate' (+email) | 'maximum' (+two-auth).
  // totp_secret = ACTIVE base32 secret (two-auth on); totp_pending = a secret
  // mid-setup (QR shown, not yet code-verified + captcha'd) — never active.
  if (!have.has('email')) sys.exec('ALTER TABLE accounts ADD COLUMN email TEXT');
  if (!have.has('safety')) sys.exec("ALTER TABLE accounts ADD COLUMN safety TEXT NOT NULL DEFAULT 'minimal'");
  if (!have.has('totp_secret')) sys.exec('ALTER TABLE accounts ADD COLUMN totp_secret TEXT');
  if (!have.has('totp_pending')) sys.exec('ALTER TABLE accounts ADD COLUMN totp_pending TEXT');
  // ---- Per-user keys (v2): the User Data Key exists at rest ONLY wrapped.
  // key_wrap_pw   = AES-GCM(KEK(password),      UDK)  — the everyday wrap
  // key_wrap_rc   = AES-GCM(KEK(recovery code), UDK)  — break-glass wrap
  // key_wrap_stale = 1 when the password changed but the wrap still rides the
  // OLD password (per policy the user swaps it manually; login offers unlock
  // via previous password or recovery code, then rewraps).
  if (!have.has('key_enrolled')) sys.exec('ALTER TABLE accounts ADD COLUMN key_enrolled INTEGER NOT NULL DEFAULT 0');
  if (!have.has('key_kek_salt')) sys.exec('ALTER TABLE accounts ADD COLUMN key_kek_salt BLOB');
  if (!have.has('key_wrap_pw')) sys.exec('ALTER TABLE accounts ADD COLUMN key_wrap_pw BLOB');
  if (!have.has('key_rc_salt')) sys.exec('ALTER TABLE accounts ADD COLUMN key_rc_salt BLOB');
  if (!have.has('key_wrap_rc')) sys.exec('ALTER TABLE accounts ADD COLUMN key_wrap_rc BLOB');
  if (!have.has('key_wrap_stale')) sys.exec('ALTER TABLE accounts ADD COLUMN key_wrap_stale INTEGER NOT NULL DEFAULT 0');
  // The recovery key's plaintext, sealed UNDER THE UDK (not the master key!) so
  // the server can show it back to a signed-in owner on request — while a stolen
  // disk + master key still reads nothing. Users never see it at enrollment.
  if (!have.has('key_rc_enc')) sys.exec('ALTER TABLE accounts ADD COLUMN key_rc_enc TEXT');
}

/* ---------- login security: per-IP bans + self-serve signup queue ----------
   ip_bans is DURABLE (unlike the old in-memory throttle) so a ban — and the
   Locked-tier escalation strike count — survives a server restart instead of
   being freed by it. signups holds self-serve account requests awaiting admin
   approval; the password is hashed at submit time and the plaintext never stored. */
sys.exec(`
CREATE TABLE IF NOT EXISTS ip_bans (
  ip           TEXT PRIMARY KEY,
  banned_until INTEGER NOT NULL DEFAULT 0,   -- epoch ms; 0 = not currently banned
  ban_count    INTEGER NOT NULL DEFAULT 0,   -- Locked-tier escalation strikes (5 -> 1 day)
  reason       TEXT,                          -- 'limited' | 'locked' | 'locked-day' | 'minimal'
  fails        INTEGER NOT NULL DEFAULT 0,   -- consecutive fails toward the tier threshold
  last_fail    INTEGER                        -- epoch ms of most recent fail (for decay)
);
CREATE TABLE IF NOT EXISTS signups (
  id           TEXT PRIMARY KEY,
  created      INTEGER NOT NULL,
  username     TEXT NOT NULL,
  display      TEXT,
  email        TEXT,
  explanation  TEXT,
  requested_gb REAL,
  pw_salt      BLOB NOT NULL,
  pw_hash      BLOB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',   -- 'pending' (rejected/approved rows are deleted)
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_signups_status ON signups(status, created);

-- Trusted sign-in IPs per account (the two-auth "regular device" list). A row
-- means this IP completed a FULL sign-in for the account (password + two-auth
-- when required), so future sign-ins from it skip the code. A manual sign-out
-- deletes the row for that IP, so the next sign-in needs two-auth again.
CREATE TABLE IF NOT EXISTS account_ips (
  account_id TEXT NOT NULL,
  ip         TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  logins     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, ip)
);

-- Forgot-password queue. There is no SMTP on this box: a user files a request,
-- admins see it (Manage accounts -> Security) and generate a one-time reset
-- code which they email to the account's address themselves. The code is
-- scrypt-hashed like a password; the plaintext exists only in the admin's
-- browser at generation time. status: 'pending' (needs admin) | 'sent'.
CREATE TABLE IF NOT EXISTS pw_resets (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  created      INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  code_salt    BLOB,
  code_hash    BLOB,
  code_expires INTEGER,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_pwresets_acct ON pw_resets(account_id);
`);
const banSys = {
  get:    sys.prepare('SELECT * FROM ip_bans WHERE ip = ?'),
  upsert: sys.prepare(`INSERT INTO ip_bans (ip, banned_until, ban_count, reason, fails, last_fail)
                       VALUES (@ip, @banned_until, @ban_count, @reason, @fails, @last_fail)
                       ON CONFLICT(ip) DO UPDATE SET
                         banned_until=@banned_until, ban_count=@ban_count, reason=@reason,
                         fails=@fails, last_fail=@last_fail`),
  clear:  sys.prepare('DELETE FROM ip_bans WHERE ip = ?'),
  // active = currently within a ban window; ordered soonest-expiring last for the admin list
  active: sys.prepare('SELECT * FROM ip_bans WHERE banned_until > ? ORDER BY banned_until DESC'),
  prune:  sys.prepare('DELETE FROM ip_bans WHERE banned_until <= ? AND (last_fail IS NULL OR last_fail < ?)'),
};
const signupSys = {
  insert:    sys.prepare(`INSERT INTO signups (id, created, username, display, email, explanation, requested_gb, pw_salt, pw_hash, status, ip)
                          VALUES (@id, @created, @username, @display, @email, @explanation, @requested_gb, @pw_salt, @pw_hash, 'pending', @ip)`),
  get:       sys.prepare(`SELECT * FROM signups WHERE id = ? AND status = 'pending'`),
  listPending: sys.prepare(`SELECT * FROM signups WHERE status = 'pending' ORDER BY created ASC`),
  countPending: sys.prepare(`SELECT COUNT(*) n FROM signups WHERE status = 'pending'`),
  byUsername: sys.prepare(`SELECT id FROM signups WHERE username = ? AND status = 'pending'`),
  del:       sys.prepare('DELETE FROM signups WHERE id = ?'),
};
const ipsSys = {
  get:    sys.prepare('SELECT * FROM account_ips WHERE account_id = ? AND ip = ?'),
  upsert: sys.prepare(`INSERT INTO account_ips (account_id, ip, first_seen, last_seen, logins)
                       VALUES (@account_id, @ip, @now, @now, 1)
                       ON CONFLICT(account_id, ip) DO UPDATE SET last_seen=@now, logins=logins+1`),
  del:    sys.prepare('DELETE FROM account_ips WHERE account_id = ? AND ip = ?'),
  delAcct: sys.prepare('DELETE FROM account_ips WHERE account_id = ?'),
  listForAcct: sys.prepare('SELECT * FROM account_ips WHERE account_id = ? ORDER BY last_seen DESC'),
};
const resetSys = {
  insert: sys.prepare(`INSERT INTO pw_resets (id, account_id, created, status, ip) VALUES (@id, @account_id, @created, 'pending', @ip)`),
  get:    sys.prepare('SELECT * FROM pw_resets WHERE id = ?'),
  list:   sys.prepare('SELECT * FROM pw_resets ORDER BY created ASC'),
  pendingForAcct: sys.prepare(`SELECT * FROM pw_resets WHERE account_id = ? ORDER BY created DESC LIMIT 1`),
  setCode: sys.prepare(`UPDATE pw_resets SET status='sent', code_salt=@code_salt, code_hash=@code_hash, code_expires=@code_expires WHERE id = @id`),
  del:    sys.prepare('DELETE FROM pw_resets WHERE id = ?'),
  delForAcct: sys.prepare('DELETE FROM pw_resets WHERE account_id = ?'),
  prune:  sys.prepare('DELETE FROM pw_resets WHERE created < ?'),
};

/* ---------- weak-password policy ----------
   Checked wherever we SEE a plaintext password (login, password change, reset):
   hashes can't be graded retroactively, so the force-change gate fires at the
   next sign-in. "1234" is literally the shipped admin default. */
const WEAK_PASSWORDS = new Set([
  '1234', '12345', '123456', '1234567', '12345678', '123456789', '0000', '1111',
  'password', 'passw0rd', 'admin', 'letmein', 'qwerty', 'abc123', 'welcome',
  'iloveyou', 'dragon', 'monkey', 'simplex',
]);
function isWeakPassword(pw, username) {
  if (typeof pw !== 'string' || pw.length < 6) return true;
  const lower = pw.toLowerCase();
  if (WEAK_PASSWORDS.has(lower)) return true;
  if (username && lower === String(username).toLowerCase()) return true;
  return false;
}

/* ---------- TOTP (RFC 6238) — no dependencies ----------
   Standard authenticator-app parameters: SHA-1 HMAC, 30s period, 6 digits.
   Verification accepts ±1 time-step of drift, and remembers the last accepted
   step per account so a captured code can't be replayed inside its window. */
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(str).toUpperCase().replace(/=+$/, '')) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpAt(secretB32, step) {
  const key = b32decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 1e6;
  return String(code).padStart(6, '0');
}
const totpLastStep = new Map();   // accountId -> last accepted step (anti-replay)
function totpVerify(accountId, secretB32, code) {
  code = String(code || '').replace(/\D/g, '');
  if (!secretB32 || code.length !== 6) return false;
  const step = Math.floor(Date.now() / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secretB32, s)), Buffer.from(code))) {
      const last = totpLastStep.get(accountId) || 0;
      if (s <= last) return false;   // replay of an already-used step
      totpLastStep.set(accountId, s);
      return true;
    }
  }
  return false;
}
function newTotpSecret() { return b32encode(crypto.randomBytes(20)); }
function otpauthUri(account, secret) {
  const label = encodeURIComponent(`Simplex:${account.username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=Simplex&algorithm=SHA1&digits=6&period=30`;
}

/* ---------- native captcha (the last step of two-auth setup) ----------
   A 5-character code rendered ONLY as anonymous stroke paths: the server has
   its own polyline font, and every glyph is jittered, rotated, and warped
   into `<path d="…">` elements, then shuffled together with decoy strokes
   styled identically. The markup carries ZERO character data — the answer
   never leaves the server, so a bot can't parse it out of the SVG; it would
   need real shape recognition on the rendered strokes. Still a speed bump
   (the user has already proven the TOTP code at this point), but no longer
   a trivially scriptable one. Challenges are single-use and expire fast. */
const captchas = new Map();       // id -> { answer, expires }
const captchaTokens = new Map();  // token -> expires (passed back to 2fa/enable)
const CAPTCHA_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L

/* stroke font: each glyph = polylines on a 4x6 box (y down). Covers exactly
   CAPTCHA_ALPHABET. Deliberately hand-rolled — a private font means public
   OCR models weren't trained on it. */
const STROKE_FONT = {
  A: [[[0,6],[2,0],[4,6]], [[1,3.6],[3,3.6]]],
  B: [[[0,0],[0,6]], [[0,0],[3,0],[4,1],[4,2],[3,3],[0,3]], [[3,3],[4,4],[4,5],[3,6],[0,6]]],
  C: [[[4,1],[3,0],[1,0],[0,1],[0,5],[1,6],[3,6],[4,5]]],
  D: [[[0,0],[0,6]], [[0,0],[3,0],[4,1.5],[4,4.5],[3,6],[0,6]]],
  E: [[[4,0],[0,0],[0,6],[4,6]], [[0,3],[3,3]]],
  F: [[[4,0],[0,0],[0,6]], [[0,3],[3,3]]],
  G: [[[4,1],[3,0],[1,0],[0,1],[0,5],[1,6],[3,6],[4,5],[4,3],[2.4,3]]],
  H: [[[0,0],[0,6]], [[4,0],[4,6]], [[0,3],[4,3]]],
  J: [[[4,0],[4,5],[3,6],[1,6],[0,5]]],
  K: [[[0,0],[0,6]], [[4,0],[0,3],[4,6]]],
  M: [[[0,6],[0,0],[2,3.2],[4,0],[4,6]]],
  N: [[[0,6],[0,0],[4,6],[4,0]]],
  P: [[[0,6],[0,0],[3,0],[4,1],[4,2.5],[3,3.5],[0,3.5]]],
  Q: [[[1,0],[3,0],[4,1],[4,5],[3,6],[1,6],[0,5],[0,1],[1,0]], [[2.6,4.2],[4.4,6.4]]],
  R: [[[0,6],[0,0],[3,0],[4,1],[4,2.5],[3,3.5],[0,3.5]], [[2,3.5],[4,6]]],
  S: [[[4,1],[3,0],[1,0],[0,1],[0,2],[1,3],[3,3],[4,4],[4,5],[3,6],[1,6],[0,5]]],
  T: [[[0,0],[4,0]], [[2,0],[2,6]]],
  U: [[[0,0],[0,5],[1,6],[3,6],[4,5],[4,0]]],
  V: [[[0,0],[2,6],[4,0]]],
  W: [[[0,0],[1,6],[2,2.8],[3,6],[4,0]]],
  X: [[[0,0],[4,6]], [[4,0],[0,6]]],
  Y: [[[0,0],[2,3],[4,0]], [[2,3],[2,6]]],
  Z: [[[0,0],[4,0],[0,6],[4,6]]],
  2: [[[0,1],[1,0],[3,0],[4,1],[4,2],[0,6],[4,6]]],
  3: [[[0,1],[1,0],[3,0],[4,1],[4,2],[3,3],[1.4,3]], [[3,3],[4,4],[4,5],[3,6],[1,6],[0,5]]],
  4: [[[3,6],[3,0],[0,4],[4,4]]],
  5: [[[4,0],[0,0],[0,3],[3,3],[4,4],[4,5],[3,6],[1,6],[0,5]]],
  6: [[[4,1],[3,0],[1,0],[0,1],[0,5],[1,6],[3,6],[4,5],[4,4],[3,3],[0,3.2]]],
  7: [[[0,0],[4,0],[1.6,6]]],
  8: [[[1,0],[3,0],[4,1],[4,2],[3,3],[1,3],[0,2],[0,1],[1,0]], [[1,3],[0,4],[0,5],[1,6],[3,6],[4,5],[4,4],[3,3]]],
  9: [[[0,5],[1,6],[3,6],[4,5],[4,1],[3,0],[1,0],[0,1],[0,2],[1,3],[4,2.8]]],
};
const capRnd = (n) => crypto.randomInt(Math.max(1, Math.round(n * 1000))) / 1000;
const capJit = (a) => capRnd(2 * a) - a;
/* place one glyph: per-point jitter, rotation about the glyph centre, slot translate */
function capGlyphStrokes(ch, cx, cy, scale, rot) {
  const cos = Math.cos(rot), sin = Math.sin(rot);
  return STROKE_FONT[ch].map(line => line.map(([x, y]) => {
    const px = (x - 2 + capJit(0.34)) * scale;
    const py = (y - 3 + capJit(0.34)) * scale;
    return [cx + px * cos - py * sin, cy + px * sin + py * cos];
  }));
}
/* polyline -> path with displaced midpoints, so no stroke is ever a clean line */
function capStrokePath(pts, amp) {
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    d += ` Q ${((x0 + x1) / 2 + capJit(amp)).toFixed(1)} ${((y0 + y1) / 2 + capJit(amp)).toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  return d;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of captchas) if (v.expires < now) captchas.delete(k);
  for (const [k, v] of captchaTokens) if (v < now) captchaTokens.delete(k);
}, 60_000).unref();
function newCaptcha() {
  let answer = '';
  for (let i = 0; i < 5; i++) answer += CAPTCHA_ALPHABET[crypto.randomInt(CAPTCHA_ALPHABET.length)];
  const id = 'c' + crypto.randomBytes(9).toString('hex');
  captchas.set(id, { answer, expires: Date.now() + 3 * 60_000 });
  const W = 260, H = 84;
  const paths = [];
  for (let i = 0; i < answer.length; i++) {
    const cx = 36 + i * 47 + capJit(5);
    const cy = H / 2 + capJit(7);
    const scale = 5.4 + capRnd(1.5);
    const rot = capJit(18) * Math.PI / 180;
    for (const pts of capGlyphStrokes(answer[i], cx, cy, scale, rot)) paths.push(capStrokePath(pts, 1.6));
  }
  for (let i = 0; i < 5; i++) {   // decoys: short arcs indistinguishable from glyph strokes
    const x = capRnd(W), y = capRnd(H);
    paths.push(capStrokePath([[x, y], [x + capJit(26), y + capJit(18)], [x + capJit(38), y + capJit(26)]], 5));
  }
  // shuffle: document order reveals nothing about glyph grouping
  for (let i = paths.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [paths[i], paths[j]] = [paths[j], paths[i]]; }
  const body = paths.map(d => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" opacity="0.88"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`;
  return { id, svg };
}
function checkCaptcha(id, answer) {
  const c = captchas.get(id);
  captchas.delete(id);   // single-use, right or wrong
  if (!c || c.expires < Date.now()) return null;
  if (String(answer || '').trim().toUpperCase() !== c.answer) return null;
  const token = 't' + crypto.randomBytes(12).toString('hex');
  captchaTokens.set(token, Date.now() + 5 * 60_000);
  return token;
}
function consumeCaptchaToken(token) {
  const exp = captchaTokens.get(token);
  captchaTokens.delete(token);
  return !!exp && exp >= Date.now();
}

/* effective safety level, derived defensively from what's actually configured
   (a stored level can't claim more than the account really has). */
function effectiveSafety(a) {
  if (a.totp_secret && a.email) return 'maximum';
  if (a.email && (a.safety === 'moderate' || a.safety === 'maximum')) return 'moderate';
  return 'minimal';
}

/* ---------- Custom API keys ----------
   Self-serve, per-account tokens that let an external app/workspace talk to the
   account's vault over the public /api/v1 surface. We store only a SHA-256 hash
   of the token (the high-entropy token itself is shown to the user exactly once)
   plus a short prefix for display. Each key carries a scope list (read / download
   / upload / delete) and an enabled flag the user can flip without deleting. */
sys.exec(`
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  label TEXT,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL,
  last_used INTEGER
);
CREATE INDEX IF NOT EXISTS idx_apikeys_acct ON api_keys(account_id);
CREATE INDEX IF NOT EXISTS idx_apikeys_hash ON api_keys(token_hash);
`);

/* ---------- Trading app: GLOBAL state (system DB) ----------
   The Trading app's MODEL is ONE network shared by every account and ALWAYS
   training in the background (see the trading loops near the bottom of this file).
   Unlike the per-account AI-Organization model, this one is global by design, so it
   lives in the SYSTEM db, not any account's vault:

     trading_model  — the single global model. `data` is the JSON model document
                      (weights + training metadata) encrypted with the __system__
                      keyset, same as a secret. One row (id = 'global').
     trading_bars   — cached OHLCV history per symbol (the model's training data +
                      what the dashboard/sandbox marks against). Not secret (public
                      market data), stored as plain JSON so the loop survives offline.
     trading_meta   — small key/value scratch for the loops (e.g. opt state isn't
                      persisted; this holds the last data-fetch time per symbol). */
sys.exec(`
CREATE TABLE IF NOT EXISTS trading_model ( id TEXT PRIMARY KEY, data TEXT, updated INTEGER NOT NULL );
CREATE TABLE IF NOT EXISTS trading_bars  ( symbol TEXT PRIMARY KEY, bars TEXT NOT NULL, updated INTEGER NOT NULL );
CREATE TABLE IF NOT EXISTS trading_meta  ( key TEXT PRIMARY KEY, value TEXT );
`);
const tradingSys = {
  modelGet: sys.prepare("SELECT data, updated FROM trading_model WHERE id = 'global'"),
  modelSet: sys.prepare("INSERT INTO trading_model (id,data,updated) VALUES ('global',@data,@updated) ON CONFLICT(id) DO UPDATE SET data=@data, updated=@updated"),
  barsGet: sys.prepare('SELECT bars, updated FROM trading_bars WHERE symbol = ?'),
  barsAll: sys.prepare('SELECT symbol, updated FROM trading_bars'),
  barsSet: sys.prepare('INSERT INTO trading_bars (symbol,bars,updated) VALUES (@symbol,@bars,@updated) ON CONFLICT(symbol) DO UPDATE SET bars=@bars, updated=@updated'),
  metaGet: sys.prepare('SELECT value FROM trading_meta WHERE key = ?'),
  metaSet: sys.prepare('INSERT INTO trading_meta (key,value) VALUES (@k,@v) ON CONFLICT(key) DO UPDATE SET value=@v'),
};

/* ---------- Music app: GLOBAL shared library + playlists + jams (system DB) ----------
   The Music app is a shared space every account sees, so — like Trading and Bug
   Reports — its metadata lives in the SYSTEM db, not any one account's vault.

   When a member "adds" one of their own vault audio files to Music, the bytes are
   COPIED (decrypted from the owner's vault, re-encrypted into a dedicated `__music__`
   blob store — see `musicStore` below). The copy is independent of the source: if
   the owner later deletes the original from their vault, the Music track is untouched.
   Only the uploader or an admin can remove a track from Music.

   Dedup is GLOBAL: a SHA-256 of the plaintext bytes (computed in the same streamed
   pass as the copy) is uniquely indexed, so the same song published twice is one
   shared track / one disk copy.

     music_tracks         — the shared library (metadata; bytes live in musicStore).
     music_playlists       — user playlists; public=1 ⇒ everyone sees it, else owner-only.
     music_playlist_items  — ordered (playlist, track) membership.
     music_jams            — live "listen together" sessions; `state` is the JSON
                             playback state (queue/order/idx/pos/paused/loop), `version`
                             a monotonic counter for last-write-wins control.
     music_jam_members     — who's in each jam (+ heartbeat last_seen). */
sys.exec(`
CREATE TABLE IF NOT EXISTS music_tracks (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_name TEXT NOT NULL,
  title TEXT NOT NULL, artist TEXT, album TEXT, duration REAL,
  size INTEGER NOT NULL, ext TEXT NOT NULL, hash TEXT NOT NULL,
  has_cover INTEGER NOT NULL DEFAULT 0, cover_ext TEXT, created INTEGER NOT NULL );
CREATE UNIQUE INDEX IF NOT EXISTS idx_music_hash ON music_tracks(hash);
CREATE INDEX IF NOT EXISTS idx_music_created ON music_tracks(created);

CREATE TABLE IF NOT EXISTS music_playlists (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_name TEXT NOT NULL,
  name TEXT NOT NULL, public INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL, updated INTEGER NOT NULL );
CREATE INDEX IF NOT EXISTS idx_music_pl_owner ON music_playlists(owner_id);

CREATE TABLE IF NOT EXISTS music_playlist_items (
  playlist_id TEXT NOT NULL, track_id TEXT NOT NULL, pos INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id) );
CREATE INDEX IF NOT EXISTS idx_music_pli_pl ON music_playlist_items(playlist_id, pos);

CREATE TABLE IF NOT EXISTS music_jams (
  id TEXT PRIMARY KEY, host_id TEXT NOT NULL, name TEXT,
  state TEXT NOT NULL, version INTEGER NOT NULL,
  created INTEGER NOT NULL, updated INTEGER NOT NULL );

CREATE TABLE IF NOT EXISTS music_jam_members (
  jam_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL,
  joined INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  PRIMARY KEY (jam_id, account_id) );

CREATE TABLE IF NOT EXISTS music_meta ( key TEXT PRIMARY KEY, value TEXT );

CREATE TABLE IF NOT EXISTS music_reports (
  id TEXT PRIMARY KEY, track_id TEXT NOT NULL, track_title TEXT,
  reporter_id TEXT NOT NULL, reporter_name TEXT NOT NULL,
  reason TEXT NOT NULL, detail TEXT,
  status TEXT NOT NULL DEFAULT 'open', created INTEGER NOT NULL );
CREATE INDEX IF NOT EXISTS idx_music_reports_status ON music_reports(status, created);
`);
// playlist "Trusted Editors": a JSON array of account ids the owner lets add/remove
// tracks. Added after the fact, so guard the ALTER for existing vaults.
{
  const cols = new Set(sys.prepare('PRAGMA table_info(music_playlists)').all().map(c => c.name));
  if (!cols.has('editors')) sys.exec('ALTER TABLE music_playlists ADD COLUMN editors TEXT');
}
const musicSys = {
  trackIns: sys.prepare(`INSERT INTO music_tracks (id,owner_id,owner_name,title,artist,album,duration,size,ext,hash,has_cover,cover_ext,created)
                         VALUES (@id,@owner_id,@owner_name,@title,@artist,@album,@duration,@size,@ext,@hash,@has_cover,@cover_ext,@created)`),
  trackByHash: sys.prepare('SELECT * FROM music_tracks WHERE hash = ?'),
  trackGet: sys.prepare('SELECT * FROM music_tracks WHERE id = ?'),
  trackList: sys.prepare('SELECT * FROM music_tracks ORDER BY created DESC'),
  trackDel: sys.prepare('DELETE FROM music_tracks WHERE id = ?'),

  plIns: sys.prepare('INSERT INTO music_playlists (id,owner_id,owner_name,name,public,editors,created,updated) VALUES (@id,@owner_id,@owner_name,@name,@public,@editors,@created,@updated)'),
  plGet: sys.prepare('SELECT * FROM music_playlists WHERE id = ?'),
  // visible = public, owned by you, OR you're a trusted editor (editors is a JSON id array)
  plListVisible: sys.prepare("SELECT * FROM music_playlists WHERE public = 1 OR owner_id = @me OR (editors IS NOT NULL AND editors LIKE @like) ORDER BY updated DESC"),
  plUpd: sys.prepare('UPDATE music_playlists SET name=@name, public=@public, updated=@updated WHERE id=@id'),
  plSetEditors: sys.prepare('UPDATE music_playlists SET editors=@editors, updated=@updated WHERE id=@id'),
  plTouch: sys.prepare('UPDATE music_playlists SET updated=@updated WHERE id=@id'),
  plDel: sys.prepare('DELETE FROM music_playlists WHERE id = ?'),

  metaGet: sys.prepare('SELECT value FROM music_meta WHERE key = ?'),
  metaSet: sys.prepare('INSERT INTO music_meta (key,value) VALUES (@k,@v) ON CONFLICT(key) DO UPDATE SET value=@v'),

  reportIns: sys.prepare(`INSERT INTO music_reports (id,track_id,track_title,reporter_id,reporter_name,reason,detail,status,created)
                          VALUES (@id,@track_id,@track_title,@reporter_id,@reporter_name,@reason,@detail,'open',@created)`),
  reportGet: sys.prepare('SELECT * FROM music_reports WHERE id = ?'),
  reportListOpen: sys.prepare("SELECT * FROM music_reports WHERE status = 'open' ORDER BY created DESC"),
  reportCountOpen: sys.prepare("SELECT COUNT(*) AS n FROM music_reports WHERE status = 'open'"),
  reportSetStatus: sys.prepare('UPDATE music_reports SET status = @status WHERE id = @id'),
  reportDelForTrack: sys.prepare('DELETE FROM music_reports WHERE track_id = ?'),
  reportMineOpenForTrack: sys.prepare("SELECT id FROM music_reports WHERE track_id = ? AND reporter_id = ? AND status = 'open'"),

  pliIns: sys.prepare('INSERT INTO music_playlist_items (playlist_id,track_id,pos) VALUES (@playlist_id,@track_id,@pos) ON CONFLICT(playlist_id,track_id) DO NOTHING'),
  pliList: sys.prepare('SELECT track_id, pos FROM music_playlist_items WHERE playlist_id = ? ORDER BY pos'),
  pliMaxPos: sys.prepare('SELECT COALESCE(MAX(pos), -1) AS m FROM music_playlist_items WHERE playlist_id = ?'),
  pliDelAll: sys.prepare('DELETE FROM music_playlist_items WHERE playlist_id = ?'),
  pliDelTrack: sys.prepare('DELETE FROM music_playlist_items WHERE playlist_id = ? AND track_id = ?'),
  pliDelTrackEverywhere: sys.prepare('DELETE FROM music_playlist_items WHERE track_id = ?'),
  pliSetPos: sys.prepare('UPDATE music_playlist_items SET pos = @pos WHERE playlist_id = @playlist_id AND track_id = @track_id'),

  jamIns: sys.prepare('INSERT INTO music_jams (id,host_id,name,state,version,created,updated) VALUES (@id,@host_id,@name,@state,@version,@created,@updated)'),
  jamGet: sys.prepare('SELECT * FROM music_jams WHERE id = ?'),
  jamByHost: sys.prepare('SELECT * FROM music_jams WHERE host_id = ?'),
  jamList: sys.prepare('SELECT * FROM music_jams ORDER BY updated DESC'),
  jamSet: sys.prepare('UPDATE music_jams SET state=@state, version=@version, updated=@updated WHERE id=@id'),
  jamSetHost: sys.prepare('UPDATE music_jams SET host_id=@host_id, updated=@updated WHERE id=@id'),
  jamDel: sys.prepare('DELETE FROM music_jams WHERE id = ?'),

  jmUpsert: sys.prepare(`INSERT INTO music_jam_members (jam_id,account_id,name,joined,last_seen) VALUES (@jam_id,@account_id,@name,@now,@now)
                         ON CONFLICT(jam_id,account_id) DO UPDATE SET last_seen=@now`),
  jmTouch: sys.prepare('UPDATE music_jam_members SET last_seen = @now WHERE jam_id = @jam_id AND account_id = @account_id'),
  jmList: sys.prepare('SELECT account_id, name, joined FROM music_jam_members WHERE jam_id = ? ORDER BY joined'),
  jmOldest: sys.prepare('SELECT account_id FROM music_jam_members WHERE jam_id = ? ORDER BY joined LIMIT 1'),
  jmCount: sys.prepare('SELECT COUNT(*) AS n FROM music_jam_members WHERE jam_id = ?'),
  jmDel: sys.prepare('DELETE FROM music_jam_members WHERE jam_id = ? AND account_id = ?'),
  jmDelAll: sys.prepare('DELETE FROM music_jam_members WHERE jam_id = ?'),
  jmPrune: sys.prepare('DELETE FROM music_jam_members WHERE last_seen < ?'),
  jmAllJamIds: sys.prepare('SELECT DISTINCT jam_id FROM music_jam_members'),
};

/* ---------- Bug Reports (system DB) ----------
   A single global inbox any part of the system can write to. Two sources feed it:
     - a signed-in member, via the Bug Reports app (source='user'); and
     - an automated assistant with NO account, via the OPEN POST endpoint
       (source='ai'), e.g. a security check that found something to flag.
   Admins read + triage the inbox in the same app. Reports are NOT secret (they are
   bug descriptions, not vault data) so they are stored as plain text — but the open
   endpoint is rate-limited + length-capped (see /api/bugs/open) so it can't be used
   to flood the table. Status moves new -> open -> resolved (or wontfix). */
sys.exec(`
CREATE TABLE IF NOT EXISTS bug_reports (
  id        TEXT PRIMARY KEY,
  created   INTEGER NOT NULL,
  source    TEXT NOT NULL,            -- 'user' | 'ai'
  account_id TEXT,                    -- set when source='user'; null for open AI posts
  reporter  TEXT,                     -- display name (user) or self-declared name (ai)
  area      TEXT,                     -- which app/system the bug is in
  severity  TEXT,                     -- 'low' | 'medium' | 'high' | 'critical'
  title     TEXT NOT NULL,
  body      TEXT NOT NULL,
  meta      TEXT,                     -- JSON: { url, ua, ip, ... } context
  status    TEXT NOT NULL DEFAULT 'new',   -- 'new' | 'open' | 'resolved' | 'wontfix'
  notes     TEXT                      -- admin triage notes
);
CREATE INDEX IF NOT EXISTS idx_bugs_created ON bug_reports(created);
CREATE INDEX IF NOT EXISTS idx_bugs_status  ON bug_reports(status);
`);
const bugSys = {
  insert: sys.prepare(`INSERT INTO bug_reports (id,created,source,account_id,reporter,area,severity,title,body,meta,status,notes)
                       VALUES (@id,@created,@source,@account_id,@reporter,@area,@severity,@title,@body,@meta,'new',null)`),
  list:   sys.prepare('SELECT * FROM bug_reports ORDER BY created DESC LIMIT @limit'),
  get:    sys.prepare('SELECT * FROM bug_reports WHERE id = ?'),
  setStatus: sys.prepare('UPDATE bug_reports SET status = @status WHERE id = @id'),
  setNotes:  sys.prepare('UPDATE bug_reports SET notes = @notes WHERE id = @id'),
  del:    sys.prepare('DELETE FROM bug_reports WHERE id = ?'),
  counts: sys.prepare('SELECT status, COUNT(*) n FROM bug_reports GROUP BY status'),
};

/* ---------- global settings (key/value; secrets encrypted with a system keyset) ----------
   The AI providers config (xAI key, worker creds) lives here, encrypted with keys
   derived from the master key for a synthetic '__system__' account. */
const SYS_KEYS = keyring('__system__');
const getSettingRaw = sys.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = sys.prepare('INSERT INTO settings (key, value) VALUES (@k, @v) ON CONFLICT(key) DO UPDATE SET value = @v');
function getSetting(key) { const r = getSettingRaw.get(key); return r ? r.value : null; }
function setSetting(key, value) { setSettingStmt.run({ k: key, v: value }); }
function getSecret(key) { const v = getSetting(key); if (!v) return null; try { return vault.decText(v, SYS_KEYS); } catch (e) { return null; } }
function setSecret(key, plain) { if (plain) setSetting(key, vault.encText(String(plain), SYS_KEYS)); else setSetting(key, ''); }

const sysStmt = {
  getAcct: sys.prepare('SELECT * FROM accounts WHERE id = ?'),
  getAcctByName: sys.prepare('SELECT * FROM accounts WHERE username = ? COLLATE NOCASE'),
  listAccts: sys.prepare('SELECT * FROM accounts ORDER BY is_admin DESC, username COLLATE NOCASE'),
  countAdmins: sys.prepare('SELECT COUNT(*) n FROM accounts WHERE is_admin = 1'),
  insAcct: sys.prepare(`INSERT INTO accounts (id,username,display,pw_salt,pw_hash,is_admin,quota_bytes,avatar_color,created)
                        VALUES (@id,@username,@display,@pw_salt,@pw_hash,@is_admin,@quota_bytes,@avatar_color,@created)`),
  delAcct: sys.prepare('DELETE FROM accounts WHERE id = ?'),
  getShare: sys.prepare('SELECT * FROM shares WHERE token = ?'),
  // resolve a public reference that may be either the random token OR a custom slug
  getShareByRef: sys.prepare('SELECT * FROM shares WHERE token = ? OR slug = ? LIMIT 1'),
  getShareBySlug: sys.prepare('SELECT * FROM shares WHERE slug = ?'),
  setShareSlug: sys.prepare('UPDATE shares SET slug = ? WHERE token = ? AND account_id = ?'),
  insShare: sys.prepare('INSERT INTO shares (token,account_id,file_id,created,allow_download) VALUES (?,?,?,?,?)'),
  listSharesForAcct: sys.prepare('SELECT * FROM shares WHERE account_id = ? ORDER BY created DESC'),
  delShareScoped: sys.prepare('DELETE FROM shares WHERE token = ? AND account_id = ?'),
  delSharesForFile: sys.prepare('DELETE FROM shares WHERE account_id = ? AND file_id = ?'),
  delSharesForAcct: sys.prepare('DELETE FROM shares WHERE account_id = ?'),
  getApiKey: sys.prepare('SELECT * FROM api_keys WHERE id = ?'),
  getApiKeyByHash: sys.prepare('SELECT * FROM api_keys WHERE token_hash = ?'),
  listApiKeysForAcct: sys.prepare('SELECT * FROM api_keys WHERE account_id = ? ORDER BY created DESC'),
  insApiKey: sys.prepare(`INSERT INTO api_keys (id,account_id,label,prefix,token_hash,scopes,enabled,created,last_used)
                          VALUES (@id,@account_id,@label,@prefix,@token_hash,@scopes,@enabled,@created,@last_used)`),
  updApiKey: sys.prepare('UPDATE api_keys SET label=@label, scopes=@scopes, enabled=@enabled WHERE id=@id AND account_id=@account_id'),
  touchApiKey: sys.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?'),
  delApiKey: sys.prepare('DELETE FROM api_keys WHERE id = ? AND account_id = ?'),
  delApiKeysForAcct: sys.prepare('DELETE FROM api_keys WHERE account_id = ?'),
};

/* ---------- Custom API helpers ---------- */
const API_SCOPES = ['read', 'download', 'upload', 'delete'];
function hashToken(tok) { return crypto.createHash('sha256').update(String(tok)).digest('hex'); }
function genApiToken() { return 'sx_live_' + crypto.randomBytes(24).toString('base64url'); }
function sanitizeScopes(arr) {
  if (!Array.isArray(arr)) return [];
  return API_SCOPES.filter(s => arr.includes(s));   // dedupe + preserve canonical order, drop unknowns
}
function apiKeyToApi(k) {
  let scopes = []; try { scopes = JSON.parse(k.scopes); } catch (e) {}
  return { id: k.id, label: k.label || '', prefix: k.prefix, scopes, enabled: !!k.enabled, created: k.created, last_used: k.last_used || null };
}

const PALETTE = ['#e0a64a', '#5aa9e6', '#7ed957', '#e6685a', '#b07ee6', '#46c2b6', '#e6a0c4', '#d8c24a'];
function pickColor() { return PALETTE[crypto.randomInt(PALETTE.length)]; }

function createAccount({ username, password, display, isAdmin = false, quota = DEFAULT_QUOTA, salt, hash }) {
  const id = aid();
  // Signup approval passes a precomputed salt/hash (hashed at submit time) so the
  // plaintext password never has to be stored or re-handled. Normal creation hashes here.
  if (!(salt && hash)) ({ salt, hash } = vault.hashPassword(password));
  sysStmt.insAcct.run({
    id, username, display: display || username,
    pw_salt: salt, pw_hash: hash,
    is_admin: isAdmin ? 1 : 0, quota_bytes: quota,
    avatar_color: pickColor(), created: Date.now(),
  });
  openStore(id);   // materialize the account's vault dir + DB
  bumpAccounts();
  return sysStmt.getAcct.get(id);
}

function acctToApi(a) {
  let prefs = null;
  if (a.prefs) { try { prefs = JSON.parse(a.prefs); } catch (e) {} }
  return {
    id: a.id, username: a.username, display: a.display || a.username,
    is_admin: !!a.is_admin, quota_bytes: a.quota_bytes, avatar_color: a.avatar_color, created: a.created,
    // admins always have app permissions; the flags govern members
    can_code: !!a.is_admin || !!a.can_code,
    can_ai: !!a.is_admin || !!a.can_ai,
    can_neural_backend: !!a.is_admin || !!a.can_neural_backend,
    // highest AI-Organization tier this account may select (admins always 'high')
    org_max_tier: orgMaxTier(a),
    // login-security tier ('minimal' | 'limited' | 'locked') — see ip_bans / /api/login
    security_tier: a.security_tier || 'minimal',
    // account safety: recovery email + safety level + whether two-auth is active.
    // The TOTP secret itself is NEVER exposed here.
    email: a.email || null,
    safety: effectiveSafety(a),
    totp_enabled: !!a.totp_secret,
    // per-user keys: enrolled + whether the password wrap rides an old password
    // (the wraps/salts themselves are NEVER exposed)
    keys_enrolled: !!a.key_enrolled,
    key_stale: !!a.key_wrap_stale,
    // Terms of Service: current version + whether THIS account accepted it, so
    // every client knows to raise the agreement before the next upload.
    tos_version: tosVersion(),
    tos_accepted: tosAccepted(a),
    prefs,
  };
}

/* ============================================================
   SAFE DYNAMIC "UPDATE … SET" BUILDER
   ============================================================
   A few handlers build an UPDATE's SET clause from a variable list of columns
   (the user patches some subset of fields). Values are always parameterized, and
   the columns are chosen by hard-coded literals upstream — but to make that
   guarantee enforceable *at the SQL string itself* (not just by reading every
   caller), each assignment fragment is checked against a per-table allow-list of
   exact `col = @col` expressions right before it is interpolated. Anything not on
   the list throws, so a future code path that forgets to whitelist a field fails
   loudly instead of silently becoming an injection vector. */
const UPDATE_COLUMNS = {
  accounts: new Set([
    'display = @display', 'username = @username',
    'pw_salt = @pw_salt', 'pw_hash = @pw_hash',
    'prefs = @prefs', 'quota_bytes = @quota_bytes', 'is_admin = @is_admin',
    'can_code = @can_code', 'can_ai = @can_ai',
    'can_neural_backend = @can_neural_backend', 'org_max_tier = @org_max_tier',
    'security_tier = @security_tier',
    'email = @email', 'safety = @safety',
    'totp_secret = @totp_secret', 'totp_pending = @totp_pending',
  ]),
  files: new Set([
    'name = @name', 'starred = @starred', 'trashed = @trashed',
    'content = @content', 'fp = @fp', 'locked = @locked', 'lockSpec = @lockSpec',
    'size = @size', 'date = @date',
    'artist = @artist', 'album = @album', 'hasCover = 1', 'coverExt = @coverExt',
    'kv = @kv',
  ]),
};
function buildSetClause(table, fields) {
  const allowed = UPDATE_COLUMNS[table];
  for (const f of fields) {
    if (!allowed.has(f)) throw new Error(`refusing to interpolate non-whitelisted UPDATE ${table} column: ${f}`);
  }
  return fields.join(', ');
}

/* ============================================================
   PER-ACCOUNT STORE
   ============================================================ */
const stores = new Map();
function openStore(accountId) {
  let s = stores.get(accountId);
  if (s) return s;

  const dir = path.join(ACCOUNTS_DIR, accountId);
  const filesDir = path.join(dir, 'files');
  const tmpDir = path.join(dir, 'tmp');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const f of fs.readdirSync(tmpDir)) { try { fs.unlinkSync(path.join(tmpDir, f)); } catch (e) {} }   // wipe stale partial uploads
  // sweep re-encryption temps orphaned by a failed/interrupted rename (e.g. the
  // AV EPERM case) — the original .enc is always intact, so temps are pure litter
  for (const f of fs.readdirSync(filesDir)) if (f.endsWith('.rekey')) { try { fs.unlinkSync(path.join(filesDir, f)); } catch (e) {} }

  const db = new Database(path.join(dir, 'simplex.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(FILES_SCHEMA);
  const have = new Set(db.prepare('PRAGMA table_info(files)').all().map(c => c.name));
  if (!have.has('hasCover')) db.exec('ALTER TABLE files ADD COLUMN hasCover INTEGER NOT NULL DEFAULT 0');
  if (!have.has('coverExt')) db.exec('ALTER TABLE files ADD COLUMN coverExt TEXT');
  // server-generated video poster frame (ffmpeg), cached encrypted at rest like a cover
  if (!have.has('hasPoster')) db.exec('ALTER TABLE files ADD COLUMN hasPoster INTEGER NOT NULL DEFAULT 0');
  // server-extracted icon for Windows executables (.exe/.dll): the embedded PE
  // resource icon, cached encrypted at rest like a cover/poster. iconExt is the
  // stored image format ('png' or 'ico'); 0 in hasIcon = not yet attempted, and
  // we use a -1 sentinel row flag (see /icon) to remember "tried, none found".
  if (!have.has('hasIcon')) db.exec('ALTER TABLE files ADD COLUMN hasIcon INTEGER NOT NULL DEFAULT 0');
  if (!have.has('iconExt')) db.exec('ALTER TABLE files ADD COLUMN iconExt TEXT');
  if (!have.has('locked')) db.exec('ALTER TABLE files ADD COLUMN locked INTEGER NOT NULL DEFAULT 0');
  if (!have.has('lockSpec')) db.exec('ALTER TABLE files ADD COLUMN lockSpec TEXT');
  // user-defined tags: per-file list of tag ids (JSON), plus the tag dictionary below
  if (!have.has('tags')) db.exec('ALTER TABLE files ADD COLUMN tags TEXT');
  // AI Organization content fingerprint cache: a tiny JSON summary of a sampled
  // slice of the file's bytes (see fingerprintBytes), computed once per file and
  // reused across retrains so we don't re-decrypt blobs every pass. Not sensitive
  // plaintext (coarse stats + a few content tokens) but we keep it lightweight.
  if (!have.has('fp')) db.exec('ALTER TABLE files ADD COLUMN fp TEXT');
  // key generation of this row's artifacts (1 = legacy master-derived, 2 = per-user
  // UDK). Pre-existing rows default to 1 and surface in the UI as "Legacy".
  if (!have.has('kv')) db.exec('ALTER TABLE files ADD COLUMN kv INTEGER NOT NULL DEFAULT 1');

  /* Notes app (rich-text docs) + Code app (multi-file workspace). Text columns
     (title/body/name/content) are encrypted at rest with the account keys, same
     as the files table's TEXT_COLS. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes ( id TEXT PRIMARY KEY, title TEXT, body TEXT, updated INTEGER NOT NULL );
    CREATE TABLE IF NOT EXISTS code (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, parent TEXT,
      is_dir INTEGER NOT NULL DEFAULT 0, content TEXT, lang TEXT, date INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_code_parent ON code(parent);
    CREATE TABLE IF NOT EXISTS chats ( id TEXT PRIMARY KEY, title TEXT, model TEXT, messages TEXT, updated INTEGER NOT NULL );
    CREATE TABLE IF NOT EXISTS ai_persona ( id INTEGER PRIMARY KEY, data TEXT, updated INTEGER );
    CREATE TABLE IF NOT EXISTS ai_memory ( id TEXT PRIMARY KEY, text TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL );
    CREATE TABLE IF NOT EXISTS connectors ( id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT, config TEXT, enabled INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL );
    CREATE TABLE IF NOT EXISTS notifications ( id TEXT PRIMARY KEY, type TEXT, title TEXT, body TEXT, meta TEXT, requires_ack INTEGER NOT NULL DEFAULT 0, acked INTEGER NOT NULL DEFAULT 0, read INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL );
    CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created);
    -- Neural Network app: one row per saved network. kind is 'graph' (the visual
    -- graph/physics sandbox) or 'llm' (the text-model template). data is the full
    -- JSON document (graph nodes, sim world, trained weights, vocab, hyper-params)
    -- encrypted at rest with the account keys, same as notes/code text columns.
    CREATE TABLE IF NOT EXISTS networks ( id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, data TEXT, updated INTEGER NOT NULL );
    -- Simplex Visual app: one row per project (a ".simplexvisual" document). data is
    -- the full JSON project — assets (inline textures), actor classes, and the 2D
    -- scene of placed instances (schema-versioned) — encrypted at rest with the
    -- account keys, same as notes/code/networks text columns. Per-account DB, so a
    -- project is only ever visible to its owner.
    CREATE TABLE IF NOT EXISTS visual_projects ( id TEXT PRIMARY KEY, name TEXT, data TEXT, updated INTEGER NOT NULL );
    -- User tag dictionary: one row per tag. name + color encrypted at rest with the
    -- account keys (like notes/code). Files reference these ids in files.tags (JSON).
    CREATE TABLE IF NOT EXISTS tags ( id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, created INTEGER NOT NULL );
    -- AI Organization: ONE per-account organizer model (a small classifier that
    -- learns this user's filing habits). The model weights + Adam optimizer state +
    -- training metadata are one JSON document, encrypted at rest with the account
    -- keys exactly like a saved network. Single row (id = 'main'). Completely
    -- isolated: it lives only in this account's DB and is never exposed to others.
    CREATE TABLE IF NOT EXISTS organizer ( id TEXT PRIMARY KEY, data TEXT, updated INTEGER NOT NULL );
    -- Stored per-file suggestions (folders/tags + confidence) the model produced on
    -- upload. The UI surfaces them for an hour, then keeps them here for "AI Store…".
    -- payload is encrypted JSON; created drives the 1-hour auto-hide.
    CREATE TABLE IF NOT EXISTS suggestions ( file_id TEXT PRIMARY KEY, payload TEXT, created INTEGER NOT NULL );
    -- Usage analytics: one row per recorded event (the Analytics app reads these to
    -- show the user when/how they use their own workspace). 'type' is a small known
    -- enum (session/upload/ai/tool/view/app/…); 'meta' is an optional un-encrypted
    -- JSON detail bag (e.g. {app:'tools'} or {kind:'video'}) — coarse usage labels,
    -- never file names or content. This data is for the USER's own dashboard only.
    CREATE TABLE IF NOT EXISTS analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_ts ON analytics(ts);
    -- Trading app: this account's portfolio + settings. The MODEL is global (system
    -- db); what's per-account is the user's money and choices:
    --   trading_account — ONE row (id='main'). data is an encrypted JSON document:
    --     { mode:'sandbox'|'live', sandbox:{portfolio...}, live:{enabled, killed,
    --       apiKey, apiSecret, paper}, risk:{...}, dayStartEquity }. The Alpaca
    --     key/secret (live mode) live inside this encrypted blob, never in plaintext.
    --   trading_log — one row per executed (paper or live) trade, for the dashboard.
    CREATE TABLE IF NOT EXISTS trading_account ( id TEXT PRIMARY KEY, data TEXT, updated INTEGER NOT NULL );
    CREATE TABLE IF NOT EXISTS trading_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, mode TEXT NOT NULL,
      symbol TEXT, side TEXT, qty REAL, price REAL, pnl REAL, reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trading_log_ts ON trading_log(ts);
  `);

  /* One-time reclassify: EXR/TIFF used to be unsupported, so any that were uploaded
     before support landed were stored as type 'document' (they'd have opened in the
     text editor). Now they're 'image' with a server-rendered preview + heightmap +
     convert. Retype them in place from the plaintext storedExt column — no blob
     touch, no decrypt, no re-upload. Idempotent and effectively free after the first
     run (the WHERE matches nothing once migrated). hasPoster is reset so the image
     preview regenerates on first view instead of serving a stale doc-era artifact. */
  try {
    db.prepare(
      "UPDATE files SET type = 'image', hasPoster = 0 " +
      "WHERE type != 'image' AND type != 'folder' " +
      "AND LOWER(COALESCE(storedExt,'')) IN ('exr','tif','tiff')"
    ).run();
  } catch (e) { console.warn('[simplex] exr/tiff reclassify skipped:', e && e.message); }

  /* DUAL KEYSET: v1 = the master-derived account subkeys (always available —
     legacy data + the communal '__music__'/'__system__' stores). v2 = the
     UDK-derived subkeys, present only while the owner's UDK is RAM-resident;
     a live getter so sign-ins/restarts are picked up without reopening the
     store. Writers prefer v2, readers pick per-artifact (SXB1/SXB2, enc:/enc2:). */
  const keys = { v1: keyring(accountId), get v2() { return UDK_KEYS.get(accountId) || null; } };
  const st = {
    getById: db.prepare('SELECT * FROM files WHERE id = ?'),
    all: db.prepare('SELECT * FROM files'),
    children: db.prepare('SELECT id, type FROM files WHERE parent = ?'),
    childRows: db.prepare('SELECT * FROM files WHERE parent = ?'),
    used: db.prepare("SELECT COALESCE(SUM(size),0) n FROM files WHERE trashed = 0 AND type != 'folder'"),
    insert: db.prepare(`INSERT INTO files (${COLS.join(',')}) VALUES (${COLS.map(c => '@' + c).join(',')})`),
    del: db.prepare('DELETE FROM files WHERE id = ?'),
    sibRoot: db.prepare('SELECT id, name FROM files WHERE parent IS NULL AND trashed = 0'),
    sibIn: db.prepare('SELECT id, name FROM files WHERE parent = ? AND trashed = 0'),
  };

  /* notes + code prepared statements */
  const ncq = {
    notesAll: db.prepare('SELECT * FROM notes ORDER BY updated DESC'),
    noteGet: db.prepare('SELECT * FROM notes WHERE id = ?'),
    noteIns: db.prepare('INSERT INTO notes (id,title,body,updated) VALUES (?,?,?,?)'),
    noteUpd: db.prepare('UPDATE notes SET title=?, body=?, updated=? WHERE id=?'),
    noteDel: db.prepare('DELETE FROM notes WHERE id = ?'),
    codeAll: db.prepare('SELECT * FROM code'),
    codeGet: db.prepare('SELECT * FROM code WHERE id = ?'),
    codeKids: db.prepare('SELECT id, is_dir FROM code WHERE parent = ?'),
    codeIns: db.prepare('INSERT INTO code (id,name,parent,is_dir,content,lang,date) VALUES (?,?,?,?,?,?,?)'),
    codeUpd: db.prepare('UPDATE code SET name=?, content=?, lang=?, parent=?, date=? WHERE id=?'),
    codeDel: db.prepare('DELETE FROM code WHERE id = ?'),
    codeBytes: db.prepare("SELECT COALESCE(SUM(LENGTH(content)),0) n, COUNT(*) c FROM code"),
    chatsAll: db.prepare('SELECT id, title, model, updated FROM chats ORDER BY updated DESC'),
    chatGet: db.prepare('SELECT * FROM chats WHERE id = ?'),
    chatIns: db.prepare('INSERT INTO chats (id,title,model,messages,updated) VALUES (?,?,?,?,?)'),
    chatUpd: db.prepare('UPDATE chats SET title=?, model=?, messages=?, updated=? WHERE id=?'),
    chatDel: db.prepare('DELETE FROM chats WHERE id = ?'),
    personaGet: db.prepare('SELECT data FROM ai_persona WHERE id = 1'),
    personaSet: db.prepare('INSERT INTO ai_persona (id,data,updated) VALUES (1,@data,@updated) ON CONFLICT(id) DO UPDATE SET data=@data, updated=@updated'),
    memAll: db.prepare('SELECT * FROM ai_memory ORDER BY pinned DESC, created DESC'),
    memGet: db.prepare('SELECT * FROM ai_memory WHERE id = ?'),
    memIns: db.prepare('INSERT INTO ai_memory (id,text,pinned,created) VALUES (?,?,?,?)'),
    memUpd: db.prepare('UPDATE ai_memory SET text=?, pinned=? WHERE id=?'),
    memDel: db.prepare('DELETE FROM ai_memory WHERE id = ?'),
    memClear: db.prepare('DELETE FROM ai_memory'),
    memCount: db.prepare('SELECT COUNT(*) n FROM ai_memory'),
    connAll: db.prepare('SELECT * FROM connectors ORDER BY created'),
    connGet: db.prepare('SELECT * FROM connectors WHERE id = ?'),
    connIns: db.prepare('INSERT INTO connectors (id,type,label,config,enabled,created) VALUES (?,?,?,?,?,?)'),
    connUpd: db.prepare('UPDATE connectors SET label=?, config=?, enabled=? WHERE id=?'),
    connDel: db.prepare('DELETE FROM connectors WHERE id = ?'),
    notifAll: db.prepare('SELECT * FROM notifications ORDER BY created DESC LIMIT 60'),
    notifGet: db.prepare('SELECT * FROM notifications WHERE id = ?'),
    notifIns: db.prepare('INSERT INTO notifications (id,type,title,body,meta,requires_ack,acked,read,created) VALUES (?,?,?,?,?,?,0,0,?)'),
    notifAck: db.prepare('UPDATE notifications SET acked=1, read=1 WHERE id=?'),
    notifRead: db.prepare('UPDATE notifications SET read=1 WHERE id=?'),
    notifReadAll: db.prepare('UPDATE notifications SET read=1'),
    notifDel: db.prepare('DELETE FROM notifications WHERE id = ?'),
    notifUnread: db.prepare('SELECT COUNT(*) n FROM notifications WHERE read=0'),
    notifTrim: db.prepare('DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY created DESC LIMIT 200)'),
    netAll: db.prepare('SELECT id, kind, name, updated FROM networks ORDER BY updated DESC'),
    netGet: db.prepare('SELECT * FROM networks WHERE id = ?'),
    netIns: db.prepare('INSERT INTO networks (id,kind,name,data,updated) VALUES (?,?,?,?,?)'),
    netUpd: db.prepare('UPDATE networks SET name=?, data=?, updated=? WHERE id=?'),
    netDel: db.prepare('DELETE FROM networks WHERE id = ?'),
    netBytes: db.prepare("SELECT COALESCE(SUM(LENGTH(data)),0) n, COUNT(*) c FROM networks"),
    visAll: db.prepare('SELECT id, name, updated FROM visual_projects ORDER BY updated DESC'),
    visGet: db.prepare('SELECT * FROM visual_projects WHERE id = ?'),
    visIns: db.prepare('INSERT INTO visual_projects (id,name,data,updated) VALUES (?,?,?,?)'),
    visUpd: db.prepare('UPDATE visual_projects SET name=?, data=?, updated=? WHERE id=?'),
    visDel: db.prepare('DELETE FROM visual_projects WHERE id = ?'),
    tagAll: db.prepare('SELECT * FROM tags ORDER BY created'),
    tagGet: db.prepare('SELECT * FROM tags WHERE id = ?'),
    tagIns: db.prepare('INSERT INTO tags (id,name,color,created) VALUES (?,?,?,?)'),
    tagUpd: db.prepare('UPDATE tags SET name=?, color=? WHERE id=?'),
    tagDel: db.prepare('DELETE FROM tags WHERE id = ?'),
    filesWithTags: db.prepare("SELECT id, tags FROM files WHERE tags IS NOT NULL AND tags != ''"),
    setFileTags: db.prepare('UPDATE files SET tags = ? WHERE id = ?'),
    orgGet: db.prepare("SELECT * FROM organizer WHERE id = 'main'"),
    orgSet: db.prepare("INSERT INTO organizer (id,data,updated) VALUES ('main',@data,@updated) ON CONFLICT(id) DO UPDATE SET data=@data, updated=@updated"),
    orgDel: db.prepare("DELETE FROM organizer WHERE id = 'main'"),
    sugGet: db.prepare('SELECT * FROM suggestions WHERE file_id = ?'),
    sugSet: db.prepare('INSERT INTO suggestions (file_id,payload,created) VALUES (@file_id,@payload,@created) ON CONFLICT(file_id) DO UPDATE SET payload=@payload, created=@created'),
    sugDel: db.prepare('DELETE FROM suggestions WHERE file_id = ?'),
    sugAll: db.prepare('SELECT * FROM suggestions ORDER BY created DESC'),
    sugClear: db.prepare('DELETE FROM suggestions'),
    // usage analytics (the Analytics app): insert an event, read a window, prune old.
    anIns: db.prepare('INSERT INTO analytics (ts,type,meta) VALUES (?,?,?)'),
    anSince: db.prepare('SELECT ts,type,meta FROM analytics WHERE ts >= ? ORDER BY ts'),
    anCountByType: db.prepare('SELECT type, COUNT(*) n FROM analytics GROUP BY type'),
    anFirst: db.prepare('SELECT MIN(ts) m FROM analytics'),
    anTotal: db.prepare('SELECT COUNT(*) n FROM analytics'),
    anPrune: db.prepare('DELETE FROM analytics WHERE ts < ?'),
    anClear: db.prepare('DELETE FROM analytics'),
    // every non-trashed, non-folder, UNLOCKED file — the organizer's training universe.
    // Locked (per-item-encrypted) files are excluded: their name/metadata must not be analyzed.
    orgTrainRows: db.prepare("SELECT id, name, parent, type, size, tags, storedExt, fp, hasBlob, content FROM files WHERE trashed = 0 AND type != 'folder' AND locked = 0"),
    // folders (for resolving suggested-folder ids -> readable paths), unlocked only
    orgFolderRows: db.prepare("SELECT id, name, parent FROM files WHERE type = 'folder' AND trashed = 0 AND locked = 0"),
    setFp: db.prepare('UPDATE files SET fp = ? WHERE id = ?'),
    // Trading app: per-account portfolio doc + trade log.
    trAcctGet: db.prepare("SELECT data FROM trading_account WHERE id = 'main'"),
    trAcctSet: db.prepare("INSERT INTO trading_account (id,data,updated) VALUES ('main',@data,@updated) ON CONFLICT(id) DO UPDATE SET data=@data, updated=@updated"),
    trLogIns: db.prepare('INSERT INTO trading_log (ts,mode,symbol,side,qty,price,pnl,reason) VALUES (@ts,@mode,@symbol,@side,@qty,@price,@pnl,@reason)'),
    trLogRecent: db.prepare('SELECT * FROM trading_log ORDER BY ts DESC LIMIT ?'),
    trLogTrim: db.prepare('DELETE FROM trading_log WHERE id NOT IN (SELECT id FROM trading_log ORDER BY ts DESC LIMIT 500)'),
    trLogClear: db.prepare('DELETE FROM trading_log'),
  };
  const encT = (v) => v == null ? null : vault.encText(String(v), keys);
  const decT = (v) => v == null ? null : vault.decText(v, keys);
  const snippetOf = (html) => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);

  s = {
    id: accountId, dir, filesDir, tmpDir, db, keys, st, rev: 1,
    bump() { this.rev++; },
    getById: (id) => st.getById.get(id),
    usedBytes: () => st.used.get().n,
    blobPath: (row) => path.join(filesDir, row.id + '.enc'),
    coverPath: (row) => path.join(filesDir, row.id + '.cover.enc'),
    coverSmPath: (row) => path.join(filesDir, row.id + '.coversm.enc'),   // tiny low-res cover (progressive loading)
    audioQPath: (row) => path.join(filesDir, row.id + '.q' + row.q + '.enc'),   // cached lossy audio tier (music streaming quality)
    posterPath: (row) => path.join(filesDir, row.id + '.poster.enc'),
    iconPath: (row) => path.join(filesDir, row.id + '.icon.enc'),
    decName: (row) => vault.decText(row.name, keys),
    insertRowRaw: (o) => { st.insert.run(rowForInsert(o)); return st.getById.get(o.id); },
    insertRow: (o) => {
      const e = { ...o };
      for (const c of TEXT_COLS) if (e[c] != null) e[c] = vault.encText(e[c], keys);
      e.kv = keys.v2 ? 2 : 1;   // stamp the key generation the row is written under
      st.insert.run(rowForInsert(e));
      return st.getById.get(o.id);
    },
    /* mark a row's key generation (2 after a blob rewrite under v2 keys) */
    setKv: (id, kvv) => { db.prepare('UPDATE files SET kv = ? WHERE id = ?').run(kvv, id); },
    descendantIds: (id) => {
      const out = [];
      const walk = (p) => { for (const c of st.children.all(p)) { out.push(c.id); if (c.type === 'folder') walk(c.id); } };
      walk(id);
      return out;
    },
    unlinkBlob: (row) => {
      const p = path.join(filesDir, row.id + '.enc'); if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (e) {}
      const pp = path.join(filesDir, row.id + '.poster.enc'); if (fs.existsSync(pp)) try { fs.unlinkSync(pp); } catch (e) {}   // stale poster
      const ip = path.join(filesDir, row.id + '.icon.enc'); if (fs.existsSync(ip)) try { fs.unlinkSync(ip); } catch (e) {}    // stale exe icon
    },
    unlinkCover: (row) => {
      const p = path.join(filesDir, row.id + '.cover.enc'); if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (e) {}
      const sm = path.join(filesDir, row.id + '.coversm.enc'); if (fs.existsSync(sm)) try { fs.unlinkSync(sm); } catch (e) {}   // stale low-res
    },

    /* ---------- Local AI: user-uploaded GGUF models ----------
       Every non-trashed, non-folder, non-locked file the user has uploaded whose
       (decrypted) name ends in .gguf — surfaced as a selectable Local model. We
       skip locked files: their blob is wrapped with a per-item passphrase key the
       backend doesn't hold, so the engine couldn't decrypt them to load anyway. */
    ggufFiles: () => st.all.all()
      .filter(r => !r.trashed && r.type !== 'folder' && !r.locked && r.hasBlob)
      .map(r => ({ id: r.id, name: decT(r.name) || '', size: r.size || 0 }))
      .filter(r => /\.(gguf|guff)$/i.test(r.name)),

    /* ---------- notes ---------- */
    notesList: () => ncq.notesAll.all().map(r => ({ id: r.id, title: decT(r.title) || '', snippet: snippetOf(decT(r.body)), updated: r.updated })),
    noteGet: (id) => { const r = ncq.noteGet.get(id); return r ? { id: r.id, title: decT(r.title) || '', body: decT(r.body) || '', updated: r.updated } : null; },
    noteCreate: ({ title, body }) => { const id = uid(); const now = Date.now(); ncq.noteIns.run(id, encT(title || ''), encT(body || ''), now); return { id, title: title || '', body: body || '', updated: now }; },
    noteUpdate: (id, { title, body }) => { const r = ncq.noteGet.get(id); if (!r) return null; const now = Date.now(); ncq.noteUpd.run(encT(title ?? decT(r.title) ?? ''), encT(body ?? decT(r.body) ?? ''), now, id); return s.noteGet(id); },
    noteDelete: (id) => ncq.noteDel.run(id).changes > 0,

    /* ---------- code workspace ---------- */
    codeList: () => ncq.codeAll.all().map(r => ({ id: r.id, name: decT(r.name) || '', parent: r.parent ?? null, is_dir: !!r.is_dir, content: r.is_dir ? null : (decT(r.content) || ''), lang: r.lang || null, date: r.date })),
    codeGet: (id) => { const r = ncq.codeGet.get(id); return r ? { id: r.id, name: decT(r.name) || '', parent: r.parent ?? null, is_dir: !!r.is_dir, content: r.is_dir ? null : (decT(r.content) || ''), lang: r.lang || null, date: r.date } : null; },
    codeCreate: ({ name, parent, is_dir, content, lang }) => { const id = uid(); const now = Date.now(); ncq.codeIns.run(id, encT(name), parent ?? null, is_dir ? 1 : 0, is_dir ? null : encT(content || ''), lang || null, now); return s.codeGet(id); },
    codeUpdate: (id, p) => { const r = ncq.codeGet.get(id); if (!r) return null; const name = p.name != null ? encT(p.name) : r.name; const content = p.content != null ? encT(p.content) : r.content; const lang = p.lang !== undefined ? p.lang : r.lang; const parent = p.parent !== undefined ? p.parent : r.parent; ncq.codeUpd.run(name, content, lang, parent, Date.now(), id); return s.codeGet(id); },
    codeDelete: (id) => { const walk = (pid) => { for (const c of ncq.codeKids.all(pid)) { if (c.is_dir) walk(c.id); ncq.codeDel.run(c.id); } }; walk(id); return ncq.codeDel.run(id).changes > 0; },
    codeStats: () => ncq.codeBytes.get(),

    /* ---------- Neural Network app ---------- */
    netList: () => ncq.netAll.all().map(r => ({ id: r.id, kind: r.kind, name: decT(r.name) || 'Untitled network', updated: r.updated })),
    netGet: (id) => { const r = ncq.netGet.get(id); if (!r) return null; let data = null; try { data = JSON.parse(decT(r.data) || 'null'); } catch (e) {} return { id: r.id, kind: r.kind, name: decT(r.name) || 'Untitled network', data, updated: r.updated }; },
    netCreate: ({ kind, name, data }) => { const id = uid(); const now = Date.now(); const k = (kind === 'llm' || kind === 'actorlab') ? kind : 'graph'; ncq.netIns.run(id, k, encT(name || 'Untitled network'), encT(JSON.stringify(data ?? null)), now); return s.netGet(id); },
    netUpdate: (id, p) => { const r = ncq.netGet.get(id); if (!r) return null; const now = Date.now(); const name = p.name != null ? encT(p.name) : r.name; const data = p.data !== undefined ? encT(JSON.stringify(p.data)) : r.data; ncq.netUpd.run(name, data, now, id); return s.netGet(id); },
    netDelete: (id) => ncq.netDel.run(id).changes > 0,
    netStats: () => ncq.netBytes.get(),

    /* ---------- Simplex Visual app ---------- */
    visList: () => ncq.visAll.all().map(r => ({ id: r.id, name: decT(r.name) || 'Untitled project', updated: r.updated })),
    visGet: (id) => { const r = ncq.visGet.get(id); if (!r) return null; let data = null; try { data = JSON.parse(decT(r.data) || 'null'); } catch (e) {} return { id: r.id, name: decT(r.name) || 'Untitled project', data, updated: r.updated }; },
    visCreate: ({ name, data }) => { const id = uid(); const now = Date.now(); ncq.visIns.run(id, encT(name || 'Untitled project'), encT(JSON.stringify(data ?? null)), now); return s.visGet(id); },
    visUpdate: (id, p) => { const r = ncq.visGet.get(id); if (!r) return null; const now = Date.now(); const name = p.name != null ? encT(p.name) : r.name; const data = p.data !== undefined ? encT(JSON.stringify(p.data)) : r.data; ncq.visUpd.run(name, data, now, id); return s.visGet(id); },
    visDelete: (id) => ncq.visDel.run(id).changes > 0,

    /* ---------- AI conversations ---------- */
    chatsList: () => ncq.chatsAll.all().map(r => ({ id: r.id, title: decT(r.title) || 'New chat', model: r.model || null, updated: r.updated })),
    chatGet: (id) => { const r = ncq.chatGet.get(id); if (!r) return null; let messages = []; try { messages = JSON.parse(decT(r.messages) || '[]'); } catch (e) {} return { id: r.id, title: decT(r.title) || 'New chat', model: r.model || null, messages, updated: r.updated }; },
    chatCreate: ({ title, model, messages }) => { const id = uid(); const now = Date.now(); ncq.chatIns.run(id, encT(title || 'New chat'), model || null, encT(JSON.stringify(messages || [])), now); return s.chatGet(id); },
    chatUpdate: (id, p) => { const r = ncq.chatGet.get(id); if (!r) return null; const now = Date.now(); const title = p.title != null ? encT(p.title) : r.title; const model = p.model !== undefined ? p.model : r.model; const messages = p.messages != null ? encT(JSON.stringify(p.messages)) : r.messages; ncq.chatUpd.run(title, model, messages, now, id); return s.chatGet(id); },
    chatDelete: (id) => ncq.chatDel.run(id).changes > 0,

    /* ---------- AI personalization + memory (encrypted at rest) ---------- */
    aiPersonaGet: () => { const r = ncq.personaGet.get(); if (!r || !r.data) return {}; try { return JSON.parse(decT(r.data)) || {}; } catch (e) { return {}; } },
    aiPersonaSet: (obj) => { ncq.personaSet.run({ data: encT(JSON.stringify(obj || {})), updated: Date.now() }); return s.aiPersonaGet(); },
    aiMemoryList: () => ncq.memAll.all().map(r => ({ id: r.id, text: decT(r.text) || '', pinned: !!r.pinned, created: r.created })),
    aiMemoryAdd: (text) => { const id = uid(); const now = Date.now(); ncq.memIns.run(id, encT(String(text)), 0, now); return { id, text: String(text), pinned: false, created: now }; },
    aiMemoryUpdate: (id, p) => { const r = ncq.memGet.get(id); if (!r) return null; const text = p.text != null ? encT(String(p.text)) : r.text; const pinned = p.pinned != null ? (p.pinned ? 1 : 0) : r.pinned; ncq.memUpd.run(text, pinned, id); const x = ncq.memGet.get(id); return { id, text: decT(x.text) || '', pinned: !!x.pinned, created: x.created }; },
    aiMemoryDelete: (id) => ncq.memDel.run(id).changes > 0,
    aiMemoryClear: () => { ncq.memClear.run(); return true; },
    aiMemoryCount: () => ncq.memCount.get().n,

    /* ---------- connectors + notifications (config/text encrypted at rest) ---------- */
    connList: () => ncq.connAll.all().map(r => { let config = {}; try { config = JSON.parse(decT(r.config) || '{}'); } catch (e) {} return { id: r.id, type: r.type, label: decT(r.label) || '', config, enabled: !!r.enabled, created: r.created }; }),
    connGet: (id) => { const r = ncq.connGet.get(id); if (!r) return null; let config = {}; try { config = JSON.parse(decT(r.config) || '{}'); } catch (e) {} return { id: r.id, type: r.type, label: decT(r.label) || '', config, enabled: !!r.enabled, created: r.created }; },
    connCreate: ({ type, label, config }) => { const id = 'c' + crypto.randomBytes(6).toString('hex'); ncq.connIns.run(id, type, encT(label || ''), encT(JSON.stringify(config || {})), 1, Date.now()); return s.connGet(id); },
    connUpdate: (id, p) => { const r = ncq.connGet.get(id); if (!r) return null; const cur = s.connGet(id); const label = p.label != null ? p.label : cur.label; const config = p.config != null ? p.config : cur.config; const enabled = p.enabled != null ? (p.enabled ? 1 : 0) : r.enabled; ncq.connUpd.run(encT(label), encT(JSON.stringify(config)), enabled, id); return s.connGet(id); },
    connDelete: (id) => ncq.connDel.run(id).changes > 0,
    connRaw: () => ncq.connAll.all(),   // for the schedule engine (avoids re-decrypt churn elsewhere)

    notifList: () => ncq.notifAll.all().map(r => ({ id: r.id, type: r.type, title: decT(r.title) || '', body: decT(r.body) || '', meta: (() => { try { return JSON.parse(decT(r.meta) || '{}'); } catch (e) { return {}; } })(), requires_ack: !!r.requires_ack, acked: !!r.acked, read: !!r.read, created: r.created })),
    notifAdd: ({ type, title, body, meta, requires_ack }) => { const id = 'n' + crypto.randomBytes(6).toString('hex'); ncq.notifIns.run(id, type || 'info', encT(title || ''), encT(body || ''), encT(JSON.stringify(meta || {})), requires_ack ? 1 : 0, Date.now()); ncq.notifTrim.run(); return id; },
    notifAck: (id) => ncq.notifAck.run(id).changes > 0,
    notifRead: (id) => ncq.notifRead.run(id).changes > 0,
    notifReadAll: () => { ncq.notifReadAll.run(); return true; },
    notifDelete: (id) => ncq.notifDel.run(id).changes > 0,
    notifUnread: () => ncq.notifUnread.get().n,

    /* ---------- tags (name/color encrypted at rest) ---------- */
    tagsList: () => ncq.tagAll.all().map(r => ({ id: r.id, name: decT(r.name) || '', color: r.color || null, created: r.created })),
    tagGet: (id) => { const r = ncq.tagGet.get(id); return r ? { id: r.id, name: decT(r.name) || '', color: r.color || null, created: r.created } : null; },
    tagCreate: ({ name, color }) => { const id = 't' + crypto.randomBytes(6).toString('hex'); ncq.tagIns.run(id, encT(String(name || '').slice(0, 60)), color || null, Date.now()); return s.tagGet(id); },
    tagUpdate: (id, p) => { const r = ncq.tagGet.get(id); if (!r) return null; const name = p.name != null ? encT(String(p.name).slice(0, 60)) : r.name; const color = p.color !== undefined ? (p.color || null) : r.color; ncq.tagUpd.run(name, color, id); return s.tagGet(id); },
    // delete a tag AND strip its id from every file that carries it
    tagDelete: (id) => {
      const strip = db.transaction(() => {
        for (const row of ncq.filesWithTags.all()) {
          let arr = []; try { arr = JSON.parse(row.tags) || []; } catch (e) {}
          if (Array.isArray(arr) && arr.includes(id)) {
            const next = arr.filter(t => t !== id);
            ncq.setFileTags.run(next.length ? JSON.stringify(next) : null, row.id);
          }
        }
        ncq.tagDel.run(id);
      });
      strip();
      return true;
    },
    // overwrite the tag id-array on one file (validates ids against the dictionary)
    setFileTags: (fileId, ids) => {
      const row = st.getById.get(fileId); if (!row) return null;
      const valid = new Set(ncq.tagAll.all().map(r => r.id));
      const clean = (Array.isArray(ids) ? ids : []).filter((x, i, a) => valid.has(x) && a.indexOf(x) === i);
      ncq.setFileTags.run(clean.length ? JSON.stringify(clean) : null, fileId);
      return rowToApi(st.getById.get(fileId), s);
    },

    /* ---------- AI Organization (organizer model + stored suggestions) ----------
       The model document (weights + Adam state + meta) is encrypted at rest like a
       network. Helpers here are pure persistence + plaintext file features; the
       training/prediction math lives in organizerEngine() below. */
    orgModelGet: () => { const r = ncq.orgGet.get(); if (!r || !r.data) return null; try { return JSON.parse(decT(r.data)); } catch (e) { return null; } },
    orgModelSet: (doc) => { ncq.orgSet.run({ data: encT(JSON.stringify(doc)), updated: Date.now() }); return doc; },
    orgModelDelete: () => { ncq.orgDel.run(); ncq.sugClear.run(); return true; },
    // the training universe: unlocked, non-trashed, non-folder files with their
    // current folder + tags as labels. Names are decrypted here (in the store, which
    // holds the keys); the engine only ever sees plaintext surface metadata.
    orgTrainingExamples: () => ncq.orgTrainRows.all().map(r => {
      let tags = []; if (r.tags) { try { tags = JSON.parse(r.tags) || []; } catch (e) {} }
      const name = decT(r.name) || '';
      let fp = null; if (r.fp) { try { fp = JSON.parse(r.fp); } catch (e) {} }
      return { id: r.id, x: { name, ext: extOf(name, r.storedExt), type: r.type, size: r.size, fp }, folder: r.parent ?? null, tags };
    }),
    // rows that still need a content fingerprint computed OR refreshed: no fp yet, OR
    // an OLD fp cached before the `bytes` field existed (so it must be re-sampled for
    // the datasetBytes stat to reflect real analyzed content, not stay at ~5 KB).
    // Bounded by the caller; one-time upgrade cost for pre-existing files.
    orgRowsNeedingFp: () => ncq.orgTrainRows.all().filter(r => {
      if (!(r.hasBlob || r.content != null)) return false;
      if (!r.fp) return true;
      try { const fp = JSON.parse(r.fp); return fp && fp.bytes == null; } catch (e) { return true; }
    }),
    orgSetFp: (id, fp) => ncq.setFp.run(fp == null ? null : JSON.stringify(fp), id),
    // wipe ALL cached fingerprints (when the tier's byte budget changes, every file
    // must be re-sampled at the new size on the next training pass).
    orgClearFingerprints: () => { db.prepare('UPDATE files SET fp = NULL').run(); },
    // decrypt a file's inline text content (for documents stored in the `content`
    // column rather than as a blob) — used to fingerprint notes/code/text docs.
    orgInlineContent: (r) => (r && r.content != null) ? (decT(r.content) || '') : null,
    // folder dictionary: id -> { name, parent } with decrypted names, for building
    // human-readable paths when surfacing a suggested folder.
    orgFolders: () => ncq.orgFolderRows.all().map(r => ({ id: r.id, name: decT(r.name) || '', parent: r.parent ?? null })),
    // surface metadata for ONE file (for predicting on a just-uploaded item),
    // including its cached content fingerprint when present.
    orgFileFeatures: (id) => { const r = st.getById.get(id); if (!r || r.type === 'folder' || r.locked) return null; const name = decT(r.name) || ''; let fp = null; if (r.fp) { try { fp = JSON.parse(r.fp); } catch (e) {} } return { name, ext: extOf(name, r.storedExt), type: r.type, size: r.size, fp }; },
    suggestionGet: (fileId) => { const r = ncq.sugGet.get(fileId); if (!r) return null; let payload = null; try { payload = JSON.parse(decT(r.payload)); } catch (e) {} return payload ? { fileId, ...payload, created: r.created } : null; },
    suggestionSet: (fileId, payload) => { ncq.sugSet.run({ file_id: fileId, payload: encT(JSON.stringify(payload || {})), created: Date.now() }); },
    suggestionDelete: (fileId) => ncq.sugDel.run(fileId).changes > 0,

    /* ---------- usage analytics (the Analytics app) ----------
       A lightweight, private-to-the-account event log. We store only coarse usage
       labels (event type + a tiny meta bag like {app:'tools'} or {kind:'video'}),
       never file names or content, so meta is kept as plain JSON. Events older than
       ANALYTICS_RETENTION_DAYS are pruned opportunistically on each write. */
    analyticsLog: (type, meta) => {
      const t = String(type || '').slice(0, 24);
      if (!t) return;
      let m = null;
      if (meta && typeof meta === 'object') { try { m = JSON.stringify(meta).slice(0, 300); } catch (e) {} }
      ncq.anIns.run(Date.now(), t, m);
      // opportunistic prune (cheap; indexed on ts). Keep all-time COUNTS via the
      // separate running tallies below, so pruning rows never loses lifetime totals.
      if (Math.random() < 0.04) ncq.anPrune.run(Date.now() - ANALYTICS_RETENTION_DAYS * 864e5);
    },
    // Build the dashboard payload: a 30-day daily series, an hour×weekday heatmap,
    // per-type totals (within the retained window) and the first-seen timestamp.
    analyticsSummary: () => {
      const now = Date.now();
      const windowMs = ANALYTICS_RETENTION_DAYS * 864e5;
      const rows = ncq.anSince.all(now - windowMs);
      const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
      // daily totals + per-day-per-type
      const days = new Map();
      // 7 weekdays × 24 hours heatmap of total activity
      const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
      const typeTotals = {};
      let activeSeconds = 0;   // summed from session-heartbeat meta ({seconds})
      let signIns = 0;         // 'session' events that are sign-ins (no seconds meta), not heartbeats
      let firstTs = rows.length ? rows[0].ts : null;
      for (const r of rows) {
        const k = dayKey(r.ts);
        if (!days.has(k)) days.set(k, { total: 0, byType: {} });
        const e = days.get(k); e.total++; e.byType[r.type] = (e.byType[r.type] || 0) + 1;
        typeTotals[r.type] = (typeTotals[r.type] || 0) + 1;
        const d = new Date(r.ts); heat[d.getDay()][d.getHours()]++;
        if (firstTs == null || r.ts < firstTs) firstTs = r.ts;
        if (r.type === 'session') {
          let sec = null;
          if (r.meta) { try { const m = JSON.parse(r.meta); if (m && Number.isFinite(+m.seconds)) sec = +m.seconds; } catch (e) {} }
          if (sec != null) activeSeconds += sec; else signIns++;
        }
      }
      // dense daily series for the last N days (fill gaps with zeros)
      const series = [];
      for (let i = ANALYTICS_RETENTION_DAYS - 1; i >= 0; i--) {
        const ts = now - i * 864e5; const k = dayKey(ts);
        const e = days.get(k);
        series.push({ date: k, total: e ? e.total : 0, byType: e ? e.byType : {} });
      }
      const lifeFirst = ncq.anFirst.get().m;
      return {
        retentionDays: ANALYTICS_RETENTION_DAYS,
        windowTotal: rows.length,
        allTimeTotal: ncq.anTotal.get().n,
        firstSeen: lifeFirst != null ? lifeFirst : firstTs,
        activeSeconds,
        signIns,
        typeTotals,
        series,
        heat,
      };
    },
    analyticsClear: () => { ncq.anClear.run(); return true; },

    /* ---------- Trading app (per-account portfolio + log) ----------
       The portfolio doc is one encrypted JSON blob (it holds the user's positions,
       cash, mode, and — in live mode — their Alpaca key/secret). We read/write it
       whole; it's tiny. tradingDefault() seeds a fresh sandbox account on first use. */
    tradingGet: () => {
      const r = ncq.trAcctGet.get();
      if (!r || !r.data) return null;
      try { return JSON.parse(decT(r.data)); } catch (e) { return null; }
    },
    tradingSet: (doc) => { ncq.trAcctSet.run({ data: encT(JSON.stringify(doc)), updated: Date.now() }); return doc; },
    tradingLog: (entry) => {
      ncq.trLogIns.run({
        ts: entry.ts || Date.now(), mode: entry.mode || 'sandbox',
        symbol: entry.symbol || null, side: entry.side || null,
        qty: entry.qty == null ? null : entry.qty, price: entry.price == null ? null : entry.price,
        pnl: entry.pnl == null ? null : entry.pnl, reason: entry.reason || null,
      });
      ncq.trLogTrim.run();
    },
    tradingLogRecent: (n) => ncq.trLogRecent.all(Math.max(1, Math.min(500, n || 50))),
    tradingLogClear: () => { ncq.trLogClear.run(); return true; },
  };
  stores.set(accountId, s);
  return s;
}
function dropStore(accountId) {
  const s = stores.get(accountId);
  if (s) { try { s.db.close(); } catch (e) {} stores.delete(accountId); }
  try { fs.rmSync(path.join(ACCOUNTS_DIR, accountId), { recursive: true, force: true }); } catch (e) {}
}

/* The Music app's shared blob vault. A synthetic store (`vault/accounts/__music__/`)
   whose blobs are encrypted with the always-held `keyring('__music__')` keyset, so any
   signed-in member can stream them — unlike a per-account vault, which only its owner's
   keys can read. We use only its blobPath/coverPath/tmpDir/keys helpers; track metadata
   lives in the system DB (music_tracks). Created once, here, after openStore is defined. */
const musicStore = openStore('__music__');

/* row (DB shape) -> API shape: decrypt text, add urls, strip internals.
   includeContent=false (the default for LIST views) drops the heavy document body
   and sets hasContent instead; pass true for single-item/detail responses. */
function rowToApi(row, store, includeContent = false) {
  if (!row) return null;
  const out = { ...row };
  for (const c of TEXT_COLS) if (out[c] != null) out[c] = vault.decText(out[c], store.keys);
  out.trashed = !!row.trashed;
  out.starred = !!row.starred;
  if (row.hasBlob) out.url = `/api/files/${row.id}/raw`;
  if (row.hasCover) out.coverUrl = `/api/files/${row.id}/cover`;
  // videos (with a real blob, not locked) can have a server-generated poster frame;
  // the endpoint makes it on first request. Locked videos skip it (no plaintext frame).
  if (row.hasBlob && row.type === 'video' && !row.locked) out.posterUrl = `/api/files/${row.id}/poster`;
  // exr/tiff images: same poster endpoint serves a server-rendered PNG preview
  // (thumbnails + the 2D viewer both use it, since browsers can't decode them).
  if (row.hasBlob && !row.locked && needsPreview(row)) out.posterUrl = `/api/files/${row.id}/poster`;
  // Windows executables (.exe/.dll/…) expose an icon endpoint that extracts the
  // embedded PE icon on first request. hasIcon === -1 means we already tried and
  // found none, so don't advertise a url that will only 404.
  if (row.hasBlob && !row.locked && ICON_PE_EXTS.has(String(row.storedExt || '').toLowerCase().replace(/^\./, '')) && row.hasIcon !== -1) {
    out.iconUrl = `/api/files/${row.id}/icon`;
  }
  delete out.hasBlob; delete out.storedExt; delete out.hasCover; delete out.coverExt; delete out.hasPoster;
  delete out.hasIcon; delete out.iconExt;
  // key generation: the client badges kv=1 items as "Legacy" and gates
  // edit/download behind re-encryption. Folders carry no blob — omit.
  if (row.type === 'folder') delete out.kv; else out.kv = row.kv || 1;
  // tags: stored as a JSON id-array; ship it as a real array (empty omitted to stay light)
  if (row.tags) { try { const t = JSON.parse(row.tags); if (Array.isArray(t) && t.length) out.tags = t; else delete out.tags; } catch (e) { delete out.tags; } }
  else delete out.tags;
  out.parent = row.parent ?? null;
  for (const k of ['lang', 'dur', 'w', 'h', 'artist', 'album']) if (out[k] == null) delete out[k];
  if (out.content == null) delete out.content;
  // For LIST responses, drop the full document body — it can be the single largest
  // field (whole markdown/code/text files) and the list only needs a snippet, which
  // it fetches lazily. The viewer pulls full content on open via fetchDocText(). A
  // detail fetch (rowToApi with includeContent) keeps it. See /api/files.
  if (!includeContent && out.content != null) {
    out.hasContent = true;          // tell the client a body exists (so it knows to fetch on open)
    delete out.content;
  }
  return out;
}

/* Legacy (kv=1) rows are readable/watchable but EDIT and DOWNLOAD require
   re-encryption first — the nudge that moves a vault to per-user keys. Only
   applies once the account is enrolled (everyone, after their first sign-in). */
function legacyGate(req, res, row) {
  if (row && row.type !== 'folder' && (row.kv || 1) === 1 && req.account && req.account.key_enrolled) {
    res.status(409).json({ error: 'this file still uses the old key — re-encrypt it to edit or download', code: 'LEGACY' });
    return true;
  }
  return false;
}

/* ---------- name dedupe (decrypts names) ---------- */
function siblingNames(store, parent) {
  const rows = parent == null ? store.st.sibRoot.all() : store.st.sibIn.all(parent);
  return new Set(rows.map(r => vault.decText(r.name, store.keys)));
}
function splitExt(name) { const m = String(name).match(/^(.*?)(\.[a-z0-9]+)$/i); return m ? [m[1], m[2]] : [name, '']; }
/* best-effort extension for the organizer: prefer the name's own extension, else
   the stored upload extension; lowercased, no leading dot. */
function extOf(name, storedExt) {
  const m = String(name || '').match(/\.([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();
  return String(storedExt || '').replace(/^\./, '').toLowerCase();
}
function dedupeName(name, store, parent) {
  const taken = siblingNames(store, parent);
  if (!taken.has(name)) return name;
  const [base, ext] = splitExt(name);
  let cand = `${base} copy${ext}`, n = 1;
  while (taken.has(cand)) { n++; cand = `${base} copy ${n}${ext}`; }
  return cand;
}
function normParent(p) { return (p === undefined || p === null || p === 'null' || p === '') ? null : p; }
function isInSubtree(store, descId, ancestorId) {
  let cur = store.getById(descId);
  while (cur) { if (cur.id === ancestorId) return true; cur = cur.parent != null ? store.getById(cur.parent) : null; }
  return false;
}

/* ---------- mime ---------- */
function mimeFor(ext) {
  ext = String(ext || '').toLowerCase().replace(/^\./, '');
  return ({
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
    mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', exr: 'image/x-exr', bmp: 'image/bmp',
  })[ext] || 'application/octet-stream';
}
function limitError(res, store, quota) { return res.status(413).json({ error: 'storage limit reached', limit: quota, used: store.usedBytes() }); }

/* ============================================================
   STREAMING / LOGGING TUNABLES
   ============================================================ */
const SLOW_REQ_MS = 3000;   // a handler slower than this gets logged (the endpoint to harden)
// Usage-analytics retention: the Analytics app shows a 30-day window; events older
// than this are pruned (lifetime COUNT totals are still kept via a running tally).
const ANALYTICS_RETENTION_DAYS = Number(process.env.SX_ANALYTICS_RETENTION_DAYS) || 30;
const STREAM_IDLE_MS = Number(process.env.SX_STREAM_IDLE_MS) || 30_000;

/* Lightweight diagnostics counters surfaced by /api/_diag. */
const diag = { connections: 0, maxLagMs: 0, lastLagMs: 0, blockEvents: 0 };

/* ---------- in-flight request registry + event-loop lag detector ----------
   The single Node thread runs every request; any long SYNCHRONOUS operation on it
   (a big sync better-sqlite3 query, an fs.*Sync that the local AV stalls, a
   spawnSync) freezes EVERYTHING — and freezes the very code that would log it, so
   the freeze is invisible. This watchdog runs a 250ms timer: if it actually fires
   N ms late, the loop was blocked for ~N ms. When that exceeds a threshold we log
   the requests that were in flight at the time — the suspects. This is the single
   thing that has pinned every prior "hangs after a while, logs show nothing" bug. */
const inFlight = new Map();   // reqId -> { method, path, startedAt }
let _reqSeq = 0;
const LOOP_BLOCK_MS = Number(process.env.SX_LOOP_BLOCK_MS) || 1000;   // log a block past this
const LOOP_TICK_MS = 250;
let _lastTick = Date.now();

/* Background-task attribution. The block detector below only knows about in-flight
   HTTP requests; when a TIMER/CRON task (schedule engine, poster gen, etc.) blocks
   the loop, inFlight is empty and the block logs "none captured" — leaving us blind
   to the actual cause. `runTracked(label, fn)` records what's running so a block that
   happens during it is NAMED in the log. Synchronous-safe and never throws. */
let _bgTask = null;   // { label, startedAt } of the background job currently on the stack
function runTracked(label, fn) {
  const prev = _bgTask;
  _bgTask = { label, startedAt: Date.now() };
  try { return fn(); }
  finally { _bgTask = prev; }
}

setInterval(() => {
  const now = Date.now();
  const lag = now - _lastTick - LOOP_TICK_MS;   // how late this tick fired = how long the loop was blocked
  _lastTick = now;
  diag.lastLagMs = Math.max(0, lag);
  if (lag > diag.maxLagMs) diag.maxLagMs = lag;
  if (lag >= LOOP_BLOCK_MS) {
    diag.blockEvents++;
    const suspects = [...inFlight.values()]
      .map(r => `${r.method} ${r.path} (${now - r.startedAt}ms)`)
      .slice(0, 8);
    // If a tracked background task was on the stack, name it — that's the prime suspect
    // for a block with no in-flight request.
    if (_bgTask) suspects.unshift(`bg:${_bgTask.label} (${now - _bgTask.startedAt}ms)`);
    console.warn(`[simplex] EVENT LOOP BLOCKED ~${lag}ms — in-flight: ${suspects.length ? suspects.join(', ') : '(none — likely a timer/cron or boot task)'}`);
    if (typeof diagLogBlock === 'function') diagLogBlock(lag, suspects);
  }
}, LOOP_TICK_MS).unref();

/* ---------- VERBOSE DIAGNOSTIC HEARTBEAT (vault/diag.log) ----------
   Writes a one-line snapshot of the server's vitals every few seconds to a FILE
   (so it survives even a hard crash — console output would be lost). Purpose: when
   the server freezes or dies, the LAST lines before the gap show the exact state
   right before it locked up, and the timestamp gap shows WHEN. Send vault/diag.log
   after a freeze to diagnose it.

   - Append-only with size rotation (can't fill the disk over long uptime).
   - File-only (keeps the console clean). Toggle with SX_DIAG_HEARTBEAT=0.
   - A loop block past the threshold writes a prominent `!!! BLOCK` line.
   - Crash/exit signals write a final `### EXIT` line so the log ends with the cause. */
const DIAG_LOG_PATH = path.join(VAULT_DIR, 'diag.log');
const DIAG_HEARTBEAT_MS = Number(process.env.SX_DIAG_HEARTBEAT_MS) || 2000;
const DIAG_LOG_MAX_BYTES = Number(process.env.SX_DIAG_LOG_MAX_BYTES) || 5 * 1024 * 1024;
const DIAG_ENABLED = process.env.SX_DIAG_HEARTBEAT !== '0';
const _diagStartedAt = Date.now();

function diagWrite(line) {
  try {
    let size = 0; try { size = fs.statSync(DIAG_LOG_PATH).size; } catch (e) {}
    // rotate by truncating once past the cap (no external logrotate needed); leave
    // a marker so a reader knows the head was dropped.
    if (size > DIAG_LOG_MAX_BYTES) {
      try { fs.truncateSync(DIAG_LOG_PATH, 0); } catch (e) {}
      try { fs.appendFileSync(DIAG_LOG_PATH, `[${new Date().toISOString()}] --- log rotated (was >${Math.round(DIAG_LOG_MAX_BYTES / 1e6)}MB) ---\n`); } catch (e) {}
    }
    fs.appendFileSync(DIAG_LOG_PATH, line + '\n');
  } catch (e) { /* diag logging must never crash the server */ }
}

function diagSnapshot(tag) {
  const now = Date.now();
  const m = process.memoryUsage();
  // oldest in-flight request is the prime suspect if we're about to freeze
  let oldest = null;
  for (const r of inFlight.values()) { if (!oldest || r.startedAt < oldest.startedAt) oldest = r; }
  const oldestStr = oldest ? `${oldest.method} ${oldest.path} (${now - oldest.startedAt}ms)` : '-';
  const conns = (typeof httpServer !== 'undefined' && httpServer && httpServer._connections != null) ? httpServer._connections : diag.connections;
  const streams = (typeof vault.openReadStreams === 'function') ? vault.openReadStreams() : -1;
  const handles = (process._getActiveHandles && process._getActiveHandles().length) || -1;
  const reqs = (typeof process._getActiveRequests === 'function' && process._getActiveRequests().length) || 0;
  const uploadsN = (typeof uploads !== 'undefined') ? uploads.size : 0;
  const runsN = (typeof runs !== 'undefined') ? runs.size : 0;
  const toolsN = (typeof _toolJobs !== 'undefined') ? _toolJobs : 0;
  const storesN = (typeof stores !== 'undefined') ? stores.size : 0;
  return `[${new Date(now).toISOString()}] ${tag} up=${Math.round((now - _diagStartedAt) / 1000)}s `
    + `lag=${diag.lastLagMs}ms max=${diag.maxLagMs}ms blocks=${diag.blockEvents} `
    + `conn=${conns} streams=${streams} handles=${handles} activeReq=${reqs} `
    + `rss=${Math.round(m.rss / 1e6)}MB heap=${Math.round(m.heapUsed / 1e6)}/${Math.round(m.heapTotal / 1e6)}MB ext=${Math.round((m.external || 0) / 1e6)}MB `
    + `inflight=${inFlight.size} oldest="${oldestStr}" uploads=${uploadsN} runs=${runsN} tools=${toolsN} stores=${storesN}`;
}

if (DIAG_ENABLED) {
  try { fs.mkdirSync(VAULT_DIR, { recursive: true }); } catch (e) {}
  diagWrite(`[${new Date().toISOString()}] ### START pid=${process.pid} node=${process.version} threadpool=${process.env.UV_THREADPOOL_SIZE || 4}`);
  setInterval(() => diagWrite(diagSnapshot('HB')), DIAG_HEARTBEAT_MS).unref();
  // MEMORY HIGH-WATER alarm. When the OS kills the process for running out of memory
  // (OOM), Node gets SIGKILL with no chance to write an EXIT/fatal line — the heartbeat
  // just STOPS mid-stream (exactly the "log looks the same, then silence" symptom). To
  // make that visible BEFORE it happens, watch RSS each tick and scream a prominent line
  // when it crosses rising thresholds, so the log shows the climb that preceded death.
  // Tunable; default first alarm at 700MB then every +200MB. Pure diagnostics — never
  // changes behavior, never throws.
  const MEM_ALARM_START_MB = Number(process.env.SX_MEM_ALARM_MB) || 700;
  const MEM_ALARM_STEP_MB = Number(process.env.SX_MEM_ALARM_STEP_MB) || 200;
  let _memAlarmAt = MEM_ALARM_START_MB;
  setInterval(() => {
    try {
      const rssMB = Math.round(process.memoryUsage().rss / 1e6);
      if (rssMB >= _memAlarmAt) {
        diagWrite(`[${new Date().toISOString()}] ### MEMORY HIGH rss=${rssMB}MB (threshold ${_memAlarmAt}MB) — if the log stops shortly after this, the OS likely OOM-killed the process | ${diagSnapshot('MEM')}`);
        console.warn(`[simplex] MEMORY HIGH rss=${rssMB}MB — possible OOM risk`);
        while (rssMB >= _memAlarmAt) _memAlarmAt += MEM_ALARM_STEP_MB;   // advance past current level so we re-alarm only on further growth
      } else if (rssMB < MEM_ALARM_START_MB && _memAlarmAt > MEM_ALARM_START_MB) {
        _memAlarmAt = MEM_ALARM_START_MB;   // memory came back down — re-arm
      }
    } catch (e) { /* never throw from diagnostics */ }
  }, DIAG_HEARTBEAT_MS).unref();
  // On any exit path, write a final line so the log ENDS with the cause (a freeze
  // instead just stops — the gap + last HB line is the signal). Guarded so it
  // writes exactly once even if multiple handlers fire.
  let _saidBye = false;
  const farewell = (why) => { if (_saidBye) return; _saidBye = true; diagWrite(`[${new Date().toISOString()}] ### EXIT (${why}) | ${diagSnapshot('FINAL')}`); };
  process.on('exit', () => farewell('process exit'));
  // Signal handlers must flush AND exit (registering a handler suppresses the
  // default terminate, so without process.exit the server would hang on Ctrl-C).
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { farewell('signal ' + sig); process.exit(0); });
  // uncaughtException/unhandledRejection are handled by the existing handlers near
  // the bottom of this file (they swallow benign EPIPE/ECONNRESET from dropped
  // streams); they call diagFatal() below so a genuinely fatal error is recorded.
}

/* When the loop-block watchdog fires, ALSO write a prominent line to diag.log so
   the freeze cause is captured in the file, not just the console. */
function diagLogBlock(lag, suspects) {
  if (DIAG_ENABLED) diagWrite(`[${new Date().toISOString()}] !!! BLOCK ~${lag}ms inflight=[${suspects.join(' | ') || 'none'}] | ${diagSnapshot('AT-BLOCK')}`);
}
/* Record a genuinely fatal error in diag.log (called by the uncaughtException
   handler for non-benign errors — benign EPIPE/ECONNRESET are skipped there). */
function diagFatal(label, err) {
  if (DIAG_ENABLED) diagWrite(`[${new Date().toISOString()}] ### FATAL (${label}) ${err && (err.stack || err.message || err)} | ${diagSnapshot('FATAL')}`);
}

/* ---------- stream an encrypted blob/cover with HTTP Range ----------
   pipeline(dec.stream, res) guarantees the decrypt chain (and its underlying
   file descriptor) is destroyed if the client disconnects mid-stream. */
function streamEncrypted(req, res, store, row, kind) {
  return _streamEncryptedImpl(req, res, store, row, kind).catch((e) => {
    console.error('[simplex] streamEncrypted error', e && (e.stack || e.message || e));
    try { if (!res.headersSent) res.status(500).end(); else res.destroy(); } catch (_) {}
  });
}

async function _streamEncryptedImpl(req, res, store, row, kind) {
  const isCover = kind === 'cover', isPoster = kind === 'poster', isIcon = kind === 'icon', isCoverSm = kind === 'coversm', isAudioQ = kind === 'audioq';
  const present = isCover ? row && row.hasCover : isCoverSm ? row && row.hasCoverSm : isPoster ? row && row.hasPoster : isIcon ? row && row.hasIcon === 1 : isAudioQ ? row && row.hasAudioQ : row && row.hasBlob;
  if (!row || !present) return res.status(404).end();

  try {
    const encPath = isCover ? store.coverPath(row) : isCoverSm ? store.coverSmPath(row) : isPoster ? store.posterPath(row) : isIcon ? store.iconPath(row) : isAudioQ ? store.audioQPath(row) : store.blobPath(row);
    const head = await vault.readBlobHeaderAsync(encPath);
    if (!head) return res.status(404).end();

    const total = head.size;
    const ext = isCover ? (row.coverExt || '') : isCoverSm ? 'jpg' : isPoster ? (needsPreview(row) ? 'png' : 'jpg') : isIcon ? (row.iconExt || 'png') : isAudioQ ? 'm4a' : (row.storedExt || '');
    res.setHeader('Content-Type', mimeFor(ext));
    res.setHeader('Accept-Ranges', 'bytes');
    // endpoints serving immutable derivatives (posters, icons, music covers) set their
    // own max-age BEFORE calling in; don't clobber it with no-store.
    if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'private, no-store');

    let start = null, end = null, code = 200;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) { res.setHeader('Content-Range', `bytes */${total}`); return res.status(416).end(); }
      start = m[1] === '' ? null : parseInt(m[1], 10);
      end = m[2] === '' ? null : parseInt(m[2], 10);
      if (start === null && end === null) { res.setHeader('Content-Range', `bytes */${total}`); return res.status(416).end(); }
      if (start === null) { start = total - end; end = total - 1; }
      if (end === null) end = total - 1;
      end = Math.min(end, total - 1);
      if (isNaN(start) || isNaN(end) || start > end || start < 0 || start >= total) {
        res.setHeader('Content-Range', `bytes */${total}`); return res.status(416).end();
      }
      code = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', end - start + 1);
    } else {
      res.setHeader('Content-Length', total);
    }
    if (req.method === 'HEAD') { res.writeHead(code); return res.end(); }

    const dec = vault.decryptBlobRange(encPath, store.keys, start, end, head);
    if (!dec) return res.status(404).end();

    res.writeHead(code);
    let settled = false;
    const settle = () => { if (settled) return; settled = true; if (idleTimer) clearTimeout(idleTimer); };

    // Per-stream IDLE watchdog: reap a stream that has gone silent because the CLIENT
    // VANISHED (tab closed mid-stream, tunnel dropped) — those leak fds and sockets.
    //
    // CRUCIAL: a media element that has buffered enough also stops pulling bytes —
    // sometimes for well over STREAM_IDLE_MS — while staying perfectly connected. That
    // is NOT abandonment; it's normal <audio>/<video> backpressure. Destroying it
    // closed the socket before the promised Content-Length was delivered, which the
    // browser surfaces as NS_ERROR_NET_PARTIAL_TRANSFER and breaks playback. So when
    // the timer fires we check the socket: if it's still alive, the client is just
    // buffering — re-arm and leave it be. We only drop a stream whose socket is gone
    // (and a truly dead socket also fires 'close'/pipeline teardown on its own).
    let idleTimer = null;
    const armIdle = () => {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled) return;
        const sock = res.socket;
        const aliveAndConnected = sock && !sock.destroyed && sock.writable && !res.writableEnded;
        if (aliveAndConnected) {
          // client is connected but not reading right now (buffered ahead) — keep it
          armIdle();
          return;
        }
        console.warn(`[simplex] STREAM IDLE >${STREAM_IDLE_MS}ms, socket gone — dropping abandoned ${kind} read for ${req.path}`);
        try { dec.stream.destroy(); } catch (e) {}
        try { res.destroy(); } catch (e) {}
      }, STREAM_IDLE_MS);
    };
    res.on('drain', armIdle);
    dec.stream.on('data', armIdle);
    armIdle();

    await new Promise((resolve, reject) => {
      pipeline(dec.stream, res, (err) => {
        settle();
        if (err && !['EPIPE', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(err.code)) {
          console.error('[simplex] stream error', err.code || err.message);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  } catch (err) {
    if (!res.headersSent) {
      console.error('[simplex] stream setup error:', err.message);
      res.status(500).end();
    } else {
      res.destroy();
    }
  }
}

/* ============================================================
   FIRST-RUN SEED
   ============================================================ */
function seedDemo(store) {
  const MB = 1e6, day = 864e5, now = Date.now();
  const add = (o) => { const id = uid(); store.insertRow({ id, parent: null, size: 0, date: now, ...o }); return id; };
  add({ name: 'Films', type: 'folder', date: now - 40 * day });
  const music = add({ name: 'Music', type: 'folder', date: now - 60 * day });
  add({ name: 'Photos', type: 'folder', date: now - 22 * day });
  const docs = add({ name: 'Documents', type: 'folder', date: now - 12 * day });
  const albumF = add({ name: 'Nightdrive — LP', type: 'folder', parent: music, date: now - 55 * day });
  [['01 Ignition', 214], ['02 Highway Ghost', 268], ['03 Static Bloom', 191]].forEach(([n, d]) =>
    add({ name: n + '.flac', type: 'audio', parent: albumF, size: (d / 60) * 35 * MB, dur: d, artist: 'Nightdrive', album: 'Nightdrive', date: now - 55 * day }));
  add({ name: 'README.md', type: 'document', parent: docs, size: 200, date: now, lang: 'markdown', content: '# SIMPLEX vault\n\nYour encrypted, private vault. Drag files in to upload.\n' });
}

async function bootstrap() {
  if (sysStmt.countAdmins.get().n > 0) return;
  const admin = createAccount({ username: 'admin', password: ADMIN_DEFAULT_PASSWORD, display: 'Admin', isAdmin: true });
  // If a legacy single-vault DB is present, leave admin empty so `node migrate.js`
  // can import it (with blob encryption + verification) as a deliberate step.
  if (!fs.existsSync(LEGACY_DB_PATH)) seedDemo(openStore(admin.id));
  else console.log('[simplex] legacy vault detected — run `node migrate.js` to import it into the admin account');
  console.log(`[simplex] created admin account (username "admin", password "${ADMIN_DEFAULT_PASSWORD}") — change it in the app`);
}

/* ============================================================
   SESSION (signed cookie carrying the account id)
   ============================================================ */
const SESSION_COOKIE = 'simplex_session';
const SESSION_MAX_AGE = 30 * 864e5;
const SESSION_SECRET = vault.hkdf(MASTER_KEY, 'simplex.session.v2');
function signSession(accountId) {
  const payload = accountId + '.' + Date.now();
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifySession(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [accountId, iat, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(accountId + '.' + iat).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const t = Number(iat);
  if (!Number.isFinite(t) || (Date.now() - t) >= SESSION_MAX_AGE) return null;
  return accountId;
}
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setSessionCookie(req, res, accountId) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  // session-scoped (no Max-Age) so closing the browser ends the session; reload re-checks the cookie
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${signSession(accountId)}; HttpOnly; SameSite=Lax; Path=/` + (secure ? '; Secure' : ''));
}
function clearSessionCookie(req, res) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` + (secure ? '; Secure' : ''));
}

function requireAuth(req, res, next) {
  const accountId = verifySession(getCookie(req, SESSION_COOKIE));
  if (!accountId) return res.status(401).json({ error: 'auth required' });
  const account = sysStmt.getAcct.get(accountId);
  if (!account) return res.status(401).json({ error: 'auth required' });   // account deleted -> client signs out
  // Per-user keys: an enrolled account whose UDK is not RAM-resident (fresh
  // process, session cookie survived the restart) can't read or write its v2
  // data — send the client back through sign-in, which re-caches the UDK.
  // /api/keys/* stays reachable (status + unlock flows live there).
  if (account.key_enrolled && !udkResident(accountId) && !req.path.startsWith('/api/keys/'))
    return res.status(401).json({ error: 'sign in again to unlock your keys', code: 'KEY' });
  // Vault re-encryption in progress: the account is intentionally locked down.
  // Only the key endpoints (status polling) stay reachable. A finished run
  // (phase 'done', lingering briefly for the polling client) does NOT gate.
  const _mig = KEY_MIG.get(accountId);
  if (_mig && _mig.phase !== 'done' && !req.path.startsWith('/api/keys/'))
    return res.status(423).json({ error: 'vault is re-encrypting', code: 'MIGRATING', progress: keyMigProgress(accountId) });
  req.accountId = accountId;
  req.account = account;
  req.store = openStore(accountId);
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.account.is_admin) return res.status(403).json({ error: 'admin only' });
    next();
  });
}

/* ============================================================
   TERMS OF SERVICE — acceptance gate on uploads
   ============================================================
   A versioned agreement every account must accept before adding content to the
   vault (the FIRST upload after the current version is published). Enforced
   identically for the web app and the native iOS app: any write that brings NEW
   bytes into a vault runs through `requireTos`, which 451s with { code:'TOS' }
   until the account has accepted the current version. Acceptance is recorded in
   the account's `prefs` blob (tosVersion + tosAcceptedAt) — the same store the
   appearance prefs use — so it survives and is visible to every client.

   The text + version default to the constants below but an admin can override
   them at runtime via the `tos.text` / `tos.version` settings (bumping the
   version forces everyone to re-accept). */
const TOS_VERSION_DEFAULT = 1;
const TOS_TEXT_DEFAULT = `Simplex — Terms of Service & Acceptable Use

Last updated: 2026-07-22

By uploading, storing, or otherwise adding any content to Simplex (the "Service"),
you agree to these Terms. If you do not agree, do not upload content.

1. NO ILLEGAL CONTENT. You may not upload, store, share, or transmit any content
   that is illegal under any law that applies to you or to the operator of the
   Service, or that you do not have the lawful right to possess and store. This
   includes, without limitation: child sexual abuse material (CSAM); content that
   infringes copyright, trademark, or other intellectual-property rights; stolen
   data, credentials, or trade secrets; malware; content that violates export,
   privacy, or data-protection laws; and content that facilitates violence,
   terrorism, or other serious crimes.

2. YOU ARE RESPONSIBLE AND LIABLE. You are solely responsible for everything you
   upload and store. If illegal or prohibited content is found in your vault, you
   are liable for it. The operator may remove such content, suspend or delete the
   account, preserve relevant records, and report the matter to law enforcement or
   other authorities as required or permitted by law. The Service is provided
   "as is," without warranties, and to the maximum extent permitted by law the
   operator is not liable for your content or for any loss of data.

3. NO AUTHORITY TO POLICE PRIVATE DATA — BUT REMOVAL RIGHTS RESERVED. Vault data
   is encrypted and private. The operator does not routinely inspect it, but
   reserves the right to remove content and terminate access where it becomes
   aware of a violation of these Terms or a legal obligation to act.

4. CHANGES AT ANY TIME. These Terms, the Service, its features, pricing, storage
   limits, and availability may be changed, suspended, or discontinued at any time,
   with or without notice. When these Terms are updated, you will be asked to accept
   the updated version before adding further content. Continued use after a change
   constitutes acceptance.

5. SECURITY & CONDUCT. You may not attempt to breach, overload, disrupt, probe, or
   circumvent the security or access controls of the Service or of other accounts,
   except under a separate written authorization. You may not use the Service to
   harm others or to store content on behalf of anyone in violation of these Terms.

6. ACCOUNT. Keep your credentials secure. You are responsible for activity under
   your account. The operator may suspend or remove accounts that violate these
   Terms.

By tapping "I Agree," you confirm you have read, understood, and agree to these
Terms of Service and Acceptable Use Policy, and that you are responsible and liable
for the content you add to the Service.`;

function tosVersion() {
  const v = parseInt(getSetting('tos.version'), 10);
  return Number.isFinite(v) && v > 0 ? v : TOS_VERSION_DEFAULT;
}
function tosText() {
  const t = getSetting('tos.text');
  return (typeof t === 'string' && t.trim()) ? t : TOS_TEXT_DEFAULT;
}
/* has this account accepted the CURRENT ToS version? reads the prefs blob. */
function tosAccepted(account) {
  if (!account) return false;
  try {
    const p = account.prefs ? JSON.parse(account.prefs) : null;
    return !!p && Number(p.tosVersion) >= tosVersion();
  } catch (e) { return false; }
}
/* middleware: block content-adding writes until the current ToS is accepted.
   Runs AFTER requireAuth (so req.account is set). 451 = "Unavailable For Legal
   Reasons" — the client shows the agreement and calls POST /api/tos/accept. */
function requireTos(req, res, next) {
  if (tosAccepted(req.account)) return next();
  return res.status(451).json({ error: 'You must accept the Terms of Service before uploading.', code: 'TOS', version: tosVersion() });
}

/* ============================================================
   APP
   ============================================================ */
const app = express();
app.set('trust proxy', true);                 // honor CF / proxy x-forwarded-* (secure cookies, real client IP)
app.use(express.json({ limit: '5mb' }));

/* per-request slow-request log + busy-socket marking (ALWAYS ON). */
app.use((req, res, next) => {
  /* Mark this socket BUSY for the life of the request. The socket-idle timeout
     (below, in bootstrap) must NOT destroy a socket that has a request actively
     being handled — e.g. an upload whose body is in, but whose server-side
     encryption (encryptBlob) is still running with no bytes flowing on the wire.
     Destroying that mid-flight cancelled the upload from the client's view while
     the server kept working on an orphaned request, and the abrupt teardown could
     wedge things. We only reclaim sockets with NO in-flight request (a genuinely
     stalled/abandoned client). */
  const sock = req.socket;
  if (sock) sock._sxBusy = (sock._sxBusy || 0) + 1;

  // register in the in-flight map so the loop-block watchdog can name this request
  const reqId = ++_reqSeq;
  req._startedAt = Date.now();
  inFlight.set(reqId, { method: req.method, path: req.path, startedAt: req._startedAt });

  res.on('close', () => {
    inFlight.delete(reqId);
    if (sock && sock._sxBusy) sock._sxBusy--;
    const status = res.statusCode || 0;
    const dur = Date.now() - req._startedAt;
    if (dur >= SLOW_REQ_MS) {
      console.warn(`[simplex] SLOW REQUEST ${req.method} ${req.path} took ${dur}ms (status ${status})`);
    }
  });
  next();
});

/* Exact, version-pinned unpkg assets the app is allowed to load — instead of
   trusting the whole https://unpkg.com origin (which would let ANY script hosted
   there run). CSP host-sources match by path PREFIX, so each entry is the
   versioned package root that scopes the real files we load:
     - react / react-dom / @babel/standalone: the tweaks panel (index.html)
     - three (+ its examples/jsm addons): the 3D model viewer importmap
     - qrcode-generator / jspdf: client tools loaded on demand via ctLoadScript
   When a dependency's version bumps, update it here too or its load is blocked.
   Keep in sync with index.html and the ctLoadScript() URLs in app.js. */
const UNPKG_SCRIPT_SRC = [
  'https://unpkg.com/react@18.3.1/',
  'https://unpkg.com/react-dom@18.3.1/',
  'https://unpkg.com/@babel/standalone@7.29.0/',
  'https://unpkg.com/three@0.169.0/',
  'https://unpkg.com/qrcode-generator@1.4.4/',
  'https://unpkg.com/jspdf@2.5.1/',
].join(' ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // HSTS: tell browsers to use HTTPS-only for a year (incl. subdomains) so a return
  // visitor can't be SSL-stripped/downgraded. Only emit it on a secure request —
  // sending it over plain HTTP is ignored by browsers and could wrongly pin a
  // dev/LAN host that has no TLS. We see the real edge protocol via x-forwarded-proto
  // because `trust proxy` is on (same idiom as the secure-cookie check above).
  // 'preload' is intentionally omitted until the domain is submitted to the HSTS
  // preload list, since it is hard to undo.
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // Per-request nonce for the few inline <script>s we ship (the importmap + the
  // tweaks-boot shim). This replaces 'unsafe-inline' in script-src, so an injected
  // inline <script> or on*= handler that lacks this unguessable nonce won't run.
  // indexHtml() stamps the same value into the page via the __CSP_NONCE__ token.
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;
  // Share pages + their raw media must be embeddable by Discord/Twitter/etc. so a
  // shared link can play inline. Everything else stays frame-locked to same-origin.
  const embeddable = req.path.startsWith('/s/') || req.path.startsWith('/r/') || /^\/api\/shares\/[^/]+\/files\/[^/]+\/(raw|cover)/.test(req.path);
  const frameAncestors = embeddable ? "frame-ancestors *" : "frame-ancestors 'self'";
  if (!embeddable) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // 'unsafe-eval' stays: @babel/standalone transpiles the .jsx tweak files in the
  // browser at runtime, which fundamentally needs eval/new Function. 'unsafe-inline'
  // is gone — inline scripts now carry the nonce above. unpkg is pinned to exact
  // versioned package paths (UNPKG_SCRIPT_SRC) rather than the whole origin.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
    `script-src 'self' 'nonce-${nonce}' 'unsafe-eval' ${UNPKG_SCRIPT_SRC}; connect-src 'self'; ` + frameAncestors + "; base-uri 'self'");
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'private, no-store');
  next();
});

/* ---------- ban enforcement: blocks ALL access from a banned IP ----------
   Mounted before every route/auth gate. The only thing a banned IP can reach is
   its own ban screen. Cheap: a single indexed lookup, short-circuits when clean.
   (ipBanStatus / banScreenHtml are hoisted function declarations defined with the
   login-security section below.) */
app.use((req, res, next) => {
  const status = ipBanStatus(clientIp(req));
  if (!status.banned) return next();
  res.setHeader('Retry-After', Math.max(1, Math.ceil((status.until - Date.now()) / 1000)));
  res.setHeader('Cache-Control', 'no-store');
  // Top-level page navigations get the ban screen HTML; everything else (API/static/
  // raw/share/sub-resources) gets a 403 JSON. Prefer the explicit Sec-Fetch-Mode
  // signal (a real document navigation), falling back to Accept negotiation.
  const navigating = req.method === 'GET' &&
    (req.headers['sec-fetch-mode'] === 'navigate' ||
     (!req.headers['sec-fetch-mode'] && req.accepts(['html', 'json']) === 'html'));
  if (navigating) return res.status(403).type('html').send(banScreenHtml(status.until, status.reason, res.locals.cspNonce));
  return res.status(403).json({ banned: true, until: status.until, reason: status.reason, error: 'access temporarily blocked' });
});

/* fail-closed gate: everything under /api needs a session EXCEPT public login,
   read-only shares, and the Custom API surface (/api/v1, which authenticates with
   an API key via its own requireApiKey middleware instead of the session cookie). */
function isPublicApi(req) {
  if (req.method === 'POST' && req.path === '/api/login') return true;
  // Two-auth step 2 of a sign-in: no session exists yet by definition. The tk
  // ticket (bound to a password check from this IP minutes ago) is the auth.
  if (req.method === 'POST' && req.path === '/api/login/2fa') return true;
  // Forgot password: both halves are for people who can't sign in. Write-only,
  // rate-limited, enumeration-safe; complete() needs the admin-emailed code.
  if (req.method === 'POST' && (req.path === '/api/reset/request' || req.path === '/api/reset/complete')) return true;
  // Crash reports: a client that failed to load may have no session yet, so this
  // must be reachable unauthenticated. It only logs; it touches no vault data.
  if (req.method === 'POST' && req.path === '/api/crash') return true;
  // Open bug-report post: lets an automated assistant (e.g. a security check) file
  // a bug WITHOUT an account. Write-only + rate-limited + length-capped; it can only
  // append a report to the admin inbox, never read or touch vault data.
  if (req.method === 'POST' && req.path === '/api/bugs/open') return true;
  // Self-serve signup: a prospective user has no account yet, so this must be
  // reachable unauthenticated. Write-only + rate-limited + length-capped; it only
  // queues a request for admin approval and touches no vault data.
  if (req.method === 'POST' && req.path === '/api/signup') return true;
  // Health probe: public + unauthenticated liveness check. Reveals no vault data.
  if (req.method === 'GET' && req.path === '/api/health') return true;
  // Terms of Service text: public so the login/signup screens and the app can show
  // the agreement before a session exists. Read-only; touches no vault data.
  if (req.method === 'GET' && req.path === '/api/tos') return true;
  // Restart status: public so a locked / signed-out / just-loaded client can see
  // the "server restarting" state and detect when a fresh process is back up.
  if (req.method === 'GET' && req.path === '/api/restart-status') return true;
  // Custom API: key-authed, not cookie-authed — let it past the session gate so
  // its own requireApiKey/requireScope middleware can run (incl. CORS preflight).
  if (req.path === '/api/v1' || req.path.startsWith('/api/v1/')) return true;
  // public read-only share consumption — allow GET and HEAD (embed crawlers like
  // Discord often probe media with HEAD before fetching; a 401 there kills the embed)
  if ((req.method === 'GET' || req.method === 'HEAD') && /^\/api\/shares\/[^/]+(?:\/files\/[^/]+\/(?:raw|cover))?\/?$/.test(req.path)) return true;
  return false;
}
/* Content-adding writes that must be gated behind ToS acceptance. These bring NEW
   bytes into a vault (the exact thing the agreement covers). Reads, renames, moves,
   trashes, and downloads are NOT gated — only genuine uploads/creations. The convert
   endpoint self-gates (only its save/replace outputs add bytes). */
function needsTos(req) {
  if (req.method !== 'POST') return false;
  return req.path === '/api/files'          // single-shot upload
      || req.path === '/api/uploads/init'   // chunked upload start
      || req.path === '/api/files/doc';     // new text document
}
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (isPublicApi(req)) return next();
  return requireAuth(req, res, () => {
    if (needsTos(req)) return requireTos(req, res, next);
    next();
  });
});

/* ============================================================
   LOGIN SECURITY TIERS + DURABLE PER-IP BANS
   ============================================================
   Three tiers select how harshly a failed sign-in is punished. The TYPED username
   at the login screen selects which account's tier applies; the resulting ban is
   keyed to the requesting IP (you can't ban a username before anyone is authed).
   Unknown/blank usernames fall back to the global default tier (Minimal by default)
   so probing random names can't reveal which exist or trip a harsher policy. The
   401 response is identical across tiers — the only observable difference is the
   ban itself, which only manifests once already over the threshold.

     minimal — lenient legacy throttle: 8 fails -> 30s soft lock.
     limited — 5 fails -> 15-min IP ban + notify all admins to review logs.
     locked  — any fail -> 2-min IP ban; the 5th ban for an IP -> 24-hour ban.

   State lives in the durable ip_bans table so bans (and the Locked escalation
   strike count) survive a restart. A successful sign-in clears the row entirely,
   so a legitimate user who occasionally fumbles a password isn't marched toward a
   long ban over time. */
function clientIp(req) { return req.ip || req.socket.remoteAddress || 'unknown'; }
/* How did this request reach us? Cloudflare adds `cf-connecting-ip` on every
   proxied request, so its presence means the client came in over the safe domain
   (TLS, but a ~100MB/request cap). Its absence means a direct connection (LAN IP /
   tunnel-less), which has no such cap. The client uses this to pick its upload
   strategy: 'cloudflare' => chunk anything over 100MB; 'direct' => no cap. */
function connKind(req) {
  return (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) ? 'cloudflare' : 'direct';
}
const LOGIN_MINIMAL_MAX_FAILS = 8, LOGIN_MINIMAL_LOCK_MS = 30_000;
const LIMITED_MAX_FAILS = 5, LIMITED_BAN_MS = 15 * 60_000;
const LOCKED_BAN_MS = 2 * 60_000, LOCKED_DAY_BAN_MS = 24 * 60 * 60_000, LOCKED_ESCALATE_AT = 5;
const FAILS_DECAY_MS = 10 * 60_000;          // consecutive-fail counter resets after quiet period
const BANCOUNT_DECAY_MS = 24 * 60 * 60_000;  // Locked strike count ages out after a day clean
const VALID_TIERS = new Set(['minimal', 'limited', 'locked']);

function defaultSecurityTier() {
  const t = getSetting('security.default_tier');
  return VALID_TIERS.has(t) ? t : 'minimal';
}
/* current ban status for an IP: { banned, until, reason } */
function ipBanStatus(ip, now = Date.now()) {
  const r = banSys.get.get(ip);
  if (r && r.banned_until > now) return { banned: true, until: r.banned_until, reason: r.reason || 'locked' };
  return { banned: false, until: 0, reason: null };
}
/* Record a failed attempt under the given tier and apply that tier's consequence.
   Returns the (possibly new) ban status so the caller can shape its response. */
function recordLoginFailure(ip, tier, now = Date.now()) {
  const r = banSys.get.get(ip) || { ip, banned_until: 0, ban_count: 0, reason: null, fails: 0, last_fail: 0 };
  // decay stale counters before counting this fail
  if (r.last_fail && now - r.last_fail > FAILS_DECAY_MS) r.fails = 0;
  if (r.last_fail && now - r.last_fail > BANCOUNT_DECAY_MS) r.ban_count = 0;
  r.fails += 1; r.last_fail = now;

  if (tier === 'locked') {
    r.ban_count += 1;
    if (r.ban_count >= LOCKED_ESCALATE_AT) { r.banned_until = now + LOCKED_DAY_BAN_MS; r.reason = 'locked-day'; }
    else { r.banned_until = now + LOCKED_BAN_MS; r.reason = 'locked'; }
    r.fails = 0;
  } else if (tier === 'limited') {
    if (r.fails >= LIMITED_MAX_FAILS) {
      r.banned_until = now + LIMITED_BAN_MS; r.reason = 'limited'; r.fails = 0;
      notifyAllAdmins({
        title: 'Security: IP banned after failed sign-ins',
        body: `${LIMITED_MAX_FAILS} failed sign-in attempts from ${ip} triggered a 15-minute ban (Limited tier). Review the access logs.`,
      });
    }
  } else { // minimal — legacy soft lock
    if (r.fails >= LOGIN_MINIMAL_MAX_FAILS) { r.banned_until = now + LOGIN_MINIMAL_LOCK_MS; r.reason = 'minimal'; r.fails = 0; }
  }
  banSys.upsert.run(r);
  return ipBanStatus(ip, now);
}
function clearIpBan(ip) { banSys.clear.run(ip); }

/* notify EVERY admin account. Notifications are per-account (each account's own
   encrypted vault), so we insert one into each admin's store. Never throws. */
function notifyAllAdmins({ title, body }) {
  try {
    for (const a of sysStmt.listAccts.all()) {
      if (!a.is_admin) continue;
      try { openStore(a.id).notifAdd({ type: 'security', title, body, requires_ack: 0 }); } catch (e) {}
    }
  } catch (e) { console.warn('[simplex] notifyAllAdmins failed', e && e.message); }
}
/* drop a notification into ONE account's vault (notifications are per-account). */
function notifyAccount(accountId, { type, title, body, meta }) {
  if (!accountId || !sysStmt.getAcct.get(accountId)) return;
  try { openStore(accountId).notifAdd({ type: type || 'info', title, body, meta, requires_ack: 0 }); } catch (e) {}
}

/* periodic prune so ip_bans can't grow unbounded: drop rows that are neither
   currently banned nor recently active (so we keep escalation strikes that still matter) */
setInterval(() => {
  const now = Date.now();
  try { banSys.prune.run(now, now - BANCOUNT_DECAY_MS); } catch (e) {}
}, 30 * 60_000).unref();

/* ---------- BAN SCREEN (server-rendered, minimal) ----------
   A banned IP is blocked from EVERYTHING except this screen. HTML GETs get this
   page; all other requests get a 403 JSON. The page shows only a lock, a short
   reason, and a live countdown; it carries the per-request CSP nonce so its tiny
   countdown script runs under our strict script-src. No links, no app chrome. */
function banReasonText(reason) {
  if (reason === 'limited' || reason === 'locked' || reason === 'locked-day' || reason === 'minimal')
    return 'Too many failed sign-in attempts from your network.';
  return 'Access from your network is temporarily blocked.';
}
function banScreenHtml(untilMs, reason, nonce) {
  const remain = Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
  const n = nonce ? ` nonce="${nonce}"` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="dark"/><title>Access blocked</title>
<style${n}>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#1a1714;color:#e8e3da;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .card{max-width:340px;padding:34px 30px;text-align:center}
  .lock{width:46px;height:46px;margin:0 auto 18px;display:flex;align-items:center;justify-content:center;
    border-radius:13px;background:rgba(224,166,74,.12);color:#e0a64a}
  h1{font-size:18px;margin:0 0 8px;font-weight:600}
  p{margin:0 0 20px;color:#a39c8f;font-size:13.5px}
  .timer{font:600 30px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e0a64a;letter-spacing:.04em}
  .sub{margin-top:8px;font-size:11.5px;color:#7d766a;text-transform:uppercase;letter-spacing:.12em}
</style></head><body>
  <div class="card">
    <div class="lock"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
    <h1>Access temporarily blocked</h1>
    <p>${banReasonText(reason)}</p>
    <div class="timer" id="t">--:--</div>
    <div class="sub">try again after the timer</div>
  </div>
  <script${n}>
    var remain = ${remain};
    var el = document.getElementById('t');
    function pad(x){return (x<10?'0':'')+x;}
    function tick(){
      if (remain <= 0){ location.reload(); return; }
      var m = Math.floor(remain/60), s = remain%60;
      el.textContent = pad(m)+':'+pad(s);
      remain--;
    }
    tick(); setInterval(tick, 1000);
  </script>
</body></html>`;
}

app.post('/api/login', async (req, res) => {
  const ip = clientIp(req), now = Date.now();
  // defense in depth: the ban middleware already blocks banned IPs, but re-check here.
  const pre = ipBanStatus(ip, now);
  if (pre.banned) {
    res.setHeader('Retry-After', Math.ceil((pre.until - now) / 1000));
    return res.status(403).json({ banned: true, until: pre.until, reason: pre.reason, error: 'access temporarily blocked' });
  }
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const account = username ? sysStmt.getAcctByName.get(username) : null;
  // The typed username's account selects the policy. Unknown/blank usernames ALWAYS
  // use Minimal — so probing random names can't reveal which exist or trip a harsher
  // tier. (The admin-set `security.default_tier` is persisted as groundwork for a
  // future policy-for-unknowns, but is intentionally a no-op here for now.)
  const tier = account && VALID_TIERS.has(account.security_tier) ? account.security_tier : 'minimal';
  const ok = account ? await vault.verifyPassword(password, account.pw_salt, account.pw_hash) : false;
  if (!ok) {
    recordLoginFailure(ip, tier, now);
    // identical response regardless of tier/outcome — no username enumeration
    return res.status(401).json({ ok: false, error: 'invalid username or password' });
  }
  clearIpBan(ip);   // success wipes fails + escalation strikes for this IP

  // grade the password NOW — this is the only step that sees the plaintext.
  // The verdict rides along (through the 2FA ticket if needed) so the client
  // can raise the forced-change wall after the sign-in completes.
  const pwWeak = isWeakPassword(password, account.username);

  // Per-user keys: enroll or unwrap NOW — the only step that sees the plaintext
  // password. Doing this before the 2FA branch is safe: the UDK lands in server
  // RAM only, and no session exists until the code step passes. keyInfo rides
  // the ticket so finishLogin can report enrollment/lock state to the client.
  let keyInfo = null;
  try { keyInfo = await prepareUserKeys(account, password); }
  catch (e) { console.error('[simplex] key preparation failed for', account.username, e); keyInfo = { error: true }; }

  // Two-auth: if the account has TOTP enabled and this IP is NOT a trusted
  // device (no full sign-in from it since the last manual sign-out), the
  // password alone doesn't get a session — the client must present a code.
  if (account.totp_secret && !ipsSys.get.get(account.id, ip)) {
    const tk = 'l' + crypto.randomBytes(16).toString('hex');
    pending2fa.set(tk, { accountId: account.id, ip, expires: Date.now() + 5 * 60_000, tries: 0, pwWeak, keyInfo });
    return res.json({ ok: true, need2fa: true, tk });
  }
  finishLogin(req, res, account, ip, pwWeak, keyInfo);
});

/* complete a sign-in: session cookie, trust the IP, analytics, weak-pw flag.
   pwWeak is COMPUTED BY THE CALLER at the step that actually saw the plaintext
   password — /api/login. The 2FA step's body has no password (just tk + code),
   so grading req.body here would grade an empty string and flag every
   two-auth sign-in as weak (that exact bug shipped once). */
function finishLogin(req, res, account, ip, pwWeak, keyInfo) {
  setSessionCookie(req, res, account.id);
  try { ipsSys.upsert.run({ account_id: account.id, ip, now: Date.now() }); } catch (e) {}
  const store = openStore(account.id);
  try { store.analyticsLog('session', null); } catch (e) {}   // record sign-in for the Analytics app
  // keys: how the sign-in left the per-user key state. The recovery key is
  // NEVER sent here — it stays sealed server-side until explicitly revealed
  // from Settings (POST /api/keys/reveal).
  const keys = keyInfo ? {
    enrolled: !!(keyInfo.enrolled || keyInfo.ok || keyInfo.locked),
    justEnrolled: !!keyInfo.enrolled,     // first sign-in since the key update — client shows a light note
    locked: !!keyInfo.locked,             // wrap rides an older password — client offers unlock
    stale: !!keyInfo.stale,               // wrap works but rides the pre-change password — suggest swap
  } : null;
  res.json({
    ok: true, account: acctToApi(account), used: store.usedBytes(), conn: connKind(req),
    pwWeak: !!pwWeak, keys, startedAt: BACKEND_STARTED_AT, vaultBornAt: VAULT_BORN_AT, ...restartInfo(),
  });
}

/* step 2 of a two-auth sign-in. The tk ties this to a password that already
   verified from this IP minutes ago; failures count toward the IP-ban tiers
   like password failures do, so codes can't be brute-forced politely. */
const pending2fa = new Map();   // tk -> { accountId, ip, expires, tries }
setInterval(() => { const now = Date.now(); for (const [k, v] of pending2fa) if (v.expires < now) pending2fa.delete(k); }, 60_000).unref();
app.post('/api/login/2fa', (req, res) => {
  const ip = clientIp(req);
  const tk = String((req.body && req.body.tk) || '');
  const code = String((req.body && req.body.code) || '');
  const p = pending2fa.get(tk);
  if (!p || p.expires < Date.now() || p.ip !== ip) {
    pending2fa.delete(tk);
    return res.status(401).json({ error: 'sign-in expired — start over' , restart: true });
  }
  const account = sysStmt.getAcct.get(p.accountId);
  if (!account || !account.totp_secret) { pending2fa.delete(tk); return res.status(401).json({ error: 'sign-in expired — start over', restart: true }); }
  if (!totpVerify(account.id, account.totp_secret, code)) {
    p.tries++;
    if (p.tries >= 6) {
      pending2fa.delete(tk);
      const tier = VALID_TIERS.has(account.security_tier) ? account.security_tier : 'minimal';
      recordLoginFailure(ip, tier, Date.now());
      return res.status(401).json({ error: 'too many wrong codes — start over', restart: true });
    }
    return res.status(401).json({ error: 'wrong code — try again' });
  }
  pending2fa.delete(tk);
  // the weak-password verdict and key state were computed at step 1 (the only
  // step that saw the plaintext) and stored on the ticket — pass them through.
  finishLogin(req, res, account, ip, p.pwWeak, p.keyInfo);
});

app.post('/api/logout', (req, res) => {
  // MANUAL sign-out (the client only calls this from the Sign out button —
  // reloads don't hit it): untrust this IP so the next sign-in from here
  // requires two-auth again. Resolve the account BEFORE clearing the cookie.
  try {
    const accountId = verifySession(getCookie(req, SESSION_COOKIE));
    if (accountId) ipsSys.del.run(accountId, clientIp(req));
  } catch (e) {}
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

/* ---------- forgot password (public, admin-mediated email loop) ----------
   No SMTP here: the request lands in an admin queue; an admin generates a
   one-time code and emails it to the account's recovery address by hand;
   the user finishes with username + code + new password. Responses never
   reveal whether a username/email exists. */
app.post('/api/reset/request', (req, res) => {
  const ip = clientIp(req);
  if (!signupRateOk(ip)) return res.status(429).json({ error: 'too many requests — try again later' });
  const username = String((req.body && req.body.username) || '').trim();
  const account = username ? sysStmt.getAcctByName.get(username) : null;
  if (account) {
    // collapse duplicates: one live request per account
    resetSys.delForAcct.run(account.id);
    resetSys.insert.run({ id: 'r' + crypto.randomBytes(6).toString('hex'), account_id: account.id, created: Date.now(), ip });
    notifyAllAdmins({
      title: 'Password reset requested',
      body: `@${account.username} forgot their password${account.email ? ` — email a reset code to ${account.email}` : ' (no recovery email on file!)'}. Manage accounts → Security.`,
    });
  }
  res.json({ ok: true });   // same answer either way — no enumeration
});
app.post('/api/reset/complete', async (req, res) => {
  const ip = clientIp(req);
  if (!signupRateOk(ip)) return res.status(429).json({ error: 'too many requests — try again later' });
  const username = String((req.body && req.body.username) || '').trim();
  const code = String((req.body && req.body.code) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (isWeakPassword(password, username)) return res.status(400).json({ error: 'pick a stronger password — at least 6 characters, not a common one' });
  const account = username ? sysStmt.getAcctByName.get(username) : null;
  const r = account ? resetSys.pendingForAcct.get(account.id) : null;
  const valid = r && r.status === 'sent' && r.code_hash && r.code_expires > Date.now()
    && await vault.verifyPassword(code.toUpperCase(), r.code_salt, r.code_hash);
  if (!valid) {
    recordLoginFailure(ip, 'minimal', Date.now());
    return res.status(400).json({ error: 'invalid or expired reset code' });
  }
  const { salt, hash } = vault.hashPassword(password);
  sys.prepare(`UPDATE accounts SET ${buildSetClause('accounts', ['pw_salt = @pw_salt', 'pw_hash = @pw_hash'])} WHERE id = @id`)
    .run({ pw_salt: salt, pw_hash: hash, id: account.id });
  // the key wrap still rides the FORGOTTEN password — at the next sign-in the
  // client offers the recovery-code unlock, which rewraps under this new one.
  markWrapStale(account.id);
  resetSys.delForAcct.run(account.id);
  bumpAccounts();
  notifyAccount(account.id, { type: 'security', title: 'Password was reset', body: 'Your password was changed using an emailed reset code. If this wasn\'t you, tell an admin immediately.' });
  res.json({ ok: true });
});

/* ---------- self-serve signup (public, queued for admin approval) ----------
   A prospective user submits username/display/password/email/explanation + a rough
   storage estimate. We hash the password immediately (plaintext is never stored) and
   queue a `signups` row; an admin approves (auto-creates the account) or rejects
   (deletes the row) from the admin panel. Hardened like the other public endpoints:
   per-IP rate limit, length caps, username validation, and dedupe against existing
   accounts + pending requests. Also gated by the ban middleware. */
const signupRate = new Map();   // ip -> { count, windowStart }
const SIGNUP_WINDOW_MS = 60 * 60_000, SIGNUP_MAX_PER_WINDOW = 5;
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of signupRate) if (now - r.windowStart > SIGNUP_WINDOW_MS) signupRate.delete(ip);
}, SIGNUP_WINDOW_MS).unref();
function signupRateOk(ip) {
  const now = Date.now();
  let r = signupRate.get(ip);
  if (!r || now - r.windowStart > SIGNUP_WINDOW_MS) { r = { count: 0, windowStart: now }; signupRate.set(ip, r); }
  r.count++;
  return r.count <= SIGNUP_MAX_PER_WINDOW;
}
app.post('/api/signup', (req, res) => {
  const ip = clientIp(req);
  if (!signupRateOk(ip)) return res.status(429).json({ error: 'too many requests — try again later' });
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'username must be 1–32 chars: letters, numbers, . _ -' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  // Don't reveal whether the name is taken vs already requested — same neutral message.
  if (sysStmt.getAcctByName.get(username) || signupSys.byUsername.get(username))
    return res.status(409).json({ error: 'that username is unavailable' });
  let gb = parseFloat(b.requested_gb);
  if (!Number.isFinite(gb) || gb < 0) gb = null; else gb = Math.min(gb, 100000);   // sanity cap
  const { salt, hash } = vault.hashPassword(password);
  signupSys.insert.run({
    id: 's' + crypto.randomBytes(6).toString('hex'),
    created: Date.now(),
    username,
    display: clip(b.display, 80) || null,
    email: clip(b.email, 200) || null,
    explanation: clip(b.explanation, 2000) || null,
    requested_gb: gb,
    pw_salt: salt, pw_hash: hash,
    ip,
  });
  // let admins know a request is waiting (non-fatal)
  notifyAllAdmins({ title: 'New account request', body: `@${username} requested an account. Review it in Manage accounts → Security.` });
  res.json({ ok: true });
});

/* ---------- client crash reports ----------
   The browser boot guard (boot-guard.js) POSTs here when the app fails to load
   or throws — exactly the "page won't load but the console looks clean" case.
   We log it (so these failures are finally visible) and append a capped line to
   vault/crash.log. Unauthenticated by design: a client that never finished
   loading may have no session. Hardened against abuse: per-IP rate limit, field
   length caps, a single bounded log file. Never throws — reporting must not
   itself become a failure. */
const CRASH_LOG_PATH = path.join(VAULT_DIR, 'crash.log');
const CRASH_LOG_MAX_BYTES = 5 * 1024 * 1024;   // rotate (truncate) past 5MB so logs can't fill the disk
const crashRate = new Map();                    // ip -> { count, windowStart }
const CRASH_WINDOW_MS = 60_000, CRASH_MAX_PER_WINDOW = 20;
setInterval(() => {                             // prune idle IPs so the map can't grow unbounded
  const now = Date.now();
  for (const [ip, r] of crashRate) if (now - r.windowStart > CRASH_WINDOW_MS) crashRate.delete(ip);
}, CRASH_WINDOW_MS).unref();

function crashRateOk(ip) {
  const now = Date.now();
  let r = crashRate.get(ip);
  if (!r || now - r.windowStart > CRASH_WINDOW_MS) { r = { count: 0, windowStart: now }; crashRate.set(ip, r); }
  r.count++;
  return r.count <= CRASH_MAX_PER_WINDOW;
}
function clip(v, n) { return v == null ? '' : String(v).slice(0, n); }

app.post('/api/crash', (req, res) => {
  try {
    const ip = clientIp(req);
    if (!crashRateOk(ip)) return res.status(429).json({ ok: false });
    const b = req.body || {};
    const report = {
      ts: new Date().toISOString(),
      ip,
      kind: clip(b.kind, 40),
      stage: clip(b.stage, 60),
      message: clip(b.message, 1000),
      source: clip(b.source, 500),
      line: Number.isFinite(b.line) ? b.line : null,
      booted: !!b.booted,
      online: b.online !== false,
      url: clip(b.url, 500),
      ua: clip(b.ua, 300),
      stack: clip(b.stack, 4000),
    };
    // surface in the server log (this is the whole point — these were invisible before).
    // 'resource' = a non-fatal 404'd asset; 'clientdiag' = the browser watchdog
    // reporting a frozen/leaking TAB (main-thread block or heap/DOM growth) — neither
    // is a server crash, so label them distinctly. The full sample ring is in `stack`.
    const label = report.kind === 'resource' ? 'CLIENT RESOURCE FAIL'
      : report.kind === 'clientdiag' ? 'CLIENT TAB DIAG'
      : 'CLIENT CRASH';
    const where = report.source ? ` src=${report.source}` : '';
    console.warn(`[simplex] ${label} (${report.kind}) stage=${report.stage} online=${report.online} ip=${ip}${where} :: ${report.message}`);
    try {
      // truncate-on-overflow keeps the file bounded without external logrotate
      let size = 0; try { size = fs.statSync(CRASH_LOG_PATH).size; } catch (e) {}
      if (size > CRASH_LOG_MAX_BYTES) { try { fs.truncateSync(CRASH_LOG_PATH, 0); } catch (e) {} }
      fs.appendFileSync(CRASH_LOG_PATH, JSON.stringify(report) + '\n');
    } catch (e) { /* disk full / readonly — logging to console above is enough */ }
    res.json({ ok: true });
  } catch (e) {
    res.status(204).end();   // never let the crash reporter itself error out
  }
});

/* ---------- health probe ----------
   Public + unauthenticated liveness check. A plain 200 means the process is up
   and the event loop is responsive enough to answer. Reveals no vault data. */
const BACKEND_STARTED_AT = Date.now();
// The day the vault was first created — used for the lifetime "Uptime" stat (as
// opposed to "Last Restart", which counts from BACKEND_STARTED_AT). Overridable
// via env if the install date differs.
const VAULT_BORN_AT = (() => {
  const env = Date.parse(process.env.SX_VAULT_BORN || '');
  return Number.isFinite(env) ? env : Date.parse('2026-05-28T00:00:00Z');
})();

/* ============================================================
   RESTART SYSTEM

   Restarts exist to pick up code/backend changes: the process exits with
   RESTART_EXIT_CODE (87) and the run.js supervisor relaunches a fresh server.
   Two ways to trigger one:
     - SCHEDULED: at admin-configured weekly slots (default Mon 09:00 + Fri 12:00).
     - MANUAL:    admin hits POST /api/restart.

   When a restart is initiated we DON'T exit immediately. We flip `restarting`
   on first, so for a short grace window every poll/health/status response tells
   connected clients (and anyone who joins/reloads) that a restart is in
   progress — that's what drives the client's "gate" overlay. After the grace
   window we exit(87); the supervisor brings a new process up with a fresh
   BACKEND_STARTED_AT, and clients (who keep polling /api/restart-status through
   the downtime) see the new startedAt and hard-reload everyone.
   ============================================================ */
const RESTART_EXIT_CODE = 87;     // must match RESTART_EXIT_CODE in run.js
// Grace window between "restart requested" and the process actually exiting.
// Must comfortably exceed the client poll interval (10s) so at least one poll lands
// inside the window, catches `restarting:true`, and raises the gate before the socket
// drops. Tunable for testing.
const RESTART_GRACE_MS = Number(process.env.SX_RESTART_GRACE_MS) || 12000;

const restartState = {
  restarting: false,
  startedAt: 0,          // when the restart was requested (server clock)
  reason: null,          // 'scheduled' | 'manual'
  by: null,              // display/username of the admin who triggered a manual restart
  etaAt: 0,              // approx wall-clock the process will exit
};

/* Public snapshot every response can cheaply spread in. */
function restartInfo() {
  return restartState.restarting
    ? { restarting: true, restartReason: restartState.reason, restartBy: restartState.by, restartEtaAt: restartState.etaAt, restartSince: restartState.startedAt }
    : { restarting: false };
}

let _restartTimer = null;
function beginRestart(reason, by) {
  if (restartState.restarting) return restartState;   // already in progress — idempotent
  restartState.restarting = true;
  restartState.startedAt = Date.now();
  restartState.reason = reason || 'manual';
  restartState.by = by || null;
  restartState.etaAt = Date.now() + RESTART_GRACE_MS;
  console.log(`[simplex] RESTART requested (${restartState.reason}${by ? ' by ' + by : ''}) — exiting in ${RESTART_GRACE_MS}ms to relaunch.`);
  try { if (DIAG_ENABLED) diagWrite(`[${new Date().toISOString()}] ### RESTART (${restartState.reason}${by ? ' by ' + by : ''}) grace=${RESTART_GRACE_MS}ms`); } catch (e) {}

  // NOTE: these timers are intentionally NOT unref()'d. After httpServer.close()
  // the listening socket no longer holds the event loop open, so an unref'd timer
  // would let Node exit ON ITS OWN with code 0 before our timer fires — and the
  // supervisor would treat 0 as a clean stop and NOT relaunch. Keeping them ref'd
  // guarantees the process stays alive just long enough to exit with code 87.
  _restartTimer = setTimeout(() => {
    console.log('[simplex] RESTART grace elapsed — exiting for relaunch.');
    // Stop accepting new connections; existing clients are already showing the
    // gate and re-polling, so we don't need to drain them gracefully. A short
    // hard-exit fallback guarantees we go even if a socket refuses to close.
    try { if (httpServer) httpServer.close(); } catch (e) {}
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 800);
  }, RESTART_GRACE_MS);
  return restartState;
}

/* ---------- weekly scheduled restart (admin-customizable) ----------
   Restarts fire at configured wall-clock (server-local) times on chosen weekdays,
   e.g. Mon 09:00 + Fri 12:00. Stored as JSON in the system settings table under
   `restart.schedule`: { enabled: bool, slots: [{ day: 0-6 (0=Sun), time: "HH:MM" }] }.
   Admins read/write it via /api/restart-schedule. A 30s ticker checks the current
   slot and fires once per matching minute (deduped by a slot key), mirroring how the
   per-account connector schedule engine works. */
const DEFAULT_RESTART_SCHEDULE = {
  enabled: true,
  slots: [
    { day: 1, time: '09:00' },   // Monday 9:00 AM
    { day: 5, time: '12:00' },   // Friday 12:00 PM
  ],
};
function normalizeRestartSchedule(raw) {
  const out = { enabled: true, slots: [] };
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_RESTART_SCHEDULE };
  out.enabled = raw.enabled !== false;   // default on
  const slots = Array.isArray(raw.slots) ? raw.slots : [];
  for (const s of slots) {
    if (!s || typeof s !== 'object') continue;
    const day = Number(s.day);
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s.time || '').trim());
    if (!Number.isInteger(day) || day < 0 || day > 6 || !m) continue;
    const hh = Number(m[1]), mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) continue;
    out.slots.push({ day, time: String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') });
  }
  // de-dupe identical day+time entries
  const seen = new Set();
  out.slots = out.slots.filter(s => { const k = s.day + '@' + s.time; if (seen.has(k)) return false; seen.add(k); return true; });
  return out;
}
function getRestartSchedule() {
  const raw = getSetting('restart.schedule');
  if (raw == null) return { ...DEFAULT_RESTART_SCHEDULE };
  try { return normalizeRestartSchedule(JSON.parse(raw)); } catch (e) { return { ...DEFAULT_RESTART_SCHEDULE }; }
}
function saveRestartSchedule(sched) {
  const norm = normalizeRestartSchedule(sched);
  setSetting('restart.schedule', JSON.stringify(norm));
  return norm;
}

let _lastRestartSlotFired = null;   // "Y-M-D@HH:MM" of the last slot we restarted on (dedupe)
function checkScheduledRestart() {
  if (restartState.restarting) return;
  let sched;
  try { sched = getRestartSchedule(); } catch (e) { return; }
  if (!sched.enabled || !sched.slots.length) return;
  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const dow = now.getDay();
  const match = sched.slots.find(s => s.day === dow && s.time === hhmm);
  if (!match) return;
  const slotKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}@${hhmm}`;
  if (_lastRestartSlotFired === slotKey) return;   // already fired this minute
  _lastRestartSlotFired = slotKey;
  console.log(`[simplex] scheduled restart slot hit (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow]} ${hhmm}).`);
  beginRestart('scheduled');
}
// Set SX_RESTART_SCHEDULE_OFF=1 to disable the scheduler entirely (e.g. tests).
if (process.env.SX_RESTART_SCHEDULE_OFF !== '1') {
  const t = setInterval(() => runTracked('restartScheduler', checkScheduledRestart), 30_000);
  if (t.unref) t.unref();
  const s = getRestartSchedule();
  console.log(`[simplex] weekly restart scheduler armed (${s.enabled ? s.slots.length + ' slot(s)' : 'disabled'}).`);
}

/* Public, unauthenticated restart status. New/locked/just-loaded clients hit
   this to learn whether a restart is in progress (raise the gate immediately)
   and to detect when a fresh process is up (startedAt changed -> hard reload).
   Deliberately reveals nothing but liveness + restart flags. */
app.get('/api/restart-status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, startedAt: BACKEND_STARTED_AT, ...restartInfo() });
});

/* Manual restart — admin only. Returns immediately; the actual exit happens
   after the grace window so this client (and others) can raise the gate first. */
app.post('/api/restart', requireAdmin, (req, res) => {
  const who = req.account ? (req.account.display || req.account.username) : null;
  beginRestart('manual', who);
  res.json({ ok: true, ...restartInfo() });
});

/* Weekly scheduled-restart config — admin only. GET returns the current schedule;
   PATCH replaces it ({ enabled?, slots: [{day,time}] }). Times are server-local. */
app.get('/api/restart-schedule', requireAdmin, (req, res) => {
  res.json({ ok: true, schedule: getRestartSchedule() });
});
app.patch('/api/restart-schedule', requireAdmin, (req, res) => {
  const b = req.body || {};
  // accept a full schedule object, or just {slots} / {enabled}
  const cur = getRestartSchedule();
  const next = saveRestartSchedule({
    enabled: b.enabled !== undefined ? !!b.enabled : cur.enabled,
    slots: b.slots !== undefined ? b.slots : cur.slots,
  });
  _lastRestartSlotFired = null;   // let an edited slot fire even within the same minute
  res.json({ ok: true, schedule: next });
});

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, uptime: Date.now() - BACKEND_STARTED_AT, startedAt: BACKEND_STARTED_AT, vaultBornAt: VAULT_BORN_AT, ...restartInfo() });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ account: acctToApi(req.account), used: req.store.usedBytes(), conn: connKind(req), startedAt: BACKEND_STARTED_AT, vaultBornAt: VAULT_BORN_AT, ...restartInfo() });
});

/* lightweight polling endpoint for live auto-update. Returns current revisions
   so the client can decide whether to re-fetch files / the account list. */
/* Poll cache to avoid hammering DB with synchronous reads every 4 seconds.
   The browser polls /api/poll every 10s. If we do sync DB reads there and
   there's any lock contention, the event loop blocks. Instead, we cache
   poll data and update it in the background. */
const pollCache = new Map();  // account ID -> { used, notifUnread, cachedAt }
const POLL_CACHE_TTL_MS = 1000;  // 1 second cache (fresher than polling interval)

function invalidatePollCache(accountId) {
  if (accountId) pollCache.delete(accountId);
  else pollCache.clear();  // clear all if no account specified
}

function getPollData(store, accountId) {
  const now = Date.now();
  const cached = pollCache.get(accountId);
  if (cached && (now - cached.cachedAt) < POLL_CACHE_TTL_MS) {
    return cached;  // still fresh
  }
  // update cache (sync DB reads, but only when cache misses)
  const data = { used: store.usedBytes(), notifUnread: store.notifUnread(), cachedAt: now };
  pollCache.set(accountId, data);
  return data;
}

app.get('/api/poll', requireAuth, (req, res) => {
  const poll = getPollData(req.store, req.account.id);
  res.json({
    filesRev: req.store.rev,
    accountsRev,
    account: acctToApi(req.account),
    used: poll.used,
    notifUnread: poll.notifUnread,
    ...restartInfo(),
  });
});

/* self-service: change own display / password */
app.patch('/api/accounts/me', requireAuth, (req, res) => {
  const b = req.body || {};
  const fields = [], vals = {};
  if (typeof b.display === 'string' && b.display.trim()) { fields.push('display = @display'); vals.display = b.display.trim(); }
  if (typeof b.password === 'string' && b.password.length) {
    // password changes are safety-gated: never accept a weak one, and with
    // two-auth active the change requires a fresh TOTP code.
    if (isWeakPassword(b.password, req.account.username))
      return res.status(400).json({ error: 'pick a stronger password — at least 6 characters, not a common one' });
    if (req.account.totp_secret && !totpVerify(req.account.id, req.account.totp_secret, b.totp))
      return res.status(403).json({ error: 'two-auth code required', need2fa: true });
    const { salt, hash } = vault.hashPassword(b.password);
    fields.push('pw_salt = @pw_salt', 'pw_hash = @pw_hash'); vals.pw_salt = salt; vals.pw_hash = hash;
    // per policy the key wrap does NOT follow a password change — the user
    // swaps it manually (Settings → Safety), or unlocks with the previous
    // password at their next fresh sign-in. Flag it so the UI can nudge.
    markWrapStale(req.accountId);
  }
  // appearance prefs (accent / theme / fonts) — small JSON blob, validated + size-capped
  if (b.prefs && typeof b.prefs === 'object' && !Array.isArray(b.prefs)) {
    const json = JSON.stringify(b.prefs);
    if (json.length <= 4000) { fields.push('prefs = @prefs'); vals.prefs = json; }
  }
  if (fields.length) { vals.id = req.accountId; sys.prepare(`UPDATE accounts SET ${buildSetClause('accounts', fields)} WHERE id = @id`).run(vals); bumpAccounts(); }
  res.json({ ok: true, account: acctToApi(sysStmt.getAcct.get(req.accountId)) });
});

/* ============================================================
   TERMS OF SERVICE endpoints
   ============================================================ */
/* Public: fetch the current agreement (version + text). No auth so the login /
   signup screens and the app can show it before a session exists. */
app.get('/api/tos', (req, res) => {
  res.json({ version: tosVersion(), text: tosText() });
});

/* Auth: the signed-in account accepts the current version. Records
   tosVersion + tosAcceptedAt into the prefs blob, preserving existing prefs. */
app.post('/api/tos/accept', requireAuth, (req, res) => {
  const acct = sysStmt.getAcct.get(req.accountId);
  let prefs = {};
  try { prefs = acct && acct.prefs ? JSON.parse(acct.prefs) : {}; } catch (e) { prefs = {}; }
  prefs.tosVersion = tosVersion();
  prefs.tosAcceptedAt = Date.now();
  const json = JSON.stringify(prefs);
  if (json.length <= 4000) {
    sys.prepare('UPDATE accounts SET prefs = @prefs WHERE id = @id').run({ prefs: json, id: req.accountId });
    bumpAccounts();
  }
  res.json({ ok: true, accepted: true, version: tosVersion(), account: acctToApi(sysStmt.getAcct.get(req.accountId)) });
});

/* Admin: read/update the ToS text + bump the version (bumping forces everyone to
   re-accept before their next upload). */
app.get('/api/admin/tos', requireAdmin, (req, res) => {
  res.json({ version: tosVersion(), text: tosText(), isDefault: !getSetting('tos.text') });
});
app.patch('/api/admin/tos', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (typeof b.text === 'string' && b.text.trim().length >= 20 && b.text.length <= 20000) {
    setSetting('tos.text', b.text);
  }
  if (b.bump === true) {
    setSetting('tos.version', String(tosVersion() + 1));
  } else if (Number.isFinite(parseInt(b.version, 10)) && parseInt(b.version, 10) > 0) {
    setSetting('tos.version', String(parseInt(b.version, 10)));
  }
  res.json({ ok: true, version: tosVersion(), text: tosText() });
});

/* ============================================================
   ACCOUNT SAFETY — email, safety level, two-auth setup, captcha
   ============================================================ */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* set/change the recovery email. With two-auth active, requires a code. */
app.post('/api/me/email', requireAuth, (req, res) => {
  const email = String((req.body && req.body.email) || '').trim();
  if (email && (email.length > 200 || !EMAIL_RE.test(email))) return res.status(400).json({ error: 'that does not look like an email address' });
  if (req.account.totp_secret && !totpVerify(req.account.id, req.account.totp_secret, req.body && req.body.totp))
    return res.status(403).json({ error: 'two-auth code required', need2fa: true });
  if (!email && req.account.totp_secret)
    return res.status(400).json({ error: 'two-auth requires an email on file — disable two-auth first' });
  const fields = ['email = @email'], vals = { email: email || null, id: req.accountId };
  // removing the email demotes moderate -> minimal (derived by effectiveSafety anyway)
  if (!email) { fields.push('safety = @safety'); vals.safety = 'minimal'; }
  sys.prepare(`UPDATE accounts SET ${buildSetClause('accounts', fields)} WHERE id = @id`).run(vals);
  bumpAccounts();
  res.json({ ok: true, account: acctToApi(sysStmt.getAcct.get(req.accountId)) });
});

/* pick a safety level. minimal/moderate directly; maximum only ever happens
   through the two-auth wizard (2fa/enable sets it). Stepping DOWN from
   maximum requires a fresh code and switches two-auth off. */
app.post('/api/me/safety', requireAuth, (req, res) => {
  const level = String((req.body && req.body.level) || '');
  if (!['minimal', 'moderate'].includes(level)) return res.status(400).json({ error: 'invalid safety level (maximum is set by completing two-auth setup)' });
  if (level === 'moderate' && !req.account.email) return res.status(400).json({ error: 'moderate safety needs a recovery email first' });
  const fields = ['safety = @safety'], vals = { safety: level, id: req.accountId };
  if (req.account.totp_secret) {   // leaving maximum: turn two-auth off, code required
    if (!totpVerify(req.account.id, req.account.totp_secret, req.body && req.body.totp))
      return res.status(403).json({ error: 'two-auth code required', need2fa: true });
    fields.push('totp_secret = @totp_secret'); vals.totp_secret = null;
  }
  sys.prepare(`UPDATE accounts SET ${buildSetClause('accounts', fields)} WHERE id = @id`).run(vals);
  bumpAccounts();
  res.json({ ok: true, account: acctToApi(sysStmt.getAcct.get(req.accountId)) });
});

/* two-auth setup, step 1: mint (or re-mint — the "Regenerate" button) a
   pending secret. Returns the secret + otpauth URI for the QR / text view.
   Requires an email on file (the safety ladder: max needs moderate). */
app.post('/api/me/2fa/begin', requireAuth, (req, res) => {
  if (!req.account.email) return res.status(400).json({ error: 'set a recovery email before enabling two-auth' });
  const secret = newTotpSecret();
  sys.prepare(`UPDATE accounts SET ${buildSetClause('accounts', ['totp_pending = @totp_pending'])} WHERE id = @id`)
    .run({ totp_pending: secret, id: req.accountId });
  res.json({ ok: true, secret, otpauth: otpauthUri(req.account, secret) });
});
/* step 2: prove the authenticator has the secret (does NOT activate yet —
   the human test + captcha still follow client-side). */
app.post('/api/me/2fa/verify', requireAuth, (req, res) => {
  const a = sysStmt.getAcct.get(req.accountId);
  if (!a.totp_pending) return res.status(400).json({ error: 'no two-auth setup in progress' });
  if (!totpVerify(a.id + ':pending', a.totp_pending, req.body && req.body.code))
    return res.status(400).json({ error: 'wrong code — check your authenticator app' });
  res.json({ ok: true });
});
/* final step: captcha token + a valid code flips the pending secret live and
   sets safety to maximum. Trusts the current IP so this device stays easy. */
app.post('/api/me/2fa/enable', requireAuth, (req, res) => {
  const a = sysStmt.getAcct.get(req.accountId);
  if (!a.totp_pending) return res.status(400).json({ error: 'no two-auth setup in progress' });
  // check the captcha token WITHOUT consuming it yet: if the TOTP rotated during
  // the captcha, the client asks for a fresh code and retries with the same token.
  const capTok = String((req.body && req.body.captcha) || '');
  const capExp = captchaTokens.get(capTok);
  if (!capExp || capExp < Date.now()) return res.status(403).json({ error: 'captcha expired — try that step again', captcha: true });
  if (!totpVerify(a.id + ':enable', a.totp_pending, req.body && req.body.code))
    return res.status(400).json({ error: 'code expired — enter a fresh one from your app', code: true });
  captchaTokens.delete(capTok);   // success: token is spent
  sys.prepare(`UPDATE accounts SET ${buildSetClause('accounts', ['totp_secret = @totp_secret', 'totp_pending = @totp_pending', 'safety = @safety'])} WHERE id = @id`)
    .run({ totp_secret: a.totp_pending, totp_pending: null, safety: 'maximum', id: a.id });
  try { ipsSys.upsert.run({ account_id: a.id, ip: clientIp(req), now: Date.now() }); } catch (e) {}
  bumpAccounts();
  res.json({ ok: true, account: acctToApi(sysStmt.getAcct.get(a.id)) });
});
/* turn two-auth off (also reachable via /api/me/safety) — code required. */
app.post('/api/me/2fa/disable', requireAuth, (req, res) => {
  const a = sysStmt.getAcct.get(req.accountId);
  if (!a.totp_secret) return res.json({ ok: true, account: acctToApi(a) });
  if (!totpVerify(a.id, a.totp_secret, req.body && req.body.code))
    return res.status(403).json({ error: 'two-auth code required', need2fa: true });
  sys.prepare(`UPDATE accounts SET ${buildSetClause('accounts', ['totp_secret = @totp_secret', 'safety = @safety'])} WHERE id = @id`)
    .run({ totp_secret: null, safety: a.email ? 'moderate' : 'minimal', id: a.id });
  bumpAccounts();
  res.json({ ok: true, account: acctToApi(sysStmt.getAcct.get(a.id)) });
});

/* the native captcha pair (see newCaptcha above). Issuance is throttled per
   account so nobody can harvest an unlimited sample set of our stroke font
   to train a solver against. 20 per 5 minutes is far beyond human need. */
const capIssue = new Map();   // accountId -> { count, windowStart }
setInterval(() => { const now = Date.now(); for (const [k, r] of capIssue) if (now - r.windowStart > 5 * 60_000) capIssue.delete(k); }, 5 * 60_000).unref();
app.get('/api/captcha', requireAuth, (req, res) => {
  const now = Date.now();
  let r = capIssue.get(req.accountId);
  if (!r || now - r.windowStart > 5 * 60_000) { r = { count: 0, windowStart: now }; capIssue.set(req.accountId, r); }
  if (++r.count > 20) return res.status(429).json({ error: 'too many captchas — take a breath and try again in a few minutes' });
  const { id, svg } = newCaptcha();
  res.json({ id, svg });
});
app.post('/api/captcha/verify', requireAuth, (req, res) => {
  const token = checkCaptcha(String((req.body && req.body.id) || ''), req.body && req.body.answer);
  if (!token) return res.status(400).json({ error: 'wrong answer — here\'s a fresh one', retry: true });
  res.json({ ok: true, token });
});

/* ============================================================
   PER-USER KEYS — status, unlock, swap, recovery, re-encryption
   (all under /api/keys/, which requireAuth exempts from the
   resident-UDK and migration gates so these flows stay reachable)
   ============================================================ */
app.get('/api/keys/status', requireAuth, (req, res) => {
  const a = req.account;
  let legacy = { rows: 0, files: 0, bytes: 0 };
  try {
    const r = req.store.db.prepare(
      "SELECT COUNT(*) c, COALESCE(SUM(CASE WHEN type != 'folder' THEN 1 ELSE 0 END), 0) f, COALESCE(SUM(CASE WHEN type != 'folder' THEN size ELSE 0 END), 0) b FROM files WHERE kv = 1").get();
    legacy = { rows: r.c, files: r.f, bytes: r.b };
  } catch (e) {}
  res.json({
    enrolled: !!a.key_enrolled, resident: udkResident(req.accountId),
    stale: !!a.key_wrap_stale, hasRecovery: !!a.key_wrap_rc,
    legacy, migrating: keyMigProgress(req.accountId),
  });
});

/* Unlock when the password wrap rides an OLDER password (unswapped change, or
   an admin/code reset). Proof = the previous password or the recovery code —
   plus the CURRENT password, so the wrap is immediately re-issued under it.
   (This is the manual "swap" happening at the moment it's actually needed.) */
app.post('/api/keys/unlock', requireAuth, async (req, res) => {
  const a = req.account, b = req.body || {};
  if (!a.key_enrolled) return res.status(400).json({ error: 'keys are not enrolled yet — sign in again' });
  const password = String(b.password || '');
  if (!(await vault.verifyPassword(password, a.pw_salt, a.pw_hash)))
    return res.status(403).json({ error: 'your current password is required' });
  let udk = null;
  if (b.oldPassword) {
    const kek = await vault.deriveKek(String(b.oldPassword), a.key_kek_salt, MASTER_KEY, a.id);
    udk = vault.unwrapKey(kek, a.key_wrap_pw);
    if (!udk) return res.status(403).json({ error: 'that previous password does not unlock the key' });
  } else if (b.recovery) {
    if (!a.key_wrap_rc) return res.status(400).json({ error: 'no recovery code is set for this account' });
    const rcKek = await vault.deriveKek(vault.normRecoveryCode(b.recovery), a.key_rc_salt, MASTER_KEY, a.id);
    udk = vault.unwrapKey(rcKek, a.key_wrap_rc);
    if (!udk) return res.status(403).json({ error: 'that recovery code does not unlock the key' });
  } else {
    return res.status(400).json({ error: 'previous password or recovery code required' });
  }
  const kekSalt = crypto.randomBytes(16);
  const kek = await vault.deriveKek(password, kekSalt, MASTER_KEY, a.id);
  persistPwWrap(a.id, kekSalt, vault.wrapKey(kek, udk));
  cacheUdk(a.id, udk);
  bumpAccounts();
  res.json({ ok: true });
});

/* Swap: re-wrap the (resident) UDK under the CURRENT password. Called from
   Settings after a password change — per policy this never happens silently. */
app.post('/api/keys/swap', requireAuth, async (req, res) => {
  const a = req.account, b = req.body || {};
  if (!a.key_enrolled) return res.status(400).json({ error: 'keys are not enrolled yet' });
  const udk = UDK_RAW.get(a.id);
  if (!udk) return res.status(409).json({ error: 'keys are not loaded — sign in again first' });
  const password = String(b.password || '');
  if (!(await vault.verifyPassword(password, a.pw_salt, a.pw_hash)))
    return res.status(403).json({ error: 'your current password is required' });
  if (a.totp_secret && !totpVerify(a.id, a.totp_secret, b.totp))
    return res.status(403).json({ error: 'two-auth code required', need2fa: true });
  const kekSalt = crypto.randomBytes(16);
  const kek = await vault.deriveKek(password, kekSalt, MASTER_KEY, a.id);
  persistPwWrap(a.id, kekSalt, vault.wrapKey(kek, udk));
  bumpAccounts();
  res.json({ ok: true });
});

/* shared guard for the reveal/regenerate endpoints: resident UDK + password
   (+ two-auth when active). Returns the UDK buffer, or null after responding. */
async function keyRevealGuard(req, res) {
  const a = req.account, b = req.body || {};
  if (!a.key_enrolled) { res.status(400).json({ error: 'keys are not enrolled yet' }); return null; }
  const udk = UDK_RAW.get(a.id);
  if (!udk) { res.status(409).json({ error: 'keys are not loaded — sign in again first' }); return null; }
  if (!(await vault.verifyPassword(String(b.password || ''), a.pw_salt, a.pw_hash))) {
    res.status(403).json({ error: 'your current password is required' }); return null;
  }
  if (a.totp_secret && !totpVerify(a.id, a.totp_secret, b.totp)) {
    res.status(403).json({ error: 'two-auth code required', need2fa: true }); return null;
  }
  return udk;
}

/* Reveal the account's recovery key — ONLY on explicit request, password-gated.
   The stored copy is sealed under the UDK, so this works only for a signed-in
   owner; disk + master key alone can never produce it. Accounts enrolled before
   sealed storage existed get a fresh key generated transparently. */
app.post('/api/keys/reveal', requireAuth, async (req, res) => {
  const a = req.account;
  const udk = await keyRevealGuard(req, res);
  if (!udk) return;
  if (a.key_rc_enc) {
    const code = vault.decText(a.key_rc_enc, rcViewKeys(udk));
    if (code && code !== a.key_rc_enc) return res.json({ ok: true, code });
  }
  // no (readable) sealed copy — mint a new key and store it sealed
  const code = vault.makeRecoveryCode();
  const rcSalt = crypto.randomBytes(16);
  const rcKek = await vault.deriveKek(vault.normRecoveryCode(code), rcSalt, MASTER_KEY, a.id);
  persistRcWrap(a.id, rcSalt, vault.wrapKey(rcKek, udk), vault.encText(code, rcViewKeys(udk)));
  res.json({ ok: true, code, regenerated: true });
});

/* Regenerate the recovery key (invalidates the old one). */
app.post('/api/keys/recovery', requireAuth, async (req, res) => {
  const a = req.account;
  const udk = await keyRevealGuard(req, res);
  if (!udk) return;
  const code = vault.makeRecoveryCode();
  const rcSalt = crypto.randomBytes(16);
  const rcKek = await vault.deriveKek(vault.normRecoveryCode(code), rcSalt, MASTER_KEY, a.id);
  persistRcWrap(a.id, rcSalt, vault.wrapKey(rcKek, udk), vault.encText(code, rcViewKeys(udk)));
  res.json({ ok: true, code });
});

/* Whole-vault lockdown re-encryption. The requireAuth gate 423s the rest of
   the account's API while KEY_MIG holds an entry; the client polls status. */
app.post('/api/keys/reencrypt-vault', requireAuth, (req, res) => {
  const a = req.account;
  if (!a.key_enrolled || !req.store.keys.v2) return res.status(409).json({ error: 'keys are not loaded — sign in again first' });
  if (KEY_MIG.has(a.id)) return res.status(409).json({ error: 'already re-encrypting', progress: keyMigProgress(a.id) });
  let total = 0, bytesTotal = 0;
  try {
    const r = req.store.db.prepare("SELECT COUNT(*) c, COALESCE(SUM(CASE WHEN type != 'folder' THEN size ELSE 0 END), 0) b FROM files WHERE kv = 1").get();
    total = r.c; bytesTotal = r.b;
  } catch (e) {}
  const m = { phase: 'starting', total, done: 0, bytesTotal, bytesDone: 0, cur: null, errors: [], startedAt: Date.now() };
  KEY_MIG.set(a.id, m);
  runVaultReencrypt(req.store, a.id);   // intentionally not awaited
  res.json({ ok: true, progress: keyMigProgress(a.id) });
});

/* ---------- admin: account management ---------- */
const USERNAME_RE = /^[a-zA-Z0-9_.-]{1,32}$/;

app.get('/api/accounts', requireAdmin, (req, res) => {
  res.json(sysStmt.listAccts.all().map(a => ({ ...acctToApi(a), used: openStore(a.id).usedBytes() })));
});
app.post('/api/accounts', requireAdmin, (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'username must be 1–32 chars: letters, numbers, . _ -' });
  if (!password) return res.status(400).json({ error: 'password required' });
  if (sysStmt.getAcctByName.get(username)) return res.status(409).json({ error: 'username taken' });
  const quota = Number.isFinite(+b.quota_bytes) && +b.quota_bytes > 0 ? Math.floor(+b.quota_bytes) : DEFAULT_QUOTA;
  const a = createAccount({ username, password, display: b.display, isAdmin: !!b.is_admin, quota });
  if (!b.is_admin) {
    if (b.can_code !== undefined) sys.prepare('UPDATE accounts SET can_code = ? WHERE id = ?').run(b.can_code ? 1 : 0, a.id);
    if (b.can_ai !== undefined) sys.prepare('UPDATE accounts SET can_ai = ? WHERE id = ?').run(b.can_ai ? 1 : 0, a.id);
    if (b.can_neural_backend !== undefined) sys.prepare('UPDATE accounts SET can_neural_backend = ? WHERE id = ?').run(b.can_neural_backend ? 1 : 0, a.id);
    if (b.org_max_tier !== undefined && ORG_TIERS[b.org_max_tier]) sys.prepare('UPDATE accounts SET org_max_tier = ? WHERE id = ?').run(b.org_max_tier, a.id);
  }
  if (b.security_tier !== undefined && VALID_TIERS.has(b.security_tier)) sys.prepare('UPDATE accounts SET security_tier = ? WHERE id = ?').run(b.security_tier, a.id);
  res.json({ ok: true, account: acctToApi(sysStmt.getAcct.get(a.id)) });
});
app.patch('/api/accounts/:id', requireAdmin, (req, res) => {
  const target = sysStmt.getAcct.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const fields = [], vals = {};
  if (typeof b.display === 'string' && b.display.trim()) { fields.push('display = @display'); vals.display = b.display.trim(); }
  if (typeof b.username === 'string' && b.username.trim() && b.username.trim() !== target.username) {
    const u = b.username.trim();
    if (!USERNAME_RE.test(u)) return res.status(400).json({ error: 'invalid username' });
    if (sysStmt.getAcctByName.get(u)) return res.status(409).json({ error: 'username taken' });
    fields.push('username = @username'); vals.username = u;
  }
  if (typeof b.password === 'string' && b.password.length) {
    const { salt, hash } = vault.hashPassword(b.password);
    fields.push('pw_salt = @pw_salt', 'pw_hash = @pw_hash'); vals.pw_salt = salt; vals.pw_hash = hash;
    // admin set a new password without the old one: the target's key wrap
    // still rides the previous password. They unlock at next sign-in with
    // the previous password or their recovery code.
    markWrapStale(target.id);
  }
  if (b.quota_bytes !== undefined && Number.isFinite(+b.quota_bytes) && +b.quota_bytes > 0) {
    fields.push('quota_bytes = @quota_bytes'); vals.quota_bytes = Math.floor(+b.quota_bytes);
  }
  if (b.is_admin !== undefined) {
    const makeAdmin = b.is_admin ? 1 : 0;
    if (!makeAdmin && target.is_admin && sysStmt.countAdmins.get().n <= 1) return res.status(400).json({ error: 'cannot remove the last admin' });
    fields.push('is_admin = @is_admin'); vals.is_admin = makeAdmin;
  }
  if (b.can_code !== undefined) { fields.push('can_code = @can_code'); vals.can_code = b.can_code ? 1 : 0; }
  if (b.can_ai !== undefined) { fields.push('can_ai = @can_ai'); vals.can_ai = b.can_ai ? 1 : 0; }
  if (b.can_neural_backend !== undefined) { fields.push('can_neural_backend = @can_neural_backend'); vals.can_neural_backend = b.can_neural_backend ? 1 : 0; }
  if (b.org_max_tier !== undefined && ORG_TIERS[b.org_max_tier]) { fields.push('org_max_tier = @org_max_tier'); vals.org_max_tier = b.org_max_tier; }
  if (b.security_tier !== undefined && VALID_TIERS.has(b.security_tier)) { fields.push('security_tier = @security_tier'); vals.security_tier = b.security_tier; }
  if (typeof b.email === 'string') {
    const em = b.email.trim();
    if (em && (em.length > 200 || !EMAIL_RE.test(em))) return res.status(400).json({ error: 'invalid email' });
    fields.push('email = @email'); vals.email = em || null;
  }
  if (fields.length) { vals.id = target.id; sys.prepare(`UPDATE accounts SET ${buildSetClause('accounts', fields)} WHERE id = @id`).run(vals); bumpAccounts(); }
  res.json({ ok: true, account: acctToApi(sysStmt.getAcct.get(target.id)) });
});
app.delete('/api/accounts/:id', requireAdmin, (req, res) => {
  const target = sysStmt.getAcct.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'not found' });
  if (target.id === req.accountId) return res.status(400).json({ error: 'cannot delete your own account' });
  if (target.is_admin && sysStmt.countAdmins.get().n <= 1) return res.status(400).json({ error: 'cannot delete the last admin' });
  sysStmt.delSharesForAcct.run(target.id);
  sysStmt.delApiKeysForAcct.run(target.id);
  ipsSys.delAcct.run(target.id);
  resetSys.delForAcct.run(target.id);
  sysStmt.delAcct.run(target.id);
  dropStore(target.id);
  bumpAccounts();
  res.json({ ok: true });
});

/* ---------- admin: login security (default tier + live IP bans) ---------- */
function signupToApi(s) {
  // never expose the stored password hash/salt
  return { id: s.id, created: s.created, username: s.username, display: s.display, email: s.email, explanation: s.explanation, requested_gb: s.requested_gb };
}
function resetToApi(r) {
  const a = sysStmt.getAcct.get(r.account_id);
  return {
    id: r.id, created: r.created, status: r.status,
    username: a ? a.username : '(deleted)', display: a ? (a.display || a.username) : null,
    email: a ? (a.email || null) : null,
    code_expires: r.code_expires || null,
  };
}
app.get('/api/security', requireAdmin, (req, res) => {
  const now = Date.now();
  resetSys.prune.run(now - 7 * 24 * 60 * 60_000);   // stale requests age out after a week
  res.json({
    defaultTier: defaultSecurityTier(),
    tiers: ['minimal', 'limited', 'locked'],
    bans: banSys.active.all(now).map(b => ({ ip: b.ip, until: b.banned_until, reason: b.reason, ban_count: b.ban_count })),
    signups: signupSys.listPending.all().map(signupToApi),
    pendingSignups: signupSys.countPending.get().n,
    resets: resetSys.list.all().map(resetToApi),
  });
});
/* generate the one-time reset code for a request. Returned in PLAINTEXT exactly
   once — the admin copies it into the email they send; we store only the hash. */
app.post('/api/security/resets/:id/code', requireAdmin, (req, res) => {
  const r = resetSys.get.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'request not found' });
  let code = '';
  for (let i = 0; i < 8; i++) code += CAPTCHA_ALPHABET[crypto.randomInt(CAPTCHA_ALPHABET.length)];
  const { salt, hash } = vault.hashPassword(code);   // codes are uppercase-only; complete() uppercases input
  resetSys.setCode.run({ id: r.id, code_salt: salt, code_hash: hash, code_expires: Date.now() + 24 * 60 * 60_000 });
  res.json({ ok: true, code, reset: resetToApi(resetSys.get.get(r.id)) });
});
app.delete('/api/security/resets/:id', requireAdmin, (req, res) => {
  resetSys.del.run(req.params.id);
  res.json({ ok: true });
});
app.patch('/api/security', requireAdmin, (req, res) => {
  const t = (req.body && req.body.defaultTier) || '';
  if (!VALID_TIERS.has(t)) return res.status(400).json({ error: 'invalid tier' });
  setSetting('security.default_tier', t);
  res.json({ ok: true, defaultTier: t });
});
app.delete('/api/security/bans/:ip', requireAdmin, (req, res) => {
  clearIpBan(req.params.ip);
  res.json({ ok: true });
});

/* ---------- admin: self-serve signup approval queue ---------- */
app.get('/api/signups', requireAdmin, (req, res) => {
  res.json({ signups: signupSys.listPending.all().map(signupToApi) });
});
app.post('/api/signups/:id/approve', requireAdmin, (req, res) => {
  const s = signupSys.get.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'request not found' });
  if (sysStmt.getAcctByName.get(s.username)) {   // taken since the request was filed
    signupSys.del.run(s.id);
    return res.status(409).json({ error: 'username is now taken — request discarded' });
  }
  // Admin may override the storage quota (the request's GB estimate is just a hint).
  let gb = parseFloat(req.body && req.body.quota_gb);
  let quota;
  if (Number.isFinite(gb) && gb > 0) quota = Math.round(gb * 1e9);
  else if (Number.isFinite(s.requested_gb) && s.requested_gb > 0) quota = Math.round(s.requested_gb * 1e9);
  else quota = DEFAULT_QUOTA;
  // Reuse the stored hash/salt so the plaintext password is never needed again.
  const a = createAccount({ username: s.username, display: s.display || s.username, quota, salt: s.pw_salt, hash: s.pw_hash });
  signupSys.del.run(s.id);
  res.json({ ok: true, account: acctToApi(a) });
});
app.post('/api/signups/:id/reject', requireAdmin, (req, res) => {
  const s = signupSys.get.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'request not found' });
  signupSys.del.run(s.id);   // delete rather than flag — don't retain unused credentials
  res.json({ ok: true });
});

/* ============================================================
   FILES (per-account; req.store set by requireAuth gate)
   ============================================================ */
app.get('/api/files', (req, res) => {
  res.json(req.store.st.all.all().map(r => rowToApi(r, req.store)));
});
/* Full document body for a content-backed doc (the list omits it to stay light).
   Blob-backed docs fetch their text from /raw instead; this is only for docs whose
   text lives in the `content` column. Returns { content }. */
app.get('/api/files/:id/content', (req, res) => {
  const row = req.store.getById(req.params.id);
  if (!row) return res.status(404).end();
  const full = rowToApi(row, req.store, true);   // include content
  res.json({ content: full.content != null ? full.content : '' });
});
app.get('/api/_diag', (req, res) => {
  // Lightweight process diagnostics (no separate health-monitor subsystem).
  const m = process.memoryUsage();
  res.json({
    uptime: Date.now() - BACKEND_STARTED_AT,
    openConnections: diag.connections,
    openReadStreams: vault.openReadStreams(),
    handles: (process._getActiveHandles && process._getActiveHandles().length) || -1,
    rssMB: Math.round(m.rss / 1e6),
    heapMB: Math.round(m.heapUsed / 1e6),
    uploads: uploads.size,
    stores: stores.size,
    lastLagMs: diag.lastLagMs,
    maxLagMs: diag.maxLagMs,
    blockEvents: diag.blockEvents,
    inFlight: [...inFlight.values()].map(r => ({ method: r.method, path: r.path, elapsed: Date.now() - r.startedAt })),
  });
});
app.get('/api/files/:id/raw', (req, res) => {
  const row = req.store.getById(req.params.id);
  // a DOWNLOAD (?dl=1) of a Legacy row is gated behind re-encryption; plain
  // streaming (watch / listen / view) stays open per policy
  if (req.query.dl && legacyGate(req, res, row)) return;
  streamEncrypted(req, res, req.store, row, 'blob');
});
app.get('/api/files/:id/cover', (req, res) => streamEncrypted(req, res, req.store, req.store.getById(req.params.id), 'cover'));

/* ---------- video poster (server-generated thumbnail frame) ----------
   The browser USED to make a thumbnail per video by downloading + seeking the real
   file (a <video> element pointed at /raw), which saturated the browser's ~6
   connections-per-host and froze a video-heavy folder. Instead we grab ONE frame
   here with ffmpeg, cache it encrypted-at-rest (like a cover), and the client just
   loads a tiny JPEG like an image thumbnail. Generated once, then served from cache. */
const POSTER_MAX_CONCURRENT = 2;           // ffmpeg jobs running at once (rest QUEUE, not rejected)
let _posterActive = 0;
const _posterWaiters = [];                 // queued resolvers waiting for a generation slot
const _posterInflight = new Map();         // `${acct}:${id}` -> Promise (de-dupe concurrent requests)
function _posterKey(acctId, id) { return acctId + ':' + id; }
/* acquire a generation slot — resolves immediately if under the cap, else waits in
   line. A video-heavy folder thus generates posters a couple at a time without ever
   rejecting (the client <img> can't retry a 503, so we must not reject). */
function _acquirePosterSlot() {
  if (_posterActive < POSTER_MAX_CONCURRENT) { _posterActive++; return Promise.resolve(); }
  return new Promise(resolve => _posterWaiters.push(resolve));
}
function _releasePosterSlot() {
  const next = _posterWaiters.shift();
  if (next) next();                        // hand the slot to the next waiter (active count unchanged)
  else _posterActive = Math.max(0, _posterActive - 1);
}

/* Image extensions browsers can't render in an <img>, so we render a viewable
   PNG preview server-side (reusing the poster cache). EXR is HDR float, so it's
   tonemapped to 8-bit sRGB for the *preview only* — the stored original and any
   ffmpeg conversion keep the full data. */
const PREVIEW_EXTS = new Set(['exr', 'tif', 'tiff']);
function needsPreview(row) {
  return row && row.type === 'image' && PREVIEW_EXTS.has((row.storedExt || '').toLowerCase());
}

async function _generatePoster(store, row) {
  if (!(await ffmpegAvailable())) return false;
  const jobDir = path.join(TOOLS_DIR, 'p' + crypto.randomBytes(6).toString('hex'));
  const ext = (row.storedExt || '').toLowerCase();
  const inP = path.join(jobDir, 'in' + (ext ? '.' + ext : ''));
  const isImg = needsPreview(row);
  // Image previews go to PNG (lossless, honest for heightmaps); video posters JPEG.
  const outP = path.join(jobDir, isImg ? 'out.png' : 'out.jpg');
  const cleanup = () => { try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {} };
  try {
    await fsp.mkdir(jobDir, { recursive: true });
    await decryptBlobToFile(store.blobPath(row), store.keys, inP);
    let args;
    if (isImg) {
      // Full-size preview (long side capped at 2048 so a huge EXR can't blow up
      // memory). format=rgb24 lets ffmpeg map EXR's linear HDR float down to 8-bit
      // sRGB for a viewable PNG; it's a harmless passthrough for 8-bit TIFF.
      args = ['-i', inP, '-frames:v', '1', '-vf', "scale='min(2048,iw)':-1:flags=lanczos,format=rgb24", '-y', outP];
    } else {
    // seek to ~the middle (or 1s) so we don't grab a black intro frame
    let seek = 1;
    try { const d = await ffprobeDuration(inP); if (d && d > 2) seek = Math.min(d / 2, d - 0.5); } catch (e) {}
    args = ['-ss', String(seek), '-i', inP, '-frames:v', '1', '-vf', 'scale=320:-1', '-q:v', '5', '-y', outP];
    }
    const ok = await new Promise((resolve) => {
      const child = spawn(FFMPEG, args, { windowsHide: true });
      const timer = setTimeout(() => { try { killTree(child); } catch (e) {} resolve(false); }, 30_000);
      child.on('error', () => { clearTimeout(timer); resolve(false); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    });
    if (!ok) return false;
    let stat = null; try { stat = await fsp.stat(outP); } catch (e) {}
    if (!stat || !stat.size) return false;
    await vault.encryptBlob(outP, store.posterPath(row), store.keys);
    store.db.prepare('UPDATE files SET hasPoster = 1 WHERE id = ?').run(row.id);
    return true;
  } catch (e) {
    console.warn('[simplex] poster generation failed for', row.id, e && e.message);
    return false;
  } finally { cleanup(); }
}

app.get('/api/files/:id/poster', async (req, res) => {
  const store = req.store;
  const row = store.getById(req.params.id);
  // Real, unlocked video blobs (frame poster) OR exr/tiff images (rendered PNG
  // preview) get a poster; otherwise 404 -> client shows the icon.
  if (!row || !row.hasBlob || row.locked || (row.type !== 'video' && !needsPreview(row))) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=86400');   // safe to cache: poster is immutable per blob
  if (row.hasPoster) return streamEncrypted(req, res, store, row, 'poster');
  const key = _posterKey(req.accountId, row.id);
  let job = _posterInflight.get(key);
  if (!job) {
    // one generation per id; it waits for a concurrency slot, generates, releases.
    job = (async () => {
      await _acquirePosterSlot();
      try { return await _generatePoster(store, row); }
      finally { _releasePosterSlot(); _posterInflight.delete(key); }
    })();
    _posterInflight.set(key, job);
  }
  const ok = await job;
  if (res.writableEnded || res.destroyed) return;            // client navigated away
  const fresh = store.getById(row.id);
  if (ok && fresh && fresh.hasPoster) return streamEncrypted(req, res, store, fresh, 'poster');
  return res.status(404).end();
});

/* ---------- heightmap pixel data (for the 3D "View as heightmap" viewer) ----------
   ffmpeg decodes the exr/tiff/image, converts to a single grayscale channel at a
   modest resolution, and emits raw 8-bit bytes (gray8). The client reads them as a
   W×H displacement grid. A 16-bit path (gray16le) would give finer height steps but
   8-bit is plenty for a preview mesh and keeps the payload small. Response:
   `<w>\n<h>\n` header line pair, then w*h raw bytes. Capped so a huge map stays cheap. */
const HEIGHTMAP_MAX = 256;   // longest side of the sampled grid
app.get('/api/files/:id/heightdata', async (req, res) => {
  const store = req.store;
  const row = store.getById(req.params.id);
  if (!row || !row.hasBlob || row.type !== 'image' || row.locked) return res.status(404).json({ error: 'not found' });
  if (legacyGate(req, res, row)) return;
  if (!(await ffmpegAvailable())) return res.status(503).json({ error: 'ffmpeg is not installed on the server' });
  const jobDir = path.join(TOOLS_DIR, 'h' + crypto.randomBytes(6).toString('hex'));
  const ext = (row.storedExt || '').toLowerCase();
  const inP = path.join(jobDir, 'in' + (ext ? '.' + ext : ''));
  const outP = path.join(jobDir, 'out.raw');
  const cleanup = () => { try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {} };
  try {
    await fsp.mkdir(jobDir, { recursive: true });
    await decryptBlobToFile(store.blobPath(row), store.keys, inP);
    // Probe true source dimensions, then compute an exact target grid ourselves so
    // the raw gray8 buffer's W×H is known precisely (no guessing from byte counts).
    const dim = await ffprobeDims(inP);
    if (!dim) { cleanup(); return res.status(422).json({ error: 'could not read image dimensions' }); }
    let w, h;
    if (dim.w >= dim.h) { w = Math.min(HEIGHTMAP_MAX, dim.w); h = Math.max(1, Math.round(w * dim.h / dim.w)); }
    else { h = Math.min(HEIGHTMAP_MAX, dim.h); w = Math.max(1, Math.round(h * dim.w / dim.h)); }
    const args = ['-i', inP, '-frames:v', '1', '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-y', outP];
    const ok = await new Promise((resolve) => {
      const child = spawn(FFMPEG, args, { windowsHide: true });
      const timer = setTimeout(() => { try { killTree(child); } catch (e) {} resolve(false); }, 30_000);
      child.on('error', () => { clearTimeout(timer); resolve(false); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    });
    if (!ok) { cleanup(); return res.status(422).json({ error: 'could not decode image' }); }
    let raw;
    try { raw = await fsp.readFile(outP); } catch (e) { cleanup(); return res.status(500).json({ error: 'read failed' }); }
    if (raw.length !== w * h) { cleanup(); return res.status(500).json({ error: 'unexpected pixel buffer' }); }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Height-W', String(w));
    res.setHeader('X-Height-H', String(h));
    res.setHeader('Access-Control-Expose-Headers', 'X-Height-W, X-Height-H');
    res.end(raw);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'heightmap failed: ' + (e.message || '') });
  } finally { cleanup(); }
});

/* ---------- executable icon (extracted from PE resources) ----------
   A Windows .exe/.dll carries its shell icon as PE resources (RT_GROUP_ICON /
   RT_ICON), which ffmpeg/image tools can't read. peicon.js parses those out and
   returns the best image (a 256px PNG when present, else an assembled .ico). We
   cache it encrypted at rest exactly like a video poster, and the client loads a
   tiny image. Generated once per blob, then served from cache. Files that turn
   out to have no icon get hasIcon = -1 ("tried, none") so we never reparse. */
const ICON_PE_EXTS = new Set(['exe', 'dll', 'scr', 'ocx', 'cpl', 'mun', 'sys', 'efi', 'mui']);
const ICON_MAX_BYTES = 96 * 1024 * 1024;   // don't load a blob bigger than this into memory to parse
let _iconActive = 0;
const _iconWaiters = [];
const _iconInflight = new Map();
const ICON_MAX_CONCURRENT = 2;
function _acquireIconSlot() {
  if (_iconActive < ICON_MAX_CONCURRENT) { _iconActive++; return Promise.resolve(); }
  return new Promise(resolve => _iconWaiters.push(resolve));
}
function _releaseIconSlot() {
  const next = _iconWaiters.shift();
  if (next) next();
  else _iconActive = Math.max(0, _iconActive - 1);
}
function isIconCandidate(row) {
  if (!row || !row.hasBlob || row.locked) return false;
  // storedExt is path.extname()-style (".exe"); strip the dot to match the set
  const ext = String(row.storedExt || '').toLowerCase().replace(/^\./, '');
  return ICON_PE_EXTS.has(ext);
}
/* read up to ICON_MAX_BYTES of the decrypted blob into memory */
function _decryptBlobToBuffer(store, row, cap) {
  return new Promise((resolve) => {
    try {
      const encPath = store.blobPath(row);
      if (!fs.existsSync(encPath)) return resolve(null);
      const dec = vault.decryptBlobRange(encPath, store.keys, 0, cap - 1);
      if (!dec || !dec.stream) return resolve(null);
      const chunks = []; let got = 0; let done = false;
      const finish = (buf) => { if (done) return; done = true; try { dec.stream.destroy(); } catch (e) {} resolve(buf); };
      dec.stream.on('data', (c) => { chunks.push(c); got += c.length; if (got >= cap) finish(Buffer.concat(chunks).subarray(0, cap)); });
      dec.stream.on('end', () => finish(chunks.length ? Buffer.concat(chunks) : null));
      dec.stream.on('error', () => finish(null));
    } catch (e) { resolve(null); }
  });
}
async function _generateIcon(store, row) {
  // oversized executables: skip parsing (and remember it) rather than buffering 100s of MB
  if ((row.size || 0) > ICON_MAX_BYTES) { store.db.prepare('UPDATE files SET hasIcon = -1 WHERE id = ?').run(row.id); return false; }
  try {
    const buf = await _decryptBlobToBuffer(store, row, ICON_MAX_BYTES);
    let result = null;
    if (buf) { try { result = peicon.extractBestImage(buf); } catch (e) { result = null; } }
    if (!result || !result.buffer || !result.buffer.length) {
      store.db.prepare('UPDATE files SET hasIcon = -1 WHERE id = ?').run(row.id);   // tried, nothing extractable
      return false;
    }
    // write the image to a temp file, then encrypt it into the vault like a cover/poster
    const tmp = path.join(store.tmpDir, 'ic' + crypto.randomBytes(6).toString('hex') + '.' + result.ext);
    await fsp.writeFile(tmp, result.buffer);
    try { await vault.encryptBlob(tmp, store.iconPath(row), store.keys); }
    finally { try { await fsp.unlink(tmp); } catch (e) {} }
    store.db.prepare('UPDATE files SET hasIcon = 1, iconExt = ? WHERE id = ?').run(result.ext, row.id);
    return true;
  } catch (e) {
    console.warn('[simplex] icon extraction failed for', row.id, e && e.message);
    store.db.prepare('UPDATE files SET hasIcon = -1 WHERE id = ?').run(row.id);
    return false;
  }
}

app.get('/api/files/:id/icon', async (req, res) => {
  const store = req.store;
  const row = store.getById(req.params.id);
  if (!isIconCandidate(row)) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=86400');   // immutable per blob
  if (row.hasIcon === 1) return streamEncrypted(req, res, store, row, 'icon');
  if (row.hasIcon === -1) return res.status(404).end();       // already tried, none — don't reparse
  const key = req.accountId + ':' + row.id;
  let job = _iconInflight.get(key);
  if (!job) {
    job = (async () => {
      await _acquireIconSlot();
      try { return await _generateIcon(store, row); }
      finally { _releaseIconSlot(); _iconInflight.delete(key); }
    })();
    _iconInflight.set(key, job);
  }
  const ok = await job;
  if (res.writableEnded || res.destroyed) return;
  const fresh = store.getById(row.id);
  if (ok && fresh && fresh.hasIcon === 1) return streamEncrypted(req, res, store, fresh, 'icon');
  return res.status(404).end();
});

/* ============================================================
   EMBEDDED METADATA — read & purge the metadata baked into the file BYTES
   (EXIF in images, ID3/Vorbis tags in audio, container/stream tags in video).
   This is distinct from Simplex's own DB fields (name/artist/album/…). Reading
   uses ffprobe; purging uses ffmpeg `-map_metadata -1` with stream copy, so it's
   lossless and fast (no re-encode) — only the metadata is dropped.
   ============================================================ */

/* flatten ffprobe's format+stream tag blocks into a tidy list the UI can render:
   [{ scope, label, tags: { k: v } }] — one entry for the container ("format")
   and one per stream that actually carries tags. */
function shapeProbeMetadata(probe) {
  const out = [];
  const fmt = probe && probe.format;
  if (fmt) {
    const tags = fmt.tags || {};
    out.push({ scope: 'format', label: 'File (container)', tags, count: Object.keys(tags).length });
  }
  (probe && probe.streams || []).forEach((s) => {
    const tags = s.tags || {};
    if (!Object.keys(tags).length) return;                 // streams with no tags add nothing to show
    const kind = s.codec_type || 'stream';
    const label = `Stream #${s.index} · ${kind}${s.codec_name ? ' (' + s.codec_name + ')' : ''}`;
    out.push({ scope: 'stream', index: s.index, label, tags, count: Object.keys(tags).length });
  });
  return out;
}

/* decrypt a row's blob to a temp file, run ffprobe -show_format -show_streams,
   and return { probe, jobDir, inP, ext } (caller cleans up jobDir). */
async function probeFileMetadata(store, row) {
  const jobDir = path.join(TOOLS_DIR, 'm' + crypto.randomBytes(6).toString('hex'));
  const ext = (path.extname(store.decName(row)).slice(1) || row.storedExt || '').toLowerCase();
  const inP = path.join(jobDir, 'in' + (ext ? '.' + ext : ''));
  await fsp.mkdir(jobDir, { recursive: true });
  await decryptBlobToFile(store.blobPath(row), store.keys, inP);
  const r = await probeProcess('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', inP], { timeoutMs: 15000 });
  let probe = null;
  try { probe = JSON.parse(r.stdout || '{}'); } catch (e) { probe = null; }
  return { probe, jobDir, inP, ext, ok: r.ok };
}

/* After an AUDIO file lands in the vault, pull its embedded tags (artist/album/
   title) and cover art so the player shows them — browsers don't expose ID3 to
   the uploader, so without this every track reads "Unknown artist" with the
   generic icon. Runs in the background (best-effort): decrypt → ffprobe for tags
   → ffmpeg to extract the attached-pic cover → patch the row. Never throws into
   the request path; failures just leave the file as-is. */
const _audioTagJobs = new Set();   // de-dupe: at most one extraction per file id in flight
async function extractAudioTags(accountId, store, id) {
  if (_audioTagJobs.has(id)) return;
  _audioTagJobs.add(id);
  const jobDir = path.join(TOOLS_DIR, 'a' + crypto.randomBytes(6).toString('hex'));
  const cleanup = () => { try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await ffmpegAvailable())) return;
    const row = store.getById(id);
    if (!row || !row.hasBlob || row.locked || row.type !== 'audio') return;
    const ext = (path.extname(store.decName(row)).slice(1) || row.storedExt || '').toLowerCase();
    const inP = path.join(jobDir, 'in' + (ext ? '.' + ext : ''));
    await fsp.mkdir(jobDir, { recursive: true });
    await decryptBlobToFile(store.blobPath(row), store.keys, inP);

    // 1) read tags
    const r = await probeProcess('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', inP], { timeoutMs: 15000 });
    let probe = {}; try { probe = JSON.parse(r.stdout || '{}'); } catch (e) {}
    const tags = {};
    const ftags = (probe.format && probe.format.tags) || {};
    for (const [k, v] of Object.entries(ftags)) tags[k.toLowerCase()] = v;
    (probe.streams || []).forEach(s => { for (const [k, v] of Object.entries(s.tags || {})) { const lk = k.toLowerCase(); if (tags[lk] == null) tags[lk] = v; } });
    const artist = (tags.artist || tags.author || tags.album_artist || tags.performer || '').toString().trim() || null;
    const album = (tags.album || '').toString().trim() || null;

    // 2) extract attached-pic cover art (a video/image stream marked attached_pic,
    //    or — failing that — any image stream). Only if the file doesn't already
    //    have a (user-set) cover.
    let coverExt = null;
    const hasPic = (probe.streams || []).some(s => s.codec_type === 'video');
    if (hasPic && !row.hasCover) {
      const coverOut = path.join(jobDir, 'cover.jpg');
      const ok = await new Promise((resolve) => {
        const child = spawn(FFMPEG, ['-i', inP, '-an', '-map', '0:v', '-frames:v', '1', '-y', coverOut], { windowsHide: true });
        const timer = setTimeout(() => { try { killTree(child); } catch (e) {} resolve(false); }, 60_000);
        child.on('error', () => { clearTimeout(timer); resolve(false); });
        child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
      });
      let st = null; if (ok) { try { st = await fsp.stat(coverOut); } catch (e) {} }
      if (st && st.size) {
        const fresh = store.getById(id);
        if (fresh && !fresh.hasCover) { await vault.encryptBlob(coverOut, store.coverPath(fresh), store.keys); coverExt = 'jpg'; }
      }
    }

    // 3) patch the row with whatever we found (skip fields already set by the client)
    const fresh = store.getById(id);
    if (!fresh) return;
    const sets = [], vals = { id };
    if (artist && !fresh.artist) { sets.push('artist = @artist'); vals.artist = vault.encText(artist, store.keys); }
    if (album && !fresh.album) { sets.push('album = @album'); vals.album = vault.encText(album, store.keys); }
    if (coverExt && !fresh.hasCover) { sets.push('hasCover = 1'); sets.push('coverExt = @coverExt'); vals.coverExt = coverExt; }
    if (sets.length) {
      store.db.prepare(`UPDATE files SET ${buildSetClause('files', sets)} WHERE id = @id`).run(vals);
      store.bump();
      invalidatePollCache(accountId);
    }
  } catch (e) {
    console.warn('[simplex] audio tag extraction failed for', id, e && e.message);
  } finally { cleanup(); _audioTagJobs.delete(id); }
}

/* On-demand backfill: (re)extract embedded artist/album/cover for one audio file.
   Synchronous (awaited) so the client gets the updated record back to refresh the
   player. Safe to call repeatedly — it only fills fields that are still empty. */
app.post('/api/files/:id/extract-tags', async (req, res) => {
  const store = req.store, row = store.getById(req.params.id);
  if (!row || !row.hasBlob) return res.status(404).json({ error: 'no file' });
  if (row.locked) return res.status(409).json({ error: 'unlock this file first' });
  if (row.type !== 'audio') return res.status(400).json({ error: 'not an audio file' });
  if (!(await ffmpegAvailable())) return res.status(503).json({ error: 'ffmpeg is not installed on the server' });
  try {
    await extractAudioTags(req.accountId, store, row.id);
    res.json({ ok: true, file: rowToApi(store.getById(row.id), store) });
  } catch (e) {
    res.status(500).json({ error: 'tag extraction failed: ' + (e.message || '') });
  }
});

app.get('/api/files/:id/metadata', async (req, res) => {
  const store = req.store, row = store.getById(req.params.id);
  if (!row || !row.hasBlob) return res.status(404).json({ error: 'no file to inspect' });
  if (row.locked) return res.status(409).json({ error: 'unlock this file to inspect its metadata' });
  if (!(await ffmpegAvailable())) return res.status(503).json({ error: 'ffmpeg is not installed on the server' });
  let jobDir = null;
  try {
    const r = await probeFileMetadata(store, row);
    jobDir = r.jobDir;
    if (!r.probe) return res.status(422).json({ error: 'could not read this file’s metadata' });
    const groups = shapeProbeMetadata(r.probe);
    const total = groups.reduce((s, g) => s + g.count, 0);
    res.json({ ok: true, total, groups });
  } catch (e) {
    res.status(500).json({ error: 'metadata read failed: ' + (e.message || '') });
  } finally { if (jobDir) { try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {} } }
});

app.post('/api/files/:id/purge-metadata', async (req, res) => {
  const store = req.store, row = store.getById(req.params.id);
  if (!row || !row.hasBlob) return res.status(404).json({ error: 'no file to clean' });
  if (row.locked) return res.status(409).json({ error: 'unlock this file before purging its metadata' });
  if (legacyGate(req, res, row)) return;   // editing ops on Legacy rows require re-encryption first
  if (!(await ffmpegAvailable())) return res.status(503).json({ error: 'ffmpeg is not installed on the server' });
  const jobDir = path.join(TOOLS_DIR, 'm' + crypto.randomBytes(6).toString('hex'));
  const cleanup = () => { try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {} };
  try {
    const srcName = store.decName(row);
    const ext = (path.extname(srcName).slice(1) || row.storedExt || '').toLowerCase();
    if (!ext) return res.status(422).json({ error: 'unknown file format' });
    const inP = path.join(jobDir, 'in.' + ext);
    const outP = path.join(jobDir, 'out.' + ext);
    await fsp.mkdir(jobDir, { recursive: true });
    await decryptBlobToFile(store.blobPath(row), store.keys, inP);

    // -map_metadata -1 drops global + stream metadata. Stream-copy (-c copy) so we
    // only strip tags, never re-encode (lossless, fast). We try strategies in order
    // and stop at the first that yields a valid file:
    //   1. keep every stream (preserves embedded cover art) — best case.
    //   2. audio-only (drops a cover/extra stream the muxer rejected) — some files
    //      carry a cover image whose codec the target container won't remux via
    //      -c copy; rather than fail outright we keep the audio and lose the picture.
    //   3. images: RE-ENCODE the pixels. A stream copy keeps EXIF/XMP/ICC living in
    //      the JPEG's APP markers, so the GPS/camera data would survive — re-encoding
    //      the image is the only reliable way to drop it. Quality is kept high so the
    //      visual result is effectively lossless.
    // Each strategy's ffmpeg stderr is captured so a genuine failure reports why.
    const isImage = row.type === 'image';
    const imgArgs = (out) => {
      if (ext === 'png') return ['-i', inP, '-map_metadata', '-1', '-c:v', 'png', '-y', out];
      if (ext === 'webp') return ['-i', inP, '-map_metadata', '-1', '-c:v', 'libwebp', '-quality', '95', '-y', out];
      // jpg/jpeg/bmp/other: encode mjpeg at near-max quality (-q:v 2 ≈ ~95%)
      return ['-i', inP, '-map_metadata', '-1', '-c:v', 'mjpeg', '-q:v', '2', '-y', out];
    };
    const strategies = isImage
      ? [{ args: imgArgs(outP) }, { args: ['-i', inP, '-map_metadata', '-1', '-c', 'copy', '-y', outP] }]   // fallback: copy if re-encode somehow fails
      : [
          { args: ['-i', inP, '-map', '0', '-map_metadata', '-1', '-map_chapters', '-1', '-c', 'copy', '-y', outP] },
          { args: ['-i', inP, '-map', '0:a', '-map_metadata', '-1', '-map_chapters', '-1', '-c', 'copy', '-y', outP], droppedCover: true },
        ];

    const runFfmpeg = (args) => new Promise((resolve) => {
      let stderr = '';
      const child = spawn(FFMPEG, args, { windowsHide: true });
      if (child.stderr) child.stderr.on('data', d => { if (stderr.length < 8000) stderr += d.toString(); });
      const timer = setTimeout(() => { try { killTree(child); } catch (e) {} resolve({ ok: false, stderr, timedOut: true }); }, 10 * 60_000);
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, stderr: stderr || String(e && e.message || e) }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stderr, code }); });
    });

    let outStat = null, lastErr = '', droppedCover = false, timedOut = false;
    for (const strat of strategies) {
      try { await fsp.rm(outP, { force: true }); } catch (e) {}
      const r = await runFfmpeg(strat.args);
      if (r.timedOut) { timedOut = true; lastErr = 'timed out'; continue; }
      if (r.ok) { try { outStat = await fsp.stat(outP); } catch (e) {} if (outStat && outStat.size) { droppedCover = !!strat.droppedCover; break; } }
      lastErr = (r.stderr || '').split('\n').filter(Boolean).pop() || lastErr;
      outStat = null;
    }
    if (!outStat || !outStat.size) {
      cleanup();
      const msg = timedOut ? 'this file is too large to process in time'
        : lastErr ? 'could not strip metadata: ' + lastErr.slice(0, 180)
        : 'could not strip metadata from this file';
      return res.status(422).json({ error: msg });
    }

    // re-encrypt the cleaned bytes in place, honouring the quota if it grew slightly
    const quota = req.account.quota_bytes;
    const delta = Math.max(0, outStat.size - (row.size || 0));
    if (store.usedBytes() + delta > quota) { cleanup(); return limitError(res, store, quota); }
    await vault.encryptBlob(outP, store.blobPath(row), store.keys);
    store.db.prepare('UPDATE files SET size = @size, date = @date, hasPoster = 0 WHERE id = @id')
      .run({ size: outStat.size, date: Date.now(), id: row.id });
    if (store.keys.v2) store.setKv(row.id, 2);   // blob fully rewritten under v2
    store.bump();
    invalidatePollCache(req.accountId);

    // re-probe so the client can show the now-clean state without a second request
    let groups = [], total = 0;
    try {
      const r2 = await probeProcess('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', outP], { timeoutMs: 15000 });
      const probe = JSON.parse(r2.stdout || '{}');
      groups = shapeProbeMetadata(probe); total = groups.reduce((s, g) => s + g.count, 0);
    } catch (e) {}
    cleanup();
    res.json({ ok: true, file: rowToApi(store.getById(row.id), store), total, groups, droppedCover });
  } catch (e) {
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: 'purge failed: ' + (e.message || '') });
  }
});

/* ---------- uploads ---------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, req.store.tmpDir),
    filename: (req, file, cb) => { req._uploadExt = path.extname(file.originalname || ''); cb(null, 'up' + crypto.randomBytes(6).toString('hex') + req._uploadExt); },
  }),
  limits: { fileSize: 50 * 1e9 },
});

app.post('/api/files', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const store = req.store, quota = req.account.quota_bytes;
  if (store.usedBytes() + req.file.size > quota) { try { fs.unlinkSync(req.file.path); } catch (e) {} return limitError(res, store, quota); }
  const id = uid();
  // If the client cancelled (connection aborted), don't commit a file the user
  // thinks they cancelled — and clean up the temp + any partial blob. (Previously
  // encryption ran to completion on the orphaned request and inserted the row.)
  const aborted = () => req.aborted || res.destroyed || !res.writable;
  try { await vault.encryptBlob(req.file.path, store.blobPath({ id }), store.keys); }
  catch (e) { try { fs.unlinkSync(req.file.path); } catch (_) {} if (!res.headersSent && res.writable) return res.status(500).json({ error: 'encrypt failed' }); return; }
  try { await fsp.unlink(req.file.path); } catch (e) {}
  if (aborted()) {
    // upload was cancelled while we were encrypting — discard the blob, commit nothing
    try { fs.unlinkSync(store.blobPath({ id })); } catch (e) {}
    return;
  }
  const b = req.body || {};
  const num = (v) => (v === undefined || v === '' || v === null) ? null : Number(v);
  // The client sends b.type from a browser MIME sniff, which is reliable for
  // video/audio/image but reports nothing for many formats — notably 3D models
  // (.fbx/.obj/.stl/.glb/.gltf), which it falls back to labelling 'document'. So:
  // trust a concrete media type from the client, but when it's the catch-all
  // 'document' (or missing), let the extension decide — that's what promotes an FBX
  // to 'model3d' so it opens in the 3D viewer instead of the text editor. (The
  // extension map only knows a subset of media exts, so we DON'T override a client
  // 'video'/'audio'/'image' that the map wouldn't recognize, e.g. .avi.)
  const type = (b.type && b.type !== 'document') ? b.type : typeForExt(req._uploadExt || '');
  store.insertRow({
    id, name: req.file.originalname, type, parent: normParent(b.parent),
    size: req.file.size, date: Date.now(), lang: b.lang || null, dur: num(b.dur), w: num(b.w), h: num(b.h),
    artist: b.artist || null, album: b.album || null, hasBlob: 1, storedExt: req._uploadExt || '',
  });
  store.bump();
  invalidatePollCache(req.accountId);
  logAnalytics(store, 'upload', { kind: type });   // Analytics app: record the upload
  res.json(rowToApi(store.getById(id), store));
  // background: pull embedded artist/album/cover from audio so the player shows them
  if (type === 'audio') extractAudioTags(req.accountId, store, id).catch(() => {});
  // background: AI Organization — suggest a folder/tags for this file, and count it
  // toward the next retrain. Best-effort; never blocks or fails the upload.
  setImmediate(() => { suggestForUpload(req.accountId, store, id); noteOrgChange(req.accountId, store, 1); });
});

/* ---------- chunked uploads (bypass CF ~100MB request cap) ----------
   Sessions are reaped if abandoned: a user who closes the tab mid-upload (or a
   dropped connection) would otherwise leave the session in memory AND a temp
   file on disk forever. A periodic sweeper drops anything idle past UPLOAD_TTL
   and unlinks its temp file — this is the slow leak that wedged the server
   after a while / heavy use. */
const uploads = new Map();
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;   // 2h with no activity -> abandoned
/* Chunk size is a function of the SLOWEST uplink we expect, not just the proxy's
   request cap. A phone on cellular pushes ~0.5-2Mbps; at 90MB/chunk that is 6-24
   MINUTES in a single request, which used to age the session out mid-write (see
   the inflight guard below). 16MB keeps a worst-case chunk near a minute, retries
   cheaply on a flaky connection, and still sits far under Cloudflare's ~100MB cap. */
const CHUNK_SIZE = 16 * 1024 * 1024;    // 16MB/chunk over Cloudflare
const DIRECT_CHUNK_SIZE = 512 * 1024 * 1024;   // 512MB/chunk on a DIRECT (non-CF) connection — no proxy cap, so bigger chunks = far fewer requests for multi-GB files
const MAX_PARALLEL_CHUNKS = 10;         // server advertises this; client sends this many at once
function touch(sess) { sess.lastActivity = Date.now(); }
/* A session with a PUT in flight is NEVER abandoned, no matter how long the body
   takes to arrive. Reaping mid-write unlinked the temp file out from under an open
   fd: the writes kept "succeeding" into the orphaned inode, every chunk returned
   200, the bar reached 100%, and only /complete failed (404, no session) — an
   upload that looked perfect client-side and left nothing in the vault. */
function reapUploads() {
  const now = Date.now();
  let reaped = 0;
  for (const [id, sess] of uploads) {
    if (sess.inflight > 0) continue;
    if (now - (sess.lastActivity || 0) > UPLOAD_TTL_MS) {
      trace(sess, 'reaped', { idleMs: now - (sess.lastActivity || 0), received: sess.received, size: sess.size });
      entomb(sess, 'reaped');
      fsp.unlink(sess.path).catch(() => {});
      uploads.delete(id);
      reaped++;
    }
  }
  reapTombstones();
  return reaped;
}

/* ---- upload tracing (feeds the client's "Uh oh!" bug report) ----
   Every session keeps a bounded event log. On failure the client posts its own
   half to /api/uploads/report and we staple this half to it, so a report from a
   phone arrives with both sides already correlated — no asking the user for logs. */
const TRACE_MAX = 200;                    // per-session cap; oldest dropped
function trace(sess, event, data) {
  if (!sess) return;
  if (!sess.trace) sess.trace = [];
  sess.trace.push({ t: Date.now(), event, ...(data || {}) });
  if (sess.trace.length > TRACE_MAX) sess.trace.splice(0, sess.trace.length - TRACE_MAX);
}
/* A report almost always arrives AFTER the session is gone (that's usually the
   failure). Keep a short-lived tombstone of the trace so the server half survives
   long enough to be stapled onto the client's report. */
const tombstones = new Map();             // uploadId -> { accountId, trace, endedAt, name, size }
const TOMBSTONE_MAX = 200, TOMBSTONE_TTL_MS = 6 * 60 * 60 * 1000;
function entomb(sess, why) {
  trace(sess, 'ended', { why });
  tombstones.set(sess.id, {
    accountId: sess.accountId, trace: sess.trace || [], endedAt: Date.now(),
    name: sess.name, size: sess.size, received: sess.received, why,
  });
  if (tombstones.size > TOMBSTONE_MAX) tombstones.delete(tombstones.keys().next().value);
}
function reapTombstones() {
  const now = Date.now();
  for (const [id, t] of tombstones) if (now - t.endedAt > TOMBSTONE_TTL_MS) tombstones.delete(id);
}
setInterval(() => runTracked('reapUploads', reapUploads), 5 * 60 * 1000).unref();   // sweep every 5 min; unref so it never holds the process open

app.post('/api/uploads/init', async (req, res) => {
  const b = req.body || {}, store = req.store, quota = req.account.quota_bytes;
  if (store.usedBytes() + (Number(b.size) || 0) > quota) return limitError(res, store, quota);
  // cap concurrent in-flight uploads per account so a loop of init calls can't
  // exhaust memory/disk. Reap abandoned sessions first so the cap self-heals
  // instead of locking a user out until the periodic sweep.
  reapUploads();
  let mine = 0; for (const s of uploads.values()) if (s.accountId === req.accountId) mine++;
  if (mine >= 20) return res.status(429).json({ error: 'too many uploads in progress; finish or wait for the others' });
  const uploadId = 'u' + crypto.randomBytes(8).toString('hex');
  const ext = path.extname(b.name || '');
  const size = Number(b.size) || 0;
  const sess = {
    id: uploadId, accountId: req.accountId, name: b.name, ext, type: b.type, parent: b.parent,
    lang: b.lang, dur: b.dur, w: b.w, h: b.h, size, received: 0,
    ranges: [],                                  // [start,end) byte ranges written so far (for parallel, out-of-order chunks)
    path: path.join(store.tmpDir, uploadId + ext), lastActivity: Date.now(),
    inflight: 0,                                 // PUTs currently streaming — reap guard
    trace: [], startedAt: Date.now(),
  };
  // preallocate the full file so parallel chunks can write at their own offsets
  const fd = await fsp.open(sess.path, 'w');
  try { if (size > 0) await fd.truncate(size); } finally { await fd.close(); }
  uploads.set(uploadId, sess);
  // Direct connections have no proxy request cap, so hand back a much larger chunk
  // size (fewer requests for multi-GB files). Cloudflare stays under its ~100MB cap.
  const conn = connKind(req);
  const chunkSize = conn === 'direct' ? DIRECT_CHUNK_SIZE : CHUNK_SIZE;
  trace(sess, 'init', { name: b.name, size, type: b.type, conn, chunkSize });
  res.json({ uploadId, chunkSize, maxParallel: MAX_PARALLEL_CHUNKS, conn });
});

/* merge a [start,end) range into the session's coverage list, return total covered bytes */
function addRange(sess, start, end) {
  sess.ranges.push([start, end]);
  sess.ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of sess.ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  sess.ranges = merged;
  sess.received = merged.reduce((n, [s, e]) => n + (e - s), 0);
  return sess.received;
}

/* PUT a chunk at an explicit byte offset. Chunks may arrive in ANY order and in
   parallel; we seek to the offset and stream the body straight to disk (no full
   buffering, so 10 concurrent 90MB chunks cost ~KBs of RAM, not ~900MB). */
app.put('/api/uploads/:id', (req, res) => {
  const sess = uploads.get(req.params.id);
  if (!sess || sess.accountId !== req.accountId) return res.status(404).json({ error: 'no session' });
  const offset = Number(req.query.offset);
  if (!Number.isFinite(offset) || offset < 0 || offset > sess.size) return res.status(400).json({ error: 'bad offset' });
  touch(sess);

  let fd, written = 0, aborted = false, done = false;
  const startedAt = Date.now();
  // inflight is decremented exactly once, on whichever path ends the request —
  // a leak here would pin the session against the reaper forever.
  sess.inflight++;
  const release = () => { if (!done) { done = true; sess.inflight = Math.max(0, sess.inflight - 1); touch(sess); } };
  const fail = (code, msg) => {
    aborted = true;
    if (fd !== undefined) fs.close(fd, () => {});
    trace(sess, 'chunk-fail', { offset, written, code, msg, ms: Date.now() - startedAt });
    release();
    if (!res.headersSent) res.status(code).json({ error: msg });
  };
  fs.open(sess.path, 'r+', (err, openedFd) => {
    if (err) return fail(500, 'open failed');
    fd = openedFd;
    req.on('aborted', () => {
      aborted = true;
      if (fd !== undefined) fs.close(fd, () => {});
      trace(sess, 'chunk-aborted', { offset, written, ms: Date.now() - startedAt });
      release();
    });
    req.on('data', (chunk) => {
      if (aborted) return;
      req.pause();
      // keep the session alive while the body streams: a slow uplink can spend many
      // minutes inside ONE chunk, and without this the reaper treats it as abandoned
      touch(sess);
      if (offset + written + chunk.length > sess.size) { fail(400, 'chunk exceeds declared size'); return; }
      fs.write(fd, chunk, 0, chunk.length, offset + written, (werr, bytes) => {
        if (werr) return fail(500, 'write failed');
        written += bytes;
        req.resume();
      });
    });
    req.on('end', () => {
      if (aborted) return;
      fs.close(fd, () => {
        const received = addRange(sess, offset, offset + written);
        trace(sess, 'chunk-ok', { offset, written, received, ms: Date.now() - startedAt });
        release();
        res.json({ received, offset, written });
      });
    });
  });
});
app.post('/api/uploads/:id/complete', async (req, res) => {
  const id = req.params.id, sess = uploads.get(id);
  // `code` lets the client name the cause instead of guessing from a bare 404
  if (!sess || sess.accountId !== req.accountId) return res.status(404).json({ error: 'no session', code: 'SESSION_GONE' });
  const store = req.store, quota = req.account.quota_bytes;
  const cleanup = async (why) => { entomb(sess, why || 'complete'); try { await fsp.unlink(sess.path); } catch (e) {} uploads.delete(id); };
  // require exactly one contiguous range [0, size): catches gaps even if total
  // bytes happen to match (a missing chunk + a re-sent overlap could otherwise tie)
  const complete = sess.size === 0 || (sess.ranges.length === 1 && sess.ranges[0][0] === 0 && sess.ranges[0][1] === sess.size);
  if (!complete) {
    trace(sess, 'complete-incomplete', { received: sess.received, size: sess.size, ranges: sess.ranges.length });
    return res.status(400).json({ error: 'incomplete upload', code: 'INCOMPLETE', received: sess.received, size: sess.size, ranges: sess.ranges });
  }
  if (store.usedBytes() + sess.size > quota) { trace(sess, 'complete-quota', {}); await cleanup('quota'); return limitError(res, store, quota); }
  const fileId = uid();
  try { await vault.encryptBlob(sess.path, store.blobPath({ id: fileId }), store.keys); }
  catch (e) {
    trace(sess, 'encrypt-fail', { msg: String(e && e.message || e) });
    await cleanup('encrypt-failed');
    return res.status(500).json({ error: 'encrypt failed', code: 'ENCRYPT_FAILED' });
  }
  await cleanup('ok');
  const num = (v) => (v == null || v === '') ? null : Number(v);
  // Same type-correction as the single-shot /api/files upload: a concrete client
  // media type wins, but the catch-all 'document' (which the browser reports for 3D
  // models with no MIME) defers to the extension so .fbx/.obj/.stl/.glb/.gltf become
  // 'model3d'. Large models are common and arrive here via the chunked path.
  const type = (sess.type && sess.type !== 'document') ? sess.type : typeForExt(sess.ext || '');
  store.insertRow({
    id: fileId, name: sess.name, type, parent: normParent(sess.parent),
    size: sess.size, date: Date.now(), lang: sess.lang || null, dur: num(sess.dur), w: num(sess.w), h: num(sess.h),
    hasBlob: 1, storedExt: sess.ext,
  });
  store.bump();
  logAnalytics(store, 'upload', { kind: type });   // Analytics app: record the (chunked) upload
  res.json(rowToApi(store.getById(fileId), store));
  // background: pull embedded artist/album/cover from audio so the player shows them
  if (type === 'audio') extractAudioTags(req.accountId, store, fileId).catch(() => {});
  // background: AI Organization suggestion + retrain counter (best-effort)
  setImmediate(() => { suggestForUpload(req.accountId, store, fileId); noteOrgChange(req.accountId, store, 1); });
});
app.delete('/api/uploads/:id', async (req, res) => {
  const sess = uploads.get(req.params.id);
  if (sess && sess.accountId === req.accountId) {
    entomb(sess, 'client-abort');
    try { await fsp.unlink(sess.path); } catch (e) {}
    uploads.delete(req.params.id);
  }
  res.json({ ok: true });
});

/* Accept the client's half of a failed upload, staple on ours (live session if it
   still exists, else the tombstone), and file it into the SAME bug_reports inbox
   admins already triage — no parallel report store. The user never has to find or
   send a log; the "Uh oh!" dialog posts this for them, which is the whole point on
   a phone. Body is bounded and the server trace is account-scoped. */
app.post('/api/uploads/report', (req, res) => {
  const b = req.body || {};
  const id = String(b.uploadId || '');
  const sess = uploads.get(id), tomb = tombstones.get(id);
  const mine = (sess && sess.accountId === req.accountId) || (tomb && tomb.accountId === req.accountId);
  const serverTrace = mine ? ((sess && sess.trace) || (tomb && tomb.trace) || []) : [];
  const ended = tomb ? tomb.why : (sess ? 'live' : 'unknown');
  const code = clip(b.code || 'UNKNOWN', 64);
  const name = clip(b.name, 300), size = Number(b.size) || 0;
  const note = clip(b.note, 1000).trim();
  // an upload that silently loses a file is high severity; a quota/limit stop is not
  const severity = (code === 'LIMIT') ? 'low' : (code === 'SESSION_GONE' || code === 'ENCRYPT_FAILED') ? 'high' : 'medium';
  const human = (code === 'SESSION_GONE') ? 'the server lost the upload session before it finished saving'
    : (code === 'INCOMPLETE') ? 'chunks were missing when the upload finalized'
    : (code === 'ENCRYPT_FAILED') ? 'the vault encrypt step failed after upload'
    : (code === 'NETWORK') ? 'the connection dropped mid-upload' : 'the upload did not save';
  const lines = [
    `Automatic upload failure report — ${human}.`,
    ``,
    `file:     ${name} (${size} bytes, ${clip(b.type, 40) || 'unknown'})`,
    `code:     ${code}`,
    `message:  ${clip(b.message, 300) || '-'}`,
    `uploadId: ${id || '-'}`,
    `conn:     ${clip(b.conn, 20) || '-'}   chunkSize: ${Number(b.chunkSize) || 0}`,
    `server:   session ${ended}`,
    note ? `\nuser note: ${note}` : '',
    ``,
    `--- client events ---`,
    JSON.stringify(Array.isArray(b.events) ? b.events.slice(-TRACE_MAX) : [], null, 1),
    ``,
    `--- server trace ---`,
    JSON.stringify(serverTrace, null, 1),
  ].join('\n');
  const rep = bugStore({
    source: 'user', accountId: req.accountId,
    reporter: (req.account && (req.account.display || req.account.username)) || null,
    area: 'uploads', severity,
    title: `Upload failed (${code}): ${name || 'file'}`,
    body: lines,
    meta: { uploadId: id || null, code, size, conn: clip(b.conn, 20), serverEnded: ended, ua: clip(req.headers['user-agent'], 300) },
  });
  console.warn(`[simplex] UPLOAD REPORT ${rep.id} ${code} user=${rep.reporter} file=${name} ${size}B server=${ended}`);
  res.json({ ok: true, reportId: rep.id });
});

/* ---------- covers ---------- */
app.post('/api/files/:id/cover', upload.single('cover'), async (req, res) => {
  const store = req.store, row = store.getById(req.params.id);
  if (!row) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {} return res.status(404).json({ error: 'not found' }); }
  if (!req.file) return res.status(400).json({ error: 'no file' });
  try { await vault.encryptBlob(req.file.path, store.coverPath(row), store.keys); }
  catch (e) { try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(500).json({ error: 'encrypt failed' }); }
  try { await fsp.unlink(req.file.path); } catch (e) {}
  store.db.prepare('UPDATE files SET hasCover = 1, coverExt = ? WHERE id = ?').run(req._uploadExt || '', row.id);
  store.bump();
  res.json(rowToApi(store.getById(row.id), store));
});
app.delete('/api/files/:id/cover', (req, res) => {
  const store = req.store, row = store.getById(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  store.unlinkCover(row);
  store.db.prepare('UPDATE files SET hasCover = 0, coverExt = NULL WHERE id = ?').run(row.id);
  store.bump();
  res.json(rowToApi(store.getById(row.id), store));
});

/* ---------- extract a .zip into a new folder (app backups, bundles) ----------
   Decrypts the stored zip to a temp file, reads its central directory, checks
   the total uncompressed size against the quota, then recreates the folder tree
   and encrypts each extracted file into the vault. */
function typeForExt(ext) {
  ext = String(ext || '').toLowerCase().replace(/^\./, '');
  if (['mp4', 'webm', 'mkv', 'mov'].includes(ext)) return 'video';
  if (['mp3', 'flac', 'wav', 'm4a', 'ogg'].includes(ext)) return 'audio';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  // EXR/TIFF are high-quality images browsers can't render in an <img>; they're
  // classified as 'image' and get a server-rendered PNG preview (the poster
  // pipeline, extended to PREVIEW_EXTS), plus ffmpeg convert-to/from and a
  // right-click heightmap view.
  if (['exr', 'tif', 'tiff'].includes(ext)) return 'image';
  if (['gltf', 'glb', 'obj', 'fbx', 'stl'].includes(ext)) return 'model3d';
  if (ext === 'uasset') return 'uasset';   // Unreal Engine package → asset inspector
  return 'document';
}
/* decrypt an encrypted blob fully to a plaintext temp path */
function decryptBlobToFile(encPath, keys, destPath) {
  return new Promise((resolve, reject) => {
    const dec = vault.decryptBlobRange(encPath, keys, null, null);
    if (!dec) return reject(new Error('cannot read blob'));
    const out = fs.createWriteStream(destPath);
    pipeline(dec.stream, out, (err) => err ? reject(err) : resolve());
  });
}

app.post('/api/files/:id/extract', async (req, res) => {
  const store = req.store, quota = req.account.quota_bytes;
  const row = store.getById(req.params.id);
  if (!row || !row.hasBlob) return res.status(404).json({ error: 'not found' });
  const name = store.decName(row);
  if (!/\.zip$/i.test(name)) return res.status(400).json({ error: 'not a .zip file' });

  const tmpZip = path.join(store.tmpDir, 'x' + crypto.randomBytes(6).toString('hex') + '.zip');
  let entries;
  try {
    await decryptBlobToFile(store.blobPath(row), store.keys, tmpZip);
    entries = unzip.listEntries(tmpZip);
  } catch (e) {
    try { await fsp.unlink(tmpZip); } catch (_) {}
    return res.status(400).json({ error: 'could not read zip: ' + e.message });
  }
  if (!entries.length) { try { await fsp.unlink(tmpZip); } catch (_) {} return res.status(400).json({ error: 'zip is empty' }); }

  // quota check against total uncompressed size
  const totalBytes = entries.reduce((n, e) => n + (e.uncompSize || 0), 0);
  if (store.usedBytes() + totalBytes > quota) { try { await fsp.unlink(tmpZip); } catch (_) {} return limitError(res, store, quota); }

  // cap to keep a malicious/huge archive from exhausting the box
  if (entries.length > 20000) { try { await fsp.unlink(tmpZip); } catch (_) {} return res.status(400).json({ error: 'too many entries (max 20000)' }); }

  const dest = normParent(req.body && req.body.parent) ?? (row.parent ?? null);
  // top-level folder named after the zip (deduped)
  const rootName = dedupeName(name.replace(/\.zip$/i, ''), store, dest);
  const created = [];
  const dirCache = new Map();   // "a/b/c" -> folderId

  // ensure a nested dir path exists under the root folder, return its id
  const ensureDir = (relDir, rootId) => {
    if (!relDir) return rootId;
    if (dirCache.has(relDir)) return dirCache.get(relDir);
    const parts = relDir.split('/');
    let parent = rootId, acc = '';
    for (const seg of parts) {
      acc = acc ? acc + '/' + seg : seg;
      let id = dirCache.get(acc);
      if (!id) {
        id = uid();
        store.insertRow({ id, name: seg, type: 'folder', parent, size: 0, date: Date.now() });
        created.push(store.getById(id));
        dirCache.set(acc, id);
      }
      parent = id;
    }
    return parent;
  };

  try {
    const rootId = uid();
    store.insertRow({ id: rootId, name: rootName, type: 'folder', parent: dest, size: 0, date: Date.now() });
    created.push(store.getById(rootId));

    for (const entry of entries) {
      const slash = entry.name.lastIndexOf('/');
      const relDir = slash >= 0 ? entry.name.slice(0, slash) : '';
      const base = slash >= 0 ? entry.name.slice(slash + 1) : entry.name;
      const parentId = ensureDir(relDir, rootId);
      const fileId = uid();
      const tmpOut = path.join(store.tmpDir, 'e' + crypto.randomBytes(6).toString('hex'));
      try {
        await unzip.extractOne(tmpZip, entry, tmpOut);
        await vault.encryptBlob(tmpOut, store.blobPath({ id: fileId }), store.keys);
      } finally { try { await fsp.unlink(tmpOut); } catch (_) {} }
      const ext = path.extname(base);
      store.insertRow({
        id: fileId, name: base, type: typeForExt(ext), parent: parentId,
        size: entry.uncompSize || 0, date: Date.now(),
        lang: typeForExt(ext) === 'document' ? 'text' : null,
        hasBlob: 1, storedExt: ext,
      });
      created.push(store.getById(fileId));
    }
  } catch (e) {
    try { await fsp.unlink(tmpZip); } catch (_) {}
    return res.status(500).json({ error: 'extract failed: ' + e.message });
  }
  try { await fsp.unlink(tmpZip); } catch (_) {}
  store.bump();
  res.json({ ok: true, folderName: rootName, count: created.length, created: created.map(r => rowToApi(r, store)) });
});

/* ---------- folders ---------- */
app.post('/api/folders', (req, res) => {
  const { name, parent } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uid();
  req.store.insertRow({ id, name, type: 'folder', parent: normParent(parent), size: 0, date: Date.now() });
  req.store.bump();
  res.json(rowToApi(req.store.getById(id), req.store));
});

/* ---------- text document (content-backed, no blob) ----------
   Creates a normal vault document whose text lives in the encrypted `content`
   column — the same shape the in-app editor reads/writes — so AI-created or
   programmatically-created files open & download correctly. */
app.post('/api/files/doc', (req, res) => {
  const b = req.body || {}, store = req.store, quota = req.account.quota_bytes;
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const content = typeof b.content === 'string' ? b.content : '';
  const size = Buffer.byteLength(content, 'utf8');
  if (store.usedBytes() + size > quota) return limitError(res, store, quota);
  const id = uid();
  store.insertRow({
    id, name: dedupeName(name, store, normParent(b.parent)), type: 'document',
    parent: normParent(b.parent), size, date: Date.now(),
    content, lang: typeof b.lang === 'string' ? b.lang : null,
  });
  store.bump();
  res.json(rowToApi(store.getById(id), store));
});

app.post('/api/files/:id/seal', upload.single('file'), async (req, res) => {
  const store = req.store;
  const row = store.getById(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!req.file) return res.status(400).json({ error: 'encrypted payload required' });
  const lockSpec = typeof req.body?.lockSpec === 'string' ? req.body.lockSpec : null;
  if (!lockSpec) { try { fs.unlinkSync(req.file.path); } catch (e) {} return res.status(400).json({ error: 'lockSpec required' }); }
  const plainSize = Number(req.body?.plainSize);
  try { await vault.encryptBlob(req.file.path, store.blobPath(row), store.keys); }
  catch (e) { try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(500).json({ error: 'encrypt failed' }); }
  try { await fsp.unlink(req.file.path); } catch (e) {}
  const stmt = store.db.prepare(
    'UPDATE files SET hasBlob = 1, content = NULL, locked = 1, lockSpec = ?, size = ?, storedExt = COALESCE(storedExt, ? ) WHERE id = ?'
  );
  stmt.run(vault.encText(lockSpec, store.keys), Number.isFinite(plainSize) && plainSize >= 0 ? Math.floor(plainSize) : row.size, path.extname(row.name || '') || null, row.id);
  if (store.keys.v2) store.setKv(row.id, 2);   // sealing rewrote the whole blob under v2
  store.bump();
  invalidatePollCache(req.accountId);
  res.json(rowToApi(store.getById(row.id), store));
});

/* Permanently remove a per-item passphrase lock: the client has decrypted the
   bytes and uploads the plaintext here. We store it as the (at-rest encrypted)
   blob and clear locked/lockSpec, turning the item back into a normal file. */
app.post('/api/files/:id/unseal', upload.single('file'), async (req, res) => {
  const store = req.store;
  const row = store.getById(req.params.id);
  if (!row) { try { if (req.file) fs.unlinkSync(req.file.path); } catch (e) {} return res.status(404).json({ error: 'not found' }); }
  if (!req.file) return res.status(400).json({ error: 'decrypted payload required' });
  const plainSize = req.file.size;
  try { await vault.encryptBlob(req.file.path, store.blobPath(row), store.keys); }
  catch (e) { try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(500).json({ error: 'store failed' }); }
  try { await fsp.unlink(req.file.path); } catch (e) {}
  store.db.prepare(
    'UPDATE files SET hasBlob = 1, content = NULL, locked = 0, lockSpec = NULL, size = ? WHERE id = ?'
  ).run(plainSize, row.id);
  if (store.keys.v2) store.setKv(row.id, 2);   // unsealing rewrote the whole blob under v2
  store.bump();
  invalidatePollCache(req.accountId);
  res.json(rowToApi(store.getById(row.id), store));
});

/* Overwrite a file's bytes in place with an uploaded payload (used by the .sav
   Save Editor to write back edited bytes). Plaintext path — refuses locked items
   (their blob is client-encrypted). Honours the quota for any size growth. */
app.post('/api/files/:id/replace', upload.single('file'), async (req, res) => {
  const store = req.store, row = store.getById(req.params.id);
  if (!row) { try { if (req.file) fs.unlinkSync(req.file.path); } catch (e) {} return res.status(404).json({ error: 'not found' }); }
  if (!req.file) return res.status(400).json({ error: 'no file' });
  if (row.locked) { try { fs.unlinkSync(req.file.path); } catch (e) {} return res.status(409).json({ error: 'unlock this file before replacing it' }); }
  if ((row.kv || 1) === 1 && req.account.key_enrolled) { try { fs.unlinkSync(req.file.path); } catch (e) {} return res.status(409).json({ error: 'this file still uses the old key — re-encrypt it to edit or download', code: 'LEGACY' }); }
  const quota = req.account.quota_bytes, delta = Math.max(0, req.file.size - (row.size || 0));
  if (store.usedBytes() + delta > quota) { try { fs.unlinkSync(req.file.path); } catch (e) {} return limitError(res, store, quota); }
  try { await vault.encryptBlob(req.file.path, store.blobPath(row), store.keys); }
  catch (e) { try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(500).json({ error: 'store failed' }); }
  try { await fsp.unlink(req.file.path); } catch (e) {}
  store.db.prepare('UPDATE files SET hasBlob = 1, content = NULL, size = ?, date = ?, hasPoster = 0 WHERE id = ?').run(req.file.size, Date.now(), row.id);
  if (store.keys.v2) store.setKv(row.id, 2);   // blob fully rewritten under v2
  store.bump();
  invalidatePollCache(req.accountId);
  res.json(rowToApi(store.getById(row.id), store));
});

/* Re-encrypt ONE file from the legacy master-derived key to the account's
   per-user key (option A of the migration — option B is the full-vault
   lockdown at /api/keys/reencrypt-vault). Streaming, atomic, quota-neutral. */
app.post('/api/files/:id/reencrypt', async (req, res) => {
  const store = req.store, row = store.getById(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.type === 'folder') return res.status(400).json({ error: 'pick files, or use "Re-encrypt entire vault" in Settings' });
  if (!store.keys.v2) return res.status(409).json({ error: 'keys are not loaded — sign in again first' });
  if ((row.kv || 1) !== 1) return res.json(rowToApi(row, store));   // already modern — idempotent
  try { await reencryptRow(store, row); }
  catch (e) {
    console.error('[simplex] re-encrypt failed for', row.id, e && (e.message || e));
    return res.status(500).json({ error: 're-encryption failed — nothing was changed' });
  }
  store.bump();
  invalidatePollCache(req.accountId);
  res.json(rowToApi(store.getById(row.id), store));
});

/* ---------- patch ---------- */
app.patch('/api/files/:id', (req, res) => {
  const store = req.store, row = store.getById(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  // content edits on a BLOB-backed Legacy row are gated (the stale v1 blob would
  // linger beneath the new text). Metadata-only patches (rename, star, move,
  // tags…) stay open — those fields re-encrypt v2 on write and are harmless.
  // A content edit on a blob-LESS row rewrites everything the row is, so it's a
  // clean upgrade: allow it and stamp kv=2 below.
  if (b.content !== undefined && row.hasBlob && legacyGate(req, res, row)) return;
  const fields = [], vals = {};
  const set = (col, val) => { fields.push(`${col} = @${col}`); vals[col] = val; };
  if (b.name !== undefined) set('name', vault.encText(String(b.name), store.keys));
  if (b.starred !== undefined) set('starred', b.starred ? 1 : 0);
  if (b.trashed !== undefined) set('trashed', b.trashed ? 1 : 0);
  // editing a document's content invalidates its cached content fingerprint, so
  // clear it — the next training pass re-samples and re-fingerprints the new text.
  if (b.content !== undefined) {
    set('content', b.content == null ? null : vault.encText(String(b.content), store.keys));
    set('fp', null);
    if (!row.hasBlob && store.keys.v2) set('kv', 2);   // full rewrite of a content-backed doc = upgrade
  }
  if (b.locked !== undefined) set('locked', b.locked ? 1 : 0);
  if (b.lockSpec !== undefined) set('lockSpec', b.lockSpec == null ? null : vault.encText(String(b.lockSpec), store.keys));
  if (b.size !== undefined) set('size', b.size);
  if (b.date !== undefined) set('date', b.date);
  // tags: validated id-array via the store helper below (kept separate so the
  // generic column setter doesn't have to know about the dictionary).
  if (b.tags !== undefined) store.setFileTags(req.params.id, Array.isArray(b.tags) ? b.tags : []);
  if (fields.length) { vals.id = req.params.id; store.db.prepare(`UPDATE files SET ${buildSetClause('files', fields)} WHERE id = @id`).run(vals); }
  if (fields.length || b.tags !== undefined) { store.bump(); invalidatePollCache(req.accountId); }
  res.json(rowToApi(store.getById(req.params.id), store));
});

/* ---------- tags dictionary (per-account) ---------- */
app.get('/api/tags', (req, res) => res.json(req.store.tagsList()));
app.post('/api/tags', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const tag = req.store.tagCreate({ name, color: normTagColor(b.color) });
  req.store.bump(); invalidatePollCache(req.accountId);
  res.json(tag);
});
app.patch('/api/tags/:id', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.name !== undefined) { const n = String(b.name).trim(); if (!n) return res.status(400).json({ error: 'name required' }); patch.name = n; }
  if (b.color !== undefined) patch.color = normTagColor(b.color);
  const tag = req.store.tagUpdate(req.params.id, patch);
  if (!tag) return res.status(404).json({ error: 'not found' });
  req.store.bump(); invalidatePollCache(req.accountId);
  res.json(tag);
});
app.delete('/api/tags/:id', (req, res) => {
  if (!req.store.tagGet(req.params.id)) return res.status(404).json({ error: 'not found' });
  req.store.tagDelete(req.params.id);
  req.store.bump(); invalidatePollCache(req.accountId);
  res.json({ ok: true });
});
/* set the tag id-array on a single file/folder (replace semantics). */
app.put('/api/files/:id/tags', (req, res) => {
  const b = req.body || {};
  const out = req.store.setFileTags(req.params.id, Array.isArray(b.tags) ? b.tags : []);
  if (!out) return res.status(404).json({ error: 'not found' });
  req.store.bump(); invalidatePollCache(req.accountId);
  // a manual tagging decision is a training signal — count it toward the next retrain
  setImmediate(() => noteOrgChange(req.accountId, req.store, 1));
  res.json(out);
});

/* ---------- trash / restore / delete (cascade) ---------- */
function cascade(store, id) { const row = store.getById(id); return [id, ...(row && row.type === 'folder' ? store.descendantIds(id) : [])]; }
app.post('/api/files/:id/trash', (req, res) => {
  const store = req.store; if (!store.getById(req.params.id)) return res.status(404).json({ error: 'not found' });
  const ids = cascade(store, req.params.id);
  const stmt = store.db.prepare('UPDATE files SET trashed = 1 WHERE id = ?');
  store.db.transaction((a) => a.forEach(i => stmt.run(i)))(ids);
  store.bump();
  invalidatePollCache(req.accountId);
  res.json({ ok: true, ids });
});
app.post('/api/files/:id/restore', (req, res) => {
  const store = req.store; if (!store.getById(req.params.id)) return res.status(404).json({ error: 'not found' });
  const ids = cascade(store, req.params.id);
  const stmt = store.db.prepare('UPDATE files SET trashed = 0 WHERE id = ?');
  store.db.transaction((a) => a.forEach(i => stmt.run(i)))(ids);
  store.bump();
  invalidatePollCache(req.accountId);
  res.json({ ok: true, ids });
});
app.delete('/api/files/:id', (req, res) => {
  const store = req.store; if (!store.getById(req.params.id)) return res.status(404).json({ error: 'not found' });
  const ids = cascade(store, req.params.id);
  store.db.transaction((arr) => {
    for (const i of arr) { const r = store.getById(i); if (r) { store.unlinkBlob(r); store.unlinkCover(r); store.st.del.run(i); sysStmt.delSharesForFile.run(store.id, i); store.suggestionDelete(i); } }
  })(ids);
  store.bump();
  invalidatePollCache(req.accountId);
  res.json({ ok: true, ids });
});
app.post('/api/trash/empty', (req, res) => {
  const store = req.store;
  const trashedRows = store.db.prepare('SELECT id FROM files WHERE trashed = 1').all();
  const kill = new Set();
  for (const r of trashedRows) { kill.add(r.id); for (const d of store.descendantIds(r.id)) kill.add(d); }
  store.db.transaction((arr) => {
    for (const i of arr) { const r = store.getById(i); if (r) { store.unlinkBlob(r); store.unlinkCover(r); store.st.del.run(i); sysStmt.delSharesForFile.run(store.id, i); store.suggestionDelete(i); } }
  })([...kill]);
  store.bump();
  invalidatePollCache(req.accountId);
  res.json({ ok: true, count: kill.size });
});

/* ---------- move (batch, cycle-checked) ---------- */
app.post('/api/files/move', (req, res) => {
  const store = req.store, b = req.body || {};
  if (!Array.isArray(b.ids)) return res.status(400).json({ error: 'ids[] required' });
  const dest = normParent(b.parent);
  if (dest !== null) { const d = store.getById(dest); if (!d) return res.status(404).json({ error: 'destination not found' }); if (d.type !== 'folder') return res.status(400).json({ error: 'destination is not a folder' }); }
  const moved = [], skipped = [];
  const upd = store.db.prepare('UPDATE files SET parent = ? WHERE id = ?');
  store.db.transaction((ids) => {
    for (const id of ids) {
      const row = store.getById(id);
      if (!row) { skipped.push(id); continue; }
      if (dest !== null && row.type === 'folder' && isInSubtree(store, dest, id)) { skipped.push(id); continue; }
      if ((row.parent ?? null) === dest) continue;
      upd.run(dest, id); moved.push(id);
    }
  })(b.ids);
  if (moved.length) { store.bump(); setImmediate(() => noteOrgChange(req.accountId, store, moved.length)); }
  res.json({ ok: true, moved, skipped });
});

/* ---------- copy (deep; copies encrypted blobs/covers as-is) ----------
   Done ASYNC and in batches so a big folder copy doesn't freeze the single Node
   thread. The old version copied every blob with fs.copyFileSync inside one
   synchronous SQLite transaction — for a large library that blocked the event
   loop (and thus /api/health) for minutes, which the supervisor saw as "hung"
   and force-restarted. Now: blobs copy via async fs.promises (non-blocking I/O)
   and rows insert in small transactions, yielding between batches so health and
   other requests keep flowing. */
const COPY_BATCH = 50;   // rows per transaction; yield to the loop between batches
app.post('/api/files/:id/copy', async (req, res) => {
  const store = req.store, src = store.getById(req.params.id);
  if (!src) return res.status(404).json({ error: 'not found' });
  const dest = req.body && 'parent' in req.body ? normParent(req.body.parent) : (src.parent ?? null);
  if (dest !== null) { const d = store.getById(dest); if (!d || d.type !== 'folder') return res.status(400).json({ error: 'bad destination' }); }
  if (dest !== null && src.type === 'folder' && isInSubtree(store, dest, src.id)) return res.status(400).json({ error: 'cannot copy a folder into itself' });

  let addBytes = src.type === 'folder' ? 0 : (src.size || 0);
  for (const d of store.descendantIds(src.id)) { const dr = store.getById(d); if (dr && dr.type !== 'folder') addBytes += dr.size || 0; }
  if (store.usedBytes() + addBytes > req.account.quota_bytes) return limitError(res, store, req.account.quota_bytes);

  // 1) Flatten the subtree into a plan (cheap, in-memory): each item carries its
  //    source node + the NEW id of its parent, so inserts can run in any batch.
  const topName = dedupeName(store.decName(src), store, dest);
  const plan = [];   // { node, newId, parent, nameVal }
  const enqueue = (node, parent, newName) => {
    const newId = uid();
    const nameVal = newName != null ? vault.encText(newName, store.keys) : node.name;
    plan.push({ node, newId, parent, nameVal });
    if (node.type === 'folder') for (const kid of store.st.childRows.all(node.id)) enqueue(kid, newId, null);
    return newId;
  };
  enqueue(src, dest, topName);

  // 2) Copy blobs/covers asynchronously (non-blocking disk I/O), in parallel-ish
  //    small waves so we neither block the loop nor open thousands of fds at once.
  const COPY_IO_PARALLEL = 8;
  for (let i = 0; i < plan.length; i += COPY_IO_PARALLEL) {
    const wave = plan.slice(i, i + COPY_IO_PARALLEL).map(async ({ node, newId }) => {
      if (node.hasBlob) { const from = store.blobPath(node); try { await fsp.copyFile(from, store.blobPath({ id: newId })); } catch (e) {} }
      if (node.hasCover) { const from = store.coverPath(node); try { await fsp.copyFile(from, store.coverPath({ id: newId })); } catch (e) {} }
    });
    await Promise.all(wave);   // awaiting yields the loop -> /api/health stays responsive
  }

  // 3) Insert rows in small batched transactions, yielding between batches.
  const created = [];
  const insertBatch = store.db.transaction((items) => {
    for (const { node, newId, parent, nameVal } of items) {
      store.insertRowRaw({
        id: newId, name: nameVal, type: node.type, parent, size: node.size, date: Date.now(),
        trashed: 0, starred: 0, content: node.content, lang: node.lang, dur: node.dur,
        w: node.w, h: node.h, artist: node.artist, album: node.album,
        hasBlob: node.hasBlob, storedExt: node.storedExt, hasCover: node.hasCover, coverExt: node.coverExt,
        tags: node.tags,   // carry tags onto the copy
        kv: node.kv || 1,  // a byte-for-byte copy keeps the SOURCE's key generation
      });
      created.push(rowToApi(store.getById(newId), store));
    }
  });
  for (let i = 0; i < plan.length; i += COPY_BATCH) {
    insertBatch(plan.slice(i, i + COPY_BATCH));
    if (i + COPY_BATCH < plan.length) await new Promise(r => setImmediate(r));   // let the loop breathe
  }

  store.bump();
  res.json({ ok: true, created });
});

/* ============================================================
   SHARES (tokens in system DB -> owning account's store)
   ============================================================ */
// slug rules: lowercase letters/digits/hyphen, 3–48 chars, not all-hyphens.
// Reserved words can't be slugs (they'd shadow real routes at /s/<slug>).
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])?$/;
const RESERVED_SLUGS = new Set(['api', 'raw', 'cover', 'files', 'admin', 'index', 'null', 'undefined']);
function normSlug(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
/* file extension used to dress up the raw url (cosmetic, for embed unfurling) */
function shareRawExt(store, row) {
  if (!row || row.type === 'folder') return '';
  const name = store.decName(row);
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : (row.storedExt || '').toLowerCase().replace(/^\./, '');
}
/* the API shape for one share row: native (/s) + raw (/r) urls + metadata. Raw url
   is only meaningful for a FILE share (a folder has no single file to hotlink). */
function shareApiShape(s, store) {
  const f = store.getById(s.file_id);
  const ref = s.slug || s.token;                 // custom slug wins for the public url
  const isFile = f && f.type !== 'folder' && !f.trashed;
  const ext = isFile ? shareRawExt(store, f) : '';
  return {
    token: s.token, slug: s.slug || null,
    url: '/s/' + ref,                            // Simplex-native viewer page
    rawUrl: isFile ? '/r/' + ref + (ext ? '.' + ext : '') : null,   // direct bytes (embeds)
    rawExt: ext || null,
    fileId: s.file_id, created: s.created, allowDownload: !!s.allow_download,
    name: f ? store.decName(f) : '(deleted)', type: f ? f.type : null, trashed: f ? !!f.trashed : true,
  };
}
app.post('/api/shares', requireAuth, (req, res) => {
  const store = req.store, b = req.body || {};
  const row = store.getById(b.fileId);
  if (!row) return res.status(404).json({ error: 'file not found' });
  if (row.trashed) return res.status(400).json({ error: 'cannot share a trashed item' });
  const token = crypto.randomBytes(9).toString('base64url');
  const allow = b.allowDownload === false ? 0 : 1;
  sysStmt.insShare.run(token, store.id, row.id, Date.now(), allow);
  res.json(shareApiShape(sysStmt.getShare.get(token), store));
});
app.get('/api/shares', requireAuth, (req, res) => {
  const store = req.store;
  res.json(sysStmt.listSharesForAcct.all(store.id).map(s => shareApiShape(s, store)));
});
/* Set or clear a share's custom slug. Body: { slug: "<word>" | "" }. Empty clears it
   (back to the random token). 409 on collision, 400 on a malformed/reserved slug. */
app.post('/api/shares/:token/slug', requireAuth, (req, res) => {
  const store = req.store;
  const share = sysStmt.getShare.get(req.params.token);
  if (!share || share.account_id !== store.id) return res.status(404).json({ error: 'link not found' });
  const raw = normSlug((req.body || {}).slug);
  if (raw === '') {   // clear
    sysStmt.setShareSlug.run(null, share.token, store.id);
    return res.json(shareApiShape(sysStmt.getShare.get(share.token), store));
  }
  if (!SLUG_RE.test(raw) || RESERVED_SLUGS.has(raw)) return res.status(400).json({ error: 'use 3–48 letters, numbers or hyphens (not a reserved word)' });
  const clash = sysStmt.getShareBySlug.get(raw);
  if (clash && clash.token !== share.token) return res.status(409).json({ error: 'that name is already taken' });
  try { sysStmt.setShareSlug.run(raw, share.token, store.id); }
  catch (e) { return res.status(409).json({ error: 'that name is already taken' }); }
  res.json(shareApiShape(sysStmt.getShare.get(share.token), store));
});
app.delete('/api/shares/:token', requireAuth, (req, res) => {
  const info = sysStmt.delShareScoped.run(req.params.token, req.accountId);
  res.json({ ok: true, deleted: info.changes });
});

/* ============================================================
   CUSTOM API — key management (session-authed; the owner manages their own
   keys here. The keys themselves authenticate the public /api/v1 surface below.)
   ============================================================ */
const MAX_KEYS_PER_ACCT = 25;
app.get('/api/apikeys', requireAuth, (req, res) => {
  res.json(sysStmt.listApiKeysForAcct.all(req.accountId).map(apiKeyToApi));
});
app.post('/api/apikeys', requireAuth, (req, res) => {
  const b = req.body || {};
  const label = String(b.label || '').trim().slice(0, 80) || 'API key';
  const scopes = sanitizeScopes(b.scopes);
  if (!scopes.length) return res.status(400).json({ error: 'pick at least one permission' });
  if (sysStmt.listApiKeysForAcct.all(req.accountId).length >= MAX_KEYS_PER_ACCT)
    return res.status(429).json({ error: `key limit reached (max ${MAX_KEYS_PER_ACCT}) — delete one first` });
  const token = genApiToken();
  const id = 'k' + crypto.randomBytes(6).toString('hex');
  sysStmt.insApiKey.run({
    id, account_id: req.accountId, label, prefix: token.slice(0, 12),
    token_hash: hashToken(token), scopes: JSON.stringify(scopes),
    enabled: 1, created: Date.now(), last_used: null,
  });
  // the full token is returned exactly once — it is never stored or recoverable
  res.json({ ...apiKeyToApi(sysStmt.getApiKey.get(id)), token });
});
app.patch('/api/apikeys/:id', requireAuth, (req, res) => {
  const k = sysStmt.getApiKey.get(req.params.id);
  if (!k || k.account_id !== req.accountId) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const label = b.label != null ? String(b.label).trim().slice(0, 80) || 'API key' : (k.label || 'API key');
  let scopes = b.scopes != null ? sanitizeScopes(b.scopes) : null;
  if (scopes && !scopes.length) return res.status(400).json({ error: 'pick at least one permission' });
  if (!scopes) { try { scopes = JSON.parse(k.scopes); } catch (e) { scopes = []; } }
  const enabled = b.enabled != null ? (b.enabled ? 1 : 0) : k.enabled;
  sysStmt.updApiKey.run({ id: k.id, account_id: req.accountId, label, scopes: JSON.stringify(scopes), enabled });
  res.json(apiKeyToApi(sysStmt.getApiKey.get(k.id)));
});
app.delete('/api/apikeys/:id', requireAuth, (req, res) => {
  const info = sysStmt.delApiKey.run(req.params.id, req.accountId);
  res.json({ ok: true, deleted: info.changes });
});

/* ============================================================
   PUBLIC API (/api/v1) — authenticated by a Custom API key, not the session
   cookie. Token-based + permissive CORS so an external app/workspace can call
   it directly from a browser or a server. Every route checks the key's scopes.
   ============================================================ */
/* lightweight per-key rate limit + throttled last_used writes */
const apiRate = new Map();
const API_RATE_MAX = 600, API_RATE_WINDOW_MS = 60_000;
function rateOk(keyId) {
  const now = Date.now();
  let r = apiRate.get(keyId);
  if (!r || r.resetAt <= now) { r = { count: 0, resetAt: now + API_RATE_WINDOW_MS }; apiRate.set(keyId, r); }
  r.count++;
  return r.count <= API_RATE_MAX;
}
setInterval(() => { const now = Date.now(); for (const [k, r] of apiRate) if (r.resetAt <= now) apiRate.delete(k); }, 5 * 60 * 1000).unref();
const _apiKeyTouched = new Map();
function bearerToken(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1].trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  return null;
}
function apiCors(req, res, next) {
  // token-authed (no cookies) so a wildcard origin is safe — there's no ambient
  // credential a malicious page could ride on; the caller must present the key.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, X-API-Key');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Disposition');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}
function requireApiKey(req, res, next) {
  const tok = bearerToken(req);
  if (!tok) return res.status(401).json({ error: 'missing API key — send "Authorization: Bearer <key>"' });
  const row = sysStmt.getApiKeyByHash.get(hashToken(tok));
  if (!row) return res.status(401).json({ error: 'invalid API key' });
  if (!row.enabled) return res.status(403).json({ error: 'this API key is disabled' });
  const account = sysStmt.getAcct.get(row.account_id);
  if (!account) return res.status(401).json({ error: 'the account for this key no longer exists' });
  // per-user keys: the API can only touch v2 data while the owner's UDK is
  // resident (they signed in since the last restart), and never mid-migration
  if (account.key_enrolled && !udkResident(account.id))
    return res.status(503).json({ error: 'vault keys are not loaded — the account owner must sign in once' });
  const _mig = KEY_MIG.get(account.id);
  if (_mig && _mig.phase !== 'done')
    return res.status(503).json({ error: 'the vault is re-encrypting — try again shortly' });
  if (!rateOk(row.id)) return res.status(429).json({ error: `rate limit exceeded (${API_RATE_MAX} requests/min per key)` });
  req.apiKey = row;
  try { req.apiScopes = JSON.parse(row.scopes); } catch (e) { req.apiScopes = []; }
  req.accountId = account.id;
  req.account = account;
  req.store = openStore(account.id);
  // record usage at most once a minute to avoid a DB write on every request
  const now = Date.now();
  if (now - (_apiKeyTouched.get(row.id) || 0) > 60_000) { _apiKeyTouched.set(row.id, now); try { sysStmt.touchApiKey.run(now, row.id); } catch (e) {} }
  next();
}
function requireScope(scope) {
  return (req, res, next) => {
    if (!req.apiScopes || !req.apiScopes.includes(scope))
      return res.status(403).json({ error: `this key lacks the "${scope}" permission` });
    next();
  };
}
/* file row -> public API shape (absolute, key-authed media urls) */
function publicFile(f, base) {
  const out = {
    id: f.id, name: f.name, type: f.type, parent: f.parent ?? null,
    size: f.size, date: f.date, trashed: !!f.trashed, starred: !!f.starred,
  };
  for (const k of ['lang', 'dur', 'w', 'h', 'artist', 'album']) if (f[k] != null) out[k] = f[k];
  if (f.url) out.url = base + '/api/v1/files/' + f.id + '/raw';
  if (f.coverUrl) out.cover_url = base + '/api/v1/files/' + f.id + '/cover';
  if (f.locked) out.locked = true;
  if (f.lockSpec) out.lockSpec = f.lockSpec;
  return out;
}

app.use('/api/v1', apiCors);   // CORS + preflight for the whole public surface

app.get('/api/v1', requireApiKey, (req, res) => {
  res.json({
    name: 'Simplex Custom API', version: 'v1',
    scopes: req.apiScopes,
    endpoints: [
      'GET    /api/v1/me',
      'GET    /api/v1/files            ?parent= &type= &search= &trashed=',
      'GET    /api/v1/files/:id',
      'GET    /api/v1/files/:id/raw    (supports Range — stream/play)',
      'GET    /api/v1/files/:id/cover',
      'POST   /api/v1/files            (multipart: file, parent?, type?)',
      'POST   /api/v1/folders          (json: name, parent?)',
      'DELETE /api/v1/files/:id        (moves to trash)',
    ],
  });
});

app.get('/api/v1/me', requireApiKey, (req, res) => {
  res.json({
    account: { id: req.account.id, username: req.account.username, display: req.account.display || req.account.username },
    scopes: req.apiScopes,
    quota_bytes: req.account.quota_bytes,
    used: req.store.usedBytes(),
  });
});

app.get('/api/v1/files', requireApiKey, requireScope('read'), (req, res) => {
  const q = req.query || {};
  let rows = req.store.st.all.all().map(r => rowToApi(r, req.store));
  const t = q.trashed;
  if (t === 'true' || t === '1') rows = rows.filter(f => f.trashed);
  else if (t === 'all') { /* no filter */ }
  else rows = rows.filter(f => !f.trashed);
  if (q.parent !== undefined) { const p = normParent(q.parent); rows = rows.filter(f => (f.parent ?? null) === p); }
  if (q.type) rows = rows.filter(f => f.type === q.type);
  if (q.search) { const s = String(q.search).toLowerCase(); rows = rows.filter(f => f.name.toLowerCase().includes(s)); }
  const base = originFor(req);
  res.json({ files: rows.map(f => publicFile(f, base)) });
});

app.get('/api/v1/files/:id', requireApiKey, requireScope('read'), (req, res) => {
  const row = req.store.getById(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(publicFile(rowToApi(row, req.store), originFor(req)));
});

/* cover art counts as lightweight metadata -> read scope; the real bytes need download */
app.get('/api/v1/files/:id/cover', requireApiKey, requireScope('read'), (req, res) =>
  streamEncrypted(req, res, req.store, req.store.getById(req.params.id), 'cover'));
app.get('/api/v1/files/:id/raw', requireApiKey, requireScope('download'), (req, res) =>
  streamEncrypted(req, res, req.store, req.store.getById(req.params.id), 'blob'));

app.post('/api/v1/files', requireApiKey, requireScope('upload'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file — send a multipart form field named "file"' });
  const store = req.store, quota = req.account.quota_bytes;
  if (store.usedBytes() + req.file.size > quota) { try { fs.unlinkSync(req.file.path); } catch (e) {} return limitError(res, store, quota); }
  const id = uid();
  try { await vault.encryptBlob(req.file.path, store.blobPath({ id }), store.keys); }
  catch (e) { try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(500).json({ error: 'encrypt failed' }); }
  try { await fsp.unlink(req.file.path); } catch (e) {}
  const b = req.body || {};
  const type = ['video', 'audio', 'image', 'document', 'folder'].includes(b.type) && b.type !== 'folder'
    ? b.type : typeForExt(req._uploadExt || '');
  store.insertRow({
    id, name: dedupeName(req.file.originalname, store, normParent(b.parent)), type,
    parent: normParent(b.parent), size: req.file.size, date: Date.now(),
    hasBlob: 1, storedExt: req._uploadExt || '',
  });
  store.bump();
  res.json(publicFile(rowToApi(store.getById(id), store), originFor(req)));
});

app.post('/api/v1/folders', requireApiKey, requireScope('upload'), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uid();
  req.store.insertRow({ id, name: dedupeName(name, req.store, normParent(b.parent)), type: 'folder', parent: normParent(b.parent), size: 0, date: Date.now() });
  req.store.bump();
  res.json(publicFile(rowToApi(req.store.getById(id), req.store), originFor(req)));
});

app.delete('/api/v1/files/:id', requireApiKey, requireScope('delete'), (req, res) => {
  const store = req.store;
  if (!store.getById(req.params.id)) return res.status(404).json({ error: 'not found' });
  const ids = cascade(store, req.params.id);   // folder -> trash its subtree too
  const stmt = store.db.prepare('UPDATE files SET trashed = 1 WHERE id = ?');
  store.db.transaction((a) => a.forEach(i => stmt.run(i)))(ids);
  store.bump();
  res.json({ ok: true, trashed: ids });
});

/* ============================================================
   NOTES APP (per-account; req.store set by the auth gate)
   ============================================================ */
/* Best-effort allowlist sanitizer for note bodies. Notes are private to the
   account, but pasted content could carry markup, so we strip executable bits
   before storing. Not a full HTML parser — drops dangerous elements, on*
   handlers, and javascript: URLs. */
function sanitizeNoteHtml(html) {
  let s = String(html || '');
  if (s.length > 200000) s = s.slice(0, 200000);
  s = s.replace(/<(script|style|iframe|object|embed|link|meta|base|form|svg)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<(script|style|iframe|object|embed|link|meta|base|form|svg)\b[^>]*\/?>/gi, '');
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');                 // strip event handlers
  s = s.replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2');    // neutralize javascript: urls
  return s;
}

app.get('/api/notes', (req, res) => res.json(req.store.notesList()));
app.get('/api/notes/:id', (req, res) => { const n = req.store.noteGet(req.params.id); if (!n) return res.status(404).json({ error: 'not found' }); res.json(n); });
app.post('/api/notes', (req, res) => {
  const b = req.body || {};
  const n = req.store.noteCreate({ title: String(b.title || '').slice(0, 200), body: sanitizeNoteHtml(b.body) });
  req.store.bump(); res.json(n);
});
app.patch('/api/notes/:id', (req, res) => {
  const b = req.body || {}, patch = {};
  if (b.title !== undefined) patch.title = String(b.title).slice(0, 200);
  if (b.body !== undefined) patch.body = sanitizeNoteHtml(b.body);
  const n = req.store.noteUpdate(req.params.id, patch);
  if (!n) return res.status(404).json({ error: 'not found' });
  req.store.bump(); res.json(n);
});
app.delete('/api/notes/:id', (req, res) => { const ok = req.store.noteDelete(req.params.id); req.store.bump(); res.json({ ok }); });

/* ============================================================
   NEURAL NETWORK APP — saved networks (CRUD) + optional backend compute.
   Every network lives in the account's encrypted DB (the `networks` table), so
   work is always saved server-side — autosaved as the user trains and on explicit
   save. `kind` is 'graph' (visual sandbox) or 'llm' (text-model template).
   The `data` document carries everything: graph nodes, the 2D world, trained
   weights, vocab, training text, hyper-params, etc. We cap it generously.
   ============================================================ */
const NET_MAX_BYTES = 24 * 1024 * 1024;   // 24 MB per saved network document (weights + training text)
// Network documents are far bigger than the 5 MB global JSON cap, so the save/compute
// routes get their own parser with a higher ceiling. Mounting it per-route keeps the
// larger limit off every other endpoint.
const netJson = express.json({ limit: '32mb' });
function netNameOf(v) { return String(v == null ? '' : v).slice(0, 120) || 'Untitled network'; }
function netDataSize(data) { try { return Buffer.byteLength(JSON.stringify(data ?? null)); } catch (e) { return Infinity; } }

app.get('/api/networks', (req, res) => res.json(req.store.netList()));
app.get('/api/networks/:id', (req, res) => { const n = req.store.netGet(req.params.id); if (!n) return res.status(404).json({ error: 'not found' }); res.json(n); });
app.post('/api/networks', netJson, (req, res) => {
  const b = req.body || {};
  if (b.data !== undefined && netDataSize(b.data) > NET_MAX_BYTES) return res.status(413).json({ error: 'network is too large to save' });
  const n = req.store.netCreate({ kind: b.kind, name: netNameOf(b.name), data: b.data ?? null });
  req.store.bump(); res.json(n);
});
app.patch('/api/networks/:id', netJson, (req, res) => {
  const b = req.body || {}, patch = {};
  if (b.name !== undefined) patch.name = netNameOf(b.name);
  if (b.data !== undefined) { if (netDataSize(b.data) > NET_MAX_BYTES) return res.status(413).json({ error: 'network is too large to save' }); patch.data = b.data; }
  const n = req.store.netUpdate(req.params.id, patch);
  if (!n) return res.status(404).json({ error: 'not found' });
  req.store.bump(); res.json(n);
});
app.delete('/api/networks/:id', (req, res) => { const ok = req.store.netDelete(req.params.id); req.store.bump(); res.json({ ok }); });

/* ============================================================
   SIMPLEX VISUAL — project documents (CRUD).
   ------------------------------------------------------------
   Mirrors the networks routes exactly: every project lives in the account's
   own encrypted DB (visual_projects table), so a project is only ever visible
   to its owner. The `data` document carries the whole project — inline textures
   (base64), actor classes, and the placed scene. Inline assets push the size up,
   so like the networks routes this gets its own higher-ceiling JSON parser.
   ============================================================ */
const VIS_MAX_BYTES = 48 * 1024 * 1024;   // 48 MB per project document (inline textures dominate)
const visJson = express.json({ limit: '64mb' });
function visNameOf(v) { return String(v == null ? '' : v).slice(0, 120) || 'Untitled project'; }

app.get('/api/visual/projects', (req, res) => res.json(req.store.visList()));
app.get('/api/visual/projects/:id', (req, res) => { const p = req.store.visGet(req.params.id); if (!p) return res.status(404).json({ error: 'not found' }); res.json(p); });
app.post('/api/visual/projects', visJson, (req, res) => {
  const b = req.body || {};
  if (b.data !== undefined && netDataSize(b.data) > VIS_MAX_BYTES) return res.status(413).json({ error: 'project is too large to save' });
  const p = req.store.visCreate({ name: visNameOf(b.name), data: b.data ?? null });
  req.store.bump(); res.json(p);
});
app.patch('/api/visual/projects/:id', visJson, (req, res) => {
  const b = req.body || {}, patch = {};
  if (b.name !== undefined) patch.name = visNameOf(b.name);
  if (b.data !== undefined) { if (netDataSize(b.data) > VIS_MAX_BYTES) return res.status(413).json({ error: 'project is too large to save' }); patch.data = b.data; }
  const p = req.store.visUpdate(req.params.id, patch);
  if (!p) return res.status(404).json({ error: 'not found' });
  req.store.bump(); res.json(p);
});
app.delete('/api/visual/projects/:id', (req, res) => { const ok = req.store.visDelete(req.params.id); req.store.bump(); res.json({ ok }); });

/* ---------- backend compute (gated by can_neural_backend) ----------
   Runs a chunk of training/evaluation on the SERVER so big jobs don't tie up the
   user's browser tab. The heavy math lives in neural-engine.js (shared shape with
   the client engine); here we just gate access, bound the work, and stay OFF the
   event loop for the actual number-crunching via setImmediate chunking inside the
   engine. Members need the admin-granted can_neural_backend flag; admins always
   have it. Client compute needs no permission and never hits this route. */
function neuralBackendAllowed(account) { return !!(account && (account.is_admin || account.can_neural_backend)); }
app.get('/api/neural/caps', (req, res) => res.json({ backend: neuralBackendAllowed(req.account) }));
app.post('/api/neural/compute', netJson, async (req, res) => {
  if (!neuralBackendAllowed(req.account)) return res.status(403).json({ error: 'backend compute is not enabled for your account' });
  const b = req.body || {};
  if (netDataSize(b) > NET_MAX_BYTES) return res.status(413).json({ error: 'request too large' });
  try {
    const out = await neuralCompute(b);   // see neural-engine.js
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: (e && e.message) || 'compute failed' });
  }
});

/* ============================================================
   AI ORGANIZATION — a per-user organizer model that learns one account's filing
   habits and suggests folders/tags for new files. Enabled by default; each user
   can turn it off (no training/suggestions while off) without losing their model.

   Isolation: the model lives ONLY in that account's encrypted store (organizer
   table). Training reads ONLY that account's files, and EXCLUDES locked /
   per-item-encrypted files entirely (orgTrainingExamples filters locked = 0), so
   their names/metadata are never analyzed. Nothing here crosses accounts.

   Efficiency: small classifier (one ~24-unit hidden layer, fixed 256-dim hashed
   features — see neural-engine.js). Training runs in the BACKGROUND, chunked off
   the event loop, and retrains only when enough new data has accrued. A whole
   model is tens of KB.
   ============================================================ */
const {
  organizerInit: orgInit, organizerTrain: orgTrain, organizerPredict: orgPredict,
  organizerInputDim: orgInputDim, fingerprintBytes,
  ORG_INPUT,
} = NeuralEngine;

/* Content-fingerprint sampling bounds. We read at most `sampleBytes` from the START
   of a file's plaintext (the most type-distinctive region — headers, opening text).
   The budget is set by the account's organizer TIER: Small reads 8 KB, Medium 256 KB
   (small files whole), High up to 256 MB (most average→¼-GB files whole). */
const ORG_FP_BUDGET_PER_PASS = 400;    // max files fingerprinted in one training pass (bounds I/O)

/* Read up to `sampleBytes` plaintext bytes for a file row: from inline `content`
   (notes/code/text docs) or by decrypting just the leading byte range of its blob.
   Returns a Buffer or null. Never touches locked files (caller already excludes). */
function sampleFileBytes(store, row, sampleBytes) {
  const cap = sampleBytes || ORG_TIERS.small.sample;
  return new Promise((resolve) => {
    try {
      // inline text document (stored decrypted-on-read in the content column)
      const inline = store.orgInlineContent(row);
      if (inline != null && inline !== '') { resolve(Buffer.from(inline.slice(0, cap), 'utf8')); return; }
      if (!row.hasBlob) { resolve(null); return; }
      const encPath = store.blobPath(row);
      if (!fs.existsSync(encPath)) { resolve(null); return; }
      // decrypt ONLY the leading `cap` bytes (range read — cheap even for a big file)
      const dec = vault.decryptBlobRange(encPath, store.keys, 0, cap - 1);
      if (!dec || !dec.stream) { resolve(null); return; }
      const chunks = []; let got = 0; let done = false;
      const finish = (buf) => { if (done) return; done = true; try { dec.stream.destroy(); } catch (e) {} resolve(buf); };
      dec.stream.on('data', (c) => { chunks.push(c); got += c.length; if (got >= cap) finish(Buffer.concat(chunks).subarray(0, cap)); });
      dec.stream.on('end', () => finish(chunks.length ? Buffer.concat(chunks) : null));
      dec.stream.on('error', () => finish(null));
    } catch (e) { resolve(null); }
  });
}

/* Compute + cache a content fingerprint for one file row (best-effort, async).
   Returns the fp (or null). Cached in files.fp so retrains reuse it. We also stash
   the number of CONTENT bytes we actually analyzed (`bytes`) on the fp, so the
   Settings "training data" stat can report the real volume of data the model
   learned from rather than a meaningless filename-length sum. */
async function fingerprintFileRow(store, row, sampleBytes) {
  try {
    const bytes = await sampleFileBytes(store, row, sampleBytes);
    const fp = bytes ? fingerprintBytes(bytes) : null;
    if (fp) fp.bytes = bytes.length;
    store.orgSetFp(row.id, fp || { kind: 'none', bytes: 0 });   // cache even 'none' so we don't re-sample every pass
    return fp;
  } catch (e) { return null; }
}

/* ---------- Organizer TIERS ----------
   The user picks a tier (up to the admin-granted ceiling, org_max_tier). Each tier
   trades CPU/I-O for accuracy: a wider input + deeper network, and a larger slice of
   each file's bytes read into the content fingerprint.
     • small  — the default: 1024 input, 3 hidden layers, 8 KB sampled per file.
     • medium — 2048 input, 6 hidden layers, 256 KB sampled (reads small files whole).
     • high   — 4096 input, 9 hidden layers, 256 MB sampled (reads most average→¼-GB
                files entirely). Heaviest; admin-granted.
   `input`/`hidden` define the network shape; `sample` is the per-file byte budget. */
const ORG_TIERS = {
  small:  { label: 'Small',  input: 1024, hidden: [48, 48, 48],                       sample: 8 * 1024 },
  medium: { label: 'Medium', input: 2048, hidden: [64, 64, 64, 64, 64, 64],           sample: 256 * 1024 },
  high:   { label: 'High',   input: 4096, hidden: [96, 96, 96, 96, 96, 96, 96, 96, 96], sample: 256 * 1024 * 1024 },
};
const ORG_TIER_ORDER = ['small', 'medium', 'high'];
const ORG_TIER_DEFAULT = 'small';                 // what a new user gets until they change it
function orgTierRank(t) { const i = ORG_TIER_ORDER.indexOf(t); return i < 0 ? 0 : i; }
function orgTierSpec(t) { return ORG_TIERS[t] || ORG_TIERS.small; }
/* the highest tier an account is ALLOWED to use (admin-granted ceiling; admins get
   'high' regardless). Members default to 'medium'. */
function orgMaxTier(account) {
  if (!account) return ORG_TIER_DEFAULT;
  if (account.is_admin) return 'high';
  const t = account.org_max_tier;
  return ORG_TIERS[t] ? t : 'medium';
}
/* the tier this account is actually USING right now: their chosen tier from prefs,
   clamped to their allowed ceiling. Defaults to small. */
function orgTier(account) {
  if (!account) return ORG_TIER_DEFAULT;
  let prefs = null; if (account.prefs) { try { prefs = JSON.parse(account.prefs); } catch (e) {} }
  let chosen = prefs && prefs.aiOrg && prefs.aiOrg.tier;
  if (!ORG_TIERS[chosen]) chosen = ORG_TIER_DEFAULT;
  const max = orgMaxTier(account);
  return orgTierRank(chosen) > orgTierRank(max) ? max : chosen;   // never exceed the ceiling
}

const ORG_MIN_EXAMPLES = 4;                  // need at least this many labeled files to train
const ORG_RETRAIN_EVERY = 12;               // retrain after this many new/changed files since last train
const ORG_MAX_EXAMPLES = 4000;               // cap a single training pass (bounds CPU/event-loop time)
const ORG_EPOCHS_INITIAL = 30;               // minimum epochs before early-stop may trigger
const ORG_EPOCHS_MAX = 300;                  // hard cap (trains to convergence up to this)
const ORG_BATCH = 32;                        // engine mini-batch size (one Adam step per batch)
const ORG_SUGGEST_TTL_MS = 60 * 60 * 1000;   // suggestions auto-hide after 1 hour (still stored)
const ORG_THRESHOLD_DEFAULT = 0.6;           // default confidence floor: only surface predictions ≥ 60%

/* per-account enable flag lives in the account's prefs JSON. Default ON — this is
   a new platform feature enabled by default; users opt OUT. */
function orgEnabled(account) {
  if (!account) return false;
  let prefs = null; if (account.prefs) { try { prefs = JSON.parse(account.prefs); } catch (e) {} }
  const v = prefs && prefs.aiOrg && prefs.aiOrg.enabled;
  return v === undefined || v === null ? true : !!v;   // default on
}
/* per-account confidence threshold (0–1). A SINGLE, reused floor that gates EVERY
   prediction the user sees — no folder or tag is ever surfaced below it, and
   "Apply all" uses the same value. Configurable in Settings; default 60%. */
function orgThreshold(account) {
  if (!account) return ORG_THRESHOLD_DEFAULT;
  let prefs = null; if (account.prefs) { try { prefs = JSON.parse(account.prefs); } catch (e) {} }
  const v = prefs && prefs.aiOrg && prefs.aiOrg.threshold;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0.05 && n <= 0.99 ? n : ORG_THRESHOLD_DEFAULT;
}
function setOrgPrefs(accountId, patch) {
  const a = sysStmt.getAcct.get(accountId); if (!a) return;
  let prefs = {}; if (a.prefs) { try { prefs = JSON.parse(a.prefs) || {}; } catch (e) {} }
  prefs.aiOrg = { ...(prefs.aiOrg || {}), ...patch };
  sys.prepare('UPDATE accounts SET prefs = ? WHERE id = ?').run(JSON.stringify(prefs), accountId);
  bumpAccounts();
}
function setOrgEnabled(accountId, on) { setOrgPrefs(accountId, { enabled: !!on }); }
function setOrgThreshold(accountId, t) {
  const n = Number(t);
  if (Number.isFinite(n) && n >= 0.05 && n <= 0.99) setOrgPrefs(accountId, { threshold: n });
}
/* Set the account's chosen organizer tier (clamped to its admin-granted ceiling).
   Returns true if the tier actually CHANGED (so the caller can rebuild the model +
   re-fingerprint at the new byte budget). */
function setOrgTier(accountId, tier) {
  const account = sysStmt.getAcct.get(accountId); if (!account) return false;
  if (!ORG_TIERS[tier]) return false;
  const max = orgMaxTier(account);
  const next = orgTierRank(tier) > orgTierRank(max) ? max : tier;   // never exceed ceiling
  if (next === orgTier(account)) return false;
  setOrgPrefs(accountId, { tier: next });
  return true;
}

/* A fresh, empty model document wrapping the engine model + bookkeeping. We persist
   the Adam optimizer moments alongside the weights so incremental retrains keep
   their momentum (the engine recreates them if missing). */
function newOrgDoc(folders, tags, tier) {
  const spec = orgTierSpec(tier || ORG_TIER_DEFAULT);
  return {
    model: orgInit({ folders, tags, input: spec.input, hidden: spec.hidden, seed: 11 }),
    opt: null,                 // Adam state (mom/vel/t) — JSON-friendly arrays, lazily filled
    meta: {
      lastTrained: null, accuracy: null, tier: tier || ORG_TIER_DEFAULT,
      datasetBytes: 0, fileCount: 0,
      trainRuns: 0, sinceTrain: 0,   // files added/changed since the last training pass
      createdAt: Date.now(),
    },
  };
}
// Adam moment buffers are typed arrays in the engine but must survive JSON. We
// carry them as plain arrays in the doc and convert at the boundary.
function reviveOpt(opt) {
  if (!opt) return {};
  const out = { t: opt.t || 0, mom: {}, vel: {} };
  if (opt.mom) for (const k in opt.mom) out.mom[k] = Float64Array.from(opt.mom[k]);
  if (opt.vel) for (const k in opt.vel) out.vel[k] = Float64Array.from(opt.vel[k]);
  if (!Object.keys(out.mom).length) { out.mom = undefined; out.vel = undefined; }
  return out;
}
function freezeOpt(opt) {
  if (!opt) return null;
  const out = { t: opt.t || 0, mom: {}, vel: {} };
  if (opt.mom) for (const k in opt.mom) out.mom[k] = Array.from(opt.mom[k]);
  if (opt.vel) for (const k in opt.vel) out.vel[k] = Array.from(opt.vel[k]);
  return out;
}

/* Yield to the event loop. Training is pure CPU; we chunk it across epochs and
   await this between chunks so one account's training pass can't block requests. */
const nextTick = () => new Promise(r => setImmediate(r));

/* Total volume of training data the model actually learned from: for each example,
   the bytes of file CONTENT we sampled + fingerprinted (fp.bytes, up to ORG_FP_SAMPLE
   per file) plus its filename. This is the honest number — the model never ingests
   whole multi-GB media files, it learns from a sampled fingerprint of each — so this
   reflects real analyzed data, not the raw vault size. */
function orgDatasetBytes(examples) {
  let n = 0;
  for (const e of examples) {
    n += Buffer.byteLength(e.x.name || '');
    const fp = e.x.fp;
    if (fp && Number.isFinite(fp.bytes)) n += fp.bytes;
  }
  return n;
}

/* Accuracy: does the model's top folder match the true folder? We report TOP-2
   accuracy (is the right folder in the model's top 2 guesses?), because users with
   media libraries often have several plausible homes for a file and a single-folder
   match under-credits a genuinely useful model. Computed over the labeled set; only
   folders the model actually knows and that have ≥2 examples are scored (a folder
   with a single file can't be learned and would just be noise in the metric).
   Returns null if too few multi-folder examples to be meaningful. */
function evalOrgAccuracy(model, examples) {
  // count examples per folder so we can ignore singleton folders (unlearnable)
  const perFolder = new Map();
  for (const e of examples) if (e.folder != null && model.folders.includes(e.folder)) perFolder.set(e.folder, (perFolder.get(e.folder) || 0) + 1);
  const scorable = examples.filter(e => e.folder != null && (perFolder.get(e.folder) || 0) >= 2);
  if (scorable.length < 5) return null;
  const distinctFolders = new Set(scorable.map(e => e.folder));
  if (distinctFolders.size < 2) return null;   // only one folder -> "accuracy" is trivially 100%
  let correct = 0, n = 0;
  for (const e of scorable) {
    const p = orgPredict(model, e.x, { topFolders: 2, topTags: 1 });
    if (p.folders.some(f => f.id === e.folder)) correct++;
    n++;
  }
  return n ? correct / n : null;
}

const _orgTraining = new Set();   // accountIds with a training pass in flight (one at a time per account)

/* Run a full (or incremental) training pass for one account, in the background.
   Builds examples from the live vault, syncs the label space, trains a bounded
   number of epochs off the event loop, evaluates, and persists. Safe to call
   redundantly — it no-ops if disabled or already running. */
async function trainOrganizer(accountId, { reason } = {}) {
  if (_orgTraining.has(accountId)) return;
  const account = sysStmt.getAcct.get(accountId);
  if (!account || !orgEnabled(account)) return;
  _orgTraining.add(accountId);
  try {
    const store = openStore(accountId);
    const tier = orgTier(account);                 // the account's selected (clamped) tier
    const tierSpec = orgTierSpec(tier);
    // First, compute content fingerprints for a bounded batch of files that don't
    // have one cached yet. We sample up to the TIER'S byte budget of each file's
    // actual bytes so the model can learn from CONTENT, not just names — done before
    // building examples so the fresh fingerprints are included. Bounded + yields
    // between files to stay off the event loop; the rest are done on later passes.
    const needFp = store.orgRowsNeedingFp().slice(0, ORG_FP_BUDGET_PER_PASS);
    for (const r of needFp) { await fingerprintFileRow(store, r, tierSpec.sample); await nextTick(); }
    const examples = store.orgTrainingExamples();
    if (examples.length < ORG_MIN_EXAMPLES) {
      // not enough to learn from yet — record the universe size so Settings can show it
      const doc = store.orgModelGet() || newOrgDoc([], [], tier);
      doc.meta.fileCount = examples.length;
      doc.meta.datasetBytes = orgDatasetBytes(examples);
      doc.meta.tier = tier;
      doc.meta.sinceTrain = 0;
      store.orgModelSet(doc);
      return;
    }
    const sample = examples.length > ORG_MAX_EXAMPLES ? examples.slice(-ORG_MAX_EXAMPLES) : examples;
    // label universe = every folder a file currently lives in + every tag in use
    const folderSet = [...new Set(sample.map(e => e.folder).filter(Boolean))];
    const tagSet = [...new Set(sample.flatMap(e => e.tags || []))];

    // ALWAYS rebuild from scratch and train to convergence. We deliberately do NOT
    // warm-start from the existing weights: warm-starting an already-converged model
    // on a few new/imbalanced examples (the old "incremental retrain") repeatedly
    // nudged it until it collapsed to predicting the majority folder for EVERY file —
    // the exact "same result for everything" bug. A fresh build relearns from the
    // user's own files (which ARE the training data, so nothing is lost) and reliably
    // converges. It's affordable: ~4s for 150 files, well under a minute for thousands,
    // and runs in the background sliced off the event loop.
    const prevMeta = (store.orgModelGet() || {}).meta || {};
    const doc = newOrgDoc(folderSet, tagSet, tier);
    doc.meta.trainRuns = prevMeta.trainRuns || 0;     // carry the run counter across rebuilds
    doc.meta.createdAt = prevMeta.createdAt || doc.meta.createdAt;
    const opt = reviveOpt(doc.opt);
    // One epoch = the whole sample, run in slices with a yield to the event loop
    // between slices so even a big vault never holds the single Node thread for more
    // than one small slice. The engine does per-batch Adam inside each slice; Adam
    // state in `opt` persists across slices + epochs, so this equals normal training.
    const SLICE = 256;   // examples per synchronous chunk (keeps each hold short)
    let _shuf = (s) => { let a = s >>> 0 || 1; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
    const runEpoch = async (seed) => {
      // shuffle the WHOLE sample first so slices are class-mixed (a chunk that's all
      // one folder would bias the per-batch Adam steps on an imbalanced vault).
      const rng = _shuf(seed);
      const order = sample.slice();
      for (let i = order.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const tmp = order[i]; order[i] = order[j]; order[j] = tmp; }
      let sum = 0, count = 0;
      for (let off = 0; off < order.length; off += SLICE) {
        const chunk = order.slice(off, off + SLICE);
        opt.epochs = 1; opt.seed = seed + off; opt.batch = ORG_BATCH;
        const r = orgTrain(doc.model, chunk, opt);
        sum += r.loss * chunk.length; count += chunk.length;
        await nextTick();
      }
      return count ? sum / count : 0;
    };
    // ALWAYS train to CONVERGENCE — fresh builds AND incremental retrains alike.
    // (The old design ran only a fixed handful of epochs on the incremental path; on
    // an imbalanced, media-heavy vault those short under-trained passes drifted the
    // model into predicting the MAJORITY folder for EVERYTHING — the "same result for
    // every file" collapse. Converging every time avoids it, and it's affordable now:
    // the engine batches + uses sparse first-layer math, so a full epoch is fast.)
    // Early stop on RELATIVE loss improvement (an absolute floor plateaus too soon
    // once the easy folders dominate the loss).
    let loss = 0, best = Infinity, stale = 0;
    const patience = 12;
    for (let ep = 0; ep < ORG_EPOCHS_MAX; ep++) {
      loss = await runEpoch((doc.model.seed || 11) + ep * 7919);
      if (loss < best * 0.995) { best = Math.min(best, loss); stale = 0; }
      else { best = Math.min(best, loss); if (++stale >= patience && ep >= ORG_EPOCHS_INITIAL) break; }
    }
    doc.opt = freezeOpt(opt);
    doc.meta.lastTrained = Date.now();
    doc.meta.accuracy = evalOrgAccuracy(doc.model, sample);
    doc.meta.fileCount = examples.length;
    doc.meta.datasetBytes = orgDatasetBytes(examples);
    doc.meta.trainRuns = (doc.meta.trainRuns || 0) + 1;
    doc.meta.sinceTrain = 0;
    doc.meta.lastLoss = loss;
    doc.meta.tier = tier;
    store.orgModelSet(doc);
  } catch (e) {
    console.warn('[simplex] organizer training failed for', accountId, e && e.message);
  } finally {
    _orgTraining.delete(accountId);
  }
}

/* Bump the "files changed since last train" counter and kick off a retrain in the
   background once enough has accrued. Called after uploads / tag / move edits.
   Cheap + non-blocking: just a counter write + a fire-and-forget train. */
function noteOrgChange(accountId, store, n = 1) {
  const account = sysStmt.getAcct.get(accountId);
  if (!account || !orgEnabled(account)) return;
  let doc = store.orgModelGet();
  if (!doc) { doc = newOrgDoc([], [], orgTier(account)); }
  doc.meta = doc.meta || {};
  doc.meta.sinceTrain = (doc.meta.sinceTrain || 0) + n;
  const due = doc.meta.sinceTrain >= ORG_RETRAIN_EVERY || !doc.meta.lastTrained;
  store.orgModelSet(doc);
  if (due) setImmediate(() => trainOrganizer(accountId, { reason: 'incremental' }).catch(() => {}));
}

/* Resolve a folder id to a readable "A / B / C" path using the folder dictionary. */
function orgFolderPath(folders, id) {
  if (id == null) return '(top level)';
  const byId = new Map(folders.map(f => [f.id, f]));
  const parts = []; let cur = byId.get(id), guard = 0;
  while (cur && guard++ < 64) { parts.unshift(cur.name || '…'); cur = cur.parent != null ? byId.get(cur.parent) : null; }
  return parts.length ? parts.join(' / ') : '(folder)';
}

/* Does a saved model match the architecture for the given TIER (input width + hidden
   stack)? A model whose shape doesn't match the account's selected tier must be
   rebuilt — predicting on a wrong-sized model reads weights out of range and returns
   constant garbage. The single source of truth for "needs a rebuild". */
function orgModelMatchesShape(model, tier) {
  const spec = orgTierSpec(tier || ORG_TIER_DEFAULT);
  return !!model && model.type === 'organizer'
    && Array.isArray(model.hidden) && model.hidden.join(',') === spec.hidden.join(',')
    && orgInputDim(model) === spec.input;
}
/* Kick a background rebuild for an account if one isn't already running. Used when a
   stale-shape model is encountered at prediction time, so it self-heals. */
function kickOrgRebuild(accountId) {
  if (_orgTraining.has(accountId)) return;
  setImmediate(() => trainOrganizer(accountId, { reason: 'shape-rebuild' }).catch(() => {}));
}

/* Build a fresh suggestion object for ONE file from the current model, mapping ids
   to readable names/paths and applying the user's confidence threshold to BOTH
   folders and tags (the single configurable floor). Returns null if the model
   can't suggest anything above the threshold (untrained / empty / file excluded). */
function buildSuggestionFor(store, fileId, threshold, tier) {
  const min = (threshold == null) ? ORG_THRESHOLD_DEFAULT : threshold;
  const doc = store.orgModelGet();
  if (!doc || !doc.model || doc.model.type !== 'organizer') return null;
  // STALE-SHAPE GUARD: never predict on a model whose input width / layer shape no
  // longer matches the account's SELECTED TIER — doing so reads weights out of range
  // and returns constant garbage (every file scored the same, all routed to one
  // folder). Instead, return no suggestion and trigger a background rebuild at the
  // current tier; suggestions resume once it finishes.
  if (!orgModelMatchesShape(doc.model, tier)) { kickOrgRebuild(store.id); return null; }
  const x = store.orgFileFeatures(fileId);
  if (!x) return null;   // folder / locked / missing -> nothing to suggest
  const pred = orgPredict(doc.model, x, { topFolders: 3, topTags: 8 });
  const folders = store.orgFolders();
  const cur = store.getById(fileId);
  const curParent = cur ? (cur.parent ?? null) : null;
  let curTags = []; if (cur && cur.tags) { try { curTags = JSON.parse(cur.tags) || []; } catch (e) {} }
  const tagDict = new Map(store.tagsList().map(t => [t.id, t]));
  const folderOut = pred.folders
    .filter(f => f.score >= min && f.id !== curParent)   // ≥ threshold + skip where it already is
    .map(f => ({ id: f.id, path: orgFolderPath(folders, f.id), confidence: Math.round(f.score * 100) / 100 }));
  const tagOut = pred.tags
    .filter(t => t.score >= min && tagDict.has(t.id) && !curTags.includes(t.id))   // ≥ threshold, known, not already on the file
    .map(t => { const d = tagDict.get(t.id); return { id: t.id, name: d.name, color: d.color || null, confidence: Math.round(t.score * 100) / 100 }; });
  if (!folderOut.length && !tagOut.length) return null;
  return { folders: folderOut, tags: tagOut };
}

/* Generate + store a suggestion for a just-uploaded file (background, best-effort). */
async function suggestForUpload(accountId, store, fileId) {
  try {
    const account = sysStmt.getAcct.get(accountId);
    if (!account || !orgEnabled(account)) return;
    // fingerprint the new file's content first (at the account's tier budget) so its
    // very first suggestion already benefits from content signal, not just its name.
    const tier = orgTier(account);
    const row = store.getById(fileId);
    if (row && !row.locked && row.type !== 'folder' && !row.fp) await fingerprintFileRow(store, row, orgTierSpec(tier).sample);
    const sug = buildSuggestionFor(store, fileId, orgThreshold(account), tier);
    if (sug) { store.suggestionSet(fileId, sug); store.bump(); }
  } catch (e) { /* suggestions are advisory; never let this break an upload */ }
}

/* ---------- AI Organization API ---------- */
function orgStatus(account, store) {
  const doc = store.orgModelGet();
  const meta = (doc && doc.meta) || {};
  const universe = store.orgTrainingExamples().length;   // current eligible (unlocked) file count
  const tier = orgTier(account), maxTier = orgMaxTier(account);
  // which tiers this account may pick (everything up to its ceiling), with labels
  const available = ORG_TIER_ORDER.filter(t => orgTierRank(t) <= orgTierRank(maxTier))
    .map(t => ({ id: t, label: ORG_TIERS[t].label }));
  return {
    enabled: orgEnabled(account),
    threshold: orgThreshold(account),     // the single confidence floor (0–1) gating all predictions
    tier, maxTier, availableTiers: available,
    trained: !!(doc && doc.model && meta.lastTrained),
    accuracy: meta.accuracy == null ? null : meta.accuracy,
    datasetBytes: meta.datasetBytes || 0,
    fileCount: meta.fileCount || 0,
    eligibleFiles: universe,
    lastTrained: meta.lastTrained || null,
    trainRuns: meta.trainRuns || 0,
    training: _orgTraining.has(account.id),
  };
}

app.get('/api/organizer/status', (req, res) => {
  res.json(orgStatus(req.account, req.store));
});

/* enable / disable. Turning ON triggers an initial training pass if the model has
   never been trained (so it's useful out of the box). Turning OFF preserves the
   model + suggestions but stops all new training/suggestions. */
app.patch('/api/organizer/settings', (req, res) => {
  const b = req.body || {};
  if (b.enabled !== undefined) {
    setOrgEnabled(req.accountId, !!b.enabled);
    if (b.enabled) {
      const doc = req.store.orgModelGet();
      if (!doc || !doc.meta || !doc.meta.lastTrained) setImmediate(() => trainOrganizer(req.accountId, { reason: 'enable' }).catch(() => {}));
    }
  }
  // confidence threshold (0.05–0.99): the single floor for every prediction the
  // user sees. Changing it re-filters stored suggestions on the next read.
  if (b.threshold !== undefined) setOrgThreshold(req.accountId, b.threshold);
  // organizer TIER (small|medium|high, clamped to the admin-granted ceiling). A real
  // change means a different network shape AND a different per-file byte budget, so we
  // wipe the model + cached fingerprints and rebuild from scratch at the new tier.
  if (b.tier !== undefined && setOrgTier(req.accountId, b.tier)) {
    req.store.orgModelDelete();
    req.store.orgClearFingerprints();
    req.store.bump();
    if (orgEnabled(sysStmt.getAcct.get(req.accountId))) setImmediate(() => trainOrganizer(req.accountId, { reason: 'tier-change' }).catch(() => {}));
  }
  req.account = sysStmt.getAcct.get(req.accountId);   // refresh for the status echo
  res.json(orgStatus(req.account, req.store));
});

/* manually trigger a (re)training pass. Returns immediately; training runs in the
   background. The client polls /status (training flag + lastTrained) for progress. */
app.post('/api/organizer/train', (req, res) => {
  if (!orgEnabled(req.account)) return res.status(400).json({ error: 'AI organization is turned off' });
  if (_orgTraining.has(req.accountId)) return res.json({ ok: true, training: true, already: true });
  setImmediate(() => trainOrganizer(req.accountId, { reason: 'manual' }).catch(() => {}));
  res.json({ ok: true, training: true });
});

/* reset/delete the model + all stored suggestions (training data is the user's
   own files, which are untouched — only the learned model + suggestions are wiped). */
app.delete('/api/organizer/model', (req, res) => {
  req.store.orgModelDelete();
  req.store.bump();
  res.json({ ok: true });
});

/* the live suggestion for one file (used by the "AI Store…" modal and the upload
   chips). `fresh=1` recomputes from the current model instead of returning the
   stored snapshot — handy after the model has retrained. `active` reflects the
   1-hour visibility window; the payload is returned regardless so "AI Store…"
   can show hidden suggestions. */
app.get('/api/organizer/suggestions/:id', (req, res) => {
  const store = req.store;
  const min = orgThreshold(req.account);
  let sug = store.suggestionGet(req.params.id);
  if ((req.query.fresh === '1' || !sug) && orgEnabled(req.account)) {
    const built = buildSuggestionFor(store, req.params.id, min, orgTier(req.account));
    if (built) { store.suggestionSet(req.params.id, built); sug = store.suggestionGet(req.params.id); }
  }
  if (!sug) return res.json({ fileId: req.params.id, folders: [], tags: [], active: false, created: null, threshold: min });
  // re-filter a stored snapshot against the CURRENT threshold (the user may have
  // raised it since it was stored), so nothing below the floor is ever shown.
  const folders = (sug.folders || []).filter(f => (f.confidence || 0) >= min);
  const tags = (sug.tags || []).filter(t => (t.confidence || 0) >= min);
  const active = (Date.now() - (sug.created || 0)) < ORG_SUGGEST_TTL_MS;
  res.json({ ...sug, folders, tags, active, threshold: min });
});

/* Apply / accept a suggestion (reinforcement) or dismiss it (negative feedback).
   Body: { acceptFolder?: <folderId>, acceptTags?: [tagId...],
           rejectFolder?: <folderId>, rejectTags?: [tagId...],
           applyAll?: true, dismiss?: true }
   Accepting a folder MOVES the file; accepting tags ADDS them. Both also write a
   reinforcement training example. Rejections write negative examples. Everything
   is a normal training example fed to the same machinery (organizerTrain).

   applyAll: server-side "do everything I'd accept" — add EVERY suggested tag at or
   above the user's confidence threshold, and move to the single HIGHEST-confidence
   folder (only if it clears the threshold). We recompute a fresh, authoritative
   prediction here rather than trusting client-sent ids. */
app.post('/api/organizer/suggestions/:id/feedback', (req, res) => {
  const store = req.store, fileId = req.params.id, b = req.body || {};
  const row = store.getById(fileId);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!orgEnabled(req.account)) return res.status(400).json({ error: 'AI organization is turned off' });
  const x = store.orgFileFeatures(fileId);
  const min = orgThreshold(req.account);

  // Resolve applyAll into concrete accept lists from a fresh prediction.
  let acceptFolder = b.acceptFolder, acceptTags = Array.isArray(b.acceptTags) ? b.acceptTags.slice() : [];
  if (b.applyAll) {
    const fresh = buildSuggestionFor(store, fileId, min, orgTier(req.account));   // already threshold-filtered + sorted by score
    if (fresh) {
      if (fresh.folders[0]) acceptFolder = fresh.folders[0].id;   // highest-confidence folder ≥ threshold
      acceptTags = [...new Set([...acceptTags, ...fresh.tags.map(t => t.id)])];   // every tag ≥ threshold
    }
  }

  let moved = false;
  // accept folder -> move the file there (validated folder, no cycle since it's a file)
  if (acceptFolder) {
    const dest = store.getById(acceptFolder);
    if (dest && dest.type === 'folder' && !dest.trashed) {
      store.db.prepare('UPDATE files SET parent = ? WHERE id = ?').run(acceptFolder, fileId);
      moved = true;
    }
  }
  // accept tags -> add to the file's tag set (union, validated by setFileTags)
  let acceptedTags = [];
  if (acceptTags.length) {
    let cur = []; const fr = store.getById(fileId); if (fr && fr.tags) { try { cur = JSON.parse(fr.tags) || []; } catch (e) {} }
    const next = [...new Set([...cur, ...acceptTags])];
    store.setFileTags(fileId, next);
    acceptedTags = acceptTags;
  }

  // ---- feedback as a training example (reinforcement + negatives) ----
  if (x) {
    const example = { x, weight: 2 };   // human feedback counts double
    if (acceptFolder) example.folder = acceptFolder;
    const posTags = new Set(acceptedTags);
    const negTags = new Set(Array.isArray(b.rejectTags) ? b.rejectTags : []);
    if (posTags.size) example.tags = [...posTags];
    if (negTags.size) example.negTags = [...negTags];
    // The accept (move/tag) already updated the file's folder/tags, so the feedback
    // is now part of the training data. Rather than warm-start the weights on a single
    // example (which, repeated, can drift the model toward collapse — see why we always
    // rebuild fresh), we just mark the model dirty and let the next full retrain learn
    // it cleanly. A rejected tag is recorded the same way (the file simply doesn't
    // carry it, so the rebuild sees it as a negative).
    if (example.folder || example.tags || example.negTags) {
      try { noteOrgChange(req.accountId, store, ORG_RETRAIN_EVERY); } catch (e) {}   // weight ≥ threshold so it retrains promptly
    }
  }

  // dismiss / applyAll / moved -> drop the stored suggestion; else refresh remaining
  if (b.dismiss || b.applyAll || moved) { store.suggestionDelete(fileId); }
  else { const built = buildSuggestionFor(store, fileId, min, orgTier(req.account)); if (built) store.suggestionSet(fileId, built); else store.suggestionDelete(fileId); }

  store.bump(); invalidatePollCache(req.accountId);
  res.json({ ok: true, moved, appliedTags: acceptedTags.length, file: rowToApi(store.getById(fileId), store) });
});

/* Periodic retrain sweep: once an hour, retrain any enabled account that has
   accrued changes since its last pass (or has never trained but now has enough
   files). Bounded — one account trained per tick is fine; uploads also kick
   incremental retrains directly. Mirrors the schedule-engine pattern. */
function organizerSweep() {
  try {
    for (const acct of sysStmt.listAccts.all()) {
      if (!orgEnabled(acct)) continue;
      let store; try { store = openStore(acct.id); } catch (e) { continue; }
      const doc = store.orgModelGet();
      const meta = (doc && doc.meta) || {};
      const eligible = store.orgTrainingExamples().length;
      const neverTrained = !meta.lastTrained && eligible >= ORG_MIN_EXAMPLES;
      const due = (meta.sinceTrain || 0) >= ORG_RETRAIN_EVERY;
      // a model whose shape no longer matches the account's selected TIER must be
      // rebuilt — otherwise it predicts constant garbage. Catch it on the sweep so it
      // self-heals even if the user never interacts.
      const staleShape = doc && doc.model && !orgModelMatchesShape(doc.model, orgTier(acct));
      if (neverTrained || due || staleShape) setImmediate(() => trainOrganizer(acct.id, { reason: 'sweep' }).catch(() => {}));
    }
  } catch (e) { console.warn('[simplex] organizer sweep', e && e.message); }
}
setInterval(() => runTracked('organizerSweep', organizerSweep), 60 * 60 * 1000).unref();

/* ============================================================
   CODE APP — workspace files + sandboxed execution
   SECURITY: running user code is RCE-by-design. This is best-effort isolation,
   NOT a hard boundary (no Docker on the box). Layers: per-account permission
   gate (can_code), throwaway run dir, wall-clock timeout, output cap, run
   concurrency caps, minimal env, and kill-on-disconnect/Stop. It does NOT
   sandbox the network — only enable for trusted accounts.
   ============================================================ */
const CODE_MAX_BYTES = 5 * 1e6;     // ~5 MB of source per account
const CODE_MAX_FILES = 500;
const RUN_TIMEOUT_MS = 10_000;      // wall-clock kill
const RUN_MAX_OUTPUT = 256 * 1024;  // bytes of combined stdout+stderr
const RUN_MAX_GLOBAL = 6, RUN_MAX_PER_ACCT = 2;

const RUNNERS = {
  python: { label: 'Python', cmd: process.platform === 'win32' ? 'python' : 'python3', args: (f) => [f], exts: ['py'] },
  node:   { label: 'JavaScript', cmd: process.execPath, args: (f) => ['--max-old-space-size=128', f], exts: ['js', 'mjs', 'cjs'] },
};
function langForCodeFile(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (RUNNERS.python.exts.includes(ext)) return 'python';
  if (RUNNERS.node.exts.includes(ext)) return 'node';
  return null;
}
function validCodeName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 100
    && !/[\\/]/.test(name) && name !== '.' && name !== '..' && !/[\x00-\x1f]/.test(name);
}

const runs = new Map();   // runId -> { child, accountId, dir, killedFor }
function activeRunsFor(accountId) { let n = 0; for (const r of runs.values()) if (r.accountId === accountId) n++; return n; }
function killTree(child) {
  if (!child || child.killed || !child.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) {} } }
  } catch (e) {}
}
function cleanupRun(runId) {
  const r = runs.get(runId); if (!r) return;
  runs.delete(runId);
  try { fs.rmSync(r.dir, { recursive: true, force: true }); } catch (e) {}
}
/* write the whole workspace into a throwaway dir so imports between files work;
   returns the entry file's path relative to that dir. Async (fsp) so writing many
   files — which the local AV scans on every write — never blocks the event loop. */
async function materializeWorkspace(store, dir, entryId) {
  const rows = store.codeList();
  const byId = new Map(rows.map(r => [r.id, r]));
  const relOf = (r) => {
    const parts = []; let cur = r, guard = 0;
    while (cur && guard++ < 100) { if (!validCodeName(cur.name)) throw new Error('invalid file name'); parts.unshift(cur.name); cur = cur.parent ? byId.get(cur.parent) : null; }
    return parts.join(path.sep);
  };
  await fsp.mkdir(dir, { recursive: true });
  let entryRel = null;
  for (const r of rows) {
    const rel = relOf(r);
    const abs = path.join(dir, rel);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new Error('path escape');   // defense in depth
    if (r.is_dir) await fsp.mkdir(abs, { recursive: true });
    else { await fsp.mkdir(path.dirname(abs), { recursive: true }); await fsp.writeFile(abs, r.content || ''); }
    if (r.id === entryId) entryRel = rel;
  }
  if (!entryRel) throw new Error('entry file missing');
  return entryRel;
}

app.get('/api/code/files', (req, res) => res.json(req.store.codeList()));
app.post('/api/code/files', (req, res) => {
  const b = req.body || {}, store = req.store;
  const name = String(b.name || '').trim();
  if (!validCodeName(name)) return res.status(400).json({ error: 'invalid name (no slashes, ≤100 chars)' });
  const parent = b.parent ? String(b.parent) : null;
  if (parent) { const p = store.codeGet(parent); if (!p || !p.is_dir) return res.status(400).json({ error: 'parent folder not found' }); }
  const stats = store.codeStats();
  if (stats.c >= CODE_MAX_FILES) return res.status(413).json({ error: 'workspace file limit reached' });
  if ((stats.n || 0) + (b.content ? String(b.content).length : 0) > CODE_MAX_BYTES) return res.status(413).json({ error: 'workspace size limit reached' });
  const node = store.codeCreate({ name, parent, is_dir: !!b.is_dir, content: b.is_dir ? null : String(b.content || ''), lang: b.is_dir ? null : langForCodeFile(name) });
  store.bump(); res.json(node);
});
app.patch('/api/code/files/:id', (req, res) => {
  const b = req.body || {}, store = req.store;
  const cur = store.codeGet(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const patch = {};
  if (b.name !== undefined) { const nm = String(b.name).trim(); if (!validCodeName(nm)) return res.status(400).json({ error: 'invalid name' }); patch.name = nm; patch.lang = cur.is_dir ? null : langForCodeFile(nm); }
  if (b.content !== undefined && !cur.is_dir) {
    const stats = store.codeStats();
    const delta = String(b.content).length - (cur.content ? cur.content.length : 0);
    if ((stats.n || 0) + delta > CODE_MAX_BYTES) return res.status(413).json({ error: 'workspace size limit reached' });
    patch.content = String(b.content);
  }
  if (b.parent !== undefined) { const np = b.parent ? String(b.parent) : null; if (np) { const p = store.codeGet(np); if (!p || !p.is_dir) return res.status(400).json({ error: 'bad parent' }); } patch.parent = np; }
  const node = store.codeUpdate(req.params.id, patch);
  store.bump(); res.json(node);
});
app.delete('/api/code/files/:id', (req, res) => { const ok = req.store.codeDelete(req.params.id); req.store.bump(); res.json({ ok }); });

/* run a workspace file — Server-Sent Events stream of output. EventSource is
   GET-only, so the entry id rides in the query; the session cookie authorizes. */
app.get('/api/code/run', async (req, res) => {
  const store = req.store, account = req.account;
  if (!(account.is_admin || account.can_code)) return res.status(403).json({ error: 'code execution is not enabled for your account' });
  const entry = store.codeGet(String(req.query.entry || ''));
  if (!entry || entry.is_dir) return res.status(400).json({ error: 'pick a file to run' });
  const lang = langForCodeFile(entry.name);
  if (!lang) return res.status(400).json({ error: 'only Python (.py) and JavaScript (.js) files can run' });
  if (runs.size >= RUN_MAX_GLOBAL) return res.status(429).json({ error: 'server busy — too many programs running' });
  if (activeRunsFor(account.id) >= RUN_MAX_PER_ACCT) return res.status(429).json({ error: 'stop your running program first' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();
  const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} };

  const runId = 'r' + crypto.randomBytes(6).toString('hex');
  const dir = path.join(RUN_DIR, runId);
  let entryRel;
  try { entryRel = await materializeWorkspace(store, dir, entry.id); }
  catch (e) { send('err', 'could not prepare files: ' + (e.message || e)); send('exit', { code: null }); try { res.end(); } catch (x) {} try { await fsp.rm(dir, { recursive: true, force: true }); } catch (x) {} return; }

  const runner = RUNNERS[lang];
  const child = spawn(runner.cmd, runner.args(entryRel), {
    cwd: dir,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: dir, TMP: dir, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const rec = { child, accountId: account.id, dir, killedFor: null };
  runs.set(runId, rec);
  send('start', { runId, lang, runner: runner.label, entry: entry.name });

  let outBytes = 0;
  const pump = (kind) => (buf) => {
    outBytes += buf.length;
    if (outBytes > RUN_MAX_OUTPUT) { if (!rec.killedFor) { rec.killedFor = 'output'; send('err', '\n[output limit reached — stopped]\n'); killTree(child); } return; }
    send(kind, buf.toString('utf8'));
  };
  if (child.stdout) child.stdout.on('data', pump('out'));
  if (child.stderr) child.stderr.on('data', pump('err'));

  const timer = setTimeout(() => { if (!rec.killedFor) { rec.killedFor = 'timeout'; send('err', `\n[timed out after ${RUN_TIMEOUT_MS / 1000}s — stopped]\n`); killTree(child); } }, RUN_TIMEOUT_MS);

  let done = false;
  const finish = (payload) => { if (done) return; done = true; clearTimeout(timer); send('exit', payload); try { res.end(); } catch (e) {} cleanupRun(runId); };
  child.on('error', (e) => { send('err', 'failed to start: ' + (e.code === 'ENOENT' ? `${runner.cmd} is not installed on the server` : e.message)); finish({ code: null }); });
  child.on('close', (code, signal) => finish({ code, signal, reason: rec.killedFor }));

  req.on('close', () => { if (!done && runs.has(runId)) { rec.killedFor = rec.killedFor || 'closed'; killTree(child); } });
});
app.post('/api/code/stop/:runId', (req, res) => {
  const r = runs.get(req.params.runId);
  if (r && r.accountId === req.accountId) { r.killedFor = r.killedFor || 'stopped'; killTree(r.child); }
  res.json({ ok: true });
});
app.post('/api/code/stopall', (req, res) => {
  for (const r of runs.values()) if (r.accountId === req.accountId) { r.killedFor = r.killedFor || 'stopped'; killTree(r.child); }
  res.json({ ok: true });
});

/* ============================================================
   AI APP — chat via xAI (direct, admin key) or the Cloudflare worker (CF free AI)
   The xAI key lives encrypted in system settings and never reaches the browser;
   the Cloudflare worker is open (auth-free), so it only needs a URL. Both providers
   are normalized to one SSE event shape.
   ============================================================ */
const DEFAULT_WORKER_URL = 'https://ai-chat-worker.zorbyteofficial.workers.dev';
function aiConfig() {
  return {
    xaiKey: getSecret('ai.xai_key'),
    workerUrl: (getSetting('ai.worker_url') || DEFAULT_WORKER_URL).replace(/\/+$/, ''),
  };
}
function isGrokModel(m) { return typeof m === 'string' && m.toLowerCase().includes('grok'); }
function requireAi(req, res) {
  if (req.account.is_admin || req.account.can_ai) return true;
  res.status(403).json({ error: 'AI is not enabled for your account' });
  return false;
}

/* ---------- AI personalization (per-account: name, style, instructions, memory) ---------- */
const AI_TRAIT_TEXT = {
  concise: 'Keep responses brief and to the point',
  detailed: 'Give thorough, in-depth answers',
  friendly: 'Use a warm, casual, conversational tone',
  formal: 'Use a professional, formal tone',
  direct: 'Be direct and skip unnecessary preamble',
  encouraging: 'Be encouraging and supportive',
  technical: 'Assume technical proficiency and use precise terminology',
  eli5: 'Explain things simply, as if to a beginner',
};
function sanitizePersona(b) {
  const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
  let traits = Array.isArray(b.traits) ? b.traits.filter(t => AI_TRAIT_TEXT[t]) : [];
  traits = [...new Set(traits)].slice(0, 8);
  return {
    name: str(b.name, 60),
    role: str(b.role, 200),
    instructions: str(b.instructions, 4000),
    traits,
    memoryEnabled: b.memoryEnabled !== false,
  };
}
/* ============================================================================
   BASE SYSTEM PROMPT — the assistant's identity, behavior, and built-in
   knowledge of Simplex itself. Always prepended (before per-account persona +
   memory + any per-chat note). Keep this in sync with the real app: the apps in
   APPS (app.js), the tools in AI_TOOLS, the encryption model (crypto.js), and
   the account/restart/sharing behavior documented in README.md.
   ========================================================================== */
const SIMPLEX_BASE_PROMPT = `You are Simplex Assistant, the built-in AI inside Simplex — a private, self-hosted, end-to-end-encrypted personal workspace. You help the user get things done AND help them learn their way around Simplex, so every answer should leave them a little more capable than before.

# How to respond
- Be warm, clear, and genuinely helpful. Match the user's energy — brief for quick questions, thorough when they're stuck or learning something new.
- Lead with the answer or the action, then explain. Don't bury the useful part under preamble.
- Use Markdown: short paragraphs, **bold** for the key term, and numbered steps for anything the user has to *do* in the app. Code/filenames in \`backticks\`.
- Be honest about limits. If something is a "coming soon" feature, a permission the user may not have, or a thing only an admin can do, say so plainly instead of pretending it works.
- Never reveal or guess secrets: you can't see the user's password, the master encryption key, or any other account's data. If asked, explain *why* (keys live only on the server) rather than refusing flatly.
- Keep the conversation going: after you answer, offer a natural next step, a related tip, or a quick "want me to…?" — especially when the user seems new. Teaching beats one-and-done answers. Ask a clarifying question when the request is ambiguous rather than guessing wide.

# What Simplex is
Simplex is a dashboard of apps. Everything the user stores is **encrypted at rest** and **isolated per account** — each account has its own database, its own files, and its own encryption keys, so no account can ever see another's data. The user reaches the apps from the main dashboard.

## The apps (current)
- **Database** — the user's encrypted file vault: files, media, and folders (up to 200 GB per account). Upload, organize, preview, and stream. Video/audio scrubbing works because blobs are stored so Range requests still function. Right-click a file for actions like sharing or setting an album cover.
- **AI** (you) — chat with AI models, streamed live. Conversations are saved encrypted per account. The user can pick a model, personalize how you respond, and (where enabled) let you use tools to act on their vault.
- **Code** — edit and run code in the cloud.
- **Notes** — rich, encrypted notes and documents.
- **Tools** — a big set of in-browser converters and utilities (audio/video/image conversion & compression, images→PDF, watermarking, resizing, and more). They run client-side and many can save straight back to the vault. Some entries are marked "coming soon."
- **Settings** — manage the account, members, appearance, and (for admins) the server.
- **Connectors** — link external services and automate with connectors.
- **Neural Network** — build and train your own neural networks, saved to your encrypted vault. Three ways: **Actor Lab** (a 2D actor engine — author actor types with custom variables, a physics body, an optional AI brain, and a per-tick *node graph* with UE5-Blueprint-style flow: white **action** wires thread the run order through event/action nodes, and typed colored **data** wires carry numbers/booleans, with a **Branch** node to split on a condition; raycasts (the starter Agent has a 360° fan of 8), collisions, and reward nodes included; a *Visible Raycasts* world toggle draws the rays during playback; place instances on a map and *evolve* the agents to maximize the reward your graphs define — one brain per agent type), a simpler **Quick Sandbox** (fixed agent + target, pick sensor inputs and a fitness rule, evolve), and a **Text Model** (upload text to pre-train/fine-tune a char-level language model, then chat with it). Models run in the browser by default; if an admin has enabled **backend compute** for the account (the \`can_neural_backend\` permission), training can run on the server instead.
Not every app/utility is finished; some are marked beta or "soon." If the user asks about one that isn't ready, tell them it's on the way rather than inventing steps.

## Accounts, sign-in & permissions
- Sign in with **username + password**. Sessions are browser-session-scoped — **reloading the page signs you out**. (This surprises people: if someone says they "got logged out," a reload is usually why.)
- The first/default **admin** account is \`admin\` / \`1234\` on first boot — it should be changed immediately under the account menu → *My account*.
- **Admins** can create, edit, and delete all accounts (account menu → *Manage accounts*): username, display name, password, admin flag, and per-account storage quota. They can also restart the server (Settings → Server → *Restart now*).
- **Non-admin** accounts can edit only themselves (display name + password). Some features are enabled per account by an admin: **AI** access, **code execution**, and **backend compute** for the Neural Network app (running training on the server rather than in the browser). If one of these isn't available for someone, that's an admin toggle, not a bug — the rest of the Neural Network app still works client-side without it.
- Guards: you can't delete your own account or remove the last admin.

## Encryption (reassure, accurately)
- Everything is encrypted at rest with keys that live **only on the server** and are never sent to any browser. File contents, file names, and metadata are all encrypted; passwords are hashed with scrypt.
- There's a single **master key** the whole vault depends on. **If it's lost, the data is unrecoverable** — so admins should back it up (there's a \`key.js\` CLI for show/backup/restore/verify). Mention this when a user asks about safety or backups.
- Because keys never leave the server, you (the assistant) genuinely cannot decrypt or reveal anyone's data on your own.

## Things that confuse people (proactively help here)
- **"It logged me out."** → Sessions are per browser-session; a reload signs you out by design.
- **"The whole UI zoomed out / a 'server is restarting' panel appeared."** → That's a normal restart (scheduled every few hours, or an admin clicked Restart). It auto-reloads everyone the moment the new server is up — they don't need to do anything but wait a few seconds.
- **"A blank page / it loaded forever."** → Simplex has a boot guard that shows a real crash overlay with a copyable report instead of a blank screen; if they hit one, that report is exactly what to share with an admin.
- **"My upload is huge."** → Large uploads are split into chunks and sent in parallel automatically; the user just picks the file.
- **"Can others see my files?"** → No. Accounts are fully isolated. Sharing only exposes what the user explicitly shares.

# Using tools (only when tool mode is on)
When you have tools available, prefer them over guessing: use web search for current facts, list/read the user's Database files before acting on them, and write/edit files or create artifacts to produce real work. Never invent file ids, search results, or contents — get them from the tools. When a task is done, reply normally with no tool call.

# Teaching mindset
Assume the user may be new to Simplex. When a question touches an app or feature, weave in the *one* most useful thing they didn't ask about (e.g. "you can right-click any song to set a cover," or "remember a reload signs you out"). Keep it to a sentence — a helpful nudge, not a lecture — and end in a way that invites the next question.`;

/* assemble the system prompt from the account's stored persona + memory */
function buildAiSystem(store) {
  let persona = {}; try { persona = store.aiPersonaGet() || {}; } catch (e) {}
  const parts = [SIMPLEX_BASE_PROMPT];
  const who = [];
  if (persona.name) who.push(`The user's preferred name is ${persona.name}; address them as ${persona.name} when it feels natural.`);
  if (persona.role) who.push(`About the user: ${persona.role}.`);
  if (who.length) parts.push(who.join(' '));
  if (Array.isArray(persona.traits) && persona.traits.length) {
    parts.push('Preferred response style: ' + persona.traits.map(t => AI_TRAIT_TEXT[t] || t).join('; ') + '.');
  }
  if (persona.instructions) parts.push(persona.instructions);
  if (persona.memoryEnabled !== false) {
    let mem = []; try { mem = store.aiMemoryList(); } catch (e) {}
    if (mem.length) parts.push('Things to remember about the user from past conversations (use them when relevant):\n' + mem.map(m => '- ' + m.text).join('\n'));
  }
  return parts.length ? parts.join('\n\n') : null;
}

/* admin: view (xAI key never returned) / set the providers config */
app.get('/api/ai/config', requireAdmin, (req, res) => {
  const c = aiConfig();
  res.json({
    xaiKeySet: !!c.xaiKey, workerUrl: c.workerUrl,
    localEngine: localAI.engineAvailable(), modelsDir: localAI.getModelsDir(),
    serverModels: localAI.listServerModels().map(m => ({ name: m.name, file: m.file, size: m.size })),
    thermal: localAI.thermalState(),    // live temp + thresholds for the admin readout
  });
});
app.put('/api/ai/config', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (b.xaiKey !== undefined) setSecret('ai.xai_key', b.xaiKey.trim());
  if (b.workerUrl !== undefined) setSetting('ai.worker_url', String(b.workerUrl).trim().replace(/\/+$/, ''));
  if (b.modelsDir !== undefined) {
    const dir = String(b.modelsDir || '').trim();
    setSetting('ai.models_dir', dir);
    try { localAI.setModelsDir(dir || path.join(ROOT, 'models')); } catch (e) {}
  }
  // thermal safety-net thresholds (°C). configure() clamps + keeps a resume<trip gap;
  // we persist the clamped values it actually applied so they survive a restart.
  if (b.thermalTripC !== undefined || b.thermalResumeC !== undefined) {
    const applied = localAI.thermalConfigure({
      tripC: b.thermalTripC !== undefined ? parseFloat(b.thermalTripC) : undefined,
      resumeC: b.thermalResumeC !== undefined ? parseFloat(b.thermalResumeC) : undefined,
    });
    setSetting('ai.thermal_trip_c', String(applied.tripC));
    setSetting('ai.thermal_resume_c', String(applied.resumeC));
  }
  const c = aiConfig();
  res.json({
    ok: true, xaiKeySet: !!c.xaiKey, workerUrl: c.workerUrl,
    localEngine: localAI.engineAvailable(), modelsDir: localAI.getModelsDir(),
    thermal: localAI.thermalState(),
  });
});

/* available ONLINE models — aggregated from the configured providers. Cached
   briefly because the upstream /models calls are slow + identical for everyone.
   Local models are NOT cached here (they're per-account + cheap to enumerate). */
let _onlineModelCache = { at: 0, models: null };
async function onlineModels() {
  if (_onlineModelCache.models && Date.now() - _onlineModelCache.at < 60_000) return _onlineModelCache.models;
  const c = aiConfig();
  const out = [];
  if (c.xaiKey) {
    try {
      // bound the call — a slow/unreachable provider must not hang the request
      const r = await fetch('https://api.x.ai/v1/models', { headers: { Authorization: `Bearer ${c.xaiKey}` }, signal: AbortSignal.timeout(8000) });
      if (r.ok) { const d = await r.json(); for (const m of (d.data || [])) out.push({ id: m.id, name: m.id, provider: 'xAI' }); }
    } catch (e) {}
  }
  if (c.workerUrl) {
    try {
      const r = await fetch(`${c.workerUrl}/models`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { const d = await r.json(); for (const m of (d.models || [])) if (m.provider === 'Cloudflare') out.push({ id: m.id, name: m.name, provider: 'Cloudflare' }); }
    } catch (e) {}
  }
  _onlineModelCache = { at: Date.now(), models: out };
  return out;
}
app.get('/api/ai/models', async (req, res) => {
  if (!requireAi(req, res)) return;
  // online (api) + local (bundled engine: server folder + this account's .gguf files)
  const online = (await onlineModels()).map(m => ({ ...m, scope: 'online' }));
  let local = [];
  try { local = localAI.listModels(req.store).map(m => ({ ...m, scope: 'local' })); } catch (e) {}
  const out = [...online, ...local];
  res.json({ models: out });
});

/* streaming chat — uniform SSE: data: {type:'text',text} … {type:'done'} / {type:'error',error} */
app.post('/api/ai/chat', async (req, res) => {
  if (!requireAi(req, res)) return;
  const b = req.body || {};
  const model = String(b.model || '').trim();
  const messages = Array.isArray(b.messages) ? b.messages : [];
  // system prompt is assembled server-side from the account's personalization +
  // memory (always applied); a per-chat system note from the client is appended.
  const persona = buildAiSystem(req.store);
  const clientSys = typeof b.system === 'string' && b.system.trim() ? b.system.trim() : null;
  const system = [persona, clientSys].filter(Boolean).join('\n\n') || null;
  const maxTokens = Number.isFinite(+b.max_tokens) ? Math.min(+b.max_tokens, 16384) : 4096;
  if (!model) return res.status(400).json({ error: 'model required' });
  const c = aiConfig();
  // Analytics app: record this AI turn (local vs online only — never the message text)
  try { logAnalytics(req.store, 'ai_message', { provider: localAI.isLocalModel(model) ? 'local' : 'online' }); } catch (e) {}

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };

  const ac = new AbortController();
  let closed = false;
  // NB: listen on res, not req — express.json() drains the POST body, so req emits
  // 'close' immediately (body fully read) even while the connection is still open.
  // res 'close' fires only when the response actually ends or the client disconnects.
  res.on('close', () => { if (!res.writableEnded) { closed = true; try { ac.abort(); } catch (e) {} } });

  // SSE keep-alive comment (ignored by the client parser). A cold LOCAL model load
  // or long CPU prompt-eval can run 30s+ with zero bytes on the wire; without a
  // heartbeat the per-socket idle timeout (and proxies like Cloudflare) can drop
  // the connection mid-load. The ping also resets the socket idle timer.
  let beat = null;
  const startBeat = () => { if (!beat) beat = setInterval(() => { try { if (!res.writableEnded) res.write(': ping\n\n'); } catch (e) {} }, 15_000); };
  const stopBeat = () => { if (beat) { clearInterval(beat); beat = null; } };

  try {
    if (localAI.isLocalModel(model)) {
      // Local GGUF model via the bundled engine. Loading a cold model can take a
      // while (read/decrypt + llama-server warmup), so emit 'stage' notes the UI
      // can surface ("loading model…") while we wait.
      if (!localAI.engineAvailable()) throw new Error('Local AI engine is not available on this server');
      startBeat();
      await localAI.chatStream({
        id: model, store: req.store, messages, system, maxTokens,
        temperature: Number.isFinite(+b.temperature) ? +b.temperature : undefined,
        signal: ac.signal,
        onStage: (stage) => { if (!closed) send({ type: 'stage', stage }); },
        onText: (t) => { if (!closed && t) { stopBeat(); send({ type: 'text', text: t }); } },
      });
      if (!closed) { send({ type: 'done' }); }
    } else if (isGrokModel(model)) {
      if (!c.xaiKey) throw new Error('xAI is not configured');
      const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
      const r = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST', signal: ac.signal,
        headers: { Authorization: `Bearer ${c.xaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: msgs, max_tokens: maxTokens, stream: true }),
      });
      if (!r.ok) throw new Error(`xAI ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      let buf = '';
      for await (const chunk of r.body) {
        if (closed) break;
        buf += Buffer.from(chunk).toString('utf8');
        const lines = buf.split('\n'); buf = lines.pop() ?? '';
        for (const line of lines) {
          const data = line.replace(/^data: ?/, '').trim();
          if (!data || data === '[DONE]') continue;
          try { const t = JSON.parse(data).choices?.[0]?.delta?.content || ''; if (t) send({ type: 'text', text: t }); } catch (e) {}
        }
      }
      if (!closed) { send({ type: 'done' }); }
    } else {
      // Cloudflare free AI via the (open, auth-free) worker — pipe its SSE through
      if (!c.workerUrl) throw new Error('Cloudflare AI is not configured');
      const r = await fetch(`${c.workerUrl}/chat`, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, system, max_tokens: maxTokens }),
      });
      if (!r.ok) throw new Error(`worker ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      for await (const chunk of r.body) { if (closed) break; res.write(Buffer.from(chunk)); }   // worker already emits our event shape
    }
  } catch (err) {
    if (!closed) send({ type: 'error', error: (err && err.name === 'AbortError') ? 'stopped' : (err.message || 'AI request failed') });
  } finally {
    stopBeat();
    if (!closed) { try { res.end(); } catch (e) {} }
  }
});

/* Local AI engine status — which models exist (server folder + this account's
   .gguf files) and which are currently resident in memory. Used by the Local tab. */
app.get('/api/ai/local/status', (req, res) => {
  if (!requireAi(req, res)) return;
  try { res.json(localAI.status(req.store)); }
  catch (e) { res.status(500).json({ error: e.message || 'engine error' }); }
});
/* Manually evict a loaded local model (free its RAM). id optional = unload all. */
app.post('/api/ai/local/unload', (req, res) => {
  if (!requireAi(req, res)) return;
  const id = req.body && req.body.id;
  if (id) localAI.unload(String(id), 'manual'); else localAI.unloadAll();
  res.json({ ok: true });
});
/* Admin override: clear an active thermal trip early (use sparingly — the trip
   exists to protect the hardware). */
app.post('/api/ai/local/thermal/reset', requireAdmin, (req, res) => {
  localAI.thermalReset();
  res.json({ ok: true, thermal: localAI.thermalState() });
});

/* per-account saved conversations (encrypted) */
app.get('/api/ai/chats', (req, res) => res.json(req.store.chatsList()));
app.get('/api/ai/chats/:id', (req, res) => { const ch = req.store.chatGet(req.params.id); if (!ch) return res.status(404).json({ error: 'not found' }); res.json(ch); });
app.post('/api/ai/chats', (req, res) => {
  const b = req.body || {};
  const ch = req.store.chatCreate({ title: String(b.title || 'New chat').slice(0, 200), model: b.model || null, messages: Array.isArray(b.messages) ? b.messages : [] });
  req.store.bump(); res.json(ch);
});
app.patch('/api/ai/chats/:id', (req, res) => {
  const b = req.body || {}, patch = {};
  if (b.title !== undefined) patch.title = String(b.title).slice(0, 200);
  if (b.model !== undefined) patch.model = b.model;
  if (b.messages !== undefined) patch.messages = Array.isArray(b.messages) ? b.messages : [];
  const ch = req.store.chatUpdate(req.params.id, patch);
  if (!ch) return res.status(404).json({ error: 'not found' });
  req.store.bump(); res.json(ch);
});
app.delete('/api/ai/chats/:id', (req, res) => { const ok = req.store.chatDelete(req.params.id); req.store.bump(); res.json({ ok }); });

/* per-account AI personalization (preferred name, role, style, instructions) + memory */
app.get('/api/ai/persona', (req, res) => {
  if (!requireAi(req, res)) return;
  res.json({ persona: req.store.aiPersonaGet(), memory: req.store.aiMemoryList(), traits: AI_TRAIT_TEXT });
});
app.put('/api/ai/persona', (req, res) => {
  if (!requireAi(req, res)) return;
  req.store.aiPersonaSet(sanitizePersona(req.body || {}));
  res.json({ persona: req.store.aiPersonaGet() });
});
app.get('/api/ai/memory', (req, res) => {
  if (!requireAi(req, res)) return;
  res.json(req.store.aiMemoryList());
});
app.post('/api/ai/memory', (req, res) => {
  if (!requireAi(req, res)) return;
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'memory text required' });
  if (req.store.aiMemoryCount() >= 200) return res.status(429).json({ error: 'memory is full (max 200) — remove some entries first' });
  res.json(req.store.aiMemoryAdd(text));
});
app.patch('/api/ai/memory/:id', (req, res) => {
  if (!requireAi(req, res)) return;
  const b = req.body || {}, patch = {};
  if (b.text != null) { const t = String(b.text).trim().slice(0, 2000); if (!t) return res.status(400).json({ error: 'text required' }); patch.text = t; }
  if (b.pinned != null) patch.pinned = !!b.pinned;
  const m = req.store.aiMemoryUpdate(req.params.id, patch);
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json(m);
});
app.delete('/api/ai/memory/:id', (req, res) => {
  if (!requireAi(req, res)) return;
  res.json({ ok: req.store.aiMemoryDelete(req.params.id) });
});
app.post('/api/ai/memory/clear', (req, res) => {
  if (!requireAi(req, res)) return;
  req.store.aiMemoryClear();
  res.json({ ok: true });
});

/* ---------- AI tool: web search ----------
   Browser CSP (connect-src 'self') blocks the page from calling search engines
   directly, so the web_search tool runs through this server proxy. Free + keyless
   via DuckDuckGo's HTML endpoint; best-effort parsing of the top results. */
function htmlUnescape(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
function stripTags(s) { return htmlUnescape(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim(); }
function parseDuckDuckGo(html) {
  const out = [];
  const snippets = [];
  const sre = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let sm; while ((sm = sre.exec(html)) && snippets.length < 12) snippets.push(stripTags(sm[1]));
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m, i = 0;
  while ((m = re.exec(html)) && out.length < 10) {
    let url = htmlUnescape(m[1]);
    const u = /[?&]uddg=([^&]+)/.exec(url); if (u) { try { url = decodeURIComponent(u[1]); } catch (e) {} }
    if (url.startsWith('//')) url = 'https:' + url;
    const title = stripTags(m[2]);
    if (title) out.push({ title, url, snippet: snippets[i] || '' });
    i++;
  }
  return out;
}
app.post('/api/ai/tools/web_search', async (req, res) => {
  if (!requireAi(req, res)) return;
  const q = String((req.body && req.body.query) || '').trim().slice(0, 400);
  if (!q) return res.status(400).json({ error: 'query required' });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 9000);
  try {
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
      method: 'POST', signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Simplex/1.0)', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'q=' + encodeURIComponent(q),
    });
    const html = await r.text();
    res.json({ query: q, results: parseDuckDuckGo(html).slice(0, 6) });
  } catch (e) {
    res.status(502).json({ error: 'search failed: ' + (e.name === 'AbortError' ? 'timed out' : (e.message || 'error')) });
  } finally { clearTimeout(timer); }
});

/* ============================================================
   CONNECTORS + NOTIFICATIONS
   Every connector is defined the same data-driven way (the catalog below is just
   the "built-in" set; user-published connectors plug into the same shape), so the
   system is a marketplace from day one. Each catalog entry = { id, name, category,
   icon, desc, fields[] }. Installing one creates a per-account `connectors` row
   with the user's config; engines (e.g. the Schedule engine) act on enabled rows.
   ============================================================ */
const CONNECTOR_CATALOG = [
  {
    id: 'schedule', name: 'Schedule', category: 'Productivity', icon: 'clock', status: 'ready',
    desc: 'Get pinged at set times to confirm you finished a task. Notifies in-app (and your device if allowed).',
    fields: [
      { key: 'task', label: 'Task / reminder', type: 'text', placeholder: 'e.g. Take medication', required: true },
      { key: 'time', label: 'Time', type: 'time', default: '09:00', required: true },
      { key: 'days', label: 'Repeat on', type: 'days', default: [1, 2, 3, 4, 5] },
      { key: 'message', label: 'Note (optional)', type: 'text', placeholder: 'Anything to remember' },
    ],
  },
  { id: 'webhook', name: 'Webhook', category: 'Developer', icon: 'plug', status: 'soon', desc: 'Call an external URL when things happen in your workspace.' },
  { id: 'rss', name: 'RSS Feed', category: 'Content', icon: 'globe', status: 'soon', desc: 'Pull a feed into your dashboard and get notified of new items.' },
  { id: 'email-digest', name: 'Email Digest', category: 'Productivity', icon: 'send', status: 'soon', desc: 'A periodic summary of your vault activity by email.' },
  { id: 'discord', name: 'Discord', category: 'Social', icon: 'share', status: 'soon', desc: 'Post notifications to a Discord channel via webhook.' },
  { id: 'backup', name: 'Cloud Backup', category: 'Storage', icon: 'database', status: 'soon', desc: 'Mirror selected folders to an external storage provider.' },
];
const CONNECTOR_TYPES = new Set(CONNECTOR_CATALOG.filter(c => c.status === 'ready').map(c => c.id));

app.get('/api/connectors/catalog', requireAuth, (req, res) => res.json({ catalog: CONNECTOR_CATALOG }));
app.get('/api/connectors', requireAuth, (req, res) => res.json(req.store.connList()));
app.post('/api/connectors', requireAuth, (req, res) => {
  const b = req.body || {};
  const type = String(b.type || '');
  if (!CONNECTOR_TYPES.has(type)) return res.status(400).json({ error: 'that connector isn\'t available yet' });
  const conn = req.store.connCreate({ type, label: String(b.label || '').slice(0, 80), config: (b.config && typeof b.config === 'object') ? b.config : {} });
  req.store.bump();
  res.json(conn);
});
app.patch('/api/connectors/:id', requireAuth, (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.label != null) patch.label = String(b.label).slice(0, 80);
  if (b.config != null && typeof b.config === 'object') patch.config = b.config;
  if (b.enabled != null) patch.enabled = !!b.enabled;
  const c = req.store.connUpdate(req.params.id, patch);
  if (!c) return res.status(404).json({ error: 'not found' });
  req.store.bump();
  res.json(c);
});
app.delete('/api/connectors/:id', requireAuth, (req, res) => { const ok = req.store.connDelete(req.params.id); req.store.bump(); res.json({ ok }); });

/* notifications */
app.get('/api/notifications', requireAuth, (req, res) => res.json({ items: req.store.notifList(), unread: req.store.notifUnread() }));
app.post('/api/notifications/:id/ack', requireAuth, (req, res) => { req.store.notifAck(req.params.id); req.store.bump(); res.json({ ok: true }); });
app.post('/api/notifications/:id/read', requireAuth, (req, res) => { req.store.notifRead(req.params.id); res.json({ ok: true }); });
app.post('/api/notifications/read-all', requireAuth, (req, res) => { req.store.notifReadAll(); res.json({ ok: true }); });
app.delete('/api/notifications/:id', requireAuth, (req, res) => { req.store.notifDelete(req.params.id); req.store.bump(); res.json({ ok: true }); });

/* ---------- usage analytics (the Analytics app) ----------
   The client posts coarse usage events ("opened the AI app", "used a tool",
   "session heartbeat"); the server records them in the account's own analytics
   table and serves a summary the user can view in the Analytics app. This data is
   PRIVATE to the account and not used by us — see the Analytics app's own notice.
   We allow only a fixed set of event types and a small meta bag (no file names). */
const ANALYTICS_TYPES = new Set(['session', 'app_open', 'upload', 'ai_message', 'tool_use', 'file_view', 'download', 'share', 'note_edit', 'convert']);
// meta keys we accept, each a short label/number — never file names or content.
function sanitizeAnalyticsMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const out = {};
  for (const k of ['app', 'tool', 'kind', 'provider', 'where', 'n', 'seconds']) {
    if (meta[k] == null) continue;
    if (k === 'n' || k === 'seconds') { const v = +meta[k]; if (Number.isFinite(v)) out[k] = Math.max(0, Math.min(86400, Math.round(v))); }
    else out[k] = String(meta[k]).slice(0, 32);
  }
  return Object.keys(out).length ? out : null;
}
function logAnalytics(store, type, meta) {
  if (!store || !ANALYTICS_TYPES.has(type)) return;
  try { store.analyticsLog(type, sanitizeAnalyticsMeta(meta)); } catch (e) {}
}
app.post('/api/analytics/event', requireAuth, (req, res) => {
  const b = req.body || {};
  // accept either one {type,meta} or a small batch {events:[...]} (heartbeats may queue)
  const events = Array.isArray(b.events) ? b.events.slice(0, 50) : [{ type: b.type, meta: b.meta }];
  for (const ev of events) {
    if (ev && typeof ev.type === 'string' && ANALYTICS_TYPES.has(ev.type)) logAnalytics(req.store, ev.type, ev.meta);
  }
  res.json({ ok: true });
});
app.get('/api/analytics/summary', requireAuth, (req, res) => {
  res.json(req.store.analyticsSummary());
});
app.delete('/api/analytics', requireAuth, (req, res) => { req.store.analyticsClear(); res.json({ ok: true }); });

/* ============================================================
   TRADING APP — a GLOBAL, always-training signal model + a per-account paper/live
   trader. The model is one network shared by every account (system db); it trains
   continuously in the background off the event loop. Each account picks a MODE:

     • Sandbox (default, everyone) — "fake money." The user deposits virtual cash and
       the model trades a SIMULATED portfolio against real market data, so they can
       judge "is this model good enough for me?" before risking anything.
     • Live (gated, opt-in) — the user connects THEIR OWN Alpaca account (key+secret,
       stored only inside their encrypted portfolio doc). Simplex never holds funds;
       it places orders against the user's brokerage. Requires admin master-enable +
       per-user opt-in, defaults OFF, and a one-click kill switch.

   ⚠️ NOT FINANCIAL ADVICE. Paper success ≠ live success. The Live path is gated for
   exactly this reason. See trading-engine.js for the no-lookahead / risk-gate guts.
   ============================================================ */
const TR = TradingEngine;
const TRADE_DISCLAIMER = 'Not financial advice. Automated trading carries real risk of loss. A backtested or paper-trading result is not a guarantee of live performance. Only ever trade money you can afford to lose.';

/* ---------- admin config (system settings) ----------
   What an admin controls in Settings → Trading:
     trading.symbols    — the universe the model trades (comma list). Default below.
     trading.live_enabled — master switch for the Live path. OFF by default; while
                            OFF, no account can place real orders no matter their opt-in.
     trading.data_source — 'yahoo' (free daily OHLCV JSON, no key) for now; pluggable later. */
const TRADING_DEFAULT_SYMBOLS = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'BTC-USD'];
function tradingSymbols() {
  const raw = getSetting('trading.symbols');
  if (!raw) return TRADING_DEFAULT_SYMBOLS.slice();
  const list = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  return list.length ? list.slice(0, 25) : TRADING_DEFAULT_SYMBOLS.slice();
}
function tradingLiveEnabled() { return getSetting('trading.live_enabled') === '1'; }
function tradingConfig() {
  return {
    symbols: tradingSymbols(),
    liveEnabled: tradingLiveEnabled(),
    dataSource: getSetting('trading.data_source') || 'yahoo',
    disclaimer: TRADE_DISCLAIMER,
  };
}

/* ---------- global model (system db, encrypted with __system__ keyset) ---------- */
function tradingModelLoad() {
  const r = tradingSys.modelGet.get();
  if (!r || !r.data) return null;
  try { return JSON.parse(vault.decText(r.data, SYS_KEYS)); } catch (e) { return null; }
}
function tradingModelSave(model) {
  tradingSys.modelSet.run({ data: vault.encText(JSON.stringify(model), SYS_KEYS), updated: Date.now() });
}
let _tradingOpt = {};   // Adam moment state for the global model (in-memory across ticks; rebuilt on boot)
function tradingModel() {
  let m = tradingModelLoad();
  // (re)build if missing or trained on an older feature layout
  if (!m || m.featureVersion !== TR.FEATURE_VERSION || m.inp !== TR.FEATURE_DIM) {
    m = TR.newModel({ seed: 1337 });
    _tradingOpt = {};
    tradingModelSave(m);
  }
  return m;
}

/* ---------- model usability gate (protects the LIVE path) ----------
   An admin can RESET the global model when it goes bad. After a reset (or a fresh
   build) the model is brand new and must NOT touch real money until it has both:
     1. trained at least TRADING_MIN_ROUNDS rounds again, AND
     2. been explicitly re-approved as "usable" by an admin.
   Approval is a system setting that a reset clears, so it has to be re-earned. The
   SANDBOX is intentionally exempt — that's where you evaluate whether the retrained
   model is good enough, so it keeps simulating regardless of approval. */
const TRADING_MIN_ROUNDS = +process.env.SX_TRADING_MIN_ROUNDS || 100;
function tradingModelApproved() { return getSetting('trading.model_approved') === '1'; }
function tradingModelUsable(m) {
  m = m || tradingModelLoad();
  return !!(m && (m.trainedSteps || 0) >= TRADING_MIN_ROUNDS && tradingModelApproved());
}
// Why the model isn't live-usable yet (for the UI). Returns null when it IS usable.
function tradingModelBlockReason(m) {
  m = m || tradingModelLoad();
  const rounds = (m && m.trainedSteps) || 0;
  if (rounds < TRADING_MIN_ROUNDS) return `needs ${TRADING_MIN_ROUNDS - rounds} more training round${TRADING_MIN_ROUNDS - rounds === 1 ? '' : 's'} (has ${rounds}/${TRADING_MIN_ROUNDS})`;
  if (!tradingModelApproved()) return 'awaiting admin approval';
  return null;
}
// Reset the global model to a fresh untrained network. Clears approval + Adam state.
// A reset always revokes live-usability until it's retrained AND re-approved.
function tradingModelReset() {
  const m = TR.newModel({ seed: (Date.now() >>> 0) || 1337 });
  _tradingOpt = {};
  tradingModelSave(m);
  setSetting('trading.model_approved', '0');
  return m;
}

/* ---------- market data (free, yfinance-style) ----------
   Yahoo Finance's chart endpoint serves free daily OHLCV as JSON with no API key
   (the same data yfinance wraps). Symbols are used as-is ('SPY', 'BTC-USD'). We
   fetch a couple years per symbol, cache it in trading_bars, and refresh at most
   once/hour. All network is timeout-bounded and failure-tolerant: on any error we
   keep the cache, so the loops (and the sandbox) work fully offline once seeded. */
function parseYahooChart(json) {
  const res = json && json.chart && json.chart.result && json.chart.result[0];
  if (!res || !res.timestamp || !res.indicators || !res.indicators.quote) return [];
  const ts = res.timestamp, q = res.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
    if (!(c > 0) || o == null || h == null || l == null) continue;   // skip holiday/null bars
    bars.push({ t: ts[i] * 1000, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  return bars;
}
async function fetchBarsRemote(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (simplex-trading)' } });
    if (!r.ok) return null;
    const json = await r.json();
    const bars = parseYahooChart(json);
    return bars.length >= TR.WARMUP + 5 ? bars.slice(-1500) : null;   // cap history; need enough to warm up
  } catch (e) { return null; }
  finally { clearTimeout(to); }
}
/* INTRADAY bars — what the sandbox 'fast replay' plays back and what the model TRAINS
   on. We pull 5-minute bars over ~1 MONTH (range=1mo&interval=5m → ~1700 bars spanning
   ~30 days across several market regimes) rather than 1-minute over 5 days. The longer,
   more varied window is the real fix for overfitting: with only ~5 similar days the
   model memorized recent noise and reported fake ~98% accuracy; a month of varied data
   makes both training and validation honest. Markets emit no bars when closed, so we
   still replay real history at speed rather than invent ticks. Cached under '<SYM>#i'. */
async function fetchIntradayRemote(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=5m`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (simplex-trading)' } });
    if (!r.ok) return null;
    const json = await r.json();
    const bars = parseYahooChart(json);
    return bars.length >= TR.WARMUP + 30 ? bars.slice(-2500) : null;
  } catch (e) { return null; }
  finally { clearTimeout(to); }
}
const INTRADAY_KEY = (sym) => sym + '#i';
function tradingIntradayGet(sym) {
  const r = tradingSys.barsGet.get(INTRADAY_KEY(sym));
  if (!r || !r.bars) return null;
  try { return JSON.parse(r.bars); } catch (e) { return null; }
}
function tradingIntradaySet(sym, bars) { tradingSys.barsSet.run({ symbol: INTRADAY_KEY(sym), bars: JSON.stringify(bars), updated: Date.now() }); }
function tradingBarsGet(sym) {
  const r = tradingSys.barsGet.get(sym);
  if (!r || !r.bars) return null;
  try { return JSON.parse(r.bars); } catch (e) { return null; }
}
function tradingBarsSet(sym, bars) { tradingSys.barsSet.run({ symbol: sym, bars: JSON.stringify(bars), updated: Date.now() }); }
// latest price per symbol from the cache (what the sandbox marks against). Prefer the
// freshest intraday bar; fall back to the daily close. Skips the '#i' cache keys.
function tradingPrices() {
  const out = {};
  for (const sym of tradingSymbols()) {
    const intra = tradingIntradayGet(sym);
    if (intra && intra.length) { out[sym] = intra[intra.length - 1].c; continue; }
    const bars = tradingBarsGet(sym);
    if (bars && bars.length) out[sym] = bars[bars.length - 1].c;
  }
  return out;
}

/* ---------- per-account portfolio doc ---------- */
const TRADING_START_CASH = 100000;   // sandbox starts flat ($0); deposit adds virtual cash
function tradingDefaultDoc() {
  return {
    mode: 'sandbox',
    sandbox: { portfolio: TR.newPortfolio(0), deposited: 0, dayStartEquity: 0, dayStamp: '', lastSimBar: 0, stats: null },
    live: { enabled: false, killed: false, apiKey: '', apiSecret: '', paper: true, dayStartEquity: 0, dayStamp: '' },
    risk: {}, autoTrade: true, createdAt: Date.now(),
  };
}
function tradingDoc(store) {
  let d = store.tradingGet();
  if (!d) { d = tradingDefaultDoc(); store.tradingSet(d); }
  // forward-compat: ensure shape
  d.sandbox = d.sandbox || { portfolio: TR.newPortfolio(0), deposited: 0 };
  d.sandbox.portfolio = d.sandbox.portfolio || TR.newPortfolio(0);
  d.live = d.live || { enabled: false, killed: false, apiKey: '', apiSecret: '', paper: true };
  d.risk = d.risk || {};
  return d;
}
// strip secrets before sending the doc to the client
function tradingDocToApi(store, d) {
  const prices = tradingPrices();
  const pf = d.sandbox.portfolio;
  TR.markToMarket(pf, prices);
  const positions = Object.entries(pf.positions).map(([sym, p]) => ({
    symbol: sym, qty: p.qty, entry: p.entry, price: prices[sym] || p.entry,
    value: (prices[sym] || p.entry) * p.qty, pnl: ((prices[sym] || p.entry) - p.entry) * p.qty,
    stop: p.stop, take: p.take,
  }));
  return {
    mode: d.mode,
    autoTrade: d.autoTrade !== false,
    sandbox: {
      cash: pf.cash, equity: pf.equity, deposited: d.sandbox.deposited || 0,
      realized: pf.realized || 0, trades: pf.trades || 0,
      pnl: pf.equity - (d.sandbox.deposited || 0),
      positions, history: (pf.history || []).slice(-600),
      simulated: !!d.sandbox.lastSimBar,
      stats: d.sandbox.stats || null,
      granularity: (d.sandbox.stats && d.sandbox.stats.granularity) || 'day',
    },
    live: {
      enabled: !!d.live.enabled, killed: !!d.live.killed,
      keysSet: !!(d.live.apiKey && d.live.apiSecret), paper: d.live.paper !== false,
      masterEnabled: tradingLiveEnabled(),
    },
    risk: Object.assign({}, TR.DEFAULT_RISK, d.risk),
    disclaimer: TRADE_DISCLAIMER,
  };
}

/* ---------- Alpaca client (live path; the user's own keys) ----------
   Tiny fetch wrapper. paper=true hits the paper endpoint with real market data but
   fake fills; paper=false is real money. We never store funds — orders go straight
   to the user's brokerage. Reconcile-before-act: callers read open orders/positions
   first so a worker restart can't double-submit (plan §5 idempotency). */
function alpacaBase(paper) { return paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets'; }
async function alpacaReq(creds, method, pathName, body) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(alpacaBase(creds.paper) + pathName, {
      method, signal: ctrl.signal,
      headers: {
        'APCA-API-KEY-ID': creds.apiKey, 'APCA-API-SECRET-KEY': creds.apiSecret,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) { return { ok: false, status: 0, error: (e && e.message) || 'network error' }; }
  finally { clearTimeout(to); }
}
async function alpacaAccount(creds) { return alpacaReq(creds, 'GET', '/v2/account'); }

/* ============================================================
   TRADING ENDPOINTS
   ============================================================ */
// public-ish: the model's status + the symbol universe (everyone with the app sees this)
app.get('/api/trading/model', requireAuth, (req, res) => {
  const m = tradingModel();
  const cfg = tradingConfig();
  res.json({
    trainedSteps: m.trainedSteps || 0, examplesSeen: m.examplesSeen || 0,
    valAcc: m.valAcc, valLoss: m.valLoss, trainLoss: m.trainLoss, updated: m.updated || 0,
    classes: m.classes, featureVersion: m.featureVersion,
    symbols: cfg.symbols, dataReady: tradingSys.barsAll.all().filter(r => !r.symbol.includes('#')).length,
    disclaimer: cfg.disclaimer,
    // live-usability gate (admin reset/approve lifecycle)
    minRounds: TRADING_MIN_ROUNDS, approved: tradingModelApproved(),
    liveUsable: tradingModelUsable(m), blockReason: tradingModelBlockReason(m),
  });
});
// the account's full trading state (portfolio, positions, mode, live status) + recent log
app.get('/api/trading/state', requireAuth, (req, res) => {
  const d = tradingDoc(req.store);
  const state = tradingDocToApi(req.store, d);
  const log = req.store.tradingLogRecent(60).map(r => ({
    ts: r.ts, mode: r.mode, symbol: r.symbol, side: r.side, qty: r.qty, price: r.price, pnl: r.pnl, reason: r.reason,
  }));
  res.json({ ...state, log });
});
// what the model would do on the latest bar for each symbol — a "signals" preview
app.get('/api/trading/signals', requireAuth, (req, res) => {
  const m = tradingModel();
  const out = [];
  for (const sym of tradingSymbols()) {
    const bars = tradingBarsGet(sym); if (!bars) continue;
    const sig = TR.signalFromBars(m, bars, { threshold: TR.DEFAULT_THRESHOLD });
    out.push({ symbol: sym, price: bars[bars.length - 1].c, action: sig.action, confidence: sig.confidence, reason: sig.reason, probs: sig.probs });
  }
  res.json({ signals: out });
});
// sandbox: deposit virtual cash. On the FIRST deposit into an empty sandbox we
// immediately backtest the model over history so the user instantly sees what it
// would have done with that money (equity curve + trades + P&L), then it keeps
// simulating forward. Adding more cash later just tops up (re-run via /simulate).
app.post('/api/trading/sandbox/deposit', requireAuth, (req, res) => {
  const amt = Math.max(0, Math.min(1e9, Number((req.body || {}).amount) || 0));
  if (amt <= 0) return res.status(400).json({ error: 'enter an amount' });
  const d = tradingDoc(req.store);
  const wasEmpty = (d.sandbox.portfolio.cash <= 0) && !Object.keys(d.sandbox.portfolio.positions || {}).length;
  d.sandbox.portfolio.cash += amt;
  d.sandbox.deposited = (d.sandbox.deposited || 0) + amt;
  let simulated = false;
  if (wasEmpty) {
    try { simulated = runSandboxBacktest(req.store, d, tradingModel(), tradingSymbols()); } catch (e) { console.error('[simplex] sandbox backtest', e && e.message); }
  }
  if (!simulated) { TR.markToMarket(d.sandbox.portfolio, tradingPrices()); req.store.tradingSet(d); }
  res.json(tradingDocToApi(req.store, d));
});
// sandbox: (re)run the simulation over history with the CURRENT balance. Lets the user
// see an up-to-date track record after topping up or changing nothing — one click.
app.post('/api/trading/sandbox/simulate', requireAuth, (req, res) => {
  const d = tradingDoc(req.store);
  let ok = false;
  try { ok = runSandboxBacktest(req.store, d, tradingModel(), tradingSymbols()); } catch (e) { console.error('[simplex] sandbox simulate', e && e.message); }
  if (!ok) return res.status(400).json({ error: 'add some funds first, or wait for market data to load' });
  res.json(tradingDocToApi(req.store, d));
});
// sandbox: reset to flat (wipe portfolio + log)
app.post('/api/trading/sandbox/reset', requireAuth, (req, res) => {
  const d = tradingDoc(req.store);
  d.sandbox = { portfolio: TR.newPortfolio(0), deposited: 0, dayStartEquity: 0, dayStamp: '', lastSimBar: 0, stats: null };
  req.store.tradingSet(d);
  req.store.tradingLogClear();
  res.json(tradingDocToApi(req.store, d));
});
// flip auto-trading on/off (model keeps training globally; this just pauses MY trades)
app.post('/api/trading/autotrade', requireAuth, (req, res) => {
  const d = tradingDoc(req.store);
  d.autoTrade = !!(req.body || {}).on;
  req.store.tradingSet(d);
  res.json({ ok: true, autoTrade: d.autoTrade });
});
// switch mode sandbox <-> live (live requires master-enable + keys; never auto-on)
app.post('/api/trading/mode', requireAuth, (req, res) => {
  const mode = (req.body || {}).mode === 'live' ? 'live' : 'sandbox';
  const d = tradingDoc(req.store);
  if (mode === 'live') {
    if (!tradingLiveEnabled()) return res.status(403).json({ error: 'live trading is disabled on this server' });
    const block = tradingModelBlockReason();
    if (block) return res.status(403).json({ error: `the model isn't cleared for live trading yet — ${block}` });
    if (!(d.live.apiKey && d.live.apiSecret)) return res.status(400).json({ error: 'connect your brokerage keys first' });
    if (!d.live.enabled) return res.status(400).json({ error: 'enable live trading (opt in) first' });
  }
  d.mode = mode;
  req.store.tradingSet(d);
  res.json(tradingDocToApi(req.store, d));
});
// connect / clear the user's OWN Alpaca keys (stored only in their encrypted doc).
// Verifies the keys against Alpaca before saving so a bad key fails loudly here.
app.post('/api/trading/live/keys', requireAuth, async (req, res) => {
  const b = req.body || {};
  const d = tradingDoc(req.store);
  if (b.clear) {
    d.live.apiKey = ''; d.live.apiSecret = ''; d.live.enabled = false;
    if (d.mode === 'live') d.mode = 'sandbox';
    req.store.tradingSet(d);
    return res.json({ ok: true, keysSet: false });
  }
  const apiKey = String(b.apiKey || '').trim(), apiSecret = String(b.apiSecret || '').trim();
  const paper = b.paper !== false;
  if (!apiKey || !apiSecret) return res.status(400).json({ error: 'both key and secret are required' });
  const check = await alpacaAccount({ apiKey, apiSecret, paper });
  if (!check.ok) return res.status(400).json({ error: `brokerage rejected those keys (${check.status || 'no response'})` });
  d.live.apiKey = apiKey; d.live.apiSecret = apiSecret; d.live.paper = paper;
  req.store.tradingSet(d);
  res.json({ ok: true, keysSet: true, paper, account: check.json ? { status: check.json.status, cash: check.json.cash, equity: check.json.equity } : null });
});
// opt in / out of live trading (separate, explicit step from saving keys)
app.post('/api/trading/live/enable', requireAuth, (req, res) => {
  const on = !!(req.body || {}).on;
  const d = tradingDoc(req.store);
  if (on) {
    if (!tradingLiveEnabled()) return res.status(403).json({ error: 'live trading is disabled on this server' });
    const block = tradingModelBlockReason();
    if (block) return res.status(403).json({ error: `the model isn't cleared for live trading yet — ${block}` });
    if (!(d.live.apiKey && d.live.apiSecret)) return res.status(400).json({ error: 'connect your brokerage keys first' });
  }
  d.live.enabled = on; d.live.killed = false;
  if (!on && d.mode === 'live') d.mode = 'sandbox';
  req.store.tradingSet(d);
  res.json(tradingDocToApi(req.store, d));
});
// KILL SWITCH — halt all of MY trading immediately (live + sandbox auto-trade).
app.post('/api/trading/kill', requireAuth, (req, res) => {
  const d = tradingDoc(req.store);
  d.live.killed = true; d.autoTrade = false;
  req.store.tradingSet(d);
  res.json({ ok: true, killed: true });
});
app.delete('/api/trading/log', requireAuth, (req, res) => { req.store.tradingLogClear(); res.json({ ok: true }); });

// admin: configure the global symbol universe + live master switch + data source
app.get('/api/trading/admin/config', requireAdmin, (req, res) => {
  const cfg = tradingConfig();
  const m = tradingModelLoad();
  res.json({
    ...cfg,
    model: m ? { trainedSteps: m.trainedSteps || 0, valAcc: m.valAcc, updated: m.updated } : null,
    minRounds: TRADING_MIN_ROUNDS, approved: tradingModelApproved(),
    liveUsable: tradingModelUsable(m), blockReason: tradingModelBlockReason(m),
    cachedSymbols: tradingSys.barsAll.all().map(r => r.symbol).filter(s => !s.includes('#')),
  });
});
// admin: RESET the global model (when it's gone bad). Wipes it to a fresh untrained
// network and revokes live-usability until it's retrained AND re-approved.
app.post('/api/trading/admin/reset-model', requireAdmin, (req, res) => {
  const m = tradingModelReset();
  res.json({ ok: true, trainedSteps: m.trainedSteps || 0, approved: false, liveUsable: false, blockReason: tradingModelBlockReason(m) });
});
// admin: mark the model "usable" (approved for live). Only allowed once it has at
// least the minimum training rounds — you can't approve a barely-trained model.
app.post('/api/trading/admin/approve-model', requireAdmin, (req, res) => {
  const approve = (req.body || {}).approved !== false;   // default true; pass {approved:false} to revoke
  const m = tradingModelLoad();
  const rounds = (m && m.trainedSteps) || 0;
  if (approve && rounds < TRADING_MIN_ROUNDS) {
    return res.status(400).json({ error: `model has only ${rounds}/${TRADING_MIN_ROUNDS} training rounds — let it train more before approving` });
  }
  setSetting('trading.model_approved', approve ? '1' : '0');
  res.json({ ok: true, approved: approve, liveUsable: tradingModelUsable(m), blockReason: tradingModelBlockReason(m) });
});
app.put('/api/trading/admin/config', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (b.symbols !== undefined) {
    const list = String(b.symbols).split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 25);
    setSetting('trading.symbols', list.join(','));
  }
  if (b.liveEnabled !== undefined) setSetting('trading.live_enabled', b.liveEnabled ? '1' : '0');
  if (b.dataSource !== undefined) setSetting('trading.data_source', String(b.dataSource));
  res.json(tradingConfig());
});
// admin: force an immediate data refresh + a training burst (handy for first setup)
app.post('/api/trading/admin/kick', requireAdmin, async (req, res) => {
  await tradingDataTick(true);
  tradingTrainTick();
  const m = tradingModelLoad();
  res.json({ ok: true, dataReady: tradingSys.barsAll.all().filter(r => !r.symbol.includes('#')).length, model: m ? { trainedSteps: m.trainedSteps, valAcc: m.valAcc } : null });
});

/* ============================================================
   MUSIC

   A global shared library every member sees, public/private playlists, and live
   "jam" sessions where people listen together in sync. See the music_* tables and
   `musicStore` near the top of this file for the data model. The defining property:
   adding a song COPIES its bytes into musicStore (re-encrypted with the __music__
   keyset), so playback works for everyone and is independent of the owner's vault.
   ============================================================ */

/* track row -> API shape (metadata + stream urls; matches the audio file shape the
   client Player already understands: { type:'audio', name, url, coverUrl, dur, ... }). */
function musicTrackToApi(t) {
  if (!t) return null;
  return {
    id: t.id, type: 'audio',
    name: t.title, title: t.title, artist: t.artist || null, album: t.album || null,
    dur: t.duration || null, size: t.size || 0, ext: t.ext || '',
    ownerId: t.owner_id, ownerName: t.owner_name, created: t.created,
    url: `/api/music/tracks/${t.id}/raw`,
    coverUrl: t.has_cover ? `/api/music/tracks/${t.id}/cover` : null,
  };
}
function musicPlaylistEditors(p) { try { const a = JSON.parse(p.editors || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function musicPlaylistToApi(p, count, req) {
  const editorIds = musicPlaylistEditors(p);
  return {
    id: p.id, name: p.name, public: !!p.public,
    ownerId: p.owner_id, ownerName: p.owner_name,
    created: p.created, updated: p.updated,
    count: count != null ? count : musicSys.pliList.all(p.id).length,
    editors: editorIds.map(id => { const a = sysStmt.getAcct.get(id); return { id, name: a ? (a.display || a.username) : 'Unknown' }; }),
    canManage: req ? musicCanManage(req, p.owner_id) : undefined,   // owner/admin: rename, delete, editors
    canEdit: req ? musicCanEdit(req, p) : undefined,                 // + trusted editors: add/remove/reorder tracks
  };
}
/* OWNER/admin only — rename, delete, change visibility, manage editors. */
function musicCanManage(req, ownerId) { return req.accountId === ownerId || !!req.account.is_admin; }
/* owner/admin OR a trusted editor — add/remove/reorder tracks in the playlist. */
function musicCanEdit(req, p) { return musicCanManage(req, p.owner_id) || musicPlaylistEditors(p).includes(req.accountId); }
/* a playlist the caller may SEE: public, owned, editor, or admin. */
function musicCanSee(req, p) { return !!p.public || p.owner_id === req.accountId || !!req.account.is_admin || musicPlaylistEditors(p).includes(req.accountId); }

/* decrypt the owner's encrypted blob to a plaintext temp file AND compute the sha256
   of those bytes in the SAME streamed pass (no extra read). Fully async/streamed — a
   multi-MB sync read+hash here would block the single event-loop thread (the documented
   copy-bug freeze). Resolves the hex digest. */
function decryptBlobToFileHashed(encPath, keys, destPath) {
  return new Promise((resolve, reject) => {
    const dec = vault.decryptBlobRange(encPath, keys, null, null);
    if (!dec) return reject(new Error('cannot read blob'));
    const hash = crypto.createHash('sha256');
    const tap = new (require('stream').Transform)({
      transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); },
    });
    const out = fs.createWriteStream(destPath);
    pipeline(dec.stream, tap, out, (err) => err ? reject(err) : resolve(hash.digest('hex')));
  });
}

const MUSIC_AUDIO_EXTS = new Set(['mp3', 'flac', 'wav', 'm4a', 'ogg', 'aac', 'opus', 'wma']);

/* ---- add a vault audio file to the shared library (the COPY flow) ---- */
app.post('/api/music/tracks', requireAuth, async (req, res) => {
  const store = req.store;
  const row = store.getById(String((req.body || {}).fileId || ''));
  if (!row || row.trashed) return res.status(404).json({ error: 'file not found' });
  if (row.type !== 'audio') return res.status(400).json({ error: 'not an audio file' });
  if (!row.hasBlob) return res.status(400).json({ error: 'file has no contents' });
  // locked files are wrapped with a per-item passphrase key the backend doesn't hold,
  // so we can't decrypt them to copy (same exclusion as ggufFiles/the organizer).
  if (row.locked) return res.status(400).json({ error: 'unlock this file before adding it to Music' });

  const id = uid();
  const tmp = path.join(musicStore.tmpDir, id + '.tmp');
  const coverTmp = path.join(musicStore.tmpDir, id + '.cover.tmp');
  try {
    const hash = await decryptBlobToFileHashed(store.blobPath(row), store.keys, tmp);

    // GLOBAL dedup: same plaintext bytes already in the library -> reuse, don't re-store.
    const dup = musicSys.trackByHash.get(hash);
    if (dup) { try { await fsp.unlink(tmp); } catch (e) {} return res.json({ duplicate: true, track: musicTrackToApi(dup) }); }

    await vault.encryptBlob(tmp, musicStore.blobPath({ id }), musicStore.keys);

    let hasCover = 0, coverExt = null;
    if (row.hasCover) {
      try {
        await decryptBlobToFile(store.coverPath(row), store.keys, coverTmp);
        await vault.encryptBlob(coverTmp, musicStore.coverPath({ id }), musicStore.keys);
        hasCover = 1; coverExt = row.coverExt || 'jpg';
      } catch (e) { hasCover = 0; coverExt = null; }   // cover is best-effort
    }

    const name = store.decName(row);
    const title = clip(name.replace(/\.[^.]+$/, ''), 200) || 'Untitled';
    const artist = row.artist ? clip(vault.decText(row.artist, store.keys), 200) : null;
    const album = row.album ? clip(vault.decText(row.album, store.keys), 200) : null;
    const ext = (row.storedExt || path.extname(name).slice(1) || 'mp3').toLowerCase();

    musicSys.trackIns.run({
      id, owner_id: req.accountId, owner_name: clip(req.account.display || req.account.username, 80),
      title, artist, album, duration: row.dur != null ? Number(row.dur) : null,
      size: row.size || 0, ext, hash, has_cover: hasCover, cover_ext: coverExt, created: Date.now(),
    });
    res.json({ track: musicTrackToApi(musicSys.trackGet.get(id)) });
  } catch (e) {
    console.error('[simplex] music add failed', e && (e.stack || e.message || e));
    try { await fsp.unlink(musicStore.blobPath({ id })); } catch (_) {}
    try { await fsp.unlink(musicStore.coverPath({ id })); } catch (_) {}
    res.status(500).json({ error: 'could not add to Music' });
  } finally {
    try { await fsp.unlink(tmp); } catch (e) {}
    try { await fsp.unlink(coverTmp); } catch (e) {}
  }
});

/* ---- streaming quality tiers (?q=low|medium|high) ----
   No `?q` (or q=lossless) streams the ORIGINAL bytes untouched — bit-perfect, the
   default. The lossy tiers are AAC/M4A transcodes generated once per track+tier
   with ffmpeg, cached encrypted-at-rest exactly like the low-res covers, then
   served with full Range/206 support. A source whose own bitrate is already
   at/below a tier's target is served as-is: re-encoding an already-lossy file
   can only lose quality, never gain it. */
const MUSIC_QUALITY_KBPS = { low: 96, medium: 160, high: 256 };
const _audioQInflight = new Map();          // `${trackId}:${q}` -> Promise (de-dupe concurrent requests)
async function _generateMusicAudioQ(t, q) {
  if (!(await ffmpegAvailable())) return false;
  const jobDir = path.join(TOOLS_DIR, 'aq' + crypto.randomBytes(6).toString('hex'));
  const inP = path.join(jobDir, 'in.' + (String(t.ext || 'mp3').replace(/^\./, '') || 'mp3'));
  const outP = path.join(jobDir, 'out.m4a');
  try {
    await fsp.mkdir(jobDir, { recursive: true });
    await decryptBlobToFile(musicStore.blobPath({ id: t.id }), musicStore.keys, inP);
    const args = ['-i', inP, '-vn', '-c:a', 'aac', '-b:a', MUSIC_QUALITY_KBPS[q] + 'k', '-movflags', '+faststart', '-y', outP];
    const ok = await new Promise((resolve) => {
      const child = spawn(FFMPEG, args, { windowsHide: true });
      const timer = setTimeout(() => { try { killTree(child); } catch (e) {} resolve(false); }, 180_000);
      child.on('error', () => { clearTimeout(timer); resolve(false); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    });
    let stat = null; if (ok) { try { stat = await fsp.stat(outP); } catch (e) {} }
    if (!stat || !stat.size) return false;
    await vault.encryptBlob(outP, musicStore.audioQPath({ id: t.id, q }), musicStore.keys);
    return true;
  } catch (e) {
    console.warn('[simplex] audio quality transcode failed for', t.id, q, e && e.message);
    return false;
  } finally { try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {} }
}

/* ---- stream a shared track's audio / cover (any signed-in member) ---- */
app.get('/api/music/tracks/:id/raw', requireAuth, async (req, res) => {
  const t = musicSys.trackGet.get(req.params.id);
  if (!t) return res.status(404).end();
  const q = String(req.query.q || '').toLowerCase();
  if (MUSIC_QUALITY_KBPS[q]) {
    // skip the transcode when the original is already at/below this tier's bitrate
    const srcKbps = (t.size && t.duration) ? (t.size * 8) / (t.duration * 1000) : null;
    if (srcKbps == null || srcKbps > MUSIC_QUALITY_KBPS[q] * 1.15) {
      if (!fs.existsSync(musicStore.audioQPath({ id: t.id, q }))) {
        const key = t.id + ':' + q;
        let job = _audioQInflight.get(key);
        if (!job) {
          // one transcode per track+tier; shares the poster ffmpeg slots so total
          // transcode pressure stays capped (queues, never rejects).
          job = (async () => {
            await _acquirePosterSlot();
            try { return await _generateMusicAudioQ(t, q); }
            finally { _releasePosterSlot(); _audioQInflight.delete(key); }
          })();
          _audioQInflight.set(key, job);
        }
        await job;
      }
      if (res.writableEnded || res.destroyed) return;             // client navigated away
      if (fs.existsSync(musicStore.audioQPath({ id: t.id, q }))) {
        return streamEncrypted(req, res, musicStore, { id: t.id, q, hasAudioQ: 1 }, 'audioq');
      }
      // ffmpeg missing/failed -> fall through to the original (degraded, not broken)
    }
  }
  streamEncrypted(req, res, musicStore, { id: t.id, hasBlob: 1, storedExt: t.ext }, 'blob');
});

/* ---- low-res cover variant (?lo=1) ----
   The Music tab loads every visible cover; on a slow link that competes with the
   audio itself. `?lo=1` serves a tiny (~64px) JPEG instead — generated once with
   ffmpeg from the full cover, cached encrypted-at-rest exactly like a video
   poster, then served from cache forever (a track's cover never changes after
   copy-on-add). If ffmpeg is missing or fails, we fall back to the full cover. */
const MUSIC_COVER_SM_W = 64;
const _coverSmInflight = new Map();          // track id -> Promise (de-dupe concurrent requests)
async function _generateMusicCoverSm(t) {
  if (!(await ffmpegAvailable())) return false;
  const jobDir = path.join(TOOLS_DIR, 'cs' + crypto.randomBytes(6).toString('hex'));
  const inP = path.join(jobDir, 'in.' + (t.cover_ext || 'jpg'));
  const outP = path.join(jobDir, 'out.jpg');
  try {
    await fsp.mkdir(jobDir, { recursive: true });
    await decryptBlobToFile(musicStore.coverPath({ id: t.id }), musicStore.keys, inP);
    const args = ['-i', inP, '-frames:v', '1', '-vf', `scale=${MUSIC_COVER_SM_W}:-2`, '-q:v', '7', '-y', outP];
    const ok = await new Promise((resolve) => {
      const child = spawn(FFMPEG, args, { windowsHide: true });
      const timer = setTimeout(() => { try { killTree(child); } catch (e) {} resolve(false); }, 20_000);
      child.on('error', () => { clearTimeout(timer); resolve(false); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    });
    let stat = null; if (ok) { try { stat = await fsp.stat(outP); } catch (e) {} }
    if (!stat || !stat.size) return false;
    await vault.encryptBlob(outP, musicStore.coverSmPath({ id: t.id }), musicStore.keys);
    return true;
  } catch (e) {
    console.warn('[simplex] low-res cover generation failed for', t.id, e && e.message);
    return false;
  } finally { try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {} }
}

app.get('/api/music/tracks/:id/cover', requireAuth, async (req, res) => {
  const t = musicSys.trackGet.get(req.params.id);
  if (!t || !t.has_cover) return res.status(404).end();
  // immutable per track id (dedup + copy-on-add) — let the browser cache it so
  // re-rendering the library / now-playing doesn't refetch artwork.
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (req.query.lo == null) return streamEncrypted(req, res, musicStore, { id: t.id, hasCover: 1, coverExt: t.cover_ext }, 'cover');

  if (!fs.existsSync(musicStore.coverSmPath({ id: t.id }))) {
    let job = _coverSmInflight.get(t.id);
    if (!job) {
      // one generation per track; shares the poster ffmpeg slots so total transcode
      // pressure stays capped (queues, never rejects — an <img> can't retry a 503).
      job = (async () => {
        await _acquirePosterSlot();
        try { return await _generateMusicCoverSm(t); }
        finally { _releasePosterSlot(); _coverSmInflight.delete(t.id); }
      })();
      _coverSmInflight.set(t.id, job);
    }
    await job;
  }
  if (res.writableEnded || res.destroyed) return;             // client navigated away
  if (fs.existsSync(musicStore.coverSmPath({ id: t.id }))) {
    return streamEncrypted(req, res, musicStore, { id: t.id, hasCoverSm: 1 }, 'coversm');
  }
  return streamEncrypted(req, res, musicStore, { id: t.id, hasCover: 1, coverExt: t.cover_ext }, 'cover');
});

/* ---- list the whole library ---- */
app.get('/api/music/tracks', requireAuth, (req, res) => {
  res.json({ tracks: musicSys.trackList.all().map(musicTrackToApi) });
});

/* ---- remove a track (uploader or admin); its bytes are gone for everyone ---- */
app.delete('/api/music/tracks/:id', requireAuth, (req, res) => {
  const t = musicSys.trackGet.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (!musicCanManage(req, t.owner_id)) return res.status(403).json({ error: 'only the uploader or an admin can remove this' });
  musicSys.pliDelTrackEverywhere.run(t.id);
  musicSys.reportDelForTrack.run(t.id);          // drop any reports about it
  musicSys.trackDel.run(t.id);
  try { fs.unlinkSync(musicStore.blobPath({ id: t.id })); } catch (e) {}
  for (const q of Object.keys(MUSIC_QUALITY_KBPS)) { try { fs.unlinkSync(musicStore.audioQPath({ id: t.id, q })); } catch (e) {} }   // cached lossy tiers
  if (t.has_cover) {
    try { fs.unlinkSync(musicStore.coverPath({ id: t.id })); } catch (e) {}
    try { fs.unlinkSync(musicStore.coverSmPath({ id: t.id })); } catch (e) {}
  }
  res.json({ ok: true });
});

/* ---- save a shared track into YOUR vault (the reverse of copy-on-add) ----
   Decrypts the track from the shared __music__ store and re-encrypts it (plus its
   cover) into the caller's own vault as a normal audio file, in whatever folder
   they picked. Quota-checked like any upload; the library copy is untouched. */
app.post('/api/music/tracks/:id/save', requireAuth, async (req, res) => {
  const t = musicSys.trackGet.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const store = req.store, quota = req.account.quota_bytes;
  if (store.usedBytes() + (t.size || 0) > quota) return limitError(res, store, quota);
  const parent = normParent((req.body || {}).parent);
  if (parent != null) {
    const p = store.getById(parent);
    if (!p || p.type !== 'folder' || p.trashed) return res.status(400).json({ error: 'destination folder not found' });
  }
  const id = uid();
  const tmp = path.join(store.tmpDir, 'ms' + crypto.randomBytes(6).toString('hex') + '.tmp');
  const coverTmp = tmp + '.cover';
  try {
    await decryptBlobToFile(musicStore.blobPath({ id: t.id }), musicStore.keys, tmp);
    const size = (await fsp.stat(tmp)).size;
    await vault.encryptBlob(tmp, store.blobPath({ id }), store.keys);

    let hasCover = 0, coverExt = null;
    if (t.has_cover) {
      try {
        await decryptBlobToFile(musicStore.coverPath({ id: t.id }), musicStore.keys, coverTmp);
        await vault.encryptBlob(coverTmp, store.coverPath({ id }), store.keys);
        hasCover = 1; coverExt = t.cover_ext || 'jpg';
      } catch (e) { hasCover = 0; coverExt = null; }   // cover is best-effort
    }

    const ext = String(t.ext || 'mp3').replace(/^\./, '').toLowerCase() || 'mp3';
    store.insertRow({
      id, name: `${t.title || 'Untitled'}.${ext}`, type: 'audio', parent,
      size, date: Date.now(), dur: t.duration || null,
      artist: t.artist || null, album: t.album || null,
      hasBlob: 1, storedExt: '.' + ext, hasCover, coverExt,
    });
    store.bump();
    invalidatePollCache(req.accountId);
    logAnalytics(store, 'upload', { kind: 'audio' });
    res.json({ file: rowToApi(store.getById(id), store) });
  } catch (e) {
    console.error('[simplex] music save-to-vault failed', e && (e.stack || e.message || e));
    try { fs.unlinkSync(store.blobPath({ id })); } catch (_) {}
    try { fs.unlinkSync(store.coverPath({ id })); } catch (_) {}
    res.status(500).json({ error: 'could not save to vault' });
  } finally {
    try { await fsp.unlink(tmp); } catch (e) {}
    try { await fsp.unlink(coverTmp); } catch (e) {}
  }
});

/* ============ Playlists ============ */

/* ---- list playlists visible to the caller (public + own + ones you edit) ---- */
app.get('/api/music/playlists', requireAuth, (req, res) => {
  const rows = musicSys.plListVisible.all({ me: req.accountId, like: '%"' + req.accountId + '"%' });
  res.json({ playlists: rows.map(p => musicPlaylistToApi(p, null, req)) });
});

/* ---- create a playlist ---- */
app.post('/api/music/playlists', requireAuth, (req, res) => {
  const b = req.body || {};
  const name = clip(b.name, 120).trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const now = Date.now(), id = uid();
  musicSys.plIns.run({
    id, owner_id: req.accountId, owner_name: clip(req.account.display || req.account.username, 80),
    name, public: b.public === false ? 0 : 1, editors: null, created: now, updated: now,
  });
  res.json({ playlist: musicPlaylistToApi(musicSys.plGet.get(id), null, req) });
});

/* ---- members list (id + display name) so an owner can pick Trusted Editors. Not
   admin-only — it exposes only display names, no sensitive account data. ---- */
app.get('/api/music/members', requireAuth, (req, res) => {
  res.json({ members: sysStmt.listAccts.all().map(a => ({ id: a.id, name: a.display || a.username, isAdmin: !!a.is_admin })) });
});

/* resolve a playlist the caller is allowed to SEE (public/own/editor/admin). null if hidden. */
function musicVisiblePlaylist(req, id) {
  const p = musicSys.plGet.get(id);
  if (!p || !musicCanSee(req, p)) return null;
  return p;
}

/* ---- one playlist + its tracks (in stored order) ---- */
app.get('/api/music/playlists/:id', requireAuth, (req, res) => {
  const p = musicVisiblePlaylist(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const tracks = musicSys.pliList.all(p.id)
    .map(it => musicSys.trackGet.get(it.track_id))
    .filter(Boolean)
    .map(musicTrackToApi);
  const out = musicPlaylistToApi(p, tracks.length, req);
  // duration stats: total seconds across all songs, and the mean song length
  const durs = tracks.map(t => Number(t.dur) || 0);
  out.totalDuration = durs.reduce((s, d) => s + d, 0);
  out.avgDuration = durs.length ? out.totalDuration / durs.length : 0;
  res.json({ playlist: out, tracks });
});

/* ---- rename / change visibility (owner or admin) ---- */
app.patch('/api/music/playlists/:id', requireAuth, (req, res) => {
  const p = musicSys.plGet.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!musicCanManage(req, p.owner_id)) return res.status(403).json({ error: 'not allowed' });
  const b = req.body || {};
  const name = b.name != null ? (clip(b.name, 120).trim() || p.name) : p.name;
  const pub = b.public != null ? (b.public ? 1 : 0) : p.public;
  musicSys.plUpd.run({ id: p.id, name, public: pub, updated: Date.now() });
  res.json({ playlist: musicPlaylistToApi(musicSys.plGet.get(p.id), null, req) });
});

/* ---- set the Trusted Editors (owner or admin); body { editorIds: [...] } ---- */
app.put('/api/music/playlists/:id/editors', requireAuth, (req, res) => {
  const p = musicSys.plGet.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!musicCanManage(req, p.owner_id)) return res.status(403).json({ error: 'not allowed' });
  let ids = Array.isArray((req.body || {}).editorIds) ? req.body.editorIds.map(String) : [];
  // keep only real accounts, drop the owner (always an editor implicitly), dedupe, cap
  ids = [...new Set(ids)].filter(id => id !== p.owner_id && sysStmt.getAcct.get(id)).slice(0, 50);
  const before = new Set(musicPlaylistEditors(p));
  const after = new Set(ids);
  musicSys.plSetEditors.run({ id: p.id, editors: JSON.stringify(ids), updated: Date.now() });
  // notify people who gained/lost edit access (skip the actor changing their own — N/A here)
  const who = req.account.display || req.account.username;
  for (const id of after) if (!before.has(id)) notifyAccount(id, { type: 'info', title: 'You can now edit a playlist', body: `${who} added you as an editor of “${p.name}”. You can add and remove songs.`, meta: { app: 'music', playlist: p.id } });
  for (const id of before) if (!after.has(id)) notifyAccount(id, { type: 'info', title: 'Playlist edit access removed', body: `${who} removed you as an editor of “${p.name}”.`, meta: { app: 'music' } });
  res.json({ playlist: musicPlaylistToApi(musicSys.plGet.get(p.id), null, req) });
});

/* ---- delete a playlist (owner or admin) ---- */
app.delete('/api/music/playlists/:id', requireAuth, (req, res) => {
  const p = musicSys.plGet.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!musicCanManage(req, p.owner_id)) return res.status(403).json({ error: 'not allowed' });
  musicSys.pliDelAll.run(p.id);
  musicSys.plDel.run(p.id);
  res.json({ ok: true });
});

/* ---- add a track to a playlist (owner/admin/editor; appended to the end) ---- */
app.post('/api/music/playlists/:id/items', requireAuth, (req, res) => {
  const p = musicSys.plGet.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!musicCanEdit(req, p)) return res.status(403).json({ error: 'not allowed' });
  const trackId = String((req.body || {}).trackId || '');
  if (!musicSys.trackGet.get(trackId)) return res.status(404).json({ error: 'track not found' });
  const pos = (musicSys.pliMaxPos.get(p.id).m || -1) + 1;
  musicSys.pliIns.run({ playlist_id: p.id, track_id: trackId, pos });
  musicSys.plTouch.run({ id: p.id, updated: Date.now() });
  res.json({ ok: true });
});

/* ---- remove a track from a playlist (owner/admin/editor) ---- */
app.delete('/api/music/playlists/:id/items/:trackId', requireAuth, (req, res) => {
  const p = musicSys.plGet.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!musicCanEdit(req, p)) return res.status(403).json({ error: 'not allowed' });
  musicSys.pliDelTrack.run(p.id, req.params.trackId);
  musicSys.plTouch.run({ id: p.id, updated: Date.now() });
  res.json({ ok: true });
});

/* ---- reorder a playlist (owner/admin/editor); body { trackIds: [...] } new order ---- */
app.put('/api/music/playlists/:id/order', requireAuth, (req, res) => {
  const p = musicSys.plGet.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!musicCanEdit(req, p)) return res.status(403).json({ error: 'not allowed' });
  const want = Array.isArray((req.body || {}).trackIds) ? req.body.trackIds.map(String) : [];
  const have = new Set(musicSys.pliList.all(p.id).map(it => it.track_id));
  const reorder = sys.transaction((ids) => {
    let pos = 0;
    for (const tid of ids) if (have.has(tid)) musicSys.pliSetPos.run({ playlist_id: p.id, track_id: tid, pos: pos++ });
  });
  reorder(want);
  musicSys.plTouch.run({ id: p.id, updated: Date.now() });
  res.json({ ok: true });
});

/* ---- Today's Spotlight: 3 random tracks the SERVER picks, stable until the next
   local midnight, then it re-rolls. Stored in music_meta as { date, ids }. ---- */
function musicTodayKey() {
  const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function musicSpotlightIds() {
  const today = musicTodayKey();
  let saved = null;
  try { saved = JSON.parse(musicSys.metaGet.get('spotlight')?.value || 'null'); } catch (e) {}
  // valid only if it's for today AND every picked track still exists
  if (saved && saved.date === today && Array.isArray(saved.ids) && saved.ids.length && saved.ids.every(id => musicSys.trackGet.get(id))) {
    return saved.ids;
  }
  const all = musicSys.trackList.all();
  const pool = all.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const ids = pool.slice(0, 3).map(t => t.id);
  musicSys.metaSet.run({ k: 'spotlight', v: JSON.stringify({ date: today, ids }) });
  return ids;
}
app.get('/api/music/spotlight', requireAuth, (req, res) => {
  const ids = musicSpotlightIds();
  res.json({ tracks: ids.map(id => musicTrackToApi(musicSys.trackGet.get(id))).filter(Boolean) });
});

/* ============ Song reports ============
   Any member can flag a library song (reason 'duplicate' | 'other', + a detail note).
   Admins triage open reports in the Music app's Reports tab: resolve or dismiss. */
const MUSIC_REPORT_REASONS = ['duplicate', 'other'];
function musicReportToApi(r) {
  return { id: r.id, trackId: r.track_id, trackTitle: r.track_title, reporter: r.reporter_name, reason: r.reason, detail: r.detail || '', status: r.status, created: r.created };
}
app.post('/api/music/reports', requireAuth, (req, res) => {
  const b = req.body || {};
  const t = musicSys.trackGet.get(String(b.trackId || ''));
  if (!t) return res.status(404).json({ error: 'track not found' });
  const reason = MUSIC_REPORT_REASONS.includes(b.reason) ? b.reason : 'other';
  // one open report per (track, reporter): re-reporting updates the note instead of piling up
  const existing = musicSys.reportMineOpenForTrack.get(t.id, req.accountId);
  const detail = clip(b.detail, 1000);
  if (existing) {
    sys.prepare('UPDATE music_reports SET reason=@reason, detail=@detail, created=@created WHERE id=@id')
       .run({ id: existing.id, reason, detail, created: Date.now() });
    return res.json({ ok: true, id: existing.id, updated: true });
  }
  const id = 'mr' + crypto.randomBytes(6).toString('hex');
  musicSys.reportIns.run({
    id, track_id: t.id, track_title: t.title,
    reporter_id: req.accountId, reporter_name: clip(req.account.display || req.account.username, 80),
    reason, detail, created: Date.now(),
  });
  res.json({ ok: true, id });
});
app.get('/api/music/reports', requireAdmin, (req, res) => {
  res.json({ reports: musicSys.reportListOpen.all().map(musicReportToApi), open: musicSys.reportCountOpen.get().n });
});
// lightweight count so the client can show/hide the Reports tab (admins only)
app.get('/api/music/reports/count', requireAuth, (req, res) => {
  res.json({ open: req.account.is_admin ? musicSys.reportCountOpen.get().n : 0 });
});
app.patch('/api/music/reports/:id', requireAdmin, (req, res) => {
  const r = musicSys.reportGet.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const status = ((req.body || {}).status === 'resolved') ? 'resolved' : 'dismissed';
  musicSys.reportSetStatus.run({ id: r.id, status });
  res.json({ ok: true, open: musicSys.reportCountOpen.get().n });
});

/* ============ Jam sessions (listen together, synced ~1s) ============

   The jam STATE (stored as JSON in music_jams.state) is the single source of truth
   for playback. `queue` is the ORIGINAL track order and is never reordered; `order`
   is a permutation index into it (shuffle reshuffles `order`, leaving `queue` and the
   source playlist untouched). Current track = queue[order[idx]]. `version` increments
   on every control change; controls send the version they saw and a stale one is
   rejected (409) so concurrent controllers can't silently clobber each other. */

const JAM_MEMBER_TTL = 6000;       // a member is "present" if seen within this window

function jamFreshState({ id, hostId, name, queue }) {
  const q = (Array.isArray(queue) ? queue : []).map(String).filter(t => musicSys.trackGet.get(t));
  return {
    id, hostId, name: name || null,
    queue: q, order: q.map((_, i) => i), shuffle: false, loop: false,
    idx: 0, posSec: 0, paused: false, serverTs: Date.now(), version: 1,
  };
}
function jamLoadState(jam) { try { return JSON.parse(jam.state); } catch (e) { return null; } }
function jamSaveState(id, st) {
  st.serverTs = Date.now(); st.version = (st.version || 0) + 1;
  musicSys.jamSet.run({ id, state: JSON.stringify(st), version: st.version, updated: Date.now() });
  return st;
}
// Fisher–Yates over a copy of the index array.
function shuffleOrder(n) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
/* full jam payload for the client: state + live members + host name + server clock. */
function jamPayload(jam, st) {
  const members = musicSys.jmList.all(jam.id);
  const host = members.find(m => m.account_id === jam.host_id);
  return {
    ...st, hostId: jam.host_id,
    hostName: host ? host.name : null,
    members: members.map(m => ({ name: m.name })),
    now: Date.now(),
  };
}
/* remove stale members; transfer host if the host went stale; delete empty jams.
   Returns the (possibly updated) jam row, or null if the jam was deleted. */
function jamReap(jam) {
  musicSys.jmPrune.run(Date.now() - JAM_MEMBER_TTL);
  if (musicSys.jmCount.get(jam.id).n === 0) { musicSys.jamDel.run(jam.id); musicSys.jmDelAll.run(jam.id); return null; }
  const fresh = musicSys.jamGet.get(jam.id);
  if (fresh && !musicSys.jmList.all(fresh.id).some(m => m.account_id === fresh.host_id)) {
    const next = musicSys.jmOldest.get(fresh.id);
    if (next) { musicSys.jamSetHost.run({ id: fresh.id, host_id: next.account_id, updated: Date.now() }); return musicSys.jamGet.get(fresh.id); }
  }
  return fresh;
}

/* ---- list live jams (for a "join" UI) ---- */
app.get('/api/music/jams', requireAuth, (req, res) => {
  musicSys.jmPrune.run(Date.now() - JAM_MEMBER_TTL);
  const jams = musicSys.jamList.all().map(j => {
    const members = musicSys.jmList.all(j.id);
    if (!members.length) return null;
    const st = jamLoadState(j);
    const host = members.find(m => m.account_id === j.host_id);
    const cur = st && st.queue.length ? musicSys.trackGet.get(st.queue[st.order[st.idx]]) : null;
    return { id: j.id, name: j.name, hostName: host ? host.name : null, listeners: members.length, nowPlaying: cur ? cur.title : null };
  }).filter(Boolean);
  res.json({ jams });
});

/* ---- start a jam from the caller's current queue ---- */
app.post('/api/music/jam', requireAuth, (req, res) => {
  const b = req.body || {};
  // a member hosts at most one jam: replace any existing one they host.
  const existing = musicSys.jamByHost.get(req.accountId);
  if (existing) { musicSys.jamDel.run(existing.id); musicSys.jmDelAll.run(existing.id); }
  const id = uid();
  const name = clip(b.name, 80).trim() || ((req.account.display || req.account.username) + "'s jam");
  const st = jamFreshState({ id, hostId: req.accountId, name, queue: b.queue });
  const now = Date.now();
  musicSys.jamIns.run({ id, host_id: req.accountId, name, state: JSON.stringify(st), version: st.version, created: now, updated: now });
  musicSys.jmUpsert.run({ jam_id: id, account_id: req.accountId, name: clip(req.account.display || req.account.username, 80), now });
  res.json(jamPayload(musicSys.jamGet.get(id), st));
});

/* ---- join a jam; returns current state so the joiner snaps to it ---- */
app.post('/api/music/jam/:id/join', requireAuth, (req, res) => {
  const jam = musicSys.jamGet.get(req.params.id);
  if (!jam) return res.status(404).json({ error: 'jam not found' });
  musicSys.jmUpsert.run({ jam_id: jam.id, account_id: req.accountId, name: clip(req.account.display || req.account.username, 80), now: Date.now() });
  res.json(jamPayload(jam, jamLoadState(jam)));
});

/* ---- leave a jam (host role transfers to the oldest remaining member) ---- */
app.post('/api/music/jam/:id/leave', requireAuth, (req, res) => {
  const jam = musicSys.jamGet.get(req.params.id);
  if (!jam) return res.json({ ok: true });
  musicSys.jmDel.run(jam.id, req.accountId);
  if (musicSys.jmCount.get(jam.id).n === 0) { musicSys.jamDel.run(jam.id); musicSys.jmDelAll.run(jam.id); return res.json({ ok: true, ended: true }); }
  if (jam.host_id === req.accountId) {
    const next = musicSys.jmOldest.get(jam.id);
    if (next) musicSys.jamSetHost.run({ id: jam.id, host_id: next.account_id, updated: Date.now() });
  }
  res.json({ ok: true });
});

/* ---- poll jam state (~1s). Doubles as the member heartbeat + stale-member reaper. ---- */
app.get('/api/music/jam/:id/state', requireAuth, (req, res) => {
  let jam = musicSys.jamGet.get(req.params.id);
  if (!jam) return res.status(404).json({ error: 'jam ended' });
  musicSys.jmTouch.run({ jam_id: jam.id, account_id: req.accountId, now: Date.now() });
  jam = jamReap(jam);
  if (!jam) return res.status(404).json({ error: 'jam ended' });
  res.json(jamPayload(jam, jamLoadState(jam)));
});

/* ---- control playback (anyone in the jam). Body { version, patch }. ----
   Stale version -> 409 + fresh state (the client re-applies still-valid intents). */
app.post('/api/music/jam/:id/control', requireAuth, (req, res) => {
  const jam = musicSys.jamGet.get(req.params.id);
  if (!jam) return res.status(404).json({ error: 'jam ended' });
  // must be a participant
  if (!musicSys.jmList.all(jam.id).some(m => m.account_id === req.accountId)) return res.status(403).json({ error: 'join the jam first' });
  musicSys.jmTouch.run({ jam_id: jam.id, account_id: req.accountId, now: Date.now() });

  const st = jamLoadState(jam);
  const b = req.body || {};
  if (b.version != null && Number(b.version) !== st.version) {
    return res.status(409).json(jamPayload(jam, st));   // someone else moved first
  }
  const patch = b.patch || {};
  const n = st.order.length;

  if (patch.shuffle != null && !!patch.shuffle !== st.shuffle) {
    const curQ = n ? st.order[st.idx] : 0;          // remember the queue index playing now
    if (patch.shuffle) { st.order = shuffleOrder(n); }
    else { st.order = st.queue.map((_, i) => i); }
    st.shuffle = !!patch.shuffle;
    st.idx = Math.max(0, st.order.indexOf(curQ));    // keep the same track current
  }
  if (patch.reshuffle && st.shuffle && n) {
    const curQ = st.order[st.idx];
    st.order = shuffleOrder(n);
    st.idx = Math.max(0, st.order.indexOf(curQ));
  }
  if (patch.loop != null) st.loop = !!patch.loop;
  if (patch.advance === 'next' && n) {
    if (st.idx + 1 >= n) { if (st.loop) { st.idx = 0; st.posSec = 0; st.paused = false; } else { st.paused = true; st.posSec = 0; } }
    else { st.idx += 1; st.posSec = 0; st.paused = false; }
  }
  if (patch.advance === 'prev' && n) { st.idx = (st.idx - 1 + n) % n; st.posSec = 0; st.paused = false; }
  if (patch.idx != null && n) { st.idx = ((Number(patch.idx) % n) + n) % n; st.posSec = 0; st.paused = false; }
  if (patch.posSec != null) st.posSec = Math.max(0, Number(patch.posSec) || 0);
  if (patch.paused != null) st.paused = !!patch.paused;

  jamSaveState(jam.id, st);
  res.json(jamPayload(musicSys.jamGet.get(jam.id), st));
});

/* ============================================================
   BUG REPORTS

   A global inbox any part of the system can write to. Members file reports from
   the Bug Reports app; automated assistants with NO account file them through the
   OPEN POST endpoint. Admins read + triage them in the same app.

     POST /api/bugs        — signed-in member files a report
     POST /api/bugs/open   — PUBLIC, unauthenticated: an automated AI files a report
     GET  /api/bugs        — admin: list + status counts
     PATCH/DELETE /api/bugs/:id — admin: triage / remove
   ============================================================ */
const BUG_SEVERITIES = ['low', 'medium', 'high', 'critical'];
const BUG_STATUSES = ['new', 'open', 'resolved', 'wontfix'];
const BUG_LIST_LIMIT = 500;
function bugId() { return 'bug_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
/* normalize a severity to one of BUG_SEVERITIES (default 'medium'). */
function bugSeverity(v) { v = String(v || '').toLowerCase(); return BUG_SEVERITIES.includes(v) ? v : 'medium'; }
/* shape a stored row for the API (parse meta JSON; never leak account_id). */
function bugToApi(r) {
  let meta = null; if (r.meta) { try { meta = JSON.parse(r.meta); } catch (e) {} }
  return {
    id: r.id, created: r.created, source: r.source, reporter: r.reporter || null,
    area: r.area || null, severity: r.severity || 'medium', title: r.title, body: r.body,
    status: r.status || 'new', notes: r.notes || null, meta,
  };
}
/* store a report. Caller passes already-clipped/validated fields. Returns the API row. */
function bugStore({ source, accountId = null, reporter, area, severity, title, body, meta }) {
  const row = {
    id: bugId(), created: Date.now(), source,
    account_id: accountId, reporter: clip(reporter, 80) || null,
    area: clip(area, 60) || null, severity: bugSeverity(severity),
    title: clip(title, 200), body: clip(body, 8000),
    meta: meta ? JSON.stringify(meta).slice(0, 4000) : null,
  };
  bugSys.insert.run(row);
  return bugToApi(bugSys.get.get(row.id));
}

// member files a report from the Bug Reports app (attributed to their account).
app.post('/api/bugs', requireAuth, (req, res) => {
  const b = req.body || {};
  const title = clip(b.title, 200).trim();
  const body = clip(b.body, 8000).trim();
  if (!title || !body) return res.status(400).json({ error: 'a title and a description are required' });
  const rep = bugStore({
    source: 'user', accountId: req.accountId,
    reporter: req.account.display || req.account.username,
    area: b.area, severity: b.severity, title, body,
    meta: { url: clip(b.url, 500), ua: clip(req.headers['user-agent'], 300) },
  });
  console.warn(`[simplex] BUG REPORT (user ${req.account.username}) [${rep.severity}] ${rep.area || '-'}: ${rep.title}`);
  res.json({ ok: true, report: rep });
});

/* OPEN POST — an automated assistant with no account files a bug report.
   Public + unauthenticated by design (an external security check / AI may have no
   session). Hardened like /api/crash: per-IP rate limit, field length caps, and it
   is WRITE-ONLY — it returns just an ack + id, never the inbox. */
const bugOpenRate = new Map();   // ip -> { count, windowStart }
const BUG_OPEN_WINDOW_MS = 60_000, BUG_OPEN_MAX_PER_WINDOW = 10;
setInterval(() => {              // prune idle IPs so the map can't grow unbounded
  const now = Date.now();
  for (const [ip, r] of bugOpenRate) if (now - r.windowStart > BUG_OPEN_WINDOW_MS) bugOpenRate.delete(ip);
}, BUG_OPEN_WINDOW_MS).unref();
function bugOpenRateOk(ip) {
  const now = Date.now();
  let r = bugOpenRate.get(ip);
  if (!r || now - r.windowStart > BUG_OPEN_WINDOW_MS) { r = { count: 0, windowStart: now }; bugOpenRate.set(ip, r); }
  r.count++;
  return r.count <= BUG_OPEN_MAX_PER_WINDOW;
}
app.post('/api/bugs/open', (req, res) => {
  try {
    const ip = clientIp(req);
    if (!bugOpenRateOk(ip)) return res.status(429).json({ ok: false, error: 'rate limited — try again shortly' });
    const b = req.body || {};
    const title = clip(b.title, 200).trim();
    const body = clip(b.body, 8000).trim();
    if (!title || !body) return res.status(400).json({ ok: false, error: 'title and body are required' });
    const rep = bugStore({
      source: 'ai', accountId: null,
      reporter: clip(b.reporter, 80) || 'Automated assistant',
      area: b.area, severity: b.severity, title, body,
      meta: { ip, ua: clip(req.headers['user-agent'], 300), tool: clip(b.tool, 80), url: clip(b.url, 500) },
    });
    console.warn(`[simplex] BUG REPORT (open/ai ${rep.reporter} ip=${ip}) [${rep.severity}] ${rep.area || '-'}: ${rep.title}`);
    res.json({ ok: true, id: rep.id });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'could not file report' });
  }
});

// admin: read the inbox + status counts
app.get('/api/bugs', requireAdmin, (req, res) => {
  const reports = bugSys.list.all({ limit: BUG_LIST_LIMIT }).map(bugToApi);
  const counts = { new: 0, open: 0, resolved: 0, wontfix: 0 };
  for (const c of bugSys.counts.all()) if (counts[c.status] != null) counts[c.status] = c.n;
  res.json({ reports, counts });
});
// admin: triage — change status and/or add notes
app.patch('/api/bugs/:id', requireAdmin, (req, res) => {
  const row = bugSys.get.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (b.status !== undefined) {
    if (!BUG_STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad status' });
    bugSys.setStatus.run({ id: row.id, status: b.status });
  }
  if (b.notes !== undefined) bugSys.setNotes.run({ id: row.id, notes: clip(b.notes, 4000) });
  res.json({ ok: true, report: bugToApi(bugSys.get.get(row.id)) });
});
// admin: delete a report
app.delete('/api/bugs/:id', requireAdmin, (req, res) => {
  bugSys.del.run(req.params.id);
  res.json({ ok: true });
});

/* ============================================================
   TRADING BACKGROUND LOOPS — the "always training" engine. All run off the event
   loop (the training math chunks internally; data fetches are async I/O), and all
   timers are .unref()'d so they never hold the process open during a restart.
   ============================================================ */
const TRADING_DATA_INTERVAL_MS = +process.env.SX_TRADING_DATA_MS || 60 * 60_000;   // refresh market data hourly
const TRADING_TRAIN_INTERVAL_MS = +process.env.SX_TRADING_TRAIN_MS || 5_000;        // a training burst every 5s
const TRADING_TRADE_INTERVAL_MS = +process.env.SX_TRADING_TRADE_MS || 5 * 60_000;   // evaluate trades every 5 min

let _tradingDataAt = 0, _tradingDataBusy = false;
async function tradingDataTick(force) {
  if (_tradingDataBusy) return;
  if (!force && Date.now() - _tradingDataAt < TRADING_DATA_INTERVAL_MS) return;
  _tradingDataBusy = true; _tradingDataAt = Date.now();
  try {
    for (const sym of tradingSymbols()) {
      const cached = tradingBarsGet(sym);
      const meta = tradingSys.barsGet.get(sym);
      // skip a refetch if we refreshed this symbol within the interval (unless forced)
      if (force || !cached || !meta || Date.now() - meta.updated >= TRADING_DATA_INTERVAL_MS) {
        const bars = await fetchBarsRemote(sym);
        if (bars && bars.length) tradingBarsSet(sym, bars);
        await new Promise(r => setTimeout(r, 350));   // be gentle on the free endpoint
      }
      // intraday (1-min) bars for the sandbox fast-replay — refreshed more often than
      // daily so the replay reflects recent moves (default every 15 min via the guard).
      const iMeta = tradingSys.barsGet.get(INTRADAY_KEY(sym));
      if (force || !iMeta || Date.now() - iMeta.updated >= 15 * 60_000) {
        const intra = await fetchIntradayRemote(sym);
        if (intra && intra.length) tradingIntradaySet(sym, intra);
        await new Promise(r => setTimeout(r, 350));
      }
    }
  } catch (e) { console.error('[simplex] trading data', e && e.message); }
  finally { _tradingDataBusy = false; }
}

// Train the GLOBAL model a few steps on a rotating symbol's history each tick. Cheap
// per tick (chunked Adam in the engine), so over many ticks it sweeps every symbol
// and keeps improving — this is the "always training, shared by all accounts" core.
//
// Throughput knobs (env): SX_TRADING_TRAIN_SYMBOLS = how many symbols to train on per
// tick (each is one round; default 3), and SX_TRADING_TRAIN_MS the tick interval. We
// train on the RICHER series (intraday bars when cached → ~10× more examples per round
// than daily), and yield to the event loop between symbols (setImmediate) so even a
// burst of rounds never blocks a request. Default cadence reaches a few hundred rounds
// in minutes instead of hours.
const TRADING_TRAIN_SYMBOLS = Math.max(1, Math.min(10, +process.env.SX_TRADING_TRAIN_SYMBOLS || 1));
const TRAIN_WINDOW_BARS = Math.max(200, +process.env.SX_TRADING_TRAIN_WINDOW || 900);   // cap bars/round → short slices
let _trainSymbolIdx = 0, _trainBusy = false;
function tradingTrainTick() {
  if (_trainBusy) return;        // don't overlap a still-running burst
  _trainBusy = true;
  let model;
  try { model = tradingModel(); } catch (e) { _trainBusy = false; return; }
  const symbols = tradingSymbols();
  if (!symbols.length) { _trainBusy = false; return; }

  let done = 0;
  const trainOne = () => runTracked('tradingTrainRound', () => {
    const t0 = Date.now();
    try {
      const sym = symbols[_trainSymbolIdx % symbols.length]; _trainSymbolIdx++;
      // Train on a bounded RECENT window of bars (not the whole multi-thousand-bar
      // history) so a single round stays a short event-loop slice no matter how much
      // is cached. The persistent Adam state accumulates progress across rounds.
      let bars = tradingIntradayGet(sym) || tradingBarsGet(sym);
      if (bars && bars.length > TRAIN_WINDOW_BARS) bars = bars.slice(-TRAIN_WINDOW_BARS);
      if (bars && bars.length >= TR.WARMUP + 30) {
        const ds = TR.buildDataset(bars);
        // 1 epoch + a large batch keeps each round short while progress accrues via Adam.
        if (ds.X.length >= 30) { TR.train(model, ds, Object.assign(_tradingOpt, { epochs: 1, batch: 256 })); }
      }
    } catch (e) { console.error('[simplex] trading train', e && e.message); }
    const dt = Date.now() - t0;
    if (dt > 600) console.warn(`[simplex] slow train round: ${dt}ms`);   // surface a genuinely heavy round
    done++;
    if (done < TRADING_TRAIN_SYMBOLS) { setImmediate(trainOne); }   // yield between rounds
    else { try { tradingModelSave(model); } catch (e) {} _trainBusy = false; }
  });
  trainOne();
}

// Day-stamp helper for the daily-loss reset.
function todayStamp() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

// Evaluate + (paper-)execute trades for every account that has auto-trading on. Live
// orders go to the user's own Alpaca; sandbox runs the paper simulator. Stop/take
// exits are checked first (risk), then the model's signal per symbol (sized by gate).
async function tradingTradeTick() {
  let model;
  try { model = tradingModel(); } catch (e) { return; }
  const prices = tradingPrices();
  if (!Object.keys(prices).length) return;
  const symbols = tradingSymbols();
  const stamp = todayStamp();
  const modelUsable = tradingModelUsable(model);   // gates the LIVE path (sandbox is exempt)
  for (const acct of sysStmt.listAccts.all()) {
    let store; try { store = openStore(acct.id); } catch (e) { continue; }
    const raw = store.tradingGet();
    if (!raw) continue;                 // user never opened the Trading app — nothing to do
    const d = tradingDoc(store);
    if (d.autoTrade === false) continue;
    // LIVE path is blocked unless the global model is usable (≥ min rounds + admin-
    // approved). Sandbox is exempt — it's how you check whether a retrained model is
    // good enough, so it keeps simulating regardless.
    if (d.mode === 'live' && (d.live.killed || !tradingLiveEnabled() || !d.live.enabled || !modelUsable)) continue;

    if (d.mode === 'live') { await tradingTickLive(store, d, model, prices, symbols, stamp); }
    else { tradingTickSandbox(store, d, model, prices, symbols, stamp); }
  }
}

// collect cached history for every active symbol -> { SYMBOL: bars[] }
function tradingHistoryBySymbol(symbols, opts) {
  opts = opts || {};
  const out = {}; let usedIntraday = false, usedDaily = false;
  for (const sym of symbols) {
    // sandbox fast-replay prefers INTRADAY (1-min) bars so the playback is fine-grained
    // and feels live; falls back to daily history if intraday isn't cached yet.
    let bars = null, intraday = false;
    if (opts.intraday) { const i = tradingIntradayGet(sym); if (i && i.length >= TR.WARMUP + 10) { bars = i; intraday = true; } }
    if (!bars) bars = tradingBarsGet(sym);
    if (bars && bars.length) { out[sym] = bars; if (intraday) usedIntraday = true; else usedDaily = true; }
  }
  // report the dominant granularity via a non-enumerable marker the caller can read
  Object.defineProperty(out, '__granularity', { value: usedIntraday ? 'minute' : (usedDaily ? 'day' : 'none'), enumerable: false });
  return out;
}

/* Run an INSTANT backtest of the sandbox's current cash over the symbols' history and
   load the result into the portfolio + trade log, so the user immediately sees "what
   the model would have done with my money" (equity curve, trades, P&L). After this,
   the forward loop continues simulating new bars from `lastSimBar`. Mutates d. */
function runSandboxBacktest(store, d, model, symbols) {
  const pf = d.sandbox.portfolio;
  // backtest from the user's NET DEPOSITED amount (the honest baseline) — not the
  // current post-gain equity, so re-running the sim doesn't compound on itself.
  const liveEquity = pf.cash + Object.entries(pf.positions).reduce((s, [sym, p]) => s + (tradingBarsGet(sym)?.slice(-1)[0]?.c || p.entry) * p.qty, 0);
  const cash = (d.sandbox.deposited && d.sandbox.deposited > 0) ? d.sandbox.deposited : liveEquity;
  if (!(cash > 0)) return false;
  // prefer 1-minute intraday bars (fine-grained fast replay); fall back to daily.
  const bySymbol = tradingHistoryBySymbol(symbols, { intraday: true });
  if (!Object.keys(bySymbol).length) return false;
  const bt = TR.backtest(model, bySymbol, { cash, risk: d.risk, maxCurve: 600 });
  // replace the portfolio with the backtested end-state + its equity curve
  bt.portfolio.history = bt.curve;
  d.sandbox.portfolio = bt.portfolio;
  d.sandbox.lastSimBar = bt.lastBarTs;     // forward loop resumes after this bar
  bt.stats.granularity = bySymbol.__granularity === 'minute' ? 'minute' : 'day';
  bt.stats.fromTs = bt.curve.length ? bt.curve[0].t : 0;
  bt.stats.toTs = bt.curve.length ? bt.curve[bt.curve.length - 1].t : 0;
  d.sandbox.stats = bt.stats;              // cached summary for the dashboard
  d.sandbox.dayStamp = ''; d.sandbox.dayStartEquity = bt.portfolio.equity;
  // rewrite the trade log from the simulation (most recent first, capped)
  store.tradingLogClear();
  for (const t of bt.trades.slice(-500)) store.tradingLog({ ...t, mode: 'sandbox' });
  store.tradingSet(d);
  store.bump();
  return true;
}

function tradingTickSandbox(store, d, model, prices, symbols, stamp) {
  const pf = d.sandbox.portfolio;
  if (pf.cash <= 0 && !Object.keys(pf.positions).length) return;
  // only act on a genuinely NEW bar (daily data) — the backtest already covered all of
  // history, so we don't re-trade the same latest bar every 5-minute tick.
  let newestBar = 0;
  for (const sym of symbols) { const bars = tradingBarsGet(sym); if (bars && bars.length) newestBar = Math.max(newestBar, bars[bars.length - 1].t || 0); }
  if (d.sandbox.lastSimBar && newestBar && newestBar <= d.sandbox.lastSimBar) {
    // no new bar since the last simulation step — just refresh the mark-to-market point
    TR.markToMarket(pf, prices);
    pf.history = pf.history || [];
    const last = pf.history[pf.history.length - 1];
    if (!last || Date.now() - (last.t || 0) > 60_000) { pf.history.push({ t: Date.now(), equity: Math.round(pf.equity * 100) / 100 }); if (pf.history.length > 500) pf.history = pf.history.slice(-500); store.tradingSet(d); }
    return;
  }
  d.sandbox.lastSimBar = newestBar || d.sandbox.lastSimBar;
  // reset the day-start equity once per calendar day (for the daily-loss kill switch)
  TR.markToMarket(pf, prices);
  if (d.sandbox.dayStamp !== stamp) { d.sandbox.dayStamp = stamp; d.sandbox.dayStartEquity = pf.equity; }
  let changed = false;
  // 1) forced exits (stop-loss / take-profit) first
  for (const ex of TR.stopOrders(pf, prices)) {
    const r = TR.applyOrder(pf, ex, {});
    if (r.ok) { logTrade(store, 'sandbox', r); changed = true; }
  }
  // 2) day-trader conviction layer (all-in / all-out), same as the backtest
  const preds = [];
  for (const sym of symbols) {
    const bars = tradingBarsGet(sym); if (!bars) continue;
    const price = prices[sym]; if (!(price > 0)) continue;
    const sig = TR.signalFromBars(model, bars, { threshold: TR.DEFAULT_THRESHOLD });
    if (sig.probs) preds.push({ symbol: sym, conf: sig.probs.up - sig.probs.down, price });
  }
  d.sandbox.decState = d.sandbox.decState || { lastExit: {}, barIndex: 0 };
  d.sandbox.decState.barIndex = (d.sandbox.decState.barIndex || 0) + 1;
  const decisions = TR.decidePortfolio(preds, pf, d.risk.decision || {}, d.sandbox.decState);
  decisions.sort((a, b) => (a.side === 'sell' ? -1 : 1) - (b.side === 'sell' ? -1 : 1));
  for (const dec of decisions) {
    const price = prices[dec.symbol]; if (!(price > 0)) continue;
    TR.markToMarket(pf, prices);
    const gate = TR.riskGate({
      action: dec.side === 'sell' ? 'SELL' : 'BUY', symbol: dec.symbol, price, equity: pf.equity, cash: pf.cash,
      positions: pf.positions, risk: d.risk, dayStartEquity: d.sandbox.dayStartEquity, sizeFrac: dec.targetFrac,
    });
    if (!gate.ok) continue;
    const r = TR.applyOrder(pf, gate, {});
    if (r.ok) { logTrade(store, 'sandbox', { ...r, reason: dec.reason }); changed = true; }
  }
  // record an equity point for the dashboard sparkline (cap history length)
  TR.markToMarket(pf, prices);
  pf.history = pf.history || [];
  pf.history.push({ t: Date.now(), equity: Math.round(pf.equity * 100) / 100 });
  if (pf.history.length > 500) pf.history = pf.history.slice(-500);
  store.tradingSet(d);
  if (changed) store.bump();
}

// Live path: place orders against the user's OWN Alpaca account. Reconcile-before-act
// — read current positions so we never double-buy on a worker restart (plan §5).
async function tradingTickLive(store, d, model, prices, symbols, stamp) {
  const creds = { apiKey: d.live.apiKey, apiSecret: d.live.apiSecret, paper: d.live.paper !== false };
  const posResp = await alpacaReq(creds, 'GET', '/v2/positions');
  if (!posResp.ok) return;             // brokerage unreachable — skip this tick, try next
  const held = {}; for (const p of (posResp.json || [])) held[p.symbol] = { qty: +p.qty, entry: +p.avg_entry_price };
  const acctResp = await alpacaAccount(creds);
  const equity = acctResp.ok && acctResp.json ? +acctResp.json.equity : 0;
  if (d.live.dayStamp !== stamp) { d.live.dayStamp = stamp; d.live.dayStartEquity = equity; store.tradingSet(d); }
  // day-trader conviction layer over the REAL brokerage book (all-in / all-out)
  const preds = [];
  for (const sym of symbols) {
    const bars = tradingBarsGet(sym); if (!bars) continue;
    const price = prices[sym]; if (!(price > 0)) continue;
    const sig = TR.signalFromBars(model, bars, { threshold: TR.DEFAULT_THRESHOLD });
    if (sig.probs) preds.push({ symbol: sym, conf: sig.probs.up - sig.probs.down, price });
  }
  const livePf = { cash: equity, positions: held, equity };
  d.live.decState = d.live.decState || { lastExit: {}, barIndex: 0 };
  d.live.decState.barIndex = (d.live.decState.barIndex || 0) + 1;
  store.tradingSet(d);
  const decisions = TR.decidePortfolio(preds, livePf, d.risk.decision || {}, d.live.decState);
  decisions.sort((a, b) => (a.side === 'sell' ? -1 : 1) - (b.side === 'sell' ? -1 : 1));
  for (const dec of decisions) {
    const price = prices[dec.symbol]; if (!(price > 0)) continue;
    const gate = TR.riskGate({
      action: dec.side === 'sell' ? 'SELL' : 'BUY', symbol: dec.symbol, price, equity, cash: equity,
      positions: held, risk: d.risk, dayStartEquity: d.live.dayStartEquity, sizeFrac: dec.targetFrac,
    });
    if (!gate.ok) continue;
    // Alpaca fractional orders: a fractional BUY is sent as a dollar `notional` amount
    // (market/day); a SELL sends the fractional `qty` we hold. Whole-share orders also
    // work via qty. Either way these support fractional shares so small accounts trade.
    const order = gate.side === 'buy'
      ? { symbol: dec.symbol, notional: +(gate.notional || gate.qty * price).toFixed(2), side: 'buy', type: 'market', time_in_force: 'day' }
      : { symbol: dec.symbol, qty: String(gate.qty), side: 'sell', type: 'market', time_in_force: 'day' };
    const r = await alpacaReq(creds, 'POST', '/v2/orders', order);
    if (r.ok) { logTrade(store, 'live', { side: gate.side, symbol: dec.symbol, qty: gate.qty, price, reason: dec.reason }); held[dec.symbol] = gate.side === 'buy' ? { qty: gate.qty, entry: price } : undefined; }
  }
}

function logTrade(store, mode, r) {
  try {
    store.tradingLog({ ts: Date.now(), mode, symbol: r.symbol, side: r.side, qty: r.qty, price: r.price, pnl: r.pnl == null ? null : r.pnl, reason: r.reason });
  } catch (e) {}
}

// schedule the loops (all .unref()'d). Kick a data fetch shortly after boot so a fresh
// install has bars to train on without waiting an hour.
setInterval(() => runTracked('tradingTrain', tradingTrainTick), TRADING_TRAIN_INTERVAL_MS).unref();
setInterval(() => runTracked('tradingData', () => { tradingDataTick(false); }), 10 * 60_000).unref();
setInterval(() => runTracked('tradingTrade', () => { tradingTradeTick(); }), TRADING_TRADE_INTERVAL_MS).unref();
setTimeout(() => { runTracked('tradingDataBoot', () => { tradingDataTick(true); }); }, 5_000).unref();

/* ============================================================
   DISCORD BOT — admin-only app driving discord-bot.js (the voice assistant
   that joins calls, always transcribes, wakes on "Hey Simplex", and talks via
   xAI). Config lives in settings: plain knobs as JSON under 'discord.config',
   secrets (bot token, STT/TTS keys) encrypted via setSecret and NEVER returned
   to the browser — only *Set booleans. The xAI key is shared with the AI app.
   ============================================================ */
function discordConfig() {
  let raw = {};
  try { raw = JSON.parse(getSetting('discord.config') || '{}'); } catch (e) {}
  return DiscordBot.normalizeConfig(raw);
}
const discordBot = DiscordBot.createEngine({
  getConfig: discordConfig,
  getSecrets: () => ({
    botToken: getSecret('discord.bot_token'),
    xaiKey: getSecret('ai.xai_key'),           // "the x.AI API key connected" (AI app config)
    sttKey: getSecret('discord.stt_key'),
    ttsKey: getSecret('discord.tts_key'),
  }),
  onLog: (e) => { if (e.kind === 'error') console.warn('[discord]', e.text); },
});

app.get('/api/discord/config', requireAdmin, (req, res) => {
  const c = discordConfig();
  res.json({
    config: c,
    defaults: DiscordBot.DEFAULT_CONFIG,
    tokenSet: !!getSecret('discord.bot_token'),
    xaiKeySet: !!getSecret('ai.xai_key'),
    sttKeySet: !!getSecret('discord.stt_key'),
    ttsKeySet: !!getSecret('discord.tts_key'),
  });
});
app.put('/api/discord/config', requireAdmin, (req, res) => {
  const b = req.body || {};
  // secrets: undefined = unchanged, '' = clear, string = set
  if (b.botToken !== undefined) setSecret('discord.bot_token', String(b.botToken).trim());
  if (b.sttKey !== undefined) setSecret('discord.stt_key', String(b.sttKey).trim());
  if (b.ttsKey !== undefined) setSecret('discord.tts_key', String(b.ttsKey).trim());
  if (b.config !== undefined) {
    const clean = DiscordBot.normalizeConfig(b.config);
    setSetting('discord.config', JSON.stringify(clean));
  }
  res.json({ ok: true, config: discordConfig(), tokenSet: !!getSecret('discord.bot_token'), sttKeySet: !!getSecret('discord.stt_key'), ttsKeySet: !!getSecret('discord.tts_key'), xaiKeySet: !!getSecret('ai.xai_key') });
});
app.get('/api/discord/status', requireAdmin, (req, res) => res.json(discordBot.status()));
app.get('/api/discord/log', requireAdmin, (req, res) => res.json({ log: discordBot.getLog(req.query.since), now: Date.now() }));
app.post('/api/discord/start', requireAdmin, async (req, res) => res.json(await discordBot.start()));
app.post('/api/discord/stop', requireAdmin, async (req, res) => res.json(await discordBot.stop('admin stop')));
app.post('/api/discord/restart', requireAdmin, async (req, res) => res.json(await discordBot.restart()));
app.post('/api/discord/hangup', requireAdmin, async (req, res) => { await discordBot.leaveCall('admin hang-up'); res.json(discordBot.status()); });

/* ---------- Music: reap jams whose members all went away ----------
   Clients heartbeat via /api/music/jam/:id/state, but if everyone closes the tab
   without leaving cleanly, the jam would linger. Sweep periodically: drop stale
   members, transfer host if needed, and delete jams with no one left. */
setInterval(() => runTracked('musicJamSweep', () => {
  musicSys.jmPrune.run(Date.now() - JAM_MEMBER_TTL);
  for (const { jam_id } of musicSys.jamList.all().map(j => ({ jam_id: j.id }))) {
    const jam = musicSys.jamGet.get(jam_id);
    if (jam) jamReap(jam);
  }
}), 30_000).unref();

/* ---------- Schedule engine ----------
   Once a minute, for every account that has enabled Schedule connectors, fire a
   notification when the local clock matches a configured time on an active day.
   `config.lastFired` (a YYYY-MM-DD-HH:MM slot key) dedupes so we ping once per slot. */
function slotKey(d, time) { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}@${time}`; }
function runScheduleEngine() {
  try {
    const now = new Date();
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const dow = now.getDay();   // 0=Sun
    for (const acct of sysStmt.listAccts.all()) {
      let store;
      try { store = openStore(acct.id); } catch (e) { continue; }
      let changed = false;
      for (const row of store.connRaw()) {
        if (row.type !== 'schedule' || !row.enabled) continue;
        const conn = store.connGet(row.id); if (!conn) continue;
        const cfg = conn.config || {};
        if (cfg.time !== hhmm) continue;
        const days = Array.isArray(cfg.days) ? cfg.days : [0, 1, 2, 3, 4, 5, 6];
        if (days.length && !days.includes(dow)) continue;
        const key = slotKey(now, cfg.time);
        if (cfg.lastFired === key) continue;
        store.notifAdd({
          type: 'schedule',
          title: cfg.task || conn.label || 'Scheduled reminder',
          body: cfg.message || 'Confirm when you\'ve finished this.',
          meta: { connectorId: conn.id },
          requires_ack: true,
        });
        store.connUpdate(conn.id, { config: { ...cfg, lastFired: key } });
        changed = true;
      }
      if (changed) store.bump();
    }
  } catch (e) { console.error('[simplex] schedule engine', e && e.message); }
}
setInterval(() => runTracked('scheduleEngine', runScheduleEngine), 60_000).unref();

/* ============================================================
   TOOLS APP — ffmpeg-backed media converters/compressors
   Safe by construction: ffmpeg is a fixed binary and EVERY arg is built server-side
   from an allowlist (no user command strings, no network). Each job runs in a
   throwaway dir under vault/tools and is cleaned up on every exit path.
   ============================================================ */
const FFMPEG = 'ffmpeg';   // resolved via PATH

/* Run a short-lived probe process WITHOUT blocking the event loop. spawnSync
   freezes the whole single thread until the child exits — and on Windows with
   real-time AV (BitDefender) scanning the spawned .exe, that can stall for a long
   time, hanging every request incl. /api/health (the "opened Tools and it hung"
   freeze). spawn() is async; we add a hard timeout so a missing/hung binary
   resolves quickly instead of pinning a job. Resolves { ok, status, stdout }. */
function probeProcess(cmd, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let done = false, out = '';
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); }
    catch (e) { return finish({ ok: false, status: null, stdout: '' }); }
    const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} finish({ ok: false, status: null, stdout: out }); }, timeoutMs);
    if (child.stdout) child.stdout.on('data', (d) => { if (out.length < 65536) out += d.toString(); });
    child.on('error', () => { clearTimeout(to); finish({ ok: false, status: null, stdout: '' }); });
    child.on('close', (code) => { clearTimeout(to); finish({ ok: code === 0, status: code, stdout: out }); });
  });
}

let _ffmpegOk = null;
let _ffmpegProbe = null;   // in-flight probe promise (de-dupe concurrent first-calls)
async function ffmpegAvailable() {
  if (_ffmpegOk !== null) return _ffmpegOk;
  if (!_ffmpegProbe) _ffmpegProbe = probeProcess(FFMPEG, ['-version']).then(r => { _ffmpegOk = r.ok; _ffmpegProbe = null; return r.ok; });
  return _ffmpegProbe;
}

const TOOL_TIMEOUT_MS = 20 * 60_000;          // 20 min per job (sources come from the vault and can be large)
const TOOL_MAX_GLOBAL = 3, TOOL_MAX_PER_ACCT = 1;
let _toolJobs = 0; const _toolJobsByAcct = new Map();
/* live conversion progress per account (cap is 1 job/acct, so accountId is the key).
   The client polls GET /api/tools/progress while a conversion runs. */
const _toolProgress = new Map();
function setToolProgress(acctId, o) { _toolProgress.set(acctId, { ...(o || {}), updated: Date.now() }); }
function clearToolProgress(acctId) { _toolProgress.delete(acctId); }
/* parse the seconds elapsed from ffmpeg's stderr "time=HH:MM:SS.ss" tokens */
function ffmpegTimeSecs(chunk) {
  let secs = null, m, re = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/g;
  while ((m = re.exec(chunk))) secs = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  return secs;
}

const VIDEO_EXTS = ['mp4', 'ts', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v', 'wmv', 'mpg', 'mpeg', '3gp'];
const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'exr'];
const AUDIO_CODEC = { mp3: 'libmp3lame', m4a: 'aac', aac: 'aac', wav: 'pcm_s16le', flac: 'flac', ogg: 'libvorbis', opus: 'libopus' };
const AUDIO_MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg' };
const VIDEO_MIME = { mp4: 'video/mp4', ts: 'video/mp2t', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo' };
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', exr: 'image/x-exr' };
const AUDIO_BITRATE = { '320': '320k', '192': '192k', '128': '128k', '96': '96k' };
const lossless = (fmt) => fmt === 'wav' || fmt === 'flac';
const audioArgs = (fmt, preset) => { const a = ['-c:a', AUDIO_CODEC[fmt]]; if (!lossless(fmt)) a.push('-b:a', AUDIO_BITRATE[preset] || '192k'); return a; };

const TOOL_SPECS = {
  'video-to-audio': {
    accept: VIDEO_EXTS, targets: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'], mime: (f) => AUDIO_MIME[f],
    build: (i, o, { format, preset }) => ['-i', i, '-vn', ...audioArgs(format, preset), '-y', o],
  },
  'audio-convert': {
    accept: AUDIO_EXTS, targets: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'], mime: (f) => AUDIO_MIME[f],
    build: (i, o, { format, preset }) => ['-i', i, '-vn', ...audioArgs(format, preset), '-y', o],
  },
  'video-convert': {
    accept: VIDEO_EXTS, targets: ['mp4', 'ts', 'mkv', 'webm', 'mov', 'avi'], mime: (f) => VIDEO_MIME[f],
    build: (i, o, { format }) => format === 'webm'
      ? ['-i', i, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-c:a', 'libopus', '-y', o]
      : ['-i', i, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '192k', '-y', o],
  },
  'video-compress': {
    accept: VIDEO_EXTS, targets: ['mp4'], mime: () => 'video/mp4', sizeMode: 'video',
    build: (i, o, { vBitrate, aBitrate }) => ['-i', i, '-c:v', 'libx264', '-preset', 'medium', '-b:v', vBitrate + 'k', '-maxrate', Math.round(vBitrate * 1.3) + 'k', '-bufsize', (vBitrate * 2) + 'k', '-c:a', 'aac', '-b:a', aBitrate + 'k', '-movflags', '+faststart', '-y', o],
  },
  'audio-compress': {
    accept: AUDIO_EXTS, targets: ['mp3'], mime: () => 'audio/mpeg', sizeMode: 'audio',
    build: (i, o, { aBitrate }) => ['-i', i, '-vn', '-c:a', 'libmp3lame', '-b:a', aBitrate + 'k', '-y', o],
  },
  // Image conversion, both directions: EXR/TIFF <-> png/jpg/webp/bmp/tiff/exr.
  // A single still frame; ffmpeg picks the encoder from the output extension
  // (exr needs it named explicitly). No duration, so there's no size mode.
  'image-convert': {
    accept: IMAGE_EXTS, targets: ['png', 'jpg', 'webp', 'tiff', 'exr', 'bmp'], mime: (f) => IMAGE_MIME[f] || 'application/octet-stream',
    build: (i, o, { format }) => format === 'exr'
      ? ['-i', i, '-c:v', 'exr', '-y', o]
      : ['-i', i, '-frames:v', '1', '-y', o],
  },
};

/* read media duration (seconds) via ffprobe — needed to turn a target file size
   into a target bitrate for the compressors. */
async function ffprobeDuration(p) {
  // async (no spawnSync) so a slow/AV-scanned ffprobe never blocks the event loop
  const r = await probeProcess('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', p]);
  const d = parseFloat(String(r.stdout || '').trim());
  return Number.isFinite(d) && d > 0 ? d : null;
}
/* read the pixel dimensions of the first video/image stream via ffprobe */
async function ffprobeDims(p) {
  const r = await probeProcess('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', p]);
  const m = /^(\d+)x(\d+)/.exec(String(r.stdout || '').trim());
  if (!m) return null;
  const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
  return (w > 0 && h > 0) ? { w, h } : null;
}
/* turn a target size (bytes) + duration into kbps, split across video/audio.
   Single-pass + maxrate gets close to the target; the result reports the real size. */
function bitratesForTarget(kind, targetBytes, durationSec) {
  // ~6% headroom for container overhead so we land at or under target
  const totalKbps = Math.max(8, Math.floor((targetBytes * 8 / durationSec / 1000) * 0.94));
  if (kind === 'audio') return { aBitrate: Math.max(16, Math.min(320, totalKbps)) };
  let aBitrate = totalKbps > 192 ? 128 : totalKbps > 96 ? 96 : 64;
  let vBitrate = totalKbps - aBitrate;
  if (vBitrate < 50) { vBitrate = Math.max(40, totalKbps - 32); aBitrate = Math.max(24, totalKbps - vBitrate); }
  return { vBitrate: Math.round(vBitrate), aBitrate: Math.round(aBitrate) };
}

app.get('/api/tools', async (req, res) => res.json({ ffmpeg: await ffmpegAvailable(), ready: Object.keys(TOOL_SPECS) }));

/* live progress for the account's running conversion (polled by the client) */
app.get('/api/tools/progress', (req, res) => {
  const p = _toolProgress.get(req.accountId);
  res.json(p ? { active: true, pct: p.pct == null ? null : p.pct, phase: p.phase || 'processing' } : { active: false });
});

/* Convert/compress a file that's ALREADY in the vault (no multipart upload — this
   sidesteps Cloudflare's ~100 MB request cap; big files get into the vault via the
   chunked uploader). The source blob is decrypted to a temp file, ffmpeg runs, and
   the result is streamed back for download OR re-encrypted into the vault as a new
   file / in place of the original. JSON body:
     { fileId, tool, format, preset?, mode?, value?, output: 'download'|'save'|'replace' } */
app.post('/api/tools/convert', async (req, res) => {
  const jobDir = path.join(TOOLS_DIR, 't' + crypto.randomBytes(6).toString('hex'));
  const cleanup = () => { try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {} };
  let counted = false;
  const release = () => { if (!counted) return; counted = false; _toolJobs = Math.max(0, _toolJobs - 1); const n = (_toolJobsByAcct.get(req.accountId) || 1) - 1; if (n <= 0) _toolJobsByAcct.delete(req.accountId); else _toolJobsByAcct.set(req.accountId, n); };
  try {
    if (!(await ffmpegAvailable())) return res.status(503).json({ error: 'ffmpeg is not installed on the server' });
    const b = req.body || {};
    const spec = TOOL_SPECS[String(b.tool || '')];
    if (!spec) return res.status(400).json({ error: 'unknown tool' });
    const format = String(b.format || spec.targets[0]).toLowerCase();
    if (!spec.targets.includes(format)) return res.status(400).json({ error: 'unsupported output format' });
    const output = ['download', 'save', 'replace'].includes(b.output) ? b.output : 'download';
    // save/replace add (or rewrite) bytes in the vault, so they're gated behind ToS
    // acceptance just like a direct upload. A plain download is not.
    if ((output === 'save' || output === 'replace') && !tosAccepted(req.account)) {
      return res.status(451).json({ error: 'You must accept the Terms of Service before saving to your vault.', code: 'TOS', version: tosVersion() });
    }

    const store = req.store;
    const row = store.getById(String(b.fileId || ''));
    if (!row || !row.hasBlob) return res.status(404).json({ error: 'pick a file from your vault' });
    if (legacyGate(req, res, row)) return;   // convert/compress reads + exports the blob — Legacy rows re-encrypt first
    const srcName = store.decName(row);
    const srcExt = (path.extname(srcName).slice(1) || row.storedExt || '').toLowerCase();
    if (spec.accept && srcExt && !spec.accept.includes(srcExt)) return res.status(400).json({ error: `this tool can't use a .${srcExt} file` });

    const acctN = _toolJobsByAcct.get(req.accountId) || 0;
    if (_toolJobs >= TOOL_MAX_GLOBAL) return res.status(429).json({ error: 'server busy — try again shortly' });
    if (acctN >= TOOL_MAX_PER_ACCT) return res.status(429).json({ error: 'you already have a conversion running' });

    await fsp.mkdir(jobDir, { recursive: true });
    const inP = path.join(jobDir, 'in' + (srcExt ? '.' + srcExt : ''));
    await decryptBlobToFile(store.blobPath(row), store.keys, inP);
    let srcSize = row.size || 0; try { srcSize = (await fsp.stat(inP)).size; } catch (e) {}

    // probe duration once — used both for the compressor bitrate math AND for a
    // live progress percentage (ffmpeg reports elapsed time vs. this total).
    const dur = await ffprobeDuration(inP);

    const buildOpts = { format, preset: String(b.preset || '') };
    if (spec.sizeMode) {
      const mode = String(b.mode || 'percent');
      let targetBytes;
      if (mode === 'size') {
        const mb = parseFloat(b.value);
        if (!Number.isFinite(mb) || mb <= 0) { cleanup(); return res.status(400).json({ error: 'enter a target size in MB' }); }
        targetBytes = mb * 1024 * 1024;
      } else {
        const pct = parseFloat(b.value);
        if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) { cleanup(); return res.status(400).json({ error: 'target percentage must be between 1 and 99' }); }
        targetBytes = srcSize * (pct / 100);
      }
      if (!dur) { cleanup(); return res.status(422).json({ error: 'could not read the media duration' }); }
      Object.assign(buildOpts, bitratesForTarget(spec.sizeMode, targetBytes, dur));
    }

    const outP = path.join(jobDir, 'out.' + format);
    const args = spec.build(inP, outP, buildOpts);

    _toolJobs++; _toolJobsByAcct.set(req.accountId, acctN + 1); counted = true;
    setToolProgress(req.accountId, { pct: dur ? 0 : null, phase: 'processing' });
    const child = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => {
      const s = d.toString();
      if (stderr.length < 8000) stderr += s;
      if (dur) { const t = ffmpegTimeSecs(s); if (t != null) setToolProgress(req.accountId, { pct: Math.max(0, Math.min(99, Math.round(t / dur * 100))), phase: 'processing' }); }
    });
    let timedOut = false, aborted = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, TOOL_TIMEOUT_MS);
    res.on('close', () => { if (!res.writableEnded) { aborted = true; killTree(child); } });
    child.on('error', () => {});
    child.on('close', async (code) => {
      clearTimeout(timer); release();
      try {
        if (aborted) { clearToolProgress(req.accountId); return cleanup(); }
        if (timedOut) { clearToolProgress(req.accountId); cleanup(); if (!res.headersSent) res.status(504).json({ error: 'conversion timed out' }); return; }
        let outStat = null;
        if (code === 0) { try { outStat = await fsp.stat(outP); } catch (e) {} }
        if (code !== 0 || !outStat) {
          clearToolProgress(req.accountId); cleanup();
          const msg = (stderr.split('\n').filter(Boolean).pop() || 'conversion failed').slice(0, 200);
          if (!res.headersSent) res.status(422).json({ error: msg });
          return;
        }
        const outSize = outStat.size;
        const base = (srcName.replace(/\.[^.]+$/, '') || 'output');

        if (output === 'download') {
          setToolProgress(req.accountId, { pct: 100, phase: 'download' });
          const safeName = base.replace(/[^\w.\- ]+/g, '_').slice(0, 80) + '.' + format;
          res.setHeader('Content-Type', spec.mime(format) || 'application/octet-stream');
          res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
          res.setHeader('Content-Length', String(outSize));
          res.setHeader('X-Output-Size', String(outSize));
          res.setHeader('Access-Control-Expose-Headers', 'X-Output-Size');
          const rs = fs.createReadStream(outP);
          rs.on('error', () => { clearToolProgress(req.accountId); cleanup(); try { res.destroy(); } catch (e) {} });
          rs.on('close', () => { clearToolProgress(req.accountId); cleanup(); });
          rs.pipe(res);
          return;
        }

        // save into the vault (new file or replace the original)
        setToolProgress(req.accountId, { pct: 100, phase: 'saving' });
        const quota = req.account.quota_bytes;
        if (output === 'save') {
          if (store.usedBytes() + outSize > quota) { clearToolProgress(req.accountId); cleanup(); return limitError(res, store, quota); }
          const id = uid();
          await vault.encryptBlob(outP, store.blobPath({ id }), store.keys);
          const newName = dedupeName(base + '.' + format, store, row.parent ?? null);
          store.insertRow({ id, name: newName, type: typeForExt(format), parent: row.parent ?? null, size: outSize, date: Date.now(), dur: (await ffprobeDuration(outP)) || null, hasBlob: 1, storedExt: format });
          store.bump(); clearToolProgress(req.accountId); cleanup();
          return res.json({ ok: true, output: 'save', srcSize, outSize, file: rowToApi(store.getById(id), store) });
        }
        // replace: overwrite the source row's blob + metadata in place
        const delta = Math.max(0, outSize - (row.size || 0));
        if (store.usedBytes() + delta > quota) { clearToolProgress(req.accountId); cleanup(); return limitError(res, store, quota); }
        await vault.encryptBlob(outP, store.blobPath(row), store.keys);
        const newName = base + '.' + format;
        store.db.prepare('UPDATE files SET name=@name, size=@size, storedExt=@ext, type=@type, dur=@dur, date=@date, hasPoster=0 WHERE id=@id')
          .run({ name: vault.encText(newName, store.keys), size: outSize, ext: format, type: typeForExt(format), dur: (await ffprobeDuration(outP)) || null, date: Date.now(), id: row.id });
        try { await fsp.unlink(store.posterPath(row)); } catch (e) {}   // drop the stale preview/poster; regenerated on demand
        if (store.keys.v2) store.setKv(row.id, 2);   // blob fully rewritten under v2
        store.bump(); clearToolProgress(req.accountId); cleanup();
        return res.json({ ok: true, output: 'replace', srcSize, outSize, file: rowToApi(store.getById(row.id), store) });
      } catch (e) {
        clearToolProgress(req.accountId); cleanup();
        if (!res.headersSent) res.status(500).json({ error: 'finalize failed: ' + (e.message || 'error') });
      }
    });
  } catch (e) {
    release(); clearToolProgress(req.accountId); cleanup();
    if (!res.headersSent) res.status(500).json({ error: 'conversion error: ' + (e.message || '') });
  }
});

/* ============================================================
   MINI VIDEO EDITOR — server render (POST /api/tools/mve/export)
   Builds ONE ffmpeg invocation from a validated project: a single video track
   (trim + interior cuts -> concat), burned-in text overlays (drawtext), and an
   audio mix of the source's own audio + any number of extra vault audio tracks,
   each with per-track volume + pitch (semitone shift). Same safety model as the
   converters: ffmpeg is fixed, EVERY arg is built here from sanitized numbers /
   allowlisted strings — no user command strings, no network. Inputs come ONLY
   from the account's vault (resolved by fileId), are decrypted to a throwaway job
   dir, and the rendered mp4 is re-encrypted back into the vault.
   ============================================================ */
const MVE_LIMITS = { clips: 60, tracks: 12, overlays: 40, sourceDur: 4 * 3600, totalDur: 4 * 3600, textLen: 500 };

const clampNum = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
/* escape text for ffmpeg drawtext (the text= value): backslash, colon, single
   quote, percent, and newlines all have meaning inside the filtergraph. */
function drawtextEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "’")
    .replace(/%/g, '\\%').replace(/[\r\n]+/g, ' ');
}
/* turn a hex (#rgb / #rrggbb) into ffmpeg "0xRRGGBB"; default white. */
function ffColor(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split('').map(c => c + c).join('');
  return /^[0-9a-fA-F]{6}$/.test(h) ? '0x' + h.toUpperCase() : '0xFFFFFF';
}
/* 9-grid position -> drawtext x/y expressions (text_w/text_h + a fixed margin).
   The margin is a literal (drawtext has no user variables), so the expressions
   are self-contained. */
const MVE_M = 24;
const MVE_POS = {
  tl: { x: `${MVE_M}`, y: `${MVE_M}` }, tc: { x: '(w-text_w)/2', y: `${MVE_M}` }, tr: { x: `w-text_w-${MVE_M}`, y: `${MVE_M}` },
  ml: { x: `${MVE_M}`, y: '(h-text_h)/2' }, mc: { x: '(w-text_w)/2', y: '(h-text_h)/2' }, mr: { x: `w-text_w-${MVE_M}`, y: '(h-text_h)/2' },
  bl: { x: `${MVE_M}`, y: `h-text_h-${MVE_M}` }, bc: { x: '(w-text_w)/2', y: `h-text_h-${MVE_M}` }, br: { x: `w-text_w-${MVE_M}`, y: `h-text_h-${MVE_M}` },
};

/* keyframe value at clip-local time t (mirrors the client's mveKfValue) */
function mveEaseServer(a, b, frac, curve) {
  if (curve === 'hold') return a;
  if (curve === 'ease') frac = frac * frac * (3 - 2 * frac);
  return a + (b - a) * frac;
}
function mveKfValueServer(kfs, t, dflt) {
  if (!Array.isArray(kfs) || !kfs.length) return dflt;
  const s = kfs.map(k => ({ t: Number(k.t) || 0, v: Number(k.v), curve: k.curve })).filter(k => Number.isFinite(k.v)).sort((a, b) => a.t - b.t);
  if (!s.length) return dflt;
  if (t <= s[0].t) return s[0].v;
  if (t >= s[s.length - 1].t) return s[s.length - 1].v;
  for (let i = 0; i < s.length - 1; i++) if (t >= s[i].t && t <= s[i + 1].t) { const span = (s[i + 1].t - s[i].t) || 1e-6; return mveEaseServer(s[i].v, s[i + 1].v, (t - s[i].t) / span, s[i].curve || 'linear'); }
  return s[s.length - 1].v;
}

/* build an ffmpeg `volume` expression (eval=frame) from volume keyframes. `t` in
   the expression is the FILTER time (clip-local, since we trim+asetpts first).
   Falls back to a constant. Curves: linear / ease (smoothstep) / hold. */
function volumeExpr(kfs, constVol) {
  const s = (Array.isArray(kfs) ? kfs : []).map(k => ({ t: clampNum(k.t, 0, 1e6, 0), v: clampNum(k.v, 0, 8, 1), curve: MVE_CURVES_SET.has(k.curve) ? k.curve : 'linear' })).sort((a, b) => a.t - b.t);
  if (!s.length) return null;                 // caller uses constant volume
  if (s.length === 1) return s[0].v.toFixed(4);
  // nested if(): for each segment [a,b], interpolate; outside clamps to ends
  let expr = s[s.length - 1].v.toFixed(4);     // default = last value
  for (let i = s.length - 2; i >= 0; i--) {
    const a = s[i], b = s[i + 1];
    const span = (b.t - a.t) || 1e-6;
    const fr = `((t-${a.t.toFixed(4)})/${span.toFixed(4)})`;
    let frac = fr;
    if (a.curve === 'ease') frac = `(${fr}*${fr}*(3-2*${fr}))`;
    let seg;
    if (a.curve === 'hold') seg = a.v.toFixed(4);
    else seg = `(${a.v.toFixed(4)}+(${(b.v - a.v).toFixed(4)})*${frac})`;
    expr = `if(lt(t,${b.t.toFixed(4)}),${seg},${expr})`;
  }
  expr = `if(lt(t,${s[0].t.toFixed(4)}),${s[0].v.toFixed(4)},${expr})`;
  return expr;
}
const MVE_CURVES_SET = new Set(['linear', 'ease', 'hold']);

/* constant pitch shift by N semitones using rubberband when available (clean,
   tempo-preserving), else asetrate+atempo. Returns a filter string or null. */
function pitchFilter(semitones, sr = 44100) {
  const n = clampNum(semitones, -24, 24, 0);
  if (!n) return null;
  if (_rubberbandOk) return `rubberband=pitch=${Math.pow(2, n / 12).toFixed(6)}`;
  const ratio = Math.pow(2, n / 12);
  let parts = [`asetrate=${sr}*${ratio.toFixed(6)}`, `aresample=${sr}`];
  let comp = 1 / ratio, steps = [];
  while (comp > 2.0) { steps.push(2.0); comp /= 2.0; }
  while (comp < 0.5) { steps.push(0.5); comp /= 0.5; }
  steps.push(comp);
  for (const s of steps) parts.push(`atempo=${s.toFixed(6)}`);
  return parts.join(',');
}
/* probe rubberband availability once (smooth keyframed pitch needs it) */
let _rubberbandOk = null;
async function rubberbandAvailable() {
  if (_rubberbandOk !== null) return _rubberbandOk;
  try { const r = await probeProcess(FFMPEG, ['-hide_banner', '-filters']); _rubberbandOk = /(\s)rubberband(\s)/.test(String(r.stdout || '')); }
  catch (e) { _rubberbandOk = false; }
  return _rubberbandOk;
}

/* compose one audio clip's filter chain: trim -> reset PTS -> pitch (segmented for
   keyframes, via rubberband) -> keyframed/constant volume -> delay to its start. */
function mveAudioClipChain(inLabel, c, outLabel) {
  const inP = clampNum(c.in, 0, MVE_LIMITS.sourceDur, 0);
  const outP = clampNum(c.out, inP + 0.02, MVE_LIMITS.sourceDur + 1, inP + 1);
  const start = clampNum(c.start, 0, MVE_LIMITS.totalDur, 0);
  const baseVol = clampNum(c.volume, 0, 8, 1);
  const chain = [`atrim=start=${inP.toFixed(3)}:end=${outP.toFixed(3)}`, 'asetpts=PTS-STARTPTS'];
  // pitch: keyframed -> piecewise rubberband segments; else a single shift
  const pkfs = Array.isArray(c.pitchKfs) ? c.pitchKfs : [];
  if (pkfs.length && _rubberbandOk) {
    // approximate the ramp with short constant-pitch slices (smooth enough audibly)
    const dur = outP - inP, N = Math.min(40, Math.max(2, Math.round(dur / 0.25)));
    // rubberband can't be time-varying in one instance; emulate by averaging is poor,
    // so we keep a single representative shift (midpoint) and note finer ramps export-only.
    const mid = mveKfValueServer(pkfs, dur / 2, c.pitch || 0);
    const pf = pitchFilter(mid); if (pf) chain.push(pf);
  } else {
    const pf = pitchFilter(c.pitch); if (pf) chain.push(pf);
  }
  // volume: keyframed expression or constant
  const vexpr = volumeExpr(c.volumeKfs, baseVol);
  if (vexpr && /[a-z(]/.test(vexpr)) chain.push(`volume=eval=frame:volume='${vexpr}'`);
  else chain.push(`volume=${(vexpr || baseVol.toFixed(4))}`);
  // fade in/out (clip-local, before the timeline delay). Clamped to the clip length.
  const clipLen = outP - inP;
  const fin = clampNum(c.fadeIn, 0, clipLen, 0), fout = clampNum(c.fadeOut, 0, clipLen, 0);
  if (fin > 0.01) chain.push(`afade=t=in:st=0:d=${fin.toFixed(3)}`);
  if (fout > 0.01) chain.push(`afade=t=out:st=${Math.max(0, clipLen - fout).toFixed(3)}:d=${fout.toFixed(3)}`);
  if (start > 0) chain.push(`adelay=${Math.round(start * 1000)}|${Math.round(start * 1000)}`);
  return `${inLabel}${chain.join(',')}${outLabel}`;
}

app.post('/api/tools/mve/export', async (req, res) => {
  const jobDir = path.join(TOOLS_DIR, 'm' + crypto.randomBytes(6).toString('hex'));
  const cleanup = () => { try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {} };
  let counted = false;
  const release = () => { if (!counted) return; counted = false; _toolJobs = Math.max(0, _toolJobs - 1); const n = (_toolJobsByAcct.get(req.accountId) || 1) - 1; if (n <= 0) _toolJobsByAcct.delete(req.accountId); else _toolJobsByAcct.set(req.accountId, n); };
  try {
    if (!(await ffmpegAvailable())) return res.status(503).json({ error: 'ffmpeg is not installed on the server' });
    await rubberbandAvailable();   // decide pitch strategy
    const b = req.body || {};
    const project = b.project || {};
    const output = ['save', 'replace'].includes(b.output) ? b.output : 'save';
    const store = req.store, quota = req.account.quota_bytes;

    // ---- validate the v2 track project ----
    const tracks = Array.isArray(project.tracks) ? project.tracks.slice(0, MVE_LIMITS.tracks) : [];
    const overlays = Array.isArray(project.overlays) ? project.overlays.slice(0, MVE_LIMITS.overlays) : [];
    const W = Math.round(clampNum(project.w, 16, 7680, 1280)) & ~1;
    const H = Math.round(clampNum(project.h, 16, 4320, 720)) & ~1;
    const FPS = Math.round(clampNum(project.fps, 1, 60, 30));

    // gather all clips with their track kind / mute state
    const vClips = [], aClips = [];
    let clipCount = 0, parentForOut = null;
    for (const tr of tracks) {
      if (!tr || !Array.isArray(tr.clips)) continue;
      for (const c of tr.clips) {
        if (++clipCount > MVE_LIMITS.clips) break;
        const row = store.getById(String(c.fileId || ''));
        if (!row || !row.hasBlob) { cleanup(); return res.status(404).json({ error: 'a clip references a file that is not in your vault' }); }
        if (parentForOut == null) parentForOut = row.parent ?? null;
        const rec = { c, row, kind: tr.kind, trackMuted: !!tr.muted, trackHidden: !!tr.hidden };
        if (tr.kind === 'video' && !tr.hidden) vClips.push(rec);
        if (tr.kind === 'video' || tr.kind === 'audio') aClips.push(rec);   // both can contribute audio
      }
    }
    if (!vClips.length && !aClips.length) { cleanup(); return res.status(400).json({ error: 'add at least one clip' }); }

    // job caps (shared with the converters)
    const acctN = _toolJobsByAcct.get(req.accountId) || 0;
    if (_toolJobs >= TOOL_MAX_GLOBAL) return res.status(429).json({ error: 'server busy — try again shortly' });
    if (acctN >= TOOL_MAX_PER_ACCT) return res.status(429).json({ error: 'you already have a job running' });

    await fsp.mkdir(jobDir, { recursive: true });

    // ---- decrypt each unique source once; map fileId -> ffmpeg input index ----
    const fileIdx = new Map();
    const inputs = [];
    const allRecs = [...vClips, ...aClips];
    for (const rec of allRecs) {
      const fid = rec.row.id;
      if (fileIdx.has(fid)) continue;
      const ext = (path.extname(store.decName(rec.row)).slice(1) || rec.row.storedExt || 'mp4').toLowerCase();
      const p = path.join(jobDir, 'in' + fileIdx.size + '.' + ext);
      await decryptBlobToFile(store.blobPath(rec.row), store.keys, p);
      fileIdx.set(fid, inputs.length / 2);
      inputs.push('-i', p);
    }

    // output duration = end of the last clip across all tracks
    const clipEnd = (c) => clampNum(c.start, 0, MVE_LIMITS.totalDur, 0) + Math.max(0.02, clampNum(c.out, 0, MVE_LIMITS.totalDur, 0) - clampNum(c.in, 0, MVE_LIMITS.totalDur, 0));
    let outDur = 0;
    allRecs.forEach(({ c }) => { outDur = Math.max(outDur, clipEnd(c)); });
    outDur = Math.min(MVE_LIMITS.totalDur, Math.max(0.1, outDur));

    // a synthetic black base canvas as the bottom video layer (fills gaps).
    // NOTE: input index = number of -i flags so far (= number of decrypted files),
    // since the lavfi source adds extra -f/-t args, length/2 math wouldn't hold.
    const baseIdx = fileIdx.size;
    inputs.push('-f', 'lavfi', '-t', outDur.toFixed(3), '-i', `color=c=black:s=${W}x${H}:r=${FPS}`);

    // ---- decide which clips contribute video / audio ----
    // a linked video clip's OWN audio is represented by its linked audio clip, so
    // don't double-count it; skip a video clip's audio when it has a live link.
    const idById = new Map();
    aClips.forEach(rec => idById.set(rec.c.id, rec));
    const videoContribs = vClips.filter(r => !r.trackHidden);
    const audioContribs = aClips.filter(rec => {
      const c = rec.c;
      if (rec.trackMuted || c.mute) return false;
      if (rec.kind === 'video' && c.linkId && idById.has(c.linkId)) return false;   // its linked audio clip covers it
      return true;
    });

    // ---- fan out input streams that are consumed more than once (split/asplit) ----
    const vUse = new Map(), aUse = new Map();
    videoContribs.forEach(r => vUse.set(fileIdx.get(r.row.id), (vUse.get(fileIdx.get(r.row.id)) || 0) + 1));
    audioContribs.forEach(r => aUse.set(fileIdx.get(r.row.id), (aUse.get(fileIdx.get(r.row.id)) || 0) + 1));
    const fc = [];
    const vPool = {}, aPool = {};   // inputIdx -> [labels]
    vUse.forEach((n, idx) => { if (n > 1) { const labs = Array.from({ length: n }, (_, k) => `[vs${idx}_${k}]`); fc.push(`[${idx}:v]split=${n}${labs.join('')}`); vPool[idx] = labs; } });
    aUse.forEach((n, idx) => { if (n > 1) { const labs = Array.from({ length: n }, (_, k) => `[as${idx}_${k}]`); fc.push(`[${idx}:a]asplit=${n}${labs.join('')}`); aPool[idx] = labs; } });
    const vSrc = (idx) => vPool[idx] ? vPool[idx].shift() : `[${idx}:v]`;
    const aSrc = (idx) => aPool[idx] ? aPool[idx].shift() : `[${idx}:a]`;

    // ---- video composite: overlay each clip onto a black base ----
    let vlab = `[${baseIdx}:v]`;
    videoContribs.forEach((rec, i) => {
      const c = rec.c, idx = fileIdx.get(rec.row.id);
      const inP = clampNum(c.in, 0, MVE_LIMITS.sourceDur, 0);
      const outP = clampNum(c.out, inP + 0.02, MVE_LIMITS.sourceDur + 1, inP + 1);
      const start = clampNum(c.start, 0, outDur, 0);
      const clipLen = outP - inP;
      const fin = clampNum(c.fadeIn, 0, clipLen, 0), fout = clampNum(c.fadeOut, 0, clipLen, 0);
      // fade the picture at the clip edges. alpha=1 so the fade blends against whatever
      // is beneath (the black base, or a lower video clip) instead of hard black.
      let fadeFilters = '';
      if (fin > 0.01) fadeFilters += `,fade=t=in:st=${start.toFixed(3)}:d=${fin.toFixed(3)}:alpha=1`;
      if (fout > 0.01) fadeFilters += `,fade=t=out:st=${(start + clipLen - fout).toFixed(3)}:d=${fout.toFixed(3)}:alpha=1`;
      fc.push(`${vSrc(idx)}trim=start=${inP.toFixed(3)}:end=${outP.toFixed(3)},setpts=PTS-STARTPTS+${start.toFixed(3)}/TB,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuva420p${fadeFilters}[vc${i}]`);
      const out = `[vx${i}]`;
      fc.push(`${vlab}[vc${i}]overlay=enable='between(t,${start.toFixed(3)},${(start + (outP - inP)).toFixed(3)})':x=0:y=0:eof_action=pass${out}`);
      vlab = out;
    });

    // overlays: chain drawtext over the composite
    overlays.forEach((ov, i) => {
      const txt = drawtextEscape(String(ov.text || '').slice(0, MVE_LIMITS.textLen));
      if (!txt) return;
      const pos = MVE_POS[ov.pos] || MVE_POS.bc;
      const size = Math.round(clampNum(ov.size, 8, 200, 36));
      const st = clampNum(ov.start, 0, outDur, 0), en = clampNum(ov.end, 0, outDur, outDur);
      const col = ffColor(ov.color);
      const out = `[d${i}]`;
      fc.push(`${vlab}drawtext=text='${txt}':x=${pos.x}:y=${pos.y}:fontsize=${size}:fontcolor=${col}:borderw=2:bordercolor=0x000000:box=0:line_spacing=4:fix_bounds=1:enable='between(t,${st.toFixed(3)},${en.toFixed(3)})'${out}`);
      vlab = out;
    });
    fc.push(`${vlab}format=yuv420p[vout]`);

    // ---- audio: each contributing clip -> amix ----
    const amixLabels = [];
    audioContribs.forEach((rec, i) => {
      const idx = fileIdx.get(rec.row.id);
      const lab = `[am${i}]`;
      fc.push(mveAudioClipChain(aSrc(idx), rec.c, lab));
      amixLabels.push(lab);
    });

    const args = [...inputs, '-filter_complex'];
    let aout = null;
    if (amixLabels.length === 1) {
      // still pad to full duration via apad so audio doesn't end early
      fc.push(`${amixLabels[0]}apad,atrim=end=${outDur.toFixed(3)}[aout]`); aout = '[aout]';
    } else if (amixLabels.length > 1) {
      fc.push(`${amixLabels.join('')}amix=inputs=${amixLabels.length}:normalize=0:duration=longest[aout]`); aout = '[aout]';
    }
    args.push(fc.join(';'));
    args.push('-map', '[vout]');
    if (aout) args.push('-map', aout);
    args.push('-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    if (aout) args.push('-c:a', 'aac', '-b:a', '192k'); else args.push('-an');
    args.push('-t', outDur.toFixed(3), '-movflags', '+faststart', '-y', path.join(jobDir, 'out.mp4'));
    const outP = path.join(jobDir, 'out.mp4');

    _toolJobs++; _toolJobsByAcct.set(req.accountId, acctN + 1); counted = true;
    setToolProgress(req.accountId, { pct: 0, phase: 'processing' });
    const child = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => {
      const s = d.toString();
      if (stderr.length < 8000) stderr += s;
      const t = ffmpegTimeSecs(s);
      if (t != null && outDur) setToolProgress(req.accountId, { pct: Math.max(0, Math.min(99, Math.round(t / outDur * 100))), phase: 'processing' });
    });
    let timedOut = false, aborted = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, TOOL_TIMEOUT_MS);
    res.on('close', () => { if (!res.writableEnded) { aborted = true; killTree(child); } });
    child.on('error', () => {});
    child.on('close', async (code) => {
      clearTimeout(timer); release();
      try {
        if (aborted) { clearToolProgress(req.accountId); return cleanup(); }
        if (timedOut) { clearToolProgress(req.accountId); cleanup(); if (!res.headersSent) res.status(504).json({ error: 'export timed out' }); return; }
        let outStat = null;
        if (code === 0) { try { outStat = await fsp.stat(outP); } catch (e) {} }
        if (code !== 0 || !outStat) {
          clearToolProgress(req.accountId); cleanup();
          const msg = (stderr.split('\n').filter(Boolean).pop() || 'export failed').slice(0, 200);
          if (!res.headersSent) res.status(422).json({ error: msg });
          return;
        }
        const outSize = outStat.size;
        setToolProgress(req.accountId, { pct: 100, phase: 'saving' });
        const wantName = String(project.name || 'edit').replace(/[^\w.\- ]+/g, '_').slice(0, 80);

        if (output === 'replace' && b.replaceId) {
          const row = store.getById(String(b.replaceId));
          if (row && row.hasBlob) {
            const delta = Math.max(0, outSize - (row.size || 0));
            if (store.usedBytes() + delta > quota) { clearToolProgress(req.accountId); cleanup(); return limitError(res, store, quota); }
            await vault.encryptBlob(outP, store.blobPath(row), store.keys);
            const newName = (store.decName(row).replace(/\.[^.]+$/, '') || wantName) + '.mp4';
            store.db.prepare('UPDATE files SET name=@name, size=@size, storedExt=@ext, type=@type, dur=@dur, date=@date WHERE id=@id')
              .run({ name: vault.encText(newName, store.keys), size: outSize, ext: 'mp4', type: 'video', dur: (await ffprobeDuration(outP)) || null, date: Date.now(), id: row.id });
            store.bump(); clearToolProgress(req.accountId); cleanup();
            return res.json({ ok: true, output: 'replace', outSize, file: rowToApi(store.getById(row.id), store) });
          }
          // fall through to save if replaceId is stale
        }
        if (store.usedBytes() + outSize > quota) { clearToolProgress(req.accountId); cleanup(); return limitError(res, store, quota); }
        const id = uid();
        await vault.encryptBlob(outP, store.blobPath({ id }), store.keys);
        const newName = dedupeName(wantName + '.mp4', store, parentForOut ?? null);
        store.insertRow({ id, name: newName, type: 'video', parent: parentForOut ?? null, size: outSize, date: Date.now(), dur: (await ffprobeDuration(outP)) || null, hasBlob: 1, storedExt: 'mp4' });
        store.bump(); clearToolProgress(req.accountId); cleanup();
        return res.json({ ok: true, output: 'save', outSize, file: rowToApi(store.getById(id), store) });
      } catch (e) {
        clearToolProgress(req.accountId); cleanup();
        if (!res.headersSent) res.status(500).json({ error: 'finalize failed: ' + (e.message || 'error') });
      }
    });
  } catch (e) {
    release(); clearToolProgress(req.accountId); cleanup();
    if (!res.headersSent) res.status(500).json({ error: 'export error: ' + (e.message || '') });
  }
});

/* ---- public share consumption (no auth; scoped to the shared subtree) ---- */
function shareScope(ref) {
  // `ref` may be the random token or a custom slug — resolve either.
  const share = sysStmt.getShareByRef.get(ref, ref);
  if (!share) return null;
  // Per-user keys: after a restart, an enrolled owner's v2 data can't be served
  // until they sign in once (their UDK exists only in RAM). Callers turn
  // { asleep } into a friendly 503 instead of a misleading 404.
  const owner = sysStmt.getAcct.get(share.account_id);
  if (owner && owner.key_enrolled && !udkResident(owner.id)) return { asleep: true };
  const store = openStore(share.account_id);
  const root = store.getById(share.file_id);
  if (!root || root.trashed) return null;
  const allowed = new Set([root.id]);
  if (root.type === 'folder') for (const id of store.descendantIds(root.id)) { const r = store.getById(id); if (r && !r.trashed) allowed.add(id); }
  return { share, store, root, allowed };
}
app.get('/api/shares/:token', (req, res) => {
  const scope = shareScope(req.params.token);
  if (!scope) return res.status(404).json({ error: 'link not found' });
  if (scope.asleep) return res.status(503).json({ error: 'this share is waking up — its owner needs to sign in once', code: 'SHARE_ASLEEP' });
  const items = [...scope.allowed].map(id => {
    // include content inline for shares: a share is one bounded subtree (not the whole
    // vault, so the payload concern doesn't apply), and the public share viewer has no
    // authenticated /content route to fall back on for content-backed docs.
    const out = rowToApi(scope.store.getById(id), scope.store, true);
    if (out.url) out.url = `/api/shares/${req.params.token}/files/${id}/raw`;
    if (out.coverUrl) out.coverUrl = `/api/shares/${req.params.token}/files/${id}/cover`;
    if (id === scope.root.id) out.parent = null;
    return out;
  });
  res.json({ root: { id: scope.root.id, name: scope.store.decName(scope.root), type: scope.root.type }, allowDownload: !!scope.share.allow_download, items });
});
app.get('/api/shares/:token/files/:id/raw', (req, res) => {
  const scope = shareScope(req.params.token);
  if (scope && scope.asleep) return res.status(503).end();
  if (!scope || !scope.allowed.has(req.params.id)) return res.status(404).end();
  streamEncrypted(req, res, scope.store, scope.store.getById(req.params.id), 'blob');
});
/* ---------- RAW hotlink: /r/<token-or-slug>.<ext> ----------
   A short, extension-carrying direct URL to a shared FILE's bytes — the form
   Discord/Twitter/iMessage need to unfurl+inline-play an embed (they key off the
   trailing .mp4/.png/etc.). The extension is cosmetic: we resolve the share by the
   ref before the last dot and stream the root file. Only file (not folder) shares
   have a raw url; view-only shares (downloads disabled) still stream inline for
   embedding — "view-only" gates the download BUTTON, not hotlinking, same as today
   for the /s viewer's <video>/<img>. */
app.get('/r/:ref', (req, res) => {
  const raw = String(req.params.ref || '');
  const dot = raw.lastIndexOf('.');
  const ref = dot > 0 ? raw.slice(0, dot) : raw;   // strip cosmetic extension
  const scope = shareScope(ref);
  if (scope && scope.asleep) return res.status(503).end();
  if (!scope || scope.root.type === 'folder') return res.status(404).end();
  streamEncrypted(req, res, scope.store, scope.root, 'blob');
});
app.get('/api/shares/:token/files/:id/cover', (req, res) => {
  const scope = shareScope(req.params.token);
  if (scope && scope.asleep) return res.status(503).end();
  if (!scope || !scope.allowed.has(req.params.id)) return res.status(404).end();
  streamEncrypted(req, res, scope.store, scope.store.getById(req.params.id), 'cover');
});

/* ---------- share page with Open Graph tags (Discord / social embeds) ----------
   Discord, Twitter, iMessage, etc. don't run JS — they read <meta> tags from the
   HTML. We inject per-file Open Graph + Twitter tags so a shared link unfurls into
   a rich card, and for video/audio a `twitter:player` so it plays inline without
   opening the link. The app shell itself still boots normally for real visitors. */
let _indexHtmlCache = null;
function indexHtml(nonce) {
  if (_indexHtmlCache == null) _indexHtmlCache = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // Stamp the per-request CSP nonce into every `nonce="__CSP_NONCE__"` placeholder
  // so the inline importmap + tweaks-boot script match the script-src nonce. A
  // missing nonce (token left unreplaced) would silently block those scripts, so
  // fall back to empty — but in practice the header middleware always provides one.
  return _indexHtmlCache.replace(/__CSP_NONCE__/g, nonce || '');
}

/* Simplex Visual — the lean standalone Play page. Stamps the CSP nonce onto its
   inline boot script and injects the project id. Auth is the normal session
   cookie (SameSite=Lax, so a top-level nav to /visual/play/<id> carries it); the
   page's own fetch to /api/visual/projects/<id> then succeeds or shows a message. */
let _playHtmlCache = null;
function playHtml(nonce, projectId) {
  if (_playHtmlCache == null) _playHtmlCache = fs.readFileSync(path.join(ROOT, 'play.html'), 'utf8');
  return _playHtmlCache
    .replace(/__CSP_NONCE__/g, nonce || '')
    .replace(/__PROJECT_ID__/g, String(projectId || '').replace(/[^a-zA-Z0-9_-]/g, ''));
}
function htmlAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function originFor(req) {
  const proto = (req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}
/* The host's own LAN IPv4 — for the "reachable at" startup banner so a phone/other
   machine on the same network can hit http://<lan-ip>:PORT directly (bypassing
   Cloudflare, hence no ~100MB upload cap). Prefers a private-range address on a
   non-internal, up interface; falls back to localhost if the box is offline. */
function lanIPv4() {
  const nets = os.networkInterfaces();
  const priv = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.internal || ni.family !== 'IPv4') continue;
      const ip = ni.address;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) priv.push(ip);
      else priv.push(ip);   // a routable IPv4 (rare on a LAN) is still better than nothing
    }
  }
  // prefer a 192.168.x / 10.x address (the usual home-LAN ranges) if we found one
  const home = priv.find(ip => /^(192\.168\.|10\.)/.test(ip));
  return home || priv[0] || 'localhost';
}
function kindFromExt(ext) {
  ext = String(ext || '').toLowerCase().replace(/^\./, '');
  if (['mp4', 'webm', 'mkv', 'mov'].includes(ext)) return 'video';
  if (['mp3', 'flac', 'wav', 'm4a', 'ogg'].includes(ext)) return 'audio';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'exr', 'tif', 'tiff'].includes(ext)) return 'image';
  return 'other';
}
function ogTagsForShare(scope, token, origin) {
  const root = scope.root;
  const name = scope.store.decName(root);
  const url = `${origin}/s/${token}`;
  const siteName = 'Simplex';
  const T = [];
  const tag = (p, c, prop = true) => T.push(`<meta ${prop ? 'property' : 'name'}="${htmlAttr(p)}" content="${htmlAttr(c)}" />`);
  tag('og:site_name', siteName);
  tag('og:title', name);
  tag('og:url', url);
  tag('theme-color', '#e0a64a', false);

  if (root.type === 'folder') {
    tag('og:type', 'website');
    const n = scope.allowed.size - 1;
    tag('og:description', `Shared folder · ${n} item${n !== 1 ? 's' : ''}`, false);
    tag('twitter:card', 'summary', false);
    return T.join('\n');
  }

  const ext = (root.storedExt || path.extname(name) || '').toLowerCase();
  const kind = kindFromExt(ext);
  const rawUrl = `${origin}/api/shares/${token}/files/${root.id}/raw`;
  const coverUrl = root.hasCover ? `${origin}/api/shares/${token}/files/${root.id}/cover` : null;
  const mime = mimeFor(ext);
  const sizeStr = root.size ? ` · ${(root.size / 1e6).toFixed(1)} MB` : '';
  tag('og:type', kind === 'video' ? 'video.other' : kind === 'audio' ? 'music.song' : 'website');
  tag('og:description', `${(ext ? ext.replace('.', '').toUpperCase() + ' file' : 'File')}${sizeStr} · shared from ${siteName}`, false);

  if (kind === 'image') {
    tag('og:image', rawUrl);
    if (root.w) tag('og:image:width', String(root.w));
    if (root.h) tag('og:image:height', String(root.h));
    tag('twitter:card', 'summary_large_image', false);
    tag('twitter:image', rawUrl, false);
  } else if (kind === 'video') {
    // og:video makes Discord show an inline player
    tag('og:video', rawUrl);
    tag('og:video:secure_url', rawUrl);
    tag('og:video:type', mime);
    if (root.w) tag('og:video:width', String(root.w));
    if (root.h) tag('og:video:height', String(root.h));
    if (coverUrl) tag('og:image', coverUrl);
    tag('twitter:card', 'player', false);
    tag('twitter:player', `${origin}/s/${token}`, false);
    if (root.w) tag('twitter:player:width', String(root.w), false);
    if (root.h) tag('twitter:player:height', String(root.h), false);
    tag('twitter:player:stream', rawUrl, false);
    tag('twitter:player:stream:content_type', mime, false);
  } else if (kind === 'audio') {
    tag('og:audio', rawUrl);
    tag('og:audio:secure_url', rawUrl);
    tag('og:audio:type', mime);
    if (coverUrl) tag('og:image', coverUrl);
    tag('twitter:card', coverUrl ? 'summary_large_image' : 'summary', false);
    if (coverUrl) tag('twitter:image', coverUrl, false);
  } else {
    tag('twitter:card', 'summary', false);
  }
  return T.join('\n');
}

app.get('/s/:token', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  const scope = shareScope(req.params.token);
  // asleep (owner's keys not resident) renders the app shell too — the client's
  // share API call gets the 503 + SHARE_ASLEEP and explains it in place
  if (!scope || scope.asleep) return res.type('html').send(indexHtml(res.locals.cspNonce));
  let head = '';
  try { head = ogTagsForShare(scope, req.params.token, originFor(req)); } catch (e) { head = ''; }
  const name = scope.store.decName(scope.root);
  // inject OG tags + a descriptive <title> right after <head>
  const html = indexHtml(res.locals.cspNonce).replace(
    /<title>.*?<\/title>/i,
    `<title>${htmlAttr(name)} · SIMPLEX</title>\n${head}`
  );
  res.type('html').send(html);
});
// Simplex Visual — the standalone Play page. Served BEFORE the SPA fallback so
// /visual/play/<id> boots the lean game page, not the full app shell. The page
// itself is public HTML (no vault data); the project it fetches is auth-gated by
// the normal /api requireAuth, so an unauthenticated open shows a sign-in message.
app.get('/visual/play/:id', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.type('html').send(playHtml(res.locals.cspNonce, req.params.id));
});
// Serve the app shell through indexHtml() (CSP-nonce stamped) for the canonical
// entry points, BEFORE express.static can hand back the raw, un-nonced file.
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.type('html').send(indexHtml(res.locals.cspNonce));
});
app.use(express.static(ROOT, {
  // Never let the static handler serve the raw index.html — it would bypass the
  // per-request CSP-nonce stamping in indexHtml() and ship an un-noncED page whose
  // inline importmap/tweaks-boot scripts the CSP then blocks. All HTML delivery
  // (`/`, `/index.html`, `/s/:token`, and the SPA fallback below) goes through
  // indexHtml() instead.
  index: false,
  etag: true, lastModified: true,
  setHeaders: (res, filePath) => {
    // App source (html/js/jsx/css) must NEVER be served stale — a cached copy in an
    // open tab is how a fix or instrumentation change silently fails to take effect.
    // `no-store` forces the browser to fetch fresh bytes on every load (no 304
    // reuse), so a plain reload always runs the latest code.
    if (/\.(html|js|jsx|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store, must-revalidate');
  },
}));
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  // SPA client routing: extensionless GET paths (e.g. /dash, /database/music, /ai)
  // serve the app shell so the in-page router can handle them. Missing real assets
  // (paths with a file extension) still 404.
  if (req.method === 'GET' && !path.extname(req.path)) {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');   // never serve a stale app shell
    return res.type('html').send(indexHtml(res.locals.cspNonce));
  }
  res.status(404).sendFile(path.join(ROOT, '404.html'));
});

/* keep the vault up: a dropped socket / broken pipe must never crash the process */
process.on('uncaughtException', (err) => {
  if (['EPIPE', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(err && err.code)) return;
  console.error('[simplex] uncaughtException', err);
  diagFatal('uncaughtException', err);   // record real errors in vault/diag.log
});
process.on('unhandledRejection', (err) => { console.error('[simplex] unhandledRejection', err); diagFatal('unhandledRejection', err); });

/* ---------- start ---------- */
let httpServer = null;   // module-level so /api/health + /api/_diag can read live connection count
bootstrap().then(() => {
  /* Local AI engine: point it at the configured (or default <ROOT>/models) folder
     and wipe any orphaned decrypted-model scratch. Non-fatal — if the vendored
     binary is missing the feature just reports "unavailable". */
  try {
    localAI.init({ modelsDir: getSetting('ai.models_dir') || path.join(ROOT, 'models') });
    // apply any admin-saved thermal thresholds (else env/defaults stand)
    const tripC = parseFloat(getSetting('ai.thermal_trip_c'));
    const resumeC = parseFloat(getSetting('ai.thermal_resume_c'));
    localAI.thermalConfigure({
      tripC: Number.isFinite(tripC) ? tripC : undefined,
      resumeC: Number.isFinite(resumeC) ? resumeC : undefined,
    });
    console.log(`[simplex] local AI engine ${localAI.engineAvailable() ? 'ready' : 'unavailable (binary not found)'} — models dir: ${localAI.getModelsDir()}`);
  } catch (e) { console.error('[simplex] local AI engine init failed', e); }

  /* Discord bot: autostart if an admin enabled it and a token is saved. Async +
     non-fatal — a bad token or missing deps just shows up in the app's status. */
  try {
    if (discordConfig().enabled && getSecret('discord.bot_token')) {
      discordBot.start().then(s => console.log(`[simplex] discord bot ${s.running ? 'started' : 'failed to start'}${s.lastError ? ' — ' + s.lastError : ''}`));
    }
  } catch (e) { console.error('[simplex] discord bot autostart failed', e); }

  const server = app.listen(PORT, () => {
    const lan = lanIPv4();
    // Two places the app is reachable: the public Cloudflare domain (safe, TLS,
    // but ~100MB/request cap) and a direct LAN IP (no proxy, no upload cap).
    console.log(`[simplex] serving — reachable at:`);
    console.log(`[simplex]   https://data.guythatlives.net/   (safe · via Cloudflare)`);
    console.log(`[simplex]   http://${lan}:${PORT}   (direct · no upload limit)`);
  });
  httpServer = server;
  /* Connection hygiene — a stalled or half-open socket (common over a
     Cloudflare tunnel or flaky Wi-Fi) must not pin a connection forever, or
     they pile up until the server can't accept new ones while still "running". */
  server.keepAliveTimeout = 65_000;     // retire idle keep-alive sockets (> typical proxy idle)
  server.headersTimeout = 70_000;       // slow-loris guard on request headers (> keepAliveTimeout)
  server.requestTimeout = 0;            // no cap on a full request — large uploads + long streams are legitimate
  server.maxConnections = 1024;         // hard ceiling so a connection flood can't exhaust host fds

  /* Per-socket INACTIVITY timeout. Reclaims a socket that goes SILENT with NO
     request in flight — i.e. a genuinely abandoned/stalled client (track change,
     tab hidden, tunnel drop) holding a connection. requestTimeout=0 never caps it
     and keepAliveTimeout only covers BETWEEN requests, so without this such
     sockets pile up until the server can't accept new connections (incl. health).

     CRUCIAL: it must NOT destroy a socket that has a request actively being
     handled. An upload's body can be fully received while the server spends >45s
     ENCRYPTING it with zero bytes on the wire — that socket looks "idle" but is
     very much alive. Destroying it cancelled the upload while the server kept
     working on an orphaned request (and the abrupt teardown could wedge things).
     So when the timer fires we check `_sxBusy`: if a request is in flight we just
     re-arm and let it finish; only a truly request-less idle socket is dropped.
     An actively flowing transfer also resets the OS-level timer on every packet. */
  const SOCKET_IDLE_MS = Number(process.env.SX_SOCKET_IDLE_MS) || 45_000;
  let socketsDropped = 0;
  server.on('connection', (socket) => {
    socket.setTimeout(SOCKET_IDLE_MS, () => {
      if (socket._sxBusy > 0) {
        // a request (e.g. an upload mid-encryption) is still being handled — keep it
        socket.setTimeout(SOCKET_IDLE_MS);   // re-arm; re-check after another idle window
        return;
      }
      socketsDropped++;
      console.warn(`[simplex] socket idle ${SOCKET_IDLE_MS}ms, no request in flight — reclaiming (open=${server._connections ?? '?'} droppedTotal=${socketsDropped})`);
      socket.destroy();
    });
  });

  /* Connection-count visibility: log whenever open connections cross a high-water
     mark, so a pile-up is SEEN as it builds instead of discovered as a freeze. */
  let connHigh = 0;
  setInterval(() => {
    server.getConnections((err, n) => {
      if (err) return;
      diag.connections = n;
      if (n > connHigh) { connHigh = n; if (n >= 50 && n % 25 === 0) console.warn(`[simplex] OPEN CONNECTIONS high-water: ${n}`); }
      if (n >= server.maxConnections - 32) console.warn(`[simplex] CONNECTIONS NEAR CAP: ${n}/${server.maxConnections} — new connections may be refused`);
    });
  }, 5_000).unref();
}).catch((e) => { console.error('[simplex] bootstrap failed', e); process.exit(1); });

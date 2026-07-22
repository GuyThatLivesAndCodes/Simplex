/* ============================================================
   SIMPLEX — one-time importer: legacy single vault -> admin account,
   with at-rest encryption of every blob.
   ------------------------------------------------------------
   - Creates the master key (if absent), system.sqlite, and an admin
     account (username "admin", password "1234") if none exists.
   - Imports vault/simplex.sqlite rows into the admin account's DB,
     encrypting text columns (name/content/artist/album).
   - Encrypts every referenced plaintext blob in vault/files into
     vault/accounts/<admin>/files/<id>.enc, VERIFIES (header size +
     decrypted tail), then deletes the plaintext original.
   - Idempotent / resumable: re-running skips finished blobs and cleans
     up any leftover plaintext whose .enc already exists.
   - On success the legacy DB is renamed to _imported_*.sqlite.
   ============================================================ */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vault = require('./crypto');

const VAULT = path.join(__dirname, 'vault');
const FILES = path.join(VAULT, 'files');
const ACCTS = path.join(VAULT, 'accounts');
const SYS = path.join(VAULT, 'system.sqlite');
const LEGACY = path.join(VAULT, 'simplex.sqlite');
const DEFAULT_QUOTA = 200 * 1e9;

const COLS = ['id', 'name', 'type', 'parent', 'size', 'date', 'trashed', 'starred',
  'content', 'lang', 'dur', 'w', 'h', 'artist', 'album', 'hasBlob', 'storedExt', 'hasCover', 'coverExt'];
const TEXT_COLS = ['name', 'content', 'artist', 'album'];
const FILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, parent TEXT,
  size INTEGER NOT NULL DEFAULT 0, date INTEGER NOT NULL,
  trashed INTEGER NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0,
  content TEXT, lang TEXT, dur REAL, w INTEGER, h INTEGER, artist TEXT, album TEXT,
  hasBlob INTEGER NOT NULL DEFAULT 0, storedExt TEXT,
  hasCover INTEGER NOT NULL DEFAULT 0, coverExt TEXT
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
    hasBlob: o.hasBlob ? 1 : 0, storedExt: o.storedExt ?? null,
    hasCover: o.hasCover ? 1 : 0, coverExt: o.coverExt ?? null,
  };
}
function readRange(encPath, keys, s, e) {
  return new Promise((res, rej) => {
    const r = vault.decryptBlobRange(encPath, keys, s, e);
    if (!r) return rej(new Error('no header'));
    const b = []; r.stream.on('data', d => b.push(d)); r.stream.on('end', () => res(Buffer.concat(b))); r.stream.on('error', rej);
  });
}
function plaintextTail(src, n) {
  const size = fs.statSync(src).size, len = Math.min(n, size), buf = Buffer.alloc(len);
  const fd = fs.openSync(src, 'r');
  try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
  return buf;
}

(async () => {
  const master = vault.loadMasterKey(VAULT);
  const keyring = vault.makeKeyring(master);

  // system DB + admin
  fs.mkdirSync(ACCTS, { recursive: true });
  const sys = new Database(SYS);
  sys.pragma('journal_mode = WAL');
  sys.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display TEXT,
      pw_salt BLOB NOT NULL, pw_hash BLOB NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0, quota_bytes INTEGER NOT NULL DEFAULT ${DEFAULT_QUOTA},
      avatar_color TEXT, created INTEGER NOT NULL );
    CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT );
    CREATE TABLE IF NOT EXISTS shares (
      token TEXT PRIMARY KEY, account_id TEXT NOT NULL, file_id TEXT NOT NULL,
      created INTEGER NOT NULL, allow_download INTEGER NOT NULL DEFAULT 1 );
    CREATE INDEX IF NOT EXISTS idx_shares_acct ON shares(account_id);
  `);
  let admin = sys.prepare('SELECT * FROM accounts WHERE is_admin = 1 ORDER BY created LIMIT 1').get();
  if (!admin) {
    const id = 'a' + crypto.randomBytes(6).toString('hex');
    const { salt, hash } = vault.hashPassword('1234');
    sys.prepare(`INSERT INTO accounts (id,username,display,pw_salt,pw_hash,is_admin,quota_bytes,avatar_color,created)
                 VALUES (?,?,?,?,?,1,?,?,?)`).run(id, 'admin', 'Admin', salt, hash, DEFAULT_QUOTA, '#e0a64a', Date.now());
    admin = sys.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    console.log('created admin account (username "admin", password "1234")');
  }
  const adminId = admin.id;
  const keys = keyring(adminId);

  // admin store
  const adir = path.join(ACCTS, adminId), afiles = path.join(adir, 'files');
  fs.mkdirSync(afiles, { recursive: true });
  fs.mkdirSync(path.join(adir, 'tmp'), { recursive: true });
  const adb = new Database(path.join(adir, 'simplex.sqlite'));
  adb.pragma('journal_mode = WAL');
  adb.exec(FILES_SCHEMA);

  // import legacy metadata + shares
  if (fs.existsSync(LEGACY)) {
    const ldb = new Database(LEGACY, { readonly: true });
    const rows = ldb.prepare('SELECT * FROM files').all();
    let lshares = []; try { lshares = ldb.prepare('SELECT * FROM shares').all(); } catch (e) {}
    ldb.close();
    const ins = adb.prepare(`INSERT OR IGNORE INTO files (${COLS.join(',')}) VALUES (${COLS.map(c => '@' + c).join(',')})`);
    adb.transaction(() => {
      for (const r of rows) {
        const o = { ...r, hasCover: 0, coverExt: null };
        for (const c of TEXT_COLS) if (o[c] != null) o[c] = vault.encText(o[c], keys);
        ins.run(rowForInsert(o));
      }
    })();
    console.log(`imported ${rows.length} metadata rows into admin DB`);
    const sin = sys.prepare('INSERT OR IGNORE INTO shares (token,account_id,file_id,created,allow_download) VALUES (?,?,?,?,?)');
    for (const s of lshares) { try { sin.run(s.token, adminId, s.file_id, s.created || Date.now(), s.allow_download ? 1 : 0); } catch (e) {} }
    if (lshares.length) console.log(`imported ${lshares.length} shares`);
  }

  // encrypt blobs referenced by the admin DB
  const blobRows = adb.prepare('SELECT id, storedExt FROM files WHERE hasBlob = 1').all();
  let enc = 0, skip = 0, miss = 0, fail = 0, bytes = 0;
  for (const r of blobRows) {
    const dest = path.join(afiles, r.id + '.enc');
    const src = path.join(FILES, r.id + (r.storedExt || ''));
    if (fs.existsSync(dest)) {
      const h = vault.readBlobHeader(dest);
      if (h && (!fs.existsSync(src) || h.size === fs.statSync(src).size)) {
        if (fs.existsSync(src)) fs.unlinkSync(src);
        skip++; continue;
      }
      try { fs.unlinkSync(dest); } catch (e) {}
    }
    if (!fs.existsSync(src)) { miss++; console.log(`MISSING  ${r.id}${r.storedExt || ''}`); continue; }
    const ssize = fs.statSync(src).size;
    process.stdout.write(`ENCRYPT  ${r.id}${r.storedExt || ''}  ${(ssize / 1e6).toFixed(0)}MB ... `);
    try {
      await vault.encryptBlob(src, dest, keys);
      const h = vault.readBlobHeader(dest);
      if (!h || h.size !== ssize) throw new Error('size verify failed');
      const decTail = await readRange(dest, keys, Math.max(0, ssize - 64), ssize - 1);
      if (!decTail.equals(plaintextTail(src, 64))) throw new Error('tail verify failed');
      fs.unlinkSync(src);
      enc++; bytes += ssize; console.log('ok + verified, plaintext removed');
    } catch (e) {
      fail++; try { fs.unlinkSync(dest); } catch (_) {}
      console.log('FAILED:', e.message);
    }
  }
  adb.close();

  if (fail === 0 && fs.existsSync(LEGACY)) {   // retire legacy only on a clean run
    const st = Date.now();
    for (const ext of ['', '-wal', '-shm']) { const p = LEGACY + ext; if (fs.existsSync(p)) try { fs.renameSync(p, path.join(VAULT, `_imported_${st}_simplex.sqlite${ext}`)); } catch (e) {} }
  }
  console.log(`\nDONE — encrypted ${enc} (${(bytes / 1e9).toFixed(2)} GB), skipped ${skip}, missing ${miss}, failed ${fail}`);
  const left = fs.existsSync(FILES) ? fs.readdirSync(FILES).filter(f => !f.startsWith('.')) : [];
  console.log(`plaintext remaining in vault/files: ${left.length}`);
  sys.close();
})().catch(e => { console.error('migrate failed:', e); process.exit(1); });

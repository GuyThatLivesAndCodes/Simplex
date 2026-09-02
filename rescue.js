#!/usr/bin/env node
/* ============================================================
   SIMPLEX — vault rescue / forensics CLI

   For the "I copied another vault over this one" accident. It answers the two
   questions that decide whether data comes back, and then puts the accounts
   back together.

   HOW A SIMPLEX VAULT IS PUT TOGETHER (why the accident is usually survivable):

     vault/keys/master.key      32 bytes. Everything hangs off this.
     vault/system.sqlite        accounts (logins + per-user key wraps), shares.
     vault/accounts/<id>/       ONE FOLDER PER ACCOUNT, named by account id:
         simplex.sqlite           file metadata (names encrypted at rest)
         files/<fileId>.enc       the actual bytes

   A per-account folder is named by its account id, so copying a DIFFERENT
   vault over this one usually does NOT touch the old accounts' folders — the
   ids don't collide, so the old folders just sit there beside the new ones.
   That is the 100 GB you can still see. What the copy DID replace is
   system.sqlite, which is why the logins are gone: the files are fine, the
   rows naming who owns them are not.

   Two things decide how much comes back:

     1. Is vault/keys/master.key still the ORIGINAL one?
        v1 ("legacy", SXB1/enc:) data is encrypted with keys derived from
        master key + account id. Right key + folder name = fully readable,
        no accounts row needed. Wrong key = nothing is readable, and no
        amount of database repair changes that. `scan` tells you which.

     2. Do you still have the ORIGINAL system.sqlite?
        v2 (SXB2/enc2:) data is encrypted under a per-user key that exists on
        disk ONLY wrapped inside that account's row. Lose the row and v2 data
        is gone with it, even holding the master key. `scan` reports the v1/v2
        split per account so you know what is at stake.

   Usage:
     node rescue.js scan [--deep]          read-only report. START HERE.
     node rescue.js try-key <hex|file> [--account <id>]
                                           test a candidate master key against
                                           the data on disk WITHOUT installing it
     node rescue.js adopt <accountId> --username <u> --password <p> [--admin]
                                           rebuild the login for a surviving
                                           account folder (keeps the id, so the
                                           v1 keys still derive)
     node rescue.js orphan-blobs <accountId>
                                           list .enc blobs the account's DB no
                                           longer mentions (folder-id collision)

   `scan`, `try-key` and `orphan-blobs` never write. `adopt` backs up
   system.sqlite before touching it. Nothing here ever deletes.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const vault = require('./crypto');

const ROOT = __dirname;
const VAULT_DIR = process.env.SIMPLEX_VAULT_DIR ? path.resolve(process.env.SIMPLEX_VAULT_DIR) : path.join(ROOT, 'vault');
const ACCOUNTS_DIR = path.join(VAULT_DIR, 'accounts');
const SYSTEM_DB_PATH = path.join(VAULT_DIR, 'system.sqlite');
const DEFAULT_QUOTA = 200 * 1e9;

const args = process.argv.slice(2);
const cmd = (args[0] || '').toLowerCase();
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.slice(1).filter(a => !a.startsWith('--'));
function opt(name) { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; }
function die(msg) { console.error('\n  ' + msg + '\n'); process.exit(1); }
function fingerprint(key) { return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16); }
function fmtSize(b) {
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
  return b + ' B';
}
function mtime(p) { try { return new Date(fs.statSync(p).mtime).toISOString().replace('T', ' ').slice(0, 19); } catch (e) { return null; } }

/* ---------- read-only helpers ---------- */

/* Open a SQLite file read-only. Never creates, never migrates, never takes a
   write lock — safe to point at a database mid-incident. */
function openRO(file) {
  if (!fs.existsSync(file)) return null;
  try { return new Database(file, { readonly: true, fileMustExist: true }); }
  catch (e) { return { _err: e.message }; }
}
function tableExists(db, name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  catch (e) { return false; }
}

/* Recursive size + file count of a directory (the blobs are the bulk). */
function dirStats(dir) {
  let bytes = 0, files = 0;
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { bytes += fs.statSync(p).size; files++; } catch (_) {} }
    }
  };
  walk(dir);
  return { bytes, files };
}

/* THE key test. `name` columns are stored encrypted; decText hands a value back
   UNCHANGED when it can't decrypt it. So: pull a few names from the account's
   own database, decrypt with keys derived from `key` + this account id, and see
   whether they actually turned into text. This tests the key against the DATA on
   disk, which is the only test that matters — `key.js verify` only tells you
   whether a key matches the key file, not whether it opens the vault. */
function keyOpensAccount(key, accountId, accDb, sample = 40) {
  if (!accDb || accDb._err || !tableExists(accDb, 'files')) return null;
  let rows;
  try { rows = accDb.prepare("SELECT name FROM files WHERE name LIKE 'enc:%' LIMIT ?").all(sample); }
  catch (e) { return null; }
  if (!rows.length) return null;   // nothing v1-encrypted to test against
  const keys = { v1: vault.makeKeyring(key)(accountId), v2: null };
  let ok = 0;
  for (const r of rows) {
    const out = vault.decText(r.name, keys);
    if (typeof out === 'string' && !out.startsWith('enc:')) ok++;
  }
  return { tested: rows.length, decrypted: ok, match: ok > 0 && ok === rows.length };
}

/* Per-account inventory, read-only. */
function inspectAccount(id, key, deep) {
  const dir = path.join(ACCOUNTS_DIR, id);
  const dbPath = path.join(dir, 'simplex.sqlite');
  const filesDir = path.join(dir, 'files');
  const info = {
    id, dir,
    dbExists: fs.existsSync(dbPath),
    dbMtime: mtime(dbPath),
    hasWal: fs.existsSync(dbPath + '-wal'),
    walMtime: mtime(dbPath + '-wal'),
    rows: 0, v1: 0, v2: 0, folders: 0, bytes: 0,
    blobCount: 0, blobBytes: 0,
    keyOpens: null, orphanBlobs: null, err: null,
  };
  if (fs.existsSync(filesDir)) {
    const s = dirStats(filesDir);
    info.blobCount = s.files; info.blobBytes = s.bytes;
  }
  const db = openRO(dbPath);
  if (!db) return info;
  if (db._err) { info.err = db._err; return info; }
  try {
    if (tableExists(db, 'files')) {
      const t = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(size),0) n FROM files WHERE type != 'folder'").get();
      info.rows = t.c; info.bytes = t.n;
      info.folders = db.prepare("SELECT COUNT(*) c FROM files WHERE type = 'folder'").get().c;
      // key generation split: kv=1 needs only the master key, kv=2 needs the
      // account row's wrapped UDK as well
      try {
        for (const r of db.prepare('SELECT COALESCE(kv,1) k, COUNT(*) c FROM files GROUP BY k').all()) {
          if (r.k === 2) info.v2 = r.c; else info.v1 += r.c;
        }
      } catch (e) { info.v1 = info.rows; }
      if (key) info.keyOpens = keyOpensAccount(key, id, db);
      if (deep && fs.existsSync(filesDir)) {
        // blobs on disk that the metadata DB no longer mentions — the signature
        // of a folder-id COLLISION, where the copy replaced simplex.sqlite but
        // left the bytes behind
        const known = new Set(db.prepare('SELECT id FROM files').all().map(r => r.id));
        let orphans = 0, orphanBytes = 0;
        for (const f of fs.readdirSync(filesDir)) {
          const m = f.match(/^([^.]+)\.enc$/);
          if (!m || known.has(m[1])) continue;
          orphans++;
          try { orphanBytes += fs.statSync(path.join(filesDir, f)).size; } catch (_) {}
        }
        info.orphanBlobs = { count: orphans, bytes: orphanBytes };
      }
    }
  } catch (e) { info.err = e.message; }
  db.close();
  return info;
}

/* ---------- scan ---------- */
function cmdScan() {
  const deep = flags.has('--deep');
  console.log('\n==================================================================');
  console.log('  SIMPLEX vault rescue — read-only scan');
  console.log('  vault: ' + VAULT_DIR);
  console.log('==================================================================\n');

  if (!fs.existsSync(VAULT_DIR)) die('no vault directory at ' + VAULT_DIR);

  /* ---- 1. the master key ---- */
  console.log('MASTER KEY');
  let key = null, keySource = null;
  try {
    const info = vault.readExistingMasterKey(VAULT_DIR);
    if (info) { key = info.key; keySource = info.source; }
  } catch (e) { console.log('  ERROR: ' + e.message); }
  if (!key) {
    console.log('  !! NO MASTER KEY FOUND.');
    console.log('     Do NOT start the server: it would generate a brand new one');
    console.log('     and the old data would be permanently unreadable.');
    console.log('     Find your backup and install it with:  node key.js restore <file-or-hex>');
  } else {
    console.log('  source      : ' + keySource);
    console.log('  fingerprint : ' + fingerprint(key));
    const kp = vault.keyFilePath(VAULT_DIR);
    if (fs.existsSync(kp)) {
      console.log('  file mtime  : ' + mtime(kp));
      console.log('                (NOT proof of anything on Windows: Explorer preserves the');
      console.log('                 SOURCE file\'s timestamp on copy, so a replaced key keeps');
      console.log('                 the other vault\'s date. Trust the key tests below instead.)');
    }
    if (process.env.SIMPLEX_MASTER_KEY) console.log('  note        : SIMPLEX_MASTER_KEY is set and overrides the file.');
  }
  console.log('');

  /* ---- 2. the system database (accounts) ---- */
  console.log('SYSTEM DB (accounts / logins)');
  console.log('  path   : ' + SYSTEM_DB_PATH);
  console.log('  exists : ' + fs.existsSync(SYSTEM_DB_PATH) + (fs.existsSync(SYSTEM_DB_PATH) ? '   mtime ' + mtime(SYSTEM_DB_PATH) : ''));
  let walNewer = false;
  for (const suffix of ['-wal', '-shm']) {
    const p = SYSTEM_DB_PATH + suffix;
    if (!fs.existsSync(p)) continue;
    let newer = false;
    try { newer = fs.statSync(p).mtimeMs > fs.statSync(SYSTEM_DB_PATH).mtimeMs + 1000; } catch (e) {}
    if (newer) walNewer = true;
    console.log('  ' + suffix.slice(1) + '    : present, mtime ' + mtime(p) + (newer ? '   <- NEWER than the db itself' : ''));
  }
  if (walNewer) {
    console.log('');
    console.log('  !! The -wal is NEWER than system.sqlite. That is the signature of a file');
    console.log('     copy dropping a database in underneath a WAL the running server was');
    console.log('     still writing — the two no longer belong together.');
    console.log('     SQLite REPLAYS a WAL on open, and replaying a foreign one can leave the');
    console.log('     database unreadable. Do not start the server until you have run:');
    console.log('         node rescue.js wal-check');
    console.log('     It tests both combinations on COPIES and tells you which is real.');
  }
  const accounts = new Map();
  const sysdb = openRO(SYSTEM_DB_PATH);
  if (sysdb && !sysdb._err && tableExists(sysdb, 'accounts')) {
    const cols = new Set(sysdb.prepare('PRAGMA table_info(accounts)').all().map(c => c.name));
    const rows = sysdb.prepare('SELECT * FROM accounts').all();
    console.log('  accounts: ' + rows.length);
    for (const a of rows) {
      accounts.set(a.id, a);
      const enrolled = cols.has('key_enrolled') && a.key_enrolled ? 'per-user key ENROLLED' : 'master-key only';
      console.log(`    - ${a.id}  ${String(a.username).padEnd(16)} ${a.is_admin ? 'admin ' : 'member'}  ${enrolled}`);
    }
  } else if (sysdb && sysdb._err) {
    console.log('  ERROR: ' + sysdb._err);
  } else {
    console.log('  !! no accounts table — this database is not a Simplex system db.');
  }
  if (sysdb && !sysdb._err) sysdb.close();
  console.log('');

  /* ---- 3. the account folders (where the 100 GB lives) ---- */
  console.log('ACCOUNT FOLDERS' + (deep ? ' (deep scan — reading blob listings)' : '  [run with --deep to also find orphaned blobs]'));
  if (!fs.existsSync(ACCOUNTS_DIR)) { console.log('  !! no accounts directory.'); return; }
  const dirs = fs.readdirSync(ACCOUNTS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name);

  const orphanedFolders = [];   // data on disk with no login
  let totalBytes = 0;
  for (const id of dirs) {
    const inf = inspectAccount(id, key, deep);
    totalBytes += inf.blobBytes;
    const acct = accounts.get(id);
    const label = id.startsWith('__') ? '(shared store)' : acct ? `login: ${acct.username}` : '*** NO LOGIN ***';
    console.log(`\n  ${id}   ${label}`);
    console.log(`    blobs on disk : ${inf.blobCount} files, ${fmtSize(inf.blobBytes)}`);
    console.log(`    metadata db   : ${inf.dbExists ? `${inf.rows} files + ${inf.folders} folders (${fmtSize(inf.bytes)}), mtime ${inf.dbMtime}` : 'MISSING'}`);
    if (inf.hasWal) console.log(`    db -wal       : present, mtime ${inf.walMtime}`);
    if (inf.dbExists) console.log(`    key versions  : v1(master-key) ${inf.v1}   v2(per-user key) ${inf.v2}`);
    if (inf.err) console.log(`    ERROR         : ${inf.err}`);
    if (inf.keyOpens) {
      const k = inf.keyOpens;
      console.log(`    key test      : ${k.match ? 'OK — the current master key decrypts this account' : `FAILED — decrypted ${k.decrypted}/${k.tested} names. WRONG KEY for this data.`}`);
    } else if (inf.dbExists && key) {
      console.log('    key test      : (no v1-encrypted names to test against)');
    }
    if (inf.orphanBlobs && inf.orphanBlobs.count) {
      console.log(`    ORPHAN BLOBS  : ${inf.orphanBlobs.count} files (${fmtSize(inf.orphanBlobs.bytes)}) on disk that this db does not mention`);
      console.log('                    -> this folder\'s metadata db was overwritten. See `orphan-blobs`.');
    }
    if (!acct && !id.startsWith('__')) orphanedFolders.push({ id, inf });
  }

  const ghosts = [...accounts.keys()].filter(id => !dirs.includes(id));
  console.log('\n------------------------------------------------------------------');
  console.log('SUMMARY');
  console.log('  data on disk        : ' + fmtSize(totalBytes) + ' across ' + dirs.length + ' folder(s)');
  console.log('  folders with NO login (your lost accounts): ' + orphanedFolders.length);
  for (const o of orphanedFolders) console.log('      ' + o.id + '  ' + fmtSize(o.inf.blobBytes) + '  ' + o.inf.rows + ' files' + (o.inf.keyOpens ? (o.inf.keyOpens.match ? '  [key OK]' : '  [KEY MISMATCH]') : ''));
  console.log('  logins pointing at a MISSING folder      : ' + ghosts.length);
  for (const g of ghosts) console.log('      ' + g + '  ' + (accounts.get(g) || {}).username);

  const anyMismatch = orphanedFolders.some(o => o.inf.keyOpens && !o.inf.keyOpens.match);
  console.log('\nWHAT TO DO NEXT');
  if (!key) {
    console.log('  1. Find your master key backup. Nothing else matters until then.');
  } else if (anyMismatch) {
    console.log('  1. The installed master key does NOT match some of this data — the copy');
    console.log('     replaced vault/keys/master.key with the other vault\'s key.');
    console.log('     Find the ORIGINAL key (password manager, `key.js backup` output, an');
    console.log('     old server image) and test it WITHOUT installing it:');
    console.log('         node rescue.js try-key <hex-or-file>');
    console.log('     Until the right key is installed, do not adopt anything.');
  } else if (orphanedFolders.length) {
    console.log('  1. The master key is correct for this data — the files are readable.');
    console.log('     Rebuild each lost login (the id must stay the same, it is half the key):');
    console.log('         node rescue.js adopt <accountId> --username <name> --password <newpass> [--admin]');
    console.log('     Accounts that were "per-user key ENROLLED" also need their ORIGINAL');
    console.log('     system.sqlite for their v2 files; v1 files come back regardless.');
  } else {
    console.log('  Every folder has a matching login. Nothing to adopt.');
  }
  console.log('  Whatever you do next: copy the whole vault/ to a second disk FIRST.\n');
}

/* ---------- try-key: test a candidate key against the data, without installing ---------- */
function cmdTryKey() {
  const src = positional[0];
  if (!src) die('usage: node rescue.js try-key <hex-or-base64-or-file> [--account <id>]');
  let key;
  if (fs.existsSync(src) && fs.statSync(src).isFile()) {
    const buf = fs.readFileSync(src);
    key = buf.length === 32 ? buf : vault.decodeKeyString(buf.toString('utf8'));
  } else {
    key = vault.decodeKeyString(src);
  }
  if (!key || key.length !== 32) die('could not read a valid 32-byte key from that source.');
  console.log('\n  candidate key fingerprint: ' + fingerprint(key) + '\n');

  const only = opt('account');
  const dirs = fs.readdirSync(ACCOUNTS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name)
    .filter(id => !only || id === only);
  if (!dirs.length) die('no account folders to test against.');

  let hits = 0;
  for (const id of dirs) {
    const db = openRO(path.join(ACCOUNTS_DIR, id, 'simplex.sqlite'));
    if (!db || db._err) { console.log(`  ${id}  — no readable metadata db`); continue; }
    const r = keyOpensAccount(key, id, db);
    db.close();
    if (!r) { console.log(`  ${id}  — nothing to test (no v1-encrypted names)`); continue; }
    if (r.match) { hits++; console.log(`  ${id}  ✓ OPENS  (${r.decrypted}/${r.tested} names decrypted)`); }
    else console.log(`  ${id}  ✗ no     (${r.decrypted}/${r.tested})`);
  }
  console.log('');
  if (hits) {
    console.log('  This key opens ' + hits + ' account folder(s). To make it the live key:');
    console.log('      node key.js restore ' + (fs.existsSync(src) ? src : '<the key>') + ' --force');
    console.log('  (--force is required because a different key is installed. Back up the');
    console.log('   current key file first if you are not certain.)\n');
  } else {
    console.log('  This key opens nothing here. It is not the key for this data.\n');
  }
  process.exit(hits ? 0 : 2);
}

/* ---------- adopt: rebuild a login for a surviving account folder ---------- */
function cmdAdopt() {
  const id = positional[0];
  const username = opt('username');
  const password = opt('password');
  if (!id || !username || !password) die('usage: node rescue.js adopt <accountId> --username <u> --password <p> [--admin] [--quota-gb N]');
  const dir = path.join(ACCOUNTS_DIR, id);
  if (!fs.existsSync(dir)) die('no folder at ' + dir + ' — the account id must match the folder name exactly.');

  let key;
  try { const i = vault.readExistingMasterKey(VAULT_DIR); key = i && i.key; } catch (e) { die(e.message); }
  if (!key) die('no master key installed. Restore it before adopting anything.');

  // Refuse to build a login onto data the installed key cannot read. Doing that
  // would hand you an account full of files that decrypt to garbage, and would
  // paper over the real problem (wrong master key).
  const accDb = openRO(path.join(dir, 'simplex.sqlite'));
  if (accDb && !accDb._err) {
    const r = keyOpensAccount(key, id, accDb);
    accDb.close();
    if (r && !r.match && !flags.has('--force')) {
      die('the installed master key does NOT decrypt this folder (' + r.decrypted + '/' + r.tested + ' names).\n' +
          '  Adopting now would give you an unreadable account. Find the original key first:\n' +
          '      node rescue.js try-key <candidate>\n' +
          '  Re-run with --force only if you know what you are doing.');
    }
  }

  if (!fs.existsSync(SYSTEM_DB_PATH)) die('no system.sqlite at ' + SYSTEM_DB_PATH + ' — start the server once to create it, then re-run.');

  // back up the system db (and its wal) before any write
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bakDir = path.join(VAULT_DIR, 'rescue-backups');
  fs.mkdirSync(bakDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const p = SYSTEM_DB_PATH + suffix;
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(bakDir, 'system.sqlite' + suffix + '.' + stamp));
  }
  console.log('\n  backed up system.sqlite -> ' + bakDir);

  const db = new Database(SYSTEM_DB_PATH);
  if (db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) die('an account row with id ' + id + ' already exists. Nothing to adopt.');
  if (db.prepare('SELECT 1 FROM accounts WHERE username = ?').get(username)) die('username "' + username + '" is taken. Pick another.');

  const { salt, hash } = vault.hashPassword(password);
  const quotaGb = Number(opt('quota-gb'));
  const cols = new Set(db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name));
  const row = {
    id, username, display: username,
    pw_salt: salt, pw_hash: hash,
    is_admin: flags.has('--admin') ? 1 : 0,
    quota_bytes: Number.isFinite(quotaGb) && quotaGb > 0 ? Math.round(quotaGb * 1e9) : DEFAULT_QUOTA,
    avatar_color: '#e0a64a', created: Date.now(),
  };
  const names = Object.keys(row).filter(c => cols.has(c));
  db.prepare(`INSERT INTO accounts (${names.join(',')}) VALUES (${names.map(c => '@' + c).join(',')})`).run(row);
  db.close();

  console.log('\n  ✓ adopted ' + id + ' as "' + username + '"' + (flags.has('--admin') ? ' (admin)' : ''));
  console.log('    The folder keeps its id, so its v1 files decrypt exactly as before.');
  console.log('    Sign in with the password you just set, then change it in Settings.');
  console.log('    NOTE: files written under a per-user key (v2) stay sealed — those');
  console.log('    need the ORIGINAL system.sqlite row, which this cannot reconstruct.\n');
}

/* ---------- orphan-blobs: bytes on disk the metadata db lost track of ---------- */
function cmdOrphanBlobs() {
  const id = positional[0];
  if (!id) die('usage: node rescue.js orphan-blobs <accountId>');
  const dir = path.join(ACCOUNTS_DIR, id);
  const filesDir = path.join(dir, 'files');
  if (!fs.existsSync(filesDir)) die('no files directory at ' + filesDir);
  const db = openRO(path.join(dir, 'simplex.sqlite'));
  const known = new Set();
  if (db && !db._err && tableExists(db, 'files')) for (const r of db.prepare('SELECT id FROM files').all()) known.add(r.id);
  if (db && !db._err) db.close();

  console.log('\n  orphaned blobs in ' + filesDir);
  console.log('  (present on disk, not referenced by simplex.sqlite)\n');
  let n = 0, bytes = 0, v1 = 0, v2 = 0;
  for (const f of fs.readdirSync(filesDir)) {
    const m = f.match(/^([^.]+)\.enc$/);
    if (!m || known.has(m[1])) continue;
    const p = path.join(filesDir, f);
    let size = 0, ver = '?', plain = null;
    try { size = fs.statSync(p).size; } catch (_) {}
    try {
      const head = vault.readBlobHeader(p);
      if (head) { ver = head.ver === 2 ? 'v2' : 'v1'; plain = head.size; if (head.ver === 2) v2++; else v1++; }
    } catch (_) {}
    n++; bytes += size;
    if (n <= 40) console.log(`    ${m[1]}  ${ver}  on-disk ${fmtSize(size)}${plain != null ? `  plaintext ${fmtSize(Number(plain))}` : ''}`);
  }
  if (n > 40) console.log(`    … and ${n - 40} more`);
  console.log(`\n  total: ${n} blob(s), ${fmtSize(bytes)}   (v1 ${v1}, v2 ${v2})`);
  if (n) {
    console.log('\n  These are real bytes and they are NOT lost — but their names, types and');
    console.log('  folder placement lived in the simplex.sqlite that got overwritten.');
    console.log('  v1 blobs can be decrypted with the master key + this account id.');
    console.log('  Recover the original simplex.sqlite (or its -wal) if you can: it is a');
    console.log('  small file, and it is the only place the filenames ever existed.\n');
  } else {
    console.log('  none — this folder\'s metadata db still matches its blobs.\n');
  }
}

/* ---------- names: decrypt v1 filenames, to identify WHICH vault a folder came from ----------
   When two vaults have been mixed together, the fastest way to tell which is
   which is to read the filenames back and look at them. v1 names need only the
   master key; v2 names stay sealed without the account row, and are reported as
   such rather than silently skipped. */
function cmdNames() {
  const id = positional[0];
  if (!id) die('usage: node rescue.js names <accountId> [--limit N] [--key <hex|file>]');
  const dbPath = path.join(ACCOUNTS_DIR, id, 'simplex.sqlite');
  const db = openRO(dbPath);
  if (!db) die('no metadata db at ' + dbPath);
  if (db._err) die(db._err);

  let key;
  const kArg = opt('key');
  if (kArg) {
    if (fs.existsSync(kArg) && fs.statSync(kArg).isFile()) {
      const buf = fs.readFileSync(kArg);
      key = buf.length === 32 ? buf : vault.decodeKeyString(buf.toString('utf8'));
    } else key = vault.decodeKeyString(kArg);
    if (!key || key.length !== 32) die('could not read a 32-byte key from --key');
  } else {
    try { const i = vault.readExistingMasterKey(VAULT_DIR); key = i && i.key; } catch (e) { die(e.message); }
    if (!key) die('no master key installed; pass one with --key');
  }

  const limit = Math.max(1, Number(opt('limit')) || 60);
  const keys = { v1: vault.makeKeyring(key)(id), v2: null };
  const rows = db.prepare('SELECT name, type, size, COALESCE(kv,1) kv FROM files ORDER BY size DESC LIMIT ?').all(limit);
  db.close();

  console.log('\n  ' + id + '  — largest ' + rows.length + ' entries, names decrypted with key ' + fingerprint(key) + '\n');
  let sealed = 0;
  for (const r of rows) {
    const nm = vault.decText(r.name, keys);
    const readable = typeof nm === 'string' && !nm.startsWith('enc');
    if (!readable) sealed++;
    console.log('    ' + (readable ? nm : '[sealed — ' + (r.kv === 2 ? 'per-user key, needs the original account row' : 'wrong master key') + ']')
      + '   ' + r.type + '  ' + fmtSize(r.size));
  }
  if (sealed) console.log('\n  ' + sealed + '/' + rows.length + ' names could not be decrypted.');
  console.log('');
}

/* ---------- wal-check: does the surviving -wal hold pre-copy account rows? ----------
   A file copy replaces system.sqlite but often leaves the running server's
   -wal/-shm behind (they exist only while the db is live, so the source vault
   frequently has none to copy over). A WAL written AFTER the db file it sits
   next to is the giveaway. SQLite replays a WAL on open, so we never test this
   in place — we test on COPIES, twice: the db alone, then the db with its WAL.
   If the second one has accounts the first doesn't, the WAL is holding them. */
function cmdWalCheck() {
  if (!fs.existsSync(SYSTEM_DB_PATH)) die('no system.sqlite at ' + SYSTEM_DB_PATH);
  const work = path.join(VAULT_DIR, 'rescue-backups', 'wal-check-' + Date.now());
  const bare = path.join(work, 'bare'), withWal = path.join(work, 'with-wal');
  fs.mkdirSync(bare, { recursive: true });
  fs.mkdirSync(withWal, { recursive: true });

  fs.copyFileSync(SYSTEM_DB_PATH, path.join(bare, 'system.sqlite'));
  for (const suffix of ['', '-wal', '-shm']) {
    const p = SYSTEM_DB_PATH + suffix;
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(withWal, 'system.sqlite' + suffix));
  }
  console.log('\n  working on copies in ' + work);
  console.log('  (the real vault files are not touched)\n');

  const readAccounts = (dir, label) => {
    const f = path.join(dir, 'system.sqlite');
    let db;
    // opened read-write on purpose: that is what makes SQLite replay the WAL.
    // It is a throwaway copy, so recovery can do whatever it likes to it.
    try { db = new Database(f); } catch (e) { console.log('  ' + label + ': cannot open — ' + e.message); return null; }
    let out = null;
    try {
      if (!tableExists(db, 'accounts')) { console.log('  ' + label + ': no accounts table'); }
      else {
        out = db.prepare('SELECT id, username, is_admin, key_enrolled FROM accounts ORDER BY username').all();
        console.log('  ' + label + ': ' + out.length + ' account(s)');
        for (const a of out) console.log('      ' + a.id + '  ' + String(a.username).padEnd(16) + (a.is_admin ? 'admin ' : 'member') + (a.key_enrolled ? '  per-user key ENROLLED' : ''));
      }
    } catch (e) { console.log('  ' + label + ': ' + e.message); }
    db.close();
    return out;
  };

  const a = readAccounts(bare, 'db WITHOUT its wal');
  console.log('');
  const b = readAccounts(withWal, 'db WITH the surviving wal');

  const ids = (list) => new Set((list || []).map(r => r.id));
  const A = ids(a), B = ids(b);
  const extra = [...B].filter(x => !A.has(x));
  console.log('');
  if (extra.length) {
    console.log('  *** THE WAL HOLDS ' + extra.length + ' ACCOUNT ROW(S) THE DATABASE FILE DOES NOT ***');
    for (const e of extra) console.log('      ' + e);
    console.log('\n  This is the best possible outcome: those rows carry the wrapped per-user');
    console.log('  keys. Recover them by keeping system.sqlite AND its -wal together —');
    console.log('  copy the recovered pair in ' + withWal);
    console.log('  over vault/system.sqlite (+ -wal) with the server STOPPED.\n');
  } else if (b === null && a) {
    console.log('  *** DANGER: replaying that WAL DESTROYED the copy — the accounts table');
    console.log('      became unreadable. The WAL belongs to a DIFFERENT database file.');
    console.log('      SQLite replays a WAL automatically on open, so starting the server');
    console.log('      now would do this to your REAL system.sqlite.');
    console.log('      With the server stopped, move the stray files aside FIRST:');
    console.log('          rename vault\\system.sqlite-wal system.sqlite-wal.foreign');
    console.log('          rename vault\\system.sqlite-shm system.sqlite-shm.foreign');
    console.log('      Keep them — they are still evidence, and may be readable beside');
    console.log('      the database they actually came from if you find it.\n');
  } else {
    console.log('  The WAL adds no accounts — it belongs to the database now in place,');
    console.log('  or SQLite discarded it as foreign. The original rows are not here.\n');
  }
}

/* ---------- find-keys: hunt for a master key anywhere and test it against the data ----------
   A master key is 32 raw bytes, or a hex/base64 dump of them. Old installs,
   `key.js backup` output, a copied app folder, a USB stick — any of them may
   hold the original. Every candidate is tested against the actual encrypted
   filenames, which is the only proof that matters. */
function cmdFindKeys() {
  const roots = positional.length ? positional : [path.parse(process.cwd()).root];
  const maxFiles = Number(opt('max-files')) || 400000;
  const SKIP = /^(node_modules|\.git|Windows|WinSxS|\$Recycle\.Bin|System Volume Information|AppData\\Local\\Temp)$/i;

  console.log('\n  searching for candidate master keys under:');
  for (const r of roots) console.log('    ' + r);
  console.log('  (32-byte files, and small files whose name mentions "key")\n');

  const candidates = [];
  let seen = 0, stop = false;
  const walk = (d, depth) => {
    if (stop || depth > 12) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (stop) return;
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.test(e.name)) walk(p, depth + 1); continue; }
      if (++seen > maxFiles) { stop = true; console.log('  (stopped at ' + maxFiles + ' files — narrow the search with a path argument)'); return; }
      let st; try { st = fs.statSync(p); } catch (_) { continue; }
      const nameHints = /key/i.test(e.name);
      if (st.size === 32) candidates.push({ p, how: 'raw 32 bytes' });
      else if (nameHints && st.size > 0 && st.size <= 4096) candidates.push({ p, how: 'name mentions "key"' });
    }
  };
  for (const r of roots) walk(r, 0);

  console.log('  scanned ' + seen + ' files, ' + candidates.length + ' candidate(s)\n');
  if (!candidates.length) { console.log('  nothing to test.\n'); return; }

  // the folders worth testing against: those with v1-encrypted names
  const folders = [];
  for (const id of fs.readdirSync(ACCOUNTS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)) {
    const db = openRO(path.join(ACCOUNTS_DIR, id, 'simplex.sqlite'));
    if (!db || db._err) continue;
    let has = false;
    try { has = !!db.prepare("SELECT 1 FROM files WHERE name LIKE 'enc:%' LIMIT 1").get(); } catch (_) {}
    db.close();
    if (has) folders.push(id);
  }
  if (!folders.length) { console.log('  no folder has v1-encrypted names to test a key against.\n'); return; }
  console.log('  testing against: ' + folders.join(', ') + '\n');

  const tried = new Set();
  let found = 0;
  for (const c of candidates) {
    let key = null;
    try {
      const buf = fs.readFileSync(c.p);
      key = buf.length === 32 ? buf : vault.decodeKeyString(buf.toString('utf8').trim());
    } catch (_) { continue; }
    if (!key || key.length !== 32) continue;
    const fp = fingerprint(key);
    if (tried.has(fp)) continue;
    tried.add(fp);
    const opens = [];
    for (const id of folders) {
      const db = openRO(path.join(ACCOUNTS_DIR, id, 'simplex.sqlite'));
      if (!db || db._err) continue;
      const r = keyOpensAccount(key, id, db);
      db.close();
      if (r && r.match) opens.push(id);
    }
    if (opens.length) {
      found++;
      console.log('  *** ' + fp + '  opens ' + opens.join(', '));
      console.log('      ' + c.p + '   (' + c.how + ')');
    }
  }
  console.log('');
  if (!found) console.log('  none of the candidates decrypt anything here.\n');
  else console.log('  Install the one that opens the folders you care about:\n      node key.js restore "<path>" --force\n');
}

switch (cmd) {
  case 'scan': cmdScan(); break;
  case 'names': cmdNames(); break;
  case 'wal-check': cmdWalCheck(); break;
  case 'find-keys': cmdFindKeys(); break;
  case 'try-key': cmdTryKey(); break;
  case 'adopt': cmdAdopt(); break;
  case 'orphan-blobs': cmdOrphanBlobs(); break;
  default:
    console.log('SIMPLEX vault rescue — recover accounts after a bad vault copy\n');
    console.log('  node rescue.js scan [--deep]                 read-only report — START HERE');
    console.log('  node rescue.js try-key <hex|file>            test a candidate master key against the data');
    console.log('  node rescue.js adopt <id> --username <u> --password <p> [--admin]');
    console.log('                                              rebuild a login for a surviving folder');
    console.log('  node rescue.js orphan-blobs <id>            blobs the metadata db lost track of');
    console.log('  node rescue.js names <id> [--key <k>]        decrypt filenames — tells you WHICH vault a folder is');
    console.log('  node rescue.js wal-check                    does the surviving -wal hold the old account rows?');
    console.log('  node rescue.js find-keys [dir...]           hunt for a master key on disk and test it\n');
    console.log('  scan / try-key / orphan-blobs never write. adopt backs up system.sqlite first.');
    console.log('  Nothing in this tool deletes anything.\n');
}

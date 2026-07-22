/* read-only inspection of current vault state */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const VAULT = path.join(__dirname, 'vault');
const FILES = path.join(VAULT, 'files');
const ACCTS = path.join(VAULT, 'accounts');

function list(dir) { try { return fs.readdirSync(dir); } catch (e) { return []; } }
function sizeOf(p) { try { return fs.statSync(p).size; } catch (e) { return -1; } }

console.log('=== vault/ entries ===');
for (const f of list(VAULT)) {
  const p = path.join(VAULT, f);
  const st = fs.statSync(p);
  console.log((st.isDirectory() ? 'DIR  ' : 'FILE ') + f + (st.isDirectory() ? '' : '  ' + st.size));
}

console.log('\n=== vault/files plaintext blobs ===');
const blobs = list(FILES);
let totalPlain = 0;
const byId = {};
for (const f of blobs) { const s = sizeOf(path.join(FILES, f)); totalPlain += s; byId[f.replace(/\.[^.]+$/, '')] = { name: f, size: s }; }
console.log('count:', blobs.length, ' totalBytes:', totalPlain, '(', (totalPlain / 1e9).toFixed(2), 'GB )');

// find the source DB: prefer a _migrated_* one, else simplex.sqlite
const cands = list(VAULT).filter(f => /simplex\.sqlite$/.test(f));
console.log('\n=== candidate DBs ===', cands);

function dumpDB(label, file) {
  if (!fs.existsSync(file)) { console.log(label, '-> missing'); return; }
  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); } catch (e) { console.log(label, 'open failed', e.message); return; }
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name);
    console.log('\n###', label, '(' + file + ') tables:', tables.join(','));
    if (!tables.includes('files')) return;
    const n = db.prepare('SELECT COUNT(*) n FROM files').get().n;
    const nb = db.prepare('SELECT COUNT(*) n FROM files WHERE hasBlob = 1').get().n;
    console.log('rows:', n, ' hasBlob rows:', nb);
    const cols = db.prepare('PRAGMA table_info(files)').all().map(c => c.name);
    console.log('cols:', cols.join(','));
    const blobRows = db.prepare('SELECT id, storedExt, size, hasBlob FROM files WHERE hasBlob = 1').all();
    // how many of those blob rows have a matching plaintext file on disk?
    let matchPlain = 0, matchEnc = 0;
    for (const r of blobRows) {
      if (fs.existsSync(path.join(FILES, r.id + (r.storedExt || '')))) matchPlain++;
    }
    console.log('blob rows whose plaintext exists in vault/files:', matchPlain, '/', blobRows.length);
    // sample
    console.log('sample blob rows:', JSON.stringify(blobRows.slice(0, 3)));
  } finally { db.close(); }
}

for (const c of cands) dumpDB('DB ' + c, path.join(VAULT, c));

console.log('\n=== vault/accounts ===');
for (const a of list(ACCTS)) {
  const adir = path.join(ACCTS, a);
  const afiles = path.join(adir, 'files');
  const encs = list(afiles);
  let encTotal = 0; for (const f of encs) encTotal += sizeOf(path.join(afiles, f));
  console.log('account', a, '| files/:', encs.length, 'enc blobs', (encTotal / 1e9).toFixed(3), 'GB');
  dumpDB('  acct DB ' + a, path.join(adir, 'simplex.sqlite'));
  // how many enc blobs vs hasBlob rows
}

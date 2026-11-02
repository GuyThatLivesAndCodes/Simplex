#!/usr/bin/env node
/* ============================================================
   SIMPLEX — master key management CLI

   The master key encrypts EVERYTHING in the vault. It lives at
   vault/keys/master.key and is read on every boot, so data survives
   reboots automatically. This tool lets you safely view, verify, back
   up, and restore it for disaster recovery.

   Usage:
     node key.js show [--yes]      View the key (hex + base64). Prompts for
                                   confirmation unless --yes is given.
     node key.js verify <key>      Check a written-down key matches the real
                                   one WITHOUT printing the real key.
     node key.js backup <dest>     Copy the key to a safe place (file or folder,
                                   e.g. a USB drive). Written with 0600 perms.
     node key.js restore <src>     Install a key from a backup file OR a
                                   hex/base64 string. Refuses to overwrite a
                                   different existing key unless --force.
     node key.js path              Print the key file location + status.

   SECURITY: anyone who can read vault/keys/master.key (or run this tool) can
   decrypt the vault. Keep backups somewhere only you control (password
   manager, encrypted USB). Never commit the key or paste it into chat.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const vault = require('./crypto');

const VAULT_DIR = path.join(__dirname, 'vault');
const args = process.argv.slice(2);
const cmd = (args[0] || '').toLowerCase();
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.slice(1).filter(a => !a.startsWith('--'));

function die(msg) { console.error(msg); process.exit(1); }
function fingerprint(key) { return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16); }

function getKeyOrExit() {
  let info;
  try { info = vault.readExistingMasterKey(VAULT_DIR); }
  catch (e) { die('[key] ' + e.message); }
  if (!info) die('[key] no master key yet. It is created the first time you run `node server.js`.');
  return info;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a); });
  });
}

async function cmdShow() {
  const { key, source } = getKeyOrExit();
  if (!flags.has('--yes')) {
    if (!process.stdin.isTTY) die('[key] refusing to print the key to a non-interactive shell. Re-run with --yes if you really mean to.');
    console.log('\n  This will print your master encryption key in plain text.');
    console.log('  Make sure nobody is watching your screen and your terminal history is private.\n');
    const a = await ask('  Type "show" to reveal the key: ');
    if (a.trim().toLowerCase() !== 'show') die('  cancelled.');
  }
  console.log('\n==================================================================');
  console.log('  SIMPLEX master key   (source: ' + source + ')');
  console.log('  fingerprint : ' + fingerprint(key) + '   (safe to share; identifies the key)');
  console.log('------------------------------------------------------------------');
  console.log('  hex    : ' + key.toString('hex'));
  console.log('  base64 : ' + key.toString('base64'));
  console.log('==================================================================');
  console.log('  Store this in a password manager or on an encrypted USB drive.');
  console.log('  To use it on a fresh machine without the file:');
  console.log('      SIMPLEX_MASTER_KEY=<hex> node server.js');
  console.log('  Losing it with no backup = data is unrecoverable.\n');
}

function cmdVerify() {
  if (!positional[0]) die('usage: node key.js verify <hex-or-base64-key>');
  const { key } = getKeyOrExit();
  const cand = vault.decodeKeyString(positional[0]);
  if (!cand || cand.length !== 32) die('  that is not a valid 32-byte key (need 64 hex chars or base64).');
  const ok = cand.length === key.length && crypto.timingSafeEqual(cand, key);
  console.log(ok ? '\n  ✓ MATCH — your backup is correct.\n' : '\n  ✗ NO MATCH — this is NOT the current key. Do not rely on it.\n');
  process.exit(ok ? 0 : 2);
}

function cmdBackup() {
  if (!positional[0]) die('usage: node key.js backup <destination-file-or-folder>');
  const { key, source } = getKeyOrExit();
  let dest = positional[0];
  try { if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) dest = path.join(dest, 'simplex-master.key'); } catch (e) {}
  if (fs.existsSync(dest) && !flags.has('--force')) die('  ' + dest + ' already exists. Use --force to overwrite.');
  const fd = fs.openSync(dest, 'w', 0o600);
  try { fs.writeSync(fd, key); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.chmodSync(dest, 0o600); } catch (e) {}
  console.log('\n  ✓ backed up key (' + source + ')');
  console.log('    -> ' + path.resolve(dest));
  console.log('    fingerprint ' + fingerprint(key) + '\n');
}

function cmdRestore() {
  if (!positional[0]) die('usage: node key.js restore <backup-file-or-hex/base64-string> [--force]');
  let key;
  const arg = positional[0];
  if (fs.existsSync(arg) && fs.statSync(arg).isFile()) {
    const buf = fs.readFileSync(arg);
    key = buf.length === 32 ? buf : vault.decodeKeyString(buf.toString('utf8'));   // raw 32B file or a text key dump
  } else {
    key = vault.decodeKeyString(arg);
  }
  if (!key || key.length !== 32) die('  could not read a valid 32-byte key from that source.');

  if (process.env.SIMPLEX_MASTER_KEY) console.log('  note: SIMPLEX_MASTER_KEY is set; it overrides the key file at runtime.');
  const keyPath = vault.keyFilePath(VAULT_DIR);
  if (fs.existsSync(keyPath)) {
    const cur = fs.readFileSync(keyPath);
    if (cur.length === key.length && crypto.timingSafeEqual(cur, key)) { console.log('\n  already installed — identical key. nothing to do.\n'); return; }
    if (!flags.has('--force')) die('\n  a DIFFERENT key already exists at ' + keyPath + '.\n' +
      '  Overwriting it will make the current vault unreadable. If you are sure, re-run with --force.\n');
  }
  const written = vault.writeMasterKeyFile(VAULT_DIR, key);
  console.log('\n  ✓ installed key -> ' + written + '   fingerprint ' + fingerprint(key) + '\n');
}

function cmdPath() {
  const keyPath = vault.keyFilePath(VAULT_DIR);
  console.log('  key file : ' + keyPath);
  console.log('  exists   : ' + fs.existsSync(keyPath));
  if (process.env.SIMPLEX_MASTER_KEY) console.log('  note     : SIMPLEX_MASTER_KEY env var is set and TAKES PRECEDENCE over the file.');
  try { const info = vault.readExistingMasterKey(VAULT_DIR); if (info) console.log('  in use   : ' + info.source + '   fingerprint ' + fingerprint(info.key)); }
  catch (e) { console.log('  WARNING  : ' + e.message); }
}

(async () => {
  switch (cmd) {
    case 'show': await cmdShow(); break;
    case 'verify': cmdVerify(); break;
    case 'backup': cmdBackup(); break;
    case 'restore': cmdRestore(); break;
    case 'path': cmdPath(); break;
    default:
      console.log('SIMPLEX key tool — manage the master encryption key\n');
      console.log('  node key.js show [--yes]      view the key (hex + base64)');
      console.log('  node key.js verify <key>      check a backup matches, without revealing the key');
      console.log('  node key.js backup <dest>     copy the key to a file/folder (e.g. USB)');
      console.log('  node key.js restore <src>     install a key from a file or hex/base64 string');
      console.log('  node key.js path              show the key file location + status');
  }
})();

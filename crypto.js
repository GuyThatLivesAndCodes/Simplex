/* ============================================================
   SIMPLEX — backend cryptography (all keys live ONLY here)
   ------------------------------------------------------------
   - Master key: 32 random bytes in vault/keys/master.key (chmod 0600)
     or SIMPLEX_MASTER_KEY (hex/base64). Never sent to any client.
   - KEY VERSIONS. Two generations of data keys coexist:
       v1 ("legacy"): per-account subkeys via HKDF-SHA256(master, accountId).
         Derivable from the master key alone — a stolen master key reads v1.
       v2: per-account subkeys via HKDF-SHA256(UDK, purpose), where the UDK
         (User Data Key) is 32 random bytes that exist at rest ONLY wrapped:
         AES-GCM under a KEK derived from scrypt(user password) HKDF-mixed
         with the master key. A stolen master key + disk CANNOT read v2 data
         without the user's password (or recovery code). The unwrapped UDK
         lives only in server RAM while the account has signed in.
     Every artifact self-describes its generation: blobs by magic (SXB1/SXB2),
     text fields by prefix (enc:/enc2:) — so both generations decrypt
     transparently and migration can be lazy or bulk.
   - Keysets passed around are either a bare subkey object {ctr1,ctr2,txt1,txt2}
     (treated as v1-only — the system/music keyrings) or a dual keyset
     { v1: subkeys, v2: subkeys|null }. asKeyset() normalizes; writers prefer
     v2 when present, readers pick by the artifact's own marker.
   - Blobs on disk: [28B header][ciphertext], double AES-256-CTR. CTR is a
     stream cipher so HTTP Range / video scrubbing still works — we seek the
     128-bit counter to the requested block and slice.
   - Text fields in SQLite: base64( AES-GCM_txt2( AES-GCM_txt1( utf8 ) ) ),
     stored with an "enc:"/"enc2:" marker so plaintext values and migration
     are handled transparently.
   - Passwords: scrypt(password, salt, 64); verify is async (off the event
     loop) and constant-time.
   - decryptBlobRange wires the file->decipher->slicer chain with
     stream.pipeline so a client abort (e.g. video seek) tears the whole
     chain down — no leaked file descriptors. This is essential: leaking fds
     on aborted range requests is what makes the server eventually wedge.
   ============================================================ */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Transform, pipeline } = require('stream');

/* ---------- master key ----------
   Persistence model (this is what makes data survive reboots):
   1. If SIMPLEX_MASTER_KEY is set, that key is used and nothing is written to
      disk (good for keeping the key in a secret manager, off the drive).
   2. Otherwise the key lives in vault/keys/master.key. It is generated ONCE on
      first run and re-read on every boot — so powering the machine off/on never
      loses data. Losing this single file (with no backup and no env var) is the
      ONLY thing that makes the data unrecoverable, which is why key.js exists. */
function keyFilePath(vaultDir) { return path.join(vaultDir, 'keys', 'master.key'); }

function decodeKeyString(s) {
  s = String(s || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  try { return Buffer.from(s, 'base64'); } catch (e) { return null; }
}

/* read the in-use key WITHOUT ever creating one (used by key.js) -> {key,source}|null */
function readExistingMasterKey(vaultDir) {
  const env = process.env.SIMPLEX_MASTER_KEY;
  if (env && env.trim()) {
    const buf = decodeKeyString(env);
    if (!buf || buf.length !== 32) throw new Error('SIMPLEX_MASTER_KEY must be 32 bytes (64 hex chars or base64)');
    return { key: buf, source: 'env:SIMPLEX_MASTER_KEY' };
  }
  const keyPath = keyFilePath(vaultDir);
  if (fs.existsSync(keyPath)) {
    const buf = fs.readFileSync(keyPath);
    if (buf.length !== 32) throw new Error(`master key at ${keyPath} is ${buf.length} bytes, expected 32`);
    return { key: buf, source: keyPath };
  }
  return null;
}

/* write a 32-byte key to the key file atomically + durably, perms 0600 */
function writeMasterKeyFile(vaultDir, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('refusing to write a key that is not 32 bytes');
  const keysDir = path.join(vaultDir, 'keys');
  fs.mkdirSync(keysDir, { recursive: true });
  const keyPath = keyFilePath(vaultDir);
  const tmp = keyPath + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, key); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, keyPath);
  try { fs.chmodSync(keyPath, 0o600); } catch (e) {}   // best-effort on Windows
  return keyPath;
}

function loadMasterKey(vaultDir) {
  const existing = readExistingMasterKey(vaultDir);
  if (existing) return existing.key;
  // First run only: generate once and persist.
  const key = crypto.randomBytes(32);
  const keyPath = writeMasterKeyFile(vaultDir, key);
  console.log('==================================================================');
  console.log('[simplex] generated a NEW master encryption key at:');
  console.log('          ' + keyPath);
  console.log('  It encrypts ALL vault data and persists across reboots. If you');
  console.log('  ever lose it, the data CANNOT be recovered. Back it up now:');
  console.log('          node key.js show        (view / copy the key)');
  console.log('          node key.js backup <dest>');
  console.log('==================================================================');
  return key;
}

/* ---------- per-account key derivation ---------- */
function hkdf(master, info, len = 32) {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(info), len));
}
function makeKeyring(master) {
  const cache = new Map();
  return function accountKeys(accountId) {
    let k = cache.get(accountId);
    if (!k) {
      k = {
        ctr1: hkdf(master, 'simplex.blob.ctr1.' + accountId),
        ctr2: hkdf(master, 'simplex.blob.ctr2.' + accountId),
        txt1: hkdf(master, 'simplex.text.gcm1.' + accountId),
        txt2: hkdf(master, 'simplex.text.gcm2.' + accountId),
      };
      cache.set(accountId, k);
    }
    return k;
  };
}

/* normalize a keyset argument: bare subkeys => v1-only dual keyset. Every
   crypto entry point calls this, so old callers (music/system keyrings) keep
   working untouched while account stores pass { v1, v2 } duals. */
function asKeyset(k) {
  if (!k) return { v1: null, v2: null };
  return k.v1 || k.v2 ? k : { v1: k, v2: null };
}

/* ---------- v2: User Data Key (UDK) + wrapping ----------
   The UDK is 32 random bytes, generated once per account at enrollment. Its
   subkeys encrypt all NEW data. At rest the UDK exists only wrapped:
     KEK = HKDF( scrypt(secret, salt), salt=masterKey, info=accountId )
     wrap = AES-256-GCM(KEK, UDK)
   `secret` is the account password (the everyday wrap) or a recovery code (the
   break-glass wrap). Mixing the master key into the KEK means an attacker
   needs the disk AND the master key AND the secret — no single artifact reads
   anything. scrypt runs async (off the event loop). */
function udkSubkeys(udk) {
  return {
    ctr1: hkdf(udk, 'simplex.udk.blob.ctr1'),
    ctr2: hkdf(udk, 'simplex.udk.blob.ctr2'),
    txt1: hkdf(udk, 'simplex.udk.text.gcm1'),
    txt2: hkdf(udk, 'simplex.udk.text.gcm2'),
  };
}
function deriveKek(secret, salt, master, accountId) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(secret), salt, 32, SCRYPT, (err, stretched) => {
      if (err) return reject(err);
      resolve(Buffer.from(crypto.hkdfSync('sha256', stretched, master, Buffer.from('simplex.kek2.' + accountId), 32)));
    });
  });
}
function wrapKey(kek, keyBuf) { return gcmEnc(kek, keyBuf); }
function unwrapKey(kek, wrapped) {
  try {
    const out = gcmDec(kek, wrapped);
    return out.length === 32 ? out : null;
  } catch (e) { return null; }
}
/* recovery key: 8 groups of 4 from a 32-char alphabet (no 0/O/1/I) = 160 bits.
   Users don't transcribe this at enrollment — it stays sealed server-side
   (encrypted under the UDK) and is revealed only on request — so length costs
   nothing and buys margin. */
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeRecoveryCode() {
  const bytes = crypto.randomBytes(32);
  let s = '';
  for (let i = 0; i < 32; i++) {
    if (i > 0 && i % 4 === 0) s += '-';
    s += RC_ALPHABET[bytes[i] % 32];
  }
  return s;
}
/* recovery codes are compared after normalization so users can type them loosely */
function normRecoveryCode(s) { return String(s || '').toUpperCase().replace(/[^A-Z2-9]/g, ''); }

/* ============================================================
   BLOB CRYPTO — double AES-256-CTR, seekable, version-tagged
   ============================================================ */
const MAGIC = Buffer.from('SXB1', 'ascii');    // v1: master-derived account keys
const MAGIC2 = Buffer.from('SXB2', 'ascii');   // v2: UDK-derived keys
const HEADER_LEN = 28;   // magic(4) + iv(16) + originalSize(8)

function ivB_from(ivA) { return crypto.createHash('sha256').update(ivA).digest().subarray(0, 16); }

/* add `blocks` to a 16-byte big-endian counter (CTR seek) */
function addCounter(iv16, blocks) {
  const c = Buffer.from(iv16);
  let add = BigInt(blocks);
  for (let i = 15; i >= 0 && add > 0n; i--) {
    add += BigInt(c[i]);
    c[i] = Number(add & 0xffn);
    add >>= 8n;
  }
  return c;
}

/* build the cipher pair for a WRITE with the newest keys available.
   Returns { k, magic } — v2 when the keyset has it, else v1. */
function writeKeys(keys) {
  const ks = asKeyset(keys);
  if (ks.v2) return { k: ks.v2, magic: MAGIC2 };
  if (ks.v1) return { k: ks.v1, magic: MAGIC };
  throw new Error('no keys available to encrypt with');
}
/* pick the subkeys a blob header says it was written with (null = unavailable) */
function readKeysFor(keys, ver) {
  const ks = asKeyset(keys);
  return ver === 2 ? ks.v2 : ks.v1;
}

/* encrypt a plaintext STREAM of known size -> encrypted destPath.
   The core writer: encryptBlob wraps it for files, re-encryption feeds it the
   decrypted v1 stream directly (no plaintext ever touches the disk). */
function encryptBlobStream(inp, size, destPath, keys) {
  return new Promise((resolve, reject) => {
    let picked;
    try { picked = writeKeys(keys); } catch (e) { return reject(e); }
    const iv = crypto.randomBytes(16);
    const header = Buffer.alloc(HEADER_LEN);
    picked.magic.copy(header, 0);
    iv.copy(header, 4);
    header.writeBigUInt64BE(BigInt(size), 20);

    const cipherA = crypto.createCipheriv('aes-256-ctr', picked.k.ctr1, iv);
    const cipherB = crypto.createCipheriv('aes-256-ctr', picked.k.ctr2, ivB_from(iv));
    const out = fs.createWriteStream(destPath);
    out.write(header);
    pipeline(inp, cipherA, cipherB, out, (err) => err ? reject(err) : resolve(size));
  });
}

/* encrypt plaintext file srcPath -> encrypted destPath. Resolves to plaintext size. */
function encryptBlob(srcPath, destPath, keys) {
  let size;
  try { size = fs.statSync(srcPath).size; } catch (e) { return Promise.reject(e); }
  return encryptBlobStream(fs.createReadStream(srcPath), size, destPath, keys);
}

/* re-encrypt an existing encrypted blob under the newest keys (v1 -> v2),
   streaming decrypt->encrypt so plaintext exists only in transit. Writes to
   destPath (caller renames over the original after success). Resolves to the
   plaintext size, or null if the source is missing/unreadable. */
async function reencryptBlob(srcPath, destPath, keys) {
  const head = await readBlobHeaderAsync(srcPath);
  if (!head) return null;
  const dec = decryptBlobRange(srcPath, keys, null, null, head);
  if (!dec) return null;
  const ks = asKeyset(keys);
  if (!ks.v2) throw new Error('re-encryption needs the v2 keys resident');
  await encryptBlobStream(dec.stream, head.size, destPath, { v1: null, v2: ks.v2 });
  return head.size;
}

/* parse the 28-byte header buffer -> { iv, size, ver } (null if bad) */
function parseBlobHeader(hb, n) {
  if (n < HEADER_LEN) return null;
  const magic = hb.subarray(0, 4);
  const ver = magic.equals(MAGIC) ? 1 : magic.equals(MAGIC2) ? 2 : 0;
  if (!ver) return null;
  return { iv: hb.subarray(4, 20), size: Number(hb.readBigUInt64BE(20)), ver };
}

/* read just the header of an encrypted blob -> { iv, size } (null if bad).
   SYNCHRONOUS — only for off-the-hot-path callers (migrate.js). On the request
   path use readBlobHeaderAsync: a synchronous fs.readSync here blocks the WHOLE
   event loop until the OS returns, and on Windows with real-time AV (BitDefender)
   scanning the .enc file, that read can stall for a long time — freezing every
   request including /api/health, with no recoverable "EVENT LOOP BLOCKED" log
   because the monitor timer is frozen too. That was the hang during audio playback. */
function readBlobHeader(encPath) {
  let fd;
  try {
    fd = fs.openSync(encPath, 'r');
    const hb = Buffer.alloc(HEADER_LEN);
    const n = fs.readSync(fd, hb, 0, HEADER_LEN, 0);
    return parseBlobHeader(hb, n);
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {}
  }
}

/* async header read — never blocks the event loop. Resolves { iv, size } | null. */
async function readBlobHeaderAsync(encPath) {
  let fh;
  try {
    fh = await fsp.open(encPath, 'r');
    const hb = Buffer.alloc(HEADER_LEN);
    const { bytesRead } = await fh.read(hb, 0, HEADER_LEN, 0);
    return parseBlobHeader(hb, bytesRead);
  } catch (e) {
    return null;
  } finally {
    if (fh) try { await fh.close(); } catch (e) {}
  }
}

/* Transform that drops the first `skip` plaintext bytes then emits up to `length` */
function makeSlicer(skip, length) {
  let dropped = 0, sent = 0, done = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (done) return cb();
      if (dropped < skip) { const d = Math.min(skip - dropped, chunk.length); dropped += d; chunk = chunk.subarray(d); }
      if (chunk.length && sent < length) {
        const take = Math.min(length - sent, chunk.length);
        this.push(chunk.subarray(0, take)); sent += take;
      }
      if (sent >= length && !done) { done = true; this.push(null); }
      cb();
    },
  });
}

/* live counters so a leak in this path is observable, not guessed at */
const streamStats = { opened: 0, closed: 0 };
function openReadStreams() { return streamStats.opened - streamStats.closed; }

/* Readable of decrypted plaintext for inclusive byte range [start,end].
   start/end null => whole file. Returns { stream, size, start, end } or null.
   The internal file->cipher->slicer chain is wired with pipeline(), so if the
   returned stream is destroyed (client abort), the file read stream is closed. */
function decryptBlobRange(encPath, keys, start, end, head) {
  // `head` may be passed in (already read async by the caller) to avoid a second,
  // synchronous header read on the hot path. Fall back to a sync read only if not.
  if (!head) head = readBlobHeader(encPath);
  if (!head) return null;
  // the header names its key generation; a v2 blob without resident v2 keys
  // (owner not signed in since the last restart) is undecryptable right now
  const kk = readKeysFor(keys, head.ver);
  if (!kk) return null;
  keys = kk;
  const size = head.size;
  if (start == null) start = 0;
  if (end == null || end > size - 1) end = size - 1;
  if (size === 0 || start > end) {
    const empty = new Transform({ transform(c, e, cb) { cb(); } }); empty.end();
    return { stream: empty, size, start: 0, end: -1 };
  }
  const iv = head.iv, ivB = ivB_from(iv);
  const blockIndex = Math.floor(start / 16);
  const skip = start - blockIndex * 16;
  const fileStart = HEADER_LEN + blockIndex * 16;
  const fileEnd = HEADER_LEN + end;                       // inclusive

  const rs = fs.createReadStream(encPath, { start: fileStart, end: fileEnd });
  streamStats.opened++;
  rs.once('close', () => { streamStats.closed++; });      // fires whether it ends or is destroyed
  // encrypt order was cipherA then cipherB; decrypt undoes B first, then A
  const decB = crypto.createDecipheriv('aes-256-ctr', keys.ctr2, addCounter(ivB, blockIndex));
  const decA = crypto.createDecipheriv('aes-256-ctr', keys.ctr1, addCounter(iv, blockIndex));
  const slicer = makeSlicer(skip, end - start + 1);
  // teardown ties the whole chain together: if `slicer` is destroyed (because the
  // outer pipeline to res tore down on client abort), the source `rs` is closed too.
  pipeline(rs, decB, decA, slicer, () => {});
  // belt-and-suspenders: if the consumer destroys our returned stream, make
  // absolutely sure the file read stream is closed even if pipeline misses it.
  slicer.once('close', () => { if (!rs.destroyed) rs.destroy(); });
  return { stream: slicer, size, start, end };
}

/* ============================================================
   TEXT CRYPTO — double AES-256-GCM + base64, "enc:"/"enc2:" markers
   ============================================================ */
const TEXT_PREFIX = 'enc:';     // v1 (master-derived account keys)
const TEXT_PREFIX2 = 'enc2:';   // v2 (UDK-derived keys)
function gcmEnc(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);   // 12 + 16 + n
}
function gcmDec(key, buf) {
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
function encText(val, keys) {
  if (val == null) return val;
  const { k, magic } = writeKeys(keys);
  const p1 = gcmEnc(k.txt1, Buffer.from(String(val), 'utf8'));
  const p2 = gcmEnc(k.txt2, p1);
  return (magic === MAGIC2 ? TEXT_PREFIX2 : TEXT_PREFIX) + p2.toString('base64');
}
function decText(val, keys) {
  if (val == null || typeof val !== 'string') return val;
  // NOTE: enc2: must be tested first — 'enc2:…'.startsWith('enc') is not enough
  const v2 = val.startsWith(TEXT_PREFIX2);
  if (!v2 && !val.startsWith(TEXT_PREFIX)) return val;
  const k = readKeysFor(keys, v2 ? 2 : 1);
  if (!k) return val;   // v2 field, keys not resident — leave it sealed
  try {
    const buf = Buffer.from(val.slice(v2 ? TEXT_PREFIX2.length : TEXT_PREFIX.length), 'base64');
    // outer layer is txt2 (applied last in encText), so undo txt2 first, then txt1
    return gcmDec(k.txt1, gcmDec(k.txt2, buf)).toString('utf8');
  } catch (e) {
    return val;   // corrupt/foreign — don't crash a whole listing over one field
  }
}
function isEncText(val) { return typeof val === 'string' && (val.startsWith(TEXT_PREFIX) || val.startsWith(TEXT_PREFIX2)); }
function textVer(val) { return typeof val !== 'string' ? 0 : val.startsWith(TEXT_PREFIX2) ? 2 : val.startsWith(TEXT_PREFIX) ? 1 : 0; }

/* ============================================================
   PASSWORDS — scrypt (verify async, off the event loop)
   ============================================================ */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  return new Promise((resolve) => {
    if (!salt || !hash) return resolve(false);
    crypto.scrypt(String(password), salt, hash.length, SCRYPT, (err, cand) => {
      if (err) return resolve(false);
      resolve(cand.length === hash.length && crypto.timingSafeEqual(cand, hash));
    });
  });
}

module.exports = {
  loadMasterKey, readExistingMasterKey, writeMasterKeyFile, keyFilePath, decodeKeyString,
  makeKeyring, hkdf, asKeyset,
  udkSubkeys, deriveKek, wrapKey, unwrapKey, makeRecoveryCode, normRecoveryCode,
  encryptBlob, encryptBlobStream, reencryptBlob, decryptBlobRange,
  readBlobHeader, readBlobHeaderAsync, HEADER_LEN,
  encText, decText, isEncText, textVer,
  hashPassword, verifyPassword,
  openReadStreams,            // # of decrypt file-streams currently open (leak probe)
};

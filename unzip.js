/* ============================================================
   SIMPLEX — dependency-free ZIP reader
   ------------------------------------------------------------
   Reads a .zip from a file descriptor using the central directory (the
   authoritative index at the end of the archive), then extracts each entry by
   streaming its local-header data region through zlib. Supports:
     - method 0 (store) and method 8 (deflate) — the only methods real zips use
     - ZIP64 (>4GB archives / >65535 entries) end-of-central-directory + extra fields
     - safe path handling (no absolute paths, no `..` traversal)
   Entries are yielded one at a time and written via a caller-provided sink, so a
   multi-GB app backup never has to live in memory.
   ============================================================ */
const fs = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream');

const EOCD_SIG = 0x06054b50;        // End Of Central Directory
const EOCD64_SIG = 0x06064b50;      // ZIP64 EOCD
const EOCD64_LOC_SIG = 0x07064b50;  // ZIP64 EOCD locator
const CEN_SIG = 0x02014b50;         // Central directory file header
const LOC_SIG = 0x04034b50;         // Local file header

function readChunk(fd, length, position) {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const n = fs.readSync(fd, buf, off, length - off, position + off);
    if (n <= 0) break;
    off += n;
  }
  return off === length ? buf : buf.subarray(0, off);
}

/* find the End Of Central Directory record near the end of the file */
function findEOCD(fd, fileSize) {
  const maxComment = 0xffff;
  const tail = Math.min(fileSize, maxComment + 22);
  const buf = readChunk(fd, tail, fileSize - tail);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      return { buf, off: i, absolute: fileSize - tail + i };
    }
  }
  return null;
}

/* parse the central directory into a list of entry descriptors */
function readDirectory(fd, fileSize) {
  const eocd = findEOCD(fd, fileSize);
  if (!eocd) throw new Error('not a zip file (no end-of-central-directory)');
  let { buf, off } = eocd;
  let count = buf.readUInt16LE(off + 10);
  let cdSize = buf.readUInt32LE(off + 12);
  let cdOffset = buf.readUInt32LE(off + 16);

  // ZIP64: when fields are maxed out, the real values live in the ZIP64 EOCD
  if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
    const locPos = eocd.absolute - 20;
    if (locPos >= 0) {
      const loc = readChunk(fd, 20, locPos);
      if (loc.readUInt32LE(0) === EOCD64_LOC_SIG) {
        const z64pos = Number(loc.readBigUInt64LE(8));
        const z64 = readChunk(fd, 56, z64pos);
        if (z64.readUInt32LE(0) === EOCD64_SIG) {
          count = Number(z64.readBigUInt64LE(32));
          cdSize = Number(z64.readBigUInt64LE(40));
          cdOffset = Number(z64.readBigUInt64LE(48));
        }
      }
    }
  }

  const cd = readChunk(fd, cdSize, cdOffset);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (cd.readUInt32LE(p) !== CEN_SIG) break;
    const method = cd.readUInt16LE(p + 10);
    let compSize = cd.readUInt32LE(p + 20);
    let uncompSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    const flags = cd.readUInt16LE(p + 8);
    const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);

    // ZIP64 extra field (0x0001) overrides maxed 32-bit values
    if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const tag = cd.readUInt16LE(e), sz = cd.readUInt16LE(e + 2); let q = e + 4;
        if (tag === 0x0001) {
          if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
          break;
        }
        e += 4 + sz;
      }
    }
    entries.push({ name, method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* where does an entry's compressed data actually start? (local header varies in
   size from the central one, so we read the local header to get its lengths) */
function dataStart(fd, entry) {
  const lh = readChunk(fd, 30, entry.localOffset);
  if (lh.readUInt32LE(0) !== LOC_SIG) throw new Error('bad local header for ' + entry.name);
  const nameLen = lh.readUInt16LE(26);
  const extraLen = lh.readUInt16LE(28);
  return entry.localOffset + 30 + nameLen + extraLen;
}

/* normalize a zip entry path: strip drive/leading slashes, drop any `..`,
   return null for unsafe/empty. Always forward slashes. */
function safePath(name) {
  let s = String(name).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '').replace(/^\/+/, '');
  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;            // refuse traversal entirely
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/* extract `entry` to destPath (streamed + decompressed). resolves to bytes written */
function extractEntry(fd, entry, destPath) {
  return new Promise((resolve, reject) => {
    const start = dataStart(fd, entry);
    if (entry.compSize === 0 && entry.uncompSize === 0) {   // empty file
      fs.writeFile(destPath, Buffer.alloc(0), (e) => e ? reject(e) : resolve(0));
      return;
    }
    const src = fs.createReadStream(null, { fd, start, end: start + entry.compSize - 1, autoClose: false });
    const out = fs.createWriteStream(destPath);
    if (entry.method === 0) {
      pipeline(src, out, (err) => err ? reject(err) : resolve(entry.uncompSize));
    } else if (entry.method === 8) {
      pipeline(src, zlib.createInflateRaw(), out, (err) => err ? reject(err) : resolve(entry.uncompSize));
    } else {
      reject(new Error(`unsupported compression method ${entry.method} for ${entry.name}`));
    }
  });
}

/* list logical entries (files only; directories are implied by paths).
   Returns [{ name (safe path), uncompSize, method, raw }]. */
function listEntries(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const raw = readDirectory(fd, size);
    const out = [];
    for (const e of raw) {
      if (e.name.endsWith('/')) continue;          // directory marker — skip, paths recreate dirs
      const safe = safePath(e.name);
      if (!safe) continue;                         // unsafe/empty -> skip
      out.push({ name: safe, uncompSize: e.uncompSize, method: e.method, _raw: e });
    }
    return out;
  } finally { fs.closeSync(fd); }
}

/* extract a single entry (by the descriptor from listEntries) into destPath */
function extractOne(zipPath, entry, destPath) {
  const fd = fs.openSync(zipPath, 'r');
  return extractEntry(fd, entry._raw, destPath).finally(() => { try { fs.closeSync(fd); } catch (e) {} });
}

module.exports = { listEntries, extractOne, safePath };

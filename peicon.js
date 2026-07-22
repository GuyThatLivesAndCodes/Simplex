/* ============================================================
   peicon.js — extract the embedded icon from a Windows PE file
   (.exe / .dll) and assemble it into a standalone .ico buffer.

   No native deps, no ffmpeg: a Windows executable stores its icon as
   PE resources, and ffmpeg/image tools can't read those. We parse the
   PE headers down to the resource directory ourselves, pull the
   RT_GROUP_ICON that the shell would show, gather the RT_ICON images
   it references, and stitch them back into an .ico (which is literally
   a GROUP_ICON directory + the same image blobs, with byte offsets
   instead of resource ids). Browsers render .ico in <img> directly.

   Everything here is bounds-checked and wrapped by the caller in a
   try/catch — a malformed/packed/non-PE file just yields null, never a
   throw that could take down a request. We read only headers + the
   .rsrc section, so even a huge exe is cheap.
   ============================================================ */

'use strict';

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

/* A GROUP_ICON resource is a small directory; each entry's bytes mirror an
   ICONDIRENTRY except the trailing 4-byte field is a 2-byte RT_ICON resource
   id (vs. a 4-byte file offset in a real .ico). We translate between the two. */

function u16(buf, o) { return buf.readUInt16LE(o); }
function u32(buf, o) { return buf.readUInt32LE(o); }

/* Locate the resource (.rsrc) section and the PE's image base + the section
   table, returning what we need to walk the resource tree. Returns null for
   anything that isn't a well-formed PE with a resource directory. */
function parsePE(buf) {
  if (buf.length < 0x40 || u16(buf, 0) !== 0x5a4d) return null;   // 'MZ'
  const peOff = u32(buf, 0x3c);
  if (peOff <= 0 || peOff + 24 > buf.length) return null;
  if (u32(buf, peOff) !== 0x00004550) return null;               // 'PE\0\0'

  const coffOff = peOff + 4;
  const numSections = u16(buf, coffOff + 2);
  const optSize = u16(buf, coffOff + 16);
  const optOff = coffOff + 20;
  if (optOff + optSize > buf.length || optOff + 2 > buf.length) return null;

  const magic = u16(buf, optOff);
  // PE32 (0x10b) vs PE32+ (0x20b) only change the optional-header layout; the
  // data-directory array sits at a different offset in each.
  const isPlus = magic === 0x20b;
  if (magic !== 0x10b && !isPlus) return null;

  // data directories start after the fixed part of the optional header
  const ddOff = optOff + (isPlus ? 112 : 96);
  // directory index 2 = resource table (RVA + size)
  const resDirEntryOff = ddOff + 2 * 8;
  if (resDirEntryOff + 8 > buf.length) return null;
  const resRVA = u32(buf, resDirEntryOff);
  if (!resRVA) return null;                                       // no resources at all

  // section table follows the optional header
  const secTableOff = optOff + optSize;
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const s = secTableOff + i * 40;
    if (s + 40 > buf.length) return null;
    sections.push({
      vaddr: u32(buf, s + 12),
      vsize: u32(buf, s + 8),
      rawSize: u32(buf, s + 16),
      rawPtr: u32(buf, s + 20),
    });
  }
  return { buf, sections, resRVA };
}

/* Map a resource RVA to a file offset using the section that contains it.
   Resource pointers inside the .rsrc tree are RVAs (image-relative), so every
   dereference goes through here. */
function rvaToOffset(pe, rva) {
  for (const s of pe.sections) {
    if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize)) {
      const off = s.rawPtr + (rva - s.vaddr);
      return off < pe.buf.length ? off : -1;
    }
  }
  return -1;
}

/* Walk one IMAGE_RESOURCE_DIRECTORY, returning its entries as
   { id, nameOffset, isDir, offset } relative to the resource base. */
function readResDir(buf, base, dirOff) {
  if (dirOff < 0 || dirOff + 16 > buf.length) return [];
  const nNamed = u16(buf, dirOff + 12);
  const nId = u16(buf, dirOff + 14);
  const total = nNamed + nId;
  const entries = [];
  let p = dirOff + 16;
  for (let i = 0; i < total; i++, p += 8) {
    if (p + 8 > buf.length) break;
    const nameField = u32(buf, p);
    const offField = u32(buf, p + 4);
    entries.push({
      id: nameField & 0x80000000 ? null : nameField,    // high bit => named (string), else integer id
      isDir: !!(offField & 0x80000000),
      offset: base + (offField & 0x7fffffff),
    });
  }
  return entries;
}

/* Resolve a leaf (IMAGE_RESOURCE_DATA_ENTRY) to the actual bytes. */
function readResData(pe, base, dataEntryOff) {
  const buf = pe.buf;
  if (dataEntryOff < 0 || dataEntryOff + 16 > buf.length) return null;
  const rva = u32(buf, dataEntryOff);
  const size = u32(buf, dataEntryOff + 4);
  const off = rvaToOffset(pe, rva);
  if (off < 0 || size <= 0 || off + size > buf.length) return null;
  return buf.subarray(off, off + size);
}

/* Pick the first leaf under a directory entry (we don't care about language;
   take whatever language sub-entry exists). */
function firstLeaf(pe, base, entry) {
  if (!entry.isDir) return entry.offset;        // already a data entry
  const langDir = readResDir(pe.buf, base, entry.offset);
  if (!langDir.length) return -1;
  const leaf = langDir[0];
  return leaf.isDir ? -1 : leaf.offset;         // language level should be a leaf
}

/* Score an icon group entry so we can choose a "best" representative group when
   an exe has several (apps often have a main-app group + smaller ones). We
   prefer the group whose largest image is biggest — that's the high-res app
   icon the shell shows at large sizes. */
function groupBestDim(buf, groupBytes) {
  // GRPICONDIR: reserved(2) type(2) count(2), then count * GRPICONDIRENTRY(14)
  if (!groupBytes || groupBytes.length < 6) return 0;
  const count = u16(groupBytes, 4);
  let best = 0;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 14;
    if (e + 14 > groupBytes.length) break;
    let w = groupBytes[e];        // 0 means 256
    let h = groupBytes[e + 1];
    w = w === 0 ? 256 : w;
    h = h === 0 ? 256 : h;
    best = Math.max(best, Math.min(w, h));
  }
  return best;
}

/* Build a .ico file buffer from a GROUP_ICON resource + a map of
   RT_ICON id -> image bytes. The .ico on-disk format is:
     ICONDIR (6 bytes) + count * ICONDIRENTRY (16 bytes) + image blobs.
   GRPICONDIRENTRY is 14 bytes and ends with a 2-byte icon id; ICONDIRENTRY is
   16 bytes and ends with a 4-byte byte-offset. We rewrite each entry and lay
   the image blobs out after the directory. */
function buildIco(groupBytes, iconImages) {
  const count = u16(groupBytes, 4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 14;
    if (e + 14 > groupBytes.length) break;
    const id = u16(groupBytes, e + 12);
    const img = iconImages.get(id);
    if (!img) continue;
    entries.push({
      width: groupBytes[e],
      height: groupBytes[e + 1],
      colorCount: groupBytes[e + 2],
      reserved: groupBytes[e + 3],
      planes: u16(groupBytes, e + 4),
      bitCount: u16(groupBytes, e + 6),
      bytes: img,
    });
  }
  if (!entries.length) return null;

  const headerSize = 6 + entries.length * 16;
  let offset = headerSize;
  const head = Buffer.alloc(headerSize);
  head.writeUInt16LE(0, 0);                 // reserved
  head.writeUInt16LE(1, 2);                 // type 1 = icon
  head.writeUInt16LE(entries.length, 4);    // count
  let p = 6;
  for (const en of entries) {
    head.writeUInt8(en.width, p);
    head.writeUInt8(en.height, p + 1);
    head.writeUInt8(en.colorCount, p + 2);
    head.writeUInt8(en.reserved, p + 3);
    head.writeUInt16LE(en.planes, p + 4);
    head.writeUInt16LE(en.bitCount, p + 6);
    head.writeUInt32LE(en.bytes.length, p + 8);
    head.writeUInt32LE(offset, p + 12);
    offset += en.bytes.length;
    p += 16;
  }
  return Buffer.concat([head, ...entries.map(e => e.bytes)]);
}

/* Main entry point. Given the full bytes of a PE file, return a Buffer holding
   a valid .ico for its primary icon, or null if there's no icon / not a PE. */
function extractIco(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  let pe;
  try { pe = parsePE(buf); } catch (e) { return null; }
  if (!pe) return null;

  const base = rvaToOffset(pe, pe.resRVA);
  if (base < 0) return null;

  // level 1: resource types. Find RT_GROUP_ICON (14) and RT_ICON (3).
  const types = readResDir(pe.buf, base, base);
  const groupType = types.find(t => t.id === RT_GROUP_ICON && t.isDir);
  const iconType = types.find(t => t.id === RT_ICON && t.isDir);
  if (!groupType || !iconType) return null;

  // level 2 under RT_GROUP_ICON: one entry per named icon group
  const groupEntries = readResDir(pe.buf, base, groupType.offset);
  if (!groupEntries.length) return null;

  // choose the group with the largest max-dimension image (the app icon)
  let bestGroup = null, bestDim = -1;
  for (const ge of groupEntries) {
    const leaf = firstLeaf(pe, base, ge);
    if (leaf < 0) continue;
    const bytes = readResData(pe, base, leaf);
    if (!bytes || bytes.length < 6) continue;
    const dim = groupBestDim(pe.buf, bytes);
    if (dim > bestDim) { bestDim = dim; bestGroup = bytes; }
  }
  if (!bestGroup) return null;

  // build an id -> image-bytes map from the RT_ICON directory
  const iconEntries = readResDir(pe.buf, base, iconType.offset);
  const iconImages = new Map();
  for (const ie of iconEntries) {
    if (ie.id == null) continue;
    const leaf = firstLeaf(pe, base, ie);
    if (leaf < 0) continue;
    const bytes = readResData(pe, base, leaf);
    if (bytes) iconImages.set(ie.id, bytes);
  }
  if (!iconImages.size) return null;

  try { return buildIco(bestGroup, iconImages); }
  catch (e) { return null; }
}

/* Convenience for thumbnails: return the single best displayable image rather
   than a multi-size .ico. If the primary group has a PNG sub-image (modern
   high-res icons store the 256px image as PNG), return that PNG directly — it's
   the sharpest and renders identically everywhere. Otherwise fall back to the
   assembled .ico (DIB images wrapped in an icon container), which browsers also
   render in <img>. Returns { buffer, ext } or null.
   ext is 'png' or 'ico' so the caller can set the right content-type. */
function extractBestImage(buf) {
  const ico = extractIco(buf);
  if (!ico) return null;
  // scan the ICONDIR for a PNG sub-image and return the largest one
  const count = ico.readUInt16LE(4);
  let bestPng = null, bestPngDim = -1;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const size = ico.readUInt32LE(e + 8);
    const off = ico.readUInt32LE(e + 12);
    if (off + 8 > ico.length || off + size > ico.length) continue;
    const isPng = ico[off] === 0x89 && ico[off + 1] === 0x50 && ico[off + 2] === 0x4e && ico[off + 3] === 0x47;
    if (!isPng) continue;
    let w = ico[e] || 256;
    if (w > bestPngDim) { bestPngDim = w; bestPng = ico.subarray(off, off + size); }
  }
  if (bestPng) return { buffer: Buffer.from(bestPng), ext: 'png' };
  return { buffer: ico, ext: 'ico' };
}

module.exports = { extractIco, extractBestImage };

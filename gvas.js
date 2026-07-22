/* ============================================================
   GVAS — Unreal Engine 4 .sav parser / serializer / editor core.

   Parses a UE4 "GVAS" save into a property tree, flattens it to a flat list of
   editable scalar leaves (bool/int/float/string/enum), applies edits back into
   the tree, recomputes all container byte-sizes bottom-up, and re-serializes.

   Verified to round-trip real saves byte-for-byte (Backrooms BP_New_SaveGame).
   Pure browser code: works on Uint8Array via DataView (no Node Buffer). Also
   loadable under Node for tests. Exposed as the global `GVAS`.

   FString encoding: int32 len; len>0 => `len` Latin-1 bytes incl. trailing NUL;
   len<0 => `-len` UTF-16LE code units incl. trailing NUL; 0 => empty. We remember
   whether each string was wide so we re-emit it identically.
   ============================================================ */
(function (root) {
  'use strict';

  const td = new TextDecoder('latin1');
  const td16 = new TextDecoder('utf-16le');

  /* ---------------- Reader ---------------- */
  function Reader(u8) { this.b = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.o = 0; }
  Reader.prototype.u8 = function () { return this.dv.getUint8(this.o++); };
  Reader.prototype.i32 = function () { const v = this.dv.getInt32(this.o, true); this.o += 4; return v; };
  Reader.prototype.u32 = function () { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; };
  Reader.prototype.u16 = function () { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; };
  Reader.prototype.i64 = function () { const v = this.dv.getBigInt64(this.o, true); this.o += 8; return v; };
  Reader.prototype.f32 = function () { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; };
  Reader.prototype.f64 = function () { const v = this.dv.getFloat64(this.o, true); this.o += 8; return v; };
  Reader.prototype.bytes = function (n) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; };
  Reader.prototype.guid = function () { return this.b.slice(this.o, (this.o += 16)); };
  Reader.prototype.str = function () {
    const len = this.i32();
    if (len === 0) return { s: '', wide: false };
    if (len > 0) { const slice = this.b.subarray(this.o, this.o + len); this.o += len; return { s: td.decode(slice.subarray(0, len - 1)), wide: false }; }
    const n = -len; const slice = this.b.subarray(this.o, this.o + n * 2); this.o += n * 2; return { s: td16.decode(slice.subarray(0, (n - 1) * 2)), wide: true };
  };

  /* ---------------- Writer ---------------- */
  function Writer() { this.parts = []; this.len = 0; }
  Writer.prototype._push = function (buf) { this.parts.push(buf); this.len += buf.length; };
  Writer.prototype.u8 = function (v) { this._push(Uint8Array.of(v & 0xff)); };
  Writer.prototype.i32 = function (v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v | 0, true); this._push(b); };
  Writer.prototype.u32 = function (v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this._push(b); };
  Writer.prototype.u16 = function (v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v & 0xffff, true); this._push(b); };
  Writer.prototype.i64 = function (v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), true); this._push(b); };
  Writer.prototype.f32 = function (v) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this._push(b); };
  Writer.prototype.f64 = function (v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); this._push(b); };
  Writer.prototype.raw = function (u8) { this._push(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8)); };
  Writer.prototype.str = function (s, wide) {
    if (s == null) s = '';
    if (s === '') { this.i32(0); return; }
    if (wide) {
      const cu = s.length + 1; this.i32(-cu);
      const b = new Uint8Array(cu * 2); const dv = new DataView(b.buffer);
      for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true);
      this._push(b);                                  // last code unit left 0 (NUL)
    } else {
      const b = new Uint8Array(s.length + 1);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
      this.i32(b.length); this._push(b);              // trailing byte 0 (NUL)
    }
  };
  Writer.prototype.build = function () {
    const out = new Uint8Array(this.len); let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  };
  /* measure the serialized length produced by a writer callback (for size fields) */
  function measure(fn) { const w = new Writer(); fn(w); return w.len; }

  /* ---------------- header ---------------- */
  function readHeader(r) {
    const h = {};
    h.magic = td.decode(r.bytes(4));
    if (h.magic !== 'GVAS') throw new Error('Not a UE4 save file (missing GVAS header).');
    h.saveGameVersion = r.i32();
    h.packageVersion = r.i32();
    h.engineMajor = r.u16(); h.engineMinor = r.u16(); h.enginePatch = r.u16(); h.engineChangelist = r.u32();
    h.engineBranch = r.str();
    h.customFormatVersion = r.i32();
    const count = r.i32(); h.customFormats = [];
    for (let i = 0; i < count; i++) h.customFormats.push({ guid: r.guid(), val: r.i32() });
    h.saveClass = r.str();
    return h;
  }
  function writeHeader(w, h) {
    for (let i = 0; i < 4; i++) w.u8(h.magic.charCodeAt(i));
    w.i32(h.saveGameVersion); w.i32(h.packageVersion);
    w.u16(h.engineMajor); w.u16(h.engineMinor); w.u16(h.enginePatch); w.u32(h.engineChangelist);
    w.str(h.engineBranch.s, h.engineBranch.wide);
    w.i32(h.customFormatVersion); w.i32(h.customFormats.length);
    for (const c of h.customFormats) { w.raw(c.guid); w.i32(c.val); }
    w.str(h.saveClass.s, h.saveClass.wide);
  }

  /* ---------------- fixed (numeric) structs ---------------- */
  const FIXED_READ = {
    Vector: r => ({ x: r.f32(), y: r.f32(), z: r.f32() }),
    Rotator: r => ({ x: r.f32(), y: r.f32(), z: r.f32() }),
    Quat: r => ({ x: r.f32(), y: r.f32(), z: r.f32(), w: r.f32() }),
    Vector2D: r => ({ x: r.f32(), y: r.f32() }),
    LinearColor: r => ({ r: r.f32(), g: r.f32(), b: r.f32(), a: r.f32() }),
    Guid: r => r.guid(),
  };
  const FIXED_WRITE = {
    Vector: (w, v) => { w.f32(v.x); w.f32(v.y); w.f32(v.z); },
    Rotator: (w, v) => { w.f32(v.x); w.f32(v.y); w.f32(v.z); },
    Quat: (w, v) => { w.f32(v.x); w.f32(v.y); w.f32(v.z); w.f32(v.w); },
    Vector2D: (w, v) => { w.f32(v.x); w.f32(v.y); },
    LinearColor: (w, v) => { w.f32(v.r); w.f32(v.g); w.f32(v.b); w.f32(v.a); },
    Guid: (w, v) => { w.raw(v); },
  };

  /* ---------------- property tree (read) ---------------- */
  function readPropertiesUntilNone(r) {
    const props = [];
    for (;;) {
      const name = r.str();
      if (name.s === 'None' || name.s === '') return { props, terminator: name };
      props.push(readProperty(r, name));
    }
  }
  function readProperty(r, name) {
    const type = r.str();
    const size = r.i64();
    const p = { name, type: type.s, _typeWide: type.wide, size };
    switch (type.s) {
      case 'BoolProperty': p.value = r.u8() !== 0; p.hasGuid = r.u8(); return p;
      case 'IntProperty': p.hasGuid = r.u8(); p.value = r.i32(); return p;
      case 'UInt32Property': p.hasGuid = r.u8(); p.value = r.u32(); return p;
      case 'Int64Property': p.hasGuid = r.u8(); p.value = r.i64(); return p;
      case 'FloatProperty': p.hasGuid = r.u8(); p.value = r.f32(); return p;
      case 'DoubleProperty': p.hasGuid = r.u8(); p.value = r.f64(); return p;
      case 'StrProperty': p.hasGuid = r.u8(); p.value = r.str(); return p;
      case 'NameProperty': p.hasGuid = r.u8(); p.value = r.str(); return p;
      case 'ObjectProperty': p.hasGuid = r.u8(); p.value = r.str(); return p;
      case 'EnumProperty': p.enumType = r.str(); p.hasGuid = r.u8(); p.value = r.str(); return p;
      case 'ByteProperty':
        p.enumName = r.str(); p.hasGuid = r.u8();
        if (p.enumName.s === 'None') { p.byte = r.u8(); p.isRawByte = true; } else { p.value = r.str(); }
        return p;
      case 'StructProperty':
        p.structType = r.str(); p.structGuid = r.guid(); p.hasGuid = r.u8();
        p.struct = readStructBody(r, p.structType.s);
        return p;
      case 'ArrayProperty': {
        p.elemType = r.str(); p.hasGuid = r.u8(); p.count = r.i32();
        if (p.elemType.s === 'StructProperty') {
          p.innerName = r.str(); p.innerType = r.str(); p.innerSize = r.i64();
          p.innerStructType = r.str(); p.innerGuid = r.guid(); p.innerHasGuid = r.u8();
          p.elems = [];
          for (let i = 0; i < p.count; i++) p.elems.push(readStructBody(r, p.innerStructType.s));
        } else {
          p.elems = [];
          for (let i = 0; i < p.count; i++) p.elems.push(readSimpleValue(r, p.elemType.s));
        }
        return p;
      }
      case 'MapProperty':
        p.keyType = r.str(); p.valType = r.str(); p.hasGuid = r.u8();
        p.numKeysToRemove = r.i32(); p.count = r.i32(); p.entries = [];
        for (let i = 0; i < p.count; i++) p.entries.push({ key: readMapInner(r, p.keyType.s, true), val: readMapInner(r, p.valType.s, false) });
        return p;
      default:
        // Unknown type: capture the raw payload so the file still round-trips.
        p.raw = r.bytes(Number(size)).slice(); p.unknown = true; return p;
    }
  }
  function readStructBody(r, structType) {
    if (FIXED_READ[structType]) return { fixed: structType, val: FIXED_READ[structType](r) };
    const inner = readPropertiesUntilNone(r);
    return { fixed: null, props: inner.props, terminator: inner.terminator };
  }
  function readSimpleValue(r, type) {
    switch (type) {
      case 'BoolProperty': return { kind: 'bool', value: r.u8() !== 0 };
      case 'ByteProperty': return { kind: 'byte', value: r.u8() };
      case 'IntProperty': return { kind: 'int', value: r.i32() };
      case 'Int64Property': return { kind: 'int64', value: r.i64() };
      case 'FloatProperty': return { kind: 'float', value: r.f32() };
      case 'NameProperty': return { kind: 'name', value: r.str() };
      case 'StrProperty': return { kind: 'str', value: r.str() };
      case 'ObjectProperty': return { kind: 'object', value: r.str() };
      case 'EnumProperty': return { kind: 'enum', value: r.str() };
      default: throw new Error('Unsupported array element type: ' + type);
    }
  }
  /* A StructProperty *key* in a map is a bare 16-byte Guid; a *value* is a
     properties-until-None block. (Matches the real saves we target.) */
  function readMapInner(r, type, isKey) {
    if (type === 'StructProperty') return isKey ? { kind: 'structGuid', guid: r.guid() } : { kind: 'struct', body: readStructBody(r, '') };
    return readSimpleValue(r, type);
  }

  /* ---------------- property tree (write) ---------------- */
  function writePropertiesWithNone(w, block) { for (const p of block.props) writeProperty(w, p); w.str(block.terminator.s, block.terminator.wide); }
  function writeProperty(w, p) {
    w.str(p.name.s, p.name.wide); w.str(p.type, p._typeWide); w.i64(p.size);
    switch (p.type) {
      case 'BoolProperty': w.u8(p.value ? 1 : 0); w.u8(p.hasGuid); break;
      case 'IntProperty': w.u8(p.hasGuid); w.i32(p.value); break;
      case 'UInt32Property': w.u8(p.hasGuid); w.u32(p.value); break;
      case 'Int64Property': w.u8(p.hasGuid); w.i64(p.value); break;
      case 'FloatProperty': w.u8(p.hasGuid); w.f32(p.value); break;
      case 'DoubleProperty': w.u8(p.hasGuid); w.f64(p.value); break;
      case 'StrProperty': w.u8(p.hasGuid); w.str(p.value.s, p.value.wide); break;
      case 'NameProperty': w.u8(p.hasGuid); w.str(p.value.s, p.value.wide); break;
      case 'ObjectProperty': w.u8(p.hasGuid); w.str(p.value.s, p.value.wide); break;
      case 'EnumProperty': w.str(p.enumType.s, p.enumType.wide); w.u8(p.hasGuid); w.str(p.value.s, p.value.wide); break;
      case 'ByteProperty':
        w.str(p.enumName.s, p.enumName.wide); w.u8(p.hasGuid);
        if (p.isRawByte) w.u8(p.byte); else w.str(p.value.s, p.value.wide);
        break;
      case 'StructProperty': w.str(p.structType.s, p.structType.wide); w.raw(p.structGuid); w.u8(p.hasGuid); writeStructBody(w, p.struct); break;
      case 'ArrayProperty':
        w.str(p.elemType.s, p.elemType.wide); w.u8(p.hasGuid); w.i32(p.count);
        if (p.elemType.s === 'StructProperty') {
          w.str(p.innerName.s, p.innerName.wide); w.str(p.innerType.s, p.innerType.wide); w.i64(p.innerSize);
          w.str(p.innerStructType.s, p.innerStructType.wide); w.raw(p.innerGuid); w.u8(p.innerHasGuid);
          for (const e of p.elems) writeStructBody(w, e);
        } else { for (const e of p.elems) writeSimpleValue(w, p.elemType.s, e); }
        break;
      case 'MapProperty':
        w.str(p.keyType.s, p.keyType.wide); w.str(p.valType.s, p.valType.wide); w.u8(p.hasGuid);
        w.i32(p.numKeysToRemove); w.i32(p.count);
        for (const en of p.entries) { writeMapInner(w, p.keyType.s, en.key); writeMapInner(w, p.valType.s, en.val); }
        break;
      default: w.raw(p.raw); break;
    }
  }
  function writeStructBody(w, body) { if (body.fixed) { FIXED_WRITE[body.fixed](w, body.val); return; } writePropertiesWithNone(w, body); }
  function writeSimpleValue(w, type, v) {
    switch (type) {
      case 'BoolProperty': w.u8(v.value ? 1 : 0); break;
      case 'ByteProperty': w.u8(v.value); break;
      case 'IntProperty': w.i32(v.value); break;
      case 'Int64Property': w.i64(v.value); break;
      case 'FloatProperty': w.f32(v.value); break;
      case 'NameProperty': w.str(v.value.s, v.value.wide); break;
      case 'StrProperty': w.str(v.value.s, v.value.wide); break;
      case 'ObjectProperty': w.str(v.value.s, v.value.wide); break;
      case 'EnumProperty': w.str(v.value.s, v.value.wide); break;
      default: throw new Error('cannot write array elem type: ' + type);
    }
  }
  function writeMapInner(w, type, v) {
    if (type === 'StructProperty') { if (v.kind === 'structGuid') { w.raw(v.guid); return; } writeStructBody(w, v.body); return; }
    writeSimpleValue(w, type, v);
  }

  /* ---------------- bottom-up size recompute ----------------
     A string edit changes the FString byte length, so every container that wraps
     it (Struct/Array/Map) has a `size`/`innerSize` field that must be recomputed
     from its serialized children. Numeric/bool leaves are fixed width — untouched. */
  function recomputeAll(props) { for (const p of props) recomputeProp(p); }
  function recomputeProp(p) {
    switch (p.type) {
      case 'StrProperty': case 'NameProperty': case 'ObjectProperty': case 'EnumProperty':
        p.size = BigInt(measure(w => w.str(p.value.s, p.value.wide))); break;
      case 'ByteProperty':
        p.size = BigInt(p.isRawByte ? 1 : measure(w => w.str(p.value.s, p.value.wide))); break;
      case 'StructProperty':
        if (!p.struct.fixed) recomputeAll(p.struct.props);
        p.size = BigInt(measure(w => writeStructBody(w, p.struct))); break;
      case 'ArrayProperty':
        if (p.elemType.s === 'StructProperty') {
          p.elems.forEach(e => { if (!e.fixed) recomputeAll(e.props); });
          p.innerSize = BigInt(measure(w => { for (const e of p.elems) writeStructBody(w, e); }));
          p.size = BigInt(measure(w => {
            w.i32(p.count); w.str(p.innerName.s, p.innerName.wide); w.str(p.innerType.s, p.innerType.wide); w.i64(p.innerSize);
            w.str(p.innerStructType.s, p.innerStructType.wide); w.raw(p.innerGuid); w.u8(p.innerHasGuid);
            for (const e of p.elems) writeStructBody(w, e);
          }));
        } else {
          p.size = BigInt(measure(w => { w.i32(p.count); for (const e of p.elems) writeSimpleValue(w, p.elemType.s, e); }));
        }
        break;
      case 'MapProperty':
        p.entries.forEach(en => { if (en.val.kind === 'struct' && !en.val.body.fixed) recomputeAll(en.val.body.props); });
        p.size = BigInt(measure(w => { w.i32(p.numKeysToRemove); w.i32(p.count); for (const en of p.entries) { writeMapInner(w, p.keyType.s, en.key); writeMapInner(w, p.valType.s, en.val); } }));
        break;
      // Int/UInt32/Int64/Float/Double/Bool: fixed width — size never changes.
    }
  }

  /* ---------------- top-level parse / serialize ---------------- */
  function parse(u8) {
    if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
    const r = new Reader(u8);
    const header = readHeader(r);
    const body = readPropertiesUntilNone(r);
    const trailing = u8.slice(r.o);              // UE appends 4 zero bytes after the final None
    return { header, body, trailing };
  }
  function serialize(save) {
    recomputeAll(save.body.props);               // keep all size fields consistent with current values
    const w = new Writer();
    writeHeader(w, save.header);
    writePropertiesWithNone(w, save.body);
    w.raw(save.trailing);
    return w.build();
  }

  /* ---------------- flatten to editable leaves ----------------
     Returns [{ path:[...], label, kind:'bool'|'int'|'float'|'str', get(), set(v) }].
     Edits mutate the live tree; call serialize() afterwards. */
  function flatten(save) {
    const leaves = [];
    const pushLeaf = (path, kind, get, set, meta) => leaves.push(Object.assign({ path, label: path[path.length - 1], kind, get, set }, meta || {}));

    const walkProps = (props, path) => props.forEach(p => addProp(p, path.concat(cleanName(p.name.s))));
    const addProp = (p, path) => {
      switch (p.type) {
        case 'BoolProperty': pushLeaf(path, 'bool', () => p.value, v => { p.value = !!v; }); break;
        case 'IntProperty': case 'UInt32Property': pushLeaf(path, 'int', () => p.value, v => { p.value = Math.trunc(Number(v)) | 0; }); break;
        case 'Int64Property': pushLeaf(path, 'int', () => p.value.toString(), v => { p.value = BigInt(Math.trunc(Number(v))); }); break;
        case 'FloatProperty': case 'DoubleProperty': pushLeaf(path, 'float', () => p.value, v => { p.value = Number(v); }); break;
        case 'StrProperty': case 'NameProperty': case 'ObjectProperty': pushLeaf(path, 'str', () => p.value.s, v => { p.value.s = String(v); }); break;
        case 'EnumProperty': pushLeaf(path, 'str', () => p.value.s, v => { p.value.s = String(v); }, { enumType: p.enumType.s }); break;
        case 'ByteProperty':
          if (p.isRawByte) pushLeaf(path, 'int', () => p.byte, v => { p.byte = Number(v) & 0xff; });
          else pushLeaf(path, 'str', () => p.value.s, v => { p.value.s = String(v); });
          break;
        case 'StructProperty': walkStruct(p.struct, path); break;
        case 'ArrayProperty':
          if (p.elemType.s === 'StructProperty') p.elems.forEach((e, i) => walkStruct(e, path.concat('[' + i + ']')));
          else p.elems.forEach((e, i) => addSimple(e, path.concat('[' + i + ']')));
          break;
        case 'MapProperty':
          p.entries.forEach((en, i) => {
            const kl = mapKeyLabel(en.key, i);
            if (en.val.kind === 'struct') walkStruct(en.val.body, path.concat('{' + kl + '}'));
            else addSimple(en.val, path.concat('{' + kl + '}'));
          });
          break;
        // unknown: not editable, skipped (still round-trips via raw bytes)
      }
    };
    const walkStruct = (body, path) => {
      if (body.fixed) {
        if (body.val && typeof body.val === 'object' && !(body.val instanceof Uint8Array)) {
          Object.keys(body.val).forEach(k => pushLeaf(path.concat(k), 'float', () => body.val[k], v => { body.val[k] = Number(v); }));
        }
      } else walkProps(body.props, path);
    };
    const addSimple = (e, path) => {
      if (e.kind === 'bool') pushLeaf(path, 'bool', () => e.value, v => { e.value = !!v; });
      else if (e.kind === 'int' || e.kind === 'byte') pushLeaf(path, 'int', () => e.value, v => { e.value = Math.trunc(Number(v)) | 0; });
      else if (e.kind === 'int64') pushLeaf(path, 'int', () => e.value.toString(), v => { e.value = BigInt(Math.trunc(Number(v))); });
      else if (e.kind === 'float') pushLeaf(path, 'float', () => e.value, v => { e.value = Number(v); });
      else if (e.value && e.value.s != null) pushLeaf(path, 'str', () => e.value.s, v => { e.value.s = String(v); });
    };
    walkProps(save.body.props, []);
    return leaves;
  }
  /* UE property names are suffixed with _<index>_<GUID>; show the clean name. */
  function cleanName(s) { const m = /^(.*?)_\d+_[0-9A-Fa-f]{32}$/.exec(s); return m ? m[1] : s; }
  function mapKeyLabel(key, i) {
    if (key.kind === 'structGuid') return hex8(key.guid);
    if (key.value && key.value.s != null) return key.value.s;
    if (key.value != null) return String(key.value);
    return '#' + i;
  }
  function hex8(u8) { let s = ''; for (let i = 0; i < 4 && i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0'); return s; }

  root.GVAS = { parse, serialize, flatten, recomputeAll, cleanName, Reader, Writer };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

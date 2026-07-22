/* ============================================================
   UASSET — Unreal Engine .uasset package identifier (READ-ONLY).

   A .uasset is a serialized UE *package*, not a self-contained mesh. We do NOT
   fully deserialize it. The goal is narrow and robust: confirm the file is a real
   UE package and figure out *what kind of asset it is* (StaticMesh, SkeletalMesh,
   Texture2D, Material, …) so the viewer can show a mesh panel or a "this asset
   type isn't previewable" message naming the type.

   The renderable mesh geometry is cooked, engine-version-specific, and for most
   games lives in a separate .uexp/.ubulk sidecar the vault stores independently —
   so a standalone .uasset usually has no geometry to draw. Hence: identify, don't
   render. (Mirrors how gvas.js powers the .sav editor — pure browser code over
   Uint8Array/DataView, also loadable under Node for headless tests.)

   HOW WE IDENTIFY THE CLASS (verified against real UE5 project assets):
     1. Parse the FPackageFileSummary deterministically to get the Name table and
        the Import/Export map offsets. The summary layout is version-gated; the
        important UE5.1+ wrinkle is a 20-byte SavedHash + 4-byte TotalHeaderSize
        block right after the version fields (skipping it is what makes the
        custom-version array and everything after it line up).
     2. Read the Name table (FName strings) and the Import map (each import's
        ObjectName is an engine class name like 'StaticMesh').
     3. Read the Export map; the asset's *primary* export is the one whose
        ObjectName equals the package's base name (e.g. package /Game/…/SM_Door →
        export 'SM_Door'). Its ClassIndex (an FPackageIndex; negative → import)
        resolves through the import map to the authoritative asset class.
   Import/Export row sizes vary by engine version, so we determine each stride by
   structural validation at the *known* table offset (every FName index in range,
   every FPackageIndex resolvable). If the structured parse fails on an exotic
   version, we fall back to a best-effort name scan so we still say *something*.

   FString encoding matches UE / gvas.js: int32 len; len>0 => `len` Latin-1 bytes
   incl. trailing NUL; len<0 => `-len` UTF-16LE code units incl. trailing NUL.
   ============================================================ */
(function (root) {
  'use strict';

  const PACKAGE_TAG = 0x9e2a83c1;   // FPackageFileSummary.Tag (LE uint32 at offset 0)

  const td = new TextDecoder('latin1');
  const td16 = new TextDecoder('utf-16le');

  /* ---------------- Reader ---------------- */
  function Reader(u8) {
    this.b = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.o = 0;
  }
  Reader.prototype.i32 = function () { const v = this.dv.getInt32(this.o, true); this.o += 4; return v; };
  Reader.prototype.u32 = function () { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; };
  Reader.prototype.skip = function (n) { this.o += n; };
  /* FString. Bounds-checked: a corrupt length must not blow past the buffer. */
  Reader.prototype.str = function () {
    const len = this.i32();
    if (len === 0) return '';
    if (len > 0) {
      if (len > this.b.length - this.o) throw new Error('bad FString length');
      const slice = this.b.subarray(this.o, this.o + len); this.o += len;
      return td.decode(slice.subarray(0, len - 1));
    }
    const n = -len;
    if (n * 2 > this.b.length - this.o) throw new Error('bad FString length');
    const slice = this.b.subarray(this.o, this.o + n * 2); this.o += n * 2;
    return td16.decode(slice.subarray(0, (n - 1) * 2));
  };
  /* length (in bytes) an FString at `off` occupies, without decoding — for skipping. */
  function fstrByteLen(dv, off) {
    const len = dv.getInt32(off, true);
    if (len === 0) return 4;
    return 4 + (len > 0 ? len : -len * 2);
  }

  /* ---------------- asset classes ----------------
     Friendly labels for the classes we name; meshes are the only ones the viewer
     treats specially. Anything not in this table is reported by its raw class name. */
  const MESH_CLASSES = new Set(['StaticMesh', 'SkeletalMesh']);
  const CLASS_LABELS = {
    StaticMesh: 'Static Mesh', SkeletalMesh: 'Skeletal Mesh',
    Texture2D: 'Texture', Texture2DArray: 'Texture Array', TextureCube: 'Cube Texture',
    TextureRenderTarget2D: 'Render Target', VolumeTexture: 'Volume Texture',
    Material: 'Material', MaterialInstanceConstant: 'Material Instance',
    MaterialFunction: 'Material Function', MaterialParameterCollection: 'Material Parameter Collection',
    PhysicsAsset: 'Physics Asset', Skeleton: 'Skeleton',
    AnimSequence: 'Anim Sequence', AnimMontage: 'Anim Montage', BlendSpace: 'Blend Space', BlendSpace1D: 'Blend Space',
    NiagaraSystem: 'Niagara System', NiagaraEmitter: 'Niagara Emitter', ParticleSystem: 'Particle System',
    SoundWave: 'Sound Wave', SoundCue: 'Sound Cue',
    DataTable: 'Data Table', CurveTable: 'Curve Table', CurveFloat: 'Float Curve', CurveLinearColor: 'Color Curve',
    Blueprint: 'Blueprint', BlueprintGeneratedClass: 'Blueprint',
    WidgetBlueprint: 'Widget Blueprint', WidgetBlueprintGeneratedClass: 'Widget Blueprint',
    InputMappingContext: 'Input Mapping Context', InputAction: 'Input Action',
    Font: 'Font', FontFace: 'Font Face', LevelSequence: 'Level Sequence',
    World: 'Level / World', StringTable: 'String Table', DataAsset: 'Data Asset',
  };
  /* classes we're confident enough about to stop searching strides on (a resolved
     primary-export class that's one of these is almost certainly the real answer). */
  const KNOWN_CLASSES = new Set(Object.keys(CLASS_LABELS));

  /* ---------------- summary ----------------
     Reads only as far as the Import/Export map offsets. Returns null on any layout
     inconsistency (caller falls back to the name scan). */
  function readSummary(u8) {
    const r = new Reader(u8);
    if (r.u32() !== PACKAGE_TAG) throw new Error('Not an Unreal Engine .uasset (bad package signature).');
    const legacy = r.i32();
    if (legacy >= 0) return null;                       // ancient/unsupported layout
    if (legacy !== -4) r.i32();                          // LegacyUE3Version
    const ue4 = r.i32();
    let ue5 = 0;
    if (legacy <= -8) ue5 = r.i32();                    // FileVersionUE5 (UE5 only)
    r.i32();                                            // FileVersionLicenseeUE4
    // UE5.1+ inserts SavedHash (20 bytes) + TotalHeaderSize (4 bytes) here. Gate on
    // the UE5 release-stream version (1008+) or the -9 legacy tag with a UE5 version.
    const isUE51 = ue5 >= 1008 || (ue5 > 0 && legacy <= -9);
    if (isUE51) r.skip(24);
    const cvCount = r.i32();                            // FCustomVersionContainer count
    if (cvCount < 0 || cvCount > 10000) return null;
    r.skip(cvCount * 20);                               // each: Guid(16) + version(4)
    if (!isUE51) r.i32();                                // TotalHeaderSize (older position)
    const pkgName = r.str();                            // FolderName / deprecated PackageName
    r.u32();                                            // PackageFlags
    const nameCount = r.i32();
    const nameOffset = r.i32();
    if (nameCount < 0 || nameCount > 5_000_000) return null;
    if (nameOffset <= 0 || nameOffset >= u8.length) return null;
    if (isUE51) { r.i32(); r.i32(); }                  // SoftObjectPaths count/offset
    // LocalizationId — an FString present for editor-saved packages (UE4.20+). It's
    // flag-gated in the engine, but skipping a sane-looking FString here keeps the
    // following count/offset pairs aligned across the assets we've validated.
    {
      const len = r.dv.getInt32(r.o, true);
      if (len === 0) r.skip(4);
      else if (Math.abs(len) < 512) r.skip(fstrByteLen(r.dv, r.o));
    }
    r.i32(); r.i32();                                  // GatherableTextData count/offset
    const exportCount = r.i32();
    const exportOffset = r.i32();
    const importCount = r.i32();
    const importOffset = r.i32();
    if (exportCount < 0 || exportCount > 1_000_000 || importCount < 0 || importCount > 1_000_000) return null;
    if (exportOffset <= 0 || exportOffset >= u8.length || importOffset <= 0 || importOffset >= u8.length) return null;
    const base = (pkgName || '').split('/').pop() || '';
    return { ue4, ue5, nameCount, nameOffset, exportCount, exportOffset, importCount, importOffset, base };
  }

  /* Read the FName string table. Modern packages append 4 hash bytes after each
     entry; older ones don't — we detect which from the first two entries. */
  function readNameTable(u8, off, count) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let hashBytes = 4;
    {
      let probe = off;
      probe += fstrByteLen(dv, probe);
      if (count > 1 && probe + 8 <= u8.length) {
        const withH = dv.getInt32(probe + 4, true), without = dv.getInt32(probe, true);
        const okH = withH !== 0 && Math.abs(withH) < 1024;
        const okW = without !== 0 && Math.abs(without) < 1024;
        hashBytes = (okW && !okH) ? 0 : 4;
      }
    }
    const r = new Reader(u8); r.o = off;
    const names = [];
    for (let i = 0; i < count; i++) {
      if (r.o + 4 > u8.length) return null;
      let s;
      try { s = r.str(); } catch (_) { return null; }
      names.push(s);
      if (i < count - 1) r.skip(hashBytes);
    }
    return names;
  }

  /* Find the byte stride of a fixed-size record table at a known offset by testing
     candidate strides: the first that makes every row validate wins (`validateRow`
     returns false on a bad row). `preferLargest` keeps scanning to the biggest
     stride that still validates (export rows need this — small strides alias). */
  function findStride(u8, off, count, strides, validateRow, preferLargest) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let chosen = null;
    for (const st of strides) {
      if (off + count * st > u8.length) continue;
      let ok = true;
      for (let i = 0; i < count; i++) { if (!validateRow(dv, off + i * st)) { ok = false; break; } }
      if (ok) { chosen = st; if (!preferLargest) break; }
    }
    return chosen;
  }

  // FPackageIndex validity against the table sizes (0 = null, <0 = import, >0 = export)
  function pkgIndexOk(x, importCount, exportCount) {
    return x === 0 || (x < 0 && -x <= importCount) || (x > 0 && x <= exportCount);
  }

  /* ---------------- structured class resolution ---------------- */
  function classifyStructured(u8) {
    const sum = readSummary(u8);
    if (!sum) return null;
    const names = readNameTable(u8, sum.nameOffset, sum.nameCount);
    if (!names) return { sum, names: null, assetClass: null };
    const N = names.length;
    const inRange = (x) => x >= 0 && x < N;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

    // IMPORT row: ClassPackage FName@0, ClassName FName@8, OuterIndex i32@16, ObjectName FName@20
    const impStride = findStride(u8, sum.importOffset, sum.importCount, [40, 28, 32, 36, 44, 48], (dv, b) => {
      const cp = dv.getInt32(b, true), cn = dv.getInt32(b + 8, true), on = dv.getInt32(b + 20, true);
      if (!inRange(cp) || !inRange(cn) || !inRange(on)) return false;
      const pkg = names[cp];
      return pkg.startsWith('/Script') || pkg.startsWith('/Game') || pkg.startsWith('/');
    }, false);
    if (!impStride) return { sum, names, assetClass: null };
    const imports = [];
    for (let i = 0; i < sum.importCount; i++) imports.push(names[dv.getInt32(sum.importOffset + i * impStride + 20, true)] || '');
    const resolve = (ci) => ci < 0 ? (imports[-ci - 1] || null) : (ci === 0 ? 'Class' : null);

    // EXPORT row: ClassIndex i32@0, …, OuterIndex i32@12, ObjectName FName@16.
    // Try every valid stride; for each, the primary export is the one named like the
    // package. Stop at the first stride whose primary resolves to a known class.
    let assetClass = null;
    const expStrides = [112, 72, 76, 68, 80, 84, 88, 92, 96, 100, 104, 108, 116, 120, 128];
    for (const es of expStrides) {
      if (sum.exportOffset + sum.exportCount * es > u8.length) continue;
      let ok = true;
      const rows = [];
      for (let i = 0; i < sum.exportCount; i++) {
        const b = sum.exportOffset + i * es;
        const ci = dv.getInt32(b, true), oi = dv.getInt32(b + 12, true), on = dv.getInt32(b + 16, true);
        if (!inRange(on) || names[on] === '' || !pkgIndexOk(ci, sum.importCount, sum.exportCount) || !pkgIndexOk(oi, sum.importCount, sum.exportCount)) { ok = false; break; }
        rows.push({ ci, name: names[on] });
      }
      if (!ok) continue;
      // primary export: ObjectName === package base name; else first top-level export
      let primary = rows.find(r => r.name === sum.base);
      const cls = primary ? resolve(primary.ci) : null;
      if (cls && KNOWN_CLASSES.has(cls)) { assetClass = cls; break; }
      // mesh tie-break: if any top-level export is a mesh, prefer that
      if (!assetClass) {
        const meshRow = rows.find(r => MESH_CLASSES.has(resolve(r.ci) || ''));
        if (meshRow) { assetClass = resolve(meshRow.ci); break; }
        if (cls) assetClass = cls;   // remember best-effort; keep scanning for a known one
      }
    }
    return { sum, names, assetClass };
  }

  /* ---------------- name-scan fallback ----------------
     If the structured parse can't pin a class (exotic version), look for any known
     class name appearing verbatim in the buffer. Less precise (can pick up a
     referenced class) but better than nothing. */
  function classifyByScan(u8) {
    const runs = [];
    let start = -1;
    for (let i = 0; i < u8.length; i++) {
      const c = u8[i];
      if (c >= 0x20 && c < 0x7f) { if (start < 0) start = i; }
      else { if (start >= 0 && i - start >= 4) runs.push(td.decode(u8.subarray(start, i))); start = -1; }
    }
    const set = new Set(runs);
    // meshes first, then anything else known
    for (const cls of ['StaticMesh', 'SkeletalMesh']) if (set.has(cls)) return cls;
    for (const cls of Object.keys(CLASS_LABELS)) if (set.has(cls)) return cls;
    return null;
  }

  /* ---------------- public parse ---------------- */
  function parse(u8) {
    if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
    if (u8.length < 8) throw new Error('File too small to be an Unreal .uasset.');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, true) !== PACKAGE_TAG) throw new Error('Not an Unreal Engine .uasset (bad package signature).');

    let sum = null, names = null, assetClass = null;
    try {
      const r = classifyStructured(u8);
      if (r) { sum = r.sum; names = r.names; assetClass = r.assetClass; }
    } catch (_) { /* fall through to scan */ }
    if (!assetClass) assetClass = classifyByScan(u8);

    const label = assetClass ? (CLASS_LABELS[assetClass] || assetClass) : null;
    const isMesh = !!assetClass && MESH_CLASSES.has(assetClass);
    return {
      ok: true,
      magic: PACKAGE_TAG,
      fileVersionUE4: sum ? sum.ue4 : 0,
      fileVersionUE5: sum ? (sum.ue5 || 0) : 0,
      nameCount: names ? names.length : (sum ? sum.nameCount : 0),
      assetClass,            // e.g. 'StaticMesh' | 'Material' | null
      label,                 // friendly label e.g. 'Static Mesh' | null
      isMesh,
    };
  }

  root.UASSET = { parse, PACKAGE_TAG, MESH_CLASSES, CLASS_LABELS, Reader };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

/* Node export (guarded) so the parser can be tested headless, like gvas.js. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).UASSET;
}

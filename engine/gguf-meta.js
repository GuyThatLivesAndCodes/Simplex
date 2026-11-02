/* ============================================================
   GGUF HEADER READER — model metadata without loading the model
   ------------------------------------------------------------
   Parses the GGUF header (key/value metadata + tensor table) from the first few
   MB of a model file so the Model Lab can show architecture, parameter count,
   quantization mix, context length and vocab size BEFORE (or without) spinning
   up llama-server. Pure parsing over a Buffer: the caller supplies the bytes
   (a plain fs read for server models, a range-decrypt for vault models), so this
   module never touches keys or the disk itself.

   Big arrays (the vocab / merges lists) are skipped — only their length is kept.
   If the header is larger than the bytes supplied we return what was parsed with
   `partial: true` rather than failing.
   ============================================================ */

'use strict';

const GGML_TYPES = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1',
  10: 'Q2_K', 11: 'Q3_K', 12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K', 15: 'Q8_K',
  16: 'IQ2_XXS', 17: 'IQ2_XS', 18: 'IQ3_XXS', 19: 'IQ1_S', 20: 'IQ4_NL', 21: 'IQ3_S',
  22: 'IQ2_S', 23: 'IQ4_XS', 24: 'I8', 25: 'I16', 26: 'I32', 27: 'I64', 28: 'F64',
  29: 'IQ1_M', 30: 'BF16', 34: 'TQ1_0', 35: 'TQ2_0', 39: 'MXFP4',
};
const FILE_TYPES = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1', 10: 'Q2_K',
  11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M', 16: 'Q5_K_S',
  17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S', 22: 'IQ3_XS',
  23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M', 28: 'IQ2_S',
  29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16', 36: 'TQ1_0', 37: 'TQ2_0', 38: 'MXFP4_MOE',
};

const MAX_STR = 16 * 1024;     // keep strings (e.g. chat templates) up to 16 KB
const MAX_ARR_KEEP = 32;       // keep small arrays verbatim; big ones → length only

class Short extends Error {}

function parseGgufHeader(buf) {
  let o = 0;
  const need = (n) => { if (o + n > buf.length) throw new Short(); };
  const u8 = () => { need(1); return buf.readUInt8(o++); };
  const i8 = () => { need(1); return buf.readInt8(o++); };
  const u16 = () => { need(2); const v = buf.readUInt16LE(o); o += 2; return v; };
  const i16 = () => { need(2); const v = buf.readInt16LE(o); o += 2; return v; };
  const u32 = () => { need(4); const v = buf.readUInt32LE(o); o += 4; return v; };
  const i32 = () => { need(4); const v = buf.readInt32LE(o); o += 4; return v; };
  const f32 = () => { need(4); const v = buf.readFloatLE(o); o += 4; return v; };
  const u64 = () => { need(8); const v = buf.readBigUInt64LE(o); o += 8; return Number(v); };
  const i64 = () => { need(8); const v = buf.readBigInt64LE(o); o += 8; return Number(v); };
  const f64 = () => { need(8); const v = buf.readDoubleLE(o); o += 8; return v; };
  const str = (keep = true) => {
    const n = u64(); need(n);
    const s = keep ? buf.toString('utf8', o, o + Math.min(n, MAX_STR)) : null;
    o += n;
    return s;
  };
  const scalar = (t, keep) => {
    switch (t) {
      case 0: return u8(); case 1: return i8(); case 2: return u16(); case 3: return i16();
      case 4: return u32(); case 5: return i32(); case 6: return f32(); case 7: return !!u8();
      case 8: return str(keep); case 10: return u64(); case 11: return i64(); case 12: return f64();
      default: throw new Error('unknown gguf value type ' + t);
    }
  };
  const value = (t) => {
    if (t !== 9) return scalar(t, true);
    const et = u32(), n = u64();
    const keep = n <= MAX_ARR_KEEP;
    const items = [];
    for (let i = 0; i < n; i++) {
      if (et === 9) throw new Error('nested gguf arrays unsupported');
      const v = scalar(et, keep);
      if (keep) items.push(v);
    }
    return keep ? items : { array: true, length: n };
  };

  const out = { version: null, tensorCount: 0, kv: {}, tensors: null, partial: false };
  try {
    need(4);
    if (buf.toString('latin1', 0, 4) !== 'GGUF') throw new Error('not a GGUF file (bad magic)');
    o = 4;
    out.version = u32();
    if (out.version < 2) throw new Error('GGUF v' + out.version + ' is too old to inspect');
    out.tensorCount = u64();
    const kvCount = u64();
    for (let i = 0; i < kvCount; i++) {
      const k = str();
      const t = u32();
      out.kv[k] = value(t);
    }
    const tensors = [];
    for (let i = 0; i < out.tensorCount; i++) {
      const name = str();
      const nd = u32();
      const dims = [];
      for (let d = 0; d < nd; d++) dims.push(u64());
      const type = u32();
      u64(); // offset
      tensors.push({ name, dims, type });
    }
    out.tensors = tensors;
  } catch (e) {
    if (e instanceof Short) out.partial = true;
    else throw e;
  }
  return out;
}

/* Summarize a parsed header into the shape the UI shows. */
function summarize(h) {
  const kv = h.kv || {};
  const arch = kv['general.architecture'] || null;
  const a = (k) => (arch ? kv[`${arch}.${k}`] : undefined);
  const vocab = kv['tokenizer.ggml.tokens'];
  let params = null, quantMix = null;
  if (h.tensors) {
    params = 0;
    const byType = {};
    for (const t of h.tensors) {
      const n = t.dims.reduce((x, y) => x * y, 1);
      params += n;
      const name = GGML_TYPES[t.type] || ('type' + t.type);
      byType[name] = (byType[name] || 0) + n;
    }
    quantMix = Object.entries(byType)
      .map(([type, n]) => ({ type, share: params ? n / params : 0 }))
      .sort((x, y) => y.share - x.share);
  }
  const ft = kv['general.file_type'];
  return {
    ggufVersion: h.version,
    partial: !!h.partial,
    name: kv['general.name'] || null,
    architecture: arch,
    fileType: ft != null ? (FILE_TYPES[ft] || String(ft)) : null,
    params,
    quantMix,
    tensorCount: h.tensorCount,
    contextLength: a('context_length') ?? null,
    embeddingLength: a('embedding_length') ?? null,
    blockCount: a('block_count') ?? null,
    headCount: a('attention.head_count') ?? null,
    headCountKv: a('attention.head_count_kv') ?? null,
    expertCount: a('expert_count') ?? null,
    ropeFreqBase: a('rope.freq_base') ?? null,
    vocabSize: vocab ? (Array.isArray(vocab) ? vocab.length : vocab.length) : (a('vocab_size') ?? null),
    tokenizer: kv['tokenizer.ggml.model'] || null,
    bosId: kv['tokenizer.ggml.bos_token_id'] ?? null,
    eosId: kv['tokenizer.ggml.eos_token_id'] ?? null,
    hasChatTemplate: typeof kv['tokenizer.chat_template'] === 'string',
    license: kv['general.license'] || null,
    quantizedBy: kv['general.quantized_by'] || null,
    sizeLabel: kv['general.size_label'] || null,
  };
}

module.exports = { parseGgufHeader, summarize, GGML_TYPES, FILE_TYPES };

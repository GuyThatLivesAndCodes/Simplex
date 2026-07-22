/* ============================================================
   CLIENT TOOLS (lazy-loaded) — extracted from app.js.
   Loaded on demand by openTool() the first time a browser-only tool opens, so
   this ~950-line block stays out of the boot path. Plain (non-module) script:
   runs in the same global scope as app.js, so it both SEES core globals
   (svg/esc/toast/ctLoadScript/ctReadImageFile/pickVaultFile/…) and DEFINES the
   CLIENT_TOOLS registry + the build/ct helpers that the core dispatcher calls.
   The two shared helpers ctLoadScript + ctReadImageFile stay in app.js core
   (used by AI codeblocks and native image-convert even when this file is absent).
   ============================================================ */
/* ============================================================
   CLIENT TOOLS — converters & utilities that run entirely in the
   browser. No server, no ffmpeg. Each entry in CLIENT_TOOLS is a
   builder (root, tool) => void that fills the panel and wires it.
   Shared chrome + helpers live just above the registry.
   ============================================================ */

/* tiny DOM helper, scoped so it never clashes with anything global */
function ctEl(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }
function ctCopyBtn(getText, label = 'Copy') {
  const b = ctEl(`<button class="btn ghost sm ct-copy">${svg('copy', 13)} ${esc(label)}</button>`);
  b.onclick = async () => { await copyText(typeof getText === 'function' ? getText() : getText); const o = b.innerHTML; b.innerHTML = `${svg('check', 13)} Copied`; setTimeout(() => { b.innerHTML = o; }, 1100); };
  return b;
}
function ctDownload(filename, content, mime = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* a standard two-pane in→out converter scaffold used by several tools.
   opts: { inLabel, outLabel, placeholder, action(label, fn), onRun(input)->{out, info?, error?} } */
function ctConverter(root, opts) {
  root.innerHTML = `
    <div class="ct-intro"><div class="ct-big">${esc(opts.title)}</div><div class="ct-sub mono">${esc(opts.sub || '')}</div></div>
    <div class="ct-2col">
      <label class="ct-field"><span class="eyebrow">${esc(opts.inLabel || 'Input')}</span>
        <textarea class="ct-area" id="ctIn" spellcheck="false" placeholder="${esc(opts.placeholder || '')}"></textarea></label>
      <label class="ct-field"><span class="eyebrow ct-outhead"><span>${esc(opts.outLabel || 'Output')}</span><span id="ctOutTools"></span></span>
        <textarea class="ct-area" id="ctOut" spellcheck="false" readonly placeholder="Result appears here"></textarea></label>
    </div>
    <div class="ct-acts" id="ctActs"></div>
    <div class="ct-status mono" id="ctStatus"></div>`;
  const inEl = root.querySelector('#ctIn'), outEl = root.querySelector('#ctOut');
  const statusEl = root.querySelector('#ctStatus'), toolsEl = root.querySelector('#ctOutTools');
  toolsEl.appendChild(ctCopyBtn(() => outEl.value));
  const run = () => {
    try {
      const r = opts.onRun(inEl.value);
      outEl.value = r && r.out != null ? r.out : '';
      statusEl.className = 'ct-status mono' + (r && r.error ? ' err' : r && r.info ? ' ok' : '');
      statusEl.textContent = r ? (r.error || r.info || '') : '';
    } catch (e) {
      outEl.value = ''; statusEl.className = 'ct-status mono err'; statusEl.textContent = e.message || 'Something went wrong';
    }
  };
  (opts.actions || []).forEach(a => {
    const b = ctEl(`<button class="btn ${a.primary ? 'primary' : 'ghost'}">${a.icon ? svg(a.icon, 14) + ' ' : ''}${esc(a.label)}</button>`);
    b.onclick = () => { if (a.run) a.run({ inEl, outEl, statusEl, run }); else run(); };
    root.querySelector('#ctActs').appendChild(b);
  });
  if (opts.live) { inEl.oninput = run; }
  if (opts.sample != null) inEl.value = opts.sample;
  if (opts.runOnLoad) run();
  return { inEl, outEl, statusEl, run };
}

/* ---- CSV ↔ JSON ---- */
function ctParseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}
function ctToCSV(arr) {
  if (!Array.isArray(arr) || !arr.length) throw new Error('Expected a non-empty JSON array of objects.');
  const cols = [...new Set(arr.flatMap(o => Object.keys(o || {})))];
  const esc = v => { v = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return [cols.map(esc).join(','), ...arr.map(o => cols.map(c => esc(o ? o[c] : '')).join(','))].join('\n');
}
function buildCsvJson(root) {
  let dir = 'c2j';
  const r = ctConverter(root, {
    title: 'CSV ↔ JSON', sub: 'paste a CSV (first row = headers) or a JSON array of objects',
    inLabel: 'Input', outLabel: 'Output', placeholder: 'name,age\nAda,36\nGrace,40',
    live: true,
    onRun(input) {
      input = input.trim(); if (!input) return { out: '' };
      if (dir === 'c2j') {
        const rows = ctParseCSV(input); if (!rows.length) return { out: '' };
        const head = rows[0]; const out = rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
        return { out: JSON.stringify(out, null, 2), info: `${out.length} row${out.length === 1 ? '' : 's'} · ${head.length} column${head.length === 1 ? '' : 's'}` };
      } else {
        const data = JSON.parse(input);
        const csv = ctToCSV(Array.isArray(data) ? data : [data]);
        return { out: csv, info: `${csv.split('\n').length - 1} row${csv.split('\n').length - 1 === 1 ? '' : 's'}` };
      }
    },
    actions: [
      { label: 'CSV → JSON', primary: true, run: ({ run }) => { dir = 'c2j'; setDir(); run(); } },
      { label: 'JSON → CSV', run: ({ run }) => { dir = 'j2c'; setDir(); run(); } },
    ],
  });
  function setDir() {
    const acts = root.querySelectorAll('#ctActs .btn');
    acts[0].className = 'btn ' + (dir === 'c2j' ? 'primary' : 'ghost');
    acts[1].className = 'btn ' + (dir === 'j2c' ? 'primary' : 'ghost');
  }
  r.inEl.value = 'name,age\nAda,36\nGrace,40'; r.run();
}

/* ---- JSON Formatter ---- */
function buildJsonFormat(root) {
  ctConverter(root, {
    title: 'JSON Formatter', sub: 'pretty-print, minify & validate',
    placeholder: '{"hello":"world","nums":[1,2,3]}', live: true,
    sample: '{"hello":"world","nums":[1,2,3]}', runOnLoad: true,
    onRun(input) {
      input = input.trim(); if (!input) return { out: '' };
      const data = JSON.parse(input);
      return { out: JSON.stringify(data, null, 2), info: 'Valid JSON ✓' };
    },
    actions: [
      { label: 'Pretty', icon: 'code', primary: true, run: ({ inEl, outEl, statusEl }) => { try { outEl.value = JSON.stringify(JSON.parse(inEl.value), null, 2); statusEl.className = 'ct-status mono ok'; statusEl.textContent = 'Valid JSON ✓'; } catch (e) { statusEl.className = 'ct-status mono err'; statusEl.textContent = e.message; } } },
      { label: 'Minify', run: ({ inEl, outEl, statusEl }) => { try { const s = JSON.stringify(JSON.parse(inEl.value)); outEl.value = s; statusEl.className = 'ct-status mono ok'; statusEl.textContent = `Minified · ${s.length} chars`; } catch (e) { statusEl.className = 'ct-status mono err'; statusEl.textContent = e.message; } } },
    ],
  });
}

/* ---- YAML ↔ JSON (compact, dependency-free YAML for common configs) ----
   Handles nested maps, sequences, list-of-maps, scalars, quoted strings and
   inline flow ([...] / {...}). Not a full YAML engine — enough for configs. */
function ctYamlScalar(s) {
  s = s.trim();
  if (s === '') return '';
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true; if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  if ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  if (s[0] === '[' || s[0] === '{') { try { return JSON.parse(s.replace(/'/g, '"')); } catch (e) { return s; } }
  return s;
}
function ctYamlToJson(src) {
  // strip trailing comments (only when the '#' is preceded by whitespace and
  // sits outside quotes — a light heuristic, good enough for config files)
  const stripComment = l => {
    let q = null;
    for (let k = 0; k < l.length; k++) {
      const c = l[k];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '#' && (k === 0 || /\s/.test(l[k - 1]))) return l.slice(0, k);
    }
    return l;
  };
  const lines = src.replace(/\t/g, '  ').split('\n')
    .map(stripComment)
    .filter(l => l.trim() !== '');
  const node = lines.map(l => ({ indent: l.match(/^ */)[0].length, text: l.trim() }));
  let i = 0;
  function parse(minIndent) {
    if (i >= node.length || node[i].indent < minIndent) return null;
    const baseIndent = node[i].indent;
    const isSeq = node[i].text === '-' || node[i].text.startsWith('- ');
    if (isSeq) {
      const arr = [];
      while (i < node.length && node[i].indent === baseIndent && (node[i].text === '-' || node[i].text.startsWith('- '))) {
        const rest = node[i].text === '-' ? '' : node[i].text.slice(2).trim();
        if (rest === '') { i++; arr.push(parse(baseIndent + 1)); }
        else if (/^[^"'\[{][^:]*:(\s|$)/.test(rest)) {
          // "- key: value" → an inline map item. Re-seat this line as a map row
          // at a deeper indent so parse() reads the whole item as one object.
          const off = node[i].text.indexOf(rest);
          node[i] = { indent: baseIndent + off, text: rest };
          arr.push(parse(baseIndent + off));
        } else { i++; arr.push(ctYamlScalar(rest)); }
      }
      return arr;
    }
    const obj = {};
    while (i < node.length && node[i].indent === baseIndent && node[i].text !== '-' && !node[i].text.startsWith('- ')) {
      const t = node[i].text; const idx = t.indexOf(':');
      if (idx < 0) { i++; continue; }
      const key = ctYamlScalar(t.slice(0, idx)); const after = t.slice(idx + 1).trim();
      i++;
      if (after !== '') obj[key] = ctYamlScalar(after);
      else if (i < node.length && node[i].indent > baseIndent) obj[key] = parse(node[i].indent);
      else if (i < node.length && node[i].indent === baseIndent && (node[i].text === '-' || node[i].text.startsWith('- '))) obj[key] = parse(baseIndent);
      else obj[key] = null;
    }
    return obj;
  }
  const out = parse(0);
  return out == null ? {} : out;
}
function ctJsonToYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  const scalar = v => {
    if (v == null) return 'null';
    if (typeof v === 'string') return /[:#\-?{}\[\],&*!|>'"%@`]|^\s|\s$|^$/.test(v) ? JSON.stringify(v) : v;
    return String(v);
  };
  if (Array.isArray(obj)) {
    if (!obj.length) return pad + '[]';
    return obj.map(v => (v && typeof v === 'object')
      ? pad + '-\n' + ctJsonToYaml(v, indent + 1)
      : pad + '- ' + scalar(v)).join('\n');
  }
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj); if (!keys.length) return pad + '{}';
    return keys.map(k => {
      const v = obj[k];
      if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length))
        return pad + k + ':\n' + ctJsonToYaml(v, indent + 1);
      return pad + k + ': ' + scalar(v);
    }).join('\n');
  }
  return pad + scalar(obj);
}
function buildYamlJson(root) {
  let dir = 'y2j';
  const r = ctConverter(root, {
    title: 'YAML ↔ JSON', sub: 'handles the common config shapes — maps, lists, scalars',
    placeholder: 'name: simplex\nports:\n  - 80\n  - 443', live: true,
    onRun(input) {
      input = input.trim(); if (!input) return { out: '' };
      if (dir === 'y2j') return { out: JSON.stringify(ctYamlToJson(input), null, 2), info: 'Parsed ✓' };
      return { out: ctJsonToYaml(JSON.parse(input)), info: 'Converted ✓' };
    },
    actions: [
      { label: 'YAML → JSON', primary: true, run: ({ run }) => { dir = 'y2j'; setDir(); run(); } },
      { label: 'JSON → YAML', run: ({ run }) => { dir = 'j2y'; setDir(); run(); } },
    ],
  });
  function setDir() { const a = root.querySelectorAll('#ctActs .btn'); a[0].className = 'btn ' + (dir === 'y2j' ? 'primary' : 'ghost'); a[1].className = 'btn ' + (dir === 'j2y' ? 'primary' : 'ghost'); }
  r.inEl.value = 'name: simplex\nports:\n  - 80\n  - 443'; r.run();
}

/* ---- Base64 ---- */
function buildBase64(root) {
  let mode = 'enc';
  const r = ctConverter(root, {
    title: 'Base64', sub: 'encode or decode text — UTF-8 safe',
    placeholder: 'Type or paste text…', live: true,
    onRun(input) {
      if (!input) return { out: '' };
      if (mode === 'enc') return { out: btoa(unescape(encodeURIComponent(input))), info: 'Encoded' };
      try { return { out: decodeURIComponent(escape(atob(input.trim()))), info: 'Decoded' }; }
      catch (e) { return { out: '', error: 'Not valid Base64.' }; }
    },
    actions: [
      { label: 'Encode', primary: true, run: ({ run }) => { mode = 'enc'; setMode(); run(); } },
      { label: 'Decode', run: ({ run }) => { mode = 'dec'; setMode(); run(); } },
    ],
  });
  function setMode() { const a = root.querySelectorAll('#ctActs .btn'); a[0].className = 'btn ' + (mode === 'enc' ? 'primary' : 'ghost'); a[1].className = 'btn ' + (mode === 'dec' ? 'primary' : 'ghost'); }
}

/* ---- Hash Generator (Web Crypto for sha; small md5 impl) ---- */
function ctMd5(str) {
  // RFC 1321 MD5 over UTF-8. Compact, classic implementation.
  function toUtf8(s) { return unescape(encodeURIComponent(s)); }
  function add(x, y) { const l = (x & 0xFFFF) + (y & 0xFFFF); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xFFFF); }
  function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
  function cmn(q, a, b, x, s, t) { return add(rol(add(add(a, q), add(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  str = toUtf8(str);
  const n = str.length; const blocks = [];
  for (let i = 0; i < n; i++) blocks[i >> 2] = (blocks[i >> 2] || 0) | (str.charCodeAt(i) << ((i % 4) * 8));
  blocks[n >> 2] = (blocks[n >> 2] || 0) | (0x80 << ((n % 4) * 8));
  blocks[(((n + 8) >> 6) + 1) * 16 - 2] = n * 8;
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < blocks.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d; const x = j => blocks[i + j] || 0;
    a = ff(a, b, c, d, x(0), 7, -680876936); d = ff(d, a, b, c, x(1), 12, -389564586); c = ff(c, d, a, b, x(2), 17, 606105819); b = ff(b, c, d, a, x(3), 22, -1044525330);
    a = ff(a, b, c, d, x(4), 7, -176418897); d = ff(d, a, b, c, x(5), 12, 1200080426); c = ff(c, d, a, b, x(6), 17, -1473231341); b = ff(b, c, d, a, x(7), 22, -45705983);
    a = ff(a, b, c, d, x(8), 7, 1770035416); d = ff(d, a, b, c, x(9), 12, -1958414417); c = ff(c, d, a, b, x(10), 17, -42063); b = ff(b, c, d, a, x(11), 22, -1990404162);
    a = ff(a, b, c, d, x(12), 7, 1804603682); d = ff(d, a, b, c, x(13), 12, -40341101); c = ff(c, d, a, b, x(14), 17, -1502002290); b = ff(b, c, d, a, x(15), 22, 1236535329);
    a = gg(a, b, c, d, x(1), 5, -165796510); d = gg(d, a, b, c, x(6), 9, -1069501632); c = gg(c, d, a, b, x(11), 14, 643717713); b = gg(b, c, d, a, x(0), 20, -373897302);
    a = gg(a, b, c, d, x(5), 5, -701558691); d = gg(d, a, b, c, x(10), 9, 38016083); c = gg(c, d, a, b, x(15), 14, -660478335); b = gg(b, c, d, a, x(4), 20, -405537848);
    a = gg(a, b, c, d, x(9), 5, 568446438); d = gg(d, a, b, c, x(14), 9, -1019803690); c = gg(c, d, a, b, x(3), 14, -187363961); b = gg(b, c, d, a, x(8), 20, 1163531501);
    a = gg(a, b, c, d, x(13), 5, -1444681467); d = gg(d, a, b, c, x(2), 9, -51403784); c = gg(c, d, a, b, x(7), 14, 1735328473); b = gg(b, c, d, a, x(12), 20, -1926607734);
    a = hh(a, b, c, d, x(5), 4, -378558); d = hh(d, a, b, c, x(8), 11, -2022574463); c = hh(c, d, a, b, x(11), 16, 1839030562); b = hh(b, c, d, a, x(14), 23, -35309556);
    a = hh(a, b, c, d, x(1), 4, -1530992060); d = hh(d, a, b, c, x(4), 11, 1272893353); c = hh(c, d, a, b, x(7), 16, -155497632); b = hh(b, c, d, a, x(10), 23, -1094730640);
    a = hh(a, b, c, d, x(13), 4, 681279174); d = hh(d, a, b, c, x(0), 11, -358537222); c = hh(c, d, a, b, x(3), 16, -722521979); b = hh(b, c, d, a, x(6), 23, 76029189);
    a = hh(a, b, c, d, x(9), 4, -640364487); d = hh(d, a, b, c, x(12), 11, -421815835); c = hh(c, d, a, b, x(15), 16, 530742520); b = hh(b, c, d, a, x(2), 23, -995338651);
    a = ii(a, b, c, d, x(0), 6, -198630844); d = ii(d, a, b, c, x(7), 10, 1126891415); c = ii(c, d, a, b, x(14), 15, -1416354905); b = ii(b, c, d, a, x(5), 21, -57434055);
    a = ii(a, b, c, d, x(12), 6, 1700485571); d = ii(d, a, b, c, x(3), 10, -1894986606); c = ii(c, d, a, b, x(10), 15, -1051523); b = ii(b, c, d, a, x(1), 21, -2054922799);
    a = ii(a, b, c, d, x(8), 6, 1873313359); d = ii(d, a, b, c, x(15), 10, -30611744); c = ii(c, d, a, b, x(6), 15, -1560198380); b = ii(b, c, d, a, x(13), 21, 1309151649);
    a = ii(a, b, c, d, x(4), 6, -145523070); d = ii(d, a, b, c, x(11), 10, -1120210379); c = ii(c, d, a, b, x(2), 15, 718787259); b = ii(b, c, d, a, x(9), 21, -343485551);
    a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
  }
  const hex = n => { let s = ''; for (let i = 0; i < 4; i++) s += ('0' + ((n >> (i * 8)) & 0xFF).toString(16)).slice(-2); return s; };
  return hex(a) + hex(b) + hex(c) + hex(d);
}
async function ctSha(algo, str) {
  const buf = await crypto.subtle.digest(algo, new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function buildHash(root) {
  root.innerHTML = `
    <div class="ct-intro"><div class="ct-big">Hash Generator</div><div class="ct-sub mono">md5 · sha-1 · sha-256 · sha-512 — computed locally</div></div>
    <label class="ct-field"><span class="eyebrow">Text</span>
      <textarea class="ct-area sm" id="ctIn" spellcheck="false" placeholder="Type or paste text to hash…"></textarea></label>
    <div class="ct-hashes" id="ctHashes"></div>`;
  const inEl = root.querySelector('#ctIn'), out = root.querySelector('#ctHashes');
  const algos = [['MD5', 'md5'], ['SHA-1', 'SHA-1'], ['SHA-256', 'SHA-256'], ['SHA-512', 'SHA-512']];
  const render = rows => { out.innerHTML = ''; rows.forEach(([name, hash]) => {
    const row = ctEl(`<div class="ct-hashrow"><span class="ct-halgo mono">${name}</span><code class="ct-hval" id="h-${name}">${esc(hash)}</code></div>`);
    row.appendChild(ctCopyBtn(() => hash, '')); out.appendChild(row);
  }); };
  const run = async () => {
    const v = inEl.value;
    const results = await Promise.all(algos.map(async ([name, a]) => [name, a === 'md5' ? ctMd5(v) : await ctSha(a, v)]));
    render(results);
  };
  inEl.oninput = run; inEl.value = 'hello world'; run();
}

/* ---- URL Encode ---- */
function buildUrlEncode(root) {
  let mode = 'enc', whole = false;
  const r = ctConverter(root, {
    title: 'URL Encode', sub: 'encode or decode URL components',
    placeholder: 'hello world & friends?', live: true,
    onRun(input) {
      if (!input) return { out: '' };
      const fn = whole
        ? (mode === 'enc' ? encodeURI : decodeURI)
        : (mode === 'enc' ? encodeURIComponent : decodeURIComponent);
      try { return { out: fn(input), info: mode === 'enc' ? 'Encoded' : 'Decoded' }; }
      catch (e) { return { out: '', error: 'Malformed URI sequence.' }; }
    },
    actions: [
      { label: 'Encode', primary: true, run: ({ run }) => { mode = 'enc'; setMode(); run(); } },
      { label: 'Decode', run: ({ run }) => { mode = 'dec'; setMode(); run(); } },
    ],
  });
  function setMode() { const a = root.querySelectorAll('#ctActs .btn'); a[0].className = 'btn ' + (mode === 'enc' ? 'primary' : 'ghost'); a[1].className = 'btn ' + (mode === 'dec' ? 'primary' : 'ghost'); }
  const toggle = ctEl(`<label class="ct-check"><input type="checkbox" id="ctWhole"> <span>Whole URL (keep <code>/ : ? &amp;</code>)</span></label>`);
  toggle.querySelector('input').onchange = e => { whole = e.target.checked; r.run(); };
  root.querySelector('#ctActs').appendChild(toggle);
}

/* ---- Case Converter ---- */
function ctWords(s) { return s.replace(/[_\-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().split(/\s+/).filter(Boolean); }
function buildCaseConvert(root) {
  const cases = [
    ['UPPERCASE', s => s.toUpperCase()],
    ['lowercase', s => s.toLowerCase()],
    ['Title Case', s => s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase())],
    ['Sentence case', s => s.toLowerCase().replace(/(^\s*\w|[.!?]\s+\w)/g, c => c.toUpperCase())],
    ['camelCase', s => ctWords(s).map((w, i) => i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()).join('')],
    ['PascalCase', s => ctWords(s).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('')],
    ['snake_case', s => ctWords(s).map(w => w.toLowerCase()).join('_')],
    ['kebab-case', s => ctWords(s).map(w => w.toLowerCase()).join('-')],
    ['CONSTANT_CASE', s => ctWords(s).map(w => w.toUpperCase()).join('_')],
  ];
  root.innerHTML = `
    <div class="ct-intro"><div class="ct-big">Case Converter</div><div class="ct-sub mono">type once, copy any style</div></div>
    <label class="ct-field"><span class="eyebrow">Text</span>
      <textarea class="ct-area sm" id="ctIn" spellcheck="false" placeholder="hello world from simplex"></textarea></label>
    <div class="ct-cases" id="ctCases"></div>`;
  const inEl = root.querySelector('#ctIn'), out = root.querySelector('#ctCases');
  const run = () => { out.innerHTML = ''; cases.forEach(([name, fn]) => {
    let res = ''; try { res = fn(inEl.value); } catch (e) {}
    const row = ctEl(`<div class="ct-caserow"><span class="ct-clabel mono">${esc(name)}</span><span class="ct-cval">${esc(res)}</span></div>`);
    row.appendChild(ctCopyBtn(() => res, '')); out.appendChild(row);
  }); };
  inEl.oninput = run; inEl.value = 'hello world from simplex'; run();
}

/* ---- Word Counter ---- */
function buildWordCount(root) {
  root.innerHTML = `
    <div class="ct-intro"><div class="ct-big">Word Counter</div><div class="ct-sub mono">words, characters, reading time — live</div></div>
    <label class="ct-field"><span class="eyebrow">Text</span>
      <textarea class="ct-area lg" id="ctIn" spellcheck="false" placeholder="Start typing or paste your text…"></textarea></label>
    <div class="ct-stats" id="ctStats"></div>`;
  const inEl = root.querySelector('#ctIn'), out = root.querySelector('#ctStats');
  const run = () => {
    const v = inEl.value;
    const words = (v.match(/\S+/g) || []).length;
    const chars = v.length, noSpace = v.replace(/\s/g, '').length;
    const sentences = (v.match(/[^.!?]+[.!?]+/g) || []).length || (v.trim() ? 1 : 0);
    const paras = v.split(/\n\s*\n/).filter(p => p.trim()).length;
    const mins = words / 200; const read = mins < 1 ? `${Math.ceil(mins * 60)} sec` : `${Math.round(mins)} min`;
    const stats = [['Words', words], ['Characters', chars], ['Characters (no spaces)', noSpace], ['Sentences', sentences], ['Paragraphs', paras], ['Reading time', read]];
    out.innerHTML = stats.map(([k, val]) => `<div class="ct-stat"><span class="ct-statnum">${esc(String(val))}</span><span class="ct-statlbl mono">${esc(k)}</span></div>`).join('');
  };
  inEl.oninput = run; run();
}

/* ---- Lorem Ipsum ---- */
const LOREM_WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(' ');
function ctLoremSentence() {
  const n = 8 + Math.floor(Math.random() * 12); const w = [];
  for (let i = 0; i < n; i++) w.push(LOREM_WORDS[Math.floor(Math.random() * LOREM_WORDS.length)]);
  let s = w.join(' '); s = s[0].toUpperCase() + s.slice(1);
  // sprinkle a comma
  if (n > 6) { const c = 3 + Math.floor(Math.random() * 3); s = s.split(' ').map((x, i) => i === c ? x + ',' : x).join(' '); }
  return s + '.';
}
function buildLorem(root) {
  root.innerHTML = `
    <div class="ct-intro"><div class="ct-big">Lorem Ipsum</div><div class="ct-sub mono">classic placeholder text</div></div>
    <div class="ct-opts">
      <label class="ct-field sm"><span class="eyebrow">Amount</span><input type="number" class="ct-num" id="ctCount" value="3" min="1" max="50"></label>
      <label class="ct-field sm"><span class="eyebrow">Unit</span><select class="set-select" id="ctUnit"><option value="para">Paragraphs</option><option value="sent">Sentences</option><option value="word">Words</option></select></label>
      <label class="ct-check inline"><input type="checkbox" id="ctStart" checked> <span>Start with “Lorem ipsum…”</span></label>
      <button class="btn primary" id="ctGen">${svg('convert', 14)} Generate</button>
    </div>
    <label class="ct-field"><span class="eyebrow ct-outhead"><span>Output</span><span id="ctOutTools"></span></span>
      <textarea class="ct-area lg" id="ctOut" spellcheck="false" readonly></textarea></label>`;
  const outEl = root.querySelector('#ctOut');
  root.querySelector('#ctOutTools').appendChild(ctCopyBtn(() => outEl.value));
  const gen = () => {
    const count = Math.max(1, Math.min(50, parseInt(root.querySelector('#ctCount').value) || 1));
    const unit = root.querySelector('#ctUnit').value; const lead = root.querySelector('#ctStart').checked;
    let text = '';
    if (unit === 'word') {
      const w = []; for (let i = 0; i < count; i++) w.push(LOREM_WORDS[Math.floor(Math.random() * LOREM_WORDS.length)]);
      if (lead) { w[0] = 'Lorem'; if (count > 1) w[1] = 'ipsum'; }
      text = w.join(' '); text = text[0].toUpperCase() + text.slice(1) + '.';
    } else if (unit === 'sent') {
      const s = []; for (let i = 0; i < count; i++) s.push(ctLoremSentence());
      if (lead) s[0] = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
      text = s.join(' ');
    } else {
      const p = []; for (let i = 0; i < count; i++) { const n = 3 + Math.floor(Math.random() * 4); const s = []; for (let j = 0; j < n; j++) s.push(ctLoremSentence()); p.push(s.join(' ')); }
      if (lead) p[0] = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' + p[0];
      text = p.join('\n\n');
    }
    outEl.value = text;
  };
  root.querySelector('#ctGen').onclick = gen; gen();
}

/* ---- Diff Checker (line-based LCS) ---- */
function ctDiffLines(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: 'eq', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', text: A[i] }); i++; }
    else { out.push({ t: 'add', text: B[j] }); j++; }
  }
  while (i < n) out.push({ t: 'del', text: A[i++] });
  while (j < m) out.push({ t: 'add', text: B[j++] });
  return out;
}
function buildDiff(root) {
  root.innerHTML = `
    <div class="ct-intro"><div class="ct-big">Diff Checker</div><div class="ct-sub mono">compare two blocks of text, line by line</div></div>
    <div class="ct-2col">
      <label class="ct-field"><span class="eyebrow">Original</span><textarea class="ct-area" id="ctA" spellcheck="false" placeholder="Paste the first version…"></textarea></label>
      <label class="ct-field"><span class="eyebrow">Changed</span><textarea class="ct-area" id="ctB" spellcheck="false" placeholder="Paste the second version…"></textarea></label>
    </div>
    <div class="ct-acts"><button class="btn primary" id="ctDiffGo">${svg('code', 14)} Compare</button><span class="ct-status mono" id="ctDiffSum"></span></div>
    <div class="ct-diff" id="ctDiffOut"></div>`;
  const out = root.querySelector('#ctDiffOut'), sum = root.querySelector('#ctDiffSum');
  const run = () => {
    const rows = ctDiffLines(root.querySelector('#ctA').value, root.querySelector('#ctB').value);
    let add = 0, del = 0;
    out.innerHTML = rows.map(r => {
      if (r.t === 'add') add++; if (r.t === 'del') del++;
      const sign = r.t === 'add' ? '+' : r.t === 'del' ? '-' : ' ';
      return `<div class="ct-dline ${r.t}"><span class="ct-dsign">${sign}</span><span class="ct-dtext">${esc(r.text) || '&nbsp;'}</span></div>`;
    }).join('');
    sum.className = 'ct-status mono ok';
    sum.textContent = add || del ? `+${add} added · −${del} removed` : 'Identical — no differences';
  };
  root.querySelector('#ctDiffGo').onclick = run;
  root.querySelector('#ctA').oninput = root.querySelector('#ctB').oninput = run;
}

/* ============================================================
   UTILITY TOOLS
   ============================================================ */

/* ---- QR Generator (lazy-loads qrcode-generator, then draws to a canvas) ---- */
function buildQR(root) {
  root.innerHTML = `
    <div class="ct-intro"><div class="ct-big">QR Generator</div><div class="ct-sub mono">turn any text or URL into a QR code — made on your device</div></div>
    <label class="ct-field"><span class="eyebrow">Text or URL</span>
      <textarea class="ct-area sm" id="ctIn" spellcheck="false" placeholder="https://example.com">https://anthropic.com</textarea></label>
    <div class="ct-opts">
      <label class="ct-field sm"><span class="eyebrow">Size</span><select class="set-select" id="ctSize"><option value="256">256 px</option><option value="512" selected>512 px</option><option value="1024">1024 px</option></select></label>
      <label class="ct-field sm"><span class="eyebrow">Margin</span><select class="set-select" id="ctMargin"><option value="1">1</option><option value="2" selected>2</option><option value="4">4</option></select></label>
      <label class="ct-field sm"><span class="eyebrow">Error correction</span><select class="set-select" id="ctEcc"><option value="L">L · 7%</option><option value="M" selected>M · 15%</option><option value="Q">Q · 25%</option><option value="H">H · 30%</option></select></label>
    </div>
    <div class="ct-qrout" id="ctQrOut"><div class="dim mono">Loading…</div></div>`;
  const inEl = root.querySelector('#ctIn'), out = root.querySelector('#ctQrOut');
  let ready = false, timer = null;
  ctLoadScript('https://unpkg.com/qrcode-generator@1.4.4/qrcode.js')
    .then(() => { ready = true; render(); })
    .catch(e => { out.innerHTML = `<div class="tool-err mono">${svg('close', 14)} ${esc(e.message)}</div>`; });
  const render = () => {
    if (!ready || typeof window.qrcode !== 'function') return;
    const text = inEl.value;
    if (!text.trim()) { out.innerHTML = `<div class="dim mono">Enter some text to make a QR code.</div>`; return; }
    const size = parseInt(root.querySelector('#ctSize').value);
    const margin = parseInt(root.querySelector('#ctMargin').value);
    const ecc = root.querySelector('#ctEcc').value;
    try {
      const qr = window.qrcode(0, ecc); qr.addData(text); qr.make();
      const count = qr.getModuleCount(); const total = count + margin * 2;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d'); const cell = size / total;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#000000';
      for (let r = 0; r < count; r++) for (let c = 0; c < count; c++)
        if (qr.isDark(r, c)) ctx.fillRect(Math.round((c + margin) * cell), Math.round((r + margin) * cell), Math.ceil(cell), Math.ceil(cell));
      const url = canvas.toDataURL('image/png');
      out.innerHTML = `<img class="ct-qrimg" src="${url}" alt="QR code" width="${Math.min(300, size)}" height="${Math.min(300, size)}" />`;
      out.appendChild(ctEl(`<a class="btn primary" download="qrcode.png" href="${url}">${svg('download', 14)} Download PNG</a>`));
    } catch (e) {
      out.innerHTML = `<div class="tool-err mono">${svg('close', 14)} ${esc(e.message && /code length overflow/i.test(e.message) ? 'Too much text for one QR code — shorten it or raise the size.' : (e.message || 'Could not generate QR'))}</div>`;
    }
  };
  inEl.oninput = () => { clearTimeout(timer); timer = setTimeout(render, 180); };
  root.querySelector('#ctSize').onchange = root.querySelector('#ctMargin').onchange = root.querySelector('#ctEcc').onchange = render;
}

/* ---- Color Converter ---- */
function ctHexToRgb(hex) { hex = hex.replace('#', ''); if (hex.length === 3) hex = hex.split('').map(c => c + c).join(''); if (!/^[0-9a-f]{6}$/i.test(hex)) return null; return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) }; }
function ctRgbToHex(r, g, b) { return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join(''); }
function ctRgbToHsl(r, g, b) { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0; const l = (max + min) / 2; if (max !== min) { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min); h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; } return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }; }
function ctHslToRgb(h, s, l) { h /= 360; s /= 100; l /= 100; const hue = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }; let r, g, b; if (s === 0) r = g = b = l; else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q; r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3); } return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) }; }
function buildColor(root) {
  root.innerHTML = `
    <div class="ct-intro"><div class="ct-big">Color Converter</div><div class="ct-sub mono">hex · rgb · hsl — pick or type</div></div>
    <div class="ct-colorrow">
      <input type="color" class="ct-swatch" id="ctPick" value="#e0a64a">
      <div class="ct-colorfields">
        <label class="ct-field sm"><span class="eyebrow">HEX</span><input type="text" class="ct-num wide" id="ctHex" value="#e0a64a"></label>
        <label class="ct-field sm"><span class="eyebrow">RGB</span><input type="text" class="ct-num wide" id="ctRgb"></label>
        <label class="ct-field sm"><span class="eyebrow">HSL</span><input type="text" class="ct-num wide" id="ctHsl"></label>
      </div>
    </div>
    <div class="ct-preview" id="ctPrev"></div>`;
  const pick = root.querySelector('#ctPick'), hexEl = root.querySelector('#ctHex'), rgbEl = root.querySelector('#ctRgb'), hslEl = root.querySelector('#ctHsl'), prev = root.querySelector('#ctPrev');
  const setAll = ({ r, g, b }) => {
    const hex = ctRgbToHex(r, g, b), hsl = ctRgbToHsl(r, g, b);
    hexEl.value = hex; rgbEl.value = `rgb(${r}, ${g}, ${b})`; hslEl.value = `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`;
    pick.value = hex; prev.style.background = hex;
    prev.innerHTML = `<span class="ct-prevhex mono" style="color:${hsl.l > 55 ? '#1a1a1a' : '#fff'}">${hex.toUpperCase()}</span>`;
  };
  pick.oninput = () => setAll(ctHexToRgb(pick.value));
  hexEl.oninput = () => { const rgb = ctHexToRgb(hexEl.value.trim()); if (rgb) setAll(rgb); };
  rgbEl.oninput = () => { const m = rgbEl.value.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/); if (m) setAll({ r: +m[1], g: +m[2], b: +m[3] }); };
  hslEl.oninput = () => { const m = hslEl.value.match(/(\d+)[,\s]+(\d+)%?[,\s]+(\d+)%?/); if (m) setAll(ctHslToRgb(+m[1], +m[2], +m[3])); };
  setAll(ctHexToRgb('#e0a64a'));
}

/* ---- Unit Converter ---- */
const CT_UNITS = {
  Length: { base: 'm', units: { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 } },
  Weight: { base: 'kg', units: { mg: 1e-6, g: 0.001, kg: 1, t: 1000, oz: 0.0283495, lb: 0.453592, st: 6.35029 } },
  Volume: { base: 'L', units: { mL: 0.001, L: 1, 'm³': 1000, tsp: 0.00492892, tbsp: 0.0147868, 'fl oz': 0.0295735, cup: 0.236588, pt: 0.473176, qt: 0.946353, gal: 3.78541 } },
  Area: { base: 'm²', units: { 'mm²': 1e-6, 'cm²': 1e-4, 'm²': 1, 'km²': 1e6, 'ft²': 0.092903, 'yd²': 0.836127, acre: 4046.86, ha: 10000 } },
  Speed: { base: 'm/s', units: { 'm/s': 1, 'km/h': 0.277778, mph: 0.44704, knot: 0.514444, 'ft/s': 0.3048 } },
  Data: { base: 'B', units: { b: 0.125, B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 } },
  Temperature: { base: 'C', temp: true, units: { C: 1, F: 1, K: 1 } },
};
function ctTemp(v, from, to) { let c = from === 'C' ? v : from === 'F' ? (v - 32) * 5 / 9 : v - 273.15; return to === 'C' ? c : to === 'F' ? c * 9 / 5 + 32 : c + 273.15; }
function buildUnit(root) {
  const cats = Object.keys(CT_UNITS);
  root.innerHTML = `
    <div class="ct-intro"><div class="ct-big">Unit Converter</div><div class="ct-sub mono">length · weight · volume · temperature & more</div></div>
    <label class="ct-field sm"><span class="eyebrow">Category</span><select class="set-select" id="ctCat">${cats.map(c => `<option>${c}</option>`).join('')}</select></label>
    <div class="ct-unitrow">
      <div class="ct-unitside"><input type="number" class="ct-num wide" id="ctFrom" value="1"><select class="set-select" id="ctFromU"></select></div>
      <span class="ct-uneq">=</span>
      <div class="ct-unitside"><input type="number" class="ct-num wide" id="ctTo" readonly><select class="set-select" id="ctToU"></select></div>
    </div>`;
  const catEl = root.querySelector('#ctCat'), fromEl = root.querySelector('#ctFrom'), toEl = root.querySelector('#ctTo');
  const fromU = root.querySelector('#ctFromU'), toU = root.querySelector('#ctToU');
  const fillUnits = () => {
    const u = Object.keys(CT_UNITS[catEl.value].units);
    fromU.innerHTML = u.map(x => `<option>${x}</option>`).join('');
    toU.innerHTML = u.map(x => `<option>${x}</option>`).join('');
    toU.selectedIndex = Math.min(1, u.length - 1);
  };
  const conv = () => {
    const cat = CT_UNITS[catEl.value]; const v = parseFloat(fromEl.value); if (isNaN(v)) { toEl.value = ''; return; }
    let res; if (cat.temp) res = ctTemp(v, fromU.value, toU.value);
    else res = v * cat.units[fromU.value] / cat.units[toU.value];
    toEl.value = Math.round(res * 1e6) / 1e6;
  };
  catEl.onchange = () => { fillUnits(); conv(); };
  fromEl.oninput = fromU.onchange = toU.onchange = conv;
  fillUnits(); conv();
}

/* ---- Timestamp Converter ---- */
function buildTimestamp(root) {
  root.innerHTML = `
    <div class="ct-intro"><div class="ct-big">Timestamp Converter</div><div class="ct-sub mono">Unix epoch ↔ human dates</div></div>
    <div class="ct-now" id="ctNow"></div>
    <div class="ct-2col">
      <div class="ct-field"><span class="eyebrow">Unix timestamp</span>
        <input type="text" class="ct-num wide" id="ctTs" placeholder="1700000000">
        <div class="ct-tsout mono" id="ctTsOut"></div></div>
      <div class="ct-field"><span class="eyebrow">Date & time (local)</span>
        <input type="datetime-local" class="ct-num wide" id="ctDt" step="1">
        <div class="ct-tsout mono" id="ctDtOut"></div></div>
    </div>`;
  const nowEl = root.querySelector('#ctNow'), tsEl = root.querySelector('#ctTs'), dtEl = root.querySelector('#ctDt');
  const tsOut = root.querySelector('#ctTsOut'), dtOut = root.querySelector('#ctDtOut');
  const fmt = d => d.toString() === 'Invalid Date' ? '—' : d.toUTCString() + '  ·  ' + d.toLocaleString();
  let nowTimer = setInterval(() => { const n = Math.floor(Date.now() / 1000); nowEl.innerHTML = `<span class="eyebrow">Now</span> <code class="ct-nowval">${n}</code> <span class="dim mono">${new Date().toLocaleString()}</span>`; }, 1000);
  _appCleanup = (prev => () => { clearInterval(nowTimer); if (prev) prev(); })(_appCleanup);
  tsEl.oninput = () => { const raw = tsEl.value.trim(); if (!raw) { tsOut.textContent = ''; return; } let n = Number(raw); if (isNaN(n)) { tsOut.textContent = 'Not a number'; return; } if (raw.length <= 11) n *= 1000; tsOut.textContent = fmt(new Date(n)); };
  dtEl.oninput = () => { if (!dtEl.value) { dtOut.textContent = ''; return; } const d = new Date(dtEl.value); dtOut.textContent = `Unix: ${Math.floor(d.getTime() / 1000)}  ·  ms: ${d.getTime()}`; };
  const now = new Date(); tsEl.value = String(Math.floor(now.getTime() / 1000)); tsEl.oninput();
}

/* ---- Password Generator ---- */
function buildPassword(root) {
  root.innerHTML = `
    <div class="ct-intro"><div class="ct-big">Password Generator</div><div class="ct-sub mono">strong, random, generated on your device</div></div>
    <div class="ct-pwout"><code class="ct-pwval" id="ctPw">—</code><span id="ctPwTools"></span></div>
    <div class="ct-pwmeter"><i id="ctPwBar"></i></div>
    <div class="ct-pwlabel mono" id="ctPwLabel"></div>
    <label class="ct-field"><span class="eyebrow">Length: <b id="ctLenVal">20</b></span><input type="range" id="ctLen" min="6" max="64" value="20" class="ct-range"></label>
    <div class="ct-pwopts">
      <label class="ct-check"><input type="checkbox" id="ctUp" checked> <span>Uppercase A-Z</span></label>
      <label class="ct-check"><input type="checkbox" id="ctLow" checked> <span>Lowercase a-z</span></label>
      <label class="ct-check"><input type="checkbox" id="ctDig" checked> <span>Digits 0-9</span></label>
      <label class="ct-check"><input type="checkbox" id="ctSym" checked> <span>Symbols !@#$…</span></label>
      <label class="ct-check"><input type="checkbox" id="ctAmb"> <span>Avoid ambiguous (l 1 I O 0)</span></label>
    </div>
    <button class="btn primary" id="ctPwGen">${svg('convert', 14)} Generate new</button>`;
  const pwEl = root.querySelector('#ctPw'), lenEl = root.querySelector('#ctLen'), bar = root.querySelector('#ctPwBar'), label = root.querySelector('#ctPwLabel');
  root.querySelector('#ctPwTools').appendChild(ctCopyBtn(() => pwEl.textContent, ''));
  const gen = () => {
    let upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', lower = 'abcdefghijklmnopqrstuvwxyz', dig = '0123456789', sym = '!@#$%^&*()-_=+[]{};:,.<>?';
    if (root.querySelector('#ctAmb').checked) { upper = upper.replace(/[IO]/g, ''); lower = lower.replace(/l/g, ''); dig = dig.replace(/[10]/g, ''); }
    let pool = ''; if (root.querySelector('#ctUp').checked) pool += upper; if (root.querySelector('#ctLow').checked) pool += lower; if (root.querySelector('#ctDig').checked) pool += dig; if (root.querySelector('#ctSym').checked) pool += sym;
    if (!pool) { pwEl.textContent = 'Pick at least one set'; return; }
    const len = parseInt(lenEl.value); const arr = new Uint32Array(len); crypto.getRandomValues(arr);
    let pw = ''; for (let i = 0; i < len; i++) pw += pool[arr[i] % pool.length];
    pwEl.textContent = pw;
    const variety = (root.querySelector('#ctUp').checked ? 26 : 0) + (root.querySelector('#ctLow').checked ? 26 : 0) + (root.querySelector('#ctDig').checked ? 10 : 0) + (root.querySelector('#ctSym').checked ? 24 : 0);
    const bits = Math.round(len * Math.log2(variety || 1));
    const pct = Math.min(100, Math.round(bits / 128 * 100));
    bar.style.width = pct + '%';
    bar.style.background = bits < 50 ? 'var(--vid)' : bits < 90 ? '#e0a64a' : 'var(--img)';
    label.textContent = `~${bits} bits of entropy · ${bits < 50 ? 'weak' : bits < 90 ? 'good' : 'strong'}`;
  };
  lenEl.oninput = () => { root.querySelector('#ctLenVal').textContent = lenEl.value; gen(); };
  root.querySelectorAll('.ct-pwopts input').forEach(c => c.onchange = gen);
  root.querySelector('#ctPwGen').onclick = gen; gen();
}

/* ============================================================
   IMAGE TOOLS — canvas-based, fully client-side
   ============================================================ */
function ctImagePicker(label) {
  // Vault-first image picker. The primary action opens the vault file picker
  // (pickVaultFile) and hands back a real File built from the selected vault
  // item's decrypted bytes — so image tools read straight from the database,
  // no upload needed. Dropping a local file still works as a quick fallback.
  const el = ctEl(`<div class="ct-imgpick">
    <button class="tool-pick" type="button"><span class="tp-ico">${svg('image', 24, 1.5)}</span>
    <span class="tp-text"><span class="tp-big">${esc(label || 'Choose an image')}</span><span class="tp-sub mono">pick from your vault, or drop a file here</span></span>
    <span class="tp-act">Browse ›</span></button></div>`);
  const btn = el.querySelector('button');
  let cb = null;
  const deliver = (file) => { if (file && cb) cb(file); };
  btn.onclick = () => pickVaultFile({ kinds: ['image'], onPick: async (f) => {
    if (!f) return;
    btn.querySelector('.tp-big').textContent = 'Loading ' + f.name + '…';
    try { deliver(await vaultFileToFile(f)); }
    catch (e) { if (e.message !== 'cancelled') toast(e.message || 'Could not read that image', 'close'); btn.querySelector('.tp-big').textContent = label || 'Choose an image'; }
  } });
  btn.ondragover = e => { e.preventDefault(); btn.classList.add('drag'); };
  btn.ondragleave = () => btn.classList.remove('drag');
  btn.ondrop = e => { e.preventDefault(); btn.classList.remove('drag'); deliver(e.dataTransfer.files[0]); };
  return { el, onPick(fn) { cb = fn; }, setLabel(name) { btn.querySelector('.tp-big').textContent = name; btn.classList.add('has'); } };
}

function buildImageConvert(root) { imageSingleTool(root, { mode: 'convert' }); }
function buildImageCompress(root) { imageSingleTool(root, { mode: 'compress' }); }
function buildImageResize(root) { imageSingleTool(root, { mode: 'resize' }); }

/* one panel covers convert / compress / resize — they share the canvas pipeline */
function imageSingleTool(root, { mode }) {
  const titles = { convert: ['Image Converter', 'png · jpg · webp — converted in your browser'], compress: ['Image Compressor', 'shrink JPG/WebP with a quality slider'], resize: ['Image Resizer', 'resize to exact pixels or by percent'] };
  root.innerHTML = `
    <div class="ct-intro"><div class="ct-big">${titles[mode][0]}</div><div class="ct-sub mono">${titles[mode][1]}</div></div>
    <div id="ctPickWrap"></div>
    <div class="ct-imgopts hidden" id="ctOpts">
      ${mode !== 'compress' ? `<label class="ct-field sm"><span class="eyebrow">Format</span><select class="set-select" id="ctFmt"><option value="image/png">PNG</option><option value="image/jpeg">JPG</option><option value="image/webp">WebP</option></select></label>` : `<input type="hidden" id="ctFmt" value="image/jpeg">`}
      ${mode === 'resize' ? `
      <label class="ct-field sm"><span class="eyebrow">Width</span><input type="number" class="ct-num" id="ctW" min="1"></label>
      <label class="ct-field sm"><span class="eyebrow">Height</span><input type="number" class="ct-num" id="ctH" min="1"></label>
      <label class="ct-check inline"><input type="checkbox" id="ctLock" checked> <span>Lock ratio</span></label>` : ''}
      ${mode !== 'resize' && mode !== 'convert' ? '' : ''}
      <label class="ct-field sm ct-qwrap" id="ctQwrap"><span class="eyebrow">Quality: <b id="ctQval">85</b>%</span><input type="range" id="ctQ" min="10" max="100" value="85" class="ct-range"></label>
      <button class="btn primary" id="ctRun">${svg(mode === 'compress' ? 'compress' : 'convert', 14)} ${mode === 'compress' ? 'Compress' : mode === 'resize' ? 'Resize' : 'Convert'}</button>
    </div>
    <div class="ct-imgresult" id="ctImgRes"></div>`;
  const picker = ctImagePicker('Choose an image');
  root.querySelector('#ctPickWrap').appendChild(picker.el);
  const opts = root.querySelector('#ctOpts'), res = root.querySelector('#ctImgRes');
  let img = null, srcFile = null;
  const qwrap = root.querySelector('#ctQwrap');
  const updateQ = () => { const fmt = root.querySelector('#ctFmt').value; qwrap.style.display = fmt === 'image/png' ? 'none' : ''; };
  picker.onPick(async file => {
    try { img = await ctReadImageFile(file); srcFile = file; }
    catch (e) { res.innerHTML = `<div class="tool-err mono">${svg('close', 14)} ${esc(e.message)}</div>`; return; }
    picker.setLabel(`${file.name} · ${img.width}×${img.height} · ${fmtSize(file.size)}`);
    opts.classList.remove('hidden');
    if (mode === 'resize') { root.querySelector('#ctW').value = img.width; root.querySelector('#ctH').value = img.height; }
    updateQ();
  });
  if (root.querySelector('#ctFmt').tagName === 'SELECT') root.querySelector('#ctFmt').onchange = updateQ;
  const qEl = root.querySelector('#ctQ'); if (qEl) qEl.oninput = () => root.querySelector('#ctQval').textContent = qEl.value;
  if (mode === 'resize') {
    const wEl = root.querySelector('#ctW'), hEl = root.querySelector('#ctH'), lock = root.querySelector('#ctLock');
    wEl.oninput = () => { if (lock.checked && img) hEl.value = Math.round(wEl.value * img.height / img.width); };
    hEl.oninput = () => { if (lock.checked && img) wEl.value = Math.round(hEl.value * img.width / img.height); };
  }
  root.querySelector('#ctRun').onclick = () => {
    if (!img) return;
    let w = img.width, h = img.height;
    if (mode === 'resize') { w = Math.max(1, parseInt(root.querySelector('#ctW').value) || img.width); h = Math.max(1, parseInt(root.querySelector('#ctH').value) || img.height); }
    const fmt = root.querySelector('#ctFmt').value;
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (fmt === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const q = qEl ? parseInt(qEl.value) / 100 : 0.85;
    canvas.toBlob(blob => {
      if (!blob) { res.innerHTML = `<div class="tool-err mono">${svg('close', 14)} This browser couldn't encode that format.</div>`; return; }
      const url = URL.createObjectURL(blob);
      const ext = fmt === 'image/jpeg' ? 'jpg' : fmt === 'image/webp' ? 'webp' : 'png';
      const base = (srcFile.name.replace(/\.[^.]+$/, '') || 'image');
      const outName = `${base}-${mode === 'resize' ? w + 'x' + h : mode}.${ext}`;
      const ratio = srcFile.size ? Math.round((1 - blob.size / srcFile.size) * 100) : 0;
      res.innerHTML = `<div class="tool-done">
        <div class="td-row"><span class="td-ok">${svg('check', 16)} Done</span><span class="mono dim">${img.width}×${img.height} → ${w}×${h} · ${fmtSize(srcFile.size)} → ${fmtSize(blob.size)}${ratio > 0 ? ' · ' + ratio + '% smaller' : ''}</span></div>
        <img class="tool-prev ct-imgprev" src="${url}" />
        <a class="btn primary" href="${url}" download="${esc(outName)}">${svg('download', 15)} Download ${esc(outName)}</a>
      </div>`;
    }, fmt, q);
  };
}

/* ---- Images → PDF (lazy-loads jsPDF) ---- */
function buildImageToPdf(root) {
  root.innerHTML = `
    <div class="ct-intro"><div class="ct-big">Images → PDF</div><div class="ct-sub mono">combine images into a single PDF, one per page</div></div>
    <div id="ctPickWrap"></div>
    <div class="ct-pdflist" id="ctList"></div>
    <div class="ct-imgopts hidden" id="ctOpts">
      <label class="ct-field sm"><span class="eyebrow">Page size</span><select class="set-select" id="ctPage"><option value="a4">A4</option><option value="letter">Letter</option><option value="fit">Fit to image</option></select></label>
      <label class="ct-field sm"><span class="eyebrow">Orientation</span><select class="set-select" id="ctOrient"><option value="auto">Auto</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
      <button class="btn primary" id="ctRun">${svg('document', 14)} Build PDF</button>
    </div>
    <div class="ct-imgresult" id="ctImgRes"></div>`;
  const picker = ctImagePicker('Add images');
  root.querySelector('#ctPickWrap').appendChild(picker.el);
  const list = root.querySelector('#ctList'), opts = root.querySelector('#ctOpts'), res = root.querySelector('#ctImgRes');
  const items = [];
  const renderList = () => {
    list.innerHTML = items.map((it, i) => `<div class="ct-pdfitem"><span class="mono">${i + 1}.</span> <span class="ct-pdfname">${esc(it.file.name)}</span> <span class="dim mono">${it.img.width}×${it.img.height}</span><button class="ct-pdfrm" data-i="${i}" title="Remove">${svg('close', 13)}</button></div>`).join('');
    list.querySelectorAll('.ct-pdfrm').forEach(b => b.onclick = () => { items.splice(+b.dataset.i, 1); renderList(); });
    opts.classList.toggle('hidden', !items.length);
  };
  picker.onPick(async file => { try { const img = await ctReadImageFile(file); items.push({ file, img }); renderList(); } catch (e) { res.innerHTML = `<div class="tool-err mono">${esc(e.message)}</div>`; } });
  root.querySelector('#ctRun').onclick = async () => {
    if (!items.length) return;
    res.innerHTML = `<div class="ct-working mono"><span class="spin"></span> Building PDF…</div>`;
    try {
      await ctLoadScript('https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js');
      const { jsPDF } = window.jspdf;
      const pageSel = root.querySelector('#ctPage').value, orientSel = root.querySelector('#ctOrient').value;
      let pdf = null;
      items.forEach((it, idx) => {
        const iw = it.img.width, ih = it.img.height;
        const orient = orientSel === 'auto' ? (iw >= ih ? 'landscape' : 'portrait') : orientSel;
        let fmt = pageSel === 'letter' ? 'letter' : pageSel === 'fit' ? [iw, ih] : 'a4';
        if (!pdf) pdf = new jsPDF({ orientation: pageSel === 'fit' ? (iw >= ih ? 'landscape' : 'portrait') : orient, unit: 'px', format: fmt });
        else pdf.addPage(fmt, pageSel === 'fit' ? (iw >= ih ? 'landscape' : 'portrait') : orient);
        const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
        let dw = iw, dh = ih;
        if (pageSel !== 'fit') { const scale = Math.min(pw / iw, ph / ih, 1) * 0.95; dw = iw * scale; dh = ih * scale; }
        const c = document.createElement('canvas'); c.width = iw; c.height = ih; c.getContext('2d').drawImage(it.img, 0, 0);
        const data = c.toDataURL('image/jpeg', 0.92);
        pdf.addImage(data, 'JPEG', (pw - dw) / 2, (ph - dh) / 2, dw, dh);
      });
      const blob = pdf.output('blob'); const url = URL.createObjectURL(blob);
      res.innerHTML = `<div class="tool-done">
        <div class="td-row"><span class="td-ok">${svg('check', 16)} Done</span><span class="mono dim">${items.length} page${items.length === 1 ? '' : 's'} · ${fmtSize(blob.size)}</span></div>
        <a class="btn primary" href="${url}" download="images.pdf">${svg('download', 15)} Download images.pdf</a></div>`;
    } catch (e) { res.innerHTML = `<div class="tool-err mono">${svg('close', 14)} ${esc(e.message || 'Could not build PDF')}</div>`; }
  };
}

/* ---- Watermark ---- */
function buildWatermark(root) {
  root.innerHTML = `
    <div class="ct-intro"><div class="ct-big">Watermark</div><div class="ct-sub mono">stamp text onto an image</div></div>
    <div id="ctPickWrap"></div>
    <div class="ct-imgopts hidden" id="ctOpts">
      <label class="ct-field"><span class="eyebrow">Text</span><input type="text" class="ct-num wide" id="ctText" value="© Simplex"></label>
      <label class="ct-field sm"><span class="eyebrow">Position</span><select class="set-select" id="ctPos"><option value="br">Bottom-right</option><option value="bl">Bottom-left</option><option value="tr">Top-right</option><option value="tl">Top-left</option><option value="center">Center</option><option value="tile">Tile</option></select></label>
      <label class="ct-field sm"><span class="eyebrow">Size: <b id="ctSzVal">5</b>%</span><input type="range" id="ctSz" min="2" max="20" value="5" class="ct-range"></label>
      <label class="ct-field sm"><span class="eyebrow">Opacity: <b id="ctOpVal">50</b>%</span><input type="range" id="ctOp" min="5" max="100" value="50" class="ct-range"></label>
      <label class="ct-field sm"><span class="eyebrow">Color</span><input type="color" class="ct-swatch sm" id="ctWmColor" value="#ffffff"></label>
    </div>
    <div class="ct-imgresult" id="ctImgRes"></div>`;
  const picker = ctImagePicker('Choose an image');
  root.querySelector('#ctPickWrap').appendChild(picker.el);
  const opts = root.querySelector('#ctOpts'), res = root.querySelector('#ctImgRes');
  let img = null, srcFile = null;
  const draw = () => {
    if (!img) return;
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const text = root.querySelector('#ctText').value || '';
    const sz = parseInt(root.querySelector('#ctSz').value) / 100 * img.height;
    const op = parseInt(root.querySelector('#ctOp').value) / 100;
    const pos = root.querySelector('#ctPos').value; const color = root.querySelector('#ctWmColor').value;
    ctx.font = `600 ${sz}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = color; ctx.globalAlpha = op;
    ctx.textBaseline = 'middle';
    const m = ctx.measureText(text), tw = m.width, pad = sz * 0.6;
    if (pos === 'tile') {
      ctx.save(); ctx.translate(img.width / 2, img.height / 2); ctx.rotate(-Math.PI / 6); ctx.translate(-img.width / 2, -img.height / 2);
      for (let y = -img.height; y < img.height * 2; y += sz * 3) for (let x = -img.width; x < img.width * 2; x += tw + sz * 3) ctx.fillText(text, x, y);
      ctx.restore();
    } else {
      ctx.textAlign = pos.includes('r') ? 'right' : pos === 'center' ? 'center' : 'left';
      const x = pos.includes('r') ? img.width - pad : pos === 'center' ? img.width / 2 : pad;
      const y = pos.includes('t') ? sz / 2 + pad : pos === 'center' ? img.height / 2 : img.height - sz / 2 - pad;
      ctx.fillText(text, x, y);
    }
    ctx.globalAlpha = 1;
    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const base = srcFile.name.replace(/\.[^.]+$/, '') || 'image';
      res.innerHTML = `<div class="tool-done">
        <div class="td-row"><span class="td-ok">${svg('check', 16)} Watermarked</span><span class="mono dim">${fmtSize(blob.size)}</span></div>
        <img class="tool-prev ct-imgprev" src="${url}" />
        <a class="btn primary" href="${url}" download="${esc(base)}-watermarked.png">${svg('download', 15)} Download PNG</a></div>`;
    }, 'image/png');
  };
  picker.onPick(async file => {
    try { img = await ctReadImageFile(file); srcFile = file; } catch (e) { res.innerHTML = `<div class="tool-err mono">${esc(e.message)}</div>`; return; }
    picker.setLabel(`${file.name} · ${img.width}×${img.height}`);
    opts.classList.remove('hidden'); draw();
  });
  ['#ctText', '#ctPos', '#ctWmColor'].forEach(s => { const el = root.querySelector(s); el.oninput = el.onchange = draw; });
  root.querySelector('#ctSz').oninput = () => { root.querySelector('#ctSzVal').textContent = root.querySelector('#ctSz').value; draw(); };
  root.querySelector('#ctOp').oninput = () => { root.querySelector('#ctOpVal').textContent = root.querySelector('#ctOp').value; draw(); };
}

/* ---- Markdown → PDF (lazy-loads jsPDF; renders a tidy text-based PDF) ---- */
function ctParseMd(src) {
  // returns a flat list of {type, text, level?} blocks for the PDF renderer
  const blocks = []; const lines = src.replace(/\r/g, '').split('\n');
  let inCode = false, code = [];
  for (let raw of lines) {
    if (/^```/.test(raw)) { if (inCode) { blocks.push({ type: 'code', text: code.join('\n') }); code = []; inCode = false; } else inCode = true; continue; }
    if (inCode) { code.push(raw); continue; }
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { blocks.push({ type: 'gap' }); continue; }
    let m;
    if (m = line.match(/^(#{1,6})\s+(.*)$/)) blocks.push({ type: 'h', level: m[1].length, text: m[2] });
    else if (m = line.match(/^\s*([-*+])\s+(.*)$/)) blocks.push({ type: 'li', text: m[2] });
    else if (m = line.match(/^\s*(\d+)\.\s+(.*)$/)) blocks.push({ type: 'oli', text: m[2], num: m[1] });
    else if (/^\s*>/.test(line)) blocks.push({ type: 'quote', text: line.replace(/^\s*>\s?/, '') });
    else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) blocks.push({ type: 'hr' });
    else blocks.push({ type: 'p', text: line });
  }
  if (inCode && code.length) blocks.push({ type: 'code', text: code.join('\n') });
  return blocks;
}
function ctStripInline(s) { return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1').replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)'); }
function buildMdToPdf(root) {
  root.innerHTML = `
    <div class="ct-intro"><div class="ct-big">Markdown → PDF</div><div class="ct-sub mono">headings, lists, quotes & code — rendered to a clean PDF</div></div>
    <label class="ct-field"><span class="eyebrow">Markdown</span>
      <textarea class="ct-area lg" id="ctIn" spellcheck="false" placeholder="# Title\n\nYour **markdown** here…"></textarea></label>
    <div class="ct-acts"><button class="btn primary" id="ctRun">${svg('document', 14)} Download PDF</button><span class="ct-status mono" id="ctStatus"></span></div>`;
  const inEl = root.querySelector('#ctIn'), status = root.querySelector('#ctStatus');
  inEl.value = '# My Document\n\nThis is a **Markdown** document rendered to PDF, entirely in your browser.\n\n## Features\n\n- Headings\n- *Bulleted* and numbered lists\n- > Block quotes\n- `inline code` and fenced blocks\n\n1. First\n2. Second\n\n> Quietly does the work.\n\n```\ncode stays monospaced\n```';
  root.querySelector('#ctRun').onclick = async () => {
    status.className = 'ct-status mono'; status.innerHTML = `<span class="spin"></span> Rendering…`;
    try {
      await ctLoadScript('https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js');
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
      const margin = 56, pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
      const maxW = pw - margin * 2; let y = margin;
      const newPageIf = need => { if (y + need > ph - margin) { pdf.addPage(); y = margin; } };
      const blocks = ctParseMd(inEl.value);
      blocks.forEach(b => {
        if (b.type === 'gap') { y += 6; return; }
        if (b.type === 'hr') { newPageIf(14); pdf.setDrawColor(200); pdf.line(margin, y + 4, pw - margin, y + 4); y += 14; return; }
        if (b.type === 'code') {
          pdf.setFont('courier', 'normal'); pdf.setFontSize(10); pdf.setTextColor(40);
          const ls = pdf.splitTextToSize(b.text, maxW - 16);
          newPageIf(ls.length * 13 + 12);
          pdf.setFillColor(244, 244, 242); pdf.rect(margin, y, maxW, ls.length * 13 + 10, 'F');
          pdf.text(ls, margin + 8, y + 14); y += ls.length * 13 + 18; return;
        }
        let size = 11, style = 'normal', font = 'helvetica', indent = 0, prefix = '';
        if (b.type === 'h') { size = [22, 18, 15, 13, 12, 11][b.level - 1] || 11; style = 'bold'; }
        else if (b.type === 'li') { prefix = '•  '; indent = 14; }
        else if (b.type === 'oli') { prefix = b.num + '.  '; indent = 14; }
        else if (b.type === 'quote') { indent = 14; pdf.setTextColor(110); }
        pdf.setFont(font, style); pdf.setFontSize(size);
        if (b.type !== 'quote') pdf.setTextColor(b.type === 'h' ? 20 : 45);
        const text = prefix + ctStripInline(b.text);
        const ls = pdf.splitTextToSize(text, maxW - indent);
        const lh = size * 1.35;
        newPageIf(ls.length * lh + 4);
        if (b.type === 'quote') { pdf.setFillColor(225); pdf.rect(margin, y - lh + 4, 3, ls.length * lh, 'F'); }
        pdf.text(ls, margin + indent, y); y += ls.length * lh + (b.type === 'h' ? 6 : 3);
        pdf.setTextColor(45);
      });
      const blob = pdf.output('blob'); ctDownload('document.pdf', blob);
      status.className = 'ct-status mono ok'; status.textContent = `Done · ${pdf.getNumberOfPages()} page(s)`;
    } catch (e) { status.className = 'ct-status mono err'; status.textContent = e.message || 'Could not render PDF'; }
  };
}

const CLIENT_TOOLS = {
  'csv-json': buildCsvJson, 'json-format': buildJsonFormat, 'yaml-json': buildYamlJson,
  'base64': buildBase64, 'hash': buildHash, 'url-encode': buildUrlEncode,
  'case-convert': buildCaseConvert, 'word-count': buildWordCount, 'lorem': buildLorem, 'diff': buildDiff,
  'qr': buildQR, 'color': buildColor, 'unit': buildUnit, 'timestamp': buildTimestamp, 'password': buildPassword,
  'image-convert': buildImageConvert, 'image-compress': buildImageCompress, 'image-resize': buildImageResize,
  'image-to-pdf': buildImageToPdf, 'watermark': buildWatermark, 'md-to-pdf': buildMdToPdf,
};

/* chunkview.js — "Open anyway" for files the browser can't show, and the reader
   for very large text files. It never pulls a whole file: each slice is fetched
   with an HTTP Range request, and the next slice only loads when the user asks.
   Bytes that look like text are shown as text; anything else as a hex dump.

   Content-backed docs (text kept in the database, no raw URL) are read the same
   way through /api/files/:id/content?offset=&length=, in characters. A server that
   predates slicing returns the whole text; then it's kept here and still shown
   one slice at a time. */
import { html, el, icon, fmtSize, esc, api } from './lib.js';

const TEXT_CHUNK = 256 * 1024;   // text: 256 KB (or 256K characters) per slice
const HEX_CHUNK = 64 * 1024;     // hex: 64 KB per slice (4,096 lines)

export function chunkView(f, { mode } = {}) {
  const inDb = !f.url;
  const root = el(html`<div class="doc chunk"><div class="db">
      <span>${icon('eye', 14)} Reading in parts${inDb ? ' · read-only' : ''}</span><span class="dim mono" data-pos></span>
      ${inDb ? '' : html`<span style="margin-left:auto" class="seg" data-mode><button data-v="text">Text</button><button data-v="hex">Hex</button></span>`}
    </div><div class="cv-out" tabindex="0"></div>
    <div class="cv-more"></div></div>`.s);
  const out = root.querySelector('.cv-out'), more = root.querySelector('.cv-more'), pos = root.querySelector('[data-pos]');
  let offset = 0, total = inDb ? 0 : f.size || 0, view = inDb ? 'text' : mode || null, busy = false, ctl = null, whole = null;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const amount = n => (inDb ? `${n.toLocaleString()} characters` : fmtSize(n));

  async function loadDb() {
    let piece;
    if (whole != null) piece = whole.slice(offset, offset + TEXT_CHUNK);
    else {
      const r = await api(`/api/files/${encodeURIComponent(f.id)}/content?offset=${offset}&length=${TEXT_CHUNK}`, { signal: ctl.signal, timeout: 120000 });
      if (r.total == null) { whole = r.content || ''; total = whole.length; piece = whole.slice(offset, offset + TEXT_CHUNK); }
      else { total = r.total; piece = r.content || ''; }
    }
    // end the part on a line break so no line is split between two parts (the rest comes next time)
    const nl = piece.lastIndexOf('\n');
    if (offset + piece.length < total && nl > piece.length / 2) piece = piece.slice(0, nl + 1);
    out.appendChild(el(`<pre class="cv-text">${esc(piece)}</pre>`));
    offset += piece.length;
  }

  async function load() {
    if (busy) return; busy = true;
    // until we know it's text, read the small (hex-sized) slice — a 256 KB first read of
    // a binary file would draw 16,000 hex lines at once
    const size = view === 'text' ? TEXT_CHUNK : HEX_CHUNK;
    more.innerHTML = '<span class="spin"></span>';
    ctl = new AbortController();
    if (inDb) {
      try { await loadDb(); } catch (e) { if (e.name !== 'AbortError') more.innerHTML = html`<span class="dim">${e.message}</span>`.s; busy = false; return; }
      busy = false; return finish();
    }
    try {
      const res = await fetch(f.url, { credentials: 'same-origin', headers: { Range: `bytes=${offset}-${offset + size - 1}` }, signal: ctl.signal });
      if (!res.ok && res.status !== 206) throw new Error(`Couldn’t read the file (${res.status})`);
      const cr = res.headers.get('Content-Range'); const m = cr && /\/(\d+)$/.exec(cr); if (m) total = Number(m[1]);
      // a server that ignored Range would send everything: read only what we asked for
      const reader = res.body.getReader(); const parts = []; let got = 0;
      while (got < size) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; }
      if (got > size || res.status === 200) try { ctl.abort(); } catch (e) {}
      const bytes = new Uint8Array(Math.min(got, size)); let o = 0;
      for (const p of parts) { const take = Math.min(p.length, bytes.length - o); bytes.set(p.subarray(0, take), o); o += take; if (o >= bytes.length) break; }
      if (!view) view = looksText(bytes) ? 'text' : 'hex';
      paintMode();
      if (view === 'text') out.appendChild(el(`<pre class="cv-text">${esc(decoder.decode(bytes, { stream: true }))}</pre>`));
      else out.appendChild(el(`<pre class="cv-hex">${hexDump(bytes, offset)}</pre>`));
      offset += bytes.length;
    } catch (e) {
      if (e.name !== 'AbortError') more.innerHTML = html`<span class="dim">${e.message}</span>`.s;
      busy = false; return;
    }
    busy = false;
    finish();
  }
  function finish() {
    pos.textContent = `${amount(offset)} of ${amount(total)}`;
    const left = total - offset;
    more.innerHTML = left > 0
      ? html`<span class="dim">${amount(left)} not loaded yet</span><button class="b sm" data-next>${icon('arrowdown', 14)} Load the next ${amount(Math.min(left, view === 'hex' ? HEX_CHUNK : TEXT_CHUNK))}</button>`.s
      : html`<span class="dim">${icon('check', 13)} End of file</span>`.s;
  }
  function paintMode() { root.querySelectorAll('[data-mode] button').forEach(b => b.classList.toggle('on', b.dataset.v === view)); }
  more.addEventListener('click', e => { if (e.target.closest('[data-next]')) load(); });
  const modes = root.querySelector('[data-mode]');
  if (modes) modes.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.dataset.v === view || busy) return;
    view = b.dataset.v; offset = 0; out.innerHTML = ''; load();   // switching view starts over from the top
  });
  load();
  root.destroy = () => { try { ctl && ctl.abort(); } catch (e) {} };
  return root;
}

/* treat as text when nearly every byte is printable / whitespace / UTF-8 */
function looksText(b) {
  const n = Math.min(b.length, 8192); if (!n) return true;
  let bad = 0;
  for (let i = 0; i < n; i++) { const c = b[i]; if (c === 0) return false; if (c < 9 || (c > 13 && c < 32)) bad++; }
  return bad / n < 0.02;
}
function hexDump(b, base) {
  const lines = [];
  for (let i = 0; i < b.length; i += 16) {
    const row = b.subarray(i, i + 16);
    const hex = [...row].map(x => x.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const asc = [...row].map(x => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
    lines.push(`<span class="o">${(base + i).toString(16).padStart(8, '0')}</span>  ${hex}  <span class="a">${esc(asc)}</span>`);
  }
  return lines.join('\n');
}

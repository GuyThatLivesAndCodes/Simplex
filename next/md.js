/* md.js — a small, safe Markdown renderer for AI replies. Every piece of text is
   HTML-escaped before any markup is added, links are limited to http(s)/mailto,
   and code blocks get a language label + Copy button (wired by the caller via
   [data-copycode]). Covers: fenced code, headings, bold/italic/strike, inline
   code, links, lists (nested), blockquotes, GFM tables, rules, paragraphs. */
import { esc } from './lib.js';

export function md(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    const fence = /^\s*(```+|~~~+)\s*([\w#+.-]*)\s*$/.exec(line);
    if (fence) {
      const close = fence[1], lang = fence[2] || '';
      const body = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++;
      out.push(`<div class="md-code"><div class="md-code-h"><span>${esc(lang || 'code')}</span><button class="md-copy" data-copycode>Copy</button></div><pre><code>${esc(body.join('\n'))}</code></pre></div>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { const n = Math.min(6, h[1].length + 1); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    // rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    // table: header row + separator row
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(line), aligns = cells(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : '');
      i += 2; const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(cells(lines[i++]));
      const td = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c)}</${tag}>`;
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, k) => td('td', c, k)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    // blockquote
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${md(q.join('\n'))}</blockquote>`);
      continue;
    }
    // lists
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) { const r = list(lines, i); out.push(r.html); i = r.next; continue; }
    // paragraph: until a blank line or another block starts
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) { para.push(lines[i++]); }
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

function list(lines, start) {
  const indentOf = l => /^(\s*)/.exec(l)[1].replace(/\t/g, '  ').length;
  const base = indentOf(lines[start]);
  const ordered = /^\s*\d+[.)]/.test(lines[start]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { if (i + 1 < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1]) && indentOf(lines[i + 1]) >= base) { i++; continue; } break; }
    const ind = indentOf(l);
    const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (m && ind === base) { items.push({ text: m[2], sub: '' }); i++; continue; }
    if (m && ind > base && items.length) { const r = list(lines, i); items[items.length - 1].sub += r.html; i = r.next; continue; }
    if (!m && ind > base && items.length) { items[items.length - 1].text += '\n' + l.trim(); i++; continue; }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const startN = ordered ? parseInt(/^\s*(\d+)/.exec(lines[start])[1], 10) : 1;
  return { html: `<${tag}${ordered && startN !== 1 ? ` start="${startN}"` : ''}>${items.map(it => {
    const task = /^\[([ xX])\]\s+(.*)$/s.exec(it.text);
    const body = task ? `<span class="md-task${task[1] !== ' ' ? ' done' : ''}">${task[1] !== ' ' ? '✓' : ''}</span>${inline(task[2])}` : inline(it.text).replace(/\n/g, '<br>');
    return `<li>${body}${it.sub}</li>`;
  }).join('')}</${tag}>`, next: i };
}

/* inline: escape first, then add markup on the escaped text */
function inline(s) {
  const codes = [];
  let t = esc(s).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = t
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_, txt, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`)
    .replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[n]}</code>`);
}

/* wire Copy buttons on code blocks inside `root` */
export function wireCodeCopy(root, onCopied) {
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-copycode]'); if (!b) return;
    const code = b.closest('.md-code').querySelector('code').textContent;
    copyText(code).then(() => { b.textContent = 'Copied'; b.classList.add('ok'); setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('ok'); }, 1400); onCopied && onCopied(); });
  });
}
export function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text) {
  const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove();
}

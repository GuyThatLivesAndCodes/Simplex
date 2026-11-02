/* captions.js — subtitles for the player. Three places they come from:
     - files the user attached to the video (kept server-side, /api/files/:id/sublinks)
     - files beside the video that share its name (movie.mkv + movie.en.srt)
     - tracks built into the video file (the server extracts them as WebVTT)
   SRT, WebVTT and ASS/SSA are parsed here into plain timed cues; the player draws
   them itself, so they can be styled, sized and shifted in time. Cue text is
   escaped, with only <i>, <b> and <u> let back in. */
import { api, ext, esc } from './lib.js';
import * as store from './store.js';

export const SUB_EXT = new Set(['srt', 'vtt', 'ass', 'ssa']);
export const isSubFile = f => f && f.type !== 'folder' && SUB_EXT.has(ext(f.name));
const stem = n => String(n || '').replace(/\.[^.]+$/, '');

/* ---------- language names ---------- */
// ISO 639-2/B codes (what MKV files and release names use) -> the /T form Intl knows
const B2T = { ger: 'deu', fre: 'fra', chi: 'zho', dut: 'nld', cze: 'ces', gre: 'ell', per: 'fas', rum: 'ron', slo: 'slk', alb: 'sqi', arm: 'hye', baq: 'eus', bur: 'mya', geo: 'kat', ice: 'isl', mac: 'mkd', mao: 'mri', may: 'msa', tib: 'bod', wel: 'cym' };
const WORDS = { english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', russian: 'ru', japanese: 'ja', korean: 'ko', chinese: 'zh', arabic: 'ar', dutch: 'nl', swedish: 'sv', polish: 'pl', turkish: 'tr', hindi: 'hi' };
let names = null;
export function langName(code) {
  const c = String(code || '').toLowerCase();
  if (!c || c === 'und' || c === 'unk') return '';
  try { names = names || new Intl.DisplayNames(['en'], { type: 'language' }); const n = names.of(B2T[c] || c); if (n && n.toLowerCase() !== c) return n; } catch (e) {}
  return c.toUpperCase();
}
// 'en', 'eng' and 'english' are the same language: compare by name
export const sameLang = (a, b) => !!a && !!b && (langName(WORDS[a] || a) || a).toLowerCase() === (langName(WORDS[b] || b) || b).toLowerCase();

/* "Movie.2020.en.forced.srt" -> { lang: 'en', forced: true, sdh: false } */
function tagsFromName(name, videoStem) {
  const rest = stem(name).slice(videoStem && stem(name).toLowerCase().startsWith(videoStem.toLowerCase()) ? videoStem.length : 0);
  const parts = rest.toLowerCase().split(/[.\s_\-[\]()]+/).filter(Boolean);
  let lang = '';
  for (const p of parts.reverse()) {
    if (WORDS[p]) { lang = WORDS[p]; break; }
    if (/^[a-z]{2,3}$/.test(p) && langName(p) && langName(p) !== p.toUpperCase()) { lang = p; break; }
  }
  return { lang, forced: parts.includes('forced'), sdh: parts.includes('sdh') || parts.includes('cc') || parts.includes('hi') };
}

/* ---------- sources ---------- */
/* subtitle FILES for this video: attached ones first, then name matches. If the
   folder holds a single video, every subtitle file in it counts as a match. */
export async function fileSources(f) {
  let linked = [];
  try { linked = (await api(`/api/files/${f.id}/sublinks`, { timeout: 8000 })).subs || []; } catch (e) {}
  const parent = f.parent ?? null, vStem = stem(f.name).toLowerCase();
  const here = store.live().filter(x => (x.parent ?? null) === parent);
  const oneVideo = here.filter(x => x.type === 'video').length === 1;
  const matched = here.filter(x => isSubFile(x) && !linked.includes(x.id) && (oneVideo || (() => {
    const s = stem(x.name).toLowerCase();
    return s === vStem || (s.startsWith(vStem) && /^[.\s_\-[(]/.test(s.slice(vStem.length)));
  })())).map(x => x.id);
  return [...linked.map(id => [id, true]), ...matched.map(id => [id, false])].map(([id, isLinked]) => {
    const x = store.byId(id); if (!x) return null;
    const t = tagsFromName(x.name, stem(f.name));
    const ln = langName(t.lang);
    return { key: 'f:' + id, kind: 'file', id, linked: isLinked, lang: t.lang, forced: t.forced,
      label: (ln || stem(x.name)) + (t.sdh ? ' (SDH)' : '') + (t.forced ? ' · forced' : ''), detail: x.name };
  }).filter(Boolean);
}
/* tracks inside the video file (listed by the server with ffprobe) */
export async function embeddedSources(f) {
  const r = await api(`/api/files/${f.id}/subtitles`, { timeout: 60000 });
  return (r.tracks || []).map(t => {
    const ln = langName(t.lang);
    const label = (t.title && !/^(sdh|forced|full|subs?|subtitles?)$/i.test(t.title) ? t.title + (ln && !t.title.toLowerCase().includes(ln.toLowerCase()) ? ' · ' + ln : '') : ln || `Track ${t.n + 1}`)
      + (t.sdh ? ' (SDH)' : '') + (t.forced ? ' · forced' : '');
    return { key: 'e:' + t.n, kind: 'embedded', n: t.n, lang: t.lang, forced: t.forced, isDefault: t.default, usable: t.text,
      label, detail: t.text ? 'Built into the video' : 'Picture-based subtitles (' + t.codec + ') can’t be shown' };
  });
}

/* cue list for a source */
export async function loadCues(f, src) {
  if (src.kind === 'local') return parseSubs(src.text);
  if (src.kind === 'file') {
    const x = store.byId(src.id); if (!x) throw new Error('That subtitle file is gone.');
    return parseSubs(await store.fetchText(x));
  }
  // built-in: extraction can take a while on a big file, and the server runs two at a time
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`/api/files/${f.id}/subtitles/${src.n}`, { credentials: 'same-origin' });
    if (res.ok) return parseSubs(await res.text());
    if (res.status !== 503) { let m = ''; try { m = (await res.json()).error; } catch (e) {} throw new Error(m || 'That subtitle track couldn’t be read.'); }
    await new Promise(r => setTimeout(r, 2500));
  }
  throw new Error('The server is busy reading other subtitles. Try again in a moment.');
}

export const attach = (f, subId) => api(`/api/files/${f.id}/sublinks`, { method: 'POST', json: { sub: subId } });
export const detach = (f, subId) => api(`/api/files/${f.id}/sublinks/${encodeURIComponent(subId)}`, { method: 'DELETE' });

/* ---------- parsing ---------- */
const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;
function secs(s) {
  const m = TIME.exec(s); if (!m) return NaN;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
}
/* text -> safe HTML: escape everything, then allow back simple styling */
function cueHtml(t) {
  const s = esc(String(t).replace(/\{\\[^}]*\}/g, '').trim())   // stray ASS overrides in SRT ({\an8})
    .replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>')
    .replace(/&lt;\/?(?:c|v|lang|ruby|rt|font|span)\b[^&]*?&gt;/gi, '')
    .replace(/&lt;\d[\d:.]*&gt;/g, '');                         // VTT karaoke timestamps
  return s.replace(/\r?\n/g, '<br>');
}

export function parseSubs(text) {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues = /^\s*\[Script Info\]/im.test(src) || /^Dialogue:/m.test(src) ? parseAss(src) : parseSrtVtt(src);
  return cues.filter(c => c.end > c.start && c.html).sort((a, b) => a.start - b.start);
}
function parseSrtVtt(src) {
  const out = [];
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = secs(a), end = secs(b);
    if (!isFinite(start) || !isFinite(end)) continue;
    out.push({ start, end, html: cueHtml(lines.slice(i + 1).join('\n')) });
  }
  return out;
}
function parseAss(src) {
  const out = [];
  let fmt = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  let inEvents = false;
  for (const line of src.split('\n')) {
    if (/^\s*\[/.test(line)) { inEvents = /^\s*\[events\]/i.test(line); continue; }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) { fmt = line.replace(/^format\s*:/i, '').split(',').map(s => s.trim().toLowerCase()); continue; }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const parts = line.replace(/^dialogue\s*:/i, '').split(',');
    const textAt = fmt.indexOf('text');
    const cols = parts.slice(0, textAt).map(s => s.trim()), body = parts.slice(textAt).join(',');
    const start = secs(cols[fmt.indexOf('start')] + '0'), end = secs(cols[fmt.indexOf('end')] + '0');   // H:MM:SS.cc
    if (!isFinite(start) || !isFinite(end)) continue;
    const t = body.replace(/\{\\i1\}/g, '<i>').replace(/\{\\i0?\}/g, '</i>').replace(/\{\\b1\}/g, '<b>').replace(/\{\\b0?\}/g, '</b>')
      .replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ');
    out.push({ start, end, html: cueHtml(t) });
  }
  return out;
}

/* cues showing at time t (sorted by start; overlaps allowed) */
export function cuesAt(cues, t) {
  let lo = 0, hi = cues.length - 1, last = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (cues[mid].start <= t) { last = mid; lo = mid + 1; } else hi = mid - 1; }
  const on = [];
  for (let i = last; i >= 0 && i > last - 12; i--) if (cues[i].end > t) on.unshift(cues[i]);
  return on;
}

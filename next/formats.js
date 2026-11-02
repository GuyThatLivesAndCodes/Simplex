/* formats.js — can this browser show a file natively, and if not, what can the
   server convert it into? The conversion lists mirror TOOL_SPECS in server.js
   (VIDEO_EXTS / AUDIO_EXTS / IMAGE_EXTS and each tool's targets) exactly. */
import { ext } from './lib.js';

const VIDEO_MIME = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', mkv: 'video/x-matroska', ts: 'video/mp2t', m2ts: 'video/mp2t', mts: 'video/mp2t', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp' };
const AUDIO_MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg; codecs=opus', weba: 'audio/webm', wma: 'audio/x-ms-wma' };
const IMAGE_OK = new Set(['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'apng']);
const PREVIEW_IMG = new Set(['exr', 'tif', 'tiff']);   // the server renders a PNG preview (posterUrl)
export const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'log', 'csv', 'tsv', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bat', 'ps1', 'sql', 'lua', 'r', 'swift', 'dart', 'vue', 'env', 'gitignore', 'dockerfile', 'srt', 'vtt', 'ass', 'ssa', 'jsonl', 'ndjson', 'nfo', 'gd', 'glsl', 'hlsl']);

/* server-side converters (TOOL_SPECS) */
const SV_VIDEO = ['mp4', 'ts', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v', 'wmv', 'mpg', 'mpeg', '3gp'];
const SV_AUDIO = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'];
const SV_IMAGE = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'exr'];
export const CONVERT = {
  video: { tool: 'video-convert', targets: ['mp4', 'webm', 'mkv', 'mov', 'ts', 'avi'] },
  videoAudio: { tool: 'video-to-audio', targets: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'] },
  audio: { tool: 'audio-convert', targets: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'] },
  image: { tool: 'image-convert', targets: ['png', 'jpg', 'webp', 'tiff', 'bmp', 'exr'] },
};
export function conversionsFor(f) {
  const e = ext(f.name);
  const out = [];
  if (SV_VIDEO.includes(e)) out.push({ group: 'Video', ...CONVERT.video }, { group: 'Audio only', ...CONVERT.videoAudio });
  else if (SV_AUDIO.includes(e)) out.push({ group: 'Audio', ...CONVERT.audio });
  else if (SV_IMAGE.includes(e)) out.push({ group: 'Image', ...CONVERT.image });
  return out.map(g => ({ ...g, targets: g.targets.filter(t => t !== e && !(e === 'jpeg' && t === 'jpg') && !(e === 'tif' && t === 'tiff')) })).filter(g => g.targets.length);
}

const probe = {};
function canPlay(kind, mime) {
  const k = kind + mime;
  if (!(k in probe)) { try { probe[k] = !!document.createElement(kind).canPlayType(mime); } catch (e) { probe[k] = false; } }
  return probe[k];
}
const NAMES = { ts: 'MPEG-TS video', m2ts: 'MPEG-TS video', mts: 'MPEG-TS video', avi: 'AVI video', wmv: 'Windows Media video', flv: 'Flash video', mkv: 'Matroska video', mpg: 'MPEG video', mpeg: 'MPEG video', '3gp': '3GP video', mov: 'QuickTime video', wma: 'Windows Media audio', heic: 'HEIC photo', heif: 'HEIF photo', psd: 'Photoshop file', raw: 'camera RAW photo', cr2: 'camera RAW photo', nef: 'camera RAW photo', dng: 'camera RAW photo' };

/* { how: 'image'|'video'|'audio'|'pdf'|'text'|'none', why } */
export function support(f) {
  const e = ext(f.name);
  if (f.type === 'image') {
    if (IMAGE_OK.has(e) || (!e && f.url)) return { how: 'image' };
    if (PREVIEW_IMG.has(e) && f.posterUrl) return { how: 'image', preview: true };
    return { how: 'none', why: `${NAMES[e] || (e ? '.' + e + ' images' : 'This image')} can’t be shown by web browsers.` };
  }
  if (f.type === 'video') {
    const mime = VIDEO_MIME[e];
    if (!e || (mime && canPlay('video', mime))) return { how: 'video' };
    return { how: 'none', why: `${NAMES[e] || '.' + e + ' video'} (.${e}) isn’t supported by web browsers.`, tryable: true };
  }
  if (f.type === 'audio') {
    const mime = AUDIO_MIME[e];
    if (!e || (mime && canPlay('audio', mime))) return { how: 'audio' };
    return { how: 'none', why: `${NAMES[e] || '.' + e + ' audio'} (.${e}) isn’t supported by web browsers.`, tryable: true };
  }
  if (e === 'pdf' && f.url) return { how: 'pdf' };
  if (f.type === 'document' && (!f.url || TEXT_EXT.has(e) || !e)) return { how: 'text' };
  return { how: 'none', why: e ? `.${e} files can’t be opened in the browser.` : 'This file can’t be opened in the browser.' };
}

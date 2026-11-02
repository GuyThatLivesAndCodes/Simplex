/* pick.js — choose files from the vault in a searchable dialog. Resolves with an
   array of file ids, or null when cancelled. Used by the VM app (send files in)
   and the player (attach subtitles). */
import { html, icon, fmtSize, fmtDate } from './lib.js';
import * as store from './store.js';
import { dialog } from './ui.js';

const fileIc = n => /\.(exe|msi|bat|cmd|ps1|com|jar)$/i.test(n) ? 'window' : /\.(png|jpe?g|gif|webp|bmp)$/i.test(n) ? 'image' : /\.(mp4|mkv|mov|avi|webm)$/i.test(n) ? 'video' : /\.(mp3|wav|flac|ogg|m4a)$/i.test(n) ? 'audio' : /\.(zip|7z|rar|tar|gz)$/i.test(n) ? 'folder' : 'file';

/* filter(f) narrows what is offered; rank(f) floats matches to the top (higher first) */
export function pickFiles({ title, multi = false, filter, rank, okLabel, hint, empty = 'No files match' }) {
  return new Promise(resolve => {
    const all = store.live().filter(f => f.type !== 'folder' && !f.locked && (!filter || filter(f)))
      .sort((a, b) => (rank ? rank(b) - rank(a) : 0) || (b.date || 0) - (a.date || 0));
    const chosen = new Set(); let q = '', settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    dialog({
      ic: 'database', title, wide: true,
      body: html`<div class="pick-find">${icon('search', 15)}<input placeholder="Search your files" spellcheck="false"></div>
        <div class="pick-list"></div>${hint ? html`<p class="dim pick-hint">${hint}</p>` : ''}`,
      actions: [{ label: 'Cancel', run: () => done(null) }, { label: okLabel || (multi ? 'Add' : 'Choose'), kind: 'pri', run: () => { if (!chosen.size) return false; done([...chosen]); } }],
      onMount: (r, close) => {
        const list = r.querySelector('.pick-list');
        const draw = () => {
          const items = all.filter(f => !q || f.name.toLowerCase().includes(q)).slice(0, 80);
          list.innerHTML = items.length ? items.map(f => html`<button class="pick-i${chosen.has(f.id) ? ' on' : ''}" data-id="${f.id}"><span class="pick-ic">${icon(fileIc(f.name), 15)}</span><span><b>${f.name}</b><small>${fmtSize(f.size || 0)} · ${fmtDate(f.date)}${f.parent && store.byId(f.parent) ? ' · ' + store.byId(f.parent).name : ''}</small></span><i>${chosen.has(f.id) ? icon('check', 14, 2.4) : ''}</i></button>`.s).join('') : html`<div class="dim pick-hint" style="padding:20px;text-align:center">${empty}</div>`.s;
        };
        draw();
        const inp = r.querySelector('input');
        inp.oninput = e => { q = e.target.value.toLowerCase(); draw(); };
        setTimeout(() => inp.focus(), 50);
        list.onclick = e => {
          const b = e.target.closest('[data-id]'); if (!b) return;
          if (!multi) { chosen.clear(); chosen.add(b.dataset.id); close(); done([b.dataset.id]); return; }
          chosen.has(b.dataset.id) ? chosen.delete(b.dataset.id) : chosen.add(b.dataset.id); draw();
        };
        const obs = new MutationObserver(() => { if (!r.isConnected) { obs.disconnect(); done(null); } });
        obs.observe(document.body, { childList: true, subtree: true });   // in full screen the dialog lives deeper than body
      },
    });
  });
}

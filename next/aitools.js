/* aitools.js — the tools the AI can call, in the plain-text protocol every model
   understands:   ```tool_use\n{"tool": "name", "args": {...}}\n```

   Each tool declares a KIND that drives permissions:
     read    — looking things up (files, web, past chats, memory). Never asks.
     ui      — artifacts in the side panel. Never asks.
     write   — creates or changes something.
     delete  — removes something (Trash or permanent).
   and returns { text, summary }: `text` goes back to the model (complete, with
   explicit truncation notes), `summary` is the one line the user sees. Raw output
   is never shown in the chat — the user sees what was done, not the dump. */
import { api, fmtSize, plural } from './lib.js';
import * as store from './store.js';

const MAX_LIST = 1000;

/* ---------------- lookup helpers ---------------- */
const pathOf = f => store.pathOf(f.id).map(n => n.name).join('/');
const day = t => (t ? new Date(t).toISOString().slice(0, 10) : '');
const row = f => `${f.id} | ${pathOf(f)}${f.type === 'folder' ? '/' : ''} | ${f.type} | ${f.type === 'folder' ? store.children(f.id).length + ' items' : fmtSize(f.size || 0)} | ${day(f.date)}${f.starred ? ' | starred' : ''}`;
const quote = s => { const f = store.byId(String(s)); return '“' + (f ? f.name : s) + '”'; };   // labels show names even when the model passes ids
async function ready() { if (!store.S.loaded) await store.loadFiles(); }

/* an item from an id, a path ("Projects/2026/plan.md") or a unique name */
function resolve(ref, { folderOnly, fileOnly } = {}) {
  const r = String(ref ?? '').trim();
  if (!r) throw new Error('no file given');
  const ok = f => !f.trashed && (!folderOnly || f.type === 'folder') && (!fileOnly || f.type !== 'folder');
  const byId = store.byId(r); if (byId && ok(byId)) return byId;
  const live = store.live().filter(ok);
  const clean = r.replace(/^\/+|\/+$/g, '');
  if (clean.includes('/')) { const hit = live.find(f => pathOf(f).toLowerCase() === clean.toLowerCase()); if (hit) return hit; }
  const exact = live.filter(f => f.name.toLowerCase() === clean.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`"${r}" matches ${exact.length} items — use one of these ids:\n` + exact.slice(0, 8).map(row).join('\n'));
  const part = live.filter(f => f.name.toLowerCase().includes(clean.toLowerCase()));
  if (part.length === 1) return part[0];
  if (part.length > 1) throw new Error(`"${r}" is ambiguous (${part.length} matches) — use an id:\n` + part.slice(0, 8).map(row).join('\n'));
  throw new Error(`nothing called "${r}" — use search_files to find it`);
}
function resolveFolder(ref) {
  const r = String(ref ?? '').trim();
  if (!r || r === '/' || /^(root|all files|home)$/i.test(r)) return null;
  return resolve(r, { folderOnly: true });
}
const many = refs => (Array.isArray(refs) ? refs : [refs]).filter(x => x != null && x !== '').map(x => resolve(x));
const nameOf = f => (f ? f.name : 'All files');

/* paged output that always says what was left out */
function page(items, offset, limit, total, what) {
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const lim = Math.min(MAX_LIST, Math.max(1, Math.floor(Number(limit) || 200)));
  const slice = items.slice(off, off + lim);
  const head = total === 0 ? `No ${what}.` : `Showing ${off + 1}–${off + slice.length} of ${total} ${what}.`;
  const more = off + slice.length < total ? `\n[TRUNCATED: ${total - off - slice.length} more not shown. Call again with offset=${off + slice.length} to continue, or narrow the filters.]` : '';
  return { slice, text: head + (slice.length ? '\nid | path | type | size | modified\n' + slice.map(row).join('\n') : '') + more };
}
function sortItems(items, sort = 'name', order = 'asc') {
  const k = { name: f => f.name.toLowerCase(), date: f => f.date || 0, size: f => f.size || 0, type: f => f.type }[sort] || (f => f.name.toLowerCase());
  const m = order === 'desc' ? -1 : 1;
  return items.sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0) * m);
}
const parseSize = v => { if (v == null || v === '') return null; if (typeof v === 'number') return v; const m = /^([\d.]+)\s*(b|kb|mb|gb|tb)?$/i.exec(String(v).trim()); if (!m) return null; return Number(m[1]) * ({ b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[(m[2] || 'b').toLowerCase()]); };
const parseDate = v => { if (!v) return null; const t = Date.parse(v); return isFinite(t) ? t : null; };

/* ---------------- the tools ---------------- */
export const TOOLS = {
  vault_overview: {
    kind: 'read', label: () => 'Looking over your files',
    desc: 'Totals for the whole vault: file and folder counts, counts and sizes by type, storage used, and the top-level folders. Use this first to understand a large vault. args: {}',
    run: async () => {
      await ready();
      const live = store.live(), files = live.filter(f => f.type !== 'folder');
      const by = {}; files.forEach(f => { by[f.type] = by[f.type] || { n: 0, size: 0 }; by[f.type].n++; by[f.type].size += f.size || 0; });
      const top = store.children(null).filter(f => f.type === 'folder');
      const a = store.S.account || {};
      const text = [`${files.length} files and ${live.length - files.length} folders. Storage: ${fmtSize(store.S.used || 0)}${a.quota_bytes ? ' of ' + fmtSize(a.quota_bytes) : ''}.`,
        'By type: ' + Object.entries(by).map(([t, v]) => `${t} ${v.n} (${fmtSize(v.size)})`).join(', '),
        `Top-level folders (${top.length}):`, ...top.slice(0, 300).map(f => `${f.id} | ${f.name}/ | ${store.descendants(f.id).filter(x => !x.trashed && x.type !== 'folder').length} files inside`),
        top.length > 300 ? `[TRUNCATED: ${top.length - 300} more folders — use list_folder]` : '',
        `Starred: ${live.filter(f => f.starred).length}. In Trash: ${store.trashed().length}.`].filter(Boolean).join('\n');
      return { text, summary: `Looked over ${plural(files.length, 'file')} in ${plural(live.length - files.length, 'folder')}` };
    },
  },
  list_folder: {
    kind: 'read', label: a => `Opening ${a.folder ? quote(a.folder) : 'All files'}`,
    desc: 'List what is directly inside one folder (not recursive). args: {"folder"?: id|path|name (omit for the top level), "sort"?: "name"|"date"|"size"|"type", "order"?: "asc"|"desc", "offset"?: number, "limit"?: number (default 200, max 1000)}',
    run: async a => {
      await ready();
      const folder = resolveFolder(a.folder);
      const items = sortItems(store.children(folder ? folder.id : null), a.sort, a.order);
      const p = page(items, a.offset, a.limit, items.length, 'items in ' + (folder ? pathOf(folder) + '/' : 'All files'));
      return { text: p.text, summary: `Listed ${plural(items.length, 'item')} in ${nameOf(folder)}` };
    },
  },
  search_files: {
    kind: 'read', label: a => a.query ? `Searching files for ${quote(a.query)}` : 'Searching files',
    desc: 'Find files and folders anywhere in the vault (or under one folder). All filters are optional and combine. "query" matches names (every word must appear). args: {"query"?: string, "type"?: "folder"|"document"|"image"|"video"|"audio"|"model3d"|"uasset", "ext"?: string, "folder"?: id|path, "recursive"?: boolean (default true), "starred"?: boolean, "min_size"?: "10MB", "max_size"?: "1GB", "modified_after"?: "2026-01-31", "modified_before"?: date, "sort"?: "name"|"date"|"size"|"type", "order"?: "asc"|"desc", "offset"?: number, "limit"?: number (default 200, max 1000)}',
    run: async a => {
      await ready();
      const folder = a.folder ? resolveFolder(a.folder) : null;
      let items = folder ? (a.recursive === false ? store.children(folder.id) : store.descendants(folder.id).filter(f => !f.trashed)) : store.live();
      const words = String(a.query || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length) items = items.filter(f => { const n = f.name.toLowerCase(); return words.every(w => n.includes(w)); });
      if (a.type) items = items.filter(f => f.type === a.type);
      if (a.ext) { const e = String(a.ext).toLowerCase().replace(/^\./, ''); items = items.filter(f => f.name.toLowerCase().endsWith('.' + e)); }
      if (a.starred != null) items = items.filter(f => !!f.starred === !!a.starred);
      const mn = parseSize(a.min_size), mx = parseSize(a.max_size), af = parseDate(a.modified_after), bf = parseDate(a.modified_before);
      if (mn != null) items = items.filter(f => (f.size || 0) >= mn);
      if (mx != null) items = items.filter(f => (f.size || 0) <= mx);
      if (af != null) items = items.filter(f => (f.date || 0) >= af);
      if (bf != null) items = items.filter(f => (f.date || 0) <= bf);
      items = sortItems(items, a.sort || 'name', a.order);
      const p = page(items, a.offset, a.limit, items.length, 'matches');
      return { text: p.text, summary: `Searched files${a.query ? ' for ' + quote(a.query) : ''}${folder ? ' in ' + folder.name : ''} — ${plural(items.length, 'match', 'matches')}` };
    },
  },
  folder_tree: {
    kind: 'read', label: a => `Mapping folders${a.folder ? ' in ' + quote(a.folder) : ''}`,
    desc: 'An indented outline of folders (with how many items each holds) under a folder or the whole vault. args: {"folder"?: id|path, "depth"?: number (default 3, max 8), "max_lines"?: number (default 300, max 1500)}',
    run: async a => {
      await ready();
      const root = resolveFolder(a.folder), depth = Math.min(8, Math.max(1, Number(a.depth) || 3)), cap = Math.min(1500, Math.max(10, Number(a.max_lines) || 300));
      const lines = []; let total = 0;
      const walk = (pid, d) => {
        for (const f of sortItems(store.children(pid).filter(x => x.type === 'folder'))) {
          total++;
          if (lines.length < cap) lines.push(`${'  '.repeat(d)}${f.name}/  (${store.children(f.id).length} items, id ${f.id})`);
          if (d + 1 < depth) walk(f.id, d + 1);
        }
      };
      walk(root ? root.id : null, 0);
      const text = (root ? pathOf(root) + '/\n' : 'All files/\n') + (lines.join('\n') || '(no folders)') + (total > lines.length ? `\n[TRUNCATED: ${total - lines.length} more folders — raise max_lines or start from a subfolder]` : '');
      return { text, summary: `Mapped ${plural(total, 'folder')}${root ? ' in ' + root.name : ''}` };
    },
  },
  file_info: {
    kind: 'read', label: a => `Checking ${quote(a.file || '')}`,
    desc: 'Details about one file or folder: path, type, size, dates, dimensions/duration, and (for folders) what is inside. args: {"file": id|path|name}',
    run: async a => {
      await ready();
      const f = resolve(a.file);
      const bits = [row(f)];
      if (f.w && f.h) bits.push(`dimensions ${f.w}×${f.h}`);
      if (f.dur) bits.push(`duration ${Math.round(f.dur)}s`);
      if (f.artist || f.album) bits.push(`artist ${f.artist || '?'}, album ${f.album || '?'}`);
      if (f.type === 'folder') { const d = store.descendants(f.id).filter(x => !x.trashed); bits.push(`${d.filter(x => x.type !== 'folder').length} files and ${d.filter(x => x.type === 'folder').length} folders inside (all levels), ${fmtSize(d.reduce((n, x) => n + (x.size || 0), 0))}`); }
      return { text: bits.join('\n'), summary: `Checked ${f.name}` };
    },
  },
  read_file: {
    kind: 'read', label: a => `Reading ${quote(a.file || '')}`,
    desc: 'Read a text file. Long files come in slices: pass offset to continue. args: {"file": id|path|name, "offset"?: number (characters, default 0), "length"?: number (default 20000, max 80000)}',
    run: async a => {
      await ready();
      const f = resolve(a.file, { fileOnly: true });
      let text;
      try { text = await store.fetchText(f); } catch (e) { throw new Error('could not read ' + f.name); }
      const off = Math.max(0, Number(a.offset) || 0), len = Math.min(80000, Math.max(100, Number(a.length) || 20000));
      const part = text.slice(off, off + len);
      const note = off + part.length < text.length ? `\n[TRUNCATED: characters ${off}–${off + part.length} of ${text.length}. Call again with offset=${off + part.length} for more.]` : `\n[end of file — ${text.length} characters]`;
      return { text: `${pathOf(f)}\n---\n${part}${note}`, summary: `Read ${f.name}${off ? ' (from character ' + off + ')' : ''}` };
    },
  },
  web_search: {
    kind: 'read', label: a => `Searching the web for ${quote(a.query || '')}`,
    desc: 'Search the web for current or factual information. args: {"query": string}',
    run: async a => {
      const q = String(a.query || '').trim(); if (!q) throw new Error('query required');
      const r = await api('/api/ai/tools/web_search', { method: 'POST', json: { query: q } });
      const res = r.results || [];
      return { text: res.length ? res.map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${x.snippet || ''}`.trim()).join('\n\n') : 'No results found.', summary: `Searched the web for ${quote(q)} — ${plural(res.length, 'result')}` };
    },
  },
  search_chats: {
    kind: 'read', history: true, label: a => `Looking through past chats for ${quote(a.query || '')}`,
    desc: 'Search the user\'s past conversations with you (titles and messages). Use it when they refer to something discussed before. args: {"query": string, "limit"?: number (default 6, max 12)}',
    run: async (a, ctx) => {
      const q = String(a.query || '').toLowerCase().trim(); if (!q) throw new Error('query required');
      const words = q.split(/\s+/).filter(Boolean);
      const chats = (await api('/api/ai/chats')).filter(c => c.id !== ctx.chatId).sort((x, y) => (y.updated || 0) - (x.updated || 0)).slice(0, 60);
      const hits = [];
      for (const c of chats) {
        let full; try { full = await api('/api/ai/chats/' + c.id); } catch (e) { continue; }
        const msgs = (full.messages || []).filter(m => (m.role === 'user' && !m.toolResult) || m.role === 'assistant');
        const blob = msgs.map(m => m.content || '').join('\n').toLowerCase();
        const score = words.filter(w => blob.includes(w) || (c.title || '').toLowerCase().includes(w)).length;
        if (!score) continue;
        const snips = msgs.filter(m => words.some(w => (m.content || '').toLowerCase().includes(w))).slice(0, 3)
          .map(m => `  ${m.role === 'user' ? 'User' : 'You'}: ${String(m.content || '').replace(/```tool_use[\s\S]*?```/g, '').replace(/\s+/g, ' ').slice(0, 280)}`);
        hits.push({ score, text: `• "${c.title || 'Untitled'}" (${day(c.updated)}, chat ${c.id})\n${snips.join('\n')}` });
      }
      hits.sort((x, y) => y.score - x.score);
      const lim = Math.min(12, Math.max(1, Number(a.limit) || 6));
      return { text: hits.length ? hits.slice(0, lim).map(h => h.text).join('\n\n') + (hits.length > lim ? `\n[${hits.length - lim} more matching chats not shown]` : '') : 'No past chats mention that (searched the 60 most recent).', summary: `Searched past chats for ${quote(a.query)} — ${plural(Math.min(hits.length, lim), 'match', 'matches')}` };
    },
  },
  recent_chats: {
    kind: 'read', history: true, label: () => 'Checking recent chats',
    desc: 'Titles and dates of the user\'s most recent conversations with you. args: {"limit"?: number (default 10, max 30)}',
    run: async (a, ctx) => {
      const lim = Math.min(30, Math.max(1, Number(a.limit) || 10));
      const chats = (await api('/api/ai/chats')).filter(c => c.id !== ctx.chatId).sort((x, y) => (y.updated || 0) - (x.updated || 0));
      return { text: chats.slice(0, lim).map(c => `• ${c.title || 'Untitled'} — ${day(c.updated)} (chat ${c.id})`).join('\n') || 'No other chats yet.', summary: `Checked ${plural(Math.min(lim, chats.length), 'recent chat')}` };
    },
  },
  recall: {
    kind: 'read', label: () => 'Checking memory',
    desc: 'Everything currently saved in your long-term memory of the user, with ids. args: {}',
    run: async (a, ctx) => {
      const m = ctx.memory.list();
      return { text: m.length ? m.map(x => `- (${x.id}) ${x.text}`).join('\n') : 'Memory is empty.', summary: `Checked memory (${plural(m.length, 'item')})` };
    },
  },
  remember: {
    kind: 'write', label: () => 'Saving to memory', describe: a => `Remember: ${quote(String(a.text || '').slice(0, 120))}`,
    desc: 'Save a lasting fact about the user to long-term memory (only durable things — preferences, details about them or their work — not one-off task context). args: {"text": string, "category"?: "about"|"work"|"prefs"|"ongoing"}',
    run: async (a, ctx) => {
      const r = await ctx.memory.add(String(a.text || ''), a.category);
      return { text: r.message, summary: r.added ? 'Saved to memory' : 'Memory unchanged' };
    },
  },
  forget: {
    kind: 'write', label: () => 'Updating memory', describe: a => `Forget ${a.id ? 'memory ' + a.id : quote(String(a.text || ''))}`,
    desc: 'Remove a memory that is wrong or outdated. args: {"id"?: string (from recall), "text"?: string to match}',
    run: async (a, ctx) => { const r = await ctx.memory.remove(a.id, a.text); return { text: r, summary: 'Removed a memory' }; },
  },
  create_file: {
    kind: 'write', label: a => `Creating ${quote(a.name || '')}`, describe: a => `Create ${quote(a.name || '')}${a.folder ? ' in ' + quote(a.folder) : ''}`,
    desc: 'Create a new text/code file. args: {"name": string (with extension), "content": string, "folder"?: id|path}',
    run: async a => {
      await ready();
      const name = String(a.name || '').trim(); if (!name) throw new Error('name required');
      const folder = resolveFolder(a.folder);
      const rec = await api('/api/files/doc', { method: 'POST', json: { name, content: String(a.content ?? ''), parent: folder ? folder.id : null } });
      store.added(rec);
      return { text: `Created ${pathOf(rec)} (id ${rec.id}, ${fmtSize(rec.size)}).`, summary: `Created ${rec.name}${folder ? ' in ' + folder.name : ''}` };
    },
  },
  edit_file: {
    kind: 'write', label: a => `Editing ${quote(a.file || '')}`,
    describe: a => a.edits ? `Make ${plural(a.edits.length, 'change')} to ${quote(a.file || '')}` : a.append ? `Add text to the end of ${quote(a.file || '')}` : `Replace the contents of ${quote(a.file || '')}`,
    desc: 'Change a text file. Use ONE of: "content" (replace everything), "append" (add to the end), or "edits" (targeted find/replace — preferred for small changes). args: {"file": id|path|name, "content"?: string, "append"?: string, "edits"?: [{"find": string, "replace": string, "all"?: boolean}]}',
    run: async a => {
      await ready();
      const f = resolve(a.file, { fileOnly: true });
      let next;
      if (Array.isArray(a.edits)) {
        next = await store.fetchText(f);
        for (const e of a.edits) {
          if (!e || typeof e.find !== 'string' || !e.find) throw new Error('each edit needs "find"');
          if (!next.includes(e.find)) throw new Error(`couldn't find this text in ${f.name}: ${e.find.slice(0, 80)}`);
          next = e.all ? next.split(e.find).join(String(e.replace ?? '')) : next.replace(e.find, String(e.replace ?? ''));
        }
      } else if (a.append != null) next = (await store.fetchText(f)) + String(a.append);
      else if (a.content != null) next = String(a.content);
      else throw new Error('give content, append or edits');
      await store.saveContent(f.id, next);
      return { text: `Saved ${pathOf(f)} (${next.length} characters).`, summary: `Edited ${f.name}` };
    },
  },
  create_folder: {
    kind: 'write', label: a => `Creating folder ${quote(a.name || '')}`, describe: a => `Create the folder ${quote(a.name || '')}${a.parent ? ' in ' + quote(a.parent) : ''}`,
    desc: 'Create a folder. args: {"name": string, "parent"?: id|path}',
    run: async a => {
      await ready();
      const parent = resolveFolder(a.parent);
      const f = await store.createFolder(String(a.name || '').trim() || 'New folder', parent ? parent.id : null);
      return { text: `Created folder ${pathOf(f)}/ (id ${f.id}).`, summary: `Created folder ${f.name}` };
    },
  },
  rename: {
    kind: 'write', label: a => `Renaming ${quote(a.file || '')}`, describe: a => `Rename ${quote(a.file || '')} to ${quote(a.new_name || '')}`,
    desc: 'Rename a file or folder. args: {"file": id|path|name, "new_name": string}',
    run: async a => {
      await ready();
      const f = resolve(a.file), name = String(a.new_name || '').trim(); if (!name) throw new Error('new_name required');
      const old = f.name; await store.rename(f.id, name);
      return { text: `Renamed ${old} to ${name}.`, summary: `Renamed ${old} → ${name}` };
    },
  },
  move: {
    kind: 'write', bulk: a => (Array.isArray(a.files) ? a.files.length : 1), label: a => `Moving ${plural(Array.isArray(a.files) ? a.files.length : 1, 'item')}`,
    describe: a => `Move ${plural(Array.isArray(a.files) ? a.files.length : 1, 'item')} to ${quote(a.to || 'All files')}`,
    desc: 'Move files/folders into a folder. args: {"files": [id|path, …], "to": id|path (omit for the top level)}',
    run: async a => {
      await ready();
      const items = many(a.files), dest = resolveFolder(a.to);
      const r = await store.move(items.map(f => f.id), dest ? dest.id : null);
      return { text: `Moved ${r.moved.length} to ${nameOf(dest)}${r.skipped && r.skipped.length ? `; ${r.skipped.length} skipped (can't move a folder into itself)` : ''}.`, summary: `Moved ${plural(r.moved.length, 'item')} to ${nameOf(dest)}` };
    },
  },
  star: {
    kind: 'write', bulk: a => (Array.isArray(a.files) ? a.files.length : 1), label: () => 'Updating stars',
    describe: a => `${a.starred === false ? 'Unstar' : 'Star'} ${plural(Array.isArray(a.files) ? a.files.length : 1, 'item')}`,
    desc: 'Star or unstar items. args: {"files": [id|path, …], "starred"?: boolean (default true)}',
    run: async a => { await ready(); const items = many(a.files), on = a.starred !== false; for (const f of items) await store.setStar(f.id, on); return { text: `${on ? 'Starred' : 'Unstarred'} ${items.length}.`, summary: `${on ? 'Starred' : 'Unstarred'} ${plural(items.length, 'item')}` }; },
  },
  restore: {
    kind: 'write', label: () => 'Restoring from Trash', describe: a => `Restore ${plural(Array.isArray(a.files) ? a.files.length : 1, 'item')} from Trash`,
    desc: 'Restore items from Trash (ids from search_files can\'t see Trash — use the ids the user gives or from earlier). args: {"files": [id, …]}',
    run: async a => {
      await ready();
      const ids = (Array.isArray(a.files) ? a.files : [a.files]).map(String).filter(id => store.byId(id));
      if (!ids.length) throw new Error('none of those ids are in Trash');
      await store.restore(ids);
      return { text: `Restored ${ids.length}.`, summary: `Restored ${plural(ids.length, 'item')} from Trash` };
    },
  },
  delete: {
    kind: 'delete', bulk: a => (Array.isArray(a.files) ? a.files.length : 1), label: () => 'Moving to Trash',
    describe: a => `Move ${plural(Array.isArray(a.files) ? a.files.length : 1, 'item')} to Trash${Array.isArray(a.files) && a.files.length <= 3 ? ': ' + a.files.map(x => (store.byId(x) || {}).name || x).join(', ') : ''}`,
    desc: 'Delete items by moving them to Trash (recoverable). args: {"files": [id|path, …]}',
    run: async a => { await ready(); const items = many(a.files); await store.trash(items.map(f => f.id)); return { text: `Moved ${items.length} to Trash.`, summary: `Moved ${plural(items.length, 'item')} to Trash` }; },
  },
  delete_forever: {
    kind: 'delete', bulk: a => (Array.isArray(a.files) ? a.files.length : 1), label: () => 'Deleting permanently',
    describe: a => `PERMANENTLY delete ${plural(Array.isArray(a.files) ? a.files.length : 1, 'item')} — this can't be undone`,
    desc: 'Permanently delete items (no Trash, cannot be undone). Only when the user clearly asks for permanent deletion. args: {"files": [id, …]}',
    run: async a => {
      await ready();
      const ids = (Array.isArray(a.files) ? a.files : [a.files]).map(String).map(x => (store.byId(x) ? x : resolve(x).id));
      await store.destroy(ids);
      return { text: `Permanently deleted ${ids.length}.`, summary: `Permanently deleted ${plural(ids.length, 'item')}` };
    },
  },
  create_artifact: {
    kind: 'ui', label: a => `Writing ${quote(a.title || 'artifact')}`,
    desc: 'Show substantial code, a document, HTML or SVG in the side panel, where the user can preview, edit, copy, download or save it. args: {"title": string, "type": "code"|"markdown"|"html"|"svg"|"text", "content": string, "language"?: string}',
    run: async (a, ctx) => { const art = ctx.artifacts.create(a); return { text: `Artifact "${art.title}" (id ${art.id}) is open in the side panel.`, summary: `Created ${art.title}` }; },
  },
  update_artifact: {
    kind: 'ui', label: () => 'Updating the artifact',
    desc: 'Replace an artifact\'s content (defaults to the latest one). args: {"id"?: string, "content": string, "title"?: string}',
    run: async (a, ctx) => { const art = ctx.artifacts.update(a); if (!art) throw new Error('artifact not found'); return { text: `Updated "${art.title}".`, summary: `Updated ${art.title}` }; },
  },
};

/* ---------------- permissions ---------------- */
export const MODES = {
  auto: { label: 'Auto', sub: 'Decides when to check with you. Always asks before deleting.' },
  ask: { label: 'Ask permission', sub: 'Asks before every change. Searching and reading never ask.' },
  allow: { label: 'Always allow', sub: 'Does anything without asking — including deleting.' },
};
const BULK = 25;
export function needsApproval(call, mode, chatAllowed) {
  const t = TOOLS[call.tool]; if (!t) return false;
  if (t.kind === 'read' || t.kind === 'ui') return false;
  if (mode === 'allow' || chatAllowed) return false;
  if (mode === 'ask') return true;
  // auto: deletions always ask; the model can ask on its own; very large batches ask
  if (t.kind === 'delete') return true;
  if (call.args && call.args.ask === true) return true;
  return t.bulk ? t.bulk(call.args || {}) > BULK : false;
}
export const describeCall = c => { const t = TOOLS[c.tool]; return t && t.describe ? t.describe(c.args || {}) : (t ? t.label(c.args || {}) : c.tool); };

/* ---------------- protocol ---------------- */
/* The format is ```tool_use {json}```, but models drift: the fence glued to the end
   of a sentence ("Done.```tool_use"), a bare "tool_use" label, ```json fences,
   <tool_use> tags, fences left open or doubled. So instead of matching fences, the
   scanner finds each {"tool": …} object by balancing braces, then widens the span
   over whatever label/fence wraps it. Calls are found and hidden by the same scan,
   so what runs and what is hidden can't disagree. JSON naming an unknown tool only
   counts when it's labelled as a tool call (an example in normal prose stays). */
const asCall = s => { try { const o = JSON.parse(String(s).trim()); const name = o && (o.tool || o.name); return name && (TOOLS[name] || o.tool) ? { tool: String(name), args: o.args || o.arguments || o.parameters || {} } : null; } catch (e) { return null; } };
function jsonEnd(text, i) {   // index just past the object starting at text[i] === '{', or -1
  let depth = 0, str = false, esc = false;
  for (let k = i; k < text.length; k++) {
    const ch = text[k];
    if (str) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') str = false; continue; }
    if (ch === '"') str = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) return k + 1;
  }
  return -1;
}
const OPEN = /(?:<tool_(?:use|call)>|`{3,}[ \t]*(?:tool_use|tool_call|tool_code|tool|json)?|\b(?:tool_use|tool_call))[ \t]*\r?\n?[ \t]*$/i;
const CLOSE = /^[ \t]*\r?\n?[ \t]*(?:<\/tool_(?:use|call)>|`{3,}(?=[ \t]*(?:\r?\n|$)))/i;
function scan(text) {
  const out = [], re = /\{\s*"(?:tool|name)"\s*:/g; let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 48), m.index);
    const open = OPEN.exec(before), labelled = !!open && /tool|`/i.test(open[0]);
    const end = jsonEnd(text, m.index);
    if (end < 0) {   // never closed: a broken call if it was labelled as one, otherwise just text
      if (labelled) out.push({ start: m.index - open[0].length, end: text.length, call: { tool: '_bad_json', args: { raw: text.slice(m.index, m.index + 200) } } });
      break;
    }
    const raw = text.slice(m.index, end), call = asCall(raw);
    let start = m.index, stop = end;
    if (labelled) start -= open[0].length;
    const close = CLOSE.exec(text.slice(end)); if (close && labelled) stop += close[0].length;
    if (call && (labelled || TOOLS[call.tool])) out.push({ start, end: stop, call });
    else if (!call && labelled && /tool_use|tool_call/i.test(open[0])) out.push({ start, end: stop, call: { tool: '_bad_json', args: { raw: raw.slice(0, 200) } } });
    re.lastIndex = end;
  }
  return out;
}
export const parseToolCalls = text => scan(String(text || '')).map(x => x.call);
export function stripTools(t) {
  let s = String(t || '');
  for (const x of scan(s).reverse()) s = s.slice(0, x.start) + (/\S$/.test(s.slice(0, x.start)) ? '\n' : '') + s.slice(x.end);
  s = s.replace(/`{3,}[ \t]*(?:tool_use|tool_call|tool_code|json)?[ \t]*\r?\n?[ \t]*`{3,}/gi, '');   // fences left empty
  if (((s.match(/`{3,}/g) || []).length) % 2) s = s.replace(/\s*`{3,}[ \t]*(?:tool_use|tool_call|json)?\s*$/i, '');   // a dangling opener at the end
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
/* while a reply streams, show only the prose before its first tool call */
export function liveProse(t) {
  const s = String(t || '');
  const m = /(?:<tool_(?:use|call)>|`{3,}[ \t]*(?:tool_use|tool_call)|\b(?:tool_use|tool_call)\b|\{\s*"tool"\s*:)/i.exec(s);
  return (m ? s.slice(0, m.index) : s).replace(/`{1,3}[a-z_]*$/i, '');   // and not a half-typed fence
}

/* what the model is told about its tools — kept tight; behaviour rules first.
   level (the user's "System prompt" setting): 'full' = everything below,
   'minimal' = the call format and one line per tool, 'none' = nothing (no tools). */
export function toolsPrompt({ mode, history, memoryOn, level = 'full' }) {
  if (level === 'none') return '';
  const names = Object.entries(TOOLS).filter(([, t]) => !t.history || history).filter(([n]) => memoryOn || !['remember', 'forget', 'recall'].includes(n));
  if (level === 'minimal') {
    const first = d => String(d).split(/(?<=[.;])\s/)[0].replace(/[.;]$/, '').replace(/\s*args:.*$/, '');
    // just the argument names from the description's args: {...} part — "file, offset?"
    const argsOf = d => { const a = /args:\s*(\{.*\})/.exec(String(d)); return a ? [...a[1].matchAll(/"(\w+)"(\??)\s*:/g)].map(m => m[1] + m[2]).join(', ') : ''; };
    return [
      'Tools: call one with a fenced block, one call per block — several blocks in one reply run together:',
      '```tool_use', '{"tool": "name", "args": { ... }}', '```',
      'Then stop; results come back as TOOL_RESULTS. Saying you will do something does nothing — put the calls in the same reply. Never invent ids or results; page through truncated listings.',
      ...names.map(([n, t]) => `- ${n}(${argsOf(t.desc)}): ${first(t.desc)}`),
      mode === 'allow' ? 'Every tool runs without asking.' : mode === 'ask' ? 'The user approves each change; reading never needs approval.' : 'Changes run directly; add "ask": true to args for anything big or hard to undo. Deleting always asks.',
    ].join('\n');
  }
  const modeLine = mode === 'allow' ? 'Permission mode: ALWAYS ALLOW — every tool runs without asking the user, including deletion.'
    : mode === 'ask' ? 'Permission mode: ASK — the user approves every change before it runs (reading/searching never needs approval). If they deny one, accept it and continue without it.'
    : 'Permission mode: AUTO — reading/searching runs freely; changes run directly, but add "ask": true to a tool call\'s args when an action is significant or hard to undo (overwriting a file\'s contents, large batches, anything the user might not expect). Deleting always asks the user.';
  return [
    'You can call tools. To call one, write a fenced block exactly like this (one call per block):',
    '```tool_use', '{"tool": "tool_name", "args": { ... }}', '```',
    'IMPORTANT: writing that you will do something does nothing on its own. If you say you are going to look, scan, search, read or change anything, the tool_use block(s) MUST be in that same reply. Never end a reply on an announcement like "Scanning now." without the calls.',
    'Run independent calls together: put several tool_use blocks in the same reply and they run in parallel (reads run simultaneously; changes run in the order given). After your tool calls, stop writing — the results arrive in a message starting with TOOL_RESULTS.',
    `Work in steps, like a person at a computer: you may open with one short line saying what you are about to do ("Let me go through the whole vault." / "I'll check both folders."), then make the calls. When results come back, either call more tools or answer. The user sees everything you write between steps, so keep in-between lines brief and never repeat them in the final answer. Don't announce tools for simple requests that don't need any.`,
    '',
    'Tools:', ...names.map(([n, t]) => `- ${n}: ${t.desc}`),
    '',
    modeLine,
    'Working with the user\'s files:',
    '- Large vaults are normal. Results say "Showing X–Y of N" and mark anything cut off with [TRUNCATED …]. Never assume a listing is complete when it says it was truncated — page with offset, or narrow with filters, until you have what you need. Use vault_overview / folder_tree to get your bearings first.',
    '- Refer to items by the ids the tools return. Never invent ids, contents or results.',
    '- Only use tools when the request needs them. Don\'t browse the user\'s files or mention them unless the task involves them.',
    '- The user sees a short line for each tool you use, not the raw output, so summarize findings in your reply instead of pasting listings (unless they ask for one).',
    memoryOn ? '- Memory is handled automatically after each conversation, so you rarely need remember/forget — use them only when the user explicitly asks you to remember or forget something.' : '',
    '- When you have what you need, answer normally with no tool_use block.',
  ].filter(Boolean).join('\n');
}

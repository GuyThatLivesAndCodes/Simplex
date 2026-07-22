/* ============================================================
   NOTES + CODE apps (apps-editors.js) — extracted from app.js, loaded on demand
   the first time either opens (openApp -> openLazyApp -> loadFeature("apps-editors")).
   Plain (non-module) script sharing app.js global scope: DEFINES notesHTML/wireNotes
   + codeHTML/wireCode and SEES core helpers (svg/esc/toast/mdToHtml[viewers.js]/…).
   See [[lazy-loading-architecture]].
   ============================================================ */
/* ============================================================
   NOTES APP — list + rich-text (contenteditable) editor, autosaved
   ============================================================ */
let _notes = [], _noteActive = null, _noteDirty = false, _noteSaveTimer = null;

function notesHTML() {
  return `<div class="notes-app">
    <div class="notes-list">
      <div class="notes-list-head"><span class="eyebrow">Notes</span><button class="btn primary sm" id="noteNew">${svg('plus', 14)} New</button></div>
      <div class="notes-items" id="noteItems"><div class="dim mono pad-sm">Loading…</div></div>
    </div>
    <div class="notes-editor" id="notesEditor">${noteEmptyHTML()}</div>
  </div>`;
}
function noteEmptyHTML() { return `<div class="notes-empty-state"><div class="ico">${svg('note', 40, 1.4)}</div><p>Select a note, or create a new one.</p><button class="btn ghost" id="noteNew2">${svg('plus', 14)} New note</button></div>`; }

async function wireNotes() {
  document.getElementById('noteNew').onclick = newNote;
  const n2 = document.getElementById('noteNew2'); if (n2) n2.onclick = newNote;
  _appCleanup = () => flushNote();
  _noteActive = null;
  await refreshNotesList();
}
async function refreshNotesList() {
  try { _notes = await listNotes(); } catch (e) { if (e && e.code === 'AUTH') return relock(); _notes = []; }
  renderNotesList();
}
function renderNotesList() {
  const box = document.getElementById('noteItems'); if (!box) return;
  if (!_notes.length) { box.innerHTML = `<div class="dim mono pad-sm">No notes yet — create one.</div>`; return; }
  box.innerHTML = _notes.map(n => `<button class="note-item ${n.id === _noteActive ? 'on' : ''}" data-note="${n.id}">
    <div class="ni-title">${esc(n.title || 'Untitled')}</div>
    <div class="ni-sub mono">${fmtDate(n.updated)}</div>
    <div class="ni-snip">${esc(n.snippet || '')}</div>
  </button>`).join('');
  box.querySelectorAll('[data-note]').forEach(b => b.onclick = () => openNote(b.dataset.note));
}
async function newNote() {
  try { const n = await createNote({ title: '', body: '' }); await refreshNotesList(); openNote(n.id); }
  catch (e) { toast('Could not create note', 'close'); }
}
async function openNote(id) {
  await flushNote();
  let note; try { note = await getNote(id); } catch (e) { return; }
  _noteActive = id; _noteDirty = false;
  renderNotesList();
  const ed = document.getElementById('notesEditor'); if (!ed) return;
  const tools = [['bold', 'Bold', 'bold'], ['italic', 'Italic', 'italic'], ['underline', 'Underline', 'underline'],
    ['h1', 'Heading', 'formatBlock:H1'], ['h2', 'Subheading', 'formatBlock:H2'],
    ['listul', 'Bullet list', 'insertUnorderedList'], ['listol', 'Numbered list', 'insertOrderedList'],
    ['checksq', 'Checklist item', 'checklist'], ['link', 'Link', 'link']];
  ed.innerHTML = `
    <div class="note-toolbar">
      <input class="note-title" id="noteTitle" placeholder="Untitled" value="${esc(note.title || '')}">
      <div class="note-tools">
        ${tools.map(([ic, t, cmd]) => `<button class="nt-btn" data-cmd="${cmd}" title="${t}">${svg(ic, 15)}</button>`).join('')}
        <span class="spacer"></span>
        <span class="note-status mono" id="noteStatus">saved</span>
        <button class="nt-btn danger" id="noteDelete" title="Delete note">${svg('trash', 15)}</button>
      </div>
    </div>
    <div class="note-body" id="noteBody" contenteditable="true" spellcheck="true">${note.body || ''}</div>`;
  const title = ed.querySelector('#noteTitle'), body = ed.querySelector('#noteBody');
  title.oninput = markNoteDirty; body.oninput = markNoteDirty;
  body.addEventListener('blur', flushNote);
  ed.querySelectorAll('[data-cmd]').forEach(b => b.onclick = (e) => { e.preventDefault(); applyNoteCmd(b.dataset.cmd, body); });
  ed.querySelector('#noteDelete').onclick = () => removeNote(id);
}
function applyNoteCmd(cmd, body) {
  body.focus();
  if (cmd.startsWith('formatBlock:')) document.execCommand('formatBlock', false, cmd.split(':')[1]);
  else if (cmd === 'link') { const url = prompt('Link URL (https://…)'); if (url) document.execCommand('createLink', false, url); }
  else if (cmd === 'checklist') document.execCommand('insertHTML', false, '<div class="chk"><input type="checkbox"> </div>');
  else document.execCommand(cmd, false, null);
  markNoteDirty();
}
function markNoteDirty() {
  _noteDirty = true;
  const st = document.getElementById('noteStatus'); if (st) st.textContent = 'unsaved…';
  clearTimeout(_noteSaveTimer); _noteSaveTimer = setTimeout(flushNote, 800);
}
async function flushNote() {
  if (!_noteDirty || !_noteActive) return;
  const title = document.getElementById('noteTitle'), body = document.getElementById('noteBody');
  if (!title || !body) { _noteDirty = false; return; }
  _noteDirty = false;
  try {
    const n = await updateNote(_noteActive, { title: title.value, body: body.innerHTML });
    const i = _notes.findIndex(x => x.id === _noteActive);
    if (i >= 0) { _notes[i].title = n.title; _notes[i].updated = n.updated; _notes[i].snippet = (body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140); }
    renderNotesList();
    const st = document.getElementById('noteStatus'); if (st) st.textContent = 'saved';
  } catch (e) { const st = document.getElementById('noteStatus'); if (st) st.textContent = 'save failed'; }
}
async function removeNote(id) {
  if (!confirm('Delete this note? This cannot be undone.')) return;
  try { await deleteNote(id); } catch (e) {}
  if (_noteActive === id) { _noteActive = null; _noteDirty = false; }
  await refreshNotesList();
  const ed = document.getElementById('notesEditor'); if (ed) ed.innerHTML = noteEmptyHTML();
  const n2 = document.getElementById('noteNew2'); if (n2) n2.onclick = newNote;
  toast('Note deleted', 'trash');
}

/* ============================================================
   CODE APP — workspace file tree + editor + sandboxed run console
   ============================================================ */
let _codeFiles = [], _codeActive = null, _codeDirty = false, _codeSaveTimer = null;
let codeES = null, _codeRunId = null;

function codeHTML() {
  return `<div class="code-app">
    <div class="code-tree">
      <div class="code-tree-head">
        <span class="eyebrow">Workspace</span>
        <span class="ct-actions">
          <button class="ic-btn" id="codeNewFile" title="New file">${svg('newfile', 15)}</button>
          <button class="ic-btn" id="codeNewFolder" title="New folder">${svg('newfolder', 15)}</button>
        </span>
      </div>
      <div class="code-tree-body" id="codeTree"><div class="dim mono pad-sm">Loading…</div></div>
      <div class="code-note mono">Runs are sandboxed &amp; auto-stop on leave. Best-effort isolation — code can still reach the network.</div>
    </div>
    <div class="code-main">
      <div class="code-edbar">
        <span class="code-active mono" id="codeActiveName">— no file —</span>
        <span class="spacer"></span>
        <span class="code-runstat mono" id="codeRunStat"></span>
        <button class="btn primary sm" id="codeRunBtn">${svg('play', 14)} Run</button>
        <button class="btn ghost sm hidden" id="codeStopBtn">${svg('stop', 14)} Stop</button>
      </div>
      <div class="code-editor-wrap" id="codeEdWrap"><div class="code-empty mono">Create or open a file to start coding.</div></div>
      <div class="code-console">
        <div class="cc-head"><span class="eyebrow">${svg('terminal', 12)} Output</span><span class="spacer"></span><button class="ic-btn" id="codeClear" title="Clear output">${svg('trash', 13)}</button></div>
        <pre class="cc-out" id="codeOut"></pre>
      </div>
    </div>
  </div>`;
}
async function wireCode() {
  document.getElementById('codeNewFile').onclick = () => codeNew(false);
  document.getElementById('codeNewFolder').onclick = () => codeNew(true);
  document.getElementById('codeRunBtn').onclick = codeRun;
  document.getElementById('codeStopBtn').onclick = codeStopClick;
  document.getElementById('codeClear').onclick = () => { const o = document.getElementById('codeOut'); if (o) o.textContent = ''; };
  if (!(ACCOUNT && ACCOUNT.can_code)) {
    const rb = document.getElementById('codeRunBtn');
    rb.disabled = true; rb.classList.add('disabled'); rb.title = 'Ask an admin to enable code execution for your account';
  }
  _codeActive = null;
  _appCleanup = () => { flushCodeFile(); stopCodeRun({ leave: true }); };
  await refreshCodeTree();
}
async function refreshCodeTree(selectId) {
  try { _codeFiles = await codeFiles(); } catch (e) { if (e && e.code === 'AUTH') return relock(); _codeFiles = []; }
  if (!_codeFiles.length) {   // seed a friendly starter file the first time
    try { const f = await codeCreate({ name: 'main.py', content: 'print("Hello from Simplex Code!")\n' }); _codeFiles = [f]; } catch (e) {}
  }
  renderCodeTree();
  if (selectId) openCodeFile(selectId);
  else if (!_codeActive) { const first = _codeFiles.find(f => !f.is_dir); if (first) openCodeFile(first.id); }
}
function renderCodeTree() {
  const box = document.getElementById('codeTree'); if (!box) return;
  const kids = new Map();
  for (const f of _codeFiles) { const p = f.parent || 'root'; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(f); }
  const sortNodes = arr => arr.sort((a, b) => (b.is_dir ? 1 : 0) - (a.is_dir ? 1 : 0) || a.name.localeCompare(b.name));
  const level = (parent, depth) => sortNodes(kids.get(parent || 'root') || []).map(f => {
    const pad = `style="padding-left:${8 + depth * 14}px"`;
    if (f.is_dir) return `<div class="ct-node ct-dir" data-cid="${f.id}" ${pad}>${svg('folder', 14)}<span class="ct-name">${esc(f.name)}</span></div>` + level(f.id, depth + 1);
    return `<div class="ct-node ct-file ${f.id === _codeActive ? 'on' : ''}" data-cid="${f.id}" ${pad}>${svg('code', 14)}<span class="ct-name">${esc(f.name)}</span></div>`;
  }).join('');
  box.innerHTML = level(null, 0) || `<div class="dim mono pad-sm">Empty workspace.</div>`;
  box.querySelectorAll('.ct-file').forEach(n => n.onclick = () => openCodeFile(n.dataset.cid));
  box.querySelectorAll('.ct-node').forEach(n => n.oncontextmenu = (e) => { e.preventDefault(); codeNodeMenu(e, n.dataset.cid); });
}
function codeNodeMenu(e, id) {
  hideCtx();
  const f = _codeFiles.find(x => x.id === id); if (!f) return;
  const items = [{ ic: 'rename', label: 'Rename', fn: () => codeRename(id) }, { ic: 'trash', label: 'Delete', danger: true, fn: () => codeRemove(id) }];
  const menu = document.createElement('div'); menu.className = 'ctx'; ctxEl = menu;
  menu.innerHTML = items.map((it, i) => `<button data-ci="${i}" class="${it.danger ? 'danger' : ''}">${svg(it.ic, 15)} ${it.label}</button>`).join('');
  document.body.appendChild(menu);
  menu.style.left = Math.min(e.clientX, innerWidth - 180) + 'px';
  menu.style.top = Math.min(e.clientY, innerHeight - 90) + 'px';
  menu.querySelectorAll('[data-ci]').forEach(b => b.onclick = () => { hideCtx(); items[b.dataset.ci].fn(); });
}
async function codeNew(isDir) {
  const name = (prompt(isDir ? 'New folder name' : 'New file name (e.g. main.py, app.js)') || '').trim();
  if (!name) return;
  try { const f = await codeCreate({ name, is_dir: isDir, content: '' }); await refreshCodeTree(); if (!isDir) openCodeFile(f.id); }
  catch (e) { toast(e.message || 'Could not create', 'close'); }
}
async function codeRename(id) {
  const f = _codeFiles.find(x => x.id === id); if (!f) return;
  const name = (prompt('Rename', f.name) || '').trim();
  if (!name || name === f.name) return;
  try { await codeUpdate(id, { name }); await refreshCodeTree(); document.getElementById('codeActiveName') && (_codeActive === id) && (document.getElementById('codeActiveName').textContent = name); }
  catch (e) { toast(e.message || 'Rename failed', 'close'); }
}
async function codeRemove(id) {
  if (!confirm('Delete this item?')) return;
  try { await codeDelete(id); } catch (e) {}
  if (_codeActive === id) { _codeActive = null; const w = document.getElementById('codeEdWrap'); if (w) w.innerHTML = `<div class="code-empty mono">Create or open a file to start coding.</div>`; document.getElementById('codeActiveName').textContent = '— no file —'; }
  await refreshCodeTree();
}
async function openCodeFile(id) {
  await flushCodeFile();
  const f = _codeFiles.find(x => x.id === id);
  if (!f || f.is_dir) return;
  _codeActive = id; _codeDirty = false;
  renderCodeTree();
  document.getElementById('codeActiveName').textContent = f.name;
  const wrap = document.getElementById('codeEdWrap');
  wrap.innerHTML = `<div class="code-editor"><div class="gutter" id="codeGut"></div><textarea class="editor-area code-area" id="codeArea" spellcheck="false">${esc(f.content || '')}</textarea></div>`;
  const area = wrap.querySelector('#codeArea'), gut = wrap.querySelector('#codeGut');
  const syncGut = () => { const lines = area.value.split('\n').length; gut.innerHTML = Array.from({ length: lines }, (_, i) => `<span>${i + 1}</span>`).join(''); gut.scrollTop = area.scrollTop; };
  area.addEventListener('input', () => { markCodeDirty(); syncGut(); });
  area.addEventListener('scroll', () => gut.scrollTop = area.scrollTop);
  area.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); flushCodeFile(); toast('Saved'); }
    if (e.key === 'Tab') { e.preventDefault(); const s = area.selectionStart, en = area.selectionEnd; area.value = area.value.slice(0, s) + '  ' + area.value.slice(en); area.selectionStart = area.selectionEnd = s + 2; markCodeDirty(); syncGut(); }
  });
  syncGut();
}
function markCodeDirty() { _codeDirty = true; clearTimeout(_codeSaveTimer); _codeSaveTimer = setTimeout(flushCodeFile, 900); }
async function flushCodeFile() {
  if (!_codeDirty || !_codeActive) return;
  const area = document.getElementById('codeArea'); if (!area) { _codeDirty = false; return; }
  const content = area.value; _codeDirty = false;
  try { await codeUpdate(_codeActive, { content }); const f = _codeFiles.find(x => x.id === _codeActive); if (f) f.content = content; }
  catch (e) { toast('Save failed', 'close'); }
}
async function codeRun() {
  if (!(ACCOUNT && ACCOUNT.can_code)) { toast('Code execution is not enabled for your account', 'close'); return; }
  if (!_codeActive) { toast('Open a file to run', 'close'); return; }
  const f = _codeFiles.find(x => x.id === _codeActive);
  if (!f || f.is_dir) return;
  if (!/\.(py|js|mjs|cjs)$/i.test(f.name)) { toast('Only .py and .js files can run', 'close'); return; }
  await flushCodeFile();
  stopCodeRun();
  const out = document.getElementById('codeOut'); if (out) out.textContent = '';
  setCodeRunning(true);
  appendCodeOut(`▸ running ${f.name}\n`, 'sys');
  codeES = new EventSource('/api/code/run?entry=' + encodeURIComponent(f.id));
  codeES.addEventListener('start', e => { try { _codeRunId = JSON.parse(e.data).runId; } catch (x) {} });
  codeES.addEventListener('out', e => appendCodeOut(sseData(e.data)));
  codeES.addEventListener('err', e => appendCodeOut(sseData(e.data), 'err'));
  codeES.addEventListener('exit', e => {
    let d = {}; try { d = JSON.parse(e.data); } catch (x) {}
    appendCodeOut(`\n▸ finished${d.code != null ? ' · exit ' + d.code : ''}${d.reason ? ' · ' + d.reason : ''}\n`, 'sys');
    stopCodeRun();
  });
  codeES.onerror = () => { setCodeRunning(false); };
}
function sseData(data) { try { return JSON.parse(data); } catch (e) { return data; } }
function appendCodeOut(text, cls) {
  const out = document.getElementById('codeOut'); if (!out) return;
  const span = document.createElement('span'); if (cls) span.className = 'cc-' + cls; span.textContent = text;
  out.appendChild(span); out.scrollTop = out.scrollHeight;
}
function setCodeRunning(on) {
  const rb = document.getElementById('codeRunBtn'), sb = document.getElementById('codeStopBtn'), st = document.getElementById('codeRunStat');
  if (rb) rb.classList.toggle('hidden', on);
  if (sb) sb.classList.toggle('hidden', !on);
  if (st) st.textContent = on ? 'running…' : '';
}
function codeStopClick() { if (_codeRunId) codeStop(_codeRunId); stopCodeRun(); appendCodeOut('\n▸ stopped\n', 'sys'); }
function stopCodeRun(opts = {}) {
  if (codeES) { try { codeES.close(); } catch (e) {} codeES = null; }   // closing the stream makes the server kill the run
  if (opts.leave) { if (navigator.sendBeacon) { try { navigator.sendBeacon('/api/code/stopall'); } catch (e) { codeStopAll(); } } else codeStopAll(); }
  _codeRunId = null;
  setCodeRunning(false);
}
/* full page unload (reload / close tab): make sure no run is left behind */
window.addEventListener('pagehide', () => { if (codeES) { try { codeES.close(); } catch (e) {} if (navigator.sendBeacon) navigator.sendBeacon('/api/code/stopall'); } });

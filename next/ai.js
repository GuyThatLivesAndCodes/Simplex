/* ai.js — the AI app (#/ai). Chats are stored in the same format as the classic
   app, so they open in either interface:

     chat.messages = [{ role: 'meta', tuning, title? }, ...messages]
     message       = { role, content, tools?, artifacts?, alts?, alt?, rating?, toolResult?, memory? }
     alts[i]       = { content, tools?, artifacts?, toolResult?, after: [...messages] }

   Tools are always on (aitools.js). A turn is a loop: the model can say a line
   ("Let me look through that folder"), call tools, read the results, say more, call
   more — like Claude or ChatGPT — until it answers. Several calls in one reply run
   in parallel. The permission mode decides when the user is asked first. The user
   sees a compact activity line per tool, never the raw output. Memory is learned
   after each exchange (aimemory.js). */
import { html, raw, el, icon, esc, fmtSize, fmtDate, plural, api, lsGet, lsSet, animate, SPRING, $$, debounce } from './lib.js';
import * as store from './store.js';
import * as prefs from './prefs.js';
import { toast, menu, dialog, confirm, prompt, pushEsc, seg } from './ui.js';
import { md, wireCodeCopy, copyText } from './md.js';
import { editHistory, removeEditHistory, clearEditHistory, aiEditDialog, canAiEdit } from './jobs.js';
import { onTasks, addTask, cancelTask } from './tasks.js';
import { openClassic } from './classic.js';
import { TOOLS, MODES, needsApproval, describeCall, parseToolCalls, stripTools, liveProse, toolsPrompt } from './aitools.js';
import * as memory from './aimemory.js';

/* ---------------- state ----------------
   Each conversation's live state is a SESSION. A turn runs against its own session
   (as a task in the AI lane of the queue, a few at a time), so chats keep working
   while you read or type in another one, or leave the AI app. The A.* fields that
   belong to a conversation are views onto the session on screen (S). */
const DEFAULT_TUNING = { system: '', temperature: 0.7, top_k: 40, top_p: 0.95, min_p: 0.05, repeat_penalty: 1.1, max_tokens: 2048 };
const A = {
  ready: false, models: [], scope: lsGet('simplex.ai.scope') || 'online', model: null, chats: [], persona: {},
  artOpen: null, artTab: 'preview', artEditing: false, editIdx: -1,
  view: 'chat', side: 'chats', tuneOpen: false, thermal: null, thermalTimer: null, q: '', editSel: null, stick: true,
};
let seq = 0;
function makeSession(id = null) {
  return {
    key: 'tmp' + Date.now().toString(36) + (++seq), id, messages: [], tuning: { ...DEFAULT_TUNING }, title: null, temporary: false, chatAllow: false,
    artifacts: [], model: A.model, streaming: false, status: 'idle', abort: null, streamIdx: -1, load: null,
    approvals: new Map(),   // "msgIdx:toolIdx" -> resolve(decision)
    task: null, progress: null, unread: false,
  };
}
let S = makeSession();
const sessions = new Set([S]);   // the session on screen, plus any that are busy or hold an unseen reply
for (const k of ['messages', 'tuning', 'title', 'temporary', 'chatAllow', 'artifacts', 'streaming', 'abort', 'streamIdx', 'load']) Object.defineProperty(A, k, { get: () => S[k], set: v => { S[k] = v; } });
Object.defineProperty(A, 'active', { get: () => S.id, set: v => { S.id = v; } });
const busy = s => s.status !== 'idle';
const sessionFor = ref => [...sessions].find(s => (s.id && s.id === ref) || s.key === ref) || null;
const openSession = s => { location.hash = '#/ai/' + (s.id || s.key); };
let R = null;

const TRAITS = [
  { id: 'concise', label: 'Concise', text: 'Keep responses brief and to the point' },
  { id: 'detailed', label: 'Detailed', text: 'Give thorough, in-depth answers' },
  { id: 'friendly', label: 'Friendly', text: 'Use a warm, casual, conversational tone' },
  { id: 'formal', label: 'Formal', text: 'Use a professional, formal tone' },
  { id: 'direct', label: 'Direct', text: 'Skip preamble; get to the point' },
  { id: 'encouraging', label: 'Encouraging', text: 'Be encouraging and supportive' },
  { id: 'technical', label: 'Technical', text: 'Assume expertise; use precise terms' },
  { id: 'eli5', label: 'Explain simply', text: 'Explain as if to a beginner' },
];
const SLIDERS = [
  { k: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.01, dp: 2, help: 'Higher is more random. 0 is deterministic.' },
  { k: 'top_k', label: 'Top K', min: 0, max: 200, step: 1, dp: 0, help: 'Only the K most likely tokens are considered. 0 disables it.' },
  { k: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.01, dp: 2, help: 'Keeps the smallest set of tokens adding up to P.' },
  { k: 'min_p', label: 'Min P', min: 0, max: 1, step: 0.01, dp: 2, help: 'Drops tokens less likely than this share of the best one.' },
  { k: 'repeat_penalty', label: 'Repetition penalty', min: 0.5, max: 2, step: 0.01, dp: 2, help: 'Above 1 discourages the model from repeating itself.' },
  { k: 'max_tokens', label: 'Reply limit', min: 128, max: 8192, step: 64, dp: 0, help: 'The longest reply the model may produce, in tokens.' },
];
const TOOL_IC = { vault_overview: 'database', list_folder: 'folder', search_files: 'search', folder_tree: 'folder', file_info: 'info', read_file: 'eye', web_search: 'search', search_chats: 'chat', recent_chats: 'chat', recall: 'brain', remember: 'brain', forget: 'brain', create_file: 'plus', edit_file: 'pencil', create_folder: 'newfolder', rename: 'pencil', move: 'move', star: 'star', restore: 'restore', delete: 'trash', delete_forever: 'trash', create_artifact: 'window', update_artifact: 'window', list_files: 'folder', write_file: 'plus' };
const ISSUES = [['not-followed', 'Did not fully follow my request'], ['incorrect', 'Not factually correct'], ['refused', 'Refused when it shouldn’t have'], ['unsafe', 'Unsafe or inappropriate'], ['style', 'Wrong style, tone, or format'], ['slow', 'Too slow'], ['other', 'Something else']];
const NAMES = { 'grok-4.7': 'Grok 4.7', 'grok-4.3': 'Grok 4.3', 'grok-build-0.1': 'Grok Build 0.1' };
const modelName = m => !m ? 'Select a model' : (m.scope || 'online') === 'local' ? m.name : (NAMES[String(m.id).toLowerCase()] || m.name || m.id);
const modelSub = m => (m.scope || 'online') === 'local' ? `${m.size ? fmtSize(m.size) + ' · ' : ''}${m.source === 'user' ? 'from your files' : 'on the server'}` : (m.provider || 'online');
const inScope = s => A.models.filter(m => (m.scope || 'online') === s);
const byModel = id => A.models.find(m => m.id === id) || null;
const mode = () => (['auto', 'ask', 'allow'].includes(prefs.get('aiMode')) ? prefs.get('aiMode') : 'auto');
const promptLevel = () => (['none', 'minimal', 'full'].includes(prefs.get('aiPrompt')) ? prefs.get('aiPrompt') : 'full');
const MODE_IC = { auto: 'spark', ask: 'lock', allow: 'check' };

/* ---------------- entry ---------------- */
export async function renderAI(stage, route) {
  stage.innerHTML = '<div class="aiapp page-enter"><div class="ai-load"><span class="spin"></span></div></div>';
  R = stage.firstElementChild;
  const acct = store.S.account || {};
  if (!(acct.can_ai || acct.is_admin)) return notice('AI isn’t enabled for your account', 'Ask an administrator to turn on “Can use AI”.');
  if (!A.ready) {
    try { A.models = (await api('/api/ai/models')).models || []; } catch (e) { A.models = []; }
    try { const p = await api('/api/ai/persona'); A.persona = p.persona || {}; memory.load(p.memory || []); } catch (e) {}
    if (!inScope(A.scope).length) A.scope = inScope('online').length ? 'online' : 'local';
    const pref = inScope(A.scope).find(m => /grok-4\.7/i.test(m.id));
    A.model = (pref || inScope(A.scope)[0] || A.models[0] || {}).id || null;
    A.ready = true;
    // consolidate memory from recent chats at most once a day, quietly in the background
    if (A.persona.memoryEnabled !== false && prefs.get('aiAutoMemory')) memory.synthesize({ models: A.models, model: A.model }).then(n => { if (n) toast('Memory refreshed from your recent chats', { ic: 'brain' }); }).catch(() => {});
  }
  if (R !== stage.firstElementChild) return;
  if (!A.models.length) return notice('No AI providers are set up yet', acct.is_admin ? 'Providers are configured in the classic interface’s Settings.' : 'Ask an administrator to set them up.', acct.is_admin);
  await refreshChats();
  if (R !== stage.firstElementChild) return;
  const arg = route.arg;
  A.side = arg === 'edits' ? 'edits' : 'chats';
  A.view = arg === 'edits' ? 'edits' : arg === 'you' ? 'you' : 'chat';
  if (arg && !['edits', 'you'].includes(arg) && arg !== A.active && arg !== S.key) await openChat(arg, true);
  if (!arg && A.active) newChat();   // #/ai is a fresh chat (a running one carries on in the background)
  S.unread = false;
  frame();
  if (A.scope === 'local') startThermal();
}
export function leaveAI() { stopThermal(); R = null; }
function notice(title, sub, classicBtn) {
  R.innerHTML = html`<div class="ai-notice"><div class="ai-orb">${icon('spark', 30, 1.5)}</div><h2>${title}</h2><p>${sub}</p>${classicBtn ? html`<button class="b" data-c>${icon('swap', 15)} Open classic settings</button>` : ''}</div>`.s;
  const b = R.querySelector('[data-c]'); if (b) b.onclick = () => openClassic('/settings');
}

/* ---------------- frame ---------------- */
function frame() {
  R.innerHTML = html`<aside class="ai-side">
      <div class="seg ai-tabs" data-side><button data-v="chats">${icon('chat', 14)} Chats</button><button data-v="edits">${icon('image', 14)} Image edits</button></div>
      <div class="ai-side-body"></div>
    </aside>
    <section class="ai-main"></section>
    <div class="ai-scrim" data-closeside></div>`.s;
  paintSide(); paintMain();
  R.querySelector('[data-side]').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; location.hash = b.dataset.v === 'edits' ? '#/ai/edits' : (A.active ? '#/ai/' + A.active : '#/ai'); });
  R.querySelector('[data-closeside]').onclick = () => R.classList.remove('side-open');
}
const paintTabs = () => $$('[data-side] button', R).forEach(b => b.classList.toggle('on', b.dataset.v === A.side));

function paintSide() {
  if (!R) return;
  paintTabs();
  const body = R.querySelector('.ai-side-body');
  if (A.side === 'edits') return paintEditsList(body);
  const q = A.q.toLowerCase();
  const list = A.chats.filter(c => !q || (c.title || '').toLowerCase().includes(q));
  const now = new Date(), dayMs = 864e5, start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const grp = c => c.updated >= start ? 'Today' : c.updated >= start - dayMs ? 'Yesterday' : c.updated >= start - 6 * dayMs ? 'Previous 7 days' : 'Older';
  let last = null, rows = '';
  list.forEach(c => { const g = grp(c); if (g !== last) { rows += html`<div class="ai-g">${g}</div>`.s; last = g; } rows += html`<button class="ai-chat${c.id === A.active ? ' on' : ''}" data-chat="${c.id}"><span>${c.title || 'New chat'}</span><i class="ai-csw" data-cs="${c.id}">${raw(badge(c.id))}</i><small>${fmtDate(c.updated)}</small></button>`.s; });
  // temporary chats aren't saved, so they only appear here while they run (or hold an unseen reply)
  const temps = [...sessions].filter(x => !x.id && x !== S && (busy(x) || x.unread));
  if (temps.length) rows = html`<div class="ai-g">Temporary</div>`.s + temps.map(x => html`<button class="ai-chat" data-chat="${x.key}"><span>${titleOf(x)}</span><i class="ai-csw" data-cs="${x.key}">${raw(badge(x.key))}</i><small>${icon('clock', 11)}</small></button>`.s).join('') + rows;
  const n = memory.list().length;
  body.innerHTML = html`<div class="ai-side-head"><div class="ai-find">${icon('search', 15)}<input placeholder="Search chats" value="${A.q}" spellcheck="false"></div><button class="ib" data-new title="New chat" aria-label="New chat">${icon('plus', 18)}</button></div>
    <div class="ai-chats">${raw(rows || '<div class="ai-empty-list">No chats yet</div>')}</div>
    <button class="ai-you${A.view === 'you' ? ' on' : ''}" data-you>${icon('brain', 16)}<span>Memory & personalization</span>${n ? html`<small>${n}</small>` : ''}</button>`.s;
  const inp = body.querySelector('input');
  inp.addEventListener('input', debounce(() => { A.q = inp.value; const pos = inp.selectionStart; paintSide(); const nn = R.querySelector('.ai-find input'); nn.focus(); nn.setSelectionRange(pos, pos); }, 120));
  body.querySelector('[data-new]').onclick = () => { newChat(); A.view = 'chat'; if (location.hash === '#/ai') { paintSide(); paintMain(); } else location.hash = '#/ai'; };
  body.querySelector('[data-you]').onclick = () => { location.hash = '#/ai/you'; };
  body.querySelector('.ai-chats').addEventListener('click', e => { const b = e.target.closest('[data-chat]'); if (b) { R.classList.remove('side-open'); location.hash = '#/ai/' + b.dataset.chat; } });
  body.querySelector('.ai-chats').addEventListener('contextmenu', e => { const b = e.target.closest('[data-chat]'); if (!b) return; e.preventDefault(); chatMenu(b.dataset.chat, { x: e.clientX, y: e.clientY }); });
}
/* the little status mark beside a chat: working, waiting its turn, needs you, or a new reply */
function badge(ref) {
  const x = sessionFor(ref); if (!x || x === S && !busy(x)) return '';
  if (x.status === 'waiting') return html`<b class="ai-cs wait" title="Needs your OK">${icon('lock', 11)}</b>`.s;
  if (x.status === 'queued') return html`<b class="ai-cs queued" title="Waiting for a free slot">${icon('clock', 11)}</b>`.s;
  if (x.status === 'running') return '<b class="ai-cs run" title="Working"><span class="spin"></span></b>';
  return x.unread ? '<b class="ai-cs new" title="New reply"></b>' : '';
}
function paintBadges() {
  if (!R) return;
  const box = R.querySelector('.ai-chats'); if (!box || A.side !== 'chats') return;
  // a temporary chat that started or stopped needs the full list; otherwise just the marks
  const temps = [...sessions].filter(x => !x.id && x !== S && (busy(x) || x.unread)).length;
  if (temps !== box.querySelectorAll('[data-chat^="tmp"]').length) return paintSide();
  $$('[data-cs]', box).forEach(n => { n.innerHTML = badge(n.dataset.cs); });
}
function chatMenu(id, at) {
  if (!A.chats.find(x => x.id === id)) return;
  const live = sessionFor(id);
  menu([
    { label: 'Open', ic: 'chat', run: () => { location.hash = '#/ai/' + id; } },
    { label: 'Rename', ic: 'pencil', run: () => renameChat(id) },
    live && busy(live) && { label: 'Stop', ic: 'close', run: () => stopStream(live) },
    '-', { label: 'Delete chat', ic: 'trash', danger: true, run: () => deleteChat(id) },
  ].filter(Boolean), at);
}

/* ---------------- main panel ---------------- */
function paintMain() {
  if (!R) return;
  const main = R.querySelector('.ai-main');
  if (A.view === 'you') return paintMemoryPage(main);
  if (A.view === 'edits') return paintEditsMain(main);
  const cur = byModel(A.model);
  main.innerHTML = html`<header class="ai-bar">
      <button class="ib ai-sidebtn" data-sidebtn aria-label="Chats">${icon('chat', 18)}</button>
      <button class="ai-pickbtn" data-pick>${icon(A.scope === 'local' ? 'database' : 'spark', 15)}<span>${modelName(cur)}</span><small>${cur ? (A.scope === 'local' ? 'local' : cur.provider || '') : ''}</small>${icon('arrowdown', 13)}</button>
      ${A.scope === 'local' && cur ? html`<button class="ib" data-lab title="Open in Model Lab — raw inference, token stepper & compare (no system prompt)">${icon('brain', 17)}</button>` : ''}
      <span class="sp"></span>
      ${A.temporary ? html`<span class="ai-pill temp">${icon('clock', 13)} Temporary</span>` : ''}
      ${!A.messages.length || A.temporary ? html`<button class="ib${A.temporary ? ' on' : ''}" data-temp title="${A.temporary ? 'Turn off temporary chat' : 'Temporary chat — not saved, no memory'}">${icon('clock', 17)}</button>` : ''}
      <button class="ib" data-ctx title="Context usage">${icon('chart', 17)}</button>
      <button class="ib${A.tuneOpen ? ' on' : ''}" data-tune title="Conversation settings">${icon('settings', 17)}</button>
      ${A.active ? html`<button class="ib" data-chatmore title="Chat options">${icon('more', 17)}</button>` : ''}
    </header>
    <div class="ai-banner"></div>
    <div class="ai-body">
      <div class="ai-scroll"><div class="ai-thread"></div></div>
      <button class="ai-jump" hidden>${icon('arrowdown', 15)} Latest</button>
      <aside class="ai-tunep"${A.tuneOpen ? '' : ' hidden'}></aside>
      <aside class="ai-art"${A.artOpen ? '' : ' hidden'}></aside>
    </div>
    <footer class="ai-composer"><div class="ai-box">
      <textarea rows="1" placeholder="${cur ? 'Message ' + modelName(cur) + '…' : 'Pick a model to start'}" ${cur ? '' : 'disabled'}></textarea>
      <button class="ai-send" data-send aria-label="Send">${icon('arrowup', 18, 2.2)}</button>
      <button class="ai-stop" data-stop aria-label="Stop" hidden><i></i></button>
    </div><div class="ai-hint"><button class="ai-modebtn m-${mode()}" data-mode title="Permission mode">${icon(MODE_IC[mode()], 13)} ${MODES[mode()].label} ${icon('arrowdown', 11)}</button><span>Enter to send · Shift+Enter for a new line</span></div></footer>`.s;
  wireMain(main);
  paintThread(); paintBanner(); paintTune(); paintArt();
  setStreaming(S, S.streaming);
}
function wireMain(main) {
  const ta = main.querySelector('textarea');
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.keyCode === 13) && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  main.querySelector('[data-send]').onclick = send;
  main.querySelector('[data-stop]').onclick = () => stopStream(S);
  main.querySelector('[data-pick]').onclick = e => modelPicker(e.currentTarget);
  const lab = main.querySelector('[data-lab]');
  if (lab) lab.onclick = () => import('./modellab.js').then(m => m.openModelLab({ ids: A.model ? [A.model] : [], kind: 'chat' })).catch(() => toast('Model Lab failed to load', { bad: true }));
  main.querySelector('[data-sidebtn]').onclick = () => R.classList.toggle('side-open');
  main.querySelector('[data-ctx]').onclick = e => contextPopover(e.currentTarget);
  main.querySelector('[data-tune]').onclick = () => { A.tuneOpen = !A.tuneOpen; paintTune(); main.querySelector('[data-tune]').classList.toggle('on', A.tuneOpen); };
  main.querySelector('[data-mode]').onclick = e => modePicker(e.currentTarget);
  const tmp = main.querySelector('[data-temp]'); if (tmp) tmp.onclick = () => { A.temporary = !A.temporary; paintMain(); toast(A.temporary ? 'Temporary chat — it won’t be saved or used for memory' : 'Temporary chat off', { ic: 'clock' }); };
  const more = main.querySelector('[data-chatmore]'); if (more) more.onclick = e => chatMenu(A.active, e.currentTarget);
  const scroll = main.querySelector('.ai-scroll'), jump = main.querySelector('.ai-jump');
  scroll.addEventListener('scroll', () => {
    const atEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    if (!atEnd && performance.now() - autoAt < 400) { scrollEnd(); return; }   // our own scroll landing late
    A.stick = atEnd; jump.hidden = atEnd;
  });
  jump.onclick = () => { A.stick = true; scrollEnd(true); };
  wireThread(main.querySelector('.ai-thread'));
  setTimeout(() => ta.focus(), 50);
}
let autoAt = 0;
function scrollEnd(smooth) { const s = R && R.querySelector('.ai-scroll'); if (s && A.stick !== false) { autoAt = performance.now(); s.scrollTo({ top: s.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); } }
function setStreaming(s, on) {
  s.streaming = on;
  if (s !== S || !R) return;
  const sb = R.querySelector('[data-send]'), st = R.querySelector('[data-stop]'), ta = R.querySelector('.ai-composer textarea');
  if (sb) sb.hidden = on; if (st) st.hidden = !on; if (ta) ta.disabled = on || !A.model;
}

/* ---------------- thread ---------------- */
function paintThread() {
  const t = R && R.querySelector('.ai-thread'); if (!t) return;
  t.innerHTML = (A.messages.length ? A.messages.map(msgHTML).join('') : welcomeHTML())
    + (S.status === 'queued' ? html`<div class="ai-m bot ai-queued"><div class="ai-av">${icon('clock', 14, 2)}</div><div class="ai-col"><p class="ai-qn">Waiting for a free slot — ${plural([...sessions].filter(x => x.status === 'running' || x.status === 'waiting').length, 'other chat is', 'other chats are')} working. This starts on its own.</p></div></div>`.s : '');
  A.stick = true;
  if (A.messages.length || S.status === 'queued') scrollEnd();
  else { const sc = R.querySelector('.ai-scroll'); if (sc) sc.scrollTop = 0; }   // a fresh chat starts at its greeting, not scrolled past it
  tickLoad();
}
function welcomeHTML() {
  if (A.scope === 'local' && !inScope('local').length) return html`<div class="ai-welcome"><div class="ai-orb">${icon('database', 28, 1.5)}</div><h2>Local AI</h2><p>Run a language model entirely on this server — nothing leaves the box.</p>
    <div class="ai-cards"><div>${icon('upload', 16)}<b>Upload a model</b><span>Add a .gguf file to your files — it shows up here automatically.</span></div><div>${icon('database', 16)}<b>Server models</b><span>${store.S.account && store.S.account.is_admin ? 'Drop .gguf files into the server’s models/ folder.' : 'An admin can pre-load models for everyone.'}</span></div></div></div>`.s;
  const h = new Date().getHours();
  const greet = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const sug = [['Help me write', 'pencil'], ['Find something in my files', 'search'], ['Explain a concept', 'info'], ['Brainstorm ideas', 'spark'], ['Organize a folder', 'folder'], ['Debug some code', 'code']];
  return html`<div class="ai-welcome"><div class="ai-orb">${icon(A.temporary ? 'clock' : 'spark', 30, 1.5)}</div><h2>${A.temporary ? 'Temporary chat' : greet + (A.persona.name ? ', ' + A.persona.name : '') + '.'}</h2>
    <p>${A.temporary ? 'This chat won’t be saved, won’t use your memory, and won’t add to it.' : 'How can I help today?'}</p>
    <div class="ai-sugs">${sug.map(([s, ic]) => html`<button data-sug="${s}">${icon(ic, 15)}${s}</button>`)}</div></div>`.s;
}
const streamingProse = liveProse;
/* an assistant message that continues a turn after tool results (no new avatar) */
const isCont = i => { for (let k = i - 1; k >= 0; k--) { const p = A.messages[k]; if (p.role === 'meta') continue; return p.role === 'user' && !!p.toolResult; } return false; };
function msgHTML(m, i) {
  if (m.role === 'meta') return '';
  if (m.role === 'user') {
    if (m.toolResult) return '';
    if (A.editIdx === i) return html`<div class="ai-m me editing" data-mi="${i}"><div class="ai-edit"><textarea>${m.content}</textarea>
      <div class="ai-edit-a"><span class="dim">Saving makes a new branch — the original is kept.</span><button class="b sm" data-editcancel>Cancel</button><button class="b sm pri" data-editsave>Save & send</button></div></div></div>`.s;
    return html`<div class="ai-m me" data-mi="${i}"><div class="ai-bub">${m.content}</div>${actions(m, i)}</div>`.s;
  }
  const streaming = i === A.streamIdx;
  const prose = streaming ? streamingProse(m.content || '') : stripTools(m.content || '');
  const thinking = streaming && !prose.trim() && !(m.tools && m.tools.length);
  const inner = prose.trim() ? md(prose) : thinking ? (A.load ? loadHTML() : html`<span class="ai-think"><i></i><i></i><i></i></span>`.s) : '';
  const acts = activityHTML(m, i);
  const last = isLastOfTurn(i), cont = isCont(i);
  if (!inner && !acts && !m.memory) return '';
  // the order inside a step mirrors what the model did: what it said, then the tools it used
  return html`<div class="ai-m bot${cont ? ' cont' : ''}" data-mi="${i}"><div class="ai-av${streaming ? ' live' : ''}">${cont ? '' : icon('spark', 14, 2)}</div><div class="ai-col">
    ${inner ? raw(`<div class="ai-md">${inner}</div>`) : ''}${raw(acts)}
    ${m.artifacts && m.artifacts.length ? html`<div class="ai-arts">${m.artifacts.map(a => html`<button class="ai-artc" data-art="${a.id}">${icon('window', 16)}<span><b>${a.title}</b><small>${a.type}${a.language ? ' · ' + a.language : ''}</small></span><em>Open</em></button>`)}</div>` : ''}
    ${m.memory && m.memory.length ? html`<button class="ai-memnote" data-memnote>${icon('brain', 13)} Memory updated <span>${m.memory.map(x => (x.op === 'remove' ? 'Forgot: ' : '') + x.text).join(' · ')}</span></button>` : ''}
    ${streaming || !last || !prose.trim() ? '' : actions(m, i)}</div></div>`.s;
}
/* is message i the final assistant message of its turn (where the actions row belongs)? */
function isLastOfTurn(i) { for (let k = i + 1; k < A.messages.length; k++) { const n = A.messages[k]; if (n.role === 'user' && !n.toolResult) return true; if (n.role === 'assistant') return false; } return true; }

/* the black-box activity list: one line per tool, no output */
const lower = s => String(s || '').replace(/^[A-Z](?=[a-z])/, c => c.toLowerCase());
const upper = s => String(s || '').replace(/^./, c => c.toUpperCase());
const toolLabel = t => { if (t.summary) return t.summary; try { if (TOOLS[t.name]) return TOOLS[t.name].label(t.args || {}); } catch (e) {} return t.name === '_bad_json' ? 'Malformed tool call' : 'Used ' + String(t.name || 'a tool').replace(/_/g, ' '); };
function lineText(t) {
  const label = toolLabel(t), st = t.status || 'done';
  return st === 'running' ? label + '…' : st === 'error' ? label + ' — ' + (t.err || 'failed') : st === 'denied' ? 'Not allowed: ' + lower(label) : upper(label);
}
function activityHTML(m, i) {
  const tools = m.tools || [];
  if (!tools.length) return '';
  const live = tools.some(t => t.status === 'running' || t.status === 'pending');
  const lines = tools.map((t, k) => {
    const label = toolLabel(t);
    const st = t.status || 'done';
    if (st === 'pending') return html`<div class="ai-act pending"><span class="ai-ai">${icon('lock', 13)}</span><div class="ai-ask"><b>${upper(t.ask || label)}</b><span>Allow this?</span>
      <div class="ai-ask-a"><button class="b sm pri" data-approve="${i}:${k}" data-d="once">Allow</button><button class="b sm" data-approve="${i}:${k}" data-d="chat">Allow for this chat</button><button class="b sm flat" data-approve="${i}:${k}" data-d="deny">Deny</button></div></div></div>`;
    const text = lineText(t);
    return html`<div class="ai-act ${st}"><span class="ai-ai">${st === 'running' ? raw('<i class="spin"></i>') : icon(st === 'error' ? 'info' : TOOL_IC[t.name] || 'wrench', 13)}</span><span class="ai-al">${text}</span>${st === 'done' ? icon('check', 12, 2.4) : ''}</div>`;
  });
  if (live) return html`<div class="ai-acts-live">${lines}</div>`.s;
  const denied = tools.filter(t => t.status === 'denied').length;
  const head = tools.length === 1 ? lineText(tools[0]) : 'Used ' + plural(tools.length - denied, 'tool') + (denied ? ` · ${denied} not allowed` : '');
  return html`<details class="ai-acts-done"><summary>${icon(tools.length === 1 ? TOOL_IC[tools[0].name] || 'wrench' : 'wrench', 13)}<span>${head}</span>${icon('chevron', 12)}</summary><div>${lines}</div></details>`.s;
}
function actions(m, i) {
  const n = Array.isArray(m.alts) ? m.alts.length : 1, at = (m.alt || 0) + 1;
  const nav = n > 1 ? html`<span class="ai-branch"><button data-alt="${i}" data-dir="-1" ${at <= 1 ? 'disabled' : ''} aria-label="Previous version">${icon('back', 13)}</button><span>${at}/${n}</span><button data-alt="${i}" data-dir="1" ${at >= n ? 'disabled' : ''} aria-label="Next version">${icon('chevron', 13)}</button></span>` : '';
  const copy = html`<button data-copy="${i}" title="Copy">${icon('file', 14)}</button>`;
  if (m.role === 'user') return html`<div class="ai-acts">${nav}${copy}<button data-edit="${i}" title="Edit — makes a new branch">${icon('pencil', 14)}</button></div>`;
  const first = firstOfTurn(i), fm = A.messages[first];
  const fn = Array.isArray(fm.alts) ? fm.alts.length : 1, fat = (fm.alt || 0) + 1;
  const tnav = fn > 1 ? html`<span class="ai-branch"><button data-alt="${first}" data-dir="-1" ${fat <= 1 ? 'disabled' : ''} aria-label="Previous version">${icon('back', 13)}</button><span>${fat}/${fn}</span><button data-alt="${first}" data-dir="1" ${fat >= fn ? 'disabled' : ''} aria-label="Next version">${icon('chevron', 13)}</button></span>` : '';
  return html`<div class="ai-acts">${tnav}${copy}<button data-regen="${i}" title="Regenerate — makes a new branch">${icon('restore', 14)}</button>
    <button class="${m.rating === 'up' ? 'on' : ''}" data-rate="up" data-mi="${i}" title="Good response">${icon('check', 14)}</button>
    <button class="${m.rating === 'down' ? 'on bad' : ''}" data-rate="down" data-mi="${i}" title="Bad response">${icon('close', 14)}</button></div>`;
}
function wireThread(t) {
  wireCodeCopy(t);
  t.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.approve) { const fn = S.approvals.get(b.dataset.approve); if (fn) fn(b.dataset.d); return; }
    if (b.dataset.sug) { const ta = R.querySelector('.ai-composer textarea'); ta.value = b.dataset.sug + ' '; ta.focus(); ta.dispatchEvent(new Event('input')); return; }
    if (b.hasAttribute('data-memnote')) { location.hash = '#/ai/you'; return; }
    if (b.dataset.alt != null) return switchVariant(+b.dataset.alt, +b.dataset.dir);
    if (b.dataset.copy != null) { const m = A.messages[+b.dataset.copy]; copyText(m.role === 'assistant' ? turnText(+b.dataset.copy) : m.content).then(() => toast('Copied', { ic: 'check' })); return; }
    if (b.dataset.edit != null) { if (A.streaming) return toast('Wait for the reply to finish', { bad: true }); A.editIdx = +b.dataset.edit; paintThread(); const ta = t.querySelector('.ai-edit textarea'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); ta.style.height = Math.min(ta.scrollHeight, 260) + 'px'; } return; }
    if (b.hasAttribute('data-editcancel')) { A.editIdx = -1; return paintThread(); }
    if (b.hasAttribute('data-editsave')) return saveEdit();
    if (b.dataset.regen != null) return regenerate(firstOfTurn(+b.dataset.regen));
    if (b.dataset.rate) return rate(+b.dataset.mi, b.dataset.rate);
    if (b.dataset.art) { A.artOpen = b.dataset.art; A.artEditing = false; return paintArt(); }
  });
  t.addEventListener('keydown', e => {
    if (!e.target.closest('.ai-edit')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); A.editIdx = -1; paintThread(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
  });
  t.addEventListener('contextmenu', e => {
    const m = e.target.closest('[data-mi]'); if (!m || window.getSelection().toString()) return;
    e.preventDefault();
    const i = +m.dataset.mi, msg = A.messages[i];
    menu([
      { label: 'Copy', ic: 'file', run: () => copyText(msg.role === 'assistant' ? turnText(i) : msg.content).then(() => toast('Copied', { ic: 'check' })) },
      msg.role === 'user' ? { label: 'Edit (new branch)', ic: 'pencil', run: () => { const eb = t.querySelector(`[data-edit="${i}"]`); eb && eb.click(); } } : { label: 'Regenerate (new branch)', ic: 'restore', run: () => regenerate(firstOfTurn(i)) },
      msg.role === 'assistant' && { label: 'Save reply to Files', ic: 'download', run: () => saveReply(turnText(i)) },
    ].filter(Boolean), { x: e.clientX, y: e.clientY });
  });
}
/* a turn can span several assistant messages (tool rounds): find its first, and its full text */
function firstOfTurn(i, msgs = A.messages) { let k = i; while (k > 0 && !(msgs[k - 1].role === 'user' && !msgs[k - 1].toolResult)) k--; return msgs[k] && msgs[k].role === 'assistant' ? k : i; }
function turnText(i, msgs = A.messages) { const s = firstOfTurn(i, msgs); const out = []; for (let k = s; k < msgs.length; k++) { const m = msgs[k]; if (m.role === 'user' && !m.toolResult) break; if (m.role === 'assistant') out.push(stripTools(m.content)); } return out.filter(Boolean).join('\n\n'); }
function paintMsg(i, s = S) {
  if (!R || s !== S) return;   // a chat working in the background repaints when you open it
  const t = R.querySelector('.ai-thread'); if (!t) return;
  const cur = t.querySelector(`.ai-m[data-mi="${i}"]`);
  const html2 = msgHTML(A.messages[i], i);
  if (!cur) { if (html2) paintThread(); return; }
  if (!html2) { cur.remove(); return; }
  const open = cur.querySelector('details[open]');
  const n = el(html2); if (open) { const d = n.querySelector('details'); d && (d.open = true); }
  cur.replaceWith(n); scrollEnd(); tickLoad();
}

/* ---------------- model loading progress ---------------- */
/* The local engine only reports stages (resolving → starting → ready), so the bar is
   an estimate: it remembers how long each model took last time and eases toward
   ~96% until the model reports ready. */
function loadEstimate(id) {
  const seen = Number(lsGet('nx.aiload.' + id, '0'));
  if (seen) return seen;
  const m = byModel(id); return 2500 + ((m && m.size) || 400e6) / 160e6 * 1000;
}
function loadHTML() {
  const L = A.load, t = performance.now() - L.start;
  const p = L.done ? 1 : Math.min(0.96, 1 - Math.exp(-2.6 * t / L.est));
  const eta = Math.max(0, Math.round((L.est - t) / 1000));
  return html`<div class="ai-loadbox"><div class="ai-loadh"><span>${icon('database', 13)} ${L.label}</span><b>${Math.round(p * 100)}%</b></div><div class="ai-loadbar"><i style="width:${(p * 100).toFixed(1)}%"></i></div><small>${L.done ? 'Ready' : eta > 0 ? `About ${eta}s left · ${L.name}` : `Almost there · ${L.name}`}</small></div>`.s;
}
let loadTimer = 0;
function tickLoad() {
  if (!A.load || loadTimer) return;
  const step = () => {
    loadTimer = 0;
    if (!A.load || !R) return;
    const box = R.querySelector('.ai-loadbox');
    if (box) {   // update in place so the bar glides instead of being rebuilt
      const n = el(loadHTML());
      box.querySelector('.ai-loadbar i').style.width = n.querySelector('.ai-loadbar i').style.width;
      box.querySelector('.ai-loadh').innerHTML = n.querySelector('.ai-loadh').innerHTML;
      box.querySelector('small').textContent = n.querySelector('small').textContent;
    }
    if (!A.load.done) loadTimer = setTimeout(step, 150);
  };
  loadTimer = setTimeout(step, 150);
}
function onStage(s, stage) {
  const m = byModel(s.model);
  if (stage === 'resolving' || stage === 'starting' || stage === 'loading') {
    if (!s.load) s.load = { start: performance.now(), est: loadEstimate(s.model), name: m ? modelName(m) : 'model', label: 'Preparing model' };
    s.load.label = stage === 'resolving' ? 'Preparing model' : 'Loading model into memory';
    setStatus(s, 'running', s.load.label);
    if (s.streamIdx >= 0) paintMsg(s.streamIdx, s);
  } else if (stage === 'ready') finishLoad(s);
}
function finishLoad(s) {
  if (!s.load || s.load.done) return;
  s.load.done = true;
  lsSet('nx.aiload.' + s.model, String(Math.round(performance.now() - s.load.start)));
  const box = s === S && R && R.querySelector('.ai-loadbox'); if (box) box.replaceWith(el(loadHTML()));
  setTimeout(() => { s.load = null; if (s.streamIdx >= 0) paintMsg(s.streamIdx, s); }, 450);
}

/* ---------------- branching (same model as classic) ---------------- */
const variantOf = m => ({ content: m.content, tools: m.tools, artifacts: m.artifacts, toolResult: m.toolResult, after: [] });
function ensureAlts(m) { if (!Array.isArray(m.alts) || !m.alts.length) { m.alts = [variantOf(m)]; m.alt = 0; } return m; }
function stashTail(i) {
  const m = A.messages[i]; if (!m || !Array.isArray(m.alts)) return;
  const cur = m.alts[m.alt] || m.alts[0];
  cur.content = m.content; cur.tools = m.tools; cur.artifacts = m.artifacts;
  cur.after = A.messages.slice(i + 1); A.messages.length = i + 1;
}
function addVariant(i, content) {
  const m = A.messages[i]; if (!m) return;
  ensureAlts(m); stashTail(i);
  m.alts.push({ content, tools: undefined, artifacts: undefined, toolResult: m.toolResult, after: [] });
  m.alt = m.alts.length - 1; m.content = content; m.tools = undefined; m.artifacts = undefined;
}
function switchVariant(i, dir) {
  const m = A.messages[i]; if (!m || !Array.isArray(m.alts)) return;
  const next = m.alt + dir; if (next < 0 || next >= m.alts.length) return;
  if (A.streaming) stopStream();
  stashTail(i); m.alt = next;
  const v = m.alts[next]; m.content = v.content; m.tools = v.tools; m.artifacts = v.artifacts;
  for (const x of v.after) A.messages.push(x);
  rebuildArtifacts(); paintThread(); persist();
}
function rebuildArtifacts(s = S) {
  s.artifacts = [];
  s.messages.forEach(m => { if (Array.isArray(m.artifacts)) m.artifacts.forEach(a => { if (a && a.content != null) s.artifacts.push(a); }); });
  if (s !== S) return;
  if (A.artOpen && !A.artifacts.find(a => a.id === A.artOpen)) A.artOpen = null;
  paintArt();
}

/* ---------------- sending + the agent loop ---------------- */
const MAX_STEPS = 14;
async function send() {
  const s = S;
  if (s.streaming || !R) return;
  const ta = R.querySelector('.ai-composer textarea');
  const text = (ta.value || '').trim(); if (!text) return;
  if (!A.model) return toast('Pick a model first', { bad: true });
  ta.value = ''; ta.style.height = 'auto';
  A.editIdx = -1; s.model = A.model;
  s.messages.push({ role: 'user', content: text });
  if (s.messages.length === 1) { const b = R.querySelector('[data-temp]'); if (b && !s.temporary) b.remove(); }
  paintThread();
  if (!s.temporary && !s.id) await persist(s);   // saved straight away, so it shows in the list while it works
  await answer(s);
}
/* status shown in the sidebar and the Activity panel */
function setStatus(s, status, detail) {
  const was = s.status;
  s.status = status;
  if (detail && s.progress) s.progress(null, detail);
  if (status === 'waiting' && was !== 'waiting' && (s !== S || !R)) toast(`“${titleOf(s)}” needs your OK`, { ic: 'lock', action: 'View', onAction: () => openSession(s), ms: 6000 });
  if (was !== status) paintBadges();
  if (s === S && (was === 'queued') !== (status === 'queued')) paintThread();   // the "waiting for a slot" note
}
/* queue a turn for session s; resolves when it has finished, failed or been stopped */
async function answer(s, slot, slotIdx) {
  s.abort = new AbortController(); s.model = s.model || A.model;
  sessions.add(s); setStreaming(s, true); setStatus(s, 'queued');
  const from = s.messages.length;
  let state = 'done';
  await new Promise(resolve => {
    const t = s.task = addTask({
      kind: 'ai', title: titleOf(s), sub: modelName(byModel(s.model)), tint: 't-app',
      open: () => openSession(s),
      run: async (task, { signal, progress }) => {
        if (s.abort.signal.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
        signal.addEventListener('abort', () => { try { s.abort.abort(); } catch (e) {} });
        s.progress = progress; setStatus(s, 'running', 'Thinking…');
        await runTurn(s);
        task.doneText = 'Replied';
      },
    });
    const off = onTasks(() => { if (!['queued', 'running'].includes(t.state)) { off(); state = t.state; resolve(); } });
  });
  s.task = null; s.progress = null; s.streamIdx = -1; s.load = null; s.abort = null;
  s.approvals.forEach(fn => fn('deny')); s.approvals.clear();
  setStreaming(s, false); setStatus(s, 'idle');
  if (slot) {   // regenerate: the first new message becomes the slot's new variant
    const produced = s.messages.splice(from, s.messages.length - from);
    const first = produced.shift() || { role: 'assistant', content: '' };
    slot.content = first.content; slot.tools = first.tools; slot.artifacts = first.artifacts;
    slot.alts[slot.alt] = { content: first.content, tools: first.tools, artifacts: first.artifacts, after: [] };
    s.messages.splice(slotIdx, 0, slot);
    for (const p of produced) s.messages.push(p);
  }
  rebuildArtifacts(s); if (s === S) paintThread(); await persist(s);
  if (state === 'done' && (s !== S || !R)) {   // finished out of sight: mark it and say so
    s.unread = true; paintBadges();
    toast(`Reply ready — “${titleOf(s)}”`, { ic: 'chat', action: 'View', onAction: () => openSession(s), ms: 6000 });
  }
  learnFromTurn(s);
}
/* after a turn: let memory learn from it (never in temporary chats) */
async function learnFromTurn(s) {
  if (s.temporary || A.persona.memoryEnabled === false || !prefs.get('aiAutoMemory')) return;
  let u = -1; for (let k = s.messages.length - 1; k >= 0; k--) { const m = s.messages[k]; if (m.role === 'user' && !m.toolResult) { u = k; break; } }
  const lastAi = s.messages.length - 1;
  if (u < 0 || !s.messages[lastAi] || s.messages[lastAi].role !== 'assistant') return;
  const msg = s.messages[lastAi];
  const changes = await memory.learn({ models: A.models, model: s.model, user: s.messages[u].content, reply: turnText(lastAi, s.messages) });
  if (!changes.length || s.streaming) return;
  msg.memory = changes;
  if (s.messages[lastAi] === msg) paintMsg(lastAi, s);
  persist(s);
}
async function runTurn(s) {
  const history = prefs.get('aiHistory') && !s.temporary;
  const memOn = A.persona.memoryEnabled !== false && !s.temporary;
  const level = promptLevel();
  const sys = [toolsPrompt({ mode: mode(), history, memoryOn: memOn, level }), (s.tuning.system || '').trim()].filter(Boolean).join('\n\n');
  const repaint = () => { if (s === S) paintThread(); };
  let nudged = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    const idx = s.messages.push({ role: 'assistant', content: '' }) - 1;
    s.streamIdx = idx; repaint();
    if (step) setStatus(s, 'running', 'Thinking…');
    let acc = '', err = null;
    try {
      await streamChat({
        model: s.model, system: sys, promptLevel: level, tuning: tuningPayload(s), signal: s.abort.signal, memory: !s.temporary,
        messages: s.messages.slice(0, idx).filter(m => m.role !== 'meta').map(m => ({ role: m.role, content: m.content || '' })),
        onStage: st => onStage(s, st),
        onText: t => { if (s.load) finishLoad(s); if (!acc) setStatus(s, 'running', 'Writing…'); acc += t; s.messages[idx].content = acc; updateStream(idx, s); },
        onError: msg => { err = msg; },
      });
    } catch (e) {
      if (e.name === 'AbortError') { s.messages[idx].content = stripTools(acc) || '_(stopped)_'; return; }
      err = e.message || 'request failed';
    }
    if (err) { s.messages[idx].content = (stripTools(acc) ? stripTools(acc) + '\n\n' : '') + '⚠️ ' + err; return; }
    const calls = parseToolCalls(acc);
    if (!calls.length) {
      s.streamIdx = -1;
      // the model announced an action ("Scanning the vault.") but sent no tool call —
      // nudge it once, quietly, instead of leaving the user with a promise and nothing done
      if (!nudged && announces(acc)) {
        nudged = true; paintMsg(idx, s);
        s.messages.push({ role: 'user', content: 'TOOL_RESULTS\n(No tool ran: your last reply said you would do something but contained no tool_use block. Make the tool call(s) now using the exact ```tool_use format — or, if no tool is actually needed, just answer.)', toolResult: true });
        continue;
      }
      if (!acc.trim()) s.messages[idx].content = '_(no response)_';
      paintMsg(idx, s); return;
    }
    s.streamIdx = -1;
    setStatus(s, 'running', calls.length === 1 ? 'Using a tool' : `Using ${calls.length} tools`);
    const results = await runTools(s, idx, calls);
    if (!s.abort || s.abort.signal.aborted) return;
    const left = MAX_STEPS - step - 1;
    s.messages.push({ role: 'user', content: 'TOOL_RESULTS\n' + results.join('\n\n') + (left <= 2 ? `\n\n(${left} tool round${left === 1 ? '' : 's'} left in this turn — wrap up soon.)` : ''), toolResult: true });
  }
  s.messages.push({ role: 'assistant', content: '_I hit the limit of steps for one reply. Say “continue” and I’ll pick up where I left off._' });
}
/* a short reply that promises an action and stops ("I'll check your files.", "Scanning the vault.") */
function announces(text) {
  const t = stripTools(text).trim();
  if (!t || t.length > 400 || /\?\s*$/.test(t)) return false;
  const last = t.split(/\n+/).pop();
  return /\b(I'?ll|I will|let me|I'?m going to|going to|one (sec|moment)|give me a (sec|moment)|on it)\b/i.test(last)
    || /^(scanning|checking|searching|looking|reading|listing|opening|going through|pulling up|fetching|running|renaming|moving|deleting|creating|editing|organi[sz]ing)\b/i.test(last.trim());
}
/* one tool's output as the model sees it: big enough for real work, small enough
   that a long run of steps stays well under the server's request limit. The model
   is told when it was cut, so it can page or narrow the next call. */
const RESULT_CAP = 60000;
const capResult = t => (t.length <= RESULT_CAP ? t : t.slice(0, RESULT_CAP) + `\n[TRUNCATED: ${(t.length - RESULT_CAP).toLocaleString()} more characters — narrow the request (filters, offset, a smaller limit) to see the rest]`);
/* run one reply's tool calls: reads at once, changes one after another (each waiting
   for approval when the mode says so) — both lanes run side by side */
async function runTools(s, idx, calls) {
  const m = s.messages[idx];
  m.tools = calls.map(c => ({ name: c.tool, args: c.args, status: 'running' }));
  paintMsg(idx, s);
  const ctx = {
    chatId: s.id, signal: s.abort.signal,
    memory: { list: () => memory.list().map(x => ({ id: x.id, text: x.text })), add: memory.add, remove: memory.remove },
    artifacts: { create: a => createArtifact(a, idx, s), update: a => updateArtifact(a, s) },
  };
  const results = new Array(calls.length);
  let waiting = 0;
  const runOne = async (c, k) => {
    const rec = m.tools[k];
    const tool = TOOLS[c.tool];
    const fail = (err, text) => { rec.status = 'error'; rec.err = err; results[k] = `[${c.tool}] Error: ${text}`; paintMsg(idx, s); };
    if (c.tool === '_bad_json') return fail('malformed call', 'that tool_use block was not valid JSON. Use {"tool": "name", "args": {...}}.');
    if (!tool) return fail('unknown tool', `unknown tool "${c.tool}". Available: ${Object.keys(TOOLS).join(', ')}`);
    if (tool.history && (!prefs.get('aiHistory') || s.temporary)) return fail('chat history is off', 'the user has turned off access to past chats.');
    if (needsApproval(c, mode(), s.chatAllow)) {
      rec.status = 'pending'; rec.ask = describeCall(c); paintMsg(idx, s);
      waiting++; setStatus(s, 'waiting', 'Waiting for your OK');
      const d = await new Promise(res => s.approvals.set(`${idx}:${k}`, res));
      s.approvals.delete(`${idx}:${k}`);
      if (--waiting === 0 && s.abort && !s.abort.signal.aborted) setStatus(s, 'running', 'Using tools');
      if (d === 'chat') s.chatAllow = true;
      delete rec.ask;
      if (d === 'deny' || !s.abort || s.abort.signal.aborted) { rec.status = 'denied'; results[k] = `[${c.tool}] The user DENIED this action. Don't retry it; continue without it or ask them what they'd like.`; paintMsg(idx, s); return; }
      rec.status = 'running'; paintMsg(idx, s);
    }
    try {
      const out = await tool.run(c.args || {}, ctx);
      rec.status = 'done'; rec.summary = out.summary;
      results[k] = `[${c.tool}] ${capResult(String(out.text))}`;
      paintMsg(idx, s);
    } catch (e) { fail(String(e.message || 'failed').split('\n')[0].split(' — ')[0].slice(0, 120), e.message || 'failed'); }   // the user sees the gist; the model gets the full hint
  };
  let chain = Promise.resolve();
  await Promise.all(calls.map((c, k) => {
    const kind = TOOLS[c.tool] ? TOOLS[c.tool].kind : 'read';
    if (kind === 'read' || kind === 'ui') return runOne(c, k);
    chain = chain.then(() => runOne(c, k));
    return chain;
  }));
  m.tools.forEach(t => { if (!t.summary) t.summary = toolLabel(t); delete t.args; });   // the stored chat keeps the summary lines, not the raw arguments
  return results;
}
/* Tokens arrive far faster than anyone reads. Re-rendering the whole reply's
   markdown for each one is O(n²) over a long answer and pins a laptop CPU, so the
   text is drawn at most every ~70ms (~150ms with light effects) — the stream
   still flows, just in small batches. The last batch always lands (flush). */
let streamTimer = 0, streamLast = 0, streamArgs = null;
function updateStream(i, s = S) {
  if (!R || s !== S) return;
  streamArgs = [i, s];
  if (streamTimer) return;
  const gap = document.documentElement.hasAttribute('data-lite') ? 150 : 70;
  const wait = Math.max(0, gap - (performance.now() - streamLast));
  streamTimer = setTimeout(() => requestAnimationFrame(drawStream), wait);
}
function drawStream() {
  streamTimer = 0; streamLast = performance.now();
  const [i, s] = streamArgs || []; streamArgs = null;
  if (!R || s !== S || !A.messages[i]) return;
  const box = R.querySelector(`.ai-m[data-mi="${i}"] .ai-md`);
  const p = streamingProse(A.messages[i].content || '').trim();
  if (!box || !p) return paintMsg(i);
  box.innerHTML = md(p); scrollEnd();
}
function stopStream(s = S) {
  if (s.abort) { try { s.abort.abort(); } catch (e) {} }
  if (s.task) cancelTask(s.task.id);   // also drops it from the queue if it hadn't started
  s.approvals.forEach(fn => fn('deny')); s.approvals.clear();
  s.streamIdx = -1; s.load = null;
}
async function streamChat({ model, messages, system, promptLevel: level, tuning, signal, onText, onError, onStage: stageFn, memory: useMemory }) {
  const res = await fetch('/api/ai/chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, system, promptLevel: level, memory: useMemory, ...(tuning || {}) }), signal });
  if (!res.ok) { let msg = 'request failed'; try { msg = (await res.json()).error || msg; } catch (e) {} throw new Error(msg); }
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const line of lines) {
      const d = line.replace(/^data: ?/, '').trim(); if (!d || d.startsWith(':')) continue;
      let o; try { o = JSON.parse(d); } catch (e) { continue; }
      if (o.type === 'text' && o.text) onText(o.text);
      else if (o.type === 'stage') stageFn && stageFn(o.stage);
      else if (o.type === 'error') onError(o.error);
    }
  }
}
const tuningPayload = s => { const { temperature, top_k, top_p, min_p, repeat_penalty, max_tokens } = s.tuning; return { temperature, top_k, top_p, min_p, repeat_penalty, max_tokens }; };

async function saveEdit() {
  const ta = R.querySelector('.ai-edit textarea'); if (!ta) return;
  const i = A.editIdx, text = ta.value.trim(), m = A.messages[i];
  if (!m) { A.editIdx = -1; return paintThread(); }
  if (!text) return toast('A message can’t be empty', { bad: true });
  A.editIdx = -1;
  if (text === m.content) return paintThread();
  addVariant(i, text); rebuildArtifacts(); paintThread();
  S.model = A.model;
  await answer(S);
}
async function regenerate(i) {
  if (A.streaming) return toast('Already working', { bad: true });
  const m = A.messages[i]; if (!m || m.role !== 'assistant') return;
  if (!A.model) return toast('Pick a model first', { bad: true });
  ensureAlts(m); stashTail(i);
  m.alts.push({ content: '', tools: undefined, artifacts: undefined, after: [] }); m.alt = m.alts.length - 1;
  const keep = A.messages.splice(i, 1)[0];
  S.model = A.model;
  await answer(S, keep, i);
}
function rate(i, rating) {
  const m = A.messages[i]; if (!m || m.role !== 'assistant' || m.rating === rating) return;
  const up = rating === 'up';
  dialog({
    ic: up ? 'check' : 'info', title: up ? 'What was good about this reply?' : 'What went wrong?',
    body: html`${up ? '' : html`<div class="cv-g"><span class="eyebrow">Type of issue</span><select class="in" data-issue>${ISSUES.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></div>`}
      <div class="cv-g"><span class="eyebrow">Details (optional)</span><textarea class="in" rows="4" placeholder="${up ? 'What was satisfying about this response?' : 'What was unsatisfying about this response?'}"></textarea></div>
      <p class="dim" style="font-size:12.5px">Sending shares this conversation with the maintainers so the model can be improved. An administrator reviews every report.</p>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Send feedback', kind: 'pri', run: async (_c, r) => {
        let promptText = ''; for (let k = i - 1; k >= 0; k--) { const p = A.messages[k]; if (p.role === 'user' && !p.toolResult) { promptText = p.content || ''; break; } }
        try {
          await api('/api/ai/feedback', { method: 'POST', json: { rating, issue: r.querySelector('[data-issue]') ? r.querySelector('[data-issue]').value : null, comment: r.querySelector('textarea').value, model: A.model, chatId: A.active, prompt: promptText, excerpt: turnText(i) } });
          m.rating = rating; paintMsg(i); persist(); toast('Thanks — sent to the maintainers', { ic: 'check' });
        } catch (e) { toast(e.message, { bad: true }); return false; }
      },
    }],
  });
}
async function saveReply(text) {
  const name = await prompt({ title: 'Save reply to Files', value: 'AI reply.md', ok: 'Save', select: 'base' });
  if (!name) return;
  try { const rec = await api('/api/files/doc', { method: 'POST', json: { name, content: text, parent: null } }); store.added(rec); toast('Saved “' + rec.name + '”', { ic: 'check' }); }
  catch (e) { toast(e.message, { bad: true }); }
}

/* ---------------- persistence ---------------- */
function titleOf(s = S) { const u = s.messages.find(m => m.role === 'user' && !m.toolResult); return s.title || (u ? u.content.slice(0, 60) : s.temporary ? 'Temporary chat' : 'New chat'); }
async function persist(s = S) {
  if (!s.messages.length || s.temporary) return;   // temporary chats are never saved
  const meta = { role: 'meta', tuning: s.tuning }; if (s.title) meta.title = s.title;
  const payload = [meta, ...s.messages];
  try {
    if (!s.id) {
      const ch = await api('/api/ai/chats', { method: 'POST', json: { title: titleOf(s), model: s.model, messages: payload } });
      s.id = ch.id;
      if (s === S && R && A.view === 'chat') try { history.replaceState(history.state, '', '#/ai/' + ch.id); } catch (e) {}
    } else await api('/api/ai/chats/' + s.id, { method: 'PATCH', json: { title: titleOf(s), model: s.model, messages: payload } });
    await refreshChats(); if (R && A.side === 'chats') paintSide();
  } catch (e) { toast('Couldn’t save this chat: ' + e.message, { bad: true }); }
}
async function refreshChats() { try { A.chats = (await api('/api/ai/chats')).sort((a, b) => (b.updated || 0) - (a.updated || 0)); } catch (e) { A.chats = []; } }
/* put session s on screen; the one you leave keeps running if it's busy */
function show(s) {
  if (S !== s && !busy(S) && !S.unread) sessions.delete(S);
  S = s; sessions.add(s); s.unread = false;
  A.editIdx = -1; A.artOpen = null; A.artEditing = false;
  rebuildArtifacts(s);
  if (s.model && byModel(s.model)) { A.model = s.model; A.scope = byModel(s.model).scope || 'online'; }
}
function newChat() { show(makeSession()); }
async function openChat(id, quiet) {
  const live = sessionFor(id);
  if (live) return show(live);   // a chat that's working (or just finished) — its live state is the freshest
  let ch; try { ch = await api('/api/ai/chats/' + id); } catch (e) { if (!quiet) toast('That chat couldn’t be opened', { bad: true }); newChat(); return; }
  const s = makeSession(ch.id);
  const arr = Array.isArray(ch.messages) ? ch.messages.slice() : [];
  if (arr.length && arr[0] && arr[0].role === 'meta') { const meta = arr.shift(); s.tuning = { ...DEFAULT_TUNING, ...(meta.tuning || {}) }; s.title = meta.title || null; }
  s.messages = arr; s.model = ch.model && byModel(ch.model) ? ch.model : A.model;
  show(s);
}
async function renameChat(id) {
  const c = A.chats.find(x => x.id === id); if (!c) return;
  const name = await prompt({ title: 'Rename chat', value: c.title || '', ok: 'Rename' });
  if (!name) return;
  try {
    const live = sessionFor(id);
    if (live) { live.title = name; await persist(live); }
    else {
      const ch = await api('/api/ai/chats/' + id);
      const arr = Array.isArray(ch.messages) ? ch.messages.slice() : [];
      if (arr[0] && arr[0].role === 'meta') arr[0] = { ...arr[0], title: name }; else arr.unshift({ role: 'meta', tuning: DEFAULT_TUNING, title: name });
      await api('/api/ai/chats/' + id, { method: 'PATCH', json: { title: name, messages: arr } });
      await refreshChats(); paintSide();
    }
    toast('Chat renamed', { ic: 'pencil' });
  } catch (e) { toast(e.message, { bad: true }); }
}
async function deleteChat(id) {
  if (!(await confirm({ title: 'Delete this chat?', text: 'The whole conversation, including every branch, is removed.', ok: 'Delete', danger: true, ic: 'trash', tint: 't-video' }))) return;
  const live = sessionFor(id);
  if (live) { if (busy(live)) stopStream(live); live.temporary = true; if (live !== S) sessions.delete(live); }   // temporary = never saved again
  try { await api('/api/ai/chats/' + id, { method: 'DELETE' }); } catch (e) {}
  await refreshChats();
  if (A.active === id) { newChat(); location.hash = '#/ai'; } else paintSide();
  toast('Chat deleted', { ic: 'trash' });
}

/* ---------------- pickers ---------------- */
function modelPicker(anchor) {
  const close = popover(anchor, html`<div class="ai-pop ai-models">
    <div class="seg ai-scope"><button data-scope="online" class="${A.scope === 'online' ? 'on' : ''}">${icon('spark', 13)} Online</button><button data-scope="local" class="${A.scope === 'local' ? 'on' : ''}">${icon('database', 13)} Local</button></div>
    <div class="ai-mlist">${inScope(A.scope).length ? inScope(A.scope).map(m => html`<button class="ai-mi${m.id === A.model ? ' on' : ''}" data-model="${m.id}"><span><b>${modelName(m)}</b><small>${modelSub(m)}</small></span>${m.id === A.model ? icon('check', 15, 2.2) : ''}</button>`) : html`<div class="ai-mempty">${A.scope === 'local' ? 'No local models — add a .gguf file to your files.' : 'No online models are available right now.'}</div>`}</div></div>`, box => {
    box.addEventListener('click', e => {
      const s = e.target.closest('[data-scope]');
      if (s && s.dataset.scope !== A.scope) { A.scope = s.dataset.scope; lsSet('simplex.ai.scope', A.scope); if (!byModel(A.model) || (byModel(A.model).scope || 'online') !== A.scope) A.model = (inScope(A.scope)[0] || {}).id || null; S.model = A.model; close(); paintMain(); A.scope === 'local' ? startThermal() : stopThermal(); modelPicker(R.querySelector('[data-pick]')); return; }
      const b = e.target.closest('[data-model]'); if (!b) return;
      A.model = b.dataset.model; S.model = A.model; close(); paintMain(); if (A.active && !S.streaming) persist();
    });
  });
}
function modePicker(anchor) {
  popover(anchor, html`<div class="ai-pop ai-modes"><b class="ai-pop-h">When the AI changes your files</b>
    ${Object.entries(MODES).map(([k, v]) => html`<button class="ai-mi${mode() === k ? ' on' : ''}" data-m="${k}"><span class="ai-mic m-${k}">${icon(MODE_IC[k], 14)}</span><span><b>${v.label}</b><small>${v.sub}</small></span>${mode() === k ? icon('check', 15, 2.2) : ''}</button>`)}
    ${A.chatAllow ? html`<p class="ai-pop-note">${icon('info', 12)} You chose “Allow for this chat”, so this chat won’t ask again.</p>` : ''}</div>`, (box, close) => {
    box.addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b) return; prefs.set({ aiMode: b.dataset.m }); close(); const mb = R && R.querySelector('[data-mode]'); if (mb) { mb.className = 'ai-modebtn m-' + b.dataset.m; mb.innerHTML = html`${icon(MODE_IC[b.dataset.m], 13)} ${MODES[b.dataset.m].label} ${icon('arrowdown', 11)}`.s; } });
  }, true);
}
function popover(anchor, markup, wire, above) {
  const box = el(markup.s || markup); document.body.appendChild(box);
  const r = anchor.getBoundingClientRect();
  box.style.top = Math.max(10, above ? r.top - box.offsetHeight - 8 : r.bottom + 8) + 'px';
  box.style.left = Math.max(10, Math.min(r.left, innerWidth - box.offsetWidth - 10)) + 'px';
  animate(box, [{ opacity: 0, transform: `translateY(${above ? 6 : -6}px) scale(0.97)` }, { opacity: 1, transform: 'none' }], { duration: 320, easing: SPRING });
  let done = false;
  const close = () => { if (done) return; done = true; pop(); document.removeEventListener('pointerdown', away, true); animate(box, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' }).then(() => box.remove()); };
  const away = e => { if (!box.contains(e.target) && !anchor.contains(e.target)) close(); };
  const pop = pushEsc(close);
  setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
  wire && wire(box, close);
  return close;
}
function contextPopover(anchor) {
  const est = s => Math.ceil(String(s || '').length / 4);
  const sys = est(A.tuning.system) + est(toolsPrompt({ mode: mode(), history: true, memoryOn: true })) + est(memory.list().map(m => m.text).join('\n'));
  let mine = 0, theirs = 0;
  A.messages.forEach(m => { if (m.role === 'meta') return; const n = est(m.content); if (m.role === 'user' && !m.toolResult) mine += n; else theirs += n; });
  const overhead = A.messages.length * 4, used = sys + mine + theirs + overhead;
  const cur = byModel(A.model), limit = (cur && cur.ctx) || (A.scope === 'local' ? 8192 : 128000);
  const pct = Math.min(100, Math.round(used / limit * 100)), seg = n => Math.min(100, n / limit * 100);
  popover(anchor, html`<div class="ai-pop ai-ctxp"><b>Context usage</b><p class="dim">An estimate — about four characters per token.</p>
    <div class="ai-ctxbar"><i class="s1" style="width:${seg(sys)}%"></i><i class="s2" style="width:${seg(mine)}%"></i><i class="s3" style="width:${seg(theirs)}%"></i><i class="s4" style="width:${seg(overhead)}%"></i></div>
    ${[['s1', 'Instructions, tools & memory', sys], ['s2', 'Your messages', mine], ['s3', 'AI replies & tool results', theirs], ['s4', 'Formatting', overhead]].map(([c, l, n]) => html`<div class="ai-ctxr"><i class="${c}"></i>${l}<span>${n.toLocaleString()}</span></div>`)}
    <div class="ai-ctxr tot">Used of ${limit.toLocaleString()}<span>${used.toLocaleString()} (${pct}%)</span></div></div>`);
}

/* ---------------- conversation settings ---------------- */
function paintTune() {
  const p = R && R.querySelector('.ai-tunep'); if (!p) return;
  p.hidden = !A.tuneOpen; if (!A.tuneOpen) return;
  const local = A.scope === 'local';
  p.innerHTML = html`<div class="ai-ph"><b>${icon('settings', 15)} Conversation</b><button class="b sm flat" data-treset>Reset</button><button class="ib sm" data-tclose aria-label="Close">${icon('close', 16)}</button></div>
    <div class="ai-pb"><div class="cv-g"><span class="eyebrow">Instructions for this chat</span><textarea class="in" rows="4" data-sys placeholder="e.g. Answer in Spanish.">${A.tuning.system || ''}</textarea><small class="dim">Added on top of your personalization and memory, for this chat only.</small></div>
    <div class="cv-g"><span class="eyebrow">Sampling</span>${local ? '' : html`<p class="ai-note">${icon('info', 13)}<span>These only apply to <b>local</b> models — online providers don’t accept them, so nothing here is sent for this model.</span></p>`}
      <div class="ai-sliders${local ? '' : ' inert'}">${SLIDERS.map(s => html`<label class="ai-sl"><span>${s.label}<input type="number" data-tnum="${s.k}" min="${s.min}" max="${s.max}" step="${s.step}" value="${(+A.tuning[s.k]).toFixed(s.dp)}"></span><input type="range" data-trange="${s.k}" min="${s.min}" max="${s.max}" step="${s.step}" value="${A.tuning[s.k]}"><small>${s.help}</small></label>`)}</div></div></div>`.s;
  const save = debounce(() => { if (A.active) persist(); }, 700);
  const paint = r => r.style.setProperty('--fill', ((r.value - r.min) / (r.max - r.min) * 100) + '%');
  $$('input[type=range]', p).forEach(paint);
  p.querySelector('[data-tclose]').onclick = () => { A.tuneOpen = false; paintTune(); const b = R.querySelector('[data-tune]'); b && b.classList.remove('on'); };
  p.querySelector('[data-treset]').onclick = () => { A.tuning = { ...DEFAULT_TUNING }; paintTune(); save(); toast('Settings reset', { ic: 'restore' }); };
  p.querySelector('[data-sys]').oninput = e => { A.tuning.system = e.target.value; save(); };
  p.addEventListener('input', e => {
    const k = e.target.dataset.trange; if (!k) return; const s = SLIDERS.find(x => x.k === k);
    A.tuning[k] = +e.target.value; paint(e.target); p.querySelector(`[data-tnum="${k}"]`).value = (+e.target.value).toFixed(s.dp); save();
  });
  p.addEventListener('change', e => {
    const k = e.target.dataset.tnum; if (!k) return; const s = SLIDERS.find(x => x.k === k);
    let v = +e.target.value; if (!isFinite(v)) v = DEFAULT_TUNING[k]; v = Math.min(s.max, Math.max(s.min, v));
    A.tuning[k] = v; e.target.value = v.toFixed(s.dp); const r = p.querySelector(`[data-trange="${k}"]`); r.value = v; paint(r); save();
  });
}

/* ---------------- artifacts ---------------- */
const ART_TYPES = ['code', 'markdown', 'html', 'svg', 'text'];
function createArtifact(a, msgIdx, s = S) {
  const art = { id: 'art' + Math.random().toString(36).slice(2, 8), title: String(a.title || 'Untitled').slice(0, 120), type: ART_TYPES.includes(a.type) ? a.type : 'text', language: String(a.language || '').slice(0, 30), content: String(a.content || '') };
  s.artifacts.push(art);
  const m = s.messages[msgIdx]; if (m) (m.artifacts = m.artifacts || []).push(art);
  if (s === S) { A.artOpen = art.id; paintArt(); }
  return art;
}
function updateArtifact(a, s = S) {
  const art = a.id ? s.artifacts.find(x => x.id === a.id) : s.artifacts[s.artifacts.length - 1];
  if (!art) return null;
  if (a.content != null) art.content = String(a.content);
  if (a.title) art.title = String(a.title).slice(0, 120);
  if (s === S) { A.artOpen = art.id; paintArt(); }
  return art;
}
function artExt(a) {
  if (a.type === 'markdown') return 'md'; if (a.type === 'html') return 'html'; if (a.type === 'svg') return 'svg';
  if (a.type === 'code') { const L = (a.language || '').toLowerCase(); return ({ javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', go: 'go', rust: 'rs', rs: 'rs', ruby: 'rb', php: 'php', html: 'html', css: 'css', json: 'json', sql: 'sql', sh: 'sh', bash: 'sh', yaml: 'yaml', yml: 'yaml', markdown: 'md' })[L] || 'txt'; }
  return 'txt';
}
const artFile = a => { const base = (a.title || 'artifact').replace(/[^a-z0-9 ._-]/gi, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'artifact'; return /\.[a-z0-9]+$/i.test(base) ? base : base + '.' + artExt(a); };
function paintArt() {
  const p = R && R.querySelector('.ai-art'); if (!p) return;
  const art = A.artifacts.find(a => a.id === A.artOpen);
  p.hidden = !art; if (!art) return;
  const pv = ['markdown', 'svg', 'html'].includes(art.type), tab = pv ? A.artTab : 'code';
  const bodyHTML = A.artEditing ? html`<textarea class="ai-arted" spellcheck="false">${art.content}</textarea>`.s
    : tab === 'preview' && pv ? (art.type === 'markdown' ? `<div class="ai-md ai-artmd">${md(art.content)}</div>` : art.type === 'svg' ? `<div class="ai-artsvg"><img alt="" src="data:image/svg+xml;utf8,${encodeURIComponent(art.content)}"></div>` : `<iframe class="ai-artframe" sandbox="allow-scripts allow-popups" srcdoc="${esc(art.content)}"></iframe>`)
    : `<pre class="ai-artcode"><code>${esc(art.content)}</code></pre>`;
  p.innerHTML = html`<div class="ai-ph"><span class="tint t-app ai-arti">${icon('window', 15)}</span><div class="ai-artt"><b>${art.title}</b><small>${art.type}${art.language ? ' · ' + art.language : ''}</small></div><button class="ib sm" data-aclose aria-label="Close">${icon('close', 16)}</button></div>
    ${A.artifacts.length > 1 ? html`<div class="ai-artsw">${A.artifacts.map(a => html`<button class="${a.id === art.id ? 'on' : ''}" data-asw="${a.id}">${a.title}</button>`)}</div>` : ''}
    <div class="ai-arttb">${pv ? html`<div class="seg"><button data-atab="preview" class="${tab === 'preview' ? 'on' : ''}">Preview</button><button data-atab="code" class="${tab === 'code' ? 'on' : ''}">Source</button></div>` : ''}<span class="sp"></span>
      <button class="ib sm" data-aedit title="${A.artEditing ? 'Done editing' : 'Edit'}">${icon(A.artEditing ? 'check' : 'pencil', 15)}</button><button class="ib sm" data-acopy title="Copy">${icon('file', 15)}</button><button class="ib sm" data-adl title="Download">${icon('download', 15)}</button><button class="b sm pri" data-asave>${icon('upload', 14)} Save to Files</button></div>
    <div class="ai-artb">${raw(bodyHTML)}</div>`.s;
  p.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-aclose')) { A.artOpen = null; A.artEditing = false; return paintArt(); }
    if (b.dataset.asw) { A.artOpen = b.dataset.asw; A.artEditing = false; return paintArt(); }
    if (b.dataset.atab) { A.artTab = b.dataset.atab; return paintArt(); }
    if (b.hasAttribute('data-aedit')) { if (A.artEditing) { const ta = p.querySelector('.ai-arted'); if (ta) { art.content = ta.value; persist(); } } A.artEditing = !A.artEditing; return paintArt(); }
    if (b.hasAttribute('data-acopy')) return copyText(art.content).then(() => toast('Copied', { ic: 'check' }));
    if (b.hasAttribute('data-adl')) { const u = URL.createObjectURL(new Blob([art.content], { type: 'text/plain' })); const a = document.createElement('a'); a.href = u; a.download = artFile(art); a.click(); setTimeout(() => URL.revokeObjectURL(u), 4000); return; }
    if (b.hasAttribute('data-asave')) { try { const rec = await api('/api/files/doc', { method: 'POST', json: { name: artFile(art), content: art.content, parent: null } }); store.added(rec); toast('Saved “' + rec.name + '” to Files', { ic: 'check' }); } catch (err) { toast(err.message, { bad: true }); } }
  };
}

/* ---------------- thermal banner (local models) ---------------- */
function paintBanner() {
  const b = R && R.querySelector('.ai-banner'); if (!b) return;
  const t = A.thermal;
  if (A.scope !== 'local' || !t || !t.tripped) { b.innerHTML = ''; return; }
  const mins = Math.max(1, Math.ceil((t.cooldownRemainingMs || 0) / 60000));
  b.innerHTML = html`<div class="ai-thermal">${icon('info', 15)}<div><b>Cooling down${t.tempC != null ? ` (reached ${Math.round(t.tempC)}°C)` : ''}</b><span>The server got too warm, so local AI is paused for about ${plural(mins, 'more minute')}. Online models still work.</span></div></div>`.s;
}
function startThermal() {
  stopThermal();
  const tick = async () => { try { A.thermal = (await api('/api/ai/local/status', { timeout: 8000 })).thermal || null; } catch (e) { A.thermal = null; } paintBanner(); };
  tick(); A.thermalTimer = setInterval(tick, 15000);
}
function stopThermal() { clearInterval(A.thermalTimer); A.thermalTimer = null; }

/* ---------------- memory & personalization ---------------- */
function paintMemoryPage(main) {
  const p = A.persona || {};
  const on = p.memoryEnabled !== false;
  const items = memory.list();
  const upd = memory.lastUpdated();
  main.innerHTML = html`<header class="ai-bar"><button class="ib ai-sidebtn" data-sidebtn aria-label="Chats">${icon('chat', 18)}</button><b class="ai-bt">${icon('brain', 16)} Memory & personalization</b><span class="sp"></span><a class="b sm" href="${A.active ? '#/ai/' + A.active : '#/ai'}">${icon('back', 14)} Back to chat</a></header>
    <div class="ai-scroll"><div class="ai-you-page">
      <section class="mem-hero"><div class="ai-orb sm">${icon('brain', 20, 1.6)}</div><div><h3>What the AI remembers about you</h3>
        <p class="dim">It picks up lasting things — who you are, your projects, how you like answers — from your conversations, and brings them into every new chat.${upd ? ' Last updated ' + fmtDate(upd) + '.' : ''}</p></div></section>
      <div class="group mem-sw">
        <div class="row"><div class="rm"><b>Use memory</b><small>Bring what it remembers into new chats</small></div><label class="sw"><input type="checkbox" data-memon ${on ? 'checked' : ''}><span></span></label></div>
        <div class="row"><div class="rm"><b>Learn from conversations</b><small>Update memory automatically after each reply</small></div><label class="sw"><input type="checkbox" data-pref="aiAutoMemory" ${prefs.get('aiAutoMemory') ? 'checked' : ''} ${on ? '' : 'disabled'}><span></span></label></div>
        <div class="row"><div class="rm"><b>Reference past chats</b><small>Let it search your earlier conversations when you mention them</small></div><label class="sw"><input type="checkbox" data-pref="aiHistory" ${prefs.get('aiHistory') ? 'checked' : ''}><span></span></label></div>
      </div>
      <section class="ai-plevel"><h3>System prompt</h3><p class="dim">How much instruction goes along with every message. Less leaves more room for your conversation and is faster on small local models.</p>
        <div class="seg" data-plevel><button data-v="none">None</button><button data-v="minimal">Minimal</button><button data-v="full">Full</button></div>
        <p class="ai-pldesc" data-pldesc></p></section>
      <section><div class="mem-head"><h3>Memory</h3><span class="sp"></span><button class="b sm" data-msynth ${on ? '' : 'disabled'}>${icon('restore', 14)} Refresh from recent chats</button><button class="b sm" data-madd>${icon('plus', 14)} Add</button></div>
        ${items.length ? memory.CATS.map(c => { const list = items.filter(m => m.cat === c.id); return list.length ? html`<div class="mem-cat"><span class="eyebrow">${c.label}</span>${list.map(m => html`<div class="ai-mem${m.pinned ? ' pinned' : ''}" data-mem="${m.id}"><span>${m.body}</span><div><button class="ib sm${m.pinned ? ' on' : ''}" data-mpin title="${m.pinned ? 'Unpin — refreshing may rewrite it' : 'Pin — keep exactly as written'}">${icon('star', 14)}</button><button class="ib sm" data-medit title="Edit">${icon('pencil', 14)}</button><button class="ib sm" data-mdel title="Forget">${icon('trash', 14)}</button></div></div>`)}</div>` : ''; }) : html`<div class="ai-mempty">${on ? 'Nothing yet. Chat normally — it picks up lasting details as you go. You can also add things yourself.' : 'Memory is off.'}</div>`}
        ${items.length ? html`<button class="b sm danger" data-mclear>${icon('trash', 14)} Clear all memory</button>` : ''}
      </section>
      <section><h3>Personalization</h3><p class="dim">Tell the AI about yourself and how you like answers. Applies to every chat.</p>
        <div class="cv-g"><span class="eyebrow">What should it call you?</span><input class="in" data-p="name" maxlength="60" placeholder="Your name" value="${p.name || ''}"></div>
        <div class="cv-g"><span class="eyebrow">What do you do?</span><input class="in" data-p="role" maxlength="200" placeholder="e.g. Software engineer, student, novelist…" value="${p.role || ''}"></div>
        <div class="cv-g"><span class="eyebrow">Response style</span><div class="ai-traits">${TRAITS.map(t => html`<button class="${(p.traits || []).includes(t.id) ? 'on' : ''}" data-trait="${t.id}" title="${t.text}">${t.label}</button>`)}</div></div>
        <div class="cv-g"><span class="eyebrow">Anything else it should know?</span><textarea class="in" rows="5" maxlength="4000" data-p="instructions" placeholder="e.g. I prefer British English. When I share code, point out bugs before explaining.">${p.instructions || ''}</textarea></div>
        <div class="ai-save"><button class="b pri" data-psave>${icon('check', 15)} Save</button><span class="dim" data-phint></span></div></section>
      <section class="mem-foot"><p class="dim">${icon('clock', 12)} Want a chat that’s forgotten? Start a <b>temporary chat</b> with the clock button — it isn’t saved and never reads or changes memory.</p></section>
    </div></div>`.s;
  main.querySelector('[data-sidebtn]').onclick = () => R.classList.toggle('side-open');
  // System prompt level, with roughly what it costs per message (~3.6 characters a token)
  const BASE_CHARS = { none: 0, minimal: 205, full: 3020 };   // the server's base prompt at each level
  const descPl = lv => {
    const chars = BASE_CHARS[lv] + toolsPrompt({ mode: mode(), history: prefs.get('aiHistory'), memoryOn: on, level: lv }).length;
    const tok = Math.round(chars / 3.6 / 10) * 10;
    const what = { none: 'Nothing but your memory and personalization. The AI can’t use tools at this level — no searching or changing your files.',
      minimal: 'A two-line brief and a compact list of its tools.',
      full: 'Detailed guidance on how to answer, what Simplex is, and how to work with your files.' }[lv];
    main.querySelector('[data-pldesc]').innerHTML = tok
      ? html`${what} <b>≈ ${tok.toLocaleString()} tokens per message</b>${on ? ', plus your memory' : ''}.`.s
      : html`${what} <b>No extra tokens.</b>`.s;
  };
  seg(main.querySelector('[data-plevel]'), promptLevel(), v => { prefs.set({ aiPrompt: v }); descPl(v); });
  descPl(promptLevel());
  main.querySelector('.ai-traits').onclick = e => { const b = e.target.closest('[data-trait]'); if (b) b.classList.toggle('on'); };
  const collect = () => ({ name: main.querySelector('[data-p=name]').value.trim(), role: main.querySelector('[data-p=role]').value.trim(), instructions: main.querySelector('[data-p=instructions]').value.trim(), traits: $$('.ai-traits .on', main).map(b => b.dataset.trait), memoryEnabled: main.querySelector('[data-memon]').checked });
  const savePersona = async silent => {
    try { const r = await api('/api/ai/persona', { method: 'PUT', json: collect() }); A.persona = r.persona || collect(); if (!silent) { const h = main.querySelector('[data-phint]'); h.textContent = 'Saved'; setTimeout(() => { h.textContent = ''; }, 2000); toast('Personalization saved', { ic: 'check' }); } }
    catch (e) { toast(e.message, { bad: true }); }
  };
  main.querySelector('[data-psave]').onclick = () => savePersona(false);
  main.querySelector('[data-memon]').onchange = async () => { await savePersona(true); paintMemoryPage(main); };
  main.onchange = e => { const k = e.target.dataset.pref; if (k) prefs.set({ [k]: e.target.checked }); };
  main.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.hasAttribute('data-madd')) {
        dialog({ ic: 'brain', title: 'Add a memory', body: html`<div class="cv-g"><span class="eyebrow">Category</span><select class="in" data-c>${memory.CATS.map(c => html`<option value="${c.id}">${c.label}</option>`)}</select></div><div class="cv-g"><span class="eyebrow">What should it remember?</span><textarea class="in" rows="3" maxlength="500" placeholder="e.g. Works night shifts, so prefers short answers late at night."></textarea></div>`,
          actions: [{ label: 'Cancel' }, { label: 'Remember', kind: 'pri', run: async (_c, r) => { const t = r.querySelector('textarea').value.trim(); if (!t) return false; try { const res = await memory.add(t, r.querySelector('[data-c]').value); toast(res.added ? 'Remembered' : res.message, { ic: 'brain' }); } catch (err) { toast(err.message, { bad: true }); return false; } paintMemoryPage(main); paintSide(); } }] });
        return;
      }
      if (b.hasAttribute('data-msynth')) {
        b.disabled = true; b.innerHTML = '<span class="spin"></span> Refreshing…';
        const n = await memory.synthesize({ models: A.models, model: A.model, force: true });
        toast(n == null ? 'Nothing new to learn from' : `Memory rebuilt — ${plural(n, 'memory', 'memories')}`, { ic: 'brain' });
        paintMemoryPage(main); paintSide(); return;
      }
      if (b.hasAttribute('data-mclear')) {
        if (!(await confirm({ title: 'Clear all memory?', text: 'Everything the AI remembers about you is removed. This can’t be undone.', ok: 'Clear memory', danger: true, ic: 'trash' }))) return;
        await memory.clear(); paintMemoryPage(main); paintSide(); toast('Memory cleared', { ic: 'trash' }); return;
      }
      const row = b.closest('[data-mem]'); if (!row) return;
      const id = row.dataset.mem, m = memory.list().find(x => x.id === id); if (!m) return;
      if (b.hasAttribute('data-mdel')) await memory.remove(id);
      else if (b.hasAttribute('data-mpin')) await memory.pin(id, !m.pinned);
      else if (b.hasAttribute('data-medit')) { const t = await prompt({ title: 'Edit memory', value: m.body, ok: 'Save', ic: 'brain' }); if (!t) return; await memory.update(id, t); }
      else return;
      paintMemoryPage(main); paintSide();
    } catch (err) { toast(err.message, { bad: true }); }
  };
}

/* ---------------- image edits tab ---------------- */
let editsWired = false;
function paintEditsList(body) {
  const list = editHistory();
  body.innerHTML = html`<div class="ai-side-head"><b style="flex:1;padding-left:4px">AI image edits</b>${list.length ? html`<button class="ib" data-clearedits title="Clear history" aria-label="Clear history">${icon('trash', 16)}</button>` : ''}<button class="ib" data-newedit title="New edit" aria-label="New edit">${icon('plus', 18)}</button></div>
    <div class="ai-chats">${list.length ? list.map(x => html`<div class="ai-ed-row"><button class="ai-ed${A.editSel === x.key ? ' on' : ''}" data-ed="${x.key}"><span class="ai-edt">${x.resultUrl || x.srcUrl ? raw(`<img src="${esc(x.resultUrl || x.srcUrl)}" alt="" loading="lazy">`) : icon('image', 18)}</span><span><b>${x.prompt}</b><small>${x.state === 'done' ? fmtDate(x.created) : x.state === 'failed' ? 'Failed' : 'Working…'}</small></span></button><button class="ib sm ai-ed-x" data-edx="${x.key}" title="Remove from history" aria-label="Remove from history">${icon('close', 14)}</button></div>`) : html`<div class="ai-empty-list">Right-click an image in Files and choose “AI Edit”.</div>`}</div>`.s;
  body.querySelector('[data-newedit]').onclick = pickImageToEdit;
  const clr = body.querySelector('[data-clearedits]');
  if (clr) clr.onclick = async () => { if (await confirm({ title: 'Clear edit history?', text: 'Removes the list here. The edited images stay in your files.', ok: 'Clear history', ic: 'trash' })) { A.editSel = null; clearEditHistory(); toast('Edit history cleared', { ic: 'trash' }); } };
  const box = body.querySelector('.ai-chats');
  box.onclick = e => {
    const x = e.target.closest('[data-edx]'); if (x) { if (A.editSel === x.dataset.edx) A.editSel = null; removeEditHistory(x.dataset.edx); return; }
    const b = e.target.closest('[data-ed]'); if (!b) return; A.editSel = b.dataset.ed; R.classList.remove('side-open'); paintSide(); if (A.view === 'edits') paintMain();
  };
  box.oncontextmenu = e => {
    const b = e.target.closest('[data-ed]'); if (!b) return; e.preventDefault();
    const h = editHistory().find(y => y.key === b.dataset.ed); if (!h) return;
    menu([
      h.resultId && { label: 'Open result', ic: 'eye', run: () => openFile(h.resultId) },
      h.resultId && { label: 'Edit the result', ic: 'spark', run: () => aiEditDialog(h.resultId) },
      h.resultId && '-',
      { label: 'Remove from history', ic: 'trash', danger: true, run: () => { if (A.editSel === h.key) A.editSel = null; removeEditHistory(h.key); } },
    ].filter(Boolean), { x: e.clientX, y: e.clientY });
  };
  if (!editsWired) {
    editsWired = true;
    const refresh = () => { if (R && A.side === 'edits') { paintSide(); if (A.view === 'edits') paintMain(); } };
    window.addEventListener('nx:aiedits', refresh);
    onTasks(debounce(refresh, 300));
  }
}
const openFile = id => import('./viewer.js').then(v => { const f = store.byId(id); if (f) v.openViewer(f, [f]); else toast('That file is gone', { bad: true }); });
function paintEditsMain(main) {
  const list = editHistory();
  const x = list.find(e => e.key === A.editSel) || list[0];
  main.innerHTML = html`<header class="ai-bar"><button class="ib ai-sidebtn" data-sidebtn aria-label="Edits">${icon('image', 18)}</button><b class="ai-bt">${icon('spark', 16)} AI image edits</b><span class="sp"></span>
      <span class="dim ai-tok">${tokenText()}</span><button class="b sm pri" data-newedit>${icon('plus', 14)} New edit</button></header>
    <div class="ai-scroll"><div class="ai-edit-page">${x ? html`
      <div class="ai-ba"><figure>${raw(`<img src="${esc(x.srcUrl || '')}" alt="">`)}<figcaption>Before</figcaption></figure>
        <figure class="${x.state === 'done' ? '' : 'wait'}">${x.state === 'done' && x.resultUrl ? raw(`<img src="${esc(x.resultUrl)}" alt="">`) : x.state === 'failed' ? html`<div class="ai-baw bad">${icon('info', 22)}<span>${x.error || 'This edit failed'}</span></div>` : html`<div class="ai-baw"><span class="spin"></span><span>Editing…</span></div>`}<figcaption>After</figcaption></figure></div>
      <div class="ai-edmeta"><b>“${x.prompt}”</b><span class="dim">${x.quality === 'premium' ? 'Premium' : 'Default'} quality · ${x.srcName} · ${fmtDate(x.created)}</span>
        <div class="ai-edacts">${x.state === 'done' && x.resultId ? html`<button class="b" data-edopen="${x.resultId}">${icon('eye', 15)} Open result</button><button class="b" data-edagain="${x.resultId}">${icon('spark', 15)} Edit the result</button>` : ''}
          ${store.byId(x.srcId) ? html`<button class="b" data-edagain="${x.srcId}" data-prompt="${x.prompt}">${icon('restore', 15)} Try again on the original</button>` : ''}
          <button class="b flat" data-edremove="${x.key}">${icon('trash', 15)} Remove from history</button></div></div>` : html`<div class="ai-welcome"><div class="ai-orb">${icon('image', 28, 1.5)}</div><h2>AI image edits</h2><p>Describe a change and the AI repaints your photo. Results are saved beside the original.</p><button class="b pri" data-newedit>${icon('plus', 15)} Pick an image</button></div>`}
    </div></div>`.s;
  main.querySelector('[data-sidebtn]').onclick = () => R.classList.toggle('side-open');
  main.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-newedit')) return pickImageToEdit();
    if (b.dataset.edopen) return openFile(b.dataset.edopen);
    if (b.dataset.edagain) return aiEditDialog(b.dataset.edagain, b.dataset.prompt || '');
    if (b.dataset.edremove) { A.editSel = null; removeEditHistory(b.dataset.edremove); }
  };
  main.onchange = null;
}
function tokenText() { const t = (store.S.account && store.S.account.img_edit) || {}; return t.unlimited ? 'Unlimited edits' : `${t.remaining ?? 0} of ${t.limit ?? 5} edits left today`; }
function pickImageToEdit() {
  const imgs = store.live().filter(canAiEdit).sort((a, b) => (b.date || 0) - (a.date || 0));
  if (!imgs.length) return toast('Upload a PNG or JPEG first — AI Edit works on those', { bad: true });
  let q = '';
  dialog({
    ic: 'image', tint: 't-image', title: 'Pick an image to edit', wide: true,
    body: html`<div class="ai-find" style="margin-bottom:12px">${icon('search', 15)}<input placeholder="Search images" spellcheck="false"></div><div class="ai-pick-grid"></div>`,
    actions: [{ label: 'Cancel' }],
    onMount: (r, close) => {
      const grid = r.querySelector('.ai-pick-grid');
      const paint = () => { const l = imgs.filter(f => !q || f.name.toLowerCase().includes(q)).slice(0, 60); grid.innerHTML = l.map(f => html`<button data-pid="${f.id}" title="${f.name}">${raw(`<img src="${esc(f.url)}" alt="" loading="lazy">`)}<span>${f.name}</span></button>`.s).join('') || '<div class="dim">No matches</div>'; };
      paint();
      r.querySelector('input').oninput = e => { q = e.target.value.toLowerCase(); paint(); };
      grid.onclick = e => { const b = e.target.closest('[data-pid]'); if (!b) return; close(); setTimeout(() => aiEditDialog(b.dataset.pid), 220); };
    },
  });
}

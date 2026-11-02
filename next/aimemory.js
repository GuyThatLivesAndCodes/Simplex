/* aimemory.js — long-term memory for the AI, modelled on how Claude and ChatGPT do it:

   - Memories are short, durable facts, grouped into categories. They live in the
     server's per-account ai_memory table (text tagged "[about] …"), which the server
     injects into every chat's system prompt — so classic and new UI share them.
   - LEARN: after each exchange, a quick background pass asks a model whether
     anything lasting should be added, corrected or removed. Most exchanges change
     nothing; when something does, the reply gets a small "Memory updated" note.
   - SYNTHESIZE: at most once a day (or on demand), memory is consolidated from the
     user's recent chats — duplicates merged, stale facts dropped — like Claude's
     daily synthesis. Pinned memories are never touched.
   - Temporary chats neither read nor change memory. */
import { api, lsGet, lsSet } from './lib.js';
import * as prefs from './prefs.js';

export const CATS = [
  { id: 'about', label: 'About you' },
  { id: 'work', label: 'Work & projects' },
  { id: 'prefs', label: 'Preferences' },
  { id: 'ongoing', label: 'Ongoing & plans' },
];
const TAG = /^\[(about|work|prefs|ongoing)\]\s*/i;
export const parse = m => { const t = TAG.exec(m.text || ''); return { ...m, cat: t ? t[1].toLowerCase() : 'about', body: t ? m.text.slice(t[0].length) : m.text }; };
const tagged = (text, cat) => `[${CATS.some(c => c.id === cat) ? cat : 'about'}] ${String(text).trim()}`;

let entries = [];
const subs = new Set();
export const onMemory = fn => { subs.add(fn); return () => subs.delete(fn); };
const changed = () => subs.forEach(fn => { try { fn(entries); } catch (e) {} });
export const list = () => entries.map(parse);
export function load(memory) { entries = Array.isArray(memory) ? memory.slice() : []; changed(); }
export async function refresh() { try { load(await api('/api/ai/memory')); } catch (e) {} }

export async function add(text, cat) {
  const body = String(text || '').trim();
  if (!body) return { added: false, message: 'Nothing to remember.' };
  if (body.length > 500) return { added: false, message: 'Keep a memory under 500 characters.' };
  if (entries.some(m => parse(m).body.trim().toLowerCase() === body.toLowerCase())) return { added: false, message: 'Already remembered.' };
  const m = await api('/api/ai/memory', { method: 'POST', json: { text: tagged(body, cat) } });
  entries.unshift(m); changed();
  return { added: true, message: 'Saved to memory: ' + body, entry: m };
}
export async function update(id, text, cat) {
  const cur = entries.find(m => m.id === id); if (!cur) return null;
  const p = parse(cur);
  const m = await api('/api/ai/memory/' + id, { method: 'PATCH', json: { text: tagged(text ?? p.body, cat || p.cat) } });
  Object.assign(cur, m); changed(); return cur;
}
export async function pin(id, on) { const cur = entries.find(m => m.id === id); if (!cur) return; Object.assign(cur, await api('/api/ai/memory/' + id, { method: 'PATCH', json: { pinned: !!on } })); changed(); }
export async function remove(id, text) {
  const t = String(text || '').trim().toLowerCase();
  const m = id ? entries.find(x => x.id === id) : t ? entries.find(x => x.text.toLowerCase().includes(t)) : null;
  if (!m) return 'No matching memory.';
  await api('/api/ai/memory/' + m.id, { method: 'DELETE' });
  entries = entries.filter(x => x.id !== m.id); changed();
  return 'Forgot: ' + parse(m).body;
}
export async function clear() { await api('/api/ai/memory/clear', { method: 'POST' }); entries = []; changed(); }
export const lastUpdated = () => Number(lsGet('nx.mem.updated', '0')) || 0;
const touch = () => lsSet('nx.mem.updated', String(Date.now()));

/* ---------------- background model calls ---------------- */
/* pick the model for memory work: the fast Llama when offered, else the chat's own */
export function memoryModel(models, fallback) {
  const fast = models.find(m => (m.scope || 'online') === 'online' && /llama-3\.3-70b/i.test(m.id));
  return (fast && fast.id) || fallback;
}
async function complete(model, system, user, maxTokens = 600) {
  const res = await fetch('/api/ai/chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, system, memory: false, messages: [{ role: 'user', content: user }], max_tokens: maxTokens, temperature: 0.2 }) });
  if (!res.ok) throw new Error('memory model unavailable');
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '', out = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const line of lines) {
      const d = line.replace(/^data: ?/, '').trim(); if (!d || d.startsWith(':')) continue;
      let o; try { o = JSON.parse(d); } catch (e) { continue; }
      if (o.type === 'text') out += o.text;
      else if (o.type === 'error') throw new Error(o.error || 'memory model error');
    }
  }
  return out;
}
function json(text) { const s = text.indexOf('{'), e = text.lastIndexOf('}'); if (s < 0 || e <= s) return null; try { return JSON.parse(text.slice(s, e + 1)); } catch (err) { return null; } }
const listForPrompt = () => entries.map(m => { const p = parse(m); return `(${m.id}) [${p.cat}]${m.pinned ? ' [pinned]' : ''} ${p.body}`; }).join('\n') || '(empty)';

const RULES = `Save only durable facts that will still matter in future conversations: who the user is, their work and projects, how they like answers, ongoing goals or plans.
Do NOT save: details of a one-off task, the content of things they asked about, anything about the assistant, secrets or credentials, sensitive personal data (health, finances, relationships) unless they explicitly asked you to remember it, or anything already in memory.
Write each memory as one short third-person sentence ("Prefers TypeScript over JavaScript.").`;

/* after an exchange: maybe add / update / remove a few memories. Returns the changes made. */
export async function learn({ models, model, user, reply }) {
  if (!prefs.get('aiAutoMemory')) return [];
  const sys = `You maintain the long-term memory of an AI assistant about its user. Read the latest exchange and decide whether memory should change.
${RULES}
If the user corrected something that contradicts a memory, update that memory. If they asked to forget something, remove it. Never touch [pinned] memories.
Current memory (id, category, text):
${listForPrompt()}
Reply with ONLY JSON: {"add":[{"text":"…","category":"about|work|prefs|ongoing"}],"update":[{"id":"…","text":"…","category":"…"}],"remove":["id"]}. Use empty arrays when nothing should change — most exchanges change nothing.`;
  const exchange = `USER:\n${String(user || '').slice(0, 4000)}\n\nASSISTANT:\n${String(reply || '').slice(0, 3000)}`;
  let out;
  try { out = json(await complete(memoryModel(models, model), sys, exchange, 500)); } catch (e) { return []; }
  if (!out) return [];
  const done = [];
  for (const a of (out.add || []).slice(0, 4)) { try { const r = await add(a.text, a.category); if (r.added) done.push({ op: 'add', text: String(a.text).trim() }); } catch (e) {} }
  for (const u of (out.update || []).slice(0, 4)) { const cur = entries.find(m => m.id === u.id); if (!cur || cur.pinned || !u.text) continue; try { await update(u.id, u.text, u.category); done.push({ op: 'update', text: String(u.text).trim() }); } catch (e) {} }
  for (const id of (out.remove || []).slice(0, 4)) { const cur = entries.find(m => m.id === id); if (!cur || cur.pinned) continue; try { await remove(id); done.push({ op: 'remove', text: parse(cur).body }); } catch (e) {} }
  if (done.length) touch();
  return done;
}

/* consolidate memory from recent chats (daily, or when the user asks) */
export async function synthesize({ models, model, force }) {
  const last = Number(lsGet('nx.mem.synth', '0')) || 0;
  if (!force && Date.now() - last < 24 * 3600e3) return null;
  lsSet('nx.mem.synth', String(Date.now()));
  let chats; try { chats = (await api('/api/ai/chats')).sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 20); } catch (e) { return null; }
  if (!force && !chats.some(c => (c.updated || 0) > last)) return null;
  const digest = [];
  for (const c of chats) {
    let full; try { full = await api('/api/ai/chats/' + c.id); } catch (e) { continue; }
    const said = (full.messages || []).filter(m => m.role === 'user' && !m.toolResult).map(m => String(m.content || '').replace(/\s+/g, ' ').slice(0, 400));
    if (said.length) digest.push(`# ${c.title || 'Untitled'} (${new Date(c.updated || Date.now()).toISOString().slice(0, 10)})\n- ` + said.slice(0, 8).join('\n- '));
  }
  if (!digest.length) return null;
  const sys = `You maintain the long-term memory of an AI assistant about its user. Rebuild that memory from the current memory plus what the user said in their recent conversations.
${RULES}
Merge duplicates, drop facts that are clearly stale or contradicted by newer chats, keep everything still true. At most 40 memories. Keep [pinned] memories exactly as they are (they are kept automatically — don't repeat them).
Current memory:
${listForPrompt()}
Reply with ONLY JSON: {"memories":[{"text":"…","category":"about|work|prefs|ongoing"}]}`;
  let out; try { out = json(await complete(memoryModel(models, model), sys, digest.join('\n\n').slice(0, 24000), 1600)); } catch (e) { return null; }
  if (!out || !Array.isArray(out.memories)) return null;
  const fresh = out.memories.filter(x => x && x.text).slice(0, 40);
  // replace unpinned memories with the synthesized set (pinned stay as they are)
  for (const m of entries.filter(x => !x.pinned)) { try { await api('/api/ai/memory/' + m.id, { method: 'DELETE' }); } catch (e) {} }
  entries = entries.filter(x => x.pinned);
  for (const x of fresh) { try { const m = await api('/api/ai/memory', { method: 'POST', json: { text: tagged(x.text, x.category) } }); entries.push(m); } catch (e) {} }
  touch(); changed();
  return fresh.length;
}

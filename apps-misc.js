/* ============================================================
   MISC APPS (apps-misc.js) — Analytics and Bug Reports, extracted from app.js and
   loaded on demand the first time any opens (openApp →
   loadFeature("apps-misc")). Plain (non-module) script sharing app.js global scope:
   DEFINES {analytics,bugs}HTML + their wire* fns; SEES core helpers and the
   always-on trackEvent/flushAnalytics logger (stays in data.js, so event logging
   keeps working even when this dashboard code is not loaded).
   ============================================================ */
/* ============================================================
   ANALYTICS APP — the user's own private usage dashboard.
   Reads /api/analytics/summary (a 30-day daily series + an hour×weekday heatmap +
   per-type + all-time totals, all derived from the account's own event log) and
   draws it with inline SVG/CSS — no chart libraries, no external calls. The data is
   the user's; we don't use it for anything (see the notice). They can wipe it.
   ============================================================ */
const ANALYTICS_LABELS = {
  session: { label: 'Sessions', icon: 'clock', tint: 'video' },
  app_open: { label: 'Apps opened', icon: 'grid', tint: 'document' },
  upload: { label: 'Uploads', icon: 'upload', tint: 'audio' },
  ai_message: { label: 'AI messages', icon: 'spark', tint: 'audio' },
  tool_use: { label: 'Tools used', icon: 'wrench', tint: 'image' },
  file_view: { label: 'Files opened', icon: 'eye', tint: 'folder' },
  download: { label: 'Downloads', icon: 'download', tint: 'folder' },
  share: { label: 'Shares', icon: 'share', tint: 'video' },
  note_edit: { label: 'Note edits', icon: 'note', tint: 'document' },
  convert: { label: 'Conversions', icon: 'convert', tint: 'image' },
};
const _WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function analyticsHTML() {
  return `<div class="analytics-app" data-screen-label="Analytics">
    <div class="an-head">
      <div>
        <h2 class="an-title">Your activity</h2>
        <p class="an-sub">How and when you use your workspace — counted privately, just for you.</p>
      </div>
      <div class="an-head-acts">
        <button class="btn ghost sm" id="anRefresh">${svg('refresh', 14)} Refresh</button>
        <button class="btn ghost sm danger" id="anClear">${svg('trash', 14)} Clear data</button>
      </div>
    </div>
    <div class="an-notice">${svg('info', 16)}
      <span><b>This is yours alone.</b> We record these usage stats only so you can see them here — they're stored in your own encrypted account and <b>we don't use them for anything today</b>. We may, in the future, use anonymous patterns to make your experience better. Clearing the data wipes it for good.</span>
    </div>
    <div id="anBody"><div class="an-loading">${svg('chart', 28)}<span>Crunching your numbers…</span></div></div>
  </div>`;
}

async function wireAnalytics() {
  const refresh = document.getElementById('anRefresh');
  const clear = document.getElementById('anClear');
  if (refresh) refresh.onclick = () => loadAnalytics();
  if (clear) clear.onclick = () => confirmModal(
    'Clear analytics?',
    'This permanently erases your recorded usage history. It cannot be undone. New activity will start being counted again from now.',
    async () => { try { await clearAnalytics(); toast('Analytics cleared'); loadAnalytics(); } catch (e) { toast('Could not clear', 'close'); } },
    'Clear'
  );
  loadAnalytics();
}

async function loadAnalytics() {
  const body = document.getElementById('anBody');
  if (!body) return;
  // flush any queued events first so the freshest numbers are included
  try { if (typeof flushAnalytics === 'function') flushAnalytics(); } catch (e) {}
  body.innerHTML = `<div class="an-loading">${svg('chart', 28)}<span>Crunching your numbers…</span></div>`;
  let data;
  try { data = await getAnalyticsSummary(); }
  catch (e) { if (e && e.code === 'AUTH') return relock(); body.innerHTML = `<div class="an-loading">${svg('info', 24)}<span>Couldn't load analytics.</span></div>`; return; }
  body.innerHTML = analyticsBodyHTML(data);
}

function analyticsBodyHTML(d) {
  const tt = d.typeTotals || {};
  const series = d.series || [];
  const heat = d.heat || [];

  // KPI cards: the most meaningful at-a-glance numbers
  const kpis = [
    { v: fmtElapsed((d.activeSeconds || 0) * 1000), k: 'Active time (30d)', icon: 'clock', tint: 'video' },
    { v: String(d.signIns || 0), k: 'Sign-ins (30d)', icon: 'user', tint: 'document' },
    { v: String(tt.upload || 0), k: 'Uploads (30d)', icon: 'upload', tint: 'audio' },
    { v: String(tt.ai_message || 0), k: 'AI messages (30d)', icon: 'spark', tint: 'audio' },
  ];

  // daily activity bar chart (last N days)
  const maxDay = Math.max(1, ...series.map(s => s.total));
  const bars = series.map(s => {
    const h = Math.round((s.total / maxDay) * 100);
    const dt = new Date(s.date + 'T00:00:00');
    const tip = `${dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${s.total} event${s.total === 1 ? '' : 's'}`;
    return `<div class="an-bar" title="${esc(tip)}"><i style="height:${Math.max(s.total ? 4 : 0, h)}%"></i></div>`;
  }).join('');
  // a few date ticks under the chart
  const tickCount = Math.min(6, series.length);
  const ticks = [];
  for (let i = 0; i < tickCount; i++) {
    const idx = Math.round(i * (series.length - 1) / Math.max(1, tickCount - 1));
    const dt = new Date(series[idx].date + 'T00:00:00');
    ticks.push(`<span>${dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>`);
  }

  // hour × weekday heatmap
  let maxCell = 1;
  for (const row of heat) for (const c of row) if (c > maxCell) maxCell = c;
  const heatRows = _WEEKDAYS.map((wd, di) => {
    const cells = (heat[di] || new Array(24).fill(0)).map((c, hi) => {
      const lvl = c === 0 ? 0 : Math.ceil((c / maxCell) * 4);   // 0–4 intensity
      return `<i class="lv${lvl}" title="${wd} ${String(hi).padStart(2, '0')}:00 · ${c}"></i>`;
    }).join('');
    return `<div class="an-heatrow"><span class="an-heatlbl">${wd}</span><div class="an-heatcells">${cells}</div></div>`;
  }).join('');

  // per-type breakdown (sorted, only types we have a label for). 'session' rows are
  // the sign-in count, not the heartbeats, so the bar matches the KPI above.
  const breakdown = Object.keys(ANALYTICS_LABELS)
    .map(t => ({ t, n: t === 'session' ? (d.signIns || 0) : (tt[t] || 0), ...ANALYTICS_LABELS[t] }))
    .filter(r => r.n > 0)
    .sort((a, b) => b.n - a.n);
  const maxType = Math.max(1, ...breakdown.map(r => r.n));
  const breakdownHTML = breakdown.length ? breakdown.map(r => `
    <div class="an-brow">
      <span class="an-bico bg-${r.tint} t-${r.tint}">${svg(r.icon, 15, 1.7)}</span>
      <span class="an-blabel">${esc(r.label)}</span>
      <span class="an-btrack"><i style="width:${Math.round((r.n / maxType) * 100)}%"></i></span>
      <span class="an-bval">${r.n}</span>
    </div>`).join('') : `<div class="an-empty">No activity recorded yet — use the workspace and check back.</div>`;

  const firstSeen = d.firstSeen ? new Date(d.firstSeen).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—';

  return `
    <div class="an-kpis">
      ${kpis.map(c => `<div class="an-kpi"><div class="an-kico bg-${c.tint} t-${c.tint}">${svg(c.icon, 18, 1.7)}</div><div class="an-kv">${esc(c.v)}</div><div class="an-kk">${esc(c.k)}</div></div>`).join('')}
    </div>

    <div class="an-card">
      <div class="an-card-head"><h3>Daily activity</h3><span class="eyebrow">last ${d.retentionDays || 30} days</span></div>
      <div class="an-chart">${bars}</div>
      <div class="an-ticks">${ticks.join('')}</div>
    </div>

    <div class="an-grid2">
      <div class="an-card">
        <div class="an-card-head"><h3>When you're active</h3><span class="eyebrow">by hour & day</span></div>
        <div class="an-heat">${heatRows}
          <div class="an-heatrow an-heataxis"><span class="an-heatlbl"></span><div class="an-heatcells"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span></div></div>
        </div>
        <div class="an-heatkey"><span>Less</span><i class="lv0"></i><i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><i class="lv4"></i><span>More</span></div>
      </div>

      <div class="an-card">
        <div class="an-card-head"><h3>What you do</h3><span class="eyebrow">events by type</span></div>
        <div class="an-breakdown">${breakdownHTML}</div>
      </div>
    </div>

    <div class="an-foot mono">${d.allTimeTotal || 0} events recorded all-time · first activity ${esc(firstSeen)}</div>`;
}

/* ============================================================
   TRADING APP — control panel for the GLOBAL, always-training AI trader.
   The model is shared by everyone and trains in the background server-side; this
   screen shows its status, the user's portfolio (sandbox "fake money" by default,
   or their own connected brokerage in live mode), positions, P&L, an equity curve,
   the live signals, and the trade log. Built with inline SVG + the app's own CSS,
   no chart libraries — same approach as Analytics.
   ============================================================ */
/* ============================================================
   BUG REPORTS app — every account can file a bug; admins read + triage them.
   Members see a submit form (+ a note about the open AI endpoint); admins also
   see the full inbox. Reports are filed through data.js (bugSubmit / bugList /
   bugUpdate / bugDelete), backed by the global bug_reports table on the server.
   ============================================================ */
const BUG_AREAS = ['Database', 'AI', 'Code', 'Notes', 'Tools', 'Neural Network', 'Analytics', 'Trading', 'Connectors', 'Settings', 'Account / login', 'Other'];
const BUG_SEVERITIES = [
  { val: 'low', label: 'Low — minor / cosmetic' },
  { val: 'medium', label: 'Medium — annoying but usable' },
  { val: 'high', label: 'High — blocks a feature' },
  { val: 'critical', label: 'Critical — data loss / app broken' },
];
const BUG_STATUS_LABEL = { new: 'New', open: 'Open', resolved: 'Resolved', wontfix: "Won't fix" };

/* SIMPLEX VISUAL moved out to its own module (apps-visual.js) once it grew past a
   scaffold into a real 2D game engine. See [[ai-models-and-visual-app]]. */

function bugsHTML() {
  const isAdmin = ACCOUNT && ACCOUNT.is_admin;
  return `<div class="bug-app" data-screen-label="Bug Reports">
    <div class="bug-head">
      <div>
        <h2 class="bug-title">${svg('bug', 20, 1.8)} Bug Reports</h2>
        <p class="bug-sub">Hit something broken? Tell us here. ${isAdmin ? 'As an admin you can also read &amp; triage every report below.' : 'An admin will read it and follow up.'}</p>
      </div>
    </div>

    <div class="bug-grid">
      <div class="bug-card bug-form-card">
        <h3 class="bug-card-h">${svg('send', 16)} Report a bug</h3>
        <div class="bug-form" id="bugForm">
          <label class="bug-field"><span class="eyebrow">What's it about?</span>
            <select class="set-select" id="bugArea">${BUG_AREAS.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}</select>
          </label>
          <label class="bug-field"><span class="eyebrow">Severity</span>
            <select class="set-select" id="bugSeverity">${BUG_SEVERITIES.map(s => `<option value="${s.val}" ${s.val === 'medium' ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
          </label>
          <label class="bug-field"><span class="eyebrow">Title</span>
            <input type="text" id="bugTitleInput" maxlength="200" placeholder="Short summary, e.g. 'Upload fails for files over 2 GB'">
          </label>
          <label class="bug-field"><span class="eyebrow">What happened?</span>
            <textarea id="bugBodyInput" maxlength="8000" rows="6" placeholder="Steps to reproduce, what you expected, and what actually happened. The more detail, the faster we can fix it."></textarea>
          </label>
          <div class="bug-form-acts">
            <span class="bug-form-msg" id="bugFormMsg"></span>
            <button class="btn primary" id="bugSubmitBtn">${svg('send', 14)} Send report</button>
          </div>
        </div>
      </div>

      <div class="bug-card bug-aside">
        <h3 class="bug-card-h">${svg('brain', 16)} Automated reports</h3>
        <p class="bug-aside-p">Automated assistants — like the security check — can file reports <b>without an account</b> by posting to the open endpoint. No login, no cookie.</p>
        <pre class="bug-code">POST /api/bugs/open
Content-Type: application/json

{
  "reporter": "Security Check",
  "tool": "tls-audit",
  "area": "Account / login",
  "severity": "high",
  "title": "Session cookie missing Secure flag",
  "body": "Set-Cookie on /api/login omits Secure over HTTPS…"
}</pre>
        <p class="bug-aside-note mono">Rate-limited &amp; write-only. Full docs: SECURITY_CHECK_RULES.md.</p>
      </div>
    </div>

    ${isAdmin ? `<div class="bug-inbox" id="bugInbox">
      <div class="bug-inbox-head">
        <h3 class="bug-card-h">${svg('files', 16)} Inbox</h3>
        <div class="bug-inbox-acts">
          <div class="seg bug-filter" id="bugFilter">
            <button data-f="all" class="on">All</button>
            <button data-f="new">New</button>
            <button data-f="open">Open</button>
            <button data-f="resolved">Resolved</button>
          </div>
          <button class="btn ghost sm" id="bugRefresh">${svg('refresh', 14)} Refresh</button>
        </div>
      </div>
      <div id="bugList"><div class="bug-loading">${svg('bug', 24)}<span>Loading reports…</span></div></div>
    </div>` : ''}
  </div>`;
}

const _bugs = { reports: [], counts: null, filter: 'all' };

function wireBugs() {
  const btn = document.getElementById('bugSubmitBtn');
  if (btn) btn.onclick = submitBugReport;
  if (ACCOUNT && ACCOUNT.is_admin) {
    const refresh = document.getElementById('bugRefresh');
    if (refresh) refresh.onclick = () => loadBugs();
    const filter = document.getElementById('bugFilter');
    if (filter) filter.querySelectorAll('button').forEach(b => b.onclick = () => {
      _bugs.filter = b.dataset.f;
      filter.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      renderBugList();
    });
    loadBugs();
  }
}

async function submitBugReport() {
  const btn = document.getElementById('bugSubmitBtn');
  const msg = document.getElementById('bugFormMsg');
  const area = document.getElementById('bugArea').value;
  const severity = document.getElementById('bugSeverity').value;
  const title = document.getElementById('bugTitleInput').value.trim();
  const body = document.getElementById('bugBodyInput').value.trim();
  if (msg) { msg.textContent = ''; msg.className = 'bug-form-msg'; }
  if (!title || !body) {
    if (msg) { msg.textContent = 'Add a title and a description.'; msg.className = 'bug-form-msg err'; }
    return;
  }
  btn.disabled = true;
  try {
    await bugSubmit({ area, severity, title, body, url: location.pathname });
    document.getElementById('bugTitleInput').value = '';
    document.getElementById('bugBodyInput').value = '';
    if (msg) { msg.textContent = 'Thanks — your report was sent.'; msg.className = 'bug-form-msg ok'; }
    toast('Bug report sent', 'check');
    if (ACCOUNT && ACCOUNT.is_admin) loadBugs();
  } catch (e) {
    if (e && e.code === 'AUTH') return relock();
    if (msg) { msg.textContent = (e && e.message) || 'Could not send report.'; msg.className = 'bug-form-msg err'; }
  } finally { btn.disabled = false; }
}

async function loadBugs() {
  const list = document.getElementById('bugList');
  if (!list) return;
  try {
    const data = await bugList();
    _bugs.reports = data.reports || [];
    _bugs.counts = data.counts || null;
    renderBugList();
  } catch (e) {
    if (e && e.code === 'AUTH') return relock();
    list.innerHTML = `<div class="bug-loading">${svg('info', 22)}<span>Couldn't load the inbox.</span></div>`;
  }
}

function renderBugList() {
  const list = document.getElementById('bugList');
  if (!list) return;
  const f = _bugs.filter;
  const rows = _bugs.reports.filter(r => f === 'all' ? true : r.status === f);
  if (!rows.length) {
    list.innerHTML = `<div class="bug-empty mono">${svg('check', 22)} <span>${_bugs.reports.length ? 'Nothing here with that filter.' : 'No bug reports yet.'}</span></div>`;
    return;
  }
  list.innerHTML = rows.map(bugRowHTML).join('');
  list.querySelectorAll('[data-bug]').forEach(card => {
    const id = card.dataset.bug;
    card.querySelectorAll('[data-status]').forEach(b => b.onclick = () => setBugStatus(id, b.dataset.status));
    const del = card.querySelector('[data-del]'); if (del) del.onclick = () => deleteBugReport(id);
    const note = card.querySelector('[data-note]'); if (note) note.onclick = () => editBugNote(id);
  });
}

function bugRowHTML(r) {
  const when = fmtDate(r.created);
  const sevCls = 'sev-' + (r.severity || 'medium');
  const srcLabel = r.source === 'ai' ? 'Automated' : 'Member';
  const who = esc(r.reporter || (r.source === 'ai' ? 'Automated assistant' : 'Someone'));
  return `<div class="bug-row ${r.status}" data-bug="${esc(r.id)}">
    <div class="bug-row-top">
      <span class="bug-sev ${sevCls}">${esc(r.severity || 'medium')}</span>
      <span class="bug-row-title">${esc(r.title)}</span>
      <span class="bug-status-tag ${r.status}">${esc(BUG_STATUS_LABEL[r.status] || r.status)}</span>
    </div>
    <div class="bug-row-meta mono">
      <span class="bug-src ${r.source}">${svg(r.source === 'ai' ? 'brain' : 'user', 12)} ${srcLabel}</span>
      · ${who}${r.area ? ` · ${esc(r.area)}` : ''} · ${esc(when)}
    </div>
    <div class="bug-row-body">${esc(r.body)}</div>
    ${r.notes ? `<div class="bug-row-notes"><span class="eyebrow">Admin notes</span>${esc(r.notes)}</div>` : ''}
    <div class="bug-row-acts">
      <button class="btn ghost sm" data-status="open" ${r.status === 'open' ? 'disabled' : ''}>Open</button>
      <button class="btn ghost sm" data-status="resolved" ${r.status === 'resolved' ? 'disabled' : ''}>${svg('check', 13)} Resolve</button>
      <button class="btn ghost sm" data-status="wontfix" ${r.status === 'wontfix' ? 'disabled' : ''}>Won't fix</button>
      <button class="btn ghost sm" data-note>${svg('rename', 13)} Note</button>
      <button class="btn ghost sm danger" data-del>${svg('trash', 13)}</button>
    </div>
  </div>`;
}

async function setBugStatus(id, status) {
  try { await bugUpdate(id, { status }); const r = _bugs.reports.find(x => x.id === id); if (r) r.status = status; renderBugList(); toast('Updated', 'check'); }
  catch (e) { if (e && e.code === 'AUTH') return relock(); toast('Could not update', 'close'); }
}
function editBugNote(id) {
  const r = _bugs.reports.find(x => x.id === id); if (!r) return;
  modal('Admin note', 'Internal triage note for this report.', r.notes || '', async v => {
    try { await bugUpdate(id, { notes: v }); r.notes = v; renderBugList(); toast('Note saved', 'check'); }
    catch (e) { toast('Could not save note', 'close'); }
  });
}
function deleteBugReport(id) {
  confirmModal('Delete report?', 'This permanently removes the bug report. This cannot be undone.', async () => {
    try { await bugDelete(id); _bugs.reports = _bugs.reports.filter(x => x.id !== id); renderBugList(); toast('Deleted'); }
    catch (e) { toast('Could not delete', 'close'); }
  }, 'Delete');
}


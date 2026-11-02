/* ============================================================
   MUSIC + JAM apps (apps-music.js) — the Music library/playlist SCREEN and the
   listen-together Jam system, extracted from app.js and loaded on demand (openApp
   -> openLazyApp -> loadFeature("apps-music"); the now-playing overlay Jam button
   also lazy-loads this). The persistent PLAYER + EQ stay in core (music keeps
   playing across navigation). These CORE bits stay in app.js because the Player/Jam
   touch them live even before this file loads: the MU state object, muOnMusic(),
   muProgressiveImgHTML(), and musicOpenPlaylist(). Plain non-module script sharing
   app.js global scope. See [[lazy-loading-architecture]] and [[music-app]].
   ============================================================ */
/* ============================================================
   MUSIC APP

   A global shared library (everyone sees every uploaded song), public/private
   playlists, and live "jam" sessions where people listen in sync (~1s polling) with
   shared controls. Songs are copied into the Music store on add (see server.js), so
   the library is shared and independent of any one vault.

   Playback runs through the persistent global Player (app.js) — the SAME player the
   Database uses: 10-band EQ, between-song crossfade, the now-playing visual, the
   docked mini-player that keeps playing as you navigate. muPlay() just hands a list of
   Music track objects to the Player; the Player streams them via _resolveMediaSrc
   (their `url` is /api/music/tracks/:id/raw). SHUFFLE (a real Fisher–Yates permutation
   in Player.order) and LOOP (Player.loop) are the Player's, shared with Database audio.

   In a JAM, the server's jam state is the source of truth for queue/order/idx/pos/
   paused/shuffle/loop; the jam layer here drives the Player and the now-playing controls
   double as shared jam controls (every member can control, ~1s sync). EQ + crossfade
   stay each listener's PERSONAL settings (PREFS.eq / fade) — they are never synced.
   ============================================================ */

/* Music playback runs through the persistent global Player (EQ, crossfade, mini-dock,
   now-playing visual, plays-while-you-navigate) — see muPlay below. MU only holds the
   app's own view state + the jam session bookkeeping; the audio element, queue, order,
   shuffle and loop all live on Player. */

function musicHTML() {
  return `<div class="mu-app" data-screen-label="Music">
    <div class="mu-head">
      <div>
        <h2 class="mu-title">${svg('audio', 20, 1.8)} Music</h2>
        <p class="mu-sub">A shared library everyone can hear. Make playlists, then jam — listen together, in sync.</p>
      </div>
      <div class="mu-head-acts">
        <button class="btn primary sm" id="muAdd">${svg('plus', 14)} Add from vault</button>
        <button class="btn ghost sm" id="muRefresh">${svg('refresh', 14)} Refresh</button>
      </div>
    </div>
    <div class="mu-tabs" id="muTabs"></div>
    <div id="muBody"><div class="mu-loading">${svg('audio', 28)}<span>Loading the music…</span></div></div>
  </div>`;
}

/* render the tab strip — the Reports tab only appears for admins when open reports
   exist. Wires tab clicks. */
function muRenderTabs() {
  const el = document.getElementById('muTabs'); if (!el) return;
  const isAdmin = !!(ACCOUNT && ACCOUNT.is_admin);
  const tabs = [
    { id: 'library', icon: 'audio', label: 'Library' },
    { id: 'playlists', icon: 'listul', label: 'Playlists' },
    { id: 'jams', icon: 'user', label: 'Jams' },
  ];
  if (isAdmin && MU.reportCount > 0) tabs.push({ id: 'reports', icon: 'bug', label: `Reports`, badge: MU.reportCount });
  // if the Reports tab vanished while selected, fall back to Library
  if (MU.tab === 'reports' && !(isAdmin && MU.reportCount > 0)) MU.tab = 'library';
  el.innerHTML = tabs.map(t => `<button class="mu-tab ${t.id === MU.tab ? 'on' : ''}" data-mtab="${t.id}">${svg(t.icon, 14)} ${t.label}${t.badge ? `<span class="mu-tab-badge">${t.badge}</span>` : ''}</button>`).join('');
  el.querySelectorAll('[data-mtab]').forEach(b => b.onclick = () => { MU.tab = b.dataset.mtab; MU.openPlaylist = null; MU.selectMode = false; MU.selected.clear(); muRenderTabs(); renderMusicBody(); });
}

async function wireMusic() {
  const add = document.getElementById('muAdd');
  const refresh = document.getElementById('muRefresh');
  if (add) add.onclick = muAddFromVault;
  if (refresh) refresh.onclick = () => loadMusic();
  muRenderTabs();
  // NB: do NOT stop the jam poll on app-leave — playback (and the jam) continue in the
  // dock as you navigate, exactly like Database audio. The jam tears down on leave/close.
  _appCleanup = null;
  await loadMusic();
}

/* start a Music queue playing through the global Player. */
function muPlay(tracks, startIdx, label, shuffle) {
  const list = (tracks || []).filter(Boolean);
  if (!list.length) return;
  if (Player.jam) muLeaveJam(true);                 // starting a fresh local queue leaves any jam
  Player.kind = 'audio';
  Player.list = list.slice();
  Player.idx = Math.max(0, Math.min(list.length - 1, startIdx || 0));
  Player.loop = false;
  playerSetShuffle(!!shuffle);
  Player.expanded = true;
  void loadAudio(Player.idx, true);
  renderNowPlaying();
}

async function loadMusic() {
  const body = document.getElementById('muBody');
  if (!body) return;
  try {
    const isAdmin = !!(ACCOUNT && ACCOUNT.is_admin);
    const [lib, pls, spot, rc] = await Promise.all([
      musicLibrary(), musicPlaylists(),
      musicSpotlight().catch(() => ({ tracks: [] })),   // server-picked, stable until midnight
      isAdmin ? musicReportsCount().catch(() => ({ open: 0 })) : Promise.resolve({ open: 0 }),
    ]);
    MU.tracks = lib.tracks || [];
    MU.playlists = pls.playlists || [];
    MU.spotlight = spot.tracks || [];
    MU.reportCount = rc.open || 0;
    if (!muOnMusic()) return;
    muRenderTabs();
    renderMusicBody();
  } catch (e) {
    if (e && e.code === 'AUTH') return relock();
    body.innerHTML = `<div class="mu-loading">${svg('info', 24)}<span>Couldn't load the music.</span></div>`;
  }
}

function muTrackById(id) { return MU.tracks.find(t => t.id === id) || (Player.list || []).find(t => t.id === id); }

function renderMusicBody() {
  document.querySelectorAll('#muTabs [data-mtab]').forEach(b => b.classList.toggle('on', b.dataset.mtab === MU.tab));
  const body = document.getElementById('muBody');
  if (!body) return;
  if (MU.openPlaylist) body.innerHTML = muPlaylistDetailHTML();
  else if (MU.tab === 'library') body.innerHTML = muLibraryHTML();
  else if (MU.tab === 'playlists') body.innerHTML = muPlaylistsHTML();
  else if (MU.tab === 'reports') body.innerHTML = muReportsHTML();
  else body.innerHTML = muJamsHTML();
  wireMusicBody();
  muObserveCovers(body);   // lazy-load covers only as they scroll into view
}

/* html for a big progressive cover image (now-playing album, song drawer) — starts
   low-res, upgraded by CoverLoader.wire() on the rendered container. */

/* Covers are LAZY: emit an <img> with NO src and the url on data-cover. An
   IntersectionObserver (muObserveCovers) sets src only when the card scrolls near the
   viewport, so a big library doesn't fetch hundreds of covers up front. Once visible
   they load low-res first and upgrade through CoverLoader. */
function muCoverHTML(t, size) {
  if (t && t.coverUrl) return `<img class="mu-cover lazy" data-cover="${t.coverUrl}" alt="" decoding="async" />`;
  return `<div class="mu-cover mu-cover-ph">${svg('audio', size || 22)}</div>`;
}
let _muCoverObs = null;
function muObserveCovers(root) {
  if (!('IntersectionObserver' in window)) {   // no observer support → just load them
    (root || document).querySelectorAll('img.mu-cover.lazy[data-cover]').forEach(img => { CoverLoader.progressive(img, img.dataset.cover); img.classList.remove('lazy'); });
    return;
  }
  if (!_muCoverObs) {
    _muCoverObs = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target; obs.unobserve(img);
        if (img.dataset.cover) { CoverLoader.progressive(img, img.dataset.cover); img.classList.remove('lazy'); }
      }
    }, { root: null, rootMargin: '300px' });   // start loading a bit before they're visible
  }
  (root || document).querySelectorAll('img.mu-cover.lazy[data-cover]').forEach(img => _muCoverObs.observe(img));
}
function muMeta(t) { return esc(t.artist || t.ownerName || 'Unknown'); }
/* "1 hr 23 min", "23 min", "45 sec" — for playlist totals. */
function muFmtLong(sec) {
  sec = Math.round(Number(sec) || 0);
  if (sec <= 0) return '0 min';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h} hr${h !== 1 ? 's' : ''} ${m} min`;
  if (m) return `${m} min`;
  return `${s} sec`;
}

/* one library card (grid). In select mode it shows a tick instead of play/more. */
function muTrackCardHTML(t, sel) {
  return `<div class="mu-card ${sel ? 'selectable' : ''} ${sel && MU.selected.has(t.id) ? 'sel' : ''}" data-track="${t.id}">
      <div class="mu-card-art">
        ${muCoverHTML(t, 30)}
        ${sel ? `<span class="mu-card-tick">${svg('check', 14)}</span>` : `<button class="mu-play-btn" data-play="${t.id}" title="Play">${svg('play', 18)}</button>`}
      </div>
      <div class="mu-card-title" title="${esc(t.title)}">${esc(t.title)}</div>
      <div class="mu-card-sub">${muMeta(t)}</div>
      ${sel ? '' : `<button class="mu-card-more" data-more="${t.id}" title="More">${svg('more', 16)}</button>`}
    </div>`;
}
/* the 3 spotlight tracks the SERVER picked for today (stable until midnight). */
function muSpotlightTracks() { return (MU.spotlight || []).filter(Boolean); }

function muLibraryHTML() {
  if (!MU.tracks.length) {
    return `<div class="mu-empty">${svg('audio', 30)}<h3>No songs yet</h3><p>Add audio from your vault to start the shared library.</p>
      <button class="btn primary" id="muEmptyAdd">${svg('plus', 14)} Add from vault</button></div>`;
  }
  const me = (ACCOUNT && ACCOUNT.id) || null;
  const isAdmin = !!(ACCOUNT && ACCOUNT.is_admin);
  const sel = MU.selectMode;
  const q = MU.search.trim().toLowerCase();
  const matches = q
    ? MU.tracks.filter(t => (t.title || '').toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q) || (t.ownerName || '').toLowerCase().includes(q))
    : MU.tracks;

  // ---- select mode: just the action bar + the whole grid (selecting across search) ----
  if (sel) {
    const head = `<div class="mu-libhead mu-selbar">
        <span class="mu-count">${MU.selected.size} selected</span>
        <button class="btn sm" id="muSelAll">${svg('checksq', 14)} ${MU.selected.size === MU.tracks.length ? 'None' : 'All'}</button>
        <span class="mu-sel-spacer"></span>
        <button class="btn sm" id="muSelAddPl" ${MU.selected.size ? '' : 'disabled'}>${svg('plus', 14)} Add to playlist</button>
        ${(me || isAdmin) ? `<button class="btn sm danger" id="muSelDelete" ${MU.selected.size ? '' : 'disabled'}>${svg('trash', 14)} Remove</button>` : ''}
        <button class="btn ghost sm" id="muSelDone">Done</button>
      </div>`;
    return `${head}<div class="mu-grid">${MU.tracks.map(t => muTrackCardHTML(t, true)).join('')}</div>`;
  }

  // ---- Today's Spotlight (hidden while searching) ----
  const spot = muSpotlightTracks();
  const spotlight = (q || spot.length === 0) ? '' : `
    <div class="mu-section">
      <div class="mu-section-head"><h3>${svg('spark', 16)} Today's Spotlight</h3><span class="mu-section-sub">Fresh picks from the latest uploads</span></div>
      <div class="mu-spotlight">${spot.map(t => `
        <button class="mu-spot-card" data-spot="${t.id}">
          ${muCoverHTML(t, 34)}
          <div class="mu-spot-meta"><div class="mu-spot-title">${esc(t.title)}</div><div class="mu-spot-sub">${muMeta(t)}</div></div>
          <span class="mu-spot-play">${svg('play', 16)}</span>
        </button>`).join('')}</div>
    </div>`;

  // ---- Full Library (search + grid) ----
  const grid = matches.length
    ? `<div class="mu-grid">${matches.map(t => muTrackCardHTML(t, false)).join('')}</div>`
    : `<div class="mu-empty sm">${svg('audio', 24)}<p>No songs match “${esc(MU.search)}”.</p></div>`;
  const libHead = `<div class="mu-section">
      <div class="mu-section-head">
        <h3>${svg('audio', 16)} Full Library</h3>
        <div class="mu-libtools">
          <div class="mu-libsearch">${svg('audio', 13)}<input id="muLibSearch" placeholder="Search songs, artists, uploaders…" autocomplete="off" value="${esc(MU.search)}" />${q ? `<button class="mu-libsearch-x" id="muLibSearchX" title="Clear">${svg('close', 13)}</button>` : ''}</div>
          <button class="btn ghost sm" id="muSelect" title="Select multiple">${svg('checksq', 14)}</button>
        </div>
      </div>
      <div class="mu-libactions">
        <button class="btn sm" id="muPlayAll">${svg('play', 14)} Play ${q ? 'results' : 'all'}</button>
        <button class="btn ghost sm" id="muShuffleAll">${svg('shuffle', 14)} Shuffle ${q ? 'results' : 'all'}</button>
        <span class="mu-count">${matches.length}${q ? ` of ${MU.tracks.length}` : ''} song${matches.length !== 1 ? 's' : ''}</span>
      </div>
    </div>`;
  return `${spotlight}${libHead}${grid}`;
}

function muPlaylistsHTML() {
  const cards = MU.playlists.map(p => `
    <div class="mu-pl-card" data-openpl="${p.id}">
      <div class="mu-pl-art">${svg('listul', 26)}</div>
      <div class="mu-pl-body">
        <div class="mu-pl-name" title="${esc(p.name)}">${esc(p.name)}</div>
        <div class="mu-pl-sub">${p.count} song${p.count !== 1 ? 's' : ''} · ${esc(p.ownerName)} · <span class="${p.public ? 'mu-pub' : 'mu-priv'}">${svg(p.public ? 'globe' : 'lock', 11)} ${p.public ? 'Public' : 'Private'}</span></div>
      </div>
    </div>`).join('');
  return `<div class="mu-libhead">
      <button class="btn primary sm" id="muNewPl">${svg('plus', 14)} New playlist</button>
      <span class="mu-count">${MU.playlists.length} playlist${MU.playlists.length !== 1 ? 's' : ''}</span>
    </div>
    ${MU.playlists.length ? `<div class="mu-pl-grid">${cards}</div>` : `<div class="mu-empty">${svg('listul', 30)}<h3>No playlists yet</h3><p>Create one, then add songs from the library.</p></div>`}`;
}

function muPlaylistDetailHTML() {
  const { playlist: p, tracks } = MU.openPlaylist;
  const canManage = !!p.canManage;   // owner/admin: rename, delete, editors
  const canEdit = !!p.canEdit;       // + trusted editors: add/remove/reorder tracks
  const editors = p.editors || [];
  const rows = tracks.length ? tracks.map((t, i) => `
    <div class="mu-row" data-track="${t.id}" data-rowidx="${i}" ${canEdit ? 'draggable="true"' : ''}>
      ${canEdit ? `<span class="mu-row-grip" title="Drag to reorder">${svg('move', 13)}</span>` : ''}
      <span class="mu-row-n">${i + 1}</span>
      <button class="mu-row-play" data-plplay="${i}" title="Play">${svg('play', 14)}</button>
      ${muCoverHTML(t, 16)}
      <div class="mu-row-meta"><div class="mu-row-title">${esc(t.title)}</div><div class="mu-row-sub">${muMeta(t)}</div></div>
      <span class="mu-row-dur">${t.dur ? fmtDur(t.dur) : ''}</span>
      ${canEdit ? `<button class="mu-row-x" data-plremove="${t.id}" title="Remove from playlist">${svg('close', 14)}</button>` : ''}
    </div>`).join('') : `<div class="mu-empty sm">${svg('audio', 24)}<p>This playlist is empty.${canEdit ? ' Add songs from the library.' : ''}</p></div>`;
  const editorLine = editors.length
    ? `<div class="mu-pldetail-editors">${svg('user', 12)} Editors: ${editors.map(e => esc(e.name)).join(', ')}</div>`
    : '';
  const total = p.totalDuration || 0, avg = p.avgDuration || 0;
  const durLine = tracks.length ? ` · ${muFmtLong(total)} · avg ${fmtDur(avg)}` : '';
  return `<div class="mu-pldetail">
    <div class="mu-pldetail-head">
      <button class="btn ghost sm" id="muPlBack">${svg('back', 14)} Back</button>
      <div class="mu-pldetail-info">
        <div class="mu-pldetail-name">${esc(p.name)}</div>
        <div class="mu-pldetail-sub">${tracks.length} song${tracks.length !== 1 ? 's' : ''}${durLine} · ${esc(p.ownerName)} · <span class="${p.public ? 'mu-pub' : 'mu-priv'}">${svg(p.public ? 'globe' : 'lock', 11)} ${p.public ? 'Public' : 'Private'}</span></div>
        ${editorLine}
      </div>
      <div class="mu-pldetail-acts">
        <button class="btn sm" id="muPlPlay" ${tracks.length ? '' : 'disabled'}>${svg('play', 14)} Play</button>
        <button class="btn ghost sm" id="muPlShuffle" ${tracks.length ? '' : 'disabled'}>${svg('shuffle', 14)} Shuffle</button>
        ${canEdit ? `<button class="btn ghost sm" id="muPlAddSongs" title="Add songs from the library">${svg('plus', 14)}</button>` : ''}
        ${canManage ? `<button class="btn ghost sm" id="muPlEditors" title="Trusted Editors">${svg('user', 14)}</button>` : ''}
        ${canManage ? `<button class="btn ghost sm" id="muPlEdit" title="Rename / visibility">${svg('rename', 14)}</button>` : ''}
        ${canManage ? `<button class="btn ghost sm danger" id="muPlDelete" title="Delete playlist">${svg('trash', 14)}</button>` : ''}
      </div>
    </div>
    <div class="mu-list">${rows}</div>
  </div>`;
}

function muJamsHTML() {
  return `<div class="mu-jamtab">
    <div class="mu-loading sm">${svg('user', 22)}<span>Loading live jams…</span></div>
  </div>`;
}

function muReportsHTML() {
  return `<div class="mu-reports">
    <div class="mu-loading sm">${svg('bug', 22)}<span>Loading reports…</span></div>
  </div>`;
}
async function muLoadReports() {
  const wrap = document.querySelector('#muBody .mu-reports'); if (!wrap) return;
  let data;
  try { data = await musicReports(); } catch (e) { wrap.innerHTML = `<div class="mu-loading sm">${svg('info', 22)}<span>Couldn't load reports.</span></div>`; return; }
  if (!muOnMusic() || MU.tab !== 'reports') return;
  MU.reportCount = data.open || 0; muRenderTabs();
  const reports = data.reports || [];
  if (!reports.length) {
    wrap.innerHTML = `<div class="mu-empty">${svg('check', 30)}<h3>No open reports</h3><p>Reported songs will show up here for review.</p></div>`;
    return;
  }
  const reasonLabel = (r) => r === 'duplicate' ? 'Duplicate' : 'Other';
  wrap.innerHTML = `<div class="mu-libhead"><span class="mu-count">${reports.length} open report${reports.length !== 1 ? 's' : ''}</span></div>` +
    reports.map(r => {
      const t = muTrackById(r.trackId);
      return `<div class="mu-report" data-rid="${r.id}">
        <div class="mu-report-main">
          <div class="mu-report-title">${svg('audio', 13)} ${esc(r.trackTitle || (t && t.title) || 'Unknown song')}<span class="mu-report-reason mu-report-${r.reason}">${reasonLabel(r.reason)}</span></div>
          <div class="mu-report-meta">Reported by ${esc(r.reporter)} · ${fmtDate ? fmtDate(r.created) : new Date(r.created).toLocaleString()}</div>
          ${r.detail ? `<div class="mu-report-detail">“${esc(r.detail)}”</div>` : ''}
        </div>
        <div class="mu-report-acts">
          ${t ? `<button class="btn ghost sm" data-rplay="${r.trackId}" title="Play the song">${svg('play', 13)}</button>` : ''}
          <button class="btn ghost sm danger" data-rremove="${r.trackId}" title="Remove the song from Music">${svg('trash', 13)} Remove song</button>
          <button class="btn sm" data-rresolve="${r.id}" title="Mark handled">${svg('check', 13)} Resolve</button>
          <button class="btn ghost sm" data-rdismiss="${r.id}" title="Ignore this report">Dismiss</button>
        </div>
      </div>`;
    }).join('');
  wrap.querySelectorAll('[data-rplay]').forEach(el => el.onclick = () => { const t = muTrackById(el.dataset.rplay); if (t) muPlay([t], 0, t.title, false); });
  wrap.querySelectorAll('[data-rresolve]').forEach(el => el.onclick = async () => {
    try { const r = await musicResolveReport(el.dataset.rresolve); MU.reportCount = r.open || 0; toast('Resolved'); muLoadReports(); } catch (e) { toast(e.message || 'Failed', 'close'); }
  });
  wrap.querySelectorAll('[data-rdismiss]').forEach(el => el.onclick = async () => {
    try { const r = await musicDismissReport(el.dataset.rdismiss); MU.reportCount = r.open || 0; toast('Dismissed'); muLoadReports(); } catch (e) { toast(e.message || 'Failed', 'close'); }
  });
  wrap.querySelectorAll('[data-rremove]').forEach(el => el.onclick = () => {
    const tid = el.dataset.rremove; const t = muTrackById(tid);
    confirmModal('Remove this song?', `“${t ? t.title : 'This song'}” will be removed from Music for everyone, and its reports cleared.`, async () => {
      try { await musicRemoveTrack(tid); toast('Song removed'); await loadMusic(); if (MU.tab === 'reports') muLoadReports(); } catch (e) { toast(e.message || 'Failed', 'close'); }
    }, 'Remove');
  });
}

function wireMusicBody() {
  const b = document.getElementById('muBody'); if (!b) return;
  // library — the list of tracks currently shown (filtered by search) drives Play/Shuffle
  const q = MU.search.trim().toLowerCase();
  const shown = q
    ? MU.tracks.filter(t => (t.title || '').toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q) || (t.ownerName || '').toLowerCase().includes(q))
    : MU.tracks;
  const ea = b.querySelector('#muEmptyAdd'); if (ea) ea.onclick = muAddFromVault;
  const pa = b.querySelector('#muPlayAll'); if (pa) pa.onclick = () => muPlay(shown, 0, q ? 'Search' : 'Library', false);
  const sa = b.querySelector('#muShuffleAll'); if (sa) sa.onclick = () => muPlay(shown, 0, q ? 'Search' : 'Library', true);
  // Today's Spotlight cards
  b.querySelectorAll('[data-spot]').forEach(el => el.onclick = () => { const t = muTrackById(el.dataset.spot); if (t) muPlay([t], 0, 'Spotlight', false); });
  // search box (preserve focus + caret across the re-render)
  const sb = b.querySelector('#muLibSearch');
  if (sb) {
    sb.oninput = (e) => {
      MU.search = e.target.value;
      const caret = e.target.selectionStart;
      renderMusicBody();
      const ns = document.getElementById('muLibSearch'); if (ns) { ns.focus(); try { ns.setSelectionRange(caret, caret); } catch (_) {} }
    };
    sb.onkeydown = (e) => { if (e.key === 'Escape') { MU.search = ''; renderMusicBody(); const ns = document.getElementById('muLibSearch'); if (ns) ns.focus(); } };
  }
  const sx = b.querySelector('#muLibSearchX'); if (sx) sx.onclick = () => { MU.search = ''; renderMusicBody(); const ns = document.getElementById('muLibSearch'); if (ns) ns.focus(); };
  if (MU.selectMode) {
    // in select mode, clicking a card toggles its selection
    b.querySelectorAll('.mu-card[data-track]').forEach(el => el.onclick = () => {
      const id = el.dataset.track;
      if (MU.selected.has(id)) MU.selected.delete(id); else MU.selected.add(id);
      renderMusicBody();
    });
    const all = b.querySelector('#muSelAll'); if (all) all.onclick = () => {
      if (MU.selected.size === MU.tracks.length) MU.selected.clear(); else MU.tracks.forEach(t => MU.selected.add(t.id));
      renderMusicBody();
    };
    const addPl = b.querySelector('#muSelAddPl'); if (addPl) addPl.onclick = () => muBatchAddToPlaylist([...MU.selected]);
    const del = b.querySelector('#muSelDelete'); if (del) del.onclick = () => muBatchRemove([...MU.selected]);
    const done = b.querySelector('#muSelDone'); if (done) done.onclick = () => { MU.selectMode = false; MU.selected.clear(); renderMusicBody(); };
  } else {
    // play button (hover) plays; clicking the card body opens the song detail drawer
    b.querySelectorAll('.mu-grid [data-play]').forEach(el => el.onclick = (e) => { e.stopPropagation(); muPlay(shown, shown.findIndex(t => t.id === el.dataset.play), q ? 'Search' : 'Library', false); });
    b.querySelectorAll('.mu-grid .mu-card[data-track]').forEach(card => {
      card.onclick = (e) => { if (e.target.closest('[data-play],[data-more]')) return; muOpenSong(card.dataset.track); };
      card.oncontextmenu = (e) => { e.preventDefault(); muLibraryRowMenu(e.clientX, e.clientY, card.dataset.track); };
    });
    b.querySelectorAll('[data-more]').forEach(el => el.onclick = (e) => { e.stopPropagation(); const r = el.getBoundingClientRect(); muLibraryRowMenu(r.right, r.bottom, el.dataset.more); });
    const select = b.querySelector('#muSelect'); if (select) select.onclick = () => { MU.selectMode = true; MU.selected.clear(); renderMusicBody(); };
  }
  // playlists list
  const np = b.querySelector('#muNewPl'); if (np) np.onclick = muNewPlaylist;
  b.querySelectorAll('[data-openpl]').forEach(el => el.onclick = () => musicOpenPlaylist(el.dataset.openpl));
  // playlist detail
  const back = b.querySelector('#muPlBack'); if (back) back.onclick = () => { MU.openPlaylist = null; MU.tab = 'playlists'; renderMusicBody(); };
  if (MU.openPlaylist) {
    const { tracks, playlist: p } = MU.openPlaylist;
    const canManage = !!p.canManage, canEdit = !!p.canEdit;
    const play = b.querySelector('#muPlPlay'); if (play) play.onclick = () => muPlay(tracks, 0, p.name, false);
    const shuf = b.querySelector('#muPlShuffle'); if (shuf) shuf.onclick = () => muPlay(tracks, 0, p.name, true);
    b.querySelectorAll('[data-plplay]').forEach(el => el.onclick = () => muPlay(tracks, Number(el.dataset.plplay), p.name, false));
    if (canEdit) {
      b.querySelectorAll('[data-plremove]').forEach(el => el.onclick = async (e) => {
        e.stopPropagation();
        try { await musicRemoveFromPlaylist(p.id, el.dataset.plremove); toast('Removed'); await musicOpenPlaylist(p.id); } catch (e) { toast(e.message || 'Failed', 'close'); }
      });
      const addSongs = b.querySelector('#muPlAddSongs'); if (addSongs) addSongs.onclick = () => muAddSongsToPlaylist(p);
      // right-click a row → reorder / remove menu
      b.querySelectorAll('.mu-row[data-track]').forEach(row => row.oncontextmenu = (e) => { e.preventDefault(); muPlaylistRowMenu(e.clientX, e.clientY, p, Number(row.dataset.rowidx)); });
      muWirePlaylistDrag(b, p);
    }
    if (canManage) {
      const eds = b.querySelector('#muPlEditors'); if (eds) eds.onclick = () => muManageEditors(p);
      const ed = b.querySelector('#muPlEdit'); if (ed) ed.onclick = () => muEditPlaylist(p);
      const del = b.querySelector('#muPlDelete'); if (del) del.onclick = () => confirmModal('Delete playlist?', `"${p.name}" will be removed. The songs stay in the library.`, async () => {
        try { await musicDeletePlaylist(p.id); toast('Playlist deleted'); MU.openPlaylist = null; MU.tab = 'playlists'; await loadMusic(); } catch (e) { toast(e.message || 'Failed', 'close'); }
      }, 'Delete');
    }
  }
  if (MU.tab === 'jams' && !MU.openPlaylist) muLoadJams();
  if (MU.tab === 'reports' && !MU.openPlaylist) muLoadReports();
}

/* pick library songs to add to THIS playlist (for editors who can't multi-select the
   global library into a specific playlist easily). Reuses the library track list. */
function muAddSongsToPlaylist(p) {
  const have = new Set((MU.openPlaylist.tracks || []).map(t => t.id));
  const avail = MU.tracks.filter(t => !have.has(t.id));
  muSongPicker({
    title: `Add songs to “${p.name}”`,
    dek: 'Pick songs from the shared library to add to this playlist.',
    searchPlaceholder: 'Search the library…',
    emptyText: 'Every library song is already in this playlist.',
    items: avail,
    get: { id: t => t.id, title: t => t.title, artist: t => t.artist || t.ownerName, cover: t => t.coverUrl || null, size: t => t.size, dur: t => t.dur },
    confirmLabel: n => `Add ${n} song${n !== 1 ? 's' : ''}`,
    countText: n => `${n} song${n !== 1 ? 's' : ''} to choose from`,
    onConfirm: async (ids) => {
      let added = 0, fail = 0;
      toast(`Adding ${ids.length} song${ids.length !== 1 ? 's' : ''}…`);
      for (const id of ids) { try { await musicAddToPlaylist(p.id, id); added++; } catch (e) { fail++; } }
      toast(`${added} added${fail ? ' · ' + fail + ' failed' : ''}`, fail ? 'close' : 'save');
      await musicOpenPlaylist(p.id);
    },
  });
}

/* move a track within the open playlist from one index to another, optimistically
   updating the UI then persisting the new order. */
async function muPlaylistReorder(p, fromIdx, toIdx) {
  const tracks = (MU.openPlaylist && MU.openPlaylist.tracks) || [];
  if (fromIdx < 0 || fromIdx >= tracks.length) return;
  toIdx = Math.max(0, Math.min(tracks.length - 1, toIdx));
  if (toIdx === fromIdx) return;
  const next = tracks.slice();
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  MU.openPlaylist.tracks = next;     // optimistic
  renderMusicBody();
  try { await musicReorderPlaylist(p.id, next.map(t => t.id)); }
  catch (e) { toast(e.message || 'Could not reorder', 'close'); await musicOpenPlaylist(p.id); }
}

/* right-click menu for a playlist row: play, remove, and move actions (incl. a
   "Move down by N" submenu). */
function muPlaylistRowMenu(x, y, p, idx) {
  if (typeof hideCtx === 'function') hideCtx();
  const tracks = (MU.openPlaylist && MU.openPlaylist.tracks) || [];
  const t = tracks[idx]; if (!t) return;
  const n = tracks.length;
  const items = [{ head: t.title }];
  items.push({ ic: 'play', label: 'Play', fn: () => muPlay(tracks, idx, p.name, false) });
  items.push({ div: true });
  if (idx > 0) items.push({ ic: 'arrowup', label: 'Move up', fn: () => muPlaylistReorder(p, idx, idx - 1) });
  if (idx < n - 1) items.push({ ic: 'arrowdown', label: 'Move down', fn: () => muPlaylistReorder(p, idx, idx + 1) });
  if (idx > 0) items.push({ ic: 'arrowup', label: 'Move to top', fn: () => muPlaylistReorder(p, idx, 0) });
  if (idx < n - 1) items.push({ ic: 'arrowdown', label: 'Move to bottom', fn: () => muPlaylistReorder(p, idx, n - 1) });
  // "move down by N" submenu (and up by N), for jumping several spots at once
  if (n > 2) {
    const downBy = []; for (let k = 2; k <= Math.min(n - 1 - idx, 10); k++) downBy.push({ ic: 'arrowdown', label: `${k} spots`, fn: () => muPlaylistReorder(p, idx, idx + k) });
    const upBy = []; for (let k = 2; k <= Math.min(idx, 10); k++) upBy.push({ ic: 'arrowup', label: `${k} spots`, fn: () => muPlaylistReorder(p, idx, idx - k) });
    if (downBy.length) items.push({ ic: 'arrowdown', label: 'Move down by…', sub: downBy });
    if (upBy.length) items.push({ ic: 'arrowup', label: 'Move up by…', sub: upBy });
  }
  items.push({ div: true });
  items.push({ ic: 'trash', label: 'Remove from playlist', danger: true, fn: async () => {
    try { await musicRemoveFromPlaylist(p.id, t.id); toast('Removed'); await musicOpenPlaylist(p.id); } catch (e) { toast(e.message || 'Failed', 'close'); }
  } });
  const panel = buildCtxPanel(items);
  document.body.appendChild(panel);
  if (typeof ctxEl !== 'undefined') ctxEl = panel;
  const r = panel.getBoundingClientRect();
  panel.style.left = Math.min(x, innerWidth - r.width - 10) + 'px';
  panel.style.top = Math.min(y, innerHeight - r.height - 10) + 'px';
}

/* HTML5 drag-and-drop reordering of playlist rows. */
function muWirePlaylistDrag(b, p) {
  let dragFrom = -1;
  b.querySelectorAll('.mu-row[draggable="true"]').forEach(row => {
    row.ondragstart = (e) => { dragFrom = Number(row.dataset.rowidx); row.classList.add('dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragFrom)); } catch (_) {} };
    row.ondragend = () => { row.classList.remove('dragging'); b.querySelectorAll('.mu-row.drop-above,.mu-row.drop-below').forEach(r => r.classList.remove('drop-above', 'drop-below')); };
    row.ondragover = (e) => {
      e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
      const rect = row.getBoundingClientRect(); const after = e.clientY > rect.top + rect.height / 2;
      b.querySelectorAll('.mu-row.drop-above,.mu-row.drop-below').forEach(r => r.classList.remove('drop-above', 'drop-below'));
      row.classList.add(after ? 'drop-below' : 'drop-above');
    };
    row.ondrop = (e) => {
      e.preventDefault();
      const to0 = Number(row.dataset.rowidx);
      const rect = row.getBoundingClientRect(); const after = e.clientY > rect.top + rect.height / 2;
      let to = after ? to0 + 1 : to0;
      if (dragFrom < to) to -= 1;   // account for the removed source slot
      muPlaylistReorder(p, dragFrom, to);
    };
  });
}

/* owner/admin: choose Trusted Editors (members who can add/remove songs). */
async function muManageEditors(p) {
  let members = [];
  try { members = (await musicMembers()).members || []; } catch (e) { toast('Could not load members', 'close'); return; }
  const meId = (ACCOUNT && ACCOUNT.id) || null;
  members = members.filter(m => m.id !== p.ownerId);
  const byId = Object.fromEntries(members.map(m => [m.id, m]));
  const sel = new Set((p.editors || []).map(e => e.id).filter(id => byId[id]));
  // editors saved before but whose account is gone still count; keep their names for chips
  (p.editors || []).forEach(e => { if (!byId[e.id]) { byId[e.id] = { id: e.id, name: e.name }; sel.add(e.id); } });
  let q = '';

  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal mu-menu-modal"><h3>Trusted Editors</h3>
    <p class="mu-pick-dek">Editors can add and remove songs in this playlist. They can't rename, delete, or change who can edit.</p>
    <div class="mu-chips" id="muEdChips"></div>
    <div class="mu-libsearch" style="margin:10px 0">${svg('user', 13)}<input id="muEdSearch" placeholder="Search members by name…" autocomplete="off" /></div>
    <div class="mu-ed-results" id="muEdResults"></div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Save</button></div></div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };

  const chipsEl = bg.querySelector('#muEdChips');
  const resEl = bg.querySelector('#muEdResults');
  const searchEl = bg.querySelector('#muEdSearch');
  function renderChips() {
    chipsEl.innerHTML = sel.size
      ? [...sel].map(id => `<span class="mu-chip" data-rm="${id}">${esc((byId[id] || {}).name || 'Unknown')}<button title="Remove">${svg('close', 11)}</button></span>`).join('')
      : `<span class="mu-chip-empty">No editors yet — search and click members to add them.</span>`;
    chipsEl.querySelectorAll('[data-rm]').forEach(c => c.querySelector('button').onclick = () => { sel.delete(c.dataset.rm); renderChips(); renderResults(); });
  }
  function renderResults() {
    const term = q.trim().toLowerCase();
    const matches = members.filter(m => !term || m.name.toLowerCase().includes(term)).slice(0, 50);
    resEl.innerHTML = matches.length ? matches.map(m => `
      <button type="button" class="mu-ed-row ${sel.has(m.id) ? 'on' : ''}" data-pick="${m.id}">
        <span class="mu-ed-name">${esc(m.name)}${m.id === meId ? ' (you)' : ''}${m.isAdmin ? ' · admin' : ''}</span>
        ${sel.has(m.id) ? svg('check', 14) : `<span class="mu-ed-add">${svg('plus', 13)}</span>`}
      </button>`).join('') : `<div class="mu-menu-note">No members match “${esc(q)}”.</div>`;
    resEl.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
      const id = b.dataset.pick; if (sel.has(id)) sel.delete(id); else sel.add(id);
      renderChips(); renderResults();
    });
  }
  searchEl.oninput = (e) => { q = e.target.value; renderResults(); };
  bg.querySelector('[data-ok]').onclick = async () => {
    close();
    try { await musicSetEditors(p.id, [...sel]); toast('Editors updated'); await musicOpenPlaylist(p.id); } catch (e) { toast(e.message || 'Failed', 'close'); }
  };
  renderChips(); renderResults();
  setTimeout(() => searchEl.focus(), 30);
}

/* ---- add-from-vault picker ---- */
let _muPickView = 'grid';   // remembered across opens: 'grid' | 'list'
/* Reusable multi-select song picker (grid/list toggle, search, select-all). Used both
   for adding vault audio to Music and for adding library songs to a playlist. opts:
     { title, dek, items, searchPlaceholder, emptyText, confirmLabel(n),
       get: { id,title,artist,cover,size,dur }, badge?(item)->string|null,
       countText(total), onConfirm(ids) } */
function muSongPicker(opts) {
  const g = opts.get;
  const items = opts.items || [];
  const sel = new Set();
  let filter = '';

  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal mu-pick-modal">
    <div class="mu-pick-head">
      <div>
        <h3>${esc(opts.title)}</h3>
        ${opts.dek ? `<p class="mu-pick-dek">${esc(opts.dek)}</p>` : ''}
      </div>
      <div class="mu-pick-viewseg" id="muPickView">
        <button data-pv="grid" title="Grid">${svg('grid', 15)}</button>
        <button data-pv="list" title="List">${svg('listul', 15)}</button>
      </div>
    </div>
    <div class="mu-pick-toolbar">
      <div class="mu-pick-search">${svg('audio', 14)}<input id="muPickSearch" placeholder="${esc(opts.searchPlaceholder || 'Search…')}" autocomplete="off" /></div>
      <label class="mu-pick-all"><input type="checkbox" id="muPickAll" /> <span>Select all</span></label>
    </div>
    <div class="mu-pick-body" id="muPickBody"></div>
    <div class="acts">
      <span class="mu-pick-count" id="muPickCount"></span>
      <button class="btn ghost" data-cancel>Cancel</button>
      <button class="btn primary" data-ok disabled>Add selected</button>
    </div>
  </div>`;
  document.body.appendChild(bg);

  const body = bg.querySelector('#muPickBody');
  const okBtn = bg.querySelector('[data-ok]');
  const countEl = bg.querySelector('#muPickCount');
  const allBox = bg.querySelector('#muPickAll');
  const close = () => bg.remove();

  const visible = () => {
    const q = filter.trim().toLowerCase();
    return items.filter(it => !q || (g.title(it) || '').toLowerCase().includes(q) || (g.artist(it) || '').toLowerCase().includes(q));
  };
  // picker thumbs are tiny — for music covers the low-res variant is all we ever need
  const coverHTML = (it) => { const u = g.cover(it); return u ? `<img class="mu-pick-cover" src="${esc(CoverLoader.srcFor(u))}" alt="" loading="lazy" />` : `<div class="mu-pick-cover ph">${svg('audio', 18)}</div>`; };

  function syncFooter() {
    const vis = visible();
    okBtn.disabled = sel.size === 0;
    okBtn.textContent = sel.size ? `${opts.confirmLabel ? opts.confirmLabel(sel.size) : 'Add ' + sel.size}` : 'Add selected';
    countEl.textContent = sel.size ? `${sel.size} selected` : (opts.countText ? opts.countText(items.length) : `${items.length} song${items.length !== 1 ? 's' : ''}`);
    const visIds = vis.map(g.id);
    allBox.checked = visIds.length > 0 && visIds.every(id => sel.has(id));
    allBox.indeterminate = !allBox.checked && visIds.some(id => sel.has(id));
  }

  function render() {
    const vis = visible();
    bg.querySelector('.modal').classList.toggle('listmode', _muPickView === 'list');
    bg.querySelectorAll('#muPickView [data-pv]').forEach(b => b.classList.toggle('on', b.dataset.pv === _muPickView));
    if (!items.length) { body.innerHTML = `<div class="mu-pick-empty">${svg('audio', 28)}<p>${esc(opts.emptyText || 'Nothing to add.')}</p></div>`; syncFooter(); return; }
    if (!vis.length) { body.innerHTML = `<div class="mu-pick-empty">${svg('audio', 24)}<p>No matches for “${esc(filter)}”.</p></div>`; syncFooter(); return; }

    if (_muPickView === 'grid') {
      body.className = 'mu-pick-body grid';
      body.innerHTML = vis.map(it => { const id = g.id(it), title = esc(g.title(it)), badge = opts.badge && opts.badge(it); return `
        <button type="button" class="mu-pick-card ${sel.has(id) ? 'sel' : ''}" data-pick="${id}">
          <div class="mu-pick-art">${coverHTML(it)}<span class="mu-pick-tick">${svg('check', 14)}</span>${badge ? `<span class="mu-pick-have">${esc(badge)}</span>` : ''}</div>
          <div class="mu-pick-t" title="${title}">${title}</div>
          <div class="mu-pick-s">${g.artist(it) ? esc(g.artist(it)) : fmtSize(g.size(it) || 0)}</div>
        </button>`; }).join('');
    } else {
      body.className = 'mu-pick-body list';
      body.innerHTML = vis.map(it => { const id = g.id(it), title = esc(g.title(it)), badge = opts.badge && opts.badge(it), dur = g.dur(it); return `
        <button type="button" class="mu-pick-li ${sel.has(id) ? 'sel' : ''}" data-pick="${id}">
          <span class="mu-pick-box">${svg('check', 13)}</span>
          ${coverHTML(it)}
          <span class="mu-pick-li-meta"><span class="mu-pick-t" title="${title}">${title}</span><span class="mu-pick-s">${g.artist(it) ? esc(g.artist(it)) + ' · ' : ''}${fmtSize(g.size(it) || 0)}${dur ? ' · ' + fmtDur(dur) : ''}</span></span>
          ${badge ? `<span class="mu-pick-have">${esc(badge)}</span>` : ''}
        </button>`; }).join('');
    }
    body.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => {
      const id = el.dataset.pick;
      if (sel.has(id)) sel.delete(id); else sel.add(id);
      el.classList.toggle('sel', sel.has(id));
      syncFooter();
    });
    syncFooter();
  }

  bg.querySelectorAll('#muPickView [data-pv]').forEach(b => b.onclick = () => { _muPickView = b.dataset.pv; render(); });
  bg.querySelector('#muPickSearch').oninput = (e) => { filter = e.target.value; render(); };
  allBox.onclick = () => {
    const vis = visible();
    const allSel = vis.every(it => sel.has(g.id(it)));
    vis.forEach(it => { const id = g.id(it); if (allSel) sel.delete(id); else sel.add(id); });
    render();
  };
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('#muPickSearch').onkeydown = e => { if (e.key === 'Escape') close(); };

  okBtn.onclick = () => { const ids = Array.from(sel); close(); if (ids.length) opts.onConfirm(ids); };

  render();
  setTimeout(() => { const s = bg.querySelector('#muPickSearch'); if (s) s.focus(); }, 30);
}

async function muAddFromVault() {
  // the Music app can be opened without ever visiting the Database, so the vault file
  // list may not be loaded yet — load it on demand (no-op if already cached).
  try { await ensureAiDB(); } catch (e) { if (e && e.code === 'AUTH') return relock(); }
  const vaultAudio = allOfType('audio').filter(f => !f.locked);
  const inLib = new Set(MU.tracks.map(t => (t.title || '').toLowerCase()));   // flag likely dupes
  const titleOf = (f) => (f.name || '').replace(/\.[^.]+$/, '') || f.name || 'Untitled';
  muSongPicker({
    title: 'Add songs to Music',
    dek: 'Pick audio from your vault — each is copied into the shared library everyone can hear.',
    searchPlaceholder: 'Search your audio…',
    emptyText: 'No unlocked audio in your vault yet. Upload some in the Database app first.',
    items: vaultAudio,
    get: { id: f => f.id, title: titleOf, artist: f => f.artist, cover: f => f.coverUrl ? coverSrc(f) : null, size: f => f.size, dur: f => f.dur },
    badge: f => inLib.has(titleOf(f).toLowerCase()) ? 'In Music' : null,
    confirmLabel: n => `Add ${n} song${n !== 1 ? 's' : ''}`,
    countText: n => `${n} song${n !== 1 ? 's' : ''} in your vault`,
    onConfirm: async (ids) => {
      let added = 0, dup = 0, fail = 0;
      toast(`Adding ${ids.length} song${ids.length !== 1 ? 's' : ''}…`);
      for (const id of ids) { try { const r = await musicAddTrack(id); if (r.duplicate) dup++; else added++; } catch (e) { fail++; } }
      await loadMusic();
      const parts = [];
      if (added) parts.push(`${added} added`);
      if (dup) parts.push(`${dup} already in Music`);
      if (fail) parts.push(`${fail} failed`);
      toast(parts.join(' · ') || 'Done', fail ? 'close' : 'save');
    },
  });
}

/* ---- per-track "…" menu (add to playlist / jam / remove) ---- */
/* playlists the caller may add to (own or admin). Returns ctx submenu items. */
function muAddToPlaylistItems(trackId) {
  const me = (ACCOUNT && ACCOUNT.id) || null;
  const isAdmin = !!(ACCOUNT && ACCOUNT.is_admin);
  const mine = MU.playlists.filter(p => p.ownerId === me || isAdmin);
  if (!mine.length) return [{ ic: 'listul', label: 'New playlist…', fn: () => muNewPlaylist() }];
  const subs = mine.map(p => ({ ic: 'listul', label: p.name, fn: async () => {
    try { await musicAddToPlaylist(p.id, trackId); toast('Added to ' + p.name); await loadMusic(); } catch (e) { toast(e.message || 'Failed', 'close'); }
  } }));
  subs.push({ div: true });
  subs.push({ ic: 'plus', label: 'New playlist…', fn: () => muNewPlaylist() });
  return subs;
}
/* small right-click panel for a LIBRARY song. */
function muLibraryRowMenu(x, y, trackId) {
  const t = muTrackById(trackId); if (!t) return;
  if (typeof hideCtx === 'function') hideCtx();
  const me = (ACCOUNT && ACCOUNT.id) || null;
  const isAdmin = !!(ACCOUNT && ACCOUNT.is_admin);
  const canRemove = me && (t.ownerId === me || isAdmin);
  const items = [{ head: t.title }];
  items.push({ ic: 'play', label: 'Play', fn: () => muPlay([t], 0, t.title, false) });
  items.push({ ic: 'info', label: 'View details', fn: () => muOpenSong(trackId) });
  items.push({ ic: 'plus', label: 'Add to playlist', sub: muAddToPlaylistItems(trackId) });
  items.push({ ic: 'download', label: 'Save to my vault…', fn: () => muSaveToVault(trackId) });
  items.push({ ic: 'user', label: 'Start a jam with this', fn: () => { muPlay([t], 0, t.title, false); muStartJam(); } });
  items.push({ div: true });
  items.push({ ic: 'bug', label: 'Report…', fn: () => muReportTrack(t) });
  if (canRemove) items.push({ ic: 'trash', label: 'Remove from Music', danger: true, fn: () => confirmModal('Remove from Music?', `"${t.title}" will be removed for everyone. This does not touch your vault file.`, async () => {
    try { await musicRemoveTrack(trackId); toast('Removed'); muCloseSong(); await loadMusic(); } catch (e) { toast(e.message || 'Failed', 'close'); }
  }, 'Remove') });
  const panel = buildCtxPanel(items);
  document.body.appendChild(panel);
  if (typeof ctxEl !== 'undefined') ctxEl = panel;
  const r = panel.getBoundingClientRect();
  panel.style.left = Math.min(x, innerWidth - r.width - 10) + 'px';
  panel.style.top = Math.min(y, innerHeight - r.height - 10) + 'px';
}

/* ---- song detail drawer (slides in from the right) ---- */
function muOpenSong(trackId) {
  const t = muTrackById(trackId); if (!t) return;
  muCloseSong();
  const me = (ACCOUNT && ACCOUNT.id) || null;
  const isAdmin = !!(ACCOUNT && ACCOUNT.is_admin);
  const canRemove = me && (t.ownerId === me || isAdmin);
  const cover = t.coverUrl ? muProgressiveImgHTML(t.coverUrl) : `<div class="mu-song-ph">${svg('audio', 54)}</div>`;
  const added = t.created ? new Date(t.created).toLocaleDateString() : '';
  const wrap = document.createElement('div'); wrap.className = 'mu-song-scrim'; wrap.id = 'muSongScrim';
  wrap.innerHTML = `<div class="mu-song-drawer" role="dialog">
    <button class="mu-song-close" id="muSongClose" title="Close">${svg('close', 16)}</button>
    <div class="mu-song-art">${cover}</div>
    <div class="mu-song-title">${esc(t.title)}</div>
    <div class="mu-song-artist">${esc(t.artist || 'Unknown artist')}</div>
    <div class="mu-song-rows">
      ${t.album ? `<div class="mu-song-row"><span>Album</span><b>${esc(t.album)}</b></div>` : ''}
      <div class="mu-song-row"><span>Uploaded by</span><b>${esc(t.ownerName || 'Unknown')}</b></div>
      <div class="mu-song-row"><span>Length</span><b>${t.dur ? fmtDur(t.dur) : '—'}</b></div>
      ${t.ext ? `<div class="mu-song-row"><span>Format</span><b>${esc(String(t.ext).replace(/^\./, '').toUpperCase())}</b></div>` : ''}
      ${t.size ? `<div class="mu-song-row"><span>Size</span><b>${fmtSize(t.size)}</b></div>` : ''}
      ${added ? `<div class="mu-song-row"><span>Added</span><b>${esc(added)}</b></div>` : ''}
    </div>
    <div class="mu-song-acts">
      <button class="btn primary" id="muSongPlay">${svg('play', 15)} Play</button>
      <button class="btn ghost" id="muSongAdd">${svg('plus', 14)} Add to playlist</button>
      <button class="btn ghost" id="muSongSave">${svg('download', 14)} Save to vault</button>
      <button class="btn ghost" id="muSongReport">${svg('bug', 14)} Report</button>
      ${canRemove ? `<button class="btn ghost danger" id="muSongRemove">${svg('trash', 14)} Remove</button>` : ''}
    </div>
  </div>`;
  document.body.appendChild(wrap);
  CoverLoader.wire(wrap);   // low-res art paints now, full-res follows when the network allows
  requestAnimationFrame(() => wrap.classList.add('show'));
  wrap.onclick = (e) => { if (e.target === wrap) muCloseSong(); };
  wrap.querySelector('#muSongClose').onclick = muCloseSong;
  wrap.querySelector('#muSongPlay').onclick = () => muPlay([t], 0, t.title, false);
  wrap.querySelector('#muSongAdd').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); muLibraryRowMenu(r.left, r.bottom, trackId); };
  wrap.querySelector('#muSongSave').onclick = () => muSaveToVault(trackId);
  wrap.querySelector('#muSongReport').onclick = () => muReportTrack(t);
  const rm = wrap.querySelector('#muSongRemove'); if (rm) rm.onclick = () => confirmModal('Remove from Music?', `"${t.title}" will be removed for everyone. This does not touch your vault file.`, async () => {
    try { await musicRemoveTrack(trackId); toast('Removed'); muCloseSong(); await loadMusic(); } catch (e) { toast(e.message || 'Failed', 'close'); }
  }, 'Remove');
}
function muCloseSong() { const w = document.getElementById('muSongScrim'); if (w) { w.classList.remove('show'); setTimeout(() => w.remove(), 200); } }

/* ---- save a shared song into YOUR vault (pick the destination folder) ---- */
async function muSaveToVault(trackId) {
  const t = muTrackById(trackId); if (!t) return;
  // the folder tree comes from the vault file cache, which may not be loaded if
  // the user came straight to Music — load it on demand (no-op if cached).
  try { await ensureAiDB(); } catch (e) { if (e && e.code === 'AUTH') return relock(); toast('Could not load your folders', 'close'); return; }
  const tree = folderTree([]);
  let dest = null;
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal move-modal">
    <h3>Save “${esc(t.title)}” to your vault</h3>
    <p>Pick a destination folder. The song is copied — the Music library keeps its own version.</p>
    <div class="tree" id="muSaveTree">${tree.map(x => `
      <button class="tree-item ${x.id === dest ? 'on' : ''}" data-id="${x.id == null ? '' : x.id}" style="padding-left:${10 + x.depth * 17}px">
        <span class="t-folder">${svg(x.id == null ? 'hdd' : 'folder', 15)}</span><span class="tn">${esc(x.name)}</span>
      </button>`).join('')}</div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>${svg('download', 14)} Save here</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  const treeEl = bg.querySelector('#muSaveTree');
  treeEl.querySelectorAll('.tree-item').forEach(b => b.onclick = () => {
    dest = b.dataset.id === '' ? null : b.dataset.id;
    treeEl.querySelectorAll('.tree-item').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
  });
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('[data-ok]').onclick = async () => {
    close();
    toast(`Saving “${t.title}” to your vault…`);
    try {
      await musicSaveTrack(trackId, dest);
      toast(`Saved “${t.title}” to your vault`, 'save');
      try { render(); } catch (e) {}   // repaint if the Database grid is showing
    } catch (e) {
      toast(e && e.status === 413 ? 'Storage limit reached' : (e.message || 'Save failed'), 'close');
    }
  };
}

/* ---- report a song (Duplicate / Other + reason) ---- */
function muReportTrack(t) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h3>Report “${esc(t.title)}”</h3>
    <label class="mu-field"><span class="eyebrow">Reason</span>
      <select class="set-select" id="muRepReason">
        <option value="duplicate">Duplicate</option>
        <option value="other">Other</option>
      </select></label>
    <label class="mu-field"><span class="eyebrow" id="muRepLbl">Details (optional)</span>
      <textarea id="muRepDetail" rows="3" placeholder="Add any context for the admins…"></textarea></label>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Send report</button></div></div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  const reasonSel = bg.querySelector('#muRepReason');
  const lbl = bg.querySelector('#muRepLbl');
  reasonSel.onchange = () => { lbl.textContent = reasonSel.value === 'other' ? 'Reason (required)' : 'Details (optional)'; };
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('[data-ok]').onclick = async () => {
    const reason = reasonSel.value;
    const detail = bg.querySelector('#muRepDetail').value.trim();
    if (reason === 'other' && !detail) { bg.querySelector('#muRepDetail').focus(); toast('Please add a reason', 'info'); return; }
    close();
    try { await musicReportTrack(t.id, reason, detail); toast('Report sent — thanks'); } catch (e) { toast(e.message || 'Failed', 'close'); }
  };
}

/* ---- batch: add many selected tracks to a playlist ---- */
function muBatchAddToPlaylist(trackIds) {
  if (!trackIds.length) return;
  const me = (ACCOUNT && ACCOUNT.id) || null;
  const isAdmin = !!(ACCOUNT && ACCOUNT.is_admin);
  const myPlaylists = MU.playlists.filter(p => p.ownerId === me || isAdmin);
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  const plRows = myPlaylists.length ? myPlaylists.map(p => `<button class="mu-menu-item" data-addpl="${p.id}">${svg('listul', 13)} ${esc(p.name)} <span class="mu-menu-count">${p.count}</span></button>`).join('')
    : `<div class="mu-menu-note">No playlists you can edit. Create one first.</div>`;
  bg.innerHTML = `<div class="modal mu-menu-modal"><h3>Add ${trackIds.length} song${trackIds.length !== 1 ? 's' : ''} to…</h3>
    <div class="mu-menu-sec">Choose a playlist</div>
    <div class="mu-menu-list">${plRows}</div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn ghost" data-newpl>${svg('plus', 13)} New playlist</button></div></div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('[data-newpl]').onclick = () => { close(); muNewPlaylist(); };
  bg.querySelectorAll('[data-addpl]').forEach(el => el.onclick = async () => {
    close();
    const plId = el.dataset.addpl;
    let added = 0, fail = 0;
    toast(`Adding ${trackIds.length} song${trackIds.length !== 1 ? 's' : ''}…`);
    for (const id of trackIds) {
      try { await musicAddToPlaylist(plId, id); added++; } catch (e) { fail++; }
    }
    MU.selectMode = false; MU.selected.clear();
    await loadMusic();
    toast(`${added} added${fail ? ' · ' + fail + ' failed' : ''}`, fail ? 'close' : 'save');
  });
}

/* ---- batch: remove selected tracks from Music (owner/admin only; others skipped) ---- */
function muBatchRemove(trackIds) {
  if (!trackIds.length) return;
  const me = (ACCOUNT && ACCOUNT.id) || null;
  const isAdmin = !!(ACCOUNT && ACCOUNT.is_admin);
  const mine = trackIds.filter(id => { const t = muTrackById(id); return t && (t.ownerId === me || isAdmin); });
  const skipped = trackIds.length - mine.length;
  if (!mine.length) { toast('You can only remove songs you added', 'close'); return; }
  const msg = `${mine.length} song${mine.length !== 1 ? 's' : ''} will be removed from Music for everyone. This does not touch your vault files.${skipped ? ` (${skipped} you don't own will be skipped.)` : ''}`;
  confirmModal('Remove selected songs?', msg, async () => {
    let removed = 0, fail = 0;
    toast(`Removing ${mine.length} song${mine.length !== 1 ? 's' : ''}…`);
    for (const id of mine) {
      try { await musicRemoveTrack(id); removed++; } catch (e) { fail++; }
    }
    MU.selectMode = false; MU.selected.clear();
    await loadMusic();
    toast(`${removed} removed${fail ? ' · ' + fail + ' failed' : ''}`, fail ? 'close' : 'save');
  }, 'Remove');
}

/* visibility dropdown (Public / Private) reused by new + edit. */
function muVisibilitySelect(isPublic) {
  return `<label class="mu-field"><span class="eyebrow">Visibility</span>
    <select class="set-select" id="muPlVis">
      <option value="public" ${isPublic ? 'selected' : ''}>Public</option>
      <option value="private" ${!isPublic ? 'selected' : ''}>Private</option>
    </select></label>`;
}
function muNewPlaylist() {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h3>New playlist</h3>
    <input id="muPlName" placeholder="Playlist name" />
    ${muVisibilitySelect(true)}
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Create</button></div></div>`;
  document.body.appendChild(bg);
  const input = bg.querySelector('#muPlName'); input.focus();
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  const ok = async () => {
    const name = input.value.trim(); if (!name) return;
    const isPublic = bg.querySelector('#muPlVis').value === 'public';
    close();
    try { await musicCreatePlaylist(name, isPublic); toast('Playlist created'); MU.tab = 'playlists'; await loadMusic(); } catch (e) { toast(e.message || 'Failed', 'close'); }
  };
  bg.querySelector('[data-ok]').onclick = ok;
  input.onkeydown = e => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') close(); };
}

function muEditPlaylist(p) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h3>Edit playlist</h3>
    <input id="muPlName" value="${esc(p.name)}" />
    ${muVisibilitySelect(!!p.public)}
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Save</button></div></div>`;
  document.body.appendChild(bg);
  const input = bg.querySelector('#muPlName'); input.focus(); input.select();
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  const ok = async () => {
    const name = input.value.trim() || p.name;
    const isPublic = bg.querySelector('#muPlVis').value === 'public';
    close();
    try { await musicUpdatePlaylist(p.id, { name, public: isPublic }); toast('Saved'); await musicOpenPlaylist(p.id); await loadMusic(); } catch (e) { toast(e.message || 'Failed', 'close'); }
  };
  bg.querySelector('[data-ok]').onclick = ok;
  input.onkeydown = e => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') close(); };
}

/* ============ JAM (listen together) — drives the global Player ============ */

async function muStartJam() {
  if (Player.kind !== 'audio' || !Player.list.length) { toast('Play something first, then start a jam', 'info'); return; }
  try {
    // share the queue in PLAY order so the jam starts on the current track at index 0
    const queueIds = npUpNextOrder().map(i => Player.list[i].id);
    const state = await jamCreate(queueIds, MU.openPlaylist ? MU.openPlaylist.playlist.name : 'Music');
    muEnterJam(state);
    toast('Jam started — others can join from the Jams tab');
  } catch (e) { toast(e.message || 'Could not start jam', 'close'); }
}
async function muJoinJam(id) {
  try {
    const state = await jamJoin(id);
    muEnterJam(state);
    if (MU.tab === 'jams') { MU.tab = 'library'; renderMusicBody(); }
    toast('Joined the jam');
  } catch (e) { toast(e.message || 'Could not join', 'close'); }
}
function muEnterJam(state) {
  const me = (ACCOUNT && ACCOUNT.id) || null;
  const isHost = state.hostId === me;
  Player.jam = { id: state.id, version: state.version, hostName: state.hostName, members: state.members || [], isHost };
  Player.kind = 'audio'; Player.expanded = true;
  MU._lastPush = 0;
  if (isHost) {
    // the host is already playing the queue it just created — don't reload/seek, only
    // record the queue/flags so the jam UI matches. muSyncQueueOnly REPLACES Player.list
    // with the jam queue (which is in play-order: the current song is at the server's
    // idx), so Player.idx MUST be realigned to that queue or the UI shows the wrong song
    // while the audio keeps playing the old one. We built the queue so the current track
    // sits at state.idx, so map it back through the (identity) order.
    muSyncQueueOnly(state);
    const ord = state.order || Player.list.map((_, i) => i);
    Player.idx = ord[Math.max(0, Math.min(ord.length - 1, state.idx || 0))] || 0;
    MU._jamLoadedId = (Player.list[Player.idx] || {}).id;
    paintPlayer();   // keep the scrubber/time on the still-playing song
  } else {
    MU._jamLoadedId = null;                 // force a load of the host's current track
    muApplyRemoteState(state, true, true);  // snap to the host
  }
  muStartJamPoll();
  renderNowPlaying(); renderMini();
}
function muStartJamPoll() { muStopJamPoll(); MU.jamTimer = setInterval(muPollJam, 600); }
function muStopJamPoll() { if (MU.jamTimer) { clearInterval(MU.jamTimer); MU.jamTimer = null; } }

async function muLeaveJam(silent) {
  const jam = Player.jam; Player.jam = null; muStopJamPoll();
  if (Player.expanded) renderNowPlaying(); renderMini();
  if (jam) { try { await jamLeave(jam.id); } catch (e) {} }
  if (!silent) toast('Left the jam');
}

async function muPollJam() {
  if (!Player.jam || MU.jamBusy) return;
  MU.jamBusy = true;
  try {
    const state = await jamState(Player.jam.id);
    if (!Player.jam) return;
    const wasVersion = Player.jam.version;
    Player.jam.version = state.version;
    Player.jam.hostName = state.hostName;
    Player.jam.members = state.members || [];
    const me = (ACCOUNT && ACCOUNT.id) || null;
    Player.jam.isHost = state.hostId === me;

    if (Player.jam.isHost) {
      // the HOST is the source of truth: never let incoming state seek/reload its own
      // playback (that was the "song keeps restarting" loop). Just keep the queue/flags
      // in sync for the UI, and push our real position so listeners can follow.
      muSyncQueueOnly(state);
      if (Player.audio && !Player.audio.paused && (!MU._lastPush || Date.now() - MU._lastPush > 3000)) {
        MU._lastPush = Date.now();
        muJamControl({ posSec: Player.audio.currentTime, idx: muJamOrderPos() }, true);
      }
    } else {
      // a listener follows the host. Only act on a real change (new version) to avoid
      // re-seeking every second; always gently drift-correct toward the host clock.
      muApplyRemoteState(state, false, wasVersion !== state.version);
    }
    muRenderPlayerSoft();   // refresh in place — full render only if the TRACK changed (keeps the album spin)
  } catch (e) {
    if (e && e.status === 404) { Player.jam = null; muStopJamPoll(); if (Player.expanded) renderNowPlaying(); renderMini(); toast('The jam ended'); }
  } finally { MU.jamBusy = false; }
}

/* repaint the now-playing player without resetting the spinning album: a full
   renderNowPlaying() only when the current track actually changed; otherwise an
   in-place refresh of the dynamic bits (pill, shuffle/loop, up-next, play state). */
function muRenderPlayerSoft() {
  if (Player.expanded) {
    const cur = (Player.list[Player.idx] || {}).id || '';
    if (muNpShownId() !== cur) renderNowPlaying(); else muRefreshJamUI();
  } else renderMini();
}

/* the position (index into `order`) of the track currently playing — what the server's
   jam `idx` means. */
function muJamOrderPos() {
  if (!Player.order) return Player.idx;
  const p = Player.order.indexOf(Player.idx); return p < 0 ? 0 : p;
}

/* keep Player.list/order/shuffle/loop aligned with the server WITHOUT touching the audio
   element (no reload, no seek, no pause). Used by the host, who owns playback. */
function muSyncQueueOnly(state) {
  const ids = state.queue || [];
  Player.list = ids.map(id => muTrackById(id) || muJamStub(id));
  const order = (state.order && state.order.length === ids.length) ? state.order : ids.map((_, i) => i);
  Player.order = order.slice();
  Player.shuffle = !!state.shuffle; Player.loop = !!state.loop;
}
function muJamStub(id) { return { id, type: 'audio', name: 'Track', title: 'Track', ownerName: '', artist: '', url: '/api/music/tracks/' + id + '/raw', coverUrl: '/api/music/tracks/' + id + '/cover', dur: null }; }

/* apply server jam state to a LISTENER's Player. `snap` forces an immediate seek (on
   join). `changed` = the version moved since last poll (so we only (re)load the track /
   honor pause on real changes, not every tick). */
function muApplyRemoteState(state, snap, changed) {
  MU.applyingRemote = true;
  try {
    const ids = state.queue || [];
    Player.list = ids.map(id => muTrackById(id) || muJamStub(id));
    const order = (state.order && state.order.length === ids.length) ? state.order : ids.map((_, i) => i);
    Player.order = order.slice();
    Player.shuffle = !!state.shuffle; Player.loop = !!state.loop;
    const wantIdx = order[Math.max(0, Math.min(order.length - 1, state.idx || 0))];
    Player.idx = wantIdx == null ? 0 : wantIdx;

    const t = Player.list[Player.idx];
    const a = ensureAudioEl();
    // only (re)load when the actual TRACK changed — compare by id, not idx, so we never
    // restart the song we're already on.
    const loadedId = MU._jamLoadedId;
    const needLoad = t && t.id !== loadedId;
    if (needLoad) { MU._jamLoadedId = t.id; void loadAudio(Player.idx, !state.paused); }

    if (changed || snap || needLoad) {
      if (state.paused && a && !a.paused) a.pause();
      if (!state.paused && a && a.paused && t) a.play().catch(() => {});
    }

    MU._pendingPos = { posSec: state.posSec || 0, serverTs: state.serverTs, now: state.now, paused: !!state.paused };
    muJamSeekIfNeeded(!!snap || needLoad);
  } finally { MU.applyingRemote = false; }
}

function muJamSeekIfNeeded(force) {
  const a = Player.audio, p = MU._pendingPos;
  if (!a || !p) return;
  if (Date.now() < MU.scrubUntil && !force) return;        // user is scrubbing — leave them be
  if (!isFinite(a.duration) && !force) return;             // wait for metadata to seek precisely
  // extrapolate the host's position to "now" using the server clock from the same response
  const drift = p.paused ? 0 : Math.max(0, (Date.now() - (p.now || Date.now())) / 1000);
  const expected = (p.posSec || 0) + drift;
  const diff = Math.abs((a.currentTime || 0) - expected);
  if (force || diff > 1.5) {
    try { a.currentTime = expected; } catch (e) {}
  } else if (diff > 0.5) {
    // ease toward sync without an audible jump; restore the user's chosen speed after
    a.playbackRate = expected > a.currentTime ? 1.03 : 0.97;
    setTimeout(() => { try { if (Player.audio) Player.audio.playbackRate = Player.rate; } catch (e) {} }, 800);
  }
}

/* send a control change; optimistically apply locally, then reconcile with the server.
   `quiet` = a background position push (host) — never re-apply remote playback for it. */
async function muJamControl(patch, quiet) {
  if (!Player.jam) return;
  if (!quiet) muOptimisticPatch(patch);
  try {
    const res = await jamControl(Player.jam.id, Player.jam.version, patch);
    if (!res) return;
    if (res.error) { if (res.status === 404) { Player.jam = null; muStopJamPoll(); if (Player.expanded) renderNowPlaying(); renderMini(); } return; }
    if (res.version != null) {
      Player.jam.version = res.version;
      Player.jam.members = res.members || Player.jam.members;
      const me = (ACCOUNT && ACCOUNT.id) || null; Player.jam.isHost = res.hostId === me;
      // a quiet position-push must NOT seek/reload us (we ARE where we just reported).
      // The host owns playback, so it only syncs the queue; a listener applies fully.
      if (quiet || Player.jam.isHost) muSyncQueueOnly(res);
      else muApplyRemoteState(res, false, true);
      if (!quiet) muRenderPlayerSoft();   // keep the album spin; full render only on track change
    }
  } catch (e) { /* next poll will reconcile */ }
}
/* apply a control intent to the LOCAL Player immediately, so the person who pressed the
   button hears it right away (the server confirms within ~1s). Drives real playback for
   track moves / shuffle / loop, not just pause/seek. */
function muOptimisticPatch(patch) {
  const a = Player.audio;
  const n = Player.list.length;
  if (patch.shuffle != null) playerSetShuffle(!!patch.shuffle);
  if (patch.loop != null) Player.loop = !!patch.loop;
  if (patch.advance === 'next') { const nx = playerAdvanceIndex(1); if (nx != null) { MU._jamLoadedId = (Player.list[nx] || {}).id; void loadAudio(nx, true); } }
  else if (patch.advance === 'prev') { const pv = playerAdvanceIndex(-1); if (pv != null) { MU._jamLoadedId = (Player.list[pv] || {}).id; void loadAudio(pv, true); } }
  else if (patch.idx != null && n) {
    const wantIdx = (Player.order ? Player.order[((Number(patch.idx) % n) + n) % n] : ((Number(patch.idx) % n) + n) % n);
    MU._jamLoadedId = (Player.list[wantIdx] || {}).id; void loadAudio(wantIdx, true);
  }
  if (patch.paused != null && a) { patch.paused ? a.pause() : a.play().catch(() => {}); }
  if (patch.posSec != null && a) { a.currentTime = patch.posSec; }
  if (Player.expanded) renderNowPlaying();
}

async function muLoadJams() {
  const wrap = document.querySelector('#muBody .mu-jamtab'); if (!wrap) return;
  try {
    const { jams } = await musicJams();
    if (!muOnMusic() || MU.tab !== 'jams') return;
    const inJam = Player.jam ? Player.jam.id : null;
    if (!jams.length) {
      wrap.innerHTML = `<div class="mu-empty">${svg('user', 30)}<h3>No live jams</h3><p>Start playing something, then hit <b>Start a jam</b> to listen together.</p></div>`;
      return;
    }
    wrap.innerHTML = jams.map(j => `
      <div class="mu-jam-row">
        <div class="mu-jam-info">
          <div class="mu-jam-name">${svg('user', 14)} ${esc(j.name || 'Jam')}</div>
          <div class="mu-jam-meta">${esc(j.hostName || 'Someone')} · ${j.listeners} listening${j.nowPlaying ? ' · ♪ ' + esc(j.nowPlaying) : ''}</div>
        </div>
        <button class="btn primary sm" data-joinjam="${j.id}" ${inJam === j.id ? 'disabled' : ''}>${inJam === j.id ? 'In this jam' : 'Join'}</button>
      </div>`).join('');
    wrap.querySelectorAll('[data-joinjam]').forEach(el => el.onclick = () => muJoinJam(el.dataset.joinjam));
  } catch (e) {
    wrap.innerHTML = `<div class="mu-loading sm">${svg('info', 22)}<span>Couldn't load jams.</span></div>`;
  }
}

/* TRADING app extracted to apps-trading.js (lazy via openLazyApp). */


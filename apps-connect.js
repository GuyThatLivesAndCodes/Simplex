/* ============================================================
   CONNECT app (apps-connect.js) — private rooms with live calls + chat.
   Loaded on demand (openApp -> openLazyApp -> loadFeature("apps-connect")). Plain
   non-module script sharing app.js's global scope, like the other apps-*.js files.
   The small CORE bits the router needs before this file loads (the CN state object,
   cnOnConnect() and connectOpenRoom()) live in app.js.
   See [[connect-app]] and [[lazy-loading-architecture]].
   ============================================================ */
/* ============================================================
   CONNECT

   Make a room, get a 5-character code, share the code — that's the whole entry
   model. Rooms are private: they are never listed to anyone who hasn't joined, so
   holding the code is what grants access.

   THE CALL IS PEER-TO-PEER AND END-TO-END ENCRYPTED
   -------------------------------------------------
   Media never touches the Simplex server. Each pair of participants builds a
   direct RTCPeerConnection, and WebRTC encrypts every frame with DTLS-SRTP using
   keys negotiated in the browser-to-browser DTLS handshake. The server only
   relays SDP + ICE (see the SSE stream in server.js) and never holds a key that
   could decrypt anyone's screen, camera, or voice. Nothing here needs a media
   library — the browser ships the entire stack.

   The room is a MESH: with N people there are N*(N-1)/2 connections, each peer
   uploading its stream N-1 times. That is why the server caps a room at 8.

   GLARE: two peers must never send each other an offer at once. The rule is
   simple and lives entirely on the arriving side — WHOEVER JOINS LAST CALLS
   EVERYONE ALREADY THERE. The 'welcome' event lists who was already present, and
   we offer to exactly those; anyone who arrives after us offers to us instead
   ('peer-joined' just registers them and waits). So each pair has exactly one
   offerer, decided by join order, and no rollback is ever needed.

   AUDIO is pinned to 64 kbps stereo Opus (the spec) by rewriting the SDP's
   b=/maxaveragebitrate lines and setting a sender encoding cap — see cnTuneAudio.
   VIDEO asks for the best the device will give (up to 1080p60 for camera, and
   full-resolution screen capture) and lets the encoder adapt downward.
   ============================================================ */

/* ---- tuning constants ---------------------------------------------------- */
const CN_AUDIO_BITRATE = 64000;          // 64 kbps, per spec

/* ---- video quality presets ----------------------------------------------
   Chosen by the user in Devices & quality, separately for the CAMERA and the
   SCREEN SHARE, because they want opposite things: a camera can drop resolution
   happily, while shared text stays readable only if resolution is preserved.

   'auto' asks for the best the device offers and lets the encoder adapt — right
   for most people. The fixed tiers exist for a capped connection, a data plan,
   or a laptop whose fans spin up encoding 1080p60.

   `max` is intentionally uncapped-ish: the browser still adapts downward under
   congestion, this only sets the ceiling. */
const CN_CAM_QUALITY = {
  auto:   { label: 'Auto (recommended)', w: 1920, h: 1080, fps: 60, bitrate: 2_500_000, note: 'Best your camera supports, adapts to your connection' },
  low:    { label: 'Low · 360p',         w: 640,  h: 360,  fps: 24, bitrate: 350_000,   note: 'Easiest on data and battery' },
  medium: { label: 'Medium · 720p',      w: 1280, h: 720,  fps: 30, bitrate: 1_200_000, note: 'Good balance' },
  high:   { label: 'High · 1080p',       w: 1920, h: 1080, fps: 30, bitrate: 3_000_000, note: 'Sharp, needs a solid connection' },
  max:    { label: 'Max · 1080p60',      w: 1920, h: 1080, fps: 60, bitrate: 6_000_000, note: 'Smoothest motion, heaviest upload' },
};
const CN_SCREEN_QUALITY = {
  auto:   { label: 'Auto (recommended)', w: 3840, h: 2160, fps: 60, bitrate: 8_000_000,  note: 'Full resolution, adapts to your connection' },
  low:    { label: 'Low · 720p',         w: 1280, h: 720,  fps: 15, bitrate: 800_000,    note: 'Readable text, very light' },
  medium: { label: 'Medium · 1080p',     w: 1920, h: 1080, fps: 30, bitrate: 3_000_000,  note: 'Good for slides and code' },
  high:   { label: 'High · 1440p',       w: 2560, h: 1440, fps: 30, bitrate: 6_000_000,  note: 'Crisp detail' },
  max:    { label: 'Max · 4K60',         w: 3840, h: 2160, fps: 60, bitrate: 12_000_000, note: 'For video or fast motion' },
};
/* the user's current choice, persisted in PREFS (see cnQualityPrefs) */
function cnCamQuality() { return CN_CAM_QUALITY[(PREFS && PREFS.connectCamQuality) || 'auto'] || CN_CAM_QUALITY.auto; }
function cnScreenQuality() { return CN_SCREEN_QUALITY[(PREFS && PREFS.connectScreenQuality) || 'auto'] || CN_SCREEN_QUALITY.auto; }
/* the live ceiling the sender is capped at, by track kind */
function cnVideoBitrateFor(isScreen) { return isScreen ? cnScreenQuality().bitrate : cnCamQuality().bitrate; }
/* Public STUN only. STUN just tells a peer its own public address so the two can
   find each other — it never carries media, so using Google's public servers
   costs no privacy for the call content itself. No TURN: a relay would be a third
   party in the path, and we would rather a hard-NAT call fail loudly than quietly
   route media through someone else's server. */
const CN_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
const CN_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🔥', '👀'];

/* ---- state ---------------------------------------------------------------
   CN itself is declared in app.js — the router touches it before this file loads.
   We must NOT redeclare it here: every apps-*.js shares app.js's single global
   scope, so a second `const CN` would throw a redeclaration error and take the
   whole app down (the same trap documented in [[tweaks-jsx-global-scope]]).
   This only (re)initialises the fields. */
function cnResetState() {
  CN.rooms = [];
  CN.room = null;           // the room we're viewing
  CN.inCall = false;
  CN.self = null;           // { id, name, peerId }
  CN.peers = new Map();     // accountId -> { id, name, peerId, media, pc, stream, el }
  CN.local = null;          // MediaStream we're sending (mic + optional cam)
  CN.screen = null;         // separate MediaStream while presenting
  CN.es = null;             // EventSource (signaling)
  CN.messages = [];
  CN.lastMsgAt = 0;
  CN.replyTo = null;
  CN.media = { mic: false, cam: false, screen: false, hand: false };
  CN.devices = { mics: [], cams: [], micId: null, camId: null };
  CN.pinned = null;         // accountId of the tile blown up to speaker view
  CN.chatOpen = true;
  CN.pollTimer = null;
  CN.levelTimer = null;
  CN.audioCtx = null;
  CN.analysers = new Map();

  /* ---- tile focus (the Discord model) ----
     The KEY of the tile filling the stage: 'self', an accountId, or a screen key
     ('scr:<accountId>'). Everyone else drops into the filmstrip rather than being
     hidden, which is what separates this from Zoom's speaker view. */
  CN.focus = null;

  /* ---- screen shares as their own participants ----
     A share is no longer a second video track on the sharer's tile; it gets its
     own tile keyed 'scr:<accountId>'. `openScreens` holds the keys the viewer has
     actually OPENED — an unopened share is a 1fps still preview with its audio
     muted, so ten people sharing doesn't cost ten live decodes. */
  CN.screens = new Map();     // 'scr:<accountId>' -> { key, ownerId, ownerName, stream, live }
  CN.openScreens = new Set();

  /* ---- per-user, per-viewer overrides (local only, never published) ----
     volume 0..1, muted (silence them for me), ignored (hide their video+audio
     entirely). Keyed by accountId. Persisted per room in PREFS so an ignore
     survives a refresh. */
  CN.userPrefs = new Map();

  /* the noise-suppression graph, when it's running (see cnBuildMicChain) */
  CN.micChain = null;
  CN.micTest = null;          // the "hear yourself" monitor, while open
}

/* ============================================================
   SCREEN 1 — the room list / lobby
   ============================================================ */
function connectHTML() {
  return `<div class="cn-app" data-screen-label="Connect">
    <div class="cn-head">
      <div>
        <h2 class="cn-title">${svg('window', 20, 1.8)} Connect</h2>
        <p class="cn-sub">Private rooms for calls, screen sharing & chat. Share the 5-character code to let someone in — the call itself is end-to-end encrypted between you.</p>
      </div>
      <div class="cn-head-acts">
        <button class="btn primary sm" id="cnNew">${svg('plus', 14)} New room</button>
        <button class="btn ghost sm" id="cnJoin">${svg('link', 14)} Join by code</button>
        <button class="btn ghost sm" id="cnRefresh">${svg('refresh', 14)} Refresh</button>
      </div>
    </div>
    <div id="cnBody"><div class="cn-loading">${svg('window', 28)}<span>Loading your rooms…</span></div></div>
  </div>`;
}

async function wireConnect() {
  cnResetState();
  const n = document.getElementById('cnNew');
  const j = document.getElementById('cnJoin');
  const r = document.getElementById('cnRefresh');
  if (n) n.onclick = cnNewRoom;
  if (j) j.onclick = cnJoinByCode;
  if (r) r.onclick = () => cnLoadRooms();
  // leaving the app must tear the call down — otherwise mic/camera stay live
  _appCleanup = () => cnLeaveCall({ silent: true });
  await cnLoadRooms();
}

async function cnLoadRooms() {
  const body = document.getElementById('cnBody');
  if (!body) return;
  try {
    const data = await cnApi('/api/connect/rooms');
    CN.rooms = data.rooms || [];
    if (!cnOnConnect()) return;
    if (CN.room) await connectOpenRoom(CN.room.id, true);
    else cnRenderBody();
  } catch (e) {
    if (e && e.code === 'AUTH') return relock();
    body.innerHTML = `<div class="cn-loading">${svg('info', 24)}<span>Couldn't load your rooms.</span></div>`;
  }
}

function cnRenderBody() {
  const body = document.getElementById('cnBody');
  if (!body) return;
  body.innerHTML = CN.room ? cnRoomHTML() : cnLobbyHTML();
  if (CN.room) {
    // Seed the render caches (see cnRenderStage) so the first stage render after
    // a full body render doesn't needlessly rebuild markup it just wrote.
    // NB: read from the GENERATORS, not from innerHTML — the browser normalises
    // markup on parse, so the round-tripped string never compares equal.
    const stage = document.getElementById('cnStage');
    if (stage) stage._cnHTML = cnStageHTML();
    const bar = document.querySelector('.cn-bar');
    if (bar) bar._cnHTML = cnBarHTML();
    cnWireRoom();
  } else cnWireLobby();
}

function cnLobbyHTML() {
  if (!CN.rooms.length) {
    return `<div class="cn-empty">
      ${svg('window', 40, 1.4)}
      <h3>No rooms yet</h3>
      <p>Create a room and you'll get a 5-character code. Anyone you give the code to can join the call.</p>
      <button class="btn primary" id="cnEmptyNew">${svg('plus', 15)} Create your first room</button>
    </div>`;
  }
  return `<div class="cn-rooms">${CN.rooms.map(cnRoomCardHTML).join('')}</div>`;
}

function cnRoomCardHTML(r) {
  const liveBadge = r.liveCount
    ? `<span class="cn-live"><span class="cn-live-dot"></span>${r.liveCount} in call</span>`
    : `<span class="cn-idle">idle</span>`;
  const who = r.live && r.live.length
    ? `<div class="cn-card-who">${r.live.slice(0, 4).map(p => esc(p.name)).join(', ')}${r.live.length > 4 ? ` +${r.live.length - 4}` : ''}</div>`
    : '';
  return `<div class="cn-card" data-room="${esc(r.id)}">
    <div class="cn-card-top">
      <div class="cn-card-name">${esc(r.name)}</div>
      ${liveBadge}
    </div>
    ${r.topic ? `<div class="cn-card-topic">${esc(r.topic)}</div>` : ''}
    ${who}
    <div class="cn-card-foot">
      <button class="cn-code" data-copy="${esc(r.code)}" title="Copy the room code">${svg('copy', 12)}<span>${esc(r.code)}</span></button>
      <div class="cn-card-meta">${r.memberCount} ${r.memberCount === 1 ? 'person' : 'people'}${r.isOwner ? ' · yours' : ''}</div>
    </div>
  </div>`;
}

function cnWireLobby() {
  const en = document.getElementById('cnEmptyNew');
  if (en) en.onclick = cnNewRoom;
  document.querySelectorAll('.cn-card').forEach(card => {
    card.onclick = (e) => {
      // the code chip copies instead of opening the room
      const copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) { e.stopPropagation(); cnCopyCode(copyBtn.getAttribute('data-copy')); return; }
      connectOpenRoom(card.getAttribute('data-room'));
    };
  });
}

function cnCopyCode(code) {
  try {
    navigator.clipboard.writeText(code);
    toast('Room code ' + code + ' copied', 'copy');
  } catch (e) { toast('Code: ' + code, 'info'); }
}

/* ---- create / join ------------------------------------------------------- */
async function cnNewRoom() {
  const name = await cnPrompt({ title: 'New room', label: 'Room name', placeholder: 'Design sync', okText: 'Create' });
  if (!name || !name.trim()) return;
  try {
    const { room } = await cnApi('/api/connect/rooms', { method: 'POST', body: { name: name.trim() } });
    CN.rooms.unshift(room);
    toast('Room created — code ' + room.code, 'check');
    await connectOpenRoom(room.id);
  } catch (e) { toast(e.message || "Couldn't create the room", 'info'); }
}

async function cnJoinByCode() {
  const code = await cnPrompt({
    title: 'Join a room', label: 'Room code',
    placeholder: 'ABC23', okText: 'Join',
    hint: '5 characters — letters and numbers.',
  });
  if (!code || !code.trim()) return;
  try {
    const { room } = await cnApi('/api/connect/join', { method: 'POST', body: { code: code.trim() } });
    toast('Joined ' + room.name, 'check');
    await cnLoadRooms();
    await connectOpenRoom(room.id);
  } catch (e) {
    toast(e.message || "Couldn't join that room", 'info');
  }
}

/* ============================================================
   SCREEN 2 — inside a room
   ============================================================ */
function cnRoomHTML() {
  const r = CN.room;
  return `<div class="cn-room ${CN.inCall ? 'in-call' : ''} ${CN.chatOpen ? 'chat-open' : ''}" id="cnRoom">
    <div class="cn-room-head">
      <button class="btn ghost sm" id="cnBack">${svg('back', 14)} Rooms</button>
      <div class="cn-room-id">
        <div class="cn-room-name">${esc(r.name)}</div>
        ${r.topic ? `<div class="cn-room-topic">${esc(r.topic)}</div>` : ''}
      </div>
      <button class="cn-code big" data-copy="${esc(r.code)}" title="Copy the room code">${svg('copy', 13)}<span>${esc(r.code)}</span></button>
      <div class="spacer"></div>
      ${r.canManage ? `<button class="btn ghost sm" id="cnSettings">${svg('gear', 14)}</button>` : ''}
      <button class="btn ghost sm" id="cnToggleChat" title="Toggle chat">${svg('note', 14)}</button>
    </div>

    <div class="cn-room-body">
      <div class="cn-stage-wrap">
        <div class="cn-stage" id="cnStage">${cnStageHTML()}</div>
        <div class="cn-bar">${cnBarHTML()}</div>
      </div>
      <aside class="cn-chat" id="cnChat">
        <div class="cn-chat-head">
          <span>Chat</span>
          <span class="cn-chat-note">cleared when the room is deleted</span>
        </div>
        <div class="cn-msgs" id="cnMsgs">${cnMessagesHTML()}</div>
        <div class="cn-reply" id="cnReplyBar" hidden></div>
        <form class="cn-compose" id="cnCompose">
          <button type="button" class="cn-attach" id="cnAttach" title="Share a file">${svg('plus', 15)}</button>
          <textarea id="cnInput" rows="1" placeholder="Message the room…" maxlength="4000"></textarea>
          <button type="submit" class="btn primary sm" id="cnSend" title="Send">${svg('send', 14)}</button>
        </form>
        <input type="file" id="cnFilePick" class="hidden" multiple />
      </aside>
    </div>
  </div>`;
}

/* Can this page capture at all? False on a plain-http origin, where the browser
   removes navigator.mediaDevices outright (localhost is treated as secure). */
function cnCanCapture() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/* the video grid (or the "you're not in the call yet" panel) */
function cnStageHTML() {
  if (!CN.inCall) {
    const live = (CN.room && CN.room.liveCount) || 0;
    return `<div class="cn-prejoin">
      <div class="cn-prejoin-card">
        ${svg('window', 34, 1.4)}
        <h3>${live ? `${live} ${live === 1 ? 'person is' : 'people are'} in the call` : 'Nobody is in the call yet'}</h3>
        <p>Your camera, screen and voice go straight to the other people in the room — encrypted end to end. Simplex relays only the handshake.</p>
        ${cnCanCapture() ? '' : `<div class="cn-prejoin-warn">${svg('info', 14)}
          <span>This page is on <b>http</b>, so your browser blocks the mic and camera. Open Simplex over <b>https</b> to join the call.</span>
        </div>`}
        <p class="cn-prejoin-note">Your browser will ask for permission — choose <b>Allow</b> to join.</p>
        <div class="cn-prejoin-acts">
          <button class="btn primary" id="cnJoinCall">${svg('play', 15)} Join with mic</button>
          <button class="btn ghost" id="cnJoinCallCam">${svg('video', 15)} Join with mic + camera</button>
        </div>
      </div>
    </div>`;
  }
  /* Build the full tile list: self, every peer (minus the ones this viewer has
     ignored), then every screen share as its OWN tile. */
  const tiles = [
    { key: 'self', html: cnSelfTileHTML() },
    ...[...CN.peers.values()]
      .filter(p => !cnUserPref(p.id).ignored)
      .map(p => ({ key: p.id, html: cnPeerTileHTML(p) })),
    ...(CN.media.screen ? [{ key: 'scr:self', html: cnSelfScreenTileHTML() }] : []),
    ...[...CN.screens.values()]
      .filter(s => !cnUserPref(s.ownerId).ignored)
      .map(s => ({ key: s.key, html: cnScreenTileHTML(s) })),
  ];

  // FOCUS VIEW: the focused tile fills the stage, everyone else goes to the strip.
  if (CN.focus && tiles.some(t => t.key === CN.focus)) {
    const hero = tiles.find(t => t.key === CN.focus);
    const rest = tiles.filter(t => t.key !== CN.focus);
    return `<div class="cn-grid focused" id="cnGrid">
      ${hero.html}
      ${rest.length ? `<div class="cn-strip">${rest.map(t => t.html).join('')}</div>` : ''}
    </div>`;
  }
  // A focus target that has since left the call falls back to the grid.
  if (CN.focus) CN.focus = null;

  const n = tiles.length;
  const cls = n > 9 ? 'nmany' : `n${n}`;
  return `<div class="cn-grid ${cls}" id="cnGrid">${tiles.map(t => t.html).join('')}</div>`;
}

/* The class list every tile shares: focus state, and whether it's the hero. */
function cnTileCls(key) {
  return CN.focus === key ? 'focus' : '';
}

function cnSelfTileHTML() {
  // Your own tile now only ever shows your CAMERA — your screen share is a
  // separate tile (cnSelfScreenTileHTML), the same as everyone else's.
  const showing = CN.media.cam;
  return `<div class="cn-tile self ${cnTileCls('self')}" data-peer="self" data-key="self">
    <video id="cnSelfVideo" autoplay muted playsinline class="${showing ? '' : 'off'}"></video>
    ${showing ? '' : `<div class="cn-avatar">${cnInitials(CN.self ? CN.self.name : 'You')}</div>`}
    <div class="cn-tile-bar">
      <span class="cn-tile-name">You</span>
      <span class="cn-tile-icons">
        ${CN.media.hand ? '<span class="cn-hand">✋</span>' : ''}
        ${CN.media.mic ? '' : `<span class="cn-muted" title="Muted">${svg('volmute', 12)}</span>`}
      </span>
    </div>
  </div>`;
}

function cnPeerTileHTML(p) {
  const pref = cnUserPref(p.id);
  const showing = p.media && p.media.cam;
  const key = p.id;
  return `<div class="cn-tile ${cnTileCls(key)}" data-peer="${esc(p.id)}" data-key="${esc(key)}">
    <video autoplay playsinline data-video="${esc(p.id)}" class="${showing ? '' : 'off'}"></video>
    ${showing ? '' : `<div class="cn-avatar">${cnInitials(p.name)}</div>`}
    ${p.connecting ? `<div class="cn-connecting">connecting…</div>` : ''}
    <div class="cn-tile-bar">
      <span class="cn-tile-name">${esc(p.name)}</span>
      <span class="cn-tile-icons">
        ${pref.muted ? `<span class="cn-muted" title="Muted for you">${svg('volmute', 12)}</span>` : ''}
        ${pref.volume !== 1 && !pref.muted ? `<span class="cn-vol-badge" title="Volume ${Math.round(pref.volume * 100)}%">${Math.round(pref.volume * 100)}%</span>` : ''}
        ${p.media && p.media.hand ? '<span class="cn-hand">✋</span>' : ''}
        ${p.media && p.media.mic ? '' : `<span class="cn-muted" title="Muted">${svg('volmute', 12)}</span>`}
      </span>
    </div>
  </div>`;
}

/* Your own screen share, shown to you as its own tile so the layout matches what
   everyone else sees. Always "open" — it's your screen, there's nothing to fetch. */
function cnSelfScreenTileHTML() {
  const key = 'scr:self';
  return `<div class="cn-tile screen open ${cnTileCls(key)}" data-peer="self" data-key="${esc(key)}" data-screen="self">
    <video id="cnSelfScreenVideo" autoplay muted playsinline></video>
    <div class="cn-tile-bar">
      <span class="cn-tile-name">${svg('window', 11)} Your screen</span>
      <span class="cn-tile-icons"><span class="cn-live-tag">live</span></span>
    </div>
  </div>`;
}

/* Someone else's screen share.
   CLOSED  → a still frame refreshed about once a second, audio muted. This is the
             "1 fps preview" — cheap enough to have several on screen at once.
   OPEN    → the real <video>, full framerate, audio audible.
   Opening is deliberate (click / "Open stream") so a busy room doesn't decode
   every share the moment it appears. */
function cnScreenTileHTML(s) {
  const open = CN.openScreens.has(s.key);
  const pref = cnUserPref(s.ownerId);
  return `<div class="cn-tile screen ${open ? 'open' : 'closed'} ${cnTileCls(s.key)}"
       data-peer="${esc(s.ownerId)}" data-key="${esc(s.key)}" data-screen="${esc(s.key)}">
    ${open
      ? `<video autoplay playsinline data-screenvideo="${esc(s.key)}"></video>`
      : `<canvas class="cn-scr-preview" data-screenpreview="${esc(s.key)}"></canvas>
         <div class="cn-scr-overlay">
           <button class="cn-scr-open" data-openscreen="${esc(s.key)}">${svg('play', 15)} Open stream</button>
           <span class="cn-scr-hint">preview · 1 fps, no sound</span>
         </div>`}
    <div class="cn-tile-bar">
      <span class="cn-tile-name">${svg('window', 11)} ${esc(s.ownerName)}'s screen</span>
      <span class="cn-tile-icons">
        ${pref.muted ? `<span class="cn-muted" title="Muted for you">${svg('volmute', 12)}</span>` : ''}
        ${open ? '<span class="cn-live-tag">live</span>' : ''}
      </span>
    </div>
  </div>`;
}

/* ============================================================
   PER-USER, PER-VIEWER OVERRIDES
   These are LOCAL: volume/mute/ignore change what THIS viewer hears and sees and
   are never signalled to the room. Nobody is told they've been muted or ignored.
   ============================================================ */
const CN_PREF_DEFAULT = { volume: 1, muted: false, ignored: false };

function cnUserPref(id) {
  if (!id || id === 'self') return { ...CN_PREF_DEFAULT };
  let p = CN.userPrefs.get(id);
  if (!p) { p = { ...CN_PREF_DEFAULT }; CN.userPrefs.set(id, p); }
  return p;
}

function cnSetUserPref(id, patch) {
  const p = cnUserPref(id);
  Object.assign(p, patch);
  CN.userPrefs.set(id, p);
  cnApplyUserPrefs();
  cnSaveUserPrefs();
  cnRenderStage();
}

/* Push volume/mute onto the live <audio>/<video> elements. Ignoring is handled at
   render time (the tile isn't emitted at all) — but we still mute the element,
   because an ignored peer's audio would otherwise keep playing from a detached
   element that the browser is happy to leave running. */
function cnApplyUserPrefs() {
  for (const p of CN.peers.values()) {
    const pref = cnUserPref(p.id);
    const gain = pref.ignored || pref.muted ? 0 : pref.volume;
    // Their voice comes out of the dedicated element (cnPeerAudioEl); the tile's
    // <video> is always muted, so volume only has to be applied in one place.
    if (p.audioEl) {
      // HTMLMediaElement.volume can't exceed 1, so anything ABOVE 100% is done
      // with a Web Audio gain node instead (cnPeerBoost) — that's the whole
      // reason the slider goes to 150%: the common complaint is someone too
      // quiet to hear, which a 0..1 control cannot fix.
      if (gain > 1) {
        p.audioEl.volume = 1;
        cnPeerBoost(p, gain);
      } else {
        cnPeerBoost(p, 1);       // tear the booster down when it isn't needed
        p.audioEl.volume = Math.max(0, gain);
      }
      p.audioEl.muted = gain === 0;
    }
    // An ignored peer shouldn't keep decoding video we never show.
    const el = document.querySelector(`[data-video="${CSS.escape(p.id)}"]`);
    if (el) el.muted = true;
  }
  // a screen share follows its OWNER's volume, so muting someone kills their
  // screen's system audio too — which is what "mute this person" should mean
  for (const s of CN.screens.values()) {
    const pref = cnUserPref(s.ownerId);
    const gain = pref.ignored || pref.muted ? 0 : pref.volume;
    const el = document.querySelector(`[data-screenvideo="${CSS.escape(s.key)}"]`);
    if (el) { el.volume = gain; el.muted = gain === 0; }
  }
}

/* Amplify one peer beyond 100%.

   The graph is source(their stream) → gain → speakers, and the <audio> element is
   muted while it runs so the sound isn't playing twice. Built lazily and only for
   peers actually turned above 100%, because each one costs an AudioContext.

   Note this reads from the STREAM, not from the element: createMediaElementSource
   permanently rewires an element's output and can't be undone (the same trap
   documented in [[audio-equalizer]]), which would make going back below 100%
   impossible. */
function cnPeerBoost(p, gain) {
  if (gain <= 1) {
    // tear down and hand playback back to the plain element
    if (p.boost) {
      try { p.boost.src.disconnect(); p.boost.gain.disconnect(); p.boost.ctx.close(); } catch (e) {}
      p.boost = null;
      if (p.audioEl) p.audioEl.muted = false;
    }
    return;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || !p.audioStream) return;
  if (!p.boost) {
    try {
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(p.audioStream);
      const g = ctx.createGain();
      src.connect(g); g.connect(ctx.destination);
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      p.boost = { ctx, src, gain: g };
    } catch (e) { return; }
  }
  p.boost.gain.gain.value = gain;
  // the element would otherwise play the same audio underneath the boosted copy
  if (p.audioEl) p.audioEl.muted = true;
}

/* Persist per-room so an "ignore" survives a refresh. Only non-default entries
   are written — no point storing "everyone at 100%, nobody muted". */
function cnSaveUserPrefs() {
  if (!CN.room || typeof setPrefs !== 'function') return;
  const all = (PREFS && PREFS.connectUserPrefs) || {};
  const mine = {};
  for (const [id, p] of CN.userPrefs) {
    if (p.volume !== 1 || p.muted || p.ignored) mine[id] = { volume: p.volume, muted: p.muted, ignored: p.ignored };
  }
  if (Object.keys(mine).length) all[CN.room.id] = mine; else delete all[CN.room.id];
  setPrefs({ connectUserPrefs: all });
}

function cnLoadUserPrefs() {
  CN.userPrefs = new Map();
  if (!CN.room) return;
  const saved = ((PREFS && PREFS.connectUserPrefs) || {})[CN.room.id];
  if (!saved) return;
  for (const [id, p] of Object.entries(saved)) {
    CN.userPrefs.set(id, { ...CN_PREF_DEFAULT, ...p });
  }
}

function cnBarHTML() {
  if (!CN.inCall) return `<div class="cn-bar-hint">Not in the call</div>`;
  return `
    <button class="cn-ctl ${CN.media.mic ? 'on' : 'off'}" id="cnMic" title="${CN.media.mic ? 'Mute' : 'Unmute'}">
      ${svg(CN.media.mic ? 'vol' : 'volmute', 17)}<span>${CN.media.mic ? 'Mic' : 'Muted'}</span>
    </button>
    <button class="cn-ctl ${CN.media.cam ? 'on' : ''}" id="cnCam" title="Camera">
      ${svg('video', 17)}<span>Camera</span>
    </button>
    <button class="cn-ctl ${CN.media.screen ? 'on' : ''}" id="cnScreen" title="Share your screen">
      ${svg('window', 17)}<span>${CN.media.screen ? 'Stop share' : 'Share'}</span>
    </button>
    <button class="cn-ctl ${CN.media.hand ? 'on' : ''}" id="cnHand" title="Raise hand">
      <span class="cn-hand-ico">✋</span><span>Hand</span>
    </button>
    <button class="cn-ctl ${cnNoise().enabled ? 'on' : ''}" id="cnNoise" title="Noise cancellation">
      ${svg('vol', 17)}<span>Noise</span>
    </button>
    <button class="cn-ctl" id="cnDevices" title="Choose microphone & camera">${svg('gear', 17)}<span>Devices</span></button>
    ${cnIgnoredCount() ? `<button class="cn-ctl warn" id="cnIgnored" title="You've hidden some people">
      ${svg('eye', 17)}<span>${cnIgnoredCount()} hidden</span>
    </button>` : ''}
    <div class="spacer"></div>
    <button class="cn-ctl leave" id="cnLeave" title="Leave the call">${svg('close', 17)}<span>Leave</span></button>`;
}

function cnIgnoredCount() {
  let n = 0;
  for (const p of CN.peers.values()) if (cnUserPref(p.id).ignored) n++;
  return n;
}

function cnWireRoom() {
  const back = document.getElementById('cnBack');
  if (back) back.onclick = () => cnBackToLobby();
  const chatBtn = document.getElementById('cnToggleChat');
  if (chatBtn) chatBtn.onclick = () => {
    CN.chatOpen = !CN.chatOpen;
    const room = document.getElementById('cnRoom');
    if (room) room.classList.toggle('chat-open', CN.chatOpen);
  };
  const setBtn = document.getElementById('cnSettings');
  if (setBtn) setBtn.onclick = cnRoomSettings;
  document.querySelectorAll('#cnRoom [data-copy]').forEach(b => {
    b.onclick = () => cnCopyCode(b.getAttribute('data-copy'));
  });
  cnWireStage();
  cnWireChat();
}

function cnWireStage() {
  const j1 = document.getElementById('cnJoinCall');
  const j2 = document.getElementById('cnJoinCallCam');
  if (j1) j1.onclick = () => cnJoinCall({ cam: false });
  if (j2) j2.onclick = () => cnJoinCall({ cam: true });

  cnWireBar();

  document.querySelectorAll('.cn-tile').forEach(t => {
    const key = t.getAttribute('data-key');
    const peerId = t.getAttribute('data-peer');
    const screenKey = t.getAttribute('data-screen');

    t.onclick = (e) => {
      // the explicit "Open stream" button handles itself
      if (e.target.closest('[data-openscreen]')) return;
      // A CLOSED screen preview opens on click rather than focusing — opening is
      // what you almost always want from a 1fps still, and you can focus it after.
      if (screenKey && screenKey !== 'self' && !CN.openScreens.has(screenKey)) {
        cnOpenScreen(screenKey);
        return;
      }
      // Single click focuses (Discord), click the focused tile again to release.
      CN.focus = (CN.focus === key) ? null : key;
      cnRenderStage();
    };

    // Right-click: per-user controls, or the stream menu on a screen tile.
    t.oncontextmenu = (e) => {
      e.preventDefault();
      if (screenKey) cnScreenMenu(e, screenKey);
      else if (peerId && peerId !== 'self') cnUserMenu(e, peerId);
      else cnSelfMenu(e);
    };
  });

  document.querySelectorAll('[data-openscreen]').forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); cnOpenScreen(b.getAttribute('data-openscreen')); };
  });

  cnAttachStreams();
  cnApplyUserPrefs();
}

/* The control bar re-renders independently of the tiles (see cnRenderStage), so
   its handlers are bound separately. */
function cnWireBar() {
  const mic = document.getElementById('cnMic');
  const cam = document.getElementById('cnCam');
  const scr = document.getElementById('cnScreen');
  const hand = document.getElementById('cnHand');
  const dev = document.getElementById('cnDevices');
  const leave = document.getElementById('cnLeave');
  if (mic) mic.onclick = cnToggleMic;
  if (cam) cam.onclick = cnToggleCam;
  if (scr) scr.onclick = cnToggleScreen;
  if (hand) hand.onclick = cnToggleHand;
  if (dev) dev.onclick = cnDevicePicker;
  if (leave) leave.onclick = () => cnLeaveCall();
  const ign = document.getElementById('cnIgnored');
  if (ign) ign.onclick = cnIgnoredList;
  const noise = document.getElementById('cnNoise');
  if (noise) noise.onclick = cnNoiseSettings;
}

/* Re-render only the video area (not the chat, which would lose scroll + input).

   Replacing innerHTML throws away every <video> and builds new ones, which makes
   each element re-attach its srcObject and briefly go black. That was tolerable
   when the stage rendered rarely, but focus, screen tiles and per-user prefs all
   call this — and a peer-media event (someone toggling their mic) fires it for
   everyone. So: if the markup hasn't actually changed, don't touch the DOM.
   The rendered HTML is its own change key; nothing about a tile's appearance
   lives outside it. */
function cnRenderStage() {
  const stage = document.getElementById('cnStage');
  if (!stage) return;
  const html = cnStageHTML();
  if (stage._cnHTML !== html) {
    stage._cnHTML = html;
    stage.innerHTML = html;
    cnWireStage();
  } else {
    // Same markup, but the streams may have changed underneath it (a track
    // arriving doesn't alter the HTML), so the bindings still need refreshing.
    cnAttachStreams();
    cnApplyUserPrefs();
  }
  const bar = document.querySelector('.cn-bar');
  if (bar) {
    const barHTML = cnBarHTML();
    if (bar._cnHTML !== barHTML) { bar._cnHTML = barHTML; bar.innerHTML = barHTML; cnWireBar(); }
  }
  const room = document.getElementById('cnRoom');
  if (room) room.classList.toggle('in-call', CN.inCall);
}

/* Put the MediaStream objects back onto the freshly-rendered <video> elements.
   srcObject can't live in HTML, so this runs after every stage render. */
function cnAttachStreams() {
  // Your own tile is now ALWAYS your camera — the screen has its own tile below.
  const self = document.getElementById('cnSelfVideo');
  if (self) {
    if (CN.local && self.srcObject !== CN.local) self.srcObject = CN.local;
    cnTrackTileRatio(self);
  }
  const selfScr = document.getElementById('cnSelfScreenVideo');
  if (selfScr) {
    if (CN.screen && selfScr.srcObject !== CN.screen) selfScr.srcObject = CN.screen;
    cnTrackTileRatio(selfScr);
  }
  for (const p of CN.peers.values()) {
    const el = document.querySelector(`[data-video="${CSS.escape(p.id)}"]`);
    if (el && p.stream && el.srcObject !== p.stream) el.srcObject = p.stream;
    if (el) cnTrackTileRatio(el);
    cnPeerAudioEl(p);
  }
  // Screen shares: an OPEN one gets the live stream; a CLOSED one gets the
  // low-rate canvas preview instead.
  for (const s of CN.screens.values()) {
    if (CN.openScreens.has(s.key)) {
      const el = document.querySelector(`[data-screenvideo="${CSS.escape(s.key)}"]`);
      if (el && s.stream && el.srcObject !== s.stream) el.srcObject = s.stream;
      if (el) cnTrackTileRatio(el);
    } else {
      cnStartScreenPreview(s);
    }
  }
  cnSweepScreenPreviews();
}

/* Every peer gets a dedicated, hidden <audio> element carrying only their audio
   track, created once and reused for the life of the peer.

   Why not just let the tile's <video> play the sound? Because the tile is
   re-rendered whenever anything about the call changes, and the video element is
   display:none whenever their camera is off — both of which make audio playback
   unreliable across browsers (Safari in particular will stop a hidden media
   element). A persistent element outside the stage sidesteps all of it, and it's
   also the natural place to hang per-viewer volume (see cnApplyUserPrefs). */
function cnPeerAudioEl(p) {
  if (!p || !p.stream) return null;
  const audioTracks = p.stream.getAudioTracks();
  if (!audioTracks.length) return p.audioEl || null;

  if (!p.audioEl) {
    const a = document.createElement('audio');
    a.autoplay = true;
    a.setAttribute('playsinline', '');
    a.style.display = 'none';
    document.body.appendChild(a);
    p.audioEl = a;
  }
  // Bind ONLY the audio, so this element never decodes video.
  const want = p.audioStream || (p.audioStream = new MediaStream());
  for (const t of audioTracks) if (!want.getTracks().includes(t)) want.addTrack(t);
  if (p.audioEl.srcObject !== want) p.audioEl.srcObject = want;
  // Autoplay can be refused until the user has interacted; joining a call counts,
  // but retry quietly rather than failing silent.
  const pr = p.audioEl.play();
  if (pr && pr.catch) pr.catch(() => {});

  // The tile's <video> must NOT also play the audio, or everyone is doubled.
  const vid = document.querySelector(`[data-video="${CSS.escape(p.id)}"]`);
  if (vid) vid.muted = true;
  return p.audioEl;
}

/* ---- the 1 fps preview ----
   A closed share still has a live MediaStream arriving (we can't ask the sender to
   stop without a whole extra negotiation), but we don't want to PAINT it at 60fps
   in five tiles at once. So the stream is decoded into an offscreen <video> that
   is never shown, and once a second we copy one frame onto the tile's <canvas>.
   That keeps the cost to a single drawImage per share per second, and the audio
   element is never created at all, so a closed share is genuinely silent. */
function cnStartScreenPreview(s) {
  const canvas = document.querySelector(`[data-screenpreview="${CSS.escape(s.key)}"]`);
  if (!canvas || !s.stream) return;
  if (canvas._cnWired) { canvas._cnPaint && canvas._cnPaint(); return; }
  canvas._cnWired = true;

  // one hidden decoder per share, reused across re-renders
  let v = s.previewEl;
  if (!v) {
    v = document.createElement('video');
    v.autoplay = true; v.playsInline = true; v.muted = true;   // muted: preview is silent
    v.srcObject = s.stream;
    // Safari won't decode a <video> that isn't in the document, so it lives in
    // the DOM but is visually gone (display:none would stop decoding too).
    v.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;';
    document.body.appendChild(v);
    v.play().catch(() => {});
    s.previewEl = v;
  }

  const paint = () => {
    if (!canvas.isConnected) return;
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    try { canvas.getContext('2d').drawImage(v, 0, 0, w, h); } catch (e) {}
    const tile = canvas.closest('.cn-tile');
    if (tile) { tile.style.setProperty('--tile-ar', `${w} / ${h}`); tile.classList.add('has-video'); }
  };
  canvas._cnPaint = paint;
  paint();
  s.previewTimer = setInterval(paint, 1000);    // the "1 fps"
}

function cnStopScreenPreview(s) {
  if (s.previewTimer) { clearInterval(s.previewTimer); s.previewTimer = null; }
  if (s.previewEl) { try { s.previewEl.srcObject = null; s.previewEl.remove(); } catch (e) {} s.previewEl = null; }
}

/* Kill preview machinery for shares that are now open or gone. Without this the
   hidden <video> and its interval would leak every time a share is opened. */
function cnSweepScreenPreviews() {
  for (const s of CN.screens.values()) {
    if (CN.openScreens.has(s.key) && s.previewTimer) cnStopScreenPreview(s);
  }
}

/* ---- opening and closing a share ---- */
function cnOpenScreen(key) {
  const s = CN.screens.get(key);
  if (!s) return;
  CN.openScreens.add(key);
  cnStopScreenPreview(s);
  // Opening a share is nearly always followed by wanting to actually look at it,
  // so focus it in the same gesture.
  CN.focus = key;
  cnRenderStage();
  toast(`Opened ${s.ownerName}'s screen`, 'window');
}

function cnCloseScreen(key) {
  const s = CN.screens.get(key);
  CN.openScreens.delete(key);
  if (CN.focus === key) CN.focus = null;    // don't focus a tile you just closed
  cnRenderStage();
  if (s) toast(`Closed ${s.ownerName}'s screen`, 'info');
}

/* ============================================================
   CONTEXT MENUS (desktop right-click)
   A small positioned popover. Built once per open and torn down on any outside
   click, Escape, or scroll — the same lifecycle for every menu in this file.
   ============================================================ */
function cnMenu(ev, items) {
  cnCloseMenu();
  const m = document.createElement('div');
  m.className = 'cn-menu';
  m.id = 'cnMenu';
  m.innerHTML = items.map(it => {
    if (it.sep) return '<div class="cn-menu-sep"></div>';
    if (it.html) return `<div class="cn-menu-custom">${it.html}</div>`;
    return `<button class="cn-menu-item ${it.danger ? 'danger' : ''} ${it.on ? 'on' : ''}" data-act="${esc(it.id)}">
      ${it.icon ? svg(it.icon, 14) : '<span class="cn-menu-gap"></span>'}
      <span>${esc(it.label)}</span>
      ${it.on ? svg('check', 13) : ''}
    </button>`;
  }).join('');
  document.body.appendChild(m);

  // Position at the cursor, then pull back inside the viewport if it would spill.
  const pad = 8;
  const r = m.getBoundingClientRect();
  let x = ev.clientX, y = ev.clientY;
  if (x + r.width + pad > innerWidth) x = Math.max(pad, innerWidth - r.width - pad);
  if (y + r.height + pad > innerHeight) y = Math.max(pad, innerHeight - r.height - pad);
  m.style.left = x + 'px';
  m.style.top = y + 'px';

  m.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = () => {
      const it = items.find(i => i.id === b.getAttribute('data-act'));
      cnCloseMenu();
      if (it && it.run) it.run();
    };
  });
  // let a custom row (the volume slider) wire itself up
  items.filter(i => i.onMount).forEach(i => i.onMount(m));

  // Close on anything that isn't a click inside the menu.
  setTimeout(() => {
    const off = (e) => { if (!m.contains(e.target)) cnCloseMenu(); };
    const esckey = (e) => { if (e.key === 'Escape') cnCloseMenu(); };
    m._off = off; m._esc = esckey;
    document.addEventListener('mousedown', off, true);
    document.addEventListener('contextmenu', off, true);
    document.addEventListener('keydown', esckey, true);
    window.addEventListener('scroll', cnCloseMenu, true);
  }, 0);
  return m;
}

function cnCloseMenu() {
  const m = document.getElementById('cnMenu');
  if (!m) return;
  if (m._off) {
    document.removeEventListener('mousedown', m._off, true);
    document.removeEventListener('contextmenu', m._off, true);
  }
  if (m._esc) document.removeEventListener('keydown', m._esc, true);
  window.removeEventListener('scroll', cnCloseMenu, true);
  m.remove();
}

/* Right-click a person: volume, mute-for-me, ignore, focus. */
function cnUserMenu(ev, peerId) {
  const p = CN.peers.get(peerId);
  if (!p) return;
  const pref = cnUserPref(peerId);
  const focused = CN.focus === peerId;

  cnMenu(ev, [
    { id: 'hdr', html: `<div class="cn-menu-head">${esc(p.name)}</div>` },
    {
      id: 'vol',
      html: `<div class="cn-menu-vol">
        <label>Volume <b id="cnVolVal">${Math.round(pref.volume * 100)}%</b></label>
        <input type="range" id="cnVolSlider" min="0" max="150" step="5" value="${Math.round(pref.volume * 100)}" />
      </div>`,
      // The slider applies LIVE as it's dragged — you're adjusting someone who is
      // talking right now, so waiting for a commit would make it unusable.
      onMount: (root) => {
        const sl = root.querySelector('#cnVolSlider');
        const val = root.querySelector('#cnVolVal');
        if (!sl) return;
        sl.oninput = () => {
          const v = Number(sl.value) / 100;
          val.textContent = Math.round(v * 100) + '%';
          const pr = cnUserPref(peerId);
          pr.volume = v; pr.muted = false;
          CN.userPrefs.set(peerId, pr);
          cnApplyUserPrefs();
        };
        // persist only when they let go, not on every pixel of the drag
        sl.onchange = () => { cnSaveUserPrefs(); cnRenderStage(); };
      },
    },
    { sep: true },
    {
      id: 'mute', icon: pref.muted ? 'vol' : 'volmute', on: pref.muted,
      label: pref.muted ? 'Unmute for me' : 'Mute for me',
      run: () => cnSetUserPref(peerId, { muted: !pref.muted }),
    },
    {
      id: 'ignore', icon: 'eye', on: pref.ignored,
      label: pref.ignored ? 'Stop ignoring' : 'Ignore (hide camera & sound)',
      run: () => {
        cnSetUserPref(peerId, { ignored: !pref.ignored });
        toast(pref.ignored ? `Showing ${p.name} again` : `Ignoring ${p.name}`, 'info');
      },
    },
    { sep: true },
    {
      id: 'focus', icon: 'full', label: focused ? 'Unfocus' : 'Focus',
      run: () => { CN.focus = focused ? null : peerId; cnRenderStage(); },
    },
  ]);
}

/* Right-click your own tile: a short menu, since muting yourself for yourself is
   meaningless — the useful actions are the ones in the control bar. */
function cnSelfMenu(ev) {
  const focused = CN.focus === 'self';
  cnMenu(ev, [
    { id: 'hdr', html: `<div class="cn-menu-head">You</div>` },
    { id: 'focus', icon: 'full', label: focused ? 'Unfocus' : 'Focus', run: () => { CN.focus = focused ? null : 'self'; cnRenderStage(); } },
    { id: 'mic', icon: CN.media.mic ? 'volmute' : 'vol', label: CN.media.mic ? 'Mute my mic' : 'Unmute my mic', run: cnToggleMic },
    { id: 'cam', icon: 'video', label: CN.media.cam ? 'Turn camera off' : 'Turn camera on', run: cnToggleCam },
  ]);
}

/* Right-click a screen share: open / close / focus. */
function cnScreenMenu(ev, key) {
  // your own share: the only sensible actions are focus and stop sharing
  if (key === 'scr:self') {
    const focused = CN.focus === 'scr:self';
    return cnMenu(ev, [
      { id: 'hdr', html: `<div class="cn-menu-head">Your screen</div>` },
      { id: 'focus', icon: 'full', label: focused ? 'Unfocus' : 'Focus', run: () => { CN.focus = focused ? null : 'scr:self'; cnRenderStage(); } },
      { sep: true },
      { id: 'stop', icon: 'close', danger: true, label: 'Stop sharing', run: cnStopScreen },
    ]);
  }
  const s = CN.screens.get(key);
  if (!s) return;
  const open = CN.openScreens.has(key);
  const focused = CN.focus === key;
  cnMenu(ev, [
    { id: 'hdr', html: `<div class="cn-menu-head">${esc(s.ownerName)}'s screen</div>` },
    open
      ? { id: 'close', icon: 'close', label: 'Close stream', run: () => cnCloseScreen(key) }
      : { id: 'open', icon: 'play', label: 'Open stream', run: () => cnOpenScreen(key) },
    { id: 'focus', icon: 'full', label: focused ? 'Unfocus' : 'Focus', run: () => { CN.focus = focused ? null : key; cnRenderStage(); } },
    { sep: true },
    { id: 'user', icon: 'user', label: `Controls for ${s.ownerName}…`, run: () => cnUserMenu(ev, s.ownerId) },
  ]);
}

/* The "N hidden" chip in the control bar — a way back for anyone you've ignored,
   since an ignored person has no tile left to right-click. */
function cnIgnoredList() {
  const hidden = [...CN.peers.values()].filter(p => cnUserPref(p.id).ignored);
  if (!hidden.length) return;
  const rows = hidden.map(p => `<li><span>${esc(p.name)}</span>
    <button class="cn-kick" data-unignore="${esc(p.id)}">Show again</button></li>`).join('');
  cnHelpModal('People you\'ve hidden', `
    <p>These people are hidden for <b>you only</b> — they haven't been told, and everyone else still sees and hears them normally.</p>
    <ul class="cn-ignored-list">${rows}</ul>`);
  document.querySelectorAll('[data-unignore]').forEach(b => {
    b.onclick = () => {
      cnSetUserPref(b.getAttribute('data-unignore'), { ignored: false });
      b.closest('li').remove();
    };
  });
}

/* Tiles are a fixed 16:9 by default. Once a <video> actually has frames, adopt the
   STREAM's own ratio so a 4:3 webcam or a tall phone screen-share isn't letterboxed
   into a 16:9 hole. Also flags .has-video so the tile stops being a plain avatar
   box. Runs on loadedmetadata AND on resize, because a screen-share's dimensions
   change when the presenter switches window. */
function cnTrackTileRatio(video) {
  if (!video || video._cnRatioWired) return;
  video._cnRatioWired = true;
  const apply = () => {
    const tile = video.closest('.cn-tile');
    if (!tile) return;
    const w = video.videoWidth, h = video.videoHeight;
    if (w > 0 && h > 0) {
      tile.style.setProperty('--tile-ar', `${w} / ${h}`);
      tile.classList.add('has-video');
    } else {
      tile.style.removeProperty('--tile-ar');
      tile.classList.remove('has-video');
    }
  };
  video.addEventListener('loadedmetadata', apply);
  video.addEventListener('resize', apply);
  video.addEventListener('emptied', apply);
  apply();
}

async function cnBackToLobby() {
  if (CN.inCall) {
    const ok = await confirmDialog('Leave the call?', 'You will hang up but stay a member of the room.', 'Leave call');
    if (!ok) return;
    await cnLeaveCall();
  }
  CN.room = null;
  cnStopMessagePoll();
  cnRenderBody();
  syncUrl();
}

/* Open a room (also the router's entry point for /connect/room/<id>). */
async function connectOpenRoomImpl(id, quiet) {
  try {
    const data = await cnApi('/api/connect/rooms/' + encodeURIComponent(id));
    CN.room = data.room;
    if (!quiet) { CN.messages = []; CN.lastMsgAt = 0; }
    if (!cnOnConnect()) return;
    cnRenderBody();
    if (!quiet) {
      await cnLoadMessages();
      cnStartMessagePoll();
    }
    syncUrl();
  } catch (e) {
    if (e && e.code === 'AUTH') return relock();
    toast("Couldn't open that room", 'info');
    CN.room = null;
    cnRenderBody();
  }
}

/* ============================================================
   THE CALL — getUserMedia, the mesh, and the signaling stream
   ============================================================ */
async function cnJoinCall({ cam }) {
  if (CN.inCall) return;

  // Browsers only expose mediaDevices on a SECURE ORIGIN (https, or localhost). Over
  // plain http on a LAN IP the whole API is missing, so getUserMedia would throw a
  // bare TypeError and look like a mysterious permission failure. Catch it here and
  // say what's actually wrong, since the fix is "use the https address".
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    cnInsecureOriginModal();
    return;
  }

  // Show WHY the browser is about to prompt. Chrome/Safari put the permission bubble
  // in a corner of the chrome where it's easy to miss (or dismiss by clicking away),
  // and a dismissed prompt looks identical to "nothing happened".
  const hint = cnPermHint(cam);
  let stream = null;
  try {
    // Audio FIRST, on its own. A combined request is all-or-nothing: one awkward
    // video constraint (see the Safari note on cnVideoConstraints) would fail the
    // mic too and drop the user out of the call entirely.
    stream = await navigator.mediaDevices.getUserMedia({ audio: cnAudioConstraints() });
  } catch (e) {
    hint.remove();
    cnPermissionHelpModal(e, cam);
    return;
  }

  // Then the camera, through the relaxation ladder, as a separate request.
  if (cam) {
    try {
      const vs = await cnGetCameraStream();
      for (const t of vs.getVideoTracks()) stream.addTrack(t);
    } catch (e) {
      // Joining with just the mic is a reasonable outcome; they can turn the
      // camera on later from the control bar.
      toast(e && e.name === 'NotFoundError'
        ? 'No camera found — joining with just your mic'
        : "Couldn't start your camera — joining with just your mic", 'info');
    }
  }
  hint.remove();

  CN.local = stream;
  CN.media.mic = true;
  CN.media.cam = !!cam && stream.getVideoTracks().length > 0;
  CN.inCall = true;
  cnLoadUserPrefs();
  // Route the mic through the noise-suppression graph before anyone hears it.
  await cnApplyMicProcessing();
  cnRenderStage();
  cnOpenSignaling();
  cnStartLevelMeter();
}

/* A small banner shown WHILE the browser's own permission prompt is up, so the user
   knows what they're being asked and that they must click Allow. Removed as soon as
   the request settles either way. */
function cnPermHint(cam) {
  const el = document.createElement('div');
  el.className = 'cn-perm-hint';
  el.innerHTML = `${svg('info', 16)}<div>
    <b>Allow ${cam ? 'microphone and camera' : 'microphone'} access</b>
    <span>Your browser is asking now — choose <b>Allow</b> to join the call.</span>
  </div>`;
  document.body.appendChild(el);
  return el;
}

/* getUserMedia failed. Explain the specific cause and how to undo it — a blocked
   permission is sticky per-site, so "try again" alone never works. */
function cnPermissionHelpModal(e, cam) {
  const name = (e && e.name) || '';
  const what = cam ? 'microphone and camera' : 'microphone';
  let title = 'Could not start your ' + what;
  let body = '';

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    title = `${cam ? 'Microphone/camera' : 'Microphone'} access is blocked`;
    body = `<p>Your browser blocked access, or the prompt was dismissed. Because the choice is remembered for this site, you need to clear it before trying again:</p>
      <ol class="cn-help-steps">
        <li>Click the <b>padlock</b> (or the camera/mic icon) in the address bar.</li>
        <li>Set <b>Microphone</b>${cam ? ' and <b>Camera</b>' : ''} to <b>Allow</b>.</li>
        <li>Reload the page and press Join again.</li>
      </ol>
      <p class="dim">On iPhone/iPad: Settings → Safari → Camera &amp; Microphone → Allow.</p>`;
  } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    title = 'No ' + what + ' found';
    body = `<p>Your device didn't report ${cam ? 'a microphone or camera' : 'a microphone'}. Plug one in (or connect your headset) and press Join again.</p>`;
  } else if (name === 'NotReadableError' || name === 'AbortError') {
    title = 'Your ' + what + ' is busy';
    body = `<p>Another app is using it — Zoom, Teams, Discord and OBS are the usual culprits. Close that app, then press Join again.</p>`;
  } else {
    body = `<p>${esc((e && e.message) || 'Unknown error')}</p>
      <p class="dim">If this keeps happening, try another browser — Chrome, Edge, Firefox and Safari all support calls.</p>`;
  }

  cnHelpModal(title, body);
}

/* The page isn't on a secure origin, so the browser hides the capture API entirely.
   No amount of permission-granting fixes this — they have to use https. */
function cnInsecureOriginModal() {
  const httpsUrl = 'https://' + location.host + location.pathname;
  cnHelpModal('This page isn\'t secure, so calls are blocked', `
    <p>Browsers only allow microphone and camera access over <b>https</b>. This page was opened over plain <b>http</b> (<code>${esc(location.origin)}</code>), so the browser hides those features completely — this isn't a Simplex permission you can grant.</p>
    <p><b>Open Simplex over https instead</b>, then press Join again.</p>
    <p class="dim">If you're on the local network, use the https address rather than the raw IP. <code>localhost</code> also counts as secure for testing on the same machine.</p>
    <p><a href="${esc(httpsUrl)}" class="cn-help-link">Try ${esc(httpsUrl)}</a></p>`);
}

/* Shared help modal built on the app's existing .modal-bg / .modal markup. */
function cnHelpModal(title, bodyHTML) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal cn-help">
    <h3>${esc(title)}</h3>
    <div class="cn-help-body">${bodyHTML}</div>
    <div class="acts"><button class="btn primary" data-ok>Got it</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-ok]').onclick = close;
  bg.onclick = (e) => { if (e.target === bg) close(); };
}

/* 64 kbps stereo Opus is the target; these hints tell the browser to give us
   clean, full-band audio rather than the narrowband speech profile. */
function cnAudioConstraints() {
  const id = CN.devices.micId;
  const n = cnNoise();
  return {
    // `ideal`, not `exact` — same reasoning as the camera: a stale deviceId
    // shouldn't fail the whole request.
    ...(id ? { deviceId: { ideal: id } } : {}),
    echoCancellation: true,
    // LAYER 1: the browser's built-in denoiser. Users who find it over-processes
    // their voice (it can sound thin on a good mic) can turn it off and rely on
    // our gate alone.
    noiseSuppression: !!(n.enabled && n.browserNS),
    autoGainControl: true,
    channelCount: 2,
    sampleRate: 48000,
  };
}
/* Camera constraints for the chosen quality.
   `relaxed` drops everything except the device, and is what we retry with when a
   browser rejects the sized request outright (see cnGetCameraStream).

   Safari note — this is the "lower the camera to 360 and the camera just turns
   off" bug. Safari on macOS treats width/height/frameRate far more strictly than
   Chrome does even when they're expressed as `ideal`: asking a camera whose
   native modes start at 1280x720 for 640x360 at 24fps can fail the whole
   getUserMedia call with OverconstrainedError instead of quietly picking the
   nearest mode. The old code caught OverconstrainedError, blanked the deviceId
   and retried with the SAME resolution, so the retry failed the same way and the
   camera ended up off. Hence: no `max` on frameRate, and a real relaxation ladder
   below rather than a single retry. */
function cnVideoConstraints(opts = {}) {
  const id = CN.devices.camId;
  const q = cnCamQuality();
  if (opts.relaxed) {
    // last resort: just give us this camera, any mode it likes
    return id ? { deviceId: { ideal: id } } : true;
  }
  return {
    // `ideal`, never `exact`: an exact deviceId that no longer resolves (camera
    // unplugged, or Safari rotating its ids between grants) is itself a common
    // source of OverconstrainedError.
    ...(id ? { deviceId: { ideal: id } } : {}),
    width: { ideal: q.w }, height: { ideal: q.h },
    // No `max` here. `frameRate: {ideal, max}` is the single most rejection-prone
    // part of this constraint set on Safari — a camera that only reports 30fps
    // modes can fail a max:24 request. The sender-side bitrate cap already limits
    // what we actually transmit, so the capture framerate needs no hard ceiling.
    frameRate: { ideal: q.fps },
  };
}

/* Open the camera, relaxing the constraints step by step rather than giving up.
   Returns a MediaStream, or throws the LAST error if even the bare request fails
   (so the permission/hardware message the user sees is the real one). */
async function cnGetCameraStream() {
  const attempts = [
    cnVideoConstraints(),                 // what the user actually asked for
    { ...cnVideoConstraints(), frameRate: undefined },   // same size, any framerate
    cnVideoConstraints({ relaxed: true }),               // this camera, any mode
    true,                                                // any camera at all
  ];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const video = attempts[i];
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video });
      if (i > 0) {
        // Say so plainly — silently handing back 720p when they picked 360p would
        // leave them thinking the setting did nothing.
        const t = s.getVideoTracks()[0];
        const st = (t && t.getSettings && t.getSettings()) || {};
        if (st.width && st.height) {
          toast(`Your camera doesn't support that exact size — using ${st.width}×${st.height}`, 'info');
        }
      }
      return s;
    } catch (e) {
      lastErr = e;
      // A permission refusal will fail identically at every step, so stop early
      // rather than prompting the user four times.
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw e;
      // NotReadableError means the device is busy — relaxing constraints won't help.
      if (e && e.name === 'NotReadableError') throw e;
    }
  }
  throw lastErr || new Error('no camera');
}
function cnScreenConstraints() {
  const q = cnScreenQuality();
  return {
    video: { frameRate: { ideal: q.fps, max: q.fps }, width: { ideal: q.w }, height: { ideal: q.h } },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  };
}
function cnMediaError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError') return 'Simplex needs permission to use your mic/camera';
  if (n === 'NotFoundError') return 'No microphone or camera found';
  if (n === 'NotReadableError') return 'Your mic/camera is in use by another app';
  return 'Could not start your mic/camera';
}

/* ============================================================
   NOISE CANCELLATION
   Two layers, because they catch different things:

   1) The BROWSER's own suppressor (`noiseSuppression` in the audio constraints).
      This is the good one — a real, trained denoiser inside Chrome/Safari/Firefox
      that removes steady background noise without touching speech. It's on by
      default and costs nothing.

   2) Our own Web Audio chain on top: a high-pass to kill rumble, and a noise
      GATE that mutes the mic between sentences. This is what handles the things
      the browser's suppressor leaves through — a fan, a mechanical keyboard, a
      room with an echo, someone talking in the background.

   Layer 2 is the tweakable part, because a gate is a trade: set it too high and
   the start of your own quiet sentences gets clipped. That's exactly why the
   controls (and the "hear yourself" test) exist rather than shipping one fixed
   setting and hoping.

   Everything is plain Web Audio — no model to download, works offline, and adds
   about a millisecond of latency.
   ============================================================ */
const CN_NOISE_DEFAULTS = {
  enabled: true,        // on by default, per the brief
  browserNS: true,      // layer 1
  gate: true,           // layer 2: the noise gate
  threshold: -50,       // dBFS below which we treat it as silence
  attack: 8,            // ms to open once you start talking (short = no clipped words)
  release: 220,         // ms to close after you stop (long = doesn't chop word gaps)
  highPass: 85,         // Hz; below this is rumble, handling noise and pops
  gain: 1,              // post-gate makeup gain
};

function cnNoise() {
  return { ...CN_NOISE_DEFAULTS, ...((PREFS && PREFS.connectNoise) || {}) };
}

/* Build (or rebuild) the mic processing graph and swap its output into the call.

   The chain: mic → high-pass → analyser ─┐
                                          ├→ gate gain → makeup gain → destination
   The analyser drives the gate in a rAF loop rather than using a ScriptProcessor
   (deprecated, and it runs on the main thread) or an AudioWorklet (needs a
   separate module file, which this no-build app can't lazily add cheaply). At a
   ~60Hz control rate a gate is perceptually indistinguishable from a sample-rate
   one, because attack/release are measured in tens of milliseconds anyway. */
async function cnBuildMicChain(sourceTrack) {
  const cfg = cnNoise();
  if (!cfg.enabled || !cfg.gate) return null;      // layer 1 only; nothing to build
  if (!window.AudioContext && !window.webkitAudioContext) return null;

  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ sampleRate: 48000 });
  // Safari starts contexts suspended until a gesture; joining a call IS a gesture,
  // but resume() is still required to be explicit about it.
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }

  const src = ctx.createMediaStreamSource(new MediaStream([sourceTrack]));

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = cfg.highPass;
  hp.Q.value = 0.7;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.2;

  const gate = ctx.createGain();
  gate.gain.value = 1;

  const makeup = ctx.createGain();
  makeup.gain.value = cfg.gain;

  const dest = ctx.createMediaStreamDestination();

  src.connect(hp);
  hp.connect(analyser);
  hp.connect(gate);
  gate.connect(makeup);
  makeup.connect(dest);

  const chain = {
    ctx, src, hp, analyser, gate, makeup, dest,
    sourceTrack,
    outTrack: dest.stream.getAudioTracks()[0],
    raf: 0, open: false, level: -100, cfg,
  };

  /* ---- the gate loop ----
     Driven by setInterval, NOT requestAnimationFrame. rAF is throttled to zero in
     a hidden tab, and this loop decides whether your microphone is open — a user
     who switched tabs mid-call would have the gate freeze in whatever state it
     was last in, muting them for the rest of the call with no way to tell.
     A 16ms interval keeps ticking regardless of visibility. Browsers do clamp
     background timers (to ~1s in some cases), which softens the gate's timing but
     never strands it closed, because each tick still re-evaluates the level. */
  const buf = new Float32Array(analyser.fftSize);
  const tick = () => {
    if (!chain.raf) return;                       // stopped
    analyser.getFloatTimeDomainData(buf);
    // RMS → dBFS. RMS rather than peak so a single click doesn't open the gate.
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    chain.level = db;

    const c = chain.cfg;
    const shouldOpen = db > c.threshold;
    if (shouldOpen !== chain.open) {
      chain.open = shouldOpen;
      const now = ctx.currentTime;
      const secs = (shouldOpen ? c.attack : c.release) / 1000;
      // Ramp rather than jump: an instant gain change is an audible click.
      gate.gain.cancelScheduledValues(now);
      gate.gain.setValueAtTime(gate.gain.value, now);
      gate.gain.linearRampToValueAtTime(shouldOpen ? 1 : 0, now + secs);
    }
  };
  chain.raf = setInterval(tick, 16);

  return chain;
}

/* Tear the graph down and release its AudioContext. Browsers cap the number of
   live AudioContexts, so leaking one per settings change would eventually stop
   the mic working entirely. */
function cnStopMicChain() {
  const c = CN.micChain;
  if (!c) return;
  CN.micChain = null;
  if (c.raf) { clearInterval(c.raf); c.raf = 0; }
  try { c.src.disconnect(); c.hp.disconnect(); c.gate.disconnect(); c.makeup.disconnect(); } catch (e) {}
  try { c.ctx.close(); } catch (e) {}
}

/* Put the processed track on the wire (or take it back off).
   The RAW mic track stays in CN.local as the source; what peers receive is the
   chain's output. replaceTrack means this needs no renegotiation, so it can be
   toggled mid-sentence without a glitch. */
async function cnApplyMicProcessing() {
  if (!CN.local) return;
  const raw = CN.local.getAudioTracks()[0];
  if (!raw) return;

  cnStopMicChain();
  const cfg = cnNoise();

  let outbound = raw;
  if (cfg.enabled && cfg.gate) {
    try {
      const chain = await cnBuildMicChain(raw);
      if (chain && chain.outTrack) {
        CN.micChain = chain;
        outbound = chain.outTrack;
        // The processed track carries its own enabled state, so the mute button
        // has to reach it too.
        outbound.enabled = CN.media.mic;
      }
    } catch (e) {
      // Any failure here falls back to the raw mic — a call with unfiltered audio
      // beats a call with no audio.
      console.warn('[connect] noise chain failed, using the raw mic', e);
    }
  }

  CN.outboundAudio = outbound;
  for (const peer of CN.peers.values()) {
    if (!peer.pc) continue;
    const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
    if (sender && sender.track !== outbound) {
      try { await sender.replaceTrack(outbound); } catch (e) {}
    }
  }
}

/* ---- the "hear yourself" test ----
   Routes the PROCESSED mic to the speakers so the user can hear exactly what the
   room hears while they move the sliders. Headphones are essential here and the
   modal says so — on speakers this is a feedback loop. */
async function cnStartMicTest() {
  cnStopMicTest();
  if (!CN.local) return null;
  const raw = CN.local.getAudioTracks()[0];
  if (!raw) return null;

  // A test needs its own chain: the call's chain output goes to a
  // MediaStreamDestination, and we want this one going to the speakers instead.
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  const ctx = new Ctx({ sampleRate: 48000 });
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }

  const cfg = cnNoise();
  const src = ctx.createMediaStreamSource(new MediaStream([raw]));
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = cfg.highPass; hp.Q.value = 0.7;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.2;
  const gate = ctx.createGain(); gate.gain.value = cfg.gate ? 0 : 1;
  const makeup = ctx.createGain(); makeup.gain.value = cfg.gain;

  src.connect(hp);
  hp.connect(analyser);
  hp.connect(gate);
  gate.connect(makeup);
  makeup.connect(ctx.destination);        // ← the speakers, not a peer

  const test = { ctx, src, hp, analyser, gate, makeup, cfg, raf: 0, level: -100, open: false, onLevel: null };
  const buf = new Float32Array(analyser.fftSize);
  const tick = () => {
    if (!test.raf) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    test.level = db;
    const c = test.cfg;
    const shouldOpen = !c.gate || db > c.threshold;
    if (shouldOpen !== test.open) {
      test.open = shouldOpen;
      const now = ctx.currentTime;
      const secs = (shouldOpen ? c.attack : c.release) / 1000;
      gate.gain.cancelScheduledValues(now);
      gate.gain.setValueAtTime(gate.gain.value, now);
      gate.gain.linearRampToValueAtTime(shouldOpen ? 1 : 0, now + secs);
    }
    if (test.onLevel) test.onLevel(db, shouldOpen);
  };
  // Same reasoning as the call chain: a timer, not rAF. The meter is only visible
  // while the panel is open anyway, and a gate that stops evaluating would show a
  // frozen reading that doesn't match what you're hearing.
  test.raf = setInterval(tick, 16);
  CN.micTest = test;
  return test;
}

function cnStopMicTest() {
  const t = CN.micTest;
  if (!t) return;
  CN.micTest = null;
  if (t.raf) { clearInterval(t.raf); t.raf = 0; }
  try { t.src.disconnect(); t.hp.disconnect(); t.gate.disconnect(); t.makeup.disconnect(); } catch (e) {}
  try { t.ctx.close(); } catch (e) {}
}

/* Open the SSE signaling stream. Everything about who is in the call flows
   through here. */
function cnOpenSignaling() {
  cnCloseSignaling();
  const url = '/api/connect/rooms/' + encodeURIComponent(CN.room.id) + '/events';
  const es = new EventSource(url);
  CN.es = es;

  es.addEventListener('welcome', (ev) => {
    const d = JSON.parse(ev.data);
    CN.self = d.self;
    // We are the newcomer: WE call everyone already here. See the glare note up top.
    for (const p of d.peers) {
      cnAddPeer(p);
      cnCallPeer(p.id);
    }
    cnPublishMedia();
    cnRenderStage();
  });

  es.addEventListener('peer-joined', (ev) => {
    const d = JSON.parse(ev.data);
    // They arrived after us, so THEY will offer. We just make a tile and wait.
    cnAddPeer(d);
    cnRenderStage();
    toast(d.name + ' joined the call', 'user');
  });

  es.addEventListener('peer-left', (ev) => {
    const d = JSON.parse(ev.data);
    const p = CN.peers.get(d.id);
    if (p) toast(p.name + ' left the call', 'user');
    cnRemovePeer(d.id);
    cnRenderStage();
  });

  es.addEventListener('peer-media', (ev) => {
    const d = JSON.parse(ev.data);
    const p = CN.peers.get(d.id);
    if (p) { p.media = d.media; cnRenderStage(); }
  });

  es.addEventListener('signal', (ev) => {
    const d = JSON.parse(ev.data);
    cnOnSignal(d).catch(err => console.warn('[connect] signal failed', err));
  });

  // chat + room events arrive on the same stream while we're in the call
  es.addEventListener('message', (ev) => cnOnMessageEvent(JSON.parse(ev.data)));
  es.addEventListener('message-edited', (ev) => cnOnMessageEdited(JSON.parse(ev.data)));
  es.addEventListener('message-deleted', (ev) => cnOnMessageDeleted(JSON.parse(ev.data)));
  es.addEventListener('message-reacted', (ev) => cnOnMessageReacted(JSON.parse(ev.data)));

  es.addEventListener('room-updated', (ev) => {
    const d = JSON.parse(ev.data);
    if (CN.room) { Object.assign(CN.room, d.room); cnRenderBody(); }
  });
  es.addEventListener('room-deleted', () => {
    toast('This room was deleted', 'info');
    cnLeaveCall({ silent: true });
    CN.room = null;
    cnLoadRooms();
  });
  es.addEventListener('kicked', () => {
    toast('You were removed from this room', 'info');
    cnLeaveCall({ silent: true });
    CN.room = null;
    cnLoadRooms();
  });

  // EventSource reconnects on its own; a hard failure while we think we're in the
  // call means the room is gone or we lost auth.
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED && CN.inCall) {
      toast('Lost the connection to the room', 'info');
      cnLeaveCall({ silent: true });
      cnRenderBody();
    }
  };
}

function cnCloseSignaling() {
  if (CN.es) { try { CN.es.close(); } catch (e) {} CN.es = null; }
}

function cnAddPeer(p) {
  if (CN.peers.has(p.id)) return CN.peers.get(p.id);
  const peer = {
    id: p.id, name: p.name, peerId: p.peerId,
    media: p.media || { mic: false, cam: false, screen: false },
    pc: null, stream: null, connecting: true,
    pendingIce: [],   // ICE that arrives before the remote description is set
  };
  CN.peers.set(p.id, peer);
  return peer;
}

function cnRemovePeer(id) {
  const p = CN.peers.get(id);
  if (!p) return;
  try { if (p.pc) { p.pc.onicecandidate = null; p.pc.ontrack = null; p.pc.close(); } } catch (e) {}
  // the persistent audio element and any boost graph go with them, or they leak
  // one <audio> (and possibly one AudioContext) per person who ever joined
  cnPeerBoost(p, 1);
  if (p.audioEl) { try { p.audioEl.srcObject = null; p.audioEl.remove(); } catch (e) {} p.audioEl = null; }
  CN.peers.delete(id);
  CN.analysers.delete(id);
  if (CN.pinned === id) CN.pinned = null;
  if (CN.focus === id) CN.focus = null;
  // their screen tile (and its preview timer) goes with them
  cnRemoveRemoteScreen('scr:' + id);
}

/* Build the RTCPeerConnection for one peer and attach our outgoing tracks. */
function cnMakePc(peerId) {
  const peer = CN.peers.get(peerId);
  if (!peer) return null;
  if (peer.pc) return peer.pc;

  const pc = new RTCPeerConnection({ iceServers: CN_ICE, bundlePolicy: 'max-bundle' });
  peer.pc = pc;

  // send our current tracks. The screen goes out on its OWN MediaStream so the
  // receiver can tell it apart from the camera — see cnIsScreenStream.
  if (CN.local) {
    for (const t of CN.local.getTracks()) {
      // Peers hear the NOISE-PROCESSED mic, not the raw one. CN.local keeps the
      // raw track because that's what the chain (and the level meter) reads from.
      if (t.kind === 'audio' && CN.outboundAudio && CN.outboundAudio !== t) continue;
      pc.addTrack(t, CN.local);
    }
    if (CN.outboundAudio && !CN.local.getAudioTracks().includes(CN.outboundAudio)) {
      pc.addTrack(CN.outboundAudio, CN.local);
    }
  }
  if (CN.screen) for (const t of CN.screen.getTracks()) pc.addTrack(t, CN.screen);

  pc.onicecandidate = (e) => {
    if (e.candidate) cnSignal(peerId, 'ice', e.candidate.toJSON());
  };

  /* Route an inbound track to the right tile.
     A peer now has TWO possible destinations: their own camera/mic stream, and a
     separate screen-share stream that becomes its own tile. We tell them apart by
     the MediaStream id the sender used — cnScreenStreamId stamps a recognisable
     prefix on the screen stream before it's ever added to a connection. */
  pc.ontrack = (e) => {
    const remote = e.streams && e.streams[0];
    peer.connecting = false;

    if (remote && cnIsScreenStream(remote)) {
      cnAddRemoteScreen(peer, remote);
      cnRenderStage();
      return;
    }

    // camera / mic: the peer's own tile
    let stream = peer.stream;
    if (!stream) { stream = new MediaStream(); peer.stream = stream; }
    if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
    // A track the sender removed should take its tile state with it, otherwise a
    // camera that was switched off leaves a frozen last frame behind.
    e.track.onended = () => { try { stream.removeTrack(e.track); } catch (err) {} cnRenderStage(); };
    cnRenderStage();
    cnWatchLevel(peerId, stream);
  };

  pc.onconnectionstatechange = () => {
    if (!CN.peers.has(peerId)) return;
    const st = pc.connectionState;
    peer.connecting = (st === 'connecting' || st === 'new');
    if (st === 'failed') {
      // No TURN by design, so a hard-NAT pair can genuinely fail. Say so plainly
      // instead of leaving a silent black tile.
      toast(`Couldn't reach ${peer.name} directly`, 'info');
    }
    cnRenderStage();
  };

  cnTuneAudio(pc);
  return pc;
}

/* ============================================================
   TELLING A SCREEN SHARE APART FROM A CAMERA
   `MediaStream.id` survives the trip to the far end (it's carried in the SDP's
   a=msid), so stamping the id at capture time is enough — no extra signalling
   round-trip, and it can't get out of sync with the tracks the way a separate
   "I am now sharing" message can.

   getDisplayMedia hands back a stream with a browser-assigned id, and that id is
   read-only, so we can't rename it. Instead we copy its tracks into a stream we
   build ourselves... which also has a read-only generated id. So the marker rides
   on the TRACK's contentHint plus a label check, with the stream id as the
   primary signal where the browser allows setting it via addTransceiver's
   streams — in practice we tag the tracks and check both. */
const CN_SCREEN_TAG = 'simplex-screen';

/* Mark every track of a display-capture stream so the far end can recognise it. */
function cnTagScreenStream(stream) {
  if (!stream) return stream;
  stream._cnScreen = true;
  for (const t of stream.getTracks()) {
    t._cnScreen = true;
    // contentHint is a standard, settable property that survives to the receiver
    // via the track's own settings on some browsers; harmless where it doesn't.
    try { t.contentHint = t.kind === 'video' ? 'detail' : 'music'; } catch (e) {}
  }
  return stream;
}

/* Does this inbound stream carry a screen share?
   Checked in order of reliability:
     1) our own tag, if this is a local stream
     2) the track label — Chrome/Edge/Firefox name display captures "screen",
        "window", "web-contents", etc.
     3) contentHint 'detail', which we set on the sending side
   Safari gives a generic label, so 3 is what carries it there. */
function cnIsScreenStream(stream) {
  if (!stream) return false;
  if (stream._cnScreen) return true;
  if (stream.id && stream.id.indexOf(CN_SCREEN_TAG) === 0) return true;
  for (const t of stream.getVideoTracks()) {
    if (t._cnScreen) return true;
    if (t.label && /screen|window|display|monitor|web-contents|entire|tab/i.test(t.label)) return true;
    if (t.contentHint === 'detail') return true;
  }
  return false;
}

/* Register (or update) a peer's inbound screen share as its own tile. */
function cnAddRemoteScreen(peer, stream) {
  const key = 'scr:' + peer.id;
  let s = CN.screens.get(key);
  if (!s) {
    s = { key, ownerId: peer.id, ownerName: peer.name, stream, previewEl: null, previewTimer: null };
    CN.screens.set(key, s);
    // A new share announces itself but does NOT auto-open — opening is the
    // viewer's call, which is the whole point of the preview state.
    toast(`${peer.name} started sharing their screen`, 'window');
  } else {
    // a re-share replaces the stream; drop any preview bound to the old one
    if (s.stream !== stream) { cnStopScreenPreview(s); s.stream = stream; }
  }
  // The sender ending the share is the signal to remove the tile.
  for (const t of stream.getTracks()) {
    t.onended = () => cnRemoveRemoteScreen(key);
  }
  stream.onremovetrack = () => {
    if (!stream.getVideoTracks().length) cnRemoveRemoteScreen(key);
  };
}

function cnRemoveRemoteScreen(key) {
  const s = CN.screens.get(key);
  if (!s) return;
  cnStopScreenPreview(s);
  CN.screens.delete(key);
  CN.openScreens.delete(key);
  if (CN.focus === key) CN.focus = null;
  cnRenderStage();
}

/* We are the offerer for this peer. */
async function cnCallPeer(peerId) {
  const pc = cnMakePc(peerId);
  if (!pc) return;
  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    offer.sdp = cnSdpBitrate(offer.sdp);
    await pc.setLocalDescription(offer);
    cnSignal(peerId, 'offer', { sdp: pc.localDescription.sdp, type: pc.localDescription.type });
  } catch (e) { console.warn('[connect] offer failed', e); }
}

/* Handle an inbound offer/answer/ICE. */
async function cnOnSignal(d) {
  const from = d.from;
  let peer = CN.peers.get(from);
  if (!peer) { peer = cnAddPeer({ id: from, name: d.fromName || 'Someone', peerId: d.fromPeerId }); cnRenderStage(); }

  if (d.type === 'offer') {
    const pc = cnMakePc(from);
    await pc.setRemoteDescription(new RTCSessionDescription(d.payload));
    await cnFlushIce(peer);
    const answer = await pc.createAnswer();
    answer.sdp = cnSdpBitrate(answer.sdp);
    await pc.setLocalDescription(answer);
    cnSignal(from, 'answer', { sdp: pc.localDescription.sdp, type: pc.localDescription.type });
  } else if (d.type === 'answer') {
    const pc = peer.pc;
    if (!pc) return;
    // Ignore a duplicate/late answer rather than throwing an InvalidStateError.
    if (pc.signalingState !== 'have-local-offer') return;
    await pc.setRemoteDescription(new RTCSessionDescription(d.payload));
    await cnFlushIce(peer);
  } else if (d.type === 'ice') {
    const pc = peer.pc;
    // ICE can beat the offer/answer; hold it until there's a remote description.
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) { peer.pendingIce.push(d.payload); return; }
    try { await pc.addIceCandidate(new RTCIceCandidate(d.payload)); } catch (e) {}
  }
}

async function cnFlushIce(peer) {
  if (!peer.pendingIce || !peer.pendingIce.length || !peer.pc) return;
  const queued = peer.pendingIce.splice(0);
  for (const c of queued) {
    try { await peer.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
  }
}

function cnSignal(to, type, payload) {
  if (!CN.room) return;
  cnApi('/api/connect/rooms/' + encodeURIComponent(CN.room.id) + '/signal', {
    method: 'POST', body: { to, type, payload },
  }).catch(() => {});
}

/* ---- bitrate control ----
   Two levers, because browsers honour them unevenly:
     1) SDP b=AS/b=TIAS + Opus maxaveragebitrate — understood by every browser and
        applied at negotiation time. This is what pins audio to 64 kbps.
     2) RTCRtpSender encoding params — a live cap we can adjust after the fact. */
function cnSdpBitrate(sdp) {
  if (!sdp) return sdp;
  const lines = sdp.split(/\r\n|\n/);
  const out = [];
  let section = null;   // 'audio' | 'video'
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('m=')) {
      section = line.startsWith('m=audio') ? 'audio' : line.startsWith('m=video') ? 'video' : null;
      out.push(line);
      continue;
    }
    // strip any existing bandwidth line so ours is authoritative
    if (/^b=(AS|TIAS):/.test(line)) continue;
    out.push(line);
    // b= must come directly after the c= line of its own m= section
    if (line.startsWith('c=') && section) {
      const kbps = section === 'audio' ? CN_AUDIO_BITRATE / 1000 : cnVideoBitrateFor(!!CN.media.screen) / 1000;
      out.push('b=AS:' + Math.round(kbps));
      out.push('b=TIAS:' + Math.round(kbps * 1000));
    }
  }
  let sdp2 = out.join('\r\n');
  // Opus: ask for stereo, full band, and exactly our target average bitrate.
  sdp2 = sdp2.replace(/(a=fmtp:(\d+) [^\r\n]*)/g, (m, full, pt) => {
    if (!new RegExp('a=rtpmap:' + pt + ' opus', 'i').test(sdp2)) return full;
    let f = full;
    if (!/stereo=/.test(f)) f += ';stereo=1;sprop-stereo=1';
    if (!/maxaveragebitrate=/.test(f)) f += ';maxaveragebitrate=' + CN_AUDIO_BITRATE;
    if (!/useinbandfec=/.test(f)) f += ';useinbandfec=1';   // survive packet loss
    return f;
  });
  return sdp2;
}

/* Cap the audio sender at 64 kbps and mark video as motion/detail appropriately. */
async function cnTuneAudio(pc) {
  // senders exist only after tracks are added, so run on the next tick
  setTimeout(async () => {
    for (const s of pc.getSenders()) {
      if (!s.track) continue;
      try {
        const p = s.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        if (s.track.kind === 'audio') {
          p.encodings[0].maxBitrate = CN_AUDIO_BITRATE;
          p.encodings[0].priority = 'high';   // voice must survive congestion
        } else {
          const screen = s.track.label && /screen|window|tab|display/i.test(s.track.label);
          p.encodings[0].maxBitrate = cnVideoBitrateFor(screen);
          p.degradationPreference = screen ? 'maintain-resolution' : 'balanced';
        }
        await s.setParameters(p);
      } catch (e) {}
    }
  }, 0);
}

/* ---- controls ------------------------------------------------------------ */
function cnToggleMic() {
  if (!CN.local) return;
  CN.media.mic = !CN.media.mic;
  for (const t of CN.local.getAudioTracks()) t.enabled = CN.media.mic;
  // When the noise chain is running it's the PROCESSED track that peers receive,
  // and it has its own enabled flag — muting the raw source alone would leave the
  // gate happily forwarding silence-shaped audio, but muting both is what
  // actually guarantees nothing goes out.
  if (CN.micChain && CN.micChain.outTrack) CN.micChain.outTrack.enabled = CN.media.mic;
  cnPublishMedia();
  cnRenderStage();
}

async function cnToggleCam() {
  if (!CN.inCall) return;
  if (CN.media.cam) {
    for (const t of CN.local.getVideoTracks()) { t.stop(); CN.local.removeTrack(t); cnDropTrack(t); }
    CN.media.cam = false;
  } else {
    const hint = cnPermHint(true);
    try {
      // relaxation ladder, so a quality this camera can't hit exactly still
      // turns the camera ON rather than failing the whole toggle
      const s = await cnGetCameraStream();
      const track = s.getVideoTracks()[0];
      CN.local.addTrack(track);
      cnAddTrackToPeers(track, CN.local);
      CN.media.cam = true;
    } catch (e) {
      // turning the camera on mid-call has its own prompt, so explain it the same way
      cnPermissionHelpModal(e, true);
      return;
    } finally { hint.remove(); }
  }
  cnPublishMedia();
  cnRenderStage();
}

async function cnToggleScreen() {
  if (!CN.inCall) return;
  if (CN.media.screen) return cnStopScreen();
  try {
    // Resolution/framerate follow the user's screen-share quality choice; system
    // audio is taken if the browser offers it.
    CN.screen = await navigator.mediaDevices.getDisplayMedia(cnScreenConstraints());
  } catch (e) {
    // The user cancelling the picker is a normal outcome, not an error to shout about.
    if (e && e.name === 'NotAllowedError') return;
    toast("Couldn't start screen sharing", 'info');
    return;
  }
  // Tag it BEFORE it reaches any peer connection, so the very first ontrack at
  // the far end already knows this is a screen and not a camera.
  cnTagScreenStream(CN.screen);
  const track = CN.screen.getVideoTracks()[0];
  if (!track) return;
  // "Stop sharing" in the browser's own bar ends the track behind our back.
  track.onended = () => cnStopScreen();
  cnAddTrackToPeers(track, CN.screen);
  for (const a of CN.screen.getAudioTracks()) cnAddTrackToPeers(a, CN.screen);
  CN.media.screen = true;
  // Your share opens focused on your own screen so you can see what you're
  // presenting; it's your screen, so there's no preview state to opt out of.
  CN.focus = 'scr:self';
  cnPublishMedia();
  cnRenderStage();
}

function cnStopScreen() {
  if (CN.screen) {
    for (const t of CN.screen.getTracks()) { t.stop(); cnDropTrack(t); }
    CN.screen = null;
  }
  CN.media.screen = false;
  if (CN.focus === 'scr:self') CN.focus = null;   // its tile is about to vanish
  cnPublishMedia();
  cnRenderStage();
}

function cnToggleHand() {
  CN.media.hand = !CN.media.hand;
  cnPublishMedia();
  cnRenderStage();
}

/* Add a newly-started track to every existing peer connection and renegotiate.
   We are the offerer for these renegotiations, which is safe because adding a
   track is always initiated locally. */
function cnAddTrackToPeers(track, stream) {
  for (const [id, peer] of CN.peers) {
    if (!peer.pc) continue;
    try { peer.pc.addTrack(track, stream); } catch (e) { continue; }
    cnRenegotiate(id);
  }
}
function cnDropTrack(track) {
  for (const [id, peer] of CN.peers) {
    if (!peer.pc) continue;
    const s = peer.pc.getSenders().find(x => x.track === track);
    if (!s) continue;
    try { peer.pc.removeTrack(s); } catch (e) { continue; }
    cnRenegotiate(id);
  }
}
async function cnRenegotiate(peerId) {
  const peer = CN.peers.get(peerId);
  if (!peer || !peer.pc) return;
  // Only renegotiate from a settled connection; otherwise the in-flight
  // offer/answer already carries the change.
  if (peer.pc.signalingState !== 'stable') return;
  try {
    const offer = await peer.pc.createOffer();
    offer.sdp = cnSdpBitrate(offer.sdp);
    await peer.pc.setLocalDescription(offer);
    cnSignal(peerId, 'offer', { sdp: peer.pc.localDescription.sdp, type: peer.pc.localDescription.type });
    cnTuneAudio(peer.pc);
  } catch (e) {}
}

/* Tell the room which tracks we're sending (drives the muted/presenting badges). */
function cnPublishMedia() {
  if (!CN.room || !CN.inCall) return;
  cnApi('/api/connect/rooms/' + encodeURIComponent(CN.room.id) + '/media', {
    method: 'POST', body: CN.media,
  }).catch(() => {});
}

async function cnLeaveCall(opts = {}) {
  const wasIn = CN.inCall;
  CN.inCall = false;
  if (wasIn && CN.room && !opts.silent) {
    cnApi('/api/connect/rooms/' + encodeURIComponent(CN.room.id) + '/hangup', { method: 'POST' }).catch(() => {});
  }
  for (const id of [...CN.peers.keys()]) cnRemovePeer(id);
  // any screen tiles that outlived their peer (and their 1fps preview timers)
  for (const key of [...CN.screens.keys()]) cnRemoveRemoteScreen(key);
  CN.openScreens.clear();
  if (CN.local) { for (const t of CN.local.getTracks()) t.stop(); CN.local = null; }
  if (CN.screen) { for (const t of CN.screen.getTracks()) t.stop(); CN.screen = null; }
  cnStopMicChain();
  cnStopMicTest();
  CN.media = { mic: false, cam: false, screen: false, hand: false };
  CN.pinned = null;
  CN.focus = null;
  cnStopLevelMeter();
  cnCloseSignaling();
  if (wasIn && !opts.silent) {
    // back to polling for chat now that the live stream is gone
    cnStartMessagePoll();
    cnRenderStage();
  }
}

/* ---- device picker ------------------------------------------------------- */
async function cnDevicePicker() {
  if (!cnCanCapture()) { cnInsecureOriginModal(); return; }
  let list = [];
  try { list = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
  CN.devices.mics = list.filter(d => d.kind === 'audioinput');
  CN.devices.cams = list.filter(d => d.kind === 'videoinput');
  // Labels are EMPTY until the site has been granted access at least once — a
  // list of "Device / Device / Device" is useless, so say why and offer to fix it.
  const unlabeled = [...CN.devices.mics, ...CN.devices.cams].some(d => !d.label);

  const opt = (d, sel, i) => `<option value="${esc(d.deviceId)}" ${sel === d.deviceId ? 'selected' : ''}>${esc(d.label || `Device ${i + 1}`)}</option>`;
  const html = `<div class="cn-devs">
    <label class="cn-dev-row"><span>Microphone</span>
      <select id="cnMicSel">${CN.devices.mics.map((d, i) => opt(d, CN.devices.micId, i)).join('') || '<option value="">No microphone found</option>'}</select>
    </label>
    <label class="cn-dev-row"><span>Camera</span>
      <select id="cnCamSel">${CN.devices.cams.map((d, i) => opt(d, CN.devices.camId, i)).join('') || '<option value="">No camera found</option>'}</select>
    </label>
    ${unlabeled ? `<p class="cn-dev-note">Your browser hides device names until you've allowed access once. Choosing a camera below will ask for permission.</p>` : ''}

    <div class="cn-qual-head">Quality</div>
    <label class="cn-dev-row"><span>Camera</span>
      <select id="cnCamQual">${cnQualityOptions(CN_CAM_QUALITY, (PREFS && PREFS.connectCamQuality) || 'auto')}</select>
      <em class="cn-qual-note" id="cnCamQualNote">${esc(cnCamQuality().note)}</em>
    </label>
    <label class="cn-dev-row"><span>Screen share</span>
      <select id="cnScrQual">${cnQualityOptions(CN_SCREEN_QUALITY, (PREFS && PREFS.connectScreenQuality) || 'auto')}</select>
      <em class="cn-qual-note" id="cnScrQualNote">${esc(cnScreenQuality().note)}</em>
    </label>

    <p class="cn-dev-note">Changes apply straight away — the call keeps running. Voice is always 64 kbps stereo Opus; these settings only affect video.</p>
  </div>`;
  // Read the selects INSIDE onAccept — the modal is removed before the promise
  // resolves, so reading them afterwards would always come back empty.
  const picked = await cnModal({
    title: 'Devices & quality', bodyHTML: html, okText: 'Use these',
    onAccept: (root) => ({
      mic: (root.querySelector('#cnMicSel') || {}).value || null,
      cam: (root.querySelector('#cnCamSel') || {}).value || null,
      camQ: (root.querySelector('#cnCamQual') || {}).value || 'auto',
      scrQ: (root.querySelector('#cnScrQual') || {}).value || 'auto',
    }),
    onMount: (root) => {
      // live-update the little explainer under each picker
      const wire = (sel, noteId, table) => {
        const s = root.querySelector(sel), n = root.querySelector(noteId);
        if (s && n) s.onchange = () => { n.textContent = (table[s.value] || {}).note || ''; };
      };
      wire('#cnCamQual', '#cnCamQualNote', CN_CAM_QUALITY);
      wire('#cnScrQual', '#cnScrQualNote', CN_SCREEN_QUALITY);
    },
  });
  if (!picked) return;

  // Persist the quality choices (they apply to future calls too, not just this one)
  const camQChanged = picked.camQ !== ((PREFS && PREFS.connectCamQuality) || 'auto');
  const scrQChanged = picked.scrQ !== ((PREFS && PREFS.connectScreenQuality) || 'auto');
  if (camQChanged || scrQChanged) {
    setPrefs({ connectCamQuality: picked.camQ, connectScreenQuality: picked.scrQ });
  }

  const newMic = picked.mic || null;
  const newCam = picked.cam || null;
  const micChanged = !!newMic && newMic !== CN.devices.micId;
  const camChanged = !!newCam && newCam !== CN.devices.camId;
  const prevMic = CN.devices.micId, prevCam = CN.devices.camId;
  if (newMic) CN.devices.micId = newMic;
  if (newCam) CN.devices.camId = newCam;
  if (!CN.inCall) return;   // not live yet: the choice is used on join

  // Swap the live tracks in place so the call doesn't drop.
  if (micChanged) {
    if (!await cnSwapTrack('audio')) CN.devices.micId = prevMic;   // revert on failure
  }
  if (camChanged) {
    if (CN.media.cam) {
      // camera already running: hot-swap it
      if (await cnSwapTrack('video')) toast('Camera switched', 'check');
      else CN.devices.camId = prevCam;
    } else {
      // Camera is OFF. Picking a different camera clearly means "use that one",
      // so turn it on rather than silently doing nothing until they toggle it.
      await cnToggleCam();
    }
  } else if (camQChanged && CN.media.cam) {
    // Same camera, new quality: re-open the track at the new resolution. The
    // sender cap alone can't raise resolution, only lower the bitrate.
    if (await cnSwapTrack('video')) toast('Camera quality: ' + cnCamQuality().label, 'check');
  }

  // Screen-share quality: re-acquiring the display would pop the picker again,
  // which is obnoxious mid-presentation. Apply the new BITRATE ceiling live and
  // let the resolution change apply the next time they start sharing.
  if (scrQChanged) {
    cnApplySenderBitrates();
    if (CN.media.screen) toast('Screen quality applies when you restart sharing', 'info');
  }
  cnRenderStage();
}

/* ============================================================
   NOISE CANCELLATION SETTINGS
   Live: every control applies as you move it, and the meter shows the gate
   opening and closing in real time. Turning this into an OK/Cancel form would
   make it useless — you can't tune a gate you can't hear.
   ============================================================ */
async function cnNoiseSettings() {
  const cfg = cnNoise();
  const html = `<div class="cn-noise">
    <label class="cn-dev-row check">
      <input type="checkbox" id="cnNsOn" ${cfg.enabled ? 'checked' : ''} />
      <span><b>Noise cancellation</b><em>Removes background noise from your microphone</em></span>
    </label>

    <div class="cn-noise-body ${cfg.enabled ? '' : 'disabled'}" id="cnNsBody">
      <label class="cn-dev-row check">
        <input type="checkbox" id="cnNsBrowser" ${cfg.browserNS ? 'checked' : ''} />
        <span>Browser noise suppression<em>Your browser's own filter. Leave this on unless it makes your voice sound thin or underwater.</em></span>
      </label>
      <label class="cn-dev-row check">
        <input type="checkbox" id="cnNsGate" ${cfg.gate ? 'checked' : ''} />
        <span>Silence between sentences<em>Mutes your mic when you're not speaking, so typing and fans don't carry.</em></span>
      </label>

      <div class="cn-noise-adv ${cfg.gate ? '' : 'disabled'}" id="cnNsAdv">
        <div class="cn-slide-row">
          <label for="cnNsThresh">Sensitivity <b id="cnNsThreshV">${cfg.threshold} dB</b></label>
          <input type="range" id="cnNsThresh" min="-75" max="-20" step="1" value="${cfg.threshold}" />
          <em>Lower catches quieter speech; higher cuts more noise. If the start of your words disappears, lower this.</em>
        </div>
        <div class="cn-slide-row">
          <label for="cnNsRelease">Hold after speaking <b id="cnNsReleaseV">${cfg.release} ms</b></label>
          <input type="range" id="cnNsRelease" min="60" max="800" step="10" value="${cfg.release}" />
          <em>How long the mic stays open after you stop. Raise it if your speech sounds chopped up.</em>
        </div>
        <div class="cn-slide-row">
          <label for="cnNsHp">Remove low rumble <b id="cnNsHpV">${cfg.highPass} Hz</b></label>
          <input type="range" id="cnNsHp" min="0" max="200" step="5" value="${cfg.highPass}" />
          <em>Cuts desk knocks, footsteps and handling noise below this pitch.</em>
        </div>
      </div>

      <div class="cn-mictest">
        <div class="cn-mictest-head">
          <b>Test it</b>
          <button type="button" class="btn ghost sm" id="cnNsTest">${svg('play', 13)} Hear myself</button>
        </div>
        <p class="cn-mictest-warn">${svg('info', 12)} <span><b>Use headphones.</b> On speakers this will feed back and screech.</span></p>
        <div class="cn-meter"><div class="cn-meter-fill" id="cnNsMeter"></div><div class="cn-meter-thresh" id="cnNsMark"></div></div>
        <div class="cn-meter-legend"><span id="cnNsState">Not testing</span><span>the marker is your sensitivity setting</span></div>
      </div>

      <button type="button" class="btn ghost sm cn-noise-reset" id="cnNsReset">Reset to defaults</button>
    </div>
  </div>`;

  await cnModal({
    title: 'Noise cancellation', bodyHTML: html, okText: 'Done', cancelText: null,
    // A full-screen surface: there are three sliders, three toggles, a meter and
    // a live test in here, and squeezing that into a small centred box made it
    // scroll awkwardly. `wide` lets the panel use the window and lay its controls
    // out in columns when there's room (see .cn-modal.wide in the CSS).
    wide: true,
    onMount: (root) => {
      const $ = (id) => root.querySelector(id);
      const body = $('#cnNsBody'), adv = $('#cnNsAdv');

      // Write a change through to PREFS, the live call chain, and the open test.
      const save = (patch, { rebuild = false } = {}) => {
        const next = { ...cnNoise(), ...patch };
        setPrefs({ connectNoise: next });
        // the running test picks up threshold/release/highPass immediately
        if (CN.micTest) {
          CN.micTest.cfg = next;
          try { CN.micTest.hp.frequency.value = next.highPass; } catch (e) {}
        }
        if (CN.micChain) {
          CN.micChain.cfg = next;
          try { CN.micChain.hp.frequency.value = next.highPass; } catch (e) {}
        }
        // Only a change of SHAPE (on/off, gate on/off) needs the graph rebuilt and
        // the sender re-pointed; a slider move is just a value.
        if (rebuild) cnApplyMicProcessing();
        const btn = document.getElementById('cnNoise');
        if (btn) btn.classList.toggle('on', next.enabled);
      };

      $('#cnNsOn').onchange = (e) => {
        body.classList.toggle('disabled', !e.target.checked);
        save({ enabled: e.target.checked }, { rebuild: true });
        // browserNS lives in the CONSTRAINTS, so it only takes effect on the next
        // capture — say so rather than letting them wonder.
        toast(e.target.checked ? 'Noise cancellation on' : 'Noise cancellation off', 'check');
      };
      $('#cnNsBrowser').onchange = (e) => {
        save({ browserNS: e.target.checked });
        toast('Applies the next time your microphone starts', 'info');
      };
      $('#cnNsGate').onchange = (e) => {
        adv.classList.toggle('disabled', !e.target.checked);
        save({ gate: e.target.checked }, { rebuild: true });
      };

      const slider = (id, valId, key, fmt) => {
        const s = $(id), v = $(valId);
        if (!s) return;
        s.oninput = () => { v.textContent = fmt(s.value); save({ [key]: Number(s.value) }); if (key === 'threshold') mark(); };
      };
      slider('#cnNsThresh', '#cnNsThreshV', 'threshold', v => `${v} dB`);
      slider('#cnNsRelease', '#cnNsReleaseV', 'release', v => `${v} ms`);
      slider('#cnNsHp', '#cnNsHpV', 'highPass', v => `${v} Hz`);

      // ---- the meter ----
      // dBFS is logarithmic and mostly empty at the top; -70..0 maps the useful
      // range of speech across the full width.
      const pct = (db) => Math.max(0, Math.min(100, ((db + 70) / 70) * 100));
      const markEl = $('#cnNsMark');
      const mark = () => { markEl.style.left = pct(Number($('#cnNsThresh').value)) + '%'; };
      mark();

      const meter = $('#cnNsMeter'), state = $('#cnNsState'), testBtn = $('#cnNsTest');
      let testing = false;

      const stopTest = () => {
        testing = false;
        cnStopMicTest();
        meter.style.width = '0%';
        meter.classList.remove('open');
        state.textContent = 'Not testing';
        testBtn.innerHTML = `${svg('play', 13)} Hear myself`;
      };

      testBtn.onclick = async () => {
        if (testing) return stopTest();
        const t = await cnStartMicTest();
        if (!t) { toast("Couldn't start the test — join the call first", 'info'); return; }
        testing = true;
        testBtn.innerHTML = `${svg('stop', 13)} Stop test`;
        t.onLevel = (db, open) => {
          meter.style.width = pct(db) + '%';
          meter.classList.toggle('open', open);
          state.textContent = open ? 'Sending — the room would hear this' : 'Silent — gated out';
        };
      };

      $('#cnNsReset').onclick = () => {
        setPrefs({ connectNoise: { ...CN_NOISE_DEFAULTS } });
        cnApplyMicProcessing();
        stopTest();
        cnCloseModalAndReopenNoise();
      };

      // The test must not outlive the modal — a monitor left running after the
      // window closes is an invisible feedback loop.
      root._cnCleanup = stopTest;
    },
    onClose: (root) => { if (root && root._cnCleanup) root._cnCleanup(); cnStopMicTest(); },
  });
  cnStopMicTest();
}

/* Reset re-opens the panel so every control shows its restored value. */
function cnCloseModalAndReopenNoise() {
  const bg = document.querySelector('.modal-bg');
  if (bg) bg.remove();
  cnStopMicTest();
  setTimeout(cnNoiseSettings, 0);
}

/* Build the <option> list for a quality table. */
function cnQualityOptions(table, current) {
  return Object.entries(table)
    .map(([k, v]) => `<option value="${esc(k)}" ${k === current ? 'selected' : ''}>${esc(v.label)}</option>`)
    .join('');
}

/* Re-apply the sender bitrate ceilings on every peer connection (used when the
   quality preference changes without re-acquiring the track). */
async function cnApplySenderBitrates() {
  for (const peer of CN.peers.values()) {
    if (!peer.pc) continue;
    for (const s of peer.pc.getSenders()) {
      if (!s.track || s.track.kind !== 'video') continue;
      try {
        const p = s.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        const isScreen = s.track.label && /screen|window|tab|display/i.test(s.track.label);
        p.encodings[0].maxBitrate = cnVideoBitrateFor(isScreen);
        await s.setParameters(p);
      } catch (e) {}
    }
  }
}

/* Replace one live track everywhere (replaceTrack needs no renegotiation). */
async function cnSwapTrack(kind, opts = {}) {
  if (!cnCanCapture()) { cnInsecureOriginModal(); return false; }
  // Selecting a device the browser hasn't granted yet triggers a FRESH permission
  // prompt (each camera is its own grant), so show the same hint as on join —
  // otherwise the switch looks like it silently did nothing.
  const hint = cnPermHint(kind === 'video');
  let fresh = null;
  try {
    // Video goes through the relaxation ladder (see cnGetCameraStream) so a
    // quality the camera can't hit exactly still produces a working track rather
    // than turning the camera off.
    const s = kind === 'audio'
      ? await navigator.mediaDevices.getUserMedia({ audio: cnAudioConstraints() })
      : await cnGetCameraStream();
    fresh = kind === 'audio' ? s.getAudioTracks()[0] : s.getVideoTracks()[0];
    if (!fresh) { s.getTracks().forEach(t => t.stop()); return false; }
  } catch (e) {
    hint.remove();
    // A device can vanish between listing and selecting (unplugged). For audio
    // there's no ladder, so fall back to the system default once — guarded by a
    // flag so a permanently-failing device can't recurse forever.
    if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') && !opts._retried) {
      if (kind === 'audio') CN.devices.micId = null; else CN.devices.camId = null;
      toast('That device is unavailable — using the default instead', 'info');
      return cnSwapTrack(kind, { _retried: true });
    }
    cnPermissionHelpModal(e, kind === 'video');
    return false;
  }
  hint.remove();

  // Swap into every peer connection first (replaceTrack needs no renegotiation),
  // then update the local stream.
  for (const peer of CN.peers.values()) {
    if (!peer.pc) continue;
    const sender = peer.pc.getSenders().find(x => x.track && x.track.kind === kind);
    if (sender) { try { await sender.replaceTrack(fresh); } catch (e) {} }
  }
  const old = kind === 'audio' ? CN.local.getAudioTracks()[0] : CN.local.getVideoTracks()[0];
  if (old) { old.stop(); CN.local.removeTrack(old); }
  CN.local.addTrack(fresh);
  if (kind === 'audio') {
    fresh.enabled = CN.media.mic;
    // The noise chain was reading from the OLD mic, which we just stopped. Rebuild
    // it around the new one — otherwise switching microphones silently drops the
    // user back to unprocessed audio (or to a dead track).
    await cnApplyMicProcessing();
  }

  // Force the local preview to re-bind. cnAttachStreams() only assigns srcObject
  // when the OBJECT changed, and CN.local is the same MediaStream instance — so
  // without this the tile keeps painting the old camera's last frame.
  cnRefreshSelfPreview();
  return true;
}

/* Re-point the self tile at the local stream, even when the MediaStream object is
   unchanged (swapping a track mutates it in place). */
function cnRefreshSelfPreview() {
  const el = document.getElementById('cnSelfVideo');
  if (!el) return;
  const want = CN.media.screen && CN.screen ? CN.screen : CN.local;
  el.srcObject = null;
  el.srcObject = want || null;
  if (want) { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
  cnTrackTileRatio(el);
}

/* ---- speaking indicator --------------------------------------------------
   A cheap Web Audio meter per stream: it only reads levels to add a ring around
   whoever is talking. Nothing is recorded or sent anywhere. */
function cnStartLevelMeter() {
  cnStopLevelMeter();
  try { CN.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  if (CN.local) cnWatchLevel('self', CN.local);
  CN.levelTimer = setInterval(cnTickLevels, 200);
}
function cnWatchLevel(id, stream) {
  if (!CN.audioCtx || !stream || !stream.getAudioTracks().length) return;
  if (CN.analysers.has(id)) return;
  try {
    const src = CN.audioCtx.createMediaStreamSource(stream);
    const an = CN.audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    CN.analysers.set(id, { an, data: new Uint8Array(an.frequencyBinCount) });
  } catch (e) {}
}
function cnTickLevels() {
  for (const [id, a] of CN.analysers) {
    a.an.getByteFrequencyData(a.data);
    let sum = 0;
    for (let i = 0; i < a.data.length; i++) sum += a.data[i];
    const level = sum / a.data.length;
    const tile = document.querySelector(`.cn-tile[data-peer="${CSS.escape(id)}"]`);
    if (tile) tile.classList.toggle('speaking', level > 12);
  }
}
function cnStopLevelMeter() {
  if (CN.levelTimer) { clearInterval(CN.levelTimer); CN.levelTimer = null; }
  CN.analysers.clear();
  if (CN.audioCtx) { try { CN.audioCtx.close(); } catch (e) {} CN.audioCtx = null; }
}

/* ============================================================
   CHAT
   ============================================================ */
function cnMessagesHTML() {
  if (!CN.messages.length) {
    return `<div class="cn-msgs-empty">${svg('note', 22)}<span>No messages yet. Say hello.</span></div>`;
  }
  let out = '', lastAuthor = null, lastAt = 0;
  for (const m of CN.messages) {
    // group consecutive messages from one person within 5 minutes
    const grouped = m.authorId === lastAuthor && (m.created - lastAt) < 5 * 60 * 1000;
    out += cnMsgHTML(m, grouped);
    lastAuthor = m.authorId; lastAt = m.created;
  }
  return out;
}

function cnMsgHTML(m, grouped) {
  const reply = m.replyTo ? CN.messages.find(x => x.id === m.replyTo) : null;
  const rx = (m.reactions || []).map(r =>
    `<button class="cn-rx ${r.mine ? 'mine' : ''}" data-rx="${esc(m.id)}" data-emoji="${esc(r.emoji)}" title="${esc(r.names.join(', '))}">
       <span>${esc(r.emoji)}</span><b>${r.count}</b>
     </button>`).join('');
  return `<div class="cn-msg ${m.mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}" data-msg="${esc(m.id)}">
    ${grouped ? '' : `<div class="cn-msg-head">
      <span class="cn-msg-who">${esc(m.authorName)}</span>
      <span class="cn-msg-at">${cnTime(m.created)}</span>
    </div>`}
    ${reply ? `<div class="cn-msg-reply">${svg('back', 10)} <b>${esc(reply.authorName)}</b> ${esc(cnTrim(reply.text, 90))}</div>` : ''}
    ${m.text ? `<div class="cn-msg-body">${cnLinkify(m.text)}${m.edited ? '<span class="cn-edited">(edited)</span>' : ''}</div>` : ''}
    ${(m.files && m.files.length) ? `<div class="cn-msg-files">${m.files.map(cnFileHTML).join('')}</div>` : ''}
    <div class="cn-msg-tools">
      <button class="cn-tool" data-react="${esc(m.id)}" title="React">😊</button>
      <button class="cn-tool" data-reply="${esc(m.id)}" title="Reply">${svg('back', 12)}</button>
      ${m.mine ? `<button class="cn-tool" data-edit="${esc(m.id)}" title="Edit">${svg('rename', 12)}</button>` : ''}
      ${(m.mine || (CN.room && CN.room.canManage)) ? `<button class="cn-tool danger" data-del="${esc(m.id)}" title="Delete">${svg('trash', 12)}</button>` : ''}
    </div>
    ${rx ? `<div class="cn-rxs">${rx}</div>` : ''}
  </div>`;
}

function cnTrim(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }
function cnTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function cnInitials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}
/* Escape first, THEN linkify — so a message can never inject markup. */
function cnLinkify(text) {
  const safe = esc(text);
  return safe.replace(/https?:\/\/[^\s<]+/g, (url) =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

function cnWireChat() {
  const form = document.getElementById('cnCompose');
  const input = document.getElementById('cnInput');
  if (form) form.onsubmit = (e) => { e.preventDefault(); cnSendMessage(); };
  if (input) {
    // Enter sends, Shift+Enter makes a new line
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); cnSendMessage(); }
    };
    input.oninput = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    };
  }
  const attach = document.getElementById('cnAttach');
  if (attach) attach.onclick = cnAttachMenu;
  const picker = document.getElementById('cnFilePick');
  if (picker) picker.onchange = async () => {
    const files = [...(picker.files || [])];
    picker.value = '';                 // let the same file be picked again later
    for (const f of files) await cnUploadFile(f);
  };
  cnWireMsgTools();
  cnScrollChat();
}

/* ============================================================
   CHAT ATTACHMENTS — from the device, or out of the vault
   ============================================================ */

/* Ask where the file is coming from. The device path carries a warning, because
   those bytes exist ONLY on this server and go when the room does. */
async function cnAttachMenu() {
  const html = `<div class="cn-attach-menu">
    <button class="cn-attach-opt" data-pick="device">
      ${svg('upload', 20)}
      <div><b>From this device</b><span>Pick a file from your phone or computer</span></div>
    </button>
    <button class="cn-attach-opt" data-pick="vault">
      ${svg('database', 20)}
      <div><b>From my Database</b><span>Share something already in your vault</span></div>
    </button>
    <p class="cn-attach-warn">${svg('info', 13)}
      <span><b>Files shared here are deleted with the room.</b> A file you upload from your device
      lives only in this room — when the room is deleted it's gone from the server for good.
      Sharing from your Database copies it, so your original always stays safe in your vault.</span>
    </p>
  </div>`;
  // cnChoiceModal resolves with whatever the clicked option carried, so there's
  // no state to stash outside the modal.
  const pick = await cnChoiceModal({ title: 'Share a file', bodyHTML: html });
  if (pick === 'device') { const p = document.getElementById('cnFilePick'); if (p) p.click(); }
  else if (pick === 'vault') await cnVaultPicker();
}

/* A modal whose OPTIONS resolve the promise: any [data-pick] element inside
   `bodyHTML` closes it and resolves with that element's data-pick value.
   Cancel / backdrop resolve null. Used for pick-one-of-N choices where the plain
   OK/Cancel shape of cnModal doesn't fit. */
function cnChoiceModal({ title, bodyHTML, cancelText = 'Cancel', onMount = null }) {
  return new Promise(resolve => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal cn-modal">
      <h3>${esc(title)}</h3>
      <div class="cn-modal-body">${bodyHTML}</div>
      <div class="acts"><div class="spacer"></div><button class="btn ghost" data-cancel>${esc(cancelText)}</button></div>
    </div>`;
    document.body.appendChild(bg);
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; bg.remove(); resolve(v); };
    bg.querySelector('[data-cancel]').onclick = () => done(null);
    bg.onclick = e => { if (e.target === bg) done(null); };
    bg.querySelectorAll('[data-pick]').forEach(b => {
      b.onclick = () => done(b.getAttribute('data-pick'));
    });
    if (onMount) onMount(bg.querySelector('.modal'), done);
  });
}

/* Upload one file straight from the device. */
async function cnUploadFile(file) {
  if (!CN.room || !file) return;
  const max = 256 * 1024 * 1024;
  if (file.size > max) { toast(`"${file.name}" is over the 256MB chat limit`, 'info'); return; }
  const id = 'up' + Math.random().toString(36).slice(2, 8);
  cnShowUploading(id, file.name);
  try {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const res = await fetch(`/api/connect/rooms/${encodeURIComponent(CN.room.id)}/files`, { method: 'POST', body: fd });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || 'upload failed');
    cnUpsertMessage(data.message);
  } catch (e) {
    toast(e.message || "Couldn't share that file", 'info');
  } finally { cnClearUploading(id); }
}

/* A placeholder row while an upload is in flight, so a big file doesn't look
   like nothing happened. */
function cnShowUploading(id, name) {
  const box = document.getElementById('cnMsgs');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'cn-uploading';
  el.id = 'cnUp_' + id;
  el.innerHTML = `<span class="cn-up-spin"></span><span>Sending ${esc(name)}…</span>`;
  box.appendChild(el);
  cnScrollChat();
}
function cnClearUploading(id) {
  const el = document.getElementById('cnUp_' + id);
  if (el) el.remove();
}

/* Pick a file out of the caller's own vault. Reuses the already-loaded file list
   when the Database app has been opened; otherwise fetches it. */
async function cnVaultPicker() {
  let files = [];
  try {
    if (typeof DB !== 'undefined' && DB && Array.isArray(DB.files) && DB.files.length) files = DB.files;
    else files = await (await fetch('/api/files')).json();
  } catch (e) { toast("Couldn't read your vault", 'info'); return; }
  const pickable = files
    .filter(f => !f.folder && !f.trashed && f.hasBlob !== false)
    .sort((a, b) => (b.date || 0) - (a.date || 0))
    .slice(0, 400);
  if (!pickable.length) { toast('Nothing in your vault to share yet', 'info'); return; }

  const rows = pickable.map(f => `<button class="cn-vault-row" data-pick="${esc(f.id)}">
      ${svg(cnIconForType(f.type), 15)}
      <span class="cn-vault-name">${esc(f.name)}</span>
      <span class="cn-vault-size">${esc(cnBytes(f.size || 0))}</span>
    </button>`).join('');
  const html = `<div class="cn-vault-pick">
    <input id="cnVaultSearch" placeholder="Search your vault…" />
    <div class="cn-vault-list" id="cnVaultList">${rows}</div>
    <p class="cn-dev-note">Sharing copies the file into this room — your original stays in your vault. The copy is deleted with the room.</p>
  </div>`;
  // rows carry data-pick (the file id), so the modal resolves with the choice
  const chosen = await cnChoiceModal({
    title: 'Share from your Database', bodyHTML: html,
    onMount: (root) => {
      const search = root.querySelector('#cnVaultSearch');
      const list = root.querySelector('#cnVaultList');
      if (search) search.oninput = () => {
        const q = search.value.toLowerCase();
        list.querySelectorAll('.cn-vault-row').forEach(r => {
          const n = r.querySelector('.cn-vault-name').textContent.toLowerCase();
          r.style.display = n.includes(q) ? '' : 'none';
        });
      };
      setTimeout(() => { if (search) search.focus(); }, 0);
    },
  });
  if (chosen) await cnShareVaultFile(chosen);
}

async function cnShareVaultFile(fileId) {
  if (!CN.room) return;
  const id = 'vf' + Math.random().toString(36).slice(2, 8);
  cnShowUploading(id, 'file from your vault');
  try {
    const d = await cnApi(`/api/connect/rooms/${encodeURIComponent(CN.room.id)}/files/vault`, {
      method: 'POST', body: { fileId },
    });
    cnUpsertMessage(d.message);
  } catch (e) {
    toast(e.message || "Couldn't share that file", 'info');
  } finally { cnClearUploading(id); }
}

function cnIconForType(t) {
  return ({ image: 'image', video: 'video', audio: 'audio', document: 'document', model3d: 'cube', uasset: 'uasset' })[t] || 'files';
}
function cnBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

/* One attachment inside a chat message. Images and video preview inline; anything
   else gets a download row. */
function cnFileHTML(f) {
  const temp = f.temporary
    ? `<span class="cn-file-temp" title="Uploaded from a device — deleted when this room is deleted">temporary</span>` : '';
  const cap = `<span class="cn-file-cap">${esc(f.name)} · ${esc(cnBytes(f.size))} ${temp}</span>`;

  // Images open the lightbox rather than a new tab, so the download / save-to-
  // photos actions are right there instead of behind the browser's own chrome.
  if (f.kind === 'image') {
    return `<a class="cn-file-img" href="${esc(f.url)}" data-preview="${esc(f.id)}">
      <img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy" />
      ${cap}
    </a>`;
  }
  if (f.kind === 'video') {
    return `<div class="cn-file-vid">
      <video src="${esc(f.url)}" controls preload="metadata"></video>
      ${cap}
    </div>`;
  }
  if (f.kind === 'audio') {
    return `<div class="cn-file-aud">
      <audio src="${esc(f.url)}" controls preload="metadata"></audio>
      ${cap}
    </div>`;
  }
  // TEXT-ish files small enough to be worth showing get an inline excerpt with a
  // "click to read" affordance. Markdown is the common case (notes, snippets),
  // but any small text file benefits — a filename alone tells you nothing about
  // whether it's the thing you wanted.
  if (cnIsTextPreviewable(f)) {
    return `<div class="cn-file-text" data-textfile="${esc(f.id)}">
      <div class="cn-file-text-head">
        ${svg('document', 14)}
        <b>${esc(f.name)}</b>
        <span>${esc(cnBytes(f.size))} ${temp}</span>
      </div>
      <pre class="cn-file-text-body" data-textbody="${esc(f.id)}">Loading…</pre>
      <button class="cn-file-text-open" data-preview="${esc(f.id)}">Open</button>
    </div>`;
  }
  return `<a class="cn-file-row" href="${esc(f.url)}?download=1" download="${esc(f.name)}">
    ${svg(cnIconForType(f.kind), 16)}
    <span class="cn-file-meta"><b>${esc(f.name)}</b><span>${esc(cnBytes(f.size))} ${temp}</span></span>
    ${svg('download', 15)}
  </a>`;
}

/* Which attachments get an inline text excerpt.
   The size cap matters: this fetches the file to show it, so it has to stay in
   "nano/small markdown" territory rather than pulling a 40MB log into the chat. */
const CN_TEXT_PREVIEW_MAX = 256 * 1024;
const CN_TEXT_EXT = /\.(md|markdown|txt|text|log|json|ya?ml|toml|ini|cfg|conf|csv|tsv|js|ts|jsx|tsx|py|rb|go|rs|java|c|h|cpp|hpp|cs|sh|bash|zsh|sql|html?|css|scss|xml|svg)$/i;

function cnIsTextPreviewable(f) {
  if (!f || !f.name) return false;
  if (f.size > CN_TEXT_PREVIEW_MAX) return false;
  if (f.kind === 'image' || f.kind === 'video' || f.kind === 'audio') return false;
  return CN_TEXT_EXT.test(f.name);
}

/* Fill in the inline excerpts after a chat render. Kept separate from the HTML so
   a re-render doesn't re-fetch what we already have — the cache is keyed by file
   id and lives as long as the room does. */
const CN_TEXT_CACHE = new Map();

async function cnFillTextPreviews() {
  const nodes = document.querySelectorAll('[data-textbody]');
  for (const el of nodes) {
    const id = el.getAttribute('data-textbody');
    if (el._cnFilled) continue;
    el._cnFilled = true;
    if (CN_TEXT_CACHE.has(id)) { cnPaintTextPreview(el, CN_TEXT_CACHE.get(id)); continue; }
    const f = cnFindFile(id);
    if (!f) { el.textContent = ''; continue; }
    try {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error('fetch failed');
      const text = (await res.text()).slice(0, CN_TEXT_PREVIEW_MAX);
      CN_TEXT_CACHE.set(id, text);
      cnPaintTextPreview(el, text);
    } catch (e) {
      el.textContent = "Couldn't load a preview of this file.";
      el.classList.add('cn-text-err');
    }
  }
}

/* The inline excerpt is deliberately the RAW first few lines, not rendered
   markdown — at four lines tall, rendered headings and bullets read worse than
   the source. The full preview (cnOpenFilePreview) does render it. */
function cnPaintTextPreview(el, text) {
  const lines = text.split('\n').slice(0, 6);
  el.textContent = lines.join('\n') + (text.split('\n').length > 6 ? '\n…' : '');
}

/* Find an attachment by id across every loaded message. */
function cnFindFile(id) {
  for (const m of CN.messages) {
    if (!m.files) continue;
    const f = m.files.find(x => x.id === id);
    if (f) return f;
  }
  return null;
}

/* ============================================================
   THE ATTACHMENT LIGHTBOX
   Full-size preview with Download and — on iOS/macOS — Save to Photos.
   ============================================================ */
async function cnOpenFilePreview(id) {
  const f = cnFindFile(id);
  if (!f) return;

  let bodyHTML;
  if (f.kind === 'image') {
    bodyHTML = `<div class="cn-prev-img"><img src="${esc(f.url)}" alt="${esc(f.name)}" /></div>`;
  } else if (cnIsTextPreviewable(f)) {
    // rendered markdown where the app already has a renderer, raw text otherwise
    let text = CN_TEXT_CACHE.get(id);
    if (text === undefined) {
      try { text = await (await fetch(f.url)).text(); CN_TEXT_CACHE.set(id, text); }
      catch (e) { text = null; }
    }
    if (text === null) bodyHTML = `<p class="cn-prev-err">Couldn't load this file.</p>`;
    else if (/\.(md|markdown)$/i.test(f.name) && typeof mdToHtml === 'function') {
      bodyHTML = `<div class="cn-prev-md">${mdToHtml(text)}</div>`;
    } else {
      bodyHTML = `<pre class="cn-prev-code">${esc(text)}</pre>`;
    }
  } else {
    bodyHTML = `<p class="cn-prev-err">No preview for this kind of file — you can still download it.</p>`;
  }

  const canSavePhotos = f.kind === 'image' && cnCanSaveToPhotos();
  cnPreviewModal({
    title: f.name,
    subtitle: cnBytes(f.size) + (f.temporary ? ' · deleted with the room' : ''),
    bodyHTML,
    actions: [
      { id: 'download', label: 'Download', icon: 'download', run: () => cnDownloadFile(f) },
      ...(canSavePhotos ? [{ id: 'photos', label: 'Save to Photos', icon: 'image', run: () => cnSaveToPhotos(f) }] : []),
    ],
  });
}

/* A wide, chrome-light modal for looking at one thing. */
function cnPreviewModal({ title, subtitle, bodyHTML, actions = [] }) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg cn-prev-bg';
  bg.innerHTML = `<div class="modal cn-prev">
    <div class="cn-prev-head">
      <div class="cn-prev-id"><b>${esc(title)}</b><span>${esc(subtitle || '')}</span></div>
      <button class="cn-prev-x" data-close title="Close">${svg('close', 16)}</button>
    </div>
    <div class="cn-prev-body">${bodyHTML}</div>
    <div class="cn-prev-acts">
      ${actions.map(a => `<button class="btn ghost sm" data-act="${esc(a.id)}">${svg(a.icon, 14)} ${esc(a.label)}</button>`).join('')}
    </div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => { document.removeEventListener('keydown', onKey, true); bg.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey, true);
  bg.querySelector('[data-close]').onclick = close;
  bg.onclick = (e) => { if (e.target === bg) close(); };
  bg.querySelectorAll('[data-act]').forEach(b => {
    const a = actions.find(x => x.id === b.getAttribute('data-act'));
    if (a) b.onclick = () => a.run();
  });
  return bg;
}

/* Save to Photos / camera roll.
   There's no web API that writes to the photo library directly, so this uses the
   Web Share API: on iOS and macOS, sharing an image file offers "Save Image" (and
   "Add to Photos") in the share sheet. That's the closest a web page can get, and
   it's the same route native apps use. Everywhere else we don't offer the button
   at all rather than showing one that can't work. */
function cnCanSaveToPhotos() {
  if (!navigator.canShare || !navigator.share) return false;
  // Apple platforms are where the share sheet actually offers a Photos target.
  const ua = navigator.userAgent || '';
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(ua);
  // iPadOS reports as Macintosh; touch support disambiguates, but either way both
  // are Apple platforms with the same share sheet, so no further check is needed.
  return isApple;
}

async function cnSaveToPhotos(f) {
  try {
    const res = await fetch(f.url);
    if (!res.ok) throw new Error('fetch failed');
    const blob = await res.blob();
    const file = new File([blob], f.name, { type: blob.type || 'image/jpeg' });
    if (navigator.canShare && !navigator.canShare({ files: [file] })) {
      throw new Error('sharing this file type is not supported');
    }
    await navigator.share({ files: [file], title: f.name });
  } catch (e) {
    // AbortError just means they dismissed the sheet — not a failure worth a toast.
    if (e && e.name === 'AbortError') return;
    toast('Couldn\'t open the share sheet — use Download instead', 'info');
  }
}

/* Download an attachment. Goes through a blob so the filename is honoured even
   when the response has no Content-Disposition. */
async function cnDownloadFile(f) {
  try {
    const res = await fetch(f.url + '?download=1');
    if (!res.ok) throw new Error('fetch failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the download in some browsers; a tick later
    // is enough for the click to have been consumed.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    // fall back to letting the browser navigate to it
    window.open(f.url + '?download=1', '_blank', 'noopener');
  }
}

/* One delegated handler for every message action, re-bound after each render. */
function cnWireMsgTools() {
  const box = document.getElementById('cnMsgs');
  if (!box) return;
  box.onclick = (e) => {
    const rx = e.target.closest('[data-rx]');
    if (rx) return cnToggleReaction(rx.getAttribute('data-rx'), rx.getAttribute('data-emoji'));
    const react = e.target.closest('[data-react]');
    if (react) return cnReactionPicker(react.getAttribute('data-react'), react);
    const reply = e.target.closest('[data-reply]');
    if (reply) return cnSetReply(reply.getAttribute('data-reply'));
    const ed = e.target.closest('[data-edit]');
    if (ed) return cnEditMessage(ed.getAttribute('data-edit'));
    const del = e.target.closest('[data-del]');
    if (del) return cnDeleteMessage(del.getAttribute('data-del'));
    // clicking an attachment opens the preview rather than navigating away
    const prev = e.target.closest('[data-preview]');
    if (prev) { e.preventDefault(); return cnOpenFilePreview(prev.getAttribute('data-preview')); }
  };

  // Right-click a message for the same actions as the hover toolbar, plus the
  // ones there's no room for on hover (copy text, copy link to the sender).
  box.oncontextmenu = (e) => {
    const el = e.target.closest('[data-msg]');
    if (!el) return;
    // let the browser's own menu win on a link or an image — "copy image",
    // "open in new tab" and "save as" are genuinely useful there
    if (e.target.closest('a[href], img, video, audio')) return;
    e.preventDefault();
    cnMessageMenu(e, el.getAttribute('data-msg'));
  };
}

/* Right-click menu for one chat message. */
function cnMessageMenu(ev, msgId) {
  const m = CN.messages.find(x => x.id === msgId);
  if (!m) return;
  const canDelete = m.mine || (CN.room && CN.room.canManage);

  const items = [
    // The reaction row goes first — it's the most-used action, and putting the
    // emoji inline saves a second click through a picker.
    {
      id: 'rxrow',
      html: `<div class="cn-menu-rx">${CN_REACTIONS.map(e2 =>
        `<button class="cn-menu-rx-btn" data-emoji="${esc(e2)}">${esc(e2)}</button>`).join('')}</div>`,
      onMount: (root) => {
        root.querySelectorAll('.cn-menu-rx-btn').forEach(b => {
          b.onclick = () => { cnCloseMenu(); cnToggleReaction(msgId, b.getAttribute('data-emoji')); };
        });
      },
    },
    { sep: true },
    { id: 'reply', icon: 'back', label: 'Reply', run: () => cnSetReply(msgId) },
    { id: 'copy', icon: 'copy', label: 'Copy text', run: () => cnCopyText(m.text || '') },
  ];
  if (m.mine) items.push({ id: 'edit', icon: 'rename', label: 'Edit', run: () => cnEditMessage(msgId) });
  if (canDelete) {
    items.push({ sep: true });
    items.push({ id: 'del', icon: 'trash', danger: true, label: 'Delete', run: () => cnDeleteMessage(msgId) });
  }
  cnMenu(ev, items);
}

function cnCopyText(t) {
  if (!t) { toast('Nothing to copy', 'info'); return; }
  try { navigator.clipboard.writeText(t); toast('Copied', 'copy'); }
  catch (e) { toast("Couldn't copy that", 'info'); }
}

function cnRenderMessages() {
  const box = document.getElementById('cnMsgs');
  if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = cnMessagesHTML();
  cnWireMsgTools();
  cnFillTextPreviews();
  if (atBottom) cnScrollChat();
}
function cnScrollChat() {
  const box = document.getElementById('cnMsgs');
  if (box) box.scrollTop = box.scrollHeight;
}

async function cnLoadMessages() {
  if (!CN.room) return;
  try {
    const d = await cnApi('/api/connect/rooms/' + encodeURIComponent(CN.room.id) + '/messages');
    CN.messages = d.messages || [];
    CN.lastMsgAt = CN.messages.length ? CN.messages[CN.messages.length - 1].created : 0;
    cnRenderMessages();
  } catch (e) {}
}

async function cnSendMessage() {
  const input = document.getElementById('cnInput');
  if (!input || !CN.room) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  const replyTo = CN.replyTo;
  cnClearReply();
  try {
    const d = await cnApi('/api/connect/rooms/' + encodeURIComponent(CN.room.id) + '/messages', {
      method: 'POST', body: { text, replyTo },
    });
    cnUpsertMessage(d.message);
  } catch (e) {
    toast("Couldn't send that message", 'info');
    input.value = text;   // give it back rather than losing what they typed
  }
}

function cnUpsertMessage(m) {
  if (!m) return;
  const i = CN.messages.findIndex(x => x.id === m.id);
  if (i >= 0) CN.messages[i] = { ...m, mine: m.authorId === cnMyId() };
  else CN.messages.push({ ...m, mine: m.authorId === cnMyId() });
  CN.messages.sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
  if (m.created > CN.lastMsgAt) CN.lastMsgAt = m.created;
  cnRenderMessages();
}
function cnMyId() { return (ACCOUNT && ACCOUNT.id) || (CN.self && CN.self.id) || null; }

function cnOnMessageEvent(d) {
  if (!d || !d.message) return;
  cnUpsertMessage(d.message);
}
function cnOnMessageEdited(d) { if (d && d.message) cnUpsertMessage(d.message); }
function cnOnMessageDeleted(d) {
  if (!d) return;
  CN.messages = CN.messages.filter(m => m.id !== d.id);
  cnRenderMessages();
}
/* The broadcast is written once for every recipient, so it carries no per-viewer
   `mine` flag. Each client derives its own from the reactor ids in `by`. */
function cnOnMessageReacted(d) {
  if (!d) return;
  const m = CN.messages.find(x => x.id === d.id);
  if (!m) return;
  const me = cnMyId();
  m.reactions = (d.reactions || []).map(r => ({ ...r, mine: (r.by || []).includes(me) }));
  cnRenderMessages();
}

async function cnToggleReaction(msgId, emoji) {
  const m = CN.messages.find(x => x.id === msgId);
  if (!m || !CN.room) return;
  const existing = (m.reactions || []).find(r => r.emoji === emoji);
  const remove = !!(existing && existing.mine);
  try {
    const d = await cnApi(
      `/api/connect/rooms/${encodeURIComponent(CN.room.id)}/messages/${encodeURIComponent(msgId)}/react`,
      { method: 'POST', body: { emoji, remove } });
    cnUpsertMessage(d.message);
  } catch (e) {}
}

/* A small emoji palette anchored to the message. */
function cnReactionPicker(msgId, anchor) {
  document.querySelectorAll('.cn-rx-pop').forEach(p => p.remove());
  const pop = document.createElement('div');
  pop.className = 'cn-rx-pop';
  pop.innerHTML = CN_REACTIONS.map(e => `<button data-pick="${esc(e)}">${e}</button>`).join('');
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.style.top = Math.max(8, r.top - pop.offsetHeight - 6) + 'px';
  pop.onclick = (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    cnToggleReaction(msgId, b.getAttribute('data-pick'));
    pop.remove();
  };
  // close on the next outside click
  setTimeout(() => {
    const close = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 0);
}

function cnSetReply(msgId) {
  const m = CN.messages.find(x => x.id === msgId);
  if (!m) return;
  CN.replyTo = msgId;
  const bar = document.getElementById('cnReplyBar');
  if (!bar) return;
  bar.hidden = false;
  bar.innerHTML = `<span>Replying to <b>${esc(m.authorName)}</b> — ${esc(cnTrim(m.text, 60))}</span>
                   <button class="cn-reply-x" id="cnReplyX">${svg('close', 12)}</button>`;
  const x = document.getElementById('cnReplyX');
  if (x) x.onclick = cnClearReply;
  const input = document.getElementById('cnInput');
  if (input) input.focus();
}
function cnClearReply() {
  CN.replyTo = null;
  const bar = document.getElementById('cnReplyBar');
  if (bar) { bar.hidden = true; bar.innerHTML = ''; }
}

async function cnEditMessage(msgId) {
  const m = CN.messages.find(x => x.id === msgId);
  if (!m || !CN.room) return;
  const text = await cnPrompt({ title: 'Edit message', label: 'Message', value: m.text, okText: 'Save' });
  if (text == null || !text.trim() || text === m.text) return;
  try {
    const d = await cnApi(
      `/api/connect/rooms/${encodeURIComponent(CN.room.id)}/messages/${encodeURIComponent(msgId)}`,
      { method: 'PATCH', body: { text: text.trim() } });
    cnUpsertMessage(d.message);
  } catch (e) { toast("Couldn't edit that message", 'info'); }
}

async function cnDeleteMessage(msgId) {
  if (!CN.room) return;
  const ok = await confirmDialog('Delete message?', 'This removes it for everyone in the room.', 'Delete');
  if (!ok) return;
  try {
    await cnApi(`/api/connect/rooms/${encodeURIComponent(CN.room.id)}/messages/${encodeURIComponent(msgId)}`, { method: 'DELETE' });
    CN.messages = CN.messages.filter(m => m.id !== msgId);
    cnRenderMessages();
  } catch (e) { toast("Couldn't delete that message", 'info'); }
}

/* Poll for chat ONLY when we're not in the call — while in the call the SSE
   stream already delivers messages live, so polling would be pure waste. */
function cnStartMessagePoll() {
  cnStopMessagePoll();
  CN.pollTimer = setInterval(async () => {
    if (!CN.room || CN.inCall) return;
    try {
      const d = await cnApi(`/api/connect/rooms/${encodeURIComponent(CN.room.id)}/messages?since=${CN.lastMsgAt || 0}`);
      for (const m of (d.messages || [])) cnUpsertMessage(m);
    } catch (e) {}
  }, 3000);
}
function cnStopMessagePoll() {
  if (CN.pollTimer) { clearInterval(CN.pollTimer); CN.pollTimer = null; }
}

/* ---- room settings (owner) ----------------------------------------------- */
async function cnRoomSettings() {
  const r = CN.room;
  if (!r) return;
  const members = r.members.map(m => `<li>
      <span>${esc(m.name)}${m.id === r.ownerId ? ' · owner' : ''}</span>
      ${m.id !== r.ownerId ? `<button class="cn-kick" data-kick="${esc(m.id)}">Remove</button>` : ''}
    </li>`).join('');
  const html = `<div class="cn-settings">
    <label class="cn-dev-row"><span>Name</span><input id="cnSetName" value="${esc(r.name)}" maxlength="120" /></label>
    <label class="cn-dev-row"><span>Topic</span><input id="cnSetTopic" value="${esc(r.topic || '')}" maxlength="300" placeholder="optional" /></label>
    <label class="cn-dev-row check"><input type="checkbox" id="cnSetLock" ${r.locked ? 'checked' : ''} /><span>Locked — the code stops letting new people in</span></label>
    ${r.isOwner ? `<label class="cn-dev-row check"><input type="checkbox" id="cnSetPerm" ${r.permanent ? 'checked' : ''} /><span>Keep this room permanently</span></label>
    <p class="cn-dev-note">${r.permanent
      ? 'This room stays put when everyone leaves.'
      : 'Temporary: once everyone leaves the call, this room and its chat are deleted automatically.'}</p>` : ''}
    <div class="cn-set-members"><h4>People (${r.members.length})</h4><ul id="cnMemberList">${members}</ul></div>
    <p class="cn-dev-note">Deleting the room erases its chat and reactions for everyone.</p>
  </div>`;
  const ok = await cnModal({
    title: 'Room settings', bodyHTML: html, okText: 'Save',
    extraText: 'Delete room',
    onExtra: async () => {
      const sure = await confirmDialog(
        'Delete this room?',
        `"${r.name}" and its entire chat history will be gone for everyone. This cannot be undone.`,
        'Delete room');
      if (!sure) return false;
      try {
        await cnApi('/api/connect/rooms/' + encodeURIComponent(r.id), { method: 'DELETE' });
        await cnLeaveCall({ silent: true });
        CN.room = null;
        toast('Room deleted', 'trash');
        await cnLoadRooms();
      } catch (e) { toast("Couldn't delete the room", 'info'); }
      return true;
    },
    onAccept: (root) => ({
      name: (root.querySelector('#cnSetName') || {}).value || '',
      topic: (root.querySelector('#cnSetTopic') || {}).value || '',
      locked: !!(root.querySelector('#cnSetLock') || {}).checked,
      permanent: root.querySelector('#cnSetPerm') ? !!root.querySelector('#cnSetPerm').checked : undefined,
    }),
    onMount: (root) => {
      root.querySelectorAll('[data-kick]').forEach(b => {
        b.onclick = async () => {
          const id = b.getAttribute('data-kick');
          try {
            await cnApi(`/api/connect/rooms/${encodeURIComponent(r.id)}/members/${encodeURIComponent(id)}`, { method: 'DELETE' });
            b.closest('li').remove();
            toast('Removed', 'check');
          } catch (e) { toast("Couldn't remove them", 'info'); }
        };
      });
    },
  });
  if (!ok) return;
  // captured by onAccept while the modal was still mounted (see cnModal)
  const { name, topic, locked, permanent } = ok;
  try {
    const body = { name, topic, locked };
    if (permanent !== undefined) body.permanent = permanent;
    const d = await cnApi('/api/connect/rooms/' + encodeURIComponent(r.id), {
      method: 'PATCH', body,
    });
    CN.room = d.room;
    cnRenderBody();
  } catch (e) { toast("Couldn't save the room", 'info'); }
}

/* ---- local dialogs -------------------------------------------------------
   app.js has confirmModal/confirmDialog, but both are text-only and positional.
   Connect needs a text PROMPT and a modal that can host arbitrary markup (the
   device picker, the room settings with its member list), so these two build on
   the same .modal-bg / .modal markup the rest of the app styles. */
function cnPrompt({ title, label, value = '', placeholder = '', okText = 'OK', hint = '' }) {
  return new Promise(resolve => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal">
      <h3>${esc(title)}</h3>
      <label class="cn-prompt-label">${esc(label || '')}
        <input id="cnPromptInput" value="${esc(value)}" placeholder="${esc(placeholder)}" />
      </label>
      ${hint ? `<p class="dim">${esc(hint)}</p>` : ''}
      <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>${esc(okText)}</button></div>
    </div>`;
    document.body.appendChild(bg);
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; bg.remove(); resolve(v); };
    const input = bg.querySelector('#cnPromptInput');
    bg.querySelector('[data-cancel]').onclick = () => done(null);
    bg.querySelector('[data-ok]').onclick = () => done(input.value);
    bg.onclick = e => { if (e.target === bg) done(null); };
    input.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    };
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

/* Modal with custom body markup. `onMount` gets the modal element so callers can
   wire controls inside it; `extra` adds a third (usually destructive) button
   whose handler returning true closes the modal. */
/* `cancelText: null` drops the Cancel button entirely — for panels that apply
   their changes live and so have nothing to cancel BACK to.
   `onClose` always runs when the modal goes away, whichever way it went. Panels
   that start something (an audio monitor, a timer) use it to guarantee cleanup;
   relying on the OK handler alone would leak when the user clicks the backdrop. */
function cnModal({ title, bodyHTML, okText = 'Save', cancelText = 'Cancel', extraText = '', onExtra = null, onMount = null, onAccept = null, onClose = null, wide = false }) {
  return new Promise(resolve => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal cn-modal ${wide ? 'wide' : ''}">
      <h3>${esc(title)}</h3>
      <div class="cn-modal-body">${bodyHTML}</div>
      <div class="acts">
        ${extraText ? `<button class="btn danger" data-extra>${esc(extraText)}</button>` : ''}
        <div class="spacer"></div>
        ${cancelText ? `<button class="btn ghost" data-cancel>${esc(cancelText)}</button>` : ''}
        <button class="btn primary" data-ok>${esc(okText)}</button>
      </div>
    </div>`;
    document.body.appendChild(bg);
    let settled = false;
    // IMPORTANT: `onAccept` runs while the modal is still in the DOM and its return
    // value is what the promise resolves to. Callers that need to READ their own
    // form controls must use it — reading them after the promise resolves fails,
    // because the modal (and its inputs) are already removed by then.
    const done = (v) => {
      if (settled) return;
      settled = true;
      const root = bg.querySelector('.modal');
      let out = v;
      if (v === true && onAccept) { try { out = onAccept(root); } catch (e) { out = v; } }
      // cleanup runs while the DOM is still intact, and on EVERY exit path
      if (onClose) { try { onClose(root); } catch (e) {} }
      bg.remove();
      resolve(out);
    };
    const cancelBtn = bg.querySelector('[data-cancel]');
    if (cancelBtn) cancelBtn.onclick = () => done(false);
    bg.querySelector('[data-ok]').onclick = () => done(true);
    bg.onclick = e => { if (e.target === bg) done(false); };
    const ex = bg.querySelector('[data-extra]');
    if (ex && onExtra) ex.onclick = async () => { if (await onExtra()) done(false); };
    if (onMount) onMount(bg.querySelector('.modal'));
  });
}

/* ---- tiny fetch wrapper (matches the other apps' error shape) ------------- */
async function cnApi(url, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);
  if (res.status === 401) { const e = new Error('auth'); e.code = 'AUTH'; throw e; }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const e = new Error((data && data.error) || `request failed (${res.status})`);
    e.status = res.status;
    if (data && data.code) e.code = data.code;
    throw e;
  }
  return data;
}

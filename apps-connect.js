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
const CN_VIDEO_BITRATE = 2_500_000;      // camera target; screen gets more (below)
const CN_SCREEN_BITRATE = 8_000_000;     // sharing text/code needs the headroom
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
  if (CN.room) cnWireRoom(); else cnWireLobby();
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
          <textarea id="cnInput" rows="1" placeholder="Message the room…" maxlength="4000"></textarea>
          <button type="submit" class="btn primary sm" id="cnSend" title="Send">${svg('send', 14)}</button>
        </form>
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
  const tiles = [cnSelfTileHTML(), ...[...CN.peers.values()].map(cnPeerTileHTML)].join('');
  const n = CN.peers.size + 1;
  const cls = CN.pinned ? 'pinned' : `n${Math.min(n, 9)}`;
  return `<div class="cn-grid ${cls}" id="cnGrid">${tiles}</div>`;
}

function cnSelfTileHTML() {
  const pinned = CN.pinned === 'self';
  const showing = CN.media.screen || CN.media.cam;
  return `<div class="cn-tile self ${pinned ? 'pin' : ''} ${CN.pinned && !pinned ? 'thumb' : ''}" data-peer="self">
    <video id="cnSelfVideo" autoplay muted playsinline class="${showing ? '' : 'off'}"></video>
    ${showing ? '' : `<div class="cn-avatar">${cnInitials(CN.self ? CN.self.name : 'You')}</div>`}
    <div class="cn-tile-bar">
      <span class="cn-tile-name">You${CN.media.screen ? ' · presenting' : ''}</span>
      <span class="cn-tile-icons">
        ${CN.media.hand ? '<span class="cn-hand">✋</span>' : ''}
        ${CN.media.mic ? '' : `<span class="cn-muted" title="Muted">${svg('volmute', 12)}</span>`}
      </span>
    </div>
  </div>`;
}

function cnPeerTileHTML(p) {
  const pinned = CN.pinned === p.id;
  const showing = p.media && (p.media.cam || p.media.screen);
  return `<div class="cn-tile ${pinned ? 'pin' : ''} ${CN.pinned && !pinned ? 'thumb' : ''}" data-peer="${esc(p.id)}">
    <video autoplay playsinline data-video="${esc(p.id)}" class="${showing ? '' : 'off'}"></video>
    ${showing ? '' : `<div class="cn-avatar">${cnInitials(p.name)}</div>`}
    ${p.connecting ? `<div class="cn-connecting">connecting…</div>` : ''}
    <div class="cn-tile-bar">
      <span class="cn-tile-name">${esc(p.name)}${p.media && p.media.screen ? ' · presenting' : ''}</span>
      <span class="cn-tile-icons">
        ${p.media && p.media.hand ? '<span class="cn-hand">✋</span>' : ''}
        ${p.media && p.media.mic ? '' : `<span class="cn-muted" title="Muted">${svg('volmute', 12)}</span>`}
      </span>
    </div>
  </div>`;
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
    <button class="cn-ctl" id="cnDevices" title="Choose microphone & camera">${svg('gear', 17)}<span>Devices</span></button>
    <div class="spacer"></div>
    <button class="cn-ctl leave" id="cnLeave" title="Leave the call">${svg('close', 17)}<span>Leave</span></button>`;
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

  // click a tile to pin it to speaker view; click again to unpin
  document.querySelectorAll('.cn-tile').forEach(t => {
    t.ondblclick = () => {
      const id = t.getAttribute('data-peer');
      CN.pinned = (CN.pinned === id) ? null : id;
      cnRenderStage();
    };
  });
  cnAttachStreams();
}

/* Re-render only the video area (not the chat, which would lose scroll + input). */
function cnRenderStage() {
  const stage = document.getElementById('cnStage');
  if (!stage) return;
  stage.innerHTML = cnStageHTML();
  const bar = document.querySelector('.cn-bar');
  if (bar) bar.innerHTML = cnBarHTML();
  const room = document.getElementById('cnRoom');
  if (room) room.classList.toggle('in-call', CN.inCall);
  cnWireStage();
}

/* Put the MediaStream objects back onto the freshly-rendered <video> elements.
   srcObject can't live in HTML, so this runs after every stage render. */
function cnAttachStreams() {
  const self = document.getElementById('cnSelfVideo');
  if (self) {
    // While presenting, your own tile previews the SCREEN; otherwise the camera.
    const want = CN.media.screen && CN.screen ? CN.screen : CN.local;
    if (want && self.srcObject !== want) self.srcObject = want;
    cnTrackTileRatio(self);
  }
  for (const p of CN.peers.values()) {
    const el = document.querySelector(`[data-video="${CSS.escape(p.id)}"]`);
    if (el && p.stream && el.srcObject !== p.stream) el.srcObject = p.stream;
    if (el) cnTrackTileRatio(el);
  }
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
    stream = await navigator.mediaDevices.getUserMedia({
      audio: cnAudioConstraints(),
      video: cam ? cnVideoConstraints() : false,
    });
  } catch (e) {
    hint.remove();
    // Asking for the camera when only a mic exists fails the WHOLE request, so retry
    // audio-only rather than leaving them stuck outside the call.
    if (cam && (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError'))) {
      toast('No camera found — joining with just your mic', 'info');
      return cnJoinCall({ cam: false });
    }
    cnPermissionHelpModal(e, cam);
    return;
  }
  hint.remove();

  CN.local = stream;
  CN.media.mic = true;
  CN.media.cam = !!cam && stream.getVideoTracks().length > 0;
  CN.inCall = true;
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
  return {
    ...(id ? { deviceId: { exact: id } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 2,
    sampleRate: 48000,
  };
}
function cnVideoConstraints() {
  const id = CN.devices.camId;
  return {
    ...(id ? { deviceId: { exact: id } } : {}),
    width: { ideal: 1920 }, height: { ideal: 1080 },
    frameRate: { ideal: 60, max: 60 },
  };
}
function cnMediaError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError') return 'Simplex needs permission to use your mic/camera';
  if (n === 'NotFoundError') return 'No microphone or camera found';
  if (n === 'NotReadableError') return 'Your mic/camera is in use by another app';
  return 'Could not start your mic/camera';
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
  CN.peers.delete(id);
  CN.analysers.delete(id);
  if (CN.pinned === id) CN.pinned = null;
}

/* Build the RTCPeerConnection for one peer and attach our outgoing tracks. */
function cnMakePc(peerId) {
  const peer = CN.peers.get(peerId);
  if (!peer) return null;
  if (peer.pc) return peer.pc;

  const pc = new RTCPeerConnection({ iceServers: CN_ICE, bundlePolicy: 'max-bundle' });
  peer.pc = pc;

  // send our current tracks
  if (CN.local) for (const t of CN.local.getTracks()) pc.addTrack(t, CN.local);
  if (CN.screen) for (const t of CN.screen.getVideoTracks()) pc.addTrack(t, CN.screen);

  pc.onicecandidate = (e) => {
    if (e.candidate) cnSignal(peerId, 'ice', e.candidate.toJSON());
  };

  pc.ontrack = (e) => {
    // One stream per peer keeps the tile simple: whatever they send lands here.
    let stream = peer.stream;
    if (!stream) { stream = new MediaStream(); peer.stream = stream; }
    if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
    peer.connecting = false;
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
      const kbps = section === 'audio' ? CN_AUDIO_BITRATE / 1000 : (CN.media.screen ? CN_SCREEN_BITRATE : CN_VIDEO_BITRATE) / 1000;
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
          p.encodings[0].maxBitrate = screen ? CN_SCREEN_BITRATE : CN_VIDEO_BITRATE;
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
      const s = await navigator.mediaDevices.getUserMedia({ video: cnVideoConstraints() });
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
    // Ask for the best the display will give, and take system audio if offered.
    CN.screen = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60, max: 60 }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    // The user cancelling the picker is a normal outcome, not an error to shout about.
    if (e && e.name === 'NotAllowedError') return;
    toast("Couldn't start screen sharing", 'info');
    return;
  }
  const track = CN.screen.getVideoTracks()[0];
  if (!track) return;
  // "Stop sharing" in the browser's own bar ends the track behind our back.
  track.onended = () => cnStopScreen();
  cnAddTrackToPeers(track, CN.screen);
  for (const a of CN.screen.getAudioTracks()) cnAddTrackToPeers(a, CN.screen);
  CN.media.screen = true;
  cnPublishMedia();
  cnRenderStage();
}

function cnStopScreen() {
  if (CN.screen) {
    for (const t of CN.screen.getTracks()) { t.stop(); cnDropTrack(t); }
    CN.screen = null;
  }
  CN.media.screen = false;
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
  if (CN.local) { for (const t of CN.local.getTracks()) t.stop(); CN.local = null; }
  if (CN.screen) { for (const t of CN.screen.getTracks()) t.stop(); CN.screen = null; }
  CN.media = { mic: false, cam: false, screen: false, hand: false };
  CN.pinned = null;
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
    <p class="cn-dev-note">Changes apply straight away — the call keeps running. Audio is sent as 64 kbps stereo Opus.</p>
  </div>`;
  // Read the selects INSIDE onAccept — the modal is removed before the promise
  // resolves, so reading them afterwards would always come back empty.
  const picked = await cnModal({
    title: 'Devices', bodyHTML: html, okText: 'Use these',
    onAccept: (root) => ({
      mic: (root.querySelector('#cnMicSel') || {}).value || null,
      cam: (root.querySelector('#cnCamSel') || {}).value || null,
    }),
  });
  if (!picked) return;

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
  }
  cnRenderStage();
}

/* Replace one live track everywhere (replaceTrack needs no renegotiation). */
async function cnSwapTrack(kind) {
  if (!cnCanCapture()) { cnInsecureOriginModal(); return false; }
  // Selecting a device the browser hasn't granted yet triggers a FRESH permission
  // prompt (each camera is its own grant), so show the same hint as on join —
  // otherwise the switch looks like it silently did nothing.
  const hint = cnPermHint(kind === 'video');
  let fresh = null;
  try {
    const s = await navigator.mediaDevices.getUserMedia(
      kind === 'audio' ? { audio: cnAudioConstraints() } : { video: cnVideoConstraints() });
    fresh = kind === 'audio' ? s.getAudioTracks()[0] : s.getVideoTracks()[0];
    if (!fresh) { s.getTracks().forEach(t => t.stop()); return false; }
  } catch (e) {
    hint.remove();
    // A device can vanish between listing and selecting (unplugged), and an exact
    // deviceId that no longer resolves throws OverconstrainedError. Fall back to
    // the system default rather than leaving them with no camera at all.
    if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
      if (kind === 'audio') CN.devices.micId = null; else CN.devices.camId = null;
      toast('That device is unavailable — using the default instead', 'info');
      return cnSwapTrack(kind);
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
  if (kind === 'audio') fresh.enabled = CN.media.mic;

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
    <div class="cn-msg-body">${cnLinkify(m.text)}${m.edited ? '<span class="cn-edited">(edited)</span>' : ''}</div>
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
  cnWireMsgTools();
  cnScrollChat();
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
  };
}

function cnRenderMessages() {
  const box = document.getElementById('cnMsgs');
  if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = cnMessagesHTML();
  cnWireMsgTools();
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
  const { name, topic, locked } = ok;
  try {
    const d = await cnApi('/api/connect/rooms/' + encodeURIComponent(r.id), {
      method: 'PATCH', body: { name, topic, locked },
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
function cnModal({ title, bodyHTML, okText = 'Save', extraText = '', onExtra = null, onMount = null, onAccept = null }) {
  return new Promise(resolve => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal cn-modal">
      <h3>${esc(title)}</h3>
      <div class="cn-modal-body">${bodyHTML}</div>
      <div class="acts">
        ${extraText ? `<button class="btn danger" data-extra>${esc(extraText)}</button>` : ''}
        <div class="spacer"></div>
        <button class="btn ghost" data-cancel>Cancel</button>
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
      let out = v;
      if (v === true && onAccept) { try { out = onAccept(bg.querySelector('.modal')); } catch (e) { out = v; } }
      bg.remove();
      resolve(out);
    };
    bg.querySelector('[data-cancel]').onclick = () => done(false);
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

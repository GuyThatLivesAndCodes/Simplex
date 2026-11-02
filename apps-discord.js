/* ============================================================
   DISCORD BOT app (apps-discord.js) — admin-only control panel for the server-side
   voice assistant, extracted from app.js and loaded on demand (openApp ->
   openLazyApp -> loadFeature("apps-discord")). Plain non-module script sharing the
   app.js global scope. See [[lazy-loading-architecture]] and [[discord-bot-app]].
   ============================================================ */
/* ============================================================
   DISCORD BOT APP (admin-only)
   Control panel for the server-side voice assistant (discord-bot.js): live
   status + activity feed, start/stop/restart, and every knob — bot token,
   system prompt, wake words, xAI model, STT/TTS endpoints, timing. Secrets are
   write-only: the server only ever reports "set / not set".
   ============================================================ */
const DC = { status: null, cfg: null, tokenSet: false, sttKeySet: false, ttsKeySet: false, xaiKeySet: false, log: [], logSince: 0, timer: null, busy: false };

function discordHTML() {
  return `<div class="dc-app" data-screen-label="Discord Bot">
    <div class="dc-head">
      <div>
        <h2 class="dc-title">${svg('discord', 20, 1.8)} Discord Bot</h2>
        <p class="dc-sub">A voice assistant in your Discord server — it joins calls with <span class="mono">/join-call</span>, transcribes everything it hears, wakes on “Hey Simplex”, and talks back with AI. Admin-only.</p>
      </div>
    </div>
    <div class="dc-grid">
      <div class="dc-col">
        <div class="dc-card" id="dcStatusCard"><div class="dc-loading">${svg('discord', 24)}<span>Loading status…</span></div></div>
        <div class="dc-card">
          <h3 class="dc-card-h">${svg('pulse', 16)} Activity</h3>
          <div class="dc-log" id="dcLog"><div class="dc-log-empty mono">Nothing yet — start the bot and join a call.</div></div>
        </div>
        <div class="dc-card">
          <h3 class="dc-card-h">${svg('info', 16)} Setup guide</h3>
          <ol class="dc-guide">
            <li>Create an application at <span class="mono">discord.com/developers</span> → Bot → copy the <b>token</b> into the form here.</li>
            <li>Invite it: OAuth2 → URL Generator → scopes <span class="mono">bot</span> + <span class="mono">applications.commands</span>; permissions <b>Connect</b>, <b>Speak</b>, <b>Send Messages</b>.</li>
            <li>The assistant's brain uses the <b>xAI key</b> from Settings → AI providers${'' /* shared with the AI app */}.</li>
            <li>Hearing needs a <b>speech-to-text</b> key (any OpenAI-compatible endpoint — the default URL is Groq's free Whisper). A <b>text-to-speech</b> endpoint is optional; without one the bot replies in text chat.</li>
            <li>Start the bot, join a voice channel in Discord, type <span class="mono">/join-call</span>, and say “${esc((DC.cfg && DC.cfg.wakeWords && DC.cfg.wakeWords[0]) || 'hey simplex')}”.</li>
          </ol>
        </div>
      </div>
      <div class="dc-col">
        <div class="dc-card" id="dcConfigCard"><div class="dc-loading">${svg('gear', 24)}<span>Loading config…</span></div></div>
      </div>
    </div>
  </div>`;
}

function wireDiscord() {
  DC.log = []; DC.logSince = 0;
  loadDiscord();
  DC.timer = setInterval(() => { pollDiscord().catch(() => {}); }, 3000);
  _appCleanup = () => { if (DC.timer) { clearInterval(DC.timer); DC.timer = null; } };
}

async function loadDiscord() {
  try {
    const [cfg, st] = await Promise.all([discordGetConfig(), discordStatus()]);
    DC.cfg = cfg.config; DC.tokenSet = cfg.tokenSet; DC.sttKeySet = cfg.sttKeySet; DC.ttsKeySet = cfg.ttsKeySet; DC.xaiKeySet = cfg.xaiKeySet;
    DC.status = st;
    renderDiscordStatus(); renderDiscordConfig();
    await pollDiscord();
  } catch (e) {
    if (e && e.code === 'AUTH') return relock();
    const card = document.getElementById('dcStatusCard');
    if (card) card.innerHTML = `<div class="dc-loading">${svg('info', 22)}<span>${esc((e && e.message) || 'Could not load')}</span></div>`;
  }
}

async function pollDiscord() {
  if (currentApp !== 'discord') return;
  const [st, lg] = await Promise.all([discordStatus(), discordLogFetch(DC.logSince)]);
  DC.status = st;
  if (lg.log && lg.log.length) { DC.log.push(...lg.log); if (DC.log.length > 400) DC.log.splice(0, DC.log.length - 400); }
  DC.logSince = lg.now || Date.now();
  renderDiscordStatus(); renderDiscordLog();
}

function dcBadge() {
  const s = DC.status || {};
  if (s.starting) return '<span class="dc-badge starting">Starting…</span>';
  if (s.running && s.user) return '<span class="dc-badge on">Online</span>';
  if (s.running) return '<span class="dc-badge starting">Connecting…</span>';
  return '<span class="dc-badge off">Offline</span>';
}

function renderDiscordStatus() {
  const card = document.getElementById('dcStatusCard');
  if (!card) return;
  const s = DC.status || {};
  const keyRow = (ok, label) => `<span class="dc-key ${ok ? 'ok' : 'miss'}">${svg(ok ? 'check' : 'close', 12)} ${label}</span>`;
  const voice = s.voice ? `
    <div class="dc-voice">
      <div class="dc-voice-h">${svg('vol', 14)} In call: <b>${esc(s.voice.channel)}</b>${s.voice.session ? ` <span class="dc-badge on">AI session · ${s.voice.session.turns} turn${s.voice.session.turns === 1 ? '' : 's'}</span>` : ' <span class="dc-badge idle">listening for wake word</span>'}</div>
      <div class="dc-voice-p mono">${s.voice.participants.length ? 'With: ' + esc(s.voice.participants.join(', ')) : 'Nobody else in the channel'}</div>
      <button class="btn ghost sm danger" id="dcHangup">${svg('close', 13)} Hang up</button>
    </div>` : '';
  card.innerHTML = `
    <h3 class="dc-card-h">${svg('pulse', 16)} Status ${dcBadge()}</h3>
    <div class="dc-status-rows">
      <div class="dc-srow"><span class="eyebrow">Bot</span>${s.user ? `<b>${esc(s.user)}</b>` : '<span class="mono">not connected</span>'}${s.startedAt ? ` <span class="mono">· up ${fmtElapsed(Date.now() - s.startedAt)}</span>` : ''}</div>
      <div class="dc-srow"><span class="eyebrow">Servers</span>${s.guilds && s.guilds.length ? esc(s.guilds.map(g => g.name).join(', ')) : '<span class="mono">none</span>'}</div>
      <div class="dc-srow dc-keys"><span class="eyebrow">Keys</span>
        ${keyRow(s.tokenSet !== undefined ? s.tokenSet : DC.tokenSet, 'Bot token')}
        ${keyRow(s.xaiKeySet !== undefined ? s.xaiKeySet : DC.xaiKeySet, 'xAI')}
        ${keyRow(s.sttKeySet !== undefined ? s.sttKeySet : DC.sttKeySet, 'STT key')}
        ${keyRow(s.ttsKeySet !== undefined ? s.ttsKeySet : DC.ttsKeySet, 'TTS key')}
      </div>
      ${s.depsError ? `<div class="dc-err mono">${esc(s.depsError)}</div>` : ''}
      ${s.lastError ? `<div class="dc-err mono">${esc(s.lastError)}</div>` : ''}
    </div>
    ${voice}
    <div class="dc-acts">
      <button class="btn primary sm" id="dcStart" ${s.running ? 'disabled' : ''}>${svg('play', 13)} Start</button>
      <button class="btn ghost sm" id="dcRestart" ${s.running ? '' : 'disabled'}>${svg('refresh', 13)} Restart</button>
      <button class="btn ghost sm danger" id="dcStop" ${s.running ? '' : 'disabled'}>${svg('stop', 13)} Stop</button>
    </div>`;
  const act = (id, fn, msg) => { const b = document.getElementById(id); if (b) b.onclick = async () => { if (DC.busy) return; DC.busy = true; b.disabled = true; try { DC.status = await fn(); renderDiscordStatus(); toast(msg, 'check'); } catch (e) { toast((e && e.message) || 'Failed', 'close'); } finally { DC.busy = false; } }; };
  act('dcStart', discordStart, 'Bot starting');
  act('dcStop', discordStop, 'Bot stopped');
  act('dcRestart', discordRestart, 'Bot restarting');
  act('dcHangup', discordHangup, 'Left the call');
}

const DC_LOG_ICON = { info: 'info', error: 'close', transcript: 'vol', wake: 'spark', ai: 'brain', tts: 'audio' };
function renderDiscordLog() {
  const el = document.getElementById('dcLog');
  if (!el) return;
  if (!DC.log.length) { el.innerHTML = '<div class="dc-log-empty mono">Nothing yet — start the bot and join a call.</div>'; return; }
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = DC.log.slice(-200).map(e => {
    const t = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `<div class="dc-log-row ${esc(e.kind)}"><span class="dc-log-t mono">${t}</span><span class="dc-log-i">${svg(DC_LOG_ICON[e.kind] || 'info', 12)}</span><span class="dc-log-x">${esc(e.text)}</span></div>`;
  }).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

/* ---------- config form (everything admin-tunable, secrets write-only) ---------- */
function dcField(label, inner, hint) {
  return `<label class="dc-field"><span class="eyebrow">${label}</span>${inner}${hint ? `<span class="dc-hint">${hint}</span>` : ''}</label>`;
}
function dcSecretField(id, label, isSet, hint) {
  return dcField(label, `<input type="password" id="${id}" autocomplete="off" placeholder="${isSet ? '•••••• saved — leave blank to keep' : 'not set'}">`,
    `${hint || ''}${isSet ? ` <a href="#" class="dc-clear" data-clear="${id}">remove</a>` : ''}`);
}

function renderDiscordConfig() {
  const card = document.getElementById('dcConfigCard');
  if (!card || !DC.cfg) return;
  const c = DC.cfg;
  card.innerHTML = `
    <h3 class="dc-card-h">${svg('gear', 16)} Configuration</h3>
    <div class="dc-form">
      <div class="dc-sect">${svg('key', 14)} Connection</div>
      ${dcSecretField('dcTok', 'Bot token', DC.tokenSet, 'From the Discord developer portal.')}
      ${dcField('Autostart with the server', `<label class="dc-check"><input type="checkbox" id="dcEnabled" ${c.enabled ? 'checked' : ''}> start the bot whenever Simplex boots</label>`)}
      ${dcField('Presence text', `<input type="text" id="dcPresence" maxlength="100" value="${esc(c.presence)}">`, 'Shows as “Watching …” under the bot’s name.')}

      <div class="dc-sect">${svg('brain', 14)} Assistant</div>
      ${dcField('System prompt', `<textarea id="dcSys" rows="6" maxlength="8000">${esc(c.systemPrompt)}</textarea>`, 'The AI’s personality &amp; rules. It already knows about its end_call / end_session / list_participants tools.')}
      ${dcField('xAI model', `<input type="text" id="dcModel" value="${esc(c.model)}">`, DC.xaiKeySet ? 'Uses the xAI key from Settings → AI providers.' : '⚠ No xAI key set — add one in Settings → AI providers.')}
      <div class="dc-2col">
        ${dcField('Temperature', `<input type="number" id="dcTemp" step="0.1" min="0" max="2" value="${c.temperature}">`)}
        ${dcField('Max reply tokens', `<input type="number" id="dcMaxTok" min="32" max="4096" value="${c.maxTokens}">`)}
      </div>
      ${dcField('Wake words', `<input type="text" id="dcWake" value="${esc(c.wakeWords.join(', '))}">`, 'Comma-separated. Hearing any of these starts an AI session.')}
      ${dcField('', `<label class="dc-check"><input type="checkbox" id="dcEveryone" ${c.respondToEveryone ? 'checked' : ''}> during a session, respond to everyone (not just whoever woke it)</label>`)}
      ${dcField('', `<label class="dc-check"><input type="checkbox" id="dcAmbient" ${c.includeAmbient ? 'checked' : ''}> give the AI the chat heard just before the wake word</label>`)}
      <div class="dc-2col">
        ${dcField('Session sleep after (s)', `<input type="number" id="dcIdle" min="5" max="600" value="${Math.round(c.sessionIdleMs / 1000)}">`, 'Silence before it goes back to passive listening.')}
        ${dcField('Max turns per session', `<input type="number" id="dcTurns" min="1" max="500" value="${c.maxSessionTurns}">`)}
      </div>

      <div class="dc-sect">${svg('vol', 14)} Hearing (speech-to-text)</div>
      ${dcField('STT endpoint', `<input type="text" id="dcSttUrl" value="${esc(c.sttUrl)}">`, 'Any OpenAI-compatible /audio/transcriptions URL (Groq, OpenAI, local Whisper…).')}
      ${dcSecretField('dcSttKey', 'STT API key', DC.sttKeySet)}
      <div class="dc-2col">
        ${dcField('STT model', `<input type="text" id="dcSttModel" value="${esc(c.sttModel)}">`)}
        ${dcField('Language (blank = auto)', `<input type="text" id="dcSttLang" maxlength="8" value="${esc(c.sttLanguage)}">`)}
      </div>
      <div class="dc-2col">
        ${dcField('End of utterance (ms silence)', `<input type="number" id="dcVad" min="200" max="5000" value="${c.vadSilenceMs}">`)}
        ${dcField('Ignore blips under (ms)', `<input type="number" id="dcMinUtt" min="100" max="5000" value="${c.minUtteranceMs}">`)}
      </div>

      <div class="dc-sect">${svg('audio', 14)} Voice (text-to-speech)</div>
      ${dcField('TTS endpoint', `<input type="text" id="dcTtsUrl" value="${esc(c.ttsUrl)}" placeholder="blank = reply in text chat only">`, 'OpenAI-compatible /audio/speech URL.')}
      ${dcSecretField('dcTtsKey', 'TTS API key', DC.ttsKeySet)}
      <div class="dc-2col">
        ${dcField('TTS model', `<input type="text" id="dcTtsModel" value="${esc(c.ttsModel)}">`)}
        ${dcField('Voice', `<input type="text" id="dcTtsVoice" value="${esc(c.ttsVoice)}">`)}
      </div>
      <div class="dc-2col">
        ${dcField('Speed', `<input type="number" id="dcTtsSpeed" step="0.05" min="0.5" max="2" value="${c.ttsSpeed}">`)}
        ${dcField('', `<label class="dc-check"><input type="checkbox" id="dcTextFb" ${c.textFallback ? 'checked' : ''}> also post replies in text chat</label>`)}
      </div>

      <div class="dc-form-acts">
        <span class="dc-form-msg" id="dcFormMsg"></span>
        <button class="btn primary" id="dcSave">${svg('save', 14)} Save configuration</button>
      </div>
    </div>`;
  card.querySelectorAll('[data-clear]').forEach(a => a.onclick = (ev) => {
    ev.preventDefault();
    const map = { dcTok: ['botToken', 'bot token'], dcSttKey: ['sttKey', 'STT key'], dcTtsKey: ['ttsKey', 'TTS key'] };
    const [field, label] = map[a.dataset.clear];
    confirmModal(`Remove ${label}?`, 'The saved secret is deleted from the server. The bot may stop working until you set a new one.', async () => {
      try { const r = await discordSetConfig({ [field]: '' }); DC.tokenSet = r.tokenSet; DC.sttKeySet = r.sttKeySet; DC.ttsKeySet = r.ttsKeySet; renderDiscordConfig(); toast('Removed', 'check'); }
      catch (e) { toast('Could not remove', 'close'); }
    }, 'Remove');
  });
  const save = document.getElementById('dcSave');
  if (save) save.onclick = saveDiscordConfig;
}

async function saveDiscordConfig() {
  const btn = document.getElementById('dcSave');
  const msg = document.getElementById('dcFormMsg');
  const v = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
  const chk = (id) => { const el = document.getElementById(id); return el ? el.checked : undefined; };
  const payload = {
    config: {
      ...DC.cfg,
      enabled: chk('dcEnabled'),
      presence: v('dcPresence'),
      systemPrompt: v('dcSys'),
      model: v('dcModel'),
      temperature: parseFloat(v('dcTemp')),
      maxTokens: parseInt(v('dcMaxTok'), 10),
      wakeWords: v('dcWake'),
      respondToEveryone: chk('dcEveryone'),
      includeAmbient: chk('dcAmbient'),
      sessionIdleMs: (parseInt(v('dcIdle'), 10) || 45) * 1000,
      maxSessionTurns: parseInt(v('dcTurns'), 10),
      sttUrl: v('dcSttUrl'), sttModel: v('dcSttModel'), sttLanguage: v('dcSttLang'),
      vadSilenceMs: parseInt(v('dcVad'), 10), minUtteranceMs: parseInt(v('dcMinUtt'), 10),
      ttsUrl: v('dcTtsUrl'), ttsModel: v('dcTtsModel'), ttsVoice: v('dcTtsVoice'),
      ttsSpeed: parseFloat(v('dcTtsSpeed')), textFallback: chk('dcTextFb'),
    },
  };
  // secrets ride along only when typed (blank = keep; removal is the explicit link)
  for (const [id, field] of [['dcTok', 'botToken'], ['dcSttKey', 'sttKey'], ['dcTtsKey', 'ttsKey']]) {
    const val = (v(id) || '').trim();
    if (val) payload[field] = val;
  }
  btn.disabled = true;
  if (msg) { msg.textContent = ''; msg.className = 'dc-form-msg'; }
  try {
    const r = await discordSetConfig(payload);
    DC.cfg = r.config; DC.tokenSet = r.tokenSet; DC.sttKeySet = r.sttKeySet; DC.ttsKeySet = r.ttsKeySet; DC.xaiKeySet = r.xaiKeySet;
    renderDiscordConfig();
    if (msg) { msg.textContent = DC.status && DC.status.running ? 'Saved — restart the bot to apply connection changes.' : 'Saved.'; msg.className = 'dc-form-msg ok'; }
    toast('Configuration saved', 'check');
  } catch (e) {
    if (e && e.code === 'AUTH') return relock();
    if (msg) { msg.textContent = (e && e.message) || 'Could not save.'; msg.className = 'dc-form-msg err'; }
  } finally { btn.disabled = false; }
}

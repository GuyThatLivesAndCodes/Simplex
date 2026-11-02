/* ============================================================
   DISCORD BOT ENGINE — Simplex's voice assistant that lives in a Discord server.
   Server-side only (required by server.js; never shipped to the browser).

   What it does:
   - Connects a bot account (admin-supplied token) to the Discord gateway.
   - Registers two slash commands: /join-call (bot joins YOUR current voice
     channel) and /leave-call (bot disconnects).
   - While in a call it ALWAYS listens: every utterance from every user is
     captured (per-user Opus stream → PCM → WAV) and transcribed to text via an
     admin-configured OpenAI-compatible speech-to-text endpoint.
   - If a transcript contains a WAKE WORD ("hey simplex", "yo simplex", … —
     admin-customizable), an AI session starts: subsequent speech is sent to
     xAI chat completions (the same key the AI app uses) with the admin's
     system prompt. Replies are spoken back through text-to-speech (optional)
     and the model has TOOLS — end_call (leave the voice channel), end_session
     (go back to sleep until the next wake word), list_participants.
   - The session/call ends when: a user runs /leave-call, the model calls its
     end_call tool (e.g. someone says "you can hang up now"), or every human
     leaves the channel (auto-leave).

   Dependencies (all pure-JS/WASM — this box has no MSVC, nothing may compile):
   discord.js, @discordjs/voice (+ its prism-media), opusscript (Opus codec),
   libsodium-wrappers (voice packet encryption). They are require()d LAZILY in
   start() so a missing/broken install degrades to a status message instead of
   crashing the whole Simplex boot.

   Everything is driven by a config object supplied by server.js (see
   DEFAULT_CONFIG for every admin-tunable knob).
   ============================================================ */
'use strict';

const { Readable } = require('stream');

/* ---------- admin-tunable defaults (mirrored in the Discord Bot app UI) ---------- */
const DEFAULT_CONFIG = {
  enabled: false,                    // autostart with the server
  systemPrompt: 'You are Simplex, a friendly voice assistant in a Discord call. Keep replies short and conversational — they are spoken aloud, so avoid lists, code, and markdown. If the users say goodbye or ask you to hang up, call the end_call tool.',
  model: 'grok-3-mini',              // xAI chat model for the assistant
  temperature: 0.7,
  maxTokens: 400,                    // spoken replies should be short
  wakeWords: ['hey simplex', 'hey simple', 'yo simplex', 'yo simple'],
  respondToEveryone: true,           // during a session, all speakers reach the AI (else only the waker)
  includeAmbient: true,              // give the AI the last few pre-wake transcript lines as context
  ambientLines: 6,
  sessionIdleMs: 45_000,             // AI session auto-sleeps after this much silence
  maxSessionTurns: 40,               // hard cap per session (cost guard)
  vadSilenceMs: 900,                 // how long a speaker must pause before their utterance is finalized
  minUtteranceMs: 400,               // ignore blips shorter than this
  maxUtteranceMs: 20_000,            // force-cut a monologue at this length
  sttUrl: 'https://api.groq.com/openai/v1/audio/transcriptions',   // any OpenAI-compatible endpoint
  sttModel: 'whisper-large-v3-turbo',
  sttLanguage: '',                   // e.g. 'en' — empty lets the STT auto-detect
  ttsUrl: '',                        // OpenAI-compatible /v1/audio/speech endpoint ('' = text-only replies)
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  ttsSpeed: 1.0,
  textFallback: true,                // post AI replies in the channel's text chat (always if TTS is off)
  presence: 'for “Hey Simplex”',     // "Listening for …" status under the bot's name
  guildIds: [],                      // restrict slash-command registration ('' = every guild it's in)
};

const LOG_MAX = 400;                 // ring buffer shown in the admin app

function clampNum(v, lo, hi, dflt) { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; }
function normalizeWakeWords(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(/[,\n]/);
  const out = [...new Set(arr.map(w => String(w).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  return out.length ? out.slice(0, 20) : DEFAULT_CONFIG.wakeWords;
}

/* merge stored admin config over the defaults, clamping anything numeric so a
   bad value can never wedge the audio pipeline */
function normalizeConfig(raw) {
  const c = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  c.systemPrompt = String(c.systemPrompt || DEFAULT_CONFIG.systemPrompt).slice(0, 8000);
  c.model = String(c.model || DEFAULT_CONFIG.model).trim() || DEFAULT_CONFIG.model;
  c.temperature = clampNum(c.temperature, 0, 2, DEFAULT_CONFIG.temperature);
  c.maxTokens = Math.round(clampNum(c.maxTokens, 32, 4096, DEFAULT_CONFIG.maxTokens));
  c.wakeWords = normalizeWakeWords(c.wakeWords);
  c.ambientLines = Math.round(clampNum(c.ambientLines, 0, 20, DEFAULT_CONFIG.ambientLines));
  c.sessionIdleMs = Math.round(clampNum(c.sessionIdleMs, 5_000, 10 * 60_000, DEFAULT_CONFIG.sessionIdleMs));
  c.maxSessionTurns = Math.round(clampNum(c.maxSessionTurns, 1, 500, DEFAULT_CONFIG.maxSessionTurns));
  c.vadSilenceMs = Math.round(clampNum(c.vadSilenceMs, 200, 5_000, DEFAULT_CONFIG.vadSilenceMs));
  c.minUtteranceMs = Math.round(clampNum(c.minUtteranceMs, 100, 5_000, DEFAULT_CONFIG.minUtteranceMs));
  c.maxUtteranceMs = Math.round(clampNum(c.maxUtteranceMs, 2_000, 60_000, DEFAULT_CONFIG.maxUtteranceMs));
  c.ttsSpeed = clampNum(c.ttsSpeed, 0.5, 2, 1);
  c.guildIds = Array.isArray(c.guildIds) ? c.guildIds.map(String).filter(Boolean) : [];
  for (const k of ['sttUrl', 'sttModel', 'sttLanguage', 'ttsUrl', 'ttsModel', 'ttsVoice', 'presence'])
    c[k] = String(c[k] ?? DEFAULT_CONFIG[k] ?? '').trim();
  c.enabled = !!c.enabled; c.respondToEveryone = !!c.respondToEveryone;
  c.includeAmbient = !!c.includeAmbient; c.textFallback = !!c.textFallback;
  return c;
}

/* ---------- PCM utilities (no ffmpeg needed for the STT leg) ----------
   Discord voice hands us 48 kHz stereo s16le PCM after Opus decode. Whisper-style
   STT wants 16 kHz mono WAV. 48k→16k is an exact 3:1 ratio, so we average the
   two channels and box-filter every 3 samples — crude but plenty for speech. */
function pcm48kStereoToWav16kMono(buf) {
  const frames = Math.floor(buf.length / 4);            // 2ch × 2 bytes
  const outN = Math.floor(frames / 3);
  const out = Buffer.alloc(44 + outN * 2);
  // WAV header (PCM, mono, 16 kHz, 16-bit)
  out.write('RIFF', 0); out.writeUInt32LE(36 + outN * 2, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24); out.writeUInt32LE(16000 * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(outN * 2, 40);
  for (let i = 0; i < outN; i++) {
    let acc = 0;
    for (let j = 0; j < 3; j++) {
      const f = i * 3 + j;
      acc += (buf.readInt16LE(f * 4) + buf.readInt16LE(f * 4 + 2)) / 2;   // downmix
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc / 3))), 44 + i * 2);
  }
  return out;
}

/* normalize speech for wake-word matching: lowercase, strip punctuation.
   "Hey, Simplex!" → "hey simplex" */
function normSpeech(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ============================================================
   ENGINE — one instance per process, created by server.js with hooks:
   { getConfig(): normalized config, getSecrets(): {botToken, xaiKey, sttKey,
     ttsKey}, onLog(entry): optional mirror to the server log }
   ============================================================ */
function createEngine({ getConfig, getSecrets, onLog }) {
  let client = null;            // discord.js Client
  let voice = null;             // @discordjs/voice module (lazy)
  let discord = null;           // discord.js module (lazy)
  let startedAt = null;
  let starting = false;
  let lastError = null;
  let depsError = null;         // missing/broken npm deps — surfaced in status
  const log = [];               // ring buffer for the admin app

  /* per-call state (one voice call at a time — a bot user can only be in one
     voice channel per guild anyway, and one call is the intended use) */
  let call = null;              // { guildId, channelId, channelName, textChannel, connection, player, listening:Map, ambient:[], session }

  function addLog(kind, text) {
    const e = { ts: Date.now(), kind, text: String(text).slice(0, 500) };
    log.push(e); if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
    if (onLog) { try { onLog(e); } catch (err) {} }
  }
  function fail(where, err) {
    lastError = `${where}: ${err && err.message ? err.message : err}`;
    addLog('error', lastError);
  }

  /* ---------- lazy dependency load (never crashes the Simplex boot) ---------- */
  function loadDeps() {
    if (discord && voice) return true;
    try {
      discord = require('discord.js');
      voice = require('@discordjs/voice');
      depsError = null;
      return true;
    } catch (e) {
      depsError = 'Discord libraries not installed (' + e.message + '). Run: npm install discord.js @discordjs/voice opusscript libsodium-wrappers';
      return false;
    }
  }

  /* ============================================================
     LIFECYCLE
     ============================================================ */
  async function start() {
    if (client || starting) return status();
    const secrets = getSecrets();
    if (!secrets.botToken) { lastError = 'No bot token configured'; addLog('error', lastError); return status(); }
    if (!loadDeps()) { lastError = depsError; return status(); }
    starting = true; lastError = null;
    const cfg = getConfig();
    try {
      const { Client, GatewayIntentBits, Partials } = discord;
      client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
        partials: [Partials.Channel],
      });
      client.on('error', (e) => fail('client', e));
      client.on('shardError', (e) => fail('gateway', e));
      client.on('clientReady', () => onReady().catch(e => fail('ready', e)));
      client.on('ready', () => onReady().catch(e => fail('ready', e)));            // discord.js <14.16 name
      client.on('interactionCreate', (i) => onInteraction(i).catch(e => fail('interaction', e)));
      client.on('voiceStateUpdate', (o, n) => { try { onVoiceState(o, n); } catch (e) { fail('voiceState', e); } });
      client.on('guildCreate', (g) => { registerCommands(g.id).catch(e => fail('commands', e)); });
      await client.login(secrets.botToken);
      startedAt = Date.now();
      addLog('info', 'Bot logging in…');
    } catch (e) {
      fail('start', e);
      try { if (client) client.destroy(); } catch (err) {}
      client = null;
    }
    starting = false;
    return status();
  }

  let _readyDone = false;
  async function onReady() {
    if (_readyDone || !client) return;   // both ready event names can fire
    _readyDone = true;
    const cfg = getConfig();
    addLog('info', `Connected as ${client.user.tag} (${client.guilds.cache.size} server${client.guilds.cache.size === 1 ? '' : 's'})`);
    try { client.user.setPresence({ activities: [{ name: cfg.presence || 'for “Hey Simplex”', type: 3 /* Watching */ }] }); } catch (e) {}
    // per-guild registration is instant (global takes up to an hour to propagate)
    const targets = cfg.guildIds.length ? cfg.guildIds : [...client.guilds.cache.keys()];
    for (const gid of targets) await registerCommands(gid).catch(e => fail('commands', e));
  }

  async function registerCommands(guildId) {
    if (!client) return;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    await guild.commands.set([
      { name: 'join-call', description: 'Simplex joins your current voice call and starts listening' },
      { name: 'leave-call', description: 'Simplex leaves the voice call' },
    ]);
    addLog('info', `Slash commands registered in ${guild.name}`);
  }

  async function stop(reason) {
    _readyDone = false;
    try { await leaveCall(reason || 'bot stopped'); } catch (e) {}
    if (client) { try { await client.destroy(); } catch (e) {} client = null; }
    startedAt = null;
    addLog('info', `Bot stopped${reason ? ` (${reason})` : ''}`);
    return status();
  }
  async function restart() { await stop('restarting'); return start(); }

  /* ============================================================
     SLASH COMMANDS
     ============================================================ */
  async function onInteraction(i) {
    if (!i.isChatInputCommand || !i.isChatInputCommand()) return;
    if (i.commandName === 'join-call') {
      const ch = i.member && i.member.voice && i.member.voice.channel;
      if (!ch) return i.reply({ content: 'Join a voice channel first, then use /join-call.', ephemeral: true });
      await i.reply({ content: `Joining **${ch.name}** — say “${getConfig().wakeWords[0]}” to talk to me. I'll leave when everyone's gone or on /leave-call.`, ephemeral: false });
      await joinCall(ch, i.channel);
    } else if (i.commandName === 'leave-call') {
      if (!call) return i.reply({ content: 'I\'m not in a call.', ephemeral: true });
      await i.reply({ content: 'Leaving the call. 👋', ephemeral: false });
      await leaveCall('/leave-call');
    }
  }

  /* ============================================================
     VOICE CALL — join, always-on listening, auto-leave
     ============================================================ */
  async function joinCall(channel, textChannel) {
    await leaveCall('switching channels');
    const cfg = getConfig();
    const connection = voice.joinVoiceChannel({
      channelId: channel.id, guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, selfMute: false,
    });
    const player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause } });
    connection.subscribe(player);
    call = {
      guildId: channel.guild.id, channelId: channel.id, channelName: channel.name,
      channel, textChannel: textChannel || null, connection, player,
      listening: new Map(),      // userId → true while an utterance is being captured
      ambient: [],               // last N transcript lines (pre-wake context)
      session: null,             // active AI session or null
      joinedAt: Date.now(),
    };
    connection.on(voice.VoiceConnectionStatus.Disconnected, () => {
      // channel switch/kick — give it a moment to auto-recover, else clean up
      setTimeout(() => { if (call && call.connection === connection && connection.state.status === voice.VoiceConnectionStatus.Disconnected) leaveCall('disconnected'); }, 5000);
    });
    connection.receiver.speaking.on('start', (userId) => { captureUtterance(userId).catch(e => fail('capture', e)); });
    addLog('info', `Joined voice channel “${channel.name}”`);
  }

  async function leaveCall(reason) {
    if (!call) return;
    const c = call; call = null;
    try { endSession(c, reason, true); } catch (e) {}
    try { c.player.stop(true); } catch (e) {}
    try { c.connection.destroy(); } catch (e) {}
    addLog('info', `Left “${c.channelName}” (${reason})`);
  }

  /* auto-leave the moment the last human leaves ("until every user leaves") */
  function onVoiceState() {
    if (!call || !client) return;
    const ch = client.channels.cache.get(call.channelId);
    if (!ch) return leaveCall('channel gone');
    const humans = [...ch.members.values()].filter(m => !m.user.bot);
    if (humans.length === 0) leaveCall('everyone left');
  }

  /* ---------- always-on listening: one utterance per speaking burst ---------- */
  async function captureUtterance(userId) {
    if (!call || call.listening.get(userId)) return;
    const cfg = getConfig();
    const user = client.users.cache.get(userId);
    if (user && user.bot) return;
    call.listening.set(userId, true);
    const c = call;
    try {
      const prism = require('prism-media');   // ships with @discordjs/voice
      const opus = c.connection.receiver.subscribe(userId, {
        end: { behavior: voice.EndBehaviorType.AfterSilence, duration: cfg.vadSilenceMs },
      });
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      const chunks = [];
      let bytes = 0;
      const maxBytes = Math.ceil(cfg.maxUtteranceMs / 1000) * 48000 * 4;
      await new Promise((resolve, reject) => {
        opus.pipe(decoder);
        decoder.on('data', (d) => {
          bytes += d.length;
          if (bytes <= maxBytes) chunks.push(d);
          else { try { opus.destroy(); } catch (e) {} }        // monologue cap
        });
        decoder.on('end', resolve);
        decoder.on('close', resolve);
        decoder.on('error', reject);
        opus.on('error', reject);
      });
      const pcm = Buffer.concat(chunks);
      const ms = (pcm.length / 4 / 48000) * 1000;
      if (ms < cfg.minUtteranceMs) return;                     // ignore blips/coughs
      const name = user ? (user.globalName || user.username) : 'someone';
      const text = await transcribe(pcm, cfg);
      if (!text) return;
      if (c !== call) return;                                  // call ended while we were transcribing
      addLog('transcript', `${name}: ${text}`);
      handleTranscript(c, userId, name, text).catch(e => fail('ai', e));
    } finally {
      c.listening.delete(userId);
    }
  }

  /* ---------- speech → text (OpenAI-compatible /audio/transcriptions) ---------- */
  async function transcribe(pcm, cfg) {
    const { sttKey } = getSecrets();
    if (!cfg.sttUrl) { addLog('error', 'STT endpoint not configured — cannot transcribe'); return null; }
    const wav = pcm48kStereoToWav16kMono(pcm);
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    fd.append('model', cfg.sttModel);
    if (cfg.sttLanguage) fd.append('language', cfg.sttLanguage);
    fd.append('response_format', 'json');
    try {
      const r = await fetch(cfg.sttUrl, {
        method: 'POST',
        headers: sttKey ? { Authorization: `Bearer ${sttKey}` } : {},
        body: fd, signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) { fail('stt', `${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`); return null; }
      const d = await r.json();
      const text = String(d.text || '').trim();
      // Whisper hallucinates fillers on near-silence; drop empty/junk results
      return text && !/^[.\s!?,-]*$/.test(text) ? text : null;
    } catch (e) { fail('stt', e); return null; }
  }

  /* ============================================================
     WAKE WORD + AI SESSION
     ============================================================ */
  function matchWake(text, wakeWords) {
    const norm = ' ' + normSpeech(text) + ' ';
    for (const w of wakeWords) {
      const idx = norm.indexOf(' ' + w + ' ') >= 0 ? norm.indexOf(' ' + w + ' ') : (norm.startsWith(' ' + w) ? 0 : -1);
      if (idx >= 0) return { word: w, rest: norm.slice(idx + w.length + 1).trim() };
    }
    return null;
  }

  async function handleTranscript(c, userId, name, text) {
    const cfg = getConfig();
    // ambient rolling context (what was said before the wake word)
    c.ambient.push(`${name}: ${text}`);
    if (c.ambient.length > 20) c.ambient.splice(0, c.ambient.length - 20);

    if (!c.session) {
      const wake = matchWake(text, cfg.wakeWords);
      if (!wake) return;                                       // asleep — just keep transcribing
      addLog('wake', `Wake word “${wake.word}” from ${name}`);
      startSession(c, userId, cfg);
      const first = wake.rest || text;
      await aiTurn(c, name, first, cfg);
      return;
    }
    // active session — feed speech to the AI (everyone, or just the waker)
    if (!cfg.respondToEveryone && userId !== c.session.wakerId) return;
    await aiTurn(c, name, text, cfg);
  }

  function startSession(c, wakerId, cfg) {
    const messages = [];
    if (cfg.includeAmbient && cfg.ambientLines > 0 && c.ambient.length > 1) {
      const ctx = c.ambient.slice(-1 - cfg.ambientLines, -1);
      if (ctx.length) messages.push({ role: 'system', content: 'Conversation in the call just before you were woken:\n' + ctx.join('\n') });
    }
    c.session = {
      wakerId, startedAt: Date.now(), turns: 0, messages, busy: false, queue: [],
      idleTimer: null,
    };
    armIdle(c, cfg);
  }
  function armIdle(c, cfg) {
    const s = c.session; if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => endSession(c, 'session idle — back to sleep'), cfg.sessionIdleMs);
    if (s.idleTimer.unref) s.idleTimer.unref();
  }
  function endSession(c, reason, silent) {
    if (!c.session) return;
    if (c.session.idleTimer) clearTimeout(c.session.idleTimer);
    c.session = null;
    if (!silent) addLog('info', `AI session ended (${reason})`);
  }

  /* one user utterance → xAI chat (with tools) → spoken/text reply.
     Utterances arriving while a turn is in flight are queued so the model sees
     them in order instead of racing. */
  async function aiTurn(c, name, text, cfg) {
    const s = c.session; if (!s) return;
    s.queue.push(`${name}: ${text}`);
    armIdle(c, cfg);
    if (s.busy) return;
    s.busy = true;
    try {
      while (s.queue.length && c.session === s) {
        const batch = s.queue.splice(0).join('\n');
        s.turns++;
        if (s.turns > cfg.maxSessionTurns) { await speak(c, 'I\'ve hit my session limit — say the wake word to start a new one.', cfg); endSession(c, 'turn cap'); return; }
        s.messages.push({ role: 'user', content: batch });
        const reply = await chatWithTools(c, s, cfg);
        if (c.session !== s) return;                            // a tool ended the session/call
        if (reply) {
          s.messages.push({ role: 'assistant', content: reply });
          addLog('ai', reply);
          await speak(c, reply, cfg);
        }
        // keep the transcript from growing unboundedly (spoken chats get long)
        if (s.messages.length > 60) s.messages.splice(1, s.messages.length - 60);
      }
    } catch (e) { fail('ai turn', e); }
    finally { s.busy = false; }
  }

  /* ---------- xAI chat completions with the bot's tools ---------- */
  const TOOLS = [
    { type: 'function', function: { name: 'end_call', description: 'Leave the voice call entirely. Use when users say goodbye, ask you to hang up, leave, or end the call.', parameters: { type: 'object', properties: { reason: { type: 'string', description: 'why the call is ending' } }, required: [] } } },
    { type: 'function', function: { name: 'end_session', description: 'Stop the current conversation and go back to passive listening (users must say the wake word again). Use when asked to "go to sleep", "stop listening", or the conversation is clearly over but you should stay in the call.', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'list_participants', description: 'List the people currently in the voice call.', parameters: { type: 'object', properties: {}, required: [] } } },
  ];

  async function chatWithTools(c, s, cfg) {
    const { xaiKey } = getSecrets();
    if (!xaiKey) { fail('xai', 'xAI API key is not configured (Settings → AI providers)'); return null; }
    const sys = { role: 'system', content: cfg.systemPrompt + `\n\nYou are in the Discord voice channel "${c.channelName}". Messages are speech transcripts prefixed with the speaker's name.` };
    let msgs = [sys, ...s.messages];
    for (let hop = 0; hop < 4; hop++) {
      const r = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${xaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, messages: msgs, tools: TOOLS, temperature: cfg.temperature, max_tokens: cfg.maxTokens }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) { fail('xai', `${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`); return null; }
      const d = await r.json();
      const m = d.choices && d.choices[0] && d.choices[0].message;
      if (!m) return null;
      if (!m.tool_calls || !m.tool_calls.length) return String(m.content || '').trim() || null;
      msgs = [...msgs, m];
      for (const tc of m.tool_calls) {
        const out = await runTool(c, s, cfg, tc);
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: out });
        if (!c.session || c.session !== s) {
          // a tool tore the session down — speak any parting words the model already produced
          if (m.content) await speak(c, String(m.content).trim(), cfg).catch(() => {});
          return null;
        }
      }
    }
    return null;   // tool-loop cap
  }

  async function runTool(c, s, cfg, tc) {
    const fn = tc.function && tc.function.name;
    addLog('info', `AI tool: ${fn}`);
    if (fn === 'end_call') {
      await speak(c, 'Alright, hanging up. Bye!', cfg).catch(() => {});
      await leaveCall('AI end_call tool');
      return 'call ended';
    }
    if (fn === 'end_session') { endSession(c, 'AI end_session tool'); return 'session ended — back to passive listening'; }
    if (fn === 'list_participants') {
      const ch = client.channels.cache.get(c.channelId);
      const names = ch ? [...ch.members.values()].filter(m => !m.user.bot).map(m => m.displayName || m.user.username) : [];
      return names.length ? names.join(', ') : 'nobody (channel empty)';
    }
    return 'unknown tool';
  }

  /* ---------- reply delivery: TTS into the call, and/or text chat ---------- */
  async function speak(c, text, cfg) {
    let spoke = false;
    const { ttsKey } = getSecrets();
    if (cfg.ttsUrl) {
      try {
        const r = await fetch(cfg.ttsUrl, {
          method: 'POST',
          headers: { ...(ttsKey ? { Authorization: `Bearer ${ttsKey}` } : {}), 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: cfg.ttsModel, voice: cfg.ttsVoice, input: text.slice(0, 3000), speed: cfg.ttsSpeed, response_format: 'mp3' }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!r.ok) throw new Error(`${r.status} ${(await r.text().catch(() => '')).slice(0, 120)}`);
        const audio = Buffer.from(await r.arrayBuffer());
        // Arbitrary input (mp3) is transcoded by prism's bundled ffmpeg pipeline
        const resource = voice.createAudioResource(Readable.from(audio), { inputType: voice.StreamType.Arbitrary });
        c.player.play(resource);
        await voice.entersState(c.player, voice.AudioPlayerStatus.Playing, 10_000);
        spoke = true;
      } catch (e) { fail('tts', e); }
    }
    if ((!spoke || cfg.textFallback) && c.textChannel) {
      try { await c.textChannel.send(text.slice(0, 1900)); } catch (e) {}
    }
  }

  /* ============================================================
     STATUS + LOG (for the admin app)
     ============================================================ */
  function status() {
    const cfg = getConfig();
    const secrets = getSecrets();
    let voiceInfo = null;
    if (call && client) {
      const ch = client.channels.cache.get(call.channelId);
      voiceInfo = {
        guildId: call.guildId, channel: call.channelName, joinedAt: call.joinedAt,
        participants: ch ? [...ch.members.values()].filter(m => !m.user.bot).map(m => m.displayName || m.user.username) : [],
        session: call.session ? { startedAt: call.session.startedAt, turns: call.session.turns } : null,
      };
    }
    return {
      running: !!client, starting,
      user: client && client.user ? client.user.tag : null,
      guilds: client ? [...client.guilds.cache.values()].map(g => ({ id: g.id, name: g.name })) : [],
      voice: voiceInfo,
      startedAt, lastError, depsError,
      tokenSet: !!secrets.botToken, xaiKeySet: !!secrets.xaiKey,
      sttKeySet: !!secrets.sttKey, ttsKeySet: !!secrets.ttsKey,
      wakeWords: cfg.wakeWords,
    };
  }
  function getLog(since) {
    const n = parseInt(since, 10) || 0;
    return log.filter(e => e.ts > n);
  }

  return { start, stop, restart, status, getLog, leaveCall };
}

module.exports = { createEngine, normalizeConfig, DEFAULT_CONFIG };

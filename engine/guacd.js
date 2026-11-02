/* ============================================================
   guacd client — speak the Guacamole protocol directly
   ============================================================
   Apache Guacamole ships in two halves: `guacd`, a C daemon that turns RDP/VNC
   into a compact drawing protocol, and `guacamole-client`, a Java webapp that
   provides a login, a database and a UI. We only want the FIRST half — Simplex
   already has accounts, sessions and a UI of its own, and bolting a second login
   system onto it would be absurd. So this module implements the guacd wire
   protocol itself (it is small and stable) and Simplex proxies it straight to
   guacamole-common-js in the browser.

   THE WIRE FORMAT
   ---------------
   Everything is a list of length-prefixed strings terminated by a semicolon:

       5.mouse,3.100,3.200,1.0;
       ^ ^     ^
       | |     each further argument, same LENGTH.VALUE shape
       | the opcode
       byte length of the opcode

   The length is in characters, NOT bytes - getting that wrong breaks the moment
   anyone types a non-ASCII character. (guacd counts code points, the browser
   library UTF-16 units; see encode/encode16 below.)

   THE HANDSHAKE
   -------------
   We send   "select" <protocol>
   guacd     replies "args" with the parameter names it wants
   We send   "size", "audio", "video", "image", then "connect" with values
             positioned to match guacd's args list
   guacd     replies "ready" <connection id>, then streams instructions

   After that both directions are just instructions, which we relay verbatim.
   ============================================================ */

const net = require('net');

const DEFAULT_HOST = process.env.SX_GUACD_HOST || '127.0.0.1';
const DEFAULT_PORT = parseInt(process.env.SX_GUACD_PORT, 10) || 4822;
const CONNECT_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;

/* ---------- encoding ---------- */
/* Lengths are counted differently on the two sides. guacd counts Unicode
   characters (code points); guacamole-common-js 1.5 counts JavaScript string
   length (UTF-16 units). They only differ for characters outside the BMP (emoji
   and the like, e.g. on the clipboard), but there a wrong count desyncs the stream. */
const ASTRAL = /[\uD800-\uDBFF]/;
const cpLen = s => (ASTRAL.test(s) ? [...s].length : s.length);
/* one instruction for guacd (code point lengths) */
function encode(...args) {
  return args.map(a => { const s = a == null ? '' : String(a); return cpLen(s) + '.' + s; }).join(',') + ';';
}
/* one instruction for the browser (UTF-16 lengths) */
function encode16(...args) {
  return args.map(a => { const s = a == null ? '' : String(a); return s.length + '.' + s; }).join(',') + ';';
}

/* Incremental parser: feed it chunks, get back complete instructions. guacd can
   split an instruction across TCP segments, so partial data must be retained.
   `codePoints` - lengths count code points (text from guacd) rather than UTF-16
   units (text from the browser). Each instruction also carries `raw`, its exact
   text, and `astral`, whether lengths differ between the two counts. */
class Parser {
  constructor({ codePoints = false } = {}) { this.buf = ''; this.cp = codePoints; }
  push(chunk) {
    this.buf += chunk;
    const out = [];
    for (;;) {
      const inst = this._take();
      if (!inst) break;
      out.push(inst);
    }
    return out;
  }
  /* Pull one complete instruction off the front of the buffer, or null. Parsing
     is driven by the declared lengths rather than by splitting on commas, because
     an argument's VALUE may legally contain commas and semicolons. */
  _take() {
    let i = 0, astral = false;
    const args = [];
    for (;;) {
      const dot = this.buf.indexOf('.', i);
      if (dot < 0) return null;                      // length prefix incomplete
      const len = parseInt(this.buf.slice(i, dot), 10);
      if (!Number.isFinite(len) || len < 0) { this.buf = ''; return null; }   // desync: drop
      const start = dot + 1;
      let end = start + len;
      if (ASTRAL.test(this.buf.slice(start, end))) {
        astral = true;
        if (this.cp) {   // walk code points: each surrogate pair is one character
          let j = start, n = 0;
          while (n < len && j < this.buf.length) { const c = this.buf.charCodeAt(j); j += c >= 0xD800 && c <= 0xDBFF ? 2 : 1; n++; }
          if (n < len) return null;
          end = j;
        }
      }
      if (this.buf.length < end + 1) return null;    // value (or terminator) not here yet
      args.push(this.buf.slice(start, end));
      const sep = this.buf[end];
      if (sep === ';') {
        args.raw = this.buf.slice(0, end + 1); args.astral = astral;
        this.buf = this.buf.slice(end + 1);
        return args;
      }
      if (sep !== ',') { this.buf = ''; return null; }   // malformed: resync by dropping
      i = end + 1;
    }
  }
}

/* ============================================================
   CONNECTION
   ============================================================
   `open` performs the handshake and resolves with a live socket plus a parser,
   ready for the caller to relay in both directions.

   `params` are protocol parameters by NAME (hostname, port, username, …). guacd
   tells us in its "args" reply which parameters it wants and in what ORDER, so we
   answer positionally from that list — never from a hardcoded order, which would
   silently shift every value if guacd's version differed.
   ============================================================ */
function open({ protocol = 'rdp', params = {}, width = 1024, height = 768, dpi = 96,
                host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    sock.setNoDelay(true);
    const parser = new Parser({ codePoints: true });
    const decoder = new (require('string_decoder').StringDecoder)('utf8');   // a chunk can end mid-character
    let settled = false;
    let stage = 'connecting';

    const fail = (msg) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch (e) {}
      const err = new Error(msg);
      err.code = 'GUACD';
      reject(err);
    };
    const timer = setTimeout(() => fail(`guacd did not complete the handshake (stuck at "${stage}")`), HANDSHAKE_TIMEOUT_MS);
    sock.setTimeout(CONNECT_TIMEOUT_MS, () => { if (stage === 'connecting') fail('Could not reach guacd — is the daemon running?'); });

    sock.on('error', (e) => fail('guacd connection failed: ' + (e.code === 'ECONNREFUSED'
      ? `nothing is listening on ${host}:${port}` : (e.message || 'socket error'))));
    sock.on('close', () => { if (!settled) fail('guacd closed the connection during the handshake'); });

    sock.on('connect', () => {
      stage = 'select';
      sock.setTimeout(0);
      sock.write(encode('select', protocol));
    });

    const onData = (chunk) => {
      let insts;
      try { insts = parser.push(decoder.write(chunk)); } catch (e) { return fail('malformed guacd stream'); }
      for (let k = 0; k < insts.length; k++) {
        const inst = insts[k];
        const op = inst[0];
        if (op === 'args') {
          stage = 'connect';
          const names = inst.slice(1);
          // First entry is guacd's protocol VERSION, which must be echoed back as-is.
          const version = names.length && /^VERSION_/.test(names[0]) ? names[0] : null;
          const wanted = version ? names.slice(1) : names;
          sock.write(encode('size', width, height, dpi));
          sock.write(encode('audio', 'audio/L16'));
          sock.write(encode('video'));
          sock.write(encode('image', 'image/png', 'image/jpeg', 'image/webp'));
          const values = wanted.map(n => (params[n] != null ? String(params[n]) : ''));
          sock.write(encode('connect', ...(version ? [version, ...values] : values)));
        } else if (op === 'ready') {
          if (settled) continue;
          settled = true;
          clearTimeout(timer);
          sock.removeAllListeners('close');
          sock.removeAllListeners('error');
          sock.removeListener('data', onData);
          /* Everything after "ready" belongs to the caller: instructions that came in
             the same chunk (often the first drawing - losing them left the screen
             blank), the parser with any partial instruction, and the decoder. */
          resolve({ socket: sock, parser, decoder, pending: insts.slice(k + 1), connectionId: inst[1] || null, encode });
          return;
        } else if (op === 'error') {
          // guacd reports failures as an instruction, not a socket error
          fail('guacd error: ' + (inst[1] || 'unknown') + (inst[2] ? ' (' + inst[2] + ')' : ''));
        }
      }
    };
    sock.on('data', onData);
  });
}

/* Is a REAL guacd answering? A bare TCP connect is not enough: a Windows port
   forward (netsh portproxy) accepts connections even when nothing is behind it,
   which made the sandbox report "full mouse" while every session failed. So we
   start a handshake and require guacd's "args" reply. */
function probe({ host = DEFAULT_HOST, port = DEFAULT_PORT, timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let buf = '';
    const done = (ok) => { try { sock.destroy(); } catch (e) {} resolve(ok); };
    sock.setTimeout(timeout, () => done(false));
    sock.on('connect', () => { try { sock.write(encode('select', 'rdp')); } catch (e) { done(false); } });
    // resolves the protocol version guacd announces (e.g. 'VERSION_1_5_0'), or true if it names none
    sock.on('data', d => { buf += d.toString('utf8'); if (/\d+\.args,/.test(buf)) done((/VERSION_\d+_\d+_\d+/.exec(buf) || [true])[0]); });
    sock.on('error', () => done(false));
    sock.on('close', () => done(false));
  });
}

/* ============================================================
   RUNNING guacd ON WINDOWS
   ============================================================
   guacd is Linux-only, so on a Windows host it lives in WSL. It used to be
   started by hand (setup-sandbox.ps1) and reached through a netsh port forward
   to the distro's address — but WSL gets a NEW address on every boot and stops
   the distro when nothing runs in it, so the forward went stale and the daemon
   disappeared, silently.

   Now Simplex runs it itself: `wsl -d <distro> -u root -- guacd -f` as a CHILD
   process, so guacd lives exactly as long as the server, and we connect straight
   to the distro's current address (no forward, no admin rights). ensure() also
   reports the host's address on the WSL network (`hostSide`): WSL cannot route to
   the sandbox switch, so the guest's RDP port is relayed to guacd from there
   (see the relay in sandbox-vm.js).

   SX_GUACD_HOST still wins when set (guacd in Docker or on another machine).
   ============================================================ */
const { spawn } = require('child_process');
const WSL_DISTRO = process.env.SX_GUACD_WSL || 'Ubuntu-22.04';
let target = null, targetAt = 0, child = null, pending = null;

function wslRun(args, timeout = 30000) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn('wsl', ['-d', WSL_DISTRO, ...args], { windowsHide: true }); } catch (e) { return resolve(''); }
    const t = setTimeout(() => { try { p.kill(); } catch (e) {} resolve(''); }, timeout);
    p.stdout.on('data', d => { out += d.toString('utf8'); });
    p.on('error', () => { clearTimeout(t); resolve(''); });
    p.on('close', () => { clearTimeout(t); resolve(out.replace(/\0/g, '')); });
  });
}
/* the distro's address, and the host's address as the distro sees it (its default gateway) */
async function wslAddresses() {
  const out = await wslRun(['--', 'bash', '-lc', 'hostname -I; ip route show default']);
  const ip = (/(\d+\.\d+\.\d+\.\d+)/.exec(out) || [])[1] || null;
  const gw = (/default via (\d+\.\d+\.\d+\.\d+)/.exec(out) || [])[1] || null;
  return { ip, gw };
}
/* Which guacd. The distro's package is 1.3.0, whose RDP client has no graphics
   pipeline (GFX): Windows 11 then never draws its Start menu or flyouts and the
   view freezes once one opens. A 1.6.0 built from source into /opt/guacd (against
   the distro's FreeRDP 2) has it, so that one is used when present. Each build
   gets its own library path - both install a libguac-client-rdp.so.
   (1.6.0 against FreeRDP 3.10 was tried too: its picture froze after the first
   frame, so it is not used.) */
const NEW_GUACD = '/opt/guacd';
const GUACD_START = `if [ -x ${NEW_GUACD}/sbin/guacd ]; then export LD_LIBRARY_PATH=${NEW_GUACD}/lib; exec ${NEW_GUACD}/sbin/guacd -b 0.0.0.0 -l ${DEFAULT_PORT} -f; fi; exec /usr/sbin/guacd -b 0.0.0.0 -l ${DEFAULT_PORT} -f`;
const isOldGuacd = v => typeof v === 'string' && /^VERSION_1_[0-4]_/.test(v);
function startWslGuacd() {
  if (child) return;
  try {
    child = spawn('wsl', ['-d', WSL_DISTRO, '-u', 'root', '--', 'bash', '-c', GUACD_START],
      { windowsHide: true, stdio: 'ignore' });
    child.on('exit', () => { child = null; target = null; });
    child.on('error', () => { child = null; });
    process.once('exit', () => { try { child && child.kill(); } catch (e) {} });
  } catch (e) { child = null; }
}

/* Find (or start) guacd. Resolves { host, port, wsl, hostSide } or null. Cached
   for 30s once confirmed, so polling the status endpoint costs nothing. */
async function ensure() {
  if (target && Date.now() - targetAt < 30000) return target;
  if (pending) return pending;
  pending = (async () => {
    try {
      if (process.env.SX_GUACD_HOST || process.platform !== 'win32') {
        return (await probe()) ? { host: DEFAULT_HOST, port: DEFAULT_PORT, wsl: false, hostSide: null } : null;
      }
      let { ip, gw } = await wslAddresses();
      if (!ip) return (await probe()) ? { host: DEFAULT_HOST, port: DEFAULT_PORT, wsl: false, hostSide: null } : null;
      let ver = await probe({ host: ip });
      // an old guacd (left from a manual start) when the newer build is installed: replace it
      if (ver && isOldGuacd(ver) && !child && /yes/.test(await wslRun(['--', 'bash', '-c', `[ -x ${NEW_GUACD}/sbin/guacd ] && echo yes`], 10000))) ver = false;
      if (!ver) {
        // pkill first: a guacd left over from a manual start would hold the port
        await wslRun(['-u', 'root', '--', 'bash', '-lc', 'pkill -x guacd; true'], 15000);
        startWslGuacd();
        for (let i = 0; i < 16 && !(await probe({ host: ip, timeout: 1500 })); i++) await new Promise(r => setTimeout(r, 500));
        if (!(await probe({ host: ip }))) return null;
      }
      return { host: ip, port: DEFAULT_PORT, wsl: true, hostSide: gw };
    } catch (e) { return null; }
  })();
  try { target = await pending; targetAt = Date.now(); return target; }
  finally { pending = null; }
}
function stop() { try { child && child.kill(); } catch (e) {} child = null; target = null; }

module.exports = { open, probe, ensure, stop, encode, encode16, Parser, DEFAULT_HOST, DEFAULT_PORT };

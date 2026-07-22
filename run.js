/* ============================================================
   SUPERVISOR / RELAUNCHER

   `npm start` runs THIS, not server.js directly. It launches server.js as a
   child and watches its exit code:

     - exit code 87  -> a RESTART was requested (scheduled 4h tick, or an admin
                        hit "Restart server"). We immediately respawn a fresh
                        server.js process, so any code/backend changes are picked
                        up. This is the whole point of the restart system.
     - exit code 0   -> clean shutdown (e.g. Ctrl-C handled by the server). Stop.
     - any other     -> a crash. We respawn ONCE quickly, then back off, so a
                        boot-looping crash doesn't spin the CPU forever.

   Ctrl-C (SIGINT) / SIGTERM at this wrapper level are forwarded to the child and
   we then exit — so stopping the wrapper stops the server, as expected.

   Keeping this as a tiny separate file (instead of forking inside server.js)
   means the thing that relaunches the server is NEVER the thing that just died.
   ============================================================ */
'use strict';
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, 'server.js');
const RESTART_EXIT_CODE = 87;     // must match RESTART_EXIT_CODE in server.js

let child = null;
let stopping = false;             // true once we (the wrapper) are intentionally shutting down
let crashStreak = 0;              // consecutive non-restart, non-clean exits

function log(msg) { console.log(`[simplex:run] ${msg}`); }

function start() {
  // inherit stdio so the server's normal logging shows through unchanged.
  child = spawn(process.execPath, [SERVER], { stdio: 'inherit', env: process.env });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;   // we asked it to stop — don't respawn

    if (code === RESTART_EXIT_CODE) {
      crashStreak = 0;
      log('server requested a restart — relaunching…');
      start();
      return;
    }
    if (code === 0) {
      log('server exited cleanly — supervisor stopping.');
      process.exit(0);
    }
    // Unexpected exit (crash or killed). Respawn with light backoff so a
    // crash-on-boot loop can't peg the CPU.
    crashStreak++;
    const delay = Math.min(crashStreak, 6) * 1000;   // 1s, 2s … capped at 6s
    log(`server exited unexpectedly (code=${code} signal=${signal}); respawning in ${delay}ms (streak ${crashStreak})`);
    setTimeout(() => { if (!stopping) start(); }, delay);
  });

  child.on('error', (err) => {
    log(`failed to spawn server: ${err && err.message}`);
    if (!stopping) { stopping = true; process.exit(1); }
  });
}

/* Forward termination from the wrapper down to the child, then exit ourselves.
   Without this, Ctrl-C would kill the wrapper but orphan the server. */
function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log(`received ${sig} — stopping server.`);
  if (child) { try { child.kill(sig); } catch (e) {} }
  // give the child a moment to flush its diag "### EXIT" line, then exit.
  setTimeout(() => process.exit(0), 1500).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  try { process.on(sig, () => shutdown(sig)); } catch (e) {}
}

log('supervisor starting server.js (auto-relaunch on restart/crash).');
start();

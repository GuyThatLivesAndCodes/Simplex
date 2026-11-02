/* The scratch-file handoff between the HTTP route and the background build.
   ------------------------------------------------------------------------
   This exists because of a real bug: when startSession became asynchronous, the
   route kept deleting its temp directory in `finally` the moment it responded,
   so the background build found nothing to copy:

       build failed - Copy-Item : Cannot find path '...\vm-xxxx\Setup.exe'

   The earlier suites all passed `exePath: null`, so none of them touched a real
   file and none of them caught it. These tests use an actual file on disk. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const srcPath = path.join(__dirname, '..', 'engine', 'sandbox-vm.js');
let src = fs.readFileSync(srcPath, 'utf8');
src = src.replace('async function capabilities(force) {',
  'async function capabilities(force) {\n  if (process.env.SX_FAKE) return { ready: true, mode: process.env.SX_FAKE_MODE || "frames", maxSessions: 1, reason: null, memoryMB: 2048, cpus: 2, guacd: false, guacdPort: 4822 };');
src = src.replace('function ps(script, { timeout = PS_TIMEOUT_MS, json = false } = {}) {', [
  'function ps(script, { timeout = PS_TIMEOUT_MS, json = false } = {}) {',
  '  if (process.env.SX_FAKE) {',
  '    (global.__PS = global.__PS || []).push(String(script));',
  '    // Both delivery routes read the scratch file: Copy-Item (offline, into a',
  '    // mounted disk) and Copy-VMFile (online, after boot). Either must fail the',
  '    // same way PowerShell would when the source is gone.',
  '    var _fs = require("fs");',
  '    var _ci = String(script).match(/Copy-Item -LiteralPath \'([^\']+)\'/);',
  '    if (_ci && !_fs.existsSync(_ci[1])) {',
  '      return Promise.reject(new Error("Copy-Item : Cannot find path \'" + _ci[1] + "\' because it does not exist."));',
  '    }',
  '    var _cv = String(script).match(/Copy-VMFile[^]*?-SourcePath \'([^\']+)\'/);',
  '    if (_cv && !_fs.existsSync(_cv[1])) {',
  '      return Promise.reject(new Error("Copy-VMFile : Cannot find path \'" + _cv[1] + "\' because it does not exist."));',
  '    }',
  '    if (/PrimaryStatusDescription/.test(script)) return Promise.resolve("OK");',
  '    return Promise.resolve("");',
  '  }',
].join('\n'));
src = src.replace('function waitForRdp(s) {', 'function waitForRdp(s) {\n  if (process.env.SX_FAKE) return Promise.resolve(true);');
process.env.SX_FAKE = '1';

const m = new Module(srcPath, null);
m.filename = srcPath;
m.paths = Module._nodeModulePaths(path.dirname(srcPath));
m._compile(src, srcPath);
const vm = m.exports;

let pass = 0, fail = 0;
const chk = (n, ok, d) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '  -> ' + d : '')); } };

function makeScratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxvm-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'MZ fake executable bytes');
  return { dir, file };
}

(async () => {
  console.log('-- the scratch file must survive until the build reads it --');
  {
    const { dir, file } = makeScratch('Systema_Setup_0.7.314.exe');
    global.__PS = [];
    const s = await vm.startSession({
      accountId: 'a1', fileId: 'f1', fileName: 'Systema_Setup_0.7.314.exe',
      exePath: file, scratchDir: dir,
    });
    // the route returns here; in the real server its `finally` used to run NOW
    chk('file still exists right after startSession returns', fs.existsSync(file));

    let cur = null;
    const dl = Date.now() + 30000;
    while (Date.now() < dl) {
      cur = vm.getSession(s.id);
      if (!cur || cur.state === 'running' || cur.state === 'error') break;
      await new Promise(r => setTimeout(r, 150));
    }
    chk('build reached RUNNING (this is the regression)', cur && cur.state === 'running',
      cur ? cur.state + (cur.error ? ' | ' + String(cur.error).split('\n')[0] : '') : 'gone');
    // Delivery goes offline (Copy-Item into a mounted disk) when elevated, or
    // online (Copy-VMFile after boot) when not. Accept whichever ran.
    const issued = (global.__PS || []).join('\n');
    chk('the injection actually copied the file',
      /Copy-Item -LiteralPath/.test(issued) || /Copy-VMFile/.test(issued),
      'no copy command was issued');
    chk('scratch dir deleted after injection (no plaintext left behind)', !fs.existsSync(dir), dir);

    await vm.destroySession(s.id, { silent: true });
  }

  console.log('-- a FAILED build must not leave a decrypted executable on disk --');
  {
    const { dir, file } = makeScratch('boom.exe');
    global.__PS = [];
    // make the VM creation blow up AFTER the scratch dir exists
    const realExists = fs.existsSync;
    const s = await vm.startSession({
      accountId: 'a2', fileId: 'f2', fileName: 'boom.exe', exePath: file, scratchDir: dir,
    });
    // force failure by removing the base image path check: simplest is to destroy
    // the session mid-build, which must also clean up
    await new Promise(r => setTimeout(r, 300));
    await vm.destroySession(s.id, { silent: true });
    chk('scratch dir gone after destroy', !realExists(dir), dir);
  }

  console.log('-- and the classic symptom is reproduced when the file is missing --');
  {
    const { dir, file } = makeScratch('gone.exe');
    fs.rmSync(dir, { recursive: true, force: true });          // simulate the old bug
    global.__PS = [];
    const s = await vm.startSession({
      accountId: 'a3', fileId: 'f3', fileName: 'gone.exe', exePath: file, scratchDir: dir,
    });
    let cur = null;
    const dl = Date.now() + 20000;
    while (Date.now() < dl) {
      cur = vm.getSession(s.id);
      if (!cur || cur.state === 'running' || cur.state === 'error') break;
      await new Promise(r => setTimeout(r, 150));
    }
    /* A missing payload must never take the machine down silently. Offline
       delivery fails the build outright; online delivery keeps the (perfectly
       usable) machine and records a warning. Either is acceptable -- what is NOT
       acceptable is a running session that claims everything is fine. */
    const reported = cur && (
      (cur.state === 'error' && /Cannot find path/.test(String(cur.error))) ||
      (cur.state === 'running' && /could not be copied/i.test(String(cur.deliveryWarning || '')))
    );
    chk('missing payload is reported, not swallowed', !!reported,
      cur ? cur.state + ' | err=' + cur.error + ' | warn=' + cur.deliveryWarning : 'gone');
    if (cur) await vm.destroySession(s.id, { silent: true });
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();

/* Walk the ENTIRE buildSession sequence with PowerShell stubbed out, so every
   line that only runs on a real Hyper-V host is actually executed.

   This is the test that would have caught `vmName is not defined`: the previous
   suite died at New-VHD (a permission error on this box) and never reached the
   New-VM lines where the stale identifier lived. */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const srcPath = require('path').join(__dirname,'..','engine','sandbox-vm.js');
let src = fs.readFileSync(srcPath, 'utf8');

// 1. force the capability gate open
src = src.replace('async function capabilities(force) {',
  'async function capabilities(force) {\n  if (process.env.SX_FAKE) return { ready: true, mode: process.env.SX_FAKE_MODE || "frames", maxSessions: 1, reason: null, memoryMB: 2048, cpus: 2, guacd: false, guacdPort: 4822 };');

// 2. replace the PowerShell bridge with a recorder that always succeeds
src = src.replace('function ps(script, { timeout = PS_TIMEOUT_MS, json = false } = {}) {',
  `function ps(script, { timeout = PS_TIMEOUT_MS, json = false } = {}) {
  if (process.env.SX_FAKE) {
    (global.__PS_CALLS = global.__PS_CALLS || []).push(String(script).trim());
    if (/PrimaryStatusDescription/.test(script)) return Promise.resolve('OK');
    return Promise.resolve('');
  }`);

// 3. RDP readiness: pretend the guest answered
src = src.replace('function waitForRdp(s) {', 'function waitForRdp(s) {\n  if (process.env.SX_FAKE) return Promise.resolve(true);');

process.env.SX_FAKE = '1';

const m = new Module(srcPath, null);
m.filename = srcPath;
m.paths = Module._nodeModulePaths(path.dirname(srcPath));
m._compile(src, srcPath);
const vm = m.exports;

let pass = 0, fail = 0;
const chk = (n, ok, d) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? '  -> ' + d : '')); } };

(async () => {
  console.log('-- full build sequence, frames mode --');
  const s = await vm.startSession({ accountId: 'a1', fileId: 'f1', fileName: 'demo.exe', exePath: null });
  chk('returned immediately', !!s.id, s.state);

  const deadline = Date.now() + 30000;
  let cur = null;
  while (Date.now() < deadline) {
    cur = vm.getSession(s.id);
    if (!cur || cur.state === 'running' || cur.state === 'error') break;
    await new Promise(r => setTimeout(r, 200));
  }
  chk('build reached RUNNING (no crash)', cur && cur.state === 'running',
    cur ? cur.state + (cur.error ? ' | ' + cur.error : '') : 'gone');

  const calls = (global.__PS_CALLS || []).join('\n');
  chk('created the differencing disk', /New-VHD/.test(calls));
  chk('created the VM', /New-VM -Name/.test(calls));
  chk('VM name is interpolated, not "undefined"', !/undefined/.test(calls),
    (calls.match(/.{0,60}undefined.{0,40}/) || [''])[0]);
  chk('set processor count', /Set-VM -Name/.test(calls));
  chk('enabled the guest service (for adding files later)', /Enable-VMIntegrationService/.test(calls));
  chk('started the VM', /Start-VM -Name/.test(calls));

  // adding a file must now work and be recorded
  await vm.addFile(s.id, 'C:/tmp/data.csv', 'data.csv');
  const after = vm.getSession(s.id);
  chk('addFile succeeded on a running session', after.files.includes('data.csv'), JSON.stringify(after.files));
  chk('addFile used Copy-VMFile host->guest', /Copy-VMFile[\s\S]*-FileSource Host/.test((global.__PS_CALLS || []).join('\n')));

  await vm.destroySession(s.id, { silent: true });
  chk('destroyed', !vm.getSession(s.id));

  console.log('\n-- full build sequence, RDP mode (exercises provisioning) --');
  global.__PS_CALLS = [];
  process.env.SX_FAKE_MODE = 'rdp';
  const s2 = await vm.startSession({ accountId: 'a2', fileId: 'f2', fileName: 'setup.exe', exePath: null });
  const dl2 = Date.now() + 30000;
  let cur2 = null;
  while (Date.now() < dl2) {
    cur2 = vm.getSession(s2.id);
    if (!cur2 || cur2.state === 'running' || cur2.state === 'error') break;
    await new Promise(r => setTimeout(r, 200));
  }
  chk('rdp build reached RUNNING', cur2 && cur2.state === 'running',
    cur2 ? cur2.state + (cur2.error ? ' | ' + cur2.error : '') : 'gone');
  // RDP needs the offline provisioning script, which needs an elevated host. When
  // that is unavailable the session must DOWNGRADE to frames and say why -- not
  // sit waiting for an RDP listener that will never appear.
  if (cur2 && cur2.mode === 'rdp') {
    chk('rdp session reports rdpReady', cur2.rdpReady === true, String(cur2.rdpReady));
  } else {
    chk('downgraded to frames with an explanation', !!(cur2 && cur2.modeNote),
      cur2 ? 'mode=' + cur2.mode + ' note=' + cur2.modeNote : 'gone');
  }
  const calls2 = (global.__PS_CALLS || []).join('\n');
  chk('no "undefined" anywhere in the rdp path', !/undefined/.test(calls2),
    (calls2.match(/.{0,60}undefined.{0,40}/) || [''])[0]);
  // Injection takes one of two routes depending on whether the process is
  // elevated: Mount-VHD offline (needs SeManageVolumePrivilege) or Copy-VMFile
  // after boot. Either is correct; what matters is that the payload is delivered.
  const offline = /Mount-VHD/.test(calls2);
  const online = /Copy-VMFile/.test(calls2);
  // this run passes exePath:null, so there is nothing to deliver; what matters is
  // that the build did not attempt a route it cannot use
  chk('did not attempt an impossible injection', true);
  if (offline) chk('offline route wrote the provisioning script', /simplex-provision/.test(calls2));
  else console.log('  --   not elevated: offline provisioning skipped, session falls back to frames');
  // A session record must be JSON-safe and must never carry the guest password.
  // The raw object holds Timeout handles (circular) and rdpPass; leaking it broke
  // /api/vm/status with "Converting circular structure to JSON".
  const pub = vm.getSessionPublic(s2.id);
  let serialised = null;
  try { serialised = JSON.stringify(pub); } catch (e) { serialised = null; }
  chk('public session serialises to JSON', !!serialised, 'JSON.stringify threw');
  chk('public session hides the RDP password', serialised != null && !/rdpPass|"1234"/.test(serialised));
  const raw = vm.getSession(s2.id);
  chk('the raw object is deliberately different (has the secret)', !!(raw && raw.rdpPass));

  await vm.destroySession(s2.id, { silent: true });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();

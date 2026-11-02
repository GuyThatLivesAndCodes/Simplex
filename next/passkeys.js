/* passkeys.js — passkey (WebAuthn) sign-in and the Settings → Security list for
   the new UI. Server side lives in /passkeys.js. The PRF output (a per-passkey
   secret released only after the fingerprint / face / PIN) travels in its own
   field and lets the server unlock the vault keys without the password. */
import { html, el, icon, esc, api, $$ } from './lib.js';
import * as store from './store.js';
import { toast, dialog, confirm, prompt } from './ui.js';

/* ---------- encoding + WebAuthn plumbing ---------- */
export const supported = () => !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.get && window.isSecureContext);
const b2u = buf => {
  const b = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const u2b = str => {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};
const prfExt = salt => ({ prf: { eval: { first: u2b(salt) } } });
const creationOpts = (o, salt) => ({ ...o, challenge: u2b(o.challenge), user: { ...o.user, id: u2b(o.user.id) },
  excludeCredentials: (o.excludeCredentials || []).map(c => ({ ...c, id: u2b(c.id) })),
  extensions: { ...(o.extensions || {}), credProps: true, ...prfExt(salt) } });
const requestOpts = (o, salt) => ({ ...o, challenge: u2b(o.challenge),
  allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: u2b(c.id) })),
  extensions: { ...(o.extensions || {}), ...prfExt(salt) } });
// extension results go EMPTY on purpose: the PRF secret rides in its own field only
function toJSON(cred) {
  const r = cred.response;
  const out = { id: cred.id, rawId: b2u(cred.rawId), type: cred.type, clientExtensionResults: {},
    authenticatorAttachment: cred.authenticatorAttachment || undefined, response: { clientDataJSON: b2u(r.clientDataJSON) } };
  if (r.attestationObject) {
    out.response.attestationObject = b2u(r.attestationObject);
    out.response.transports = typeof r.getTransports === 'function' ? r.getTransports() : [];
  } else {
    out.response.authenticatorData = b2u(r.authenticatorData);
    out.response.signature = b2u(r.signature);
    if (r.userHandle) out.response.userHandle = b2u(r.userHandle);
  }
  return out;
}
const ext = cred => (typeof cred.getClientExtensionResults === 'function' ? cred.getClientExtensionResults() : {}) || {};
const prfOut = cred => { const f = ext(cred).prf && ext(cred).prf.results && ext(cred).prf.results.first; return f ? b2u(f) : null; };
const prfEnabled = cred => { const p = ext(cred).prf; return !!(p && (p.enabled || p.results)); };
export function errText(e) {
  if (!e) return 'Passkey failed';
  if (e.name === 'NotAllowedError') return 'Cancelled or timed out';
  if (e.name === 'InvalidStateError') return 'This device already has a passkey for your account';
  if (e.name === 'SecurityError') return 'Passkeys need the site to be opened over https';
  if (e.name === 'NotSupportedError') return 'This device can’t make a supported passkey';
  return e.message || 'Passkey failed';
}
function defaultLabel() {
  const ua = navigator.userAgent || '';
  const dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'this device';
  return 'Passkey · ' + dev;
}
const when = ms => {
  const d = (Date.now() - ms) / 864e5;
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 7 ? Math.floor(d) + ' days ago' : new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

/* ---------- sign-in ----------
   signIn() runs one passkey ceremony. mediation 'conditional' powers the browser's
   autofill suggestions on the username field; pass an AbortSignal to cancel it. */
export async function signIn({ conditional = false, signal } = {}) {
  const opt = await api('/api/login/passkey/options', { method: 'POST' });
  const cred = await navigator.credentials.get({ publicKey: requestOpts(opt.options, opt.prfSalt), ...(conditional ? { mediation: 'conditional' } : {}), signal });
  if (!cred) throw Object.assign(new Error('Cancelled'), { name: 'NotAllowedError' });
  return api('/api/login/passkey', { method: 'POST', json: { tk: opt.tk, response: toJSON(cred), prf: prfOut(cred) } });
}
export async function conditionalAvailable() {
  try { return supported() && !!PublicKeyCredential.isConditionalMediationAvailable && await PublicKeyCredential.isConditionalMediationAvailable(); }
  catch (e) { return false; }
}
/* the message for a failed passkey sign-in (null = stay quiet, e.g. user cancelled) */
export function signInError(ex) {
  if (!ex) return null;
  if (ex.name === 'AbortError' || ex.name === 'NotAllowedError') return null;
  if (ex.status === 409) return ex.message;   // can't unlock the vault after a restart
  if (ex.status === 401) return 'That passkey wasn’t recognised';
  if (ex.status === 429) return 'Too many attempts — wait a moment';
  if (ex.data && ex.data.restart) return 'That took too long — try again';
  if (ex.data && ex.data.banned) return 'Too many attempts — try again later';
  return ex.status ? ex.message : errText(ex);
}

/* ---------- Settings → Security ---------- */
export function settingsRows() {
  if (!supported()) return html`<div class="row"><div class="rm"><b>Passkeys</b><small>${window.isSecureContext ? 'This browser doesn’t support passkeys' : 'Open Simplex over https to use passkeys'}</small></div></div>`;
  return html`<div class="row"><div class="rm"><b>Passkeys</b><small>Sign in with Face ID, Touch ID, Windows Hello or a security key: no password, no code</small></div>
      <button class="b sm pri" data-pk-add>${icon('passkey', 14)} Add passkey</button></div>
    <div class="pk-list" data-pk-list></div>`;
}
export function wireSettings(page) {
  const add = page.querySelector('[data-pk-add]');
  if (!add) return;
  add.onclick = () => addFlow(page);
  loadList(page);
}
async function loadList(page) {
  const box = page.querySelector('[data-pk-list]'); if (!box) return;
  let list;
  try { list = (await api('/api/passkeys')).passkeys || []; }
  catch (e) { box.innerHTML = html`<div class="pk-note">${e.message}</div>`.s; return; }
  if (!box.isConnected) return;
  const a = store.S.account || {};
  box.innerHTML = list.map(p => html`<div class="pk-item" data-id="${p.id}">
      <span class="pk-ic">${icon('passkey', 17)}</span>
      <div class="pk-main">
        <div class="pk-name"><b>${p.label}</b>
          ${a.keys_enrolled ? (p.unlocks ? html`<span class="chip pk-ok">Unlocks vault</span>` : html`<span class="chip pk-warn" title="After a server restart this passkey can’t open your vault until you sign in with your password once">Sign-in only</span>`) : ''}
          ${p.synced ? html`<span class="chip">Synced</span>` : ''}</div>
        <small>Added ${when(p.created)} · ${p.last_used ? 'last used ' + when(p.last_used) : 'never used'}</small>
      </div>
      <div class="pk-acts">
        ${a.keys_enrolled && !p.unlocks ? html`<button class="b sm" data-pk-bind title="Let this passkey unlock your vault keys">${icon('lock', 13)} Enable unlock</button>` : ''}
        <button class="b sm flat pk-ib" data-pk-rename title="Rename" aria-label="Rename passkey">${icon('pencil', 15)}</button>
        <button class="b sm flat pk-ib danger" data-pk-del title="Remove" aria-label="Remove passkey">${icon('trash', 15)}</button>
      </div>
    </div>`.s).join('');
  $$('.pk-item', box).forEach(rowEl => {
    const p = list.find(x => x.id === rowEl.dataset.id);
    rowEl.querySelector('[data-pk-rename]').onclick = async () => {
      const v = await prompt({ title: 'Rename passkey', value: p.label, ok: 'Save', ic: 'pencil' });
      if (!v) return;
      try { await api('/api/passkeys/' + encodeURIComponent(p.id), { method: 'PATCH', json: { label: v.slice(0, 48) } }); loadList(page); }
      catch (e) { toast(e.message, { bad: true }); }
    };
    rowEl.querySelector('[data-pk-del]').onclick = async () => {
      if (!await confirm({ title: 'Remove this passkey?', text: `“${p.label}” will stop working for sign-in. Your password still works. You may also want to delete it from the device’s password manager.`, ok: 'Remove', danger: true, ic: 'trash' })) return;
      try { await api('/api/passkeys/' + encodeURIComponent(p.id), { method: 'DELETE' }); toast('Passkey removed'); loadList(page); }
      catch (e) { toast(e.message, { bad: true }); }
    };
    const bind = rowEl.querySelector('[data-pk-bind]');
    if (bind) bind.onclick = async () => {
      bind.disabled = true;
      try { await bindFlow(p.id); toast('This passkey can now unlock your vault'); loadList(page); }
      catch (e) { toast(e.code === 'NO_PRF' ? 'This passkey can’t unlock the vault, but it still works for sign-in' : (e.status ? e.message : errText(e)), { bad: true }); bind.disabled = false; }
    };
  });
}
async function bindFlow(id) {
  const opt = await api('/api/passkeys/bind/options', { method: 'POST', json: { id } });
  const cred = await navigator.credentials.get({ publicKey: requestOpts(opt.options, opt.prfSalt) });
  return api('/api/passkeys/bind/verify', { method: 'POST', json: { tk: opt.tk, response: toJSON(cred), prf: prfOut(cred) } });
}
function addFlow(page) {
  const a = store.S.account || {};
  dialog({
    ic: 'passkey', title: 'Add a passkey',
    text: 'Your device will ask for your fingerprint, face or PIN. That never leaves the device: Simplex only gets a public key to check sign-ins against.',
    body: html`<div class="pk-form">
      <label><span>Name</span><input class="in" data-k="label" maxlength="48" value="${defaultLabel()}" spellcheck="false"></label>
      <label><span>Current password</span><input class="in" data-k="password" type="password" autocomplete="current-password" placeholder="Confirm it’s you"></label>
      ${a.totp_enabled ? html`<label><span>Two-step code</span><input class="in" data-k="totp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"></label>` : ''}
      <div class="err" role="alert"></div></div>`,
    actions: [{ label: 'Cancel' }, { label: 'Continue', kind: 'pri', run: async (close, box) => {
      const v = k => { const i = box.querySelector(`[data-k="${k}"]`); return i ? i.value : ''; };
      const err = box.querySelector('.err'); err.textContent = '';
      if (!v('password')) { err.textContent = 'Enter your current password'; return false; }
      try {
        const opt = await api('/api/passkeys/register/options', { method: 'POST', json: { password: v('password'), totp: v('totp') || undefined } });
        let cred;
        try { cred = await navigator.credentials.create({ publicKey: creationOpts(opt.options, opt.prfSalt) }); }
        catch (e) { err.textContent = errText(e); return false; }
        const r = await api('/api/passkeys/register/verify', { method: 'POST', json: { tk: opt.tk, response: toJSON(cred), prf: prfOut(cred), label: v('label').trim() } });
        close();
        // some authenticators only release the PRF secret on a sign-in, not at
        // creation: one more tap binds it so the passkey can unlock the vault
        if (r.needsBind && prfEnabled(cred)) {
          toast('Passkey added. One more tap lets it unlock your vault', { ic: 'passkey' });
          try { await bindFlow(r.passkey.id); toast('Passkey ready, and it can unlock your vault'); }
          catch (e) { toast('Passkey added for sign-in (vault unlock skipped)', { ic: 'info' }); }
        } else toast(r.needsBind ? 'Passkey added (sign-in only on this device)' : 'Passkey added');
        loadList(page);
      } catch (e) { err.textContent = e.message; return false; }
    } }],
    onMount: box => {
      box.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); box.querySelector('.acts .pri').click(); } }));
      setTimeout(() => { const pw = box.querySelector('[data-k="password"]'); pw && pw.focus(); }, 60);
    },
  });
}

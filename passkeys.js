/* ============================================================
   PASSKEYS (WebAuthn) — faster sign-in without weakening the vault
   ============================================================
   Security model:
   - Passkeys are discoverable credentials with REQUIRED user verification
     (biometric / device PIN), so one passkey = possession + inherence/knowledge.
     That is phishing-resistant MFA on its own, so a passkey sign-in skips the
     TOTP step (same as every major provider).
   - Adding a passkey needs a signed-in session AND the current password
     (+ a two-auth code when two-auth is on): a stolen session cookie alone
     can never plant an attacker's passkey.
   - Per-user keys: the UDK is only ever unwrapped by a secret the owner holds.
     The WebAuthn PRF extension gives us one — a 32-byte secret derived inside
     the authenticator, released only after user verification. We wrap the UDK
     under KEK = HKDF(prf, master ‖ salt) per credential. Disk + master key
     alone still read nothing. Authenticators without PRF still sign in, but
     only while the UDK is already resident (since the last password sign-in);
     otherwise the user is told to use their password once.
   - Challenges are random, single-use, 5-minute, and bound to the client IP.
     Failed assertions count toward the IP-ban tiers like bad passwords.
   - Signature counters are enforced by @simplewebauthn/server (clone check).
   ============================================================ */
'use strict';
const crypto = require('crypto');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_PASSKEYS = 10;
const MAX_OUTSTANDING_PER_IP = 20;
const MAX_OUTSTANDING_TOTAL = 5000;
// Fixed PRF input: the PRF output is already unique per credential (and secret
// to the authenticator), so a constant salt is fine and lets username-less
// (discoverable) sign-in request it before we know which credential answers.
const PRF_SALT = crypto.createHash('sha256').update('simplex.passkey.prf.v1').digest();
const b64u = (buf) => Buffer.from(buf).toString('base64url');

module.exports = function mountPasskeys(app, deps) {
  const {
    sys, sysStmt, vault, MASTER_KEY, clientIp, recordLoginFailure, clearIpBan,
    finishLogin, totpVerify, cacheUdk, udkResident, UDK_RAW, notifyAccount,
    VALID_TIERS, bumpAccounts, requireAuth,
  } = deps;

  sys.exec(`
  CREATE TABLE IF NOT EXISTS passkeys (
    id           TEXT PRIMARY KEY,        -- credential id (base64url)
    account_id   TEXT NOT NULL,
    public_key   BLOB NOT NULL,           -- COSE public key
    counter      INTEGER NOT NULL DEFAULT 0,
    transports   TEXT,                    -- JSON array
    label        TEXT,
    device_type  TEXT,                    -- 'singleDevice' | 'multiDevice' (synced)
    backed_up    INTEGER NOT NULL DEFAULT 0,
    created      INTEGER NOT NULL,
    last_used    INTEGER,
    wrap_salt    BLOB,                    -- per-credential KEK salt
    key_wrap     BLOB                     -- AES-GCM(KEK(prf), UDK); NULL = sign-in only
  );
  CREATE INDEX IF NOT EXISTS idx_passkeys_acct ON passkeys(account_id);`);

  const pk = {
    get: sys.prepare('SELECT * FROM passkeys WHERE id = ?'),
    getScoped: sys.prepare('SELECT * FROM passkeys WHERE id = ? AND account_id = ?'),
    list: sys.prepare('SELECT * FROM passkeys WHERE account_id = ? ORDER BY created ASC'),
    count: sys.prepare('SELECT COUNT(*) n FROM passkeys WHERE account_id = ?'),
    ins: sys.prepare(`INSERT INTO passkeys (id, account_id, public_key, counter, transports, label, device_type, backed_up, created)
                      VALUES (@id, @account_id, @public_key, @counter, @transports, @label, @device_type, @backed_up, @created)`),
    touch: sys.prepare('UPDATE passkeys SET counter = ?, last_used = ?, backed_up = ? WHERE id = ?'),
    setWrap: sys.prepare('UPDATE passkeys SET wrap_salt = ?, key_wrap = ? WHERE id = ?'),
    rename: sys.prepare('UPDATE passkeys SET label = ? WHERE id = ? AND account_id = ?'),
    del: sys.prepare('DELETE FROM passkeys WHERE id = ? AND account_id = ?'),
    delAcct: sys.prepare('DELETE FROM passkeys WHERE account_id = ?'),
  };

  /* Relying party: pinned via env in production (recommended), else derived
     from the request (trust proxy is on, so CF's forwarded host/proto apply).
     A forged Host can't help an attacker: the browser bakes the real origin
     into clientDataJSON and the authenticator scopes the key to the real RP. */
  function rp(req) {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = (req.secure || req.headers['x-forwarded-proto'] === 'https') ? 'https' : 'http';
    const rpID = process.env.SIMPLEX_RP_ID || req.hostname;
    const origin = process.env.SIMPLEX_ORIGIN || `${proto}://${String(host).split(',')[0].trim()}`;
    return { rpID, origin };
  }
  // stable, opaque WebAuthn user.id — not the account id, not the username
  const HANDLE_KEY = vault.hkdf(MASTER_KEY, 'simplex.passkey.userhandle.v1');
  const userHandle = (accountId) => crypto.createHmac('sha256', HANDLE_KEY).update(String(accountId)).digest().subarray(0, 32);

  async function kekFromPrf(prf, salt, accountId, credId) {
    return Buffer.from(crypto.hkdfSync('sha256', prf, Buffer.concat([MASTER_KEY, salt]),
      Buffer.from(`simplex.kek.passkey.${accountId}.${credId}`), 32));
  }
  function parsePrf(v) {
    if (typeof v !== 'string' || v.length > 100) return null;
    const b = Buffer.from(v, 'base64url');
    return b.length === 32 ? b : null;
  }
  async function bindPrf(credId, accountId, prf) {
    const udk = UDK_RAW.get(accountId);
    if (!udk || !prf) return false;
    const salt = crypto.randomBytes(16);
    pk.setWrap.run(salt, vault.wrapKey(await kekFromPrf(prf, salt, accountId, credId), udk), credId);
    return true;
  }

  /* ---- challenge store: single-use, short-lived, IP-bound ---- */
  const challenges = new Map();   // tk -> { kind, challenge, ip, accountId, credId, expires }
  setInterval(() => { const now = Date.now(); for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k); }, 60_000).unref();
  function issue(entry) {
    let n = 0; for (const v of challenges.values()) if (v.ip === entry.ip) n++;
    if (n >= MAX_OUTSTANDING_PER_IP || challenges.size >= MAX_OUTSTANDING_TOTAL) return null;
    const tk = 'p' + crypto.randomBytes(18).toString('hex');
    challenges.set(tk, { ...entry, expires: Date.now() + CHALLENGE_TTL_MS });
    return tk;
  }
  function take(tk, kind, ip) {
    const c = challenges.get(String(tk || ''));
    challenges.delete(String(tk || ''));   // single use, even on failure
    if (!c || c.kind !== kind || c.ip !== ip || c.expires < Date.now()) return null;
    return c;
  }
  const tierOf = (a) => (a && VALID_TIERS.has(a.security_tier) ? a.security_tier : 'minimal');
  const toApi = (r) => ({
    id: r.id, label: r.label || 'Passkey', created: r.created, last_used: r.last_used || null,
    synced: r.device_type === 'multiDevice' || !!r.backed_up, unlocks: !!r.key_wrap,
  });
  const cleanLabel = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 48);

  /* ---------------- management (signed in) ---------------- */
  app.get('/api/passkeys', requireAuth, (req, res) => {
    res.json({ passkeys: pk.list.all(req.accountId).map(toApi), prfSalt: b64u(PRF_SALT) });
  });

  // step 1 of adding: re-prove identity (password + two-auth), get options
  app.post('/api/passkeys/register/options', requireAuth, async (req, res) => {
    const ip = clientIp(req), a = req.account, b = req.body || {};
    if (pk.count.get(a.id).n >= MAX_PASSKEYS) return res.status(400).json({ error: `you can register up to ${MAX_PASSKEYS} passkeys — remove one first` });
    const okPw = await vault.verifyPassword(String(b.password || ''), a.pw_salt, a.pw_hash);
    if (!okPw) { recordLoginFailure(ip, tierOf(a), Date.now()); return res.status(403).json({ error: 'wrong password' }); }
    if (a.totp_secret && !totpVerify(a.id, a.totp_secret, b.totp))
      return res.status(403).json({ error: 'two-auth code required', need2fa: true });
    const { rpID } = rp(req);
    const options = await generateRegistrationOptions({
      rpName: 'Simplex', rpID,
      userName: a.username, userDisplayName: a.display || a.username, userID: userHandle(a.id),
      attestationType: 'none',
      excludeCredentials: pk.list.all(a.id).map(r => ({ id: r.id, transports: r.transports ? JSON.parse(r.transports) : undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      supportedAlgorithmIDs: [-7, -8, -257],   // ES256, EdDSA, RS256
      timeout: 120_000,
    });
    const tk = issue({ kind: 'reg', challenge: options.challenge, ip, accountId: a.id });
    if (!tk) return res.status(429).json({ error: 'too many pending requests — try again in a few minutes' });
    res.json({ tk, options, prfSalt: b64u(PRF_SALT) });
  });

  // step 2: verify the attestation, store the credential, bind PRF if given
  app.post('/api/passkeys/register/verify', requireAuth, async (req, res) => {
    const ip = clientIp(req), a = req.account, b = req.body || {};
    const c = take(b.tk, 'reg', ip);
    if (!c || c.accountId !== a.id) return res.status(400).json({ error: 'that request expired — try adding the passkey again' });
    if (pk.count.get(a.id).n >= MAX_PASSKEYS) return res.status(400).json({ error: `you can register up to ${MAX_PASSKEYS} passkeys` });
    const { rpID, origin } = rp(req);
    let v;
    try {
      v = await verifyRegistrationResponse({
        response: b.response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch (e) { return res.status(400).json({ error: 'the passkey could not be verified' }); }
    if (!v.verified || !v.registrationInfo) return res.status(400).json({ error: 'the passkey could not be verified' });
    const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
    if (pk.get.get(credential.id)) return res.status(409).json({ error: 'that passkey is already registered' });
    pk.ins.run({
      id: credential.id, account_id: a.id, public_key: Buffer.from(credential.publicKey), counter: credential.counter || 0,
      transports: JSON.stringify(credential.transports || (b.response && b.response.response && b.response.response.transports) || []),
      label: cleanLabel(b.label) || 'Passkey', device_type: credentialDeviceType, backed_up: credentialBackedUp ? 1 : 0, created: Date.now(),
    });
    const bound = await bindPrf(credential.id, a.id, parsePrf(b.prf));
    notifyAccount(a.id, { type: 'security', title: 'Passkey added', body: `A passkey named “${cleanLabel(b.label) || 'Passkey'}” can now sign in to your account. If this wasn't you, remove it in Settings → Safety and change your password.` });
    bumpAccounts();
    res.json({ ok: true, passkey: toApi(pk.get.get(credential.id)), needsBind: !bound && !!a.key_enrolled });
  });

  // PRF bind for authenticators that only release PRF on get(): one verified
  // assertion from THAT credential, by its signed-in owner, with the UDK resident.
  app.post('/api/passkeys/bind/options', requireAuth, async (req, res) => {
    const ip = clientIp(req), a = req.account;
    const row = pk.getScoped.get(String((req.body && req.body.id) || ''), a.id);
    if (!row) return res.status(404).json({ error: 'passkey not found' });
    if (!udkResident(a.id)) return res.status(409).json({ error: 'keys are not loaded — sign in with your password first' });
    const { rpID } = rp(req);
    const options = await generateAuthenticationOptions({
      rpID, userVerification: 'required', timeout: 120_000,
      allowCredentials: [{ id: row.id, transports: row.transports ? JSON.parse(row.transports) : undefined }],
    });
    const tk = issue({ kind: 'bind', challenge: options.challenge, ip, accountId: a.id, credId: row.id });
    if (!tk) return res.status(429).json({ error: 'too many pending requests — try again in a few minutes' });
    res.json({ tk, options, prfSalt: b64u(PRF_SALT) });
  });
  app.post('/api/passkeys/bind/verify', requireAuth, async (req, res) => {
    const ip = clientIp(req), a = req.account, b = req.body || {};
    const c = take(b.tk, 'bind', ip);
    if (!c || c.accountId !== a.id) return res.status(400).json({ error: 'that request expired — try again' });
    const row = pk.getScoped.get(c.credId, a.id);
    if (!row || !b.response || b.response.id !== row.id) return res.status(400).json({ error: 'wrong passkey' });
    const r = await verifyAssertion(req, b.response, c.challenge, row);
    if (!r) return res.status(400).json({ error: 'the passkey could not be verified' });
    const prf = parsePrf(b.prf);
    if (!prf) return res.status(400).json({ error: 'this passkey or browser does not support vault unlock (PRF)', code: 'NO_PRF' });
    if (!(await bindPrf(row.id, a.id, prf))) return res.status(409).json({ error: 'keys are not loaded — sign in with your password first' });
    res.json({ ok: true, passkey: toApi(pk.get.get(row.id)) });
  });

  app.patch('/api/passkeys/:id', requireAuth, (req, res) => {
    const label = cleanLabel(req.body && req.body.label);
    if (!label) return res.status(400).json({ error: 'give it a name' });
    const r = pk.rename.run(label, req.params.id, req.accountId);
    if (!r.changes) return res.status(404).json({ error: 'passkey not found' });
    res.json({ ok: true, passkey: toApi(pk.get.get(req.params.id)) });
  });
  app.delete('/api/passkeys/:id', requireAuth, (req, res) => {
    const row = pk.getScoped.get(req.params.id, req.accountId);
    if (!row) return res.status(404).json({ error: 'passkey not found' });
    pk.del.run(row.id, req.accountId);
    notifyAccount(req.accountId, { type: 'security', title: 'Passkey removed', body: `The passkey “${row.label || 'Passkey'}” can no longer sign in.` });
    bumpAccounts();
    res.json({ ok: true });
  });

  async function verifyAssertion(req, response, expectedChallenge, row) {
    const { rpID, origin } = rp(req);
    try {
      const v = await verifyAuthenticationResponse({
        response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter,
          transports: row.transports ? JSON.parse(row.transports) : undefined },
      });
      if (!v.verified) return null;
      pk.touch.run(v.authenticationInfo.newCounter, Date.now(), v.authenticationInfo.credentialBackedUp ? 1 : 0, row.id);
      return v;
    } catch (e) { return null; }
  }

  /* ---------------- sign-in (public) ---------------- */
  app.post('/api/login/passkey/options', async (req, res) => {
    const ip = clientIp(req);
    const { rpID } = rp(req);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', timeout: 300_000 });
    const tk = issue({ kind: 'auth', challenge: options.challenge, ip });
    if (!tk) return res.status(429).json({ error: 'too many attempts — wait a moment' });
    res.json({ tk, options, prfSalt: b64u(PRF_SALT) });
  });

  app.post('/api/login/passkey', async (req, res) => {
    const ip = clientIp(req), now = Date.now(), b = req.body || {};
    const c = take(b.tk, 'auth', ip);
    if (!c) return res.status(400).json({ error: 'sign-in expired — try again', restart: true });
    const resp = b.response;
    const row = resp && typeof resp.id === 'string' ? pk.get.get(resp.id) : null;
    const account = row ? sysStmt.getAcct.get(row.account_id) : null;
    const fail = () => { recordLoginFailure(ip, tierOf(account), now); return res.status(401).json({ error: 'that passkey was not recognised' }); };
    if (!row || !account) return fail();
    // discoverable sign-in returns the user handle: it must be this account's
    const uh = resp.response && resp.response.userHandle;
    if (uh) {
      const got = Buffer.from(String(uh)), want = Buffer.from(b64u(userHandle(account.id)));
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return fail();
    }
    if (!(await verifyAssertion(req, resp, c.challenge, row))) return fail();

    // per-user keys
    const prf = parsePrf(b.prf);
    let keyInfo = null;
    if (account.key_enrolled) {
      if (!udkResident(account.id) && row.key_wrap && prf) {
        const udk = vault.unwrapKey(await kekFromPrf(prf, row.wrap_salt, account.id, row.id), row.key_wrap);
        if (udk) cacheUdk(account.id, udk);
      }
      if (!udkResident(account.id)) {
        // signature was valid (so no ban strike), but nothing here can unlock the vault
        return res.status(409).json({ code: 'PASSKEY_NO_KEY', error: 'this passkey can’t unlock your vault right now — sign in with your password once, then passkeys work again' });
      }
      if (!row.key_wrap && prf) { try { await bindPrf(row.id, account.id, prf); } catch (e) {} }   // self-heal
      keyInfo = { ok: true, stale: !!account.key_wrap_stale };
    }
    clearIpBan(ip);
    finishLogin(req, res, account, ip, false, keyInfo);
  });

  return { deleteForAccount: (id) => pk.delAcct.run(id), countFor: (id) => pk.count.get(id).n };
};

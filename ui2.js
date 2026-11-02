/* ui2.js — the classic interface's doorway back to the new one.
 *
 * Runs deferred after app.js on the classic page. Adds:
 *   - a small floating "New Simplex" pill (bottom-left) once signed in
 *   - an "Interface" row at the top of classic Settings
 * Both call SimplexUI.useNext() (ui2-boot.js), which remembers the choice and
 * opens /next.html. Never touches classic app state; failures are swallowed.
 */
(function () {
  'use strict';
  var UI = window.SimplexUI;
  if (!UI) return;

  function signedIn() { var l = document.getElementById('lock'); return !!(l && l.classList.contains('hidden')); }

  var pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'nx-pill';
  pill.hidden = true;
  pill.title = 'Switch to the new Simplex interface';
  pill.innerHTML = '<span class="nx-orb"></span><span>New Simplex</span><span class="nx-go">Switch →</span>';
  pill.onclick = function () { UI.useNext(); };

  function syncPill() { pill.hidden = !signedIn(); }

  function injectSettings() {
    var settings = document.querySelector('#appscreen .settings');
    if (!settings || document.getElementById('nxSetRow')) return;
    var sec = document.createElement('div');
    sec.className = 'set-section'; sec.id = 'nxSetRow';
    sec.innerHTML = '<span class="eyebrow">Interface</span>' +
      '<div class="set-row"><div class="sr-main"><div class="sr-title">New Simplex</div>' +
      '<div class="sr-sub mono">the rebuilt interface — apps move over as they’re finished</div></div>' +
      '<button class="btn primary" type="button">Switch</button></div>';
    sec.querySelector('button').onclick = function () { UI.useNext(); };
    settings.insertBefore(sec, settings.firstChild);
  }

  function start() {
    try {
      document.body.appendChild(pill);
      syncPill();
      var lock = document.getElementById('lock');
      if (lock) new MutationObserver(syncPill).observe(lock, { attributes: true, attributeFilter: ['class'] });
      var scr = document.getElementById('appscreen');
      if (scr) new MutationObserver(function () { try { injectSettings(); } catch (e) {} }).observe(scr, { childList: true });
    } catch (e) { console.warn('[ui]', e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

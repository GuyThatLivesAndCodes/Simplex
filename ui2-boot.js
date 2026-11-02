/* ui2-boot.js — picks which Simplex interface this browser gets.
 *
 * Loaded synchronously in the classic page's <head> (index.html), before any of
 * the classic app's scripts run. The new interface lives at /next.html (code in
 * /next/); the classic one is this page. The choice is per browser:
 *
 *   localStorage 'simplex.ui' = 'next' | 'classic'   (unset → DEFAULT_UI)
 *   ?ui=classic / ?ui=next on any URL sets it (that's how the two link to each other)
 *
 * When the answer is 'next', we leave immediately — mapping classic paths to the
 * new app's routes — so the classic app never boots. Public share links (/s/…)
 * and the Simplex Visual play page always stay here.
 */
(function () {
  // Which interface a browser gets before it has chosen. 'classic' keeps the new
  // interface opt-in; 'next' makes it the default for everyone.
  var DEFAULT_UI = 'next';
  var KEY = 'simplex.ui';

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var params;
  try { params = new URLSearchParams(location.search); } catch (e) { params = null; }
  var q = params && params.get('ui');
  if (q === 'classic' || q === 'next') {
    lsSet(KEY, q);
    // drop ?ui= from the address bar so reloads/bookmarks stay clean
    try { params.delete('ui'); var s = params.toString(); history.replaceState(history.state, '', location.pathname + (s ? '?' + s : '') + location.hash); } catch (e) {}
  }

  var mode = lsGet(KEY) || DEFAULT_UI;
  window.SimplexUI = {
    mode: mode,
    useNext: function () { lsSet(KEY, 'next'); location.href = '/next.html'; },
  };
  if (mode !== 'next') return;

  var p = location.pathname;
  if (/^\/(s|visual\/play)\//.test(p)) return;   // public pages are classic-only

  // classic routes → new-app routes (anything unknown lands on Home)
  var m, hash = '#/';
  if ((m = p.match(/^\/database\/folder\/([^/]+)/))) hash = '#/files/' + m[1];
  else if (/^\/database\/files\/?$/.test(p)) hash = '#/files';
  else if ((m = p.match(/^\/database\/(music|films|photos|documents|models|assets)\/?$/))) hash = '#/c/' + m[1];
  else if (/^\/database\/starred/.test(p)) hash = '#/starred';
  else if (/^\/database\/trash/.test(p)) hash = '#/trash';
  else if (/^\/database/.test(p)) hash = '#/files';
  location.replace('/next.html' + hash);
})();

/* guard.js — safety net for the new interface (classic script, no modules).
   Loaded as both a regular and a `nomodule` script by index.html (the new interface at /):
   - browsers that can't run ES modules get sent straight to the classic interface
   - if the app hasn't drawn anything 8s after load (a script failed, an old
     browser choked), a fallback card offers the classic interface instead of a
     blank page */
(function () {
  function toClassic() { try { localStorage.setItem('simplex.ui', 'classic'); } catch (e) {} location.href = '/old.html?ui=classic'; }
  var isNoModule = document.currentScript && document.currentScript.hasAttribute('nomodule');
  if (isNoModule) { toClassic(); return; }
  window.addEventListener('load', function () {
    setTimeout(function () {
      var root = document.getElementById('root');
      if (!root || root.children.length) return;
      root.innerHTML = '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;font:15px/1.5 system-ui,sans-serif;color:#f3f3f7">' +
        '<div style="max-width:380px;padding:28px;border-radius:24px;background:rgb(18 19 26 / .85);box-shadow:inset 0 0 0 1px rgb(255 255 255 / .1)">' +
        '<b style="font-size:19px">The new Simplex didn’t load</b><p style="opacity:.7;margin:8px 0 18px">Your browser may be too old, or a file failed to download. The classic interface still works.</p>' +
        '<button id="nxGuardClassic" style="height:42px;padding:0 18px;border:0;border-radius:999px;font:600 14px system-ui;cursor:pointer;background:linear-gradient(135deg,#c4a6ff,#7f8cff);color:#0b0b12">Open classic interface</button> ' +
        '<button id="nxGuardRetry" style="height:42px;padding:0 16px;border:0;border-radius:999px;font:600 14px system-ui;cursor:pointer;background:rgb(255 255 255 / .08);color:#f3f3f7">Retry</button></div></div>';
      document.getElementById('nxGuardClassic').onclick = toClassic;
      document.getElementById('nxGuardRetry').onclick = function () { location.reload(); };
    }, 8000);
  });
})();

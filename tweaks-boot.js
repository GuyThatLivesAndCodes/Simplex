/* tweaks-boot.js — CDN-dependency failure tracking for the optional tweaks panel.
 *
 * This used to be an inline <script> plus three inline `onerror=` attributes on the
 * react / react-dom / @babel/standalone <script> tags. Our CSP no longer allows
 * inline scripts or inline event handlers (no 'unsafe-inline'); nonces don't cover
 * on*= attributes, so the handlers were moved here into a nonced external file.
 *
 * Contract preserved exactly: window.__simplexTweaksUnavailable(which) pushes the
 * failed dependency name onto window.__simplexTweaksMissing. Code that wants the
 * panel checks that array and skips the panel instead of throwing. The core app
 * (login + vault) does not depend on any of this.
 *
 * Load order: this file is included immediately BEFORE the three CDN <script src>
 * tags in index.html, so these error listeners are attached before those tags can
 * finish loading or fail.
 */
(function () {
  window.__simplexTweaksUnavailable = function (which) {
    window.__simplexTweaksMissing = (window.__simplexTweaksMissing || []);
    window.__simplexTweaksMissing.push(which);
  };

  // Attach an error listener to each CDN dependency script by id. If the resource
  // fails to load (offline, blocked, integrity mismatch), record it by its
  // data-dep name — the same names the old inline onerror handlers reported.
  ['dep-react', 'dep-react-dom', 'dep-babel'].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('error', function () {
      window.__simplexTweaksUnavailable(el.getAttribute('data-dep') || id);
    });
  });
})();

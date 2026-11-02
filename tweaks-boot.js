/* tweaks-boot.js — loader + CDN-failure tracking for the optional tweaks panel.
 *
 * The tweaks panel (tweaks-panel.jsx / tweaks.jsx) is a design-host edit-mode panel:
 * it only ever shows when this page is FRAMED by the host (it talks to window.parent
 * via postMessage). For every normal visitor it was still costing ~4MB of CDN JS
 * (React + ReactDOM development builds + @babel/standalone) plus an in-browser JSX
 * transpile on every page load — seconds of CPU and a big chunk of RAM on a low-end
 * phone, for a panel that never appears. So the deps are now injected ONLY when framed.
 *
 * Unframed, tweaks.jsx would have been a no-op anyway: its defaults match the CSS
 * (--scan-op 0.5, album spin on), so skipping it changes nothing visible.
 *
 * Contract preserved: window.__simplexTweaksUnavailable(which) pushes the failed
 * dependency name onto window.__simplexTweaksMissing. Our CSP forbids inline
 * handlers, so listeners are attached here (this file carries the CSP nonce).
 */
(function () {
  window.__simplexTweaksUnavailable = function (which) {
    window.__simplexTweaksMissing = (window.__simplexTweaksMissing || []);
    window.__simplexTweaksMissing.push(which);
  };

  var framed = false;
  try { framed = window.self !== window.top; } catch (e) { framed = true; }   // cross-origin parent throws → framed
  if (!framed) return;

  var nonce = (document.currentScript && (document.currentScript.nonce || document.currentScript.getAttribute('nonce'))) || '';
  var DEPS = [
    { dep: 'react', src: 'https://unpkg.com/react@18.3.1/umd/react.development.js', sri: 'sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L' },
    { dep: 'react-dom', src: 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js', sri: 'sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm' },
    { dep: 'babel', src: 'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js', sri: 'sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y' },
  ];
  DEPS.forEach(function (d) {
    var s = document.createElement('script');
    s.id = 'dep-' + d.dep; s.setAttribute('data-dep', d.dep);
    s.src = d.src; s.integrity = d.sri; s.crossOrigin = 'anonymous';
    s.async = false;                       // keep react → react-dom → babel order
    if (nonce) s.nonce = nonce;
    s.addEventListener('error', function () { window.__simplexTweaksUnavailable(d.dep); });
    if (d.dep === 'babel') s.addEventListener('load', function () {
      // Babel auto-transforms text/babel tags on DOMContentLoaded. Injected scripts
      // can land after that already fired, so run it ourselves in that case.
      if (document.readyState !== 'loading' && window.Babel && window.Babel.transformScriptTags) {
        try { window.Babel.transformScriptTags(); } catch (e) {}
      }
    });
    (document.head || document.documentElement).appendChild(s);
  });
})();

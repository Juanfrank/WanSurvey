/* global window, document, localStorage */
// Applies the colour theme before the page paints, so a dark theme does not flash light.
// The choice is kept on the device ('ws.theme': light | dark | system; system by default).
(function () {
  var pref = 'system';
  try {
    pref = localStorage.getItem('ws.theme') || 'system';
  } catch {
    // No storage: follow the system.
  }
  var dark =
    pref === 'dark' ||
    (pref !== 'light' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();

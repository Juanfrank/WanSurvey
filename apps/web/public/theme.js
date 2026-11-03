/* global window, document, localStorage */
// Applies the colour theme before the page paints, so a dark theme does not flash light.
// The person's choice is kept on the device ('ws.theme': light | dark | system); without one, the
// organisation's default ('ws.org', written by the application) and its accent apply. The pages
// respondents open (/s/, /o/, /f/, /u/) follow only the device's own preference.
(function () {
  var pref = null;
  var org = null;
  var respondent = /^\/(s|o|f|u)\//.test(window.location.pathname);
  try {
    pref = localStorage.getItem('ws.theme');
    if (!respondent) org = JSON.parse(localStorage.getItem('ws.org') || 'null');
  } catch {
    // No storage: follow the system.
  }
  if (pref !== 'light' && pref !== 'dark' && pref !== 'system') {
    pref = org && (org.default === 'light' || org.default === 'dark') ? org.default : 'system';
  }
  var dark =
    pref === 'dark' ||
    (pref !== 'light' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  var tokens = org && org[dark ? 'dark' : 'light'];
  if (tokens) for (var k in tokens) root.style.setProperty('--color-' + k, tokens[k]);
})();

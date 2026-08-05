/* Counts installed-app launches. Nothing else.
 *
 * Why this file exists at all: the app's CSP is `script-src 'self'` with no
 * 'unsafe-inline', so the loader that used to sit inline in index.html was
 * refused by the browser on every load — the app has never reported a single
 * thing. External file, so it actually runs.
 *
 * What it reports, deliberately narrow:
 *   - Only when the app is running as an INSTALLED app (display-mode:
 *     standalone / minimal-ui, or iOS navigator.standalone). A browser tab on
 *     /app reports nothing, so the count in the dashboard is "PWA opens", not
 *     "people who visited the app URL".
 *   - Exactly ONE hit per launch. Vercel's script also watches history changes;
 *     beforeSend drops everything after the first so tab switching inside the
 *     app can never inflate the number.
 *   - No custom payload, no user data. The vault is encrypted and never leaves
 *     the device; that is not changing. All that leaves here is the same thing
 *     any web page sends: a request for /app.
 *
 * Opt-out: visit any page with ?noanalytics=1 (same localStorage key as the
 * landing page, same origin, so opting out there covers this too).
 */
(function () {
  var OFF_KEY = "duitful-analytics-off";

  // Native shell: Capacitor's WebView base is https://localhost, so
  // /_vercel/insights/script.js would 404. The bridge sets window.Capacitor
  // before page scripts run, so this check is safe here.
  if (window.Capacitor && typeof window.Capacitor.isNativePlatform === "function"
      && window.Capacitor.isNativePlatform()) return;

  // Installed only.
  var standalone = false;
  try {
    standalone = (window.matchMedia && (window.matchMedia("(display-mode: standalone)").matches
      || window.matchMedia("(display-mode: minimal-ui)").matches))
      || window.navigator.standalone === true;
  } catch (e) {}
  if (!standalone) return;

  try {
    if (localStorage.getItem(OFF_KEY)) return;
  } catch (e) { /* storage blocked (private mode) — count normally */ }

  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };

  // One and done. The shipped script drops the event when beforeSend returns
  // null, and queued calls are replayed once the tag loads, so ordering with
  // the deferred script below is safe.
  var sent = false;
  window.va("beforeSend", function (event) {
    if (sent) return null;
    sent = true;
    return event;
  });

  var s = document.createElement("script");
  s.defer = true;
  s.src = "/_vercel/insights/script.js";
  document.head.appendChild(s);
})();

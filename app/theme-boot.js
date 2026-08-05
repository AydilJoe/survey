/* Applies the saved theme before anything paints.
 *
 * The theme choice is stored OUTSIDE the encrypted vault precisely so it can
 * be read this early — the vault needs a passcode, and the passcode prompt is
 * itself something we have to paint.
 *
 * This has to be an external file: the page CSP is `script-src 'self'` with no
 * 'unsafe-inline', so the inline version of this that shipped for months was
 * refused by the browser on every single load. Dark-mode users got a cream
 * flash on every launch and the comment in index.html claimed otherwise.
 *
 * It also has to be synchronous, and it has to sit BEFORE the stylesheet
 * links. A blocking script placed after a <link rel=stylesheet> cannot run
 * until that sheet arrives, which would put the flash back on any cold start
 * with a slow network — the exact case this exists to prevent.
 */
try {
  var t = localStorage.getItem("duit-tracker.theme");
  if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
